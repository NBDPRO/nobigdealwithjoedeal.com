# NEEDS_JOE — decisions only Jo can make (each with a recommendation)

1. **Layers select on the line-item / job-template path does nothing (D-006, ED-F01).** Tear-off is priced by which
   code is on the estimate (TO1 / TO2 / TO3 at their own rates), so the brief's "multiply by layers" fix would
   double-charge. *Recommend:* when Layers ≠ the tear-off code on the estimate, show a one-tap "Switch to 2-layer
   tear-off?" prompt. Never change it silently.
2. **Unconfigured tenant shows NBD's full identity (ED-F12, CU-F12).** A tenant that never set a legal name gets
   NBD's name, logo and GAF #1162011 on documents. *Recommend:* treat "no legal name" as NOT NBD (blank identity +
   a "finish your Company Profile" banner), keyed on the platform-tenant check the warranty cert already uses.
3. **Portal "Send reply" fails Unauthenticated (CU-F21, ledger customer-087).** The client call looks right. The
   suspect is server auth/App Check on `replyToPortalMessage` (Tier C). *Recommend:* a server look in a daytime session.
4. **Job templates ignore markup / overhead / profit / repair minimum (ED-F05).** *Recommend:* decide whether
   templates carry their own margins (then say so in Settings) or inherit the company values.
