/* customer-quick-actions.test.js
 *
 * Two things, both learned the hard way on 2026-09-07.
 *
 * 1. The header action bar.
 *    .quick-actions carried `position:sticky; top:0` under a comment saying
 *    the "always visible" spec "now is" met. It never was: the bar is the
 *    LAST CHILD of .customer-header, and a sticky element is clipped to its
 *    containing block, so it travelled the header's ~24px of bottom padding
 *    and then scrolled away. Separately, at <=900px the 2-column grid of
 *    48px buttons measured 334px — 388px once #stageProgressBtn unhides —
 *    on a 390px screen, so a rep opening a customer saw a wall of buttons
 *    instead of the customer.
 *
 * 2. A page must actually LOAD the module its code calls.
 *    #1458 added the booking-events.js <script> tag to portal.html but not
 *    customer.html, because the edit helper's substitution closure read a
 *    stale source string and silently dropped the change. Nothing failed —
 *    window.NBDBooking was simply undefined, options() returned [], and the
 *    booking buttons stopped rendering entirely. No error, no test, no
 *    symptom until someone opened the page. The last group here is a
 *    dependency check for that whole class of bug, not just this instance.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const HTML = read('docs/pro/customer.html');
const MOD = read('docs/pro/js/customer-quick-actions.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

group('The bar no longer claims a stickiness it cannot have', () => {
  const rule = HTML.match(/\.quick-actions \{[\s\S]*?\n\}/);
  assert('.quick-actions rule found', !!rule);
  if (rule) {
    // The rule's own comment QUOTES the removed declarations to explain why
    // they must not come back, so assert against declarations only. (This
    // suite matched its own prose three separate times while being written.)
    const decls = rule[0].replace(/\/\*[\s\S]*?\*\//g, ' ');
    assert('no position:sticky on .quick-actions', !/position:\s*sticky/.test(decls),
      'it is the last child of .customer-header — sticky is clipped to that box');
    assert('and no top/z-index left behind from it',
      !/\btop:\s*0/.test(decls) && !/z-index/.test(decls));
    assert('the comment says why, so nobody re-adds it',
      /NOT sticky, deliberately/.test(rule[0]) && /last child/i.test(rule[0]));
  }
  // .jump-nav is the one that genuinely pins; do not let this fix take it out.
  const nav = HTML.match(/\.jump-nav \{[\s\S]*?\n\}/);
  assert('.jump-nav is still sticky (it is a sibling of the header, so it works)',
    !!nav && /position:\s*sticky/.test(nav[0]));
});

group('Phones collapse the bar instead of surrendering the screen', () => {
  assert('a collapsed-state rule exists',
    /\.quick-actions\[data-qa-collapsed="1"\] \.qa-more \{ display:none !important; \}/.test(HTML));
  assert('it lives inside the <=900px block',
    /@media \(max-width:900px\)[\s\S]{0,1400}data-qa-collapsed/.test(HTML),
    'collapsing on desktop would hide controls that fit fine');
  assert('desktop force-hides the toggle',
    /@media \(min-width:901px\)[\s\S]{0,400}#qaMoreBtn \{ display:none !important; \}/.test(HTML));
  assert('!important is used — a class must beat the inline display a module writes when it unhides a conditional button',
    /\.qa-more \{ display:none !important; \}/.test(HTML));
});

group('The module is loaded, CSP-clean, and decides membership safely', () => {
  assert('customer.html loads customer-quick-actions.js with defer',
    /<script defer src="js\/customer-quick-actions\.js\?v=\d+"><\/script>/.test(HTML));
  assert('module has no inline handler and uses a data-action toggle',
    /setAttribute\('data-action', 'toggleQuickActions'\)/.test(MOD));
  assert('the toggle function is on window for the delegate to resolve',
    /window\.toggleQuickActions = function/.test(MOD));
  // Strip comments: the module explains WHY it avoids nth-child and why it
  // never writes .style.display, and the first draft of these two assertions
  // matched that prose instead of the code.
  const modCode = MOD
    // Line-wise: a /\*...\*/ regex swallows real code in these files (they
    // contain comment-looking sequences inside regex literals and strings —
    // measured 10-48% of the file destroyed), which makes ABSENCE assertions
    // pass against a corpus that no longer holds the region they guard.
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
  assert('membership is an explicit ID allowlist, not nth-child',
    /PRIMARY_IDS = \[/.test(modCode) && !/nth-child/.test(modCode),
    'four controls unhide later, so position does not track what is visible');
  // `=(?!=)` so the read in ownerHidden (`el.style.display === 'none'`) is
  // not mistaken for a write.
  assert('the module never writes element.style.display',
    !/\.style\.display\s*=(?!=)/.test(modCode),
    'writing display would fight the inline display:none that gates conditional buttons');
  assert('it re-counts when other modules unhide their buttons',
    /MutationObserver/.test(MOD));
  assert('primary set keeps the rep able to reach the customer and move the job',
    /'callLink'/.test(MOD) && /'smsBookingLink'/.test(MOD) && /'emailLink'/.test(MOD) && /'stageProgressBtn'/.test(MOD));
});

