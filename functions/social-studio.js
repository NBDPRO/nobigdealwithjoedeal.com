/**
 * functions/social-studio.js — Social Studio's server side (2026-10-04).
 *
 *   socialEligibleJobs  (callable) finished jobs (install complete or later,
 *                       stage-roles isWon) that have photos — the picker.
 *   socialDraftFromJob  (callable) one job → drafts (one per platform):
 *                       before/after or carousel, re-encoded photos, town
 *                       only, package/shingle, template caption + hashtags,
 *                       all through the privacy + Kentucky filter.
 *   socialPlanWeeks     (callable) "Plan N weeks": proposes a mix (job
 *                       showcases, tips, storm-season PSAs, reviews, behind
 *                       the scenes) across platforms as DRAFTS. Jo approves
 *                       each one.
 *   socialApprovePost   (callable) the ONLY way a post becomes approved /
 *                       scheduled: re-cleans caption + hashtags with the
 *                       source lead's private terms, then flips status.
 *                       firestore.rules forbid a client from setting
 *                       approved/scheduled on a draft, and any content edit
 *                       sends a post back to draft.
 *   socialPublisher     (cron, every 5 min) social-publisher.js runPublisher.
 *   socialMedia         (GET /api/social-media?k=<32 hex>) serves a
 *                       re-encoded social copy. This is the URL Meta fetches
 *                       and the CRM displays. It can only ever serve files
 *                       written by prepareMedia() below (sharp re-encode via
 *                       photo-reencode.js — EXIF/GPS gone), looked up by an
 *                       unguessable key in social_media/{key}. Raw photos and
 *                       Storage ?token= URLs are never used.
 *
 * Owner / company_admin only (and platform admin). Tenant key = the
 * companyId claim, or the uid for a solo owner.
 */
'use strict';

const crypto = require('crypto');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { CORS_ORIGINS } = require('./handlers/_shared');
const L = require('./social-logic');
const SR = require('./stage-roles');
const { makeAdapters } = require('./social-adapters');
const { runPublisher, postBlockers: approvalBlockers } = require('./social-publisher');

const META_PAGE_ACCESS_TOKEN = defineSecret('META_PAGE_ACCESS_TOKEN');
const META_PAGE_ID = defineSecret('META_PAGE_ID');
const IG_BUSINESS_ACCOUNT_ID = defineSecret('IG_BUSINESS_ACCOUNT_ID');
const GBP_CLIENT_ID = defineSecret('GBP_CLIENT_ID');
const GBP_CLIENT_SECRET = defineSecret('GBP_CLIENT_SECRET');
const GBP_REFRESH_TOKEN = defineSecret('GBP_REFRESH_TOKEN');
const GBP_ACCOUNT_ID = defineSecret('GBP_ACCOUNT_ID');
const GBP_LOCATION_ID = defineSecret('GBP_LOCATION_ID');

// Public media base. Same-origin with the CRM (so the page's CSP allows it)
// and a public HTTPS URL Meta can fetch. firebase.json rewrites it here.
const MEDIA_BASE = process.env.SOCIAL_MEDIA_BASE || 'https://nobigdealwithjoedeal.com/api/social-media';
const MEDIA_KEY_RE = /^[a-f0-9]{32}$/;
const PHOTO_PATH_RE = /^(photos|homeowner-uploads)\//;

function mediaUrl(key) { return MEDIA_KEY_RE.test(String(key || '')) ? MEDIA_BASE + '?k=' + key : ''; }

