/**
 * functions/reel-studio.js — Reel Studio's server side (2026-10-04).
 *
 * Built INTO Social Studio (functions/social-studio.js): a rendered reel
 * becomes an ordinary social_posts draft (format 'reel'), approved through
 * socialApprovePost and published by socialPublisher, with the video served
 * from the same /api/social-media?k=<key> route as the photos.
 *
 *   reelStartUpload    (callable) mint an upload slot for a phone clip,
 *                      photo, or an AI-made graphic: companies/{c}/reel_media/{id}
 *                      + the private Storage path reel-uploads/{c}/{uid}/{id}
 *                      the page uploads to (resumable; storage.rules: the
 *                      uploader's own folder, owner / company_admin only,
 *                      never readable by a client).
 *   reelIngestUpload   (Storage trigger) transcode the upload to the
 *                      normalized intermediate reel-work/{c}/{id}.mp4 (or a
 *                      re-encoded .jpg), ALL metadata / data streams
 *                      stripped (GPS!), then DELETE the raw upload.
 *   reelJobMedia       (callable) a finished job's photos + clips for the picker.
 *   reelCreate         (callable) validate + per-company daily cap → a reel
 *                      doc in status 'queued'.
 *   reelRenderWorker   (Firestore trigger on companies/{c}/reels/{id})
 *                      claims a queued reel and renders it (or applies the
 *                      blur): ffmpeg segments + concat, Whisper captions for
 *                      talking-head, then the privacy frame check (Claude
 *                      vision, one frame every ~2 s) + hero thumbnail.
 *   reelConfirmPrivacy (callable) Jo looked at the flagged / unchecked frames.
 *   reelApplyBlur      (callable) re-render with blur boxes over the flagged
 *                      regions for the flagged time ranges.
 *   reelRetry          (callable) re-queue a failed / stuck render.
 *   reelToPosts        (callable) the reel → Social Studio drafts.
 *   reelAiImagePost    (callable) an uploaded AI graphic → a tip / storm-season
 *                      draft, tagged aiGenerated: true. Never a job showcase.
 *   reelCleanup        (daily) intermediates older than 14 days, abandoned
 *                      upload slots, raw uploads left behind.
 *
 * Runtime choice (see documentation/projects/REEL-STUDIO-2026-10-04.md):
 * 2nd-gen Cloud Functions + ffmpeg-static, NOT a Cloud Run job — it ships
 * with the existing `firebase deploy --only functions` pipeline. The worker is
 * event-driven (540 s ceiling); a 90 s 1080x1920 reel renders in roughly
 * 60–150 s on 4 vCPU / 4 GiB.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onObjectFinalized } = require('firebase-functions/v2/storage');
const { onSchedule } = require('./integrations/heartbeat');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { CORS_ORIGINS } = require('./handlers/_shared');
const L = require('./social-logic');
const RL = require('./reel-logic');
const SR = require('./stage-roles');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const VISION_MODEL = 'claude-haiku-4-5-20251001';
const COST_IN = 1.00 / 1e6;
const COST_OUT = 5.00 / 1e6;
// Same per-user monthly vision budget photo-vision / receipt-vision share
// (userCostMeter/{uid}__{month}.visionUsd), same plan table floor.
const VISION_CAP_BY_PLAN = { free: 25, lite: 25, foundation: 25, starter: 25, blueprint: 40, team: 50, growth: 75, professional: 150 };

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UPLOAD_RE = /^reel-uploads\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,64})$/;
const PHOTO_PATH_RE = /^(photos|homeowner-uploads)\//;
const INTERMEDIATE_TTL_MS = 14 * 86400000;

function isEmulator() { return process.env.FUNCTIONS_EMULATOR === 'true'; }

// ffmpeg-static is an OPTIONAL dependency (functions/package.json): its
// install script downloads a ~80 MB binary, and a failed download must not
// fail the whole functions deploy. Without it, every video path stops here
// with this message instead of a cryptic spawn error.
const FFMPEG_MISSING = 'Video rendering is not available: the ffmpeg binary did not install with this deploy (ffmpeg-static is an optional dependency). Redeploy functions, or set FFMPEG_PATH.';
function requireFfmpeg(deps) {
  if (!deps.stub && !(deps.ff && deps.ff.ffmpegPath())) throw new Error(FFMPEG_MISSING);
}

/**
 * The on/off gate (RL.reelSwitch): companies/{c}/social_settings/config.reels
 * must be true and feature_flags/global.reelStudioDisabled must not be.
 * Fails CLOSED: a settings read error counts as off. → null | reason
 */
async function reelsBlocked(db, companyId, getFlags) {
  let settings = null;
  try { const s = await db.doc('companies/' + companyId + '/social_settings/config').get(); settings = s.exists ? s.data() : null; } catch (_) { settings = null; }
  let flags = {};
  try { flags = (getFlags && await getFlags()) || {}; } catch (_) { flags = {}; }
  const sw = RL.reelSwitch(settings, flags);
  return sw.ok ? null : sw.reason;
}
async function requireReelsOn(db, companyId) {
  const why = await reelsBlocked(db, companyId, require('./integrations/killswitch').getFlags);
  if (why) throw new HttpsError('failed-precondition', why);
}
function randomKey() { return crypto.randomBytes(16).toString('hex'); }
function sm() { return require('./social-studio')._test; }
function reelsCol(db, c) { return db.collection('companies').doc(c).collection('reels'); }
function mediaCol(db, c) { return db.collection('companies').doc(c).collection('reel_media'); }

// ── Daily render cap (transaction on companies/{c}/reel_usage/{day}) ─────
async function takeRenderSlot(db, companyId, nowMs, cap) {
  const ref = db.doc('companies/' + companyId + '/reel_usage/' + RL.dayKey(nowMs));
  const limit = cap || RL.DAILY_RENDER_CAP;
  let ok = false;
  let used = 0;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    used = (s.exists && Number(s.data().renders)) || 0;
    ok = used < limit;
    if (ok) tx.set(ref, { renders: used + 1, day: RL.dayKey(nowMs), updatedAtMs: nowMs }, { merge: true });
  });
  if (!ok) throw new HttpsError('resource-exhausted', 'That is ' + limit + ' renders today — the daily cap. It resets at midnight Eastern.');
  return used + 1;
}

