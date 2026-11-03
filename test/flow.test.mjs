/**
 * End-to-end tests for steps ①–⑤, using a fake GitHub transport.
 *
 * The GitHub tests never touch the network: `createClient` accepts a `fetch`
 * implementation, and the fake here records every request so the test can assert
 * *what would have been written* — which is the thing worth pinning down.
 *
 * Run: node test/flow.test.mjs
 *
 * @module test/flow.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { scanForPlugins, inspectPackage, entryFileName, parseGithubUrl, parseRepoSlug } from '../lib/scan.js'
import { diagnose, planFixes, applyFixes, undoFixes } from '../lib/check.js'
import {
  buildSubmission, draftDescriptions, inferCategory, readSurface,
  resolveTarget, renderEntryYaml, validateDraft,
} from '../lib/entry.js'
import {
  createClient, whoami, repoFacts, ensureFork, commitFiles, ensurePullRequest,
  planSubmission, executeSubmission, branchNameFor, AWESOME_REPO,
} from '../lib/github.js'
import {
  makeTempRoot, removeTempRoot, writeGoodPlugin, writeClientOnlyPlugin,
  writePeerTrapPlugin, writePlainPackage, writeMonorepo,
} from './fixtures.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.error(`  FAIL ${name}`)
    console.error(`       ${error.message}`)
  }
}

const root = makeTempRoot()

/* ─────────────────────────── ① scan ─────────────────────────── */

console.log('① scan')
await test('finds a package declaring dsh.bundle', () => {
  const dir = writeGoodPlugin(root)
  const result = scanForPlugins(root)
  assert.ok(result.ok)
  assert.ok(result.found.some(p => p.dir === dir), `found: ${result.found.map(p => p.dir)}`)
})

await test('reports a dsh.client-only package as a near miss, not a candidate', () => {
  const dir = writeClientOnlyPlugin(root)
  const result = scanForPlugins(root)
  assert.ok(!result.found.some(p => p.dir === dir))
  assert.ok(result.nearMisses.some(p => p.dir === dir))
})

await test('ignores a plain package that is not a DSH plugin', () => {
  const dir = writePlainPackage(root)
  const result = scanForPlugins(root)
  assert.ok(!result.found.some(p => p.dir === dir))
  assert.ok(!result.nearMisses.some(p => p.dir === dir))
})

await test('descends into a monorepo subpackage', () => {
  const repo = writeMonorepo(root)
  const result = scanForPlugins(repo)
  assert.equal(result.found.length, 1)
  assert.ok(result.found[0].dir.endsWith(path.join('packages', 'my-plugin')))
})

