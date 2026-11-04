# Google Business Profile — integration plan and read-only design (2026-10-22)

Design only. **Nothing here is built and nothing needs the API until Google
approves case 8-9748000042165** (project `nobigdeal-pro`, 717435841570,
requested 2026-09-27). Part of [storm-demand-recon-2026-10-22](storm-demand-recon-2026-10-22.md).

## Gate: how we know access is granted

Jo checks Cloud Console > APIs & Services > My Business APIs > Quotas: 0
requests/min = pending, 300 = approved (or the case email). Until then every
step below is blocked. Jo signs in himself for OAuth; no agent enters his
credentials, and no GBP secret is ever committed.

## Order of work once approved

1. Enable the My Business API family in the project; OAuth client; refresh
   token with scope `business.manage` (Jo, himself); look up account and
   location ids. Five `GBP_*` secrets
   (`functions/google-reviews.README.md`). **Jo's steps, in the console.**
2. Deploy only `syncGbpReviews` + `getGoogleReviews` (already written,
   dormant). Verify one sync reads back newest-first. Rollback = delete
   `siteContent/googleReviews`.
3. Then the read-only additions below, one PR each.

## Read-only reviews design (extends what exists)

Reviews already flow to `siteContent/googleReviews` (public strip, hide list,
newest-first). Add, server-side only:

- Keep the **unreplied count and oldest unreplied age** (reviews with no
  `reviewReply`) in a company-scoped doc written only by the sync function.
- CRM surface: a count on the reputation screen ("3 reviews have no reply").
  **Replying is a write and stays out of scope**; Jo replies in Google.
- Reviewer names are already public on Google; store display name + rating +
  text + time only. No reviewer id mapping to CRM leads.
- Review-ask loop (`review-ask-auto`) stays as is; this only adds visibility.

## Read-only insights design

Business Profile Performance API (verify exact method and metric names
against the live docs at build time):

- Daily metrics time series per location: search and Maps impressions, call
  clicks, website clicks, direction requests.
- Monthly search-keyword impressions.
- A nightly scheduled function (heartbeat-wrapped like the other jobs) pulls
  the last 35 days and writes **aggregates** (per-day counts) to a doc only
  the server writes (`companies/{id}`-scoped or `siteContent`; rules deny
  client writes). Owner/admin reads through a callable, or the doc rule is
  owner-read-only. Any rules change needs the security review first.
- Tie-in with `lead_sources`: compare GBP call clicks with the Call Center's
  Google-sourced calls. Aggregates only, no per-person data.
- Tenant note: another tenant would need its own OAuth consent. Single-tenant
  (NBD) first; do not generalise until asked.

## Not in scope / risks

- Posting to GBP (`social-adapters.js` adapter) stays off (`SOCIAL_GBP_ENABLED`).
- Review gating or incentives: FTC rules; the ask stays neutral.
- Quota is low by design (300 QPM); one nightly pull is far under it.
- Refresh-token revocation: sync logs "not configured"/auth failure and exits;
  surface a heartbeat warning rather than failing silently.
