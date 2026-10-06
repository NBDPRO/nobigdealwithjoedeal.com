# Finishing the `scripts/_admin.js` migration — and killing the Timestamp myth (2026-09-01)

> **Update 2026-09-01 (same day, later session):** the "next migration tranche"
> §6 names — `import-cost-rotation.js` and `import-job-template-costs.js` — is
> **done**, and the `scripts/_admin.js` migration is now **complete**: zero
> legacy-namespace calls remain anywhere under `scripts/`, and
> `tests/smoke/functions.test.js` now fails if one comes back (it had only ever
> walked `functions/`). See
> [ADMIN-SCRIPTS-COST-IMPORT-PORT-2026-09-01](ADMIN-SCRIPTS-COST-IMPORT-PORT-2026-09-01.md).
>
> Two corrections to this note fall out of that work, both detailed there:
>
> - **§1's finding does not generalise the way it reads.** "Check what the
>   script reads first" was right, but both cost importers *do* write a server
>   timestamp, so the question had to be re-asked — and answered affirmatively
>   this time. It cost nothing: on v12, `admin.firestore.FieldValue` is `===`
>   the modular `FieldValue`, so v14 removed the *accessor*, not the class.
>   `ServerTimestampTransform.toProto()` is byte-identical across both, and a
>   v12 write and a v14 write read back as the same `Timestamp`.
> - **§6's boilerplate inventory undercounts.** `export NODE_PATH=<v12>`
>   survives in **six** scripts, not one — see that note's §7 for the list.

**Trigger:** the last two scripts in `scripts/` still doing a bare
`require('firebase-admin')` — `audit-legacy-documents.js` (read-only) and
`backfill-legacy-addresses.js` (writes prod `/leads`). Both died with
`MODULE_NOT_FOUND` before reaching Firestore, because neither `scripts/` nor
the repo root has `node_modules`.

**Outcome in one line:** both ported to `scripts/_admin.js`; a copy-pasted
docstring warning that had propagated to seven scripts was disproved and
corrected; a test that would have silently stopped testing was caught; and the
backfill turned out to be **already 12/13 applied in prod**, not 0/13 as the
brief assumed.

Companion note: [CRM-ADDRESS-INTEGRITY-2026-08-18](CRM-ADDRESS-INTEGRITY-2026-08-18.md),
which shipped the audit + backfill scripts this session finishes wiring up.

---

## 1. The "v14 breaks Timestamps" warning is false — and was never true here

Seven scripts carried this verbatim in their SETUP block:

```
 * SETUP (admin-script-runner pattern — prod nobigdeal-pro via ADC, with
 * NODE_PATH pointed at a firebase-admin v12 install; v14 breaks Timestamps):
 *   export NODE_PATH=/path/to/fa12/node_modules    # firebase-admin@12
```

It is inherited boilerplate — the exact copy-paste propagation
`_admin.js`'s own docstring was written to describe. **Neither script it was
attached to reads a Timestamp at all:**

| Script | Fields actually read | Ordering |
| --- | --- | --- |
| `audit-legacy-documents.js` | `leadId`, `deleted`, `filename`, `name`, `url`, `htmlUrl`, `signedDocumentUrl`, `userId` — strings + one boolean | `.orderBy('__name__')`, a string literal — no `FieldPath.documentId()` |
| `backfill-legacy-addresses.js` | `address`, `firstName`, `lastName` — all strings | same |

Timestamps genuinely **do** sit on those documents (`uploadedAt`, `createdAt`,
`signedAt`, `date`). The scripts just never touch them. Run against real
firebase-admin **14.3.0** `Timestamp` objects with `--list`: no throw, no
`[object Object]` leak, byte-identical verdict.

The real v12/v14 hazard is **dual-install**: two `Timestamp` classes in one
process, across which `instanceof` fails. `_admin`'s single resolver is what
removes it. The warning had attached itself to the wrong thing.

