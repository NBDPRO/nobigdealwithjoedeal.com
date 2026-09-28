/**
 * tests/deal-acceptance-atomicity.test.js
 *
 * functions/deal-acceptance.js's submitDealAcceptance is an onRequest Cloud
 * Function with no defineSecret, but it still can't be exercised end-to-end
 * without a real (or emulated) Firestore transaction — so, per the house
 * pattern set by tests/invoice-payment-webhook.test.js ("the Cloud Function
 * can't be require()d standalone ... creditPayment() below is a FAITHFUL
 * MIRROR of the db.runTransaction() callback ... If you change that
 * transaction block in stripe.js, mirror it here"), this file mirrors the
 * submitDealAcceptance burn+record transaction against a minimal in-memory
 * Firestore-transaction fake, and proves the specific property the
 * 2026-09-14 fix added: atomicity.
 *
 * THE BUG (before the fix): the token burn (`tx.update(tokRef, {status:
 * 'accepted'})`) committed inside its own transaction; the deal_rooms
 * acceptance record was then written in a SEPARATE, non-transactional
 * `db.doc(...).set(...)` wrapped in a try/catch that only logger.warn'd on
 * failure. A failure on that second write left the token permanently burned
 * (single-use, can never be replayed) while deal_rooms still showed the
 * pre-acceptance state — the homeowner saw "accepted", the CRM's Close Board
 * still read draft, and nothing surfaced an error anywhere.
 *
 * THE FIX: both writes are staged inside the SAME transaction (`tx.update` +
 * `tx.set`), so Firestore commits them together or not at all.
 *
 * This test builds a tiny fake `runTransaction` that genuinely enforces that
 * atomicity contract (writes are buffered and only applied on a successful
 * return; a throw discards everything staged), then:
 *   1. Runs the FIXED shape (both writes in one transaction) through a
 *      simulated mid-transaction failure and proves NEITHER write lands.
 *   2. Runs the OLD shape (burn transaction, then a separate write) through
 *      the same failure and proves the split-state bug actually occurs —
 *      so this test is proven to distinguish the two, not just describe them.
 *   3. Covers the ordinary success, not-found, expired, and already-accepted
 *      paths against the fixed shape.
 *
 * Zero deps. Run: node tests/deal-acceptance-atomicity.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ── Minimal fake Firestore: docs keyed by path, transactions buffer writes
//    and only apply them if the callback resolves without throwing. ──
function makeFakeDb(initialDocs) {
  const store = new Map(Object.entries(initialDocs || {}));
  return {
    doc(path) {
      return {
        path,
        async get() {
          const data = store.get(path);
          return { exists: data !== undefined, data: () => data };
        },
      };
    },
    async runTransaction(cb) {
      const staged = [];
      const tx = {
        async get(ref) { return ref.get(); },
        update(ref, data) { staged.push({ path: ref.path, data, merge: true }); },
        set(ref, data, opts) { staged.push({ path: ref.path, data, merge: !!(opts && opts.merge) }); },
      };
      const result = await cb(tx); // a throw here discards `staged` entirely
      for (const w of staged) {
        const prior = store.get(w.path) || {};
        store.set(w.path, w.merge ? Object.assign({}, prior, w.data) : w.data);
      }
      return result;
    },
    _dump() { return Object.fromEntries(store); },
  };
}

const FieldValue = { serverTimestamp: () => 'SERVER_TS' };

// ── Faithful mirror of the FIXED submitDealAcceptance transaction body
//    (functions/deal-acceptance.js, burn + record in one tx.set/tx.update). ──
async function fixedBurnAndRecord(db, token, input) {
  const tokRef = db.doc('deal_accept_tokens/' + token);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(tokRef);
    if (!snap.exists) { const e = new Error('nf'); e._http = 404; throw e; }
    const t = snap.data();
    if (t.expiresAt && t.expiresAt < Date.now()) { const e = new Error('exp'); e._http = 410; throw e; }
    if (t.status !== 'pending') { const e = new Error('done'); e._http = 409; throw e; }
    const price = (t.tierPrices && t.tierPrices[input.tier]) || 0;
    tx.update(tokRef, { status: 'accepted', acceptedAt: FieldValue.serverTimestamp() });
    if (input._injectDealRoomFailure) { throw new Error('simulated deal_rooms write failure'); }
    tx.set(db.doc('deal_rooms/' + t.dealId), {
      status: 'accepted', acceptedTier: input.tier, acceptedPrice: price,
      acceptedSignature: input.signature, acceptedAt: FieldValue.serverTimestamp(), acceptedVia: 'remote',
    }, { merge: true });
    return { dealId: t.dealId, ownerUid: t.ownerUid, price };
  });
}

// ── Faithful mirror of the OLD (pre-2026-09-14) shape: burn commits alone,
//    then a SEPARATE non-transactional write follows in its own try/catch. ──
async function oldBurnThenSeparateRecord(db, token, input) {
  const tokRef = db.doc('deal_accept_tokens/' + token);
  const info = await db.runTransaction(async (tx) => {
    const snap = await tx.get(tokRef);
    if (!snap.exists) { const e = new Error('nf'); e._http = 404; throw e; }
    const t = snap.data();
    if (t.expiresAt && t.expiresAt < Date.now()) { const e = new Error('exp'); e._http = 410; throw e; }
    if (t.status !== 'pending') { const e = new Error('done'); e._http = 409; throw e; }
    tx.update(tokRef, { status: 'accepted', acceptedAt: FieldValue.serverTimestamp() });
    return { dealId: t.dealId, ownerUid: t.ownerUid, price: (t.tierPrices && t.tierPrices[input.tier]) || 0 };
  });
  // Token already burned by this point — the old code's separate write:
  try {
    if (input._injectDealRoomFailure) throw new Error('simulated deal_rooms write failure');
    const ref = db.doc('deal_rooms/' + info.dealId);
    const prior = (await ref.get()).data() || {};
    // (real code used db.doc(...).set(..., {merge:true}) directly — inline
    // equivalent against the fake db, since it has no bare non-tx .set())
    Object.assign(prior, { status: 'accepted', acceptedTier: input.tier });
    db.runTransaction(async () => {}); // no-op; keeps fake db shape consistent
  } catch (e) { /* old code: logger.warn and swallow */ }
  return info;
}

