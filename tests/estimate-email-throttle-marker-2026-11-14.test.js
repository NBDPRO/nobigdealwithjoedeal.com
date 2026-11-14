/**
 * tests/estimate-email-throttle-marker-2026-11-14.test.js
 *
 * estimateEmail claims the estimate_leads doc (stamps estimateEmailedAt) and
 * then spends the per-recipient (3/day) and global (100/day) caps. When a cap
 * refused, the handler returned with the doc still stamped "emailed" and no
 * status: the homeowner got nothing and nothing on the record said so. The
 * throttled branch must clear the stamp and leave estimateEmailStatus
 * 'throttled', the way the held_paused / canary branches already do.
 * (The Cloud Function can't be required standalone; this reads the
 * comment-stripped source of the one branch.)
 *
 * Run: node tests/estimate-email-throttle-marker-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(label, cond) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label); failed++; }
}

const raw = fs.readFileSync(path.join(__dirname, '..', 'functions', 'estimate-email.js'), 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const i = src.indexOf('if (!(await spendCaps()))');
const branch = i === -1 ? '' : src.slice(i, src.indexOf('return;', i) + 7);
const send = src.indexOf('resend.emails.send(gated.msg)');

console.log('\nestimateEmail throttled branch');
ok('the spendCaps() gate exists before the send', i !== -1 && send !== -1 && i < send);
ok('a throttled send marks estimateEmailStatus throttled', /estimateEmailStatus: 'throttled'/.test(branch));
ok('…and clears the estimateEmailedAt claim stamp', /estimateEmailedAt: FieldValue\.delete\(\)/.test(branch));
ok('…before returning (not a bare return)', !/^if \(!\(await spendCaps\(\)\)\) return;/.test(branch) && /\.update\(/.test(branch));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
