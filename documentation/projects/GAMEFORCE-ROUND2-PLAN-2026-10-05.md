# GameForce round 2: plan (2026-10-05)

Jo asked for a second look at gameforce.ai ("anything else you'd take from it we
don't have yet"), then for items 1–4 of the shortlist written up as a plan. Nothing
here is built yet. Each item needs Jo's go before work starts (standing rule a).

**Round 1 (2026-10-02) already shipped three GameForce ideas.** Don't rebuild them:

- #2019: Ask Joe can act (look up, schedule, text after a confirm card).
  `docs/pro/js/ask-joe-actions.js`, `functions/ask-joe-tools.js`.
- #2021: Storm Watch layer on the D2D map. `docs/pro/js/d2d-storm-layer.js`.
- #2017: proposal views, with open count, read time and a heads-up when opened.
  `functions/deal-view-logic.js`, `tests/deal-room-views-2026-10-02.test.js`.

That makes round-2 item 2 ("proposal read time") **already done**. It's recorded
below so nobody re-plans it.

## 1. A "Needs attention" manager card

**What GameForce shows:** one card for the manager. Overdue follow-ups per rep,
new leads with no owner, and an appointment a rep can't make ("reassign the
Johnson booking to Sam, Friday 3 PM").

**What we have:** `today-home.js` / `today-plan.js` (#2137) is *one person's* list,
with one follow-up rule (`followUpDue`). The Team tab (`dashboard-team-tab.js`)
manages members, not work. Nothing shows a manager the team's loose ends.

**Plan:**
- A Home card, shown only to owner / company_admin / manager, with three rows:
  1. **Overdue follow-ups by rep**, counted with the *same* `followUpDue` rule
     Today uses (one rule, never a second copy).
  2. **New leads with no owner**: leads in the company with no assigned rep.
     Web-form intake leads are the usual case.
  3. **Appointment conflicts**: an appointment whose rep has marked themselves
     unavailable, or two at the same time for one rep.
- Each row deep-links to a filtered list with a one-tap **Assign** (a picker of
  company members).
- Data: reps may not read each other's leads, so the counts come from a
  **server callable** (`getTeamAttention`). It is tenant-scoped by `companyId`,
  role-checked, and returns counts plus ids, never other reps' lead details to a
  rep. Add it to `viewer-callables` as manager-only.
- Tests: a pure `team-attention-logic.js` (counting, grouping, conflict
  detection), unit-tested. A rules test that a rep can't call it. An E2E check
  at 390x844 that the card hides for a rep.

**Open questions for Jo:** Is "manager" the right minimum role? Should
unavailability come from the calendar hub (Google Calendar) or a simple
"can't make it" button on the appointment?

## 2. Proposal read time (done in round 1)

Shipped as #2017. Optional follow-on: show "opened 3×, 12 min" on the manager
card's rows and on the Today list, reusing `deal-view-logic.js` (no new tracking).

## 3. Rep pace alerts

**What GameForce shows:** "Sam O. is under 20 dials by noon."

**What we have:** nothing like it (no daily targets, no midday check).

**Plan:**
- Settings → Team: an optional daily target per rep or role (knocks, calls,
  appointments set), off by default, plus a checkpoint time (default noon ET).
- A scheduled function (one `onSchedule`, added to the cron heartbeat plan and
  `cron-gates.js` like every other cron) compares the day's count so far against
  the target. It sends **one bell notification per rep per day** to the manager,
  and never to the rep's customers.
- Counts read existing records (knocks, `phone_calls`, appointments). No new
  tracking, the same principle as the game layer.
- Depends on item 1's role model; ship after it.

**Open questions for Jo:** Which metric matters for roofing (knocks? appointments
set)? Should the rep see their own pace too (a gentle "12 of 20 knocks")?

## 4. Team rivalry on top of XP (needs Jo's decision first)

**What GameForce shows:** a live weekly leaderboard that reshuffles, one-on-one
duels ("most appointments by Friday"), plus loot boxes, pets and a virtual
"Sales City".

**What we have:**
- `functions/game-logic.js` (#2094): XP only from real work, capped per day, and
  **"competition is with yourself: this week vs last week (your ghost)."** That
  was Jo's deliberate call on 2026-10-03 ("I just don't know how far to take it
  before we distract or overwhelm users").
- `docs/pro/leaderboard.html` + `pages/leaderboard.js`: one person's own stats
  (leads, knocks, invoices for `userId == uid`). It isn't a team board.

**Plan, if Jo opts in:**
- A **company setting, off by default**: "Team board". When on, a weekly board
  ranks the company's reps by the same `game-logic.js` XP (nothing new to farm),
  live via a server-derived snapshot, never client-written scores.
- **Duels, opt-in per rep:** two reps, one metric (e.g. appointments set), a
  deadline, and a result card. No stakes, no money.
- **Skip:** loot boxes (a bad look in a contractor tool), pets and Sales City.
- Tests: ranking ties, the per-day caps carrying into the board, the setting
  off by default, and tenant isolation (a board never shows another company's
  reps).

**Decision needed from Jo:** does a team board (even opt-in) fit the 10/3
"compete with yourself" rule, or stay with the ghost?

## Order and sizing

1 → 3 → 4. Item 1 is the foundation (role model + team callable). Item 3 reuses
it. Item 4 waits on Jo's decision. Roughly one PR each, every one with pure-logic
tests, a rules/tenant test, and a 390x844 E2E.

Not in this plan, but noted: a real **Do Not Call check** before AI texting
goes live (today the code only mentions DNC; quiet hours are enforced for storm
SMS in #2114). That belongs with the A2P launch work.
