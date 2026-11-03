/**
 * 上架台 / dsh-onshelf — Host half.
 *
 * Contributes one agent tool (`onshelf`) and a same-origin JSON API the wizard
 * reads. The five steps it implements map 1:1 onto what the plugin promises:
 *
 *   ① scan     — find local packages that declare `dsh.bundle`
 *   ② check    — run the contributing.md rulebook, apply safe fixes
 *   ③ prepare  — draft the entry YAML, bilingual description, screenshots.json
 *   ④ upload   — push screenshots into the author's own repo
 *   ⑤ submit   — fork, branch, commit, open the PR
 *
 * Wiring notes (learned from the plugins already installed here):
 *   - `ctx.inject(['webServer'], ...)` rather than `ctx.get('webServer')` at apply
 *     time: plugins load before the browser half publishes the server.
 *   - Nothing here edits the profile's package.json or cordis.patch.yml; the
 *     Plugin Manager owns those.
 *   - The token lives in memory for the session only, is never logged, and never
 *     reaches disk. Steps ①②③ work with no token at all.
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanForPlugins, scanForPluginsAsync, inspectPackage, defaultScanRoots, entryFileName } from './lib/scan.js'
import { collectFiles, scanForPrivateDetails } from './lib/upload.js'
import { GITIGNORE_SKIP_REASON } from './lib/gitignore.js'
import { checkPackage, summarize, CATEGORIES, CATEGORY_LABELS } from './lib/rules.js'
import { diagnose, planFixes, applyFixes, undoFixes, minimalPatchYaml } from './lib/check.js'
import {
  buildSubmission, draftDescriptions, inferCategory, readSurface,
  resolveTarget, renderEntryYaml, validateDraft, applyDraftFix, buildPrDraft, describePrStatus,
} from './lib/entry.js'
import {
  createClient, whoami, repoFacts, planSubmission, executeSubmission,
  uploadScreenshots, branchNameFor, AWESOME_REPO, entryExists, diffEntry, addRepoTopic,
  prStatus, findExistingSubmission,
  inspectTargetRepo, createRepo, pushFiles,
} from './lib/github.js'

export const name = 'onshelf'

/** Only `tools` is required; the HTTP surface degrades away without a server. */
export const inject = ['tools']

const PKG_DIR = fileURLToPath(new URL('./', import.meta.url))
const API_PREFIX = '/api/onshelf'

/**
 * Where the wizard keeps its draft between page loads. Deliberately *not* the
 * token: that stays in memory only.
 */
function dataDir(ctx) {
  const home = ctx.get('homePaths')?.home
    ?? process.env.DSH_HOME
    ?? path.join(process.env.USERPROFILE ?? '.', '.dsh')
  return path.join(home, 'onshelf')
}

function readDrafts(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'drafts.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeDrafts(dir, drafts) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'drafts.json'), JSON.stringify(drafts, null, 2), 'utf8')
}

/**
 * The user's own settings, kept beside the drafts.
 *
 * Only the scan roots live here for now, and only because the default guess cannot
 * be right for everyone: the first release guessed the DSH profile directory, which
 * filled the list with installed marketplace plugins and none of the author's own.
 * A configurable list is the honest fix — the plugin does not know where you keep
 * your projects.
 */
function readSettings(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeSettings(dir, settings) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
}

