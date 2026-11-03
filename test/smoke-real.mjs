/**
 * A real-machine smoke run: scan with the same defaults the plugin uses and print
 * what it would offer the user. Not part of the test suite — it depends on what
 * happens to exist on this machine.
 *
 * Run: node test/smoke-real.mjs
 *
 * @module test/smoke-real.mjs
 */

import path from 'node:path'
import { scanForPlugins, defaultScanRoots } from '../lib/scan.js'
import { diagnose } from '../lib/check.js'
import { draftDescriptions } from '../lib/entry.js'

const roots = defaultScanRoots({
  // The app hands the plugin a workspace that resolves into the DSH home; the real
  // default is this plugin's parent folder.
  workspace: path.join(process.env.USERPROFILE ?? '.', '.dsh', 'profiles', 'desktop'),
  dshHome: path.join(process.env.USERPROFILE ?? '.', '.dsh'),
  pluginDir: process.cwd(),
})

console.log('scan roots:')
for (const r of roots) console.log('  ' + r)
console.log('')

for (const root of roots) {
  const result = scanForPlugins(root, { maxDepth: 3 })
  if (!result.ok) {
    console.log(`${root}\n  skipped: ${result.errors[0] ?? 'n/a'}\n`)
    continue
  }
  console.log(`${root}`)
  console.log(`  candidates: ${result.found.length}   near misses: ${result.nearMisses.length}   read errors: ${result.errors.length}`)
  for (const p of result.found.slice(0, 10)) {
    console.log(`    ✓ ${p.name}  (${p.hasClient ? 'client+host' : 'host only'})  ${p.repository ?? 'no repository'}`)
  }
  if (result.found.length > 10) console.log(`    … ${result.found.length - 10} more`)
  for (const p of result.nearMisses.slice(0, 5)) {
    console.log(`    ! ${p.name}  — dsh.client only`)
  }
  console.log('')
}

// Deep-check one real installed plugin so the rulebook is exercised against real
// code rather than only fixtures.
const probe = path.join(process.env.USERPROFILE ?? '.', '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-our-free-model')
const diag = diagnose(probe, { category: 'model', descriptionEn: 'Adds free model providers.' })
if (diag.ok) {
  const draft = draftDescriptions({ ...diag, packageJson: {} })
  console.log(`deep check: ${diag.name}`)
  console.log(`  findings: ${diag.summary.error} error / ${diag.summary.warn} warn / ${diag.summary.info} info`)
  for (const f of diag.findings.slice(0, 8)) console.log(`    [${f.level}] ${f.title}`)
  void draft
} else {
  console.log(`deep check skipped: ${diag.error}`)
}
