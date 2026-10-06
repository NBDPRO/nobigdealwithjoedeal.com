/**
 * tests/estimate-funnel-lost-lead-banner-2026-10-05.test.js
 *
 * H3 (2026-10-05): the public /estimate funnel could lose a lead and still
 * show the homeowner the success screen.
 *
 *   - window._notifyJoe (f95015cb84.module.js) caught its own error and never
 *     threw, so the wizard's `_joeNotified = true` / `notified = true` ALWAYS
 *     ran and `_leadDeliveryFailed` (= !saved && !notified) was never true.
 *   - The callable it wrapped, notifyNewLead, has enforceAppCheck:true and
 *     /estimate never initialises App Check → it 401'd on every submit. Joe is
 *     alerted by the leadAlertEstimate Firestore trigger on estimate_leads
 *     instead, so "notified" never meant anything.
 *
 * The fix bases delivered/failed on the lead actually being SAVED, and drops
 * the dead notifyNewLead call from the funnel. This suite runs the real
 * shipped wizard in a vm against a small fake DOM (pattern from
 * estimate-funnel-unblock-2026-10-03.test.js) with every network call stubbed.
 *
 * Synthetic data only (555-01xx). Never posts anywhere.
 *
 * Run: node tests/estimate-funnel-lost-lead-banner-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); failed++; fails.push(label); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

// Ids the shipped markup does NOT contain — the wizard must create them. Every
// other id auto-materialises (the real page has them).
const ABSENT = new Set(['leadDeliveryFail']);

function makeDom() {
  const byId = new Map();
  const docListeners = {};
  class ClassList {
    constructor() { this.s = new Set(); }
    add(...c) { c.forEach((x) => this.s.add(x)); }
    remove(...c) { c.forEach((x) => this.s.delete(x)); }
    contains(c) { return this.s.has(c); }
    toggle(c, f) { const on = f === undefined ? !this.s.has(c) : !!f; if (on) this.s.add(c); else this.s.delete(c); return on; }
  }
  class El {
    constructor(tag, id) {
      this.tagName = String(tag || 'div').toUpperCase();
      this.id = id || '';
      this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.type = '';
      this.style = {}; this.dataset = {}; this.attrs = {}; this.children = []; this.listeners = {};
      this._text = ''; this.innerHTML = ''; this.className = ''; this.classList = new ClassList();
      this._parent = null; this.offsetParent = {};
    }
    get textContent() { return this._text + this.children.map((c) => (c.textContent || '')).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    get parentElement() { if (!this._parent) { this._parent = new El('div'); this._parent.children.push(this); } return this._parent; }
    get parentNode() { return this.parentElement; }
    get firstChild() { return this.children[0] || null; }
    get childElementCount() { return this.children.length + (this.innerHTML ? 1 : 0); }
    get isConnected() { return true; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener() {}
    fire(t, ev) { (this.listeners[t] || []).forEach((fn) => fn.call(this, Object.assign({ target: this, preventDefault() {} }, ev || {}))); }
    appendChild(n) { n._parent = this; this.children.push(n); return n; }
    insertBefore(n, ref) {
      n._parent = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i === -1) this.children.push(n); else this.children.splice(i, 0, n);
      return n;
    }
    focus() {} scrollIntoView() {} click() {}
    getClientRects() { return [1]; }
    matches(sel) {
      if (sel.indexOf(',') !== -1) return sel.split(',').some((s) => this.matches(s.trim()));
      const classes = (this.className + ' ' + [...this.classList.s].join(' ')).split(/\s+/).filter(Boolean);
      const re = /(\.[\w-]+)|(\[([\w-]+)(?:="([^"]*)")?\])|(^[a-z]+)/gi;
      let m, any = false;
      while ((m = re.exec(sel))) {
        any = true;
        if (m[1] && !classes.includes(m[1].slice(1))) return false;
        if (m[2] && !(m[3] in this.attrs && (m[4] === undefined || this.attrs[m[3]] === m[4]))) return false;
        if (m[5] && this.tagName !== m[5].toUpperCase()) return false;
      }
      return any;
    }
    closest(sel) { let n = this; for (let i = 0; n && i < 8; i++) { if (n.matches(sel)) return n; n = n._parent; } return null; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => n.children.forEach((c) => { if (c.matches(sel)) out.push(c); walk(c); });
      walk(this);
      return out;
    }
  }
  function findDeep(id) {
    let hit = null;
    const walk = (n) => { for (const c of n.children) { if (hit) return; if (c.id === id) { hit = c; return; } walk(c); } };
    for (const e of byId.values()) { walk(e); if (hit) break; }
    return hit;
  }
  const head = new El('head');
  const body = new El('body');
  const document = {
    head, body, readyState: 'complete', activeElement: null,
    getElementById(id) {
      if (ABSENT.has(id)) return findDeep(id);
      if (!byId.has(id)) byId.set(id, new El('div', id));
      return byId.get(id);
    },
    createElement(tag) { return new El(tag); },
    createTextNode(t) { const n = new El('#text'); n._text = String(t); return n; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      if (sel === '.step') return ['step1', 'step2', 'step3', 'step4', 'step5', 'stepLoading', 'stepResults'].map((i) => this.getElementById(i));
      if (sel === '.otp-input') return [0, 1, 2, 3, 4, 5].map((i) => this.getElementById('otp' + i));
      const all = [...byId.values()].filter((e) => e.matches(sel));
      return all.concat(head.querySelectorAll(sel), body.querySelectorAll(sel));
    },
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener() {},
  };
  return { document, El };
}

const WIZ = read('docs/assets/js/inline/4053149b2f.js');

// saveResult: what each _saveLead call resolves to (the real one resolves the
// lead id, or null on failure). The _notifyJoe stub models the OLD shipped
// helper exactly: it swallows its own error and always resolves.
function loadWizard(saveResult) {
  const { document, El } = makeDom();
  document.getElementById('btnSubmit').disabled = true;
  document.getElementById('estFollowUp').hidden = true; // as shipped: <div id="estFollowUp" hidden>
  const saves = [], notes = [];
  const ctx = {
    document, console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, URLSearchParams, JSON, Math, Date,
    location: { pathname: '/estimate', search: '' },
    scrollTo() {},
    L: { map: () => ({}), tileLayer: () => ({ addTo() {} }), divIcon: () => ({}), marker: () => ({ addTo() {} }) },
    gtag() {},
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  };
  ctx.window = ctx;
  ctx._saveLead = async (lead) => { saves.push(lead); if (saveResult) ctx._lastPhotoToken = 'a'.repeat(48); return saveResult; };
  ctx._notifyJoe = async (p) => { notes.push(p); };
  ctx.NBDIntake = { html: () => '<fieldset></fieldset>', read: () => ({ fields: {}, files: [] }), afterSubmit: async () => {} };
  vm.createContext(ctx);
  vm.runInContext(WIZ + '\n;globalThis.__t = { get funnelData() { return funnelData; } };', ctx, { filename: 'wizard.js' });
  const d = document;
  ctx.__t.funnelData.address = '12 Test St, Mason, OH';
  ctx.__t.funnelData.service = 'roof-repair';
  d.getElementById('firstName').value = 'Pat';
  d.getElementById('phoneNumber').value = '(513) 555-0100';
  d.getElementById('tcpaConsent').checked = true;
  d.getElementById('tcpaConsent').fire('change');
  return { ctx, document: d, El, saves, notes };
}

(async () => {
  console.log('\n1. Submit — both lead saves fail');
  {
    const W = loadWizard(null);
    await W.ctx.submitAndGetEstimate();
    await tick(900);
    const leadSaves = W.saves.filter((x) => !x.type);
    ok('the lead save was retried once (2 attempts)', leadSaves.length === 2, leadSaves.length);
    ok('_leadDeliveryFailed is TRUE when the lead never saved', W.ctx._leadDeliveryFailed === true, W.ctx._leadDeliveryFailed);
    const results = W.document.getElementById('stepResults');
    ok('the results step is the one showing', results.classList.contains('active'));
    const banner = W.document.getElementById('leadDeliveryFail');
    ok('the call-Joe banner is rendered inside the results step', !!banner && banner._parent === results && results.children[0] === banner);
    ok('...visible (not display:none) and announced (role=alert)', !!banner && banner.style.display !== 'none' && banner.getAttribute('role') === 'alert');
    ok('...with a tel: and an sms: link to Joe', !!banner && /href="tel:\+18594207382"/.test(banner.innerHTML) && /href="sms:\+18594207382"/.test(banner.innerHTML));
    ok('the optional follow-up block is never mounted (nothing to save it against)', W.document.getElementById('estIntake').innerHTML === '');
    ok('no notifyNewLead call from Submit (it 401s without App Check)', W.notes.length === 0, W.notes.length);
  }

  console.log('\n2. Submit — the lead saves');
  {
    const W = loadWizard('lead-1');
    await W.ctx.submitAndGetEstimate();
    await tick(900);
    const leadSaves = W.saves.filter((x) => !x.type);
    ok('one lead save, no retry', leadSaves.length === 1, leadSaves.length);
    ok('_leadDeliveryFailed is false', W.ctx._leadDeliveryFailed === false, W.ctx._leadDeliveryFailed);
    ok('no call-Joe banner', W.document.getElementById('leadDeliveryFail') === null);
    ok('the optional follow-up block shows', W.document.getElementById('estFollowUp').hidden === false);
  }

  console.log('\n3. OTP-skip "just have Joe call me" — both saves fail / one lands');
  {
    const W = loadWizard(null);
    const btn = new W.El('button');
    await W.ctx.skipOtpAndRequestCall(btn);
    const st = W.document.getElementById('otpSkipStatus');
    ok('a failed save is NOT reported as "Request sent"', btn.textContent !== 'Request sent ✓', btn.textContent);
    ok('...it tells the homeowner to call or text Joe', /call or text Joe/.test(st.textContent) && /error/.test(st.className), st.textContent);
    ok('...and the button is usable again', btn.disabled === false);

    const W2 = loadWizard('lead-2');
    const btn2 = new W2.El('button');
    await W2.ctx.skipOtpAndRequestCall(btn2);
    ok('a saved request confirms "Request sent"', btn2.textContent === 'Request sent ✓', btn2.textContent);
    ok('neither path calls notifyNewLead', W.notes.length === 0 && W2.notes.length === 0);
  }

  console.log('\n4. the dead notifyNewLead call is gone from the funnel (comments stripped)');
  {
    const wiz = stripComments(WIZ);
    const mod = stripComments(read('docs/assets/js/inline/f95015cb84.module.js'));
    ok('the wizard never calls _notifyJoe', !/_notifyJoe/.test(wiz));
    ok('the estimate module no longer wires notifyNewLead', !/notifyNewLead|_notifyJoe/.test(mod));
    ok('the delivered/failed flag is derived from _leadSaved alone', /window\._leadDeliveryFailed\s*=\s*!_leadSaved\s*;/.test(wiz));
    // The alert Joe actually gets: leadAlertEstimate on estimate_leads, which
    // only skips the follow-up EVENT docs (type set) — the lead doc has none.
    const alert = read('functions/lead-alert.js');
    ok('leadAlertEstimate fires on estimate_leads creates', /exports\.leadAlertEstimate\s*=\s*onDocumentCreated\(\{[^}]*document:\s*'estimate_leads\/\{leadId\}'/.test(alert));
    const L = require(path.join(ROOT, 'functions', 'lead-bridge-logic.js'));
    ok('...and does not skip the main lead or the OTP-skip call request', L.isFollowUpEvent('estimate_leads', {}) === false && L.isFollowUpEvent('estimate_leads', { requestType: 'otp_skipped_call_request' }) === false);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
