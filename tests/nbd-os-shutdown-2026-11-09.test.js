/**
 * tests/nbd-os-shutdown-2026-11-09.test.js - NBD OS P1: the Shutdown ritual's pure
 * half (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6.2).
 *
 * docs/pro/js/os/shutdown-logic.js, table-driven:
 *   - own vs team leads (a manager's _leads carries the team's; only the rep's own are listed)
 *   - touched today by a HUMAN stamp (lastContactedAt, lastOutboundAt, a stageHistory
 *     entry by this uid, a task completed today, a door knock made today) vs a server
 *     stamp (updatedAt, stageStartedAt, lastInboundAt, a web-form createdAt): never a touch
 *   - fails no-next-step.js hasNextStep (the shared function, not a copy)
 *   - today's unfiled visits (the recorder's isUnfiled, part 2 is the same visit)
 *   - overdue promises from the Today plan
 *   - "Loop closed: N leads, N visits" from counts only; visits unknown -> not said
 *   - the carry-over is ids only, this uid's, today's
 *
 * Run: node tests/nbd-os-shutdown-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const G = (fn) => { try { fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } };
const req = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return null; } };
const read = (p) => (fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : '');

const S = req('docs/pro/js/os/shutdown-logic.js');
const NNS = req('docs/pro/js/no-next-step.js');
const SRC = read('docs/pro/js/os/shutdown-logic.js');

console.log('\n1. the module');
ok('docs/pro/js/os/shutdown-logic.js exists and require()s', !!S && typeof S.build === 'function');
if (!S) { console.log('\n' + passed + ' passed, ' + (failed) + ' failed'); process.exit(1); }
ok('it is UMD: window.NBDOSShutdownLogic in the browser, module.exports in Node', /root\.NBDOSShutdownLogic = api/.test(SRC) && /module\.exports = api/.test(SRC));
ok('pure: no DOM, no storage, no network, no Date.now()', !/document\.|localStorage|fetch\(|getDoc|updateDoc|Date\.now\(\)/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')));

const NOW = new Date(2026, 10, 9, 17, 30).getTime();   // Mon Nov 9 2026, 5:30 PM local
const TODAY_10 = new Date(2026, 10, 9, 10, 0).getTime();
const YDAY = new Date(2026, 10, 8, 15, 0).getTime();
const UID = 'rep1';
const iso = (ms) => new Date(ms).toISOString();
const ts = (ms) => ({ toMillis: () => ms });
function lead(id, extra) { return Object.assign({ id, firstName: 'Lee', lastName: id, address: id + ' Oak St, Town, OH', stage: 'contacted', userId: UID }, extra || {}); }

console.log('\n2. own vs team leads, touched vs server-stamped, next step (table)');
G(() => {
  const CASES = [
    // [name, lead, taskCache, listed?, closed (has next step)?]
    ['own, called today, no next step -> listed', lead('a', { lastContactedAt: ts(TODAY_10), lastContactType: 'call' }), null, true, false],
    ['own via assignedTo (no userId), texted today -> listed', lead('b', { userId: undefined, assignedTo: UID, lastContactedAt: TODAY_10, lastContactType: 'text' }), null, true, false],
    ['team lead (another rep), called today -> NOT listed (a manager\'s _leads)', lead('c', { userId: 'rep2', lastContactedAt: TODAY_10 }), null, false, false],
    ['no owner field at all -> NOT listed', lead('d', { userId: undefined, lastContactedAt: TODAY_10 }), null, false, false],
    ['own, only updatedAt today (a server stamp) -> NOT a touch', lead('e', { updatedAt: ts(TODAY_10) }), null, false, false],
    ['own, only stageStartedAt today (a server stamp) -> NOT a touch', lead('f', { stageStartedAt: ts(TODAY_10) }), null, false, false],
    ['own, only lastInboundAt today (the customer\'s action) -> NOT a touch', lead('g', { lastInboundAt: ts(TODAY_10) }), null, false, false],
    ['own, web-form lead created today -> NOT a touch', lead('h', { createdAt: ts(TODAY_10), source: 'website' }), null, false, false],
    ['own, door-knock lead created today -> listed (Knocked today)', lead('i', { createdAt: ts(TODAY_10), d2dKnockId: 'k1' }), null, true, false],
    ['own, stage moved today BY this rep -> listed', lead('j', { stageHistory: [{ from: 'new', to: 'contacted', at: iso(TODAY_10), by: UID }] }), null, true, false],
    ['own, stage moved today by someone else -> NOT a touch', lead('k', { stageHistory: [{ from: 'new', to: 'contacted', timestamp: iso(TODAY_10), by: 'rep2' }] }), null, false, false],
    ['own, stage-write.js entry (timestamp) by this rep today -> listed', lead('l', { stageHistory: [{ to: 'contacted', timestamp: iso(TODAY_10), by: UID }] }), null, true, false],
    ['own, "I replied" (lastOutboundAt) today -> listed', lead('m', { lastOutboundAt: ts(TODAY_10) }), null, true, false],
    ['own, a task completed today and none open -> listed', lead('n'), { n: [{ done: true, completedAt: ts(TODAY_10) }] }, true, false],
    ['own, called YESTERDAY -> NOT today', lead('o', { lastContactedAt: YDAY }), null, false, false],
    ['own, called today, has a follow-up date -> not listed, counted closed', lead('p', { lastContactedAt: TODAY_10, followUp: '2026-11-10' }), null, false, true],
    ['own, called today, has an open task -> closed', lead('q', { lastContactedAt: TODAY_10 }), { q: [{ done: false, title: 'Call back' }] }, false, true],
    ['own, called today, snoozed into the future -> closed', lead('r', { lastContactedAt: TODAY_10, snoozedUntil: ts(NOW + 86400000 * 3) }), null, false, true],
    ['own, called today, but lost -> not open, ignored', lead('s', { lastContactedAt: TODAY_10, stage: 'lost' }), null, false, false],
    ['own, called today, deleted -> ignored', lead('t', { lastContactedAt: TODAY_10, deleted: true }), null, false, false],
    ['own, called today, a won/closed stage -> ignored', lead('u', { lastContactedAt: TODAY_10, stage: 'closed' }), null, false, false],
  ];
  CASES.forEach(([name, l, tc, listed, closed]) => {
    const r = S.build({ leads: [l], uid: UID, now: NOW, taskCache: tc || {}, visits: [], plan: null, nns: NNS });
    const got = r.leads.length === 1 && r.leads[0].leadId === l.id;
    ok(name, got === listed && (r.closed.leads === (closed ? 1 : 0)), J({ rows: r.leads, closed: r.closed }));
  });
  ok('words say what the touch was (Called / Texted / Stage moved / Knocked)', (() => {
    const r = S.build({ leads: [CASES[0][1], CASES[1][1], CASES[8][1], CASES[9][1]], uid: UID, now: NOW, visits: [], nns: NNS });
    const w = {}; r.leads.forEach((x) => { w[x.leadId] = x.words; });
    return w.a === 'Called today' && w.b === 'Texted today' && w.i === 'Knocked today' && w.j === 'Stage moved today';
  })());
  ok('most recent touch first', (() => {
    const r = S.build({ leads: [lead('x', { lastContactedAt: TODAY_10 }), lead('y', { lastContactedAt: TODAY_10 + 3600000 })], uid: UID, now: NOW, visits: [], nns: NNS });
    return r.leads.map((x) => x.leadId).join() === 'y,x';
  })());
  ok('no uid -> no rows (never someone else\'s by default)', S.build({ leads: [CASES[0][1]], uid: '', now: NOW, nns: NNS }).leads.length === 0);
  ok('it uses no-next-step.js hasNextStep itself (a spy sees every candidate)', (() => {
    const seen = [];
    const spy = Object.assign({}, NNS, { hasNextStep: (l, t, n) => { seen.push(l.id); return NNS.hasNextStep(l, t, n); } });
    S.build({ leads: [lead('a', { lastContactedAt: TODAY_10 }), lead('c', { userId: 'rep2', lastContactedAt: TODAY_10 }), lead('e', { updatedAt: TODAY_10 })], uid: UID, now: NOW, nns: spy });
    return seen.join() === 'a';
  })());
  ok('in Node it finds no-next-step.js on its own (no env.nns)', S.build({ leads: [CASES[0][1]], uid: UID, now: NOW }).leads.length === 1);
  ok('the tenant\'s stage role decides open (a renamed won stage is not listed)', (() => {
    const l = lead('w', { stage: 'paid_up', lastContactedAt: TODAY_10 });
    const r = S.build({ leads: [l], uid: UID, now: NOW, nns: NNS, stageRole: (k) => (k === 'paid_up' ? 'won' : 'active') });
    return r.leads.length === 0;
  })());
});

console.log('\n3. today\'s unfiled visits');
G(() => {
  const v = (id, extra) => Object.assign({ id, startedAtMs: TODAY_10, status: 'uploaded' }, extra || {});
  const CASES = [
    ['unfiled today -> a row', [v('v1')], 1, 0],
    ['filed today (on a customer) -> counted filed, no row', [v('v2', { leadId: 'L1' })], 0, 1],
    ['unfiled YESTERDAY -> not today\'s', [v('v3', { startedAtMs: YDAY })], 0, 0],
    ['still recording -> neither', [v('v4', { status: 'recording' })], 0, 0],
    ['discarded -> neither', [v('v5', { status: 'discarded' })], 0, 0],
    ['skipped by the pipeline -> neither', [v('v6', { pipelineStatus: 'skipped' })], 0, 0],
    ['part 2 of a capped recording is the same visit', [v('v7'), v('v8', { partOf: 'v7', startedAtMs: TODAY_10 + 3600000 })], 1, 0],
    ['another device\'s visit not uploaded yet -> not listed', [v('v9', { remoteOnly: true, status: 'queued' })], 0, 0],
    ['the same visit local and remote -> once', [v('v10'), v('v10')], 1, 0],
  ];
  CASES.forEach(([name, rows, n, filed]) => {
    const r = S.build({ leads: [], uid: UID, now: NOW, visits: rows, nns: NNS });
    ok(name, (r.visits || []).length === n && r.closed.visits === filed, J(r));
  });
  ok('the recorder\'s own isUnfiled is used when given', (() => {
    const seen = [];
    S.build({ leads: [], uid: UID, now: NOW, visits: [v('v11')], nns: NNS, isUnfiled: (r) => { seen.push(r.id); return true; } });
    return seen.join() === 'v11';
  })());
  ok('visits not read (null) -> rows null and the filed count unknown, never 0', (() => {
    const r = S.build({ leads: [], uid: UID, now: NOW, visits: null, nns: NNS });
    return r.visits === null && r.closed.visits === null;
  })());
});

console.log('\n4. overdue promises (the Today plan)');
G(() => {
  const plan = { promises: [
    { leadId: 'P1', name: 'Pat One', missTotal: 2, promiseTasks: [{ overdue: true }] },
    { leadId: 'P2', name: 'Pam Two', missTotal: 0, promiseTasks: [{ overdue: false }] },
    { leadId: 'a', name: 'Lee a', promiseTasks: [{ overdue: true }] },
  ] };
  const r = S.build({ leads: [lead('a', { lastContactedAt: TODAY_10 })], uid: UID, now: NOW, plan, visits: [], nns: NNS });
  ok('a promise past due is a row; one not due yet is not', r.promises.map((p) => p.leadId).indexOf('P1') !== -1 && r.promises.map((p) => p.leadId).indexOf('P2') === -1);
  ok('its miss count comes from the plan', r.promises.filter((p) => p.leadId === 'P1')[0].misses === 2);
  ok('a lead already on the list is not listed twice', r.promises.every((p) => p.leadId !== 'a'));
  ok('open = leads + visits + promises', r.open === r.leads.length + r.visits.length + r.promises.length && r.open === 2);
  ok('no plan -> no promise rows', S.build({ leads: [], uid: UID, now: NOW, plan: null, nns: NNS }).promises.length === 0);
});

console.log('\n5. words from counts only');
G(() => {
  ok('"Loop closed: 3 leads, 1 visit"', S.closedLine({ leads: 3, visits: 1 }) === 'Loop closed: 3 leads, 1 visit');
  ok('"Loop closed: 1 lead, 0 visits" (a counted 0 is said)', S.closedLine({ leads: 1, visits: 0 }) === 'Loop closed: 1 lead, 0 visits');
  ok('visits not counted -> not said', S.closedLine({ leads: 2, visits: null }) === 'Loop closed: 2 leads');
  ok('no counts -> nothing (never a default number)', S.closedLine(null) === '' && S.closedLine({ leads: 'x' }) === '' && S.closedLine({}) === '');
  ok('the widget line counts leads and promises', S.widgetLine({ leads: [1, 2], promises: [1] }) === '2 leads with no next step · 1 promise past due');
  ok('the widget line with none open', S.widgetLine({ leads: [], promises: [] }) === 'Every lead you touched today has a next step');
  ok('every digit the builder emits is a count it was given', (() => {
    const line = S.closedLine({ leads: 7, visits: 4 });
    return (line.match(/\d+/g) || []).join() === '7,4';
  })());
});

console.log('\n6. the 4 PM - 8 PM window and follow-up dates');
G(() => {
  const at = (h, m) => new Date(2026, 10, 9, h, m || 0).getTime();
  [[15, 59, false], [16, 0, true], [19, 59, true], [20, 0, false], [9, 0, false]].forEach(([h, m, want]) => {
    ok('inWindow ' + h + ':' + String(m).padStart(2, '0') + ' -> ' + want, S.inWindow(at(h, m)) === want);
  });
  ok('Tomorrow / +3 days / +1 week in the followUp field\'s YYYY-MM-DD', S.followUpYmd(1, NOW) === '2026-11-10' && S.followUpYmd(3, NOW) === '2026-11-12' && S.followUpYmd(7, NOW) === '2026-11-16');
  ok('same as no-next-step.js followUpIn (one format for the field)', [1, 3, 7].every((n) => S.followUpYmd(n, NOW) === NNS.followUpIn(n, NOW)));
});

console.log('\n7. carry-over for the Welcome Recap (device-only)');
G(() => {
  const r = S.build({ leads: [lead('a', { lastContactedAt: TODAY_10 })], uid: UID, now: NOW, visits: [{ id: 'v1', startedAtMs: TODAY_10, status: 'uploaded' }], plan: { promises: [{ leadId: 'P1', name: 'Pat', promiseTasks: [{ overdue: true }] }] }, nns: NNS });
  const c = S.carry(r, UID, NOW);
  ok('ids only: leads, visits, promises; this uid and today', J(c) === J({ v: 1, uid: UID, dk: '2026-11-09', at: NOW, leads: ['a'], visits: ['v1'], promises: ['P1'] }), J(c));
  ok('no names or addresses in it', !/Lee|Oak|Pat/.test(J(c)));
  ok('an nbd_ key, so sign-out wipes it', /^nbd_/.test(S.CARRY_KEY));
  ok('no uid -> nothing stored', S.carry(r, '', NOW) === null);
  ok('capped at 30 per list', (() => {
    const many = []; for (let i = 0; i < 40; i++) many.push(lead('m' + i, { lastContactedAt: TODAY_10 }));
    return S.carry(S.build({ leads: many, uid: UID, now: NOW, nns: NNS }), UID, NOW).leads.length === 30;
  })());
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
