/**
 * tests/email-queue-recipients-2026-10-19.test.js
 *
 * email-queue-worker.js sends raw (no customer kill switch / canary) because EVERY row it carries is account
 * mail: to the owner, to a platform address, or to a contractor's own Auth email. This test enforces that:
 * for every file that can queue a row, each recipient expression must be pinned here together with the
 * source that proves it is one of those three. A new writer, a new recipient, or a recipient taken from a
 * lead / homeowner field fails until it is reviewed and added on purpose.
 *
 * Run: node tests/email-queue-recipients-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { stripJsComments } = require('./lib/strip-js-comments');

const FN = path.join(__dirname, '..', 'functions');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const PLATFORM = /'jd@nobigdealwithjoedeal\.com'/;
// file -> { to: [recipient expressions, in file order], proof: [regexes that must ALL match the file] }
const WRITERS = {
  'backup-freshness.js': { to: ['RECIPIENT'], proof: [/const RECIPIENT = 'jd@nobigdealwithjoedeal\.com'/] },
  'health-digest.js': { to: ['RECIPIENT'], proof: [/const RECIPIENT = 'jd@nobigdealwithjoedeal\.com'/] },
  // `to` is assigned AFTER `mail` (Object.assign({..}, mail, { to })) so nothing in the built email can redirect the alert.
  'pro-prospects.js': {
    to: ['PLATFORM_ALERT_EMAIL'],
    proof: [/PLATFORM_ALERT_EMAIL = process\.env\.PLATFORM_ALERT_EMAIL \|\| 'jd@nobigdealwithjoedeal\.com'/, /\}, mail, \{\s*to: PLATFORM_ALERT_EMAIL,/],
  },
  'tenant-ops.js': {
    to: ['PLATFORM_ALERT_EMAIL', 'ownerEmail'],
    proof: [/PLATFORM_ALERT_EMAIL = process\.env\.PLATFORM_ALERT_EMAIL \|\| 'jd@nobigdealwithjoedeal\.com'/, /ownerEmail = \(await auth\.getUser\(co\.ownerId\)\)\.email/],
  },
  'care-plan.js': { to: ['await ownerEmail(db)'], proof: [/db\.collection\('users'\)\.doc\(OWNER\)\.get\(\)/, /return OWNER_ALERT_FALLBACK/] },
  'integrations/compliance.js': { to: ['email'], proof: [/getAuth\(\)\.getUser\(uid\)/, /email = userRecord\.email/] },
  'messaging-controls-fns.js': { to: ['beforeOwner.email'], proof: [/beforeOwner = await MC\.readOwnerContact\(/] },
  'monthly-overhead-alert.js': { to: ['email'], proof: [/email = \(await getAuth\(\)\.getUser\(ownerUid\)\)\.email/] },
  'stripe.js': {
    to: ['email', 'email', 'ownerEmail', 'email'],
    proof: [/email = \(await getAuth\(\)\.getUser\(uid\)\)\.email/, /const email = userRecord\.email/,
      /ownerEmail = \(await getAuth\(\)\.getUser\(String\(opts\.ownerUid\)\)\)\.email/, /const email = \(await getAuth\(\)\.getUser\(opts\.uid\)\)\.email/],
  },
};

function recipients(src) {
  // Every `to:` in the object literal that follows a queue write site (email_queue path or enqueueOnce).
  const out = [];
  const seen = new Set();
  const re = /email_queue['"\/`]|enqueueOnce\(db, [`'"]/g;
  let m;
  while ((m = re.exec(src))) {
    const seg = src.slice(m.index, m.index + 700);
    const t = /\bto:\s*([^,\n}]+)/.exec(seg);
    if (!t) continue;
    const at = m.index + t.index;
    if (seen.has(at)) continue;
    seen.add(at);
    out.push({ at, expr: t[1].trim() });
  }
  return out.sort((a, b) => a.at - b.at).map((r) => r.expr);
}

for (const [rel, spec] of Object.entries(WRITERS)) {
  const src = stripJsComments(fs.readFileSync(path.join(FN, rel), 'utf8'));
  const got = recipients(src);
  ok(rel + ': queued recipients are exactly the pinned set (' + spec.to.join(', ') + ')', JSON.stringify(got) === JSON.stringify(spec.to), got.join(' | '));
  ok(rel + ': each recipient is provably a platform address, the owner, or the account holder\'s own Auth email', spec.proof.every((p) => p.test(src)));
}

ok('all 13 queue recipients are pinned (backup-freshness, care-plan, health-digest, compliance, controls-fns, overhead, pro-prospects, stripe x4, tenant-ops x2)', Object.values(WRITERS).reduce((n, w) => n + w.to.length, 0) === 13);

// Controls: the scanner is not blind, and a homeowner-sourced recipient would be caught.
{
  const bad = "await db.collection('email_queue').add({ to: lead.email, subject: 's' });";
  ok('control: a queued row to lead.email is reported as an unpinned recipient', JSON.stringify(recipients(bad)) === JSON.stringify(['lead.email']));
  ok('control: the pinned map does not contain a lead/customer-derived recipient', Object.values(WRITERS).every((w) => w.to.every((e) => !/lead|customer|homeowner|contact/i.test(e))));
}

// The worker header states the rule this test enforces.
{
  const w = fs.readFileSync(path.join(FN, 'integrations/email-queue-worker.js'), 'utf8');
  ok('email-queue-worker.js header documents the account-mail-only rule and names this test', /account mail only/i.test(w) && /email-queue-recipients-2026-10-19/.test(w));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
