# Contract-language project: status (2026-10-22)

> **Research status only. Not legal advice.** Nothing in this note is contract
> language and nothing here authorises a change to a live template. The hard rule
> stands: **no clause ships to a customer or the site until the LegalShield attorney
> has reviewed it and Jo has signed off.** This note adds no clause text.

Jo's ask (2026-10-13): strengthen the contract language: lien rights, late fees after
completion, dispute defense, "every aspect". Research first, attorney before anything ships.

## What exists (all docs, merged)

| Piece | Where | State |
| --- | --- | --- |
| Law memo (OH/KY liens, interest, fee-shifting, consumer overlay, e-sign) | [KY-OH-CONTRACTOR-LAW-RESEARCH-2026-10-13](../audit/KY-OH-CONTRACTOR-LAW-RESEARCH-2026-10-13.md) | Done. Kentucky text verbatim; Ohio read through a summarising tool; case law mostly secondary |
| Inventory of every legal clause in the product (five signing paths, ~40 clause families) | [CONTRACT-LANGUAGE-INVENTORY-2026-10-13](CONTRACT-LANGUAGE-INVENTORY-2026-10-13.md) | Done |
| Strengthening plan: candidate clause set (11 families), 12 decisions for Jo (D1-D12), build map, 30 attorney questions (Q1-Q30) | [CONTRACT-STRENGTHENING-PLAN-2026-10-13](CONTRACT-STRENGTHENING-PLAN-2026-10-13.md) | **Draft for attorney.** Nothing decided |
| Honesty removals (false or risky customer statements, no new clauses) | [CUSTOMER-CLAIM-HONESTY-FIXES-2026-10-13](../audit/CUSTOMER-CLAIM-HONESTY-FIXES-2026-10-13.md), #2434 | Merged (plan phase 0) |
| Attorney packet: 5-page limited-scope PDF (who we are, five things that look wrong, questions by tier) | `LEGALSHIELD-ATTORNEY-PACKET-2026-10-13.pdf`, **untracked in Jo's main checkout root, deliberately not in the repo** | Prepared. File dated 2026-10-20. Nothing in the repo says it was sent |

## Shipped to customers since 10-13 that touches legal text

These are the places the "nothing unreviewed" rule is nearest to being tested. None
is a strengthening clause; each rests on statute text. **Jo should say whether the
attorney needs to look at them.**

- **#2516**: Kentucky "BUYER'S RIGHT TO CANCEL" statement (KRS 367.430) on KY
  home-signed contracts. Statute wording verbatim; PR was labelled "legal text: review,
  no auto-merge". No record of attorney review.
- **#2511**: CRM deposit rule: Ohio 10% cap applies over $25,000 (ORC 4722.01(C)).
  This is Q6 in the plan, which the attorney has not answered; the statute's own
  sections disagree on the threshold.
- **#2434** (removals) and **#2515** (Reg Z guard on site copy): removal or guard
  only, no new binding text.

## Drafted vs not built

- **Drafted only (plan Part A):** lien reservation, late interest, mutual fee-shifting,
  change orders, schedule/weather, insurance-job, warranty, dispute stack, subcontractor,
  e-sign, cancellation clause sets. All candidates, confidence-tagged HIGH/MED/LOW.
- **Not built:** plan phases 1-6 (internal lien-deadline tracker and reminders,
  incoming-waiver slots, evidence retention, consent/IP evidence parity, the clause
  module behind a dark flag, per-set enablement, late-fee line). No lien tracker or
  late-fee code exists on `origin/main`. Phase 1 (internal tracking, no customer-facing
  text) and phase 2 do not need the attorney, but the plan wants Jo's go first.

## What the attorney must answer (tiers, from plan Part D)

1. **Money and statutory exposure:** Is 1.5%/month lawful in Ohio (ORC 1343.01, 1343.03)?
   Kentucky benchmark under KRS 360.010 for principal of $15,000 or less. Flat late fee
   allowed? Mutual prevailing-party fee clause enforceable? Reg Z if milestone payments or
   a plan? Does the Ohio 10% deposit cap reach contracts of $25,000 or less? Kentucky
   insurance jobs: what may be collected at signing, deductible handling, "no
   discount/rebate" wording. Cancellation notice on an Ohio job that is also insurance-paid,
   and whether a housecall roofer is outside the fixed-location exemption. Emergency-services
   waiver. ORC 4722.02 content for $25,000-plus jobs.
2. **Liens:** the Ohio and Kentucky deadline checklists; any lien for a Kentucky deductible;
   may NBD put a lien clause in its own contract; required in-contract lien notices;
   subcontractor agreement clauses.
3. **Dispute stack:** arbitration/class waiver/jury waiver/mediation, notice-and-cure,
   governing law and venue for an Ohio contractor working in Kentucky, shortened claim
   periods, liability caps, warranty exclusions.
4. **Paper and records:** exact "licensed/registered/insured" wording per jurisdiction,
   contracting entity name, ESIGN consumer disclosure, retention, photo and messaging
   consent, change orders by text, insurance supplements.

The plan's "What to bring" list is the attorney's intake: signed samples (redacted), invoice
samples, templates, cancellation packets, the saved Legal Text overrides, one redacted
late-payment timeline, entity records.

## Blocked on

| Blocker | Who |
| --- | --- |
| No record the attorney session has happened or been booked (the packet is untracked and unsent as far as the repo shows) | Jo |
| Saved legal-text overrides (`companyProfile`) were never read; they win over repo defaults. Needs an owner-authorised read | Jo |
| No real signed contract has been read by the researcher | Jo to supply redacted copies |
| Statute refresh: Ohio statutory interest rate resets each October 15; KRS 367.620-.628 marked 2026. Re-check the day any text is finalised | whoever builds |
| Decisions D1-D12 (late-interest rate, flat fee, fee-shifting, deposit structure, courts/arbitration, venue, liability cap, claim period, lien posture, the 1.5% invoice line, entity name, warranty conditions) | Jo, informed by the attorney |

## Decisions Jo must make

1. Has the attorney been booked? If not, book the limited-scope session and bring the
   plan's "What to bring" list. Everything after phase 0 waits on it.
2. Do #2516 and #2511 (already live) go to the attorney as a first check?
3. Approve plan phase 1 (internal lien-deadline tracking, no customer text) now, or wait?
   The lien clock runs on real jobs whether or not a clause exists.
4. D10: remove the existing 1.5% invoice line pending Q1, or leave it?

Honesty rules for any future text stay as in the plan Part E: never "licensed", no
claim-outcome promises, no "we handle the claim" on Kentucky insurance jobs, crews are
independent subcontractors, credentials exactly as the footer states them.
