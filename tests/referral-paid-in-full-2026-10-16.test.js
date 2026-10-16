/**
 * tests/referral-paid-in-full-2026-10-16.test.js — the $100 referral bonus is
 * credited only when the referred customer's job is PAID IN FULL.
 *
 * WHY: Joe (2026-10-16): referral credit timing = "after paid in full". Until
 * now functions/referral-rewards.js credited the bonus at ANY won stage
 * (Install Done, Final Photos, Deductible, Collections...), i.e. before the
 * customer had paid. The rule is now the one the automatic review ask uses:
 * paid-in-full.js isPaidInFull (a won stage at or after Final Payment, a
 * tenant's custom won stage included, and no invoice still owing) plus a
 * payment RECEIVED with a date (review-ask-auto-logic.js receivedMs).
 *
 *   1. RULE      paidForReferral, pure: which stage + invoice states credit
 *   2. ACTIVE    the lead path waits for the money; a job whose last invoice
 *                is paid after its stage moved is credited when the job flips
 *                paidInFull (onReferralJobWrite), once
 *   3. LEGACY    a lead with no jobs waits the same way
 *   4. KEPT      a bonus already owed or paid is never redone or reversed
 *   5. WORDING   the customer and rep copy says "paid in full", not "closes"
 *
 * Run: node tests/referral-paid-in-full-2026-10-16.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const FieldValue = {
  serverTimestamp: () => ({ __ts: true }),
  increment: (n) => ({ __inc: n }),
  arrayUnion: (...v) => ({ __union: v }),
};
let CURRENT_DB = null;
const stubs = {
  'firebase-functions/v2/firestore': { onDocumentWritten: (o, fn) => { fn.__opts = o; return fn; } },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
  'firebase-admin/firestore': { getFirestore: () => CURRENT_DB, FieldValue },
};
const origLoad = Module._load;
Module._load = function (req) { return stubs[req] || origLoad.apply(this, arguments); };
const R = require(path.join(ROOT, 'functions', 'referral-rewards.js'));
Module._load = origLoad;
const I = R._internal;

// A tiny Firestore: docs by path, a transaction, invoices where(leadId ==).
function makeDb() {
  const store = new Map();
  const notes = [];
  const apply = (doc, patch) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v && v.__inc !== undefined) doc[k] = (Number(doc[k]) || 0) + v.__inc;
      else if (v && v.__union) doc[k] = (doc[k] || []).concat(v.__union);
      else doc[k] = JSON.parse(JSON.stringify(v));
    }
  };
  function ref(p) {
    return {
      path: p,
      async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), ref: ref(p), data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))) }; },
      async set(d, o) { const cur = o && o.merge ? (store.get(p) || {}) : {}; apply(cur, d); store.set(p, cur); },
      async update(patch) { if (!store.has(p)) throw new Error('no doc ' + p); apply(store.get(p), patch); },
      collection: (c) => col(p + '/' + c),
    };
  }
  function col(c) {
    return {
      doc: (id) => ref(c + '/' + id),
      async add(d) { notes.push(d); return { id: 'n' + notes.length }; },
      where: (field, op, val) => ({ async get() {
        const docs = [...store.entries()].filter(([k, d]) => k.startsWith(c + '/') && k.split('/').length === 2 && d && d[field] === val)
          .map(([k, d]) => ({ id: k.split('/')[1], data: () => JSON.parse(JSON.stringify(d)) }));
        return { docs };
      } }),
    };
  }
  return {
    store, notes,
    collection: (c) => (c === 'notifications' ? { async add(d) { notes.push(d); return {}; } } : col(c)),
    doc: (p) => ref(p),
    async runTransaction(fn) {
      const writes = [];
      const r = await fn({ get: (x) => x.get(), update: (x, p) => writes.push([x, p]) });
      for (const [x, p] of writes) await x.update(p);
      return r;
    },
  };
}
const DAY = 86400000;
const PAID = (jobId) => ({ leadId: 'L1', userId: 'u1', companyId: 'c1', jobId, status: 'paid', total: 12000, paidAt: new Date(Date.now() - DAY).toISOString() });
const OWING = (jobId) => ({ leadId: 'L1', userId: 'u1', companyId: 'c1', jobId, status: 'sent', total: 6000, balanceDue: 6000 });
const referred = (extra) => Object.assign({ userId: 'u1', companyId: 'c1', firstName: 'ZZ_QA', lastName: 'Referred', referralRewardStatus: 'pending', referralDocId: 'R1', referredByName: 'Pat Referrer' }, extra);
function seed(db, lead, jobs, invoices) {
  db.store.set('leads/L1', JSON.parse(JSON.stringify(lead)));
  db.store.set('referrals/R1', { userId: 'u1', companyId: 'c1', code: 'PAT-AB12', rewardsOwedTotal: 0 });
  for (const [id, j] of Object.entries(jobs || {})) db.store.set('leads/L1/jobs/' + id, j);
  for (const [id, inv] of Object.entries(invoices || {})) db.store.set('invoices/' + id, inv);
}
const lead = (db) => db.store.get('leads/L1');
const job = (db, id) => db.store.get('leads/L1/jobs/' + id);
const ledger = (db) => db.store.get('referrals/R1');
const leadEvent = (before, after) => ({ params: { leadId: 'L1' }, data: { before: { exists: !!before, data: () => before }, after: { exists: !!after, data: () => after, ref: CURRENT_DB.doc('leads/L1') } } });
const jobEvent = (jobId, before, after) => ({ params: { leadId: 'L1', jobId }, data: { before: { exists: !!before, data: () => before }, after: { exists: !!after, data: () => after } } });

(async () => {
  console.log('\n1. the rule (pure): paid in full = the review ask\'s rule');
  {
    const P = I.paidForReferral;
    ok('paidForReferral is exported', typeof P === 'function');
    const at = (stage, role) => Object.assign({ stage }, role ? { stageRole: role } : {});
    ok('Install Done with the money in → NOT yet (a won stage, but before Final Payment)', P(at('install_complete', 'won'), [PAID()]) === false);
    ok('Final Photos / Deductible / Collections → NOT yet', !P(at('final_photos', 'won'), [PAID()]) && !P(at('deductible_collected', 'won'), [PAID()]) && !P(at('collections', 'won'), [PAID()]));
    ok('Final Payment + a paid invoice received → credited', P(at('final_payment', 'won'), [PAID()]) === true);
    ok('Closed + a paid invoice received → credited', P(at('closed', 'won'), [PAID()]) === true);
    ok('a tenant\'s CUSTOM won stage + paid → credited', P(at('custom_done', 'won'), [PAID()]) === true);
    ok('Closed but an invoice still owes money → NOT yet', P(at('closed', 'won'), [PAID(), OWING()]) === false);
    ok('Closed with no payment received at all (no invoice) → NOT yet', P(at('closed', 'won'), []) === false);
    ok('invoices not known (null) → NOT yet', P(at('closed', 'won'), null) === false);
    ok('a lost job → never', P(at('lost', 'lost'), [PAID()]) === false);
  }

  console.log('\n2. the active job (lead path + the paidInFull flip)');
  {
    const db = makeDb(); CURRENT_DB = db;
    const l = referred({ activeJobId: 'j1', stage: 'install_complete', stageRole: 'won' });
    seed(db, l, { j1: { stage: 'install_complete', stageRole: 'won' } }, { i1: PAID('j1') });
    await I.handleReferralLeadWrite(leadEvent(referred({ activeJobId: 'j1', stage: 'production' }), l));
    ok('Install Done (even with an invoice paid) → nothing owed, no bell', lead(db).referralRewardStatus === 'pending' && !job(db, 'j1').referralRewardOwedAt && db.notes.length === 0);
  }
  {
    const db = makeDb(); CURRENT_DB = db;
    const l = referred({ activeJobId: 'j1', stage: 'final_payment', stageRole: 'won' });
    seed(db, l, { j1: { stage: 'final_payment', stageRole: 'won' } }, { i1: PAID('j1'), i2: OWING('j1') });
    await I.handleReferralLeadWrite(leadEvent(referred({ activeJobId: 'j1', stage: 'install_complete', stageRole: 'won' }), l));
    ok('Final Payment with the final invoice still owing → nothing yet', lead(db).referralRewardStatus === 'pending' && db.notes.length === 0);
    // The final invoice is paid: money-paper.js markJobPaid flips job.paidInFull.
    db.store.set('invoices/i2', Object.assign(PAID('j1'), { total: 6000 }));
    const jb = job(db, 'j1');
    const ja = Object.assign({}, jb, { paidInFull: true });
    db.store.set('leads/L1/jobs/j1', ja);
    await I.handleReferralJobWrite(jobEvent('j1', jb, ja));
    ok('…the last invoice paid → the job flips paidInFull → $100 owed, ledger + bell', lead(db).referralRewardStatus === 'owed' && lead(db).referralRewardAmount === 100
      && !!job(db, 'j1').referralRewardOwedAt && ledger(db).rewardsOwedTotal === 100 && db.notes.length === 1, JSON.stringify(lead(db)));
    await I.handleReferralJobWrite(jobEvent('j1', ja, job(db, 'j1')));
    await I.handleReferralLeadWrite(leadEvent(lead(db), lead(db)));
    ok('…its own writes re-firing credit nothing more', ledger(db).rewardsOwedTotal === 100 && db.notes.length === 1);
  }
  {
    const db = makeDb(); CURRENT_DB = db;
    const l = referred({ activeJobId: 'j1', stage: 'closed', stageRole: 'won' });
    seed(db, l, { j1: { stage: 'closed', stageRole: 'won' } }, { i1: PAID('j1') });
    await I.handleReferralLeadWrite(leadEvent(referred({ activeJobId: 'j1', stage: 'final_payment', stageRole: 'won' }), l));
    ok('paid in full and closed → $100 owed', lead(db).referralRewardStatus === 'owed' && ledger(db).rewardsOwedTotal === 100);
    ok('…the bell says "paid in full", not "closed"', /paid in full/.test(db.notes[0] && db.notes[0].message) && !/closed\b/.test(db.notes[0].message), db.notes[0] && db.notes[0].message);
  }
  {
    const db = makeDb(); CURRENT_DB = db;
    const l = referred({ activeJobId: 'j1', stage: 'final_payment', stageRole: 'won' });
    seed(db, l, { j1: { stage: 'final_payment', stageRole: 'won' } }, {});
    const jb = job(db, 'j1');
    const ja = Object.assign({}, jb, { paidInFull: true });
    await I.handleReferralJobWrite(jobEvent('j1', jb, ja));
    ok('a paidInFull flag with no dated payment received → nothing (the review ask\'s rule)', lead(db).referralRewardStatus === 'pending' && db.notes.length === 0);
  }

  console.log('\n3. a lead with no jobs (legacy path)');
  {
    const db = makeDb(); CURRENT_DB = db;
    const l = referred({ stage: 'closed', stageRole: 'won' });
    seed(db, l, {}, {});
    await I.handleReferralLeadWrite(leadEvent(referred({ stage: 'install_complete' }), l));
    ok('closed, nothing paid → still pending', lead(db).referralRewardStatus === 'pending' && db.notes.length === 0);
    db.store.set('invoices/i1', PAID(undefined));
    await I.handleReferralLeadWrite(leadEvent(l, lead(db)));
    ok('the money arrives, the next lead write → $100 owed', lead(db).referralRewardStatus === 'owed' && lead(db).referralRewardAmount === 100 && ledger(db).rewardsOwedTotal === 100);
  }

  console.log('\n4. already credited referrals stay as they are');
  {
    const db = makeDb(); CURRENT_DB = db;
    const l = referred({ activeJobId: 'j1', stage: 'install_complete', stageRole: 'won', referralRewardStatus: 'owed', referralRewardAmount: 100, referralRewardJobCount: 1, referralRewardOwedAt: 'x' });
    seed(db, l, { j1: { stage: 'install_complete', stageRole: 'won', referralRewardOwedAt: 'x', referralRewardAmount: 100 } }, {});
    db.store.set('referrals/R1', { userId: 'u1', companyId: 'c1', rewardsOwedTotal: 100 });
    await I.handleReferralLeadWrite(leadEvent(referred({ activeJobId: 'j1', stage: 'production' }), l));
    ok('a bonus owed under the old rule (at Install Done) is not reversed or re-credited', lead(db).referralRewardStatus === 'owed' && lead(db).referralRewardAmount === 100 && ledger(db).rewardsOwedTotal === 100 && db.notes.length === 0);
  }

  console.log('\n5. wording: "paid in full", never "closes"');
  {
    const rd = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');
    const rr = rd('functions/referral-rewards.js');
    ok('referral-rewards: no "project closed" bell, no "owed when their project closes"', !/'s project closed\./.test(rr) && !/owed when their project closes/.test(rr));
    ok('the referral-code text says "once their project is paid in full"', /you get a \$100 bonus once their project is paid in full/.test(rd('docs/pro/js/review-engine.js')));
    ok('the referral-code email says "paid in full"', /For every referred job that is paid in full, you'll receive a \$100 bonus!/.test(rd('functions/email-functions.js')));
    ok('the warranty email\'s referral line says "paid in full"', /\$100 referral bonus for every referred job, once it is paid in full\./.test(rd('docs/pro/js/email_system.js')));
    ok('the referral document\'s terms say "paid in full"', /Bonus paid after the referred job is paid in full\./.test(rd('docs/pro/js/doc-preflight.js')));
    const all = rr + rd('docs/pro/js/review-engine.js') + rd('functions/email-functions.js') + rd('docs/pro/js/email_system.js') + rd('docs/pro/js/doc-preflight.js');
    ok('no "every job that closes" / "when their project closes" left', !/every job that closes|when their project closes|when the referred job closes/.test(all));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
