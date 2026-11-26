# GSC content merges (2026-11-26)

Jo approved three content merges on 2026-11-26 from the Search Console data
below ("Yes, do the merges"). One draft PR, a 301 for every removed URL, no
unique content dropped. Linked from [INDEX](../INDEX.md).

## The data

Search Console, `https://` URL-prefix property. Only **Sep 26 - Nov 24 2026**
exists in the property, so this is about 2 months of data.

- 238 pages had impressions; 183 clicks in total.
- **hail-damage-&lt;town&gt;** (26 town pages): 15 of 26 appeared at all, **65
  impressions, 0 clicks**.
- **storm-damage-&lt;town&gt;** (their twins): 16 pages, **487 impressions, 0 clicks**.
- **Financing**: `how-roof-financing-actually-works` 5 impressions;
  `roof-financing-cincinnati-explained` 158.
- **Class 4**: `is-the-class-4-upgrade-worth-it` 27 impressions at position
  12.1; `why-class-4-impact-shingles` 23 at position 8.9. Both 0 clicks.

## Decisions (Jo, 2026-11-26)

1. **Merge hail into storm**, town by town. The storm page survives (more
   impressions), retitled "Hail & Storm Damage Roof Repair in &lt;Town&gt;".
2. **Merge the financing posts** into `roof-financing-cincinnati-explained`.
3. **Merge the Class 4 posts** into `why-class-4-impact-shingles` (better
   position, older), keeping the Lexington 12% story as a section.
4. **Keep** all the GAF vs TAMKO posts (top traffic).
5. **Keep** the homepage and `/areas/cincinnati-oh` as they are.
6. **Keep** the 8 "&lt;Town&gt; Roofer" titles. Fort Mitchell, Indian Hill, Amelia
   and Mt Orab rank at positions 9.7-13, against 14-28 for the other towns.
7. **Hold** any other service-by-city pruning until about 6 months of data
   (around late March 2027).

## What was done

### 1. Hail into storm (26 towns)

`scripts/merge-hail-into-storm-2026-11-26.js` (dry run by default; ran once
with `--write`). For each town it:

- copies the hail page's local section (the "Hail Damage Inspection in
  &lt;Town&gt;" box and the paragraphs under it) **verbatim** into the storm page,
  right after the storm page's own local section;
- adds the hail **hero paragraph** to that section (most towns' NOAA hail facts
  live there), and the hail-only topic sections: "Hail Damage on Older Anderson
  Township Homes" and "Hail Damage in Blue Ash — What Gets Missed";
- adds the hail "What's included" bullets the storm list doesn't already say
  (see the skipped list below);
- adds the hail FAQs the storm page lacks to **both** the visible FAQ and the
  FAQPage JSON-LD, copying each answer verbatim (4 per town; 8 for Batavia,
  Cincinnati, Loveland, Mason and West Chester, which had already absorbed the
  2026-08-02 claim pages). `faq-schema-sync` passes;
- retitles the storm page: title, H1, og/twitter title, WebPage name and
  serviceType now read "Hail & Storm Damage Roof Repair"; dateModified and
  "Last updated" are 2026-11-26;
- drops the storm page's own "Hail Damage in &lt;Town&gt;" card (it would link to
  itself); then deletes the hail page.

`scripts/repoint-hail-town-links-2026-11-26.js` then rewrote every internal
link: 98 "Hail Damage in &lt;Town&gt;" cards on area and sibling service pages were
dropped because the same page already links that town's storm page; the 26
city pills and one intro link on the `/services/hail-damage-insurance-claim`
hub now point at the storm pages ("Hail & Storm Damage Repair — &lt;Town&gt;").

`scripts/add-location-interlinks.js` no longer has a `hail-damage` family, so
a re-run cannot bring the hail town links back. The hub
`hail-damage-insurance-claim` family stays.

**firebase.json**: 26 new 301s `/services/hail-damage-<town>*` →
`/services/storm-damage-<town>`. The five 2026-08-02 redirects
(`hail-damage-insurance-claim-<city>-oh*`) now go straight to storm, so there
are no chains. The hub `/services/hail-damage-insurance-claim` is not
redirected; every source has a `-<town>` suffix.

**Measured.** Plain-text lines over 40 characters in each old hail page and not
in its old storm twin: 1,011 counting head, JSON-LD and CSS (Jo's 597 counted
visible text only). After the merge, every remaining one falls into these groups:

- page furniture that belongs to the deleted URL: title, meta, schema,
  breadcrumb, CSS, the hail nearby-cities cards, the hail CTA headings ("Hail
  Hit Covington?", "Ready for a Free Hail Damage Inspection in ...?") and their
  one-line subtext;
- hail bullets the storm list already says in other words (not added, to avoid
  saying the same thing twice in one list): "Supplement (my updated estimate)
  ..." (7 towns, the storm page has its own supplement line), "Photo
  documentation and a line-item estimate for your claim" (6), "Documentation
  formatted for insurance adjusters" (6), "Full replacement or repair with
  matched materials" and its variants (11), "Free hail damage inspection —
  roof, gutters, siding, soft metal" and variants (6), "Photo documentation for
  your claim + adjuster meeting on site" (2), "Soft-metal surface documentation
  — gutters, vents, AC covers, window frames" (Blue Ash; its "What Gets Missed"
  section covers soft metal in full), "Free hail damage inspection — all roof
  planes, including hillside exposures" (Fort Mitchell; hillside roofs are in
  the hero paragraph that moved), "Full repair or replacement — Ohio building
  code compliant", "Damage documentation and an adjuster meeting (you file and
  own the claim)", "Complete documentation package for Kentucky insurance
  adjuster" (Florence), "Adjuster meeting — I walk the property with your
  adjuster" (Fairfield).

