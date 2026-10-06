# Session 2026-09-07 — seven client PDFs out the door, and the one that would have undercharged by $1,616

Branch: `fix/invoice-pdf-rendering` · commits `5f065174`, `6fcc3d23` · PR #1460

Joe's ask, in order: "i just checked some of these like one customer and i
wanted a completed copy in PDF not just the gdocs" → "just add the logo to
each" → "make sure everything is in its proper folder".

---

## What shipped

Seven finished, branded, client-ready PDFs, each filed in its customer's
Drive `Docs` folder and imported onto its CRM card.

| Customer | Document | Value |
|---|---|---|
| Customer CG | `NBD-2026-0814-XXXX` invoice | $1,050 |
| Customer C | `NBD-2026-0902-XXXX` invoice | $125 |
| Customer DU | `NBD-2026-0903-XXXX` invoice | $225 |
| Customer CA | `NBD-2026-0902-XXXX` estimate | $5,038 / $4,306 |
| Customer BF | `NBD-2026-0902-XXXX` estimate | $7,500 |
| Customer BQ | `NBD-2026-0902-XXXX` estimate | $8,350 |
| Customer FI | `NBD-2026-0902-XXXX` estimate | $1,800 / $2,400 |

Two documents were deliberately **not** converted:

- **Customer ER's** Drive gdoc is a sales talk-track — "Say them before the
  price", tier reasoning, open items. Rendering it into a branded client PDF
  would have handed the customer Joe's own notes. Her real 8-page proposal
  turned up during the tidy, sitting at her folder root.
- **Customer BX's** "Estimate and COI Packet" gdoc is a text extraction of an
  existing PDF, and its back half is a mangled transcription of a real ACORD 25
  certificate of liability insurance. Regenerating an insurance certificate is
  not something to do; the original from Next Insurance is the only valid copy,
  and it was already in her folder.

## The renderer learned what an invoice is

`scripts/render-estimate-pdf.py` was written against estimates. Run an invoice
through it and three defects showed on the page:

- `DESCRIPTION        AMOUNT` collapsed into the single nonsense heading
  "DESCRIPTION AMOUNT"
- line-item prices separated by a run of spaces rendered **inline in the
  sentence** instead of in an amount column
- `BALANCE DUE` came out as a plain grey key-value row rather than the navy bar
  the house style calls for

Fixed, plus five more found on the way through: letterhead detection keyed on
"Licensed & Insured"/"TAMKO Pro Gold" and the Customer DU invoice carries neither,
so its entire letterhead printed as body text under a fallback title; a priced
section heading was being captured as a line item; dot-leader rows only matched
when the value was a price, so a measurement schedule printed its literal dots
as prose; `[CONFIRM — house number and zip]` got the same unmissable badge that
`[ADDRESS]` already had, because sentence-case holes were shipping silently;
and TOTAL/BALANCE DUE no longer split across a page break.

A bare payment URL now renders as an orange **pay button plus a scannable QR**
of the same link, so a printed invoice is payable from paper. The QR was
decoded and compared against the live Stripe URL before the PDF was filed.

## The logo

The masthead had been a typeset approximation because the logo file had never
been located — the standing note said Pictures on rog14, a path that cannot be
granted. It is actually at
`G:\My Drive\COMPANIES\NBD\INTERNAL\Content\BRAND\NBD ORIGINAL LOGO.png`.

Trimmed to its bounding box, white knocked out to transparency, resampled to
1100px and quantised to 48 colours — 46 KB, committed at
`scripts/assets/nbd-wordmark.png` and embedded as a data URI so the PDF carries
no external reference. `logo_tag()` falls back to the typeset wordmark if the
asset is missing.

Palette now matches the artwork rather than sitting next to it: navy `#1A3057`
and orange `#BD5728`, both sampled from the mark. The previous `#1A3A5C` /
`#E8720C` were close enough to read as a mistake once the real logo was on the
same page.

## THE CATCH — Customer CA

**The estimate filed for Customer CA was the wrong pricing.** It was rendered
from the newest Google Doc in her folder. That doc was the Sep 2 draft, which had
been superseded on Sep 3 by a reprice: $17/lf two-story gutter rate rather than
$14/lf, five new downspouts at $250 each, and a fascia allowance.

- What was filed: **$3,422 / $2,690**
- What is correct: **$5,038 / $4,306**
- Gap: **$1,616 of undercharge**, in a document that looked entirely professional

