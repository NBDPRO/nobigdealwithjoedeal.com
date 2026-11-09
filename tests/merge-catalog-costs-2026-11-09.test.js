/**
 * tests/merge-catalog-costs-2026-11-09.test.js
 *
 * scripts/merge-catalog-costs.js merges ONLY approved SKU cost tiers (and
 * approved xactimate materialCost values) into an EXISTING tenant cost book by
 * field path. The importer cannot do this: it writes a whole `costs` map and
 * --force would revert every Product Library edit since the cutover.
 *
 * Proves: untouched keys stay untouched (labor, laborOps, xactCosts, jtCosts,
 * v2Costs, other SKUs, unapproved tiers), refused tiers are never written,
 * --yes is required to write, there is no "all", the backup is written before
 * the write (fake db), --expect skips a SKU edited since the review, and an
 * offline --live dry run works with no credentials.
 *
 * Every figure here is FAKE (public repo). Pure Node, no emulator.
 * Run: node tests/merge-catalog-costs-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'merge-catalog-costs.js');
const M = require(SCRIPT);

let passed = 0, failed = 0;
function ok(label, cond) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label); failed++; }
}
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── fake public catalogs ───────────────────────────────────────────────────
const PUBLIC = [
  { id: 'sku_a', pricing: { good: { sell: 100 }, better: { sell: 120 }, best: { sell: 140 } } },
  { id: 'sku_b', pricing: { good: { sell: 50 }, better: { sell: 60 }, best: { sell: 70 } } },
  { id: 'sku_c', pricing: { good: { sell: 10 }, better: { sell: 10 }, best: { sell: 10 } } },
];
const XACT_WIN = { NBD_XACT_CATALOG: { items: [
  { code: 'TST ONE', name: 'Test one', unit: 'EA', materialCost: 5, laborCost: 3 },
  { code: 'TST TWO', name: 'Test two', unit: 'LF', materialCost: 2, laborCost: 1 },
] } };

// ── a fake live book with every map the merge must leave alone ─────────────
const LIVE = {
  version: 1,
  defaults: { overheadMultiplier: 1.11, profitMarginPct: 11 },
  costs: {
    sku_a: { cost: { good: 40, better: 41, best: 42 }, labor: { perUnit: 9, crewSize: 2 } },
    sku_b: { cost: { good: 20, better: 21, best: 22 }, labor: { perUnit: 8 } },
    sku_c: { cost: { good: 4, better: 4, best: 4 } },
  },
  jtCosts: { jt_x: { materialCost: 7, laborCost: 7 } },
  laborOps: { op_x: { rate: 7, hoursPerUnit: 1, crewSize: 1 } },
  v2Costs: { 'shingle-good': { cost: 7, labor: 7 } },
  xactCosts: { 'TST ONE': { materialCost: 5, laborCost: 3 } },
};
const PROPOSAL = {
  version: 1,
  costs: {
    sku_a: { cost: { good: 45, better: 41, best: 999 }, labor: { perUnit: 1 } }, // best > sell → refused; labor ignored
    sku_b: { cost: { good: 25, better: 26, best: 27 } },                          // NOT approved
    sku_c: { cost: { good: 5, better: 5, best: 5 } },
  },
};

console.log('\nparseOnly / parseArgs');
{
  const rf = () => 'sku_a\n# a comment\nsku_c, sku_a\n';
  ok('comma list', JSON.stringify(M.parseOnly('sku_a, sku_c', rf)) === '["sku_a","sku_c"]');
  ok('a code with a space stays one entry', JSON.stringify(M.parseOnly('RFG SYN, TST ONE', rf)) === '["RFG SYN","TST ONE"]');
  ok('@file with comments, de-duplicated', JSON.stringify(M.parseOnly('@approved.txt', rf)) === '["sku_a","sku_c"]');
  ['all', 'ALL', '*', 'sku_a,all'].forEach((v) => {
    let threw = false;
    try { M.parseOnly(v, rf); } catch (e) { threw = e instanceof M.Fatal; }
    ok('"' + v + '" is refused (there is no all)', threw);
  });
  const fatal = (argv) => { try { M.parseArgs(argv); return false; } catch (e) { return e instanceof M.Fatal; } };
  ok('--only is required with --in', fatal(['--company', 'c1', '--in', 'p.json']));
  ok('--only-xact is required with --xact', fatal(['--company', 'c1', '--xact', 'x.json']));
  ok('--company --yes does not eat the flag', fatal(['--company', '--yes', '--in', 'p.json', '--only', 'a']));
  ok('--live is refused with --yes', fatal(['--company', 'c1', '--in', 'p.json', '--only', 'a', '--live', 'l.json', '--yes']));
  ok('unknown tier refused', fatal(['--company', 'c1', '--in', 'p.json', '--only', 'a', '--tiers', 'premium']));
  ok('--tiers subset parsed in canonical order',
    JSON.stringify(M.parseArgs(['--company', 'c1', '--in', 'p', '--only', 'a', '--tiers', 'best,good']).tierList) === '["good","best"]');
  ok('field path for a SKU tier', M.fieldPathFor('sku', 'sku_a', 'good').join('.') === 'costs.sku_a.cost.good');
  ok('field path for an xact code keeps the space in one segment',
    JSON.stringify(M.fieldPathFor('xact', 'TST ONE')) === '["xactCosts","TST ONE","materialCost"]');
}

console.log('\nplanSkuMerge — diff + validation');
{
  const rows = M.planSkuMerge({ proposal: PROPOSAL, live: LIVE, only: ['sku_a', 'sku_c'], publicCatalog: PUBLIC });
  const st = (k, t) => (rows.find((r) => r.key === k && r.field === t) || {}).status;
  ok('changed tier → write', st('sku_a', 'good') === 'write');
  ok('equal tier → same', st('sku_a', 'better') === 'same');
  ok('cost above sell → refused', st('sku_a', 'best') === 'refused');
  ok('refusal reason names sell < cost', /sell 140 < cost 999/.test(rows.find((r) => r.key === 'sku_a' && r.field === 'best').reason));
  ok('unapproved SKU is not planned at all', !rows.some((r) => r.key === 'sku_b'));
  const writes = M.buildWrites(rows);
  ok('refused tier is not in the writes', !writes.some((w) => w.segments.join('.') === 'costs.sku_a.cost.best'));
  ok('writes are field paths under costs.<id>.cost only', writes.every((w) => w.segments[0] === 'costs' && w.segments[2] === 'cost' && w.segments.length === 4));

  const after = M.applyWritesToObject(LIVE, writes);
  ok('labor of a written SKU untouched', JSON.stringify(after.costs.sku_a.labor) === JSON.stringify(LIVE.costs.sku_a.labor));
  ['defaults', 'jtCosts', 'laborOps', 'v2Costs', 'xactCosts'].forEach((k) =>
    ok(k + ' untouched', JSON.stringify(after[k]) === JSON.stringify(LIVE[k])));
  ok('unapproved SKU untouched', JSON.stringify(after.costs.sku_b) === JSON.stringify(LIVE.costs.sku_b));
  ok('refused tier keeps the live value', after.costs.sku_a.cost.best === 42);
  ok('approved tiers changed', after.costs.sku_a.cost.good === 45 && after.costs.sku_c.cost.best === 5);

  const sub = M.planSkuMerge({ proposal: PROPOSAL, live: LIVE, only: ['sku_c'], tiers: ['good'], publicCatalog: PUBLIC });
  ok('--tiers good plans only the good tier', sub.length === 1 && sub[0].field === 'good');

  const zero = M.planSkuMerge({ proposal: { costs: { sku_c: { cost: { good: 0 } } } }, live: LIVE, only: ['sku_c'], tiers: ['good'], publicCatalog: PUBLIC });
  ok('cost 0 refused (cost must be > 0)', zero[0].status === 'refused');
  const ghost = M.planSkuMerge({ proposal: { costs: { sku_z: { cost: { good: 1 } } } }, live: { costs: { sku_z: { cost: { good: 2 } } } }, only: ['sku_z'], tiers: ['good'], publicCatalog: PUBLIC });
  ok('SKU missing from the public catalog refused', ghost[0].status === 'refused');
  const nolive = M.planSkuMerge({ proposal: PROPOSAL, live: { costs: {} }, only: ['sku_a'], publicCatalog: PUBLIC });
  ok('SKU with no live entry skipped', nolive.length === 1 && nolive[0].status === 'skipped');

  const expect = clone(LIVE); expect.costs.sku_a.cost.good = 39;   // someone edited sku_a after the review
  const ex = M.planSkuMerge({ proposal: PROPOSAL, live: LIVE, only: ['sku_a', 'sku_c'], publicCatalog: PUBLIC, expect });
  ok('--expect: SKU changed since the snapshot is skipped', ex.filter((r) => r.key === 'sku_a').every((r) => r.status === 'skipped'));
  ok('--expect: unchanged SKU still planned', ex.some((r) => r.key === 'sku_c' && r.status === 'write'));
}

console.log('\nplanXactMerge');
{
  const prop = { xactCosts: { 'TST ONE': { materialCost: 4 }, 'TST TWO': { materialCost: 1 }, 'TST NOPE': { materialCost: 1 }, 'TST NEG': { materialCost: -1 } } };
  const rows = M.planXactMerge({ proposal: prop, live: LIVE, only: ['TST ONE', 'TST TWO', 'TST NOPE'], xactWin: XACT_WIN });
  const st = (k) => (rows.find((r) => r.key === k) || {}).status;
  ok('approved code with a live entry → write', st('TST ONE') === 'write');
  ok('code with no live entry → skipped (laborCost unknown)', st('TST TWO') === 'skipped');
  ok('code not in the public catalog → refused', st('TST NOPE') === 'refused');
  const neg = M.planXactMerge({ proposal: { xactCosts: { 'TST ONE': { materialCost: -1 } } }, live: LIVE, only: ['TST ONE'], xactWin: XACT_WIN });
  ok('negative materialCost → refused', neg[0].status === 'refused');
  const after = M.applyWritesToObject(LIVE, M.buildWrites(rows));
  ok('xact write keeps laborCost', after.xactCosts['TST ONE'].laborCost === 3 && after.xactCosts['TST ONE'].materialCost === 4);
  ok('xact write leaves costs untouched', JSON.stringify(after.costs) === JSON.stringify(LIVE.costs));
}

// ── run() with a fake db ───────────────────────────────────────────────────
function fakeDeps(files, events, opts) {
  const doc = clone(LIVE);
  const exists = !(opts && opts.missing);
  const updates = [];
  class FakeFieldPath { constructor(...s) { this.segments = s; } }
  const db = {
    doc(p) {
      events.push('doc:' + p);
      return {
        async get() { events.push('read'); return exists ? { exists: true, data: () => clone(doc), updateTime: 'T-READ' } : { exists: false, data: () => undefined }; },
        async update(...args) { events.push('update'); updates.push(args); },
      };
    },
  };
  return {
    updates,
    deps: {
      db, FieldPath: FakeFieldPath, publicCatalog: PUBLIC, xactWin: XACT_WIN,
      now: () => new Date('2026-11-09T12:00:00Z'),
      log() {}, err() {},
      readFile: (p) => { if (!(p in files)) throw new Error('ENOENT ' + p); return files[p]; },
      writeFile: (p, s) => { events.push('backup:' + path.basename(p)); files['__backup__'] = s; },
      mkdir() {},
    },
  };
}

(async () => {
  console.log('\nrun() — fake db');
  const files = { 'p.json': JSON.stringify(PROPOSAL), 'x.json': JSON.stringify({ xactCosts: { 'TST ONE': { materialCost: 4 } } }) };
  const base = ['--company', 'co_test', '--in', 'p.json', '--only', 'sku_a,sku_c', '--xact', 'x.json', '--only-xact', 'TST ONE'];

  {
    const events = [];
    const f = fakeDeps(files, events);
    const code = await M.run(base, f.deps);
    ok('dry run (no --yes) never calls update', f.updates.length === 0 && !events.includes('update'));
    ok('dry run exits 1 because a tier was refused', code === 1);
    ok('dry run still writes a backup of the live doc', events.some((e) => e.startsWith('backup:')));
  }
  {
    const events = [];
    const f = fakeDeps(files, events);
    const code = await M.run(base.concat(['--yes']), f.deps);
    ok('--yes writes exactly once', f.updates.length === 1);
    const bi = events.findIndex((e) => e.startsWith('backup:'));
    ok('backup written BEFORE the update', bi >= 0 && bi < events.indexOf('update'));
    ok('backup file is timestamped and named for the tenant', events[bi] === 'backup:catalogCosts-co_test-2026-11-09T12-00-00-000Z.backup.json');
    ok('backup holds the live doc', JSON.parse(files.__backup__).costs.sku_a.cost.good === 40);
    const args = f.updates[0];
    const pre = args[args.length - 1];
    ok('update carries a lastUpdateTime precondition from the read', pre && pre.lastUpdateTime === 'T-READ');
    const pairs = [];
    for (let i = 0; i + 1 < args.length; i += 2) pairs.push([args[i].segments.join('.'), args[i + 1]]);
    const paths = pairs.map((p) => p[0]).sort();
    ok('only the approved, valid field paths are written',
      JSON.stringify(paths) === JSON.stringify(['costs.sku_a.cost.good', 'costs.sku_c.cost.best', 'costs.sku_c.cost.better', 'costs.sku_c.cost.good', 'xactCosts.TST ONE.materialCost']));
    ok('refused tier (sku_a best) never written', !paths.includes('costs.sku_a.cost.best'));
    ok('write exits 1 (a tier was refused) but wrote the rest', code === 1);
  }
  {
    const events = [];
    const f = fakeDeps(files, events);
    const code = await M.run(['--company', 'co_test', '--in', 'p.json', '--only', 'all', '--yes'], f.deps);
    ok('--only all is fatal (exit 2) and reads nothing', code === 2 && events.length === 0);
  }
  {
    // No catalogCosts/{companyId} doc at all: this tool only merges into an
    // existing book. Even with --yes it backs nothing up, writes nothing, and
    // points at the importer.
    const events = [];
    const errs = [];
    const own = clone(files); delete own.__backup__;
    const f = fakeDeps(own, events, { missing: true });
    f.deps.err = (s) => errs.push(s);
    const code = await M.run(base.concat(['--yes']), f.deps);
    ok('missing book: exits 2', code === 2);
    ok('missing book: never calls update', f.updates.length === 0 && !events.includes('update'));
    ok('missing book: writes no backup', !events.some((e) => e.startsWith('backup:')) && !('__backup__' in own));
    ok('missing book: message points at import-catalog-costs.js', errs.some((s) => /does not exist/.test(s) && /import-catalog-costs\.js/.test(s)));
  }

  console.log('\nCLI — offline --live dry run, no credentials');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-cc-'));
    const prop = path.join(dir, 'p.json');
    const live = path.join(dir, 'live.json');
    // Real public SKU id, FAKE costs (well under its public sell).
    fs.writeFileSync(prop, JSON.stringify({ version: 1, costs: { shingle_001: { cost: { good: 11, better: 12, best: 13 } } } }));
    fs.writeFileSync(live, JSON.stringify({ version: 1, costs: { shingle_001: { cost: { good: 10, better: 12, best: 14 }, labor: { perUnit: 1 } } } }));
    const env = Object.assign({}, process.env);
    delete env.GOOGLE_APPLICATION_CREDENTIALS;
    delete env.FIRESTORE_EMULATOR_HOST;
    let out = ''; let code = 0;
    try {
      out = execFileSync(process.execPath, ['-e',
        // fail loudly if anything tries to load firebase-admin
        "const M=require('module');const o=M._load;M._load=function(r){if(/firebase-admin|_admin/.test(r))throw new Error('ADMIN LOADED '+r);return o.apply(this,arguments)};" +
        'process.argv=[process.argv[0],' + JSON.stringify(SCRIPT) + '].concat(' + JSON.stringify(['--company', 'co_test', '--in', prop, '--only', 'shingle_001', '--live', live]) + ');' +
        'require(' + JSON.stringify(SCRIPT) + ').run(process.argv.slice(2)).then(c=>process.exit(c));',
      ], { env, encoding: 'utf8', cwd: ROOT });
    } catch (e) { code = e.status; out = String(e.stdout || '') + String(e.stderr || ''); }
    ok('offline dry run exits 0', code === 0);
    ok('offline dry run never loads firebase-admin', !/ADMIN LOADED/.test(out));
    ok('prints the diff for the changed tiers', /costs\.shingle_001\.cost\.good/.test(out) && /costs\.shingle_001\.cost\.best/.test(out));
    ok('says DRY RUN', /DRY RUN/.test(out));
    ok('writes no backup for an offline file', !/backup\s+:/.test(out));

    let code2 = 0;
    try { execFileSync(process.execPath, [SCRIPT, '--company', 'co_test', '--in', prop, '--only', 'shingle_001', '--live', live, '--yes'], { env, stdio: 'pipe', cwd: ROOT }); }
    catch (e) { code2 = e.status; }
    ok('--live with --yes is fatal (exit 2)', code2 === 2);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nrepo hygiene');
  {
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    ok('.local/ (where backups land) is gitignored', /^\.local\/$/m.test(gi));
    const src = fs.readFileSync(SCRIPT, 'utf8');
    ok('header says Jo runs the write', /Jo runs the write/.test(src));
    ok('firebase-admin is required only inside loadAdmin()', (src.match(/require\('\.\/_admin'\)/g) || []).length === 1 && /function loadAdmin\(\)\s*\{\s*const \{[^}]*\} = require\('\.\/_admin'\)/.test(src));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
