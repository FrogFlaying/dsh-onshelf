/**
 * Updating an entry that is already on the list.
 *
 * The first version treated "entry already exists" as a hard stop with a note telling
 * the author to edit it by hand. That is the wrong answer for the most common case:
 * you shipped a new version, so the description or category needs updating. This
 * suite pins the behaviour that makes it a one-click update.
 *
 * Run: node test/update.test.mjs
 *
 * @module test/update.test.mjs
 */

import assert from 'node:assert/strict'

import {
  createClient, branchNameFor, branchNameCandidates, diffEntry,
  planSubmission, findExistingSubmission, AWESOME_REPO, addRepoTopic,
} from '../lib/github.js'
import { buildPrDraft } from '../lib/entry.js'

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

/* ─────────────────────────── branch naming ─────────────────────────── */

console.log('branch names are stable per entry')
test('a version is not part of the branch name any more', () => {
  assert.equal(branchNameFor('alice__repo.yml'), 'add-alice__repo')
  // The old signature took a version; passing one now must not resurrect it.
  assert.equal(branchNameFor('alice__repo.yml', '0.2.0'), 'add-alice__repo')
})

test('the old versioned shape is still discoverable for updates', () => {
  const candidates = branchNameCandidates('alice__repo.yml', '0.1.0')
  assert.deepEqual(candidates, ['add-alice__repo', 'add-alice__repo-v0.1.0'])
})

test('without a version there is only the stable name', () => {
  assert.deepEqual(branchNameCandidates('alice__repo.yml'), ['add-alice__repo'])
})

/* ─────────────────────────── diff ─────────────────────────── */

console.log('comparing the new entry with the published one')
const OLD = [
  'url: https://github.com/alice/repo',
  'name: alice/repo',
  'category: ui',
  'description:',
  '  en: Does a thing.',
].join('\n')

const NEW = [
  'url: https://github.com/alice/repo',
  'name: alice/repo',
  'category: tools',
  'description:',
  '  en: Does a thing, and says so.',
].join('\n')

test('an identical entry is reported as no change', () => {
  const diff = diffEntry(OLD, OLD)
  assert.equal(diff.identical, true)
  assert.deepEqual(diff.changed, [])
})

test('trailing whitespace and CRLF do not count as a change', () => {
  const messy = OLD.replace(/\n/g, '\r\n') + '\r\n\r\n'
  assert.equal(diffEntry(messy, OLD).identical, true)
})

test('a changed category and description show up line by line', () => {
  const diff = diffEntry(OLD, NEW)
  assert.equal(diff.identical, false)
  assert.equal(diff.changed.length, 2)
  assert.ok(diff.changed.some(c => c.from === 'category: ui' && c.to === 'category: tools'))
  assert.ok(diff.changed.some(c => /Does a thing\./.test(c.from ?? '') && /says so/.test(c.to ?? '')))
})

test('an added line reports a null "from"', () => {
  const withShot = `${OLD}\ntarball: https://example/x.tgz`
  const diff = diffEntry(OLD, withShot)
  assert.equal(diff.changed.length, 1)
  assert.equal(diff.changed[0].from, null)
})

/* ─────────────────────────── plan: add vs update ─────────────────────────── */

/**
 * A fake that can pretend the entry is already listed, and can track whether an
 * open PR branch exists in the fork.
 */
