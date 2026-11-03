/**
 * Steps ④ and ⑤ — everything that talks to GitHub.
 *
 * Design constraints, in priority order:
 *   1. **No token, no silent failure.** Every function returns a structured
 *      `{ ok: false, needsAuth: true, ... }` rather than throwing, and the local
 *      half of the product (scan → check → generate) never calls this module.
 *   2. **Read before write.** Fork/commit/PR are all preceded by a check that
 *      says what will happen, so the wizard can show a plan the user approves.
 *   3. **Idempotent where it can be.** Re-running a submission reuses an existing
 *      fork, an existing branch, and an already-open PR instead of opening a
 *      duplicate.
 *
 * The token is never logged, never written to disk by this module, and never put
 * into a URL. It travels in an Authorization header only.
 *
 * @module lib/github.js
 */

const API = 'https://api.github.com'
const UA = 'dsh-onshelf'

/** The list this plugin submits to. */
export const AWESOME_REPO = { owner: 'awesome-dsh-plugin', repo: 'awesome-dsh-plugin' }

/** A thin GitHub REST client with the failure shape the UI expects. */
export function createClient(token, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const api = options.api ?? API

  async function request(method, pathOrUrl, body, extraHeaders = {}) {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : `${api}${pathOrUrl}`
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': UA,
      ...extraHeaders,
    }
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'

    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      return { ok: false, status: 0, error: `网络请求失败：${error?.message ?? error}` }
    }

    if (response.status === 204) return { ok: true, status: 204, data: null }

    const text = await response.text()
    let data = null
    if (text) {
      try { data = JSON.parse(text) } catch { data = text }
    }

    if (!response.ok) {
      const message = typeof data === 'object' && data?.message ? data.message : `HTTP ${response.status}`
      const result = { ok: false, status: response.status, error: message, data }
      if (response.status === 401) result.needsAuth = true
      if (response.status === 403) {
        const remaining = response.headers?.get?.('x-ratelimit-remaining')
        if (remaining === '0') {
          result.rateLimited = true
          result.error = 'GitHub API 速率限制已用尽；未登录时每小时 60 次，请提供 token 或稍后再试。'
        }
      }
      return result
    }
    return { ok: true, status: response.status, data, headers: response.headers }
  }

  return {
    request,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    patch: (path, body) => request('PATCH', path, body),
    del: (path) => request('DELETE', path),
  }
}

/**
 * Verify a token and read the identity behind it. This is the one call the wizard
 * makes as soon as a token is pasted, so a bad token is caught before any work.
 */
export async function whoami(client) {
  const res = await client.get('/user')
  if (!res.ok) {
    if (res.status === 401) return { ok: false, needsAuth: true, error: 'token 无效或已过期' }
    return { ok: false, error: res.error }
  }
  const scopes = res.headers?.get?.('x-oauth-scopes') ?? ''
  return {
    ok: true,
    login: res.data.login,
    name: res.data.name,
    avatarUrl: res.data.avatar_url,
    scopes: scopes ? scopes.split(',').map(s => s.trim()).filter(Boolean) : [],
  }
}

/**
 * Read the facts CI checks but that only GitHub knows: repo age and topics.
 * Returns `{ ageDays, topics, archived, defaultBranch }` so the rulebook can be
 * run with real data instead of guesses.
 */
export async function repoFacts(client, owner, repo) {
  const res = await client.get(`/repos/${owner}/${repo}`)
  if (!res.ok) {
    if (res.status === 404) return { ok: false, notFound: true, error: `仓库不存在或无权访问：${owner}/${repo}` }
    return { ok: false, error: res.error }
  }
  const createdAt = Date.parse(res.data.created_at)
  const ageDays = Number.isFinite(createdAt) ? (Date.now() - createdAt) / 86_400_000 : null
  return {
    ok: true,
    owner,
    repo,
    fullName: res.data.full_name,
    ageDays,
    createdAt: res.data.created_at,
    topics: Array.isArray(res.data.topics) ? res.data.topics : [],
    archived: res.data.archived === true,
    defaultBranch: res.data.default_branch ?? 'main',
    stargazers: res.data.stargazers_count ?? 0,
    fork: res.data.fork === true,
  }
}

/**
 * Add a topic to a repository.
 *
 * `contributing.md` requires the `dsh-plugin` topic, and it is a one-line API call —
 * so telling the author "go to About → Topics → type it → save" is asking them to do
 * something the tool can do. Adding it needs the same Administration permission that
 * creating a repo already needs.
 *
 * Idempotent: an existing topic is reported as already there rather than re-sent.
 */
export async function addRepoTopic(client, owner, repo, topic = 'dsh-plugin') {
  const info = await client.get(`/repos/${owner}/${repo}`)
  if (!info.ok) {
    return { ok: false, error: info.error, needsAuth: info.needsAuth, status: info.status }
  }
  const current = Array.isArray(info.data.topics) ? info.data.topics : []
  if (current.includes(topic)) return { ok: true, already: true, topics: current }

  const next = [...current, topic]
  const res = await client.put(`/repos/${owner}/${repo}/topics`, { names: next })
  if (!res.ok) {
    // 403/404 here almost always means the token cannot change repository settings.
    const hint = res.needsAuth || res.status === 403 || res.status === 404
      ? `添加 topic 失败：token 没有修改仓库设置的权限（fine-grained token 需要 Administration: read/write）`
      : `添加 topic 失败：${res.error}`
    return { ok: false, error: hint, needsAuth: res.needsAuth, status: res.status }
  }
  return {
    ok: true,
    already: false,
    topics: Array.isArray(res.data?.names) ? res.data.names : next,
  }
}

