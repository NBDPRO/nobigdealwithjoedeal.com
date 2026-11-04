# Thumbtack Opportunities watcher (2026-11-04)

Server and data pieces for shortlisting Thumbtack Opportunities and drafting a first reply. It ships **dark** behind the flag `thumbtackOpportunities` and it **reads nothing from Thumbtack, logs in to nothing, sends nothing and runs no browser step**. Everything here takes plain item objects (what a page read produced, or what Jo pasted) and returns a decision. The design and Jo's answers live in the vault note `Money/Design - Thumbtack Opportunities Watcher 2026-11-04` (private, not in this repo).

**Flags** (Firestore `feature_flags/_default`, or per user in `feature_flags/{uid}`; absent or anything but the boolean `true` = off):

| Flag | Default | Meaning |
|---|---|---|
| `thumbtackOpportunities` | false | Every watcher callable refuses and files nothing while it is off. |
| `thumbtackOppSend` | false | RESERVED for the sender (a later PR, not built). Nothing reads it. |

Both are registered in `functions/flags-registry.js` (`FIRESTORE_FLAGS`, a separate list from the env flags) and pinned by `tests/flags-registry-drift.test.js`.

## Input-agnostic by design

Jo is asking Thumbtack support in writing whether an API exists. Until then the fallback is "Jo pastes an item". The scoring takes the same plain object either way:

```
{ oppId, category, city, state, zip, lat, lng, distanceMiles, milesByBase,
  postedAgeMin, prosAlready, photos, description, ownerOccupied, vacant, outOfState }
```

Only `category` is needed to start; a missing value is reported in the reasons and, where it matters (distance, age), holds the item instead of guessing.

## Rules (first version, all tunable; `functions/opp-rules.js`)

Score out of 100, then SHOW (score 60 or more), HOLD (40 to 59.9) or SKIP, with a one-line reason.

1. **Trade is a hard filter.** Always: roof repair or maintenance, roof inspection, siding repair, gutter repair. Roof installation or replacement and siding installation: only if the words read like a real replacement, the property is not known to be non-owner-occupied, and it is in the near zone. Drywall (paused), gutter cleaning, gutter installation, painting, handyman, moving, lawn, solar and anything unknown: SKIP. The match is on the category label only.
2. **Distance** from the nearer of two bases (Goshen OH warehouse, Cincinnati home). Near zone: 25 miles or less (25.0 is near). Far zone: over 25 up to 40 (40.0 is far), only when the job reads at least "normal" size (a leak, missing shingles, damage, an inspection) and never for installs. Over 40: SKIP. Kentucky included. Miles come from coordinates (ZIP centroid, supplied by the caller), a per-base map, or one supplied number. **The two base coordinates are approximate village / downtown centres, not the street addresses: Jo to confirm.**
3. **Job size** from the customer's words: `small` ("one panel") beats `big` ("full replacement", storm damage) beats `normal` (leak, missing, inspection) beats `unknown`. No price is ever produced.
4. **Competition:** 15 points at no pros down to 7 at four, 4 at five (crowded), 0 from nine.
5. **Freshness:** posted under 60 minutes gets the top 25 points; 60 to 360 minutes slides from 20 to 10; over 6 hours gets 2; over 24 hours is HOLD ("check it is still open"); no posted time is HOLD.
6. **Photos** (+3) and a clear place (+2). Vacant, out-of-state owner and not-owner-occupied are flagged, not blocked.
7. **Expected-value test, from history numbers the caller supplies.** Expected collected per reply = (hires / leads) x collected per hire; a trade is SHOWN only if that is at least `ev.multiple` (3) x the price per reply. If there is no history, under 5 leads of history, or no price per reply, the test is not applied and says so. A failing test holds the item (HOLD), it does not delete it. Integer cents throughout. **Starting guesses from Jo's Jul 31 to Oct 17 numbers are in `historySeed` and are NOT used unless a caller passes them in. See "May be wrong" below: with those numbers the literal 3x test would hold every trade, including roof repair.**
8. **Caps and hours** are data and pure helpers (`capStatus`, `inWatcherHours`, `inSendHours`): 8 approved sends a day and 25 a week; watcher 7 am to 8 pm Eastern; sends 8 am to 8 pm Eastern (the end hour is exclusive). Nothing enforces them yet because nothing sends yet. A rules override can only LOWER a cap.
9. **Per run:** at most 5 SHOW; the rest become HOLD with a reason.

