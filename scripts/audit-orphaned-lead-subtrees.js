/**
 * scripts/audit-orphaned-lead-subtrees.js
 *
 * Counts rows left under hard-deleted leads, and (only when told to) sweeps
 * them the way onLeadDeleted now does.
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
 * WHAT IT PRINTS: COUNTS ONLY
 * ───────────────────────────
 * The repo is public and this output gets pasted into notes and PRs. No lead
 * id, uid, name, address or path is ever printed, only numbers and
 * subcollection names (which come from code, not from users). --verbose adds
 * error messages, which can contain paths; do not paste those.
 *
 * HOW
 * ───
 * For each known lead subcollection name (the union of a fixed list and the
 * `match /leads/{leadId}` children in firestore.rules), a collectionGroup
 * query with select() (no fields) pages every row. Rows whose path is
 * leads/{id}/... are grouped by id; each id is checked with a getAll that
 * asks for no fields. A row whose lead does not exist is an orphan. Rows
 * under the retired leads/{uid}/leads/... tree and same-named collections
 * elsewhere (top-level `notes`, say) are counted apart and never touched.
 * For each orphaned lead id, listCollections() reports subcollections with
 * names this script does not know, so a new one cannot hide.
 *
 * --delete (NOT run by the author; production deletes need Jo's explicit OK)
 * ──────────────────────────────────────────────────────────────────────────
 * For each orphaned lead id: read the lead again (skip it if it exists now),
 * then run sweepLeadSubtree(), the trigger's own code: each row's Storage
 * objects before the row, the same segment-exact confinement, rows newer than
 * this run's start kept. Requires --yes. Storage objects under the lead's
 * leadId-keyed prefixes that no row names are NOT this script's job; see
 * scripts/sweep-orphan-lead-artifacts.js, which walks the bucket.
 *
 * SAFETY
 *   • --project is required. There is no default, so a run can only ever hit
 *     the project it names, and the target (EMULATOR or PRODUCTION) is
 *     printed before anything is read.
 *   • Read-only unless --delete --yes.
 *   • A lead read that fails is never treated as "lead absent".
 *
 * SETUP (production): Application Default Credentials, and
 * FIRESTORE_EMULATOR_HOST unset. firebase-admin comes from scripts/_admin.js.
 *
 * RUN
 *   node scripts/audit-orphaned-lead-subtrees.js --project nobigdeal-pro
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/audit-orphaned-lead-subtrees.js --project demo-x
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

function usage(msg) {
  if (msg) console.error('✗ ' + msg);
  console.error('usage: node scripts/audit-orphaned-lead-subtrees.js --project <id> [--delete --yes] [--bucket <name>] [--verbose]');
  process.exit(2);
}

async function main() {
  if (!PROJECT) usage('--project is required (no default, on purpose)');
  if (DELETE && !YES) usage('--delete needs --yes');

  const emulator = process.env.FIRESTORE_EMULATOR_HOST || '';
  // Both or neither. Found while testing this script: with only the
  // Firestore emulator set, a --delete run's Storage calls went to REAL
  // Storage on the machine's ADC (they 404'd on a bucket that does not
  // exist). An emulator run must never reach production, and vice versa.
  const storageEmulator = process.env.FIREBASE_STORAGE_EMULATOR_HOST || '';
  if (DELETE && !!emulator !== !!storageEmulator) {
    usage('mixed targets: set FIRESTORE_EMULATOR_HOST and FIREBASE_STORAGE_EMULATOR_HOST together (emulator) or neither (production)');
  }
  const { initAdmin, getFirestore, getStorage, FieldPath } = require('./_admin');
  initAdmin(emulator ? { projectId: PROJECT, credential: null } : { projectId: PROJECT });
  const db = getFirestore();

  console.log('audit-orphaned-lead-subtrees');
  console.log('  project : ' + PROJECT);
  console.log('  target  : ' + (emulator ? 'EMULATOR at ' + emulator : 'PRODUCTION (no FIRESTORE_EMULATOR_HOST)'));
  console.log('  mode    : ' + (DELETE ? 'DELETE' : 'read-only'));

  const names = [...new Set([...KNOWN_SUBCOLLECTIONS, ...subcollectionsFromRules()])].sort();
  console.log('  checking: ' + names.join(', '));

  const startNs = BigInt(Date.now()) * 1000000n;

  // name -> { rows, byLead: Map<leadId, count>, legacyNested, elsewhere }
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

  // Which parent leads exist. A failed read is "unknown", never "absent".
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
  const orphanIds = ids.filter((id) => leadExists.get(id) === false);
  const orphanSet = new Set(orphanIds);

  // Orphan rows that name a Storage object the trigger would delete. Needs
  // the row data; read, counted, never printed.
  const { storageRefsIn, isReapableLeadArtifactPath } = require('../functions/lead-artifact-paths.js');
  const withStorage = {};
  for (const name of names) {
    withStorage[name] = 0;
    const refs = [];
    for (const [leadId] of per[name].byLead) if (orphanSet.has(leadId)) refs.push(leadId);
    for (const leadId of refs) {
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

  console.log('\nRows under top-level leads, by subcollection (counts only):');
  console.log('  ' + 'subcollection'.padEnd(18) + 'rows'.padStart(8) + 'orphaned'.padStart(10)
    + 'orphan leads'.padStart(14) + 'w/ Storage'.padStart(12) + 'legacy'.padStart(8) + 'elsewhere'.padStart(11));
  let tRows = 0, tOrph = 0, tStor = 0;
  for (const name of names) {
    const p = per[name];
    let orphRows = 0, orphLeads = 0;
    for (const [leadId, n] of p.byLead) if (orphanSet.has(leadId)) { orphRows += n; orphLeads++; }
    tRows += p.rows; tOrph += orphRows; tStor += withStorage[name];
    console.log('  ' + name.padEnd(18) + String(p.rows).padStart(8) + String(orphRows).padStart(10)
      + String(orphLeads).padStart(14) + String(withStorage[name]).padStart(12)
      + String(p.legacyNested).padStart(8) + String(p.elsewhere).padStart(11));
  }
  const deterministic = orphanIds.filter((id) => id.includes('__')).length;
  console.log('\nTotals:');
  console.log('  lead ids with rows under them      : ' + ids.length);
  console.log('  of those, lead doc ABSENT (orphans): ' + orphanIds.length);
  console.log('    with a deterministic id (x__y)   : ' + deterministic + '  (Cal.com / bridged web leads: guessable)');
  console.log('  lead existence unknown (read error): ' + unknownLeads);
  console.log('  orphaned rows (known names)        : ' + tOrph + ' of ' + tRows);
  console.log('  orphaned rows naming a Storage obj : ' + tStor);
  const un = Object.entries(unknownNames);
  console.log('  other subcollections under orphans : ' + (un.length ? un.map(([k, v]) => `${k}=${v}`).join(', ') : 'none'));
  console.log('  (legacy = leads/{uid}/leads/... tree, never touched; elsewhere = same name outside leads/)');

  if (!DELETE) {
    console.log('\nRead-only run. Nothing was changed.');
    return;
  }

  // ── --delete --yes ─────────────────────────────────────────────
  const { sweepLeadSubtree } = require('../functions/lead-subtree-sweep.js');
  const bucketName = argValue('--bucket') || process.env.NBD_STORAGE_BUCKET
    || (emulator ? `${PROJECT}.appspot.com` : `${PROJECT}.firebasestorage.app`);
  const bucket = getStorage().bucket(bucketName);
  console.log(`\nDELETE: sweeping ${orphanIds.length} orphaned lead subtree(s); bucket ${emulator ? bucketName : '(production default)'}`);
  const tot = { swept: 0, reappeared: 0, rowsDeleted: 0, objectsDeleted: 0, refusedRefs: 0, rowsKeptForStorage: 0, skippedNewer: 0, skippedChanged: 0, failures: 0 };
  for (const leadId of orphanIds) {
    let s;
    try { s = await db.collection('leads').doc(leadId).get(); }
    catch (e) { tot.failures++; if (VERBOSE) console.error('  re-read failed: ' + e.message); continue; }
    if (s.exists) { tot.reappeared++; continue; }
    const r = await sweepLeadSubtree({ db, bucket, leadId, cutoffNs: startNs });
    tot.swept++;
    for (const k of ['rowsDeleted', 'objectsDeleted', 'refusedRefs', 'rowsKeptForStorage', 'skippedNewer', 'skippedChanged']) tot[k] += r[k];
    tot.failures += r.failures.length;
    if (VERBOSE) r.failures.forEach((f) => console.error('  ' + f));
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
