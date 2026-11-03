/**
 * Regression tests for the two defects reported after the first real run:
 *
 *   1. The "→ 按功能自动推荐" lines were plain text, not buttons, and most findings
 *      had no fix implementation at all — so a blocked plugin could not be fixed
 *      from the UI.
 *   2. The English description was Chinese, because `package.json#description` was
 *      reused as `description.en` without checking its language.
 *
 * Run: node test/actions.test.mjs
 *
 * @module test/actions.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { checkPackage, looksEnglish, hasCjk, summarize } from '../lib/rules.js'
import { inspectPackage } from '../lib/scan.js'
import { draftDescriptions, applyDraftFix, inferCategory } from '../lib/entry.js'
import { diagnose, applyFixes } from '../lib/check.js'

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onshelf-actions-'))

/** A plugin whose package.json description is Chinese, like the real one. */
function writeChinesePlugin(dir, overrides = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const pkg = {
    name: 'dsh-desktop-organizer',
    version: '0.1.0',
    type: 'module',
    description: '整理 Windows 桌面：按类别归类快捷方式，找出没在桌面建快捷方式的已安装程序。',
    meta: { title: '桌面整理', description: '归类桌面快捷方式、发现未建快捷方式的程序。' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    ...overrides,
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), "- insert:\n    - id: desktop-organizer\n      name: 'dsh-desktop-organizer'\n")
  fs.writeFileSync(path.join(dir, 'index.js'), [
    'export const name = "desktop-organizer"',
    'export function apply(ctx) {',
    '  ctx.tools.register({',
    "    name: 'desktop_organize',",
    "    description: 'Inspect and tidy the Windows desktop.',",
    '    async execute() { return "ok" },',
    '  })',
    '}',
  ].join('\n'))
  fs.writeFileSync(path.join(dir, 'README.md'), '# desktop organizer\n')
  return dir
}

console.log('language detection')
test('a Chinese sentence is not English', () => {
  assert.equal(looksEnglish('整理 Windows 桌面。'), false)
  assert.equal(hasCjk('整理 Windows 桌面。'), true)
})
test('an English sentence is English', () => {
  assert.equal(looksEnglish('Groups desktop shortcuts by category.'), true)
})

console.log('② english draft must not be Chinese')
const cnPlugin = writeChinesePlugin(path.join(root, 'cn-plugin'))

test('the drafted English line contains no CJK', () => {
  const pkg = inspectPackage(cnPlugin)
  const drafted = draftDescriptions(pkg)
  assert.equal(hasCjk(drafted.en), false, `English draft is Chinese: ${drafted.en}`)
  assert.equal(looksEnglish(drafted.en), true, `not English: ${drafted.en}`)
})

test('the Chinese draft keeps the Chinese source', () => {
  const pkg = inspectPackage(cnPlugin)
  const drafted = draftDescriptions(pkg)
  assert.equal(hasCjk(drafted.zh), true)
  assert.match(drafted.zh, /归类桌面快捷方式|整理 Windows 桌面/)
})

test('a derived English line is flagged as needing translation', () => {
  const pkg = inspectPackage(cnPlugin)
  const drafted = draftDescriptions(pkg)
  assert.equal(drafted.needsTranslation, true)
  assert.match(drafted.sources.englishSource, /code surface/)
})

test('the derived English line only states what the code registers', () => {
  const pkg = inspectPackage(cnPlugin)
  const drafted = draftDescriptions(pkg)
  assert.match(drafted.en, /registers 1 agent tool \(desktop_organize\)/)
})

test('an English description is used as-is and not flagged', () => {
  const dir = writeChinesePlugin(path.join(root, 'en-plugin'), {
    name: 'dsh-en-plugin',
    description: 'Groups desktop shortcuts by category.',
  })
  const pkg = inspectPackage(dir)
  const drafted = draftDescriptions(pkg)
  assert.match(drafted.en, /^Groups desktop shortcuts by category\./)
  assert.equal(drafted.needsTranslation, false)
})

test('a Chinese line in description.en is reported as an error', () => {
  const pkg = inspectPackage(cnPlugin)
  const findings = checkPackage(pkg, {
    category: 'ui',
    descriptionEn: '整理 Windows 桌面。',
  })
  const f = findings.find(x => x.id === 'description-en-not-english')
  assert.ok(f, `expected description-en-not-english; got ${findings.map(x => x.id)}`)
  assert.equal(f.level, 'error')
  assert.equal(f.action.kind, 'draft')
})

console.log('② findings must carry a real action')
test('every auto-fixable finding names an action kind', () => {
  const pkg = inspectPackage(cnPlugin)
  const findings = checkPackage(pkg, { descriptionEn: '' })
  for (const f of findings) {
    if (f.fixable) {
      assert.ok(f.action, `${f.id} is fixable but has no action`)
      assert.ok(['file', 'draft'].includes(f.action.kind), `${f.id} has action kind ${f.action.kind}`)
    }
  }
})

