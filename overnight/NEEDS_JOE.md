# NEEDS_JOE
1. Homepage portrait hero video is ~0.9-2 MB on phones (starts after load+idle, does not move LCP). Recommendation: ship a lighter phone cut or skip on cellular (Save-Data / effectiveType) — your call, it is a visible brand asset.
2. `tests/` has no automated mobile TBT budget locally; perf-watch.yml already measures the live site weekly. Recommendation: leave as is.
3. Stray empty dir `C:\c\Users\jonat\AppData\Local\Temp\lhtest` from a path slip; safe to delete (I was blocked from removing it).
4. Service-page hero photos are 800 px wide and show about 1.8x upscaled on 1440 px screens (siding, gutter, commercial, interior pages). A sharper desktop hero needs 1600 px re-exports from the original photos (not in the repo). Recommendation: re-export the ~14 service hero photos at 1600 px next time you are in the photo library, then add a -1600 variant to the hero srcset.
