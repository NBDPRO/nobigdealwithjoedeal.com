/**
 * functions/member-storage-move.js — when a team member is removed, their
 * stored FILES move to the company owner too (Jo, 2026-10-06).
 *
 * WHY
 * ───
 * removeMember already hands the member's company records to the owner
 * (member-offboarding.js reassignMemberRecords). Storage did not follow:
 * every storage.rules owner block authorizes on the uid IN THE PATH
 * (photos/{uid}/..., documents/{uid}/..., audio/{uid}/..., ...), so the
 * ex-rep, signed back in as a claimless solo user, could still read their old
 * customers' photos, signed contracts, homeowner uploads and call recordings,
 * and delete the photos and docs the reassigned records point at.
 *
 * WHAT MOVES
 * ──────────
 * An object under one of the member's per-uid prefixes (STORAGE_PREFIXES in
 * integrations/user-owned.js, minus their personal `skins/`) moves when a
 * company record says it is the company's:
 *   - a moved record names it: a plain path, or a Firebase download URL, in
 *     any field at any depth (photos path/storagePath/thumbStoragePath/url,
 *     lead documents htmlPath + originalHtmlPath, esign sourcePath/signedPath,
 *     invoice payments[].proofPath, expense receipts, recordings, deal rooms,
 *     estimates' signedEnvelopePath ...). "Moved records" = the ledger
 *     reassignMemberRecords writes in the same batch as each reassignment,
 *     plus every row under each moved lead (leads/{id}/documents etc. carry no
 *     userId of their own, so the reassignment never touched them);
 *   - or it sits in a folder named for a moved record
 *     (`<prefix>/<rep>/<leadId>/...`, `deal_rooms/<rep>/<dealId>.html`,
 *     `portals/<rep>/<leadId>-photos.html`): objects whose path the servers
 *     DERIVE from the owner field instead of storing it;
 *   - plus the image pipeline's `_variants/` copies of each moved image.
 * Everything else stays: the member's own pre-company (solo) files, and
 * orphans nothing claims. Those are counted as `left`, never guessed at.
 *
 * HOW (each step resumable; the state is in Firestore, never in memory)
 * ───
 *   member_offboarding/{companyId}__{repUid}     status, phase, cursor, lease
 *     /ledger/{sha1(doc path)}                   records to scan + rewrite
 *     /objects/{sha1(src path)}                  src, dst, state per object
 *   phases: records -> collect -> list -> copy -> rewrite -> delete -> unlock
 *   - copy: server-side copy to the same relative path under the owner's uid
 *     (contentType + custom metadata, incl. signed:'true', go with it), then
 *     size + md5 (crc32c when GCS has no md5) + contentType + signed flag must
 *     match. A signed object, or one a record holds a sha256 for (esign
 *     signedSha256/sourceSha256, deal room acceptedEvidence.pageSha256), is
 *     downloaded on both sides and its sha256 compared; whether it still
 *     equals the record's stored hash is recorded too. A copy never
 *     overwrites an existing different object at the destination.
 *   - rewrite: each record is rewritten in a transaction (old path -> new
 *     path, and the encoded path inside download URLs; a download token is
 *     copied with the object's metadata, so the URL keeps working). Signed
 *     URLs (X-Goog-Signature) cannot be rewritten and expire on their own;
 *     every server re-signs from the stored path.
 *   - delete: only after every record is rewritten, and only when the copy
 *     re-verifies and the original is unchanged since it was copied.
 *   - unlock: removeMember sets an `offboardLock` claim with the claim strip;
 *     storage.rules refuses every owner read/write while it is set, so the
 *     member's folder is locked for the whole move. It is cleared only when
 *     every company file has moved cleanly; what is left is their own.
 * A slice is bounded (ops + wall clock). removeMember runs one inline; the
 * resumeMemberStorageMoves cron (member-storage-move-cron.js) runs the rest,
 * every 5 minutes, under a lease so two runners never overlap.
 *
 * No firebase-admin import: the caller passes db, bucket, auth and logger,
 * so the emulator suite drives exactly this code.
 */
