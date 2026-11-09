# Session 2026-11-09: credentials "Fix now" (built)

Branch `cred-fixes` (worktree `.claude/worktrees/cred-fixes`), from `main` after the NBD OS P3 merge. Builds section 3 "Fix now" of the plan note `CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09` (on branch `plan-note`; not yet on `main`, so this note stands in for its "Built" section). Source of truth throughout: [docs/assets/data/credentials.json](../../docs/assets/data/credentials.json); only `status: "active"` rows may be claimed. Runbook updated: [ADD-A-CREDENTIAL](../runbooks/ADD-A-CREDENTIAL.md).

## What was built

1. **AI assistant's credential list.** `functions/agent-mcp-logic.js` `rulesReference().credentials` listed "IKO ROOFPRO Advantage"; IKO is held (pending, not public) in the data file. Removed. `functions/` cannot read `docs/` at runtime, so the list stays in code and a test pins it to the active rows: one certification per active manufacturer row (issuer + contractor ID, in order), one membership per active membership row, the insurance wording in the note, no held row and no stray issuer. The old IKO-present assertion in `tests/agent-tenant-bots-2026-10-04.test.js` is flipped.
2. **llms.txt credentials region.** The hand line in `docs/llms.txt` had drifted (TAMKO "certified July 8, 2026" vs `since: 2026-07`; American Operator missing; GAF's generic locator instead of its profile link). `scripts/build-llms.mjs` now owns a fourth region, `LLMS:CREDENTIALS`, rendered from the active rows with the same facts as the /credentials cards; a forbidden claim word (Master Elite, President's Club, Licensed) is fatal. `--check-regions` (CI) covers it. The warranty sentences and Acorn Finance stay hand prose outside the region.
3. **Footer disclaimer.** The cert-bar independence sentences in the four footer partials named GAF and TAMKO only; /credentials names James Hardie too. Both now name GAF, TAMKO and James Hardie (partials restamped onto 277 pages; the 13 pages that carry the same footer by hand were edited the same way, outside any marker region). Decision: no Hardie trademark clause, because no Hardie mark or name is shown in the footer badges; American Operator stays out of the independence line on both surfaces (it is a locally-owned certification, not a manufacturer program).
4. **Verify links: left as they are.** No NBD-specific TAMKO profile URL or American Operator listing URL is recorded anywhere in `documentation/` or the data files (only `tamko.com/locate-a-contractor` and the American Operator homepage; [SESSION-2026-08-13-american-operator-badge](SESSION-2026-08-13-american-operator-badge.md) notes American Operator has no per-business pages). Nothing was invented. Jo can paste the real URLs into `verifyUrl` if the issuers give him one, then run `build-credentials.mjs` and `build-llms.mjs --write-regions`.

## Tests

New suite `tests/credentials-surfaces-2026-11-09.test.js` (node bucket; floors 1026/74/1164): A agent list, B llms region content, C footer vs /credentials issuer set. Each section was shown red before its fix. `tests/build-llms-modes.test.js` gains: holding a row back turns `--check-regions` red and `--write-regions` fixes it; a Master Elite name is fatal.

## Open

- The plan note itself (branch `plan-note`) should get a dated "Built" pointer to this note when both land.
- Real profile verify links for TAMKO and American Operator, if the issuers provide them.
