/**
 * tests/sentry-release-stamp-step.test.js — the "Stamp Sentry release with
 * git SHA" deploy step actually rewrites docs/pro/js/sentry-config.js the
 * way Sentry expects, and runs in the right place in the deploy job.
 *
 * WHY THIS EXISTS
 *
 * PR-4c of the Grok Pro/CRM audit evaluation
 * (documentation/audit/GROK-CRM-AUDIT-EVALUATION-2026-09-13.md, verdict row
 * 12). `docs/pro/js/sentry-config.js` has shipped a placeholder release tag
 * (`web@2026-04-26-sentry-on`) since PR #81 (2026-04-26) — every error from
 * every deploy since has landed in the SAME Sentry "release" bucket, so a
 * regression introduced today gets grouped with a 6-month-old bug. The fix
 * (drafted in docs/dev/rock-4-handoff.md#4, never applied because that
 * session's push token lacked `workflow` scope) is a runner-local step that
 * rewrites the placeholder to `web@<date>-<short-sha>` on every hosting
 * deploy, without ever committing the rewrite back to the repo.
 *
 * This test extracts the REAL step body from
 * .github/workflows/firebase-deploy.yml (not a re-typed copy — the same
 * "faithful mirror" precedent as tests/deploy-api-enable-step.test.js) and
 * runs it against a scratch copy of the real sentry-config.js, so a future
 * edit to either file that breaks the pairing fails here first.
 *
 * Run: node tests/sentry-release-stamp-step.test.js   (needs bash; no deps)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const ROOT = path.join(__dirname, '..');
const WF = path.join(ROOT, '.github/workflows/firebase-deploy.yml');
const SENTRY_CONFIG_REL = 'docs/pro/js/sentry-config.js';
const yml = fs.readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');

/** Pull one step's `run: |` block out of the workflow and dedent it. */
function extractRunBlock(stepName) {
  const lines = yml.split('\n');
  const at = lines.findIndex((l) => l.trim() === '- name: ' + stepName);
  if (at < 0) return null;
  let i = at;
  while (i < lines.length && lines[i].trim() !== 'run: |') i++;
  if (i >= lines.length) return null;
  const bodyIndent = lines[i].match(/^(\s*)/)[1] + '  ';
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') { out.push(''); continue; }
    if (!lines[j].startsWith(bodyIndent)) break;
    out.push(lines[j].slice(bodyIndent.length));
  }
  return out.join('\n');
}

