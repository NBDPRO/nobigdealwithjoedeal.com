/* customer-keyboard-actions.test.js
 *
 * 25 controls on docs/pro/customer.html carry data-action on a <div> or
 * <span> rather than a <button>: all 15 document-template cards, all 8
 * timeline filter pills, and both upload drop zones. The CSP action delegate
 * was registered on 'click' alone and none of them had tabindex or role — so
 * the entire Generate Documents feature and the entire timeline filter were
 * unreachable without a mouse and announced as plain text.
 *
 * The fix is one keydown listener beside the click delegate, so any element
 * that gains a data-action later is keyboard-operable by construction. This
 * suite RUNS that listener rather than matching its source, because the
 * subtle part is what it must NOT do: a <button> already turns Enter/Space
 * into a click, so handling the key there too would fire every action twice.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const HTML = read('docs/pro/customer.html');
const TASKS = read('docs/pro/js/customer-tasks-ui.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

/* ── every non-native data-action control is focusable and announced ── */
group('No mouse-only controls remain', () => {
  // Elements carrying data-action that are NOT natively focusable.
  const tags = [...HTML.matchAll(/<(div|span|li|td|p)\b([^>]*\bdata-action="[^"]+"[^>]*)>/g)];
  assert('found the non-native data-action controls', tags.length >= 25,
    'got ' + tags.length);

  const missingTab = tags.filter((m) => !/\btabindex="0"/.test(m[2]));
  const missingRole = tags.filter((m) => !/\brole="button"/.test(m[2]));

  assert('every one is focusable (tabindex="0")', missingTab.length === 0,
    missingTab.length ? missingTab.length + ' without tabindex, first: ' +
      missingTab[0][0].slice(0, 110) : '');
  assert('every one is announced as a control (role="button")', missingRole.length === 0,
    missingRole.length ? missingRole.length + ' without role, first: ' +
      missingRole[0][0].slice(0, 110) : '');

  // 16, not 15: +1 for storm_history_report (2026-09-09) — the free
  // NOAA/NWS 5-year storm history doc. Same count pinned in
  // tests/smoke/photo.test.js — keep both in sync.
  // 22 since the template library (2026-10-04): +lien waiver, right to cancel, material selection,
  // good-better-best, insurance scope letter, receipt.
  assert('the doc-template card wiring count is 22 (smoke pins this)',
    (HTML.match(/class="doc-template-card(?: [^"]*)?"[^>]*data-action="generateCustomerDoc"/g) || []).length === 22);

  assert('focused controls are visible',
    /\[data-action\]\[tabindex="0"\]:focus-visible \{[\s\S]{0,120}outline:/.test(HTML),
    'reachable by Tab but invisible while focused is worse than unreachable');
});

/* ── run the delegate ── */
const fnSrc = /document\.addEventListener\('keydown', function _nbdCustomerKeyDelegate\(e\) \{[\s\S]*?\n\}\);/.exec(TASKS);

group('The keydown delegate is present and liftable', () => {
  assert('_nbdCustomerKeyDelegate found', !!fnSrc);
});

function press(key, tagName, opts) {
  opts = opts || {};
  const dispatched = [];
  let defaultPrevented = false;
  const el = {
    tagName: tagName.toUpperCase(),
    dataset: opts.noAction ? {} : { action: 'generateCustomerDoc' },
  };
  const target = { closest: (sel) => (sel === '[data-action]' && !opts.noMatch ? el : null) };
  const sandbox = {
    document: {
      addEventListener: (type, fn) => { if (type === 'keydown') sandbox.__fire = fn; },
    },
    _nbdCustomerActionDispatch: (a, e2) => dispatched.push(a),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fnSrc[0], sandbox);
  sandbox.__fire({
    key,
    altKey: !!opts.alt, ctrlKey: !!opts.ctrl, metaKey: !!opts.meta,
    target,
    preventDefault: () => { defaultPrevented = true; },
  });
  return { dispatched, defaultPrevented };
}

if (fnSrc) {
  group('Enter and Space activate a non-native control', () => {
    for (const key of ['Enter', ' ', 'Spacebar']) {
      const r = press(key, 'div');
      assert('"' + key + '" on a <div> dispatches the action', r.dispatched.length === 1);
      assert('"' + key + '" also prevents default (no page scroll under Space)',
        r.defaultPrevented === true);
    }
  });

  group('Native controls are skipped so actions cannot fire twice', () => {
    for (const tag of ['button', 'a', 'input', 'select', 'textarea']) {
      const r = press('Enter', tag);
      assert('<' + tag + '> is left to the browser', r.dispatched.length === 0,
        'the browser already synthesises a click — handling it here would double-fire');
    }
  });

  group('It stays out of the way otherwise', () => {
    assert('other keys do nothing', press('a', 'div').dispatched.length === 0);
    assert('Tab does nothing', press('Tab', 'div').dispatched.length === 0);
    assert('Ctrl+Enter does nothing', press('Enter', 'div', { ctrl: true }).dispatched.length === 0);
    assert('Meta+Enter does nothing', press('Enter', 'div', { meta: true }).dispatched.length === 0);
    assert('Alt+Enter does nothing', press('Enter', 'div', { alt: true }).dispatched.length === 0);
    assert('an element with no data-action ancestor does nothing',
      press('Enter', 'div', { noMatch: true }).dispatched.length === 0);
    assert('a matched element with an empty action does nothing',
      press('Enter', 'div', { noAction: true }).dispatched.length === 0);
  });
}

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
