# Credentials page + strip - 2026-10-13

Jo approved a dedicated credentials page. Shipped on `feat/credentials-page`.

## What exists

- Data: `docs/assets/data/credentials.json` (4 active rows: GAF Certified,
  TAMKO Pro Gold, IKO ROOFPRO Advantage, Fully insured). The repo's
  `**/*credentials*.json` secrets ignore needed a one-file exception in
  `.gitignore`.
- Generator: `scripts/build-credentials.mjs` (`--check` is the drift gate;
  also validates the schema and the honesty rules).
- Page: `/credentials` (cards grouped Manufacturer certifications, Insured,
  Memberships and Materials we install when those have rows).
- Strip: generated from the data into the homepage trust row (replacing the
  hand-placed GAF/TAMKO badge row) and the `/about` hero (replacing the
  hand-typed "GAF Certified" and "Fully Insured" pills). The footer cert bar
  is deliberately untouched: it also carries the American Operator badge, which
  is not a credential row, and sits in 4 partials on ~275 pages.
- Wiring: sitemap CORE_PAGES row, `llms.txt` key-pages bullet, llms-full page
  list, a "Credentials" link in the footer-extended and footer-blog Company
  columns.
- Guard: `tests/credentials-2026-10-13.test.js` (fixture-driven; break-tested -
  see PR body).
- Runbook: [ADD-A-CREDENTIAL](../../runbooks/ADD-A-CREDENTIAL.md)

## Phone check (390x844, system Chrome, static server)

No horizontal overflow on `/credentials`, `/` or `/about`; every link inside
the new surfaces is >= 44 px tall; one H1 each. Screenshots (re-encoded PNG,
no EXIF) are in this folder.

## Open fields Jo owes (IKO)

The IKO row is live and text-only. Not claimed until supplied: exact program /
tier name (wording is marked pending), contractor ID and verify URL, which
warranty tiers it unlocks (then set `warrantyVerified`), logo kit.
Also: GAF "since" is the year only (2026); TAMKO's verify link is the generic
contractor locator (ID 181382 is searchable there).

## Choices worth knowing

- `/#org` already lists GAF/TAMKO/American Operator under `hasCredential`
  inside `schema-entity.html`. The page adds `@id`'d credential nodes on a
  `CollectionPage` rather than a second entity; IKO is not yet in the
  site-wide `hasCredential` list (add with its ID once Jo supplies it).
- The strip's wrapper is a `div role=group`, not `<nav>`: the marketing
  stylesheets style bare `nav` as the sticky site header.
