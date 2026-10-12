/**
 * tests/call-watch-labels-2026-10-12.test.js — callWatch (server) reads the
 * per-number labels and keeps in step with Home (phase 2a).
 *
 *   A. functions/call-watch-logic.js callNeedsYou == docs/pro/js/home-attention.js
 *      callNeedsYou on the SAME rows with the SAME labels (a matrix, not a pair)
 *   B. newNeeds: hidden numbers never alert; a promise ALWAYS does; the
 *      safety valve alerts once per baseline; Thursday from a hidden number
 *      stays out
 *   C. runWatch through a fake db: reads companies/{OWNER}/contact_labels,
 *      alerts without a hidden number's noise, still alerts its promise; a
 *      failed labels read alerts WITHOUT labels (fail open) and says so
 *
 * Absence assertions carry a positive control (the same input with no label).
 * Run: node tests/call-watch-labels-2026-10-12.test.js
 */
'use strict';
process.env.TZ = 'America/New_York';
const path = require('path');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + detail : '')); }
}
const W = require(path.join(ROOT, 'functions/call-watch-logic.js'));
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));

const NOW = Date.parse('2026-10-12T18:00:00Z');   // Monday 2:00 PM Eastern
const MIN = 60000, H = 3600000;
const N = '5550142222';
const call = (o) => Object.assign({ id: 'c', direction: 'inbound', status: 'noted', bucket: 'unknown', phoneDigits: N, startedAtMs: NOW - H }, o);
const lab = (kind, policy, extra) => ({ [N]: Object.assign({ kind, policy, updatedAtMs: NOW - 6 * H }, extra || {}) });

