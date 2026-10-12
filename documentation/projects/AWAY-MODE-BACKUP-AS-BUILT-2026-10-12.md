# Away mode + backup — as built (2026-10-12)

*Stage 2 of the never-forget away-mode lane (PR #2389). Companion to the design note `documentation/projects/AWAY-MODE-BACKUP-2026-10-12.md` (PR #2377). Where this note and the design note disagree, this note wins.*

What shipped differs from the design sketch in these places.

- **Files.** `functions/away-mode-logic.js` (pure), `functions/away-mode.js`
  (`manageAway` callable + `awayModeTick`), `docs/pro/js/away-mode.js` (Home),
  `docs/pro/js/away-mode-settings.js` (Settings → Notifications),
  `docs/pro/css/away-mode.css`, tests `tests/away-mode-2026-10-12.test.js` and
  `firestore-rules.test.js` section 62.
- **Away mode ships dark for notifying.** `awayModeTick` is dry-run unless
  `AWAY_MODE_ENABLED=true` (registered in `cron-gates.js`; not in the committed
  env). Ending an expired window and writing the hand-back is **not** behind the
  gate. The callable and UI work regardless.
- **Lazy bundle.** `away-mode.js` loads as the `away` ScriptLoader bundle,
  kicked from `today-home.js` at Home boot, because the boot-budget ratchet
  allows no new `<script>` tag. Both pages' `script-loader.js` cache-buster is
  now `v=197`.
- **Heartbeat.** `awayModeTick` shares the `call-followups` check (one `PLAN`
  line). The reliability lane can give it its own slug for an independent
  dead-man.
- **Approval is per trip.** The security review (finding F3) showed an approval
  surviving into a later window with a different end date. Now: hand-back clears
  the approval (the draft stays), approval records the end time it was given
  against (`approvedForUntilMs`), and `thursdayAwayContext(cfg, away, now)`
  returns `null` for a different end time. Jo re-approves with one tap each trip.
- **Ledger.** One doc per window (`away_windows/{companyId}__{windowId}`); a
  non-away "standing" ledger holds routing for ordinary ack-window cover. Pruned
  rows really leave the doc (whole-doc write after a fresh read), capped at 300.
- **Tick fairness.** Tenants are served longest-since-served first with a 90 s
  budget; the remainder is picked up next run (`deferred` in the log line).
- **Lock-screen safety.** A caller name that looks like a link, email or handle
  is shown as "A caller"; bidi-override and zero-width characters are stripped.
- **Expiry never depends on the item query.** If the open-items read fails at
  hand-back time, every touched item is returned to the owner as still open.
- **Owner-only (decision 8, Jo 2026-10-12; review finding F4).** Naming the
  backup, reading the config and approving/saving the away wording go through
  `requireTeamAdmin(..., { ownerOnly: true })`: a company_admin is refused. F4
  was: "a rogue or compromised company_admin could name themselves backup and
  approve what Thursday says". A company_admin may still switch Away on/off,
  mark "I'm back" and review the hand-back.
- **Confirmed defaults (Jo 2026-10-12).** A viewer cannot be a backup. The
  backup sees a call-back number. The backup's "done" is advisory and never
  marks a call handled. The wording never names the backup to callers (it says
  the owner is away); `nameBackupToCallers` is forced false. 21-day cap;
  quiet hours 21:00-08:00 ET with urgent exempt for a staff push; timings
  120 / 30 / 240 min stay (tunable per company in Settings).

## Turning it on

1. Jo opens Settings → Notifications → "Away mode & backup", picks a teammate,
   saves, writes + approves the wording.
2. Set `AWAY_MODE_ENABLED=true` in `functions/.env.nobigdeal-pro` (a normal
   deploy). Until then the status line, hand-back and cover list work and
   nobody is pushed.
3. Wire `thursdayAwayContext` into the Bland pathway node (deferred item 1).
