# Drive photo inventory — 2026-08-17 (full-drive sweep)

Jo asked for a deep look across "other devices and storage… USB files or the
SD card", guaranteeing 6–8k photos. An exhaustive agent walk of the whole
Drive (keyset-cursor pagination over `mimeType contains 'image/'` — the MCP's
own pageToken re-serves pages, so treat totals as a tight floor) found:

- **≈9,995 images** (Jo's guess was low) and **2,424 videos** (~1,100 of the
  videos are a personal TV-series archive, not job footage).

This note is the reusable map. Companion notes:
[SESSION-2026-08-17-photo-credibility-tarping-seo](SESSION-2026-08-17-photo-credibility-tarping-seo.md)
(what's already been scanned/published) ·
[rush-week addendum](../marketing/rush-week-2026-08.md) (what the photos feed).

## Device / backup roots

| Root | What's inside | Images |
|---|---|---|
| **USB Devices & SD Cards** (Drive folder at My Drive root) | Six device dumps — see card table below | 5,931 |
| **COMPANIES** (curated business tree) | Four brands: **NBD**, **ORC**, **SPR**, **MLR** (Mad Ladder Roofing — Jo's own prior brand; the 2025 "Mad Ladder" tarp-fee invoice is in-family, not a competitor's) | 3,335+ |
| **ASUS ROG 14** (laptop sync) | E:-drive image incl. **DCIM/101MEDIA — 235 DJI, July 2026, the newest job flying, on no SD card** + Documents copies of SPR/MLR trees | ~300 |
| TOWER / My Laptop (PC syncs) | Downloads only | 18 |
| Personal (old phone "Pictures", 2011 Fuji orphans, USB wallpapers) | Non-job | ~500 |

## The SD cards (all DJI drone rolls; heavy overlap — dedupe before bulk use)

| Card | Rolls (images) | Notes |
|---|---|---|
| SDXC 240GB | 100MEDIA (627) · 101MEDIA (952) | **Scanned 2026-08-17** (sampled). Source of the published tarp + guards + algae crops |
| SDXC Card | 101–106MEDIA (206 / 878 / 546 / 74 / 165 / 338) = 2,291 | **Unscanned.** 102MEDIA (878) + 103MEDIA (546) are the biggest unscanned rolls anywhere |
| SDXC 64GB | 101–107MEDIA = 1,660 | 102/103MEDIA duplicate "SDXC Card" 1:1; **107MEDIA (96) scanned** — source of the installed-screens shot |
| MICRO SD 64GB | 103–105MEDIA = 223 | Oldest drone archive (2025) |
| HSFTOOLS THERMAL | 202605 (130 thermal) | Thermal-inspection imagery (Customer BX job; same set duplicated in her customer folder). **Differentiated marketing material** — nobody else in the market shows thermal moisture scans |
| USB30FD / SANDISK 256 | wallpapers, old school files | Non-job |

## Curated customer sets (COMPANIES/NBD/CUSTOMERS — 2,250 imgs, 25+ folders)

Largest: Customer FO Phone shots (269 HEIC) · Customer BR Build Day drone
(263 ×2 exact-duplicate folders + 63 loose) · Customer BX (136 iPhone + 130
thermals) · Customer BY (121) · Troy (105) · Jennifer Customer DR (175) ·
Customer EE (77) · Customer FS (70) · Customer G (69) · Louie (69).
ORC brand adds 224 (Customer DO 90…); SPR adds 166 (duplicated under ASUS ROG
Documents). iPhone sets are HEIC — **decode with `heic-convert` (npm), the
repo's sharp build can't read HEVC**; some .HEIC files are secretly JPEG.

## Sensitivity flags

- **"Scans to Sort" = bank checks + receipts (~100 PDFs), zero images** —
  never anything from there on the public site.
- MLR Drive-takeout under ASUS ROG Documents contains staff-account exports
  (staff-account emails removed) — internal, keep private.
- Standing photo rules from the credibility session apply to everything
  here: EXIF strip via `prepare-project-images.mjs`, anonymous crops for
  non-consented properties, condition-not-claim captions, no manufacturer
  marketing assets.

## Scan status / queue

- ✅ Sampled + harvested: SDXC-240GB 100/101MEDIA, 64GB 107MEDIA, Gutters
  folder, loose damaged-gutter JPEGs (7 photos published via PR #1227).
- ✅ ASUS ROG E:/DCIM/101MEDIA — **actually ~937 files (DJI_0001–0944,
  Jun 1–Jul 6 2026), not the 235 the inventory pass counted** (pagination
  jitter). 21 hits kept in scratchpad. Verdicts: Gary's "7980" house
  appears in the **Jul 4 pre-job survey** (0712 existing screens,
  0714/0716 failing gutters) — completed-install afters are NOT in this
  roll (ends Jul 6, proposal dated Jul 9); the 20MB full-res frames
  DJI_0705–0709 exceed the Drive-MCP 10MB cap and remain unviewed.
  Second tarp job found (0305/0309, Jun 7 — spares). **Featured-project
  candidate, gallery-ready: the July brick Tudor duplex re-roof** —
  process 0728 (FeltBuster + staged HDZ), action 0842, finished 0880,
  box-gutter reline 0888/0904, flashing 0896. Needs Jo: customer name,
  city, consentOnFile, price-range-or-skip → then a PUBLISH-PROJECT run.
- ✅ Customer FO Phone shots — 145 unique of 269 records (half are duplicate
  uploads). Moss macro published; guards close-ups (IMG_6391/6426) and a
  15-shot inspection-storytelling series banked as spares.
- 🔔 NBD > INTERNAL > Content > **Soft Wash** folder created by Jo
  2026-08-17 22:02Z — empty at 22:10Z, watch armed; first real
  soft-wash job photos expected to land there.
- ⏭ Next best: SDXC Card 102MEDIA (878) → covers its 64GB twin ·
  103MEDIA (546) · MICRO SD 103MEDIA (168, 2025 archive) · thermal set
  (marketing content, not the current three categories).
- Dedup rule of thumb: scan "SDXC Card" rolls, skip "SDXC 64GB" twins;
  prefer customer-named folders over raw rolls when both exist.
- Tooling caps to remember: Drive-MCP downloads fail >10MB (48MP DJI
  frames); use the laptop/Drive web for those. HEIC → `heic-convert`.