/** Create (or reuse) the user's fork of a repo. Returns `{ owner, repo, reused }`. */
export async function ensureFork(client, owner, repo, login) {
  const existing = await client.get(`/repos/${login}/${repo}`)
  if (existing.ok && existing.data?.fork === true) {
    return { ok: true, owner: login, repo, reused: true }
  }

  const res = await client.post(`/repos/${owner}/${repo}/forks`, {})
  if (!res.ok) {
    // 403 with a message about an existing fork is a race, not a failure.
    if (res.status === 403 || res.status === 422) {
      const retry = await client.get(`/repos/${login}/${repo}`)
      if (retry.ok) return { ok: true, owner: login, repo, reused: true }
    }
    return { ok: false, error: `创建 fork 失败：${res.error}`, needsAuth: res.needsAuth }
  }
  return { ok: true, owner: login, repo, reused: false, waiting: true }
}

/** GitHub forks take a few seconds to become usable; poll the branch endpoint. */
export async function waitForFork(client, owner, repo, { timeoutMs = 60_000, intervalMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    const res = await client.get(`/repos/${owner}/${repo}`)
    if (res.ok) return { ok: true, defaultBranch: res.data.default_branch ?? 'main' }
    lastError = res.error
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return { ok: false, error: `fork 迟迟未就绪：${lastError ?? '超时'}` }
}

/** Read a file's content + blob sha, or `null` when it does not exist. */
export async function readFile(client, owner, repo, path, ref) {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const res = await client.get(`/repos/${owner}/${repo}/contents/${encodePath(path)}${query}`)
  if (!res.ok) {
    if (res.status === 404) return { ok: true, exists: false, content: null, sha: null }
    return { ok: false, error: res.error }
  }
  if (Array.isArray(res.data)) return { ok: false, error: `${path} 是目录，不是文件` }
  const content = res.data.content
    ? Buffer.from(res.data.content, res.data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
    : ''
  return { ok: true, exists: true, content, sha: res.data.sha, size: res.data.size }
}

/**
 * Write one or more files on a branch in a single commit.
 *
 * Uses the Git Data API (tree → commit → ref) rather than the Contents API so
 * several files land in one commit and binary screenshots can be uploaded without
 * base64 round-tripping through the Contents endpoint.
 */
export async function commitFiles(client, owner, repo, { branch, baseBranch, message, files, author, preferExistingBranch = false }) {
  // An update must build on the branch's own head, not on the base branch: starting
  // from `baseBranch` would replay the whole change and, worse, drop anything the
  // branch already carried (for example a maintainer's requested edit).
  let effectiveBase = baseBranch
  if (preferExistingBranch && branch) {
    const own = await client.get(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)
    if (own.ok) effectiveBase = branch
  }

  const base = await client.get(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(effectiveBase)}`)
  if (!base.ok) {
    // 409 means the base branch has no commits yet — every git-data call will fail
    // until one exists, so say that plainly instead of surfacing "Git Repository is
    // empty" from whichever endpoint happened to run first.
    if (base.status === 409) {
      return {
        ok: false,
        reason: 'repo-empty',
        error: `仓库 ${owner}/${repo} 还没有任何提交。先上传一次代码（③ 里的「建仓并上传」）再来这一步。`,
      }
    }
    return { ok: false, error: `读不到 ${effectiveBase} 分支：${base.error}` }
  }
  const baseSha = base.data.object.sha

  const baseCommit = await client.get(`/repos/${owner}/${repo}/git/commits/${baseSha}`)
  if (!baseCommit.ok) return { ok: false, error: `读不到基线提交：${baseCommit.error}` }

  const tree = []
  for (const file of files) {
    if (file.encoding === 'base64') {
      const blob = await client.post(`/repos/${owner}/${repo}/git/blobs`, {
        content: file.content,
        encoding: 'base64',
      })
      if (!blob.ok) return { ok: false, error: `上传 ${file.path} 失败：${blob.error}` }
      tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.data.sha })
    } else {
      tree.push({ path: file.path, mode: '100644', type: 'blob', content: file.content })
    }
  }

  const newTree = await client.post(`/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseCommit.data.tree.sha,
    tree,
  })
  if (!newTree.ok) return { ok: false, error: `创建 tree 失败：${newTree.error}` }

  const commit = await client.post(`/repos/${owner}/${repo}/git/commits`, {
    message,
    tree: newTree.data.sha,
    parents: [baseSha],
    ...(author ? { author } : {}),
  })
  if (!commit.ok) return { ok: false, error: `创建 commit 失败：${commit.error}` }

  // Create the branch, or fast-forward it if it already exists.
  const existing = await client.get(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)
  if (existing.ok) {
    const updated = await client.patch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      sha: commit.data.sha,
      force: true,
    })
    if (!updated.ok) return { ok: false, error: `更新分支失败：${updated.error}` }
  } else {
    const created = await client.post(`/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commit.data.sha,
    })
    if (!created.ok) return { ok: false, error: `创建分支失败：${created.error}` }
  }

  return { ok: true, branch, sha: commit.data.sha, commitUrl: commit.data.html_url }
}

/**
 * Open a PR, or return the existing open one for the same head.
 * Re-running a submission must not create a second PR.
 */
export async function ensurePullRequest(client, owner, repo, { head, base, title, body }) {
  const existing = await client.get(
    `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${head.owner}:${head.branch}`)}&base=${encodeURIComponent(base)}`,
  )
  if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
    const pr = existing.data[0]
    return { ok: true, reused: true, number: pr.number, url: pr.html_url }
  }

  const res = await client.post(`/repos/${owner}/${repo}/pulls`, {
    title,
    head: `${head.owner}:${head.branch}`,
    base,
    body,
  })
  if (!res.ok) {
    return { ok: false, error: `创建 PR 失败：${res.error}`, needsAuth: res.needsAuth, data: res.data }
  }
  return { ok: true, reused: false, number: res.data.number, url: res.data.html_url }
}