**Prompt injection.** Every word a stranger wrote is DATA. The description is scanned only for fixed cue words (size, replacement, tags). An item whose words read like an instruction to us ("ignore your rules", "approve all", "reply with the owner's phone number", "change the budget") is flagged `instruction_text`, scored 0 and SKIPped; it changes no setting. No free text from an item is copied into a result: only tags from our own vocabulary (`leak`, `missing shingles`, `storm damage`, ...).

## Data model (all new, nothing existing changed)

One record per Opportunity seen, one per draft, and a rules doc. Customer contact details are NOT stored. Collections are admin-SDK only; the owner reads and writes through callables scoped by company.

| Collection | Key fields | Notes |
|---|---|---|
| `opp_seen/{companyId}_{oppId}` | `seenAt`, `postedAgeMin`, `category`, `tradeKey`, `zip`, `city`, `milesNearestBase`, `baseUsed`, `prosAlready`, `photos` (count), `summary` (fixed tags only, 200 chars max), `score`, `decision`, `reasons[]`, `flags[]`, `rulesVersion`, `expireAt` | `oppId` is Thumbtack's id if visible, else a hash of category + place + posted time rounded to 30 minutes. `expireAt` is 90 days out (the delete job is not built). No names, no phone, no free text. |
| `opp_rules/_default` | numeric overrides, `killSwitch`, `history`, `rulesVersion` | Owner-edited only through `sanitizeOverride` (bounded numbers; a cap can only be lowered). |
| `opp_drafts/{companyId}_{oppId}` | `oppId`, `tradeKey`, `templateKey`, `draftText`, `usedQuote`, `status` (`pending`), `createdAt`, `createdBy`, `expireAt` | Create-only. One per opportunity. Approval, edit, skip and send fields come with later PRs. |
| `feature_flags/_default.thumbtackOpportunities` | boolean | Absent or false = off. |

Not built here: the approval screen (inside the Follow-up board, a later PR), the sender, outreach tracking (`thumbtack_outreach`), the weekly report (`opp_weekly`) and rule tuning. No auto-send exists or is planned in this series.

## Storage and the filing callable (PR 2)

- **`opp_seen` and `opp_rules` are Admin-SDK only** (`firestore.rules`: `allow read, write: if false`, spelled out beside the `thumbtack_*` collections). The owner reads and writes through callables; no browser touches them. `opp_rules/_default` has no writer in this series yet: it is edited by hand with admin tools until a rules screen exists, and everything in it passes `sanitizeOverride` on the way in.
- **`oppShortlistFile`** (`functions/opp-shortlist.js`, shared gate in `functions/opp-access.js`): OWNER ONLY (the NBD owner account; a company admin, manager, rep, viewer, another tenant or a platform admin who is not the owner is refused), App Check enforced, 30 calls an hour per uid. Takes 1 to 25 plain items, scores them with the pure logic and files one `opp_seen` record each with `create()`: the first sighting wins, a re-scan answers `already_seen`. It reads only the two flag docs and `opp_rules/_default`, writes only `opp_seen`, contacts nobody and reads nothing from Thumbtack. Flag off or `killSwitch` true answers `not_allowed` and files nothing; a settings read error is `unavailable` (fails closed).
- **What it stores:** decision, score, our own reasons, trade label and key, a validated 5 digit ZIP, a letters-only city, miles to the nearer base, pros already in, photo count, and `summary` made of fixed tags. Nothing a stranger typed is stored or returned: not a name, phone, address, link or sentence. An instruction-shaped item is filed as `Other`, score 0, SKIP, flag `instruction_text`.
- A caller cannot pass rules or history; only the owner's `opp_rules/_default` and the built-in defaults reach the scoring. The seed history is not applied (see "May be wrong").
- `expireAt` (90 days) is stamped, but **no TTL policy or delete job exists yet**: nothing deletes old records until one is added.
- Watcher hours are reported (`inWatcherHours`) and not enforced here: paste mode may be used at any hour, and the freshness rule already holds old items. Send hours and the caps are for the sender PR.

## Draft templates and the message gates (PR 3)

A draft is a **fixed template plus three facts** (company name, city, one sanitized quote). Nobody types words into a template: a caller sends a template KEY (or none and the server picks one from the opportunity id).

