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

  // History starts 2026-01-01 and never earlier (L.HISTORY_FROM). If the floor
  // moved since the cursor was built, the scan restarts at it once.
  const floor = L.historyFloor(cfg.backfillFrom);
  const startCursor = L.scanCursor(cfg, floor);
  const days = await listAll("'" + root + "' in parents and mimeType = '" + FOLDER_MIME + "' and trashed = false", 'id, name');
  const scan = L.foldersToScan(days, startCursor, floor);

  const index = L.buildPhoneIndex(await ownerLeads(db));
  const counts = { folders: scan.length, seen: 0, fresh: 0, stored: 0, skipped: 0, failed: 0, buckets: {} };
  let cursor = startCursor;
  let budget = MAX_FILES_PER_RUN;

  for (const day of scan) {
    const files = await listAll("'" + day.id + "' in parents and trashed = false", 'id, name, size, mimeType, createdTime');
    files.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    let finishedDay = true;
    // One batched read per day folder for "already filed?".
    // Sidecars (.json, Cube ACR's per-call metadata) by name: duration only.
    const sidecars = new Map(files.filter((f) => /\.json$/i.test(f.name || '')).map((f) => [f.name, f]));
    const refs = files.map((f) => db.collection(COLLECTION).doc(L.callDocId(f.id)));
    const have = new Set();
    if (refs.length) (await db.getAll(...refs)).forEach((s) => { if (s.exists) have.add(s.id); });
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (sidecars.has(f.name)) continue; // read alongside its recording
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
        let durationSec = null;
        const side = sidecars.get(L.sidecarNameFor(f.name));
        if (side) {
          try { const meta = L.parseSidecar((await download(side.id)).toString('utf8')); if (meta) durationSec = meta.durationSec; } catch (_) { /* duration is optional */ }
        }
        if (durationSec != null && durationSec < L.SHORT_CALL_SEC) counts.short = (counts.short || 0) + 1;
        await bucket.file(path).save(bytes, { contentType: parsed.ext === 'm4a' ? 'audio/mp4' : (f.mimeType || 'application/octet-stream'), resumable: false, metadata: { cacheControl: 'private, max-age=0' } });
        await docRef.set(Object.assign(L.buildCallDoc({ ownerUid: OWNER, file: f, parsed, match, bucket: bucketName, storedPath: path, nowMs, durationSec }), { createdAt: FieldValue.serverTimestamp() }));
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
    // Recorded only by a live run, so a dry run never uses up the rescan.
    floorApplied: live ? floor : (cfg.floorApplied || null),
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

// ═══════════════════════════════════════════════════════════════════════
// Stage 2 — transcript + AI notes (2026-10-01)
// ═══════════════════════════════════════════════════════════════════════
//
// Every 30 minutes: take stored calls, transcribe with Groq Whisper (the key
// and helper Voice Intelligence already use: free tier, 8 h audio/day), have
// Claude Haiku write the notes (summary, who promised what, a follow-up
// date), and file them:
//   phone_calls/{id}          status 'noted' + transcript + notes
//   leads/{id}/activity/cube-{id}   the customer timeline entry
//   leads/{id}/tasks/cube-{id}      ONE follow-up task, only when Jo promised
//                                   something or a follow-up date came out
// A call the model calls "personal" keeps no transcript, files nothing, and
// its CRM audio copy is deleted (the original stays in Jo's Drive).
//
// Gate: CALL_CENTER_TRANSCRIBE_ENABLED=true runs the backlog (newest first,
// 12 a run, ≤ 7.5 h audio a day). With the gate OFF, only the ids on
// integrations/callCenter.transcribeOnly run — Jo's one-call test.
// The AI kill switch (integrations/killswitch) stops it too.

const { defineSecret } = require('firebase-functions/params');
const { SECRETS, secretValue } = require('./integrations/_shared');
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const NOTES_MODEL = 'claude-haiku-4-5-20251001';
const TRANSCRIBE_PER_RUN = 12;
const transcribeEnabled = () => process.env.CALL_CENTER_TRANSCRIBE_ENABLED === 'true';

let _deps = null;
function deps() {
  if (_deps) return _deps;
  const { transcribeGroqBuffer } = require('./integrations/voice-intelligence');
  return {
    transcribe: (buffer, ext) => transcribeGroqBuffer({ buffer, mimeType: ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg', filename: 'call.' + (ext || 'm4a'), timeoutMs: 300_000 }),
    notes: claudeNotes,
  };
}

// Shared with text-inbox.js (textInboxNotes binds its own ANTHROPIC_API_KEY).
async function claudeNotes({ system, prompt }) {
  const key = secretValue(ANTHROPIC_API_KEY);
  if (!key) throw new Error('anthropic-not-configured');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key },
    body: JSON.stringify({ model: NOTES_MODEL, max_tokens: 900, system, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error('anthropic ' + res.status + ': ' + String((data && data.error && data.error.message) || '').slice(0, 200));
  const text = ((data && data.content) || []).map((c) => (c && c.type === 'text' ? c.text : '')).join('').trim();
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('notes: no JSON');
  return JSON.parse(m[0]);
}

async function createIfAbsent(ref, data) {
  try { await ref.create(data); return true; } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) return false;
    throw e;
  }
}

/** One transcription pass. Exported for the integration test (stubbed deps). */
async function runTranscribe({ db, bucket, live, nowMs }) {
  const ref = db.doc(CONFIG);
  const snap = await ref.get();
  const cfg = snap.exists ? snap.data() : {};
  if (cfg.paused === true) return { state: 'paused' };
  const allowIds = Array.isArray(cfg.transcribeOnly) ? cfg.transcribeOnly : [];
  if (!live && !allowIds.length) return { state: 'off' };

  const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const usedSec = (cfg.audioSecDay === today && Number(cfg.audioSecUsed)) || 0;
  const secLeft = L.dayAudioCapSec(cfg.dayAudioCapHours) - usedSec;

  let candidates = [];
  if (allowIds.length) {
    const snaps = await db.getAll(...allowIds.map((id) => db.collection(COLLECTION).doc(id)));
    candidates = snaps.filter((s) => s.exists).map((s) => Object.assign({}, s.data(), { id: s.id }));
  } else {
    const q = await db.collection(COLLECTION).where('userId', '==', OWNER).where('status', '==', 'stored')
      .orderBy('startedAtMs', 'desc').limit(TRANSCRIBE_PER_RUN * 3).get();
    q.forEach((d) => candidates.push(Object.assign({}, d.data(), { id: d.id })));
  }
  const pick = L.pickToTranscribe(candidates, { live, allowIds, maxCount: TRANSCRIBE_PER_RUN, secLeft });
  const out = { state: allowIds.length ? 'test' : 'live', picked: pick.length, noted: 0, personal: 0, failed: 0, tasks: 0, audioSec: 0 };
  const d = deps();

  for (const call of pick) {
    const callRef = db.collection(COLLECTION).doc(call.id);
    try {
      if ((Number(call.sizeBytes) || 0) > L.GROQ_MAX_BYTES) {
        await callRef.set({ status: 'too_large' }, { merge: true });
        continue;
      }
      const [buf] = await bucket.file(call.storagePath).download();
      const t = await d.transcribe(buf, String(call.storagePath).split('.').pop());
      out.audioSec += Number(t.durationSec) || L.estimateAudioSec(call.sizeBytes);

      let leadName = '';
      if (call.leadId) {
        const ls = await db.doc('leads/' + call.leadId).get();
        if (ls.exists) { const l = ls.data(); leadName = ((l.firstName || '') + ' ' + (l.lastName || '')).trim(); }
      }
      const notes = L.sanitizeNotes(await d.notes({ system: L.NOTES_SYSTEM, prompt: L.buildNotesPrompt({ call, transcript: t.text, leadName }) }));
      // Jo said "it wasn't personal" (callCenterAction notpersonal): the
      // model's personal verdict is overridden; the call is filed as business.
      if (call.notPersonal === true && notes.callType === 'personal') notes.callType = 'other';
      const personal = notes.callType === 'personal';
      await callRef.set({
        status: personal ? 'personal' : 'noted',
        transcript: personal ? null : String(t.text || '').slice(0, 100000),
        durationSec: Number(t.durationSec) || Number(call.durationSec) || null,
        summary: notes.summary,
        callType: notes.callType,
        promises: notes.promises,
        followUpDate: notes.followUpDate,
        urgent: notes.urgent,
        notedAtMs: nowMs,
      }, { merge: true });
      if (personal) {
        // Jo, 2026-10-01: a personal call keeps no CRM copy of its audio
        // either. The original recording stays in Jo's own Drive, so a
        // misjudged call is still recoverable there.
        try {
          await bucket.file(call.storagePath).delete({ ignoreNotFound: true });
          await callRef.set({ storagePath: null, audioRemoved: 'personal' }, { merge: true });
        } catch (e) {
          logger.warn('call_center_personal_audio_delete_failed', { id: call.id, err: e && e.message });
        }
        out.personal++;
        continue;
      }
      out.noted++;

      if (call.leadId) {
        const full = Object.assign({}, call, { durationSec: Number(t.durationSec) || 0 });
        await db.doc('leads/' + call.leadId + '/activity/cube-' + call.id)
          .set(Object.assign(L.buildCallActivity({ call: full, notes, ownerUid: OWNER }), { createdAt: FieldValue.serverTimestamp() }));
        const task = L.buildFollowUpTask({ call: full, notes, leadId: call.leadId, ownerUid: OWNER, todayYmd: today, nowMs });
        // create(): a re-run must never un-tick a task Jo already completed.
        if (task && await createIfAbsent(db.doc('leads/' + call.leadId + '/tasks/cube-' + call.id), Object.assign(task, { createdAt: FieldValue.serverTimestamp() }))) out.tasks++;
      }
    } catch (e) {
      // Groq's hourly/daily rate limit is about the account, not this call:
      // no strike, and stop the run (every later call would be refused too).
      // The next half-hourly run picks up where this one stopped.
      if (L.isRateLimited(e)) {
        out.rateLimited = true;
        await callRef.set({ transcribeError: String((e && e.message) || e).slice(0, 300), rateLimitedAtMs: nowMs }, { merge: true }).catch(() => {});
        logger.info('call_center_transcribe_rate_limited', { id: call.id, noted: out.noted });
        break;
      }
      out.failed++;
      await callRef.set({ transcribeAttempts: (Number(call.transcribeAttempts) || 0) + 1, transcribeError: String((e && e.message) || e).slice(0, 300) }, { merge: true }).catch(() => {});
      logger.warn('call_center_transcribe_failed', { id: call.id, err: e && e.message });
    }
  }

  const patch = { audioSecDay: today, audioSecUsed: usedSec + out.audioSec, lastTranscribeAtMs: nowMs, lastTranscribe: out };
  // The one-call test runs once: clear the ids it handled.
  if (allowIds.length) patch.transcribeOnly = allowIds.filter((id) => !pick.some((c) => c.id === id));
  await ref.set(patch, { merge: true });
  return out;
}

exports.callCenterTranscribe = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'America/New_York', timeoutSeconds: 540, memory: '1GiB', secrets: [SECRETS.GROQ_API_KEY, ANTHROPIC_API_KEY] },
  async () => {
    try {
      if (await require('./integrations/killswitch').isAiDisabled()) { logger.info('[callCenterTranscribe] AI kill switch on'); return; }
      const r = await runTranscribe({ db: getFirestore(), bucket: getStorage().bucket(), live: transcribeEnabled(), nowMs: Date.now() });
      logger.info('[callCenterTranscribe]', r);
    } catch (e) {
      logger.warn('[callCenterTranscribe] failed', { err: e && e.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════
// Stage 3 — the "you said you'd…" sweep (2026-10-01)
// ═══════════════════════════════════════════════════════════════════════
// 07:15 and 15:15 ET: one email to Jo (users/{owner}.email) listing open
// promises from Jo's calls (call-center-logic.js collectSweepItems). Nothing
// open → nothing sent. DRY-RUN (logs counts) unless
// CALL_CENTER_SWEEP_ENABLED=true. Internal mail only — never a homeowner.

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const sweepEnabled = () => process.env.CALL_CENTER_SWEEP_ENABLED === 'true';

// The open "you said you'd…" items, uncapped — ONE source for the email and
// the Call Center deck (callPromisesList), so the two can't disagree.
async function gatherSweep({ db, nowMs }) {
  const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const calls = [];
  const q = await db.collection(COLLECTION).where('userId', '==', OWNER).where('status', '==', 'noted')
    .orderBy('startedAtMs', 'desc').limit(300).get();
  q.forEach((d) => calls.push(Object.assign({}, d.data(), { id: d.id })));
  // Texts (textInboxNotes): a texted promise counts like a spoken one.
  const tq = await db.collection('phone_text_days').where('userId', '==', OWNER).where('status', '==', 'noted')
    .orderBy('startedAtMs', 'desc').limit(300).get();
  tq.forEach((d) => calls.push(Object.assign({}, d.data(), { id: d.id, channel: 'text' })));
  const withLead = calls.filter((c) => c.leadId);
  const tasksByCallId = new Map();
  if (withLead.length) {
    const snaps = await db.getAll(...withLead.map((c) => db.doc('leads/' + c.leadId + '/tasks/' + (c.channel === 'text' ? 'sms-' : 'cube-') + c.id)));
    snaps.forEach((s, i) => { if (s.exists) tasksByCallId.set(withLead[i].id, s.data()); });
  }
  const items = L.collectSweepItems({ calls, tasksByCallId, nowMs, todayYmd: today });
  const counts = { items: items.length, urgent: items.filter((i) => i.kind === 'urgent').length, due: items.filter((i) => i.kind === 'due').length, nofile: items.filter((i) => i.kind === 'nofile').length };
  return { today, items, counts };
}

async function runSweep({ db, live, nowMs, send, slot }) {
  const user = await db.collection('users').doc(OWNER).get();
  const email = user.exists ? String((user.data() || {}).email || '') : '';
  const { today, items, counts } = await gatherSweep({ db, nowMs });
  if (!items.length) return Object.assign({ state: 'nothing' }, counts);
  if (!live) return Object.assign({ state: 'dry_run' }, counts);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Object.assign({ state: 'no_email' }, counts);
  const mail = L.buildSweepEmail({ items, todayYmd: today, slot });
  await send({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
  return Object.assign({ state: 'sent' }, counts);
}

exports.callCenterSweep = onSchedule(
  { schedule: '15 7,15 * * *', timeZone: 'America/New_York', timeoutSeconds: 120, memory: '512MiB', maxInstances: 1, secrets: [RESEND_API_KEY, EMAIL_FROM] },
  async () => {
    try {
      const nowMs = Date.now();
      const hour = Number(new Date(nowMs).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
      const r = await runSweep({
        db: getFirestore(), live: sweepEnabled(), nowMs, slot: hour >= 12 ? 'pm' : 'am',
        send: async (m) => {
          const key = secretValue(RESEND_API_KEY);
          if (!key) throw new Error('no-resend-key');
          const { Resend } = require('resend');
          const { resendRejected, resendErrorMessage } = require('./resend-guard');
          // Email category: INTERNAL — Jo's own reminder, never a homeowner.
          const resp = await new Resend(key).emails.send({ from: secretValue(EMAIL_FROM) || 'NBD Pro <noreply@nobigdealwithjoedeal.com>', to: m.to, subject: m.subject, html: m.html, text: m.text });
          if (resendRejected(resp)) throw new Error('resend: ' + resendErrorMessage(resp));
        },
      });
      logger.info('[callCenterSweep]', r);
    } catch (e) {
      logger.warn('[callCenterSweep] failed', { err: e && e.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════
// callCenterAction — the Call Center screen's writes (phone_calls is
// server-written only). Same audience as thursdayCallAction: the call's
// owner, an admin, or company_admin / manager of the call's company;
// viewers and sales reps are refused.
//   handled / unhandled  — drop a call off (or back onto) the sweep
//   attach {leadId}      — file the call on a customer in the same tenant:
//                          leadId + bucket 'customer', the caller's number
//                          onto the lead (blanks only), and — if the call is
//                          already noted — the timeline entry + follow-up task
// ═══════════════════════════════════════════════════════════════════════
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const COMPANY_STAFF = ['company_admin', 'manager'];

// Test seam for notpersonal (Drive download + bucket).
let deps_ = {};

async function callAction({ db, auth, data, nowMs }) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const id = String((data && data.id) || '');
  // cube_… = a phone call; txt_… = a day of texts (phone_text_days, 2026-10-02).
  const isText = /^txt_[0-9_]{10,40}$/.test(id);
  if (!isText && !/^cube_[A-Za-z0-9_-]{5,120}$/.test(id)) throw new HttpsError('invalid-argument', 'Bad call id.');
  const ref = db.collection(isText ? 'phone_text_days' : COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Call not found.');
  const call = Object.assign({}, snap.data(), { id });
  const token = auth.token || {};
  const role = String(token.role || '');
  if (role === 'viewer') throw new HttpsError('permission-denied', 'Your role is view-only.');
  const sameCompany = !!(token.companyId && call.companyId && token.companyId === call.companyId);
  if (!(role === 'admin' || auth.uid === call.userId || (sameCompany && COMPANY_STAFF.includes(role)))) {
    throw new HttpsError('permission-denied', 'Not your call.');
  }
  const action = String((data && data.action) || '');
  if (action === 'handled' || action === 'unhandled') {
    await ref.set({ handledAtMs: action === 'handled' ? nowMs : null, handledBy: auth.uid }, { merge: true });
    return { ok: true };
  }
  // The "Said you'd do" deck (2026-10-03). Done ticks the call's follow-up
  // task exactly as the customer page does (done + completedAt); Snooze
  // moves that task's due date, or — for a call with no customer/task —
  // parks the call itself (snoozeUntilYmd, read by collectSweepItems).
  // Each has an undo. Applies to calls and texts alike.
  if (action === 'taskDone' || action === 'taskUndone' || action === 'snooze' || action === 'unsnooze') {
    const taskRef = call.leadId ? db.doc('leads/' + call.leadId + '/tasks/' + (isText ? 'sms-' : 'cube-') + id) : null;
    const tSnap = taskRef ? await taskRef.get() : null;
    const task = tSnap && tSnap.exists ? tSnap.data() : null;
    const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (action === 'taskDone' || action === 'taskUndone') {
      if (!task) throw new HttpsError('failed-precondition', 'This call has no follow-up task — mark it handled instead.');
      const done = action === 'taskDone';
      await taskRef.set({ done, completedAt: done ? FieldValue.serverTimestamp() : null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { ok: true, done };
    }
    if (action === 'snooze') {
      const days = Math.round(Number(data && data.days));
      if (!(days >= 1 && days <= 30)) throw new HttpsError('invalid-argument', 'Snooze 1–30 days.');
      const until = L.addDaysYmd(today, days);
      if (task) {
        await taskRef.set({ dueDate: until, snoozedFromDue: task.snoozedFromDue || task.dueDate || today, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return { ok: true, until, on: 'task' };
      }
      await ref.set({ snoozeUntilYmd: until, snoozedBy: auth.uid }, { merge: true });
      return { ok: true, until, on: 'call' };
    }
    // unsnooze
    if (task && task.snoozedFromDue) {
      await taskRef.set({ dueDate: task.snoozedFromDue, snoozedFromDue: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { ok: true, on: 'task' };
    }
    await ref.set({ snoozeUntilYmd: null }, { merge: true });
    return { ok: true, on: 'call' };
  }
  // Texts are matched to customers by the text ingest itself; only Handled applies.
  if (isText) throw new HttpsError('invalid-argument', 'Only Handled applies to texts.');
  if (action === 'attach') {
    const leadId = String((data && data.leadId) || '');
    if (!leadId || leadId.includes('/')) throw new HttpsError('invalid-argument', 'Bad lead id.');
    const ls = await db.doc('leads/' + leadId).get();
    const lead = ls.exists ? ls.data() : null;
    if (!lead || lead.deleted === true) throw new HttpsError('not-found', 'Customer not found.');
    const tenantOk = (lead.companyId && lead.companyId === call.companyId) || (lead.userId && lead.userId === call.userId);
    if (!tenantOk) throw new HttpsError('permission-denied', 'That customer is not in your company.');
    await ref.set({ leadId, bucket: 'customer', alternateLeadIds: [], attachedBy: auth.uid, attachedAtMs: nowMs }, { merge: true });
    const patch = L.phonePatchForLead(lead, call.phoneDigits);
    if (patch) await db.doc('leads/' + leadId).set(Object.assign(patch, { updatedAt: FieldValue.serverTimestamp() }), { merge: true });
    if (call.status === 'noted') {
      const notes = { summary: call.summary || '', promises: call.promises || [], followUpDate: call.followUpDate || null, urgent: !!call.urgent };
      const owner = call.userId || OWNER;
      await db.doc('leads/' + leadId + '/activity/cube-' + id)
        .set(Object.assign(L.buildCallActivity({ call, notes, ownerUid: owner }), { createdAt: FieldValue.serverTimestamp() }));
      const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const task = L.buildFollowUpTask({ call, notes, leadId, ownerUid: owner, todayYmd: today, nowMs });
      if (task) await createIfAbsent(db.doc('leads/' + leadId + '/tasks/cube-' + id), Object.assign(task, { createdAt: FieldValue.serverTimestamp() }));
    }
    return { ok: true, leadId, phoneAdded: !!patch };
  }
  if (action === 'notpersonal') {
    // The model called it personal: its CRM audio copy was deleted and no
    // notes were kept. Re-copy the recording from Jo's Drive (the original
    // never left) and put the call back in the transcription queue, marked
    // so the personal verdict can't recur.
    if (call.status !== 'personal') throw new HttpsError('failed-precondition', 'Only a call marked personal can be redone.');
    if (!call.driveFileId) throw new HttpsError('failed-precondition', 'No original recording on file.');
    const ext = String(call.fileName || '').split('.').pop().toLowerCase() || 'm4a';
    const path = L.storagePath(call.userId || OWNER, call.ymd || 'unknown', call.driveFileId, ext);
    const bytes = await (deps_.download || download)(call.driveFileId);
    await (deps_.bucket || getStorage().bucket()).file(path).save(bytes, { contentType: ext === 'm4a' ? 'audio/mp4' : 'application/octet-stream', resumable: false, metadata: { cacheControl: 'private, max-age=0' } });
    await ref.set({ status: 'stored', storagePath: path, audioRemoved: null, notPersonal: true, summary: null, callType: null, transcribeAttempts: 0, notPersonalBy: auth.uid, notPersonalAtMs: nowMs }, { merge: true });
    return { ok: true, requeued: true };
  }
  throw new HttpsError('invalid-argument', 'Unknown action.');
}

exports.callCenterAction = onCall(
  { region: 'us-central1', enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 30, maxInstances: 10 },
  (request) => callAction({ db: getFirestore(), auth: request.auth, data: request.data, nowMs: Date.now() })
);

// callPromisesList — the Call Center "Said you'd do" deck's list: every open
// item the sweep email is built from (uncapped). Owner (or platform admin)
// only: the sweep is the owner's own calls.
async function promisesList({ db, auth, nowMs }) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const role = String((auth.token || {}).role || '');
  if (!(auth.uid === OWNER || role === 'admin')) throw new HttpsError('permission-denied', 'This list is the owner\'s calls.');
  const { today, items, counts } = await gatherSweep({ db, nowMs });
  return { today, items, counts };
}

exports.callPromisesList = onCall(
  { region: 'us-central1', enforceAppCheck: true, memory: '512MiB', timeoutSeconds: 60, maxInstances: 5 },
  (request) => promisesList({ db: getFirestore(), auth: request.auth, nowMs: Date.now() })
);

exports.claudeNotes = claudeNotes;

exports._test = {
  runIngest,
  runTranscribe,
  runSweep,
  gatherSweep,
  promisesList,
  callAction,
  setActionDeps(x) { deps_ = x || {}; },
  setClient(c) { _testClient = c; },
  setDeps(x) { _deps = x; },
  OWNER, COLLECTION, CONFIG,
};
