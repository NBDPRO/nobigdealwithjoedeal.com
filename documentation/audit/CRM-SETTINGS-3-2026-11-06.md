# Settings round 3: platform tools, checkout sign-in — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06 (harness and findings index:
[CRM-AUDIT-HARNESS-2026-11-06](CRM-AUDIT-HARNESS-2026-11-06.md)). Earlier rounds:
[CRM-SETTINGS-UI-2026-11-06](CRM-SETTINGS-UI-2026-11-06.md) and round 2 in [NBDPRO/nobigdealwithjoedeal.com#2966](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2966).
Test: `tests/settings-3-2026-11-06.test.js`. It passes 7/7 on this branch, and 5 checks fail
against main's code.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| ST-F41 | `admin-manager.js` `render()` | Team Manager showed **Rotate Access Codes** and **Run Migrations** to every company owner. Both callables are platform-admin only, so the server returns 403 for anyone else, and the rotate prompt names NBD's own access codes. | Hidden unless `role === 'admin'`. The admin view is a `<template>`, so the gate runs where the view paints (`render`), not at boot. It uses `style.display` because `.btn` sets its own display. |
| ST-F65 | `pricing-page.module.js` `subscribe()` | It read `auth.currentUser` before Firebase had restored the session, so a signed-in user who tapped a plan right after the page loaded was told to create an account. | It awaits `auth.authStateReady()` first, falling through if that isn't available. |

Not done here: ST-F42 (the session card's "Joe" fallback) and ST-F43 (Export Photos / Export Estimates labels). Both are in `dashboard-bootstrap.module.js`, which several queued PRs edit tonight, so they wait for those to land.
