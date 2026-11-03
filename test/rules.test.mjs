/**
 * Rulebook tests — every assertion here cites a line of contributing.md.
 *
 * Run: node test/rules.test.mjs
 *
 * @module test/rules.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  analyzePeerRange, checkScreenshotPath, checkTarballUrl, findMarketingWords,
  needsYamlQuote, yamlScalar, summarize, CATEGORIES, checkPackage,
} from '../lib/rules.js'
import { inspectPackage } from '../lib/scan.js'
import {
  makeTempRoot, removeTempRoot, writeGoodPlugin, writeClientOnlyPlugin,
  writePeerTrapPlugin, writeBadPatchPlugin, writePlainPackage,
} from './fixtures.js'

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.error(`  FAIL ${name}`)
    console.error(`       ${error.message}`)
  }
}

const root = makeTempRoot()

console.log('rules: YAML scalar quoting')
test('": " forces quoting (contributing.md line 31)', () => {
  assert.equal(needsYamlQuote('Vision toolkit: OCR and diff.'), true)
  assert.equal(needsYamlQuote('A tool that reads images.'), false)
})
test('yamlScalar quotes only when required', () => {
  assert.equal(yamlScalar('Plain description.'), 'Plain description.')
  assert.equal(yamlScalar('Toolkit: OCR.'), "'Toolkit: OCR.'")
})
test('yamlScalar doubles embedded single quotes', () => {
  assert.equal(yamlScalar("Alice's plugin: works."), "'Alice''s plugin: works.'")
})

console.log('rules: peer ranges (contributing.md line 132)')
test('broad range without a prerelease comparator on the tuple is rejected', () => {
  const verdict = analyzePeerRange('>=0.0.1-rc.1 <0.2.0')
  assert.equal(verdict.ok, false)
  assert.match(verdict.suggested, /\|\|/)
})
test('"match everything" range is also rejected', () => {
  assert.equal(analyzePeerRange('>=0.0.0-0 <0.2.0-0').ok, false)
})
test('explicit prerelease branch is accepted', () => {
  assert.equal(analyzePeerRange('>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0').ok, true)
})
test('a range with no prerelease tag at all only warns', () => {
  const verdict = analyzePeerRange('^0.1.0')
  assert.equal(verdict.ok, true)
  assert.ok(verdict.warning)
})

console.log('rules: marketing words (contributing.md line 80)')
test('English superlatives are found', () => {
  assert.deepEqual(findMarketingWords('A powerful and seamless tool.'), ['powerful', 'seamless'])
})
test('Chinese superlatives are found', () => {
  assert.ok(findMarketingWords('一个强大的插件').includes('强大'))
})
test('a factual description is clean', () => {
  assert.deepEqual(findMarketingWords('Registers one agent tool that greets a person by name.'), [])
})

console.log('rules: screenshots (contributing.md lines 189-193)')
test('relative path inside the plugin dir is accepted', () => {
  assert.equal(checkScreenshotPath('assets/a.png').ok, true)
})
test('leading slash is rejected', () => {
  assert.equal(checkScreenshotPath('/abs/a.png').ok, false)
})
test('.. escape is rejected', () => {
  assert.equal(checkScreenshotPath('../a.png').ok, false)
})
test('third-party host is rejected', () => {
  assert.equal(checkScreenshotPath('https://imgur.com/a.png').ok, false)
})
test('GitHub-hosted absolute URL is accepted', () => {
  assert.equal(checkScreenshotPath('https://raw.githubusercontent.com/o/r/main/a.png').ok, true)
})
test('http (not https) is rejected', () => {
  assert.equal(checkScreenshotPath('http://raw.githubusercontent.com/o/r/a.png').ok, false)
})
test('non-image extension is rejected', () => {
  assert.equal(checkScreenshotPath('assets/a.txt').ok, false)
})

console.log('rules: tarball rot (contributing.md line 124)')
test('latest/download with a versioned filename warns', () => {
  const verdict = checkTarballUrl('https://github.com/o/r/releases/latest/download/r-1.2.0.tgz')
  assert.equal(verdict.ok, true)
  assert.match(verdict.warning, /404|静默|字面/)
})
test('latest/download with an unversioned filename is fine', () => {
  const verdict = checkTarballUrl('https://github.com/o/r/releases/latest/download/r.tgz')
  assert.equal(verdict.ok, true)
  assert.equal(verdict.warning, undefined)
})
test('non-GitHub host is rejected', () => {
  assert.equal(checkTarballUrl('https://example.com/r.tgz').ok, false)
})
test('non-.tgz is rejected', () => {
  assert.equal(checkTarballUrl('https://github.com/o/r/releases/download/v1/r.zip').ok, false)
})

console.log('rules: package findings')
test('a compliant plugin produces no errors', () => {
  const dir = writeGoodPlugin(root)
  const pkg = inspectPackage(dir)
  const findings = checkPackage(pkg, {
    category: 'tools',
    descriptionEn: 'Greets people by name from a registered agent tool.',
    descriptionZh: '注册一个按名字打招呼的 agent 工具。',
    screenshots: ['assets/shot-1.png'],
  })
  const errors = findings.filter(f => f.level === 'error')
  assert.deepEqual(errors, [], `unexpected errors: ${errors.map(e => e.title).join('; ')}`)
})

test('dsh.client only is a blocking error', () => {
  const dir = writeClientOnlyPlugin(root)
  const pkg = inspectPackage(dir)
  const findings = checkPackage(pkg, { category: 'ui', descriptionEn: 'Does a thing.' })
  const bundle = findings.find(f => f.id === 'bundle-missing')
  assert.ok(bundle, 'expected bundle-missing')
  assert.equal(bundle.level, 'error')
  assert.equal(bundle.fixable, true)
})

test('official packages in dependencies are a blocking error', () => {
  const dir = writePeerTrapPlugin(root)
  const pkg = inspectPackage(dir)
  const findings = checkPackage(pkg, { category: 'tools', descriptionEn: 'Uses the harness.' })
  assert.ok(findings.some(f => f.id === 'official-in-dependencies' && f.level === 'error'))
  assert.ok(findings.some(f => f.id === 'peer-prerelease-range' && f.level === 'error'))
})

test('a patch file that is a mapping is a blocking error', () => {
  const dir = writeBadPatchPlugin(root)
  const pkg = inspectPackage(dir)
  const findings = checkPackage(pkg, { category: 'tools', descriptionEn: 'Wrong patch shape.' })
  assert.ok(findings.some(f => f.id === 'patch-not-array' && f.level === 'error'))
})

test('marketing in the description is a blocking error', () => {
  const dir = writeGoodPlugin(root)
  const pkg = inspectPackage(dir)
  const findings = checkPackage(pkg, { category: 'tools', descriptionEn: 'A powerful greeting tool.' })
  assert.ok(findings.some(f => f.id === 'description-marketing' && f.level === 'error'))
})

test('missing English description is a blocking error', () => {
  const dir = writeGoodPlugin(root)
  const pkg = inspectPackage(dir)
  const findings = checkPackage(pkg, { category: 'tools', descriptionEn: '' })
  assert.ok(findings.some(f => f.id === 'description-en-missing' && f.level === 'error'))
})

test('an invalid category is a blocking error', () => {
  const dir = writeGoodPlugin(root)
  const pkg = inspectPackage(dir)
  const findings = checkPackage(pkg, { category: 'nonsense', descriptionEn: 'Greets people.' })
  assert.ok(findings.some(f => f.id === 'category-invalid' && f.level === 'error'))
})

test('a repo younger than 1 day is a blocking error', () => {
  const dir = writeGoodPlugin(root)
  const pkg = inspectPackage(dir)
  const findings = checkPackage(pkg, { category: 'tools', descriptionEn: 'Greets people.' }, { repoAgeDays: 0.2 })
  assert.ok(findings.some(f => f.id === 'repo-too-new' && f.level === 'error'))
})

test('a missing dsh-plugin topic is a blocking error', () => {
  const dir = writeGoodPlugin(root)
  const pkg = inspectPackage(dir)
  const findings = checkPackage(pkg, { category: 'tools', descriptionEn: 'Greets people.' }, { topics: ['dsh'] })
  assert.ok(findings.some(f => f.id === 'topic-missing' && f.level === 'error'))
})

test('summarize counts by level and flags blocked', () => {
  const s = summarize([
    { level: 'error' }, { level: 'warn' }, { level: 'warn' }, { level: 'info' },
  ])
  assert.equal(s.error, 1)
  assert.equal(s.warn, 2)
  assert.equal(s.info, 1)
  assert.equal(s.blocked, true)
  assert.equal(s.total, 4)
})

test('every category in the guide is accepted', () => {
  assert.equal(CATEGORIES.length, 23)
  assert.ok(CATEGORIES.includes('theme'))
  assert.ok(CATEGORIES.includes('market'))
})

removeTempRoot(root)

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
