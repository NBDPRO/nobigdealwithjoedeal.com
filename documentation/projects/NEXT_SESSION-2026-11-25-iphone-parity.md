# Next session: iPhone / Android CRM parity (2026-11-25)

Lane handoff, not the live brief (the Current handoff pointer in [INDEX](../INDEX.md) still
names the live one). Full findings: [IPHONE-ANDROID-PARITY-2026-11-25](../audit/IPHONE-ANDROID-PARITY-2026-11-25.md).

## The ask

Joe uses the CRM on an Android phone (installed Chrome app) and an iPhone (Safari /
home-screen app). Android felt "further along"; he wants both identical.

## What was wrong (short version)

No code serves the two phones different builds. The gap was how the iPhone app boots,
resumes and updates, plus Safari-only bugs:

- Feature flags stayed **off for the whole session** when an iPhone signed in slower than
  10 s (47 files read them).
- The installed iPhone app kept **old builds for days**: it reloaded only when `sw.js` changed.
- iPhone-only bugs:
  - invalid theme-color
  - `sms:` bodies that iOS drops
  - D2D memo saved as webm
  - share-sheet / picker taps that Safari expires
  - zoom-on-focus inputs
  - sheets and dialogs under the status bar
  - long-press text selection
  - no touch drag on the board
  - iPad treated as a desktop
  - Add Lead dropdowns drawn grey
  - blank empty date fields
  - text enlarging in landscape

## State of the PRs (as of writing)

| PR | What | State |
|---|---|---|
| [#3241](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3241) | Flags retry + re-read on resume; new build offered on resume; theme-color; `?&body=` sms links; memo type; share/camera taps; map voice loop; 16px inputs; sheets clear the status bar; Record a Visit / New Estimate in + Create | **merged** |
| [#3244](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3244) | 21 centred dialogs + Edit Customer modal clear the status bar and home bar | **merged** |
| [#3245](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3245) | `-webkit-user-select` everywhere; kanban cards hold a long-press for their menu (no callout) | **merged** |
| [#3248](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3248) | Hold-then-drag cards between Board columns on touch (`kanban-touch-drag.js`, lazy, touch only) | **merged, live** |
| [#3249](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3249) | iPad (Mac UA + touch) gets the estimate share sheet and the portal Share hint | **merged, live** |
| [#3250](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3250) | `.mfield select` drawn the same in Safari and Chrome (native skin off, drawn arrow) | **merged, live** |
| [#3251](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3251) | Empty date field on iOS shows "mm/dd/yyyy" + calendar icon (`ios-date-hint.js`, iOS only) | **merged, live** |
| [#3252](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3252) | `-webkit-text-size-adjust` at every width (landscape) | **merged, live** |

**Update (2026-11-25, end of session):** all eight PRs are merged and deployed; #3252 (landscape text size) was the last, after a merge of main to clear a version-number conflict on `dashboard.html`. Nothing from this lane is left in flight. One CI pattern to know: the PR-level **"Pro demo zero-network walk (Chromium)"** job was cancelled part-way on #3249 and after every test passed on #3252 ("The operation was canceled", no test failure). The merge queue runs its own checks, so it did not block either merge; re-run the job if it ever does.

## Decisions Joe made (do not relitigate)

- Fix everything on the list; don't wait for screenshots. Fold them in if he sends them.
- WebKit download approved (Playwright WebKit 2370, installed in a separate browsers folder under the session scratchpad, so it may be gone). A failed `playwright install` once wiped this machine's shared browsers, so install WebKit with its own `PLAYWRIGHT_BROWSERS_PATH`.
- **Touch drag:** hold ~0.3 s to lift, drag to a column, release to move. Release without moving gives the 0.5 s card menu as before. Board view on any touch screen.
- **Empty date fields:** grey "mm/dd/yyyy" hint + calendar icon, iOS only.
- **New build on resume** is *offered* (the "New version ready" bar), not forced. It reloads on a tap, or when the app is left while idle. (A review finding: the busy check can't see uploads or in-memory estimates.)
- The server still writes missed-call links as `?body=` (the call-feed golden fixture needs Joe's OK to re-bless). The phone upgrades them to `?&body=` wherever they're shown or opened.

## Things to know

- **Dashboard boot budget:** 204 B of shipped-script room left once #3251 lands (its iOS loader costs ~360 B). Measure before any dashboard JS change. Lazy bundles and injected scripts don't count.
- **Playwright WebKit on Windows is not iOS.** It has no date picker (`.type` reads `'text'`), reports 0 touch points even with touch on, draws native selects differently, and drops iOS-only CSS (`-webkit-text-size-adjust`, `-webkit-touch-callout`). Use it for parsing, layout and CSS application. Notch, home bar, tap-permission timing, `sms:` and resume need a real phone.
- **Local test runs:** the manifest runner's 8-minute budget skips suites locally. Run every node-bucket suite in parallel instead (all 1,205–1,211 passed on each branch).
- Force-push is blocked by the repo's safety hook. After a rebase of an already-pushed branch with no PR, push under a new name (that's why #3248's branch is `claude/crm-kanban-touch-drag-2`).

## Joe's real-iPhone checklist (after the PRs deploy)

1. Swipe the home-screen app away and reopen it. From then on, a later deploy shows a "New version ready" bar.
2. Features match Android after a cold start on weak signal.
3. Status bar dark on both phones.
4. Text links open Messages with the body filled in.
5. A D2D voice memo plays back.
6. Estimate share: the share sheet, or a one-tap "share it now" box. Also on an iPad.
7. Tapping fields never zooms.
8. Sheets and dialogs sit below the clock / Dynamic Island and above the home bar.
9. + Create: Record a Visit and New Estimate work.
10. Long-press a pipeline card: only the card menu (no blue selection, no Copy bubble).
11. Board view: hold a card, drag it to another column, release: it moves. A quick swipe still scrolls.
12. Add Lead dropdowns dark like the text fields; empty date fields show mm/dd/yyyy + icon.
13. Turn the phone sideways: text stays the same size.

## Still open

- Nothing from the original list. If Joe's screenshots show something else, start from the audit note.
