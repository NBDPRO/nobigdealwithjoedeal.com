/**
 * tests/cron-heartbeat.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every scheduled function now pings Healthchecks.io after each run through
 * the drop-in onSchedule in functions/integrations/heartbeat.js. The
 * guarantee this buys — "Jo hears within minutes when a cron stops" — has two
 * silent failure modes: a cron that imports the raw scheduler and so never
 * pings (the monitor then alerts forever, or never gets created), and a ping
 * that throws into the cron and fails the work it monitors. The first is a
 * source contract enforced here over every file under functions/; the second
 * is driven with an injected fetch that throws.
 *
 * Also pinned: the slug derivation (the check name Jo types must equal what
 * the code sends), the /fail suffix on a throw, the rethrow, the auto-bound
 * secret on the real firebase-functions endpoint object, and the no-op when
 * the key is the deploy's `__unset__` stub.
 *
 * Pure-Node, no network. Run: node tests/cron-heartbeat.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const hb = require(path.join(FUNCTIONS, 'integrations', 'heartbeat.js'));
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

console.log('\nSLUGS — what the code sends is what Jo types into Healthchecks');
{
  ok('hailMatchCron → hail-match-cron', hb.heartbeatSlug('hailMatchCron') === 'hail-match-cron');
  ok('onAppointmentReminder → on-appointment-reminder', hb.heartbeatSlug('onAppointmentReminder') === 'on-appointment-reminder');
  ok('migrationsTick → migrations-tick', hb.heartbeatSlug('migrationsTick') === 'migrations-tick');
  ok('already-kebab passes through', hb.heartbeatSlug('email-queue-worker') === 'email-queue-worker');
  ok('odd characters collapse to single hyphens, no leading/trailing', hb.heartbeatSlug('  weird__Name!! ') === 'weird-name');
  ok('empty → empty (and pingHeartbeat refuses an empty slug below)', hb.heartbeatSlug('') === '' && hb.heartbeatSlug(undefined) === '');
  hb._overrides.functionTarget = 'hailMatchCron';
  ok('the run-time name comes from FUNCTION_TARGET (test seam)', hb.currentFunctionName() === 'hailMatchCron');
  hb._overrides.functionTarget = undefined;
}

console.log('\nURLS');
{
  ok('success ping is hc-ping.com/<key>/<slug>', hb.heartbeatUrl('abc123', 'hail-match-cron') === 'https://hc-ping.com/abc123/hail-match-cron');
  ok('failure ping appends /fail', hb.heartbeatUrl('abc123', 'hail-match-cron', 'fail') === 'https://hc-ping.com/abc123/hail-match-cron/fail');
  ok('start ping appends /start', hb.heartbeatUrl('abc123', 'x', 'start') === 'https://hc-ping.com/abc123/x/start');
  ok('the key is URL-encoded', hb.heartbeatUrl('a/b c', 'x') === 'https://hc-ping.com/a%2Fb%20c/x');
}

(async () => {
console.log('\nPING — no-op when unset, POST when set, never throws');
{
  const calls = [];
  hb._overrides.fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };

  hb._overrides.pingKey = null;
  let r = await hb.pingHeartbeat('hail-match-cron', 'success', {});
  ok('unset key → { sent:false, reason:"unset" } and NO request', r.sent === false && r.reason === 'unset' && calls.length === 0);

  hb._overrides.pingKey = 'KEY';
  r = await hb.pingHeartbeat('', 'success', {});
  ok('empty slug → refused, NO request (never pings an unknown check as "ok")', r.sent === false && r.reason === 'no-slug' && calls.length === 0);

  r = await hb.pingHeartbeat('hail-match-cron', 'success', { durationMs: 1234 });
  ok('configured → one POST to the slug URL', r.sent === true && calls.length === 1 && calls[0].url === 'https://hc-ping.com/KEY/hail-match-cron' && calls[0].opts.method === 'POST');
  ok('body carries outcome + meta as JSON', JSON.parse(calls[0].opts.body).outcome === 'success' && JSON.parse(calls[0].opts.body).durationMs === 1234);
  ok('request has a timeout signal', !!calls[0].opts.signal);

  await hb.pingHeartbeat('hail-match-cron', 'fail', { error: 'boom' });
  ok('a failure pings /fail', calls[1].url.endsWith('/hail-match-cron/fail'));

  hb._overrides.fetchImpl = async () => ({ ok: false, status: 404 });
  r = await hb.pingHeartbeat('not-created-yet', 'success', {});
  ok('404 (no check with that slug yet) → sent:false, status 404, no throw', r.sent === false && r.status === 404);

  hb._overrides.fetchImpl = async () => { throw new Error('ECONNRESET'); };
  r = await hb.pingHeartbeat('hail-match-cron', 'success', {});
  ok('a network error → sent:false with the message, no throw', r.sent === false && /ECONNRESET/.test(r.error));
}

console.log('\nWRAP — success pings, throw pings /fail and rethrows, work is never blocked by the ping');
{
  const calls = [];
  hb._overrides.pingKey = 'KEY';
  hb._overrides.fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200 }; };
  // A DEDICATED-check cron: its plan slug is its kebab-case name. (Until
  // 2026-10-04 this used hailMatchCron, which now shares 'daily-syncs' — see
  // the PLAN section below.)
  hb._overrides.functionTarget = 'migrationsTick';

  const wrapped = hb.withHeartbeat(null, async (ev) => 'result:' + ev.x);
  const out = await wrapped({ x: 1 });
  ok('handler result is returned unchanged', out === 'result:1');
  ok('success pinged the planned slug', calls.length === 1 && calls[0] === 'https://hc-ping.com/KEY/migrations-tick');

  const failing = hb.withHeartbeat(null, async () => { throw new Error('cron blew up'); });
  let threw = null;
  try { await failing({}); } catch (e) { threw = e; }
  ok('a throwing handler still throws (Cloud Scheduler must see the failure)', threw && threw.message === 'cron blew up');
  ok('…after pinging /fail', calls.length === 2 && calls[1].endsWith('/migrations-tick/fail'));

  hb._overrides.fetchImpl = async () => { throw new Error('healthchecks is down'); };
  const out2 = await wrapped({ x: 2 });
  ok('when Healthchecks itself is unreachable the handler result still returns', out2 === 'result:2');

  const explicit = hb.withHeartbeat('custom-slug', async () => 1);
  hb._overrides.fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200 }; };
  await explicit({});
  ok('an explicit slug wins over FUNCTION_TARGET', calls[calls.length - 1].endsWith('/custom-slug'));

  let typeErr = null;
  try { hb.withHeartbeat(null, 'not a function'); } catch (e) { typeErr = e; }
  ok('a non-function handler is rejected at definition time, not at 3 am', typeErr instanceof TypeError);
  hb._overrides.functionTarget = undefined;
}

console.log('\nONSCHEDULE — the real endpoint object binds the ping key and keeps the rest');
{
  const marker = { key: 'OTHER_SECRET' };
  const fn = hb.onSchedule({ schedule: 'every 5 minutes', region: 'us-central1', secrets: ['RESEND_API_KEY'], timeoutSeconds: 60 }, async () => 'ran');
  const ep = fn && fn.__endpoint;
  ok('returns a firebase-functions v2 endpoint', !!ep && !!ep.scheduleTrigger);
  ok('schedule preserved', ep.scheduleTrigger.schedule === 'every 5 minutes');
  ok('region + timeout preserved', (Array.isArray(ep.region) ? ep.region[0] : ep.region) === 'us-central1' && ep.timeoutSeconds === 60);
  const secretKeys = (ep.secretEnvironmentVariables || []).map((s) => s.key || s);
  ok('existing secrets kept', secretKeys.includes('RESEND_API_KEY'));
  ok('HEALTHCHECKS_PING_KEY added', secretKeys.includes('HEALTHCHECKS_PING_KEY'));
  ok('…exactly once', secretKeys.filter((k) => k === 'HEALTHCHECKS_PING_KEY').length === 1);

  const fn2 = hb.onSchedule('every 10 minutes', async () => 'ran');
  ok('string-schedule form works like the original', fn2.__endpoint.scheduleTrigger.schedule === 'every 10 minutes'
     && (fn2.__endpoint.secretEnvironmentVariables || []).some((s) => (s.key || s) === 'HEALTHCHECKS_PING_KEY'));

  const noOpt = hb.onSchedule({ schedule: 'every 1 hours', heartbeat: false }, async () => 1);
  ok('heartbeat:false opts out — no secret bound, no `heartbeat` key leaked into the endpoint',
     !(noOpt.__endpoint.secretEnvironmentVariables || []).some((s) => (s.key || s) === 'HEALTHCHECKS_PING_KEY') && !('heartbeat' in noOpt.__endpoint));

  // Run the wrapped handler through the endpoint the way the runtime would.
  const calls = [];
  hb._overrides.pingKey = 'KEY';
  hb._overrides.fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200 }; };
  const named = hb.onSchedule({ schedule: 'every 1 hours', heartbeat: 'weekly-digest' }, async () => 'ok');
  const runner = typeof named.run === 'function' ? named.run : named;
  const res = await runner({ scheduleTime: new Date().toISOString() });
  ok('invoking the endpoint runs the handler and pings the explicit slug', res === 'ok' && calls.length === 1 && calls[0].endsWith('/weekly-digest'));
  void marker;
}

console.log('\nSOURCE CONTRACT — every cron goes through the wrapper');
{
  const files = walk(FUNCTIONS);
  const rawImporters = [];
  const cronFiles = [];
  let cronCount = 0;
  for (const f of files) {
    const rel = path.relative(FUNCTIONS, f).replace(/\\/g, '/');
    const src = codeOnly(fs.readFileSync(f, 'utf8'));
    if (/require\(\s*['"]firebase-functions\/v2\/scheduler['"]\s*\)/.test(src) && rel !== 'integrations/heartbeat.js') rawImporters.push(rel);
    const n = (src.match(/\bonSchedule\(/g) || []).length;
    if (n && rel !== 'integrations/heartbeat.js') {
      cronCount += n;
      cronFiles.push(rel);
      const importsWrapper = /require\(\s*['"](\.\/integrations\/heartbeat|\.\/heartbeat|\.\.\/integrations\/heartbeat)['"]\s*\)/.test(src);
      ok(`${rel} imports onSchedule from the heartbeat wrapper`, importsWrapper);
    }
  }
  ok('only heartbeat.js touches firebase-functions/v2/scheduler directly', rawImporters.length === 0, rawImporters.join(', '));
  // RATCHET LOWERED 25 -> 24 on 2026-09-05, deliberately and once.
  // nightlyFirestoreBackup was retired from integrations/compliance.js: a
  // second Firestore export against gs://nobigdeal-pro-backups, a bucket
  // never created because the job had no retention pass, duplicating
  // firestore-backup.js which exports AND prunes. It failed every night it
  // ever ran. FUNCTIONS_INDEX.md had already ruled "retire it rather than
  // fix it"; this is that.
  //
  // The ratchet exists so a cron is never dropped SILENTLY — it did its job
  // here, failing this PR until the removal was justified in writing. Do not
  // lower it again to make a red test green: find out which cron went missing
  // and why first.
  ok('all 24 scheduled functions are accounted for (ratchet: never fewer)', cronCount >= 24, String(cronCount));
  ok('spread across the 22 cron files', cronFiles.length >= 22, String(cronFiles.length));

  const shared = codeOnly(fs.readFileSync(path.join(FUNCTIONS, 'integrations', '_shared.js'), 'utf8'));
  ok('_shared.js declares defineSecret(\'HEALTHCHECKS_PING_KEY\') — the literal the deploy auto-discovers to stub the secret',
     /defineSecret\(\s*'HEALTHCHECKS_PING_KEY'\s*\)/.test(shared));
  const status = codeOnly(fs.readFileSync(path.join(FUNCTIONS, 'handlers', 'integrations.js'), 'utf8'));
  ok('integrationStatus reports healthchecks', /healthchecks:\s*_hasInt\(\s*'HEALTHCHECKS_PING_KEY'\s*\)/.test(status));
  const runbook = path.join(ROOT, 'documentation', 'runbooks', 'HEALTHCHECKS-SETUP.md');
  ok('the setup runbook exists and lists the migrations-tick slug', fs.existsSync(runbook) && /migrations-tick/.test(fs.readFileSync(runbook, 'utf8')));
}

console.log('\nPLAN — every cron has a check (or a dated exemption), within the free tier');
{
  const planMod = require(path.join(FUNCTIONS, 'integrations', 'heartbeat-plan.js'));
  const { PLAN, CHECKS, MAX_CHECKS } = planMod;
  // Every exported cron, from source: exports.NAME = onSchedule(
  const crons = [];
  for (const f of walk(FUNCTIONS)) {
    const rel = path.relative(FUNCTIONS, f).replace(/\\/g, '/');
    if (rel === 'integrations/heartbeat.js') continue;
    for (const m of codeOnly(fs.readFileSync(f, 'utf8')).matchAll(/^exports\.([A-Za-z_]\w*)\s*=\s*onSchedule\(/gm)) crons.push(m[1]);
  }
  ok('found the crons (35 on 2026-10-04)', crons.length >= 35, String(crons.length));
  const unplanned = crons.filter((c) => !PLAN[c]);
  ok('every cron is in heartbeat-plan.js', unplanned.length === 0, 'add to PLAN: ' + unplanned.join(', '));
  const stale = Object.keys(PLAN).filter((n) => !crons.includes(n));
  ok('every PLAN entry is a real cron (no stale names)', stale.length === 0, stale.join(', '));
  const badEntry = Object.entries(PLAN).filter(([, e]) => !(e.exempt ? /\b20\d\d-\d\d-\d\d\b/.test(e.exempt) && !e.slug : typeof e.slug === 'string' && e.slug));
  ok('each entry is { slug } or { exempt: "<YYYY-MM-DD> reason" }', badEntry.length === 0, badEntry.map(([n]) => n).join(', '));
  const used = [...new Set(Object.values(PLAN).filter((e) => e.slug).map((e) => e.slug))];
  ok('checks needed: ' + used.length + ' ≤ ' + MAX_CHECKS + ' (Healthchecks free tier)', used.length <= MAX_CHECKS);
  const undocumented = used.filter((s) => !CHECKS[s] || !CHECKS[s].period || !CHECKS[s].grace);
  ok('every slug in use has a period + grace in CHECKS', undocumented.length === 0, undocumented.join(', '));
  const unused = Object.keys(CHECKS).filter((s) => !used.includes(s));
  ok('no CHECKS entry is unused', unused.length === 0, unused.join(', '));
  ok('slugs are already in canonical form (what the wrapper sends == what Jo types)', used.every((s) => hb.heartbeatSlug(s) === s), used.filter((s) => hb.heartbeatSlug(s) !== s).join(', '));
  // Dedicated checks keep the slug they always had, so existing checks stay green.
  const dedicated = used.filter((s) => Object.values(PLAN).filter((e) => e.slug === s).length === 1);
  const renamed = dedicated.filter((s) => !Object.keys(PLAN).some((n) => PLAN[n].slug === s && hb.heartbeatSlug(n) === s));
  ok('a dedicated check keeps the cron\'s historical kebab slug', renamed.length === 0, renamed.join(', '));

  // Behaviour: the wrapper pings the PLANNED slug, by FUNCTION_TARGET.
  const calls = [];
  hb._overrides.pingKey = 'KEY';
  hb._overrides.fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200 }; };
  hb._overrides.functionTarget = 'callCenterIngest';
  await hb.withHeartbeat(null, async () => 1)({});
  ok('a grouped cron pings its SHARED slug (callCenterIngest → calls-texts-ingest)', calls[calls.length - 1] === 'https://hc-ping.com/KEY/calls-texts-ingest', calls[calls.length - 1]);
  hb._overrides.functionTarget = 'hailMatchCron';
  let threw = null;
  try { await hb.withHeartbeat(null, async () => { throw new Error('x'); })({}); } catch (e) { threw = e; }
  ok('a grouped cron\'s throw pings <shared>/fail (failures still surface)', threw && calls[calls.length - 1].endsWith('/daily-syncs/fail'));
  hb._overrides.functionTarget = 'someBrandNewCron';
  await hb.withHeartbeat(null, async () => 1)({});
  ok('an unplanned cron still pings its kebab default (and the coverage check above goes red)', calls[calls.length - 1].endsWith('/some-brand-new-cron'));
  // Exempt path, via a temporary plan entry.
  PLAN.someBrandNewCron = { exempt: '2026-10-04 test' };
  const before = calls.length;
  const r = await hb.withHeartbeat(null, async () => 'ran')({});
  ok('an exempt cron runs and pings nothing', r === 'ran' && calls.length === before);
  delete PLAN.someBrandNewCron;
  hb._overrides.functionTarget = undefined;

  // The runbook table is the list Jo creates — it must match the plan.
  const md = fs.readFileSync(path.join(ROOT, 'documentation', 'runbooks', 'HEALTHCHECKS-SETUP.md'), 'utf8');
  const missingRows = used.filter((s) => !new RegExp('\\|\\s*\x60' + s + '\x60\\s*\\|').test(md));
  ok('HEALTHCHECKS-SETUP.md has a table row for every check', missingRows.length === 0, missingRows.join(', '));
  const unlistedCrons = crons.filter((c) => !md.includes(c));
  ok('HEALTHCHECKS-SETUP.md names every cron', unlistedCrons.length === 0, unlistedCrons.join(', '));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
