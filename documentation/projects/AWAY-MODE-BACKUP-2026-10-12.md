# Away Mode + Backup Person — design (2026-10-12)

*Build lane for Jo's "never forget anything" goal. Jo is a solo owner-operator on
roofs all day; he is the single point of failure. This note is the Stage 1 design
(docs-only). Stage 2 is the build. Sibling lanes: reliability (heartbeat,
ack-timeout, escalation ladder, delivery verification, digest —
the `NEVER-FORGET-RELIABILITY-AUDIT-2026-10-12` audit in documentation/audit, on its own branch until it merges), contact labels, promise capture. This slice is new files plus thin,
marked integration points; it does not edit callWatch, the escalation ladder or
push delivery.*

## 1. What it does

1. **Backup person.** One company setting: "if I have not acknowledged an item
   within X, notify Y." Y is a company member (resolved by their member row at
   every use) or, later, an external contact the owner enters with a consent
   note. A pure resolver decides who is told, now, and why.
2. **Away mode.** One switch with an optional end date/time. While on:
   reminders get stricter and route to the backup; Thursday gets an "owner is
   away until <date>" playbook; Today shows a status line ("Away until Thu —
   backup: Sam"); customer-facing wording is a **draft Jo approves once** and is
   never auto-sent.
3. **Auto hand-back.** When the window ends (or Jo taps "I'm back"), everything
   the backup touched that is still open goes back to Jo with a one-line note of
   what the backup did, as a "While you were away" row on Today that stays until
   Jo taps "Reviewed".

Out of scope here (owned elsewhere): the escalation ladder for Jo himself, push
delivery verification, promise capture, contact labels.

## 2. Data model

All three collections are top-level, keyed by `companyId` (the tenant key every
SMS path uses: `claims.companyId`, or a solo owner's own uid), and **written only
by the Admin SDK** (a callable or the scheduled tick). No client write path
exists, so a rep cannot name themselves backup, forge consent or approve wording.

| Doc | Holds | Who reads (rules) |
|---|---|---|
| `away_mode/{companyId}` | **Status only**: `away {on, startMs, untilMs, windowId}`, `backup {kind, name}`, `backupState` (`ok` / `unavailable` / `unreachable` / `none`), `playbookApproved`, `updatedAtMs`. No phone, no email, no customer data. | Any member of the company (a viewer too — it is a status line), the owner, platform admin |
| `away_private/{companyId}` | Config: `ackWindowMin`, `awayWindowMin`, `backup {memberEmail \| external{name, phone, email, consentNote, consentAtMs, consentBy}}`, `schedule.unavailable[]`, `playbook {draft, approved, approvedHash, approvedAtMs, approvedBy}` | **Nobody via rules** (`false`). Returned only by the `manageAway` callable to the owner / company_admin |
| `away_windows/{companyId}__{windowId}` | The ledger for one away window: `startMs`, `endMs`, `endedBy`, `status`, `items{key → {who, phone10, why, urgent, kind, atMs, notifiedCount, lastNotifiedMs, assignee, touches[]}}`, `handBack {atMs, openCount, closedByBackupCount}`, `reviewedAtMs` | Owner / company_admin of that company (it names customers and numbers), platform admin. Never the backup (see section 4) |

Item keys reuse callWatch's `callerKey` (`lead:<id>` / `num:<10 digits>`), so an
item is a **person**, matching Home, the Call Center and callWatch.

## 3. Rules (pure, in `functions/away-mode-logic.js`)

Inputs: `config`, `items[]` (open items "that need Jo", each with
`key, kind, who, why, urgent, atMs, ackedAtMs?, phone10?`), `now`, `notified`
(per-item `{count, lastAtMs}`), `backup` (the verified backup or `null`).

`resolveBackupNotifications(...)` returns `{ notify[], skipped[], digest }`.

1. **No verified backup → nothing is sent**, `skipped` carries `no_backup` /
   `backup_unavailable` so the status line can warn Jo. A backup whose member row
   is missing, `deactivated` or not yet claimed is *unavailable* (re-checked every
   tick; removing a member silently ends their backup role).
2. **Acknowledged or handled → skipped** (`acknowledged`). Ack comes from the
   reliability lane's signal (`ackedAtMs`: opened the card, handled, notification
   click); until that ships the only ack is "handled", which already removes the
   item from the needs list.
3. **Threshold** (minutes since the item arrived, or since the window started if
   later, so turning Away on does not instantly fire 30 stale items):
   - normal: `ackWindowMin` (default **120**); urgent items `min(ackWindowMin, 30)`
   - away on, or inside a `schedule.unavailable` window: urgent **0** (now),
     everything else `awayWindowMin` (default **30**)
4. **Quiet hours** (America/New_York, 21:00–08:00): non-urgent items are held and
   released at 08:00. Urgent items go through to a *member* (an in-app push to a
   staff phone, not a consumer text). An *external* contact is texted only inside
   the shared send window (`sms-send-window.js`), never urgent-overriding it.
5. **Repeat**: told once, then again after `repeatMin` (default 240) at most
   `maxRepeats` (2) times; then the item is `exhausted` and Jo's own digest is the
   only owner of it (no infinite re-pushing a backup at 3 a.m.).
