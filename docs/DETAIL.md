# VS Code

Adds a **VS Code** entry to the sidebar's global panel list. The panel is a
server-side VS Code workbench, embedded in the Harness page.

## What it does

- Starts a managed code-server process on the Harness host, on a loopback port,
  and exposes it same-origin at `/vscode`.
- Shows the workbench as a main panel. Switching to another panel hides the
  iframe instead of destroying it, so editors and terminal sessions survive the
  switch.
- Follows the Harness light/dark theme through the workbench color theme.
- Downloads the code-server standalone runtime on first use when it is missing;
  `scripts/install-runtime.mjs` pre-installs it for offline hosts.

## Configuration

`folder`, `dataDir`, `codeServerBin`, `version`, `port`, `locale`,
`colorTheme`, `syncTheme`, `autoInstall` and `args` are documented in the
package README.

## Limitations

- The browser page reload rebuilds the iframe; only the page session is kept
  alive by `display: none`.
- One workbench is shared by the profile. Use one browser tab for editing.
- Automatic runtime install supports Linux x64/arm64 and macOS. Windows needs
  an explicit `codeServerBin`.
- The workbench is as privileged as the DSH host user; it is protected only by
  the Harness/gate access control.
