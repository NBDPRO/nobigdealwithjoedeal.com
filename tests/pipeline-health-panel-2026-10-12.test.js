#!/usr/bin/env node
/**
 * Pipeline health panel (audit 2026-10-12): functions/pipeline-health.js
 * (callPipelineHealth) + the Call Center strip in call-center-view.js.
 * Run: node tests/pipeline-health-panel-2026-10-12.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const PH = require(path.join(ROOT, 'functions/pipeline-health.js'))._internal;
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const MIN = 60000, H = 3600000;
const NOW = Date.parse('2026-10-02T14:40:00Z'); // 10:40 AM ET
const gates = { watch: true, ingest: true, transcribe: true };
const good = () => ({
  now: NOW, gates,
  watch: { lastCheckAtMs: NOW - 40 * MIN, lastPush: { sent: 1 } },
  cc: { lastRunAtMs: NOW - 10 * MIN, lastTranscribeAtMs: NOW - 10 * MIN },
  health: { problems: [], checkedAtMs: NOW - 5 * MIN, canary: { ok: true, ymd: '2026-10-02', checks: 7, failed: [] } },
  ledger: { ymd: '2026-10-01', clear: true, open: 0, anomalies: [] },
  newestCallMs: NOW - 2 * H, waiting: 0, tokens: 2,
});
const row = (r, k) => r.rows.find((x) => x.key === k);

(async () => {
  console.log('A. healthRows');
  let r = PH.healthRows(good());
  ok('everything running -> overall ok, every row ok', r.overall === 'ok' && r.rows.every((x) => x.status === 'ok'), JSON.stringify(r.rows.filter((x) => x.status !== 'ok')));
  let i = good(); i.watch.lastCheckAtMs = NOW - 5 * H;
  r = PH.healthRows(i);
  ok('2-hour check overdue -> that row bad, overall bad', row(r, 'callwatch').status === 'bad' && r.overall === 'bad' && /overdue/.test(row(r, 'callwatch').detail));
  i = good(); i.cc.lastRunAtMs = NOW - 3 * H;
  ok('copy job 3 h silent -> bad', row(PH.healthRows(i), 'copy').status === 'bad');
  i = good(); i.tokens = 0;
  ok('no push device on file -> push bad', row(PH.healthRows(i), 'push').status === 'bad');
  i = good(); i.watch.lastPush = { sent: 0 };
  ok('last alert reached 0 phones -> push bad', row(PH.healthRows(i), 'push').status === 'bad' && /reached 0/.test(row(PH.healthRows(i), 'push').detail));
  i = good(); i.newestCallMs = NOW - 40 * H;
  ok('no recording for 40 h -> bad', row(PH.healthRows(i), 'recordings').status === 'bad');
  i = good(); i.health.problems = ['ingest_not_running'];
  ok('dead-man problem listed -> bad', row(PH.healthRows(i), 'deadman').status === 'bad' && /ingest_not_running/.test(row(PH.healthRows(i), 'deadman').detail));
  i = good(); i.gates = { watch: false, ingest: true, transcribe: true };
  ok('callWatch switched off is flagged, not hidden', row(PH.healthRows(i), 'callwatch').status === 'warn');
  i = good(); i.waiting = 9;
  ok('9 transcripts waiting -> bad', row(PH.healthRows(i), 'waiting').status === 'bad');

  console.log('B. the callable');
  const mkDb = (docs) => ({
    doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p] }) }),
    collection: (c) => {
      const q = { where: () => q, orderBy: () => q, limit: () => q, get: async () => ({ docs: [{ data: () => ({ startedAtMs: NOW - H }) }], size: 0 }), doc: () => ({ collection: () => ({ get: async () => ({ size: 2 }) }) }) };
      return q;
    },
  });
  const OWNER = '1phDvAVXHSg82wDLegAbQFq14Ci1';
  let denied = null;
  try { await PH.handle({ auth: { uid: 'stranger', token: { role: 'sales_rep' } }, db: mkDb({}), nowMs: NOW }); } catch (e) { denied = e; }
  ok('a non-owner is refused', denied && denied.code === 'permission-denied');
  denied = null;
  try { await PH.handle({ auth: null, db: mkDb({}), nowMs: NOW }); } catch (e) { denied = e; }
  ok('signed out is refused', denied && denied.code === 'unauthenticated');
  const snap = await PH.handle({ auth: { uid: OWNER, token: {} }, db: mkDb({ 'integrations/callWatch': { lastCheckAtMs: NOW - 10 * MIN, lastPush: { sent: 1 } }, 'integrations/callCenter': { lastRunAtMs: NOW - 5 * MIN, lastTranscribeAtMs: NOW - 5 * MIN } }), nowMs: NOW });
  ok('owner gets rows + overall', Array.isArray(snap.rows) && snap.rows.length === 9 && !!snap.overall && snap.atMs === NOW);

  console.log('C. wiring');
  const idx = read('functions/index.js');
  ok('exported from index.js + function-map', /exports\.callPipelineHealth = require\('\.\/pipeline-health'\)\.callPipelineHealth/.test(idx) && /"callPipelineHealth": "\.\/pipeline-health"/.test(read('functions/function-map.json')));
  ok('callable enforces App Check', /enforceAppCheck: true/.test(read('functions/pipeline-health.js')));
  const v = read('docs/pro/js/call-center-view.js');
  ok('the Call Center renders the strip and loads it on init', /healthPanel\(\) \+ tagPanel\(\)/.test(v) && /init: function \(\) \{ load\(\); loadPromises\(\); loadHealth\(\)/.test(v));
  ok('a failed read says so (never renders green)', /Could not check the call pipeline just now/.test(v));
  ok('loader cache-busted', /call-center-view\.js\?v=1[5-9]/.test(read('docs/pro/js/script-loader.js')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