6. **Grouping**: more than 3 due items become one digest per person like callWatch
   ("3 people need a call-back"), so one bad morning is one push, not nine.
7. **Delivery truth** (the audit's R2): the tick only stamps an item `notified`
   when the injected `deliver()` reports `sent > 0` (push) or the in-app bell was
   written for a backup with no push tokens. `sent: 0` is a *failed attempt*; after
   3 failed attempts the status doc goes `backupState: 'unreachable'` and Today
   shows "Backup could not be reached" so Jo knows he has no cover.

`awayWindowState(config, now)` → `inactive | active | expired`. An open-ended
away is capped at **21 days** (`MAX_AWAY_DAYS`) and then ends itself and hands
back, so a forgotten switch cannot silently reroute the business forever.

`handBack(window, openKeys)` → the rows for Today: every routed item the backup
touched (`touches.length > 0`) that is still in the open set is reassigned
(`assignee: 'owner'`) with a one-line note (`"Sam: called back, will come Tue"`,
140 chars). Items the backup closed stay listed as "closed by Sam — your call".

### What the backup can do, and what that changes

The backup records a touch: **I'm on it** / **Called** / **Couldn't reach** /
**Note** (140 chars). A touch is recorded **in the away ledger only**. It does
**not** mark the call handled, clear a task or write the lead. The CRM's source of
truth (callWatch, Home, Today) keeps counting the item until Jo handles it on
return. A well-meaning but wrong "done" can therefore never make an item vanish.

### Customer-facing wording (Thursday and texts)

- `playbook.draft` is generated server-side from a template (owner name, until
  date, the backup's *first name only if Jo ticks "name my backup"*) and edited by
  Jo. **Approval is one tap, bound to a hash of the exact text**; editing the text
  clears the approval. `thursdayAwayContext(config, now)` returns the text **only
  when** the window is active **and** the approved hash matches the current draft;
  otherwise `null`. The draft is never used.
- Auto-reply gate `autoReplyAllowed({channel, inbound, optedOut, lastReplyMs,
  windowId, now, homeownerTz})`: **inbound only**, once per number per window,
  never to an opted-out / STOP number, never outside the 08:00–21:00 homeowner
  window, never as the first contact (the person must have written or called
  first), and never for `sms` while texting is off or unregistered
  (`sms-texting-gate.js`). Nothing in this PR sends a text; the gate is the
  contract the future sender must pass through (Twilio is still on trial / A2P
  unregistered).
- No outcome promises, no claim-handling wording (Kentucky rules in
  `ky-insurance-law.js` apply): the template says Jo is away, takes their number,
  and will call back by a date. It never names who will call or when unless Jo
  typed it.

## 4. Security

**Who can set the backup / switch Away / approve wording.** The company **owner**
(uid == companyId, or `companies/{id}.ownerId`) and a **company_admin** of that
company. Never a manager, sales_rep, viewer or access-code member. Enforced
server-side in `manageAway` through the existing `requireTeamAdmin` (which also
refuses a disabled Auth account and a subordinate role without a companyId).

**Who can be the backup.** An **active, claimed** member of the same company
(`companies/{id}/members/{email}` with `status: 'active'` and a `uid`), not the
owner themselves, and not a `viewer` (Jo's decision B: viewers are read-only on
tenant data; giving one a customer's name and number would break it). Resolved by
member row on every tick, so deactivation/removal ends the role on the next run
without a client round trip.

**Tenant isolation.** Every read/write is keyed by the caller's *own* tenant key
derived from the token; `manageAway` never accepts a `companyId` argument. The
tick groups by the status doc's own `companyId`. Rules: `away_private` and
`away_windows` have no client read for non-owners; `away_mode` is
same-company-only (`request.auth.token.companyId == companyId`, or the owner's
uid).

**What the backup can see.** Nothing in Firestore directly: rules give the backup
no read on any of the three docs (`away_windows` is owner-only, and the backup is
a *member*, not the owner). They get a **packet** through the `manageAway`
`backupList` action, and only while (a) the window is active, (b) they are the
verified backup *right now*, (c) for items the tick already routed to them. A
packet row is exactly: first name + last initial, the 10-digit call-back number, a
one-line reason ("missed call", "promised a call-back", "urgent"), the age, and
the touches. **No address, no amounts, no notes, no estimate, no photos, no lead
link, no history.** The backup cannot open the lead, and their normal CRM role is
unchanged — Away Mode grants no new Firestore permission to anyone.

**External backup** (deferred build, designed here so the data model does not
change): the owner enters name + phone/email and ticks a consent line ("this
person agreed to receive these notices"); the server stamps `consentAtMs` /
`consentBy`. An external contact is only ever *notified*; they get no CRM access
and no packet beyond the notification text (first name + reason + number). SMS to
them waits for A2P registration and the send window.

**Abuse cases covered by tests:** a rep forges `setAway` (refused); a rep names
themselves backup (refused); backup of company A reads company B's packet
(isolated by tenant key); a deactivated backup keeps getting packets (re-verified,
stops); an unapproved or edited draft reaches Thursday (hash mismatch → `null`);
an expired window keeps routing (state machine ends it); an auto-reply to a STOP
number (gate refuses); a viewer reading `away_windows` (rules).

## 5. UI states

**Today status line** (a `<div class="away-status">` above the greeting, rendered
by the new `away-mode.js`; one thin hook in `today-home.js`):

| State | Line |
|---|---|
| Off, backup set | nothing (quiet) |
| Off, no backup | nothing (Settings shows a "set a backup" prompt, not Today) |
| Away, backup ok | `Away until Thu 6 PM — backup: Sam` + **I'm back** |
| Away, no end | `Away — no end date (auto-ends in N days)` + **I'm back** |
| Away, backup unavailable | `Away — your backup Sam is no longer active. Nobody is covering.` (red) |
| Away, backup unreachable | `Away — Sam could not be reached (3 tries). Check their phone.` (red) |
| Hand-back pending | **While you were away** card: one row per item (name, "Sam: called back, will come Tue", open/closed badge), **Reviewed** button; stays until tapped |

**Settings → Notifications → "Away mode & backup"** (viewer: hidden): backup
picker (members who qualify), "tell my backup after N minutes" (30–480, step 15),
Away switch + optional "until" date/time, the **playbook draft** (editable text,
"Approve this wording" tap, state chip: *Not approved* / *Approved <date>*), a
read-only "what your backup will see" example, and an honest note that texting to
customers is off until registration. All controls are plain buttons/inputs
(strict CSP: no inline handlers).

## 6. Integration points for the other lanes

| Who | Call | Contract |
|---|---|---|
| Reliability / escalation ladder | `require('./away-mode-logic').resolveBackupNotifications({config, items, now, notified, backup})` | Pure. Feed it the ladder's open items; deliver each `notify[]` row through **your** verified delivery helper. Set `item.ackedAtMs` from your ack signal. |
| Reliability / heartbeat | `awayModeTick` in `integrations/heartbeat-plan.js` (one `PLAN` line, shares `call-followups`) | Give it its own slug if you want an independent dead-man (the audit's R3). |
| Reliability / delivery | `runAwayTick({ db, nowMs, live, deliver })` | `deliver(uid, title, body, data)` must resolve `{sent, failed}`; the default is `sendCustomNotification` + a bell write. Pass your verified wrapper. |
| Thursday (Bland) | `thursdayAwayContext(config, now)` → `{ active, text, untilYmd } | null` | Read once per call from `away_private`; inject `text` into the node the agent owns. Wiring the Bland pathway is **not in this PR** (agent-owned; memory: tools bind only via node data). |
| Texting | `autoReplyAllowed(...)` | The only gate an away auto-reply may pass. |
| Promise capture / labels | none | A `hide` label must still not hide an *urgent* item from the backup; the resolver takes already-filtered items, so apply labels before calling it. |

## 7. Failure modes considered

- Jo sets Away and forgets: 21-day cap, then hand-back.
- Backup's push tokens are dead: `sent: 0` is not "told"; three tries then the
  `unreachable` status and the red line.
- Backup member removed mid-window: next tick sees no active row → `unavailable`;
  Jo sees the red line within 15 minutes; items stay owner-owned.
- The tick is down: Today still shows the status line (the doc is already
  written), and callWatch/Home are untouched. The status line shows
  `lastTickAtMs` older than 45 min as "backup routing is behind".
- Clock / DST: all comparisons in epoch ms; day and quiet-hour logic via
  `America/New_York` like callWatch.
- Two ticks overlap: ledger writes are `merge` on deterministic keys and the
  `notified` check reads the ledger first, so a repeat is a no-op.

## 8. Deferred (not in the Stage 2 PR)

1. Wiring `thursdayAwayContext` into the Bland pathway node (agent-owned).
2. External (non-member) backup *delivery* — data model and consent capture are
   in; sending waits on A2P registration.
3. Writing the hand-back one-liner onto the lead's timeline (`activity`).
4. Auto-reply sender (only the gate ships).
5. Per-weekday recurring unavailable windows beyond a simple list of 7.
6. Backup notified by email through Resend (needs the suppression/consent path).
7. Multiple backups / a ladder of backups.
8. The backup's own mini-app view beyond the list packet (a "My cover shift" tab).

## 9. Decisions for Jo

1. **Viewer as backup?** Designed as *no* (read-only role, decision B). Say if you
   want a viewer allowed because they only see a name and number.
2. **Default timings** — normal 120 min, away 30 min, urgent immediately while
   away, repeat 240 min x2. Too chatty for a backup?
3. **Backup sees a call-back number.** Name + number + one-line reason is the
   minimum that lets them do the job. Anything they should *not* get?
4. **Backup can't clear anything.** Their "done" is advisory and you close it on
   return. Keep, or let the backup mark a call handled?
5. **Away wording** — the draft template is in the Stage 2 PR; you approve it once.
   Do you want it to name the backup, or just "we'll call you back by Thursday"?
6. **21-day cap** on an open-ended Away.
7. **Quiet hours for the backup** — 21:00–08:00, urgent exempt for a staff push.