export function apply(ctx, config) {
  const log = ctx.logger?.('onshelf') ?? ctx.logger ?? console
  const store = dataDir(ctx)

  /** Session-scoped token. Never persisted, never logged. */
  let token = null
  let identity = null
  /** Cached scan result; rescanned on demand. */
  let scanCache = null

  const client = () => createClient(token)

  /**
   * Where to look for the author's plugins.
   *
   * Precedence: an explicit plugin config (cordis.patch.yml) wins, then the list
   * the user edited in the wizard, then a best-effort default. The workspace is
   * passed only as a hint — `defaultScanRoots` discards it when it resolves into
   * the DSH home, because that is the profile directory and not a project.
   */
  const scanRoots = () => {
    const configured = Array.isArray(config?.scanRoots) ? config.scanRoots.filter(Boolean) : []
    if (configured.length > 0) return configured.map(r => path.resolve(r))

    const saved = readSettings(store).scanRoots
    if (Array.isArray(saved) && saved.length > 0) return saved.map(r => path.resolve(r))

    return defaultScanRoots({
      workspace: ctx.get('workspace')?.root ?? ctx.get('workspaceRoot'),
      dshHome: ctx.get('homePaths')?.home,
      pluginDir: PKG_DIR,
    })
  }

  /** Where the current root list came from — shown so the guess is never silent. */
  const rootsSource = () => {
    if (Array.isArray(config?.scanRoots) && config.scanRoots.length > 0) return 'config'
    const saved = readSettings(store).scanRoots
    if (Array.isArray(saved) && saved.length > 0) return 'custom'
    return 'default'
  }

  /**
   * Merge per-root results, dropping packages reached more than once.
   * Kept separate from the scan itself so the sync and background paths cannot
   * disagree about what a combined result looks like.
   */
  const mergeResults = (roots, results) => {
    const seen = new Set()
    const found = []
    const nearMisses = []
    for (const r of results) {
      for (const p of r.found) {
        const key = p.dir.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        found.push(p)
      }
      for (const p of r.nearMisses) {
        const key = p.dir.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        nearMisses.push(p)
      }
    }
    const stats = results.reduce((acc, r) => ({
      dirsVisited: acc.dirsVisited + (r.stats?.dirsVisited ?? 0),
      packages: acc.packages + (r.stats?.packages ?? 0),
      truncated: acc.truncated || r.stats?.truncated === true,
    }), { dirsVisited: 0, packages: 0, truncated: false })

    return {
      roots,
      scannedAt: new Date().toISOString(),
      found,
      nearMisses,
      errors: results.flatMap(r => r.errors),
      stats,
    }
  }

  /** Synchronous-by-await scan: used by the agent tool and the simple API path. */
  const runScan = async (roots, force = false) => {
    if (!force && scanCache && JSON.stringify(scanCache.roots) === JSON.stringify(roots)) return scanCache
    const results = []
    for (const root of roots) {
      results.push(await scanForPluginsAsync(root, {
        maxDepth: config?.maxDepth,
        maxDirectories: config?.maxDirectories,
        shouldStop: () => scanJob?.cancelled === true,
      }))
    }
    scanCache = mergeResults(roots, results)
    return scanCache
  }

  /* ── background scan with progress ──
   *
   * A large root must not freeze the host: this process also answers the very
   * request that reports progress. The walk yields every 64 directories, and the
   * job object is what `/scan/status` reads while it runs.
   */
  let scanJob = null

  const startScanJob = (roots) => {
    if (scanJob?.running) scanJob.cancelled = true
    const job = {
      id: `scan-${Date.now().toString(36)}`,
      roots,
      startedAt: Date.now(),
      finishedAt: null,
      running: true,
      cancelled: false,
      error: null,
      progress: { dirsVisited: 0, packages: 0, found: 0, nearMisses: 0, errors: 0, cap: 0, current: '', rootIndex: 0, rootCount: roots.length },
      result: null,
      lastRoot: null,
    }
    scanJob = job

    const run = async () => {
      const results = []
      try {
        for (let i = 0; i < roots.length; i++) {
          if (job.cancelled) break
          const root = roots[i]
          job.progress.rootIndex = i
          const result = await scanForPluginsAsync(root, {
            maxDepth: config?.maxDepth,
            maxDirectories: config?.maxDirectories,
            shouldStop: () => job.cancelled,
            onProgress: p => {
              // Carry the completed roots' totals so the bar never jumps backwards.
              const done = job.completed ?? { dirsVisited: 0, packages: 0, found: 0, nearMisses: 0 }
              job.progress = {
                ...p,
                dirsVisited: done.dirsVisited + p.dirsVisited,
                packages: done.packages + p.packages,
                found: done.found + p.found,
                nearMisses: done.nearMisses + p.nearMisses,
                rootIndex: i,
                rootCount: roots.length,
              }
              job.lastRoot = root
            },
          })
          results.push(result)
          job.completed = {
            dirsVisited: (job.completed?.dirsVisited ?? 0) + (result.stats?.dirsVisited ?? 0),
            packages: (job.completed?.packages ?? 0) + (result.stats?.packages ?? 0),
            found: (job.completed?.found ?? 0) + result.found.length,
            nearMisses: (job.completed?.nearMisses ?? 0) + result.nearMisses.length,
          }
        }
        job.result = mergeResults(roots, results)
        scanCache = job.result
      } catch (error) {
        job.error = String(error?.message ?? error)
        log.warn?.(`onshelf: scan failed: ${job.error}`)
      } finally {
        job.running = false
        job.finishedAt = Date.now()
      }
    }

    job.done = run()
    return job
  }

  const publicJob = job => (job ? {
    id: job.id,
    roots: job.roots,
    running: job.running,
    cancelled: job.cancelled,
    startedAt: job.startedAt,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    progress: job.progress,
    error: job.error,
    result: job.result,
  } : null)

  /* ── publishing the code, as a background job ──
   *
   * The upload is one HTTP request per file, so it takes long enough that a plain
   * "wait for the POST" leaves the button looking dead. This job object is what
   * `/publish-status` reads, and it carries the failure text — a failed upload must
   * say so where the author clicked, not in a banner they have scrolled past.
   */
  let publishJob = null

  const publishPhases = {
    checking: '正在检查仓库',
    creating: '正在创建仓库',
    field: '正在写入 repository 字段',
    reading: '正在读取本地文件',
    uploading: '正在上传',
    done: '已完成',
    failed: '失败',
  }

  const startPublishJob = ({ gh, owner, repoName, dir, pkg, isPrivate, slug, warnings, overwrite, repoExists }) => {
    const job = {
      id: `publish-${Date.now().toString(36)}`,
      slug,
      startedAt: Date.now(),
      finishedAt: null,
      running: true,
      cancelRequested: false,
      phase: 'checking',
      progress: { done: 0, total: 0, current: '' },
      result: null,
      error: null,
    }
    publishJob = job

    const setPhase = phase => { job.phase = phase }

    const run = async () => {
      try {
        // 1. Create the repository if it does not exist.
        if (!repoExists) {
          setPhase('creating')
          const created = await createRepo(gh, {
            name: repoName,
            private: isPrivate,
            description: String(pkg.description ?? '').slice(0, 300),
          })
          if (!created.ok) {
            job.error = created.needsAuth
              ? 'token 缺少创建仓库的权限（fine-grained token 需要 Administration: read/write）'
              : created.error
            return
          }
        }

        // 2. Write the repository field BEFORE pushing, so the first commit has it.
        setPhase('field')
        const repoFieldFix = diagnose(dir, { repoUrl: slug }, { targetRepo: slug })
        let repoFieldWritten = false
        if (repoFieldFix.ok) {
          const wanted = repoFieldFix.fixPlan.writes.filter(w => w.kind === 'package.json')
          if (wanted.length > 0) {
            const written = applyFixes({ writes: wanted, skipped: [] })
            repoFieldWritten = written.applied.length > 0
          }
        }

        // 3. Read the tree. Re-collected because package.json just changed.
        setPhase('reading')
        const collected = collectFiles(dir)
        if (!collected.ok) { job.error = collected.error; return }
        const files = []
        for (const file of collected.files) {
          if (job.cancelRequested) { job.error = '已取消'; return }
          try {
            files.push({ path: file.path, base64: fs.readFileSync(file.abs).toString('base64') })
          } catch (error) {
            job.error = `读取 ${file.path} 失败：${error?.message ?? error}`
            return
          }
        }

        // 4. Push.
        setPhase('uploading')
        job.progress = { done: 0, total: files.length, current: '' }
        const pushed = await pushFiles(gh, owner, repoName, {
          message: `Add ${pkg.name}${pkg.version ? ` v${pkg.version}` : ''}`,
          files,
          allowOverwrite: overwrite,
          onProgress: p => {
            if (p.phase === 'blobs') {
              job.progress = { done: p.done, total: p.total, current: p.current ?? '' }
            } else {
              job.phase = p.phase === 'tree' ? 'uploading' : p.phase === 'commit' ? 'uploading' : 'uploading'
              job.progress = { ...job.progress, current: '' }
            }
          },
        })
        if (!pushed.ok) {
          job.error = pushed.error
          job.needsOverwrite = pushed.reason === 'repo-not-empty'
          return
        }

        // 5. Fill the wizard's repo field so the next check stops complaining.
        const drafts = readDrafts(store)
        drafts[dir] = { ...(drafts[dir] ?? {}), repoUrl: `https://github.com/${slug}` }
        writeDrafts(store, drafts)

        const after = diagnose(dir, drafts[dir], { targetRepo: slug })
        job.result = {
          repoUrl: `https://github.com/${slug}`,
          owner,
          repo: repoName,
          branch: pushed.branch,
          files: pushed.files,
          commitUrl: pushed.commitUrl,
          root: pushed.root,
          repoFieldWritten,
          topLevel: collected.stats.topLevel,
          skipped: collected.skipped,
          findings: after.ok ? after.findings : [],
          summary: after.ok ? after.summary : null,
          draft: drafts[dir],
          warnings,
        }
        job.phase = 'done'
      } catch (error) {
        job.error = String(error?.message ?? error)
        log.warn?.(`onshelf: publish failed: ${job.error}`)
      } finally {
        job.running = false
        job.finishedAt = Date.now()
        if (job.error) job.phase = 'failed'
      }
    }

    job.done = run()
    return job
  }

  const publicPublishJob = (job, { includeResult = false } = {}) => (job ? {
    id: job.id,
    slug: job.slug,
    running: job.running,
    phase: job.phase,
    phaseLabel: publishPhases[job.phase] ?? job.phase,
    progress: job.progress,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    error: job.error,
    needsOverwrite: job.needsOverwrite === true,
    ...(includeResult ? { result: job.result } : {}),
  } : null)

  /**
   * Mirror the draft's screenshot list into the plugin's own `screenshots.json`.
   *
   * There used to be two answers to "which screenshots does this plugin have?" — the
   * wizard's draft and that file — and they disagreed: an image pasted on ③ was in
   * the draft but not on disk as a declaration, so ④ said "nothing to upload".
   *
   * `screenshots.json` is what the marketplace reads, so it has to exist. Writing it
   * from the draft on every change makes the draft the single source of truth, and
   * keeps the file consistent with what the author actually sees.
   */
  const syncScreenshotsJson = (dir, screenshots) => {
    const list = Array.isArray(screenshots) ? screenshots.filter(s => typeof s === 'string' && s.trim() !== '') : []
    if (list.length === 0) return { ok: true, written: false, reason: 'empty' }
    const file = path.join(dir, 'screenshots.json')
    try {
      // Preserve the `{ "screenshots": [...] }` form if that is what was already
      // there; otherwise write the plain array the guide documents.
      let shaped = JSON.stringify(list, null, 2) + '\n'
      const existing = readJsonSafeLocal(file)
      if (existing && !Array.isArray(existing) && Array.isArray(existing.screenshots)) {
        shaped = JSON.stringify({ screenshots: list }, null, 2) + '\n'
      }
      fs.writeFileSync(file, shaped, 'utf8')
      return { ok: true, written: true, file, paths: list }
    } catch (error) {
      return { ok: false, written: false, error: String(error?.message ?? error) }
    }
  }

  const readJsonSafeLocal = file => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  }

  /**
   * Fix everything that can be fixed for one plugin: the file-level rewrites plus
   * every draft action the current findings ask for.
   *
   * Shared by the wizard's "一键修复" button and the agent tool's `fix` action, so
   * what the button does and what the model does cannot diverge. Anything that
   * genuinely needs a human decision comes back in `manual` — "自动修复" must never
   * claim more than it did.
   */
  const runAutofix = (dir, { dryRun = false } = {}) => {
    const pkg = inspectPackage(dir)
    if (!pkg) return { ok: false, error: `不是插件目录：${dir}` }

    const drafts = readDrafts(store)
    let draft = drafts[dir] ?? {}

    const before = diagnose(dir, draft, { targetRepo: draft.repoUrl })
    if (!before.ok) return { ok: false, error: before.error }

    const applied = []
    const manual = []

    // 1. File-level rewrites first: they can change what the draft should say.
    if (dryRun) {
      for (const w of before.fixPlan.writes) applied.push({ kind: 'file', file: w.file, dryRun: true })
    } else if (before.fixPlan.writes.length > 0) {
      const written = applyFixes(before.fixPlan)
      for (const a of written.applied) applied.push({ kind: 'file', ...a })
      for (const f of written.failures) manual.push({ file: f.file, reason: f.reason })
      scanCache = null
    }

    // 2. Draft actions, re-checked after each pass: filling the description can
    //    resolve several findings at once, and one action can change the next.
    for (let pass = 0; pass < 3; pass++) {
      const pkgNow = inspectPackage(dir)
      if (!pkgNow) break
      const findings = checkPackage(pkgNow, draft, { targetRepo: draft.repoUrl })
      const draftActions = findings.filter(f => f.action?.kind === 'draft')
      if (draftActions.length === 0) {
        for (const f of findings) {
          if (f.action?.kind === 'manual') manual.push({ id: f.id, title: f.title, hint: f.action.hint })
        }
        break
      }
      let changed = false
      for (const finding of draftActions) {
        const result = applyDraftFix(pkgNow, draft, finding.action)
        if (!result.ok) { manual.push({ id: finding.id, title: finding.title, reason: result.reason }); continue }
        const next = { ...draft, ...result.patch }
        if (JSON.stringify(next) === JSON.stringify(draft)) continue
        draft = next
        changed = true
        applied.push({ kind: 'draft', id: finding.id, patch: result.patch, note: result.note ?? null })
      }
      if (!changed) break
    }

    if (!dryRun) {
      drafts[dir] = draft
      writeDrafts(store, drafts)
    }

    const after = diagnose(dir, draft, { targetRepo: draft.repoUrl })
    if (manual.length === 0 && after.ok) {
      for (const f of after.findings) {
        if (f.action?.kind === 'manual') manual.push({ id: f.id, title: f.title, hint: f.action.hint })
      }
    }
    return {
      ok: true,
      dryRun,
      applied,
      manual,
      draft,
      findings: after.ok ? after.findings : [],
      summary: after.ok ? after.summary : null,
    }
  }

  /* ─────────────────────────── agent tool ─────────────────────────── */

  ctx.tools.register({
    name: 'onshelf',
    description:
      'Publish a DSH plugin to the awesome-dsh-plugin list. action "scan" finds local packages that declare ' +
      'dsh.bundle (and packages that only declare dsh.client, which cannot be installed). action "check" runs ' +
      'the contributing.md rulebook against one plugin directory and returns findings plus a safe fix plan. ' +
      'action "fix" applies those fixes, backing up every file first. action "prepare" drafts the entry YAML, ' +
      'bilingual description and screenshots.json without touching the network. action "submit" forks the list, ' +
      'commits the entry and opens a PR — it needs a GitHub token supplied earlier through the wizard. ' +
      'Always run "check" before "submit".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['scan', 'check', 'fix', 'prepare', 'submit', 'status'],
          description:
            'scan = find candidates; check = diagnose one plugin; fix = apply safe fixes; prepare = draft ' +
            'submission materials offline; submit = open the PR; status = what the session knows (token, scan).',
        },
        dir: {
          type: 'string',
          description: 'Plugin directory. Required for check/fix/prepare; for submit it identifies which scanned plugin to submit.',
        },
        roots: {
          type: 'array',
          items: { type: 'string' },
          description: 'For scan: directories to search. Omit to use the workspace and its parent.',
        },
        category: {
          type: 'string',
          enum: CATEGORIES,
          description: 'For prepare: the list category. Omit to let it be inferred from the code.',
        },
        descriptionEn: { type: 'string', description: 'For prepare: override the drafted English description.' },
        descriptionZh: { type: 'string', description: 'For prepare: override the drafted Chinese description.' },
        repoUrl: { type: 'string', description: 'For prepare/submit: the GitHub repo to be listed (owner/repo or full URL).' },
        pluginSubpath: { type: 'string', description: 'For prepare/submit: monorepo subpackage path, when the plugin is not at the repo root.' },
        screenshots: {
          type: 'array',
          items: { type: 'string' },
          description: 'For prepare: screenshot paths relative to the plugin directory (1-8).',
        },
        tarball: { type: 'string', description: 'For prepare: optional GitHub Release .tgz URL.' },
        dryRun: { type: 'boolean', description: 'For fix/submit: compute the plan and return it without writing anything.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'action', 'text'],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          text: { type: 'string' },
          data: { type: 'object', additionalProperties: true, properties: {} },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const action = String(args.action ?? 'scan')

      if (action === 'status') {
        const lines = []
        lines.push(`扫描根目录：${scanRoots().join('、') || '（无）'}`)
        lines.push(`本次扫描：${scanCache ? `${scanCache.found.length} 个可收录候选、${scanCache.nearMisses.length} 个近失（缺 dsh.bundle）` : '尚未扫描'}`)
        lines.push(`GitHub 身份：${identity ? identity.login : '未提供 token（①②③ 步不需要 token，⑤ 步需要）'}`)
        return { ok: true, action, text: lines.join('\n'), data: { roots: scanRoots(), scanned: Boolean(scanCache) } }
      }

      if (action === 'scan') {
        const roots = Array.isArray(args.roots) && args.roots.length > 0
          ? args.roots.map(r => path.resolve(String(r)))
          : scanRoots()
        const result = await runScan(roots, true)
        const lines = [`扫描 ${roots.join('、')}`, '']
        lines.push(`可收录候选（声明了 dsh.bundle）：${result.found.length} 个`)
        for (const p of result.found) {
          lines.push(`  ${p.name}  ${p.dir}`)
          lines.push(`      ${p.hasClient ? '含浏览器半身' : '仅 host 半身'} · ${p.repository ?? '无 repository 字段'}`)
        }
        if (result.nearMisses.length > 0) {
          lines.push('')
          lines.push(`⚠️ 近失：${result.nearMisses.length} 个看起来是 DSH 插件但只声明了 dsh.client（CI 会直接拒绝）`)
          for (const p of result.nearMisses) lines.push(`  ${p.name}  ${p.dir}`)
        }
        if (result.errors.length > 0) {
          lines.push('')
          lines.push(`读取失败 ${result.errors.length} 处：`)
          for (const e of result.errors.slice(0, 10)) lines.push(`  ${e}`)
        }
        return {
          ok: true,
          action,
          text: lines.join('\n'),
          data: {
            found: result.found.map(brief),
            nearMisses: result.nearMisses.map(brief),
            errors: result.errors,
          },
        }
      }

      if (action === 'check') {
        const dir = requireDir(args.dir)
        const draft = readDrafts(store)[dir] ?? {}
        const result = diagnose(dir, draft, { targetRepo: draft.repoUrl })
        if (!result.ok) return { ok: false, action, text: result.error }
        return {
          ok: true,
          action,
          text: renderFindings(result),
          data: {
            findings: result.findings,
            summary: result.summary,
            fixPlan: result.fixPlan.writes.map(w => ({ file: w.file, kind: w.kind })),
          },
        }
      }

      if (action === 'fix') {
        const dir = requireDir(args.dir)
        const dryRun = args.dryRun === true
        const result = runAutofix(dir, { dryRun })
        if (!result.ok) return { ok: false, action, text: result.error }

        const lines = []
        const files = result.applied.filter(a => a.kind === 'file')
        const drafts = result.applied.filter(a => a.kind === 'draft')
        if (result.applied.length === 0) {
          lines.push(dryRun ? '[dry run] 没有可自动修复的问题。' : '没有可自动修复的问题。')
        } else {
          if (dryRun) lines.push('[dry run]')
          if (files.length > 0) {
            lines.push(`改了 ${files.length} 个文件：`)
            for (const f of files) lines.push(`  ${f.kind === 'file' ? f.file : f}`)
          }
          if (drafts.length > 0) {
            lines.push(`填写了 ${drafts.length} 项投稿信息：`)
            for (const d of drafts) {
              for (const [field, value] of Object.entries(d.patch ?? {})) {
                lines.push(`  ${field} = ${String(value).slice(0, 80)}`)
              }
              if (d.note) lines.push(`    （${d.note}）`)
            }
          }
        }
        if (result.manual.length > 0) {
          lines.push('')
          lines.push(`还有 ${result.manual.length} 条只能手动处理：`)
          for (const m of result.manual) {
            lines.push(`  ${m.title ?? m.id}：${m.hint ?? m.reason ?? ''}`)
          }
        }
        if (!dryRun && result.summary) {
          lines.push('')
          lines.push(`修复后：错误 ${result.summary.error} · 警告 ${result.summary.warn} · 提示 ${result.summary.info}`)
          lines.push(result.summary.blocked ? '仍有阻塞性错误。' : '没有阻塞性错误，可以进入第 ③ 步生成投稿材料。')
        }
        return {
          ok: result.summary ? !result.summary.blocked : true,
          action,
          text: lines.join('\n'),
          data: { applied: result.applied, manual: result.manual, draft: result.draft },
        }
      }

      if (action === 'prepare') {
        const dir = requireDir(args.dir)
        const pkg = inspectPackage(dir)
        if (!pkg) return { ok: false, action, text: `不是插件目录：${dir}` }
        const draft = {
          ...readDrafts(store)[dir],
          ...(args.category ? { category: args.category } : {}),
          ...(args.descriptionEn ? { descriptionEn: args.descriptionEn } : {}),
          ...(args.descriptionZh !== undefined ? { descriptionZh: args.descriptionZh } : {}),
          ...(args.repoUrl ? { repoUrl: args.repoUrl } : {}),
          ...(args.pluginSubpath !== undefined ? { pluginSubpath: args.pluginSubpath } : {}),
          ...(Array.isArray(args.screenshots) ? { screenshots: args.screenshots } : {}),
          ...(args.tarball !== undefined ? { tarball: args.tarball } : {}),
        }
        const submission = buildSubmission(pkg, draft)
        if (!submission.ok && submission.error) return { ok: false, action, text: submission.error }
        return {
          ok: submission.validation.ok,
          action,
          text: renderSubmission(submission),
          data: {
            entryFile: submission.entryFile,
            yaml: submission.yaml,
            entry: submission.entry,
            validation: submission.validation,
            screenshotVerdicts: submission.screenshotVerdicts,
          },
        }
      }

      if (action === 'submit') {
        if (!token) {
          return {
            ok: false,
            action,
            text: [
              '还没有 GitHub token。第 ⑤ 步需要它；①②③ 步不需要。',
              '在 设置 → 上架台 里粘贴一个 fine-grained token（只需 Contents: read/write 与 Pull requests: read/write），',
              '或者只生成材料、由你自己提 PR（第 ③ 步的产物就是完整的提交内容）。',
            ].join('\n'),
          }
        }
        const dir = requireDir(args.dir)
        const pkg = inspectPackage(dir)
        if (!pkg) return { ok: false, action, text: `不是插件目录：${dir}` }
        const draft = readDrafts(store)[dir] ?? {}
        const submission = buildSubmission(pkg, draft)
        if (!submission.ok && submission.error) return { ok: false, action, text: submission.error }
        if (!submission.validation.ok) {
          return { ok: false, action, text: `投稿材料还不合规，先修好：\n${renderValidation(submission.validation)}` }
        }
        const gh = client()
        const me = identity ?? (await whoami(gh))
        if (!me.ok) return { ok: false, action, text: `token 无效：${me.error}` }
        identity = me

        const branch = branchNameFor(submission.entryFile, pkg.version)
        const plan = await planSubmission(gh, {
          login: me.login,
          target: submission.target,
          entryFile: submission.entryFile,
          yaml: submission.yaml,
          screenshots: [],
          prTitle: `Add ${submission.entry.name}`,
          prBody: submission.prDraft,
          branchName: branch,
        })
        if (!plan.ok) return { ok: false, action, text: plan.error }
        if (args.dryRun === true) {
          return { ok: true, action, text: `[dry run] 将执行：\n${plan.steps.map(s => `  - ${s.label}`).join('\n')}`, data: { steps: plan.steps, warnings: plan.warnings } }
        }
        const result = await executeSubmission(gh, plan, {
          login: me.login,
          target: submission.target,
          entryFile: submission.entryFile,
          yaml: submission.yaml,
          files: [],
          prTitle: `Add ${submission.entry.name}`,
          prBody: submission.prDraft,
          branchName: branch,
        })
        if (!result.ok) return { ok: false, action, text: `提交失败（${result.step}）：${result.error}` }
        return {
          ok: true,
          action,
          text: [
            result.reusedPr ? '这个分支已经有开着的 PR，已复用：' : 'PR 已创建：',
            `  ${result.prUrl}`,
            '',
            `fork：${result.fork}  分支：${result.branch}`,
            ...(plan.warnings.length > 0 ? ['', '注意：', ...plan.warnings.map(w => `  - ${w}`)] : []),
          ].join('\n'),
          data: result,
        }
      }

      throw new Error(`unknown action "${action}"`)
    },
  })

  /* ─────────────────────────── HTTP surface ─────────────────────────── */

  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer

    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.replace(/^\/api\/onshelf/, '').replace(/\/+$/, '') || '/'
      const method = String(req.method ?? 'GET').toUpperCase()
      const send = (status, payload) => {
        const body = JSON.stringify(payload)
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      }

      try {
        /* ---- meta ---- */
        if (method === 'GET' && route === '/config') {
          return send(200, {
            categories: CATEGORIES.map(id => ({ id, label: CATEGORY_LABELS[id] ?? id })),
            roots: scanRoots(),
            rootsSource: rootsSource(),
            editableRoots: !Array.isArray(config?.scanRoots) || config.scanRoots.length === 0,
            awesome: AWESOME_REPO,
            hasToken: Boolean(token),
            identity: identity ? { login: identity.login, name: identity.name, avatarUrl: identity.avatarUrl } : null,
          })
        }

        /* ---- token ---- */
        if (method === 'POST' && route === '/token') {
          const body = await readJson(req)
          const candidate = String(body.token ?? '').trim()
          if (candidate === '') {
            token = null
            identity = null
            return send(200, { ok: true, cleared: true })
          }
          const probe = await whoami(createClient(candidate))
          if (!probe.ok) return send(400, { ok: false, error: probe.error })
          token = candidate
          identity = probe
          log.info?.(`onshelf: GitHub token accepted for ${probe.login}`)
          return send(200, { ok: true, login: probe.login, scopes: probe.scopes })
        }

        /* ---- ① scan ---- */
        // The blocking form. Kept because it is one round trip and the agent tool
        // needs a finished result; the settings page uses /scan/start instead so it
        // can show progress instead of a spinner.
        if (method === 'GET' && route === '/scan') {
          const requested = url.searchParams.getAll('root').filter(Boolean)
          const result = await runScan(
            requested.length > 0 ? requested.map(r => path.resolve(r)) : scanRoots(),
            url.searchParams.get('force') === '1',
          )
          return send(200, {
            ok: true,
            roots: result.roots,
            scannedAt: result.scannedAt,
            found: result.found.map(brief),
            nearMisses: result.nearMisses.map(brief),
            errors: result.errors,
            stats: result.stats,
          })
        }

        /* ---- ① scan, cached only (never walks the disk) ---- */
        if (method === 'GET' && route === '/scan/cached') {
          const roots = scanRoots()
          const usable = scanCache && JSON.stringify(scanCache.roots) === JSON.stringify(roots)
          return send(200, {
            ok: true,
            cached: usable
              ? {
                  roots: scanCache.roots,
                  scannedAt: scanCache.scannedAt,
                  found: scanCache.found.map(brief),
                  nearMisses: scanCache.nearMisses.map(brief),
                  errors: scanCache.errors,
                  stats: scanCache.stats,
                }
              : null,
          })
        }

        /* ---- ① scan, as a background job with progress ---- */
        if (method === 'POST' && route === '/scan/start') {
          const body = await readJson(req)
          const requested = Array.isArray(body.roots) && body.roots.length > 0
            ? body.roots.map(r => path.resolve(String(r)))
            : scanRoots()
          // Hand back the previous result straight away so the list never blanks
          // out while a rescan runs.
          const previous = scanCache && JSON.stringify(scanCache.roots) === JSON.stringify(requested)
            ? { found: scanCache.found.map(brief), nearMisses: scanCache.nearMisses.map(brief), scannedAt: scanCache.scannedAt, stats: scanCache.stats }
            : null
          const job = startScanJob(requested)
          return send(200, { ok: true, running: true, job: publicJob(job), previous })
        }

        if (method === 'GET' && route === '/scan/status') {
          const wanted = url.searchParams.get('job')
          if (wanted && scanJob && scanJob.id !== wanted) {
            return send(200, { ok: true, job: null, stale: true })
          }
          if (!scanJob) return send(200, { ok: true, job: null })
          const job = publicJob(scanJob)
          return send(200, {
            ok: true,
            job: {
              ...job,
              // Only hydrate the full list once, when it is done.
              result: job.result
                ? {
                    roots: job.result.roots,
                    scannedAt: job.result.scannedAt,
                    found: job.result.found.map(brief),
                    nearMisses: job.result.nearMisses.map(brief),
                    errors: job.result.errors,
                    stats: job.result.stats,
                  }
                : null,
            },
          })
        }

        if (method === 'POST' && route === '/scan/cancel') {
          if (scanJob?.running) scanJob.cancelled = true
          return send(200, { ok: true, cancelled: Boolean(scanJob?.cancelled) })
        }

        /* ---- scan roots, editable ---- */
        if (method === 'GET' && route === '/roots') {
          return send(200, { ok: true, roots: scanRoots(), source: rootsSource() })
        }

        if (method === 'POST' && route === '/roots') {
          const body = await readJson(req)
          const incoming = Array.isArray(body.roots) ? body.roots.map(String) : null
          if (!incoming) return send(400, { error: 'roots 必须是数组' })

          const accepted = []
          const rejected = []
          for (const raw of incoming) {
            const abs = path.resolve(raw.trim())
            if (abs.trim() === '') continue
            try {
              if (!fs.statSync(abs).isDirectory()) {
                rejected.push({ path: abs, reason: '不是目录' })
                continue
              }
              accepted.push(abs)
            } catch {
              rejected.push({ path: abs, reason: '路径不存在' })
            }
          }
          if (accepted.length === 0 && incoming.length > 0) {
            return send(400, { ok: false, error: '没有一个可用的目录', rejected })
          }

          const settings = readSettings(store)
          settings.scanRoots = accepted
          writeSettings(store, settings)
          scanCache = null
          return send(200, { ok: true, roots: accepted, rejected })
        }

        /**
         * Put the plugin's code on GitHub: create the repo if needed, write the
         * `repository` field into package.json, then push the whole directory as one
         * root commit.
         *
         * Order matters — the repository field is committed *with* the code, so the
         * published repo is self-describing from its first commit.
         */
        if (method === 'POST' && route === '/publish-repo') {
          if (!token) return send(401, { ok: false, needsAuth: true, error: '需要 token' })
          const body = await readJson(req)
          if (!body.dir) return send(400, { error: '缺少 dir' })
          const dir = path.resolve(String(body.dir))
          const pkg = inspectPackage(dir)
          if (!pkg) return send(400, { error: `不是插件目录：${dir}` })

          const gh = client()
          const me = identity ?? (await whoami(gh))
          if (!me.ok) return send(401, { ok: false, needsAuth: true, error: me.error })
          identity = me

          const repoName = String(body.name ?? pkg.name).trim()
          if (!/^[A-Za-z0-9._-]{1,100}$/.test(repoName)) {
            return send(400, { error: '仓库名只能用字母、数字、点、下划线、连字符' })
          }
          const isPrivate = body.private === true
          const owner = me.login
          const slug = `${owner}/${repoName}`

          // 1. Does it exist already?
          const target = await inspectTargetRepo(gh, owner, repoName)
          if (!target.ok) return send(400, { ok: false, error: target.error })

          const collected = collectFiles(dir)
          if (!collected.ok) return send(400, { error: collected.error })
          if (collected.files.length === 0) {
            return send(400, { error: '这个目录里没有可上传的文件。' })
          }

          // Visibility only applies to creation. On an existing repo the checkbox is
          // meaningless, so ignore it instead of failing — but warn when the repo's
          // real visibility will block the list.
          const warnings = []
          if (target.exists && target.private === true) {
            warnings.push(`仓库 ${owner}/${repoName} 是私有的，awesome 列表只收公开仓库。请在 GitHub 的 Settings → General → Danger Zone 里改成公开。`)
          }
          if (target.exists && isPrivate && target.private !== true) {
            warnings.push('这个仓库已经存在且是公开的；「建成私有仓库」只对新建生效，这里不会改动它。')
          }

          // A plugin README written on one machine is read on thousands, so details
          // that only hold locally (an install path, a `C:\Users\<name>`) are both
          // useless and a small privacy leak. Report them before anything is pushed.
          const privacy = scanForPrivateDetails(collected.files, { homeDir: ctx.get('homePaths')?.home ?? process.env.USERPROFILE })
          if (!privacy.clean) {
            warnings.push(
              `发现 ${privacy.findings.length} 处可能只对本机成立的细节（比如安装路径或用户名）。`
              + '它们不影响上传，但读到的人用不上，也可能泄露你的用户名；建议改成通用写法。',
            )
          }

          // The author's `.gitignore` is a decision already made: what it excludes is a
          // runtime observation, not source. Name them — a silent 144-file drop from
          // the plan would look like the wizard lost them instead.
          const excludedByAuthor = collected.skipped.filter(s => s.reason === GITIGNORE_SKIP_REASON)
          if (excludedByAuthor.length > 0) {
            const sample = excludedByAuthor.slice(0, 3).map(s => s.path).join('、')
            warnings.push(
              `按插件自己的 .gitignore 排除了 ${excludedByAuthor.length} 个文件（例如 ${sample}`
              + `${excludedByAuthor.length > 3 ? ' 等' : ''}），它们不会被上传。`,
            )
          }

          const plan = {
            owner,
            repo: repoName,
            url: `https://github.com/${owner}/${repoName}`,
            willCreate: !target.exists,
            exists: target.exists,
            empty: target.empty === true,
            files: collected.stats.files,
            bytes: collected.stats.bytes,
            topLevel: collected.stats.topLevel,
            skipped: collected.skipped,
            privacy,
            private: target.exists ? target.private === true : isPrivate,
            createsPublicRepo: !target.exists && !isPrivate,
            warnings,
          }

          if (body.dryRun === true) return send(200, { ok: true, dryRun: true, plan })

          if (target.exists && !target.empty && body.overwrite !== true) {
            return send(409, {
              ok: false,
              needsOverwrite: true,
              plan,
              error: `仓库 ${owner}/${repoName} 里已经有提交了。我不会覆盖它——确认要用本地代码替换里面的内容，请勾选覆盖。`,
            })
          }

          // 2. Run the upload as a background job so the wizard can show progress.
          //    Uploading a directory is one request per file; a single blocking POST
          //    that returns nothing for half a minute is indistinguishable from a
          //    dead button — which is exactly what the author reported.
          const job = startPublishJob({
            gh, owner, repoName, dir, pkg, isPrivate, slug, warnings,
            overwrite: body.overwrite === true,
            repoExists: target.exists,
          })
          return send(200, { ok: true, running: true, plan, job: publicPublishJob(job) })
        }

        if (method === 'GET' && route === '/publish-status') {
          const wanted = url.searchParams.get('job')
          if (!publishJob) return send(200, { ok: true, job: null })
          if (wanted && publishJob.id !== wanted) return send(200, { ok: true, job: null, stale: true })
          return send(200, { ok: true, job: publicPublishJob(publishJob, { includeResult: true }) })
        }

        if (method === 'POST' && route === '/publish-cancel') {
          if (publishJob?.running) publishJob.cancelRequested = true
          return send(200, { ok: true, cancelRequested: Boolean(publishJob?.cancelRequested) })
        }

        /* ---- ③ screenshots: accept pasted / dropped / picked image bytes ---- */
        /**
         * Save images the author pasted, dropped or picked into the plugin's own
         * `assets/` folder and return the relative paths for the draft.
         *
         * The browser can hand us bytes, not paths: a screenshot pasted from the
         * clipboard has no file on disk at all. So the host writes them — which also
         * means every path we record points at a file that really exists, which is
         * exactly what the rulebook checks.
         */
        if (method === 'POST' && route === '/screenshots') {
          const body = await readJson(req)
          if (!body.dir) return send(400, { error: '缺少 dir' })
          const dir = path.resolve(String(body.dir))
          const pkg = inspectPackage(dir)
          if (!pkg) return send(400, { error: `不是插件目录：${dir}` })

          const images = Array.isArray(body.images) ? body.images : []
          if (images.length === 0) return send(400, { error: '没有收到图片' })

          const rawFolder = String(body.folder ?? 'assets')
          // A `..` segment is a mistake or an attack, never a normalisation to fix up
          // silently: stripping it would write the images somewhere the caller did
          // not ask for. Refuse it.
          if (rawFolder.split(/[\\/]/).includes('..')) {
            return send(400, { error: `截图目录必须在插件目录内：${rawFolder}` })
          }
          const folder = rawFolder.replace(/^[./\\]+|[./\\]+$/g, '') || 'assets'
          const targetDir = path.resolve(dir, folder)
          // Never write outside the plugin directory, whatever the caller sends.
          const relToPlugin = path.relative(dir, targetDir)
          if (relToPlugin.startsWith('..') || path.isAbsolute(relToPlugin)) {
            return send(400, { error: `截图目录必须在插件目录内：${folder}` })
          }
          if (/(^|[\\/])node_modules([\\/]|$)/i.test(relToPlugin)) {
            return send(400, { error: '不能把图片写进 node_modules' })
          }

          const saved = []
          const failures = []
          for (const image of images) {
            const name = String(image?.name ?? '')
            const base64 = String(image?.base64 ?? '')
            if (base64 === '') { failures.push({ name, reason: '空的图片数据' }); continue }

            const ext = imageExtension(name, image?.type)
            if (!ext) {
              failures.push({ name, reason: '只接受 png / jpg / webp / gif / avif' })
              continue
            }

            // Keep the author's own filename when it is safe — they recognise their
            // own screenshots — and suffix on collision instead of overwriting.
            const stem = safeStem(name)
            let fileName = `${stem}.${ext}`
            let counter = 1
            while (fs.existsSync(path.join(targetDir, fileName))) {
              fileName = `${stem}-${counter++}.${ext}`
            }
            try {
              fs.mkdirSync(targetDir, { recursive: true })
              fs.writeFileSync(path.join(targetDir, fileName), Buffer.from(base64, 'base64'))
              saved.push(`${folder}/${fileName}`)
            } catch (error) {
              failures.push({ name, reason: error?.message ?? String(error) })
            }
          }

          let sync = { ok: true, written: false }
          if (saved.length > 0) {
            const drafts = readDrafts(store)
            const current = drafts[dir] ?? {}
            const next = [...new Set([...(current.screenshots ?? []), ...saved])].slice(0, 8)
            drafts[dir] = { ...current, screenshots: next }
            writeDrafts(store, drafts)
            // Declare them right away: a pasted image must be visible to ④ and to the
            // marketplace, not merely present in the wizard's private draft.
            sync = syncScreenshotsJson(dir, next)
          }

          return send(200, { ok: saved.length > 0, saved, failures, folder, screenshotsJson: sync })
        }

        /* ---- ③ screenshot preview: serve an image from inside the plugin ---- */
        /**
         * The wizard shows thumbnails of the screenshots it is about to declare.
         * They live in the author's plugin directory, not under the web root, so the
         * only way for the page to display them is through this route.
         *
         * Two hard rules: the path must stay inside that plugin directory, and the
         * file must be a supported image. Anything else is a 400, not a 404, so a
         * mistake is legible instead of looking like a missing file.
         */
        if (method === 'GET' && route === '/shot') {
          const dir = url.searchParams.get('dir')
          const rel = url.searchParams.get('path')
          if (!dir || !rel) return send(400, { error: '缺少 dir 或 path' })
          const pluginDir = path.resolve(dir)
          const abs = path.resolve(pluginDir, rel)
          const relToPlugin = path.relative(pluginDir, abs)
          if (relToPlugin.startsWith('..') || path.isAbsolute(relToPlugin)) {
            return send(400, { error: '路径必须在插件目录内' })
          }
          const ext = path.extname(abs).replace(/^\./, '').toLowerCase()
          const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' }[ext]
          if (!mime) return send(400, { error: `不是支持的图片格式：${rel}` })

          let bytes
          try {
            bytes = fs.readFileSync(abs)
          } catch {
            return send(404, { error: `图片不存在：${rel}` })
          }
          res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' })
          return res.end(bytes)
        }

        /* ---- repo topic: add `dsh-plugin` for the author ---- */
        /**
         * CI requires the `dsh-plugin` topic. It is a single API call, so making the
         * author click through the GitHub UI to add it is unnecessary — this does it
         * for them, with the same Administration permission repo creation already
         * needs.
         */
        if (method === 'POST' && route === '/repo/topic') {
          if (!token) return send(401, { ok: false, needsAuth: true, error: '需要 token' })
          const body = await readJson(req)
          const target = resolveTarget({ repoUrl: body.repo ?? '' })
          if (!target.ok) return send(400, { error: target.error })

          const me = identity ?? (await whoami(client()))
          if (!me.ok) return send(401, { ok: false, needsAuth: true, error: me.error })
          identity = me

          // Only the owner may rewrite topics; anything else would be a surprise write.
          if (target.owner.toLowerCase() !== String(me.login).toLowerCase()) {
            return send(400, {
              ok: false,
              error: `只能改自己仓库的 topic（当前 token 属于 ${me.login}，目标是 ${target.owner}）。`,
            })
          }

          const topic = String(body.topic ?? 'dsh-plugin').trim() || 'dsh-plugin'
          const result = await addRepoTopic(client(), target.owner, target.repo, topic)
          if (!result.ok) return send(400, { ok: false, ...result })
          return send(200, { ok: true, already: result.already, topics: result.topics, slug: target.slug })
        }

        /* ---- ② check ---- */
        if (method === 'GET' && route === '/check') {
          const dir = url.searchParams.get('dir')
          if (!dir) return send(400, { error: '缺少 dir' })
          const draft = readDrafts(store)[path.resolve(dir)] ?? {}
          const result = diagnose(path.resolve(dir), draft, { targetRepo: draft.repoUrl })
          if (!result.ok) return send(400, { error: result.error })
          return send(200, {
            ok: true,
            name: result.name,
            version: result.version,
            findings: result.findings,
            summary: result.summary,
            fixPlan: result.fixPlan.writes.map(w => ({ file: w.file, kind: w.kind, before: w.before, after: w.after })),
            skipped: result.fixPlan.skipped,
          })
        }

        if (method === 'POST' && route === '/fix') {
          const body = await readJson(req)
          const dir = path.resolve(String(body.dir ?? ''))
          if (!body.dir) return send(400, { error: '缺少 dir' })
          const draft = readDrafts(store)[dir] ?? {}
          const result = diagnose(dir, draft, { targetRepo: draft.repoUrl })
          if (!result.ok) return send(400, { error: result.error })
          if (body.dryRun === true) {
            return send(200, { ok: true, dryRun: true, writes: result.fixPlan.writes })
          }
          const applied = applyFixes(result.fixPlan)
          scanCache = null
          return send(200, { ok: applied.failures.length === 0, ...applied })
        }

        if (method === 'POST' && route === '/undo-fix') {
          const body = await readJson(req)
          const files = Array.isArray(body.files) ? body.files.map(String) : []
          const result = undoFixes(files)
          scanCache = null
          return send(200, { ok: result.failures.length === 0, ...result })
        }

        /**
         * Apply one `{ kind: 'draft' }` finding. The wizard renders a button per
         * actionable finding and calls this by id; the rule declared the action, so
         * the two cannot drift apart.
         */
        if (method === 'POST' && route === '/draft/apply') {
          const body = await readJson(req)
          if (!body.dir) return send(400, { error: '缺少 dir' })
          const dir = path.resolve(String(body.dir))
          const pkg = inspectPackage(dir)
          if (!pkg) return send(400, { error: `不是插件目录：${dir}` })

          const drafts = readDrafts(store)
          const draft = drafts[dir] ?? {}
          // Recompute findings so the action comes from the rulebook, not the client.
          const current = diagnose(dir, draft, { targetRepo: draft.repoUrl })
          if (!current.ok) return send(400, { error: current.error })
          const finding = current.findings.find(f => f.id === body.id)
          if (!finding) return send(400, { error: `没有这条检查项：${body.id}` })
          if (finding.action?.kind !== 'draft') {
            return send(400, { error: `这条问题不能通过改草稿解决（kind=${finding.action?.kind ?? 'none'}）` })
          }

          const applied = applyDraftFix(pkg, draft, finding.action)
          if (!applied.ok) return send(400, { ok: false, error: applied.reason })

          drafts[dir] = { ...draft, ...applied.patch }
          writeDrafts(store, drafts)

          const after = diagnose(dir, drafts[dir], { targetRepo: drafts[dir].repoUrl })
          return send(200, {
            ok: true,
            applied: { id: finding.id, patch: applied.patch, note: applied.note ?? null },
            draft: drafts[dir],
            findings: after.findings,
            summary: after.summary,
          })
        }

        /**
         * Fix everything that can be fixed in one go: the file-level rewrites plus
         * every draft action the current findings ask for. Anything that genuinely
         * needs a human decision is returned in `manual` and left alone.
         */
        if (method === 'POST' && route === '/autofix') {
          const body = await readJson(req)
          if (!body.dir) return send(400, { error: '缺少 dir' })
          const result = runAutofix(path.resolve(String(body.dir)), { dryRun: body.dryRun === true })
          if (!result.ok) return send(400, { error: result.error })
          return send(200, result)
        }

        /* ---- ③ prepare ---- */
        if (method === 'GET' && route === '/draft') {
          const dir = url.searchParams.get('dir')
          if (!dir) return send(400, { error: '缺少 dir' })
          const abs = path.resolve(dir)
          const pkg = inspectPackage(abs)
          if (!pkg) return send(400, { error: `不是插件目录：${abs}` })
          const saved = readDrafts(store)[abs] ?? {}
          const surface = readSurface(pkg)
          const descriptions = draftDescriptions(pkg, { surface })
          const inferred = inferCategory(pkg, descriptions.en)

          // Heal drafts saved before screenshots were mirrored to disk: the author's
          // images exist in the draft, so the plugin should declare them too.
          if (Array.isArray(saved.screenshots) && saved.screenshots.length > 0) {
            syncScreenshotsJson(abs, saved.screenshots)
          }
          return send(200, {
            ok: true,
            dir: abs,
            package: brief(pkg),
            surface,
            draft: {
              // An empty string is "not chosen", not a choice: `??` alone would keep
              // it and leave the select blank with no suggestion to fall back on.
              category: saved.category || inferred.category,
              // `categorySource` is what the UI keys off: a value the author picked
              // by hand is never silently replaced by a fresh guess.
              categorySource: saved.category ? 'manual' : 'suggested',
              categoryReason: saved.category
                ? `你在下拉框里选过，所以保留它（自动推荐是 ${inferred.category}）`
                : inferred.reason,
              suggestedCategory: inferred.category,
              suggestedCategoryReason: inferred.reason,
              // `||` rather than `??`: a cleared textarea should offer the draft again
              // instead of leaving the author with an empty required field.
              descriptionEn: saved.descriptionEn || descriptions.en,
              descriptionZh: saved.descriptionZh ?? descriptions.zh,
              repoUrl: saved.repoUrl || (pkg.repository ? `https://github.com/${pkg.repository}` : ''),
              pluginSubpath: saved.pluginSubpath ?? '',
              screenshots: saved.screenshots ?? (pkg.screenshots?.paths ?? []),
              tarball: saved.tarball ?? '',
            },
            descriptionSources: descriptions.sources,
            claims: descriptions.claims,
          })
        }

        if (method === 'POST' && route === '/draft') {
          const body = await readJson(req)
          const dir = path.resolve(String(body.dir ?? ''))
          if (!body.dir) return send(400, { error: '缺少 dir' })
          const drafts = readDrafts(store)
          drafts[dir] = {
            ...(drafts[dir] ?? {}),
            ...(body.draft && typeof body.draft === 'object' ? body.draft : {}),
          }
          writeDrafts(store, drafts)
          // Keep the plugin's own declaration in step with the draft.
          const synced = syncScreenshotsJson(dir, drafts[dir].screenshots)
          return send(200, { ok: true, draft: drafts[dir], screenshotsJson: synced })
        }

        if (method === 'GET' && route === '/preview') {
          const dir = url.searchParams.get('dir')
          if (!dir) return send(400, { error: '缺少 dir' })
          const abs = path.resolve(dir)
          const pkg = inspectPackage(abs)
          if (!pkg) return send(400, { error: `不是插件目录：${abs}` })
          const draft = readDrafts(store)[abs] ?? {}
          const submission = buildSubmission(pkg, draft)
          if (!submission.ok && submission.error) return send(400, { error: submission.error })
          return send(200, {
            ok: submission.validation.ok,
            entryFile: submission.entryFile,
            yaml: submission.yaml,
            entry: submission.entry,
            validation: submission.validation,
            screenshotVerdicts: submission.screenshotVerdicts,
            screenshotsJson: submission.screenshotsJson,
            prDraft: submission.prDraft,
            categoryLabel: submission.categoryLabel,
            categoryReason: submission.categoryReason,
          })
        }

        /* ---- GitHub facts for the rulebook ---- */
        if (method === 'GET' && route === '/repo') {
          if (!token) return send(401, { ok: false, needsAuth: true, error: '需要 token 才能读取仓库信息' })
          const repoUrl = url.searchParams.get('repo')
          const target = resolveTarget({ repoUrl })
          if (!target.ok) return send(400, { error: target.error })
          const facts = await repoFacts(client(), target.owner, target.repo)
          if (!facts.ok) return send(400, { ok: false, ...facts })
          return send(200, {
            ok: true,
            ...facts,
            hasTopic: facts.topics.includes('dsh-plugin'),
            oldEnough: facts.ageDays !== null && facts.ageDays >= 1,
          })
        }

        /* ---- ④ upload screenshots to the author's own repo ---- */
        if (method === 'POST' && route === '/upload-screenshots') {
          if (!token) return send(401, { ok: false, needsAuth: true, error: '需要 token' })
          const body = await readJson(req)
          const dir = path.resolve(String(body.dir ?? ''))
          const pkg = inspectPackage(dir)
          if (!pkg) return send(400, { error: `不是插件目录：${dir}` })
          const target = resolveTarget({ repoUrl: body.repoUrl ?? pkg.repository })
          if (!target.ok) return send(400, { error: target.error })
          // The wizard's draft is the authority: it is what the author sees and edits.
          // `screenshots.json` may not exist yet, and reading only that was why a
          // screenshot just pasted on ③ looked like "nothing to upload" here.
          const draftShots = readDrafts(store)[dir]?.screenshots
          const paths = Array.isArray(body.paths) && body.paths.length > 0
            ? body.paths.map(String)
            : (Array.isArray(draftShots) && draftShots.length > 0
              ? draftShots
              : (pkg.screenshots?.paths ?? []))
          if (paths.length === 0) {
            return send(400, {
              ok: false,
              error: '还没有截图。回到 ③ 投稿材料，把截图粘贴或拖进「截图路径」，再回到这里。',
            })
          }
          if (paths.length > 8) return send(400, { error: '截图最多 8 张' })

          const images = []
          const failures = []
          for (const rel of paths) {
            const abs = path.resolve(dir, rel)
            if (!abs.startsWith(path.resolve(dir))) { failures.push({ path: rel, reason: '路径跳出插件目录' }); continue }
            try {
              images.push({ path: rel, base64: fs.readFileSync(abs).toString('base64') })
            } catch (error) {
              failures.push({ path: rel, reason: error?.message ?? String(error) })
            }
          }
          if (images.length === 0) return send(400, { error: '没有可读取的截图', failures })

          const me = identity ?? (await whoami(client()))
          if (!me.ok) return send(401, { ok: false, needsAuth: true, error: me.error })
          const facts = await repoFacts(client(), target.owner, target.repo)
          if (!facts.ok) return send(400, { ok: false, ...facts })

          if (body.dryRun === true) {
            return send(200, { ok: true, dryRun: true, wouldUpload: images.map(i => i.path), failures })
          }

          const result = await uploadScreenshots(client(), {
            owner: target.owner,
            repo: target.repo,
            baseBranch: facts.defaultBranch,
            branchName: body.branch ?? 'onshelf/screenshots',
            images,
            screenshotsPath: body.writeManifest === false ? null : JSON.stringify(paths, null, 2) + '\n',
          })
          if (!result.ok) return send(400, { ok: false, ...result })
          return send(200, { ok: true, failures, ...result })
        }

        /* ---- ⑤ plan + submit ---- */
        if (method === 'POST' && route === '/submit') {
          if (!token) return send(401, { ok: false, needsAuth: true, error: '需要 token' })
          const body = await readJson(req)
          const dir = path.resolve(String(body.dir ?? ''))
          const pkg = inspectPackage(dir)
          if (!pkg) return send(400, { error: `不是插件目录：${dir}` })
          const draft = { ...(readDrafts(store)[dir] ?? {}), ...(body.draft ?? {}) }
          const submission = buildSubmission(pkg, draft)
          if (!submission.ok && submission.error) return send(400, { error: submission.error })
          if (!submission.validation.ok) {
            return send(400, { ok: false, validation: submission.validation, error: '投稿材料还不合规' })
          }

          const me = identity ?? (await whoami(client()))
          if (!me.ok) return send(401, { ok: false, needsAuth: true, error: me.error })
          identity = me

          const branch = body.branch ?? branchNameFor(submission.entryFile)
          const gh = client()

          // Does this entry already exist? That decides "add" vs "update", which
          // changes the PR title, the PR body and how the plan describes itself.
          const existingEntry = await entryExists(gh, AWESOME_REPO.owner, AWESOME_REPO.repo, submission.entryFile)
          const mode = existingEntry.ok && existingEntry.exists ? 'update' : 'add'
          const diff = mode === 'update'
            ? diffEntry(existingEntry.content, submission.yaml)
            : null
          const prTitle = mode === 'update'
            ? `Update ${submission.entry.name}`
            : `Add ${submission.entry.name}`
          const prBody = mode === 'update'
            ? buildPrDraft(submission.entry, submission.target, pkg, submission.surface, { mode, diff })
            : submission.prDraft

          const plan = await planSubmission(gh, {
            login: me.login,
            target: submission.target,
            entryFile: submission.entryFile,
            yaml: submission.yaml,
            screenshots: [],
            prTitle,
            prBody,
            branchName: branch,
            version: pkg.version,
          })
          if (!plan.ok) return send(400, { ok: false, ...plan })
          if (body.dryRun === true) {
            return send(200, {
              ok: true,
              dryRun: true,
              plan: {
                mode,
                steps: plan.steps,
                warnings: plan.warnings,
                repoStatus: plan.repoStatus,
                branch: plan.branch ?? branch,
                changedLines: diff?.changed?.length ?? 0,
                diff,
                existingPr: plan.existingSubmission?.pr ?? null,
              },
            })
          }

          // Auto-fix the one CI condition that a single API call can fix. The author
          // came here to submit; sending them to the GitHub UI for a checkbox the
          // tool can tick is exactly the kind of "you do it yourself" this plugin is
          // supposed to remove. Anything we change is reported back.
          let topicResult = null
          if (plan.repoStatus && plan.repoStatus.hasTopic === false) {
            topicResult = await addRepoTopic(gh, submission.target.owner, submission.target.repo, 'dsh-plugin')
            if (topicResult.ok) {
              plan.warnings = plan.warnings.filter(w => !/dsh-plugin topic/.test(w))
            }
          }

          const result = await executeSubmission(gh, plan, {
            login: me.login,
            target: submission.target,
            entryFile: submission.entryFile,
            yaml: submission.yaml,
            files: [],
            prTitle,
            prBody,
            branchName: plan.branch ?? branch,
          })
          if (!result.ok) {
            return send(400, {
              ok: false, mode, warnings: plan.warnings, repoStatus: plan.repoStatus, topicResult, ...result,
            })
          }
          return send(200, {
            ok: true,
            mode,
            prTitle,
            changedLines: diff?.changed?.length ?? 0,
            warnings: plan.warnings,
            repoStatus: plan.repoStatus,
            topicResult,
            ...result,
          })
        }

        /* ---- ⑤ what happened to my PR ---- */
        /**
         * Read the PR's own state plus its CI result, and translate it.
         *
         * The author was being told to open the PR page and look for a red X. Every
         * fact needed is in three API responses, and a failure is worth translating
         * rather than pasting: "conclusion: failure" is not a next step.
         */
        if (method === 'GET' && route === '/pr-status') {
          if (!token) return send(401, { ok: false, needsAuth: true, error: '需要 token' })

          // `Number(null)` is 0 and `Number('')` is 0, so parsing first and validating
          // later turned "no number was given" into "PR #0 is invalid". Parse only what
          // is actually present.
          const rawNumber = url.searchParams.get('number')
          let number = rawNumber === null || String(rawNumber).trim() === '' ? null : Number(rawNumber)

          // With no number, find the PR for this plugin — open, merged or closed. A
          // merged submission must not read as "you have not submitted yet".
          if (number === null) {
            const dir = url.searchParams.get('dir')
            if (!dir) return send(400, { error: '请提供 number，或提供 dir 让插件自己找 PR' })
            const abs = path.resolve(dir)
            const pkg = inspectPackage(abs)
            if (!pkg) return send(400, { error: `不是插件目录：${abs}` })

            const draft = readDrafts(store)[abs] ?? {}
            const submission = buildSubmission(pkg, draft)
            if (!submission.ok && submission.error) return send(400, { error: submission.error })

            const me = identity ?? (await whoami(client()))
            if (!me.ok) return send(401, { ok: false, needsAuth: true, error: me.error })
            identity = me

            const found = await findExistingSubmission(
              client(), me.login, AWESOME_REPO.repo, submission.entryFile, pkg.version,
            )
            if (!found.found) {
              return send(200, {
                ok: true,
                found: false,
                status: describePrStatus({ ok: false, error: '还没找到你提交的 PR。先在 ⑤ 点「创建 PR」。' }),
              })
            }

            // The entry is on the list but no PR could be recovered: report the
            // listing instead of failing.
            if (!found.pr) {
              return send(200, {
                ok: true,
                found: true,
                status: describePrStatus({
                  ok: true,
                  number: null,
                  url: `https://github.com/${AWESOME_REPO.owner}/${AWESOME_REPO.repo}/blob/main/data/plugins/${submission.entryFile}`,
                  state: 'closed',
                  merged: true,
                  title: submission.entry.name,
                  checks: { verdict: 'merged', total: 0, failing: 0, pending: 0, neutral: 0, items: [] },
                }),
              })
            }
            number = found.pr.number
          }

          if (!Number.isInteger(number) || number <= 0) {
            return send(400, { error: `PR 编号不合法：${rawNumber}` })
          }

          const raw = await prStatus(client(), AWESOME_REPO.owner, AWESOME_REPO.repo, number)
          if (!raw.ok) return send(raw.notFound ? 404 : 400, { ok: false, ...raw })
          return send(200, { ok: true, found: true, status: describePrStatus(raw), raw })
        }

        /* ---- patch-file generator, exposed for the wizard's "create patch" ---- */
        if (method === 'GET' && route === '/patch-template') {
          const nameParam = url.searchParams.get('name') ?? 'dsh-your-plugin'
          return send(200, { ok: true, yaml: minimalPatchYaml(nameParam) })
        }

        return send(404, { error: `no route ${method} ${route}` })
      } catch (error) {
        log.warn?.(`onshelf: ${error?.message ?? error}`)
        return send(500, { error: String(error?.message ?? error) })
      }
    }

    scoped.effect(
      () => server.register({ kind: 'prefix', path: API_PREFIX, handler }),
      'onshelf: api routes',
    )
    log.info?.(`onshelf: API mounted at ${API_PREFIX}`)
  })

  ctx.effect(() => () => { /* nothing persistent to release */ }, 'onshelf: lifetime')
}