/** Owner/admin gate → { uid, companyId }. */
function requireSocialManager(request, isPlatformAdmin) {
  const a = request.auth;
  if (!a || !a.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const t = a.token || {};
  const companyId = String(t.companyId || a.uid);
  const role = String(t.role || '');
  if ((isPlatformAdmin || ((x) => x.role === 'admin'))(t)) return { uid: a.uid, companyId };
  if (role === 'viewer') throw new HttpsError('permission-denied', 'Social Studio is for the owner or a company admin.');
  if (companyId === a.uid) return { uid: a.uid, companyId };
  if (role === 'company_admin') return { uid: a.uid, companyId };
  throw new HttpsError('permission-denied', 'Social Studio is for the owner or a company admin.');
}

function leadInCompany(lead, companyId, uid) {
  if (!lead) return false;
  if (lead.companyId) return String(lead.companyId) === companyId;
  return lead.userId === uid || lead.userId === companyId;
}

async function loadLead(db, leadId, ctx) {
  if (typeof leadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(leadId)) throw new HttpsError('invalid-argument', 'Pick a job.');
  const snap = await db.doc('leads/' + leadId).get();
  const lead = snap.exists ? snap.data() : null;
  if (!lead || lead.deleted || !leadInCompany(lead, ctx.companyId, ctx.uid)) throw new HttpsError('not-found', 'That job was not found.');
  return lead;
}

async function leadPhotos(db, leadId, lead, ctx) {
  const q = await db.collection('photos').where('leadId', '==', leadId).limit(200).get();
  const out = [];
  q.forEach((d) => {
    const p = d.data() || {};
    const sameTenant = p.companyId ? String(p.companyId) === ctx.companyId : (p.userId === ctx.uid || p.userId === lead.userId);
    const path = p.storagePath || p.path;
    if (sameTenant && typeof path === 'string' && PHOTO_PATH_RE.test(path)) out.push(Object.assign({ id: d.id }, p));
  });
  return out;
}

/**
 * Re-encode each chosen photo (sharp: EXIF/GPS stripped, orientation baked,
 * long edge capped) and store the copy under social-media/{companyId}/.
 * → [{ key, role }]
 */
async function prepareMedia(db, companyId, chosen, deps) {
  const bucket = (deps && deps.bucket) || getStorage().bucket();
  const reencode = (deps && deps.reencode) || require('./photo-reencode').reencodePhoto;
  const out = [];
  for (const c of chosen) {
    if (!PHOTO_PATH_RE.test(String(c.storagePath || ''))) continue;
    let buf;
    try { [buf] = await bucket.file(c.storagePath).download(); } catch (e) {
      logger.warn('social: photo download failed', { path: c.storagePath, err: e && e.message });
      continue;
    }
    let jpeg;
    try { jpeg = await reencode(buf, 'jpeg'); } catch (e) {
      logger.warn('social: re-encode refused', { path: c.storagePath, err: e && e.message });
      continue;
    }
    const key = crypto.randomBytes(16).toString('hex');
    const path = 'social-media/' + companyId + '/' + key + '.jpg';
    await bucket.file(path).save(jpeg, { contentType: 'image/jpeg', resumable: false, metadata: { cacheControl: 'public, max-age=86400' } });
    await db.doc('social_media/' + key).set({ companyId, path, bytes: jpeg.length, createdAt: FieldValue.serverTimestamp() });
    out.push({ key, role: c.role || 'photo' });
  }
  return out;
}

function cleanPlatforms(list, fallback) {
  const ps = (Array.isArray(list) ? list : []).filter((p) => L.PLATFORMS[p]);
  return ps.length ? Array.from(new Set(ps)) : (fallback || ['facebook', 'instagram']);
}

function postsCol(db, companyId) { return db.collection('companies').doc(companyId).collection('social_posts'); }

async function writeJobDrafts(db, ctx, leadId, lead, platforms, opts) {
  const photos = await leadPhotos(db, leadId, lead, ctx);
  const sel = L.choosePhotos(photos, (opts && opts.maxPhotos) || 10);
  const media = sel.photos.length ? await prepareMedia(db, ctx.companyId, sel.photos, opts && opts.deps) : [];
  const format = media.length === 0 ? 'text' : media.length === 1 ? 'single' : sel.format;
  const groupId = crypto.randomBytes(8).toString('hex');
  const created = [];
  const seed = Math.floor(Math.random() * 1000);
  for (const platform of platforms) {
    if (L.PLATFORMS[platform].needsMedia && !media.length) continue;
    const body = L.buildJobDraft({ lead, platform, media, format, leadId, seed });
    const ref = postsCol(db, ctx.companyId).doc();
    const doc = Object.assign(body, {
      companyId: ctx.companyId, createdBy: ctx.uid, groupId,
      scheduledAt: opts && opts.scheduledAtMs ? Timestamp.fromMillis(opts.scheduledAtMs) : null,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      source: (opts && opts.source) || 'job',
    });
    await ref.set(doc);
    created.push({ id: ref.id, platform });
  }
  return { created, format, mediaCount: media.length, facts: L.jobFacts(lead) };
}

async function existingShowcaseLeads(db, companyId) {
  const snap = await postsCol(db, companyId).where('kind', '==', 'job_showcase').limit(1000).get();
  const s = new Set();
  snap.forEach((d) => { const v = d.data() || {}; if (v.sourceLeadId && v.status !== 'cancelled') s.add(v.sourceLeadId); });
  return s;
}

async function eligibleJobs(db, ctx, limit) {
  const seen = new Map();
  const add = (snap) => snap.forEach((d) => { if (!seen.has(d.id)) seen.set(d.id, d.data() || {}); });
  add(await db.collection('leads').where('companyId', '==', ctx.companyId).limit(1000).get());
  if (ctx.companyId === ctx.uid) add(await db.collection('leads').where('userId', '==', ctx.uid).limit(1000).get());
  const won = [];
  for (const [id, lead] of seen) {
    if (lead.deleted || !leadInCompany(lead, ctx.companyId, ctx.uid) || !SR.isWon(lead)) continue;
    won.push({ id, lead, at: L.ms(lead.installCompletedAt) || L.ms(lead.completedAt) || L.ms(lead.stageStartedAt) || L.ms(lead.updatedAt) });
  }
  won.sort((a, b) => b.at - a.at);
  const posted = await existingShowcaseLeads(db, ctx.companyId);
  const out = [];
  for (const w of won.slice(0, limit || 40)) {
    const photos = await leadPhotos(db, w.id, w.lead, ctx);
    if (!photos.length) continue;
    const sel = L.choosePhotos(photos, 10);
    const facts = L.jobFacts(w.lead);
    const name = String(w.lead.name || [w.lead.firstName, w.lead.lastName].filter(Boolean).join(' ') || 'Job').slice(0, 60);
    out.push({
      leadId: w.id,
      // CRM-only label so Jo recognises the job. Never stored on a post.
      label: name, town: facts.town, state: facts.state, packageLabel: facts.packageLabel,
      stage: String(w.lead.stage || ''), photoCount: photos.length, format: sel.format,
      alreadyPosted: posted.has(w.id), completedAtMs: w.at || null,
    });
  }
  return out;
}

const callOpts = { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true };

exports.socialEligibleJobs = onCall(Object.assign({}, callOpts, { timeoutSeconds: 60 }), async (request) => {
  const ctx = requireSocialManager(request, (t) => t.role === 'admin');
  return { jobs: await eligibleJobs(getFirestore(), ctx, 40) };
});

exports.socialDraftFromJob = onCall(Object.assign({}, callOpts, { timeoutSeconds: 180, memory: '1GiB' }), async (request) => {
  const ctx = requireSocialManager(request, (t) => t.role === 'admin');
  const data = request.data || {};
  const db = getFirestore();
  const lead = await loadLead(db, data.leadId, ctx);
  if (!SR.isWon(lead)) throw new HttpsError('failed-precondition', 'Drafts come from finished jobs (install complete or later).');
  const res = await writeJobDrafts(db, ctx, data.leadId, lead, cleanPlatforms(data.platforms), { source: 'job' });
  if (!res.created.length) throw new HttpsError('failed-precondition', 'This job has no usable photos for those platforms.');
  return res;
});

exports.socialPlanWeeks = onCall(Object.assign({}, callOpts, { timeoutSeconds: 300, memory: '1GiB' }), async (request) => {
  const ctx = requireSocialManager(request, (t) => t.role === 'admin');
  const data = request.data || {};
  const db = getFirestore();
  const weeks = Math.min(8, Math.max(1, Math.floor(Number(data.weeks) || 2)));
  const platforms = cleanPlatforms(data.platforms);
  const startMs = Number(data.startMs) > Date.now() - 86400000 ? Number(data.startMs) : Date.now();
  const jobs = (await eligibleJobs(db, ctx, 40)).filter((j) => !j.alreadyPosted).slice(0, weeks);
  let reviews = [];
  try {
    const r = await db.doc('siteContent/googleReviews').get();
    const list = (r.exists && r.data().data && r.data().data.reviews) || [];
    reviews = list.filter((x) => x && Number(x.rating) >= 5 && typeof x.text === 'string' && x.text.length >= 40 && x.text.length <= 400)
      .map((x) => ({ text: x.text }));
  } catch (_) { reviews = []; }
  const proposals = L.planWeeks({ weeks, platforms, startMs, jobs: jobs.map((j) => ({ leadId: j.leadId, facts: j, format: j.format })), reviews, seed: Math.floor(Math.random() * 1000) });
  const created = [];
  const doneLeads = new Set();
  for (const p of proposals) {
    if (p.kind === 'job_showcase' && p.leadId) {
      if (doneLeads.has(p.leadId)) continue; // one group per job, all platforms
      doneLeads.add(p.leadId);
      const lead = await loadLead(db, p.leadId, ctx).catch(() => null);
      if (!lead) continue;
      const res = await writeJobDrafts(db, ctx, p.leadId, lead, platforms, { maxPhotos: 4, scheduledAtMs: p.scheduledAtMs, source: 'plan' });
      res.created.forEach((c) => created.push(Object.assign({ kind: 'job_showcase' }, c)));
      continue;
    }
    const ref = postsCol(db, ctx.companyId).doc();
    await ref.set({
      kind: p.kind, platform: p.platform, format: 'text', caption: p.caption, hashtags: p.hashtags, media: [],
      town: '', state: '', packageLabel: '', shingle: '', sourceLeadId: null, status: 'draft',
      captionFilter: { dropped: 0 }, companyId: ctx.companyId, createdBy: ctx.uid, groupId: null,
      scheduledAt: Timestamp.fromMillis(p.scheduledAtMs), source: 'plan',
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    created.push({ id: ref.id, platform: p.platform, kind: p.kind });
  }
  return { created, weeks };
});

exports.socialApprovePost = onCall(Object.assign({}, callOpts, { timeoutSeconds: 30 }), async (request) => {
  const ctx = requireSocialManager(request, (t) => t.role === 'admin');
  const data = request.data || {};
  if (typeof data.postId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(data.postId)) throw new HttpsError('invalid-argument', 'Missing post.');
  const db = getFirestore();
  const ref = postsCol(db, ctx.companyId).doc(data.postId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Post not found.');
  const post = snap.data() || {};
  if (!L.canApprove(post.status)) throw new HttpsError('failed-precondition', 'Only a draft (or a failed post) can be approved.');
  let terms = [];
  if (post.sourceLeadId) {
    const ls = await db.doc('leads/' + post.sourceLeadId).get();
    if (ls.exists) terms = L.privateTerms(ls.data());
  }
  const cleaned = L.cleanCaption(post.caption, { privateTerms: terms });
  const caption = L.limitCaption(cleaned.text, post.platform);
  if (!caption) throw new HttpsError('failed-precondition', 'Nothing is left of this caption after the privacy and Kentucky wording rules. Rewrite it and try again.');
  const hashtags = L.limitHashtags(L.cleanHashtags(post.hashtags || [], { privateTerms: terms }), post.platform);
  if (L.PLATFORMS[post.platform] && L.PLATFORMS[post.platform].needsMedia && !(post.media || []).length) {
    throw new HttpsError('failed-precondition', L.PLATFORMS[post.platform].label + ' posts need a photo.');
  }
  // Reel Studio: a reel's privacy gate + the AI-image rule (also re-checked at publish).
  const block = await approvalBlockers(db, ctx.companyId, post);
  if (block) throw new HttpsError('failed-precondition', block.message);
  const schedMs = Number(data.scheduledAtMs) || L.ms(post.scheduledAt) || 0;
  const status = schedMs ? 'scheduled' : 'approved';
  await ref.update({
    caption, hashtags, status,
    scheduledAt: schedMs ? Timestamp.fromMillis(schedMs) : null,
    approvedAt: FieldValue.serverTimestamp(), approvedBy: ctx.uid,
    captionFilter: { dropped: cleaned.dropped.length, rules: cleaned.dropped.map((d) => d.rule).slice(0, 10) },
    publish: { attempts: 0, nextAttemptAtMs: 0, lastError: null, claimId: null, claimedAtMs: 0 },
    failReason: null, readyReason: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { status, caption, hashtags, dropped: cleaned.dropped };
});

// ── Alerts ──────────────────────────────────────────────────────────────
async function ownerOf(db, companyId) {
  try {
    const c = await db.doc('companies/' + companyId).get();
    return (c.exists && c.data().ownerId) || companyId;
  } catch (_) { return companyId; }
}

async function notifyOwner(db, companyId, title, message, id) {
  const uid = await ownerOf(db, companyId);
  await db.collection('notifications').add({
    userId: uid, type: 'social_publisher', title, message, priority: 'high',
    clickUrl: '/pro/social.html', read: false, dismissed: false, createdAt: FieldValue.serverTimestamp(),
  }).catch((e) => logger.error('social: notification write failed', { err: e && e.message }));
  try {
    await require('./push-functions').sendCustomNotification(uid, title, message, { type: 'social_publisher', clickUrl: '/pro/social.html', notificationId: id });
  } catch (_) { /* push is best effort; the bell row is the record */ }
}

exports.socialPublisher = onSchedule({
  schedule: 'every 5 minutes', timeZone: 'America/New_York', timeoutSeconds: 300, memory: '512MiB',
  secrets: [META_PAGE_ACCESS_TOKEN, META_PAGE_ID, IG_BUSINESS_ACCOUNT_ID, GBP_CLIENT_ID, GBP_CLIENT_SECRET, GBP_REFRESH_TOKEN, GBP_ACCOUNT_ID, GBP_LOCATION_ID],
}, async () => {
  const db = getFirestore();
  const v = (s) => { try { return s.value(); } catch (_) { return ''; } };
  const env = {
    META_PAGE_ACCESS_TOKEN: v(META_PAGE_ACCESS_TOKEN), META_PAGE_ID: v(META_PAGE_ID), IG_BUSINESS_ACCOUNT_ID: v(IG_BUSINESS_ACCOUNT_ID),
    GBP_CLIENT_ID: v(GBP_CLIENT_ID), GBP_CLIENT_SECRET: v(GBP_CLIENT_SECRET), GBP_REFRESH_TOKEN: v(GBP_REFRESH_TOKEN),
    GBP_ACCOUNT_ID: v(GBP_ACCOUNT_ID), GBP_LOCATION_ID: v(GBP_LOCATION_ID),
    SOCIAL_GBP_ENABLED: process.env.SOCIAL_GBP_ENABLED,
  };
  const adapters = makeAdapters(env, fetch, {
    getGbpAccessToken: () => require('./gbp-reviews-sync').fetchAccessToken(env.GBP_CLIENT_ID, env.GBP_CLIENT_SECRET, env.GBP_REFRESH_TOKEN),
  });
  await runPublisher({
    db, adapters, logger, nowMs: Date.now(), ts: (m) => Timestamp.fromMillis(m), mediaUrl,
    disabled: process.env.SOCIAL_PUBLISHER_DISABLED === 'true',
    alert: async (evt) => {
      logger.error('social_publish_failed', { companyId: evt.companyId, postId: evt.postId, platform: evt.post && evt.post.platform, reason: evt.reason, message: evt.message });
      const label = (L.PLATFORMS[evt.post && evt.post.platform] || {}).label || 'Social';
      await notifyOwner(db, evt.companyId, label + ' post failed', String(evt.message || evt.reason).slice(0, 240), 'social-fail-' + evt.postId);
    },
    notify: async (evt) => {
      const n = evt.items.length;
      await notifyOwner(db, evt.companyId, n + (n === 1 ? ' post is' : ' posts are') + ' ready to post by hand',
        'Open Social Studio → Ready to post: copy the caption, share the photos, then Mark posted.', 'social-ready-' + Date.now());
    },
  });
});

// Only files written by prepareMedia() / Reel Studio's storeMedia(): a
// re-encoded JPEG, or a rendered reel MP4 (ffmpeg, all metadata stripped).
const MEDIA_PATH_RE = /^social-media\/[A-Za-z0-9_-]+\/[a-f0-9]{32}\.(jpg|mp4)$/;

/**
 * "bytes=a-b" → { start, end } within size, or null (serve the whole file).
 * 'invalid' when the range cannot be satisfied (→ 416). Safari / iPhone
 * plays <video> only from a server that answers Range with 206.
 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!(start >= 0) || start > end || start >= size) return 'invalid';
  return { start, end };
}

exports.socialMedia = onRequest({ region: 'us-central1', maxInstances: 20, concurrency: 40, timeoutSeconds: 120, memory: '256MiB' }, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).send('Method not allowed'); return; }
  const key = String((req.query && req.query.k) || '');
  if (!MEDIA_KEY_RE.test(key)) { res.status(404).send('Not found'); return; }
  try {
    const db = getFirestore();
    const idx = await db.doc('social_media/' + key).get();
    const d = idx.exists ? idx.data() : null;
    if (!d || typeof d.path !== 'string' || !MEDIA_PATH_RE.test(d.path)) { res.status(404).send('Not found'); return; }
    const file = getStorage().bucket().file(d.path);
    res.set('Cache-Control', 'public, max-age=86400');
    if (d.path.endsWith('.mp4')) {
      // Video: stream, with Range support (206) — never buffer a whole reel.
      const [meta] = await file.getMetadata();
      const size = Number(meta.size) || 0;
      res.set('Content-Type', 'video/mp4');
      res.set('Accept-Ranges', 'bytes');
      const r = parseRange(req.headers && req.headers.range, size);
      if (r === 'invalid') { res.set('Content-Range', 'bytes */' + size); res.status(416).end(); return; }
      const start = r ? r.start : 0;
      const end = r ? r.end : size - 1;
      res.set('Content-Length', String(end - start + 1));
      if (r) res.set('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
      res.status(r ? 206 : 200);
      if (req.method === 'HEAD' || size === 0) { res.end(); return; }
      file.createReadStream({ start, end }).on('error', () => { try { res.end(); } catch (_) {} }).pipe(res);
      return;
    }
    const [buf] = await file.download();
    res.set('Content-Type', 'image/jpeg');
    res.status(200).send(buf);
  } catch (e) {
    logger.warn('socialMedia: serve failed', { err: e && e.message });
    res.status(404).send('Not found');
  }
});

exports._test = { requireSocialManager, leadInCompany, leadPhotos, prepareMedia, mediaUrl, cleanPlatforms, approvalBlockers, parseRange, MEDIA_PATH_RE };
