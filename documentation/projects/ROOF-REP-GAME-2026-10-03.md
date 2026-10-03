# Roof Rep — the NBD Pro sales game (2026-10-03)

Jo: "I officially wanna make a game. Roofing sales person simulator." Built
the same day as a claude.ai artifact, grown in four rounds at Jo's request
("let's do all 5", "double what we have"), then moved into the CRM with its
own tab.

## Where it lives

| Piece | Path |
|---|---|
| Page | `docs/pro/roof-rep.html` (noindexed; strict CSP, no inline script) |
| Game | `docs/pro/js/pages/roof-rep.js` (classic script, ~190 KB) |
| Look | `docs/pro/css/roof-rep.css` (single dark arcade look on purpose) |
| CRM link | `docs/pro/js/pages/roof-rep-net.js` (auth, saves, crew board) |
| Tab | `#nav-roofrep` (sidebar, TOOLS) + `#mm-roofrep` (phone More drawer); plain `<a>` links so the installed iPhone app stays in-app |

**Source of truth for content is the published artifact**
(claude.ai/artifact/Cgjufp5u5oj8ibbxGxFcJA). The CRM files are generated
from it by a split script that swaps the artifact's claude.ai storage for
`window.RoofRepNet`. Change the game in one place and regenerate the other;
don't let them fork.

## Data

- `roofRep/{uid}` — the career save (`{ save, at }`). Owner-only; not even a
  company admin reads it.
- `roofRepScores/{uid}` — the crew-board row. Readable by the owner and by
  the SAME company (token `companyId`); the owner writes only their own row,
  stamped with their own `companyId`, board fields only (`hasOnly`).
- Both are on `OWNER_KEYED_DOCS` (GDPR erase/export).
- localStorage `roofrep.save.v2` is a boot cache; Firestore wins when newer.
  A save from a different rep on the same device is never adopted.
- The Home game-card avatar (`userSettings/{uid}.game.avatar`) seeds a new
  career's look.

## What it teaches (and the guard)

The Kentucky rules are the core mechanic: "I'll handle your claim", covering
or waiving the deductible, padding a supplement, an assignment of benefits,
signing a check over, skipping the permit — each is offered as a WRONG
choice and loses the door or breaks the clean-day streak.
`tests/roof-rep-game-2026-10-03.test.js` fails if any trap ever becomes a
winning line (break-tested), and if game prices drift from the CRM price
book: TIER_RATES (550/660/770 per SQ), job-template retail floors (pipe boot
$350, chimney reflash $750, ridge repair $450, ice dam retrofit $900) and
seamless gutters $8.50/LF with the $1,000 K5 floor.

Supplement line-item amounts, change orders and the upgrade shop are game
values (what a carrier approves / game currency), not NBD retail.

## Content inventory

6 streets (Maple Court → Old Town, unlocking by level) each with a boss door;
24 homeowner types; seasons, weather, catastrophe storms; a storm-chaser
rival; dogs; 11 phone-call types; the full job from knock to collected
(inspect, measure, photo report, price, adjuster + test square, supplement,
crew board, build: change order / layers / nailing / city inspector / magnet
sweep / review); end-of-day CRM log; 6 training courses; 7 skills; 12
upgrades; 26 trophies; daily challenge; first-day tutorial; chiptune sound.

## Tests

- `tests/roof-rep-game-2026-10-03.test.js` (unit: traps, prices, trees, hygiene, rules, registry, nav)
- `tests/firestore-rules.test.js` (roofRep owner-only; roofRepScores same-company)
- `tests/e2e/roof-rep.spec.js` (iPhone first: More tab, tutorial, a full day,
  Firestore save, wiped-cache reload; then desktop sidebar tab + "← CRM")
