# Job cost auditor (flag `jobCostAuditor`), 2026-10-19

Why: 20 of 21 finished jobs read about 100% margin because the sub and labor
cost of the independent crews was never logged (only 6 jobs had any cost). The
receipt sorter handles materials; this is the other half: sub, labor, dumpster,
permit and disposal cost. It finds the jobs whose books look wrong, makes the
entry quick from a phone, and adds a checker that asks "real or a mistake?".
Ships dark. Crews are independent subcontractors: nothing here says employee,
payroll or in-house.

## What it is

- **Queue** (Expenses, "Job cost audit" button and card): finished, in-production
  and paid-signed jobs grouped by problem: margin too low or negative, margin too
  high, costs but no payment, no labor / sub cost, no materials. Each card shows
  collected, direct costs by type, margin and the reason. Search, group chips,
  sort (worst first, most collected, highest margin, name), status filter.
  Cards, not a table: one column on a phone.
- **Job sheet**: flag cards ("Is this real or a mistake?": It's right / Mistake -
  fix / Add missing cost), the job's cost rows (Void your own, with a required
  reason), and the entry form: who did it (the `companies/{id}/subs` roster plus
  past subcontractor payees), cost-type chips (Sub labor tear-off/install, Sub
  labor gutters, Dumpster, Permit, Disposal, Other), amount, a percent-of-collected
  slider, an estimate switch ("Cost unknown - estimate"), date, note.
- **Suggestions**: only from the company's own jobs. A peer is a job of the same
  trade (`lead.trades`) with money collected and a REAL (not estimated) sub / labor
  cost. With 3 or more: "Similar jobs: sub cost 38-52% of collected, median 44%"
  with Use low / median / high, turned into dollars of THIS job's collected money
  (and per square when `lead.squares` exists on the job and 3 peers). With fewer
  than 3 it says so and leaves the box empty. No industry rate is anywhere in the
  code; no preset percent buttons.
- **Ask me**: one question at a time (sub, dumpster, permit, disposal, materials)
  with Skip / Not applicable / Unsure. Every answer is remembered on the lead
  (`costAudit.asked.<q>`), so it is not asked twice.
- **Costs complete** marks a job done (`costAudit.complete/completeBy/completeAt`),
  which takes it out of the queue (a "Marked complete" view has Reopen). A job that
  still has flags asks for a second tap. "It's right" is remembered against the
  numbers it judged (`costAudit.ack.<code>` = a fingerprint of costs and collected);
  a new cost or payment re-opens the card.

## Where a cost goes (no new store)

An `/expenses` doc exactly like the receipt importer and the cash payout log
write: `costType: 'direct'`, `category` subcontractor / equipment_dumpster /
permits_fees / disposal, `source: 'cost_auditor'`, `auditKind` (what the checker
counts it as: sub, dumpster, permit, disposal, other), `auditType`, `supplier` =
who, `subId` when the name is on the roster, `estimated: true|false`,
`amountCents` (int), `date`, `leadId` / `jobId`, `editLog` (`{at, by, what,
source: 'cost-auditor', note}`, at most 25, the existing rule bound). So job
profit, the Expenses by-job table, receipt-health "costs missing" and the agent
`job_profit` tool all count it. An estimate counts in margin and is marked, and
never becomes a peer. Void = `deleted: true` AND `deletedAt` plus an editLog
entry with a required note; only the row's own writer (rules) can void. No hard
delete. "Other" uses category `equipment_dumpster` (the nearest direct bucket) with
`auditKind: 'other'`.

## The checker, `jobCostFlags(job, costs, peers, config)`

Pure, in `docs/pro/js/job-cost-audit-logic.js`; `functions/job-cost-audit-logic.js`
is a byte-identical copy (a test holds them equal). One `CONFIG` object holds every
threshold. Flags: margin over 90% with no sub / labor on a job over $1,500;
margin more than 25 points above (or below) the median of the company's own jobs
of that trade (3 or more peers, else a fixed fallback: over 90% / under 10%);
negative margin; sub cost over collected; duplicate cost rows (same category,
amount, day, name); a cost dated more than a day before the customer existed;
costs with nothing collected (info); no materials (info). Margin flags apply only
to FINISHED jobs (collected is the final money); data-quality flags apply to all.

## Agent tool (second PR)

`cost_audit` for Frank (read only, `readOnlyHint`): flagged jobs with lead id,
name, phase, trade, collected, direct costs by type, estimated costs, margin and
reasons. No phone, email or address. Jobs marked complete and flags the owner
called right are left out. Frank files a report or reminder with the existing
`file_report` / `file_reminder`; the bot changes no cost and contacts no one.

## Rules and data

No firestore.rules change: a lead update by the owner or company staff already
accepts the `costAudit` map, and the expense create / update rules already bound
`editLog`. The panel is hidden for `viewer` and `sales_rep` (cannot write costs);
shown for no-role owners, `company_admin`, `manager`, platform `admin`. Lead
squares: the CRM has no reliable squares field on a lead today, so per-square
suggestions appear only when `lead.squares` (or `totalSquares`) is present.

## Turn it on

Firebase console, Firestore, `feature_flags/_default`: add `jobCostAuditor`
(boolean) = `true` (or the same field on `feature_flags/{your uid}` to try it
alone). Reload Pro, Expenses: a "Job cost audit" card and button appear. The
assistant cannot write production flags.

## Tests

`tests/job-cost-audit-2026-10-19.test.js` (node bucket): money picture, medians,
ties, peers, suggestions (0 / 2 / 3 peers, zero collected, self excluded),
thresholds, every flag with a positive and a negative control, queue, gates, the
cost document. `tests/e2e/phone-job-cost-audit.spec.js` (@phonefit): 360 and
412px, no sideways scroll, 44px targets, a saved cost's document, Use median,
estimate, Skip remembered, Costs complete, void with reason. Mutation-checked.

## Not done

- Cost rows written by someone else cannot be voided from here (rules).
- Per-square needs a squares field on the lead; none is stored today.
- The queue reads the loaded Expenses list (newest 1000 rows) and the cached
  invoices; a job whose costs are older than that window reads as "no cost".
