# Firestore index coverage — catching missing indexes before prod does

*Written 2026-10-04. Scanner: [`scripts/check-firestore-indexes.js`](../../scripts/check-firestore-indexes.js);
gate: `tests/firestore-index-coverage-2026-10-04.test.js`; alert (not yet
created): [`monitoring/alert-firestore-missing-index.json`](../../monitoring/alert-firestore-missing-index.json).*

## The problem

The Firestore emulator never enforces indexes. A query that needs a composite
index passes unit tests, emulator suites and every E2E shard, then fails in
production with `FAILED_PRECONDITION: The query requires an index` — usually
caught and turned into an empty list, so the symptom is "the list is empty",
not an error (callWatch, 2026-10-02).

## The pre-merge gate

`node scripts/check-firestore-indexes.js` reads every query in `functions/`
and `docs/pro/js/` whose collection and fields are string literals — admin
chains (`db.collection('x').where(...).orderBy(...)`, ref variables like
`const col = db.collection('x')`) and modular calls (`query(collection(db,
'x'), where(...), orderBy(...))`, any `w.`/`window.`/`fs.` namespace) — and
checks each against `firestore.indexes.json`:

- **composite needed** when a query combines 2+ fields and at least one is an
  `orderBy`, an inequality, or `array-contains`. Equality-only queries are
  served by index merging. The index must match scope (`COLLECTION` vs
  `COLLECTION_GROUP` — a collection-group index does not serve a plain
  collection query), equality fields first in any order, then the sort fields
  in order and direction.
- **collection-group single-field** indexes are not automatic: a
  `collectionGroup(...)` query needs a `fieldOverrides` entry with a
  `COLLECTION_GROUP` index for each field (or a CG composite that covers it).

Dynamic queries (computed field names, spread constraint arrays, conditional
`q = q.where(...)` chains) are skipped or approximated; reviewed false
positives live in the test's `ALLOWLIST` with a dated reason. The test also
ratchets the number of queries scanned, so the scanner cannot silently go
blind.

First run (2026-10-04): 267 queries, two findings — `leads/{id}/recordings`
`where(userId ==) orderBy(recordedAt desc)` (the Voice Intel tab) had only a
`COLLECTION_GROUP` index, so the `COLLECTION`-scope index was added; the
other (`sms_log` in `isNewNumberForTenant`) is a conditional chain whose real
shape is indexed — allowlisted.

## The production alarm (to create)

```bash
gcloud alpha monitoring policies list --project=nobigdeal-pro --format="value(name,displayName)" | grep -i "missing index"   # must be empty
gcloud alpha monitoring policies create --project=nobigdeal-pro \
  --policy-from-file=monitoring/alert-firestore-missing-index.json
```

It is a `conditionMatchedLog` on Cloud Run (all Gen2 functions) for
`FAILED_PRECONDITION` + "requires an index", rate-limited to one notification
an hour, using the same two notification channels as the live policies in
[monitoring/README.md](../../monitoring/README.md). Client-side (browser)
queries never reach Cloud Logging — those are covered only by the scanner
(and by the browser error reporter if that ships).

Expected noise: it also fires during the few minutes an index is BUILDING
right after a deploy that adds one.
