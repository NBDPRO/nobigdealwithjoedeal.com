/**
 * Google Reviews proxy — pulls the business's Google Place Details
 * (rating, total review count, latest ~5 reviews) through the Places
 * API and caches the result in Firestore so the public frontend never
 * touches the API key or burns billable calls on every page view.
 *
 * Design:
 *   - Fresh data window: 6 hours. Pages rendered within that window
 *     serve the cached doc with no external round-trip.
 *   - Stale fallback: if Google is down or quota is burnt, the function
 *     returns the last-known good cache with `stale: true` rather than
 *     a 500. The /review page degrades gracefully.
 *   - No client-side Firestore reads required — the public endpoint is
 *     the only surface. This keeps the security model simple.
 *
 * Setup (runbook in functions/google-reviews.README.md):
 *   1. Enable "Places API (New)" in Google Cloud Console (the legacy
 *      "Places API" cannot be enabled on newer projects). Key
 *      restrictions: server-side calls need IP/none — an HTTP-referrer
 *      restricted key is silently refused. Billing must be active.
 *   2. firebase functions:secrets:set GOOGLE_PLACES_API_KEY
 *   3. firebase functions:secrets:set NBD_PLACE_ID
 *   4. firebase deploy --only functions:getGoogleReviews,hosting
 *
 * Cost model:
 *   With a 6-hour TTL we make ~4 Place Details calls per day
 *   ($17/1000 = $0.07/mo at current Google pricing). Effectively free.
 */
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');

const GOOGLE_PLACES_API_KEY = defineSecret('GOOGLE_PLACES_API_KEY');
const NBD_PLACE_ID = defineSecret('NBD_PLACE_ID');
const { secretValue } = require('./integrations/_shared');
const { presentPayload } = require('./google-reviews-display');
const { recordTotal, needsRecord } = require('./google-reviews-momentum');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_DOC_PATH = 'public_cache/google_reviews';

// Full-set layer (brief 3/C step 3): syncGbpReviews (gbp-reviews-sync.js)
// writes EVERY review here daily via the Business Profile API — no Places
// 5-review cap. Served while fresh; the Places path below stays as the
// fallback so nothing changes while the sync is dormant/unconfigured.
const GBP_DOC_PATH = 'siteContent/googleReviews';
const GBP_FRESH_MS = 36 * 60 * 60 * 1000; // daily sync + slack

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// Throttle for the not-configured notice. Missing secrets are a DEPLOY
// STATE, not a per-request fault: the condition is identical on request 1
// and request 10,000, so logging it once per request buys no information
// and costs a flooded error stream. Module scope = once per warm instance
// per hour (maxInstances 3, so ≤3/hour project-wide).
const NOT_CONFIGURED_LOG_INTERVAL_MS = 60 * 60 * 1000;
let lastNotConfiguredLogAt = 0;

/**
 * Momentum options for a STALE payload. Its total was observed at
 * `doc.fetchedAt`, not now, so the 30-day window ends there — computing it
 * against today would credit old growth to the current month. Past a week of
 * staleness the line is dropped entirely rather than dated.
 */
const STALE_MOMENTUM_MAX_MS = 7 * 24 * 60 * 60 * 1000;
function staleMomentum(doc, totalsHistory, now) {
  const at = doc && Number(doc.fetchedAt);
  if (!at || now - at > STALE_MOMENTUM_MAX_MS) return undefined;
  return { totalsHistory, now: at };
}

/**
 * Serve the best payload we still have when a refresh cannot produce one:
 * last-known-good Places cache → stale GBP full set → empty-but-valid body.
 *
 * Shared by the not-configured branch and the refresh-failed catch so the
 * two can differ in LOGGING (warn-once vs. error-every-time) without ever
 * drifting in what the widget actually receives. `reason` is echoed into
 * the body so `curl /api/google-reviews` says WHY it is empty — before
 * this, a cold unconfigured deploy and a Google outage were byte-identical
 * from outside and only Cloud Logging could tell them apart.
 */
function serveFallback(res, { cached, gbp, now, reason }) {
  const history = cached && cached.totalsHistory;
  if (cached && cached.data) {
    res.set('Cache-Control', 'public, max-age=120');
    return res.status(200).json({
      ...presentPayload(cached.data, staleMomentum(cached, history, now)),
      cached: true,
      stale: true,
      reason,
      fetchedAt: cached.fetchedAt || 0,
    });
  }
  // A stale GBP full-set doc still beats an empty payload — old
  // reviews are real reviews.
  if (gbp && gbp.data && Array.isArray(gbp.data.reviews) && gbp.data.reviews.length) {
    res.set('Cache-Control', 'public, max-age=120');
    return res.status(200).json({
      ...presentPayload(gbp.data, staleMomentum(gbp, history, now)),
      cached: true,
      stale: true,
      source: 'gbp',
      reason,
      fetchedAt: gbp.fetchedAt || 0,
    });
  }
  // Cold-cache fallback: return an empty-but-valid payload instead
  // of a 503 — the widget renders its "Read our reviews on Google"
  // card and the static featured section still carries the page.
  //
  // An unconfigured deploy lands here on EVERY request forever, so it gets
  // a longer edge TTL than a transient Google failure: 5 minutes of CDN
  // caching turns one origin hit per page view into one per 5 minutes, and
  // costs at most a 5-minute delay before real reviews appear once the
  // secrets are set. A refresh failure keeps the short 60s TTL because it
  // is expected to clear on its own.
  res.set(
    'Cache-Control',
    reason === 'not_configured' ? 'public, max-age=300' : 'public, max-age=60'
  );
  return res.status(200).json({
    name: 'No Big Deal Home Solutions',
    rating: 0,
    total: 0,
    profileUrl: '',
    reviews: [],
    cached: false,
    stale: false,
    empty: true,
    reason,
    fetchedAt: now,
  });
}

