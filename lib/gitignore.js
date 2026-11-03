/**
 * Read the author's own `.gitignore`, so "upload my plugin" respects it.
 *
 * Why this is here: the wizard collects a directory and pushes it, and it used to
 * choose what to skip from a hard-coded list alone. A plugin that writes runtime
 * files — session snapshots, caches, a local config override — says so in
 * `.gitignore`, in the author's own words. Ignoring that file once collected 144
 * desktop snapshots (7 MB of real window titles, user names and folder paths) for a
 * public repo, while the plugin's own `.gitignore` said in its first line "never
 * commit them". The exclusion the author already wrote wins.
 *
 * Deliberately not a git implementation: no `.git/info/exclude`, no global
 * `core.excludesFile`, and no `git check-ignore` (the author should not have to
 * install git — that premise is the whole plugin). Supported, because real plugin
 * repos use them: comments, blank lines, `!` negation, a trailing `/` for
 * directories, `*` `?` `**`, `[...]` character classes, a leading or middle `/` for
 * anchoring, escaped `\#` `\!` and `\ `, and nested `.gitignore` files, where a
 * deeper file overrides a shallower one.
 *
 * @module lib/gitignore.js
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * The one reason string for "the author's .gitignore kept this out".
 *
 * Deliberately free of a `：` separator: `skippedSummary()` groups by the text before
 * the first colon, so every ignored file collapses into one readable line instead of
 * 144.
 */
export const GITIGNORE_SKIP_REASON = '被 .gitignore 排除'

/**
 * Parse `.gitignore` text into rules for {@link isIgnored}.
 *
 * `base` is the directory the file lives in, relative to the collected root ('' for
 * the root), because a rule only ever applies inside its own directory. Rules come
 * back in file order: the last matching rule wins.
 */
export function parseGitignore(text, base = '') {
  const rules = []

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    // Trailing whitespace is not part of the pattern unless it is escaped.
    const line = raw.replace(/(?<!\\)\s+$/, '')
    if (line === '' || line.startsWith('#')) continue

    const negated = line.startsWith('!')
    let body = negated ? line.slice(1) : line
    if (body === '') continue

    const dirOnly = body.endsWith('/')
    if (dirOnly) body = body.replace(/\/+$/, '')
    if (body === '') continue

    // "If there is a separator at the beginning or middle of the pattern, then the
    // pattern is relative to the .gitignore's own directory; otherwise it may also
    // match at any level below it."
    const anchored = body.includes('/')
    if (anchored) body = body.replace(/^\/+/, '')
    if (body === '') continue

    rules.push({
      negative: negated,
      dirOnly,
      base,
      source: line,
      regex: compile(body, anchored),
    })
  }

  return rules
}

/**
 * The rules of `dir`'s `.gitignore`, or none when there is no readable file there.
 * A missing file is the normal case; an unreadable one must not stop the upload.
 */
export function loadGitignoreRules(dir, base = '') {
  let text
  try {
    text = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')
  } catch {
    return []
  }
  return parseGitignore(text, base)
}

/**
 * Does `relPath` end up excluded, once every rule has had its say?
 *
 * Pass the rules ordered shallowest directory first, so a nested `.gitignore` wins
 * over the one above it. Directories are matched too: git never re-includes anything
 * inside an excluded directory, and neither does the walk in `lib/upload.js`, which
 * prunes the subtree instead of descending into it.
 */
export function isIgnored(rules, relPath, isDir = false) {
  let ignored = false
  for (const rule of rules) {
    if (ruleMatches(rule, relPath, isDir)) ignored = !rule.negative
  }
  return ignored
}

function ruleMatches(rule, relPath, isDir) {
  // `foo/` only ever excludes a directory.
  if (rule.dirOnly && !isDir) return false

  let subject = relPath
  if (rule.base) {
    if (!relPath.startsWith(`${rule.base}/`)) return false
    subject = relPath.slice(rule.base.length + 1)
  }
  return rule.regex.test(subject)
}

/** Build the pattern's matcher: anchored patterns pin to the base, others to any name. */
function compile(body, anchored) {
  const segments = body.split('/')
  let source = anchored ? '^' : '^(?:.*/)?'

  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (segment === '**') {
      // `a/**/b` spans any number of directories; a trailing `**` is everything below.
      source += last ? '.*' : '(?:[^/]+/)*'
      return
    }
    source += segmentToRegex(segment)
    if (!last) source += '/'
  })

  source += '$'

  try {
    return new RegExp(source)
  } catch {
    // A malformed class like `[z-a]` must not crash the upload, and it must not
    // quietly match nothing either: read the whole pattern as a literal name.
    return new RegExp(`^${escapeRe(body).replace(/\//g, '/')}$`)
  }
}

function segmentToRegex(segment) {
  let out = ''
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]

    if (char === '\\' && i + 1 < segment.length) {
      out += escapeRe(segment[++i])
      continue
    }
    if (char === '*') { out += '[^/]*'; continue }
    if (char === '?') { out += '[^/]'; continue }
    if (char === '[') {
      const end = classEnd(segment, i)
      if (end > i) {
        out += classRegex(segment.slice(i, end + 1))
        i = end
        continue
      }
    }
    out += escapeRe(char)
  }
  return out
}

/** The index of the `]` closing the class opened at `start`, or -1. */
function classEnd(segment, start) {
  for (let i = start + 1; i < segment.length; i++) {
    if (segment[i] === '\\') { i++; continue }
    if (segment[i] === ']' && i > start + 1) return i
  }
  return -1
}

function classRegex(text) {
  let inner = text.slice(1, -1) // strip [ ]
  let negative = false
  if (inner.startsWith('!') || inner.startsWith('^')) {
    negative = true
    inner = inner.slice(1)
  }
  inner = inner.replace(/\\/g, '\\\\')
  // A class must never swallow the path separator.
  if (!inner.includes('/')) inner = inner.replace(/^\]/, '\\]')
  if (inner === '') return '[^/]'
  return `[${negative ? '^' : ''}${inner}]`
}

function escapeRe(char) {
  return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
