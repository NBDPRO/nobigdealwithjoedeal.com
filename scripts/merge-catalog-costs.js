#!/usr/bin/env node
/**
 * scripts/merge-catalog-costs.js — merge ONLY the approved cost tiers of named
 * SKUs (and, optionally, the material cost of named xactimate codes) into ONE
 * company's existing cost book at catalogCosts/{companyId}.
 *
 * WHY THIS EXISTS. scripts/import-catalog-costs.js was the 2026-07-30 cutover
 * tool: it writes a whole `costs` map and refuses a tenant that already has a
 * book, because --force would overwrite every SKU edited in the Product
 * Library since. A reviewed supplier-pricing proposal needs the opposite
 * shape: change a short, named list of tiers and leave everything else in the
 * book exactly as the tenant left it.
 *
 * So this writes BY FIELD PATH — costs.<id>.cost.good|better|best and
 * xactCosts.<code>.materialCost — and nothing else. It never touches labor,
 * laborOps, jtCosts, v2Costs, defaults, an unnamed SKU, or an unnamed tier of
 * a named SKU.
 *
 * ⚠ THIS WRITES TO PROD FIRESTORE. Jo runs the write (Claude does not write
 *   prod). Auth: GOOGLE_APPLICATION_CREDENTIALS env var (same as the importer).
 *
 * Run:
 *   # offline review, no credentials: diff a proposal against an exported doc
 *   node scripts/merge-catalog-costs.js --company <companyId> --in <proposal.json> \
 *        --only shingle_001,under_001 --live <exported-doc.json>
 *   # dry run against the live doc (reads Firestore, writes a backup to .local/)
 *   node scripts/merge-catalog-costs.js --company <companyId> --in <proposal.json> --only @approved.txt
 *   # the write
 *   node scripts/merge-catalog-costs.js --company <companyId> --in <proposal.json> --only @approved.txt --yes
 *
 * Flags:
 *   --company <id>     the tenant (companyId claim, or the owner uid for a solo operator)
 *   --in <file>        proposal in the importer shape: { version, costs: { <id>: { cost: {good,better,best} } } }
 *   --only <list>      REQUIRED with --in: comma list, or @file (one per line or comma-separated, # comments).
 *                      Not split on spaces: xactimate codes contain them ('RFG SYN').
 *                      There is no "all": every SKU written is one somebody named.
 *   --tiers <list>     optional subset of good,better,best (default all three)
 *   --xact <file>      xactimate proposal: { xactCosts: { "<code>": { materialCost } } } (or the bare map)
 *   --only-xact <list> REQUIRED with --xact; same syntax as --only
 *   --expect <file>    optional earlier snapshot of the doc (e.g. a backup this script wrote, or the
 *                      --live export you reviewed). A SKU or code whose live value differs from it is
 *                      SKIPPED, so an edit made in the Product Library after the review is never reverted.
 *   --live <file>      read the "live" doc from a JSON file instead of Firestore. Dry run only: it needs
 *                      no credentials and never loads firebase-admin. Refused with --yes.
 *   --yes              write. Without it this is a dry run.
 *
 * Every new tier is validated with functions/catalog-cost-logic.js against the
 * working-tree PUBLIC catalog (cost > 0, sell >= cost). A tier that fails is
 * REFUSED and reported, and never written; the other approved tiers still are.
 * The sell side is the public catalog only (docs/pro/js/product-data.js and
 * roofivent-catalog.js); a tenant's own sell price is not consulted.
 * Xactimate codes are validated with functions/cost-basis-registry.js (the
 * code is a live catalog line, materialCost is a finite number >= 0). A SKU or
 * code with no entry in the live book is skipped: a lone materialCost without
 * its laborCost is ignored by the client (catalog-costs.js xactCost()), and a
 * brand-new SKU entry belongs in the Product Library.
 *
 * Before any write the live doc is saved to .local/ (gitignored) as a
 * timestamped JSON backup, and the update carries a lastUpdateTime
 * precondition, so a doc that changed between the read and the write fails
 * the update instead of being merged over.
 *
 * Exit codes: 0 = ok, 1 = a tier/code was refused, or a named SKU/code was
 * skipped (not in the proposal, no live entry, or changed since --expect), so
 * a typo'd id in the approved list never reads as a clean run; the rest were
 * still planned / written. A single tier the proposal leaves blank is skipped
 * without raising the code. 2 = fatal (nothing written).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { TIERS, validateCostOverlay } = require(path.join(ROOT, 'functions', 'catalog-cost-logic.js'));
const REG = require(path.join(ROOT, 'functions', 'cost-basis-registry.js'));

const COLLECTION = 'catalogCosts';

class Fatal extends Error {}

// ── argument parsing (pure) ────────────────────────────────────────────────

// A following FLAG is not a value: `--company --yes` must not write to
// catalogCosts/--yes (the bug the importer's arg() guards against).
function parseArgs(argv) {
  const takes = ['--company', '--in', '--only', '--tiers', '--xact', '--only-xact', '--expect', '--live', '--backup-dir'];
  const out = { yes: argv.includes('--yes') };
  takes.forEach((name) => {
    const i = argv.indexOf(name);
    if (i < 0) return;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Fatal(name + ' requires a value (got ' + (v ? v : 'nothing') + ').');
    out[name.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = v;
  });
  if (!out.company) throw new Fatal('--company <companyId> is required.');
  if (!/^[A-Za-z0-9_-]{1,1500}$/.test(out.company)) throw new Fatal('--company "' + out.company + '" is not a plausible companyId.');
  if (!out.in && !out.xact) throw new Fatal('nothing to merge: pass --in <proposal> and/or --xact <proposal>.');
  if (out.in && !out.only) throw new Fatal('--only <ids|@file> is required with --in. There is no "all".');
  if (out.xact && !out.onlyXact) throw new Fatal('--only-xact <codes|@file> is required with --xact. There is no "all".');
  if (!out.in && out.only) throw new Fatal('--only without --in.');
  if (!out.xact && out.onlyXact) throw new Fatal('--only-xact without --xact.');
  if (out.live && out.yes) throw new Fatal('--live is for offline review; a write must read the live doc. Drop --live.');
  out.tierList = parseTiers(out.tiers);
  return out;
}

function parseTiers(raw) {
  if (raw == null) return TIERS.slice();
  const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Fatal('--tiers is empty.');
  list.forEach((t) => { if (!TIERS.includes(t)) throw new Fatal('--tiers: unknown tier "' + t + '" (expected ' + TIERS.join(',') + ').'); });
  return TIERS.filter((t) => list.includes(t));
}

/**
 * `--only a,b` or `--only @file`. Returns a de-duplicated list in order.
 * Refuses "all" / "*" outright: an approved list is a list.
 */
