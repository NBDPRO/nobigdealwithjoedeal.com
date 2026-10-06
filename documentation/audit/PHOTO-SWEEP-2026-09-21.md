# Photo sweep — 2026-09-21: CUSTOMERS tree (post-08-29) + USB Devices & SD Cards scoping

> Read-only Drive reconnaissance, Jo-requested 2026-09-21. Two asks: (1) find
> completed-job CUSTOMERS subfolders created/touched since the 2026-08-28
> sweep's "wells are dry" cutoff (2026-08-29) that aren't in
> `docs/assets/data/projects.json` yet, and (2) scope (not mine) the
> **USB Devices & SD Cards** folder (Drive id `0Bw7x1lDrCZSOS1pIRTJpb0pHOU0`,
> created 2017-08-21) that the 2026-08-28 sweep never touched. Sanitized:
> first name + last initial, town-level location only, no street addresses,
> no phone numbers, no dollar figures, no claim numbers. Nothing was
> downloaded, published, or modified — this is recon only. The prior sweep's
> full report (exact addresses/GPS/CRM ids) lives in
> `.local/ourwork-candidate-pipeline-2026-08-28-FULL.md` (gitignored); this
> note follows the same pattern — sanitized queue here, no `.local` companion
> was created this session.

## Part 1 — CUSTOMERS tree candidates since 2026-08-29

Method: `search_files` doesn't support `'<id>' in parents` directly, but it
turns out `parentId = '<id>'` **does** work as a query term on this instance
(contrary to the tool-quirk note passed into this session) — verified against
CUSTOMERS (`1yg5hXlvZOm29xMYtkrlWHRvW1xK18yPq`) and confirmed with
`get_file_metadata` walks up each result's parent chain. A `createdTime`/
`modifiedTime` filter on the CUSTOMERS root only catches folders whose own
Drive metadata changed — **it misses jobs where the top customer folder was
provisioned earlier but new Docs/Photos content landed after the cutoff**,
since Drive doesn't cascade a child edit up to the parent folder's
`modifiedTime`. Cross-checking that gap with `title contains 'Invoice'` /
`title contains 'Photo Documentation Report'` and `createdTime > 2026-08-25`
surfaced several jobs the folder-listing approach alone would have missed.

**Two folders excluded as already published**, both from timing matching an
existing card almost exactly: **Charlene Z.** (folder + invoice both dated
2026-08-26 — this is rank-4 from the 08-28 sweep, live as
`cincinnati-oh-soffit-repair-2026`) and **Hanna D.** (folder 2026-08-15,
invoice 2026-08-31 — this is rank-3 from the 08-28 sweep, live as
`newport-ky-siding-top-course-2026`; a "SUPERSEDED" reissue of the invoice on
09-09 is an admin correction, not a new job).

### Candidates (ranked by photo readiness)

1. **Chris R. — gutter section + shingle repair** (folder created
   2026-09-15). Drone stills (~15 files, DJI_ naming, shot 09-11 and 09-15)
   plus phone photos (~11 files, HEIC). Invoice issued 09-17. An invoice PDF
   and a receipt PDF are present in Docs, unopened beyond metadata. Town:
   Cincinnati, OH (from the invoice header, town-level only — no street
   quoted here). Already flagged to this session before the sweep started;
   confirmed real and photo-ready.

2. **Emily & Caesar F. — LP SmartSide siding & trim repair** (folder created
   2026-09-08). The big one: Phone shots folder has **100+ HEIC photos**
   (pagination didn't resolve past the first 100 in this pass — the job's own
   Photo Documentation Report PDF says explicitly "a representative set is
   shown here; the full photo library for this job is on file in Drive"),
   spanning a clear before → during (roof-walk, corner-trim removal) →
   after arc. Drone shots subfolder exists but is empty. A yard-sign/photo
   marketing release, an invoice, a receipt template, and a 10-page Photo
   Documentation Report PDF are present in Docs/Reports, unopened beyond
   metadata (except the marketing-release PDF's own snippet, which
   explicitly documents homeowner consent for job-site photo/marketing use
   with no interior photos and no address alongside images — i.e. this job
   already carries a signed photo-release). Town: Cincinnati, OH. **Best
   candidate in this batch** — richest photo set, explicit marketing consent
   on file, clean before/during/after story.

3. **Cheryl H. — folder dated 2026-08-11, but its Photo Documentation Report
   (and a superseded version of it) were generated 2026-09-08/09.** Photos
   folder's Drone shots subfolder has 50+ DJI_ JPGs (paginated past 50, so
   more exist) — see Part 2 note below: this drone set traces back to the
   **SDXC 240GB** card in USB Devices & SD Cards (byte-identical file sizes
   confirmed on the DJI_0401–DJI_0410 range), so the raw source material for
   this job already lives in both trees. Phone shots subfolder is empty.
   Town not discoverable without opening the Reports PDF (not opened).

