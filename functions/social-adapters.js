/**
 * functions/social-adapters.js — the per-platform publishing adapters behind
 * ONE interface (Social Studio, 2026-10-04).
 *
 * Every adapter is an object:
 *   id          'facebook' | 'instagram' | 'gbp' | 'tiktok' | …
 *   auto        true when an API can post it; false = manual queue only
 *   connected() → { ok: true } | { ok: false, reason }   (never throws)
 *   publish({ post, message, mediaUrls }) → { platformPostId, url }
 *               throws SocialPublishError on failure.
 *
 * SocialPublishError carries:
 *   retryable  the platform answered with a transient error (rate limit,
 *              5xx, Graph is_transient) BEFORE anything public was created —
 *              safe to try again later.
 *   unknown    the request that makes the post public may or may not have
 *              landed (network drop / timeout on the publish step). NEVER
 *              retried automatically: the item fails and Jo checks the page.
 *   neither    a definite refusal (bad token, missing permission, bad
 *              media) — fails now, Jo is alerted.
 *
 * Nothing here reads secrets or Firestore: credentials and fetch are passed
 * in (makeAdapters), so tests stub the Graph API entirely.
 *
 * Meta Graph API references (checked 2026-10-04, docs example version v25.0):
 *   FB Page photo:  POST /{page-id}/photos  url, caption|message, published
 *   FB multi-photo: POST /{page-id}/photos  url, published=false → media_fbid
 *                   POST /{page-id}/feed    message, attached_media[n]={"media_fbid":…}
 *   IG single:      POST /{ig-user-id}/media  image_url, caption → container id
 *                   POST /{ig-user-id}/media_publish  creation_id
 *   IG carousel:    POST /{ig-user-id}/media  image_url, is_carousel_item=true (×≤10)
 *                   POST /{ig-user-id}/media  media_type=CAROUSEL, children=a,b,c, caption
 *                   POST /{ig-user-id}/media_publish  creation_id
 *   IG images must be JPEG on a public URL (we serve the re-encoded copy at
 *   /api/social-media?k=…). 100 API posts / 24 h per IG account.
 *
 * Video (Reel Studio, checked 2026-10-04):
 *   FB Page video:  POST /{page-id}/videos  file_url, description, published
 *                   (permissions: pages_manage_posts, pages_read_engagement,
 *                   pages_show_list — the same token as photos)
 *   IG Reels:       POST /{ig-user-id}/media  media_type=REELS, video_url,
 *                   caption, share_to_feed, cover_url | thumb_offset
 *                   GET  /{container-id}?fields=status_code  (IN_PROGRESS →
 *                   FINISHED | ERROR | EXPIRED | PUBLISHED; "once per minute,
 *                   for no more than 5 minutes")
 *                   POST /{ig-user-id}/media_publish  creation_id
 *                   Spec: MP4, H.264, AAC ≤48 kHz, 23–60 fps, ≤1920 px wide,
 *                   3 s–15 min, ≤300 MB; 9:16 recommended. instagram_content_publish.
 *   Adapters with `video: true` take { video: { url, coverUrl, thumbOffsetMs } };
 *   a reel on any other platform goes to the manual queue.
 */
'use strict';

const GRAPH_VERSION = 'v25.0';
const GRAPH_BASE = 'https://graph.facebook.com/' + GRAPH_VERSION;
const SECRET_STUB = '__unset__';

class SocialPublishError extends Error {
  constructor(message, opts) {
    super(message);
    this.name = 'SocialPublishError';
    const o = opts || {};
    this.code = o.code || 'error';
    this.retryable = !!o.retryable;
    this.unknown = !!o.unknown;
  }
}

function configured(v) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim() !== SECRET_STUB;
}

// Graph error codes that mean "try again later" (rate limits / transient).
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80001, 80004]);

/**
 * One Graph call. `commit` marks the request that makes something PUBLIC —
 * a network failure there is `unknown`, elsewhere `retryable`.
 */
