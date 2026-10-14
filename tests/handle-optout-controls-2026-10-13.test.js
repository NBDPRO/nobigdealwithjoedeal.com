/**
 * tests/handle-optout-controls-2026-10-13.test.js
 *
 * The three clear bugs the 2026-10-13 handle / opt-out controls audit
 * (documentation/audit/HANDLE-AND-OPTOUT-CONTROLS-2026-10-13.md) fixed. Each is
 * a control that promised one thing and did another:
 *
 *   A. "Don't ask this one" (review deck, writes lead.reviewAskDeclined) was
 *      honoured by the client engine and the deck, but NOT by the server
 *      review nudge: the 08:15 email, the bell and the morning-brief line kept
 *      naming a customer Jo had declined. reviewAskDue() is the one shared
 *      pure rule, so it is fixed there.
 *   B. Snoozing a lead did not stop leadFollowUpSweep: a card still at
 *      stage new / status new got "we haven't managed to connect" emailed to
 *      the HOMEOWNER at 20-48h even though Jo had snoozed it on purpose.
 *   C. The STOP classifier missed a full-width "STOP", spaced letters
 *      "S T O P", "do not call or text me" and "delete my number" - each fell
 *      through to the AI draft step. Conservative additions only; the pinned
 *      "wrong number" -> not-an-opt-out decision is untouched.
 *
 * Every assertion is paired with a positive control (the same input minus the
 * trigger still does the old thing), so a vacuous guard shows up red.
 *
 * Needs functions/node_modules (junctioned in a worktree).
 * Run: node tests/handle-optout-controls-2026-10-13.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

let stubs = {};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};
function fresh(file) {
  const p = require.resolve(path.join(FN, file));
  delete require.cache[p];
  return require(p);
}

(async () => {
  // ═══ A. reviewAskDeclined reaches the server review nudge ═══════════════
  console.log('A. "Don\'t ask this one" is honoured by the server review nudge');
  {
    stubs = {};
    const RN = fresh('review-request-nudge.js')._test;
    const DAY = 86400000;
    const now = Date.parse('2026-10-13T15:00:00Z');
    const wonMs = now - 10 * DAY;
    const lead = { phone: '5135550101', email: 'a@example.test' };
    ok('control: a customer paid 10 days ago is due', RN.reviewAskDue(lead, null, null, wonMs, now) === true);
    ok('declined customer (no jobs) is NOT due', RN.reviewAskDue(Object.assign({}, lead, { reviewAskDeclined: true }), null, null, wonMs, now) === false);
    ok('control: a multi-job customer is due', RN.reviewAskDue(lead, {}, 'j2', wonMs, now) === true);
    ok('declined multi-job customer is NOT due', RN.reviewAskDue(Object.assign({}, lead, { reviewAskDeclined: true }), {}, 'j2', wonMs, now) === false);
    ok('a falsy flag does not decline', RN.reviewAskDue(Object.assign({}, lead, { reviewAskDeclined: false }), null, null, wonMs, now) === true);
  }

  // ═══ B. a snoozed lead is not emailed "we haven't connected" ════════════
  console.log('\nB. leadFollowUpSweep skips a deliberately snoozed lead');
  function world(card) {
    const docs = {};
    const sends = [];
    const now = Date.now();
    docs['estimate_leads/p1'] = { email: 'homeowner@example.test', firstName: 'Pat', createdAt: { toMillis: () => now - 30 * 3600e3 } };
    const ref = (p) => ({
      id: p.split('/').pop(),
      async get() { return { exists: !!docs[p], data: () => docs[p] }; },
      async update(d) { docs[p] = Object.assign({}, docs[p] || {}, d); },
    });
    const coll = (name) => {
      const q = {
        where: () => q, limit: () => q,
        async get() {
          let rows;
          if (name === 'leads') rows = [{ id: 'crm-1', data: () => Object.assign({ stage: 'new', status: 'new' }, card) }];
          else rows = Object.keys(docs).filter((k) => k.startsWith(name + '/'))
            .map((k) => ({ id: k.split('/')[1], data: () => Object.assign({}, docs[k]), ref: ref(k) }));
          return { empty: rows.length === 0, docs: rows, size: rows.length };
        },
        doc: (id) => ref(name + '/' + id),
      };
      return q;
    };
    const db = { collection: coll, doc: ref };
    const logger = { error() {}, warn() {}, info() {}, debug() {} };
    stubs = {
      'firebase-admin/firestore': {
        getFirestore: () => db,
        FieldValue: { serverTimestamp: () => '__ts__' },
        Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
      },
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'k-' + n }) },
      'firebase-functions/v2': { logger },
      './integrations/heartbeat': { onSchedule: (o, h) => ({ __handler: h }) },
      './lead-bridge-logic': { isFollowUpEvent: () => false },
      './email-suppression': {
        READ_TIMEOUT_MS: 1000,
        gateCommercialEmail: async () => ({ suppressed: false, headers: {}, tags: [] }),
        applyFooter: (u, html, text) => ({ html, text }),
      },
      resend: { Resend: function () { this.emails = { send: async (m) => { sends.push(m); return { data: { id: 're_' + sends.length }, error: null }; } }; } },
    };
    delete process.env.LEAD_FOLLOWUP_ENABLED;
    return { mod: fresh('lead-followup.js'), sends };
  }
  {
    const w = world({});
    await w.mod.leadFollowUpSweep.__handler({});
    ok('control: an untouched, never-snoozed card is emailed', w.sends.length === 1, w.sends.length);
  }
  {
    const w = world({ snoozedUntil: new Date(Date.now() + 3 * 86400000), snoozeCount: 1 });
    await w.mod.leadFollowUpSweep.__handler({});
    ok('a card snoozed into the future is NOT emailed', w.sends.length === 0, w.sends.length);
  }
  {
    // Snooze expired in the last day: a human still triaged it. One snooze is
    // a decision; the apology email would be wrong either way.
    const w = world({ snoozedUntil: new Date(Date.now() - 3600e3), snoozeCount: 1 });
    await w.mod.leadFollowUpSweep.__handler({});
    ok('a card whose snooze just expired (snoozeCount>0) is NOT emailed', w.sends.length === 0, w.sends.length);
  }
  {
    // Deliberate: unsnooze nulls snoozedUntil but never resets snoozeCount
    // (lead-snooze.js:162), so a card Jo snoozed once and woke is never sent
    // the apology email. Fails closed; pinned so it is a decision, not drift.
    const w = world({ snoozedUntil: null, snoozeCount: 1 });
    await w.mod.leadFollowUpSweep.__handler({});
    ok('a woken card (snoozedUntil null, snoozeCount 1) stays skipped', w.sends.length === 0, w.sends.length);
  }
  {
    const w = world({ snoozedUntil: null, snoozeCount: 0 });
    await w.mod.leadFollowUpSweep.__handler({});
    ok('control: snoozeCount 0 and no snooze is emailed', w.sends.length === 1, w.sends.length);
  }
  {
    const w = world({ snoozedUntil: { toMillis: () => Date.now() + 86400000 }, snoozeCount: 1 });
    await w.mod.leadFollowUpSweep.__handler({});
    ok('a Timestamp-shaped snoozedUntil is read too', w.sends.length === 0, w.sends.length);
  }

  // ═══ C. STOP classifier ═════════════════════════════════════════════════
  console.log('\nC. STOP classifier: full-width, spaced letters, call-or-text, delete my number');
  stubs = {};
  const S = fresh('sms-stop-intent.js');
  const cls = (m) => S.classifyInbound(m).intent;
  const MUST_STOP = [
    'ＳＴＯＰ',                 // full-width STOP
    'S T O P', 's.t.o.p',
    'Do not call or text me', "don't call or text me again", 'dont text or call me', 'Never call or text this number',
    'Stop calling and texting me',
    'Delete my number', 'please delete this number', 'Delete my number from your list please.',
    'Please do not call or text me anymore', "don't call or text me again.",
  ];
  for (const m of MUST_STOP) ok('opt-out: ' + JSON.stringify(m), cls(m) === 'stop', cls(m));
  const MUST_NOT = [
    'Can you call or text me when you are close?', 'You can call or text me anytime', 'call me tomorrow',
    'text me when you are close', 'Please stop by Tuesday', 'delete the old estimate', 'S T O P by after 5', 'T O P',
    'wrong number', 'a b c', 'yes',
    // A contact-hours or who-to-call limit names both channels but is a
    // customer talking, not a revocation (silent-failure review, same day).
    "Please don't call or text before 10am, I work nights", "Don't call or text during work, email me",
    "Don't call or text my husband, use my number", 'do not call or text me after 6pm',
    'delete my number 555-1234 and use 555-9999', 'delete me from the group text', 'delete this number from the estimate and call my wife',
  ];
  for (const m of MUST_NOT) ok('NOT an opt-out: ' + JSON.stringify(m), cls(m) !== 'stop', cls(m));
  ok('control: plain STOP still stops', cls('STOP') === 'stop' && cls('Stop texting me') === 'stop');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
