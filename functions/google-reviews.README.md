# Google Reviews — Setup Runbook

Live Google reviews on `/review` are served by the `getGoogleReviews`
Cloud Function. This doc is the first-time setup. After this is done,
reviews refresh on their own every 6 hours, no manual work.

> **2026-09-13 correction:** step 2 below pointed at the legacy Places API
> and step 3 said to restrict the key to it. `functions/google-reviews.js:17-19`
> already had it right — the legacy "Places API" cannot be enabled on newer
> GCP projects; enable and restrict to **"Places API (New)"** instead. Also
> corrected: "How it behaves" claimed a cold cache + Google failure returns
> HTTP 503 and the widget hides itself. It doesn't — the function returns
> **200 with `empty: true`** (see `functions/google-reviews.js` around the
> cold-cache-fallback comment), and `docs/assets/js/google-reviews-widget.js`
> renders a "Read our reviews on Google" fallback card, it never hides.

## 1. Find your Place ID

You need Google's internal ID for your business. Two ways:

1. **Place ID Finder tool** — open
   <https://developers.google.com/maps/documentation/places/web-service/place-id>,
   type "No Big Deal Home Solutions Cincinnati", click the pin. The
   popup shows your Place ID. It starts with `ChIJ...`.
2. **From a Google Maps URL** — search your business on Google Maps.
   The URL contains a long string after `!1s0x...` that isn't the
   Place ID — use the finder above instead. The `?place_id=` query
   parameter is what you want if present.

Save this string. Example: `ChIJ1a2b3c4d5e6f7g8h9i0j`.

## 2. Enable the Places API (New)

In Google Cloud Console, make sure you are on the `nobigdeal-pro`
project (same project Firebase Functions run under).

1. Open
   <https://console.cloud.google.com/apis/library/places.googleapis.com>
2. Click **Enable**. If you see "Already enabled" you're done.
   (Do not use the legacy `places-backend.googleapis.com` listing —
   newer GCP projects can't enable it at all; see
   `functions/google-reviews.js:17-19`.)
3. (If prompted) accept billing terms. Google gives a $200/month
   maps & places credit; with our 6-hour cache we use < $0.10/mo, so
   you will never pay for this.

## 3. Create an API key

1. Open <https://console.cloud.google.com/apis/credentials>
2. **Create credentials → API key**.
3. Click the new key → **Edit API key**.
4. Under **API restrictions**, choose "Restrict key" and select
   **Places API (New)** only. This limits blast radius if the key
   ever leaks.
5. Under **Application restrictions**, leave as "None" — the key is
   only ever used server-side inside the Cloud Function, never
   exposed to the browser.
6. Copy the key. It starts with `AIza...`.

## 4. Store both values as Firebase secrets

From the repo root:

```bash
firebase functions:secrets:set GOOGLE_PLACES_API_KEY
# paste the AIza... key when prompted

firebase functions:secrets:set NBD_PLACE_ID
# paste the ChIJ... Place ID when prompted
```

Verify:

```bash
firebase functions:secrets:access GOOGLE_PLACES_API_KEY
firebase functions:secrets:access NBD_PLACE_ID
```

## 5. Deploy

```bash
firebase deploy --only functions:getGoogleReviews,hosting
```

The hosting deploy picks up the `firebase.json` rewrite so
`/api/google-reviews` routes through the function.

## 6. Verify

Hit the endpoint directly:

```bash
curl https://nobigdealwithjoedeal.com/api/google-reviews
```

You should see JSON with `rating`, `total`, and a `reviews` array.

Then visit <https://nobigdealwithjoedeal.com/review> — the live
Google section renders above the hand-curated review grid.

## How it behaves

- **Fresh cache (< 6 hours old)** — served from Firestore instantly,
  zero Google API cost.
- **Stale cache** — function refreshes from Google, stores new
  snapshot, serves it.
- **Google down / quota burnt** — function returns the last-known
  snapshot with `stale: true`. The widget shows a small
  "(showing last-known reviews)" note instead of blanking.
- **No cache yet and Google fails** — endpoint still returns **HTTP 200**,
  with `empty: true` and a `reason` field saying why (never a 503). The
  widget renders a "Read our reviews on Google →" fallback card instead
  of hiding itself. Hand-curated review grid still renders either way.

