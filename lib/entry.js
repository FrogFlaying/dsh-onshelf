/**
 * Step ③ — build the submission materials.
 *
 * Two rules shape everything here:
 *   1. `description.en` is the only required field, so it is the one thing the
 *      generator must get right; `zh` is optional but decides Chinese click-through.
 *   2. The guide says the description is *checked against the code*. So the
 *      generator only ever states what it can read out of the package: declared
 *      tools, declared commands, the meta block, the keywords. It never invents a
 *      capability, and it reports every claim it made so the author can confirm it.
 *
 * @module lib/entry.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { CATEGORIES, CATEGORY_LABELS, findMarketingWords, needsYamlQuote, yamlScalar, checkScreenshotPath, checkTarballUrl, looksEnglish, hasCjk } from './rules.js'
import { entryFileName, parseGithubUrl, parseRepoSlug } from './scan.js'

/**
 * Category inference from name, keywords, description and — most reliably — the
 * code surface it actually declares. Ordered: the first rule that fires wins, and
 * the order encodes priority (a theme plugin that also registers a tool is still
 * a theme).
 */
const CATEGORY_RULES = [
  { category: 'theme', re: /\b(theme|skin|palette|wallpaper|appearance|主题|皮肤|配色|壁纸)\b/i },
  { category: 'market', re: /\b(plugin[\s-]?market|marketplace|storefront|registry|awesome[\s-]?dsh|收录|插件市场|投稿|上架)\b/i },
  { category: 'memory', re: /\b(memory|remember|recall|knowledge[\s-]?base|记忆|知识库|回忆)\b/i },
  { category: 'voice', re: /\b(tts|speech|voice|audio|sound|音乐|语音|朗读|音效)\b/i },
  { category: 'vision', re: /\b(ocr|vision|识图)\b/i },
  { category: 'browser', re: /\b(browser|webview|playwright|puppeteer|浏览器|网页抓取)\b/i },
  { category: 'wsl', re: /\b(wsl|linux|distro|ubuntu|子系统)\b/i },
  { category: 'git', re: /\b(git|github|commit|branch|merge|版本控制)\b/i },
  { category: 'notify', re: /\b(notif|alert|remind|toast|通知|提醒|告警)\b/i },
  { category: 'docs', re: /\b(docx?|markdown|pdf|document|文档)\b/i },
  { category: 'skill', re: /\b(skill|prompt[\s-]?pack|技能|提示词包)\b/i },
  { category: 'session', re: /\b(session|conversation|transcript|会话|对话记录)\b/i },
  { category: 'usage', re: /\b(token|usage|cost|billing|quota|用量|费用|计费)\b/i },
  { category: 'model', re: /\b(provider|model|llm|inference|模型|推理)\b/i },
  { category: 'identity', re: /\b(persona|identity|character|role[\s-]?play|人设|角色)\b/i },
  { category: 'security', re: /\b(security|audit|secret|credential|安全|审计|凭据)\b/i },
  { category: 'remote', re: /\b(remote|ssh|tunnel|远程|隧道)\b/i },
  { category: 'workflow', re: /\b(workflow|pipeline|automation|schedul|流程|自动化|编排)\b/i },
  // Operating-system utilities. Checked before `ui`: a plugin that operates on the
  // desktop, files or processes is a tool, even though it happens to ship a settings
  // page. Having a browser half does not make something a "UI enhancement".
  { category: 'tools', re: /\b(desktop|shortcut|clipboard|file[\s-]?system|folder|directory|process|registry|windows|system|桌面|快捷方式|剪贴板|文件|文件夹|目录|进程|注册表|系统)\b/i },
  { category: 'ui', re: /\b(ui|sidebar|panel|widget|button|layout|界面|面板|侧边栏|按钮|布局)\b/i },
  { category: 'dev', re: /\b(lint|build|scaffold|plugin[\s-]?dev|开发|构建|脚手架)\b/i },
  { category: 'fun', re: /\b(pet|game|meme|easter[\s-]?egg|玩具|游戏|宠物|彩蛋)\b/i },
]

