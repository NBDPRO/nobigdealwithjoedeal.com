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
    async publish({ message, mediaUrls }) {
      const urls = mediaUrls || [];
      let postId;
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
  return {
    id: 'instagram',
    auto: true,
    connected() {
      if (!configured(igId) || !configured(token)) return { ok: false, reason: 'not_connected: IG_BUSINESS_ACCOUNT_ID / META_PAGE_ACCESS_TOKEN not set' };
      return { ok: true };
    },
    async publish({ message, mediaUrls }) {
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
