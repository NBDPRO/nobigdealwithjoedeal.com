# Manual items for Jo — SEO/Tech Hardening 2026-07

Everything here either needs console/DNS access this session didn't have, or a
brand decision that isn't mine to make. Each item is self-contained.

---

## 1. ~~DECISION NEEDED~~ DECIDED 2026-07-02 — remaining white-on-orange CTAs (F4)

> **Jo's decision (option "C", recorded here):** darken only the genuinely-tiny
> badge/pill/ribbon elements; primary CTA buttons keep brand orange `#E8720C`.
> Implemented in `scripts/fix-tiny-badge-contrast.js` (8 elements across 4
> pages: `.about-badge`, `.wc-ribbon`, `.sc-badge`, `.nbd-tier-pill.featured`,
> the "MOST CHOSEN" inline span, `.tc-pill`, `.progress-dot.active`,
> `.filter-btn.active`). Re-audit confirms 0 tiny badges remain on `#E8720C`;
> the 137 remaining hits below the table are all deliberately-kept primary
> CTAs (`.btn-primary`, `.nav-cta`, step numbers, CTA-panel links). Scanners
> will keep flagging those — that is the accepted tradeoff. The table below is
> kept for the record.

The announcement bar is fixed on this branch (now `#B85400`, passes AA). But
the headless-Chrome audit found ~35 more element patterns rendering white text
on brand orange `#E8720C` at small sizes — 3.06:1, which fails WCAG AA for
normal-size text (needs 4.5:1; only ≥24px regular or ≥18.66px bold text may be
3:1). I did **not** change these: recoloring every primary CTA site-wide is a
de-facto brand-palette change (locked per the ground rules), and growing them
all to 18.66px+ bold is a redesign.

Full enumeration (17 representative templates × desktop+mobile; a hit count of
2 usually means "one element, seen in both viewports"):

| Element/class | Hits (17-page sample) | Computed sizes | Weights | Example text | Already passes AA-large? |
|---|---|---|---|---|---|
| `btn-primary` | 46 | 13.6px, 14.72px, 14.08px, 15.2px, 14.4px, 16px, 13.12px | 700, 800 | "Call Joe — (859) 420-7382" | no |
| `nav-cta` | 15 | 11.2px, 12.48px, 12.8px | 700 | "Free Estimate →" | no |
| `a` (misc inline CTAs) | 12 | 13.12px, 17.6px, 14.08px, 14.4px | 800, 700 | "Explore the TAMKO Storm Series →" | no |
| `div` (step chips) | 8 | 13.6px | 800 | "1" | no |
| `h2` (hero display text) | 6 | 64px, 57.6px, 25.6px | 700 | "Call Joe. I'll Take Care of It." | **YES — no action needed** |
| `p` (orange CTA panels) | 6 | 16.8px, 15.2px | 500 | "I'll come out, take a real look…" | no |
| `q-num` | 6 | 14.4px | 800 | "1" | no |
| `phone` | 4 | 17.6px | 700 | "Or send a message:" | no |
| `wc-ribbon` | 2 | 10.56px | 800 | "The NBD Guarantee" | no |
| `span` ("MOST CHOSEN" badge) | 2 | 9.6px | 800 | "MOST CHOSEN" | no |
| `nbd-tier-pill` | 2 | 11.52px | 700 | "Preferred · Most Chosen" | no |
| `sc-badge` | 2 | 10.4px | 800 | "Most Requested" | no |
| `big-num` | 2 | 40px | 400 | "5★" | **YES — no action needed** |
| `small` | 2 | 10.4px | 700 | "Google Rated" | no |
| `form-submit` | 2 | 14.4px | 800 | "Get My Free Estimate →" | no |
| `hs-btn` | 2 | 14.08px | 800 | "Get My Free Estimate →" | no |
| `filter-btn.active` | 2 | 12.48px | 700 | "All Projects" | no |
| `progress-dot.active` | 2 | 11.2px, 10.4px | 800 | "1" | no |
| `phone-cta` | 2 | 16.32px | 800 | "Call or Text (859) 420-7382" | no |
| `ico` | 2 | 18.4px | 800 | "☎" | no |
| `submit-btn` | 2 | 16px | 800 | "Request Free Inspection" | no |
| `sc-callbtn` | 2 | 13.12px | 800 | "📞 Call Joe" | no |
| `sc-next` | 2 | 16px | 800 | "Continue →" | no |
| `btn-arrow` | 2 | 14.4px, 13.12px | 800 | "→" | no |
| `sig` | 2 | 28.8px | 400 | "— Joe" | **YES — no action needed** |
| `btn-ghost-white` | 2 | 16px, 13.12px | 800 | "Text Joe Directly" | no |
| `btn-submit` | 2 | 15.2px | 800 | "Submit Entry" | no |
| `tc-pill` | 2 | 10.88px | 800 | "Most Chosen · ~50% of jobs" | no |
| `tc-cta` | 2 | 13.12px | 800 | "Get a Preferred Estimate" | no |
| `col-preferred` | 2 | 16px | 700 | "Preferred" | no |
| `gtss-cta` | 2 | 13.12px | 800 | "Explore the TAMKO Storm Series →" | no |
| `cta-primary` | 2 | 14.72px | 800 | "📞 Call Joe — (859) 420-7382" | no |
| `trust-icon` | 2 | 16px | 400 | "🤝" | no |
| `vs` | 1 | 13.12px | 800 | "VS" | no |
| `sb-call` | 1 | 12.16px | 800 | "📞 Call Joe" | no |

