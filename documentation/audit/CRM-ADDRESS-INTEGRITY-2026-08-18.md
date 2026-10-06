# CRM address integrity — audit & repair (2026-08-18)

Triggered by Jo: *"we may be having some serious address issues… we need to
make sure we can accurately and easily put the correct address into customer
files without any chance of number loss or accidental or forced reformat."*

He was right, and the damage is measurable.

## Headline

All 81 pipeline records were read out of `/leads` and each `address` checked
against the finished documents in Drive (`NBD/CUSTOMERS/<customer>/`).

| Class | Count | Job value |
|---|---:|---:|
| Pre-Wave-141 mangled | 6 | $20,645 |
| House number / suffix lost | 10 | $29,275 |
| City + ZIP only, no street | 35 | $9,751 |
| No address at all | 5 | $400 |
| **Defective total** | **56 of 81 (69%)** | **$60,071** |
| Complete | 25 (31%) | — |

## Root cause — already fixed in the write path

Six records carry a signature no human types and no correct formatter emits:
**a comma immediately after the house number**, an unabbreviated road name, a
Nominatim hamlet/subdivision where the post town belongs, and no state or ZIP.

```
[street address, mangled the same way]   (Larry)
[street address], Rivendell Estates                          (Customer AK)
[street address], O'Bannon Creek                        (Customer DR)
[street address], Franklin County                       (Customer AT — street name gone entirely)
[street address], Blue Ash                                  (Customer BX)
```

`docs/pro/js/dashboard-ui.js` already documents this exact bug and its fix at
`selectAcItem()`:

> Wave 141: produce a proper USPS-style mailing address using the structured
> nominatim addressdetails … Replaces the old `display_name.split(',').slice(0,3)`
> which produced "456, Example Road, Goshen" (wrong on every count: comma
> after house number, full road name instead of "Rd", missing ZIP, state
> spelled out, county included).

**The write path is sound.** `formatMailingAddress()` emits
`456 Example Rd, Goshen, OH 45122`. `customer-edit-modal.js saveCustomerEdits()`
only `.trim()`s — it does not reformat. Nothing overwrites a typed address today.

Corroborating evidence: every mangled row is **105–137 days old**; every record
created since is clean. This is legacy residue, not an active regression.

## What is NOT a code bug

The 35 city+ZIP-only rows are Thumbtack's shape — the marketplace withholds the
street until the customer shares it. Those addresses are *thin*, not corrupt.
The defect is that nothing in the product says so, and documents generate off
them anyway. Five invoices were generated on 2026-08-18 carrying only a city
and ZIP (Customer Q, Customer CG, Customer DG, Customer CK, Customer DU — $4,636.25).

## Three rows where the CRM contradicts a shipped document

| Customer | CRM | Document |
|---|---|---|
| Customer ET | `Kentucky Ave, Cincinnati, OH 45223` — no number | Invoice NBD-2026-0810-XXXX: **1944 _and_ 1942** Kentucky Ave |
| Customer DR | `[street address], O'Bannon Creek` | `[street address], Loveland, OH 45140` |
| Customer BZ | blank | Photo report: `[street address]` |

Anthony's is the structural one: **one job, two multi-family buildings.** The
schema has a single `address` string, so the second building cannot be
represented at all. This will recur — landlord work is a growth lane.

## Delivered

- `scripts/audit-lead-addresses.js` — read-only classifier over all `/leads`.
  `--list` / `--csv`. **Exits non-zero when any mangled or blank address
  remains**, so it can gate CI and the corruption cannot silently return.
  Thin-but-honest rows (`noStreet`) do not fail the run.
- `scripts/backfill-legacy-addresses.js` — repairs mangled rows from a
  hardcoded map of corrections, each transcribed from a finished NBD document.
  Dry-run by default; `--apply` requires `--yes`; **verify-before-write** (a row
  is only touched when its current value is byte-identical to `expectCurrent`,
  so a manual fix is never clobbered); idempotent. Rows with no verified source
  are reported, never guessed at.

Both pass `node scripts/check-js-syntax.js` (466 files clean).

## Open

1. **Multi-address support.** Anthony needs 1944 + 1942 on one job.
2. **Block document generation on an unverified address**, or stamp the draft.
   This is what would have caught the five thin invoices above.
3. **Wire `audit-lead-addresses.js` into CI** so the count can only go down.
4. **33 rows still need a street** — that is customer contact, not code.
5. **Add-lead UX:** `crm-leads.js:179` requires name AND address and renders the
   failure into an inline `mErr` element. A lead added without an address fails
   with no visible feedback in normal use — observed live 2026-08-18 while
   adding Customer DI.

