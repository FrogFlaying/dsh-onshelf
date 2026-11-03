/**
 * "Put my code on GitHub" — collection rules, repo creation, root commits.
 *
 * The reported gap: the wizard told the author to create a repo and push the code
 * themselves. That is exactly the step a beginner cannot do, and the whole premise
 * of this plugin is that they should not have to.
 *
 * Run: node test/publish.test.mjs
 *
 * @module test/publish.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { collectFiles, skippedSummary, scanForPrivateDetails } from '../lib/upload.js'
import { GITIGNORE_SKIP_REASON } from '../lib/gitignore.js'
import {
  createClient, inspectTargetRepo, createRepo, pushFiles,
} from '../lib/github.js'

let passed = 0
let failed = 0
async function test(label, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL ${label}`)
    console.error(`       ${error.message}`)
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onshelf-publish-'))

function writeTree(base, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(base, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return base
}

/* ─────────────────────────── collectFiles ─────────────────────────── */

console.log('collecting files')
const plugin = writeTree(path.join(root, 'plugin'), {
  'package.json': '{"name":"dsh-x"}',
  'index.js': 'export const name = "x"',
  'cordis.patch.yml': '- insert: []\n',
  'README.md': '# x',
  'assets/shot.png': 'png-bytes',
  'lib/helper.js': 'export const y = 1',
  '.github/workflows/ci.yml': 'on: push',
  '.git/config': 'should be ignored',
  'node_modules/dep/index.js': 'should be ignored',
  '.onshelf-backup': 'backup',
  'package.json.onshelf-backup': 'backup',
  'debug.log': 'log',
  '.DS_Store': 'junk',
})

await test('includes source, config, docs and assets', () => {
  const result = collectFiles(plugin)
  const paths = result.files.map(f => f.path).sort()
  for (const wanted of ['package.json', 'index.js', 'cordis.patch.yml', 'README.md', 'assets/shot.png', 'lib/helper.js']) {
    assert.ok(paths.includes(wanted), `missing ${wanted} in ${paths.join(', ')}`)
  }
})

await test('never includes node_modules, .git, backups or OS junk', () => {
  const result = collectFiles(plugin)
  const paths = result.files.map(f => f.path)
  for (const bad of paths) {
    assert.ok(!bad.startsWith('node_modules/'), `uploaded ${bad}`)
    assert.ok(!bad.startsWith('.git/'), `uploaded ${bad}`)
    assert.ok(!bad.endsWith('.onshelf-backup'), `uploaded ${bad}`)
    assert.ok(!bad.endsWith('.log'), `uploaded ${bad}`)
    assert.ok(!bad.includes('.DS_Store'), `uploaded ${bad}`)
  }
})

await test('keeps .github workflows', () => {
  const result = collectFiles(plugin)
  assert.ok(result.files.some(f => f.path === '.github/workflows/ci.yml'))
})

await test('reports a summary the author can read before uploading', () => {
  const result = collectFiles(plugin)
  assert.ok(result.stats.files > 0)
  assert.ok(Array.isArray(result.stats.topLevel))
  assert.ok(result.stats.topLevel.includes('assets/'))
  assert.equal(result.stats.truncated, false)
})

await test('a per-file size limit skips the big one and says why', () => {
  const big = writeTree(path.join(root, 'big'), {
    'a.js': 'x',
    'movie.bin': Buffer.alloc(2048, 1),
  })
  const result = collectFiles(big, { maxFileBytes: 1024 })
  assert.ok(!result.files.some(f => f.path === 'movie.bin'))
  assert.ok(result.skipped.some(s => s.path === 'movie.bin'))
  assert.ok(skippedSummary(result.skipped).length > 0)
})

await test('the file-count ceiling stops the walk instead of uploading everything', () => {
  const many = path.join(root, 'many')
  for (let i = 0; i < 30; i++) writeTree(many, { [`f${i}.js`]: 'x' })
  const result = collectFiles(many, { maxFiles: 10 })
  assert.ok(result.files.length <= 10)
  assert.equal(result.stats.truncated, true)
})