// ── Vision (privacy frame check) ────────────────────────────────────────
const VISION_SYSTEM = [
  'You check frames from a roofing company\'s short social video BEFORE it is posted publicly.',
  'Flag anything that could identify a customer\'s home or a person:',
  '  house_number  — a readable house number, mailbox number or address plaque',
  '  license_plate — a readable vehicle license plate',
  '  street_sign   — a readable street-name sign',
  '  face          — a person\'s face that is visible enough to recognise',
  'For each flag give box = [x, y, w, h] as fractions (0–1) of the frame width/height, top-left origin, and confidence 0–1.',
  'Also give heroScore 0–1 per frame: how good it is as the cover thumbnail (finished roof clearly visible, sharp, well lit; text cards score 0).',
  'Reply with STRICT JSON only: {"frames":[{"i":<frame index>,"flags":[{"type":"house_number","box":[0.1,0.2,0.05,0.03],"confidence":0.8}],"heroScore":0.6}]}',
  'Include every frame index you were given, with an empty flags array when nothing is found.',
].join('\n');

/**
 * frames: [{ t, b64 }]. deps: { apiKey, fetchFn, batch }. → { ran, raw, costUsd, error }
 * Never throws: a failed check returns ran:false (→ 'unchecked', Jo confirms).
 */
async function callVision(frames, deps) {
  const fetchFn = deps.fetchFn || fetch;
  const batch = deps.batch || 10;
  const merged = { frames: [] };
  let cost = 0;
  try {
    for (let s = 0; s < frames.length; s += batch) {
      const content = [];
      frames.slice(s, s + batch).forEach((f, j) => {
        content.push({ type: 'text', text: 'Frame ' + (s + j) + ' (t=' + f.t + 's)' });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.b64 } });
      });
      content.push({ type: 'text', text: 'Return the JSON for frames ' + s + '–' + (s + Math.min(batch, frames.length - s) - 1) + '.' });
      const res = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': deps.apiKey },
        body: JSON.stringify({ model: VISION_MODEL, max_tokens: 1500, system: VISION_SYSTEM, messages: [{ role: 'user', content }] }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) return { ran: false, error: 'vision HTTP ' + res.status, costUsd: cost };
      const u = data.usage || {};
      cost += (u.input_tokens || 0) * COST_IN + (u.output_tokens || 0) * COST_OUT;
      const block = (data.content || []).find((b) => b && b.type === 'text');
      const text = String((block && block.text) || '').replace(/^```(?:json)?\s*|\s*```\s*$/g, '').trim();
      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { return { ran: false, error: 'vision returned unparseable JSON', costUsd: cost }; }
      const got = Array.isArray(parsed && parsed.frames) ? parsed.frames : [];
      // Every frame of the batch must be answered, or the check did not run.
      const want = Math.min(batch, frames.length - s);
      if (got.length < want) return { ran: false, error: 'vision skipped frames', costUsd: cost };
      merged.frames.push(...got);
    }
  } catch (e) {
    return { ran: false, error: 'vision failed: ' + ((e && e.message) || e), costUsd: cost };
  }
  return { ran: true, raw: merged, costUsd: cost };
}

/** The gate in front of every vision call: kill switch, emulator, key, budget. → null | reason */
async function visionBlocked(db, uid, companyId, deps) {
  if (await deps.aiDisabled()) return 'ai_disabled';
  if (deps.emulator) return 'emulator';
  if (!deps.apiKey) return 'not_configured';
  try {
    const month = new Date(deps.nowMs || Date.now()).toISOString().slice(0, 7);
    const [m, sub] = await Promise.all([db.doc('userCostMeter/' + uid + '__' + month).get(), db.doc('subscriptions/' + companyId).get()]);
    const used = (m.exists && Number(m.data().visionUsd)) || 0;
    const plan = (sub.exists && sub.data().plan) || 'lite';
    const cap = VISION_CAP_BY_PLAN[plan] != null ? VISION_CAP_BY_PLAN[plan] : Math.min.apply(null, Object.values(VISION_CAP_BY_PLAN));
    if (used >= cap) return 'budget';
  } catch (_) { /* meter read failed: fail open like the other vision callers */ }
  return null;
}

async function meterVision(db, uid, usd, nowMs) {
  if (!(usd > 0)) return;
  const month = new Date(nowMs || Date.now()).toISOString().slice(0, 7);
  await db.doc('userCostMeter/' + uid + '__' + month).set({
    uid, monthKey: month, visionUsd: FieldValue.increment(usd), visionCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true }).catch(() => {});
}

// ── Sources ─────────────────────────────────────────────────────────────
async function loadLeadFor(db, leadId, companyId, uid) {
  if (!leadId) return null;
  if (!ID_RE.test(String(leadId))) throw new HttpsError('invalid-argument', 'Bad job.');
  const s = await db.doc('leads/' + leadId).get();
  const lead = s.exists ? s.data() : null;
  if (!lead || lead.deleted || !sm().leadInCompany(lead, companyId, uid)) throw new HttpsError('not-found', 'That job was not found.');
  return lead;
}

/**
 * Resolve the request's clips to verified sources (server truth, never the
 * client's word): job photos must belong to the reel's job + tenant; uploads
 * must be this company's, ready, and NOT AI-made.
 * → [{ source, photoId|mediaId, type, storagePath, durationSec, hasAudio, aiGenerated }]
 */
async function resolveClips(db, companyId, uid, leadId, lead, clips) {
  const out = [];
  for (const c of (Array.isArray(clips) ? clips : []).slice(0, 20)) {
    if (c && c.source === 'job_photo' && ID_RE.test(String(c.photoId || ''))) {
      if (!leadId) throw new HttpsError('invalid-argument', 'Pick the job first.');
      const s = await db.doc('photos/' + c.photoId).get();
      const p = s.exists ? s.data() : null;
      const pathStr = p && (p.storagePath || p.path);
      const sameTenant = p && (p.companyId ? String(p.companyId) === companyId : (p.userId === uid || p.userId === (lead && lead.userId)));
      if (!p || p.leadId !== leadId || !sameTenant || typeof pathStr !== 'string' || !PHOTO_PATH_RE.test(pathStr) || p.deleted) {
        throw new HttpsError('not-found', 'A picked photo is not part of this job.');
      }
      out.push({ source: 'job_photo', photoId: c.photoId, type: 'photo', storagePath: pathStr, phase: String(p.phase || '').toLowerCase() });
    } else if (c && c.source === 'upload' && ID_RE.test(String(c.mediaId || ''))) {
      const s = await mediaCol(db, companyId).doc(c.mediaId).get();
      const m = s.exists ? s.data() : null;
      if (!m || m.status !== 'ready' || !m.workPath) throw new HttpsError('failed-precondition', 'A clip is still processing (or failed). Wait for it, then try again.');
      out.push({ source: 'upload', mediaId: c.mediaId, type: m.kind, storagePath: m.workPath, durationSec: m.durationSec || 0, hasAudio: !!m.hasAudio, aiGenerated: m.aiGenerated === true });
    } else {
      throw new HttpsError('invalid-argument', 'Bad clip in the request.');
    }
  }
  return out;
}

