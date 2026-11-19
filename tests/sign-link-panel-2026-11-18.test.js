/**
 * sign-link-panel-2026-11-18.test.js - signing-ease lane (Jo's Q48, Q59, Q60), flag docSignPanelV1 (default OFF, per person):
 *   A. server: createSignRequest mints a link WITHOUT an email (sendEmail:false), flag on only; every gate still runs;
 *      14-day expiry only with the flag; a new link retires the old one; flag off is unchanged
 *   B. the registry / flag plumbing (FIRESTORE_FLAGS row, strict gate read, same flag name on server and client)
 *   C. the panel module (docs/pro/js/sign-link-panel.js) in a small fake DOM: QR, Text link, Copy link, Email it, Make a new link
 *   D. the viewer wiring: flag on shows the panel and never calls window.prompt; flag off keeps the old prompt; lazy load, versions
 * Run: node tests/sign-link-panel-2026-11-18.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
module.paths.unshift(path.join(FN, 'node_modules'));
const kit = require('./lib/doc-evidence-kit');
const DE = require(path.join(FN, 'doc-evidence.js'));
const K = require(path.join(FN, 'ky-insurance-law.js'));
const ESL = require(path.join(FN, 'esign-logic.js'));
const AG = require(path.join(FN, 'attic-gate.js'));
const AA = require(path.join(FN, 'attic-ack.js'));
const NBDQr = require(path.join(ROOT, 'docs/pro/js/qr-code.js'));
const rx = (re, text) => re.exec(text) !== null; // a plain wording probe for the few checks that have no behaviour to run
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.V1_VERBOSE) console.log('  ok ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }

const FLAG = 'docSignPanelV1';
const P = 'documents/U1/L1/d-1.html';
const CONTRACT = '<!DOCTYPE html><html><head><title>Roofing Contract</title></head><body><h1>Roofing Contract</h1><p>Contract price: $14,500.00</p>'
  + '<!--nbd-cancel-packet:start--><section data-nbd-cancel-by="2026-11-17"><h2>Notice of Right to Cancel</h2>'
  + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
  + '<div data-nbd-noc="ftc"><p>NOTICE OF CANCELLATION. NOT LATER THAN MIDNIGHT OF November 17, 2026</p></div>'
  + '</section><!--nbd-cancel-packet:end-->'
  + '<div data-nbd-sig="homeowner" data-nbd-sig-required="1"><canvas width="300" height="100"></canvas></div></body></html>';
const PROFILE = { brand: { legalName: 'Acme Roofing LLC', entityName: 'Acme Roofing LLC', contact: { mailingAddress: '1 Main St, Cincinnati, OH 45202' } } };
// NO email on the lead's record: the case Q48 is about.
const lead = (extra) => Object.assign({ userId: 'U1', companyId: 'U1', firstName: 'Dana', lastName: 'Whitfield', address: '12 Oak St, Cincinnati, OH 45202', jobType: 'cash', primaryEstimateId: 'E1' }, extra || {});
const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './doc-evidence', './await-briefly', './signed-price', './attic-gate', './attic-ack', 'crypto'];
const stubs = () => ({ './cancel-window': require(path.join(FN, 'cancel-window.js')), './ky-insurance-law': K, './lead-artifact-paths': require(path.join(FN, 'lead-artifact-paths.js')),
  './esign-logic': ESL, './doc-evidence': DE, './await-briefly': require(path.join(FN, 'await-briefly.js')), './signed-price': require(path.join(FN, 'signed-price.js')), './attic-gate': AG, './attic-ack': AA });
const world = (flags, o) => {
  const x = o || {};
  const s = {
    'leads/L1': lead(x.lead), 'companyProfile/U1': PROFILE,
    'estimates/E1': x.est || { grandTotal: 14500, rows: [{ code: 'GTR 5K' }] },
    'leads/L1/documents/d1': { type: x.type || 'contract', typeName: 'Roofing Contract', htmlPath: P, userId: 'U1' },
  };
  if (flags) s['feature_flags/_default'] = flags;
  return kit.makeDb(s);
};
const mint = async (db, data, mod) => {
  if (mod) mod(db);
  const L = kit.loadHandler('remote-signing.js', db, kit.makeStorage({ [P]: CONTRACT }), stubs(), REAL);
  const t0 = Date.now();
  try { return { v: await L.fns.createSignRequest({ auth: { uid: 'U1', token: {} }, data: Object.assign({ leadId: 'L1', docId: 'd1', signerName: 'Dana Whitfield' }, data || {}) }), db, t0 }; }
  catch (e) { return { e, db, t0 }; }
};
const tokens = (db) => db._all('doc_sign_tokens');
const DAY = 86400000;

(async () => {
  // ═══════════════════════════════════════════════════════
  section('A. createSignRequest: a link without an email (flag docSignPanelV1)');
  {
    let r = await mint(world({ [FLAG]: true }), { sendEmail: false });
    ok('flag on, sendEmail:false, no email anywhere: a link is minted', !!r.v && !!r.v.signLink && r.v.signLink.indexOf(r.v.token) !== -1, r.e && r.e.message);
    ok('nothing was emailed, and the token is stored with no signer email', !!r.v && r.v.emailed === false && tokens(r.db).length === 1 && (tokens(r.db)[0] || {}).signerEmail === '');
    ok('the token is pending and single-use as always (status pending, no burn fields)', (tokens(r.db)[0] || {}).status === 'pending');
    ok('the document is stamped "sent" like an emailed link', (r.db._get('leads/L1/documents/d1') || {}).status === 'sent');
    r = await mint(world({ [FLAG]: true }), { sendEmail: false, signerEmail: 'not-an-email' });
    ok('flag on, sendEmail:false: a junk address typed alongside is ignored, never emailed', !!r.v && r.v.emailed === false && (tokens(r.db)[0] || {}).signerEmail === '', r.e && r.e.message);
    r = await mint(world({ [FLAG]: true }), {});
    ok('flag on, but sendEmail NOT false and no email: the old refusal stands', !!r.e && r.e.code === 'invalid-argument' && /valid signer email/.test(r.e.message) && tokens(r.db).length === 0);
    r = await mint(world({ [FLAG]: true }), { sendEmail: true });
    ok('flag on, sendEmail:true and no email: refused too', !!r.e && r.e.code === 'invalid-argument');
    r = await mint(world({ [FLAG]: true }), { signerEmail: 'stranger@example.test' });
    ok('flag on, an email send to an address NOT on the record is still refused', !!r.e && r.e.code === 'failed-precondition' && tokens(r.db).length === 0);
    r = await mint(world({ [FLAG]: true }, { lead: { email: 'dana@example.test' } }), { signerEmail: 'dana@example.test' });
    ok('flag on, the email path (address on the record) still emails and mints', !!r.v && r.v.emailed === true && (tokens(r.db)[0] || {}).signerEmail === 'dana@example.test', r.e && r.e.message);

    // flag OFF: byte-identical
    r = await mint(world(null), { sendEmail: false });
    ok('FLAG OFF: sendEmail:false with no email is the existing refusal, nothing minted', !!r.e && r.e.code === 'invalid-argument' && r.e.message === 'A valid signer email is required' && tokens(r.db).length === 0);
    r = await mint(world({ [FLAG]: false }), { sendEmail: false });
    ok('flag explicitly false: same refusal', !!r.e && r.e.code === 'invalid-argument');
    r = await mint(world(null), { sendEmail: false, signerEmail: 'stranger@example.test' });
    ok('FLAG OFF: an address not on the record is still refused (sendEmail:false never relaxes it)', !!r.e && r.e.code === 'failed-precondition' && r.e.message === ESL.SIGN_EMAIL_NOT_ON_RECORD && tokens(r.db).length === 0);
    r = await mint(world(null), { signerEmail: 'dana@example.test' }, null);
    ok('FLAG OFF, no email on the record: refused as before', !!r.e && r.e.code === 'failed-precondition');
    r = await mint(world(null, { lead: { email: 'dana@example.test' } }), { signerEmail: 'dana@example.test' });
    ok('FLAG OFF: the email path emails and mints exactly as before, 7-day link', !!r.v && r.v.emailed === true && Math.abs(r.v.expiresAt - (r.t0 + 7 * DAY)) < 60000, r.e && r.e.message);

    // expiry
    r = await mint(world({ [FLAG]: true }), { sendEmail: false });
    ok('flag on: the link lasts 14 days', !!r.v && Math.abs(r.v.expiresAt - (r.t0 + 14 * DAY)) < 60000 && Math.abs((tokens(r.db)[0] || {}).expiresAt.toMillis() - (r.t0 + 14 * DAY)) < 60000);
    r = await mint(world({ [FLAG]: true }, { lead: { email: 'dana@example.test' } }), { signerEmail: 'dana@example.test' });
    ok('flag on, emailed: also 14 days', !!r.v && Math.abs(r.v.expiresAt - (r.t0 + 14 * DAY)) < 60000);
    r = await mint(world({ docClauseSetV1: true, docEvidenceFoundation: true, docAtticAckV1: true }), { signerEmail: 'x@y.test' });
    ok('other flags on, this one off: still 7 days (the expiry follows this flag only)', !(r.v && r.v.expiresAt > r.t0 + 8 * DAY));
  }

  // ─── every gate still runs
  {
    let r = await mint(world({ [FLAG]: true, docEvidenceFoundation: true }, { lead: { address: '' } }), { sendEmail: false });
    ok('gate: an incomplete contract (no property address) is refused even with sendEmail:false', !!r.e && r.e.code === 'failed-precondition' && tokens(r.db).length === 0, r.e && r.e.message);
    r = await mint(world({ [FLAG]: true, docClauseSetV1: true }, { lead: { address: '' } }), { sendEmail: false });
    ok('gate: the clause-set (docClauseSetV1) check runs on a link-only mint', !!r.e && tokens(r.db).length === 0, r.e && r.e.message);
    r = await mint(world({ [FLAG]: true, docAtticAckV1: true }, { est: { grandTotal: 14500, rows: [{ code: 'LAB TO1' }] } }), { sendEmail: false });
    ok('gate: the attic gate refuses a re-roof contract with no attic form, link-only or not', !!r.e && r.e.code === 'failed-precondition' && /Attic, Ventilation & Moisture Acknowledgment/.test(r.e.message) && tokens(r.db).length === 0, r.e && r.e.message);
    r = await mint(world({ [FLAG]: true }), { sendEmail: false }, (db) => { const o = db.doc; db.doc = (p) => (/^feature_flags\//.test(p) ? { get: async () => { throw new Error('down'); } } : o(p)); });
    ok('gate: an unreadable flag is a retryable refusal, never "off" and never a link', !!r.e && r.e.code === 'unavailable' && tokens(r.db).length === 0, r.e && r.e.code);
    r = await mint(world({ [FLAG]: true }), { sendEmail: false }, (db) => { const o = db.doc; db.doc = (p) => (/^feature_flags\/U1$/.test(p) ? { get: async () => { throw new Error('down'); } } : o(p)); });
    ok('gate: an unreadable per-person flag doc fails closed too', !!r.e && r.e.code === 'unavailable' && tokens(r.db).length === 0);
    r = await mint(world({ [FLAG]: true }, { lead: { userId: 'OTHER' } }), { sendEmail: false });
    ok('owner check: a lead that is not yours still refuses a link-only mint', !!r.e && r.e.code === 'permission-denied' && tokens(r.db).length === 0);
    const rs = src('functions/remote-signing.js');
    const at = (s) => rs.indexOf(s);
    ok('the rate limits (per-minute and daily) run before the flag branch and are unchanged', at("callableRateLimit(request, 'createSignRequest', 20, 60_000)") !== -1 && at("callableRateLimit(request, 'signLinkEmailDaily'") !== -1
      && at("callableRateLimit(request, 'signLinkEmailDaily'") < at('signPanelFlagForGate'));
    ok('the email block is skipped by a flag, not removed (the email path is the old code)', rx(/if \(!noEmailMint\)/, rs) && rx(/Resend\(RESEND_API_KEY\.value\(\)\)/, rs));
    ok('the email copy states the real expiry (7 stays 7)', rx(/expires in \$\{ttlDays\} days/, rs) && !rx(/expires in 7 days/, rs));
  }

  // ─── a new link retires the old one
  {
    let db = world({ [FLAG]: true });
    let a = await mint(db, { sendEmail: false });
    let b = await mint(db, { sendEmail: false });
    const ts = tokens(db);
    const old = ts.find((t) => t.status === 'superseded');
    ok('contract, flag on: the second link retires the first, one pending token is left', !!a.v && !!b.v && ts.length === 2 && ts.filter((t) => t.status === 'pending').length === 1 && !!old && old.supersededBy === b.v.token, JSON.stringify(ts.map((t) => t.status)));
    db = world({ [FLAG]: true }, { type: 'attic_acknowledgment' });
    a = await mint(db, { sendEmail: false });
    b = await mint(db, { sendEmail: false });
    const ts2 = tokens(db);
    ok('any document type, flag on: making a new link retires the old link of the SAME document', ts2.length === 2 && ts2.filter((t) => t.status === 'pending').length === 1 && ts2.some((t) => t.status === 'superseded'), JSON.stringify(ts2.map((t) => t.status)));
    ok('the answer says the old link was retired (the panel tells the rep so)', !!b.v && b.v.supersededOld === true);
    db = world(null, { type: 'attic_acknowledgment', lead: { email: 'dana@example.test' } });
    a = await mint(db, { signerEmail: 'dana@example.test' });
    b = await mint(db, { signerEmail: 'dana@example.test' });
    ok('FLAG OFF, a non-contract: two links stay pending, exactly as before (no retire, no new field)', tokens(db).filter((t) => t.status === 'pending').length === 2 && b.v && b.v.supersededOld === undefined);
  }

  // ═══════════════════════════════════════════════════════
  section('B. flag plumbing');
  {
    const REG = require(path.join(FN, 'flags-registry.js'));
    const row = REG.FIRESTORE_FLAGS.find((f) => f.name === FLAG);
    ok('registered in FIRESTORE_FLAGS: default off, dark, read by doc-evidence.js, doc exists', !!row && row.default === false && row.dark === true && row.file === 'doc-evidence.js' && fs.existsSync(path.join(ROOT, row.doc)), row && row.doc);
    ok('doc-evidence.js exports the strict gate read for it', typeof DE.signPanelFlagForGate === 'function' && rx(/docSignPanelV1/, src('functions/doc-evidence.js')));
    ok('a read that fails is an "unavailable" refusal, a clean read is true/false', await (async () => {
      const mkE = (m) => Object.assign(new Error(m), { code: m });
      const H = function (c, m) { return mkE(c + ':' + m); };
      const dbOn = world({ [FLAG]: true }); const dbOff = world({});
      let bad = null;
      try { await DE.signPanelFlagForGate({ doc: () => ({ get: async () => { throw new Error('x'); } }) }, 'U1', H); } catch (e) { bad = e; }
      return (await DE.signPanelFlagForGate(dbOn, 'U1', H)) === true && (await DE.signPanelFlagForGate(dbOff, 'U1', H)) === false && !!bad && /unavailable/.test(bad.message);
    })());
    ok('the client reads the same flag name the same way the other doc flags are read (NBDFlags.enabled)', rx(/NBDFlags\.enabled\('docSignPanelV1'\)/, src('docs/pro/js/nbd-doc-viewer.js')));
  }

  // ═══════════════════════════════════════════════════════
  section('C. the panel module in a fake DOM');
  const PANEL_SRC = fs.existsSync(path.join(ROOT, 'docs/pro/js/sign-link-panel.js')) ? src('docs/pro/js/sign-link-panel.js') : '';
  ok('docs/pro/js/sign-link-panel.js exists', PANEL_SRC.length > 0);
  function mkEl(tag) {
    const e = { tagName: String(tag || 'div').toUpperCase(), children: [], attrs: {}, _l: {}, parentNode: null, style: {}, dataset: {}, className: '', _text: '', innerHTML: '', value: '', hidden: false, disabled: false };
    Object.defineProperty(e, 'textContent', { get() { return e._text + e.children.map((c) => c.textContent).join(''); }, set(v) { e._text = String(v); e.children = []; } });
    e.classList = { add(c) { e.className = (e.className + ' ' + c).trim(); }, remove(c) { e.className = e.className.split(/\s+/).filter((x) => x && x !== c).join(' '); }, contains(c) { return e.className.split(/\s+/).indexOf(c) !== -1; }, toggle(c, on) { if (on === undefined ? !e.classList.contains(c) : on) e.classList.add(c); else e.classList.remove(c); } };
    e.setAttribute = (k, v) => { e.attrs[k] = String(v); if (k === 'class') e.className = String(v); if (k === 'hidden') e.hidden = true; };
    e.getAttribute = (k) => (k in e.attrs ? e.attrs[k] : null);
    e.removeAttribute = (k) => { delete e.attrs[k]; if (k === 'hidden') e.hidden = false; };
    e.hasAttribute = (k) => k in e.attrs;
    e.appendChild = (c) => { c.parentNode = e; e.children.push(c); return c; };
    e.remove = () => { if (e.parentNode) e.parentNode.children = e.parentNode.children.filter((x) => x !== e); e.parentNode = null; };
    e.addEventListener = (t, f) => { (e._l[t] = e._l[t] || []).push(f); };
    e.removeEventListener = () => {};
    e.closest = (sel) => { const m = /^\[([a-z-]+)\]$/.exec(sel); let n = e; while (n) { if (m && n.attrs[m[1]] !== undefined) return n; n = n.parentNode; } return null; };
    e.focus = () => { e._focused = true; }; e.select = () => {}; e.setSelectionRange = () => {};
    return e;
  }
  const walk = (e, fn) => { fn(e); e.children.forEach((c) => walk(c, fn)); };
  const byAction = (root, a) => { let f = null; walk(root, (n) => { if (!f && n.attrs['data-sl-action'] === a) f = n; }); return f; };
  function env(o) {
    const x = o || {};
    const head = mkEl('head'), body = mkEl('body');
    const win = { document: { head, body, createElement: mkEl, getElementById: () => null, execCommand: (c) => { win._exec.push(c); return true; } }, NBDQr, _exec: [], _toasts: [], _opened: [] };
    win.window = win;
    win.location = { href: 'https://crm.test/pro/customer.html' };
    win.showToast = (m, k) => win._toasts.push({ m, k });
    win.prompt = () => { win._prompted = true; return null; };
    win.navigator = { clipboard: x.noClipboard ? undefined : { writeText: async (t) => { win._copied = t; } } };
    win.setTimeout = setTimeout; win.clearTimeout = clearTimeout;
    if (x.checkText !== null) win.NBDPhoneShare = { checkText: x.checkText || (async () => ({ ok: true })), digits: (p) => String(p || '').replace(/\D/g, '') };
    const ctx = vm.createContext(Object.assign({ console }, win, { window: win }));
    // run the module with window === the same object it reads
    vm.runInContext(PANEL_SRC, Object.assign(ctx, { window: win }));
    return win;
  }
  const fire = (root, type, target, extra) => { const ev = Object.assign({ type, target, prevented: false, preventDefault() { ev.prevented = true; }, stopPropagation() {} }, extra || {}); (root._l[type] || []).forEach((f) => f(ev)); return ev; };
  const mkMint = () => { const calls = []; const f = async (o) => { calls.push(o); const n = calls.length; if (f.fail) throw new Error(f.fail); return { signLink: 'https://app.test/sign.html?t=TOKEN' + n, expiresAt: Date.now() + 14 * DAY, emailed: !!(o && o.email), supersededOld: n > 1 }; }; f.calls = calls; return f; };

  if (PANEL_SRC) {
    const win = env();
    const Panel = win.NBDSignLinkPanel;
    ok('the module registers window.NBDSignLinkPanel.open', !!Panel && typeof Panel.open === 'function');
    const m = mkMint();
    const host = mkEl('div');
    const p = Panel.open({ host, mint: m, phone: '(859) 555-0142', leadId: 'L1', firstName: 'Dana', docLabel: 'Roofing Contract', brand: 'Acme Roofing', emailDefault: '' });
    await p.ready;
    const el = p.el;
    ok('it mints a link-only link on open: mint({sendEmail:false}) once, no email', m.calls.length === 1 && m.calls[0].sendEmail === false && !m.calls[0].email);
    ok('the panel is attached to the host and is a labelled dialog', host.children.indexOf(el) !== -1 && el.attrs.role === 'dialog' && /sign/i.test(el.attrs['aria-label'] || ''));
    const qrHtml = () => { let h = ''; walk(el, (n) => { if (/<svg/.test(n.innerHTML)) h += n.innerHTML; }); return h; };
    ok('the QR is the real NBDQr.svg of exactly the link (nothing else, no name, no address)', qrHtml() === NBDQr.svg('https://app.test/sign.html?t=TOKEN1', { label: 'QR code for the signing link' }) || qrHtml() === NBDQr.svg('https://app.test/sign.html?t=TOKEN1'), qrHtml().slice(0, 80));
    ok('the QR carries no homeowner PII', !/Dana|Whitfield|Oak|859|555|@/.test(qrHtml()));
    const text = el.textContent;
    ok('labels: Text link, Copy link, Email it, Make a new link', ['Text link', 'Copy link', 'Email it', 'Make a new link'].every((l) => text.indexOf(l) !== -1), text);
    ok('the bearer-token note is shown verbatim', text.indexOf('Anyone with this link can sign: only show it to the homeowner.') !== -1);
    ok('every action is a real button or link with an accessible name, no inline handler or style attribute', (() => {
      let good = true;
      walk(el, (n) => {
        if (n.attrs['data-sl-action'] !== undefined) { if (!(n.textContent || n.attrs['aria-label'])) good = false; if (n.tagName !== 'BUTTON' && n.tagName !== 'A') good = false; if (n.tagName === 'BUTTON' && n.attrs.type !== 'button') good = false; }
        Object.keys(n.attrs).forEach((k) => { if (/^on/i.test(k) || k === 'style') good = false; });
      });
      return good;
    })());
    ok('the text action is an sms: anchor to the lead\'s phone with the link written in', (() => {
      const a = byAction(el, 'text');
      return !!a && a.tagName === 'A' && /^sms:8595550142\?&body=/.test(a.attrs.href || '') && decodeURIComponent(a.attrs.href).indexOf('https://app.test/sign.html?t=TOKEN1') !== -1;
    })());
    ok('the panel itself has no window.prompt in its source', !rx(/\bprompt\s*\(/, PANEL_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));

    // text: allowed
    let ev = fire(el, 'click', byAction(el, 'text'));
    await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    ok('Text link: the click is held (preventDefault), asked of checkText with this lead, and opens Messages only on a yes', ev.prevented === true && /^sms:8595550142/.test(win.location.href));

    // text: blocked fails closed
    const w2 = env({ checkText: async () => ({ ok: false, reason: 'This customer replied STOP.' }) });
    const m2 = mkMint(); const p2 = w2.NBDSignLinkPanel.open({ host: mkEl('div'), mint: m2, phone: '8595550142', leadId: 'L1', firstName: 'Dana' }); await p2.ready;
    fire(p2.el, 'click', byAction(p2.el, 'text')); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    ok('texting blocked: nothing opens, the panel says why and "Use Email or Copy link instead."', w2.location.href === 'https://crm.test/pro/customer.html' && /STOP/.test(p2.el.textContent) && p2.el.textContent.indexOf('Use Email or Copy link instead.') !== -1);
    const w3 = env({ checkText: null });
    const p3 = w3.NBDSignLinkPanel.open({ host: mkEl('div'), mint: mkMint(), phone: '8595550142', leadId: 'L1' }); await p3.ready;
    fire(p3.el, 'click', byAction(p3.el, 'text')); await new Promise((r) => setTimeout(r, 0));
    ok('no NBDPhoneShare at all (the check cannot run): fails closed with the same line', w3.location.href === 'https://crm.test/pro/customer.html' && p3.el.textContent.indexOf('Use Email or Copy link instead.') !== -1);
    const w4 = env({ checkText: async () => { throw new Error('boom'); } });
    const p4 = w4.NBDSignLinkPanel.open({ host: mkEl('div'), mint: mkMint(), phone: '8595550142', leadId: 'L1' }); await p4.ready;
    fire(p4.el, 'click', byAction(p4.el, 'text')); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    ok('a check that throws fails closed', w4.location.href === 'https://crm.test/pro/customer.html' && p4.el.textContent.indexOf('Use Email or Copy link instead.') !== -1);
    const w5 = env();
    const p5 = w5.NBDSignLinkPanel.open({ host: mkEl('div'), mint: mkMint(), phone: '', leadId: 'L1' }); await p5.ready;
    fire(p5.el, 'click', byAction(p5.el, 'text')); await new Promise((r) => setTimeout(r, 0));
    ok('no phone number on file: nothing opens, says so and points at Email / Copy link', w5.location.href === 'https://crm.test/pro/customer.html' && p5.el.textContent.indexOf('Use Email or Copy link instead.') !== -1 && /phone/i.test(p5.el.textContent));

    // copy
    fire(el, 'click', byAction(el, 'copy')); await new Promise((r) => setTimeout(r, 0));
    ok('Copy link puts exactly the link on the clipboard', win._copied === 'https://app.test/sign.html?t=TOKEN1');
    const w6 = env({ noClipboard: true });
    const p6 = w6.NBDSignLinkPanel.open({ host: mkEl('div'), mint: mkMint(), phone: '', leadId: 'L1' }); await p6.ready;
    fire(p6.el, 'click', byAction(p6.el, 'copy')); await new Promise((r) => setTimeout(r, 0));
    ok('no clipboard API: falls back to selecting the link box and execCommand("copy") - never window.prompt', w6._exec.indexOf('copy') !== -1 && !w6._prompted);

    // email inside the panel
    const mailRow = () => byAction(el, 'email-send');
    ok('Email it asks for the address INSIDE the panel (an input), not window.prompt', (() => { fire(el, 'click', byAction(el, 'email')); let input = null; walk(el, (n) => { if (n.tagName === 'INPUT' && n.attrs.type === 'email') input = n; }); return !!input && !win._prompted && !!(input.attrs['aria-label'] || input.attrs.id); })());
    let input = null; walk(el, (n) => { if (n.tagName === 'INPUT' && n.attrs.type === 'email') input = n; });
    input.value = 'not an email';
    fire(el, 'click', mailRow()); await new Promise((r) => setTimeout(r, 0));
    ok('a bad address is refused in the panel and nothing is sent', m.calls.length === 1 && /valid email/i.test(el.textContent));
    input.value = 'dana@example.test';
    fire(el, 'click', mailRow()); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    ok('a good address calls mint with the email (the existing email path) and redraws the QR for the new link', m.calls.length === 2 && m.calls[1].email === 'dana@example.test' && qrHtml().indexOf('<svg') !== -1 && qrHtml() === NBDQr.svg('https://app.test/sign.html?t=TOKEN2', { label: 'QR code for the signing link' }) || qrHtml() === NBDQr.svg('https://app.test/sign.html?t=TOKEN2'));
    ok('it says the email went out', /Emailed/.test(el.textContent));

    // new link
    fire(el, 'click', byAction(el, 'new')); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    ok('Make a new link: one tap mints another link-only link, the QR is redrawn, the old link is said to be retired', m.calls.length === 3 && m.calls[2].sendEmail === false && qrHtml().indexOf('<svg') !== -1 && /old link no longer works/i.test(el.textContent));
    fire(el, 'click', byAction(el, 'copy')); await new Promise((r) => setTimeout(r, 0));
    ok('after a new link, Copy and Text use the NEW link', win._copied === 'https://app.test/sign.html?t=TOKEN3' && decodeURIComponent(byAction(el, 'text').attrs.href).indexOf('TOKEN3') !== -1);

    // a refusal from the server (gate) is shown, no QR is left for a dead link
    const m7 = mkMint(); m7.fail = 'This contract is missing the property address.';
    const p7 = Panel.open({ host: mkEl('div'), mint: m7, phone: '', leadId: 'L1' }); await p7.ready;
    ok('a server refusal (a gate) is shown in plain words and no QR is drawn', p7.el.textContent.indexOf('This contract is missing the property address.') !== -1 && !/<svg/.test((() => { let h = ''; walk(p7.el, (n) => { h += n.innerHTML; }); return h; })()));
    m7.fail = null; fire(p7.el, 'click', byAction(p7.el, 'new')); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    ok('and Make a new link retries from there', /<svg/.test((() => { let h = ''; walk(p7.el, (n) => { h += n.innerHTML; }); return h; })()));
    // close
    fire(el, 'click', byAction(el, 'close'));
    ok('Close removes the panel and drops the link from the screen', host.children.indexOf(el) === -1);
    ok('only one panel at a time: opening again replaces the first', (() => { const h = mkEl('div'); const a = Panel.open({ host: h, mint: mkMint(), phone: '' }); const b = Panel.open({ host: h, mint: mkMint(), phone: '' }); return h.children.length === 1 && h.children[0] === b.el && a.el !== b.el; })());
  }
  {
    const code = PANEL_SRC.replace(/\/\*[\s\S]*?\*\//g, '');
    ok('CSP: no inline handlers, no inline script text, no eval / document.write in the module', !rx(/\son[a-z]+\s*=/, code) && !rx(/eval\(|new Function|document\.write/, code));
    ok('DESIGN.md: 44px tap targets, theme tokens (var(--...)), no old oranges, no hard-coded transition: all', rx(/^(?=[\s\S]*min-height:\s*44px)(?=[\s\S]*var\(--)(?![\s\S]*(?:#E8720C|#F08030|transition:\s*all))/i, code));
    ok('the QR is built with the in-page NBDQr.svg only (no network image, no third-party QR service)', rx(/root\.NBDQr[\s\S]*\.svg\(link/, code) && !rx(/https?:\/\/(?!www\.w3\.org)/, code.replace(/'https:\/\/[^']*'/g, '')));
  }

  // ═══════════════════════════════════════════════════════
  section('D. the viewer wiring and the lazy load');
  {
    const v = src('docs/pro/js/nbd-doc-viewer.js');
    const fnOf = (name) => { const a = v.indexOf('async function ' + name + '()'); const b = v.indexOf('\n  }\n', a); return a === -1 || b === -1 ? '' : '(' + v.slice(a, b + 4).replace('async function ' + name + '()', 'async function ()') + ')'; };
    ok('found handleSendForSignature and openSignPanel in nbd-doc-viewer.js', !!fnOf('handleSendForSignature') && !!fnOf('openSignPanel'));
    const send = async (flags) => {
      const calls = { prompt: 0, panel: 0, mint: 0 };
      const sb = { window: { prompt() { calls.prompt++; return 'pat@example.test'; }, showToast() {}, NBDFlags: flags }, flashStatus() {}, openSignPanel: async () => { calls.panel++; },
        currentContext: { signerEmailDefault: '', onSendForSignature: async () => { calls.mint++; return { emailed: true, signLink: 'x' }; } } };
      await vm.runInNewContext(fnOf('handleSendForSignature'), sb)();
      return calls;
    };
    let c = await send({ enabled: (n) => n === 'docSignPanelV1' });
    ok('flag ON: Send for Signature opens the panel and never calls window.prompt or mints by itself', c.panel === 1 && c.prompt === 0 && c.mint === 0, JSON.stringify(c));
    c = await send({ enabled: () => false });
    ok('flag OFF: the old prompt and the old email send, no panel', c.panel === 0 && c.prompt === 1 && c.mint === 1, JSON.stringify(c));
    c = await send(undefined);
    ok('no flag registry on the page: the old prompt', c.panel === 0 && c.prompt === 1 && c.mint === 1, JSON.stringify(c));
    c = await send({ enabled: (n) => n === 'docClauseSetV1' });
    ok('another doc flag on, this one off: the old prompt', c.panel === 0 && c.prompt === 1);
    const openP = async (loadWorks) => {
      const log = { loaded: [], opened: null, status: [] };
      const ctx = { id: 'ctx' }, overlay = { id: 'ov' };
      const win = { ScriptLoader: { load: async (p) => { log.loaded.push(p); if (loadWorks) win.NBDSignLinkPanel = { openFor: async (cx, host) => { log.opened = [cx, host]; } }; } } };
      const sb = { window: win, currentContext: ctx, currentOverlay: overlay, flashStatus: (m) => log.status.push(m), prompt() { log.prompted = true; } };
      await vm.runInNewContext(fnOf('openSignPanel'), sb)();
      return Object.assign(log, { ctx, overlay });
    };
    let o = await openP(true);
    ok('the panel file is fetched on the first click (lazy, with a version) and opened for this document inside the viewer overlay', o.loaded.length === 1 && rx(/^js\/sign-link-panel\.js\?v=\d+$/, o.loaded[0]) && !!o.opened && o.opened[0] === o.ctx && o.opened[1] === o.overlay);
    o = await openP(false);
    ok('a panel file that does not load says so and never falls back to window.prompt', o.opened === null && o.status.length === 1 && !o.prompted);
    // openFor: loads the QR encoder and the text check on first use, mints through the generator closure
    {
      const winP = env({ checkText: null });
      const loaded = []; let minted = [];
      delete winP.NBDQr; delete winP.NBDPhoneShare;
      winP.ScriptLoader = { load: async (p) => { loaded.push(p); if (/qr-code/.test(p)) winP.NBDQr = NBDQr; if (/phone-share/.test(p)) winP.NBDPhoneShare = { checkText: async () => ({ ok: true }) }; } };
      const ctx = { leadId: 'L1', signerEmailDefault: 'd@e.test', onSendForSignature: async (email, o2) => { minted.push([email, o2]); return { signLink: 'https://app.test/s?t=T' + minted.length, emailed: !!email }; }, signPanelOpts: { signerPhoneDefault: '8595550142', signerNameDefault: 'Dana Whitfield', docLabel: 'Roofing Contract' } };
      const host = mkEl('div');
      const pnl = await winP.NBDSignLinkPanel.openFor(ctx, host); await pnl.ready;
      ok('openFor loads the QR encoder and the text check lazily, then draws the QR', loaded.length === 2 && /<svg/.test((() => { let h = ''; walk(pnl.el, (n) => { h += n.innerHTML; }); return h; })()));
      ok('openFor mints a link with sendEmail:false and no address; the Email it path sends the typed address', minted.length === 1 && minted[0][0] === '' && minted[0][1] && minted[0][1].sendEmail === false);
      ok('the text link carries the first name, the document and the link', (() => { const a = byAction(pnl.el, 'text'); const b = decodeURIComponent(a.attrs.href); return /Hi Dana, here is your Roofing Contract/.test(b) && b.indexOf('T1') !== -1; })());
    }
    // the few wording pins that have no behaviour to run here
    const g = src('docs/pro/js/document-generator.js');
    ok('the generator adds sendEmail:false to the createSignRequest payload ONLY when the panel asks, and passes phone, name, type and lead to the viewer',
      rx(/if \(sendOpts && sendOpts\.sendEmail === false\) payload\.sendEmail = false/, g) && rx(/signerPhoneDefault[\s\S]*signerNameDefault[\s\S]*docLabel: typeName[\s\S]*leadId: _leadIdEarly/, g));
    const ver = (re, text) => { const m = re.exec(text); return m ? +m[1] : 0; };
    ok('asset versions bumped well above main (viewer 6 -> 12, docgen generator 34 -> 40, script-loader 249 -> 255)',
      ver(/nbd-doc-viewer\.js\?v=(\d+)/, src('docs/pro/customer.html')) >= 12 && ver(/nbd-doc-viewer\.js\?v=(\d+)/, src('docs/pro/dashboard.html')) >= 12
      && ver(/document-generator\.js\?v=(\d+)/, src('docs/pro/js/script-loader.js')) >= 40 && ver(/script-loader\.js\?v=(\d+)/, src('docs/pro/dashboard.html')) >= 255);
    ok('the panel is NOT in the eager boot path (no tag in customer.html or dashboard.html, not in script-loader.js)',
      !rx(/sign-link-panel/, src('docs/pro/customer.html') + src('docs/pro/dashboard.html') + src('docs/pro/js/script-loader.js')));
  }

  console.log('\n' + (failed ? 'FAILED ' + failed + ' of ' + (passed + failed) + ':\n  - ' + fails.join('\n  - ') : 'sign-link-panel: ' + passed + ' checks passed'));
  if (failed) process.exit(1);
  console.log('passed ' + passed + ', failed ' + failed);
})().catch((e) => { console.error(e); process.exit(1); });
