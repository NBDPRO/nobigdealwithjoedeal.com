# Live checks after deploys (2026-11-26)

Follow-up 6 of the ten Joe approved after the
[web-leads Turnstile outage](../audit/WEB-LEADS-TURNSTILE-OUTAGE-2026-11-25.md).
These are checks against the live site after the /roof-check merge (#3259, #3263)
and the guide "Email me a copy" box (#3272) deployed. Nothing was fixed here. The
two real submits ran with Joe's OK, using NBD's own phone line and the jd@ inbox,
and each CRM lead was soft-deleted afterwards.

## Results

| # | Check | Result | Evidence |
|---|---|---|---|
| A1 | #3263 deploy green | Pass | Run 45844893010 was cancelled by deploy concurrency. The run that replaced it, 45853671581 (commit `69db268f6`), contains `37bfe42ae` and every job passed. #3259 deployed in run 45735712765. |
| A2 | Old storm tool URLs 301 to /roof-check | Pass | `/storm-check`, `/roof-score` and `/storm-report`, each extensionless, `.html` and with a trailing slash: all 9 return 301 to `/roof-check`. |
| A3 | `/roof-check` live | Pass | 200 |
| A4 | `/book` moved | Pass | `/book`, `/book/` and `/book/index.html` 301 to `/inspect#other-visits`. `/book.html` is 404, but that URL never existed (the old page was `docs/book/`), so it is not a regression. |
| A5 | Homepage footer links /roof-check | Pass | 1 footer link |
| B | Real /roof-check submit, end to end | Pass, with findings 1 to 3 | 801 Plum St, Cincinnati; phone 859-420-7382; email jd@; texting box unticked. `submitPublicLead` 200 → `inspect_leads/zm1KEjgFPg4MvQ7vZViH` (source `/roof-check`, story `ROOF CHECK \| 892 events/5yr …`) → CRM `leads/inspect_leads__zm1KEjgFPg4MvQ7vZViH` ("Website — Inspection / Storm tool", stage new). Lead alert `alert_outbox/AGTamIReHQO9kzPKEpWk`: email sent, push sent, SMS `skipped:no-target`. Storm-report email held: `reportEmailHeld: messaging_paused` (log reason `customer_sends_off`, 17:06:01Z). CRM lead soft-deleted 17:07:40Z and read back. |
| C1 | #3272 deploy green | Pass | Run 45871098934 (commit `c10cb7dd7`) was cancelled by concurrency. Run 45873991589 (commit `713f39cfa`) contains it and every job passed, including "Verify live site matches main". |
| C2 | Real guide "Email me a copy" | Partial pass: the PDF was not checked (finding 1) | `/guides/compare-roofing-quotes-checklist`, jd@, storm-tips box unticked. `guide_copy_requests/WoJIBjZ83sa6oGillQqw` (`emailConsent: false`) → CRM `leads/guide_copy_requests__WoJIBjZ83sa6oGillQqw`, source "Website — Guide copy", notes "Cold lead: no alert was sent". No `alert_outbox` row, so no alert text. `guideCopyEmail` logged "held, customer messaging paused" (`customer_sends_off`, 19:32:41Z) and set `guideEmailHeld: messaging_paused`. No Resend id exists, so the PDF attachment is unverified. CRM lead soft-deleted 19:33:42Z and read back. |

## Findings for Joe

1. **Customer email is paused, so neither homeowner email went out.** The
   kill switch reads `customer_sends_off`. While it is off, the /roof-check
   storm report and the guide PDF are stored as held, and the homeowner never gets
   them. Once it is back on, re-run C2 to check that the PDF is attached.
2. **The guide page says "Done. The PDF is on its way to your inbox"** even while
   the email is held. With sends paused, that is not true for the visitor.
   Nothing was changed.
3. **Lead alert texts are skipped: `skipped:no-target`.** The alert email and
   push went out, but no alert text did, on this submit and on the two before it
   (2026-11-24 and 2026-11-25). The cause was not checked here.
4. **The /roof-check lookup took about 24 s on a cold start.** That is under the
   page's 60 s timeout, but the spinner gives no sign of progress for that long.
5. **AI result wording.** The /roof-check result text mentioned working with
   the adjuster ("The claim is yours to decide"). Worth checking against the
   Kentucky insurance-job wording rules.
