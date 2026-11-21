/**
 * VS Code bundle, Host half.
 *
 * The plugin owns one server-side code-server runtime and exposes it on the
 * Harness origin: `/vscode` is the workbench, `/_static` carries the handful
 * of root-relative assets code-server itself serves, and `/dsh-vscode/*`
 * answers the small JSON calls the Client half makes. The Client half renders
 * a persistent iframe; this half keeps the VS Code session behind it alive.
 */
import z from '@deepseek-ai/schemastery'
import { BASE_PATH, STATIC_PATH, VSCodeRuntime } from './src/runtime.js'

export const name = 'vscode'

export const inject = ['webServer']

export const Config = z.object({
  /** Directory opened in the workbench; defaults to DSH_WORKDIR, then the Host cwd. */
  folder: z.string().default(''),
  /** Runtime, user data and extension directory; defaults under the profile directory. */
  dataDir: z.string().default(''),
  /** Launcher to use instead of the installed `runtime/bin/code-server`. */
  codeServerBin: z.string().default(''),
  /** code-server release to download when the runtime is missing. */
  version: z.string().default('4.146.0'),
  /** Fixed loopback port; 0 lets the OS choose one. */
  port: z.natural().default(0),
  /** Workbench locale (for example `zh-cn`); empty follows the browser. */
  locale: z.string().default(''),
  /** Initial workbench theme when the stored settings do not name one. */
  colorTheme: z.string().default('Default Dark Modern'),
  /** Follow the Harness light/dark theme by updating the workbench setting. */
  syncTheme: z.boolean().default(true),
  /** Download the code-server runtime on first use when it is missing. */
  autoInstall: z.boolean().default(true),
  /** Extra code-server arguments appended before the folder. */
  args: z.array(z.string()).default([]),
})

/**
 * Register the routes once for the plugin's lifetime.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} config
 */
export function apply(ctx, config) {
  const upgrades = []
  const releaseUpgrades = () => {
    for (const dispose of upgrades.splice(0)) dispose()
  }
  const publishUpgrades = (runtime, paths) => {
    releaseUpgrades()
    for (const path of paths) {
      try {
        upgrades.push(ctx.webServer.registerUpgrade({
          path,
          handler: (req, socket, head) => runtime.handleUpgrade(req, socket, head),
        }))
      } catch (error) {
        ctx.logger?.warn?.(`[vscode] cannot claim WebSocket route ${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const runtime = new VSCodeRuntime({
    ctx,
    config: config ?? {},
    onUpgradePaths: paths => publishUpgrades(runtime, paths),
  })

  ctx.effect(() => () => {
    releaseUpgrades()
    void runtime.dispose()
  }, 'vscode:runtime')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BASE_PATH,
    handler: (req, res) => runtime.handleHttp(req, res),
  }), 'vscode:workbench')

  // code-server serves its favicon, manifest art and service worker at the
  // origin root. The Harness app does not use `/_static`, so this prefix is
  // free; losing it only degrades that artwork.
  let staticRoute
  try {
    staticRoute = ctx.webServer.register({
      kind: 'prefix',
      path: STATIC_PATH,
      handler: (req, res) => runtime.handleStatic(req, res),
    })
  } catch (error) {
    ctx.logger?.warn?.(`[vscode] /_static is already claimed; workbench artwork will be missing: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (staticRoute !== undefined) ctx.effect(() => staticRoute, 'vscode:static')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-vscode/status',
    resource: async () => Response.json(runtime.getStatus()),
  }), 'vscode:status')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-vscode/config',
    resource: async () => Response.json({
      folder: runtime.folder,
      installed: runtime.installed,
      autoInstall: config?.autoInstall !== false,
      state: runtime.state,
    }),
  }), 'vscode:config')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-vscode/theme',
    handler: (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      let body = ''
      let rejected = false
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 4096 && !rejected) {
          rejected = true
          res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('theme payload too large\n')
        }
      })
      req.on('end', () => {
        if (rejected) return
        let scheme
        try {
          scheme = JSON.parse(body || '{}').scheme
        } catch {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('invalid JSON\n')
          return
        }
        runtime.applyScheme(scheme === 'light' ? 'light' : 'dark').then(() => {
          res.writeHead(204, { 'cache-control': 'no-store' })
          res.end()
        }, (error) => {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`${error instanceof Error ? error.message : String(error)}\n`)
        })
      })
    },
  }), 'vscode:theme')
}
