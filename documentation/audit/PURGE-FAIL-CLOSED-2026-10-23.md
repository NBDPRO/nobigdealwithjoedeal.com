# Shared-device purge: fail closed (2026-10-23)

Overnight audit finding (HIGH): on an account switch `onAuthStateChanged` in `docs/pro/js/dashboard-bootstrap.module.js`
called `window.NBDAuth.purgeAccountStorage()` only `if (window.NBDAuth && ...)`, then ALWAYS wrote `nbd_last_uid = <new uid>`.
If `nbd-auth.js` had not assigned `window.NBDAuth` yet, or the purge threw, the purge was skipped and the record of the
previous account was erased, so the second defence (Daily Success sync, keyed on `nbd_last_uid`) saw no switch. Account B
then read A's cached leads, progress photos and queued texts.

## Fix
- The uid is recorded only after the purge ran. A switch the callback cannot purge in its first tick is settled by
  `_settleOwedPurge` (waits up to 5 s for `NBDAuth`, awaits the purge, then records the uid). Nothing after it (subscription
  read, `loadLeads`, rendering cached rows) runs before it returns.
- If the purge still cannot run (or rejects), it fails closed: `_failClosedClear` removes the `nbd_`/`nav-` keys (keeping
  `nbd_last_uid` and the unsent door-knock queue, which is work), deletes IndexedDB `nbd_ds_photos`, `nbd-myskin` and the SMS
  outbox, and leaves `nbd_last_uid` on the old uid so the next load retries. It skips the wipe if another tab already settled
  the switch.
- A purge that resolves `false` (SMS outbox blocked or timed out) drops the SMS database directly.
- `ds-firebase-sync.js` (the second writer of `nbd_last_uid`) now awaits the purge, so a rejected purge pauses the sync
  instead of recording the new uid.

## Not fixed here (open)
- The account-switch path does not call `clearFirestoreCache()` (only logout / `_signOut` do); whether Firestore's persistent
  cache can serve A's documents to B needs a browser repro.
- The fail-closed SMS delete also drops PII-free "sent" receipts; the normal purge keeps them. Accepted on a rare path.
- Real-deal-academy's `window.NBDAuth &&` checks are access gates, not purges; left alone.

## Verification
`tests/account-switch-purge-fail-closed-2026-10-23.test.js` (38 checks) runs the real callback block and helpers lifted from
the module against a fake device. It includes a control showing the pre-fix block leaks. Mutation runs (always record the
uid, drop the await, no fail-closed clear, no wait, rejected purge counted as done, fallback advancing the uid, queue wipe,
no re-read, `false` ignored, sync not awaited) each went red. An `nbd-security-reviewer` pass found the sync second-writer,
the queue wipe, the `false` result and the multi-tab case; all four are addressed above.

## Follow-up: photos hidden from other accounts (2026-10-23, PR after #2695)
Residual gap: if `nbd-auth.js` never loads and the user leaves within the 5 s wait, `nbd_last_uid` stays on A and A's
IndexedDB `nbd_ds_photos` survived; B could read it on Daily Success (the sync paused but did not clear it). Two locks:
- each photo now records the account that took it (`owner`). `NBDPhotos.visible()` shows a photo only to its owner, and only
  once `nbd_last_uid` equals the signed-in uid (the switch settled); an unsettled switch shows nothing, and adding a photo is
  refused until it settles. Photos from before owners existed are claimed by the first settled account to open the card.
  Hidden, not deleted: the owner gets them back.
- `ds-firebase-sync.js` deletes the photo database directly in both "cannot purge" branches, and exposes
  `window.NBDDsAuth.uid()` plus an `nbd-ds-account` event so the card re-checks when the account is known / settled.
Tests: `tests/tracker-photos-owner-gate-2026-10-23.test.js` and two new checks in `tracker-account-switch-2026-10-21.test.js`;
eight mutations each went red. Still open: the other Daily Success data (pages, workouts) stays on the phone during a paused
sync; that is the older "Sync paused" design.
