# Roof Check merge (2026-11-25)

The three storm tools are one page, **/roof-check**. Context: the website deep
dive of 2026-11-25 ranked the three as overlapping and under-performing (see
[WEB-LEADS-TURNSTILE-OUTAGE-2026-11-25](../audit/WEB-LEADS-TURNSTILE-OUTAGE-2026-11-25.md)
for the lead counts). All-time stored submissions before the merge: 5 from
/storm-report (which showed a free result first), 2 from /storm-check (which
asked for contact details first), 0 from /roof-score.

## Decisions (Jo, 2026-11-25; do not relitigate)

- **One URL, new name: `/roof-check`.** The old URLs 301 there.
- **Free storm history first.** Address, then the 5-year storm record for it
  with no contact asked. Joe's take (the AI note) only after contact: it costs
  money per call, and a warmer lead gives a number after seeing their history.
- **Roof Score's extras are dropped:** the 0–100 score and band (more precision
  than five answers support), the moisture question (now a sign tile, "Water
  stains on a ceiling or wall inside", value `leak`) and the last-inspection
  question. The storm "when / what kind" step is gone too: the 5-year lookup
  answers it.

## The flow (docs/roof-check.html + docs/assets/js/roof-check.js)

1. Address (Nominatim on blur / Check, never per keystroke; "use my address as
   typed" when the map finds nothing).
2. Free storm history (`GET /api/storm-report`, unchanged). A failed lookup says
   "we couldn't check", never "no storms", with Retry. A soft link to /inspect
   and the phone for anyone who just wants Joe.
3. Roof age (required), material, signs (multi-select, incl. water stains).
4. Contact: first name, phone, optional email (for the emailed storm-report
   copy), the scheduling block, the optional TCPA box (tcpa-v3 wording).
   `submitPublicLead('inspect', { source: '/roof-check', … })` runs FIRST.
5. Result: a plain verdict from the storm data plus the answers (at most "worth
   a free inspection"), Joe's take (`publicFunnelAI`, kind `stormCheck`), the
   storm table / map / measured gusts, optional details + photos.

GA events: `roof_check_generate`, `roof_check_history`, `roof_check_questions`,
`roof_check_contact`, `roof_check_submit`, `roof_check_complete`
(`generate_lead` still comes from public-lead-submit.js).

Lead story: `ROOF CHECK | N events/Yyr (h hail, w wind, t tornado, max X″) | roof age: … (…) | signs: …`,
or `ROOF CHECK | storm records unavailable | …`.

## What moved where

| Before | After |
|---|---|
| /storm-check, /storm-check.html | 301 → /roof-check |
| /roof-score, /roof-score.html | 301 → /roof-check |
| /storm-report, /storm-report.html | 301 → /roof-check |
| docs/storm-check.html, roof-score.html, storm-report.html | deleted |
| docs/assets/js/storm-check.js, roof-score.js, storm-report-page.js | deleted (roof-check.js) |
| lead `source` '/storm-check', '/roof-score', '/storm-report' | '/roof-check' |
| stormReportEmail: source '/storm-report' only | '/roof-check' or '/storm-report' (pre-merge leads); parses the ROOF CHECK story; links /roof-check |
| publicFunnelAI kinds | page posts `stormCheck` only; `roofScore` still validated server-side, no page posts it |
| /free-tools: three cards | one Roof Check card |
| nav-blog, mobile-nav-blog, footer-extended partials; homepage, /review, NBD Guarantee hand-copied menus | one "Free Roof Check" link |
| sitemap.xml, llms.txt, perf-watch | /roof-check |
| privacy (Roof Score bullet), terms (tool names) | Roof Check |

Unchanged on purpose: `/api/storm-report` and the `stormReport` function, the
TCPA wording/version, `storm-check-ga.js` (the GA bootstrap kept its file name).

## Left as is

- The live storm-alert SMS body (`functions/storm-watch.js`) and its sample on
  /storm-alerts still say `nobigdealwithjoedeal.com/storm-check`: it 301s to
  /roof-check, and changing outbound SMS text near the A2P re-registration is
  Jo's call.
- The printable guide PDFs (`docs/guides/pdf`) still print /storm-report; the
  redirect covers them until the Docs Studio rebuild.
- Comments in the CRM (`docs/pro/js/…`) that describe the old public page.
