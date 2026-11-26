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

// ── A tiny fake DOM for the quiz tool (roof-check.js since 2026-11-25; it
// replaced storm-check.js, roof-score.js and storm-report-page.js). Supports getElementById, descendant selectors made of
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
  const fetches = [], inits = [];
  const window = {
    document: dom.doc,
    location: { pathname: '/', search: '' },
    scrollTo() {},
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return 0; }, clearInterval() {},
    AbortController,
    fetch(url, init) {
      fetches.push(String(url)); inits.push(init || {});
      if (/nominatim/.test(url)) {
        const r = geocode(url);
        if (r instanceof Error) return Promise.reject(r);
        return Promise.resolve({ ok: true, json: () => Promise.resolve(r) });
      }
      // Other APIs (storm data, AI) stall until their signal aborts, if any.
      return new Promise((resolve, reject) => {
        if (init && init.signal) init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      });
    },
    console,
  };
  window.window = window;
  vm.createContext(window);
  vm.runInContext(read(rel), window, { filename: rel });
  const runTimers = () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } };
  const nominatimCalls = () => fetches.filter((u) => /nominatim/.test(u)).length;
  return { window, dom, ids, fetches, inits, timers, nominatimCalls, runTimers, fire: dom.fire, $: dom.doc.getElementById };
}
// /roof-check: address -> the free storm history (rc-teaser) -> roof questions (rc-step3).
function buildQuiz(P) {
  return (el) => {
    const root = el('main');
    const step1 = el('section', { id: P + '-step1', class: P + '-step active' }, root);
    const wrap = el('div', { class: P + '-input-wrap' }, step1);
    el('input', { id: P + '-address' }, wrap);
    el('div', { id: P + '-acdrop' }, wrap);
    el('div', { id: P + '-addr-hint', class: P + '-hint' }, step1);
    el('button', { class: P + '-next', 'data-action': 'generate' }, step1);
    el('section', { id: P + '-loading', class: P + '-step' }, root);
    const teaser = el('section', { id: P + '-teaser', class: P + '-step' }, root);
    for (const id of ['teaser-headline', 'teaser-sub', 'teaser-chips', 'retry']) el('div', { id: P + '-' + id }, teaser);
    const step3 = el('section', { id: P + '-step3', class: P + '-step' }, root);
    const group = el('div', { class: P + '-tiles', 'data-group': 'signs' }, step3);
    for (const v of ['missing', 'dents', 'none']) el('div', { class: P + '-tile', 'data-value': v }, group);
    el('input', { id: P + '-phone' }, root);
    return root;
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

  for (const [rel, P] of [['docs/assets/js/roof-check.js', 'rc']]) {
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
      const next = t.dom.doc.querySelector('[data-action="generate"]');
      t.fire(next, 'click'); for (let i = 0; i < 4; i++) await tick();
      const hintEl = t.$(P + '-addr-hint');
      const btn = hintEl.children.find((c) => c.getAttribute && c.getAttribute('data-action') === 'useTypedAddress');
      ok(`${label}: Check offers a "Use my address as typed" button`, !!btn && /as typed/.test(btn.textContent), hintEl.textContent);
      ok(`${label}: …and step 1 has not advanced yet`, t.$(P + '-teaser').classList.contains('active') === false);
      if (btn) { t.fire(btn, 'click'); await tick(); }
      // No map point means no storm records: the honest "couldn't check" history, never a dead end.
      ok(`${label}: clicking it moves on to the storm history, which says it could not check`, t.$(P + '-teaser').classList.contains('active') === true && /couldn.t check storm records/i.test(t.$(P + '-teaser-headline').textContent), t.$(P + '-teaser-headline').textContent);
      ok(`${label}: …and the hint is cleared`, t.$(P + '-addr-hint').style.display === 'none');
    }
  }

  console.log('\nM3 — /roof-check: a stalled AI call ends at 30 s and the result shows the canned note');
  {
    const t = loadTool('docs/assets/js/roof-check.js', (el) => {
      const root = buildQuiz('rc')(el);
      for (const id of ['rc-firstName', 'rc-email', 'rc-consent', 'rc-contact-err', 'rc-submit',
        'rc-result-headline', 'rc-result-detail', 'rc-result-data', 'rc-result-take', 'rc-result-warn',
        'rc-rep-summary', 'rc-rep-rows', 'rc-rep-source', 'rc-rep-gusts', 'rc-rep-gust-list', 'rc-rep-gust-note', 'rc-rep-gust-source']) el('div', { id }, root);
      el('section', { id: 'rc-step5', class: 'rc-step' }, root);
      el('section', { id: 'rc-result', class: 'rc-step' }, root);
      el('button', { 'data-action': 'submit' }, root);
    });
    t.$('rc-firstName').value = 'Pat'; t.$('rc-phone').value = '(859) 555-0100'; t.$('rc-consent').checked = true;
    t.fire(t.dom.doc.querySelector('[data-action="submit"]'), 'click');
    for (let i = 0; i < 6; i++) await tick();
    const aiAt = t.fetches.findIndex((u) => /publicFunnelAI/.test(u));
    ok('the AI call was made', aiAt !== -1, t.fetches);
    ok('…with an abort signal', aiAt !== -1 && !!t.inits[aiAt].signal);
    const abortT = [...t.timers.values()].find((x) => x.ms === 30000);
    ok('…and a 30 s abort timer', !!abortT, [...t.timers.values()].map((x) => x.ms));
    ok('the result is not shown while the AI call is pending', !t.$('rc-result').classList.contains('active'));
    if (abortT) abortT.fn();
    for (let i = 0; i < 6; i++) await tick();
    ok('after the timeout the result screen shows', t.$('rc-result').classList.contains('active'));
    ok('…with Joe\'s canned note', /Pat, I’ll get on your roof/.test(t.$('rc-result-take').textContent), t.$('rc-result-take').textContent);
  }

  console.log('\nM3 — /estimate: _fetchAI aborts at 30 s');
  {
    const src = read('docs/assets/js/inline/4053149b2f.js');
    const at = src.indexOf('async function _fetchAI(body) {');
    ok('_fetchAI exists', at !== -1);
    if (at !== -1) {
      let depth = 0, i = src.indexOf('{', at);
      for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
      const timers = []; let signal = null;
      const ctx = {
        AbortController, CONFIG: { PROXY_URL: 'https://x.test/publicFunnelAI' },
        setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
        fetch(url, init) { signal = init.signal; return new Promise((res, rej) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })); },
      };
      vm.createContext(ctx);
      vm.runInContext(src.slice(at, i + 1), ctx);
      let outcome = null;
      ctx._fetchAI({ prompt: 'p' }).then(() => { outcome = 'resolved'; }, (e) => { outcome = e.name; });
      await tick();
      ok('the fetch carries an abort signal', !!signal);
      const t30 = timers.find((x) => x.ms === 30000);
      ok('a 30 s abort timer is armed', !!t30, timers.map((x) => x.ms));
      if (t30) t30.fn();
      await tick(); await tick();
      ok('on timeout it rejects (the caller\'s catch shows the fallback estimate)', outcome === 'AbortError', outcome);
    }
    ok('both publicFunnelAI calls go through _fetchAI (one raw fetch left, inside it)',
      (src.match(/await _fetchAI\(/g) || []).length === 2 && (src.match(/fetch\(CONFIG\.PROXY_URL/g) || []).length === 1);
  }

  // (2026-11-25) The /roof-score copy of this check went with roof-score.js; the
  // merged tool's AI timeout is the behavioural /roof-check M3 block above.

  console.log('\nM4 — /estimate "Email my estimate" does not promise an email the server may not send');
  {
    // The email goes out from a Firestore trigger (functions/estimate-email.js)
    // that can throttle, dry-run or skip it; submitPublicLead's response only
    // says the request doc was saved. The success text must say just that.
    const src = read('docs/assets/js/inline/4053149b2f.js');
    const at = src.indexOf('async function emailEstimate(btn) {');
    let depth = 0, i = src.indexOf('{', at);
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    const run = async (savedId) => {
      const btn = { textContent: '', disabled: false, style: {} };
      const ctx = {
        funnelData: { email: 'pat@example.com', estimate: {} }, trackCTA() {}, trackEvent() {}, emailEstimatePayload: () => ({ v: 1 }),
        window: { _saveLead: async () => savedId }, document: { getElementById: () => null }, console,
      };
      vm.createContext(ctx);
      vm.runInContext(src.slice(at, i + 1), ctx);
      await ctx.emailEstimate(btn);
      return btn;
    };
    const okBtn = await run('lead-1');
    ok('a saved request no longer says "Check your inbox"', !/check your inbox/i.test(okBtn.textContent), okBtn.textContent);
    ok('…it says the email was requested and should arrive in a few minutes', /requested/i.test(okBtn.textContent) && /few minutes/i.test(okBtn.textContent), okBtn.textContent);
    ok('…with the call/text fallback if it does not', /\(859\) 420-7382/.test(okBtn.textContent), okBtn.textContent);
    const failBtn = await run(null);
    ok('a failed save keeps the call/text message and re-enables the button', /Couldn't send/.test(failBtn.textContent) && failBtn.disabled === false, failBtn.textContent);
  }

  console.log('\nL1 — /estimate "Start over" restores a real arrow on the submit button');
  {
    const src = read('docs/assets/js/inline/4053149b2f.js');
    const html = read('docs/estimate.html');
    const initial = (html.match(/id="btnSubmit"[^>]*>([^<]*)</) || [])[1] || '';
    const reset = (src.match(/getElementById\('btnSubmit'\)\.textContent = '([^']*)'/) || [])[1];
    ok('the reset sets the submit label through textContent', typeof reset === 'string', reset);
    ok('…with the → character, not the literal "&#x2192;" entity', reset === 'Get My Free Detailed Estimate →', reset);
    ok('…matching the initial label in estimate.html', initial.replace('&#x2192;', '→') === reset, initial);
  }

  console.log('\nM10 — form errors are announced to screen readers');
  for (const [page, id] of [['docs/roof-check.html', 'rc-contact-err']]) {
    const tag = (read(page).match(new RegExp('<div[^>]*id="' + id + '"[^>]*>')) || [])[0] || '';
    ok(`${page}: #${id} has role="alert"`, /\srole="alert"/.test(tag), tag);
  }

  console.log('\nM1 — "None / not sure" clears when a real sign is picked');
  for (const [rel, P] of [['docs/assets/js/roof-check.js', 'rc']]) {
    const t = loadTool(rel, buildQuiz(P));
    const tile = (v) => t.dom.doc.querySelector('[data-group="signs"] .' + P + '-tile[data-value="' + v + '"]');
    t.fire(tile('none'), 'click');
    ok(`${rel}: tapping "none" selects it`, tile('none').classList.contains('selected'));
    t.fire(tile('missing'), 'click');
    ok(`${rel}: tapping "missing" afterwards deselects "none"`, !tile('none').classList.contains('selected') && tile('missing').classList.contains('selected'));
  }

  console.log('\nH4 — roof-check.js: no lookup per keystroke; Check resolves a typed address (was storm-report-page.js)');
  {
    const t = loadTool('docs/assets/js/roof-check.js', buildQuiz('rc'), { geocode: () => [{ display_name: '12 Elm St, Goshen, OH', lat: '39.2', lon: '-84.1' }] });
    const inp = t.$('rc-address');
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