async function graph(fetchFn, method, path, params, token, commit) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    body.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  body.append('access_token', token);
  let res;
  try {
    const url = GRAPH_BASE + path + (method === 'GET' ? '?' + body.toString() : '');
    res = await fetchFn(url, method === 'GET'
      ? { method: 'GET' }
      : { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  } catch (e) {
    throw new SocialPublishError('Network error talking to Meta: ' + ((e && e.message) || e), commit
      ? { code: 'network', unknown: true }
      : { code: 'network', retryable: true });
  }
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok || (data && data.error)) {
    const err = (data && data.error) || {};
    const code = Number(err.code) || 0;
    const transient = res.status >= 500 || res.status === 429 || err.is_transient === true || TRANSIENT_CODES.has(code);
    const msg = 'Meta ' + (res.status || '') + ' ' + (err.message || 'error') + (code ? ' (code ' + code + ')' : '');
    // A 5xx on the publish step is still ambiguous — Meta may have posted.
    if (transient && commit && res.status >= 500) throw new SocialPublishError(msg, { code: 'meta_' + (code || res.status), unknown: true });
    throw new SocialPublishError(msg, { code: 'meta_' + (code || res.status), retryable: transient });
  }
  return data || {};
}

function facebookAdapter(env, fetchFn) {
  const pageId = env.META_PAGE_ID;
  const token = env.META_PAGE_ACCESS_TOKEN;
  return {
    id: 'facebook',
    auto: true,
    connected() {
      if (!configured(pageId) || !configured(token)) return { ok: false, reason: 'not_connected: META_PAGE_ID / META_PAGE_ACCESS_TOKEN not set' };
      return { ok: true };
    },
    video: true,
    async publish({ message, mediaUrls, video }) {
      const urls = mediaUrls || [];
      let postId;
      if (video && video.url) {
        // Page video (Reel Studio): one call, Meta fetches the MP4 from our
        // public media URL. This call makes it public → commit.
        const r = await graph(fetchFn, 'POST', '/' + pageId + '/videos', { file_url: video.url, description: message, published: true }, token, true);
        if (!r.id) throw new SocialPublishError('Meta returned no video id', { code: 'no_id', unknown: true });
        return { platformPostId: String(r.id), url: 'https://www.facebook.com/' + pageId + '/videos/' + String(r.id) };
      }
      if (urls.length === 1) {
        const r = await graph(fetchFn, 'POST', '/' + pageId + '/photos', { url: urls[0], caption: message, published: true }, token, true);
        postId = r.post_id || r.id;
      } else if (urls.length > 1) {
        const ids = [];
        for (const u of urls) {
          const r = await graph(fetchFn, 'POST', '/' + pageId + '/photos', { url: u, published: false }, token, false);
          ids.push(r.id);
        }
        const params = { message };
        ids.forEach((id, i) => { params['attached_media[' + i + ']'] = { media_fbid: id }; });
        const r = await graph(fetchFn, 'POST', '/' + pageId + '/feed', params, token, true);
        postId = r.id;
      } else {
        const r = await graph(fetchFn, 'POST', '/' + pageId + '/feed', { message }, token, true);
        postId = r.id;
      }
      if (!postId) throw new SocialPublishError('Meta returned no post id', { code: 'no_id', unknown: true });
      return { platformPostId: String(postId), url: 'https://www.facebook.com/' + String(postId) };
    },
  };
}