/** Pull one step's `if:` condition line (single-line form). */
function extractIfCondition(stepName) {
  const lines = yml.split('\n');
  const at = lines.findIndex((l) => l.trim() === '- name: ' + stepName);
  if (at < 0) return null;
  for (let j = at + 1; j < lines.length && j < at + 4; j++) {
    const m = lines[j].match(/^\s*if:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

console.log('\nsentry-release-stamp-step — PR-4c regression guard\n');

const body = extractRunBlock('Stamp Sentry release with git SHA');
ok('the step body is extractable from the workflow', !!body,
  'the test must run the REAL step, not a copy of it');

if (!body) {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(1);
}

// ── Step ordering + guard condition ───────────────────────────────────────
{
  const lines = yml.split('\n');
  const stampAt = lines.findIndex((l) => l.trim() === '- name: Stamp Sentry release with git SHA');
  const deployAt = lines.findIndex((l) => l.trim() === '- name: Deploy Hosting');
  ok('Deploy Hosting step exists', deployAt > -1);
  // 2026-10-16: the deploy-time minify and its source-map upload sit between them on purpose: the
  // minify must run AFTER the stamp, whose sed matches the readable source. No other step may.
  // 2026-10-27: so does the homepage head-CSS inlining (scripts/inline-head-css.js), which only rewrites docs/index.html.
  const ALLOWED_BETWEEN = ["- name: Minify the CRM's JS and CSS for this deploy", "- name: Inline the homepage head CSS for this deploy", "- name: Keep the deploy's source maps (artifact, not served)"];
  ok('the stamp step runs immediately before Deploy Hosting (only the deploy-time minify steps between them)',
    stampAt > -1 && deployAt > stampAt
    && !lines.slice(stampAt + 1, deployAt).some((l) => /^\s*- name:/.test(l) && ALLOWED_BETWEEN.indexOf(l.trim()) === -1),
    'stampAt=' + stampAt + ' deployAt=' + deployAt);

  const stampIf = extractIfCondition('Stamp Sentry release with git SHA');
  const deployIf = extractIfCondition('Deploy Hosting');
  ok('the stamp step is gated on the SAME push/scope condition as Deploy Hosting (never runs on an unrelated workflow_dispatch scope)',
    stampIf !== null && stampIf === deployIf,
    'stamp if=' + stampIf + '\n      deploy if=' + deployIf);
}

/**
 * Run the real step body against a scratch copy of a given
 * sentry-config.js-shaped file, with GITHUB_SHA set the way GitHub Actions
 * sets it (a full 40-char SHA).
 */
function runStep({ githubSha, withConfigFile, configContent }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-sentry-stamp-'));
  const jsDir = path.join(dir, 'docs', 'pro', 'js');
  fs.mkdirSync(jsDir, { recursive: true });
  if (withConfigFile) {
    fs.writeFileSync(path.join(jsDir, 'sentry-config.js'), configContent, 'utf8');
  }
  const harness = `
exec 2>&1
GITHUB_SHA=${JSON.stringify(githubSha)}
${body}
`;
  const script = path.join(dir, 'step.sh');
  fs.writeFileSync(script, harness);
  const stdout = execFileSync('bash', [script], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const finalConfig = withConfigFile
    ? fs.readFileSync(path.join(jsDir, 'sentry-config.js'), 'utf8')
    : null;
  return { stdout, finalConfig };
}

// ── the everyday case: sentry-config.js exists with the real placeholder ──
{
  // Read the committed BLOB, not the working-tree file: this repo's local
  // checkout is CRLF (Windows core.autocrlf), but `git ls-files --eol` shows
  // the git object itself is LF-only and there is no .gitattributes forcing
  // conversion, so ubuntu-latest (this workflow's runs-on) checks it out as
  // LF. Testing against the CRLF working copy would fail here for a reason
  // that can never happen on the real runner: Git Bash's `sed -i` silently
  // normalizes CRLF->LF on write (the documented footgun this repo's own
  // CLAUDE.md warns about for local edits), which looks like "sed touched
  // untargeted lines" but is really an artifact of the LOCAL line ending,
  // not the step.
  const realConfig = execFileSync('git', ['show', 'HEAD:' + SENTRY_CONFIG_REL], { cwd: ROOT, encoding: 'utf8' });
  ok('the committed sentry-config.js blob is LF (matches what ubuntu-latest checks out)',
    !realConfig.includes('\r'), 'if this ever becomes CRLF, this test needs to stop normalizing');
  ok('the real sentry-config.js still carries a bare web@ placeholder to stamp over',
    /window\.__NBD_RELEASE\s*=\s*'web@[^']*';/.test(realConfig),
    'if this no longer matches, the sed pattern in the workflow step needs updating too');

  const sha = 'a93a4b871234567890abcdef1234567890abcdef';
  const { stdout, finalConfig } = runStep({ githubSha: sha, withConfigFile: true, configContent: realConfig });

  ok('prints a ::notice:: with the stamped tag',
    /::notice::Sentry release stamped/.test(stdout), stdout);
  ok('the notice uses only the first 8 chars of the SHA',
    stdout.includes(sha.slice(0, 8)) && !stdout.includes(sha.slice(0, 9)),
    stdout);
  ok('raises no ::warning:: when the file is present',
    !stdout.includes('::warning::'), stdout);

  const tagMatch = finalConfig.match(/window\.__NBD_RELEASE\s*=\s*'([^']*)';/);
  ok('sentry-config.js was rewritten with a NEW release tag (not left as the placeholder)',
    !!tagMatch && tagMatch[1] !== 'web@2026-04-26-sentry-on', finalConfig);
  ok('the new tag has the documented shape web@<YYYY-MM-DD>-<8-char-sha>',
    !!tagMatch && /^web@\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/.test(tagMatch[1]),
    tagMatch && tagMatch[1]);
  ok('the new tag embeds the correct short SHA',
    !!tagMatch && tagMatch[1].endsWith(sha.slice(0, 8)), tagMatch && tagMatch[1]);

  // This is the actual regression contract with tests/smoke/dashboard.test.js
  // — that suite's own pin only requires the value start with 'web@', so the
  // runner-local rewrite must never produce anything that fails IT.
  ok('the rewritten line still satisfies tests/smoke/dashboard.test.js\'s __NBD_RELEASE pin',
    /window\.__NBD_RELEASE\s*=\s*['"]web@/.test(finalConfig));

  // Every other line of the file must survive untouched — the sed is a
  // single-line substitution, not a rewrite of the whole file.
  const realLines = realConfig.split('\n');
  const finalLines = finalConfig.split('\n');
  const releaseLineIdx = realLines.findIndex((l) => /window\.__NBD_RELEASE/.test(l));
  ok('every line OTHER than the release line is byte-identical to the source file',
    releaseLineIdx > -1
    && realLines.length === finalLines.length
    && realLines.every((l, i) => i === releaseLineIdx || l === finalLines[i]),
    'sed touched more than the one targeted line');
}

// ── missing file: warn, don't crash the deploy ────────────────────────────
{
  const { stdout } = runStep({ githubSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', withConfigFile: false });
  ok('missing sentry-config.js raises a ::warning:: instead of failing the step',
    /::warning::sentry-config\.js not found/.test(stdout), stdout);
  ok('missing sentry-config.js does NOT print a stamped-release notice',
    !stdout.includes('::notice::Sentry release stamped'), stdout);
}

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
