/**
 * functions/social-publisher.js — the publish loop (Social Studio,
 * 2026-10-04). Pure orchestration: Firestore, the adapters, the clock and
 * the alert sink are all injected, so tests run it against a fake db with
 * the Graph API stubbed (no real API calls, ever).
 *
 * One run:
 *   1. Every companies/{c}/social_posts doc with status 'scheduled' (or a
 *      'publishing' claim) and scheduledAt <= now (collection-group query,
 *      index in firestore.indexes.json). The path is pinned to that exact
 *      shape (collection-group-paths.js) — a social_posts collection
 *      anywhere else is ignored.
 *   2. Company switch off (social_settings/config.enabled !== true) or the
 *      platform switched off → skipped, left scheduled. Nothing posts until
 *      Jo turns it on in Social Studio.
 *   3. Manual platform, or the adapter is not connected (secrets missing) →
 *      status 'ready' with the reason: the "Ready to post" queue, and ONE
 *      notification per company per run. Never a silent skip.
 *   4. Caption re-checked (privacy + Kentucky wording). Anything the filter
 *      would drop → failed + alert; the publisher never edits Jo's words.
 *   5. CLAIM before publish (same idea as storm-sms-guard.js): a
 *      transaction re-reads the doc and flips scheduled → publishing with a
 *      fresh claimId and attempts+1. A second run (or an overlapping one)
 *      finds 'publishing' and walks away — two runs = one post.
 *   6. Publish through the adapter. Success → posted + postUrl +
 *      platformPostId. A retryable failure → back to scheduled with
 *      nextAttemptAtMs = now + backoff (5 min doubling, cap 6 h) until
 *      MAX_ATTEMPTS, then failed + alert. An `unknown` outcome (network
 *      drop on the publish step) → failed + alert, never retried.
 *   7. A 'publishing' claim older than STALE_CLAIM_MS means a run died
 *      mid-publish → failed ('outcome_unknown') + alert to check the page.
 */
'use strict';

const L = require('./social-logic');
const { matchDocPath } = require('./collection-group-paths');

const POST_PATH = 'companies/{companyId}/social_posts/{postId}';
const BATCH = 50;

function randomId() {
  return require('crypto').randomBytes(12).toString('hex');
}

async function loadSettings(db, cache, companyId) {
  if (cache.has(companyId)) return cache.get(companyId);
  let s = {};
  try {
    const snap = await db.doc('companies/' + companyId + '/social_settings/config').get();
    s = (snap.exists && snap.data()) || {};
  } catch (_) { s = {}; }
  const out = { enabled: s.enabled === true, platforms: (s.platforms && typeof s.platforms === 'object') ? s.platforms : {} };
  cache.set(companyId, out);
  return out;
}

async function leadTerms(db, post) {
  if (!post.sourceLeadId) return [];
  try {
    const snap = await db.doc('leads/' + post.sourceLeadId).get();
    return snap.exists ? L.privateTerms(snap.data()) : [];
  } catch (_) { return []; }
}

/**
 * Reel Studio gates (2026-10-04), shared by socialApprovePost and the
 * publisher (approval AND publish time, like the caption filter):
 *   - a reel post needs its reel rendered and its privacy check clear,
 *     confirmed by Jo, or blurred (reel-logic canApproveReel);
 *   - an AI-made image (post.aiGenerated, or any media whose social_media
 *     index says aiGenerated) only on a tip / storm-season post — never a
 *     job showcase, never a reel (reel-logic checkAiImageRule).
 * → null when clear, else { code, message }.
 */
async function postBlockers(db, companyId, post) {
  const RL = require('./reel-logic');
  const p = post || {};
  const idx = {};
  for (const m of (p.media || []).slice(0, 12)) {
    if (!m || typeof m.key !== 'string' || !/^[a-f0-9]{32}$/.test(m.key)) continue;
    try { const s = await db.doc('social_media/' + m.key).get(); if (s.exists) idx[m.key] = s.data() || {}; } catch (_) { /* treated as absent */ }
  }
  const ai = RL.checkAiImageRule(p, idx);
  if (!ai.ok) return { code: 'ai_image_rule', message: ai.reason };
  const isReel = p.format === 'reel' || !!p.reelId || (p.media || []).some((m) => m && idx[m.key] && idx[m.key].kind === 'reel');
  if (isReel) {
    if (typeof p.reelId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(p.reelId)) return { code: 'reel_missing', message: 'This video post is not linked to a reel.' };
    let reel = null;
    try { const s = await db.doc('companies/' + companyId + '/reels/' + p.reelId).get(); reel = s.exists ? s.data() : null; } catch (_) { reel = null; }
    if (!reel) return { code: 'reel_missing', message: 'The reel for this post was not found.' };
    const g = RL.canApproveReel(reel);
    if (!g.ok) return { code: 'reel_privacy', message: g.reason };
    if (!(p.media || []).some((m) => m && m.key === reel.output.key)) return { code: 'reel_stale', message: 'The reel was re-rendered (blurred). Send the new version to Social Studio.' };
  }
  return null;
}

