# getGoogleReviews: 4,017 errors for a feature that never once worked

> **Update 2026-09-27 — resolved.** Live Google reviews have rendered since
> mid-September: `/api/google-reviews` returned 5.0 / 29 reviews on 09-20
> ([NEXT_SESSION-2026-09-21](../projects/NEXT_SESSION-2026-09-21.md) §6), and
> #1545 pinned the visual tests against the now-live data. The note below
> describes the 09-08 state. Current SEO/reviews picture:
> [SEO-AEO-GEO-DEEP-DIVE-2026-09-27](SEO-AEO-GEO-DEEP-DIVE-2026-09-27.md).

**2026-09-08** · project `nobigdeal-pro` · log-noise fixed in this session,
the feature itself still needs Jo

`getGoogleReviews` has logged `refresh failed` on essentially every request
since it shipped. It is not a regression, not related to the 2026-09-08T20:01Z
deploy of #1505, and not an outage. Both secrets it needs have held the
deploy workflow's `__unset__` stub since the day the function was created, so
there has never been a successful Google Places fetch — **live Google reviews
have never rendered on the site.**

Two things were wrong, and only one of them is Jo's to fix:

1. The secrets are unset (needs a Places API key + place id from Jo).
2. The function treated that permanent, known deploy state as a per-request
   runtime **error** — 4,017 ERROR lines in the 30-day retention window for a
   function whose genuine fault rate is zero. That half is fixed here.

---

## 1. Root cause, verified in Secret Manager

```bash
for S in GOOGLE_PLACES_API_KEY NBD_PLACE_ID; do
  gcloud secrets versions list "$S" --project=nobigdeal-pro \
    --format="value(name,createTime)"
done
```

```
GOOGLE_PLACES_API_KEY: 1  2026-04-21T19:10:06
NBD_PLACE_ID:          1  2026-04-21T19:10:17
```

**One version each. Both created 2026-04-21** — the same day
`functions/google-reviews.js` first landed (`37e99b18`, *feat(reviews): live
Google Reviews via Firebase Function + 6h cache*). That single version is the
sentinel the deploy workflow writes:

```bash
gcloud secrets versions access latest --secret=NBD_PLACE_ID --project=nobigdeal-pro
# __unset__
```

Nobody has ever run steps 1–4 of `functions/google-reviews.README.md`. The
runbook exists, is correct, and was never executed. **140 days dead.**

The `__unset__` value comes from `.github/workflows/firebase-deploy.yml`
("Ensure integration secrets exist (stub if missing)"), which discovers every
`defineSecret(...)` name under `functions/` and creates any missing secret with
that sentinel — the Firebase CLI refuses to bind a secret with no version. This
is working as designed; `secretValue()` in `functions/integrations/_shared.js`
correctly reads the sentinel as unset. That guard (2026-09-04,
[STABILITY-AUDIT](STABILITY-AUDIT-2026-09-04.md)) is what stopped us asking
Google for `places/__unset__` — it fixed the *behaviour* and left the
*reporting* wrong, which is this note.

## 2. The noise, measured

```bash
gcloud logging read 'resource.labels.service_name="getgooglereviews" AND severity>=ERROR' \
  --project=nobigdeal-pro --limit=5000 --format="value(timestamp)" --freshness=30d | wc -l
# 4017      (under the 5000 cap, so this is the true count, not a truncation)
```

Spread across the whole retention window — 1 on 2026-08-09 through 661 on
2026-09-08 — i.e. it predates retention entirely. Daily spikes (435, 412, 322,
376, 661) are not traffic spikes. See §3.

Every line identical:

```
getGoogleReviews: refresh failed Error: Google Places not configured:
GOOGLE_PLACES_API_KEY and/or NBD_PLACE_ID unset (or the __unset__ deploy stub)
    at /workspace/google-reviews.js:176:15
```

**Why this is worse than noise.** ERROR was the same severity a genuine Places
outage or quota burn would use, from the same function, with the fallback
behaviour identical. A real incident would have been indistinguishable from the
background — and the background was 100% of the volume.

## 3. The caller — it is CI hitting production, not customers

The burst pattern (4 errors in ~20s) is not a retry loop. There is no retry
anywhere: the widget fetches once on `DOMContentLoaded` and gives up. The
requests are real, and they are **ours**:

