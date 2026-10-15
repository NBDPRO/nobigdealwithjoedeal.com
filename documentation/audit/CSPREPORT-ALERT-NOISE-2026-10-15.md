# cspReport alert noise — 2026-10-15

Joe got the "Rate-limit denial (any…)" SMS several times a day from 10-12 on,
always `service_name=cspreport`.

## What the logs showed (project nobigdeal-pro, read-only)

- The 2,000 most recent `rate_limit_denied` entries over 7 days: **all**
  `cspReport:ip`. Nothing else was being denied.
- Of the last 300 `csp_violation` lines, 295 came from one browser (Brave on
  iOS 18.7, WebKit), every field blank.
- Of the last 400 cspreport requests: 159 × 204, 131 × 429, **110 × 504**.
  Each 504 is Cloud Run's "reached the maximum request timeout" at 5.0 s; in
  the one traced, the limiter's `rate_limit_denied` line arrived 5 s *after*
  the timeout.

## Root cause

1. **Blank reports.** WebKit posts one Reporting API object per request,
   `{type:"csp-violation", url, body:{effectiveDirective, blockedURL, …}}`.
   The parser knew the legacy `{"csp-report":{…}}` and Chrome's array, so it
   logged the wrapper object, whose top-level keys are none of the fields.
2. **The page.** The browser re-sent the same reports, over 60/min from one
   IP; every denial logged `rate_limit_denied` at WARNING, which is exactly
   what the paging policy matches.
3. **The timeouts.** Up to 80 concurrent requests per instance from that one
   IP all ran a Firestore transaction on the same counter doc
   (`_rate_limits_ip/cspReport:ip__…`). The contention retries ran past the
   function's 5 s timeout.

## Fix (PR "cspReport: parse Safari/Reporting API reports, dedupe, stop alert noise")

- `functions/csp-report-logic.js`: parse all three shapes into
  `directive / blocked / document / disposition / sourceFile / line`; ignore
  browser-extension reports; drop an identical report (same directive +
  blocked + document) from the same IP for 10 minutes **before** the limiter;
  204 on every POST path; the limiter call is raced against 1.5 s.
- Denials log INFO `csp_report_rate_limited` with `sampled: true`, once per IP
  per 10 minutes, with `suppressedSinceLast` and a hashed IP. The shared
  limiter takes `{ logDenial: false }` from this one caller only.
- Alert policy 13778878090024008942: `AND NOT jsonPayload.namespace=~"^cspReport"`
  added, applied live 10-15 (see [monitoring/README](../../monitoring/README.md) §4).
  Replayed on 60 days of logs: it still matches the `claudeProxy:uid` denials of 09-29.
- Tests: `tests/csp-report-noise-2026-10-15.test.js`.

## Not changed: the `style-src-elem 'inline'` reports

The few reports that did parse were `style-src-elem` `inline`, disposition
`report`, on `/privacy` (line 36), `/` (37), `/terms` (38), `/inspect` (27) and
others. The source file is the page itself and each line is that page's own
first `<style>` block, so this is our code, not an extension. But it is the
**Report-Only** policy (`style-src 'self' https://fonts.googleapis.com`, no
`'unsafe-inline'`) doing its job: 293 of 294 public pages carry inline
`<style>` blocks (privacy 5, terms 2, home 10, inspect 4; ~68 KB on those
four). Moving those four pages' CSS out would leave the same report on the
other 289, adds render-blocking requests to the homepage, and is a site-wide
CSP migration rather than part of this fix. Nothing is broken for visitors:
the enforced policy still allows inline styles.
