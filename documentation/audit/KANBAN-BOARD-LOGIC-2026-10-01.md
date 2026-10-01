# Kanban board logic and card visibility audit (2026-10-01)

Jo asked for two things:
- **Visibility:** "double check kanban card stability and visibility and make
  sure nothing is broken or causing cards to hide or be invisible".
- **Board logic:** "seriously work on the kanban logic in different board
  types … make sure the columns all make sense, every customer shows up in all
  the right boards … I find myself simply clicking All and never any other
  board filter".

## 1. Visibility: no look hides a card

`tests/e2e/kanban-visibility.spec.js` (@audit) seeds a lead into each of the
first six board stages, one of them 60 days stale (the animated "critical"
aging style). It checks every card **behaviourally**:
- the card exists, once, in its own column;
- it has a real size and isn't `display:none` or hidden;
- it isn't faded (the product of the opacities ≥ .9);
- `elementFromPoint` hits its name, so nothing covers it;
- the name clears 4.5:1 against the alpha-composited background behind it.

It sweeps 12 themes, the skins and art themes among them, across all 12
Shape & Depth styles on the desktop board, and a subset on the phone list.

**Result:**
- Desktop board: 864 checks, all pass, worst name contrast 13.27:1.
- Phone list: 180 checks, all pass, worst 16.15:1.

The sweep's own positive control caught two harness bugs before it could
report a false green:
- the theme engine is a lazy bundle, so 11 of the 12 themes silently didn't
  apply;
- the Shape & Depth picker lives in an unmounted template.

## 2. Board logic: what production looked like

This was a read-only count over 182 live customers, plus 65 prospects that
are hidden by design. No names were read.

| | |
|---|---|
| Job type | 118 none, 34 cash, 17 insurance, 13 service, 0 finance, 0 warranty |
| Untyped customers | appear only on Insurance and All, never on Cash or Service |

Where stages landed before the fix (`resolveColumn` with the real view lists):

| Stage | All | Insurance | Cash | Service | Warranty |
|---|---|---|---|---|---|
| contacted | **New** | own | own | own | own |
| estimate_submitted | own | own | **New** | **New** | n/a |
| service_quoted | **New** | **New** | **New** | own | n/a |
| contract_signed | own | own | own | **New** | **New** |
| install_in_progress | own | **Contract Signed** | **Contract Signed** | own | Closed |
| install_complete / final_payment / closed | Closed | **Contract Signed** | **Contract Signed** | Closed | Closed |

So:
- every installing, complete, paid and closed job piled into Contract Signed
  on the Insurance and Cash boards;
- anything a board had no column for fell into New.

## 3. The fix

All of it is in `docs/pro/js/crm-stages.js`.

- **Insurance, Cash and Finance** gain **Installing** and **Closed** columns
  after Contract Signed (the same pair All has). The finer job stages fold
  into them: won goes to Closed, in-production goes to Installing.
- **All** gains a **Contacted** column (12 live customers sat there and read
  as New).
- **`resolveColumn` families.** A stage a board lacks folds into the same
  step under that board's name:
  - any estimate, quote, negotiation, supplement or prequal goes to the
    board's estimate column;
  - claim and adjuster stages go to Inspected;
  - Contract Signed, Service Approved and Loan Approved are the same step;
  - warranty stages go together.

  Only a stage with no equivalent at all reaches the first column.
- **Stage pickers:** `stageOptionsForType` dedupes. The tenant-aware pickers
  (`dashboard-bootstrap` and the customer page's `_pipelineFor`) take the
  board's own job columns out before laying in the full job sequence.
  Otherwise "next after Installing" read Closed, which
  `phone-pipeline.spec`'s swipe check caught.

`tests/kanban-board-logic-2026-10-01.test.js` (39 checks) runs every board ×
every built-in stage:
- nothing lands off-board or in the first column by accident;
- jobs go to Installing or Closed on every track board;
- the exact production cases above;
- dropdowns have no duplicates;
- both picker wrappers keep the job sequence in order.

Break-tested: removing the family fallback turns 7 checks red.

## 4. Next (Jo chose "Suggest + sort")

The 118 untyped customers are the main reason the filtered boards look empty.
Next lane:
- a **Sort my customers** screen that suggests each type from what's on file:
  claim info means insurance, a cash estimate or negotiation means cash, a
  service quote means service;
- Jo confirms in bulk with one tap;
- new leads must pick a type.

This is a production data write, so it waits for Jo's confirm on the screen
itself.

## 5. Update, same day: "Sort my customers" shipped

- **`suggestJobType(lead)`** lives in `docs/pro/js/crm-stages.js` and is
  exposed as `window.suggestJobType`. It returns `{type, reason, strength}`
  or `null`, and never writes.
  - **Strong:** what `inferJobType` already reads: a carrier, a claim or
    policy number, a claim status other than "No Claim", an adjuster or a
    date of loss, a real loan (`loanAmount` > 0, since 8 real leads carry 0),
    a warranty claim, or a claim / finance / service / cash stage.
  - **Likely:** the request's own words.
    - Thumbtack `Category:` / `Project type:` or `damageType`: a repair,
      maintenance or cleaning request → Service; an install or replacement
      → Cash.
    - Storm words → Insurance, unless the request says "not covered".
    - Failing those, the price: $5k or more → Cash, under $2.5k → Service.
- **What a read-only count of the 118 untyped customers showed:**
  - 89 are Thumbtack requests: drywall 21, roof repair 20, siding 15,
    gutters 7.
  - 13 say "Insurance claim coverage: No".
  - The new suggester places 107. That is 86 Service, 13 Cash and 8
    Insurance; 11 have no clues. `inferJobType` alone placed 4.
- **`docs/pro/js/sort-customers.js`** + `css/sort-customers.css`:
  - The banner over the board (`#sortCustomersWrap`, refreshed at the end of
    `renderLeads`) reads "N customers have no job type".
  - The screen has filters (Suggested / No clues / All), a per-row picker
    preselected to the suggestion, and "Set everyone shown to…".
  - **Save** writes only the picked rows: `jobType` + `updatedAt` in chunked
    writeBatches, then a best-effort `type_change` timeline note per lead
    (the same note `changeLeadType` writes).
  - Only leads the user may edit are listed. Viewers see nothing.
- **New leads must pick a type.** `saveLead` in `crm-leads.js` refuses a new
  lead with no type; editing an old untyped lead still saves. The "Not Set"
  option now reads "Pick a type…".
- **Tests:**
  - `tests/suggest-job-type-2026-10-01.test.js`: 34 checks.
  - `tests/e2e/sort-customers.spec.js` (@shard2, 390px). Break-tested: a
    no-op Save turns it red.
  - `crm-handoff-ui.spec.js` now picks a type.
- **Production write:** none was made by this work. Jo sorts on the screen.
