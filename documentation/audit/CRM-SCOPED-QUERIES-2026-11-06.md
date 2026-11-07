# Three panels were empty because their queries could never pass the rules — 2026-11-06

From the 2026-11-06 full CRM audit (DT-F01, DT-F03, DT-F05; scorecard on the `crm/2026-11-06-tooling` branch).
Client query scoping only — firestore.rules are untouched.

| Panel | Query before | Rule | Who saw nothing | Query now |
|---|---|---|---|---|
| Saved inspection reports (`inspection-report-engine.js getReports`) | `/reports` where leadId | isOwner(userId) ‖ isAdmin() ‖ sameCompanyAsResource() — a leadId-only query can't prove any | every non-admin | leadId + own userId, plus leadId + companyId for team readers; sorted client-side (no composite index) |
| Estimate builder + supplement photo pickers (`estimate-v2-ui.js loadLeadPhotos`, `supplement-ui.js _loadLeadPhotos`) | `/photos` where leadId | passes only via docLeadInMyCompany() (company readers) | sales reps, solo owners | readers unchanged; everyone else adds own userId (same rule as customer-bootstrap `_photoQueryScopes`) |
| Ask Joe "what's on today" (`ask-joe-actions.js`) | `/appointments` where repUid | isOwner(resource.data.userId) | every non-admin | where userId (every booking doc carries it — functions/integrations/calcom.js; `userId + startTime` is indexed) |

Each was wrapped in a catch that returned an empty list, so nothing ever said why.

**Proof against the real rules:** local emulator, signed in as a synthetic sales rep — the three old queries
returned `permission-denied`, the three new ones were allowed. `tests/scoped-queries-2026-11-06.test.js` runs the
real loaders against a rules-shaped stub: 11/11; on main 7 fail.

Left as a NEEDS_JOE / Tier C note: the comment in firestore.rules near the /reports block (≈3852-3855) says the
leadId-only query works; it doesn't.

## Update — PR steward review (2026-11-06 evening)

1. **Platform admin kept.** Jo's account is `{ owner: true, role: 'admin' }`, and it reads `leadId`-only `/photos` and `/reports` today through `isAdmin()`. The new scope lists left `admin` out, so his reads would have narrowed to his own uploads. Now:
   - In both photo pickers, `admin` counts as a reader (the `leadId`-only query).
   - Saved reports run one `leadId`-only query for `admin`.
2. **Each report scope on its own.** A refused company-scope read no longer throws away the owner-scope reports already fetched. The loader returns what it found, and fails only when every scope was refused.

Test: `tests/scoped-queries-2026-11-06.test.js` now models `isAdmin()` and a refused company scope in its rules stub. It passes 15/15, and the 4 new checks fail on the PR head before this commit.
