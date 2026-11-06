# Slice inventory: settings (PREFIX ST)

_Summary (2026-11-06, read-only audit of worktree HEAD 74bc5840):_ **98 inventory rows** (ST-001…ST-098) covering the dashboard Settings view (14 tabs), the Team Manager admin view, pricing.html, onboarding.html, register.html and login.html, plus the three shared stores. Across the scored rows: **"Works"** has 74 ✅, 18 ⚠️ and 6 ❌; **all scored columns together** have 587 ✅, 115 ⚠️ and 37 ❌. There are **72 findings**: 0 P0, 3 P1, 33 P2, 36 P3. The worst three:
- **ST-F01:** Settings → Estimates OH&P / markup / cost basis / minimums / round-to / dump fee live only in the `nbd_est_settings_v3` localStorage key. That key is wiped at every sign-out, and its Firestore copy is never read back, so every estimate after a re-login silently prices at factory defaults. It is the same class as the old "markup never reached the engine" bug and a **P0 candidate**.
- **ST-F02:** `_saveCompanyProfile` changes the in-memory profile and its cache *before* the Firestore write and never rolls back. A sales_rep / manager / viewer whose Company Profile, Estimates Save All or Business Rules save is denied therefore keeps pricing and printing with the rejected values for the rest of the session (and offline next boot).
- **ST-F60:** re-running the setup wizard overwrites the business / lead-alert email with the login email.

DEAD settings found (saved, never consumed):
- the whole Company tab (18 `co*` fields)
- Profile Company / Role / License #
- Company Profile proposal-validity days, cancellation window text, statute reference
- Notifications Hot / Storm / Inbound / D2D triggers and Email / SMS channels
- the Daily Program theme
- Pixel Mode toggles (loader never attaches)

There is no settings save that uses `setDoc` without merge. The full-replace writes (county maps, jurisdictions, pipeline views) are deliberate and gated.

Method:
- I traced Profile, Estimates, Daily, Company, Company Profile, Notifications and Help directly.
- Four read-only sub-audits covered Appearance; Team / Access / Billing; Pipelines / AI texting / Bots / Business Rules / Upgrade prices; and the four pages. I spot-checked their key claims: the pixel-mode loader, the onboarding prefill order, and the Business Rules denied-save behaviour.

Legend: ✅ ⚠️ ❌ `?` = could not tell; N/A:reason.

## Section 1 — Inventory + scorecard

