# NEXT_SESSION - 2026-10-24: the 10-22/23 build days, live; two PRs waiting

**Session of 2026-10-24 (pick-up and follow-up).** Continues
[NEXT_SESSION-2026-10-21](NEXT_SESSION-2026-10-21.md) (its Needs Jo list still stands except where
marked below). Verified against `main` `ef666ca` and the Actions deploy list on 2026-10-24.

## Where things stand

- **Everything on `main` is live.** The `Firebase deploy` run for `ef666ca` (#2717) finished green;
  it covers every commit below. (Some per-commit runs show *cancelled*: superseded under
  `concurrency: firebase-deploy`, expected.)
- **Open PRs:**
  - [#2720](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2720) zod / chromium-bidi pin
    (HIGH npm advisory). All checks green except the non-required `@shard2` (cancelled at its cap).
    Ready to queue.
  - [#2719](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2719) progress photos
    owner-stamped (closes the purge residual from #2695). Blocked: the required Public-surface E2E was
    *cancelled* (the Playwright install wedge, see [ci-runner-minutes](../qa/ci-runner-minutes-2026-10-23.md)),
    and the branch is behind `main`. `main` merges in clean (only `tests/ci-manifest.json` auto-merges);
    its own suites pass after the merge (23/23, 28/28). Needs: update branch, re-run, queue.
  - [#2656](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2656) paint-color blog draft -
    stays a draft until Jo writes his lines.
- **This session could not push.** Every `git push` and the GitHub app's update-branch / auto-merge
  calls returned 403 ("Claude doesn't have GitHub access to NBDPRO/... for your organization").
  Reads worked. Fix: reconnect GitHub for the NBDPRO org (claude.ai connect-github) or reinstall the
  Claude GitHub App on the repo. Until then, #2719's update and both merges are by hand.

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

1. **GitHub access for this tool** (above) - or merge #2720 and #2719 by hand.
2. **Flip what's built and dark, if wanted** (Firebase console / env):
   - `leadSourceFixer`, `speedToLead`, `estimateFollowBoard`, then answer the "Where customers came from" cards.
   - `OWNER_WEEKLY_DIGEST_ENABLED=true` (owner digest into the Agent inbox). Also decide: owner only? And
     should company admins be able to read its revenue lines (rules 2622-2625)?
   - `roofWeatherChip`.
   - Texting automations stay off until he opens `messaging_controls/global`.
3. **Confirm claims**: James Hardie Alliance and American Operator memberships (home, /review, siding
   guide, about JSON-LD); IKO ROOFPRO Advantage held or not (the agent lists it as confirmed; the
   finished-job card does not).
4. **Real-iPhone pass**, one sitting: theme walk, photo sign-out, Call Center chips against known calls,
   Cal.com bell (one bell, nothing to the customer), [Draw daylight checklist](../qa/DRAW-DAYLIGHT-TEST-CHECKLIST-2026-10-22.md)
   (go-live = `CROSSHAIR_DEFAULT_ON = true`), VoiceOver checklist ([a11y audit](../qa/a11y-audit-2026-10-23.md)),
   measurements/photos (camera, HEIC), plus the 10-21 items (barcode, Download my data, coach).
5. **Contracts**: book the LegalShield attorney and the D1-D12 decisions
   ([status](CONTRACT-LANGUAGE-STATUS-2026-10-22.md)).
6. **Data he supplies**: Active Era export rows (weight import), Search Console export (SEO pass),
   GBP quota on case 8-9748000042165.
7. **CI policy** ([ci-runner-minutes](../qa/ci-runner-minutes-2026-10-23.md)): stop non-required jobs in the
   queue/push, docs-only fast path, the Public-surface Playwright wedge fix (it is a *required* job and
   just blocked #2719).
8. Still open from 10-21: Apple Health switch, review #2646/#2647, required-check ruleset for the shards.

## Next lanes (engineering, no Jo needed)

1. Land #2720, then #2719 (update branch first).
2. Public-surface E2E install wedge (apt cache or move webkit off the required job) - it blocks merges.
3. Purge follow-ups: `clearFirestoreCache()` on account switch needs a browser repro.
4. Pass-2 leftovers: storm callables rate limit, digest `deal_rooms` team undercount and `companies.limit(500)`,
   lead-source fixer `confirmedSourceAt` (unverified), `docs/free-tools/index.html` `.tool-cta` contrast.
5. Pass-1 leftovers: Pro demo iframed prod panes, coach overlay Escape/focus, food-input focus ring,
   typed measurement text wiped by `renderDash`, blob URLs not revoked.
6. `@shard2` specs (six named in the CI-minutes note).
7. Tracker layouts: Cockpit, then Quest/Arcade, then One Thing/Journal ([interfaces](DAILY-SUCCESS-INTERFACES-2026-10-22.md)).
