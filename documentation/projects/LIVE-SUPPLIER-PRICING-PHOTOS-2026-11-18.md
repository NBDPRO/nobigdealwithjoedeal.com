# Live supplier pricing: product photos (2026-11-18)

Status: **built on branch `claude/supplier-pricing-photos-2026-11-18`, ships dark
behind `supplierPricing`.** The photo half of the design's slice 4, moved to its
own slice by Jo (slice 4 plan, Q7). This note carries no cost, price or account
number.

- Lane note: [LIVE-SUPPLIER-PRICING-2026-11-17](LIVE-SUPPLIER-PRICING-2026-11-17.md)
- Design: [LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17](LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md) (section 4.5)
- Slice 4: [LIVE-SUPPLIER-PRICING-SLICE-4-2026-11-17](LIVE-SUPPLIER-PRICING-SLICE-4-2026-11-17.md)

## Jo's decision (2026-11-18, in chat)

The owner and company admins add photos, on a product's Stores & prices sheet
and on each supplier item. They show on the product card and the sheet. Reps see
them and can not change them. Inside the CRM only, never on a customer document.

## What was built

| Piece | Where |
|---|---|
| `savePhoto` op on `priceLedgerSave` (add, replace, remove; its own limit, 20 an hour per person; the function now has 512MiB for sharp) | `functions/price-ledger-store.js`, `functions/price-ledger.js` |
| Re-encode: the shared `photo-reencode.js` (proves it is an image, drops EXIF and GPS), WebP, at most 640 px | `functions/photo-reencode.js` (unchanged) |
| Where it lives: Storage `product-photos/{companyId}/{productId or offerId}/{sha}.webp`; the pointer on `productLinks/{productId}.photo` (never the product row) or on the offer's `photo` | |
| Storage rule: the company's owner, admins, managers and reps read; a viewer, an access-code member, another company and the platform admin read nothing; nobody writes but the server | `storage.rules`, `tests/storage-rules.product-photos.test.js` (48/48 on the emulator; own CI step) |
| Erasure: a solo owner's erasure deletes `product-photos/{companyId}/` with the price ledger tree | `functions/integrations/user-owned.js` (`COMPANY_KEYED_STORAGE_PREFIXES`), `compliance.js` |
| Screens: Add a photo / Change photo / Remove photo on the sheet (product and each item); a thumbnail on the product card; read with `getBlob` into a `blob:` URL, never a download link | `docs/pro/js/price-ledger.js`, `price-offers-ui.js`, `product-library.js`, `docs/pro/css/price-ledger.css` |

The hand-off case the design flagged is pinned by the storage suite: a removed
former owner whose claims were stripped still reads the photos (Storage rules
here read claims only). Accepted as the design wrote it: product pictures with
no price; the Firestore side, where the prices are, refuses that person.

## Tests

- New: `tests/price-ledger-photos-2026-11.test.js` (the op against an in-memory
  Firestore and Storage: where it is saved, replaced and removed files deleted,
  approval markers kept, every refusal writes nothing, audit rows, and no public
  page or customer-document file names the path), `tests/storage-rules.product-photos.test.js`.
- Extended: `tests/r4-erasure-export-honesty-2026-10-06.test.js` (the photos go
  with a solo owner's erasure).

## Not done

- Nobody has added a photo in the real dashboard. The controls were checked in a
  local harness page at 375 px (stubbed data and picture): no sideways scroll.
- The sharp re-encode itself ran only in its own existing tests, not against a
  real upload here.
