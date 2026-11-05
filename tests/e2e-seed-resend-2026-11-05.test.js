/**
 * tests/e2e-seed-resend-2026-11-05.test.js — E2E lead seeding survives a resent write.
 *
 * Specs seeded leads with a page-side addDoc. On a loaded CI runner the long-polling SDK can
 * resend a create the emulator already saved, and addDoc's "must not exist yet" check throws
 * ALREADY_EXISTS for a lead that is there (phone-deal-packet, phone-customer-order, 2026-11-04).
 * loginAs now injects window.__e2eAddDoc (id first, setDoc, read back after any error), and every
 * spec seeds leads through it.
 *
 *   1. the injected helper, run for real against a fake Firestore (normal / resent / refused / read-back fails)
 *   2. ratchet: no spec seeds a lead with a raw addDoc(collection(..., 'leads'), ...)
 *
 * Zero deps. Run: node tests/e2e-seed-resend-2026-11-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function bodyAfter(src, anchor) {
  const at = src.indexOf(anchor);
  if (at === -1) return null;
  const open = src.indexOf('{', at + anchor.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

function fakeMod(mode) {
  const docs = {};
  let seq = 0;
  const err = (code) => Object.assign(new Error(code), { code });
  return {
    docs, writes: 0,
    collection: (_db, col) => ({ col }),
    doc: (c) => ({ id: 'id' + (++seq), path: c.col + '/id' + seq }),
    async setDoc(ref, data) {
      this.writes++;
      if (mode === 'ok') { docs[ref.path] = data; return; }
      if (mode === 'resent') { docs[ref.path] = data; throw err('already-exists'); }
      if (mode === 'readFails') throw err('unavailable');
      throw err('permission-denied');
    },
    async getDoc(ref) {
      if (mode === 'readFails') throw new Error('offline');
      const d = docs[ref.path];
      return { exists: () => d !== undefined };
    },
  };
}

(async () => {
  console.log('\n1. window.__e2eAddDoc (tests/e2e/fixtures/auth.js)');
  const body = bodyAfter(read('tests/e2e/fixtures/auth.js'), 'window.__e2eAddDoc = async (mod, db, col, data) =>');
  ok('POSITIVE CONTROL: the helper is in loginAs', !!body);
  const make = () => new Function('console', 'return async (mod, db, col, data) => ' + body)({ warn() {} });
  const run = async (mode) => { const m = fakeMod(mode); try { return { ref: await make()(m, {}, 'leads', { a: 1 }), m }; } catch (e) { return { err: e, m }; } };
  {
    const r = await run('ok');
    ok('a normal seed writes once and returns a ref with an id', r.ref && r.ref.id && r.m.writes === 1 && r.m.docs['leads/' + r.ref.id]);
  }
  {
    const r = await run('resent');
    ok('RESEND: ALREADY_EXISTS for a doc that is there resolves with that ref', r.ref && r.m.docs['leads/' + r.ref.id], r.err && r.err.code);
  }
  {
    const r = await run('denied');
    ok('a real refusal still throws', r.err && r.err.code === 'permission-denied');
  }
  {
    const r = await run('readFails');
    ok('a failing read-back reports the write error (never a false success)', r.err && r.err.code === 'unavailable');
  }
  {
    let added = 0;
    const m = { collection: (_d, c) => ({ col: c }), addDoc: async () => { added++; return { id: 'x' }; } };
    const ref = await make()(m, {}, 'leads', {});
    ok('a page without setDoc / getDoc falls back to addDoc', ref && ref.id === 'x' && added === 1);
  }

  console.log('\n2. ratchet');
  const dir = path.join(ROOT, 'tests/e2e');
  const RAW = /\.addDoc\(\s*[\w$.]+\.collection\(\s*[^,()]+\s*,\s*'leads'\s*\)\s*,/;
  const specs = fs.readdirSync(dir).filter((f) => f.endsWith('.spec.js'));
  const raw = specs.filter((f) => RAW.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  const using = specs.filter((f) => /window\.__e2eAddDoc\(/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  ok('POSITIVE CONTROL: specs seed through window.__e2eAddDoc (at least 10)', using.length >= 10, String(using.length));
  ok('no spec seeds a lead with a raw addDoc', raw.length === 0, raw.join(', '));
  ok('the ratchet pattern catches a raw seed', RAW.test("await fs.addDoc(fs.collection(db, 'leads'), {"));

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
