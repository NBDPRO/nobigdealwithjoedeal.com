# CRM intense QA sweep — 2026-09-27

One-session manual QA sweep of the Pro CRM (`docs/pro/`), run at Jo's request while a separate coding session was active elsewhere in the repo. Goal was breadth and logging, not fixing: tap/click/scroll/type/save/delete across several areas and both desktop and mobile viewports, catalog every anomaly, and leave the fix work for a dedicated remediation pass.

## Method

- Ran the full Firebase emulator suite (`auth`,`firestore`,`functions`,`storage`,`hosting`) rather than pointing at production, so destructive testing (creates/edits/deletes/estimate saves) couldn't touch real customer data.
- Seeded a throwaway tenant with `node scripts/seed-emulator.js` (5 users across every role, 5 leads, 3 estimates, 1 customer, 1 knock — see that script for exact shape and login credentials).
- Drove the app through the built-in browser (Claude Code's Browser pane), reading console/network output alongside screenshots rather than relying on visuals alone.
- Logged in as `company_admin` for most of the sweep, then explicitly cross-checked one finding (NEW-01) against the `viewer` role.
- Deliberately skipped the Calls / Thursday AI-receptionist area and viewer-callable-permission edges, since those were the live coding lane per the day's handoff and open PR #1780.

Session ran in three passes (all logged in the same file): the first covered Home/Pipeline/Estimates/Drawing/Prospects/roles/mobile; a second covered Photos/Templates/Products/Expenses/Money/Settings/Reports/customer-card deep tabs and traced one finding all the way to raw Firestore data; a third covered Job Templates/Sales Training/Real Deal Academy/Leaderboard/Storm Watch/Close Board/Rep OS/Talk Tank/Daily Success/Referrals/Ask Joe AI/the Growth-tier AI Tools/Maps & Pins.

## What's here

- [BUG-LOG.md](BUG-LOG.md) — 22 numbered findings (1 BLOCKER, 5 HIGH, 6 MEDIUM, 1 LOW–MEDIUM, 6 LOW, plus a few sub-findings, one content/compliance flag, and one confirmed non-bug methodology note) plus a "positive checks" section for things specifically tested and found working, so they aren't re-tested from scratch next time.
- **The single most important thing in the log**: five separate-looking findings (Home dashboard, Pipeline board/list, Money page, Reports funnel, Leaderboard/Analytics, Ask Joe's live-context banner) plus the Tara Boone customer detail page itself all mishandle leads whose stage is `"quoted"` or `"won"` — strong evidence this is **one shared root cause** (likely a stage-enumeration helper missing those two values), not six unrelated bugs. See the "Likely unifying root cause" sections near the top of BUG-LOG.md.
- **Second most important**: NEW-02's actual root cause was found in the third pass — a real JS `TypeError` (`Cannot read properties of undefined (reading 'exists')`) inside the subscription-check code, caught and silently defaulted to "Free plan." This isn't cosmetic — it also blocks Ask Joe's AI chat from working (confirmed live, NEW-19), so it's gating a real feature, not just a banner.
- **A content/compliance flag, not a code defect**: NEW-18 — a Sales Training scenario script contains language ("we handle the whole claims process for you") matching this repo's own documented Kentucky insurance-job compliance prohibition, and the training feedback never flags the legal issue, only tone.

## No cleanup needed

Everything created (test leads, a test knock, an unsaved estimate edit, a test expense, a temporarily-changed pricing setting) lived in the local emulator's throwaway `demo-co` tenant, not production. The one setting change made to probe NEW-15 (Better tier rate) was explicitly reverted back to $595 before the session ended. The emulator was stopped and nothing here persists.

## Suggested next step

A dedicated remediation session. Priority order:
1. The shared stage-handling root cause behind NEW-01/NEW-11/NEW-14/NEW-16 (and the Tara Boone customer-page mislabel, and the Leaderboard/Ask Joe sightings) — fixing the one shared helper likely resolves six+ findings at once.
2. **NEW-03** (BLOCKER — estimate total/squares corruption on old-schema-estimate reopen).
3. **NEW-02** (HIGH — now with a concrete root-cause lead: a real TypeError in the subscription-check code, not just a missing doc; also blocks Ask Joe AI per NEW-19).
4. **NEW-15** (HIGH — per-SQ tier pricing config appears to be dead/regressed; previously verified working in `qa/exhaustive-sweep`).
5. **NEW-18** (content/compliance — have whoever owns Sales Training content review the Pitch Perfector scripts against the Kentucky insurance-job rules before the next rep trains on them).
All come with concrete repro steps and root-cause hints in BUG-LOG.md.
