// tests/prod-switches-2026-11-09.test.js
// scripts/prod-switches.js: per-company production switches (Coach AI line,
// Call Brief auto-brief). Dry run by default; --yes writes exactly the two
// documents the CRM's own UI writes. No network: a fake Firestore.
'use strict';
const path = require('path');
const S = require(path.join(__dirname, '..', 'scripts', 'prod-switches.js'));

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  FAIL', m); } }
function throws(fn, re, m) { try { fn(); ok(false, m + ' (no throw)'); } catch (e) { ok(re.test(String(e.message)), m + ' -> ' + e.message); } }

// ── parseArgs ──
const a = S.parseArgs(['--company', 'c1', '--coach-ai', 'on', '--auto-brief', 'off']);
ok(a.company === 'c1' && a.coachAi === true && a.autoBrief === false && a.yes === false, 'parses both switches, dry run default');
ok(S.parseArgs(['--company', 'c1', '--coach-ai', 'off', '--yes']).yes === true, '--yes');
ok(S.parseArgs(['--company', 'c1', '--auto-brief', 'on']).coachAi === undefined, 'unset switch stays undefined');
ok(S.parseArgs(['--company', 'c1', '--coach-ai', 'on']).project === 'nobigdeal-pro', 'default project');
throws(() => S.parseArgs(['--coach-ai', 'on']), /--company/, 'company required');
throws(() => S.parseArgs(['--company', 'c1']), /at least one/, 'a switch required');
throws(() => S.parseArgs(['--company', 'c1', '--coach-ai', 'yes']), /on or off/, 'on/off only');
throws(() => S.parseArgs(['--company', 'c1', '--coach-ai', 'on', '--force']), /unknown/, 'unknown flag refused');
throws(() => S.parseArgs(['--company', 'a/b', '--coach-ai', 'on']), /company/, 'path-like id refused');

// ── plan ──
const p1 = S.plan({ coachAiEnabled: false, autoBrief: false }, { coachAi: true, autoBrief: false });
ok(p1.length === 1 && p1[0].key === 'coachAi' && p1[0].from === false && p1[0].to === true, 'plan lists only real changes');
ok(S.plan({ coachAiEnabled: true, autoBrief: true }, { coachAi: true, autoBrief: true }).length === 0, 'no-op plan is empty');
ok(S.plan({ coachAiEnabled: undefined }, { coachAi: false }).length === 0, 'absent counts as off');

// ── run against a fake Firestore ──
function fakeDb(docs) {
  const writes = [];
  const ref = (p) => ({
    path: p,
    get: async () => ({ exists: Object.prototype.hasOwnProperty.call(docs, p), data: () => docs[p] }),
    set: async (data, opt) => { writes.push({ p, data, opt }); docs[p] = Object.assign({}, docs[p] || {}, data); },
  });
  return { writes, db: { doc: ref } };
}
const SERVER_TS = { __ts: true };

