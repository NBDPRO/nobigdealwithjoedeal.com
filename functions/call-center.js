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
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const L = require('./call-center-logic');
const PR = require('./promise-logic');
const CL = require('./contact-labels');
const PV = require('./ping-volume-logic'); // digest dedupe + the repeat-number summary line (audit F6/F7)

const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

// The missed-call auto-text's sender (missed-call-autotext.js; dark unless
// MISSED_CALL_AUTOTEXT_ENABLED === 'true'). Same Secret Manager names
// lead-alert.js uses; the Twilio SDK loads only on a real send.
const { defineSecret: _defineSecret } = require('firebase-functions/params');
const TWILIO_ACCOUNT_SID = _defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = _defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_PHONE_NUMBER = _defineSecret('TWILIO_PHONE_NUMBER');
async function sendAutoText({ to, body }) {
  const { secretValue: sv } = require('./integrations/_shared');
  const sid = sv(TWILIO_ACCOUNT_SID), tok = sv(TWILIO_AUTH_TOKEN), from = sv(TWILIO_PHONE_NUMBER);
  if (!sid || !tok || !from) throw new Error('twilio-not-configured');
  return require('twilio')(sid, tok).messages.create({ to, from, body });
}
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
  // Numbers Jo labeled personal AND confirmed "stop copying and transcribing"
  // (contact-labels.js captureOff): listed so the cursor advances, never copied.
  const labels = await CL.loadLabels(db, OWNER);
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
      // (a number that became a customer after its label is captured: C-4)
      if (CL.captureOff(labels, parsed.phoneDigits, index.get(parsed.phoneDigits))) {
        // One metadata row (time, direction, number) so the Call Center still
        // shows that it rang; no audio copy, no Groq, no notes, no transcript.
        counts.labelSkipped = (counts.labelSkipped || 0) + 1;
        if (live) {
          await docRef.set(Object.assign(
            L.buildCallDoc({ ownerUid: OWNER, file: f, parsed, match, bucket: bucketName, storedPath: null, nowMs, durationSec: null }),
            { status: 'personal', audioRemoved: 'label', capturedByLabel: false, createdAt: FieldValue.serverTimestamp() }));
        }
        continue;
      }
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
        const callDoc = L.buildCallDoc({ ownerUid: OWNER, file: f, parsed, match, bucket: bucketName, storedPath: path, nowMs, durationSec });
        await docRef.set(Object.assign({}, callDoc, { createdAt: FieldValue.serverTimestamp() }));
        counts.stored++;
        // Speed-to-lead auto-text (2026-10-15): dark unless
        // MISSED_CALL_AUTOTEXT_ENABLED === 'true'; consented customers only.
        if (callDoc.replyDraft && process.env.MISSED_CALL_AUTOTEXT_ENABLED === 'true') {
          const r = await require('./missed-call-autotext').maybeAutoTextMissedCall({
            db, call: Object.assign({ id: docRef.id }, callDoc), nowMs, tenantKey: OWNER, send: sendAutoText, logger,
          });
          if (r.sent) counts.autoTexted = (counts.autoTexted || 0) + 1;
        }
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
  { schedule: 'every 30 minutes', timeZone: 'America/New_York', timeoutSeconds: 540, memory: '1GiB', secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER] },
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
const TRANSIENT_MAX = 6; // consecutive 5xx/overloaded failures of ONE call before it counts as the call's fault
const transcribeEnabled = () => process.env.CALL_CENTER_TRANSCRIBE_ENABLED === 'true';

let _deps = null;
function deps() {
  if (_deps) return _deps;
  const { transcribeGroqBuffer } = require('./integrations/voice-intelligence');
  return {
    transcribe: async (buffer, ext) => {
      // Groq refuses .amr/.3gp/.aac (Cube ACR): re-encoded to FLAC first.
      const p = await require('./call-audio-transcode').prepareForGroq(buffer, ext);
      return transcribeGroqBuffer({ buffer: p.buffer, mimeType: p.mimeType, filename: p.filename, timeoutMs: 300_000, feature: 'call-center-transcribe' });
    },
    notes: claudeNotes,
    // callWatch's push sender (Jo's own devices; never a customer).
    push: (uid, title, body, data) => require('./push-functions').sendCustomNotification(uid, title, body, data),
  };
}

