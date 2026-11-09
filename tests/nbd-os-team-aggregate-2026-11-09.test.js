/**
 * tests/nbd-os-team-aggregate-2026-11-09.test.js - NBD OS P2 "Team": the
 * scheduled team aggregate (functions/leaderboard-aggregate.js + -logic.js;
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5, §8 P2).
 *
 * Every 30 minutes the server writes one row per company member to
 * leaderboard/{uid} (the path firestore.rules already opens to the member's own
 * company and closes to every client write): today's and this week's COUNTED
 * numbers, in the company's time zone (companyProfile.timeZone), weeks starting
 * Monday. The metrics, and why each is one the CRM already records:
 *   doors      knocks the member logged (knocks.userId, createdAt)
 *   appts      those knocks with disposition 'appointment' (the D2D "Appointment
 *              set" outcome; the Leaderboard page counts the same)
 *   estimates  leads the member moved into an estimate-sent stage
 *              (estimate_sent_cash / estimate_submitted), from stageHistory
 *              { to, timestamp, by } (stage-write.js), each lead once per window
 *   deals      the member's sales (stage-roles.js isSale) dated by the SALE date
 *              (closedAt, else the first move into a sale stage), over every job
 *              (jobs-logic.js jobRecords), never updatedAt
 * Covered here: the zone day / week boundaries (New York both DST switches,
 * Phoenix, Kolkata's half hour, Santiago's missing midnight, UTC), the metric
 * rules, the row shape, and the runner over a fake Firestore (rows written with
 * companyId, a removed member's row deleted, an unchanged second run writes
 * nothing, the dry run writes nothing), plus the export, the index entry and
 * the cron gate.
 *
 * Run: node tests/nbd-os-team-aggregate-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const req = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return { __err: e.message }; } };
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; } };
const Z = (iso) => Date.parse(iso);

const L = req('functions/leaderboard-aggregate-logic.js');
const has = (fn) => L && typeof L[fn] === 'function';

(async () => {
  console.log('\n1. the logic module');
  ok('functions/leaderboard-aggregate-logic.js loads', L && !L.__err, L && L.__err);
  ['validTimeZone', 'companyZone', 'ymdInZone', 'mondayOf', 'dayStartMs', 'bounds', 'memberRows', 'rowDoc', 'sameRow'].forEach((fn) => ok('exports ' + fn, has(fn)));
  if (!has('bounds')) { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(1); }

  console.log('\n2. the company time zone');
  ok('a real IANA zone is valid', L.validTimeZone('America/Chicago') && L.validTimeZone('UTC') && L.validTimeZone('Asia/Kolkata'));
  ok('junk, a number, an empty string and 65 chars are not', !L.validTimeZone('Mars/Olympus') && !L.validTimeZone(5) && !L.validTimeZone('') && !L.validTimeZone('A'.repeat(65)));
  ok('companyProfile.timeZone is the zone', J(L.companyZone({ timeZone: 'America/Denver' })) === J({ tz: 'America/Denver', set: true }));
  ok('the older lowercase timezone (agent settings) still counts', L.companyZone({ timezone: 'America/Chicago' }).tz === 'America/Chicago');
  ok('an invalid timeZone is skipped for the next one', L.companyZone({ timeZone: 'Nope/Zone', brand: { timeZone: 'America/Phoenix' } }).tz === 'America/Phoenix');
  ok('no zone: Eastern, the house default every server day rule uses, marked not set',
    J(L.companyZone({})) === J({ tz: 'America/New_York', set: false }) && J(L.companyZone(null)) === J({ tz: 'America/New_York', set: false }));

  console.log('\n3. day and week boundaries in the zone (weeks start Monday)');
  ok('Mon 2026-11-09 is its own Monday; Sun 2026-11-08 belongs to Mon 2026-11-02', L.mondayOf('2026-11-09') === '2026-11-09' && L.mondayOf('2026-11-08') === '2026-11-02');
  ok('a Monday across a month and year edge', L.mondayOf('2027-01-01') === '2026-12-28' && L.mondayOf('2026-03-01') === '2026-02-23');
  // New York, spring forward Sun 2026-03-08 02:00 (a 23-hour day)
  ok('NY spring-forward day starts at 05:00Z (EST)', L.dayStartMs('2026-03-08', 'America/New_York') === Z('2026-03-08T05:00:00Z'));
  ok('the next NY day starts at 04:00Z (EDT)', L.dayStartMs('2026-03-09', 'America/New_York') === Z('2026-03-09T04:00:00Z'));
  // fall back Sun 2026-11-01 02:00 (a 25-hour day)
  ok('NY fall-back day starts at 04:00Z (EDT)', L.dayStartMs('2026-11-01', 'America/New_York') === Z('2026-11-01T04:00:00Z'));
  ok('the next NY day starts at 05:00Z (EST)', L.dayStartMs('2026-11-02', 'America/New_York') === Z('2026-11-02T05:00:00Z'));
  ok('Phoenix keeps -07:00 all year', L.dayStartMs('2026-03-08', 'America/Phoenix') === Z('2026-03-08T07:00:00Z') && L.dayStartMs('2026-11-01', 'America/Phoenix') === Z('2026-11-01T07:00:00Z'));
  ok('Kolkata is +05:30', L.dayStartMs('2026-11-09', 'Asia/Kolkata') === Z('2026-11-08T18:30:00Z'));
  ok('UTC is UTC', L.dayStartMs('2026-11-09', 'UTC') === Z('2026-11-09T00:00:00Z'));
  ok('Santiago 2026-09-06 has no midnight (clocks jump 00:00 -> 01:00): the day starts at its first instant, 04:00Z',
    L.dayStartMs('2026-09-06', 'America/Santiago') === Z('2026-09-06T04:00:00Z'), new Date(L.dayStartMs('2026-09-06', 'America/Santiago')).toISOString());
  {
    // 11:30 PM Sunday Nov 1 in New York (after fall-back) = 04:30Z Monday
    const b = L.bounds(Z('2026-11-02T04:30:00Z'), 'America/New_York');
    ok('at 11:30 PM Sun Nov 1 (NY) today is 2026-11-01, the week Mon 2026-10-26', b.dayKey === '2026-11-01' && b.weekKey === '2026-10-26', J(b));
    ok('the week started at 04:00Z on Oct 26 (still EDT), the day at 04:00Z Nov 1', b.weekStartMs === Z('2026-10-26T04:00:00Z') && b.dayStartMs === Z('2026-11-01T04:00:00Z'), J(b));
    const u = L.bounds(Z('2026-11-02T04:30:00Z'), 'UTC');
    ok('the same instant is already Monday Nov 2 for a UTC company', u.dayKey === '2026-11-02' && u.weekKey === '2026-11-02');
  }
  {
    const b = L.bounds(Z('2026-03-08T12:00:00Z'), 'America/New_York');
    ok('Sun 2026-03-08 08:00 EDT: today began 05:00Z, the week Mon 2026-03-02 05:00Z', b.dayStartMs === Z('2026-03-08T05:00:00Z') && b.weekStartMs === Z('2026-03-02T05:00:00Z') && b.dayKey === '2026-03-08', J(b));
  }

  console.log('\n4. the counted metrics');
  const now = Z('2026-11-02T04:30:00Z');   // 11:30 PM Sun Nov 1, New York
  const b = L.bounds(now, 'America/New_York');
  const T = (iso) => ({ toMillis: () => Z(iso) });   // a Firestore Timestamp
  const members = [{ uid: 'u1', name: 'Riley' }, { uid: 'u2', name: 'Jordan' }];
  const knocks = [
    { userId: 'u1', createdAt: T('2026-11-02T04:10:00Z'), disposition: 'not_home' },      // 11:10 PM Nov 1: today
    { userId: 'u1', createdAt: T('2026-11-01T05:30:00Z'), disposition: 'appointment' },   // 12:30 AM EST Nov 1 (after fall-back): today
    { userId: 'u1', createdAt: T('2026-11-01T03:59:00Z'), disposition: 'appointment' },   // 11:59 PM Oct 31 EDT: week, not today
    { userId: 'u1', createdAt: T('2026-10-26T04:00:00Z'), disposition: 'storm_damage' },  // Mon 12:00 AM: the first instant of the week
    { userId: 'u1', createdAt: T('2026-10-26T03:59:59Z'), disposition: 'appointment' },   // Sun Oct 25 11:59 PM: last week
    { userId: 'u2', createdAt: { seconds: Z('2026-10-30T15:00:00Z') / 1000 }, disposition: 'appointment' },
    { userId: 'zz', createdAt: T('2026-11-01T15:00:00Z'), disposition: 'appointment' },   // not a member
    { userId: 'u2', createdAt: null, disposition: 'not_home' },                           // undated: not counted
  ];
  const H = (to, iso, by) => ({ from: 'inspected', to, timestamp: iso, by });
  const leads = [
    // estimates: u1 moved two leads to an estimate stage this week (one of them twice), one last week
    { id: 'L1', userId: 'u2', stage: 'estimate_sent_cash', stageHistory: [H('estimate_sent_cash', '2026-11-01T14:00:00.000Z', 'u1'), H('negotiating', '2026-11-01T15:00:00.000Z', 'u1'), H('estimate_sent_cash', '2026-11-01T16:00:00.000Z', 'u1')] },
    { id: 'L2', userId: 'u1', stage: 'estimate_submitted', stageHistory: [H('estimate_submitted', '2026-10-28T14:00:00.000Z', 'u1')] },
    { id: 'L3', userId: 'u1', stage: 'estimate_submitted', stageHistory: [H('estimate_submitted', '2026-10-20T14:00:00.000Z', 'u1')] },
    { id: 'L4', userId: 'u1', stage: 'Estimate Sent', stageHistory: [H('Estimate Sent', '2026-11-01T18:00:00.000Z', 'zz')] },   // a non-member's move
    // deals
    { id: 'D1', userId: 'u2', stage: 'closed', closedAt: T('2026-11-01T20:00:00Z') },                       // today
    { id: 'D2', userId: 'u2', stage: 'contract_signed', stageHistory: [H('contract_signed', '2026-10-27T15:00:00.000Z', 'u2')] },   // no closedAt: the first sale move dates it
    { id: 'D3', userId: 'u2', stage: 'closed', closedAt: T('2026-10-20T15:00:00Z') },                       // last week
    { id: 'D4', userId: 'u2', stage: 'closed', closedAt: T('2026-11-01T15:00:00Z'), deleted: true },       // deleted
    { id: 'D5', userId: 'u2', stage: 'lost', closedAt: T('2026-11-01T15:00:00Z') },                         // lost is not a sale
    { id: 'D6', userId: 'u1', stage: 'negotiating', updatedAt: T('2026-11-01T15:00:00Z') },                 // edited this week, not a sale
    { id: 'D7', userId: 'u1', stage: 'closed', closedAt: T('2026-09-01T15:00:00Z'), updatedAt: T('2026-11-01T15:00:00Z'), activeJobId: 'j1' },   // old win edited today: not again
  ];
  const jobsByLead = { D7: [{ id: 'j1', stage: 'closed' }, { id: 'j2', stage: 'contract_signed', closedAt: T('2026-10-29T15:00:00Z') }] };   // its second job sold this week
  const rows = L.memberRows({ members, knocks, leads, jobsByLead, bounds: b });
  ok('a row per member, nobody else', J(Object.keys(rows).sort()) === J(['u1', 'u2']), J(Object.keys(rows)));
  ok('u1 doors: 2 today, 4 this week (Mon 00:00 in, Sun 23:59:59 out; fall-back counted once)', rows.u1.today.doors === 2 && rows.u1.week.doors === 4, J(rows.u1));
  ok('u1 appointments: 1 today, 2 this week', rows.u1.today.appts === 1 && rows.u1.week.appts === 2, J(rows.u1));
  ok('u2 doors: 0 today, 1 this week (an undated knock is not counted)', rows.u2.today.doors === 0 && rows.u2.week.doors === 1, J(rows.u2));
  ok('u1 estimates: 1 today (L1 once, though moved twice), 2 this week; last week\'s and a non-member\'s move are not', rows.u1.today.estimates === 1 && rows.u1.week.estimates === 2, J(rows.u1));
  ok('estimates go to whoever moved the lead (u1 moved u2\'s lead): u2 has none', rows.u2.week.estimates === 0);
  ok('u2 deals: 1 today, 2 this week (closed today; signed Tuesday with no closedAt)', rows.u2.today.deals === 1 && rows.u2.week.deals === 2, J(rows.u2));
  ok('u1 deals: the second job sold this week counts; the old win edited today does not', rows.u1.week.deals === 1 && rows.u1.today.deals === 0, J(rows.u1));
  ok('every number is a whole number', ['u1', 'u2'].every((u) => ['today', 'week'].every((p) => Object.values(rows[u][p]).every((n) => Number.isInteger(n) && n >= 0))));
  const noJobs = L.memberRows({ members, knocks: [], leads, jobsByLead: null, bounds: b });
  ok('without the jobs read, each customer counts once by its own fields (D7\'s old win stays out)', noJobs.u1.week.deals === 0 && noJobs.u2.week.deals === 2, J(noJobs));
  const none = L.memberRows({ members: [{ uid: 'u9', name: 'New' }], knocks: [], leads: [], bounds: b });
  ok('a member with nothing gets zeros (counted: nothing happened), not a missing row', J(none.u9.today) === J({ doors: 0, appts: 0, estimates: 0, deals: 0 }));

  console.log('\n5. the row');
  const row = L.rowDoc({ companyId: 'c1', uid: 'u1', name: 'Riley <b>', metrics: rows.u1, bounds: b, zone: { tz: 'America/New_York', set: true }, nowMs: now });
  ok('the row: companyId, uid, name, tz, tzSet, dayKey, weekKey, today, week, asOfMs',
    J(Object.keys(row).sort()) === J(['asOfMs', 'companyId', 'dayKey', 'name', 'today', 'tz', 'tzSet', 'uid', 'week', 'weekKey']), J(Object.keys(row)));
  ok('stamped with the zone and its keys', row.companyId === 'c1' && row.tz === 'America/New_York' && row.dayKey === '2026-11-01' && row.weekKey === '2026-10-26' && row.asOfMs === now);
  ok('the name is kept as text (the readers escape it), at most 60 chars', row.name === 'Riley <b>' && L.rowDoc({ companyId: 'c1', uid: 'u', name: 'x'.repeat(90), metrics: none.u9, bounds: b, zone: { tz: 'UTC', set: false }, nowMs: now }).name.length === 60);
  ok('no money, no customer and no lead id in a row', !/revenue|jobValue|amount|address|leadId|firstName/i.test(J(row)));
  ok('sameRow ignores asOfMs only', L.sameRow(row, Object.assign({}, row, { asOfMs: now + 60000 })) && !L.sameRow(row, Object.assign({}, row, { dayKey: '2026-11-02' })) && !L.sameRow(row, null));

  console.log('\n6. the runner over a fake Firestore');
  const AGG = req('functions/leaderboard-aggregate.js');
  ok('functions/leaderboard-aggregate.js loads and exposes runAggregate', AGG && typeof AGG.runAggregate === 'function', AGG && AGG.__err);
  if (AGG && typeof AGG.runAggregate === 'function') {
    const store = {
      'companies/c1': { ownerId: 'u1' },
      'companies/c1/members/riley@example.com': { uid: 'u1', displayName: 'Riley', status: 'active' },
      'companies/c1/members/jordan@example.com': { uid: 'u2', displayName: 'Jordan', status: 'active' },
      'companies/c1/members/gone@example.com': { uid: 'u3', displayName: 'Gone', status: 'deactivated' },
      'companies/c1/members/invited@example.com': { email: 'invited@example.com', status: 'invited' },
      'companyProfile/c1': { timeZone: 'America/Chicago' },
      'leaderboard/u3': { companyId: 'c1', uid: 'u3', name: 'Gone' },
      'leaderboard/other': { companyId: 'c2', uid: 'other' },
      'knocks/k1': { userId: 'u1', companyId: 'c1', createdAt: T('2026-11-01T15:00:00Z'), disposition: 'appointment' },
      'knocks/k2': { userId: 'u2', companyId: 'c1', createdAt: T('2026-10-20T15:00:00Z'), disposition: 'not_home' },
      'leads/D1': { userId: 'u2', stage: 'closed', closedAt: T('2026-11-01T20:00:00Z'), updatedAt: T('2026-11-01T20:00:00Z') },
      'leads/D1/jobs/j1': { stage: 'closed' },
    };
    const db = fakeDb(store);
    const r1 = await AGG.runAggregate({ db, nowMs: now, live: true });
    ok('one company, two members written, one stale row removed', r1.companies === 1 && r1.written === 2 && r1.removed === 1, J(r1));
    const u1 = store['leaderboard/u1'], u2 = store['leaderboard/u2'];
    ok('rows carry companyId and the Chicago zone (11:30 PM NY = 10:30 PM Central, still Sun Nov 1)', u1 && u1.companyId === 'c1' && u1.tz === 'America/Chicago' && u1.tzSet === true && u1.dayKey === '2026-11-01', J(u1));
    ok('Riley: 1 door, 1 appointment today; Jordan: 1 deal today, last week\'s knock out', u1 && u1.today.doors === 1 && u1.today.appts === 1 && u2 && u2.today.deals === 1 && u2.week.doors === 0, J([u1, u2]));
    ok('the deactivated member\'s row is gone; another company\'s row is untouched', !store['leaderboard/u3'] && !!store['leaderboard/other']);
    ok('no invited (uid-less) member gets a row', Object.keys(store).filter((k) => /^leaderboard\//.test(k)).length === 3);
    const writes = db.writes.length;
    const r2 = await AGG.runAggregate({ db, nowMs: now + 60000, live: true });
    ok('an unchanged second run writes nothing', r2.written === 0 && r2.unchanged === 2 && db.writes.length === writes, J(r2));
    const db3 = fakeDb(Object.assign({}, store, { 'leaderboard/u1': undefined }));
    const r3 = await AGG.runAggregate({ db: db3, nowMs: now, live: false });
    ok('the dry run (gate off) computes but writes nothing', db3.writes.length === 0 && r3.written === 0 && r3.wouldWrite >= 1, J(r3));
    ok('the reads are bounded: knocks and leads by userId from the week start, never a whole collection',
      db.queries.every((q) => q.coll !== 'knocks' || (q.where.some((w) => w[0] === 'userId') && q.where.some((w) => w[0] === 'createdAt' && w[1] === '>=')))
      && db.queries.every((q) => q.coll !== 'leads' || (q.where.some((w) => w[0] === 'userId') && q.where.some((w) => w[0] === 'updatedAt' && w[1] === '>='))), J(db.queries.slice(0, 6)));
  }

  console.log('\n7. wired: export, schedule, index entry, cron gate, indexes');
  const SRC = read('functions/leaderboard-aggregate.js');
  ok('scheduled every 30 minutes with the heartbeat onSchedule', /require\('\.\/integrations\/heartbeat'\)/.test(SRC) && /schedule:\s*'every 30 minutes'/.test(SRC));
  ok('writes only when LEADERBOARD_AGGREGATE_ENABLED is "true" (dry run otherwise)', /process\.env\.LEADERBOARD_AGGREGATE_ENABLED === 'true'/.test(SRC));
  ok('functions/index.js exports leaderboardAggregate', /exports\.leaderboardAggregate = require\('\.\/leaderboard-aggregate'\)\.leaderboardAggregate;/.test(read('functions/index.js')));
  ok('FUNCTIONS_INDEX.md lists leaderboardAggregate', /\| `leaderboardAggregate` \|/.test(read('functions/FUNCTIONS_INDEX.md')));
  const gates = req('functions/cron-gates.js');
  ok('cron-gates.js registers the gate', !!(gates && gates.CRON_GATES && gates.CRON_GATES.some((g) => g.name === 'LEADERBOARD_AGGREGATE_ENABLED' && g.polarity === 'enabled' && g.file === 'leaderboard-aggregate.js')));
  const IDX = JSON.parse(read('firestore.indexes.json') || '{"indexes":[]}').indexes;
  const hasIdx = (coll, fields) => IDX.some((i) => i.collectionGroup === coll && (i.queryScope || 'COLLECTION') === 'COLLECTION' && J(i.fields.map((f) => [f.fieldPath, f.order])) === J(fields));
  ok('the knocks query has its index (userId ASC, createdAt ASC)', hasIdx('knocks', [['userId', 'ASCENDING'], ['createdAt', 'ASCENDING']]));
  ok('the leads query has its index (userId ASC, updatedAt DESC)', hasIdx('leads', [['userId', 'ASCENDING'], ['updatedAt', 'DESCENDING']]));
  ok('the leads query orders updatedAt desc (so that index serves it)', /orderBy\('updatedAt', 'desc'\)/.test(SRC));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

/** A tiny Firestore: collection / doc / where (==, >=) / orderBy / limit / startAfter / get / set / delete. */
function fakeDb(store) {
  Object.keys(store).forEach((k) => { if (store[k] === undefined) delete store[k]; });
  const writes = [], queries = [];
  const ms = (v) => (v == null ? null : typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime()
    : typeof v.seconds === 'number' ? v.seconds * 1000 : typeof v === 'number' ? v : null);
  const snap = (p) => ({ id: p.split('/').pop(), exists: Object.prototype.hasOwnProperty.call(store, p), data: () => (store[p] ? Object.assign({}, store[p]) : undefined),
    ref: { path: p, parent: { parent: p.split('/').length > 3 ? { id: p.split('/')[1] } : null } } });
  function docRef(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => snap(p),
      set: async (d) => { writes.push(['set', p]); store[p] = d; },
      delete: async () => { writes.push(['delete', p]); delete store[p]; },
      collection: (c) => coll(p + '/' + c),
    };
  }
  function coll(cp, q) {
    q = q || { where: [], order: null, lim: 0, after: null };
    const api = {
      doc: (id) => docRef(cp + '/' + id),
      where: (f, op, v) => coll(cp, Object.assign({}, q, { where: q.where.concat([[f, op, v]]) })),
      orderBy: (f, dir) => coll(cp, Object.assign({}, q, { order: [f, dir || 'asc'] })),
      limit: (n) => coll(cp, Object.assign({}, q, { lim: n })),
      startAfter: (d) => coll(cp, Object.assign({}, q, { after: d && d.id })),
      get: async () => {
        queries.push({ coll: cp, where: q.where.map((w) => [w[0], w[1]]) });
        const depth = cp.split('/').length + 1;
        let ids = Object.keys(store).filter((k) => k.indexOf(cp + '/') === 0 && k.split('/').length === depth).sort();
        ids = ids.filter((k) => q.where.every(([f, op, v]) => {
          const x = f && f.constructor && f.constructor.name === 'FieldPath' ? k.split('/').pop() : store[k][f];
          if (op === '==') return x === v;
          if (op === '>=') { const a = ms(x), c = ms(v); return a != null && c != null && a >= c; }
          return false;
        }));
        if (q.after) ids = ids.filter((k) => k.split('/').pop() > q.after);
        if (q.lim) ids = ids.slice(0, q.lim);
        const docs = ids.map(snap);
        return { docs, empty: !docs.length, size: docs.length, forEach: (f) => docs.forEach(f) };
      },
    };
    return api;
  }
  return { collection: (c) => coll(c), doc: (p) => docRef(p), writes, queries };
}
