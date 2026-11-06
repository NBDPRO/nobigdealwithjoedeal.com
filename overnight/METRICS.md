# METRICS

Local server `scripts/overnight-serve.mjs` (gzip, cleanUrls), Lighthouse 12.8.2, median of 2 runs, mobile = 390x844 simulated slow 4G + 4x CPU.
Raw LHR JSON under `baseline/lh/before/` (not committed). Machine benchmarkIndex ~1300 and shared with other work, so TBT is noisy (±300 ms).
Pages: /, /services/{roof-replacement,roof-repair,roof-inspection,storm-damage,siding-replacement,gutter-replacement,hail-damage-insurance-claim}, /inspect, /our-work, /pro/login (no /contact page exists; /inspect is the lead form).

## BEFORE
| Page | Form | Perf | A11y | BP | SEO | FCP ms | LCP ms | CLS | TBT ms | SI ms | KB | Req | Unused CSS/JS KB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| / | mobile | 79 | 100 | 96 | 100 | 1573 | 3056 | 0 | 552 | 2385 | 1317 | 51 | 0/0 |
| / | desktop | 99 | 100 | 96 | 100 | 409 | 1006 | 0.001 | 0 | 691 | 2555 | 51 | 0/0 |
| /services/roof-replacement | mobile | 94 | 100 | 96 | 100 | 1713 | 2876 | 0 | 65 | 1713 | 354 | 42 | 0/0 |
| /services/roof-replacement | desktop | 99 | 100 | 96 | 100 | 680 | 881 | 0 | 43 | 820 | 283 | 42 | 0/0 |
| /services/roof-repair | mobile | 80 | 100 | 96 | 100 | 1625 | 3070 | 0 | 540 | 1715 | 353 | 39 | 0/0 |
| /services/roof-repair | desktop | 100 | 100 | 96 | 100 | 418 | 723 | 0.001 | 0 | 561 | 285 | 40 | 0/0 |
| /services/roof-inspection | mobile | 73 | 100 | 96 | 100 | 2003 | 3313 | 0 | 702 | 2003 | 346 | 39 | 0/0 |
| /services/roof-inspection | desktop | 100 | 100 | 96 | 100 | 404 | 684 | 0.001 | 10 | 578 | 287 | 40 | 0/0 |
| /services/storm-damage | mobile | 74 | 100 | 96 | 100 | 1831 | 3397 | 0 | 642 | 1831 | 404 | 39 | 0/0 |
| /services/storm-damage | desktop | 100 | 100 | 96 | 100 | 382 | 708 | 0.001 | 0 | 519 | 320 | 40 | 0/0 |
| /services/siding-replacement | mobile | 93 | 100 | 96 | 100 | 1522 | 2872 | 0 | 147 | 1533 | 236 | 37 | 0/0 |
| /services/siding-replacement | desktop | 100 | 100 | 96 | 100 | 405 | 659 | 0.001 | 0 | 539 | 236 | 39 | 0/0 |
| /services/gutter-replacement | mobile | 71 | 100 | 96 | 100 | 1840 | 3464 | 0 | 782 | 2005 | 393 | 39 | 0/0 |
| /services/gutter-replacement | desktop | 98 | 100 | 96 | 100 | 598 | 861 | 0 | 96 | 773 | 667 | 44 | 0/0 |
| /services/hail-damage-insurance-claim | mobile | 92 | 100 | 96 | 100 | 1515 | 3169 | 0 | 82 | 1515 | 386 | 38 | 0/0 |
| /services/hail-damage-insurance-claim | desktop | 99 | 100 | 96 | 100 | 578 | 837 | 0 | 69 | 664 | 296 | 38 | 0/0 |
| /inspect | mobile | 93 | 100 | 96 | 100 | 1165 | 2000 | 0 | 276 | 1165 | 135 | 23 | 0/0 |
| /inspect | desktop | 100 | 100 | 96 | 100 | 350 | 469 | 0 | 39 | 423 | 129 | 23 | 0/0 |
| /our-work | mobile | 96 | 100 | 96 | 100 | 1789 | 2539 | 0 | 0 | 1789 | 580 | 45 | 0/0 |
| /our-work | desktop | 100 | 100 | 96 | 100 | 527 | 667 | 0 | 56 | 607 | 484 | 46 | 0/0 |
| /pro/login | mobile | 95 | 100 | 93 | 54 | 2232 | 2580 | 0.009 | 29 | 2232 | 421 | 34 | 17/156 |
| /pro/login | desktop | 100 | 100 | 96 | 54 | 599 | 734 | 0.01 | 0 | 599 | 380 | 28 | 17/131 |

axe (390/1440): only `region` (1 node mobile, 4 desktop) on every public page; /inspect desktop and /pro/login clean.
Console/404 locally: `/api/google-reviews` 404 and `/pro/nosw.txt` 404 (functions rewrite and demo SW probe; not served by static server, expected).
Horizontal overflow at 390: 0 on every page.

## AFTER (main with #2899 and #2900 merged; 4 pages, 2 runs median)

| Page | Form | Perf | A11y | BP | SEO | FCP ms | LCP ms | CLS | TBT ms | SI ms | KB | Req | Unused CSS/JS KB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| / | mobile | 94 | 100 | 96 | 100 | 1518 | 2974 | 0 | 83 | 1817 | 1317 | 51 | 0/0 |
| / | desktop | 97 | 100 | 96 | 100 | 513 | 1039 | 0 | 111 | 893 | 2556 | 51 | 0/0 |
| /services/roof-repair | mobile | 75 | 100 | 96 | 100 | 1582 | 3226 | 0 | 718 | 1898 | 354 | 39 | 0/0 |
| /services/roof-repair | desktop | 99 | 100 | 96 | 100 | 398 | 685 | 0.001 | 76 | 648 | 286 | 40 | 0/0 |
| /services/roof-inspection | mobile | 76 | 100 | 96 | 100 | 1757 | 3285 | 0 | 604 | 1876 | 347 | 39 | 0/0 |
| /services/roof-inspection | desktop | 99 | 100 | 96 | 100 | 575 | 813 | 0 | 88 | 718 | 287 | 40 | 0/0 |
| /pro/login | mobile | 98 | 100 | 93 | 54 | 1727 | 2098 | 0.008 | 70 | 1727 | 421 | 34 | 17/156 |
| /pro/login | desktop | 100 | 100 | 96 | 54 | 555 | 661 | 0.033 | 0 | 555 | 380 | 28 | 17/131 |

Mobile TBT moves +/-300 ms between runs on this machine; public-page Perf differences are noise (no script or LCP change). Only visible metric change: /pro/login desktop CLS 0.010 -> 0.033 (new split layout, under 0.1). Raw JSON not committed.
