// CRM audit 2026-11-06 — PL-F28, VW-F166, VW-F15, VW-F56.
// Each check runs the shipped function where it can, so a revert fails here.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function check(name, ok) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name); }
}
// Lift a function declared at a given indent ("" top level, "  " in an IIFE).
function lift(src, name, indent) {
  const lines = src.split(/\r?\n/);
  const re = new RegExp('^' + indent + '(async )?function ' + name + '\\(');
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return '';
  const j = lines.findIndex((l, k) => k > i && l === indent + '}');
  return j < 0 ? '' : lines.slice(i, j + 1).join('\n');
}

(async () => {
  // ── PL-F28: the list view reads money like the board ─────────────
  {
    const src = read('docs/pro/js/crm-list-view.js');
    const fn = lift(src, '_money', '  ');
    const ctx = { window: {} };
    if (fn) vm.runInNewContext(fn + '\nout = [_money("$45,000"), _money(1200), _money(""), _money(null)];', ctx);
    check('PL-F28: a legacy "$45,000" reads 45000', !!ctx.out && ctx.out[0] === 45000 && ctx.out[1] === 1200 && ctx.out[2] === 0 && ctx.out[3] === 0);
    const ctx2 = { window: { NBDCustomerEstimateRows: { moneyValue: () => 7 } } };
    if (fn) vm.runInNewContext(fn + '\nout = _money("x");', ctx2);
    check('PL-F28: it uses the shared money reader when loaded', ctx2.out === 7);
    check('PL-F28: no Number(l.jobValue) left in the list view', !/Number\(\s*l\.jobValue\s*\)/.test(src));
  }

  // ── VW-F166: a failed persona read never lets Save overwrite it ───
  {
    const src = read('docs/pro/js/ai-texting-persona.js');
    const load = lift(src, 'load', '  ');
    const save = lift(src, 'doSave', '  ');
    const statuses = [];
    let writes = 0;
    const ctx = {
      window: { db: {}, doc: () => ({}), getDoc: async () => { throw new Error('unavailable'); }, setDoc: async () => { writes++; } },
      freshConfig: () => ({}), uid: () => 'u1', setStatus: (m, k) => statuses.push([m, k]),
      configPayload: () => ({}), PRESETS: [{ traits: {} }], defaultName: () => '', console: { warn() {} },
      saving: false, state: null,
    };
    let ok = !!(load && save);
    try { vm.runInNewContext('var loadFailed = false;\n' + load + '\n' + save + '\nout = load().then(doSave).then(() => loadFailed);', ctx); } catch (e) { ok = false; }
    const lf = ok ? await ctx.out : false;
    check('VW-F166: a failed persona read is recorded', lf === true);
    check('VW-F166: Save writes nothing after a failed read', ok && writes === 0);
    check('VW-F166: Save says why it is off', statuses.some(([m, k]) => /save is off/i.test(m) && k === 'error'));
    check('VW-F166: the tab says the persona did not load', /if \(loadFailed\) setStatus\(/.test(src));
  }

  // ── VW-F15: a playing recording survives a re-render ─────────────
  {
    const src = read('docs/pro/js/call-center-view.js');
    const fn = lift(src, 'render', '  ');
    const audio = { tag: 'audio' };
    let appended = null;
    const oldSlot = { getAttribute: () => 'call1' };
    audio.parentNode = oldSlot;
    const newSlot = { querySelector: () => null, appendChild: (a) => { appended = a; } };
    const el = {
      querySelectorAll: (sel) => (/audio/.test(sel) ? [audio] : []),
      querySelector: (sel) => (sel.includes('call1') ? newSlot : null),
    };
    let rendered = 0;
    const ctx = { root: () => el, renderList: () => { rendered++; }, CSS: { escape: (s) => s } };
    let ok = !!fn;
    try { vm.runInNewContext(fn + '\nrender();', ctx); } catch (e) { ok = false; }
    check('VW-F15: render still rebuilds the list', ok && rendered === 1);
    check('VW-F15: the same <audio> element goes back into the new row', appended === audio);
    check('VW-F15: blob URLs are revoked when the page goes', /pagehide[\s\S]{0,200}revokeObjectURL/.test(src));
  }

  // ── VW-F56: Docs template rows and the fill modal by keyboard ─────
  {
    const src = read('docs/pro/js/dashboard-ui.js');
    const fn = lift(src, '_injectBlankButtons', '');
    const mk = (cls) => {
      const attrs = {}, h = {};
      return {
        cls, tabIndex: -1, clicks: 0, attrs,
        classList: { contains: (c) => c === cls },
        hasAttribute: (k) => k in attrs, setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k],
        addEventListener: (t, f) => { h[t] = f; }, fire: (t, e) => h[t] && h[t](e),
        click() { this.clicks++; }, querySelector: () => ({}),
      };
    };
    const row = mk('tl-doc-row'), head = mk('tl-cat-header');
    const document = { querySelectorAll: (sel) => (sel.includes('tl-cat-header') ? [row, head] : []) };
    let ok = !!fn;
    try { vm.runInNewContext(fn + '\n_injectBlankButtons(); _injectBlankButtons();', { document, window: {} }); } catch (e) { ok = false; }
    check('VW-F56: template rows and category headers are in the Tab order', ok && row.tabIndex === 0 && head.tabIndex === 0);
    check('VW-F56: a category header is a button to assistive tech', head.attrs.role === 'button' && row.attrs.role === undefined);
    let prevented = 0;
    const ev = (key, target) => ({ key, target, preventDefault: () => { prevented++; } });
    head.fire('keydown', ev('Enter', head)); row.fire('keydown', ev(' ', row)); row.fire('keydown', ev('a', row));
    row.fire('keydown', ev('Enter', {}));
    check('VW-F56: Enter / Space open a row or header, other keys and inner buttons do not', head.clicks === 1 && row.clicks === 1 && prevented === 2);

    const dg = read('docs/pro/js/document-generator.js');
    const start = dg.indexOf('renderFillFormModal(documentType)');
    const body = start >= 0 ? dg.slice(start, dg.indexOf('window._docgenAutoFill = function', start)) : '';
    check('VW-F56: every fill-modal label names its field', (body.match(/<label for="\$\{id\}"/g) || []).length === 3 && /<label for="docgen_leadSelect"/.test(body));
    check('VW-F56: the × close button has a name', /data-dg-action="closeFillModal" aria-label="Close"/.test(body));
    check('VW-F56: the fill modal joins the shared dialog contract', /window\.nbdOverlay\.attach\(modal,\s*\{[^}]*close:/.test(body));
  }

  console.log('\nviews-p3d: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