await test('an empty directory is a readable error, not a crash', () => {
  const empty = path.join(root, 'empty')
  fs.mkdirSync(empty, { recursive: true })
  const result = collectFiles(empty)
  assert.equal(result.ok, true)
  assert.equal(result.files.length, 0)
})

await test('a missing directory reports an error', () => {
  const result = collectFiles(path.join(root, 'nope'))
  assert.equal(result.ok, false)
  assert.match(result.error, /目录不存在/)
})

/* ─────────────────── the author's own .gitignore ───────────────────
 *
 * The wizard used to decide what to skip from a hard-coded list alone, so a plugin
 * that writes runtime files — and says so in `.gitignore`, in its author's own words
 * — had those files pushed anyway. A real submission collected 144 desktop snapshots
 * (7 MB of window titles, user names and folder paths) for a public repo while the
 * plugin's `.gitignore` began with "never commit them".
 */

console.log("respecting the author's .gitignore")

const ignoredPlugin = writeTree(path.join(root, 'gitignored'), {
  'package.json': '{"name":"dsh-y"}',
  'index.js': 'export const y = 2',
  'README.md': '# y',
  '.gitignore': [
    'data/*',
    '!data/.gitkeep',
    '',
    'build/',
    '*.local.json',
    '/root-only.txt',
    '**/logs',
    '',
  ].join('\n'),
  'data/.gitkeep': '',
  'data/snapshot-20261023-091319-interval.json': '{"host":{"user":"someone","computer":"DESKTOP-X"}}',
  'config/deskresume.json': '{}',
  'config/deskresume.local.json': '{"intervalSeconds":60}',
  'build/bundle.js': 'compiled',
  'build/nested/deep.js': 'compiled',
  'root-only.txt': 'at the root',
  'sub/root-only.txt': 'not at the root',
  'sub/logs': 'a file whose name matches the directory pattern',
  'logs/keep.txt': 'inside an excluded directory',
})

await test('a file the author excluded is not uploaded', () => {
  const paths = collectFiles(ignoredPlugin).files.map(f => f.path)
  assert.ok(!paths.includes('data/snapshot-20261023-091319-interval.json'), paths.join(', '))
})

await test('a negated pattern puts back the file the repo needs', () => {
  // `data/*` excludes the directory's contents and `!data/.gitkeep` re-includes the
  // placeholder — which only works because the directory itself is not excluded.
  const paths = collectFiles(ignoredPlugin).files.map(f => f.path)
  assert.ok(paths.includes('data/.gitkeep'), paths.join(', '))
})

await test('.gitignore itself is still uploaded', () => {
  const paths = collectFiles(ignoredPlugin).files.map(f => f.path)
  assert.ok(paths.includes('.gitignore'), paths.join(', '))
})

await test('a bare name matches at any depth, an anchored one only at the root', () => {
  const paths = collectFiles(ignoredPlugin).files.map(f => f.path)
  assert.ok(!paths.includes('config/deskresume.local.json'), paths.join(', '))
  assert.ok(paths.includes('config/deskresume.json'), paths.join(', '))
  assert.ok(!paths.includes('root-only.txt'), paths.join(', '))
  assert.ok(paths.includes('sub/root-only.txt'), paths.join(', '))
})

await test('an excluded directory is not descended into, exactly like git', () => {
  const paths = collectFiles(ignoredPlugin).files.map(f => f.path)
  assert.ok(!paths.some(p => p.startsWith('build/')), paths.join(', '))
})

await test('"**" reaches a directory at any depth, and a file of the same name', () => {
  const paths = collectFiles(ignoredPlugin).files.map(f => f.path)
  assert.ok(!paths.some(p => p.startsWith('logs/')), paths.join(', '))
  assert.ok(!paths.includes('sub/logs'), paths.join(', '))
})

await test('the exclusions are reported, grouped into one readable line', () => {
  const result = collectFiles(ignoredPlugin)
  const ignored = result.skipped.filter(s => s.reason === GITIGNORE_SKIP_REASON)
  assert.ok(ignored.length >= 5, JSON.stringify(result.skipped))
  const summary = skippedSummary(result.skipped)
  assert.ok(summary.some(line => line.includes('.gitignore')), summary.join(' | '))
})