/** Does an entry file already exist in the target repo? Prevents duplicates. */
export async function entryExists(client, owner, repo, entryFile) {
  const res = await readFile(client, owner, repo, `data/plugins/${entryFile}`)
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, exists: res.exists, content: res.content, sha: res.sha }
}

/* ─────────────────── CI status: what happened to my PR ─────────────────── */

/**
 * Map a GitHub checks/status state onto the four words that matter to the author.
 *
 * GitHub spreads this across two systems (`check_runs` from Actions, `statuses` from
 * older integrations), each with its own vocabulary, and the PR page merges them. A
 * single verdict lets the wizard say "waiting" / "passed" / "failed" without the
 * author learning any of that.
 */
function verdictOf({ total, failing, pending, neutral }) {
  if (total === 0) return 'none'
  if (failing > 0) return 'failed'
  if (pending > 0) return 'pending'
  if (neutral > 0 && total === neutral) return 'neutral'
  return 'passed'
}

/** Normalise one check run into the shape the UI shows. */
function normaliseCheckRun(run) {
  const conclusion = run.conclusion ?? null
  return {
    name: String(run.name ?? 'check'),
    source: 'check_run',
    status: String(run.status ?? '').toLowerCase(),
    conclusion: conclusion ? String(conclusion).toLowerCase() : null,
    url: run.html_url ?? run.details_url ?? null,
    summary: typeof run.output?.summary === 'string' ? run.output.summary.slice(0, 2000) : null,
    title: typeof run.output?.title === 'string' ? run.output.title : null,
    text: typeof run.output?.text === 'string' ? run.output.text.slice(0, 4000) : null,
  }
}

/** Normalise one legacy commit status. */
function normaliseStatus(st) {
  return {
    name: String(st.context ?? 'status'),
    source: 'status',
    status: 'completed',
    conclusion: st.state === 'success' ? 'success'
      : st.state === 'failure' ? 'failure'
        : st.state === 'pending' ? 'pending'
          : String(st.state ?? '').toLowerCase(),
    url: st.target_url ?? null,
    summary: typeof st.description === 'string' ? st.description : null,
    title: null,
    text: null,
  }
}

/**
 * Read the state of one pull request: is it open/merged/closed, and did CI pass?
 *
 * This exists because the author was being told to open the PR page and squint at a
 * red X. Everything needed is in three API responses; the interesting part is
 * turning "conclusion: failure" into something a person can act on.
 */
export async function prStatus(client, owner, repo, number) {
  const pr = await client.get(`/repos/${owner}/${repo}/pulls/${number}`)
  if (!pr.ok) {
    if (pr.status === 404) return { ok: false, notFound: true, error: `找不到 PR #${number}` }
    return { ok: false, error: pr.error, needsAuth: pr.needsAuth }
  }

  const headSha = pr.data.head?.sha ?? null
  const base = {
    ok: true,
    number: pr.data.number,
    url: pr.data.html_url,
    title: pr.data.title,
    state: pr.data.state,                       // open | closed
    merged: pr.data.merged === true,
    mergedAt: pr.data.merged_at ?? null,
    draft: pr.data.draft === true,
    mergeable: pr.data.mergeable ?? null,
    mergeableState: pr.data.mergeable_state ?? null,
    comments: pr.data.comments ?? 0,
    commits: pr.data.commits ?? null,
    changedFiles: pr.data.changed_files ?? null,
    headSha,
    headBranch: pr.data.head?.ref ?? null,
    author: pr.data.user?.login ?? null,
    createdAt: pr.data.created_at,
    updatedAt: pr.data.updated_at,
  }

  // Merged or closed: CI no longer matters, the outcome is decided.
  if (base.merged) {
    return { ...base, checks: { verdict: 'merged', total: 0, failing: 0, pending: 0, neutral: 0, items: [] } }
  }
  if (base.state === 'closed') {
    return { ...base, checks: { verdict: 'closed', total: 0, failing: 0, pending: 0, neutral: 0, items: [] } }
  }
  if (!headSha) {
    return { ...base, checks: { verdict: 'none', total: 0, failing: 0, pending: 0, neutral: 0, items: [] } }
  }

  // Two sources, merged. Either may be absent on a given repo.
  const [runs, statuses] = await Promise.all([
    client.get(`/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=50`),
    client.get(`/repos/${owner}/${repo}/commits/${headSha}/status`),
  ])

  const items = []
  if (runs.ok && Array.isArray(runs.data?.check_runs)) {
    for (const run of runs.data.check_runs) items.push(normaliseCheckRun(run))
  }
  if (statuses.ok && Array.isArray(statuses.data?.statuses)) {
    for (const st of statuses.data.statuses) items.push(normaliseStatus(st))
  }

  let failing = 0
  let pending = 0
  let neutral = 0
  for (const item of items) {
    if (item.source === 'check_run' && item.status !== 'completed') { pending++; continue }
    switch (item.conclusion) {
      case 'failure':
      case 'timed_out':
      case 'action_required':
      case 'error':
        failing++
        break
      case 'pending':
        pending++
        break
      case 'skipped':
      case 'cancelled':
      case 'neutral':
        neutral++
        break
      default:
        break
    }
  }

  return {
    ...base,
    checks: {
      verdict: verdictOf({ total: items.length, failing, pending, neutral }),
      total: items.length,
      failing,
      pending,
      neutral,
      items,
      // Turns of phrase the wizard would otherwise have to invent.
      failedItems: items.filter(i => ['failure', 'timed_out', 'action_required', 'error'].includes(i.conclusion)),
    },
  }
}

