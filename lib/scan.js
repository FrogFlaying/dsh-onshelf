/**
 * Step ① — scan local directories for DSH plugin candidates.
 *
 * A candidate is a directory that holds a `package.json` declaring `dsh.bundle`.
 * That is the exact manifest `awesome-dsh-plugin` checks, so the scanner reports
 * `dsh.client`-only directories as *near misses* instead of silently dropping
 * them — that is the single most common rejection reason and the user needs to
 * see it at scan time, not at CI time.
 *
 * Pure Node builtins only: this module is imported by tests and by the host half
 * alike, and must never touch a network or a shell.
 *
 * @module lib/scan.js
 */

import fs from 'node:fs'
import path from 'node:path'

/** Directories never worth descending into. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', '__pycache__', '.venv', 'venv',
  '.dsh', '.pnpm-store', 'vendor', 'target',
])

/** How deep below a scan root a plugin may live (monorepo subpackages). */
const DEFAULT_MAX_DEPTH = 4

/**
 * A ceiling on directories visited per scan root.
 *
 * Pointing the scanner at `C:\` should produce a truncated result, not a request
 * that never returns. Reported as `stats.truncated` so the UI can say so.
 */
const DEFAULT_MAX_DIRECTORIES = 20_000

/**
 * Read and parse a JSON file, tolerating a UTF-8 BOM and `//`-free JSONC-ish
 * whitespace. Returns `null` when the file is missing or unparseable.
 */
export function readJsonSafe(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Normalise the many shapes a `repository` field takes into `owner/repo`. */
export function parseRepoSlug(repository) {
  if (!repository) return null
  let url = typeof repository === 'string' ? repository : repository.url
  if (typeof url !== 'string') return null
  url = url.trim()
  if (url === '') return null
  // npm shorthand: "github:owner/repo", "owner/repo"
  const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url)
  if (shorthand) return `${shorthand[1]}/${shorthand[2]}`
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/?].*)?$/i.exec(url)
  if (m) return `${m[1]}/${m[2]}`
  return null
}

/** Extract `owner/repo` (and optional subpackage path) from a GitHub URL. */
export function parseGithubUrl(url) {
  if (typeof url !== 'string') return null
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/[\w.-]+\/(.+?))?\/?(?:[?#].*)?$/i.exec(url.trim())
  if (!m) return null
  return {
    owner: m[1],
    repo: m[2],
    subpath: m[3] ? m[3].replace(/\/+$/, '') : null,
  }
}

/**
 * The entry filename the awesome list expects.
 *
 * Root package:      `<owner>__<repo>.yml`
 * Monorepo subpath:  `<owner>__<repo>--packages-my-plugin.yml`
 *                    (subpath separators become `-`, per contributing.md)
 */
export function entryFileName(slug, subpath = null) {
  const [owner, repo] = String(slug).split('/')
  const base = `${owner}__${repo}`
  if (!subpath) return `${base}.yml`
  return `${base}--${subpath.replace(/^\/+|\/+$/g, '').replace(/\//g, '-')}.yml`
}

/** A `dsh.bundle` is present only when it carries a patch path. */
function describeBundle(dsh) {
  if (!dsh || typeof dsh !== 'object') return null
  const bundle = dsh.bundle
  if (bundle === undefined || bundle === null) return null
  if (bundle === true) return { patch: null, explicit: true }
  if (typeof bundle === 'string') return { patch: bundle, explicit: true }
  if (typeof bundle === 'object') {
    return {
      patch: typeof bundle.patch === 'string' ? bundle.patch : null,
      explicit: true,
    }
  }
  return null
}

function describeClient(dsh) {
  if (!dsh || typeof dsh !== 'object') return null
  const client = dsh.client
  if (!client) return null
  if (typeof client === 'string') return { platform: client }
  return {
    platform: typeof client.platform === 'string' ? client.platform : null,
    inject: Array.isArray(client.inject) ? client.inject : null,
  }
}

/**
 * Inspect one directory as a potential plugin package.
 * Returns `null` when there is no `package.json` at all.
 */
export function inspectPackage(dir) {
  const pkgFile = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgFile)) return null
  const pkg = readJsonSafe(pkgFile)
  if (!pkg || typeof pkg !== 'object') return null

  const bundle = describeBundle(pkg.dsh)
  const client = describeClient(pkg.dsh)
  const patchPath = bundle?.patch ? path.join(dir, bundle.patch) : null

  // A screenshots.json next to package.json is the modern convention.
  let screenshots = null
  const shotsFile = path.join(dir, 'screenshots.json')
  if (fs.existsSync(shotsFile)) {
    const parsed = readJsonSafe(shotsFile)
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.screenshots) ? parsed.screenshots : null)
    if (list) screenshots = { file: shotsFile, paths: list.filter(p => typeof p === 'string') }
  }

  return {
    dir,
    name: typeof pkg.name === 'string' ? pkg.name : path.basename(dir),
    version: typeof pkg.version === 'string' ? pkg.version : null,
    private: pkg.private === true,
    description: typeof pkg.description === 'string' ? pkg.description : '',
    license: typeof pkg.license === 'string' ? pkg.license : null,
    keywords: Array.isArray(pkg.keywords) ? pkg.keywords.filter(k => typeof k === 'string') : [],
    hasBundle: bundle !== null,
    bundlePatch: bundle?.patch ?? null,
    bundlePatchExists: patchPath ? fs.existsSync(patchPath) : false,
    hasClient: client !== null,
    client,
    hasMeta: Boolean(pkg.meta && typeof pkg.meta === 'object'),
    metaTitle: pkg.meta?.title ?? null,
    hasScreenshots: screenshots !== null,
    screenshots,
    hasReadme: ['README.md', 'readme.md', 'README.MD', 'Readme.md'].some(f => fs.existsSync(path.join(dir, f))),
    repository: parseRepoSlug(pkg.repository),
    repositoryRaw: pkg.repository ?? null,
    peerDependencies: pkg.peerDependencies ?? null,
    dependencies: pkg.dependencies ?? null,
    files: Array.isArray(pkg.files) ? pkg.files : null,
    packageJson: pkg,
  }
}