await test('never descends into node_modules', () => {
  const dir = writeGoodPlugin(root)
  const buried = path.join(dir, 'node_modules', 'sneaky')
  fs.mkdirSync(buried, { recursive: true })
  fs.writeFileSync(path.join(buried, 'package.json'), JSON.stringify({
    name: 'sneaky', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  const result = scanForPlugins(dir)
  assert.ok(!result.found.some(p => p.dir === buried))
})

await test('a missing root is an error, not a throw', () => {
  const result = scanForPlugins(path.join(root, 'does-not-exist'))
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 1)
})

await test('parses repository shorthands and GitHub URLs', () => {
  assert.equal(parseRepoSlug('github:alice/repo'), 'alice/repo')
  assert.equal(parseRepoSlug('alice/repo'), 'alice/repo')
  assert.equal(parseRepoSlug({ url: 'git+https://github.com/alice/repo.git' }), 'alice/repo')
  assert.equal(parseRepoSlug('https://gitlab.com/alice/repo'), null)
  const parsed = parseGithubUrl('https://github.com/alice/repo/tree/main/packages/my-plugin')
  assert.equal(parsed.owner, 'alice')
  assert.equal(parsed.repo, 'repo')
  assert.equal(parsed.subpath, 'packages/my-plugin')
})

await test('entry filenames follow the guide, including monorepo subpaths', () => {
  assert.equal(entryFileName('alice/repo'), 'alice__repo.yml')
  assert.equal(entryFileName('alice/repo', 'packages/my-plugin'), 'alice__repo--packages-my-plugin.yml')
})

/* ─────────────────────────── ② check + fix ─────────────────────────── */

console.log('② check and fix')
await test('diagnose reports the missing bundle and plans a fix', () => {
  const dir = writeClientOnlyPlugin(root)
  const result = diagnose(dir, { category: 'ui', descriptionEn: 'A plugin.' })
  assert.ok(result.ok)
  assert.ok(result.summary.blocked)
  const kinds = result.fixPlan.writes.map(w => w.kind)
  assert.ok(kinds.includes('package.json'))
  assert.ok(kinds.includes('cordis.patch.yml'))
})

await test('applying the fix makes the plugin installable, and undo reverts it', () => {
  const dir = writeClientOnlyPlugin(root)
  const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
  const patchFile = path.join(dir, 'cordis.patch.yml')
  assert.equal(fs.existsSync(patchFile), false, 'fixture must not already have a patch file')

  const first = diagnose(dir, { category: 'ui', descriptionEn: 'A plugin.' })
  const applied = applyFixes(first.fixPlan)
  assert.equal(applied.failures.length, 0)

  const pkg = inspectPackage(dir)
  assert.equal(pkg.hasBundle, true)
  assert.equal(pkg.bundlePatchExists, true)

  const after = diagnose(dir, { category: 'ui', descriptionEn: 'A plugin.' })
  assert.ok(!after.findings.some(f => f.id === 'bundle-missing'), 'bundle-missing should be gone')

  // Undo restores the overwritten file and removes the one we created.
  const undo = undoFixes(applied.applied)
  assert.equal(undo.failures.length, 0)
  assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), before)
  assert.equal(fs.existsSync(patchFile), false, 'created patch file should be removed by undo')
})

await test('fixing peer deps moves official packages and repairs the range', () => {
  const dir = writePeerTrapPlugin(root)
  const first = diagnose(dir, { category: 'tools', descriptionEn: 'Uses the harness.' })
  applyFixes(first.fixPlan)
  const pkg = inspectPackage(dir)
  assert.equal(pkg.dependencies, null, 'an emptied dependencies block must be removed, not left as {}')
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-tools'])
  assert.match(pkg.peerDependencies['@deepseek-ai/dsh-client-ui'], /\|\|/)
})

await test('a bad patch shape is rewritten into a top-level array', () => {
  const dir = writeGoodPlugin(root, { name: 'dsh-bad-patch2' })
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), 'insert:\n  - id: x\n')
  const result = diagnose(dir, { category: 'tools', descriptionEn: 'A plugin.' })
  assert.ok(result.findings.some(f => f.id === 'patch-not-array'))
  applyFixes(result.fixPlan)
  const text = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')
  // The first non-comment, non-blank line must open a YAML sequence.
  const firstMeaningful = text.split(/\r?\n/).find(l => l.trim() !== '' && !l.trim().startsWith('#'))
  assert.ok(firstMeaningful.trimStart().startsWith('-'), `got: ${text}`)
  assert.match(text, /\binsert\b/)
})

/* ─────────────────────────── ③ prepare ─────────────────────────── */

console.log('③ prepare')
await test('reads the surface a package actually declares', () => {
  const dir = writeGoodPlugin(root)
  const pkg = inspectPackage(dir)
  const surface = readSurface(pkg)
  assert.deepEqual(surface.tools, ['greet'])
})

await test('drafts a description from real facts only', () => {
  const dir = writeGoodPlugin(root)
  const pkg = inspectPackage(dir)
  const draft = draftDescriptions(pkg)
  assert.match(draft.en, /Greets people by name/)
  assert.match(draft.en, /1 agent tool/)
  assert.match(draft.en, /greet/)
  assert.ok(draft.en.endsWith('.'))
  assert.ok(draft.zh.endsWith('。'))
})

