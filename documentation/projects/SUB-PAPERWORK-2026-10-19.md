# Sub paperwork tracker (flag `subPaperwork`), 2026-10-19

Plan 1 of Jo's "all five" (2026-10-19). Ships DARK. Crews are independent
subcontractors: nothing here says employee, payroll or in-house.

Goal: one screen per sub that answers "do we have their W-9, are their
insurance papers current, how much did we pay them this year", plus a January
export for the 1099 prep. Alerts go to Jo only; nothing goes to a sub or a
customer (customer texting is OFF and untouched).

## What shipped (phases 1 to 4 of the plan; the Home strip is left)

| Piece | Where |
| --- | --- |
| Status fields on the sub doc | `firestore.rules` `subPaperworkOk` (called from `subWriteOk`) |
| Pointer docs for files | `companies/{id}/subs/{subId}/papers/{paperId}` (rules: `match /papers/`) |
| Private files | `storage.rules` `sub-papers/{companyId}/{subId}/{file}` |
| Pure logic (chips, totals, CSV) | `docs/pro/js/sub-paperwork-logic.js` |
| UI (Expenses tab card, list, sheet, 1099 prep) | `docs/pro/js/sub-paperwork.js`, `docs/pro/css/sub-paperwork.css` |
| Daily expiry watch (owner only) | `functions/sub-paperwork-watch.js`, `sub-paperwork-logic.js`; env `SUB_PAPERWORK_WATCH_ENABLED` |
| Tests | `tests/sub-paperwork-2026-10-19.test.js`, `tests/firestore-rules.sub-paperwork.test.js`, `tests/storage-rules.sub-papers.test.js` |

## Data model

On `companies/{id}/subs/{subId}` (all optional, all bounded by the rules):
`legalName`, `entityType`, `w9Status` (`none` / `requested` / `on_file`),
`w9ReceivedOn`, `glExpiry`, `wcExpiry`, `wcExempt` (+ `wcExemptNote`),
`licenseRequired`, `licenseNote`, `licenseExpiry`, `paperworkNote`,
`paperworkReviewedAt`. `insuranceExpiry` stays the older name for the liability
date; the tracker writes both so the Production roster warning keeps working.

Files: `sub-papers/{companyId}/{subId}/{ts}_{name}.{pdf|jpg}`; the pointer doc is
`{ kind: w9 | gl_coi | wc_coi | license | other, storagePath, fileName,
uploadedAt, uploadedBy }`. Never a URL or a `?token=` link.

## Who can do what

- **Write** (fields, files): the solo owner or the company's `company_admin`.
  A manager still edits the roster, but a write that sets or changes one of the
  paperwork fields is refused (`subPaperworkWriter`).
- **Statuses and totals**: read by the roster's readers; the UI shows the card
  to owner, company_admin, manager, viewer and platform admin. A `sales_rep`
  sees nothing in the UI (the existing roster read rule is unchanged).
- **Files** (the Firestore pointers and the Storage objects): the solo owner and
  `company_admin` only. Not a manager, a viewer, a sales rep, another company
  and not the platform admin. Chosen because a W-9 holds a tax ID.

## Privacy decisions

- **No SSN / EIN is stored or typed anywhere in the CRM.** The rules refuse a
  key named like a tax ID and refuse free text that holds one (SSN, EIN or nine
  digits in a row; a 10-digit phone number is fine). The form refuses the same
  text. No last-4 field either: not needed, so not built.
- Files open through the signed-in SDK (`getBlob` into a `blob:` URL, the
  shared `NBDProofPhotos` opener), never `getDownloadURL`: a download URL carries
  a permanent token. `proof-photos.js` `PATH_RE` got one more private prefix
  (`sub-papers/`); every earlier path is still refused or accepted exactly as before.
- Photos are re-drawn on a canvas (EXIF and GPS dropped) before upload; PDFs go
  as is. Images and PDFs only, under 25MB. A paper is immutable: upload a new one
  and remove the old.
- The 1099 export carries no tax ID. It says "Confirm thresholds, who needs a
  1099, and filing deadlines with your CPA." and states no threshold or deadline.
- Cash paid and never logged is not in the totals; the screen and the CSV say so.

## 1099 prep (January)

Expenses tab > Sub paperwork > 1099 prep. Pick a calendar year. Per sub: legal
name, total paid, payment count, split by method, W-9 status, flags (no W-9 on
file; payee not matched to a roster sub; payments with no method). Source is
plain `/expenses` rows with category `subcontractor` (so it covers the cash
payout log, the job cost auditor and the sub payments sorter without depending on
their code). Deleted rows and `estimated: true` rows are not counted; estimated
ones are named as left out. Payees that match no roster sub (by `subId`, name key
or alias) are listed in an "Unassigned" block so nothing is dropped. Matching
reuses the sorter's `payeeKey`. CSV (Excel-safe: leading `= + - @` defused) and Print.

## Alerts

`subPaperworkWatch`, daily 09:15 ET. For each active sub: liability date (or the
older `insuranceExpiry`), workers comp date unless exempt, license date only
when "needs a license" is on. At 30 / 14 / 7 days and when ended: one
Agent-inbox `report` (`agent_inbox/subdoc_<company>_<sub>_<kind>_<expiry>_<stage>`,
`create()`, so each stage files once; a renewal moves the date and starts fresh)
and one bell per company per day to the owner. No SMS, no email, no draft, no
message to a sub or customer. Missing dates raise no alert (the screen shows
"Missing"). Dry run (logs counts only) until `SUB_PAPERWORK_WATCH_ENABLED=true`.

## Turning it on (Jo)

1. Flag: set `subPaperwork: true` in `feature_flags/_default` in the Firebase
   console (Claude cannot write prod flags). Off = no card, nothing loads.
2. After deploy, read one `sub_paperwork_watch_dry_run` log line, then set
   `SUB_PAPERWORK_WATCH_ENABLED=true` in `functions/.env.nobigdeal-pro`.
3. Deploy `firestore.rules` and `storage.rules` with the PR (a push to `main` does).
4. Enter the dates by hand per sub (Expenses > Sub paperwork > the sub).

## Tests

- `node tests/sub-paperwork-2026-10-19.test.js`: bands (browser = server on 441
  dates), chips, the form, totals (deleted / estimated / other year / alias /
  unmatched), CSV, watcher (fake Firestore: dry run writes nothing; live files
  once), source guards, rules text.
- Emulator suites (see the header of each file for the command):
  `firestore-rules.sub-paperwork.test.js` (75 checks) and
  `storage-rules.sub-papers.test.js` (41 checks, with a positive control:
  the same object the owner reads is refused to every other identity).
- Mutation check (2026-10-19): each rule was removed in a scratch copy and the
  emulator suite went red; the table is in the PR body.

## Not done / follow-ups

- The "Paperwork due" strip on Home (plan screen 3). The daily inbox report and the
  Expenses card cover the alert for now; the Home strip needs a Home template mount
  like `#homeDocExpiry`.
- Phone-fit pass on a real iPhone (CSS follows the sorter's one-column rules; the
  layout gate will see it once a page renders the overlay).
- A one-time import of Alex's (CA Roofing) dates is by hand: tell Claude the
  dates and enter them in the sheet; nothing here writes prod data.
