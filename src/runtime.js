/**
 * Host half of the VS Code panel.
 *
 * One code-server process is supervised here; the browser reaches it through
 * this plugin's same-origin routes (`/vscode`, `/_static`), so the iframe in
 * the Client half needs no separate port, login or CORS exception. The
 * routes are pass-through: code-server itself mounts the workbench at
 * `/vscode`, and the `x-forwarded-prefix` header makes the generated HTML and
 * workbench configuration use that base.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

/** Prefix the workbench lives under on the Harness origin. */
export const BASE_PATH = '/vscode'

/** code-server release this plugin installs when none is present. */
export const DEFAULT_VERSION = '4.146.0'

/** Root assets code-server references relatively; the path is not under /vscode. */
export const STATIC_PATH = '/_static'

const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000
const HEALTH_TIMEOUT_MS = 60_000

/** Resolve a runtime directory from plugin config or the profile default. */
export function resolveDataDir(config) {
  const configured = String(config.dataDir ?? '').trim()
  if (configured !== '') return path.resolve(configured)
  const profile = process.env.DSH_PROFILE_DIR
  if (profile !== undefined && profile !== '') return path.join(profile, 'vscode-data')
  return path.join(process.cwd(), '.dsh-vscode-data')
}

/** Read the product commit that shapes the workbench WebSocket path. */
async function readProduct(runtimeDir) {
  try {
    const raw = await readFile(path.join(runtimeDir, 'lib', 'vscode', 'product.json'), 'utf8')
    const product = JSON.parse(raw)
    const commit = typeof product.commit === 'string' ? product.commit : ''
    const quality = typeof product.quality === 'string' && product.quality !== '' ? product.quality : 'oss'
    return { commit, quality }
  } catch {
    return undefined
  }
}

/** Pick a loopback port the OS says is free right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

/** One installed code-server release plus the process supervising it. */
export class VSCodeRuntime {
  /**
   * @param {object} options
   * @param {import('@deepseek-ai/cordis').Context} options.ctx
   * @param {Record<string, unknown>} options.config
   */
  constructor(options) {
    this.ctx = options.ctx
    this.config = options.config
    this.dataDir = resolveDataDir(options.config)
    this.runtimeDir = path.join(this.dataDir, 'runtime')
    this.userDataDir = path.join(this.dataDir, 'user-data')
    this.extensionsDir = path.join(this.dataDir, 'extensions')
    this.logPath = path.join(this.dataDir, 'code-server.log')
    const configuredBin = String(options.config.codeServerBin ?? '').trim()
    this.bin = configuredBin || path.join(this.runtimeDir, 'bin', process.platform === 'win32' ? 'code-server.cmd' : 'code-server')
    this.folder = String(options.config.folder ?? '').trim()
      || process.env.DSH_WORKDIR
      || process.cwd()
    this.state = 'idle'
    this.error = undefined
    this.port = undefined
    this.child = undefined
    this.readyPromise = undefined
    this.install = { received: 0, total: 0 }
    this.wsPaths = []
    this.registeredUpgrades = []
    this.logTail = []
    this.disposed = false
    this.upgradePathsChanged = options.onUpgradePaths ?? (() => {})
  }

  /** Whether a code-server launcher is present. */
  get installed() {
    return existsSync(this.bin)
  }

  /** Snapshot for the status route and the install page. */
  getStatus() {
    return {
      state: this.state,
      running: this.state === 'running',
      installed: this.installed,
      folder: this.folder,
      port: this.port ?? null,
      received: this.install.received,
      total: this.install.total,
      error: this.error ?? null,
      log: this.logTail.slice(-20),
    }
  }

  /** Make sure the runtime is installed and serving; concurrent callers share one start. */
  async ready() {
    if (this.disposed) throw new Error('VS Code runtime is disposed')
    if (this.state === 'running') return
    if (this.readyPromise !== undefined) return this.readyPromise
    this.readyPromise = this.#prepare().finally(() => { this.readyPromise = undefined })
    return this.readyPromise
  }

