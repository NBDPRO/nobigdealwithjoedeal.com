# Next session — handoff 2026-10-03

A long "keep going" day. Four lanes shipped: the restyle program
finished its JS-screen pass, the calls email gained a one-at-a-time
deck, the CRM got a game, and the call importer was un-stuck. An audit
produced the top-20 list in §4.

## 1. Shipped today (all merged unless noted)

**Restyle (inline styles → stylesheets).** 41 JS screens, #2065–#2092
plus #2100 (decision-engine multi-line, queued). `docs/pro/js` ratchet
4101 → 2148 (2136 with #2100). Status table:
[RESKIN-PLAN-2026-10-01](RESKIN-PLAN-2026-10-01.md).

**Calls.**
- #2093: the "Said you'd do" deck. The twice-daily email shows the true
  count and links to a one-at-a-time deck. Swipe right = done, left =
  later; snooze, call, text, file on a customer.
- #2096: no-customer calls get "Looks like X" / "🆕 Make this a lead".
- #2097: **the importer was stuck.** An 89 MB May-10 recording failed
  every run and the scan stopped at its day. No call reached the CRM
  after Oct 1 21:36 ET; Oct 2 had 5. The fix:
  - too large → a permanent, logged skip;
  - the newest 3 day folders are filed first on every run.
- #2098: the daily transcription cap is a setting,
  `integrations/callCenter.dayAudioCapHours` (default 7.5 h). Jo chose
  NOT to upgrade Groq: normal days use 1–2 h. The backlog (~196 stored
  calls ≈ 15 h, plus May 10–June still to import) clears in ~2–4 days,
  new calls first.

**Game.**
- #2094: the optional Home game card. Pixel avatar, XP only from real
  work, "your ghost" = last week.
- #2095: **Roof Rep**, the roofing-sales game, with its own tab (sidebar
  TOOLS + phone More). See
  [ROOF-REP-GAME-2026-10-03](ROOF-REP-GAME-2026-10-03.md).
- #2099 (queued): "Play Roof Rep" on the Home card.

## 2. Verify first next session

- **Calls.** Confirm production has Oct 2's calls and the backfill
  cursor moved past 2026-05-10:
  - `integrations/callCenter.lastRun.tooLarge` = 1;
  - no new `call_center_file_failed`;
  - phone_calls in June exist.
- **Deploys.** #2094's deploy failed on a transient Firestore API error
  ("Failed to make request to firestore.googleapis.com", wholesale,
  before rollout). The next deploy (856e58a1 / 575a533f) must succeed.
  Check `getGameCard` is deployed and `/pro/roof-rep.html` is served.
- **Email.** The 10-04 07:15 calls email (first with the deck link):
  does the link open the deck on the installed iPhone app?

## 3. Lessons (also in memory)

- **A green local smoke over UNTRACKED new files proves nothing.**
  File-walking guards (catalog-cost-privacy) scan tracked files. Stage
  first. Roof Rep's shop used a `cost:` key and failed CI.
- **The restyle converter (scratchpad reskin.js) overwrote an existing
  stylesheet** on a second pass. It now appends; check the CSS diff for
  removed lines anyway.
- **Queue runs hit the 2 h background limit.** Run short chains (2–3
  PRs). A chain stops by design when the local head ≠ the PR head:
  push, don't force.
- **Keep-both conflicts the resolver doesn't know** (FUNCTIONS_INDEX.md,
  functions/index.js, viewer-callables.test.js, the
  tests/package.json spec list) recur whenever two PRs add a callable
  or spec. Resolve keep-both by hand, re-measure the manifest floors.

## 4. Top 20 (audit, 2026-10-03), ranked for Jo's week

**Needs Jo**
1. **Twilio A2P registration.** 0/23 texts delivered in 45 days. See
   [TWILIO-A2P-REGISTRATION](../runbooks/TWILIO-A2P-REGISTRATION.md).
2. **Promote Thursday 0.7.0.** The live receptionist still says "walk
   them through the claim". One test call, then
   `scripts/thursday-agent-lookup.js --promote --yes`.
3. **Free-roof page.** "Drawing" vs "a gift, not a contest", plus
   denied-claim targeting in KY counties: needs a call and maybe
   counsel (`docs/free-roof/index.html:469/561`).
4. **The NAP / map pin mismatch.** Address is Campton KY, the geo
   coordinates are near Goshen OH. Tied to the Business Profile move.

**Website**
5. **KY claim wording the gate misses:**
   - "full payout they're owed" (storm-damage-mason-oh:492);
   - "every dollar of damage" (…cincinnati-oh:492);
   - "Max Your Payout" and "Denials get appealed"
     (hail-damage-insurance-claim:746/380/812, also llms-full.txt);
   - schema service "Storm Damage Insurance Claims" on every page.

   Reword, and add gate rules for payout / appeal / every dollar /
   file claims.
6. **"Insurance Restoration" / "Storm Claims" in titles.** Brand call for
   Jo.
7. **Home H1** has no service or place.
8. **Service vs city pages** cannibalize each other.
9. **49 our-work pages** have no mobile call bar and weak titles.
10. **Estimate page H1.**

**CRM / ops (safe without a decision)**
11. **CSP reports arrive empty.** `monitoring.js` reads JSON;
    application/csp-report isn't parsed. Use `rawBody`.
12. **migrationsTick hasn't run since 09-20.** "every 24 hours" resets
    on each deploy. Use a fixed time.
13. **No `notes(type, createdAt desc)` index in production**; the AI SMS
    draft swallows the error (`handlers/ai-texting.js:162`).
14. **No `otp_requests(phone, requestedAt)` index in production**
    (`verify-functions.js:74`). No calls in 30 days, so latent.
15. **Portal photos keep EXIF/GPS.** Re-encode with sharp, like the
    public form path.
16. **hailMatchCron drops leads** on transient fetch errors. Retry with
    backoff.
17. **E2E gates.**
    - boot-weight and tenant-filename-prefix specs have no shard tag,
      so they never run.
    - The shard-tag check can't fail.
    - retries 3 hide flakes.
    - There's no `forbidOnly`.
18. **Cal.com usernames saved as full URLs** stay broken (BUG-LOG
    R4-11). Production check, then fix.
19. **Unbounded live listeners** on all company knocks and estimates.
20. **Claim progress per job.** `claimStage` / `claimHistory` /
    `checklist_*` aren't in JOB_FIELDS (needs Jo's OK).

Also noted:
- crmMcp logs 405 GETs at WARNING, and a Cursor client failed auth 13×.
- The deploy retry step's `continue-on-error`.
- `renderInvoicePanel` is mounted nowhere.
- The street-address hard-require is due about 10-07.
- Price book phase 2 and financing are blocked on Jo's answers.
