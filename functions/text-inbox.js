/**
 * NBD Pro — Text Inbox ingest (SMS Backup & Restore → CRM), 2026-10-01
 * ═══════════════════════════════════════════════════════════════
 *
 * Call Center stage 4: Jo's texts. Every 30 minutes, read the newest
 * sms-*.xml backup that SMS Backup & Restore (on Jo's Android phone) put in
 * the Drive folder Jo shared with the functions' service account
 * ("SMSBackupRestore", Viewer), and file every text — received and sent —
 * as a `phone_texts` doc on the owner tenant, matched to the lead by phone
 * and sorted like calls (customer / insurance / contact / unknown). Short
 * codes (2FA, bank, delivery alerts) are never stored.
 *
 *   - newest backup only (each is a full copy); skipped when it's the same
 *     file + modifiedTime as last run
 *   - reads texts newer than the cursor minus 3 days (90 days on the first
 *     run); doc ids are content hashes, so overlap never duplicates
 *   - cursor + counts (no names, numbers or bodies) on integrations/textInbox
 *   - integrations/textInbox.paused === true stops it
 *
 * Ships DRY-RUN: unless TEXT_INBOX_ENABLED=true it parses and counts only.
 * Pure parsing/sorting: text-inbox-logic.js; lead matching shared with the
 * call ingest (call-center-logic.js).
 */
'use strict';

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const T = require('./text-inbox-logic');
const CC = require('./call-center-logic');

const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const CONFIG = 'integrations/textInbox';
const COLLECTION = 'phone_texts';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_NAME = 'SMSBackupRestore';
const BACKFILL_DAYS = 90;
const MAX_BYTES = 250 * 1024 * 1024;
const BATCH = 400;
const enabled = () => process.env.TEXT_INBOX_ENABLED === 'true';

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
    const r = await c.request({ url: DRIVE + '/files', params: { q, fields: 'nextPageToken, files(' + fields + ')', pageSize: 200, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true } });
    out.push(...((r.data && r.data.files) || []));
    pageToken = r.data && r.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function downloadText(fileId) {
  const c = await gclient();
  const r = await c.request({ url: DRIVE + '/files/' + encodeURIComponent(fileId), params: { alt: 'media', supportsAllDrives: true }, responseType: 'arraybuffer' });
  return Buffer.from(r.data).toString('utf8');
}

async function ownerLeads(db) {
  const [a, b] = await Promise.all([
    db.collection('leads').where('companyId', '==', OWNER).get(),
    db.collection('leads').where('userId', '==', OWNER).get(),
  ]);
  const byId = new Map();
  for (const s of [a, b]) s.forEach((d) => { if (!byId.has(d.id)) byId.set(d.id, Object.assign({}, d.data(), { id: d.id })); });
  return [...byId.values()];
}

/** One pass. Exported for the integration test (stubbed Drive, fake db). */
async function runTextIngest({ db, live, nowMs }) {
  const ref = db.doc(CONFIG);
  const snap = await ref.get();
  const cfg = snap.exists ? snap.data() : {};
  if (cfg.paused === true) return { state: 'paused' };

  let folderId = cfg.folderId;
  if (!folderId) {
    const hits = await listAll("name = '" + FOLDER_NAME + "' and mimeType = '" + FOLDER_MIME + "' and trashed = false", 'id, name');
    if (!hits.length) return { state: 'not_shared' };
    if (hits.length > 1) return { state: 'ambiguous_folder', count: hits.length };
    folderId = hits[0].id;
  }
  const files = await listAll("'" + folderId + "' in parents and trashed = false", 'id, name, size, modifiedTime');
  const newest = T.pickNewestBackup(files);
  if (!newest) { await ref.set({ folderId, lastRunAtMs: nowMs, lastRun: { live, state: 'no_backup' } }, { merge: true }); return { state: 'no_backup' }; }
  if (live && cfg.lastFileId === newest.id && cfg.lastFileModified === newest.modifiedTime) return { state: 'unchanged' };
  if (Number(newest.size) > MAX_BYTES) return { state: 'too_large' };

  const since = T.sinceFor(cfg.cursorMs || null, nowMs, BACKFILL_DAYS);
  const { messages, skipped } = T.parseSmsBackup(await downloadText(newest.id), { sinceMs: since });
  const index = CC.buildPhoneIndex(await ownerLeads(db));
  const counts = { parsed: messages.length, fresh: 0, stored: 0, buckets: {}, skippedShortCodes: skipped.shortCode, skippedOther: skipped.otherType + skipped.noNumber };

  let cursor = cfg.cursorMs || 0;
  for (let i = 0; i < messages.length; i += BATCH) {
    const chunk = messages.slice(i, i + BATCH);
    const refs = chunk.map((m) => db.collection(COLLECTION).doc(T.textDocId(m)));
    const have = new Set();
    (await db.getAll(...refs)).forEach((s) => { if (s.exists) have.add(s.id); });
    const batch = live ? db.batch() : null;
    let writes = 0;
    chunk.forEach((m, k) => {
      cursor = Math.max(cursor, m.dateMs);
      if (have.has(refs[k].id)) return;
      counts.fresh++;
      const match = CC.matchLead(m.phoneDigits, index);
      const bucket = CC.classifyCall({ contactLabel: m.contactName, savedContact: !!m.contactName }, match);
      counts.buckets[bucket] = (counts.buckets[bucket] || 0) + 1;
      if (live) { batch.set(refs[k], T.buildTextDoc({ ownerUid: OWNER, msg: m, match, bucket, fileId: newest.id, nowMs })); writes++; }
    });
    if (live && writes) { await batch.commit(); counts.stored += writes; }
  }

  const patch = { folderId, lastRunAtMs: nowMs, lastRun: Object.assign({ live, backupName: newest.name }, counts) };
  if (live) Object.assign(patch, { cursorMs: cursor || null, lastFileId: newest.id, lastFileModified: newest.modifiedTime || null });
  await ref.set(patch, { merge: true });
  return Object.assign({ state: live ? 'ingested' : 'dry_run' }, counts);
}

exports.textInboxIngest = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'America/New_York', timeoutSeconds: 540, memory: '1GiB', maxInstances: 1 },
  async () => {
    try {
      const r = await runTextIngest({ db: getFirestore(), live: enabled(), nowMs: Date.now() });
      logger.info('[textInboxIngest]', r);
    } catch (e) {
      // 403/404 before the folder is shared is the expected idle state.
      logger.warn('[textInboxIngest] failed', { err: e && e.message, code: e && (e.code || (e.response && e.response.status)) });
    }
  }
);

exports._test = { runTextIngest, setClient(c) { _testClient = c; }, OWNER, COLLECTION, CONFIG };
