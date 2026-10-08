#!/usr/bin/env node
/**
 * tests/close-flow-2026-10-03.test.js — the estimate → homeowner close flow.
 *
 *   A. Kentucky legal block. "Send for Signature" (BoldSign until 2026-10-04,
 *      in-house e-sign since — section A2/A3) sent the retail
 *      quote titled "Roofing Contract" with NO KRS 367.624 insurance-job
 *      notices. On a Kentucky insurance job — classified by the SAME
 *      ky-insurance-law.js classifyLead the contract notices use — the button
 *      is hidden, the call refuses, and "Sign on this phone" / "Generate
 *      contract" (both carry the notices) are offered. KY insurance, KY cash
 *      and OH insurance leads.
 *   B. Economy warranty. A flat "Lifetime Workmanship Warranty" badge sat
 *      above every tier; Economy is 1-year labor + the manufacturer's limited
 *      warranty, no system warranty. Each tier card now prints its own
 *      tierWarrantyText; no deal-wide badge.
 *   C. Financing (Reg Z). The deal page printed "~$X/mo" at 7.99% / 60 mo and
 *      offered 0–11.99% plans; the public estimator uses Acorn's 11.49–19.99%
 *      band. Both now read /assets/js/financing-band.js and print the SAME
 *      low–high range (parity checked on the real estimator code).
 *   D. "Create Deal Room" lost the estimate (never called save()). The one
 *      "Send to homeowner" flow saves (stamps the lead), creates the deal,
 *      mints the link, then opens the share sheet — in that order — and stays
 *      on screen. "Sign on this phone" opens the accept page with no email.
 *   E. Deal page contact: Call (tel:) + Text (sms:) buttons, 44px.
 *   F. V3 wizard: skips the Customer step when the open came prefilled from a
 *      lead; Finish has ONE primary (Send to homeowner), the rest under More.
 *
 * Behaviour, not source shape: every module is loaded in a vm and driven.
 * Run: node tests/close-flow-2026-10-03.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}

// A section that throws (e.g. a seam missing on an older build) fails
// loudly but lets the rest run — the break-test shows every red assertion.
function section(title, fn) {
  console.log(title);
  try { fn(); } catch (e) { ok(title + ' — ran', false, e && e.message); }
}
async function asection(title, fn) {
  console.log(title);
  try { await fn(); } catch (e) { ok(title + ' — ran', false, e && e.message); }
}
const J = require(path.join(ROOT, 'docs/pro/js/ky-insurance-law.js'));
const BAND = require(path.join(ROOT, 'docs/assets/js/financing-band.js'));

// ── a tiny fake DOM: elements by id, with classList / hidden / text ──────
function fakeEl(id) {
  const cls = new Set();
  return {
    id, textContent: '', innerHTML: '', hidden: false, disabled: false, style: {}, value: '',
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; },
    },
    _clicks: 0, click() { this._clicks++; },
  };
}
function fakeDoc(ids) {
  const els = {};
  (ids || []).forEach((i) => { els[i] = fakeEl(i); });
  return {
    els,
    getElementById: (i) => els[i] || null,
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => Object.assign(fakeEl(''), { appendChild() {}, addEventListener() {}, setAttribute() {} }),
    addEventListener() {}, body: { appendChild() {} }, head: { appendChild() {} },
  };
}

// ── estimate-v2-ui.js in a vm, with a priced cash per-SQ estimate ─────────
function loadV2(opts) {
  opts = opts || {};
  const SRC = read('docs/pro/js/estimate-v2-ui.js');
  const doc = fakeDoc(['v2signBtn', 'v2signStatus', 'v2kyNote', 'v2kyContractBtn', 'v2sendHoBtn', 'v2shareStatus', 'v2shareBox', 'v2saveBtn', 'v2saveStatus', 'estV2Modal', 'v2coName', 'v2coEmail', 'v2cosign']);
  const calls = [];
  const win = {};
  win.window = win;
  win.NBDJurisdiction = opts.noLaw ? undefined : J;
  win._user = { uid: 'u1' };
  win._leads = opts.leads || [];
  win.NBD_XACT_CATALOG = { find: (code) => ({ code, name: code, unit: 'SQ' }) };
  win.EstimateLogic = {
    resolveEstimate: () => ({ lines: [{ code: 'RFG', name: 'Shingles', quantity: 20, unit: 'SQ', lineTotal: 9000 }], subtotal: 9000, tax: 0, total: 9000 }),
    buildContext: (x) => x, MEASUREMENT_VARS: [],
  };
  win.EstimateBuilderV2 = {
    loadSettings: () => ({ countyTax: {} }),
    calculatePerSq: () => ({}),
    calculateAllTiers: () => ({
      economy: { total: 9000, subtotal: 9000 }, good: { total: 11000, subtotal: 11000 },
      better: { total: 13000, subtotal: 13000 }, best: { total: 15000, subtotal: 15000 }, beyond: { total: 17000, subtotal: 17000 },
    }),
  };
  let saveN = 0;
  win._saveEstimate = async (payload) => {
    calls.push(['save', { editing: win._editingEstimateId || null, leadId: payload.leadId }]);
    if (opts.saveFails) return null;
    saveN++;
    win._editingEstimateId = null; // _saveEstimate clears it after an update
    return 'est_1';
  };
  win.CloseBoard = opts.noCloseBoard ? undefined : {
    createFromEstimate: (est, lead) => { calls.push(['deal', { est, lead }]); return { id: 'dr_1' }; },
    getAcceptLink: async (deal) => { calls.push(['link', deal.id]); return 'https://example.test/deal/tok123'; },
    markShared: (id, via) => { calls.push(['marked', via]); },
  };
  win.showToast = (m, t) => { calls.push(['toast', m, t]); };
  // R6-3-2: the server's "ok to text?" (phone-share.js checkText). Default
  // yes; opts.textCheck is the server's answer; opts.noPhoneShare = the
  // module never loaded (must block, not open Messages unchecked).
  win.NBDPhoneShare = opts.noPhoneShare ? undefined : {
    checkText: async (o) => { calls.push(['checkText', o]); return opts.textCheck || { ok: true }; },
  };
  win.goTo = () => { calls.push(['goTo']); };
  // The in-house e-sign callable (2026-10-04). Records every call; the
  // server's answer is opts.callableResult (default: emailed, link returned).
  win._functions = {};
  win._httpsCallable = (_fns, name) => async (data) => {
    calls.push(['callable', name, data]);
    if (opts.callableThrows) throw new Error(opts.callableThrows);
    return { data: opts.callableResult || { ok: true, emailed: true, link: 'https://nobigdealwithjoedeal.com/pro/esign.html?t=ABCDEFGHJKMNPQRS' } };
  };
  const nav = {};
  if (opts.share) nav.share = async (data) => { calls.push(['share', data]); if (opts.share === 'abort') { const e = new Error('x'); e.name = 'AbortError'; throw e; } };
  const loc = { href: 'https://example.test/pro/dashboard' };
  win.location = loc;
  win.open = opts.popup === false ? () => null : () => {
    const w = { closed: false, location: { href: 'about:blank' }, close() { this.closed = true; } };
    calls.push(['open', w]);
    return w;
  };
  const sandbox = {
    window: win, document: doc, navigator: nav,
    console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Set, Map, Promise, setTimeout: (fn) => 0, clearTimeout() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  vm.runInNewContext(SRC, sandbox, { filename: 'estimate-v2-ui.js' });
  const T = win.EstimateV2UI._test;
  const st = T.getState();
  st.scope = [{ code: 'RFG' }];
  st.measurements.rawSqft = 2000;
  st.mode = 'per-sq';
  st.jobMode = 'cash';
  st.tier = 'better';
  st.customer = Object.assign({ name: 'Pat Homeowner', address: '1 Test St, Milford, OH 45150', phone: '(513) 555-0101', email: '', leadId: 'L1' }, opts.customer || {});
  return { T, st, win, doc, calls, nav, loc };
}

const KY_ADDR = '12 Dixie Hwy, Florence, KY 41042';
const OH_ADDR = '5 Vine St, Cincinnati, OH 45202';

section('A. Kentucky legal block — same classifier as the contract notices', () => {
  const cases = [
    { label: 'KY insurance', lead: { id: 'L1', address: KY_ADDR, jobType: 'insurance', insCarrier: 'State Farm', claimNumber: 'C-1' }, jobMode: 'insurance', claim: { carrier: 'State Farm', number: 'C-1' }, want: true },
    { label: 'KY cash', lead: { id: 'L1', address: KY_ADDR, jobType: 'cash' }, jobMode: 'cash', claim: {}, want: false },
    { label: 'OH insurance', lead: { id: 'L1', address: OH_ADDR, jobType: 'insurance', insCarrier: 'Allstate', claimNumber: 'C-2' }, jobMode: 'insurance', claim: { carrier: 'Allstate', number: 'C-2' }, want: false },
  ];
  for (const c of cases) {
    const V = loadV2({ leads: [c.lead], customer: { address: c.lead.address, email: 'pat@example.test' } });
    V.st.jobMode = c.jobMode;
    Object.assign(V.st.claim, c.claim);
    // Ground truth: what the contract notices decide for this lead.
    const truth = J.classifyLead(c.lead, { jobMode: c.jobMode }).kyInsurance;
    ok(c.label + ': contract classifier says kyInsurance=' + c.want, truth === c.want);
    ok(c.label + ': builder blocks e-mail e-signature = ' + c.want, V.T.kySigningBlocked() === c.want);
    V.T.applyKySigningGate();
    const d = V.doc.els;
    ok(c.label + ': "Send for Signature" ' + (c.want ? 'hidden' : 'shown'), d.v2signBtn.classList.contains('v2-ky-off') === c.want);
    ok(c.label + ': Kentucky note + "Generate contract" ' + (c.want ? 'shown' : 'hidden'), d.v2kyNote.hidden === !c.want && d.v2kyContractBtn.hidden === !c.want);
  }
  // The refusal itself (async) is in A2 below.
});

async function asyncTests() {
  await asection('A2. sendForSignature refuses a Kentucky insurance job before anything is sent', async () => {
    const V = loadV2({ leads: [{ id: 'L1', address: KY_ADDR, jobType: 'insurance' }], customer: { address: KY_ADDR, email: 'pat@example.test' } });
    V.st.jobMode = 'insurance';
    await V.T.sendForSignature();
    ok('KY insurance: the e-sign callable is never called', !V.calls.some((x) => x[0] === 'callable'));
    ok('KY insurance: the status names the Kentucky notices', /Kentucky insurance job/.test(V.doc.els.v2signStatus.textContent), V.doc.els.v2signStatus.textContent);
    ok('KY insurance: nothing saved for the envelope', !V.calls.some((x) => x[0] === 'save'));

    const O = loadV2({ leads: [{ id: 'L1', address: OH_ADDR, jobType: 'insurance' }], customer: { address: OH_ADDR, email: 'pat@example.test' } });
    O.st.jobMode = 'insurance';
    await O.T.sendForSignature();
    ok('OH insurance: passes the Kentucky gate and sends', O.calls.some((x) => x[0] === 'callable' && x[1] === 'sendEstimateEnvelope'),
      JSON.stringify(O.calls.map((c) => c[0])));

    const N = loadV2({ noLaw: true, customer: { address: OH_ADDR } });
    ok('law module missing → fail closed (blocked)', N.T.kySigningBlocked() === true);
  });

  await asection('A3. Send for Signature goes to the in-house e-sign (BoldSign retired 2026-10-04)', async () => {
    const V = loadV2({ customer: { email: 'Pat@Example.test' } });
    const r = await V.T.sendForSignature();
    const order = V.calls.map((c) => c[0]).filter((k) => k === 'save' || k === 'callable').join('>');
    ok('save happens BEFORE the send (the server builds the contract from the saved estimate)', order === 'save>callable', order);
    const call = V.calls.find((c) => c[0] === 'callable');
    ok('calls sendEstimateEnvelope (not a vendor)', call && call[1] === 'sendEstimateEnvelope', call && call[1]);
    ok('sends the SAVED estimate id', call && call[2].estimateId === 'est_1', call && JSON.stringify(call[2]));
    ok('one signer: the customer, email lower-cased', call && call[2].signers.length === 1 && call[2].signers[0].name === 'Pat Homeowner' && call[2].signers[0].email === 'pat@example.test');
    ok('emails the link (remote send)', call && call[2].sendEmail === true);
    ok('no client-rendered HTML goes to the server any more', call && !('html' in call[2]));
    ok('result: sent', r === 'sent', r);
    ok('status confirms the send', /Sent to pat@example\.test/.test(V.doc.els.v2signStatus.textContent), V.doc.els.v2signStatus.textContent);
    ok('the signing link is shown to copy / open', /esign\.html\?t=ABCDEFGHJKMNPQRS/.test(V.doc.els.v2shareBox.innerHTML) && V.doc.els.v2shareBox.hidden === false);

    // Co-owner: a second signer rides along.
    const C = loadV2({ customer: { email: 'pat@example.test' } });
    C.doc.els.v2coName.value = 'Sam Homeowner';
    C.doc.els.v2coEmail.value = 'Sam@Example.test';
    await C.T.sendForSignature();
    const cc = C.calls.find((c) => c[0] === 'callable');
    ok('co-owner becomes signer 2', cc && cc[2].signers.length === 2 && cc[2].signers[1].name === 'Sam Homeowner' && cc[2].signers[1].email === 'sam@example.test', cc && JSON.stringify(cc[2].signers));
    const H = loadV2({ customer: { email: 'pat@example.test' } });
    H.doc.els.v2coName.value = 'Sam Homeowner';
    await H.T.sendForSignature();
    ok('co-owner with no email is refused before anything is sent', !H.calls.some((c) => c[0] === 'save' || c[0] === 'callable'), JSON.stringify(H.calls.map((c) => c[0])));

    // No email on file: refused for a remote send (nothing saved, nothing sent).
    const E = loadV2({ customer: { email: '' } });
    await E.T.sendForSignature();
    ok('remote send without an email is refused before saving', !E.calls.some((c) => c[0] === 'save' || c[0] === 'callable'));

    // In person (Present → Sign Now): no email needed; the signing page opens in the tab opened inside the tap.
    const P = loadV2({ customer: { email: '' } });
    const pr = await P.T.sendForSignature({ inPerson: true });
    const pc = P.calls.find((c) => c[0] === 'callable');
    ok('in person: link only, no email', pc && pc[2].sendEmail === false, pc && JSON.stringify(pc[2]));
    const tab = P.calls.find((c) => c[0] === 'open');
    ok('in person: the tab opened inside the tap now shows the signing page', tab && /esign\.html\?t=/.test(tab[1].location.href) && pr === 'opened', pr);

    // A server refusal surfaces and closes the pre-opened tab.
    const F = loadV2({ customer: { email: 'pat@example.test' }, callableThrows: 'Price the estimate first' });
    const fr = await F.T.sendForSignature({ inPerson: true });
    const ftab = F.calls.find((c) => c[0] === 'open');
    ok('server refusal: shown to the rep', /Price the estimate first/.test(F.doc.els.v2signStatus.textContent) && fr === 'failed');
    ok('server refusal: the blank tab is closed', ftab && ftab[1].closed === true);
  });

  await asection('D. Send to homeowner — save → deal → link → share, stays on screen', async () => {
    const V = loadV2({ share: true });
    const r = await V.T.sendToHomeowner();
    const order = V.calls.map((c) => c[0]).filter((k) => ['save', 'deal', 'link', 'share'].indexOf(k) !== -1).join('>');
    ok('order is save > deal > link > share', order === 'save>deal>link>share', order);
    const deal = V.calls.find((c) => c[0] === 'deal');
    ok('the deal carries the SAVED estimate id', deal && deal[1].est.id === 'est_1' && deal[1].lead.estimateId === 'est_1');
    ok('the deal carries every per-SQ tier price', deal && deal[1].est.prices.economy === 9000 && deal[1].est.prices.beyond === 17000, deal && JSON.stringify(deal[1].est.prices));
    ok('the save was for the linked lead (stamps primary estimate + job value)', V.calls.find((c) => c[0] === 'save')[1].leadId === 'L1');
    const sh = V.calls.find((c) => c[0] === 'share');
    ok('the share sheet gets the accept link', sh && sh[1].url === 'https://example.test/deal/tok123');
    ok('shared → deal stamped sent (via link)', V.calls.some((c) => c[0] === 'marked' && c[1] === 'link'));
    ok('result "shared"', r === 'shared', r);
    ok('stays on screen: no goTo(closeboard)', !V.calls.some((c) => c[0] === 'goTo'));
    ok('the fallback share box is rendered with the link', !V.doc.els.v2shareBox.hidden && /tok123/.test(V.doc.els.v2shareBox.innerHTML));

    // Second tap: updates the same estimate instead of adding a copy.
    V.calls.length = 0;
    await V.T.sendToHomeowner();
    const s2 = V.calls.find((c) => c[0] === 'save');
    ok('second send UPDATES the saved estimate (edit id = est_1)', s2 && s2[1].editing === 'est_1', s2 && JSON.stringify(s2[1]));
    ok('…and the edit id does not linger afterwards', !V.win._editingEstimateId);

    // No share API: Messages with the phone on file.
    const M = loadV2({});
    const r2 = await M.T.sendToHomeowner();
    ok('no navigator.share → sms: with the customer phone + link', r2 === 'sms' && /^sms:\(?5135550101\?body=/.test(M.loc.href.replace(/[()\s-]/g, '')) && /tok123/.test(decodeURIComponent(M.loc.href)), M.loc.href);
    ok('…stamped sent via sms', M.calls.some((c) => c[0] === 'marked' && c[1] === 'sms'));
    ok('…after the server "ok to text?" for THIS lead and phone (R6-3-2)',
      M.calls.some((c) => c[0] === 'checkText' && c[1].leadId === 'L1' && /5135550101/.test(String(c[1].phone).replace(/\D/g, ''))),
      JSON.stringify(M.calls.filter((c) => c[0] === 'checkText')));

    // R6-3-2 (2026-10-07): a customer who replied STOP / is on the Do Not
    // Text list / it is 11pm for → the automatic hand-off does NOT open
    // Messages, says why, and stamps nothing.
    const STOPPED = { ok: false, code: 'opted_out', reason: 'This customer replied STOP — they asked not to be texted. Call or email instead.' };
    const B = loadV2({ textCheck: STOPPED });
    const b3 = await B.T.sendToHomeowner();
    ok('R6-3-2: opted-out customer → Messages NOT opened by the automatic hand-off', !/^sms:/.test(B.loc.href) && b3 === 'blocked', b3 + ' ' + B.loc.href);
    ok('R6-3-2: …the rep is told why (the server reason)', B.calls.some((c) => c[0] === 'toast' && /replied STOP/.test(c[1]) && c[2] === 'error'));
    ok('R6-3-2: …and the deal is NOT stamped sent via sms', !B.calls.some((c) => c[0] === 'marked' && c[1] === 'sms'));
    // The 💬 Text link in the share box: the tap is held for the same check.
    B.calls.length = 0;
    const b4 = await B.T._textShare();
    ok('R6-3-2: the 💬 Text link is blocked the same way (no sms:, reason shown)',
      b4 === 'blocked' && !/^sms:/.test(B.loc.href) && B.calls.some((c) => c[0] === 'toast' && /replied STOP/.test(c[1])), b4);
    const Q = loadV2({ textCheck: { ok: false, code: 'quiet_hours', reason: 'It is 11:30 PM for this homeowner — texting hours are 8am–9pm their time.' } });
    const b5 = await Q.T.sendToHomeowner();
    ok('R6-3-2: outside texting hours → blocked with the hours reason', b5 === 'blocked' && !/^sms:/.test(Q.loc.href) && Q.calls.some((c) => c[0] === 'toast' && /texting hours/.test(c[1])));
    const N = loadV2({ noPhoneShare: true });
    const b6 = await N.T.sendToHomeowner();
    ok('R6-3-2: check unavailable (phone-share.js not loaded) → blocked, never an unchecked hand-off',
      b6 === 'blocked' && !/^sms:/.test(N.loc.href) && N.calls.some((c) => c[0] === 'toast' && /Couldn.t check/.test(c[1])), b6 + ' ' + N.loc.href);

    // Save fails → no deal, no link.
    const F = loadV2({ saveFails: true, share: true });
    const r3 = await F.T.sendToHomeowner();
    ok('save failed → no deal, no link, no share', r3 === 'failed' && !F.calls.some((c) => ['deal', 'link', 'share'].indexOf(c[0]) !== -1));
    ok('…and the rep is told nothing was sent', /did not save/.test(F.doc.els.v2shareStatus.textContent), F.doc.els.v2shareStatus.textContent);

    // Insurance (line-item) estimate: the deal offers the priced package.
    const I = loadV2({ share: true, leads: [{ id: 'L1', address: OH_ADDR, jobType: 'insurance' }] });
    I.st.mode = 'line-item'; I.st.jobMode = 'insurance';
    await I.T.sendToHomeowner();
    const di = I.calls.find((c) => c[0] === 'deal');
    ok('insurance line-item: one package at the estimate total', di && JSON.stringify(di[1].est.prices) === '{"better":9000}', di && JSON.stringify(di[1].est.prices));
    ok('insurance line-item: the deal is flagged an insurance job', di && di[1].lead.insuranceClaim === true);
  });

  await asection('D2. Sign on this phone — no email needed, opens the accept page', async () => {
    const V = loadV2({ customer: { email: '' } });
    const r = await V.T.signOnThisPhone();
    const w = (V.calls.find((c) => c[0] === 'open') || [])[1];
    ok('opened in-app on the accept link (no email on file)', r === 'opened' && w && w.location.href === 'https://example.test/deal/tok123', r);
    ok('saved before the deal', V.calls.map((c) => c[0]).filter((k) => k === 'save' || k === 'deal').join() === 'save,deal');
    ok('an in-person signing does not stamp the deal "sent"', !V.calls.some((c) => c[0] === 'marked'));
    const B = loadV2({ popup: false });
    const rb = await B.T.signOnThisPhone();
    ok('popup blocked → a tappable "Open the signing page" link', rb === 'link' && /href="https:\/\/example\.test\/deal\/tok123"/.test(B.doc.els.v2shareBox.innerHTML));
    // Kentucky insurance job: the presentation's Sign Now routes here too.
    const src = read('docs/pro/js/estimate-v2-ui.js');
    const presSign = src.slice(src.indexOf("case 'pres-sign':"), src.indexOf("case 'load-preset':"));
    ok('presentation "Sign Now" routes a KY insurance job to Sign on this phone', /_kySigningBlocked\(\)\)\s*signOnThisPhone\(\)/.test(presSign));
  });
}

// ── close-board.js in a vm ─────────────────────────────────────────────────
function loadCB(withConfig, withBand) {
  const win = { addEventListener() {}, _user: null };
  win.window = win;
  const doc = { getElementById: () => null, addEventListener() {}, querySelector: () => null };
  win.document = doc;
  const c = { window: win, document: doc, console: { log() {}, warn() {}, error() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, setTimeout, clearTimeout, navigator: {}, Date, Math, JSON };
  vm.createContext(c);
  if (withConfig) vm.runInContext(read('docs/pro/js/estimate-config.js'), c);
  if (withBand) vm.runInContext(read('docs/assets/js/financing-band.js'), c);
  win._brand = () => ({ legalName: 'No Big Deal Home Solutions', contact: { phone: '(859) 420-7382', email: 'info@example.test' } });
  vm.runInContext(read('docs/pro/js/close-board.js'), c);
  return { CB: win.CloseBoard, win };
}
const tierOf = (p) => ({ price: p, description: '', lineItems: [] });
const DEAL5 = { id: 'd1', customerName: 'Pat', address: '1 Test St, Milford, OH 45150', repName: 'Joe', repEmail: 'jd@example.test', repPhone: '(859) 420-7382',
  tiers: { economy: tierOf(9000), good: tierOf(11000), better: tierOf(13000), best: tierOf(15000), beyond: tierOf(17000) } };
function tierBlock(html, t) {
  const a = html.indexOf('data-deal-tier="' + t + '"');
  const b = html.indexOf('data-deal-tier="', a + 10);
  return a < 0 ? '' : html.slice(a, b < 0 ? html.indexOf('</div>\n  </div>', a) : b);
}

section('B. Warranty — each tier its own; Economy is 1-year labor, no lifetime badge', () => {
  const { CB, win } = loadCB(true, true);
  const cfg = win.NBD_ESTIMATE_CONFIG;
  const html = CB.generatePageHTML(DEAL5);
  ok('no deal-wide "Lifetime Workmanship Warranty" badge', !/warranty-badge/.test(html) && !/Lifetime Workmanship Warranty/.test(html));
  const eco = tierBlock(html, 'economy');
  ok('Economy card: its own 1-year labor + manufacturer limited warranty, no system warranty', eco.indexOf(cfg.tierWarrantyText('economy').replace(/'/g, '&#39;')) !== -1, eco);
  ok('Economy card never says "Lifetime"', !/lifetime/i.test(eco), eco);
  for (const t of ['good', 'better', 'best', 'beyond']) {
    const blk = tierBlock(html, t);
    ok(t + ' card prints its own tierWarrantyText', blk.indexOf(cfg.tierWarrantyText(t).replace(/'/g, '&#39;')) !== -1, blk);
  }
  // Fallback (config not loaded) prints the same sentences.
  const { CB: CB2 } = loadCB(false, true);
  const html2 = CB2.generatePageHTML(DEAL5);
  for (const t of ['economy', 'good', 'better', 'best', 'beyond']) {
    ok('fallback text = config text for ' + t, tierBlock(html2, t).indexOf(cfg.tierWarrantyText(t).replace(/'/g, '&#39;')) !== -1);
  }
  ok('tier prices unchanged on the page', /\$9,000\.00/.test(html) && /\$17,000\.00/.test(html));
});

section('C. Financing — one shared band, public estimator and deal page agree', () => {
  // Real public estimator code, fake DOM.
  function publicRange(amount, years) {
    const els = {};
    ['fe-amount', 'fe-term-group', 'fe-amt', 'fe-lo', 'fe-hi'].forEach((i) => { els[i] = { textContent: '', value: String(amount), addEventListener() {}, querySelectorAll: () => [] }; });
    const win = {};
    const c = { window: win, document: { getElementById: (i) => els[i] || null }, Math };
    vm.createContext(c);
    vm.runInContext(read('docs/assets/js/financing-band.js'), c);
    vm.runInContext(read('docs/assets/js/financing-estimator.js'), c);
    return els['fe-lo'].textContent + '–' + els['fe-hi'].textContent;
  }
  const { CB } = loadCB(true, true);
  const html = CB.generatePageHTML(DEAL5);
  for (const [t, p] of [['economy', 9000], ['better', 13000], ['beyond', 17000]]) {
    const pub = publicRange(p, BAND.defaultTermYears);
    const m = /or est\. (\$[\d,]+–\$[\d,]+)\/mo/.exec(tierBlock(html, t));
    ok(t + ' $' + p + ': deal page range = public estimator range (' + pub + ')', m && m[1] === pub, m && m[1]);
  }
  ok('the public estimator reads the shared band (no own APR constants)', !/0\.1149|0\.1999/.test(read('docs/assets/js/financing-estimator.js')));
  const fin = read('docs/services/financing.html');
  ok('financing.html loads financing-band.js before financing-estimator.js',
    fin.indexOf('/assets/js/financing-band.js') !== -1 && fin.indexOf('/assets/js/financing-band.js') < fin.indexOf('/assets/js/financing-estimator.js'));
  ok('no 7.99% / 5.99% / same-as-cash plans on the deal page', !/(^|[^\d.])(7\.99|5\.99|9\.99|11\.99)%|Same-as-Cash/.test(html));
  ok('disclaimer: "Estimate only. Subject to credit approval. Rates and terms vary."', html.indexOf('Estimate only. Subject to credit approval. Rates and terms vary.') !== -1);
  ok('the site\'s Acorn pre-qualification link', html.indexOf('https://www.acornfinance.com/pre-qualify/?d=QU6WZ') !== -1);
  ok('the band label 11.49%–19.99% APR is printed', html.indexOf('11.49%–19.99% APR') !== -1);
  const island = JSON.parse(/<script type="application\/json" id="nbd-deal-data">([\s\S]*?)<\/script>/.exec(html)[1]);
  ok('data island carries the band (not rates)', island.band && island.band.aprLo === BAND.aprLo && island.band.aprHi === BAND.aprHi && !island.rates);

  // deal-room.js (the homeowner page) prints the same range when a tier is picked.
  function dealRoomRow(islandObj, tier) {
    const els = { financeOpts: { innerHTML: '' }, submitBtn: { disabled: true } };
    let clickH = null;
    const doc = {
      getElementById: (i) => (i === 'nbd-deal-data' ? { textContent: JSON.stringify(islandObj) } : (els[i] || null)),
      querySelectorAll: () => [], querySelector: () => null,
      addEventListener: (ev, fn) => { if (ev === 'click') clickH = fn; }, visibilityState: 'visible',
    };
    const c = { window: { addEventListener() {} }, document: doc, navigator: {}, Math, JSON, Number, String, parseInt };
    vm.createContext(c);
    vm.runInContext(read('docs/pro/deal-room.js'), c);
    clickH({ target: { closest: (sel) => (sel === '[data-deal-tier]' ? { dataset: { dealTier: tier } } : null) } });
    return els.financeOpts.innerHTML;
  }
  const row = dealRoomRow(island, 'better');
  ok('deal-room.js prints the same range for the picked tier', row.indexOf(publicRange(13000, 5)) !== -1, row);
  const legacy = dealRoomRow({ prices: { better: 13000 }, rates: [{ term: 60, rate: 7.99, label: '60 mo @ 7.99%' }] }, 'better');
  ok('an OLD page (rates, no band) offers Pay in Full only — never 7.99%', !/7\.99|\/mo/.test(legacy) && /Pay in Full/.test(legacy), legacy);

  const { CB: CBnb } = loadCB(true, false);
  const nb = CBnb.generatePageHTML(DEAL5);
  ok('band not loaded → no monthly payment printed at all', !/\/mo with financing/.test(nb));
});

section('E. Deal page contact — Call + Text buttons', () => {
  const { CB } = loadCB(true, true);
  const html = CB.generatePageHTML(DEAL5);
  ok('Call button (tel:)', /<a class="rep-btn" href="tel:8594207382"/.test(html));
  ok('Text button (sms:)', /<a class="rep-btn" href="sms:8594207382"/.test(html));
  ok('buttons are 44px tap targets', /\.rep-btn\{[^}]*min-height:44px/.test(html));
  ok('the phone is no longer plain text in .rep-contact', !/rep-contact">\(859\)/.test(html));
  ok('no number → no buttons', !/rep-btn" href/.test(CB.generatePageHTML(Object.assign({}, DEAL5, { repPhone: '' }))));
});

section('D3. createFromEstimate — carries the estimate id, reuses its open deal', () => {
  const { CB, win } = loadCB(true, true);
  win._user = { uid: 'u1' };
  const d1 = CB.createFromEstimate({ id: 'est_9', prices: { better: 13000 } }, { id: 'L1', name: 'Pat', phone: '5135550101', estimateId: 'est_9' });
  ok('deal remembers the saved estimate', d1.estimateId === 'est_9');
  ok('deal gets the company phone for Call / Text', d1.repPhone === '(859) 420-7382');
  ok('no deal-wide warranty default', d1.warranty === '');
  const d2 = CB.createFromEstimate({ id: 'est_9', prices: { better: 14000 } }, { id: 'L1', name: 'Pat', estimateId: 'est_9' });
  ok('same estimate again → same deal, refreshed price', d2.id === d1.id && d2.tiers.better.price === 14000 && CB.getDeals().length === 1);
  const d3 = CB.createFromEstimate({ id: 'est_9', prices: { better: 1 } }, { id: 'L1', name: 'Pat', insuranceClaim: true });
  ok('an insurance job with no carrier yet is still flagged insurance', d3.insuranceClaim === true);
});

section('F. V3 wizard — skip Customer when prefilled; one primary on Finish', () => {
  function loadV3(state, leads) {
    const cash = fakeEl('v2jobCash');
    const fakeModal = { classList: { toggle() {}, add() {} }, querySelectorAll: () => [], querySelector: () => null, contains: () => true };
    const win = { EstimateV2UI: { getState: () => state }, _leads: leads || [] };
    const c = { window: win, console, document: { getElementById: (i) => (i === 'estV2Modal' ? fakeModal : i === 'v2jobCash' ? cash : null) } };
    vm.createContext(c);
    vm.runInContext(read('docs/pro/js/estimate-v3-wizard.js'), c);
    const T = win.EstimateV3._test;
    T.ui.modal = fakeModal; T.ui.built = true;
    return { V3: win.EstimateV3, T, cash };
  }
  const pre = { jobMode: 'insurance', customer: { leadId: 'L1', name: 'Pat', address: '1 Test St' }, scope: [], measurements: {} };
  const a = loadV3(pre, [{ id: 'L1', jobType: 'cash' }]);
  a.V3.onOpen({ reopened: false });
  ok('opens on Customer', a.T.ui.step === 'job');
  a.V3.onRender(); // V2 renders AFTER prefillFromLead
  ok('first render after a prefilled lead open skips to Measure', a.T.ui.step === 'measure', a.T.ui.step);
  ok('the lead\'s cash job type is set through the real Cash toggle', a.cash._clicks === 1);
  a.T.ui.step = 'job'; a.V3.onRender();
  ok('only once per open — a later render on Customer stays put', a.T.ui.step === 'job');
  const b = loadV3({ jobMode: 'insurance', customer: { name: '', address: '' }, scope: [], measurements: {} });
  b.V3.onOpen({}); b.V3.onRender();
  ok('a blank customer still opens on Customer', b.T.ui.step === 'job');
  const r = loadV3(pre, []);
  r.V3.onOpen({ reopened: true }); r.V3.onRender();
  ok('a reopened estimate still lands on Review', r.T.ui.step === 'review');

  const fin = a.T.TAGS.filter((t) => String(t[1]).split(' ').indexOf('finish') !== -1);
  const primary = fin.filter((t) => t[2] !== 'more').map((t) => t[0]);
  // 2026-10-04: the Full packet / Paperwork only choice (+ its hint and photo
  // picker) is the question asked AT send time, so it sits with the primary.
  ok('Finish primary is ONLY Send to homeowner (+ its packet choice / status / share box)',
    primary.join() === '.v2-packet,#v2packetHint,#v2packetPhotos,[data-action="send-to-homeowner"],#v2shareStatus,#v2shareBox', primary.join());
  const more = fin.filter((t) => t[2] === 'more').map((t) => t[0]).join();
  ok('Present / Save / Sign / exports sit under More',
    ['[data-action="present"]', '#v2saveBtn', '#v2signBtn', '#v2signPhoneBtn', '.v2-export-btns'].every((s) => more.indexOf(s) !== -1), more);
  ok('the old Create Deal Room button is not a Finish control', !a.T.TAGS.some((t) => t[0].indexOf('create-deal-room') !== -1));
});

asyncTests().then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
}, (e) => { console.error(e); process.exit(1); });
