/**
 * scripts/audit-orphaned-lead-subtrees.js
 *
 * Counts what is left behind by hard-deleted leads, and (only when told to)
 * sweeps it the way onLeadDeleted now does.
 *
 * WHY THIS EXISTS (2026-09-25)
 * ────────────────────────────
 * Every rule under leads/{leadId}/... decides "owner" by reading the parent
 * lead, and the lead create rule cannot know an id was used before. So any
 * row left under a hard-deleted lead belongs to whoever creates a lead at
 * that id next, from any tenant. Until 2026-09-25 onLeadDeleted swept only
 * `documents` (later also `warrantyClaims`); every other subcollection of
 * every lead hard-deleted before then is still there. The trigger now sweeps
 * the whole subtree (functions/lead-subtree-sweep.js), but only for deletes
 * from now on. This finds the backlog.
 * See documentation/audit/LEAD-SUBTREE-HIJACK-2026-09-25.md.
 *
 * UPDATE 2026-09-25 (review of PR #1777): the perimeter was too small.
 * TOP-LEVEL docs that name a lead by a `leadId` field count too: /notes (its
 * read rule reads the lead the note names, so a re-creator reads them),
 * /photos (read by a company reader of the named lead), the token
 * collections and /appointments (the trigger deletes those). Estimates,
 * invoices and e-sign envelopes are counted as well: nothing deletes them
 * (financial and executed-contract records), and since the same review the
 * portal only shows the token's own tenant's (functions/portal-authz.js), so
 * they are reported, not swept. Before, top-level notes of a deleted lead
 * were counted as "elsewhere" and the production figure understated what a
 * re-creator could reach.
 *
 * WHAT IT PRINTS: COUNTS ONLY
 * ───────────────────────────
 * The repo is public and this output gets pasted into notes and PRs. No lead
 * id, uid, name, address or path is ever printed, only numbers and
 * collection names (which come from code, not from users). --verbose adds
 * error messages, which can contain paths; do not paste those.
 *
 * HOW
 * ───
 * Subtree: for each known lead subcollection name (the union of a fixed list
 * and the `match /leads/{leadId}` children in firestore.rules), a
 * collectionGroup query with select() (no fields) pages every row. Rows whose
 * path is leads/{id}/... are grouped by id. Top-level: each collection above
 * is paged with select('leadId'). Every lead id seen is checked with a getAll
 * that asks for no fields; an absent lead makes its rows and docs orphans.
 * Rows under the retired leads/{uid}/leads/... tree are counted apart and
 * never touched. For each orphaned lead id, listCollections() reports
 * subcollections with names this script does not know, so a new one cannot
 * hide. A reserved id (`d2d`, `_variants`, ...; isReservedLeadId) is counted
 * apart and never swept: `leads/d2d/recordings` holds many users' rows.
 *
 * --delete (NOT run by the author; production deletes need Jo's explicit OK)
 * ──────────────────────────────────────────────────────────────────────────
 * For each orphaned, non-reserved lead id: read the lead again (skip it if it
 * exists now), then run the trigger's own code: sweepLeadSubtree() (each
 * row's Storage objects before the row, the same segment-exact confinement,
 * rows newer than this run's start kept) and sweepLeadKeyedDocs() for
 * /notes, the token collections and /appointments. /photos docs are NOT
 * swept here: their objects can only be confined to the lead's owner uid,
 * which an absent lead no longer tells us (see
 * scripts/sweep-orphan-lead-artifacts.js, which walks the bucket). Requires
 * --yes.
 *
 * SAFETY
 *   • --project is required. There is no default, so a run can only ever hit
 *     the project it names, and the target (EMULATOR or PRODUCTION) is
 *     printed before anything is read.
 *   • Production: the Application Default Credentials' project must be the
 *     same --project (checked, not assumed).
 *   • Emulator: a project id from .firebaserc is refused. The shared local
 *     emulator runs one under that name, and other sessions' data lives there.
 *   • FIRESTORE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST: both or
 *     neither, or the Storage half of a run reaches the other target.
 *   • --delete: the bucket must exist before anything is deleted (a wrong
 *     --bucket would 404 every object delete, and ignoreNotFound would call
 *     that success and then delete the row that pointed at it).
 *   • Read-only unless --delete --yes.
 *   • A lead read that fails is never treated as "lead absent".
 *
 * SETUP (production): Application Default Credentials, and
 * FIRESTORE_EMULATOR_HOST unset. firebase-admin comes from scripts/_admin.js.
 *
 * RUN
 *   node scripts/audit-orphaned-lead-subtrees.js --project nobigdeal-pro
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199 \
 *     node scripts/audit-orphaned-lead-subtrees.js --project demo-x
 *   node scripts/audit-orphaned-lead-subtrees.js --project <id> --delete --yes [--bucket <name>]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}
const PROJECT = argValue('--project');
const DELETE = args.includes('--delete');
const YES = args.includes('--yes');
const VERBOSE = args.includes('--verbose');
const PAGE = 1000;

// Every subcollection the app writes under leads/{leadId} as of 2026-09-25
// (grep of docs/pro/js, functions/ and firestore.rules). Unioned with what
// firestore.rules declares at run time, so a new rule block is picked up.
const KNOWN_SUBCOLLECTIONS = [
  'activity', 'ai_drafts', 'documents', 'drawings', 'notes', 'portal_messages',
  'recordings', 'signatures', 'storm_proofs', 'tasks', 'warrantyClaims',
];

// Top-level collections whose docs name a lead by `leadId` (2026-09-25).
//   sweep: what --delete removes for an orphaned id (the trigger does too).
const TOP_LEVEL = [
  { name: 'notes', sweep: true, note: 'read rule reads the named lead: a re-creator reads these' },
  { name: 'photos', sweep: false, note: 'company readers of the named lead read these; objects need the owner uid' },
  { name: 'portal_tokens', sweep: true, alwaysStrict: true, note: 'a live homeowner link' },
  { name: 'doc_sign_tokens', sweep: true, alwaysStrict: true, note: 'a live signing link' },
  { name: 'appointments', sweep: true, note: 'owner-read only' },
  { name: 'estimates', sweep: false, note: 'kept (financial); portal scoped to tenant' },
  { name: 'invoices', sweep: false, note: 'kept (financial); portal scoped to tenant' },
  { name: 'esign_envelopes', sweep: false, note: 'kept (executed contracts); portal scoped to tenant' },
];

function subcollectionsFromRules() {
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
    const start = src.indexOf('match /leads/{leadId} {');
    if (start < 0) return [];
    // Walk braces to the end of the leads block.
    let depth = 0, end = start;
    for (let i = src.indexOf('{', start + 'match /leads/{leadId}'.length); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const block = src.slice(start, end);
    return [...block.matchAll(/match \/([A-Za-z_]+)\/\{/g)].map((m) => m[1]).filter((n) => n !== 'leads');
  } catch (_) {
    return [];
  }
}

function appProjectIds() {
  try {
    const rc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.firebaserc'), 'utf8'));
    return Object.values(rc.projects || {});
  } catch (_) {
    return [];
  }
}

function usage(msg) {
  if (msg) console.error('✗ ' + msg);
  console.error('usage: node scripts/audit-orphaned-lead-subtrees.js --project <id> [--delete --yes] [--bucket <name>] [--verbose]');
  process.exit(2);
}

async function adcProject() {
  const req = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
  const { GoogleAuth } = req('google-auth-library');
  return new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getProjectId();
}

async function main() {
  if (!PROJECT) usage('--project is required (no default, on purpose)');
  if (DELETE && !YES) usage('--delete needs --yes');

  const emulator = process.env.FIRESTORE_EMULATOR_HOST || '';
  // Both or neither. Found while testing this script: with only the
  // Firestore emulator set, a --delete run's Storage calls went to REAL
  // Storage on the machine's ADC (they 404'd on a bucket that does not
  // exist). An emulator run must never reach production, and vice versa.
  // Read-only runs too, since 2026-09-25: a read is still a read of the
  // other target.
  const storageEmulator = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '';
  if (!!emulator !== !!storageEmulator) {
    usage('mixed targets: set FIRESTORE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST together (emulator) or neither (production)');
  }
  if (emulator && appProjectIds().includes(PROJECT)) {
    usage(`refusing the app project id "${PROJECT}" on an emulator: the shared local rig uses it, and its data is other sessions'. Use a dedicated id (demo-...)`);
  }
  if (!emulator) {
    let adc = null;
    try { adc = await adcProject(); } catch (e) { if (VERBOSE) console.error('  ADC project lookup: ' + e.message); }
    if (!adc) usage('production: cannot tell which project the Application Default Credentials are for (gcloud config set project, or GOOGLE_CLOUD_PROJECT)');
    if (adc !== PROJECT) usage(`production: --project ${PROJECT} but the credentials' project is ${adc}`);
  }

  const { initAdmin, getFirestore, getStorage, FieldPath } = require('./_admin');
  initAdmin(emulator ? { projectId: PROJECT, credential: null } : { projectId: PROJECT });
  const db = getFirestore();
  const { storageRefsIn, isReapableLeadArtifactPath, isReservedLeadId } = require('../functions/lead-artifact-paths.js');

  console.log('audit-orphaned-lead-subtrees');
  console.log('  project : ' + PROJECT);
  console.log('  target  : ' + (emulator ? 'EMULATOR at ' + emulator : 'PRODUCTION (no FIRESTORE_EMULATOR_HOST)'));
  console.log('  mode    : ' + (DELETE ? 'DELETE' : 'read-only'));

  const names = [...new Set([...KNOWN_SUBCOLLECTIONS, ...subcollectionsFromRules()])].sort();
  console.log('  subtree : ' + names.join(', '));
  console.log('  top     : ' + TOP_LEVEL.map((t) => t.name).join(', '));

  const startNs = BigInt(Date.now()) * 1000000n;

  // ── Subtree rows: name -> { rows, byLead: Map<leadId, count>, legacyNested, elsewhere }
  const per = {};
  const allLeadIds = new Set();
  for (const name of names) {
    const p = { rows: 0, byLead: new Map(), legacyNested: 0, elsewhere: 0 };
    per[name] = p;
    let cursor = null;
    for (;;) {
      let q = db.collectionGroup(name).orderBy(FieldPath.documentId()).select().limit(PAGE);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) break;
      cursor = snap.docs[snap.docs.length - 1];
      for (const d of snap.docs) {
        const segs = d.ref.path.split('/');
        if (segs[0] !== 'leads' || segs.length < 4) { p.elsewhere++; continue; }
        if (segs[2] === 'leads') { p.legacyNested++; continue; }
        p.rows++;
        p.byLead.set(segs[1], (p.byLead.get(segs[1]) || 0) + 1);
        allLeadIds.add(segs[1]);
      }
      if (snap.size < PAGE) break;
    }
  }

  // ── Top-level docs keyed by leadId: name -> { docs, byLead, noLeadId }
  const top = {};
  for (const t of TOP_LEVEL) {
    const p = { docs: 0, byLead: new Map(), noLeadId: 0 };
    top[t.name] = p;
    let cursor = null;
    for (;;) {
      let q = db.collection(t.name).orderBy(FieldPath.documentId()).select('leadId').limit(PAGE);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) break;
      cursor = snap.docs[snap.docs.length - 1];
      for (const d of snap.docs) {
        p.docs++;
        const id = d.get('leadId');
        if (typeof id !== 'string' || !id || id.includes('/')) { p.noLeadId++; continue; }
        p.byLead.set(id, (p.byLead.get(id) || 0) + 1);
        allLeadIds.add(id);
      }
      if (snap.size < PAGE) break;
    }
  }

  // Which leads exist. A failed read is "unknown", never "absent".
  const leadExists = new Map();
  let unknownLeads = 0;
  const ids = [...allLeadIds];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      const snaps = await db.getAll(...chunk.map((id) => db.collection('leads').doc(id)), { fieldMask: [] });
      snaps.forEach((s, j) => leadExists.set(chunk[j], s.exists));
    } catch (e) {
      unknownLeads += chunk.length;
      if (VERBOSE) console.error('  lead read failed: ' + e.message);
    }
  }
  const absentIds = ids.filter((id) => leadExists.get(id) === false);
  const reservedIds = absentIds.filter((id) => isReservedLeadId(id));
  const orphanIds = absentIds.filter((id) => !isReservedLeadId(id));
  const orphanSet = new Set(orphanIds);

  // Orphan rows that name a Storage object the trigger would delete. Needs
  // the row data; read, counted, never printed.
  const withStorage = {};
  for (const name of names) {
    withStorage[name] = 0;
    for (const [leadId] of per[name].byLead) {
      if (!orphanSet.has(leadId)) continue;
      const snap = await db.collection('leads').doc(leadId).collection(name).get();
      for (const d of snap.docs) {
        if (storageRefsIn(d.data() || {}).some((p) => isReapableLeadArtifactPath(p, leadId))) withStorage[name]++;
      }
    }
  }

  // Subcollections under orphaned leads that the name list does not know.
  const known = new Set(names);
  const unknownNames = {};
  for (const leadId of orphanIds) {
    try {
      for (const c of await db.collection('leads').doc(leadId).listCollections()) {
        if (known.has(c.id) || c.id === 'leads') continue;
        const s = await c.select().limit(PAGE).get();
        unknownNames[c.id] = (unknownNames[c.id] || 0) + s.size;
      }
    } catch (e) {
      if (VERBOSE) console.error('  listCollections failed: ' + e.message);
    }
  }

  const orphanCount = (byLead) => {
    let rows = 0, leads = 0;
    for (const [leadId, n] of byLead) if (orphanSet.has(leadId)) { rows += n; leads++; }
    return { rows, leads };
  };

  console.log('\nRows under top-level leads, by subcollection (counts only):');
  console.log('  ' + 'subcollection'.padEnd(18) + 'rows'.padStart(8) + 'orphaned'.padStart(10)
    + 'orphan leads'.padStart(14) + 'w/ Storage'.padStart(12) + 'legacy'.padStart(8) + 'elsewhere'.padStart(11));
  let tRows = 0, tOrph = 0, tStor = 0;
  for (const name of names) {
    const p = per[name];
    const o = orphanCount(p.byLead);
    tRows += p.rows; tOrph += o.rows; tStor += withStorage[name];
    console.log('  ' + name.padEnd(18) + String(p.rows).padStart(8) + String(o.rows).padStart(10)
      + String(o.leads).padStart(14) + String(withStorage[name]).padStart(12)
      + String(p.legacyNested).padStart(8) + String(p.elsewhere).padStart(11));
  }

  console.log('\nTop-level docs naming a lead by leadId (counts only):');
  console.log('  ' + 'collection'.padEnd(18) + 'docs'.padStart(8) + 'orphaned'.padStart(10)
    + 'orphan leads'.padStart(14) + '  --delete  why it matters');
  let tTopOrph = 0, tTopSwept = 0;
  for (const t of TOP_LEVEL) {
    const o = orphanCount(top[t.name].byLead);
    tTopOrph += o.rows;
    if (t.sweep) tTopSwept += o.rows;
    console.log('  ' + t.name.padEnd(18) + String(top[t.name].docs).padStart(8) + String(o.rows).padStart(10)
      + String(o.leads).padStart(14) + '  ' + (t.sweep ? 'swept ' : 'kept  ') + '    ' + t.note);
  }

  const deterministic = orphanIds.filter((id) => id.includes('__')).length;
  const subtreeOnly = new Set();
  for (const name of names) for (const [leadId] of per[name].byLead) if (orphanSet.has(leadId)) subtreeOnly.add(leadId);
  console.log('\nTotals:');
  console.log('  lead ids named by a row or doc       : ' + ids.length);
  console.log('  of those, lead doc ABSENT (orphans)  : ' + orphanIds.length);
  console.log('    with rows under them               : ' + subtreeOnly.size);
  console.log('    with a deterministic id (x__y)     : ' + deterministic + '  (Cal.com / bridged web leads: guessable)');
  console.log('  reserved ids, absent (never swept)   : ' + reservedIds.length);
  console.log('  lead existence unknown (read error)  : ' + unknownLeads);
  console.log('  orphaned subtree rows (known names)  : ' + tOrph + ' of ' + tRows);
  console.log('  orphaned rows naming a Storage obj   : ' + tStor);
  console.log('  orphaned top-level docs              : ' + tTopOrph + ' (' + tTopSwept + ' in collections --delete sweeps)');
  const un = Object.entries(unknownNames);
  console.log('  other subcollections under orphans   : ' + (un.length ? un.map(([k, v]) => `${k}=${v}`).join(', ') : 'none'));
  console.log('  (legacy = leads/{uid}/leads/... tree, never touched; elsewhere = same name outside leads/)');

  if (!DELETE) {
    console.log('\nRead-only run. Nothing was changed.');
    return;
  }

  // ── --delete --yes ─────────────────────────────────────────────
  const { sweepLeadSubtree, sweepLeadKeyedDocs, makeLeadWatch } = require('../functions/lead-subtree-sweep.js');
  const bucketName = argValue('--bucket') || process.env.NBD_STORAGE_BUCKET
    || (emulator ? `${PROJECT}.appspot.com` : `${PROJECT}.firebasestorage.app`);
  const bucket = getStorage().bucket(bucketName);
  let bucketOk = false;
  try { [bucketOk] = await bucket.exists(); } catch (e) { if (VERBOSE) console.error('  bucket check: ' + e.message); }
  // The Storage emulator answers a bucket metadata GET with 404 even for a
  // bucket it holds objects in; there, a bucket with an object in it counts.
  if (!bucketOk && emulator) {
    try { const [files] = await bucket.getFiles({ maxResults: 1 }); bucketOk = files.length > 0; } catch (_) { /* stays false */ }
  }
  if (!bucketOk) usage('the Storage bucket does not exist (or cannot be read); nothing was deleted. Pass the right --bucket');

  console.log(`\nDELETE: sweeping ${orphanIds.length} orphaned lead id(s); bucket ${emulator ? bucketName : '(production)'}`);
  const tot = {
    swept: 0, reappeared: 0, rowsDeleted: 0, objectsDeleted: 0, refusedRefs: 0, rowsKeptForStorage: 0,
    skippedNewer: 0, skippedChanged: 0, topDocsDeleted: 0, failures: 0,
  };
  for (const leadId of orphanIds) {
    let s;
    try { s = await db.collection('leads').doc(leadId).get(); }
    catch (e) { tot.failures++; if (VERBOSE) console.error('  re-read failed: ' + e.message); continue; }
    if (s.exists) { tot.reappeared++; continue; }
    // No before-image: a lead that comes back now is treated as someone
    // else's, so nothing that existed before this run survives on its say-so.
    const watch = makeLeadWatch({ db, leadId, cutoffNs: startNs, deletedLead: null });
    const r = await sweepLeadSubtree({ db, bucket, leadId, cutoffNs: startNs, watch });
    tot.swept++;
    for (const k of ['rowsDeleted', 'objectsDeleted', 'refusedRefs', 'rowsKeptForStorage', 'skippedNewer', 'skippedChanged']) tot[k] += r[k];
    tot.failures += r.failures.length;
    if (VERBOSE) r.failures.forEach((f) => console.error('  ' + f));
    for (const t of TOP_LEVEL) {
      if (!t.sweep || !top[t.name].byLead.has(leadId)) continue;
      const k = await sweepLeadKeyedDocs({ db, collection: t.name, leadId, watch, alwaysStrict: !!t.alwaysStrict });
      tot.topDocsDeleted += k.deleted;
      tot.skippedNewer += k.skippedNewer;
      tot.skippedChanged += k.skippedChanged;
      tot.failures += k.failures.length;
      if (VERBOSE) k.failures.forEach((f) => console.error('  ' + f));
    }
    tot.failures += watch.failures.length;
  }
  console.log('  ' + Object.entries(tot).map(([k, v]) => `${k}=${v}`).join('  '));
  if (tot.failures || tot.rowsKeptForStorage) {
    console.log('  Some rows were not swept. Re-run with --verbose (do not paste its output) to see why.');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('✗ audit-orphaned-lead-subtrees failed: ' + (VERBOSE ? (e && e.stack) : (e && e.message)));
  process.exit(1);
});
