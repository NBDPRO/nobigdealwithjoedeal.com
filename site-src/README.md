# site-src/partials — shared chrome for the homeowner site

The homeowner pages under `docs/` are hand-maintained standalone HTML, because
`docs/` **is** the Firebase hosting root — what is committed is what ships.
That means every page has historically carried its own copy of the nav, footer
and chrome, and the only way to change one was a regex codemod across 200
files. 23 of the scripts in `scripts/` exist for exactly that, and each pass
left the cohort slightly more forked than it found it. The "— Goshen, OH"
footer that shipped to 139 pages was this failure mode.

This directory holds the single source of truth for that duplicated chrome.

## How it works

A page opts a block in by wrapping it in markers:

```html
<!-- nbd:partial footer-standard crumb_service_href="/services/roof-repair" crumb_service_name="Roof Repair" crumb_city_href="/areas/mason-oh" crumb_city_name="Mason" -->
  ...generated...
<!-- /nbd:partial footer-standard -->
```

`scripts/apply-partials.js` renders `site-src/partials/<name>.html` into every
region, substituting `{{key}}` from the marker's attributes.

```bash
node scripts/apply-partials.js            # restamp drifted regions in place
node scripts/apply-partials.js --check    # write nothing; exit 1 on drift
node scripts/apply-partials.js --check --diff
```

## The workflow

- **Change the chrome everywhere** → edit `site-src/partials/<name>.html`, run
  `node scripts/apply-partials.js`, commit the partial *and* every restamped page.
- **Change one page's values** → edit the attributes on that page's opening marker,
  then run the same command.
- **Never hand-edit inside a region.** It is generated; the next run overwrites it,
  and CI fails in the meantime. Page-specific content belongs outside the markers.

## Why per-page values live on the marker, not in a manifest

The location pages are authored by copying a sibling and renaming it. A
manifest keyed by path silently orphans its entry when that happens, whereas
marker attributes travel with the file. They are also greppable —
`grep -rl 'crumb_city="Mason"' docs/` answers "which pages claim Mason".

## Enforcement

`apply-partials.js --check` runs in two places, and the scheme is only real
because of them:

1. `ci.yml` → **Site integrity** job, on every PR.
2. `firebase-deploy.yml` → the pre-hosting gate, against the tree that actually
   ships. It is `--check` there on purpose: restamping at deploy time would
   publish content that is not in the repo.

The renderer also asserts structural contracts before stamping anything — a
`nav-*` partial must still contain `id="mainNav"` / `id="navLinks"` /
`id="hamburger"`, a footer must still contain `<footer>`. Those IDs are what
the runtime JS binds to, so losing one would ship pages whose controls are
silently dead rather than visibly broken.

## `schema-entity` — the one business, the one Joe (2026-09-27)

`schema-entity.html` is the ONLY place the business (`#org`, a
RoofingContractor), Joe (`#joe`, a Person) and the site (`#website`) are
defined in JSON-LD. It is stamped into the `<head>` of every public page;
every other JSON-LD node on the site refers to them by `{"@id": …}`
(`Service.provider`, `BlogPosting.author/publisher`, `WebPage.isPartOf`, …).

- **Change a business fact** (hours, phone, a credential, a new town in
  `areaServed`, the address locality) → edit `schema-entity.html`, run
  `node scripts/apply-partials.js`. The address is the single `"address"` line
  in that file: Campton, KY 41301, no street — the Google Business Profile's
  verified (hidden) address, the Kentucky LLC's legal address (Jo, 2026-09-27).
  It must match the GBP; if the GBP moves to the Goshen warehouse, change both
  together. `geo` is deliberately the Greater-Cincinnati service-area point,
  not the address.
- **Never** add a business or Joe node to a page's own JSON-LD, even a small
  one — that is a second, disconnected entity. `check-seo-surface.js` fails
  the build on it (`entity-business` / `entity-person`) and on a public page
  that lacks the region (`entity-partial`). Page-specific facts go on the
  page's own node: an area page carries a `Service` whose `areaServed` is its
  City and whose `provider` is `{"@id": "https://nobigdealwithjoedeal.com/#org"}`.
- New area page → add its town to `areaServed` here; `tests/seo-surface.test.js`
  (E7) fails until you do.
- The one-time move onto this shape is `scripts/migrate-schema-entity.mjs`
  (idempotent; also how a pending page is finished — see its header).

## Line endings

The pages are **CRLF**. The renderer works in LF internally and re-emits with
each file's own ending. Do not "fix" this: stamping LF into a CRLF file
rewrites every line of the region and turns every future diff into noise.

## Coverage

Partial coverage is a supported state — the gate only governs regions that
exist, so an unconverted page is a coverage gap, not a failure.

| Partial | Pages | Notes |
|---|---|---|
| `footer-standard` | 107 | service+city and the pages sharing that exact footer |
| `footer-blog` | 24 | 23 posts + blog/index; no per-page values (zero placeholders) |

Not yet converted (each needs its own variant, sizes cluster tightly so each is
a small job): **26 area** pages, **28 service** hub/plain pages, 5 root pages,
`the-pledge`. (`sites/free-guide` is contractor-facing and deliberately never
gets a homeowner partial — removed from this list 2026-09-13.)
