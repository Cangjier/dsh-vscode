import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { VSCodeRuntime } from '../src/runtime.js'

const logger = { info() {}, warn() {} }

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function tempRuntime(config = {}) {
  return mkdtemp(path.join(os.tmpdir(), 'dsh-vscode-')).then(dataDir => ({
    dataDir,
    runtime: new VSCodeRuntime({ ctx: { logger }, config: { dataDir, autoInstall: false, ...config } }),
  }))
}

test('handleHttp forwards the workbench path with x-forwarded-prefix', async (t) => {
  const seen = []
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, prefix: req.headers['x-forwarded-prefix'], host: req.headers['x-forwarded-host'] })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('upstream-body')
  })
  const upstreamPort = await listen(upstream)
  const { dataDir, runtime } = await tempRuntime()
  runtime.state = 'running'
  runtime.port = upstreamPort
  const proxy = http.createServer((req, res) => runtime.handleHttp(req, res))
  const proxyPort = await listen(proxy)
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true })
    await new Promise(resolve => upstream.close(resolve))
    await new Promise(resolve => proxy.close(resolve))
  })

  const response = await fetch(`http://127.0.0.1:${proxyPort}/vscode/out/app.js?x=1`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'upstream-body')
  assert.deepEqual(seen, [{ url: '/vscode/out/app.js?x=1', prefix: '/vscode', host: `127.0.0.1:${proxyPort}` }])
})

test('handleHttp prefixes an origin-absolute redirect with the workbench path', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(302, { location: '/login?to=%2F' })
    res.end()
  })
  const upstreamPort = await listen(upstream)
  const { dataDir, runtime } = await tempRuntime()
  runtime.state = 'running'
  runtime.port = upstreamPort
  const proxy = http.createServer((req, res) => runtime.handleHttp(req, res))
  const proxyPort = await listen(proxy)
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true })
    await new Promise(resolve => upstream.close(resolve))
    await new Promise(resolve => proxy.close(resolve))
  })

  const response = await fetch(`http://127.0.0.1:${proxyPort}/vscode/`, { redirect: 'manual' })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/vscode/login?to=%2F')
})

test('a document request while idle answers the boot page, not a hanging proxy', async (t) => {
  const { dataDir, runtime } = await tempRuntime()
  const server = http.createServer((req, res) => runtime.handleHttp(req, res))
  const port = await listen(server)
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true })
    await new Promise(resolve => server.close(resolve))
  })

  const response = await fetch(`http://127.0.0.1:${port}/vscode/`, { headers: { accept: 'text/html' } })
  assert.equal(response.status, 200)
  const body = await response.text()
  assert.match(body, /Starting VS Code|Installing VS Code/)
  assert.match(body, /\/dsh-vscode\/status/)
})

test('applyScheme writes a workbench theme and leaves JSONC untouched', async (t) => {
  const { dataDir, runtime } = await tempRuntime({ syncTheme: true })
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  await runtime.applyScheme('light')
  const file = path.join(runtime.userDataDir, 'User', 'settings.json')
  const settings = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(settings['workbench.colorTheme'], 'Default Light Modern')
  assert.equal(settings['telemetry.telemetryLevel'], 'off')

  await writeFile(file, '{\n  // a user comment\n  "workbench.colorTheme": "Monokai"\n}\n', 'utf8')
  await runtime.applyScheme('dark')
  assert.equal(await readFile(file, 'utf8'), '{\n  // a user comment\n  "workbench.colorTheme": "Monokai"\n}\n')
})
