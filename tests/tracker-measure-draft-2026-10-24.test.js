/**
 * tests/tracker-measure-draft-2026-10-24.test.js
 *
 * Overnight audit 2026-10-23 (pass 1, "typed measurement text lost"): typing in
 * the Measurements box within ~1 s of load was wiped by a one-time post-load
 * renderDash, and the unit / site chips wiped it too, because every re-render
 * rebuilds the card's HTML with an empty input. Saving straight after said
 * "Enter a number like 34.5".
 *
 * The REAL measurements-ui.js runs in a vm with a small fake DOM. What it pins:
 * the typed text survives renderDash and the chips, the box gets its focus and
 * caret back after a re-render it had focus for, a save clears it, and the
 * value is escaped into the attribute.
 *
 * Run: node tests/tracker-measure-draft-2026-10-24.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const read = (...p) => fs.readFileSync(path.join(DS, ...p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; fails.push(label); }
}

// The value attribute of the #msInput in a card's HTML (decoded), or null.
const valueIn = (html) => {
  const m = /<input[^>]*id="msInput"[^>]*>/.exec(html || '');
  if (!m) return null;
  const v = /\svalue="([^"]*)"/.exec(m[0]);
  return v ? v[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&') : '';
};

function load() {
  const store = new Map();
  const toasts = [];
  const listeners = {};
  const dom = {};               // id -> element
  let active = null;
  let cardHtml = '';            // the live #msCard markup
  const input = (value) => ({
    id: 'msInput', value, selectionStart: value.length, selectionEnd: value.length, focused: 0, sel: null,
    focus() { this.focused++; active = this; },
    setSelectionRange(a, b) { this.sel = [a, b]; },
  });
  // Re-parse the only two things the test reads: the card and its input.
  const mount = (html) => {
    cardHtml = html;
    dom.msCard = { get outerHTML() { return cardHtml; }, set outerHTML(h) { mount(h); } };
    const v = valueIn(html);
    dom.msInput = v == null ? null : input(v);
  };
  const main = {
    insertBefore(box) { mount(box.innerHTML); },
    get firstChild() { return null; },
  };
  const document = {
    readyState: 'complete',
    get activeElement() { return active; },
    getElementById: (id) => (id === 'main' ? main : dom[id] || null),
    createElement: () => ({ className: '', innerHTML: '' }),
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  };
  let dashRuns = 0;
  const win = {
    document,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    toast: (m) => toasts.push(m),
    todayKey: () => '2026-10-24',
    addEventListener() {},
    // The dashboard's own render throws the old cards away, like the real one.
    renderDash() { dashRuns++; dom.msCard = null; dom.msInput = null; if (active && active.id === 'msInput') active = null; },
  };
  win.window = win;
  win.self = win;
  const ctx = vm.createContext(Object.assign(win, { console, setTimeout, clearTimeout, URL, Blob: function () {} }));
  vm.runInContext(read('js', 'measurements-logic.js'), ctx, { filename: 'measurements-logic.js' });
  vm.runInContext(read('js', 'measurements-ui.js'), ctx, { filename: 'measurements-ui.js' });
  const fire = (type, target) => (listeners[type] || []).forEach((fn) => fn({ target }));
  const typeText = (text) => { const el = dom.msInput; el.value = text; el.selectionStart = el.selectionEnd = text.length; el.focus(); fire('input', el); };
  // A tap moves focus to the chip / button first, as in a browser.
  const click = (attrs) => { active = { id: 'chip' }; fire('click', { closest: () => ({ dataset: attrs }) }); };
  return { win, dom, store, toasts, typeText, click, get active() { return active; }, get dashRuns() { return dashRuns; }, cardHtml: () => cardHtml };
}

console.log('\n1. typed text survives the post-load renderDash');
{
  const t = load();
  ok('control: boot rendered the card with an empty box', t.dom.msInput && t.dom.msInput.value === '', String(t.dom.msInput && t.dom.msInput.value));
  t.typeText('34.5');
  t.win.renderDash();                        // the one-time post-load re-render
  ok('the rebuilt box still holds "34.5"', t.dom.msInput && t.dom.msInput.value === '34.5', String(t.dom.msInput && t.dom.msInput.value));
  ok('...and has focus back (typing carries on)', t.dom.msInput && t.dom.msInput.focused > 0 && t.active === t.dom.msInput);
  ok('...with the caret where it was', t.dom.msInput && JSON.stringify(t.dom.msInput.sel) === '[4,4]', JSON.stringify(t.dom.msInput && t.dom.msInput.sel));
  t.click({ msAction: 'save' });
  ok('saving right after logs it (no "Enter a number" toast)', t.toasts.includes('Logged') && !t.toasts.some((m) => /Enter a number/.test(m)), t.toasts.join(' | '));
  ok('a successful save empties the box', t.dom.msInput && t.dom.msInput.value === '', String(t.dom.msInput && t.dom.msInput.value));
}

console.log('\n2. the chips keep the typed text');
{
  const t = load();
  t.typeText('86');
  t.click({ msAction: 'unit', unit: 'cm' });
  ok('switching to cm keeps "86"', t.dom.msInput && t.dom.msInput.value === '86', String(t.dom.msInput && t.dom.msInput.value));
  t.click({ msAction: 'site', site: 'hips' });
  ok('picking another site keeps "86"', t.dom.msInput && t.dom.msInput.value === '86', String(t.dom.msInput && t.dom.msInput.value));
  t.click({ msAction: 'save' });
  ok('the save uses the box and the chosen unit (86 cm logged for hips)', t.toasts.includes('Logged') && /hips/.test(t.store.get('nbd_ds_measurements') || ''), t.store.get('nbd_ds_measurements'));
}

console.log('\n3. a re-render the box did not have focus for does not steal focus');
{
  const t = load();
  t.typeText('30');
  t.click({ msAction: 'unit', unit: 'cm' });   // a chip tap moves focus off the box in a browser
  const before = t.dom.msInput.focused;
  ok('control: the box was re-rendered with the text', t.dom.msInput.value === '30');
  ok('the chip re-render did not grab focus for the box (it never had it here)', before === 0, String(before));
}

console.log('\n4. the value is escaped into the attribute');
{
  const t = load();
  t.typeText('"><img src=x onerror=1>');
  t.win.renderDash();
  ok('no raw markup leaks out of the value attribute', !/<img src=x/.test(t.cardHtml()), t.cardHtml().slice(0, 300));
  ok('...and the text round-trips intact', t.dom.msInput && t.dom.msInput.value === '"><img src=x onerror=1>', String(t.dom.msInput && t.dom.msInput.value));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
