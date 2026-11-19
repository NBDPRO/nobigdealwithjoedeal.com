# Handoff 2026-11-18: template and liability overhaul (lane note)

> Lane note for the template / liability work. It is **not** the live brief: the current handoff stays whatever INDEX.md
> names. Nothing here is legal advice, and no customer-facing legal wording has shipped.

## Update 2026-11-19 (end of the long session; supersedes the "What is NOT done" table below)

**Shipped since this note was written (merged; flags dark except where noted):** phase 2 clause wording on every signing path (flag `docClauseSetV1`, **ON for Jo's account only**, with `docEvidenceFoundation`), phase 3 attic acknowledgment and gate (`docAtticAckV1`, **OFF**), the payment-terms settings panel, the sign-link panel with QR, text and copy (#3207, flag `docSignPanelV1`, **OFF**), contract and e-sign PDF layout fixes, and the CI budget raise (#3191). Docs: [CLAUSE-SET-V1](CLAUSE-SET-V1-2026-11-18.md), [ATTIC-ACK-V1](ATTIC-ACK-V1-2026-11-18.md), [SIGN-LINK-PANEL](SIGN-LINK-PANEL-2026-11-18.md), [attorney packet](ATTORNEY-REVIEW-PACKET-2026-11-18.md) and [answer sheet](OPEN-ITEMS-ANSWER-SHEET-2026-11-18.md).

**Merged 2026-11-19 (all dark, nothing turned on for anyone):**

| PR | What |
| --- | --- |
| #3207 | Sign-link panel (QR, text, copy, email, new link), flag `docSignPanelV1` |
| #3209 | Card fee rules (`computeCardFee`, receipt and invoice line, refund math), flag `docCardFeeV1`. **No fee is charged:** Stripe cannot tell credit from debit before the card is entered, so a funding-aware path needs a PaymentIntent and Payment Element pay page (about 5 to 8 working days); `cardFeePct` must stay 0. See [CARD-FEE-V1](CARD-FEE-V1-2026-11-18.md) |
| #3210 | Attic gate security fixes, seven review rounds. The form is now parsed with parse5 (direct dependency) and every check runs on the tree. Accepted residual: extra wording not in the canonical list, and mismatched label wording. See [ATTIC-ACK-V1](ATTIC-ACK-V1-2026-11-18.md) |
| #3212 | Five templates (property condition, decking authorization, emergency request, final walkthrough, Ohio insurance acknowledgment) behind `docClauseSetV1`, with server verification. Every new sentence is marked DRAFTER WORDING. See [PHASE5-TEMPLATES](PHASE5-TEMPLATES-2026-11-18.md) |
| #3213 | Paper-upload certification (`attestWetSigned`), signable supplement/inspection/warranty docs, co-owner signer, in-person consent tick, behind `docClauseSetV1`. See [PAPER-CERT-SIGNERS](PAPER-CERT-SIGNERS-2026-11-18.md) |

**Hard gate (unchanged):** `docAtticAckV1` stays OFF until Jo says go. The last review's verdict: an owner-only dry run on the Kentucky cash and Kentucky insurance test leads is reasonable; residual risk is a rep hiding wording through styling or padding extra wording, not forging a tick. Before turning on `docClauseSetV1`-gated paper certification for any other account, note the reviewer's flag-off residual: a user with the flag explicitly false can still upload a paper copy as `signed`.

**Still open, in order:**

1. Merge the four branches (each: merge `main`, run the node bucket in parallel, security review for server and rules changes, PR into the queue).
2. Browser verification on the TEST lead: Ohio cash, Kentucky insurance, invoice, the "By: Joe Deal, Manager" caption. The customer page froze the browser renderer on the long contract preview; use a fresh tab and expect it to be slow.
3. Delete the two TEST leads (`TEST Do Not Contact`, 100 Test Lane Campton KY, and `TEST reverse payment`) and the saved test contract and task.
4. Attic flag dry runs on Kentucky cash and Kentucky insurance test leads, confirm `atticFreeCheckDays` (default 3), then Jo's go-ahead for the flag write on his account only.

**Backlog, approved but unbuilt:** signed-copy email to homeowner and rep (Q50), estimate and deal "Send to homeowner" QR panel (Q59), 14-day links with email reminders (Q61), server-only `signed` status (Q65), signing packet (Q66), booking-confirmation attic heads-up (Q70), Kentucky insurance deal-page attic route check (Q72), and a clause cross-reference wording item for the attorney list (Q87).

**Jo only:** send the attorney packet; Kentucky assumed-name filing and the Ohio foreign-LLC question; supplier restocking percent and return terms; baffle and duct retail prices (proposed $25 and $450) and the $100 per sheet decking price; notify the card processor before the first surcharge; archive the session by hand when the queue is empty.

**Open counsel questions added this session:** link-only signing links let a rep sign as the homeowner; the in-person gate remains advisory; card-surcharge law in Ohio and Kentucky is not researched.

## What this lane did (2026-11-17 to 11-18)

Jo asked for a deep sweep of every document template for liability gaps, an attic / ventilation / moisture sign-off
before re-roofs, payment terms (late fees, restocking, a 3% card fee), and then to build "the most defensible" version.
Method: grill Jo on every decision, audit the 36 templates, write the drafts, build in phases behind a flag.

**Merged:**

| PR | What |
| --- | --- |
| #3161 | Removal-only honesty fixes to the templates (14 of 15 items; no new legal wording). New suite `template-honesty-removals-2026-11-17`. |
| #3167 | The sweep note, [TEMPLATE-DEEP-SWEEP-2026-11-17](TEMPLATE-DEEP-SWEEP-2026-11-17.md): decisions log, audit (Part 5A-C), build plan (Part 7). |
| #3173 | Phase 1, ships dark: versioned clause registry, server-written signing evidence on every path, fail-closed send checks behind the per-user flag `docEvidenceFoundation` (**default OFF**). See [CLAUSE-EVIDENCE-FOUNDATION-2026-11-18](CLAUSE-EVIDENCE-FOUNDATION-2026-11-18.md). |

**Update 2026-11-18 (later):** PR #3176 (the attorney packet, `ATTORNEY-REVIEW-PACKET-2026-11-18.md`, about 13,800
words, 58 clauses, 42 attorney questions) and this note's own PR #3178 both merged. Jo sends the packet to the
attorney. A Word copy was generated outside the repo (see "Not verified"). Phase 2 (`docClauseSetV1`, clause set on the
contract, e-sign PDF and deal page, ships dark) was built on `feat/clause-set-v1` and was in review fixes; check
whether it merged. The signing-ease lane (Q48 to Q68 in the sweep note) and the payment-terms settings screen follow it.