(async () => {
  const lines = [];
  const log = (s) => lines.push(String(s));

  // dry run writes nothing
  let f = fakeDb({ 'companies/c1': { name: 'X' }, 'companyProfile/c1': {}, });
  let r = await S.run({ db: f.db, args: S.parseArgs(['--company', 'c1', '--coach-ai', 'on', '--auto-brief', 'on']), log, serverTimestamp: () => SERVER_TS });
  ok(f.writes.length === 0 && r.wrote === false && r.changes.length === 2, 'dry run: two planned changes, no writes');
  ok(lines.some((l) => /dry run/i.test(l)), 'dry run says so');

  // --yes writes the UI's shapes, merged
  f = fakeDb({ 'companies/c1': { name: 'X' }, 'companyProfile/c1': { companyName: 'X' } });
  r = await S.run({ db: f.db, args: S.parseArgs(['--company', 'c1', '--coach-ai', 'on', '--auto-brief', 'on', '--yes']), log, serverTimestamp: () => SERVER_TS });
  const cp = f.writes.find((w) => w.p === 'companyProfile/c1');
  const cb = f.writes.find((w) => w.p === 'companies/c1/settings/callBrief');
  ok(cp && cp.data.coachAiEnabled === true && Object.keys(cp.data).length === 1 && cp.opt && cp.opt.merge === true, 'companyProfile: merge {coachAiEnabled} only');
  ok(cb && cb.data.autoBrief === true && cb.data.updatedBy === 'script:prod-switches' && cb.data.updatedAt === SERVER_TS && cb.opt && cb.opt.merge === true, 'settings/callBrief: the UI payload, merged');
  ok(r.wrote === true && r.after.coachAiEnabled === true && r.after.autoBrief === true, 're-read after write');

  // nothing to change -> no writes even with --yes
  f = fakeDb({ 'companies/c1': {}, 'companyProfile/c1': { coachAiEnabled: true } });
  r = await S.run({ db: f.db, args: S.parseArgs(['--company', 'c1', '--coach-ai', 'on', '--yes']), log, serverTimestamp: () => SERVER_TS });
  ok(f.writes.length === 0 && r.changes.length === 0, 'already set: no write');

  // unknown company refused before any write
  f = fakeDb({});
  let err = null;
  try { await S.run({ db: f.db, args: S.parseArgs(['--company', 'nope', '--coach-ai', 'on', '--yes']), log, serverTimestamp: () => SERVER_TS }); } catch (e) { err = e; }
  ok(err && /no companies\/nope/.test(err.message) && f.writes.length === 0, 'missing company refused, nothing written');

  // REST adapter (token mode) with a fake fetch
  const R = require(path.join(__dirname, '..', 'scripts', '_firestore-rest.js'));
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === 'GET' && /missing$/.test(url)) return { status: 404, text: async () => '{}' };
    if (init.method === 'GET') return { status: 200, text: async () => JSON.stringify({ fields: { coachAiEnabled: { booleanValue: true }, n: { integerValue: '7' }, m: { mapValue: { fields: { 'RFG X': { doubleValue: 1.5 } } } } } }) };
    return { status: 200, text: async () => '{}' };
  };
  throws(() => R.restFirestore({ projectId: 'p', token: ' ' }), /empty/, 'empty token refused');
  const rdb = R.restFirestore({ projectId: 'nobigdeal-pro', token: 'tok', fetchImpl: fakeFetch });
  const g = await rdb.doc('companyProfile/c1').get();
  ok(g.exists && g.data().coachAiEnabled === true && g.data().n === 7 && g.data().m['RFG X'] === 1.5, 'decodes bool, int, nested double');
  ok(calls[0].init.headers.Authorization === 'Bearer tok' && /documents\/companyProfile\/c1$/.test(calls[0].url), 'bearer header, document url');
  ok((await rdb.doc('companies/missing').get()).exists === false, '404 -> not exists');
  await rdb.doc('companies/c1/settings/callBrief').set({ autoBrief: true, updatedAt: R.serverTimestamp() }, { merge: true });
  const w = calls[calls.length - 1].body.writes[0];
  ok(/:commit$/.test(calls[calls.length - 1].url) && w.update.fields.autoBrief.booleanValue === true && !w.update.fields.updatedAt, 'set: fields without the sentinel');
  ok(w.updateMask.fieldPaths.join() === 'autoBrief' && w.updateTransforms[0].fieldPath === 'updatedAt' && w.updateTransforms[0].setToServerValue === 'REQUEST_TIME', 'merge mask + server timestamp transform');
  await rdb.doc('catalogCosts/c1').update(new R.FieldPath('xactCosts', 'RFG DRPE-AL', 'materialCost'), 0.77);
  const u = calls[calls.length - 1].body.writes[0];
  ok(u.updateMask.fieldPaths[0] === 'xactCosts.`RFG DRPE-AL`.materialCost', 'field path with a space is backtick-quoted');
  ok(u.update.fields.xactCosts.mapValue.fields['RFG DRPE-AL'].mapValue.fields.materialCost.doubleValue === 0.77, 'nested update value');
  ok(u.currentDocument && u.currentDocument.exists === true, 'update requires the doc to exist');

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
