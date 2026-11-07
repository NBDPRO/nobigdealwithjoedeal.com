# Beyond as a labelled fourth option on the public site (2026-11-06)

Decided with Jo in a grilling session, 2026-11-06 (every recommended answer accepted):

- The public site keeps **Standard / Preferred / Elite** as "the three tiers". **Beyond** (CRM-only until now) is
  added as a clearly labelled **fourth option for hail-prone roofs**, not a renumbering of the whole site.
- Beyond = **TAMKO HailGuard only**, NBD's own written labor warranty up to **20 years** (Elite's term; CRM
  `TIER_LABOR_YEARS.beyond = 20`, Jo 2026-10-06). The hail warranty is **TAMKO's**, a separate document; no years are quoted.
- Price on the cost blog only: **$985-$1,100 per square**, the CRM beyond rate $880 x the 1.12-1.25 pitch factor,
  the same method as the three core tiers ($615-$690, $740-$825, $860-$965). The guarantee page keeps its policy of
  not printing exact prices and links to the blog.
- **Economy stays CRM-only**; `roof-replacement` gets only the neutral line "Tighter budget? Ask Joe about options."
- Five places changed: the guarantee page (callout `#beyond` + visible FAQ + FAQPage JSON-LD + the HailGuard lane card's
  label), the TAMKO impact-resistant shingles page (one sentence), the cost blog (one price bullet, "three core tiers"),
  `roof-replacement` (one paragraph), `llms.txt`.

Claim check (two read-only agents, before Jo saw it): wording attributes "the first asphalt shingle system backed by a
written hail warranty" to TAMKO, says who gives which warranty, quotes no hail-warranty years (TAMKO's own page and the
repo's TAMKO page may disagree on them; Jo must verify), and promises no insurance outcome. Left alone, not part of this
change, for Jo: `tamko-impact-resistant-shingles` still says "If you've already had one hail claim and never want to file
another, this is the shingle" (reads like a claims promise) and carries the unattributed "first ... hail warranty" wording
on several lines. Beyond's $985-$1,100 band is extrapolated from the documented method
([PRICE-EVIDENCE-SITE-VS-CRM-2026-10-16](../projects/PRICE-EVIDENCE-SITE-VS-CRM-2026-10-16.md) covers only 550/660/770).

Related: the CRM tiers are in `docs/pro/js/estimate-config.js`; see also [UI sweep](UI-SWEEP-2026-10-24.md).
