# CRM plan: many jobs per customer, and a filed document for every charge (2026-09-30)

Items #1 and #7 from Jo's live-CRM handoff of 2026-09-30. The same handoff's
smaller items went out as PRs the same day:

- #1907: hotkeys, the Edit Lead layout jump, pipeline search.
- #1908: yard signs.
- #1909: the duplicate check.

> **Status (corrected 2026-09-30, evening): BUILT.** Part 2 (money paper,
> #1912/#1913) and Part 1 phases 1–2 (#1914–#1929) are merged and deployed.
> The PR-by-PR list is in [NEXT_SESSION-2026-09-30-part2](NEXT_SESSION-2026-09-30-part2.md) §1.
> What's still open: Drive filing waits on Jo's folder share; profit/margin
> stay per customer (expenses are keyed by lead); the navy print logo.

This note began as the plan, written from two read-only scoping passes over
the code on a `main` checkout the same day.

## Jo's answers (2026-09-30, the same session) — these override the recommendations below

- **J1 Referral payout: once per JOB.** Every won job from a referred customer
  pays the referrer again. This departs from the recommendation. The referral
  trigger has to key its "already paid" guard on the job, not the lead.
- **J2 Review request per completed job, never twice within 90 days;
  anniversary once a year per customer, from the first job.** This is the
  recommendation.
- **J3 Cards: the new job REPLACES the customer's card only when the earlier
  job is paid in full AND closed. Otherwise both jobs are open at the same
  time, as two cards.** Jo, verbatim: "I really have had two people with two
  open jobs at the same time."
  - What this changes: **one card per open job**. A customer with no open job
    shows one card, for the most recent closed job.
  - This moves the phase-2 per-job pipeline card to the heart of the feature.
    Phase 1 (schema, backfill, mirror) still ships first and stays invisible,
    but the mirror's "active job" is only the lead-level view.
  - The pipeline has to read jobs before a second concurrent job can exist in
    the UI. The customer page's "＋ Add job" button ships in the same PR as
    per-job cards, not before.
- **P4 Photo plate: the cover photo, else the newest After photo, else no
  plate.** This is the recommendation.
- **P1 7-day terms and P3 out-of-band Mark Paid** were already specified by
  the handoff, so they are taken as decided.
- **P2 (share the Drive folder)** is still Jo's action. It is optional: filing
  on the CRM card works without it.

---

## Part 1: a customer can have more than one job

### The problem

A `/leads/{id}` doc is both the customer and the job. It has one stage, one
`jobValue` and one `scheduledDate`. A repeat customer therefore either gets a
duplicate card (Jo's hard rule is no duplicates) or has the closed job
overwritten. Current cases:

- Pat Schwemlein: a $250 repair was closed, and a caulk job is set for Oct 1.
- Brian McGlynn: two addresses.
- Larry Cunningham: Morrow and Marlette Dr.

"Additional Service Locations" (`lead.serviceAddresses`) only lists addresses.

### Scale

About 106 source files touch `lead.stage` (77 client, 29 in `functions/`). There
are 445 references to `jobValue` across 101 files, and 79 of the 351 unit tests
pin stage, value or schedule fields. Nothing like a jobs model exists today, so
the name `jobs` is free.

### Design

This follows the handoff's proposal.

- `/leads` stays the **customer**. Ids like `thumbtack_leads__…` survive.
- A new subcollection `leads/{leadId}/jobs/{jobId}` holds:
  - `title`, `stage`, `stageRole`, `stageStartedAt`, `stageHistory`, `jobValue`, `jobType`, `source`, `scopeOfWork`;
  - `scheduledDate`, `scheduledWeek` and the arrival-window fields;
  - `property {address, lat, lng}`, `createdAt`, `closedAt`.
- Rules follow the `warrantyClaims` pattern in `firestore.rules`:
  - read: owner or parent lead in my company;
  - write: notViewer, then owner or company staff;
  - a `jobWriteOk()` shape check reusing `stageWriteOk()` and `scheduleWindowOk()`.
- The lead carries `activeJobId`.
- The lead-delete sweep already finds subcollections generically, so jobs are
  swept with no change.

### Phase 1 (nothing visible changes)

1. The rules above, with rules tests.
2. A backfill migration: one job per existing lead, copied from its current
   fields. It is idempotent, a dry run by default, and requires `--company`.
   **Running it against production is Jo's call.**
3. A mirror that keeps the lead's legacy fields equal to its **active** job.
   Every current reader (kanban, analytics, portal, iPhone feed, Google
   Calendar, stage-role triggers, the 79 tests) keeps working untouched.
4. Every create path makes the first job: Add Lead, Cal.com, Thursday, the
   web-form bridge, inbound SMS and referrals.

Seven writers set these fields directly instead of going through
`stage-write.js`:

- the edit modal
- the schedule planner
- `deal-install-date`
- Stripe's `final_payment` advance
- D2D
- the portal bridge
- the insurance claim stage

Phase 1 routes each one through a single "write the active job" helper, or the
job and the lead drift apart.

### Phase 2 (a second job actually works)

- The pipeline board and list show **one card per job** (customer name, job
  title, property). The customer page gets **＋ Add job** and a job switcher,
  and the dedup prompt (#1909) gains "Add a job to them".
- Schedule, the iPhone feed and the planner iterate jobs.
- **Google Calendar event ids become per job.** Today they are keyed per lead,
  so a second job would overwrite the first job's event.
- Estimates, invoices, documents, photos, yard signs and warranty claims get an
  optional `jobId`. `primaryEstimateId` and collected revenue go per job.
- Won/revenue stats count **closed jobs**, so reopening a customer never
  erases a closed job.
- The portal timeline and schedule go per job.
- Thursday's caller lookup picks the active job.

### Decisions for Jo

- **J1. Referral payout: once per customer, or once per job?** Today the
  payout fires when the referred lead is won, so once. **Recommendation: once
  per customer.** A second job from the same homeowner isn't a new referral.
- **J2. Review request and anniversary touch: per job or per customer?**
  **Recommendation: review request per completed job, spaced at least 90 days
  apart. Anniversary per customer, from the first job.**
- **J3. When a new job is added, does the customer card move back to that
  job's stage?** **Recommendation: yes in phase 1.** The active job is the
  newest open one, and the closed job stays in history and in revenue.

---

## Part 2: every charge gets a filed document

Jo's standing rule: a Stripe link alone is never enough. Every invoice and
receipt is the branded NBD document, filed on the CRM card **and** in Drive
under `CUSTOMERS/<Name>/Docs`. The receipt exists only once the invoice is paid.

### What exists vs what is missing

| Step | Today | Change |
|---|---|---|
| Stripe customer + invoice (`send_invoice`, `auto_advance:false`) | **Built.** `functions/stripe-crm-invoice.js` `mintCrmStripeInvoice` finds or creates the customer and voids a stale invoice, but uses `days_until_due: 14` | Change to **7** as the handoff asks, and update its test |
| NBD-500 invoice document | **Partial.** `functions/print/templates/invoice.hbs` has a pay button and badges, numbered `INV-######`. No QR code, no photo plate, no NBD-500 code or `NBD-YYYY-MMDD-XXXX` id | Add a server-side id counter, a QR code (`qrcode` npm package) from the hosted invoice URL, and a photo plate |
| Filed on the card | **Missing.** A server render returns before any save. The PDF goes to `pdf-renders/`, where it is **deleted after 30 days** | The server files it: Storage `documents/…pdf` plus a row in `leads/{id}/documents` with code, id and Stripe invoice id |
| Filed in Drive | **Missing.** There is no Drive code in production. `scripts/import-drive-docs-to-crm.js` goes the other way, but already has the folder layout and name matching | Upload with a service account (`google-auth-library` is already installed) to `CUSTOMERS/<Name>/Docs`, creating the folder if needed. **Needs Jo (P2 below)** |
| NBD-510 receipt on a Stripe payment | **Missing.** The webhooks book the payment (and move the lead to `final_payment`), but no document is made. `receipt.hbs` exists | On `invoice.paid` for a CRM invoice, render and file the receipt the same way. It is keyed on the Stripe invoice id, so it happens once |
| Mark Paid (Zelle / check / cash) | **Partial.** It records the payment and optional proof. It **leaves the Stripe invoice open and payable** when fully paid, and the "receipt" is a one-line email | Once paid in full, mark the Stripe invoice `paid_out_of_band`. That fires the same `invoice.paid` path, so one receipt code path serves both |
| Print logo | The server PDF uses the square app icon. The client falls back to `nbd-logo.png`, the white lockup, which is invisible on paper | Use the navy master (`print-assets/nbd-logo-print.png` / `nbd-logo-light-bg.png`). The brand-mark test needs updating |

### Decisions / actions for Jo

- **P1. Change due dates from 14 to 7 days** for new invoices (handoff).
  Existing invoices keep their date. OK?
- **P2. Drive filing needs one click from you.** Share the Drive folder
  `COMPANIES › NBD › CUSTOMERS` with
  `717435841570-compute@developer.gserviceaccount.com` as Editor. Until then,
  documents file to the CRM card only, and the Drive step logs "not shared".
- **P3. Out-of-band marking.** When Mark Paid brings a balance to zero, the
  Stripe invoice is marked paid (`paid_out_of_band`). Stripe then shows it as
  paid and the homeowner can no longer pay it by card. This is exactly the
  handoff's intent; confirming because it touches Stripe.
- **P4. Photo plate** (the Sep 10 rule): which photo? **Recommendation: the
  lead's cover photo, else the newest "After" photo, else no plate.**

---

## Suggested build order

1. **Part 2** (money paper), which doesn't depend on Part 1:
   - 7-day terms, NBD ids, filing on the card, receipts on Stripe payment,
     and out-of-band Mark Paid;
   - the navy logo;
   - Drive once P2 is done.
2. **Part 1, phase 1**: schema, rules, backfill as a dry run and then
   production on Jo's OK, the mirror, and create paths.
3. **Part 1, phase 2**: pipeline, schedule, calendar, revenue and portal per
   job.

Related:

- [NEXT_SESSION-2026-09-30](NEXT_SESSION-2026-09-30.md)
- [STRIPE-FULL-INTEGRATION-2026-09-29](STRIPE-FULL-INTEGRATION-2026-09-29.md)
- [CALENDAR-HUB-PLAN-2026-09-29](CALENDAR-HUB-PLAN-2026-09-29.md)
