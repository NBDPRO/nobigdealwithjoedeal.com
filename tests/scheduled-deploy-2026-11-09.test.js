/**
 * tests/scheduled-deploy-2026-11-09.test.js
 *
 * WHY: future-dated blog posts and projects reach the static blog index, feed.xml, llms.txt and the project pages
 * only on the first deploy after their date, and .github/workflows/firebase-deploy.yml ran on push to main only. A
 * post dated Tuesday stayed JS-only (a countdown card, no feed entry, no static link for crawlers) until someone
 * happened to merge something. The plan (CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09 §2 step 5) publishes a post
 * every Tuesday, so the workflow now also runs on a weekly schedule, Tuesday early morning US Eastern.
 *
 * THE CONTRACT this suite pins, by evaluating every step's `if:` for each kind of run (zero deps, no YAML library):
 *   - the schedule fires on Tuesday between midnight and 07:00 US Eastern in both EST and EDT, off the top of the hour;
 *   - a `due` job (schedule only, no secrets, read-only token) runs the strict date-gated checks and the deploy job
 *     waits for it: a scheduled run with nothing newly due deploys nothing;
 *   - on a scheduled run every hosting step runs (the in-job regeneration of the date-gated files included) and NO
 *     functions / rules / indexes / storage step does;
 *   - push and workflow_dispatch behave exactly as before (every scope still picks its own steps);
 *   - nothing in the workflow commits or pushes (main changes only through PRs), and verify-live expects the
 *     hosting stamp on a scheduled run.
 *
 * Run: node tests/scheduled-deploy-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + String(extra).slice(0, 600) : '')); }
}

const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'firebase-deploy.yml'), 'utf8').replace(/\r\n/g, '\n');
const lines = yml.split('\n');
const noComments = lines.filter((l) => !/^\s*#/.test(l)).join('\n');

// ── Tiny structural reader: top-level `on:` keys, jobs (2-space keys under jobs:), steps (`      - name:`). ──
function block(startRe, indent) {
  const i = lines.findIndex((l) => startRe.test(l));
  if (i === -1) return null;
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() && !/^\s*#/.test(l) && l.match(/^\s*/)[0].length <= indent) break;
    out.push(l);
  }
  return out.join('\n');
}
const onBlock = block(/^on:\s*$/, 0) || '';
const jobBlock = (name) => block(new RegExp('^  ' + name + ':\\s*$'), 2);
function stepsOf(job) {
  const body = jobBlock(job) || '';
  const parts = body.split(/\n(?=      - (?:name|id|uses|run):)/).filter((p) => /^\s*- (name|id|uses|run):/.test(p));
  return parts.map((p) => {
    const name = (p.match(/^\s*- name:\s*(.+)$/m) || [])[1] || '(unnamed)';
    const ifm = p.match(/^        if:\s*(.+)$/m);
    return { name: name.trim(), if: ifm ? ifm[1].trim() : null, body: p };
  });
}
const jobIf = (job) => { const m = (jobBlock(job) || '').match(/^    if:\s*(.+)$/m); return m ? m[1].trim() : null; };

// GitHub expression -> JS, evaluated against a fake context. Covers the operators this workflow uses.
function evalIf(expr, ctx) {
  if (expr === null) return true;
  let e = expr.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '');
  e = e.replace(/\bvars\.(\w+)/g, (_, k) => JSON.stringify(ctx.vars[k] ?? null))
    .replace(/\bgithub\.event\.inputs\.(\w+)/g, (_, k) => JSON.stringify(ctx.inputs[k] ?? null))
    .replace(/\bgithub\.event_name\b/g, JSON.stringify(ctx.event))
    .replace(/\bgithub\.ref\b/g, JSON.stringify('refs/heads/main'))
    .replace(/\bsteps\.(\w+)\.outcome\b/g, (_, k) => JSON.stringify((ctx.outcomes || {})[k] || 'success'))
    .replace(/\bneeds\.(\w+)\.outputs\.(\w+)/g, (_, j, k) => JSON.stringify(((ctx.needs || {})[j] || {})[k] ?? ''))
    .replace(/\bneeds\.(\w+)\.result\b/g, (_, j) => JSON.stringify(((ctx.results || {})[j]) || 'success'))
    .replace(/\balways\(\)/g, 'true').replace(/\bsuccess\(\)/g, 'true').replace(/\bcancelled\(\)/g, 'false');
  // eslint-disable-next-line no-new-func
  return Boolean(new Function('return (' + e + ');')());
}