4. **John R. — folder dated 2026-08-14 (inspection), but the invoice was
   only finalized 2026-09-07/09.** Ambiguous vintage: this could be a job
   that was mid-flight during the 08-28 sweep and simply hadn't invoiced
   yet, or one of the sweep's already-ranked-but-unpublished 13–28 queue
   (that list is in the gitignored `.local` file this session didn't have
   access to). Photos folder has 50+ files across two batches — an
   IMG_5xxx.HEIC series and a separate UUID-named JPG series — paginated
   past 50, so a substantial before/after set either way. Flag for
   cross-check against the `.local` 13–28 list before treating as fully new.

5. **Brad M. — folder dated 2026-08-18, invoice finalized 2026-09-07 (one
   superseded reissue on 09-09).** Phone shots folder has 33 JPG photos
   (UUID-named, consistent with an iPhone/Android share-sheet export, not
   HEIC — camera app or model unclear). No drone. Town not discoverable
   without opening Docs.

6. **Albeliz S. — folder dated 2026-08-15, invoice dated 2026-09-06/07.**
   Both Drone shots and Phone shots subfolders are **empty** — invoice exists
   but no photos have been uploaded yet. Not ready to publish; worth a
   follow-up ping to Jo about whether photos are still coming.

7. **Bryce W. — folder created 2026-09-15, invoice dated 2026-09-19/20 (the
   freshest paperwork in this sweep).** Both Drone shots and Phone shots
   subfolders are **empty**. Same situation as Albeliz S. — invoiced, no
   photos landed yet.

**Not opened for any of the above:** invoice PDFs beyond what the search
tool's snippet already surfaced for Chris R. and the Customer BMs (an
unavoidable side effect of the Drive search tool defaulting to
`DETAILED` content snippets on a folder listing before this session learned
to pass `excludeContentSnippets: true` — no full address, phone number, or
dollar figure from either is reproduced above, and no PDF was opened via
`read_file_content`/`download_file_content` for any candidate). Reports/
Photo Documentation PDFs are noted as present, unopened, for the rest.

**Net new, photo-ready right now:** Chris R., Emily & Caesar F., Cheryl H.
(pending the CRM-provenance note above), Brad M. — four candidates.
**Invoiced but photo-less:** Albeliz S., Bryce W. — two more that may
convert once photos land. **Ambiguous vintage, needs the `.local` cross-
check:** John R.

## Part 2 — USB Devices & SD Cards: scoping only

Root: `0Bw7x1lDrCZSOS1pIRTJpb0pHOU0`, created 2017-08-21. Eight direct
children, each a device/card dump (not a customer or job folder):