await test('the draft never invents a tool the code does not register', () => {
  const dir = writeClientOnlyPlugin(root)
  const pkg = inspectPackage(dir)
  const draft = draftDescriptions(pkg)
  assert.ok(!/agent tool/.test(draft.en), `unexpected tool claim: ${draft.en}`)
})

await test('infers a category from name and description', () => {
  const dir = writeGoodPlugin(root)
  const pkg = inspectPackage(dir)
  assert.equal(inferCategory(pkg, 'A theme that restyles the sidebar.').category, 'theme')
  assert.equal(inferCategory(pkg, 'Reads token usage and cost.').category, 'usage')
})

await test('renders the entry YAML in the guide order', () => {
  const yaml = renderEntryYaml({
    url: 'https://github.com/alice/repo',
    name: 'alice/repo',
    category: 'tools',
    descriptionEn: 'Greets people by name.',
    descriptionZh: '按名字打招呼。',
  })
  assert.equal(yaml, [
    'url: https://github.com/alice/repo',
    'name: alice/repo',
    'category: tools',
    'description:',
    '  en: Greets people by name.',
    '  zh: 按名字打招呼。',
    '',
  ].join('\n'))
})

await test('a description containing ": " is quoted automatically', () => {
  const yaml = renderEntryYaml({
    url: 'https://github.com/alice/repo',
    name: 'alice/repo',
    category: 'vision',
    descriptionEn: 'Vision toolkit: OCR and pixel diff.',
  })
  assert.match(yaml, /en: 'Vision toolkit: OCR and pixel diff\.'/)
})

await test('resolveTarget handles subpackages and produces the right filename', () => {
  const target = resolveTarget({ repoUrl: 'https://github.com/alice/repo/tree/main/packages/my-plugin' })
  assert.equal(target.ok, true)
  assert.equal(target.subpath, 'packages/my-plugin')
  assert.equal(target.url, 'https://github.com/alice/repo/tree/main/packages/my-plugin')
  assert.equal(target.entryName, 'alice/repo#my-plugin')
  assert.equal(target.entryFile, 'alice__repo--packages-my-plugin.yml')
})

await test('buildSubmission produces a valid bundle for a compliant plugin', () => {
  const dir = writeGoodPlugin(root)
  const pkg = inspectPackage(dir)
  const submission = buildSubmission(pkg, {
    category: 'tools',
    repoUrl: 'https://github.com/alice/dsh-good-plugin',
    descriptionEn: 'Greets people by name from a registered agent tool.',
    descriptionZh: '注册一个按名字打招呼的 agent 工具。',
    screenshots: ['assets/shot-1.png'],
  })
  assert.equal(submission.ok, true, JSON.stringify(submission.validation))
  assert.equal(submission.entryFile, 'alice__dsh-good-plugin.yml')
  assert.match(submission.yaml, /category: tools/)
  assert.ok(submission.prDraft.includes('data/plugins/alice__dsh-good-plugin.yml'))
})

await test('validateDraft blocks marketing and a missing English line', () => {
  const bad = validateDraft({
    url: 'https://github.com/alice/repo',
    name: 'alice/repo',
    category: 'tools',
    descriptionEn: 'A powerful tool',
  })
  assert.equal(bad.ok, false)
  assert.ok(bad.problems.some(p => p.field === 'descriptionEn'))
})

/* ─────────────────────────── ④⑤ github ─────────────────────────── */

console.log('④⑤ github (fake transport)')

/**
 * A minimal fake of the GitHub REST surface this plugin uses. It records every
 * request and answers from an in-memory repo, so the assertions can be about what
 * was written rather than about HTTP.
 */
