# L05 Triage Inbox — build log, 2026-10-12

Lane "inbox" of the CRM layouts track (D6). Spec: Grok's Drive doc "NBD CRM
custom layouts", section L05; foundation and shared kit are described in
[CRM-LAYOUTS-LANE-2026-10-11](CRM-LAYOUTS-LANE-2026-10-11.md) (read that first
for the registry, the engine and the kit). This note is the reference for what
the inbox is built from and the decisions inside it. Update it in place.

## What it is

Layout id `inbox`, every surface. `js/layouts/inbox.js` + `css/layouts/inbox.css`,
lazily loaded with the D1 kit; the only boot-path change is one registry row in
`layout-system.js`. Like Focus it is an overlay on Home (it hides when another
view is active, and Menu has a way out to the Classic pipeline / Call Center).

Three panes: folder rail | list | thread, with the customer's facts and quick
actions as a fourth column on desktop (under the thread below 1100 px; one pane
at a time on a phone, with a Back button). A second tab on the rail, **Pipeline**,
is the same layout grouped by stage, reusing the kit `LeadCard` row.

## Feeds (nothing new is stored; every one is an existing reader)

| Feed | Source | Reply-by (rule table `KINDS` in inbox.js) |
| --- | --- | --- |
| Texts, calls, missed calls, carrier | `phone_calls` + `phone_text_days` (own rows, 200 + 100 newest), through `NBDHomeAttention.groupNeeds` — the exact "needs you" rule and **people** grouping Home, Call Center and callWatch use | text 2 h, call 4 h, missed 1 h, carrier 4 h; an urgent call is held to 30 min |
| New web leads | `window._leads` (already paged by `loadLeads`), stage `new`, created in the last 7 days, not snoozed | 30 min from creation |
| Opened estimates / quiet estimates | `NBDEstimateFollowups.computeFollowups` | 24 h from the open; quiet ones are due at their d2 / d5 / d10 mark |
| Nudges | `NBDToday.compute()`: promised / overdue tasks, stalled follow-ups | due date |
| Drafts | `leads/*/ai_drafts` (collection group, own `userId`, 50 newest, pending only) and the Agent inbox's pending `draft_text` / `draft_email` (owner / company_admin only) | 2 h / 24 h |

One row per **person** (`lead:<id>` or `num:<last 10 digits>`): a customer who
called twice, texted and is also a new lead is one row with several reasons;
the row shows the earliest reply-by. Timer chip: green while there is time,
gold once half the window is gone, red when it has passed (`--green` /
`--gold` / `--red`).

**Carrier replies.** There is no inbound-email feed in the CRM (verified: no
function parses inbound mail). "Carrier" is therefore calls and text days whose
bucket is `insurance` (the call ingest already classifies them). If a real
inbound-mail source is ever added, it joins `buildItems` as one more reason kind.

## Reply: draft-only, one send path

The composer is prefilled by rule (`suggestFor`: plain, no claim / coverage /
price / outcome words; CI runs every suggestion and every UI string through
`claim-wording-filter.js`), or by the pending AI draft's text. **Nothing is sent
by typing, by a suggestion or by a key.** Send calls
`NBDPhoneShare.share({ preferSms: true, source: 'triage_inbox' })`: the server's
`phoneTextAction 'check'` first (STOP register, Do Not Text, consent, texting
switch, quiet hours in the homeowner's time), then the phone's / computer's own
Messages with the words written; the rep presses Send there and confirms "did it
go out", which logs one `sms_log` row. A refused or unreachable check opens
nothing. After a confirmed send the AI draft is set `dismissed` (the same
write the customer-page panel makes on Dismiss). Agent-inbox drafts do not get
a second path: their button is "Review in Agent inbox", which has its own sent
flow.

The facts bar deliberately omits the kit's plain `sms:` Text action (it would
skip the check); the composer is the text path.

## Keys

J / K move, R focus the composer, E done, S snooze, Esc back / leave the
composer. Ignored while typing in an input / textarea / select / contenteditable,
with a modifier, or while a dialog (`#nbd-snooze-overlay`, `[aria-modal]`) is
open. The legend is always on screen (hidden only below 768 px, where there is
no keyboard).

**Done (E)** is honest about what it wrote: calls and text days go through
`callCenterAction 'handled'` (one Handled per person clears all of that
person's open calls at once), promised tasks through `NBDTasks.setDone`. A row
with neither is only set aside on this device until tomorrow, and the toast says
the CRM record was not changed. **Snooze (S)** is `LeadSnooze.prompt`; a number
with no customer on file says to attach it in the Call Center (texts cannot be
snoozed server-side: `callCenterAction` allows only Handled for them).

## Honest failure states

Each feed keeps its own `state` / `err`. Any failed feed raises a banner naming
it with Try again; the "Nothing needs a reply" empty state is reachable only when
every feed answered. A missing shared needs-you rule is an error, not an empty
list (it would otherwise drop every call silently). A failed thread read says so
and retries. Reads are bounded: 200 / 100 / 50 / 30 rows.

## Surfaces

Solid in every theme (glass declared off in the registry). The wallpaper shows
only in the folder rail, behind `.my-skin-wallpaper`; the CSS test fails if any
other rule gets a `backdrop-filter`.

## Verification

- `tests/layout-inbox-2026-10-12.test.js` (75 checks; break-tested: person key
  per event, typing guard removed, a direct send, an unbounded query, glass on
  the list, a claim word in a suggestion, the empty state shown on failure, the
  `sms:` Text action in the facts bar, the gold timer state — each reddened the
  assertion that names it).
- `tests/e2e/inbox-layout.spec.js` (@shard2): desktop 1280 on `daylight` and
  iPhone 390 on `midnight`; keys never fire while typing; Send refused when the
  server check cannot answer; banner + retry on a missing rule.

## Not built, and why

- A true multi-select or bulk Done: the one-per-person Done covers the stated
  rule; bulk would hide how many people were touched.
- Inline AI "rewrite" in the composer: nothing generated here (rule table only),
  so there is no model call to gate.
- Voicemail audio: the call rows carry AI notes, not a playable file; the Call
  Center's `getBlob` player stays the place to listen.
