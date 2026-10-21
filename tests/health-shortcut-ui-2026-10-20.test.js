/**
 * tests/health-shortcut-ui-2026-10-20.test.js
 *
 * The tracker's Apple Health card (docs/pro/daily-success/js/health-shortcut-ui.js)
 * in a vm sandbox with a stub document. Every check has a control.
 *
 * Run: node tests/health-shortcut-ui-2026-10-20.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const SRC = fs.readFileSync(path.join(DS, 'js', 'health-shortcut-ui.js'), 'utf8');
const HTML = fs.readFileSync(path.join(DS, 'index.html'), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

function load() {
  const listeners = {};
  const win = {};
  const doc = {
    readyState: 'complete', getElementById: () => null,
    addEventListener: (t, fn) => { listeners[t] = fn; },
  };
  const ctx = { window: win, document: doc, navigator: {}, setTimeout: () => 0, console };
  win.window = win; win.document = doc;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ui: win.NBDHealthShortcutUI, win, listeners };
}

const KEY = 'nbdh_' + 'A'.repeat(43);
const on = { available: true, enabled: true, lastAt: Date.now(), lastDate: '2026-10-20', lastWeightLbs: 185.2, lastResult: 'written', endpoint: 'https://us-central1-nobigdeal-pro.cloudfunctions.net/healthShortcutIngest' };

console.log('\nVISIBILITY (dark by default)');
{
  const { ui } = load();
  ok('before the server answers: renders nothing', ui.cardHtml() === '');
  ui._state({ available: false, enabled: false });
  ok('server says available:false (flag off): renders nothing', ui.cardHtml() === '');
  ui._state({ available: true, enabled: false });
  const h = ui.cardHtml();
  ok('control: available:true renders the card, off by default with a Create button', h.includes('id="hsCard"') && h.includes('data-hs-action="create"') && !h.includes('Rotate'));
  ok('off state shows no key, no Turn off, no steps', !h.includes('nbdh_') && !h.includes('data-hs-action="off"') && !h.includes('<ol'));
}

console.log('\nON STATE');
{
  const { ui } = load();
  ui._state(on);
  const h = ui.cardHtml();
  ok('shows the last reading (weight, date) and the result', h.includes('185.2 lb') && h.includes('2026-10-20') && h.includes('Saved to that day'));
  ok('has Rotate and Turn off, and no Create', h.includes('data-hs-action="rotate"') && h.includes('data-hs-action="off"') && !h.includes('data-hs-action="create"'));
  ok('never contains a key', !h.includes('nbdh_'));
  ui._state(Object.assign({}, on, { lastAt: null, lastDate: null, lastWeightLbs: null, lastResult: null }));
  ok('nothing received yet: says so', ui.cardHtml().includes('Nothing received yet'));
  ui._state(Object.assign({}, on, { lastResult: 'hand_entered' }));
  ok('hand_entered result explains the kept weight', ui.cardHtml().includes('Kept the weight you typed'));
  ui._state(on); ui._arm('rotate');
  ok('rotate is a two-tap action: the armed label warns that the old key stops', ui.cardHtml().includes('Tap again: old key stops working'));
  ui._arm('off');
  ok('turn off is a two-tap action', ui.cardHtml().includes('Tap again to turn off'));
}

console.log('\nTHE KEY IS SHOWN ONCE');
{
  const { ui } = load();
  ui._state(on); ui._reveal(KEY);
  const h = ui.cardHtml();
  ok('revealed: the key is in a read-only box with a Copy button and the only-time warning', h.includes('value="' + KEY + '"') && h.includes('readonly') && h.includes('data-hs-action="copy"') && h.includes('only time it is shown'));
  ok('the steps name every Shortcuts action, the header and the JSON fields',
    ['Find Health Samples', 'Get Details of Health Samples', 'Format Date', 'yyyy-MM-dd', 'Get Contents of URL', 'POST', 'Authorization', 'Bearer', 'weightLbs', 'Automation', 'Run Immediately', 'lb'].every((s) => h.includes(s)));
  ok('the endpoint URL is in the steps', h.includes('healthShortcutIngest'));
  ui._reveal(null);
  ok('control: after Done the key is gone from the card', !ui.cardHtml().includes(KEY));
  ok('control: the key is not in any hidden attribute other than the readonly box (one occurrence)', (function () { ui._reveal(KEY); return ui.cardHtml().split(KEY).length - 1; })() === 1);
}

console.log('\nESCAPING');
{
  const { ui } = load();
  ui._state(Object.assign({}, on, { lastDate: '<img src=x onerror=alert(1)>', lastWeightLbs: '"><script>x</script>', endpoint: '<b onmouseover=1>' }));
  ui._err('<svg onload=1>');
  const h0 = ui.cardHtml();
  ui._reveal('"><script>alert(1)</script>');
  const h = h0 + ui.cardHtml();
  ok('server-supplied strings are escaped everywhere (no raw < from data)', !/<img src=x|<script>alert|<svg onload|<b onmouseover/.test(h) && h.includes('&lt;img') && h.includes('&lt;svg onload'));
  ok('control: the card\'s own markup still has real tags', h.includes('<div class="wc-card hs-card"'));
}

console.log('\nCSP + WIRING');
{
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
  ok('no inline on* handlers in the generated markup', !/\son[a-z]+=/.test(code.replace(/\bon[A-Z]\w*/g, '')) || !/'\s*<[^']*\son[a-z]+=/.test(code));
  ok('one delegated document click listener, no per-element listeners', (code.match(/addEventListener\('click'/g) || []).length === 1 && !/\.onclick\s*=/.test(code));
  ok('the key is never written to storage', !/localStorage|sessionStorage|indexedDB/.test(code));
  ok('index.html loads the script (external, deferred) and the stylesheet', /<script src="\/pro\/daily-success\/js\/health-shortcut-ui\.js\?v=1" defer><\/script>/.test(HTML) && HTML.includes('/pro/daily-success/css/health-shortcut.css'));
  ok('the card calls only healthShortcutManage', (code.match(/httpsCallable\(/g) || []).length === 1 && code.includes("'healthShortcutManage'"));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