/* ──────────────────────────── helpers ──────────────────────────── */

function requireDir(dir) {
  if (!dir || String(dir).trim() === '') throw new Error('缺少 dir 参数')
  return path.resolve(String(dir))
}

/** Allowed image extensions, and the MIME types that map onto them. */
const IMAGE_EXT_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'])

/**
 * Work out the extension for an incoming image.
 *
 * The clipboard gives a MIME type but often a generic name like `image.png`, and a
 * dropped file gives a real name. Extension wins when it is a known one; otherwise
 * fall back to the MIME type. Returns `null` when neither is a supported image.
 */
function imageExtension(name, mimeType) {
  const fromName = path.extname(String(name ?? '')).replace(/^\./, '').toLowerCase()
  if (IMAGE_EXTENSIONS.has(fromName)) return fromName === 'jpeg' ? 'jpg' : fromName
  const fromType = IMAGE_EXT_BY_TYPE[String(mimeType ?? '').toLowerCase()]
  return fromType ?? null
}

/**
 * A filesystem-safe stem derived from the original name.
 *
 * Pasted images arrive as `image.png` (or with no name at all), which would collide
 * on the second paste, so unnamed images get a timestamped stem instead.
 */
function safeStem(name) {
  const rawStem = path.basename(String(name ?? '')).replace(/\.[^.]+$/, '')
  const cleaned = rawStem.replace(/[^\w\u4e00-\u9fff.-]+/g, '-').replace(/^-+|-+$/g, '')
  if (cleaned === '' || /^image$/i.test(cleaned) || /^paste$/i.test(cleaned)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    return `screenshot-${stamp}`
  }
  return cleaned
}