## Wave 2 — same day, later

### 1. Multi-address support — SHIPPED

`serviceAddresses[]` on the lead. Four files:

- `docs/pro/customer.html` — "Additional Service Locations" rows under the
  address input, with add/remove.
- `docs/pro/js/customer-edit-modal.js` — `_readServiceAddressRows()` reads the
  DOM as the single source of truth, so a row typed but not blurred still
  saves. Header shows `(+N more properties)`.
- `docs/pro/js/document-generator-templates.js` — a SERVICE LOCATIONS block on
  the invoice, rendered only when at least one non-blank extra address exists.
- `docs/pro/js/doc-preflight.js` — hydrates `serviceAddresses` from
  `window._leadDoc`, trimmed and blank-filtered.

Regression coverage: 8 new assertions in
`tests/docgen-preflight-contract.test.js` (121 → 129), driven through the real
preflight→hydrate→render path, using Anthony's actual two buildings as the
fixture. They assert the block appears with both addresses, is **omitted
entirely** for a single-property invoice, filters blank/whitespace rows, and
escapes HTML.

### 2. Docgen address guard — SHIPPED, now gated

`tests/docgen-address-guard.test.js` was on disk but in no CI bucket, so
`scripts/run-test-manifest.js` failed its completeness check. Added to the
`node` bucket in `tests/ci-manifest.json`. 35/35 node suites pass.

### 3. The corrupt rows — repaired by re-running the fixed write path

The full `/leads` collection is **181 records**, not the 81 in the pipeline
view. Classified live:

| class | n |
|---|---|
| ok | 110 |
| noStreet | 41 |
| legacyMangled | 13 |
| noState | 11 |
| blank | 5 |
| noZip | 1 |

The insight that closed this out: the mangled strings are not lossy. They still
carry house number + road + locality, which is enough for Nominatim. So the fix
is to put each old string back through the *fixed* Wave-141 path —
`formatMailingAddress()` on fresh `addressdetails` — rather than transcribing
addresses by hand from Drive documents one at a time.

That is only safe with a guard, so each candidate must clear three checks
before it is written down:

1. house number byte-identical to the original,
2. first token of the street name byte-identical,
3. result inside OH / KY / IN.

12 of 13 cleared. The method independently reproduced the Customer DR
correction that had been transcribed from Drive — same string, character for
character, which is the strongest evidence available that the approach is
sound.

The one rejection is the point of the guard: `[street address], Franklin
County` (Customer AT, lost) geocoded to **123 Howard Rd, Phillips, Maine**.
Rejected on checks 2 and 3. It stays unfixed and stays in the audit.

Corrections live in `scripts/legacy-address-corrections.json`;
`backfill-legacy-addresses.js` now `require()`s that file and concatenates the
hand-transcribed entries. `expectCurrent` still gates every write.

> **Bug this fixed on the way past:** the hand-written Customer DR entry had a
> straight apostrophe in `O'Bannon`, but Firestore holds U+2019 (`O’Bannon`).
> The verify-before-write check would have skipped the row and reported drift.
> Generating the file from the live values removed the whole class of error.

### Still open

- **Customer BX is duplicated** — a `closed` record (corrupt address, fixed in
  this batch) and a separate `Estimate Sent` record holding only "[street] dr".
  Needs a merge, not an address.
- **41 rows need a street from the customer.** 4 are urgent: Customer Q, Customer AW
  and Customer CO are `crew_scheduled`, and Customer DU is `contract_signed` with a
  street but no house number — jobs booked at addresses we do not hold.
- **8 door-knock rows** spell the state as "Ohio"; mechanical, no contact needed.
- **A recurring audit is NOT wired.** `audit-lead-addresses.js` reads live
  Firestore, so it cannot join the credential-free deploy gate, and no
  scheduled workflow exists in `.github/workflows/` to model one on. Until one
  exists, "stays fixed" depends on someone running the audit.
- Add-lead UX (`crm-leads.js:179`) still fails silently — unchanged.

## Wave 3 — backfill applied, and what it exposed

### The backfill ran

All 12 corrections written to live Firestore. Re-audit over a fresh read of all
181 records:

| class | before | after |
|---|---|---|
| ok | 110 | **122** |
| legacyMangled | 13 | **1** |
| blank | 5 | 5 → 3 (see below) |

The only gate failure that is genuinely corrupt is now Customer AT's
placeholder, which the guard is deliberately refusing to touch. Every write
stored the original in `addressLegacy`.

