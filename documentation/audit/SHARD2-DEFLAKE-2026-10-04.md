# @shard2 deflake — 2026-10-04

Four authed E2E specs in **Authed E2E (emulators, @shard2)** failed on
unrelated PRs (CI jobs 111434273658, 111425829431, 111391961304), about 30
minutes of merge queue each. Root causes below. Two were real product bugs.

## Root causes

| Spec | What CI showed | Root cause | Fix |
|---|---|---|---|
| `phone-game-card.spec.js:47` | `:105` waited on `settings.enabled` to the 150 s test timeout (3 of 3 runs). Retry: `calls === 1` at `:66` | **Product.** `game-card.js` `loadSettings()` turned a rejected `getDoc` ("client is offline", which happens on a cold boot while Firestore is still connecting) into `{ enabled: false }` for the life of the page. Game mode was on, but the card never appeared until a reload. The retry failure came from leftover state: the failed attempt left game mode on, so the retry's first boot fetched the card before the spec's reset ran. | `loadSettings` retries a transient failure or an empty from-cache read (6 tries, backoff), never overwrites a choice made meanwhile, and gives up as off. The spec resets `userSettings.game` through the admin SDK **before** the first page load, and waits for the card fetch before tapping swatches. |
| `my-skin.spec.js:28` | `:35` waited on `NBDMySkin.state().cfg` to 150 s | **Product.** The `onSnapshot` listener skipped the from-cache snapshot and waited for the server copy. A user with no `userSettings` doc (or no change) only gets a *sync-state* change, and the SDK raises that only with `includeMetadataChanges` (`QueryListener.shouldRaiseEvent`). So `cfg` stayed null and the My Skin panel never filled in. | The listener now uses `{ includeMetadataChanges: true }` and skips `hasPendingWrites` echoes. The spec clears `mySkin` and the skin objects before it starts. |
| `crm-handoff-ui.spec.js:78` | "Notes jumped" 4.7 px; blocks 304→308 / 307→308 | **Web-font swap**, not the stage change. Measured on the rig: with Google Fonts blocked the two blocks are 299/310 px, with fonts 308/320. The CI "after" numbers are exactly the loaded-font heights. `document.fonts.ready` only waits for loads that have already started, and faces are requested lazily. | Before measuring, the spec calls `document.fonts.load()` for every font the open modal computes, then waits for `ready`, and asserts that nothing is still loading. |
| `call-center-view.spec.js:53` | `:236` card g "not found". Retries: "4 open" / "6 open" | **Test mock.** The `callCenterAction` mock answered in the browser only. Closing the Said-you'd-do deck reloads the list from Firestore, which brought back call a and the texts as unhandled. "File on" then correctly merged call g into the customer's person card, so there was no card g. The retries saw the previous attempt's seeded calls, because cleanup ran only at the end. | The mock writes the server's effect to the emulator before answering. The spec waits for the deck-close reload to settle before tapping. Leftovers are cleared at the start. |

`--repeat-each=10` found the same leftover-state class in two sibling tests of
`crm-handoff-ui.spec.js`, which CI's retries would also hit. `:133` saves three
ZZHS leads, and `:190` saves one ZZDS lead, with the same addresses and phones
on every attempt. From the second attempt on, the duplicate prompt stopped
`_saveLead`: `:133` hung for 9 of 10 repeats, and `:190` wrote 0 leads in 6 of
10. Both now delete their own leads before they start. The first full-shard
verification run hit the same pattern in `phone-no-next-step.spec.js:49`. Its
first attempt timed out waiting for admin-seeded leads to reach `_leads`
(cause not chased). Both retries then failed "oldest first", because the
first attempt's 2019-dated ZZNext lead was still at the top. It now clears
its own ZZNext leads first.

Still flaky and out of scope: `customer-jobs.spec.js:40` and `:143`. Both
throw `ALREADY_EXISTS` from a browser-side `_saveLead` seed, the emulator
commit-retry class that `call-center-view` avoided by seeding with the admin
SDK. Both passed on retry in every run.

## The helper that hid it

`tests/e2e/fixtures/auth.js` `safeWaitForFunction(page, fn, opts)` read only
three arguments. 31 call sites pass page.waitForFunction's order,
`(page, fn, null, { timeout })`, so their timeout was dropped and each wait ran
until the **test** timeout. A stuck boot therefore surfaced as a bare
"Test timeout of 150000ms exceeded" at the helper line. The helper now accepts
both call shapes. `kanban-visibility.spec.js`'s `(page, fn, opts, arg)` also
gets its argument now; it used to throw at once on `null.every`, and a
`.catch` swallowed the error.

## Proof

- `tests/boot-offline-reads-2026-10-04.test.js`: vm-loads both modules
  against a modelled SDK, plus the helper's call shapes. It fails 6 + 3
  assertions on origin/main's files.
- Real browser, rig with the Firestore watch channel aborted for the first
  seconds. origin/main: game mode saved ON reads `{"enabled":false}` and stays
  that way; My Skin `cfg` is still null after 45 s. This branch: `enabled:true`;
  `cfg` loads about 2 s after the channel comes back.

## Rig notes

Another session held the default emulator ports, so this run used private
ports: hosting 5150, auth 9189, firestore 8180, storage 9289. That needed a
temporary `firebase.deflake.json` and a temporary, uncommitted port patch to
`nbd-emulator-connect.js`. `functions/node_modules` was unlinked to match CI.
The baseline full shard2 on main passed locally (265 passed, 1 flaky,
`customer-jobs.spec.js:143`, unrelated). The CI-only failures needed the
induced offline boot to reproduce.
