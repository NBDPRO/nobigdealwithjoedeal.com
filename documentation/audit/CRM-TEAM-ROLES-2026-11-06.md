# Team tab and Business Rules role gating — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06. The harness and the findings index ship in
[NBDPRO/nobigdealwithjoedeal.com#2938](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2938).
Test: `tests/team-roles-2026-11-06.test.js`. It passes 17/17 on this branch. Against main's
code, 8 checks fail; the 9 that pass are positive controls and roster checks.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| ST-F36 | `dashboard-team-tab.js`, `dashboard.html` | Every role saw the Team tab's management controls: Invite a Rep, Cancel invite, Disable, Re-enable, Remove, and the seat picker and seat purchase. The server refuses all of them except for the owner, a company_admin or the platform admin (`functions/handlers/_shared.js` `requireTeamAdmin` → `teamAdminDecision`). A sales rep or viewer got a refusal only after clicking. | The roster stays visible to everyone. The controls, the invite form (`#teamInviteForm`) and the seat panels render only when the viewer is the owner, a company_admin or the platform admin. The empty-roster seat block keeps its pinned shape for the owner path (`gauntlet-regressions.test.js`, Starter first-seat buy). |
| ST-F50 | `tenant-rules-settings.js` | Business Rules rendered an editable form for every role, and Save was always refused by the rules for anyone else. | For roles that can't save, the form renders read-only: fields disabled, and Save replaced by "Only an owner or company admin can change business rules." The predicate is `NBDUpgradePriceSettings.canEdit` (mirrors `firestore.rules` cpCanWrite), with an identical inline copy when that module isn't loaded. |

Not changed:
- Server, rules and callables.
- Teammates' emails stay visible on the roster. Hiding them is a product decision, not a refusal mismatch.
