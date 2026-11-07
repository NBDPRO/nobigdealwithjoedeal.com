# NEXT_SESSION — CRM audit lane (2026-11-07)

This is the pick-up note for the NBD Pro CRM overnight audit, which ran from 2026-11-06 08:38 ET to 2026-11-07 ~00:30 ET. Start with the full report, [MORNING_REPORT](../../overnight/crm/MORNING_REPORT.md). The live state lives in [overnight/crm](../../overnight/crm/STATE.md), and the harness is described in [CRM-AUDIT-HARNESS-2026-11-06](../audit/CRM-AUDIT-HARNESS-2026-11-06.md).

## State

- The audit covered 908 rows and produced 247 findings (P0 3, P1 11, P2 92, P3 141).
- 40 PRs were opened: 37 merged and 3 are held drafts. Every P0 is merged.
- About 117 findings are fixed on main. About 123 have no PR yet, and the per-finding table is [findings-status](../../overnight/crm/findings-status.md).

## Waiting on Jo

1. **Held drafts:**
   - [#2941](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2941): ice & water bills the eave band (MONEY).
   - [#2942](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2942): estimate Settings survive sign-out (MONEY).
   - [#2981](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2981): tenant stage emails (wording).
2. **Emails, decided 2026-11-07:** "jd@ on anything going to me directly and info on anything general on site." The next PR sorts the seven document spots that print jd@ today and shows Jo the per-spot sort before merge. Zelle lines stay on jd@.
3. **[NEEDS_JOE](../../overnight/crm/NEEDS_JOE.md):** 23 items. The ones that block fixes are:
   - estimate math that changes prices (ED-F01 layers, ED-F05 template markup, Round-To, dumpster sizing)
   - the invented blank-template content (ED-F16)
   - the "Limited lifetime" strings (ED-F27)
   - the portal "Send reply" Unauthenticated error (CU-F21, Tier C)

## Good next work (Tier A, no Jo needed)

- **The P3 list in findings-status with no PR:** native-dialog fallbacks, dead code to list, remaining keyboard gaps, and Leaflet colours through a resolved-colour helper (VW-F20).
- **Once #2981 settles:** the email modal keyboard work (VW-F161) and its colours (VW-F162, rest).
- **Unbounded reads (D-011):** they need server-side counts or paging, not `limit()`. Do one read per PR, test-first.
- **VW-F160 (standalone-compat dialog):** first needs a boot-budget decision, or moving the dialog out of the parser-blocking file.

## Gotchas learned this run

- A queue kick-out's real failure is in the `merge_group` run, and a PR ahead in the group can be the cause (#2969 → #2971). CANCELLED PR-level checks are superseded runs.
- Put each PR's ci-manifest and INDEX lines at distant anchors, and run merge-tree against main and the queued PRs.
- Inline-style ratchet 2079: never add `style=`. Boot budget: about 13 bytes of headroom in parser-blocking files.
- New top-level `window.*` / DOM calls need `typeof` guards, because the vm sandboxes stub only what they use.
- The public-surface tripwire reads code comments. Never quote a real phone number in one.
- From Git Bash, pass `C:/` paths into Node; `/c/...` becomes `C:\c\...`.
- Keep held PRs as drafts, and don't bind them with the app's PR tool (it is suspected of enabling auto-merge).
