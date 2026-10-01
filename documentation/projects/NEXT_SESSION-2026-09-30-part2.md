# NEXT_SESSION — 2026-09-30, part 2

This follows [09-30](NEXT_SESSION-2026-09-30.md). Jo handed over a live-CRM
punch list from a browser chat session, then said "keep going", and approved
merging once green. Almost everything here is the **multi-job model** (a
customer can have more than one job) and the **money paper** (a filed
invoice/receipt for every charge), built from
[CRM-JOBS-AND-MONEY-PAPER-PLAN](CRM-JOBS-AND-MONEY-PAPER-PLAN-2026-09-30.md).
All of it is merged and deployed.

## §0 Read first

- **A customer is `/leads/{id}`; each piece of work is `leads/{id}/jobs/{jobId}`.**
  - `lead.activeJobId` names the job the lead's own fields (stage, jobValue,
    schedule…) describe. Every legacy screen still reads the lead.
  - `jobsMirrorOnLead` copies lead → active job (on in prod,
    `JOBS_MIRROR_ENABLED=true`).
  - The backfill wrote 254/254 NBD jobs (read back, 0 drifted).
  - Field list: `functions/jobs-logic.js` `JOB_FIELDS`, with an identical copy
    in `docs/pro/js/jobs-store.js`. **Both must match**; `jobs-stage1` pins it.
    It had a phantom `adjusterMeetingTime`. Fixed in #1922: the app writes
    `adjusterMeetingStart` / `adjusterName` / `adjusterPhone`.
- **Jo's rules (J1–J3), recorded in the plan; do not relitigate:**
  - **J3.** One pipeline card per OPEN job. A new job replaces the customer's
    card only when the current one is closed AND paid in full (or lost);
    otherwise both show.
  - **J1.** The referral bonus is paid per won job.
  - **J2.** A review ask per completed job, never twice within 90 days. The
    anniversary touch comes yearly from the first job.
- **The per-job overlay is everywhere.** A non-active job reads as the lead
  with that job's fields laid over it. That shape appears as:
  - `cardsFor` (pipeline cards);
  - `records`/`recordsFor` (money totals);
  - `jobView` (calendar, .ics, portal).
  The stamped `_stageKey`/`_stageRole` must be **redone from the job's
  stage**, or a won customer's open job reads as won.
- **Watcher gotchas, learned this session:**
  - A pin file written by PowerShell `Set-Content` ends in CRLF, so the
    watcher saw a "HEAD MOVED" on its own pin. Write pins with
    `[IO.File]::WriteAllText(..., "\n")`.
  - The 90×45 s watcher times out while CI is still queued. Use `seq 1 200`.
  - `tests/package.json`'s E2E spec list is **one line**, so two PRs that each
    add a spec always conflict. Resolve with main's line plus your spec.
- **Local "smoke bucket" ≠ CI's Smoke job.** CI runs `node tests/smoke.test.js`
  (about 4444 checks). The manifest's smoke bucket missed a pin that failed CI
  (#1925). Run the real one before pushing.

## §1 Shipped (PR → what)

| PR | What |
|---|---|
| #1907 | Pipeline live search, hotkeys off inside modals and selects, Edit Lead layout jump, double-save guard, "Carrier decision" label. |
| #1908 | Yard signs: edit/remove, GPS only on tap, "placing on" = scheduled. |
| #1909 | Duplicate check matches name + same ZIP / no street. |
| #1912 | **Money paper:** NBD-500 invoice / NBD-510 receipt PDFs filed on the customer, 7-day terms, out-of-band Mark Paid closes the Stripe invoice (ledger key pre-recorded, so no double count). |
| #1913 | Pay-by-QR on the invoice. |
| #1914, #1916 | Jobs phase 1: schema, mirror, backfill; mirror switched on. |
| #1917 | Clients write jobs (`jobWriteOk`: stamps must equal the lead's), collection-group read, `jobs-store.js`. |
| #1918 | One pipeline card per open job; a card moves only its own job. |
| #1919, #1924 | Yard-sign map: pins drawn (a null lat/lng crashed Leaflet), tap a card to fly to its pin, clusters; two signs at one spot now fan out on tap. |
| #1920 | The next open job takes over the card once the current one is paid in full + closed; a paid-in-full invoice marks its job paid. |
| #1921 | Customer page: Jobs panel + "＋ Add job"; the duplicate prompt offers "Add a job to them". |
| #1922 | Google Calendar events per job (the active job keeps the per-lead ids). |
| #1923 | Referral bonus per won job (latch on the job doc; a customer paid under the old rule is never paid twice). |
| #1925 | Review ask per completed job + 90-day gap; anniversary yearly from the first job. |
| #1926 | An invoice records the job it bills (`jobId`). |
| #1927 | The iPhone .ics feed shows each job (`leadId/jobId` UID). |
| #1928 | Portal: "Also scheduled" lines for a customer's other jobs. |
| #1929 | Pipeline / booked value / win counts count every job (`NBDJobs.recordsFor`); customer counts and expenses-based margin stay per customer. |

## §2 Open — Jo's hands

- **Yard Signs → "📍 Put them on the map"**, which places the 2 live signs
  saved without a location. Nothing was written to prod for this.
- **Drive filing (money paper):** share Drive `COMPANIES › NBD › CUSTOMERS`
  with `717435841570-compute@developer.gserviceaccount.com`. Until then the
  PDFs file on the customer only.
- Still open from 09-30 part 1: the phone photo test on /inspect, a Thursday
  test call, and the Bland balance.

## §3 Next lanes

- **Multi-job leftovers, all minor:**
  - The profit tracker and the expenses-based margin are per customer,
    because expenses are keyed by `leadId`. Per-job costs would need
    `expenses.jobId`.
  - D2D revenue is per door.
  - `ai.js` / Ask Joe context still sums one value per customer.
- **Server-side street address hard-require** on intake (09-30 §0, after a
  week of cache turnover).
- **Emulator `referral-rewards.test.js`:** 6 attribution-timing checks fail
  **identically on main's code** (baselined in #1923). Worth a look; the
  credit checks pass.
- The navy print logo (money paper) is still optional.
