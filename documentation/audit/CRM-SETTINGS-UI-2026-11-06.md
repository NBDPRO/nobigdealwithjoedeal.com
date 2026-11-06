# Settings UI — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06. The harness and the findings index ship in
[NBDPRO/nobigdealwithjoedeal.com#2938](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2938).
Test: `tests/settings-ui-2026-11-06.test.js`. It passes 15/15 on this branch. Against main's
code, 9 checks fail; the other 6 are positive controls.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| ST-F09 | `dashboard-bootstrap.module.js` `_testNotif`, `dashboard.html` | "🧪 Test Notification" only showed a toast, yet it said "your alerts work!" without testing any channel. It also fell back to a native `alert()`. | The button now reads "🔔 Preview an alert", and the toast says that email and text alerts are not sent from it. The `alert()` fallback is gone. A real end-to-end channel test would mean sending email or SMS, which is Tier C, so it's left as a proposal. |
| ST-F22 | `theme-gx.js` `clearAccentOverride`, `dashboard-actions.js` `clearAccentTheme` | GX "Reset to Default" left the inline `--orange` / `--og` that `setAccentOverride` writes on `<html>`, so the custom accent stayed. It also reset `#customAccentColorPicker`, which doesn't exist. | Both inline properties are removed, and the reset targets `#gxAccentPicker`. |
| ST-F12 | `dashboard-actions.js` `dsLoadConfig` | Daily Success offers different focus categories than Settings → Daily. A category set there matched no option, so the select showed blank, and Save rewrote it as "Other". | A stored category missing from the list is added as an option and selected, so Save keeps it. |
| ST-F23 | `ui.js` `switchSettingsTab('appearance')` | The Professional Mode and Show tool names checkboxes were synced only at DOMContentLoaded, while still inside the settings template. They opened on the markup default (unchecked). | Opening the Appearance tab reads both states from the live `<body>` classes, the same source their toggles write. |

Not done here:
- ST-F20 (the Pixel Mode loader watches a panel that is still templated).
- ST-F21 (the custom theme is applied only when Settings opens).

Both change what loads at boot, so they need a phone check rather than a vm test.