## Where the decisions live

Everything Jo decided is in the sweep note's **Decisions log** (Q1 to Q47), not repeated here. The ones most likely to
be second-guessed: attic form is an *acknowledgment, never a waiver*, with a signed "not inspected" page; late interest
8% simple after 15 days, mutual fees, right to pause (roof weather-tight first); card fee 3% on **credit cards only**
(never debit/prepaid, none on Kentucky insurance jobs, capped at processor cost); restocking **lesser of 15% or the
supplier's actual charge**, plus actual reverse delivery; hidden decking about $100/sheet flat up to 10 sheets (price
unconfirmed); legal party **No Big Deal Solutions LLC (Kentucky) d/b/a No Big Deal Home Solutions**, signed by Joe Deal,
Manager.

## What is NOT done (the build plan, sweep Part 7)

| Phase | What | State |
| --- | --- | --- |
| 2 | Print the clause wording on every signing path (contract, e-sign PDF, deal page, in-person), state-aware, behind the flag | not started; first phase that prints new legal wording, so the attorney should see it first |
| 3 | Attic form and gate: estimate scope field, rep attic panel, reason codes, hard gate on full re-roofs, catalog lines (decking per sheet, soffit baffle, bath-fan duct) | not started; blocked on Jo's prices |
| 4 | Terms of Payment section, credit-card fee on Stripe **credit** cards only (check `funding`), invoice and Payment Agreement point to the contract, wire line, cash receipt | not started; the stray "A convenience fee may apply." and the 1.5% finance-charge text are still live in the invoice and Payment Agreement |
| 5 | Property condition, decking authorization, emergency tarp request, final walkthrough and punch list, Ohio insurance acknowledgment | not started |
| 6 | Attorney review, then turn the flag on for new contracts | waiting on Jo to send the packet |

