/**
 * Progress, yielding and bounds for the scanner.
 *
 * The settings page shows a progress bar driven by these callbacks, and the host
 * must stay responsive while a big root is walked — both are load-bearing
 * behaviours, not implementation details.
 *
 * Run: node test/scan-progress.test.mjs
 *
 * @module test/scan-progress.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scanForPlugins, scanForPluginsAsync } from '../lib/scan.js'

let passed = 0
let failed = 0
async function test(label, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL ${label}`)
    console.error(`       ${error.message}`)
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onshelf-progress-'))

/** Build a tree with `count` sibling directories, one of which is a plugin. */
function buildWideTree(base, count) {
  fs.mkdirSync(base, { recursive: true })
  for (let i = 0; i < count; i++) {
    const dir = path.join(base, `dir-${String(i).padStart(3, '0')}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x')
  }
  const plugin = path.join(base, 'dir-000')
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({
    name: 'dsh-progress-fixture',
    version: '1.0.0',
    description: 'Fixture.',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  fs.writeFileSync(path.join(plugin, 'cordis.patch.yml'), "- insert:\n    - id: x\n      name: 'x'\n")
}

console.log('progress reporting')
const wide = path.join(root, 'wide')
buildWideTree(wide, 40)

await test('the sync scan reports stats', () => {
  const result = scanForPlugins(wide, { maxDepth: 2 })
  assert.ok(result.stats, 'stats missing')
  assert.ok(result.stats.dirsVisited > 0)
  assert.equal(result.stats.truncated, false)
  assert.ok(result.found.length >= 1)
})

await test('onProgress is called repeatedly and its counts grow', () => {
  const seen = []
  scanForPlugins(wide, { maxDepth: 2, onProgress: p => seen.push(p) })
  assert.ok(seen.length > 5, `only ${seen.length} progress ticks`)
  assert.ok(seen[seen.length - 1].dirsVisited > seen[0].dirsVisited)
  assert.ok(seen.every(p => typeof p.current === 'string'))
})

await test('the async scan produces the same result as the sync one', async () => {
  const sync = scanForPlugins(wide, { maxDepth: 2 })
  const async = await scanForPluginsAsync(wide, { maxDepth: 2 })
  assert.deepEqual(
    async.found.map(p => p.dir).sort(),
    sync.found.map(p => p.dir).sort(),
  )
  assert.equal(async.stats.dirsVisited, sync.stats.dirsVisited)
})

await test('the async scan yields to the event loop instead of blocking it', async () => {
  const big = path.join(root, 'big')
  buildWideTree(big, 200)
  let timerFired = false
  const timer = setTimeout(() => { timerFired = true }, 0)
  let ticks = 0
  await scanForPluginsAsync(big, { maxDepth: 1, yieldEvery: 8, onProgress: () => { ticks++ } })
  clearTimeout(timer)
  assert.ok(ticks > 0, 'no progress ticks')
  assert.equal(timerFired, true, 'a 0ms timer never ran — the scan blocked the loop')
})

await test('shouldStop aborts the walk and marks it truncated', async () => {
  let calls = 0
  const result = await scanForPluginsAsync(wide, {
    maxDepth: 2,
    shouldStop: () => ++calls > 3,
  })
  assert.equal(result.stats.truncated, true)
})

await test('the directory ceiling bounds a pathological root', () => {
  const big = path.join(root, 'huge')
  buildWideTree(big, 120)
  const result = scanForPlugins(big, { maxDepth: 2, maxDirectories: 10 })
  assert.equal(result.stats.truncated, true)
  assert.ok(result.stats.dirsVisited <= 11, `visited ${result.stats.dirsVisited}`)
})

await test('a missing root returns stats rather than throwing', async () => {
  const sync = scanForPlugins(path.join(root, 'nope'), {})
  assert.equal(sync.ok, false)
  assert.equal(sync.stats.dirsVisited, 0)
  const async = await scanForPluginsAsync(path.join(root, 'nope'), {})
  assert.equal(async.ok, false)
  assert.equal(async.stats.dirsVisited, 0)
})

await test('a wide-but-shallow tree stays fast', async () => {
  const big = path.join(root, 'perf')
  buildWideTree(big, 500)
  const started = Date.now()
  await scanForPluginsAsync(big, { maxDepth: 1 })
  const ms = Date.now() - started
  assert.ok(ms < 5000, `took ${ms}ms`)
  console.log(`       (500 directories in ${ms}ms)`)
})

try {
  fs.rmSync(root, { recursive: true, force: true })
} catch { /* temp dir is disposable */ }

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
