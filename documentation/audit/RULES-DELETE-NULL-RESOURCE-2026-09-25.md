# Firestore rules: deletes denied by a shape validator (2026-09-25)

**Result.** Two lead subcollections, `leads/{id}/documents` and
`leads/{id}/warrantyClaims`, could not be deleted by any client, the lead's
owner included. A scripted audit of every rule in `firestore.rules` found no
third case. Fixed on branch `fix/rules-subcollection-delete` (PR #1771).

> **Superseded in part 2026-09-25 (later the same day).** Who may delete
> these rows changed after this note: managers no longer hard-delete them and
> a viewer-owner writes nothing (Jo's rulings, see Open product calls below
> and [ROLE-TIGHTENING-2026-09-25](ROLE-TIGHTENING-2026-09-25.md)). The
> "who can delete" lines further down describe #1771 as merged.

> **Corrected 2026-09-25 (review fixup, same PR).** The first draft said that
> once a lead is hard-deleted, no client can reach the rows left under it, and
> that viewers are refused. Both were wrong as stated. Rows under a deleted
> lead can be taken over by whoever re-creates that lead id; see
> [Rows under a hard-deleted lead](#rows-under-a-hard-deleted-lead). A viewer
> who **owns** the lead can delete these rows, the same as they could already
> create and update them. The sections below are fixed in place.

> **Update 2026-09-25 (later, branch `fix/lead-subtree-sweep`).** The
> follow-up in [Left open](#left-open) is done. `onLeadDeleted` now deletes
> the lead's WHOLE subtree, not two named subcollections: every subcollection
> found with `listCollections()`, nested ones included, each row's Storage
> objects before the row, and never a row newer than the delete (a webhook can
> re-create a lead at the same id). The step 1/1b description below is
> superseded. The same change tightens the confinement on row-supplied
> Storage paths: `p.includes(leadId)` let a lead named `html` authorise any
> tenant's `documents/…/*.html`. Production had 1 orphaned lead id with 7
> rows (no Storage); the backfill has not been run. See
> [LEAD-SUBTREE-HIJACK-2026-09-25](LEAD-SUBTREE-HIJACK-2026-09-25.md).

## The trap

Both blocks had one `allow write` line that ended in a shape validator:

```
allow write: if isAuth()
  && (isOwner(get(.../leads/$(leadId)).data.userId)
      || (isCompanyStaff() && parentLeadInMyCompany(leadId)))
  && documentStatusWriteOk();      // warrantyClaimWriteOk() on the claims block
```

`write` covers create, update **and delete**. Both validators read
`request.resource.data`. On a delete `request.resource` is null, so the helper
throws, and a throw inside `&&` denies. The owner got a 403 on every delete.

Confirmed live on the shared emulator against origin/main's rules, with a
delete of a row that does not exist (so the probe changes nothing):

```
403  evaluation error at L484:25 for 'delete' @ L484 ... Null value error.
```

PR #1770 (tests-only) hit the same 403 in the phone-chrome cleanup: the report
rows the doc viewer files outlived their lead. It left the rules alone.

## The fix

Each block now has two lines:

- `allow create, update:` keeps the writer check and the validator.
- `allow delete:` has the same writer check and no validator.

Who can delete is exactly who could already create and update: the lead owner,
or a company_admin or manager whose tenant matches the parent lead. Denied: a
viewer or sales rep on a lead they do not own, the platform admin, other
tenants, signed-out users and homeowner sessions. A homeowner has no identity at
the rules layer. The portal reaches lead data only through token-checked Cloud
Functions.

The owner branch ignores role, so a **viewer who owns the lead** can delete
these rows, just as they could already create and update them (and as on
`tasks`, `notes` and `drawings`). The lead doc itself is stricter: its
update/delete bars a viewer-owner (Audit #3 F-1). §28d now pins the
subcollection behaviour so a change to it is deliberate; see Open product calls.

The delete check reads the parent lead, so while the lead is absent nobody can
delete its rows through the rules. `onLeadDeleted`
(`functions/lead-artifact-cleanup.js`) has always swept `documents`. It now
sweeps `warrantyClaims` too (step 1b).

### Rows under a hard-deleted lead

An absent lead does not make its rows private. Every lead subcollection rule
decides "owner" by reading `leads/{leadId}`, and the lead create rule only
requires `userId` and `companyId` to be the caller's own. It cannot know the id
was used before. So any signed-in user who creates a lead at a deleted lead's
id becomes the owner of every row still under it, and can read, update or
delete them.

The review of PR #1771 reproduced this on the shared emulator: a sales rep in an
unrelated tenant could read none of a deleted lead's leftover rows, created the
lead doc, and could then read all of them. The result was the same on
origin/main's rules and on this branch, so the PR does not widen it. The fixup
re-ran it the same way (notes, tasks, documents). Most lead ids are Firestore
auto-ids, so the caller has to know the id first. Cal.com leads are the
exception: their id is `calcom__` plus the numeric Cal.com booking id
(`bridgeDocId` in `functions/lead-bridge-logic.js`), which weighs on how soon
the follow-up below should land.

The admin-SDK sweep in `onLeadDeleted` is what closes this, once it has run.
It covers `documents` and, with this PR, `warrantyClaims`. The other
subcollections are not swept yet (see Left open).

## Audit of the rest of the rules

A script parsed every `allow` statement in `firestore.rules`, expanded helper
calls recursively, and flagged any rule that allows `write` or `delete` and
reads `request.resource`:

| Rules | Flagged |
|---|---|
| origin/main | 2: the `documents` and `warrantyClaims` blocks |
| this branch | 0 |

Every other `allow write` on a subcollection (`tasks`, `notes`, `drawings`,
`signatures`, the `users/{uid}/…` mirrors) checks only the caller and the
parent. `activity`, `recordings`, `storm_proofs`, `portal_messages` and
`ai_drafts` deny client deletes on purpose (`if false`).

`storage.rules` does not have the trap. Every `allow write` that checks
`request.resource` sits next to its own `allow delete` line, and rules combine
with OR.

A mirror check looked for create-capable rules that read the existing doc
(`resource.data`, which is null on a create). It found none. As a control, the
same script flags 33 update rules, which do read `resource.data`, as expected.

## What the client does today

No client code hard-deletes these rows. The customer page's document delete is
a soft delete: an `updateDoc` that sets `deleted: true`, which the rules always
allowed. Warranty claims are opened and closed, never deleted. The only
deletes affected were E2E cleanup and any future hard-delete.

## Tests, and how each was proven

- `tests/firestore-rules.test.js` §28d, for both subcollections:
  - 8 callers are denied: a same-tenant viewer and a same-tenant rep (neither
    owns the lead), the platform admin, another tenant's manager,
    company_admin and rep, a signed-out user, and a homeowner session.
  - The owner, a same-tenant manager and a same-tenant company_admin are
    allowed, and the rows are then gone.
  - A legacy lead with no companyId allows the owner only.
  - A viewer who owns the lead can update and delete its rows (pinned by the
    fixup, so narrowing it has to be a deliberate change).
  - A row under an already-deleted lead is denied.
- `tests/firestore-rules.cross-tenant.test.js`: 12 checks. Each subcollection
  gets 5 denials (the other tenant's rep, manager and company_admin, a
  same-tenant rep, signed-out) and 1 owner allow. The suite now reports 130 of
  130.
- `tests/lead-artifact-cleanup.integration.test.js`: after a hard delete, the
  lead's `documents` and `warrantyClaims` rows are gone and another lead's
  claim row is still there. CI's "Referral trigger tests" job ran it under a
  real functions + firestore emulator on the PR: 7 of 7 passed, including
  the new assertions.

Break-tests. Each mutation was applied, the suite run, and the original bytes
restored:

- **The fix reverted (origin/main rules).** §28d goes red at the owner delete,
  denied at the documents block. The two cross-tenant owner checks fail.
- **Only the claims split reverted.** The owner delete goes red again, this
  time denied at the warrantyClaims block.
- **Documents delete widened, one audience at a time.** Each widening turned
  exactly its own assertion red. The audiences were: viewer, same-tenant rep,
  platform admin, cross-tenant manager, cross-tenant company_admin,
  cross-tenant rep, signed-out, anonymous session, staff on a legacy lead, and
  a row whose lead is gone.
- **Claims delete widened to any signed-in user.** The claims viewer denial
  goes red, and so do 4 cross-tenant claim checks.
- **Test-side: the owner delete skipped.** The "row is gone" read goes red.
- **Viewer-owner excluded (fixup).** Four runs, each narrowing one owner
  branch to `role != 'viewer'`: `allow delete` on documents, then on claims,
  then `allow create, update` on documents, then on claims. Each turned red
  exactly the matching new §28d line (the viewer-owner delete or update) for
  that subcollection, and the unmutated control passed.
- **Trigger mutations.** These ran through the real handler, in-process,
  against a dedicated project:
  - Step 1b removed: the claims-swept assertion goes red.
  - The claims sweep widened to a collectionGroup: the confinement assertion
    goes red.
  - The documents row delete removed: the documents-swept assertion goes red.

Rules suites run locally against the shared emulator used a fresh dedicated
project id per run (`RULES_TEST_PROJECT_ID`, new in both suites). Both suites
refuse the ids in `.firebaserc`. A probe of `nobigdeal-pro` before and after
confirmed the rig kept origin/main's rules.

## Left open

- `onLeadDeleted` still does not sweep `tasks`, `notes`, `activity`,
  `drawings`, `signatures`, `recordings`, `storm_proofs`, `portal_messages` or
  `ai_drafts` under a hard-deleted lead. Those rows are **not** unreachable:
  whoever re-creates the lead id owns them (see
  [Rows under a hard-deleted lead](#rows-under-a-hard-deleted-lead)).
  Account erasure removes them only for leads that still exist. Follow-up:
  have `onLeadDeleted` delete the lead's whole subtree rather than two named
  subcollections. It is not done here because it needs its own decisions:
  - Some rows carry Storage objects that must be reaped first.
  - A delete-by-subtree must not race a legitimate re-create at the same id.
    Bridged web leads and Cal.com leads use deterministic ids with `create()`,
    so a redelivered webhook can bring a deleted lead back at the same id.
- `cleanupE2ETestData` walks `activity`, `notes`, `documents` and `signatures`,
  but not `tasks` or `warrantyClaims`. On a rig with functions, `onLeadDeleted`
  now sweeps the claims when the callable deletes the lead.

## Open product calls (for Jo)

> **Decided 2026-09-25 (both).** Jo ruled on both calls below the same day:
> hard delete of these rows is the lead's owner or a company_admin of its
> tenant (managers keep create/update and the soft delete), and the viewer
> role is read-only everywhere, a viewer-owner included. Both are enforced
> by `fix/rules-viewer-readonly`, and the two §28d lines this note says to
> flip were flipped there. Decisions quoted, before/after table and
> break-tests: [ROLE-TIGHTENING-2026-09-25](ROLE-TIGHTENING-2026-09-25.md).
> The text below is the question as it stood before the ruling.

These are not defects. The PR matched delete to the existing writer set, as its
brief required, and each point below already held for create and update
before it.

- **Managers can hard-delete these rows on a teammate's lead.** That includes
  a `documents` row for a signed contract and warranty-claim rows. Deleting the
  lead itself is limited to the owner and the tenant's company_admin (the
  firestore.rules comment says "only the lead owner or the tenant owner
  destroys data"). Managers could already `set` these rows, which can blank
  one, so the destructive power is the same. If deletes should match the lead
  rule instead, drop `isCompanyStaff()` to `isCompanyAdmin()` on both
  `allow delete` lines and flip the `del-mgr` assertion in §28d.
- **A viewer who owns a lead can write and delete its subcollections.** The
  lead doc itself is read-only for them. Making them read-only here is one pass
  over `tasks`, `notes`, `drawings`, `documents` and `warrantyClaims` together,
  create/update and delete alike. Flip the two viewer-owner lines in §28d when
  it lands.