- **Templates** (`functions/opp-draft-templates.js`): 3 wordings per trade x 6 trades (the four shortlist trades plus the two install trades) = 18 keys, `opp_<trade>_a|b|c`. Each is 3 to 5 short sentences: says it is fully insured, offers a free look and a time window ("this week, mornings or afternoons"), names the problem, asks for one photo if none was posted, and says they can reply right here in Thumbtack. No price or estimate, no pressure line, no digit, no "call / text / phone / number / email", no insurance claim talk, no "licensed", "in-house", "lifetime", guarantee or warranty, no emoji, no "Dear homeowner". The ban list is proven able to fail.
- **Phone-shaped-text refuser** (`phoneProblem`, `functions/opp-draft-logic.js`): refuses a run of 7 or more digits (any separators), 10 or more digits spread through the text, number words ("five one three"), "double / triple five", fullwidth and Arabic-Indic digits, zero-width characters between digits, O / I / l standing in for 0 / 1 beside digits, and requests like "text me", "call me", "my cell", "phone number", "area code". `linkProblem` refuses links, email addresses, handles and web addresses. Both run on the FINISHED draft, and the same functions are exported to run unchanged on Jo's edited text at approval (a later PR).
- **Kentucky wording gate** (`kentuckyProblem`): the existing `claimWordingProblem` (never handle or negotiate the claim, never a claims specialist or expert, never approved by an insurer), applied to every draft. On top of that a draft never mentions claims, insurance (except "fully insured"), adjusters, coverage or deductibles.
- **Problem-phrase sanitizer** (`sanitizePhrase`): the customer's words become ONE lower-case quote of letters, spaces, apostrophes, commas and hyphens, 120 characters at most. A phrase that is instruction-shaped, phone-shaped, link-shaped, mentions insurance, a quote or a price, is dropped whole and our own fallback phrase is used ("the leak", "the roof repair", picked from the fixed tags). Nothing else from an Opportunity reaches a draft.
- **`opp_drafts/{companyId}_{oppId}`** is CREATE-ONLY: the callable writes it with `create()` (a second filing answers `already_filed`, never overwrites), nothing in this series updates or deletes it, and `firestore.rules` denies every client read and write.
- **`oppDraftFile`** (`functions/opp-draft.js`): OWNER ONLY, App Check, 60 an hour, dark behind the flag and the kill switch. Only an `opp_seen` record the shortlist marked SHOW (and not flagged `instruction_text`) gets a draft. Files status `pending`. It sends nothing, approves nothing and has no approve or send path.

## May be wrong

- **The 3x expected-value test blocks everything on Jo's own numbers.** Roof repair: 6 hires per 33 leads (18.2%) x about $790 collected per hire is about $144 per reply against a $49.15 price ceiling; 3x that is $147.45, so it fails by a hair (2.9x). Siding repair, gutter repair and roof install fail by a wide margin. The design note's "2.7x to 3.5x collected-to-spend" for the whole channel says the same thing: a 3x bar sits at the channel average. The multiple is a data field; Jo should pick the multiple (or confirm the definition) before anyone passes the seed history in.
- Price per reply for an Opportunity is unknown until the first one is paid; the seed uses the direct-lead averages as a ceiling.
- Distance is straight-line between ZIP centroids, and the base coordinates are approximate.
- `oppId` from a hash can split one item into two ids when the posted time straddles a 30-minute edge.
- Win counts per trade are 1 to 6; treat every ratio as a hint.
- Thumbtack's terms on automated page reading have not been read; this PR does no reading.

## Files

`functions/opp-rules.js` (data, flag names, override whitelist), `functions/opp-shortlist-logic.js` (pure scoring, shortlist, hours, caps), `functions/flags-registry.js` (`FIRESTORE_FLAGS`), `tests/opp-shortlist-2026-11-04.test.js`, `tests/flags-registry-drift.test.js`; PR 2: `functions/opp-access.js`, `functions/opp-shortlist.js`, `functions/index.js` + `function-map.json` + `FUNCTIONS_INDEX.md` entries, `firestore.rules`, `tests/opp-shortlist-callable-2026-11-04.test.js`, `tests/firestore-rules.opp-2026-11-04.test.js` (emulator, wired in `.github/workflows/ci.yml`).

PR 3: `functions/opp-draft-templates.js`, `functions/opp-draft-logic.js`, `functions/opp-draft.js`, `opp_drafts` rules entry, `tests/opp-draft-2026-11-04.test.js`, `tests/opp-draft-callable-2026-11-04.test.js`, rules test extended.