function instagramAdapter(env, fetchFn, opts) {
  const igId = env.IG_BUSINESS_ACCOUNT_ID;
  const token = env.META_PAGE_ACCESS_TOKEN;
  const sleep = (opts && opts.sleep) || ((ms) => new Promise((r) => setTimeout(r, ms)));
  async function waitReady(containerId) {
    for (let i = 0; i < 5; i++) {
      const r = await graph(fetchFn, 'GET', '/' + containerId, { fields: 'status_code' }, token, false);
      const s = String(r.status_code || 'FINISHED');
      if (s === 'FINISHED') return;
      if (s === 'ERROR' || s === 'EXPIRED') throw new SocialPublishError('Instagram could not process the image (' + s + ')', { code: 'ig_container_' + s.toLowerCase() });
      await sleep(2000);
    }
    throw new SocialPublishError('Instagram is still processing the image', { code: 'ig_container_pending', retryable: true });
  }
  /**
   * Reels: POST /media media_type=REELS video_url → container; poll its
   * status_code (video takes minutes — Meta: check about once a minute, up
   * to 5 min); FINISHED → media_publish. Still IN_PROGRESS after this run's
   * polls → retryable WITH resume { containerId }, and the next attempt polls
   * that same container instead of creating another (no duplicate uploads).
   * An EXPIRED / ERROR container fails definitively.
   */
  async function publishReel(message, video, resume) {
    let containerId = resume && typeof resume.containerId === 'string' && /^\d{3,40}$/.test(resume.containerId) ? resume.containerId : null;
    if (!containerId) {
      const params = { media_type: 'REELS', video_url: video.url, caption: message, share_to_feed: true };
      if (video.coverUrl) params.cover_url = video.coverUrl;
      else if (video.thumbOffsetMs > 0) params.thumb_offset = Math.round(video.thumbOffsetMs);
      const r = await graph(fetchFn, 'POST', '/' + igId + '/media', params, token, false);
      if (!r.id) throw new SocialPublishError('Instagram returned no container id', { code: 'no_id', retryable: true });
      containerId = String(r.id);
    }
    const polls = (opts && opts.reelPolls) || 4;
    let status = '';
    for (let i = 0; i < polls; i++) {
      const r = await graph(fetchFn, 'GET', '/' + containerId, { fields: 'status_code' }, token, false);
      status = String(r.status_code || '');
      if (status === 'FINISHED') break;
      if (status === 'ERROR' || status === 'EXPIRED') throw new SocialPublishError('Instagram could not process the reel (' + status + ')', { code: 'ig_container_' + status.toLowerCase() });
      if (status === 'PUBLISHED') throw new SocialPublishError('Instagram says this reel container is already published — check the account before re-approving', { code: 'ig_already_published', unknown: true });
      if (i < polls - 1) await sleep((opts && opts.reelPollMs) || 15000);
    }
    if (status !== 'FINISHED') {
      const e = new SocialPublishError('Instagram is still processing the reel — will check again', { code: 'ig_reel_processing', retryable: true });
      e.resume = { containerId };
      throw e;
    }
    const pub = await graph(fetchFn, 'POST', '/' + igId + '/media_publish', { creation_id: containerId }, token, true);
    if (!pub.id) throw new SocialPublishError('Instagram returned no media id', { code: 'no_id', unknown: true });
    let url = '';
    try {
      const p = await graph(fetchFn, 'GET', '/' + pub.id, { fields: 'permalink' }, token, false);
      url = p.permalink || '';
    } catch (_) { /* posted; the permalink is a nicety */ }
    return { platformPostId: String(pub.id), url: url || 'https://www.instagram.com/' };
  }
  return {
    id: 'instagram',
    auto: true,
    connected() {
      if (!configured(igId) || !configured(token)) return { ok: false, reason: 'not_connected: IG_BUSINESS_ACCOUNT_ID / META_PAGE_ACCESS_TOKEN not set' };
      return { ok: true };
    },
    video: true,
    async publish({ message, mediaUrls, video, resume }) {
      if (video && video.url) return publishReel(message, video, resume);
      const urls = (mediaUrls || []).slice(0, 10);
      if (!urls.length) throw new SocialPublishError('Instagram posts need at least one photo', { code: 'ig_no_media' });
      let creationId;
      if (urls.length === 1) {
        const r = await graph(fetchFn, 'POST', '/' + igId + '/media', { image_url: urls[0], caption: message }, token, false);
        creationId = r.id;
      } else {
        const children = [];
        for (const u of urls) {
          const r = await graph(fetchFn, 'POST', '/' + igId + '/media', { image_url: u, is_carousel_item: true }, token, false);
          children.push(r.id);
        }
        const r = await graph(fetchFn, 'POST', '/' + igId + '/media', { media_type: 'CAROUSEL', children: children.join(','), caption: message }, token, false);
        creationId = r.id;
      }
      await waitReady(creationId);
      const pub = await graph(fetchFn, 'POST', '/' + igId + '/media_publish', { creation_id: creationId }, token, true);
      if (!pub.id) throw new SocialPublishError('Instagram returned no media id', { code: 'no_id', unknown: true });
      let url = '';
      try {
        const p = await graph(fetchFn, 'GET', '/' + pub.id, { fields: 'permalink' }, token, false);
        url = p.permalink || '';
      } catch (_) { /* posted; the permalink is a nicety */ }
      return { platformPostId: String(pub.id), url: url || 'https://www.instagram.com/' };
    },
  };
}