console.log('\ntrigger');
const cronM = onBlock.match(/^  schedule:\s*\n\s+- cron:\s*['"]([^'"]+)['"]/m);
ok('on: has a schedule with one cron', !!cronM && (onBlock.match(/- cron:/g) || []).length === 1, onBlock.slice(0, 400));
if (cronM) {
  const [min, hour, dom, mon, dow] = cronM[1].trim().split(/\s+/);
  const h = Number(hour), mi = Number(min);
  ok('the cron is weekly on Tuesday (day-of-week 2, any date, any month)', dow === '2' && dom === '*' && mon === '*', cronM[1]);
  ok('…early morning US Eastern in both EST (UTC-5) and EDT (UTC-4): local 00:00–07:00 Tuesday',
    Number.isInteger(h) && h - 5 >= 0 && h - 4 <= 7, cronM[1]);
  ok('…off the top of the hour (GitHub delays :00 schedules)', Number.isInteger(mi) && mi > 0 && mi < 60, cronM[1]);
}
ok('push to main and workflow_dispatch are still triggers', /^  push:\s*$/m.test(onBlock) && /^  workflow_dispatch:\s*$/m.test(onBlock));

console.log('\nthe due job');
const due = jobBlock('due');
ok('a `due` job exists', !!due);
ok('…runs only on the schedule', !!due && /github\.event_name == 'schedule'/.test(jobIf('due') || ''), jobIf('due'));
ok('…reads no secret', !!due && !/secrets\./.test(due));
ok('…has a read-only token', !!due && /permissions:\s*\n\s+contents: read\s*(\n|$)/.test(due));
ok('…runs the strict feed check and the strict projects check',
  !!due && /node scripts\/build-feed\.mjs --strict/.test(due) && /node scripts\/build-projects\.mjs --check --strict/.test(due));
ok('…publishes a `due` output', !!due && /outputs:\s*\n\s+due:\s*\$\{\{\s*steps\.\w+\.outputs\.due\s*\}\}/.test(due));

console.log('\nthe deploy job waits for `due` on a schedule, and only then');
const deployNeeds = ((jobBlock('deploy') || '').match(/^    needs:\s*(.+)$/m) || [])[1] || '';
ok('deploy needs check and due', /check/.test(deployNeeds) && /due/.test(deployNeeds), deployNeeds);
const dIf = jobIf('deploy');
const ctx = (event, extra = {}) => ({ event, inputs: {}, vars: {}, needs: { check: { configured: 'true' }, due: {} }, ...extra });
ok('push: deploy runs (due skipped)', evalIf(dIf, ctx('push')), dIf);
ok('workflow_dispatch: deploy runs', evalIf(dIf, ctx('workflow_dispatch', { inputs: { scope: 'all' } })), dIf);
ok('schedule with something due: deploy runs', evalIf(dIf, ctx('schedule', { needs: { check: { configured: 'true' }, due: { due: 'true' } } })), dIf);
ok('schedule with nothing due: deploy is skipped', !evalIf(dIf, ctx('schedule', { needs: { check: { configured: 'true' }, due: { due: 'false' } } })), dIf);
ok('schedule when the due job failed (no output): deploy is skipped', !evalIf(dIf, ctx('schedule')), dIf);
ok('no credentials: deploy is skipped on every trigger', !evalIf(dIf, ctx('push', { needs: { check: { configured: 'false' }, due: {} } })), dIf);