function freshDocs() {
  return {
    'deal_accept_tokens/tok1': { status: 'pending', dealId: 'deal1', ownerUid: 'u1', tierPrices: { better: 18000 } },
    'deal_rooms/deal1': { status: 'draft' },
  };
}

// Wrapped in an async IIFE — this is a CommonJS .js file (no "type":"module"
// in tests/package.json), and top-level await is not this repo's convention.
(async () => {

console.log('\nSOURCE CONTRACT — the real file actually has the shape this mirror assumes');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'deal-acceptance.js'), 'utf8');
  const txStart = src.indexOf('info = await db.runTransaction(async (tx) => {');
  ok('the burn transaction exists', txStart >= 0);
  // Window bounded by txEnd below; 1800 was outgrown by the 2026-09-28
  // DONE_STATUSES guard (deal-room-sibling-links-2026-09-28.test.js).
  const txBody = txStart >= 0 ? src.slice(txStart, txStart + 4000) : '';
  const txEnd = txBody.indexOf('\n      });');
  const insideTx = txEnd >= 0 ? txBody.slice(0, txEnd) : txBody;
  // 2026-09-16: the write moved from tx.set(db.doc(`deal_rooms/...`), {...}, {merge:true})
  // to tx.update(dealRoomRef, {...}) against a ref bound earlier in the block
  // (see tests/deal-room-delete-no-resurrection-2026-09-16.test.js) — update()
  // rejects on a missing doc instead of silently creating one. Either write
  // form satisfies THIS test's property (same transaction, not a separate write).
  ok('the deal_rooms write is INSIDE the transaction body (the fix)',
    /tx\.set\(\s*db\.doc\(`deal_rooms\//.test(insideTx)
    || (/dealRoomRef\s*=\s*db\.doc\(`deal_rooms\//.test(insideTx) && /tx\.update\(dealRoomRef,/.test(insideTx)));
  ok('the deal_rooms write is not a separate, non-transactional db.doc(...).set(...) after the transaction resolves (the pre-fix bug shape)',
    !/\n\s*await db\.doc\(`deal_rooms\/\$\{info\.dealId\}`\)\.set\(/.test(src));
}

console.log('\nFIXED shape — happy path commits both writes together');
{
  const db = makeFakeDb(freshDocs());
  const result = await fixedBurnAndRecord(db, 'tok1', { tier: 'better', signature: 'sig1' });
  ok('returns the deal info', result.dealId === 'deal1' && result.price === 18000);
  ok('token is burned', db._dump()['deal_accept_tokens/tok1'].status === 'accepted');
  ok('deal_rooms reflects the acceptance', db._dump()['deal_rooms/deal1'].status === 'accepted' && db._dump()['deal_rooms/deal1'].acceptedTier === 'better');
}

console.log('\nFIXED shape — a mid-transaction failure rolls back BOTH writes (the atomicity property)');
{
  const db = makeFakeDb(freshDocs());
  let threw = false;
  try { await fixedBurnAndRecord(db, 'tok1', { tier: 'better', signature: 'sig1', _injectDealRoomFailure: true }); }
  catch (e) { threw = true; }
  ok('the call throws (caller returns 500, never a silent 200)', threw);
  ok('the token is NOT burned — still pending', db._dump()['deal_accept_tokens/tok1'].status === 'pending');
  ok('deal_rooms is untouched — still draft', db._dump()['deal_rooms/deal1'].status === 'draft');
}

console.log('\nOLD shape (pre-fix) — the SAME failure actually produces the split-state bug');
{
  const db = makeFakeDb(freshDocs());
  await oldBurnThenSeparateRecord(db, 'tok1', { tier: 'better', signature: 'sig1', _injectDealRoomFailure: true });
  ok('token IS burned (single-use, now permanently unusable)', db._dump()['deal_accept_tokens/tok1'].status === 'accepted');
  ok('deal_rooms is STILL draft — the bug: homeowner saw accepted, CRM never learned', db._dump()['deal_rooms/deal1'].status === 'draft');
}

console.log('\nFIXED shape — not-found / expired / already-accepted all refuse cleanly, no partial writes');
{
  const dbNf = makeFakeDb({}); // no token doc at all
  let err;
  try { await fixedBurnAndRecord(dbNf, 'missing', { tier: 'better', signature: 's' }); } catch (e) { err = e; }
  ok('missing token -> 404, throws', err && err._http === 404);

  const dbExp = makeFakeDb({ 'deal_accept_tokens/tok1': { status: 'pending', dealId: 'deal1', expiresAt: Date.now() - 1000, tierPrices: {} } });
  err = undefined;
  try { await fixedBurnAndRecord(dbExp, 'tok1', { tier: 'better', signature: 's' }); } catch (e) { err = e; }
  ok('expired token -> 410, throws', err && err._http === 410);

  const dbDone = makeFakeDb({ 'deal_accept_tokens/tok1': { status: 'accepted', dealId: 'deal1', tierPrices: {} } });
  err = undefined;
  try { await fixedBurnAndRecord(dbDone, 'tok1', { tier: 'better', signature: 's' }); } catch (e) { err = e; }
  ok('already-accepted token -> 409, throws (no double-accept)', err && err._http === 409);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }

})();
