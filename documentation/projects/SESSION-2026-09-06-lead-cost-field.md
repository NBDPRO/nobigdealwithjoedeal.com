# SESSION 2026-09-06 — lead cost becomes a field

**Lane:** CRM / money. **Branch:** working tree, uncommitted (see §5).
**Ask (Jo):** "i also want lead cost to be a tracked metric and have a place i can
set / modify it."

---

## 1. The finding

Every Thumbtack-sourced lead in `/leads` **already carries its acquisition fee.**
It has been in Firestore the whole time, inside the `notes` blob the ingest writes:

    Thumbtack — Roof Repair or Maintenance
    I need this wooden part replaced. The grade of the roof …
    Lead cost: $51.96
    · Travel Preferences: The roofer travels to me
    · Zip code: 45237

So this was never a data-collection problem. The number every ROI question needs
was sitting there as a line of prose — which nothing can sum, chart, or subtract
from a job. That is why the September lead audit had to be rebuilt by hand from
the Thumbtack payment ledger.

## 2. Why the existing workaround could not have worked

Expenses already supports attaching a cost to a job, and the obvious move is to
log each lead fee that way. It does not work, for a reason that is invisible from
the UI: the only category that fits a lead fee is **Marketing & Advertising**,
and `expense-config.js` classifies that `COST_TYPE.OVERHEAD`. Overhead is
job-agnostic by definition — it never touches a single job's gross margin. So 75
rows of careful data entry would have produced a bigger overhead number and
**still no cost-per-job**.

Hence a new category rather than a new habit.

## 3. What shipped

| File | Change |
|---|---|
| `docs/pro/dashboard.html` | `Lead Cost ($)` input beside Job Value — the two only mean something next to each other |
| `docs/pro/js/crm-leads.js` | `leadCost` in the save payload, the modal reset list and the dirty-check list |
| `docs/pro/js/crm-portal-bridge.js` | populate `lLeadCost` when a lead is opened for edit |
| `docs/pro/js/expense-config.js` | `lead_acquisition` — **DIRECT**, not overhead |
| `docs/pro/js/lead-source-roi.js` | per-source and total lead spend, cost per lead, cost per close, return on lead spend |
| `scripts/backfill-lead-cost.js` | one-off parse of the notes line into the field |

Dollars, not cents, deliberately: `leadCost` sits on the lead doc next to
`jobValue`, which is dollars. `expenses/{id}` is the subsystem that stores
integer cents and it is untouched.

`lead-source-roi.js` already joined marketing spend from the expense ledger by
name-matching `marketingSource` to a lead-source bucket. The per-lead figure is
strictly better — it is what *this* lead cost — so the per-source tag now prefers
it and falls back to the ledger join. Cost accrues on **every** lead, won or lost;
counting it only on closes would flatter every source.

## 4. What the backfill deliberately does not do

Refunds are not in the notes — Thumbtack refunds after the fact and never
rewrites the message. The script stamps the **gross** charge and prints the eight
refunded leads from the Jul 31 – Sep 6 window as a checklist to zero by hand.
Matching a refund to a doc by customer name is exactly the fuzzy join that
silently zeroes the wrong record.

It also never writes a speculative `0`. Ten of the 85 leads in that window were
genuinely free, so "no cost line" and "cost of zero" are different facts.

## 5. Repo state — read this before committing

The working tree was reached over the desktop bridge, and **git run from the
Linux side of that bridge reports all 1,465 files modified.** It is not real.
The files are CRLF on disk (correct for a Windows checkout with
`core.autocrlf=true`); the bridge's git has `core.autocrlf` **unset**, so it
diffs CRLF working files against LF blobs and calls every line changed. Same
family as [GIT-PHANTOM-MODIFICATIONS-2026-09-05](../audit/GIT-PHANTOM-MODIFICATIONS-2026-09-05.md),
different mechanism: that one was a `sed -i` sweep rewriting files LF-only,
this one is a reader with the wrong config.

**Consequence:** no git write was performed from the bridge, and none should be.
A commit made from there would bake CRLF into the blobs for everyone. All six
files were edited with a Node script that detects and preserves each file's own
EOL, per CLAUDE.md. **Commit from Windows**, where `git status` is clean.

## 6. Gates run

    node scripts/check-js-syntax.js            489 files parsed cleanly
    node scripts/check-inline-html-scripts.js  0 inline scripts across 227 files
    node scripts/check-site-integrity.js       242 pages, 26,874 refs, 0 failures
    node tests/smoke.test.js                   3,591 passed, 0 failed

The notes parser was also exercised against six cases including the real ingest
format and two near-misses that must NOT match (`Quoted $450 for the job` and a
notes blob with no cost line) — 6/6.

**Not yet done:** no suite covers `leadCost` itself. The repo's standard is a
suite proven able to fail first; this change does not meet it yet. That is the
first thing the next session should close.

## 7. Still open

- A **Settings → Lead Costs** screen (the rate card, the weekly budget, and a
  default-on-create stamp). The rate card currently lives in the Drive sheet
  *NBD MASTER Lead Cost Settings*.
- **Duplicate-lead detection.** Jo has been double-charged at least twice in two
  weeks because customers re-submit under an adjacent, dearer category — Customer CQ
   arrived as Siding Repair `$23.38` and again as Siding Installation
  `$99.65` for the same job. Matching new leads on phone or address inside 60
  days and badging the card would turn that into a refund request instead of a
  silent loss.
- The eight refunded leads to zero after the backfill runs.
## 8. A source-destroying bug, found by triggering it 26 times

The Thumbtack ingest writes `source: 'Thumbtack'` on every lead it creates. The Add
Lead / Edit Lead select shipped with five options — Door Knock, Storm Canvass,
Referral, Online, Other — and **Thumbtack was not one of them.**

