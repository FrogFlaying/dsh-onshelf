/**
 * Reading back what happened to a submitted PR.
 *
 * The author was being told to open the PR page and look for a red X, then paste the
 * failure back. That is the plugin's job: the PR state and its CI result are three API
 * responses away, and a failure is worth *translating* — "conclusion: failure" is not
 * a next step.
 *
 * Run: node test/pr-status.test.mjs
 *
 * @module test/pr-status.test.mjs
 */

import assert from 'node:assert/strict'

import { createClient, prStatus, findExistingSubmission, AWESOME_REPO } from '../lib/github.js'
import { explainCiFailure, describePrStatus } from '../lib/entry.js'

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

/* ─────────────────────────── explaining a failure ─────────────────────────── */

console.log('a CI failure is translated into a next step')

const cases = [
  {
    name: 'a repo-age failure says to wait',
    item: { name: 'check-age', summary: 'Repository created less than 1 day ago.' },
    expect: { check: 'repo-age', blocking: 'wait' },
  },
  {
    name: 'a missing dsh.bundle points at 一键修复',
    item: { name: 'manifest', text: 'package.json does not declare dsh.bundle' },
    expect: { check: 'dsh-bundle', blocking: 'fix-local' },
  },
  {
    name: 'a missing topic gets the one-click fix',
    item: { name: 'topics', summary: 'the dsh-plugin topic is required' },
    expect: { check: 'topic', blocking: 'fix-online' },
  },
  {
    name: 'an awesome-lint failure points at ③',
    item: { name: 'awesome-lint', text: 'description should end with a period' },
    expect: { check: 'lint', blocking: 'fix-local' },
  },
  {
    name: 'too many entries says to split',
    item: { name: 'entry-count', text: 'a PR may add at most 3 entries' },
    expect: { check: 'entry-count', blocking: 'fix-local' },
  },
]

for (const c of cases) {
  await test(c.name, () => {
    const result = explainCiFailure(c.item)
    assert.equal(result.actionable, true)
    assert.equal(result.check, c.expect.check)
    assert.equal(result.blocking, c.expect.blocking)
    assert.ok(result.hint.length > 10, 'the hint must say what to do')
  })
}

await test('an unrecognised failure admits it does not know', () => {
  const result = explainCiFailure({ name: 'mystery-job', text: 'segfault in runner' })
  assert.equal(result.actionable, false)
  assert.equal(result.blocking, 'unknown')
  assert.match(result.hint, /日志/)
})

/* ─────────────────────────── reading the PR ─────────────────────────── */

/** A fake serving one PR plus its checks and statuses. */
function fakePr({ pr, checkRuns = [], statuses = [], prOk = true } = {}) {
  const calls = []
  const json = (data, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
    json: async () => data,
  })
  const fetch = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const { pathname } = new URL(url)
    calls.push({ method, path: pathname })

    const prMatch = /\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(pathname)
    if (prMatch && method === 'GET') {
      if (!prOk) return json({ message: 'Not Found' }, 404)
      return json({
        number: Number(prMatch[1]),
        title: pr.title ?? 'Add alice/repo',
        state: pr.state ?? 'open',
        merged: pr.merged ?? false,
        merged_at: pr.mergedAt ?? null,
        draft: false,
        mergeable: pr.mergeable ?? true,
        mergeable_state: 'clean',
        comments: pr.comments ?? 0,
        commits: 1,
        changed_files: 1,
        html_url: `https://github.com/${AWESOME_REPO.owner}/${AWESOME_REPO.repo}/pull/${prMatch[1]}`,
        user: { login: 'alice' },
        created_at: '2026-10-20T23:53:25Z',
        updated_at: pr.updatedAt ?? '2026-10-21T00:10:00Z',
        head: { sha: pr.headSha ?? 'abc123', ref: 'add-alice__repo' },
      })
    }
    if (/\/check-runs$/.test(pathname)) return json({ total_count: checkRuns.length, check_runs: checkRuns })
    if (/\/commits\/[^/]+\/status$/.test(pathname)) {
      const state = statuses.some(s => s.state === 'failure') ? 'failure'
        : statuses.some(s => s.state === 'pending') ? 'pending'
          : statuses.length > 0 ? 'success' : 'pending'
      return json({ state, statuses })
    }
    return json({ message: `unhandled ${method} ${pathname}` }, 500)
  }
  return { fetch, calls }
}

console.log('')
console.log('reading the PR state')

await test('an open PR with all checks passing reports "passed"', async () => {
  const fake = fakePr({
    pr: {},
    checkRuns: [{ name: 'dsh-bundle', status: 'completed', conclusion: 'success' }],
  })
  const client = createClient('t', { fetch: fake.fetch })
  const raw = await prStatus(client, AWESOME_REPO.owner, AWESOME_REPO.repo, 8375)
  assert.equal(raw.ok, true, raw.error)
  assert.equal(raw.state, 'open')
  assert.equal(raw.checks.verdict, 'passed')
  assert.equal(raw.checks.total, 1)

  const view = describePrStatus(raw)
  assert.equal(view.verdict, 'passed')
  assert.match(view.headline, /全部通过/)
  assert.ok(view.nextSteps.some(s => /人工审核|维护者/.test(s)))
})

