/**
 * ios-date-hint-2026-11-25.test.js — an empty date field on an iPhone shows "mm/dd/yyyy".
 *
 * Joe's pick (2026-11-25): on iOS only, a grey "mm/dd/yyyy" hint and a calendar
 * icon while a date field is empty, as Android draws it. The hint is a CSS
 * background keyed on .nbd-date-empty, so the class must follow the field's
 * value through every way a value arrives, or the hint would sit on top of a
 * real date. This suite RUNS docs/pro/js/ios-date-hint.js in a VM with a fake
 * input prototype and a fake MutationObserver.
 *
 * Run: node tests/ios-date-hint-2026-11-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const K = require('./lib/src-kit');
const t = K.suite();

const FILE = path.join(K.ROOT, 'docs/pro/js/ios-date-hint.js');
const SRC = fs.readFileSync(FILE, 'utf8');
const P = require(FILE);

t.section('who counts as iOS');
t.ok('iPhone and iPad (incl. iPadOS reporting a Mac with touch) do', P.isIOS('… (iPhone; CPU iPhone OS 18_6 like Mac OS X) …', 5) && P.isIOS('… (Macintosh; Intel Mac OS X 10_15_7) …', 5));
t.ok('Android, a Mac desktop and Windows do not', !P.isIOS('… (Linux; Android 14; Pixel 7) …', 5) && !P.isIOS('… (Macintosh; Intel Mac OS X 10_15_7) …', 0) && !P.isIOS('… (Windows NT 10.0; Win64; x64) …', 0));

function harness(ua) {
  const listeners = {};
  let observerCb = null;
  function HTMLInputElement() {}
  Object.defineProperty(HTMLInputElement.prototype, 'value', { configurable: true, enumerable: true, get() { return this._v || ''; }, set(v) { this._v = v == null ? '' : String(v); } });
  Object.defineProperty(HTMLInputElement.prototype, 'valueAsDate', { configurable: true, enumerable: true, get() { return this._v ? new Date(this._v) : null; }, set(d) { this._v = d ? d.toISOString().slice(0, 10) : ''; } });
  const cls = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) }; };
  const input = (type, value) => { const e = Object.create(HTMLInputElement.prototype); e.tagName = 'INPUT'; e.type = type; e.classList = cls(); e.nodeType = 1; if (value) e._v = value; return e; };
  const empty = input('date'), filled = input('date', '2026-11-25'), text = input('text');
  const body = { inputs: [empty, filled, text], querySelectorAll() { return this.inputs.filter((i) => i.type === 'date'); } };
  const html = { classList: cls() };
  const document = {
    readyState: 'complete', body, documentElement: html, head: {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const window = { document, navigator: { userAgent: ua, maxTouchPoints: 5 }, HTMLInputElement, MutationObserver: function (cb) { observerCb = cb; this.observe = () => {}; } };
  vm.runInContext(SRC, vm.createContext({ window, document, setTimeout: (fn) => fn(), Object, String, Number, console }));
  const fire = (type, target) => (listeners[type] || []).forEach((fn) => fn({ type, target }));
  return { html, empty, filled, text, input, fire, mutate: (m) => observerCb && observerCb(m), window };
}
const E = (el) => el.classList.contains('nbd-date-empty');

t.section('not an iPhone: nothing happens');
{
  const h = harness('Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/131 Mobile');
  t.ok('no nbd-ios class, no empty markers, value setter untouched', !h.html.classList.contains('nbd-ios') && !E(h.empty) && !Object.getOwnPropertyDescriptor(h.window.HTMLInputElement.prototype, 'value').set.__nbdDateHint);
}

t.section('an iPhone');
const h = harness('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) Mobile/15E148');
t.ok('the page is marked nbd-ios (the CSS hint is scoped to it)', h.html.classList.contains('nbd-ios'));
t.ok('first scan: the empty date field is marked, the filled one is not, a text field is ignored', E(h.empty) && !E(h.filled) && !E(h.text));
h.empty.value = '2026-12-01';
t.ok('code setting .value (the edit-lead prefill) clears the hint at once', !E(h.empty));
h.empty.value = '';
t.ok('…and clearing it from code brings the hint back', E(h.empty));
h.filled.valueAsDate = null;
t.ok('code setting .valueAsDate is followed too', E(h.filled));
h.filled._v = '2026-11-30'; h.fire('change', h.filled);
t.ok('the rep picking a date (change) clears the hint', !E(h.filled));
h.filled._v = ''; h.fire('input', h.filled);
t.ok('the rep clearing it (input) brings it back', E(h.filled));
const late = h.input('date', '2026-10-10'), lateEmpty = h.input('date');
h.mutate([{ type: 'childList', addedNodes: [late, lateEmpty] }]);
t.ok('a field added later (a modal\'s markup) is marked by what it holds', !E(late) && E(lateEmpty));
lateEmpty._v = '2026-10-11'; h.mutate([{ type: 'attributes', target: lateEmpty }]);
t.ok('setAttribute(\'value\', …) is followed too', !E(lateEmpty));
h.text.value = 'abc';
t.ok('a text field set from code is never marked', !E(h.text));

t.section('the CSS hint is scoped and drawn as a background (Safari does not draw ::before on a date input)');
const rules = K.cssRules(K.read('docs/pro/css/mobile-polish.css'));
const base = K.cssRule(rules, 'html.nbd-ios input[type="date"]');
const empty = K.cssRule(rules, 'html.nbd-ios input[type="date"].nbd-date-empty');
t.ok('every iOS date field gets the calendar icon and room for it', !!base && /^url\("data:image\/svg\+xml,/.test(base['background-image']) && /40px/.test(base['padding-right']) && base['-webkit-appearance'] === 'none');
t.ok('an empty one also gets the "mm/dd/yyyy" hint layer', !!empty && (empty['background-image'].match(/url\(/g) || []).length === 2 && /mm\/dd\/yyyy/.test(empty['background-image']));
t.ok('control: nothing outside html.nbd-ios (Android keeps its own drawing)', K.cssRule(rules, 'input[type="date"].nbd-date-empty') === null);

t.done();