function parseOnly(raw, readFile, flag) {
  flag = flag || '--only';
  let text = String(raw == null ? '' : raw);
  if (text.startsWith('@')) {
    const file = text.slice(1);
    try { text = readFile(file); } catch (e) { throw new Fatal(flag + ': cannot read ' + file + ' (' + e.message + ').'); }
    text = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, '')).join('\n');
  }
  const ids = [];
  text.split(/[,\r\n]+/).map((s) => s.trim()).filter(Boolean).forEach((id) => { if (!ids.includes(id)) ids.push(id); });
  if (!ids.length) throw new Fatal(flag + ' names nothing.');
  ids.forEach((id) => {
    if (/^(all|\*)$/i.test(id)) throw new Fatal(flag + ' "' + id + '": there is no "all". Name every SKU/code you approved.');
  });
  return ids;
}

/** The Firestore field-path segments for one change. */
function fieldPathFor(kind, key, tier) {
  if (kind === 'sku') return ['costs', key, 'cost', tier];
  if (kind === 'xact') return ['xactCosts', key, 'materialCost'];
  throw new Error('unknown kind ' + kind);
}

function isNum(n) { return typeof n === 'number' && Number.isFinite(n); }
function dig(obj, segs) { return segs.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj); }

// ── planning (pure) ────────────────────────────────────────────────────────

/**
 * One row per (SKU, tier) the caller approved:
 *   status 'write'   — differs from live and passed validation
 *   status 'same'    — proposal equals live; nothing to do
 *   status 'refused' — failed validation (never written)
 *   status 'skipped' — no proposal value, no live entry, or live changed since --expect
 */
