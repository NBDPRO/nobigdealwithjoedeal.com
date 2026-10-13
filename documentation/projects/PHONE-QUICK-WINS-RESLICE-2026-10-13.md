# Phone quick wins: Record payment one tap from Home (re-slice of #2316, 2026-10-13)

[PR #2316](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2316) (phone audit [2026-10-07](../qa/crm-phone-audit-2026-10-07/README.md), items 2, 4, 8-10) was about 500 commits stale. This note records what was re-applied on a fresh branch off main and what was left alone.

## Re-applied (still missing on main, verified by grep before porting)

- **Home > Money to collect > "Record payment"** links to `customer.html?id=<lead>&pay=<invoice>`. New `docs/pro/js/customer-pay-link.js` opens the page's own sheet (`NBDCustomerInvoices.recordPayment`) after load, strips `&pay` from the address bar first, picks the invoice in the sheet, and backs out to Invoices & Payments if the owed invoice belongs to another job. Viewers get the plain link. No new write path.
- **Solid sheet:** `invoice-pipeline.js` builds `<div class="modal-bg"><div class="modal">`, and `.modal` was styled only in `dashboard-app.css`, which customer.html does not load. customer.html now styles `.modal-bg > .modal`.
- **Reachable Save:** `.ipx-btn-save.btn-green` is solid green and sticky to the bottom of the sheet's scroll. `docs/pro/js/keyboard-viewport.js` sets `html.nbd-kb-open` + `--nbd-vv-h/--nbd-vv-top` from `visualViewport` while the keyboard is up, and `mobile-polish.css` section 7 fits any open sheet to the visible area.

## Not re-applied (left on #2316, still wanted, separate slice)

- CRM opens on All when no view is saved (`DEFAULT_KANBAN_VIEW`), Presentation icon, Quick Capture "Save to <customer>", Schedule 44px targets. Verified still absent on main on 2026-10-13: none of them is covered by [#2368](CUSTOMER-PHONE-ORDER-2026-10-12.md) or the layouts work. They were cut to keep this slice to the payment path, not because they are done.

## Proof

- `tests/phone-quick-wins-2026-10-08.test.js` (36 checks, node bucket). Break-test: reverting mobile-polish.css reddens the two keyboard-fit checks; invoice-pipeline.css the three Save checks; customer.html the three page-wiring checks; reverting today-home.js reddens the link/label checks; removing the two new JS files makes the run crash (a missing module fails the run too).
- `tests/e2e/phone-quick-wins.spec.js` (@shard2): seeds an owed invoice, one tap from Home, solid card, Save above a 508px viewport, $1,000 Zelle lands on that invoice as `partial|1000|3321|1`, no send calls. Not run locally in this session (needs the emulator rig); CI runs it.
- Not walked: real iOS WebKit and the real on-screen keyboard (simulated by shrinking the viewport). Worth a check on Jo's iPhone.

## Gotcha

A `git apply --3way` of a stale PR conflicts on hand-edited lines every PR touches (script tag list in dashboard.html, `authed-specs.txt`, the boot-budget ceiling, the inline-style ratchet). Take main's version of those files and re-add the one line with an EOL-aware script rather than resolving markers.