await test('a failing check returns the failure with a fix attached', async () => {
  const fake = fakePr({
    pr: {},
    checkRuns: [
      { name: 'check-repo-age', status: 'completed', conclusion: 'failure', output: { summary: 'Repository created 0.6 days ago, must be at least 1 day old.' } },
    ],
  })
  const client = createClient('t', { fetch: fake.fetch })
  const raw = await prStatus(client, AWESOME_REPO.owner, AWESOME_REPO.repo, 8375)
  assert.equal(raw.checks.verdict, 'failed')
  assert.equal(raw.checks.failing, 1)

  const view = describePrStatus(raw)
  assert.equal(view.verdict, 'failed')
  assert.equal(view.failures.length, 1)
  assert.equal(view.failures[0].check, 'repo-age')
  assert.equal(view.failures[0].blocking, 'wait')
  assert.match(view.failures[0].hint, /等|明天/)
})

await test('a pending check reports "running", not failure', async () => {
  const fake = fakePr({
    pr: {},
    checkRuns: [
      { name: 'one', status: 'completed', conclusion: 'success' },
      { name: 'two', status: 'in_progress', conclusion: null },
    ],
  })
  const client = createClient('t', { fetch: fake.fetch })
  const raw = await prStatus(client, AWESOME_REPO.owner, AWESOME_REPO.repo, 8375)
  assert.equal(raw.checks.verdict, 'pending')
  const view = describePrStatus(raw)
  assert.equal(view.verdict, 'running')
  assert.match(view.headline, /进行中/)
})

await test('a merged PR is reported as listed, not as "still waiting"', async () => {
  const fake = fakePr({ pr: { state: 'closed', merged: true, mergedAt: '2026-10-22T10:00:00Z' } })
  const client = createClient('t', { fetch: fake.fetch })
  const raw = await prStatus(client, AWESOME_REPO.owner, AWESOME_REPO.repo, 8375)
  assert.equal(raw.merged, true)
  const view = describePrStatus(raw)
  assert.equal(view.verdict, 'merged')
  assert.match(view.headline, /已合并/)
  assert.ok(view.nextSteps.some(s => /市场|重建/.test(s)))
})

await test('a closed-but-not-merged PR says so plainly', async () => {
  const fake = fakePr({ pr: { state: 'closed', merged: false } })
  const client = createClient('t', { fetch: fake.fetch })
  const raw = await prStatus(client, AWESOME_REPO.owner, AWESOME_REPO.repo, 8375)
  const view = describePrStatus(raw)
  assert.equal(view.verdict, 'closed')
  assert.match(view.headline, /被关掉/)
})

await test('legacy commit statuses are read as well as check runs', async () => {
  // Some integrations still report through /status rather than /check-runs.
  const fake = fakePr({
    pr: {},
    statuses: [{ context: 'ci/lint', state: 'success', description: 'lint ok' }],
  })
  const client = createClient('t', { fetch: fake.fetch })
  const raw = await prStatus(client, AWESOME_REPO.owner, AWESOME_REPO.repo, 8375)
  assert.equal(raw.checks.total, 1)
  assert.equal(raw.checks.verdict, 'passed')
})

await test('no checks at all is "waiting", not "passed"', async () => {
  const fake = fakePr({ pr: {} })
  const client = createClient('t', { fetch: fake.fetch })
  const raw = await prStatus(client, AWESOME_REPO.owner, AWESOME_REPO.repo, 8375)
  assert.equal(raw.checks.verdict, 'none')
  const view = describePrStatus(raw)
  assert.equal(view.verdict, 'waiting-checks')
})

await test('a missing PR is a readable error', async () => {
  const fake = fakePr({ pr: {}, prOk: false })
  const client = createClient('t', { fetch: fake.fetch })
  const raw = await prStatus(client, AWESOME_REPO.owner, AWESOME_REPO.repo, 999999)
  assert.equal(raw.ok, false)
  assert.equal(raw.notFound, true)
  const view = describePrStatus(raw)
  assert.equal(view.verdict, 'unknown')
})

await test('the skipped and neutral conclusions do not count as failures', async () => {
  const fake = fakePr({
    pr: {},
    checkRuns: [
      { name: 'a', status: 'completed', conclusion: 'success' },
      { name: 'b', status: 'completed', conclusion: 'skipped' },
      { name: 'c', status: 'completed', conclusion: 'neutral' },
    ],
  })
  const client = createClient('t', { fetch: fake.fetch })
  const raw = await prStatus(client, AWESOME_REPO.owner, AWESOME_REPO.repo, 8375)
  assert.equal(raw.checks.failing, 0)
  assert.equal(raw.checks.verdict, 'passed')
})

/* ───────────────── finding the PR after it was merged ─────────────────
 *
 * Two bugs, both reported from real use:
 *   1. only *open* PRs were looked up, so a merged submission answered
 *      "you have not submitted yet";
 *   2. `Number(null)` is 0, so "no number given" became "PR #0 is invalid".
 */

