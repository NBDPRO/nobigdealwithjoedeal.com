# Screens that said "saved" or "All clear" when they weren't — 2026-11-06

From the 2026-11-06 full CRM audit (PL-F13, VW-F51, ST-F05, VW-F157, VW-F158, VW-F01; scorecard on the
`crm/2026-11-06-tooling` branch). All Tier A — honest states, no data or logic change except the Deleted bin's
read scope.

| Where | Before | Now |
|---|---|---|
| Deleted leads bin (`dashboard-bootstrap.module.js _loadDeletedLeads`, `crm-portal-bridge.js renderDeletedDrawer`) | own deletes only; a failed read showed "All Clear"; before sign-in it threw and sat on "Loading…" | team readers also see the company's deletes (same two-scope shape as estimates), capped at 200 per scope; a failed read says "Could not load deleted leads"; [] before sign-in |
| Document viewer Save (`nbd-doc-viewer.js`, `document-generator.js`) | "✓ Document saved" even when nothing was filed on the customer | the generator reports `{ notSaved: true }`; the viewer says "Not saved to the customer" |
| Settings → Company / Notifications (`dashboard-bootstrap.module.js`) | "✓ saved" after a failed server write (empty catch) | "Saved on this device only — could not reach the server…" |
| Agent Inbox (`agent-inbox.js`) | "All clear / Nothing waiting" after a failed load | "Could not load the inbox…" |
| Voicemail transcriber (`voicemail.js`) | "✓ Voicemail saved" when the timeline write failed | warning toast + "Not saved to the customer's timeline" in the result |
| Prospects (`prospects.js`) | a company with zero leads saw a blank page forever | renders (with its empty state) once the 8 s wait ends |

`tests/silent-failures-2026-11-06.test.js`: the Deleted bin and the viewer save run as real code in a vm; the
other four are source checks on the shipped text. 19/19; on main 15 fail and the positive controls pass.

## Update — PR steward review (2026-11-06 evening)

1. **The team-wide Deleted bin offers only what the rules allow.** For each deleted lead, the drawer mirrors `/leads` in `firestore.rules`:
   - **Restore (update):** `isAdmin`, or the rep's own lead (not a viewer), or `company_admin` / `manager` in the same company.
   - **Remove (delete):** `isAdmin`, or the rep's own lead (not a viewer), or `company_admin` in the same company.
   - So a viewer sees the bin with no buttons, and a manager can Restore a teammate's lead but not Remove it.
2. **No "All Clear" before sign-in.** The loader returns `undefined` until `_user` exists, and the drawer keeps "Loading…". `refreshTrashBadge` already ignores anything that isn't an array. `silent-failures-2026-11-06.test.js` changes its expected value from "returns []" to "returns undefined, keeps Loading…".
3. Not changed here: with no `_db` / `_user`, Company settings still shows "✓ saved". That is older than this PR and left for its own change.

Tests: `silent-failures-2026-11-06.test.js` now passes 23/23. It adds viewer, manager and company_admin button checks. Against the PR head before this commit, 3 checks fail.