await test('excluded files do not count against the file ceiling', () => {
  const rotating = path.join(root, 'rotating')
  writeTree(rotating, {
    '.gitignore': 'data/*\n!data/.gitkeep\n',
    'data/.gitkeep': '',
    'index.js': 'export const z = 3',
  })
  for (let i = 0; i < 20; i++) {
    writeTree(rotating, { [`data/snapshot-${i}-interval.json`]: '{"host":{"user":"someone"}}' })
  }
  const result = collectFiles(rotating, { maxFiles: 5 })
  assert.equal(result.stats.truncated, false, 'excluded files must not exhaust the budget')
  assert.equal(result.files.length, 3, result.files.map(f => f.path).join(', '))
})

await test("DeskResume's real .gitignore keeps the repo and drops the snapshots", () => {
  // The exact file that produced the 190-file / 7 MB plan in the report.
  const real = path.join(root, 'deskresume')
  writeTree(real, {
    'package.json': '{"name":"dsh-deskresume"}',
    'index.js': 'export const name = "dsh-deskresume"',
    '.gitignore': [
      '# Snapshots contain the real window titles, command lines and folder paths.',
      '# They are observations of a private desktop, not source code: never commit them.',
      '# (data/* rather than data/ - an excluded directory would also exclude the',
      '#  .gitkeep re-include below.)',
      'data/*',
      '!data/.gitkeep',
      '',
      '# Local overrides of the shipped defaults in config/deskresume.json.',
      'config/deskresume.local.json',
      '',
      '# Runtime artefacts',
      '*.tmp',
      '*.log',
      'node_modules/',
      '.dr-state/',
    ].join('\n') + '\n',
    'data/.gitkeep': '',
    'config/deskresume.json': '{"intervalSeconds":600}',
    'config/deskresume.local.json': '{"intervalSeconds":60}',
    'lib/snapshot.js': 'export const x = 1',
    'docs/capability-report.md': '# report',
  })
  for (let i = 0; i < 5; i++) {
    writeTree(real, {
      [`data/snapshot-2026102${i}-120319-interval.json`]: '{"host":{"user":"someone","computer":"DESKTOP-X"}}',
    })
  }

  const result = collectFiles(real)
  const paths = result.files.map(f => f.path)
  assert.ok(!paths.some(p => p.startsWith('data/snapshot-')), 'a snapshot reached the repo')
  assert.ok(!paths.includes('config/deskresume.local.json'), 'a local override reached the repo')
  assert.ok(paths.includes('data/.gitkeep'), '.gitkeep keeps the runtime directory in the tree')
  assert.ok(paths.includes('package.json') && paths.includes('lib/snapshot.js'), paths.join(', '))
})

/* ─────────────────────────── private details ───────────────────────────
 *
 * A README written on one machine is read on thousands: an install path or
 * "on this machine there are 267 apps" is useless to a reader and leaks the author's
 * user name. The wizard reports it before anything is pushed.
 */

console.log('private details in the files to be published')

const privDir = path.join(root, 'privacy')
const userName = path.basename(os.userInfo().homedir)
fs.mkdirSync(privDir, { recursive: true })
fs.writeFileSync(path.join(privDir, 'README.md'), [
  '# demo plugin',
  '',
  '它通过 shell:AppsFolder 枚举全部程序（这台机器上是 267 个）。',
  '安装：dsh plugin add "D:\\work\\my-plugin"',
  `测试：$node = 'C:\\Users\\${userName}\\.dsh\\node.exe'`,
  '',
  '干净的一行：node test-scan.mjs 就能跑。',
].join('\n'))
fs.writeFileSync(path.join(privDir, 'package.json'), '{"name":"demo"}')
fs.writeFileSync(path.join(privDir, 'logo.png'), Buffer.from('89504e470d0a1a0a', 'hex'))

