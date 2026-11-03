/**
 * 上架台 / dsh-onshelf — browser half.
 *
 * One Settings section that walks the five steps as a wizard: pick a plugin,
 * read the findings, review the generated entry, connect GitHub, submit. All data
 * comes from the plugin's own same-origin `/api/onshelf/*` routes.
 *
 * Hand-written ModuleLoader bundle: no build step, and the only dependency is the
 * `react` the shell already provides. Every colour is a theme token so the page
 * survives a light/dark switch.
 *
 * @module client.js
 */

window.__ModuleLoader__.load({
  id: 'dsh-onshelf',
  factory: require => {
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useMemo } = React

    const API = '/api/onshelf'

    const T = {
      zh: {
        nav: '上架台',
        title: '上架台',
        subtitle: '把本地插件一路送到 awesome-dsh-plugin：扫描 → 体检 → 生成材料 → 上传截图 → 开 PR。',
        step1: '① 扫描',
        step2: '② 体检',
        step3: '③ 投稿材料',
        step4: '④ 截图',
        step5: '⑤ 提交 PR',
        rescan: '重新扫描',
        scanning: '扫描中…',
        scanRoots: '扫描目录',
        rootsEdit: '修改扫描目录',
        rootsHide: '收起扫描目录',
        rootsEmpty: '还没有扫描目录。加一个你存放插件的文件夹。',
        rootsPlaceholder: '例如 D:\\DeepSeek\\harness',
        rootsHint: '默认是「本插件所在的上一级目录」——本地插件通常放在一起。装进 node_modules 的别人插件会排在后面并标记「已安装」。',
        rootsFromConfig: '扫描目录由插件配置（cordis.patch.yml）指定，不能在这里改。',
        rootAdd: '添加',
        rootRemove: '移除',
        tagInstalled: '已安装',
        tagLinked: '链接',
        progressStarting: '正在枚举目录…',
        progressDirs: '已扫描目录',
        progressFound: '已找到候选',
        progressRoot: '目录',
        scannedDirs: '扫描目录数',
        tookMs: '用时',
        needSelection: '先在 ① 扫描里选一个插件，再回到这一步。',
        checkNeeded: '还没有对选中的插件做体检。点下面的「开始体检」。',
        entryNeeded: '还没有生成投稿材料。先回到 ② 体检，点「③ 投稿材料 →」。',
        applying: '正在修复…',
        applyFile: '自动修复',
        applyDraft: '自动填写',
        fixNone: '没有可自动修复项',
        publishTitle: '把代码放到 GitHub',
        publishNote: '没有建仓库、也不会用 git？这里可以直接建好仓库并把整个插件目录推上去。推的是你本机的代码，node_modules 和 .git 不会上传。',
        publishOpen: '创建仓库并上传代码',
        publishRepoName: '仓库名',
        publishPrivate: '新建仓库时建成私有仓库（awesome 列表只收公开仓库）',
        publishPreview: '先看一眼要上传什么',
        publishGo: '建仓并上传',
        publishing: '处理中…',
        publishNeedsToken: '这一步需要 GitHub token（建议 fine-grained，带 Contents 与 Administration 读写权限）。',
        publishPlanTitle: '即将执行',
        publishWillCreate: '将新建仓库',
        publishWillPush: '将推送到已有仓库',
        publishFiles: '个文件',
        publishPublic: '公开仓库',
        publishPrivateRepo: '私有仓库',
        publishSkipped: '不会上传',
        publishDone: '已上传',
        publishOverwrite: '确认覆盖仓库里已有的内容',
        publishExistsVisibility: '已有仓库的可见性由 GitHub 上的设置决定，这里不会改动它。',
        tokenScopes: 'fine-grained token 需要 Contents 与 Administration 的读写权限；经典 token 勾选 repo 即可。',
        publishPreparing: '正在准备…',
        publishFieldWritten: '已把 repository 字段写进 package.json，并随这次提交一起上传。',
        artifactsNote: '这两份是成品，不需要你填写。',
        artifactsNoteHint: '「条目文件」会由第 ⑤ 步写进 awesome 列表的 data/plugins/ 里；「PR 描述」会成为那个 PR 的正文。点「复制」只是让你确认内容、或者不想给 token 时自己照着提 PR。',
        useSuggested: '改用推荐的分类',
        screenshotDropHint: '（可直接粘贴或拖入图片）',
        shotDropTitle: '把截图拖到这里，或点一下选择文件',
        shotDropHint: '也支持在这个框里按 Ctrl+V 直接粘贴截图。图片会保存到插件的 assets/ 目录。',
        shotSaving: '正在保存图片…',
        shotPick: '选择图片',
        shotRemove: '移除这张',
        shotsReady: '将上传',
        shotUnit: '张截图',
        shotsNone: '还没有截图。',
        shotsNoneHint: '把图片粘贴或拖到上面的框里，会自动保存到插件的 assets/ 目录。',
        shotsGoStep4: '去 ④ 截图',
        shotsMovedHint: '截图在 ④ 截图 里添加（粘贴 / 拖入 / 选择文件都可以）。',
        shotsStep4Note: '截图会推到你自己的插件仓库（不是 awesome 列表），以后换图不用再提 PR。在这里粘贴、拖入或选择图片，即可保存并预览。',
        found: '可收录候选',
        nearMisses: '近失（只声明了 dsh.client，无法安装）',
        noFound: '没找到声明了 dsh.bundle 的插件目录。',
        noNearMiss: '没有近失。',
        pick: '选择',
        picked: '已选',
        check: '开始体检',
        checking: '体检中…',
        fixAll: '一键修复',
        fixing: '修复中…',
        undoFix: '撤销修复',
        errors: '错误',
        warns: '警告',
        infos: '提示',
        blocked: '有阻塞性错误，CI 会拒绝',
        passed: '没有阻塞性错误',
        category: '分类',
        categoryAuto: '自动推荐',
        descEn: '英文描述（必填）',
        descZh: '中文描述（可选，但影响点击率）',
        repo: 'GitHub 仓库',
        repoPlaceholder: 'owner/repo 或 https://github.com/owner/repo',
        subpath: '子包路径（monorepo 才需要）',
        screenshots: '截图路径（每行一个，1-8 张）',
        tarball: 'Release tarball（可选）',
        preview: '生成投稿材料',
        previewing: '生成中…',
        entryFile: '条目文件',
        prDraft: 'PR 描述',
        copy: '复制',
        copied: '已复制',
        token: 'GitHub token',
        tokenPlaceholder: '粘贴 fine-grained token（Contents + Pull requests 读写）',
        tokenNote: 'token 只在本次会话内存里，不落盘、不写日志。①②③ 步完全不需要它。',
        connect: '验证 token',
        connecting: '验证中…',
        connected: '已连接',
        disconnect: '断开',
        submit: '创建 PR',
        submitting: '提交中…',
        submitPlan: '将要执行',
        modeAdd: '新增条目',
        modeUpdate: '更新已有条目',
        updateExplains: '这个插件已经在列表里，所以会修改现有条目（不会新建第二个文件）。',
        changedLines: '改动行数：',
        prCreated: 'PR 已创建',
        prReused: '这个分支已有的 PR 已更新',
        prCreatedHint: '这是成功，不是报错。PR 已经开在 awesome 列表仓库里。',
        willFailCi: '但这个 PR 现在会被 CI 拒绝',
        willFailCiHint: '原因不在你的插件代码，而是下面两条仓库条件。按顺序处理完，再把同一个分支推一次，CI 就会重跑——不需要关掉重开 PR。',
        recheckRepo: '重新检查仓库状态',
        addTopic: '帮我加上 dsh-plugin topic',
        topicAdded: '已加上 topic：',
        topicAlready: 'topic 已经有了，不用再加。',
        topicFailed: '加 topic 失败：',
        privacyFound: '发现',
        privacyCount: '处只对本机成立的细节',
        privacyHint: '安装路径、`C:\\Users\\你的用户名`、或「这台机器上有 N 个」这类数字——读到的人用不上，还可能暴露你的用户名。改成通用写法更合适。',
        privacyMore: '另有',
        privacyNotBlocking: '不影响上传，可以照常继续。',
        checkPr: '查看 PR 状态',
        checkingPr: '查询中…',
        prComments: '条评论',
        nextSteps: '下一步',
        viewOnGithub: '在 GitHub 上查看这条检查 →',
        repush: '再推一次（修好后重跑 CI）',
        repoAge: '仓库年龄',
        repoTopics: '仓库 topic',
        days: '天',
        ageOk: '已满 1 天',
        ageNotYet: '还不满 1 天，等满再来',
        topicMissing: '缺少 dsh-plugin',
        readyToRepush: '两条都满足了：现在回到 ⑤ 点「创建 PR」再推一次，CI 会在同一个 PR 上重跑。',
        ciNote: '提交后 CI 会依次检查：条目数（≤3）→ dsh.bundle → 仓库年龄 → awesome-lint 与站点构建。失败会指出要改什么，在同一个分支 push 修复即可，不用重开 PR。',
        dryRun: '先演练一遍',
        uploaded: '截图已上传',
        uploading: '上传中…',
        uploadShots: '上传截图到我的仓库',
        claimsTitle: '描述里的可核实声明',
        claimsNote: '评审会对着代码核对下面这些；确认它们属实再提交。',
        sourcesTitle: '描述来源',
        noClaims: '没有可核实的数字或标识符。',
        loading: '加载中…',
        failed: '出错了',
        retry: '重试',
        optional: '可选',
        dir: '目录',
        version: '版本',
      },
      en: {
        nav: 'Onshelf',
        title: 'Onshelf',
        subtitle: 'Take a local plugin all the way to awesome-dsh-plugin: scan → check → prepare → screenshots → PR.',
        step1: '① Scan',
        step2: '② Check',
        step3: '③ Entry',
        step4: '④ Screenshots',
        step5: '⑤ Submit PR',
        rescan: 'Rescan',
        scanning: 'Scanning…',
        scanRoots: 'Scan roots',
        rootsEdit: 'Edit scan roots',
        rootsHide: 'Hide scan roots',
        rootsEmpty: 'No scan roots yet. Add the folder where you keep your plugins.',
        rootsPlaceholder: 'e.g. D:\\DeepSeek\\harness',
        rootsHint: 'The default is the folder above this plugin — local plugins are usually kept together. Plugins installed into node_modules are listed after yours and tagged "installed".',
        rootsFromConfig: 'Scan roots are set by the plugin config (cordis.patch.yml) and cannot be edited here.',
        rootAdd: 'Add',
        rootRemove: 'Remove',
        tagInstalled: 'installed',
        tagLinked: 'linked',
        progressStarting: 'Enumerating directories…',
        progressDirs: 'directories scanned',
        progressFound: 'candidates found',
        progressRoot: 'root',
        scannedDirs: 'Directories scanned',
        tookMs: 'took',
        needSelection: 'Pick a plugin in ① Scan first, then come back to this step.',
        checkNeeded: 'This plugin has not been checked yet. Press "Run checks" below.',
        entryNeeded: 'No entry generated yet. Go back to ② Check and press "③ Entry →".',
        applying: 'Fixing…',
        applyFile: 'Fix automatically',
        applyDraft: 'Fill automatically',
        fixNone: 'Nothing auto-fixable',
        publishTitle: 'Put the code on GitHub',
        publishNote: 'No repo yet, or no idea how to use git? This creates the repository and pushes the whole plugin directory. It uploads your local code; node_modules and .git are left out.',
        publishOpen: 'Create a repo and upload the code',
        publishRepoName: 'Repository name',
        publishPrivate: 'Create as a private repo (the awesome list only accepts public repos)',
        publishPreview: 'Show me what will be uploaded',
        publishGo: 'Create and upload',
        publishing: 'Working…',
        publishNeedsToken: 'This step needs a GitHub token (fine-grained with Contents and Administration read/write).',
        publishPlanTitle: 'About to run',
        publishWillCreate: 'will create the repository',
        publishWillPush: 'will push to the existing repository',
        publishFiles: 'files',
        publishPublic: 'public',
        publishPrivateRepo: 'private',
        publishSkipped: 'not uploaded',
        publishDone: 'Uploaded',
        publishOverwrite: 'Overwrite what is already in the repository',
        publishExistsVisibility: 'An existing repo keeps the visibility it already has; this does not change it.',
        tokenScopes: 'A fine-grained token needs Contents and Administration read/write; a classic token needs the repo scope.',
        publishPreparing: 'Preparing…',
        publishFieldWritten: 'The repository field was written into package.json and uploaded with this commit.',
        artifactsNote: 'Both of these are finished output — there is nothing for you to fill in.',
        artifactsNoteHint: 'The entry file is what step ⑤ writes into the awesome list under data/plugins/; the PR description becomes that pull request\'s body. "Copy" is only there so you can check the content, or submit the PR yourself if you would rather not hand over a token.',
        useSuggested: 'Use the suggested category',
        screenshotDropHint: '(paste or drop an image here)',
        shotDropTitle: 'Drop a screenshot here, or click to choose files',
        shotDropHint: 'You can also focus this box and press Ctrl+V to paste a screenshot. Images are saved into the plugin\'s assets/ folder.',
        shotSaving: 'Saving images…',
        shotPick: 'Choose images',
        shotRemove: 'Remove this one',
        shotsReady: 'Will upload',
        shotUnit: 'screenshots',
        shotsNone: 'No screenshots yet.',
        shotsNoneHint: 'Paste or drop an image into the box above; it is saved into the plugin\'s assets/ folder.',
        shotsGoStep4: 'Go to ④ Screenshots',
        shotsMovedHint: 'Screenshots are added on ④ Screenshots (paste, drop or pick a file).',
        shotsStep4Note: 'Screenshots are pushed to your own plugin repo (not the awesome list), so you never need a PR just to change an image. Paste, drop or pick images here to save and preview them.',
        found: 'Publishable candidates',
        nearMisses: 'Near misses (dsh.client only — not installable)',
        noFound: 'No directory declaring dsh.bundle was found.',
        noNearMiss: 'No near misses.',
        pick: 'Select',
        picked: 'Selected',
        check: 'Run checks',
        checking: 'Checking…',
        fixAll: 'Fix all',
        fixing: 'Fixing…',
        undoFix: 'Undo fixes',
        errors: 'Errors',
        warns: 'Warnings',
        infos: 'Notes',
        blocked: 'Blocking errors — CI will reject this',
        passed: 'No blocking errors',
        category: 'Category',
        categoryAuto: 'auto-suggested',
        descEn: 'English description (required)',
        descZh: 'Chinese description (optional, but drives clicks)',
        repo: 'GitHub repository',
        repoPlaceholder: 'owner/repo or https://github.com/owner/repo',
        subpath: 'Subpackage path (monorepos only)',
        screenshots: 'Screenshot paths (one per line, 1-8)',
        tarball: 'Release tarball (optional)',
        preview: 'Generate entry',
        previewing: 'Generating…',
        entryFile: 'Entry file',
        prDraft: 'PR description',
        copy: 'Copy',
        copied: 'Copied',
        token: 'GitHub token',
        tokenPlaceholder: 'Paste a fine-grained token (Contents + Pull requests read/write)',
        tokenNote: 'The token stays in this session\'s memory — never written to disk or logs. Steps ①②③ need no token at all.',
        connect: 'Verify token',
        connecting: 'Verifying…',
        connected: 'Connected',
        disconnect: 'Disconnect',
        submit: 'Open the PR',
        submitting: 'Submitting…',
        submitPlan: 'Will run',
        modeAdd: 'new entry',
        modeUpdate: 'update existing entry',
        updateExplains: 'This plugin is already on the list, so the existing entry is modified — no second file is added.',
        changedLines: 'changed lines:',
        prCreated: 'Pull request created',
        prReused: 'The open PR on this branch was updated',
        prCreatedHint: 'This is a success, not an error. The PR is open against the awesome list.',
        willFailCi: 'But CI will reject this PR right now',
        willFailCiHint: 'The cause is not your plugin\'s code — it is the two repository conditions below. Fix them in order, then push the same branch again and CI re-runs. You do not need to close and reopen the PR.',
        recheckRepo: 'Re-check repository status',
        addTopic: 'Add the dsh-plugin topic for me',
        topicAdded: 'Topic added:',
        topicAlready: 'The topic is already set.',
        topicFailed: 'Could not add the topic:',
        privacyFound: 'Found',
        privacyCount: 'machine-specific details',
        privacyHint: 'Install paths, `C:\\Users\\<your name>`, or figures like "this machine has N apps" — useless to a reader, and they can expose your user name. A generic wording reads better.',
        privacyMore: 'and',
        privacyNotBlocking: 'This does not block the upload; you can continue.',
        checkPr: 'Check PR status',
        checkingPr: 'Checking…',
        prComments: 'comments',
        nextSteps: 'Next steps',
        viewOnGithub: 'View this check on GitHub →',
        repush: 'Push again (re-runs CI after a fix)',
        repoAge: 'Repository age',
        repoTopics: 'Repository topics',
        days: 'days',
        ageOk: 'at least 1 day',
        ageNotYet: 'still under 1 day — come back later',
        topicMissing: 'dsh-plugin missing',
        readyToRepush: 'Both conditions are met: go back to ⑤ and press "Create PR" once more; CI re-runs on the same PR.',
        ciNote: 'CI checks, in order: entry count (≤3) → dsh.bundle → repository age → awesome-lint and the site build. A failure names exactly what to change; push a fix to the same branch — no need to open a new PR.',
        dryRun: 'Dry run first',
        uploaded: 'Screenshots uploaded',
        uploading: 'Uploading…',
        uploadShots: 'Upload screenshots to my repo',
        claimsTitle: 'Verifiable claims in the description',
        claimsNote: 'A maintainer checks these against your code. Confirm they are true before submitting.',
        sourcesTitle: 'Where the draft came from',
        noClaims: 'No numbers or identifiers to verify.',
        loading: 'Loading…',
        failed: 'Something went wrong',
        retry: 'Retry',
        optional: 'optional',
        dir: 'Directory',
        version: 'Version',
      },
    }

    const t = (locale, key) => (T[locale] ?? T.zh)[key] ?? key

    /**
     * Resolve the UI language.
     *
     * The settings slot hands the page a context whose `locale` service shape has
     * varied across harness versions: it may be a getter, a plain string, or an
     * object with a `locale` field. It may also be absent entirely, in which case
     * the document language is the only honest signal. Falling back to Chinese is
     * deliberate — this plugin is aimed at Chinese-speaking beginners — but it is
     * the *last* resort, not the first.
     */
    const localeTag = ctx => {
      const normalise = value => {
        const text = typeof value === 'string' ? value : String(value ?? '')
        if (text === '') return null
        return text.toLowerCase().startsWith('en') ? 'en' : 'zh'
      }
      try {
        const service = ctx?.get?.('locale')
        // Three shapes have shipped: a plain string, an object with a `get()`
        // method, and an object carrying a `locale` field. Read each one as itself
        // rather than assuming a method.
        let raw
        if (typeof service === 'string') raw = service
        else if (typeof service?.get === 'function') raw = service.get()
        else if (service && typeof service.locale === 'string') raw = service.locale
        const direct = normalise(raw)
        if (direct) return direct
      } catch { /* fall through to the document */ }
      try {
        const lang = globalThis?.document?.documentElement?.lang
          ?? globalThis?.navigator?.language
        const fromDocument = normalise(lang)
        if (fromDocument) return fromDocument
      } catch { /* no DOM (SSR / tests) */ }
      return 'zh'
    }

    /* ─────────────────────────── styles ─────────────────────────── */

    const BORDER = 'var(--dsw-alias-border-secondary, rgba(128,128,128,.25))'
    const ACCENT = 'var(--dsw-alias-bg-accent, #247bbf)'

    const S = {
      page: { padding: '20px 24px', maxWidth: 1000, color: 'var(--dsw-alias-text-primary, inherit)' },
      h1: { fontSize: 18, fontWeight: 600, margin: '0 0 4px' },
      sub: { fontSize: 13, opacity: 0.7, margin: '0 0 18px', lineHeight: 1.6 },
      steps: { display: 'flex', gap: 4, borderBottom: `1px solid ${BORDER}`, marginBottom: 16, flexWrap: 'wrap' },
      step: (on, done) => ({
        padding: '7px 12px', fontSize: 13, cursor: 'pointer', border: 'none', background: 'none',
        borderBottom: `2px solid ${on ? ACCENT : 'transparent'}`,
        color: 'inherit', opacity: on ? 1 : done ? 0.85 : 0.5, fontWeight: on ? 600 : 400,
      }),
      card: { border: `1px solid ${BORDER}`, borderRadius: 8, padding: '12px 14px', marginBottom: 12 },
      cardTitle: { fontSize: 13, fontWeight: 600, marginBottom: 8 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 },
      btn: (primary, disabled) => ({
        padding: '6px 14px', fontSize: 13, borderRadius: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: `1px solid ${BORDER}`,
        background: primary ? ACCENT : 'transparent',
        color: primary ? '#fff' : 'inherit',
        opacity: disabled ? 0.45 : 1,
      }),
      item: (on) => ({
        display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 11px',
        border: `1px solid ${on ? ACCENT : BORDER}`, borderRadius: 8, marginBottom: 8, cursor: 'pointer',
      }),
      itemName: { fontSize: 13, fontWeight: 600 },
      itemMeta: { fontSize: 12, opacity: 0.62, marginTop: 2, wordBreak: 'break-all' },
      badge: (level) => ({
        fontSize: 11, padding: '1px 7px', borderRadius: 999, border: `1px solid ${BORDER}`,
        opacity: level === 'error' ? 1 : 0.8,
        fontWeight: level === 'error' ? 600 : 400,
      }),
      finding: { borderTop: `1px solid ${BORDER}`, padding: '9px 0', fontSize: 13 },
      findingTitle: { fontWeight: 600, marginBottom: 3 },
      findingDetail: { opacity: 0.75, lineHeight: 1.55, fontSize: 12 },
      fix: { fontSize: 12, opacity: 0.9, marginTop: 4 },
      field: { marginBottom: 14 },
      label: { fontSize: 12, fontWeight: 600, marginBottom: 5, display: 'block' },
      hint: { fontSize: 11, opacity: 0.6, marginTop: 4, lineHeight: 1.5 },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 13,
        borderRadius: 6, border: `1px solid ${BORDER}`, background: 'transparent',
        color: 'inherit', fontFamily: 'inherit',
      },
      textarea: (rows) => ({
        width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 13, rows,
        borderRadius: 6, border: `1px solid ${BORDER}`, background: 'transparent',
        color: 'inherit', fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.5,
      }),
      pre: {
        fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, lineHeight: 1.55,
        padding: '10px 12px', borderRadius: 6, border: `1px solid ${BORDER}`,
        overflowX: 'auto', margin: 0, whiteSpace: 'pre',
      },
      note: { fontSize: 12, opacity: 0.62, marginTop: 10, lineHeight: 1.6 },
      banner: (kind) => ({
        fontSize: 13, padding: '9px 12px', borderRadius: 6, marginBottom: 12,
        border: `1px solid ${BORDER}`,
        background: kind === 'error' ? 'rgba(220,60,60,.08)'
          : kind === 'ok' ? 'rgba(60,160,90,.08)'
            : kind === 'info' ? 'rgba(80,140,220,.07)'
              : 'transparent',
      }),
      chips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 },
      chip: { fontSize: 11, padding: '2px 8px', borderRadius: 999, border: `1px solid ${BORDER}`, opacity: 0.85 },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 },
      monoHint: {
        fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11, opacity: 0.5,
        marginTop: 6, wordBreak: 'break-all',
      },
      barTrack: {
        height: 6, borderRadius: 999, marginTop: 4,
        background: 'var(--dsw-alias-border-secondary, rgba(128,128,128,.25))',
        overflow: 'hidden',
      },
      barFill: (fraction) => ({
        height: '100%',
        width: `${Math.max(2, Math.min(100, Math.round(fraction * 100)))}%`,
        background: ACCENT,
        transition: 'width .2s ease',
      }),
      empty: {
        fontSize: 13, lineHeight: 1.7, padding: '18px 16px', borderRadius: 8,
        border: `1px dashed ${BORDER}`, opacity: 0.8,
      },
      actionRow: { marginTop: 8 },
      manualRow: {
        marginTop: 8, fontSize: 12, lineHeight: 1.6, opacity: 0.75,
        paddingLeft: 10, borderLeft: `2px solid ${BORDER}`,
      },
      drop: (active, busy) => ({
        marginTop: 6, padding: '16px 14px', borderRadius: 8, textAlign: 'center',
        border: `1px dashed ${active ? ACCENT : BORDER}`,
        background: active ? 'rgba(80,140,220,.07)' : 'transparent',
        opacity: busy ? 0.6 : 1, outline: 'none', cursor: 'pointer',
      }),
      dropTitle: { fontSize: 13, fontWeight: 600, marginBottom: 4 },
      shotGrid: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
        gap: 8, marginTop: 10,
      },
      shot: { position: 'relative', borderRadius: 6, overflow: 'hidden', border: `1px solid ${BORDER}` },
      shotImg: { width: '100%', height: 74, objectFit: 'cover', display: 'block' },
      shotRemove: {
        position: 'absolute', top: 2, right: 2, width: 20, height: 20, lineHeight: '18px',
        padding: 0, borderRadius: 999, border: `1px solid ${BORDER}`, cursor: 'pointer',
        background: 'rgba(0,0,0,.55)', color: '#fff', fontSize: 12,
      },
      shotName: { fontSize: 10, padding: '2px 4px', opacity: 0.65, wordBreak: 'break-all' },
    }

    /* ─────────────────────────── data ─────────────────────────── */

    /**
     * Every request is bounded. A fetch that never settles used to leave the page
     * showing "loading" forever with no way to tell whether it was working — so a
     * stalled host now surfaces as a visible error.
     */
    const REQUEST_TIMEOUT_MS = 60_000

    async function request(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
      try {
        const res = await fetch(url, { ...init, signal: controller?.signal })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          const error = new Error(data.error ?? `${res.status} ${res.statusText}`)
          error.payload = data
          error.status = res.status
          throw error
        }
        return data
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）：${url}`)
        }
        throw error
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    async function getJson(url) {
      return request(url, { headers: { accept: 'application/json' } })
    }
    async function postJson(url, body) {
      return request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
    }

    /**
     * Encode an ArrayBuffer as base64 without blowing the call stack.
     *
     * `btoa(String.fromCharCode(...bytes))` works for small files and throws
     * `RangeError: Maximum call stack size exceeded` for a real screenshot, so the
     * bytes go in chunks.
     */
    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer)
      const chunk = 0x8000
      let binary = ''
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
      }
      return btoa(binary)
    }

    /** One line summarising what an autofix actually changed. */
    function describeApplied(data) {
      const applied = data.applied ?? []
      const files = applied.filter(a => a.kind === 'file').length
      const drafts = applied.filter(a => a.kind === 'draft').length
      const parts = []
      if (files > 0) parts.push(`改了 ${files} 个文件`)
      if (drafts > 0) parts.push(`填写了 ${drafts} 项投稿信息`)
      const manual = (data.manual ?? []).length
      if (parts.length === 0) {
        return manual > 0
          ? `没有能自动修的问题；剩下 ${manual} 条需要你手动处理（见下方说明）。`
          : '没有需要修复的问题。'
      }
      const head = `已自动修复：${parts.join('、')}。`
      return manual > 0 ? `${head} 还有 ${manual} 条只能手动处理。` : head
    }

    /* ─────────────────────────── page ─────────────────────────── */

    function OnshelfPage(props) {
      const locale = localeTag(props.ctx)
      const tr = useCallback(k => t(locale, k), [locale])

      // `initialStep` / `initialCheck` exist so the wizard's states can be rendered
      // and asserted without simulating clicks; the shell never passes them.
      const [step, setStep] = useState(Number.isFinite(props?.initialStep) ? props.initialStep : 1)
      const [config, setConfig] = useState(null)
      const [scan, setScan] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState(null)
      const [selected, setSelected] = useState(
        (props?.initialCheck ?? props?.initialDraft)
          ? (props?.initialSelected ?? 'D:\\plugin')
          : null,
      )
      const [check, setCheck] = useState(props?.initialCheck ?? null)
      const [draft, setDraft] = useState(props?.initialDraft ?? null)
      const [draftMeta, setDraftMeta] = useState(null)
      const [preview, setPreview] = useState(null)
      const [tokenInput, setTokenInput] = useState('')
      const [identity, setIdentity] = useState(null)
      const [outcome, setOutcome] = useState(props?.initialOutcome ?? null)
      const [copied, setCopied] = useState('')
      const [fixFiles, setFixFiles] = useState([])
      const [rootInput, setRootInput] = useState('')
      const [rootsOpen, setRootsOpen] = useState(false)
      const [progress, setProgress] = useState(null)
      const [applyNote, setApplyNote] = useState(null)
      const [publishOpen, setPublishOpen] = useState(false)
      const [publishName, setPublishName] = useState('')
      const [publishPrivate, setPublishPrivate] = useState(false)
      const [publishPlan, setPublishPlan] = useState(null)
      const [publishOutcome, setPublishOutcome] = useState(null)
      const [publishJob, setPublishJob] = useState(null)
      const [publishError, setPublishError] = useState(null)
      const [repoStatus, setRepoStatus] = useState(null)
      const [topicNote, setTopicNote] = useState(null)
      const [prStatus, setPrStatus] = useState(props?.initialPrStatus ?? null)
      const [shotBusy, setShotBusy] = useState(false)
      const [shotNote, setShotNote] = useState(null)
      const [dragOver, setDragOver] = useState(false)

      const loadConfig = useCallback(async () => {
        try {
          const data = await getJson(`${API}/config`)
          setConfig(data)
          setIdentity(data.identity)
        } catch (e) { setError(e.message) }
      }, [])

      /**
       * Run a scan as a background job and poll it.
       *
       * Polling rather than one long request means the page can show what the scan
       * is actually doing — how many directories it has visited, how many candidates
       * it has found so far — instead of an indistinguishable spinner. The previous
       * result stays on screen throughout, so a rescan never blanks the list.
       */
      const doScan = useCallback(async (force) => {
        setBusy('scan'); setError(null)
        setProgress(null)
        try {
          const started = await postJson(`${API}/scan/start`, {})
          if (started.previous) setScan(started.previous)
          const jobId = started.job?.id
          if (!jobId) { setBusy(''); return }

          // Poll until the job stops running. The cap bounds a runaway poll loop;
          // the server-side directory cap bounds the scan itself.
          for (let i = 0; i < 600; i++) {
            const status = await getJson(`${API}/scan/status?job=${encodeURIComponent(jobId)}`)
            const job = status.job
            if (!job) break
            setProgress({
              running: job.running,
              elapsedMs: job.elapsedMs,
              dirsVisited: job.progress?.dirsVisited ?? 0,
              found: job.progress?.found ?? 0,
              packages: job.progress?.packages ?? 0,
              current: job.progress?.current ?? '',
              rootIndex: job.progress?.rootIndex ?? 0,
              rootCount: job.progress?.rootCount ?? 1,
            })
            if (!job.running) {
              if (job.error) setError(job.error)
              if (job.result) setScan({ ...job.result, elapsedMs: job.elapsedMs })
              break
            }
            await new Promise(resolve => setTimeout(resolve, 150))
          }
        } catch (e) { setError(e.message) } finally { setBusy(''); setProgress(null) }
      }, [])

      useEffect(() => {
        // Paint instantly from the server's cache when there is one; only scan on
        // a cold open. Re-opening Settings must not feel like a fresh scan.
        const boot = async () => {
          loadConfig()
          try {
            const cached = await getJson(`${API}/scan/cached`)
            if (cached.cached) { setScan(cached.cached); return }
          } catch { /* fall through to a real scan */ }
          doScan(false)
        }
        boot()
      }, [loadConfig, doScan])

      /**
       * Replace the scan root list. The plugin cannot know where you keep your
       * projects, so the roots are yours to set — and the default is shown as a
       * guess, not as fact.
       */
      const saveRoots = useCallback(async next => {
        setBusy('roots'); setError(null)
        try {
          const data = await postJson(`${API}/roots`, { roots: next })
          if (data.rejected && data.rejected.length > 0) {
            setError(data.rejected.map(r => `${r.path}: ${r.reason}`).join('；'))
          }
          setConfig(prev => (prev ? { ...prev, roots: data.roots, rootsSource: 'custom' } : prev))
          await doScan(true)
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }, [doScan])

      const addRoot = useCallback(() => {
        const value = rootInput.trim()
        if (value === '') return
        const current = config?.roots ?? []
        if (current.some(r => r.toLowerCase() === value.toLowerCase())) { setRootInput(''); return }
        setRootInput('')
        saveRoots([...current, value])
      }, [rootInput, config, saveRoots])

      const removeRoot = useCallback(dir => {
        const current = config?.roots ?? []
        saveRoots(current.filter(r => r !== dir))
      }, [config, saveRoots])

      const doCheck = useCallback(async dir => {
        setBusy('check'); setError(null); setCheck(null)
        try {
          const data = await getJson(`${API}/check?dir=${encodeURIComponent(dir)}`)
          setCheck(data)
          setStep(2)
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }, [])

      const doUndoFix = useCallback(async () => {
        setBusy('undo'); setError(null)
        try {
          await postJson(`${API}/undo-fix`, { files: fixFiles })
          setFixFiles([])
          if (selected) await doCheck(selected)
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }, [fixFiles, selected, doCheck])

      /**
       * Apply ONE finding's action. Two kinds exist server-side:
       *   file  → rewrite package.json / cordis.patch.yml (via /autofix, which does
       *           the file plan and then the draft actions in one go)
       *   draft → fill a wizard field (category, description) via /draft/apply
       * Both end by refreshing the findings list, so the button's effect is visible.
       */
      const applyFinding = useCallback(async (dir, finding) => {
        setBusy(`apply:${finding.id}`); setError(null); setApplyNote(null)
        try {
          if (finding.action?.kind === 'file') {
            const data = await postJson(`${API}/autofix`, { dir })
            setFixFiles((data.applied ?? []).filter(a => a.kind === 'file').map(a => a.file))
            await doCheck(dir)
            if (data.draft) setDraft(prev => (prev ? { ...prev, ...data.draft } : prev))
            setApplyNote(describeApplied(data))
          } else {
            const data = await postJson(`${API}/draft/apply`, { dir, id: finding.id })
            setCheck({ ...check, findings: data.findings, summary: data.summary })
            if (data.applied?.note) setApplyNote(data.applied.note)
            if (data.draft) setDraft(prev => (prev ? { ...prev, ...data.draft } : prev))
          }
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }, [check, doCheck])

      /** Fix everything that can be fixed, in one request. */
      const doAutofix = useCallback(async dir => {
        setBusy('autofix'); setError(null); setApplyNote(null)
        try {
          const data = await postJson(`${API}/autofix`, { dir })
          setFixFiles((data.applied ?? []).filter(a => a.kind === 'file').map(a => a.file))
          if (data.draft) setDraft(prev => (prev ? { ...prev, ...data.draft } : prev))
          await doCheck(dir)
          setApplyNote(describeApplied(data))
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }, [doCheck])

      /**
       * Create the repo and upload the code.
       *
       * Two-step on purpose: the preview says exactly which repo will be created (or
       * used), whether it is public, how many files, and what will be left out. A
       * one-click write into someone's GitHub account should never be a surprise.
       *
       * The upload itself returns a job and is polled: one request per file means it
       * can take a while, and a button that looks frozen while it works is how the
       * author ends up not knowing whether it succeeded.
       */
      const doPublish = useCallback(async (dir, dryRun, overwrite = false) => {
        setBusy(dryRun ? 'publishPlan' : 'publish'); setError(null); setPublishError(null)
        if (dryRun) setPublishPlan(null)
        if (!dryRun) setPublishOutcome(null)
        try {
          const data = await postJson(`${API}/publish-repo`, {
            dir,
            name: publishName.trim(),
            private: publishPrivate,
            dryRun,
            overwrite,
          })
          if (dryRun) {
            setPublishPlan(data.plan)
            return
          }
          if (!data.job?.id) {
            // The server answered without a job: treat whatever it said as the result.
            setPublishOutcome(data)
            return
          }

          setPublishPlan(data.plan ?? null)
          const jobId = data.job.id
          for (let i = 0; i < 1200; i++) {
            const status = await getJson(`${API}/publish-status?job=${encodeURIComponent(jobId)}`)
            const job = status.job
            if (!job) break
            setPublishJob(job)
            if (!job.running) {
              if (job.error) {
                setPublishError({ error: job.error, needsOverwrite: job.needsOverwrite })
              } else if (job.result) {
                setPublishOutcome(job.result)
                setPublishPlan(null)
                if (job.result.repoUrl) setDraft(prev => (prev ? { ...prev, repoUrl: job.result.repoUrl } : prev))
                if (job.result.findings) {
                  setCheck(prev => ({ ...(prev ?? {}), findings: job.result.findings, summary: job.result.summary }))
                }
              }
              break
            }
            await new Promise(resolve => setTimeout(resolve, 250))
          }
        } catch (e) {
          const payload = e?.payload
          if (payload?.plan) setPublishPlan(payload.plan)
          setPublishError({ error: e.message, needsOverwrite: payload?.needsOverwrite === true })
        } finally { setBusy(''); setPublishJob(null) }
      }, [publishName, publishPrivate])

      const loadDraft = useCallback(async dir => {
        setBusy('draft'); setError(null)
        try {
          const data = await getJson(`${API}/draft?dir=${encodeURIComponent(dir)}`)
          setDraft(data.draft)
          setDraftMeta(data)
          setStep(3)
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }, [])

      /**
       * Take image files from anywhere — the clipboard, a drop, or the file picker —
       * and hand their bytes to the host, which writes them into `assets/`.
       *
       * The browser has bytes, not paths: a pasted screenshot has no file on disk.
       * Writing them host-side also guarantees the recorded path points at a real
       * file, which is exactly what the rulebook validates.
       */
      const ingestImages = useCallback(async (fileList) => {
        const files = Array.from(fileList ?? []).filter(f => /^image\//.test(f.type))
        if (files.length === 0) {
          setShotNote('没有识别到图片。支持 png / jpg / webp / gif / avif。')
          return
        }
        setShotBusy(true); setShotNote(null)
        try {
          const images = []
          for (const file of files) {
            const buffer = await file.arrayBuffer()
            images.push({
              name: file.name || 'image.png',
              type: file.type,
              base64: arrayBufferToBase64(buffer),
            })
          }
          const data = await postJson(`${API}/screenshots`, { dir: selected, images })
          if (data.saved?.length > 0) {
            setDraft(prev => (prev
              ? { ...prev, screenshots: [...new Set([...(prev.screenshots ?? []), ...data.saved])].slice(0, 8) }
              : prev))
            setShotNote(`已保存 ${data.saved.length} 张到 ${data.folder ?? 'assets'}：${data.saved.join('、')}`)
          }
          if (data.failures?.length > 0) {
            setShotNote(`部分失败：${data.failures.map(f => `${f.name}（${f.reason}）`).join('；')}`)
          }
        } catch (e) {
          setShotNote(`保存失败：${e.message}`)
        } finally { setShotBusy(false) }
      }, [selected])

      const saveDraft = useCallback(async (dir, patch) => {
        const next = { ...draft, ...patch }
        setDraft(next)
        try {
          await postJson(`${API}/draft`, { dir, draft: patch })
        } catch (e) { setError(e.message) }
      }, [draft])

      const doPreview = useCallback(async dir => {
        setBusy('preview'); setError(null)
        try {
          const data = await getJson(`${API}/preview?dir=${encodeURIComponent(dir)}`)
          setPreview(data)
          setStep(3)
        } catch (e) {
          setError(e.message)
          if (e.payload?.validation) setPreview({ validation: e.payload.validation, yaml: '', entryFile: '' })
        } finally { setBusy('') }
      }, [])

      const connectToken = useCallback(async () => {
        setBusy('token'); setError(null)
        try {
          const data = await postJson(`${API}/token`, { token: tokenInput })
          setIdentity({ login: data.login })
          setTokenInput('')
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }, [tokenInput])

      const disconnect = useCallback(async () => {
        setBusy('token')
        try {
          await postJson(`${API}/token`, { token: '' })
          setIdentity(null)
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }, [])

      const doSubmit = useCallback(async (dir, dryRun) => {
        setBusy(dryRun ? 'dry' : 'submit'); setError(null); setOutcome(null)
        try {
          const data = await postJson(`${API}/submit`, { dir, draft, dryRun })
          setOutcome(data)
        } catch (e) {
          setError(e.message)
          if (e.payload) setOutcome(e.payload)
        } finally { setBusy('') }
      }, [draft])

      const doUploadShots = useCallback(async dir => {
        setBusy('shots'); setError(null)
        try {
          const data = await postJson(`${API}/upload-screenshots`, { dir })
          setOutcome(data)
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }, [])

      /**
       * Re-read the plugin repo's age and topics.
       *
       * The two things that get a first-time submission rejected are both conditions
       * that change with time or one click on GitHub, so the author needs a way to
       * ask "am I allowed yet?" without re-running the whole submission.
       */
      const doCheckRepo = useCallback(async () => {
        setBusy('repo'); setError(null)
        try {
          const url = draft?.repoUrl || ''
          const data = await getJson(`${API}/repo?repo=${encodeURIComponent(url)}`)
          setRepoStatus(data)
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }, [draft])

      /** Add the `dsh-plugin` topic for the author — one API call, no GitHub UI trip. */
      const doAddTopic = useCallback(async () => {
        setBusy('topic'); setError(null); setTopicNote(null)
        try {
          const data = await postJson(`${API}/repo/topic`, { repo: draft?.repoUrl || '', topic: 'dsh-plugin' })
          setTopicNote(data.already
            ? tr('topicAlready')
            : `${tr('topicAdded')} ${(data.topics ?? []).join(', ')}`)
          // Re-read the status so the checkmarks move without another click.
          await doCheckRepo()
        } catch (e) { setTopicNote(`${tr('topicFailed')} ${e.message}`) } finally { setBusy('') }
      }, [draft, doCheckRepo, tr])

      /**
       * Ask what happened to the submitted PR: open / checks running / failed / merged.
       *
       * The failure cases come back already translated by the host, so this does not
       * have to read GitHub logs — it renders a verdict and a next step.
       */
      const doCheckPr = useCallback(async () => {
        setBusy('pr'); setError(null)
        try {
          // `dir` is what lets the host find the PR itself — including one that has
          // already been merged, which an "open PRs only" lookup would miss. Sending
          // `repo` alone used to make the host skip that lookup and reject PR #0.
          const query = new URLSearchParams()
          if (selected) query.set('dir', selected)
          const data = await getJson(`${API}/pr-status?${query.toString()}`)
          setPrStatus(data.found === false
            ? { ok: false, verdict: 'none', headline: data.status?.headline, nextSteps: data.status?.nextSteps ?? [] }
            : data.status)
        } catch (e) { setError(e.message) } finally { setBusy('') }
      }, [selected])

      const copy = useCallback(async (text, key) => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(key)
          setTimeout(() => setCopied(''), 1500)
        } catch { /* clipboard blocked; the text is selectable anyway */ }
      }, [])

      const pick = useCallback(dir => {
        setSelected(dir)
        setCheck(null)
        setPreview(null)
        doCheck(dir)
      }, [doCheck])

      const stepDone = { 1: Boolean(selected), 2: Boolean(check), 3: Boolean(preview), 4: false, 5: Boolean(outcome?.prUrl) }

      /**
       * Render one finding's action as an actual control.
       *
       * A finding with an action gets a button that does the thing; a finding that
       * genuinely cannot be automated says so and why. The previous version drew
       * "→ 按功能自动推荐" as plain text, which looked like a button and did nothing.
       */
      function findingAction(f) {
        const action = f.action
        if (!action) return null
        if (action.kind === 'manual') {
          return h('div', { style: S.manualRow }, `需要你处理：${action.hint}`)
        }
        const busyKey = `apply:${f.id}`
        const running = busy === busyKey
        const label = running ? tr('applying') : (f.fixLabel ?? (action.kind === 'file' ? tr('applyFile') : tr('applyDraft')))
        return h('div', { style: S.actionRow },
          h('button', {
            style: S.btn(true, running || busy === 'autofix'),
            disabled: running || busy === 'autofix',
            onClick: () => applyFinding(selected, f),
          }, `→ ${label}`))
      }

      /* ── render ── */

      /**
       * Screenshot intake: drop zone + paste + file picker.
       *
       * The author is looking at a screenshot in another window; the shortest path
       * from there to a usable storefront image is Ctrl+V or a drag, not "save the
       * file, find it, copy its relative path".
       */
      const screenshotDrop = h('div', {
        style: S.drop(dragOver, shotBusy),
        onDragOver: e => { e.preventDefault(); setDragOver(true) },
        onDragLeave: () => setDragOver(false),
        onDrop: e => {
          e.preventDefault()
          setDragOver(false)
          if (!e.dataTransfer?.files?.length) return
          ingestImages(e.dataTransfer.files)
        },
        // Paste works while this box has focus, which is the natural place to try it.
        tabIndex: 0,
        onPaste: e => {
          const items = e.clipboardData?.items ?? []
          const files = []
          for (const item of items) {
            if (item.kind === 'file') {
              const file = item.getAsFile()
              if (file) files.push(file)
            }
          }
          if (files.length > 0) {
            e.preventDefault()
            ingestImages(files)
          }
        },
      },
        h('div', { style: S.dropTitle }, shotBusy ? tr('shotSaving') : tr('shotDropTitle')),
        h('div', { style: S.hint }, tr('shotDropHint')),
        h('input', {
          type: 'file',
          accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif',
          multiple: true,
          style: { display: 'none' },
          id: 'onshelf-shot-input',
          onChange: e => { ingestImages(e.target.files); e.target.value = '' },
        }),
        h('button', {
          type: 'button',
          style: { ...S.btn(false), marginTop: 8 },
          onClick: () => {
            const input = globalThis?.document?.getElementById?.('onshelf-shot-input')
            input?.click?.()
          },
        }, tr('shotPick')))

      const findingsBlock = check && h('div', { style: S.card },
        h('div', { style: S.row },
          h('span', { style: S.cardTitle }, `${tr('errors')} ${check.summary.error} · ${tr('warns')} ${check.summary.warn} · ${tr('infos')} ${check.summary.info}`),
          h('span', { style: { flex: 1 } }),
          // Only render the fix-all control when there is something it can fix. A
          // permanently disabled primary button reads as a broken control.
          check.summary.fixable > 0 && h('button', {
            style: S.btn(true, busy === 'fix' || busy === 'autofix'),
            disabled: busy === 'fix' || busy === 'autofix',
            onClick: () => doAutofix(selected),
          }, busy === 'autofix' ? tr('fixing') : `${tr('fixAll')} (${check.summary.fixable})`),
          fixFiles.length > 0 && h('button', {
            style: S.btn(false, busy === 'undo'),
            disabled: busy === 'undo',
            onClick: doUndoFix,
          }, tr('undoFix')),
        ),
        applyNote && h('div', { style: S.banner('ok') }, applyNote),
        check.summary.blocked
          ? h('div', { style: S.banner('error') }, tr('blocked'))
          : h('div', { style: S.banner('ok') }, tr('passed')),
        ...check.findings
          .slice()
          .sort((a, b) => ({ error: 0, warn: 1, info: 2 }[a.level] - { error: 0, warn: 1, info: 2 }[b.level]))
          .map((f, i) => h('div', { key: f.id ?? i, style: S.finding },
            h('div', { style: S.row },
              h('span', { style: S.badge(f.level) }, f.level),
              h('span', { style: S.findingTitle }, f.title)),
            h('div', { style: S.findingDetail }, f.detail),
            findingAction(f))))

      const draftBlock = draft && h('div', null,
        h('div', { style: S.field },
          h('label', { style: S.label }, tr('category')),
          h('select', {
            style: S.input,
            value: draft.category,
            onChange: e => saveDraft(selected, { category: e.target.value }),
          }, (config?.categories ?? []).map(c => h('option', { key: c.id, value: c.id }, `${c.id} — ${c.label}`))),
          h('div', { style: S.hint },
            draftMeta?.draft?.categoryReason ? `${tr('categoryAuto')}: ${draftMeta.draft.categoryReason}` : ''),
          // If the saved value was picked by hand, say so and offer the fresh guess —
          // otherwise an early manual pick silently freezes the recommendation.
          draftMeta?.draft?.categorySource === 'manual'
            && draftMeta?.draft?.suggestedCategory
            && draftMeta.draft.suggestedCategory !== draft.category
            && h('button', {
              style: { ...S.btn(false), marginTop: 6 },
              onClick: () => saveDraft(selected, { category: draftMeta.draft.suggestedCategory }),
            }, `${tr('useSuggested')} ${draftMeta.draft.suggestedCategory}`)),

        h('div', { style: S.field },
          h('label', { style: S.label }, tr('descEn')),
          h('textarea', {
            style: S.textarea(3),
            value: draft.descriptionEn,
            onChange: e => setDraft({ ...draft, descriptionEn: e.target.value }),
            onBlur: e => saveDraft(selected, { descriptionEn: e.target.value }),
          }),
          h('div', { style: S.hint }, tr('claimsNote'))),

        h('div', { style: S.field },
          h('label', { style: S.label }, tr('descZh')),
          h('textarea', {
            style: S.textarea(2),
            value: draft.descriptionZh,
            onChange: e => setDraft({ ...draft, descriptionZh: e.target.value }),
            onBlur: e => saveDraft(selected, { descriptionZh: e.target.value }),
          })),

        h('div', { style: S.field },
          h('label', { style: S.label }, tr('repo')),
          h('input', {
            style: S.input,
            value: draft.repoUrl,
            placeholder: tr('repoPlaceholder'),
            onChange: e => setDraft({ ...draft, repoUrl: e.target.value }),
            onBlur: e => saveDraft(selected, { repoUrl: e.target.value }),
          })),

        /* Putting the code on GitHub — the step a beginner cannot do by hand. */
        h('div', { style: S.card },
          h('div', { style: S.cardTitle }, tr('publishTitle')),
          h('div', { style: S.note }, tr('publishNote')),
          publishOpen
            ? h('div', null,
                h('div', { style: { ...S.row, marginTop: 10 } },
                  h('span', { style: S.label }, tr('publishRepoName')),
                  h('input', {
                    style: { ...S.input, flex: 1, minWidth: 180 },
                    value: publishName,
                    placeholder: 'dsh-your-plugin',
                    onChange: e => setPublishName(e.target.value),
                  })),
                h('label', { style: { ...S.label, marginTop: 8 } },
                  h('input', {
                    type: 'checkbox', style: { marginRight: 6 },
                    checked: publishPrivate,
                    onChange: e => setPublishPrivate(e.target.checked),
                  }),
                  // Only meaningful when a repo is created. Saying so avoids the
                  // "I ticked private but it pushed to my public repo" confusion.
                  tr('publishPrivate')),
                publishPlan && !publishPlan.willCreate && h('div', { style: S.hint }, tr('publishExistsVisibility')),
                h('div', { style: { ...S.row, marginTop: 10 } },
                  h('button', {
                    style: S.btn(false, busy === 'publishPlan'),
                    disabled: busy === 'publishPlan' || !identity,
                    onClick: () => doPublish(selected, true),
                  }, busy === 'publishPlan' ? tr('publishing') : tr('publishPreview')),
                  h('button', {
                    style: S.btn(true, busy === 'publish'),
                    disabled: busy === 'publish' || !identity || !publishPlan,
                    onClick: () => doPublish(selected, false),
                  }, busy === 'publish' ? tr('publishing') : tr('publishGo'))),
                !identity && h('div', { style: S.hint }, tr('publishNeedsToken')),
                publishPlan && h('div', { style: S.card },
                  h('div', { style: S.cardTitle }, tr('publishPlanTitle')),
                  h('div', { style: S.monoHint }, publishPlan.url),
                  h('div', { style: S.hint },
                    [
                      publishPlan.willCreate ? tr('publishWillCreate') : tr('publishWillPush'),
                      `${publishPlan.files} ${tr('publishFiles')}`,
                      `${Math.max(1, Math.round(publishPlan.bytes / 1024))} KB`,
                      publishPlan.willCreate ? (publishPlan.createsPublicRepo ? tr('publishPublic') : tr('publishPrivateRepo')) : null,
                    ].filter(Boolean).join(' · ')),
                  (publishPlan.topLevel ?? []).length > 0 && h('div', { style: S.chips },
                    publishPlan.topLevel.map((t, i) => h('span', { key: i, style: S.chip }, t))),
                  (publishPlan.skipped ?? []).length > 0 && h('div', { style: S.hint },
                    `${tr('publishSkipped')}：${publishPlan.skipped.slice(0, 6).map(s => s.path).join('、')}${publishPlan.skipped.length > 6 ? ' …' : ''}`),
                  // Details that are true of this machine only. Worth knowing before a
                  // README goes public, and cheap to fix.
                  publishPlan.privacy && !publishPlan.privacy.clean && h('div', { style: { ...S.banner('info'), marginTop: 10 } },
                    h('div', null, `${tr('privacyFound')} ${publishPlan.privacy.findings.length} ${tr('privacyCount')}`),
                    h('div', { style: S.hint }, tr('privacyHint')),
                    h('div', { style: S.chips },
                      publishPlan.privacy.findings.slice(0, 5).map((f, i) => h('span', { key: i, style: S.chip },
                        `${f.path}:${f.line} · ${f.kind}`))),
                    publishPlan.privacy.findings.length > 5 && h('div', { style: S.hint },
                      `… ${tr('privacyMore')} ${publishPlan.privacy.findings.length - 5}`),
                    h('div', { style: S.hint }, tr('privacyNotBlocking'))),
                  (publishPlan.warnings ?? []).length > 0 && h('div', { style: S.banner('error') },
                    ...publishPlan.warnings.map((w, i) => h('div', { key: i }, `! ${w}`)))),
                /* Progress while the upload runs — the button alone looks frozen. */
                publishJob && h('div', { style: S.card },
                  h('div', { style: S.row },
                    h('span', { style: S.cardTitle }, publishJob.phaseLabel ?? tr('publishing')),
                    h('span', { style: { flex: 1 } }),
                    h('span', { style: S.mono, opacity: 0.7 }, `${(publishJob.elapsedMs / 1000).toFixed(1)}s`)),
                  h('div', { style: S.barTrack },
                    h('div', {
                      style: S.barFill(
                        publishJob.progress?.total > 0
                          ? publishJob.progress.done / publishJob.progress.total
                          : 0.05,
                      ),
                    })),
                  h('div', { style: S.hint },
                    publishJob.progress?.total > 0
                      ? `${publishJob.progress.done} / ${publishJob.progress.total} ${tr('publishFiles')}`
                      : tr('publishPreparing')),
                  publishJob.progress?.current && h('div', { style: S.monoHint }, publishJob.progress.current)),

                /* Failure, right where the button that failed is. */
                publishError && h('div', { style: S.banner('error') },
                  h('div', null, `✗ ${publishError.error}`),
                  publishError.needsOverwrite && h('button', {
                    style: { ...S.btn(false), marginTop: 8 },
                    onClick: () => doPublish(selected, false, true),
                  }, tr('publishOverwrite'))),

                /* Success, with the two links that prove it happened. */
                publishOutcome?.repoUrl && h('div', { style: S.banner('ok') },
                  h('div', null, `✓ ${tr('publishDone')} ${publishOutcome.files} ${tr('publishFiles')}${publishOutcome.branch ? ` → ${publishOutcome.branch}` : ''}`),
                  h('div', null, h('a', { href: publishOutcome.repoUrl, target: '_blank', rel: 'noreferrer' }, publishOutcome.repoUrl)),
                  publishOutcome.commitUrl && h('div', { style: S.monoHint },
                    h('a', { href: publishOutcome.commitUrl, target: '_blank', rel: 'noreferrer' }, publishOutcome.commitUrl)),
                  publishOutcome.repoFieldWritten && h('div', { style: S.hint }, tr('publishFieldWritten')),
                  (publishOutcome.warnings ?? []).length > 0 && h('div', { style: { ...S.hint, marginTop: 8 } },
                    ...publishOutcome.warnings.map((w, i) => h('div', { key: i }, `! ${w}`)))))
            : h('div', null,
                h('button', {
                  style: { ...S.btn(false), marginTop: 8 },
                  onClick: () => {
                    setPublishOpen(true)
                    // Default to the package name — that is what the repo should be
                    // called, and it is the one thing we can infer correctly.
                    setPublishName(publishName || draftMeta?.package?.name || check?.name || '')
                  },
                }, tr('publishOpen')),
                // Say the token is needed before they open the section, not after.
                !identity && h('div', { style: S.hint }, tr('publishNeedsToken')))),

        h('div', { style: S.field },
          h('label', { style: S.label }, `${tr('subpath')} (${tr('optional')})`),
          h('input', {
            style: S.input,
            value: draft.pluginSubpath,
            placeholder: 'packages/my-plugin',
            onChange: e => setDraft({ ...draft, pluginSubpath: e.target.value }),
            onBlur: e => saveDraft(selected, { pluginSubpath: e.target.value }),
          })),

        // Screenshots live on ④ now — one place to add, preview and upload them.
        // ③ keeps a read-only summary so the entry's completeness is still visible.
        h('div', { style: S.field },
          h('label', { style: S.label }, tr('screenshots')),
          (draft.screenshots ?? []).length > 0
            ? h('div', { style: S.row },
                h('span', { style: S.hint }, `${draft.screenshots.length} ${tr('shotUnit')} — ${draft.screenshots.map(s => s.split('/').pop()).join('、')}`),
                h('button', {
                  style: S.btn(false),
                  onClick: () => setStep(4),
                }, tr('shotsGoStep4')))
            : h('div', { style: S.row },
                h('span', { style: S.hint }, tr('shotsMovedHint')),
                h('button', {
                  style: S.btn(false),
                  onClick: () => setStep(4),
                }, tr('shotsGoStep4')))),

        h('div', { style: S.field },
          h('label', { style: S.label }, tr('tarball')),
          h('input', {
            style: S.input,
            value: draft.tarball ?? '',
            onChange: e => setDraft({ ...draft, tarball: e.target.value }),
            onBlur: e => saveDraft(selected, { tarball: e.target.value }),
          })),

        h('div', { style: S.row },
          h('button', {
            style: S.btn(true, busy === 'preview'),
            disabled: busy === 'preview',
            onClick: () => doPreview(selected),
          }, busy === 'preview' ? tr('previewing') : tr('preview'))),

        draftMeta?.claims?.length > 0 && h('div', { style: S.card },
          h('div', { style: S.cardTitle }, tr('claimsTitle')),
          h('div', { style: S.chips }, draftMeta.claims.map((c, i) => h('span', { key: i, style: S.chip }, c))),
          h('div', { style: S.hint }, tr('claimsNote'))))

      const previewBlock = preview && h('div', null,
        preview.validation && !preview.validation.ok && h('div', { style: S.banner('error') },
          ...preview.validation.problems.map((p, i) => h('div', { key: i }, `✗ ${p.field}: ${p.message}`))),
        // These two blocks are not inputs. Saying so here stops the reasonable
        // question "where do I paste this?" — the answer is "nowhere, ⑤ does it".
        preview.entryFile && h('div', { style: S.banner('info') },
          h('div', null, tr('artifactsNote')),
          h('div', { style: S.hint }, tr('artifactsNoteHint'))),
        preview.entryFile && h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.cardTitle }, tr('entryFile')),
            h('span', { style: { flex: 1 } }),
            h('button', { style: S.btn(false), onClick: () => copy(preview.yaml, 'yaml') },
              copied === 'yaml' ? tr('copied') : tr('copy'))),
          h('div', { style: S.mono, opacity: 0.7, marginBottom: 8 }, `data/plugins/${preview.entryFile}`),
          h('pre', { style: S.pre }, preview.yaml)),
        preview.screenshotsJson && h('div', { style: S.card },
          h('div', { style: S.cardTitle }, 'screenshots.json'),
          h('pre', { style: S.pre }, preview.screenshotsJson)),
        preview.prDraft && h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.cardTitle }, tr('prDraft')),
            h('span', { style: { flex: 1 } }),
            h('button', { style: S.btn(false), onClick: () => copy(preview.prDraft, 'pr') },
              copied === 'pr' ? tr('copied') : tr('copy'))),
          h('pre', { style: S.pre }, preview.prDraft)))

      const tokenBlock = h('div', { style: S.card },
        h('div', { style: S.cardTitle }, tr('token')),
        identity
          ? h('div', { style: S.row },
              h('span', null, `${tr('connected')}: ${identity.login}`),
              h('span', { style: { flex: 1 } }),
              h('button', { style: S.btn(false), onClick: disconnect }, tr('disconnect')))
          : h('div', null,
              h('input', {
                style: S.input, type: 'password', value: tokenInput,
                placeholder: tr('tokenPlaceholder'),
                onChange: e => setTokenInput(e.target.value),
                onKeyDown: e => { if (e.key === 'Enter' && tokenInput.trim() !== '') connectToken() },
              }),
              h('div', { style: { ...S.row, marginTop: 10 } },
                h('button', {
                  style: S.btn(true, busy === 'token' || tokenInput.trim() === ''),
                  disabled: busy === 'token' || tokenInput.trim() === '',
                  onClick: connectToken,
                }, busy === 'token' ? tr('connecting') : tr('connect')))),
        h('div', { style: S.hint }, tr('tokenNote')),
        // Naming the two permissions is what turns "401 something" into a fix.
        h('div', { style: S.hint }, tr('tokenScopes')))

      return h('div', { style: S.page },
        h('h1', { style: S.h1 }, tr('title')),
        h('div', { style: S.sub }, tr('subtitle')),

        h('div', { style: S.steps },
          [1, 2, 3, 4, 5].map(n => h('button', {
            key: n,
            style: S.step(step === n, stepDone[n]),
            onClick: () => setStep(n),
          }, tr(`step${n}`)))),

        error && h('div', { style: S.banner('error') }, error),

        /* A visible, counted progress bar — a bare spinner cannot say whether the
         * scan is working or wedged. */
        busy === 'scan' && h('div', { style: S.card },
          h('div', { style: S.row },
            h('span', { style: S.cardTitle }, tr('scanning')),
            h('span', { style: { flex: 1 } }),
            h('span', { style: S.mono, opacity: 0.7 },
              progress ? `${(progress.elapsedMs / 1000).toFixed(1)}s` : '')),
          h('div', { style: S.barTrack },
            h('div', {
              style: S.barFill(
                // We cannot know the total up front, so the bar shows bounded work:
                // the fraction of the directory ceiling already visited.
                progress ? Math.min(1, progress.dirsVisited / Math.max(1, progress.dirTotal || 200)) : 0.05,
              ),
            })),
          h('div', { style: S.hint },
            progress
              ? [
                  `${tr('progressDirs')} ${progress.dirsVisited}`,
                  `${tr('progressFound')} ${progress.found}`,
                  progress.rootCount > 1 ? `${tr('progressRoot')} ${progress.rootIndex + 1}/${progress.rootCount}` : null,
                ].filter(Boolean).join(' · ')
              : tr('progressStarting')),
          progress?.current && h('div', { style: S.monoHint }, progress.current)),

        /* ── ① scan ── */
        step === 1 && h('div', null,
          h('div', { style: S.row },
            h('button', {
              style: S.btn(true, busy === 'scan'),
              disabled: busy === 'scan',
              onClick: () => doScan(true),
            }, busy === 'scan' ? tr('scanning') : tr('rescan')),
            h('button', {
              style: S.btn(false),
              onClick: () => setRootsOpen(v => !v),
            }, rootsOpen ? tr('rootsHide') : tr('rootsEdit')),
            scan?.stats && h('span', { style: S.hint },
              `${tr('scannedDirs')} ${scan.stats.dirsVisited} · ${tr('tookMs')} ${(scan.elapsedMs ?? 0)}ms`)),

          /* scan roots — the plugin cannot know where your projects live */
          rootsOpen && h('div', { style: S.card },
            h('div', { style: S.cardTitle }, tr('scanRoots')),
            (config?.roots ?? []).length === 0
              ? h('div', { style: S.note }, tr('rootsEmpty'))
              : (config.roots ?? []).map(r => h('div', {
                  key: r,
                  style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' },
                },
                h('span', { style: { ...S.mono, flex: 1, wordBreak: 'break-all' } }, r),
                h('button', {
                  style: S.btn(false, busy === 'roots'),
                  disabled: busy === 'roots',
                  onClick: () => removeRoot(r),
                }, tr('rootRemove')))),
            config?.editableRoots === false
              ? h('div', { style: S.hint }, tr('rootsFromConfig'))
              : h('div', null,
                  h('div', { style: { ...S.row, marginTop: 10 } },
                    h('input', {
                      style: { ...S.input, flex: 1, minWidth: 240 },
                      value: rootInput,
                      placeholder: tr('rootsPlaceholder'),
                      onChange: e => setRootInput(e.target.value),
                      onKeyDown: e => { if (e.key === 'Enter') addRoot() },
                    }),
                    h('button', {
                      style: S.btn(true, busy === 'roots' || rootInput.trim() === ''),
                      disabled: busy === 'roots' || rootInput.trim() === '',
                      onClick: addRoot,
                    }, tr('rootAdd'))),
                  h('div', { style: S.hint }, tr('rootsHint')))),

          h('div', { style: S.row },
            h('span', { style: S.hint }, `${tr('scanRoots')}: ${(scan?.roots ?? config?.roots ?? []).join('、')}`)),
          h('div', { style: S.cardTitle }, `${tr('found')} (${scan?.found?.length ?? 0})`),
          (scan?.found ?? []).length === 0
            ? h('div', { style: S.note }, tr('noFound'))
            : (scan.found).map(p => h('div', {
                key: p.dir, style: S.item(selected === p.dir), onClick: () => pick(p.dir),
              },
                h('div', null,
                  h('div', { style: S.itemName },
                    `${p.name}${p.version ? ` · v${p.version}` : ''}`,
                    p.installed ? h('span', { style: { ...S.chip, marginLeft: 8, opacity: 0.6 } }, tr('tagInstalled')) : null,
                    p.linked ? h('span', { style: { ...S.chip, marginLeft: 6 } }, tr('tagLinked')) : null),
                  h('div', { style: S.itemMeta }, p.dir),
                  h('div', { style: S.itemMeta },
                    [p.hasClient ? 'client+host' : 'host only', p.repository ?? 'no repository'].join(' · '))))),
          (scan?.nearMisses ?? []).length > 0 && h('div', null,
            h('div', { style: { ...S.cardTitle, marginTop: 18 } }, `${tr('nearMisses')} (${scan.nearMisses.length})`),
            scan.nearMisses.map(p => h('div', {
              key: p.dir, style: S.item(selected === p.dir), onClick: () => pick(p.dir),
            },
              h('div', null,
                h('div', { style: S.itemName }, p.name),
                h('div', { style: S.itemMeta }, p.dir)))))),

        /* ── ② check ── */
        step === 2 && h('div', null,
          !selected
            // The tab is clickable at any time; without a selection there is
            // nothing to fetch, so say so instead of showing a spinner forever.
            ? h('div', { style: S.empty }, tr('needSelection'))
            : !check
              ? (busy === 'check'
                  ? h('div', { style: S.note }, tr('checking'))
                  : h('div', { style: S.empty }, tr('checkNeeded')))
              : h('div', null,
                  h('div', { style: S.row },
                    h('span', { style: S.mono, opacity: 0.7 }, selected),
                    h('span', { style: { flex: 1 } }),
                    h('button', { style: S.btn(false, busy === 'check'), disabled: busy === 'check', onClick: () => doCheck(selected) }, tr('check')),
                    h('button', { style: S.btn(true), onClick: () => loadDraft(selected) }, tr('step3') + ' →')),
                  findingsBlock)),

        /* ── ③ entry ── */
        step === 3 && h('div', null,
          !selected
            ? h('div', { style: S.empty }, tr('needSelection'))
            : !draft
              ? (busy === 'draft'
                  ? h('div', { style: S.note }, tr('loading'))
                  : h('div', { style: S.empty }, tr('entryNeeded')))
              : h('div', null,
                  h('div', { style: S.row },
                    h('span', { style: S.mono, opacity: 0.7 }, selected),
                    h('span', { style: { flex: 1 } }),
                    h('button', { style: S.btn(true), onClick: () => setStep(4) }, tr('step4') + ' →')),
                  // The token lives here as well as on ④/⑤: creating the repo and
                  // uploading the code happen on this step, so making the author
                  // walk to another tab to authenticate would be a dead end.
                  h('div', null, tokenBlock),
                  h('div', { style: S.card }, draftBlock),
                  previewBlock)),

        /* ── ④ screenshots: the single home for adding, previewing and uploading ── */
        step === 4 && h('div', null,
          !selected && h('div', { style: S.empty }, tr('needSelection')),
          tokenBlock,
          h('div', { style: S.card },
            h('div', { style: S.cardTitle }, tr('step4')),
            h('div', { style: S.note }, tr('shotsStep4Note')),

            // Add: paste, drop or pick. This is the only place screenshots are added.
            screenshotDrop,

            // Preview what will be uploaded, with per-image removal.
            (draft?.screenshots ?? []).length > 0
              ? h('div', null,
                  h('div', { style: { ...S.hint, marginTop: 12 } },
                    `${tr('shotsReady')} ${draft.screenshots.length} ${tr('shotUnit')}`),
                  h('div', { style: S.shotGrid },
                    draft.screenshots.map(rel => h('div', { key: rel, style: S.shot },
                      h('img', {
                        style: S.shotImg, alt: rel,
                        src: `${API}/shot?dir=${encodeURIComponent(selected)}&path=${encodeURIComponent(rel)}`,
                        onError: e => { e.target.style.opacity = 0.15 },
                      }),
                      h('button', {
                        type: 'button',
                        style: S.shotRemove,
                        title: tr('shotRemove'),
                        onClick: () => {
                          const next = draft.screenshots.filter(x => x !== rel)
                          setDraft({ ...draft, screenshots: next })
                          saveDraft(selected, { screenshots: next })
                        },
                      }, '×'),
                      h('div', { style: S.shotName }, rel.split('/').pop())))),
                  h('textarea', {
                    style: { ...S.textarea(2), marginTop: 8 },
                    value: draft.screenshots.join('\n'),
                    onChange: e => setDraft({ ...draft, screenshots: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) }),
                    onBlur: e => saveDraft(selected, { screenshots: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) }),
                  }))
              : h('div', { style: { ...S.banner('info'), marginTop: 10 } },
                  h('div', null, tr('shotsNone')),
                  h('div', { style: S.hint }, tr('shotsNoneHint'))),

            h('div', { style: { ...S.row, marginTop: 12 } },
              h('button', {
                style: S.btn(true, !identity || busy === 'shots' || (draft?.screenshots ?? []).length === 0),
                disabled: !identity || busy === 'shots' || (draft?.screenshots ?? []).length === 0,
                onClick: () => doUploadShots(selected),
              }, busy === 'shots' ? tr('uploading') : tr('uploadShots')))),
          shotNote && h('div', { style: S.hint }, shotNote),
          outcome?.ok && outcome?.commitUrl && h('div', { style: S.banner('ok') },
            `${tr('uploaded')}: ${outcome.commitUrl}`),
          h('div', { style: { ...S.row, marginTop: 12 } },
            h('button', { style: S.btn(false), onClick: () => setStep(5) }, tr('step5') + ' →'))),

        /* ── ⑤ submit ── */
        step === 5 && h('div', null,
          !selected && h('div', { style: S.empty }, tr('needSelection')),
          !identity && h('div', { style: S.banner('error') },
            '第 ⑤ 步需要 GitHub token。也可以只把 ③ 步的 YAML 和 PR 描述复制走，自己提 PR —— 效果完全一样。'),
          tokenBlock,
          h('div', { style: { ...S.row, marginTop: 12 } },
            h('button', {
              style: S.btn(false, !identity || busy === 'dry'),
              disabled: !identity || busy === 'dry',
              onClick: () => doSubmit(selected, true),
            }, busy === 'dry' ? tr('submitting') : tr('dryRun')),
            h('button', {
              style: S.btn(true, !identity || busy === 'submit'),
              disabled: !identity || busy === 'submit',
              onClick: () => doSubmit(selected, false),
            }, busy === 'submit' ? tr('submitting') : tr('submit')),
            // Checking what happened is its own action: PR state changes long after
            // submission, and the author should not have to open GitHub to see it.
            h('button', {
              style: S.btn(false, !identity || busy === 'pr'),
              disabled: !identity || busy === 'pr',
              onClick: () => doCheckPr(),
            }, busy === 'pr' ? tr('checkingPr') : tr('checkPr')),

          /* The verdict, in one sentence plus a next step. A red X is not a next step. */
          prStatus && h('div', {
            style: S.banner(
              prStatus.verdict === 'merged' || prStatus.verdict === 'passed' ? 'ok'
                : prStatus.verdict === 'failed' || prStatus.verdict === 'closed' ? 'error'
                  : 'info',
            ),
          },
            h('div', { style: { fontWeight: 600, marginBottom: 4 } },
              `${prStatus.verdict === 'merged' ? '✓ ' : prStatus.verdict === 'passed' ? '✓ '
                : prStatus.verdict === 'failed' || prStatus.verdict === 'closed' ? '✗ ' : '… '}`
              + (prStatus.headline ?? '')),
            prStatus.number && h('div', null,
              h('a', { href: prStatus.url, target: '_blank', rel: 'noreferrer' }, `PR #${prStatus.number}`),
              prStatus.comments > 0 && h('span', { style: S.hint }, ` · ${prStatus.comments} ${tr('prComments')}`)),
            prStatus.detail && h('div', { style: S.hint }, prStatus.detail),

            // Failures, translated one by one with the fix attached.
            (prStatus.failures ?? []).length > 0 && h('ol', { style: { margin: '8px 0 0 18px', padding: 0, fontSize: 12, lineHeight: 1.8 } },
              ...prStatus.failures.map((f, i) => h('li', { key: i },
                h('div', null, h('strong', null, f.title ?? f.name)),
                h('div', { style: S.hint }, f.hint),
                f.url && h('a', { href: f.url, target: '_blank', rel: 'noreferrer', style: S.hint }, tr('viewOnGithub'))))),

            (prStatus.nextSteps ?? []).length > 0 && h('div', { style: { ...S.hint, marginTop: 8 } },
              h('div', { style: { fontWeight: 600 } }, tr('nextSteps')),
              ...prStatus.nextSteps.map((s, i) => h('div', { key: i }, `· ${s}`)))),

            // A failed run that the plugin does not understand gets a re-push button,
            // because that is the only honest option left.
            prStatus?.verdict === 'failed' && h('button', {
              style: { ...S.btn(true), marginTop: 8 },
              onClick: () => doSubmit(selected, false),
            }, tr('repush'))),
          outcome?.plan && h('div', { style: S.card },
            h('div', { style: S.cardTitle },
              outcome.plan.mode === 'update'
                ? `${tr('submitPlan')} · ${tr('modeUpdate')}`
                : `${tr('submitPlan')} · ${tr('modeAdd')}`),
            // An update is a different kind of change; say so before the button is
            // pressed, not after the PR appears.
            outcome.plan.mode === 'update' && h('div', { style: S.hint },
              `${tr('updateExplains')}${outcome.plan.changedLines ? ` ${tr('changedLines')} ${outcome.plan.changedLines}` : ''}`),
            h('div', null, ...(outcome.plan.steps ?? []).map((s, i) => h('div', { key: i, style: S.mono }, `· ${s.label}`))),
            (outcome.plan.warnings ?? []).length > 0 && h('div', { style: S.hint },
              ...outcome.plan.warnings.map((w, i) => h('div', { key: i }, `! ${w}`)))),
          /* Success and "CI will reject it" are two different facts. Showing them in
           * one green box with red exclamation marks inside reads as a failure, which
           * is exactly what it looked like when this first happened in the wild. */
          outcome?.prUrl && h('div', { style: S.banner('ok') },
            h('div', { style: { fontWeight: 600 } },
              outcome.reusedPr ? tr('prReused') : tr('prCreated')),
            h('a', { href: outcome.prUrl, target: '_blank', rel: 'noreferrer' }, outcome.prUrl),
            h('div', { style: S.hint }, tr('prCreatedHint'))),

          (outcome?.warnings ?? []).length > 0 && h('div', { style: S.banner('error') },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, tr('willFailCi')),
            h('div', { style: S.hint }, tr('willFailCiHint')),
            h('ol', { style: { margin: '8px 0 0 18px', padding: 0, fontSize: 12, lineHeight: 1.8 } },
              ...outcome.warnings.map((w, i) => h('li', { key: i }, w))),
            h('div', { style: { ...S.row, marginTop: 10 } },
              // The topic is one API call, so offer to do it instead of describing the
              // GitHub UI steps and leaving the author to it.
              (outcome.repoStatus ? outcome.repoStatus.hasTopic === false : /topic/.test(outcome.warnings.join(' ')))
                && h('button', {
                  style: S.btn(true, busy === 'topic' || !identity),
                  disabled: busy === 'topic' || !identity,
                  onClick: () => doAddTopic(),
                }, busy === 'topic' ? tr('applying') : tr('addTopic')),
              h('button', {
                style: S.btn(false, busy === 'repo'),
                disabled: busy === 'repo',
                onClick: () => doCheckRepo(),
              }, busy === 'repo' ? tr('applying') : tr('recheckRepo'))),
            topicNote && h('div', { style: { ...S.hint, marginTop: 8 } }, topicNote),
            repoStatus && h('div', { style: { ...S.hint, marginTop: 8 } },
              h('div', null,
                `${tr('repoAge')}: ${repoStatus.ageDays != null ? `${repoStatus.ageDays.toFixed(2)} ${tr('days')}` : '?'} — `
                + (repoStatus.oldEnough ? `✓ ${tr('ageOk')}` : `✗ ${tr('ageNotYet')}`)),
              h('div', null, `${tr('repoTopics')}: ${repoStatus.hasTopic ? `✓ dsh-plugin` : `✗ ${tr('topicMissing')}`}`),
              repoStatus.oldEnough && repoStatus.hasTopic && h('div', { style: { marginTop: 6 } }, tr('readyToRepush')))),
          ),

          // What the plugin silently fixed on the author's behalf, said out loud.
          outcome?.topicResult?.ok && h('div', { style: S.banner('ok') },
            outcome.topicResult.already
              ? tr('topicAlready')
              : `${tr('topicAdded')} ${(outcome.topicResult.topics ?? []).join(', ')}`),

          h('div', { style: S.note },
            tr('ciNote')))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'onshelf',
          order: 61,
          label: () => t(localeTag(ctx), 'nav'),
        }, props => {
          // The slot may hand us a context of its own; when it does, it wins,
          // because that is the one carrying the live locale. Spreading ours last
          // would pin every render to the locale captured at apply() time.
          const pageCtx = props?.ctx ?? ctx
          return h(OnshelfPage, { ...props, ctx: pageCtx })
        }))
      },
    }
  },
})