/**
 * Which branch, if any, already carries this entry — and does it have a PR?
 *
 * This is what makes an update a one-click affair instead of a guess:
 *   - an **open** PR from a previous attempt → push to that branch, the PR updates;
 *   - a **merged or closed** PR → the submission already happened; report it so the
 *     wizard can say "already listed" instead of "no PR found";
 *   - nothing at all → start from the list's current default branch.
 *
 * Looking only for *open* PRs was a real bug: once a submission was merged, checking
 * its status said "you haven't submitted yet", which is the one message that is
 * definitely wrong. Closed PRs are searched too, newest first.
 *
 * `branchNameCandidates` covers the older `-v<version>` shape so a branch created by a
 * previous version of this plugin is still found.
 */
export async function findExistingSubmission(client, login, repo, entryFile, version) {
  const candidates = branchNameCandidates(entryFile, version)
  const head = branch => encodeURIComponent(`${login}:${branch}`)
  const prUrl = `/repos/${AWESOME_REPO.owner}/${AWESOME_REPO.repo}/pulls`

  for (const branch of candidates) {
    // Does the fork actually carry this branch? An open PR whose head branch was
    // deleted is a stale ghost; trusting the PR list alone would report a PR that can
    // no longer be pushed to.
    const ref = await client.get(`/repos/${login}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)
    if (!ref.ok) continue

    // An open PR is what an update should push to.
    const open = await client.get(`${prUrl}?state=open&head=${head(branch)}`)
    const openPr = Array.isArray(open.data) && open.data.length > 0 ? open.data[0] : null
    if (openPr) {
      return {
        ok: true,
        found: true,
        branch,
        branchExists: true,
        state: 'open',
        pr: { number: openPr.number, url: openPr.html_url },
      }
    }

    // A merged or closed PR means the submission already went through.
    const all = await client.get(`${prUrl}?state=all&head=${head(branch)}&sort=created&direction=desc`)
    if (Array.isArray(all.data) && all.data.length > 0) {
      const pr = all.data[0]
      return {
        ok: true,
        found: true,
        branch,
        branchExists: true,
        state: pr.merged_at ? 'merged' : 'closed',
        pr: { number: pr.number, url: pr.html_url, merged: Boolean(pr.merged_at), state: pr.state },
      }
    }
  }

  // The fork may carry no branch at all (a fresh clone, or a branch since deleted),
  // yet the submission can still exist. Fall back to the list's own entry: if the
  // file is there, it was listed — and the most useful thing we can say is "already
  // in", plus the entry link, rather than "you have not submitted".
  const entry = await entryExists(client, AWESOME_REPO.owner, AWESOME_REPO.repo, entryFile)
  if (entry.ok && entry.exists) {
    // Try to recover the actual PR number from the fork's history, newest first.
    // Not finding it is fine: `listed: true` already answers the author's question.
    const search = await client.get(`${prUrl}?state=all&sort=created&direction=desc&per_page=100`)
    const basename = entryFile.replace(/\.yml$/, '')
    const matching = Array.isArray(search.data)
      ? search.data.find(pr => {
        const title = String(pr.title ?? '')
        const headRef = String(pr.head?.ref ?? '')
        return title.includes(basename) || headRef.includes(basename)
      })
      : null
    return {
      ok: true,
      found: true,
      branch: matching?.head?.ref ?? null,
      branchExists: false,
      state: matching
        ? (matching.merged_at ? 'merged' : String(matching.state ?? 'closed'))
        : 'listed',
      listed: true,
      pr: matching
        ? { number: matching.number, url: matching.html_url, merged: Boolean(matching.merged_at), state: matching.state }
        : null,
    }
  }

  return { ok: true, found: false, branch: null, branchExists: false, state: null, pr: null }
}

/**
 * Compare a freshly generated entry against the one already on the list.
 *
 * An existing entry is not an error — it means "this plugin is already listed, so
 * this submission is an **update**". What the author needs to know is whether the
 * update actually changes anything, because a PR that changes nothing wastes a
 * maintainer's review.
 */
export function diffEntry(existingYaml, newYaml) {
  const normalise = text => String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')

  const before = normalise(existingYaml)
  const after = normalise(newYaml)
  const beforeLines = before === '' ? [] : before.split('\n')
  const afterLines = after === '' ? [] : after.split('\n')

  const changed = []
  const max = Math.max(beforeLines.length, afterLines.length)
  for (let i = 0; i < max; i++) {
    const a = beforeLines[i]
    const b = afterLines[i]
    if (a === b) continue
    changed.push({ line: i + 1, from: a ?? null, to: b ?? null })
  }

  return {
    identical: before === after,
    changed,
    before,
    after,
  }
}

/**
 * The complete ④+⑤ plan, computed without writing anything.
 *
 * The wizard shows this before the user presses the button, so the confirmation
 * names every write: which fork, which branch, which files, which PR.
 */
export async function planSubmission(client, params) {
  const {
    login, target, entryFile, yaml, screenshots = [], screenshotBaseDir,
    prTitle, prBody, branchName,
  } = params

  const steps = []
  const warnings = []

  const ownRepo = await repoFacts(client, target.owner, target.repo)
  if (!ownRepo.ok) return { ok: false, error: ownRepo.error, needsAuth: ownRepo.needsAuth }
  if (ownRepo.archived) return { ok: false, error: `${target.slug} 已归档，收录会被定期清理` }

  // These two are the only CI checks the author cannot fix from inside the plugin —
  // except the topic, which is one API call, so the wizard offers a button for it.
  // Each warning says what to do and when it will be satisfied.
  if (ownRepo.ageDays !== null && ownRepo.ageDays < 1) {
    const hoursLeft = Math.max(1, Math.ceil((1 - ownRepo.ageDays) * 24))
    warnings.push(
      `仓库创建不满 1 天（现在 ${ownRepo.ageDays.toFixed(2)} 天，还差约 ${hoursLeft} 小时）。`
      + '这是 CI 的硬性门槛，任何人都绕不过；等满 1 天再推一次即可，不需要关掉重开 PR。',
    )
  }
  if (!ownRepo.topics.includes('dsh-plugin')) {
    warnings.push(
      '仓库缺少 dsh-plugin topic。点下面的「帮我加上 dsh-plugin topic」可以自动补（需要 Administration 权限）；'
      + '也可以手动在仓库页 About 的齿轮 → Topics 里加。',
    )
  }

  const repoStatus = {
    slug: target.slug,
    ageDays: ownRepo.ageDays,
    oldEnough: ownRepo.ageDays !== null && ownRepo.ageDays >= 1,
    topics: ownRepo.topics,
    hasTopic: ownRepo.topics.includes('dsh-plugin'),
  }

  const dup = await entryExists(client, AWESOME_REPO.owner, AWESOME_REPO.repo, entryFile)
  // An existing entry is not an error — it means this submission is an *update* to a
  // plugin already on the list. Report what would change so a no-op PR is caught
  // before it is opened.
  let mode = 'add'
  let diff = null
  if (dup.ok && dup.exists) {
    mode = 'update'
    diff = diffEntry(dup.content, yaml)
    if (diff.identical) {
      return {
        ok: false,
        duplicate: true,
        noChange: true,
        mode,
        diff,
        existing: dup.content,
        error: `列表里的 ${entryFile} 与你现在的条目完全一样，没有需要提交的改动。改了点描述或分类之后再来。`,
      }
    }
    warnings.push(`这是对已收录条目 ${entryFile} 的**更新**，会修改现有文件，不会新建第二个文件。`)
  }

  // If a previous attempt already opened a PR for this entry, push to that branch so
  // the PR gains a commit instead of a duplicate appearing next to it.
  const existingSubmission = await findExistingSubmission(
    client, login, AWESOME_REPO.repo, entryFile, params.version,
  )
  const targetBranch = existingSubmission.found
    ? existingSubmission.branch
    : branchName

  steps.push({ id: 'fork', label: `fork ${AWESOME_REPO.owner}/${AWESOME_REPO.repo} 到 ${login}/${AWESOME_REPO.repo}`, effect: 'write' })
  steps.push({
    id: 'branch',
    label: existingSubmission.found
      ? `复用已有分支 ${targetBranch}${existingSubmission.pr ? `（PR #${existingSubmission.pr.number} 会随提交更新）` : ''}`
      : `在 fork 上创建分支 ${targetBranch}`,
    effect: 'write',
  })
  steps.push({
    id: 'entry',
    label: mode === 'update'
      ? `更新 data/plugins/${entryFile}（${diff.changed.length} 行改动）`
      : `新增 data/plugins/${entryFile}`,
    effect: 'write',
    preview: yaml,
  })
  for (const shot of screenshots) {
    steps.push({ id: `shot:${shot}`, label: `上传截图 ${shot}`, effect: 'write' })
  }
  steps.push({
    id: 'pr',
    label: existingSubmission.pr
      ? `PR #${existingSubmission.pr.number} 会自动更新（不需要新开）`
      : (mode === 'update'
        ? `向 ${AWESOME_REPO.owner}/${AWESOME_REPO.repo} 开 PR（更新条目）`
        : `向 ${AWESOME_REPO.owner}/${AWESOME_REPO.repo} 开 PR`),
    effect: 'write',
    preview: prTitle,
  })

  return {
    ok: true,
    mode,
    diff,
    steps,
    warnings,
    repo: ownRepo,
    repoStatus,
    branch: targetBranch,
    existingSubmission,
    entryFile,
    prTitle,
    prBody,
    screenshotBaseDir,
  }
}

