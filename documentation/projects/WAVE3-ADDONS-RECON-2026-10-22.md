# Wave 3 addons recon (2026-10-22)

Recon only: three small CRM addons (weekly owner digest, receipt capture polish, Cal.com phone). Method: `origin/main` at `4536ddc8`, the business-queue recon ([BUSINESS-QUEUE-RECON-2026-10-22](BUSINESS-QUEUE-RECON-2026-10-22.md), PR 2668), and a grep of `docs/pro/` and `functions/`. No prod reads, no writes, no flags. **Headline: item 3 is already fixed and tested, item 2 is already built, item 1 is mostly built; one small real gap remains.**

## Per item

| # | Item | What exists on main | Real gap |
|---|---|---|---|
| 3 | Cal.com phone | `functions/integrations/calcom-logic.js` `resolveAttendeePhone` reads, in a fixed priority order, `attendees[0].phoneNumber`, `responses.attendeePhoneNumber`, `responses.phone`, `attendees[0].phone` and the phone-call location value, records the winner as `phoneSource`, and never takes the organizer's phone. `tests/calcom-webhook-payload.test.js` covers the documented payload, the legacy `attendees[0].phoneNumber` shape and the no-phone case. The memory note "attendees[0].phoneNumber" is the OLD single-field read, not the current handler. | None in code. The header of `calcom-logic.js` says no real BOOKING_CREATED body was ever captured; the tests use documented shapes. A real payload can only come from the Cloud Logging `phoneSource` breadcrumb (prod read, not done here). **No PR.** |
| 2 | Receipt capture polish / Lowe's nudge | `docs/pro/js/lowes-import.js` (flag `lowesImport`, idempotent `lw-o-<order>` keys, shares the Home Depot matcher), the receipt sorter queue, and `docs/pro/js/receipt-health.js`, whose "costs missing" panel already lists finished jobs with no direct cost (it counts any supplier, so Lowe's receipts count). `week-review.js` also lists "costs needed" per won job with a one-tap add. | The nudge exists per job. Nothing Lowe's-specific is missing. **No PR.** |
| 1 | Weekly owner digest | `functions/weekly-digest.js` (Mon 07:00 ET, `WEEKLY_DIGEST_ENABLED` unset = dry run) emails each rep: new leads, wins (booked value, labelled projected), losses, pipeline, top leads. `#/weekreview` (`week-review.js`, Sunday review) is the in-app owner page: cash collected, wins labelled projected, win rate, stuck deals, data gaps. | The Monday summary has no **estimates awaiting signature**, **calls to return** or **jobs this week**, and nothing lands in the **Agent inbox** for the owner (the email is per rep and goes out only if Jo flips the gate). One PR: a pure tested function over the same stage-role, `phone_calls` and jobs rules, filed as an `agent_inbox` report of kind `report` for the owner, CRM-internal, no email, no text. |

## Plan for the one PR (item 1)

- Pure module under `functions/` (stage roles from `stage-roles.js`, jobs from `jobs-logic.js`, money in cents, collected revenue from payments only; projected labelled "projected"). Clock tests fake Date, ET week boundaries.
- Filed through the existing Agent-inbox item shape (`{ kind: 'report', title, text }`, see `agent-mcp-logic.js`). Gated by a new dark flag; absent = off.
- No overlap with business-queue item 5 (weekly job-margin note from `job_profit`): this digest carries no cost, margin or profit figure.
- Open questions for Jo: owner-only recipient (solo owner uid / `companyId`) and whether it should replace the rep email or sit beside it. Default: beside it, owner only.

## Queue note

The first PR waited while the open-PR count was above the overnight limit; the parent raised the limit to 12 on 2026-10-23 and this went out as one PR (recon note plus the digest).

## Built (item 1): `ownerWeeklyDigest`, ships dark

- `functions/owner-weekly-digest-logic.js` (pure) and `owner-weekly-digest.js` (Monday 07:30 ET). Gate `OWNER_WEEKLY_DIGEST_ENABLED=true`; anything else logs counts and writes nothing. Jo flips it; Claude does not.
- Files `agent_inbox/ownerdigest_<company>_<monday>` (kind `report`) with `create()`, so a rerun or retry files each week once, plus one bell to the owner. No SMS, no email, no draft, no rep.
- Content: collected last Mon-Sun (payments by date received, refunds subtracted, cents); estimates awaiting signature (sent or opened, not accepted, customer not closed; labelled PROJECTED); calls to return (Call Center items, NBD owner account only today; other companies get no calls section); jobs dated Mon-Sun this week. No cost, margin or profit figure.
- Test: `tests/owner-weekly-digest-2026-10-22.test.js` (34 checks, positive and negative controls). Mutation run, all caught: collection window widened, signed-proposal filter removed, closed-customer filter removed, `create()` swapped for `set()`, dry-run guard removed.
- Does not touch `weeklyDigest` (the rep email, still dry-run) or the margin note.
