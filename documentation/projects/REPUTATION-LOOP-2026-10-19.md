# Reputation - who was asked for a review, what was posted, what needs a reply (2026-10-19)

Plan 4, phases 1-2. Ships **dark** behind `reputationLoop`. Plan: Agent Hub > NBD > Plans > "Plan 4 - Review and Reputation Loop". Nothing here sends anything to a customer, posts anything public, or changes the review-ask email, the texting code or the messaging kill switch (`messaging_controls/global`).

**Flag:** `reputationLoop` in `feature_flags/_default` (or per user in `feature_flags/{uid}`). Absent or false = no button, no reads, no writes. Jo flips it in the Firebase console; reload the CRM afterwards (flags cache up to 10 minutes).

## Review-gating audit (done first; FTC consumer review rule 16 CFR 465 and Google's review policy)

Question: does anything screen who is asked for a review, or steer unhappy customers away from the public review?

| Surface | What it does | Gating? |
|---|---|---|
| Customer-portal rating card (`docs/pro/js/portal.js` card, `functions/portal.js` `submitCustomerRating`) | Shows the public Google review button **before** any rating, to everyone. The private 1-5 star rating is optional. After a rating the server returns the same `googleReviewUrl` for every star count and the portal renders the button in both the 4-5 and the 1-3 thank-you branch. | **No.** Fixed 2026-10-15 (comments in both files say so). |
| The "4-5 star review nudge" comments in `dashboard-bootstrap.module.js` (lines ~4848, ~4892) and `review-engine.js` (~132), and the header comment of `submitCustomerRating` | Old wording from before 2026-10-15. They describe a nudge that no longer exists in that form. | Stale comments only. Not edited here (no drive-by comment edits); worth a one-line cleanup PR. |
| Automatic ask (`functions/review-ask-auto.js` + `-logic.js`) | Daily 10:00 ET sweep, paid in full, money received 3-21 days ago, one ask per job. Eligibility reads payment dates, `deleted`, lost stage, quiet backfill, DNC and prior ask. It never reads `customerRating`, any sentiment or any private feedback. Email says "Honest feedback, whatever it is". | **No.** (`tests/reputation-2026-10-19.test.js` pins that the logic file never mentions ratings or sentiment.) |
| Photo in the ask (`functions/review-ask-photo.js`) | Adds the customer's own before/after. Same email, same recipients. | No. |
| Rep nudge (`functions/review-request-nudge.js`) and review deck (`docs/pro/js/review-deck.js`) | Prompt a rep to ask a paid customer; the deck has a per-job **"Don't ask this one"** (`reviewAskDeclined`). | **Soft risk, see below.** |
| Reply copy | The portal low-rating message says the rep "will reach out within 24 hours to make this right" and also offers the public review link. | Not gating (the link is shown). Worth a counsel read: "make this right" next to a public review link can read as an exchange for a changed review. |

**Finding:** nothing screens who is asked and nothing routes unhappy customers away from the public review on the live path. The possible issue the plan flagged was already neutralised on 2026-10-15. **No live behaviour is changed in this PR**, so there is no flagged "neutral fix" to implement.

**Soft risk to decide:** the review deck's "Don't ask this one" lets a rep skip a customer by hand. A rep who skips only unhappy customers is selective solicitation (Google's policy). The automatic ask ignores `reviewAskDeclined`, so the daily sweep still asks that customer; the rep nudge and the agent tools respect it. The Reputation screen shows these as **Marked "don't ask"** so the owner can see them. Suggested rule if Jo wants one: keep the button only for real do-not-contact reasons (already covered by `doNotContact`), or require a reason. Not changed here.

## What the screen does

CRM board toolbar, **Reputation** (owner / company_admin / platform admin only; a red count on the button when a low review is unanswered).

- **Finished + paid list.** A lead is listed when it has at least one live invoice, money actually collected (payments minus refunds above zero, `NBDRevenue.paymentsOf`), and no live invoice still owed. A lead with no payment is never listed, so it can never read "asked".
- **Ask status is read, not duplicated,** from the existing stamps: `reviewRequested`, `reviewRequestedAt`, `reviewRequestSource`, `reviewAutoAsk`. Chips: Asked (date, channel), Sending, Ask did not send (reason), Marked "don't ask", Not asked yet.
- **Counts:** asked this month, paid jobs asked / paid jobs, reviews logged, the owner's logged average. A "asked more than 14 days ago, nothing logged" line (a list to check by hand; no re-send).
- **Got a review:** platform (Google, Yelp, Thumbtack, Other) + stars, ten seconds. **I replied** flips a flag. **Undo log** clears it. Nothing is ever auto-matched.
- **Low-rating alert (Jo only, inside the CRM):** any logged 1-3 star review not marked replied raises a red banner in the screen and a count on the toolbar button. The text is a count only ("2 reviews need your reply"), with no name or address. No server write, no customer message, no public post. (The agent-inbox note in the plan was left out: it needs a server writer; the in-CRM banner covers the same need with no new send path.)
- **Reply drafts** (5 stars, 3-4 stars, 1-2 stars) in Jo's voice with the reviewer's first name; copy to clipboard and paste into the review yourself. No claim, coverage or insurance wording, no promise, no job detail.
- **Google strip:** `/api/google-reviews` (Places, live: 5.0 stars, 29 reviews, newest 5 readable). `functions/gbp-reviews-sync.js` stays dormant until Google approves the Business Profile API request (case 8-9748000042165). Yelp and Thumbtack have no free review API: log by hand.
- **Compliance lines on screen:** ask every paid customer the same way; never offer anything; never ask anyone to change or remove a review; the alert is yours only.

## Data

`review_log/{leadId}` (one doc per lead): `{ companyId, leadId, reviewSeen, platform, rating, responded, updatedAt, updatedBy }`. No review text, no reviewer name. `firestore.rules` (`match /review_log/{leadId}`): read and write only for a platform admin, a `company_admin` of the company, or a solo owner by uid; doc id = lead id, the lead must belong to the same company, exactly those eight keys, platform in the four, whole-star rating 1-5, `updatedBy` = caller, `updatedAt` = server time; "seen" needs a platform and rating; no delete (undo is a stamped `reviewSeen: false`).

**Why not a `reputation` map on the lead (the plan's wording):** the first build did that and the lead update rule hit Firestore's 1000-expression limit on denied writes (8 of the 30 existing `confirmedSource` rules checks, baseline 0). That rule is close to the budget for real edits too, so the map moved to its own collection and `leads` rules are untouched. The plan's `askStatus / askedAt / channel / reviewLink` fields are derived from the existing stamps, not stored.

## Tests

- `tests/reputation-2026-10-19.test.js` (98 checks): permissions, paid detection against the real ledger, ask status per stamp, counts, alert (1-3 only, unreplied only, owner only, count-only text), template and screen-copy wording with a control that proves the check can fail, the real module in a vm sandbox (flag off / non-owner = no render, no read, no write; flag-on positive control), the portal audit pins, source guards (no new send, one write site, only the Google fetch). 14 mutants tried, 14 caught.
- `tests/firestore-rules.reputation.test.js` (50 checks, emulator; CI step added): who may read/write, shape, tenant, no delete, positive controls. 8 rule mutants tried, 8 caught.
- `tests/dashboard-boot-budget-2026-10-03.test.js`: +1 deliberate deferred script.

## Not built (later phases)

Weekly digest, Yelp/Thumbtack rating trend, GBP sync + match-confirm, response-time metric, reviews widget past the 5-review cap, the one-by-one "never asked" past-customer drafts (needs Jo's approval of each; a separate piece of work).