await test('a home directory in the text is reported as a privacy finding', () => {
  const collected = collectFiles(privDir)
  const result = scanForPrivateDetails(collected.files, { homeDir: os.userInfo().homedir })
  assert.ok(
    result.findings.some(f => f.kind === 'home-path'),
    `expected a home-path finding, got ${JSON.stringify(result.byKind)}`,
  )
})

await test('a hard-coded absolute path is reported even without a user name', () => {
  const collected = collectFiles(privDir)
  const result = scanForPrivateDetails(collected.files)
  assert.ok(result.findings.some(f => f.kind === 'absolute-path'), JSON.stringify(result.byKind))
})

await test('a "this machine has N …" figure is reported', () => {
  const collected = collectFiles(privDir)
  const result = scanForPrivateDetails(collected.files)
  assert.ok(result.findings.some(f => f.kind === 'local-figure'), JSON.stringify(result.byKind))
})

await test('a normal line is not flagged', () => {
  const collected = collectFiles(privDir)
  const result = scanForPrivateDetails(collected.files)
  assert.ok(!result.findings.some(f => /node test-scan\.mjs/.test(f.excerpt)), 'a plain command was flagged')
})

await test('binary files are skipped instead of being scanned as text', () => {
  const collected = collectFiles(privDir)
  const result = scanForPrivateDetails(collected.files)
  assert.ok(!result.findings.some(f => f.path === 'logo.png'))
})

await test('a clean plugin reports clean', () => {
  const cleanDir = path.join(root, 'clean-plugin')
  fs.mkdirSync(cleanDir, { recursive: true })
  fs.writeFileSync(path.join(cleanDir, 'README.md'), '# ok\n\nInstall with dsh plugin add github:me/repo.\n')
  const collected = collectFiles(cleanDir)
  const result = scanForPrivateDetails(collected.files)
  assert.equal(result.clean, true, JSON.stringify(result.findings))
})

/* ─────────────────────────── github side ─────────────────────────── */

/**
 * Fake GitHub focused on repo creation and Git Data writes. It models both an empty
 * repo (no refs) and a repo with history, because that difference is the bug the
 * naive implementation hits.
 */
function fakeGithub({ login = 'alice', repoExists = false, repoEmpty = true } = {}) {
  const calls = []
  const state = {
    login,
    repoExists,
    repoEmpty,
    blobs: [],
    trees: [],
    commits: [],
    refs: new Map(),
    created: null,
  }

  const json = (data, status = 200, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    text: async () => (data === null ? '' : JSON.stringify(data)),
    json: async () => data,
  })

  const fetch = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const { pathname } = new URL(url)
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path: pathname, body })

    if (pathname === '/user') return json({ login: state.login, name: 'Alice', avatar_url: '' })

    if (pathname === '/user/repos' && method === 'POST') {
      state.repoExists = true
      state.repoEmpty = true
      state.created = body
      return json({ name: body.name, owner: { login: state.login }, private: body.private, default_branch: 'main', html_url: `https://github.com/${state.login}/${body.name}` }, 201)
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(pathname)
    if (repoMatch && method === 'GET') {
      if (!state.repoExists) return json({ message: 'Not Found' }, 404)
      return json({
        full_name: `${repoMatch[1]}/${repoMatch[2]}`,
        private: false,
        default_branch: 'main',
        html_url: `https://github.com/${repoMatch[1]}/${repoMatch[2]}`,
        size: state.repoEmpty ? 0 : 12,
      })
    }

    const refMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/.exec(pathname)
    if (refMatch && method === 'GET') {
      if (state.repoEmpty) return json({ message: 'Git Repository is empty.' }, 409)
      // After seeding, the branch points at the seeding commit.
      return json({ object: { sha: state.seedSha ?? 'basesha' } })
    }

    // The Contents API is the only door into an empty repository: it commits for you.
    const contentsPut = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(pathname)
    if (contentsPut && method === 'PUT') {
      state.seeded = body
      state.seededPath = decodeURIComponent(contentsPut[3])
      state.repoEmpty = false
      state.seedSha = 'seedsha'
      state.refs.set(`refs/heads/${body.branch ?? 'main'}`, 'seedsha')
      return json({
        content: { sha: 'seedblob' },
        commit: { sha: 'seedsha', html_url: 'https://github.com/a/b/commit/seed' },
      }, 201)
    }

    if (/\/git\/blobs$/.test(pathname) && method === 'POST') {
      state.blobs.push(body)
      return json({ sha: `blob-${state.blobs.length}` }, 201)
    }

    if (/\/git\/trees$/.test(pathname) && method === 'POST') {
      state.trees.push(body)
      return json({ sha: 'newtree' }, 201)
    }

    if (/\/git\/commits\/.+$/.test(pathname) && method === 'GET') {
      return json({ sha: 'basesha', tree: { sha: 'basetree' } })
    }

    if (/\/git\/commits$/.test(pathname) && method === 'POST') {
      state.commits.push(body)
      return json({ sha: `commit-${state.commits.length}`, html_url: 'https://github.com/a/b/commit/x' }, 201)
    }

    if (/\/git\/refs$/.test(pathname) && method === 'POST') {
      state.refs.set(body.ref, body.sha)
      return json({ ref: body.ref, object: { sha: body.sha } }, 201)
    }

    if (/\/git\/refs\/heads\//.test(pathname) && method === 'PATCH') {
      return json({ object: { sha: body.sha } })
    }

    return json({ message: `unhandled ${method} ${pathname}` }, 500)
  }

  return { fetch, calls, state }
}