## Known residuals before the flag can ever be turned on

From the three security reviews (the last said "reasonable to push dark", nothing Critical or High):

- **NEW-1 (Medium, accept or fix first):** a rep can swap the deal-room page after mint, defeating the mint-time gap check; acceptance records `pageChangedSinceMint` but does not refuse.
- Low: placeholder hidden by data-URL stripping on a >2 MB document; a narrow remote vs in-person evidence write race; a stale `evidenceRefused` race; 16 MB read cap memory cost.
- The flag is per calling uid, not per tenant. Keep it off for other tenants (there is no company-profile field for `entityName` yet).
- NBD's `mailingAddress` default is blank on purpose: with the flag on, NBD contracts are refused until Jo sets it.
- Nothing yet re-stamps a row from the token, and no UI shows `evidenceRefused`.
- Older gap, out of scope: a rep can still mark a document `signed` client-side. In-person evidence proves the rep's device and time, not that a homeowner signed.
- Emulator rules test output was not independently re-run by the main session; CI is the authority.

## Left alone on purpose (for Jo)

Four items the removal PR did not touch because they were not on the approved list: the signature caption
"Joe Deal - No Big Deal Home Solutions" on the warranty; the preflight default "Final walkthrough passed." on the
completion certificate; the company-intro preflight default "Insurance Claim Assistance"; the care-plan line "cancel
anytime ... or by calling or texting Joe". All are deletions; recommended.

## Only Jo can supply (each blocks something)

1. Retail prices: decking per sheet, soffit baffle, bath-fan duct re-route (blocks phase 3 lines; the form hides unpriced lines).
2. Supplier restocking percentage and return terms (the packet's MAT-1 clause).
3. Register the **assumed name** "No Big Deal Home Solutions" with the Kentucky Secretary of State (about $20, five years, plus a county clerk step). Ohio foreign-LLC / trade-name registration is an open attorney question (never researched).
4. A **mailing address** in the company profile.
5. Send the attorney packet (and book the attorney).

## Not verified, or worth knowing

- The Word copy of the packet was built with the `docx` library and passes the validator, but its pages were **never rendered** (no LibreOffice here); eyeball the section 4 matrix.
- The packet and the audit are **source reads**; no renderer was run for the template audit. Reconfirm each fix in the app.
- Card-surcharge state law was **not researched** (the vendor guide's "ORC 113.40" cite looks wrong); Kentucky assumed-name law was read from secondary sources only.
- The stock node runner exceeds its 8-minute cap on a loaded machine; agents ran the bucket in parallel. `communication-log-contract` failed with "Method Not Allowed" from an external server and looks unrelated; it was not compared against `main`.
- A conflict-resolve script once failed its own assertion but a `;` let the commit run, committing conflict markers in a **local** merge commit (never pushed, fixed next commit). Use `&&` through the commit, and run `git grep -nE '^(<<<<<<<|>>>>>>>) '` before committing a merge.
- Auto-merge turned itself on for PR #3161 after Auto-fix was enabled; it was switched off. Check `get_status` after enabling Auto-fix.

## Housekeeping

Agent worktrees from this lane under `.claude/worktrees/` (`agent-a3dd5df1fab083663`, `agent-a21d5938cd64cee95`,
`agent-affcdce97277eb451`, `docs-sweep`, `handoff-1118`) hold merged or pushed branches and can be removed with
`git worktree remove` once #3176 merges. The shared main checkout was moved to another session's branch mid-lane; this
lane never worked in it after that.
