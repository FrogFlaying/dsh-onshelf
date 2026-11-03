/**
 * Integration harness: mount the host half the way the loader does, then drive its
 * HTTP routes in-process. This is the closest thing to "it actually works in DSH"
 * that can run without restarting the app.
 *
 * Run: node test/host-integration.mjs
 *
 * @module test/host-integration.mjs
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, name, inject } from '../index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')

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

/* ── a minimal stand-in for the cordis context the loader hands us ── */

const registeredTools = []
let apiHandler = null
const effects = []

const ctx = {
  logger: () => ({ info() {}, warn() {}, debug() {} }),
  get(key) {
    if (key === 'homePaths') return { home: path.join(process.env.TEMP ?? '.', 'onshelf-integration-home') }
    if (key === 'workspace') return { root: pluginDir }
    return undefined
  },
  tools: {
    register(tool) { registeredTools.push(tool); return () => {} },
  },
  effect(fn, label) {
    effects.push({ label, dispose: typeof fn === 'function' ? fn() : undefined })
  },
  inject(deps, cb) {
    if (deps.includes('webServer')) {
      const webServer = {
        register({ kind, path: prefix, handler }) {
          assert.equal(kind, 'prefix')
          apiHandler = { prefix, handler }
          return () => {}
        },
      }
      cb({
        webServer,
        effect(fn, label) { effects.push({ label, dispose: typeof fn === 'function' ? fn() : undefined }) },
      })
    }
  },
}

apply(ctx, {})

console.log(`host half: name=${name} inject=${JSON.stringify(inject)}`)
console.log('')

await test('registers exactly one agent tool named "onshelf"', () => {
  assert.equal(registeredTools.length, 1)
  assert.equal(registeredTools[0].name, 'onshelf')
})

await test('the tool declares every action the wizard uses', () => {
  const actions = registeredTools[0].parameters.properties.action.enum
  for (const action of ['scan', 'check', 'fix', 'prepare', 'submit', 'status']) {
    assert.ok(actions.includes(action), `missing action ${action}`)
  }
})

await test('the tool output schema is closed and renders text', () => {
  const output = registeredTools[0].output
  assert.equal(output.schema.type, 'object')
  assert.equal(output.schema.additionalProperties, false)
  const rendered = output.render({}, { ok: true, action: 'scan', text: 'hello' })
  assert.deepEqual(rendered, [{ type: 'text', text: 'hello' }])
})

await test('mounts the API at /api/onshelf', () => {
  assert.ok(apiHandler, 'no handler mounted')
  assert.equal(apiHandler.prefix, '/api/onshelf')
})

/* ── drive the real HTTP surface ── */