/** Infer a category, preferring what the code actually does. */
export function inferCategory(pkg, text = '') {
  const haystack = [
    pkg.name,
    pkg.description,
    (pkg.keywords ?? []).join(' '),
    pkg.metaTitle ?? '',
    text,
  ].join(' ')
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(haystack)) return { category: rule.category, reason: `名称/描述/关键词命中「${rule.re.source.slice(0, 40)}…」` }
  }
  // No signal at all. Say so plainly: the recommendation is a guess, and the guide
  // is explicit that a near-miss category is fixed by a maintainer, never bounced.
  return {
    category: pkg.hasClient ? 'ui' : 'tools',
    reason: '没有足够信号判断功能，按「带不带浏览器半身」猜的；分类选不准不会被打回，维护者会改。',
  }
}

/**
 * Read what the package actually declares, so descriptions can be built from
 * facts. Deliberately shallow: we look for `ctx.tools.register({ name: '...' })`
 * and `registerCommand`-style calls in the entry files, plus the patch file.
 */
export function readSurface(pkg) {
  const tools = new Set()
  const commands = new Set()
  const slots = new Set()
  const entryFiles = []

  const candidates = ['index.js', 'index.mjs', 'main.js', 'lib/index.js', 'src/index.js']
  for (const rel of candidates) {
    const abs = path.join(pkg.dir, rel)
    if (fs.existsSync(abs)) entryFiles.push(abs)
  }
  const pkgMain = pkg.packageJson?.main ?? pkg.packageJson?.exports?.['.']
  if (typeof pkgMain === 'string') {
    const abs = path.join(pkg.dir, pkgMain)
    if (fs.existsSync(abs) && !entryFiles.includes(abs)) entryFiles.push(abs)
  }

  for (const file of entryFiles) {
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    // tools.register({ name: 'x' ... }) / defineTool({ name: 'x' ... })
    const toolRe = /(?:tools\.register|defineTool)\s*\(\s*\{[\s\S]{0,400}?name:\s*['"`]([\w.:-]+)['"`]/g
    let m
    while ((m = toolRe.exec(text)) !== null) tools.add(m[1])
    // registerCommand('x', ...) / commands.register({ name: 'x' })
    const cmdRe = /(?:registerCommand|commands\.register)\s*\(\s*(?:\{[\s\S]{0,200}?name:\s*)?['"`]([\w.:-]+)['"`]/g
    while ((m = cmdRe.exec(text)) !== null) commands.add(m[1])
    // slots.register({ name: 'settings.section', id: 'x' })
    const slotRe = /slots\.register\s*\(\s*\{[\s\S]{0,200}?name:\s*['"`]([\w.-]+)['"`]/g
    while ((m = slotRe.exec(text)) !== null) slots.add(m[1])
  }

  return {
    tools: [...tools].sort(),
    commands: [...commands].sort(),
    slots: [...slots].sort(),
    entryFiles: entryFiles.map(f => path.relative(pkg.dir, f)),
  }
}

/** Strip marketing words from a sentence and tidy the result. */
export function cleanDescription(text) {
  let value = String(text ?? '')
  for (const word of findMarketingWords(value)) {
    const isCjk = /[\u4e00-\u9fff]/.test(word)
    const re = isCjk
      ? new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      : new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    value = value.replace(re, '')
  }
  value = value
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,;:]+/, '')
    .trim()
  return value
}

/** Ensure a sentence ends with a period, in the language it is written in. */
export function ensurePeriod(text, lang = 'en') {
  const value = String(text ?? '').trim()
  if (value === '') return value
  if (/[.!?。！？]$/.test(value)) return value
  return value + (lang === 'zh' ? '。' : '.')
}

/**
 * Draft both descriptions from what the package declares.
 *
 * **Language is decided per source, not assumed.** A Chinese plugin commonly has a
 * Chinese `package.json` description, and reusing it as `description.en` produces
 * an "English" field full of Chinese — wrong for an English-first list, and a
 * reliable way to get a PR sent back. So the sources are classified first, and the
 * English line only ever uses an English source; when there is none, it falls back
 * to facts the code proves and says so via `needsTranslation`.
 *
 * Everything asserted is something `readSurface` observed. Nothing is invented.
 */
export function draftDescriptions(pkg, options = {}) {
  const surface = options.surface ?? readSurface(pkg)
  const title = (pkg.metaTitle ?? pkg.name ?? '').trim()
  const description = cleanDescription(pkg.description ?? '')
  const metaDescription = cleanDescription(pkg.packageJson?.meta?.description ?? '')

  // Prefer the dedicated field for each language, then the other one if it happens
  // to be written in that language.
  const englishSource = [description, metaDescription].find(looksEnglish) ?? null
  const chineseSource = [metaDescription, description].find(t => t.trim() !== '' && hasCjk(t)) ?? null

  const facts = englishSurfaceFacts(surface)

  let en
  if (englishSource) {
    en = ensurePeriod(englishSource, 'en')
    if (facts) en = `${en} ${ensurePeriod(`It ${facts}`, 'en')}`.replace(/\s{2,}/g, ' ').trim()
  } else {
    // No English source. State only what the package itself proves: its own name
    // and the surfaces its code registers.
    const human = humanName(pkg.name)
    const parts = [`${human} for DeepSeek Harness.`]
    if (facts) parts.push(`It ${ensurePeriod(facts, 'en')}`)
    en = parts.join(' ').replace(/\s{2,}/g, ' ').trim()
  }

  const zh = chineseSource ? ensurePeriod(chineseSource, 'zh') : ''

  return {
    en,
    zh,
    // True when the English line was derived from code rather than written prose.
    needsTranslation: englishSource === null,
    sources: {
      descriptionField: description !== '',
      metaDescriptionField: metaDescription !== '',
      englishSource: englishSource === description ? 'package.json#description'
        : englishSource === metaDescription ? 'package.json#meta.description'
          : 'code surface (no English prose available)',
      chineseSource: chineseSource === metaDescription ? 'package.json#meta.description'
        : chineseSource === description ? 'package.json#description'
          : null,
      tools: surface.tools,
      commands: surface.commands,
      slots: surface.slots,
      entryFiles: surface.entryFiles,
    },
    // Everything in the draft that a reviewer could try to verify.
    claims: [
      ...(surface.tools.length > 0 ? [`${surface.tools.length} 个 agent 工具`] : []),
      ...(surface.commands.length > 0 ? [`命令 ${surface.commands.join(', ')}`] : []),
      ...(surface.slots.length > 0 ? [`UI 挂载点 ${surface.slots.join(', ')}`] : []),
    ],
  }
}

/** The facts an English sentence may state, derived from registered surfaces. */
function englishSurfaceFacts(surface) {
  const facts = []
  if (surface.tools.length > 0) {
    facts.push(`registers ${surface.tools.length} agent tool${surface.tools.length === 1 ? '' : 's'} (${surface.tools.join(', ')})`)
  }
  if (surface.commands.length > 0) {
    facts.push(`adds the ${surface.commands.map(c => `/${c}`).join(', ')} command${surface.commands.length === 1 ? '' : 's'}`)
  }
  if (surface.slots.length > 0) {
    facts.push(`contributes a ${surface.slots.join(', ')} surface in the Web UI`)
  }
  return facts.join(' and ')
}

/** `@scope/dsh-desktop-organizer` → `Desktop organizer`, used for a fallback line. */
function humanName(packageName) {
  const bare = String(packageName ?? '')
    .replace(/^@[^/]+\//, '')
    .replace(/^dsh[-_]/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  if (bare === '') return 'This plugin'
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}

/**
 * Explain a CI failure in terms the author can act on.
 *
 * `blocking` says what kind of fix it needs:
 *   'wait'        → nothing to do but wait (repo age)
 *   'fix-local'   → change something in the plugin, then push again
 *   'fix-online'  → a one-click fix the wizard can perform
 *   'unknown'     → not recognised; show the log link instead of guessing
 */
export function explainCiFailure(item) {
  const name = String(item?.name ?? '').toLowerCase()
  // The job name carries a lot of the signal ("awesome-lint", "check-repo-age"), so it
  // is concatenated with the log text rather than being a separate condition in every
  // rule — matching on logs alone missed the commonest cases.
  const blob = `${name}\n${item?.summary ?? ''}\n${item?.text ?? ''}\n${item?.title ?? ''}`.toLowerCase()

  const rules = [
    {
      match: () => /repo[-_ ]?age|too new|created.*(ago|at least)|仓库.*(年龄|不满|1 天)/.test(blob),
      check: () => 'repo-age',
      title: '仓库创建不满 1 天',
      hint: 'CI 要求仓库至少满 1 天。等到明天再点一次「创建 PR」推同一个分支即可，不用关掉重开。',
      blocking: 'wait',
    },
    {
      match: () => /dsh\.bundle|not installable|manifest/.test(blob),
      check: () => 'dsh-bundle',
      title: 'package.json 缺少可用的 dsh.bundle',
      hint: '回到 ② 体检点「一键修复」，它会补上 dsh.bundle 和 cordis.patch.yml；修完再推一次。',
      blocking: 'fix-local',
    },
    {
      match: () => /topic/.test(blob),
      check: () => 'topic',
      title: '仓库缺少 dsh-plugin topic',
      hint: '⑤ 里点「帮我加上 dsh-plugin topic」，然后重新检查状态。',
      blocking: 'fix-online',
    },
    {
      match: () => /awesome-?lint|lint|separator|ends? with a period|locale parity|句号/.test(blob),
      check: () => 'lint',
      title: '条目格式不符合 awesome-lint',
      hint: '常见原因是描述没以句号结尾、缺中英双语其一、或分类值不在允许列表里。回 ③ 改完再推。',
      blocking: 'fix-local',
    },
    {
      match: () => /1-?8|screenshot|截图/.test(blob),
      check: () => 'screenshots',
      title: '截图声明有问题',
      hint: '截图 1-8 张，路径必须相对插件目录且文件真实存在。回 ④ 检查。',
      blocking: 'fix-local',
    },
    {
      match: () => /entry[-_ ]?count|at most 3|too many entries/.test(blob),
      check: () => 'entry-count',
      title: '一个 PR 里超过 3 条',
      hint: '拆分成多个 PR，每个最多 3 条；通常一个 PR 只放一条最好。',
      blocking: 'fix-local',
    },
    {
      match: () => /duplicate|already (exists|listed)|已收录/.test(blob),
      check: () => 'duplicate',
      title: '这个插件可能已经被收录',
      hint: '⑤ 会自动识别「更新」模式；如果确认是重复，直接在原 PR 上改。',
      blocking: 'fix-local',
    },
  ]

  for (const rule of rules) {
    if (rule.match()) {
      return { actionable: true, check: rule.check(), title: rule.title, hint: rule.hint, blocking: rule.blocking }
    }
  }

  // Unknown failure: do not pretend to understand it, and do not dump raw logs either.
  return {
    actionable: false,
    check: null,
    title: '这条检查失败了，但插件不认识它的输出',
    hint: '点「在 GitHub 上查看」能看到完整日志。把日志发我，我把这条的识别规则补上。',
    blocking: 'unknown',
  }
}

/**
 * Turn a raw `prStatus` result into what the wizard shows.
 *
 * This is the part that replaces "open the PR page and squint at a red X": every
 * verdict comes with a plain sentence and a next step, and a failure is translated
 * through `explainCiFailure` rather than pasted as a log.
 */
export function describePrStatus(status) {
  if (!status?.ok) {
    return { ok: false, verdict: 'unknown', headline: status?.error ?? '读不到 PR 状态', nextSteps: [] }
  }

  const base = {
    ok: true,
    number: status.number,
    url: status.url,
    title: status.title,
    updatedAt: status.updatedAt,
    comments: status.comments,
  }

  if (status.merged) {
    return {
      ...base,
      verdict: 'merged',
      headline: '已合并 —— 插件已经进入列表',
      detail: status.mergedAt ? `合并时间：${status.mergedAt}` : null,
      nextSteps: [
        '网站会自动重建，通常一天内插件市场就能搜到。',
        '（可选）去 Discussions 的 Show Your Plugins! 发个帖推广。',
      ],
    }
  }

  if (status.state === 'closed') {
    return {
      ...base,
      verdict: 'closed',
      headline: '这个 PR 被关掉了（没有合并）',
      detail: '维护者关闭了它，可能另有安排，或已被其他 PR 覆盖。',
      nextSteps: ['去 PR 页面看维护者的最后一条评论；修复后可以重新提交。'],
    }
  }

  const checks = status.checks ?? { verdict: 'none', items: [] }

  if (checks.verdict === 'none') {
    return {
      ...base,
      verdict: 'waiting-checks',
      headline: 'PR 已提交，但还没有任何检查开始',
      detail: 'CI 通常在一两分钟内启动；也可能这个仓库没有配置自动检查。',
      nextSteps: ['等一两分钟再点「查看 PR 状态」。', '长期没有检查说明要靠维护者人工审核。'],
    }
  }

  if (checks.verdict === 'pending') {
    return {
      ...base,
      verdict: 'running',
      headline: `检查进行中（已完成 ${checks.total - checks.pending} / ${checks.total}）`,
      nextSteps: ['稍等一两分钟再点「查看 PR 状态」。'],
    }
  }

  if (checks.verdict === 'failed') {
    const failed = checks.failedItems ?? []
    const explained = failed.map(item => ({ item, explanation: explainCiFailure(item) }))
    return {
      ...base,
      verdict: 'failed',
      headline: `${failed.length} 项检查没通过`,
      detail: '下面是插件能识别出来的失败原因和对应的下一步。',
      failures: explained.map(e => ({
        name: e.item.name,
        url: e.item.url,
        check: e.explanation.check,
        title: e.explanation.title,
        hint: e.explanation.hint,
        blocking: e.explanation.blocking,
      })),
      nextSteps: [
        ...explained.filter(e => e.explanation.blocking !== 'unknown').map(e => e.explanation.hint),
        '修好后点「创建 PR」推同一个分支，CI 会重跑——不用关掉重开。',
      ],
    }
  }

  return {
    ...base,
    verdict: 'passed',
    headline: `${checks.total} 项检查全部通过`,
    detail: '接下来是维护者人工审核：他会读你的仓库，确认代码做的是条目里说的事。',
    nextSteps: [
      '等待维护者合并，这一步没有固定时间，社区仓库通常几天内响应。',
      '（可选）在 PR 里留一句话说明用途，或去 Discussions 的 Show Your Plugins! 发帖。',
    ],
  }
}

/**
 * Resolve the submission target: which repo, which subpath, which entry filename.
 *
 * `repoUrl` may be a GitHub URL (with an optional `/tree/<branch>/<subpath>`) or an
 * `owner/repo` slug. `pluginSubpath` wins when both are given.
 */
export function resolveTarget({ repoUrl, pluginSubpath, packageName }) {
  let owner = null
  let repo = null
  let subpath = pluginSubpath ?? null

  if (repoUrl && /^[\w.-]+\/[\w.-]+$/.test(repoUrl.trim())) {
    const [o, r] = repoUrl.trim().split('/')
    owner = o
    repo = r
  } else if (repoUrl) {
    const parsed = parseGithubUrl(repoUrl)
    if (!parsed) return { ok: false, error: `无法解析 GitHub 仓库地址：${repoUrl}` }
    owner = parsed.owner
    repo = parsed.repo
    if (!subpath && parsed.subpath) subpath = parsed.subpath
  }
  if (!owner || !repo) return { ok: false, error: '缺少目标仓库（需要 owner/repo 或 GitHub URL）' }

  const slug = `${owner}/${repo}`
  subpath = subpath ? subpath.replace(/^\/+|\/+$/g, '') : null
  return {
    ok: true,
    owner,
    repo,
    slug,
    subpath,
    url: subpath ? `https://github.com/${slug}/tree/main/${subpath}` : `https://github.com/${slug}`,
    entryName: subpath ? `${slug}#${subpath.split('/').pop()}` : slug,
    entryFile: entryFileName(slug, subpath),
  }
}

/**
 * Render the entry YAML exactly as `data/plugins/<owner>__<repo>.yml` expects.
 *
 * Key order follows the guide's example so a maintainer reading the diff sees the
 * familiar shape. Optional fields are omitted rather than emitted empty — a
 * hand-written `npm:` key is rejected by validation, so we never write one.
 */
export function renderEntryYaml(entry) {
  const lines = []
  lines.push(`url: ${yamlScalar(entry.url)}`)
  lines.push(`name: ${yamlScalar(entry.name)}`)
  lines.push(`category: ${yamlScalar(entry.category)}`)
  lines.push('description:')
  lines.push(`  en: ${yamlScalar(entry.descriptionEn)}`)
  if (entry.descriptionZh) lines.push(`  zh: ${yamlScalar(entry.descriptionZh)}`)
  if (entry.tarball) lines.push(`tarball: ${yamlScalar(entry.tarball)}`)
  return lines.join('\n') + '\n'
}

/** Render `screenshots.json` for the plugin's own repo. */
export function renderScreenshotsJson(paths) {
  return JSON.stringify(paths, null, 2) + '\n'
}

/**
 * Apply one `{ kind: 'draft' }` finding action to the draft.
 *
 * This is what makes "→ 按功能自动推荐" and "→ 生成中文草稿" do something. The rules
 * declare the action, the wizard renders a button, and this is the one place that
 * knows how to compute the new value — so the button and the rule cannot drift.
 *
 * Returns `{ ok, patch, note }` where `patch` is a partial draft, or
 * `{ ok: false, reason }` when the action is not a draft action or the field is
 * unknown.
 */
export function applyDraftFix(pkg, draft = {}, action, options = {}) {
  if (!action || action.kind !== 'draft') {
    return { ok: false, reason: '这不是一个草稿修复动作' }
  }
  const surface = options.surface ?? readSurface(pkg)
  const current = {
    category: draft.category ?? '',
    descriptionEn: draft.descriptionEn ?? '',
    descriptionZh: draft.descriptionZh ?? '',
    repoUrl: draft.repoUrl ?? '',
  }

  if (action.field === 'category') {
    const suggestion = inferCategory(pkg, `${current.descriptionEn} ${current.descriptionZh} ${draft.repoUrl ?? ''}`)
    return {
      ok: true,
      patch: { category: suggestion.category },
      note: `推荐 ${suggestion.category}：${suggestion.reason}`,
    }
  }

  if (action.field === 'descriptionEn') {
    if (action.compute === 'clean') {
      const source = current.descriptionEn.trim() === ''
        ? draftDescriptions(pkg, { surface }).en
        : current.descriptionEn
      return { ok: true, patch: { descriptionEn: ensurePeriod(cleanDescription(source), 'en') } }
    }
    if (action.compute === 'period') {
      return { ok: true, patch: { descriptionEn: ensurePeriod(current.descriptionEn, 'en') } }
    }
    const drafted = draftDescriptions(pkg, { surface })
    return {
      ok: true,
      patch: { descriptionEn: drafted.en },
      note: drafted.needsTranslation
        ? '你没有英文描述，这一句是根据代码声明推导的：请核对后再改得更像人话。'
        : null,
    }
  }

  if (action.field === 'descriptionZh') {
    if (action.compute === 'clean') {
      return { ok: true, patch: { descriptionZh: ensurePeriod(cleanDescription(current.descriptionZh), 'zh') } }
    }
    const drafted = draftDescriptions(pkg, { surface })
    if (!drafted.zh) {
      return { ok: false, reason: '这个插件没有可用的中文来源；中文描述是可选的，可以留空让维护者补。' }
    }
    return { ok: true, patch: { descriptionZh: drafted.zh } }
  }

  return { ok: false, reason: `未知的草稿字段：${action.field}` }
}

/**
 * Validate a draft before it can become a PR. Returns the blocking problems and
 * the warnings, using the same rulebook the wizard shows.
 */
export function validateDraft(draft) {
  const problems = []
  const warnings = []

  if (!draft.url || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/tree\/[^/]+\/.+)?$/.test(draft.url)) {
    problems.push({ field: 'url', message: 'url 必须是 https://github.com/owner/repo 形式，且与仓库完全一致' })
  }
  if (!draft.name) problems.push({ field: 'name', message: '缺少 name' })
  if (!CATEGORIES.includes(draft.category)) {
    problems.push({ field: 'category', message: `category 必须是 ${CATEGORIES.join(' / ')} 之一` })
  }
  if (!String(draft.descriptionEn ?? '').trim()) {
    problems.push({ field: 'descriptionEn', message: 'description.en 是唯一必填字段' })
  } else {
    if (!/[.!?]$/.test(String(draft.descriptionEn).trim())) {
      warnings.push({ field: 'descriptionEn', message: '英文描述没有以句号结尾' })
    }
    const marketing = findMarketingWords(draft.descriptionEn)
    if (marketing.length > 0) {
      problems.push({ field: 'descriptionEn', message: `含营销词：${marketing.join('、')}` })
    }
    if (needsYamlQuote(draft.descriptionEn)) {
      warnings.push({ field: 'descriptionEn', message: '含 ": "，YAML 渲染时已自动加引号' })
    }
  }
  if (draft.screenshots && draft.screenshots.length > 8) {
    problems.push({ field: 'screenshots', message: '截图最多 8 张' })
  }
  if (draft.tarball) {
    const verdict = checkTarballUrl(draft.tarball)
    if (!verdict.ok) problems.push({ field: 'tarball', message: verdict.reason })
    else if (verdict.warning) warnings.push({ field: 'tarball', message: verdict.warning })
  }
  return { ok: problems.length === 0, problems, warnings }
}

/**
 * The complete submission bundle: everything the wizard shows on the review step,
 * and everything the PR step will commit.
 */
export function buildSubmission(pkg, draft) {
  const target = resolveTarget({
    repoUrl: draft.repoUrl ?? pkg.repository,
    pluginSubpath: draft.pluginSubpath,
    packageName: pkg.name,
  })
  if (!target.ok) return { ok: false, error: target.error }

  const surface = readSurface(pkg)
  const suggested = draft.descriptions ?? draftDescriptions(pkg, { surface })

  const entry = {
    url: target.url,
    name: target.entryName,
    category: draft.category ?? inferCategory(pkg, suggested.en).category,
    descriptionEn: ensurePeriod(cleanDescription(draft.descriptionEn ?? suggested.en), 'en'),
    descriptionZh: draft.descriptionZh === '' ? '' : ensurePeriod(cleanDescription(draft.descriptionZh ?? suggested.zh), 'zh'),
    tarball: draft.tarball ?? undefined,
  }

  const screenshots = Array.isArray(draft.screenshots) ? draft.screenshots : (pkg.screenshots?.paths ?? [])
  const screenshotVerdicts = screenshots.map(p => ({ path: p, ...checkScreenshotPath(p, pkg.dir) }))

  const yaml = renderEntryYaml(entry)
  const validation = validateDraft({ ...entry, screenshots, tarball: entry.tarball })

  return {
    ok: validation.ok,
    target,
    entry,
    entryFile: target.entryFile,
    yaml,
    screenshots,
    screenshotVerdicts,
    screenshotsJson: screenshots.length > 0 ? renderScreenshotsJson(screenshots) : null,
    validation,
    surface,
    categoryReason: draft.category ? '用户手动选择' : inferCategory(pkg, suggested.en).reason,
    categoryLabel: CATEGORY_LABELS[entry.category] ?? entry.category,
    prDraft: buildPrDraft(entry, target, pkg, surface),
  }
}

/**
 * A PR body that a maintainer can review without opening the repo first.
 *
 * `options.mode` distinguishes a first submission from an update. The difference
 * matters to a reviewer: an update should touch only its own entry and say what
 * changed, where an add introduces a new line.
 */
export function buildPrDraft(entry, target, pkg, surface, options = {}) {
  const isUpdate = options.mode === 'update'
  const lines = []
  lines.push(isUpdate ? '## Updating one entry' : '## Adding one entry')
  lines.push('')
  lines.push(isUpdate
    ? `Updates \`data/plugins/${target.entryFile}\` for [${target.slug}](${target.url}). This entry is already on the list; the file is modified in place, no second file is added.`
    : `Adds \`data/plugins/${target.entryFile}\` for [${target.slug}](${target.url}).`)
  lines.push('')

  if (isUpdate && Array.isArray(options.diff?.changed) && options.diff.changed.length > 0) {
    lines.push('### What changed')
    lines.push('')
    for (const change of options.diff.changed.slice(0, 12)) {
      if (change.from === null) lines.push(`- added line ${change.line}: \`${String(change.to).slice(0, 120)}\``)
      else if (change.to === null) lines.push(`- removed line ${change.line}: \`${String(change.from).slice(0, 120)}\``)
      else lines.push(`- line ${change.line}: \`${String(change.from).slice(0, 80)}\` → \`${String(change.to).slice(0, 80)}\``)
    }
    if (options.diff.changed.length > 12) {
      lines.push(`- …and ${options.diff.changed.length - 12} more changed lines`)
    }
    lines.push('')
  }

  lines.push('### What it does')
  lines.push('')
  lines.push(entry.descriptionEn)
  lines.push('')
  if (surface.tools.length > 0) {
    lines.push(`- agent tools: ${surface.tools.map(t => `\`${t}\``).join(', ')}`)
  }
  if (surface.commands.length > 0) {
    lines.push(`- commands: ${surface.commands.map(c => `\`/${c}\``).join(', ')}`)
  }
  if (surface.slots.length > 0) {
    lines.push(`- UI surface: ${surface.slots.map(s => `\`${s}\``).join(', ')}`)
  }
  lines.push('')
  lines.push('### Checklist')
  lines.push('')
  lines.push('- [x] `package.json` declares `dsh.bundle`')
  lines.push('- [x] repo carries the `dsh-plugin` topic')
  lines.push('- [x] repo is at least 1 day old')
  lines.push(isUpdate
    ? '- [x] this PR changes only my own entry'
    : '- [x] this PR adds exactly one entry and touches no other entry')
  lines.push('')
  lines.push(`_Generated with [dsh-onshelf](https://github.com/${target.slug}) — the description above was drafted from the package's own \`package.json\` and the tools its code registers._`)
  return lines.join('\n')
}
