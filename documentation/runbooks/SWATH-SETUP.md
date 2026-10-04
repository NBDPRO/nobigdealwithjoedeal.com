# Swath API setup (2026-08-06)

> **RETIRED 2026-10-04 — do not follow.** The Swath integration was never
> configured (`SWATH_API_KEY` and `SWATH_WEBHOOK_SECRET` held the deploy's
> `__unset__` stub), so its code was removed: `integrations/swath.js`, the
> `getSwathReport` / `getSwathUsage` / `swathWebhook` exports, and the
> `swath` options of `NBD_HAIL_PROVIDER` and `NBD_PARCEL_PROVIDER`. See
> the vendor cost and lock-in audit (`documentation/audit/VENDOR-COST-LOCKIN-2026-10-04.md`, Lane C — on PR #2157 until it merges). Hail runs on free NOAA/IEM (default) or NCEI SWDI. After the deploy,
> Jo deletes the three deployed functions and the two secrets. Kept below as
> history only.

Wiring for [swathapi.com](https://swathapi.com) — storm-verified property
intelligence. Radar-**measured** hail events only (never forecasts), swath
polygons, per-property exposure reports, and webhook alerts for registered
coverage areas. One API key serves three CRM surfaces:

| Surface | Code | Turn on with |
|---|---|---|
| Hail history / D2D swath polygons | `functions/integrations/hail.js` → `fetchSwathHail` | `NBD_HAIL_PROVIDER=swath` |
| Parcel intel (owner, year built, roof age) | `functions/integrations/parcel.js` → `querySwathProperty` | `NBD_PARCEL_PROVIDER=swath` |
| `storm.verified` webhook → Slack + `storm_events/` | `swathWebhook` (integrations/swath.js) | register a monitor (below) |

Plus two admin callables: `getSwathReport` (quote-first per-property
exposure report) and `getSwathUsage` (month-to-date credit meter).

## 1. Sign up — Jo does this, key is shown ONCE

```bash
curl -X POST https://swathapi.com/v1/signup \
  -H "content-type: application/json" \
  -d '{"email": "YOUR_EMAIL"}'
```

The response contains the API key (`sk_…`). **It is shown exactly once and
cannot be retrieved later** (only replaced via email recovery at
swathapi.com/recover). Paste it straight into Secret Manager — never into
chat, the repo, or anything under `docs/`:

```bash
firebase functions:secrets:set SWATH_API_KEY
```

Free plan: 100 credits/month, **hard-stops** when exhausted (no overage),
and property data is served **from cache only** — full live parcel
coverage needs a paid plan. Paid tiers continue as metered overage
($0.008/credit developer, $0.005 scale).

## 2. Register a coverage monitor (webhook alerts)

```bash
curl -X POST https://swathapi.com/v1/monitors \
  -H "Authorization: Bearer sk_..." \
  -H "content-type: application/json" \
  -d '{
    "name": "NBD territory",
    "bbox": [-85.2, 37.5, -83.7, 38.5],
    "hail_min_in": 1.0,
    "webhook_url": "https://us-central1-nobigdeal-pro.cloudfunctions.net/swathWebhook"
  }'
```

(bbox is `[W, S, E, N]` — the example above is a Lexington-ish box;
adjust to the real coverage area.)

**Save the returned `webhook_secret` the same way:**

```bash
firebase functions:secrets:set SWATH_WEBHOOK_SECRET
```

When a verified storm crosses the box, Swath POSTs one `storm.verified`
event (HMAC-signed `X-Swath-Signature: t=<unix>,v1=hex(hmac_sha256(secret,
t + "." + body))`, retried with backoff). Our receiver verifies the
signature (±300s replay window, fails closed when the secret is unset),
ingests idempotently into `storm_events/{stormId}`, and pings Slack.

No webhook? Pass `"email_alerts": true` instead of (or alongside)
`webhook_url` and Swath emails the **account owner's address only** —
there is no recipient field.

## 3. Flip providers (optional, env not secret)

```bash
NBD_HAIL_PROVIDER=swath     # D2D hail lookups use Swath (NOAA auto-fallback)
NBD_PARCEL_PROVIDER=swath   # parcel lookups use Swath (Regrid fallback if configured)
```

Both default off — with only the key set, nothing changes until the env
flips. The nightly `hailMatchCron` **never** uses Swath regardless of the
flag (a 500-lead sweep would burn the whole month's credits — deliberate,
see `functions/integrations/hail-cron.js`).

## Credit model — why the code is stingy

| Endpoint | Credits | Our guard |
|---|---|---|
| `GET /v1/storms` | 1 | 6h Firestore cache keyed on rounded coords (`swath_hail_cache/`) |
| `GET /v1/swaths/{id}/geometry` | 1 | permanent cache (`swath_geometry_cache/`), max 3 fetches per lookup |
| `GET /v1/swaths/{id}/properties` ★ report | 1/property returned (10 min) **+25 per fresh-fetched record** | quote-first: `getSwathReport` without `confirm:true` returns the 1-credit quote; pulls cached 30 days (`swath_reports/`) |
| `GET /v1/swaths/{id}/properties/quote` | 1 | — |
| `GET /v1/property` | 2 | shared 90-day `parcel_cache/` |
| `GET /v1/usage` | 1 | admin-only, 10/hr limiter |

Failed requests are never billed. Rate limits: free 60/min. On 402/429 the
callables surface `resource-exhausted`; hail lookups auto-fall back to NOAA.

## Caveats / first-use verification

- **Field-name tolerance**: Swath's public docs pin response *semantics*
  (exposure `{hail_in, score}`, year built, county…) but not exact key
  spellings for `/v1/storms`. `normalizeStormEvent` / `normalizeSwathParcel`
  in `integrations/swath.js` pick across plausible spellings — after the
  first live call, check Cloud Logging + one response body and prune the
  normalizers to the real keys.
- Report pulls are **admin/company_admin only** (they spend the shared
  key's credits); reps get hail history through the cached `getHailHistory`
  path. Loosen deliberately if reps need direct report access.
- Swath also ships an MCP server (`https://swathapi.com/mcp?key=YOUR_KEY`)
  for Claude/Cursor/etc. The key rides in the URL — treat that URL as the
  secret itself; don't paste it into shared configs.

## Related

- [SECRET_ROTATION](SECRET_ROTATION.md) — add both Swath secrets to any
  future rotation sweep
- Session note: [SESSION-2026-08-06-swath-api-setup](../projects/SESSION-2026-08-06-swath-api-setup.md)
