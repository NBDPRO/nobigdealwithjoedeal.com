/**
 * tests/deal-room-delete-no-resurrection-2026-09-16.test.js
 *
 * THE BUG: Close Board's deleteDeal() (docs/pro/js/close-board.js) removes the
 * client's local copy and deletes deal_rooms/{dealId} in Firestore, but never
 * touches any deal_accept_tokens minted for that deal. A homeowner who still
 * has the old /deal/<token> link (from an earlier text/email) can then hit
 * either no-login endpoint in functions/deal-acceptance.js:
 *
 *   - getDealRoom: its fire-and-forget "viewed" stamp did
 *       db.doc(`deal_rooms/${tok.dealId}`).set({status:'viewed', ...}, {merge:true})
 *     unconditionally — set(merge) CREATES a doc that isn't there.
 *   - submitDealAcceptance: its transaction did
 *       tx.set(db.doc(`deal_rooms/${t.dealId}`), {status:'accepted', ...}, {merge:true})
 *     with the same unconditional-create behavior, AND fired a "Deal accepted!
 *     🎉" notification to the rep for a deal they intentionally removed.
 *
 * Either path resurrects a deal the rep explicitly deleted, just by a stale
 * link being opened or replayed.
 *
 * THE FIX (functions/deal-acceptance.js, 2026-09-16): both entry points now
 * check deal_rooms/{dealId} existence before writing, and switched from
 * set(...,{merge:true}) to update(...) so even a missed check can't silently
 * recreate the doc — real Firestore's update() rejects on a nonexistent doc
 * instead of creating one.
 *
 * Per the house pattern (tests/deal-acceptance-atomicity.test.js, itself
 * following tests/invoice-payment-webhook.test.js): these onRequest functions
 * can't be require()d and driven directly, so this file mirrors the fixed
 * logic against a minimal fake Firestore that faithfully models the
 * update()-throws-on-missing-doc / set(merge)-always-creates distinction,
 * then break-tests by running the OLD shape through the same scenario to
 * prove it actually resurrects the doc.
 *
 * Zero deps. Run: node tests/deal-room-delete-no-resurrection-2026-09-16.test.js
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

// ── Minimal fake Firestore. update() faithfully rejects on a missing doc
//    (real Firestore behavior); set(merge) always creates/merges. This
//    distinction is exactly what the fix relies on. ──
function makeFakeDb(initialDocs) {
  const store = new Map(Object.entries(initialDocs || {}));
  function doc(p) {
    return {
      path: p,
      async get() { const data = store.get(p); return { exists: data !== undefined, data: () => data }; },
      async update(data) {
        if (!store.has(p)) { const e = new Error('NOT_FOUND: ' + p); e.code = 5; throw e; }
        store.set(p, Object.assign({}, store.get(p), data));
      },
      async set(data, opts) {
        const merge = !!(opts && opts.merge);
        store.set(p, merge ? Object.assign({}, store.get(p) || {}, data) : data);
      },
    };
  }
  return {
    doc,
    async runTransaction(cb) {
      const staged = [];
      const tx = {
        async get(ref) { return ref.get(); },
        update(ref, data) {
          if (!store.has(ref.path)) { const e = new Error('NOT_FOUND: ' + ref.path); e.code = 5; throw e; }
          staged.push({ path: ref.path, data, merge: true });
        },
        set(ref, data, opts) { staged.push({ path: ref.path, data, merge: !!(opts && opts.merge) }); },
      };
      const result = await cb(tx);
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

// ── Faithful mirror of the FIXED getDealRoom (the relevant slice: token
//    validation + deal-room existence check + fire-and-forget stamps). ──
async function fixedGetDealRoomStamp(db, token) {
  const tokRef = db.doc('deal_accept_tokens/' + token);
  const tokSnap = await tokRef.get();
  if (!tokSnap.exists) { const e = new Error('nf'); e._http = 404; throw e; }
  const tok = tokSnap.data();
  if (tok.expiresAt && tok.expiresAt < Date.now()) { const e = new Error('exp'); e._http = 410; throw e; }
  if (tok.status !== 'pending') { const e = new Error('done'); e._http = 410; throw e; }
  const dealRoomSnap = await db.doc('deal_rooms/' + tok.dealId).get();
  if (!dealRoomSnap.exists) { const e = new Error('gone'); e._http = 410; throw e; }
  // Fire-and-forget, but awaited here (not .catch-swallowed) so the test can
  // observe whether it actually wrote anything.
  await db.doc('deal_accept_tokens/' + token).update({ viewedAt: FieldValue.serverTimestamp() }).catch(() => {});
  await db.doc('deal_rooms/' + tok.dealId).update({ status: 'viewed', viewedAt: FieldValue.serverTimestamp() }).catch(() => {});
  return { served: true };
}

// ── Faithful mirror of the OLD (pre-fix) getDealRoom: no existence check,
//    set(merge) instead of update(). ──
async function oldGetDealRoomStamp(db, token) {
  const tokRef = db.doc('deal_accept_tokens/' + token);
  const tokSnap = await tokRef.get();
  if (!tokSnap.exists) { const e = new Error('nf'); e._http = 404; throw e; }
  const tok = tokSnap.data();
  if (tok.expiresAt && tok.expiresAt < Date.now()) { const e = new Error('exp'); e._http = 410; throw e; }
  if (tok.status !== 'pending') { const e = new Error('done'); e._http = 410; throw e; }
  await db.doc('deal_accept_tokens/' + token).update({ viewedAt: FieldValue.serverTimestamp() }).catch(() => {});
  await db.doc('deal_rooms/' + tok.dealId).set({ status: 'viewed', viewedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
  return { served: true };
}

// ── Faithful mirror of the FIXED submitDealAcceptance transaction (extends
//    tests/deal-acceptance-atomicity.test.js's fixedBurnAndRecord with the
//    new deal-room existence check). ──
async function fixedBurnAndRecord(db, token, input) {
  const tokRef = db.doc('deal_accept_tokens/' + token);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(tokRef);
    if (!snap.exists) { const e = new Error('nf'); e._http = 404; throw e; }
    const t = snap.data();
    if (t.expiresAt && t.expiresAt < Date.now()) { const e = new Error('exp'); e._http = 410; throw e; }
    if (t.status !== 'pending') { const e = new Error('done'); e._http = 409; throw e; }
    const dealRoomRef = db.doc('deal_rooms/' + t.dealId);
    const dealRoomSnap = await tx.get(dealRoomRef);
    if (!dealRoomSnap.exists) { const e = new Error('gone'); e._http = 410; throw e; }
    const price = (t.tierPrices && t.tierPrices[input.tier]) || 0;
    tx.update(tokRef, { status: 'accepted', acceptedAt: FieldValue.serverTimestamp() });
    tx.update(dealRoomRef, {
      status: 'accepted', acceptedTier: input.tier, acceptedPrice: price,
      acceptedSignature: input.signature, acceptedAt: FieldValue.serverTimestamp(), acceptedVia: 'remote',
    });
    return { dealId: t.dealId, ownerUid: t.ownerUid, price };
  });
}

// ── Faithful mirror of the OLD (pre-fix) submitDealAcceptance transaction:
//    no deal-room existence check, tx.set(merge) instead of tx.update(). ──
async function oldBurnAndRecord(db, token, input) {
  const tokRef = db.doc('deal_accept_tokens/' + token);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(tokRef);
    if (!snap.exists) { const e = new Error('nf'); e._http = 404; throw e; }
    const t = snap.data();
    if (t.expiresAt && t.expiresAt < Date.now()) { const e = new Error('exp'); e._http = 410; throw e; }
    if (t.status !== 'pending') { const e = new Error('done'); e._http = 409; throw e; }
    const price = (t.tierPrices && t.tierPrices[input.tier]) || 0;
    tx.update(tokRef, { status: 'accepted', acceptedAt: FieldValue.serverTimestamp() });
    tx.set(db.doc('deal_rooms/' + t.dealId), {
      status: 'accepted', acceptedTier: input.tier, acceptedPrice: price,
      acceptedSignature: input.signature, acceptedAt: FieldValue.serverTimestamp(), acceptedVia: 'remote',
    }, { merge: true });
    return { dealId: t.dealId, ownerUid: t.ownerUid, price };
  });
}

function tokenOnly() {
  return { 'deal_accept_tokens/tok1': { status: 'pending', dealId: 'deal1', ownerUid: 'u1', tierPrices: { better: 18000 } } };
  // Deliberately NO 'deal_rooms/deal1' entry — the rep deleted it.
}
function tokenAndDealRoom() {
  return Object.assign(tokenOnly(), { 'deal_rooms/deal1': { status: 'draft' } });
}

(async () => {

console.log('\nSOURCE CONTRACT — the real file actually has the existence checks this mirror assumes');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'deal-acceptance.js'), 'utf8');

  const getDealRoomStart = src.indexOf('exports.getDealRoom = onRequest(');
  const submitStart = src.indexOf('exports.submitDealAcceptance = onRequest(');
  ok('getDealRoom exists', getDealRoomStart >= 0);
  ok('submitDealAcceptance exists', submitStart >= 0);
  const getDealRoomBody = src.slice(getDealRoomStart, submitStart);

  ok('getDealRoom checks deal_rooms existence before the fire-and-forget writes',
    /const dealRoomSnap = await db\.doc\(`deal_rooms\/\$\{tok\.dealId\}`\)\.get\(\)/.test(getDealRoomBody)
    && /if \(!dealRoomSnap\.exists\)/.test(getDealRoomBody));
  ok('getDealRoom\'s viewed-stamp write is update(), not set(merge) (belt-and-suspenders against resurrection)',
    /db\.doc\(`deal_rooms\/\$\{tok\.dealId\}`\)\.update\(/.test(getDealRoomBody)
    && !/db\.doc\(`deal_rooms\/\$\{tok\.dealId\}`\)\.set\(/.test(getDealRoomBody));

  const submitBody = src.slice(submitStart);
  const txStart = submitBody.indexOf('info = await db.runTransaction(async (tx) => {');
  // 3000 (was 2200): the 2026-10-02 unpriced-package guard sits inside the
  // transaction too, ahead of the deal_rooms write.
  const txBody = txStart >= 0 ? submitBody.slice(txStart, txStart + 3000) : '';
  ok('submitDealAcceptance\'s transaction reads the deal_rooms doc before writing',
    /const dealRoomSnap = await tx\.get\(dealRoomRef\)/.test(txBody) && /if \(!dealRoomSnap\.exists\)/.test(txBody));
  ok('submitDealAcceptance\'s deal_rooms write is tx.update(), not tx.set(merge) (the pre-fix bug shape)',
    /tx\.update\(dealRoomRef,/.test(txBody) && !/tx\.set\(\s*db\.doc\(`deal_rooms\//.test(txBody));
}

console.log('\nFIXED getDealRoom — a deleted deal room refuses instead of resurrecting');
{
  const db = makeFakeDb(tokenOnly());
  let err;
  try { await fixedGetDealRoomStamp(db, 'tok1'); } catch (e) { err = e; }
  ok('throws 410 (deal no longer available)', err && err._http === 410);
  ok('deal_rooms/deal1 was NOT created', db._dump()['deal_rooms/deal1'] === undefined);
}

console.log('\nFIXED getDealRoom — an existing deal room still gets its normal viewed-stamp');
{
  const db = makeFakeDb(tokenAndDealRoom());
  const result = await fixedGetDealRoomStamp(db, 'tok1');
  ok('serves normally', result.served === true);
  ok('deal_rooms/deal1 stamped viewed', db._dump()['deal_rooms/deal1'].status === 'viewed');
}

console.log('\nBREAK-TEST — the OLD getDealRoom shape actually resurrects a deleted deal room');
{
  const db = makeFakeDb(tokenOnly());
  const result = await oldGetDealRoomStamp(db, 'tok1');
  ok('old code serves the stale link with no error', result.served === true);
  ok('THE BUG: deal_rooms/deal1 got silently RECREATED via set(merge)', db._dump()['deal_rooms/deal1'] && db._dump()['deal_rooms/deal1'].status === 'viewed');
}

console.log('\nFIXED submitDealAcceptance — a deleted deal room refuses, token stays unburned');
{
  const db = makeFakeDb(tokenOnly());
  let err;
  try { await fixedBurnAndRecord(db, 'tok1', { tier: 'better', signature: 'sig1' }); } catch (e) { err = e; }
  ok('throws 410 (deal no longer available)', err && err._http === 410);
  ok('token is NOT burned — still pending, homeowner can be told to ask their rep', db._dump()['deal_accept_tokens/tok1'].status === 'pending');
  ok('deal_rooms/deal1 was NOT created', db._dump()['deal_rooms/deal1'] === undefined);
}

console.log('\nFIXED submitDealAcceptance — an existing deal room still accepts normally');
{
  const db = makeFakeDb(tokenAndDealRoom());
  const result = await fixedBurnAndRecord(db, 'tok1', { tier: 'better', signature: 'sig1' });
  ok('returns the deal info', result.dealId === 'deal1' && result.price === 18000);
  ok('token is burned', db._dump()['deal_accept_tokens/tok1'].status === 'accepted');
  ok('deal_rooms reflects the acceptance', db._dump()['deal_rooms/deal1'].status === 'accepted' && db._dump()['deal_rooms/deal1'].acceptedTier === 'better');
}

console.log('\nBREAK-TEST — the OLD submitDealAcceptance shape actually resurrects the deal AND falsely notifies the rep\'s side');
{
  const db = makeFakeDb(tokenOnly());
  const result = await oldBurnAndRecord(db, 'tok1', { tier: 'better', signature: 'sig1' });
  ok('old code returns success (would trigger the "Deal accepted! 🎉" notification)', result.dealId === 'deal1');
  ok('token IS burned', db._dump()['deal_accept_tokens/tok1'].status === 'accepted');
  ok('THE BUG: deal_rooms/deal1 got silently RECREATED as accepted', db._dump()['deal_rooms/deal1'] && db._dump()['deal_rooms/deal1'].status === 'accepted');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }

})();
