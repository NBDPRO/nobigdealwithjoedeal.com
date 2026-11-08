# NEXT_SESSION, 2026-11-08: CRM power session (lane note)

A lane note, not the live brief: see the **Current handoff** pointer in [INDEX](../INDEX.md). Jo asked for the site or
the CRM, audited in layers, aimed at cleaning up code, improving the site and upgrading the CRM. The pick was the CRM;
the audit and its reasoning are in [CRM-POWER-SESSION-AUDIT-2026-11-08](../audit/CRM-POWER-SESSION-AUDIT-2026-11-08.md).
It continues the CRM audit lane ([NEXT_SESSION-2026-11-07-crm-audit](NEXT_SESSION-2026-11-07-crm-audit.md)).

## What this session shipped (branch `claude/funny-hawking-t9zyzm`, draft [#3016](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3016): one commit per lane plus three follow-through commits from the full bucket)

| Commit | Lane | What |
|---|---|---|
| `perf(pro): six flag-gated toolbar features…` | boot weight | stale-leads clean-up, lead-source fixer, speed to lead, reputation, the two follow-up boards: lazy ScriptLoader bundles loaded by `js/dark-features.js` when the flag is on. Shipped boot JS 2,858 → 2,741 KB, tags 215 → 207, six boot timers gone. Ceilings lowered to 207 / 2,748 KB. |
| `fix(pro): NBD OS: DND keeps undo toasts…` | fresh code | three confirmed P2s from an independent review of #2989: DND and the object form of `showToast`, DND shown on the phone clock, a bar long-press no longer also taps Record. |
| `fix(pro): filed dates survive a re-save…` | open findings | PL-F10, ST-F61, ST-F63, ST-F24, test-first, none touching money or a held draft's files. |
| `docs(audit): CRM power session…` | vault | the audit note, linked from INDEX. |

Every commit: new suite red against main's files, green here; the suites around the touched files, the boot budget,
syntax, site-integrity, partials, sitemap, inline-scripts, projects, llms and vault gates all green; the full node
bucket green on the first lane's tree (the final tree's run is in the PR body).

## Waiting on Jo

1. **The boot-budget ceiling.** It was LOWERED (2,864 → 2,748 KB shipped; 215 → 207 tags) to keep the gate biting
   after the 117 KB left the boot path, with about 7 KB of headroom on purpose. That is enough for the two drafts held
   on the budget ([#2994](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2994) ~0.5 KB,
   [#3008](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3008) ~0.7 KB) once this PR merges and they are
   rebased: no ceiling raise needed any more. Jo's call whether 7 KB is the right slack.
2. **The held drafts from the audit lane are unchanged:** #2941 and #2942 (MONEY, line by line), #2981 (tenant stage
   emails, wording), #2994 and #3008 (budget, see above), #2919 (/inspect header).
3. **[NEEDS_JOE](../../overnight/crm/NEEDS_JOE.md)** is unchanged; nothing here touched estimate math, template content
   or warranty strings.

## Good next work, in order (no Jo needed)

1. **Boot weight, next pass**, from the candidate map in the audit note: `ky-insurance-law.js` (27 KB, read by document
   code only) into the docgen bundle, also on customer.html; `numbers-logic.js` (17 KB) with Reports; then read
   `my-skin.js` (50 + 22 KB) to see whether a user without a skin needs it at boot, and re-check why `deposit-rule.js`
   (24 KB) is still eager when only a lazy file reads it today. Register bundles at runtime from a deferred file; never
   edit `script-loader.js` (blocking, at its 85 KB ceiling).
2. **Fresh-code P3s** (file:line in the audit note): `route-drive.js` logs nothing on a 404 and the client memoises
   `not_supported` for 10 min; `mission.js` caches a failed matrix per mount; the `osSystemLayer:false` kill switch on a
   first load; the "NBD" mark and "NBD OS" name for other tenants; the lock screen's 15 s repaint and dead `os-locked`
   class; the unguarded `NBDVisitRecorderMenu.toggle` read.
3. **Open findings, next four:** ST-F39 (Team Manager activity query: `companyId`, `orderBy`, `limit(15)` and a
   three-field index in `firestore.indexes.json`), PL-F15 (Quick Add `jobValue: ''` and missing jobType), ST-F10 (three
   dead legal fields; "valid for 30 days" hard-coded on paper; default 30 when unset so NBD stays byte-identical),
   PL-F11 (a stage chip closes the Edit modal and discards typed edits).
4. **Bookkeeping:** mark VW-F100 (#2977), ED-F28 (#2954) and ST-F54 (#2985) fixed in
   [findings-status](../../overnight/crm/findings-status.md), plus the four from this session.

## Gotchas (also in the audit note)

- `script-loader.js` is blocking and at its byte ceiling: register bundles from a deferred file.
- A new test file on disk without its manifest line turns `authed-spec-list` red for any bucket running at that moment.
- Run `node scripts/minify-shipped.js --install` before the boot-budget gate, or its shipped checks are skipped.
- Playwright resolves from the repo directory (global install); a harness for `/pro/js` bundles must be served under
  `/pro/` because bundle paths are relative.
- The designated session branch carried all four lanes, so the PR has one commit per lane; review it commit by commit.
