# Estimate settings no longer reset to factory after sign-out — 2026-11-06 (MONEY/LOGIC)

From the 2026-11-06 full CRM audit (ST-F01; scorecard on the `crm/2026-11-06-tooling` branch).

## What was wrong
Settings → Estimates "Save All" (`_saveEstimateDefaultsV2`, `dashboard-bootstrap.module.js`) keeps markup /
overhead / profit, cost basis, job and repair minimums, round-to, dump fee and extra-layer price per device in
localStorage `nbd_est_settings_v3`. `NBDAuth.purgeAccountStorage()` (sign-out and account switch) deletes every
`nbd_*` key not on its KEEP list — on purpose, so the next account on a shared phone can't inherit them. Save All
also writes the same patch to `userSettings/{uid}.estimateSettingsV2`, but nothing ever read it back. So after
every sign-out, and on every new device, estimates priced at factory defaults while Settings said the saved values
apply to every estimate. (County permits, tax and cost book already moved to the company profile and were not
affected.) Not the older "settings never reach the engine" bug: the values do reach it — they just didn't survive.

## Fix
`_hydrateEstimateSettingsFromFirestore()` runs fire-and-forget at sign-in, after the account-switch purge has
settled: when this device has no `nbd_est_settings_v3`, it reads the signed-in user's own
`userSettings/{uid}.estimateSettingsV2` and restores it (through `EstimateBuilderV2.updateSettings` when the
lazy engine is loaded, else as the stored value, which `loadSettings()` merges over the defaults). This
device's own saved values always win; a save made while the read is in flight wins; an account switch during the
read writes nothing. The purge's KEEP list is unchanged (shared-device privacy).

## Verifier (fresh eyes): REQUEST CHANGES → fixed
- **Blocker, fixed:** Settings → Estimates "Reset to defaults" reset only this device, so the restore brought the
  reset values back on the next sign-in. Reset now also deletes `userSettings/{uid}.estimateSettingsV2`.
- The account check also uses the auth instance's `currentUser` (it moves before `window._user` on a switch).
- A Settings → Estimates panel painted before the restore landed is repainted (not while the rep is typing in it),
  so a Save All from it can't write defaults back over the account copy.
- Confirmed safe: stale saved tier rates are ignored by `loadSettings` unless their rate version matches; dump fee,
  extra layer and rates are overridden by the company profile at calc time; reading `userSettings/{uid}` is
  owner-only in firestore.rules; nothing depends on the key being absent after login.

## Proof
- `tests/estimate-settings-hydrate-2026-11-06.test.js` — the real function, extracted, Firestore stubbed: 15/15 (incl. Reset, auth switch, repaint);
  on main the function does not exist.
- Local harness: saved patch in userSettings, local key removed, reload → the engine's `loadSettings()` returns
  overheadPct 0.12 / profitPct 0.18 / minJobCharge 1234 (the saved values), no page errors.

## Known limit
The restore is asynchronous: an estimate priced in the first second after sign-in, before the read lands, still
uses defaults. Settings are per user, not per company (ED-F07 in the audit — whether they should be company-wide
is a NEEDS_JOE item).