/**
 * Fetch Place Details from Places API (New).
 *
 * Migrated off the legacy /maps/api/place/details/json endpoint
 * (2026-07-12): Google no longer enables the legacy Places API on newer
 * Cloud projects, so every legacy call came back REQUEST_DENIED. That
 * throw landed in the cold-cache fallback below on every invocation —
 * the observed `empty: true` payload with a fresh fetchedAt.
 * The v1 endpoint authenticates via headers and REQUIRES `reviews` in
 * the X-Goog-FieldMask or no review data comes back. Google returns at
 * most 5 reviews (hard product limit) sorted by relevance; there is no
 * newest-first parameter on v1 Place Details.
 */
async function fetchFromGoogle(placeId, apiKey) {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'displayName,rating,userRatingCount,googleMapsUri,reviews',
    },
    // A stalled Places response must not hold a billed invocation open until
    // the platform timeout; a timeout throw lands in the stale-cache fallback.
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google Places API (New) HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  const r = await res.json();
  // Guard the last-known-good cache: the legacy endpoint's body.status check
  // threw on degraded payloads BEFORE the cache write; v1 has no in-band
  // status, so an HTTP-200 body missing reviews (field-mask hiccup, profile
  // glitch) would otherwise overwrite good cached reviews with an empty set
  // and the widget would show nothing for the next 6h. This profile has
  // dozens of reviews — an empty list here is an anomaly, not a fact.
  if (!Array.isArray(r.reviews) || r.reviews.length === 0) {
    throw new Error('Google Places API (New) returned 200 with no reviews — refusing to overwrite last-known-good cache');
  }
  return {
    name: (r.displayName && r.displayName.text) || 'No Big Deal Home Solutions',
    rating: typeof r.rating === 'number' ? r.rating : 0,
    total: typeof r.userRatingCount === 'number' ? r.userRatingCount : 0,
    profileUrl: r.googleMapsUri || '',
    reviews: Array.isArray(r.reviews)
      ? r.reviews.slice(0, 5).map((rev) => ({
          author: (rev.authorAttribution && rev.authorAttribution.displayName) || 'Google user',
          profilePhotoUrl: (rev.authorAttribution && rev.authorAttribution.photoUri) || '',
          rating: typeof rev.rating === 'number' ? rev.rating : 5,
          text: (rev.text && rev.text.text) || (rev.originalText && rev.originalText.text) || '',
          relativeTime: rev.relativePublishTimeDescription || '',
          time: rev.publishTime
            ? Math.floor(Date.parse(rev.publishTime) / 1000)
            : Math.floor(Date.now() / 1000),
        }))
      : [],
  };
}

