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

> **Update 2026-09-25 (review of PR #1777).** "A re-created id inherits
> nothing" still did not hold after the first version. A security review
> reproduced four more ways in, all fixed on the same branch (see
> [Review fixes](#review-fixes-2026-09-25)): the deleted lead's **top-level**
> `/notes` stayed readable by a re-creator; the **portal** served the old
> tenant's estimate, unpaid invoice (with Stripe link) and signed e-sign PDF
> to a token the re-creator minted; a lead named `_variants` or `d2d`, or a
> `documents` row naming someone's uid, aimed the Storage sweep at **other
> users'** shared folders; and a stranger could keep old rows by writing one
> field to each. The sections below are corrected in place where they were
> wrong. The production count below also left out top-level docs keyed by a
> deleted lead (see the correction there).

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
   `/photos` step (see What remains). *Corrected in review:* "confined" was
   not enough. A lead named `_variants` or `d2d` passed the segment check
   for folders many leads share, so such a lead id now sweeps nothing but its
   tokens, and a row uid reaches this step only if it is in the lead's tenant
   (Review fixes, #7).
5. **Limits.** Pages of 200 rows, one batch per page. The subtree gets 300 s
   of the 540 s budget (`retry: false`), leaving the rest to steps 2-5 as
   before. Hitting the budget, a kept row, or a late orphan all land in the
   `partial sweep` `logger.error` with counts. The summary log adds
   per-collection counts, never ids beyond the lead's own.
6. `leads/{uid}/leads/…`, the retired per-user nested schema, is excluded.
   Account erasure owns it, no client rule reaches it, and anyone can create
   and delete a lead doc whose id is someone's uid, so sweeping it here would
   let a stranger erase another user's legacy data.

Tokens, appointments and `/photos` (steps 3-5) were unchanged in the first
version. *Corrected in review:* they now run before the subtree walk, under
the same race rule, and a new step sweeps top-level `/notes` (Review fixes,
#1, #4, #10).

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
  row by row, so one changed row cannot strand its page. *Changed in review:*
  a changed row is read again and judged again; it stays only if it now
  belongs to a same-tenant re-create, and is otherwise deleted with its new
  `updateTime` (three tries, then a logged failure).
- **Who re-created it** (added in review). The `updateTime` half of the rule
  applies only when the lead was re-created by the deleted lead's own tenant.
  Otherwise a stranger who re-created the id kept every old row by writing
  one field to it. See Review fixes, #3.
- **Objects.** Step 2 skips any object whose `timeCreated` is after the
  cutoff, or at or after a re-created lead's `createTime` (one more lead read
  just before step 2).
- **Late orphans.** A row written after the delete while the lead stays gone
  (a late webhook appending activity) is kept by the same rule. It is
  reported (`subtreeSkippedNewer`, and a `partial sweep` error when the lead
  was not re-created) and left for the backfill script.

## Review fixes (2026-09-25)

A security review of the first version found that "a re-created id inherits
nothing" still did not hold. Each finding below was reproduced on the shared
emulator under a dedicated project id (the real rules, the real handler run
in-process with the delete's exact commit time) before it was fixed, and the
same script holds after. Nothing was disputed; one finding the reviewer had
only reasoned out (reserved ids) reproduced as described.

| # | Finding | Reproduced | Fix |
|---|---|---|---|
| 1 | Top-level `/notes` of the deleted lead stay readable. Its read rule reads the lead the note's `leadId` names, and the trigger never touched `/notes`. | After a complete sweep, tenant B re-created `calcom__…` and read A's note text (gate code, phone). | New `/notes` step (`sweepLeadKeyedDocs`). Rules suite section Z now checks B reads none. |
| 2 | The portal view found estimates, e-sign envelopes and invoices by `leadId` alone. They are never swept (financial and executed-contract records). | B re-created the id, minted a token (`canManageLead` passes on B's own lead), and the view returned A's shared estimate (total, tier, signed-document URL), A's unpaid invoice with its Stripe link, and a signed URL to A's completed e-sign PDF. Also: B could write an estimate or invoice with A's LIVE lead id and have it shown to A's homeowner. | `functions/portal-authz.js`: `portalTenant`, `recordInPortalTenant`, `tokenMatchesLead`. The view keeps only records of the lead's tenant (companyId, or for an unstamped record its owner uid); a token of another tenant than the lead's opens nothing; `getEstimateForView` checks the same. |
| 3 | A stranger who re-created the id before the sweep reached a collection kept each old row by writing one field to it (its `updateTime` was then "newer"), and the run logged `info … failures=0`. | Old signature (inline PNG, signer name) and note survived with their content; the summary was an info line. | Only a re-create by the SAME tenant may keep old rows it wrote to (`sameLeadTenant`, `belongsToDeletedLead`). Otherwise write time does not count, and a row changed mid-delete is judged again and deleted on retry. A re-create by another tenant is logged at error. |
| 4 | `/photos` docs (readable by a company reader of the named lead) and live tokens waited behind the subtree walk (up to 300 s). | B, a company_admin, listed A's photo docs with download-token URLs after re-creating the id. | Order: tokens, `/photos`, `/notes`, appointments, THEN the subtree, then Storage prefixes. The window for these is now the seconds those steps take. (A window before the trigger runs is inherent to an async trigger.) |
| 5 | The audit script's perimeter left out top-level docs keyed by a deleted lead; no ADC-project check; no refusal of the shared rig's app id. | Seeded: 2 orphaned top-level notes counted as "elsewhere", an orphaned estimate not reported. | Script counts `/notes`, `/photos`, both token collections, appointments, estimates, invoices, e-sign envelopes by `leadId`; `--delete` also sweeps notes, tokens, appointments; production requires the ADC project to equal `--project`; an emulator run refuses `.firebaserc` ids; mixed emulator targets refused in every mode; the bucket must exist before any delete. |
| 6 | A partial sweep was not always loud: the deadline was checked only between pages, and the summary is logged once at the end, so a run killed at 540 s logged nothing. | Code reading (a page of 200 rows × up to 50 sequential object deletes can outrun any per-page check). | Deadline checked per row and per child collection, in every step, against a 480 s handler budget, so the summary is always logged; a `start` line is logged first. |
| 7 | Uids off ROWS aimed Storage deletes at other users. A lead named `_variants` passed the segment check for `photos/{anyUid}/_variants/…`, and step 2 then listed that uid's shared variants folder; `d2d` did the same for D2D memos and knock photos. Separately (on main too), a `documents` row's `userId` (its create rule checks only `status`) joined the `/photos` confinement set. | `_variants`: a victim's variant named by a note row, and its whole variants folder, deleted. `d2d` + a documents row naming the victim: the victim's D2D memo and knock photo deleted. An ordinary lead + a documents row + a `/photos` doc naming the victim's flat photo: deleted. | `isReservedLeadId` (`_…`, `.…`, `d2d`, `thumbs`, `undefined`, `null`): such a lead revokes its tokens and nothing else, and `isReapableLeadArtifactPath` refuses every path for it. The `/photos` step trusts the lead's `userId` only (row uids are a fallback for a lead without one). A row uid reaches the prefix step only if it is in the lead's tenant (`uidInLeadTenant`: the owner, the lead's companyId, or a server-only `users/{uid}.companyId` equal to the lead's). |
| 8 | `onAudioUploaded` read `audio/{uid}/d2d/{knock}_{ts}.webm` as lead `d2d`, so every tenant's D2D memo became `leads/d2d/recordings/…`, which the new sweep would erase when anyone created and deleted `leads/d2d`. | Another user's `leads/d2d/recordings` row swept. | `parseAudioPath` ignores reserved ids (nothing reads those rows; production has 0). The sweep refuses reserved ids. |
| 9 | Two guards had no test: the `lastUpdateTime` precondition, and the `updateTime` half of the rule. | Each mutation left the suite green (reviewer's run). | Integration E1 (same-tenant merge onto an old row survives) and E2 (a row changed between read and delete survives, counted as changed). |
| 10 | Steps 3-5 (`/photos`, tokens, appointments) and step 2's flat deletes had no time check; a row-named object had none either. | A same-owner redelivery that re-created `calcom__…` lost its rewritten appointment, a token minted after the re-create, and a photo doc + object written after it. | Every step goes through one watch (`makeLeadWatch`). Tokens are judged by create time only (every portal open bumps their update time). Flat deletes and row-named objects are judged by their own `timeCreated`. |
| 11 | Deadline only between pages (same as 6). | — | As 6. |

### Break-tests of the review fixes

Each mutation applied alone to the worktree file, the named suite run, the
original bytes restored and checked by sha256 (`breaktest.js`, scratch).
U = `lead-photo-reaping.test.js`, I = the integration test (exact event time),
X = the cross-tenant rules suite.

| Mutation | Suite | What went red (and nothing else) |
|---|---|---|
| M1 reserved-id refusal removed from `isReapableLeadArtifactPath` | U | `_variants` (other uid's and own), `thumbs`, `undefined` cases |
| M2 strict mode ignored (write time always counts) | U, I | U: both strict cases. I: E3 signature, note, changed-mid-delete row; E4 opened token + counts |
| M3 the `updateTime` half removed | U, I | U: both same-tenant cases. I: E1 merged row; E2 row + count; E4 rewritten booking + counts |
| M4 `lastUpdateTime` precondition removed (batch and row by row) | I | E2 row + count |
| M5 a row changed under the delete never judged again | I | E3 changed-mid-delete row |
| M6 who re-created the lead ignored | I | E3 signature, note, changed row, other-tenant report |
| M7 per-row deadline check removed | I | E6 (6 of 6 rows processed past the deadline) |
| M8 `/notes` step removed from the trigger | I | A: the top-level note |
| M9 row uids back in the `/photos` owner set, unverified (the old `resolveOwnerUids`) | I | R: both victims' flat photos (the ordinary lead's and the legacy lead's) |
| M9a only the owner set widened (tenant check kept) | I | nothing: the tenant check still refuses the victim |
| M9b only the tenant check removed | I | R: the legacy (no-userId) lead's victim photo |
| M10 reserved-id guards removed from trigger and sweep | I | R: phantom `leads/d2d/recordings` row, creator's own variants, creator's own D2D memo; E5 |
| M11 keyed-doc time check removed | I | E4: post-re-create note, rewritten booking, counts |
| M12 tokens judged like rows | I | E4 opened token + counts |
| M13 portal estimate filter removed | I | P: re-creator sees old estimate; planted estimate shown to a live lead's homeowner |
| M14 portal invoice filter removed | I | P: old invoice + Stripe link; planted invoice |
| M15 portal e-sign filter removed | I | P: old signed PDF |
| M16 portal token-vs-lead check removed | I | P: old tenant's link opens the re-created lead |
| M17 `getEstimateForView` tenant check removed | I | P: old estimate by id |
| M18 `parseAudioPath` reserved check removed | U | D2D memo and reserved-id cases |
| M19 rules suite: `/notes` step skipped | X | Z: B reads A's top-level note (the hole, on the current rules) |
| M20 row-named object's `timeCreated` ignored | I | E7 object + count |
| M21 flat-shape object's `timeCreated` ignored | I | C: the flat object written after the delete |

Defence in depth, stated plainly: M1 turns only unit checks red, because the
trigger's reserved-id skip and the sweep's own refusal also stop that attack
in the integration run; M9a turns nothing red, because the tenant check still
refuses the victim's uid. Each of those layers is kept so that one mistake
does not reopen the hole; the paired mutations (M9, M10) are what the
integration suite catches.

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
  74 top-level `notes`, 1 `tasks`) ~~are not lead rows and are never
  touched~~. *Corrected in review:* the 74 top-level `notes` ARE lead-keyed
  (`leadId` field), and the `/notes` read rule admits whoever owns the lead
  they name, so any of them whose lead is gone was readable by a re-creator.
  The script now counts top-level docs by `leadId` (see the update below).

The backfill (`--delete --yes`) has **not** been run. Production deletes need
Jo's explicit OK. It would sweep that one subtree with the trigger's own code.

### Update: production counts with the corrected perimeter (read-only, 2026-09-25, later)

Same script after the review fixes, read-only, `--project nobigdeal-pro`
(the script now checks the ADC project itself; `FIRESTORE_EMULATOR_HOST`
and `FIREBASE_STORAGE_EMULATOR_HOST` unset). Counts only:

| Top-level collection | Docs | Orphaned (lead absent) | Orphaned lead ids | `--delete` |
|---|---|---|---|---|
| notes | 74 | 7 | 5 | swept |
| photos | 111 | 1 | 1 | kept (needs the owner uid; see `sweep-orphan-lead-artifacts.js`) |
| portal_tokens | 13 | 4 | 2 | swept |
| doc_sign_tokens | 1 | 0 | 0 | swept |
| appointments | 9 | 0 | 0 | swept |
| estimates | 18 | 0 | 0 | kept |
| invoices, esign_envelopes | 0 | 0 | 0 | kept |

- **7** orphaned lead ids in all (was reported as 1): 106 lead ids named by a
  row or doc, 7 of those lead docs absent, 1 of them with subtree rows (the
  same 7 rows as above). **0** have a deterministic (`x__y`) id, so none is
  guessable. 0 reserved ids.
- **12** orphaned top-level docs, 11 of them in collections the backfill
  sweeps (7 notes, 4 portal tokens). A portal token of a deleted lead opens
  nothing while the lead is absent (`project_missing`); since the review, a
  token also opens nothing on a lead re-created by another tenant.
- Nothing was changed. The backfill still needs Jo's OK:
  `--delete --yes` would now delete the 7 subtree rows, 7 notes and 4
  tokens, and leave the photo doc and nothing else.

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

### Tests added by the review fixes (2026-09-25, later)

- Integration test, now 91 checks (was 44), same CI step. New sections:
  - **A/confinement**: a top-level `/notes` doc of the deleted lead is swept;
    another lead's survives.
  - **R** (through the trigger): leads named `_variants` and `d2d` revoke
    their tokens and touch nothing else: a victim's shared variants, D2D memo
    and knock photo survive, and so do the creator's own, and another user's
    `leads/d2d/recordings` row. An ordinary lead whose `documents` row names
    a victim: its own flat photo goes, the victim's survives. A legacy lead
    with no `userId`: a teammate's flat photo (same tenant, server-only
    `users/{uid}.companyId`) goes, the victim's survives.
  - **C**: a flat-shape object written at the id after the delete survives.
  - **E** (the module, deterministic): E1 same-tenant merge onto an old row
    survives; E2 a row changed between read and delete survives, counted as
    changed; E3 a stranger's re-create keeps none of the old rows it wrote to,
    and a row changed mid-delete is deleted on retry; E4 top-level notes,
    appointments and tokens under the watch (a rewritten booking survives,
    an old token goes though it was opened after the delete); E5 a reserved
    id is refused; E6 the per-row deadline; E7 a row-named object re-uploaded
    after the re-create survives.
  - **P** (`functions/portal.js` in-process, Firestore only): the tenant's own
    token still shows its estimate, balance and signed PDF (control); a
    re-creator's token shows none of them; `getEstimateForView` refuses the
    old estimate by id; the old tenant's link does not open the re-created
    lead; a live lead's homeowner never sees an estimate or invoice another
    tenant planted with its lead id.
- Rules suite section Z: the `/notes` step runs too, and B reads none of A's
  top-level notes (145/145).
- `tests/lead-photo-reaping.test.js` (137, was 84): reserved ids, the
  strict/same-tenant rule table, `sameLeadTenant`, `uidInLeadTenant`, and
  `parseAudioPath` refusing D2D memos.
- `tests/smoke/portal.test.js`: `portalTenant`, `recordInPortalTenant`,
  `tokenMatchesLead`, and the wiring of all three filters (smoke 4440/0).

Run the same way as above, with one change: the scratch preload now uses the
shared **Storage emulator** (dedicated bucket `demo-subtree-…appspot.com`)
instead of an in-memory bucket, and initialises the functions copy of
firebase-admin with a throwaway key so section P can sign URLs. 91/91 with
the exact event time and with the emulator's whole-second time.

## What remains

- **Run the backfill** once Jo says so: 1 lead id, 7 rows, no Storage.
  *Updated after the review:* 7 lead ids; 7 subtree rows + 7 top-level notes +
  4 portal tokens would go, 1 orphaned `/photos` doc stays (see the updated
  production counts).
  `--delete --yes` against `nobigdeal-pro`, then re-run read-only to confirm 0.
- ~~**The `/photos` step still trusts row-supplied uids**~~ **Fixed in review
  (#7):** the step now trusts the lead's `userId` only. Original note: (found
  here, not changed; the brief kept that step as is). `resolveOwnerUids` adds the
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
- **The window** (narrowed in review: tokens, `/photos`, `/notes` and
  appointments now run first) between the delete and the sweep finishing (seconds) is
  still open to someone who knows the id and acts at once. See the tombstone
  and server-side delete options above.
- **Late orphans** (rows written after the delete to a lead that stays gone)
  are kept by design and logged; the backfill script finds them.
- `cleanupE2ETestData` still names four subcollections itself; the trigger
  now covers the rest when it deletes the lead.
- (Review) A tombstone or a server-side hard delete is still the only way to
  close the window before the trigger runs, for the subtree and for
  `/photos` (readable by a company reader of the lead a photo names). Not
  done here; see "Defence in depth".
- (Review) A /photos doc uploaded by a teammate under their own uid to
  someone else's lead is still refused by the `/photos` step (the owner-only
  confinement); the bucket-wide sweep script is what finds those.
- The audit script finds orphaned lead ids through known subcollection names
  and, since the review, through the `leadId` of the top-level collections.
  An orphan whose only rows are in an unknown subcollection would not show;
  under a found orphan, unknown names are listed.

Functions deploy on merge: the next deploy ships the new `onLeadDeleted`.