```bash
gcloud logging read 'resource.labels.service_name="getgooglereviews" AND httpRequest.requestUrl!=""' \
  --project=nobigdeal-pro --limit=1000 --format="value(httpRequest.referer)" --freshness=7d \
  | sed -E 's#(https?://[^/]+).*#\1#' | sort | uniq -c | sort -rn
```

```
    976 http://127.0.0.1:5000
     22 https://nobigdealwithjoedeal.com
      1 https://nobigdeal-pro--portal-framing-verify-w00ebkz6.web.app
```

**97.7% of all traffic to this production function is CI.** Source IPs are
Azure ranges (GitHub Actions runners); the referer is the hosting emulator.

The mechanism: `ci.yml` runs the public-surface and visual-regression specs
under `emulators:exec --only hosting`. The **functions emulator is not
running**, so the `/api/google-reviews` rewrite in `firebase.json` resolves to
the *deployed production function* — the logged `requestUrl` is
`https://us-central1-nobigdeal-pro.cloudfunctions.net/getGoogleReviews/...`.
The widget ships on 17 pages (homepage, `/review`, 15 service hubs), so every
Playwright page load of any of them fires a billed prod invocation, a prod
Firestore rate-limit transaction, and — before this fix — one prod ERROR line.

Consequences worth naming:

- **CI depends on a production function being up.** Nothing declares that.
- The per-IP limit is 60/min (`rate-limit-policy.js`). Parallel shards from one
  runner IP could 429 and produce a flaky, entirely mysterious failure.
- Once the secrets are real, this same path burns real Places quota on cache
  misses.

**Not fixed here, deliberately.** The obvious fix — stubbing the route in
Playwright — changes what the committed visual baselines render
(`tests/e2e/visual-regression.spec.js-snapshots/`, 12 files including
`landing--*`, which carries the widget). That needs its own PR with a baseline
re-bless, not a drive-by. Filed as an open item in §6.

## 4. Customer-visible impact: degraded, not broken

```bash
curl https://nobigdealwithjoedeal.com/api/google-reviews
```

```json
{"name":"No Big Deal Home Solutions","rating":0,"total":0,"profileUrl":"",
 "reviews":[],"cached":false,"stale":false,"empty":true,"fetchedAt":1788899631450}
```

The cold-cache branch. `public_cache/google_reviews` has never been written —
there is no cache to go stale, because no fetch ever succeeded.

`docs/assets/js/google-reviews-widget.js` handles this correctly:
`renderAll()` sees `reviews.length === 0` and calls `renderFallback()`, which
renders a "Read our reviews on Google" card linking to the profile.
`hydrateStaticHooks()` returns early on `total === 0`, so the static rating
figures on `/review` keep their hand-authored fallback text.

**So: no blank section, no broken layout, no console error, no wrong rating on
any of the 17 pages.** What is lost is the feature itself — live star rating,
review count, and review cards — on the homepage, `/review`, and 15 service
hubs. The visual-regression baselines were captured in this state, which is the
quiet confirmation that it has always looked like this.

## 5. Why nothing caught it

Beyond the ten undeployed policies (verified independently below), this
function was **never in the alert's scope in the first place**:

```
monitoring/alert-functions-error-rate.json →
  service_name=monitoring.regex.full_match(
    "claudeproxy|createcheckoutsession|validateaccesscode|imageproxy|
     publicvisualizerai|renderpdf|submitpubliclead|stripewebhook")
```

`getgooglereviews` is absent. Even fully deployed, it would not have fired.

Re-verified the undeployed claim from
[RENDERPDF-CHROMIUM-INTEROP §5a](RENDERPDF-CHROMIUM-INTEROP-2026-09-08.md)
first-hand, with a positive control on the same API surface — an empty result
from `gcloud` is not by itself evidence:

```bash
gcloud alpha monitoring policies list --project=nobigdeal-pro --format="value(displayName)"
# (empty)
gcloud alpha monitoring channels list  --project=nobigdeal-pro --format="value(type,displayName)"
# email  Joe - Primary
# sms    Joe - Primary
```

Channels return; policies do not. The empty result is real.

**The ordering point that matters:** adding `getgooglereviews` to that regex
*before* this fix would have been actively harmful — it would have pinned the
alert permanently red on a configuration gap, and a check that is always
failing is a check nobody reads. After this fix, an ERROR from this service
means a real Places outage, so adding it is now both safe and meaningful.

## 6. The fix

