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
// The newest day folders are read first on every run, ahead of any history
// backlog, so a slow or stuck backfill can never delay today's calls. On
// 2026-10-02 one 89 MB May recording failed every run, the scan stopped at
// its day, and every later day (Oct 2's calls included) went unread.
const RECENT_DAYS = 3;
function etYmd(ms) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
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

  // One day folder: file what's new; true when every recording in it is done.
  async function fileDay(day) {
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
      // Too big to copy is permanent, not a retry: log it and move on, so it
      // never holds its day (and every day after it) open.
      if (Number(f.size) > MAX_BYTES) {
        counts.tooLarge = (counts.tooLarge || 0) + 1;
        logger.info('call_center_file_too_large', { fileId: f.id, mb: Math.round(Number(f.size) / 1048576) });
        continue;
      }
      counts.fresh++;
      const match = L.matchLead(parsed.phoneDigits, index);
      const bucketName = L.classifyCall(parsed, match);
      counts.buckets[bucketName] = (counts.buckets[bucketName] || 0) + 1;
      if (!live) continue;
      if (budget <= 0) { finishedDay = false; break; }
      budget--;
      try {
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
    return finishedDay;
  }

  // Newest first: the last RECENT_DAYS folders, today first; then the history
  // backlog in date order, stopping at the first day that isn't finished.
  const recentFrom = L.daysBefore(etYmd(nowMs), RECENT_DAYS - 1);
  const done = new Map();
  for (const day of scan.filter((d) => d.ymd >= recentFrom).reverse()) done.set(day.ymd, await fileDay(day));
  for (const day of scan.filter((d) => d.ymd < recentFrom)) {
    const fin = await fileDay(day);
    done.set(day.ymd, fin);
    if (live && !fin) break;
  }
  // Advance the cursor only past fully-filed days, in date order; today's
  // folder is always re-listed next run (Cube ACR keeps adding to it).
  if (live) for (const day of scan) { if (done.get(day.ymd)) cursor = day.ymd; else break; }

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

// The stored "Looks like X" for a call on no customer (L.suggestLeadForCall:
// exactly one lead matches, or nothing). suggestCheckedAtMs marks it done.
function suggestionPatch(call, leads, nowMs) {
  const s = L.suggestLeadForCall(Object.assign({}, call, { leadId: null }), leads);
  return { suggestedLeadId: s ? s.leadId : null, suggestedLeadName: s ? s.name : null, suggestedWhy: s ? s.why : null, suggestCheckedAtMs: nowMs };
}
const SUGGEST_BACKFILL_PER_RUN = 100;
async function backfillSuggestions({ db, nowMs, leads }) {
  const q = await db.collection(COLLECTION).where('userId', '==', OWNER).where('status', '==', 'noted').where('leadId', '==', null).limit(500).get();
  const todo = [];
  q.forEach((d) => { const v = d.data() || {}; if (!v.suggestCheckedAtMs) todo.push(Object.assign({}, v, { id: d.id })); });
  if (!todo.length) return 0;
  const all = leads || await ownerLeads(db);
  const batch = todo.slice(0, SUGGEST_BACKFILL_PER_RUN);
  for (const c of batch) await db.collection(COLLECTION).doc(c.id).set(suggestionPatch(c, all, nowMs), { merge: true });
  return batch.length;
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
  let leadsForSuggest = null;

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

      // "Looks like X" (2026-10-03): a call on no customer gets its one
      // likely customer stored with it, so every call screen can offer
      // "File on X" in one tap. A suggestion only — never filed by itself.
      if (!call.leadId) {
        if (!leadsForSuggest) leadsForSuggest = await ownerLeads(db);
        await callRef.set(suggestionPatch(Object.assign({}, call, { summary: notes.summary, transcript: t.text }), leadsForSuggest, nowMs), { merge: true });
      }

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

  // Calls noted before suggestions existed get theirs, a batch a run.
  if (live && !allowIds.length) {
    try { out.suggested = await backfillSuggestions({ db, nowMs, leads: leadsForSuggest }); } catch (e) { logger.warn('call_center_suggest_backfill_failed', { err: e && e.message }); }
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
  // "No customer on file": suggest the one existing customer the call is
  // probably about (L.suggestLeadForCall — unique matches only).
  const nofile = items.filter((i) => i.kind === 'nofile' && i.channel === 'call');
  if (nofile.length) {
    const leads = [];
    const ls = await db.collection('leads').where('userId', '==', OWNER).get();
    ls.forEach((d) => { const v = d.data() || {}; leads.push({ id: d.id, firstName: v.firstName, lastName: v.lastName, address: v.address, deleted: v.deleted }); });
    const byId = new Map(calls.map((c) => [c.id, c]));
    for (const it of nofile) {
      const s = L.suggestLeadForCall(byId.get(it.callId), leads);
      if (s) it.suggest = s;
    }
  }
  const counts = { items: items.length, urgent: items.filter((i) => i.kind === 'urgent').length, due: items.filter((i) => i.kind === 'due').length, nofile: items.filter((i) => i.kind === 'nofile').length,
    newLeads: items.filter((i) => i.kind === 'nofile' && i.callType === 'lead' && !i.suggest).length };
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

const TEXT_DAYS = 'phone_text_days';
const TEXTS = 'phone_texts';
const etToday = (nowMs) => new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const noteOf = (c) => ({ summary: c.summary || '', promises: Array.isArray(c.promises) ? c.promises : [], followUpDate: c.followUpDate || null, urgent: !!c.urgent });

function leadInCallTenant(lead, call) {
  return !!((lead.companyId && lead.companyId === call.companyId) || (lead.userId && lead.userId === call.userId));
}

// One call onto one lead: the call doc, and — for a noted call — the same
// timeline entry and create-only follow-up task the notes pass writes. Both
// ids are deterministic (cube-<callId>), so a repeat is a no-op.
async function fileCallOnLead({ db, call, leadId, uid, nowMs, extra }) {
  await db.collection(COLLECTION).doc(call.id).set(Object.assign({
    leadId, bucket: 'customer', alternateLeadIds: [], attachedBy: uid, attachedAtMs: nowMs,
    suggestedLeadId: null, suggestedLeadName: null, suggestedWhy: null,
  }, extra || {}), { merge: true });
  if (call.status !== 'noted') return;
  const owner = call.userId || OWNER;
  const notes = noteOf(call);
  await db.doc('leads/' + leadId + '/activity/cube-' + call.id)
    .set(Object.assign(L.buildCallActivity({ call, notes, ownerUid: owner }), { createdAt: FieldValue.serverTimestamp() }));
  const task = L.buildFollowUpTask({ call, notes, leadId, ownerUid: owner, todayYmd: etToday(nowMs), nowMs });
  if (task) await createIfAbsent(db.doc('leads/' + leadId + '/tasks/cube-' + call.id), Object.assign(task, { createdAt: FieldValue.serverTimestamp() }));
}

// A day of texts onto one lead, with the timeline entry + task text notes write.
async function fileTextDayOnLead({ db, day, leadId, uid, nowMs, extra }) {
  await db.collection(TEXT_DAYS).doc(day.id).set(Object.assign({ leadId, attachedBy: uid, attachedAtMs: nowMs }, extra || {}), { merge: true });
  if (day.status !== 'noted') return;
  const owner = day.userId || OWNER;
  const notes = noteOf(day);
  await db.doc('leads/' + leadId + '/activity/sms-' + day.id)
    .set(Object.assign(L.buildTextDayActivity({ day, notes, ownerUid: owner }), { createdAt: FieldValue.serverTimestamp() }), { merge: true });
  const task = L.buildTextDayTask({ day, notes, leadId, ownerUid: owner, todayYmd: etToday(nowMs), nowMs });
  if (task) await createIfAbsent(db.doc('leads/' + leadId + '/tasks/sms-' + day.id), Object.assign(task, { createdAt: FieldValue.serverTimestamp() }));
}

/**
 * Once a number joins a lead, every call, day of texts and text from that
 * number still on NO lead is filed on it too (2026-10-03: the ingest files a
 * call once and never looks again, so earlier calls from a new customer sat
 * unmatched forever). Same tenant only (the call's userId + companyId); a
 * call already on another lead is never moved. Idempotent: a second pass
 * finds nothing unfiled.
 */
async function refileNumber({ db, call, leadId, uid, nowMs }) {
  const out = { calls: 0, textDays: 0, texts: 0 };
  const digits = String(call.phoneDigits || '');
  if (!/^\d{10}$/.test(digits) || !call.userId) return out;
  const mine = (v) => v && !v.leadId && v.userId === call.userId && (v.companyId || null) === (call.companyId || null);
  const extra = { refiledFrom: call.id };
  const cs = await db.collection(COLLECTION).where('userId', '==', call.userId).where('phoneDigits', '==', digits).get();
  for (const s of cs.docs) {
    const c = Object.assign({}, s.data(), { id: s.id });
    if (s.id === call.id || !mine(c)) continue;
    await fileCallOnLead({ db, call: c, leadId, uid, nowMs, extra });
    out.calls++;
  }
  const ds = await db.collection(TEXT_DAYS).where('userId', '==', call.userId).where('phoneDigits', '==', digits).get();
  for (const s of ds.docs) {
    const d = Object.assign({}, s.data(), { id: s.id });
    if (!mine(d)) continue;
    await fileTextDayOnLead({ db, day: d, leadId, uid, nowMs, extra });
    out.textDays++;
  }
  // The texts themselves, so the customer page shows the thread and the
  // next notes pass keeps the day on this lead.
  const ts = await db.collection(TEXTS).where('userId', '==', call.userId).where('phoneDigits', '==', digits).get();
  const todo = ts.docs.filter((s) => mine(s.data()));
  for (let i = 0; i < todo.length; i += 400) {
    const b = db.batch();
    todo.slice(i, i + 400).forEach((s) => b.set(s.ref, { leadId, bucket: 'customer', alternateLeadIds: [] }, { merge: true }));
    await b.commit();
  }
  out.texts = todo.length;
  return out;
}

// attach: the call, the caller's number onto the lead (blanks only), then
// every other unfiled call / text from that number.
async function attachCallToLead({ db, call, lead, leadId, uid, nowMs }) {
  await fileCallOnLead({ db, call, leadId, uid, nowMs });
  const patch = L.phonePatchForLead(lead, call.phoneDigits);
  if (patch) await db.doc('leads/' + leadId).set(Object.assign(patch, { updatedAt: FieldValue.serverTimestamp() }), { merge: true });
  const refiled = await refileNumber({ db, call, leadId, uid, nowMs });
  return { phoneAdded: !!patch, refiled };
}

// move: copy the timeline entry and task to the new lead first, then remove
// the old ones, then re-point the call — so a retry after any failure
// finishes the job (the call still names the old lead until the end).
async function moveCallToLead({ db, call, fromId, toId, to, uid, nowMs }) {
  const id = call.id;
  const oldAct = db.doc('leads/' + fromId + '/activity/cube-' + id);
  const oldTask = db.doc('leads/' + fromId + '/tasks/cube-' + id);
  const [a, t] = await Promise.all([oldAct.get(), oldTask.get()]);
  let activityMoved = false, taskMoved = false;
  if (a.exists) {
    await db.doc('leads/' + toId + '/activity/cube-' + id).set(Object.assign({}, a.data(), { movedFromLeadId: fromId }));
    activityMoved = true;
  } else if (call.status === 'noted') {
    await db.doc('leads/' + toId + '/activity/cube-' + id)
      .set(Object.assign(L.buildCallActivity({ call, notes: noteOf(call), ownerUid: call.userId || OWNER }), { createdAt: FieldValue.serverTimestamp() }));
  }
  if (t.exists) {
    await createIfAbsent(db.doc('leads/' + toId + '/tasks/cube-' + id), Object.assign({}, t.data(), { leadId: toId, movedFromLeadId: fromId, updatedAt: FieldValue.serverTimestamp() }));
    taskMoved = true;
  }
  if (a.exists) await oldAct.delete();
  if (t.exists) await oldTask.delete();
  const patch = L.phonePatchForLead(to, call.phoneDigits);
  if (patch) await db.doc('leads/' + toId).set(Object.assign(patch, { updatedAt: FieldValue.serverTimestamp() }), { merge: true });
  await db.collection(COLLECTION).doc(id).set({ leadId: toId, bucket: 'customer', alternateLeadIds: [], movedFromLeadId: fromId, movedBy: uid, movedAtMs: nowMs }, { merge: true });
  return { activityMoved, taskMoved, phoneAdded: !!patch };
}

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
    if (!leadInCallTenant(lead, call)) throw new HttpsError('permission-denied', 'That customer is not in your company.');
    const r = await attachCallToLead({ db, call, lead, leadId, uid: auth.uid, nowMs });
    return { ok: true, leadId, phoneAdded: r.phoneAdded, refiled: r.refiled };
  }
  // "Wrong customer → move to…" from the customer page (2026-10-03): the
  // call, its timeline entry and its follow-up task leave the lead they were
  // filed on and land on the chosen one. Both leads must be in the call's
  // company. The caller's number is added to the new lead (blanks only);
  // it is never removed from the old one (it may be theirs too).
  if (action === 'move') {
    const toId = String((data && data.leadId) || '');
    if (!toId || toId.includes('/')) throw new HttpsError('invalid-argument', 'Bad lead id.');
    const fromId = call.leadId ? String(call.leadId) : '';
    if (!fromId) throw new HttpsError('failed-precondition', 'This call is not filed on a customer — attach it instead.');
    if (fromId === toId) return { ok: true, leadId: toId, moved: false };
    const [fs, ts] = await Promise.all([db.doc('leads/' + fromId).get(), db.doc('leads/' + toId).get()]);
    const from = fs.exists ? fs.data() : null;
    const to = ts.exists ? ts.data() : null;
    if (!to || to.deleted === true) throw new HttpsError('not-found', 'Customer not found.');
    if (!leadInCallTenant(to, call) || (from && !leadInCallTenant(from, call))) throw new HttpsError('permission-denied', 'That customer is not in your company.');
    const r = await moveCallToLead({ db, call, fromId, toId, to, uid: auth.uid, nowMs });
    return Object.assign({ ok: true, leadId: toId, moved: true }, r);
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

// callTaggedMatch — "Match my tagged contacts" (2026-10-03). Owner (or
// platform admin) only. { } previews: calls to phone contacts tagged
// "NBD Customer" that sit on no lead, each number paired with the one lead
// it matches (L.taggedContactPlan) or listed as not in the CRM yet. Nothing
// is written. { confirm: [{ key, leadId }] } files exactly the rows Jo
// confirmed — re-planned server-side, and a row whose match changed since
// the preview is skipped, never guessed at.
async function taggedMatch({ db, auth, data, nowMs }) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const role = String((auth.token || {}).role || '');
  if (!(auth.uid === OWNER || role === 'admin')) throw new HttpsError('permission-denied', 'This is the owner\'s phone.');
  const calls = [];
  const q = await db.collection(COLLECTION).where('userId', '==', OWNER).where('leadId', '==', null).get();
  q.forEach((d) => calls.push(Object.assign({}, d.data(), { id: d.id })));
  const leads = await ownerLeads(db);
  const plan = L.taggedContactPlan({ calls, leads });
  const confirm = Array.isArray(data && data.confirm) ? data.confirm.slice(0, 500) : null;
  if (!confirm) {
    return { matches: plan.matches, notInCrm: plan.notInCrm.map((r) => ({ key: r.key, phoneDigits: r.phoneDigits, contactName: r.contactName, calls: r.callIds.length, ambiguous: r.ambiguous })) };
  }
  const byKey = new Map(plan.matches.map((m) => [m.key, m]));
  const callById = new Map(calls.map((c) => [c.id, c]));
  const leadById = new Map(leads.map((l) => [l.id, l]));
  const out = { filed: 0, calls: 0, skipped: 0 };
  for (const want of confirm) {
    const row = want && byKey.get(String(want.key || ''));
    const lead = row && leadById.get(row.leadId);
    if (!row || row.leadId !== String(want.leadId || '') || !lead) { out.skipped++; continue; }
    const first = callById.get(row.callIds[0]);
    // A number: attaching its newest call re-files the rest. No number
    // (contact-name match): each call is filed on its own.
    const r = await attachCallToLead({ db, call: first, lead, leadId: row.leadId, uid: auth.uid, nowMs });
    out.calls += 1 + r.refiled.calls;
    if (!row.phoneDigits) {
      for (const id of row.callIds.slice(1)) { await fileCallOnLead({ db, call: callById.get(id), leadId: row.leadId, uid: auth.uid, nowMs }); out.calls++; }
    }
    out.filed++;
  }
  return out;
}

exports.callTaggedMatch = onCall(
  { region: 'us-central1', enforceAppCheck: true, memory: '512MiB', timeoutSeconds: 120, maxInstances: 2 },
  (request) => taggedMatch({ db: getFirestore(), auth: request.auth, data: request.data, nowMs: Date.now() })
);

exports.claudeNotes = claudeNotes;

exports._test = {
  runIngest,
  runTranscribe,
  runSweep,
  gatherSweep,
  promisesList,
  callAction,
  taggedMatch,
  refileNumber,
  backfillSuggestions,
  setActionDeps(x) { deps_ = x || {}; },
  setClient(c) { _testClient = c; },
  setDeps(x) { _deps = x; },
  OWNER, COLLECTION, CONFIG,
};