test('a manual-only finding is not advertised as fixable', () => {
  const pkg = inspectPackage(cnPlugin)
  const findings = checkPackage(pkg, { category: 'ui', descriptionEn: 'Groups shortcuts.' }, {
    topics: [], repoAgeDays: 0.2,
  })
  for (const id of ['topic-missing', 'repo-too-new']) {
    const f = findings.find(x => x.id === id)
    assert.ok(f, `missing ${id}`)
    assert.equal(f.fixable, false, `${id} must not claim to be fixable`)
    assert.equal(f.action.kind, 'manual')
    assert.ok(f.action.hint.length > 0, `${id} needs a hint`)
  }
})

test('missing category and description offer draft actions', () => {
  const pkg = inspectPackage(cnPlugin)
  const findings = checkPackage(pkg, {})
  const cat = findings.find(f => f.id === 'category-missing')
  assert.equal(cat.action.kind, 'draft')
  assert.equal(cat.action.field, 'category')
  const en = findings.find(f => f.id === 'description-en-missing' || f.id === 'description-en-not-english')
  assert.ok(en, 'expected a description finding')
  assert.equal(en.action.kind, 'draft')
  assert.equal(en.action.field, 'descriptionEn')
})

console.log('draft actions actually change the draft')
test('suggest fills in a valid category', () => {
  const pkg = inspectPackage(cnPlugin)
  const result = applyDraftFix(pkg, {}, { kind: 'draft', field: 'category', compute: 'suggest' })
  assert.equal(result.ok, true)
  assert.ok(result.patch.category)
  assert.match(result.patch.category, /^(ui|tools|dev|workflow)$/)
})

test('draft fills an English description with no CJK', () => {
  const pkg = inspectPackage(cnPlugin)
  const result = applyDraftFix(pkg, { descriptionEn: '' }, { kind: 'draft', field: 'descriptionEn', compute: 'draft' })
  assert.equal(result.ok, true)
  assert.equal(hasCjk(result.patch.descriptionEn), false)
  assert.ok(result.note, 'a derived description should say so')
})

test('clean strips marketing words and adds the period', () => {
  const pkg = inspectPackage(cnPlugin)
  const result = applyDraftFix(pkg, { descriptionEn: 'A powerful tool' }, { kind: 'draft', field: 'descriptionEn', compute: 'clean' })
  assert.equal(result.ok, true)
  assert.ok(!/powerful/i.test(result.patch.descriptionEn))
  assert.ok(result.patch.descriptionEn.endsWith('.'))
})

test('period only adds the period', () => {
  const pkg = inspectPackage(cnPlugin)
  const result = applyDraftFix(pkg, { descriptionEn: 'Groups shortcuts' }, { kind: 'draft', field: 'descriptionEn', compute: 'period' })
  assert.equal(result.patch.descriptionEn, 'Groups shortcuts.')
})

