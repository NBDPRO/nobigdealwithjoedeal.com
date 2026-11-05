# Copy and wording review, 2026-11-04 (for Jo)

The copy findings from [OVERNIGHT-SITE-PROGRAM-2026-10-26](OVERNIGHT-SITE-PROGRAM-2026-10-26.md) (copy-001 to copy-010)
were "Needs Jo" because the words are his. This session drafted the ones that a source of truth in the repo settles, on
the DRAFT branch `claude/copy-wording-drafts-2026-11-04`. Nothing ships until Jo approves. The rest are below as
questions, each with the variants found and a suggested answer.

**Update 2026-11-04: Jo approved the drafted wording as written ("Approve as written"). It ships in #2820.** The
questions section below is still open.

Measured against `main` `72fe9466`. File counts exclude `docs/llms-full.txt`, which is regenerated at deploy.

## Drafted (on the branch, waiting on Jo's yes)

**copy-001, outcome wording (6 files).** "claimable" and "money recovered from your insurer" are gone:

| Where | Was | Now |
|---|---|---|
| Roof Score, hail dents | Often claimable — worth documenting before it ages out. | Worth documenting soon, while the marks are fresh and easy to date. |
| Storm check result | Joe will … document anything claimable, and tell you straight whether it's worth filing | Joe will … document what the storm did, and tell you straight what he found, so you can decide what to do next. |
| Fairfield hail FAQ | What size hail causes insurance-claimable damage in Ohio? | What size hail damages a roof in Ohio? |
| Fairfield hail FAQ | Ohio insurance carriers recognize impact damage down to three-quarter inch in some policy language. | Older or brittle shingles can crack from smaller stones. (The insurer claim was unverified. Say if it is right.) |
| Fayetteville hail and storm FAQs | If there's (no) claimable damage … | If there's (no) hail / storm damage … |
| Indian Hill hail FAQ | each item documented is money recovered from your insurer | every damaged item goes on my line-item estimate and nothing gets left off |

**copy-002, supplement wording (42 list items, 5 sentences).** Every line now says what `tests/claim-wording.test.js`
calls the approved model: Joe writes a supplement (his updated estimate) *for you to send your insurer*. The "what's
included" list items ("Supplement documentation if initial payment is short", "… if the initial payout is below actual
scope", "Supplement (my updated estimate) if the adjuster's scope misses damage", "Adjuster meeting on site and supplement
documentation") use one sentence. Reworded in the same sentences, because each one implies something the law (KRS
367.628) forbids:
- Goshen: "I know the Clermont County adjuster pool personally" (affiliation with insurers).
- Maineville: "7-year track record with Warren County insurance claims" (claims expertise). The answer now starts "That's
  between you and your insurer: your policy decides what's covered."
- Indian Hill: "Will my … adjuster try to low-ball a hail claim?" and "make it difficult for an adjuster to exclude
  items" (advocacy).
- Anderson Township: "My insurance restoration background means I speak the same language as adjusters … and how to
  supplement when the first number doesn't cover the full replacement cost."
- `hail-damage-insurance-claim` meta description: "writes the supplement" now says "writes supplements for you to send".

**copy-008, city count (20 files).** "All 25+ Cities" links now say "All 43 Cities". `site-src/data/towns.json` holds 43
towns (31 OH, 12 KY), `docs/areas/` has 43 town pages, and the areas index already said 43.

**copy-010, spelling and URLs (46 files).**
- grey → gray, neighbouring → neighboring. The Our Work changes went into `projects.json` and were restamped with
  `build-projects.mjs`. Kept as written: TAMKO's colour names (Oxford Grey, Thunderstorm Grey) and Union Centre.
- Slashless URLs, matching the canonical and the sitemap (the slash form 301s under `trailingSlash:false`): the
  BreadcrumbList "Blog" item on 32 posts, plus og:url and JSON-LD url on /book, /free-roof and /free-tools.
- The Field Notes post's og:url pointed at the "keep the insurance check" post.
- **Left:** "centre / centreline / centred" in the roof guide's illustrations (`site-src/illustrations/figures.json`,
  `sources.json`, two SVGs). A fix means the `build-illustrations.mjs --svg` → pinned svgo → `--stamp` pipeline and a
  look at the art. That's a small follow-up once Jo says yes.

