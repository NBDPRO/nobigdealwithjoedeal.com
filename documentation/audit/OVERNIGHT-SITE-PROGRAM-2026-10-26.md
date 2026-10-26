# Overnight site program, 2026-10-26

Jo's standing ask: "keep working on the site overnight to fix bugs, improve UI and UX and more." This is what that
produced, so the next session does not re-find it.

## How it ran

1. **Discover (read-only, five lanes).** Marketing site, homeowner forms and funnels, the CRM sample account, performance,
   and copy consistency. Each lane drove a fresh Chromium against a fresh static server on a read-only worktree of `main`.
   46 findings.
2. **Verify.** A second agent per finding tried to refute it from scratch (own server, own browser, own measurement).
   45 held; the one that did not was dropped.
3. **Plan.** 23 findings were judged safe to fix without a decision from Jo. A planner grouped 22 of them into seven
   clusters by the files they touch, so no two PRs fight over a file, and deferred the last (perf-6).
4. **Fix, review, repair.** One branch per cluster, red-first guard test, then an independent reviewer who did not see the
   fixer's reasoning, then a repair pass for anything medium or above. Reviewers found real problems in three of the seven
   (a privacy-gate failure from `gmail.com` fixtures, a regression on `/pro/playbook`, a cache-key collision on
   `intake-extras.js?v=2`); those are fixed in the PRs.

## The seven fix PRs

| PR | Findings | What it does |
|---|---|---|
| #2746 | funnel-1, funnel-4, funnel-6, marketing-7, marketing-9 | The quick lead form on 185 service and area pages now shows its errors and confirmation on a phone (they sat 890 px above the Send button, so an empty submit looked dead); failures say what happened in plain words with the phone number instead of "Network error: Failed to fetch"; selects are 16 px so iPhone does not zoom; the storm-alerts and inspect confirmations take focus. |
| #2748 | crm-1, crm-3, crm-9 | The AI tool panes in the CRM dashboard no longer dead-end on a refused-to-connect frame; text on navy clears 4.5:1; Project Codex and Daily Success stop scrolling sideways on phones. |
| #2749 | marketing-1, copy-003, copy-007 | The two above-the-fold web fonts are preloaded on every public page (82 pages had a CLS of 0.10 to 0.29 from the font swap; the sample now measures 0); case-study meta descriptions stop ending mid-word; `/free-tools` stops promising printable versions that do not exist. |
| #2750 | funnel-2, funnel-7, funnel-8 | The estimate, storm-check and roof-score wizards show their validation errors, keep keyboard focus across steps, and make the default tiles operable. |
| #2751 | marketing-3, marketing-4, marketing-5 | Four blog posts' mid-post card is readable (navy on navy before); `/404` and `/search` get their footer styling; 14 posts, the blog index, a guide and `/sms-program` stop being clipped at 320 px. |
| #2752 | crm-2, crm-4, crm-7 | The sample account's This Week tiles populate on first visit; the Door-to-Door tabs fit a phone; the sample estimates use the real field shape so the Estimates band, Reports and the funnel agree. |
| #2753 | marketing-2, funnel-5 | Anchor jumps and keyboard focus stay clear of the sticky header and the mobile Book/Call/Text bar (115 of 356 Tab stops were hidden under the bar). |

Also from the same night: #2747, the one-line wait that closes the "one person fewer" evening flake in `call-center-view`.

## Needs Jo (22)

These are real, but each needs a decision, a visual call, or wording that is Jo's. None was changed.