// ── The worker ──────────────────────────────────────────────────────────
/**
 * Claim → render (or blur) → store → privacy check. All I/O injected:
 * deps { db, bucket, ff (reel-ffmpeg), nowMs, reencode, transcribe(buf) →
 * { words, segments }, vision(frames) → callVision result, visionGate(uid) →
 * null|reason, meter(uid, usd), stub: boolean, logger }.
 */
async function processReel(companyId, reelId, deps) {
  const { db } = deps;
  const ref = reelsCol(db, companyId).doc(reelId);
  const nowMs = deps.nowMs || Date.now();
  const claimId = crypto.randomBytes(8).toString('hex');
  // Off switch first (fails closed when the gate is missing): a queued reel
  // in a company that turned Reel Studio off — or with the platform kill
  // switch pulled — is failed with the reason, never rendered. Retry
  // re-queues it once the switch is back on.
  const off = deps.reelsGate ? await deps.reelsGate(companyId) : 'Reel Studio gate missing.';
  if (off) {
    let failedIt = false;
    await db.runTransaction(async (tx) => {
      failedIt = false;
      const s = await tx.get(ref);
      if (!s.exists || s.data().status !== 'queued') return;
      tx.update(ref, { status: 'failed', op: null, render: Object.assign({}, s.data().render, { error: off, finishedAtMs: nowMs }), updatedAt: FieldValue.serverTimestamp() });
      failedIt = true;
    });
    return failedIt ? { ok: false, off: true, error: off } : { skipped: true };
  }
  let reel = null;
  await db.runTransaction(async (tx) => {
    reel = null;
    const s = await tx.get(ref);
    if (!s.exists) return;
    const d = s.data();
    if (d.status !== 'queued') return;
    tx.update(ref, { status: 'rendering', render: Object.assign({}, d.render, { claimId, startedAtMs: nowMs, error: null }), updatedAt: FieldValue.serverTimestamp() });
    reel = d;
  });
  if (!reel) return { skipped: true };
  try {
    const result = reel.op === 'blur' ? await doBlur(companyId, reelId, reel, deps) : await doRender(companyId, reelId, reel, deps);
    await ref.update(Object.assign(result, { status: 'rendered', op: null, render: Object.assign({}, reel.render, { claimId, startedAtMs: nowMs, finishedAtMs: Date.now(), error: null }), updatedAt: FieldValue.serverTimestamp() }));
    if (reel.op === 'blur') {
      const stillLive = await repointPosts(db, companyId, reel.postIds || [], result.output);
      // The unblurred MP4 is deleted unless a post already went out with it.
      if (!stillLive) await deleteMedia(db, deps.bucket, result.output.blurredFrom);
    }
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 400);
    if (deps.logger) deps.logger.error('reel render failed', { companyId, reelId, err: msg });
    await ref.update({ status: 'failed', op: null, render: Object.assign({}, reel.render, { claimId, error: msg, finishedAtMs: Date.now() }), updatedAt: FieldValue.serverTimestamp() });
    return { ok: false, error: msg };
  }
}

/**
 * After a blur, the reel's not-yet-posted drafts switch to the blurred MP4
 * and go back to 'draft' (re-approval). Posted / publishing posts are left
 * alone — and the publisher's reel_stale check refuses any stragglers.
 */
async function repointPosts(db, companyId, postIds, output) {
  let stillLive = false;
  for (const id of postIds.slice(0, 20)) {
    const pref = db.doc('companies/' + companyId + '/social_posts/' + id);
    await db.runTransaction(async (tx) => {
      const s = await tx.get(pref);
      if (!s.exists) return;
      const p = s.data();
      if (p.status === 'posted' || p.status === 'publishing') { stillLive = true; return; }
      tx.update(pref, { media: [{ key: output.key, role: 'video' }], video: Object.assign({}, p.video, { key: output.key }), status: 'draft', updatedAt: FieldValue.serverTimestamp() });
    }).catch(() => { stillLive = true; });
  }
  return stillLive;
}

async function storeMedia(db, bucket, companyId, buf, ext, extra) {
  const key = randomKey();
  const contentType = ext === 'mp4' ? 'video/mp4' : 'image/jpeg';
  const p = 'social-media/' + companyId + '/' + key + '.' + ext;
  await bucket.file(p).save(buf, { contentType, resumable: false, metadata: { cacheControl: 'public, max-age=86400' } });
  await db.doc('social_media/' + key).set(Object.assign({ companyId, path: p, contentType, bytes: buf.length, createdAt: FieldValue.serverTimestamp() }, extra || {}));
  return key;
}

async function deleteMedia(db, bucket, key) {
  if (!key) return;
  try {
    const s = await db.doc('social_media/' + key).get();
    if (s.exists && s.data().path) await bucket.file(s.data().path).delete().catch(() => {});
    await db.doc('social_media/' + key).delete();
  } catch (_) { /* best effort */ }
}

async function privacyCheck(dir, outFile, durationSec, reel, deps) {
  const { db, ff } = deps;
  const uid = reel.requestedBy;
  const frames = deps.stub ? [] : await ff.sampleFrames(dir, outFile, durationSec, RL.FRAME_WIDTH);
  const times = frames.map((f) => f.t);
  let check = { ran: false, reason: deps.stub ? 'emulator' : 'no_frames' };
  if (frames.length) {
    const blocked = await deps.visionGate(uid, reel.companyId);
    if (blocked) check = { ran: false, reason: blocked };
    else {
      const res = await deps.vision(frames.map((f) => ({ t: f.t, b64: fs.readFileSync(f.file).toString('base64') })));
      await deps.meter(uid, res.costUsd || 0);
      check = res.ran ? Object.assign({ ran: true }, RL.sanitizeVision(res.raw, times), { costUsd: res.costUsd }) : { ran: false, reason: res.error || 'vision_failed', costUsd: res.costUsd || 0 };
    }
  }
  return { check, times };
}

