# Overnight 2026-11-06: project detail gallery thumbnails

An image-size sweep of all 298 pages found the case-study gallery (`/our-work/<slug>`, 157 to 341 px wide on a phone)
loading the full 800 px files for photos 2 to N; only each job's hero had -400/-640 copies. New
`scripts/build-project-thumbs.mjs` (dry run / `--apply` / `--check`) makes `<name>-400.webp` / `-400.avif` for every
manifest photo copy that lacks one (287 files, 5.7 MB, average 20 KB against about 55 KB for the 800 px file), resized from the
committed, already EXIF-stripped copies (`check-image-privacy` clean). `scripts/build-projects.mjs` now offers them through
`<picture>` (`srcset` 400w + 800w, `sizes="(max-width: 768px) 45vw, 290px"`); 48 detail pages restamped (248 lines).
Measured on `/our-work/amelia-oh-gambrel-ridge-repair-2026` (all images fetched): 390 px at 3x DPR 221 KB -> 148 KB,
1280 px at 1x 148 KB -> 97 KB.

Sweep leftovers, not fixed: service-page hero photos are 800 px wide and show upscaled (about 1.8x) on 1440 px screens
(`/services/siding-repair`, `-replacement`, `gutter-*`, `commercial-roofing`, ...). A sharper desktop hero needs 1600 px re-exports from
the original photos, which are not in the repo; see NEEDS_JOE. Back to [INDEX](../INDEX.md).