const files = [
  { path: 'package.json', base64: Buffer.from('{"name":"dsh-x"}').toString('base64') },
  { path: 'index.js', base64: Buffer.from('export const name = "x"').toString('base64') },
]

console.log('creating and pushing')
await test('inspectTargetRepo reports a missing repo', async () => {
  const fake = fakeGithub({ repoExists: false })
  const client = createClient('t', { fetch: fake.fetch })
  const info = await inspectTargetRepo(client, 'alice', 'dsh-x')
  assert.equal(info.ok, true)
  assert.equal(info.exists, false)
})

await test('inspectTargetRepo detects an existing but empty repo', async () => {
  const fake = fakeGithub({ repoExists: true, repoEmpty: true })
  const client = createClient('t', { fetch: fake.fetch })
  const info = await inspectTargetRepo(client, 'alice', 'dsh-x')
  assert.equal(info.exists, true)
  assert.equal(info.empty, true, 'a repo with no commits is empty')
})

await test('inspecting a repo with history reports its branch', async () => {
  const fake = fakeGithub({ repoExists: true, repoEmpty: false })
  const client = createClient('t', { fetch: fake.fetch })
  const info = await inspectTargetRepo(client, 'alice', 'dsh-x')
  assert.equal(info.empty, false)
  assert.equal(info.defaultBranch, 'main')
  assert.equal(info.defaultBranchRef, 'basesha')
})

await test('createRepo asks for a repo with no README', async () => {
  const fake = fakeGithub({ repoExists: false })
  const client = createClient('t', { fetch: fake.fetch })
  const created = await createRepo(client, { name: 'dsh-x', private: false, description: 'x' })
  assert.equal(created.ok, true, created.error)
  assert.equal(fake.state.created.name, 'dsh-x')
  assert.equal(fake.state.created.private, false)
  assert.equal(fake.state.created.auto_init, false, 'auto_init would turn the first push into a merge')
})

await test('createRepo explains an already-existing name', async () => {
  const fake = fakeGithub({ repoExists: false })
  const client = createClient('t', {
    fetch: async (url, init) => {
      if (String(url).endsWith('/user/repos')) {
        return {
          ok: false, status: 422,
          headers: { get: () => null },
          text: async () => JSON.stringify({ message: 'Repository creation failed. name already exists on this account' }),
        }
      }
      return fake.fetch(url, init)
    },
  })
  const created = await createRepo(client, { name: 'dsh-x' })
  assert.equal(created.ok, false)
  assert.equal(created.alreadyExists, true)
})

