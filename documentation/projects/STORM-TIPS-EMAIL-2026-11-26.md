# Storm-season tips email (2026-11-26) — built dark

Item 9 of the 2026-11-26 follow-up list. The guide "Email me a copy" box
([GUIDE-EMAIL-COPY-2026-11-26](GUIDE-EMAIL-COPY-2026-11-26.md), PR #3272) has an
optional box: "Also email me storm-season tips from Joe now and then.
Unsubscribe any time." Until this PR it only recorded consent. This builds the
email those people agreed to. **Nothing sends until Joe turns it on.**

## Update 2026-11-26: turned on

Joe said "turn it on" after #3283 merged. `STORM_TIPS_EMAIL_ENABLED=true` is now in
`functions/.env.nobigdeal-pro` and the flag is no longer marked dark. That alone sends
nothing: an email goes out only when Joe presses Send on `/pro/storm-tips`, and the
schedule still needs `messaging_controls/automations.stormTipsEmail`. Customer sends +
email, canary and the postal address still gate every send.

## Joe's decisions (2026-11-26)

- **Trigger:** first contact is **Joe pressing send**. After that he can put
  people on an **optional schedule** he controls from a screen.
- **Frequency:** **never more than one storm-tips email per person every 14
  days.** Joe can set a longer interval, never a shorter one.
- **ZIP:** the guide form gets an **optional ZIP** so a send can target people
  near a real storm.
- **Branching:** stacked on #3272 (it lands after that PR).

## How it works

| Piece | File |
|---|---|
| Who, which issue, the 14-day floor, seasons, storm distance, the email copy | `functions/storm-tips-logic.js` |
| Reads, gates, claims, sends; `stormTipsAdmin` callable + `stormTipsSweep` cron | `functions/storm-tips-email.js` |
| Owner screen | `/pro/storm-tips` (`docs/pro/storm-tips.html`, `docs/pro/js/pages/storm-tips.js`, `docs/pro/css/storm-tips.css`) |
| Optional ZIP on the guide form (cleaned to 5 digits or refused) | `scripts/add-guide-email-copy.js`, `docs/assets/js/guide-email-copy.js` (v=2), `functions/handlers/integrations.js` |
| Tests (unsubscribe honoured, kill switch, canary, 14-day floor, storm targeting, sweep) | `tests/storm-tips-email-2026-11-26.test.js` |

**Subscribers** are read from `guide_copy_requests` where `emailConsent ==
true` and `emailConsentVersion == 'guide-storm-tips-2026-11-26'`. Several
requests from one inbox are one person. Per-person state lives in
`storm_tips_state/{sha256(email)[:40]}` (no email in the id); settings in
`storm_tips_settings/global`; a send log in `storm_tips_sends`. All three are
server-only in `firestore.rules`.

**The screen** (`/pro/storm-tips`, NBD owner only, App Check):
- shows whether each switch is on, and test mode (canary);
- sends one issue to everyone it can go to, to people within 15 miles of a
  storm in the last 14 days (from `storm_events`, by ZIP), or to the people
  Joe ticks; preview first;
- sets the schedule interval (14 to 365 days);
- per person: put on / take off the schedule, stop all emails.

**Rules the server enforces** (not the screen):
- The first email anyone gets is always `first-hello`. The schedule never
  makes first contact.
- One email per person per 14 days, claimed in a transaction before the send,
  so two presses, or a press and the sweep, mail a person once.
- The same issue never twice. The schedule sends the next issue that person
  has not had **and that is in season** (by Eastern month); if none is in
  season it waits.
- At most 200 people per press, at most min(maxPerRun, 50) per scheduled run.
- Scheduled sends wait for the customer send window (8:00 to 20:00, the ZIP's
  zone, else Eastern).

## Gates (all must be on)

| Gate | Manual send | Schedule |
|---|---|---|
| env `STORM_TIPS_EMAIL_ENABLED=true` (`cron-gates.js`) | yes | yes |
| `messaging_controls/global` customer sends + email | yes | yes |
| `messaging_controls/automations.stormTipsEmail` | no | yes |
| Company Profile mailing address (CAN-SPAM) | yes | yes |

Canary (test mode) sends each email to Joe's owner email instead, and it is
**not** counted as sent, so the homeowner still gets it later.

**Commercial email (CAN-SPAM):** every send goes through
`email-suppression.js` `gateCommercialEmail`: an unsubscribed address is
skipped and marked `unsubscribed`; every email carries the unsubscribe link,
`List-Unsubscribe` + one-click headers, and the postal address; no postal
address means nothing is sent. Registered in `SEND_PATHS` as `commercial`.
From `Joe Deal <jd@…>`, reply-to jd@.

## The drafted emails (for Joe's approval)

Five issues in `storm-tips-logic.js` `ISSUES`, in Joe's voice, each with a
"Book a free inspection" button and his phone number:

| id | When the schedule may use it | Subject |
|---|---|---|
| `first-hello` | any month (always the first) | Storm tips from Joe: what I'd check first |
| `spring-hail-prep` | Feb to May | Hail season is close: 10 minutes now saves a headache later |
| `after-a-storm` | Mar to Sep | After a storm: the first 48 hours |
| `fall-gutters` | Sep to Nov | Before winter: gutters, flashing and a quick look up |
| `winter-ice` | Dec to Feb | Icicles, ice dams and what they're telling you |

Copy rules kept: no insurance-outcome promises, never "we handle the claim"
(Kentucky), "whether to file a claim is your call", no "licensed", no
invented numbers, links only to this site's guides. The outbound template
scan covers both files.

## Turning it on (Joe)

1. Approve or edit the five emails (in `storm-tips-logic.js`).
2. Set `STORM_TIPS_EMAIL_ENABLED=true` on the functions and deploy.
3. With canary on, press Send on `first-hello` to see it in your own inbox.
4. Canary off, press Send for real.
5. Optional: put people on the schedule, then switch on
   `automations.stormTipsEmail` in the Messaging controls.

The kill switch is the same as every other customer email: customer sends or
email off stops it at once.

## Open questions for Joe

- **No double opt-in.** The guide form takes any typed email, so someone could
  tick the box for an address that isn't theirs. The first email you send says
  why they're getting it and has a one-click unsubscribe. CAN-SPAM does not
  require confirmed opt-in. A confirm-by-email step would be a separate small PR
  if you want it.
- ~~No dashboard link~~ Done (Joe, 2026-11-26): a **Storm tips email** button
  in the Messaging Center header, next to Twilio logs.
