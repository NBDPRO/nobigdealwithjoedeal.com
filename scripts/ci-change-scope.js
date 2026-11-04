#!/usr/bin/env node
/**
 * CI change scope (2026-11-04).
 *
 * Reads the list of changed paths on stdin (one per line, `git diff --name-only`)
 * and prints `heavy=true` or `heavy=false` for $GITHUB_OUTPUT.
 *
 * heavy=false ONLY when every changed path is documentation that no runtime,
 * build or test reads: the Obsidian vault under documentation/, root-level *.md
 * (README, CLAUDE.md) and the vault's .obsidian/ config. docs/ is the LIVE SITE,
 * not documentation, and never counts.
 *
 * Fails open: an empty list, unreadable input or any path outside the allow-list
 * prints heavy=true, so the optional heavy jobs run. ci.yml gates those jobs on
 * `heavy != 'false'`, so a crash here (no output at all) also runs them.
 *
 * Only NON-required jobs are gated (see the change-scope job in ci.yml). Required
 * checks always run: a skipped required job reports "skipped", and a skipped
 * matrix job reports one unexpanded name, which would hang the merge queue.
 */
'use strict';

const DOCS_ONLY = [
  /^documentation\//,
  /^[^/]+\.md$/,
  /^\.obsidian\//,
];

function isDocsOnly(paths) {
  const list = paths.map((p) => p.trim()).filter(Boolean);
  if (list.length === 0) return false;
  return list.every((p) => DOCS_ONLY.some((re) => re.test(p)));
}

module.exports = { isDocsOnly, DOCS_ONLY };

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    const paths = input.split(/\r?\n/);
    const docsOnly = isDocsOnly(paths);
    const n = paths.filter((p) => p.trim()).length;
    console.error(`change-scope: ${n} changed path(s); docs-only=${docsOnly}`);
    process.stdout.write(`heavy=${docsOnly ? 'false' : 'true'}\n`);
  });
}
