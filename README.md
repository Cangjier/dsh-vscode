# VS Code panel for DeepSeek Harness

A Harness bundle that puts a real, server-side VS Code workbench inside the Web
GUI as a main panel. Moving to another panel hides the workbench instead of
unmounting it, so open editors, undo history, terminals and running tasks are
still there when you come back.

The panel is available from the **VS Code** icon in the left sidebar, next to
the other global panels.

## How it works

```
browser                          Host (dsh web)                         loopback
┌──────────────────────┐  same origin  ┌──────────────────────────┐      ┌─────────────┐
│ persistent <iframe>  │ ────────────▶ │ /vscode     (prefix)     │ ───▶ │ code-server │
│ display:none when    │               │ /_static    (prefix)     │      │ 127.0.0.1   │
│ another panel is up  │               │ /dsh-vscode/status|theme │      └─────────────┘
└──────────────────────┘               └──────────────────────────┘
```

- The Host half owns one code-server process, started on first use on a free
  loopback port. code-server mounts the workbench itself at `/vscode`; the
  plugin forwards that prefix and sets `x-forwarded-prefix`, so the generated
  HTML, assets and WebSocket all stay on the Harness origin. No extra port,
  login page, CORS rule or mixed-content exception is involved.
- The Client half registers a `main` panel and a `sidebar.panellist` icon. The
  panel component is only a port: it measures its own box and reveals one
  long-lived iframe positioned over it. When the panel is unmounted, the iframe
  is hidden with `display: none`, which does not unload its document.
- A dedicated `/_static` prefix carries the few root-relative assets
  code-server serves (favicon, manifest art, service worker). The Harness app
  does not use `/_static`.

## Requirements

- A `web` profile (the bundle's Client half is a Web plugin).
- **Linux x64/arm64, macOS x64/arm64, or Windows x64** for the automatic runtime install. The download
  is a prebuilt code-server standalone archive; nothing is compiled and no
  package manager runs on the host.
- About 300 MB of download and 750 MB of disk for the runtime, plus roughly
  300–600 MB of RAM while VS Code is open. On a 1.6 GB server, keep the
  Harness heap limit (`DSH_WEB_HEAP_MB`) conservative and do not run other
  browsers on the host.
- If the machine cannot download GitHub releases, install code-server yourself
  and set `codeServerBin` (see below).

## Install

```bash
# from this directory
node scripts/install-runtime.mjs          # optional pre-install
```

Then install the bundle in the profile:

```text
Plugins > Add plugin > this directory
```

or with the plugin manager, using this directory as `target`. The plugin
activates in new sessions; the sidebar icon appears immediately.

On first open, if no runtime is present, the panel shows a download page and
refreshes itself when code-server is ready.

### Configuration (`cordis.patch.yml`)

Every field is optional.

| Field | Default | Meaning |
| --- | --- | --- |
| `folder` | `$DSH_WORKDIR`, then Host cwd | Directory opened in the workbench. |
| `dataDir` | `$DSH_PROFILE_DIR/vscode-data` | Runtime, user data, extensions and log. |
| `codeServerBin` | `runtime/bin/code-server` | Use an existing code-server launcher. |
| `version` | `4.146.0` | Release to download when the runtime is missing. |
| `runtimeUrl` | empty | Direct archive URL tried before GitHub (mirror/offline). |
| `port` | `0` | Fixed loopback port; `0` chooses one. |
| `locale` | browser | Workbench locale, for example `zh-cn`. |
| `colorTheme` | `Default Dark Modern` | Initial theme when none is stored. |
| `syncTheme` | `true` | Follow the Harness light/dark theme. |
| `autoInstall` | `true` | Download code-server on first use. |
| `args` | `[]` | Extra code-server arguments. |

For example:

```yaml
- id: vscode
  name: '@local/dsh-vscode'
  config:
    folder: /root/ws
    dataDir: /root/.dsh/shared/data/vscode
    version: 4.146.0
```

## Persistence and lifecycle

- Switching to Conversation or another panel hides the iframe; the VS Code
  workbench is not reloaded and its terminals keep running on the server.
- Reloading the browser page (or reopening the tab) creates a new iframe, so
  browser-side editor layout is rebuilt; terminal processes live on the server
  and are reconnected by the workbench.
- Unloading or updating the plugin stops the code-server process. Its data
  directory (settings, extensions, user data) remains.

## Security

The VS Code routes are same-origin and rely on the deployment's existing access
control: the Harness auth cookie on `/`, and the gate password in front of it.
The loopback code-server itself uses `--auth none`; it must not be exposed on a
public interface. Do not add a port-forward for it.

## Development

```bash
node --check index.js client.js src/runtime.js
node --test tests/*.test.mjs
```

The Client half is plain ESM (`client.js`) loaded by the Harness module loader;
there is no build step and no JSX. The Host half is plain ESM (`index.js`,
`src/`).

## Verified

- code-server 4.146.0 served under `/vscode` through a same-origin pass-through
  proxy with `x-forwarded-prefix`: workbench, assets, theme resources,
  extension host and WebSocket connected in a headless Chrome run.
- The DSH bundle itself and its in-app persistence have not yet been verified
  on a live profile.
