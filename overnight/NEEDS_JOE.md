# NEEDS_JOE
1. Homepage portrait hero video is ~0.9-2 MB on phones (starts after load+idle, does not move LCP). Recommendation: ship a lighter phone cut or skip on cellular (Save-Data / effectiveType) — your call, it is a visible brand asset.
2. `tests/` has no automated mobile TBT budget locally; perf-watch.yml already measures the live site weekly. Recommendation: leave as is.
3. Stray empty dir `C:\c\Users\jonat\AppData\Local\Temp\lhtest` from a path slip; safe to delete (I was blocked from removing it).
