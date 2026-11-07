# Lead Source ROI no longer re-reads the whole expense history on every lead save — 2026-11-06

From the 2026-11-06 full CRM audit (VW-F11; scorecard on the `crm/2026-11-06-tooling` branch). Performance, Tier A.

`docs/pro/js/lead-source-roi.js` cleared its spend + marketing-expense cache and re-rendered on every
`leadsChanged` event, which fires on each lead save and load. After one visit to Reports the panel stays mounted,
so every pipeline edit re-read the owner's entire `expenses` collection (no limit) plus monthly spend — even with
Reports closed. Now a hidden panel only marks the cache stale; the next Reports render (or a save while Reports is
open) refetches. Numbers shown on Reports are as current as before.

Not changed tonight (would cap or filter data that lists still show in full — proposals, not fixes): the
unbounded `loadEstimates` boot read (DT-F06), the all-time `collectionGroup('tasks')` boot read (DT-F09), and the
Canvassers panel's unbounded company reads (DT-F07). See the audit scorecard / NEEDS_JOE.

`tests/lead-source-roi-refetch-2026-11-06.test.js` loads the real module and counts expense reads: 5/5.
