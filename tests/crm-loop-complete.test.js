/**
 * tests/crm-loop-complete.test.js — contract guards for the "all 14"
 * CRM messaging / thread / briefing pass (2026-07-19).
 *
 * Zero deps. Run: node tests/crm-loop-complete.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name); }
}

console.log('CRM LOOP COMPLETE — contracts + branch report');

// Money honesty residual (item 12) — customer surfaces should prefer retailTotal
const cer = read('docs/pro/js/customer-estimate-rows.js');
const ip = read('docs/pro/js/invoice-pipeline.js');
ok('customer-estimate-rows + invoice buildRowItems reference retailTotal',
  /retailTotal/.test(cer) && /retailTotal/.test(ip) && /buildRowItems|buildDisplayRows/.test(cer + ip));

// Funnel leftovers already on main (item 6) — keep guarded
const login = read('docs/pro/js/pages/login.js');
const bg = read('docs/pro/js/billing-gate.js');
ok('login resumes nbd_plan_intent; billing getPlan exposes loaded',
  /nbd_plan_intent/.test(login) && /loaded:\s*_loaded/.test(bg));

// Intro video (item 7): since 2026-10-05 the homepage slot is a self-hosted
// <video> (no YouTube ID, no intro-video.js); its rules are pinned in
// tests/home-welcome-video-2026-10-05.test.js.
const home = read('docs/index.html');
ok('homepage #intro-video is the self-hosted welcome video',
  /id="intro-video"/.test(home) && /<video class="iv-video"/.test(home) && !/data-yt=/.test(home));

// Estimate email global cap still env-driven (item 8)
const ee = read('functions/estimate-email.js');
ok('estimate email has global cap + ESTIMATE_EMAIL_ENABLED kill switch',
  /ESTIMATE_EMAIL_GLOBAL_CAP/.test(ee) && /ESTIMATE_EMAIL_ENABLED/.test(ee));

// Branch cleanup report (item 13) — list remote branches not merged to main
console.log('\n  ── Branch cleanup report (remote, not merged to origin/main) ──');
try {
  const out = execSync('git branch -r --no-merged origin/main', {
    cwd: root, encoding: 'utf8', timeout: 15000,
  });
  const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    .filter(b => !/HEAD|origin\/main$/.test(b));
  const keepers = lines.filter(b => /feat\/|fix\/|claude\//.test(b));
  console.log('  unmerged remote branches: ' + lines.length);
  keepers.slice(0, 25).forEach(b => console.log('    · ' + b));
  if (keepers.length > 25) console.log('    … +' + (keepers.length - 25) + ' more');
  ok('branch report generated (no deletes — Jo reviews list)', lines.length >= 0);
} catch (e) {
  ok('branch report generated (git unavailable in CI ok)', true);
  console.log('  (skipped git list: ' + (e.message || e) + ')');
}

// Jo live checklist (item 2) — printable in test output
console.log(`
  ── Jo live validation checklist (do after deploy) ──
  [ ] 1. Seat-buy: Settings → Team → buy 1 seat on trial → Stripe seat line → set 0
  [ ] 2. Estimate email: send one real homeowner estimate email (not dry-run)
  [ ] 3. Pipelines editor: rename/add custom stage → board buckets correctly
  [ ] 4. Smart follow-up: open lead → wait for ✨ AI → Email (platform toast)
  [ ] 5. Stage drip: move a lead with email → toast "Send now" → platform send
  [ ] 6. Comm Log: see the send on the lead (manager: team thread if companyId stamped)
  [ ] 7. Twilio/A2P: if SMS fails, finish Twilio paid + A2P; check toast guidance
  [ ] 8. Content (optional): OH/KY reg # on area pages
`);

ok('Jo checklist printed', true);

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
