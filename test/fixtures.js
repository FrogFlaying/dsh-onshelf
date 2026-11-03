/**
 * Fixtures for the onshelf tests.
 *
 * Each fixture is a throwaway plugin directory written to a temp root, shaped to
 * trigger one specific rule from contributing.md. They are created on demand and
 * removed afterwards, so nothing here is left on disk.
 *
 * @module test/fixtures.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function makeTempRoot(prefix = 'onshelf-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function removeTempRoot(root) {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
}

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
}

/**
 * A fully compliant plugin: bundle + patch + peer deps with a prerelease branch +
 * repository + real code + README + screenshots.
 */
export function writeGoodPlugin(root, overrides = {}) {
  const dir = path.join(root, 'good-plugin')
  const pkg = {
    name: 'dsh-good-plugin',
    version: '1.2.3',
    type: 'module',
    description: 'Greets people by name from a registered agent tool.',
    repository: { type: 'git', url: 'git+https://github.com/alice/dsh-good-plugin.git' },
    peerDependencies: {
      '@deepseek-ai/dsh-tools': '>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0',
    },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web' },
    },
    meta: { title: '问候', description: '注册一个按名字打招呼的 agent 工具。' },
    ...overrides,
  }
  write(dir, {
    'package.json': JSON.stringify(pkg, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: good-plugin\n      name: 'dsh-good-plugin'\n",
    'index.js': [
      "export const name = 'good-plugin'",
      "export function apply(ctx) {",
      '  ctx.tools.register({',
      "    name: 'greet',",
      "    description: 'Greet someone by name.',",
      '    async execute(args) { return `Hello, ${args.name}` },',
      '  })',
      '}',
    ].join('\n'),
    'README.md': '# dsh-good-plugin\n\nGreets people.\n',
    'assets/shot-1.png': 'not-a-real-png',
    'screenshots.json': JSON.stringify(['assets/shot-1.png'], null, 2),
  })
  return dir
}

/** Declares only `dsh.client` — the single most common rejection reason. */
export function writeClientOnlyPlugin(root) {
  const dir = path.join(root, 'client-only')
  write(dir, {
    'package.json': JSON.stringify({
      name: 'dsh-client-only',
      version: '0.1.0',
      description: 'A plugin that forgot dsh.bundle.',
      dsh: { client: { platform: 'web' } },
    }, null, 2),
    'index.js': 'export const name = "client-only"\nexport function apply() {}\n',
    'README.md': '# client only\n',
  })
  return dir
}

/** Official packages in `dependencies` plus the prerelease peer-range trap. */
export function writePeerTrapPlugin(root) {
  const dir = path.join(root, 'peer-trap')
  write(dir, {
    'package.json': JSON.stringify({
      name: 'dsh-peer-trap',
      version: '0.1.0',
      description: 'Uses the wrong dependency block and a peer range that excludes prereleases.',
      dependencies: { '@deepseek-ai/dsh-tools': '^0.1.0' },
      peerDependencies: { '@deepseek-ai/dsh-client-ui': '>=0.0.1-rc.1 <0.2.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: peer-trap\n      name: 'dsh-peer-trap'\n",
    'index.js': 'export const name = "peer-trap"\nexport function apply() {}\n',
  })
  return dir
}

/** A patch file that is a mapping instead of a top-level array. */
export function writeBadPatchPlugin(root) {
  const dir = path.join(root, 'bad-patch')
  write(dir, {
    'package.json': JSON.stringify({
      name: 'dsh-bad-patch',
      version: '0.1.0',
      description: 'Patch file in the wrong shape.',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': 'insert:\n  - id: bad-patch\n',
    'index.js': 'export const name = "bad-patch"\n',
  })
  return dir
}

/** A directory that is not a plugin at all. */
export function writePlainPackage(root) {
  const dir = path.join(root, 'plain')
  write(dir, {
    'package.json': JSON.stringify({ name: 'some-lib', version: '1.0.0' }, null, 2),
    'index.js': 'module.exports = {}\n',
  })
  return dir
}

/** A monorepo with the plugin in a subpackage. */
export function writeMonorepo(root) {
  const repoDir = path.join(root, 'monorepo')
  write(repoDir, {
    'package.json': JSON.stringify({ name: 'monorepo-root', private: true, version: '1.0.0' }, null, 2),
    'packages/my-plugin/package.json': JSON.stringify({
      name: 'dsh-my-plugin',
      version: '0.2.0',
      description: 'The subpackage that is actually the plugin.',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'packages/my-plugin/cordis.patch.yml': "- insert:\n    - id: my-plugin\n      name: 'dsh-my-plugin'\n",
    'packages/my-plugin/index.js': 'export const name = "my-plugin"\n',
  })
  return repoDir
}