## Questions only Jo can answer

**copy-004, blog dates.** The index, the feed and each post's `article:published_time` all agree. The visible byline and
the post's JSON-LD say something else on five posts. Which date is real for each?

| Post | Byline and JSON-LD | Index, feed and published_time |
|---|---|---|
| does-homeowner-insurance-cover-hail-damage-ohio | Jan 6, 2026 | Jul 21, 2025 |
| what-to-expect-roof-insurance-adjuster-visit | Jan 14, 2026 | Oct 13, 2025 |
| signs-your-roof-needs-replacement-vs-repair | Dec 1, 2025 | Mar 24, 2025 |
| how-much-does-roof-cost-cincinnati-2026 | Dec 23, 2025 | May 19, 2025 (the title says 2026) |
| can-i-keep-insurance-check-not-fix-roof | Feb 19, 2026 | Feb 16, 2026 |

Seven posts show a 2025 byline. The business record says NBD started in 2026, so a 2025 post date may itself be the
problem. Once Jo picks, `node scripts/rebuild-blog-index.js` and `node scripts/build-feed.mjs --write` restamp the
index and feed from each post's `article:published_time`.

**copy-005, how long things take.** Pick one answer for each and every page gets it:
- **Joe's inspection, 8 wordings.** "45 minutes to an hour" (7 places, including /inspect and roof-inspection), "45 to 60
  minutes" (6), "45 to 90 minutes" (the five town roof-inspection pages), "about 45" (4), "takes an hour" (3), and "30
  min" on the /book card. Suggestion: "45 minutes to an hour", and the /book card says 60 min.
- **The adjuster visit, 6 wordings.** "20-30 minutes", "20-40 minutes", "30 to 90 minutes", "thirty minutes and an hour
  and a half", "60 min" on the /book card, and "a two-hour morning" on /book itself. Suggestion: "usually 30 to 90
  minutes", with /book's card and its "two-hour morning" line matching.

**copy-006, credentials.** The Credentials page says "If something is not on this page, I do not claim it". It lists GAF
Certified (1162011), TAMKO Pro Gold (181382) and Fully insured. Other pages claim more:
- James Hardie Alliance membership: visible on the homepage, the siding guide and /review, and in `memberOf` schema on
  ~300 pages. Add it to Credentials (if real, with the proof) or remove it everywhere?
- American Operator: in the footer and schema on every page but not in the Credentials list. Add it?
- /review "Trusted By Industry Leaders" shows ABC Supply, SRS and Beacon. They are suppliers, not endorsements.
  Suggestion: retitle the strip "Where I buy my materials".
- llms.txt lists United Restore (mitigation partner), Acorn Finance and the TAMKO HailGuard warranty, none of which is
  on Credentials.
- "50-year manufacturer warranty on siding panels" (siding-replacement), and shingles "rated for 50 years" (Florence KY
  roof replacement): is the source the manufacturer's warranty?
- IKO is named in the Credentials disclaimer while it is still pending (applied 10-07). Leave it, or take it out until
  it's granted?
- "Licensed" is never used about NBD. All 18 hits are about public adjusters or abatement contractors. No change needed.

**copy-009, the Free Roof Program.** The page contradicts itself:
- "Drawing date posted on NBD socials" and "one winner", but also "This is a gift, not a contest", "selected at NBD's
  sole discretion" and veterans "move to the front of the line". Which is it: a drawing, or Jo's pick? A drawing can
  bring sweepstakes rules into play.
- "One Entry Per Person" and also "One entry per household". Which?
- The counties are seven on the page, plus Brown on /partners. The banner says "nominate a Cincinnati neighbor" on
  every town page, including the Lexington-area and Clinton County ones. Which area is eligible?
- "Open Now", but there's no deadline, selection date or year anywhere.
- /partners says "Every year I give away a full roof replacement", which implies past winners.

**Also seen (not in the findings):** the schema `areaServed` lists 45 cities on ~300 pages. Liberty Township and
Independence have no town page or data entry. Keep them as areas served, or drop them?
