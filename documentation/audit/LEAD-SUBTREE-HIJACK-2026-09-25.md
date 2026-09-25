# A deleted lead's rows belonged to whoever re-created its id (2026-09-25)

**Result.** When a lead was hard-deleted, most of what sat under it stayed in
Firestore: notes, tasks, activity, drawings, saved homeowner signatures,
portal messages. Any signed-in user of any tenant who then created a lead at
the same id became the owner of all of it and could read, change or delete
it. Reproduced on the emulator against the real `firestore.rules`.
`onLeadDeleted` now deletes the lead's whole subtree, Storage objects first,
and never touches rows newer than the delete. Branch `fix/lead-subtree-sweep`.
Production has **1** orphaned lead id with **7** rows under it (counts below);
nothing has been deleted there.

Found by the security review of PR #1771
([RULES-DELETE-NULL-RESOURCE-2026-09-25](RULES-DELETE-NULL-RESOURCE-2026-09-25.md)),
which left it as a follow-up.

## The hole

Every rule under `leads/{leadId}/...` decides "owner" by reading the parent:

```
allow read: if isAuth() && (isAdmin()
  || isOwner(get(/databases/$(database)/documents/leads/$(leadId)).data.userId)
  || parentLeadInMyCompany(leadId));
```

The lead create rule checks only that `userId` and `companyId` are the
caller's own. It cannot know the id was used before. So once a lead doc is
gone, whoever creates `leads/{sameId}` passes every one of those checks for
the rows that are still there.

`onLeadDeleted` (`functions/lead-artifact-cleanup.js`) swept `documents` and,
from #1771, `warrantyClaims`. Nothing else under the lead was ever deleted.

Who can reach it: the caller has to know the id. Most lead ids are random
Firestore auto-ids. Cal.com leads are not: their id is `calcom__` plus the
numeric Cal.com booking id (`bridgeDocId` in `functions/lead-bridge-logic.js`).
Bridged web leads are `{collection}__{sourceId}`. A redelivered webhook can
also legitimately re-create a deleted lead at the same id, because both
integrations use `create()` with those deterministic ids.

## Repro

Shared emulator, dedicated project `demo-subtree-1`, `firestore.rules` from
origin/main. Tenant A's rep owns a `calcom__…` lead with one row in each of 8
subcollections. A hard-deletes it. Nothing sweeps (this run had no trigger;
on main the trigger would have taken `documents` and `warrantyClaims` and
left the other 6). Tenant B's rep, in a different company:

| Step | Result |
|---|---|
| Read any of the 8 subcollections before re-creating | denied, 8 of 8 |
| `setDoc(leads/{sameId}, {userId: B, companyId: co-b})` | allowed |
| Read notes, tasks, signatures, drawings, documents, activity, portal_messages, warrantyClaims | 1 row each, 8 of 8 |
| Update A's note | allowed |
| Delete A's saved homeowner signature | allowed |

The same run with the sweep in place reads 0 rows in all 8. That second run is
now a test (section Z of `tests/firestore-rules.cross-tenant.test.js`).

## Map: what lives under a lead

Grep of `docs/pro/js`, `functions/` and `firestore.rules`, 2026-09-25.

| Subcollection | Written by | Storage it names | Rule decides owner by | Swept before | Now |
|---|---|---|---|---|---|
| `documents` | document-generator, signed/dnd/overview uploads, photo report, remote-signing | `htmlPath`/`archivePath` (`documents/{uid}/{leadId}/…`), `url` (`docs/{uid}/{leadId}/…` or flat `docs/{uid}/{leadId}_{ms}_{name}`), `storagePath` (`pdf-renders/{uid}/…`) | parent lead | yes | yes |
| `warrantyClaims` | warranty-claim.js | none | parent lead | since #1771 | yes |
| `notes` | sms-functions, ai-texting, E2E | none | parent lead | no | yes |
| `tasks` | tasks, customer-tasks-ui, stage-checklist, quick-capture, voicemail, measurement, portal, voice-consumer | none (a cover photo URL at most) | parent lead | no | yes |
| `activity` | many webhooks + reps | none | parent lead (read) | no | yes |
| `drawings` | maps-routing.js | none | parent lead | no | yes |
| `signatures` | document-generator.js | none: the PNG is an inline `data:` URL in the row | parent lead | no | yes |
| `portal_messages` | portal.js, sms-functions, ai-texting | none | parent lead | no | yes |
| `recordings` | voice-intelligence (admin) | `audioPath` (`audio/{uid}/{leadId}/…`) | the row's own `userId` | no | yes |
| `storm_proofs` | storm-proof (admin) | none | the row's own `userId` | no | yes |
| `ai_drafts` | ai-texting (admin) | none | the row's own `userId` | no | yes |

