# CRM phone audit: speed and friction on the installed app (2026-10-07)

Audit only, no product change. This walks the CRM screens Jo uses every day, at 390×844 with the installed-app (`display-mode: standalone`) rules forced, and at 1440×900 for comparison. It judges "what slows Jo down on a roof": taps, seconds, thumb reach, scrolling, the keyboard, contrast in sun, and load time. Looks are covered by the [10-05 CRM visual audit](../../audit/CRM-VISUAL-AUDIT-2026-10-05.md). The homeowner pages are covered by tonight's [money-path audit](../homeowner-money-path-2026-10-07/README.md).

- The full report lives outside the repo at `C:\Users\jonat\nbd-content\crm-phone-audit-2026-10-07.md`. It has the top 10 with screenshots and file:line, the per-task tap table and the fix batches.
- The screenshots and per-screen measurements are in `C:\Users\jonat\nbd-content\crm-phone-audit-2026-10-07\` (`p\`, `d\`, `_data\`). The seeded data is fake, but the shots stay out of the public repo anyway.

## How it was walked (reusable recipe)

- **Harness:** saved in `C:\Users\jonat\nbd-content\crm-phone-audit-2026-10-07\_harness\`. To rerun:
  1. Copy the folder to `tests/zzpa/` in a worktree.
  2. Start the emulators: `npx firebase emulators:start --only auth,firestore,storage,hosting` from `tests/`, with the proxy variables unset.
  3. Run `bash zzpa/reset.sh`, then `node zzpa/walk.js phone|desk`.
  4. Delete `tests/zzpa/` before you commit.
- **No functions emulator.** Playwright answers every callable with a stub and logs it. Twilio, Resend, Stripe, FCM and the AI vendors are aborted. In this walk they were hit 0 times, and nothing was sent.
- **Seed:** a production-shaped NBD tenant (NBD platform uid). It holds 14 leads across 13 stages, tasks, appointments, calls that still need a callback, a past-due invoice, a signed deal room, two Kentucky insurance jobs and knocks.
- **Three seed-shape traps,** so the next walker doesn't log them as bugs (the [2026-09-27 sweep](../crm-intense-sweep-2026-09-27/BUG-LOG.md) hit the same kind of trap):
  - A task needs `companyId`. The single collection-group task load filters on it; without it every lead reads "no next step".
  - A missed call is `status:'short'` + `direction:'inbound'`, not `direction:'missed'`.
  - A deal room's `createdAt` is an ISO string, and its value is read from `acceptedPrice`. Without both you get "NaNd ago" and $0.
- **Timing:** taps are counted by the harness, and a native `confirm()` counts as a tap. The keyboard line assumes the iOS keyboard covers y > 508 at 844. Load times are measured on localhost, so treat them as the best case.

## Top 10 (frequency × time lost)

| # | Finding | Where | Effort |
|---|---|---|---|
| 1 | The customer page is 15 phone screens (17 on a KY insurance job): note box 4.9 screens down, Build Estimate 4.7, insurance panel 4.0, Record payment 12.3. 21 document tiles (about 2.6 screens) sit before the invoices. | `docs/pro/customer.html:1814-2066`, `:2212-2340`, `:2376` | M |
| 2 | **Record payment:** Home "Money to collect → Open" lands at the top of the page, 12 screens from the button. The sheet itself is **see-through**: `.modal` has no styles on customer.html, so the card has no background and no padding, and Save renders navy. Save also sits under the keyboard. | `docs/pro/js/today-home.js:201`; `docs/pro/js/invoice-pipeline.js:3765` (+`:2996`, `:3127`, `:3377`) vs `customer.html:836` | XS + S |
| 3 | **D2D knock:** Save is static, 2.2 screens down the sheet. The door-number confirm only appears after Save fails, at the top of the sheet. A Not Home takes 8 taps and 4 swipes. | `docs/pro/js/d2d-tracker-ui-2026b.js:305`, `:385`, `:636-650` | S |
| 4 | **Voice note:** 6–7 taps, ending in a lead picker that doesn't preselect the open customer. The header 🎤 is Presentation mode, not voice. The bottom bar offers EMAIL, not NOTE. | `docs/pro/js/quick-capture.js:480`; `customer.html:1597`; `docs/pro/js/customer-quick-action-bar.js:198` | S |
| 5 | **Estimate from a lead:** a full page hop to the dashboard (2.2–3.1 s on localhost), 10 steps and at least 13 taps. The preset is asked twice. Closing the wizard leaves Jo on the dashboard, not the lead. | `docs/pro/js/customer-tasks-ui.js:2549` | S / L |
| 6 | **Home** is 5.5 screens. The "people need you" pill sits 2.2 screens down. The "No next step" list repeats each lead with six buttons. | `docs/pro/js/today-home.js:214`, `docs/pro/js/no-next-step.js:224` | S |
| 7 | Calls, Schedule, Close Board and D2D all live in a 32-item More drawer, while the bottom-bar slot goes to Ask Joe. | `docs/pro/dashboard.html` `#mobile-more-menu` | S |
| 8 | **Taps under 44px:** 40 on the customer page alone (jump tabs 38px at 11px type, timeline pills 25px, checklist boxes 16px, Add Task 29px). On Schedule, the back and open-lead links are 12px tall. Bottom-nav labels are 8.5px. | per-screen JSON in `_data\` | S |
| 9 | **Contrast in sun** on the customer page and D2D, which the reskin hasn't reached: orange panel titles 2.84:1, "Today" label 1.60:1, D2D gold 2.03:1. The default theme is dark, and Daylight is buried in Settings. | | S–M |
| 10 | Every stage move asks a confirm (2 taps for 1). A fresh device opens the CRM on the Insurance tab, showing 2 of 14 leads. | `docs/pro/js/customer-bootstrap.module.js:2453-2467`; `docs/pro/js/dashboard-bootstrap.module.js:129` | XS |

No open PR covered any of these when this was written (#2302–#2306 are wording and money math).

**Slowest daily task:** recording a payment from Home. It takes 12 screens of scrolling, a sheet you can't read in sun, and a Save hidden by the keyboard. On D2D days the knock log costs the most time in total.

## Quick wins (XS)

1. Style `.modal` on customer.html, or render the four invoice-pipeline sheets as `.modal-content`.
2. On money rows, Home "Open" → `&pay=1`, which opens Record payment directly.
3. The CRM default tab: `'insurance'` → `'simple'`.
4. On the customer bottom bar: EMAIL → NOTE.
5. Give Presentation mode a non-mic icon.
6. Make the knock Save footer sticky.
7. Raise the 12px Schedule links and the 25px pills to 44px.
8. Preselect the open customer in the Quick Capture picker.

## Not walked

- Real iOS WebKit and the real keyboard (Chromium with standalone rules forced).
- GPS-prefilled, verified knock addresses (geocoder stubbed).
- The voice-note AI summary (callables stubbed).
- Live calendar integrations and push.
- Load times on LTE.

## Checked and fine

- No sideways scroll on any walked screen at 390.
- The Today card buttons, the wizard Next/Send, the Call Center buttons and the bottom CALL/TEXT bar are all ≥44px and in the thumb zone.
- The Close Board shows a just-sent deal with its link and the right price.
- No page errors.
