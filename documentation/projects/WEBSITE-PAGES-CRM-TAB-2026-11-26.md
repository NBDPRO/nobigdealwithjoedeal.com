# Website pages tab in the CRM (2026-11-26)

Website follow-up item 3, second half (Joe, 2026-11-26: "both"). The first
half is the "Website pages → money" section of the monthly marketing-report
email (PR #3275; its note is `projects/WEBSITE-PAGE-REVENUE-2026-11-26.md`
once that PR merges). This note covers the CRM screen.

## What it is

A third tab, **Website pages**, beside Review and Report in the "Where
customers came from" modal (`docs/pro/js/lead-source-fixer.js`, CRM board
toolbar button). It is owner / company_admin only and behind the
`leadSourceFixer` flag, the same gates as the modal it lives in
([LEAD-SOURCE-FIXER-2026-10-19](LEAD-SOURCE-FIXER-2026-10-19.md)).

For each website page it shows leads, inspected, sold and **collected**
dollars, in two tables: last calendar month and the trailing 12 months ending
with it. There is a total row, and the footnote says that estimates,
contracts and pipeline are never counted as collected.

## Rules (same as the monthly email)

- **Page:** the CRM lead's `sourcePage`. The `page-form:` prefix, the query
  string, `.html` and the trailing slash are dropped. Redirected URLs count as
  their new page: `/storm-check`, `/roof-score` and `/storm-report` count as
  `/roof-check`, and `/book` counts as `/inspect`. Cal.com bookings are one
  row. A lead with no page falls back to "(page not recorded) · <form>".
- **Counted leads:** `webLead === true`, not deleted, not a prospect, not
  e2e test data. Each is counted in the period it came in, by calendar day in
  the company's timezone (`NBDCompanyTimeZone.current(_companyProfile)`, else
  the browser's zone).
- **Inspected:** an inspected-or-later built-in stage now or anywhere in
  `stageHistory`, a sale, or an `inspectionDate` already past. Unknown custom
  stages don't count.
- **Sold:** `NBDNumbers.isSale`: won, in production, or contract signed.
- **Collected:** `NBDRevenue.paymentsOf`, payments minus refunds dated by
  when the money arrived. It covers money received in the period from any
  customer who came off that page, whenever they first came in. Amounts are
  integer cents.

The logic is the pure `wpBuild` / `wpPageKey` / `wpReachedInspection` /
`wpWindows` in `lead-source-fixer.js`. It is a client copy of
`functions/website-page-revenue.js`.
`tests/lead-source-fixer-2026-10-19.test.js` runs the server suite's cases
against it. A parity check compares both outputs on the same data. It runs once
`functions/website-page-revenue.js` is on the branch (after #3275 merges);
locally against the #3275 file it passed.

## Budget (asked first, Joe answered 2026-11-26)

Measured on main 72b047d29: shipped local script bytes were 2619 KB against
the 2620 KB ceiling, with **570 B** of room. The budget counts only
`<script src>` tags in `dashboard.html`. `lead-source-fixer.js` is the lazy
`leadsourcefixer` bundle that `dark-features.js` loads when the flag is on,
so it is not counted. Joe chose "build it inside lead-source-fixer.js":
**0 B** of boot growth, no raise (re-measured on the branch: 570 B still
left). The bundle URL went from `?v=1` to `?v=2` (same length).

## Data and privacy

No new reads. The tab uses the leads already on the board (`window._leads`)
and the invoices the modal already loads when it opens
(`NBDRevenue.loadInvoices`). Both are tenant-scoped by the Firestore rules.
Nothing is written. Page paths are escaped. No customer names appear in the
tab.

## Not verified

The tab was not opened in a signed-in browser (it needs an owner account with
the flag on). Its markup is checked in the test's vm sandbox. On a phone,
three tabs share the row, so "Website pages" may wrap to two lines inside its
44 px button.
