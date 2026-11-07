/**
 * tests/understand-context-2026-11-06.test.js — CRM audit 2026-11-06, DT-F18.
 *
 * pages/understand.js loadPipelineContext read `leads/{uid}/leads`, a path
 * that does not exist; the catch-all rule denied it, so the "Your pipeline"
 * bar and the AI context were always empty. Leads live in the flat /leads
 * collection keyed by userId (as project-codex-page.js reads them).
 * Real loadPipelineContext in a vm with a stubbed Firestore that refuses the
 * nested path the way the rules do. Zero deps.
 * Run: node tests/understand-context-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'pages', 'understand.js'), 'utf8').replace(/\r\n/g, '\n');

(async function main() {
  console.log('PIPELINE CONTEXT (DT-F18)');
  const s = SRC.indexOf('async function loadPipelineContext() {');
  const fn = s >= 0 ? SRC.slice(s, SRC.indexOf('\n}\n', s) + 3) : '';
  ok('loadPipelineContext found (positive control)', fn.length > 200);
  const LEADS = [
    { id: 'a', userId: 'u1', stage: 'new', estimateTotal: 1000 },
    { id: 'b', userId: 'u1', stage: 'completed', estimateTotal: 2500 },
    { id: 'c', userId: 'u1', stage: 'new', estimateTotal: 9999, deleted: true },
    { id: 'd', userId: 'other', stage: 'new', estimateTotal: 777 },
  ];
  const fsx = {
    collection: (db, ...segs) => ({ path: segs.join('/') }),
    where: (f, op, v) => ({ f, v }), limit: (n) => ({ limit: n }),
    query: (c, ...cs) => ({ path: c.path, cs }),
    getDocs: async (q) => {
      if (q.path !== 'leads') throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
      const w = q.cs.find((x) => x && x.f === 'userId');
      if (!w || w.v !== 'u1') throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
      const rows = LEADS.filter((d) => d.userId === w.v);
      return { size: rows.length, forEach: (f) => rows.forEach((d) => f({ id: d.id, data: () => d })) };
    },
  };
  const sb = { window: { _db: {}, _authUser: { uid: 'u1' } }, console: { log() {}, warn() {}, error() {} }, Number, globalThis: null, __fs: fsx };
  sb.globalThis = sb;
  const code = 'let pipelineContext = null;\n' + fn.replace("await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js')", 'globalThis.__fs') +
    '\nglobalThis.__run = async () => { await loadPipelineContext(); return pipelineContext; };';
  vm.createContext(sb);
  vm.runInContext(code, sb);
  const ctx = await sb.__run();
  ok('the context loads (it was always empty: the nested path is refused)', !!ctx, JSON.stringify(ctx));
  ok('it counts the user\'s leads, skipping deleted ones', ctx && ctx.leads === 2, ctx && String(ctx.leads));
  ok('pipeline value sums only those leads', ctx && ctx.revenue === 3500, ctx && String(ctx.revenue));
  ok('active / closed split by stage', ctx && ctx.active === 1 && ctx.closed === 1);
  ok('the read is capped', /limit\(\d+\)/.test(fn));
}
)();
process.on('beforeExit', () => { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exitCode = failed ? 1 : 0; });