  async #prepare() {
    try {
      if (!this.installed) {
        if (this.config.autoInstall !== true) {
          throw new Error(`code-server is not installed. Run "npm run install-runtime" in the plugin directory, or set codeServerBin.`)
        }
        await this.#install()
      }
      if (this.state !== 'running') await this.#start()
      await this.#publishUpgradePaths()
    } catch (error) {
      this.state = 'error'
      this.error = error instanceof Error ? error.message : String(error)
      this.#log(`error: ${this.error}`)
      throw error
    }
  }

  /** Download and extract the standalone release. Only one install runs at a time. */
  async #install() {
    if (this.state === 'installing') throw new Error('code-server is already being installed')
    this.state = 'installing'
    this.error = undefined
    const version = String(this.config.version ?? '').trim() || DEFAULT_VERSION
    const platform = releasePlatform()
    if (platform === undefined) {
      throw new Error(`no code-server standalone build is known for ${process.platform}/${process.arch}; set codeServerBin`)
    }
    const name = `code-server-${version}-${platform}`
    const archiveName = `${name}.tar.gz`
    const downloadDir = path.join(this.dataDir, 'download')
    const archive = path.join(downloadDir, archiveName)
    await mkdir(downloadDir, { recursive: true })
    const url = `https://github.com/coder/code-server/releases/download/v${version}/${archiveName}`
    const mirrors = [
      ...(String(this.config.runtimeUrl ?? '').trim() !== '' ? [String(this.config.runtimeUrl).trim()] : []),
      url,
      `https://ghfast.top/${url}`,
      `https://gh-proxy.com/${url}`,
    ]
    let lastError
    for (const mirror of mirrors) {
      try {
        this.#log(`downloading ${mirror}`)
        await downloadFile(mirror, archive, (received, total) => {
          this.install = { received, total }
        })
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        this.#log(`download failed: ${error instanceof Error ? error.message : String(error)}`)
        await rm(archive, { force: true })
      }
    }
    if (lastError !== undefined) throw lastError
    this.#log('extracting code-server')
    const staging = path.join(this.dataDir, 'runtime-staging')
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await extract(archive, staging)
    const stagedBin = path.join(staging, 'bin', process.platform === 'win32' ? 'code-server.cmd' : 'code-server')
    if (!existsSync(stagedBin)) throw new Error('the downloaded archive did not contain bin/code-server')
    await rm(this.runtimeDir, { recursive: true, force: true })
    await rename(staging, this.runtimeDir)
    await rm(archive, { force: true })
    this.install = { received: 0, total: 0 }
    this.#log(`installed code-server ${version} at ${this.runtimeDir}`)
    this.state = 'idle'
  }

  /** Spawn code-server on a loopback port and wait for its health endpoint. */
  async #start() {
    this.state = 'starting'
    this.error = undefined
    await mkdir(this.userDataDir, { recursive: true })
    await mkdir(this.extensionsDir, { recursive: true })
    await this.#writeSettings(undefined)
    const port = Number(this.config.port) > 0 ? Number(this.config.port) : await freePort()
    this.port = port
    const args = [
      '--auth', 'none',
      '--bind-addr', `127.0.0.1:${port}`,
      '--disable-telemetry',
      '--disable-update-check',
      '--disable-workspace-trust',
      '--disable-getting-started-override',
      '--user-data-dir', this.userDataDir,
      '--extensions-dir', this.extensionsDir,
    ]
    const locale = String(this.config.locale ?? '').trim()
    if (locale !== '') args.push('--locale', locale)
    const extra = Array.isArray(this.config.args) ? this.config.args.filter(item => typeof item === 'string') : []
    args.push(...extra)
    args.push(this.folder)
    const env = { ...process.env }
    delete env.PASSWORD
    delete env.HASHED_PASSWORD
    env.CODE_SERVER_CONFIG = path.join(this.dataDir, 'config.yaml')
    this.#log(`starting ${this.bin} ${args.join(' ')}`)
    const stream = createWriteStream(this.logPath, { flags: 'a' })
    const child = spawnCodeServer(this.bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    const capture = (chunk) => {
      const text = String(chunk)
      stream.write(text)
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() !== '') this.logTail.push(line)
      }
      if (this.logTail.length > 200) this.logTail.splice(0, this.logTail.length - 200)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    child.once('exit', (code, signal) => {
      stream.end()
      this.#log(`code-server exited code=${String(code)} signal=${String(signal)}`)
      if (this.child === child) {
        this.child = undefined
        this.port = undefined
        if (!this.disposed) this.state = 'idle'
      }
    })
    await waitForHealth(port, child, HEALTH_TIMEOUT_MS)
    this.state = 'running'
    this.#log(`code-server ready on 127.0.0.1:${port}`)
  }

  /** Register the exact upgrade paths the live workbench will use. */
  async #publishUpgradePaths() {
    const product = await readProduct(this.runtimeDir)
    if (product === undefined || product.commit === '') return
    const productPath = `${product.quality}-${product.commit}`
    const paths = [`${BASE_PATH}/${productPath}`, `${BASE_PATH}/${productPath}/`, BASE_PATH, `${BASE_PATH}/`]
    if (paths.length === this.wsPaths.length && paths.every((item, index) => item === this.wsPaths[index])) return
    this.wsPaths = paths
    this.upgradePathsChanged(paths)
  }

  /** Proxy one HTTP request to code-server, or answer the boot page while it starts. */
  handleHttp(req, res) {
    if (this.state === 'running' && this.port !== undefined) {
      this.#proxyHttp(req, res)
      return
    }
    // Start in the background; the boot page polls the status route, so a
    // first-use download never keeps one HTTP response open for minutes.
    void this.ready().catch(() => {})
    const wantsDocument = String(req.headers.accept ?? '').includes('text/html')
    if (wantsDocument && (req.method === 'GET' || req.method === 'HEAD')) {
      this.#serveLaunchPage(req, res, this.error)
      return
    }
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('VS Code is starting\n')
  }

  /** Proxy one raw `/_static` request to code-server's root assets. */
  handleStatic(req, res) {
    if (this.state !== 'running' || this.port === undefined) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('VS Code is starting\n')
      return
    }
    this.#proxyTo(req, res, req.url ?? '/', false)
  }

  #proxyHttp(req, res) {
    const target = req.url ?? `${BASE_PATH}/`
    this.#proxyTo(req, res, target, true)
  }

  #proxyTo(req, res, target, withPrefix) {
    const headers = { ...req.headers }
    headers['x-forwarded-prefix'] = BASE_PATH
    headers['x-forwarded-host'] = String(req.headers.host ?? '')
    headers['x-forwarded-proto'] = String(req.headers['x-forwarded-proto'] ?? (req.socket.encrypted ? 'https' : 'http'))
    delete headers['x-dsh-vscode-prefix']
    const upstream = http.request({
      host: '127.0.0.1',
      port: this.port,
      method: req.method,
      path: target,
      headers,
    }, (response) => {
      const out = { ...response.headers }
      const location = out.location
      if (withPrefix && typeof location === 'string' && location.startsWith('/') && !location.startsWith(`${BASE_PATH}/`)) {
        out.location = `${BASE_PATH}${location}`
      }
      res.writeHead(response.statusCode ?? 502, out)
      response.pipe(res)
      response.on('error', () => res.destroy())
    })
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      }
      res.end(`VS Code upstream error: ${error.message}\n`)
    })
    res.on('close', () => { upstream.destroy() })
    req.pipe(upstream)
  }

  /** Proxy one WebSocket upgrade. */
  handleUpgrade(req, socket, head) {
    if (this.state !== 'running' || this.port === undefined) {
      socket.destroy()
      return
    }
    const upstream = net.connect(this.port, '127.0.0.1', () => {
      const pathAndQuery = req.url ?? '/'
      let raw = `${req.method ?? 'GET'} ${pathAndQuery} HTTP/1.1\r\n`
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index]
        const value = req.rawHeaders[index + 1]
        if (name.toLowerCase() === 'x-forwarded-prefix') continue
        raw += `${name}: ${value}\r\n`
      }
      raw += `x-forwarded-prefix: ${BASE_PATH}\r\n\r\n`
      upstream.write(raw)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  }

  /** Update the workbench color theme through its user settings file. */
  async applyScheme(scheme) {
    if (this.config.syncTheme !== true) return
    await this.#writeSettings(scheme === 'light' ? 'light' : 'dark')
  }

  async #writeSettings(scheme) {
    const dir = path.join(this.userDataDir, 'User')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'settings.json')
    let current = {}
    try {
      current = JSON.parse(await readFile(file, 'utf8'))
      if (typeof current !== 'object' || current === null) current = {}
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // VS Code accepts JSONC; rewriting a commented file would destroy
        // user settings, so theme sync skips the file instead.
        this.#log('settings.json is not strict JSON; leaving it untouched')
        return
      }
      current = {}
    }
    const defaults = {
      'chat.disableAIFeatures': true,
      'chat.commandCenter.enabled': false,
      'workbench.startupEditor': 'none',
      'workbench.tips.enabled': false,
      'workbench.welcomePage.walkthroughs.openOnInstall': false,
      'security.workspace.trust.enabled': false,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
    }
    for (const [key, value] of Object.entries(defaults)) {
      if (current[key] === undefined) current[key] = value
    }
    if (scheme !== undefined) {
      const target = scheme === 'light' ? 'Default Light Modern' : 'Default Dark Modern'
      const existing = current['workbench.colorTheme']
      if (existing === undefined || existing === 'Default Dark Modern' || existing === 'Default Light Modern') {
        current['workbench.colorTheme'] = target
      }
    } else if (current['workbench.colorTheme'] === undefined) {
      current['workbench.colorTheme'] = String(this.config.colorTheme || 'Default Dark Modern')
    }
    await writeFile(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  }

  #log(line) {
    this.ctx.logger?.info?.(`[vscode] ${line}`)
    this.logTail.push(`[plugin] ${line}`)
    if (this.logTail.length > 200) this.logTail.splice(0, this.logTail.length - 200)
  }

  /** Serve the first-run/installation page instead of an empty editor. */
  #serveLaunchPage(req, res, message) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    const status = this.getStatus()
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    if (req.method === 'HEAD') { res.end(); return }
    res.end(launchPage(status, message))
  }

  /** Kill the child process and drop the registration callbacks. */
  async dispose() {
    this.disposed = true
    const child = this.child
    this.child = undefined
    this.port = undefined
    if (child !== undefined && child.exitCode === null) {
      if (process.platform === 'win32') {
        // A .cmd shim is the direct child; taskkill /T reaches the node process
        // it started, which a plain child.kill() would leave running.
        await new Promise((resolve) => {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
          killer.once('error', () => { try { child.kill() } catch {} resolve() })
          killer.once('exit', () => resolve())
        })
      } else {
        child.kill('SIGTERM')
        await new Promise((resolve) => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
          child.once('exit', () => { clearTimeout(timer); resolve() })
        })
      }
    }
    this.state = 'idle'
  }
}