| ID | Item | Kind | Entry | Files | Daily | Ledger ids | 7 Theme | 8 Tenant | 9 Hygiene | 10 Integrity | 11 Perf | 12 Tests | 2 Works | 3 States | 5 Kbd | Findings |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ST-001 | Settings view + tab bar (switchSettingsTab) | view | dashboard.html:3148-3175; ui.js:850 | ui.js, dashboard-ui.js:541 | Y | d7-settings-001…011, d1-chrome-022/026/028/064, gap-mobile-038 | ✅ | ✅ | ⚠️ dead calls ui.js:975,988-989 | ✅ | ✅ | smoke/dashboard.test.js | ✅ | ✅ | ✅ real buttons | F14,F31 |
| ST-002 | `?settings=<tab>` deep link (allowlist + poll) | route | dashboard-bootstrap.module.js:2536-2575 | bootstrap | N | none | N/A | ✅ | ✅ | ✅ allowlist | ✅ | ? | ✅ | ✅ | N/A | — |
| ST-003 | Profile · Your Profile fields + Save | settings group | dashboard.html:3180-3269; bootstrap:4904-5036 | bootstrap, dashboard-ui-prefs-boot.js:523 | Y | d7-settings-012…019,022 | ✅ | ⚠️ NBD placeholders | ⚠️ silent load catch | ❌ blank-load then save clobbers | ✅ | smoke/dashboard.test.js (registry), role-gate.test.js | ⚠️ 3 fields DEAD | ⚠️ | ✅ | F06,F07,F15 |
| ST-004 | Profile · digest / dormant / review-nudge opt-ins | settings group | dashboard.html:3222-3262 | bootstrap:4937-4942,4978-4988 | N | d7-settings-020,021 | ✅ | ✅ | ✅ | ✅ merge | ✅ | none | ✅ | ✅ | ✅ | — |
| ST-005 | Profile · Export / Sheets / Import CSV | tool | dashboard.html:3286-3313 | data-export.js:388-391, data-import.js:697 | N | d7-settings-023…025 | ✅ | ✅ | ⚠️ 2nd lead export in Access | ✅ | ✅ | data-export.test.js | ✅ | ✅ | ✅ | — |
| ST-006 | Profile · Pipeline prefs (sec header, density, view, bold, auto-collapse) | settings group | dashboard.html:3322-3390 | dashboard-ui.js, crm-list-view.js, dashboard-actions.js:1459 | Y | d7-settings-026…029 | ✅ | ✅ | ✅ | ⚠️ bold / sec-header purged at sign-out | ✅ | crm-list-view-default.test.js, e2e/phone-pipeline.spec.js | ✅ | ✅ | ✅ | F24 |
| ST-007 | Profile · Joe API key Clear | control | dashboard.html:3395-3400 | ai.js:34-46 | N | d7-settings-030,031 (stale ids), 032 | ✅ | ✅ | ✅ | ⚠️ also wipes chat | ✅ | e2e/globals-surface-snapshot.spec.js | ✅ | ⚠️ wrong copy | ✅ | F30 |
| ST-008 | Profile · Monthly goal | settings field | dashboard.html:3409-3417 | cash-card.js:89-193 | Y | none | ✅ | ✅ | ⚠️ silent read-back fail | ✅ merge | ✅ | cash-card-2026-10-15.test.js | ✅ | ⚠️ | ✅ | — |
| ST-009 | Profile · Load sample data / Sign out | bulk action | dashboard.html:3422-3430 | dashboard-actions.js:1074 | N | d7-settings-033,034 | ✅ | ✅ | ❌ native confirm fallback | ✅ | ✅ | empty-is-not-failed.test.js | ✅ | ✅ | ✅ | F16 |
| ST-010 | Appearance · Display mode | settings field | dashboard.html:3445-3452 | theme-engine.js:5704-5711 | N | d7-settings-035…037 | ✅ | ✅ | ✅ | ⚠️ purged, no cloud copy | ✅ | none | ✅ | ✅ | ✅ | F24 |
| ST-011 | Appearance · Layouts / Day-night | panel | dashboard.html:3460-3470 | layout-system.js, layout-offer.js | N | none | ✅ | ✅ | ✅ | ✅ | ✅ | layout-offer-field-bar-2026-10-15.test.js | ✅ | ⚠️ "Loading…" can stick | ? | F28 |
| ST-012 | Appearance · Theme grid + category chips | panel | dashboard.html:3474; ui.js:895-976 | theme-engine.js, theme-preview.js | N | d7-settings-038,039 | ⚠️ raw hex fallbacks ui.js:937-939 | ✅ | ⚠️ | ⚠️ blocked by inline custom vars | ✅ | theme-preview-2026-10-11.test.js | ⚠️ | ✅ | ✅ | F21,F27 |
| ST-013 | Appearance · Overlays & Ambient sound | settings group | dashboard.html:3485-3492 | theme-overlays.js, theme-sounds.js | N | d7-settings-040,041 | ✅ | ✅ | ✅ | ⚠️ overlays purged | ✅ | none | ⚠️ | ❌ sound shows unchecked | ✅ | F24,F26 |
| ST-014 | Appearance · Professional mode | settings field | dashboard.html:3498-3502 | dashboard-ui-prefs-boot.js:21,271 | N | d7-settings-042 | ✅ | ✅ | ✅ | ⚠️ purged | ✅ | smoke/dashboard.test.js (registry) | ⚠️ | ❌ blank on open | ✅ | F23,F24 |
| ST-015 | Appearance · Sidebar tool names | settings field | dashboard.html:3512-3516 | prefs-boot:285-310 | N | none | ✅ | ✅ | ✅ | ⚠️ purged | ✅ | none | ⚠️ | ❌ blank on open | ✅ | F23,F24 |
| ST-016 | Appearance · GX effects + accent | settings group | dashboard.html:3526-3567 | theme-gx.js, dashboard-billing-tab.js:143-151 | N | d7-settings-043…048 | ✅ | ✅ | ⚠️ dead id dashboard-actions.js:140 | ⚠️ purged | ✅ | smoke (registry) | ⚠️ reset broken | ⚠️ | ✅ | F22,F24 |
| ST-017 | Appearance · Achievement themes | panel | dashboard.html:3580 | theme-achievements.js | N | d7-settings-049 | ✅ | ✅ | ⚠️ | ✅ | ⚠️ unbounded knocks read | none | ⚠️ | ? | ? | F29,F32 |
| ST-018 | Appearance · Custom theme builder (tb*) | settings group | dashboard.html:3588-3632 | dashboard-custom-theme.js | N | d7-settings-050…058 | ✅ | ✅ | ✅ | ⚠️ | ✅ | custom-theme-themechange-2026-10-11.test.js | ❌ not applied at boot | ✅ | ✅ | F21 |
| ST-019 | Appearance · Fonts & UI size | settings group | dashboard.html:3637-3648 | prefs-boot:70-74,238-254 | N | d7-settings-059,060 | ✅ | ✅ | ✅ | ✅ | ⚠️ font fetched per pick | smoke/dashboard.test.js, client-dead-calls-2026-10-03.test.js | ✅ | ✅ | ⚠️ font cards are divs | F34 |
| ST-020 | Appearance · Shape & depth / Material | settings group | dashboard.html:3662-3698 | prefs-boot:408,429,656,688 | N | none | ✅ | ✅ | ✅ | ✅ merge + hydrate | ✅ | shape-styles-2026-10-01.test.js | ✅ | ✅ | ✅ | — |
| ST-021 | Appearance · Auto theme / Storm mode | panel | dashboard.html:3707-3714 | auto-theme.js, storm-mode.js | N | none | ✅ | ✅ | ✅ | ✅ merge | ✅ | auto-theme-rules.test.js | ✅ | ⚠️ click-only repaint | ? | F28 |
| ST-022 | Appearance · My Skin | panel | dashboard.html:3723-3885 | my-skin*.js | N | none | ✅ | ✅ | ⚠️ onSnapshot unsubs dropped | ✅ merge | ✅ | e2e/my-skin.spec.js, my-skin-2026-10-01.test.js | ✅ | ⚠️ load-fail silent | ✅ | F25,F33 |
| ST-023 | Appearance · Pixel Mode / World | panel | dashboard.html:3893-3906 | pixel-mode.js:76-91, pixel-mode-core.js | N | none | ✅ | ✅ | ⚠️ | ✅ | ✅ | pixel-mode-2026-10-11.test.js (regex shape only) | ❌ toggles dead | ❌ no feedback | ✅ | F20,F33 |
| ST-024 | Appearance · Customize sidebar | panel | dashboard.html:3911-3922 | dashboard-sidebar-customizer.js, prefs-boot:554-584 | N | d7-settings-061,062 | ✅ | ✅ | ✅ | ⚠️ purged | ✅ | smoke/dashboard.test.js, e2e/phone-views.spec.js | ✅ | ✅ | ✅ | F24 |
| ST-025 | Estimates · Tier rates (company) + cost basis + min job + round-to | settings group | dashboard.html:3930-3953 | bootstrap:5110-5161,5604-5610,5753; estimate-builder-v2.js:652-737 | Y | d7-settings-063…070 | ✅ | ✅ | ✅ | ❌ device half purged | ✅ | five-tier-crm-2026-10-02.test.js, county-tenant-policy.test.js | ⚠️ | ✅ | ✅ | F01,F02,F03 |
| ST-026 | Estimates · Business Rules (tiers, warranty, locks, deposit) | panel | dashboard.html:3957-3964 | tenant-rules-settings.js, tenant-rules.js | Y | none | ✅ | ✅ neutral defaults | ✅ | ❌ denied save mutates memory | ✅ | tenant-ready-2026-10-04.test.js, e2e/phone-tenant-setup.spec.js | ✅ | ✅ | ✅ | F02,F50,F56 |
| ST-027 | Estimates · Add-on rates (14) | settings group | dashboard.html:3966-3998 | bootstrap:5249-5270,5674-5691; estimate-builder-v2.js:735 | Y | none | ✅ | ✅ | ✅ | ✅ hydration-gated | ✅ | estimate-pricing.test.js | ✅ | ✅ | ✅ | F02 |
| ST-028 | Estimates · Upgrade prices + own Save | panel | dashboard.html:4000-4019 | upgrade-price-settings.js | Y | none | ✅ | ✅ | ✅ | ✅ rolls back on deny | ✅ | upgrade-price-settings.test.js | ✅ | ✅ | ✅ | — |
| ST-029 | Estimates · OH&P markup + repair minimum | settings group | dashboard.html:4022-4035 | bootstrap:5123-5125,5611-5614; estimate-v2-ui.js:2603-2643,2848-2860 | Y | d7-settings-071…073 | ✅ | ✅ | ✅ | ❌ purged, cloud copy write-only | ✅ | estimate-scope-display.test.js, estimate-pricing-paths-2026-10-05.test.js | ⚠️ | ⚠️ "applies to every estimate" untrue after sign-out | ✅ | F01 |
| ST-030 | Estimates · Cost & tax defaults | settings group | dashboard.html:4042-4052 | bootstrap:5127-5148,5615-5617 | Y | d7-settings-074…076 (removed ids), 077…079 | ✅ | ✅ | ✅ | ❌ dump / extra layer purged | ✅ | county-tenant-policy.test.js | ⚠️ | ✅ | ✅ | F01 |
| ST-031 | Estimates · County permits + county tax (14 inputs) | settings group | dashboard.html:4054-4090 | bootstrap:5163-5189,5620-5648,5778-5823 | Y | d7-settings-080,081 | ✅ | ✅ | ✅ | ✅ hydration + tenant-key gated | ✅ | county-tenant-policy.test.js | ✅ | ✅ | ✅ | — |
| ST-032 | Estimates · My Jurisdictions rows | settings group | dashboard.html:4098-4106 | bootstrap:5291-5574 | Y | none | ✅ | ✅ escaped | ✅ | ✅ full replace gated | ✅ | county-tenant-policy.test.js | ✅ | ✅ loading / failed / retry | ✅ | — |
| ST-033 | Estimates · Catalog summary (read-only) | panel | dashboard.html:4108-4118 | bootstrap:5242-5244 | N | none | ✅ | ✅ | ✅ | N/A | ✅ | none | ✅ | ⚠️ shows 0 before bundle | N/A | — |
| ST-034 | Estimates · Save All / Reset / Open V2 builder | action | dashboard.html:4121-4127; bootstrap:5577-5986 | bootstrap | Y | d7-settings-082…084 | ✅ | ✅ | ❌ native confirm fallback | ⚠️ | ✅ | county-tenant-policy.test.js, e2e/phone-views.spec.js | ✅ | ✅ honest warnings | ✅ | F02,F16 |
| ST-035 | Pipelines · stage builder | tool | dashboard.html:4132; pipeline-builder.js:623 | pipeline-builder.js, crm-stages.js, bootstrap:178-257 | Y | none | ✅ | ✅ | ✅ | ⚠️ ✕ orphans leads; deleted key lingers | ✅ | pipeline-builder-delete / -hydration tests, e2e/phone-views.spec.js | ✅ | ✅ | ⚠️ | F51,F55 |
| ST-036 | Daily OS · North Star / floors / goose | settings group | dashboard.html:4140-4199 | dashboard-actions.js:1324-1483, widgets.js:1005-1023 | N | d7-settings-085…091,093…095 | ✅ | ✅ | ⚠️ silent cloud-save catch | ❌ category blank → saved as Other | ✅ | home-widgets-survive-signout-2026-09-29.test.js, smoke (registry) | ✅ | ✅ | ✅ | F12,F14 |
| ST-037 | Daily OS · Program theme grid | settings field | dashboard.html:4201-4206 | dashboard-actions.js:1353-1358,1423 | N | d7-settings-092 | ✅ | ✅ | ✅ | ❌ overridden by dashboard theme | ✅ | none | ❌ | ✅ | ? | F13 |
| ST-038 | Company tab (18 `co*` fields) + Save / Reload | settings group | dashboard.html:4218-4280; bootstrap:5997-6052 | bootstrap | N | d7-settings-096…115 | ✅ | ⚠️ "GAF Certification" field for every tenant | ⚠️ swallowed catch | ❌ DEAD store | ✅ | smoke (registry only) | ❌ | ⚠️ false success | ✅ | F04,F05 |
| ST-039 | Company Profile · Brand identity (cp_brand_*) | settings group | dashboard.html:4285-4345 | bootstrap:6191-6345, company-profile.js:651-830 | Y | none | ✅ | ⚠️ NBD placeholders | ✅ | ❌ blanked contact can't clear | ✅ | email-unsubscribe.test.js, e2e/stranger.spec.js, e2e/phone-views.spec.js | ✅ | ✅ | ✅ | F02,F11,F15 |
| ST-040 | Company Profile · Logo upload | tool | dashboard.html:4296-4302 | tenant-account-ui.js:45-68 | N | none | ✅ | ✅ re-encoded first-party URL | ⚠️ no emulator hook | ✅ | ✅ 3 MB cap | tenant-ready-2026-10-04.test.js | ✅ | ✅ | ✅ | F18 |
| ST-041 | Company Profile · Lead-alert warning + confirm / revoke | panel | dashboard.html:4313-4320; bootstrap:6352-6455 | bootstrap, functions/alert-recipients.js | Y | none | ✅ | ✅ | ✅ textContent | ✅ address bound | ✅ | alert-recipients-2026-10-13.test.js | ✅ | ✅ | ✅ | — |
| ST-042 | Company Profile · Letterhead (cp_business*) | settings group | dashboard.html:4350-4370 | bootstrap:6071,6212-6215 | Y | d7-settings-116…121 | ✅ | ✅ | ✅ | ✅ merge | ✅ | none direct | ✅ | ✅ | ✅ | — |
| ST-043 | Company Profile · Legal clauses (15) | settings group | dashboard.html:4374-4416 | bootstrap:6061-6069; company-profile.js:850-905 | Y | d7-settings-122…137 (129 stale id) | ✅ | ✅ neutralizer | ✅ | ⚠️ 3 fields DEAD | ✅ | none direct | ⚠️ | ✅ | ✅ | F10 |
| ST-044 | Company Profile · Financing tiers (3×4) + partner | settings group | dashboard.html:4420-4455 | bootstrap:6138-6153 | N | d7-settings-138,139 | ✅ | ✅ NBD partner blanked for tenants | ✅ | ✅ | ✅ | none | ✅ | ✅ | ✅ | — |
| ST-045 | Company Profile · Marketing (tagline, service area, 6 services, 4 value props) | settings group | dashboard.html:4459-4520 | bootstrap:6155-6168 | N | d7-settings-140…143 | ✅ | ✅ | ✅ | ⚠️ serviceArea dual copy | ✅ | none | ✅ | ✅ | ✅ | F64 |
| ST-046 | Company Profile · Code cycle / jurisdiction | settings group | dashboard.html:4524-4531 | bootstrap:6070 | N | d7-settings-144,145 | ✅ | ✅ | ✅ | ✅ | ✅ | none | ✅ | ✅ | ✅ | — |
| ST-047 | Company Profile · Job budget alerts | settings group | dashboard.html:4536-4543 | bootstrap:6170-6181 | N | none | ✅ | ✅ | ✅ | ✅ clamps | ✅ | none | ✅ | ✅ | ✅ | — |
| ST-048 | Company Profile · Sales links (deal link days) | settings field | dashboard.html:4550-4555 | bootstrap:6182-6186 | N | none | ✅ | ✅ | ✅ | ✅ clamp 1-90 | ✅ | none | ✅ | ✅ | ✅ | — |
| ST-049 | Company Profile · Your website (slug + publish / unpublish) | tool | dashboard.html:4560-4585; bootstrap:6468-6573 | bootstrap, functions/handlers/public-site.js | N | none | ✅ | ✅ | ✅ | ✅ server-validated | ✅ | tenant-site-publish-2026-10-04.test.js | ✅ | ✅ | ✅ | — |
| ST-050 | Company Profile · Save / Reload / Reset | action | dashboard.html:4596-4598; bootstrap:6575-6604 | bootstrap, company-profile.js | Y | d7-settings-146…148 | ✅ | ✅ | ❌ native confirm fallback | ❌ denied save mutates memory | ✅ | e2e/stranger.spec.js | ✅ | ⚠️ raw error text | ✅ | F02,F16 |
| ST-051 | Company Profile · Re-run setup wizard link | link | dashboard.html:4587 | pages/onboarding.js:455 | N | none | ✅ | ✅ | ✅ | ❌ overwrites email / name | ✅ | none | ⚠️ | ✅ | ✅ | F60,F61 |
| ST-052 | Team · roster + row actions (cancel / disable / remove / make owner) | panel | dashboard-team-tab.js:61-441; dashboard-team-owner.js | team-tab, team-owner | N | d7-settings-152 | ✅ | ✅ path-scoped | ✅ nbdConfirm | ✅ id from element | ⚠️ no limit | member-offboarding-2026-10-06.test.js, owner-handoff-2026-10-12.test.js | ✅ | ❌ blank on error | ✅ | F36,F38 |
| ST-053 | Team · Invite form | form | dashboard.html:4636-4651; team-tab.js:14-60 | team-tab | N | d7-settings-149…151 | ✅ | ✅ | ✅ | ⚠️ double submit; no company_admin option | ✅ | e2e/phone-views.spec.js (layout) | ✅ | ⚠️ | ✅ | F46,F47 |
| ST-054 | Team · Seat picker / seat buy (dark) | panel | team-tab.js:174-376 | team-tab, billing-gate.js | N | none | ⚠️ #fff on orange | ✅ | ✅ | ✅ fails closed | ✅ | unloaded-cache-gates.test.js | ✅ | ✅ | ✅ | — |
| ST-055 | Team · Check my invite | action | team-tab.js:485-534 | team-tab | N | none | ✅ | ✅ | ✅ | ✅ | ✅ | gauntlet-regressions.test.js | ✅ | ✅ | ✅ | — |
| ST-056 | Team · Role permissions + growth roadmap (static) | panel | dashboard.html:4673-4727 | — | N | none | ✅ | ✅ | ✅ | N/A | ✅ | none | ✅ | N/A | N/A | — |
| ST-057 | Team Manager admin view (roster, filter, activity) | view | admin-manager.js:80-283,585-611 | admin-manager.js | N | none | ✅ | ⚠️ activity query unscoped | ⚠️ unescaped error HTML | ✅ | ❌ unbounded leads read | smoke/dashboard.test.js, smoke/reports.test.js | ✅ | ⚠️ | ? | F39,F44 |
| ST-058 | Team Manager · create / edit user modals | modal | dashboard.html:5262,5302; admin-manager.js:298-417 | admin-manager.js | N | none | ✅ | ✅ | ✅ | ⚠️ role change no confirm | ✅ | smoke (static) | ✅ | ✅ | ? Esc unverified | F45 |
| ST-059 | Team Manager · Rotate codes / Migrations / Analytics | tool | dashboard.html:5165-5170; admin-manager.js:626-726 | admin-manager.js | N | none | ✅ | ⚠️ NBD-internal controls shown to tenants | ✅ | ✅ server refuses | ✅ | smoke/functions.test.js | ⚠️ | ✅ | ✅ | F41 |
| ST-060 | Access · Access methods panel (static) | panel | dashboard.html:4734-4761 | — | N | d7-settings-153 | ✅ | N/A | ⚠️ false copy | ❌ | N/A | none | ❌ | N/A | N/A | F40 |
| ST-061 | Access · Current session, Sign out everywhere, Refresh | panel | bootstrap:6935-6954; session-revoke.js:82-145 | bootstrap, session-revoke.js | N | d7-settings-154,155 | ✅ | ⚠️ "Joe" fallback | ✅ | ⚠️ start time wrong | ✅ | session-revocation.test.js | ⚠️ | ⚠️ | ✅ | F42 |
| ST-062 | Access · Data retention CSVs (leads / estimates / photos) | tool | dashboard.html:4792-4794; bootstrap:6823-6930 | bootstrap | N | d7-settings-156…158, d6-photos-023 | ✅ | ✅ | ✅ formula-escaped | ⚠️ 500-estimate cap; "ZIP" is a CSV | ⚠️ photos unbounded | data-export.test.js | ✅ | ✅ | ✅ | F43 |
| ST-063 | Access · Company ZIP export | tool | tenant-account-ui.js:77-104 | tenant-account-ui.js | N | none | ✅ | ✅ server | ✅ | ✅ | ⚠️ base64 in memory | tenant-ready-2026-10-04.test.js | ✅ | ✅ | ✅ | F18 |
| ST-064 | Access · GDPR export / erasure | tool | dashboard-api.js:283-330 | dashboard-api.js | N | d7-settings-159,160 | ✅ | ✅ | ✅ nbdConfirm | ⚠️ wording (suspected) | ✅ | member-erasure-suspend-2026-10-08.test.js | ✅ | ✅ | ✅ | F49 |
| ST-065 | Access · Prod flags (read-only) | panel | prod-flags-panel.js:29-100 | prod-flags-panel.js | N | none | ✅ | ✅ | ✅ | ✅ | ✅ | prod-flags-panel.test.js | ✅ | ✅ | N/A | — |
| ST-066 | Billing · plan + usage meters | panel | dashboard-billing-tab.js:4-52; billing-gate.js:148-281 | billing-tab, billing-gate | N | none | ✅ | ✅ companyId key | ✅ | ✅ | ✅ | billing-gate.test.js | ✅ | ❌ "Loading…" forever on failure | ✅ | F37 |
| ST-067 | Billing · plan cards, Stripe portal / checkout | tool | dashboard-billing-tab.js:59-255 | billing-tab | N | d7-settings-161…164 | ✅ | ✅ | ✅ | ✅ double-bill guard | ✅ | login-plan-intent.test.js (partial) | ✅ (Tier C) | ✅ | ✅ | F48 |
| ST-068 | Billing · AI usage (nbd_ai_usage) | panel | bootstrap:6959-6975 | bootstrap, claude-proxy.js:117-137 | N | none | ✅ | ⚠️ per device | ✅ | ❌ misleading | ✅ | none | ⚠️ | ⚠️ | N/A | F35 |
| ST-069 | Billing · Stripe Connect payouts card | panel | dashboard-connect-tab.js:47-300 | connect-tab | N | none | ✅ | ✅ | ✅ | ✅ | ✅ | stripe-connect-ui.test.js | ✅ (C) | ✅ | ✅ | — |
| ST-070 | Notifications · mode / triggers / channels + Save | settings group | dashboard.html:4939-5054; bootstrap:6609-6806 | bootstrap, crm-snooze.js, tasks.js, review-engine.js | N | d7-settings-165…179 | ✅ | ✅ | ⚠️ empty catch | ⚠️ 6 toggles DEAD | ✅ | none | ⚠️ | ⚠️ false success | ✅ | F05,F08 |
| ST-071 | Notifications · Test notification | action | bootstrap:6808-6814 | bootstrap | N | d7-settings-180 | ✅ | ✅ | ❌ alert() fallback | N/A | ✅ | none | ❌ tests nothing | ✅ | ✅ | F09 |
| ST-072 | Notifications · Away mode & backup | panel | dashboard.html:5057; away-mode-settings.js | away-mode-settings.js, functions/away-mode.js | N | none | ✅ | ✅ owner-gated | ✅ nbdConfirm | ✅ | ✅ | ? | ✅ | ? | ? | — |
| ST-073 | AI Texting · persona editor + preview | panel | dashboard.html:5062; ai-texting-persona.js:368 | ai-texting-persona.js | N | none | ⚠️ inline styles | ❌ "Joe" default | ⚠️ | ⚠️ load fail → save overwrites | ✅ | viewer-callables.test.js, e2e/phone-views.spec.js | ✅ | ⚠️ | ✅ | F53,F54,F57,F59 |
| ST-074 | AI Texting · SMS compliance (switch, DNC add / lift) | panel | sms-compliance-settings.js:271 | sms-compliance-settings.js, functions/sms-dnc.js | N | none | ✅ | ✅ | ✅ | ✅ reason required | ✅ | sms-compliance-settings-ui-2026-10-05.test.js | ✅ (C) | ✅ | ✅ | — |
| ST-075 | Bots & API (enable, house rules, timezone, bots, keys) | panel | dashboard.html:5070; agent-bots-settings.js:307 | agent-bots-settings.js, functions/agent-mcp.js | N | none | ✅ | ✅ | ✅ | ❌ unset tz saved as UTC | ✅ | agent-tenant-bots-2026-10-04.test.js, e2e/phone-bots-api.spec.js | ✅ | ✅ | ✅ | F52 |
| ST-076 | Help · Start tour / How-To / Shortcuts overlay | tool | dashboard.html:5087-5110 | dashboard-actions.js:84, ui.js:468, shortcuts-help.js:190 | N | d7-settings-181,182,184,185, pages-b-049 | ✅ | ✅ | ⚠️ duplicate openShortcutsPanel | ✅ | ✅ | ? | ✅ | ✅ | ✅ | F17 |
| ST-077 | Help · Hotkey toggles | settings group | dashboard.html:5093-5100; dashboard-hotkey-toggles.js | bootstrap:2622-2681 | N | d7-settings-183 | ✅ | ✅ | ✅ | ⚠️ purged at sign-out | ✅ | none | ✅ | ✅ | ✅ | F24 |
| ST-078 | pricing.html · plan cards + Subscribe | page | pricing.html:155-193; pricing-page.module.js:111 | pricing.html, pricing-page.module.js | N | pages-b-017 | ⚠️ 13 bare #BD5728, #ff8420 | N/A: platform | ❌ native confirm :60 | ✅ server maps plan | ✅ | e2e/pro-public.spec.js | ✅ | ✅ | ⚠️ `<a href="#">` | F63,F65,F66,F70 |
| ST-079 | pricing · plan-intent resume / cancelled return | flow | pricing-page.module.js:31-40,130-170 | same | N | none | ⚠️ inline hex | N/A | ✅ | ✅ one-shot | ✅ | login-plan-intent.test.js, gauntlet-regressions.test.js | ✅ | ✅ | N/A | F70 |
| ST-080 | pricing · FAQ accordion | section | pricing.html:200+ | same | N | none | ✅ | N/A | ✅ | N/A | ✅ | ? | ✅ | N/A | ✅ aria-expanded | — |
| ST-081 | onboarding · step 1 basics | page step | onboarding.html:234; pages/onboarding.js:391 | onboarding.html, onboarding.js | N | none | ✅ | ✅ neutral placeholders | ⚠️ inline style | ✅ merge | ⚠️ 4 sync head scripts | smoke/auth.test.js, e2e/pro-authed.spec.js | ✅ | ✅ | ⚠️ no focus move | F71 |
| ST-082 | onboarding · step 2 brand | page step | onboarding.html:269; onboarding.js:404 | same | N | none | ✅ | ✅ | ✅ | ✅ colors only on touch | ✅ | gauntlet-regressions.test.js | ✅ | ✅ | ⚠️ | F71 |
| ST-083 | onboarding · step 3 Finish (provision + prefix) | page step | onboarding.html:309; onboarding.js:232 | same, functions/handlers/provisioning.js | N | none | ✅ | ✅ | ✅ | ⚠️ re-run overwrite | ✅ | as above | ✅ | ✅ | ✅ | F60,F61 |
| ST-084 | onboarding · Skip | action | onboarding.js:314-338 | same | N | none | ✅ | ✅ | ⚠️ commented empty catches | ✅ | ✅ | none | ✅ | ⚠️ no busy state | ✅ | F71 |
| ST-085 | onboarding · re-run (`?redo=1`) | flow | onboarding.js:340-372,455 | same | N | none | ✅ | ✅ | ✅ | ❌ prefill order | ✅ | none | ⚠️ | ✅ | ✅ | F60,F61,F64 |
| ST-086 | register · email form | page | register.html:567; pages/register.js:206 | register.html, register.js | N | pages-b-019…027 | ⚠️ inline hex | ⚠️ NBD placeholder | ✅ | ❌ stranded account on retry | ✅ | e2e/stranger.spec.js | ✅ | ⚠️ raw Firebase text | ✅ | F62,F68,F70 |
| ST-087 | register · Google | flow | register.js:395 | same | N | pages-b-018 | ✅ | ✅ | ✅ | ✅ | ✅ | google-signin-popup.test.js | ✅ | ⚠️ no busy state | ✅ | — |
| ST-088 | register · access code | flow | register.js:271-333 | same | N | pages-b-019 | ✅ | N/A | ✅ | ✅ | ✅ | crm-loop-complete.test.js ? | ✅ | ✅ | ✅ | — |
| ST-089 | register · plan banner / intent | section | register.js:79-126 | same | N | none | ⚠️ | N/A | ✅ | ⚠️ hard-coded prices | ✅ | gauntlet-regressions.test.js | ✅ | ✅ | N/A | F66 |
| ST-090 | login · member form | page | login.html:297; pages/login.js:147 | login.html, login.js | N | pages-b-001,004…009 | ⚠️ inline styles | ⚠️ NBD phone in errors | ✅ | ✅ | ⚠️ non-deferred script | smoke/auth.test.js | ✅ | ✅ | ✅ | F69,F70 |
| ST-091 | login · Google | flow | login.js:305 | same | N | none | ✅ | ✅ | ✅ | ✅ fails closed | ✅ | google-signin-popup.test.js | ✅ | ✅ | ✅ | — |
| ST-092 | login · reset password | flow | login.js:348-385 | login.js, login-reset.js | N | pages-b-008,010…012 | ✅ | ✅ | ✅ | ✅ | ✅ | ? | ✅ | ✅ | ✅ | — |
| ST-093 | login · tabs (Member / Code / Demo) | control | login.html:265-267; login.js:115 | same | N | pages-b-001…003 | ✅ | ✅ | ✅ | ✅ | ✅ | ? | ✅ | N/A | ⚠️ no tablist ARIA | F72 |
| ST-094 | login · access code / demo | flow | login.js:390-487 | same | N | pages-b-013…015 | ✅ | ⚠️ NBD phone | ⚠️ legacy password shim | ✅ | ✅ | ? | ✅ | ✅ | ✅ | F67,F69 |
| ST-095 | login · post-login redirect | flow | login.js:82-103 | same | N | none | N/A | N/A | ✅ no open redirect | ✅ | ✅ | login-plan-intent.test.js | ✅ | N/A | N/A | — |
| ST-096 | Store · `userSettings/{uid}` (multi-panel doc) | Firestore collection | many | bootstrap, dashboard-actions, cash-card, prefs-boot, my-skin, pixel-mode-core | Y | none | N/A | ✅ uid path | ✅ | ✅ every write merges | ✅ | firestore-rules.test.js | ✅ | N/A | N/A | F01 (write-only field) |
| ST-097 | Store · `companyProfile/{companyKey}` (multi-panel doc) | Firestore collection | company-profile.js:651-703 | company-profile.js | Y | none | N/A | ✅ resolved key | ✅ | ❌ optimistic memory, no rollback | ✅ | county-tenant-policy.test.js, firestore-rules.test.js | ✅ | ⚠️ | N/A | F02 |
| ST-098 | Store · localStorage `nbd_est_settings_v3` | local store | estimate-builder-v2.js:617-711 | estimate-builder-v2.js, nbd-auth.js:788-845 | Y | none | N/A | ⚠️ device-wide | ✅ | ❌ purged at sign-out | ✅ | five-tier-crm-2026-10-02.test.js | ⚠️ | N/A | N/A | F01 |

