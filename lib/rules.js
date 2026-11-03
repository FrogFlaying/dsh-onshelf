/**
 * Step ② — the rulebook, transcribed from `awesome-dsh-plugin/contributing.md`.
 *
 * Every check below cites the paragraph it came from, because the whole point of
 * this plugin is that these rules live in prose and nobody reads them. When the
 * upstream guide changes, this file changes; nothing else in the codebase is
 * allowed to hold a second copy of a rule.
 *
 * A finding is:
 *   { id, level, title, detail, fix?, fixable }
 * level: 'error' (CI will reject) | 'warn' (a maintainer will send it back) |
 *        'info' (worth knowing, never blocking)
 *
 * @module lib/rules.js
 */

import fs from 'node:fs'
import path from 'node:path'

/** The 23 valid categories, in the order the guide lists them. */
export const CATEGORIES = [
  'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory',
  'tools', 'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow',
  'git', 'notify', 'dev', 'security', 'remote', 'market', 'fun',
]

/** English labels, used only for display in the wizard. */
export const CATEGORY_LABELS = {
  agi: 'AGI / agents', ui: 'UI enhancements', usage: 'Usage & cost',
  theme: 'Themes & appearance', model: 'Models & providers', identity: 'Identity & persona',
  session: 'Sessions', memory: 'Memory', tools: 'Tools', wsl: 'WSL',
  browser: 'Browser', vision: 'Vision', voice: 'Voice', docs: 'Docs',
  skill: 'Skills', workflow: 'Workflow', git: 'Git', notify: 'Notifications',
  dev: 'Developer tools', security: 'Security', remote: 'Remote', market: 'Plugin market',
  fun: 'Just for fun',
}

/**
 * Marketing words the guide bans ("no superlatives or marketing"). Matching is
 * deliberately conservative: a plugin legitimately named "best-effort" should not
 * be flagged, so we look for the words in a marketing position, not as substrings
 * of compound identifiers.
 */
export const MARKETING_WORDS = [
  'powerful', 'revolutionary', 'best-in-class', 'world-class', 'cutting-edge',
  'game-changing', 'seamless', 'effortless', 'ultimate', 'unparalleled',
  'blazing', 'amazing', 'incredible', 'perfect', 'the best', 'number one',
  '强大', '革命性', '最佳', '最好', '完美', '极致', '颠覆', '神器', '一键封神',
  '行业领先', '遥遥领先', '天花板', '无敌',
]

