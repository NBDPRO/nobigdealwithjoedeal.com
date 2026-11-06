/**
 * tests/customer-states-2026-11-06.test.js — CRM audit 2026-11-06, customer
 * page failure states.
 *
 * CU-F09 customer-photo-report-generator.js loadNotes: a failed read kept
 *        "No notes yet".
 * CU-F10 customer-documents.js: a failed e-sign envelope read left the list blank.
 * CU-F18 customer-bootstrap.module.js: no ?id= returned silently (blank page).
 * CU-F17 customer-realtime.module.js: after one error the Messages status
 *        stayed red, so a later "Sent ✓" showed in red.
 * Zero deps. Run: node tests/customer-states-2026-11-06.test.js
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

(async function main() {
  console.log('NOTES READ FAILURE (CU-F09)');
  {
    const SRC = read('customer-photo-report-generator.js');
    const s = SRC.indexOf('async function loadNotes(leadId) {');
    const fn = s >= 0 ? SRC.slice(s, SRC.indexOf('\n}\n', s) + 3) : '';
    ok('loadNotes found (positive control)', fn.length > 300);
    const list = { innerHTML: 'old' };
    const sb = { document: { getElementById: (id) => (id === 'notesList' ? list : null) }, window: {}, console: { error() {} },
      getDocs: () => Promise.reject(new Error('permission-denied')), query: () => ({}), collection: () => ({}), where: () => ({}), db: {} };
    vm.createContext(sb);
    vm.runInContext(fn + '\nglobalThis.__p = loadNotes("L1");', sb);
    await sb.__p;
    ok('a failed read says so, not "No notes yet"', /Could not load notes/.test(list.innerHTML) && !/No notes yet/.test(list.innerHTML), list.innerHTML);
    const ok2 = { innerHTML: '' };
    const sb2 = Object.assign({}, sb, { document: { getElementById: (id) => (id === 'notesList' ? ok2 : null) }, getDocs: () => Promise.resolve({ docs: [] }) });
    vm.createContext(sb2);
    vm.runInContext(fn + '\nglobalThis.__p = loadNotes("L1");', sb2);
    await sb2.__p;
    ok('an empty read still says "No notes yet" (positive control)', /No notes yet/.test(ok2.innerHTML));
  }

  console.log('E-SIGN LIST READ FAILURE (CU-F10)');
  {
    const SRC = read('customer-documents.js');
    ok('the envelope-load catch now writes into #esignEnvelopeList',
      /envelopes load failed', err && err\.message\);\n[\s\S]{0,160}getElementById\('esignEnvelopeList'\)[\s\S]{0,80}textContent = 'Could not load signature requests/.test(SRC));
  }

  console.log('NO CUSTOMER ID (CU-F18)');
  {
    const SRC = read('customer-bootstrap.module.js');
    const s = SRC.indexOf("  const customerId = params.get('id');");
    const blk = s >= 0 ? SRC.slice(s, s + 500) : '';
    ok('the id check is found (positive control)', /if \(!customerId\)/.test(blk));
    ok('no id shows an error instead of returning silently', /if \(!customerId\) \{\s*\n\s*showError\('No customer selected'/.test(blk) && !/if \(!customerId\) return;/.test(blk));
    ok('…and the page is made visible', /showError\('No customer selected'[\s\S]{0,200}document\.documentElement\.style\.opacity = '1';/.test(blk));
  }

  console.log('MESSAGES STATUS COLOUR (CU-F17)');
  {
    const SRC = read('customer-realtime.module.js');
    const s = SRC.indexOf('    async function onSend() {');
    const fn = s >= 0 ? SRC.slice(s, SRC.indexOf('\n    }\n', s) + 6) : '';
    ok('onSend found (positive control)', /replyToPortalMessage/.test(fn));
    const statusEl = { textContent: 'Error: x', style: { color: '#fca5a5' } };
    const textEl = { value: 'hi' };
    const sendBtn = { textContent: 'Send', style: {}, disabled: false };
    const sb = { statusEl, textEl, sendBtn, leadId: 'L1', getFunctions: () => ({}), httpsCallable: () => async () => ({ data: { success: true } }), setTimeout() {} };
    vm.createContext(sb);
    vm.runInContext(fn + '\nglobalThis.__p = onSend();', sb);
    await sb.__p;
    ok('a send after an error shows "Sent ✓" without the old red', statusEl.textContent === 'Sent ✓' && !statusEl.style.color, JSON.stringify(statusEl.style));
    ok('error colours use the --red token (old value kept as fallback)', !/color = '#fca5a5'/.test(SRC) && !/color:#fca5a5/.test(SRC));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
