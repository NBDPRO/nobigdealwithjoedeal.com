# NEEDS_JOE
1. Homepage portrait hero video is ~0.9-2 MB on phones (starts after load+idle, does not move LCP). Recommendation: ship a lighter phone cut or skip on cellular (Save-Data / effectiveType) — your call, it is a visible brand asset.
2. `tests/` has no automated mobile TBT budget locally; perf-watch.yml already measures the live site weekly. Recommendation: leave as is.
3. Stray empty dir `C:\c\Users\jonat\AppData\Local\Temp\lhtest` from a path slip; safe to delete (I was blocked from removing it).
5. The /inspect header shows the logo image and then the words "NO BIG DEAL / Home Solutions" beside it, so the brand name reads twice (the logo image already says it). Every other tool/booking page shows the logo alone. Recommendation: drop the text block and give the image alt="No Big Deal Home Solutions" (it has alt="" today); I left it because it is the main lead page and a deliberate-looking layout.
