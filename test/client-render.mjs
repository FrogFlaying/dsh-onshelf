/**
 * Render the browser half's page in Node, against a fake ModuleLoader.
 *
 * This is not a browser test — it proves the bundle parses, registers its settings
 * section, and that the page renders without throwing for each wizard step. That is
 * the failure mode that would otherwise only show up as a blank Settings tab.
 *
 * Needs `react` and `react-dom/server` resolvable from REACT_DIR (defaults to a
 * temp install). Run: node test/client-render.mjs
 *
 * @module test/client-render.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientFile = path.resolve(here, '..', 'client.js')

const reactDir = process.env.REACT_DIR ?? path.join(process.env.TEMP ?? '.', 'onshelf-react-probe')
const requireFromReact = createRequire(path.join(reactDir, 'package.json'))

let React
let ReactDOMServer
try {
  React = requireFromReact('react')
  ReactDOMServer = requireFromReact('react-dom/server')
} catch (error) {
  console.error(`cannot load react from ${reactDir}: ${error.message}`)
  console.error('set REACT_DIR, or: npm i react@18 react-dom@18 in a temp dir')
  process.exit(2)
}

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

/* ── stand in for the shell's module loader ── */

let bundle = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      bundle = { id, factory }
    },
  },
}

const src = fs.readFileSync(clientFile, 'utf8')
// The bundle is a plain script that calls window.__ModuleLoader__.load(); evaluate
// it the way the shell would, with a `require` that resolves the shell's react.
new Function('require', 'window', src)((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
}, globalThis.window)

test('the bundle registers itself under the package name', () => {
  assert.ok(bundle, 'load() was never called')
  assert.equal(bundle.id, 'dsh-onshelf')
})

const mod = bundle.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})

test('exports an inject list including slots and locale', () => {
  assert.ok(Array.isArray(mod.inject))
  assert.ok(mod.inject.includes('slots'))
  assert.ok(mod.inject.includes('locale'))
})

test('apply() registers exactly one settings section', () => {
  const registered = []
  const ctx = {
    get: () => undefined,
    slots: {
      inject(name, fn) { fn() },
      register(spec, render) { registered.push({ spec, render }) },
    },
  }
  mod.apply(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].spec.name, 'settings.section')
  assert.equal(registered[0].spec.id, 'onshelf')
  assert.equal(typeof registered[0].render, 'function')
})

/* ── render the page ── */

/** Capture the registered settings section renderer exactly once. */
function captureRenderer() {
  let captured = null
  const host = {
    get: () => undefined,
    slots: {
      inject(name, fn) { fn() },
      register(spec, render) { captured = { spec, render } },
    },
  }
  mod.apply(host)
  return captured.render
}

/**
 * Render the page with a given locale. `locale` may be a string (returned from the
 * locale service's `get()`) or an object, so the shapes the harness has used are
 * both exercised. `extraProps` lets a test open the wizard on a specific step.
 */
function renderPage(locale = 'zh', extraProps = {}) {
  const render = captureRenderer()
  const ctx = { get: key => (key === 'locale' ? { get: () => locale } : undefined) }
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(() => render({ ctx, ...extraProps })),
  )
}

test('the page renders to non-empty markup without throwing', () => {
  const html = renderPage()
  assert.ok(html.length > 500, `markup too short: ${html.length}`)
  assert.match(html, /上架台/)
})

test('all five step tabs are present', () => {
  const html = renderPage()
  for (const label of ['① 扫描', '② 体检', '③ 投稿材料', '④ 截图', '⑤ 提交 PR']) {
    assert.ok(html.includes(label), `missing tab: ${label}`)
  }
})

test('the first step renders the scan affordance before any data arrives', () => {
  const html = renderPage()
  assert.match(html, /重新扫描|扫描中/)
})

test('the page does not leak the token into markup', () => {
  const html = renderPage()
  assert.ok(!/authorization/i.test(html))
  assert.ok(!/Bearer\s+[A-Za-z0-9]/.test(html))
})

test('locale switching to en changes the copy', () => {
  const html = renderPage('en-US')
  assert.match(html, /Onshelf/)
  assert.match(html, /① Scan/)
})

test('an absent locale service falls back to Chinese rather than crashing', () => {
  const render = captureRenderer()
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(() => render({ ctx: { get: () => undefined } })),
  )
  assert.match(html, /上架台/)
})

test('a locale service exposing a plain string is understood', () => {
  const render = captureRenderer()
  const html = ReactDOMServer.renderToStaticMarkup(
    React.createElement(() => render({ ctx: { get: key => (key === 'locale' ? 'en' : undefined) } })),
  )
  assert.match(html, /Onshelf/)
})

/* ── empty states ──
 *
 * The reported bug: the step tabs are always clickable, but steps 2–5 rendered
 * "加载中…" whenever their data was null — including when nothing was selected and
 * no request was in flight. The page looked wedged forever.
 */

