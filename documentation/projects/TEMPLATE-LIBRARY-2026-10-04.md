# Template library — 2026-10-04

Jo, 2026-10-04: "we need to greatly expand templates contracts proposals etc",
and yes to lien waivers. This note is the inventory taken before building,
what was added, which templates wait on Jo's attorney, and what the recon
found along the way. Branch `feat/template-library`.

## Inventory (what existed on 2026-10-04)

The CRM's customer documents come from one engine, `NBDDocGen`
(`docs/pro/js/document-generator.js` core types +
`document-generator-templates.js` extended types), fed by the pre-flight
review modal (`doc-preflight.js`, `DOC_SCHEMAS`), shown in the doc viewer
(`nbd-doc-viewer.js`: Print, Download PDF via html2pdf, in-person signing,
"Send for Signature" → `createSignRequest`). Contract / invoice / change
order / receipt also have server Puppeteer templates
(`functions/print/templates/*.hbs`, `functions/render-pdf.js`), used only when
no signers are configured.

| Document | Renders | Reachable from |
|---|---|---|
| Proposal / Estimate (`renderProposal`) | scope, line items, tier warranty, deposit plan, photos; signable | customer.html Generate grid + Create Document modal; dashboard docs |
| Estimate exports (`estimate-finalization.js`) | Insurance Scope / Retail Quote / Single Quote / Internal View | V2 estimate builder finalize buttons |
| Estimate preview (`estimate-preview.js`, `estimate-view.js`) | mobile estimate sheet / viewer | tapping an estimate (dashboard, customer page) |
| Roofing Contract (`renderContract`; `contract.hbs`) | parties, scope, price, deposit plan, payment clause, change-order / cancellation / dispute clauses; KY insurance: KRS 367.624 notices + 5-day forms; server copy: FTC statement + forms | Generate grid + modal |
| Work Authorization, Scope of Work | permission to proceed / scope bullets; signable | Generate grid + modal |
| Change Order (`renderChangeOrder`; `changeOrder.hbs`) | description, add/remove items, original / change / new total, schedule note | Generate grid + modal |
| Payment Agreement | deposit-rule schedule | dashboard docs only |
| Invoice (`renderInvoice`; `invoice.hbs`) | line items, pay panel | Generate grid + modal; invoices panel |
| Receipt (`renderReceipt`; `receipt.hbs`) | proof of payment | **nothing** — renderer + pre-flight schema existed, no tile |
| Warranty Certificate (`renderWarrantyCertificate`; `warranty-cert.js` + `warranty.hbs`) | per-tier workmanship + manufacturer sentence | Generate grid + modal; dashboard warranty modal (`generateWarrantyCertPDF`) |
| Certificate of Completion | checklist, before/after photos, homeowner sign-off | Generate grid + modal |
| Inspection Report — homeowner / insurance (`renderInspection*`) | condition + photos | Generate grid + modal |
| Inspection reports engine (`inspection-report-engine.js`), Roof Report (`roof-report.js`) | shareable reports (reports/{id}) | dashboard reports, photo tools |
| Photo Report (`photo-report.js`, `customer-photo-report-*.js`; `photoReport.hbs`) | before/after photo PDF | customer page photos "Generate Report" |
| Supplement Request (`renderSupplementRequest`) + Supplement Builder (`estimate-supplement.js`, `supplement-ui.js`) | supplement letter | Generate grid; estimate "Supplement" button |
| Storm History, Before & After, Financing, Company Intro, Referral Card | marketing / reports | Generate grid + modal |
| Storm checklist, claim guide, door hanger, mailer, testimonial sheet, thank-you, material delivery | marketing | dashboard docs only |
| Envelope e-sign (`esign-setup.js`, `esign-sign.js`) | any uploaded PDF | customer page "Prepare for signature" |

## Added