**Copy and claims (insurance-adjacent wording is Jo's; nothing here was touched):**
copy-001 (banned "claimable" / "money recovered from your insurer" wording still in the claim tool, Roof Score and five storm
pages), copy-002 (supplement wording differs from the approved model on about 20 pages), copy-004 (blog dates disagree
between post, index and feed; seven posts dated 2025), copy-005 (inspection and adjuster-visit lengths contradict),
copy-006 (credential and endorsement claims versus the Credentials page), copy-008 (25+ / 43 / 45 cities), copy-009
(Free Roof Program: "drawing" versus "not a contest", "per person" versus "per household"), copy-010 (British spellings,
trailing-slash URLs).

**Visual or product calls:**
marketing-6 (brand orange `#BD5728` text on navy is 2.8 to 3.4:1 on about 45 pages; `#DD875F` fixes it but changes the
colour of headings and stat numbers), marketing-10 (`/services/gaf-timberline` fires 48 failing photo probes per view; the
fix changes the photo drop-in workflow), funnel-10 (the result waits on a cosmetic AI note for up to 30 s; test-pinned).

**Engineering with a design choice inside (candidates for the next pass):**
funnel-3 (`/storm-report` says "No major storm reports" when the lookup failed, and the server caches the empty result
for 24 hours), funnel-9 (homepage and `/inspect` show one generic validation line far below the field), crm-5 (nine of
fourteen overlays ignore Escape and do not take focus), crm-6 (two sample Dashboard panels stuck on "Loading…" because
their scripts match `/pro/dashboard` and the sample serves `/pro/explore/dashboard`; Call Center opens with two failure
banners), crm-8 ("Active Leads" counts won and lost jobs; the Pipeline, Leaderboard and Ask Joe disagree with it),
crm-10 (36 by 14 Share pill, 36 px icon buttons, unnamed checkboxes), perf-1 (CRM Home reflows three to six times at
boot, CLS 0.9 to 1.4 on a phone), perf-2 (`/pro` boots the Firebase auth stack for anonymous visitors; the proposed fix
breaks the signed-in redirect for the default session-only login), perf-3 (`/review` pulls a 69 KB latin-ext font for one
"ș"), perf-4 (per-row `Intl.DateTimeFormat` on CRM boot), perf-5 (duplicate stylesheet links with two `?v=` values).

**Deferred:** perf-6 (Dancing Script subset), because it edits `nbd-fonts.css` and needs a side-by-side render of the
signature text.

## Found while fixing, not in any finding

- Seven blog posts carry a second inline `<style>` block with a stale `.callout a` rule that paints inline links inside a
  callout as orange pills with orange text (1:1), so the link text is invisible. Posts: hail-season-prep-checklist,
  why-i-install-lumanail-on-every-elite-roof, why-roofivent-is-on-my-roofs, the-pipe-boot-fork,
  gaf-vs-owens-corning-vs-atlas-shingles, how-long-does-roof-replacement-take-cincinnati,
  how-to-choose-a-roofer-after-a-storm. Higher impact than the contrast finding; not fixed yet.
- `/storm-alerts` and `/inspect`: on an empty submit the error box lands 950 to 1250 px below the focused field.
- Reports `_delta(cur, prev)` returns +100% whenever the previous period is zero, so the sample shows "$20k up +100%".
- The Reports funnel counts leads created in the window, the Estimates band counts estimates: 89% close rate beside 25%
  on the same sample, by design, until the sample has estimates for the other seven won leads.
- CI: `Pro demo zero-network walk` (20 min cap) and `Public-surface E2E (mobile WebKit)` (15 min cap) were each
  cancelled on their cap once tonight (the first took 9 to 17 minutes on other runs, the second about 1.5); reruns were
  requested. Watch for a creeping runtime.

## Method notes

The discovery, verification and review agents ran with read-only worktrees and measured instead of guessing: layout shift
with a `PerformanceObserver`, contrast by compositing ancestor backgrounds, Tab order by walking focus. The fixers wrote
their guard test first and proved it fails on `main`. Reviewers were given the diff, not the fixer's reasoning.

## Update, later 2026-10-26: what moved after the first write-up

Merged or queued since (each with a red-first guard test; the PR body has the detail):

| PR | Finding | State when written |
|---|---|---|
| #2756 | crm-5 (dialogs ignore Escape / focus), crm-10 | merged |
| #2758 | funnel-3 (`/storm-report` false "no storms", 24 h poisoned cache) | queued with auto-merge |
| #2762 | the invisible blog callout links (found while fixing) | queued with auto-merge |
| #2763 | perf-5 (six duplicate stylesheet links on the CRM pages); retires the R1-10-1 / R1-10-2 pins in `merge-leftovers-guard` | queued |
| #2764 | funnel-9, `/inspect` half (validation message under the first bad field) | queued |
| #2765 | crm-8 (Active Leads counts open deals only) | queued |
| #2766 | marketing-6 (light orange `#DD875F` for stat numbers and headings on navy; 81 elements measured, all at least 4.5:1) | queued |

Jo's calls on 2026-10-26: Active Leads = open deals only; brand orange text on navy becomes `#DD875F` (orange on light backgrounds stays `#BD5728`); the 69 KB latin-ext font on `/review` stays (perf-3, one "ș" in a reviewer's name).

Still open, still Jo's: the copy and insurance-wording findings (copy-001 to copy-010), marketing-10 (GAF Timberline photo probes), funnel-10 (30 s AI note wait), crm-6 (held in #2755), crm-7 follow-ups, perf-1, perf-2, perf-4, perf-6. The homepage form's error line already sits above its button, so the homepage half of funnel-9 needs no change.

Lessons worth keeping: a hand-written regex test can pin the exact form of a rule (`orange-text-on-navy` pinned `var(--orange-light)`), so a fallback form needs its pin widened; and a KNOWN BUG pin must be removed in the PR that fixes the bug.
