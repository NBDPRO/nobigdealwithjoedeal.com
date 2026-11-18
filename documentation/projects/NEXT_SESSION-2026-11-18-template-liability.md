# Handoff 2026-11-18: template and liability overhaul (lane note)

> Lane note for the template / liability work. It is **not** the live brief: the current handoff stays whatever INDEX.md
> names. Nothing here is legal advice, and no customer-facing legal wording has shipped.

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

**Open when this note was written:** PR #3176, `docs/attorney-review-packet`, docs only. The packet is
`ATTORNEY-REVIEW-PACKET-2026-11-18.md` on that branch (about 13,800 words, 58 clauses, 42 attorney questions). It
becomes a normal INDEX link once #3176 merges. A Word copy was generated outside the repo (see "Not verified").

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