await test('an empty repo is seeded through the Contents API, then the rest follow', async () => {
  // Git-data endpoints answer 409 until the repo has one commit, so blobs cannot be
  // the first thing we try. The Contents API commits the first file and creates the
  // branch; only then does the blob/tree path work.
  const fake = fakeGithub({ repoExists: true, repoEmpty: true })
  const client = createClient('t', { fetch: fake.fetch })
  const result = await pushFiles(client, 'alice', 'dsh-x', { message: 'init', files })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.root, true)
  assert.equal(result.seededViaContentsApi, true)
  assert.ok(fake.state.seeded, 'the Contents API must be used for the first commit')
  assert.equal(fake.state.seeded.path ?? undefined, undefined)
  assert.ok(fake.state.seeded.message, 'the seeding commit needs a message')
  assert.ok(fake.state.refs.has('refs/heads/main'), 'the branch must exist after seeding')
  // One file created the commit; the rest went through blobs.
  assert.equal(fake.state.blobs.length, files.length - 1)
  // The follow-up commit parents onto the seeded commit, never onto null.
  assert.equal(fake.state.commits.length, 1)
  assert.deepEqual(fake.state.commits[0].parents, ['seedsha'])
})

await test('pushing into a repo with history requires explicit permission', async () => {
  const fake = fakeGithub({ repoExists: true, repoEmpty: false })
  const client = createClient('t', { fetch: fake.fetch })
  const result = await pushFiles(client, 'alice', 'dsh-x', { message: 'init', files })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'repo-not-empty')
  assert.equal(fake.state.commits.length, 0, 'nothing may be written without permission')
})

await test('with permission it commits onto the existing tree', async () => {
  const fake = fakeGithub({ repoExists: true, repoEmpty: false })
  const client = createClient('t', { fetch: fake.fetch })
  const result = await pushFiles(client, 'alice', 'dsh-x', { message: 'update', files, allowOverwrite: true })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.root, false)
  assert.equal(fake.state.commits[0].parents[0], 'basesha')
  assert.equal(fake.state.trees[0].base_tree, 'basetree')
})

/* ── the empty-repository bug, pinned ──
 *
 * GitHub answers **409 "Git Repository is empty"** from git-data endpoints on a repo
 * with no commits — not 404. Treating only 404 as empty made a brand-new repo look
 * like it had history, which produced a bogus overwrite prompt and a commit whose
 * parent was `null`. A real user hit exactly this: their repo stayed empty and the
 * UI said nothing.
 */

/** A fake that behaves like GitHub on a never-pushed repo: git-data calls → 409. */
function fakeGithub409() {
  const state = { blobs: 0, commits: [], refs: [], tree: null, seeded: null, empty: true }
  const json = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
    json: async () => data,
  })
  const fetch = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const { pathname } = new URL(url)
    const body = init.body ? JSON.parse(init.body) : undefined

    if (/^\/repos\/[^/]+\/[^/]+$/.test(pathname) && method === 'GET') {
      return json({ full_name: 'alice/dsh-x', private: false, default_branch: 'main', size: state.empty ? 0 : 8 })
    }
    // The Contents API is the only door in while the repo is empty.
    if (/\/contents\//.test(pathname) && method === 'PUT') {
      state.seeded = body
      state.empty = false
      return json({ commit: { sha: 'seedsha', html_url: 'https://x/commit/seed' } }, 201)
    }
    if (/\/git\//.test(pathname) && state.empty) {
      // This is the exact shape that broke it, for every git-data endpoint.
      return json({ message: 'Git Repository is empty.' }, 409)
    }
    if (/\/git\/ref\/heads\//.test(pathname) && method === 'GET') {
      return json({ object: { sha: 'seedsha' } })
    }
    if (/\/git\/commits\/.+$/.test(pathname) && method === 'GET') {
      return json({ sha: 'seedsha', tree: { sha: 'seedtree' } })
    }
    if (/\/git\/blobs$/.test(pathname)) { state.blobs++; return json({ sha: `b${state.blobs}` }, 201) }
    if (/\/git\/trees$/.test(pathname)) { state.tree = body; return json({ sha: 'tree' }, 201) }
    if (/\/git\/commits$/.test(pathname)) { state.commits.push(body); return json({ sha: 'commit' }, 201) }
    if (/\/git\/refs$/.test(pathname) && method === 'POST') { state.refs.push(body); return json({ ref: body.ref }, 201) }
    if (/\/git\/refs\/heads\//.test(pathname) && method === 'PATCH') {
      state.refs.push({ ref: pathname, sha: body.sha })
      return json({ object: { sha: body.sha } })
    }
    return json({ message: `unhandled ${method} ${pathname}` }, 500)
  }
  return { fetch, state }
}