exports.getGoogleReviews = onRequest(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    maxInstances: 3,
    secrets: [GOOGLE_PLACES_API_KEY, NBD_PLACE_ID],
  },
  // 2026-08-10: was the only public onRequest endpoint with NO rate limit at
  // all — each cache-miss/refresh request cost 2 Firestore reads plus (stale
  // cache) an unsynchronized billed Places API call. guardHttp enforces the
  // ROUTES ceilings (per-IP; uid 0 — anonymous marketing-page widget).
  require('./rate-limit-policy').guardHttp('getGoogleReviews', async (req, res) => {
    const db = getFirestore();
    const ref = db.doc(CACHE_DOC_PATH);
    const now = Date.now();

    // Both docs are read up front (in parallel): the GBP-fresh path needs the
    // cache doc too, because the review-count history (totalsHistory, see
    // google-reviews-momentum.js) lives on it.
    //
    // cacheReadOk gates every history WRITE. If the read failed we don't know
    // what history is stored, and writing recordTotal([]) with merge:true
    // would replace the whole array with a single point — wiping the
    // baseline the "N new this month" line depends on.
    let gbp = null;
    let cached = null;
    let cacheReadOk = true;
    await Promise.all([
      db.doc(GBP_DOC_PATH).get().then(
        (snap) => { if (snap.exists) gbp = snap.data(); },
        (e) => logger.warn('getGoogleReviews: gbp doc read failed', e)
      ),
      ref.get().then(
        (snap) => { if (snap.exists) cached = snap.data(); },
        (e) => { cacheReadOk = false; logger.warn('getGoogleReviews: cache read failed', e); }
      ),
    ]);
    const storedHistory = cached && cached.totalsHistory;

    if (
      gbp && gbp.fetchedAt && now - gbp.fetchedAt < GBP_FRESH_MS &&
      gbp.data && Array.isArray(gbp.data.reviews) && gbp.data.reviews.length
    ) {
      // Record the full set's total too — at most one write per day (or when
      // the count changes), never one per request. Non-fatal: the reviews
      // are served whether or not the history point lands.
      let history = storedHistory;
      if (cacheReadOk && needsRecord(storedHistory, gbp.data.total, now)) {
        history = recordTotal(storedHistory, gbp.data.total, now);
        try {
          await ref.set({ totalsHistory: history }, { merge: true });
        } catch (e) {
          logger.warn('getGoogleReviews: totalsHistory write failed', e);
        }
      }
      res.set('Cache-Control', 'public, max-age=600');
      return res.status(200).json({
        ...presentPayload(gbp.data, { totalsHistory: history, now }),
        cached: true,
        stale: false,
        source: 'gbp',
        fetchedAt: gbp.fetchedAt,
      });
    }

    // Fresh-cache path: serve without hitting Google
    if (cached && cached.fetchedAt && now - cached.fetchedAt < CACHE_TTL_MS) {
      res.set('Cache-Control', 'public, max-age=600');
      return res.status(200).json({
        ...presentPayload(cached.data, { totalsHistory: storedHistory, now }),
        cached: true,
        stale: false,
        fetchedAt: cached.fetchedAt,
      });
    }

    // Refresh path
    // secretValue(): the deploy's '__unset__' stub reads as unset. Before
    // 2026-09-04 both stubs passed a truthiness check and this asked Google
    // for places/__unset__ on every refresh.
    const placeId = secretValue(NBD_PLACE_ID);
    const apiKey = secretValue(GOOGLE_PLACES_API_KEY);

    // Not configured is not a failure — it is a deploy state, and it must be
    // reported as one. Until 2026-09-08 this threw into the catch below, so
    // every single request logged `logger.error('refresh failed')`: 1,000+
    // ERROR lines in 48 hours on a project whose real fault rate was zero.
    // That is worse than noise. It buried genuine Places outages in an
    // identical error, and it made the function look like an active incident
    // when the true state was "a runbook step was never run". Both secrets
    // have held the '__unset__' stub since the function first deployed —
    // there has never been a successful Places fetch.
    //
    // Deliberately NOT silenced. The condition still logs, still names both
    // secrets and the runbook, and now carries a stable `event` field an
    // alert policy can match exactly — it is throttled, not hidden. The
    // response body gained `reason: 'not_configured'` for the same purpose:
    // this must stay findable from outside without reading Cloud Logging.
    // Setup: functions/google-reviews.README.md steps 1-5.
    if (!placeId || !apiKey) {
      if (now - lastNotConfiguredLogAt >= NOT_CONFIGURED_LOG_INTERVAL_MS) {
        lastNotConfiguredLogAt = now;
        logger.warn(
          'getGoogleReviews: Google Places not configured — serving fallback, no Google call attempted',
          {
            event: 'google_reviews_not_configured',
            GOOGLE_PLACES_API_KEY: apiKey ? 'set' : 'unset-or-stub',
            NBD_PLACE_ID: placeId ? 'set' : 'unset-or-stub',
            runbook: 'functions/google-reviews.README.md',
            throttledSeconds: NOT_CONFIGURED_LOG_INTERVAL_MS / 1000,
          }
        );
      }
      return serveFallback(res, { cached, gbp, now, reason: 'not_configured' });
    }

    try {
      const fresh = await fetchFromGoogle(placeId, apiKey);
      // Same single write as before, now carrying today's count point.
      // Skipped (field omitted, so merge keeps what's stored) when the cache
      // read failed — see cacheReadOk above.
      const history = cacheReadOk ? recordTotal(storedHistory, fresh.total, now) : storedHistory;
      const write = { data: fresh, fetchedAt: now };
      if (cacheReadOk) write.totalsHistory = history;
      await ref.set(write, { merge: true });

      res.set('Cache-Control', 'public, max-age=600');
      return res.status(200).json({
        ...presentPayload(fresh, { totalsHistory: history, now }),
        cached: false,
        stale: false,
        fetchedAt: now,
      });
    } catch (err) {
      // Reached only when the secrets were REAL and Google (or the network)
      // let us down — a genuine, actionable outage. Kept at ERROR severity
      // precisely because the not-configured case no longer competes with
      // it: an error line here now means something is actually broken.
      logger.error('getGoogleReviews: refresh failed', err);

      // Stale fallback — better to show old reviews than nothing
      return serveFallback(res, { cached, gbp, now, reason: 'refresh_failed' });
    }
  })
);
