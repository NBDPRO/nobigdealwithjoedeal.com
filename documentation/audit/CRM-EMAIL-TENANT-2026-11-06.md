# Stage emails stop carrying NBD's offer to other companies' homeowners — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06 (harness and findings index:
[CRM-AUDIT-HARNESS-2026-11-06](CRM-AUDIT-HARNESS-2026-11-06.md)).
Test: `tests/email-tenant-2026-11-06.test.js`. It loads the real `email_system.js`, builds real
stage emails, and passes 7/7 on this branch. Against main's code, 3 checks fail.

`email_system.js` `buildStageEmail` fills the stage templates. Three sentences in them are NBD's own offer, and they went to every company's homeowners:

| ID | Stage email | NBD-only sentence | What another company now gets |
|---|---|---|---|
| VW-F151 | `estimate_sent_cash` | "…a written labor warranty of up to 20 years depending on the package, and the NBD Pledge… We offer Standard, Preferred, and Elite options…" | "This includes all materials and labor. Your estimate lists the warranty and package options." |
| VW-F152 | `prequal_sent` | "Multiple lenders compete… through the Acorn Finance marketplace…" | "You'll see the rates and terms you qualify for. Rates and terms vary by credit." |
| VW-F152 | `closed` | "…We offer a $100 referral bonus for every referred job, once it is paid in full." | The referral ask without NBD's $100 bonus. |

**NBD's emails are unchanged.** The swap runs only when the active brand is not NBD, after placeholders are filled, on whole sentences. The templates themselves are untouched, so `referral-paid-in-full-2026-10-16` still passes.

Not changed: **VW-F153.** The `closed` email says "Your warranty certificate is attached", but nothing is attached, for NBD too. Fixing it means rewording NBD's customer email, so it is in NEEDS_JOE.
