/**
 * notes-save-offline-2026-11-14.test.js — customer-page notes never hang offline.
 *
 * Wave-1 phone finding #5, verified in docs/pro/js/customer-photo-report-generator.js:
 *   - quickAddNote awaited addDoc, which resolves only on the server's ack:
 *     offline the box stayed locked at "Saving…" forever.
 *   - saveNote (the Notes modal) did the same, and had no in-flight guard, so
 *     each extra tap on Save queued another copy of the note.
 *
 * Extracts the real functions and runs them with an addDoc that never
 * acknowledges (offline), plus an online positive control.
 * NOTES_SRC=<file> runs it against another copy.
 *
 * Run: node tests/notes-save-offline-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(process.env.NOTES_SRC || path.join(ROOT, 'docs/pro/js/customer-photo-report-generator.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + detail : '')); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const within = (p, ms) => Promise.race([Promise.resolve(p).then(() => true), tick(ms).then(() => false)]);

function slice(start, tail) {
  const i = SRC.indexOf(start);
  if (i < 0) return '';
  const open = SRC.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(i, j + 1) + (tail || ''); }
  }
  return '';
}

function el(over) {
  return Object.assign({ value: '', disabled: false, style: {}, textContent: '', innerHTML: '', focus() {}, remove() {},
    insertAdjacentHTML() {}, querySelector: () => null }, over || {});
}

function page(online) {
  const writes = [];
  const els = {
    noteText: el({ value: 'Ridge vent missing on the north side' }),
    quickNoteInput: el({ value: 'Gate code 4471' }),
    quickNoteSend: el(), quickNoteStatus: el(), notesList: el({ innerHTML: '<div class="empty"></div>' }),
  };
  const saveBtn = el();
  const rec = { notify: [], loadNotes: 0, closed: 0 };
  const win = {
    _customerId: 'L1', db: {}, auth: { currentUser: { uid: 'u1', email: 'r@x.test' } },
    collection: (db, n) => n, serverTimestamp: () => 'TS',
    addDoc: (col, d) => { writes.push(d); return online ? Promise.resolve({ id: 'n' + writes.length }) : new Promise(() => {}); },
    NBDOfflineSync: { settle: (p) => (online ? Promise.resolve(p).then(() => 'synced') : Promise.resolve('queued')) },
    nbdModal: { open() {}, close() { rec.closed++; } },
    showToast() {},
  };
  const ctx = {
    window: win, auth: win.auth, console: { log() {}, warn() {}, error() {} }, Promise, Date, String, setTimeout,
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: (s) => (s === '[data-action="saveNote"]' ? saveBtn : null),
    },
    _nbdNotify: (m, k) => rec.notify.push([k, m]),
    closeNotesModal: () => { rec.closed++; },
    loadNotes: async () => { rec.loadNotes++; },
    getDoc: async () => ({ exists: () => false }), doc: () => ({}), db: {}, loadTimeline: async () => {},
  };
  vm.createContext(ctx);
  const helpers = [slice('function _noteSettle('), SRC.includes('let _noteSaving') ? 'let _noteSaving = false;' : ''].join('\n');
  vm.runInContext(helpers + '\n' + slice('window.saveNote = async function', ';') + '\n' + slice('window.quickAddNote = async function', ';'), ctx);
  return { win, els, saveBtn, writes, rec };
}

(async () => {
  console.log('\nnotes-save-offline — Notes save offline, once\n');

  let P = page(false);
  const quick = await within(P.win.quickAddNote(), 1000);
  ok('offline: quick note returns (it sat at "Saving…" forever)', quick);
  ok('...the box is unlocked and cleared', !P.els.quickNoteInput.disabled && P.els.quickNoteInput.value === '');
  ok('...and says it is on this phone', /on this phone/i.test(P.els.quickNoteStatus.textContent), P.els.quickNoteStatus.textContent);

  P = page(false);
  const a = P.win.saveNote();
  const b = P.win.saveNote();
  const c = P.win.saveNote();
  const modal = await within(Promise.all([a, b, c]), 1000);
  ok('offline: the Notes modal Save returns', modal);
  ok('three taps on Save write ONE note', P.writes.length === 1, 'writes=' + P.writes.length);
  ok('...the modal closes and the rep is told it is on this phone', P.rec.closed >= 1 && P.rec.notify.some(([k, m]) => k === 'success' && /on this phone/i.test(m)), JSON.stringify(P.rec.notify));
  ok('...and Save is usable again afterwards', P.saveBtn.disabled === false);

  // Positive control: online, both still reload the notes list.
  P = page(true);
  await within(P.win.saveNote(), 1000);
  await within(P.win.quickAddNote(), 1000);
  ok('online: both savers write and reload the notes list', P.writes.length === 2 && P.rec.loadNotes === 2, JSON.stringify({ w: P.writes.length, l: P.rec.loadNotes }));

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
