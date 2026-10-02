/**
 * tests/text-inbox-ingest-2026-10-01.test.js — functions/text-inbox.js
 * runTextIngest against a stubbed Drive and an in-memory Firestore.
 *
 *   - not shared → idle; no backup yet → recorded, nothing else
 *   - dry run → counts only (no texts, no bodies/numbers in the config doc)
 *   - live → newest sms backup only; texts matched + bucketed; short codes
 *     never stored; cursor advances
 *   - same file again → "unchanged"; a newer full backup → only new texts
 *
 * Names and numbers invented (555).
 * Run: node tests/text-inbox-ingest-2026-10-01.test.js
 */
'use strict';

const path = require('path');
const M = require(path.join(__dirname, '..', 'functions', 'text-inbox.js'));
const { runTextIngest, setClient, OWNER, COLLECTION, CONFIG } = M._test;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const NOW = Date.parse('2026-10-01T16:00:00Z');
const at = (h) => String(NOW - h * 3600e3);
const sms = (addr, h, type, body, name) => '<sms protocol="0" address="' + addr + '" date="' + at(h) + '" type="' + type + '" body="' + body + '" contact_name="' + (name || '(Unknown)') + '" />';
const XML1 = '<smses>' + [
  sms('+18125550113', 5, 1, 'Can you come Tuesday?', 'Pat Example'),
  sms('+18125550113', 4, 2, 'Yes, 10am.', 'Pat Example'),
  sms('+18775550100', 3, 1, 'Claim 12 update', 'Example Property Claims'),
  sms('+15135550142', 2, 1, 'Who is this?'),
  sms('72975', 1, 1, 'Your code is 123456'),
].join('') + '</smses>';
const XML2 = XML1.replace('</smses>', sms('+18125550113', 0.5, 1, 'Thanks!', 'Pat Example') + '</smses>');

function fakeDrive({ shared = true, files = [], bodies = {} } = {}) {
  return {
    request: async (o) => {
      if (o.params && o.params.alt === 'media') {
        const id = decodeURIComponent(o.url.split('/files/')[1]);
        return { data: new TextEncoder().encode(bodies[id] || '').buffer };
      }
      if (/^name = 'SMSBackupRestore'/.test(o.params.q)) return { data: { files: shared ? [{ id: 'fold', name: 'SMSBackupRestore' }] : [] } };
      return { data: { files } };
    },
  };
}
function fakeDb(leads) {
  const docs = new Map();
  const mk = (p) => ({
    id: p.split('/').pop(),
    get: async () => ({ exists: docs.has(p), id: p.split('/').pop(), data: () => docs.get(p) }),
    set: async (v, o) => { docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : v); },
    _p: p,
  });
  return {
    docs,
    doc: mk,
    collection: (n) => ({
      doc: (id) => mk(n + '/' + id),
      where: (f, _o, v) => ({ get: async () => { const rows = n === 'leads' ? leads.filter((l) => l[f] === v) : []; return { forEach: (fn) => rows.forEach((l) => fn({ id: l.id, data: () => l })) }; } }),
    }),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    batch: () => { const ops = []; return { set: (r, v) => ops.push([r._p, v]), commit: async () => { ops.forEach(([p, v]) => docs.set(p, v)); } }; },
  };
}
const leads = [{ id: 'L1', companyId: OWNER, userId: OWNER, phone: '(812) 555-0113' }];
const texts = (db) => [...db.docs.entries()].filter(([k]) => k.startsWith(COLLECTION + '/')).map(([, v]) => v);

(async () => {
  console.log('\n1. Idle states');
  setClient(fakeDrive({ shared: false }));
  let db = fakeDb(leads);
  ok('not shared → idle, nothing written', (await runTextIngest({ db, live: true, nowMs: NOW })).state === 'not_shared' && db.docs.size === 0);
  setClient(fakeDrive({ files: [{ id: 'c1', name: 'calls-20261001120000.xml' }] }));
  ok('only a call-log backup → no_backup', (await runTextIngest({ db, live: true, nowMs: NOW })).state === 'no_backup' && texts(db).length === 0);

  console.log('\n2. Dry run');
  const F1 = { id: 'b1', name: 'sms-20261001150000.xml', size: '4000', modifiedTime: '2026-10-01T15:00:00Z' };
  setClient(fakeDrive({ files: [{ id: 'b0', name: 'sms-20260930150000.xml' }, F1], bodies: { b1: XML1 } }));
  db = fakeDb(leads);
  let r = await runTextIngest({ db, live: false, nowMs: NOW });
  ok('counts 4 texts, 1 short code skipped', r.state === 'dry_run' && r.fresh === 4 && r.skippedShortCodes === 1, JSON.stringify(r));
  ok('buckets: 2 customer, 1 insurance, 1 unknown', r.buckets.customer === 2 && r.buckets.insurance === 1 && r.buckets.unknown === 1, JSON.stringify(r.buckets));
  ok('no texts written; config has counts only', texts(db).length === 0 && !/555|Tuesday|Pat/.test(JSON.stringify(db.docs.get(CONFIG))));

  console.log('\n3. Live');
  r = await runTextIngest({ db, live: true, nowMs: NOW });
  const all = texts(db);
  ok('4 texts stored from the NEWEST backup', r.stored === 4 && all.length === 4 && all.every((t) => t.backupFileId === 'b1'));
  ok('customer texts matched to the lead, both directions', all.filter((t) => t.leadId === 'L1').map((t) => t.direction).sort().join() === 'inbound,outbound');
  ok('short code never stored', !all.some((t) => /code is/.test(t.body)));
  ok('tenant stamped', all.every((t) => t.userId === OWNER && t.companyId === OWNER));
  ok('cursor at the newest text', db.docs.get(CONFIG).cursorMs === Number(at(2)));

  console.log('\n4. Repeat + newer backup');
  ok('same file, same modifiedTime → unchanged', (await runTextIngest({ db, live: true, nowMs: NOW })).state === 'unchanged');
  const F2 = { id: 'b2', name: 'sms-20261001155000.xml', size: '4100', modifiedTime: '2026-10-01T15:50:00Z' };
  setClient(fakeDrive({ files: [F1, F2], bodies: { b2: XML2 } }));
  r = await runTextIngest({ db, live: true, nowMs: NOW });
  ok('a newer full backup files only the new text', r.fresh === 1 && r.stored === 1 && texts(db).length === 5, JSON.stringify(r));

  console.log('\n5. Paused');
  db = fakeDb(leads);
  await db.doc(CONFIG).set({ paused: true });
  ok('paused stops it', (await runTextIngest({ db, live: true, nowMs: NOW })).state === 'paused' && texts(db).length === 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
