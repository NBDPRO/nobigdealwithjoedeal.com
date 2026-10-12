# Company owner hand-off: design, threat scenarios, results (2026-10-12)

**Result.** `transferCompanyOwnership` (Jo's ruling 2026-10-08, "owner
hand-off") is built, reviewed and tested. The owner hands the company to an
existing, active `company_admin`; `companies/{id}.ownerId` moves; the former
owner stays on as a `company_admin` with a roster row; their later account
erasure takes the member path (suspend, keep company data), Jo's
2026-10-08 ruling pinned in `tests/member-erasure-suspend-2026-10-08.test.js`. Nothing
about billing or payouts moves. Branch `feat/owner-handoff`.

The hard part was never the callable. The company **keeps its id**, and for a
self-serve or legacy company that id *is the former owner's uid*, so a
decade-old convention, "`companyId == request.auth.uid` means this is my
tenant", stopped being true the moment the callable succeeds. Everything below
is about making that convention safe again.

## What the callable does

`functions/handlers/admin.js` `transferCompanyOwnership` (callable, App Check
enforced, CORS list, 60 s, 5 per hour per caller):

1. `requireTeamAdmin` (re-reads the caller's Auth record: a suspended account
   with an unexpired token is refused), then the caller must be
   `companies/{id}.ownerId`. Not a company_admin, not a platform admin, not a
   platform owner token, not the platform company id, not a solo owner with no
   company doc. The tenant comes from the caller's claims; the payload names
   only the target.
2. The request must carry `confirm: true` (only the dashboard's consequences
   dialog sends it). A bare or scripted call is refused.
3. The target must be an **active, enabled `company_admin` of the same company**
   with a roster row in the same state; one generic refusal covers every
   "not eligible" shape so an owner cannot use it as an account oracle.
4. Refused while `connectAccounts/{id}` exists with an account id OR any status other
   than `failed` (a setup in flight has no account id yet), checked again inside
   the transaction (payouts, below).
5. Caller claims are merged first (a `company_admin` claim on a still-owner is a
   no-op), then ONE transaction re-checks the owner and the roster row and moves
   `ownerId` (+ `previousOwnerId`, `ownershipTransferredAt/By`), swaps the two
   roster rows (seat count unchanged), mirrors `users/{uid}`, and writes the
   audit row (ids only) in the same transaction. A race that moved `ownerId`
   aborts with no roster change.
6. After commit, the former owner's bot keys and calendar links are switched off
   (best effort, counts logged); target claims are NOT re-written from the
   pre-check read, so a racing removal cannot have them restored.
7. Replay: the former owner repeating the same call gets `replayed: true` and
   changes nothing; naming a different target is refused.

## What does NOT move: Stripe and money

- `subscriptions/{companyId}` is keyed by the company id, which does not change.
  The callable calls no Stripe API, touches no subscription, card or customer
  object, and charges nothing (pinned in the test: no `subscriptions/` or
  `connectAccounts/` write, no Stripe call in the function body).
- The **card on file keeps paying** until the new owner changes it in Billing,
  and the Stripe customer keeps the former owner's billing email. The
  confirmation dialog says so. Any `company_admin`, the former owner included,
  can open the billing portal; that is the existing 2026-10-06 rule, unchanged.
- A connected **Stripe payout account** belongs to the former owner's identity
  and bank. Handing the company over would silently leave customer payments
  flowing to the old owner (and hand the new owner an Express dashboard link to
  someone else's account). So the callable refuses while one is connected, with
  an honest message. **Decision for Jo:** lifting this needs a real
  re-onboarding flow (the Connect account is created once and `createConnectAccount`
  is idempotent), not a toggle.
- Webhooks key on `client_reference_id` / `metadata.companyId` = the company id.
  Unchanged, so no webhook mis-routes after a hand-off.

## The uid-as-tenant sweep (the part that would have failed review)

Every place that read `uid == companyId` as ownership, and what it is now.

| Surface | Before | After |
| --- | --- | --- |
| `firestore.rules` | uid-keyed branches in ~30 rules | one helper `ownsTenantByUid(cid)`: the uid branch also requires that no company doc names a different `ownerId` (no doc, or a doc naming you, is unchanged) |
| claim-less create pins (`data.companyId == request.auth.uid`) on leads, knocks, photos, estimates, invoices, ... (16) | stamped the old company id onto new records | `ownsTenantByUid(data.companyId)` |
| `settings/layout`, `skin/config`, `subs`, `email_suppressions`, `counters` (customer-id), `ownershipWriteOnce`, `taskStampOk`, `thursday_config` | bare uid | `ownsTenantByUid` |
| `companies/{id}` | owner could delete the doc (re-opening the uid key) | handed-off company is not client-deletable; `previousOwnerId` / `ownershipTransferred*` are server-only |
| `storage.rules` `isSoloCompany` | `companyId == uid` and claim default uid | also refuses a lower role (a demoted former owner keeps `companyId == uid` in claims) |
| `removeMember` | strips claims | on a **former owner** (uid == company id) also **disables the login**: an enabled claim-less account falls through every `claims.companyId \|\| uid` fallback (31 call sites) and reads as the owner |
| `pixel-draft.js`, `agent-mcp.js` `callerOf` | `company === uid` meant owner | refused for a lower role |
| `shared.js` `billingPortalRefusal` + `stripe.js` portal | solo branch on uid | needs `ownerId` null or self; the portal always reads the company doc |
| `invites.js` `claimInvite` | former owner (claim == own uid) looked like a free agent | `already_member`; the owner-must-Join rule from #1897 stands |

Already safe, and why (so nobody re-derives it): `requireTeamAdmin` /
`teamAdminDecision` take `ownerId` from the company doc whenever it exists, so
a claim-less former owner is not an admin; `createCompany` refuses a doc whose
`ownerId` is someone else ("Company id conflict"); `resolveErasureScope`
decides owner from `ownerId`, so erasing the former owner is the member path
and `confirmAccountErasure` keeps the company's billing doc.

## Threat scenarios and results

Every row is a test with a positive control; the break-test column is which
assertion reddened when the guard was removed (a vacuous result is a finding).

| # | Attack | Closed by | Proof |
| --- | --- | --- | --- |
| 1 | company_admin self-promotes by calling the callable | owner check + in-transaction owner check | `owner-handoff` B2 break: "another company_admin cannot hand it off" + "...anywhere either" red |
| 2 | rep / manager / viewer calls it | `requireTeamAdmin` | B: 3 refusals |
| 3 | platform admin / owner token acts for a company | explicit refusal (and claims never rewritten) | B |
| 4 | another tenant's owner supplies a spoofed `companyId` | tenant from claims only | D: payload ignored, co-b untouched |
| 5 | scripted call with no dialog | `confirm: true` required | B1 break: both confirm assertions red |
| 6 | hand-off to a rep, an invite, a disabled, unknown or other-company account | generic refusal (7 shapes, one message) | C |
| 7 | claims drift (roster says admin, claims say rep) | claim check, then roster re-check in the transaction | B6 and B5 breaks each red a different assertion |
| 8 | double hand-off / race | transaction re-reads `ownerId` | D: aborted, one owner, no roster change |
| 9 | replay by the former owner | idempotent success, no mutation | D |
| 10 | former owner keeps owner-only features | ownerOnly gates read the doc | F: refused at an ownerOnly gate, passes the plain admin gate as non-owner |
| 11 | removed former owner (login re-enabled, claims empty) acts as owner | rules `ownsTenantByUid`; `requireTeamAdmin`; `createCompany` conflict; portal refusal | rules HANDOFF block (49 checks), F, H |
| 12 | removed former owner injects records stamped with the company id | create pins | HANDOFF leads/knocks; R2 break reddens exactly those |
| 13 | demoted former owner (rep) edits layout / skin / subs / catalogCosts | `ownsTenantByUid`, storage role refusal | rules + storage HANDOFF blocks |
| 14 | former owner joins another team while still a member | `claimInvite` `already_member` | F + B10 break |
| 15 | new owner deletes the company doc to revive the uid key | handed-off doc not client-deletable | HANDOFF delete deny |
| 16 | payouts or card silently change hands | no Stripe call; refused while Connect exists | E + B4 break |
| 17 | removal of a former owner leaves an enabled owner-shaped account | login disabled with the claim strip | G + B3 break |
| 18 | audit gap | audit row in the transaction, ids only | A + B11 break |

Break-test method: `ownsTenantByUid` neutered (23 HANDOFF assertions red, all
of them `HANDOFF:` labels, no others), and 9 per-site reverts (13 red, exactly
the matching labels). Functions: 12 single mutations, each reddened its own
assertion; one (B6) first came back vacuous because the transaction re-check
masked the claim check, so a "claims drift" scenario was added and it now
reddens.

## What a former owner can and cannot do

- **Still on the team as company_admin:** everything a company_admin does,
  including the billing portal, team management (but never the owner's account:
  `protectedTargetRefusal`), and all company records. They keep their own
  authored records and files.
- **Cannot:** hand the company anywhere, use any owner-only gate (seat money,
  Connect, publish site), delete the company doc, take `ownerId` back, remove or
  demote the owner.
- **Demoted to rep:** sees the records they authored (their leads: the whole
  history, because they created it). If Jo wants the history to move, **Remove**
  them, not demote: removal reassigns their records and files to the owner and,
  for a former owner, turns the login off.
- **Removed:** claims stripped, tokens revoked, login disabled, records and
  files moved to the new owner. They need a new account to use NBD Pro again.
  The one way back in is a platform admin re-enabling the account by hand; the
  rules still treat it as a stranger, but the 31 `claims.companyId || uid`
  function fallbacks are now stopped at the entry points by `tenant-guard.js`
  (a claim-less account whose uid is another owner's company id is refused).
- **Stale token window:** their current ID token keeps its old claims for up to
  an hour (the dashboard refreshes its own on success). Owner-only gates read
  Firestore, so they lose those at once.

## Security review follow-up (reviewer findings, all verified by tests)

An independent read-only review (nbd-security-reviewer) could not run code, so each finding was reproduced or disproved here.

| Finding | Sev | Status | Fix and proof |
| --- | --- | --- | --- |
| OPEN-1 `social-studio.js` treated `companyId == uid` as owner for any role (publishes company photos publicly) | High | CLOSED | uid branch refuses manager/sales_rep/member; Social callables guarded; break C1, C5 |
| OPEN-2 `claims.companyId || uid` fallback at ~20 sites for a claim-less former owner | High | CLOSED at the entry points | new `functions/tenant-guard.js`: a claim-less token whose uid is another owner's company id is refused in `callableRateLimit`, `requireAuth` (all onRequest, incl. Stripe checkout/portal/payment link, AI), email/SMS `verifyAuth`, agent-mcp, pixel-draft, lead-brief, social-studio; breaks C2-C7. One cached read per 30 s, claim-less tokens only, fails open on a read error |
| OPEN-3 removeMember: disable could fail after the claim strip and the retry was refused | High | CLOSED | disable first; a former owner is provably the company's by uid so a retry finishes; breaks C8, C9 |
| OPEN-4 hand-off racing a removal re-asserted stale claims | Med-High | CLOSED | no claim re-write; removeMember takes the roster row off `active` before stripping, the transaction re-reads the row; breaks C10 plus the interleave test |
| OPEN-5 payout setup in flight (`creating`, no accountId) | Med | CLOSED | predicate = account id or any status but `failed`, re-read in the transaction; breaks C11, C12 |
| OPEN-6 demoted former owner keeps write access to everything they authored | Med | **needs Jo** | not changed: reassigning the whole book (and Storage files) at hand-off is a product call. Default today: to take the history, Remove them (that reassigns records and files and turns the login off) rather than demote |
| OPEN-7 bot keys / calendar feeds survive hand-off | Med | CLOSED | revoked at hand-off; break C13 |
| OPEN-8 billing payer, dunning and trial mail stay on the former owner; their erasure keeps the plan alive on their card | Med | **needs Jo / counsel** | not built. Removing a former owner now reports `billingOnFormerOwner` and the dashboard says so (break C14). Rerouting Stripe mail to the new owner and changing the customer email needs a decision on who owns the payment relationship |

The reviewer's "reactivateUser refuse a target whose uid == companyId" is covered: re-enable needs `callerMayManageTarget` (claims) and a removed former owner has none, and the login is disabled.

Also verified by me (not covered by the reviewer): `storage.rules` (role gate, tests), `invites.js` claimInvite / createTeamInvite / ensure-company branches, `public-site.js` slug-ensure (create only when the doc is missing), `calcom-logic.js:258` (`ownerId`-based, follows the new owner), `referral-rewards.js:87` (a former owner's referral still counts for the company: intended), `measurement.js:338` (owner-authored reuse, no tenant grant), `photo.js:144` (company_admin signs via `users/{uid}.companyId`, which the hand-off writes), `member-offboarding.js:222` (feed allowed only while claims point at the company; revoked on removal).

## Known gaps (not fixed here)

- A non-owner's UI edit gates in `maps-customers.js` / `pipeline-builder.js`
  still read `companyId == uid` as "owner keyed by uid"; the rules refuse the
  save, so it is a surprise denial, not an exposure.
- Lead alert contacts and billing email may still point at the former owner.
- Files authored by the former owner stay under their uid path until removal;
  the new owner reads them through the stored download URLs, as admins do for
  reps today.

## Tests

- `tests/owner-handoff-2026-10-12.test.js` (functions, real handlers, real
  `requireTeamAdmin`, in-memory Firestore/Auth): 128 checks.
- `tests/firestore-rules.cross-tenant.test.js` HANDOFF block: 70 checks, 55
  of them new (442 total), emulator, including UPDATE and DELETE attempts by a
  removed or demoted former owner on members, owner_numbers, settings/layout,
  skin, subs and social_posts, each with an allow control.
- `tests/storage-rules.test.js` owner hand-off block: 8 checks, emulator.
- Run: `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy npx firebase-tools emulators:exec --only firestore --project nbd-xtenant-test 'node firestore-rules.cross-tenant.test.js'`
  from `tests/` (use another port if a parallel session holds 8080).