A `<select>` whose current value is not in its option list renders blank. So
opening any Thumbtack lead showed an empty Source, and saving stamped whatever
was selected over the real value. The field looked unset; it was not.

This was found the hard way: a CRM cleanup pass on 2026-09-06 set Source on ~26
records and silently downgraded every one of them from `Thumbtack` to `Online`.
Customer BP, who was not edited that day, still reads `Thumbtack` — which is
what made the comparison possible.

**Fixed:** `dashboard.html` now offers Thumbtack / Yelp / Angi / Website alongside
the originals, and `lead-source-roi.js`'s `SOURCE_ALIASES` gives each its own
bucket instead of folding them into 'Online'. Paid marketplaces are the only
sources with a per-lead cost, so collapsing them into one 'Online' bucket also
made cost-per-source unanswerable.

**Not fixed:** the ~26 records already downgraded. They need setting back to
Thumbtack by hand once this deploys — the list is every lead edited on
2026-09-06 (Customer FZ, Customer DN, Customer AZ, Customer C, Customer FH, Customer CO, Customer Q,
Customer AW, Customer EF, Customer AJ, Customer H, another customer, Customer G, Customer DI, Customer BQ, Customer EO, Customer EG,
Customer AP, Customer DD, Customer FY, Customer CF, Customer EZ, Customer CC, Customer AY, Customer FM, Customer CN).

**The general lesson for this codebase:** any `<select>` whose options are a
narrower set than the values the ingest can write is a silent data-loss bug, not
a display bug. Worth a gate that diffs the option lists in `dashboard.html`
against the distinct values actually present in Firestore for the same field.

---

## 9. The source field cannot hold the data, and it changes every conclusion

Read directly from `window._leads` (all 188 CRM records) on 2026-09-06.

### The dropdown is narrower than the data

`#lSource` offers **5** options. The collection holds **10** distinct values:

| Value | Records | In dropdown? |
|---|---:|---|
| `Door-to-Door` | 64 | no |
| `Thumbtack` | 58 | no |
| `Online` | 25 | yes |
| `Direct` | 12 | no |
| `Yelp` | 11 | no |
| `Door Knock` | 8 | yes |
| `Other` | 5 | yes |
| `Referral` | 3 | yes |
| `Website — Contact form` | 1 | no |
| *(empty)* | 1 | — |

**146 of 188 records (78%) carry a value the dropdown cannot represent.** Each
renders blank in the editor and is overwritten on save. §8 documented this as a
bug; this is its blast radius.

### The 0% D2D conversion is a definitional artifact

The channel is stored under **two different strings**. An unqualified knock is
`Door-to-Door` — exactly **64**, which is precisely the Prospects panel count.
When a knock becomes a real customer the source is retyped as `Door Knock` —
**8** records — and it leaves the prospect pool. The numerator is empty by
construction and always will be.

Door knocking has in fact produced **Customer BX** ($3,145, closed) and
**Customer DR** ($17,500, `supplement_requested`, created
2026-04-03), and carries **$44,245 of pipeline — more than any other source.**

### Won value by source, and why the session got it backwards

| Source | Leads | Won | Won value |
|---|---:|---:|---:|
| `Direct` | 12 | 7 | $31,032 |
| `Yelp` | 11 | 4 | $28,780 |
| `Thumbtack` | 58 | 8 | $5,040 |
| `Other` | 5 | 2 | $4,525 |
| `Door Knock` | 8 | 1 | $3,145 |
| `Online` | 25 | 5 | $2,925 |
| `Door-to-Door` | 64 | 0 | $0 |

`Direct` is a default, not an observation — **Customer BR ($22,882.19) sits in
it**, and Joe confirms that job actually came from Yelp. Corrected, Yelp has
produced roughly **$51,662** and is the best-performing channel in the business.
It has never appeared in a single report in this app.

Thumbtack has the **most leads (58) and the lowest won value of any real**
**channel ($5,040)**. Every channel conclusion reached earlier in this session
came from Thumbtack alone, because Thumbtack is the only source whose leads
carry a machine-readable `Lead cost:` line. That is a sampling bias in the data
collection, not in the analysis — and it inverted the ranking.

### Consequences for the work in this repo

1. **Ship the §8 dropdown fix before anyone edits another lead.** Until then,
   opening and saving a lead destroys its source 78% of the time.
2. **`lead-source-roi.js` is measuring one channel and captioning it "sources".**
   Its output is not wrong so much as unrepresentative, and it should say so
   until sources are trustworthy.
3. **Normalise `Door-to-Door` and `Door Knock` to one value** with a qualified
   flag, or the Prospects conversion metric can never be non-zero.
4. **Treat `Direct` and empty as "unset"** and report on them nightly.
5. **Lead cost is only ingestible for Thumbtack.** Yelp and Angi fees arrive as
   monthly invoices, not per-lead lines, so `leadCost` will be null for the
   channel that earns the most. Per-channel spend needs its own entry point —
   the rate card in the Drive settings sheet is the interim home.

### Fixed by hand on 2026-09-06

The prospect at `[street address], 45237` is the same property as the Customer BR job:
address corrected to `[street address], 45216`, source set to `Door Knock`,
overdue follow-up cleared, notes annotated, record hidden (the roof is done).
**Note this edit moved that record from the `Door-to-Door` bucket into
`Door Knock`**, which is why those counts read 64/8 rather than 65/7.
Not done deliberately: Promote to Customer (would duplicate Customer BR) and Job
Value on the prospect (would double-count $22,882).

A note on the Customer BR customer records `SOURCE = YELP` and why the field itself
was left alone. **Add Customer BR to the post-deploy source-correction list in §8.**