### 2. Financing

`how-roof-financing-actually-works` → `roof-financing-cincinnati-explained`.
Moved in verbatim, Joe's voice, no new claims: "First, What I Am and What I'm
Not" (with its "one-sentence version" callout), "The Soft Pull vs. Hard Pull
Thing, In Plain English" and "Why the Rate on the Ad Is Never 'Your' Rate"
(after the monthly-payment section), "When Financing Makes Sense" (after the
deductible combo), "When I'll Tell You Not to Finance" and
"What Actually Happens, Step by Step" (before the FAQ), and the Acorn Finance
marketplace disclaimer (above the author box). The survivor's "I broke down the
mechanics ... in How Roof Financing Actually Works" sentence now points down
the page (`#soft-vs-hard`). Its related card to the merged post now goes to the
free guide `/guides/roof-financing-explained` ("Paying for a Roof,
Explained"). dateModified 2026-11-26, 7 → 10 min read. So every section of
the merged post is now on the survivor (Jo, 2026-11-26: "Add the two financing
sections too"); some points now appear twice in different words (the deductible
gap, the roof that won't wait).

### 3. Class 4

`is-the-class-4-upgrade-worth-it` → `why-class-4-impact-shingles`. The whole
Lexington reader story goes in verbatim as a section, "The Same Question — A
12% Answer." (`#lexington-12-percent`), before the FAQ. Its own h2s are h3s
under it, and its "Running This Math on Your Own Roof?" text-Joe box and closing
paragraph come along. Its four FAQs were added to the visible FAQ and the
FAQPage JSON-LD. Its story-specific disclosure (the 12% is one homeowner's
agent quote, unseen paperwork, the trademark lines) is a second paragraph in
the disclosure box. Two links that pointed at the survivor now point inside it
(`#premium-discount`, `#claim-discount`). dateModified 2026-11-26, ~7 → ~13 min
read. The six Lexington-area town pages, the TAMKO impact page and
`why-wont-roofing-suppliers-sell-to-homeowners` link
`/blog/why-class-4-impact-shingles#lexington-12-percent`. The Class 4 related
cards that would have doubled up now go to the GAF vs TAMKO comparison post.

Both blog 301s are in `firebase.json`. The POSTS array
(`docs/assets/js/inline/c00f1acac9.js`) lost both entries; the blog index,
`feed.xml` and the `llms.txt` regions were regenerated by their scripts; the
sitemap lost 28 URLs (`build-sitemap.js --write --keep-lastmod`).

## Tests retargeted (same assertions, survivor pages)

- `public-insurance-wording-2026-10-16`: Covington KRS 367.626 wording and the
  Florence neighbor FAQ (visible + JSON-LD) now read the storm pages.
- `town-cta-seo-2026-11-17`: Mt Orab and Clarksville FAQ wording on the storm
  pages; section 4 now asserts no hail town page is left and every storm twin
  carries the new title; the Lexington cal.com set is 8 pages.
- `homeowner-claims-honesty-2026-10-05`: Mason neutral line on the storm page;
  the Pledge-meta list uses storm Maineville; the neutral-line floor is 18 files
  (one file per town now carries both).
- `ky-claims-wording-scan` (floor 35 → 30: five KY hail pages merged),
  `oh-claims-wording-scan`: must-include lists name the storm pages.
- `homeowner-guides-2026-10-16`, `marketing-polish-contract`,
  `site-legal-crosscheck-2026-10-16`: the financing post's slot goes to the
  survivor; the 320 px list drops the two merged posts (14 → 12).

## Follow-ups (not done here)

- **Not a bug, checked 2026-11-26:** the GeoCoordinates (39.2, -84.15) on the
  area pages are the business's own `#org` point (Goshen, OH). They come from the
  `schema-entity` partial and sit on all 274 pages; area pages carry no
  city-level geo of their own. The trap is step 1 of
  `scripts/add-location-interlinks.js`. It was written when the area pages had
  their own placeholder geo, and it now matches the org block, so a rerun
  rewrites the business's location to each town's point inside a
  generator-owned `nbd:partial` region. That restamp was reverted here. Don't
  "fix" those coordinates, and treat step 1 as stale before rerunning the script.
  Adding real per-town geo (e.g. an `areaServed` Place) would be a new feature.
- Many blog pages carry a CSS comment "copied verbatim from
  /blog/how-roof-financing-actually-works.html". The file is gone; the comments
  are history and harmless.
- Older notes in `documentation/` still name the hail town URLs; they are dated
  records and were left as they are.
- Re-read Search Console around late March 2027 (decision 7).

## Sibling PRs

#3277 (claim-wording sweep) edits `hail-damage-covington-ky.html` and other
hail pages; whichever lands second re-runs its sweep on the moved text (it now
lives in the storm pages). #3284 (town proof) restamps the OURWORK blocks on
service-by-city pages including the deleted hail pages; resolve those conflicts
in favour of the deletion and re-run `build-projects.mjs`.