await test('a 409 from the ref endpoint means the repo is EMPTY, not that it has history', async () => {
  const fake = fakeGithub409()
  const client = createClient('t', { fetch: fake.fetch })
  const info = await inspectTargetRepo(client, 'alice', 'dsh-x')
  assert.equal(info.ok, true)
  assert.equal(info.empty, true, '409 "Git Repository is empty" is the empty-repo answer')
  assert.equal(info.defaultBranchRef, null)
})

await test('a brand-new repo with a 409 ref is seeded, not rejected', async () => {
  const fake = fakeGithub409()
  const client = createClient('t', { fetch: fake.fetch })
  const result = await pushFiles(client, 'alice', 'dsh-x', { message: 'init', files })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.root, true)
  assert.ok(fake.state.seeded, 'the first commit must go through the Contents API')
  assert.equal(fake.state.blobs, files.length - 1, 'the remaining files use blobs')
})

await test('a repo reporting zero size with an unusable ref is also treated as empty', async () => {
  // Belt and braces: some error other than 404/409 must not turn a never-pushed repo
  // into "has history".
  const fetch = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const { pathname } = new URL(url)
    const json = (data, status = 200) => ({
      ok: status >= 200 && status < 300, status,
      headers: { get: () => null },
      text: async () => JSON.stringify(data),
      json: async () => data,
    })
    if (/^\/repos\/[^/]+\/[^/]+$/.test(pathname) && method === 'GET') {
      return json({ full_name: 'a/b', private: false, default_branch: 'main', size: 0 })
    }
    if (/\/git\/ref\/heads\//.test(pathname)) return json({ message: 'Server Error' }, 500)
    return json({ message: 'unhandled' }, 500)
  }
  const client = createClient('t', { fetch })
  const info = await inspectTargetRepo(client, 'alice', 'dsh-x')
  assert.equal(info.empty, true)
})

await test('progress is reported once per file', async () => {
  const fake = fakeGithub409()
  const client = createClient('t', { fetch: fake.fetch })
  const seen = []
  await pushFiles(client, 'alice', 'dsh-x', {
    message: 'init',
    files,
    concurrency: 1,
    onProgress: p => seen.push(p),
  })
  const blobTicks = seen.filter(p => p.phase === 'blobs')
  // One tick per file, counting the one that seeds the commit.
  assert.ok(blobTicks.length >= files.length, `expected ${files.length}+ blob ticks, got ${blobTicks.length}`)
  assert.equal(blobTicks[blobTicks.length - 1].done, files.length)
})

await test('a failed blob upload names the file that failed', async () => {
  const fake = fakeGithub({ repoExists: true, repoEmpty: true })
  const client = createClient('t', {
    fetch: async (url, init) => {
      if (String(url).includes('/git/blobs')) {
        return {
          ok: false, status: 422,
          headers: { get: () => null },
          text: async () => JSON.stringify({ message: 'content is too large' }),
        }
      }
      return fake.fetch(url, init)
    },
  })
  const result = await pushFiles(client, 'alice', 'dsh-x', { message: 'init', files })
  assert.equal(result.ok, false)
  assert.ok(result.failedPath, 'the failing path must be reported')
  assert.match(result.error, /too large/)
})

try {
  fs.rmSync(root, { recursive: true, force: true })
} catch { /* temp dir is disposable */ }

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
