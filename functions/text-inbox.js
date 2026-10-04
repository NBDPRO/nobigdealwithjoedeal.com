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
 *   - reads texts newer than the cursor minus 3 days (from 2026-01-01 on the
 *     first run, never earlier: T.HISTORY_FROM_MS); doc ids are content
 *     hashes, so overlap never duplicates
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

  const since = T.sinceFor(cfg.cursorMs || null, nowMs);
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

// ═══════════════════════════════════════════════════════════════════════
// Text notes (2026-10-01): one AI note per conversation-day
// ═══════════════════════════════════════════════════════════════════════
// Every hour: group the last 3 days of phone_texts into conversation-days
// (one number, one Eastern day; group texts skipped), and for each day that
// has gone quiet for 2 h and changed since it was last noted, have Claude
// Haiku write the same notes calls get (summary, who promised what,
// follow-up, urgent). Filed as phone_text_days/{txt_<digits>_<ymd>}; for a
// customer, a timeline entry leads/{id}/activity/sms-{dayId} and — for days
// in the last 14 — ONE create-only follow-up task leads/{id}/tasks/sms-{dayId}
// when Jo promised something. Personal days keep no summary detail and file
// nothing. The "you said you'd…" sweep reads these alongside calls.
// DRY-RUN (counts only) unless TEXT_NOTES_ENABLED=true; AI kill switch too.

const { defineSecret } = require('firebase-functions/params');
const { FieldValue } = require('firebase-admin/firestore');
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const DAYS = 'phone_text_days';
const NOTES_PER_RUN = 30;
const notesEnabled = () => process.env.TEXT_NOTES_ENABLED === 'true';
let _notesFn = null;

async function createIfAbsent(ref, data) {
  try { await ref.create(data); return true; } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) return false;
    throw e;
  }
}

async function runTextNotes({ db, live, nowMs }) {
  const rows = [];
  const q = await db.collection(COLLECTION).where('userId', '==', OWNER).where('sentAtMs', '>=', nowMs - 3 * 24 * 3600 * 1000)
    .orderBy('sentAtMs', 'desc').limit(3000).get();
  q.forEach((d) => rows.push(Object.assign({}, d.data(), { id: d.id })));
  const days = T.groupTextDays(rows, { nowMs });
  const refs = days.map((d) => db.collection(DAYS).doc(d.id));
  const have = new Map();
  if (refs.length) (await db.getAll(...refs)).forEach((s) => { if (s.exists) have.set(s.id, s.data()); });
  const todo = days.filter((d) => !have.has(d.id) || have.get(d.id).sig !== d.sig).slice(0, NOTES_PER_RUN);
  const out = { days: days.length, pending: todo.length, noted: 0, personal: 0, tasks: 0, failed: 0 };
  if (!live) return Object.assign({ state: 'dry_run' }, out);

  const notesFn = _notesFn || require('./call-center').claudeNotes;
  const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (const day of todo) {
    try {
      let leadName = '';
      if (day.leadId) {
        const ls = await db.doc('leads/' + day.leadId).get();
        if (ls.exists) { const l = ls.data(); leadName = ((l.firstName || '') + ' ' + (l.lastName || '')).trim(); }
      }
      const notes = CC.sanitizeNotes(await notesFn({ system: T.TEXT_NOTES_SYSTEM, prompt: T.buildTextNotesPrompt({ day, leadName }), feature: 'text-notes' }));
      const personal = notes.callType === 'personal';
      if (personal) notes.summary = 'Personal texts.';
      await db.collection(DAYS).doc(day.id).set({
        userId: OWNER, companyId: OWNER, channel: 'text',
        status: personal ? 'personal' : 'noted',
        leadId: day.leadId, contactName: day.contactName, phoneDigits: day.phoneDigits, ymd: day.ymd,
        startedAtMs: day.lastAtMs, sig: day.sig, messageCount: day.messages.length,
        summary: notes.summary, callType: notes.callType, promises: notes.promises,
        followUpDate: notes.followUpDate, urgent: notes.urgent, notedAtMs: nowMs,
      }, { merge: true });
      if (personal) { out.personal++; continue; }
      out.noted++;
      if (day.leadId) {
        const dayInfo = { id: day.id, contactName: day.contactName, messageCount: day.messages.length, startedAtMs: day.lastAtMs };
        await db.doc('leads/' + day.leadId + '/activity/sms-' + day.id).set(Object.assign(
          CC.buildTextDayActivity({ day: dayInfo, notes, ownerUid: OWNER }), { createdAt: FieldValue.serverTimestamp() }), { merge: true });
        const task = CC.buildTextDayTask({ day: dayInfo, notes, leadId: day.leadId, ownerUid: OWNER, todayYmd: today, nowMs });
        if (task) {
          if (await createIfAbsent(db.doc('leads/' + day.leadId + '/tasks/sms-' + day.id), Object.assign(task, { createdAt: FieldValue.serverTimestamp() }))) out.tasks++;
        }
      }
    } catch (e) {
      out.failed++;
      logger.warn('text_notes_failed', { id: day.id, err: e && e.message });
    }
  }
  await db.doc(CONFIG).set({ lastNotesAtMs: nowMs, lastNotes: out }, { merge: true });
  return Object.assign({ state: 'noted' }, out);
}

exports.textInboxNotes = onSchedule(
  { schedule: 'every 60 minutes', timeZone: 'America/New_York', timeoutSeconds: 540, memory: '512MiB', maxInstances: 1, secrets: [ANTHROPIC_API_KEY] },
  async () => {
    try {
      if (await require('./integrations/killswitch').isAiDisabled()) { logger.info('[textInboxNotes] AI kill switch on'); return; }
      const r = await runTextNotes({ db: getFirestore(), live: notesEnabled(), nowMs: Date.now() });
      logger.info('[textInboxNotes]', r);
    } catch (e) {
      logger.warn('[textInboxNotes] failed', { err: e && e.message });
    }
  }
);

exports._test = { runTextIngest, runTextNotes, setNotes(fn) { _notesFn = fn; }, setClient(c) { _testClient = c; }, OWNER, COLLECTION, CONFIG, DAYS };
