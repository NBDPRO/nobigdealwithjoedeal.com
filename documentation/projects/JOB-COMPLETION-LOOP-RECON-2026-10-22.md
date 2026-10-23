# Job-completion loop: recon (2026-10-22)

Scope: what happens after a job is installed: finished-job checklist, warranty
registration, review ask, referral ask. Read from `origin/main` (4536ddc8). Nothing
here sends anything; the loop stays draft-only. Sibling session `business-queue`
owns generic drafts and the `review_sprint` tool; this lane owns the post-job moment.

## What already exists (do not rebuild)

| Piece | Where | State |
|---|---|---|
| Per-job checklist | `docs/pro/js/customer-checklist.js` (`lead.jobChecklist` + real `*FiledAt` gate fields) | Live. Insurance list ends `ins-collect`, `ins-warranty-cert`; cash list ends `job-walkthrough`, `job-collect`, `job-review`. No photo or final-invoice item on the cash list; no "finished" roll-up. |
| Warranty certificate | `docs/pro/js/warranty-cert.js`, `lead.warranty`, `lead.warrantyCertFiledAt` | Live. This is NBD's own workmanship certificate (tier from the signed estimate). Nothing prompts the rep to file it when a job finishes. |
| `post_job` agent tool | `functions/agent-mcp-logic.js` `postJob()`, `agent-mcp.js:318` (Tucker, Frank) | Live, read-only: days since finish, balance owed, `review_requested`, `warranty_tier`, anniversary flag. No photo / final-invoice / referral fields. |
| Paid-in-full rule | `functions/paid-in-full.js`, mirrored in `review-engine.js` | The single definition of "money collected"; everything below keys off it. |
| Review ask, rep nudge | `functions/review-request-nudge.js`, `docs/pro/js/review-engine.js` | Live. Bell + prefilled SMS/email, 3-21 days after payment received. |
| Review ask, automatic | `functions/review-ask-auto.js` + `-logic.js` | Email behind `REVIEW_ASK_AUTO_EMAIL_ENABLED`, text behind `REVIEW_ASK_AUTO_TEXT_ENABLED` (dark until A2P). One ask per job, no rating gate, no incentive. |
| Review sprint | `review_sprint` tool, `draft_text` / `draft_email` | business-queue's lane. |
| Referral program | `functions/referral-rewards.js` (`REFERRAL_BONUS_USD = 100`, credit at paid in full, not at "Closed" as the older docs say), `docs/pro/js/referral-rewards-ui.js`, `review-engine.js` code mint | Live. The rep's SMS already appends the homeowner's own referral link to the review ask. |
| 1-year touch | `functions/anniversary-touch.js` | Dry-run flag; rep-in-the-loop only. |
| Company doc expiry | `functions/company-doc-expiry*.js` | Tracks NBD's own COI / license / manufacturer cert dates; unrelated to customer warranty. |

## Gaps (this lane)

1. **No "is this job really finished" view.** Photos, final invoice sent, balance collected and warranty filed live in four places. `post_job` shows two of the four.
2. **No warranty-registration prompt.** The checklist row exists only on insurance jobs; a cash job never asks for it. No copy names the manufacturer registration, which is where the GAF / TAMKO credentials actually matter.
3. **The referral ask is welded to the review ask.** One SMS asks for a review and a referral together. There is no separate ask after the review lands or after the warranty is filed, and no draft the rep can edit.
4. **Kentucky referral cap is not enforced anywhere.** SB 153 / KRS 367.628(2): on a Kentucky insurance-paid job, nothing over $100 may go to the insured, referral fees included. `REFERRAL_BONUS_USD = 100` sits exactly on the cap, so today it is legal only because it is flat. Any copy or future change must keep it at or under $100, and a referral credit must never be framed as a deductible discount.

## Conflicts found (for Jo, not changed here)

- `functions/agent-mcp-logic.js:572` lists `IKO ROOFPRO Advantage` as a confirmed credential (Jo, 2026-10-14). The brief for this lane, and the 2026-10-07 memory, say IKO is applied-for. This lane's copy uses only **GAF Certified #1162011** and **TAMKO Pro Gold #181382** until Jo says IKO is held.
- Older docs and the skill text say the referral credit fires "on Closed"; code credits at **paid in full**. Copy here follows the code.

## Plan (one PR at a time, rebased, enqueued only when green and CLEAN)

1. **Finished-job checklist.** A pure module (`job-closeout-logic.js`) that turns a lead, its invoices and its photo count into five rows: photos, final invoice, balance collected, warranty filed, review asked. A card on the customer page shows it when the job is won and installed. No new Firestore fields, no rule changes.
2. **Warranty registration prompt.** A rep-facing prompt and a customer-facing draft that names only GAF Certified and TAMKO Pro Gold, and only when the job's materials are that manufacturer's.
3. **Review-ask and referral-ask drafts.** Drafts only, filed for the rep to send; consent, STOP/HELP, quiet hours 8am-9pm, CAN-SPAM footer. Referral draft: separate from the review ask, after the review is left or the warranty is filed; a Kentucky insurance job gets the flat $100 wording with no deductible language; the review ask is never conditioned on rating or on the referral.

Held until Jo flips the flags: any automatic send. Crews are independent subcontractors in every line of copy.
