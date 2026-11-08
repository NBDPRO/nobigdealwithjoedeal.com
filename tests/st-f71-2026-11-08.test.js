/**
 * tests/st-f71-2026-11-08.test.js — the setup wizard moves focus with the
 * step, and a double-tapped Skip runs once (CRM audit ST-F71, 2026-11-08).
 *
 * setStep() (docs/pro/js/pages/onboarding.js) toggled the step panels and
 * scrolled to the top but never moved focus, so a keyboard or screen-reader
 * user who pressed Next was left on a button inside a now-hidden panel. It
 * now focuses the new step's first field (the "Step 3 of 3" label on the
 * review step, which has no field, so a second Enter cannot finish setup
 * unseen). The first paint keeps focus where it is.
 *
 * skip() had no busy guard: the click delegate called it on every tap, so a
 * double tap ran the createCompany self-heal and the users/{uid} write twice
 * and navigated twice. A second call now returns at once, and both Skip
 * buttons are disabled with "Skipping…".
 *
 * Runs the real setStep and skip lifted into a vm against a fake DOM whose
 * fields come from docs/pro/onboarding.html.
 * Run: node tests/st-f71-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const OB = fs.readFileSync(path.join(ROOT, 'docs/pro/js/pages/onboarding.js'), 'utf8').replace(/\r\n/g, '\n');
const HTML = fs.readFileSync(path.join(ROOT, 'docs/pro/onboarding.html'), 'utf8').replace(/\r\n/g, '\n');
function slice(src, start, end) { const i = src.indexOf(start); if (i < 0) return ''; const j = src.indexOf(end, i); return j < 0 ? '' : src.slice(i, j + end.length); }
const SET_STEP = slice(OB, 'function setStep(n) {', '\n}');
const SKIP = slice(OB, 'async function skip() {', '\n}');
ok('control: setStep and skip are found', SET_STEP.length > 200 && SKIP.length > 300, SET_STEP.length + ' / ' + SKIP.length);

// The first form field inside each step panel, read from the real page.
function firstFieldId(n) {
  const i = HTML.indexOf('id="step' + n + '"');
  if (i < 0) return '';
  const m = HTML.slice(i).match(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/);
  return m ? m[1] : '';
}
ok('control: step 1 and step 2 each start with a field', firstFieldId(1) === 'obName' && firstFieldId(2) === 'obDisplayName', firstFieldId(1) + ' / ' + firstFieldId(2));

function el(id) {
  return { id, focused: 0, focusOpts: null, classList: { toggle() {} }, innerHTML: '', textContent: '', disabled: false,
    focus(o) { this.focused++; this.focusOpts = o; } };
}
function stepHarness() {
  const els = {};
  const $ = (id) => (els[id] = els[id] || el(id));
  ['obName', 'obDisplayName', 'stepLabel', 'finishBtn'].forEach($);
  [1, 2, 3].forEach((n) => {
    const panel = $('step' + n);
    panel.querySelector = (sel) => {
      const f = firstFieldId(n);
      return f && /input/.test(String(sel)) ? $(f) : null;
    };
  });
  const state = { step: 1 };
  const window = { scrollTo() {} };
  const sandbox = { state, $, window, showErr() {}, renderReview() {}, console };
  vm.createContext(sandbox);
  vm.runInContext(SET_STEP + '\nglobalThis.__s = setStep;', sandbox);
  return { setStep: sandbox.__s, els, state };
}

console.log('\nWIZARD STEPS: focus follows the step');
{
  const h = stepHarness();
  h.setStep(1);
  const anyFocus = Object.keys(h.els).filter((k) => h.els[k].focused);
  ok('first paint (boot calls setStep(1)): nothing is focused', anyFocus.length === 0, anyFocus.join(','));
  h.setStep(2);
  ok('Next to step 2 focuses its first field (Display Name)', h.els.obDisplayName.focused === 1, h.els.obDisplayName.focused);
  ok('…without a focus-driven scroll (the existing scrollTo(0, 0) keeps the top)', h.els.obDisplayName.focusOpts && h.els.obDisplayName.focusOpts.preventScroll === true);
  h.setStep(3);
  ok('Next to the review step focuses the step label', h.els.stepLabel.focused === 1, h.els.stepLabel.focused);
  ok('…which is made focusable by script (tabIndex -1, not in the Tab order)', h.els.stepLabel.tabIndex === -1, h.els.stepLabel.tabIndex);
  ok('…and the Finish button is NOT focused, so a second Enter cannot finish unseen', !(h.els.finishBtn && h.els.finishBtn.focused));
  h.setStep(1);
  ok('a validation bounce back to step 1 focuses Company Name', h.els.obName.focused === 1, h.els.obName.focused);
  h.setStep(1);
  ok('setStep to the step already shown does not re-focus', h.els.obName.focused === 1, h.els.obName.focused);
}
{
  const h = stepHarness();
  h.els.step2 = Object.assign(el('step2'), { querySelector: () => null });
  h.setStep(2);
  ok('a panel with no field does not throw', h.state.step === 2);
  const thrower = stepHarness();
  thrower.els.obDisplayName = Object.assign(el('obDisplayName'), { focus() { throw new Error('old browser'); } });
  let threw = null;
  try { thrower.setStep(2); } catch (e) { threw = e; }
  ok('a focus() that throws does not break the step change', !threw && thrower.state.step === 2, threw && threw.message);
}

console.log('\nSKIP: one tap, one run');
async function skipRun(claims) {
  const calls = { createCompany: 0, ensure: 0, setDoc: 0, toDashboard: 0 };
  const buttons = [el('skip1'), el('skip2')];
  const document = { querySelectorAll: (sel) => (sel === '[data-action="skip"]' ? buttons : []) };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const sandbox = {
    state: { user: { uid: 'u1', email: 'jo@example.test', displayName: 'Jo Example' }, claims },
    document, functions: {}, db: {}, console, String,
    httpsCallable: () => async () => { calls.createCompany++; await tick(); return { data: { ok: true } }; },
    ensureProvisioned: async (user, fn) => { calls.ensure++; await fn(); return true; },
    setDoc: async () => { calls.setDoc++; await tick(); },
    doc: (db, c, id) => c + '/' + id,
    serverTimestamp: () => 'ts',
    toDashboard: () => { calls.toDashboard++; },
  };
  vm.createContext(sandbox);
  vm.runInContext(SKIP + '\nglobalThis.__k = skip;', sandbox);
  const a = sandbox.__k();
  const b = sandbox.__k();
  await Promise.all([a, b]);
  return { calls, buttons };
}
(async () => {
  {
    const r = await skipRun({});
    ok('a double tap runs the createCompany self-heal once', r.calls.createCompany === 1 && r.calls.ensure === 1, JSON.stringify(r.calls));
    ok('…writes users/{uid} once', r.calls.setDoc === 1, r.calls.setDoc);
    ok('…and navigates once', r.calls.toDashboard === 1, r.calls.toDashboard);
    ok('both Skip buttons are disabled', r.buttons.every((x) => x.disabled === true));
    ok('…and say Skipping…', r.buttons.every((x) => x.textContent === 'Skipping…'), r.buttons.map((x) => x.textContent).join(' | '));
  }
  {
    const r = await skipRun({ companyId: 'u1' });
    ok('an already-provisioned skipper still skips (no createCompany, one write, one navigation)', r.calls.createCompany === 0 && r.calls.setDoc === 1 && r.calls.toDashboard === 1, JSON.stringify(r.calls));
  }
  ok('both Skip buttons on the page carry data-action="skip"', (HTML.match(/data-action="skip"/g) || []).length === 2);
  ok('this suite is in the node bucket', fs.readFileSync(path.join(ROOT, 'tests/ci-manifest.json'), 'utf8').indexOf('"st-f71-2026-11-08.test.js"') >= 0);
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
