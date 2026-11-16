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

## Open
- The 15 conversion findings from the wave-3 review.
- /estimate saving the lead at step 1 (its own session; touches lead intake).
- The Lomanco training blog post (waiting on the owner's takeaways) and a Lomanco mention on the roof-replacement page.