function fakeGithub(options = {}) {
  const calls = []
  const state = {
    login: options.login ?? 'alice',
    createdAt: options.createdAt ?? new Date(Date.now() - 5 * 86_400_000).toISOString(),
    topics: options.topics ?? ['dsh-plugin'],
    defaultBranch: 'main',
    entryExists: options.entryExists ?? false,
    forks: new Set(options.forks ?? []),
    commits: [],
    prs: [],
    branches: new Map([['main', 'basesha']]),
    blobs: new Map(),
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
    const parsed = new URL(url)
    const pathname = parsed.pathname
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path: pathname, query: parsed.search, body, headers: init.headers })

    if (pathname === '/user') return json({ login: state.login, name: 'Alice', avatar_url: '' }, 200, { 'x-oauth-scopes': 'repo' })

    // /repos/{owner}/{repo}
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(pathname)
    if (repoMatch && method === 'GET') {
      const [, owner, repo] = repoMatch
      if (owner === state.login && state.forks.has(`${owner}/${repo}`)) {
        return json({ full_name: `${owner}/${repo}`, fork: true, default_branch: 'main', created_at: state.createdAt, topics: [], archived: false, stargazers_count: 0 })
      }
      if (owner === 'alice' && repo === 'dsh-good-plugin') {
        return json({
          full_name: `${owner}/${repo}`, fork: false, default_branch: state.defaultBranch,
          created_at: state.createdAt, topics: state.topics, archived: false, stargazers_count: 3,
        })
      }
      if (owner === AWESOME_REPO.owner && repo === AWESOME_REPO.repo) {
        return json({ full_name: `${owner}/${repo}`, fork: false, default_branch: 'main', created_at: '2020-01-01T00:00:00Z', topics: [], archived: false, stargazers_count: 900 })
      }
      return json({ message: 'Not Found' }, 404)
    }

    // fork creation
    if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/forks$/.test(pathname)) {
      state.forks.add(`${state.login}/${pathname.split('/')[3]}`)
      return json({ full_name: `${state.login}/${pathname.split('/')[3]}`, fork: true }, 202)
    }

    // contents
    const contentsMatch = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(pathname)
    if (contentsMatch && method === 'GET') {
      const file = decodeURIComponent(contentsMatch[3])
      if (file.startsWith('data/plugins/') && state.entryExists) {
        return json({ content: Buffer.from('url: https://github.com/alice/repo\n').toString('base64'), encoding: 'base64', sha: 'oldsha' })
      }
      return json({ message: 'Not Found' }, 404)
    }

    // git ref read
    const refMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/.exec(pathname)
    if (refMatch && method === 'GET') {
      const branch = decodeURIComponent(refMatch[3])
      const sha = state.branches.get(branch)
      if (!sha) return json({ message: 'Not Found' }, 404)
      return json({ object: { sha } })
    }

    // git commit read
    const commitMatch = /^\/repos\/([^/]+)\/([^/]+)\/git\/commits\/(.+)$/.exec(pathname)
    if (commitMatch && method === 'GET') {
      return json({ sha: commitMatch[3], tree: { sha: 'basetree' } })
    }

    // blob create
    if (method === 'POST' && /\/git\/blobs$/.test(pathname)) {
      const sha = `blob-${state.blobs.size + 1}`
      state.blobs.set(sha, body)
      return json({ sha })
    }

    // tree create
    if (method === 'POST' && /\/git\/trees$/.test(pathname)) {
      return json({ sha: 'newtree' })
    }

    // commit create
    if (method === 'POST' && /\/git\/commits$/.test(pathname)) {
      state.commits.push(body)
      return json({ sha: `commit-${state.commits.length}`, html_url: 'https://github.com/alice/awesome-dsh-plugin/commit/x' })
    }

    // ref create / update
    if (method === 'POST' && /\/git\/refs$/.test(pathname)) {
      state.branches.set(body.ref.replace('refs/heads/', ''), body.sha)
      return json({ ref: body.ref })
    }
    if (method === 'PATCH' && /\/git\/refs\/heads\//.test(pathname)) {
      return json({ ref: pathname })
    }

    // pull list / create
    if (/\/pulls$/.test(pathname) && method === 'GET') {
      return json(state.prs)
    }
    if (/\/pulls$/.test(pathname) && method === 'POST') {
      const pr = { number: state.prs.length + 1, html_url: `https://github.com/${AWESOME_REPO.owner}/${AWESOME_REPO.repo}/pull/${state.prs.length + 1}`, ...body }
      state.prs.push(pr)
      return json(pr, 201)
    }

    return json({ message: `unhandled ${method} ${pathname}` }, 500)
  }

  return { fetch, calls, state }
}