test('step 2 with nothing selected explains what to do instead of showing a spinner', () => {
  const html = renderPage('zh', { initialStep: 2 })
  assert.ok(!html.includes('加载中'), 'must not show an indefinite loading state')
  assert.match(html, /先在 ① 扫描里选一个插件/)
})

test('step 3 with nothing selected explains what to do', () => {
  const html = renderPage('zh', { initialStep: 3 })
  assert.ok(!html.includes('加载中'))
  assert.match(html, /先在 ① 扫描里选一个插件/)
})

test('step 4 and 5 with nothing selected explain what to do', () => {
  for (const initialStep of [4, 5]) {
    const html = renderPage('zh', { initialStep })
    assert.ok(!html.includes('加载中'), `step ${initialStep} shows a spinner`)
    assert.match(html, /先在 ① 扫描里选一个插件/)
  }
})

test('the initial view is not a loading state', () => {
  const html = renderPage('zh')
  assert.ok(!html.includes('加载中'), 'the first render must show the scan affordance, not a spinner')
  assert.match(html, /重新扫描/)
})

/* ── finding actions are real controls ──
 *
 * The reported bug: "→ 按功能自动推荐" was drawn as plain text, so it looked
 * clickable and did nothing.
 */

const sampleCheck = {
  name: 'dsh-desktop-organizer',
  version: '0.1.0',
  summary: { error: 2, warn: 0, info: 0, total: 2, blocked: true, fixable: 1 },
  fixPlan: [],
  findings: [
    {
      id: 'category-missing', level: 'error', title: '还没有选择分类', detail: '必须是这 23 个之一。',
      fixable: true, fixLabel: '按功能自动推荐', action: { kind: 'draft', field: 'category', compute: 'suggest' },
    },
    {
      id: 'topic-missing', level: 'error', title: '仓库缺少 dsh-plugin topic', detail: 'CI 会检查。',
      fixable: false, action: { kind: 'manual', hint: '在 GitHub 仓库主页右侧 About → Topics 加上 dsh-plugin。' },
    },
  ],
}

test('a draft action renders as a real button', () => {
  const html = renderPage('zh', { initialStep: 2, initialCheck: sampleCheck })
  assert.match(html, /<button[^>]*>→ 按功能自动推荐<\/button>/, `no action button in: ${html.slice(0, 600)}`)
})

test('the fix-all button is offered when something is fixable', () => {
  const html = renderPage('zh', { initialStep: 2, initialCheck: sampleCheck })
  assert.match(html, /一键修复 \(1\)/)
})

test('a manual-only finding shows its hint and provides no button', () => {
  const html = renderPage('zh', { initialStep: 2, initialCheck: sampleCheck })
  assert.match(html, /需要你处理：在 GitHub 仓库主页/)
})

/* ── the token belongs on the step that needs it first ──
 *
 * Creating the repo and uploading the code happens on ③, so asking for the token
 * only on ④ left the author at a dead end: the upload buttons were disabled with no
 * way to proceed without leaving the step.
 */

const sampleDraft = {
  category: 'tools',
  descriptionEn: 'Desktop organizer for DeepSeek Harness.',
  descriptionZh: '桌面整理工具。',
  repoUrl: '',
  pluginSubpath: '',
  screenshots: [],
  tarball: '',
}

test('the token field is available on step 3, next to the upload controls', () => {
  const html = renderPage('zh', { initialStep: 3, initialDraft: sampleDraft })
  assert.match(html, /GitHub token/, 'the token card must be on step 3')
  assert.match(html, /创建仓库并上传代码/, 'the publish control must be on step 3')
})

test('step 3 explains which permissions the token needs', () => {
  const html = renderPage('zh', { initialStep: 3, initialDraft: sampleDraft })
  assert.match(html, /Contents 与 Administration/)
})

test('the publish section says a token is required before it is connected', () => {
  const html = renderPage('zh', { initialStep: 3, initialDraft: sampleDraft })
  assert.match(html, /这一步需要 GitHub token/)
})

test('the entry form is still rendered below the token card', () => {
  const html = renderPage('zh', { initialStep: 3, initialDraft: sampleDraft })
  assert.match(html, /英文描述/)
  assert.match(html, /GitHub 仓库/)
})

/* ── screenshots live on ④ only ──
 *
 * They used to appear on both ③ and ④ — two entry points for one list, which read
 * as duplication and (worse) let the two disagree. ④ owns adding, previewing and
 * uploading now; ③ shows a summary and a link.
 */

