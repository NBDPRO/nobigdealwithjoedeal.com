# Warranty certificate accent colour — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06 (harness and findings index:
[CRM-AUDIT-HARNESS-2026-11-06](CRM-AUDIT-HARNESS-2026-11-06.md)).
Test: `tests/warranty-accent-2026-11-06.test.js`. It passes 6/6 on this branch, and 2 checks fail
against main's code.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| ED-F20 (colours) | `warranty-cert.js` certificate `<style>` | Every company's warranty certificate used NBD's orange (`#BD5728`) for the brand accents: header rule, brand mark, sub-label, guarantee box edge and title, feature dots and seal. | The accent comes from the tenant brand (`_b.colors.accent`, accepted only as a hex colour, else the default). For NBD the helpers return the exact old literals, so its certificate is byte-identical; the test compares it to main. |

Not changed:
- **Warranty wording.** The text is not touched.
- **Tier badge colours.** They mean the tier, not the brand.

Still open from ED-F20:
- The certificate shows no tenant logo.
- `photo-report.js` shows NBD's logo for NBD and never the tenant's.
- The invoice email hard-codes the accent and falls back to the NBD name.

Each is a layout change, so they get their own PR.