test('a non-draft action is refused rather than silently ignored', () => {
  const pkg = inspectPackage(cnPlugin)
  const result = applyDraftFix(pkg, {}, { kind: 'file', fix: 'add-bundle' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /草稿/)
})

console.log('the whole flow: a blocked plugin becomes submittable')
test('applying every action clears the blocking errors', () => {
  const dir = writeChinesePlugin(path.join(root, 'flow'))
  let draft = {}

  // What /autofix does: file plan first, then every draft action.
  const first = diagnose(dir, draft, {})
  assert.ok(first.summary.blocked, 'fixture should start blocked')
  applyFixes(first.fixPlan)

  for (let pass = 0; pass < 3; pass++) {
    const pkgNow = inspectPackage(dir)
    const findings = checkPackage(pkgNow, draft, {})
    const actionable = findings.filter(f => f.action?.kind === 'draft')
    if (actionable.length === 0) break
    let changed = false
    for (const f of actionable) {
      const r = applyDraftFix(pkgNow, draft, f.action)
      if (!r.ok) continue
      const next = { ...draft, ...r.patch }
      if (JSON.stringify(next) === JSON.stringify(draft)) continue
      draft = next
      changed = true
    }
    if (!changed) break
  }

  const after = diagnose(dir, draft, { targetRepo: 'alice/dsh-desktop-organizer' })
  // repository-missing is a manual hint, so it must not be an error any more.
  assert.equal(after.summary.error, 0, `still blocked: ${after.findings.filter(f => f.level === 'error').map(f => `${f.id}: ${f.title}`).join('; ')}`)
  assert.equal(hasCjk(draft.descriptionEn), false)
  assert.ok(draft.category)
  assert.equal(summarize(after.findings).blocked, false)
})

console.log('category recommendation')
test('a desktop/file utility is categorised as tools, not ui', () => {
  const pkg = inspectPackage(cnPlugin)
  assert.equal(
    inferCategory(pkg, '').category,
    'tools',
    'a plugin that operates on the desktop is not a "UI enhancement"',
  )
})

test('a plugin that really changes the interface is categorised as ui', () => {
  const dir = writeChinesePlugin(path.join(root, 'ui-plugin'), {
    name: 'dsh-pretty-sidebar',
    description: 'Restyled sidebar panel with a new layout and buttons.',
    meta: undefined,
  })
  const pkg = inspectPackage(dir)
  assert.equal(inferCategory(pkg, '').category, 'ui')
})

test('a theme plugin wins over the ui rule', () => {
  const dir = writeChinesePlugin(path.join(root, 'theme-plugin'), {
    name: 'dsh-theme-x',
    description: 'A theme with a new palette for the sidebar.',
    meta: undefined,
  })
  const pkg = inspectPackage(dir)
  assert.equal(inferCategory(pkg, '').category, 'theme')
})

console.log('warnings that used to be noise')
test('an empty draft screenshot list is not reported as an empty file', () => {
  // The plugin has no screenshots.json at all; the draft simply carries [].
  const pkg = inspectPackage(cnPlugin)
  assert.equal(pkg.hasScreenshots, false)
  const findings = checkPackage(pkg, { category: 'tools', descriptionEn: 'Groups shortcuts.', screenshots: [] })
  assert.ok(
    !findings.some(f => f.id === 'screenshots-empty'),
    'an absent file must not be reported as an empty file',
  )
  const missing = findings.find(f => f.id === 'screenshots-missing')
  assert.ok(missing, 'expected the informational "no screenshots" finding')
  assert.equal(missing.level, 'info')
})

test('a screenshots.json that exists but lists nothing is a warning', () => {
  const dir = writeChinesePlugin(path.join(root, 'empty-shots'), { name: 'dsh-empty-shots' })
  fs.writeFileSync(path.join(dir, 'screenshots.json'), '[]')
  const pkg = inspectPackage(dir)
  assert.equal(pkg.hasScreenshots, true)
  const findings = checkPackage(pkg, { category: 'tools', descriptionEn: 'Groups shortcuts.' })
  const f = findings.find(x => x.id === 'screenshots-empty')
  assert.ok(f, `expected screenshots-empty; got ${findings.map(x => x.id)}`)
  assert.equal(f.level, 'warn')
})

test('declared screenshots that do not exist on disk are an error', () => {
  const pkg = inspectPackage(cnPlugin)
  const findings = checkPackage(pkg, {
    category: 'tools',
    descriptionEn: 'Groups shortcuts.',
    screenshots: ['assets/missing.png'],
  })
  const f = findings.find(x => x.id === 'screenshot-path')
  assert.ok(f, `expected screenshot-path; got ${findings.map(x => x.id)}`)
  assert.equal(f.level, 'error')
})

console.log('repository field')
test('repository is a file action once the target repo is known', () => {
  const pkg = inspectPackage(cnPlugin)
  const findings = checkPackage(pkg, { category: 'tools', descriptionEn: 'Groups shortcuts.' }, {
    targetRepo: 'https://github.com/alice/dsh-desktop-organizer',
  })
  const f = findings.find(x => x.id === 'repository-missing')
  assert.ok(f, 'expected repository-missing')
  assert.equal(f.action.kind, 'file')
  assert.equal(f.action.fix, 'add-repository')
})

test('repository stays manual when no repo has been given', () => {
  const pkg = inspectPackage(cnPlugin)
  const findings = checkPackage(pkg, { category: 'tools', descriptionEn: 'Groups shortcuts.' })
  const f = findings.find(x => x.id === 'repository-missing')
  assert.equal(f.action.kind, 'manual')
})

test('the written repository URL is normalised from every input shape', () => {
  const shapes = [
    'alice/repo',
    'https://github.com/alice/repo',
    'https://github.com/alice/repo/tree/main/packages/x',
    'git+https://github.com/alice/repo.git',
  ]
  for (const [i, input] of shapes.entries()) {
    const dir = writeChinesePlugin(path.join(root, `repo-${i}`), { name: 'dsh-repo-fixture' })
    const result = diagnose(dir, { category: 'tools', descriptionEn: 'Groups shortcuts.' }, { targetRepo: input })
    applyFixes(result.fixPlan)
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    assert.ok(after.repository, `no repository written for ${input}`)
    assert.equal(
      after.repository.url,
      'git+https://github.com/alice/repo.git',
      `bad URL for input ${input}: ${after.repository.url}`,
    )
  }
})

try {
  fs.rmSync(root, { recursive: true, force: true })
} catch { /* temp dir is disposable */ }

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