/* ── the dependency check that would have caught the #1458 drop ── */
group('Every /pro page that uses a shared global actually loads the module defining it', () => {
  const PROVIDERS = [
    { global: 'NBDBooking', file: 'booking-events.js' },
  ];

  const pages = fs.readdirSync(path.join(ROOT, 'docs/pro'))
    .filter((f) => f.endsWith('.html'));

  for (const p of PROVIDERS) {
    // Which /pro modules reference the global?
    const jsDir = path.join(ROOT, 'docs/pro/js');
    const users = fs.readdirSync(jsDir)
      .filter((f) => f.endsWith('.js') && f !== p.file)
      .filter((f) => new RegExp('window\\.' + p.global + '\\b').test(
        fs.readFileSync(path.join(jsDir, f), 'utf8')));

    assert('found consumers of window.' + p.global, users.length > 0,
      'if this drops to zero the provider is dead code — check before deleting the assertion');

    for (const page of pages) {
      const html = read('docs/pro/' + page);
      const loadsAUser = users.some((u) => html.includes('js/' + u));
      if (!loadsAUser) continue;                       // page doesn't use it
      const loadsProvider = html.includes('js/' + p.file);
      assert(page + ' loads ' + p.file + ' (it loads a consumer of window.' + p.global + ')',
        loadsProvider,
        'consumer(s): ' + users.filter((u) => html.includes('js/' + u)).join(', ') +
        ' — without the provider the global is undefined and the feature silently no-ops');
    }
  }
});

/* ── behaviour: actually run the module ──────────────────────────────────
 * Everything above pins source text. This runs customer-quick-actions.js in
 * a vm against a DOM stub, so a rewrite that keeps the strings but breaks
 * the logic still fails here. The stub deliberately includes two
 * owner-hidden controls (#stageProgressBtn and #gallerySharePanel, both
 * style="display:none" in the markup) because the two things most likely to
 * regress are the More count including them and the module resurrecting
 * them. */
const vm = require('vm');

function makeEl(tag, props) {
  props = props || {};
  const el = {
    tagName: tag.toUpperCase(), nodeType: 1,
    id: props.id || '', style: props.style || {}, hidden: false,
    _attrs: Object.assign({}, props.attrs), children: [], _classes: new Set(),
    textContent: '', type: '', className: '',
    getAttribute(n) { return n in this._attrs ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    removeAttribute(n) { delete this._attrs[n]; },
    hasAttribute(n) { return n in this._attrs; },
    appendChild(c) { this.children.push(c); return c; },
  };
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    contains: (c) => el._classes.has(c),
  };
  return el;
}

function runModule(width) {
  const bar = makeEl('div');
  bar._classes.add('quick-actions');
  const kids = [
    makeEl('a', { id: 'callLink' }),
    makeEl('a', { id: 'smsBookingLink' }),
    makeEl('a', { id: 'emailLink' }),
    makeEl('button', { id: 'stageProgressBtn', style: { display: 'none' } }),
    makeEl('button', { attrs: { 'data-action': 'exportCustomerPDF' } }),
    makeEl('button', { attrs: { 'data-action': 'quickCopyPortalLink' } }),
    makeEl('button', { attrs: { 'data-action': 'quickSmsPortalLink' } }),
    makeEl('div', { id: 'gallerySharePanel', style: { display: 'none' } }),
  ];
  kids.forEach((k) => bar.children.push(k));
  const byId = {};
  const reindex = () => bar.children.forEach((c) => { if (c.id) byId[c.id] = c; });
  reindex();
  const document = {
    readyState: 'complete',
    querySelector: (s) => (s === '.quick-actions' ? bar : null),
    getElementById: (id) => { reindex(); return byId[id] || null; },
    createElement: (t) => makeEl(t),
    addEventListener() {},
  };
  const window = {
    document,
    matchMedia: (q) => {
      const m = /max-width:\s*(\d+)px/.exec(q);
      return { matches: m ? width <= Number(m[1]) : false };
    },
    addEventListener() {},
  };
  const sandbox = {
    window, document, console, setTimeout, clearTimeout,
    MutationObserver: function () { this.observe = function () {}; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(MOD, sandbox);
  return { bar, window, kids };
}

group('Behaviour on a 390px phone', () => {
  let r = null, threw = null;
  try { r = runModule(390); } catch (e) { threw = e; }
  assert('module loads without throwing', !threw, threw ? String(threw) : '');
  if (!r) return;
  const { bar, window, kids } = r;
  const more = () => bar.children.filter((c) => c.id === 'qaMoreBtn')[0];

  assert('collapsed by default', bar.getAttribute('data-qa-collapsed') === '1');
  assert('primary controls are not marked .qa-more',
    ['callLink', 'smsBookingLink', 'emailLink', 'stageProgressBtn']
      .every((id) => !kids.filter((k) => k.id === id)[0]._classes.has('qa-more')));
  assert('secondary controls are marked .qa-more',
    kids.filter((k) => k.getAttribute('data-action')).every((k) => k._classes.has('qa-more')));
  assert('a More toggle is created', !!more());
  assert('the toggle is a data-action, not an inline handler',
    !!more() && more().getAttribute('data-action') === 'toggleQuickActions');
  assert('the count excludes owner-hidden controls',
    !!more() && more().textContent === 'More (3)',
    more() ? 'got "' + more().textContent + '"' : '');
  assert('no control had style.display written by the module',
    kids.every((k) => (k.id === 'stageProgressBtn' || k.id === 'gallerySharePanel')
      ? k.style.display === 'none'
      : k.style.display === undefined));

  window.toggleQuickActions();
  assert('toggle expands', bar.getAttribute('data-qa-collapsed') === '0');
  assert('label flips to Fewer', !!more() && more().textContent === 'Fewer');
  window.toggleQuickActions();
  assert('toggle collapses again', bar.getAttribute('data-qa-collapsed') === '1');
});

group('Behaviour on desktop', () => {
  const { bar } = runModule(1440);
  assert('never collapsed at 1440px', !bar.hasAttribute('data-qa-collapsed'));
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