function planSkuMerge({ proposal, live, only, tiers, publicCatalog, expect }) {
  const rows = [];
  const pCosts = (proposal && proposal.costs) || {};
  const lCosts = (live && live.costs) || {};
  const tierList = tiers || TIERS;
  only.forEach((id) => {
    const row = (t, extra) => Object.assign({ kind: 'sku', key: id, field: t, path: fieldPathFor('sku', id, t) }, extra);
    const pEntry = pCosts[id];
    if (!pEntry || !pEntry.cost) { rows.push(row('*', { status: 'skipped', reason: 'not in the proposal' })); return; }
    const lEntry = lCosts[id];
    if (!lEntry || typeof lEntry !== 'object') {
      rows.push(row('*', { status: 'skipped', reason: 'no live entry in the book (add it in the Product Library)' }));
      return;
    }
    if (expect) {
      const eEntry = expect.costs && expect.costs[id];
      const moved = tierList.filter((t) => dig(eEntry, ['cost', t]) !== dig(lEntry, ['cost', t]));
      if (moved.length) {
        rows.push(row('*', { status: 'skipped', reason: 'live changed since --expect snapshot (' + moved.join(',') + ')' }));
        return;
      }
    }
    tierList.forEach((t) => {
      const to = pEntry.cost[t];
      const from = dig(lEntry, ['cost', t]);
      if (to === undefined || to === null) { rows.push(row(t, { from, status: 'skipped', reason: 'no proposed value' })); return; }
      if (to === from) { rows.push(row(t, { from, to, status: 'same' })); return; }
      const reasons = validateSkuTier(id, t, to, publicCatalog);
      if (reasons.length) rows.push(row(t, { from, to, status: 'refused', reason: reasons.join('; ') }));
      else rows.push(row(t, { from, to, status: 'write' }));
    });
  });
  return rows;
}

/** catalog-cost-logic's rules for ONE tier: cost > 0 (or >= 0 for the named zero-cost SKUs), sell >= cost. */
function validateSkuTier(id, tier, value, publicCatalog) {
  const overlay = { version: 1, costs: { [id]: { cost: { [tier]: value } } } };
  const { errors, warnings } = validateCostOverlay(overlay, publicCatalog || [], { requireComplete: false });
  const prefix = id + ':' + tier + ':';
  const out = errors.filter((e) => e.startsWith(prefix)).map((e) => e.slice(prefix.length).trim());
  warnings.filter((w) => w.startsWith(id + ':')).forEach((w) => out.push(w.slice(id.length + 1).trim()));
  return out;
}

/** The xactimate twin: one row per approved code, materialCost only. */
function planXactMerge({ proposal, live, only, xactWin, expect }) {
  const rows = [];
  const pMap = (proposal && (proposal.xactCosts || proposal)) || {};
  const lMap = (live && live.xactCosts) || {};
  const catalog = REG.get('xact');
  const known = new Set(catalog.entries(xactWin || {}).map((e) => e.key));
  only.forEach((code) => {
    const row = (extra) => Object.assign({ kind: 'xact', key: code, field: 'materialCost', path: fieldPathFor('xact', code) }, extra);
    const p = pMap[code];
    const to = p && typeof p === 'object' ? p.materialCost : undefined;
    if (to === undefined || to === null) { rows.push(row({ status: 'skipped', reason: 'not in the proposal' })); return; }
    if (!known.has(code)) { rows.push(row({ to, status: 'refused', reason: 'not a line in the public xactimate catalog' })); return; }
    const l = lMap[code];
    if (!l || typeof l !== 'object') {
      rows.push(row({ to, status: 'skipped', reason: 'no live xactCosts entry (its laborCost is unknown; the client ignores a lone materialCost)' }));
      return;
    }
    const from = l.materialCost;
    if (expect) {
      const e = expect.xactCosts && expect.xactCosts[code];
      if (dig(e, ['materialCost']) !== from) { rows.push(row({ from, to, status: 'skipped', reason: 'live changed since --expect snapshot' })); return; }
    }
    if (to === from) { rows.push(row({ from, to, status: 'same' })); return; }
    const seed = { version: REG.SEED_VERSION, catalog: 'xact', xactCosts: { [code]: { materialCost: to, laborCost: l.laborCost } } };
    const { errors, warnings } = REG.validateSeed(catalog, seed, xactWin);
    const reasons = errors.concat(warnings);
    if (reasons.length) rows.push(row({ from, to, status: 'refused', reason: reasons.join('; ') }));
    else rows.push(row({ from, to, status: 'write' }));
  });
  return rows;
}

