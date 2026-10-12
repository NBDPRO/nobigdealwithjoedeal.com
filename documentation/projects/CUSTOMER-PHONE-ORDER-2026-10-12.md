# Customer page, ordered for a phone on a roof (2026-10-12)

Phone audit [2026-10-07](../qa/crm-phone-audit-2026-10-07/README.md), item 1: at 390x844 the customer page was 15 phone screens long. The Notes box sat 4.9 screens down, Build Estimate about 4.5, and Record payment about 12 (under 22 document-template tiles). This lane re-orders the page for a thumb on a roof. It changes order and folding only. No panel, handler or data path is new.

The work was first built uncommitted in a worktree (`feat/customer-page-phone-order`, 43 commits behind main) and re-applied here on a fresh worktree off main. Nothing else on main already did this (no `customer-phone-order` file existed).

## What changed

- **Roof-day action row** (`#roofActionRow` in `docs/pro/customer.html`, wired by `docs/pro/js/customer-phone-order.js`): Call, Text, Note, Estimate, Payment, Navigate, in the header at scroll 0. Each button reaches the control that already did the job, so there is one handler per action:
  - Call taps `#callLink`, so the header's own handler writes the Comm Log row.
  - Text taps the bottom bar's Text on a phone (its capture listener logs); otherwise it opens the same `sms:` composer and logs through `__NBD_CALL_REGISTRY.logCommunication`.
  - Note, Estimate and Payment are plain `data-action` markup for the page delegate (`openNotesModal`, `_openInDashboardEstimate`, `NBDCustomerInvoices.recordPayment`).
  - Navigate opens Apple Maps on iPhone, Google Maps elsewhere, for the address in the header.
  - Call and Text hide when the lead has no phone; Navigate hides with no address.
- **Phone order** (`docs/pro/css/customer-phone-order.css`, 900px and under): the header is name, where, the action row, stage/brief/More, then the AI suggestion. Overview's two columns become `display:contents` in one flex column, ordered by daily use: numbers and warranty claim, owed money, Notes, Tasks, insurance and finance, Estimates, Invoices, Stripe, Photos, production and jobs, Files, Customer Info, checklist, profit. Anything a module injects later lands at the end. Desktop keeps two columns.
- **Money first:** Invoices & Payments moved up from the Files tab to sit beside Estimates. While "Total Owed" is above $0 it carries `data-owed="1"` and floats to the top on a phone. The module reads the rendered summary; it never recomputes money.
- **Folds:** rarely used panels are `<details class="cpo-fold" data-fold="phone" open>`. Open on desktop and with no JS; closed on a phone. Documents (22 tiles) shows a count. A jump to a section (jump nav, checklist "Generate", a `#hash`) opens the folds inside it. Portal Messages opens itself when the unread badge shows; a Voice Intel error toast re-opens the Voice fold.
- **Bottom bar:** Email became Note (`openNotesModal`); Email stays one tap away in the header's More. Call and Email step down into More only when the row is on the page (`ROW_COVERED_IDS` in `customer-quick-actions.js`).
- **44px targets** at 640px and under for the page's buttons, selects, inputs, jump-nav chips, checklist rows and task checkboxes (the checkbox draws its 22px box as SVG inside a 44px control).

## Proof

Measured on the seeded lead at 390x844 with the installed-app rules forced (`tests/e2e/phone-customer-order.spec.js`, Chrome, emulator):

| | origin/main | this lane |
|---|---|---|
| Page length (phone screens) | 15.1 | 9.7 |
| Notes box | 4.9 down | 1.6 |
| Build Estimate | 4.5 | 2.7 |
| Record payment | 11.8 | 3.2 |
| Action row | none | six buttons at scroll 0, each 44px or more, above the bottom bar |

- `phone-customer-order.spec.js`: 8 tests (6 behaviour, plus dark `nbd-original` and light `paper` themes at 390: no sideways scroll, row label contrast at least 4.5, targets 44px), 24 of 24 across three repeats, then green again in the combined run.
- Combined run of the 21 customer-page and phone specs that touch this DOM (`phone-fit` at 412 and 360, `phone-chrome`, `phone-customer`, `phone-ux-batch`, `doc-template-library`, `contract-cancel-forms`, `boot-weight`, `pro-authed`, and others): green. `contract-cancel-forms` and `phone-ux-batch` / `doc-template-library` needed to open the Documents fold first, which is the one real behaviour change (one extra tap to reach the tiles on a phone).
- Unit: `customer-quick-actions.test.js` 34/0 and `qab-comm-log.test.js` 14/0. Break-tests: dropping the row guard or the Email step-down reddens "Call and Email step down into More" and "More counts them"; wiring Note to the task sheet reddens "tapping Note opens the note sheet (openNotesModal), and nothing else".
- Gates: `check-js-syntax`, `check-site-integrity --quiet`, `check-inline-html-scripts`, `check-vault-index`, `inline-style-ratchet` (customer.html 206 of 206, no headroom spent), `css-no-js-escapes`, `claim-wording`, and `node tests/smoke.test.js` 4417 passed, 0 failed.
- Not run: WebKit. The emulator rig was shared with other layout lanes all session, so runs used the installed Chrome via a temporary config (not committed); CI runs the real Chromium project.

## Things to know

- The e2e spec forces the installed-app rules (`display-mode: standalone` copied to the top level) and uses a 390x844 iPhone context. No browser matches that media query, so a forced copy is the only way to test it ([phone-scale rule](../../CLAUDE.md)).
- The spec stubs every Cloud Function and aborts Twilio, Resend, Stripe and FCM, so nothing is sent from the emulator.
- `phone-chrome.spec.js` got a retry on the first Toggle Panel tap after a CDP swipe. The page is shorter now, and Chrome's gesture layer drops that first synthetic tap depending only on page length under the fixed editor. It is the harness, not the button, and a toggle that never opens still fails.
- `dashboard-boot-budget-2026-10-03.test.js` reads over its ceiling locally on main as well (CRLF inflates it); this lane adds no dashboard bytes. Trust CI's number.
- The `cpo-` prefix is unique in `docs/pro` (grepped with no cap).

## Open for Jo

- Daylight check on the installed iPhone app: the action row's label contrast in sun, and whether the six buttons sit where the thumb lands.
- Decide whether Email should come back to the bottom bar for crews that email more than they note (it is currently in More).