/**
 * Transactionally move a post from one of `fromStatuses` to `patch`, only
 * if `guard(data)` holds. → the fresh data on success, null if the doc
 * moved on (someone else claimed it, Jo edited it, …).
 */
async function transition(db, ref, fromStatuses, patchFn) {
  let out = null;
  await db.runTransaction(async (tx) => {
    out = null;
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const d = snap.data() || {};
    if (!fromStatuses.includes(d.status)) return;
    const patch = patchFn(d);
    if (!patch) return;
    tx.update(ref, patch);
    out = Object.assign({}, d, patch);
  });
  return out;
}

/**
 * deps: { db, adapters, nowMs, ts(ms) → Timestamp, alert(evt), notify(evt),
 *         mediaUrl(key), logger, disabled }
 * → counts { scanned, posted, retried, failed, ready, paused, skipped }
 */
async function runPublisher(deps) {
  const { db, adapters, logger } = deps;
  const nowMs = deps.nowMs || Date.now();
  const ts = deps.ts || ((m) => m);
  const counts = { scanned: 0, posted: 0, retried: 0, failed: 0, ready: 0, paused: 0, skipped: 0 };
  if (deps.disabled) { if (logger) logger.info('socialPublisher: disabled by SOCIAL_PUBLISHER_DISABLED'); return counts; }
  const alert = deps.alert || (async () => {});
  const settingsCache = new Map();
  const readyByCompany = new Map();

  const snap = await db.collectionGroup('social_posts')
    .where('status', 'in', ['scheduled', 'publishing'])
    .where('scheduledAt', '<=', ts(nowMs))
    .limit(BATCH)
    .get();

  for (const doc of snap.docs) {
    counts.scanned++;
    const ids = matchDocPath(POST_PATH, doc.ref.path);
    if (!ids) { counts.skipped++; continue; }
    const companyId = ids.companyId;
    const post = doc.data() || {};
    const pub = post.publish || {};

    // 7. A run died mid-publish: outcome unknown → fail, tell Jo, never retry.
    if (post.status === 'publishing') {
      if (nowMs - (Number(pub.claimedAtMs) || 0) < L.STALE_CLAIM_MS) { counts.skipped++; continue; }
      const moved = await transition(db, doc.ref, ['publishing'], (d) => ((d.publish || {}).claimId === pub.claimId ? {
        status: 'failed', failReason: 'outcome_unknown',
        publish: Object.assign({}, d.publish, { lastError: 'The publish run stopped before it could confirm. Check the page before re-approving.' }),
        updatedAt: ts(nowMs),
      } : null));
      if (moved) {
        counts.failed++;
        await alert({ companyId, postId: ids.postId, post: moved, reason: 'outcome_unknown', message: moved.publish.lastError });
      }
      continue;
    }

    // 2. Switches.
    const settings = await loadSettings(db, settingsCache, companyId);
    if (!settings.enabled || settings.platforms[post.platform] === false) { counts.paused++; continue; }
    if ((Number(pub.nextAttemptAtMs) || 0) > nowMs) { counts.skipped++; continue; }

    // 3. Manual / not connected → Ready to post.
    const adapter = adapters[post.platform];
    let conn = adapter ? adapter.connected() : { ok: false, reason: 'unknown platform ' + post.platform };
    // A reel goes by hand where the adapter cannot post video (GBP, manual).
    if (conn.ok && post.format === 'reel' && !(adapter && adapter.video)) conn = { ok: false, reason: 'manual: ' + ((L.PLATFORMS[post.platform] || {}).label || post.platform) + ' takes the video by hand — Download MP4 from Ready to post' };
    if (!adapter || !adapter.auto || !conn.ok) {
      const moved = await transition(db, doc.ref, ['scheduled'], () => ({
        status: 'ready', readyReason: String(conn.reason || 'manual'), readyAt: ts(nowMs), updatedAt: ts(nowMs),
      }));
      if (moved) {
        counts.ready++;
        const list = readyByCompany.get(companyId) || [];
        list.push({ postId: ids.postId, platform: post.platform, reason: conn.reason });
        readyByCompany.set(companyId, list);
      }
      continue;
    }

    // 4. Caption re-check (privacy + KY). Never edit — refuse.
    const terms = await leadTerms(db, post);
    const check = L.cleanCaption(post.caption, { privateTerms: terms });
    const tagCheck = L.cleanHashtags(post.hashtags || [], { privateTerms: terms });
    if (check.dropped.length || tagCheck.length !== (post.hashtags || []).length) {
      const why = check.dropped.length ? check.dropped[0].rule + ': "' + check.dropped[0].sentence.slice(0, 120) + '"' : 'a hashtag names something private';
      const moved = await transition(db, doc.ref, ['scheduled'], (d) => ({
        status: 'failed', failReason: 'caption_blocked',
        publish: Object.assign({}, d.publish, { lastError: 'Blocked by the caption rules — ' + why }),
        updatedAt: ts(nowMs),
      }));
      if (moved) { counts.failed++; await alert({ companyId, postId: ids.postId, post: moved, reason: 'caption_blocked', message: moved.publish.lastError }); }
      continue;
    }

    // 4b. Reel privacy gate + AI-image rule (Reel Studio). Never publish past them.
    const block = await postBlockers(db, companyId, post);
    if (block) {
      const moved = await transition(db, doc.ref, ['scheduled'], (d) => ({
        status: 'failed', failReason: block.code,
        publish: Object.assign({}, d.publish, { lastError: 'Blocked — ' + block.message }),
        updatedAt: ts(nowMs),
      }));
      if (moved) { counts.failed++; await alert({ companyId, postId: ids.postId, post: moved, reason: block.code, message: moved.publish.lastError }); }
      continue;
    }

    // 5. Claim.
    const claimId = randomId();
    const claimed = await transition(db, doc.ref, ['scheduled'], (d) => {
      const p = d.publish || {};
      if ((Number(p.nextAttemptAtMs) || 0) > nowMs) return null;
      return {
        status: 'publishing',
        publish: Object.assign({}, p, { claimId, claimedAtMs: nowMs, attempts: (Number(p.attempts) || 0) + 1 }),
        updatedAt: ts(nowMs),
      };
    });
    if (!claimed) { counts.skipped++; continue; }
    const attempts = claimed.publish.attempts;

    // 6. Publish.
    const mediaUrls = (claimed.media || []).map((m) => deps.mediaUrl(m.key)).filter(Boolean);
    const v = claimed.format === 'reel' && claimed.video ? claimed.video : null;
    const video = v ? { url: deps.mediaUrl(v.key), coverUrl: v.thumbKey ? deps.mediaUrl(v.thumbKey) : '', thumbOffsetMs: Number(v.thumbOffsetMs) || 0 } : null;
    let result = null;
    try {
      result = await adapter.publish({ post: claimed, message: L.composeMessage(claimed), mediaUrls, video, resume: (claimed.publish && claimed.publish.resume) || null });
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 500);
      if (e && e.retryable && !e.unknown && attempts < L.MAX_ATTEMPTS) {
        // e.resume (Instagram Reels: the container still processing) carries
        // over to the next attempt so it polls the SAME container, never a new one.
        await doc.ref.update({
          status: 'scheduled',
          publish: Object.assign({}, claimed.publish, { lastError: msg, nextAttemptAtMs: nowMs + L.backoffMs(attempts), resume: e.resume || null }),
          updatedAt: ts(nowMs),
        });
        counts.retried++;
      } else {
        const reason = (e && e.unknown) ? 'outcome_unknown' : (e && e.retryable) ? 'retries_exhausted' : 'error';
        const failed = Object.assign({}, claimed, { status: 'failed' });
        await doc.ref.update({
          status: 'failed', failReason: reason,
          publish: Object.assign({}, claimed.publish, { lastError: msg }), updatedAt: ts(nowMs),
        });
        counts.failed++;
        await alert({ companyId, postId: ids.postId, post: failed, reason, message: msg });
      }
      continue;
    }
    // Stamp OUTSIDE the publish try: if this write fails the post IS live,
    // and the doc stays 'publishing' → the stale-claim path fails it as
    // outcome_unknown (alert, no retry) instead of re-posting.
    try {
      await doc.ref.update({
        status: 'posted', postUrl: result.url || '', platformPostId: result.platformPostId || '', postedAt: ts(nowMs),
        publish: Object.assign({}, claimed.publish, { lastError: null, postedAtMs: nowMs, resume: null }), updatedAt: ts(nowMs),
      });
    } catch (e) {
      if (logger) logger.error('socialPublisher: posted but could not stamp', { postId: ids.postId, url: result.url, err: e && e.message });
    }
    counts.posted++;
  }

  for (const [companyId, items] of readyByCompany) {
    if (deps.notify) await deps.notify({ companyId, items });
  }
  if (logger) logger.info('socialPublisher run', counts);
  return counts;
}

module.exports = { runPublisher, POST_PATH, loadSettings, postBlockers };
