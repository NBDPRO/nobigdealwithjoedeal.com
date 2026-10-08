/**
 * tests/d2d-knock-fast-2026-10-08.test.js
 *
 * CRM phone audit 2026-10-07, item 3 (batch C) — the door-knock sheet's fast
 * path (d2d-tracker-ui-2026b.js + d2d-tracker-core-2026b.js).
 *
 * What it pins, running the REAL functions lifted out of the files into a vm:
 *   - doorGateState: ONE door-number rule for the one-tap outcomes and Save.
 *     Address → house number → (machine-verified, not a GPS fix of where the
 *     rep stands) or the rep's tick on the exact text in the box.
 *   - quickOutcome: Not Home / Not Interested / Left Info save on the tap
 *     when the gate passes; refused (nothing saved, the gate hint shown) when
 *     it doesn't; Come Back / Interested never save on the tap.
 *   - submitKnock offline: returns a "queued:" ref (it returned null — the
 *     failed-save value — so the sheet stayed open and a second tap queued
 *     the door twice); quiet suppresses the core toast for the undo bar.
 *   - undoKnock: drops a queued knock from the offline queue / deletes a
 *     saved one; touches nothing else.
 *   - smsConsent still needs the explicit tick AND a phone (texting review
 *     2026-10-05) — unchanged, guarded here.
 *
 * Break-test: against origin/main the doorGateState / quickOutcome /
 * undoKnock / offline-return cases go red (the functions don't exist, and
 * submitKnock returns null offline). The browser side is
 * tests/e2e/phone-knock-fast.spec.js.
 *
 * Zero deps. Run: node tests/d2d-knock-fast-2026-10-08.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'docs/pro/js/d2d-tracker-core-2026b.js'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'docs/pro/js/d2d-tracker-ui-2026b.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// Lift `[async ]function name(` … matching brace out of a source file.
function extractFn(src, name) {
  const m = new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  if (!m) return '';
  const open = src.indexOf('{', src.indexOf(')', m.index));
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(m.index, i);
}
function extractConst(src, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*').exec(src);
  if (!m) return '';
  const end = src.indexOf(';', m.index);
  return src.slice(m.index, end + 1);
}

// ── UI: doorGateState + quickOutcome ─────────────────────────────────────
function uiRig(boxText, entry) {
  const els = { 'd2d-qk-address': { value: boxText } };
  const calls = { submit: 0, hint: [], select: [], focus: [], detailsOpen: false };
  const details = { open: false };
  const sheet = { querySelector: (sel) => (/\.d2d-details/.test(sel) ? details : { dataset: {} }) };
  const ctx = vm.createContext({
    console,
    document: {
      getElementById: (id) => (id === 'd2d-quick-knock-overlay' ? sheet : (els[id] || { id, focus() {} })),
    },
    state: {
      currentKnockEntry: entry,
      DISPOSITIONS: { not_home: {}, not_interested: {}, left_material: {}, come_back: {}, interested: {} },
      extractHouseNumber: (s) => { const m = String(s || '').trim().match(/^\s*(\d+[a-zA-Z]?)\b/); return m ? m[1] : ''; },
    },
    selectDispo: (k) => calls.select.push(k),
    showGateHint: (g) => calls.hint.push(g.need),
    handleSubmitKnock: async () => { calls.submit++; },
    _bringIntoView: (el, focusEl) => { if (focusEl) calls.focus.push(focusEl.id); },
  });
  const src = [extractFn(UI, 'doorGateState'), extractConst(UI, 'QUICK_OUTCOMES'), extractConst(UI, 'ONE_TAP'), extractFn(UI, 'quickOutcome')].join('\n');
  // Missing functions (origin/main) become stubs, so the cases below fail BY NAME.
  vm.runInContext(src + '\nfunction renderDoorGate(){ return globalThis.doorGateState(); }\n'
    + 'globalThis.doorGateState = typeof doorGateState === "function" ? doorGateState : () => ({ ok: null, need: "doorGateState missing" });\n'
    + 'globalThis.quickOutcome = typeof quickOutcome === "function" ? quickOutcome : async () => {};', ctx);
  return { ctx, calls, details };
}

// ── core: submitKnock + undoKnock ────────────────────────────────────────
function coreRig({ online }) {
  const calls = { toasts: [], added: [], deleted: [], saved: 0 };
  const state = { isOnline: online, offlineQueue: [], knocks: [], currentRep: { name: 'Rep', companyId: 'c1' } };
  const win = {
    _user: { uid: 'u1' }, _db: {},
    serverTimestamp: () => 'TS',
    collection: (_db, name) => ({ name }),
    doc: (_db, coll, id) => ({ coll, id }),
    addDoc: async (coll, data) => { calls.added.push(data); return { id: 'new-' + calls.added.length }; },
    deleteDoc: async (ref) => { calls.deleted.push(ref.coll + '/' + ref.id); },
    showToast: (m, t) => calls.toasts.push(t + ':' + m),
    D2D: null,
  };
  const ctx = vm.createContext({
    window: win, state, console: { error() {}, warn() {}, log() {} },
    localStorage: { setItem() {}, getItem() { return null; } },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    MAX_ATTEMPTS: 5, D2D_QUEUE_MAX: 200,
    INS_DISPOSITIONS: ['ins_has_claim', 'ins_needs_file', 'ins_denied'],
    HOT_DISPOSITIONS: ['appointment', 'interested', 'storm_damage', 'ins_has_claim', 'ins_needs_file', 'callback'],
    getAttemptCount: () => 0,
    loadKnocks: async () => {}, refreshMapMarkers: () => {}, convertToLead: async () => {},
    attributeKnockToStormZone: () => {}, flushKnockPhotoQueue: async () => {},
    saveOfflineQueue: () => { calls.saved++; },
  });
  const src = [extractConst(CORE, 'DISPOSITIONS'), extractFn(CORE, 'extractHouseNumber'), extractFn(CORE, '_withTimeout'),
    extractFn(CORE, 'enqueueOffline'), extractConst(CORE, 'QUEUED_PREFIX'), extractFn(CORE, 'submitKnock'), extractFn(CORE, 'undoKnock')].join('\n');
  vm.runInContext(src + '\nglobalThis.submitKnock = submitKnock; globalThis.undoKnock = typeof undoKnock === "function" ? undoKnock : undefined;', ctx);
  return { ctx, calls, state };
}
const knockData = (o) => Object.assign({ address: '12 Main St, Cincinnati, OH', disposition: 'not_home', phone: '', smsConsent: false, clientTempId: 't-1' }, o || {});

(async () => {
  console.log('D2D knock sheet — door-number gate');
  {
    const g = (text, e) => uiRig(text, e || {}).ctx.doorGateState();
    ok('no address → asks for the address', g('').need === 'address');
    ok('street only → asks for the door number', g('Main St, Cincinnati').need === 'number');
    const un = g('12 Main St', {});
    ok('a number nobody verified → needs the tick', un.ok === false && un.need === 'confirm' && un.hn === '12', JSON.stringify(un));
    ok('machine-verified for this exact text → passes with no tick',
      g('12 Main St', { addrConfidence: 'verified', addrVerifiedFor: '12 Main St' }).ok === true);
    ok('verified from the rep\'s own GPS fix → still needs the tick',
      g('12 Main St', { addrConfidence: 'verified', addrVerifiedFor: '12 Main St', addrFromGps: true }).need === 'confirm');
    ok('the rep\'s tick on this text → passes',
      g('12 Main St', { addrConfirmed: true, addrVerifiedFor: '12 Main St' }).ok === true);
    ok('a tick given to different text does not carry over',
      g('14 Main St', { addrConfirmed: true, addrVerifiedFor: '12 Main St' }).need === 'confirm');
    ok('a verdict for different text does not carry over',
      g('14 Main St', { addrConfidence: 'verified', addrVerifiedFor: '12 Main St' }).need === 'confirm');
  }

  console.log('\nD2D knock sheet — one-tap outcomes');
  {
    const ready = { addrConfirmed: true, addrVerifiedFor: '12 Main St' };
    for (const k of ['not_home', 'not_interested', 'left_material']) {
      const r = uiRig('12 Main St', Object.assign({}, ready));
      await r.ctx.quickOutcome(k);
      ok(`${k}: one tap saves (gate passed)`, r.calls.submit === 1 && r.calls.select[0] === k, JSON.stringify(r.calls));
    }
    {
      const r = uiRig('12 Main St', {});
      await r.ctx.quickOutcome('not_home');
      ok('not_home without the tick: nothing saved, the tick is pointed at', r.calls.submit === 0 && r.calls.hint[0] === 'confirm', JSON.stringify(r.calls));
    }
    {
      const r = uiRig('Main St', {});
      await r.ctx.quickOutcome('not_home');
      ok('not_home with no door number: nothing saved, asks for the number', r.calls.submit === 0 && r.calls.hint[0] === 'number');
    }
    {
      const r = uiRig('12 Main St', Object.assign({}, ready));
      await r.ctx.quickOutcome('interested');
      ok('interested never saves on the tap', r.calls.submit === 0 && r.calls.select[0] === 'interested');
      ok('…it opens Contact & Notes with the name focused', r.details.open === true && r.calls.focus[0] === 'd2d-qk-homeowner', JSON.stringify(r.calls.focus));
    }
    {
      const r = uiRig('12 Main St', Object.assign({}, ready));
      await r.ctx.quickOutcome('come_back');
      ok('come_back never saves on the tap (and does not pop the keyboard)', r.calls.submit === 0 && r.details.open === true && r.calls.focus.length === 0);
    }
  }

  console.log('\nD2D submitKnock / undoKnock');
  {
    const r = coreRig({ online: false });
    const ref = await r.ctx.submitKnock(knockData());
    ok('offline: returns a queued ref, not null (null = "not saved")', ref === 'queued:t-1', String(ref));
    ok('…and queues the knock exactly once', r.state.offlineQueue.length === 1 && r.calls.added.length === 0);
    const ref2 = await r.ctx.submitKnock(knockData({ clientTempId: '' }));
    ok('offline without a tempId: one is assigned so the knock can be undone', /^queued:\d+$/.test(String(ref2)) && r.state.offlineQueue[1].data.clientTempId === ref2.slice(7));
    ok('undoKnock drops ONLY that queued knock', typeof r.ctx.undoKnock === 'function' && (await r.ctx.undoKnock('queued:t-1')) === true
      && r.state.offlineQueue.length === 1 && r.state.offlineQueue[0].data.clientTempId !== 't-1');
    ok('…and an unknown ref is a no-op', typeof r.ctx.undoKnock === 'function' && (await r.ctx.undoKnock('queued:nope')) === false && r.state.offlineQueue.length === 1);
  }
  {
    const r = coreRig({ online: true });
    const id = await r.ctx.submitKnock(knockData(), false, { quiet: true });
    ok('online: saves and returns the doc id', id === 'new-1' && r.calls.added.length === 1);
    ok('quiet: no "saved" toast (the undo bar says it)', !r.calls.toasts.some((t) => /^success:/.test(t)), JSON.stringify(r.calls.toasts));
    await r.ctx.submitKnock(knockData({ clientTempId: 't-2' }));
    ok('not quiet: the toast still shows', r.calls.toasts.some((t) => /^success:/.test(t)));
    ok('undoKnock deletes the saved knock (no confirm)', typeof r.ctx.undoKnock === 'function' && (await r.ctx.undoKnock('new-1')) === true && r.calls.deleted.join() === 'knocks/new-1');
    const d = r.calls.added[0];
    ok('the one-tap path writes the standard knock shape (orderBy field createdAt set)', d.createdAt === 'TS' && d.disposition === 'not_home' && d.stage === 'knock' && d.userId === 'u1' && d.companyId === 'c1');
  }
  {
    const r = coreRig({ online: true });
    await r.ctx.submitKnock(knockData({ smsConsent: true, phone: '' }));
    await r.ctx.submitKnock(knockData({ smsConsent: true, phone: '5135550100', clientTempId: 't-3' }));
    await r.ctx.submitKnock(knockData({ smsConsent: 'yes', phone: '5135550100', clientTempId: 't-4' }));
    const [a, b, c] = r.calls.added;
    ok('smsConsent needs a phone', a.smsConsent === false && !('smsConsentAt' in a));
    ok('smsConsent true + phone → consent on file, stamped', b.smsConsent === true && b.smsConsentAt === 'TS' && b.smsConsentBy === 'u1');
    ok('only an explicit true counts', c.smsConsent === false);
  }

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
