/**
 * tests/smoke/phone-digits.test.js — inbound-SMS phone match key.
 *
 * Two layers:
 *   1. REAL unit tests of functions/phone-utils.js phoneDigits10() — the
 *      canonical last-10-US-digits normalization. This is the actual logic
 *      both the read side (incomingSMS) and every write side (lead-create
 *      paths + backfill) depend on; if it's wrong, inbound texts stop
 *      tying to leads.
 *   2. STATIC guards that the read path queries by phoneDigits and that
 *      every lead-write path stamps it — including a drift guard that the
 *      browser paths inline the SAME transform as the shared helper (they
 *      can't `require` the Node module, so they hand-inline it).
 *
 * Zero deps — phone-utils.js is firebase-free and pure.
 */

'use strict';

const path = require('path');
const { ROOT, PRO_JS, FUNCTIONS, read } = require('./_shared');

const { phoneDigits10 } = require(path.join(FUNCTIONS, 'phone-utils.js'));

// The exact inlined transform the browser write paths must use, byte-for-byte
// with the helper body. Drift here = stamped key ≠ looked-up key = silent
// match failure, so the static guards below assert this literal appears.
const CANON_INLINE = /\.replace\(\/\\D\/g, ''\)\.replace\(\/\^1\/, ''\)\.slice\(-10\)/;