**Your options** (can be mixed per element):
- **(a) Darken to `#B85400`** — same fix as the announcement bar. White text
  passes at 4.55:1; visually a deeper, brick-ish orange. One more codemod pass
  and it's done; I can execute on request.
- **(b) Keep `#E8720C` but switch the text to navy `#142A52` or black** — also
  passes; bigger visual departure for CTAs.
- **(c) Accept the risk** — WCAG AA on marketing CTAs is a quality bar, not a
  legal mandate for a site like this; the scan will keep flagging it.

Note: the WooRank scan said "10 elements"; the real number is ~35 patterns.
Whatever you pick, the fix mechanic is the same codemod pattern used for the
announcement bar (`scripts/fix-ann-bar-contrast.js`).

## 2. ~~ACTION NEEDED~~ DONE — www → apex 301 (F1, ~2 minutes)

> **Update 2026-09-27:** done 2026-08-17 via the Hosting API workflow
> (#1217, verified in #1220); `www` and `http` both 301 to the apex, re-checked
> live 2026-09-27 ([SEO-AEO-GEO-DEEP-DIVE-2026-09-27](../../audit/SEO-AEO-GEO-DEEP-DIVE-2026-09-27.md)).
> The steps below are kept for history only.

The site is **Firebase Hosting** (not Cloudflare Pages, whatever the scan
assumed). `firebase.json` redirects can't match hostnames, so this is a
console step:

**If www is connected as a Firebase Hosting custom domain (most likely):**
1. [Firebase Console](https://console.firebase.google.com) → your project →
   **Hosting** → custom domains.
2. If `www.nobigdealwithjoedeal.com` is listed: remove it and re-add it
   choosing **"Redirect to an existing website"** → target
   `nobigdealwithjoedeal.com`. (Firebase's domain wizard offers redirect mode
   during setup; an existing "serve content" domain has to be re-added to
   switch modes.)

**If DNS is proxied through Cloudflare** (the Wave-127 notes in `firebase.json`
mention Cloudflare edge caching, so this may be your setup): a zone Redirect
Rule is cleaner:
1. Cloudflare dashboard → your zone → **Rules → Redirect Rules → Create rule**.
2. Custom filter expression: `http.host eq "www.nobigdealwithjoedeal.com"`.
3. Then: Dynamic redirect, status **301**, expression
   `concat("https://nobigdealwithjoedeal.com", http.request.uri.path)`,
   **Preserve query string: ON**.

**Verify after (from any machine — this session's network can't reach the domain):**
```
curl -sI http://nobigdealwithjoedeal.com/            # → 301 https://nobigdealwithjoedeal.com/
curl -sI http://www.nobigdealwithjoedeal.com/        # → 301 (https, apex)
curl -sI https://www.nobigdealwithjoedeal.com/       # → 301 https://nobigdealwithjoedeal.com/
curl -sI https://nobigdealwithjoedeal.com/           # → 200 (no loop!)
curl -sI "https://www.nobigdealwithjoedeal.com/services/financing?utm_source=x"
#   → 301 to https://nobigdealwithjoedeal.com/services/financing?utm_source=x (path + query preserved)
```

## 3. VERIFY AFTER MERGE+DEPLOY — cache headers (F2)

Deploy happens automatically on merge to main (`firebase-deploy.yml`). Then:
```
curl -sI https://nobigdealwithjoedeal.com/assets/css/nbd-fonts.css | grep -i cache-control
#   expect: public, max-age=86400        (was: max-age=300)
curl -sI https://nobigdealwithjoedeal.com/assets/js/nav-faq.js | grep -i cache-control
#   expect: public, max-age=86400
curl -sI https://nobigdealwithjoedeal.com/assets/fonts/montserrat-700-latin.woff2 | grep -i cache-control
#   expect: public, max-age=2592000
curl -sI https://nobigdealwithjoedeal.com/assets/images/joe-hero.jpg | grep -i cache-control
#   expect: public, max-age=2592000      (unchanged)
curl -sI https://nobigdealwithjoedeal.com/pro/js/dashboard-app.js | grep -i cache-control
#   expect: public, max-age=0, must-revalidate
#   (changed in the follow-up round: the Wave-127 revalidation rule's ordering
#    was fixed, so CRM app code now revalidates per request as its author
#    intended — see FOLLOWUP-LOG.md §4)
```
New operational rule this creates: **if you hand-edit a file under
`docs/assets/css|js/`, returning visitors can hold the old copy for up to 24 h.**
If a change must go out instantly, add `?v=2` to that file's references.

## 4. FYI — pre-existing quirk found in `firebase.json`, not changed

The `**/*.@(js|css)` rule (the "Wave 127 P0" one, `max-age=0, must-revalidate`)
never actually applies: the `**` rule after it wins per last-match-wins, so
JS/CSS has really been shipping with `max-age=300` all along — including
`/pro/js/**`. If the Wave-127 stale-SW symptom ever resurfaces in the CRM,
this is why. Fixing it means moving that rule below `**` — deliberately left
alone here because it changes CRM caching behavior (out of scope for this pass).

## 5. REMINDER — DMARC (your list, 5 minutes, DNS)

TXT record at `_dmarc.nobigdealwithjoedeal.com`:
`v=DMARC1; p=none; rua=mailto:<your inbox>` — monitor 2–4 weeks, then tighten
to `p=quarantine`. (SPF verified present and correct; no change needed.)

## 6. FYI — things checked and deliberately left alone

- **Phone landmine sweep:** every number other than (859) 420-7382 turned out
  to be a form placeholder (`(859) 555-1234` etc.) or the Oaks template's own
  contact number (`(513) 827-5297`, only under noindexed `sites/oaks/`).
  Nothing looked like a live wrong number on the marketing pages; nothing was
  changed.
- **JSON-LD `"email"` fields** still carry the plain address (structured data
  is meant to be machine-readable; encoding it would break the JSON).
- **Sitemap** is complete and correct at 199 URLs — the scan's "~250 pages"
  included private surfaces (pro/admin/tools/oaks). No action ever needed.
- **Orphan images** (`roofing-3/4.{jpg,webp}`, `drone-completed-brick.{jpg,webp}`,
  `drone-hero-curb.webp`, `projects/commercial-apartment-underlayment.jpg`) are
  referenced nowhere; left in place. Delete whenever, ~1.6 MB.
- **F7 minification: skipped** on the brief's own "acceptable outcome" clause
  (~13 KiB total upside).

## 7. Your non-code SEO track — GBP & reviews checklist (item 5, 2026-07-02)

The technical house is now in order. For a 4-month-old local-service domain,
these move rankings more than anything left in the code:

- [ ] **Google Business Profile completeness**: every service you offer listed
      as a GBP service, service area set, hours set, the real phone
      (859) 420-7382, website link to the apex (not www).
- [ ] **Photos weekly**: 2–3 job photos per week to GBP (before/after roofs
      outperform logos/stock). You already have the pipeline — the same shots
      that go to `our-work`.
- [ ] **Reviews cadence**: ask every completed job, same-day, via the /r QR
      link you already print. Target: steady trickle (2–4/month) beats bursts.
- [ ] **Reply to every review** (including the old ones) — response rate is a
      ranking input and social proof.
- [ ] **GBP posts**: 1 short post/month (storm season notice, financing,
      free-roof program). Low effort, keeps the profile "active".
- [ ] After the www redirect is live (§2), spot-check that GBP and any
      directories/citations point at `https://nobigdealwithjoedeal.com` (apex).

## 8. LEAD ENGINE — three switches to check + what's new (2026-07-02, direction A)

Audit result: your lead machine is nearly all built — but two delivery
channels may be silently off, and one finished feature is in rehearsal mode.

**a) Recovery emails are built but likely in DRY-RUN.** When someone starts
/estimate and bails, an hourly job is supposed to email them "want me to
finish it?" signed by you. It only SENDS when the `FUNNEL_RECOVERY_ENABLED`
env var is `true` on the `runabandonrecovery` Cloud Run service. Check/enable:
```
gcloud run services update runabandonrecovery --region=us-central1 \
  --update-env-vars=FUNNEL_RECOVERY_ENABLED=true
```
(or Cloud Console → Cloud Run → runabandonrecovery → edit → env vars).
Before flipping it, look at its recent logs — `funnel_recovery_dry_run`
entries show exactly who WOULD have been emailed; that's your preview.

**b) Your lead-alert TEXTS depend on Twilio A2P 10DLC registration.** The
code texts your cell instantly on every lead, but US carriers silently drop
messages from unregistered numbers (error 30034). Twilio Console →
Messaging → Regulatory Compliance: if the campaign isn't approved, emails
are currently your only alert channel. Finish the registration.

