# NEXT_SESSION - 2026-10-24: the 10-22/23 build days, live; #2719/#2720 landed

**Session of 2026-10-24 (pick-up and follow-up).** Continues
[NEXT_SESSION-2026-10-21](NEXT_SESSION-2026-10-21.md) (its Needs Jo list still stands except where
marked below). Verified against `main` `ef666ca` and the Actions deploy list on 2026-10-24.

## Where things stand

- **Everything on `main` is live.** The `Firebase deploy` run for `ef666ca` (#2717) finished green;
  it covers every commit below. (Some per-commit runs show *cancelled*: superseded under
  `concurrency: firebase-deploy`, expected.)
  #2719 and #2720 merged after that: check their `Firebase deploy` runs in Actions before calling them live.
- **Landed this session (merged 2026-10-24 through the queue):**
  - [#2720](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2720) zod / chromium-bidi pin
    (HIGH npm advisory GHSA-mrhx-c7xc-m3w5).
  - [#2719](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2719) progress photos
    owner-stamped (closes the purge residual from #2695), after a `main` merge and a fresh CI run (its
    Public-surface E2E had been *cancelled* by the Playwright install wedge, see
    [ci-runner-minutes](../qa/ci-runner-minutes-2026-10-23.md)).
  - The handoff PR (#2721) also carries **body-parser 2.4.0** in `functions/` (HIGH GHSA-27r3-jxmh-p828,
    published 10-22; it turned the Dependency audit red on every PR).
- **Still open:**
  - [#2656](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2656) paint-color blog draft -
    stays a draft until Jo writes his lines.
- **Later on 2026-10-24 (same session, after the handoff PR):**
  - Merged:
    - #2722: WebKit moved off the required Public-surface job.
    - #2723: audit pass-2 leftovers.
    - #2724: pass-1 UI fixes (measurement text, coach and inbox keyboard).
    - [#2725](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2725): AI Usage runs in the sample account.
  - **Open:** [#2726](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2726) is green.
    - Every remaining dashboard tool runs in `/pro/explore`: the Success Tracker on a sample week, and Decision Engine, Understand and Project Codex on canned sample answers with no model and no insurance topics.
    - It also fixes a production bug: every Project Codex Quick Action card threw on click.
    - **It waits on Jo's review of the sample-answer wording** (`docs/pro/demo-sdk/tools-canned.js`). Auto-merge is deliberately off.
    - Plan and decisions: the 2026-10-24 update in [PRO-DEMO-PHASE2 plan](PRO-DEMO-PHASE2-FULL-ACCOUNT-PLAN-2026-10-06.md).
  - **Next PR, after #2726:** the audit pass-1 leftovers. Status of each item is at the top of [OVERNIGHT-LANDING-AUDIT-2026-10-23](../audit/OVERNIGHT-LANDING-AUDIT-2026-10-23.md).
    - D2D map-vendor load race (production).
    - Phone greeting cut to "WELCOME B…" (production).
    - Story page tab order.
    - Desktop tap targets.
    - Strip over the Record visit bar.
  - **Reviews on every homeowner page** (Jo's ask, same day): the `reviews-strip` partial puts the newest Google reviews, each with its date, on the 229 pages that had none, plus the our-work pages from their template. Note: [REVIEWS-STRIP-2026-10-24](REVIEWS-STRIP-2026-10-24.md).
  - **The sweep PR, [#2727](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2727)** (draft while CI runs; Jo asked to ship it): audit pass-1 leftovers,
    a11y labels and 24 px floors, the text-contrast tokens, the reviews strip on every homeowner page (dates on every card,
    `/review` shows the whole synced set), and pass 5 of the sweep on the homeowner page families (brand orange on navy on 64
    footers and a dozen other spots, floors on nav and crumb links). Passes 1–5: [UI-SWEEP-2026-10-24](../audit/UI-SWEEP-2026-10-24.md).
    - **Held back for Jo:** `/pro/pricing` (FAQ 17 px, logo 22 px, headline 2.8:1) because its visual baselines must be
      CI-rendered and committed by a person from the `visual-regression-output` artifact (`ci.yml`, the bless step).
    - CI lessons from the PR: the `:where()` wrapper on floor rules; `build-projects.mjs` must list every partial it carries over;
      `ensure-nav-responsive-css.js` keeps a canonical body that must change with the stylesheet.
  - **Daily Success notebook** (Jo, 10-25, same PR): the tab row is Dash · Today · open page · Notebook (n) · +; every page files by month in a drawer. Note: [DAILY-SUCCESS-NOTEBOOK-2026-10-25](DAILY-SUCCESS-NOTEBOOK-2026-10-25.md).
  - **Roof Rep revamp** (Jo, 10-25, same PR): NBD look, phone play layout, game feel, objection duels, quest board, Storm Run, seasons, crew ranks and duels. The repo file is the source now. Update section in [ROOF-REP-GAME-2026-10-03](ROOF-REP-GAME-2026-10-03.md).
  - **Daily Success layouts, the whole lineup** (10-25, same PR): Cockpit, Quest, One Thing, Journal and Arcade are ready to pick; see the status line in [DAILY-SUCCESS-INTERFACES-2026-10-22](DAILY-SUCCESS-INTERFACES-2026-10-22.md).
  - **Characters (10-25, same PR):** a vector chibi renderer (`docs/pro/js/chibi.js`) draws every avatar on Roof Rep and the CRM game card: shaded, outlined, blinking, eight animated poses (walk, knock, talk, cheer, sad, wave, think, idle). Note: the later-10-25 update in [ROOF-REP-GAME-2026-10-03](ROOF-REP-GAME-2026-10-03.md). Guard: `tests/chibi-2026-10-25.test.js`. **Wave 2 (10-25, next PR):** jointed limbs, 220 ms pose cross-fades, hair and hat secondary motion, emotes, point / nod / shrug poses wired into the street and Storm Run (section "Wave 2" in the same note). **Wave 3 (10-25):** hammer / climb poses and animated crews in the build, nailing and ladder mini-games (section "Wave 3"). **Wave 4 (10-25):** curly / afro / bun hair and a tee / hoodie / polo top in every picker (section "Wave 4").
  - **Visual-consistency sweep (10-25, same PR, pass 6 in [UI-SWEEP-2026-10-24](../audit/UI-SWEEP-2026-10-24.md)):** the Product Library and every un-classed dashboard control read Barlow (they were the OS font); one Products title instead of three; a 44 px phone floor for every view's controls; the phone header reads "[NBD] PRO"; marketing nav CTA, primary button padding and radii aligned to the majority; the portal and estimate view each got their h1. Guard: `tests/dashboard-font-consistency-2026-10-25.test.js`.
  - **Later on 10-25, same PR:** Roof Rep plays side by side on desktop, its HUD is three across under 360 px and its chips / swatches / options are 44 px; Quest got its skill tree; the Home game card shows a work streak (server `streak()` in `functions/game-logic.js`, GameForce appendix #8); the layouts gate also renders each layout's dashboard.
  - **Claims:** Jo confirmed James Hardie and American Operator. **IKO is parked:** commit `9384d8c` (IKO in the job-closeout credentials) is not pushed. Jo needs IKO's written OK for public use and the member number.
- **GitHub access lapsed this session**: every push and GitHub-app write returned 403 ("Resource not
  accessible by integration") until Jo fixed the Claude GitHub App's install on the NBDPRO org
  (Configure -> repository access / pending permissions). A plain account reconnect did not fix it, and a
  session's credentials do not refresh mid-session.

## What shipped 10-22 -> 10-23 (merged, deployed)

| Area | PRs |
| --- | --- |
| Tracker: end-of-day review, Sunday review that proposes targets (Accept only), morning readiness check-in, per-exercise notes, Today's business tile | #2681, #2710, #2704, #2692, #2717 |
| Tracker fixes: all-theme sweep, accent-picker hardening, appearance picker contrast/44 px, sync pill + workout sync isolation, Apple Health card emulator connect, a11y pass | #2671, #2687, #2680, #2707, #2686, #2667 |
| Security: progress photos purged on sign-out/switch; shared-device purge fails closed; `companies.siteSlug` frozen against client writes | #2684, #2695, #2700 |
| Job-completion loop: finished-job card, warranty prompt (GAF + TAMKO only), review/referral-ask drafts (draft-only) | #2689, #2699, #2709 |
| Storm Center: near-customer callables, Outreach tab (approve-first drafts, nothing sends), radius + select-all, hardening (state cleared on account switch, 60-day cutoff at filing) | #2679, #2690, #2705, #2716 |
| Call Center: saved views, Missed -> Short calls, call-to-job loop on shared numbers | #2673, #2698, #2703 |
| Agent / digest: `lead_sources` confirmed source (restored by #2694 after a stale squash reverted it), Monday owner digest (dark), digest false-"none" fix, Frank-only `margin_review` | #2676, #2694, #2683, #2714, #2701 |
| Contrast: /book CTA, brand orange on navy | #2702, #2713 |
| Misc: messaging "sent" amber vs "delivered" green, pro demo sandbox fix, admin Site address column, capture deep link, Cal.com alert survives a Google outage | #2678, #2691, #2693, #2665, #2688 |
| CI: `@shard2`/`@shard3` on `pull_request` only; messaging-center random-id test fix | #2697, #2715 |
| Docs: overnight audits pass 1 + 2, purge note, recons (business queue, job loop, storm, field-to-estimate, wave3, product status, contracts, Grabber, GBP), CI minutes, A2P Verified | #2685, #2708, #2718, #2668, #2669, #2670, #2675, #2677, #2682, #2696, #2711, #2712 |

Notes for the details: [OVERNIGHT-LANDING-AUDIT-2026-10-23](../audit/OVERNIGHT-LANDING-AUDIT-2026-10-23.md),
[pass 2](../audit/OVERNIGHT-LANDING-AUDIT-PASS2-2026-10-23.md),
[PURGE-FAIL-CLOSED](../audit/PURGE-FAIL-CLOSED-2026-10-23.md),
[BUSINESS-QUEUE-RECON](BUSINESS-QUEUE-RECON-2026-10-22.md),
[JOB-COMPLETION-LOOP-HANDOFF](JOB-COMPLETION-LOOP-HANDOFF-2026-10-23.md),
[NBD-PRO-PRODUCT-STATUS](NBD-PRO-PRODUCT-STATUS-2026-10-22.md).

## Correction to the 10-14 / 10-21 lists

- **Twilio resubmit is done**: the A2P campaign went Verified 2026-10-19 (#2670). Verified is not
  "texting on": every send stays behind `messaging_controls/global` + per-automation flags.

## Needs Jo

0. **Visual decisions from the 10-25 sweep** (pass 6 of the sweep note): marketing cards are 12–14 px radius site-wide against DESIGN.md's "8 px and pills" (add a 14 px card token, or move ~40 card rules to 8 px); the nav CTA majority is 6 px against the rule's 8; the dashboard's 9 px labels against the 11 px phone rule; `/pro/register`'s Google button font and eye toggle, and `/pro/pricing`, both wait on a CI-rendered baseline bless (`visual-regression-output` from run 8275).
1. **Flip what's built and dark, if wanted** (Firebase console / env):
   - `leadSourceFixer`, `speedToLead`, `estimateFollowBoard`, then answer the "Where customers came from" cards.
   - `OWNER_WEEKLY_DIGEST_ENABLED=true` (owner digest into the Agent inbox). Also decide: owner only? And
     should company admins be able to read its revenue lines (rules 2622-2625)?
   - `roofWeatherChip`.
   - Texting automations stay off until he opens `messaging_controls/global`.
2. **Confirm claims**: James Hardie Alliance and American Operator memberships (home, /review, siding
   guide, about JSON-LD); IKO ROOFPRO Advantage held or not (the agent lists it as confirmed; the
   finished-job card does not).
3. **Real-iPhone pass**, one sitting: theme walk, photo sign-out, Call Center chips against known calls,
   Cal.com bell (one bell, nothing to the customer), [Draw daylight checklist](../qa/DRAW-DAYLIGHT-TEST-CHECKLIST-2026-10-22.md)
   (go-live = `CROSSHAIR_DEFAULT_ON = true`), VoiceOver checklist ([a11y audit](../qa/a11y-audit-2026-10-23.md)),
   measurements/photos (camera, HEIC), plus the 10-21 items (barcode, Download my data, coach).
4. **Contracts**: book the LegalShield attorney and the D1-D12 decisions
   ([status](CONTRACT-LANGUAGE-STATUS-2026-10-22.md)).
5. **Data he supplies**: Active Era export rows (weight import), Search Console export (SEO pass),
   GBP quota on case 8-9748000042165.
6. **CI policy** ([ci-runner-minutes](../qa/ci-runner-minutes-2026-10-23.md)): stop non-required jobs in the
   queue/push, docs-only fast path, the Public-surface Playwright wedge fix (it is a *required* job and
   blocked #2719).
7. Still open from 10-21: Apple Health switch, review #2646/#2647, required-check ruleset for the shards.

## Next lanes (engineering, no Jo needed)

1. ~~Public-surface E2E install wedge~~ - fixed the same day (Jo chose option (b)): WebKit moved off the required job into `Public-surface E2E (mobile WebKit)`, not required.
2. ~~Purge follow-ups~~ - browser repro built 2026-10-25: `tests/e2e/account-switch-purge.spec.js` (@audit) creates a
   second tenant with the admin SDK, signs A in, signs out the PLAIN way (`auth.signOut()`), signs B in through the
   login page and asserts A's `nbd_*` / `nav-` keys are gone and `nbd_last_uid` flips to B only after the purge
   (the pass-2 High path, closed by #2695). Passes on the emulators in 12 s.
3. ~~Pass-2 leftovers~~ - worked 2026-10-24: storm callables rate-limited, `/free-tools` CTA contrast fixed,
   `confirmedSourceAt` and the opt-out read checked (no change needed). Still open: the digest's `deal_rooms` team
   undercount and `companies.limit(500)` (deferred, see the [pass-2 update](../audit/OVERNIGHT-LANDING-AUDIT-PASS2-2026-10-23.md)).
4. ~~Pass-1 leftovers: Pro demo iframed prod panes, coach overlay Escape/focus, food-input focus ring,
   typed measurement text wiped by `renderDash`, blob URLs not revoked.~~ All five were closed by 10-25: the iframed
   panes and the food-input ring on 10-23 (#2725 / #2726, see the audit's top note), the other three in the 10-24
   session's pass-1 leftovers PR.
5. ~~`@shard2` specs~~ - reproduced 2026-10-25 on local emulators under CI conditions (`CI=1`, retries 2, the
   five specs the 10-20 log named: call-center-card, crew-calendar, inbox-layout, layouts, mission-control).
   **All five pass.** Two findings: (a) `layouts.spec.js` had drifted from the picker, which folds every
   non-featured layout under a closed "More layouts" group and repaints Settings (losing the Appearance tab) on a
   layout change - the spec now opens the panel and the group before each click on its test layout (`openPicker`),
   so it no longer burns 3 × 180 s per CI run; (b) mission-control's four "worker process exited" failures were the
   rig, not the product: a worktree whose `tests/node_modules` was a symlink with no `playwright` package. With a
   real install all four pass (9.9 min for the pair). What is left for the shard is its runtime against the
   25-min cap, not failures; the zero-network walk's AI Usage click miss (CI 2026-10-25, twice) now records what the
   parent dashboard has at the click point, so the next miss names the cover instead of the symptom.
   Also found on the way: #2727 committed `tests/node_modules` as a symlink into a scratch worktree (the
   `.gitignore` pattern `tests/node_modules/` only matches a directory). Untracked, and the pattern now also lists
   the bare name so a symlink can never be staged again.
6. ~~Tracker layouts~~ - the whole lineup shipped 10-25 (Cockpit, Quest, One Thing, Journal, Arcade) ([interfaces](DAILY-SUCCESS-INTERFACES-2026-10-22.md)).