console.log('')
console.log('finding a PR that is no longer open')

/** A fake where the entry is on the list and its PR is merged. */
function fakeMerged({ prState = 'closed', mergedAt = '2026-10-22T10:00:00Z', branchOnFork = true } = {}) {
  const json = (data, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
    json: async () => data,
  })
  const fetch = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const { pathname, search } = new URL(url)

    if (/\/contents\/data\/plugins\//.test(pathname) && method === 'GET') {
      return json({ content: Buffer.from('url: x\n').toString('base64'), encoding: 'base64', sha: 's' })
    }
    if (/\/git\/ref\/heads\//.test(pathname) && method === 'GET') {
      return branchOnFork ? json({ object: { sha: 'abc' } }) : json({ message: 'Not Found' }, 404)
    }
    if (/\/pulls$/.test(pathname) && method === 'GET') {
      const pr = {
        number: 8375,
        html_url: `https://github.com/${AWESOME_REPO.owner}/${AWESOME_REPO.repo}/pull/8375`,
        title: 'Add FrogFlaying/dsh-desktop-organizer',
        state: prState,
        merged_at: mergedAt,
      }
      if (/state=open/.test(search)) return json(prState === 'open' ? [pr] : [])
      return json([pr])
    }
    return json({ message: `unhandled ${method} ${pathname}` }, 500)
  }
  return { fetch }
}

await test('a merged PR is found even though it is not open', async () => {
  const fake = fakeMerged()
  const client = createClient('t', { fetch: fake.fetch })
  const found = await findExistingSubmission(client, 'FrogFlaying', AWESOME_REPO.repo, 'FrogFlaying__dsh-desktop-organizer.yml', '0.1.0')
  assert.equal(found.found, true, JSON.stringify(found))
  assert.equal(found.state, 'merged')
  assert.equal(found.pr.number, 8375)
  assert.equal(found.pr.merged, true)
})

await test('an open PR is preferred, because an update pushes to it', async () => {
  const fake = fakeMerged({ prState: 'open', mergedAt: null })
  const client = createClient('t', { fetch: fake.fetch })
  const found = await findExistingSubmission(client, 'FrogFlaying', AWESOME_REPO.repo, 'x.yml', '0.1.0')
  assert.equal(found.found, true)
  assert.equal(found.state, 'open')
})

await test('a closed-but-unmerged PR is reported as closed', async () => {
  const fake = fakeMerged({ prState: 'closed', mergedAt: null })
  const client = createClient('t', { fetch: fake.fetch })
  const found = await findExistingSubmission(client, 'FrogFlaying', AWESOME_REPO.repo, 'x.yml', '0.1.0')
  assert.equal(found.found, true)
  assert.equal(found.state, 'closed')
  assert.equal(found.pr.merged, false)
})

await test('an entry on the list is still reported when the fork has no branch', async () => {
  // A deleted fork branch must not make a merged submission look like nothing.
  const fake = fakeMerged({ branchOnFork: false })
  const client = createClient('t', { fetch: fake.fetch })
  const found = await findExistingSubmission(client, 'FrogFlaying', AWESOME_REPO.repo, 'FrogFlaying__dsh-desktop-organizer.yml', '0.1.0')
  assert.equal(found.found, true, JSON.stringify(found))
  assert.equal(found.listed, true, 'the entry being on the list is the answer')
  // The PR number is a bonus: recoverable when the title or head branch matches,
  // absent otherwise. Both are acceptable — "already listed" is the real answer.
  assert.ok(found.pr === null || found.pr.number > 0, JSON.stringify(found.pr))
})

await test('nothing submitted and nothing listed reports not found', async () => {
  const fetch = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const { pathname } = new URL(url)
    const json = (data, status = 200) => ({
      ok: status >= 200 && status < 300, status,
      headers: { get: () => null },
      text: async () => JSON.stringify(data),
      json: async () => data,
    })
    if (/\/contents\//.test(pathname)) return json({ message: 'Not Found' }, 404)
    if (/\/git\/ref\//.test(pathname)) return json({ message: 'Not Found' }, 404)
    if (/\/pulls$/.test(pathname)) return json([])
    return json({ message: 'unhandled' }, 500)
  }
  const client = createClient('t', { fetch })
  const found = await findExistingSubmission(client, 'alice', AWESOME_REPO.repo, 'x.yml', '0.1.0')
  assert.equal(found.found, false)
})

await test('Number("") is 0 — so an absent number must not become PR #0', () => {
  // The exact arithmetic that produced "PR 编号不合法：0".
  assert.equal(Number(null), 0)
  assert.equal(Number(''), 0)
  // The rule the host now follows.
  const parse = raw => (raw === null || String(raw).trim() === '' ? null : Number(raw))
  assert.equal(parse(null), null)
  assert.equal(parse(''), null)
  assert.equal(parse('   '), null)
  assert.equal(parse('8375'), 8375)
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
