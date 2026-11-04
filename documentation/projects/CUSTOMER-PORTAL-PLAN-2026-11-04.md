# Customer portal plan — 2026-11-04

**Status:** plan, decisions settled with Jo the same day through a "grill me"
interview (every decision below was put to him as a multiple-choice question
and answered). Nothing is built yet. Each phase ships on its own, behind a
flag where it touches a homeowner.

**Inputs:** a recon of the existing portal (all of `docs/pro/portal.html`,
`docs/pro/js/portal.js`, `functions/portal*.js`, the deal room, e-sign) and two
open-source research lanes (UX patterns; technical building blocks), each
vetted below against the code. Starting point: the GitHub repo sweep
(`documentation/audit/GITHUB-REPO-SWEEP-2026-11-04.md`, PR #2832).

## 1. Decisions (Jo, 2026-11-04 — do not relitigate)

| Question | Decision |
|---|---|
| Main job | **Status first**, then sign + pay. Reviews, referrals and the Care Plan belong on the done-job screen. |
| Who | **Every NBD Pro tenant's homeowners**, branded per company (already supported), NBD first. |
| Scope | **The whole journey, start to finish**: booking → report → estimate → signed → scheduled → install day → paid → warranty → years of care. |
| Insurance jobs | **Neutral steps + the homeowner's own documents only.** Never claim status, never "we handle your claim". Every line passes the KY claim-wording gate. |
| Budget | **No new paid services.** Free/open-source + Firebase, Stripe, Resend, Cal.com. |
| Portal link timing | **Emailed at booking** (email only while texting is off). |
| Report visibility | Inspection report + photos appear **only after Jo taps "Share with homeowner"** (same rule photos use today). |
| Payments | **Inside the portal** (Stripe's embedded form), same KY/OH hold rules. |
| Job-day updates | **Auto from CRM data + Jo's optional one-line note.** Nothing is sent without him. |
| Rescheduling | Inspections/appointments: **self-serve in the portal via Cal.com.** Install days: a **"request a change"** message only. |
| Crew shown | **Crew company + arrival window** ("Rivera Roofing (independent crew), 7–8 am"). No crew names, phones or photos. |
| Care Plan | **Build the surface; test mode first** (Jo makes one real $19 purchase), **live only after the LegalShield attorney OKs** scope, limits and the no-refund wording. |
| Emails | **Key moments only** (booked, estimate ready, scheduled, day before, done, document ready), unsubscribe, **built dark** behind a flag. |
| Look | **Refresh the layout, keep the brand**: one phone-first "your project" home: timeline on top, the single next action as a big button, the rest below. |
| Phone app | **Add-to-home-screen** (manifest + minimal service worker). |
| Language | **English only**, written so it can be translated later. |
| Measuring | **First-party anonymous counts in Firestore only.** No Clarity or third-party analytics on the portal. |

## 2. What already exists (recon, `origin/main`)

The portal is mature, so this is an upgrade, not a rebuild:
- **Access:** magic link (24-char token, 30-day default / 90 max, revocable, use-capped); one server check for all seven homeowner endpoints; per-tenant branding with a contrast loop.
- **Shown today:** a 9-step tracker (`functions/homeowner-progress.js:45-53`), estimate + signed-contract download, e-sign, a documents shelf (sandboxed viewer), payments via Stripe **links** (KY hold / OH timing respected), Cal.com booking card, shared photos + before/after, photo upload, message thread + callback request, rep card, rating + Google review, warranty card + claim, referral, live-updates banner.

**Gaps the plan closes:**
1. Nothing exists before a lead/portal: after booking on `/inspect` the homeowner sees nothing.
2. During the job there is only tracker text + photos: no "today" view.
3. Payment leaves the page (hosted Stripe), and rescheduling is a Cal.com email.
4. The Care Plan has no portal surface, and its checkout is `off`.
5. Copy bug: after signing, the booking card still says "Book your inspection" (`portal.js:1202-1205`).
6. Re-check: the 2026-10-07 money-path audit items H2–H4 (KY invoice "Balance due" while held; "Licensed & insured" on deal rooms; repair card's 10-year warranty claim). Confirm they are fixed before touching those screens.

## 3. Build plan (ranked; each phase ships alone)

### Phase 1 — "Your project" home (status first) · M
- **One task list at the top** (GOV.UK task-list pattern): done / current / "Cannot start yet" with a one-line *neutral* reason. Keep **all 9 steps fixed**, and mark ones a job skips as "Not needed" (USWDS: a step indicator must not change length).
- **Accessible steps:** hidden "completed / current" text, `aria-current="step"`, "Step X of 9" next to the heading. Test VoiceOver on an iPhone (USWDS has a Safari list bug).
- **One big next-action button** that always matches the current step (Odoo's "Sign & Pay", Invoice Ninja's approve → pay).
- **One notification banner, above the heading,** for today's change only. Never more than one; the task list must change too.
- **Done-job section** in this order: review ask → referral → Care Plan (with the price shown) → warranty card (saves as PDF).
- Fix the "Book your inspection" copy bug; re-check H2–H4.
- **Measure:** first-party counts (opens, step viewed, next-action tapped) through one Cloud Function. Allowlisted event names only, no PII, rate-limited per session, `FieldValue.increment` on `counters/{tenant}/{day}/{event}`.

### Phase 2 — Install day: "Today" card · M
- Arrival window, **crew company only**, the live stage, a rain-delay flag (weather.gov hourly forecast behind a caching Cloud Function, since browsers can't set the required User-Agent), the latest shared photo, and Jo's optional one-line note.
- "Request a change" for install days is a message, not self-serve. **Turn off Cal.com self-serve cancel/reschedule once the install is scheduled.**
- Reply-time line next to the message box ("Joe usually replies within a few hours"), set per tenant (Chatwoot pattern).

### Phase 3 — Pay inside the portal · M
- **Stripe embedded Checkout** (`ui_mode: 'embedded_page'`, `createEmbeddedCheckoutPage`): closest to today's hosted links, with line items, receipts, ACH and wallets from the Dashboard. The portal CSP already allows `js.stripe.com` (script + frame) and `api.stripe.com`; add `*.js.stripe.com` and `hooks.stripe.com` (3DS). **Test whether `checkout.stripe.com` is also needed.**
- Load Stripe.js from js.stripe.com (it can't be vendored). Pin the named version (`endive`).
- **ACH sits in `processing` for days:** show "Payment pending", never "Paid", until the webhook settles. This matches "revenue = collected only".
- Apple Pay / Google Pay: register `nobigdealwithjoedeal.com` (and each tenant domain) via `payment_method_domains`.
- Same KY hold / OH timing gate as today; the button only appears when the server says money is due.

### Phase 4 — Booking → report (before the estimate) · M
- **Booking email carries the portal link** (Cal.com webhook → create the portal token at booking). The pre-visit page shows What / When / Where, "Need to make a change?", Reschedule and Add to calendar.
- **Reschedule/cancel in the portal** from the booking webhook (`uid`, `bookerUrl`): `…/reschedule/{uid}` and `…/booking/{uid}?cancel=true`. **Embed with a plain `<iframe>`, not Cal.com's `embed.js`:** the loader injects `<style>` through `innerHTML` and inline `style=`, which breaks under the planned strict `style-src`.
- **"What happens next" panel** after every finished step (GOV.UK confirmation pattern; no buttons inside the green panel).
- **Report:** appears only after "Share with homeowner"; insurance jobs see neutral wording only.

### Phase 5 — Emails at key moments (dark) · S–M
- **MJML** (or Maizzle) templates rendered in Node, sent by Resend. No React.
- `List-Unsubscribe` + `List-Unsubscribe-Post: One-Click` headers (RFC 8058) on every portal email, with a POST endpoint that stops sends within 48 h.
- Dark-mode meta + transparent logos. Email only; no texts while texting is off.
- Ships behind a flag Jo flips.

### Phase 6 — Care Plan surface · M
- After the job, on the done-job screen: the plan offer ($199/yr or $19/mo shown), then yearly check-ins as an expandable numbered list (GOV.UK step-by-step).
- **Order: build → `CARE_PLAN_MODE=test` (Jo buys one real $19 plan) → attorney review of scope, limits and no-refund wording → `live`.**

### Phase 7 — Add-to-home-screen + polish · M
- One static manifest (`start_url`/`scope` `/portal/`) with **no token in `start_url`** (MDN: per-user ids there are a fingerprint).
- On first visit, swap the token for a session, then `history.replaceState` to strip `?token=`.
- **iOS home-screen apps have separate storage:** the installed icon needs a "re-open from your email link" path.
- Service worker caches the static shell only, network-only for private data, never a `?token=` URL.
- Offer install after a finished step, never on first load or mid-sign/pay. iOS needs a manual "Share → Add to Home Screen" hint.
- UI pieces (CSP-safe, no framework):
  - native `<dialog>` or a11y-dialog 8.1.5
  - PhotoSwipe v5 for photos (CSSOM styles only; **not GLightbox**, which injects `<style>`)
  - img-comparison-slider 8.0.7 (`adoptedStyleSheets`; test under strict style-src)
  - a hand-rolled `role="status"` live region

## 4. Anti-patterns to avoid
1. Steps that change length per job (use "Not needed").
2. More than one banner, or banners carrying the main status.
3. One link that opens everything: scope each link to one job, check it on the server, expire it. (Vikunja's view-only links exposed all views; CVE-2026-33680.)
4. Install or upsell prompts on load or mid-sign/pay.
5. Self-serve cancel/reschedule staying on after the install is committed.

## 5. Open (needs Jo, or checks before the phase starts)
- Re-check money-path audit H2–H4 (Phase 1).
- Stripe: test `checkout.stripe.com` in frame-src; register wallet domains per tenant (Phase 3).
- Care Plan attorney review (Phase 6, already on the LegalShield list).
- Per-tenant reply-time wording (Phase 2).
