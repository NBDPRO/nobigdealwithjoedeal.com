# Business queue recon (2026-10-22)

Recon only, for the seven-item business-side queue. Method: `origin/main` at `4536ddc8`, the 10-19 project notes, and a grep of `docs/pro/` and `functions/`. No prod reads, no writes, no flags touched. Plan docs go stale, so each item is shrunk to its real gap. **Headline: items 1, 2, 3 and 4 were already built on 10-19 and ship dark; most of the queue is "Jo flips a flag", not new code.**

## Per item

| # | Item | What exists on main | Real gap | Plan |
|---|---|---|---|---|
| 1 | Lead-source attribution | Intake tags are right: `thumbtack_leads` bridges as source `Thumbtack` (`functions/lead-bridge-logic.js`), a repeat marketplace phone attaches to the old card (`phoneDuplicatePatch`) and keeps the old card's source. [LEAD-SOURCE-FIXER-2026-10-19](LEAD-SOURCE-FIXER-2026-10-19.md) (dark, flag `leadSourceFixer`) records Jo's confirmed source per paying customer and reports collected dollars per source. | The undercount is not a matching bug. Thumbtack sends only lead, message and review events (`classifyEvent`); there is **no hire event**, and a customer who finds NBD's Thumbtack profile directly ("Thumbtack direct", Jo's 11%) never arrives as a lead. So the intake source cannot see hires. The fixer's own follow-up is unbuilt: `confirmedSource` does not reach the agent `lead_sources` tool or Reports > Lead Sources. | One PR: feed `confirmedSource` (when set) into `lead_sources` / the Reports table, labelled "confirmed" vs "intake hint", collected only. Needs Jo to flip `leadSourceFixer` and answer the cards or it changes nothing. |
| 2 | Speed to lead | [SPEED-TO-LEAD-2026-10-19](SPEED-TO-LEAD-2026-10-19.md): one-tap Replied, outbound-call matching, median and p90 by source, inbox chip fix. Dark, flag `speedToLead`. | Built. Listed limits: no button on the inbox row, call matching only for the signed-in user's own `phone_calls`. | No PR. Jo flips `speedToLead`. |
| 3 | Estimate follow-up view | [ESTIMATE-FOLLOW-BOARD-2026-10-19](ESTIMATE-FOLLOW-BOARD-2026-10-19.md): grouped, opened-but-silent first, then value, with a projected total. Drafts only. Dark, flag `estimateFollowBoard`. | Built. Sorting is by value then quiet days. | No PR. Jo flips `estimateFollowBoard`. |
| 4 | Collected vs projected labels | `docs/pro/js/collected-revenue.js` (`NBDRevenue`) and `tests/revenue-collected-only-2026-09-28.test.js` pin the surfaces that carry a "revenue" label. | Surfaces added after 09-28 are not in that pin. | One audit PR if the grep finds a mislabel; otherwise a note. |
| 5 | Weekly job-margin review | Agent tool `job_profit` (Frank) gives per finished job collected minus direct costs and margin, server side. | No weekly note of jobs whose margin fell. "Fell" needs a baseline (see assumption). | One PR: a pure, tested function over the same `job_profit` rows, filed as an Agent-inbox report, CRM-internal only. Nothing under `docs/` public pages. |
| 6 | A2P status | Repo docs say the campaign went **Verified on 2026-10-19** ([MESSAGING-CONTROL-CENTER-2026-10-19](MESSAGING-CONTROL-CENTER-2026-10-19.md), [MESSAGING-HARDENING-2026-10-19](../audit/MESSAGING-HARDENING-2026-10-19.md)). The 10-13 packet is superseded: rejected 30909 twice, then fixed. | Not re-read live: that needs Twilio credentials, which this queue may not touch. | Report only, no PR. Texting stays gated by `messaging_controls/global` and the `integrations/sms.a2pApproved` flag; Jo flips those. |
| 7 | Review-request drafts | `functions/review-request-nudge.js` (nudges the rep after paid in full), `review-ask-auto.js` (gated, off), agent `review_sprint` plus Tucker's `draft_text` (drafts into the Agent inbox, owner sends). | Drafting path exists. Likely no new code. | Check the draft wording against the claim gate; no PR unless a gap shows. |

## Assumptions

- Item 5 baseline: a job's margin is compared with the company's trailing average margin on jobs finished in the prior 90 days, and a job is flagged when it is at least 5 points below. The reason shown is the biggest cost category as a share of collected. Money in cents. No cost or margin figure leaves the CRM.
- Items 1 and 5 only count collected money; anything not collected is labelled projected.

## Needs Jo

Flip `leadSourceFixer`, `speedToLead`, `estimateFollowBoard` in the Firebase console, then answer the Where-customers-came-from cards. Claude cannot write prod flags.

## Order of work

Recon PR (this note) → item 1 (confirmed source into lead_sources) → item 5 → item 4 audit → item 7 check. One PR at a time.
