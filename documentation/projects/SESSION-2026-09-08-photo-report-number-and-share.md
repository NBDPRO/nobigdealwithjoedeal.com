# Session 2026-09-08 — the report number, and the link that did not exist

Branch: `claude/sharp-wescoff-5fa42a` · PR
[#1499](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/1499),
based on `main`.

Closes open items **1 and 7** of
[SESSION-2026-09-08-photo-report-builder](SESSION-2026-09-08-photo-report-builder.md),
which are §9 items 1 and 6 of [NEXT_SESSION-2026-09-09](NEXT_SESSION-2026-09-09.md).

---

## The base moved mid-session, and that is the process note

Both gaps live in code [#1483](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/1483)
introduced. When this started, #1483 was **open**: `_fileReportOnLead` and the
builder session note did not exist on `main`, so a `main`-based branch would
have been writing a share path for a row nothing wrote yet. It was therefore
built and opened as a **stack on `fix/photo-report-render-defects`**.

**#1483 merged at 18:41 UTC, while this work was in flight.** The stacked PR
went `CONFLICTING` against a base that had moved under it. Because this repo
**squash-merges**, #1483's eleven commits are in `main` only as content, not
as ancestry — so a rebase would have replayed all eleven against a tree that
already had them. The fix was to reset onto `origin/main` and **cherry-pick the
two commits that are actually mine**, which conflicted in exactly one place: the
suite-count ratchet.

Two things worth carrying:

- **`git rev-list --left-right --count` lied to me first.** It said `13 0` —
  "the branch already contains `main`" — and `merge-base --is-ancestor` said the
  opposite a minute later, because the count was taken against a remote ref the
  fetch in the same command chain had not yet moved. Same trap as
  [diff-against-a-moved-main](NEXT_SESSION-2026-09-06.md). **Check ancestry, not
  a count you took earlier**, and re-check it when the answer matters.
- **The floors had to be MEASURED again, not carried across.** This branch was
  written against 98/181 and correctly reported 99/182 there. On the merged tree
  the true value is **104/187** — arithmetic from the old base would have been
  wrong twice over, which is precisely the rule `run-test-manifest.js`'s own
  comment history already states ("MEASURED on the merged tree, not 101+2 by
  arithmetic").

After the cherry-pick every removed line in the diff against `main` was checked
individually, because a reset onto a moved base is how you silently revert
someone else's work: one removed line in the client (the old `reportNumber`
assignment) and 39 in `functions/report-sharing.js`, all of them mine, all moved
or rewritten rather than dropped.

---

## 1. The report number was a clock reading

```js
const reportNumber = (mode === 'adjuster' ? 'ADJ-' : 'PHO-')
  + Date.now().toString().slice(-6);
```

Since #1483 gave the renderer a working running footer, that string is on the
cover, in the masthead, **and on every page**. It is the thing a homeowner or an
adjuster quotes back. And it changed on every regeneration of the same report,
so "report PHO-482913" named a document that stopped existing under that name
the moment the rep re-rendered it. Two reports rendered in the same millisecond
window collided outright.

### The shape

```
<TENANT>-<PHO|ADJ>-<YYYY>-<MMDD>-<NNNN>          NBD-PHO-2026-0908-4471
```

The date convention is the one the hand-built client PDFs already use
(`NBD-2026-0902-XXXX`,
[SESSION-2026-09-07-client-pdfs-and-drive-tidy](SESSION-2026-09-07-client-pdfs-and-drive-tidy.md)).
The type infix is the one the CRM's own generators already use — `-V2-` on
estimates (`estimate-v2-ui.js:69`), `-WC` on warranty certs
(`document-generator-templates.js:437`). Keeping `PHO`/`ADJ` preserves the
distinction the old number carried, which matters because the two modes are
genuinely different documents on the same lead.

### Two things that are load-bearing

**The prefix is `_tenantIdPrefix()`, never a literal `'NBD'`.** This is a
multi-tenant CRM. `company-profile.js:619` and `estimate-finalization.js:267`
are both written up around what a hardcoded platform prefix does to a
contractor's own paper — a Summit Ridge estimate that promised an NBD warranty.
`_tenantIdPrefix()` is the right helper rather than `_tenantFilePrefix()`
because a *filename* may safely drop the prefix and an *identifier* may not
(`-2026-0908-4471` is the orphan `-0001` defect); it falls back to the neutral
`'CUS'`, never to another tenant's identity.

**`NNNN` is FNV-1a over `(leadId, mode)`, not the clock.** Same hash and the
same stated posture as `document-generator.js:757` `_seededDocNumber` — a
display reference, not an idempotency key. Seeding on the lead is what makes a
regeneration derive the *same* number even when the reuse lookup below fails.

### Assigned once, read back

`_filedReportNumber()` reads `leads/{id}/documents` and reuses the **earliest**
row for that mode. Three decisions inside that sentence:

- **Earliest, not latest.** A number is assigned once; the first row is the
  assignment and later rows are regenerations that should have carried it.
- **A legacy `PHO-482913` is reused as-is, not renumbered.** A number already in
  a customer's hands outranks a tidy format.
- **Equality-only query, sorted in memory** — the reason `customer-documents.js:88`
  gives for the same choice one file over. Two equality filters plus an
  `orderBy` needs a composite index, and an index-less query fails **closed**,
  which here would silently renumber a report that already had a number.

It never throws. A `viewer` on a teammate's lead is a real denial, and the
report has to render anyway.

### One ordering fix that came with it

`_resolveReportNumber()` awaits `_tenantIdPrefix()` **unconditionally**,
including on the reuse path that will not use the result. That call awaits
company-profile hydration, and everything after it reads `window._brand()`
*synchronously* to build the cover. `estimate-v2-ui.js:3377` is the write-up of
what happens otherwise: hydration there was "a side effect of an await sitting
inside an argument list… an accident, not a guarantee". A test pins the await
count, so moving it back inside the mint branch reddens.

---

## 2. A filed photo report could not be shared

`createReportShareToken` accepted only a `reportId` in the top-level `/reports`
collection. A filed photo report is a row in `leads/{leadId}/documents` with
`source: 'photo_report'` — so it could be downloaded and attached, and not
delivered as the link contractors increasingly send.

### Extending the token, not writing a `/reports` row

Both options were on the table. `getSharedReport` serves `report.html`, stored
inline — and **a photo report has no HTML.** It is Chromium output from a
Handlebars template. Filing it "somewhere the sharing path can already reach"
would mean maintaining a *second*, HTML rendering of the same document, so the
viewable copy and the downloadable copy would come off different renderers and
be free to disagree. #1483 had just finished removing one instance of exactly
that (a picker promising numbered photos the server template never emitted).

So the token now carries a `kind`:

| kind | subject | served as |
|---|---|---|
| `report` (default, and what every pre-existing token is) | `/reports/{id}` | inline HTML |
| `lead_document` | `leads/{id}/documents/{docId}` | the PDF, streamed |

An existing token has no `kind`, so it falls through to the HTML path untouched.

### The PDF is streamed, not redirected to

A redirect to a freshly signed Storage URL hands the viewer a credential that
**outlives the token**: it keeps working after the link is revoked or expires,
and it forwards on its own. Worse, where the compute SA cannot reach IAM
signBlob (`render-pdf.js:625`) the only URL available to redirect to is the
**never-expiring download-token** one — which would make "this link expires in
30 days", in the email this very function sends, a false statement.

Streaming keeps the token as the only credential and re-checks it on every load,
which is the posture the file header already claimed ("the homeowner never reads
Firestore/Storage directly"). It also means **`pdf-renders/` needs no public
Storage rule** — the admin SDK bypasses `storage.rules` entirely. That is
deliberate: gating `pdf-renders/` is its own queued task, and this must not
pre-empt it by requiring the objects to be client-readable.

`timeoutSeconds` went 15 → 60. The bytes are piped, never buffered, so the
memory floor is unchanged.

### The guard that matters: `storagePath` is attacker-controlled

A `documents` row is **client-writable** — `firestore.rules:389`, the clause
#1483 widened, admits the lead owner and same-company staff. So `storagePath` is
untrusted input to a function that mints an **unauthenticated public URL**.
Without a guard, a rep could point it at any object in the bucket — a
teammate's render, anything under `photos/` — and get a public link to it. That
is a privilege escalation, not a share feature.

Two independent guards, because either alone is weak:

1. **Syntactic.** The path must match `pdf-renders/{uid}/{file}` — the shape
   `render-pdf.js:588` writes. No traversal, no other prefix, no deeper nesting.
2. **Provenance.** The object's own custom metadata must carry the `renderedBy`
   stamp `render-pdf.js:596` writes, and that uid must be the caller or the
   lead's owner. **Storage object metadata is written by the renderer with the
   admin SDK and is not client-writable**, so it is the half a forged Firestore
   row cannot fake.

### Authorization mirrors the WRITE clause, not the READ clause

`firestore.rules:377` lets any company **reader** — `viewer` included — read a
lead's documents. `:389` lets only the owner or company **staff**
(`company_admin|manager`) write one. Minting a share link is an authoring act:
it publishes the document to anyone holding the URL. So the roles that may
attach a document are the roles that may hand it out. A `viewer` who can see
the report cannot broadcast it.

### Token reuse

A live token on the row is reused rather than minting a second one — otherwise
a rep who taps "Share link" twice hands out two URLs and revoking the one they
actually sent revokes nothing. Reuse is refused when the token is revoked,
expired, **or bound to a different `storagePath`** (the report was regenerated,
and the old token would serve the stale PDF forever).

The mint writes `shareToken` / `shareUrl` / `sharedAt` / `shareExpiresAt` back
onto the row, best-effort, which is what lets the Documents tab show that a
document has been shared. View tracking already existed on the token
(`viewedAt` / `viewCount`) and is stamped **before** the kind branch, so both
kinds are tracked.

### The rep's affordance

`customer-documents.js` offers "Share link" on a filed photo report, becoming
"Copy link" once one exists. Delegated `data-doc-share` handler — the CSP sets
`script-src-attr 'none'`, so an inline handler would be inert and silent. The
button is **not** offered where the callable would refuse it (no `storagePath`,
legacy top-level row, non-photo-report source), because a button that can only
return `failed-precondition` is worse than no button.

---

## Testing — 76 assertions, all executed

`tests/photo-report-sharing.test.js`, registered in `tests/ci-manifest.json`,
floors measured at `{ node: 104, smoke: 65, disk: 187 }` on the rebased tree. Nothing is grepped that
could be executed: both client files and the functions module are vm-sandboxed
and their real functions called. Every one of the interesting failures here
passes a shape test.

**All 18 breaks were applied individually and the reddened assertion checked
against the expected one.** Two findings came out of that, and they are the part
worth carrying:

### A back-to-back equality check cannot catch a clock-derived number

The first version asserted `mint(…) === mint(…)`. Reverting the fix to
`+ Date.now().toString().slice(-6)` **did not redden it** — two `Date.now()`
reads in the same millisecond return the same value. It reddened the *shape*
assertions instead, which is a different claim.

That is precisely why the original bug survived review: at the speed a test or
a reviewer runs, a clock reading looks stable. The assertion now **moves the
clock inside the sandbox** and requires the number not to move — and proves the
stub reached sandboxed code before trusting what it shows, using
`_reportSeed`'s no-parts fallback as the probe. Had I stopped at "the suite is
green", the headline fix would have shipped with no test that could see it.

### Two harness bugs that would have faked a stronger suite

- `endOfFn()` copied from the sibling suite finds the first `{` after the
  function name. `resolveLeadDocumentSubject(db, { uid, leadId })` **destructures
  its second parameter**, so that brace is the parameter list, brace-balancing
  closed the function at the end of the signature, and the sandbox got a
  fragment. It threw a SyntaxError here; wrapped in a `try`, it would have
  skipped a whole section silently.
- A regex anchor **without `/g`** makes `String.match` return capture groups
  rather than matches, so a one-group anchor reports "matched 2x". The break
  harness refused to apply it — which is the count assertion doing its job
  ([the 09-08 process note](SESSION-2026-09-08-photo-report-builder.md) is about
  exactly this) — but the reported reason was wrong and would have sent the next
  person looking for a duplicate in the source.

One more, smaller: `instanceof RegExp` is **false** across a vm realm boundary.
Caught because I added a "was this actually read" guard assertion next to the
two real ones, and only the guard reddened.

### Gates run

`run-test-manifest --check` (187 classified), all **104/104 node suites**,
`smoke.test.js` **3641 passed / 0 failed**, `marketing-polish-contract` 56,
`check-js-syntax` 496 files, `check-site-integrity` 243 pages / 0 failures,
`check-inline-html-scripts` 0 inline scripts, `build-sitemap` zero diff.

No `firestore.rules` change: `report_share_tokens` is `allow read, write: if
false` (admin-SDK only), the write-back to the document row is admin SDK, and
the new client read of `shareUrl` is covered by the existing read clause.

---

## Still open, and untouched here

From the #1483 list, unchanged and still **leads rather than findings** (that
verification pass lost 87 of its refuter agents to a session limit):

2. **`pdf-renders/` has no Storage rule.** Deliberately not touched — it is a
   separate queued task, and streaming was chosen partly so this work does not
   force a decision there.
3. **Annotations are destructive** — `photo-editor.js` persists no annotation
   array.
4. **Three incompatible `damageType` vocabularies** collide in one count.
5. **Customer-page uploads write no `createdAt`**, so report order is arbitrary
   for them.
6. **No measurements section**, though the CRM already pays for the data.

New, and small: a photo report filed **before** this change has a `reportNumber`
in the old format and will keep it forever, by design. There is no backfill and
there should not be one — renumbering a document someone may be holding is the
thing this change exists to stop.
