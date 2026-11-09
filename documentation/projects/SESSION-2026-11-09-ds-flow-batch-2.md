# Session 2026-11-09: Daily Success flow batch 2 (M8, M9, M14, M15)

Source: [the UX audit](../qa/daily-success-ux-audit-2026-11-09.md), section 3, Tier 2. Builds on [the quick wins](SESSION-2026-11-09-ds-quick-wins.md).
Only the four items that need no answer from Jo. Skipped: everything that waits on his six open decisions (open on today, cover poster,
auto-tick floors, jump sheet placement, Dash layout, delete / SAVE) and all other Tier 2 items. Saved-page data keys are unchanged.

## Built

| # | What shipped | Where |
|---|---|---|
| M9 | **One sync chip** in the header (`#sdot`, the old READY / SAVED dot). Four states: saved on phone and syncing, `SYNCED 3:42 PM`, `NOT SYNCED - TAP TO RETRY` (stays up, a keyboard-reachable button), signed out. Also `UNSAVED`, `OFFLINE` and `SYNC PAUSED`. `ds-firebase-sync.js` tells it through an `nbd-ds-sync` event. A failed push or load retries with backoff (2 s, 5 s, 15 s, 45 s, 2 min, then 5 min), at once on the `online` event, or on a tap (`NBDDsCloud.retry`). Retries do not flash the old pill. `savePages()` is wrapped in try/catch: a full or blocked storage returns false and shows one red toast instead of throwing out of every caller. On a phone the long-only words ("ON PHONE", "TAP TO") are hidden so the chip fits the 52 px header row at 320 px; the title takes an ellipsis instead of pushing the chip out. | `js/sync-chip-logic.js` (pure), `js/sync-chip-ui.js`, `ds-firebase-sync.js`, `js/app.js` |
| M8 | **Back works.** `js/nav-router.js`: `switchTo` and `smartNewPage` push one entry per new view (`#dash`, `#day-<id>`); the coach, money sheet, Sunday review and history import push `#ov-<name>` on open. `popstate` closes the top overlay first, then returns to the previous view. Closing an overlay from the screen (Close, Escape) takes its entry back off, and a push issued while that is in flight waits for it. The page never reads the hash on load; the first view is recorded in place. | `js/nav-router.js`, `js/app.js`, `workout-coach.js`, `money-ui.js`, `review-ui.js`, `tracker-history-ui.js` |
| M14 | **Rest timer that persists and shows.** `rest.until` and label are stored under `nbd_ds_coach_rest` (this device only; not part of the synced workout). A slim "Rest m:ss - Skip" bar (`#dsRestBar`, 44 px touch target, fixed above the safe-area inset) shows on every view whenever a rest is running and the coach is closed, so the buzz is never a mystery; the coach keeps its own line while open. Reload restores a running rest; one that ended over a minute ago is dropped; one that ended since shows "Go - next set" without buzzing again. Skip clears it. | `workout-coach.js`, `css/workout-coach.css` |
| M15 | **Tokens.** A `:root` block mirrors the DESIGN.md foundation tokens (`--ui-space-*`, `--ui-fs-*`, `--ui-radius-*`, same names and values as `ui-primitives.css`). Nothing reads them yet, so no layout changes. The first, overridden `.pc`, `.ph` and `.ph:hover` rules are gone (every property was set again by the later copy, so the cascade result is identical; the computed card radius, shadow and header padding are pinned). | `index.html` |

Also fixed because the chip made it visible: `collectPagePatched` dropped the original `collectPage` return value, so `flushDirty` and the 30 s timer
never marked a page saved and the dot read UNSAVED until a tab switch. It now returns the result. (The quick-wins test only asserted `includes('SAVED')`,
which `UNSAVED` also satisfies.)

## Tests (red first)

- New: `tests/ds-flow-batch-2-2026-11-09.test.js` (Chromium on the hosting server, plus the pure chip logic). Run before any code: 0 of the M9 / M8 / M14 checks
  passed (the module did not exist, and a back press left the app). Now 76 passed, 0 failed. Wired in `tests/ci-manifest.json`, `ci.yml` and `FLOORS.disk` (1186 to 1187).
- Extended: `tests/ds-sync-pill-and-workout-isolation-2026-10-23.test.js` runs the real sync module with a virtual clock: a failed sync is retried after 2 s, then 5 s,
  without touching the pill; a tap retries at once and ends on synced with a time; sign-in emits syncing then synced. The existing pill checks pass unchanged.
- Unchanged and green: every `ds-*`, `daily-success-*` and `nbd-os-ds-*` suite, the phone-fit sweep (88 layout x theme x width renders), `tracker-photos-owner-gate`.

## Left alone, for the notes

- The transient `.ds-sync-badge` pill stays for short confirmations ("Synced", "Saving...") because six tests pin it. It could be retired now the chip carries the state.
- "Keep a persistent notice when a merge overwrites local edits" is not built: the merge does not report which local edits lost, so there is nothing honest to say yet. Sync pausing does persist (`SYNC PAUSED` on the chip).
- Dead `#nbd-pro-nav` CSS in `index.html` (about line 572) is still there. The rest of M15 (stacked card margins, inline styles into classes, one 16 px card title, dropping Montserrat) was not part of this batch.
- A page opened on `#day-<id>` or `#ov-coach` still opens on the Dashboard; the hash is only written, never read.
- `smoke.test.js` and some `functions/`-dependent suites fail in this sandbox before and after (missing `functions/` dependencies, e.g. gbp-reviews); unrelated.
