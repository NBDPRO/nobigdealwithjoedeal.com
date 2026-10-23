# Daily Success: "Today's business" tile (2026-10-23)

Fourth of five queued tracker features. Recon found the tracker cannot read company data (see below); Jo's overnight
authorization chose option A, a counts-only summary the CRM writes and the tracker reads.

## What shipped
- A **Today's business** card under the Today bar on today's tracker page: people to call back, follow-ups due, jobs today,
  with "as of 7:40 am". When there is nothing trustworthy it shows one line and an "Open the CRM" link, never a number.
- **CRM side (one small place):** `today-plan.js` `summaryForTracker(plan, uid, now)` builds `{ v, uid, asOf, calls,
  followUps, jobs }` from the SAME plan the CRM Today screen paints, so the numbers match it: calls are people (the Needs
  attention rule), follow-ups are promised + promises + estimates + stalled (one row per lead), jobs are today's appointments.
  `today-home.js` `publishToTracker` writes it to localStorage `nbd_today_summary` after each plan build, only when the leads
  loaded, the appointment read answered and no rule threw. A failed or still-loading read leaves the last good summary alone.
- **Tracker side:** `js/business-tile-logic.js` `read()` is the trust boundary: only a summary for the signed-in uid
  (`nbd_last_uid`), version 1, whole-number counts, stamped today and under 12 hours old is shown. Wrong uid, stale, future-dated,
  corrupt or missing all become "open the CRM", with no numbers. Storage reads are try/catch and the card renders without storage.
- **Purge:** the key starts with `nbd_`, is not in the keep-list, so `NBDAuth.purgeAccountStorage()` (sign-out and the
  shared-phone account switch from #2647) removes it. The test runs the real purge loop against a fake storage to prove it.
- No Firestore rules, auth or claims changes; no new Firestore reads in the tracker (the test greps for any).
- Files: `today-plan.js` + `today-home.js` (CRM), `js/business-tile-logic.js`, `js/business-tile-ui.js`,
  `css/business-tile.css`, phone rules in the last `<style>` block. Test: `tests/tracker-business-tile-2026-10-23.test.js`.

## Recon notes
- The tracker only reads `users/{uid}/ds_*` and `userSettings/{uid}`. Calls, follow-ups and the calendar live in company
  data behind `myCompanyId()` rules; reading them from the tracker would need a rules/security review, so it was not done.
- **Dead code, documented not deleted:** `daily-success/js/app.js` `buildCRMContext()` (the "CRM Pipeline Snapshot" card)
  reads localStorage `nbd_pipeline_cache`. Nothing in `docs/` writes that key (grep, 2026-10-22), so the card always says
  "Connect your CRM". Left as is (out of scope); a later cleanup can remove the card or point it at `nbd_today_summary`.
- Limit of option A: the tile is only as fresh as the last time the CRM Today screen ran on this device; hence the age label
  and the 12-hour / same-day cut-off.