> **If you meet this line in another script, do not re-litigate it.** Check
> what the script reads first. As of this session it survives in
> `scripts/backfill-pins-to-knocks.js` and `.github/workflows/address-audit.yml`
> — see §6.

## 2. `NODE_PATH` defeats `_admin`, it does not feed it — verified

`_admin.js` tries a **bare `require.resolve` first** and only falls back to the
`functions/` resolver on failure:

```js
let req = require;
try { require.resolve('firebase-admin'); }
catch (_) { req = require('module').createRequire(.../functions/package.json); }
```

Tested directly rather than reasoned about:

| Condition | `require.resolve('firebase-admin')` from `scripts/` | Which install wins |
| --- | --- | --- |
| No `NODE_PATH` | throws `MODULE_NOT_FOUND` | falls back to `functions/` ✅ |
| `NODE_PATH` set to a v12 tree | **resolves** to the `NODE_PATH` copy | `NODE_PATH` silently wins ❌ |

So telling a reader to `export NODE_PATH=<v12>` instructs them to override the
single-resolver guarantee `_admin` exists to provide. The `export NODE_PATH=`
line was **deleted**, not merely updated, and the replacement docstring says
"Do NOT set NODE_PATH" and why.

Note this makes the wording inherited from `audit-lead-addresses.js:38-42`
("or whatever `NODE_PATH` points at — which is how the daily workflow supplies
its pinned v12 install") an accurate description of what CI does but a bad
instruction for a human. The new scripts do not repeat it.

## 3. The two-file trap: a stub that stops stubbing

`tests/legacy-documents-audit.test.js` intercepts the module loader on
`request === 'firebase-admin'` at **two** sites — `runAudit()` and
`loadExports()`. The moment the script stops requiring that string, both stubs
go dead and the **real** `_admin` loads.

Failure modes are asymmetric, and that is the danger:

- **In CI** (no ADC, no `functions/node_modules`) → throws, fails loudly. Fine.
- **On a developer machine with `GOOGLE_APPLICATION_CREDENTIALS` set** —
  exactly how the script's own docstring says to run it — → the suite performs
  **live prod reads** and asserts against real data instead of its fixtures.
  Read-only, so nothing is damaged. The test simply stops being a test while
  continuing to print green.

Both sites now intercept `'./_admin'` with an
`{ initAdmin(){}, getFirestore: () => ({...}) }` stub, matching the working
template at `tests/address-audit-script.test.js:54-66` (whose comment already
named this hazard).

**Proved live by negative control** rather than assumed: point the intercept at
a string the script does not require, and the real `scripts/_admin.js` loads
and crashes at line 46. With the correct string, 14/14 pass and `_admin` never
enters the require cache.

> Generalisable: a loader stub keyed on a module *string* is coupled to an
> implementation detail of the file under test. Any refactor of the import
> silently unhooks it. If you change what a script requires, grep the test for
> the old string — there may be more than one site.

## 4. `updatedAt` dropped from the backfill write (Jo's call)

The write was `{ address: c.correct, updatedAt: new Date() }`. It is now
`{ address: c.correct }` only.

An address repair is a **data correction, not a customer interaction**, and
three consumers read `updatedAt` as though it were one:

| Consumer | What it does with `updatedAt` | Consequence of stamping it |
| --- | --- | --- |
| `analytics-kpi.js:496-499` — `monthlyTrend` | buckets won-lead revenue by `updatedAt`, **no `stageStartedAt` fallback** | a closed-won lead's `jobValue` moves out of its real close month into the month the backfill ran |
| `ask-joe-proactive.js:56` — `_lastTouch` | falls through to `updatedAt` | a cold lead looks freshly contacted; its follow-up nudge stops firing |
| `crm-list-view.js:77` — `_activity` | sorts on it | reorders the list |

The first one is the expensive one, and the repo **already fixed this exact
bug** for the sibling `closedThisMonth` KPI at `analytics-kpi.js:171-177`,
whose comment reads: the old `updatedAt` proxy "re-attributed a March close to
July the moment you added a note to it." `monthlyTrend` never received the same
`stageStartedAt || updatedAt` fallback.

**`monthlyTrend` was then fixed in this same PR** (Jo's call, after the dry-run
made the stakes concrete) — one line, `l.stageStartedAt || l.updatedAt`,
identical to its sibling. Dropping the write only avoided *provoking* the bug;
any other path that stamps `updatedAt` on a won lead was still mis-attributing
revenue. Regression test added to `tests/dashboard-kpi.test.js` (already in
`ci-manifest.json`); the discriminator is a lead that closed **last** month and
was edited **this** month, and a fourth case pins the fallback so
pre-migration rows with no `stageStartedAt` still date by `updatedAt` instead
of dropping off the chart. Verified by negative control: revert the one line
and 3 assertions fail.

This was not hypothetical. The single lead this branch corrected in prod
(`HEiG1d11LRfpaMyIgqNq`) is `stage: closed`, `jobValue: 2500` — stamping
`updatedAt` would have moved **$2,500 from August into September** on the trend
chart. The read-back after the apply confirms `updatedAt` still reads
`2026-08-18T03:55:15.479Z`.

Side benefit: the docstring's SAFETY claim gets strictly stronger, from
"only ever writes `address` (+ `updatedAt`)" to "only ever writes `address`".

## 5. What prod actually looked like — the brief's premise was stale

The brief predicted 13 `FIX` lines against a collection full of mangled
addresses. Reality, measured this session against `nobigdeal-pro`:

**Baseline — `audit-lead-addresses.js`:**

```
  BROKEN  pre-Wave-141 mangled           0     0%   $0
  BROKEN  no address at all              0     0%   $0
  THIN    city/ZIP only, no street      60    33%   $12,476.25
  THIN    no state                       1     1%   $0
  OK      complete                     119    66%   $405,493.19
  scanned: 180   (plus 23 retired/soft-deleted, not counted)
  PASS — no mangled or blank addresses remain.
```

**Dry-run — `backfill-legacy-addresses.js`:** 12 `ALREADY`, **1** `FIX`,
0 drifted, 0 missing, 0 unresolved mangled.

So the 2026-08-18 backfill **did** land — on v12, back when the `NODE_PATH`
path still worked. The script has never run on v14, but "never run" was not the
same as "never applied", and the two got conflated.

Two specific worries in the brief both cleared:

- **`JoKt4d0yJeF51MTmjaJh`** (Customer DR), whose byte-equality gate depends
  on a `U+2019` in `scripts/legacy-address-corrections.json`, reported
  `ALREADY` — not `SKIPPED`. The apostrophe survived. JSON is git-clean.
- **`inspect_leads__GgomiGANIbdd8zPmzqwH`**, whose id looks like a
  copy-paste artifact, is a real document — reported `ALREADY`, not `MISSING`.

The single remaining correction was **Customer ET**
(`HEiG1d11LRfpaMyIgqNq`, jobValue $2,500):

```
"[customer's property LLC] - Kentucky Ave, Cincinnati, OH 45223"
  →  "[street address], Cincinnati, OH 45223"     src: Invoice NBD-2026-0810-XXXX
```

Note it is classified **`noStreet`**, not `legacyMangled` — one of the 60 THIN
rows, not corruption. So applying it **cannot change the mangled count**, which
was already 0; the brief's verification step ("confirm the mangled count
dropped by the number written") does not apply. What it does is move one row
THIN → OK.

**Applied 2026-09-01** on Jo's go-ahead: `written: 1, failures: 0`. Verified
three ways rather than trusting the script's own summary —

| Check | Result |
| --- | --- |
| Read-back of the doc | `address` = `"[street address], Cincinnati, OH 45223"` ✅ |
| `updatedAt` after the write | still `2026-08-18T03:55:15.479Z` — **untouched**, so the $2,500 stays in August ✅ |
| Re-run of the audit | `noStreet` 60 → 59, `OK` 119 → 120, and exactly $2,500 moved between the two buckets ✅ |

The audit still reports **PASS**. Nothing else in prod was written.

## 5b. Bonus: the legacy-documents question now has an answer

`audit-legacy-documents.js` exists to decide one thing — is the legacy merge
read in `docs/pro/js/customer-documents.js` still load-bearing? Porting it made
it runnable, so it was run:

```
  LEAD-SCOPED  live, needs the merge read       0
  lead-scoped  soft-deleted (filtered out)      0
  company doc library (NOT ours, leave it)      0
  scanned: 0
  VERDICT — no live lead-scoped rows survive.
```

**A zero here produces the expensive verdict** ("safe to delete"), which is
exactly failure mode #1 the test suite was written to guard against — so it was
verified independently rather than taken at face value:

| Probe | Result |
| --- | --- |
| Control read of `/leads` | 3 docs — credentials and read path work |
| `/documents` direct probe | 0 docs |
| `db.listCollections()` | **`documents` is not in the list at all** (Firestore only lists collections holding ≥1 document) |

The zero is real. The top-level `documents` collection holds nothing in
`nobigdeal-pro`.

**The docstring's `⚠ NOT DEAD` warning still stands, though** — do not
"clean up" the collection. `docs/pro/js/dashboard-api.js:358` writes it and
`:371` reads it back for the company-wide document library. (Spelled
`collection(window._db,'documents')` with no space after the comma, which a
`collection('documents')` grep misses — worth knowing before concluding from a
grep that nothing writes it.) The collection is empty because that upload
feature has not been used yet, not because it is unwired.

So the merge read is deletable on the evidence, but that is a separate change
with its own blast radius, and this session did not make it.

## 6. Open items this session did not close

| Item | Where | Why it is left |
| --- | --- | --- |
| ~~`monthlyTrend` has no `stageStartedAt` fallback~~ | `docs/pro/js/analytics-kpi.js` | **CLOSED in this PR** — see §4. One line + a 4-assertion regression test. |
| ~~`admin.apps` / `admin.firestore()` on v14~~ | `scripts/import-cost-rotation.js`, `scripts/import-job-template-costs.js` | **CLOSED — [ADMIN-SCRIPTS-COST-IMPORT-PORT-2026-09-01](ADMIN-SCRIPTS-COST-IMPORT-PORT-2026-09-01.md).** These two *did* resolve (they carried a `functions/` `createRequire` fallback), so they were not `MODULE_NOT_FOUND` — they used the v14-removed namespace off the default export, failing *later* and *differently*, which is exactly why the "bare require fails" framing missed them. **Three** breakages each, not one: the third was `admin.firestore.FieldValue.serverTimestamp()` at `:227` / `:201`. Both ported; the migration is complete and now CI-pinned. |
| Stale Timestamp boilerplate | six scripts (list in the companion note's §7), `.github/workflows/address-audit.yml` | Not touched this session, and **still open** — the inventory here undercounted; `export NODE_PATH=<v12>` survives in six scripts, not one. The workflow additionally pins firebase-admin v12 via `NODE_PATH` on the stated rationale that "v14 changed Timestamp handling in a way that breaks the admin scripts in `scripts/`" — §1 and §2 say that pin is both unnecessary and actively counterproductive. Unpinning it is a CI change deserving its own PR. |
| No test for `backfill-legacy-addresses.js` | `tests/` | The audit has one; the script that *writes prod* does not. |

## 7. Gates run

`check-js-syntax.js` (471 files clean) · `tests/legacy-documents-audit.test.js`
(14/14) · `tests/address-audit-script.test.js` (11/11) · live dry-run against
`nobigdeal-pro`. Both scripts confirmed to reach Firestore and complete.
