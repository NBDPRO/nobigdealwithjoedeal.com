# NEXT_SESSION — 2026-10-02 (the 10-01 night into 10-02, Jo saying "keep building")

Follows [NEXT_SESSION-2026-10-01-part4](NEXT_SESSION-2026-10-01-part4.md).
Jo's asks this stretch:
- finish the Call Center follow-ups (texts, the 7.5 h cap, "it wasn't
  personal");
- "forget semrush always use console instead its free";
- a code-correct, real-looking **gable** roof diagram ("add all code items …
  most people would leave them out"), which became **3D**;
- then "keep building".

PRs #1981–#1993 are merged. #1994 (the Ask Joe grader) and #1995 (nav-drawer flake) had watchers running when this was written; check them first.

## §0 Read first

- **Kentucky claim wording now has three gates.** Run all of them, plus
  the whole manifest, before pushing anything that touches claim or prompt
  text:
  - `tests/claim-wording.test.js`: the public site, now with the
    walk-through rules;
  - `tests/ky-claims-wording-scan.test.js`: `docs/pro` + `functions`. It
    bans "claims specialist" **even inside a "never say" rule**, which is
    what failed #1991's first CI run;
  - §5 of claim-wording: Ask Joe's real prompts.

  Run `node scripts/run-test-manifest.js` (all 290 suites, ~100 s), not just
  the suite you edited.
- **The Ask Joe live eval works without a repo secret.** The key comes from
  Secret Manager:

  ```bash
  ANTHROPIC_API_KEY=$(gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY --project=nobigdeal-pro) node scripts/eval-ask-joe.mjs
  ```

  Add `--standalone` for `/pro/ask-joe`. Answers vary, so run at least two
  passes per surface. One run costs a few cents.
- **Local browser E2E without the Playwright download:** use a temporary,
  uncommitted `tests/pw-local-chrome.config.js` that sets
  `launchOptions.executablePath` to the installed Chrome
  (`C:/Program Files/Google/Chrome/Application/chrome.exe`) on the chromium
  project. Run it inside `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u
  http_proxy npx firebase emulators:exec --only
  auth,firestore,storage,hosting …`. WebKit still can't run locally.
- **Bash tool + backslashes:** heredocs and `node -e` strings lose them
  (`\b` became a literal backspace in a regex today). Write edit scripts
  with the Write tool, or use the Edit tool. The memory note covers it.
- Worktree removal: still only via the unlink-first PowerShell loop (§0 of
  part 4).

## §1 What shipped

**Call Center follow-ups:**
- the transcription cap is 7.5 h a day (#1981);
- "It wasn't personal" re-downloads the original from Drive and re-notes
  the call (#1982);
- text notes, with texted promises joining the twice-daily "you said you'd"
  sweep (#1983);
- calls on the Home "needs you" strip, using one shared 14-day rule
  (#1985);
- the Texts tab in `#/calls`, with Handled and a Home count (#1990);
- E2E flake fix: test customers are seeded with the admin SDK (#1989).
- **Texts stay dark until Jo sets up SMS Backup & Restore** (§2).

**Site:**
- **Weekly page-speed watch** (mobile Lighthouse, median of runs), and the
  /book layout shift fixed, CLS 0.118 → 0 (#1984,
  [PERF-WATCH-2026-10-02](../audit/PERF-WATCH-2026-10-02.md)).
- **Roof diagram (#1987,
  [ROOF-3D-DIAGRAM-2026-10-02](ROOF-3D-DIAGRAM-2026-10-02.md)):**
  - a generated static gable cutaway on /services/roof-replacement: 10
    items, 7 tagged CODE, plus kick-out flashing;
  - a tap-to-load Three.js 3D view (drag, pull the layers apart);
  - Spline has no API, so it's Three.js r186, trimmed and vendored at
    143 KB gz.
  - **Jo should confirm the CODE wording before it goes in ads.**
- Mobile menu restores the exact scroll position on close, which fixes the
  WebKit flake (#1988).
- **Search Console near-miss read**, and the GAF vs TAMKO post retitled
  (#1986,
  [SEARCH-CONSOLE-NEAR-MISS-2026-10-02](../marketing/SEARCH-CONSOLE-NEAR-MISS-2026-10-02.md)).
  Only one week of data so far; **re-read around 10-30.**

**Ask Joe (#1991, #1994,
[ASK-JOE-GROUND-RULES-2026-10-02](../audit/ASK-JOE-GROUND-RULES-2026-10-02.md)):**
- What was wrong:
  - the CRM Ask Joe had no Kentucky nothing-at-signing rule, no $100 rule
    and no deposit rule;
  - `/pro/ask-joe` advertised "adjuster negotiations";
  - the AI proxy silently cut system prompts at 4000 chars.
- The fix:
  - one shared `docs/pro/js/ask-joe-rules.js`, with the deposit line quoted
    from `deposit-rule.js`;
  - the proxy cap is now a named 12000.
- The live eval, 10 runs × 8 questions: **every answer was lawful.** Every
  early failure was the grader, and the grader is fixed.

**Claim wording, round 2 (#1993,
[CLAIM-WORDING-WALKTHROUGH-2026-10-02](../audit/CLAIM-WORDING-WALKTHROUGH-2026-10-02.md)):**
- The **homepage FAQ** said "You focus on your deductible; we handle the
  rest".
- 8 pages said "walk you through the claim process", plus "I … can request
  a re-inspection", "I stay involved through adjuster visits" and "knows
  the insurance side".
- All are reworded, and 6 new gate rules are each proven red on their live
  sentence.

**Schedule:** the Plan Jobs panel now shows the Google double-booking warning
per row (#1992). It warns and never blocks, and a slow, older answer can't
overwrite a newer one.

## §2 Jo's open items

- **Thursday 0.7.0 is on STAGING, waiting on Jo's test.** Jo said "yes stage
  it".
  - The change replaces "…can walk them through the claim" (the phrase #1993
    removed from the site) with: documents the damage, writes the estimate,
    meets the adjuster after they file; the claim stays theirs.
  - Production is still 0.6.2.
  - Once Jo says it sounds right:
    `node scripts/thursday-agent-lookup.js --promote --yes`.
  - Details: [THURSDAY-BLAND §13](../architecture/THURSDAY-BLAND-2026-09-26.md).
- **Texts:**
  1. Set up SMS Backup & Restore.
  2. Share the SMSBackupRestore folder with the service account (Viewer).
  3. Then flip `TEXT_INBOX_ENABLED`, and later `TEXT_NOTES_ENABLED`.
- **Sort my customers:** the banner on the board.
- **Gary's customer page:** tick the stale Jul 14 task.
- **Clarity:** the project ID.
- **Roof diagram:** confirm the CODE wording before ads.
- Citations (from part 3).

## §2b Later the same session (after this note first merged)

- #1994 and #1995 merged.
  - **#1995 caught a real trap:** without `PLAYWRIGHT_BASE_URL`, a local
    Playwright run tests the **live site**. See the authed-e2e memory note.
  - After it merged, the nav-drawer test passed on #1997, #1998 and #1999.
- **Customer page primitives, batches 4–6** (#1997, #1998, #1999):
  - `customer.html` went from 315 to 207 inline styles. The new classes are
    `.ui-tile-icon`/`-title`/`-sub`, `.ui-label`, `.ui-page`,
    `.ui-btn-sm`, `.ui-ico-14`/`-13`, `.ui-note`, `.ui-count`,
    `.ui-modal-title`, `.ui-sec-title`, `.ui-choice`, `.ui-pill` and
    `.ui-label-plain`.
  - Each batch shows zero computed-style diff on all 758 elements at
    1280/390 px, plus a positive control.
  - **The proof tool isn't committed.** Recipe: serve the docs tree,
    Playwright with JS off, expand every `<template>`, and dump
    `getComputedStyle` for every element. Run it twice on the same tree to
    show 0 differences before trusting a zero.
  - The rest of `customer.html` is one-off layout a skin doesn't need.
    Three estimate-header buttons sit under `!important` rules
    (`.est-head-actions > .btn`, `nbd-mobile.css`).
- **The claim-wording deploy was verified live:** the homepage and the
  Batavia, Mason and Miamisburg pages carry none of the old phrases and
  include the new ones.
- **The roof 3D view was verified live** in real Chrome at 390 and 1280 px:
  the canvas draws and there are no console errors.
- **Thursday 0.7.0 is still on staging,** waiting on Jo's test.

## §3 Next lanes

- **Schedule: draw Google's busy blocks on the Schedule view** (calendar hub
  Phase 3's last piece).
  - It only shows anything once Jo's main calendar is shared free/busy
    with the service account. Check `getGoogleCalendarStatus.primaryShared`
    first.
  - The Today timeline (`smart-calendar.js`) is the natural home: untitled
    busy blocks that don't overlap an appointment.
- **Optional: run the Ask Joe eval weekly.** A scheduled workflow would
  need the key as a repo secret (Jo's call). Otherwise run it by hand after
  any change to the rules, the prompt or the model.
- **Reskin, next pool: the JS-rendered screens.**
  - `docs/pro/js` holds 4,139 inline styles in 145 files. The biggest are
    `vault-page.js` (208), `expenses.js` (143), `invoice-pipeline.js`
    and `widgets.js` (140 each), `product-library.js` (137) and
    `storm-center.js` (111).
  - These need an **in-context** proof: render the screen with seeded data
    on the emulator, then compare computed styles before and after. The
    static JS-off page doesn't contain them.
- **Search Console re-read around 2026-10-30:** the Mason cluster and the
  shingle-comparison near-misses.
- **Nav-drawer WebKit flake (#1995):**
  - It failed on #1993 and #1994 (1200 / 1200 / 9 / 40 px off) and passed on
    re-run.
  - **Test-side cause found:** the spec's own `scrollTo(0, 1200)` glides
    under `html{scroll-behavior:smooth}`. #1995 jumps instantly, waits for
    the page to settle, and prints `nbd-nav.js`'s opt-in trace on any
    miss. If it still fails, read the trace in the failure message.
  - **Local E2E gotcha:** set `PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000`
    OUTSIDE `emulators:exec` (cmd.exe can't take an inline env prefix).
    Without it the config's default runs the specs against the LIVE site.