function fakeGithub({ entryOnList = null, openBranch = null, openPr = null } = {}) {
  const calls = []
  const json = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => (data === null ? '' : JSON.stringify(data)),
    json: async () => data,
  })
  const fetch = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const { pathname, search } = new URL(url)
    calls.push({ method, path: pathname })

    // The list repo itself: fresh and healthy.
    if (/^\/repos\/awesome-dsh-plugin\/awesome-dsh-plugin$/.test(pathname)) {
      return json({ full_name: 'awesome-dsh-plugin/awesome-dsh-plugin', fork: false, default_branch: 'main', created_at: '2020-01-01T00:00:00Z', topics: [], archived: false, stargazers_count: 900 })
    }
    // The author's own repo (age + topics).
    if (/^\/repos\/alice\/repo$/.test(pathname)) {
      return json({ full_name: 'alice/repo', fork: false, default_branch: 'main', created_at: '2025-01-01T00:00:00Z', topics: ['dsh-plugin'], archived: false, stargazers_count: 1 })
    }
    // Contents of the entry file.
    if (/\/contents\/data\/plugins\//.test(pathname) && method === 'GET') {
      if (entryOnList === null) return json({ message: 'Not Found' }, 404)
      return json({ content: Buffer.from(entryOnList).toString('base64'), encoding: 'base64', sha: 'oldsha' })
    }
    // Does the fork have the branch?
    if (/\/git\/ref\/heads\//.test(pathname) && method === 'GET') {
      const branch = decodeURIComponent(pathname.split('/git/ref/heads/')[1])
      if (openBranch && branch === openBranch) return json({ object: { sha: 'branchsha' } })
      return json({ message: 'Not Found' }, 404)
    }
    // Open PRs for that head.
    if (/\/pulls$/.test(pathname) && method === 'GET') {
      if (!openPr) return json([])
      if (decodeURIComponent(search).includes(`alice:${openPr.head}`)) {
        return json([{ number: openPr.number, html_url: `https://github.com/${AWESOME_REPO.owner}/${AWESOME_REPO.repo}/pull/${openPr.number}` }])
      }
      return json([])
    }
    return json({ message: `unhandled ${method} ${pathname}` }, 500)
  }
  return { fetch, calls }
}

const target = {
  owner: 'alice', repo: 'repo', slug: 'alice/repo',
  url: 'https://github.com/alice/repo', entryName: 'alice/repo',
  entryFile: 'alice__repo.yml',
}

const baseParams = {
  login: 'alice',
  target,
  entryFile: 'alice__repo.yml',
  yaml: NEW,
  prTitle: 'Add alice/repo',
  prBody: 'body',
  branchName: 'add-alice__repo',
}

console.log('planning an update')
await test('a brand-new entry plans as "add"', async () => {
  const fake = fakeGithub({ entryOnList: null })
  const client = createClient('t', { fetch: fake.fetch })
  const plan = await planSubmission(client, { ...baseParams, version: '0.2.0' })
  assert.equal(plan.ok, true, plan.error)
  assert.equal(plan.mode, 'add')
  assert.equal(plan.branch, 'add-alice__repo')
  assert.ok(plan.steps.some(s => /新增 data\/plugins/.test(s.label)))
})

await test('an entry already on the list plans as "update", not a refusal', async () => {
  const fake = fakeGithub({ entryOnList: OLD })
  const client = createClient('t', { fetch: fake.fetch })
  const plan = await planSubmission(client, { ...baseParams, version: '0.2.0' })
  assert.equal(plan.ok, true, plan.error)
  assert.equal(plan.mode, 'update')
  assert.equal(plan.diff.changed.length, 2)
  assert.ok(plan.steps.some(s => /更新 data\/plugins/.test(s.label)))
  assert.ok(plan.warnings.some(w => /更新/.test(w)))
})

await test('an update that changes nothing is refused before any PR is opened', async () => {
  const fake = fakeGithub({ entryOnList: NEW })
  const client = createClient('t', { fetch: fake.fetch })
  const plan = await planSubmission(client, { ...baseParams, version: '0.2.0' })
  assert.equal(plan.ok, false)
  assert.equal(plan.noChange, true)
  assert.match(plan.error, /完全一样/)
})