## Section 2 — Findings

| ID | Sev | Tier | Item ids | Finding | Evidence file:line | Repro / why it matters | Suggested fix (smallest) |
|---|---|---|---|---|---|---|---|
| ST-F01 | P1 | B | ST-025,029,030,098 | Per-device estimate settings silently revert to factory defaults after every sign-out. Affected: markup / overhead / profit %, cost basis, min job, repair minimum, round-to, dump fee, extra layer. They live only in `nbd_est_settings_v3`, which `purgeAccountStorage` wipes (it is not in KEEP). `userSettings/{uid}.estimateSettingsV2` is written but never read back. | nbd-auth.js:790-845; estimate-builder-v2.js:617,652-664; dashboard-bootstrap.module.js:5660-5669, comment :5296; estimate-builder-v2.js:752 | Set Overhead 15%, sign out, sign in: line-item estimates price at 10% with no warning. The panel says "These percentages apply to every line-item estimate". Wrong totals on customer paper (P0 candidate). | On boot, hydrate the key from `userSettings.estimateSettingsV2` when absent (same pattern as widgets.js:1005-1023 for dsConfig), or move OH&P / markup / min-repair into `companyProfile.pricing` like tier rates. |
| ST-F02 | P1 | A | ST-026,034,039,050,097 | `_saveCompanyProfile` deep-merges the edit into `window._companyProfile` and the tenant localStorage cache *before* `setDoc`, and never rolls back. A rules denial (sales_rep / manager / viewer) therefore leaves the rejected rules, rates, brand and legal text live in the session. Business Rules, Company Profile and Estimates Save All all route through it, and none of their catches restores the profile. | company-profile.js:679-683 vs :701; tenant-rules-settings.js:134-139; dashboard-bootstrap.module.js:5795,5838-5841,6581-6590. Contrast upgrade-price-settings.js:725-729 (restores) | A rep types a 0% deposit or $300/SQ tier and presses Save. They see "Only an owner…", yet estimates and contracts made in this session use those values. The cache keeps them on an offline boot. | In each catch (or inside `_saveCompanyProfile` on rejection), `await window._loadCompanyProfile()`. Better: apply memory and cache only after the write resolves. |
| ST-F03 | P2 | B | ST-025 | Round-To is not honoured by the V2 line-item builder: `shopLineItemRates()` / `tierSettings()` never forward `roundTo`, so `EstimateLogic.resolveEstimate` defaults to 25. The upgrade-totals path also hard-codes `roundTo: 25`. doc-preflight uses the device value, so its totals check can disagree with the quote. | estimate-v2-ui.js:2612-2625,2635-2644,2843-2847,2726; estimate-logic-engine.js:957; doc-preflight.js:491-497 | Set Round To = 50: per-SQ quotes round to $50, line-item quotes still to $25, and preflight recomputes at $50. | Add `roundTo` to `shopLineItemRates()` (finite > 0 only) and use it at :2726. |
| ST-F04 | P2 | A | ST-038 | The whole Company tab is DEAD. Its 18 `co*` fields (licenses, insurance, GAF cert, EIN, territory, radius) save to `userSettings/{uid}.company` + `nbd_company_settings` and are read only by their own loader. Documents use Company Profile. | dashboard-bootstrap.module.js:5997-6052; no other reader in docs/pro or functions/ | Owner fills in license and insurance numbers expecting them on contracts; nothing changes. | Remove the tab, or fold the fields that matter into Company Profile (`businessLicense`) and point there. |
| ST-F05 | P2 | A | ST-038,070 | "✓ Company info saved" and "✓ Notification preferences saved" show even when the Firestore write fails (`console.warn` / empty catch). | dashboard-bootstrap.module.js:6019,6735 | Offline or denied saves look successful; the next device shows the old values. | Toast a warning in the catch. |
| ST-F06 | P2 | A | ST-003 | A failed profile read is silent (`catch {}` at :4959). Phone, Google review link and Cal.com stay blank, and Save then writes those blanks (plus `jobTitle` etc.) over the stored values. | dashboard-bootstrap.module.js:4915-4959 vs 4993-5020 | One rules or network blip, then pressing Save wipes the rep's portal phone and review link. | Keep a `_profileLoaded` flag: refuse Save (or omit the unloaded fields) and show "couldn't load your profile". |
| ST-F07 | P2 | A | ST-003 | Profile Company / Role / License # are DEAD: they save to `users/{uid}.profileCompany / jobTitle / licenseNumber` and nothing reads them. Every `jobTitle` hit elsewhere is a job's title. | dashboard-bootstrap.module.js:4999-5019; keys.js grep (0 external readers) | The "Settings saved!" copy implies use (e.g. on documents). | Wire them into the rep signature block, or remove the fields. |
| ST-F08 | P2 | A | ST-070 | Notification triggers Hot / Storm / Inbound / D2D and channels Email / SMS are DEAD. No caller passes `hot_lead` / `storm_alert` / `inbound_msg` / `d2d_update` to `shouldFireNotif`, and no server code reads `userSettings.notifications`. Email is checked by default. | dashboard-bootstrap.module.js:6632-6642,6670-6704; callers only crm-snooze.js:228,362,399, review-engine.js:344, tasks.js:29-30 | Users "turn off email alerts" and keep getting server emails, or expect hot-lead alerts that never come. | Hide or label the unwired toggles ("coming soon"), or route the server mailers through the setting. |
| ST-F09 | P2 | A | ST-071 | "Test Notification" only shows a toast saying "your alerts work!" and tests no channel. It also has a native `alert()` fallback. | dashboard-bootstrap.module.js:6808-6814 | False assurance; a hygiene rule breach. | Fire a real in-app or push test through `shouldFireNotif` (or relabel it), and drop the `alert`. |
| ST-F10 | P2 | A | ST-043 | Three Company Profile legal fields are DEAD: `proposalValidityDays` (paper hard-codes "valid for 30 days"), `cancellationWindowText`, and `cancellationStatute` (only neutralized, never rendered). | company-profile.js:96-97,133,857; estimate-finalization.js:807,1080; estimate-v2-ui.js:3972,4185; job-templates-ui.js:2481 | A tenant sets 14-day validity and every proposal still says 30 days. | Read `_legal().proposalValidityDays` at those 5 sites; hide the other two fields or render them. |
| ST-F11 | P2 | A | ST-039 | Brand contact fields (phone, email, website, address, mailing address, Zelle phone / email) can't be cleared. A blank is omitted from the merge write, so the old value persists and repopulates on the next open (the code comment admits this). | dashboard-bootstrap.module.js:6196-6253 (comment 6208-6211); company-profile.js:701 | An owner removes a Zelle number from invoices: "✓ saved", yet invoices keep printing it. | When the raw override had a value and the input is blank, write `deleteField()` for that key. |
| ST-F12 | P2 | A | ST-036 | Daily OS Focus Category renders blank when the category was set on the Daily Success page (different option lists). Save then rewrites it as "Other". | daily-success/index.html:1115-1119 vs dashboard.html:4149-4153; dashboard-actions.js:1334,1387 | Opening Settings and saving the floors silently changes the North Star category. | Add the stored value as an option when missing (or unify the lists). |
| ST-F13 | P2 | A | ST-037 | Daily "Program Theme" is effectively DEAD. It saves to `ds-theme`, but the Daily Success page reads `nbd_pro_theme`, then `nbd-theme`, and only then `ds-theme`. The panel copy says the theme is "Separate from your dashboard theme". | dashboard-actions.js:1423; daily-success/js/app.js:1388-1390 | Picking a program theme does nothing for anyone who has a dashboard theme. | Read `ds-theme` first in app.js, or drop the picker. |
| ST-F14 | P3 | A | ST-001,036 | `switchSettingsTab('daily')` calls `dsInitEditor` / `dsLoadThemeGrid`, which are defined nowhere (typeof-guarded no-ops). The real load runs via the goTo hook. | ui.js:988-989; dashboard-actions.js:1455-1457 | Dead code; misleading to the next editor. | Delete the two lines. |
| ST-F15 | P3 | A | ST-003,039 | Settings placeholders show NBD's own values to every tenant: Company "No Big Deal Home Solutions", Phone "(859) 420-7382", Cal.com "joedeal", Brand legal / display name "No Big Deal…". | dashboard.html:3188-3189,3205,4291,4293 | Tenant brand hygiene. | Use neutral placeholders (as onboarding.html does). |
| ST-F16 | P3 | A | ST-009,034,050 | Reset Estimates, Reset Company Profile and Load Sample Data fall back to native `window.confirm` on desktop (`nbdConfirm` exists only in standalone mode). | dashboard-bootstrap.module.js:5903,6600; dashboard-actions.js:1093 | Native-dialog rule. | Use the shared modal confirm everywhere. |
| ST-F17 | P3 | A | ST-076 | `openShortcutsPanel` is defined twice: ui.js:468 (exported :602 and :1206) and shortcuts-help.js:190. The last loader wins. | as cited | Duplicate definitions. | Keep one. |
| ST-F18 | P3 | B | ST-040,063 | tenant-account-ui.js `callable()` never calls `connectEmulatorsIfLocal` (the other settings callables do). Suspected: on the local emulator rig, logo upload and company export hit production functions unless `window._functions` was already wired. | tenant-account-ui.js:24-31 vs dashboard-bootstrap.module.js:6374,6525 | Audit harness could write to prod. | Mirror the emulator connect. |
| ST-F20 | P2 | A | ST-023 | Pixel Mode / World toggles do nothing for users with the feature off. The loader's `watchPanel` runs at boot while `#pixelModePanel` is still inside the settings `<template>`, so the core and its change listeners never load. | pixel-mode.js:76-91; dashboard.html:3895 (in template), 7422 (deferred loader) | The checkbox flips with no save or error. | Call `NBDPixelMode.ensure()` from the appearance branch of `switchSettingsTab`, or use a MutationObserver. |
| ST-F21 | P2 | A | ST-012,018 | A saved Custom Theme is applied only when Settings opens, never at boot. Once applied, its inline `:root` vars override every ThemeEngine theme. | dashboard-custom-theme.js:10-18,57-71; theme-engine.js:6308 | Colours change when Settings opens; the theme picker appears broken. | Apply at boot; clear the inline vars in `ThemeEngine.apply`. |
| ST-F22 | P2 | A | ST-016 | GX "Reset to Default" leaves the inline `--orange` / `--og` and resets a nonexistent `#customAccentColorPicker`. | theme-gx.js:506-518; dashboard-actions.js:140 | Reset does nothing visible until reload. | `removeProperty` both; use the id `gxAccentPicker`. |
| ST-F23 | P2 | A | ST-014,015 | Professional Mode and Sidebar Tool Names checkboxes show the markup default on open (synced only at DOMContentLoaded, before hydration). | dashboard-ui-prefs-boot.js:271-274,307-310 | The on state shows unchecked; it takes two clicks to turn off. | Repaint them in the `appearance` branch of ui.js. |
| ST-F24 | P2 | B | ST-006,010,013-016,024,077 | The sign-out purge wipes device UI prefs that have no cloud copy: `nbd_pro_mode_pref`, `nbd-theme-overlays`, `nbd_gx_settings`, `nbd_professional_mode`, `nbd-sidebar-collapsed`, `nbd_sidebar_hidden`, `nbd-kanban-bold`, `nbd_crm_sec_header_enabled`, `nbd_hk_disabled_*`. This contradicts the purge's own "UI prefs preserved" comment. | nbd-auth.js:780-845 | Settings reset after every sign-in. | Add them to KEEP (device prefs, no account data). |
| ST-F25 | P2 | B | ST-022 | A My Skin settings-load failure is swallowed; `cfg` stays null and every control silently no-ops. | my-skin.js:1671,1346,1409 | No message; the controls look broken. | Show a note and fall back to a default cfg. |
| ST-F26 | P3 | A | ST-013 | Ambient Sound checkbox is never repainted from `ThemeSounds`. | dashboard.html:3492; ui.js:891-894 | Misleading state. | Mirror the overlays sync. |
| ST-F27 | P3 | B | ST-012 | Suspected: opening Appearance before ThemeEngine loads renders the legacy grid and sets `dataset.loaded`, so the real grid never draws. | ui.js:898,912-920,968 | Stale picker on a fast / deep-linked open. | Don't set `loaded` when TE is missing. |
| ST-F28 | P3 | B | ST-011,021 | Suspected: Auto theme, Storm mode and Day/night panels repaint only on a click of `#stab-appearance`; a programmatic open leaves "Loading…". | auto-theme.js:608; storm-mode.js:707; layout-offer.js:219 | Stuck loading text. | Hook `switchSettingsTab`. |
| ST-F29 | P3 | C | ST-017 | The "hologram" theme unlock can't be earned: `customThemesCount` is never written. | theme-achievements.js:140,480 | Dead achievement. | Increment it in `saveCustomTheme`, or drop it. |
| ST-F30 | P3 | C | ST-007 | `clearJoeKey` copy talks about saving a new key (no such UI exists) and it also deletes chat history. | ai.js:34-46; dashboard.html:3398 | Hidden data loss. | Fix the copy; keep `nbd_joe_chat`. |
| ST-F31 | P3 | C | ST-001 | `ThemeBuilder.renderBuilder` is a dead call (`ThemeBuilder` is undefined). | ui.js:975 | Dead code. | Delete it. |
| ST-F32 | P3 | C | ST-017 | Achievement stats read every knock doc (unbounded `getDocs`). | theme-achievements.js:485-488 | Perf. | `getCountFromServer`. |
| ST-F33 | P3 | C | ST-022,023 | My Skin and Pixel `onSnapshot` unsubscribers are discarded. | my-skin.js:128,162; pixel-mode-core.js:134 | Listener leak on an in-page account switch. | Store the unsubscribe and call it on purge. |
| ST-F34 | P3 | C | ST-019 | Font cards are `div`s with no `tabindex` / `role`. | dashboard-ui-prefs-boot.js:238 | Keyboard users can't pick a font. | Render `<button>`. |
| ST-F35 | P2 | A | ST-068 | The AI usage panel is device-local `nbd_ai_usage` (only claude-proxy calls are counted, and it is wiped at sign-out). Its copy says charges pass "to your key", but the key is the platform's. | dashboard.html:4880; dashboard-bootstrap.module.js:6959-6975; claude-proxy.js:117-141 | Wrong figures that disagree with the server meter one panel up. | Read `subscriptions.usage.aiCalls`, or remove the panel; fix the copy. |
| ST-F36 | P2 | A | ST-052,053 | The Team tab shows invite, Disable, Remove, Cancel and seat controls (and teammates' emails) to sales_rep / viewer. The server always refuses them. | dashboard-team-tab.js:116-124; dashboard.html:4629-4651 | Confusing destructive controls for non-admins. | Hide them unless the role is owner / company_admin (same check as admin-manager.js:80-100). |
| ST-F37 | P2 | B | ST-066 | The Billing tab shows "Loading…" forever when the subscription read fails. | billing-gate.js:268-280; dashboard-billing-tab.js:12-31 | No error and no retry. | Add an error state and a retry button. |
| ST-F38 | P2 | B | ST-052 | Team roster has no loading row, and a load error only goes to `console.warn`, so the panel is blank. | dashboard-team-tab.js:81-140 | A failure looks like "no members". | Add loading and error rows. |
| ST-F39 | P2 | B | ST-057 | The Team Manager activity query `leads where userId==uid` has no companyId filter and no limit (it fetches all, then slices 15). | admin-manager.js:253-263 | Perf; possible rules refusal (suspected). | Add `where companyId`, `orderBy`, `limit(15)`. |
| ST-F40 | P3 | A | ST-060 | The Access Methods panel is static: there is nothing behind "enable or disable each one" or "reveal the active code". | dashboard.html:4737-4761 | False copy. | Make the copy informational. |
| ST-F41 | P3 | A | ST-059 | Rotate Access Codes and Run Migrations are shown to tenant owners; the prompt names NBD's codes. | dashboard.html:5165-5170; admin-manager.js:671 | NBD-internal controls leak to other tenants. | Show only for `claims.role==='admin'`. |
| ST-F42 | P3 | A | ST-061 | The session card falls back to the name "Joe". "Session started" is when the tab was opened, and unknown providers show as "Access Code". | dashboard-bootstrap.module.js:6938,6945-6951 | NBD name shown to tenants; wrong times. | Use `'—'` and `auth_time`. |
| ST-F43 | P3 | A | ST-062 | "Export Photos (ZIP)" produces a CSV of your own photo URLs; "Export Estimates" silently stops at the 500 loaded estimates. | dashboard-bootstrap.module.js:6888-6930,4271 | Labels overpromise. | Relabel; query estimates directly. |
| ST-F44 | P3 | B | ST-057 | Team Manager error messages go into `innerHTML` unescaped. | admin-manager.js:127-128,659-660 | Low XSS risk. | `escapeHTML`. |
| ST-F45 | P3 | B | ST-058 | Team Manager role change has no confirm, even on a demotion. | admin-manager.js:364-385 | One-click privilege change. | Add `nbdConfirm`. |
| ST-F46 | P3 | B | ST-053 | The Settings invite role list omits company_admin, which the server and Team Manager allow. | dashboard.html:4644-4648; functions/handlers/invites.js ~512 | Two inconsistent flows. | Add the option or document it. |
| ST-F47 | P3 | B | ST-053 | Send Invite is not disabled while the request is in flight. | dashboard-team-tab.js:25-59 | Double-click sends two invites. | Disable in try/finally. |
| ST-F48 | P3 | B | ST-067 | Five plan cards render into a 4-column grid. | dashboard-billing-tab.js:82; dashboard.html:4905 | One card sits alone on a second row. | `auto-fit` grid. |
| ST-F49 | P3 | B | ST-064 | Suspected: erasure wording keys off `companyId!==uid`, so a new owner after a hand-off gets "suspend" copy. | dashboard-api.js:313-314 | Wrong copy. | Use `companies/{id}.ownerId`. |
| ST-F50 | P2 | A | ST-026 | Business Rules has no client role gate: every role gets an editable form that is always denied on Save. This is the trigger for F02. | tenant-rules-settings.js:38-83,138-139 | Wasted edits; see F02. | Render read-only via `NBDUpgradePriceSettings.canEdit`. |
| ST-F51 | P2 | B | ST-035 | Pipelines ✕ "remove from this pipeline" has no occupancy check. Leads on that stage fall into the view's first (New) column. (🗑 delete is guarded.) | pipeline-builder.js:351-354 vs 177-183; crm-stages.js:588-590 | Removing Closed shows won jobs as New. | Apply `canDeleteStage` before splicing. |
| ST-F52 | P2 | A | ST-075 | Bots & API timezone loads as UTC when the company never set one; the next Save writes `companyProfile.timezone='UTC'`. | agent-bots-settings.js:120-132,272-274; functions/agent-mcp-logic.js:1455 | Bot "today" and contract-date logic go wrong; the warning disappears. | When unset, select '' or `browserTz()`. |
| ST-F53 | P2 | A | ST-073 | The AI persona defaults to and persists `identityName:'Joe'` for any tenant's rep without a displayName; the preset is labelled "Joe Classic". | ai-texting-persona.js:37,71-75,85,147,212; functions/handlers/ai-persona.js:81,153 | Another company's homeowner texts are signed "Joe's assistant". | Default to '' (the server fills from the tenant). |
| ST-F54 | P2 | B | ST-073 | A failed persona load is silent and shows defaults as if saved; Save then overwrites the real persona. The panel only renders once. | ai-texting-persona.js:352,360-365 | One blip wipes the rep's custom voice. | Show an error, disable Save until loaded, offer a retry. |
| ST-F55 | P3 | B | ST-035 | A deleted custom stage stays on the server: merge writes can't delete nested keys. | pipeline-builder.js:378-384,450; company-profile.js:289-305 | Config bloat. | `deleteField()` via `updateDoc`. |
| ST-F56 | P3 | A | ST-026 | When NBD saves business rules, the built-in tier labels and shingle locks are frozen as overrides; the comment at :132 is wrong. | tenant-rules.js:142-148,205-216; tenant-rules-settings.js:132-134 | Later config changes stop reaching NBD. | Skip values equal to the built-ins. |
| ST-F57 | P3 | A | ST-073 | The persona team-default checkbox is hidden from company_admin, though the rules allow them. | ai-texting-persona.js:65-69; firestore.rules:2321-2325 | Admin can't publish the team voice. | Add the company_admin role. |
| ST-F58 | P3 | B | ST-073 | The AI stats card shows "No AI reply drafts yet" when the callable fails. | ai-texting-stats-card.js:39,67-72 | Errors look like empty data. | Add an error sentinel. |
| ST-F59 | P3 | B | ST-073 | The persona tab wrapper calls `prev(tab)` without `this` / return, so wrapped panels load even when the pipeline leave-guard cancels. | ai-texting-persona.js:372-375; pipeline-builder.js:638-643 | Wasted callables. | `prev.apply(this, arguments)`. |
| ST-F60 | P1 | A | ST-051,083,085 | Re-running the setup wizard (`?redo=1`) overwrites the business email and the lead-alert email with the login email. `obEmail` is prefilled from `user.email` before the profile prefill (`setIfEmpty`). | pages/onboarding.js:346-367,190,225 | A tenant's separate alert inbox is silently replaced; public leads alert the wrong inbox. | Prefill from the profile first; use `user.email` only if still empty. |
| ST-F61 | P2 | A | ST-085 | A wizard re-run can revert a company name changed in Settings: it prefills from `users.company` before `brand.legalName`, and Settings never updates `users.company`. | pages/onboarding.js:353,364 | Rename undone on Finish. | Read the brand first. |
| ST-F62 | P2 | A | ST-086 | Free email signup: if any step after `createUserWithEmailAndPassword` fails, the retry hits email-already-in-use, leaving an account with no users doc or tenant. Raw Firebase text is shown. | pages/register.js:230-268 (contrast :279,330-333) | Stranded new customers. | Reuse the `currentUser` path and the friendly error map. |
| ST-F63 | P2 | B | ST-078 | A native `confirm()` for signed-out Subscribe (only the `already_subscribed` alert is allowed). | pricing-page.module.js:60 | Dialog rule. | Redirect to register, or show an inline note. |
| ST-F64 | P3 | A | ST-045,085 | Service area is stored twice (top-level `serviceArea` from the wizard and Settings; `brand.serviceArea` from `createCompany`); the microsite prefers brand. | pages/onboarding.js:228; functions/handlers/provisioning.js:153; functions/handlers/public-site.js:174 | Edits never reach the public site. | Write both from the wizard and from Settings. |
| ST-F65 | P3 | A | ST-078 | Subscribe reads `auth.currentUser` before auth is ready. | pricing-page.module.js:50 | A signed-in user is pushed to register. | Await `authStateReady()`. |
| ST-F66 | P3 | B | ST-078,089 | Plan prices are hard-coded in 4 places with no tie to the Stripe price ids (secrets). Drift is suspected but unverifiable from the repo. | pricing.html; register.js:89-93; functions/stripe.js:153-157 | Possible price mismatch. | Jo confirms the Stripe amounts; add a contract test against billing.js. |
| ST-F67 | P3 | B | ST-094 | Suspected-dead legacy access-code shim still signs in with a server-returned email and password. | login.js:435-439,475-478 | Exposure if still live. | Confirm prod returns `customToken`, then delete the shim. |
| ST-F68 | P3 | B | ST-086 | Register company placeholder is "No Big Deal Home Solutions". | register.html (`#regCompany`) | Invites copying NBD's name. | Neutral placeholder. |
| ST-F69 | P3 | B | ST-090,094 | Login error copy hard-codes NBD's phone number. | login.js:415,444,507 | Platform support routes to the roofing line. | Support email or link. |
| ST-F70 | P3 | B | ST-078,079,086,090 | Bare brand hexes instead of CSS vars (13× #BD5728, off-palette #ff8420). | pricing.html:31-99; pricing-page.module.js:35; onboarding.html:213; register.html:466; login.html:241 | Theme can't repaint them. | `var(--orange)`. |
| ST-F71 | P3 | B | ST-081,082,084 | Wizard step changes don't move focus; Skip has no busy state. | pages/onboarding.js:88-102,314 | A11y; double Skip. | Focus the first input; disable Skip while it runs. |
| ST-F72 | P3 | B | ST-093 | Login tabs lack `role=tab` / `aria-selected`. | login.html:265-267 | SR semantics. | Add the ARIA. |

(ST-F19 is unused: that number was dropped while drafting.)

## Section 3 — Notes

### 3.1 SETTINGS-EFFECT MATRIX

"Read at" names the consumer that makes the setting take effect. "PURGED" means the localStorage copy is removed by `purgeAccountStorage` (nbd-auth.js:788-845) at sign-out / account switch. Paths without a prefix are under `docs/pro/js/`; `fn/` = `functions/`.

**Profile** (users/{uid}, setDoc merge, bootstrap:5009-5020; loaded by bootstrap:4904)

| Field id(s) | Saved to | Read to take effect | Status | Notes |
|---|---|---|---|---|
| settingsName | Auth `updateProfile` + users.displayName | bootstrap:5004-5006 (header, greetings); `_currentRep` :5024 | LIVE | — |
| settingsEmail | — (read-only, from auth) | — | N/A | — |
| settingsCompany | users.profileCompany | none | DEAD | F07 |
| settingsPhone | users.phone | fn/portal.js:1177 (homeowner "call your rep", warranty SMS) | LIVE | Blank after a load failure, then clobbered on save (F06) |
| settingsRole | users.jobTitle | none (every jobTitle hit is a job's title) | DEAD | F07. Select has no value attrs; the loader matches text |
| settingsLicense | users.licenseNumber | none | DEAD | F07 |
| settingsCalcom | users.calcomUsername (normalized) | fn/integrations/calcom.js:141,239; fn/portal.js:1168,1242; booking-events.js:126; dashboard-ui.js:867-904; crm-portal-bridge.js:798 | LIVE | F06 clobber risk |
| settingsGoogleReview | users.googleReviewUrl (https only) | fn/portal.js:1321,2274-2287; fn/review-ask-auto.js:57; review-engine.js:147; review-handoff.js:233; portal.js:1641 | LIVE | F06 clobber risk |
| settingsWeeklyDigest / settingsDormantNudge / settingsReviewNudge | users.weeklyDigestEnabled / dormantNudgeEnabled / reviewNudgeEnabled | fn/weekly-digest.js:460; fn/dormant-leads.js:278; fn/review-request-nudge.js:535 (`=== false` opt-out) | LIVE | — |
| crmSecHeaderToggle | LS nbd_crm_sec_header_enabled | dashboard-ui.js:2723 | LIVE, PURGED | F24 |
| kanban density buttons | LS nbd-kanban-density | dashboard-state.js:618; dashboard-ui.js:1734 | LIVE | Kept at sign-out |
| crmViewAuto/Board/List | LS nbd-crm-view-mode | crm-list-view.js:47-73 | LIVE | Repainted via capture-click only |
| kanbanBoldToggle | LS nbd-kanban-bold | dashboard-state.js:622 | LIVE, PURGED | F24 |
| crmAutoCollapseToggle | LS nbd-crm-autocollapse | dashboard-ui.js:2459 | LIVE | — |
| cashGoalInput | LS nbd_monthly_goal + userSettings.monthlyGoal (merge, cash-card.js:193) | cash-card.js:89-105; widgets.js:285,344 | LIVE | PURGED, then read back from Firestore |
| clearJoeKey | removes nbd_joe_key + nbd_joe_chat | ai.js:34-46 | LIVE | F30 |

**Appearance** (sub-audit; repaint = shows the stored value when the tab opens)

| Field id(s) | Saved to | Read to take effect | Status | Notes |
|---|---|---|---|---|
| te-mode buttons | LS nbd_pro_mode_pref | theme-engine.js:5704; theme-mode-preboot.js | LIVE, PURGED | No cloud copy |
| te theme cards | LS nbd_pro_theme / nbd-theme + userSettings.theme (merge) | theme-engine.js:6163,6189 | LIVE | Overridden by custom-theme inline vars (F21) |
| te-overlays-toggle | LS nbd-theme-overlays | theme-overlays.js:63 | LIVE, PURGED | — |
| te-sound-toggle | LS nbd-theme-sound | theme-sounds.js:647 | LIVE | Not repainted (F26) |
| professionalModeToggle | LS nbd_professional_mode | dashboard-ui-prefs-boot.js:21 | LIVE, PURGED | Blank on open (F23) |
| sidebarLabelsToggle | LS nbd-sidebar-collapsed | dashboard-ui.js:2081 | LIVE, PURGED | Blank on open (F23) |
| gxMaster / Glow / Bg / Intensity / Accent | LS nbd_gx_settings | theme-gx.js:414,430,466 | PARTIAL, PURGED | Reset broken (F22) |
| tbAccent…tbBorder, tbName | LS nbd_custom_theme | dashboard-custom-theme.js:57-71 | PARTIAL | Only applied when Settings opens (F21) |
| UI size / font grid | LS nbd_ui_size / nbd_font | prefs-boot:70-74,251-254 | LIVE | Kept |
| shape / material buttons | LS + userSettings.shapeStyle / materialStyle (merge) | shape-preboot.js; material-preboot.js; prefs-boot:429,688 | LIVE | — |
| autoTheme / stormMode | userSettings.autoTheme / stormMode (merge) | auto-theme.js:626; storm-mode.js:715 | LIVE | — |
| myskin* (≈35 controls) | userSettings.mySkin (merge / dotted update) + Storage / IndexedDB | my-skin.js:114-136,1344 | LIVE | Silent load failure (F25) |
| pxSkin / pxScanlines / pxDialog / pxWorldUser / pxWorldCompany | userSettings.pixelMode / pixelWorld; companyProfile.pixelWorld | pixel-mode-core.js:125-134,377 | DEAD for users with it off | Listeners never attach (F20) |
| sidebar customizer | LS nbd_sidebar_hidden | prefs-boot:554-584 | LIVE, PURGED | — |
| achievements | userSettings.themeUnlocks (merge) | theme-achievements.js:171 | LIVE | Hologram unreachable (F29) |

**Estimates** (device half = LS `nbd_est_settings_v3` via `EstimateBuilderV2.updateSettings`, plus a write-only copy `userSettings/{uid}.estimateSettingsV2`; company half = `companyProfile/{key}.pricing.*` via `_saveCompanyProfile` (merge) and a dot-path `updateDoc` full replace at bootstrap:5818-5823, gated on a hydrated, same-tenant paint)

| Field id(s) | Saved to | Read to take effect | Status | Notes |
|---|---|---|---|---|
| v2rateEconomy…Beyond | pricing.tierRates (company) + device tierRates with tierRatesVersion | estimate-builder-v2.js:734 (applyCompanyPricing), :959 (V3 cards / deal room), :1009 (per-SQ) | LIVE | Not written when unhydrated (honest warning) |
| v2costEconomy…Beyond | device costBasis | estimate-builder-v2.js:1115 (per-SQ internal margin) | LIVE, PURGED | F01 |
| v2minJob | device minJobCharge | estimate-builder-v2.js:1104 (per-SQ only) | LIVE, PURGED | F01 |
| v2roundTo | device roundTo | estimate-builder-v2.js:1093,1384; doc-preflight.js:495; estimate-supplement.js:135,355 | PARTIAL, PURGED | Not used by the V2 line-item builder (F03) |
| v2matMarkup / v2overhead / v2profit | device materialMarkupPct / overheadPct / profitPct | estimate-v2-ui.js:2612-2625 → :2641, :2848 → estimate-logic-engine.js:934-999; estimate-builder-v2.js:1333-1370; estimate-supplement.js:127-134,334-344 | LIVE but PURGED | Reaches the engine (old bug fixed); lost at sign-out (F01) |
| v2minRepair | device minRepairCharge | estimate-v2-ui.js:2628-2643,2858; estimate-builder-v2.js:1401 | LIVE, PURGED | F01 |
| defDumpFee / defExtraLayer | device dumpFee / tearOffExtraPerSq (cp.dumpFee overlay has no UI writer) | estimate-builder-v2.js:1024,1037 (per-SQ only) | PARTIAL, PURGED | The line-item scope uses the catalog dump-fee item (:1279) instead |
| defTaxRate | pricing.fallbackTaxRate + device | estimate-builder-v2.js _withTenantCounties :808+ | LIVE | — |
| permHamOh…permCamKy, taxHamOh…taxCamKy (14) | pricing.permits / countyTax (full replace) + device | estimate-builder-v2.js:1283 (permit line), _withTenantCounties; estimate-logic-engine.js:1017 | LIVE | — |
| jurRows (name / cost / rate) | pricing.customJurisdictions (full replace) | estimate-builder-v2.js _tenantJurisdictions; county pickers | LIVE | — |
| v2addon* (14) | pricing.addonPrices | estimate-builder-v2.js:735 → per-SQ add-ons | LIVE | Per-SQ path only |
| upgrade price rows | pricing.upgradePrices (changed entries only) | upgrade-pricing.js:208; job-templates.js:1364 | LIVE | Restores on deny |
| Business rules: tiers enabled / labels / notes / warranty / shingle locks; deposit under / pct / round | companyProfile.businessRules.* | tenant-rules.js:124-216 → estimate-config.js:88,111,317,334,359; estimate-v3-wizard.js:543; deposit-rule.js:230; fn/tenant-ops-logic.js:217; warranty lines in document-generator.js:2420 etc. | LIVE | F02 / F50; depRound 0 becomes $25 |

**Pipelines / Daily / Company / Company Profile**

| Field id(s) | Saved to | Read to take effect | Status | Notes |
|---|---|---|---|---|
| pipeline stage label / color / role / hidden / order / custom stages | companyProfile.pipelines.stages / views (merge; views arrays replaced) | bootstrap:178-257 applyPipelineConfig → crm-stages.js:571,1266; crm-pipeline.js:632-660 | LIVE | Repaints without reload. F51, F55 |
| ds-cat / ds-target / ds-deadline / floors / ds-goose / ds-showgoose | LS nbd_user_config (+_at) + userSettings.dsConfig (merge) + derived LS nbd_ds_config | widgets.js:699-763 (Home widgets); daily-success/js/app.js:4,230; restore widgets.js:1005-1023 | LIVE | Category blank-on-load, then clobbered (F12) |
| ds theme grid | LS ds-theme | daily-success/js/app.js:1390 (3rd fallback only) | DEAD in practice | F13 |
| coName…coRadius (18) | userSettings.company (merge) + LS nbd_company_settings | none (own loader only) | DEAD | F04 |
| cp_brand_legalName / displayName | brand.legalName / displayName | company-profile.js:778-804 `_brand()` → every doc / portal / email; fn/handlers/public-site.js:166-167 | LIVE | Docs read at generation time, so changes apply without reload |
| cp_brand_logoUrl / cp_logoFile | brand.logoUrl (callable `uploadCompanyLogo` re-encodes) | company-profile.js:819-830 `_brandLogoSrc`; public-site.js:169 | LIVE | — |
| cp_brand_colorPrimary / Accent | brand.colors (only when touched) | `_resolveBrand`; public-site.js:170-172; doc generators | LIVE | — |
| cp_brand_phone / email / website / address (mirrored to business*) | brand.contact.* + businessPhone / Email / Website / Address; email also to contact.alertEmail | document-generator.js:2182-2185; fn/alert-recipients.js:227; fn/lead-alert.js:140; fn/handlers/public-site.js:176-179 | LIVE | Can't clear (F11); Settings never writes alertSms |
| cp_brand_mailingAddress | brand.contact.mailingAddress | fn/email-suppression.js:271; ky-insurance-law.js:1029 | LIVE | F11 |
| cp_brand_zellePhone / zelleEmail | brand.contact.zelle* | document-generator.js:29-30,75-94; invoice-pipeline.js:1096-1097; fn/zelle-contact.js:56-57 | LIVE | F11 |
| alert confirm / revoke buttons | callable alertRecipients | fn/alert-recipients.js | LIVE | Owner-only server side |
| cp_businessName…cp_businessLicense | top-level business* | document-generator.js:2181-2186; tenant-rules.js:263; fn/doc-drafts-logic.js:158-163; fn/render-pdf.js:579 | LIVE | — |
| cp_cancellationContractClause / ProposalShort, cp_changeOrderClause(Short), cp_disputeResolutionClause, cp_entireAgreementClause, cp_paymentTermsContract / Proposal, cp_paymentMethodsNoCash, cp_materialsWarrantyDisclaimer, cp_limitationOfLiability | top-level (defaults stripped; neutralized for tenants) | document-generator.js:2590-2604,2726,2778,2853-2893,3475,1266 | LIVE | — |
| cp_latePaymentChargeText | top-level | document-generator-templates.js:1154,2687 | LIVE | — |
| cp_cancellationWindowText / cp_cancellationStatute | top-level | none (defaults / neutralizer only) | DEAD | F10 |
| cp_proposalValidityDays | top-level | none: paper hard-codes 30 days | DEAD | F10 |
| cp_financePartner / cp_tier0-2_{apr, months, label, badge} | financePartner / financingTiers[3] | document-generator-templates.js:525,1153,1572,1756,1767,2688 | LIVE | — |
| cp_tagline / cp_serviceArea / cp_svc0-5_* / cp_vp0-3_* | tagline / serviceArea / services[] / valueProps[] | document-generator-templates.js:1555-1572,1613,2394,2469; document-generator.js:2194,3473,3564; fn/handlers/public-site.js | LIVE | serviceArea dual copy (F64) |
| cp_codeCycle / cp_codeJurisdiction | top-level | document-generator.js:3114-3120,3201 | LIVE | — |
| cp_budget_directCostPctWarn / marginFloorPct | budgetDefaults | expense-config.js:178-192; expenses.js:987 | LIVE | — |
| cp_salesLinks_dealLinkDays | salesLinks.dealLinkDays | close-board.js:495; fn/estimate-send-logic.js:172-219; fn/deal-acceptance.js:285; fn/estimate-send.js:345 | LIVE | — |
| cp_siteSlug / publish / unpublish | callables setSiteSlug / publishTenantSite → companies/{key}.siteSlug / sitePublished | fn/handlers/public-site.js | LIVE | — |

**Team / Access / Billing / Notifications / AI / Bots / Help / Onboarding**

| Field id(s) | Saved to | Read to take effect | Status | Notes |
|---|---|---|---|---|
| inviteRepEmail / inviteRepRole | callable createTeamInvite → companies/{co}/members/{email} | dashboard-team-tab.js:82 (roster); invite claim | LIVE | F46, F47 |
| row actions / make owner / seats | callables removeMember / deactivateUser / transferCompanyOwnership / assignSeats / setCompanySeatCount | server | LIVE (seat buy dark by flag) | — |
| Team Manager create / edit role / deactivate | createTeamMember / updateUserRole / deactivateUser | server | LIVE | F45 |
| accessCodeStatus | nothing writes it | — | DEAD | F40 |
| exports / GDPR / sign-out-everywhere / company ZIP | client CSV; exportMyData / requestAccountErasure / revokeMySessions / exportCompanyData | — | LIVE | F43 |
| billing meters | read subscriptions/{companyId}.usage | billing-gate.js:148-281 | LIVE | F37 |
| aiUsage* | LS nbd_ai_usage (claude-proxy.js:117-137) | bootstrap:6962 | PARTIAL, PURGED | F35 |
| notifCritical / Digest / Firehose (mode) | LS nbd_notif_settings (kept) + userSettings.notifications (merge) | bootstrap:6670-6681 shouldFireNotif ← crm-snooze.js:228,362,399; review-engine.js:344; tasks.js:23-30 | LIVE (client-side alerts only) | — |
| notifOverdue / notifApproval / notifNeedsField | same | shouldFireNotif via follow_up / task_overdue / estimate_approved / needs_field | LIVE | — |
| notifHot / notifStorm / notifInbound / notifD2d | same | none | DEAD | F08 |
| chInApp / chPush | same | tasks.js:29-30; crm-snooze.js:362 | LIVE | — |
| chEmail / chSms | same | none (servers never read it) | DEAD | F08 |
| away mode (ack minutes, backup) | callable (functions/away-mode.js) | server | LIVE | Owner-ish only |
| aipName / aipSignOff / aipNotes / traits / preset | users/{uid}/settings/aiPersona (merge) | fn/handlers/ai-texting.js:287 | LIVE | F53, F54 |
| aipCompanyDefault | companyProfile.aiTexting.defaultPersona | fn/handlers/ai-texting.js:277 | LIVE | F57 |
| sccEnabled / DNC add / lift | callable manageSmsCompliance → sms_settings / sms_dnc | fn/sms-dnc.js | LIVE (Tier C) | — |
| abEnabled / abRules | agent_settings/{cid} | fn/agent-mcp.js:112,332,609 | LIVE | — |
| abTz | companyProfile.timezone | fn/agent-mcp-logic.js:1450 | PARTIAL | UTC clobber (F52) |
| bots / keys | agent_bots / agent_keys (hashed) | fn/agent-mcp.js:615-700 | LIVE | — |
| hotkey toggles | LS nbd_hk_disabled_<id> | bootstrap:2622-2681 | LIVE, PURGED | F24 |
| onboarding obName / obDisplayName / obPhone / obEmail / obWebsite / obAddress / obTagline / obLogoUrl / obColor* | companyProfile brand.* + business* (merge, empties omitted); users.company | `_resolveBrand`; document-generator.js:2181-2186; fn/handlers/public-site.js:166-179; fn/alert-recipients.js:227-228 (alertSms from obPhone) | LIVE | Re-run overwrite (F60, F61) |
| obServiceArea | top-level serviceArea (createCompany writes brand.serviceArea) | document-generator.js:3473; fn/handlers/public-site.js:174 (prefers brand) | PARTIAL | F64 |
| obSeal | callable reserveCompanyPrefix | functions/customer-id.js | LIVE | — |

### 3.2 Other notes for the orchestrator

- **Role gating.** No Settings tab is hidden by role (dashboard.html:3164-3173), and role-gate.js blocks none of the settings handlers by design ("a viewer's own user-scoped writes … are untouched", role-gate.js:43).
  - **Per-user panels:** Profile, Appearance, Daily, Notifications, AI persona, Help and the Access self-service controls can be saved by every role, which is correct.
  - **Company-wide panels:** Estimates company half, Company Profile, Business Rules, Pipelines, Upgrade prices and Bots tenant settings are writable only by owner / company_admin (firestore.rules cpCanWrite :2321-2325; I did not judge the rules further).
    - Client gates exist for Pipelines (pipeline-builder.js:86-93), Upgrade prices (upgrade-price-settings.js:268-278), SMS rules (sms-compliance-settings.js:61-64), Connect (dashboard-connect-tab.js:47-50), Prod flags and the Team Manager route (admin-manager.js:80-106,611).
    - There is **no client gate** for Estimates Save All, Company Profile, Business Rules or the Team tab. A sales_rep / viewer gets fully editable forms, a denial message on Save, and (F02) the rejected values live in memory.
    - Team tab invite / remove / disable controls are shown to all roles; the server refuses them (F36).
    - The "Make owner" button is owner-only.
- **Company-profile repaint.** Document generators, the portal bridge and email helpers resolve `_brand()` / `_legal()` / `window._companyProfile` at call time, so a saved Company Profile reaches new documents without a reload; already-generated documents keep their snapshot. The Estimates panel, Pipelines, Business Rules, Upgrade prices and the setup checklist repaint on `nbd:company-profile-loaded`, which fires on load only, not on save.
- **Blank-on-load list:**
  - Daily category (F12)
  - Profile fields after a silent load failure (F06)
  - Professional mode / Sidebar labels / Ambient sound checkboxes (F23, F26)
  - Bots timezone shows UTC (F52)
  - AI persona defaults after a load failure (F54)
  - Profile Role select falls back to the first option when the stored jobTitle isn't an option (harmless: DEAD field)
- **No setDoc-without-merge clobber** in any settings writer. I scanned bootstrap, dashboard-actions, company-profile, tenant-rules-settings, upgrade-price-settings, pipeline-builder, ai-texting-persona, my-skin, pixel-mode-core, cash-card, auto-theme, storm-mode, prefs-boot, theme-engine, theme-achievements, dashboard-ui, deal-packet and game-card; the only non-merge setDoc is the lead create at bootstrap:3750, which is out of slice. The intended full replaces are customJurisdictions, permits, countyTax and pipeline view arrays.
- **Duplicate engines / stores:**
  - Two lead-CSV exporters: data-export.js (Profile) and `_exportAllData` (Access).
  - Two invite flows: createTeamInvite (Settings) and createTeamMember (Team Manager).
  - Two "company" stores: the DEAD Company tab and Company Profile.
  - Two serviceArea copies.
  - Two Daily Success category vocabularies.
  - Per-device vs company estimate settings in the same panel, with no visual distinction except copy.
- **Not assessed:**
  - firestore.rules beyond noting.
  - Stripe amounts (secrets).
  - Server-side quiet-hours enforcement for SMS.
  - Live browser behaviour: the Reach, Mobile and A11y columns are left to the harness.
  - Whether the V3 wizard (estimate-v3-wizard.js) routes through `shopLineItemRates`. I did not trace it; if it doesn't, F01 / F03 also apply there differently.
- **Coverage ledger:** 227 rows match this slice: PASS 160, UNTESTED 42, FAIL 14, BLOCKED 8, FIXED 3. Of those, `d7-settings-*` is 185 rows: PASS 124, UNTESTED 41, FAIL 14, BLOCKED 3, FIXED 3.
  - Stale rows for removed ids: d7-settings-030/031 (`#joeKeyInputSettings`, saveJoeKeyFromSettings), 074-076 (`defPitch` / `defWaste` / `defDeckPct`), 129 (`cp_insuranceAssignmentClause`).
  - PASS on DEAD fields (co* 096-115, cp_cancellationWindowText 122, cp_cancellationStatute 123, cp_proposalValidityDays 135, notifD2d 173) means "saves", not "takes effect".
  - No ledger rows exist for:
    - Pipelines, AI Texting, Bots, Business Rules, Upgrade prices, Add-on rates, My Jurisdictions
    - v2rateEconomy / Beyond, v2costEconomy / Beyond, v2minRepair
    - Brand Identity (cp_brand_*), logo upload, alert confirm, site slug / publish, budget, deal-link days
    - Away mode, Team Manager, Prod flags, Connect, Pixel Mode, My Skin
    - onboarding.html, pricing.html body
- **Test gaps:**
  - Profile save / load, Company tab, Notifications (`shouldFireNotif` mapping), Daily category round-trip and Company Profile form read / populate (`_cpReadFormToProfile`; only regex shape checks in email-unsubscribe.test.js:982-987) have no behavioural unit tests.
  - Nothing tests that estimate settings survive sign-out (F01), or that a denied company save restores memory (F02).
  - Onboarding re-entry prefill order (F60 / F61) is untested.
- **Open PRs:** #2914 / #2915 / #2917 touch pricing.html, register.html and login.html. ST-078…095 findings are against HEAD 74bc5840; re-check them after those land.
