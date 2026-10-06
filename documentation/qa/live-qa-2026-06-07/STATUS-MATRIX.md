# NBD Pro — LIVE Hands-On QA — Feature Status Matrix

**Run date:** 2026-06-07
**Target:** https://nobigdealwithjoedeal.com/pro (LIVE prod, tenant zero)
**Prod commit under test:** `b27b9403` (2 ahead of brief ref `dfa6e65`; #570 hotkeys + #571 storage-rule landed since)
**Tester session:** authenticated as JD / tenant zero (Jo's handed-off Chrome session)
**Safe recipient:** email `jonathandeal459@gmail.com` · phone _(pending Jo's cell)_
**Stripe:** treated as LIVE → drive to pre-submit boundary, never submit

## Status legend
PASS · PARTIAL · FAIL · BLOCKED · DEAD · ⏳ pending

## Baseline (Phase 0)
- Smoke suite: **GREEN** — `smoke.test.js` 1808 passed / 0 failed; 16/16 other emulator-free specs pass.
- 8 emulator-backed specs (firestore-rules, x-tenant, storage, rate-limit, auth-access, lead-lifecycle, portal-token, public-intake) **not run** (need local emulator; out of scope for live sweep).

---

## Phase 1 — Core daily workflow

| # | System | Status | Evidence | Note |
|---|--------|--------|----------|------|
| 1 | Auth & access (login/logout/persist/plan-gate/tenant-scope) | 🟡 PARTIAL | 01-auth-access/ | Login ✅, session persists across reload ✅, tenant-scoped to JD ✅. Logout deferred to run-end (can't re-auth). Plan-gating not yet exercised (tenant-zero = full access). |
| 2 | Lead intake → pipeline | 🟠 MIXED (fix ready) | 02-lead-pipeline/ | **C-1 (CRITICAL) ✅ FIXED + DEPLOYED + CONFIRMED LIVE: Add/Edit Lead modal Save was a no-op — `saveLead` missing from `_NBD_CALL_ALLOWLIST`; one-line fix `4e1fac71` deployed to prod (run 27098999792, 8m20s) + verified in the served file.** **H-1 (HIGH): public /inspect persists+emails but never reaches CRM UI.** L-1 (LOW): Quick Add discards entered values. **✅ PASS: dedup** (HIGH-MATCH detection on addr+phone, Create-anyway override). ✅ lead create via `_saveLead` works. Still to test: stage move (kanban arrows/drag), lead scoring, snooze. |
| 3 | Customer / job record (detail, property-intel, tasks, notes, convert) | 🟡 PARTIAL | 03-customer-job/ | ✅ Quick-view + full customer page render; data round-trips (addr/phone/$12.5k/Roof-Hail/Insurance/No-Claim). ✅ **Lead scoring** (36 SCORE badge). Tabs (Overview/Photos/Docs/Voice Intel/Messages/Timeline/Contact) + stage-transition button present. L-2: timeline "Invalid Date" on new lead. Not yet exercised: convert lead→job, property-intel pull, task/note CRUD, stage move via arrows. |
| 4 | Estimate builder (G/B/B, catalog, pricing rules, round-trip) | 🟢 PASS (core) | 04-estimate-builder/ | V2 builder loads + all inputs work: Mode (Per-SQ/Line/Ins/Cash), Tier (Good/Better/Best), county pricing DB (7 OH/KY counties), measurements (area/pitch/layers/stories/cut-up waste), 270-item catalog (13 cats), 6 scope presets. "Standard Reroof" on 3000 SF/12-12 pitch/2-story → real line items scaled to **35.1 SQ** (≈17% pitch+waste uplift applied) priced from DB (GAF HDZ $6,318 etc.). Pricing engine computes live + unit-tested green. NOT done this session: save→reopen round-trip; line-by-line $35/$25/12% adder hand-check (covered by green estimate-pricing.test). |
| 5 | Documents / PDF (WO, deposit, warranty, estimate PDF, e-sign) | 🟡 PARTIAL | 05-documents-pdf/ | ✅ 15-type generator present ("Auto-filled with customer data"): Proposal/Estimate, Roofing Contract, Work Authorization, Scope of Work, Inspection/Insurance Report, Supplement, Warranty Cert, Cert of Completion, Invoice, Change Order, Before&After, Financing, Company Intro, Referral. ✅ **Graceful prereq validation** (WO correctly blocked: "requires scope of work" on a lead with no estimate). ⚠ Preview/generate uses a **print-based render that froze the CDP screenshot** (recovered on navigate) — couldn't capture output via browser tool, so navy/orange branding + logo + `NBD-WO-YYYY-MMDD` numbering NOT visually verified this session. Needs: build estimate→generate WO, or manual eyes. E-sign boundary not reached. |
| 6 | Photo engine (upload, AI classify, inspection/photo report) | 🟡 PARTIAL (upload BLOCKED) | 06-photo-engine/ | ✅ Photos UI well-built: Upload Photos / Review & Sort (→photo-review.html) / Share Gallery, filters Before/During/After/Annotated/Select, drop zone (JPG/PNG/HEIC/WebP/AVIF · 15MB · 25/batch), "No photos yet" empty state. ⛔ **Actual upload + AI classification + photo/inspection report BLOCKED**: the browser `file_upload` tool only accepts user-shared files; a generated test image is rejected ("only files the user has shared with this session"). Needs Jo to drag-drop a test photo manually OR share one with the session. |
| 7 | Customer portal (generate/preview/invite) | 🟢 PASS (after H-5 fix) | 07-customer-portal/ | **H-2 RESOLVED:** the "Missing or insufficient permissions" was the same claim-less-token root as H-5. After the claim fix, **portal generates + renders** (Jo confirmed: real lead → live portal "Jennifer's Project · Claim Filed · 25% · 90 photos"). Caveat: the *inline* preview iframe is blocked by **Brave Shields** (cross-origin embed — known Brave issue), but the app's "open in new tab" fallback works. In Chrome the inline preview renders. |
| 8 | Billing (read + Stripe boundary only) | 🟡 INCONCLUSIVE | 08-billing/ | No dedicated in-app billing/subscription screen found (Settings tabs = Profile/Appearance/Estimates/Daily OS/Company/Company Profile/Team — no Billing tab). Account = **professional** plan, so no upgrade/Stripe-checkout prompt surfaces (the lite-plan upgrade banner is what triggers Stripe). Invoice exists as a doc-gen type; profit is in the estimate builder's internal view. Stripe boundary not reachable in-app for this paid account — subscription likely managed via Stripe customer portal (external). Confirm with Jo where billing lives if in-app. No charge risk encountered. |

---

## Phase 2 — Everything else

| System | Status | Evidence | Note |
|--------|--------|----------|------|
| Comms (email-system, email-drip, nbd-comms, push) | ⏳ | | |
| Insurance claim system | ⏳ | | ZZ_QA_ claim only — never Customer EX/McCain |
| Sales subsystems (D2D, close-board, rep-os, leaderboard) | 🟢 PASS | 09-phase2/ | Leaderboard (KPIs + Monthly Trend chart), Close Board (deal-room KPIs + empty state), Rep OS (AI daily-briefing landing), Prospects=D2D knock board (3 real leads) all render cleanly, console clean. |
| Academy / training (insurance/retail trees, courses, masterclass) | 🟢 PASS | 09-phase2/ | Real Deal Academy renders: Overview/Insurance Process/Retail Process/Courses/Local tabs, progress KPIs (0/48 nodes, 0/33 lessons, quizzes, avg score), "No Activity Yet" empty state. Console clean. (Didn't drill into individual lessons.) |
| Storm intel (storm-center, storm-alerts, property-intel) | 🟢 PASS | 09-phase2/ | Storm Center renders: KPIs (0 alerts/zones/knocks, $0k), Live Alerts/Storm Zones/Canvass Plans/Storm Analytics tabs, Leaflet map + location dot, "No Active Alerts" empty state. Console clean. Refresh Alerts present (not exercised). |
| Analytics (KPI, reporting-dashboard, report-export, perf-monitor) | ⏳ | | |
| Theme engine (apply/persist/contrast/brand-bleed) | 🟢 PASS | 09-phase2/ | Applied Cyberpunk → instant live apply ✅; **persists across full reload ✅ (no FOUC)**; text legible. ~180 themes, 8 categories, Fonts/Comfort/Custom Builder tabs. Brand-bleed: public /inspect page uses its own navy/orange branding independent of rep theme (no bleed observed). Restore NBD Default at cleanup. |
| Maps / routing / crew-calendar | 🟡 PARTIAL | 09-phase2/ | Map UI/layers/pin-tools render ✅ (tiles blank — known Esri/Brave). But **H-4: searchMap/saveZone/spyglassSearch/searchDraw/save-drawing/material-takeoff/solar/screenshot/angles buttons were dead** (allowlist regression) — fix committed fe1f06c8. Map tiles not loading (Esri) is a separate minor issue. |
| Analytics (KPI, reporting-dashboard, report-export, perf-monitor) | 🟡 PARTIAL | 09-phase2/ | Dashboard/Leaderboard KPIs + funnel + ROI render ✅. **H-3: Reports loadReports throws Firestore INTERNAL ASSERTION → cascades, poisons client (breaks notifications).** Report-export not reached. |
| Offline / PWA (offline-manager, install prompt) | ⏳ | | |
| Company admin (read-only) | ⏳ | | Do NOT change access/billing config |
| AI features (Ask-Joe, ai_review_system, visualizer) | 🟡 PARTIAL | 09-phase2/ | **Ask Joe AI round-trip WORKS** — auto-greeting generated from live pipeline data ("17 active leads worth $95,700…", Claude Haiku via proxy). BUT **H-4: the SEND button (`sendJoeMessage`) + key-activate (`saveJoeKey`) were dead** (allowlist) — fixed + deployed (fe1f06c8). ai_review_system + visualizer not yet tested. |
| Additional tools (Products, Templates, Sales Training, Success Tracker) | 🟢 PASS | 09-phase2/ | Products: 222-item library/16 cats/23% margin. Templates: 24 NBD-branded docs (5 cats). Sales Training: Objection Obliterator + 6 scenario simulators. Success Tracker: `windowOpen` → /pro/daily-success/ (opens separate page; not deep-tested). All render, console clean. |

---

## Companion docs in this folder

The rest of this campaign, linked so each doc is reachable from the vault:

- [BUG-LOG](BUG-LOG.md) — NBD Pro — LIVE QA — Bug Log (2026-06-07)
- [CLEANUP](CLEANUP.md) — NBD Pro — LIVE QA — Cleanup Manifest (2026-06-07)
