# NEXT SESSION — 2026-09-25

> **Update 2026-09-26:** superseded by [NEXT_SESSION-2026-09-26](NEXT_SESSION-2026-09-26.md). Every §0 ask below was answered and built the same day. The Upgrades pricing and warranties were decided and stages 1–2 merged, and the read-only production audit of Classic re-priced logged estimates found 0 affected.

A phone-scale power session (ultracode), plus a product design for Upgrades & Add-ons.

## §0 — Start here

1. **Jo owes three answers** before the upgrades build can start. Details are in [UPGRADES-ADDONS-DESIGN-2026-09-25](UPGRADES-ADDONS-DESIGN-2026-09-25.md) → *Decisions Jo still owes*:
   - the Alu-Rex retail price (from his gutter sub's price to NBD);
   - a LeafBlaster PRO Frame-Reinforced price;
   - a yes or no on the recommended workmanship split: 5 years on new gutter systems (only if the installing sub backs it in writing), 2 years on guard-only installs, 1 year on repairs.
2. **Slice 0 of the upgrades design is ready to build now:** honest paperwork. The tier row does nothing on all 107 templates, and gutter paperwork prints "Preferred" and a lifetime-workmanship sentence that contradicts NBD's written 2-year warranty.
3. **Money data repair:** read-only audit of production *logged* estimates that the Classic builder already re-priced to the $2,500 minimum and saved. Signature: `builder:'classic'` with `amount` ≠ `grandTotal`; the original price survives in `amount`. #1749 stops new damage; old damage is unrepaired.

## §1 — What merged (all live)

| PR | What |
|---|---|
| #1743 | Date of Loss sits beside Damage Type in Add/Edit Lead. It used to be inside the insurance-only block, hidden on every other job type, which is part of why 0/216 leads had one. Add Lead no longer inherits the last edited lead's claim fields. |
| #1744 | Pre-registered the nine `phone-<lane>.spec.js` names in `test:e2e:authed:emu`. |
| #1751 | Removed a published contractor cost ("Contractor cost $75/box", RFG NAIL-LUMA). The privacy test's prose layer now sweeps the Xactimate catalog and job templates too. |
| #1745–#1750, #1752–#1754 | The phone fix campaign: 72 findings across 9 lanes, all merged. See [phone-audit-2026-09-25](../qa/phone-audit-2026-09-25.md). |

**Production fix inside #1746: remote signing works again.** A global `Cross-Origin-Resource-Policy: same-origin` had blocked `signature-widget.js` in the sandboxed signing frame since about April. An exact-path CORP rule now allows it; verified live after deploy.

## §2 — Upgrades & Add-ons (designed, not built)

- Read [UPGRADES-ADDONS-DESIGN-2026-09-25](UPGRADES-ADDONS-DESIGN-2026-09-25.md).
- Jo's call: upgrades are their own feature for every category, and they never ride the Good/Better/Best buttons.
- Build order: slice 0 (honest paperwork), then 1 (gutters, cash), then 2 (roofing ladder), then 3 (other trades), then 4 (homeowner picks on the texted link), then 5 (the insurance addendum).
- Gutter guard facts:
  - Jo installs Amerimax Lock-In large mesh ($6/LF retail) and LeafBlaster PRO micromesh ($12/LF).
  - Alu-Rex is available only through his certified sub. **Leaf Sentry is dropped.**
  - LeafBlaster's warranty is 40-year **parts only**, so never call it "lifetime" or "no-clog".
- Jo already sells this way: his hand-built proposals are "same gutter, only the screen changes". His real pricing lives in Drive-imported PDFs, not CRM estimates.

## §3 — Follow-ups from the phone campaign

See the ranked list in [phone-audit-2026-09-25](../qa/phone-audit-2026-09-25.md) → *Follow-ups*. The top ones:
- the signing contract is still print-size in the doc viewer and the portal document view;
- invoice numbering;
- the second tap on the pipeline ⋯ doesn't close its menu;
- toasts over chrome;
- 360px coverage in specs;
- spec data cleanup.

## §4 — Rig lessons

- The shared Firestore emulator wedges under parallel E2E load (dead listener channels). Monitor responsiveness and restart + reseed at once.
- Lanes must not run private emulators; they share the storage blob dir.
- Don't message running workflow agents; it disrupts them.
- **The Windows hosting emulator applies no firebase.json headers** (superstatic glob bug). CI's Linux emulator does, so a header failure in CI is real.

Details: [phone-audit-2026-09-25](../qa/phone-audit-2026-09-25.md) → *Rig lessons*.