async function doRender(companyId, reelId, reel, deps) {
  const { db, bucket, ff } = deps;
  const req = RL.validateRequest({ template: reel.template, aspect: reel.aspect, params: reel.params, clips: (reel.clips || []).map((c) => ({ type: c.type, aiGenerated: c.aiGenerated })) });
  let terms = [];
  if (reel.sourceLeadId) {
    const ls = await db.doc('leads/' + reel.sourceLeadId).get();
    if (ls.exists) terms = L.privateTerms(ls.data());
  }
  const facts = reel.facts || {};
  const textDropped = [];
  const titleIn = req.params.title || (facts.town ? 'New roof · ' + facts.town + (facts.state ? ', ' + facts.state : '') : '');
  const title = RL.safeOverlayText(titleIn, terms);
  if (title.dropped) textDropped.push({ rule: title.dropped, text: 'title' });
  const lines = req.template === 'job_of_week' ? RL.jobOfWeekLines(facts, terms) : [];

  requireFfmpeg(deps);
  return ff.withWorkDir(async (dir) => {
    let outFile;
    let captions = { status: 'none', groups: 0 };
    let speechDropped = [];
    if (deps.stub) {
      outFile = path.join(dir, 'out.mp4');
      fs.copyFileSync(path.join(ff.ASSET_DIR, 'emulator-stub.mp4'), outFile);
    } else {
      // Pull every source into the work dir (job photos re-encoded: EXIF gone).
      const local = [];
      for (let i = 0; i < reel.clips.length; i++) {
        const c = reel.clips[i];
        const [buf] = await bucket.file(c.storagePath).download();
        if (c.type === 'photo') {
          const jpeg = c.source === 'job_photo' ? await deps.reencode(buf, 'jpeg') : buf;
          fs.writeFileSync(path.join(dir, 'c' + i + '.jpg'), jpeg);
          local.push({ file: 'c' + i + '.jpg', type: 'photo' });
        } else {
          fs.writeFileSync(path.join(dir, 'c' + i + '.mp4'), buf);
          local.push({ file: 'c' + i + '.mp4', type: 'video', durationSec: c.durationSec, hasAudio: c.hasAudio });
        }
      }
      let captionGroups = [];
      if (req.template === 'talking_head' && req.params.captions && local[0].hasAudio) {
        // The SAME window buildPlan trims to (shared helper) — the caption
        // timestamps Whisper returns are relative to this audio's start.
        const trim = RL.talkingHeadWindow(req.params, local[0].durationSec);
        const tr = await transcribeTrim(dir, local[0].file, trim, deps);
        if (tr.ok) {
          const words = (tr.words && tr.words.length) ? tr.words : RL.wordsFromSegments(tr.segments);
          const filtered = RL.filterTranscriptWords(words, terms);
          speechDropped = filtered.dropped;
          captionGroups = RL.groupWords(filtered.words);
          captions = { status: 'burned', groups: captionGroups.length, dropped: speechDropped.length };
        } else {
          captions = { status: 'unavailable', reason: tr.reason };
        }
      }
      const scores = req.template === 'drone_cut' ? await ff.droneScores(dir, local[0].file) : null;
      const plan = RL.buildPlan(req, local, { title: title.text, lines, captionGroups }, { droneScores: scores });
      outFile = await ff.renderPlan(dir, plan);
    }
    const pr = await ff.probe(outFile, { cwd: dir }).catch(() => ({ durationSec: deps.stub ? 3 : 0 }));
    const durationSec = pr.durationSec || (deps.stub ? 3 : 0);
    if (durationSec > RL.MAX_DURATION_S + 0.6) throw new Error('Render ran ' + durationSec + ' s — over the ' + RL.MAX_DURATION_S + ' s cap.');
    const { check, times } = await privacyCheck(dir, outFile, durationSec, Object.assign({ companyId }, reel), deps);
    // Hero thumbnail: the vision pick, else a third of the way in.
    const heroT = check.ran && check.heroIndex >= 0 ? times[check.heroIndex] : Math.max(0, Math.min(durationSec - 0.2, RL.INTRO_S + 1));
    let thumbBuf;
    if (deps.stub) thumbBuf = await deps.reencode(fs.readFileSync(path.join(ff.ASSET_DIR, 'logo.png')), 'jpeg');
    else {
      await ff.run(RL.frameArgs('out.mp4', heroT, 'hero.jpg', 1080), { cwd: dir });
      thumbBuf = fs.readFileSync(path.join(dir, 'hero.jpg'));
    }
    const videoBuf = fs.readFileSync(outFile);
    const oldOut = reel.output || {};
    const key = await storeMedia(db, bucket, companyId, videoBuf, 'mp4', { kind: 'reel', reelId });
    const thumbKey = await storeMedia(db, bucket, companyId, thumbBuf, 'jpg', { kind: 'reel_thumb', reelId });
    if (oldOut.key && !(reel.postIds || []).length) { await deleteMedia(db, bucket, oldOut.key); await deleteMedia(db, bucket, oldOut.thumbKey); }
    const privacy = {
      status: RL.privacyStatusFrom({ ran: check.ran, flags: check.flags, speechDropped, textDropped }),
      ran: !!check.ran, reason: check.ran ? null : (check.reason || null),
      flags: check.flags || [], speechDropped, textDropped, heroT,
      checkedAtMs: Date.now(), costUsd: Math.round((check.costUsd || 0) * 10000) / 10000,
    };
    return {
      output: { key, thumbKey, durationSec, bytes: videoBuf.length, aspect: req.aspect, stub: !!deps.stub },
      captions, privacy,
    };
  });
}

