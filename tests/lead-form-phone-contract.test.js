/**
 * tests/lead-form-phone-contract.test.js — every public lead form checks for
 * a real 10-digit phone BEFORE it sends, with one shared rule.
 *
 * WHY THIS EXISTS (2026-09-13)
 * ────────────────────────────
 * Jo's lanes: "a phone number on every request." The first-party forms had
 * three different phone checks and one had none:
 *   - /inspect posted blind (`novalidate`, no client check). A missing phone
 *     reached the gateway, which answers a bare 400 "Invalid submission" and
 *     keeps nothing; the homeowner saw that string and the lead was gone.
 *   - the homepage contact form checked only that the field was non-empty, so
 *     "555" reached Joe as a lead he could not call back.
 *   - /storm-report, /storm-check, /roof-score and /storm-alerts used
 *     `digits.length < 10`, which lets an 11-to-15-digit typo through.
 * /estimate already used `=== 10`. They now share one rule: strip non-digits,
 * drop a leading country-code 1, require exactly 10.
 *
 * The /inspect handler is EXECUTED here in a vm sandbox against a fake form
 * (a 9-digit number must not reach submitPublicLead; a 10-digit one must),
 * and every other form is checked for the shared rule inside the slice of
 * code that runs before its submit call — sliced from raw source, comment
 * lines stripped from the slice only.
 *
 * Zero deps. Run: node tests/lead-form-phone-contract.test.js
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

const RULE_CORE = ".replace(/\\D/g, '').replace(/^1/, '').length";
const RULE_RE = /\.replace\(\/\\D\/g, ''\)\.replace\(\/\^1\/, ''\)\.length\s*(===|!==)\s*10/;

console.log('\nTHE RULE — executed on real-world inputs');
{
  const isUs = new Function('v', 'return String(v)' + RULE_CORE + ' === 10;');
  const cases = [
    ['(859) 555-0100', true], ['859-555-0100', true], ['8595550100', true],
    ['+1 (859) 555-0100', true], ['1-859-555-0100', true],
    ['859555010', false], ['85955501001', false], ['+1 859 555 01000', false],
    ['555', false], ['', false], ['call me', false],
  ];
  for (const [input, want] of cases) ok(`${JSON.stringify(input)} → ${want}`, isUs(input) === want);
}

console.log('\nEVERY FORM — the shared rule runs before its submit call');
function sliceBefore(rel, fromMarker, toMarker) {
  const src = read(rel);
  const from = src.indexOf(fromMarker);
  const to = src.indexOf(toMarker, from === -1 ? 0 : from);
  if (from === -1 || to === -1) return null;
  return src.slice(from, to).split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
}
const FORMS = [
  ['docs/assets/js/storm-report-page.js', 'function unlock()', "window.submitPublicLead('inspect', payload)"],
  ['docs/assets/js/storm-check.js', 'function submitLead()', "window.submitPublicLead('inspect', payload)"],
  ['docs/assets/js/roof-score.js', 'function submitLead()', "window.submitPublicLead('inspect', payload)"],
  ['docs/assets/js/inline/c5a2295382.js', "const hp = document.getElementById('alertHoneypot')", 'window._saveStormAlert'],
  ['docs/assets/js/inline/72f02d79d0.js', 'async function submitForm()', 'window._captureContactLead({'],
  ['docs/assets/js/inspect-form.js', 'function isUsPhone(v)', "window.submitPublicLead('inspect', data)"],
];
for (const [rel, from, to] of FORMS) {
  const slice = sliceBefore(rel, from, to);
  ok(`${rel}: markers found (a moved marker would pass the next check vacuously)`, slice !== null && slice.length > 40);
  ok(`${rel}: the shared 10-digit rule is in the code that runs before the submit`, !!slice && RULE_RE.test(slice));
  ok(`${rel}: no bare "length < 10" check left before the submit`, !!slice && !/length\s*<\s*10/.test(slice));
}
ok('/estimate keeps its own exact-10 checks (the model the rule was aligned to)', (read('docs/assets/js/inline/4053149b2f.js').match(/length\s*[!=]==\s*10/g) || []).length >= 3);

console.log('\n/inspect — the handler, executed against a fake form');
function runInspect({ name, address, phone, response }) {
  const calls = [];
  const els = {};
  const mk = (id, props = {}) => {
    const el = Object.assign({
      id, value: '', attrs: {}, textContent: '', disabled: false, style: {}, classList: { add() {} },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
      focus() { focused.push(id); }, remove() { delete els[id]; if (form.children) form.children = form.children.filter((c) => c !== this); },
      scrollIntoView() {},
    }, props);
    els[id] = el; return el;
  };
  const focused = [];
  let submitHandler = null;
  const form = mk('inspectForm', {
    children: [],
    addEventListener(type, fn) { if (type === 'submit') submitHandler = fn; },
    appendChild(c) { this.children.push(c); if (c.id) els[c.id] = c; },
    querySelector() { return null; },
    fields: () => ({ name: els['f-name'].value, address: els['f-address'].value, phone: els['f-phone'].value, email: '', nbd_hp: '' }),
  });
  mk('f-name', { value: name }); mk('f-address', { value: address }); mk('f-phone', { value: phone });
  // TCPA consent box (2026-10-03) — ticked, so these cases test the phone rule.
  mk('ins-consent', { checked: true });
  mk('inspectSubmit', { textContent: 'Request Free Inspection' }); mk('inspectSuccess');
  const document = {
    readyState: 'complete',
    getElementById: (id) => els[id] || null,
    createElement: () => mk('__new' + Object.keys(els).length),
    addEventListener() {},
  };
  function FormData(f) { this._f = f.fields(); }
  FormData.prototype.forEach = function (cb) { Object.keys(this._f).forEach((k) => cb(this._f[k], k)); };
  const window = {
    location: { search: '' },
    submitPublicLead: (kind, data) => { calls.push({ kind, data }); return Promise.resolve(response || { ok: true }); },
  };
  vm.runInNewContext(read('docs/assets/js/inspect-form.js'), { window, document, FormData, URLSearchParams, console: { error() {}, warn() {}, log() {} } });
  if (!submitHandler) throw new Error('inspect-form.js registered no submit handler');
  submitHandler({ preventDefault() {} });
  return { calls, els, form, focused, errorText: () => (els.inspectFormError || {}).textContent || '' };
}
(async () => {
  {
    const r = runInspect({ name: 'Pat Example', address: '12 Elm St', phone: '859555010' });
    await new Promise((res) => setImmediate(res));
    ok('a 9-digit phone never reaches submitPublicLead', r.calls.length === 0, r.calls);
    ok('…the homeowner is told to add a 10-digit mobile number', /10-digit mobile number/.test(r.errorText()), r.errorText());
    ok('…the phone field is marked aria-invalid and focused', r.els['f-phone'].attrs['aria-invalid'] === 'true' && r.focused[0] === 'f-phone');
    ok('…and the button stays usable', r.els.inspectSubmit.disabled === false);
  }
  {
    const r = runInspect({ name: '', address: '', phone: '' });
    await new Promise((res) => setImmediate(res));
    ok('an empty form never reaches submitPublicLead', r.calls.length === 0);
    ok('…the message names all three fields', /name, the property address and a 10-digit mobile number/.test(r.errorText()), r.errorText());
    ok('…the first invalid field (name) gets focus', r.focused[0] === 'f-name', r.focused);
  }
  {
    const r = runInspect({ name: 'Pat Example', address: '12 Elm St, Goshen OH', phone: '+1 (859) 555-0100' });
    await new Promise((res) => setImmediate(res));
    ok('a valid form reaches submitPublicLead exactly once, as kind "inspect"', r.calls.length === 1 && r.calls[0].kind === 'inspect', r.calls);
    ok('…carrying the phone as typed and source /inspect', r.calls.length === 1 && r.calls[0].data.phone === '+1 (859) 555-0100' && r.calls[0].data.source === '/inspect');
    ok('…and clears aria-invalid on the phone', r.els['f-phone'].attrs['aria-invalid'] === 'false');
  }
  {
    const r = runInspect({ name: 'Pat Example', address: '12 Elm St', phone: '8595550100', response: { ok: false, reason: 'Invalid submission' } });
    await new Promise((res) => setImmediate(res)); await new Promise((res) => setImmediate(res));
    ok('the gateway\'s opaque "Invalid submission" is translated into what to check', /Check your name, address and 10-digit mobile number/.test(r.errorText()), r.errorText());
  }

  console.log('\nMARKUP');
  {
    const html = read('docs/inspect.html');
    ok('/inspect labels the field "Mobile phone"', /<label for="f-phone">Mobile phone<\/label>/.test(html));
    ok('/inspect phone input is type=tel with a placeholder', /<input type="tel" id="f-phone"[^>]*placeholder="\(859\) 555-1234"/.test(html));
    ok('/inspect carries the nbd_hp honeypot, keyboard-invisible, autocomplete off', /<input type="text" id="f-nbd-hp" name="nbd_hp" tabindex="-1" autocomplete="off">/.test(html));
    ok('the homepage contact form labels the field "Mobile phone"', /<label for="fieldPhone">Mobile phone <span class="req">\*<\/span><\/label>/.test(read('docs/index.html')));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
