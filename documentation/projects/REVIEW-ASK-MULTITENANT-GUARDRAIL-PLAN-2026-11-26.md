# Review ask for every company: recon and guardrail plan (2026-11-26)

**Status: PLAN ONLY. Nothing here is built.** Jo approves which pieces get built, and in what order, before any code is written. The security review and the compliance review have both run on this plan; their findings are folded in below, and §9 summarises them.

**Jo's ask, 2026-11-26:**
- "we can do multi tenant next but we need to guardrail it from abuse heavily"
- "we need to ensure no user can abuse, manipulate, extort, or lose us our verification with twilio"

**Starting point:** [PR #3288](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3288).
- Branch: `claude/crm-review-request-text-abe328`.
- What it is: review ask v2, NBD only: text first, one reminder, NBD's A2P guards.
- State: draft, dark behind `REVIEW_ASK_V2_ENABLED`.
- Its vault note `REVIEW-ASK-V2-2026-11-26.md` lands with that PR.

**Earlier build on that branch:** commit `fbd607588` was a full multi-company version. It had three ideas this plan reuses (the code is not reused):
- each company's name and link;
- the company's own From and Reply-To;
- a "job marked complete" rule.

It kept its settings in `companyProfile`, which each company can write itself (R3), and it had none of these guardrails.

Related: [REPUTATION-LOOP-2026-10-19](REPUTATION-LOOP-2026-10-19.md) (review-gating audit, `review_log`).

---

## 1. Recon: what exists today (code read 2026-11-26; corrections from the security review included)

**R1. Texting is fenced to NBD, but the fence is a single switch.**
- `functions/sms-texting-gate.js` `textingStatus` allows a company when it is NBD or when `sms_settings/{companyId}.registered === true`.
- `sms_settings` is admin-SDK only (`firestore.rules`, "SMS TEXTING MASTER SWITCH").
- **Danger:** every existing send path asks `textingStatus` for the *caller's* company and then sends with **NBD's** credentials and number. Examples:
  - `sms-functions.js` `complianceGate` (~741), then the send at ~1217-1236 using `TWILIO_ACCOUNT_SID` / `TWILIO_PHONE_NUMBER`;
  - the same pattern in `missed-call-autotext.js`, `lead-alert.js` and `storm-confirm.js`.
- **So setting `registered: true` for any other company today would put that company's rep texts on NBD's number and A2P campaign.** It must never be flipped for another company until every send path picks its sender per company (G1).

**R2. Every consent wording names NBD.**
- `functions/tcpa-consent.js` `CONSENT_TEXTS`: every wording says "No Big Deal Home Solutions".
- No company has a way to collect texting consent that names *it*.
- Consent fields (`tcpaConsent*`) are server-only on create and on update (`firestore.rules` ~247 and ~1015).

**R3. `companyProfile` is writable by each company.**
- Owner, solo owner and company_admin can write it (`cpCanWrite`). Only `docPrefix`/`seal` are frozen.
- Anything placed there (on/off, caps, sender, templates, name, Reply-To, postal address) is under the company's control.

**R4. Platform admin.**
- `isAdmin()` is `role == 'admin'`, and the functions use the same claim.
- A company cannot assign `admin` (`handlers/_shared.js` `INVITE_ALLOWED_ROLES`), so this is a sound platform boundary.

**R5. Email sender.**
- `tenant-ops-logic.js` `senderFor` builds the From name from company-writable `companyProfile.brand.displayName` / `legalName` / `businessName`.
- `safeDisplayName` strips only control and quote/bracket characters.
- Reply-To comes from company-writable `brand.contact.email`.
- `email-functions.js` (~355) falls back to the platform From when the profile read fails, which fails open to NBD's identity.

**R6. Email unsubscribe and postal address.**
- `email-suppression.js` `gateCommercialEmail` keeps a per-company register and a per-send unsubscribe token, and requires that company's own postal address (no platform default).
- The postal address is 200 characters of company-written text, HTML-escaped but otherwise unchecked.

**R7. Recipient protections.**
- `sms_opt_outs` (STOP) is global.
- `sms_dnc/{companyId}__…` gives each company its own visible copy.
- v2's `review_ask_phones/{sha256}` allows one ask per number per 180 days, server-only.
- `send-window.js` sets 8:00-20:00 recipient time, re-checked by `guardTwilio`.

**R8. Switches and caps** (`messaging-controls.js`).
- Global switches: master, per channel, canary.
- Per-automation flags and `maxPerRun`.
- `claimSendOnce`.
- All admin-SDK only and audited.
- **Nothing is per company.**

**R9. Carrier errors.**
- `messaging-center-logic.js` `CARRIER_CODES` labels 21610, 30003-30008 and 30034.
- `twilioSmsStatus` (`twilio-line.js`) is **dark by default**: it answers 200 and writes nothing unless `TWILIO_INBOUND_ENABLED` and the `twilioInbound` flag are on.
- It verifies signatures only against **NBD's** auth token, so a subaccount's callbacks would fail the check.
- The review ask's `sendTextTwilio` passes **no `statusCallback`**.
- Nothing pauses on errors.
- `resend-webhook.js` receives Resend bounce and complaint events.

**R10. Owner alerts.** `owner-notify.js` `notifyOwner` (bell, push, capped text: 4 a day, one per key per day).

**R11. "Real job": a company can manufacture every signal the trigger reads.**
- The v1/v2 trigger is paid in full, money received 3-21 days ago, excluding backfill and reversed payments, and only the last 7 days. What a company can fake:
  - **Lead provenance** (`webLead`, `publicLeadKind`, `publicLeadCollection`, `publicLeadId`, `calcomBookingId`, `backfilledBy`) is server-only **on create only**. The lead update rule does not freeze them, so a rep can stamp `webLead: true` on a hand-typed lead.
  - A company can also run its own published site form (`publishTenantSite` → lead-bridge) with anyone's number, which gives a genuine `webLead`.
  - `createdAt` is client-written.
  - Manual payments only pass a shape check, and payment entries accept extra keys (a fake `stripePaymentIntentId` on a card entry).
  - Install Done stamps and stage history are client-written.
- What a company cannot fake:
  - the payment `method: 'stripe'` (rules refuse it from a client);
  - Stripe ledger docs and server-only intent keys;
  - Cal.com provenance (HMAC-verified webhook);
  - the snapshot's server `createTime`.

**R12. A live v1 issue, not part of this plan.**
- v1's `reviewUrlFor` accepts any https link from `users/{uid}.googleReviewUrl`, which each user can write on their own doc.
- So a member of NBD's team who owns a paid lead can put any link into the live jd@ review email.
- v2 (#3288) applies the Google allowlist for its own sends.
- See §8 follow-ups.

---

## 2. Twilio route

**Recommendation: (a) one Twilio subaccount per company, under a NEW, separate parent account for the platform (ISV). NBD's current Twilio account, brand and campaign are never touched.**

Each subaccount holds that company's own:
- Secondary Customer Profile;
- Brand;
- A2P campaign;
- Messaging Service (Advanced Opt-Out on);
- number.

Twilio calls a subaccount per customer the preferred ISV architecture.

**Why a subaccount per company**
- **Isolation:** one company's filtering or suspension can't spread to another company.
- **Twilio-side kill switch:** each subaccount can be suspended and spend-capped inside Twilio.
- **Scoped credentials:** a subaccount can only send from its own number.
- **The alternative:** (b), secondary profiles inside one account, isolates none of this.

**Why a new parent account**
- The ISV parent's primary profile must be "ISV Reseller or Partner".
- Changing NBD's approved profile could reopen NBD's review.
- Twilio's docs also warn that restructuring accounts resets account-level opt-out settings.
- **Twilio must confirm this first (T1).**

**Credentials.** Subaccount credentials live in Secret Manager, or the parent's credentials are used with the subaccount AccountSid. **Never in Firestore.**

**Costs** (Twilio help-center table, Aug 2025 — check the live page):
- Brand registration, one-time, per company:
  - Standard brand with secondary vetting: about $46;
  - Low-Volume Standard or Sole Proprietor: $4.50.
- Campaign vetting: $15 per submission.
- Monthly: about $1.50 (low volume) to $10.

Who pays is Jo's call (D3).

**Email only is the default product. A company may text only when every one of these is true:**
1. Its own approved brand and campaign exist in its own subaccount, with its own number.
2. Its own consent wording names the company and review requests (see G4), on its own **public** intake form, with consent proof stored.
3. A public privacy policy (no sharing of mobile opt-in data) and terms page exist, as campaign review requires. Company microsites are private until released, so this is a real gap.
4. A platform admin records the sender in `review_ask_tenants` (§3).

**`sms_settings.registered` is not on that list.** It stays false for every non-NBD company until G1's sender work covers *every* send path (R1).

---

## 3. Data model (the platform/company split)

**`review_ask_tenants/{companyId}`: platform-controlled, admin SDK only.**
- No rule, so the existing catch-all deny covers it.
- Written only by the callable `manageReviewAskTenant`, which requires `role === 'admin'` and App Check.
- Every change is logged to `review_ask_audit` (append-only, server-only).

| Field | Meaning |
|---|---|
| `enabled` | Platform on/off. Absent means off. |
| `paused`, `pausedReason`, `pausedAtMs`, `pausedBy` | Auto or admin pause. Only a platform admin clears it. |
| `dailyCap`, `monthlyCap`, `rampStartMs`, `rampStage` | The caps in force (the ramp writes them). |
| `approved` | `{ displayName, placeId, reviewUrl, replyTo, postalAddress, approvedAtMs, approvedBy }`: the platform admin's **frozen** copy. Every send reads only this. |
| `textSender` | `{ subaccountSid, messagingServiceSid, fromE164, campaignSid, consentVersion, templateSet }`, or absent (email only). |

**`review_ask_profile/{companyId}`: the company's request.**
- Fields: `displayName`, `googleReviewUrl`, `replyTo`, plus who changed it and when.
- Written only by the callable `setReviewAskProfile`:
  - companyId comes from the caller's claim; a body companyId is ignored;
  - the allowed roles mirror `cpCanWrite` exactly (owner, solo owner, company_admin; never viewer, manager or sales_rep);
  - App Check is required;
  - at most 10 changes a day;
  - only those three keys are accepted; any other key is refused with `invalid-argument`.
- **A change never takes effect by itself.** It creates a pending request. Sends keep using the frozen `approved` copy, or stop if there is none, until a platform admin approves it.
- That closes the "swap the link, the name or the Reply-To after approval" attack on both channels.

**Server-only collections** (catch-all deny, no new allow rules):

| Collection | What it holds |
|---|---|
| `review_ask_sends/{id}` | The audit and skip-reason record for every attempt. Companies never read it. |
| `review_ask_health/{companyId}_{day}` | Counters per company per day. |
| `review_ask_counted/{sendId}_{status}` | Idempotency marks for callbacks. |
| `review_ask_phones/{companyId}_{hash}`, `review_ask_emails/{companyId}_{hash}` | The per-company 180-day window. |
| `review_ask_recipient/{hash}` | The global anti-harassment counter (G4). |

**Validation**
- **`displayName`:** 2-60 characters, letters, spaces and `&'-` only. No digits, dots or `@`, so no phone numbers, domains or URLs. It must not match the platform or NBD names after normalising homoglyphs, case and spacing (G8).
- **Review link:** checked against the Google allowlist on every send:
  - `^https://search\.google\.com/local/writereview\?placeid=[A-Za-z0-9_-]{10,200}$` (preferred in texts);
  - `^https://g\.page/r/[A-Za-z0-9_-]{6,64}/review$` (email only until Twilio answers T6).
- **The place behind the link:** the platform admin checks that it belongs to the company and stores `placeId` in `approved`.

---

## 4. The guardrails: each with its server check and its test

**Where the tests live**
- `tests/review-ask-multitenant-<date>.test.js` (node bucket, pure logic plus stub Firestore).
- A rules suite section for the R11 and G7 rules.
- Repo-wide source scans.

**The proof standard:** every check must be shown to fail with its guard removed, the same mutation proof #3288 did (13 of 13 caught).

### G1. Nothing from another company goes out on NBD's number, Messaging Service or campaign

**Server checks**
- **`resolveTextSender(companyId)`** is the only function that hands out Twilio credentials and a From number.
  - NBD (`companyId === NBD_OWNER_UID`, by key) gets NBD's secrets.
  - Another company gets its `review_ask_tenants.textSender` only if:
    - the subaccount is set;
    - `fromE164` is not NBD's number;
    - `consentVersion` is one of **that company's** consent wordings.
  - Anything else returns `null`, which means email only.
- **Every Twilio send path in `functions/` gets its sender from `resolveTextSender`, or is behind an `isNbd`-by-key check.** That includes `sendSMS`, missed-call autotext, lead alert and storm-confirm, not only the review ask. This closes R1's danger.
- **Just before each send:**
  - the lead's company must equal the run's company;
  - the client's AccountSid must equal that company's subaccount;
  - any mismatch throws `sender_tenant_mismatch`.
- **No shared client:** the sweep runs one company at a time with that company's own client; no client object is shared between companies.

**Tests**
- A non-NBD lead with no `textSender` → email path, and the Twilio stub is called 0 times.
- A `textSender.fromE164` equal to NBD's number → refused.
- Company A's lead with company B's sender → `sender_tenant_mismatch`.
- An NBD-named consent version on a non-NBD lead → no text.
- **With `sms_settings/co-X.registered = true`:** `sendSMS` from a co-X rep, missed-call autotext and lead-alert for co-X are all refused, with 0 stub calls.
- **Source scan:** every `messages.create(` in `functions/**` is reached through `resolveTextSender` or behind an `isNbd` key check. It is proven to fail by planting a violation.

### G2. Text content matches the campaign

**Server checks**
- **Fixed template sets in code.** Each set has an ask, a reminder and a HELP reply.
- **The only variables are:**
  - the first name (letters only, at most 40 characters);
  - the approved `displayName`;
  - the approved review URL.
- **There is no company free text anywhere,** and no promotional wording: no offers, prices, services, referral asks or second link. That keeps the ask informational, which limits how far a STOP reaches under FCC 26-67.
- **`smsContentOk(body, url, displayName)` runs right before every send.** It requires:
  - exactly one URL, and that URL on the allowlist;
  - no shortener domain, even written as plain text;
  - the company's name in the body (carriers require the brand to be identified);
  - the body ends with `Reply STOP to opt out.`;
  - at most 320 characters.
- **Each company is sent only the template set its campaign was approved with.** The set's text must equal the campaign's sample messages.

**Tests**
- A name or link that carries a URL, domain, phone number or shortener → rejected at save; planted directly in Firestore → rejected again at send.
- A missing STOP line, another company's name, or more than 320 characters → no send.
- Golden-string test: each template set matches its registered samples exactly.
- Source scan: promotional words are absent from every template.

### G3. Carrier health: tracked per company, auto-pause, Jo alerted

**Status callbacks**
- Every text carries a `statusCallback` to a per-send opaque id.
- The handler finds the send in `review_ask_sends` first, which gives it the company and the subaccount.
- **Then** it verifies the Twilio signature with **that subaccount's** token. Nothing is written before verification.
- Inbound STOP and HELP on subaccount numbers are verified the same way.

**Health is required to send**
- The company's text pre-flight refuses when the status handler is dark, or when recent sends have no final callback (a callback heartbeat).
- This closes R9's fail-open.

**Counters**
- Codes counted per company per day: 30007, 30003, 30005, 30006, 21610, 30034, STOP replies, and Resend complaints and bounces.
- Each (send, final status) and each Resend event id is counted **once**, in a transaction. Twilio and Svix retry, and double counts would cause false pauses.

**Thresholds.** These are proposals; Jo sets them (D2).
- **Per company, rolling 7 days, once it has at least 20 sends:**
  - 30007 ≥ 2, or above 1%;
  - opt-outs above 3%;
  - unreachable above 10%;
  - any 30034;
  - email: 1 complaint (a deliberate, conservative choice: one homeowner can trip it), or bounces above 5%.
- **Absolute triggers that ignore the 20-send floor:**
  - ≥ 2 STOPs;
  - ≥ 3 unreachable;
  - any 30007.
- **A pause** sets `review_ask_tenants.paused`, writes an audit row, resets the ramp, and calls `notifyOwner({ severity: 'alert', key: 'review_ask_pause_' + companyId })`.
  - The alert body never contains a company-written name.
  - It uses its own alert bucket, so pauses cannot use up Jo's 4-a-day alert texts.
  - Only a platform admin clears a pause.
- **A global pause** (every non-NBD text sender) fires automatically **only** on account-level signals:
  - 30034;
  - a Twilio suspension notice.
- **Rate signals need 2 or more different companies plus a platform volume floor.** Even then the default is an alert to Jo, not an automatic pause. This prevents one company from tripping it on purpose with its own burner numbers to shut down everyone else (security H4).
- **NBD's own sends are judged separately.** No other company's numbers can pause NBD.

**Tests**
- 30007 ×2 for company A → A paused; B and NBD untouched; `notifyOwner` called once.
- A callback that claims another company → company taken from the stored row.
- A bad signature, or NBD's token on a subaccount send → 403, no counter change.
- The same callback twice, or the same Svix id twice → counted once.
- The handler dark, or callbacks missing → the pre-flight refuses.
- One company with 5 STOPs → only that company paused; the global flag untouched.
- A company's own callable cannot clear `paused`.

### G4. Protect the recipient

**Per-company window**
- **One ask plus one reminder per phone and per email, per company, in 180 days.**
- Keys: `review_ask_phones/{companyId}_{hash}` and `review_ask_emails/{companyId}_{hash}`.
- **Why per company:** a global window would let company A use up company B's customers' asks and learn who they are.

**Global anti-harassment cap**
- At most asks from 2 different companies per recipient per 30 days, in `review_ask_recipient/{hash}`.
- Its reason is **never shown to a company**: the company sees a generic "not sent", and the reason stays in server-only `review_ask_sends`.
- Every company-side check (approved profile, Reply-To, postal address, caps) runs **before** any recipient claim.
- A claim is released when nothing was provably sent.

**Quiet hours**
- 10:00-20:00 in the recipient's local time, for every company. One rule, and it covers Kentucky's reported 10 a.m. start for solicitations (to confirm: C10).
- The time zone comes from the job address, then the area code; when the two conflict, skip the send.
- Checked before the claim, and again inside `guardTwilio`.

**STOP and HELP**
- The global `sms_opt_outs` is checked before every text, whichever company sends it.
- A STOP received on **any** company's number is written to it, by the inbound handler on each subaccount.
- All seven FCC 26-67 words are configured on every Messaging Service and read back at setup: stop, quit, end, revoke, opt out, cancel, unsubscribe.
- The confirmation goes within 5 minutes, names the company, and says nothing else.
- A plain-language "please stop texting me" is also written to the register (the cautious path, until counsel answers C3).
- HELP replies with the company's name, phone and email from the template set.

**Email**
- A company's unsubscribe stays per company (CAN-SPAM is per sender). The per-company and global windows still apply.

**Not voice:** no review ask ever goes by voice or AI voice.

**Tests**
- Company A asks a number; company B asks it 30 days later → B is allowed. A third company within 30 days → refused.
- Nothing readable by company A reveals `recipient_recently_asked` (rules test on its leads and `review_requests`).
- A refusal before the send leaves no recipient claim.
- A STOP stored from company A's number → company B's text refused.
- 09:30 recipient time → no claim and no send.
- Two parallel sweeps → only one claim wins.
- Setup read-back: a Messaging Service without "revoke" / "opt out" → that company's text is refused.

### G5. No gating, no incentives, no hand triggers; the "real job" rule stated honestly

**Same words to everyone**
- No rating step, no "only if happy" branch, nothing offered. A source scan checks the template sets.

**Companies cannot trigger or steer it**
- There is no callable or UI that starts an ask for a non-NBD company.
- The trigger runs only inside the scheduled sweep.
- The window, the delay and the channel order are constants in code.
- A company's settings screen shows only: request on/off, name, link and Reply-To.

**What "real job" can honestly mean**
- R11 shows that a company can create most of the signals itself. **The provenance rules raise the cost of abuse; they do not stop it.** The real limits are:
  - the per-company caps and ramp (G6);
  - the health pause (G3);
  - the global recipient cap (G4);
  - the company terms of service.
- Rules every ask still requires for a non-NBD company, each re-read on the server:
  - **Prerequisite rules fix:** the lead update rule freezes `webLead`, `publicLeadKind`, `publicLeadCollection`, `publicLeadId`, `calcomBookingId` and `backfilledBy` with `didNotChange`. Add rules tests for updates: company_admin, manager and sales_rep each denied, with a positive control. Check the rules size and the expression budget first.
  - **Lead age:** the lead's server `createTime`, never `createdAt`, is at least 3 days before the qualifying payment.
  - **The payment:** a Stripe payment proven from server-only keys (the Stripe ledger, or server-only `paidIntentIds`), never from fields on a payment entry. **Or** a manual payment at or above a platform minimum (proposed $500; Jo decides, D2), and then **email only**.
  - **Text** requires that company's own server-captured consent from its own form, **plus** a Stripe-proven payment.
  - The job marked complete (`fbd607588`'s idea).
  - Not a payment backfill, not a quiet backfill, not a reversed payment.

**Exclusions and selective-solicitation risk (for counsel, C6)**
- Skipping a customer with an open dispute, complaint, warranty claim or balance owed may count as **selectively asking happier customers**: FTC 16 CFR 255.2(e) Example 11, and Google's "selectively solicit" ban.
- **Proposal:** keep "balance owed" (the job isn't finished), and hold the dispute, complaint and warranty exclusions until counsel answers.
- **Every exclusion is company-written** (lost, archived, do not contact, warranty stage). So the exclusion rate is tracked per company in `review_ask_health`, and Jo is alerted when it is high. The terms forbid filtering by sentiment.

**Tests**
- A hand-typed lead with `webLead` set by update → the rules deny the write.
- A lead created 1 day before payment (by `createTime`) with a backdated `createdAt` → not asked.
- A fake `stripePaymentIntentId` on a card entry → not counted as Stripe.
- A $1 cash payment → not asked.
- A manual-payment lead → never texted.
- A CSV-imported lead → not asked.
- Balance reopened before the reminder → reminder closes `not_paid`.
- Any review-ask callable called with a `leadId` → no such entry point (source scan).

### G6. Per-company caps, ramp, kill switches and audit

**Caps**
- `dailyCap` and `monthlyCap` per company, claimed in the same transaction as the recipient claim.
- **Ramp** (proposal, D2):
  - week 1: 5 a day / 50 a month;
  - week 2: 10 / 150;
  - after 4 clean weeks: 25 / 400.
- A step goes up only when the last 7 days are under every G3 threshold. A pause resets the ramp to stage 1.

**Kill switches**
- Per company: `enabled` and `paused`.
- Per channel: the `reviewAskTenantText` and `reviewAskTenantEmail` automation flags.
- Global: `messaging_controls/global` and the canary.
- A new env flag, `REVIEW_ASK_TENANTS_ENABLED`, leaves NBD's v2 path untouched.
- **Everything fails closed:** a missing or unreadable doc means do not send.

**Audit**
- The audit trail is **only** server-only `review_ask_sends`. Each send records `triggeredBy: 'system:reviewAskAutoSweep'`, the companyId, the template set, the channel, the sender SID, the hashed recipient and the outcome.
- Admin changes go to `review_ask_audit`.
- `review_requests` is company-writable, so it is a display row only, never evidence.

**Tests**
- A 6th send under a daily cap of 5 → `tenant_daily_cap`.
- Monthly cap reached → no send.
- `enabled` absent → off.
- Tenant doc unreadable → off.
- Every send row carries `triggeredBy` and companyId.
- A pause resets the ramp.
- A rules test: a company writing `review_ask_sends` → denied.

### G7. No company can change its own caps, switches, sender, templates or another company's data

**Server checks**
- **No new allow rules** for `review_ask_tenants`, `_health`, `_sends`, `_counted`, `_phones`, `_emails`, `_recipient` or `_audit`: the catch-all deny covers all of them.
- `review_ask_profile`: at most `allow get` for members of the same company.
- **`manageReviewAskTenant`** requires `role === 'admin'`; a company_admin is refused.
- **`setReviewAskProfile`:**
  - companyId comes from the claim only;
  - roles exactly as `cpCanWrite`;
  - App Check required;
  - rate-limited;
  - only `{ displayName, googleReviewUrl, replyTo }` accepted;
  - a change takes effect only after platform approval (§3).
- **The send path re-validates the approved values every time.**

**Tests**
- Rules suite:
  - a company_admin writing its own `review_ask_tenants` doc → denied;
  - writing another company's `review_ask_profile` → denied;
  - reading another company's profile → denied.
- Callable tests:
  - a body companyId that names another company → ignored;
  - an extra key such as `dailyCap` → `invalid-argument`;
  - a viewer, a manager or a sales_rep → denied;
  - a company_admin calling `manageReviewAskTenant` → denied;
  - a profile change → nothing sent with the new values until approval, and an audit row written.

### G8. Email from another company

**Server checks**
- **Suppression gate:** `gateCommercialEmail` runs with **that company's** companyId, so its unsubscribe register and its unsubscribe token apply. The unsubscribe link works for at least 30 days.
- **Postal address:** the footer uses the platform admin's **approved** copy. Its shape is checked: no `http`, no `@`, no bare domain.
- **From display name:** only the approved `displayName`, never `senderFor`'s `companyProfile` fields. The address is a platform sending address (D4).
- **Reply-To:** only the approved `replyTo`. It cannot be on a platform or NBD domain.
- **If the profile, the approved copy or the gate cannot be read, the email is not sent.** There is never a fallback to the platform From.
- **No platform branding** in a company's email ("Powered by …" or a platform link). That keeps the platform from becoming a second "sender" under the 16 CFR 316.2 sender definition.
- **No NBD content:** NBD's signature, photo pipeline and wording are never used for another company.
- **Ad identification:** decided by counsel (C5).
- **Complaints and bounces:** Resend's complaint and bounce events feed G3.

**Tests**
- No approved postal address → not sent.
- A suppressed address → not sent.
- A failed profile read → not sent.
- The From name equals the approved name. Names like "N0 Big Deal", homoglyphs or "Google Reviews" are rejected when saved.
- Reply-To at `@nobigdealwithjoedeal.com` → refused.
- The footer carries the company's address and unsubscribe link.
- No platform link or branding in the body.

---

## 5. Build order (proposed; Jo picks)

| Slice | What | Risk to NBD's Twilio verification |
|---|---|---|
| **S0** | **Fixes worth doing now, whatever else is chosen:** freeze lead provenance on update (R11), and the `isNbd` / `resolveTextSender` guard on every existing Twilio send path (R1, G1). Both have their own tests. | Lowers risk |
| S1 | Data model, the two callables, the approval flow, the rules suite (G7). All dark. | None (sends nothing) |
| S2 | **Email only** for other companies (G4 email windows, G5, G6, G8), behind `REVIEW_ASK_TENANTS_ENABLED` | None (no texts) |
| S3 | Health pipeline: per-subaccount callbacks, idempotent counters, auto-pause, alerts (G3). It can serve NBD's v2 texts first. | None; lowers risk |
| S4 | Twilio ISV setup for one pilot company: new parent account, subaccount, brand, campaign, consent form and policy pages. Jo and Twilio support, by hand. | None, if T1 confirms |
| S5 | Texting for the pilot company only (G1, G2, G4 SMS), ramp stage 1 | Contained by the subaccount |

---

## 6. Questions for counsel (reference, not legal advice; refined by the compliance review)

**C1. Is a review ask marketing?**
- Is an automated review request with no promotional wording an "advertisement" or "telemarketing" under 47 USC 227 and 47 CFR 64.1200(f)?
- Under 64.1200(a)(10) as amended by FCC 26-67, may a STOP to it be treated as covering only review asks?
- The effective date is Federal Register publication + 30 days. Secondary sources say 2026-11-25; the Federal Register itself was not opened. Check https://www.federalregister.gov/d/2026-21821.

**C2. What consent is needed for texts?**
- Is prior express consent enough, or must the company terms require written consent (Twilio's policy for software platforms does)?
- Does a scheduled platform send raise an autodialer question?

**C3. Opt-out method.**
- May reply-text be the *only* opt-out method under (a)(10)?
- Must plain-language and email opt-outs still be honored?

**C4. Consent wording and templates.**
- Does a company's consent ("texts about your project, including a request to review our work") cover a text the platform sends for it?
- Please approve model consent wording, the HELP and STOP replies, and the template sets.

**C5. CAN-SPAM.**
- Is the review-request email commercial (7702(2), 316.3) or transactional (7702(17))?
- Is an ad-identification line needed?
- Is the platform an "initiator" (7702(9))?
- Does the company's name on a platform sending address meet the From-line rules?

**C6. Selective asking.**
- Under 16 CFR 255.2(d)/(e) Example 11 and Google's "selectively solicit" ban, may we skip open disputes, complaints, warranty claims or balances owed?
- This applies to NBD in #3288 too.

**C7. Platform liability.**
- Under the TCPA, CAN-SPAM and 16 CFR 465: the FTC says middlemen "are not immune".
- What must the company terms and the platform's own TCPA and privacy policy say? Is an indemnity or insurance needed?
- Does the company terms' ban on filtering by sentiment and on fake or staff reviews need more than that?

**C8. Shared recipient list.**
- Is the hashed cross-company recipient cap (G4) permitted?
- Does it need disclosure in the privacy policy or company terms?

**C9. Record keeping.** How long to keep consent proof, STOP and DNC records (5 years if 64.1200(d) applies) and send logs?

**C10. Kentucky and Ohio.**
- Does KRS 367.46955 (a reported 10 a.m.-9 p.m. window) apply to texts, or to messages that are not sales?
- Is a review ask outside Ohio R.C. 4719.01(A)(7)?
- Are there any newer state texting laws?

**L5.** Leads from a company's own site may store NBD-named consent wording. What should the stored record say?

## 7. Questions for Twilio support

- **T1.** Can a new, separate account be the ISV parent ("ISV Reseller or Partner") while NBD's existing account, brand and campaign stay exactly as they are? Does anything link them?
- **T2.** Which use case fits a one-time review request after a completed job: CUSTOMER_CARE, ACCOUNT_NOTIFICATION, MIXED or LOW_VOLUME? What sample messages and message flow would be approved?
- **T3.** On each subaccount's Messaging Service, does Advanced Opt-Out:
  - accept all seven FCC 26-67 words;
  - send STOP and HELP to our webhook;
  - allow a company-specific confirmation?
- **T4.** Sole Proprietor brands (contractors with no EIN): what are the limits, and can they be registered through the API?
- **T5.** Recommended thresholds for an ISV to suspend a subaccount itself.
- **T6.** Do carriers or campaign review treat `g.page/r/...` as a public shortener? Is `search.google.com/local/writereview?placeid=` preferred?
- **T7.** What must a company's privacy policy and terms pages say? Is a platform-hosted policy page acceptable?
- **T8.** Does a shared STOP register across subaccounts conflict with any rule on sharing mobile opt-in data? What consent proof does Twilio expect from an ISV?
- **T9.** Can a filtered or suspended subaccount affect the ISV parent, or NBD's separate account?

## 8. Decisions only Jo can make, and follow-ups

- **D1.** The build order (§5). Whether S0 goes first, now. Whether S3 lands before #3288's NBD texts turn on.
- **D2.** The pause thresholds (G3), the caps and ramp (G6), and the manual-payment minimum (G5).
- **D3.** Who pays a company's Twilio brand, campaign and number fees.
- **D4.** The platform sending address and domain for company email.
- **D5.** Text for other companies at all, or email only as the product.

**Follow-ups found during recon (not in this plan's scope):**
- **R12:** v1's live jd@ email accepts any https link from a user-writable `users/{uid}.googleReviewUrl`. Fix: the Google allowlist in v1, or freeze the field.
- **R11:** lead provenance is not frozen on update. That is S0; other readers of these fields (lead-alert) are also affected.
- **Platform email reputation:** the existing `sendEmail` already lets companies send free-text email from the platform address. The review-ask guardrails don't limit that; it needs its own review.

---

## 9. Reviews run on this plan (2026-11-26)

**`nbd-security-reviewer`** (read-only). It found 1 Critical, 5 High, 7 Medium and 5 Low. All are folded in above:
- **C1:** `registered: true` opens every existing send path on NBD's number → R1, G1, S0.
- **H1:** provenance is not frozen on update → R11, G5, S0.
- **H2:** a company can manufacture every "real job" signal → G5 restated.
- **H3:** a global window is a lever against rival companies and an information oracle → G4 per company plus a hidden global cap.
- **H4:** one company could trip the global pause → G3, which needs 2+ companies and alerts Jo.
- **H5:** status callbacks are dark and NBD-token only → G3 heartbeat and per-subaccount signatures.
- **Medium:** M1 (swaps after approval) and M2 (address text) → §3 approval and G8; M3 (gating by omission) → G5 and C6; M4 (forgeable `review_requests`) → G6; M5 (double counts) → G3; M6 (the floor) → G3 absolute triggers; M7 → R12.
- **Low:** L1-L5 → §3 roles, the alert bucket, the deliberate one-complaint choice, name validation, C-L5.
- **Not checked by it:** the v2 branch files (it had no shell), so v2-specific claims rest on this note's recon.

**`nbd-compliance-reference`** (read-only, primary sources cited, not legal advice). Folded into G2, G4, G5, G8, §2, §6 and §7:
- FCC 26-67's opt-out rules: the seven words, the 5-minute confirmation, a STOP's reach by message type;
- 10:00 start for Kentucky;
- no promotional wording;
- the long Google link in texts;
- HELP;
- consent proof and record keeping;
- privacy and terms pages;
- no platform branding (the 316.2 sender definition);
- the selective-solicitation risk of exclusions;
- written consent under Twilio's platform rule.

Its "could not verify" list, to check by hand:
- the Federal Register / eCFR text of 26-67;
- the CTIA Messaging Principles;
- Twilio support articles 11847054539547 and 1260801844470;
- KRS 367.46955.
