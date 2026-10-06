# Estimate Engine — Status Matrix

**Run:** estimate-qa-2026-06-08 · Tenant: NBD · Deliverable #1
Legend: PASS · MATH-FAIL · DRIFT · FUNCTION-FAIL · GUARDRAIL-MISSING · DOC-MISMATCH · ⏳ pending

## Phase 0 — Ground truth ✅
| Check | Status | Evidence |
|---|---|---|
| Config loads live → `NBD_ESTIMATE_CONFIG` (not fallback) | **PASS** | `_version 2026-04-25` live in app, no warn |
| Tier rates 545/595/660 (code+live) | **PASS** | config + both engines + live `loadSettings` |
| Locked spec 8 values match brief | **PASS** | RATE-SHEET §A |
| Engines live in UI | **PASS** | both — estimates carry V2 & CLASSIC badges; builder offers both |
| Dashboard boots | **FUNCTION-FAIL (env, fixed)** | stale `/pro/sw.js` SW wedged navigation; unregister recovered → see INFRA-1 |

## Phase 1 — Functional (Axis B)
| Flow | Status | Evidence |
|---|---|---|
| Open V2 builder | **PASS** | Estimate Builder V2 modal, 270-item catalog, GAF |
| Engine lazy-loads (ScriptLoader) | **PASS** | `loadBundle('estimates')` → EBv2+Logic+222 products |
| County dropdown key shapes | **PASS** | V2 emits slugs, classic emits bare — each matches its engine |
| Pick products / set measurements | **PASS** | built ZZ_QA_ per-SQ estimate, 3000SF 6/12 Hamilton |
| GBB tiers render = engine | **MATH-FAIL** | V2-1 confirmed on-screen: $22,825/$24,850/$27,475 (1.25 waste) |
| Save → reopen (persistence) | **PASS** | `EstimateV2UI.save()` → ✓ Firestore; count 5→6; survived full reload |
| Generate estimate (retail quote) | **PASS (renders)** | doc generated client-side; server render FAIL (V2-4) |
| Generate work order/receipt/warranty | **NOT TESTED** | builder modal froze renderer twice; retail-quote covers fidelity |
| Docs match estimate | **DOC-MISMATCH** | V2-2 ($17k headline vs $22.8–27.5k tiers); ~~V2-5 line-item $0 formula items~~ → **V2-5 FIXED** (CSP-safe evaluator, `feat/estimate-csp-formula-eval`) |

## Phase 2 — Logic reconciliation (Axis A) ✅ (engine leg)
| Check | Status | Evidence |
|---|---|---|
| V2 per-SQ math vs spec oracle | **PASS 93/93** | tiers/pitch/min/round/layers/cutup/addons/tax/permit/insurance |
| Tier ordering Good<Better<Best | **PASS** | 160-pt sweep, 0 inversions |
| $25 rounding | **PASS** | 0 violations in sweep |
| Job minimum $2,500 | **PASS** | floors correctly, reads as dollars |
| Pitch→waste (V2 engine, correct input) | **PASS** | matches table |
| **Pitch→waste (V2 via live UI wiring)** | **MATH-FAIL** | V2-1: always 1.25 (over-quote 4–8%) |
| Chimney $425 | **MATH-FAIL/DRIFT** | L-1: live = $285 (stale localStorage) |
| Skylight $350 | **PASS** | live = 350 |
| County tax (each, +unknown 7%, insurance 0) | **PASS** | each engine w/ own key shape |
| Config loaded not fallback | **PASS** | confirmed live |
| Classic == V2 core formula | **PASS** | identical sq+addons+tax → identical total |

## Phase 3 — Guardrails / edges ✅ (engine leg)
| Check | Status | Evidence |
|---|---|---|
| Zero/negative/tiny SQ | **PASS** (clamp→$2,500) | no NaN/negative |
| Absurdly large SQ | **GUARDRAIL-MISSING (low)** | 1e9 sqft→$7.3B silently (math correct) |
| Many tear-off layers | **PASS** | correct; no cap |
| Zero/negative layers | **PASS** (clamp→1) | |
| Tier inversion attempts | **PASS** | impossible (monotonic) |
| Unknown county tax | **PASS** (7% fallback) | |
| Unknown permit jurisdiction | **GUARDRAIL-MISSING** | C-1: V2 silent $0 |
| 100× unit trap | **PASS** | totals in dollars, no 100× |
| Engine disagreement (waste/permit/tax) | **DRIFT** | D-1..D-4 (latent unless same job both engines) |
| Save/generate from money-losing estimate | ⏳ | test in functional flow |

## Open investigations
- **$642 CLASSIC estimate** ("[street address]") below $2,500 min — investigate (view-only).
- On-screen render of V2-1 (retail quote GBB prices) — confirm in save→generate flow.
