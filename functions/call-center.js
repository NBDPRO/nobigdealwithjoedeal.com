/**
 * NBD Pro — Call Center ingest (Cube ACR → CRM)
 * ═══════════════════════════════════════════════════════════════
 *
 * Every 30 minutes: list the Drive folder Jo's call recorder (Cube ACR)
 * writes to, and file every new recording as a `phone_calls` doc on the
 * owner tenant — matched to the lead by phone number, sorted into a bucket
 * (customer / insurance / contact / unknown), the audio copied into private
 * Storage at calls/{owner}/cube-acr/… (owner-only read, server-only write —
 * the same lockdown as Thursday's recordings).
 *
 * Access: the functions' service account reads the folder Jo SHARED with it
 * (Viewer). No folder id lives in this public repo — the account finds the
 * one folder named "Cube ACR" it can see. integrations/callCenter.folderId
 * pins it once found.
 *
 * Ships DRY-RUN: unless CALL_CENTER_INGEST_ENABLED=true on this function's
 * revision it only lists and counts (counts land on integrations/callCenter,
 * no names, no audio, no call docs). Transcription + AI notes are the next
 * stage (call docs carry status 'stored', transcript null).
 *
 * All decisions live in call-center-logic.js (pure, unit-tested).
 */
'use strict';

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const L = require('./call-center-logic');

const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const CONFIG = 'integrations/callCenter';
const COLLECTION = 'phone_calls';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_NAME = 'Cube ACR';
const BACKFILL_DAYS = 90;          // first run reaches back this far
const MAX_FILES_PER_RUN = 40;      // keeps one run well inside the timeout
const MAX_BYTES = 80 * 1024 * 1024;
const enabled = () => process.env.CALL_CENTER_INGEST_ENABLED === 'true';

let _client = null;
let _testClient = null;
async function gclient() {
  if (_testClient) return _testClient;
  if (_client) return _client;
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const c = await auth.getClient();
  _client = { request: (o) => c.request(o) };
  return _client;
}

async function listAll(q, fields) {
  const c = await gclient();
  const out = [];
  let pageToken;
  do {
    const r = await c.request({
      url: DRIVE + '/files',
      params: { q, fields: 'nextPageToken, files(' + fields + ')', pageSize: 200, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true },
    });
    out.push(...((r.data && r.data.files) || []));
    pageToken = r.data && r.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function findRootFolder(cfg) {
  if (cfg && cfg.folderId) return cfg.folderId;
  const hits = await listAll("name = '" + FOLDER_NAME + "' and mimeType = '" + FOLDER_MIME + "' and trashed = false", 'id, name');
  return hits.length === 1 ? hits[0].id : (hits.length ? { ambiguous: hits.length } : null);
}

async function download(fileId) {
  const c = await gclient();
  const r = await c.request({ url: DRIVE + '/files/' + encodeURIComponent(fileId), params: { alt: 'media', supportsAllDrives: true }, responseType: 'arraybuffer' });
  return Buffer.from(r.data);
}

async function ownerLeads(db) {
  const [a, b] = await Promise.all([
    db.collection('leads').where('companyId', '==', OWNER).get(),
    db.collection('leads').where('userId', '==', OWNER).get(),
  ]);
  const byId = new Map();
  for (const s of [a, b]) s.forEach((d) => { if (!byId.has(d.id)) byId.set(d.id, Object.assign({ id: d.id }, d.data())); });
  return [...byId.values()];
}

/** One ingest pass. Exported for the integration test (stubbed Drive). */
async function runIngest({ db, bucket, live, nowMs }) {
  const ref = db.doc(CONFIG);
  const snap = await ref.get();
  const cfg = snap.exists ? snap.data() : {};
  if (cfg.paused === true) return { state: 'paused' };

  const root = await findRootFolder(cfg);
  if (!root) return { state: 'not_shared' };
  if (typeof root === 'object') return { state: 'ambiguous_folder', count: root.ambiguous };

  const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const floor = cfg.backfillFrom || L.daysBefore(today, BACKFILL_DAYS);
  const days = await listAll("'" + root + "' in parents and mimeType = '" + FOLDER_MIME + "' and trashed = false", 'id, name');
  const scan = L.foldersToScan(days, cfg.cursorYmd || null, floor);

  const index = L.buildPhoneIndex(await ownerLeads(db));
  const counts = { folders: scan.length, seen: 0, fresh: 0, stored: 0, skipped: 0, failed: 0, buckets: {} };
  let cursor = cfg.cursorYmd || null;
  let budget = MAX_FILES_PER_RUN;

  for (const day of scan) {
    const files = await listAll("'" + day.id + "' in parents and trashed = false", 'id, name, size, mimeType, createdTime');
    files.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    let finishedDay = true;
    // One batched read per day folder for "already filed?".
    const refs = files.map((f) => db.collection(COLLECTION).doc(L.callDocId(f.id)));
    const have = new Set();
    if (refs.length) (await db.getAll(...refs)).forEach((s) => { if (s.exists) have.add(s.id); });
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const parsed = L.parseCubeAcrName(f.name);
      if (!parsed) { counts.skipped++; continue; }
      counts.seen++;
      const docRef = refs[i];
      if (have.has(docRef.id)) continue;
      counts.fresh++;
      const match = L.matchLead(parsed.phoneDigits, index);
      const bucketName = L.classifyCall(parsed, match);
      counts.buckets[bucketName] = (counts.buckets[bucketName] || 0) + 1;
      if (!live) continue;
      if (budget <= 0) { finishedDay = false; break; }
      budget--;
      try {
        if (Number(f.size) > MAX_BYTES) throw new Error('too_large');
        const path = L.storagePath(OWNER, parsed.ymd, f.id, parsed.ext);
        const bytes = await download(f.id);
        await bucket.file(path).save(bytes, { contentType: parsed.ext === 'm4a' ? 'audio/mp4' : (f.mimeType || 'application/octet-stream'), resumable: false, metadata: { cacheControl: 'private, max-age=0' } });
        await docRef.set(Object.assign(L.buildCallDoc({ ownerUid: OWNER, file: f, parsed, match, bucket: bucketName, storedPath: path, nowMs }), { createdAt: FieldValue.serverTimestamp() }));
        counts.stored++;
      } catch (e) {
        counts.failed++;
        finishedDay = false;
        logger.warn('call_center_file_failed', { fileId: f.id, err: e && e.message });
      }
    }
    if (!live) continue;
    // Advance the cursor only past fully-filed days; today's folder is always
    // re-listed next run (Cube ACR keeps adding to it).
    if (finishedDay) cursor = day.ymd; else break;
  }

  await ref.set({
    folderId: root,
    cursorYmd: live ? cursor : (cfg.cursorYmd || null),
    lastRunAtMs: nowMs,
    lastRun: Object.assign({ live }, counts),
  }, { merge: true });
  return Object.assign({ state: live ? 'ingested' : 'dry_run' }, counts);
}

exports.callCenterIngest = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'America/New_York', timeoutSeconds: 540, memory: '1GiB' },
  async () => {
    const db = getFirestore();
    const live = enabled();
    try {
      const r = await runIngest({ db, bucket: getStorage().bucket(), live, nowMs: Date.now() });
      logger.info('[callCenterIngest]', r);
    } catch (e) {
      // 403/404 before the folder is shared is the expected idle state.
      logger.warn('[callCenterIngest] failed', { err: e && e.message, code: e && (e.code || (e.response && e.response.status)) });
    }
  }
);

exports._test = {
  runIngest,
  setClient(c) { _testClient = c; },
  OWNER, COLLECTION, CONFIG,
};