Two records were retired as duplicates/junk rather than repaired:

- **Customer BX was in the CRM twice.** `jHQwrjX3CMtZgV7jZPkd` (NBD-0014,
  closed, reconciled to $3,145, final payment 9 May) is the real record.
  `WjwIwbjqtXJq10818RQS` was the original March door-knock lead, still sitting
  at `Estimate Sent` under a *different* companyId — which is why neither view
  showed both. The one thing it held that the survivor did not (the original
  "3365 all in / 2825 ridge only" quote breakdown) was carried across before
  it was retired. Soft-deleted with `mergedInto`; survivor stamped
  `mergedFrom`.
- `ZZ_WriteDiag DELETE_ME` — leftover write-diagnostic record, soft-deleted.

### Document delete control — SHIPPED

There was no way to remove a generated document from a customer record short
of the Firebase console. On this date that meant two invoices for the same job
— one with the wrong scope entirely (shingle repair language on a commercial
EPDM coating job) — sat on Customer ET's live record with no way to
take either down.

`docs/pro/js/customer-signed-doc-upload.js` gained `deleteCustomerDoc`, routed
through the existing `data-action` delegate (the page ships under a CSP that
forbids inline handlers). It is a **soft** delete: the row keeps its history
and gains `deleted: true`, `loadSignedDocs()` filters it out, and the file in
Storage is left alone — anyone already holding the link still resolves it,
which is the honest behaviour for a document that may already have been sent.

Fixed alongside it: the list read only `d.name`, but generated docs store
`filename`. Every generated document rendered as the label "Document", which
is precisely how two invoices for one job became indistinguishable in the UI.

`tests/customer-doc-delete.test.js` — 17 assertions, registered in the CI
manifest. Mutation-checked: removing `deletedAt` from the patch turns the
suite red, so it is not passing vacuously.

The wrong Anthony invoice (`bVD6UoxOnlO1M4FXOAvM`, 03:48, shingle scope) was
then retired through that same path. The correct EPDM one
(`RSVu2CneNaBvYP1NCE0Q`, 03:55) remains.

### Two document types that did not exist

Both were blocking real work, and neither was a missing template so much as a
missing *registration*.

**Receipt.** `document-generator.js` already had a `receipt` branch in
`_buildPremiumData` and in the server-render map, with a comment reading
"Receipt is a future call site (no client surface yet)" — but `receipt` was
never in `DOCUMENT_TYPES`, so nothing could produce one. Jobs paid in full
(Customer BZ, Customer EE) had no closing document. Added `DG.renderReceipt`, the
`receipt` DOC_SCHEMA in doc-preflight (including PayPal and Venmo, which the
invoice payment block still lacks), and a `computed.receiptNumber`.

The rule the tests pin down: **with no `contractTotal` supplied the receipt
shows no balance section and earns no PAID IN FULL stamp.** A balance we were
not told is a balance we must not assert — telling a customer their job is
settled when nobody said so is a worse failure than an ugly document.

**Roof Assessment Report.** The existing inspection template is
insurance-shaped — carrier, claim number and date of loss are all `required` —
so a homeowner who simply pays for an opinion on their roof had no deliverable
at all. Three paid inspections were outstanding (Customer BP, Customer FY, Customer FH).
Added `DG.renderRoofAssessment`: findings as *what I saw → why it matters*,
with rep-set severity (never inferred), and no placeholder photo boxes when
there are no photos — a padded report reads as unfinished work to someone who
has already paid for it.

Coverage: `docgen-preflight-contract.test.js` 129 → 163 assertions.

### Full gate run

`check-js-syntax` 466 clean · `check-inline-html-scripts` 0/207 ·
`run-test-manifest` 36/36 · `smoke` 3405/0 · `docgen-render` 349/0 ·
`docgen-preflight-contract` 163/0 · `docgen-brand` 27/0 ·
`customer-doc-delete` 17/0 · `check-site-integrity` 210 pages / 22730 refs / 0
failures.

### Still open after Wave 3

- **41 rows still need a street address from the customer.** Unchanged; this
  is contact work, not code. Customer Q, Customer AW, Customer CO (`crew_scheduled`) and
  Customer DU (`contract_signed`) remain the urgent four.
- **A recurring audit is still not wired.** Unchanged and still the weakest
  link in the "stays fixed" claim.
- Add-lead UX (`crm-leads.js:179`) still fails silently.
- The invoice payment block still prints Zelle as `info@` rather than the
  phone, and still offers no PayPal or Venmo. The new receipt schema has both;
  the invoice does not.

## Wave 4 — the recurring gate

