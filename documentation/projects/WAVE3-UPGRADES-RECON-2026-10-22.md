# Wave 3 upgrades recon (2026-10-22)

Recon for three items: Pro demo refresh, SEO pass, messaging-center honesty. Base: `origin/main` at `4536ddc8`. No prod reads, no writes, no flags, no credentials. PRs #2662-#2668 were all still open and blocked when this was written, so no PR is open from this branch yet.

## 1. Pro demo refresh - nothing broken
Ran the four demo suites locally in Chromium (already installed, nothing downloaded; `npm install` in `tests/` only): zero-network walk 92/0, story 91/0, wave2 76/0, sdk 204/0. The CI job "Pro demo zero-network walk" runs the first one, so it should stay green. No fix needed; the recent tracker and CRM changes did not break the guided story or the browser-only sample account.

## 2. SEO pass - blocked on Search Console data
Needs Jo's Search Console export (apex property) or a signed-in tab read; not available to this session. Without it, an on-site scan of public pages found: 0 duplicate titles, 0 duplicate H1s, `check-site-integrity` clean (320 pages), sitemap matches `docs/sitemap.xml` (299 URLs), town pages stamped clean (43 area + 15 service). The scan's one "duplicate description" hit was a regex artifact (an apostrophe in "Joe's"). Next step once data arrives: query-to-page mapping for cannibalization, then edit `site-src/data/towns.json` / partials and restamp. Semrush MCP is not used.

## 3. Messaging honesty
Already honest on main: SMS outcome only becomes `delivered` from the carrier callback (`smsOutcome`, `parseDelivery`); the lead-alert watchdog treats Twilio acceptance as not reached; the alert banner flags `undelivered:`/`failed:`.
Gap found: the Messaging Center painted `sent` (provider accepted) in the same green as `delivered`. Fixed on this branch: `sent` now reads amber "accepted, not confirmed", with the help text reworded. Test added in `tests/messaging-center-2026-10-19.test.js` (positive: amber/green split; negative: no green "sent" chip; mutation: reverting the class fails the check).
A2P: Jo confirmed in chat on 2026-10-22 that the campaign is Verified (2026-10-19), so no live read was needed; the remaining gap is the display wording fixed above. Remaining honesty candidates: events stamped `sent` with no delivery data (lead ack text/email, missed-call text, review ask) now show amber too, which is the intended wording; a callback-coverage figure ("how many accepted texts ever got a carrier verdict") would be a follow-up.
