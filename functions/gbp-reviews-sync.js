/**
 * GBP all-reviews sync — the "no more 5-review cap" layer (remediation
 * brief Item 3/C step 3, built 2026-07-13). DORMANT BY DESIGN until
 * Google approves Business Profile API access and the five GBP_* secrets
 * below get real values: the deploy workflow stubs undeclared secrets
 * with the __unset__ sentinel, and every scheduled run before
 * configuration logs "not configured" and exits without touching
 * anything. Flipping this on is config-only — no code changes.
 *
 * WHY: the Places API hard-caps at 5 reviews. The Business Profile API
 * returns EVERY review for an owned location (free), but requires OAuth
 * as the profile owner + Google's access-request form. Google offers no
 * review webhook, so "auto-updating" means polling — daily here.
 *
 * FLOW: refresh-token OAuth → v4 reviews.list (paginated) → map to the
 * exact /api/google-reviews response shape → Firestore
 * siteContent/googleReviews. getGoogleReviews serves that doc while
 * fresh (≤36h) and falls back to the Places path otherwise. Same
 * response shape end to end, so the widget needs nothing.
 *
 * SETUP when approval lands: functions/google-reviews.README.md,
 * "Business Profile API (all reviews)" section.
 */
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');

const GBP_CLIENT_ID = defineSecret('GBP_CLIENT_ID');
const GBP_CLIENT_SECRET = defineSecret('GBP_CLIENT_SECRET');
const GBP_REFRESH_TOKEN = defineSecret('GBP_REFRESH_TOKEN');
const GBP_ACCOUNT_ID = defineSecret('GBP_ACCOUNT_ID');
const GBP_LOCATION_ID = defineSecret('GBP_LOCATION_ID');

const GBP_DOC_PATH = 'siteContent/googleReviews';
const PROFILE_URL = 'https://g.page/r/CXzIjLwvtRPdEBM';

// The deploy workflow provisions missing secrets with this sentinel (see
// "Ensure integration secrets exist" in firebase-deploy.yml; same
// convention as integrations/_shared.js hasSecret()). A sentinel value
// means "not configured yet" — never an error.
const SECRET_STUB = '__unset__';
function configured(v) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim() !== SECRET_STUB;
}

const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
function starRatingToNumber(s) {
  return STAR[s] || 5;
}

// Coarse humanized age, regenerated on every daily sync so drift stays
// under a day — same freshness class as the Places payload's
// relative_time_description, which we also serve from a cache.
function relativeTimeFrom(thenMs, nowMs) {
  const day = 86400000;
  const d = Math.max(0, nowMs - thenMs);
  if (d < day) return 'today';
  if (d < 2 * day) return 'a day ago';
  if (d < 7 * day) return `${Math.floor(d / day)} days ago`;
  if (d < 14 * day) return 'a week ago';
  if (d < 30 * day) return `${Math.floor(d / (7 * day))} weeks ago`;
  if (d < 60 * day) return 'a month ago';
  if (d < 365 * day) return `${Math.floor(d / (30 * day))} months ago`;
  if (d < 730 * day) return 'a year ago';
  return `${Math.floor(d / (365 * day))} years ago`;
}

// v4 review resource → the widget's review shape (google-reviews.js).
function mapGbpReview(r, nowMs) {
  const created = Date.parse((r && (r.createTime || r.updateTime)) || '') || 0;
  return {
    author: (r && r.reviewer && r.reviewer.displayName) || 'Google user',
    profilePhotoUrl: (r && r.reviewer && r.reviewer.profilePhotoUrl) || '',
    rating: starRatingToNumber(r && r.starRating),
    text: (r && r.comment) || '',
    relativeTime: relativeTimeFrom(created, nowMs),
    time: Math.floor(created / 1000),
  };
}

async function fetchAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GBP OAuth token exchange HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  const body = await res.json();
  if (!body.access_token) throw new Error('GBP OAuth token exchange returned no access_token');
  return body.access_token;
}

async function fetchAllReviews(accessToken, accountId, locationId) {
  const base =
    'https://mybusiness.googleapis.com/v4/accounts/' +
    `${encodeURIComponent(accountId)}/locations/${encodeURIComponent(locationId)}/reviews`;
  const out = { reviews: [], averageRating: 0, totalReviewCount: 0 };
  let pageToken = '';
  // 20 pages × 50 = 1,000-review guard — far above any realistic count.
  for (let page = 0; page < 20; page++) {
    const url = `${base}?pageSize=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`GBP reviews.list HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    const body = await res.json();
    out.reviews.push(...(body.reviews || []));
    if (typeof body.averageRating === 'number') out.averageRating = body.averageRating;
    if (typeof body.totalReviewCount === 'number') out.totalReviewCount = body.totalReviewCount;
    pageToken = body.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}

exports.syncGbpReviews = onSchedule(
  {
    schedule: '0 6 * * *',
    timeZone: 'America/New_York',
    region: 'us-central1',
    secrets: [GBP_CLIENT_ID, GBP_CLIENT_SECRET, GBP_REFRESH_TOKEN, GBP_ACCOUNT_ID, GBP_LOCATION_ID],
  },
  async () => {
    const cfg = {
      clientId: GBP_CLIENT_ID.value(),
      clientSecret: GBP_CLIENT_SECRET.value(),
      refreshToken: GBP_REFRESH_TOKEN.value(),
      accountId: GBP_ACCOUNT_ID.value(),
      locationId: GBP_LOCATION_ID.value(),
    };
    if (!Object.values(cfg).every(configured)) {
      logger.info(
        'syncGbpReviews: GBP secrets not configured — dormant until Business Profile API access is approved (see google-reviews.README.md)'
      );
      return;
    }

    const token = await fetchAccessToken(cfg.clientId, cfg.clientSecret, cfg.refreshToken);
    const raw = await fetchAllReviews(token, cfg.accountId, cfg.locationId);
    // Same guard philosophy as google-reviews.js: this profile has dozens of
    // reviews — an empty list is an anomaly, and throwing here means we
    // refuse to overwrite the last-known-good doc.
    if (!raw.reviews.length) {
      throw new Error('GBP returned zero reviews — refusing to overwrite last-known-good doc');
    }

    const nowMs = Date.now();
    const reviews = raw.reviews.map((r) => mapGbpReview(r, nowMs)).sort((a, b) => b.time - a.time);
    const data = {
      name: 'No Big Deal Home Solutions',
      rating: typeof raw.averageRating === 'number' ? raw.averageRating : 0,
      total: raw.totalReviewCount || reviews.length,
      profileUrl: PROFILE_URL,
      reviews,
    };
    await getFirestore().doc(GBP_DOC_PATH).set({ data, fetchedAt: nowMs, source: 'gbp' }, { merge: true });
    logger.info(
      `syncGbpReviews: wrote ${reviews.length} reviews (rating ${data.rating}, total ${data.total}) to ${GBP_DOC_PATH}`
    );
  }
);

// Reused by functions/social-studio.js (Social Studio's GBP local-posts adapter,
// dormant behind SOCIAL_GBP_ENABLED) — one refresh-token OAuth for both.
exports.fetchAccessToken = fetchAccessToken;

exports._test = { configured, starRatingToNumber, relativeTimeFrom, mapGbpReview, GBP_DOC_PATH };