`.github/workflows/address-audit.yml`. Daily at 11:00 UTC (~6-7am Cincinnati,
so a failure is in the inbox before the first call of the day), plus
`workflow_dispatch` with an optional `--list`. Reuses the existing
`FIREBASE_SERVICE_ACCOUNT` secret and follows the deploy workflow's convention
of a quick "skipped" notice rather than a failure email when it is unset.
firebase-admin is pinned to v12 (v14 breaks Timestamps in these scripts) and
installed into `$RUNNER_TEMP`, off the repo's dependency tree. The audit's exit
code is the gate; its full output is written to the job summary, because a red
check with no names in it is a red check nobody acts on.

### The bug that would have made this worthless

`audit-lead-addresses.js` counted **soft-deleted** rows. The app never destroys
a lead — it sets `deleted: true` — so merged duplicates and retired test
records sit in `/leads` permanently. Wiring the workflow as-is would have
produced a gate that could never go green, and a check that is always failing
is a check nobody reads. Found before shipping, not after.

Fixed: rows with `deleted === true` are skipped and reported on their own line
(`scanned: N (plus M retired/soft-deleted, not counted)`) so the exclusion is
visible rather than silent. `deleted: false` — the app's normal value — is
still live.

`tests/address-audit-script.test.js` — 11 assertions, registered in the CI
manifest. It drives the **real** script against a stubbed `firebase-admin`
(loader-level stub, so no credentials and no network) and asserts the exit code
in both directions: thin `noStreet` rows pass, mangled and blank rows fail,
retired rows do not fail, and a live broken row still fails when retired rows
are present alongside it. Mutation-checked: removing the skip turns 4 of the 11
red.

### Also cleared in this pass

- **Customer BZ' address written** — `[street address], Cincinnati, OH 45244`,
  sourced from the filename of their own photo report in Drive. (An earlier
  attempt was blocked; retried successfully.)
- **3 more `noState` rows repaired** by the same re-geocode + three-guard
  method: [street address], [street address], [street address]. Two were
  correctly REJECTED — Customer DS's geocode dropped the house number
  entirely, and `[street address]-Murdoch Rd` returned no match at all.

### Live-record state after Wave 4