/**
 * 1 when any row needs a human: a refusal, or a whole SKU/code skipped (typo,
 * no live entry, --expect conflict). A per-tier skip (the proposal left that
 * tier blank) is not one: --tiers exists to name a subset.
 */
function exitCodeFor(rows) {
  const flagged = rows.some((r) => r.status === 'refused' ||
    (r.status === 'skipped' && !(r.kind === 'sku' && r.field !== '*')));
  return flagged ? 1 : 0;
}

/** Only 'write' rows become writes. */
function buildWrites(rows) {
  return rows.filter((r) => r.status === 'write').map((r) => ({ segments: r.path, value: r.to }));
}

/** Apply `writes` to a plain object (what the doc looks like after the update). Pure. */
function applyWritesToObject(doc, writes) {
  const out = JSON.parse(JSON.stringify(doc || {}));
  writes.forEach((w) => {
    let o = out;
    w.segments.slice(0, -1).forEach((k) => { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; });
    o[w.segments[w.segments.length - 1]] = w.value;
  });
  return out;
}

function fmt(v) { return v === undefined ? '—' : JSON.stringify(v); }

function formatTable(rows) {
  const head = ['status', 'field path', 'live', 'proposed', 'note'];
  const body = rows.map((r) => [r.status, r.field === '*' ? r.path.slice(0, 2).join('.') : r.path.join('.'), fmt(r.from), fmt(r.to), r.reason || '']);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => String(b[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  return [line(head), line(w.map((n) => '-'.repeat(n)))].concat(body.map(line)).join('\n');
}

// ── catalogs (working tree, sandboxed) ─────────────────────────────────────

function loadPublicCatalog() {
  const win = {};
  win.window = win;
  const sandbox = { window: win, Date, Math, JSON, Set, Object, console: { log() {} } };
  ['product-data.js', 'roofivent-catalog.js'].forEach((f) => {
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', f), 'utf8'), sandbox, { filename: f });
  });
  return win.NBD_PRODUCTS || [];
}

function loadXactWindow() {
  const win = {};
  win.window = win;
  const sandbox = {
    window: win,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      addEventListener() {}, removeEventListener() {},
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {}, setAttribute() {} }),
      body: { appendChild() {} },
    },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    navigator: {},
    Date, Math, JSON, Set, Map, Object, isFinite, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.createContext(sandbox);
  REG.get('xact').files.forEach((rel) => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs', rel), 'utf8'), sandbox, { filename: path.basename(rel) });
  });
  return win;
}

// firebase-admin is loaded ONLY when the live doc is read from Firestore, so
// an offline --live review needs no credentials and no admin install.
function loadAdmin() {
  if (process.env.NBD_ACCESS_TOKEN) {
    // Token mode: Firestore REST with a short-lived access token (scripts/_firestore-rest.js).
    const R = require('./_firestore-rest');
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'nobigdeal-pro';
    return { db: R.restFirestore({ projectId, token: process.env.NBD_ACCESS_TOKEN }), FieldPath: R.FieldPath };
  }
  const { initAdmin, getFirestore, FieldPath } = require('./_admin');
  initAdmin();
  return { db: getFirestore(), FieldPath };
}

// ── run ────────────────────────────────────────────────────────────────────

/**
 * deps (all optional, for tests): db, FieldPath, publicCatalog, xactWin, now,
 * log, err, readFile, writeFile, mkdir. Returns the exit code.
 */
