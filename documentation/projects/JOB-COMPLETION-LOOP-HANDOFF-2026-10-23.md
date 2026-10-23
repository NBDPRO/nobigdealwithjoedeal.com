# Job-completion loop: handoff (2026-10-23)

Follows [JOB-COMPLETION-LOOP-RECON-2026-10-22](JOB-COMPLETION-LOOP-RECON-2026-10-22.md). All three items shipped as a card on the customer page; everything is draft-only, nothing sends, no new fields, no rules or flag changes.

## What shipped (PR order)

1. **Finished-job check card** (#2689): `docs/pro/js/job-closeout.js`, `docs/pro/css/job-closeout.css`, panel `#closeoutPanel` in `docs/pro/customer.html`. Five rows once a job is installed or finished: After photos, final invoice sent, balance collected (the shared paid-in-full rule via `ReviewEngine.paidInFullFor`), warranty certificate filed (`warrantyCertFiledAt`), review asked. Rows say Done / To do in text for screen readers.
2. **Warranty registration prompt** (#2699): shown while the warranty row is open. Names only GAF Certified #1162011 and TAMKO Pro Gold #181382; says nothing is filed or sent for the rep. The list is pinned by `tests/job-closeout-2026-10-22.test.js`; IKO, Owens Corning, Master Elite are banned there.
3. **Review-ask and referral-ask drafts** (#2709): pure `docs/pro/js/post-job-drafts-logic.js` plus two buttons on the card; text appears in read-only boxes with Copy. Test: `tests/post-job-drafts-2026-10-23.test.js`.

## Rules the code holds (each has a test)

- Review ask: after paid in full, once; same words for everyone; no rating gate, no incentive, no referral in it (FTC 16 CFR 465).
- Referral ask: a separate message, after paid in full and (review asked or warranty filed); the flat $100 the server credits (`REFERRAL_BONUS_USD`, credit at paid in full), at the Kentucky KRS 367.628(2) cap; never tied to a deductible, claim, insurer or discount; same wording on insurance jobs; never mentions a review.
- Text draft only with stored consent and no opt-out flag; ends with the STOP line; the rep is told 8am-9pm. No draft for do-not-contact leads or jobs marked finished after the fact. Sending stays in the CRM composer (`NBDComms`), which re-checks consent / STOP / unsubscribe and adds the email footer.
- Crews are independent subcontractors: no "in-house", W2, employee wording.

## Needs Jo

- **IKO.** `functions/agent-mcp-logic.js` (credentials list, ~line 572) still lists `IKO ROOFPRO Advantage` as confirmed (10-14). This lane's copy uses only GAF and TAMKO. If IKO is held, add it to `CREDENTIALS` in `job-closeout.js` (the test pins the list, so change both).
- No flags to flip: nothing here is behind one.

## Not done / next

- The drafts are copy-and-paste. Filing them as approve-first items in the Agent inbox (so a rep or Tucker can approve from the inbox) would need a server write path; not started.
- The card reads the invoice cache and photo list already loaded on the page; a job with no invoices loaded shows "…" rather than a false To do.
- A 1-year anniversary touch (`functions/anniversary-touch.js`) is still dry-run and rep-in-the-loop; not changed here.
