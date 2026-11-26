# Website pages → money (2026-11-26)

Item 3 of the 10-item website follow-up Joe approved on 2026-11-26, after the
2026-11-25 audit found the site made about 7 of 330 leads in a year (lead
forms were silently broken from 2026-10-13, see
[WEB-LEADS-TURNSTILE-OUTAGE-2026-11-25](../audit/WEB-LEADS-TURNSTILE-OUTAGE-2026-11-25.md)).
Goal: judge future website work by collected money, not traffic.

## Joe's answers (2026-11-26)

- **Where:** both. The monthly marketing report email now (this PR); a CRM tab
  later as a separate follow-up (the dashboard script budget is nearly full,
  so it needs its own measurement and budget raise).
- **Window:** last month **and** the trailing 12 months. The site makes only a
  few leads a month, so one month alone is mostly zeros.

## What shipped

A "Website pages → money" section in the 1st-of-month marketing report
(`functions/marketing-report.js`, schedule unchanged), built by the pure module
`functions/website-page-revenue.js`. One row per page, two tables:

| Column | Meaning |
| --- | --- |
| Leads | web leads (`webLead: true`, not deleted, not test data) that came in during the window, by `sourcePage` |
| Inspected | of those leads, how many reached an inspection: a stage at or past `inspected` now or anywhere in `stageHistory`, or a sale |
| Sold | of those leads, how many are a sale (`stage-roles.js` `isSale`: signed contract, job in production, or won) |
| Collected | money **received** in the window (payments minus refunds, dated when the money arrived, `agent-mcp-logic.js` `paymentsOf`) from any customer who came off that page, whenever they came in |

Estimates, contracts and pipeline are never counted as money, and the email
says so under the tables. All money is integer cents. Windows are calendar days
in the company's timezone (`companyProfile.timezone`, Eastern by default).

### Page grouping

- `page-form:/areas/mason-oh` and `/areas/mason-oh/` are one page; query
  strings, `#hash`, `.html` and `/index.html` are dropped.
- Redirected URLs count as their new home: `/storm-check`, `/roof-score`,
  `/storm-report` → `/roof-check` (#3263); `/book` → `/inspect`.
- Non-path sources: `homepage` → `/`, `estimate-funnel-v2` → `/estimate`,
  `storm-alerts-page` → `/storm-alerts`, `calcom:*` → "Cal.com booking".
- Leads bridged before `sourcePage` existed (2026-09-13) show as
  "(page not recorded) · <form>" using `publicLeadCollection`.
- Guide pages keep their own slug (`/guides/<slug>`), so each guide is judged
  on its own.

### Tenancy

The section reads one company only: the tenant the marketing site's public
forms bridge into (`NBD_OWNER_UID`, the same env value `lead-bridge.js` uses),
by `companyId` and owner uid (`userId` for leads, `createdBy` for invoices). No
other tenant's leads or money can reach the email; the test proves it with a
second tenant in the fake database. No customer names, phones or emails are in
the section.

A failed CRM read shows "Could not read the CRM this month … not $0" instead of
an empty table. A month with collected website money but no new leads still
sends.

## Tests

`tests/website-page-revenue-2026-11-26.test.js` (node bucket, 37 checks):
grouping, windows (January rollover, Oct 31 Eastern vs UTC), inspected via
history, cents with a refund, unpaid / deleted / non-website invoices excluded,
tenant isolation, failed read, HTML escaping of a form-supplied page path.

## Open / follow-ups

- **CRM tab** (Joe chose "both"): the same rollup on a CRM screen. Needs the
  dashboard script budget measured first.
- The older "Where last month's web leads stand now (CRM stage)" section in the
  same report counts `webLead` leads across every tenant (it predates this
  work); tenant-site leads could land in NBD's counts. Not changed here.
- The first real run is 2026-12-01 07:00 ET; check the numbers against the CRM's
  Collected revenue for November when it lands.