/**
 * Shared scan state and the per-directory step.
 *
 * The synchronous and asynchronous walkers below differ only in how they loop; the
 * work done per directory lives here once, so a rule change cannot drift between
 * the agent tool (sync, small trees) and the settings page (async, big trees).
 */
function createScanState(rootAbs) {
  return {
    root: rootAbs,
    found: [],
    nearMisses: [],
    scanned: [],
    errors: [],
    visited: new Set(),
    seenPackages: new Set(),
    dirsVisited: 0,
    truncated: false,
  }
}

/**
 * Inspect one directory and return the child directories worth descending into.
 * Mutates `state` with anything found. Never throws.
 */
function visitDirectory(state, dir, options) {
  state.dirsVisited++

  const real = realpathOf(dir)
  const key = real.toLowerCase()
  if (state.visited.has(key)) return []
  state.visited.add(key)

  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    state.errors.push(`${dir}: ${error?.message ?? error}`)
    return []
  }

  if (entries.some(e => e.name === 'package.json')) {
    const packageKey = real.toLowerCase()
    if (!state.seenPackages.has(packageKey)) {
      state.seenPackages.add(packageKey)
      state.scanned.push(real)
      const info = inspectPackage(real)
      if (info) {
        // Report where the source actually lives, and whether it was reached
        // through an install directory rather than the author's own folder.
        info.dir = real
        info.linked = real !== path.resolve(dir)
        info.installed = isInsideNodeModules(real)
        if (info.hasBundle) state.found.push(info)
        else if (info.hasClient || info.name.startsWith('dsh-') || info.keywords.includes('dsh-plugin')) {
          state.nearMisses.push(info)
        }
      }
    }
    // A package boundary is still walked into: monorepos nest packages.
  }

  const children = []
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    if (entry.name.startsWith('.') && entry.name !== '.dsh-plugin') continue
    const child = path.join(dir, entry.name)
    // A plain directory is answered by the Dirent; only a link needs a stat, which
    // keeps one syscall per *link* instead of one per entry.
    if (entry.isDirectory()) {
      children.push(child)
      continue
    }
    if (!entry.isSymbolicLink()) continue
    if (isDirectoryFollowingLinks(child)) children.push(child)
  }
  return children
}

function finalise(state, options) {
  // Local plugins first, then everything reached through an install directory:
  // the author wants their own work at the top of the list.
  const ordering = (a, b) => Number(a.installed) - Number(b.installed) || a.name.localeCompare(b.name)
  return {
    root: state.root,
    ok: true,
    found: state.found.sort(ordering),
    nearMisses: state.nearMisses.sort(ordering),
    scanned: state.scanned,
    errors: state.errors,
    stats: {
      dirsVisited: state.dirsVisited,
      truncated: state.truncated,
      packages: state.scanned.length,
    },
  }
}

function realpathOf(dir) {
  try { return fs.realpathSync.native(dir) } catch { return dir }
}

function maxDirectoriesOf(options) {
  const n = Number(options.maxDirectories)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_DIRECTORIES
}

/**
 * Walk `root` looking for plugin packages.
 *
 * `found` holds real candidates (declares `dsh.bundle`); `nearMisses` holds
 * packages that look like DSH plugins but declare only `dsh.client` — the exact
 * shape CI rejects, surfaced early on purpose.
 *
 * **Junctions and symlinks are followed.** A locally developed plugin is normally
 * installed with `link:`, which pnpm turns into a junction on Windows and a symlink
 * elsewhere. `readdirSync` reports those as `isSymbolicLink() === true` and
 * `isDirectory() === false`, so only looking at `isDirectory()` silently hides
 * exactly the plugins the author wants to publish. Linked entries are resolved to
 * their real path, because that is the directory the author edits and pushes from.
 */
