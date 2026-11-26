/**
 * tests/wizard-validation-focus-2026-10-26.test.js
 *
 * The three step-by-step tools (/estimate, /storm-check, /roof-score) went quiet
 * at three points. (2026-11-25: /storm-check and /roof-score merged into
 * /roof-check; sections 4-6 now drive roof-check.js on docs/roof-check.html.
 * Roof Score's score screen, band label and moisture/last-inspection step are
 * gone with it, so their checks went too; the required-answer, aria-pressed and
 * focus-follows behaviour they guarded is checked on /roof-check.) This suite pins the fixes by BEHAVIOUR: the real shipped
 * scripts run in a vm against a small DOM that is built from the REAL shipped
 * markup (docs/estimate.html, storm-check.html, roof-score.html), so ids,
 * groups, tiles and button rows are the ones a visitor gets. No network: every
 * fetch is a stub.
 *
 *   1. /estimate step 5: a typed email that does not look like one dimmed
 *      Submit with no explanation (the "Valid email required" line was in the
 *      markup and never shown). It is now shown on blur, marked aria-invalid,
 *      and cleared as soon as the address is fixed or emptied.
 *   2. Every step change hid the button that was just pressed, so keyboard
 *      focus fell to <body> and nothing was announced. The new step's heading
 *      now takes focus (tabindex -1), on all three tools.
 *   3. /estimate step 3: the two pre-selected tiles (Asphalt Shingle, Typical)
 *      were plain divs; a keyboard user could not go back to them. They carry
 *      role=button, tabindex=0 and aria-pressed like their siblings.
 *   4. /storm-check and /roof-score: Continue with a required answer missing
 *      did nothing (or flashed a border for 0.9 s). Now a role=alert line says
 *      what to pick and focus lands on the first unanswered group; the answer
 *      tiles expose aria-pressed (and are type=button).
 *   5. Cache-busts for the edited scripts, the /estimate twitter:title, and the
 *      two above-the-fold font preloads on the three pages.
 *
 * Run: node tests/wizard-validation-focus-2026-10-26.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
// A small DOM parsed from the real markup: enough for the scripts to run for real.
// ─────────────────────────────────────────────────────────────────────────
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function parseSelector(sel) {
  return sel.split(',').map((s) => s.trim()).filter(Boolean).map((part) =>
    part.split(/\s+(?![^[]*\])/).map((c) => {
      const o = { tag: null, id: null, classes: [], attrs: [] };
      const re = /^(?:([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\])/;
      let rest = c, m;
      while (rest && (m = re.exec(rest))) {
        if (m[1]) o.tag = m[1].toUpperCase();
        else if (m[2]) o.classes.push(m[2]);
        else if (m[3]) o.id = m[3];
        else o.attrs.push([m[4], m[5] !== undefined ? m[5] : (m[6] !== undefined ? m[6] : m[7])]);
        rest = rest.slice(m[0].length);
      }
      if (rest) throw new Error('unsupported selector in the test DOM: ' + sel);
      return o;
    }));
}
function matchCompound(el, o) {
  if (!el || el.tagName === '#TEXT') return false;
  if (o.tag && el.tagName !== o.tag) return false;
  if (o.id && el.id !== o.id) return false;
  const cls = el.className.split(/\s+/);
  if (o.classes.some((c) => !cls.includes(c))) return false;
  return o.attrs.every(([k, v]) => el.hasAttribute(k) && (v === undefined || el.getAttribute(k) === v));
}
function matchesSel(el, sel) {
  return parseSelector(sel).some((chain) => {
    let i = chain.length - 1;
    if (!matchCompound(el, chain[i])) return false;
    let n = el._parent;
    for (i--; i >= 0; i--) {
      while (n && !matchCompound(n, chain[i])) n = n._parent;
      if (!n) return false;
      n = n._parent;
    }
    return true;
  });
}

function makeDom(html) {
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, '');
  const focusLog = [];
  const scrollLog = [];
  const docListeners = {};
  let doc = null;

  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.attrs = {}; this.nodes = []; this._parent = null; this.listeners = {};
      this.style = {}; this._text = ''; this._value = undefined; this._checked = undefined; this.innerHTML = '';
      this.offsetParent = {};
    }
    get id() { return this.attrs.id || ''; }
    set id(v) { this.attrs.id = String(v); }
    get className() { return this.attrs.class || ''; }
    set className(v) { this.attrs.class = String(v); }
    get classList() {
      const self = this;
      const get = () => self.className.split(/\s+/).filter(Boolean);
      const set = (a) => { self.attrs.class = a.join(' '); };
      return {
        add(...c) { const a = get(); c.forEach((x) => { if (!a.includes(x)) a.push(x); }); set(a); },
        remove(...c) { set(get().filter((x) => !c.includes(x))); },
        contains(c) { return get().includes(c); },
        toggle(c, f) { const on = f === undefined ? !get().includes(c) : !!f; if (on) this.add(c); else this.remove(c); return on; },
      };
    }
    get dataset() { const o = {}; Object.keys(this.attrs).forEach((k) => { if (k.startsWith('data-')) o[camel(k.slice(5))] = this.attrs[k]; }); return o; }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get value() { return this._value !== undefined ? this._value : (this.attrs.value || ''); }
    set value(v) { this._value = String(v); }
    get checked() { return this._checked !== undefined ? this._checked : this.hasAttribute('checked'); }
    set checked(v) { this._checked = !!v; }
    get type() { return this.attrs.type || ''; }
    set type(v) { this.attrs.type = String(v); }
    get children() { return this.nodes.filter((n) => n.tagName !== '#TEXT'); }
    get childElementCount() { return this.children.length; }
    get parentElement() { return this._parent; }
    get parentNode() { return this._parent; }
    get textContent() { return this.tagName === '#TEXT' ? this._text : this.nodes.map((n) => n.textContent).join(''); }
    set textContent(v) { this.nodes = []; const t = new El('#text'); t._text = String(v); t._parent = this; this.nodes.push(t); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    removeEventListener() {}
    appendChild(n) { n._parent = this; this.nodes.push(n); return n; }
    insertBefore(n, ref) {
      n._parent = this;
      const i = ref ? this.nodes.indexOf(ref) : -1;
      if (i < 0) this.nodes.push(n); else this.nodes.splice(i, 0, n);
      return n;
    }
    matches(sel) { return matchesSel(this, sel); }
    closest(sel) { for (let n = this; n; n = n._parent) if (matchesSel(n, sel)) return n; return null; }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => n.nodes.forEach((c) => { if (c.tagName !== '#TEXT') { if (matchesSel(c, sel)) out.push(c); walk(c); } });
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; }
    getClientRects() { return [1]; }
    scrollIntoView(o) { scrollLog.push({ el: this, opts: o || null }); }
    click() { return this.dispatch('click'); }
    focus(opts) { doc.activeElement = this; focusLog.push({ el: this, opts: opts || null }); }
    blur() { if (doc.activeElement === this) doc.activeElement = null; }
    dispatch(type, ev) {
      const e = Object.assign({ type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, ev || {});
      for (let n = this; n; n = n._parent) (n.listeners[type] || []).slice().forEach((fn) => fn.call(n, e));
      (docListeners[type] || []).slice().forEach((fn) => fn.call(doc, e));
      return e;
    }
  }

  const root = new El('#document');
  const stack = [root];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>|([^<]+)|</g;
  const attrRe = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = tagRe.exec(stripped))) {
    if (m[5] !== undefined) { const t = new El('#text'); t._text = m[5]; stack[stack.length - 1].appendChild(t); continue; }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
      continue;
    }
    const el = new El(tag);
    let a;
    attrRe.lastIndex = 0;
    while ((a = attrRe.exec(m[3] || ''))) el.attrs[a[1].toLowerCase()] = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : ''));
    stack[stack.length - 1].appendChild(el);
    if (!VOID.has(tag) && !m[4]) stack.push(el);
  }

  doc = {
    readyState: 'complete', activeElement: null,
    get body() { return root.querySelector('body'); },
    get head() { return root.querySelector('head'); },
    get documentElement() { return root.querySelector('html'); },
    getElementById(id) { return root.querySelector('#' + id); },
    createElement(tag) { return new El(tag); },
    createTextNode(t) { const n = new El('#text'); n._text = String(t); return n; },
    querySelector(sel) { return root.querySelector(sel); },
    querySelectorAll(sel) { return root.querySelectorAll(sel); },
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener() {},
    dispatch(t, ev) { const e = Object.assign({ type: t, preventDefault() {} }, ev || {}); (docListeners[t] || []).slice().forEach((fn) => fn.call(doc, e)); return e; },
  };
  return { document: doc, El, focusLog, scrollLog };
}

// Run one shipped script against one shipped page.
function boot(htmlPath, jsPath, extra) {
  const o = extra || {};
  const dom = makeDom(read(htmlPath));
  const scrolls = [];
  const ctx = {
    document: dom.document, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, URLSearchParams, AbortController,
    location: { pathname: o.pathname || '/', search: '' },
    scrollTo(a) { scrolls.push(a); },
    gtag() {},
    L: { map: () => ({}), tileLayer: () => ({ addTo() {} }), divIcon: () => ({}), marker: () => ({ addTo() {} }) },
    // Never the network: the address lookup, the storm records and the AI note all fall back.
    fetch: () => Promise.reject(new Error('offline')),
    NBDIntake: { html: () => '', read: () => ({ fields: {}, files: [] }), afterSubmit() {} },
    submitPublicLead: () => Promise.resolve({ ok: true }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read(jsPath), ctx, { filename: jsPath });
  return { ctx, document: dom.document, El: dom.El, focusLog: dom.focusLog, scrollLog: dom.scrollLog, scrolls };
}

const activeStep = (d, cls) => d.querySelector('.' + cls + '.active');
const headingOf = (stepEl, sel) => stepEl.querySelector(sel);
function isFocusedHeading(d, el) { return !!el && d.activeElement === el && el.getAttribute('tabindex') === '-1' && el.style.outline === 'none'; }

(async () => {
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n1. /estimate step 5 — an optional email that does not look like one says so');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const E = boot('docs/estimate.html', 'docs/assets/js/inline/4053149b2f.js', { pathname: '/estimate' });
    const d = E.document;
    const email = d.getElementById('emailAddress');
    const group = email.parentElement;
    const err = d.getElementById('emailAddress-err');
    const html = read('docs/estimate.html');
    d.getElementById('firstName').value = 'Pat';
    d.getElementById('phoneNumber').value = '(859) 555-1234';
    d.getElementById('phoneNumber').dispatch('input');
    const submit = d.getElementById('btnSubmit');
    const type = (v, ev) => { email.value = v; email.dispatch(ev || 'input'); };

    ok('the markup already carries the message: a role=alert line in the email field\'s group',
      !!err && err.getAttribute('role') === 'alert' && group.classList.contains('input-group'));
    ok('...and the field does not point at it until it shows (a hidden description is still read out)',
      !email.getAttribute('aria-describedby') && !/id="emailAddress"[^>]*aria-describedby/.test(html));
    ok('...and the page CSS shows it when the group has .has-error',
      /\.input-group\.has-error \.error-msg\{display:block;\}/.test(html));
    type('pat@example');
    ok('mid-typing is not nagged: no error before the field is left', !group.classList.contains('has-error'));
    ok('(control) the address "pat@example" still holds Submit back', submit.disabled === true);
    type('pat@example', 'blur');
    ok('leaving the field with "pat@example" marks the group .has-error', group.classList.contains('has-error'));
    ok('...and the field now points at the message (aria-describedby)', email.getAttribute('aria-describedby') === 'emailAddress-err', email.getAttribute('aria-describedby'));
    ok('...and sets aria-invalid="true" on the field', email.getAttribute('aria-invalid') === 'true', email.getAttribute('aria-invalid'));
    ok('...the message says what to do, including that the field can be left blank', /blank/i.test(err.textContent), err.textContent);
    type('pat@example.', 'input');
    ok('still wrong while editing: the error stays up', group.classList.contains('has-error'));
    type('pat@example.com', 'input');
    ok('a fixed address clears the error as it is typed', !group.classList.contains('has-error') && email.getAttribute('aria-invalid') === 'false');
    ok('...and drops the aria-describedby again, so a valid address is not described as wrong', !email.getAttribute('aria-describedby'), email.getAttribute('aria-describedby'));
    ok('...and Submit is enabled again', submit.disabled === false);
    type('pat @example.com', 'blur');
    ok('an address with a space is flagged too', group.classList.contains('has-error'));
    type('', 'input');
    ok('emptying the optional field clears the error', !group.classList.contains('has-error') && submit.disabled === false);
    type('', 'blur');
    ok('an empty optional email is never an error', !group.classList.contains('has-error'));
    ok('...and an empty optional email has no aria-describedby', !email.getAttribute('aria-describedby'), email.getAttribute('aria-describedby'));
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n2. /estimate — every step change puts focus on the new step\'s heading');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const E = boot('docs/estimate.html', 'docs/assets/js/inline/4053149b2f.js', { pathname: '/estimate' });
    const d = E.document;
    d.getElementById('addressInput').value = '12 Main St, Mason OH';
    d.getElementById('firstName').value = 'Pat';
    d.getElementById('phoneNumber').value = '(859) 555-1234';
    d.getElementById('step1').querySelector('[data-step="2"]').click();
    await tick(30);
    const typed = d.getElementById('btnUseTyped');
    ok('(setup) the offline lookup offers "Use my address as typed"', !!typed);
    typed.click();
    const s3 = d.getElementById('step3');
    ok('(setup) typed address lands on step 3', s3.classList.contains('active'));
    ok('step 3: focus is on its heading (tabindex -1), not <body>', isFocusedHeading(d, headingOf(s3, '.step-title')), d.activeElement && d.activeElement.tagName);
    ok('...focused without a scroll jump (goToStep already scrolls to the top)', E.focusLog.length > 0 && E.focusLog[E.focusLog.length - 1].opts && E.focusLog[E.focusLog.length - 1].opts.preventScroll === true);

    s3.querySelector('[data-value="roof-replacement"]').click();
    s3.querySelector('[data-value="asap"]').click();
    d.getElementById('btnStep3').click();
    const s4 = d.getElementById('step4');
    ok('step 4: focus is on its heading', s4.classList.contains('active') && isFocusedHeading(d, headingOf(s4, '.step-title')));
    s4.querySelector('[data-step="5"]').click();
    const s5 = d.getElementById('step5');
    ok('step 5: focus is on its heading', s5.classList.contains('active') && isFocusedHeading(d, headingOf(s5, '.step-title')));
    s5.querySelector('.btn-back').click();
    ok('Back: focus follows to the heading of the step it returns to', s4.classList.contains('active') && isFocusedHeading(d, headingOf(s4, '.step-title')));

    // The results screen is shown by showResults(), not goToStep().
    E.ctx.showResults(E.ctx.buildFallbackEstimate ? E.ctx.buildFallbackEstimate() : {});
    const res = d.getElementById('stepResults');
    ok('results: focus is on the results heading', res.classList.contains('active') && isFocusedHeading(d, headingOf(res, '.step-title')), d.activeElement && d.activeElement.tagName);
    ok('every step has a .step-title heading to take focus (the loading screen falls back to its text)',
      ['step1', 'step2', 'step3', 'step4', 'step5', 'stepResults'].every((id) => !!headingOf(d.getElementById(id), '.step-title')) && !!headingOf(d.getElementById('stepLoading'), '.loading-text'));
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n3. /estimate step 3 — the two pre-selected tiles are operable like their siblings');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const E = boot('docs/estimate.html', 'docs/assets/js/inline/4053149b2f.js', { pathname: '/estimate' });
    const d = E.document;
    const tiles = d.querySelectorAll('.tile');
    const bad = tiles.filter((t) => t.getAttribute('role') !== 'button' || t.getAttribute('tabindex') !== '0' || !/^(true|false)$/.test(t.getAttribute('aria-pressed') || '')).map((t) => t.dataset.value);
    ok('every answer tile on the page is role=button, tabindex=0 and carries aria-pressed (' + tiles.length + ' tiles)', tiles.length >= 17 && bad.length === 0, bad.join(', '));
    const asphalt = d.querySelector('#roofTypeGroup .tile[data-value="asphalt"]');
    const typical = d.querySelector('#homeSizeGroup .tile[data-value="typical"]');
    ok('the pre-selected Asphalt Shingle and Typical tiles read aria-pressed="true"',
      asphalt.classList.contains('selected') && asphalt.getAttribute('aria-pressed') === 'true' && typical.classList.contains('selected') && typical.getAttribute('aria-pressed') === 'true');
    // Pick Metal, then go back to Asphalt with the keyboard (Enter on the focused tile).
    d.querySelector('#roofTypeGroup .tile[data-value="metal"]').click();
    ok('after choosing Metal, Asphalt reads aria-pressed="false" and Metal "true"',
      asphalt.getAttribute('aria-pressed') === 'false' && d.querySelector('#roofTypeGroup .tile[data-value="metal"]').getAttribute('aria-pressed') === 'true');
    const ev = asphalt.dispatch('keydown', { key: 'Enter' });
    ok('Enter on the Asphalt tile selects it again (the keyboard path reaches it)', ev.defaultPrevented && asphalt.classList.contains('selected') && asphalt.getAttribute('aria-pressed') === 'true');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n4. /roof-check — a missing answer is said out loud; tiles expose their state; focus follows');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const S = boot('docs/roof-check.html', 'docs/assets/js/roof-check.js');
    const d = S.document;
    const step = (n) => d.getElementById('rc-step' + n);
    const alertEl = (n) => step(n).querySelector('[role="alert"]');
    const alertOf = (n) => alertEl(n) || { textContent: '(no role=alert element)' };
    const pressed = (n, group) => step(n).querySelectorAll('[data-group="' + group + '"] .rc-tile').map((t) => t.getAttribute('aria-pressed')).join(',');
    const tile = (n, group, v) => step(n).querySelector('[data-group="' + group + '"] [data-value="' + v + '"]');
    const active = () => d.querySelector('.rc-step.active').id;

    const allTiles = d.querySelectorAll('.rc-tile');
    ok('every answer tile is type="button" with aria-pressed="false" at load (' + allTiles.length + ' tiles)',
      allTiles.length >= 15 && allTiles.every((t) => t.getAttribute('type') === 'button' && t.getAttribute('aria-pressed') === 'false'),
      allTiles.filter((t) => t.getAttribute('aria-pressed') !== 'false').length);
    ok('step 3 has a role=alert line under the subtitle, above the questions, empty until needed',
      [3].every((n) => { const a = alertEl(n); const lab = step(n).querySelector('.rc-label'); const sub = step(n).querySelector('.rc-sub'); return a && a.textContent === '' && a.style.minHeight === '0' && step(n).nodes.indexOf(a) === step(n).nodes.indexOf(lab) - 1 && step(n).nodes.indexOf(a) > step(n).nodes.indexOf(sub); }));

    d.getElementById('rc-address').value = '12 Main St, Mason OH';
    d.getElementById('rc-step1').querySelector('[data-action="generate"]').click();
    await tick(30);
    d.querySelector('[data-action="useTypedAddress"]').click();
    await tick(30);
    ok('(setup) typed address lands on the free storm history, focus on its heading', active() === 'rc-teaser' && isFocusedHeading(d, d.getElementById('rc-teaser-headline')), active());
    d.getElementById('rc-teaser').querySelector('[data-step="3"]').click();
    ok('"Get Joe\'s take" opens the roof questions, focus on its heading (tabindex -1), not <body>', active() === 'rc-step3' && isFocusedHeading(d, step(3).querySelector('h2')));

    step(3).querySelector('[data-step="4"]').click();
    ok('Continue with no roof age stays on step 3', active() === 'rc-step3');
    ok('...and says what to pick, in the role=alert line', /how old the roof is/.test(alertOf(3).textContent), alertOf(3).textContent);
    ok('...focus lands on the first unanswered group (the first age tile), without a scroll jump', d.activeElement === tile(3, 'roofAge', '<5') && S.focusLog[S.focusLog.length - 1].opts.preventScroll === true);
    ok('...and the page scrolls the message into the middle of the screen (clear of the sticky bars)',
      S.scrollLog.length > 0 && S.scrollLog[S.scrollLog.length - 1].el === alertEl(3) && S.scrollLog[S.scrollLog.length - 1].opts.block === 'center');

    tile(3, 'roofAge', '10-15').click();
    ok('picking an age sets aria-pressed true on it and false on its siblings', pressed(3, 'roofAge') === 'false,false,true,false,false,false', pressed(3, 'roofAge'));
    ok('...and clears the message', alertOf(3).textContent === '');

    // The multi-select group: aria-pressed follows .selected, "none" clears the rest.
    tile(3, 'signs', 'missing').click();
    tile(3, 'signs', 'dents').click();
    ok('signs (multi-select): both picks read pressed', pressed(3, 'signs') === 'true,false,true,false,false,false', pressed(3, 'signs'));
    tile(3, 'signs', 'none').click();
    ok('...choosing "None / not sure" un-presses the others', pressed(3, 'signs') === 'false,false,false,false,false,true', pressed(3, 'signs'));
    tile(3, 'signs', 'none').click();
    ok('...and toggling it off un-presses it', pressed(3, 'signs') === 'false,false,false,false,false,false', pressed(3, 'signs'));

    step(3).querySelector('[data-step="4"]').click();
    ok('step 4 (contact): focus on its heading', active() === 'rc-step4' && isFocusedHeading(d, step(4).querySelector('h2')));
    d.getElementById('rc-firstName').value = 'Pat';
    d.getElementById('rc-phone').value = '(859) 555-1234';
    d.getElementById('rc-submit').click();
    ok('submitting moves to the loading step, focus on its heading', active() === 'rc-step5' && isFocusedHeading(d, step(5).querySelector('h2')), active());
    await tick(60);
    const result = d.getElementById('rc-result');
    ok('the verdict takes focus when it appears (its headline)', result.classList.contains('active') && isFocusedHeading(d, d.getElementById('rc-result-headline')), d.activeElement && d.activeElement.id);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n6. cache-busts, the /estimate share title, and the font preloads');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const est = read('docs/estimate.html'), rc = read('docs/roof-check.html');
    const meta = (h, attr, name) => ((h.match(new RegExp('<meta ' + attr + '="' + name + '" content="([^"]*)"')) || [])[1]);
    // ">= this version": a later edit re-versions the same script (copy-001 wording, 2026-11-04).
    const ver = (h, f) => +((h.match(new RegExp('/assets/js/' + f + '\\?v=(\\d+)"')) || [])[1] || 0);
    ok('the scripts are versioned on their pages: roof-check.js?v=1+, loader ?v=6+ -> wizard ?v=7+',
      ver(rc, 'roof-check\\.js') >= 1
      && ver(est, 'estimate-wizard-loader\\.js') >= 6
      && +((read('docs/assets/js/estimate-wizard-loader.js').match(/\/assets\/js\/inline\/4053149b2f\.js\?v=(\d+)'/) || [])[1] || 0) >= 7);
    ok('/estimate: twitter:title equals og:title (no truncated copy)', !!meta(est, 'property', 'og:title') && meta(est, 'name', 'twitter:title') === meta(est, 'property', 'og:title'), meta(est, 'name', 'twitter:title'));
    const pre = (f) => '<link rel="preload" href="/assets/fonts/' + f + '" as="font" type="font/woff2" crossorigin>';
    for (const [page, h] of [['/estimate', est], ['/roof-check', rc]]) {
      const iCss = h.indexOf('<link rel="stylesheet" href="/assets/css/nbd-fonts.css">');
      const iB = h.indexOf(pre('bebas-neue-400-latin.woff2')), iM = h.indexOf(pre('montserrat-400-latin.woff2'));
      ok(page + ': preloads the two above-the-fold fonts, right after the font stylesheet (as /book does)',
        iCss > 0 && iB > iCss && iM > iB && iM - iCss < 400, [iCss, iB, iM].join('/'));
    }
    ok('the preloaded files exist', ['bebas-neue-400-latin.woff2', 'montserrat-400-latin.woff2'].every((f) => fs.existsSync(path.join(ROOT, 'docs', 'assets', 'fonts', f))));
    ok('no inline handlers or inline scripts were added to the pages',
      [est, rc].every((h) => !/\son(click|change|input|blur|keydown)\s*=/i.test(h.replace(/<style[\s\S]*?<\/style>/gi, ''))));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
