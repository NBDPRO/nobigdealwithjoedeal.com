# Add, change or retire a public credential

The public credentials page (`/credentials`), the strip on the homepage and
`/about`, and the credentials JSON-LD are all generated from one file:
`docs/assets/data/credentials.json`. Nothing else on the site should claim a
credential that is not a row there. Guard test:
`tests/credentials-2026-10-13.test.js`.

## Add a row

1. Confirm the credential with the issuer first (a listing page, a
   certificate, or an approval email). A hope is not a credential.
2. **Check the manufacturer's public-representation rules before the row goes `active`.** Some programs bar a tier from advertising membership or using program-branded marketing (IKO's Advantage tier, held 2026-10-13; see the research note from PR #2439). If the rules are unclear, get it in writing from the territory rep, keep the row `pending`, and keep the program's branded name and logo out of the data file and `docs/` entirely.
3. Append an object to `credentials[]`. Required for an `active` row:
   `id` (kebab-case, unique), `name`, `issuer`, `type`
   (`manufacturer` | `insurance` | `membership` | `supplier-material`),
   `status`, `summary` (one plain sentence on what it means for the customer,
   no outcome promises), `claimWording` (the exact approved phrase),
   `confirmedBy`, `confirmedAt` (YYYY-MM-DD), `order` (unique integer),
   `showInStrip` (true/false).
   Optional: `issuerShort`, `issuerUrl`, `contractorId`, `verifyUrl` (https),
   `since` (YYYY or YYYY-MM), `expires`, `badge` (repo-local `/assets/...png`
   plus `badgeAlt`), `warrantyVerified`.
4. `node scripts/build-credentials.mjs`. Commit the data file and every
   restamped page (no sitemap change: the URL already exists).
5. `node tests/credentials-2026-10-13.test.js` and
   `node scripts/build-credentials.mjs --check`.

## Rules the generator enforces

- **Only `status: "active"` ever renders.** Use `pending` while an application
  is open and `expired` when it lapses. Pending and expired rows are never
  shown on the page, the strip or the JSON-LD.
- **Honesty words are refused in any field:** Master Elite, President's Club,
  Licensed. We are GAF *Certified* and TAMKO *Pro Gold*; the insurance wording
  is "Fully insured", never "Licensed" (no state registration to back it).
  No carrier name, limits or policy numbers on the public site.
- **A warranty or rebate string needs `warrantyVerified: true`** on that row,
  set only after the program terms are read. Until then the row is text-only.
- **Unknown fields are refused.** The file is public. Never add a cost,
  margin or private-price key.
- **At most 3 rows with `showInStrip`.** Every strip chip links
  `/credentials#<id>` and, when `verifyUrl` exists, the issuer's own page.
- A `contractorId` is published only if the manufacturer already publishes it
  (GAF and TAMKO IDs are already in the footer disclosure).

## Logo-use rule

Show a manufacturer's mark only with its permission: a logo kit or a
contractor-portal download. No badge image means a text-only row; do not
recreate a logo. Re-encode the badge as an EXIF-stripped copy under
`docs/assets/<mfr>/` (`node scripts/check-image-privacy.js`).

## Renewal and expiry

Set `expires` when the issuer gives a date. The generator prints a WARN when
an `active` row is past its date; renew it or flip it to `expired` and
re-run. Re-confirm with the issuer and bump `confirmedAt` at each renewal.

## What to restamp

`node scripts/build-credentials.mjs` restamps `docs/credentials.html` (cards
and JSON-LD) and every page carrying a `<!-- CREDENTIALS-STRIP-START -->`
region. The strip's markup template is
`site-src/partials/credentials-strip.html`. To put the strip on another page,
drop an empty START/END marker pair where it belongs and run the generator;
do not hand-edit between the markers.

## JSON-LD note

Manufacturer rows become `EducationalOccupationalCredential` nodes
(`recognizedBy` = the issuer) hanging off the page's `CollectionPage`, which
points at the single business entity by `@id` (`/#org` lives only in
`site-src/partials/schema-entity.html`). Membership rows become
`ProgramMembership`. Insurance has no schema.org credential type and is
HTML-only. The site-wide `hasCredential` list inside `schema-entity.html` is
still hand-edited: when a new manufacturer row is added here, add it there
too.