module.exports.run = function run(ctx) {
  const { assert, section } = ctx;

  // ── 1. Unit: phoneDigits10 normalization ───────────────────
  section('phoneDigits10 — normalization (unit)');
  {
    const cases = [
      // [input, expected, label]
      ['(555) 123-4567',     '5551234567', 'rep free-form with punctuation'],
      ['+15551234567',       '5551234567', 'Twilio E.164'],
      ['1-555-123-4567',     '5551234567', 'leading country code + dashes'],
      ['555.123.4567',       '5551234567', 'dot-separated'],
      ['5551234567',         '5551234567', 'already 10 bare digits'],
      ['+1 (555) 123-4567',  '5551234567', 'E.164 with spacing'],
      ['  (555) 123-4567 ',  '5551234567', 'surrounding whitespace'],
      [5551234567,           '5551234567', 'stored as a JS number'],
      ['',                   '',           'empty string'],
      [null,                 '',           'null'],
      [undefined,            '',           'undefined'],
      ['abc',                '',           'no digits at all'],
    ];
    for (const [input, expected, label] of cases) {
      const got = phoneDigits10(input);
      assert('phoneDigits10(' + JSON.stringify(input) + ') === ' + JSON.stringify(expected)
        + ' — ' + label, got === expected, 'got ' + JSON.stringify(got));
    }

    // Always a string ≤ 10 chars (never throws on odd input).
    assert('returns a string', typeof phoneDigits10('+15551234567') === 'string');
    assert('never longer than 10 digits',
      phoneDigits10('+1 (555) 123-4567 ext 99').length <= 10);

    // THE invariant the whole fix rests on: an E.164 inbound and the
    // free-form-typed lead phone normalize to the SAME key.
    assert('E.164 inbound matches rep-typed lead (the core invariant)',
      phoneDigits10('+15551234567') === phoneDigits10('(555) 123-4567'));
    assert('country-code and bare 10-digit forms collapse to one key',
      phoneDigits10('15551234567') === phoneDigits10('5551234567'));
    // A genuinely different number must NOT collide.
    assert('distinct numbers produce distinct keys',
      phoneDigits10('+15551234567') !== phoneDigits10('+15559876543'));
  }

  // ── 2. Helper module shape ─────────────────────────────────
  section('phone-utils — module contract');
  {
    const src = read(path.join(FUNCTIONS, 'phone-utils.js'));
    // formatPhone (the US/Canada E.164 rule) joined it 2026-10-15, shared by
    // the OTP sender and submitPublicLead.
    assert('exports phoneDigits10', /module\.exports\s*=\s*\{\s*phoneDigits10\s*(,\s*formatPhone\s*)?\}/.test(src));
    assert('stays firebase-free (requirable from scripts + tests with zero deps)',
      !/require\(['"]firebase/.test(src));
    assert('helper body IS the canonical transform (guards drift vs inlined copies)',
      CANON_INLINE.test(src));
  }

  // ── 3. Read side: incomingSMS matches by phoneDigits ───────
  section('incomingSMS — matches leads by phoneDigits');
  {
    const sms = read(path.join(FUNCTIONS, 'sms-functions.js'));
    assert('imports phoneDigits10 from phone-utils',
      /require\(['"]\.\/phone-utils['"]\)/.test(sms) && /phoneDigits10/.test(sms));
    assert('normalizes the Twilio sender via phoneDigits10(fromPhone)',
      /phoneDigits10\(fromPhone\)/.test(sms));
    assert('queries leads by phoneDigits',
      /where\(\s*['"]phoneDigits['"]\s*,\s*['"]==['"]\s*,\s*fromDigits\s*\)/.test(sms));
    assert('keeps an exact-phone fallback for not-yet-backfilled leads',
      /where\(\s*['"]phone['"]\s*,\s*['"]==['"]\s*,\s*fromPhone\s*\)/.test(sms));
  }

  // ── 3b. Tenant-safe routing (audit 2026-08-02 HIGH-5) ──────
  // One shared Twilio number serves every tenant: the match must gather ALL
  // candidates and route via the pure decision module — never first-doc-wins.
  section('incomingSMS — tenant-safe routing');
  {
    const sms = read(path.join(FUNCTIONS, 'sms-functions.js'));
    assert('requires the pure route-logic module (shared decision path, no drift)',
      /require\(['"]\.\/inbound-sms-route-logic['"]\)/.test(sms) && /pickLeadForInbound\(/.test(sms));
    assert('lead match is NOT limit(1) — gathers a bounded candidate set',
      !/where\(\s*['"]phoneDigits['"][^)]*\)\.limit\(1\)/.test(sms) &&
      /MATCH_LIMIT/.test(sms));
    assert('cross-tenant ambiguity is flagged on the unmatched_sms row',
      /candidateCompanyIds/.test(sms) && /['"]cross-tenant/.test(read(path.join(FUNCTIONS, 'inbound-sms-route-logic.js'))));
    assert('received sms_log rows stamp the lead uid + companyId (Comm Log contract)',
      /logSMSToFirestore\(\s*\n?\s*db,\s*fromPhone,\s*messageBody,\s*\n?\s*lead\s*\?\s*\(lead\.userId/.test(sms));
    // The pure module owns the decision table; its own unit tests cover it.
    const logic = read(path.join(FUNCTIONS, 'inbound-sms-route-logic.js'));
    assert('route-logic stays firebase-free (requirable from tests with zero deps)',
      !/require\(['"]firebase/.test(logic));
  }

  // ── 4. Write side: every lead-create path stamps phoneDigits ─
  section('lead-write paths stamp phoneDigits');
  {
    // Server (Node) — use the shared helper.
    const bridge = read(path.join(FUNCTIONS, 'lead-bridge-logic.js'));
    assert('lead-bridge-logic requires phone-utils + stamps phoneDigits',
      /require\(['"]\.\/phone-utils['"]\)/.test(bridge) &&
      /phoneDigits:\s*phoneDigits10\(/.test(bridge));

    const referrals = read(path.join(FUNCTIONS, 'referrals.js'));
    assert('referrals requires phone-utils + stamps phoneDigits',
      /require\(['"]\.\/phone-utils['"]\)/.test(referrals) &&
      /phoneDigits:\s*phoneDigits10\(/.test(referrals));

    const seedDemo = read(path.join(FUNCTIONS, 'seed-demo.js'));
    assert('server seed-demo requires phone-utils + stamps phoneDigits',
      /require\(['"]\.\/phone-utils['"]\)/.test(seedDemo) &&
      /phoneDigits:\s*phoneDigits10\(/.test(seedDemo));

    // Client (browser) — inline the identical transform (can't require Node).
    const dash = read(path.join(PRO_JS, 'dashboard-bootstrap.module.js'));
    assert('dashboard _saveLead stamps data.phoneDigits (canonical inline)',
      /data\.phoneDigits\s*=\s*String\(data\.phone[\s\S]{0,40}/.test(dash) && CANON_INLINE.test(dash));
    // The dashboard's Load Sample Data button runs dashboard-actions.js
    // loadSampleData, which seeds through demo.js seedDemoLeads (pinned just
    // below). The bootstrap module's own seeder was a shadowed, never-live
    // twin, deleted 2026-09-22; this pin used to guard ITS stamp. It now
    // guards the live path's routing into the stamped seeder, and that no
    // unstamped lead seeder reappears in the module.
    const dashActionsPd = read(path.join(PRO_JS, 'dashboard-actions.js'));
    const lsdAtPd = dashActionsPd.search(/^async function loadSampleData\(\)/m);
    const lsdBodyPd = lsdAtPd >= 0 ? dashActionsPd.slice(lsdAtPd, dashActionsPd.indexOf('\n}', lsdAtPd)) : '';
    assert('dashboard loadSampleData seeds via demo.js seedDemoLeads (the phoneDigits-stamping seeder)',
      /await seedDemoLeads\(/.test(lsdBodyPd));
    assert('dashboard-bootstrap.module.js carries no separate loadSampleData seeder',
      !/\bfunction loadSampleData\b/.test(dash));
    const dashHtmlPd = read(path.join(PRO_JS, '..', 'dashboard.html'));
    assert('dashboard.html loads demo.js (seedDemoLeads is only defined there)',
      /<script[^>]+src="js\/demo\.js(?:\?v=\d+)?"/.test(dashHtmlPd));

    const demo = read(path.join(PRO_JS, 'demo.js'));
    assert('demo seeder stamps phoneDigits (canonical inline)',
      /phoneDigits:\s*String\(rest\.phone/.test(demo) && CANON_INLINE.test(demo));

    const d2d = read(path.join(PRO_JS, 'd2d-tracker-core-2026b.js'));
    assert('d2d convertToLead stamps phoneDigits (canonical inline)',
      /phoneDigits:\s*String\(knock\.phone/.test(d2d) && CANON_INLINE.test(d2d));

    // Paths added/covered by the 2026-07-06 drift audit (88 PRs after the
    // original stamp list). Each was a CONFIRMED prod gap: leads written or
    // phone-edited here carried no (or a stale) phoneDigits key.
    const imp = read(path.join(PRO_JS, 'data-import.js'));
    assert('CSV lead import stamps phoneDigits (canonical inline)',
      /phoneDigits:\s*String\(lead\.phone/.test(imp) && CANON_INLINE.test(imp));

    const editModal = read(path.join(PRO_JS, 'customer-edit-modal.js'));
    assert('customer edit modal refreshes phoneDigits on phone edit',
      /updates\.phoneDigits\s*=\s*String\(updates\.phone/.test(editModal) && CANON_INLINE.test(editModal));

    const preflight = read(path.join(PRO_JS, 'doc-preflight.js'));
    assert('DocPreflight refreshes phoneDigits when persisting phone',
      /updates\.phoneDigits\s*=\s*String\(updates\.phone/.test(preflight) && CANON_INLINE.test(preflight));

    const seedEmu = read(path.join(ROOT, 'scripts/seed-emulator.js'));
    assert('emulator seed stamps phoneDigits (QA rig exercises the real match path)',
      /phoneDigits:\s*String\(/.test(seedEmu) && CANON_INLINE.test(seedEmu));
  }

  // ── 5. Backfill script exists + reuses the shared helper ───
  section('backfill — leads.phoneDigits one-off');
  {
    const fs = require('fs');
    const p = path.join(ROOT, 'scripts/backfill-leads-phoneDigits.js');
    assert('scripts/backfill-leads-phoneDigits.js exists', fs.existsSync(p));
    if (fs.existsSync(p)) {
      const bf = read(p);
      assert('backfill imports the shared phoneDigits10 (no drift vs runtime)',
        /require\(['"]\.\.\/functions\/phone-utils['"]\)/.test(bf) && /phoneDigits10\(/.test(bf));
      assert('backfill is dry-run-by-default + --apply needs --yes',
        /APPLY && !YES/.test(bf) && /--apply --yes/.test(bf));
      assert('backfill is idempotent (skips already-correct docs)',
        /data\.phoneDigits === computed/.test(bf));
    }
  }
};
