/**
 * tests/project-codex-quick-actions-2026-10-24.test.js
 *
 * Project Codex's Quick Action cards (Scope of Work, Follow-Up Email, ...)
 * threw on every click: the CSP migration moved them from inline onclick to
 * one delegated document listener, but runAction() still read the global
 * `event.currentTarget`, which is now `document` (no classList), so
 * `card.classList.add('loading')` threw before any request was made. Found
 * 2026-10-24 by the sample-account walk. The delegate now hands runAction
 * the card it found. A second, duplicate delegate (it ran every action twice,
 * so a fixed card would have sent two AI requests) is gone.
 *
 * Runs the real page script in a stub DOM and clicks a card through the
 * delegate.
 *
 * Run: node tests/project-codex-quick-actions-2026-10-24.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' -- ' + String(detail).slice(0, 300) : '')); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'project-codex-page.js'), 'utf8');

function el(attrs) {
  const cls = new Set();
  return {
    attrs: attrs || {}, style: {}, value: '', innerHTML: '', textContent: '',
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), _set: cls },
    getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
    addEventListener() {}, appendChild() {}, querySelectorAll() { return []; }, scrollIntoView() {},
    closest(sel) { return /data-pc-action/.test(sel) && this.attrs['data-pc-action'] ? this : null; }
  };
}

const card = el({ 'data-pc-action': 'runAction', 'data-arg': 'scope' });
const els = {};
const getEl = (id) => (els[id] = els[id] || el());
let clickHandler = null;
const calls = [];
const errors = [];
const sandbox = {
  console, setTimeout, Promise, JSON, Date, Number, String, Array, Object, Math,
  document: {
    addEventListener(type, fn) { if (type === 'click') clickHandler = fn; },
    querySelectorAll() { return []; },
    getElementById: getEl,
    createElement: () => el(),
    body: el(), documentElement: el()
  },
  navigator: {},
  // The global `event` the old code read: during a delegated click it is the
  // click event, whose currentTarget is the document.
  event: undefined,
  toast() {},
  callClaude: async (req) => { calls.push(req); return { content: [{ text: 'ok' }] }; }
};
sandbox.window = sandbox;
try { vm.runInNewContext(src, sandbox); } catch (e) { errors.push('load: ' + e.message); }
ok('the page script loads in the stub and registers its click delegate', typeof clickHandler === 'function', errors.join(' | '));

vm.runInNewContext('currentProject = { firstName: "Sample", lastName: "Owner", address: "1 Example St", stage: "new" };', sandbox);

(async () => {
  const evt = { target: card, currentTarget: sandbox.document };
  sandbox.event = evt;
  let threw = null;
  try { await clickHandler(evt); } catch (e) { threw = e; }
  // runAction is async and not awaited by the delegate: let it run.
  await new Promise((r) => setTimeout(r, 20));
  ok('clicking a Quick Action card through the delegate does not throw', !threw, threw && threw.message);
  ok('…and it reaches the AI request (Scope of Work)', calls.length === 1 && /Scope of Work/.test(String(calls[0] && calls[0].messages && calls[0].messages[0].content)), calls.length);
  ok('…with the card marked loading while it runs, and cleared after', !card.classList.contains('loading'));
  ok('runAction no longer reads the global event (a delegated click has no card there)', !/event\.currentTarget/.test(src));
  ok('one click delegate, so one click sends one request (a second delegate ran every action twice)', (src.match(/document\.addEventListener\('click'/g) || []).length === 1);
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.log('  FAIL unhandled rejection -- ' + (e && e.message)); process.exit(1); });