Worse, the tidy pass had moved the *correct* Sep 3 six-page PDF into
`Internal\Superseded`, because its filename ("Gutter and Screen") looked like an
older variant of the one just filed ("Gutter & Screen").

Both reversed. The $5,038 PDF is back in her `Docs`; the Sep 2 re-render and the
stale source doc are in `Internal\Superseded` prefixed "SUPERSEDED Sep 2
pricing"; her CRM card carries the correct one.

> **Rule this exposed:** before rendering any Google Doc to a client PDF, check
> whether a later repriced version exists. The doc id being newest in a folder
> does not mean it carries the newest numbers.

The other six were checked against the record for the same failure mode and all
match their latest revisions.

## Two importer behaviours worth knowing

`import-drive-docs-to-crm.js` **skips a filename it has already seen.** Regenerate
a PDF under the same name and the card keeps the old copy forever. That is how a
card ended up still carrying an invoice titled "DRAFT - do not send" after the
real one was filed — one click from the customer.

It also **only walks subfolders.** A file at a customer folder root is invisible
to it. Twelve real documents had never reached the CRM for that reason alone,
including Customer ER's 8-page proposal and her GAF QuickMeasure.

New: `scripts/prune-superseded-lead-docs.js` removes named documents from lead
cards and their Storage objects — scoped to one company, dry-run by default. It
takes `--prefix=<doc number>` as well as `--name=`, because Windows hands argv to
node in the console codepage and a filename containing an em dash arrives mangled
and matches nothing. The same trap applies to `.ps1` files written as UTF-8
without a BOM: match by pattern, not by literal name.

## The Drive tidy

77 files moved, nothing deleted, everything reversible.

- images → `Photos` · Full Report / Property Owner Report / Codes and Weather /
  QuickMeasure → `Reports` · zips, competitor analysis, build scripts, blank
  templates → `Internal` · everything else → `Docs`
- Customer U's `build_estimate.py`, `build_leavebehind.py` and builder prompt came
  out of her client-facing `Docs`
- Customer BJ had a blank `NBD_Estimate_Template.pdf` sitting in her `Docs`
- a `_test_write.txt` left in Customer BX's `Internal` by an earlier session was
  deleted
- the empty duplicate folder (a misspelling of a customer's name) was removed — Joe confirmed the two spellings
  are the same person, and his documents are in `Customer CC\Docs`
- a blank estimate template attached to Customer U's CRM card was
  deleted, record and Storage object both

Result: all 145 customer folders carry the full Docs/Reports/Photos/Internal
scaffold, **zero loose files at any folder root**, and only the three
`_FILING RULES` / `_FOLDER KEY` docs at the CUSTOMERS root.

Verified by a dry-run import reporting **0 files to import, 265 already on
cards** — Drive and the CRM agree exactly.

## Unblocked mid-session by Joe

- **Customer DU**: phone [phone removed], email [email removed], service date
  Tue Aug 11 2026, address [street address], Cincinnati OH 45208. Invoice went from
  three `[CONFIRM]` holes to complete.
- **Customer BF**: [street address], Cincinnati OH 45220. This was the *only* thing
  blocking his $7,500 conversion estimate since early September. It is now
  sendable with no placeholder left in the document.

## A process note

The logo commit initially landed on `feat/customer-portal-overhaul` because a
`git checkout` was refused and PowerShell carried on past it — `$ErrorActionPreference`
does not catch a native command's exit code. It was caught, that branch was
rewound to Joe's own commit with `--force-with-lease`, and the commit replayed
onto the renderer branch. Joe's PR #1459 and his three commits were untouched.

**Wrap every `git` call in a PowerShell script in an explicit `$LASTEXITCODE`
check.** A silent failure mid-script is how work ends up on someone else's branch.

## Open, for Joe

1. **Customer CA may already be closed.** She is recorded as having approved $4,300
   on Sep 6 and moved to Contract Signed — within $6 of Option 2 ($4,306). If so
   her document is a signed-contract record, not a live estimate. Confirm which
   option she took before sending anything.
2. Send: Customer CG $1,050 (with the 20+ jobsite photos he was promised, and the
   apology — he was told documentation was coming and it never was), Customer C
   $125, Customer DU $225, Customer BF $7,500, Customer BQ $8,350, Customer FI $1,800/$2,400.
3. Customer DN's Aug 11 proposal expires around Sep 10.
4. `documentation/INDEX.md` was not touched this session — there were uncommitted
   edits to it in the working tree and a conflict was not worth causing. An index
   line for this file may be wanted.
