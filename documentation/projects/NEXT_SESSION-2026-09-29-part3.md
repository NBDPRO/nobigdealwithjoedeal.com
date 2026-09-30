# NEXT_SESSION — 2026-09-29 (part 3, evening)

This follows [part 2](NEXT_SESSION-2026-09-29-part2.md). Jo was home and
steering: "keep going", then "do all 3", then "do all 3, obviously 3 last". It
covers scheduling for real use, two security lanes from the
[09-26 brief](NEXT_SESSION-2026-09-26.md) §4, and the signed-contract lock.

## §0 Read first

- **Google Calendar is connected and correct.** Jo pressed Connect at 7:23 pm
  and got the "NBD Jobs" share email; accepting it adds the calendar to the
  Google app, and that wasn't confirmed this session. It showed "1 events in sync", which is right: 1 of
  247 leads had a job date. Jo had not been scheduling in the CRM, and is now
  filling in the next month with **Schedule → Plan Jobs**.
- **Week-first scheduling** (Jo's ask). A job can be planned to a **week**
  (`lead.scheduledWeek`, the Monday) before its day is known.
  - Google and the iPhone feed show a **free** Mon–Fri bar,
    "📆 Week of: name".
  - The homeowner portal says "scheduled for the week of…" with a
    "we'll confirm your exact day" note.
  - Setting a real date clears the week and updates the same calendar event
    in place.
- **Signed contracts are locked** (#1900).
  - **Decision conflict, resolved by date:** decision A (09-25) let the owner
    or company_admin hard-delete a signed contract, but Jo's *later* lock
    decision the same night says archive only.
  - Two old rules tests used signed fixtures to test the role tiers; they now
    use unsigned ones.
  - Memory `role-permission-decisions-2026-09-25` records this.
- **A merge whose deploy never ran:** GitHub fired **no push event** for
  #1897's merge (no CI or deploy runs for `a85fabb4`). It was deployed with
  `gh workflow run firebase-deploy.yml --ref main -f scope=all`, which is the
  same code a push would have deployed.
  - If a merged fix isn't live, check `gh run list --commit <sha>` before
    anything else.

## §1 Shipped (PR → what)

| PR | What |
|---|---|
| #1894 | **Tracker food card** (the plan's default): a protein bar (1 g/lb of the 7-day average weight, or Jo's own target), saved favorites summed into meal rows, and "Same as yesterday" filling only empty rows. It syncs through `userSettings.dsFood`. Also the Thursday verification ([vault §11](../architecture/THURSDAY-BLAND-2026-09-26.md)). |
| #1895 | 🗓️ **Schedule** in the sidebar under Pipeline, in the phone More drawer, and in the tab-bar picker. It was only reachable from Pipeline → ⋯ Tools, so Jo couldn't find Connect. The Google panel now waits for sign-in on a direct `#/schedule` link. |
| #1896 | **Security (publead):** `measureNewWebLead` spends and writes back only for a lead the **bridge** created (the doc id must equal `bridgeDocId('estimate_leads', id)`). Before, a client-set `publicLeadCollection` / `publicLeadId` could aim an Admin-SDK write at any path and trigger the paid measurement. It was dormant, because the Instant Roofer key is a stub. |
| #1897 | **Security (inviteaccept):** `claimInvite` answers `confirm_required` (with `hasData`) for anyone who owns a company, and joins only on `{confirm:true}`. Before, any tenant's invite to an owner's email silently moved that owner into the other team at boot. An invite-link signup, which owns no company, still joins at once. "Not now" is stored on `userSettings.inviteDeclined`. The E2E rep now taps Join; `@stranger` passed. |
| #1898 | **Plan Jobs panel** plus week-first scheduling: the Google week bar, the portal "week of…" line, and a `scheduledWeek` rules shape check. |
| #1899 | **Weeks everywhere:** the customer page Edit modal, the dashboard lead editor, and the iPhone .ics feed. `normalizeLeadWeek` is shared by the feed and Google; `mondayOf` is in the shared `schedule-window.js`. |
| #1901 *(open)* | **Homepage QA audit** (Jo's QAlaunch report).<br>• Tap-to-call on the contact step.<br>• Desktop hero CTA above the fold: at 1280×720, "Call Joe" moves from 910 to 554. Desktop only; 390px is pixel-identical.<br>• WCAG AA contrast: 56 failures → 0, using palette colors only. Also fixes two **invisible** ghost buttons, "See every job" and "Read all our Google reviews".<br>• Nav **not** enlarged: 15–16px wraps, and 12px is the most that fits.<br>• Form verified end to end, so no change.<br>**Waiting on:** the landing visual re-bless from CI's `-actual.png`s. That needs Jo's OK to download the ~100 MB CI artifact (asked; no answer yet). Then merge; Jo waived review. |
| #1900 | **Signed contract lock:** Firestore (share toggle plus owner/company_admin archive only, no client hard delete), Storage (signed HTML tagged `signed:'true'` and immutable; `esign/.../signed.pdf` function-only), and a clear client message. |

## §2 Open — Jo's hands

1. **Fill in the month** in Schedule → Plan Jobs. Afterwards, ask a session to
   check that Google and the portals match.
2. **One Thursday test call.** Stay on past the greeting and say a sentence.
   Greet-by-name has never been seen working: `thursdaycallerlookup` got no
   requests after 09-27 (vault §11).
3. **Bland balance is −$0.52.** The $20 bank transfer from 09-28 hasn't
   landed. If Thursday stops answering, check this first.
4. **Optional:** share the main Google calendar's free/busy with
   `717435841570-compute@developer.gserviceaccount.com`, so the
   double-booking warning sees personal events too.
5. **Still open from before:** the 6 Stripe payments that need a customer (on
   Home); ACH activation; Cash App keep or off; the Home Depot receipts; the
   `<` / `>` leads count (not approved).

## §3 Next build lanes

1. **After Jo schedules:** verify in production that each planned lead has
   exactly one Google event (week bar or day), and read
   `integrations/googleCalendar.lastSync` after the 05:45 reconcile.
2. **Thursday greet-by-name:** after Jo's test call, if there's still no
   request to `thursdaycallerlookup`, compare the builder's Initialization
   snippet URL with the deployed function URL.
3. **Legacy top-level `/documents`** rows are not covered by the signed lock,
   which targets `leads/{id}/documents`. Check whether any signed contracts
   still live there before calling the lock complete.

## §4 Method notes from this session

- **The worktree junction wipe happened again.** A Bash loop's `rmdir` lost
  its backslashes, so nothing was unlinked, and `git worktree remove` then
  emptied main's `functions/` and `tests/` `node_modules`. It was recovered
  with `npm ci` in both, and the lockfiles were untouched.
  - Unlink in the PowerShell tool, verify, and only then remove, in a separate
    call. Memory `worktree-path-length-limit` has the details.
- **Emulator ports:** the QA rig holds 8080/9099/9199/9299. Run the rules
  suites on copies pointed at **8181** (Firestore) and **9399** (Storage),
  with a throwaway `zz-fb-*.json`, and delete both afterwards.
- **Storage rules:** a `{allPaths=**}` wildcard is a *path*, not a string, so
  `.matches()` on it fails at runtime. Use `request.resource.name` for writes
  and `resource.name` for deletes.
- **A rules "evaluation error" on delete:** a helper that reads `resource`
  must be null-safe. A delete of a row that no longer exists has no
  `resource`, and the old tests do exactly that.
- **The deploy-step harness** decides "retry" by whether a name was already
  targeted, not by batch size (fixed in #1891; memory notes it).
- **A decision conflict belongs in the PR body and in memory,** not only in a
  test comment.
- **When a rule change makes old fixtures behave differently, grep EVERY test
  file,** not just the suite you're editing. #1900 went red in CI because
  `firestore-rules.cross-tenant.test.js` (a second rules suite) also used a
  signed fixture to test role tiers. Command: `grep -rln "status: *'signed'" tests/`.
- **The homepage has its own measurement harness** (scratch `home-audit.js`):
  hero CTA against the fold at 1280×720/800, 1440×900 and 390, plus an
  in-browser WCAG contrast pass that composites real backgrounds after
  scrolling so fade-ins complete. axe and Lighthouse are not installed.