/** Words that make an entry read as an ad rather than a description. */
const CLAIM_PATTERNS = [
  { re: /\b\d+\s*(?:x|times)\s+(?:faster|better|smaller)\b/i, why: '性能倍数承诺（"3x faster"）无法被评审核实' },
  { re: /\bguarantee[ds]?\b/i, why: '"guaranteed" 属于承诺性表述' },
  { re: /\b(?:no\.?\s*1|#1)\b/i, why: '排名宣称' },
]

/** Screenshot hosts that the guide rejects. */
const ALLOWED_SHOT_HOSTS = [
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
  'github.com',
  'objects.githubusercontent.com',
]

/* ──────────────────────────── text helpers ──────────────────────────── */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

/** Does this text contain CJK characters? */
export function hasCjk(text) {
  return CJK.test(String(text ?? ''))
}

/**
 * Is this text plausibly English prose? Latin letters and no CJK.
 *
 * Used to decide whether a `package.json` description may be reused as the entry's
 * English line. A Chinese description pasted into `description.en` is both wrong —
 * the list is English-first — and unreadable to the maintainers who review it.
 */
export function looksEnglish(text) {
  const value = String(text ?? '').trim()
  if (value === '') return false
  if (hasCjk(value)) return false
  return /[A-Za-z]/.test(value)
}

/** `: ` inside an unquoted YAML scalar starts a nested mapping. */
export function needsYamlQuote(text) {
  if (typeof text !== 'string') return false
  return text.includes(': ') || text.endsWith(':')
}

/**
 * Quote a YAML scalar the way the guide requires, using single quotes (so the
 * output stays readable) and doubling any embedded single quote.
 */
export function yamlScalar(text) {
  const value = String(text ?? '')
  if (!needsYamlQuote(value) && !/^[\s>|&*!%@`{[\]},#?'"-]/.test(value)) return value
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Check the semver peer range for the prerelease trap documented in the guide:
 * node-semver only admits a prerelease version when *some* comparator in the range
 * shares its exact `major.minor.patch` tuple AND itself carries a prerelease tag.
 *
 * So the failure mode is a **gap**: a range that spans several minor versions but
 * carries prerelease comparators on only some of them silently excludes the rest.
 * `>=0.0.1-rc.1 <0.2.0` looks broad, yet only `0.0.1-*` prereleases can match —
 * `0.1.0-rc.6` is excluded because nothing sits on the `0.1.0` tuple.
 *
 * We detect the gap rather than trying to re-implement node-semver.
 */
export function analyzePeerRange(range) {
  const value = String(range ?? '').trim()
  if (value === '') return { ok: false, reason: '空范围' }

  const versions = parseComparators(value)
  if (versions.length === 0) return { ok: false, reason: '无法解析任何版本号' }

  const prerelease = versions.filter(v => v.pre !== null)
  if (prerelease.length === 0) {
    return {
      ok: true,
      warning: '范围里没有任何预发布标签；如果 harness 以预发布版本发布，这个范围会静默排除它',
    }
  }

  // Which `major.minor` lanes carry a prerelease comparator?
  const coveredLanes = new Set(prerelease.map(v => `${v.major}.${v.minor}`))

  // The lanes the range actually admits: from the lowest bound to the highest.
  const sorted = [...versions].sort((a, b) => (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch))
  const lowest = sorted[0]
  const highest = sorted[sorted.length - 1]
  if (lowest.major !== highest.major) {
    return {
      ok: true,
      warning: `范围跨越了多个主版本（${lowest.major} → ${highest.major}）；预发布只在 ${[...coveredLanes].join('、')} 这几条线上被放行`,
    }
  }

  const gaps = []
  for (let minor = lowest.minor; minor <= highest.minor; minor++) {
    const lane = `${lowest.major}.${minor}`
    if (!coveredLanes.has(lane)) gaps.push(lane)
  }

  if (gaps.length === 0) return { ok: true }

  return {
    ok: false,
    reason: `范围覆盖到 ${lowest.major}.${lowest.minor}–${highest.major}.${highest.minor}，但只有 ${[...coveredLanes].join('、')} 这几条线上有带预发布标签的比较符；${gaps.join('、')} 的预发布版本会被静默排除`,
    suggested: '>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0',
    gaps,
  }
}

/** Pull every version token out of a range, recording whether it is a prerelease. */
function parseComparators(range) {
  const out = []
  const re = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/g
  let m
  while ((m = re.exec(range)) !== null) {
    out.push({
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3]),
      pre: m[4] ?? null,
      text: m[0],
    })
  }
  return out
}


/** Find marketing words in a description, case-insensitively, word-bounded. */
export function findMarketingWords(text) {
  const value = String(text ?? '')
  const hits = []
  for (const word of MARKETING_WORDS) {
    const isCjk = /[\u4e00-\u9fff]/.test(word)
    const re = isCjk
      ? new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      : new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (re.test(value)) hits.push(word)
  }
  return hits
}

/** Collect the claims in a description that a maintainer will try to verify. */
export function findVerifiableClaims(text) {
  const value = String(text ?? '')
  const claims = []
  // "46 tools", "六大领域", "8 categories", "3 tools"
  const numberRe = /(\d+)\s*(tools?|commands?|categories?|domains?|providers?|skills?|个工具|个命令|大领域|个分类|个技能)/gi
  let m
  while ((m = numberRe.exec(value)) !== null) {
    claims.push({ text: m[0], number: Number(m[1]), unit: m[2] })
  }
  const cnNumberRe = /([一二三四五六七八九十两]+)\s*(大领域|个工具|个分类|个技能)/g
  while ((m = cnNumberRe.exec(value)) !== null) {
    claims.push({ text: m[0], number: null, unit: m[2] })
  }
  // Backticked identifiers and tool-looking names are also checked by reviewers.
  const idRe = /`([^`]+)`/g
  while ((m = idRe.exec(value)) !== null) {
    claims.push({ text: m[1], identifier: true })
  }
  return claims
}

/* ──────────────────────────── the checks ──────────────────────────── */

/**
 * Build a finding.
 *
 * `action` says what a caller can actually do about it, and is the contract the UI
 * and the agent tool rely on:
 *   { kind: 'file',  fix: '<planFixes code>' }        → write files
 *   { kind: 'draft', field, compute }                 → fill a draft field
 *   { kind: 'manual', hint }                          → nothing automatic is honest
 *
 * `fixable` is derived rather than declared, so a finding cannot advertise an
 * action that no code implements — the bug that made the wizard show "→ 按功能自动
 * 推荐" as dead text.
 */
function finding(id, level, title, detail, extra = {}) {
  const action = extra.action ?? null
  const { action: _drop, ...rest } = extra
  return {
    id,
    level,
    title,
    detail,
    action,
    fixable: Boolean(action && action.kind !== 'manual'),
    fix: action?.kind === 'file' ? action.fix : undefined,
    fixLabel: extra.fixLabel ?? null,
    ...rest,
  }
}

/** Shorthand for the three action shapes. */
const fileFix = (fix, fixLabel) => ({ action: { kind: 'file', fix }, fixLabel })
const draftFix = (field, compute, fixLabel) => ({ action: { kind: 'draft', field, compute }, fixLabel })
const manual = hint => ({ action: { kind: 'manual', hint } })

/**
 * `owner/repo`, `https://github.com/owner/repo`, or `github:owner/repo` → `owner/repo`.
 * Returns `null` when the value does not name a GitHub repository.
 */
export function normalizeRepoSlug(value) {
  const text = String(value ?? '').trim()
  if (text === '') return null
  const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(text)
  if (shorthand) return `${shorthand[1]}/${shorthand[2]}`
  const url = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(text)
  if (url) return `${url[1]}/${url[2]}`
  return null
}

/**
 * Check one scanned package against the submission rules.
 *
 * `entry` is the draft entry the user is editing (category, descriptions,
 * screenshots, tarball); when absent we fall back to the package's own metadata
 * so the check is still meaningful right after a scan.
 */
export function checkPackage(pkg, entry = {}, context = {}) {
  const findings = []
  const dir = pkg.dir
  const push = f => findings.push(f)

  /* ---- 1. installability: dsh.bundle (the #1 rejection reason) ---- */
  if (!pkg.hasBundle) {
    push(finding(
      'bundle-missing', 'error',
      'package.json 没有声明 dsh.bundle',
      'contributing.md：只声明 dsh.client 无法安装，这是最常见的被拒原因，CI 第 2 步就会失败。',
      fileFix('add-bundle', '补上 dsh.bundle 并生成 cordis.patch.yml'),
    ))
  } else if (!pkg.bundlePatch) {
    push(finding(
      'bundle-no-patch', 'error',
      'dsh.bundle 没有指向 patch 文件',
      'dsh.bundle 需要形如 { "patch": "./cordis.patch.yml" }，否则没有可挂载的层。',
      fileFix('add-bundle', '修正 dsh.bundle 并生成 cordis.patch.yml'),
    ))
  } else if (!pkg.bundlePatchExists) {
    push(finding(
      'bundle-patch-missing', 'error',
      `patch 文件不存在：${pkg.bundlePatch}`,
      'dsh.bundle.patch 指向的文件在仓库里找不到，安装时无法组装 profile。',
      fileFix('create-patch', '创建 cordis.patch.yml'),
    ))
  }

  /* ---- 2. cordis.patch.yml shape ---- */
  if (pkg.bundlePatch && pkg.bundlePatchExists) {
    const patchFile = path.join(dir, pkg.bundlePatch)
    let patchText = ''
    try { patchText = fs.readFileSync(patchFile, 'utf8') } catch { /* handled above */ }
    if (patchText.trim() === '') {
      push(finding('patch-empty', 'error', 'cordis.patch.yml 是空的',
        '顶层需要是一个 YAML 数组，至少含一条 insert。',
        fileFix('create-patch', '写入最小 patch')))
    } else {
      const firstMeaningful = patchText.split(/\r?\n/).find(l => l.trim() !== '' && !l.trim().startsWith('#'))
      if (firstMeaningful && !firstMeaningful.trim().startsWith('-')) {
        push(finding('patch-not-array', 'error', 'cordis.patch.yml 顶层不是数组',
          `首个有效行是 "${firstMeaningful.trim().slice(0, 40)}"，但 loader 期望顶层 YAML 数组（以 "-" 开头）。`,
          fileFix('create-patch', '改写为顶层数组')))
      } else if (!/\binsert\b/.test(patchText)) {
        push(finding('patch-no-insert', 'warn', 'cordis.patch.yml 里没有 insert 条目',
          '没有 insert 就不会挂载任何插件行；如果这是有意的覆盖层可以忽略。',
          fileFix('create-patch', '追加 insert 条目')))
      }
    }
  }

  /* ---- 3. official packages must be peers, with a prerelease branch ---- */
  const officialInDeps = Object.keys(pkg.dependencies ?? {}).filter(n => n.startsWith('@deepseek-ai/'))
  if (officialInDeps.length > 0) {
    push(finding('official-in-dependencies', 'error',
      `官方包被写进了 dependencies：${officialInDeps.join(', ')}`,
      'contributing.md 要求 @deepseek-ai/* 放在 peerDependencies，否则用户会装到第二份 harness 运行时。',
      fileFix('move-official-to-peer', '迁移到 peerDependencies')))
  }
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/')) continue
    const verdict = analyzePeerRange(range)
    if (verdict.ok === false) {
      push(finding('peer-prerelease-range', 'error',
        `${name} 的 peer 范围排除预发布版本`,
        `${verdict.reason}。这是静默失败：用户会撞上 ERESOLVE 并手工绕过。`,
        { ...fileFix('fix-peer-range', `改为 ${verdict.suggested ?? '显式预发布分支'}`), suggested: verdict.suggested }))
    } else if (verdict.warning) {
      push(finding('peer-range-loose', 'warn', `${name} 的 peer 范围没有预发布标签`, verdict.warning,
        fileFix('fix-peer-range', '补上显式预发布分支')))
    }
  }

  /* ---- 4. repository field must point back at the listed repo ---- */
  const target = context.targetRepo ?? pkg.repository
  const repoSlug = normalizeRepoSlug(context.targetRepo)
  if (!pkg.repository) {
    if (repoSlug) {
      // The author has told us which repo this is, so writing the field is
      // mechanical — do it instead of nagging them about it.
      push(finding('repository-missing', 'warn', 'package.json 没有可解析的 repository 字段',
        '没有它，npm 包不会与本列表条目关联；发 npm 时这是硬性要求。已按你填的仓库地址补上。',
        fileFix('add-repository', `写入 repository: ${repoSlug}`)))
    } else {
      push(finding('repository-missing', 'warn', 'package.json 没有可解析的 repository 字段',
        '没有它，npm 包不会与本列表条目关联；发 npm 时这是硬性要求。',
        manual('先在 ③ 投稿材料里填「GitHub 仓库」（owner/repo）；填完这里就能一键写入 package.json。')))
    }
  } else if (target && pkg.repository.toLowerCase() !== normalizeRepoSlug(target).toLowerCase()) {
    push(finding('repository-mismatch', 'warn', 'repository 指向的不是要收录的仓库',
      `package.json 写的是 ${pkg.repository}，条目要收录 ${target}；两者不一致时 npm 包不会关联。`,
      manual('确认你要收录哪个仓库，然后把 package.json 的 repository 改成它。')))
  }

  /* ---- 5. repo age + topic (needs GitHub; reported by the github module) ---- */
  if (context.repoAgeDays !== undefined && context.repoAgeDays !== null) {
    if (context.repoAgeDays < 1) {
      push(finding('repo-too-new', 'error', '仓库创建不满 1 天',
        `实测年龄 ${formatAge(context.repoAgeDays)}。CI 会自动拒绝，等满 1 天后再提交即可，重新提交不受影响。`,
        manual('等仓库满 1 天再提交；重新提交不受影响。')))
    }
  }
  if (Array.isArray(context.topics)) {
    if (!context.topics.includes('dsh-plugin')) {
      push(finding('topic-missing', 'error', '仓库缺少 dsh-plugin topic',
        'contributing.md 明确要求给仓库加 dsh-plugin topic，CI 会检查。',
        manual('在 GitHub 仓库主页右侧 About → Topics 加上 dsh-plugin。')))
    }
  }

  /* ---- 6. real code, not a placeholder ---- */
  const codeFiles = countCodeFiles(dir)
  if (codeFiles === 0) {
    push(finding('no-code', 'error', '目录里没有可执行代码',
      '纯 README / 占位仓库不收。至少需要一个 .js/.mjs/.ts 入口文件。'))
  }
  if (!pkg.hasReadme) {
    push(finding('no-readme', 'info', '没有 README',
      '不阻塞收录，但市场详情页会空；评审也会读 README 来判断是否名副其实。'))
  }

  /* ---- 7. the entry itself ---- */
  const category = entry.category ?? context.category
  if (!category) {
    push(finding('category-missing', 'error', '还没有选择分类',
      `必须是这 23 个之一：${CATEGORIES.join(' ')}`, draftFix('category', 'suggest', '按功能自动推荐')))
  } else if (!CATEGORIES.includes(category)) {
    push(finding('category-invalid', 'error', `分类 "${category}" 不在允许列表里`,
      `允许值：${CATEGORIES.join(' ')}`, draftFix('category', 'suggest', '改为推荐分类')))
  } else if (category === 'theme' && pkg.hasClient) {
    push(finding('theme-check', 'info', '确认这是主题/皮肤类插件',
      '主题与皮肤会自动进 dsh-market 的「主题」Tab 并支持一键切换；如果只是改了 UI 增强，应该放 ui。'))
  }

  const en = entry.descriptionEn ?? context.descriptionEn ?? pkg.description ?? ''
  const zh = entry.descriptionZh ?? context.descriptionZh ?? ''
  if (!String(en).trim()) {
    push(finding('description-en-missing', 'error', '缺少英文描述',
      'description.en 是唯一必填字段；缺了 CI 直接拒绝。',
      draftFix('descriptionEn', 'draft', '根据代码与 package.json 生成草稿')))
  } else if (!looksEnglish(en)) {
    // The entry line is what a maintainer reads before opening the repo. A Chinese
    // sentence sitting in `description.en` is exactly what gets a PR sent back, and
    // it happens by accident whenever package.json's description is Chinese and is
    // reused as the English line.
    push(finding('description-en-not-english', 'error', '英文描述不是英文',
      `内容是：${String(en).slice(0, 60)}。description.en 应当是一句英文；中文请放在 description.zh。`,
      draftFix('descriptionEn', 'draft', '改成一句英文事实陈述')))
  } else {
    const marketing = findMarketingWords(en)
    if (marketing.length > 0) {
      push(finding('description-marketing', 'error', '英文描述含营销词',
        `命中：${marketing.join('、')}。contributing.md：描述只说功能，不带营销词。`,
        draftFix('descriptionEn', 'clean', '去掉营销词')))
    }
    for (const { re, why } of CLAIM_PATTERNS) {
      if (re.test(String(en))) {
        push(finding('description-claim', 'warn', '描述里有无法核实的承诺', why,
          manual('承诺性表述只能由你改写为事实陈述，自动改写会变成另一句不实的话。')))
      }
    }
    if (!/[.!?。！？]$/.test(String(en).trim())) {
      push(finding('description-en-period', 'warn', '英文描述没有以句号结尾',
        '列表里每条都以句号结尾，站点构建会检查分隔符与格式。',
        draftFix('descriptionEn', 'period', '补上句号')))
    }
    if (needsYamlQuote(String(en))) {
      push(finding('description-yaml-quote', 'warn', '描述含 ": "，生成的 YAML 会自动加引号',
        '这是 contributing.md 点名的解析陷阱；生成器已经处理，无需手工改。'))
    }
    const claims = findVerifiableClaims(String(en))
    if (claims.length > 0) {
      push(finding('description-verifiable', 'warn', '描述里有会被逐条核对的数字或标识符',
        `命中：${claims.map(c => c.text).join('、')}。评审会对着代码数一遍，对不上就退回。`))
    }
  }
  if (!String(zh).trim()) {
    push(finding('description-zh-missing', 'info', '没有中文描述',
      '中文是可选的，维护者会补；但中文描述几乎决定中文用户的点击率。',
      draftFix('descriptionZh', 'draft', '生成中文草稿')))
  } else {
    const marketingZh = findMarketingWords(zh)
    if (marketingZh.length > 0) {
      push(finding('description-zh-marketing', 'warn', '中文描述含营销词',
        `命中：${marketingZh.join('、')}`, draftFix('descriptionZh', 'clean', '去掉营销词')))
    }
  }

  /* ---- 8. screenshots ---- */
  // An empty list in the *draft* means "the author has not added any yet", which is
  // the same state as having no file at all — NOT the same as a `screenshots.json`
  // that exists and declares nothing. Conflating the two produced a warning on
  // plugins that never had the file.
  const declared = entry.screenshots ?? pkg.screenshots?.paths ?? null
  const hasShots = Array.isArray(declared) && declared.length > 0
  const emptyDeclaredFile = pkg.hasScreenshots && (pkg.screenshots?.paths?.length ?? 0) === 0

  if (!hasShots && emptyDeclaredFile) {
    push(finding('screenshots-empty', 'warn', 'screenshots.json 是空的',
      '文件存在但一张图都没列。要么删掉这个文件，要么列 1-8 张图。',
      manual('删掉 screenshots.json，或者往里面填 1-8 张图的路径（例如 ["assets/shot-1.png"]）。')))
  } else if (!hasShots) {
    push(finding('screenshots-missing', 'info', '没有声明截图',
      '不阻塞收录（市场会从 README 抽图），但作者自荐截图是转化率最高的单项投入。',
      manual('可选：在插件目录放 assets/*.png，再在下面「截图路径」里每行写一个相对路径。')))
  } else if (declared.length > 8) {
    push(finding('screenshots-too-many', 'error', `声明了 ${declared.length} 张截图`,
      '上限是 8 张，超出会被站点构建拒绝。',
      manual('删到 8 张以内，优先留主界面、核心交互、设置项、前后对比。')))
  } else {
    for (const shot of declared) {
      const verdict = checkScreenshotPath(shot, dir)
      if (!verdict.ok) {
        push(finding('screenshot-path', 'error', `截图路径不合法：${shot}`, verdict.reason,
          manual('路径要相对插件目录、不能以 / 开头、不能含 ..，且文件必须真实存在。')))
      } else if (verdict.warning) {
        push(finding('screenshot-path-warn', 'info', `截图：${shot}`, verdict.warning))
      }
    }
  }

  /* ---- 9. tarball, if declared ---- */
  const tarball = entry.tarball ?? context.tarball
  if (tarball) {
    const verdict = checkTarballUrl(tarball)
    if (!verdict.ok) push(finding('tarball-bad', 'error', 'tarball 链接不合规', verdict.reason))
    else if (verdict.warning) push(finding('tarball-rot', 'warn', 'tarball 链接会静默失效', verdict.warning))
  }

  return findings
}

/** Validate one screenshot path against the guide's rules. */
export function checkScreenshotPath(shot, pluginDir) {
  const value = String(shot ?? '').trim()
  if (value === '') return { ok: false, reason: '空路径' }
  if (/^https?:\/\//i.test(value)) {
    let host
    try { host = new URL(value).hostname.toLowerCase() } catch { return { ok: false, reason: '不是合法 URL' } }
    if (!value.toLowerCase().startsWith('https://')) {
      return { ok: false, reason: '绝对 URL 必须是 https' }
    }
    if (!ALLOWED_SHOT_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) {
      return { ok: false, reason: `第三方图床会被拒绝（${host}）；只接受 GitHub 托管的链接` }
    }
    return { ok: true }
  }
  if (value.startsWith('/')) return { ok: false, reason: '相对路径不能以 / 开头（不能跳出插件目录）' }
  if (value.split(/[\\/]/).includes('..')) return { ok: false, reason: '相对路径不能含 ..（不能跳出插件目录）' }
  if (!/\.(png|jpe?g|webp|gif|avif)$/i.test(value)) {
    return { ok: false, reason: '不是图片扩展名（png/jpg/webp/gif/avif）' }
  }
  if (pluginDir) {
    const abs = path.resolve(pluginDir, value)
    if (!fs.existsSync(abs)) {
      return { ok: false, reason: `文件不存在：${abs}` }
    }
  }
  return { ok: true }
}

/** Validate a Release tarball URL, including the `latest/download/` rot trap. */
export function checkTarballUrl(url) {
  const value = String(url ?? '').trim()
  if (!/^https:\/\//i.test(value)) return { ok: false, reason: '必须是 https 链接' }
  if (!/\.tgz(\?.*)?$/i.test(value)) return { ok: false, reason: '必须以 .tgz 结尾' }
  let parsed
  try { parsed = new URL(value) } catch { return { ok: false, reason: '不是合法 URL' } }
  if (!['github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com'].includes(parsed.hostname.toLowerCase())) {
    return { ok: false, reason: '必须是 GitHub Release 托管的链接' }
  }
  const fileName = parsed.pathname.split('/').pop() ?? ''
  const hasVersion = /\d+\.\d+\.\d+/.test(fileName)
  if (/\/releases\/latest\/download\//.test(parsed.pathname) && hasVersion) {
    return {
      ok: true,
      warning: 'latest/download/ 只在请求时解析 latest，文件名照字面取；带版本号的文件名下次发版就会 404。改成不带版本的文件名，或钉死 tag。',
    }
  }
  if (/\/releases\/download\/v[^/]+\//.test(parsed.pathname) && !hasVersion) {
    return { ok: true, warning: '钉死 tag 的写法通常带版本号文件名；确认资产名确实如此。' }
  }
  return { ok: true }
}

function countCodeFiles(dir, depth = 2) {
  let count = 0
  const walk = (d, left) => {
    if (left < 0 || count > 0) return
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build', 'assets', 'docs'].includes(e.name)) continue
        walk(path.join(d, e.name), left - 1)
      } else if (/\.(m?js|cjs|ts|mts|cts|jsx|tsx)$/.test(e.name)) {
        count++
        if (count > 0) return
      }
    }
  }
  walk(dir, depth)
  return count
}

function formatAge(days) {
  if (days < 1 / 24) return `${Math.round(days * 1440)} 分钟`
  if (days < 1) return `${Math.round(days * 24)} 小时`
  return `${Math.floor(days)} 天`
}

/** Summarise findings for the UI and for the agent tool. */
export function summarize(findings) {
  const by = { error: 0, warn: 0, info: 0 }
  for (const f of findings) by[f.level] = (by[f.level] ?? 0) + 1
  return {
    ...by,
    total: findings.length,
    blocked: by.error > 0,
    fixable: findings.filter(f => f.fixable).length,
  }
}