/** The compact shape both the tool and the API return for a scanned package. */
function brief(pkg) {
  return {
    dir: pkg.dir,
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    metaTitle: pkg.metaTitle,
    hasBundle: pkg.hasBundle,
    hasClient: pkg.hasClient,
    hasScreenshots: pkg.hasScreenshots,
    hasReadme: pkg.hasReadme,
    repository: pkg.repository,
    private: pkg.private,
    // `installed` = reached through an install directory, so not the author's to
    // publish; `linked` = reached through a junction/symlink and resolved to the
    // real source folder.
    installed: pkg.installed === true,
    linked: pkg.linked === true,
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try { resolve(JSON.parse(text)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function renderFindings(result) {
  const lines = []
  lines.push(`体检结果：${result.name}${result.version ? ` v${result.version}` : ''}`)
  lines.push(`错误 ${result.summary.error} · 警告 ${result.summary.warn} · 提示 ${result.summary.info}`)
  lines.push('')
  const order = { error: 0, warn: 1, info: 2 }
  const sorted = [...result.findings].sort((a, b) => order[a.level] - order[b.level])
  for (const f of sorted) {
    const tag = f.level === 'error' ? '✗' : f.level === 'warn' ? '!' : '·'
    lines.push(`${tag} [${f.level}] ${f.title}`)
    lines.push(`    ${f.detail}`)
    if (f.fixable) lines.push(`    → 可自动修复：${f.fixLabel ?? f.fix}`)
  }
  if (result.summary.error === 0) {
    lines.push('')
    lines.push('没有阻塞性错误，可以进入第 ③ 步生成投稿材料。')
  }
  return lines.join('\n')
}

function renderValidation(validation) {
  const lines = []
  for (const p of validation.problems) lines.push(`  ✗ ${p.field}: ${p.message}`)
  for (const w of validation.warnings) lines.push(`  ! ${w.field}: ${w.message}`)
  return lines.join('\n')
}

function renderSubmission(submission) {
  const lines = []
  lines.push(`投稿目标：${submission.target.slug}${submission.target.subpath ? `（子包 ${submission.target.subpath}）` : ''}`)
  lines.push(`条目文件：data/plugins/${submission.entryFile}`)
  lines.push(`分类：${submission.entry.category}（${submission.categoryLabel}）— ${submission.categoryReason}`)
  lines.push('')
  lines.push('--- data/plugins/' + submission.entryFile + ' ---')
  lines.push(submission.yaml.trimEnd())
  if (submission.screenshotsJson) {
    lines.push('')
    lines.push('--- screenshots.json ---')
    lines.push(submission.screenshotsJson.trimEnd())
  }
  if (submission.screenshotVerdicts.length > 0) {
    lines.push('')
    lines.push('截图校验：')
    for (const v of submission.screenshotVerdicts) {
      lines.push(`  ${v.ok ? '✓' : '✗'} ${v.path}${v.ok ? '' : ` — ${v.reason}`}${v.warning ? ` — ${v.warning}` : ''}`)
    }
  }
  lines.push('')
  if (submission.validation.ok) {
    lines.push('✅ 材料合规，可以进入第 ④⑤ 步（需要 GitHub token）。')
  } else {
    lines.push('还有阻塞问题：')
    lines.push(renderValidation(submission.validation))
  }
  if (submission.validation.warnings.length > 0 && submission.validation.ok) {
    lines.push('')
    lines.push('提醒：')
    lines.push(renderValidation({ problems: [], warnings: submission.validation.warnings }))
  }
  return lines.join('\n')
}

export {
  scanForPlugins, checkPackage, summarize, buildSubmission, draftDescriptions,
  inferCategory, readSurface, resolveTarget, renderEntryYaml, validateDraft,
  planFixes, applyFixes, entryFileName, CATEGORIES,
}
export default { name, inject, apply }