## Review momentum ("N new this month")

Places returns only 5 reviews, picked by relevance, so brand-new reviews
often don't appear on the cards. What Places *does* return is Google's
own review count (`userRatingCount` → `total`), so the function keeps a
history of it and reports growth:

- **Recording.** Every successful Places refresh writes one
  `{ date, total }` point per America/New_York day into `totalsHistory`
  on `public_cache/google_reviews`, as part of the same `set` as the
  snapshot (latest wins within a day; 400 days kept). A fresh GBP
  full-set serve records its total too, but only when today's point is
  missing or different. No write happens if the cache read failed, so a
  flaky read can't wipe the history.
- **Seed.** `SEED_TOTALS` in `google-reviews-momentum.js` compiles in
  three verified counts (2026-08-31 → 28, 2026-09-20 → 29,
  2026-09-27 → 32), each with its source, so the line works before the
  stored history is 30 days deep. Stored points win on the same date.
- **The number.** `recent = { newReviews, days, since }` is the current
  total minus the latest point on or before today − 30 days. Until a
  point that old exists, the oldest point is used and `days` is the real
  span, as long as that span is at least 7 days. A stale payload
  computes as of its own `fetchedAt` and loses the line after a week.
- **When it hides.** No baseline, a span under 7 days, or growth ≤ 0
  (e.g. Google removed a review) means `recent` is **absent** from the
  payload. The widget then renders exactly what it did before. It never
  shows "0 new".
- **Where it shows.** After the count in the cards header, and in the
  homepage summary row via the empty `data-nbd-gr-recent` hook:
  " · 4 new this month" for a 28–31 day span, otherwise
  " · 4 new in the last N days".

## When you want to invalidate the cache manually

**Don't delete the doc.** It also holds `totalsHistory`, and deleting it
resets "N new this month" to the compiled seed points only. Instead, in
the Firebase console → Firestore → `public_cache/google_reviews`, set
`fetchedAt` to `0`.

Next page view will trigger a refresh from Google.

## Cost

At a 6-hour TTL we make ~4 Place Details calls per day. Google's
price is $17 per 1,000. Monthly cost ≈ **$0.07**. Effectively free.

## Business Profile API (all reviews) — dormant layer

`syncGbpReviews` (functions/gbp-reviews-sync.js) removes the Places
5-review cap by pulling EVERY review daily through the Business Profile
API and writing them to Firestore `siteContent/googleReviews`.
`getGoogleReviews` serves that doc while it's fresh (≤36h) and falls
back to the Places flow above otherwise — same response shape, widget
untouched (it caps its rendered grid at 6 cards and links the rest to
the profile). The function ships dormant: until the GBP_* secrets hold
real values it logs "not configured" and exits — the deploy workflow
stubs them with `__unset__` automatically.

Enable it when Google approves Business Profile API access:

1. Submit the access request from the Google account that OWNS the
   profile (https://developers.google.com/my-business/content/prereqs).
   Approval typically takes days to a few weeks.
2. In the GCP project: enable the My Business API family, create an
   OAuth client, and mint a refresh token for the profile-owner account
   with scope `https://www.googleapis.com/auth/business.manage`.
3. Look up the ids: `accounts.list` → accounts/{GBP_ACCOUNT_ID};
   `accounts.locations.list` → locations/{GBP_LOCATION_ID} (numeric ids
   only, no `accounts/`/`locations/` prefixes).
4. Set the five secrets:
   `firebase functions:secrets:set GBP_CLIENT_ID` (repeat for
   GBP_CLIENT_SECRET, GBP_REFRESH_TOKEN, GBP_ACCOUNT_ID,
   GBP_LOCATION_ID).
5. `firebase deploy --only functions:syncGbpReviews,functions:getGoogleReviews`
6. First sync lands at the next 6:00 AM ET run (or trigger the Cloud
   Scheduler job manually). Until then the endpoint keeps serving the
   Places layer — the cutover is invisible.

Rollback: delete `siteContent/googleReviews` (or let it go stale >36h)
and the endpoint reverts to the Places flow automatically.