async function transcribeTrim(dir, file, trim, deps) {
  const gate = await deps.transcribeGate();
  if (gate) return { ok: false, reason: gate };
  try {
    await deps.ff.run(RL.audioArgs(file, trim.start, trim.end, 'speech.m4a'), { cwd: dir });
    const out = await deps.transcribe(fs.readFileSync(path.join(dir, 'speech.m4a')));
    return { ok: true, words: out.words || [], segments: out.segments || [] };
  } catch (e) {
    return { ok: false, reason: 'whisper_failed: ' + String((e && e.message) || e).slice(0, 160) };
  }
}

async function doBlur(companyId, reelId, reel, deps) {
  const { db, bucket, ff } = deps;
  if (!RL.blurAvailable(reel)) throw new Error('This reel has nothing the auto-blur can fix.');
  requireFfmpeg(deps);
  return ff.withWorkDir(async (dir) => {
    const idx = await db.doc('social_media/' + reel.output.key).get();
    if (!idx.exists) throw new Error('The rendered reel is missing.');
    const [buf] = await bucket.file(idx.data().path).download();
    fs.writeFileSync(path.join(dir, 'in.mp4'), buf);
    const A = RL.ASPECTS[reel.aspect] || RL.ASPECTS['9:16'];
    const regions = RL.blurRegions(reel.privacy.flags, A.w, A.h, reel.output.durationSec);
    if (deps.stub) fs.copyFileSync(path.join(dir, 'in.mp4'), path.join(dir, 'out.mp4'));
    else await ff.run(RL.blurArgs('in.mp4', 'out.mp4', regions), { cwd: dir });
    const videoBuf = fs.readFileSync(path.join(dir, 'out.mp4'));
    const key = await storeMedia(db, bucket, companyId, videoBuf, 'mp4', { kind: 'reel', reelId, blurred: true });
    return {
      output: Object.assign({}, reel.output, { key, bytes: videoBuf.length, blurredFrom: reel.output.key }),
      privacy: Object.assign({}, reel.privacy, { status: 'blurred', blurRegions: regions, blurredAtMs: Date.now(), blurredBy: reel.blurRequestedBy || null }),
    };
  });
}

