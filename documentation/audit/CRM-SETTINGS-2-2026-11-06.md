# Settings round 2 — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06 (harness and findings index:
[CRM-AUDIT-HARNESS-2026-11-06](CRM-AUDIT-HARNESS-2026-11-06.md)). Round 1 was
[CRM-SETTINGS-UI-2026-11-06](CRM-SETTINGS-UI-2026-11-06.md).
Test: `tests/settings-2-2026-11-06.test.js`. It passes 7/7 on this branch, and 3 checks fail
against main's code.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| ST-F20 | `ui.js` `switchSettingsTab('appearance')` | `pixel-mode.js` watches `#pixelModePanel` with an IntersectionObserver at boot. At boot the panel is still inside the settings `<template>`, so for a user with Pixel Mode off the core never loaded, and the Pixel Mode / World toggles did nothing. | Opening the Appearance tab calls `NBDPixelMode.ensure()` while the stub is still in place. An already-loaded core is left alone. |
| ST-F26 | same branch | The Ambient Sound checkbox opened unchecked even with sound on. | It is read from `ThemeSounds.isEnabled()`, the owner of the saved state. |
| ST-F15 | `dashboard.html` | 13 Settings / Company / Company Profile placeholders showed NBD's own name, phone (859) 420-7382, Cal.com handle and tagline to every contractor. | They now show neutral examples: "Your company name", "(555) 555-0100" (a reserved fictional number), "your-cal-username", "Your tagline". These are placeholders only, so no stored value, label or id changes. |

Not done here: ST-F21 (applying a saved Custom Theme at boot) needs a decision on what counts as the current theme. It's in NEEDS_JOE.
