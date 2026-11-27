/**
 * tests/storm-check-intake-grant-2026-11-17.test.js — the live-path assumption
 * behind the /storm-check "Add details" step: a storm-check lead is posted as
 * kind "inspect", so it lands in inspect_leads, the gateway mints the
 * one-time grant for wantsFollowUp, and updatePublicLeadIntake accepts the
 * answers the result screen sends (bestTime, insuranceClaim, howHeard, email)
 * onto the same lead and its bridged CRM card.
 *
 * Fake Firestore (no emulator needed); the same modules the deployed
 * functions run. Zero deps. Run: node tests/storm-check-intake-grant-2026-11-17.test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const GW = require(path.join(ROOT, 'functions', 'handlers', 'integrations.js'));
const PLP = require(path.join(ROOT, 'functions', 'public-lead-photos.js'))._internal;
const B = require(path.join(ROOT, 'functions', 'lead-bridge-logic.js'));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + JSON.stringify(detail) : '')); }
}

function fakeDb() {
  const store = new Map();
  const apply = (prev, patch) => { const out = Object.assign({}, prev || {}); for (const [k, v] of Object.entries(patch)) { if (v && typeof v === 'object' && 'operand' in v) out[k] = (out[k] || 0) + v.operand; else out[k] = v; } return out; };
  const ref = (c, id) => { const key = c + '/' + id; return {
    get: async () => ({ exists: store.has(key), data: () => store.get(key) }),
    set: async (d, o) => { store.set(key, o && o.merge ? apply(store.get(key), d) : apply({}, d)); },
    update: async (d) => { if (!store.has(key)) throw new Error('NOT_FOUND'); store.set(key, apply(store.get(key), d)); },
  }; };
  return { store, collection: (c) => ({ doc: (id) => ref(c, id) }), runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, d) => r.update(d) }) };
}

(async () => {
  const spec = GW._publicLeadSpec;
  const kind = spec.PUBLIC_LEAD_KINDS.inspect;

  // What the contact step posts (roof-check.js since 2026-11-25; storm-check.js
  // before): name, phone, address, source, story, tcpaConsent, the scheduling
  // choice and wantsFollowUp; an email only when one was typed (optional).
  const posted = { name: 'Pat', phone: '(859) 555-0100', address: '12 Elm St, Goshen OH', source: '/roof-check', story: 'ROOF CHECK | storm records unavailable | roof age: 10-15 (asphalt) | signs: none', tcpaConsent: false, scheduling: 'contact_me', wantsFollowUp: true };
  ok('storm-check posts kind "inspect": a service kind that stores in inspect_leads', spec.SERVICE_KINDS.includes('inspect') && kind.collection === 'inspect_leads');
  ok('...and the step-5 payload carries every required field of that kind', kind.required.every((k) => posted[k]), kind.required);

  const db = fakeDb();
  const token = await PLP.mintPhotoGrant(db, { collection: kind.collection, publicId: 'sc-1', companyId: null });
  ok('wantsFollowUp is enough for a grant: mintPhotoGrant stores one for inspect_leads', /^[a-f0-9]{48}$/.test(token) && db.store.get(PLP.GRANTS + '/' + PLP.hashToken(token)).collection === 'inspect_leads');

  const crmKey = 'leads/' + B.bridgeDocId('inspect_leads', 'sc-1');
  db.store.set('inspect_leads/sc-1', { name: 'Pat', phone: '8595550100', source: '/roof-check' });
  db.store.set(crmKey, { notes: '', email: '', phoneDigits: '8595550100' });

  // The body the result screen sends (storm-check.js saveDetails).
  const out = await PLP.saveIntakeUpdate(db, { token, bestTime: 'Evening', insuranceClaim: 'not_sure', howHeard: 'Google search', email: 'pat@example.com' });
  const pub = db.store.get('inspect_leads/sc-1');
  const crm = db.store.get(crmKey);
  ok('updatePublicLeadIntake accepts the storm-check follow-up (200, CRM card updated)', out.status === 200 && out.json.crm === true, out);
  ok('...answers land on the same public lead', pub.bestTime === 'Evening' && pub.insuranceClaim === 'not_sure' && pub.howHeard === 'Google search' && pub.email === 'pat@example.com' && pub.source === '/roof-check');
  ok('...and the CRM card gets the email and the note lines', crm.email === 'pat@example.com' && /Email: pat@example\.com/.test(crm.notes) && crm.phoneDigits === '8595550100');
  ok('...using one of the grant\'s saves', db.store.get(PLP.GRANTS + '/' + PLP.hashToken(token)).intakeUpdates === 1);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
