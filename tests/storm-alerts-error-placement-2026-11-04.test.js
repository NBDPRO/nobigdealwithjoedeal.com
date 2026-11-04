/**
 * tests/storm-alerts-error-placement-2026-11-04.test.js
 *
 * THE BUG: /storm-alerts showed every validation message in one fixed box
 * above the Sign Up button, 950-1250 px below the field that got focus on an
 * empty submit (OVERNIGHT-SITE-PROGRAM-2026-10-26, "Found while fixing"; the
 * /inspect half was #2764).
 *
 * THE FIX: placeAlertError moves #sa-error under the offending field's .row /
 * .field, just ABOVE the consent label (under it, a phone's Book/Call/Text bar
 * hides it), and back to its home for a server error with no field.
 *
 * Runs the REAL showAlertError / placeAlertError from c5a2295382.js in a vm
 * against a minimal fake DOM (children arrays with insertBefore + closest).
 *
 * Zero deps. Run: node tests/storm-alerts-error-placement-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/assets/js/inline/c5a2295382.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'docs/storm-alerts.html'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function node(name, cls, tag) {
  const n = {
    name, className: cls || '', tagName: tag || 'DIV', parentNode: null, children: [], attrs: {},
    textContent: '', classList: { add() {}, remove() {} },
    get nextSibling() { const s = this.parentNode && this.parentNode.children; return s ? s[s.indexOf(this) + 1] || null : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; },
    focus() {},
    append(...kids) { for (const k of kids) { k.parentNode = this; this.children.push(k); } return this; },
    insertBefore(k, ref) {
      if (k.parentNode) k.parentNode.children.splice(k.parentNode.children.indexOf(k), 1);
      k.parentNode = this;
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i === -1) this.children.push(k); else this.children.splice(i, 0, k);
      return k;
    },
    closest(sel) {
      for (let n = this; n; n = n.parentNode) {
        if (sel === 'label' ? n.tagName === 'LABEL' : (' ' + n.className + ' ').indexOf(' ' + sel.slice(1) + ' ') !== -1) return n;
      }
      return null;
    },
  };
  return n;
}

// The form as storm-alerts.html lays it out.
const form = node('form', '', 'FORM');
const row = node('row', 'row');
const fName = node('fName', 'field'), name = node('alertName', '', 'INPUT');
const fPhone = node('fPhone', 'field'), phone = node('alertPhone', '', 'INPUT');
const fZip = node('fZip', 'field'), zip = node('alertZip', '', 'INPUT');
const req = node('req', 'sc-consent-req', 'P');
const label = node('label', 'sc-consent', 'LABEL'), consent = node('sa-consent', '', 'INPUT');
const box = node('sa-error', 'signup-err');
const trust = node('trust', 'nbd-trust-line', 'P');
fName.append(name); fPhone.append(phone); row.append(fName, fPhone); fZip.append(zip); label.append(consent);
form.append(row, fZip, req, label, box, trust);

const ctx = { document: { getElementById: (id) => (id === 'sa-error' ? box : null) } };
vm.createContext(ctx);
vm.runInContext(SRC + '\n;globalThis.show = showAlertError;', ctx);

const after = () => { const s = box.parentNode.children; return s[s.indexOf(box) - 1]; };
const before = () => box.nextSibling;

ctx.show('Please fill in your name, phone, and zip code.', name);
ok('name error sits right after the name/phone row', after() === row, after() && after().name);
ok('the field points at the message', name.attrs['aria-describedby'] === 'sa-error');
ctx.show('Please enter a valid 5-digit zip code.', zip);
ok('zip error sits right after the zip field', after() === fZip, after() && after().name);
ctx.show('Please check the consent box.', consent);
ok('consent error sits just above the consent label', before() === label, before() && before().name);
ctx.show('Sorry — we could not sign you up just now.');
ok('a server error with no field goes back above the trust line', after() === label && before() === trust,
  (after() && after().name) + ' / ' + (before() && before().name));
ok('the page loads the edited script under a fresh ?v=', +((HTML.match(/c5a2295382\.js\?v=(\d+)/) || [])[1] || 0) >= 4);

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
