# Live supplier pricing, slice 9: read supplier PDFs and photos (2026-11-18)

Status: **built on branch `claude/supplier-pricing-slice-9-2026-11-18`, ships dark
behind `supplierPricing`.** PR 3 of the plan Jo confirmed on 2026-11-18; stacked on
the line-links PR. This note carries no cost, price or account number.

- Lane note: [LIVE-SUPPLIER-PRICING-2026-11-17](LIVE-SUPPLIER-PRICING-2026-11-17.md) (the plan, "Update 2026-11-18 (later)")
- Line links: [LIVE-SUPPLIER-PRICING-LINE-LINKS-2026-11-18](LIVE-SUPPLIER-PRICING-LINE-LINKS-2026-11-18.md)
- Design: [LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17](LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md) (section 8, slice 9)

## Jo's decisions (2026-11-18, grilling round)

PDFs first, photos second (both built here: PDF, JPG, PNG, WebP; not HEIC); owner
and admins only; the reader pre-fills the kind, date, good-through and tax, never a
number that is not on the document; the lines land on the Import prices preview and
nothing saves without an OK; the original is kept privately and linked to its rows;
"Remove this document" voids its rows and deletes the file; AI reading capped at $10
a month per company, adjustable; originals erased with a solo owner's account.

## What Jo sees (flag on)

Import prices has a second file box, "Or read a PDF or photo". Pick the supplier,
pick the file: about half a minute later the setup is filled in from the document
(kind, date, good-through, tax included or not, document number), with a note to
check each, the supplier name the document prints, anything the reader found unclear
and this month's reading spend against the limit. Preview and Save work exactly as for
a CSV. Below the form, "Documents read" lists each document with Open (the original,
through a private link) and "Remove this document". Company Settings, Supplier Price
Compare, has a third box: the monthly limit for reading documents (blank is $10).

## What was built

| Piece | Where |
|---|---|
| `priceDocRead` callable: owner / company_admin, the flag, a local role check, the AI kill switch, the paid-plan gate; a PDF or photo up to 7 MB; the same file answered from its first read for free; the cap reserved before the reader is paid and settled after; the original stored at `price-docs/{companyId}/{docId}.{ext}`; the read kept at `priceBook/{companyId}/priceDocs/{docId}`. Haiku 4.5 | `functions/price-doc-read.js`, `functions/index.js` |
| The prompt (untrusted data, no tools, transcribe only, never compute), the field-by-field sanitizer, the cap, the file decode | `functions/price-doc-logic.js` |
| Rows carry the document id (`doc.importId`, kept on `csv_import` only) | `price-logic.js` SHARED (`buildImport`, `sanitizeObservation`), `price-ledger-store.js` |
| `removeDocument` save op: voids the document's rows, recomputes their offers, deletes the original, marks it removed, audited | `functions/price-ledger-store.js` |
| Rules: `priceDocs` read by owner / company_admin; Storage `price-docs/{companyId}/…` read by owner / company_admin, written by nobody | `firestore.rules`, `storage.rules` |
| Erasure: `price-docs` joins the company-keyed Storage prefixes | `functions/integrations/user-owned.js` |
| The screen: the PDF/photo box, pre-filled setup, the documents list, Open, Remove | `docs/pro/js/price-import.js`, `docs/pro/js/price-ledger.js` |
| The monthly limit box | `docs/pro/dashboard.html`, `docs/pro/js/dashboard-bootstrap.module.js` |

## Tests

- New `tests/price-import-doc-read-2026-11.test.js` (28): the prompt and request (no
  tools, one fixed instruction), the sanitizer (only listed keys, prices as printed
  text, bad dates and prices null, 300 lines), the cap, the callable with fakes (read,
  record, private original, meter settled, spend logged, same file free, bad file and
  over 7 MB refused before paying, the kill switch, the local gate refusing a manager,
  a hard stop at the cap, a refused call not billed, a network failure keeping the
  reservation, an unreadable reply), rows carrying the document id, and Remove.
- Extended: the Firestore rules suite (section 13, 357/357 on the emulator), the
  Storage rules suite (price-docs, 67/67), the erasure suite, `viewer-callables`
  (a viewer is refused before anything is read).
- Driven in a local harness page at 375 px with a stubbed reader: pick a PDF, the
  pre-filled setup, Preview, Save (rows carry the document id), the documents list,
  Remove. No sideways scroll.

## Not done

- **Nobody has read a real document.** The reader has only run against a fake here;
  its first real run is Jo's, on one supplier quote.
- A new callable: after the deploy, check that `priceDocRead` exists (the design's
  R10: a new callable can be dropped on its first deploy).
- The dashboard boot script budget is at its ceiling after the limit box (2611 of
  2611 KB shipped).
- ~~HEIC photos (the iPhone default) are refused~~. Fixed 2026-11-18 (Jo: "Yes, convert them"): an iPhone HEIC or HEIF photo is converted to JPEG on the server (heic-convert, as the receipt inbox) before it is read and stored; priceDocRead now has 1GiB for the decode.