/**
 * Execute a planned submission.
 *
 * `files` are the writes for the fork: the entry YAML always, plus the
 * screenshots.json and image bytes when the user asked for step ④.
 */
export async function executeSubmission(client, plan, params) {
  const { login, target, entryFile, yaml, files = [], prTitle, prBody, branchName, baseBranch } = params

  const fork = await ensureFork(client, AWESOME_REPO.owner, AWESOME_REPO.repo, login)
  if (!fork.ok) return { ok: false, step: 'fork', error: fork.error, needsAuth: fork.needsAuth }

  if (fork.waiting) {
    const ready = await waitForFork(client, fork.owner, fork.repo)
    if (!ready.ok) return { ok: false, step: 'fork', error: ready.error }
  }

  const forkInfo = await repoFacts(client, fork.owner, fork.repo)
  if (!forkInfo.ok) return { ok: false, step: 'fork', error: forkInfo.error }
  const base = baseBranch ?? forkInfo.defaultBranch

  // `plan.branch` already resolved whether this is a fresh branch or an existing one
  // from an open PR; reuse it rather than recomputing, so plan and execution agree.
  const targetBranch = plan?.branch ?? branchName
  const reusingBranch = plan?.existingSubmission?.branchExists === true

  const commit = await commitFiles(client, fork.owner, fork.repo, {
    branch: targetBranch,
    baseBranch: base,
    message: prTitle,
    files: [
      { path: `data/plugins/${entryFile}`, content: yaml, encoding: 'utf8' },
      ...files,
    ],
    // Build on the branch's own head when it already exists, so an update is a real
    // additional commit rather than a replay of the original change.
    preferExistingBranch: reusingBranch,
  })
  if (!commit.ok) return { ok: false, step: 'commit', error: commit.error }

  const pr = await ensurePullRequest(client, AWESOME_REPO.owner, AWESOME_REPO.repo, {
    head: { owner: fork.owner, branch: targetBranch },
    base,
    title: prTitle,
    body: prBody,
  })
  if (!pr.ok) return { ok: false, step: 'pr', error: pr.error, commitUrl: commit.commitUrl, needsAuth: pr.needsAuth }

  return {
    ok: true,
    fork: `${fork.owner}/${fork.repo}`,
    branch: targetBranch,
    mode: plan?.mode ?? 'add',
    commitUrl: commit.commitUrl,
    prNumber: pr.number,
    prUrl: pr.url,
    reusedPr: pr.reused === true,
  }
}

