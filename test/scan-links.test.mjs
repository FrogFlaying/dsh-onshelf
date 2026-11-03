/**
 * Regression tests for the two scan bugs found in the wild:
 *
 *   1. A locally developed plugin installed with `link:` becomes a junction on
 *      Windows (symlink elsewhere). `readdirSync` reports `isDirectory() === false`
 *      for those, so a walk that only descends into `isDirectory()` entries hides
 *      exactly the plugins the author wants to publish.
 *   2. The default scan roots pointed at `~/.dsh/profiles/<name>`, which holds
 *      *installed* plugins. The list filled up with other people's marketplace
 *      plugins and none of the author's own.
 *
 * Run: node test/scan-links.test.mjs
 *
 * @module test/scan-links.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { scanForPlugins, defaultScanRoots } from '../lib/scan.js'

let passed = 0
let failed = 0
function test(label, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL ${label}`)
    console.error(`       ${error.message}`)
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onshelf-links-'))

function writePlugin(dir, name, { bundle = true } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const pkg = {
    name,
    version: '1.0.0',
    description: `${name} description.`,
    dsh: bundle ? { bundle: { patch: './cordis.patch.yml' } } : { client: { platform: 'web' } },
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  if (bundle) {
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), "- insert:\n    - id: x\n      name: 'x'\n")
  }
  fs.writeFileSync(path.join(dir, 'index.js'), 'export const name = "x"\n')
  return dir
}

/** Create a directory link. Junctions need no elevation on Windows. */
function linkDir(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true })
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    // Fall back to a shell command if the runtime refuses.
    if (process.platform === 'win32') {
      const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' })
      return r.status === 0
    }
    const r = spawnSync('ln', ['-s', target, link], { stdio: 'ignore' })
    return r.status === 0
  }
}

console.log('① scan follows directory links')

const devRoot = path.join(root, 'projects')
const source = writePlugin(path.join(devRoot, 'my-plugin'), 'dsh-my-plugin')
const installDir = path.join(root, 'node_modules')
const linked = path.join(installDir, 'dsh-my-plugin')
const linkOk = linkDir(source, linked)

test('the fixture really is a link (skipped if the OS refuses)', () => {
  if (!linkOk) return
  const entry = fs.readdirSync(installDir, { withFileTypes: true }).find(e => e.name === 'dsh-my-plugin')
  assert.ok(entry, 'link not created')
  assert.equal(entry.isSymbolicLink(), true, 'expected a symlink/junction entry')
  assert.equal(entry.isDirectory(), false, 'a link must not report isDirectory() — this is the bug')
})

test('a linked plugin is found and reported at its real source path', () => {
  if (!linkOk) return
  const result = scanForPlugins(installDir, { maxDepth: 2 })
  const hit = result.found.find(p => p.name === 'dsh-my-plugin')
  assert.ok(hit, `linked plugin not found; found: ${result.found.map(p => p.name)}`)
  assert.equal(hit.dir, fs.realpathSync.native(source), 'should report the real source directory')
  assert.equal(hit.linked, true)
})

test('a plugin found directly is not flagged as installed', () => {
  const result = scanForPlugins(devRoot, { maxDepth: 3 })
  const hit = result.found.find(p => p.name === 'dsh-my-plugin')
  assert.ok(hit)
  assert.equal(hit.installed, false)
})

test('a plugin reached through node_modules is flagged as installed', () => {
  // A *real* package sitting inside node_modules is somebody else's published
  // work — that is what "installed" means. A junction whose target lives outside
  // node_modules is the author's own source, and must not be mislabelled.
  writePlugin(path.join(installDir, 'dsh-real-installed'), 'dsh-real-installed')
  const result = scanForPlugins(installDir, { maxDepth: 2 })
  const real = result.found.find(p => p.name === 'dsh-real-installed')
  assert.ok(real, `not found; found: ${result.found.map(p => p.name)}`)
  assert.equal(real.installed, true, 'a package living inside node_modules is installed')

  const linkedPkg = result.found.find(p => p.name === 'dsh-my-plugin')
  if (linkedPkg) {
    assert.equal(linkedPkg.installed, false, 'a junction to your own source folder is not "installed"')
    assert.equal(linkedPkg.linked, true)
  }
})

