# NEXT SESSION — 2026-09-26 handoff

Jo stopped the 2026-09-25 power session at about 01:00 on 09-26 because he was near his usage limit. At that point one workflow was running (rebases, a re-verify and three new security lanes). It was **stopped mid-flight**. This note records exactly where every thread stopped. Treat anything marked *unverified* as unverified.

Previous handoff: [NEXT_SESSION-2026-09-25](NEXT_SESSION-2026-09-25.md). Its §0 asks were all answered and built (see §2).

## §0 Start here: open PRs, in order

Before starting any slice, run `gh pr list --state open` and `git worktree list`. Main at handoff: `fff5a32c` (#1774).

1. **#1778, `ci/syntax-gate-e2e-specs`** (head `73c38e1c`). This is the syntax gate.
   - It now parses `tests/**`. It also actually parses the 47 ES-module files under `docs/`: before, a bare `node --check` on a file with `import`/`export` exited 0 without parsing it.
   - It was rebased onto `fff5a32c` and pushed, and CI was running at the stop.
   - **Merge when green.** First re-check that it merges cleanly against the current main (see §7).
2. **#1780, `fix/viewer-callables`** (PR head `69000a2a`). This refuses the viewer role in every Cloud Function that writes, sends, mints a link or spends money.
   - Its review verdict was *approve*, and the follow-up fixes were pushed.
   - GitHub shows it **DIRTY**: #1779 edited the same `FLOORS` line in `scripts/run-test-manifest.js`, plus `tests/ci-manifest.json` and `tests/package.json`.
   - The worktree `C:/Users/jonat/nbd-wt-callrole` has a local HEAD of `847696aa`, which is **behind** the PR head. Fetch and reset to `origin/fix/viewer-callables` before rebasing.
   - When rebasing, combine the entries on both sides and re-measure the floors with `node scripts/run-test-manifest.js --check`. Then run its tests, and merge when green.
3. **#1777, `fix/lead-subtree-sweep`** (PR head `8e834ee7`). This closes the re-created-lead-id hole.
   - **The hole:** subcollection rules authorise through the parent lead. After a hard delete, a stranger who re-creates the same id could read what was left underneath.
   - **What the PR does:** `onLeadDeleted` now sweeps the whole subtree. It finds subcollections with `listCollections()`, runs race-safe on createTime/updateTime versus the event time, uses `lastUpdateTime` preconditions, and skips rows belonging to a lead that was re-created at the same id.
   - **Its first review found 3 blocking issues and 8 minor ones.** The follow-up fixed all 11, including:
     - top-level `/notes` rows that point at the lead;
     - **the homeowner portal now shows an estimate, invoice or signing envelope only if it belongs to the lead's company.** This also closes an older gap, where another tenant could put a document with a pay link in front of your homeowner;
     - reserved lead ids;
     - uids taken from rows.
   - **That follow-up has NOT been independently reviewed.**
   - It is **DIRTY** because of a *semantic* conflict with #1779 in `functions/integrations/voice-intelligence.js`. #1779 added the path check on the recordings retention cron. #1777 stops D2D voice memos from creating rows under `leads/d2d`. Keep both.
   - The worktree `C:/Users/jonat/nbd-wt-subtree` holds a **stopped agent's partial resolution**: HEAD `7d1a489a`, with 3 staged files (the vault note, `voice-intelligence.js` and `tests/lead-photo-reaping.test.js`). Treat it as untrusted. Either review it, or `git reset --hard origin/fix/lead-subtree-sweep` and redo the rebase.
   - **Next steps:**
     1. Rebase.
     2. Run two independent verifiers. One is for data loss: another tenant's objects, a legitimately re-created lead, D2D memos, and the retention cron. The other is for portal regressions: a genuine homeowner must still see every estimate, invoice and envelope, for solo owners with `companyId == uid`, legacy docs with no `companyId`, and company tenants. A genuine document disappearing is **blocking**.
     3. Fix what they find, then merge.
4. **Then the production cleanup Jo approved** (2026-09-26, about 01:00, explicit "Yes, delete them"). After #1777 merges:
   - `node scripts/audit-orphaned-lead-subtrees.js --project nobigdeal-pro` removes the **7 orphaned rows** under 1 hard-deleted lead (activity 4, tasks 2, portal_messages 1; none point at Storage).
   - First check that ADC reports `nobigdeal-pro` and that `FIRESTORE_EMULATOR_HOST` is unset.
   - Do a dry run first (counts only), then run with `--delete --yes`, then re-run the dry run to confirm 0.

## §1 What merged on 09-25 (in order, all green; the ones that trigger a deploy are live)

- **Phone audit campaign:** #1743–#1754, then follow-ups #1767, #1769, #1770, #1772, #1773 and #1775. Highlights:
  - **#1746:** remote signing was broken in production since about April (a CORP header). Fixed and verified live.
  - **#1772:** contracts are readable on phones in the portal and the doc viewer, and the stored and signed record stays byte-identical to desktop.
  - **#1773:** "View details" mid-upload no longer drops the rest of the batch or lies with "Uploaded N".
  - **#1775:** the kebab menu, a rotate blanking the list, the cancelled-leave nav highlight, card density, and lazy templates running their scripts twice.
- **Privacy:** #1751 removed a contractor cost from the published catalog.
- **Upgrades & Add-ons:** #1756 (core library and pricing), #1758 (honest paperwork: no phantom tier, job-type workmanship warranties), #1762 (Settings → Upgrade prices), #1763 (the builder card, Show homeowner, and V2 keeping upgrade rows). Design: [UPGRADES-ADDONS-DESIGN-2026-09-25](UPGRADES-ADDONS-DESIGN-2026-09-25.md). Stages 1 and 2 are built.
- **Money:**
  - **#1760:** gutters are priced from one footage (drawn feet when present, otherwise the eave).
  - **#1765:** one deposit rule everywhere. Cash under $2k: no deposit. Cash $2k and up: 50% at signing. Insurance: the deductible up front at minimum, normally plus the ACV check. See [DEPOSIT-RULE-2026-09-25](../audit/DEPOSIT-RULE-2026-09-25.md).
  - **Production write on Jo's OK:** the NBD profile's old `paymentTermsContract` and `paymentTermsProposal` were deleted, and `paymentMethodsNoCash` now **accepts cash**. The fields read back 31 → 29.
  - The read-only production audit of "Classic re-priced logged estimates" found **0 affected**, so no repair is needed.
- **Draw rebuild:**
  - #1757 and #1759: the installed-app drawer and address search.
  - L1 #1761: the geometry module and a touch harness.
  - **L2 #1764:** fixed the facet double count (1,075 → 2,150 sf), chained gutter runs, the estimate import mapping, per-structure totals, and undo/redo.
  - L3 #1768: the `drawMap.nbdDraw` seam.
  - **L4 #1766:** the crosshair screen, place → adjust with a magnifier → Confirm. **It ships OFF behind "Crosshair drawing (beta)"** in Draw → ☰ Tools, below the Controls row.
- **Security and roles:**
  - **#1771:** owners can delete lead `documents`/`warrantyClaims` rows (a `request.resource`-on-delete trap).
  - **#1776:** Jo's decisions. Viewers are read-only everywhere in the rules, the Storage rules and the client (`role-gate.js`). Hard delete of contract and claim rows is owner + company_admin only.
  - **#1779:** invites are claimed only from `companies/{id}/members/{email}` (the forged-invite hole). The `users/{uid}` subcollection writes are allowlisted. Production had **0** `members` docs.
- **#1774:** the boot company-profile read now retries.
  - It went through **two independent review rounds**, and each found new blocking issues: a cache-served partial snapshot could wipe jurisdictions, a same-tenant re-read left defaults in memory, and cross-tenant writes were possible after an account switch or a claims change.
  - All of those are fixed. The loaded-tenant key is `window._companyProfileLoadedKey()`, and each Estimates-panel paint records the tenant it was painted for.

## §2 Jo's decisions from this session (final, do not relitigate)

- **Deposit rule** as above, including accepting cash. Memory: `deposit-rule-2026-09-25`.
- **Upgrades:**
  - Guard prices: Amerimax Lock-In $6/LF, LeafBlaster $12, Reinforced $15, Alu-Rex $18.
  - Warranties: 5-year systems, 2-year guards, and repairs get a 1-year warranty only when the box is ticked.
  - Loper's sub prices are **private** (memory only, never under `docs/`).
- **Draw:**
  - Crosshair with place/move/confirm plus a RoofLink-style magnifier.
  - Per-structure totals.
  - Drawn gutter LF prices gutters once.
  - Ridge vent ≠ ridge cap.
  - **A daylight iPhone test before the crosshair goes live for everyone.**
- **Roles:**
  - The viewer is read-only everywhere.
  - Hard delete of contract and claim rows is owner + company_admin only.
  - **A signed contract is locked.** No one can change its content or status. The owner or a company admin can only archive it. *Not built yet (§4).*
- **Invites need an explicit Join.** Jo was told the build started and did not object. *Not built yet (§4).*

## §3 Waiting on Jo

- **Crosshair daylight test** on his iPhone installed app. Draw → ☰ Tools → scroll below Controls → "Crosshair drawing (beta)". Signing out resets the switch.
  - When he's happy, the go-live is a one-line change: `CROSSHAIR_DEFAULT_ON = true` in `docs/pro/js/draw-reticle.js`. Anyone who explicitly chose Off stays off.
- **Loper:**
  - his name in Settings → Upgrade prices;
  - his written 5-year backing;
  - the optional K5/K6 apron/drain pre-tick decision.

## §4 Lanes designed but not built (branches created at `fff5a32c`, no commits)

Worktrees exist, but they are empty: `nbd-wt-signlock`, `nbd-wt-inviteaccept`, `nbd-wt-publead`. The full briefs are in the stopped workflow script: `~/.claude/projects/C--Users-jonat-nobigdealwithjoedeal-com/0bad9f44-4f61-4ddf-9d9f-dc8bf4d3db28/workflows/scripts/batch4-rebases-verify-and-security-wf_5e25e561-352.js`. Workflow resume works only within the same session, so reuse the briefs rather than trying to resume.

- **signlock (`fix/lock-signed-documents`):** Jo's lock-once-signed decision.
  - **Rules:** after signing, a client may change only the archive/soft-delete fields, and only as the owner or company_admin.
  - **Storage:** signed artifacts cannot be overwritten either.
  - **Must keep working:** the signing transition itself (in-person in the doc viewer, and remote via `sign.html`) and the server paths that update signed docs.
  - **Client:** a locked-document message.
- **inviteaccept (`fix/invite-explicit-accept`):**
  - **The problem:** `dashboard-bootstrap.module.js` (~L1795-1822) calls `claimInvite` automatically at boot for anyone with no `companyId` claim or with `companyId == uid`. That includes **Jo's own solo account**. A real invite from any paid tenant silently re-points that account.
  - **Preview first:** fetch the invite without claiming it, then show a "Join team / Not now" modal.
  - **Solo owners with data** get a strong warning and a second confirm.
  - **Declines persist** on `userSettings` or on the member doc, *not* in `nbd_` localStorage.
  - **Sign-up through the invite link counts as acceptance.** Document why.
- **publead (`fix/public-measure-path-allowlist`):**
  - **The problem:** `functions/integrations/public-measure.js` (~L217-224) makes an Admin-SDK write to `${lead.publicLeadCollection}/${lead.publicLeadId}`. Both fields can be set by the client, and the path can also trigger a paid vendor call.
  - **Fix:** allowlist the collection, validate the id, and verify a back-reference.
  - **Rules:** clients may not set `webLead`, `publicLeadKind`, `publicLeadCollection` or `publicLeadId`.
  - Also sweep `functions/` for other writes to client-controlled paths.

## §5 Known leftovers (not fixed, all verified or disclosed by reviewers)

- **Flaky test:** `nav-drawer.spec.js` "drawer is usable on homepage" [mobile-webkit], in Public-surface E2E.
  - It failed twice on unrelated PRs on 09-25; the scroll restore after closing the drawer was off by 1200, 105, 8 and 84 px.
  - 36 of 38 recent runs were green, and no homepage code changed. The rerun passed. Investigate if it recurs.
- **Documents on phones:** 22 of the 26 doc types use the non-contract template, which is still 10–11px on phones. The contract price table clips about 30px at 320px wide. Reopening a fully signed doc in the viewer blocks Download/Print with "Sign required:" (this predates the session).
- **Uploads:** signing out mid-batch loses the batch (a persistent queue is needed), and failed photos drop out of the queue when the batch ends.
- **After a same-tab account switch** (predates #1774 and is outside its diff):
  - the Pipeline builder save, the Settings → Company Profile save and the AI persona team default are not tenant-gated;
  - `customer.html` never resets the profile.
- **Viewer gaps:**
  - A viewer can still delete rows they own by erasing their account. That is Jo's call, because blocking it also blocks a person's own erasure.
  - 4 paid read callables remain open to viewers, each backing a read control.
  - The paid voice-memo path with no `leadId`.
- **#1776 open questions:** a manager can still overwrite a signed row until signlock lands. The platform admin can delete a lead but not its contract rows (fine as is).
- **Deposit:**
  - A reopened placeholder estimate says "Your deductible" while the invoice prints $1,000.
  - `estimate-v2-ui.js:4803` treats $2,500 as "not entered".
- **Draw, deferred:**
  - Shadow Pitch's drawer copy still says "Tap two points".
  - The post-close edge review with pitch buttons, Set length and the 90° assist are not built.
  - With the engine in Eave/Rake mode, no Draw Mode button shows as active.
- **Behaviour changes to mention to Jo:**
  - Auto view plus a rotate to landscape wider than 768px now shows the Board.
  - The card density toast is gone; the menu label shows the setting.

## §6 Rig and cleanup

- The emulator rig and its watchdog were **stopped** at handoff.
  - The scripts are `%TEMP%/claude/emu-watchdog.sh` and `emu-kill.ps1`.
  - Re-seed with `%TEMP%/claude/phone-audit/reseed.js`; the static server is `serve.js` in the same folder.
  - Start the watchdog *before* any parallel E2E workflow. Memory: `emulator-rig-watchdog`.
- **Many worktrees are left** at `C:/Users/jonat/nbd-wt-*`, most for merged branches.
  - Clean them up with `git worktree list`.
  - **Remove any `node_modules` junction with PowerShell `[System.IO.Directory]::Delete`, never recursively.** A recursive delete wipes the shared target.
  - Keep `nbd-wt-subtree`, `nbd-wt-callrole` and `nbd-wt-syntaxgate` until their PRs merge.

## §7 Lessons from this session

- **GitHub "CLEAN" can be stale.** #1774 showed CLEAN with 22/22 green on a main that was three merges old. The merged tree had a duplicate `const { devices }` SyntaxError in an e2e spec, and no Node gate parsed `tests/`.
  - Before merging a PR whose CI predates main, run `git merge-tree --write-tree origin/main <head>` and `node --check` the touched files (ESM files via `--input-type=module` on stdin). Afterwards, confirm main's own CI run.
  - #1778 closes the gate gap. Memory: `stale-clean-hides-broken-merge`.
- **Review every follow-up fix independently when it touches data safety.** On #1774, each review round found *new* blocking bugs the previous fix introduced or exposed.
- **Don't message running workflow agents.** It made lanes forget their own edits.
- **A watchdog, not Monitors, for the shared emulator.** It wedged about 7 times under parallel load.