Excluding soft-deleted rows, of 162 live records: **118 fully mailable**,
38 `noStreet` (need the customer), 2 `noState`, and 4 gate failures — three
dead leads (Customer X, AJ, Customer AT's placeholder) plus Customer EW
, parked at the user's request.

### What is still not automated

Nothing, on the address-integrity side. The write path is fixed, doc
generation blocks on an incomplete address, the corrections are data rather
than hand-edits, and the gate now runs on its own every morning. The remaining
38 thin addresses are customer contact, which no workflow can do.

## 2026-08-26 — the daily gate is red for the right reasons

The Wave-4 workflow has fired six times (2026-08-20 → 08-25, daily ~11:15Z)
and failed every fire, ~20s per run. A WEEKLY_CADENCE queue item written
2026-08-25 guessed "missing Actions secret" from the durations alone — wrong
twice over, corrected here and there. The workflow skips **green** when
`FIREBASE_SERVICE_ACCOUNT` is unset (its designed convention, §Wave 4), so a
red run can only be the audit itself failing. The logs of run 32841361980
(08-25 fire) confirm the gate is doing exactly what it was built to do, and
the four failures are the **same four records this doc inventoried at ship
time** ("Live-record state after Wave 4"). Nothing broke; the gate is
waiting on the records.

The four, from the run output (all $0 leads):

| id | lead | class |
|---|---|---|
| `DpjsBG8qzrJKLwhrU9oj` | Customer AT | the pre-Wave-141 placeholder the backfill guard refuses to geocode (§Wave 2) |
| `9WWbu37dEHt7u6MfiihW` | Customer X | blank |
| `KQASizQhFLDH0tjgfFf1` | Customer EW | blank (parked at Jo's request, §Wave 4) |
| `kBNTUsTFSE7hBY8u5ukU` | AJ | blank |

The fix is Jo's, in NBD Pro, ~2 min: open each lead and either complete the
address or retire the lead (retired rows are skipped by design — §Wave 4's
soft-delete fix). The gate self-greens on the first 11:00 UTC fire after.

Rest of the 08-25 snapshot, for the trendline: scanned 174 live (+19
retired), 118 complete ($381,893 of pipeline), 50 street-less rows
($12,476.25 — Thumbtack shape, grown from 38 at Wave 4: a week of new
inbound lands thin), and 2 no-state rows — Customer DS ($0) and
`vs8xdVKbFT3g8rzhkIuf` **Nick/Gabby Customer BN at $23,600, missing only its
state**. Those two are exactly the rows Wave 4's re-geocode correctly
rejected, so they need a human. Customer BN is the money item: one field from
mailable on the biggest thin job in the book.

## 2026-08-27 — script ported to `_admin`, and the gate is green

Two updates, one code and one data.

**Code.** `scripts/audit-lead-addresses.js` still initialised firebase-admin
through the legacy namespace (`admin.credential.applicationDefault()` /
`admin.firestore()`), which v14 removed — `functions/node_modules` now holds
14.3.0, so every local run threw `Cannot read properties of undefined
(reading 'applicationDefault')` before scanning anything. The daily workflow
never noticed because its scratch NODE_PATH install is pinned to v12, where
the namespace still exists. Ported to the shared entrypoint
(`scripts/_admin.js`: `initAdmin` + `getFirestore`), same as the other
nineteen scripts; classify regexes, `--list`/`--csv`, exit codes and the
`deleted === true` skip are untouched. Verified against prod both ways:
v14.3.0 out of `functions/`, and a scratch firebase-admin@12.7.0 via
NODE_PATH replicating the workflow's invocation — identical output, exit 0.
The Wave-4 note above ("stubbed `firebase-admin` at the loader") is stale as
of this port: `tests/address-audit-script.test.js` now stubs `./_admin` at
the loader instead, same hermetic contract, all 11 assertions green with no
firebase-admin installed at all. The workflow's v12 pin is now compatibility
padding rather than a requirement for THIS script — it uses no Timestamps —
but is left alone; other scripts it might someday share the scratch install
with still care.

**Data.** The 08-27 prod run (read-only) is the first GREEN snapshot: the
four broken records inventoried on 2026-08-26 are gone (retired rows went
19 → 23 — completed or retired in NBD Pro, exactly the fix that section
prescribed), so the daily gate self-greens on its next 11:00 UTC fire.
Trendline: 173 live (+23 retired), 119 complete ($405,493.19 of pipeline),
53 street-less ($12,476.25), and **one** `noState` row left — Customer DS
($0). The Customer BN record ($23,600, 08-26's money item) got its state and now
sits in the OK bucket.

## Source

Full customer-facing breakdown with per-record detail lives in the Cowork
artifacts `nbd-address-audit` and `nbd-address-ledger` (2026-08-18).

## 2026-08-27 — gate CLEARED (Jo-directed, executed from a session)

Jo delegated the queue item. All writes verify-before-write, prod, ADC:

- **The four $0 gate-failers retired** (soft-delete: `deleted: true` +
  `deletedAt` + a `deletedReason` naming this action — recoverable, and the
  shape the gate's skip predicate reads): Customer AT `DpjsBG8qzrJKLwhrU9oj`
  (the legacyMangled placeholder), Customer X `9WWbu37dEHt7u6MfiihW`,
  Customer EW `KQASizQhFLDH0tjgfFf1`, AJ `kBNTUsTFSE7hBY8u5ukU` (blanks).
  Identities confirmed against this doc's table before writing.
- **Customer BN `vs8xdVKbFT3g8rzhkIuf` ($23,600) is now fully MAILABLE**, not
  just state-patched. The reason Wave 4's re-geocode rejected it was a
  one-letter typo: the road is [street] **Murdock** Rd, not Murdoch.
  Corrected spelling geocodes unambiguously (single road, single postcode:
  [street], Hamilton Twp, Warren County, OH 45122; USPS post town Goshen).
  Written: `[street address], Goshen, OH 45122`; prior string
  preserved in `addressPrev`. Classifies `ok`.
- **Read-back by replicated gate scan** (same classify/skip logic, full
  collection): 173 live scanned, 23 retired skipped,
  `legacyMangled: 0, blank: 0` → **the 11:00Z fire self-greens**.
  Remaining non-gating trendline: 53 noStreet (thin Thumbtack inbound),
  1 noState (Customer DS, $0 — still the one human-review row).

Also noted for the next tooling pass: `audit-lead-addresses.js` still uses
the legacy firebase-admin namespace (`admin.credential.applicationDefault`),
which v14 removed — it runs in CI but throws locally; migrating it to
`scripts/_admin.js` is the one-line-per-import fix its header prescribes.
*(2026-09-02: done — ported in #1318/#1329 and the workflow's `NODE_PATH`
pin removed in #1330; `scripts/audit-lead-addresses.js:52` now requires
`./_admin`. Nothing left to do here.)*
