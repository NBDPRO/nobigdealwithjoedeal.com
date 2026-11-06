/**
 * tests/customer-keyboard-2026-11-06.test.js — CRM audit 2026-11-06, CU-F15
 * (customer page dialogs and the document drop zone, keyboard + labels).
 *
 * - customer-tasks-ui.js showPhotoActions: the photo quick-edit popup had no
 *   Esc, no focus move and no focus return.
 * - customer.html #docDropZone: the only way to pick documents could not be
 *   reached by keyboard (customer-photo-report-generator.js wires Enter/Space).
 * - customer.html: "Additional Service Locations" was a second
 *   <label for="editDamageType">, so the Damage Type input had two labels.
 * Zero deps. Run: node tests/customer-keyboard-2026-11-06.test.js
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

console.log('PHOTO ACTIONS POPUP');
{
  const SRC = read('customer-tasks-ui.js');
  const s = SRC.indexOf('window.showPhotoActions = function(idx, event) {');
  const show = s >= 0 ? SRC.slice(s, SRC.indexOf('\n};\n', s) + 4) : '';
  const c = SRC.indexOf('function _closePhotoActionPopup() {');
  const close = c >= 0 ? SRC.slice(c, SRC.indexOf('\n}\n', c) + 3) : '';
  ok('showPhotoActions and _closePhotoActionPopup found (positive control)', show.length > 500 && close.length > 40);

  const byId = {};
  function el(tag) {
    const e = { tagName: tag, attrs: {}, listeners: {}, children: [], style: {}, id: '', isConnected: false, focused: 0,
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      appendChild(ch) { this.children.push(ch); return ch; },
      focus() { this.focused++; doc.activeElement = this; },
      remove() { this.isConnected = false; if (this.id && byId[this.id] === this) delete byId[this.id]; },
      querySelector(sel) { return sel === '.ct-close' ? (this._close || (this.children[0] && this.children[0]._close) || null) : null; } };
    Object.defineProperty(e, 'innerHTML', { set(v) { this._html = v; if (/class="ct-close"/.test(v)) this._close = el('button'); }, get() { return this._html || ''; } });
    return e;
  }
  const opener = el('div'); opener.isConnected = true;
  const doc = {
    activeElement: opener,
    createElement: (t) => el(t),
    getElementById: (id) => byId[id] || null,
    body: { appendChild(n) { n.isConnected = true; if (n.id) byId[n.id] = n; return n; } },
  };
  const win = { _allPhotos: [{ id: 'p1', phase: 'Before', url: 'x' }], _currentLead: { id: 'L1' } };
  const sb = { window: win, document: doc, _dmgOptions: () => [], _dmgNorm: (x) => x, console };
  vm.createContext(sb);
  vm.runInContext(close + '\n' + show + '\nwindow.showPhotoActions(0);', sb);
  const popup = byId.photoActionPopup;
  ok('the popup opens (positive control)', !!popup);
  ok('it is a named modal dialog', !!popup && popup.attrs.role === 'dialog' && popup.attrs['aria-modal'] === 'true' && !!popup.attrs['aria-label']);
  const closeBtn = popup && popup.querySelector('.ct-close');
  ok('focus moves to its close button', !!closeBtn && closeBtn.focused === 1);
  const keys = (popup && popup.listeners.keydown) || [];
  keys.forEach((f) => f({ key: 'Escape', preventDefault() {}, stopPropagation() {} }));
  ok('Esc closes it', !byId.photoActionPopup);
  ok('…and focus returns to what opened it', opener.focused === 1 && doc.activeElement === opener);
}

console.log('DOCUMENT DROP ZONE + LABELS');
{
  const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'customer.html'), 'utf8');
  const dz = (HTML.match(/<div class="upload-zone" id="docDropZone"[^>]*>/) || [''])[0];
  ok('the drop zone tag is found (positive control)', !!dz);
  ok('it is a focusable button with a name', /role="button"/.test(dz) && /tabindex="0"/.test(dz) && /aria-label="[^"]+"/.test(dz));
  const GEN = read('customer-photo-report-generator.js');
  const s = GEN.indexOf("document.addEventListener('DOMContentLoaded', () => {");
  const wire = s >= 0 ? GEN.slice(s, GEN.indexOf('\n});\n', s) + 4) : '';
  let clicks = 0; const zl = {};
  const dropZone = { addEventListener(t, f) { zl[t] = f; }, classList: { add() {}, remove() {} } };
  const fileInput = { click() { clicks++; }, addEventListener() {} };
  const sb = { document: { addEventListener: (t, f) => f(), getElementById: (id) => ({ docDropZone: dropZone, docFileInput: fileInput }[id]) }, Array, addDocumentsToQueue() {} };
  vm.createContext(sb);
  vm.runInContext(wire, sb);
  ok('a click opens the picker (positive control)', !!zl.click && (zl.click(), clicks === 1));
  if (zl.keydown) { zl.keydown({ key: 'Enter', preventDefault() {} }); zl.keydown({ key: ' ', preventDefault() {} }); zl.keydown({ key: 'a', preventDefault() {} }); }
  ok('Enter and Space open the picker; other keys do not', clicks === 3, String(clicks));
  const forDamage = (HTML.match(/<label[^>]*for="editDamageType"/g) || []).length;
  ok('Damage Type has exactly one label', forDamage === 1, String(forDamage));
  ok('Additional Service Locations names its list (a group label, not a stray <label for>)',
    /<div class="ui-label" id="editServiceAddressesLabel">Additional Service Locations<\/div>/.test(HTML)
    && /<div id="editServiceAddresses" role="group" aria-labelledby="editServiceAddressesLabel">/.test(HTML));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