'use strict';

const crypto = require('crypto');
const { STORAGE_PREFIXES } = require('./integrations/user-owned');
const { storagePathFromUrl, variantPathsFor } = require('./lead-artifact-paths');

const STATE_COLLECTION = 'member_offboarding';
const LOCK_CLAIM = 'offboardLock';
// skins/ is the person's own screen styling, not company data.
const NOT_MOVED_PREFIXES = new Set(['skins']);
const MOVE_PREFIXES = STORAGE_PREFIXES.filter((p) => !NOT_MOVED_PREFIXES.has(p));
const PHASES = ['records', 'collect', 'list', 'copy', 'rewrite', 'delete', 'unlock', 'done'];
// Records that hold a sha256 of an object they name: [pathField, hashField].
const HASH_BINDINGS = {
  esign_envelopes: [['signedPath', 'signedSha256'], ['sourcePath', 'sourceSha256']],
  deal_rooms: [['acceptedEvidence.pagePath', 'acceptedEvidence.pageSha256'], ['htmlPath', 'acceptedEvidence.pageSha256']],
};
const PAGE = 25;
const MAX_SLICES = 2000;

const keyOf = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const migrationId = (companyId, fromUid) => companyId + '__' + fromUid;

function ledgerEntry(ref, kind) {
  const segs = String(ref.path).split('/');
  return { path: ref.path, docId: ref.id, collection: segs[segs.length - 2], kind: kind || 'record', scanned: false, rewritten: false };
}

/** The prefix name when `p` is an object under `<prefix>/<fromUid>/`, else null. */
function repPrefixOf(p, fromUid) {
  if (typeof p !== 'string' || !fromUid || p.length > 1024) return null;
  if (p.includes('..') || p.includes('//') || p.includes('\\')) return null;
  for (const pre of MOVE_PREFIXES) {
    const head = pre + '/' + fromUid + '/';
    if (p.startsWith(head) && p.length > head.length) return pre;
  }
  return null;
}

function destFor(src, fromUid, toUid) {
  const pre = repPrefixOf(src, fromUid);
  return pre ? pre + '/' + toUid + src.slice(pre.length + 1 + fromUid.length) : null;
}

function isSignedUrl(u) {
  return /[?&](X-Goog-Signature|X-Goog-Credential|Signature|GoogleAccessId|X-Amz-Signature)=/i.test(u);
}

function isPlainObject(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** One string -> { path, signedUrl } when it names a member object, else null. */
function refOfString(v, fromUid) {
  if (typeof v !== 'string' || v.length > 2048) return null;
  if (/^[a-z]+:\/\//i.test(v)) {
    const p = storagePathFromUrl(v);
    if (!p || !repPrefixOf(p, fromUid)) return null;
    return { path: p, signedUrl: isSignedUrl(v) };
  }
  return repPrefixOf(v, fromUid) ? { path: v, signedUrl: false } : null;
}

const MAX_DEPTH = 6;
const MAX_ARRAY = 500;

/** Every member object a record names: { paths: Set, signedUrls: n }. */
function refsIn(data, fromUid) {
  const paths = new Set();
  let signedUrls = 0;
  (function walk(v, depth) {
    if (typeof v === 'string') {
      const r = refOfString(v, fromUid);
      if (r) { if (r.signedUrl) signedUrls++; else paths.add(r.path); }
      return;
    }
    if (depth >= MAX_DEPTH) return;
    if (Array.isArray(v)) { v.slice(0, MAX_ARRAY).forEach((x) => walk(x, depth + 1)); return; }
    if (isPlainObject(v)) Object.keys(v).forEach((k) => walk(v[k], depth + 1));
  })(data, 0);
  return { paths, signedUrls };
}

function rewriteUrl(u, dst) {
  const url = new URL(u);
  if (/^\/v0\/b\/[^/]+\/o\/[^/]+$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/o\/[^/]+$/, '/o/' + encodeURIComponent(dst));
  } else {
    const m = /^\/([^/]+)\//.exec(url.pathname);
    url.pathname = '/' + m[1] + '/' + dst.split('/').map(encodeURIComponent).join('/');
  }
  return url.toString();
}