**c) Both email features need a REAL Resend key.** The deploy pipeline
creates placeholder secrets when missing. Firebase/GCP Console → Secret
Manager → `RESEND_API_KEY`: if the value is a stub, alerts/recovery/ack
emails all fail quietly. Also confirm your sending domain is verified in
Resend so mail doesn't land in spam.

**d) NEW as of today: homeowners get an instant "Got it — Joe here" email**
on every form submit (estimate, inspect, contact, free-roof, high-intent
storm reports), with your direct number for urgent cases. NBD leads only —
tenant leads are excluded on purpose. Test with a ZZ_QA_ lead + your own
email after deploy.

**e) Your decision, when ready:** an instant auto-TEXT to the homeowner
("Got it — Joe will call you shortly") converts even better than email, but
auto-texting requires express consent wording on the forms (TCPA). If you
want it, say so — it's a small forms-copy change + ~20 lines of code.

**f) NEW: morning digest + gated SMS ack (2026-07-02, round 2).** Every day
at 7am ET you'll get one email listing the last 24h of leads (skips when
zero). And the homeowner ack now has a TEXT version, estimate-funnel only
(that form's TCPA checkbox = express consent), default OFF. To turn on:
set `LEAD_ACK_SMS_ENABLED=true` on the leadAlert* Cloud Run services —
same mechanics as (a). Requires the A2P registration from (b) first.

**g) NEW: 24h follow-up email (2026-07-03).** Every 3 hours, leads 20-48h
old whose CRM card you never touched (stage/status still "new") get ONE
"we haven't connected yet" email from you — reply-able, with your direct
number. Ships ACTIVE (it's a service message on their own open request);
kill switch if ever needed: set LEAD_FOLLOWUP_ENABLED=false on the
leadfollowupsweep Cloud Run service. Operational note: this makes moving
a lead's stage in the dashboard meaningful — touch the card when you
reach someone, and they'll never get the follow-up.

## 9. STORM WATCHER (direction C, 2026-07-03)

Every 30 minutes the site now checks NWS Local Storm Reports for your
service area. When hail >=0.75", damaging wind (>=58mph or a damage
report), or a tornado report lands within 25mi of a service city, you get
an instant SMS + email: what fell, where, and how many /storm-alerts
subscribers sit within 15 miles (grouped by zip).