5. **Good vs Better vs Best on line-item and job templates (ED-F10, seed #9).** Tier tabs change nothing on those
   paths. *Recommend:* differentiate on underlayment, starter/ridge and warranty term, not just the shingle.
6. **Lead Source ROI merges the Website funnels into one row (VW-F12).** *Recommend:* show the parent "Website" row
   with the funnel rows (Contact form / Inspection-Storm tool / Instant Estimate) nested under it.
7. **Stage emails promise NBD's warranty pledge, Acorn financing and the $100 referral bonus to every tenant's
   customers (VW-F151/F152).** That's legal/marketing copy, so I didn't change it. *Recommend:* gate those blocks on
   the platform tenant, with tenant-configurable versions later.
8. **"no stress, no hassle, no big deal" / "No big deal." on tenant thank-you and door-hanger paper (OR-F04).**
   *Recommend:* keep for NBD; neutral line for other tenants.
9. **Invented content in blank document templates (ED-F16):** GAF materials, sample delivery quantities and
   pre-checked completion items when fields are blank, with no preflight block for `[Placeholder]` or "INTERNAL
   NOTES". *Recommend:* blanks print as blank lines, and preflight blocks unfilled placeholders.
10. **Invoice BALANCE DUE bar orange vs navy-deep (brief).** *Recommend:* navy-deep (orange is the accent only).
11. **Multiple jobs per customer:** design note to follow in the proposals PR (additive, migration-free).
12. **Thursday / AI receptionist tie-in, lead cost backfill:** design-note items; not started tonight.
13. **"check/ACH/wire preferred" wording is nowhere in the code (ED-F26).** *Recommend:* confirm the wanted wording
    before anyone adds it to the payment panel.
14. **Ice & water eave band: 3 ft in the line-item/template engine vs 6 ft in the legacy tier estimator** (verifier
    note on the IWS PR). RFG IWS's own code text (24 in inside the exterior wall) usually needs ~6 ft with an
    overhang, so the engine may under-bill standard RFG IWS. *Recommend:* 6 ft (`eaveLf * 6 / 100`) in both, after
    you confirm the band you actually install.
15. **RFG IWS-TAMKO has no labor-code mapping** (its siblings map to LAB INST-IWS). *Recommend:* map it the same.
16. **Other quantity fall-throughs** (estdocs §3.2): gutter end caps / hangers / miters counted per foot of gutter,
    interior drywall / paint sized to the roof area. *Recommend:* explicit per-code formulas; confirm units first.
17. **Daily Program Theme (ST-F13):** Settings → Daily saves a "Program Theme" (`ds-theme`) and says it is separate from the dashboard theme, but the Daily Success page reads the dashboard theme first (`nbd_pro_theme`, deliberate since PR #557), so the picker never shows. *Recommend:* pick one: (a) the Daily picker wins when set (read `ds-theme` first), or (b) drop the picker and say Daily follows the dashboard theme.
18. **Custom Theme at startup (ST-F21):** a saved Custom Theme (Settings → Appearance → Theme Builder, `nbd_custom_theme`) is applied only when the Settings template opens, never at boot. Once applied, its inline colours override any theme picked afterwards. Nothing records whether the custom theme is the *current* choice, so "apply it at boot" would also override a later pick. *Recommend:* treat Custom as a theme choice (picking any other theme clears the inline colours and marks Custom off; Save / Apply marks it on), then apply it at boot only when it is on.
19. **Which email NBD documents print (ED-F19):** your rule is jd@ for marketing and Zelle, info@ for documents. Seven document spots print **jd@** as the letterhead/contact email:
   - estimate-finalization.js (two output formats)
   - estimate-supplement.js
   - warranty-cert.js (footer line and data)
   - photo-report.js
   - inspection-report-engine.js

   None of them is a "send Zelle to…" line. Changing them redirects customer mail, so it waits for your word. *Recommend:* info@ in all seven, leaving every Zelle line on jd@.

   **ANSWERED (Jo, 2026-11-07 ~00:00 ET):** "jd@ on anything going to me directly and info on anything general on site." The rule is now set. Still open: which of the seven spots are "to Jo directly". Next step is one PR that sorts each spot (letterhead/company contact = info@; Joe's own sign-off or personal contact line = jd@; Zelle stays jd@), shows the sort per spot, and waits for Jo's OK before merge.
20. **"Limited lifetime" in product-data.js (ED-F27):** shingle rows say "Limited lifetime" / "Limited Lifetime (single-family)". Your rule is the makers' warranty words, never "lifetime". It is warranty text, so it is not changed overnight; whether it reaches customer paper is suspected, not traced. *Recommend:* give the makers' exact warranty names per product, then swap them in one reviewed PR.
21. **"Your warranty certificate is attached" with nothing attached (VW-F153):** the Project Complete stage email (`email_system.js` `closed`) says the certificate is attached, but no attachment is ever added, for NBD too. Fixing it means rewording your customer email. *Recommend:* either attach the generated certificate, or change the line to "Your warranty certificate will follow from {companyName}." — your call on the wording.
22. **Settings that save but nothing reads (ST-F04, ST-F07, ST-F08, ST-F10).** Each looks like it works, but nothing uses the saved value:
   - **Company tab:** all 18 fields (licenses, insurance, GAF cert, EIN, territory, radius). Documents read Company Profile instead.
   - **Profile:** Company, Role and License #.
   - **Notification triggers:** Hot / Storm / Inbound / D2D, and the Email / SMS channels.
   - **Three Company Profile legal fields:** proposal validity days (the paper hard-codes "30 days"), cancellation window text and cancellation statute.

   *Recommend:* per group, either (a) wire it to its reader or (b) remove it or mark it "coming soon". The legal fields go through the attorney review first.
23. **Estimate math that changes prices (ED-F02, ED-F05, ED-F06 / ST-F03).** Each fix changes what a quote totals, so each needs your numbers first:
   - **ED-F02:** dumpster size is picked by squares after waste, not by debris volume or layers.
   - **ED-F05:** the job-template path ignores your Settings markup, overhead, profit and repair minimum, and uses the engine's 25/10/10 defaults.
   - **ED-F06 / ST-F03:** the Round-To setting applies only to per-SQ quotes. The V2 line-item builder always rounds to 25.

   *Recommend:* one MONEY PR per item, test-first. Settings are honoured everywhere they're shown; you confirm the expected totals on 2-3 sample jobs before merge.