async function run(argv, deps) {
  deps = deps || {};
  const log = deps.log || ((s) => console.log(s));
  const err = deps.err || ((s) => console.error(s));
  const readFile = deps.readFile || ((p) => fs.readFileSync(path.resolve(ROOT, p), 'utf8'));
  const writeFile = deps.writeFile || ((p, s) => fs.writeFileSync(p, s));
  const mkdir = deps.mkdir || ((p) => fs.mkdirSync(p, { recursive: true }));
  const readJson = (p, flag) => {
    try { return JSON.parse(readFile(p)); } catch (e) { throw new Fatal(flag + ': cannot read/parse ' + p + ' (' + e.message + ').'); }
  };

  try {
    const a = parseArgs(argv);
    const only = a.in ? parseOnly(a.only, readFile, '--only') : [];
    const onlyXact = a.xact ? parseOnly(a.onlyXact, readFile, '--only-xact') : [];
    const proposal = a.in ? readJson(a.in, '--in') : null;
    const xactProposal = a.xact ? readJson(a.xact, '--xact') : null;
    const expect = a.expect ? readJson(a.expect, '--expect') : null;
    if (proposal && (!proposal.costs || typeof proposal.costs !== 'object')) throw new Fatal('--in has no costs map (expected the importer shape).');

    const target = COLLECTION + '/' + a.company;
    log('target          : ' + target);
    log('mode            : ' + (a.yes ? 'WRITE (--yes)' : 'dry run'));

    // ── the live doc ──
    let live; let ref = null; let snap = null; let FieldPath = deps.FieldPath;
    if (a.live) {
      live = readJson(a.live, '--live');
      log('live doc        : ' + a.live + ' (offline file; no Firestore read)');
    } else {
      let db = deps.db;
      if (!db) { const adm = loadAdmin(); db = adm.db; FieldPath = FieldPath || adm.FieldPath; }
      ref = db.doc(target);
      snap = await ref.get();
      if (!snap.exists) throw new Fatal(target + ' does not exist. This merges into an existing book; a first book is scripts/import-catalog-costs.js.');
      live = snap.data();
      const stamp = (deps.now ? deps.now() : new Date()).toISOString().replace(/[:.]/g, '-');
      const dir = path.resolve(ROOT, a.backupDir || '.local');
      mkdir(dir);
      const backup = path.join(dir, 'catalogCosts-' + a.company + '-' + stamp + '.backup.json');
      writeFile(backup, JSON.stringify(live, null, 2));
      log('backup          : ' + backup);
    }

    // ── plan ──
    const publicCatalog = a.in ? (deps.publicCatalog || loadPublicCatalog()) : [];
    const xactWin = a.xact ? (deps.xactWin || loadXactWindow()) : null;
    const rows = []
      .concat(a.in ? planSkuMerge({ proposal, live, only, tiers: a.tierList, publicCatalog, expect }) : [])
      .concat(a.xact ? planXactMerge({ proposal: xactProposal, live, only: onlyXact, xactWin, expect }) : []);
    const writes = buildWrites(rows);
    const count = (s) => rows.filter((r) => r.status === s).length;

    log('');
    log(formatTable(rows));
    log('');
    log('to write ' + count('write') + ' · unchanged ' + count('same') + ' · refused ' + count('refused') + ' · skipped ' + count('skipped'));
    const code = exitCodeFor(rows);

    if (!a.yes) {
      log('\nDRY RUN — no write. Re-run with --yes to write the ' + count('write') + ' field(s) above.');
      return code;
    }
    if (!writes.length) { log('\nNothing to write.'); return code; }
    if (!FieldPath) throw new Fatal('no FieldPath implementation available.');

    // ── write: field paths only, guarded by the read's update time ──
    const args = [];
    writes.forEach((w) => { args.push(new FieldPath(...w.segments), w.value); });
    if (snap && snap.updateTime) args.push({ lastUpdateTime: snap.updateTime });
    await ref.update(...args);
    log('\nWrote ' + writes.length + ' field(s) to ' + target + '. Nothing else in the book was touched.');
    return code;
  } catch (e) {
    if (e instanceof Fatal) { err('FATAL: ' + e.message); return 2; }
    err('FATAL: ' + (e && e.message ? e.message : String(e)));
    return 2;
  }
}

module.exports = {
  Fatal,
  parseArgs,
  parseTiers,
  parseOnly,
  fieldPathFor,
  planSkuMerge,
  planXactMerge,
  validateSkuTier,
  exitCodeFor,
  buildWrites,
  applyWritesToObject,
  formatTable,
  run,
};

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
