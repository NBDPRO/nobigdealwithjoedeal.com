# Company document expiry tracker (2026-10-18)

Build-plan Phase 4 item 1 (`BUILD-PLAN-2026-10-18.md`): the CRM tracked only the
**subcontractors'** insurance certificates (`certStatus` in
`docs/pro/js/production-logic.js`). Nothing tracked, or warned about, the
company's **own** papers. This adds that.

## What it is

| Piece | Where |
|---|---|
| Data | `companies/{companyId}/companyDocs/{docId}`: `type`, `name`, `issuer`, `expiry` (YYYY-MM-DD), `notes`, `fileRef`, `active`, timestamps |
| Types | GL certificate (COI), workers' comp / exemption, contractor / trade license or local registration, manufacturer certification, vehicle registration or insurance, other |
| Status logic (pure) | `docs/pro/js/company-docs-logic.js` (`NBDCompanyDocsLogic`); server mirror `functions/company-doc-expiry-logic.js` |
| Settings card | Settings → Company Profile → "Company documents" (`#companyDocsMount`), `docs/pro/js/company-docs-ui.js` |
| Home warning | `#homeDocExpiry` on the Classic Home, same file; shows only when something is within 30 days or expired |
| Alert | `companyDocExpiryWatch`, daily 09:00 ET, `functions/company-doc-expiry.js` |
| Rules | `firestore.rules`, "COMPANY DOCUMENTS" block under `companies/{companyId}` |
| Tests | `tests/company-docs-2026-10-18.test.js` (83, includes the real UI file in a stub DOM), `tests/firestore-rules.company-docs.test.js` (47, emulator, own CI step) |

## Status bands

Whole **local calendar days** between today and the expiry date (both read as
calendar dates, so there is no midnight or DST edge): `ok` more than 30,
`due30` 15 to 30, `due14` 8 to 14, `due7` 0 to 7 (0 = "Expires today"),
`expired` below 0. No date, or an unreal date, is `none` (never a false alarm).
The browser takes today from the device's local date; the server takes it in
the company's time zone (`companyProfile/{id}.timezone`, else Eastern).

## Who can do what (role decisions, 2026-09-25)

* Write (create / edit / delete): the solo owner or the company's `company_admin`. Never a viewer, **even a viewer whose uid is the company id** (that is the only case that isolates `notViewer()`; the rules test pins it).
* Read: owner, `company_admin`, `manager`, `viewer` (read-only), platform admin. A `sales_rep` reads nothing.
* Another company reads and writes nothing.

## Nothing sensitive on a public page

`fileRef` is **text saying where the paper lives** ("Drive > Company > Insurance >
COI 2026.pdf"). A URL, a Storage `?token=` link or a `firebasestorage` host is refused by
both the form and the rules, so no token link can be saved here, and nothing in
this feature is under `docs/` as data. The form tells the user not to enter
policy or account numbers; the alert text carries only name, kind and issuer.

## The alert

* One Agent-inbox **report** (`kind: 'report'`, no lead) to the owner per document per stage (30, 14, 7 days, expired), id `docexp_<company>_<doc>_<expiry>_<stage>` written with `create()`, so the daily run files each stage once and a renewal (new expiry date) starts a fresh set. A run that missed days files only the stage the document is in now.
* One bell notification per company per day (`notifications/docexp_<company>_<day>`).
* **Never a customer**: no SMS, email, draft or lead. A test asserts the sweep file has no Twilio / Resend / email path.
* **Ships dark**: `COMPANY_DOC_EXPIRY_ENABLED=false` in `functions/.env.nobigdeal-pro`. Anything but `true` computes and logs counts only (no document names) and writes nothing. **Not enabled.** To go live: read one dry-run log (`company_doc_expiry_dry_run`), then flip the value to `true` and deploy.
* The collection-group read has no `where`/`orderBy`, so it needs no index (the emulator does not enforce indexes; see `firestore-index-coverage-2026-10-04.test.js`).

## Break-tests (which assertion reddens)

Unit: 7-day band `<=` to `<` reddens "7 days left = due7", the rank ladder and the browser/server parity sweep; the same for the server's 14-day edge (parity, "14 days out", "days between 14 and 8"); reading today as the UTC date reddens "localYmd ... 23:59:59" and the fall-back-day case; "expired a day late" reddens "yesterday = expired"; dropping the stage from the alert id reddens the five dedupe/stage assertions; `create()` to `set()` reddens "live: files one report per due doc" (the fake has no dedupe on `set`, so this one is caught by the shape of the write, and "the same day again" is the dedupe pin); the flag read as `!== 'false'` reddens the default-off check; ignoring dry-run reddens "dry-run ... writes NOTHING"; removing the link check reddens the three link cases; including inactive rows reddens four roll-up assertions.

UI (stub DOM): removing `esc()` reddens "names and issuers are escaped"; letting every role read reddens "sales rep: nothing on either screen"; dropping the viewer check reddens "a viewer whose uid IS the company id still gets no Add / Edit / Remove" (again only that case isolates it).

Rules (emulator): dropping `notViewer()` reddens "a viewer whose uid IS the company id CANNOT write" (it was **not** red before that case was added: the viewer role alone never reaches the writer branch, so the first draft of the test was blind to the guard); any company_admin may write reddens "another tenant company_admin CANNOT write" and "another tenant CANNOT delete"; sales_rep in the read list reddens "a sales rep does NOT read"; removing the `fileRef` clause reddens the three link cases; removing `hasOnly` reddens "a smuggled field is denied"; un-tying read from the company reddens "another tenant company_admin does NOT read".

## Left for Jo to decide

1. Flip `COMPANY_DOC_EXPIRY_ENABLED` to `true` after one dry-run log.
2. Home warning is on the **Classic** Home only (`#homeDocExpiry`). The full-screen layouts (Field, Focus, Mission, etc.) have their own slots; adding one per layout is a follow-up if Jo wants it there.
3. No Storage upload of the document file itself (deliberately: a Storage URL is the thing the invariants forbid). If he wants the PDF attached, that needs a private-Storage design (signed, short-lived reads), not a stored link.
4. Seed his real documents (GL COI, KY/OH registrations, GAF / TAMKO / IKO certs, truck papers) in Settings → Company Profile. Nothing was seeded: the repo is public.
