# CRM integrity pass 3 — 2026-11-06

Part of the overnight CRM audit, which started 2026-11-06 (the harness and the findings index ship in
[NBDPRO/nobigdealwithjoedeal.com#2938](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2938)). This pass fixes four small
"the screen says one thing, the data says another" findings. Each one ships with a
vm test that runs the real function: `tests/integrity-3-guards-2026-11-06.test.js`.
The test passes 14/14 on this branch. Against main's code, 7 checks fail.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| ST-F52 | `agent-bots-settings.js` `settingsCard` | Some companies have never picked a timezone. For them the server reports `timezone: 'UTC'` with `timezoneSet: false`. The select still pre-selected UTC, so the next Save on that card (even one only flipping a toggle) stored UTC for good. Quiet hours and the daily briefing then ran 4–5 hours off. | The current value is used only when `timezoneSet` is true. Otherwise "Not set — pick yours" stays selected, and Save writes nothing for timezone. |
| ST-F53 | `ai-texting-persona.js` `defaultName` | A rep with no display name defaulted to "Joe", and the persona form saved that. Every tenant's AI texts could go out signed "Joe". | "Joe" is used only for the NBD platform tenant (`_isNbdPlatformTenant`). Any other tenant gets a blank name, which the server fills from the profile. |
| PL-F14 | `dashboard-actions.js` `hideFollowUpAlerts` + `crm-pipeline.js` | Dismiss on the follow-up strip stored `'1'`, which hid the strip on that device forever. Overdue follow-ups stopped surfacing at all. | Dismiss now stores today's date (`en-CA`, local), so the strip comes back tomorrow. Devices that already stored `'1'` see it again. |
| PL-F12 | `crm-portal-bridge.js` `toggleCardSelection` + `kanban-context-menu.js` | When a customer has two job cards, bulk-select highlighted only the first card. The context menu also said "Delete lead", but the delete removes every job. | Every `.k-card` for that lead is highlighted. On a multi-job customer the menu now says "Delete customer (all N jobs)". |

Not changed:
- No server, rules or schema changes.
- No money math.
- The delete itself is unchanged; only the label is now accurate.
