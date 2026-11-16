# Session 2026-11-14: Our Work jobs, social calendar, Lomanco, wave-3 claim fixes

No customer names or addresses in this note.

## What shipped (or is held)
- **Our Work:** three closed 2026 jobs (White Oak re-roof, Cincinnati gutter-guard swap, West Chester siding repair) in PR #3034. The publish runbook ([PUBLISH-PROJECT](../runbooks/PUBLISH-PROJECT.md)) now also says to run `apply-partials.js`, regenerate the llms regions and bump the `/pro` job and town counts. The first CI run failed on all three.
- **Credentials:** Lomanco attic-ventilation training (a certificate of completion) and Lomanco under "Materials we install", with Lomanco's logo from its public logo kit, in PR #3050. `build-credentials` gained a `training` type (heading "Training", "Completed <month>", no schema certification node). `supplier-material` rows read "Made by". [ADD-A-CREDENTIAL](../runbooks/ADD-A-CREDENTIAL.md) documents both.
- **Wave-3 claim fixes (this branch):** following the owner's decisions of 2026-11-14:
  - The Pledge reads "as long as you own the home" everywhere.
  - "My crew" / "our crew" becomes "the crew(s) I bring in" (crews are independent subcontractors).
  - "20+ years" becomes "7+ years"; "meets adjusters on every claim" and the hard-coded 5★ are gone.
  - The hail-page, Miamisburg and claim-timeline wording now describes what Joe documents, not what the insurer decides.
  - Storm check and roof score label their AI note "AI-drafted", like /estimate.

  Pinned by `tests/homeowner-claims-honesty-2026-10-05.test.js` sections 6 and 12-15, each written to fail first.

## Social
- The Instagram feed (Metricool) had 24 posts, Sep 8 - Oct 5 2026. The 17 drafted posts for Nov 17 2026 - Jan 29 2027 reuse none of those jobs.
- Jobs dated before 2026 (or undated) carry the site's "Joe's work before No Big Deal" meaning in captions.
- Only Instagram is connected in Metricool. Facebook, Google Business, X, Threads and LinkedIn versions are drafted outside the repo.

## Conversion fixes (bundle `bundle/homeowner-2-2026-11-15`, 2026-11-15)
The wave-3 conversion findings, except /estimate (#3089 owns it). All page-only; no function or rules change.
- Town heroes carry the credentials strip (CREDENTIALS-STRIP markers, stamped by `build-credentials`).
- The on-page quick form asks name, phone, address and the scheduling choice; email and the other extras sit behind one optional "Add email, photos or details" toggle and are still posted. Its heading follows the button ("Book a Free <Town> Inspection", "Book a Free <Service> Estimate").
- Nav "Book Inspection" goes to `/inspect` (the `cta_href` partial parameter, the microsite partial and the `build-projects` template).
- Siding and gutter "Book a free estimate" opens the page's own form, which posts the service.
- "Get My Care Plan" lands on the homepage form with "Roof Care Plan" picked (`?service=care-plan`).
- `/storm-check` promises "should your roof get looked at", which is what every result says.
- `/pro/refer` names Joe and links `/inspect` and his number; a white-label tenant (`?co=`) sees neither.
- Our Work hero: booking button and tap-to-call. Error and thank-you phone numbers are `tel:` links. Every `tel:` has `+1`.
- `/credentials`: certificate of insurance on request. No "coming soon" placeholder in recent-jobs strips. The roof-repair box is "Every Repair Includes".
- AI tells: "Actually" headings and "The result?" on /about, "Absolutely" in the homepage FAQ, emoji H3s on town pages (also in `build-town-pages`), and two filler lines.

Pinned by `tests/homeowner-conversion-2026-11-15.test.js` (structure and run checks; 34 of them fail on the previous bundle).

## Open
- /estimate saving the lead at step 1 (#3089; touches lead intake).
- `/refer` as a short URL and a text-consent line on `/pro/refer` (both need a hosting or functions change).
- The Lomanco training blog post (waiting on the owner's takeaways) and a Lomanco mention on the roof-replacement page.