/**
 * Step ④ on its own: upload screenshots into the *user's own* plugin repo, which
 * is where `screenshots.json` expects them. Kept separate because it is useful
 * without ever opening a PR to the list.
 */
export async function uploadScreenshots(client, params) {
  const { owner, repo, baseBranch, branchName, images, screenshotsPath, commitMessage } = params
  const files = images.map(img => ({
    path: img.path,
    content: img.base64,
    encoding: 'base64',
  }))
  if (screenshotsPath) {
    files.push({ path: 'screenshots.json', content: screenshotsPath, encoding: 'utf8' })
  }
  return commitFiles(client, owner, repo, {
    branch: branchName,
    baseBranch,
    message: commitMessage ?? 'docs: add storefront screenshots',
    files,
  })
}

/**
 * Branch names are predictable and **stable per entry**, deliberately without a
 * version.
 *
 * A versioned branch (`add-x-v0.1.0`, then `add-x-v0.1.1`, …) means every release of
 * the plugin opens a new branch and a new PR against the list. That is noise for the
 * maintainers and it looks like a spurious duplicate submission. One entry, one
 * branch: an update pushes to the same branch, so an open PR simply gains a commit,
 * and a merged entry opens a fresh PR from a clean branch.
 */
export function branchNameFor(entryFile) {
  const stem = entryFile.replace(/\.yml$/, '').replace(/[^\w.-]+/g, '-')
  return `add-${stem}`
}

/**
 * Every branch name this plugin may have used for an entry, newest convention first.
 *
 * Updates need to find a branch opened by an older version of this plugin (which
 * appended `-v<version>`), so the lookup tries all known shapes rather than assuming
 * the current one.
 */
export function branchNameCandidates(entryFile, version) {
  const stem = entryFile.replace(/\.yml$/, '').replace(/[^\w.-]+/g, '-')
  const names = [`add-${stem}`]
  if (version) names.push(`add-${stem}-v${String(version).replace(/[^\w.-]+/g, '-')}`)
  return names
}

/* ─────────────────────── putting the code on GitHub ─────────────────────── */

/**
 * Does `owner/name` exist, and if so is it empty?
 *
 * "Empty" means it has no commits on its default branch — the state a repository
 * created through the web UI without a README is in, and a different code path from
 * an existing history.
 *
 * **GitHub answers 409, not 404, for git-data endpoints on an empty repository**
 * ("Git Repository is empty"), and that applies to *every* git-data endpoint — the
 * ref lookup, blob creation, tree creation. Treating only 404 as empty meant a
 * brand-new repo was read as "has history", produced a bogus overwrite prompt, and
 * then failed the upload with the very 409 it had misread.
 */
