# DECISIONS
- Ports: use 18431 (8080/8765 busy with unrelated apps).
- Did not chase mobile TBT: observed long tasks are first style/layout (278+164 ms), scripting 16 ms; run-to-run swing on this machine exceeds any plausible gain.
- Did not touch the CRM bundling/script-count problem: Jo has concat/bundles worktrees in flight (nbd-wt-concat*, nbd-wt-bundles).
- Fallback hex swap kept as same-length edit so each file's EOL is untouched; comments/tests/docs/sites left alone.
