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

## Ultracode phase, afternoon: seven more commits, and a budget lesson

Three workflows ran after the first push (details and the salvaged tables in the audit note's addendum). They hit
the weekly usage limit after ~50 minutes. What landed on the branch from them: the **seven fresh-code P3 fixes**
(route-drive 404 log line, Mission Control matrix retry, NBD OS kill switch on first load, tenant mark on boot and
lock screens, lock-screen focus / boot-screen announcement, record-button menu guard, NBD OS window release order),
each test-first, one commit each, reviewed (two by an agent, five by hand). Not landed: the boot-weight pass
(16 of 48 read, none refuted) and the findings triage (16 of 96), both captured as tables in the audit note.

**Second Opus batch, same afternoon (after the limit reset):** the five confirmed fix-now findings were implemented
by Opus agents in worktrees (1.3 M tokens for 5 implementers + 5 reviewers, 13 minutes; the Fable batch earlier cost
2.0 M for 7) and cherry-picked, one commit each: ED-F11 + VW-F102 (the homeowner estimate page decides NBD by tenant
key, so a nameless tenant gets a neutral page; server + client, deploy-order safe), ST-F39 (a teammate's Team Manager
row queries with the companyId claim the rules require), PL-F15 (Quick Add has a Job Type pick, defaulted from the
board, and sends a numeric job value), PL-F09 (an optimistic edit keeps the cached lead's owner, companyId, job link,
stage history and customer number), VW-F02 (Prospects marks a follow-up due on its own day and says how many days
late). Reviewer nits worth a look: the new Quick Add row uses `.mfield` styling and may not match its neighbours on
desktop (check in a browser); a platform admin with a companyId claim now gets the company filter on teammate rows.
OR-F07 stays deferred (its only file is held by #2941).

**Approach for the next session: trim.** (Updated in the evening, below: the list that stood here is done.)

## Evening: batch 5, batch 3 and a loader fix (updated 2026-11-08, evening)

Two more Opus workflows ran and were integrated commit by commit after reading every diff and its review (details in
the audit note's "Third Opus round"):

- **25 P3 findings fixed** (23 commits, all approved) plus ST-F44 and ST-F30 by hand. Three more were found already
  fixed by merged PRs. [findings-status](../../overnight/crm/findings-status.md) is current: 124 merged, 35 on #3016.
- **Seven dashboard scripts left the boot path** (My Skin, the Customers map layer, Plan Jobs, Ask Joe's tools, the
  tour, the kanban card menu, Sort my customers). Dashboard boot: 207 → 200 tags, 2,741 → 2,563 KB shipped.
- **ScriptLoader now retries a failed lazy fetch.** It used to keep the dead tag and treat the file as loaded until a
  reload. One line, inside the 85 KB blocking ceiling.
- **Team Manager's activity pane reads 15 leads, not all of them**, with a new leads index (companyId, userId,
  createdAt desc). Until the index builds after deploy, it falls back to the old read once.

## Waiting on Jo

1. **The boot ceilings.** They are lowered to the new measurements in this PR (see the boot-budget test). Jo's call
   on how much slack to keep.
2. **Bulk "Move to stage" (PL-F21).** It now lists the current board's columns with your stage names. Before, it was a
   fixed list of 9. Say if you'd rather have a different list.
3. **Dead map code (VW-F59).** The Maps view is retired (it redirects to D2D), so maps-customers.js now never loads.
   Deleting it and #view-map is a product call.
4. **icons.js** removal flips the KNOWN BUG R1-10-3 pin: needs Jo's OK in the PR that does it.
5. **Seven P3s the triage marked needs-Jo:** ST-F66 (plan prices: only Jo can confirm the live Stripe amounts),
   ST-F69 (login copy names Joe's phone for every tenant: which support channel instead), PL-F25 and ED-F18 (customer
   paper warranty and GAF default wording), ST-F56 (tier labels and shingle locks: tier/price path), ST-F29 (custom
   theme count achievement has no writer), VW-F59 (above).
6. **The held drafts are unchanged:** #2941 and #2942 (MONEY), #2981, #2994 and #3008 (budget: no raise needed after
   this PR), #2919.
7. **[NEEDS_JOE](../../overnight/crm/NEEDS_JOE.md)** is unchanged.

## Good next work, in order (no Jo needed)

1. **Customer-page boot moves (batch 4).** Four were in flight at the end of the session: review-handoff + qr-code,
   estimate-supplement, customer-jobs, the photo-report picker. Check the PR for which landed.
2. **Boot weight, next pass:** `ky-insurance-law.js` (27 KB, read by document code only) into the docgen bundle, also on
   customer.html; `numbers-logic.js` (17 KB) with Reports; `deposit-rule.js` (24 KB) is eager though only a lazy file
   reads it. Use a fake `<head>` that lists its tags in the test (the audit note's lesson).
3. **Open findings:** ST-F10 (three dead legal fields; "valid for 30 days" hard-coded on paper; default 30 so NBD stays
   byte-identical), PL-F11 (a stage chip closes the Edit modal and discards typed edits), OR-F07 once #2941 lands, then
   the triage's 21 proposal-only items.
4. **Reviewer follow-ups worth a small PR:** Team Manager activity tops up legacy leads with no createdAt (the pins
   loader's count-then-top-up pattern); Ask Joe shows typing dots before the actions module lands; viewers skip the
   Sort-my-customers fetch.

## Gotchas (also in the audit note)

- `script-loader.js` is blocking and at its byte ceiling: register bundles from a deferred file.
- A new test file on disk without its manifest line turns `authed-spec-list` red for any bucket running at that moment.
- Run `node scripts/minify-shipped.js --install` before the boot-budget gate, or its shipped checks are skipped.
- Playwright resolves from the repo directory (global install); a harness for `/pro/js` bundles must be served under
  `/pro/` because bundle paths are relative.
- The designated session branch carried all four lanes, so the PR has one commit per lane; review it commit by commit.