The last three are not reachable by a stranger (their rules read the row's own
`userId`), but they are orphans all the same, and the sweep does not pick
favourites. The saved signatures are not Storage-backed, contrary to the
brief's guess; they are inline PNGs, so deleting the row is the whole job.

Found in passing: the customer-page upload
(`customer-photo-report-generator.js`) writes a **flat**
`docs/{uid}/{leadId}_{ms}_{name}` object and keeps only its download URL on
the row. The prefix sweep cannot see that shape and the old documents loop
read only `htmlPath`/`archivePath`, so a deleted lead's uploads of this kind
were never deleted, token and all. The new sweep finds them through the URL.

### Every path that hard-deletes a lead

All of these fire `onLeadDeleted`:

- The Trash drawer's Remove: `crm-portal-bridge.js` permanentDeleteLead →
  `window._permanentDeleteLead` (`dashboard-bootstrap.module.js`) →
  `deleteDoc`.
- A prospect's "Permanently delete" (`absoluteDeleteProspect` in
  `dashboard-actions.js`: two confirms and a typed DELETE, prospects only) →
  `deleteDoc`.
- The dashboard's rules self-check creates a test lead and deletes it at once
  (`dashboard-bootstrap.module.js`, "Delete from leads collection").
- `cleanupE2ETestData` (`functions/handlers/auth.js`): batch-deletes the
  caller's `e2eTestData` leads after sweeping `activity`, `notes`,
  `documents` and `signatures` itself. Leaves `tasks`, `warrantyClaims` and
  the rest to the trigger.
- Account erasure (`functions/integrations/compliance.js`):
  `recursiveDelete` on each of the user's leads, which takes the subtree too.
- A manual console or CLI delete.

`repos.js` `hardDelete` has no callers.

## The fix

`functions/lead-subtree-sweep.js`, called from `onLeadDeleted` as the new
step 1b (replacing the two named sweeps):

1. **Discovery.** `listCollections()` on the lead, so a subcollection added
   later is covered without touching the trigger. Recurses into each row's
   own subcollections, and uses `listDocuments()` to reach subcollections that
   hang off a row that does not exist (a query never returns those).
2. **Storage first.** For each row: find every Storage path it names, by
   shape rather than field name (`storageRefsIn`: strings under a
   lead-artifact prefix, and the path inside a Storage download URL), delete
   the ones the confinement check allows, then delete the row. If an object
   delete fails, the row is **kept**: it is the only pointer to the object,
   and the backfill script can only retry what it can find. A path the
   confinement check refuses is not a failure; the row still goes.