| Folder | Created | Nature |
|---|---|---|
| USB30FD | 2017-08-21 | Old USB drive. "SUMMER" + "System Volume Information" folders, plus stray school `.docx` files (essay templates, "All U.S. History Homework.docx"). **Personal/school, not job-related.** |
| SANDISK 256 \[E\] | 2017-09-17 | Same pattern — "SUMMER" folder, identical school `.docx` set. **Personal, not job-related.** Near-duplicate of USB30FD's non-photo content. |
| SDXC Card | 2026-04-05 | Full raw Android/GoPro card image: DCIM, Download, Movies, Pictures, Notifications, Alarms, Ringtones, Podcasts, Music, Android, **goshare** (a moving-labor app — personal/general use), LOST.DIR, MISC, `mdb11.db`, `Get_started_with_GoPro.url`. |
| MICRO SD - 64GB | 2024-07-17 | **Identical subfolder structure and file names/sizes to SDXC Card and SDXC 64GB** (same `mdb11.db` size, same `goshare` folder, same GoPro URL file) — almost certainly re-images of the *same physical card* at three different points in time (2024-07, 2026-04, 2026-06), not three distinct cards. |
| SDXC 64GB | 2026-06-24 | Same as above. |
| SDXC 240GB | 2026-08-17 (active through 08-22) | **GoPro/action-cam structure** — DCIM/100MEDIA, 101MEDIA, 102MEDIA. **102MEDIA is confirmed the raw source of Cheryl H.'s (Part 1, #3) drone photos** — byte-identical file sizes on the DJI_0401–DJI_0410 range. 100MEDIA (DJI_0991–0999+, dated 08-17) and 101MEDIA (dated 08-22) use a different numbering block and are **not** yet traced to any CUSTOMERS-tree job — worth a dated/GPS cross-check in a follow-up. |
| HSFTOOLS THERMAL | 2026-05-13 | Thermal camera dump (DCIM/202605 + a `log` folder). Matches the timeframe of the already-published `blue-ash-oh-roof-vents-thermal-2026` card — most likely already-used material, not new. |
| InternalStorage | 2026-08-26 | **A drone's internal storage** (DCIM/DJI_001), separate device from the SDXC 240GB card. Stills are dated 2026-09-13/14 by filename — **does not match the capture dates of any Part-1 candidate** (closest is Chris R., whose drone shots are 09-11 and 09-15). This looks like a genuinely un-triaged, un-matched flight. Each subfolder sampled paginated past its first request (i.e., 50+ files each), consistent with Jo's "thousands" — most of that volume sits in the SDXC 240GB MEDIA folders and this DJI_001 folder, not in the two old personal drives.

**(a) Order of magnitude:** thousands is plausible in aggregate — every
DCIM/MEDIA subfolder sampled had 50+ files and paginated past the first
page. Effective *unique, job-relevant* volume is much smaller once you
discount: the two 2017 personal drives, the apparent triple-imaging of one
Android/GoPro card across three folders, and the thermal folder that's
likely already spent on a published card.

**(b) Era/nature:** a mix — two are old personal/school data (2017), three
are probably repeated dumps of the same general-use Android/GoPro SD card
(2024–2026, not job-curated), one is a thermal-camera SD card tied to a
published job, and two (SDXC 240GB, InternalStorage) are recent,
job-adjacent camera dumps with real drone/action-cam content from
August–September 2026.

**(c) Job-related subfolder names worth a focused follow-up:** none of the
subfolder *names* are customer names, addresses, or brand names (JKRC/MLR/
ORC/SPR) — everything is generic device-folder naming (DCIM, 100MEDIA,
DJI_001, etc.), so there's nothing to grep for by name. The two threads
worth a dedicated session: **SDXC 240GB/100MEDIA + 101MEDIA** (un-matched
GoPro block, Aug 17–22) and **InternalStorage/DJI_001** (un-matched drone
flight, Sept 13–14) — both fit the GPS/date cross-match pattern already
used for orphaned SD-card rolls against CRM leads.

**(d) Overlap with the 08-28 sweep:** partial. The 08-28 sweep never opened
this folder tree at all (it covered MLR/JKRC/ORC/SPR/THP/GRANDIR/
NBD-customers only), so nothing here was "covered" in the sense of being
seen before. But in practice one card (SDXC 240GB/102MEDIA) turned out to
be the direct source of photos already imported into the CUSTOMERS tree
(Cheryl H.), and the thermal folder is very likely already spent on a
published card — so mining those specific two would be **redundant**.
Everything else in this tree (100MEDIA/101MEDIA, InternalStorage/DJI_001,
and the full DCIM trees of the three generic Android/GoPro dumps that
weren't opened past the top folder level) is **net-new and unscreened**.

**Verdict:** don't mine the two 2017 personal drives or the thermal folder —
low/no yield. A focused follow-up on SDXC 240GB's 100MEDIA/101MEDIA and
InternalStorage's DJI_001, cross-matched by capture date and (if EXIF GPS
is present) against CRM lead coordinates, is the highest-value next step.
The three generic SDXC/MICRO SD Android dumps need at least one
DCIM-content sample each before ruling them in or out — this pass only
confirmed their top-level folder structure, not what's actually inside
DCIM.
