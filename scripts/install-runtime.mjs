#!/usr/bin/env node
/**
 * Install the code-server standalone build this plugin supervises.
 *
 * The plugin can download it on first use too; this script is for offline or
 * pre-provisioned deployments, where downloading from a panel request is not
 * wanted. It only downloads and extracts, so it needs no compiler and no
 * package manager on the target host.
 */
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DEFAULT_VERSION, downloadFile, releasePlatform } from '../src/runtime.js'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && typeof args[index + 1] === 'string' ? args[index + 1] : fallback
}
const version = option('version', DEFAULT_VERSION)
const profile = process.env.DSH_PROFILE_DIR
const dataDir = path.resolve(option('dir', profile !== undefined && profile !== ''
  ? path.join(profile, 'vscode-data')
  : path.join(process.cwd(), 'vscode-data')))
const runtimeDir = path.join(dataDir, 'runtime')
const platform = releasePlatform()

if (platform === undefined) {
  console.error(`No code-server standalone build is known for ${process.platform}/${process.arch}.`)
  console.error('Install code-server yourself and set the plugin config codeServerBin to its launcher.')
  process.exit(2)
}

if (existsSync(path.join(runtimeDir, 'bin', process.platform === 'win32' ? 'code-server.cmd' : 'code-server'))) {
  console.log(`code-server is already installed at ${runtimeDir}`)
  process.exit(0)
}

const name = `code-server-${version}-${platform}`
const archive = path.join(dataDir, 'download', `${name}.tar.gz`)
const url = `https://github.com/coder/code-server/releases/download/v${version}/${name}.tar.gz`
const mirrors = [url, `https://ghfast.top/${url}`, `https://gh-proxy.com/${url}`]
await mkdir(path.dirname(archive), { recursive: true })

let lastError
for (const mirror of mirrors) {
  let lastPercent = -1
  try {
    console.log(`downloading ${mirror}`)
    await downloadFile(mirror, archive, (received, total) => {
      if (total <= 0) return
      const percent = Math.floor((received / total) * 100)
      if (percent !== lastPercent) {
        lastPercent = percent
        process.stdout.write(`\r  ${percent}% (${Math.round(received / 1024 / 1024)} / ${Math.round(total / 1024 / 1024)} MiB)`)
      }
    })
    process.stdout.write('\n')
    lastError = undefined
    break
  } catch (error) {
    process.stdout.write('\n')
    lastError = error
    console.error(`  failed: ${error instanceof Error ? error.message : String(error)}`)
    await rm(archive, { force: true })
  }
}
if (lastError !== undefined) {
  console.error(lastError instanceof Error ? lastError.message : String(lastError))
  process.exit(1)
}

const staging = path.join(dataDir, 'runtime-staging')
await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true })
console.log('extracting')
await new Promise((resolve, reject) => {
  const child = spawn('tar', ['-xzf', archive, '-C', staging, '--strip-components=1'], { stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`tar exited ${String(code)}`))))
})
await rm(runtimeDir, { recursive: true, force: true })
await rename(staging, runtimeDir)
await rm(archive, { force: true })
console.log(`installed code-server ${version} at ${runtimeDir}`)