3. **Confinement, tightened.** The old documents loop allowed any path under
   `documents|portals|galleries|audio|docs` that merely *contained* the lead
   id. A lead's id is its creator's choice (the create rule does not constrain
   it), so a lead named `html` authorised deleting every tenant's
   `documents/…/*.html`, with admin credentials, from a planted `htmlPath`.
   Widening that check to every subcollection would have widened the hole. It
   is now segment-exact (`isReapableLeadArtifactPath`): the lead id must BE
   the third segment (`{prefix}/{uid}/{leadId}/…`), or the flat file name
   must be `{leadId}.html`, `{leadId}-photos.html`, or, under `docs/` only,
   `{leadId}_` + a 13-digit millisecond stamp (without the stamp check a lead
   named `calcom` would own a `calcom__…` lead's uploads). Flat `photos/` and
   anything under `d2d/` are refused. The uid segment is not checked, since a
   manager's upload to a teammate's lead sits under the manager's uid.
4. **Prefix sweep.** Step 2 now also lists `{prefix}/{uid}/{leadId}/` for
   uids named by this lead's own confined paths. That set is not passed to the
   `/photos` step (see What remains).
5. **Limits.** Pages of 200 rows, one batch per page. The subtree gets 300 s
   of the 540 s budget (`retry: false`), leaving the rest to steps 2-5 as
   before. Hitting the budget, a kept row, or a late orphan all land in the
   `partial sweep` `logger.error` with counts. The summary log adds
   per-collection counts, never ids beyond the lead's own.
6. `leads/{uid}/leads/…`, the retired per-user nested schema, is excluded.
   Account erasure owns it, no client rule reaches it, and anyone can create
   and delete a lead doc whose id is someone's uid, so sweeping it here would
   let a stranger erase another user's legacy data.

Tokens, appointments and `/photos` (steps 3-5) are unchanged.

### Race design

A lead can come back at the same id legitimately (a redelivered Cal.com or
public-lead webhook). Its new rows must survive.

- **Cutoff = the delete event's time.** `event.time` is the delete's commit
  time, on the same clock as every row's `createTime`/`updateTime`, and is
  parsed to the nanosecond (`isoToNanos`), so a row written in the same
  millisecond as the delete, after it, is not swept. A row is deleted only if
  **both** its `createTime` and `updateTime` are at or before the cutoff.
  `updateTime` too: an old `signatures/{role}` row merged again by the new
  lead carries the new lead's data.
- **Fallback** (`deleteCutoffNs` in `functions/lead-artifact-paths.js`). The
  cutoff is the invocation's start, which is always after the delete, when
  `event.time` is missing or unparseable, earlier than the lead's own last
  write (impossible for a real delete), or **on an exact second**. That last
  case is the emulator: the Firestore emulator builds `ce-time` from the
  publish instant truncated to whole seconds (read out of the emulator jar,
  `FunctionsEmulatorEventPublisher.createHttpHeaders` →
  `stripNanoSecond` → `Instant.truncatedTo(SECONDS)`), which can be up to a
  second BEFORE the delete. Trusted, it would make every row written in that
  second look newer than the delete, and CI would sweep nothing it had just
  seeded. A real commit time lands on an exact second about once in a
  million deletes. The log says which source was used (`cutoffSource`).
- **Re-read the lead before every page.** If the lead doc exists, it was
  re-created; rows at or after its `createTime` are kept even if the cutoff
  would allow them. That guards the fallback case, and so it is what protects
  a re-created lead's rows under the emulator. Old rows are still swept
  after a re-create: they belong to the deleted lead and are what a stranger
  would be after.
- **Preconditions.** Each row's delete carries `lastUpdateTime` from our read,
  so a row changed between read and delete stays. A failed batch is retried
  row by row, so one changed row cannot strand its page.
- **Objects.** Step 2 skips any object whose `timeCreated` is after the
  cutoff, or at or after a re-created lead's `createTime` (one more lead read
  just before step 2).
- **Late orphans.** A row written after the delete while the lead stays gone
  (a late webhook appending activity) is kept by the same rule. It is
  reported (`subtreeSkippedNewer`, and a `partial sweep` error when the lead
  was not re-created) and left for the backfill script.

## Defence in depth: can the rules refuse the re-create?

Considered, not done:

- **Rules cannot see the subtree.** They cannot list subcollections or
  query; `exists()` needs a known doc path. Only `signatures/{role}` has a
  predictable id.
- **Row metadata is not visible to rules**, so a read rule cannot say "only
  rows created after the parent lead". Rows do not all carry a `createdAt`
  field to compare instead.
- **A tombstone would work, but is not cheap.** `onLeadDeleted` could write
  `lead_tombstones/{leadId}` first, and the lead create rule could refuse an
  id with a tombstone from another tenant. It adds an `exists()` to every
  client lead create (the hottest write rule), a new collection with its own
  rules and tests, and a retention decision. It still leaves the seconds
  between the delete and the trigger, the same window the sweep has. What it
  would add is cover for rows a partial sweep leaves behind. Worth a lane if
  the backfill counts ever grow.
- **A server-side hard delete** (a callable that sweeps, then deletes the
  lead, with client `allow delete` on leads removed) would close even that
  window. It changes the Trash drawer, the dashboard self-check and E2E
  cleanup, so it is its own change.

## Production orphan counts (read-only, 2026-09-25)

`node scripts/audit-orphaned-lead-subtrees.js --project nobigdeal-pro`, after
checking `GoogleAuth().getProjectId() === 'nobigdeal-pro'` and with
`FIRESTORE_EMULATOR_HOST` unset. Counts only, as the script prints them:

