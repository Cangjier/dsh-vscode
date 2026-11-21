#!/usr/bin/env node
/**
 * Standalone smoke test for the code-server runtime and the same-origin proxy.
 *
 * It installs (or reuses) the runtime, starts it, puts the plugin's proxy in
 * front of it, fetches the workbench HTML and one of its assets, and opens the
 * WebSocket the workbench uses. No DSH profile, browser or build is involved.
 *
 * Environment:
 * - `DSHV_DATA_DIR` (required): runtime/user-data directory.
 * - `DSHV_RUNTIME_URL`: archive/mirror URL for the first install.
 * - `DSHV_FOLDER`: folder opened in the workbench.
 * - `DSHV_KEEP_RUNNING=1`: leave code-server running after the checks.
 */
import http from 'node:http'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { VSCodeRuntime } from '../src/runtime.js'

const dataDir = process.env.DSHV_DATA_DIR
if (!dataDir) {
  console.error('DSHV_DATA_DIR is required (for example .vscode-data)')
  process.exit(2)
}

const runtime = new VSCodeRuntime({
  ctx: { logger: console },
  config: {
    dataDir: path.resolve(dataDir),
    autoInstall: true,
    runtimeUrl: process.env.DSHV_RUNTIME_URL ?? '',
    folder: process.env.DSHV_FOLDER ?? process.cwd(),
    syncTheme: false,
  },
})

let server
const upgraded = new Set()
const cleanup = async () => {
  if (server !== undefined) {
    // A proxied WebSocket keeps the HTTP server's connection table open, so
    // close() alone never settles. Destroy both halves before waiting.
    for (const socket of upgraded) socket.destroy()
    upgraded.clear()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
  if (process.env.DSHV_KEEP_RUNNING !== '1') await runtime.dispose()
}
process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)) })

const listen = httpServer => new Promise((resolve, reject) => {
  httpServer.once('error', reject)
  httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port))
})

try {
  console.log('starting code-server …')
  await runtime.ready()
  const status = runtime.getStatus()
  console.log('status:', JSON.stringify(status))
  if (!status.running) throw new Error('code-server is not running')

  server = http.createServer((req, res) => runtime.handleHttp(req, res))
  server.on('upgrade', (req, socket, head) => {
    upgraded.add(socket)
    socket.once('close', () => upgraded.delete(socket))
    runtime.handleUpgrade(req, socket, head)
  })
  const port = await listen(server)
  const origin = `http://127.0.0.1:${port}`

  const pageUrl = `${origin}/vscode/?folder=${encodeURIComponent(runtime.folder)}`
  const page = await fetch(pageUrl)
  const html = await page.text()
  console.log('page:', page.status, `${html.length} bytes`)
  if (!page.ok) throw new Error(`workbench page answered ${page.status}`)
  if (!html.includes('vscode-workbench-web-configuration')) throw new Error('the page is not a workbench document')
  const script = html.match(/src="([^"]*workbench\.js)"/)?.[1]
  if (script === undefined) throw new Error('the page names no workbench.js')
  const assetUrl = new URL(script, pageUrl).toString()
  const asset = await fetch(assetUrl)
  console.log('asset:', asset.status, assetUrl.replace(origin, ''))
  if (!asset.ok) throw new Error(`workbench.js answered ${asset.status}`)

  for (const wsPath of runtime.wsPaths.slice(0, 1)) {
    const wsUrl = `ws://127.0.0.1:${port}${wsPath}`
    const opened = await new Promise((resolve) => {
      const socket = new WebSocket(wsUrl)
      const timer = setTimeout(() => { socket.close(); resolve(false) }, 8000)
      socket.addEventListener('open', () => { clearTimeout(timer); socket.close(); resolve(true) })
      socket.addEventListener('error', () => { clearTimeout(timer); resolve(false) })
    })
    console.log('websocket:', opened ? 'open' : 'FAILED', wsPath)
    if (!opened) throw new Error(`WebSocket ${wsPath} did not open`)
  }

  console.log('OK: workbench page, asset and WebSocket all reachable through the proxy')
} catch (error) {
  console.error('FAILED:', error instanceof Error ? error.message : String(error))
  console.error(runtime.getStatus().log?.slice(-20).join('\n') ?? '')
  process.exitCode = 1
} finally {
  await cleanup()
}
