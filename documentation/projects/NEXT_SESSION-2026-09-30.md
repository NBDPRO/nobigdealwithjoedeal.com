# NEXT_SESSION — 2026-09-30

This follows [09-29 part 3](NEXT_SESSION-2026-09-29-part3.md). Jo was mostly
away ("keep going"), and approved merging once green. The session had two
parts: finishing the 09-29 lanes (homepage audit, signed-document lock), then
**the intake-forms overhaul**, which Jo asked for mid-session and put first.

## §0 Read first

- **A local emulator test texted and emailed Jo.** A server-side E2E posted
  one synthetic `submitPublicLead` (ZZ_QA Intake, 123 Test St, Mason) to the
  **local functions emulator**. `leadAlertContact` fired, and a real Twilio
  SMS and Resend email reached Jo. It was disclosed to Jo right away and is
  safe to ignore.
  - The emulator reads the live Twilio/Resend secrets even though its
    startup log warns it can't access some secrets.
  - **Rule:** never POST lead-creating requests to the functions emulator
    with the alert triggers live. Test the browser side with Playwright
    `route` interception instead (below).
  - Memory: `emulator-lead-alerts-send-real-sms-email`.
- **Sandboxed browser testing works.** Start a hosting-only emulator
  (`emulators:start --only hosting`) and give Playwright a `ctx.route('**/*')`
  that:
  - fulfils `submitPublicLead`, `uploadPublicLeadPhoto`, `formsubmit.co` and
    `/api/site-config` itself;
  - aborts everything else.
  Nothing leaves the machine, and the homepage's FormSubmit backup email to
  jd@ is intercepted. The microsite key is in the **path**
  (`/sites/t/<key>`) or `?c=`, not `?company=`.
- **A missing address is flagged, not refused, on the server.** Every form
  now requires a street address in the browser. The gateway only sets
  `missingAddress` and adds a "⚠ No address given" note, so a cached old
  page can't lose a lead mid-rollout. **Follow-up:** hard-require it after
  about a week of cache turnover.

## §1 Shipped (PR → what)

| PR | What |
|---|---|
| #1901 | Homepage QA audit (tap-to-call, desktop hero CTA above the fold, WCAG AA contrast). Landing visual re-blessed from CI's actual after Jo OK'd the artifact download. |
| #1903 | brace-expansion 5.0.9 → 5.0.12 (a new HIGH advisory). Override pin plus a hand-spliced lock entry. |
| #1904 | The signed-document lock also covers the legacy top-level `/documents` collection (owner-only share toggle / archive; no client hard delete of a signed doc). |
| #1905 | **Intake forms.** Photos reach the CRM, and every service form requires a scheduling choice, a phone number and a street address; email is optional. Merged as `68eb4d41`; deploy run 36721333965. Details below. |

**Two things CI caught on #1905, worth knowing:**

- **@stranger went red for a real reason.** Its microsite quote-form step
  didn't fill the newly required address and scheduling choice. The spec now
  does, and also pins "no NBD calendar", "never says Joe" and
  `schedulingPreference` on the bridged lead.
  - **Any future required field on a public form means grepping
    `tests/e2e` for the form's ids first.**
- **The landing baselines were stale in a way the 2% tolerance hid.** The
  #1901-era baseline showed the "See every job" ghost button still
  **invisible**. The re-bless (landing 375/768, from byte-stable CI actuals,
  with Jo's OK for the download) picked up #1901's contrast fix along with the
  taller form.
  - The lower half of the landing capture renders blank (scroll-reveal), so
    **form copy is not covered by visual regression**. Check copy with a
    forced-reveal Playwright shot.

### #1905 in brief

- **Photos:** `submitPublicLead` returns a one-time `photoToken`, stored as a
  SHA-256-keyed grant in `public_lead_photo_grants` (60 min, max 10).
  - The page posts each photo to the new **`uploadPublicLeadPhoto`**
    (`functions/public-lead-photos.js`).
  - sharp re-encodes each photo: non-images are refused before a slot is
    used, EXIF/GPS is stripped, size is capped at 2560px.
  - Stored at `homeowner-uploads/{owner}/{crmLeadId}/web-*.jpg`, with a
    `/photos` doc (`source:'web_form'`) on the bridged CRM lead, so the
    rep's gallery shows it with no CRM change.
- **Shared block** (`docs/assets/js/intake-extras.js` + `.css`):
  - A required choice: *Pick a date & time now*, which opens Cal.com
    prefilled after submit, or *Please contact me to coordinate
    scheduling*.
  - Best time, insurance claim, how they heard about us (including "AI
    assistant"), and photos.
  - On the homepage, 185 quick-form pages, `/inspect` and the contractor
    microsite. The microsite uses the contractor's name and phone and has
    no NBD calendar, so contact-me is the only option and still required.
- **CRM notes** gain photo count, scheduling preference, best time,
  insurance and how-heard, plus `lead.schedulingPreference`.
- **Tests:**
  - `intake-forms-2026-09-30.test.js`: 50 checks.
  - `inspect-photo-disclosure-2026-09-16.test.js` was rewritten on behaviour
    (vm-sandboxed afterSubmit): the homeowner is never told photos arrived
    when they didn't. Break-tested.

## §2 Open — Jo's hands

Carried from [part 3](NEXT_SESSION-2026-09-29-part3.md) §2:

1. Fill in the month in Schedule → Plan Jobs.
2. One Thursday test call. Greet-by-name has never been seen working.
3. The Bland balance is −$0.52.
4. The six Stripe review items.
5. ACH / Cash App dashboard settings.
6. Home Depot items.
7. Optional: the free/busy share.

New:

8. **Try the photo upload once from your phone** on the live site: `/inspect`
   or any service page, pick "please contact me", attach a photo. It should
   show up in that lead's Photos in the CRM within seconds.

## §3 Next lanes (Jo's order)

1. **Instant Roofer auto-measurement.** Needs Jo to enter the API key in
   the CRM and OK about $3 per lead. It's dormant today because the key is a
   stub.
2. **Thursday greet-by-name.** Waits on Jo's test call (§2.2).
3. **Careful worktree cleanup.** 30+ `nbd-wt-*` worktrees exist.
   - Unlink each `node_modules` junction **in PowerShell**
     (`(Get-Item x).Delete()`) before `git worktree remove`.
   - On 09-30 a Bash-loop cleanup emptied main's `node_modules`, and
     `npm ci` recovered it.
   - Memory: `worktree-path-length-limit`.
4. **Intake follow-ups:**
   - hard-require an address on the server (§0);
   - add the shared block to the Instant Estimate wizard and the storm
     tools.
