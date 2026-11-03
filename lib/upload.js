/**
 * Collect a plugin directory into the file list a GitHub commit needs.
 *
 * This is the "put my code on GitHub" half of the job: the author should not have
 * to install git, learn about remotes, or know what a branch is. What they cannot
 * avoid is *deciding* — so everything here is a pure filesystem read, and the
 * caller shows the result before anything is uploaded.
 *
 * Deliberately ignored: `node_modules` (never belongs in a repo), `.git` (do not
 * push history from an unrelated working copy), our own backup files, the operating
 * system's droppings — and everything the author's own `.gitignore` excludes, because
 * that file is where a plugin states which of its files are runtime observations
 * rather than source (see `lib/gitignore.js`). Everything else is included, because a
 * plugin's shape is its author's business.
 *
 * @module lib/upload.js
 */

import fs from 'node:fs'
import path from 'node:path'

import { GITIGNORE_SKIP_REASON, isIgnored, loadGitignoreRules } from './gitignore.js'

/** Directories that never belong in a published plugin repo. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.dsh', '__pycache__', '.venv', 'venv',
  '.pnpm-store', '.turbo', '.cache',
])

/** Exact filenames to drop. */
const SKIP_FILES = new Set([
  '.DS_Store', 'Thumbs.db', 'desktop.ini', '.gitignore.bak',
])

/** Suffixes to drop (our own backups and editor/OS noise). */
const SKIP_SUFFIXES = ['.onshelf-backup', '.log', '.tmp', '.swp', '~']

/** Default ceilings. A mis-click on a folder with a video must not upload it. */
export const DEFAULT_LIMITS = {
  maxFiles: 400,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
}

/**
 * Walk `dir` and return `{ files, skipped, stats }`.
 *
 * `files` entries are `{ path, abs, size }` where `path` is the repo-relative path
 * with forward slashes — the form the Git Data API expects.
 */
export function collectFiles(dir, limits = {}) {
  const config = { ...DEFAULT_LIMITS, ...limits }
  const root = path.resolve(dir)
  const files = []
  const skipped = []
  let totalBytes = 0
  let truncated = false

  if (!fs.existsSync(root)) {
    return { ok: false, error: `目录不存在：${root}`, files: [], skipped, stats: emptyStats() }
  }

  const walk = (current, inheritedRules) => {
    if (truncated) return
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (error) {
      skipped.push({ path: relative(root, current), reason: `读不了：${error?.message ?? error}` })
      return
    }

    // Each directory adds its own `.gitignore` to the rules it inherited, so a nested
    // file overrides the one above it.
    const rules = inheritedRules.concat(loadGitignoreRules(current, relative(root, current)))

    for (const entry of entries) {
      if (truncated) return
      const abs = path.join(current, entry.name)
      const rel = relative(root, abs)

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        // `.github` holds workflows and is legitimately part of a repo; every other
        // dot-directory is tooling or VCS state that should not be published.
        if (entry.name !== '.github' && entry.name.startsWith('.')) continue
        // Git never re-includes anything under an excluded directory, so this prunes
        // the subtree rather than descending into it — which is exactly what makes
        // `data/*` + `!data/.gitkeep` behave.
        if (isIgnored(rules, rel, true)) {
          skipped.push({ path: rel, reason: GITIGNORE_SKIP_REASON })
          continue
        }
        walk(abs, rules)
        continue
      }

      if (!entry.isFile()) continue // symlinks are not followed: a repo stores content
      if (SKIP_FILES.has(entry.name)) continue
      if (SKIP_SUFFIXES.some(s => entry.name.endsWith(s))) continue
      // The author's exclusion, as opposed to our hard-coded ones. Checked before the
      // ceilings so excluded runtime files cannot eat the file budget.
      if (isIgnored(rules, rel, false)) {
        skipped.push({ path: rel, reason: GITIGNORE_SKIP_REASON })
        continue
      }

      let size = 0
      try {
        size = fs.statSync(abs).size
      } catch (error) {
        skipped.push({ path: rel, reason: `读不了：${error?.message ?? error}` })
        continue
      }

      if (size > config.maxFileBytes) {
        skipped.push({ path: rel, reason: `单文件超过 ${mb(config.maxFileBytes)}` })
        continue
      }
      if (files.length >= config.maxFiles) {
        skipped.push({ path: rel, reason: `文件数超过 ${config.maxFiles} 个` })
        truncated = true
        return
      }
      if (totalBytes + size > config.maxTotalBytes) {
        skipped.push({ path: rel, reason: `总大小超过 ${mb(config.maxTotalBytes)}` })
        truncated = true
        return
      }

      totalBytes += size
      files.push({ path: rel, abs, size })
    }
  }

  walk(root, [])

  return {
    ok: true,
    root,
    files,
    skipped,
    stats: {
      files: files.length,
      bytes: totalBytes,
      truncated,
      skipped: skipped.length,
      topLevel: topLevelSummary(root, files),
    },
  }
}

