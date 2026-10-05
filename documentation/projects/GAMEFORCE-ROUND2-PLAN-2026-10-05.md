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

## Appendix: small and niche GameForce perks (deep dive, 2026-10-05)

Jo: "I want even more of its small and niche abilities and perks." This covers every
public page: home (including the collapsed panels and the hidden "full list"),
pricing with the full plan comparison and FAQ, developers, the affiliate program,
SMS opt-in, and the weekly webinar page. **The app itself is behind a login.** We
can't create an account, and the trial needs a card. If Jo starts the 7-day trial
and shares screenshots, a third pass can go deeper.

Ranked by value to NBD. None of these is approved to build yet.

| # | GameForce perk | What we have | Why it's worth it |
|---|---|---|---|
| 1 | **Number health**: "keeps phone numbers healthy", spam monitoring, warm-up mode | Nothing | 0 of 23 texts delivered for 45 days and nothing noticed. A delivery-rate monitor ("texts delivered this week: 0%" goes red) would have caught it on day 2. |
| 2 | **Bulk-send safety preview**: "14 found · 2 skipped: no consent · 1 skipped: DNC · Send 11? Needs your OK". Afterwards it reports who was skipped; a cancel says "Dismissed. Nothing was done." | Ask Joe confirms single texts (#2019) | Needed before AI texting goes live after A2P; the right shape for TCPA. |
| 3 | **Auto-takeover after 10 minutes**: if no rep answers a new lead's text, the AI picks it up | AI texting (blocked on A2P) | Speed-to-lead wins roofing leads; a small rule on top of AI texting. |
| 4 | **"Watches"**: tell the agent "let me know when…" (e.g. a Mason lead opens a proposal) | Fixed alerts only | Ask Joe already acts; this makes alerts user-defined. |
| 5 | **Escalation flags**: an inbound "Can I talk to a manager?" becomes a "Wants a manager today" chip with Reply | Call/text matching and promise detection | One more intent tag on inbound texts and calls. |
| 6 | **Usage wallet**: every call, text, number and AI charge itemized, with spending limits on the agent | AI spend tracking (#2148) | Extends to Twilio and Bland. It's how NBD Pro tenants pay their usage fairly. |
| 7 | **Digital business card** per rep | Yard-sign QR (`/r`), booking links | A rep card page plus QR at the door. Cheap, good for D2D. |
| 8 | **Streak counter** ("12-day streak") and "#8 this week, #15 all time" | XP + ghost (`functions/game-logic.js`) | Fits the 10/3 "compete with yourself" rule. Trivial on the game card. |
| 9 | **"Moves leads, with undo"** | Unknown, check first | An undo toast on bulk moves and stage changes. |
| 10 | **Themed loading screens** ("📞 Polishing the leaderboard", "🏠 Warming up the phones") | Generic spinners | Pure polish, about an hour, makes the app feel alive. |
| 11 | **Client affiliate**: customers earn 20% of referrals' bills for life, credited to their own bill (outside affiliates: 10% for 12 months, paid on cash collected) | $200 homeowner referral code | A growth engine for NBD Pro, separate from homeowner referrals. |
| 12 | **Post-job customer surveys** (in their app list) | Review asks | Fine as a separate feedback step. Never use it to decide who gets a review ask (that's against Google's review policy). |

**Also seen, lower priority:**
- "Count my squad" seat helper.
- A clear definition of a seat: everyone who logs in, including office staff and field techs.
- Plan unlocks by team size: logo at 10, white label, domain and login styling at 30, plus the customer portal, recruiting and dispatch.
- A free weekly live walkthrough with a countdown in the visitor's own time zone.
- Consent copy that names "automated and AI calls and texts".
- "Sample data" labels on every demo screen.

**Skip:**
- Dialer extras (40 lines, voicemail drops, hold message, listen/whisper/barge).
- Skip tracing (paid data per lookup).
- Loot boxes, pets, raids and Sales City.
- Their own funnel and webinar builder (the site and Cal.com cover it).
- Recruiting / Checkr (until NBD hires).
- "Apps Atlas builds".