await test('an existing open PR branch is reused instead of a second one', async () => {
  const fake = fakeGithub({
    entryOnList: OLD,
    openBranch: 'add-alice__repo',
    openPr: { number: 42, head: 'add-alice__repo' },
  })
  const client = createClient('t', { fetch: fake.fetch })
  const plan = await planSubmission(client, { ...baseParams, version: '0.2.0' })
  assert.equal(plan.ok, true, plan.error)
  assert.equal(plan.branch, 'add-alice__repo')
  assert.equal(plan.existingSubmission.pr.number, 42)
  assert.ok(plan.steps.some(s => /复用已有分支/.test(s.label)))
  assert.ok(plan.steps.some(s => /PR #42/.test(s.label)))
})

await test('a leftover versioned branch from an older version is still found', async () => {
  const fake = fakeGithub({
    entryOnList: OLD,
    openBranch: 'add-alice__repo-v0.1.0',
    openPr: { number: 7, head: 'add-alice__repo-v0.1.0' },
  })
  const client = createClient('t', { fetch: fake.fetch })
  const found = await findExistingSubmission(client, 'alice', AWESOME_REPO.repo, 'alice__repo.yml', '0.1.0')
  assert.equal(found.found, true)
  assert.equal(found.branch, 'add-alice__repo-v0.1.0')
  assert.equal(found.pr.number, 7)
})

await test('with no open PR but the entry already listed, it reports "listed"', async () => {
  // This fixture has the entry on the list and no branch in the fork — exactly a
  // merged submission whose fork was cleaned up. That must read as "already listed",
  // not "not found": a merged PR has no open branch left to find.
  const fake = fakeGithub({ entryOnList: OLD })
  const client = createClient('t', { fetch: fake.fetch })
  const found = await findExistingSubmission(client, 'alice', AWESOME_REPO.repo, 'alice__repo.yml', '0.2.0')
  assert.equal(found.found, true)
  assert.equal(found.listed, true)
  // No branch to push to, so an update starts from a clean one.
  assert.equal(found.branchExists, false)
})

/* ─────────────────────────── PR body ─────────────────────────── */

console.log('the PR body says which kind of change it is')
const entry = {
  url: 'https://github.com/alice/repo',
  name: 'alice/repo',
  category: 'tools',
  descriptionEn: 'Does a thing, and says so.',
}
const surface = { tools: ['t'], commands: [], slots: [], entryFiles: ['index.js'] }

test('an add still reads as "Adding one entry"', () => {
  const body = buildPrDraft(entry, target, {}, surface, { mode: 'add' })
  assert.match(body, /## Adding one entry/)
  assert.match(body, /this PR adds exactly one entry/)
})

test('an update says it modifies the existing file in place', () => {
  const diff = diffEntry(OLD, NEW)
  const body = buildPrDraft(entry, target, {}, surface, { mode: 'update', diff })
  assert.match(body, /## Updating one entry/)
  assert.match(body, /modified in place, no second file/)
  assert.match(body, /### What changes|### What changed/)
  assert.match(body, /category: ui.*→.*category: tools/s)
  assert.match(body, /changes only my own entry/)
})

/* ─────────────────────────── adding the topic ─────────────────────────── */

console.log('the dsh-plugin topic is added by the tool, not by the author')

/** A fake that serves repo state and records topic writes. */
function fakeTopicRepo({ topics = [], canWrite = true } = {}) {
  const calls = []
  const state = { topics: [...topics], put: null }
  const json = (data, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
    json: async () => data,
  })
  const fetch = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const { pathname } = new URL(url)
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path: pathname, body })

    if (/^\/repos\/[^/]+\/[^/]+$/.test(pathname) && method === 'GET') {
      return json({ full_name: 'alice/repo', topics: state.topics, default_branch: 'main' })
    }
    if (/\/topics$/.test(pathname) && method === 'PUT') {
      if (!canWrite) return json({ message: 'Resource not accessible by integration' }, 403)
      state.put = body
      state.topics = body.names
      return json({ names: body.names })
    }
    return json({ message: `unhandled ${method} ${pathname}` }, 500)
  }
  return { fetch, calls, state }
}

await test('a missing topic is added with one API call', async () => {
  const fake = fakeTopicRepo({ topics: ['dsh'] })
  const client = createClient('t', { fetch: fake.fetch })
  const result = await addRepoTopic(client, 'alice', 'repo', 'dsh-plugin')
  assert.equal(result.ok, true, result.error)
  assert.equal(result.already, false)
  assert.deepEqual(fake.state.topics, ['dsh', 'dsh-plugin'], 'the existing topic must be kept')
  assert.deepEqual(fake.state.put.names, ['dsh', 'dsh-plugin'])
})

await test('an existing topic is not re-sent', async () => {
  const fake = fakeTopicRepo({ topics: ['dsh-plugin'] })
  const client = createClient('t', { fetch: fake.fetch })
  const result = await addRepoTopic(client, 'alice', 'repo', 'dsh-plugin')
  assert.equal(result.ok, true)
  assert.equal(result.already, true)
  assert.equal(fake.state.put, null, 'nothing should be written when the topic is present')
  assert.equal(fake.calls.filter(c => c.method === 'PUT').length, 0)
})

await test('a token without Administration permission gets a usable message', async () => {
  const fake = fakeTopicRepo({ topics: [], canWrite: false })
  const client = createClient('t', { fetch: fake.fetch })
  const result = await addRepoTopic(client, 'alice', 'repo', 'dsh-plugin')
  assert.equal(result.ok, false)
  assert.match(result.error, /Administration/)
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