/** Same shape as refsIn's walk; replaces each moved path. Non-plain values pass through. */
function rewriteValue(v, map, fromUid, depth) {
  if (typeof v === 'string') {
    const r = refOfString(v, fromUid);
    if (!r || r.signedUrl || !map.has(r.path)) return { value: v, changed: 0 };
    const dst = map.get(r.path);
    return { value: /^[a-z]+:\/\//i.test(v) ? rewriteUrl(v, dst) : dst, changed: 1 };
  }
  if (depth >= MAX_DEPTH) return { value: v, changed: 0 };
  if (Array.isArray(v)) {
    let changed = 0;
    const out = v.map((x, i) => {
      if (i >= MAX_ARRAY) return x;
      const r = rewriteValue(x, map, fromUid, depth + 1);
      changed += r.changed;
      return r.value;
    });
    return { value: changed ? out : v, changed };
  }
  if (isPlainObject(v)) {
    let changed = 0;
    const out = {};
    for (const k of Object.keys(v)) {
      const r = rewriteValue(v[k], map, fromUid, depth + 1);
      changed += r.changed;
      out[k] = r.value;
    }
    return { value: changed ? out : v, changed };
  }
  return { value: v, changed: 0 };
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

/** Expected sha256 per object path, from the record's own hash fields. */
function expectedHashes(collection, data, fromUid) {
  const out = {};
  for (const [pf, hf] of HASH_BINDINGS[collection] || []) {
    const p = getPath(data, pf);
    const h = getPath(data, hf);
    const r = refOfString(p, fromUid);
    if (r && !r.signedUrl && typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) out[r.path] = h;
  }
  return out;
}

/** Folder-name ids an unreferenced object could belong to (see header). */
function folderCandidates(src, fromUid) {
  const pre = repPrefixOf(src, fromUid);
  if (!pre) return [];
  const seg = src.slice(pre.length + fromUid.length + 2).split('/')[0];
  if (!seg) return [];
  return [...new Set([seg, seg.replace(/\.[^.]+$/, ''), seg.replace(/-photos\.html?$/i, '')])]
    .filter((s) => s && s.length <= 200);
}

function isMissing(e) {
  return !!e && (e.code === 404 || e.code === '404' || /no such object|not found/i.test(String(e.message || '')));
}

async function metaOf(file) {
  try { const [m] = await file.getMetadata(); return m || null; } catch (e) { if (isMissing(e)) return null; throw e; }
}

function sigOf(m) {
  return {
    size: String(m.size == null ? '' : m.size),
    md5: m.md5Hash || null,
    crc32c: m.crc32c || null,
    contentType: m.contentType || null,
    signed: !!(m.metadata && m.metadata.signed === 'true'),
  };
}

function sameBytes(a, b) {
  if (a.size !== b.size) return false;
  if (a.md5 && b.md5) return a.md5 === b.md5;
  if (a.crc32c && b.crc32c) return a.crc32c === b.crc32c;
  return false; // nothing to compare is not a match
}

async function commitSets(db, writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const b = db.batch();
    writes.slice(i, i + 400).forEach((w) => (w.merge ? b.set(w.ref, w.data, { merge: true }) : b.set(w.ref, w.data)));
    await b.commit();
  }
}

async function deleteAll(db, col) {
  for (;;) {
    const s = await col.limit(400).get();
    if (s.empty) return;
    const b = db.batch();
    s.docs.forEach((d) => b.delete(d.ref));
    await b.commit();
  }
}

/**
 * Before the reassignment: the state doc (phase 'records'). Returns the
 * ledger collection reassignMemberRecords writes into. A finished earlier
 * move for the same member (re-invited, removed again) starts fresh.
 */
async function prepareMemberStorageMove(db, { companyId, fromUid, toUid, now = Date.now } = {}) {
  if (![companyId, fromUid, toUid].every((v) => typeof v === 'string' && v) || fromUid === toUid) {
    throw new Error('prepareMemberStorageMove: companyId, fromUid and toUid are required and distinct');
  }
  const id = migrationId(companyId, fromUid);
  const ref = db.collection(STATE_COLLECTION).doc(id);
  const snap = await ref.get();
  const d = snap.exists ? (snap.data() || {}) : null;
  if (!d || d.status !== 'running') {
    if (d) { await deleteAll(db, ref.collection('ledger')); await deleteAll(db, ref.collection('objects')); }
    await ref.set({
      companyId, fromUid, toUid, status: 'running', phase: 'records',
      listCursor: { i: 0, pageToken: null }, slices: 0, leaseUntil: 0, leaseId: null,
      startedAtMs: now(), updatedAtMs: now(), lastError: null, summary: null,
    });
  }
  return { id, ref, ledger: ref.collection('ledger') };
}

/** After the reassignment committed: the move may start. */
async function markRecordsReassigned(ref, now = Date.now) {
  const s = await ref.get();
  if (s.exists && (s.data() || {}).phase === 'records') await ref.update({ phase: 'collect', updatedAtMs: now() });
}

// ── phases ─────────────────────────────────────────────────

async function collectPhase(ctx) {
  const { db, st, budget } = ctx;
  for (;;) {
    const q = await st.ledger.where('scanned', '==', false).limit(PAGE).get();
    if (q.empty) return true;
    for (const e of q.docs) {
      if (budget.spent()) return false;
      await scanLedgerEntry(ctx, e);
      budget.ops++;
    }
  }
}

async function scanLedgerEntry(ctx, e) {
  const { db, st } = ctx;
  const ent = e.data() || {};
  const snap = await db.doc(ent.path).get();
  const writes = [];
  let signedUrls = 0;
  if (snap.exists) {
    const data = snap.data() || {};
    const found = refsIn(data, st.fromUid);
    signedUrls = found.signedUrls;
    const hashes = expectedHashes(ent.collection, data, st.fromUid);
    const want = new Map();
    for (const p of found.paths) {
      want.set(p, { from: ent.path, expectedSha256: hashes[p] || null });
      if (p.startsWith('photos/') || p.startsWith('homeowner-uploads/')) {
        for (const v of variantPathsFor(p)) if (repPrefixOf(v, st.fromUid) && !want.has(v)) want.set(v, { from: ent.path, variant: true });
      }
    }
    if (want.size) {
      const srcs = [...want.keys()];
      const existing = await db.getAll(...srcs.map((s) => st.objects.doc(keyOf(s))));
      existing.forEach((x, i) => {
        const src = srcs[i];
        const w = want.get(src);
        if (!x.exists) {
          writes.push({ ref: x.ref, data: { src, dst: destFor(src, st.fromUid, st.toUid), state: 'pending', from: w.from, variant: !!w.variant, expectedSha256: w.expectedSha256 || null } });
        } else if (w.expectedSha256 && !(x.data() || {}).expectedSha256) {
          writes.push({ ref: x.ref, data: { expectedSha256: w.expectedSha256 }, merge: true });
        }
      });
    }
    // Rows under a moved lead carry no owner field of their own, so the
    // reassignment never saw them; their paths still need rewriting.
    if (ent.kind === 'record' && ent.collection === 'leads' && ent.path.split('/').length === 2) {
      const cols = await db.doc(ent.path).listCollections();
      for (const col of cols) {
        const rows = await col.get();
        if (rows.empty) continue;
        const known = await db.getAll(...rows.docs.map((r) => st.ledger.doc(keyOf(r.ref.path))));
        known.forEach((k, i) => { if (!k.exists) writes.push({ ref: k.ref, data: ledgerEntry(rows.docs[i].ref, 'sub') }); });
      }
    }
  }
  writes.push({ ref: e.ref, data: { scanned: true, signedUrls }, merge: true });
  await commitSets(db, writes);
}

async function listPhase(ctx) {
  const { db, st, bucket, budget } = ctx;
  let { i, pageToken } = st.listCursor || { i: 0, pageToken: null };
  const folderHit = new Map();
  async function inMovedFolder(src) {
    for (const c of folderCandidates(src, st.fromUid)) {
      if (!folderHit.has(c)) {
        const q = await st.ledger.where('docId', '==', c).limit(1).get();
        folderHit.set(c, !q.empty);
      }
      if (folderHit.get(c)) return c;
    }
    return null;
  }
  while (i < MOVE_PREFIXES.length) {
    if (budget.spent()) { st.listCursor = { i, pageToken }; return false; }
    const opts = { prefix: MOVE_PREFIXES[i] + '/' + st.fromUid + '/', maxResults: 100, autoPaginate: false };
    if (pageToken) opts.pageToken = pageToken;
    const [files, next] = await bucket.getFiles(opts);
    const names = files.map((f) => f.name).filter((n) => repPrefixOf(n, st.fromUid));
    const writes = [];
    if (names.length) {
      const existing = await db.getAll(...names.map((n) => st.objects.doc(keyOf(n))));
      for (let k = 0; k < names.length; k++) {
        if (existing[k].exists) continue;
        const hit = await inMovedFolder(names[k]);
        writes.push({ ref: existing[k].ref, data: hit
          ? { src: names[k], dst: destFor(names[k], st.fromUid, st.toUid), state: 'pending', from: 'folder:' + hit, variant: false, expectedSha256: null }
          : { src: names[k], state: 'left' } });
      }
    }
    await commitSets(db, writes);
    budget.ops += names.length || 1;
    pageToken = (next && next.pageToken) || null;
    if (!pageToken) i++;
    st.listCursor = { i, pageToken };
    await st.ref.update({ listCursor: st.listCursor, updatedAtMs: ctx.now() });
  }
  return true;
}

async function copyPhase(ctx) {
  const { st, budget } = ctx;
  for (;;) {
    const q = await st.objects.where('state', '==', 'pending').limit(PAGE).get();
    if (q.empty) return true;
    for (const e of q.docs) {
      if (budget.spent()) return false;
      await copyOne(ctx, e);
      budget.ops++;
    }
  }
}

async function copyOne(ctx, e) {
  const { bucket } = ctx;
  const ent = e.data() || {};
  const src = bucket.file(ent.src);
  const dst = bucket.file(ent.dst);
  const sm = await metaOf(src);
  let dm = await metaOf(dst);
  if (!sm) {
    // Nothing to copy. A copy already there (the original removed by someone
    // else) is used as is; otherwise the record names a file that is gone.
    if (dm) { await e.ref.update(Object.assign({ state: 'copied', note: 'src-gone' }, recordSig(sigOf(dm)))); }
    else await e.ref.update({ state: 'missing' });
    return;
  }
  const s = sigOf(sm);
  if (dm && !sameBytes(s, sigOf(dm))) {
    // Copies are atomic, so a different object here is not ours. Never clobber it.
    await e.ref.update({ state: 'verify-failed', reason: 'dst-exists' });
    return;
  }
  if (!dm) { await src.copy(dst); dm = await metaOf(dst); }
  const d = dm ? sigOf(dm) : null;
  if (!d || !sameBytes(s, d) || s.contentType !== d.contentType || s.signed !== d.signed) {
    await e.ref.update({ state: 'verify-failed', reason: 'copy-mismatch' });
    return;
  }
  const patch = Object.assign({ state: 'copied' }, recordSig(d));
  if (s.signed || ent.expectedSha256) {
    const [[sb], [db_]] = await Promise.all([src.download(), dst.download()]);
    const hs = sha256(sb);
    const hd = sha256(db_);
    if (hs !== hd) { await e.ref.update({ state: 'verify-failed', reason: 'sha256-mismatch' }); return; }
    patch.sha256 = hd;
    patch.hashMatchesRecord = ent.expectedSha256 ? hd === ent.expectedSha256 : null;
  }
  await e.ref.update(patch);
}

function recordSig(sig) {
  return { size: sig.size, md5: sig.md5, crc32c: sig.crc32c, contentType: sig.contentType, signed: sig.signed };
}

async function rewritePhase(ctx) {
  const { st, budget } = ctx;
  for (;;) {
    const q = await st.ledger.where('rewritten', '==', false).limit(PAGE).get();
    if (q.empty) return true;
    for (const e of q.docs) {
      if (budget.spent()) return false;
      await rewriteOne(ctx, e);
      budget.ops++;
    }
  }
}

async function rewriteOne(ctx, e) {
  const { db, st } = ctx;
  const ent = e.data() || {};
  const docRef = db.doc(ent.path);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) { tx.set(e.ref, { rewritten: true, changed: 0 }, { merge: true }); return; }
    const data = snap.data() || {};
    const srcs = [...refsIn(data, st.fromUid).paths];
    const map = new Map();
    if (srcs.length) {
      const objs = await tx.getAll(...srcs.map((s) => st.objects.doc(keyOf(s))));
      objs.forEach((o, i) => {
        const od = o.exists ? (o.data() || {}) : null;
        if (od && (od.state === 'copied' || od.state === 'done') && od.dst) map.set(srcs[i], od.dst);
      });
    }
    const r = map.size ? rewriteValue(data, map, st.fromUid, 0) : { changed: 0 };
    if (r.changed) tx.set(docRef, r.value);
    tx.set(e.ref, { rewritten: true, changed: r.changed }, { merge: true });
  });
}

