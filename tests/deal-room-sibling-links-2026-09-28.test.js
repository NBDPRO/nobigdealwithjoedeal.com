/**
 * tests/deal-room-sibling-links-2026-09-28.test.js
 *
 * THE BUG: every Text / Email / Copy on the Close Board mints a NEW
 * deal_accept_tokens doc for the same deal, and the older tokens stay
 * 'pending'. functions/deal-acceptance.js gated only on the TOKEN's status,
 * so once the homeowner accepted on link A, sibling link B:
 *   - getDealRoom: served the page and stamped deal_rooms.status = 'viewed' —
 *     an accepted deal fell off the signed list and out of booked revenue just
 *     by an old text being opened;
 *   - submitDealAcceptance: accepted AGAIN, overwriting acceptedTier /
 *     acceptedPrice / acceptedSignature and re-notifying the rep.
 * Reproduced on the emulator 2026-09-28: BEST $15,000 accepted on A → opening
 * B → 'viewed' → GOOD on B → accepted GOOD $10,000, 2 notifications.
 *
 * THE FIX: the DEAL's status gates all three entry points (DONE_STATUSES =
 * accepted / signed / scheduled): getDealRoom 410s before any stamp,
 * submitDealAcceptance 409s INSIDE the transaction before any write, and
 * createDealAcceptToken refuses (failed-precondition) to mint a link for an
 * accepted deal. Verified on the emulator after the fix: B → 410, submit on
 * B → 409, deal stays BEST $15,000, 1 notification.
 *
 * Per the house pattern (deal-room-delete-no-resurrection-2026-09-16.test.js)
 * the onRequest handlers can't be driven directly, so this file (1) asserts on
 * the REAL source with comments stripped — each guard present AND positioned
 * before the write it protects — and (2) runs the fixed decision logic and the
 * old logic through the sibling-link scenario on a fake store.
 *
 * Zero deps. Run: node tests/deal-room-sibling-links-2026-09-28.test.js
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

// Comments stripped so an assertion can't pass on its own explanatory prose.
const raw = fs.readFileSync(path.join(__dirname, '..', 'functions', 'deal-acceptance.js'), 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

function body(name) {
  const start = src.indexOf('exports.' + name + ' =');
  if (start < 0) return '';
  const next = src.indexOf('\nexports.', start + 10);
  return src.slice(start, next < 0 ? src.length : next);
}

console.log('DEAL ROOM — sibling links can\'t undo an acceptance (source contract)');
{
  ok('DONE_STATUSES lists accepted, signed and scheduled',
    /const DONE_STATUSES\s*=\s*\[\s*'accepted',\s*'signed',\s*'scheduled'\s*\]/.test(src));

  const mint = body('createDealAcceptToken');
  const mintGuard = mint.search(/DONE_STATUSES\.includes\(deal\.status\)/);
  const mintWrite = mint.indexOf('deal_accept_tokens/${token}');
  ok('createDealAcceptToken refuses an accepted deal', mintGuard > 0 && /failed-precondition/.test(mint.slice(mintGuard, mintGuard + 200)));
  ok('…before it writes a token', mintGuard > 0 && mintWrite > mintGuard);

  const get = body('getDealRoom');
  const getGuard = get.search(/DONE_STATUSES\.includes\(\(dealRoomSnap\.data\(\) \|\| \{\}\)\.status\)/);
  const getStamp = get.indexOf("status: 'viewed'");
  ok('getDealRoom checks the deal status', getGuard > 0);
  ok('…and returns an error page (410) there', getGuard > 0 && /errPage\(410/.test(get.slice(getGuard, getGuard + 160)));
  ok('…before the viewed stamp', getGuard > 0 && getStamp > getGuard);

  const sub = body('submitDealAcceptance');
  const txStart = sub.indexOf('runTransaction');
  const subGuard = sub.search(/DONE_STATUSES\.includes\(\(dealRoomSnap\.data\(\) \|\| \{\}\)\.status\)/);
  const firstWrite = sub.indexOf('tx.update(');
  ok('submitDealAcceptance checks the deal status inside the transaction', txStart > 0 && subGuard > txStart);
  ok('…with a 409', subGuard > 0 && /_http = 409/.test(sub.slice(subGuard, subGuard + 160)));
  ok('…before either transactional write', subGuard > 0 && firstWrite > subGuard);
}

// ── Behavior: the decision logic, fixed vs old, over one deal with two links ──
function makeStore() {
  const s = new Map();
  s.set('deal_rooms/d1', { status: 'sent' });
  s.set('deal_accept_tokens/A', { status: 'pending', dealId: 'd1', tierPrices: { good: 10000, best: 15000 } });
  s.set('deal_accept_tokens/B', { status: 'pending', dealId: 'd1', tierPrices: { good: 10000, best: 15000 } });
  return s;
}
const DONE = ['accepted', 'signed', 'scheduled'];
function open(store, tok, fixed) {
  const t = store.get('deal_accept_tokens/' + tok);
  if (t.status !== 'pending') return 410;
  const deal = store.get('deal_rooms/' + t.dealId);
  if (fixed && DONE.includes(deal.status)) return 410;
  store.set('deal_rooms/' + t.dealId, Object.assign({}, deal, { status: 'viewed' }));
  return 200;
}
function accept(store, tok, tier, fixed, notes) {
  const t = store.get('deal_accept_tokens/' + tok);
  if (t.status !== 'pending') return 409;
  const deal = store.get('deal_rooms/' + t.dealId);
  if (fixed && DONE.includes(deal.status)) return 409;
  store.set('deal_accept_tokens/' + tok, Object.assign({}, t, { status: 'accepted' }));
  store.set('deal_rooms/' + t.dealId, Object.assign({}, deal, { status: 'accepted', acceptedTier: tier, acceptedPrice: t.tierPrices[tier] }));
  notes.push(tier);
  return 200;
}

console.log('DEAL ROOM — two live links, accept on one, then use the other');
for (const fixed of [true, false]) {
  const store = makeStore();
  const notes = [];
  open(store, 'A', fixed);
  accept(store, 'A', 'best', fixed, notes);
  const openB = open(store, 'B', fixed);
  const afterOpen = store.get('deal_rooms/d1').status;
  const acceptB = accept(store, 'B', 'good', fixed, notes);
  const deal = store.get('deal_rooms/d1');
  if (fixed) {
    ok('fixed: opening link B is refused (410)', openB === 410);
    ok('fixed: the deal stays accepted after B is opened', afterOpen === 'accepted');
    ok('fixed: accepting on B is refused (409)', acceptB === 409);
    ok('fixed: the first acceptance stands (BEST $15,000)', deal.acceptedTier === 'best' && deal.acceptedPrice === 15000);
    ok('fixed: the rep is notified once', notes.length === 1);
  } else {
    ok('break-test: OLD logic regresses the deal to viewed on open', afterOpen === 'viewed');
    ok('break-test: OLD logic overwrites the acceptance (GOOD $10,000)', deal.acceptedTier === 'good' && deal.acceptedPrice === 10000);
    ok('break-test: OLD logic notifies twice', notes.length === 2);
  }
}

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
