/**
 * tests/st-f32-2026-11-08.test.js — CRM audit 2026-11-06, ST-F32.
 *
 * The "Iron Door" achievement (knock 500 doors) counted a rep's knocks with
 * getDocs over EVERY knock doc they ever logged, then read .size. checkAll
 * runs on init and on several track* events behind a 5 s cache, so a heavy
 * D2D rep downloaded the whole knock history over and over just to compare a
 * number with 500. Decision D-011: an unbounded read gets a server count,
 * never a client-side limit() that hides data.
 *
 * Runs the REAL modules in a vm:
 *   - server-aggregates.js NBDServerAggregates.knockCount(uid) is a Firestore
 *     count() over the same predicate the getDocs used (knocks, userId == uid,
 *     nothing wider for a team role), and answers null when it cannot count;
 *   - theme-achievements.js _gatherStats() takes totalKnocks from that count
 *     and never calls getDocs on knocks; with no aggregate module, a null
 *     answer or a failed count it falls back to the getDocs .size it had.
 * Zero deps. Run: node tests/st-f32-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const AGG_SRC = read('docs/pro/js/server-aggregates.js').replace(/\bimport\(/g, '__testImport(');
const ACH_SRC = read('docs/pro/js/theme-achievements.js');

// server-aggregates.js in a vm; the Firestore SDK is a recording stub.
function loadAggregates(opts) {
  opts = opts || {};
  const log = { counts: [], imports: [], getDocs: 0 };
  const fsStub = {
    collection: (db, name) => ({ db, name }),
    where: (f, op, v) => ({ f, op, v }),
    query: (col, ...filters) => ({ col, filters }),
    getDocs: () => { log.getDocs++; return Promise.resolve({ size: 0, docs: [] }); },
  };
  if (!opts.noCount) {
    fsStub.getCountFromServer = (q) => {
      log.counts.push(q);
      return Promise.resolve({ data: () => ({ count: opts.count == null ? 742 : opts.count }) });
    };
  }
  const win = {
    _db: opts.noDb ? undefined : { name: 'db' },
    _userClaims: opts.claims,
  };
  win.window = win;
  const sb = {
    window: win,
    console: { info() {}, warn() {}, log() {} },
    __testImport: (url) => { log.imports.push(url); return Promise.resolve(fsStub); },
  };
  vm.createContext(sb);
  vm.runInContext(AGG_SRC, sb, { filename: 'server-aggregates.js' });
  return { agg: win.NBDServerAggregates, log };
}

// theme-achievements.js in a vm with a recording Firestore surface on window.
function loadAchievements(opts) {
  opts = opts || {};
  const log = { getDocs: [], knockCount: [] };
  const el = () => ({ appendChild() {}, classList: { add() {}, remove() {} }, textContent: '' });
  const document = { readyState: 'complete', head: el(), body: el(), createElement: el, addEventListener() {} };
  const win = {
    _user: { uid: 'u1' },
    db: { name: 'db' },
    doc: (db, col, id) => ({ col, id }),
    getDoc: () => Promise.resolve({ exists: () => false, data: () => ({}) }),
    collection: (db, name) => ({ name }),
    where: (f, op, v) => ({ f, op, v }),
    query: (col, ...filters) => ({ col, filters }),
    getDocs: (q) => { log.getDocs.push(q); return Promise.resolve({ size: 3, docs: [] }); },
  };
  if (opts.aggregate !== undefined) win.NBDServerAggregates = opts.aggregate(log);
  win.window = win;
  const sb = { window: win, document, console: { info() {}, warn() {}, log() {} }, setTimeout, Date, Set, Promise };
  vm.createContext(sb);
  vm.runInContext(ACH_SRC, sb, { filename: 'theme-achievements.js' });
  return { TA: win.ThemeAchievements, log };
}
const knockReads = (log) => log.getDocs.filter((q) => q && q.col && q.col.name === 'knocks');

(async () => {
  console.log('SERVER COUNT OF A REP\'S KNOCKS (server-aggregates.js)');
  {
    const { agg, log } = loadAggregates();
    ok('NBDServerAggregates loads (positive control)', !!agg && agg.__sentinel === 'nbd-server-agg-v1');
    ok('NBDServerAggregates.knockCount exists', !!agg && typeof agg.knockCount === 'function');
    let n = 'unset', err = null;
    if (agg && typeof agg.knockCount === 'function') {
      try { n = await agg.knockCount('u1'); } catch (e) { err = e; }
    }
    ok('knockCount answers the server count', n === 742, String(n) + (err ? ' ' + err.message : ''));
    const q = log.counts[0];
    ok('one count() query, on the vendored SDK', log.counts.length === 1
      && log.imports.length === 1 && /\/assets\/vendor\/firebase\/[\d.]+\/firebase-firestore\.js$/.test(log.imports[0]), JSON.stringify(log.imports));
    ok('…over knocks, userId == uid only (the predicate the getDocs used)', !!q && q.col.name === 'knocks'
      && q.col.db && q.col.db.name === 'db'
      && q.filters.length === 1 && q.filters[0].f === 'userId' && q.filters[0].op === '==' && q.filters[0].v === 'u1',
    JSON.stringify(q));
    ok('no knock doc is downloaded', log.getDocs === 0);
  }
  {
    const { agg, log } = loadAggregates({ claims: { role: 'company_admin', companyId: 'c1' } });
    const n = agg && typeof agg.knockCount === 'function' ? await agg.knockCount('u1') : null;
    const q = log.counts[0];
    ok('a company admin still counts only their own knocks (the achievement is per rep)', n === 742
      && log.counts.length === 1 && !!q && q.filters.length === 1 && q.filters[0].f === 'userId', JSON.stringify(log.counts));
  }
  {
    const { agg } = loadAggregates({ count: 0 });
    const n = agg && typeof agg.knockCount === 'function' ? await agg.knockCount('u1') : 'missing';
    ok('a real zero comes back as 0, not null', n === 0, String(n));
  }
  {
    const a = loadAggregates({ noDb: true });
    const b = loadAggregates({ noCount: true });
    const na = a.agg && typeof a.agg.knockCount === 'function' ? await a.agg.knockCount('u1') : 'missing';
    const nb = b.agg && typeof b.agg.knockCount === 'function' ? await b.agg.knockCount('u1') : 'missing';
    ok('no db: null (the caller falls back), nothing queried', na === null && a.log.counts.length === 0, String(na));
    ok('an SDK without getCountFromServer: null', nb === null, String(nb));
  }

  console.log('\nIRON DOOR READS THE COUNT (theme-achievements.js _gatherStats)');
  {
    const { TA, log } = loadAchievements({
      aggregate: (l) => ({ knockCount: (uid) => { l.knockCount.push(uid); return Promise.resolve(742); } }),
    });
    ok('ThemeAchievements loads (positive control)', !!TA && typeof TA._gatherStats === 'function');
    const stats = await TA._gatherStats();
    ok('totalKnocks is the server count', stats.totalKnocks === 742, String(stats.totalKnocks));
    ok('knockCount was asked for the signed-in rep', log.knockCount.length === 1 && log.knockCount[0] === 'u1', JSON.stringify(log.knockCount));
    ok('getDocs never ran on knocks', knockReads(log).length === 0, String(knockReads(log).length));
  }
  {
    const { TA, log } = loadAchievements({
      aggregate: () => ({ knockCount: () => Promise.resolve(0) }),
    });
    const stats = await TA._gatherStats();
    ok('a count of 0 is used as-is (no fallback download)', stats.totalKnocks === 0 && knockReads(log).length === 0,
      stats.totalKnocks + ' / ' + knockReads(log).length);
  }
  {
    const { TA, log } = loadAchievements();
    const stats = await TA._gatherStats();
    ok('without server-aggregates.js the getDocs fallback still counts (.size)', stats.totalKnocks === 3 && knockReads(log).length === 1,
      stats.totalKnocks + ' / ' + knockReads(log).length);
    const q = knockReads(log)[0];
    ok('…with the same userId == uid predicate', !!q && q.filters.length === 1 && q.filters[0].f === 'userId' && q.filters[0].v === 'u1', JSON.stringify(q));
  }
  {
    const { TA, log } = loadAchievements({ aggregate: () => ({ __sentinel: 'nbd-server-agg-v1' }) });
    const stats = await TA._gatherStats();
    ok('an aggregate module without knockCount falls back', stats.totalKnocks === 3 && knockReads(log).length === 1, String(stats.totalKnocks));
  }
  {
    const { TA, log } = loadAchievements({ aggregate: () => ({ knockCount: () => Promise.resolve(null) }) });
    const stats = await TA._gatherStats();
    ok('knockCount answering null falls back', stats.totalKnocks === 3 && knockReads(log).length === 1, String(stats.totalKnocks));
  }
  {
    const { TA, log } = loadAchievements({ aggregate: () => ({ knockCount: () => Promise.reject(new Error('permission-denied')) }) });
    let stats = null, err = null;
    try { stats = await TA._gatherStats(); } catch (e) { err = e; }
    ok('a failed count falls back to getDocs instead of losing the number', !err && !!stats && stats.totalKnocks === 3 && knockReads(log).length === 1,
      err ? err.message : String(stats && stats.totalKnocks));
  }

  console.log('\nWIRING');
  {
    const html = read('docs/pro/dashboard.html');
    ok('the dashboard (where ThemeAchievements.init runs) loads server-aggregates.js', /<script defer src="js\/server-aggregates\.js(\?v=\d+)?"><\/script>/.test(html));
    ok('dashboard-ui.js is the page that inits ThemeAchievements (positive control)', /window\.ThemeAchievements\.init\(\)/.test(read('docs/pro/js/dashboard-ui.js')));
  }

  console.log('\n' + (failed ? 'FAILED ' + failed : 'PASSED ' + passed) + ' (' + passed + ' ok)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
