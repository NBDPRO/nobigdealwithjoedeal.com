/**
 * tests/guides-quick-form-2026-11-25.test.js — every homeowner guide ends with
 * the on-page quick lead form (2026-11-25; the 7 guides had no capture).
 *
 * Checks, per docs/guides/*.html:
 *   - exactly one quick-form host, placed AFTER the generated GUIDE-BODY region
 *     (scripts/build-guides.js owns that region; the form must never be inside it)
 *     and before the "More free guides" list
 *   - the form's CSS and script are loaded
 * And that scripts/add-guide-quick-lead-form.js is idempotent and touches only
 * docs/guides (run against a temp copy).
 *
 * Zero deps. Run: node tests/guides-quick-form-2026-11-25.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'docs', 'guides');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

const pages = fs.readdirSync(DIR).filter((f) => f.endsWith('.html')).sort();
ok('control: the seven homeowner guides are on disk', pages.length === 7, pages);

const count = (s, needle) => s.split(needle).length - 1;
for (const f of pages) {
  const s = fs.readFileSync(path.join(DIR, f), 'utf8');
  const slug = f.replace(/\.html$/, '');
  const host = s.indexOf('data-nbd-quick-form');
  const genEnd = s.indexOf('<!-- GUIDE-BODY:END ' + slug + ' -->');
  const generated = s.indexOf('<!-- GUIDE-BODY:START') !== -1;
  const related = s.indexOf('<nav class="g-related"');
  const placed = host !== -1 && related !== -1 && host < related && (!generated || (genEnd !== -1 && host > genEnd));
  const cssAt = s.indexOf('/assets/css/quick-lead-form.css');
  const jsAt = s.indexOf('/assets/js/quick-lead-form.js');
  ok(slug + ': one quick form, after the generated body and before "More free guides", with its CSS and script',
    count(s, 'data-nbd-quick-form') === 1 && placed && cssAt !== -1 && jsAt !== -1 && count(s, 'id="quote"') === 1,
    { host, genEnd, related, cssAt, jsAt });
}

// The inject script: on a temp copy of docs/guides, a second run changes nothing.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-guides-'));
  try {
    const scriptDir = path.join(tmp, 'scripts'); const docs = path.join(tmp, 'docs', 'guides');
    fs.mkdirSync(scriptDir, { recursive: true }); fs.mkdirSync(docs, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts', 'add-guide-quick-lead-form.js'), path.join(scriptDir, 'add-guide-quick-lead-form.js'));
    for (const f of pages) fs.copyFileSync(path.join(DIR, f), path.join(docs, f));
    const before = pages.map((f) => fs.readFileSync(path.join(docs, f), 'utf8'));
    const out = execFileSync(process.execPath, [path.join(scriptDir, 'add-guide-quick-lead-form.js')], { encoding: 'utf8' });
    const after = pages.map((f) => fs.readFileSync(path.join(docs, f), 'utf8'));
    ok('the inject script is idempotent (a re-run changes no file)', before.every((b, i) => b === after[i]) && /0 changed, 7 skipped, 0 failed/.test(out), out.trim().split('\n').pop());
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// The generator still owns its region: build-guides --check stays clean.
{
  let clean = true; let msg = '';
  try { msg = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-guides.js'), '--check'], { encoding: 'utf8' }); }
  catch (e) { clean = false; msg = String(e.stdout || e.message); }
  ok('build-guides --check is clean (the form is outside every GUIDE-BODY region)', clean, msg.trim().split('\n').pop());
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
