import test from 'node:test'
import assert from 'node:assert/strict'
import { launchPage, releasePlatform, resolveDataDir } from '../src/runtime.js'

test('releasePlatform maps the supported standalone builds', () => {
  assert.equal(releasePlatform('linux', 'x64'), 'linux-amd64')
  assert.equal(releasePlatform('linux', 'arm64'), 'linux-arm64')
  assert.equal(releasePlatform('darwin', 'arm64'), 'macos-arm64')
  assert.equal(releasePlatform('darwin', 'x64'), 'macos-amd64')
  assert.equal(releasePlatform('win32', 'x64'), 'windows-amd64')
})

test('resolveDataDir prefers config, then the profile directory', () => {
  assert.equal(resolveDataDir({ dataDir: '/tmp/example' }), '/tmp/example')
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = '/tmp/profile'
  try {
    assert.equal(resolveDataDir({ dataDir: '' }), '/tmp/profile/vscode-data')
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
})

test('launchPage reports download progress and escapes text', () => {
  const html = launchPage({
    state: 'installing',
    received: 50 * 1024 * 1024,
    total: 100 * 1024 * 1024,
    log: ['<script>alert(1)</script>'],
  }, undefined)
  assert.match(html, /50%/)
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(!html.includes('<script>alert(1)</script>'))
})
