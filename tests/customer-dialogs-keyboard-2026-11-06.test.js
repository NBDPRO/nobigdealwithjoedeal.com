/**
 * tests/customer-dialogs-keyboard-2026-11-06.test.js — CRM audit 2026-11-06,
 * CU-F15 part 2: the customer page's secure-link dialogs (customer-documents.js
 * _dlg) and the document prerequisite dialog (customer-tasks-ui.js) had no Esc,
 * no focus move and no focus return.
 * Zero deps. Run: node tests/customer-dialogs-keyboard-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8').replace(/\r\n/g, '\n');
function fnBlock(src, start) {
  const s = src.indexOf(start);
  if (s < 0) return '';
  const indent = start.match(/^\s*/)[0];
  const e = src.indexOf('\n' + indent + '}\n', s);
  return e < 0 ? '' : src.slice(s, e + indent.length + 3);
}

(async function main() {
  console.log('SECURE-LINK DIALOGS (_dlg)');
  {
    const SRC = read('customer-documents.js');
    const code = ['  function _dlg(build) {', '  function _el(tag, cls, text) {', '  function askSecureOptions() {'].map((h) => {
      const b = h.includes('_el(') ? (SRC.slice(SRC.indexOf(h), SRC.indexOf('\n', SRC.indexOf(h)) + 1)) : fnBlock(SRC, h);
      return b;
    });
    ok('_dlg, _el and askSecureOptions found (positive control)', code.every((c) => c.length > 20), code.map((c) => c.length).join(','));

    const doc = { activeElement: null, body: { kids: [], appendChild(n) { n.isConnected = true; this.kids.push(n); return n; } } };
    function el(tag) {
      const e = { tagName: tag.toUpperCase(), className: '', attrs: {}, kids: [], listeners: {}, hidden: false, disabled: false, isConnected: false, value: '', textContent: '', options: [],
        setAttribute(k, v) { this.attrs[k] = String(v); },
        appendChild(c) { c.parent = this; this.kids.push(c); if (this.isConnected) c.isConnected = true; return c; },
        addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
        remove() { this.isConnected = false; const all = (n) => { n.isConnected = false; n.kids.forEach(all); }; all(this); },
        focus() { doc.activeElement = this; },
        all() { const out = []; const w = (n) => { n.kids.forEach((k) => { out.push(k); w(k); }); }; w(this); return out; },
        querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
        querySelectorAll(sel) {
          if (sel.startsWith('.')) return this.all().filter((n) => (n.className || '').split(' ').includes(sel.slice(1)));
          const tags = sel.split(',').map((x) => x.trim().toUpperCase());
          return this.all().filter((n) => tags.includes(n.tagName) || (tags.includes('[TABINDEX]') && n.attrs.tabindex != null));
        } };
      return e;
    }
    // appendChild on body marks the whole subtree connected
    const realAppend = doc.body.appendChild.bind(doc.body);
    doc.body.appendChild = (n) => { realAppend(n); const w = (x) => { x.isConnected = true; x.kids.forEach(w); }; w(n); return n; };
    doc.createElement = el;
    const opener = el('button'); opener.isConnected = true; doc.activeElement = opener;
    const sb = { document: doc, Promise, Array, parseInt, String };
    vm.createContext(sb);
    vm.runInContext(code.join('\n') + '\nglobalThis.__ask = askSecureOptions;', sb);
    const p = sb.__ask();
    const back = doc.body.kids[doc.body.kids.length - 1];
    const box = back && back.kids[0];
    ok('the dialog opens (positive control)', !!box && box.attrs.role === 'dialog');
    ok('it is named by its heading', !!box && box.attrs['aria-label'] === 'Send securely', box && box.attrs['aria-label']);
    ok('focus starts inside it, on its first control', !!box && doc.activeElement && doc.activeElement !== opener && box.all().includes(doc.activeElement), doc.activeElement && doc.activeElement.tagName);
    const kd = (back && back.listeners.keydown) || [];
    kd.forEach((f) => f({ key: 'Escape', preventDefault() {}, stopPropagation() {} }));
    const res = await Promise.race([p, new Promise((r) => setTimeout(() => r('still open'), 50))]);
    ok('Esc closes it as Cancel (resolves null)', res === null, String(res));
    ok('…and focus returns to the opener', doc.activeElement === opener);
  }

  console.log('PREREQUISITE DIALOG');
  {
    const SRC = read('customer-tasks-ui.js');
    const s = SRC.indexOf("const label = check.label || type;");
    const blk = s >= 0 ? SRC.slice(s, SRC.indexOf('\n    return;\n', s)) : '';
    ok('the prerequisite dialog block is found (positive control)', /Can't Generate/.test(blk));
    ok('it is a named modal dialog', /modal\.setAttribute\('role', 'dialog'\)/.test(blk) && /modal\.setAttribute\('aria-modal', 'true'\)/.test(blk) && /modal\.setAttribute\('aria-label'/.test(blk));
    ok('Esc closes it', /addEventListener\('keydown'[\s\S]{0,120}e\.key === 'Escape'[\s\S]{0,80}_closeBack\(\)/.test(blk));
    ok('focus starts on "Got It"', /querySelector\('\.nbd-preq-close'\);\s*if \(_gotIt[^)]*\) _gotIt\.focus\(\)/.test(blk));
    ok('Got It, Esc and a backdrop tap all return focus to the opener',
      /nbd-preq-close'\)\.addEventListener\('click', \(\) => _closeBack\(\)\)/.test(blk) && /e\.target === modal\) _closeBack\(\)/.test(blk) && /_opener\.focus\(\)/.test(blk));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
