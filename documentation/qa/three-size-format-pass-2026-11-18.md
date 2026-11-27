# Three-size format pass: phone, PC, paper (2026-11-18)

Jo asked for every doc and template to be looked at at phone scale, PC size and paper print size. This is pass 1. Read-only: nothing here changed a customer-facing file. Related: [guide PDF rebuild](../../docs/guides/pdf/) (draft PR #3185) and the earlier [phone audit](phone-audit-2026-09-25.md).

## Done in pass 1

| Surface | Phone 390 | PC 1280 | Paper (Letter) | Result |
|---|---|---|---|---|
| 6 homeowner guide pages + guides index + /inspect | no sideways scroll (tables scroll inside their own box) | no overflow | not applicable | clean |
| 4 rebuilt guide PDFs (spot-checked photo sheet + storm guide) | not checked | not checked | Letter, clean, nothing clipped | clean |
| Customer estimate view (`docs/pro/estimate-view.html`, mocked data, 3 and 40 lines) | clean, no overflow | clean | 1 page for 3 lines; 40 lines flows to 3 pages, rows intact | clean |
| E-sign contract PDF (`functions/estimate-esign-pdf.js`, sample with 3 and 25 lines) | n/a | n/a | Letter; see findings | **findings** |

## Findings (e-sign contract PDF), for Jo to decide

1. **Not in the NBD Document Standard.** Plain Helvetica, grey and black: no navy/orange, no Montserrat/Lato, no section numbering. `CLAUDE.md` says the standard is mirrored in `functions/render-pdf.js`; this builder does not use it.
2. **Continuation pages have no running header, no page "X of Y", and the line-item table does not repeat its Description / Qty / Amount header.** On a 25-line estimate page 2 starts mid-table.
3. **Wasted space.** With 3 lines the price page is about 40 percent used, then the acceptance/signature block starts on page 2. Fine for signatures, but it lengthens paper copies.
4. Sample showed "50% deposit: 50%" (label and value repeat); check whether real `depositPlan` data does that.

A contract is legally sensitive, so no change was made; fixing 1 and 2 is a design decision for Jo.

## Not yet covered (next passes)

- Invoice (customer view, PDF, pay page, `invoice-success.html`)
- Customer portal (`portal.html`, has a print block) and `sign.html` / `esign.html` (no print CSS)
- Document generator template library (`document-generator-templates.js`, OH/KY) and server PDFs in `render-pdf.js`
- Real iPhone and a real printer (this pass used Chromium emulation and PDF rendering)

## Method

Playwright against a static server of `docs/`, with `getEstimateForView` mocked; PDFs rasterised with PyMuPDF. The e-sign PDF was built by calling `buildEstimateContractPdf` with sample data. A Playwright `page.pdf` call without margins puts text against the page edge, so margin-free output is not a finding.
