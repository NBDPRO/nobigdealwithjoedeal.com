/**
 * tests/estimate-funnel-unblock-2026-10-03.test.js
 *
 * The /estimate instant-estimate funnel produced 3 leads EVER (newest in April)
 * and web forms 2 leads in 60 days, while the Twilio account is a trial that
 * has delivered 0 texts. The funnel kept Submit disabled until a texted code
 * was verified. This suite pins the unblock, by BEHAVIOUR (the real shipped
 * scripts run in a vm against a small fake DOM; the real gateway / alert /
 * bridge modules run with Firebase stubbed):
 *
 *   1. OTP off: Submit enables on first name + 10-digit phone + consent
 *      (last name + email optional); the OTP path still works behind the flag.
 *   2. The server (submitPublicLead) accepts an estimate lead with no OTP
 *      token, Joe's alert fires and the CRM card maps, on the required fields.
 *   3. Per-step GA4 events: funnel_step {step, step_name}, and
 *      funnel_address_unmatched when step 1's lookup finds nothing / fails.
 *   4. Step 1: "Use my address as typed" skips the satellite step; no
 *      Nominatim call per keystroke (blur / Continue only, once per string).
 *   5. OTP autofill (autocomplete="one-time-code") spreads across the boxes.
 *   6. The optional "help Joe prepare" answers move to the thank-you screen
 *      and are saved onto the same lead (updatePublicLeadIntake, grant-gated,
 *      the gateway's own allowlist).
 *   7. public-lead-submit.js: Turnstile preloads on first field focus; a failed
 *      submit shows "Call or text Joe" with tel: + sms: (never on /sites/t/).
 *   8. Trust line above every listed form's Submit, rating hydrated live.
 *   9. Home hero: an Instant-estimate button that stays visible on phones.
 *
 * NEVER posts anywhere: every network call is a stub (memory: an emulator
 * submitPublicLead once texted + emailed Jo for real). Synthetic data only,
 * 555-01xx numbers.
 *
 * Run: node tests/estimate-funnel-unblock-2026-10-03.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); failed++; fails.push(label); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

// ─────────────────────────────────────────────────────────────────────────
// A small fake DOM — enough for the wizard / helper / widget to run for real.
// ─────────────────────────────────────────────────────────────────────────
function makeDom() {
  const byId = new Map();
  const docListeners = {};
  function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
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
    get childElementCount() { return this.children.length + (this.innerHTML ? 1 : 0); }
    get isConnected() { return true; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v); if (k === 'class') this.className = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener() {}
    fire(t, ev) { (this.listeners[t] || []).forEach((fn) => fn.call(this, Object.assign({ target: this, preventDefault() {} }, ev || {}))); }
    appendChild(n) { n._parent = this; this.children.push(n); return n; }
    insertBefore(n) { return this.appendChild(n); }
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
  const head = new El('head');
  const body = new El('body');
  const document = {
    head, body, readyState: 'complete', activeElement: null,
    getElementById(id) { if (!byId.has(id)) byId.set(id, new El('div', id)); return byId.get(id); },
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
    fire(t, ev) { (docListeners[t] || []).forEach((fn) => fn(Object.assign({ preventDefault() {} }, ev))); },
  };
  return { document, El, byId, head, body };
}

(async () => {
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n1. the wizard — OTP off, the required fields, Submit');
  // ═══════════════════════════════════════════════════════════════════════
  const WIZ = read('docs/assets/js/inline/4053149b2f.js');
  function loadWizard(opts) {
    const o = opts || {};
    const { document, El } = makeDom();
    // Mirror the shipped markup's starting state.
    document.getElementById('btnSubmit').disabled = true;
    const events = [];
    const fetches = [];
    const ctx = {
      document, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, URLSearchParams, JSON, Math, Date,
      location: { pathname: '/estimate', search: '' },
      scrollTo() {},
      // Leaflet (the satellite map) — inert stand-in.
      L: { map: () => ({}), tileLayer: () => ({ addTo() {} }), divIcon: () => ({}), marker: () => ({ addTo() {} }) },
      gtag: (kind, name, params) => { if (kind === 'event') events.push({ name, params }); },
      fetch: async (url, init) => {
        fetches.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
        if (o.fetch) return o.fetch(String(url), init);
        return { ok: false, json: async () => ({}) };
      },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(WIZ + '\n;globalThis.__t = { get funnelData() { return funnelData; }, get currentStep() { return currentStep; }, CONFIG: CONFIG };', ctx, { filename: 'wizard.js' });
    return { ctx, document, El, events, fetches, t: ctx.__t };
  }

  {
    const W = loadWizard();
    ok('the text-code check ships OFF (CONFIG.OTP_ENABLED === false)', W.t.CONFIG.OTP_ENABLED === false);
    const d = W.document;
    const fill = (fn, ph, consent, extra) => {
      d.getElementById('firstName').value = fn;
      d.getElementById('lastName').value = (extra && extra.ln) || '';
      d.getElementById('emailAddress').value = (extra && extra.email) || '';
      d.getElementById('phoneNumber').value = ph;
      d.getElementById('tcpaConsent').checked = consent;
      d.getElementById('phoneNumber').fire('input');
      d.getElementById('tcpaConsent').fire('change');
      return !d.getElementById('btnSubmit').disabled;
    };
    ok('first name + phone + consent → Submit ENABLED (no last name, no email, no code)', fill('Pat', '5135550100', true) === true);
    ok('...and the phone input formats as typed', d.getElementById('phoneNumber').value === '(513) 555-0100');
    ok('no consent → Submit disabled', fill('Pat', '5135550100', false) === false);
    ok('no first name → Submit disabled', fill('', '5135550100', true) === false);
    ok('a 9-digit phone → Submit disabled', fill('Pat', '513555010', true) === false);
    ok('an email that is typed must look like one ("pat@") → disabled', fill('Pat', '5135550100', true, { email: 'pat@' }) === false);
    ok('a real optional email + last name → enabled', fill('Pat', '5135550100', true, { email: 'pat@example.test', ln: 'Example' }) === true);
    ok('the Send Code button and skip link are hidden while OTP is off', d.getElementById('btnSendCode').hidden === true && d.getElementById('otpSkip').hidden === true);

    // The OTP path is kept behind the flag.
    const W2 = loadWizard();
    W2.t.CONFIG.OTP_ENABLED = true;
    W2.ctx._applyOtpMode();
    const d2 = W2.document;
    d2.getElementById('firstName').value = 'Pat';
    d2.getElementById('phoneNumber').value = '5135550100';
    d2.getElementById('tcpaConsent').checked = true;
    d2.getElementById('tcpaConsent').fire('change');
    ok('flag ON: Submit stays disabled until the phone is verified (code path kept)', d2.getElementById('btnSubmit').disabled === true);
    ok('flag ON: the Send Code button and skip link come back', d2.getElementById('btnSendCode').hidden === false && d2.getElementById('otpSkip').hidden === false);
  }

  {
    // Submit with only the required fields: what reaches _saveLead / _notifyJoe.
    const W = loadWizard();
    const d = W.document;
    const saves = [], notes = [];
    W.ctx._saveLead = async (lead) => { saves.push(lead); W.ctx._lastPhotoToken = 'a'.repeat(48); return 'lead-1'; };
    W.ctx._notifyJoe = async (p) => { notes.push(p); };
    W.ctx.NBDIntake = { html: () => '<fieldset></fieldset>', read: () => ({ fields: {}, files: [] }), afterSubmit: async () => {} };
    W.t.funnelData.address = '12 Test St, Mason, OH';
    W.t.funnelData.service = 'roof-repair';
    d.getElementById('firstName').value = 'Pat';
    d.getElementById('phoneNumber').value = '(513) 555-0100';
    d.getElementById('tcpaConsent').checked = true;
    d.getElementById('tcpaConsent').fire('change');
    await W.ctx.submitAndGetEstimate();
    ok('Submit sends the lead with only the required fields (no scheduling choice demanded)', saves.length === 1 && saves[0].firstName === 'Pat' && saves[0].phone === '(513) 555-0100' && saves[0].tcpaConsent === true, saves[0]);
    ok('...asks for the follow-up grant (wantsFollowUp)', saves[0] && saves[0].wantsFollowUp === true);
    ok('...carries no intake answers up front', saves[0] && !('scheduling' in saves[0]) && !('bestTime' in saves[0]));
    // notifyNewLead is no longer called from the funnel (H3, 2026-10-05) —
    // Joe's alert is leadAlertEstimate on the saved doc; see
    // estimate-funnel-lost-lead-banner-2026-10-05.test.js.
    ok('...and no notifyNewLead call (Joe is alerted by the estimate_leads trigger)', notes.length === 0, notes.length);
    await tick(900);
    ok('the results screen shows the optional "help Joe prepare" block (lead saved, grant held)', d.getElementById('estFollowUp').hidden === false && d.getElementById('estIntake').innerHTML.length > 0);
    ok('a funnel_step for the results screen fires', W.events.some((e) => e.name === 'funnel_step' && e.params.step === 6 && e.params.step_name === 'results'));

    // The thank-you screen's optional answers → updatePublicLeadIntake with the grant.
    W.ctx.NBDIntake.read = (root, p, o) => ({ fields: { scheduling: 'contact_me', bestTime: 'Evening' }, files: [], _o: o });
    const after = [];
    W.ctx.NBDIntake.afterSubmit = async (box, info) => { after.push(info); };
    W.fetches.length = 0;
    const btn = new W.El('button');
    W.ctx.fetch = async (url, init) => { W.fetches.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ success: true }) }; };
    await W.ctx.saveFollowUp(btn);
    const post = W.fetches.find((f) => /\/updatePublicLeadIntake$/.test(f.url));
    ok('the optional answers POST to updatePublicLeadIntake with the one-time grant', !!post && post.body.token === 'a'.repeat(48) && post.body.scheduling === 'contact_me' && post.body.bestTime === 'Evening', W.fetches);
    ok('...then afterSubmit runs (calendar / photos) with the same grant', after.length === 1 && after[0].photoToken === 'a'.repeat(48));
    ok('...and the button confirms', btn.textContent === 'Sent ✓');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n2. step 1 — the address dead end, Nominatim usage, step analytics');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const W = loadWizard({ fetch: async (url) => ({ ok: true, json: async () => (/nominatim/.test(url) ? [] : {}) }) });
    const d = W.document;
    const inp = d.getElementById('addressInput');
    ok('funnel_step {step:1, step_name:"address"} fires when the wizard starts', W.events.some((e) => e.name === 'funnel_step' && e.params.step === 1 && e.params.step_name === 'address'));
    for (const v of ['1', '12', '12 N', '12 No', '12 Nowh', '12 Nowhere', '12 Nowhere Rd']) { inp.value = v; inp.fire('input'); }
    await tick(600);
    ok('typing never calls Nominatim (no autocomplete-per-keystroke)', W.fetches.filter((f) => /nominatim/.test(f.url)).length === 0, W.fetches.map((f) => f.url));
    inp.fire('blur');
    await tick(500);
    ok('leaving the field looks the address up ONCE', W.fetches.filter((f) => /nominatim/.test(f.url)).length === 1);
    inp.fire('blur');
    await tick(500);
    W.ctx.goToStep(2);
    await tick(20);
    ok('the same string is never re-asked (blur again + Continue reuse the answer)', W.fetches.filter((f) => /nominatim/.test(f.url)).length === 1, W.fetches.length);
    const ev = W.events.find((e) => e.name === 'funnel_address_unmatched');
    ok('no match → funnel_address_unmatched {reason:"no_match"}', !!ev && ev.params.reason === 'no_match', W.events);
    const useBtn = d.getElementById('addressHint').querySelector('[data-action="useTypedAddress"]');
    ok('no match → a "Use my address as typed" button is offered', !!useBtn && /as typed/.test(useBtn.textContent));
    d.fire('click', { target: useBtn });
    ok('using it skips the satellite step (step 3 is next)', W.t.currentStep === 3, W.t.currentStep);
    ok('...keeps the typed address, with no coordinates', W.t.funnelData.address === '12 Nowhere Rd' && W.t.funnelData.lat === null && W.t.funnelData.lon === null);
    ok('...and emits funnel_step {step:3, step_name:"project"}', W.events.some((e) => e.name === 'funnel_step' && e.params.step === 3 && e.params.step_name === 'project'));
    W.ctx.goToStep(2);
    ok('Back from step 3 returns to the address (no map to confirm)', W.t.currentStep === 1);

    const W2 = loadWizard({ fetch: async () => { throw new Error('offline'); } });
    W2.document.getElementById('addressInput').value = '9 Lost Ln, Batavia OH';
    W2.ctx.goToStep(2);
    await tick(20);
    const ev2 = W2.events.find((e) => e.name === 'funnel_address_unmatched');
    ok('a lookup ERROR also offers "as typed" (reason:"lookup_error")', !!ev2 && ev2.params.reason === 'lookup_error' && !!W2.document.getElementById('addressHint').querySelector('[data-action="useTypedAddress"]'));

    const W3 = loadWizard({ fetch: async () => ({ ok: true, json: async () => ([{ display_name: '5 Real St, Mason, OH', lat: '39.36', lon: '-84.31' }]) }) });
    W3.document.getElementById('addressInput').value = '5 Real St Mason';
    W3.ctx.goToStep(2);
    await tick(150);
    ok('a match still goes to the satellite step, with coordinates', W3.t.currentStep === 2 && W3.t.funnelData.lat === 39.36, W3.t.currentStep);
    ok('...emitting funnel_step {step:2, step_name:"confirm_home"}', W3.events.some((e) => e.name === 'funnel_step' && e.params.step === 2 && e.params.step_name === 'confirm_home'));
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n3. OTP autofill (autocomplete="one-time-code")');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const W = loadWizard();
    const calls = [];
    W.ctx._verifyOTP = async (phone, code) => { calls.push(code); return { success: true }; };
    const boxes = W.document.querySelectorAll('.otp-input');
    boxes[0].value = '481516';
    boxes[0].fire('input');
    await tick(5);
    // Each box must hold ONE digit — the joined string alone would also match
    // the bug (all six digits stuck in box 1).
    ok('a whole autofilled code in box 1 is spread across all six boxes', boxes.map((b) => b.value).join(',') === '4,8,1,5,1,6', boxes.map((b) => b.value));
    ok('...and verification runs once with the full code', calls.length === 1 && calls[0] === '481516', calls);
    const html = read('docs/estimate.html');
    const first = (html.match(/<input[^>]*class="otp-input"[^>]*>/) || [''])[0];
    ok('the first box carries autocomplete="one-time-code" and accepts 6 characters', /autocomplete="one-time-code"/.test(first) && /maxlength="6"/.test(first), first);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n4. the server — no OTP required; alert + CRM on the required fields');
  // ═══════════════════════════════════════════════════════════════════════
  async function gateway(body) {
    const added = [], grants = [];
    const stubs = {
      'firebase-functions/v2/https': { onRequest: (o, h) => ({ __handler: h }), onCall: (o, h) => ({ __handler: h }), HttpsError: Error },
      'firebase-admin/firestore': {
        getFirestore: () => ({
          collection: (name) => ({
            add: async (row) => { added.push({ name, row }); return { id: 'pub-1' }; },
            doc: (id) => ({ get: async () => ({ exists: false }), set: async (d) => { grants.push({ name, id, d }); } }),
          }),
        }),
        FieldValue: { serverTimestamp: () => '__ts__', increment: (n) => ({ operand: n }) },
      },
      '../integrations/upstash-ratelimit': { enforceRateLimit: async () => ({}), httpRateLimit: async () => true, clientIp: () => '198.51.100.9', provider: 'stub' },
      '../integrations/turnstile': { verifyTurnstile: async () => ({ ok: true, configured: false }) },
    };
    const real = Module._load;
    Module._load = function (request) { return Object.prototype.hasOwnProperty.call(stubs, request) ? stubs[request] : real.apply(this, arguments); };
    const file = path.join(ROOT, 'functions', 'handlers', 'integrations.js');
    const plp = path.join(ROOT, 'functions', 'public-lead-photos.js');
    delete require.cache[file]; delete require.cache[plp];
    let mod;
    try { mod = require(file); } finally { Module._load = real; }
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
    // The photo grant module is required lazily inside the handler — stub its Firestore too.
    Module._load = function (request) { return Object.prototype.hasOwnProperty.call(stubs, request) ? stubs[request] : real.apply(this, arguments); };
    try { await mod.submitPublicLead.__handler({ method: 'POST', headers: { referer: 'https://nobigdealwithjoedeal.com/estimate' }, body }, res); }
    finally { Module._load = real; delete require.cache[file]; delete require.cache[plp]; }
    return { res, added, grants };
  }
  const MIN = { kind: 'estimate', address: '12 Test St, Mason, OH', source: 'estimate-funnel-v2', firstName: 'Pat', phone: '(513) 555-0100', tcpaConsent: true, phoneVerified: false, wantsFollowUp: true };
  {
    const { res, added, grants } = await gateway(MIN);
    ok('submitPublicLead accepts an estimate lead with NO OTP token (200)', res.code === 200 && res.body && res.body.success === true, res);
    ok('...writes it with first name + phone + consent', added.length === 1 && added[0].name === 'estimate_leads' && added[0].row.firstName === 'Pat' && added[0].row.phone === '(513) 555-0100' && added[0].row.tcpaConsent === true);
    ok('...and returns the one-time follow-up grant (wantsFollowUp)', /^[a-f0-9]{48}$/.test((res.body || {}).photoToken || '') && grants.some((g) => g.name === 'public_lead_photo_grants' && g.d.collection === 'estimate_leads' && g.d.publicId === 'pub-1'));
    const S = require(path.join(ROOT, 'functions', 'handlers', 'integrations.js'))._publicLeadSpec;
    const req = S.PUBLIC_LEAD_KINDS.estimate.required;
    ok('the estimate kind requires nothing OTP-shaped (address + source only)', req.join() === 'address,source' && !/otp|verif/i.test(JSON.stringify(S.PUBLIC_LEAD_KINDS.estimate)));
    const { res: r2, grants: g2 } = await gateway(Object.assign({}, MIN, { wantsFollowUp: undefined }));
    ok('no grant when the page does not ask for one', r2.code === 200 && !r2.body.photoToken && g2.length === 0);

    // Joe's alert on exactly that document (lead-alert.js, real; Twilio/Resend stubbed — nothing is sent).
    const rec = { emails: [], sms: [] };
    const aStubs = {
      'firebase-functions/v2/firestore': { onDocumentCreated: (o, h) => ({ __handler: h }) },
      'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'test-' + name }) },
      'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
      resend: { Resend: class { constructor() { this.emails = { send: async (p) => { rec.emails.push(p); return { data: { id: 'em' }, error: null }; } }; } } },
      twilio: () => ({ messages: { create: async (p) => { rec.sms.push(p); return { sid: 'SM' }; } } }),
      'firebase-admin/firestore': {
        FieldValue: { serverTimestamp: () => '__ts__' },
        getFirestore: () => ({ collection: () => ({ add: async () => ({ id: 'x' }), doc: () => ({ get: async () => ({ exists: false }), update: async () => {} }) }) }),
      },
    };
    const real = Module._load;
    Module._load = function (request) { return Object.prototype.hasOwnProperty.call(aStubs, request) ? aStubs[request] : real.apply(this, arguments); };
    const LAF = path.join(ROOT, 'functions', 'lead-alert.js');
    delete require.cache[LAF];
    try {
      const LA = require(LAF);
      await LA.leadAlertEstimate.__handler({ data: { data: () => added[0].row }, params: { leadId: 'pub-1' } });
    } finally { Module._load = real; delete require.cache[LAF]; }
    const joeSms = rec.sms.find((m) => /lead/.test(m.body || ''));
    ok("Joe's alert fires on the required fields alone (SMS names Pat + the phone)", !!joeSms && /Pat/.test(joeSms.body) && /555-0100/.test(joeSms.body), rec.sms.map((m) => m.body));
    ok("...and the alert email goes out too", rec.emails.some((e) => /New lead/.test(e.subject || '') && /Pat/.test(e.subject)));

    const B = require(path.join(ROOT, 'functions', 'lead-bridge-logic.js'));
    const lead = B.mapPublicLeadToLead({ collection: 'estimate_leads', sourceId: 'pub-1', ownerUid: 'o', companyId: 'o', data: added[0].row });
    ok('the CRM card maps from the same document (name, phone, phoneDigits, address)', lead.firstName === 'Pat' && lead.lastName === '' && lead.phoneDigits === '5135550100' && lead.address === '12 Test St, Mason, OH');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n5. updatePublicLeadIntake — the thank-you answers, onto the same lead');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const PLP = require(path.join(ROOT, 'functions', 'public-lead-photos.js'))._internal;
    const B = require(path.join(ROOT, 'functions', 'lead-bridge-logic.js'));
    function fakeDb(seed) {
      const store = new Map(Object.entries(seed || {}));
      const apply = (prev, patch) => {
        const out = Object.assign({}, prev || {});
        for (const [k, v] of Object.entries(patch)) {
          if (v && typeof v === 'object' && 'operand' in v) out[k] = (out[k] || 0) + v.operand;
          else out[k] = v;
        }
        return out;
      };
      const ref = (c, id) => {
        const key = c + '/' + id;
        return {
          key,
          get: async () => ({ exists: store.has(key), data: () => store.get(key) }),
          set: async (d, o) => { store.set(key, o && o.merge ? apply(store.get(key), d) : apply({}, d)); },
          update: async (d) => { if (!store.has(key)) throw new Error('NOT_FOUND'); store.set(key, apply(store.get(key), d)); },
        };
      };
      return {
        store,
        collection: (c) => ({ doc: (id) => ref(c, id) }),
        runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, d) => r.update(d) }),
      };
    }
    const TOKEN = 'b'.repeat(48);
    const GKEY = PLP.GRANTS + '/' + PLP.hashToken(TOKEN);
    const live = () => ({ collection: 'estimate_leads', publicId: 'pub-1', exp: Date.now() + 60_000, max: 10, used: 0 });
    const crmKey = 'leads/' + B.bridgeDocId('estimate_leads', 'pub-1');

    let db = fakeDb({ [GKEY]: live(), 'estimate_leads/pub-1': { firstName: 'Pat' }, [crmKey]: { notes: 'Instant Estimate — roof-repair' } });
    let out = await PLP.saveIntakeUpdate(db, { token: TOKEN, scheduling: 'calendar', bestTime: 'Evening', insuranceClaim: 'bogus', howHeard: 'Yard sign', leadScore: '99' });
    ok('a valid grant saves the answers (200, CRM updated)', out.status === 200 && out.json.crm === true, out);
    const pub = db.store.get('estimate_leads/pub-1');
    ok('...onto the SAME public lead', pub.scheduling === 'calendar' && pub.bestTime === 'Evening' && pub.howHeard === 'Yard sign' && pub.firstName === 'Pat');
    ok('...through the gateway allowlist: an off-list enum and a foreign key are dropped', !('insuranceClaim' in pub) && !('leadScore' in pub));
    const crm = db.store.get(crmKey);
    ok('...and onto the bridged CRM card: note lines appended + schedulingPreference', /Instant Estimate/.test(crm.notes) && /booking a time on the calendar/.test(crm.notes) && /Best time to reach: Evening/.test(crm.notes) && crm.schedulingPreference === 'calendar');
    ok('the grant counts the save', db.store.get(GKEY).intakeUpdates === 1);

    out = await PLP.saveIntakeUpdate(db, { token: TOKEN, insuranceClaim: 'nope' });
    ok('nothing valid to save → 400', out.status === 400);
    out = await PLP.saveIntakeUpdate(db, { token: 'zz', scheduling: 'calendar' });
    ok('a malformed token → 400', out.status === 400);
    out = await PLP.saveIntakeUpdate(fakeDb({}), { token: TOKEN, scheduling: 'calendar' });
    ok('an unknown grant → 404', out.status === 404);
    out = await PLP.saveIntakeUpdate(fakeDb({ [GKEY]: Object.assign(live(), { exp: Date.now() - 1 }) }), { token: TOKEN, scheduling: 'calendar' });
    ok('an expired grant → 410 with the call/text fallback', out.status === 410 && /420-7382/.test(out.json.error));
    out = await PLP.saveIntakeUpdate(fakeDb({ [GKEY]: Object.assign(live(), { intakeUpdates: PLP.INTAKE_MAX_UPDATES }) }), { token: TOKEN, scheduling: 'calendar' });
    ok('more than ' + PLP.INTAKE_MAX_UPDATES + ' saves per grant → 429', out.status === 429);
    out = await PLP.saveIntakeUpdate(fakeDb({ [GKEY]: Object.assign(live(), { collection: 'guide_leads' }) }), { token: TOKEN, scheduling: 'calendar' });
    ok('a grant for a non-service collection → refused', out.status === 400);

    const waits = [];
    db = fakeDb({ [GKEY]: live(), 'estimate_leads/pub-1': {} });
    out = await PLP.saveIntakeUpdate(db, { token: TOKEN, scheduling: 'contact_me' }, { wait: async (ms) => { waits.push(ms); } });
    ok('CRM card not bridged yet → waits, retries, and NEVER creates one (the bridge must own the create)', out.status === 200 && out.json.crm === false && waits.length === 2 && !db.store.has(crmKey), { waits, crm: out.json.crm });

    const idx = read('functions/index.js');
    ok('the endpoint is exported', /exports\.updatePublicLeadIntake\s*=\s*require\('\.\/public-lead-photos'\)\.updatePublicLeadIntake/.test(idx));
    ok('...and documented', /`updatePublicLeadIntake` \| onRequest/.test(read('functions/FUNCTIONS_INDEX.md')));

    // intake-extras: optional mode for the thank-you screen.
    const ctx = { window: {}, document: { querySelector: () => ({}), getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ setAttribute() {} }), readyState: 'loading', addEventListener() {} }, URLSearchParams };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(read('docs/assets/js/intake-extras.js'), ctx);
    const root = (picked) => ({ querySelector: (s) => (/:checked/.test(s) ? picked : (/Photos/.test(s) ? { files: [] } : null)) });
    ok('NBDIntake.read(…, {optional:true}) with no scheduling choice → no error, no field', (() => { const r = ctx.NBDIntake.read(root(null), 'estI', { optional: true }); return !r.error && !('scheduling' in r.fields); })());
    ok('NBDIntake.read without the option still REQUIRES the choice (every other form)', !!ctx.NBDIntake.read(root(null), 'x').error);
    ok('optional mode drops the required star from the legend', !/nbd-intake-req/.test(ctx.NBDIntake.html('estI', { optional: true })) && /nbd-intake-req/.test(ctx.NBDIntake.html('x')));
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n6. public-lead-submit.js — Turnstile preload, call/text fallback');
  // ═══════════════════════════════════════════════════════════════════════
  const PLS = read('docs/assets/js/public-lead-submit.js');
  function loadHelper(o) {
    const { document, El, head } = makeDom();
    const ctx = {
      document, console, setTimeout, clearTimeout, Promise, JSON,
      location: { pathname: o.path || '/storm-check' },
      fetch: o.fetch || (async () => { throw new Error('offline'); }),
    };
    if ('key' in o) ctx.__NBD_TURNSTILE_SITEKEY = o.key;
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(PLS, ctx);
    return { ctx, document, El, head };
  }
  {
    const H = loadHelper({});
    ok('nothing loads before the visitor touches a form', H.head.children.filter((s) => /turnstile/.test(s.src || '')).length === 0);
    const f = new H.El('input'); f.type = 'text';
    H.document.fire('focusin', { target: f });
    ok('the FIRST field focus starts the Turnstile script download', H.head.children.filter((s) => /challenges\.cloudflare\.com\/turnstile/.test(s.src || '')).length === 1);
    H.document.fire('focusin', { target: f });
    ok('...once (a second focus adds nothing)', H.head.children.filter((s) => /turnstile/.test(s.src || '')).length === 1);
    const H0 = loadHelper({});
    const btn = new H0.El('button'); btn.type = 'submit';
    H0.document.fire('focusin', { target: btn });
    ok('focusing a button is not a form field (no preload)', H0.head.children.length === 0);

    // Failure fallback: key '' opts out of Turnstile so the submit is immediate.
    const H2 = loadHelper({ key: '' });
    const form = new H2.El('form');
    const field = new H2.El('input'); field.type = 'tel';
    form.appendChild(field);
    H2.document.fire('focusin', { target: field });
    const r = await H2.ctx.submitPublicLead('inspect', { name: 'Pat', phone: '5135550100', address: '1 A St', source: '/storm-check' });
    const fb = form.querySelector('.nbd-lead-fallback');
    ok('a failed submit still reports ok:false to the page', r.ok === false);
    ok('...and shows "Call or text Joe — (859) 420-7382" under the form', !!fb && /Call or text Joe/.test(fb.textContent) && /\(859\) 420-7382/.test(fb.textContent), fb && fb.textContent);
    const links = fb ? fb.children.filter((c) => c.tagName === 'A').map((a) => a.href) : [];
    ok('...with a tel: AND an sms: link to the site number', links.includes('tel:+18594207382') && links.includes('sms:+18594207382'), links);
    await H2.ctx.submitPublicLead('inspect', {});
    ok('...once (a second failure does not stack another)', form.querySelectorAll('.nbd-lead-fallback').length === 1);

    const H3 = loadHelper({ key: '', fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: 'x' }) }) });
    const form3 = new H3.El('form'); const f3 = new H3.El('input'); f3.type = 'text'; form3.appendChild(f3);
    H3.document.fire('focusin', { target: f3 });
    await H3.ctx.submitPublicLead('contact', {});
    ok('a server error (non-2xx) shows the same fallback', !!form3.querySelector('.nbd-lead-fallback'));

    const H4 = loadHelper({ key: '', path: '/sites/t/' });
    const form4 = new H4.El('form'); const f4 = new H4.El('input'); f4.type = 'text'; form4.appendChild(f4);
    H4.document.fire('focusin', { target: f4 });
    await H4.ctx.submitPublicLead('contact', {});
    ok("a tenant microsite (/sites/t/) never shows NBD's number", !form4.querySelector('.nbd-lead-fallback'));

    const site = read('docs/index.html');
    ok('the fallback number matches the site (tel:+18594207382 on the homepage)', /href="tel:\+18594207382"/.test(site) && /\(859\) 420-7382/.test(site));
    ok('the quick form loads the gateway client on first focus (so its preload runs early)', /form\.addEventListener\('focusin', function \(\) \{ ensureGateway\(\)/.test(read('docs/assets/js/quick-lead-form.js')));
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n7. trust line above every listed form + live rating');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const TL = /<p class="(?:nbd-trust-line|qlf-trust)"><span aria-hidden="true">&#9733;<\/span> <span data-nbd-gr-rating>5\.0<\/span> on Google &middot; (?:Fully insured|Licensed &amp; insured) &middot; Joe on every roof<\/p>/;
    // 2026-10-05: "Fully insured" (Jo has no OH/KY registration number to back
    // "Licensed"). docs/index.html keeps the old line until the home-page PR
    // lands; tests/homeowner-claims-honesty-2026-10-05.test.js bans it elsewhere.
    const pages = [
      ['docs/estimate.html', 'id="btnSubmit"'],
      ['docs/storm-check.html', 'id="sc-submit"'],
      ['docs/storm-alerts.html', 'id="alertSignupBtn"'],
      ['docs/inspect.html', 'id="inspectSubmit"'],
      ['docs/index.html', 'id="leadFormSubmit"'],
    ];
    for (const [p, submitId] of pages) {
      const h = read(p);
      const m = TL.exec(h);
      const iSub = h.indexOf(submitId);
      ok(p.replace('docs/', '/') + ': the trust line sits directly above Submit', !!m && iSub > m.index && iSub - m.index < 400, m ? (iSub - m.index) : 'no line');
      ok(p.replace('docs/', '/') + ': loads google-reviews-widget.js so the rating is live', /<script[^>]*src="\/assets\/js\/google-reviews-widget\.js"[^>]*><\/script>/.test(h));
    }
    const q = read('docs/assets/js/quick-lead-form.js');
    const iT = q.search(TL), iB = q.indexOf("'<button class=\"qlf-btn\" type=\"submit\"");
    ok('the service/area quick form (JS-built on 185 generated pages) renders the line above its Submit', iT > 0 && iB > iT && iB - iT < 400);
    ok('...and hydrates the rating (widget hook or a one-time load)', /hydrateRating\(\);/.test(q) && /nbdHydrateReviewHooks/.test(q));
    const hosts = fs.readdirSync(path.join(ROOT, 'docs', 'areas')).filter((f) => f.endsWith('.html')).map((f) => read('docs/areas/' + f)).filter((h) => /data-nbd-quick-form/.test(h) && /quick-lead-form\.js/.test(h)).length;
    ok('generated area pages still host the quick form (> 20)', hosts > 20, hosts);
    ok('Kentucky wording: the line makes no claim-handling promise', !/claim|insurance|deductible|negotiat/i.test('★ 5.0 on Google · Fully insured · Joe on every roof'));

    // The widget hydrates hooks on a page WITHOUT the review cards.
    const { document, El } = makeDom();
    const hook = new El('span'); hook.setAttribute('data-nbd-gr-rating', ''); hook.textContent = '5.0';
    document.body.appendChild(hook);
    const ctx = { document, console, fetch: async () => ({ ok: true, json: async () => ({ rating: 4.9, total: 31 }) }) };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(read('docs/assets/js/google-reviews-widget.js'), ctx);
    await tick(10);
    ok('google-reviews-widget hydrates a trust-line rating on a page with no review cards', hook.textContent === '4.9', hook.textContent);
    const late = new El('span'); late.setAttribute('data-nbd-gr-rating', ''); late.textContent = '5.0';
    document.body.appendChild(late);
    ctx.nbdHydrateReviewHooks();
    ok('...and re-hydrates hooks rendered later (the JS-built quick form)', late.textContent === '4.9');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n8. home hero — an Instant-estimate button that phones keep');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const h = read('docs/index.html');
    const btns = (h.match(/<div class="hero-btns">([\s\S]*?)<\/div>/) || [])[1] || '';
    ok('the hero buttons hold "Call Joe" then an Instant-estimate link to /estimate', /href="tel:\+18594207382"[\s\S]*href="\/estimate" class="btn-ghost hero-btn-estimate"/.test(btns), btns.slice(0, 200));
    ok('/estimate exists to link to', fs.existsSync(path.join(ROOT, 'docs', 'estimate.html')));
    const mq = h.slice(h.indexOf('.hero-btns .btn-ghost{display:none}'));
    ok('phones hide the other secondary buttons but SHOW this one, full width', /\.hero-btns \.btn-ghost\.hero-btn-estimate\{display:inline-flex;width:100%;justify-content:center\}/.test(mq.slice(0, 600)));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
