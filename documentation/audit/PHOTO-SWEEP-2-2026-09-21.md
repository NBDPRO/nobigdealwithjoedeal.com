# Photo sweep #2 — 2026-09-21: CUSTOMERS tree, what's still new

> Read-only Drive reconnaissance, follow-up to `PHOTO-SWEEP-2026-09-21.md`
> (same day, earlier session) and the 08-28 full sweep. Nothing downloaded,
> published, or modified — this is the only file this session wrote.
> Sanitized throughout: first name + last initial, town-level location only,
> price rounded to the nearest hundred, no street addresses, no phone
> numbers, no claim numbers, no exact dollar figures.

## Method

1. Enumerated the CUSTOMERS folder (`1yg5hXlvZOm29xMYtkrlWHRvW1xK18yPq`) by
   paginating `search_files` with `parentId = '<id>'` — confirmed this query
   term works on this account (four page fetches, ~140 direct child folders
   total, one page had a one-item overlap at the boundary which was
   deduped by id).
2. Instead of walking every folder's Docs/Photos subtree by hand (expensive
   at this scale), cross-checked against a **global Drive search** for
   `fullText contains 'invoice'` and `fullText contains 'receipt'` scoped to
   `createdTime > 2026-09-01` (plus a second pass for the 2026-08-28→09-01
   gap, to not miss anything right at the boundary of the last full sweep).
   This surfaces every invoice/receipt file created anywhere in Drive since
   the last full sweep, regardless of when its parent customer folder was
   originally provisioned — which matters, because a folder's own
   `modifiedTime` does **not** reliably bubble up when a file lands two
   levels down in its Docs subfolder (the same gap the earlier sweep today
   already flagged).
3. Every hit was traced back to its customer folder (`get_file_metadata` /
   `parentId` walk) and checked against the "done" and "excluded" lists
   already in hand. Anything real was read in full and its Photos subfolder
   (or Phone shots/Drone shots split, depending on folder vintage) was
   listed to confirm non-empty.
4. Separately verified the four most-recently-created CUSTOMERS folders
   (created 09-07 through 09-19, i.e. newer than anything in the invoice
   search) by listing their Docs subfolders directly, since a same-day file
   could in principle lag the search index.

## Folders checked and ruled out

- **Already done or excluded per this session's brief**: Customer AG, Emily
  & Caesar Customer BM, Customer Z (interior job), Customer CG, Customer AD
  , Customer C, the second (gutter-cleaning) Bryce W., Anastasios
  "Tasso" R., Customer FB — not re-opened.
- **The bulk of the tree (~100+ folders) never has an invoice or receipt at
  all** — mostly two large bulk-import batches (folders stamped identically
  2026-08-15 and 2026-08-18, and a third cluster stamped 2026-09-06 that
  looks like a CRM reorg/migration touching ~25 older folders'
  `modifiedTime` without adding any new content — none of those 25 produced
  an invoice/receipt hit in the global search either, confirming the
  09-06 timestamp cluster is administrative, not job progress).
- **Estimate/scope stage only, not complete** — checked directly and
  confirmed no invoice exists: Larry C. (two property folders, both still
  at "Job Scope" stage), Jermaine O. (repair proposal only, created 09-19),
  Rick Z. (Docs folder empty, created 09-15), Ian B. (interior painting
  proposal only, created 09-07), James & Michelle S. (roof estimate re-run
  09-15, no invoice), Sarah S. (roof replacement estimate 08-30, no
  invoice), Kim M. (photo assessment & estimate 09-08/09, no invoice) —
  Anastasios R.'s estimate PDF also reappeared in this pass, consistent
  with the existing exclusion.
- **Superseded/administrative documents, not new jobs**: reissued invoice
  copies for Hanna D. and Brad M. (see below), a "SUPERSEDED" draft doc for
  Albeliz S., and an internal `_NBD MASTER INDEX` / `_NBD DOCUMENT STANDARD`
  pair of process docs that matched the 'invoice' keyword incidentally.
- **One invoice/receipt hit traced outside the CUSTOMERS tree entirely**: a
  `NBD-Invoice-Customer Z-2026-0919.pdf` / matching receipt sits in a
  differently-structured "files" folder (not the standard
  Docs/Photos/Reports/Internal layout), dated 09-19/20. Given the surname
  and date, this is almost certainly the already-DONE Customer Z
  invoice generated through a different storage path, not a new customer —
  flagged, not re-investigated as new.

## New candidates (ranked)

1. **Rebecca H. — gutter replacement + screens, two-story run** (Cincinnati,
   OH). Paid receipt dated 2026-09-20 — the freshest paperwork found in this
   pass, likely landed after the earlier same-day sweep had already run.
   Job total ~$4,000. Real photos: 10+ HEIC files plus a contact sheet and a
   separate JPG export folder, all dated 09-03 (photographed ahead of the
   paperwork, consistent with the job having actually happened). Not a
   duplicate of the existing `cincinnati-oh-gutter-screens-2026` card —
   that one is a materially smaller/cheaper job (~$2,000–2,500) with no
   mention of a multi-line adjustment; this is a bigger two-story run with
   its own distinct invoice number and photo set. **Best candidate in this
   pass** — paid in full, richest photo set, clean paperwork.

2. **Rachel H. — soffit repair** (Franklin, OH). Paid invoice dated
   2026-09-10. Small job, ~$500. Real photos: 10 HEIC files in a flat
   Photos folder (this customer folder predates the Phone/Drone-shots split
   used on newer folders), plus the invoice PDF itself embeds four
   before/after photo call-outs. Not a duplicate of the existing
   `cincinnati-oh-soffit-repair-2026` card — different town, different
   price, different soffit detail (tongue-and-groove vs. broken boards).
   Small but clean and complete.

3. **Brad M. — gutter cleaning, same-day service** (Cincinnati, OH). Paid
   invoice dated 2026-09-09 (one superseded reissue same week, cosmetic
   only — a Stripe-link correction). Smallest job in this batch, ~$200.
   Real photos: 10+ JPG phone shots (paginated past the first page, so
   more exist), no drone (not needed for a cleaning job). **This one was
   already flagged as "net new, photo-ready right now" in the earlier
   same-day sweep** (`PHOTO-SWEEP-2026-09-21.md`, candidate #5) but does
   not appear among the four customers this session's brief says were
   actually published today — worth confirming with Jo whether it was
   deliberately skipped (routine cleaning vs. the other three's
   replacement/repair scope) or just fell off the list.

None of the three above appear anywhere in `docs/assets/data/projects.json`
under any city/description combination (checked by grepping for
job-specific keywords and street-name fragments — no matches).

## Bottom line

The well is not dry — three genuinely new, paid, photo-backed candidates
turned up, none of them previously flagged as done or excluded. Two (Rachel
H., Brad M.) were misses of the earlier same-day folder-timestamp-based
sweep for the same structural reason that sweep's own methodology note
called out: a customer folder provisioned before a cutoff date can still
receive a brand-new invoice well after it, and folder-level `modifiedTime`
doesn't reliably surface that. The third (Rebecca H.) is simply newer than
this morning's sweep. Recommend Jo (or a build pass) treat Rebecca H. and
Rachel H. as ready to draft into `/our-work` cards, and either publish or
consciously defer Brad M.
