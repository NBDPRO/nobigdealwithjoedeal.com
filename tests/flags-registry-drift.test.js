/**
 * tests/flags-registry-drift.test.js — the live-flags registry
 * (functions/flags-registry.js) can't fall out of sync with the code, and the
 * flagStatus callable can't leak a secret.
 *
 * Sibling of tests/cron-gate-drift.test.js (which pins the 32 cron gates);
 * this one covers EVERY env flag the functions read: *_ENABLED, *_DISABLED,
 * *_REQUIRED, *_MODE, and the `=== 'off'` kill switches — in both directions
 * (a new flag without a registry row fails; a stale row fails).
 *
 * Zero deps for the registry parts (flags-registry.js and cron-gates.js have
 * none). The handler-behaviour block needs functions/node_modules and is
 * skipped with a loud line when they are absent; the static handler checks
 * always run.
 *
 * Run: node tests/flags-registry-drift.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN_DIR = path.join(ROOT, 'functions');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; fails.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Fake secrets are assembled at runtime so no literal in this file looks like a
// real key to a secret scanner (gitleaks); the leak guard still plants real-shaped values.
const FAKE = (...p) => p.join('');
const REG = require(path.join(FN_DIR, 'flags-registry.js'));
const { CRON_GATES } = require(path.join(FN_DIR, 'cron-gates.js'));
const { FLAGS, GROUPS } = REG;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
}
const files = [];
walk(FN_DIR, files);

// Strip comments so a flag only mentioned in prose does not count as "read".
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const found = new Map();       // name -> Set<relative file>
function note(name, f) {
  const rel = path.relative(FN_DIR, f).split(path.sep).join('/');
  if (!found.has(name)) found.set(name, new Set());
  found.get(name).add(rel);
}
for (const f of files) {
  if (path.basename(f) === 'flags-registry.js' || path.basename(f) === 'cron-gates.js') continue;
  const src = stripComments(fs.readFileSync(f, 'utf8'));
  let m;
  // process.env.X_ENABLED / env.X_MODE (care-plan-logic reads an injected env)
  const re1 = /\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*_(?:ENABLED|DISABLED|REQUIRED|MODE))\b/g;
  while ((m = re1.exec(src))) note(m[1], f);
  // kill switches: process.env.NBD_X === 'off' / !== 'off'
  const re2 = /process\.env\.([A-Z][A-Z0-9_]*)\s*[!=]==\s*'off'/g;
  while ((m = re2.exec(src))) note(m[1], f);
  // bracket access: process.env['X_ENABLED']
  const re3 = /process\.env\[\s*['"]([A-Z][A-Z0-9_]*_(?:ENABLED|DISABLED|REQUIRED|MODE))['"]\s*\]/g;
  while ((m = re3.exec(src))) note(m[1], f);
}

console.log('\nFLAG REGISTRY — functions/flags-registry.js vs. the real code\n');

const regNames = new Set(FLAGS.map((f) => f.name));
const missing = [...found.keys()].filter((n) => !regNames.has(n));
ok('every flag the code reads is registered in flags-registry.js', missing.length === 0, JSON.stringify(missing));
const stale = [...regNames].filter((n) => !found.has(n));
ok('every registered flag is actually read somewhere in functions/ (no stale rows)', stale.length === 0, JSON.stringify(stale));

for (const f of FLAGS) {
  const where = found.get(f.name);
  if (!where) continue;
  ok(`${f.name}: registry file "${f.file}" is a file that really reads it`, where.has(f.file), JSON.stringify([...where]));
}

// 41 (2026-10-15): + REVIEW_ASK_AUTO_EMAIL_ENABLED / REVIEW_ASK_AUTO_TEXT_ENABLED (two more gates).
ok('registry pins 41 flags (update deliberately: 35 gates + CARE_PLAN_MODE + TURNSTILE_REQUIRED + 3 off-switches + the QA test-mode flag)',
  FLAGS.length === 41, String(FLAGS.length));

// ── cron-gates.js stays the single polarity source ────────────────────────
const gateNames = new Set(CRON_GATES.map((g) => g.name));
ok('every CRON_GATES gate has a registry row', CRON_GATES.every((g) => regNames.has(g.name)),
  JSON.stringify(CRON_GATES.filter((g) => !regNames.has(g.name)).map((g) => g.name)));
ok('registry kind for a gate IS the cron-gates polarity (no second hand copy)',
  CRON_GATES.every((g) => (FLAGS.find((f) => f.name === g.name) || {}).kind === g.polarity));

// The polarity itself must match the literal the code compares against —
// otherwise registry, cron-gates and health-digest are all wrong together
// (ESTIMATE_EMAIL_ENABLED / LEAD_FOLLOWUP_ENABLED were: the code runs them
// unless the value is the literal 'false').
console.log('\nthe literal each flag is compared with in its own file');
{
  const ALL_SRC = files.map((p) => stripComments(fs.readFileSync(p, 'utf8'))).join('\n');
  const LITERAL = { enabled: 'true', disabled: 'true', required: 'true', 'default-on': 'false', 'off-switch': 'off', 'one-on': '1' };
  for (const f of FLAGS) {
    if (!LITERAL[f.kind]) continue;
    const src = ALL_SRC;   // the compare can live in a sibling module (SOCIAL_GBP_ENABLED: social-adapters.js)
    const lits = new Set();
    const re = new RegExp(f.name + "[^;\\n]{0,70}?[!=]==\\s*'([A-Za-z0-9]+)'", 'g');
    let m;
    while ((m = re.exec(src))) lits.add(m[1]);
    ok(f.name + ' (' + f.kind + '): ' + f.file + ' compares it with \'' + LITERAL[f.kind] + '\'',
      lits.has(LITERAL[f.kind]) && lits.size === 1, JSON.stringify([...lits]));
  }
}
const nonGate = FLAGS.filter((f) => !gateNames.has(f.name)).map((f) => f.name).sort();
ok('the non-gate flags are exactly CARE_PLAN_MODE, TURNSTILE_REQUIRED, the three NBD_* off-switches and the QA test-mode flag',
  JSON.stringify(nonGate) === JSON.stringify(['CARE_PLAN_MODE', 'NBD_CONNECT_ALLOW_TEST_MODE', 'NBD_CRM_STRIPE_INVOICES', 'NBD_INVOICE_OVERDUE', 'NBD_MONEY_PAPER', 'TURNSTILE_REQUIRED']),
  JSON.stringify(nonGate));

// ── row quality ──────────────────────────────────────────────────────────
const KINDS = ['enabled', 'disabled', 'default-on', 'off-switch', 'one-on', 'required', 'mode'];
for (const f of FLAGS) {
  ok(`${f.name}: kind/group/meaning/doc are all filled in and valid`,
    KINDS.includes(f.kind) && GROUPS.includes(f.group) && f.meaning.length >= 20 && f.meaning.length <= 220 && typeof f.doc === 'string',
    JSON.stringify({ kind: f.kind, group: f.group }));
  ok(`${f.name}: owner decision doc exists (${f.doc})`, fs.existsSync(path.join(ROOT, f.doc)));
}
ok('no registry name looks like a secret (KEY/SECRET/TOKEN/PASSWORD)', FLAGS.every((f) => REG.isSafeName(f.name)));
ok('every group in GROUPS is used by at least one flag', GROUPS.every((g) => FLAGS.some((f) => f.group === g)));
ok('the ships-dark hints are exactly the flags that shipped dark awaiting Jo\'s go',
  JSON.stringify(FLAGS.filter((f) => f.dark).map((f) => f.name).sort()) === JSON.stringify([
    'AWAY_MODE_ENABLED', 'CARE_PLAN_MODE', 'MISSED_CALL_AUTOTEXT_ENABLED', 'REVIEW_ASK_AUTO_TEXT_ENABLED', 'SOCIAL_GBP_ENABLED', 'TEXT_INBOX_ENABLED', 'TEXT_NOTES_ENABLED',
    'THURSDAY_LABEL_PLAYBOOKS_ENABLED', 'TWILIO_INBOUND_ENABLED']),
  JSON.stringify(FLAGS.filter((f) => f.dark).map((f) => f.name).sort()));

// Every flag-shaped line in the committed env file must be registered.
{
  const envFile = fs.readFileSync(path.join(FN_DIR, '.env.nobigdeal-pro'), 'utf8');
  const names = [...envFile.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  const flagShaped = names.filter((n) => /_(ENABLED|DISABLED|REQUIRED|MODE)$/.test(n));
  ok('every flag-shaped name in functions/.env.nobigdeal-pro is registered',
    flagShaped.every((n) => regNames.has(n)), JSON.stringify(flagShaped.filter((n) => !regNames.has(n))));
}

// ── state semantics, per kind (mirrors how the code reads each value) ─────
console.log('\nstateFor() — polarity per kind');
{
  const S = REG.stateFor;
  ok('enabled: only the literal "true" is ON (unset, "yes", "TRUE" are OFF)',
    S('enabled', 'true') === 'ON' && S('enabled', 'unset') === 'OFF' && S('enabled', 'yes') === 'OFF' && S('enabled', 'false') === 'OFF');
  ok('disabled: unset runs (ON); "true" is PAUSED',
    S('disabled', 'unset') === 'ON' && S('disabled', 'true') === 'PAUSED' && S('disabled', 'false') === 'ON');
  ok('default-on: runs unless the literal "false" (PAUSED)',
    S('default-on', 'unset') === 'ON' && S('default-on', 'false') === 'PAUSED' && S('default-on', 'true') === 'ON');
  ok('off-switch: ON unless the literal "off" (PAUSED)',
    S('off-switch', 'unset') === 'ON' && S('off-switch', 'off') === 'PAUSED' && S('off-switch', 'true') === 'ON');
  ok('enabled: case is kept - "TRUE" is OFF at runtime and reads OFF here (no flattering fold to true)',
    S('enabled', 'TRUE') === 'OFF' && REG.safeValue('TRUE') === 'TRUE' && REG.safeValue(' true') === 'other');
  ok('default-on: only "false" pauses ("0", "off", "FALSE", "no" keep it running)',
    ['0', 'off', 'FALSE', 'no'].every((v) => S('default-on', v) === 'ON'));
  ok('off-switch: only "off" pauses ("false", "OFF", "0" keep it running)',
    ['false', 'OFF', '0'].every((v) => S('off-switch', v) === 'ON'));
  ok('required: "1" and "yes" are NOT required; "TRUE" is (turnstile.js lower-cases)',
    S('required', '1') === 'OFF' && S('required', 'yes') === 'OFF' && S('required', 'TRUE') === 'ON');
  ok('an unknown kind fails to OFF, never ON', S('nonsense', 'true') === 'OFF');
  ok('one-on: only the literal "1" is ON',
    S('one-on', '1') === 'ON' && S('one-on', 'true') === 'OFF' && S('one-on', 'unset') === 'OFF');
  ok('required: "true" is ON, anything else OFF',
    S('required', 'true') === 'ON' && S('required', 'unset') === 'OFF');
  ok('mode: off/unset/junk = OFF, test = TEST, live = ON (fails closed)',
    S('mode', 'off') === 'OFF' && S('mode', 'unset') === 'OFF' && S('mode', 'lve') === 'OFF' && S('mode', 'test') === 'TEST' && S('mode', 'live') === 'ON');
  const row = (env, name) => REG.flagStatus(env, null).find((r) => r.name === name);
  ok('flagStatus: LEAD_FOLLOWUP_ENABLED unset is ON (the code runs unless "false")', row({}, 'LEAD_FOLLOWUP_ENABLED').state === 'ON');
  ok('flagStatus: CARE_PLAN_MODE=test reads TEST', row({ CARE_PLAN_MODE: 'test' }, 'CARE_PLAN_MODE').state === 'TEST');
  ok('flagStatus: effective is "true"/"false"/"unset" and committed is null when no file',
    row({ AWAY_MODE_ENABLED: 'true' }, 'AWAY_MODE_ENABLED').effective === 'true'
    && row({ AWAY_MODE_ENABLED: 'false' }, 'AWAY_MODE_ENABLED').effective === 'false'
    && row({}, 'AWAY_MODE_ENABLED').effective === 'unset'
    && row({}, 'AWAY_MODE_ENABLED').committed === null && row({}, 'AWAY_MODE_ENABLED').drift === null);
}

// ── drift: committed file vs running env ─────────────────────────────────
console.log('\ncommitted vs running drift');
{
  const committed = REG.parseCommitted('HEALTH_DIGEST_ENABLED=true\nCARE_PLAN_MODE=off\nRESEND_API_KEY=' + FAKE('re_', 'abc') + '\nNOT_A_FLAG=1\n');
  ok('parseCommitted keeps registry names only (a key or a non-flag line never survives)',
    JSON.stringify(Object.keys(committed).sort()) === JSON.stringify(['CARE_PLAN_MODE', 'HEALTH_DIGEST_ENABLED']), JSON.stringify(committed));
  const rows = REG.flagStatus({ HEALTH_DIGEST_ENABLED: 'false', CARE_PLAN_MODE: 'off' }, committed);
  const h = rows.find((r) => r.name === 'HEALTH_DIGEST_ENABLED');
  ok('committed true vs running false is flagged as drift', h.drift === true && h.committed === 'true' && h.effective === 'false');
  ok('matching values are not drift', rows.find((r) => r.name === 'CARE_PLAN_MODE').drift === false);
  const ov = REG.flagStatus({ AWAY_MODE_ENABLED: 'true' }, committed).find((r) => r.name === 'AWAY_MODE_ENABLED');
  ok('runtime set but absent from the deployed file (a gcloud --update-env-vars override) IS drift',
    ov.drift === true && ov.committed === 'unset' && ov.effective === 'true');
  const un = REG.flagStatus({ CARE_PLAN_MODE: 'off' }, REG.parseCommitted('CARE_PLAN_MODE=live')).find((r) => r.name === 'CARE_PLAN_MODE');
  ok('file says live, runtime says off is drift', un.drift === true && un.committed === 'live' && un.effective === 'off');
  ok('a flag absent from the file and unset at runtime is not drift', rows.find((r) => r.name === 'AWAY_MODE_ENABLED').drift === false);
}

// ── secret-leak guard (with a positive control) ───────────────────────────
console.log('\nsecret-leak guard');
{
  const SECRETS = [FAKE('sk_', 'live_', 'SUPERSECRET123'), FAKE('re_', 'live_', 'RESENDKEY456'), FAKE('AC', '0123456789', 'TWILIOSID'), FAKE('whsec', '_WEBHOOKSECRET789'), FAKE('gh', 'p_', 'TOKEN0000')];
  const env = {
    RESEND_API_KEY: SECRETS[1], TWILIO_AUTH_TOKEN: SECRETS[2], STRIPE_SECRET_KEY: SECRETS[0],
    STRIPE_WEBHOOK_SECRET: SECRETS[3], GITHUB_TOKEN: SECRETS[4], NBD_OWNER_UID: 'ownerUidValue1234',
    // a registered flag whose value is secret-shaped: must not be echoed
    AWAY_MODE_ENABLED: SECRETS[3], CALL_WATCH_ENABLED: 'true',
    TWILIO_VOICE_FORWARD_TO: '+15555550100',
  };
  const leaks = (json) => [...SECRETS, 'ownerUidValue1234', '+15555550100'].filter((s) => json.includes(s));
  const out = JSON.stringify(REG.buildResponse(env, 'AWAY_MODE_ENABLED=' + SECRETS[3] + '\nCALL_WATCH_ENABLED=true\nRESEND_API_KEY=' + SECRETS[1] + '\n', { revision: 'rev-1' }));
  ok('no secret value, no non-registry env name appears in the output', leaks(out).length === 0, JSON.stringify(leaks(out)));
  ok('output names are exactly registry names',
    JSON.parse(out).flags.every((r) => regNames.has(r.name)));
  ok('a secret-shaped value on a registered flag is reduced to "other"',
    REG.flagStatus(env, null).find((r) => r.name === 'AWAY_MODE_ENABLED').effective === 'other');
  ok('CALL_WATCH_ENABLED=true still reads true (safeValue does not over-redact)',
    REG.flagStatus(env, null).find((r) => r.name === 'CALL_WATCH_ENABLED').effective === 'true');

  ok('the response has exactly the documented top-level keys (nothing env-shaped rides along)',
    JSON.stringify(Object.keys(JSON.parse(out)).sort()) === JSON.stringify(['committedAvailable', 'flags', 'generatedAtMs', 'groups', 'revision']));
  ok('every row has exactly the documented fields',
    JSON.parse(out).flags.every((r) => JSON.stringify(Object.keys(r).sort()) ===
      JSON.stringify(['committed', 'dark', 'doc', 'drift', 'effective', 'file', 'group', 'kind', 'meaning', 'name', 'state'])));
  // short and punctuated secrets are reduced too
  const shorties = ['a.b/c+d=e', 'sk-1234567890abcdefg', 'p@ss word', 'x'.repeat(40)];
  const sh = JSON.stringify(REG.flagStatus({ AWAY_MODE_ENABLED: shorties[0], CALL_WATCH_ENABLED: shorties[1], HEALTH_DIGEST_ENABLED: shorties[2], MORNING_BRIEF_ENABLED: shorties[3] }, null));
  ok('punctuated / spaced / long values never come back', shorties.every((s) => !sh.includes(s)));

  // Poisoned registry rows: a secret-named flag must be dropped, not returned (one per word).
  for (const bad of ['SOME_API_KEY', 'STRIPE_SECRET', 'GITHUB_TOKEN', 'DB_PASSWORD']) {
    FLAGS.push({ name: bad, kind: 'enabled', group: GROUPS[0], file: 'x.js', meaning: 'x'.repeat(30), doc: 'x', dark: false });
    const poisoned = JSON.stringify(REG.flagStatus({ [bad]: 'true' }, null));
    FLAGS.pop();
    ok('a registry row named ' + bad + ' is dropped at output time', !poisoned.includes(bad));
  }

  // Positive control: the leak detector must catch a naive implementation.
  const naive = JSON.stringify({ env });
  ok('POSITIVE CONTROL: the same leak check flags a naive "return process.env" payload', leaks(naive).length >= 3, JSON.stringify(leaks(naive)));
}

// ── handler (static): gate + no env dump ──────────────────────────────────
console.log('\nhandlers/integrations.js — flagStatus gate');
{
  const src = fs.readFileSync(path.join(FN_DIR, 'handlers', 'integrations.js'), 'utf8');
  const m = src.match(/exports\.flagStatus\s*=\s*onCall\s*\([\s\S]+?\n\);/);
  ok('flagStatus handler block located', !!m);
  const body = m ? stripComments(m[0]) : '';
  ok('requires authentication', /unauthenticated/.test(body));
  ok('is gated to admin / company_admin (or the platform owner uid), permission-denied otherwise',
    /\['admin',\s*'company_admin'\]\.includes\(callerRole\)/.test(body) && /permission-denied/.test(body) && /NBD_OWNER_UID/.test(body));
  ok('enforces App Check like its sibling callables', /enforceAppCheck:\s*true/.test(body));
  ok('returns registry output only: no process.env spread, no raw env object in the return',
    /return R\.buildResponse\(process\.env,\s*fileText,/.test(body) && !/\.\.\.process\.env/.test(body) && !/return\s*\{[^}]*\benv\s*:/.test(body));
  ok('is READ-ONLY: no Firestore / Storage / network write in the handler',
    !/\.(set|update|delete|add|create)\(|fetch\(|FieldValue/.test(body));
  const idx = fs.readFileSync(path.join(FN_DIR, 'index.js'), 'utf8');
  ok('exported from functions/index.js', /exports\.flagStatus\s*=\s*integrationsHandlers\.flagStatus/.test(idx));
  const map = JSON.parse(fs.readFileSync(path.join(FN_DIR, 'function-map.json'), 'utf8'));
  ok('present in function-map.json -> ./handlers/integrations', map.flagStatus === './handlers/integrations');
}

// ── handler (behaviour) ───────────────────────────────────────────────────
console.log('\nflagStatus callable — behaviour');
const haveDeps = fs.existsSync(path.join(FN_DIR, 'node_modules', 'firebase-functions'));
if (!haveDeps) {
  if (process.env.CI) ok('functions/node_modules is installed in CI (the behaviour block must run there)', false);
  else console.log('  (skipped: functions/node_modules absent — static checks above still ran)');
} else {
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'nobigdeal-pro';
  const realLog = console.log; console.log = () => {};
  let H;
  try { H = require(path.join(FN_DIR, 'handlers', 'integrations.js')); } finally { console.log = realLog; }
  const run = (req) => H.flagStatus.run(req);
  (async () => {
    const code = async (req) => { try { await run(req); return 'ok'; } catch (e) { return e.code || String(e); } };
    ok('no auth -> unauthenticated', (await code({})) === 'unauthenticated');
    ok('a rep -> permission-denied', (await code({ auth: { uid: 'u1', token: { role: 'rep' } } })) === 'permission-denied');
    ok('a viewer -> permission-denied', (await code({ auth: { uid: 'u1', token: { role: 'viewer' } } })) === 'permission-denied');
    ok('a member, manager and "owner"-string role claim -> permission-denied (only admin / company_admin / owner uid pass)',
      (await code({ auth: { uid: 'u1', token: { role: 'member' } } })) === 'permission-denied'
      && (await code({ auth: { uid: 'u1', token: { role: 'manager' } } })) === 'permission-denied'
      && (await code({ auth: { uid: 'u1', token: {} } })) === 'permission-denied');
    ok('company_admin -> ok', (await code({ auth: { uid: 'u1', token: { role: 'company_admin' } } })) === 'ok');
    const out = await run({ auth: { uid: 'u1', token: { role: 'admin' } } });
    ok('returns one row per registered flag plus groups', out.flags.length === FLAGS.length && Array.isArray(out.groups));
    const envFile = REG.parseCommitted(fs.readFileSync(path.join(FN_DIR, '.env.nobigdeal-pro'), 'utf8'));
    const hd = out.flags.find((r) => r.name === 'HEALTH_DIGEST_ENABLED');
    ok('reads the deployed env file: committed value matches the file, and running-vs-file drift is computed',
      out.committedAvailable === true && hd.committed === envFile.HEALTH_DIGEST_ENABLED && hd.committed === 'true'
      && hd.drift === (hd.effective !== 'true'), JSON.stringify(hd));
    // planted secrets in the real process env must not appear in the real handler output
    const planted = { RESEND_API_KEY: FAKE('re_', 'live_', 'PLANTED_9f8e7d'), TWILIO_AUTH_TOKEN: FAKE('tw_', 'PLANTED_token_1'), MY_DB_PASSWORD: 'hunter2-PLANTED' };
    Object.assign(process.env, planted);
    const leaked = JSON.stringify(await run({ auth: { uid: 'u1', token: { role: 'admin' } } }));
    for (const k of Object.keys(planted)) delete process.env[k];
    ok('real handler output contains none of the secrets planted in process.env',
      Object.values(planted).every((v) => !leaked.includes(v)) && !/PLANTED/.test(leaked));
    ok('real handler output has exactly the documented top-level keys',
      JSON.stringify(Object.keys(out).sort()) === JSON.stringify(['committedAvailable', 'flags', 'generatedAtMs', 'groups', 'revision']));
    const prev = process.env.NBD_OWNER_UID;
    process.env.NBD_OWNER_UID = 'jo-owner-uid';
    ok('the platform owner uid -> ok even with no role claim', (await code({ auth: { uid: 'jo-owner-uid', token: {} } })) === 'ok');
    if (prev === undefined) delete process.env.NBD_OWNER_UID; else process.env.NBD_OWNER_UID = prev;
    finish();
  })().catch((e) => { ok('behaviour block ran without throwing', false, e && e.message); finish(); });
}
if (!haveDeps) finish();

function finish() {
  if (finish.done) return; finish.done = true;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFAILED:'); for (const f of fails) console.log('  - ' + f); process.exit(1); }
}