/**
 * Google Business Profile local posts — STUB behind a flag. API access is
 * pending (case 8-9748000042165). Off unless SOCIAL_GBP_ENABLED === 'true'
 * AND the five GBP_* secrets syncGbpReviews already uses are configured.
 * Same refresh-token OAuth as functions/gbp-reviews-sync.js (getAccessToken
 * is injected so tests never touch Google).
 */
function gbpAdapter(env, fetchFn, opts) {
  const on = env.SOCIAL_GBP_ENABLED === 'true';
  const getAccessToken = opts && opts.getGbpAccessToken;
  return {
    id: 'gbp',
    auto: true,
    connected() {
      if (!on) return { ok: false, reason: 'not_connected: Google Business posting is off (SOCIAL_GBP_ENABLED) until API access is approved' };
      for (const k of ['GBP_CLIENT_ID', 'GBP_CLIENT_SECRET', 'GBP_REFRESH_TOKEN', 'GBP_ACCOUNT_ID', 'GBP_LOCATION_ID']) {
        if (!configured(env[k])) return { ok: false, reason: 'not_connected: ' + k + ' not set' };
      }
      if (typeof getAccessToken !== 'function') return { ok: false, reason: 'not_connected: no GBP auth' };
      return { ok: true };
    },
    async publish({ message, mediaUrls }) {
      let token;
      try { token = await getAccessToken(); } catch (e) { throw new SocialPublishError('GBP auth failed: ' + e.message, { code: 'gbp_auth' }); }
      const url = 'https://mybusiness.googleapis.com/v4/accounts/' + env.GBP_ACCOUNT_ID + '/locations/' + env.GBP_LOCATION_ID + '/localPosts';
      const body = { languageCode: 'en-US', topicType: 'STANDARD', summary: String(message || '').slice(0, 1500) };
      if (mediaUrls && mediaUrls[0]) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: mediaUrls[0] }];
      let res;
      try {
        res = await fetchFn(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } catch (e) {
        throw new SocialPublishError('Network error talking to Google: ' + e.message, { code: 'network', unknown: true });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new SocialPublishError('GBP ' + res.status + ' ' + ((data.error && data.error.message) || ''), { code: 'gbp_' + res.status, retryable: res.status === 429, unknown: res.status >= 500 });
      return { platformPostId: String(data.name || ''), url: data.searchUrl || 'https://business.google.com/' };
    },
  };
}

function manualAdapter(id) {
  return {
    id,
    auto: false,
    connected() { return { ok: false, reason: 'manual: post this one by hand from the Ready to post queue' }; },
    async publish() { throw new SocialPublishError('Manual platform', { code: 'manual' }); },
  };
}

/** The adapter registry. env = secret/env values; fetchFn = fetch. */
function makeAdapters(env, fetchFn, opts) {
  const e = env || {};
  const f = fetchFn || (typeof fetch === 'function' ? fetch : null);
  return {
    facebook: facebookAdapter(e, f),
    instagram: instagramAdapter(e, f, opts),
    gbp: gbpAdapter(e, f, opts),
    tiktok: manualAdapter('tiktok'),
    nextdoor: manualAdapter('nextdoor'),
    linkedin: manualAdapter('linkedin'),
    x: manualAdapter('x'),
  };
}

module.exports = { GRAPH_VERSION, GRAPH_BASE, SocialPublishError, makeAdapters, configured, graph };
