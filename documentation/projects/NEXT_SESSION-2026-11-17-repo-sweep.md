# NEXT SESSION, 2026-11-17: after the repo sweep

**Start here.** This follows [NEXT_SESSION-2026-11-09-close](NEXT_SESSION-2026-11-09-close.md). That brief's §2-§3 items (the prod runs waiting on a Firestore token, the Hardie footer line) are still open and are carried in §5 below.

On 11-17 a read-only sweep ([REPO-SWEEP-2026-11-17](../audit/REPO-SWEEP-2026-11-17.md)) found 28 verified findings. Every one now has a PR. Each fix started with a failing test and passed an independent review with two skeptics per finding.

## 1. Merged

| PR | What |
|---|---|
| #3127 | M1 tenant deposit on re-tier; M2 custom-stage roles on the customer page |
| #3128 | M3 "Email My Estimate": server-built email, passed-Turnstile gate, 3 per IP per day |
| #3129 | Operator scripts dry-run unless `--apply`; provision refusals; DEMO kept; admin claims merged; photo upload/sweep fixes |
| #3132 | The six call-to-close suites pass on a Windows CRLF checkout |
| #3133, #3139 | The sweep audit note and its status table |
| #3135 | Lows, server: Stripe invoiceWebhook marker, Thursday kill switch, ET due date, admin analytics fail-closed, /inspect late answers carried by the lead bridge |
| #3137 | Lows, site: breadcrumb JSON-LD + redirect-URL guard, /sites canonical, visualizer label |
| #3138 | Lows, service worker: API allowlist (reviews + storm layer, capped), dead write queue removed, tile hosts only, no-store never-cache pages |

## 2. Open, and the order to land them

1. **#3131 pricing** (Job Templates use the Settings rates and Round to, cents rollup, tenant supplement deposit). Auto-merge is on.
   - Your template prices move only if your saved rates aren't 25/10/10. The first template preview says so once.
   - Line-item totals move only if your "Round to" isn't $25.
2. **#3136 lows, CRM** (e-sign source locked + hash check, tenant warranty picker, stage label as text).
   - **Rebase it after #3131 lands**: both bump `script-loader.js` and `customer.html` versions.
   - Then re-run its suite and `asset-version-consistency-2026-11-14`, push, and turn auto-merge on.
3. **#3145 leftovers** (rotateAccessCodes no longer kills DEMO, seed `--apply` prompt, dead sync listener, local test budget 40 min + floors, `/pro` no-store). Auto-merge is on.
   - If it lands after #3131 and #3136, `run-test-manifest --check` will warn that the floors are stale by their new suites. That is a warning, not a failure; set the floors to what `--check` prints.

## 3. Jo's answers on 11-17 (so they are not asked again)

- **Scripts:** prod-writing operator scripts write only with `--apply`. `provision-tenant.js` needs `--force` to move an account, demote a platform admin, or reassign an owned company.
- **DEMO** stays public: neither the seed script nor `rotateAccessCodes` touches it.
- **Estimate email:** built server-side from numbers only. It needs a Turnstile check that really passed, and is limited to 3 per IP per day. Old cached pages get a no-numbers email. Joe's voice stays.
- **Pricing:**
  - Templates follow Settings rates, with a one-time note.
  - Line items follow "Round to".
  - Flipping a pin that covers only the 1¢ rounding is OK'd.
- **`thursday_config.enabled`** stays a widget-only switch. `thursdayExtractDisabled` / `aiDisabled` are the no-deploy stops for Thursday AI spend.
- **PRs:** auto-merge on everything except pricing, which Jo looks at (it later had auto-merge on too).

## 4. Known follow-ups (small, not started)

- **/inspect thank-you answers:** if the lead bridge has already run when the answers arrive and every CRM merge try misses, the answers stay only on the public doc, marked `crmIntakePending`. Nothing reads that mark yet.
- **Stripe:** a look in the Stripe dashboard at which event types each webhook endpoint subscribes to would confirm how often the old shared marker actually cost an event.
- **Comment:** `photo-queue-store.js`'s header still describes the removed `flushOfflineQueue`. Leave it until a change re-versions that file anyway.

## 5. Still waiting on Jo, carried from 11-09-close (unchanged)

- **Prod runs:** each needs a Firestore token and Jo's OK per run (CLAUDE.md rule f).
  - The Q11 cleanups
  - The cost book v3 diff
  - The leaderboard check
  - The retention log
  - NBD OS on for all of NBD
- **Hardie footer line:** needs CI visual baselines committed from GitHub.
- **Real-iPhone pass** over the Daily Success PRs.
- **Photo matcher and upload:** run on Jo's computer, dry run first. `upload-job-photos.js` is now create-only in Storage, finds the older NBD leads, and exits non-zero on any failure (#3129).

## 6. Sandbox notes

- The full node bucket takes about 10-11 minutes on this Windows machine. Since #3145 the runner gives a local run 40 minutes (`NBD_TEST_BUDGET_MIN` overrides).
- Emulator suites (`firestore-rules.*`, `lead-bridge.integration`) and Playwright suites (`ds-flow-batch-*`) can't run here; CI runs them.
- A git worktree has no `node_modules`. Junction the main checkout's `functions/node_modules` to run functions suites there, and remove the junction with `rmdir` (it removes only the link) before `git worktree remove`.
