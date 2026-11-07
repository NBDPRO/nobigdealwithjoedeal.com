/**
 * tests/pipeline-small-2026-11-06.test.js — CRM audit 2026-11-06, pipeline P3s.
 *
 * PL-F19 crm-pipeline.js legacy drop handler: no stopPropagation, so a drop
 *        also reached the board-level handler and moveCard ran twice.
 * PL-F29 kanban-context-menu.js long press: the once-click suppressor stayed
 *        armed when iOS sent no click, and ate the next real tap on the card.
 * PL-F24 dashboard.html #nav-admin: the one sidebar item without role/tabindex.
 * Zero deps. Run: node tests/pipeline-small-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8').replace(/\r\n/g, '\n');

console.log('LEGACY DROP (PL-F19)');
{
  const P = read('crm-pipeline.js');
  const s = P.indexOf('      // W103: same race-safe drop as the new-system path above.\n      const dropH = e => {');
  const blk = s >= 0 ? P.slice(s, P.indexOf('\n      };\n', s) + 10) : '';
  ok('the legacy dropH is found (positive control)', /moveCard\(draggedId, stage,/.test(blk));
  // Run it: a fake event that records stopPropagation; moveCard stubbed.
  const calls = []; let stopped = 0;
  const sb = { body: { classList: { remove() {} } }, stage: 'won', _dragId: null, window: {}, moveCard: (...a) => calls.push(a) };
  vm.createContext(sb);
  vm.runInContext(blk.replace('const dropH', 'globalThis.dropH'), sb);
  sb.dropH({ preventDefault() {}, stopPropagation() { stopped++; }, dataTransfer: { getData: (t) => (t === 'text/plain' ? 'L1' : 'J1') } });
  ok('it still moves the dropped card once (positive control)', calls.length === 1 && calls[0][0] === 'L1' && calls[0][2].jobId === 'J1');
  ok('it stops the drop reaching the board-level handler', stopped === 1);
}

console.log('LONG PRESS CLICK SUPPRESSOR (PL-F29)');
{
  const K = read('kanban-context-menu.js');
  const fn = (() => { const s = K.indexOf('  function onTouchStart(ev) {'); return s >= 0 ? K.slice(s, K.indexOf('\n  }\n', s) + 4) : ''; })();
  ok('onTouchStart is found (positive control)', /suppressClick/.test(fn));
  const timers = [];
  const listeners = {};
  const card = {
    isConnected: true,
    getAttribute: (k) => (k === 'data-id' ? 'L1' : null),
    addEventListener(t, f, o) { (listeners[t] = listeners[t] || []).push({ f, o }); },
    removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter((x) => x.f !== f); },
  };
  const sb = {
    findCardEl: () => card, findLead: () => ({ id: 'L1' }), buildMenu() {}, LONG_PRESS_MS: 500,
    touchTimer: null, touchStart: null, navigator: {},
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout() {},
  };
  vm.createContext(sb);
  vm.runInContext('var touchTimer = null, touchStart = null;\n' + fn + '\nglobalThis.__ts = onTouchStart;', sb);
  sb.__ts({ target: card, touches: [{ clientX: 1, clientY: 1 }] });
  const press = timers.shift(); press && press.f();
  ok('the long press arms the click suppressor (positive control)', (listeners.click || []).length === 1);
  (listeners.touchend || []).forEach((x) => x.f());
  timers.splice(0).forEach((t) => t.f());
  ok('once the finger lifts, the suppressor is disarmed (the next tap is not eaten)', (listeners.click || []).length === 0, String((listeners.click || []).length));
  ok('touchcancel disarms it too', (listeners.touchcancel || []).length === 1);
}

console.log('TEAM MANAGER NAV (PL-F24)');
{
  const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'dashboard.html'), 'utf8');
  const tag = (HTML.match(/<div class="ni[^"]*"[^>]*id="nav-admin"[^>]*>/) || [''])[0];
  ok('#nav-admin is found (positive control)', !!tag);
  ok('it is a focusable button like every other sidebar item', /role="button"/.test(tag) && /tabindex="0"/.test(tag), tag);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