/** The directories/files at the repo root, for the "you are about to upload" view. */
function topLevelSummary(root, files) {
  const names = new Set()
  for (const file of files) {
    const first = file.path.split('/')[0]
    names.add(file.path.includes('/') ? `${first}/` : first)
  }
  return [...names].sort().slice(0, 20)
}

function relative(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/')
}

function mb(bytes) {
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

function emptyStats() {
  return { files: 0, bytes: 0, truncated: false, skipped: 0, topLevel: [] }
}

/** Hint the author can act on, based on what was skipped. */
export function skippedSummary(skipped) {
  if (skipped.length === 0) return null
  const byReason = new Map()
  for (const s of skipped) {
    const key = s.reason.replace(/[：:].*$/, '')
    byReason.set(key, (byReason.get(key) ?? 0) + 1)
  }
  return [...byReason.entries()].map(([reason, count]) => `${reason}（${count} 个）`)
}

/**
 * Scan the files about to be published for details that are true of *this machine*
 * and of nobody else.
 *
 * A plugin README is written on one computer and read on thousands, so an install
 * path or a "on this machine there are 267 apps" note is both useless to a reader and
 * a small privacy leak (`C:\Users\<your name>` is a real name more often than not).
 * This does not block an upload — some of it is legitimate, like a local clone path in
 * a developer note — it reports what it found so the author can decide.
 *
 * Only text files are scanned, and only the first `maxBytes` of each.
 */
export function scanForPrivateDetails(files, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 256 * 1024
  const homeDir = options.homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? ''
  const userName = homeDir ? path.basename(homeDir) : ''
  const textExtensions = new Set([
    '.md', '.txt', '.json', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts',
    '.jsx', '.tsx', '.html', '.css', '.sh', '.ps1', '.bat',
  ])

  const findings = []

  const add = (file, line, match, kind) => {
    findings.push({ path: file.path, line, kind, excerpt: match.slice(0, 120) })
  }

  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase()
    if (!textExtensions.has(ext)) continue

    let text = ''
    try {
      const buffer = fs.readFileSync(file.abs)
      text = buffer.subarray(0, maxBytes).toString('utf8')
    } catch { continue }

    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // A hard-coded home directory. This is the one that leaks a name.
      if (homeDir) {
        const normalised = homeDir.replace(/\\/g, '\\')
        if (line.includes(normalised) || line.includes(homeDir.replace(/\\/g, '/'))) {
          add(file, i + 1, line, 'home-path')
          continue
        }
        const usersPath = /[A-Za-z]:\\Users\\([^\\/:*?"<>|\s]+)/.exec(line)
        if (usersPath && userName && usersPath[1].toLowerCase() === userName.toLowerCase()) {
          add(file, i + 1, line, 'home-path')
          continue
        }
      }

      // Other absolute Windows paths — machine-specific even without a user name.
      // A drive-letter path is distinctive enough on its own; requiring a well-known
      // top-level folder missed things like `D:\work\my-plugin`.
      if (/(?:^|[^A-Za-z0-9])[A-Za-z]:\\[A-Za-z0-9_.\- ]/.test(line)) {
        add(file, i + 1, line, 'absolute-path')
        continue
      }

      // "on this machine there are N …" style figures that only hold locally.
      if (/(这台机器|本机|我这边|this machine|on my machine)[^。.\n]{0,20}\d+/i.test(line)) {
        add(file, i + 1, line, 'local-figure')
      }
    }
  }

  const byKind = findings.reduce((acc, f) => {
    acc[f.kind] = (acc[f.kind] ?? 0) + 1
    return acc
  }, {})

  return {
    findings,
    byKind,
    clean: findings.length === 0,
    userName: userName || null,
  }
}
