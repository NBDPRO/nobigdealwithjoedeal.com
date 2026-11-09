# Session 2026-11-09: credentials "Fix now" (built)

Branch `cred-fixes` (worktree `.claude/worktrees/cred-fixes`), from `main` after the NBD OS P3 merge. Builds section 3 "Fix now" of the plan note `CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09` ([CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09](CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md), which now points here from section 3). Source of truth throughout: [docs/assets/data/credentials.json](../../docs/assets/data/credentials.json); only `status: "active"` rows may be claimed. Runbook updated: [ADD-A-CREDENTIAL](../runbooks/ADD-A-CREDENTIAL.md).

## What was built

1. **AI assistant's credential list.** `functions/agent-mcp-logic.js` `rulesReference().credentials` listed "IKO ROOFPRO Advantage"; IKO is held (pending, not public) in the data file. Removed. `functions/` cannot read `docs/` at runtime, so the list stays in code and a test pins it to the active rows: one certification per active manufacturer row (issuer + contractor ID, in order), one membership per active membership row, the insurance wording in the note, no held row and no stray issuer. The old IKO-present assertion in `tests/agent-tenant-bots-2026-10-04.test.js` is flipped.
2. **llms.txt credentials region.** The hand line in `docs/llms.txt` had drifted (TAMKO "certified July 8, 2026" vs `since: 2026-07`; American Operator missing; GAF's generic locator instead of its profile link). `scripts/build-llms.mjs` now owns a fourth region, `LLMS:CREDENTIALS`, rendered from the active rows with the same facts as the /credentials cards; a forbidden claim word (Master Elite, President's Club, Licensed) is fatal. `--check-regions` (CI) covers it. The warranty sentences and Acorn Finance stay hand prose outside the region.
3. **Footer disclaimer.** The cert-bar independence sentences in the four footer partials named GAF and TAMKO only; /credentials names James Hardie too. Both now name GAF, TAMKO and James Hardie (partials restamped onto 277 pages; the 13 pages that carry the same footer by hand were edited the same way, outside any marker region). Decision: no Hardie trademark clause, because no Hardie mark or name is shown in the footer badges; American Operator stays out of the independence line on both surfaces (it is a locally-owned certification, not a manufacturer program).
4. **Verify links: left as they are.** No NBD-specific TAMKO profile URL or American Operator listing URL is recorded anywhere in `documentation/` or the data files (only `tamko.com/locate-a-contractor` and the American Operator homepage; [SESSION-2026-08-13-american-operator-badge](SESSION-2026-08-13-american-operator-badge.md) notes American Operator has no per-business pages). Nothing was invented. Jo can paste the real URLs into `verifyUrl` if the issuers give him one, then run `build-credentials.mjs` and `build-llms.mjs --write-regions`.

## Tests

New suite `tests/credentials-surfaces-2026-11-09.test.js` (node bucket; floors 1037/74/1176 after the rebase below): A agent list, B llms region content, C footer vs /credentials issuer set. Each section was shown red before its fix. `tests/build-llms-modes.test.js` gains: holding a row back turns `--check-regions` red and `--write-regions` fixes it; a Master Elite name is fatal.

## Open

- Real profile verify links for TAMKO and American Operator, if the issuers provide them.

## Update 2026-11-09: independent review acted on

Verdict was approve. One required step and seven non-blocking findings.

- **Rebased** onto `claude/funny-hawking-t9zyzm` (the Q11 integration branch, which now carries the plan note). The FLOORS conflict was resolved to 1037/74/1176 with a rewritten dated comment, as `--check` measures. The first commit's message still says 1026/74/1164, which was true before the rebase. On the merged tree, `apply-partials --check`, `build-llms --check-regions` and `build-credentials --check` are clean.
- **Fixed: the 13 hand-carried footers were untested.** Section C now scans every `docs/` page with the cert bar (290), outside `/pro`. A local revert of `docs/index.html` turned it red.
- **Fixed: the llms.txt heading promised a verify link for every row.** Insurance and James Hardie have no `verifyUrl`. The heading now says a verify link follows each one the issuer lists publicly. Pinned (red, then green).
- **Not changed: `gaf-timberline` line 921, and `tamko-impact-resistant-shingles` line 962, which the reviewer did not list.** These are page-specific copyright and trademark lines that name the marks those pages show. They are not the site-wide independence list, and the test leaves them out on purpose. The same goes for blog posts saying "either manufacturer".
- **Not changed: `scripts/add-footer-cert-bar.js`.** It is a one-off 2026-07-20 sweep that nothing runs. It also predates the American Operator and Hardie badges, so editing only its sentence would still leave it producing a stale cert bar. If anyone revives it, it should stamp the footer partial instead. Mentioned for the PR body.
- **Not changed: "American Operator certifies No Big Deal...".** This is the `summary` in `credentials.json`, and it is the same on /credentials and in the footer alt text. Making it agree with the AI note "Memberships are never 'certified'" is Jo's wording call in the data file.
- **Not changed: the logic copied between `build-llms.mjs` and `build-credentials.mjs`.** `build-credentials.mjs` validates and runs at import, so it can't be imported. `build-llms-modes` and section B cover the copy. Extracting a shared module would be a refactor nobody asked for.