| Subcollection | Rows under leads | Orphaned rows | Orphaned lead ids | Orphans naming a Storage object |
|---|---|---|---|---|
| activity | 23 | 4 | 1 | 0 |
| documents | 294 | 0 | 0 | 0 |
| portal_messages | 1 | 1 | 1 | 0 |
| tasks | 17 | 2 | 1 | 0 |
| ai_drafts, drawings, notes, recordings, signatures, storm_proofs, warrantyClaims | 0 | 0 | 0 | 0 |

- 73 lead ids have rows under them; **1** of those lead docs is absent. It is
  not a deterministic (`x__y`) id. **7** orphaned rows of 335.
- No other subcollection names under the orphan, no rows in the retired
  `leads/{uid}/leads/…` tree. "Elsewhere" rows (same name outside `leads/`:
  74 top-level `notes`, 1 `tasks`) are not lead rows and are never touched.

The backfill (`--delete --yes`) has **not** been run. Production deletes need
Jo's explicit OK. It would sweep that one subtree with the trigger's own code.

## Tests, and how each was proven

- `tests/lead-artifact-cleanup.integration.test.js` (CI: "Referral trigger
  tests", now under `--only functions,firestore,storage`). 44 checks:
  - **A.** Every subcollection of a deleted lead is gone: notes, tasks,
    activity, drawings, the saved signature, a portal message, a name no code
    knows, a nested row, a nested row under a row that never existed, and
    three `documents` rows. Nothing at all is left under the id. The object a
    row's `htmlPath` named and the flat object only a download URL named are
    deleted; an object of a live lead whose id *starts with* the deleted one
    survives; another lead's rows survive.
  - **B.** 450 old activity rows (three pages) and an old object under the
    lead prefix go. A row and an object written once the trigger has
    provably started, to a lead that stays gone (a late webhook), survive.
    Written then, not at once, because under the emulator the cutoff is the
    invocation start (see Race design).
  - **C.** A stranger re-creates a `calcom__…` id right after the delete: the
    old note, signature and task go, the stranger's new note and lead doc
    stay, only that one row is left under the id, the old object under the
    lead prefix goes and an object uploaded after the re-create stays.
  - **D.** The module directly. Cutoff = one row's exact commit time: that row
    goes, the next row committed survives, counted as newer. Cutoff an hour
    ahead (an unusable event time): rows from before a re-create go, rows
    after it stay; a row's object is deleted while the row still exists; a
    row whose object delete fails is kept and reported.
- `tests/firestore-rules.cross-tenant.test.js` section Z (12 checks, suite now
  142/142): the owner deletes a lead with a row in 8 subcollections, the sweep
  runs over the admin SDK, another tenant's rep can still create the id, and
  then reads **0** rows in each of the 8.
- `tests/lead-photo-reaping.test.js` (84 checks, was 41): the segment-exact
  confinement (a lead named `html`, a lead named after a uid, a sibling id
  prefix, `calcom` vs `calcom__`, traversal, flat photos, d2d), path-from-URL
  parsing, `storageRefsIn` (a signature data URL is not a path), exact
  nanosecond time parsing, the four `deleteCutoffNs` cases, the prefix
  lockstep, and that the sweep module requires only the path helpers.

Break-tests. Each mutation applied alone, the suite run, the original bytes
restored and checked by sha256. "trunc" runs send the emulator's
whole-second event time instead of the exact commit time:

| Mutation | Red, and only this |
|---|---|
| Discovery hard-coded to `documents`, `warrantyClaims` | 16: A (9 rows + nothing-left), B (old rows), C (2), D (3) |
| No recursion into a row's subcollections | A: both nested rows + nothing-left |
| No `listDocuments()` pass | A: the row under a never-existing parent + nothing-left |
| No per-row Storage delete | A: the URL-only object; D: Storage-first, kept row, counted |
| Confinement back to `includes(leadId)` | A: the sibling lead's object |
| Row cutoff check removed (exact, and trunc) | B: the late row; D: the row after the cutoff + its count |
| Re-create guard removed | exact: D's row after the re-create. trunc: also C's new note + only-own-row |
| Row deleted even when its object delete failed | D: the kept row |
| Step 2 object guard removed | B: the late object; C: the object after the re-create |
| Step 2 object guard: re-create part removed (trunc) | C: the object after the re-create |
| Step 2 object guard: cutoff part removed | B: the late object |
| Sweep finds no collections (rules suite) | Z: the sweep line + all 8 empty reads (the hole, on the current rules) |
| Unit: segment check back to `includes()` | `html`, uid-named, sibling-prefix |
| Unit: 13-digit stamp check removed | `calcom`, `calcom_`, un-stamped docs |
| Unit: cutoff ignores a precise event time | the precise-time case |
| Unit: cutoff trusts a whole-second time | the whole-second case |
| Unit: cutoff skips the last-write sanity check | the before-last-write case |

Trusting the whole-second time turned nothing red in a trunc integration run;
whether it bites depends on which second the rows were seeded in, which is
why that rule is pinned by the unit test instead.

One early "cutoff removed" run also reddened the appointments check and D's
Storage checks; a rerun reddened only the intended lines, and so did every
run after. Most likely the shared emulator restarted mid-run (its watchdog
does). Treat a many-red result on that rig as suspect until rerun.

### How the tests were run

No emulator was started. The shared rig (firestore 8080) was used under
dedicated project ids only (`demo-subtree-*`); `nobigdeal-pro` there was never
touched and the rules suites refuse the `.firebaserc` ids.

- Rules suites: `RULES_TEST_PROJECT_ID=demo-subtree-… node
  firestore-rules.test.js` and the same for the cross-tenant suite (section Z
  sets `FIRESTORE_EMULATOR_HOST` to the host the rules env uses).
- Integration test: the committed file, run with `node --require
  <preload> lead-artifact-cleanup.integration.test.js` from `tests/`, with
  `GCLOUD_PROJECT=demo-subtree-…` and `FIRESTORE_EMULATOR_HOST` set. The
  preload (scratch, not committed) patches `DocumentReference.delete` in both
  firebase-admin copies: after a top-level `leads/{id}` delete it runs the
  real `onLeadDeleted` handler in-process 250 ms later, not awaited, with
  `event.data` carrying the before-image and its `updateTime`, and
  `event.time` either the delete's exact `writeTime` (as production sends
  it) or that instant truncated to the second (as the emulator sends it).
  44/44 in both modes. Storage is an in-memory bucket shared by the test and
  the handler, so the shared Storage emulator is not touched; the test
  refuses to run without either that or a storage emulator. CI runs the same
  file under the real functions + storage emulators.
