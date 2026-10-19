/**
 * tests/messaging-zero-cap-2026-10-19.test.js
 *
 * WHY: `Number(process.env.STORM_MAX_SMS_PER_DAY) || 2000` turned the
 * documented kill switch "=0" into 2000 (messaging audit 2026-10-19, Twilio
 * A2P now delivering). A cap or switch read from env must keep a real 0.
 *
 *   A. functions/env-number.js envCap: unset/blank/junk/negative -> default,
 *      0 -> 0, 7.9 -> 7.
 *   B. No `Number|parseInt|parseFloat(process.env.X) ||` fallback survives in
 *      functions/ (comments stripped) except two non-cap allow-listed values;
 *      positive controls prove the scanner CAN see the pattern.
 *   C. The customer-facing / spend caps read through envCap.
 *
 * Run: node tests/messaging-zero-cap-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { stripJsComments } = require('./lib/strip-js-comments');
const { envCap } = require('../functions/env-number');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// A
ok('envCap: 0 stays 0', envCap('0', 2000) === 0);
ok('envCap: number 0 stays 0', envCap(0, 2000) === 0);
ok('envCap: unset -> default', envCap(undefined, 2000) === 2000);
ok('envCap: null -> default', envCap(null, 2000) === 2000);
ok('envCap: blank -> default', envCap('  ', 2000) === 2000);
ok('envCap: junk -> default', envCap('abc', 2000) === 2000);
ok('envCap: negative -> default', envCap('-5', 2000) === 2000);
ok('envCap: Infinity -> default', envCap('Infinity', 2000) === 2000);
ok('envCap: 7.9 -> 7', envCap('7.9', 2000) === 7);
ok('envCap: 250 -> 250', envCap('250', 2000) === 250);

// B
const FN = path.join(__dirname, '..', 'functions');
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const BAD_SRC = '(?:Number|parseInt|parseFloat)\\(\\s*process\\.env\\.([A-Z0-9_]+)\\s*(?:,\\s*10\\s*)?\\)\\s*\\|\\|';
const ALLOW = new Set(['NBD_MEASUREMENT_PASSTHRU_PRICE', 'AUDIT_LOG_RETENTION_DAYS']);
ok('scanner positive control: sees the old pattern',
  new RegExp(BAD_SRC).test(stripJsComments('const a = Number(process.env.STORM_X) || 5;')));
ok('scanner positive control: a comment-only mention is ignored',
  !new RegExp(BAD_SRC).test(stripJsComments('// const a = Number(process.env.STORM_X) || 5;\nconst b = 1;')));
const offenders = [];
for (const f of walk(FN, [])) {
  const src = stripJsComments(fs.readFileSync(f, 'utf8'));
  const re = new RegExp(BAD_SRC, 'g');
  let m;
  while ((m = re.exec(src))) if (!ALLOW.has(m[1])) offenders.push(path.relative(FN, f) + ':' + m[1]);
}
ok('no Number(process.env.X) || default left on a cap/switch', offenders.length === 0, offenders.join(', '));

// C
function code(rel) { return stripJsComments(fs.readFileSync(path.join(FN, rel), 'utf8')); }
ok('storm per-run cap reads envCap',
  /MAX_SMS_PER_RUN\s*=\s*envCap\(process\.env\.STORM_MAX_SMS_PER_RUN,\s*250\)/.test(code('sms-functions.js')));
ok('storm per-day cap reads envCap',
  /MAX_SMS_PER_DAY\s*=\s*envCap\(process\.env\.STORM_MAX_SMS_PER_DAY,\s*2000\)/.test(code('sms-functions.js')));
ok('estimate-email global cap reads envCap',
  /envCap\(process\.env\.ESTIMATE_EMAIL_GLOBAL_CAP,\s*100\)/.test(code('estimate-email.js')));
ok('public AI daily cap reads envCap',
  /envCap\(process\.env\.PUBLIC_AI_DAILY_CAP,\s*300\)/.test(code(path.join('handlers', 'ai.js'))));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
