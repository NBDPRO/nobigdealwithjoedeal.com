# Price evidence: site per-square ranges vs CRM rates (2026-10-16)

Review Queue item "Prices don't match". Joe (2026-10-16): "CRM is closer, I
think, but check what the site's Our Work / won jobs show to back it up."

**Result: no price change made. The two sets of numbers are the same prices
in two different units, and the 2026 jobs fit both.** Joe decides whether the
public site should show the CRM's per-square rate instead (option B below).

## 1. The two numbers

| Package | CRM `TIER_RATES` ($ per CRM square) | Public site ($ per square, installed) |
|---|---|---|
| Standard | 550 | 615–690 |
| Preferred | 660 | 740–825 |
| Elite | 770 | 860–965 |

Sources: `docs/pro/js/estimate-config.js` `TIER_RATES` (repriced 2026-10-02;
545 / 595 / 660 before that). The site ranges come from the public /estimate
tool's `PRICING.roof.asphalt` (`docs/assets/js/inline/4053149b2f.js`), which
says they are the CRM rate × the CRM's pitch waste factor, 1.12 (low slope) to
1.25 (steep): 550×1.12 = 616 … 550×1.25 = 688 → $615–690, and the same for the
other two. The vault note *Packages & Warranties* records the same rule (Joe,
2026-10-15).

So the site's number is per square of **roof area**. The CRM's is per square
**billed**: roof area plus 12–25% waste for pitch and cuts
(`estimate-builder-v2.js` `wasteFactorForPitch`: 1.12 / 1.15 / 1.17 / 1.20 /
1.25). The /estimate tool measures the roof area from the address, so it has
to use the waste-included rate, or every ballpark would come in 12–25% low.

## 2. What the 2026 jobs show (Our Work, `docs/assets/data/projects.json`)

Only two 2026 replacements on the site state a square count:

| Job (2026) | Squares stated | Pitch | Published price | Per stated square | Per roof-area square (stated ÷ waste) |
|---|---|---|---|---|---|
| "Forty-Five Squares, Two Days" | 45 | 8/12 (waste 1.17) | $24,500–$25,500 | $544–$567 | about $637–$663 |
| "Ten-Twelve Pitch, Plank Decking" (Timberline HDZ) | 14 | 10/12 (waste 1.20) | $9,500–$10,500 | $679–$750 (includes the steep charge and plank-deck work) | about $814–$900 |

- The 45-square job's low price is exactly 45 × $545, the Standard rate in
  force before 2026-10-02. That points to the stated squares being the CRM's
  billed squares, priced at the CRM rate.
- Per roof-area square, the same job sits inside the site's Standard range
  ($615–690). The HDZ job sits above the Preferred range, which fits its
  steep-roof and decking add-ons.

## 3. CRM estimates (read-only aggregate, prod, 2026)

A read-only count of NBD's 2026 estimates (`estimates`, NBD tenant, not
deleted, created 2026) found **2** with a square count, both tier "best".
Neither is signed.
- 15.35 SQ, a line-item V2 estimate at $1,176 per SQ. It carries other work,
  so it says nothing about the rate.
- 33.75 SQ at $455 per SQ (no price mode saved).

That is too few, and too mixed, to support or contradict either number. No
customer names were read into this note.

## 4. Options for Joe

- **A. Keep as is (no change).** The site shows the all-in price per square
  of roof, which is what a homeowner can check against their own roof size.
  The CRM shows the rate per billed square. They agree by construction.
- **B. Show the CRM rate on the site.** For example "from $550 / $660 / $770
  per square, plus 12–25% for your roof's pitch and cuts". The typical-home
  totals stay the same: 20 × 660 × 1.12 ≈ $14,800 and 25 × 660 × 1.25 ≈
  $20,600 are the "$14,800–$20,600" already published. The /estimate tool's
  math must keep the waste in either way.
- **C. Fix the unit on Our Work.** When a job page states squares, say
  whether they are roof squares or billed squares. The 45-square job reads as
  $544 a square next to a site that says $615 and up.

Nothing on the site was changed for this note. The draft PR that adds it is
for the decision only.
