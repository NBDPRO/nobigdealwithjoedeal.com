#!/usr/bin/env node
/**
 * cron-deadman (2026-11-22, audit BOTS-AGENTS-SCHEDULES-REVIEW §2.8 / §3.8).
 *
 * Three holes this pins shut:
 *  1. softFail: callCenterIngest / callCenterTranscribe / callCenterSweep /
 *     textInboxIngest caught their main failure with logger.warn, so the run
 *     pinged SUCCESS. A caught main failure now pings /fail and is recorded
 *     ok:false; per-item catches stay best-effort.
 *  2. A shared Healthchecks check stays green while its fastest member pings.
 *     Every wrapped run now writes a per-job ledger doc, and cronDeadman
 *     judges each job on its own doc.
 *  3. Daytime alerts only (Joe): 07-21 ET at once, otherwise queued for ONE
 *     07:00 summary; call/text ingest alert at any hour; one alert per outage
 *     plus a recovery line.
 *
 * Pure Node (no network, no Firestore). Run: node tests/cron-deadman-2026-11-22.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const hb = require(path.join(FN, 'integrations', 'heartbeat.js'));
const { PLAN } = require(path.join(FN, 'integrations', 'heartbeat-plan.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const MIN = 60000, H = 3600000, DAY = 24 * H;
// November 2026 is EST (UTC-5).
const et = (ymd, hhmm) => Date.parse(ymd + 'T' + hhmm + ':00-05:00');

// Run a real handler with a few of ITS OWN requires swapped (firebase-admin,
// a lazy require inside the handler): a fresh copy of the module is loaded
// while the stubs are armed, and the cached copy is put back afterwards.
const Module = require('module');
async function withFresh(rel, stubs, fn) {
  const file = require.resolve(path.join(FN, rel));
  const saved = require.cache[file];
  delete require.cache[file];
  const realLoad = Module._load;
  Module._load = function (req, parent) {
    if (parent && parent.filename === file && Object.prototype.hasOwnProperty.call(stubs, req)) return stubs[req];
    return realLoad.apply(this, arguments);
  };
  try { return await fn(require(file)); }
  finally { Module._load = realLoad; if (saved) require.cache[file] = saved; else delete require.cache[file]; }
}
// leadAlertWatchdog's Firestore: lead collections, alert_outbox claims (create / update / where).
function watchdogDb(seed) {
  const store = JSON.parse(JSON.stringify(seed || {}), (k, v) => (k === 'createdAt' ? new Date(v) : v));
  const col = (n) => (store[n] = store[n] || {});
  const ref = (n, id) => ({
    id,
    get: async () => ({ exists: !!col(n)[id], id, data: () => col(n)[id] }),
    create: async (v) => { if (col(n)[id]) throw Object.assign(new Error('6 ALREADY_EXISTS'), { code: 6 }); col(n)[id] = Object.assign({}, v); },
    update: async (v) => { if (!col(n)[id]) throw new Error('NOT_FOUND'); Object.assign(col(n)[id], v); },
    set: async (v) => { col(n)[id] = Object.assign({}, v); },
  });
  const query = (n, fs_) => ({
    where: (f, op, v) => query(n, fs_.concat([[f, op, v]])),
    get: async () => {
      const val = (x) => (x instanceof Date ? x.getTime() : x);
      const docs = Object.keys(col(n)).filter((id) => fs_.every(([f, op, v]) => {
        const a = val(col(n)[id][f]), b = val(v);
        return op === '==' ? a === b : op === '>=' ? a != null && a >= b : op === '<=' ? a != null && a <= b : false;
      })).map((id) => ({ id, ref: ref(n, id), data: () => col(n)[id] }));
      return { docs, forEach: (f) => docs.forEach(f) };
    },
  });
  return {
    store,
    collection: (n) => Object.assign(query(n, []), { doc: (id) => ref(n, id), add: async (v) => { const id = 'a' + Object.keys(col(n)).length; col(n)[id] = v; return { id }; } }),
    doc: (p) => { const s = String(p).split('/'); return ref(s.slice(0, -1).join('/'), s[s.length - 1]); },
  };
}
const quietV2 ={ logger: { info() {}, warn() {}, error() {}, log() {} } };
const runEndpoint = (ep) => (typeof ep.run === 'function' ? ep.run : ep)({ scheduleTime: new Date().toISOString() });
// A scheduled run through the real heartbeat wrapper: what it pinged and recorded.
async function scheduled(name, ep, pings, rows) {
  hb._overrides.functionTarget = name;
  pings.length = 0; rows.length = 0;
  let threw = null;
  try { await runEndpoint(ep); } catch (e) { threw = e; }
  return { threw, ping: pings[pings.length - 1] || '', row: rows[rows.length - 1] || null };
}
// Drive stand-in: `answer(q)` returns the files for a list query, or throws.
const driveClient = (answer) => ({ request: async (o) => ({ data: { files: answer(String((o.params || {}).q || '')) } }) });
const driveError = (code) => () => { throw Object.assign(new Error('drive ' + code), { code }); };
// The two ingest jobs' Firestore: the config doc, plus the tenant-feed query.
function ingestDb(docs, opts) {
  const o = opts || {};
  const reads = [];
  return {
    reads,
    doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p] }), set: async (v) => { docs[p] = Object.assign({}, docs[p], v); } }),
    collection: (c) => ({ where: () => ({ get: async () => { reads.push(c); if (o.tenantThrows) throw new Error('tenant read failed'); return { docs: [], forEach() {} }; } }) }),
  };
}

(async () => {
  // Capture pings and ledger rows; never touch the network or Firestore.
  const pings = [];
  const rows = [];
  hb._overrides.pingKey = 'KEY';
  hb._overrides.fetchImpl = async (url) => { pings.push(url); return { ok: true, status: 200 }; };
  hb._overrides.recordRun = async (row) => { rows.push(row); };

  console.log('A. softFail: a caught MAIN failure is a failed run');
  {
    ok('heartbeat.js exports softFail', typeof hb.softFail === 'function');
    hb._overrides.functionTarget = 'callCenterTranscribe';
    pings.length = 0; rows.length = 0;
    let threw = null;
    try {
      await hb.withHeartbeat(null, async () => {
        try { throw new Error('drive down'); } catch (e) { hb.softFail(e); }
        return 'finished';
      })({});
    } catch (e) { threw = e; }
    ok('the run still returns normally (no rethrow, Scheduler retries unchanged)', threw === null, threw && threw.message);
    ok('…but pings <slug>/fail, not success', pings.length === 1 && pings[0].endsWith('/calls-texts-ingest/fail'), pings.join());
    ok('…and the ledger records ok:false with the error', rows.length === 1 && rows[0].job === 'callCenterTranscribe' && rows[0].ok === false && /drive down/.test(rows[0].error || ''), JSON.stringify(rows));

    pings.length = 0; rows.length = 0;
    await hb.withHeartbeat(null, async () => {
      const e = Object.assign(new Error('not shared yet'), { code: 403 });
      try { throw e; } catch (err) { hb.softFail(err, { expected: [403, 404] }); }
    })({});
    ok('an EXPECTED code (403 before the folder is shared, gate off) still pings success', pings.length === 1 && pings[0].endsWith('/calls-texts-ingest') && rows[0].ok === true, pings.join() + ' ' + JSON.stringify(rows));
    pings.length = 0; rows.length = 0;
    await hb.withHeartbeat(null, async () => {
      const e = Object.assign(new Error('gaxios'), { response: { status: 404 } });
      hb.softFail(e, { expected: [403, 404] });
    })({});
    ok('…the code is also read from err.response.status', pings[0].endsWith('/calls-texts-ingest') && rows[0].ok === true);

    pings.length = 0; rows.length = 0;
    await hb.withHeartbeat(null, async () => {
      try { throw new Error('one lead failed'); } catch (_) { /* per-item best effort, plain warn */ }
      return 1;
    })({});
    ok('a per-item catch that does NOT call softFail stays best-effort (success)', pings[0].endsWith('/calls-texts-ingest') && rows[0].ok === true);
    let outside = null;
    try { outside = hb.softFail(new Error('no run')); } catch (e) { outside = e; }
    ok('softFail outside a wrapped run is harmless', !(outside instanceof Error));
  }

  console.log('B. the four real call sites (behaviour, no Firebase app → the main pass throws inside its try)');
  {
    const CC = require(path.join(FN, 'call-center.js'));
    const TI = require(path.join(FN, 'text-inbox.js'));
    const runEp = async (ep) => { const r = typeof ep.run === 'function' ? ep.run : ep; return r({ scheduleTime: new Date().toISOString() }); };
    for (const [name, ep] of [['textInboxIngest', TI.textInboxIngest], ['callCenterTranscribe', CC.callCenterTranscribe], ['callCenterSweep', CC.callCenterSweep]]) {
      hb._overrides.functionTarget = name;
      pings.length = 0; rows.length = 0;
      let threw = null;
      try { await runEp(ep); } catch (e) { threw = e; }
      const slug = PLAN[name].slug;
      ok(name + ': a failed main pass pings ' + slug + '/fail (was: success)', !threw && pings.length === 1 && pings[0].endsWith('/' + slug + '/fail'), (threw && threw.message) + ' ' + pings.join());
      ok(name + ': ledger ok:false', rows.length === 1 && rows[0].ok === false, JSON.stringify(rows));
    }
  }

  console.log('B2. the two ingest handlers, run with a stubbed Drive + Firestore (gate on = live)');
  {
    const envKeys = ['CALL_CENTER_INGEST_ENABLED', 'CALL_CENTER_MULTI_TENANT_ENABLED', 'TEXT_INBOX_ENABLED'];
    const envWas = envKeys.map((k) => process.env[k]);
    const setLive = (k, on) => { if (on) process.env[k] = 'true'; else delete process.env[k]; };
    const FA = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));

    // callCenterIngest: getFirestore() runs before its try, so it needs a stand-in app.
    let ccDb = null;
    await withFresh('call-center.js', {
      'firebase-admin/firestore': Object.assign({}, FA, { getFirestore: () => ccDb }),
      'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({}) }) },
      'firebase-functions/v2': quietV2,
    }, async (CCf) => {
      const run = async (live, answer, docs, opts) => {
        setLive('CALL_CENTER_INGEST_ENABLED', live);
        ccDb = ingestDb(docs || {}, opts);
        CCf._test.setClient(driveClient(answer));
        return scheduled('callCenterIngest', CCf.callCenterIngest, pings, rows);
      };
      let r = await run(true, driveError(403));
      ok('callCenterIngest live: Drive 403 fails the run (/fail, ledger ok:false)', !r.threw && r.ping.endsWith('/fail') && r.row && r.row.ok === false && /403/.test(r.row.error || ''), r.ping + ' ' + JSON.stringify(r.row));
      r = await run(false, driveError(403));
      ok('callCenterIngest dry run: Drive 403 (folder not shared yet) is the idle state (success)', !r.threw && !r.ping.endsWith('/fail') && r.row && r.row.ok === true, r.ping + ' ' + JSON.stringify(r.row));
      r = await run(false, driveError(404));
      ok('…404 too', r.row && r.row.ok === true);
      r = await run(false, driveError(500));
      ok('callCenterIngest dry run: any other Drive error still fails the run', r.ping.endsWith('/fail') && r.row && r.row.ok === false, JSON.stringify(r.row));
      r = await run(true, () => []);
      ok('callCenterIngest live: no "Cube ACR" folder (returns normally) fails the run', r.ping.endsWith('/fail') && r.row && r.row.ok === false && /not_shared/.test(r.row.error || ''), JSON.stringify(r.row));
      r = await run(true, () => [{ id: 'a' }, { id: 'b' }]);
      ok('callCenterIngest live: two "Cube ACR" folders fails the run', r.row && r.row.ok === false && /ambiguous_folder/.test(r.row.error || ''), JSON.stringify(r.row));
      r = await run(false, () => []);
      ok('callCenterIngest dry run: no folder is idle (success)', r.row && r.row.ok === true, JSON.stringify(r.row));
      process.env.CALL_CENTER_MULTI_TENANT_ENABLED = 'true';
      r = await run(true, driveError(500), { 'integrations/callCenter': { paused: true } }, { tenantThrows: true });
      ok('callCenterIngest: a tenant pass that throws stays best-effort (NBD pass fine → success)', !r.threw && r.row && r.row.ok === true && ccDb.reads.includes('integrations'), JSON.stringify(r.row) + ' reads=' + ccDb.reads.join());
      delete process.env.CALL_CENTER_MULTI_TENANT_ENABLED;
    });

    let tiDb = null;
    await withFresh('text-inbox.js', {
      'firebase-admin/firestore': Object.assign({}, FA, { getFirestore: () => tiDb }),
      'firebase-functions/v2': quietV2,
    }, async (TIf) => {
      const run = async (live, answer, docs) => {
        setLive('TEXT_INBOX_ENABLED', live);
        tiDb = ingestDb(docs || {});
        TIf._test.setClient(driveClient(answer));
        return scheduled('textInboxIngest', TIf.textInboxIngest, pings, rows);
      };
      let r = await run(true, driveError(403));
      ok('textInboxIngest live: Drive 403 fails the run', !r.threw && r.ping.endsWith('/fail') && r.row && r.row.ok === false, r.ping + ' ' + JSON.stringify(r.row));
      r = await run(false, driveError(403));
      ok('textInboxIngest dry run: Drive 403 is the idle state (success)', r.row && r.row.ok === true && !r.ping.endsWith('/fail'), JSON.stringify(r.row));
      r = await run(false, driveError(500));
      ok('textInboxIngest dry run: any other Drive error still fails the run', r.row && r.row.ok === false, JSON.stringify(r.row));
      const backup = (modifiedTime, size) => (q) => (/^name = /.test(q) ? [{ id: 'F1', name: 'SMSBackupRestore' }] : [{ id: 'b1', name: 'sms-20261120120000.xml', size: String(size || 1000), modifiedTime }]);
      const mt = new Date(Date.now() - H).toISOString();
      r = await run(true, backup(mt, 300 * 1024 * 1024));
      ok('textInboxIngest live: a backup over the size cap (returns too_large) fails the run', r.row && r.row.ok === false && /too_large/.test(r.row.error || ''), JSON.stringify(r.row));
      r = await run(false, backup(mt, 300 * 1024 * 1024));
      ok('…dry run: too_large is idle (success)', r.row && r.row.ok === true, JSON.stringify(r.row));
      const stale = new Date(Date.now() - 3 * DAY).toISOString();
      r = await run(true, backup(stale), { 'integrations/textInbox': { folderId: 'F1', lastFileId: 'b1', lastFileModified: stale } });
      ok('textInboxIngest live: the same backup for 3 days (the phone app stopped) fails the run', r.row && r.row.ok === false && /h old/.test(r.row.error || ''), JSON.stringify(r.row));
      r = await run(true, backup(mt), { 'integrations/textInbox': { folderId: 'F1', lastFileId: 'b1', lastFileModified: mt } });
      ok('…the same backup 1 h old is fine (success)', r.row && r.row.ok === true, JSON.stringify(r.row));
    });
    envKeys.forEach((k, i) => { if (envWas[i] === undefined) delete process.env[k]; else process.env[k] = envWas[i]; });
  }

  console.log('C. the ledger: one doc per job, with its own cadence');
  {
    rows.length = 0;
    hb._overrides.functionTarget = 'callCenterIngest';
    const ep = hb.onSchedule({ schedule: 'every 30 minutes', timeZone: 'America/New_York' }, async () => 'ran');
    await (typeof ep.run === 'function' ? ep.run : ep)({});
    ok('the wrapper records {job, schedule, timeZone, startedAtMs, finishedAtMs, ok}', rows.length === 1 && rows[0].job === 'callCenterIngest' && rows[0].schedule === 'every 30 minutes' && rows[0].timeZone === 'America/New_York' && rows[0].ok === true && rows[0].finishedAtMs >= rows[0].startedAtMs, JSON.stringify(rows));
    rows.length = 0;
    let threw = null;
    try { await hb.withHeartbeat(null, async () => { throw new Error('boom'); })({}); } catch (e) { threw = e; }
    ok('a throw is recorded ok:false and still rethrown', threw && rows[0].ok === false && rows[0].error === 'boom');
    hb._overrides.recordRun = async () => { throw new Error('firestore down'); };
    const r = await hb.withHeartbeat(null, async () => 'still ran')({});
    ok('a ledger write failure never fails the cron', r === 'still ran');
    hb._overrides.recordRun = undefined;
    const t0 = Date.now();
    const r2 = await hb.withHeartbeat(null, async () => 'no app')({});
    ok('the real writer is a quick no-op when no Firebase app exists (unit tests stay offline)', r2 === 'no app' && Date.now() - t0 < 2000);
    hb._overrides.recordRun = async (row) => { rows.push(row); };
    ok('the ledger path is system/heartbeats/cron_runs/<export name>', hb.LEDGER_COLLECTION === 'system/heartbeats/cron_runs');
    // Review fix: a subcollection named `jobs` fell into the recursive
    // `match /{path=**}/jobs/{jobId}` read grant (platform admins could read
    // every cron's error text) and into every collectionGroup('jobs') query.
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    const recursive = [...rules.matchAll(/match\s+\/\{path=\*\*\}\/([A-Za-z0-9_]+)\//g)].map((m) => m[1]);
    const ledgerColl = hb.LEDGER_COLLECTION.split('/').pop();
    ok('no recursive {path=**} rule matches the ledger collection id (so default deny holds)', recursive.length > 0 && !recursive.includes(ledgerColl), ledgerColl + ' vs ' + recursive.join());
    ok('no explicit rule opens system/heartbeats/…', !/match\s+\/system\/heartbeats/.test(rules) && /match \/system\/\{docId\} \{\s*allow read, write: if false;/.test(rules));
    let collGroupJobs = [];
    const walkCg = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walkCg(p); else if (p.endsWith('.js') && new RegExp("collectionGroup\\(\\s*'" + ledgerColl + "'").test(fs.readFileSync(p, 'utf8'))) collGroupJobs.push(p); } };
    walkCg(FN); walkCg(path.join(ROOT, 'scripts'));
    ok('no collectionGroup query in functions/ or scripts/ uses the ledger collection id', collGroupJobs.length === 0, collGroupJobs.join());
  }

  const D = require(path.join(FN, 'cron-deadman.js'))._test;

  console.log('D. cadence from the schedule string');
  {
    ok('every 10 minutes → 10 min', D.cadenceMs('every 10 minutes') === 10 * MIN);
    ok('every 1 minutes → 1 min', D.cadenceMs('every 1 minutes') === MIN);
    ok('every 60 minutes → 1 h', D.cadenceMs('every 60 minutes') === H);
    ok('every day 03:30 → 24 h', D.cadenceMs('every day 03:30') === DAY);
    ok('15 7,15 * * * → 16 h (the longest gap)', D.cadenceMs('15 7,15 * * *') === 16 * H, String(D.cadenceMs('15 7,15 * * *') / H));
    ok('0 8-20/2 * * * → 12 h', D.cadenceMs('0 8-20/2 * * *') === 12 * H);
    ok('0 */3 * * * → 3 h', D.cadenceMs('0 */3 * * *') === 3 * H);
    ok('5 * * * * → 1 h', D.cadenceMs('5 * * * *') === H);
    ok('0 7 * * MON → 7 d', D.cadenceMs('0 7 * * MON') === 7 * DAY);
    ok('30 4 * * 0 → 7 d', D.cadenceMs('30 4 * * 0') === 7 * DAY);
    ok('0 7 1 * * → 31 d', D.cadenceMs('0 7 1 * *') === 31 * DAY, String(D.cadenceMs('0 7 1 * *') / DAY));
    ok('garbage → null (never a made-up cadence)', D.cadenceMs('whenever') === null && D.cadenceMs('') === null);
    ok('Healthchecks periods parse too (1 week / cron …)', D.periodMs('1 week') === 7 * DAY && D.periodMs('cron 0 7 1 * * (America/New_York)') === 31 * DAY && D.periodMs('1 minute') === MIN);
    ok('every schedule string in functions/ parses', (() => {
      const bad = [];
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) for (const m of fs.readFileSync(p, 'utf8').matchAll(/schedule:\s*'([^']+)'/g)) if (D.cadenceMs(m[1]) == null) bad.push(m[1]); } };
      walk(FN); return bad.length === 0 || (console.log('    unparsed: ' + bad.join(' | ')), false);
    })());
  }

  console.log('E. per job: a dead job is caught while its Healthchecks group stays green');
  {
    ok('callCenterTranscribe and leadAlertWatchdog share one check', PLAN.callCenterTranscribe.slug === PLAN.leadAlertWatchdog.slug);
    // The old view: the shared check's LAST ping decides its colour.
    pings.length = 0;
    hb._overrides.functionTarget = 'callCenterTranscribe';
    await hb.withHeartbeat(null, async () => { hb.softFail(new Error('groq down')); })({});
    hb._overrides.functionTarget = 'leadAlertWatchdog';
    await hb.withHeartbeat(null, async () => 1)({});
    ok('(the shared check: the watchdog\'s success ping lands last, so it reads green)', pings[pings.length - 1].endsWith('/calls-texts-ingest'));
    const now = et('2026-11-23', '10:00');
    const jobs = {
      leadAlertWatchdog: { schedule: 'every 10 minutes', ok: true, lastOkAtMs: now - 5 * MIN, finishedAtMs: now - 5 * MIN },
      callCenterTranscribe: { schedule: 'every 30 minutes', ok: false, error: 'groq down', lastOkAtMs: now - 3 * H, finishedAtMs: now - 10 * MIN },
    };
    const p = D.judgeJobs({ jobs, expected: ['leadAlertWatchdog', 'callCenterTranscribe'], startedAtMs: now - 30 * DAY, now });
    ok('the ledger flags exactly the dead job', Object.keys(p).join() === 'callCenterTranscribe', JSON.stringify(p));
    ok('…saying why (last run failed + the error)', /last run failed: groq down/.test(p.callCenterTranscribe.reason), p.callCenterTranscribe && p.callCenterTranscribe.reason);
    const silent = D.judgeJobs({ jobs: { callCenterTranscribe: { schedule: 'every 30 minutes', ok: true, lastOkAtMs: now - 2 * H, finishedAtMs: now - 2 * H } }, expected: ['callCenterTranscribe'], startedAtMs: now - 30 * DAY, now });
    ok('a job that just stopped (no failing run) is "no run since"', /no run since/.test((silent.callCenterTranscribe || {}).reason || ''), JSON.stringify(silent));
    const fresh = D.judgeJobs({ jobs: { callCenterTranscribe: { schedule: 'every 30 minutes', ok: true, lastOkAtMs: now - 55 * MIN } }, expected: ['callCenterTranscribe'], startedAtMs: now - 30 * DAY, now });
    ok('slack: one missed 30-min run (55 min) is not an outage yet', Object.keys(fresh).length === 0);
    const retired = D.judgeJobs({ jobs: { oldRetiredCron: { schedule: 'every 5 minutes', ok: true, lastOkAtMs: now - 30 * DAY } }, expected: [], startedAtMs: now - 30 * DAY, now });
    ok('a ledger doc for a cron no longer deployed is ignored', Object.keys(retired).length === 0);
    const self = D.judgeJobs({ jobs: { cronDeadman: { schedule: 'every 30 minutes', ok: false, lastOkAtMs: now - DAY } }, expected: ['cronDeadman'], startedAtMs: now - 30 * DAY, now });
    ok('the dead-man never judges itself (pipeline-deadman watches it)', Object.keys(self).length === 0);
  }

  console.log('F. never-seen jobs get a grace period from the dead-man\'s first run');
  {
    const now = et('2026-11-23', '10:00');
    const a = D.judgeJobs({ jobs: {}, expected: ['emailQueueWorker', 'monthlyMarketingReport'], startedAtMs: now - 10 * MIN, now });
    ok('10 min after the first deploy: nothing (no wall of alerts)', Object.keys(a).length === 0, JSON.stringify(a));
    const b = D.judgeJobs({ jobs: {}, expected: ['emailQueueWorker', 'monthlyMarketingReport'], startedAtMs: now - 40 * MIN, now });
    ok('40 min later the 1-minute email worker with no run at all is flagged; the monthly job is not', Object.keys(b).join() === 'emailQueueWorker', JSON.stringify(b));
  }

  // ── The runner, against an in-memory Firestore ──
  function fakeDb(jobs) {
    const docs = {};
    const added = [];
    return {
      docs, jobs, added,
      doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p] }), set: async (v) => { docs[p] = JSON.parse(JSON.stringify(v)); } }),
      collection: (c) => ({ add: async (v) => { added.push([c, v]); return { id: 'n' + added.length }; }, get: async () => { if (c !== hb.LEDGER_COLLECTION) throw new Error('wrong collection ' + c); const ds = Object.keys(jobs).map((id) => ({ id, data: () => jobs[id] })); return { docs: ds, forEach: (f) => ds.forEach(f) }; } }),
    };
  }
  const expected = ['leadAlertWatchdog', 'callCenterTranscribe', 'callCenterIngest'];
  const healthy = (now) => ({
    leadAlertWatchdog: { schedule: 'every 10 minutes', ok: true, lastOkAtMs: now - 2 * MIN },
    callCenterTranscribe: { schedule: 'every 30 minutes', ok: true, lastOkAtMs: now - 10 * MIN },
    callCenterIngest: { schedule: 'every 30 minutes', ok: true, lastOkAtMs: now - 10 * MIN },
  });
  const R = require(path.join(FN, 'cron-deadman.js'));
  async function tick(db, now, sent, over) {
    Object.assign(db.jobs, healthy(now), over || {});
    return R.run({ db, nowMs: now, live: true, expected, send: async (t, b) => { sent.push({ t, b, now }); } });
  }
  const deadTranscribe = (now) => ({ callCenterTranscribe: { schedule: 'every 30 minutes', ok: false, error: 'groq down', lastOkAtMs: et('2026-11-23', '00:30'), finishedAtMs: now - MIN } });
  const deadIngest = (now) => ({ callCenterIngest: { schedule: 'every 30 minutes', ok: false, error: 'Drive 403', lastOkAtMs: et('2026-11-23', '00:30'), finishedAtMs: now - MIN } });

  console.log('G. quiet hours: queued at night, ONE summary at 07:00');
  {
    const db = fakeDb({}); const sent = [];
    db.docs['system/heartbeats'] = { startedAtMs: et('2026-11-01', '00:00') };
    let r = await tick(db, et('2026-11-23', '02:00'), sent, deadTranscribe(et('2026-11-23', '02:00')));
    ok('02:00 ET non-critical outage: detected, nothing sent', r.problems.join() === 'callCenterTranscribe' && sent.length === 0, JSON.stringify(r));
    ok('…queued for the morning', (db.docs['system/heartbeats'].queue || []).length === 1);
    ok('…and the run does not fail (no 2 a.m. Healthchecks email)', r.downSent === 0);
    r = await tick(db, et('2026-11-23', '02:30'), sent, deadTranscribe(et('2026-11-23', '02:30')));
    ok('02:30: still nothing sent, still one queued line', sent.length === 0 && db.docs['system/heartbeats'].queue.length === 1);
    r = await tick(db, et('2026-11-23', '07:00'), sent, deadTranscribe(et('2026-11-23', '07:00')));
    ok('07:00: exactly one summary goes out', sent.length === 1 && /callCenterTranscribe/.test(sent[0].b) && /overnight/i.test(sent[0].t), JSON.stringify(sent));
    ok('…the queue is cleared', db.docs['system/heartbeats'].queue.length === 0);
    r = await tick(db, et('2026-11-23', '07:30'), sent, deadTranscribe(et('2026-11-23', '07:30')));
    ok('07:30, still down: nothing more (told once)', sent.length === 1);
    r = await tick(db, et('2026-11-23', '09:00'), sent);
    ok('09:00 recovered: one recovery line, at once', sent.length === 2 && /recovered/i.test(sent[1].b), JSON.stringify(sent[1]));
    ok('…a recovery alone does not fail the run', r.downSent === 0);
    r = await tick(db, et('2026-11-23', '09:30'), sent);
    ok('09:30: quiet', sent.length === 2);
  }

  console.log('H. overnight blip: down and back before morning → one summary line');
  {
    const db = fakeDb({}); const sent = [];
    db.docs['system/heartbeats'] = { startedAtMs: et('2026-11-01', '00:00') };
    await tick(db, et('2026-11-23', '02:00'), sent, deadTranscribe(et('2026-11-23', '02:00')));
    ok('(02:00: it is down and queued)', (db.docs['system/heartbeats'].queue || []).length === 1);
    await tick(db, et('2026-11-23', '03:30'), sent);
    ok('nothing sent overnight', sent.length === 0);
    const q = db.docs['system/heartbeats'].queue;
    ok('one queued line that says it recovered', q.length === 1 && /recovered/i.test(q[0].text), JSON.stringify(q));
    await tick(db, et('2026-11-23', '07:00'), sent);
    ok('07:00: the summary carries it', sent.length === 1 && /callCenterTranscribe/.test(sent[0].b) && /recovered/i.test(sent[0].b));
  }

  console.log('I. the call/text pipeline alerts at any hour');
  {
    const db = fakeDb({}); const sent = [];
    db.docs['system/heartbeats'] = { startedAtMs: et('2026-11-01', '00:00') };
    let r = await tick(db, et('2026-11-23', '02:00'), sent, deadIngest(et('2026-11-23', '02:00')));
    ok('02:00 ET callCenterIngest dead: sent at once', sent.length === 1 && /callCenterIngest/.test(sent[0].b), JSON.stringify(sent));
    ok('…and the run fails so Healthchecks emails too', r.downSent === 1);
    r = await tick(db, et('2026-11-23', '02:30'), sent, deadIngest(et('2026-11-23', '02:30')));
    ok('02:30: not again', sent.length === 1 && r.downSent === 0);
    r = await tick(db, et('2026-11-23', '03:00'), sent);
    ok('03:00 recovered: the recovery goes at once too', sent.length === 2 && /recovered/i.test(sent[1].b));
    ok('the critical set is exactly call + text ingest', [...R._test.CRITICAL].sort().join() === 'callCenterIngest,textInboxIngest');
  }

  console.log('J. daytime: once per outage, then a recovery line');
  {
    const db = fakeDb({}); const sent = [];
    db.docs['system/heartbeats'] = { startedAtMs: et('2026-11-01', '00:00') };
    const dead = (now) => ({ callCenterTranscribe: { schedule: 'every 30 minutes', ok: true, lastOkAtMs: et('2026-11-23', '08:00'), finishedAtMs: et('2026-11-23', '08:00') } });
    let r = await tick(db, et('2026-11-23', '10:00'), sent, dead());
    ok('10:00: told at once', sent.length === 1 && /no run since/.test(sent[0].b) && r.downSent === 1);
    await tick(db, et('2026-11-23', '10:30'), sent, dead());
    await tick(db, et('2026-11-23', '11:00'), sent, dead());
    ok('10:30, 11:00: deduped', sent.length === 1);
    await tick(db, et('2026-11-23', '11:30'), sent);
    ok('11:30: one recovery line', sent.length === 2 && /recovered/i.test(sent[1].b));
  }

  console.log('K. a failed send is retried, never marked told');
  {
    const db = fakeDb({}); const sent = [];
    db.docs['system/heartbeats'] = { startedAtMs: et('2026-11-01', '00:00') };
    Object.assign(db.jobs, healthy(et('2026-11-23', '10:00')), deadIngest(et('2026-11-23', '10:00')));
    const r = await R.run({ db, nowMs: et('2026-11-23', '10:00'), live: true, expected, send: async () => { throw new Error('push down'); } });
    ok('the send error is reported (the handler throws on it)', /push down/.test(r.sendError || ''), JSON.stringify(r));
    await tick(db, et('2026-11-23', '10:30'), sent, deadIngest(et('2026-11-23', '10:30')));
    ok('the next run sends it', sent.length === 1 && /callCenterIngest/.test(sent[0].b));
  }

  console.log('L. dry run and first run');
  {
    const db = fakeDb({}); const sent = [];
    Object.assign(db.jobs, healthy(et('2026-11-23', '10:00')), deadIngest(et('2026-11-23', '10:00')));
    const r = await R.run({ db, nowMs: et('2026-11-23', '10:00'), live: false, expected, send: async (t, b) => { sent.push(b); } });
    ok('dry run: computes, sends nothing', r.problems.join() === 'callCenterIngest' && sent.length === 0 && /dry_run/.test(r.state), JSON.stringify(r));
    ok('…but stamps startedAtMs + checkedAtMs (so the watcher of the dead-man sees it ran)', db.docs['system/heartbeats'].startedAtMs === et('2026-11-23', '10:00') && db.docs['system/heartbeats'].checkedAtMs === et('2026-11-23', '10:00'));
  }

  console.log('M. registration');
  {
    // functions/index.js exporting it and FUNCTIONS_INDEX.md naming it are
    // enforced for EVERY export by merge-leftovers-guard-2026-10-05 (function-map
    // == the loaded index.js exports; every deployed export is in the catalog)
    // and functions-lazy-load-2026-10-04 (each map entry, by object identity).
    ok('cronDeadman is in the heartbeat plan', !!PLAN.cronDeadman && !!PLAN.cronDeadman.slug);
    const map = JSON.parse(fs.readFileSync(path.join(FN, 'function-map.json'), 'utf8'));
    ok('function-map.json maps cronDeadman', map.cronDeadman === './cron-deadman');
    const ep = R.cronDeadman.__endpoint;
    ok('every 30 minutes, America/New_York, one instance', ep.scheduleTrigger.schedule === 'every 30 minutes' && ep.scheduleTrigger.timeZone === 'America/New_York' && ep.maxInstances === 1);
  }

  // ── Review fixes (2026-11-22) ──

  console.log('N. text/call ingest: a live terminal state that returns normally is still a failed run');
  {
    const TI = require(path.join(FN, 'text-inbox.js'));
    const P = TI._test.ingestProblem;
    const now = et('2026-11-23', '02:00');
    ok('text-inbox exports ingestProblem', typeof P === 'function');
    for (const st of ['not_shared', 'ambiguous_folder', 'no_backup', 'too_large']) {
      ok('live ' + st + ' → a problem', typeof P && !!P({ state: st }, true, now));
      ok('dry run ' + st + ' → idle, not a problem', typeof P && !P({ state: st }, false, now));
    }
    ok('live unchanged, backup 2 h old → fine (hourly backups)', !P({ state: 'unchanged', newestModifiedMs: now - 2 * H }, true, now));
    ok('live unchanged, newest backup 3 days old → a problem (the backup app stopped)', !!P({ state: 'unchanged', newestModifiedMs: now - 3 * DAY }, true, now));
    ok('ingested / paused → fine', !P({ state: 'ingested' }, true, now) && !P({ state: 'paused' }, true, now));
    // Behaviour through the wrapper: a too_large return now records ok:false.
    hb._overrides.functionTarget = 'textInboxIngest';
    pings.length = 0; rows.length = 0;
    await hb.withHeartbeat(null, async () => { const r = { state: 'too_large' }; const why = P(r, true, now); if (why) hb.softFail(new Error(why)); })({});
    ok('a live too_large pass pings /fail and records ok:false', pings.length === 1 && pings[0].endsWith('/fail') && rows[0].ok === false && /too_large/.test(rows[0].error), pings.join() + JSON.stringify(rows));
    // The real handlers (too_large, a 3-day-old unchanged backup, a missing or
    // doubled Cube ACR folder) are run end to end in B2.
  }

  console.log('O. many jobs down at once: every job is named in what is sent');
  {
    const db = fakeDb({}); const sent = [];
    db.docs['system/heartbeats'] = { startedAtMs: et('2026-11-01', '00:00') };
    const names = ['emailQueueWorker', 'migrationsTick', 'stormPoller', 'socialPublisher', 'runAbandonRecovery', 'textInboxNotes', 'messagingWatch', 'docLinkFollowupSweep', 'leaderboardAggregate', 'awayModeTick'];
    const err = '13 UNAVAILABLE: No connection established. Last error: connect ECONNREFUSED 142.250.0.1:443 (Firestore backend unavailable, retry later)';
    const many = {};
    for (const n of names) many[n] = { schedule: 'every 30 minutes', ok: false, error: err, lastOkAtMs: et('2026-11-23', '00:30'), finishedAtMs: et('2026-11-23', '02:00') };
    const exp = expected.concat(names);
    const tickM = (now) => { Object.assign(db.jobs, healthy(now), many); return R.run({ db, nowMs: now, live: true, expected: exp, send: async (t, b) => { sent.push({ t, b }); } }); };
    await tickM(et('2026-11-23', '02:00'));
    await tickM(et('2026-11-23', '07:00'));
    ok('one 07:00 summary', sent.length === 1, String(sent.length));
    const b = (sent[0] || {}).b || '';
    ok('…that names all 10 jobs', names.every((n) => b.includes(n)), names.filter((n) => !b.includes(n)).join());
    ok('…and the first line (what a push shows) lists them by name', names.slice(0, 6).every((n) => b.split('\n')[0].includes(n)), b.split('\n')[0]);
  }

  console.log('P. an outage still open the next day is mentioned again');
  {
    const db = fakeDb({}); const sent = [];
    db.docs['system/heartbeats'] = { startedAtMs: et('2026-11-01', '00:00') };
    const dead = () => ({ callCenterTranscribe: { schedule: 'every 30 minutes', ok: false, error: 'groq down', lastOkAtMs: et('2026-11-23', '08:00'), finishedAtMs: et('2026-11-23', '09:59') } });
    await tick(db, et('2026-11-23', '10:00'), sent, dead());
    ok('(10:00 Monday: told once)', sent.length === 1);
    await tick(db, et('2026-11-23', '15:00'), sent, dead());
    await tick(db, et('2026-11-24', '02:00'), sent, dead());
    ok('same day and overnight: not repeated', sent.length === 1);
    const r = await tick(db, et('2026-11-24', '07:00'), sent, dead());
    ok('07:00 Tuesday: "still down" reminder', sent.length === 2 && /callCenterTranscribe/.test(sent[1].b) && /still down/i.test(sent[1].b), JSON.stringify(sent[1]));
    ok('…and the run fails again (Healthchecks stays honest)', r.downSent === 1);
    await tick(db, et('2026-11-24', '07:30'), sent, dead());
    ok('…once per day', sent.length === 2);
  }

  console.log('Q. a job that stops being watched is not "recovered"');
  {
    const db = fakeDb({}); const sent = [];
    db.docs['system/heartbeats'] = { startedAtMs: et('2026-11-01', '00:00') };
    await tick(db, et('2026-11-23', '10:00'), sent, deadTranscribe(et('2026-11-23', '10:00')));
    ok('(told)', sent.length === 1);
    Object.assign(db.jobs, healthy(et('2026-11-23', '10:30')), deadTranscribe(et('2026-11-23', '10:30')));
    await R.run({ db, nowMs: et('2026-11-23', '10:30'), live: true, expected: ['leadAlertWatchdog', 'callCenterIngest'], send: async (t, b) => { sent.push({ t, b }); } });
    ok('dropped from the watch list: no false recovery line', sent.length === 1, JSON.stringify(sent[1] || null));
    ok('…and its outage state is cleared', !(db.docs['system/heartbeats'].open || {}).callCenterTranscribe);
  }

  console.log('R. windowed crons are judged from their next expected fire');
  {
    // promiseSweep-like '15 7,15 * * *': ok at 07:16 Monday, then dead.
    const doc = { schedule: '15 7,15 * * *', timeZone: 'America/New_York', ok: false, error: 'boom', lastOkAtMs: et('2026-11-23', '07:16'), finishedAtMs: et('2026-11-23', '15:16') };
    const at = (hhmm, ymd) => D.judgeJobs({ jobs: { callCenterSweep: doc }, expected: ['callCenterSweep'], startedAtMs: et('2026-11-01', '00:00'), now: et(ymd || '2026-11-23', hhmm) });
    ok('15:00 Monday (before the 15:15 fire): fine', Object.keys(at('15:00')).length === 0);
    ok('16:30 Monday: flagged the same day (was: 05:15 Tuesday)', !!at('16:30').callCenterSweep, JSON.stringify(at('16:30')));
    const watch = { schedule: '0 8-20/2 * * *', timeZone: 'America/New_York', ok: true, lastOkAtMs: et('2026-11-23', '20:01'), finishedAtMs: et('2026-11-23', '20:01') };
    const w = (ymd, hhmm) => D.judgeJobs({ jobs: { callWatch: watch }, expected: ['callWatch'], startedAtMs: et('2026-11-01', '00:00'), now: et(ymd, hhmm) });
    ok('callWatch last ran 20:00: the quiet night is not an outage (07:59 Tue fine)', Object.keys(w('2026-11-24', '07:59')).length === 0);
    ok('…but missing the 08:00 run is flagged by 09:00', !!w('2026-11-24', '09:01').callWatch);
    const daily = { schedule: 'every day 03:30', timeZone: 'America/New_York', ok: true, lastOkAtMs: et('2026-11-23', '03:31') };
    const dj = (ymd, hhmm) => D.judgeJobs({ jobs: { firestoreBackupRetention: daily }, expected: ['firestoreBackupRetention'], startedAtMs: et('2026-11-01', '00:00'), now: et(ymd, hhmm) });
    ok('every day 03:30: fine at 04:00 next day, flagged by 05:00', Object.keys(dj('2026-11-24', '04:00')).length === 0 && !!dj('2026-11-24', '05:00').firestoreBackupRetention);
  }

  console.log('S. a watcher report on leadAlertWatchdog is not a failed watchdog');
  {
    ok('heartbeat.js exports mainWorkRan', typeof hb.mainWorkRan === 'function');
    hb._overrides.functionTarget = 'leadAlertWatchdog';
    pings.length = 0; rows.length = 0;
    let threw = null;
    try { await hb.withHeartbeat(null, async () => { hb.mainWorkRan(); throw new Error('pipelineDeadMan: ai_provider_outage'); })({}); } catch (e) { threw = e; }
    ok('the throw still pings /fail (Healthchecks email path unchanged)', threw && pings.length === 1 && pings[0].endsWith('/fail'));
    ok('…but the ledger records ok:true, so cronDeadman sends no second alert', rows.length === 1 && rows[0].ok === true, JSON.stringify(rows));
    // The real leadAlertWatchdog handler: pipeline-deadman reports a problem.
    const FA = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));
    const LAreal = require(path.join(FN, 'lead-alert.js'))._internal;
    let wdDb = null, dmProblems = [];
    let alertJoe = async () => ({ email: 'sent' });
    await withFresh('lead-alert-watchdog.js', {
      'firebase-admin/firestore': { getFirestore: () => wdDb, FieldValue: { serverTimestamp: () => '__ts__' } },
      'firebase-functions/v2': quietV2,
      './lead-alert': { _internal: Object.assign({}, LAreal, { alertJoe: (...a) => alertJoe(...a) }) },
      './pipeline-deadman': { run: async () => ({ problems: dmProblems.slice() }) },
      './pipeline-canary': { run: async () => ({}) },
    }, async (WDf) => {
      const wdRun = async (problems, leads, alert) => {
        dmProblems = problems; alertJoe = alert || (async () => ({ email: 'sent' }));
        wdDb = watchdogDb(leads);
        return scheduled('leadAlertWatchdog', WDf.leadAlertWatchdog, pings, rows);
      };
      const lead = { contact_leads: { L1: { name: 'Pat Example', phone: '513-555-0101', source: 'home', createdAt: new Date(Date.now() - 30 * MIN) } } };
      const down = async () => { throw new Error('resend down'); };
      let r = await wdRun([], {});
      ok('(control) leadAlertWatchdog, nothing wrong: success, ok:true', !r.threw && r.row && r.row.ok === true && !r.ping.endsWith('/fail'), JSON.stringify(r.row));
      r = await wdRun(['ai_provider_outage'], {});
      ok('leadAlertWatchdog, a pipeline report with every lead reached: throws (pings /fail) but the ledger says ok:true', r.threw && /pipelineDeadMan: ai_provider_outage/.test(r.threw.message) && r.ping.endsWith('/fail') && r.row && r.row.ok === true, (r.threw && r.threw.message) + ' ' + JSON.stringify(r.row));
      r = await wdRun(['ai_provider_outage'], lead, down);
      ok('…the same report while a lead reached nobody: the ledger says ok:false (cronDeadman alerts)', r.threw && /reached nobody/.test(r.threw.message) && r.row && r.row.ok === false, (r.threw && r.threw.message) + ' ' + JSON.stringify(r.row));
      r = await wdRun([], lead, down);
      ok('(control) a lead that reached nobody, no pipeline report: ok:false', r.threw && r.row && r.row.ok === false, JSON.stringify(r.row));
    });
  }

  console.log('T. a push that fails is not a silent success');
  {
    const ON = require(path.join(FN, 'owner-notify.js'));
    const db = { collection: () => ({ add: async () => ({}) }) };
    // push-functions.js needs a Firebase app at load; stand in for it.
    const pfPath = require.resolve(path.join(FN, 'push-functions.js'));
    const pf = { sendCustomNotification: null };
    require.cache[pfPath] = { id: pfPath, filename: pfPath, loaded: true, exports: pf };
    const orig = pf.sendCustomNotification;
    pf.sendCustomNotification = async () => ({ sent: 0 });
    let r1; try { r1 = await ON.notifyOwner(db, 't', 'b'); } catch (e) { r1 = e; }
    pf.sendCustomNotification = async () => { throw new Error('fcm down'); };
    let r2; try { r2 = await ON.notifyOwner(db, 't', 'b'); } catch (e) { r2 = e; }
    pf.sendCustomNotification = async () => ({ sent: 1 });
    let r3; try { r3 = await ON.notifyOwner(db, 't', 'b'); } catch (e) { r3 = e; }
    pf.sendCustomNotification = orig;
    ok('notifyOwner reports pushed:false when no device got it / the push threw, pushed:true when it did', r1 && r1.pushed === false && r2 && r2.pushed === false && r3 && r3.pushed === true, JSON.stringify([r1, r2 && r2.message, r3]));
    const dbx = fakeDb({}); dbx.docs['system/heartbeats'] = { startedAtMs: et('2026-11-01', '00:00') };
    Object.assign(dbx.jobs, healthy(et('2026-11-23', '10:00')), { callCenterTranscribe: { schedule: 'every 30 minutes', ok: true, lastOkAtMs: et('2026-11-23', '08:00') } });
    await R.run({ db: dbx, nowMs: et('2026-11-23', '10:00'), live: true, expected, send: async () => ({ pushed: true }) });
    Object.assign(dbx.jobs, healthy(et('2026-11-23', '10:30')));
    const rr = await R.run({ db: dbx, nowMs: et('2026-11-23', '10:30'), live: true, expected, send: async () => ({ pushed: false }) });
    ok('cronDeadman: a recovery line whose push failed is reported (the handler throws on pushFailed)', rr.pushFailed === true && rr.downSent === 0, JSON.stringify(rr));
    // The real cronDeadman handler (its own getFirestore, the real notifyOwner
    // over the push-functions stand-in above). callCenterIngest is critical,
    // so its alert and recovery go out at any hour the suite runs.
    const now = Date.now();
    const handler = async (db, sentCount) => {
      pf.sendCustomNotification = async () => ({ sent: sentCount });
      const FA = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));
      return withFresh('cron-deadman.js', { 'firebase-admin/firestore': Object.assign({}, FA, { getFirestore: () => db }), 'firebase-functions/v2': quietV2 },
        (CDf) => scheduled('cronDeadman', CDf.cronDeadman, pings, rows));
    };
    const outageThenRecovery = async (recoverySent) => {
      const db = fakeDb({}); db.docs['system/heartbeats'] = { startedAtMs: now - 30 * DAY };
      db.jobs.callCenterIngest = { schedule: 'every 30 minutes', timeZone: 'America/New_York', ok: false, error: 'Drive 403', lastOkAtMs: now - 3 * H, finishedAtMs: now - MIN };
      const first = await handler(db, 1);
      db.jobs.callCenterIngest = { schedule: 'every 30 minutes', timeZone: 'America/New_York', ok: true, lastOkAtMs: now, finishedAtMs: now };
      return { first, second: await handler(db, recoverySent), notes: db.added.length };
    };
    const bad = await outageThenRecovery(0);
    ok('(the outage run throws on the alert it sent)', bad.first.threw && /cronDeadman: callCenterIngest/.test(bad.first.threw.message), bad.first.threw && bad.first.threw.message);
    ok('cronDeadman handler: a recovery line whose push reached no device fails the run', bad.second.threw && /push reached no device/.test(bad.second.threw.message) && bad.second.ping.endsWith('/fail') && bad.notes === 2, (bad.second.threw && bad.second.threw.message) + ' notes=' + bad.notes);
    const good = await outageThenRecovery(1);
    ok('(control) the same recovery delivered: the run succeeds', !good.second.threw && good.notes === 2, good.second.threw && good.second.threw.message);
    pf.sendCustomNotification = orig;
  }

  console.log('U. alert text never carries an email, phone or token');
  {
    const red = hb.redactText;
    ok('heartbeat.js exports redactText', typeof red === 'function');
    const raw = "invalid to: homeowner@example.com; The 'To' number +1 (513) 555-0142 is not valid; https://x/y?token=abc123&z=1";
    const out = red ? red(raw) : raw;
    ok('email, phone and ?token= are masked', !/homeowner@example\.com/.test(out) && !/555-0142/.test(out) && !/abc123/.test(out), out);
    ok('…plain text and short numbers survive', /is not valid/.test(out) && red('13 UNAVAILABLE after 540 s') === '13 UNAVAILABLE after 540 s');
    hb._overrides.functionTarget = 'callCenterTranscribe';
    pings.length = 0; rows.length = 0;
    const bodies = [];
    hb._overrides.fetchImpl = async (url, o) => { pings.push(url); bodies.push(String((o && o.body) || '')); return { ok: true, status: 200 }; };
    await hb.withHeartbeat(null, async () => { hb.softFail(new Error('resend rejected homeowner@example.com')); })({});
    hb._overrides.fetchImpl = async (url) => { pings.push(url); return { ok: true, status: 200 }; };
    ok('softFail: the ledger error and the Healthchecks body are masked', !/homeowner@/.test(rows[0].error) && !bodies.some((x) => /homeowner@/.test(x)), JSON.stringify(rows[0]) + bodies.join());
    const now = et('2026-11-23', '10:00');
    const p = D.judgeJobs({ jobs: { callCenterTranscribe: { schedule: 'every 30 minutes', ok: false, error: 'bad number +15135550142', lastOkAtMs: now - 3 * H } }, expected: ['callCenterTranscribe'], startedAtMs: now - 30 * DAY, now });
    ok('cronDeadman masks an older unmasked ledger error before sending', !/5135550142/.test(p.callCenterTranscribe.reason), p.callCenterTranscribe.reason);
  }

  hb._overrides.functionTarget = undefined;
  hb._overrides.recordRun = undefined;
  hb._overrides.fetchImpl = undefined;
  hb._overrides.pingKey = undefined;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
