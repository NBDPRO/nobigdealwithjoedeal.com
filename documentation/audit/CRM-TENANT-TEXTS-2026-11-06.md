# Words reps send or say to another company's customers no longer name No Big Deal — 2026-11-06

From the 2026-11-06 full CRM audit (VW-F04, VW-F08, VW-F09; scorecard on the `crm/2026-11-06-tooling` branch).

| Where | Before (a tenant with no legal name, or every tenant) | Now |
|---|---|---|
| D2D follow-up texts (`d2d-tracker-core-2026b.js _d2dCompany`) | "No Big Deal Home Solutions" — "no legal name" was treated as NBD | the tenant's name, or "our team" |
| Win-back drafts to past customers (`winback.js companyName`) | fell back to "No Big Deal Home Solutions" | "our team" (NBD keeps its name) |
| Storm Center door scripts (`storm-center.js generateTalkingPoints`) | "Hi, I'm with No Big Deal Home Solutions" for EVERY company | the tenant's own name |
| Storm marketing default company (`storm-integration.js`) | NBD's name, phone, website | the tenant's own brand |

NBD is now decided by the platform-tenant check (companyId, `window._isNbdPlatformTenant`) when it is loaded —
the same rule the warranty certificate uses — and NBD's own wording is byte-identical. With the check not loaded
the old behaviour stands.

`tests/tenant-texts-2026-11-06.test.js` runs each real helper: 15/15; on main 5 tenant-leak assertions fail.