`functions/google-reviews.js` — not-configured is now its own branch, ahead of
the try/catch, and never reaches `logger.error`:

- **Throttled to one WARN per warm instance per hour** (module-scope
  timestamp; `maxInstances: 3`, so ≤3/hour project-wide).
- **Not silenced.** The warn still fires, names *which* of the two secrets is
  missing, points at the runbook, and carries
  `event: 'google_reviews_not_configured'` — a stable field an alert policy can
  match exactly. Downgrading severity without keeping the signal is how
  `renderPdf` stayed 100% down for 11 weeks behind a client fallback; this is
  throttled, not hidden.
- **No Google call is attempted** — the stub cannot succeed.
- **`reason` is echoed into the response body** (`not_configured` vs
  `refresh_failed`). Previously an unconfigured deploy and a Google outage were
  byte-identical from outside, and only Cloud Logging could tell them apart;
  now `curl /api/google-reviews` diagnoses itself.
- **Cold unconfigured responses get `max-age=300`** instead of 60 — 5× fewer
  origin hits from real traffic, at the cost of ≤5 minutes' delay before live
  reviews appear once the secrets are set. Genuine failures keep the short 60s
  TTL because they are expected to clear on their own.
- The three-tier fallback chain (last-known Places cache → stale GBP full set →
  empty payload) moved verbatim into a shared `serveFallback()` so the two
  paths cannot drift in what the widget receives while differing in logging.

**Genuine Places failures stay at ERROR.** That is the whole point: an error
line from this function now means something is actually broken.

### The test, and proof it can fail

`tests/google-reviews-not-configured.test.js` (24 assertions, wired into the
`node` bucket of `tests/ci-manifest.json`; the `run-test-manifest.js` FLOORS
ratchet went 106→107 / 191→192).

It drives the **real exported handler** against firebase modules stubbed at the
module loader — the `address-audit-script.test.js` idiom, so no `functions/`
install, no credentials, no network — and counts observed `logger` calls and
`fetch` invocations. It deliberately does **not** match source strings: a
`/logger\.warn/` shape regex would pass against the throwing version too, which
is exactly how the #1416 photo-destroying change stayed "covered by tests".

Proven by reverting the fix (throw restored inside the `try`) and re-running:

```
✗ 20 requests log ZERO errors (was 20 — one per request) — saw 20
✗ the condition is still reported — exactly one warn, not silence — saw 0
✗ the warn carries the machine-matchable event field ...
✗ body says WHY it is empty — reason:not_configured ...
✗ cold unconfigured payload gets the longer 300s edge TTL
15 passed, 9 failed   (exit code 1)
```

The nine that redden are the nine that should; the control assertions
(happy path, real-failure-stays-loud, fallback chain) stayed green in both
directions.

The break test also **found a defect in the test itself**: an assertion
indexing `logs.warn[0][1]` directly threw a `TypeError` when no warn was
emitted, aborting the run and swallowing every later case. A regression suite
whose failure mode is a stack trace reports less than one that fails cleanly.
Fixed with a guarded `warnMeta()` accessor before trusting the suite — the
break test earning its keep twice.

## 7. Open — needs Jo

1. **Set the two secrets.** `functions/google-reviews.README.md` steps 1–5 are
   accurate and unchanged: enable Places API (New), create a key with
   *Application restrictions: None* (server-side; a referrer-restricted key is
   silently refused), grab the `ChIJ...` place id, then
   `firebase functions:secrets:set` each and redeploy. ~$0.07/month.
2. **Expect the visual baselines to break** the moment that lands. The
   committed `landing--*` snapshots were captured with the fallback card; real
   reviews will change those pixels. Re-bless them in the same PR.
3. **Stop CI from calling the production function** (§3). Needs its own PR
   because the fix moves visual baselines.
4. **Add `getgooglereviews` to `alert-functions-error-rate.json`** — safe only
   now, per §5. Worth nothing until the policies are actually deployed, which
   is still the larger open item from the renderPdf note.

---

## Related

- [RENDERPDF-CHROMIUM-INTEROP-2026-09-08](RENDERPDF-CHROMIUM-INTEROP-2026-09-08.md)
  — §5a, the undeployed alert policies that let both of these run unnoticed
- [STABILITY-AUDIT-2026-09-04](STABILITY-AUDIT-2026-09-04.md) — where the
  `__unset__` stub class of bug was first catalogued
- `functions/google-reviews.README.md` — the setup runbook that was never run