await test('whoami reads the login and reports a bad token', async () => {
  const fake = fakeGithub()
  const client = createClient('t', { fetch: fake.fetch })
  const me = await whoami(client)
  assert.equal(me.ok, true)
  assert.equal(me.login, 'alice')
})

await test('repoFacts computes age, topics and the 1-day bar', async () => {
  const fake = fakeGithub()
  const client = createClient('t', { fetch: fake.fetch })
  const facts = await repoFacts(client, 'alice', 'dsh-good-plugin')
  assert.equal(facts.ok, true)
  assert.ok(facts.ageDays > 4)
  assert.ok(facts.topics.includes('dsh-plugin'))
})

await test('ensureFork reuses an existing fork instead of creating one', async () => {
  const fake = fakeGithub({ forks: ['alice/awesome-dsh-plugin'] })
  const client = createClient('t', { fetch: fake.fetch })
  const fork = await ensureFork(client, AWESOME_REPO.owner, AWESOME_REPO.repo, 'alice')
  assert.equal(fork.ok, true)
  assert.equal(fork.reused, true)
  assert.ok(!fake.calls.some(c => c.method === 'POST' && /forks$/.test(c.path)))
})

await test('commitFiles writes every file in one commit', async () => {
  const fake = fakeGithub({ forks: ['alice/awesome-dsh-plugin'] })
  const client = createClient('t', { fetch: fake.fetch })
  const result = await commitFiles(client, 'alice', 'awesome-dsh-plugin', {
    branch: 'add-alice__repo',
    baseBranch: 'main',
    message: 'Add alice/repo',
    files: [
      { path: 'data/plugins/alice__repo.yml', content: 'url: x\n', encoding: 'utf8' },
      { path: 'assets/shot.png', content: 'AAAA', encoding: 'base64' },
    ],
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(fake.state.commits.length, 1)
  // The base64 file went through the blob API, the text one inline.
  assert.equal(fake.calls.filter(c => /\/git\/blobs$/.test(c.path)).length, 1)
})

await test('planSubmission treats an existing entry as an update, not a refusal', async () => {
  // This used to be a hard stop. The common case is "I shipped a new version", so an
  // existing entry now plans as an update and reports what would change. The detail
  // lives in update.test.mjs; here we only pin that it no longer blocks outright.
  const fake = fakeGithub({ entryExists: true })
  const client = createClient('t', { fetch: fake.fetch })
  const plan = await planSubmission(client, {
    login: 'alice',
    target: { owner: 'alice', repo: 'dsh-good-plugin', slug: 'alice/dsh-good-plugin', url: 'https://github.com/alice/dsh-good-plugin', entryName: 'alice/dsh-good-plugin', entryFile: 'alice__dsh-good-plugin.yml' },
    entryFile: 'alice__dsh-good-plugin.yml',
    yaml: 'url: x\n',
    prTitle: 'Add alice/dsh-good-plugin',
    prBody: 'body',
    branchName: 'add-alice__dsh-good-plugin',
  })
  if (plan.ok) {
    assert.equal(plan.mode, 'update', 'an existing entry must plan as an update')
  } else {
    // Refused only when the content is byte-identical — a no-op PR must not open.
    assert.equal(plan.noChange, true, `unexpected refusal: ${plan.error}`)
  }
})

await test('planSubmission warns about a young repo and a missing topic', async () => {
  const fake = fakeGithub({ createdAt: new Date().toISOString(), topics: [] })
  const client = createClient('t', { fetch: fake.fetch })
  const plan = await planSubmission(client, {
    login: 'alice',
    target: { owner: 'alice', repo: 'dsh-good-plugin', slug: 'alice/dsh-good-plugin', url: 'https://github.com/alice/dsh-good-plugin', entryName: 'alice/dsh-good-plugin', entryFile: 'alice__dsh-good-plugin.yml' },
    entryFile: 'alice__dsh-good-plugin.yml',
    yaml: 'url: x\n',
    prTitle: 'Add alice/dsh-good-plugin',
    prBody: 'body',
    branchName: 'add-alice__dsh-good-plugin',
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.warnings.length, 2)
})

await test('executeSubmission forks, commits and opens exactly one PR', async () => {
  const fake = fakeGithub()
  const client = createClient('t', { fetch: fake.fetch })
  const target = {
    owner: 'alice', repo: 'dsh-good-plugin', slug: 'alice/dsh-good-plugin',
    url: 'https://github.com/alice/dsh-good-plugin', entryName: 'alice/dsh-good-plugin',
    entryFile: 'alice__dsh-good-plugin.yml',
  }
  const plan = await planSubmission(client, {
    login: 'alice', target, entryFile: target.entryFile, yaml: 'url: x\n',
    prTitle: 'Add alice/dsh-good-plugin', prBody: 'body', branchName: 'add-x',
  })
  assert.equal(plan.ok, true)
  const result = await executeSubmission(client, plan, {
    login: 'alice', target, entryFile: target.entryFile, yaml: 'url: x\n',
    files: [], prTitle: 'Add alice/dsh-good-plugin', prBody: 'body', branchName: 'add-x',
  })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.prNumber, 1)
  assert.equal(fake.state.prs.length, 1)
  assert.equal(fake.state.commits.length, 1)
  assert.equal(fake.state.commits[0].message, 'Add alice/dsh-good-plugin')
})

await test('re-running the submission reuses the open PR instead of duplicating it', async () => {
  const fake = fakeGithub({ forks: ['alice/awesome-dsh-plugin'] })
  const client = createClient('t', { fetch: fake.fetch })
  const target = {
    owner: 'alice', repo: 'dsh-good-plugin', slug: 'alice/dsh-good-plugin',
    url: 'https://github.com/alice/dsh-good-plugin', entryName: 'alice/dsh-good-plugin',
    entryFile: 'alice__dsh-good-plugin.yml',
  }
  const params = {
    login: 'alice', target, entryFile: target.entryFile, yaml: 'url: x\n',
    files: [], prTitle: 'Add', prBody: 'body', branchName: 'add-x',
  }
  const first = await executeSubmission(client, await planSubmission(client, params), params)
  assert.equal(first.ok, true, first.error)
  const second = await executeSubmission(client, await planSubmission(client, params), params)
  assert.equal(second.ok, true, second.error)
  assert.equal(second.reusedPr, true)
  assert.equal(fake.state.prs.length, 1, 'must not open a second PR')
})

await test('a 401 from GitHub is reported as needsAuth, not as a crash', async () => {
  const fetch = async () => ({
    ok: false, status: 401,
    headers: { get: () => null },
    text: async () => JSON.stringify({ message: 'Bad credentials' }),
  })
  const client = createClient('bad', { fetch })
  const me = await whoami(client)
  assert.equal(me.ok, false)
  assert.equal(me.needsAuth, true)
})

await test('branch names are deterministic, filesystem-safe and version-free', () => {
  // A version in the branch name would make every release open a new PR.
  assert.equal(branchNameFor('alice__repo.yml'), 'add-alice__repo')
  assert.equal(branchNameFor('alice__repo--packages-my-plugin.yml', null), 'add-alice__repo--packages-my-plugin')
})

removeTempRoot(root)

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