// Shared with text-inbox.js (textInboxNotes binds its own ANTHROPIC_API_KEY).
async function claudeNotes({ system, prompt, feature, maxTokens }) {
  const key = secretValue(ANTHROPIC_API_KEY);
  if (!key) throw new Error('anthropic-not-configured');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key },
    body: JSON.stringify({ model: NOTES_MODEL, max_tokens: Number(maxTokens) || 900, system, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error('anthropic ' + res.status + ': ' + String((data && data.error && data.error.message) || '').slice(0, 200));
    err.status = res.status; err.provider = 'anthropic'; // L.classifyProviderError
    throw err;
  }
  // AI spend in one place (functions/ai-spend.js) — one counter row per call.
  await require('./ai-spend').recordAiSpend(require('./ai-spend').rowFromAnthropic(feature || 'call-center-notes', NOTES_MODEL, data), { log: logger });
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

/** lastContactedAt / lastContactType / followUp on the lead (L.leadContactPatch). */
async function applyLeadContact({ db, leadId, lead, call, notes, todayYmd, nowMs }) {
  const p = L.leadContactPatch({ lead, call, notes, todayYmd, nowMs });
  if (!p) return false;
  const patch = {};
  if (p.lastContactedAtMs) { patch.lastContactedAt = Timestamp.fromMillis(p.lastContactedAtMs); patch.lastContactType = p.lastContactType; }
  if (p.followUp) patch.followUp = p.followUp;
  await db.doc('leads/' + leadId).set(patch, { merge: true });
  return true;
}

/**
 * An urgent call → Jo's own push right away (2026-10-03), plus the bell
 * entry callWatch would have made. Once per call: urgentPushedAtMs on the
 * call doc is stamped only after the push went out, and callWatch skips a
 * call already told this way (call-watch-logic newNeeds). Same gate and
 * hours as callWatch (CALL_WATCH_ENABLED, 8 AM-8 PM ET) — outside them the
 * next callWatch run tells Jo instead. INTERNAL: never a customer.
 */
/** One number's label (companies/{OWNER}/contact_labels/{digits}) as { digits: label }; {} when none / unreadable (the safe direction: it surfaces). */
async function labelFor(db, phoneDigits) {
  const dg = String(phoneDigits || '').replace(/\D/g, '').slice(-10);
  if (dg.length !== 10) return {};
  try {
    const s = await db.collection('companies').doc(OWNER).collection('contact_labels').doc(dg).get();
    const x = s && s.exists ? (s.data() || {}) : null;
    return x && x.kind ? { [dg]: { kind: x.kind, policy: x.policy || '' } } : {};
  } catch (e) {
    logger.warn('call_center_urgent_label_read_failed', { err: e && e.message });
    return {};
  }
}

async function pushUrgent({ db, d, call, notes, leadName, nowMs }) {
  if (process.env.CALL_WATCH_ENABLED !== 'true' || typeof d.push !== 'function') return false;
  const W = require('./call-watch-logic');
  if (!W.inWatchHours(nowMs)) return false;
  // The SAME label rule callWatch and Home use (call-watch-logic callNeedsYou /
  // reasonFor, mirror of contact-labels-logic): a hidden PERSONAL number's urgent
  // call breaks through (tagged), a spam number's "urgent" does not, a quiet
  // number needs a promise / due callback. Not 'urgent' here -> callWatch decides.
  const labels = await labelFor(db, call.phoneDigits);
  const row = Object.assign({}, call, { urgent: true, promises: notes && notes.promises, followUpDate: notes && notes.followUpDate, callType: (notes && notes.callType) || call.callType });
  const ctx = { labels };
  if (!W.callNeedsYou(row, nowMs, ctx) || W.reasonFor(row, nowMs, ctx) !== 'urgent') return false;
  const lb = W.labelOf(ctx, row);
  // The person card (audit F4, 2026-10-13): another call from the SAME person that
  // was already pushed as urgent today and is still open. A second urgent call from
  // that person does not buzz again - the open urgent call carries the ladder, and
  // its next re-tell names both ("+1 more call"). A failed read is not an excuse to
  // stay quiet: the push goes out as before. (Inline, not a helper: the delivery-
  // truth test slices this function's source.)
  let sib = null;
  if (call.leadId || String(call.phoneDigits || '').trim()) {
    try {
      const base = db.collection(COLLECTION).where('userId', '==', OWNER);
      const snap = await (call.leadId ? base.where('leadId', '==', call.leadId) : base.where('phoneDigits', '==', call.phoneDigits)).limit(60).get();
      const today = W.etYmd(nowMs), key = W.callerKey(call);
      (snap.docs || []).forEach((doc) => {
        const c = Object.assign({}, doc.data(), { id: doc.id });
        if (c.id === call.id || W.callerKey(c) !== key) return;
        const at = W.toMs(c.urgentPushedAtMs);
        if (!at || c.urgentFoldedAtMs || W.etYmd(at) !== today) return;
        if (!W.callNeedsYou(c, nowMs, { labels })) return;          // handled / done / parked: a new need
        if (!sib || at > W.toMs(sib.urgentPushedAtMs)) sib = c;
      });
    } catch (e) {
      logger.warn('call_center_urgent_sibling_read_failed', { id: call.id, err: e && e.message });
      sib = null;
    }
  }
  if (sib) {
    // Folded: stamped as told (callWatch will not re-tell it as new), seeded at the
    // sibling's push time so the ladder climbs the two calls in step.
    try {
      await db.collection(COLLECTION).doc(call.id).set({ urgentPushedAtMs: sib.urgentPushedAtMs, urgentFoldedAtMs: nowMs, urgentFoldedInto: sib.id }, { merge: true });
    } catch (e) {
      logger.warn('call_center_urgent_fold_stamp_failed', { id: call.id, err: e && e.message });
      // Unstamped: callWatch sees it as a new urgent call at the next run and puts it on
      // the bell; the person card may fold the PUSH (its carrier's re-tell names it).
    }
    return false;
  }
  const msg = L.urgentPushText({ call, notes, leadName });
  if (lb && lb.policy === 'hide') {
    const kindName = { personal: 'Personal', other: 'Other', recruiter: 'Job seeker' }[lb.kind] || String(lb.kind).charAt(0).toUpperCase() + String(lb.kind).slice(1);
    msg.body = String(msg.body || '').slice(0, 160) + ' (' + kindName + ' · hidden number)';
  }
  const clickUrl = W.callCardUrl(call.id);
  try {
    const pr = await d.push(OWNER, msg.title, msg.body, { type: 'call_watch', clickUrl, notificationId: 'call-urgent-' + call.id });
    // sendPushNotification RESOLVES {sent:0} for "no device on file" and for
    // "every token failed" (audit R2, 2026-10-12). That is not "told": leave
    // urgentPushedAtMs unset so the next callWatch run tells Jo again.
    if (pr && typeof pr === 'object' && pr.sent === 0) {
      logger.warn('call_center_urgent_push_reached_nobody', { id: call.id, failed: pr.failed || 0 });
      return false;
    }
    await db.collection(COLLECTION).doc(call.id).set({ urgentPushedAtMs: nowMs }, { merge: true });
    await db.collection('notifications').add({
      userId: OWNER, type: 'call_watch', title: '📞 ' + msg.title, message: msg.body, priority: 'high',
      clickUrl, read: false, dismissed: false, createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (e) {
    logger.warn('call_center_urgent_push_failed', { id: call.id, err: e && e.message });
    return false;
  }
}

// The stored "Looks like X" for a call on no customer (L.suggestLeadForCall:
// exactly one lead matches, or nothing). suggestCheckedAtMs marks it done.
function suggestionPatch(call, leads, nowMs) {
  const s = L.suggestLeadForCall(Object.assign({}, call, { leadId: null }), leads);
  return { suggestedLeadId: s ? s.leadId : null, suggestedLeadName: s ? s.name : null, suggestedWhy: s ? s.why : null, suggestCheckedAtMs: nowMs, suggestRulesV: L.SUGGEST_RULES_VERSION };
}
const SUGGEST_BACKFILL_PER_RUN = 100;
// The noted calls on no customer — read once a run, shared by the facts
// re-extraction and the suggestion backfill.
async function unfiledNoted(db) {
  const q = await db.collection(COLLECTION).where('userId', '==', OWNER).where('status', '==', 'noted').where('leadId', '==', null).limit(500).get();
  const rows = [];
  q.forEach((d) => rows.push(Object.assign({}, d.data() || {}, { id: d.id })));
  return rows;
}
async function backfillSuggestions({ db, nowMs, leads, rows }) {
  const all = rows || await unfiledNoted(db);
  // Unchecked, or checked under older rules (2026-10-03: Thumbtack rules, then caller facts).
  const todo = all.filter((v) => v.suggestRulesV !== L.SUGGEST_RULES_VERSION);
  if (!todo.length) return 0;
  const leadRows = leads || await ownerLeads(db);
  const batch = todo.slice(0, SUGGEST_BACKFILL_PER_RUN);
  for (const c of batch) await db.collection(COLLECTION).doc(c.id).set(suggestionPatch(c, leadRows, nowMs), { merge: true });
  return batch.length;
}

// Caller facts for calls noted before the notes prompt asked for them
// (2026-10-03). Bounded: FACTS_PER_RUN a run and FACTS_DAY_CAP model calls
// a day (counted on integrations/callCenter factsDay / factsUsed, the same
// way the audio cap is), from the STORED transcript — never re-transcribed.
// factsV marks a call done, so a re-run never re-reads it; a call that
// fails twice is left alone. Each re-read call is re-scored at once.
const FACTS_PER_RUN = 20;
const FACTS_DAY_CAP = 150;
const FACTS_MAX_ATTEMPTS = 2;
async function reextractFacts({ db, d, rows, cfg, today, nowMs, getLeads }) {
  const usedToday = (cfg && cfg.factsDay === today && Number(cfg.factsUsed)) || 0;
  const out = { reextracted: 0, failed: 0, aiCalls: 0, usedToday };
  const room = Math.min(FACTS_PER_RUN, FACTS_DAY_CAP - usedToday);
  if (room <= 0) return out;
  const todo = rows
    .filter((c) => (Number(c.factsV) || 0) < L.FACTS_VERSION && (Number(c.factsAttempts) || 0) < FACTS_MAX_ATTEMPTS)
    .sort((a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0));
  for (const c of todo) {
    if (out.aiCalls >= room) break;
    const ref = db.collection(COLLECTION).doc(c.id);
    if (!String(c.transcript || '').trim()) {
      // Nothing to read: marked done, no model call spent.
      const patch = { callerFacts: L.sanitizeCallerFacts(null), factsV: L.FACTS_VERSION };
      await ref.set(patch, { merge: true });
      Object.assign(c, patch);
      continue;
    }
    out.aiCalls++;
    try {
      const facts = L.sanitizeCallerFacts(await d.notes({ system: L.FACTS_SYSTEM, prompt: L.buildFactsPrompt({ transcript: c.transcript }), feature: 'call-center-facts' }));
      Object.assign(c, { callerFacts: facts, factsV: L.FACTS_VERSION });
      const sp = suggestionPatch(c, await getLeads(), nowMs);
      await ref.set(Object.assign({ callerFacts: facts, factsV: L.FACTS_VERSION, factsAtMs: nowMs }, sp), { merge: true });
      Object.assign(c, sp);
      out.reextracted++;
    } catch (e) {
      // Out of credit / bad key / provider down: the CALL did nothing wrong.
      // No strike (two would retire its facts for good); stop, the run reports it.
      const outage = L.classifyProviderError(e);
      if (outage) { out.outage = outage; out.aiCalls--; logger.warn('call_center_facts_provider_outage', { id: c.id, kind: outage.kind }); break; }
      out.failed++;
      c.factsAttempts = (Number(c.factsAttempts) || 0) + 1;
      await ref.set({ factsAttempts: c.factsAttempts, factsError: String((e && e.message) || e).slice(0, 300) }, { merge: true }).catch(() => {});
      logger.warn('call_center_facts_failed', { id: c.id, err: e && e.message });
      break; // the model is down or refusing: the next run tries again
    }
  }
  return out;
}

/**
 * A stored recording's bytes, without the library's streamed download.
 *
 * `file.download()` reads through createReadStream(), and inside it
 * teeny-request and @google-cloud/storage each pipe the SAME node-fetch
 * response body: one 300 KB download leaves 11 'error' and 11 'close'
 * listeners on that PassThrough, so every recording this job read logged two
 * MaxListenersExceededWarning lines (~500 a week, rising with call volume).
 * Reproduced on the Storage emulator 2026-10-04: 15 downloads → 30 warnings,
 * 15 distinct streams, each one ended and destroyed afterwards — fan-out per
 * file, not a stream kept across files, but noise that buries real warnings.
 *
 * So: one buffered, authenticated GET of the object's media URL through the
 * storage client's own auth (no stream at all). Where that client is absent
 * or points at a custom endpoint (the emulator, test fakes), read the stream
 * ourselves and END it — destroy() in `finally`, whatever happened — so a
 * download that throws half way never leaves its stream open. Plain
 * download() remains only for a fake that offers nothing else.
 */
async function readStoredAudio(bucket, path) {
  const file = bucket.file(path);
  const st = (file && file.storage) || (bucket && bucket.storage) || null;
  if (st && !st.customEndpoint && st.authClient && typeof st.authClient.request === 'function' && st.apiEndpoint) {
    const url = String(st.apiEndpoint).replace(/\/+$/, '') + '/storage/v1/b/' + encodeURIComponent(bucket.name)
      + '/o/' + encodeURIComponent(path) + '?alt=media';
    const res = await st.authClient.request({ url, method: 'GET', responseType: 'arraybuffer', retry: true });
    return Buffer.from(res.data);
  }
  if (file && typeof file.createReadStream === 'function') {
    const stream = file.createReadStream({ validation: false });
    const chunks = [];
    try {
      for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    } finally {
      if (!stream.destroyed && typeof stream.destroy === 'function') stream.destroy();
    }
    return Buffer.concat(chunks);
  }
  const [buf] = await file.download();
  return buf;
}

/**
 * One clear signal when the AI step is out for a reason only Jo can fix
 * (credit / key): a bell (one doc per ET day, so a rerun cannot double it) and
 * a push to his own devices, in watch hours, once a day. Never a customer.
 * Returns { alertedYmd, pushedYmd } for what actually happened today.
 */
async function alertProviderOutage({ db, d, outage, prev, today, nowMs }) {
  const out = {};
  const who = outage.provider === 'groq' ? 'Groq' : (outage.provider === 'anthropic' ? 'Anthropic' : 'AI provider');
  const fix = outage.kind === 'credit'
    ? who + ' credit problem - top up at ' + (outage.provider === 'groq' ? 'console.groq.com > Billing' : 'console.anthropic.com > Billing')
    : who + ' key problem - the API key was rejected, replace it in the Firebase secrets';
  const title = 'AI call notes are paused';
  const body = fix + '; calls are still recorded and listed.';
  const clickUrl = '/pro/dashboard.html#/calls';
  if (!prev || prev.alertedYmd !== today) {
    try {
      await db.collection('notifications').doc('ai-outage-' + today).set({
        userId: OWNER, type: 'ai_outage', title: '⚠ ' + title, message: body, priority: 'high',
        clickUrl, read: false, dismissed: false, createdAt: FieldValue.serverTimestamp(),
      });
      out.alertedYmd = today;
    } catch (e) { logger.warn('call_center_outage_bell_failed', { err: e && e.message }); }
  }
  if ((!prev || prev.pushedYmd !== today) && typeof d.push === 'function' && require('./call-watch-logic').inWatchHours(nowMs)) {
    try {
      const pr = await d.push(OWNER, title, body, { type: 'ai_outage', clickUrl, notificationId: 'ai-outage-' + today });
      // {sent:0} = no device reached: not "told", so the next run tries again.
      if (!(pr && typeof pr === 'object' && pr.sent === 0)) out.pushedYmd = today;
    } catch (e) { logger.warn('call_center_outage_push_failed', { err: e && e.message }); }
  }
  return out;
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
  // A number labeled personal + "stop copying and transcribing" after its call
  // was copied: never transcribe it. The stored audio is left exactly as it is
  // (only the status moves, so the queue stops seeing it).
  const labels = await CL.loadLabels(db, OWNER);
  // A number that became a customer after its label is never skipped (C-4).
  const anyCaptureOff = Object.keys(labels).some((k) => labels[k] && labels[k].capture === 'off');
  const leadIndex = anyCaptureOff ? L.buildPhoneIndex(await ownerLeads(db)) : new Map();
  const kept = [];
  for (const c of candidates) {
    if (!CL.captureOff(labels, c.phoneDigits, leadIndex.get(c.phoneDigits))) { kept.push(c); continue; }
    if (live) await db.collection(COLLECTION).doc(c.id).set({ status: 'personal', labelCapture: 'off', transcript: null, transcriptSaved: false }, { merge: true });
  }
  candidates = kept;
  const pick = L.pickToTranscribe(candidates, { live, allowIds, maxCount: TRANSCRIBE_PER_RUN, secLeft });
  const out = { state: allowIds.length ? 'test' : 'live', picked: pick.length, noted: 0, personal: 0, failed: 0, tasks: 0, audioSec: 0 };
  const d = deps();
  let leadsForSuggest = null;

  for (const call of pick) {
    const callRef = db.collection(COLLECTION).doc(call.id);
    let t = null;
    try {
      const reuse = call.transcriptSaved === true && String(call.transcript || '').trim();
      if (!reuse && (Number(call.sizeBytes) || 0) > L.GROQ_MAX_BYTES) {
        await callRef.set({ status: 'too_large' }, { merge: true });
        continue;
      }
      if (reuse) {
        // A previous run transcribed this call and only the notes step failed
        // (provider outage): never pay the transcriber twice.
        t = { text: String(call.transcript), durationSec: Number(call.durationSec) || 0 };
        out.reusedTranscripts = (out.reusedTranscripts || 0) + 1;
      } else {
        let buf;
        try { buf = await readStoredAudio(bucket, call.storagePath); } catch (se) { if (se && typeof se === 'object') se.notProvider = true; throw se; }
        t = await d.transcribe(buf, String(call.storagePath).split('.').pop());
        out.audioSec += Number(t.durationSec) || L.estimateAudioSec(call.sizeBytes);
      }

      let leadName = '';
      let leadDoc = null;
      if (call.leadId) {
        const ls = await db.doc('leads/' + call.leadId).get();
        if (ls.exists) { leadDoc = ls.data(); leadName = ((leadDoc.firstName || '') + ' ' + (leadDoc.lastName || '')).trim(); }
      }
      const notes = L.sanitizeNotes(await d.notes({ system: L.NOTES_SYSTEM, prompt: L.buildNotesPrompt({ call, transcript: t.text, leadName }), feature: 'call-center-notes' }));
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
        callerFacts: notes.callerFacts,
        factsV: L.FACTS_VERSION,
        notedAtMs: nowMs,
        transcriptSaved: false,
        transcribeError: null,
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

      // An urgent call tells Jo now, not at the next 2-hourly callWatch.
      if (notes.urgent === true && !call.urgentPushedAtMs) {
        if (await pushUrgent({ db, d, call, notes, leadName, nowMs })) out.urgentPushed = (out.urgentPushed || 0) + 1;
      }

      // "Looks like X" (2026-10-03): a call on no customer gets its one
      // likely customer stored with it, so every call screen can offer
      // "File on X" in one tap. A suggestion only — never filed by itself.
      if (!call.leadId) {
        if (!leadsForSuggest) leadsForSuggest = await ownerLeads(db);
        await callRef.set(suggestionPatch(Object.assign({}, call, { summary: notes.summary, transcript: t.text, callerFacts: notes.callerFacts }), leadsForSuggest, nowMs), { merge: true });
      }

      if (call.leadId) {
        const full = Object.assign({}, call, { durationSec: Number(t.durationSec) || 0 });
        await db.doc('leads/' + call.leadId + '/activity/cube-' + call.id)
          .set(Object.assign(L.buildCallActivity({ call: full, notes, ownerUid: OWNER }), { createdAt: FieldValue.serverTimestamp() }));
        const task = L.buildFollowUpTask({ call: full, notes, leadId: call.leadId, ownerUid: OWNER, todayYmd: today, nowMs });
        // create(): a re-run must never un-tick a task Jo already completed.
        if (task && await createIfAbsent(db.doc('leads/' + call.leadId + '/tasks/cube-' + call.id), Object.assign(task, { createdAt: FieldValue.serverTimestamp() }))) out.tasks++;
        // The lead itself knows Jo talked to them (lastContactedAt, followUp).
        if (leadDoc && leadDoc.deleted !== true && await applyLeadContact({ db, leadId: call.leadId, lead: leadDoc, call, notes, todayYmd: today, nowMs })) out.leadsUpdated = (out.leadsUpdated || 0) + 1;
      }
    } catch (e) {
      // Groq's hourly/daily rate limit is about the account, not this call:
      // no strike, and stop the run (every later call would be refused too).
      // The next half-hourly run picks up where this one stopped.
      const errMsg = String((e && e.message) || e).slice(0, 300);
      // The transcript is the expensive half: if transcription succeeded and
      // only the notes step failed, keep it on the call (status stays
      // 'stored', so the call stays listed and eligible; a retry re-runs ONLY
      // the notes).
      const keepTranscript = t && t.text && call.transcriptSaved !== true
        ? { transcriptSaved: true, transcript: String(t.text).slice(0, 100000), transcriptSavedAtMs: nowMs, durationSec: Number(t.durationSec) || Number(call.durationSec) || null }
        : {};
      // A provider outage (Groq or Anthropic: out of credit, bad key, rate
      // limit, overloaded) is about the ACCOUNT, not this call: no strike, and
      // stop the run (every later call would be refused too). The next
      // half-hourly run picks up where this one stopped.
      // Only the transcriber / the model can be a provider outage: a Storage
      // read that 403s must not tell Jo to top up Anthropic.
      let outage = e && e.notProvider ? null : L.classifyProviderError(e);
      // A 5xx can be one poisoned file, not the provider: after TRANSIENT_MAX
      // in a row it is the call's fault after all (a strike), so one bad call
      // can never hold the whole line forever. Credit/auth/429 are account-level.
      const transientFails = (Number(call.transientFails) || 0) + (outage && outage.kind === 'overloaded' ? 1 : 0);
      if (outage && outage.kind === 'overloaded' && transientFails >= TRANSIENT_MAX) outage = null;
      if (outage) {
        if (outage.kind === 'overloaded') keepTranscript.transientFails = transientFails;
        out.providerOutage = outage;
        if (outage.kind === 'rate_limit') out.rateLimited = true;
        await callRef.set(Object.assign({ transcribeError: errMsg, providerOutageAtMs: nowMs }, outage.kind === 'rate_limit' ? { rateLimitedAtMs: nowMs } : {}, keepTranscript), { merge: true }).catch((we) => logger.warn('call_center_outage_write_failed', { id: call.id, err: we && we.message }));
        logger.warn('call_center_transcribe_provider_outage', { id: call.id, kind: outage.kind, provider: outage.provider, noted: out.noted });
        break;
      }
      out.failed++;
      await callRef.set(Object.assign({ transcribeAttempts: (Number(call.transcribeAttempts) || 0) + 1, transcribeError: errMsg }, keepTranscript), { merge: true }).catch((we) => logger.warn('call_center_strike_write_failed', { id: call.id, err: we && we.message }));
      logger.warn('call_center_transcribe_failed', { id: call.id, err: e && e.message });
    }
  }

  // Calls noted before suggestions existed get theirs, a batch a run.
  // Older calls get caller facts re-read (bounded, see reextractFacts) and
  // are re-scored.
  let factsUsed = null;
  if (live && !allowIds.length && !out.providerOutage) {
    try {
      const rows = await unfiledNoted(db);
      const getLeads = async () => (leadsForSuggest = leadsForSuggest || await ownerLeads(db));
      try {
        const f = await reextractFacts({ db, d, rows, cfg, today, nowMs, getLeads });
        out.factsReextracted = f.reextracted;
        if (f.failed) out.factsFailed = f.failed;
        factsUsed = f.usedToday + f.aiCalls;
        if (f.outage) out.providerOutage = f.outage;
        else if (f.reextracted > 0) out.aiWorked = true;
      } catch (e) { logger.warn('call_center_facts_backfill_failed', { err: e && e.message }); }
      out.suggested = await backfillSuggestions({ db, nowMs, leads: leadsForSuggest, rows });
    } catch (e) { logger.warn('call_center_suggest_backfill_failed', { err: e && e.message }); }
  }

  // Provider outage (2026-10-13): say so, once a day, in words Jo can act on;
  // clears itself on the first run whose AI step works again.
  const outage = out.providerOutage || null;
  if (outage) out.state = 'provider_outage';
  const prevOutage = (cfg && cfg.providerOutage) || null;
  const outagePatch = {};
  if (outage) {
    const same = prevOutage && prevOutage.kind === outage.kind && prevOutage.provider === outage.provider;
    const al = outage.needsAction ? await alertProviderOutage({ db, d, outage, prev: prevOutage, today, nowMs }) : {};
    outagePatch.providerOutage = {
      provider: outage.provider, kind: outage.kind, reason: outage.reason, needsAction: outage.needsAction,
      sinceMs: (same && prevOutage.sinceMs) || nowMs, lastAtMs: nowMs,
      alertedYmd: al.alertedYmd || (prevOutage && prevOutage.alertedYmd) || null,
      pushedYmd: al.pushedYmd || (prevOutage && prevOutage.pushedYmd) || null,
    };
  } else if (prevOutage && (out.noted > 0 || out.personal > 0 || out.aiWorked === true)) {
    outagePatch.providerOutage = null;
    out.outageCleared = true;
  }
  const patch = Object.assign({ audioSecDay: today, audioSecUsed: usedSec + out.audioSec, lastTranscribeAtMs: nowMs, lastTranscribe: out }, outagePatch);
  if (factsUsed !== null) Object.assign(patch, { factsDay: today, factsUsed });
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
    ls.forEach((d) => { const v = d.data() || {}; leads.push({ id: d.id, firstName: v.firstName, lastName: v.lastName, address: v.address, deleted: v.deleted, source: v.source }); });
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

/**
 * gatherSweep + the promise TASKS due today or earlier (2026-10-13, audit F1):
 * what the morning brief and the 15:15 email list. One row per PERSON (a
 * person with an open call and a due promise is one row). `promiseCheckFailed`
 * is true when the task read failed - callers say "could not check", never
 * "nothing due". The deck (callPromisesList) keeps plain gatherSweep: its rows
 * are calls it can swipe through callCenterAction.
 */
async function gatherSweepWithPromises({ db, nowMs }) {
  const base = await gatherSweep({ db, nowMs });
  const PC = require('./promise-channel');
  const PCL = require('./promise-channel-logic');
  const labels = await CL.loadLabels(db, OWNER);
  const pr = await PC.readDuePromisePeople({ db, owner: OWNER, nowMs, labels });
  const items = PCL.mergeSweep(base.items, pr.people);
  const counts = Object.assign({}, base.counts, { items: items.length, promises: pr.people.length });
  // F6: unlabelled numbers that keep calling are bell-only (never pushed), so the
  // brief / email carries ONE summary line for them. A failed read says so.
  let quietLines = [];
  try {
    const W = require('./call-watch-logic');
    const q = await db.collection(COLLECTION).where('userId', '==', OWNER).where('startedAtMs', '>=', nowMs - 36 * 3600000)
      .orderBy('startedAtMs', 'desc').limit(300).get();
    const rows = [];
    q.forEach((d) => rows.push(Object.assign({}, d.data(), { id: d.id })));
    const ctx = Object.assign(W.reachIndex(rows), { labels });
    quietLines = PV.quietNumberLines(PV.quietNumbers(rows, nowMs, W.callNeedsYou, ctx), false);
  } catch (e) {
    logger.warn('[callCenterSweep] repeat-number summary read failed', { err: e && e.message });
    quietLines = PV.quietNumberLines([], true);
  }
  return { today: base.today, items, counts, promiseCheckFailed: pr.failed, quietLines };
}

/** The digest signature doc: what the last brief / sweep email listed (audit F7). */
const DIGEST_SIG_DOC = 'integrations/digestSig';
async function stampDigest(db, items, nowMs, by) {
  try { await db.doc(DIGEST_SIG_DOC).set({ ymd: PV.etYmd(nowMs), sig: PV.digestSig(items), n: items.length, atMs: nowMs, by }, { merge: false }); }
  catch (e) { logger.warn('[digest] signature stamp failed (the next digest will send)', { err: e && e.message }); }
}

async function runSweep({ db, live, nowMs, send, slot, absorbed }) {
  // One morning email (2026-10-04): the 07:15 list rides in the 06:45 brief
  // when it absorbs this email (morning-brief-absorb.js). 15:15 always sends.
  if (slot === 'am' && absorbed) return { state: 'absorbed' };
  const user = await db.collection('users').doc(OWNER).get();
  const email = user.exists ? String((user.data() || {}).email || '') : '';
  const { today, items, counts, promiseCheckFailed, quietLines } = await gatherSweepWithPromises({ db, nowMs });
  // A failed promise-task read is never "nothing": say so (the email carries the warning).
  if (!items.length && !promiseCheckFailed) return Object.assign({ state: 'nothing' }, counts);
  if (!live) return Object.assign({ state: 'dry_run' }, counts);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Object.assign({ state: 'no_email' }, counts);
  // F7: the 15:15 email is skipped when the list is exactly what this morning's
  // brief / sweep already listed (once per CHANGE, not twice a day). A warning
  // (the task read failed) always sends; a failed signature read sends too - a
  // duplicate beats a lost reminder.
  if (slot === 'pm' && !promiseCheckFailed && items.length) {
    let last = null;
    try { const s = await db.doc(DIGEST_SIG_DOC).get(); last = s && s.exists ? s.data() : null; }
    catch (e) { logger.warn('[callCenterSweep] digest signature read failed (sending)', { err: e && e.message }); }
    if (PV.digestUnchanged(last, items, nowMs)) return Object.assign({ state: 'unchanged' }, counts);
  }
  const mail = L.buildSweepEmail({ items, todayYmd: today, slot, promiseCheckFailed, quietLines });
  await send({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
  if (!promiseCheckFailed) await stampDigest(db, items, nowMs, 'sweep-' + slot);
  return Object.assign({ state: 'sent' }, counts);
}

exports.callCenterSweep = onSchedule(
  { schedule: '15 7,15 * * *', timeZone: 'America/New_York', timeoutSeconds: 120, memory: '512MiB', maxInstances: 1, secrets: [RESEND_API_KEY, EMAIL_FROM] },
  async () => {
    try {
      const nowMs = Date.now();
      const hour = Number(new Date(nowMs).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
      const slot = hour >= 12 ? 'pm' : 'am';
      const db = getFirestore();
      const r = await runSweep({
        db, live: sweepEnabled(), nowMs, slot,
        absorbed: slot === 'am' && await require('./morning-brief-absorb').briefAbsorbs(db),
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
async function refileNumber({ db, call, leadId, uid, nowMs, noted }) {
  const out = { calls: 0, textDays: 0, texts: 0 };
  const digits = String(call.phoneDigits || '');
  if (!/^\d{10}$/.test(digits) || !call.userId) return out;
  // A proxy number (on 3+ of the tenant's leads) identifies nobody: never
  // sweep everything from it onto one lead.
  const onLeads = new Set();
  for (const [f, v] of [['userId', call.userId], ['companyId', call.companyId]]) {
    if (!v) continue;
    (await db.collection('leads').where(f, '==', v).where('phoneDigits', '==', digits).get())
      .forEach((d) => { if ((d.data() || {}).deleted !== true) onLeads.add(d.id); });
  }
  if (onLeads.size >= L.PROXY_MIN_LEADS) return Object.assign(out, { proxy: true });
  const mine = (v) => v && !v.leadId && v.userId === call.userId && (v.companyId || null) === (call.companyId || null);
  const extra = { refiledFrom: call.id };
  const cs = await db.collection(COLLECTION).where('userId', '==', call.userId).where('phoneDigits', '==', digits).get();
  for (const s of cs.docs) {
    const c = Object.assign({}, s.data(), { id: s.id });
    if (s.id === call.id || !mine(c)) continue;
    await fileCallOnLead({ db, call: c, leadId, uid, nowMs, extra });
    if (Array.isArray(noted) && c.status === 'noted') noted.push(c);
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
  const noted = call.status === 'noted' ? [call] : [];
  const refiled = await refileNumber({ db, call, leadId, uid, nowMs, noted });
  // "The CRM knows I called": the newest noted call among the attached one
  // and every re-filed one sets lastContactedAt / followUp (one write).
  const newest = noted.sort((a, b) => (Number(b.startedAtMs) || 0) - (Number(a.startedAtMs) || 0))[0];
  if (newest) await applyLeadContact({ db, leadId, lead, call: newest, notes: noteOf(newest), todayYmd: etToday(nowMs), nowMs });
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

// Keep the away-mode hand-back timeline row true once Jo clears the person
// (2026-10-13, functions/away-handback-settle.js). Best effort, never throws.
async function settleAway(db, call, auth, nowMs) {
  try {
    await require('./away-handback-settle').settleHandBackTimeline(db, call, { nowMs, byUid: auth && auth.uid, byName: auth && auth.token && auth.token.name });
  } catch (_) { /* the clearing action already succeeded */ }
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
    await settleAway(db, call, auth, nowMs);
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
      // Mirror onto the call now (onCallTaskWrite does the same for a tick
      // anywhere else) so "needs you" drops the person straight away.
      await ref.set({ taskDone: done }, { merge: true });
      await settleAway(db, call, auth, nowMs);
      return { ok: true, done };
    }
    if (action === 'snooze') {
      const days = Math.round(Number(data && data.days));
      if (!(days >= 1 && days <= 30)) throw new HttpsError('invalid-argument', 'Snooze 1–30 days.');
      const until = L.addDaysYmd(today, days);
      if (task) {
        await taskRef.set({ dueDate: until, snoozedFromDue: task.snoozedFromDue || task.dueDate || today, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        // ALSO stamp the call itself (2026-10-13): Home, the ledger, the brief and
        // the away list read only the call row, so a snooze that moved nothing but
        // the task was invisible to them (audit F9a). One parked rule, one field:
        // call-watch-logic parkedUntil.
        await ref.set({ snoozeUntilYmd: until, snoozedBy: auth.uid }, { merge: true });
        return { ok: true, until, on: 'task' };
      }
      await ref.set({ snoozeUntilYmd: until, snoozedBy: auth.uid }, { merge: true });
      return { ok: true, until, on: 'call' };
    }
    // unsnooze
    if (task && task.snoozedFromDue) {
      await taskRef.set({ dueDate: task.snoozedFromDue, snoozedFromDue: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await ref.set({ snoozeUntilYmd: null }, { merge: true });
      return { ok: true, on: 'task' };
    }
    await ref.set({ snoozeUntilYmd: null }, { merge: true });
    return { ok: true, on: 'call' };
  }
  // Promise capture (2026-10-12; documentation/projects/PROMISE-CAPTURE-2026-10-12.md).
  // Handling a call asks what Jo owes: one chip (Call back / Send estimate /
  // Text by 5pm / Order materials / Check on permit / Waiting on them) and a
  // date become a dated task on the customer (promise-<callId>, so a double
  // tap writes once and choosing again from the call edits it). The call is
  // marked handled and its generic cube-/sms- follow-up task is retired as
  // superseded, so the person is not owed twice. A call filed on no customer
  // has no lead to hang a task on: the promise rides on the call doc
  // (promise{} + followUpDate, the rule needs-you already reads) and the call
  // stays unhandled. "Nothing owed" is the plain 'handled' action.
  if (action === 'promise') {
    const today = etToday(nowMs);
    const kind = String((data && data.kind) || '');
    const built = PR.buildTask({
      kind, dueYmd: data && data.dueYmd ? String(data.dueYmd) : '', why: data && data.why, todayYmd: today,
      uid: auth.uid, source: isText ? 'text' : 'call', sourceCallId: id,
      waitingOn: data && data.waitingOn, waitingDays: data && data.waitingDays,
    });
    if (built.error) throw new HttpsError('invalid-argument', built.error);
    if (call.leadId) {
      const leadId = String(call.leadId);
      const ls = await db.doc('leads/' + leadId).get();
      const lead = ls.exists ? ls.data() : null;
      if (!lead || lead.deleted === true) throw new HttpsError('not-found', 'Customer not found.');
      if (!leadInCallTenant(lead, call)) throw new HttpsError('permission-denied', 'That customer is not in your company.');
      const taskId = 'promise-' + id;
      const taskRef = db.doc('leads/' + leadId + '/tasks/' + taskId);
      const prev = await taskRef.get();
      const old = prev.exists ? (prev.data() || {}) : null;
      const doc = Object.assign({}, built, {
        leadId, userId: lead.userId || call.userId || OWNER,
        title: built.text, createdBy: 'Promise capture', phoneCallId: id, updatedAt: FieldValue.serverTimestamp(),
      });
      if (lead.companyId || call.companyId) doc.companyId = lead.companyId || call.companyId;
      if (old && old.kind === 'promise') {
        // Editing the same promise: keep its history, never reset a miss count.
        ['missCount', 'rescheduleCount', 'madeYmd', 'madeBy', 'nudgeCount', 'waitingSince'].forEach((k) => { if (old[k] !== undefined && old[k] !== null) doc[k] = old[k]; });
        if (doc.promiseKind === 'waiting' && old.promiseKind !== 'waiting') doc.waitingSince = built.waitingSince;
        doc.done = false; doc.completedAt = null; doc.outcome = null;
      } else {
        doc.madeAt = FieldValue.serverTimestamp();
        doc.createdAt = FieldValue.serverTimestamp();
      }
      await taskRef.set(doc, { merge: true });
      const genericRef = db.doc('leads/' + leadId + '/tasks/' + (isText ? 'sms-' : 'cube-') + id);
      const g = await genericRef.get();
      if (g.exists && (g.data() || {}).done !== true) {
        await genericRef.set({ done: true, completedAt: FieldValue.serverTimestamp(), supersededBy: taskId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      await ref.set({ handledAtMs: nowMs, handledBy: auth.uid, promiseTaskId: taskId, promiseKind: kind }, { merge: true });
      await settleAway(db, call, auth, nowMs);
      return { ok: true, on: 'task', taskId, dueDate: built.dueDate };
    }
    if (kind === 'waiting') throw new HttpsError('failed-precondition', 'File this call on a customer first - waiting needs a customer.');
    const prevPromise = call.promise && call.promise.kind === 'promise' ? call.promise : null;
    const promise = Object.assign({}, built);
    if (prevPromise) ['missCount', 'rescheduleCount', 'madeYmd', 'madeBy'].forEach((k) => { if (prevPromise[k] != null) promise[k] = prevPromise[k]; });
    const patch = { promise, promiseKind: kind, followUpDate: built.dueDate, handledAtMs: null };
    if (built.dueDate > today) { patch.snoozeUntilYmd = built.dueDate; patch.snoozedBy = auth.uid; } else patch.snoozeUntilYmd = null;
    await ref.set(patch, { merge: true });
    return { ok: true, on: 'call', dueDate: built.dueDate };
  }
  // Moving a promise that rides on a call (no customer): a new date, and a
  // miss counted when it was already past due. Task promises move on the task.
  if (action === 'promiseMove') {
    const p = call.promise && call.promise.kind === 'promise' ? call.promise : null;
    if (!p) throw new HttpsError('failed-precondition', 'This call has no promise to move.');
    const today = etToday(nowMs);
    const to = String((data && data.dueYmd) || '');
    const bad = PR.moveProblem(p, to, today);
    if (bad) throw new HttpsError('invalid-argument', bad);
    const next = Object.assign({}, p, PR.movePatch(p, to, today));
    const patch = { promise: next, followUpDate: to, snoozeUntilYmd: to > today ? to : null };
    if (to > today) patch.snoozedBy = auth.uid;
    await ref.set(patch, { merge: true });
    return { ok: true, on: 'call', dueDate: to, missCount: next.missCount };
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

// ═══════════════════════════════════════════════════════════════════════
// onCallTaskWrite (2026-10-03) — a call's follow-up task ticked ANYWHERE
// (the customer page, the Today list, "Said you'd do", a bot) → taskDone on
// the call / text day it came from. home-attention.js callNeedsYou and
// callWatch read it: a kept promise drops the person off "needs you".
// Task ids are cube-<callId> (phone_calls) and sms-<dayId> (phone_text_days).
// A DELETED follow-up task is NOT "dealt with" (2026-10-12 audit: moveCallToLead
// deletes the old task before re-pointing the call, and a lead delete removes
// its tasks; both used to mark the promise kept). Deleting changes nothing; Jo
// closes a call with Handled. Writes only when the value
// changes; the task must sit on the call's own lead.
// ═══════════════════════════════════════════════════════════════════════
const { onDocumentWritten } = require('firebase-functions/v2/firestore');

async function mirrorCallTask({ db, leadId, taskId, after }) {
  const m = /^(cube|sms)-([A-Za-z0-9_-]{5,140})$/.exec(String(taskId || ''));
  if (!m) return null;
  const ref = db.collection(m[1] === 'sms' ? 'phone_text_days' : COLLECTION).doc(m[2]);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const call = snap.data() || {};
  if (call.leadId && call.leadId !== leadId) return null;
  // An UNFILED call / text day has no leadId to compare, and task ids are
  // guessable (sms-txt_<10 digits>_<yyyymmdd>): without this, any signed-in
  // user could tick a "task" on THEIR OWN lead and mark Jo's open text day
  // kept (QA 2026-10-13). The task's lead must belong to the call's tenant.
  if (!call.leadId) {
    const ls = await db.collection('leads').doc(leadId).get();
    const lead = ls && ls.exists ? (ls.data() || {}) : null;
    const sameOwner = !!(lead && call.userId && lead.userId === call.userId);
    const sameCompany = !!(lead && call.companyId && lead.companyId === call.companyId);
    if (!sameOwner && !sameCompany) return null;
  }
  if (!after) return { unchanged: true, taskDeleted: true };
  const done = after.done === true;
  if (call.taskDone === done) return { unchanged: true };
  await ref.set({ taskDone: done }, { merge: true });
  await settleAway(db, call, null, Date.now());
  return { id: m[2], done };
}

exports.onCallTaskWrite = onDocumentWritten(
  { document: 'leads/{leadId}/tasks/{taskId}', region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (event) => {
    // Most tasks are not a call's; skip them before any read.
    if (!/^(cube|sms)-/.test(String(event.params.taskId || ''))) return;
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    try {
      await mirrorCallTask({ db: getFirestore(), leadId: event.params.leadId, taskId: event.params.taskId, after });
    } catch (e) {
      logger.warn('call_task_mirror_failed', { taskId: event.params.taskId, err: e && e.message });
    }
  }
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
// The morning brief's "You said you'd…" section reads the same list.
exports.gatherSweep = gatherSweep;
exports.gatherSweepWithPromises = gatherSweepWithPromises;
exports.stampDigest = stampDigest;

exports._test = {
  runIngest,
  runTranscribe,
  runSweep,
  gatherSweep,
  gatherSweepWithPromises,
  promisesList,
  callAction,
  pushUrgent,
  mirrorCallTask,
  applyLeadContact,
  taggedMatch,
  refileNumber,
  backfillSuggestions,
  reextractFacts,
  FACTS_PER_RUN, FACTS_DAY_CAP,
  readStoredAudio,
  setActionDeps(x) { deps_ = x || {}; },
  setClient(c) { _testClient = c; },
  setDeps(x) { _deps = x; },
  OWNER, COLLECTION, CONFIG,
};