`docs/pro/js/document-generator-library.js` (new, docgen bundle, after
-templates; renders through `NBDDocGen._tpl` so letterhead, footer, tenant
brand and signature block are the templates file's own):

- **Lien Waiver** — conditional / unconditional × progress / final; Ohio
  (ORC Ch. 1311) and Kentucky (KRS Ch. 376), state from the address via
  `ky-insurance-law.js`; payer homeowner / insurance company / mortgage
  company; amount (cents), through-date, check no., loan no., owner's claim
  no.; exceptions; optional notary block; KY insurance jobs carry the KRS
  367.628(2)(g) lien undertaking. Contractor signs in-app.
- **Notice of Right to Cancel** — plain-English how-to + the deadline (3
  business days, ky-insurance-law's counter) + the FTC 429.1(a) statement and
  two completed FTC forms (verbatim, from ky-insurance-law.js); Ohio Home
  Solicitation Sales Act / Kentucky home solicitation law named by state; a
  Kentucky insurance job also gets the KRS 367.624(3) notices and (4) forms.
  Homeowner acknowledges in-app.
- **Material & Color Selection** — shingle line (from the estimate), color,
  underlayment, drip edge, vents, gutters, guards; homeowner + rep sign.
- **Good-Better-Best Options** — one page, every priced package from the
  estimate's `prices`, labels/warranty from `estimate-config.js`, the
  payment row from `deposit-rule.js` (KY insurance: $0 at signing).
- **Insurance Next Steps** — homeowner letter: you own the claim, we
  document / estimate / meet the adjuster after you file / repair; not a
  public adjuster; Kentucky block (nothing at signing, 5-day cancel, $100).

Extended in place: change order (cents, computed New Total, schedule days +
new completion date, plain-English intro), warranty certificate (install
date, manufacturer warranty by name, shingle), completion certificate and
every signable -templates document (in-app signature pads). Receipt got its
tile.

## Attorney review (DRAFT badge in the CRM picker only)

Lien Waiver, Change Order, Notice of Right to Cancel. The badge is
`.dt-draft-badge` on the customer.html tile and `draft:true` in the Create
Document catalog; `NBDDocGen.ATTORNEY_REVIEW_TYPES` mirrors it. No rendered
document carries it (`tests/doc-template-library.test.js`).

## Findings

1. **Change order, completion certificate, scope, work authorization and
   payment agreement could not be signed in-app at all.** Two stacked bugs:
   -templates.js `Object.assign`-ed its own `{name, template}` entries over
   the core DOCUMENT_TYPES entries, dropping their `defaultSigners` (so the
   pre-flight seeded no signers and the viewer showed no "Send for
   Signature"); and its `sigBlock()` printed bare ink lines even when signers
   were set. Registration now merges (`registerTypes`) and
   `sigBlock(labels, data)` emits the `[data-nbd-sig]` pads. Proven on the
   emulator: the change order now opens with Send for Signature.
2. **The pre-flight never passed the estimate's items** to the warranty
   certificate, so every certificate it generated named GAF's warranty —
   TAMKO roofs included (per-SQ estimates' customer lines name no shingle).
   It now passes `{code, name}` only.
3. **Change order "New Total $0.00"** — the form's New Total was required
   with a literal 0 default and the renderer trusted it.
4. **For the attorney:** the client contract (the path every in-app signed
   contract takes) prints the cancellation clause but **not** the FTC Notice
   of Cancellation forms — only the server PDF attaches them. Generate the
   Right to Cancel notice with every home-signed contract until the contract
   carries them. The default `cancellationContractClause` cites "KRS
   § 367.390"; Kentucky's home solicitation sales law is KRS 367.410–.460.

## Update 2026-10-04 — finding 4 fixed (branch `feat/contract-cancel-forms`)

Every contract signed in the app now carries the Notice of Right to Cancel
with the two completed FTC forms (+ the KRS 367.624(4) 5-day forms on a
Kentucky insurance job). The workaround in finding 4 ("generate the Right to
Cancel notice with every home-signed contract") is no longer needed.

- One packet, `ky-insurance-law.js` `cancelPacketHtml` (both copies): the
  same notice, steps and forms as the library template, which now reads its
  law names and steps from there.
- Where it rides: the generated contract and signable proposal (in-person
  signing in the doc viewer; the HTML a remote link serves), the deal page
  ("Sign on this phone" / the homeowner link), and contract e-sign envelopes
  (pages appended to the signed PDF, `functions/cancel-notice-pdf.js`).
- Rebuilt on main 2026-10-05 after #2166 retired BoldSign: Send for
  signature is now an estimate envelope whose contract PDF already carries
  the two FTC forms and sets `cancelFormsIncluded`. Its title is "Roofing
  Contract — …", so `cancel-window.js` `envelopeNeedsCancelNotice` skips any
  envelope with that flag — one set of forms, never two
  (`tests/esign-gaps-2026-10-04.test.js` J + D).
- Dated the day the homeowner signs: the viewer, `getSignDocument`,
  `submitSignature`, `getDealRoom` and `submitDealAcceptance` re-date it
  (`restampCancelPacket`). The server re-renders it from the copy it served,
  never the signer's bytes. `createSignRequest` refuses a contract generated
  before the packet existed.
- `cancelBy` ("YYYY-MM-DD", 3 business days under 16 CFR 429.0) is stored on
  the document / deal / envelope and on the lead. The customer page shows
  "Cancellation window ends <date>". A move to Materials Ordered / Delivered,
  Crew Scheduled or Install inside the window warns (customer-page confirm,
  kanban toast) and never blocks.
- The "KRS § 367.390" citation is unchanged — it stays for Jo's attorney.
- Tests: `tests/contract-cancel-forms.test.js`; E2E
  `tests/e2e/contract-cancel-forms.spec.js` (390x844, in-person signing).