async function deletePhase(ctx) {
  const { st, bucket, budget } = ctx;
  for (;;) {
    const q = await st.objects.where('state', '==', 'copied').limit(PAGE).get();
    if (q.empty) return true;
    for (const e of q.docs) {
      if (budget.spent()) return false;
      const ent = e.data() || {};
      const want = { size: ent.size, md5: ent.md5, crc32c: ent.crc32c };
      const dm = await metaOf(bucket.file(ent.dst));
      budget.ops++;
      if (!dm || !sameBytes(want, sigOf(dm))) { await e.ref.update({ state: 'verify-failed', reason: 'dst-changed' }); continue; }
      const src = bucket.file(ent.src);
      const sm = await metaOf(src);
      if (sm && !sameBytes(want, sigOf(sm))) { await e.ref.update({ state: 'verify-failed', reason: 'src-changed' }); continue; }
      if (sm) {
        try { await src.delete(); } catch (err) { if (!isMissing(err)) throw err; }
      }
      await e.ref.update({ state: 'done' });
    }
  }
}

async function countWhere(col, field, op, value) {
  const q = col.where(field, op, value);
  if (typeof q.count === 'function') { const s = await q.count().get(); return s.data().count; }
  return (await q.get()).size;
}

async function summarize(st) {
  const [moved, left, missing, failed, signedMoved, hashStale, docsChanged, signedUrlDocs] = await Promise.all([
    countWhere(st.objects, 'state', '==', 'done'),
    countWhere(st.objects, 'state', '==', 'left'),
    countWhere(st.objects, 'state', '==', 'missing'),
    countWhere(st.objects, 'state', '==', 'verify-failed'),
    countWhere(st.objects, 'sha256', '>', ''),
    countWhere(st.objects, 'hashMatchesRecord', '==', false),
    countWhere(st.ledger, 'changed', '>', 0),
    countWhere(st.ledger, 'signedUrls', '>', 0),
  ]);
  return { moved, left, missing, verifyFailed: failed, hashVerified: signedMoved, hashDiffersFromRecord: hashStale, recordsRewritten: docsChanged, recordsWithSignedUrls: signedUrlDocs };
}