export function scanForPlugins(root, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? Number(options.maxDepth) : DEFAULT_MAX_DEPTH
  const cap = maxDirectoriesOf(options)
  const rootAbs = path.resolve(root)

  if (!fs.existsSync(rootAbs)) {
    return {
      root: rootAbs, ok: false, found: [], nearMisses: [], scanned: [],
      errors: [`路径不存在：${rootAbs}`],
      stats: { dirsVisited: 0, truncated: false, packages: 0 },
    }
  }

  const state = createScanState(rootAbs)
  const stack = [{ dir: rootAbs, depth: 0 }]
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()
    if (depth > maxDepth) continue
    if (state.dirsVisited >= cap) { state.truncated = true; break }
    const children = visitDirectory(state, dir, options)
    options.onProgress?.(progressOf(state, dir, cap))
    for (const child of children) stack.push({ dir: child, depth: depth + 1 })
  }
  return finalise(state, options)
}

/**
 * The same walk, but it yields to the event loop periodically.
 *
 * A settings page must not freeze the host while a large root is scanned: the same
 * process answers every other request, including the one that would report
 * progress. Yield every `yieldEvery` directories (default 64).
 */
export async function scanForPluginsAsync(root, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? Number(options.maxDepth) : DEFAULT_MAX_DEPTH
  const cap = maxDirectoriesOf(options)
  const yieldEvery = Number.isFinite(options.yieldEvery) && options.yieldEvery > 0 ? options.yieldEvery : 64
  const rootAbs = path.resolve(root)

  if (!fs.existsSync(rootAbs)) {
    return {
      root: rootAbs, ok: false, found: [], nearMisses: [], scanned: [],
      errors: [`路径不存在：${rootAbs}`],
      stats: { dirsVisited: 0, truncated: false, packages: 0 },
    }
  }

  const state = createScanState(rootAbs)
  const stack = [{ dir: rootAbs, depth: 0 }]
  let sinceYield = 0
  while (stack.length > 0) {
    if (options.shouldStop?.() === true) { state.truncated = true; break }
    const { dir, depth } = stack.pop()
    if (depth > maxDepth) continue
    if (state.dirsVisited >= cap) { state.truncated = true; break }
    const children = visitDirectory(state, dir, options)
    options.onProgress?.(progressOf(state, dir, cap))
    for (const child of children) stack.push({ dir: child, depth: depth + 1 })
    if (++sinceYield >= yieldEvery) {
      sinceYield = 0
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  return finalise(state, options)
}

function progressOf(state, dir, cap) {
  return {
    dirsVisited: state.dirsVisited,
    packages: state.scanned.length,
    found: state.found.length,
    nearMisses: state.nearMisses.length,
    errors: state.errors.length,
    cap,
    truncated: state.truncated,
    current: dir,
  }
}

/** `statSync` follows links, so this is true for a junction pointing at a dir. */
function isDirectoryFollowingLinks(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false // broken link, permission denial, ENOENT — all "don't descend"
  }
}

/** Whether a real path sits inside an install directory. */
function isInsideNodeModules(dir) {
  return /[\\/]node_modules[\\/]/i.test(`${dir}${path.sep}`)
}

/**
 * Default scan roots.
 *
 * The first version guessed `~/.dsh/profiles/<name>`, which is where *installed*
 * plugins live — so the list was full of other people's marketplace plugins and
 * none of the author's own. That was the wrong question: you can only submit a
 * plugin you own, and that lives in the author's own folder.
 *
 * So the defaults are: the directories the user configured, else the folder that
 * contains this plugin (local plugins are habitually kept as siblings), else the
 * working directory. Anything inside the DSH home is never offered, because
 * installed plugins are not the user's to publish.
 */
export function defaultScanRoots({ workspace, dshHome, extra = [], pluginDir } = {}) {
  const home = path.resolve(dshHome ?? path.join(process.env.USERPROFILE ?? '.', '.dsh'))
  const roots = []
  const push = dir => {
    if (!dir) return
    const abs = path.resolve(dir)
    if (isInside(abs, home)) return
    if (roots.some(r => r.toLowerCase() === abs.toLowerCase())) return
    try {
      if (!fs.statSync(abs).isDirectory()) return
    } catch { return }
    roots.push(abs)
  }

  for (const dir of extra) push(dir)

  // A workspace that resolves into the DSH home is the profile directory, not the
  // user's project — it is useless as a scan root and actively misleading.
  push(workspace)
  if (workspace) push(path.dirname(path.resolve(workspace)))

  // The folder holding this plugin is the strongest available hint on a machine
  // where local plugins are developed side by side.
  if (pluginDir) push(path.dirname(path.resolve(pluginDir)))

  if (roots.length === 0) push(process.cwd())

  return roots
}

/** Whether `child` is inside `parent`. */
function isInside(child, parent) {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}