export async function inspectTargetRepo(client, owner, name) {
  const info = await client.get(`/repos/${owner}/${name}`)
  if (!info.ok) {
    if (info.status === 404) return { ok: true, exists: false }
    return { ok: false, error: info.error }
  }
  const defaultBranch = info.data.default_branch ?? 'main'
  const size = info.data.size ?? 0
  const ref = await client.get(`/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(defaultBranch)}`)

  const refMissing = ref.status === 404 || ref.status === 409
  // A repo reporting zero size that also fails the ref lookup is empty. This is a
  // belt-and-braces check for the case where the ref endpoint answers with some
  // other error on a repo that has never been pushed to.
  const empty = refMissing || (!ref.ok && size === 0)

  return {
    ok: true,
    exists: true,
    empty,
    defaultBranch,
    private: info.data.private === true,
    htmlUrl: info.data.html_url,
    size,
    defaultBranchRef: empty ? null : (ref.ok ? ref.data?.object?.sha ?? null : null),
  }
}

/** Create a repository under the authenticated account. */
export async function createRepo(client, { name, private: isPrivate = false, description = '' }) {
  const res = await client.post('/user/repos', {
    name,
    private: isPrivate,
    description,
    // No README: we push a real tree, and an auto-init commit would make the first
    // push a merge instead of a clean root commit.
    auto_init: false,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
  })
  if (!res.ok) {
    const alreadyExists = res.status === 422 && /already exists/i.test(String(res.error))
    return {
      ok: false,
      alreadyExists,
      error: alreadyExists ? `仓库 ${name} 已经存在` : `创建仓库失败：${res.error}`,
      needsAuth: res.needsAuth,
    }
  }
  return {
    ok: true,
    owner: res.data.owner.login,
    name: res.data.name,
    private: res.data.private,
    defaultBranch: res.data.default_branch ?? 'main',
    htmlUrl: res.data.html_url,
  }
}

/**
 * Push a set of files to a repository's default branch in one commit.
 *
 * Handles the empty-repository case (a root commit plus the first ref) because that
 * is exactly what a freshly created repo looks like — and the case that breaks every
 * naive "just use the Contents API" implementation.
 *
 * `allowOverwrite` is required to touch a repository that already has commits: this
 * writes to the author's own repo, and silently replacing a history would be a
 * destructive thing for a helper to do.
 */