async function unlockPhase(ctx) {
  const { st, auth } = ctx;
  st.summary = await summarize(st);
  if (st.summary.verifyFailed > 0) {
    // Some company files could not move. Keep the lock and stop for a person.
    st.status = 'needs-attention';
    return true;
  }
  if (auth) {
    try {
      const u = await auth.getUser(st.fromUid);
      const c = Object.assign({}, u.customClaims || {});
      if (LOCK_CLAIM in c) { delete c[LOCK_CLAIM]; await auth.setCustomUserClaims(st.fromUid, c); }
    } catch (e) {
      if (!(e && (e.code === 'auth/user-not-found'))) throw e;
    }
  }
  st.status = 'done';
  return true;
}

const RUNNERS = { collect: collectPhase, list: listPhase, copy: copyPhase, rewrite: rewritePhase, delete: deletePhase, unlock: unlockPhase };

/**
 * Run one bounded slice of a member's storage move. Safe to call at any time
 * from anywhere: a held lease, a finished move or one still in 'records'
 * returns without doing anything. Returns { status, phase }.
 */
async function runMemberStorageMove(db, bucket, id, opts = {}) {
  const logger = opts.logger || console;
  const now = opts.now || Date.now;
  const deadline = now() + (opts.deadlineMs || 60000);
  const budget = { ops: 0, maxOps: opts.maxOps || 400, spent() { return this.ops >= this.maxOps || now() >= deadline; } };
  const ref = db.collection(STATE_COLLECTION).doc(id);
  const leaseId = crypto.randomBytes(8).toString('hex');
  const d = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return null;
    const v = s.data() || {};
    if (v.status !== 'running' || v.phase === 'records') return v;
    if ((v.leaseUntil || 0) > now()) return Object.assign({}, v, { leased: true });
    tx.update(ref, { leaseUntil: deadline + 60000, leaseId });
    return Object.assign({}, v, { mine: true });
  });
  if (!d) return { status: 'absent' };
  if (!d.mine) return { status: d.status, phase: d.phase, skipped: d.leased ? 'leased' : 'not-runnable' };

  const st = {
    ref, fromUid: d.fromUid, toUid: d.toUid, companyId: d.companyId,
    ledger: ref.collection('ledger'), objects: ref.collection('objects'),
    listCursor: d.listCursor, status: 'running', summary: null,
  };
  const ctx = { db, bucket, auth: opts.auth || null, st, budget, now, logger };
  let phase = d.phase;
  let lastError = null;
  try {
    while (phase !== 'done' && st.status === 'running') {
      const run = RUNNERS[phase];
      if (!run) throw new Error('unknown phase ' + phase);
      const complete = await run(ctx);
      if (!complete) break;
      phase = PHASES[PHASES.indexOf(phase) + 1];
    }
  } catch (e) {
    lastError = { message: String((e && e.message) || e).slice(0, 500), phase, atMs: now() };
    logger.error('memberStorageMove.error', Object.assign({ id }, lastError));
  }
  const slices = (d.slices || 0) + 1;
  if (st.status === 'running' && phase === 'done') st.status = 'done';
  if (st.status === 'running' && slices >= MAX_SLICES) st.status = 'needs-attention';
  const patch = { phase, status: st.status, slices, leaseUntil: 0, leaseId: null, updatedAtMs: now(), lastError };
  if (st.listCursor) patch.listCursor = st.listCursor;
  if (st.summary) patch.summary = st.summary;
  if (st.status !== 'running') patch.finishedAtMs = now();
  await ref.update(patch);
  if (st.status !== 'running') {
    const line = Object.assign({ id, companyId: st.companyId, fromUid: st.fromUid, toUid: st.toUid, status: st.status, slices }, st.summary || {});
    (st.status === 'done' ? logger.info : logger.error).call(logger, 'memberStorageMove.' + st.status, line);
  }
  return { status: st.status, phase, error: lastError ? lastError.message : null, summary: st.summary };
}

module.exports = {
  STATE_COLLECTION,
  LOCK_CLAIM,
  MOVE_PREFIXES,
  HASH_BINDINGS,
  keyOf,
  migrationId,
  ledgerEntry,
  repPrefixOf,
  destFor,
  refsIn,
  rewriteValue,
  expectedHashes,
  folderCandidates,
  prepareMemberStorageMove,
  markRecordsReassigned,
  runMemberStorageMove,
};
