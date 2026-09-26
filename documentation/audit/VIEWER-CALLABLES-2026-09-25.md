# Cloud Functions refuse a viewer's writes, sends, mints and orders (2026-09-25)

**Result.** Every exported callable and HTTP function (124) now has a recorded
verdict for the `viewer` role, and the 26 that create, update or delete tenant
data, send to a homeowner or third party, mint a token or link, or place a paid
order refuse a viewer first, through one shared guard. Branch
`fix/viewer-callables`. This closes the first "Left open" item of
[ROLE-TIGHTENING-2026-09-25](ROLE-TIGHTENING-2026-09-25.md) (#1776).

Prod today (read-only counts, 2026-09-25): 10 Auth users, **0** with a `viewer`
role claim (admin 1, company_admin 2, member 1, demo 1, no role 5); 0
`users/{uid}` docs with `role == 'viewer'`; 0 `companies/*/members` docs. The
change affects no live account yet; it lands before the first viewer is
invited.

## The decision being enforced

> **B.** The 'viewer' role is READ-ONLY everywhere: a viewer can read what
> their company role allows but cannot create, update or delete any tenant
> data — including rows under leads they own. (Jo, 2026-09-25, final.)

#1776 enforced it in `firestore.rules` / `storage.rules` and the client. A
Cloud Function writes with the Admin SDK, which bypasses the rules, and most
callables checked ownership only (the lead's `userId`, the envelope's
`ownerUid`, the deal's `userId`), which a viewer can hold. Two checked less
than that: `attachStormProof` and `requestMeasurement` admit any member of the
lead's company, on any lead. Before this change only `sendEmail` and
`markEmailUnsubscribed` refused a viewer.

## The guard

`functions/shared.js`:

- `assertNotViewer(claims)` for onCall: throws
  `HttpsError('permission-denied', 'Your role is view-only')`.
- `viewOnlyRefusal(decoded)` for onRequest: returns `null` or
  `{ status: 403, body: { error: 'Your role is view-only', code: 'view-only' } }`
  for the handler to write (the file's rule: never throw `HttpsError` at an
  HTTP handler; same shape as `requireAuth`).
- `isViewOnlyRole(claims)`: `claims.role === 'viewer'`, exactly the rules'
  `notViewer()` expression. A solo operator has **no** role claim and passes;
  every other role passes. No other role's rights changed.

Each refused handler calls it right after its sign-in check, before its rate
limiter, any Firestore read, any vendor call. `grep` for an existing role
helper found none that fit: `handlers/_shared.js requireTeamAdmin` is an
owner/admin allowlist, and the two existing viewer checks were inline.

## Refused (26)

| Function | File | Why a viewer is refused |
|---|---|---|
| `attachStormProof` | handlers/storm-proof.js | writes `leads/{id}/storm_proofs` + a lead stamp; paid hail lookup; admitted any company member |
| `requestMeasurement` | integrations/measurement.js | paid provider order, result written onto the lead; admitted any company member |
| `createPortalToken` | portal.js | mints a homeowner portal link |
| `revokePortalToken` | portal.js | updates token docs, purges legacy portal fields/objects on the lead |
| `replyToPortalMessage` | portal.js | messages the homeowner, writes the thread |
| `createEsignEnvelope` / `saveEsignFields` / `sendEsignEnvelope` / `voidEsignEnvelope` | esign-envelope.js | envelope writes; send mints a signer link and emails it |
| `createSignRequest` | remote-signing.js | mints a sign link, emails the signer |
| `sendEstimateForSignature` | integrations/esign.js | paid BoldSign envelope to a homeowner |
| `createDealAcceptToken` | deal-acceptance.js | mints a deal-room accept link |
| `createReportShareToken` | report-sharing.js | mints a public share link (and can email it) |
| `transcribeVoiceMemo` | integrations/voice-memo.js | **only with a `leadId`**: writes a voice-memo activity row |
| `analyzePhotoVision` | photo-vision.js | AI spend, writes the classification onto the photo |
| `analyzeRoofPhoto` (HTTP) | handlers/photo.js | AI spend, writes `aiAnalysis` onto the photo |
| `backfillAnalytics` | handlers/migrations.js | rewrites fields on the caller's knocks and leads; paid geocoding |
| `trackUsage` | billing.js | increments the company's usage meter |
| `renderPdf` | render-pdf.js | saves a PDF of tenant data under `pdf-renders/` and returns a link |
| `createCalendarFeedToken` | calendar-feed.js | **mint only**: an unauthenticated feed URL with lead names and addresses; `revokeOnly` stays open (it only turns off the caller's own links) |
| `sendSMS` / `sendQueuedSMS` (HTTP) | sms-functions.js | texts a homeowner (one shared handler; ahead of the queued-send peek too) |
| `sendD2DSMS` (HTTP) | sms-functions.js | texts a homeowner |
| `createCheckoutSession` (HTTP) | stripe.js | buys a plan for the company |
| `createCustomerPortalSession` (HTTP) | stripe.js | opens the company's Stripe billing portal, where its subscription and payment method are managed |
| `createStripePaymentLink` (HTTP) | stripe.js | mints a payment link (and deactivates the prior one); admitted any member of the invoice's tenant |

The two conditional guards are deliberate. A transcript-only voice memo
(`nbd-whisper.js`, the "dictate everywhere" mic that fills whatever input is
focused, search included) writes nothing; revoking your own calendar links
leaves less tenant data reachable, not more.

`renderPdf` has two read-shaped callers, the customer page's blank-template
preview (which #1776 kept for a viewer) and a format preview in the estimate
builder opened to read. Both already catch a failed server render and open
their client render, so a viewer's preview still works.

## Everything else (98), with its verdict

**Already refused a viewer before this change (2).** `sendEmail` (2026-06-24,
also `member`) and `markEmailUnsubscribed` (2026-09-22, also `member`). Left
as they are; their message differs ("Your account role cannot …").

**Role-gated: an allowlist that excludes a viewer (26).** Read from the code,
not re-tested here.
`requireTeamAdmin` (owner / company_admin / platform admin; a subordinate role
without a `companyId` is refused first): `createTeamMember`, `updateUserRole`,
`deactivateUser`, `removeMember`, `createTeamInvite`, `assignSeats`,
`setSiteSlug`, `reverifyCompanyKnocks`, `createConnectAccount`,
`createConnectOnboardingLink`, `createConnectDashboardLink`;
`setCompanySeatCount` (owner only). admin / company_admin: `getAdminAnalytics`,
`integrationStatus`, `getSwathReport`, `getSwathUsage`. admin / company_admin /
manager: `adminAI`. owner / manager / admin: `listTeamMembers`. Platform admin:
`getAiUsageAnalytics`, `rotateAccessCodes`, `runMigrations`, `setStorageCors`.
Owner claim / platform admin: `convertUnmatchedSms`, `provisionE2ETestUser`.
Owner emails only: `mintOwnerClaims`. The E2E test account only:
`cleanupE2ETestData`.

**Read (8).** Return data, write no tenant data: `getAdjusterTacticBoard`,
`getAiTextingStats`, `getDocumentHtml`, `getEsignEnvelopeForOwner`,
`integrationAvailability`, `getSubscriptionStatus`, `signImageUrl` (a
15-minute read URL for an image the caller may already read),
`getConnectStatus` (also refreshes the server-derived Stripe mirror; nothing
the caller supplies is written).

**Read, paid per call (7).** Return data to the caller only and write no tenant
data, but bill a vendor; each is rate-limited per uid. Kept open because
decision B is about data and each has a read use a viewer has: `claudeProxy`
(AI answers; paid-plan gated), `dictate` (the command palette's voice search),
`lookupParcel` (property intel on a knock), `getHailHistory` (the map's hail
overlay), `resolveAddress` (door verification; writes only the shared geocode
cache), `extractReceiptData` (receipt OCR; writes only the caller's own cost
meter), `previewAiPersona` (a preview that writes nothing, like the blank
template preview). See Left open.

**The caller's own account (8).** Sign-in and boot, the caller's own tenant,
their own data rights: `claimInvite`, `activateInvitedRep`,
`registerDeviceFingerprint`, `revokeMySessions`, `exportMyData`,
`requestAccountErasure` (see Left open), `createCompany` and
`reserveCompanyPrefix` (both refuse an account that already belongs to another
company, which every invited viewer does).

**No signed-in caller (47).** A homeowner token, a webhook, or the public
site, so there is no role to check: `getHomeownerPortalView`,
`getPortalDocumentHtml`, `getPortalMessages`, `sendPortalMessage`,
`uploadHomeownerPhoto`, `requestCallback`, `reportWarrantyClaim`,
`submitCustomerRating`, `getEstimateForView`, `recordCustomerEvent`,
`getSharedReport`, `getSignDocument`, `submitSignature`, `getEsignEnvelope`,
`submitEsignEnvelope`, `getDealRoom`, `submitDealAcceptance`,
`getCalendarFeed`, `emailUnsubscribe`, `confirmAccountErasure`,
`validateAccessCode`, `sendVerificationCode`, `verifyCode`, `notifyNewLead`,
`submitPublicLead`, `submitReferral`, `saveFunnelProgress`, `publicFunnelAI`,
`publicVisualizerAI`, `publicRoofMeasure`, `visualizerImageGen`,
`stormReport`, `getGoogleReviews`, `getPublicSiteConfig`, `shareSSR`,
`cspReport`, `imageProxy` (retired, answers 410), and the webhooks
`stripeWebhook`, `invoiceWebhook`, `stripeConnectWebhook`, `calcomWebhook`,
`esignWebhook`, `measurementWebhook`, `resendWebhook`, `swathWebhook`,
`thumbtackWebhook`, `incomingSMS`.

Firestore / Storage / scheduled triggers have no caller role. The client
writes that fire them are already refused to a viewer by the rules.

## Client

`docs/pro/js/role-gate.js` (`?v=3` on both pages) hides, and its capture guard
explains, the visible controls that reach a newly refused function:
card-detail 🛡️ Storm Proof, Share / Revoke portal link, Reports ✨ Enrich
Data, the estimate builder's 📐 Auto-measure, the close board's Text / Email /
Copy (each mints an accept link and used to fail as "Could not create the
accept link — try again"), the D2D knock's 📐 Order precise roof report (failed
as "Could not order the report"), and the photo lightbox's ✨ Analyze damage
with AI.

Everywhere else the server's text reaches the page's existing error toast,
which already prints the error message: every SMS send goes through
`NBDComms.sendSMS`, which treats a 403 as final (no hand-off to Messages) and
toasts its `error`; the portal-link helpers ("Couldn't copy link: Your role is
view-only"); the calendar feed ("Could not create your calendar link: …");
Send for signature; document share links.

## Tests

- `tests/viewer-callables.test.js` (new, node bucket): **91 checks.**
  - A (6): the helper. Only an exact `'viewer'` is refused; sales_rep,
    manager, company_admin, admin, member, a no-role solo operator and no
    claims pass; exact code, text and HTTP body.
  - B (78): each of the 26 refused handlers is driven for real against
    stubbed firebase modules and vendor SDKs (nothing reaches a network). With
    the same input, a viewer gets the view-only refusal with **zero** side
    effects recorded (no Firestore op, no per-uid limiter, no vendor call); a
    sales_rep and a solo operator get past the guard (not refused, and the
    handler body ran: at least one side effect recorded).
  - B2 (2): a viewer's transcript-only voice memo and `revokeOnly` calendar
    call are not refused.
  - C (5): `functions/index.js` is loaded in a child process and every
    exported callable / HTTP function must have a verdict in the suite's
    `VERDICTS` table (124 today). A new function fails the suite until
    someone decides whether a viewer may call it. Every `refused` verdict must
    have a section-B case and every case a `refused` verdict.
- `tests/role-gate.test.js`: 140 (was 139). The new controls are in the gated
  selector; close-board Preview and card-detail Photos / Docs are not.
- `sms-send-optout-order`, `sms-outbox-server`, `esign-envelope-guards`: their
  `./shared` stubs gained the new export (no caller there is a viewer).

**Break-tests** (fix reverted, suite run, restored byte-for-byte):

| Break | Reddened (and nothing else) |
|---|---|
| guard removed from `attachStormProof` | "attachStormProof: viewer → view-only refusal, zero side effects" (90/91) |
| guard removed from `sendD2DSMS` | "sendD2DSMS: viewer → …" (90/91) |
| both conditional guards made unconditional | the two B2 lines (89/91) |
| `dictate` dropped from `VERDICTS` | "every exported callable / HTTP function has a verdict" (90/91) |
| helper compares against `'Viewer'` | all 26 viewer lines + 3 helper lines (62/91) |
| `enrichReportData` dropped from role-gate's list | role-gate "gated: storm proof, …" (139/140) |

Also green: `node tests/smoke.test.js` (4421), the node bucket (192 suites),
`scripts/check-js-syntax.js`, `run-test-manifest.js --check` (floors
192/68/281). Not done: a browser run as a viewer account (no emulator E2E
spec provisions one); the capture guard itself is covered by role-gate.test.js.

## Left open

- **Paid read-shaped calls stay open to a viewer.** `claudeProxy`, `dictate`,
  `previewAiPersona`, `extractReceiptData`, `lookupParcel`, `getHailHistory`,
  `resolveAddress` write no tenant data but bill a vendor per call (each
  rate-limited per uid; `claudeProxy` also against the company AI budget). If
  a viewer should spend nothing, each is a one-line `assertNotViewer`, and the
  suite's `VERDICTS` entry flips to `refused` with a section-B case.
- **Account erasure deletes team data, for every role.** `requestAccountErasure`
  → `confirmAccountErasure` removes the account's uid-owned rows ("your leads,
  estimates, photos …"). For any team member, not just a viewer, that includes
  company leads assigned to them. Whose data that is (the member's or the
  company's) is a product call; unchanged here.
- **Broader than the lead rules, for non-viewers (unchanged by decision).**
  `attachStormProof` and `requestMeasurement` still admit any member of the
  lead's company on any lead, a sales_rep included, though the rules let a rep
  read only their own leads. `createCheckoutSession`,
  `createCustomerPortalSession` and `createStripePaymentLink` admit any
  non-viewer member of the tenant. "Do not change any other role's rights"
  kept these as they were.
- **`member`** (the access-code login; 1 in prod) is not refused by the new
  guard. Only `sendEmail` and `markEmailUnsubscribed` refuse it.
- **Links minted before someone became a viewer keep working** (portal, share,
  sign, deal-accept, calendar feed). The guard stops new ones; the owner or a
  company_admin revokes portal links, and the viewer can turn off their own
  calendar links.
- The portal-link helpers' entry points (kanban "Text portal link", activity
  feed, almost-there widget, the customer page's portal buttons) and the
  calendar feed's Create my link stay visible to a viewer; the click ends in
  the view-only message from the server, not a hidden control.
