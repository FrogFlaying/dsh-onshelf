/**
 * Run every suite. Exits non-zero if anything fails.
 *
 * Run: node test/all.mjs
 *
 * @module test/all.mjs
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const suites = [
  ['rules', 'rules.test.mjs'],
  ['scan-links', 'scan-links.test.mjs'],
  ['scan-progress', 'scan-progress.test.mjs'],
  ['actions', 'actions.test.mjs'],
  ['publish', 'publish.test.mjs'],
  ['update', 'update.test.mjs'],
  ['pr-status', 'pr-status.test.mjs'],
  ['flow', 'flow.test.mjs'],
  ['host', 'host-integration.mjs'],
  ['client', 'client-render.mjs'],
]

let failedSuites = 0
for (const [label, file] of suites) {
  console.log(`\n═══ ${label} ═══`)
  const result = spawnSync(process.execPath, [path.join(here, file)], { stdio: 'inherit' })
  if (result.status !== 0) failedSuites++
}

console.log('')
if (failedSuites === 0) {
  console.log('all suites passed')
  process.exit(0)
}
console.error(`${failedSuites} suite(s) failed`)
process.exit(1)