export async function pushFiles(
  client, owner, repo,
  { branch, message, files, allowOverwrite = false, onProgress, concurrency = 4 },
) {
  const info = await inspectTargetRepo(client, owner, repo)
  if (!info.ok) return { ok: false, error: info.error }

  const targetBranch = branch ?? (info.exists ? info.defaultBranch : 'main')
  if (info.exists && !info.empty && !allowOverwrite) {
    return {
      ok: false,
      reason: 'repo-not-empty',
      error: `仓库 ${owner}/${repo} 里已经有提交了，不会覆盖它。`,
      existingBranch: targetBranch,
    }
  }

  // ── empty repository: the git-data API cannot write to it at all ──
  //
  // Every `/git/*` endpoint answers 409 "Git Repository is empty" until the repo has
  // one commit, so blobs must wait. The only door in is the Contents API, which
  // commits a file directly. We use it to create that first commit from the real
  // files, then the normal tree path is available for everything that follows.
  if (info.empty) {
    const seeded = await seedEmptyRepo(client, owner, repo, { branch: targetBranch, files, message, onProgress })
    if (!seeded.ok) return seeded
    return {
      ok: true,
      owner,
      repo,
      branch: targetBranch,
      files: files.length,
      root: true,
      seededViaContentsApi: true,
      commitSha: seeded.commitSha,
      commitUrl: seeded.commitUrl,
    }
  }

  // Blobs. Binary and text both travel base64, which is the only encoding the
  // blobs endpoint accepts for binary content. A small pool keeps the wall time
  // down: one request per file is slow enough to look frozen on a phone link.
  const tree = new Array(files.length)
  let next = 0
  let done = 0
  let failure = null

  const worker = async () => {
    while (failure === null) {
      const index = next++
      if (index >= files.length) return
      const file = files[index]
      const blob = await client.post(`/repos/${owner}/${repo}/git/blobs`, {
        content: file.base64,
        encoding: 'base64',
      })
      if (!blob.ok) {
        failure = { ok: false, error: `上传 ${file.path} 失败：${blob.error}`, failedPath: file.path }
        return
      }
      tree[index] = { path: file.path, mode: '100644', type: 'blob', sha: blob.data.sha }
      done++
      onProgress?.({ phase: 'blobs', done, total: files.length, current: file.path })
    }
  }

  onProgress?.({ phase: 'blobs', done: 0, total: files.length })
  const poolSize = Math.max(1, Math.min(concurrency, files.length || 1))
  await Promise.all(Array.from({ length: poolSize }, worker))
  if (failure) return failure

  onProgress?.({ phase: 'tree', done, total: files.length })

  // A root commit has no parent. Deciding this from the *absence of a commit sha*
  // rather than from `empty` alone keeps a mis-detected empty repo from producing
  // `parents: [null]`, which the API rejects with a 422 nobody can interpret.
  const isRoot = !info.exists || info.empty || !info.defaultBranchRef
  let baseTreeSha = null
  if (!isRoot && info.defaultBranchRef) {
    const baseCommit = await client.get(`/repos/${owner}/${repo}/git/commits/${info.defaultBranchRef}`)
    if (!baseCommit.ok) return { ok: false, error: `读不到基线提交：${baseCommit.error}` }
    baseTreeSha = baseCommit.data.tree.sha
  }

  const newTree = await client.post(`/repos/${owner}/${repo}/git/trees`, {
    tree,
    ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
  })
  if (!newTree.ok) return { ok: false, error: `创建 tree 失败：${newTree.error}` }

  const commit = await client.post(`/repos/${owner}/${repo}/git/commits`, {
    message,
    tree: newTree.data.sha,
    // A root commit has no parents. Omitting the field entirely is what the API
    // expects here — an empty array is not the same thing.
    ...(isRoot ? {} : { parents: [info.defaultBranchRef] }),
  })
  if (!commit.ok) return { ok: false, error: `创建 commit 失败：${commit.error}` }

  onProgress?.({ phase: 'ref', done, total: files.length })

  if (isRoot) {
    const ref = await client.post(`/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${targetBranch}`,
      sha: commit.data.sha,
    })
    if (!ref.ok) {
      // The branch may have appeared between our inspection and now (repo created
      // in another tab, or a retry after a partial failure). Point the existing ref
      // at our commit instead of failing an upload that actually worked.
      if (ref.status === 422) {
        const updated = await client.patch(
          `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(targetBranch)}`,
          { sha: commit.data.sha, force: true },
        )
        if (!updated.ok) return { ok: false, error: `创建分支失败：${ref.error}` }
      } else {
        return { ok: false, error: `创建分支失败：${ref.error}` }
      }
    }
  } else {
    const ref = await client.patch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(targetBranch)}`, {
      sha: commit.data.sha,
    })
    if (!ref.ok) return { ok: false, error: `更新分支失败：${ref.error}` }
  }

  return {
    ok: true,
    owner,
    repo,
    branch: targetBranch,
    files: files.length,
    root: isRoot,
    commitSha: commit.data.sha,
    commitUrl: commit.data.html_url,
  }
}

/**
 * Give a brand-new repository its first commit.
 *
 * The git-data API is unusable before that first commit exists: blobs, trees, commits
 * and refs all answer **409 "Git Repository is empty"**. Only the Contents API can
 * create content in that state, because it commits for you.
 *
 * So: commit the first file through the Contents API (that also creates the branch),
 * then hand the remaining files to the normal blob/tree/commit path. Two commits
 * instead of one — a cosmetic price for actually working on an empty repo.
 */
async function seedEmptyRepo(client, owner, repo, { branch, files, message, onProgress }) {
  if (files.length === 0) return { ok: false, error: '没有可上传的文件' }

  // Pick a stable first file: package.json if present, else the first path.
  const firstIndex = Math.max(0, files.findIndex(f => f.path === 'package.json'))
  const first = files[firstIndex]
  const rest = files.filter((_, i) => i !== firstIndex)

  onProgress?.({ phase: 'blobs', done: 0, total: files.length, current: first.path })

  const created = await client.put(
    `/repos/${owner}/${repo}/contents/${encodePath(first.path)}`,
    {
      message: rest.length === 0 ? message : `${message} (1/${files.length})`,
      content: first.base64,
      encoding: 'base64',
      branch,
    },
  )
  if (!created.ok) {
    return { ok: false, error: `创建首个提交失败：${created.error}`, failedPath: first.path }
  }

  const firstCommit = created.data?.commit?.sha ?? null
  const firstCommitUrl = created.data?.commit?.html_url ?? null
  onProgress?.({ phase: 'blobs', done: 1, total: files.length, current: first.path })

  if (rest.length === 0) {
    return { ok: true, commitSha: firstCommit, commitUrl: firstCommitUrl }
  }

  // The repo now has a commit, so the git-data path works.
  const info = await inspectTargetRepo(client, owner, repo)
  if (!info.ok) return { ok: false, error: info.error }
  if (!info.defaultBranchRef) {
    return { ok: false, error: '首个提交之后仍读不到分支，可能 token 权限不足。' }
  }

  const tree = []
  let done = 1
  for (const file of rest) {
    const blob = await client.post(`/repos/${owner}/${repo}/git/blobs`, {
      content: file.base64,
      encoding: 'base64',
    })
    if (!blob.ok) {
      return {
        ok: false,
        error: `上传 ${file.path} 失败：${blob.error}（首个提交已建立，可重试）`,
        failedPath: file.path,
        partial: true,
        commitUrl: firstCommitUrl,
      }
    }
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.data.sha })
    done++
    onProgress?.({ phase: 'blobs', done, total: files.length, current: file.path })
  }

  const baseCommit = await client.get(`/repos/${owner}/${repo}/git/commits/${info.defaultBranchRef}`)
  if (!baseCommit.ok) return { ok: false, error: `读不到基线提交：${baseCommit.error}` }

  const newTree = await client.post(`/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseCommit.data.tree.sha,
    tree,
  })
  if (!newTree.ok) return { ok: false, error: `创建 tree 失败：${newTree.error}` }

  const commit = await client.post(`/repos/${owner}/${repo}/git/commits`, {
    message,
    tree: newTree.data.sha,
    parents: [info.defaultBranchRef],
  })
  if (!commit.ok) return { ok: false, error: `创建 commit 失败：${commit.error}` }

  const ref = await client.patch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    sha: commit.data.sha,
  })
  if (!ref.ok) return { ok: false, error: `更新分支失败：${ref.error}` }

  return { ok: true, commitSha: commit.data.sha, commitUrl: commit.data.html_url }
}

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/')
}