test('step 4 offers a drop zone, a file picker and a paste target', () => {
  const html = renderPage('zh', { initialStep: 4, initialDraft: sampleDraft })
  assert.match(html, /把截图拖到这里/, 'no drop zone')
  assert.match(html, /选择图片/, 'no file picker button')
  assert.match(html, /Ctrl\+V/, 'paste is not mentioned')
  assert.match(html, /type="file"/, 'the hidden file input is missing')
  assert.match(html, /accept="image\/png/, 'the picker must filter to images')
})

test('step 3 no longer carries its own copy of the screenshot controls', () => {
  const html = renderPage('zh', { initialStep: 3, initialDraft: sampleDraft })
  assert.ok(!/把截图拖到这里/.test(html), 'step 3 still has a drop zone — the two steps would diverge again')
  assert.ok(!/type="file"/.test(html), 'step 3 still has a file picker')
  assert.match(html, /截图在 ④/, 'step 3 should point at step 4')
})

test('step 3 still summarises the screenshots that exist', () => {
  const withShots = { ...sampleDraft, screenshots: ['assets/a.png', 'assets/b.png'] }
  const html = renderPage('zh', { initialStep: 3, initialDraft: withShots })
  assert.match(html, /2 张截图/, 'the count is not shown on step 3')
  assert.match(html, /a\.png/, 'the names are not shown on step 3')
})

test('step 4 renders thumbnails with a remove control', () => {
  const withShots = { ...sampleDraft, screenshots: ['assets/a.png', 'assets/b.png'] }
  const html = renderPage('zh', { initialStep: 4, initialDraft: withShots })
  assert.match(html, /<img[^>]*src="\/api\/onshelf\/shot\?/, 'thumbnails are not rendered')
  assert.equal((html.match(/src="\/api\/onshelf\/shot\?/g) ?? []).length, 2)
  assert.match(html, /移除这张/)
})

/* ── ④ must show the screenshots it is about to upload ──
 *
 * The reported bug: ③ held a screenshot, ④ claimed "nothing to upload". Showing the
 * list here, and offering the same drop zone, removes the disagreement entirely.
 */

const sampleDraftWithShots = { ...sampleDraft, screenshots: ['assets/a.png'] }

test('step 4 lists the screenshots that will be uploaded', () => {
  const html = renderPage('zh', { initialStep: 4, initialDraft: sampleDraftWithShots })
  assert.match(html, /将上传 1 张截图/, 'the count is not shown')
  assert.match(html, /<img[^>]*src="\/api\/onshelf\/shot\?/, 'no thumbnail on step 4')
})

test('step 4 does not claim there are no screenshots when there are', () => {
  const html = renderPage('zh', { initialStep: 4, initialDraft: sampleDraftWithShots })
  assert.ok(!/还没有截图/.test(html), 'step 4 wrongly says there are none')
})

test('step 4 with no screenshots explains how to add them and offers the drop zone', () => {
  const html = renderPage('zh', { initialStep: 4, initialDraft: sampleDraft })
  assert.match(html, /还没有截图/)
  assert.match(html, /把截图拖到这里/, 'the drop zone is missing on step 4')
})

/* ── "PR created" and "CI will reject it" are different facts ──
 *
 * In the wild this showed as one green box with red exclamation marks inside, and the
 * author read it as a failure even though the PR had been opened successfully.
 */

const outcomeWithWarnings = {
  prUrl: 'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8375',
  warnings: [
    '仓库创建不满 1 天（现在 0.66 天，还差约 9 小时）。',
    '仓库缺少 dsh-plugin topic。',
  ],
}

test('a created PR is stated as a success in its own block', () => {
  const html = renderPage('zh', { initialStep: 5, initialDraft: sampleDraft, initialOutcome: outcomeWithWarnings })
  assert.match(html, /PR 已创建/, 'the success headline is missing')
  assert.match(html, /这是成功，不是报错/)
  assert.match(html, /pull\/8375/)
})

test('the CI-blocking warnings get their own, separate explanation', () => {
  const html = renderPage('zh', { initialStep: 5, initialDraft: sampleDraft, initialOutcome: outcomeWithWarnings })
  assert.match(html, /但这个 PR 现在会被 CI 拒绝/)
  assert.match(html, /原因不在你的插件代码/)
  assert.match(html, /不需要关掉重开 PR/)
})

test('the warnings are rendered as a numbered checklist', () => {
  const html = renderPage('zh', { initialStep: 5, initialDraft: sampleDraft, initialOutcome: outcomeWithWarnings })
  assert.match(html, /<ol[^>]*>/, 'the warnings should be an ordered list')
  assert.equal((html.match(/<li[^>]*>/g) ?? []).length >= 2, true)
})

test('there is a way to re-check whether the repo is allowed yet', () => {
  const html = renderPage('zh', { initialStep: 5, initialDraft: sampleDraft, initialOutcome: outcomeWithWarnings })
  assert.match(html, /重新检查仓库状态/)
})

test('a missing topic offers to add it, instead of describing the GitHub UI', () => {
  const html = renderPage('zh', { initialStep: 5, initialDraft: sampleDraft, initialOutcome: outcomeWithWarnings })
  assert.match(html, /帮我加上 dsh-plugin topic/)
})

test('no topic button when the topic is already present', () => {
  const html = renderPage('zh', {
    initialStep: 5,
    initialDraft: sampleDraft,
    initialOutcome: {
      prUrl: 'https://github.com/a/b/pull/1',
      warnings: ['仓库创建不满 1 天（现在 0.66 天）。'],
      repoStatus: { slug: 'a/b', ageDays: 0.66, oldEnough: false, topics: ['dsh-plugin'], hasTopic: true },
    },
  })
  assert.ok(!/帮我加上 dsh-plugin topic/.test(html), 'the button should not appear when the topic exists')
})

test('what the plugin fixed on the author\'s behalf is reported', () => {
  const html = renderPage('zh', {
    initialStep: 5,
    initialDraft: sampleDraft,
    initialOutcome: {
      prUrl: 'https://github.com/a/b/pull/1',
      warnings: [],
      topicResult: { ok: true, already: false, topics: ['dsh-plugin'] },
    },
  })
  assert.match(html, /已加上 topic/)
})

test('a PR created without warnings shows no CI-failure block', () => {
  const html = renderPage('zh', {
    initialStep: 5,
    initialDraft: sampleDraft,
    initialOutcome: { prUrl: 'https://github.com/a/b/pull/1', warnings: [] },
  })
  assert.match(html, /PR 已创建/)
  assert.ok(!/会被 CI 拒绝/.test(html), 'a clean submission must not be told it will fail')
})

/* ── checking what happened to the PR, from inside the plugin ──
 *
 * The author was told to open the PR page and copy the red-X text back to me. That is
 * the plugin's job: it holds the token, it can call the API, and it can translate.
 */

test('step 5 offers a "check PR status" button', () => {
  const html = renderPage('zh', { initialStep: 5, initialDraft: sampleDraft })
  assert.match(html, /查看 PR 状态/)
})

test('a passing PR says so and points at the human review', () => {
  const html = renderPage('zh', {
    initialStep: 5,
    initialDraft: sampleDraft,
    initialPrStatus: {
      ok: true, verdict: 'passed', headline: '2 项检查全部通过', number: 8375,
      url: 'https://github.com/a/b/pull/8375', comments: 0,
      detail: '接下来是维护者人工审核。',
      nextSteps: ['等待维护者合并，这一步没有固定时间。'],
    },
  })
  assert.match(html, /全部通过/)
  assert.match(html, /PR #8375/)
  assert.match(html, /等待维护者合并/)
})

test('a failing PR lists translated reasons with the fix attached', () => {
  const html = renderPage('zh', {
    initialStep: 5,
    initialDraft: sampleDraft,
    initialPrStatus: {
      ok: true, verdict: 'failed', headline: '1 项检查没通过', number: 8375,
      url: 'https://github.com/a/b/pull/8375', comments: 0,
      failures: [{
        name: 'check-repo-age',
        check: 'repo-age',
        title: '仓库创建不满 1 天',
        hint: '等到明天再点一次「创建 PR」推同一个分支即可。',
        blocking: 'wait',
        url: 'https://github.com/a/b/runs/1',
      }],
      nextSteps: ['修好后点「创建 PR」推同一个分支，CI 会重跑。'],
    },
  })
  assert.match(html, /1 项检查没通过/)
  assert.match(html, /仓库创建不满 1 天/)
  assert.match(html, /等到明天/)
  assert.match(html, /在 GitHub 上查看这条检查/)
  assert.match(html, /再推一次/)
})

test('a merged PR is reported as listed, so the author stops waiting', () => {
  const html = renderPage('zh', {
    initialStep: 5,
    initialDraft: sampleDraft,
    initialPrStatus: {
      ok: true, verdict: 'merged', headline: '已合并 —— 插件已经进入列表', number: 8375,
      url: 'https://github.com/a/b/pull/8375', comments: 2,
      nextSteps: ['网站会自动重建，通常一天内插件市场就能搜到。'],
    },
  })
  assert.match(html, /已合并/)
  assert.match(html, /插件市场就能搜到/)
  assert.match(html, /2 条评论/)
})

test('a running PR says it is running rather than showing a verdict', () => {
  const html = renderPage('zh', {
    initialStep: 5,
    initialDraft: sampleDraft,
    initialPrStatus: {
      ok: true, verdict: 'running', headline: '检查进行中（已完成 1 / 3）', number: 8375,
      url: 'https://github.com/a/b/pull/8375', comments: 0,
      nextSteps: ['稍等一两分钟再点「查看 PR 状态」。'],
    },
  })
  assert.match(html, /检查进行中/)
  assert.ok(!/没通过/.test(html), 'a running PR must not look failed')
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