(async () => {
  console.log('A. one rule, two implementations');
  const variants = {
    plain: {}, urgent: { urgent: true }, missed: { status: 'short' }, promise: { promises: [{ who: 'jo', text: 'x' }] },
    theirPromise: { promises: [{ who: 'them', text: 'x' }] }, dueFu: { followUpDate: '2026-10-12' }, futureFu: { followUpDate: '2026-10-30' },
    onLead: { leadId: 'L1' }, insurance: { bucket: 'insurance' }, subType: { callType: 'sub', urgent: true }, supplierPromise: { callType: 'supplier', promises: [{ who: 'jo', text: 'y' }] },
    done: { taskDone: true, promises: [{ who: 'jo', text: 'x' }] },
  };
  const labelSets = {
    none: null, empty: {}, hide: lab('personal', 'hide'), quiet: lab('sub', 'quiet'), surface: lab('customer', 'surface'),
    adjuster: lab('insurance', 'surface'), other: { '5559999999': { kind: 'spam', policy: 'hide' } },
  };
  let mismatches = [], cells = 0;
  Object.keys(variants).forEach((vk) => Object.keys(labelSets).forEach((lk) => {
    const c = call(Object.assign({ id: vk }, variants[vk]));
    const L = labelSets[lk];
    const a = W.callNeedsYou(c, NOW, { reachedAt: new Map(), labels: L });
    const b = HA.callNeedsYou(c, NOW, { reachedAt: new Map(), labels: L });
    cells++;
    if (a !== b) mismatches.push(vk + '/' + lk + ' server=' + a + ' client=' + b);
  }));
  ok('server == client on ' + cells + ' (call shape x label set) cells', mismatches.length === 0, mismatches.join('; '));
  ok('control: the matrix really spans both outcomes', Object.keys(variants).some((vk) => HA.callNeedsYou(call(variants[vk]), NOW, {})) && Object.keys(variants).some((vk) => !HA.callNeedsYou(call(variants[vk]), NOW, {})));
  const burst = [1, 2, 3].map((i) => call({ id: 'b' + i, startedAtMs: NOW - i * 15 * MIN }));
  const rs = (impl, L) => impl.resurfacedNumbers(burst, L, NOW).map((v) => v.digits + ':' + v.reason + ':' + v.base).join();
  ok('resurfacedNumbers: server == client (burst, lead, ack, none)',
    rs(W, lab('spam', 'hide')) === rs(HA, lab('spam', 'hide')) && rs(W, lab('spam', 'hide')).startsWith(N + ':burst:')
    && rs(W, null) === rs(HA, null) && rs(W, null) === ''
    && rs(W, lab('spam', 'hide', { ackAtMs: NOW - MIN })) === rs(HA, lab('spam', 'hide', { ackAtMs: NOW - MIN })) && rs(W, lab('spam', 'hide', { ackAtMs: NOW - MIN })) === '');

  console.log('B. newNeeds');
  const since = NOW - 2 * H;
  const noisy = call({ id: 'n1', urgent: true, notedAtMs: NOW - 30 * MIN });
  ok('control: an urgent unknown call alerts with no labels', W.newNeeds([noisy], [], [], since, NOW).map((n) => n.id).join() === 'call:n1');
  ok('hide: the same call does NOT alert', W.newNeeds([noisy], [], [], since, NOW, lab('personal', 'hide')).length === 0);
  ok('quiet: the same call does NOT alert', W.newNeeds([noisy], [], [], since, NOW, lab('sub', 'quiet')).length === 0);
  const promised = call({ id: 'n2', promises: [{ who: 'jo', text: 'call him Friday' }], notedAtMs: NOW - 30 * MIN });
  const pn = W.newNeeds([promised], [], [], since, NOW, lab('personal', 'hide'));
  ok('hide: a promise Jo made ALWAYS alerts, saying why', pn.length === 1 && pn[0].why === 'you promised something', JSON.stringify(pn));
  const both = call({ id: 'n3', urgent: true, promises: [{ who: 'jo', text: 'x' }], notedAtMs: NOW - 30 * MIN });
  ok('hide + urgent + promise reads "you promised something", not "urgent"', W.newNeeds([both], [], [], since, NOW, lab('personal', 'hide'))[0].why === 'you promised something'
    && W.newNeeds([both], [], [], since, NOW)[0].why === 'urgent');
  const tx = [{ id: 't1', phoneDigits: N, urgent: true, startedAtMs: NOW - H, notedAtMs: NOW - 10 * MIN, contactName: 'X' }];
  ok('a day of texts follows the same label (control: alerts without)', W.newNeeds([], tx, [], since, NOW).length === 1 && W.newNeeds([], tx, [], since, NOW, lab('spam', 'hide')).length === 0);

  const bn = W.newNeeds(burst, [], [], since, NOW, lab('spam', 'hide', { updatedAtMs: NOW - 6 * H }));
  ok('a hidden number calling 3 times in 24h alerts once, saying so', bn.length === 1 && /^hidden:5550142222:/.test(bn[0].id) && bn[0].why === 'a hidden number is calling a lot', JSON.stringify(bn));
  ok('control: without a hide label the same three calls are ordinary needs, not a hidden-number row', W.newNeeds(burst, [], [], since, NOW).every((n) => !/^hidden:/.test(n.id)));
  ok('two calls are not a burst (server)', W.newNeeds(burst.slice(0, 2), [], [], since, NOW, lab('spam', 'hide', { updatedAtMs: NOW - 6 * H })).length === 0);
  const lead = [call({ id: 'ld', leadId: 'L5', startedAtMs: NOW - 20 * MIN })];
  const ln = W.newNeeds(lead, [], [], since, NOW, lab('personal', 'hide'));
  ok('a hidden number that is now a customer alerts, saying so', ln.length === 1 && ln[0].why === 'a hidden number matches a customer', JSON.stringify(ln));
  ok('the id carries the baseline, so "Keep hidden" re-arms it and the old id stays told',
    W.newNeeds(burst, [], [], since, NOW, lab('spam', 'hide', { ackAtMs: NOW - 5 * MIN })).length === 0
    && bn[0].id.split(':')[2] === String(NOW - 6 * H));
  const th = [{ id: 'th9', status: 'processed', reviewed: false, from: '+1 (555) 014-2222', processedAt: new Date(NOW - 15 * MIN), startedAt: new Date(NOW - 20 * MIN) }];
  ok('Thursday: control alerts; from a hidden / quiet number it stays out; another label kind surfaces',
    W.newNeeds([], [], th, since, NOW).length === 1 && W.newNeeds([], [], th, since, NOW, lab('spam', 'hide')).length === 0
    && W.newNeeds([], [], th, since, NOW, lab('sub', 'quiet')).length === 0 && W.newNeeds([], [], th, since, NOW, lab('customer', 'surface')).length === 1);

  console.log('C. runWatch with a fake db');
  const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
  const watch = require(path.join(ROOT, 'functions/call-watch.js'))._internal;
  function fakeDb(o) {
    const sets = [];
    const docs = (rows) => ({ docs: rows.map((r) => ({ id: r.id, data: () => { const d = Object.assign({}, r); delete d.id; return d; } })) });
    const chain = (rows) => { const c = { where: () => c, orderBy: () => c, limit: () => c, get: async () => docs(rows) }; return c; };
    const labelsCol = { get: async () => { if (o.labelsThrow) throw new Error('boom'); return docs(o.labels || []); } };
    return {
      sets,
      collection: (name) => {
        if (name === 'companies') return { doc: (id) => ({ collection: (sub) => (id === OWNER && sub === 'contact_labels' ? labelsCol : chain([])) }) };
        if (name === 'phone_calls') return chain(o.calls || []);
        if (name === 'notifications') return { add: async (v) => { sets.push(['notifications', v]); } };
        return chain([]);
      },
      doc: (p) => ({ get: async () => ({ exists: false, data: () => ({}) }), set: async (v) => { sets.push([p, v]); } }),
      getAll: async (...refs) => refs.map(() => ({ exists: false, data: () => ({}) })),
    };
  }
  const watchNow = (() => { const d = new Date(NOW); return NOW; })();
  const calls = [
    call({ id: 'u1', phoneDigits: N, urgent: true, startedAtMs: watchNow - 30 * MIN, createdAtMs: watchNow - 25 * MIN, userId: OWNER }),
    call({ id: 'u2', phoneDigits: '5550143333', urgent: true, contactName: 'Real Customer', startedAtMs: watchNow - 30 * MIN, createdAtMs: watchNow - 25 * MIN, userId: OWNER }),
  ];
  const pushes = [];
  const push = async (...a) => { pushes.push(a); return { sent: 1 }; };
  const labelDocs = [{ id: N, kind: 'spam', policy: 'hide', updatedAtMs: watchNow - 6 * H }];
  const dbL = fakeDb({ calls, labels: labelDocs });
  const rL = await watch.runWatch({ db: dbL, nowMs: watchNow, live: true, push });
  const bell = dbL.sets.filter((s) => s[0] === 'notifications').map((s) => s[1].message).join('|');
  ok('a hidden number\'s urgent call is NOT in the alert; the real customer is', rL.needs === 1 && /Real Customer/.test(bell) && !/…2222/.test(bell), JSON.stringify(rL) + ' ' + bell);
  const dbN = fakeDb({ calls, labels: [] });
  const rN = await watch.runWatch({ db: dbN, nowMs: watchNow, live: true, push });
  ok('control: with no labels both calls alert', rN.needs === 2, JSON.stringify(rN));
  const dbT = fakeDb({ calls, labelsThrow: true });
  const rT = await watch.runWatch({ db: dbT, nowMs: watchNow, live: true, push });
  ok('a failed labels read still alerts, WITHOUT labels (fail open: show Jo the call)', rT.needs === 2, JSON.stringify(rT));
  const loaded = await watch.loadLabels(fakeDb({ labels: [{ id: N, kind: 'sub', policy: 'quiet', ackAtMs: 5, updatedAtMs: 7 }, { id: 'abc', kind: 'sub' }, { id: '5550149999' }] }));
  ok('loadLabels: indexes by 10 digits, drops malformed ids and docs with no kind, keeps ack/updated stamps',
    Object.keys(loaded).join() === N && loaded[N].policy === 'quiet' && loaded[N].ackAtMs === 5 && loaded[N].updatedAtMs === 7, JSON.stringify(loaded));
  const src = require('fs').readFileSync(path.join(ROOT, 'functions/call-watch.js'), 'utf8');
  ok('callWatch only READS labels (no write to contact_labels)', /collection\('contact_labels'\)\.get\(\)/.test(src) && !/contact_labels[^\n]*\.(set|update|add|delete)\(/.test(src));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