test('the same real package is reported once even when reached twice', () => {
  if (!linkOk) return
  // Scanning the parent reaches both the source and, through node_modules, the link.
  const result = scanForPlugins(root, { maxDepth: 4 })
  const hits = result.found.filter(p => p.name === 'dsh-my-plugin')
  assert.equal(hits.length, 1, `expected one entry, got ${hits.length}: ${hits.map(h => h.dir)}`)
})

test('local plugins sort before installed ones', () => {
  // Scanning an install directory directly is the case that mixes both: real
  // packages (installed) and junctions back to the author's own source (not
  // installed). The author's own work must come first.
  if (!linkOk) return
  writePlugin(path.join(installDir, 'dsh-real-installed'), 'dsh-real-installed')
  const result = scanForPlugins(installDir, { maxDepth: 2 })
  const flags = result.found.map(p => p.installed)
  assert.ok(flags.includes(true), `no installed package; got ${result.found.map(p => `${p.name}:${p.installed}`)}`)
  assert.ok(flags.includes(false), `no local package; got ${result.found.map(p => `${p.name}:${p.installed}`)}`)
  const lastLocal = flags.lastIndexOf(false)
  const firstInstalled = flags.indexOf(true)
  assert.ok(
    lastLocal < firstInstalled,
    `local must precede installed; got ${result.found.map(p => `${p.name}:${p.installed}`).join(', ')}`,
  )
})

test('a symlink cycle does not hang the scan', () => {
  const cycleRoot = path.join(root, 'cycle')
  const inner = writePlugin(path.join(cycleRoot, 'p'), 'dsh-cycle')
  // Point a link inside the plugin back at the cycle root.
  const back = path.join(inner, 'loop')
  if (!linkDir(cycleRoot, back)) return
  const started = Date.now()
  const result = scanForPlugins(cycleRoot, { maxDepth: 6 })
  assert.ok(Date.now() - started < 5000, 'scan took too long — cycle guard is not working')
  assert.equal(result.found.filter(p => p.name === 'dsh-cycle').length, 1)
})

test('a broken link is skipped, not thrown', () => {
  const brokenRoot = path.join(root, 'broken')
  fs.mkdirSync(brokenRoot, { recursive: true })
  const target = path.join(root, 'nowhere')
  if (!linkDir(target, path.join(brokenRoot, 'dangling'))) return
  const result = scanForPlugins(brokenRoot, { maxDepth: 2 })
  assert.equal(result.ok, true)
  assert.equal(result.found.length, 0)
})

console.log('')
console.log('② default scan roots')

const fakeHome = path.join(root, 'dsh-home')
const profileDir = path.join(fakeHome, 'profiles', 'desktop')
fs.mkdirSync(profileDir, { recursive: true })

test('the DSH home is never offered as a scan root', () => {
  const roots = defaultScanRoots({ dshHome: fakeHome, pluginDir: devRoot })
  for (const r of roots) {
    assert.ok(!r.toLowerCase().startsWith(fakeHome.toLowerCase()), `root inside DSH home: ${r}`)
  }
})

test('a workspace that resolves into the DSH home is discarded', () => {
  const roots = defaultScanRoots({ workspace: profileDir, dshHome: fakeHome, pluginDir: devRoot })
  assert.ok(!roots.some(r => r.toLowerCase().includes('profiles')), `got: ${roots.join(', ')}`)
})

test('the folder containing the plugin is offered by default', () => {
  const pluginDir = path.join(devRoot, 'my-plugin')
  const roots = defaultScanRoots({ dshHome: fakeHome, pluginDir })
  assert.ok(
    roots.some(r => path.resolve(r) === path.resolve(devRoot)),
    `expected ${devRoot} in ${roots.join(', ')}`,
  )
})

test('explicit extra roots are honoured and deduplicated', () => {
  const other = writePlugin(path.join(root, 'other'), 'dsh-other')
  const roots = defaultScanRoots({ dshHome: fakeHome, pluginDir: devRoot, extra: [other, other] })
  const matches = roots.filter(r => path.resolve(r) === path.resolve(other))
  assert.equal(matches.length, 1, 'the same root must not be listed twice')
})

test('a non-existent extra root is dropped rather than returned', () => {
  const roots = defaultScanRoots({
    dshHome: fakeHome,
    pluginDir: devRoot,
    extra: [path.join(root, 'does-not-exist')],
  })
  assert.ok(!roots.some(r => r.includes('does-not-exist')))
})

try {
  fs.rmSync(root, { recursive: true, force: true })
} catch { /* junctions on Windows can resist deletion; the temp dir is disposable */ }

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
