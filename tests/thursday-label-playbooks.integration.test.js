/**
 * tests/thursday-label-playbooks.integration.test.js — the REAL
 * thursdayCallerLookup handler (functions/integrations/thursday.js) with the
 * per-label playbooks (THURSDAY_LABEL_PLAYBOOKS_ENABLED), driven in-process
 * against the Firestore emulator.
 *
 *   documentation/projects/THURSDAY-LABEL-PLAYBOOKS-2026-10-12.md
 *
 * Proves:
 *   1. DARK: flag unset (or anything but 'true') returns the exact legacy
 *      three-key response, even with labels / handled / away docs present
 *      (positive control: the same docs light up the playbook with the flag on);
 *   2. each label kind → its playbook id; `other` and no label → unknown;
 *      a number with exactly one lead and no label → customer;
 *   3. thursday_handled/{digits} → handled:true;
 *   4. personal / spam never return a first name, even on a one-lead number;
 *   5. away wording: only the APPROVED text, only while the window is active,
 *      never with spam, dropped when it names the backup;
 *   6. tenant isolation: another company's label for the same digits is not read;
 *   7. a malformed label doc degrades to the unlabeled flow, never an error;
 *   8. a bad bearer is refused exactly as before.
 *
 * Run (CI job "Auth/Firestore emulator suites"):
 *   firebase emulators:exec --only firestore --project demo-nbd-thursday-pb 'node ./thursday-label-playbooks.integration.test.js'
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('x FIRESTORE_EMULATOR_HOST must be set (emulator only)');
  process.exit(1);
}
const PROJECT = process.env.THURSDAY_PB_TEST_PROJECT_ID || process.env.GCLOUD_PROJECT || 'demo-nbd-thursday-pb';
{
  const rc = JSON.parse(fs.readFileSync(path.join(ROOT, '.firebaserc'), 'utf8'));
  if (Object.values(rc.projects || {}).includes(PROJECT)) {
    console.error('x refusing to run against the app project "' + PROJECT + '"');
    process.exit(1);
  }
}
process.env.GCLOUD_PROJECT = PROJECT;
const TOKEN = 'lookup_test_' + Date.now().toString(36);
process.env.THURSDAY_LOOKUP_TOKEN = TOKEN;
delete process.env.THURSDAY_LABEL_PLAYBOOKS_ENABLED;

const freq = createRequire(path.join(ROOT, 'functions', 'package.json'));
freq('firebase-admin/app').initializeApp({ projectId: PROJECT });
const db = freq('firebase-admin/firestore').getFirestore();

const T = require(path.join(ROOT, 'functions/integrations/thursday-logic.js'));
const AWAY = require(path.join(ROOT, 'functions/away-mode-logic.js'));
const fns = require(path.join(ROOT, 'functions/integrations/thursday.js'));

const NBD = T.NBD_OWNER_UID;
const OTHER = 'otherTenantZZ00000000000001';

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// 555 fixtures only.
const N = (i) => '513555' + String(1000 + i);

async function lookup(from, opts) {
  const o = opts || {};
  const res = { code: 0, body: null, headers: {},
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; },
    end() { return this; }, set(k, v) { this.headers[k] = v; return this; } };
  const req = { method: 'POST', headers: { authorization: 'Bearer ' + (o.token || TOKEN) }, body: { from }, ip: '203.0.113.9' };
  await fns.thursdayCallerLookup(req, res);
  return res;
}
const label = (d, kind, extra) => db.doc('companies/' + NBD + '/contact_labels/' + d).set(Object.assign({
  digits: d, kind, policy: kind === 'personal' || kind === 'spam' ? 'hide' : kind === 'customer' ? 'surface' : 'quiet',
  companyId: NBD, updatedBy: NBD, updatedAtMs: 1, createdAtMs: 1, source: 'manual',
}, extra || {}));
const handled = (d) => db.doc('companies/' + NBD + '/thursday_handled/' + d).set({
  digits: d, companyId: NBD, updatedBy: NBD, updatedAtMs: 1, createdAtMs: 1,
});

async function main() {
  const LEGACY_KEYS = ['first_name', 'job_hint', 'known'];

  section('1. DARK: the flag is off');
  await label(N(1), 'sub');
  await handled(N(1));
  {
    const r = await lookup(N(1));
    ok('flag unset: 200 with exactly the legacy keys', r.code === 200 && Object.keys(r.body).sort().join() === LEGACY_KEYS.join(), JSON.stringify(r.body));
    ok('flag unset: no playbook fields leak', r.body.playbook === undefined && r.body.away_text === undefined && r.body.handled === undefined && r.body.label_kind === undefined);
    process.env.THURSDAY_LABEL_PLAYBOOKS_ENABLED = 'yes';
    const r2 = await lookup(N(1));
    ok('flag "yes" (not the literal true) is still dark', Object.keys(r2.body).sort().join() === LEGACY_KEYS.join());
    process.env.THURSDAY_LABEL_PLAYBOOKS_ENABLED = 'true';
    const r3 = await lookup(N(1));
    ok('control: flag "true" lights the same docs up (sub, handled)', r3.body.playbook === 'sub' && r3.body.label_kind === 'sub' && r3.body.handled === true, JSON.stringify(r3.body));
  }

  section('2. label kind -> playbook');
  const kinds = { customer: 'customer', prospect: 'prospect', contractor: 'sub', sub: 'sub', supplier: 'supplier', insurance: 'insurance', referral: 'referral', personal: 'personal', spam: 'spam', recruiter: 'recruiter', other: 'unknown' };
  let i = 10;
  for (const [kind, pb] of Object.entries(kinds)) {
    const d = N(i++);
    await label(d, kind);
    const r = await lookup(d);
    ok(kind + ' -> ' + pb, r.body.playbook === pb && r.body.label_kind === kind && r.body.handled === false, JSON.stringify(r.body));
  }
  {
    const r = await lookup(N(90));
    ok('no label, no lead -> unknown, no label kind', r.body.playbook === 'unknown' && r.body.label_kind === '' && r.body.known === false, JSON.stringify(r.body));
  }

  section('3. handled setting');
  {
    const d = N(30);
    const before = await lookup(d);
    await handled(d);
    const after = await lookup(d);
    ok('control: not handled before', before.body.handled === false);
    ok('handled after the doc exists', after.body.handled === true);
    await db.doc('companies/' + NBD + '/thursday_handled/' + d).delete();
    const gone = await lookup(d);
    ok('take-back (doc deleted) -> handled false again', gone.body.handled === false);
  }
  {
    const d = N(31);
    await label(d, 'spam'); await handled(d);
    const r = await lookup(d);
    ok('a spam number is never "handled" even with a stray setting doc', r.body.playbook === 'spam' && r.body.handled === false);
  }

  section('4. names: personal / spam get none');
  {
    // A lead owns this number: unlabeled -> greeted by first name (control).
    const d = N(40);
    await db.doc('leads/zzpb-lead-1').set({ companyId: NBD, userId: NBD, firstName: 'Pat', lastName: 'Example', phoneDigits: d, phone: d, stage: 'new' });
    const plain = await lookup(d);
    ok('control: one lead, no label -> known, "Pat", playbook customer', plain.body.known === true && plain.body.first_name === 'Pat' && plain.body.playbook === 'customer', JSON.stringify(plain.body));
    await label(d, 'personal');
    const p = await lookup(d);
    ok('personal label: no first name, not known, no job hint', p.body.known === false && p.body.first_name === '' && p.body.job_hint === '' && p.body.playbook === 'personal', JSON.stringify(p.body));
    await label(d, 'spam');
    const s = await lookup(d);
    ok('spam label: no first name', s.body.known === false && s.body.first_name === '' && s.body.playbook === 'spam');
    await label(d, 'customer');
    const c = await lookup(d);
    ok('control: customer label keeps the name', c.body.known === true && c.body.first_name === 'Pat');
  }

  section('5. away wording');
  {
    const TEXT = 'Thanks for calling No Big Deal. The owner is out of the office until Friday. I can take your name and number and he will call you back.';
    const now = Date.now();
    await db.doc('away_private/' + NBD).set({
      playbook: { approved: TEXT, approvedHash: AWAY.hashText(TEXT), approvedAtMs: now - 1000, approvedBy: NBD, approvedForUntilMs: now + 86400000 },
      backup: { memberEmail: 'sam.backup@example.com' },
    });
    await db.doc('away_mode/' + NBD).set({ away: { on: false }, backup: { name: 'Sam Backup' } });
    const d = N(50);
    await label(d, 'customer');
    const off = await lookup(d);
    ok('away OFF: no away text (control)', off.body.away_text === '');
    await db.doc('away_mode/' + NBD).set({ away: { on: true, startMs: now - 3600000, untilMs: now + 86400000 }, backup: { name: 'Sam Backup' } });
    const on = await lookup(d);
    ok('away ON + approved: the approved text, word for word', on.body.away_text === TEXT, JSON.stringify(on.body));
    await label(d, 'spam');
    const sp = await lookup(d);
    ok('spam never gets the away text', sp.body.away_text === '' && sp.body.playbook === 'spam');
    await label(d, 'personal');
    const pe = await lookup(d);
    ok('personal still gets the away text (and no name)', pe.body.away_text === TEXT && pe.body.first_name === '');
    ok('no backup detail anywhere in the response (name, email)', !/Sam|Backup|backup|@/.test(JSON.stringify(pe.body)), JSON.stringify(pe.body));
    // Edited after approval: hash no longer matches -> nothing spoken.
    await db.doc('away_private/' + NBD).set({
      playbook: { approved: TEXT + ' Edited.', approvedHash: AWAY.hashText(TEXT), approvedAtMs: now - 1000, approvedBy: NBD, approvedForUntilMs: now + 86400000 },
      backup: { memberEmail: 'sam.backup@example.com' },
    });
    const ed = await lookup(d);
    ok('text edited after approval -> not spoken', ed.body.away_text === '');
    // Approved text that names the backup -> dropped (defense in depth).
    const LEAKY = 'The owner is away. Sam Backup is covering and will call you back.';
    await db.doc('away_private/' + NBD).set({
      playbook: { approved: LEAKY, approvedHash: AWAY.hashText(LEAKY), approvedAtMs: now - 1000, approvedBy: NBD, approvedForUntilMs: now + 86400000 },
      backup: { memberEmail: 'sam.backup@example.com' },
    });
    const lk = await lookup(d);
    ok('approved text that names the backup is dropped', lk.body.away_text === '', JSON.stringify(lk.body));
    // Approved for a different end time -> not spoken (per-trip approval).
    await db.doc('away_private/' + NBD).set({
      playbook: { approved: TEXT, approvedHash: AWAY.hashText(TEXT), approvedAtMs: now - 1000, approvedBy: NBD, approvedForUntilMs: now + 5 * 86400000 },
    });
    const tr = await lookup(d);
    ok('approval for a different trip end -> not spoken', tr.body.away_text === '');
    await db.doc('away_private/' + NBD).delete();
    await db.doc('away_mode/' + NBD).delete();
  }

  section('6. tenant isolation');
  {
    const d = N(60);
    await db.doc('companies/' + OTHER + '/contact_labels/' + d).set({
      digits: d, kind: 'insurance', policy: 'surface', companyId: OTHER, updatedBy: OTHER, updatedAtMs: 1, createdAtMs: 1,
    });
    await db.doc('companies/' + OTHER + '/thursday_handled/' + d).set({ digits: d, companyId: OTHER, updatedBy: OTHER, updatedAtMs: 1, createdAtMs: 1 });
    const r = await lookup(d);
    ok('another tenant\'s label / handled doc for the same digits is not read', r.body.playbook === 'unknown' && r.body.label_kind === '' && r.body.handled === false, JSON.stringify(r.body));
    await label(d, 'insurance');
    const mine = await lookup(d);
    ok('control: our own label for the same digits is', mine.body.playbook === 'insurance');
  }

  section('7. garbage in the label doc');
  {
    const d = N(70);
    await db.doc('companies/' + NBD + '/contact_labels/' + d).set({ digits: d, kind: { x: 1 }, policy: 7 });
    const r = await lookup(d);
    ok('malformed label -> unlabeled flow, 200', r.code === 200 && r.body.playbook === 'unknown');
    await db.doc('companies/' + NBD + '/contact_labels/' + N(71)).set({ digits: N(71), kind: 'billionaire', policy: 'surface' });
    const r2 = await lookup(N(71));
    ok('unknown kind string -> unlabeled flow', r2.code === 200 && r2.body.playbook === 'unknown' && r2.body.label_kind === '');
  }

  section('7b. a slow playbook read never costs the caller their greeting (security review S1)');
  {
    const d = N(80);
    await db.doc('leads/zzpb-lead-2').set({ companyId: NBD, userId: NBD, firstName: 'Lee', lastName: 'Example', phoneDigits: d, phone: d, stage: 'new' });
    await label(d, 'customer');
    const origDoc = db.doc.bind(db);
    db.doc = function (p) {
      const ref = origDoc(p);
      if (/contact_labels/.test(p)) {
        const g = ref.get.bind(ref);
        ref.get = () => new Promise((resolve) => setTimeout(() => resolve(g()), 6000));
      }
      return ref;
    };
    const t0 = Date.now();
    const slow = await lookup(d);
    const ms = Date.now() - t0;
    db.doc = origDoc;
    ok('the greeting survives a 6 s label read: still known, "Lee"', slow.code === 200 && slow.body.known === true && slow.body.first_name === 'Lee', JSON.stringify(slow.body));
    ok('...and the whole lookup stayed under 2 s (the snippet aborts at 2.5 s)', ms < 2000, String(ms) + ' ms');
    ok('...and it answered without a playbook (legacy shape)', slow.body.playbook === undefined);
    const fast = await lookup(d);
    ok('control: with the read un-stubbed the same number gets its playbook', fast.body.playbook === 'customer' && fast.body.first_name === 'Lee');
  }

  section('8. auth + input unchanged');
  {
    const bad = await lookup(N(1), { token: 'nope' });
    ok('bad bearer -> 401', bad.code === 401);
    const short = await lookup('5135');
    ok('short number -> the legacy unknown body, no playbook', short.code === 200 && Object.keys(short.body).sort().join() === LEGACY_KEYS.join());
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join('; ')); process.exit(1); }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