// ── Ingest (Storage trigger) ────────────────────────────────────────────
/** deps { db, bucket, ff, reencode, heicToJpeg, stubNoFfmpeg } */
async function ingestUpload(name, contentType, size, deps) {
  const m = UPLOAD_RE.exec(String(name || ''));
  if (!m) return { skipped: true };
  const [, companyId, uploaderUid, mediaId] = m;
  const { db, bucket, ff } = deps;
  const ref = mediaCol(db, companyId).doc(mediaId);
  const raw = bucket.file(name);
  try {
    const s = await ref.get();
    const doc = s.exists ? s.data() : null;
    if (!doc || doc.status !== 'awaiting_upload' || doc.uploadPath !== name || doc.createdBy !== uploaderUid) {
      return { refused: 'no matching upload slot' };
    }
    if (Number(size) > RL.MAX_UPLOAD_BYTES) { await ref.update({ status: 'failed', error: 'File is over 500 MB.' }); return { refused: 'size' }; }
    const off = deps.reelsGate ? await deps.reelsGate(companyId) : 'Reel Studio gate missing.';
    if (off) { await ref.update({ status: 'failed', error: off }); return { refused: 'off' }; }
    await ref.update({ status: 'processing', updatedAt: FieldValue.serverTimestamp() });
    return await ff.withWorkDir(async (dir) => {
      const [buf] = await raw.download();
      if (doc.kind === 'photo') {
        let src = buf;
        if (/heic|heif/i.test(contentType || '') || isHeic(buf)) src = await deps.heicToJpeg(buf);
        const jpeg = await deps.reencode(src, 'jpeg');
        const workPath = 'reel-work/' + companyId + '/' + mediaId + '.jpg';
        await bucket.file(workPath).save(jpeg, { contentType: 'image/jpeg', resumable: false });
        await ref.update({ status: 'ready', workPath, bytes: jpeg.length, readyAt: FieldValue.serverTimestamp() });
        return { ok: true, kind: 'photo' };
      }
      if (!ff.ffmpegPath()) throw new Error(FFMPEG_MISSING);
      const inFile = path.join(dir, 'raw');
      fs.writeFileSync(inFile, buf);
      const pr = await ff.normalize(inFile, path.join(dir, 'norm.mp4'));
      if (!pr.hasVideo || !(pr.durationSec > 0)) throw new Error('That file has no playable video.');
      const workPath = 'reel-work/' + companyId + '/' + mediaId + '.mp4';
      const out = fs.readFileSync(path.join(dir, 'norm.mp4'));
      await bucket.file(workPath).save(out, { contentType: 'video/mp4', resumable: false });
      await ref.update({ status: 'ready', workPath, bytes: out.length, durationSec: pr.durationSec, hasAudio: pr.hasAudio, width: pr.width, height: pr.height, readyAt: FieldValue.serverTimestamp() });
      return { ok: true, kind: 'video', durationSec: pr.durationSec };
    });
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    await ref.update({ status: 'failed', error: msg, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    return { error: msg };
  } finally {
    // The raw upload carries the phone's GPS / device metadata: it never
    // outlives this run, success or failure.
    await raw.delete().catch(() => {});
  }
}

function isHeic(buf) {
  if (!buf || buf.length < 12) return false;
  const brand = buf.slice(4, 12).toString('latin1');
  return /^ftyp(heic|heix|hevc|heim|heis|mif1|msf1)/.test(brand);
}

// ── Callables ───────────────────────────────────────────────────────────
const callOpts = { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true };

exports.reelStartUpload = onCall(Object.assign({}, callOpts, { timeoutSeconds: 30 }), async (request) => {
  const ctx = sm().requireSocialManager(request, (t) => t.role === 'admin');
  const d = request.data || {};
  const ct = String(d.contentType || '').toLowerCase();
  const purpose = d.purpose === 'ai_image' ? 'ai_image' : 'clip';
  const isVideo = RL.VIDEO_TYPES.test(ct);
  const isImage = RL.IMAGE_TYPES.test(ct);
  if (!isVideo && !isImage) throw new HttpsError('invalid-argument', 'Videos (mp4 / mov) or photos only.');
  if (!(Number(d.bytes) > 0) || Number(d.bytes) > RL.MAX_UPLOAD_BYTES) throw new HttpsError('invalid-argument', 'Files up to 500 MB.');
  let postKind = null;
  if (purpose === 'ai_image') {
    if (!isImage) throw new HttpsError('invalid-argument', 'An AI graphic must be an image.');
    if (!RL.aiImageAllowedFor(d.postKind)) throw new HttpsError('failed-precondition', 'AI-made images are for tip and storm-season posts only — never a job showcase.');
    postKind = d.postKind;
  }
  const db = getFirestore();
  await requireReelsOn(db, ctx.companyId);
  let leadId = null;
  if (d.leadId && purpose === 'clip') { await loadLeadFor(db, d.leadId, ctx.companyId, ctx.uid); leadId = d.leadId; }
  const ref = mediaCol(db, ctx.companyId).doc();
  const uploadPath = 'reel-uploads/' + ctx.companyId + '/' + ctx.uid + '/' + ref.id;
  await ref.set({
    kind: isVideo ? 'video' : 'photo', purpose, aiGenerated: purpose === 'ai_image', postKind, leadId,
    contentType: ct, declaredBytes: Number(d.bytes), name: String(d.name || '').replace(/[^\w .()-]/g, '').slice(0, 80),
    status: 'awaiting_upload', uploadPath, companyId: ctx.companyId, createdBy: ctx.uid,
    createdAt: FieldValue.serverTimestamp(), createdAtMs: Date.now(),
  });
  return { mediaId: ref.id, path: uploadPath };
});

exports.reelJobMedia = onCall(Object.assign({}, callOpts, { timeoutSeconds: 60 }), async (request) => {
  const ctx = sm().requireSocialManager(request, (t) => t.role === 'admin');
  const db = getFirestore();
  const leadId = (request.data || {}).leadId;
  const lead = await loadLeadFor(db, leadId, ctx.companyId, ctx.uid);
  const photos = (await sm().leadPhotos(db, leadId, lead, ctx))
    .filter((p) => !p.deleted && !p.hidden)
    .map((p) => ({ id: p.id, phase: String(p.phase || (p.aiSuggestion && p.aiSuggestion.phase) || '').toLowerCase(), createdAtMs: L.ms(p.createdAt || p.uploadedAt) }))
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  const clips = [];
  (await mediaCol(db, ctx.companyId).where('leadId', '==', leadId).limit(50).get()).forEach((s) => {
    const m = s.data();
    if (m.status === 'ready' && !m.aiGenerated) clips.push({ mediaId: s.id, kind: m.kind, durationSec: m.durationSec || 0, name: m.name || '' });
  });
  const facts = L.jobFacts(lead);
  return { photos, clips, facts, finished: SR.isWon(lead) };
});

exports.reelCreate = onCall(Object.assign({}, callOpts, { timeoutSeconds: 60 }), async (request) => {
  const ctx = sm().requireSocialManager(request, (t) => t.role === 'admin');
  const d = request.data || {};
  const db = getFirestore();
  await requireReelsOn(db, ctx.companyId);
  // Fail before spending a render slot when the binary is not there.
  if (!isEmulator() && !require('./reel-ffmpeg').ffmpegPath()) throw new HttpsError('failed-precondition', FFMPEG_MISSING);
  const lead = d.leadId ? await loadLeadFor(db, d.leadId, ctx.companyId, ctx.uid) : null;
  const clips = await resolveClips(db, ctx.companyId, ctx.uid, d.leadId || null, lead, d.clips);
  let req;
  try { req = RL.validateRequest({ template: d.template, aspect: d.aspect, params: d.params, clips }); } catch (e) { throw new HttpsError('invalid-argument', e.message); }
  if (RL.TEMPLATES[req.template].jobShowcase && lead && !SR.isWon(lead)) throw new HttpsError('failed-precondition', 'Job reels come from finished jobs (install complete or later).');
  // Phone clips tagged to another job cannot ride along on this one.
  for (const c of clips) if (c.source === 'upload') {
    const m = (await mediaCol(db, ctx.companyId).doc(c.mediaId).get()).data() || {};
    if (m.leadId && d.leadId && m.leadId !== d.leadId) throw new HttpsError('invalid-argument', 'A clip belongs to a different job.');
  }
  const nowMs = Date.now();
  await takeRenderSlot(db, ctx.companyId, nowMs);
  const ref = reelsCol(db, ctx.companyId).doc();
  await ref.set({
    template: req.template, aspect: req.aspect, params: req.params,
    kind: RL.reelPostKind(req.template, d.kind),
    clips, sourceLeadId: d.leadId || null, facts: lead ? L.jobFacts(lead) : {},
    status: 'queued', op: 'render', render: { requestedAtMs: nowMs },
    privacy: { status: 'pending' }, postIds: [], companyId: ctx.companyId,
    requestedBy: ctx.uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    estimate: RL.estimateCostUsd({ durationSec: 30, transcribe: req.template === 'talking_head' }),
  });
  return { reelId: ref.id };
});

async function loadReel(db, ctx, reelId) {
  if (typeof reelId !== 'string' || !ID_RE.test(reelId)) throw new HttpsError('invalid-argument', 'Missing reel.');
  const ref = reelsCol(db, ctx.companyId).doc(reelId);
  const s = await ref.get();
  if (!s.exists) throw new HttpsError('not-found', 'Reel not found.');
  return { ref, reel: s.data() };
}

exports.reelConfirmPrivacy = onCall(Object.assign({}, callOpts, { timeoutSeconds: 30 }), async (request) => {
  const ctx = sm().requireSocialManager(request, (t) => t.role === 'admin');
  const db = getFirestore();
  const { ref, reel } = await loadReel(db, ctx, (request.data || {}).reelId);
  if (reel.status !== 'rendered') throw new HttpsError('failed-precondition', 'The reel has not finished rendering.');
  const st = (reel.privacy || {}).status;
  if (st !== 'flagged' && st !== 'unchecked') throw new HttpsError('failed-precondition', 'Nothing to confirm.');
  await ref.update({ 'privacy.status': 'confirmed', 'privacy.confirmedBy': ctx.uid, 'privacy.confirmedAtMs': Date.now(), 'privacy.confirmedFrom': st, updatedAt: FieldValue.serverTimestamp() });
  return { status: 'confirmed' };
});

exports.reelApplyBlur = onCall(Object.assign({}, callOpts, { timeoutSeconds: 30 }), async (request) => {
  const ctx = sm().requireSocialManager(request, (t) => t.role === 'admin');
  const db = getFirestore();
  const { ref, reel } = await loadReel(db, ctx, (request.data || {}).reelId);
  if (reel.status !== 'rendered' || !RL.blurAvailable(reel)) throw new HttpsError('failed-precondition', 'Auto-blur needs a box for every flagged frame (and no flagged speech). Watch the reel and confirm instead.');
  await requireReelsOn(db, ctx.companyId);
  await takeRenderSlot(db, ctx.companyId, Date.now());
  await ref.update({ status: 'queued', op: 'blur', blurRequestedBy: ctx.uid, updatedAt: FieldValue.serverTimestamp() });
  return { status: 'queued' };
});

exports.reelRetry = onCall(Object.assign({}, callOpts, { timeoutSeconds: 30 }), async (request) => {
  const ctx = sm().requireSocialManager(request, (t) => t.role === 'admin');
  const db = getFirestore();
  const { ref, reel } = await loadReel(db, ctx, (request.data || {}).reelId);
  const stale = reel.status === 'rendering' && Date.now() - Number((reel.render || {}).startedAtMs || 0) > RL.STALE_RENDER_MS;
  if (reel.status !== 'failed' && !stale) throw new HttpsError('failed-precondition', 'Only a failed (or stuck) render can be retried.');
  await requireReelsOn(db, ctx.companyId);
  await takeRenderSlot(db, ctx.companyId, Date.now());
  await ref.update({ status: 'queued', op: reel.op === 'blur' ? 'blur' : 'render', updatedAt: FieldValue.serverTimestamp() });
  return { status: 'queued' };
});

function defaultSlotMs(nowMs) {
  const y = L.zonedYmd(nowMs + 86400000);
  return L.zonedMs(y.y, y.m, y.d, 10, 0);
}

/** The reel → one Social Studio draft per platform (format 'reel'). Pure-ish: db injected. */
async function reelPostsFor(db, ctx, reelId, reel, data) {
  if (reel.status !== 'rendered' || !reel.output || !reel.output.key) throw new HttpsError('failed-precondition', 'The reel has not finished rendering.');
  const platforms = sm().cleanPlatforms(data.platforms, ['facebook', 'instagram']);
  const kind = RL.reelPostKind(reel.template, data.kind || reel.kind);
  let terms = [];
  if (reel.sourceLeadId) { const ls = await db.doc('leads/' + reel.sourceLeadId).get(); if (ls.exists) terms = L.privateTerms(ls.data()); }
  const facts = reel.facts || {};
  const seed = Math.floor(Math.random() * 1000);
  const raw = kind === 'job_showcase' ? L.templateCaption('job_showcase', facts, seed) : L.templateCaption(kind, facts, seed);
  const cleaned = L.cleanCaption(raw, { privateTerms: terms });
  const tags = L.cleanHashtags(L.hashtagsFor(facts, kind).concat(['#reels']), { privateTerms: terms });
  const schedMs = Number(data.scheduledAtMs) > Date.now() ? Number(data.scheduledAtMs) : defaultSlotMs(Date.now());
  const groupId = crypto.randomBytes(8).toString('hex');
  const created = [];
  for (const platform of platforms) {
    const ref = db.collection('companies').doc(ctx.companyId).collection('social_posts').doc();
    await ref.set({
      kind, platform, format: 'reel',
      caption: L.limitCaption(cleaned.text, platform), hashtags: L.limitHashtags(tags, platform),
      media: [{ key: reel.output.key, role: 'video' }],
      video: { key: reel.output.key, thumbKey: reel.output.thumbKey || null, durationSec: reel.output.durationSec || 0, aspect: reel.aspect || '9:16', thumbOffsetMs: Math.round(((reel.privacy && reel.privacy.heroT) || 0) * 1000) },
      reelId, aiGenerated: false,
      town: facts.town || '', state: facts.state || '', packageLabel: facts.packageLabel || '', shingle: facts.shingle || '',
      sourceLeadId: reel.sourceLeadId || null, status: 'draft', captionFilter: { dropped: cleaned.dropped.length },
      companyId: ctx.companyId, createdBy: ctx.uid, groupId, scheduledAt: Timestamp.fromMillis(schedMs), source: 'reel',
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    created.push({ id: ref.id, platform });
  }
  return { created, kind, scheduledAtMs: schedMs };
}

exports.reelToPosts = onCall(Object.assign({}, callOpts, { timeoutSeconds: 60 }), async (request) => {
  const ctx = sm().requireSocialManager(request, (t) => t.role === 'admin');
  const db = getFirestore();
  const d = request.data || {};
  const { ref, reel } = await loadReel(db, ctx, d.reelId);
  const res = await reelPostsFor(db, ctx, d.reelId, reel, d);
  await ref.update({ postIds: FieldValue.arrayUnion(...res.created.map((c) => c.id)), updatedAt: FieldValue.serverTimestamp() });
  return res;
});

/** An uploaded AI graphic → tip / storm-season drafts (aiGenerated: true). */
async function aiImagePostsFor(db, bucket, ctx, mediaId, data) {
  if (typeof mediaId !== 'string' || !ID_RE.test(mediaId)) throw new HttpsError('invalid-argument', 'Missing image.');
  const ms = await mediaCol(db, ctx.companyId).doc(mediaId).get();
  const m = ms.exists ? ms.data() : null;
  if (!m || m.purpose !== 'ai_image' || m.aiGenerated !== true) throw new HttpsError('not-found', 'That AI image was not found.');
  if (m.status !== 'ready' || !m.workPath) throw new HttpsError('failed-precondition', 'The image is still processing.');
  const kind = data.kind || m.postKind;
  if (!RL.aiImageAllowedFor(kind)) throw new HttpsError('failed-precondition', 'AI-made images are for tip and storm-season posts only — never a job showcase.');
  const [buf] = await bucket.file(m.workPath).download();
  const key = await storeMedia(db, bucket, ctx.companyId, buf, 'jpg', { kind: 'ai_image', aiGenerated: true, mediaId });
  const platforms = sm().cleanPlatforms(data.platforms, ['facebook', 'instagram']);
  const seed = Math.floor(Math.random() * 1000);
  // Honest label: the graphic is AI-made (platform AI-label rules, and Jo's
  // rule that AI never passes for real work).
  const caption = L.cleanCaption(L.templateCaption(kind, {}, seed) + ' (Graphic made with AI.)', {}).text;
  const tags = L.hashtagsFor({}, kind);
  const schedMs = Number(data.scheduledAtMs) > Date.now() ? Number(data.scheduledAtMs) : defaultSlotMs(Date.now());
  const created = [];
  for (const platform of platforms) {
    const ref = db.collection('companies').doc(ctx.companyId).collection('social_posts').doc();
    await ref.set({
      kind, platform, format: 'single', caption: L.limitCaption(caption, platform), hashtags: L.limitHashtags(tags, platform),
      media: [{ key, role: 'ai_image' }], aiGenerated: true,
      town: '', state: '', packageLabel: '', shingle: '', sourceLeadId: null, status: 'draft', captionFilter: { dropped: 0 },
      companyId: ctx.companyId, createdBy: ctx.uid, groupId: null, scheduledAt: Timestamp.fromMillis(schedMs), source: 'ai_image',
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    created.push({ id: ref.id, platform });
  }
  return { created, kind };
}

exports.reelAiImagePost = onCall(Object.assign({}, callOpts, { timeoutSeconds: 60 }), async (request) => {
  const ctx = sm().requireSocialManager(request, (t) => t.role === 'admin');
  const d = request.data || {};
  return aiImagePostsFor(getFirestore(), getStorage().bucket(), ctx, d.mediaId, d);
});

// ── Triggers ────────────────────────────────────────────────────────────
function liveDeps() {
  const db = getFirestore();
  const ff = require('./reel-ffmpeg');
  const killswitch = require('./integrations/killswitch');
  const { hasSecret } = require('./integrations/_shared');
  const { secretValue } = require('./integrations/_shared');
  const apiKey = secretValue(ANTHROPIC_API_KEY);
  const stub = isEmulator() && !ff.ffmpegPath();
  return {
    db, bucket: getStorage().bucket(), ff, logger, stub,
    reelsGate: (companyId) => reelsBlocked(db, companyId, killswitch.getFlags),
    reencode: (buf, f) => require('./photo-reencode').reencodePhoto(buf, f),
    heicToJpeg: async (buf) => Buffer.from(await require('heic-convert')({ buffer: buf, format: 'JPEG', quality: 0.9 })),
    visionGate: (uid, companyId) => visionBlocked(db, uid, companyId, { aiDisabled: killswitch.isAiDisabled, emulator: isEmulator(), apiKey, nowMs: Date.now() }),
    vision: (frames) => callVision(frames, { apiKey }),
    meter: (uid, usd) => meterVision(db, uid, usd, Date.now()),
    transcribeGate: async () => {
      if (await killswitch.isAiDisabled()) return 'ai_disabled';
      if (isEmulator()) return 'emulator';
      if (!hasSecret('GROQ_API_KEY')) return 'not_configured';
      return null;
    },
    transcribe: (buf) => require('./integrations/voice-intelligence').transcribeGroqBuffer({ buffer: buf, mimeType: 'audio/mp4', filename: 'speech.m4a', timeoutMs: 120000, words: true }),
  };
}

exports.reelRenderWorker = onDocumentWritten({
  document: 'companies/{companyId}/reels/{reelId}', region: 'us-central1',
  memory: '4GiB', cpu: 4, timeoutSeconds: 540, concurrency: 1, maxInstances: 3,
  secrets: [ANTHROPIC_API_KEY, require('./integrations/_shared').SECRETS.GROQ_API_KEY],
}, async (event) => {
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  if (!after || after.status !== 'queued') return;
  await processReel(event.params.companyId, event.params.reelId, liveDeps());
});

exports.reelIngestUpload = onObjectFinalized({ region: 'us-central1', memory: '4GiB', cpu: 4, timeoutSeconds: 540, concurrency: 1, maxInstances: 5 }, async (event) => {
  const o = event.data || {};
  if (!String(o.name || '').startsWith('reel-uploads/')) return;
  const deps = liveDeps();
  deps.bucket = getStorage().bucket(o.bucket);
  const r = await ingestUpload(o.name, o.contentType, o.size, deps);
  if (r && (r.error || r.refused)) logger.warn('reel ingest', Object.assign({ name: o.name }, r));
});

/** Daily: drop intermediates older than 14 days, abandoned slots, stray raw uploads. */
async function cleanup(db, bucket, nowMs) {
  const counts = { work: 0, slots: 0, raw: 0 };
  const snap = await db.collectionGroup('reel_media').where('createdAtMs', '<', nowMs - 86400000).limit(300).get();
  for (const d of snap.docs) {
    const m = d.data() || {};
    if (m.status === 'awaiting_upload' || m.status === 'processing' || m.status === 'failed') {
      await bucket.file(m.uploadPath || '').delete().catch(() => {});
      if (m.status !== 'failed') { await d.ref.update({ status: 'expired' }).catch(() => {}); counts.slots++; }
    } else if (m.status === 'ready' && (Number(m.createdAtMs) || 0) < nowMs - INTERMEDIATE_TTL_MS) {
      if (m.workPath) await bucket.file(m.workPath).delete().catch(() => {});
      await d.ref.update({ status: 'expired', workPath: null }).catch(() => {});
      counts.work++;
    }
  }
  try {
    const [files] = await bucket.getFiles({ prefix: 'reel-uploads/', maxResults: 500 });
    for (const f of files) {
      const t = Date.parse((f.metadata && f.metadata.timeCreated) || '') || 0;
      if (t && t < nowMs - 86400000) { await f.delete().catch(() => {}); counts.raw++; }
    }
  } catch (_) { /* listing is best effort */ }
  return counts;
}

exports.reelCleanup = onSchedule({ schedule: 'every day 04:15', timeZone: 'America/New_York', timeoutSeconds: 300, memory: '256MiB' }, async () => {
  const counts = await cleanup(getFirestore(), getStorage().bucket(), Date.now());
  logger.info('reelCleanup', counts);
});

exports._test = { reelsBlocked, FFMPEG_MISSING, processReel, ingestUpload, resolveClips, takeRenderSlot, callVision, visionBlocked, reelPostsFor, aiImagePostsFor, cleanup, isHeic, UPLOAD_RE, VISION_SYSTEM };
