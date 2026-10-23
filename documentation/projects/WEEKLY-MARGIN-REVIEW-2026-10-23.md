# Weekly margin review (2026-10-23)

**Why:** Jo wants to know which finished jobs made less than usual and why, once a week. Queue item 5 in [BUSINESS-QUEUE-RECON-2026-10-22](BUSINESS-QUEUE-RECON-2026-10-22.md). **CRM-internal only: no cost, contractor or margin figure goes under `docs/`** (guard: `tests/catalog-cost-privacy.test.js`; this tool also has its own scan of `docs/`).

**What it is:** a read-only agent tool, `margin_review`, for Frank (Finance) only, in `functions/agent-mcp-logic.js` (`marginReview`, built on the existing `jobProfit` so the two cannot disagree) with the handler in `functions/agent-mcp.js`. Frank calls it, then files the result with `file_report` into the Agent inbox, where Jo reads it. It sends nothing to anyone and writes nothing itself.

**Rules (assumptions Jo can change):**
- Window: jobs finished in the last N days (default 7, 1 to 60).
- Baseline: the company own margin on judged jobs finished in the 90 days before the window, weighted by collected dollars. Needs 3 or more judged jobs, otherwise it says there is not enough history and flags nothing.
- Flag: a window job at least 5 points under the baseline (5 exactly counts). Worst first.
- Reason: the direct cost category with the biggest share of what was collected (for example "materials, 60% of collected"). Overhead never counts against a job.
- Judged = collected money above zero and at least one direct cost logged. A job with no costs logged would overstate profit, so it is counted as skipped, not judged. Money not collected is not margin.
- Cents math throughout; output is whole percent. At most the 50 most recent finished jobs are read (`capped` says so).

**Test:** `tests/margin-review-2026-10-23.test.js` (17 checks: boundary, skipped, thin baseline, no payments, Frank-only, read-only, docs scan; 7 mutations tried, all caught).

**Not built on purpose:** no scheduled function (a cron that files to prod needs a deploy and a messaging-style review), no CRM screen. A weekly routine for Frank can call the tool.