console.log('\nwhich deploy steps run on which trigger');
const steps = stepsOf('deploy');
ok('POSITIVE CONTROL: the deploy job has its steps', steps.length >= 30, String(steps.length));
const runsOn = (c) => steps.filter((s) => evalIf(s.if, c)).map((s) => s.name);
const sched = runsOn(ctx('schedule'));
// "Install Cloud Functions dependencies" installs, it deploys nothing; a scope=hosting dispatch has always run it.
const isBackend = (n) => !/^Install /.test(n) && /function|firestore|rules|indexes|storage|cloud scheduler|google apis|java|orphan|smoke|tolerant/i.test(n) && !/hosting/i.test(n);
const hostingNames = ['Regenerate static blog index', 'Regenerate static projects gallery', 'Sync sitemap URL set',
  'Regenerate RSS feed', 'Regenerate llms.txt lists + llms-full.txt', 'Deploy Hosting',
  'Stamp /version.json with the deployed commit', 'Gate — shipped JS must parse + site integrity must hold'];
for (const n of hostingNames) ok(`schedule runs "${n}"`, sched.includes(n), sched.join(' | '));
const backendOnSchedule = sched.filter(isBackend);
ok('schedule runs NO functions / rules / indexes / storage step', backendOnSchedule.length === 0, backendOnSchedule.join(' | '));
const hostingOnly = runsOn(ctx('workflow_dispatch', { inputs: { scope: 'hosting' } }));
ok('schedule runs exactly the steps a scope=hosting dispatch runs',
  JSON.stringify(sched) === JSON.stringify(hostingOnly),
  'only schedule: ' + sched.filter((n) => !hostingOnly.includes(n)).join(', ') + ' | only dispatch: ' + hostingOnly.filter((n) => !sched.includes(n)).join(', '));
const push = runsOn(ctx('push'));
const all = runsOn(ctx('workflow_dispatch', { inputs: { scope: 'all' } }));
ok('push still runs the backend steps', push.filter(isBackend).length >= 5, push.filter(isBackend).join(' | '));
ok('push runs everything scope=all runs, plus only the push-only IndexNow ping',
  JSON.stringify(push.filter((n) => !/IndexNow/.test(n))) === JSON.stringify(all));
const fnOnly = runsOn(ctx('workflow_dispatch', { inputs: { scope: 'functions' } }));
ok('a scope=functions dispatch still deploys no hosting', !fnOnly.includes('Deploy Hosting') && !fnOnly.some((n) => /^Regenerate/.test(n)));
ok('the IndexNow ping stays push-only', !sched.some((n) => /IndexNow/.test(n)) && push.some((n) => /IndexNow/.test(n)));
const hostingStep = steps.find((s) => s.name === 'Deploy Hosting');
ok('the Hosting step deploys hosting only', !!hostingStep && /deploy --only hosting\b/.test(hostingStep.body));

console.log('\nnever commits to main; verify-live understands the schedule');
ok('no step runs git commit or git push', !/\bgit\s+(commit|push)\b/.test(noComments));
ok('the deploy job token stays read-only', /permissions:\s*\n\s+contents: read\s*\n/.test(jobBlock('deploy') || ''));
const vl = jobBlock('verify-live') || '';
const expect = (vl.match(/EXPECT_LANDED:\s*(\$\{\{[\s\S]*?\}\})/) || [])[1] || '';
const evalExpect = (c) => { const e = expect.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '').replace(/&& 'true' \|\| 'false'$/, '').trim(); return evalIf(e, c); };
// GitHub skips a job whose ANCESTOR was skipped unless its if: carries a status function; `due` is skipped on every
// push, so without one verify-live would silently stop running after every push deploy.
const vlIf = jobIf('verify-live') || '';
ok('verify-live carries a status function (!cancelled()/always()), so a skipped `due` never skips it',
  /!cancelled\(\)|always\(\)/.test(vlIf), vlIf);
ok('verify-live still runs only after a successful deploy with credentials',
  evalIf(vlIf, ctx('push')) && !evalIf(vlIf, { ...ctx('push'), results: { deploy: 'skipped' } })
  && !evalIf(vlIf, ctx('push', { needs: { check: { configured: 'false' } } })), vlIf);
ok('verify-live expects the hosting stamp to land on a scheduled run', !!expect && evalExpect(ctx('schedule')), expect);
ok('…and still on push, but not on a scope=functions dispatch', evalExpect(ctx('push')) && !evalExpect(ctx('workflow_dispatch', { inputs: { scope: 'functions' } })));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
