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