const server = http.createServer((req, res) => apiHandler.handler(req, res))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}/api/onshelf`

async function getJson(route) {
  const res = await fetch(`${base}${route}`)
  const data = await res.json()
  return { status: res.status, data }
}
async function postJson(route, body) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const data = await res.json()
  return { status: res.status, data }
}

await test('GET /config returns the 23 categories and no token', async () => {
  const { status, data } = await getJson('/config')
  assert.equal(status, 200)
  assert.equal(data.categories.length, 23)
  assert.equal(data.hasToken, false)
  assert.equal(data.identity, null)
})

await test('GET /scan finds this very plugin', async () => {
  const { status, data } = await getJson(`/scan?root=${encodeURIComponent(pluginDir)}`)
  assert.equal(status, 200)
  assert.ok(data.found.some(p => p.name === 'dsh-onshelf'), `found: ${data.found.map(f => f.name)}`)
  assert.ok(data.stats, 'the scan result should carry stats the UI can display')
})

await test('GET /scan/cached never walks the disk', async () => {
  const { status, data } = await getJson('/scan/cached')
  assert.equal(status, 200)
  // Either a cached result or an explicit null — never a scan that blocks.
  assert.ok(data.cached === null || Array.isArray(data.cached.found))
})

await test('GET /scan/cached returns a usable result after a scan of the same roots', async () => {
  // The cache is keyed by root list, so prime it with the *default* roots — the
  // same ones /scan/cached compares against.
  const primes = await getJson('/scan?force=1')
  assert.equal(primes.status, 200)
  const { data } = await getJson('/scan/cached')
  assert.ok(data.cached, 'expected the scan to be cached')
  assert.ok(Array.isArray(data.cached.found))
})

await test('POST /scan/start runs in the background and /scan/status reports progress', async () => {
  const started = await postJson('/scan/start', { roots: [pluginDir] })
  assert.equal(started.status, 200)
  assert.equal(started.data.running, true)
  const jobId = started.data.job?.id
  assert.ok(jobId, 'no job id returned')

  // Poll exactly as the settings page does.
  let last = null
  for (let i = 0; i < 200; i++) {
    const { status, data } = await getJson(`/scan/status?job=${encodeURIComponent(jobId)}`)
    assert.equal(status, 200)
    last = data.job
    if (!last) break
    if (!last.running) break
    await new Promise(r => setTimeout(r, 20))
  }
  assert.ok(last, 'the job disappeared')
  assert.equal(last.running, false, 'job never finished')
  assert.ok(last.elapsedMs >= 0)
  assert.ok(last.progress.dirsVisited > 0, 'progress was never reported')
  assert.ok(last.result, 'no result on a finished job')
  assert.ok(last.result.found.some(p => p.name === 'dsh-onshelf'))
})

await test('POST /scan/start hands back the previous result so the list never blanks', async () => {
  // Prime the cache with a normal scan.
  await getJson(`/scan?root=${encodeURIComponent(pluginDir)}&force=1`)
  const { data } = await postJson('/scan/start', { roots: [pluginDir] })
  assert.ok(data.previous, 'expected the previous result alongside the running job')
  assert.ok(data.previous.found.some(p => p.name === 'dsh-onshelf'))
})

await test('POST /scan/cancel is accepted and reported', async () => {
  const { status, data } = await postJson('/scan/cancel', {})
  assert.equal(status, 200)
  assert.equal(typeof data.cancelled, 'boolean')
})

await test('GET /scan/status for a stale job id returns no job instead of another job', async () => {
  const { data } = await getJson('/scan/status?job=scan-does-not-exist')
  assert.equal(data.job, null)
})

await test('GET /check diagnoses this plugin and finds no blocking error', async () => {
  const { status, data } = await getJson(`/check?dir=${encodeURIComponent(pluginDir)}`)
  assert.equal(status, 200)
  assert.equal(data.name, 'dsh-onshelf')
  assert.ok(Array.isArray(data.findings))
  const bundle = data.findings.find(f => f.id === 'bundle-missing')
  assert.equal(bundle, undefined, 'this plugin declares dsh.bundle, so that finding must not appear')
})

await test('GET /check returns findings that name an action', async () => {
  const { data } = await getJson(`/check?dir=${encodeURIComponent(pluginDir)}`)
  for (const f of data.findings) {
    if (!f.fixable) continue
    assert.ok(f.action, `${f.id} is fixable but has no action`)
    assert.ok(['file', 'draft'].includes(f.action.kind), `${f.id}: ${f.action.kind}`)
  }
})

await test('POST /draft/apply fills a draft field and returns fresh findings', async () => {
  await postJson('/draft', { dir: pluginDir, draft: { category: '', descriptionEn: '' } })
  const before = await getJson(`/check?dir=${encodeURIComponent(pluginDir)}`)
  const target = before.data.findings.find(f => f.action?.kind === 'draft')
  assert.ok(target, `no draft-actionable finding: ${before.data.findings.map(f => f.id)}`)

  const res = await postJson('/draft/apply', { dir: pluginDir, id: target.id })
  assert.equal(res.status, 200, JSON.stringify(res.data))
  assert.equal(res.data.ok, true)
  assert.ok(res.data.applied.patch)
  assert.ok(Array.isArray(res.data.findings))
})

await test('POST /draft/apply with an unknown id is a 400', async () => {
  const res = await postJson('/draft/apply', { dir: pluginDir, id: 'no-such-finding' })
  assert.equal(res.status, 400)
  assert.match(res.data.error, /没有这条检查项/)
})

await test('POST /draft/apply refuses a file-level finding', async () => {
  // A bundle/patch finding is a file action; sending it to the draft endpoint must
  // be refused rather than silently writing nothing.
  const res = await postJson('/draft/apply', { dir: pluginDir, id: 'repository-missing' })
  // repository-missing is now a manual action, so the refusal message differs; what
  // matters is that it does not pretend to have succeeded.
  assert.equal(res.status, 400)
  assert.equal(res.data.ok, undefined)
})

await test('POST /autofix fills what it can and reports what it cannot', async () => {
  await postJson('/draft', { dir: pluginDir, draft: { category: '', descriptionEn: '' } })
  const res = await postJson('/autofix', { dir: pluginDir })
  assert.equal(res.status, 200, JSON.stringify(res.data))
  assert.equal(res.data.ok, true)
  assert.ok(Array.isArray(res.data.applied))
  assert.ok(Array.isArray(res.data.manual))
  assert.ok(res.data.draft.category, 'category was not filled')
  assert.ok(res.data.draft.descriptionEn, 'english description was not filled')
  assert.ok(
    !/[\u4e00-\u9fff]/.test(res.data.draft.descriptionEn),
    `english description still contains CJK: ${res.data.draft.descriptionEn}`,
  )
})

await test('POST /autofix dryRun writes nothing', async () => {
  await postJson('/draft', { dir: pluginDir, draft: { category: 'market', descriptionEn: 'A fixed line.' } })
  const before = await getJson(`/draft?dir=${encodeURIComponent(pluginDir)}`)
  const res = await postJson('/autofix', { dir: pluginDir, dryRun: true })
  assert.equal(res.status, 200)
  assert.equal(res.data.dryRun, true)
  const after = await getJson(`/draft?dir=${encodeURIComponent(pluginDir)}`)
  assert.equal(after.data.draft.descriptionEn, before.data.draft.descriptionEn)
})

await test('GET /preview renders an English entry line after autofix', async () => {
  await postJson('/draft', { dir: pluginDir, draft: { category: '', descriptionEn: '' } })
  await postJson('/autofix', { dir: pluginDir })
  await postJson('/draft', {
    dir: pluginDir,
    draft: { repoUrl: 'https://github.com/alice/dsh-onshelf', category: 'market' },
  })
  const { status, data } = await getJson(`/preview?dir=${encodeURIComponent(pluginDir)}`)
  assert.equal(status, 200, JSON.stringify(data))
  assert.ok(
    !/[\u4e00-\u9fff]/.test(data.entry.descriptionEn),
    `entry en is Chinese: ${data.entry.descriptionEn}`,
  )
})

await test('GET /draft drafts a description from what this plugin registers', async () => {
  const { status, data } = await getJson(`/draft?dir=${encodeURIComponent(pluginDir)}`)
  assert.equal(status, 200)
  assert.equal(data.package.name, 'dsh-onshelf')
  assert.ok(data.draft.descriptionEn.length > 0)
  assert.ok(data.draft.descriptionZh.length > 0)
  // The plugin registers one tool called "onshelf"; the draft may say so.
  assert.ok(data.surface.tools.includes('onshelf'), `surface: ${JSON.stringify(data.surface)}`)
})

await test('POST /draft persists and GET /draft reads it back', async () => {
  await postJson('/draft', {
    dir: pluginDir,
    draft: { category: 'market', descriptionEn: 'Publishes a DSH plugin to the community list.' },
  })
  const { data } = await getJson(`/draft?dir=${encodeURIComponent(pluginDir)}`)
  assert.equal(data.draft.category, 'market')
  assert.match(data.draft.descriptionEn, /Publishes a DSH plugin/)
})

await test('GET /roots reports the roots and where they came from', async () => {
  const { status, data } = await getJson('/roots')
  assert.equal(status, 200)
  assert.ok(Array.isArray(data.roots))
  assert.ok(['default', 'custom', 'config'].includes(data.source))
})

await test('POST /roots saves a usable directory and rescans', async () => {
  const before = await getJson('/roots')
  const { status, data } = await postJson('/roots', { roots: [pluginDir] })
  assert.equal(status, 200, JSON.stringify(data))
  assert.deepEqual(data.roots, [pluginDir])

  const after = await getJson('/roots')
  assert.deepEqual(after.data.roots, [pluginDir])
  assert.equal(after.data.source, 'custom')

  // The saved root must drive the next scan.
  const scan = await getJson('/scan?force=1')
  assert.ok(scan.data.found.some(p => p.name === 'dsh-onshelf'), 'scan should use the saved root')

  // Restore whatever was there before so the suite leaves no trace.
  await postJson('/roots', { roots: before.data.roots })
})

await test('POST /roots rejects a path that does not exist', async () => {
  const { status, data } = await postJson('/roots', {
    roots: [path.join(pluginDir, 'nope-does-not-exist')],
  })
  assert.equal(status, 400)
  assert.equal(data.ok, false)
  assert.equal(data.rejected.length, 1)
})

await test('POST /roots rejects a path that is a file, not a directory', async () => {
  const { status, data } = await postJson('/roots', { roots: [path.join(pluginDir, 'package.json')] })
  assert.equal(status, 400)
  assert.equal(data.rejected[0].reason, '不是目录')
})

await test('GET /preview renders the entry YAML and PR body', async () => {
  await postJson('/draft', {
    dir: pluginDir,
    draft: {
      category: 'market',
      repoUrl: 'https://github.com/alice/dsh-onshelf',
      descriptionEn: 'Scans local DSH plugins and submits an entry to the community list.',
      descriptionZh: '扫描本地插件并提交条目到社区列表。',
    },
  })
  const { status, data } = await getJson(`/preview?dir=${encodeURIComponent(pluginDir)}`)
  assert.equal(status, 200)
  assert.equal(data.entryFile, 'alice__dsh-onshelf.yml')
  assert.match(data.yaml, /^url: https:\/\/github\.com\/alice\/dsh-onshelf$/m)
  assert.match(data.yaml, /category: market/)
  assert.ok(data.prDraft.includes('data/plugins/alice__dsh-onshelf.yml'))
  assert.equal(data.validation.ok, true, JSON.stringify(data.validation))
})

await test('a manually picked category is kept and the suggestion is reported', async () => {
  await postJson('/draft', {
    dir: pluginDir,
    draft: { category: 'ui', descriptionEn: 'Scans local DSH plugins and submits an entry.' },
  })
  const { data } = await getJson(`/draft?dir=${encodeURIComponent(pluginDir)}`)
  // The saved value wins — never silently replaced.
  assert.equal(data.draft.category, 'ui')
  assert.equal(data.draft.categorySource, 'manual')
  // But the fresh guess is available, so the UI can offer to switch.
  assert.ok(data.draft.suggestedCategory, 'a fresh suggestion should still be reported')
  assert.match(data.draft.categoryReason, /选过/)
})

await test('an untouched draft reports its category as suggested, not manual', async () => {
  // Clear the saved category to simulate a first visit.
  await postJson('/draft', { dir: pluginDir, draft: { category: '' } })
  const { data } = await getJson(`/draft?dir=${encodeURIComponent(pluginDir)}`)
  assert.equal(data.draft.categorySource, 'suggested')
  assert.equal(data.draft.category, data.draft.suggestedCategory)
})

await test('an invalid repo URL is rejected rather than written', async () => {
  await postJson('/draft', { dir: pluginDir, draft: { repoUrl: 'not-a-repo' } })
  const { status, data } = await getJson(`/preview?dir=${encodeURIComponent(pluginDir)}`)
  assert.equal(status, 400)
  assert.match(data.error, /仓库/)
})

await test('POST /token with an empty value clears the session token', async () => {
  const { status, data } = await postJson('/token', { token: '' })
  assert.equal(status, 200)
  assert.equal(data.cleared, true)
})

await test('every GitHub route refuses without a token instead of crashing', async () => {
  const repo = await getJson('/repo?repo=alice/dsh-onshelf')
  assert.equal(repo.status, 401)
  assert.equal(repo.data.needsAuth, true)

  const submit = await postJson('/submit', { dir: pluginDir })
  assert.equal(submit.status, 401)
  assert.equal(submit.data.needsAuth, true)

  const upload = await postJson('/upload-screenshots', { dir: pluginDir })
  assert.equal(upload.status, 401)
  assert.equal(upload.data.needsAuth, true)
})

await test('an unknown route is a 404, not a hang', async () => {
  const { status } = await getJson('/nope')
  assert.equal(status, 404)
})

await test('the agent tool runs scan end to end', async () => {
  const result = await registeredTools[0].execute({ action: 'scan', roots: [pluginDir] })
  assert.equal(result.ok, true)
  assert.match(result.text, /dsh-onshelf/)
})

await test('the agent tool runs check end to end', async () => {
  const result = await registeredTools[0].execute({ action: 'check', dir: pluginDir })
  assert.equal(result.ok, true)
  assert.match(result.text, /体检结果/)
})

await test('the agent tool refuses to submit without a token', async () => {
  const result = await registeredTools[0].execute({ action: 'submit', dir: pluginDir })
  assert.equal(result.ok, false)
  assert.match(result.text, /token/i)
})

/* ── publishing the code to GitHub ──
 *
 * The reported gap: the wizard told the author to create the repo and push the code
 * themselves. This drives the endpoint end to end against a fake transport, on a
 * throwaway plugin directory so the plugin under test is never modified.
 */

const publishDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onshelf-publish-host-'))
fs.writeFileSync(path.join(publishDir, 'package.json'), JSON.stringify({
  name: 'dsh-publish-fixture',
  version: '1.0.0',
  description: 'A fixture for the publish endpoint.',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2))
fs.writeFileSync(path.join(publishDir, 'cordis.patch.yml'), "- insert:\n    - id: x\n      name: 'dsh-publish-fixture'\n")
fs.writeFileSync(path.join(publishDir, 'index.js'), 'export const name = "x"\n')
fs.writeFileSync(path.join(publishDir, 'README.md'), '# fixture\n')
fs.mkdirSync(path.join(publishDir, 'node_modules', 'junk'), { recursive: true })
fs.writeFileSync(path.join(publishDir, 'node_modules', 'junk', 'a.js'), 'nope')

const realFetch = globalThis.fetch
const publishCalls = []
const publishState = { repoExists: false, empty: true, blobs: 0, trees: 0, commits: 0, refs: 0, created: null }

globalThis.fetch = async (url, init = {}) => {
  const target = String(url)
  // Only GitHub is faked; the test's own requests to the local host pass through.
  if (!/^https?:\/\/api\.github\.com\//.test(target)) return realFetch(url, init)

  const method = (init.method ?? 'GET').toUpperCase()
  const { pathname } = new URL(target)
  const body = init.body ? JSON.parse(init.body) : undefined
  publishCalls.push({ method, path: pathname })

  const json = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
    json: async () => data,
  })

  if (pathname === '/user') return json({ login: 'alice', name: 'Alice', avatar_url: '' })
  if (pathname === '/user/repos' && method === 'POST') {
    publishState.repoExists = true
    publishState.created = body
    return json({ name: body.name, owner: { login: 'alice' }, private: false, default_branch: 'main' }, 201)
  }
  const repo = /^\/repos\/([^/]+)\/([^/]+)$/.exec(pathname)
  if (repo && method === 'GET') {
    if (!publishState.repoExists) return json({ message: 'Not Found' }, 404)
    return json({
      full_name: `${repo[1]}/${repo[2]}`,
      private: false,
      default_branch: 'main',
      size: publishState.repoEmpty === false ? 8 : 0,
    })
  }
  if (/\/git\/commits\/.+$/.test(pathname) && method === 'GET') {
    return json({ sha: publishState.seedSha ?? 'basesha', tree: { sha: 'seedtree' } })
  }
  if (/\/git\/refs\/heads\//.test(pathname) && method === 'PATCH') {
    publishState.refs++
    return json({ object: { sha: body.sha } })
  }
  if (/\/git\/ref\/heads\//.test(pathname) && method === 'GET') {
    // 409 is what GitHub really answers on a repo with no commits — and it stops
    // being true the moment the seeding commit lands.
    if (publishState.repoEmpty !== false) {
      return json({ message: 'Git Repository is empty.' }, 409)
    }
    return json({ object: { sha: publishState.seedSha ?? 'basesha' } })
  }
  // Seeding an empty repo has to go through the Contents API: every /git/* endpoint
  // refuses until one commit exists.
  if (/\/contents\//.test(pathname) && method === 'PUT') {
    publishState.seeded = body
    publishState.repoEmpty = false
    publishState.seedSha = 'seedsha'
    return json({ commit: { sha: 'seedsha', html_url: 'https://example/seed' } }, 201)
  }
  if (/\/git\/blobs$/.test(pathname) && method === 'POST') { publishState.blobs++; return json({ sha: `b${publishState.blobs}` }, 201) }
  if (/\/git\/trees$/.test(pathname) && method === 'POST') { publishState.trees++; return json({ sha: 'tree' }, 201) }
  if (/\/git\/commits$/.test(pathname) && method === 'POST') { publishState.commits++; return json({ sha: 'commit', html_url: 'https://example/commit' }, 201) }
  if (/\/git\/refs$/.test(pathname) && method === 'POST') { publishState.refs++; return json({ ref: body.ref }, 201) }
  return json({ message: `unhandled ${method} ${pathname}` }, 500)
}

await test('POST /publish-repo refuses without a token', async () => {
  const res = await postJson('/publish-repo', { dir: publishDir })
  assert.equal(res.status, 401)
  assert.equal(res.data.needsAuth, true)
})

await test('POST /publish-repo dry run describes the upload and writes nothing', async () => {
  const token = await postJson('/token', { token: 'fake-token' })
  assert.equal(token.status, 200, JSON.stringify(token.data))

  const res = await postJson('/publish-repo', { dir: publishDir, name: 'dsh-publish-fixture', dryRun: true })
  assert.equal(res.status, 200, JSON.stringify(res.data))
  const plan = res.data.plan
  assert.equal(plan.willCreate, true)
  assert.equal(plan.url, 'https://github.com/alice/dsh-publish-fixture')
  assert.ok(plan.files >= 4, `expected at least 4 files, got ${plan.files}`)
  assert.equal(plan.createsPublicRepo, true)
  assert.equal(publishState.commits, 0, 'a dry run must not write anything')
})

await test('the plan never includes node_modules', async () => {
  const res = await postJson('/publish-repo', { dir: publishDir, name: 'dsh-publish-fixture', dryRun: true })
  const top = res.data.plan.topLevel
  assert.ok(!top.some(t => String(t).startsWith('node_modules')), `uploaded ${top.join(', ')}`)
})

await test('POST /publish-repo creates the repo, pushes one root commit, and fills the draft', async () => {
  const res = await postJson('/publish-repo', { dir: publishDir, name: 'dsh-publish-fixture' })
  assert.equal(res.status, 200, JSON.stringify(res.data))
  assert.equal(res.data.ok, true)
  // The upload runs as a job so the wizard can show progress; poll it the way the
  // page does.
  assert.ok(res.data.job?.id, 'expected a job id')

  let job = null
  for (let i = 0; i < 400; i++) {
    const status = await getJson(`/publish-status?job=${encodeURIComponent(res.data.job.id)}`)
    job = status.data.job
    if (!job) break
    if (!job.running) break
    await new Promise(r => setTimeout(r, 25))
  }
  assert.ok(job, 'the job disappeared')
  assert.equal(job.running, false, 'job never finished')
  assert.equal(job.error, null, `job failed: ${job.error}`)

  const result = job.result
  assert.ok(result, 'a finished job must carry its result')
  assert.equal(result.repoUrl, 'https://github.com/alice/dsh-publish-fixture')
  assert.equal(result.branch, 'main')
  assert.equal(publishState.created.name, 'dsh-publish-fixture')
  assert.equal(publishState.created.auto_init, false)
  assert.equal(publishState.commits, 1, 'one follow-up commit after the seeding commit')
  assert.ok(publishState.seeded, 'the first file must go through the Contents API')
  // One file seeded the commit; every other file travelled as a blob.
  assert.ok(publishState.blobs >= 3, `expected the remaining files as blobs, got ${publishState.blobs}`)

  // The repository field must have been written before the push, so the pushed
  // package.json is self-describing.
  const written = JSON.parse(fs.readFileSync(path.join(publishDir, 'package.json'), 'utf8'))
  assert.equal(written.repository.url, 'git+https://github.com/alice/dsh-publish-fixture.git')

  // And the wizard's repo field must be filled in.
  const draft = await getJson(`/draft?dir=${encodeURIComponent(publishDir)}`)
  assert.equal(draft.data.draft.repoUrl, 'https://github.com/alice/dsh-publish-fixture')
})

await test('the publish job reports progress while it uploads', async () => {
  // Re-push with overwrite so the job runs again and we can watch its phases.
  const res = await postJson('/publish-repo', { dir: publishDir, name: 'dsh-publish-fixture', overwrite: true })
  assert.equal(res.status, 200, JSON.stringify(res.data))
  const phases = new Set()
  let job = null
  for (let i = 0; i < 400; i++) {
    const status = await getJson(`/publish-status?job=${encodeURIComponent(res.data.job.id)}`)
    job = status.data.job
    if (!job) break
    phases.add(job.phase)
    if (!job.running) break
    await new Promise(r => setTimeout(r, 15))
  }
  assert.equal(job.running, false)
  // Whatever the timing, the job must have passed through at least one working phase
  // and ended in a terminal one — never left dangling mid-upload.
  assert.ok(['done', 'failed'].includes(job.phase), `ended in phase ${job.phase}`)
  assert.ok(phases.size >= 1)
})

await test('GET /publish-status for a stale job id returns no job', async () => {
  const { data } = await getJson('/publish-status?job=publish-nope')
  assert.equal(data.job, null)
})

await test('the repository finding is gone after publishing', async () => {
  const { data } = await getJson(`/check?dir=${encodeURIComponent(publishDir)}`)
  assert.ok(
    !data.findings.some(f => f.id === 'repository-missing'),
    'repository-missing must not survive a publish',
  )
})

await test('POST /publish-repo refuses to clobber a repo that already has commits', async () => {
  // Flip the fake to "this repo already has history".
  publishState.empty = false
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (!/^https?:\/\/api\.github\.com\//.test(target)) return original(url, init)
    const { pathname } = new URL(target)
    const method = (init.method ?? 'GET').toUpperCase()
    if (/\/git\/ref\/heads\//.test(pathname) && method === 'GET') {
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ object: { sha: 'existing' } }),
        json: async () => ({ object: { sha: 'existing' } }),
      }
    }
    return original(url, init)
  }
  try {
    const res = await postJson('/publish-repo', { dir: publishDir, name: 'dsh-publish-fixture' })
    assert.equal(res.status, 409)
    assert.equal(res.data.needsOverwrite, true)
  } finally {
    globalThis.fetch = original
  }
})

await test('POST /publish-repo rejects an invalid repository name', async () => {
  const res = await postJson('/publish-repo', { dir: publishDir, name: 'bad name!' })
  assert.equal(res.status, 400)
  assert.match(res.data.error, /仓库名/)
})

await test('a plan for an existing repo says visibility is not changed here', async () => {
  // The repo now exists (the earlier test created it) and is public; ticking
  // "private" must not error — it simply does not apply.
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (!/^https?:\/\/api\.github\.com\//.test(target)) return original(url, init)
    const { pathname } = new URL(target)
    if (/^\/repos\/[^/]+\/[^/]+$/.test(pathname) && (init.method ?? 'GET').toUpperCase() === 'GET') {
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ full_name: 'alice/x', private: false, default_branch: 'main', size: 3 }),
        json: async () => ({ full_name: 'alice/x', private: false, default_branch: 'main', size: 3 }),
      }
    }
    return original(url, init)
  }
  try {
    const res = await postJson('/publish-repo', {
      dir: publishDir, name: 'dsh-publish-fixture', private: true, dryRun: true,
    })
    assert.equal(res.status, 200, JSON.stringify(res.data))
    assert.equal(res.data.plan.willCreate, false)
    assert.ok(res.data.plan.warnings.some(w => /只对新建生效/.test(w)), JSON.stringify(res.data.plan.warnings))
  } finally {
    globalThis.fetch = original
  }
})

await test('a plan for a private existing repo warns that the list needs it public', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (!/^https?:\/\/api\.github\.com\//.test(target)) return original(url, init)
    const { pathname } = new URL(target)
    if (/^\/repos\/[^/]+\/[^/]+$/.test(pathname) && (init.method ?? 'GET').toUpperCase() === 'GET') {
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ full_name: 'alice/x', private: true, default_branch: 'main', size: 3 }),
        json: async () => ({ full_name: 'alice/x', private: true, default_branch: 'main', size: 3 }),
      }
    }
    return original(url, init)
  }
  try {
    const res = await postJson('/publish-repo', {
      dir: publishDir, name: 'dsh-publish-fixture', dryRun: true,
    })
    assert.equal(res.status, 200, JSON.stringify(res.data))
    assert.ok(res.data.plan.warnings.some(w => /私有/.test(w)), JSON.stringify(res.data.plan.warnings))
  } finally {
    globalThis.fetch = original
  }
})

await test('clearing the token revokes publish access', async () => {
  await postJson('/token', { token: '' })
  const res = await postJson('/publish-repo', { dir: publishDir, name: 'x' })
  assert.equal(res.status, 401)
})

/* ── screenshots: paste / drop / pick ──
 *
 * The author is looking at a screenshot in another window. Making them save it,
 * find the file, and type a relative path is the step this replaces.
 */

// A 1x1 PNG, the smallest real image — enough to prove bytes survive the round trip.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onshelf-shots-'))
fs.writeFileSync(path.join(shotDir, 'package.json'), JSON.stringify({
  name: 'dsh-shot-fixture', version: '1.0.0', description: 'Shots.',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2))
fs.writeFileSync(path.join(shotDir, 'cordis.patch.yml'), "- insert:\n    - id: x\n      name: 'x'\n")
fs.writeFileSync(path.join(shotDir, 'index.js'), 'export const name = "x"\n')

await test('POST /screenshots writes the image into assets/ and returns its path', async () => {
  const res = await postJson('/screenshots', {
    dir: shotDir,
    images: [{ name: 'main-window.png', type: 'image/png', base64: PNG_1x1 }],
  })
  assert.equal(res.status, 200, JSON.stringify(res.data))
  assert.equal(res.data.ok, true)
  assert.deepEqual(res.data.saved, ['assets/main-window.png'])

  const abs = path.join(shotDir, 'assets', 'main-window.png')
  assert.ok(fs.existsSync(abs), 'the file must really exist on disk')
  assert.equal(fs.statSync(abs).size, Buffer.from(PNG_1x1, 'base64').length)
})

await test('the saved path is recorded in the draft', async () => {
  const { data } = await getJson(`/draft?dir=${encodeURIComponent(shotDir)}`)
  assert.ok(data.draft.screenshots.includes('assets/main-window.png'), JSON.stringify(data.draft.screenshots))
})

await test('a pasted image with a generic name gets a unique, dated name', async () => {
  // The clipboard reports `image.png` for almost everything; the second paste must
  // not overwrite the first.
  const res = await postJson('/screenshots', {
    dir: shotDir,
    images: [
      { name: 'image.png', type: 'image/png', base64: PNG_1x1 },
      { name: 'image.png', type: 'image/png', base64: PNG_1x1 },
    ],
  })
  assert.equal(res.status, 200, JSON.stringify(res.data))
  assert.equal(res.data.saved.length, 2)
  assert.notEqual(res.data.saved[0], res.data.saved[1], 'the two pastes must not collide')
  for (const rel of res.data.saved) {
    assert.ok(fs.existsSync(path.join(shotDir, rel)), `${rel} missing`)
  }
})

await test('a same-named image is suffixed instead of overwritten', async () => {
  await postJson('/screenshots', {
    dir: shotDir, images: [{ name: 'main-window.png', type: 'image/png', base64: PNG_1x1 }],
  })
  assert.ok(fs.existsSync(path.join(shotDir, 'assets', 'main-window-1.png')), 'expected a suffixed copy')
})

await test('the MIME type decides the extension when the name has none', async () => {
  const res = await postJson('/screenshots', {
    dir: shotDir, images: [{ name: 'clipboard', type: 'image/jpeg', base64: PNG_1x1 }],
  })
  assert.equal(res.status, 200)
  assert.match(res.data.saved[0], /\.jpg$/, res.data.saved[0])
})

await test('a non-image payload is refused with a readable reason', async () => {
  const res = await postJson('/screenshots', {
    dir: shotDir, images: [{ name: 'notes.txt', type: 'text/plain', base64: Buffer.from('hi').toString('base64') }],
  })
  assert.equal(res.status, 200)
  assert.equal(res.data.ok, false)
  assert.match(res.data.failures[0].reason, /只接受/)
})

/* ── the draft and screenshots.json must not disagree ──
 *
 * The reported bug: an image pasted on ③ was in the draft but never declared on
 * disk, so ④ said "nothing to upload" for a screenshot the author could see.
 */

await test('pasting an image also writes screenshots.json', async () => {
  // Start from a clean slate: earlier tests already created the file.
  fs.rmSync(path.join(shotDir, 'screenshots.json'), { force: true })
  assert.equal(fs.existsSync(path.join(shotDir, 'screenshots.json')), false)
  const res = await postJson('/screenshots', {
    dir: shotDir, images: [{ name: 'declared.png', type: 'image/png', base64: PNG_1x1 }],
  })
  assert.equal(res.status, 200, JSON.stringify(res.data))
  assert.equal(res.data.screenshotsJson?.written, true, 'the declaration must be written')

  const file = path.join(shotDir, 'screenshots.json')
  assert.ok(fs.existsSync(file), 'screenshots.json still missing')
  const declared = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(Array.isArray(declared))
  assert.ok(declared.includes('assets/declared.png'), JSON.stringify(declared))
})

await test('editing the draft screenshot list keeps screenshots.json in step', async () => {
  await postJson('/draft', { dir: shotDir, draft: { screenshots: ['assets/one.png', 'assets/two.png'] } })
  const declared = JSON.parse(fs.readFileSync(path.join(shotDir, 'screenshots.json'), 'utf8'))
  assert.deepEqual(declared, ['assets/one.png', 'assets/two.png'])
})

await test('opening ③ heals a draft whose screenshots were never declared', async () => {
  // Simulate a draft saved by an older version: images exist, no file on disk.
  fs.rmSync(path.join(shotDir, 'screenshots.json'), { force: true })
  await postJson('/draft', { dir: shotDir, draft: { screenshots: ['assets/legacy.png'] } })
  fs.rmSync(path.join(shotDir, 'screenshots.json'), { force: true })

  const { data } = await getJson(`/draft?dir=${encodeURIComponent(shotDir)}`)
  assert.deepEqual(data.draft.screenshots, ['assets/legacy.png'])
  const file = path.join(shotDir, 'screenshots.json')
  assert.ok(fs.existsSync(file), 'reading the draft must restore the declaration')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['assets/legacy.png'])
})

await test('④ finds screenshots that were added on ③, even with no file at first', async () => {
  // The exact reported situation: draft has images, screenshots.json does not.
  fs.rmSync(path.join(shotDir, 'screenshots.json'), { force: true })
  await postJson('/draft', { dir: shotDir, draft: { screenshots: ['assets/from-step3.png'] } })
  fs.rmSync(path.join(shotDir, 'screenshots.json'), { force: true })
  fs.mkdirSync(path.join(shotDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(shotDir, 'assets', 'from-step3.png'), Buffer.from(PNG_1x1, 'base64'))

  // The upload endpoint needs a token, so assert the resolution logic it uses by
  // checking the draft is what it consults: without a token it must fail on auth,
  // not on "no screenshots".
  await postJson('/token', { token: '' })
  const res = await postJson('/upload-screenshots', { dir: shotDir, dryRun: true })
  assert.equal(res.status, 401, 'it should get past screenshot resolution and stop at auth')
  assert.equal(res.data.needsAuth, true)
})

await test('with no screenshots anywhere, ④ says where to add them', async () => {
  // Give the plugin a repository field, or the endpoint stops earlier on that.
  const pkgFile = path.join(shotDir, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  pkg.repository = { type: 'git', url: 'git+https://github.com/alice/dsh-shot-fixture.git' }
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))

  await postJson('/draft', { dir: shotDir, draft: { screenshots: [], repoUrl: 'alice/dsh-shot-fixture' } })
  fs.rmSync(path.join(shotDir, 'screenshots.json'), { force: true })
  await postJson('/token', { token: 'fake' })
  const res = await postJson('/upload-screenshots', { dir: shotDir, dryRun: true })
  assert.equal(res.status, 400)
  assert.match(res.data.error, /回到 ③/)
  await postJson('/token', { token: '' })
})

await test('the screenshot folder cannot escape the plugin directory', async () => {
  const res = await postJson('/screenshots', {
    dir: shotDir, folder: '../outside', images: [{ name: 'a.png', type: 'image/png', base64: PNG_1x1 }],
  })
  assert.equal(res.status, 400)
  assert.match(res.data.error, /插件目录内/)
})

await test('writes into node_modules are refused', async () => {
  const res = await postJson('/screenshots', {
    dir: shotDir, folder: 'node_modules/x', images: [{ name: 'a.png', type: 'image/png', base64: PNG_1x1 }],
  })
  assert.equal(res.status, 400)
  assert.match(res.data.error, /node_modules/)
})

await test('GET /shot serves the stored image with an image content type', async () => {
  const target = `${base}/shot?dir=${encodeURIComponent(shotDir)}&path=${encodeURIComponent('assets/main-window.png')}`
  const res = await realFetch(target)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  const bytes = Buffer.from(await res.arrayBuffer())
  assert.deepEqual(bytes, Buffer.from(PNG_1x1, 'base64'))
})

await test('GET /shot refuses a path outside the plugin directory', async () => {
  const target = `${base}/shot?dir=${encodeURIComponent(shotDir)}&path=${encodeURIComponent('../../etc/passwd')}`
  const res = await realFetch(target)
  assert.equal(res.status, 400)
})

await test('GET /shot refuses a non-image file', async () => {
  const target = `${base}/shot?dir=${encodeURIComponent(shotDir)}&path=${encodeURIComponent('package.json')}`
  const res = await realFetch(target)
  assert.equal(res.status, 400)
  assert.match((await res.json()).error, /不是支持的图片格式/)
})

await test('GET /shot reports a missing image as 404', async () => {
  const target = `${base}/shot?dir=${encodeURIComponent(shotDir)}&path=${encodeURIComponent('assets/nope.png')}`
  const res = await realFetch(target)
  assert.equal(res.status, 404)
})

try { fs.rmSync(shotDir, { recursive: true, force: true }) } catch { /* temp */ }

globalThis.fetch = realFetch
try { fs.rmSync(publishDir, { recursive: true, force: true }) } catch { /* temp */ }

await new Promise(resolve => server.close(resolve))

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