/** Spawn a launcher, going through cmd.exe for a Windows .cmd shim. */
function spawnCodeServer(bin, args, options) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return spawn(bin, args, options)
  const quote = value => `"${String(value).replace(/"/g, '""')}"`
  const line = [quote(bin), ...args.map(quote)].join(' ')
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], options)
}

/** Human-readable platform selector used in the release asset name. */
export function releasePlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && arch === 'x64') return 'linux-amd64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64'
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64'
  if (platform === 'darwin' && arch === 'x64') return 'macos-amd64'
  if (platform === 'win32' && arch === 'x64') return 'windows-amd64'
  return undefined
}

/** Follow redirects and stream one asset to disk. */
export function downloadFile(url, target, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('too many redirects')); return }
    const client = url.startsWith('https:') ? https : http
    const request = client.get(url, { headers: { 'user-agent': 'dsh-vscode' } }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && typeof response.headers.location === 'string') {
        response.resume()
        const next = new URL(response.headers.location, url).toString()
        downloadFile(next, target, onProgress, redirects + 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error(`HTTP ${status} from ${url}`))
        return
      }
      const total = Number(response.headers['content-length'] ?? 0)
      let received = 0
      const out = createWriteStream(target)
      response.on('data', (chunk) => {
        received += chunk.length
        onProgress(received, total)
      })
      pipeline(response, out).then(resolve, reject)
    })
    request.setTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, () => request.destroy(new Error('download timed out')))
    request.on('error', reject)
  })
}

