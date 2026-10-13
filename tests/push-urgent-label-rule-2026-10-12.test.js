#!/usr/bin/env node
/**
 * pushUrgent follows the label rule (labels lane, 2026-10-12). The immediate
 * urgent push in functions/call-center.js must agree with callWatch and Home:
 *   - a hidden PERSONAL number's urgent call breaks through, tagged;
 *   - a hidden SPAM number's "urgent" does NOT (robocalls claim urgent);
 *   - a quiet number needs a promise / due callback, not "urgent";
 *   - no label / unreadable label -> pushes (the safe direction).
 * Source-extracted and run against the real call-watch-logic.
 * Run: node tests/push-urgent-label-rule-2026-10-12.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const src = fs.readFileSync(path.join(ROOT, 'functions/call-center.js'), 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('async function labelFor');
const b = src.indexOf('async function pushUrgent');
const c = src.indexOf('\n}\n', b) + 3;

function make(labelDoc, opts) {
  const o = opts || {};
  const pushes = [], stamped = [], warns = [];
  const db = {
    collection: (col) => ({
      doc: (id) => ({
        collection: (sub) => ({
          doc: (dg) => ({ get: async () => { if (o.labelThrows) throw new Error('unavailable'); return labelDoc ? { exists: true, data: () => labelDoc } : { exists: false }; } }),
        }),
        set: async (v) => { stamped.push(v); },
      }),
      add: async () => {},
    }),
  };
  const sandbox = {
    process: { env: { CALL_WATCH_ENABLED: 'true' } },
    require: (m) => { if (m === './call-watch-logic') return require(path.join(ROOT, 'functions/call-watch-logic.js')); throw new Error('unexpected require ' + m); },
    L: { urgentPushText: () => ({ title: 'Urgent call — Maria', body: 'Water through the ceiling' }) },
    OWNER: 'owner1', COLLECTION: 'phone_calls', FieldValue: { serverTimestamp: () => 'TS' },
    logger: { warn: (...x) => warns.push(x), info() {} }, Promise, Object, String, Number,
  };
  vm.createContext(sandbox);
  vm.runInContext(src.slice(a, c) + '\nglobalThis.pushUrgent = pushUrgent;', sandbox);
  const d = { push: async (...x) => { pushes.push(x); return { sent: 1 }; } };
  return { sandbox, db, d, pushes, stamped, warns };
}
const NOON = Date.parse('2026-10-01T16:00:00Z');
const call = { id: 'cube_u1', phoneDigits: '8595550177', startedAtMs: NOON - 60000, leadId: null };

(async () => {
  let m = make(null);
  let r = await m.sandbox.pushUrgent({ db: m.db, d: m.d, call, notes: { urgent: true, callType: 'lead', promises: [] }, leadName: '', nowMs: NOON });
  ok('no label: pushes, untagged', r === true && m.pushes.length === 1 && !/hidden number/.test(m.pushes[0][2]));

  m = make({ kind: 'personal', policy: 'hide' });
  r = await m.sandbox.pushUrgent({ db: m.db, d: m.d, call, notes: { urgent: true, callType: 'other', promises: [] }, leadName: '', nowMs: NOON });
  ok('hidden PERSONAL number: urgent breaks through, tagged "Personal · hidden number"', r === true && m.pushes.length === 1 && /Personal · hidden number/.test(m.pushes[0][2]), JSON.stringify(m.pushes));

  m = make({ kind: 'spam', policy: 'hide' });
  r = await m.sandbox.pushUrgent({ db: m.db, d: m.d, call, notes: { urgent: true, callType: 'lead', promises: [] }, leadName: '', nowMs: NOON });
  ok('hidden SPAM number: urgent does NOT push and is not stamped', r === false && m.pushes.length === 0 && m.stamped.length === 0);

  m = make({ kind: 'spam', policy: 'hide' });
  r = await m.sandbox.pushUrgent({ db: m.db, d: m.d, call, notes: { urgent: true, callType: 'lead', promises: [{ who: 'jo', text: 'call back' }] }, leadName: '', nowMs: NOON });
  ok('...a promise from Jo on that number still surfaces (callWatch tells it as a promise, not as urgent)', r === false && m.pushes.length === 0);

  m = make({ kind: 'sub', policy: 'quiet' });
  r = await m.sandbox.pushUrgent({ db: m.db, d: m.d, call, notes: { urgent: true, callType: 'sub', promises: [] }, leadName: '', nowMs: NOON });
  ok('quiet number: "urgent" alone does not push immediately', r === false && m.pushes.length === 0);

  m = make({ kind: 'personal', policy: 'hide' }, { labelThrows: true });
  r = await m.sandbox.pushUrgent({ db: m.db, d: m.d, call, notes: { urgent: true, callType: 'lead', promises: [] }, leadName: '', nowMs: NOON });
  // (the fake has no where(): the person-card sibling read also fails and says so, hence the filter)
  ok('label read fails -> no labels -> pushes (the safe direction) and says why', r === true && m.pushes.length === 1 && m.warns.filter((w) => /label_read_failed/.test(String(w[0]))).length === 1);

  // QA 2026-10-13: labelFor stripped a literal capital "D" (/D/g) instead of non-digits (/\D/g).
  // The fake below answers ONLY for the exact 10-digit doc id, so a mangled id finds no label and
  // a hidden SPAM number's "urgent" would push (fail-open). Positive control: a different number.
  {
    const keyed = (labelDoc, wantId) => {
      const m = make(labelDoc);
      m.db.collection = () => ({ doc: () => ({ collection: () => ({ doc: (dg) => ({ get: async () => (dg === wantId ? { exists: true, data: () => labelDoc } : { exists: false }) }) }), set: async () => {} }), add: async () => {} });
      return m;
    };
    const fmt = Object.assign({}, call, { phoneDigits: '+1 (859) 555-0177' });
    let k = keyed({ kind: 'spam', policy: 'hide' }, '8595550177');
    let rr = await k.sandbox.pushUrgent({ db: k.db, d: k.d, call: fmt, notes: { urgent: true, callType: 'lead', promises: [] }, leadName: '', nowMs: NOON });
    ok('a formatted number still finds its SPAM label (id normalised with non-digit strip) -> no push', rr === false && k.pushes.length === 0);
    k = keyed({ kind: 'spam', policy: 'hide' }, '8595550177');
    rr = await k.sandbox.pushUrgent({ db: k.db, d: k.d, call: Object.assign({}, call, { phoneDigits: '5555550100' }), notes: { urgent: true, callType: 'lead', promises: [] }, leadName: '', nowMs: NOON });
    ok('control: a different number has no label -> pushes (the keyed fake really discriminates)', rr === true && k.pushes.length === 1);
  }

  ok('call-center.js reuses the shared rule (no private copy of it)', /W\.callNeedsYou\(row, nowMs, ctx\)/.test(src) && /W\.reasonFor\(row, nowMs, ctx\) !== 'urgent'/.test(src));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
