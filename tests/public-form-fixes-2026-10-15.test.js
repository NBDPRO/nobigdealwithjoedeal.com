/**
 * tests/public-form-fixes-2026-10-15.test.js — public form fixes from the
 * 2026-10-14 site code review (nbd-agents/reports/site-code-review-2026-10-14.md).
 *
 *   H2  generate_lead fires once per lead, not on /estimate's follow-up saves
 *   M5  the gateway POST has a client timeout, so "Sending…" ends and the
 *       call/text fallback shows
 *
 * The gateway client (docs/assets/js/public-lead-submit.js) is EXECUTED in a
 * vm sandbox with a fake fetch, gtag and timers.
 *
 * Zero deps. Run: node tests/public-form-fixes-2026-10-15.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

const CLIENT_REL = 'docs/assets/js/public-lead-submit.js';
const client = read(CLIENT_REL);

// fetchMode: 'ok' answers 200; 'stall' never answers until the signal aborts.
function loadClient({ fetchMode = 'ok' } = {}) {
  const events = [];
  const timers = new Map(); let seq = 0;
  const document = {
    head: { appendChild() {} }, body: { appendChild() {} },
    activeElement: null,
    addEventListener() {},
    createElement() { return { style: {}, dataset: {}, setAttribute() {}, appendChild() {} }; },
    createTextNode() { return {}; },
    querySelector() { return null; },
  };
  const window = {
    document,
    location: { pathname: '/estimate', hostname: 'nobigdealwithjoedeal.com' },
    AbortController,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    gtag(type, name, params) { events.push({ type, name, params }); },
    fetch(url, init) {
      if (fetchMode === 'stall') {
        return new Promise((resolve, reject) => {
          if (init.signal) init.signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted.'); e.name = 'AbortError'; reject(e);
          });
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'lead-1' }) });
    },
    console,
  };
  window.window = window;
  vm.createContext(window);
  vm.runInContext(client, window, { filename: CLIENT_REL });
  // No Turnstile key/widget on this fake page → the token step resolves ''.
  window.__NBD_TURNSTILE_SITEKEY = '';
  return { window, events, timers };
}
const tick = () => new Promise((r) => setImmediate(r));

// ── A tiny fake DOM for the quiz tools (storm-check.js, roof-score.js,
// storm-report-page.js). Supports getElementById, descendant selectors made of
// `.class`, `[attr]` and `[attr="v"]`, closest(), events, classList.
function makeDom() {
  const all = [];
  function el(tag, attrs = {}, parent = null) {
    const e = {
      tagName: tag.toUpperCase(), attrs: Object.assign({}, attrs), children: [], parentNode: null,
      style: {}, value: '', textContent: '', listeners: {}, disabled: false, checked: false,
      get id() { return this.attrs.id || ''; },
      get className() { return this.attrs.class || ''; }, set className(v) { this.attrs.class = v; },
      get dataset() { const d = {}; for (const k of Object.keys(this.attrs)) if (k.startsWith('data-')) d[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = this.attrs[k]; return d; },
      get type() { return this.attrs.type || ''; }, set type(v) { this.attrs.type = v; },
      get childElementCount() { return this.children.length; },
      classList: null,
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      appendChild(c) { c.parentNode = this; this.children.push(c); all.push(c); return c; },
      closest(sel) { let n = this; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parentNode; } return null; },
      matches(sel) { return matchCompound(this, sel); },
      querySelector(sel) { return query(sel, this)[0] || null; },
      querySelectorAll(sel) { return query(sel, this); },
      focus() {}, scrollIntoView() {},
    };
    // textContent assignment drops children, like the real DOM.
    let text = '';
    Object.defineProperty(e, 'textContent', { get() { return text + e.children.map((c) => c.textContent).join(''); }, set(v) { text = String(v); e.children = []; } });
    Object.defineProperty(e, 'innerHTML', { get() { return text; }, set(v) { text = String(v); e.children = []; } });
    const cls = () => (e.attrs.class || '').split(/\s+/).filter(Boolean);
    e.classList = {
      add(c) { const s = cls(); if (!s.includes(c)) s.push(c); e.attrs.class = s.join(' '); },
      remove(c) { e.attrs.class = cls().filter((x) => x !== c).join(' '); },
      toggle(c, force) { const has = cls().includes(c); const want = force === undefined ? !has : !!force; if (want) this.add(c); else this.remove(c); return want; },
      contains(c) { return cls().includes(c); },
    };
    if (parent) parent.appendChild(e); else all.push(e);
    return e;
  }
  function matchCompound(e, sel) {
    const parts = sel.match(/\.[\w-]+|\[[^\]]+\]/g) || [];
    if (!parts.length) return false;
    return parts.every((p) => {
      if (p[0] === '.') return e.classList.contains(p.slice(1));
      const m = p.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (!m) return false;
      return m[2] === undefined ? (m[1] in e.attrs) : e.attrs[m[1]] === m[2];
    });
  }
  function isDesc(n, root) { let p = n.parentNode; while (p) { if (p === root) return true; p = p.parentNode; } return false; }
  function query(sel, root) {
    const chain = sel.trim().split(/\s+/);
    return all.filter((n) => {
      if (root && root !== doc && !isDesc(n, root)) return false;
      if (!matchCompound(n, chain[chain.length - 1])) return false;
      let cur = n;
      for (let i = chain.length - 2; i >= 0; i--) {
        let p = cur.parentNode; while (p && !matchCompound(p, chain[i])) p = p.parentNode;
        if (!p) return false; cur = p;
      }
      return true;
    });
  }
  const docListeners = {};
  const doc = {
    readyState: 'complete', activeElement: null,
    getElementById: (id) => all.find((n) => n.id === id) || null,
    querySelector: (sel) => query(sel, doc)[0] || null,
    querySelectorAll: (sel) => query(sel, doc),
    createElement: (tag) => { const e = el(tag); all.splice(all.indexOf(e), 1); return e; },
    createTextNode: (t) => ({ textContent: t }),
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    head: { appendChild() {} }, body: { appendChild() {} },
  };
  const fire = (target, type) => {
    for (const fn of (target.listeners[type] || [])) fn.call(target, { target, key: '', preventDefault() {} });
    if (type === 'click') for (const fn of (docListeners.click || [])) fn({ target, preventDefault() {} });
  };
  return { el, doc, fire };
}

// Load one quiz tool with fake timers and a scripted fetch.
function loadTool(rel, build, { geocode = () => [] } = {}) {
  const dom = makeDom();
  const ids = build(dom.el);
  const timers = new Map(); let seq = 0;
  const fetches = [];
  const window = {
    document: dom.doc,
    location: { pathname: '/', search: '' },
    scrollTo() {},
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return 0; }, clearInterval() {},
    fetch(url) {
      fetches.push(String(url));
      if (/nominatim/.test(url)) {
        const r = geocode(url);
        if (r instanceof Error) return Promise.reject(r);
        return Promise.resolve({ ok: true, json: () => Promise.resolve(r) });
      }
      return new Promise(() => {}); // other APIs (storm data, AI) stay pending
    },
    console,
  };
  window.window = window;
  vm.createContext(window);
  vm.runInContext(read(rel), window, { filename: rel });
  const runTimers = () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } };
  const nominatimCalls = () => fetches.filter((u) => /nominatim/.test(u)).length;
  return { window, dom, ids, fetches, nominatimCalls, runTimers, fire: dom.fire, $: dom.doc.getElementById };
}
function buildQuiz(P) {
  return (el) => {
    const root = el('main');
    const step1 = el('section', { id: P + '-step1', class: 'sc-step active' }, root);
    const wrap = el('div', { class: 'sc-input-wrap' }, step1);
    el('input', { id: P + '-address' }, wrap);
    el('div', { id: P + '-acdrop' }, wrap);
    el('div', { id: P + '-addr-hint', class: 'sc-hint' }, step1);
    el('button', { class: 'sc-next', 'data-step': '2' }, step1);
    const step2 = el('section', { id: P + '-step2', class: 'sc-step' }, root);
    const group = el('div', { class: 'sc-tiles', 'data-group': 'signs' }, step2);
    for (const v of ['missing', 'dents', 'none']) el('div', { class: 'sc-tile', 'data-value': v }, group);
    el('input', { id: P + '-phone' }, root);
  };
}

(async () => {
  console.log('\nH2 — generate_lead once per lead');
  {
    const { window, events } = loadClient();
    const r1 = await window.submitPublicLead('estimate', { firstName: 'Pat', phone: '8595550100', source: 'estimate-funnel-v2' });
    ok('the lead save succeeds', r1.ok === true, r1);
    for (const type of ['estimate_result', 'cta_click', 'email_estimate_request']) {
      const r = await window.submitPublicLead('estimate', { type, source: 'estimate-funnel-v2' });
      ok(`follow-up save "${type}" still succeeds`, r.ok === true, r);
    }
    const leads = events.filter((e) => e.name === 'generate_lead');
    ok('generate_lead fired exactly once across the lead + 3 follow-up saves', leads.length === 1, leads.length);
    ok('…for the lead itself (kind estimate)', leads[0] && leads[0].params.lead_kind === 'estimate');
  }
  {
    const { window, events } = loadClient();
    await window.submitPublicLead('inspect', { name: 'Pat', phone: '8595550100', source: '/inspect' });
    ok('a normal /inspect lead still fires generate_lead', events.filter((e) => e.name === 'generate_lead').length === 1);
  }

  console.log('\nM5 — the gateway POST times out');
  {
    const { window, timers, events } = loadClient({ fetchMode: 'stall' });
    const p = window.submitPublicLead('inspect', { name: 'Pat', phone: '8595550100' });
    let settled = null; p.then((r) => { settled = r; });
    for (let i = 0; i < 5; i++) await tick();
    ok('a stalled POST has not settled yet', settled === null);
    const abortTimer = [...timers.entries()].find(([, t]) => t.ms >= 15000 && t.ms <= 30000);
    ok('a 15–30 s abort timer is armed for the POST', !!abortTimer, [...timers.values()].map((t) => t.ms));
    if (abortTimer) { timers.delete(abortTimer[0]); abortTimer[1].fn(); }
    for (let i = 0; i < 5; i++) await tick();
    ok('after the timeout the submit resolves ok:false (so the form can recover)', settled && settled.ok === false, settled);
    ok('…flagged timedOut with a plain-language reason', settled && settled.timedOut === true && /taking too long/i.test(settled.reason) && !/abort/i.test(settled.reason), settled);
    ok('…and no generate_lead fired', events.filter((e) => e.name === 'generate_lead').length === 0);
  }
  {
    const { window, timers } = loadClient();
    await window.submitPublicLead('inspect', { name: 'Pat', phone: '8595550100' });
    ok('a successful POST clears its abort timer', ![...timers.values()].some((t) => t.ms >= 15000 && t.ms <= 30000), [...timers.values()].map((t) => t.ms));
  }

  for (const [rel, P] of [['docs/assets/js/storm-check.js', 'sc'], ['docs/assets/js/roof-score.js', 'rs']]) {
    console.log(`\nH4 — ${rel}: no lookup per keystroke`);
    {
      const t = loadTool(rel, buildQuiz(P), { geocode: () => [{ display_name: '12 Elm St, Goshen, OH', lat: '39.2', lon: '-84.1' }] });
      const inp = t.$(P + '-address');
      for (const v of ['1', '12', '12 E', '12 El', '12 Elm', '12 Elm St']) { inp.value = v; t.fire(inp, 'input'); t.runTimers(); }
      await tick();
      ok('typing six characters one at a time sends no Nominatim request', t.nominatimCalls() === 0, t.nominatimCalls());
      t.fire(inp, 'blur'); t.runTimers(); await tick();
      ok('leaving the field sends exactly one lookup', t.nominatimCalls() === 1, t.nominatimCalls());
      t.fire(inp, 'blur'); t.runTimers(); await tick();
      ok('the same string is not looked up twice (per-page cache)', t.nominatimCalls() === 1, t.nominatimCalls());
      inp.value = '12 E'; t.fire(inp, 'input'); t.fire(inp, 'blur'); t.runTimers(); await tick();
      ok('under 5 characters, blur sends nothing', t.nominatimCalls() === 1, t.nominatimCalls());
    }
    console.log(`\nH3 — ${rel}: "use the address as typed" when the map finds nothing`);
    for (const [label, geocode] of [['no match', () => []], ['lookup error', () => new Error('blocked')]]) {
      const t = loadTool(rel, buildQuiz(P), { geocode });
      const inp = t.$(P + '-address'); inp.value = '4471 New Build Rd, Rural Route 2';
      t.fire(inp, 'input');
      const next = t.dom.doc.querySelector('[data-step="2"]');
      t.fire(next, 'click'); for (let i = 0; i < 4; i++) await tick();
      const hintEl = t.$(P + '-addr-hint');
      const btn = hintEl.children.find((c) => c.getAttribute && c.getAttribute('data-action') === 'useTypedAddress');
      ok(`${label}: Continue offers a "Use my address as typed" button`, !!btn && /as typed/.test(btn.textContent), hintEl.textContent);
      ok(`${label}: …and step 1 has not advanced yet`, t.$(P + '-step2').classList.contains('active') === false);
      if (btn) { t.fire(btn, 'click'); await tick(); }
      ok(`${label}: clicking it moves on to step 2`, t.$(P + '-step2').classList.contains('active') === true);
      ok(`${label}: …and the hint is cleared`, t.$(P + '-addr-hint').style.display === 'none');
    }
  }

  console.log('\nM1 — "None / not sure" clears when a real sign is picked');
  for (const [rel, P] of [['docs/assets/js/storm-check.js', 'sc'], ['docs/assets/js/roof-score.js', 'rs']]) {
    const t = loadTool(rel, buildQuiz(P));
    const tile = (v) => t.dom.doc.querySelector('[data-group="signs"] .sc-tile[data-value="' + v + '"]');
    t.fire(tile('none'), 'click');
    ok(`${rel}: tapping "none" selects it`, tile('none').classList.contains('selected'));
    t.fire(tile('missing'), 'click');
    ok(`${rel}: tapping "missing" afterwards deselects "none"`, !tile('none').classList.contains('selected') && tile('missing').classList.contains('selected'));
  }

  console.log('\nH4 — storm-report-page.js: no lookup per keystroke; Generate resolves a typed address');
  {
    const t = loadTool('docs/assets/js/storm-report-page.js', (el) => {
      const root = el('main');
      const wrap = el('div', { class: 'sr-input-wrap' }, root);
      el('input', { id: 'sr-address' }, wrap); el('div', { id: 'sr-acdrop' }, wrap);
      el('div', { id: 'sr-addr-hint' }, root);
      el('section', { id: 'sr-loading' }, root);
      el('button', { 'data-action': 'generate' }, root);
      el('input', { id: 'sr-phone' }, root);
    }, { geocode: () => [{ display_name: '12 Elm St, Goshen, OH', lat: '39.2', lon: '-84.1' }] });
    const inp = t.$('sr-address');
    for (const v of ['1', '12', '12 E', '12 El', '12 Elm', '12 Elm St']) { inp.value = v; t.fire(inp, 'input'); t.runTimers(); }
    await tick();
    ok('typing sends no Nominatim request', t.nominatimCalls() === 0, t.nominatimCalls());
    t.fire(t.dom.doc.querySelector('[data-action="generate"]'), 'click'); for (let i = 0; i < 4; i++) await tick();
    ok('Generate with a typed (unpicked) address looks it up once', t.nominatimCalls() === 1, t.nominatimCalls());
    ok('…and goes on to fetch the storm report for the top match', t.fetches.some((u) => /lat=39\.2&lon=-84\.1/.test(u)), t.fetches);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