/** Extract a .tar.gz with the platform tar; no compiler or package manager involved. */
async function extract(archive, target) {
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', target, '--strip-components=1'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar exited ${String(code)}: ${stderr.trim()}`))
    })
  })
}

/** Poll code-server's /healthz until it answers or the child exits. */
async function waitForHealth(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`code-server exited before it became healthy (code ${String(child.exitCode)})`)
    const ok = await new Promise((resolve) => {
      const request = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1000 }, (response) => {
        response.resume()
        resolve((response.statusCode ?? 0) < 500)
      })
      request.on('timeout', () => { request.destroy(); resolve(false) })
      request.on('error', () => resolve(false))
    })
    if (ok) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('code-server did not become healthy in time')
}

/** First-run page: explains installation and refreshes itself when the runtime is ready. */
export function launchPage(status, message) {
  const title = status.state === 'installing' ? 'Installing VS Code' : 'Starting VS Code'
  const percent = status.total > 0 ? Math.min(100, Math.round((status.received / status.total) * 100)) : 0
  const detail = status.total > 0
    ? `${percent}% · ${Math.round(status.received / 1024 / 1024)} / ${Math.round(status.total / 1024 / 1024)} MiB`
    : (message ?? 'Preparing the server-side workbench.')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#17181a;color:#e6e8ea;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(560px,88vw)}h1{margin:0 0 8px;font-size:20px}p{margin:0 0 16px;color:#a9adb3}
.track{height:6px;border-radius:99px;background:#2b2e33;overflow:hidden}.bar{height:100%;width:${percent}%;background:linear-gradient(90deg,#3b82f6,#60a5fa);transition:width .3s}
pre{margin:16px 0 0;padding:12px;border-radius:8px;background:#101113;color:#c9ced4;font-size:12px;max-height:180px;overflow:auto;white-space:pre-wrap}
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><div class="track"><div class="bar"></div></div>
<pre id="log">${escapeHtml((status.log ?? []).join('\n'))}</pre>
<p style="margin-top:16px">首次使用会下载 code-server 运行时（约 260 MB）。此页面会自动刷新。</p>
</main>
<script>
const started = Date.now();
async function poll(){
  try {
    const response = await fetch('/dsh-vscode/status', { cache: 'no-store' });
    const status = await response.json();
    if (status.installed && (status.running || status.state === 'running')) { location.reload(); return }
    if (status.state === 'error' && status.error) { document.querySelector('p').textContent = status.error }
    setTimeout(poll, 2000)
  } catch { setTimeout(poll, 3000) }
}
if (Date.now() - started < 1000 * 60 * 30) setTimeout(poll, 1500)
</script></body></html>`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}