Subscriber texting ("we'll only text you when severe weather actually hits
your zip") ships OFF. Until you flip it, every storm email shows exactly
who WOULD have been texted — your dry-run preview. To go live (needs A2P
from §8b first):
```
gcloud run services update stormwatch --region=us-central1 \
  --update-env-vars=STORM_TEXT_ENABLED=true
```
Protections: max one storm text per subscriber per 24h, STOP honored by
Twilio, unknown zips never texted (they show in your email instead).
Every processed report is stored in the storm_events collection for audit.

## 10. PRO FUNNEL — one console flip + what changed (2026-07-03)

**Your 1-minute fix (audit gap #2):** the access-code signup path
("NBD-PRO" hint on /pro/register) fails in prod because the compute
service account can't mint custom tokens. Fix:
```
gcloud projects add-iam-policy-binding nobigdeal-pro \
  --member="serviceAccount:717435841570-compute@developer.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```
Then test: register with an access code from your access_codes collection.

**Shipped in code (gaps #3-4):**
- /pro/landing.html advertised stale plans at $29/$49/$79 ("Foundation/
  Blueprint/Professional") while checkout charges $99/$299 — the cards,
  footer, and FAQ now mirror pricing.html exactly (Free $0 / Starter $99 /
  Growth $299, trial wording accurate).
- The free-guide magnet's "guide is ready" screens now hand contractors to
  /pro/register (UTM-tagged free-guide/magnet so the new monthly report
  shows whether the magnet converts).
- Checkout no longer 403s unverified emails — a fresh signup can pay
  immediately (logged for visibility; Stripe re-collects receipt email).

## 11. PILLAR1 PHASE 2 + 4 SHIPPED — self-serve tenants + onboarding wizard (2026-07-03)

New signups (free path) now self-provision: createCompany creates
companies/{uid} + a NEUTRAL companyProfile seed (their name + their email
as alert contact — never NBD's brand) and sets companyId/role=company_admin
claims. Their public-site leads route to THEM, not you. Idempotent;
invited reps can't accidentally spawn tenants; 5/hr rate limit + App
Check (the register page now initializes App Check — without that the
provisioning call was rejected in prod).

Phase 4 (same day): after registering, new free owners land on
/pro/onboarding.html — a 3-step wizard (company basics → brand → review)
that writes their companyProfile (letterhead + brand.contact/colors/seal)
and marks users/{uid}.onboarded. Skippable; invited reps and your own
accounts are bounced straight to the dashboard; 'NBD' is rejected as a
seal. If register-time provisioning failed, the wizard retries
createCompany on finish (self-heal).

Test after deploy (ZZ_QA_ prefix, throwaway email):
1. /pro/register → free account with company name "ZZ_QA_ Roofing".
2. You should land on /pro/onboarding.html with the name prefilled.
   Fill a phone + pick a seal, finish → dashboard.
3. Firestore: companies/{uid}, companyProfile/{uid} (brand.legalName =
   ZZ_QA_ Roofing, contact.alertSms = the phone), users/{uid}.onboarded
   = true; claims carry companyId + role=company_admin.
4. To re-run the wizard on the same account: /pro/onboarding.html?redo=1.

## 12. PILLAR1 PHASE 3 SHIPPED — team invites now actually work (2026-07-03)

Until now the Team tab wrote an invite record and said "Invite sent" —
but no email ever went out, and the function meant to join the rep to
your company could never deploy (it needed a paid Google Cloud Identity
Platform upgrade). Fixed WITHOUT the upgrade — the GCIP decision from
the plan is closed, no action or cost on your side:
- Inviting someone now emails them signup steps (same Resend key your
  lead alerts use; reply-to goes to the inviting owner).
- When they sign up with that email, VERIFY it (they must click the
  verification link — that's the security gate), and open the
  dashboard, they're joined automatically: claims + member record flip
  to active. If they signed up before verifying, it retries on their
  next dashboard load.
- Safety: an invite can never grant platform-admin; your own accounts
  can't be downgraded by an invite; someone already on another team is
  refused.

Test after deploy (throwaway email you can actually receive):
1. Dashboard → Settings → Team → invite the throwaway email as
   sales rep. You should RECEIVE the invite email within a minute.
2. Follow it: register free (ZZ_QA_ names), click the verification
   email, then open the dashboard → you should land in YOUR company's
   team (Settings → Team on your owner account shows the member
   active).
3. Firestore check: companies/{your-uid}/members/{email} status
   'active' with their uid stamped.

## 13. PILLAR 4 PHASE 1 SHIPPED — company-level billing (2026-07-03)

Billing used to be per-person: a rep you invited showed up as 'free'
(their own uid has no subscription doc) no matter what plan the company
paid for, and each rep had their own separate usage meter. Now:
- Reps see and share the COMPANY plan. Plan + limits resolve from the
  owner's subscription everywhere (dashboard, feature gates, usage
  meters). Your own accounts still bypass everything as before.
- Usage pools company-wide: 5 reps on Growth share one 500-lead/month
  allowance instead of each getting a phantom free meter.
- Seat limits are real now: Free/Starter = solo (invites blocked with
  an upgrade prompt), Growth = 5 reps, and the check happens on the
  server so it can't be bypassed. Re-inviting a pending member re-sends
  their email without taking a new seat.

Nothing for you to flip — deploys with the merge. Quick check when you
run the §12 invite test: after the rep joins, their dashboard should
show your plan (not Free), and Settings → Team should reject a 6th
active invite on Growth with a friendly seat-limit message.

Still open from the Pillar-4 sketch (your product calls, not built):
gating signup behind a paid plan, and charging at company creation.

## 14. PILLAR 5 PHASE 1 SHIPPED — instant tenant websites (2026-07-03)

Every tenant now gets a ready-made one-page website at
`/sites/t/<their-company-id>` — no hand-building a folder like we did
for Oaks. It renders live from their company profile (name, tagline,
logo, colors, phone, service area, services list), and its "Request a
free quote" form feeds THEIR pipeline and THEIR lead alerts through the
same hardened gateway as every other public form. What a tenant never
set simply doesn't show (neutral fallbacks — no NBD branding can bleed
onto their site). Pages are noindex, same as the Oaks microsite.

Nice-to-know:
- Pretty URLs: set `siteSlug: "acme-roofing"` on their companies/{id}
  doc (Firestore console for now) → /sites/t/acme-roofing works.
- Private data can't leak: the page reads through a server endpoint
  that whitelists ONLY public marketing fields — alert email/SMS,
  Twilio/Slack settings, pricing, and legal text are never served.
- Brand edits show on the site within ~5 minutes (cached).

Test after deploy: take your §11 ZZ_QA_ test tenant's uid and open
`/sites/t/<that-uid>` — you should see their brand + colors; submit the
form with ZZ_QA_ names and confirm the lead lands in that tenant's
pipeline (NOT yours) and the ack/alert goes to the tenant's email.

Still open for later phases (your calls): custom domains per tenant
(console/DNS work), moving Oaks off its hand-built pages onto this
template (ask Scott), and a Settings field so tenants set their own
slug.

## 15. SETTINGS SURFACES SHIPPED + THREE THINGS ON YOUR DESK (2026-07-03)

**Shipped in this round (nothing to flip):**
- Settings → Company Profile → **Your Website**: tenants set a custom
  web address (slug) for their microsite — reserved names and
  duplicates are rejected server-side — plus a live link to their site
  and a "re-run the setup wizard" shortcut.
- Settings → Team: member rows now have real actions — cancel a
  pending invite, disable an active rep (kills their login and live
  sessions, leads stay), re-enable, and remove from the roster.

**On your desk — 1) Custom domains** (when a tenant asks): the full
runbook is at documentation/runbooks/TENANT-CUSTOM-DOMAINS.md. Short
version: start with a free 301 redirect at their registrar (5 minutes,
option A); the true white-label proxy (option C) is a small build I'll
productize when a few tenants want it.

**On your desk — 2) Pillar 4 product calls** (answer whenever; I build
after you pick):
- **Gate signup behind a paid plan?** My recommendation: NO — keep the
  free tier as the funnel (abuse is already contained by App Check +
  rate limits + seat/usage caps), and let the in-app limits do the
  selling. Alternatives: card-required signup, or a time-boxed trial.
- **Charge at company creation?** My recommendation: NOT yet — the
  upgrade path via /pro/landing pricing + Stripe checkout already
  works; charging at signup pairs best with a trial decision above.
  If you pick a paywall, I'll build the checkout-first-then-provision
  flow.

**On your desk — 3) Homeowner side:** the three blog drafts are still
waiting on your edits in documentation/drafts/ (each has JO: markers) —
say the word when edited and I'll publish them into /blog with all the
trimmings. The GBP/reviews cadence from §7 remains the highest-leverage
non-code SEO work.

## 16. SECURITY AUDIT OF THIS WEEK'S WORK — bugs found & fixed (2026-07-03)

I ran three adversarial audits over everything shipped this week and fixed
the confirmed bugs. Full write-up:
documentation/qa/tenant-lifecycle-audit-2026-07.md. The ones that would
have bitten you:
- Tenant microsite leads were misrouting to YOU instead of the tenant (a
  casing bug in the lead tagger). Fixed.
- The "Save Address" button in Settings was silently doing nothing —
  the whole slug feature was dead on arrival. Fixed.
- If a new signup's provisioning hiccuped, finishing the setup wizard
  wiped the brand they'd just entered. Fixed.
Plus a slug-uniqueness race, a plan-claim clobber, a wizard bug that
stamped MY orange as every tenant's brand color, and a couple of caching/
scope edge cases — all fixed and tested (both rules suites + 1924 smoke +
browser tests green).

Deferred to a focused follow-up PR (needs careful testing): when you
Disable or Remove a team member, their access token can linger up to ~1
hour (standard Firebase behavior) and their claims aren't fully cleared —
I'll harden that with its own rules-tested change. A few low-priority
items (public-form bot-hardening, honeypot autofill, tenant-site favicon)
are flagged in the audit doc for your call.