- The audit script was exercised on a seeded dedicated project: read-only
  counts, the `--delete` refusal without `--yes`, the mixed-target refusal,
  a `--delete --yes` run, and a clean re-count after it. The mixed-target
  refusal exists because an earlier `--delete` test run, with only the
  Firestore emulator set, sent its Storage calls to real Storage on this
  machine's ADC. They were deletes of one path in a bucket that does not
  exist (404, nothing touched), and the script now refuses that combination.

Gates run: `check-js-syntax`, `run-test-manifest --check`, `check-vault-index`,
`tests/smoke.test.js` (4419/0), both rules suites, and a functions require of
`lead-artifact-cleanup.js`.

## What remains

- **Run the backfill** once Jo says so: 1 lead id, 7 rows, no Storage.
  `--delete --yes` against `nobigdeal-pro`, then re-run read-only to confirm 0.
- **The `/photos` step still trusts row-supplied uids** (found here, not
  changed; the brief kept that step as is). `resolveOwnerUids` adds the
  `userId` and `htmlPath` uid of every `documents` row, which are
  client-written, and `isReapablePhotoPath` then allows any
  `photos/{thatUid}/…` path named by a `/photos` doc whose `leadId` is the
  deleted lead (also client-written). So a user who plants both under their
  own lead and hard-deletes it can have the trigger delete another user's
  photo, given its path. Fix: confine the photo step to `lead.userId` plus
  paths whose third segment is the lead id.
- **`pdf-renders/{uid}/…`** named by a photo-report `documents` row has no
  lead id in its path, so the sweep refuses it; `pdf-render-retention.js`
  deletes it at 30 days.
- **The window** between the delete and the sweep finishing (seconds) is
  still open to someone who knows the id and acts at once. See the tombstone
  and server-side delete options above.
- **Late orphans** (rows written after the delete to a lead that stays gone)
  are kept by design and logged; the backfill script finds them.
- `cleanupE2ETestData` still names four subcollections itself; the trigger
  now covers the rest when it deletes the lead.
- The audit script finds orphaned lead ids through known subcollection names.
  An orphan whose only rows are in an unknown subcollection would not show;
  under a found orphan, unknown names are listed.

Functions deploy on merge: the next deploy ships the new `onLeadDeleted`.
