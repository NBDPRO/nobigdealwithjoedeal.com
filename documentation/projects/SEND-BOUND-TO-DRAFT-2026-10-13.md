# Send bound to the draft (2026-10-13)

Follow-up to [DOC-DRAFTS-QUEUE-2026-10-13](DOC-DRAFTS-QUEUE-2026-10-13.md):
the security review of #2447 found three holes in how the "Docs to review"
queue sent mail. Jo said go. This note records what changed, the `sendEmail`
caller table, and what is still open.

## The findings and what closes them

| Finding | Closed by |
|---|---|
| MEDIUM 1 (pre-existing): `sendEmail` trusted the caller's `kind`, so a same-company rep could call it directly with `kind:'document'` and skip the unsubscribe gate for commercial mail. | **Draft path:** `kind` comes from the server's `DRAFT_KINDS` table keyed by the draft's `kind` (not even the stored `emailKind` copy). **Legacy path:** a claimed transactional kind is honoured only with the record it is about (below); anything else is commercial. |
| MEDIUM 2: two tabs or two people could double-send a draft. | The draft is **claimed in a Firestore transaction** (`draft` -> `sending` + nonce) before the provider is called. Two concurrent sends make one provider call; the loser gets 409. |
| LOW: `doNotContact` checked in the browser only. | Enforced server-side on **both** paths; fails closed (503 `record_unverified`) when the lead cannot be read. |
| LOW: `soldTier` is rep-editable, so a wrong tier could write a wrong warranty year into a reviewed draft. | The warranty draft names a tier only when the estimate the homeowner **signed** says so (`estimates/{id}.signedPrice`, server-only). Otherwise the `[[workmanship warranty term]]` placeholder, which blocks Send. |

## How a draft send works now

`POST sendEmail {leadId, draftId, subject?, body?}` (the endpoint stays an HTTP
function; a request that names `draftId` is a draft send):

1. Caller checks as before (not viewer/member, verified email), then
   `functions/doc-draft-send.js` `prepareDraftSend`:
   - loads `leads/{leadId}` and the draft; the caller must be able to open the
     lead (owner, platform admin, same-company company_admin/manager: exactly
     the draft rules);
   - refuses unless the draft is still `draft` (409 `already_sent` /
     `already_sending` / `draft_not_sendable`);
   - recipient = `draft.to`, which must **still be on the lead** (422
     `recipient_not_on_record` if the customer's address changed);
   - `do_not_contact` (403) for every kind;
   - subject/body: the rep's edit is taken only while the draft is `draft`;
     control + bidi characters stripped, subject flattened to one line, length
     <= 300 / 10,000 (the rules limits), empty refused, any `[[...]]` refused
     (422 `unresolved_placeholders`);
   - commercial kind (the thank-you's review ask): STOP (403
     `stop_requested`), unsubscribe register (403 `unsubscribed`, 503
     `suppression_unverified` when unreadable), CAN-SPAM postal address (403
     `no_postal_address`); footer + RFC 8058 headers on the message.
2. The handler runs the IP and per-user limiters (a 429 happens before any
   claim).
3. `executeDraftSend`: transactional claim, build, provider, finalise.

Provider outcomes:

| Outcome | Draft | Response |
|---|---|---|
| Accepted | `sent` + `sentAt`, `messageId`, `sentBy` | 200 `{success, id, bookkeeping}` |
| Definite refusal (a 4xx API answer other than 408) | released to `draft`, `lastSendError` kept | 502 `provider_rejected` |
| Anything ambiguous (thrown, network, 5xx, 408, no status) | stays `sending`, `sendState: 'check_provider'` | 502 `send_unconfirmed` |
| Accepted, but the `sent` write failed | stays `sending`, `sendState: 'sent_unrecorded'` + `messageId` (durable: the card says "WAS sent, tap Mark sent") | 200 with `bookkeeping: 'failed'` (never "could not send") |

The provider's own error wording stays in the server log; the browser gets the code only.

An unconfirmed send is **never retried automatically**. The card shows "This
may or may not have gone out. Check your email provider ..." with Mark sent /
Dismiss (rules let the browser clear an unconfirmed claim, or one older than 5
minutes, to `copied` or `dismissed`; never back to `draft`).

## Rules (firestore.rules `doc_drafts`)

The browser can no longer write `sending`, `sent`, `sentAt`, `messageId` or any
claim field. Client transitions:

- `draft`: edit `subject`/`body`; -> `dismissed`; -> **`copied`** ("I sent it
  myself, outside the CRM": the Thumbtack / Yelp / text path; this replaces the
  old client-written `sent`). **Decision:** a rule-permitted transition, not a
  callable: it asserts nothing the server must verify and needs no provider.
- `failed` marker: -> `dismissed` only (it used to be revivable).
- `sending` + (`sendState == 'check_provider'` or `sendingAt` older than 5 min):
  -> `copied` / `dismissed`.
- `sent`, `copied`, `dismissed` are final.

## `sendEmail` caller table (every call site in `docs/pro/js`)

| Caller | Sends | `kind` sent | Needs for the kind to be honoured | Behaviour change |
|---|---|---|---|---|
| `doc-drafts-ui.js` (the queue) | draft | none (server derives) | - | now `{leadId, draftId, subject, body}` only, via `NBDComms.sendDraftEmail` |
| `invoice-pipeline.js` (invoice) | invoice HTML | `invoice` | `invoiceId` -> an invoice the caller can open | none (it passes `invoiceId`) |
| `invoice-pipeline.js` (receipt) | receipt HTML | `receipt` | `invoiceId` | none |
| `invoice-reminder.js` | reminder | `invoice` | `invoiceId` (`inv.id`) | none unless `inv.id` is missing, then commercial |
| `close-board.js` | estimate link | `proposal` | a lead | none |
| `email_system.js` | estimate / photo report / stage templates | `estimate`, `document`, stage kinds, else none | a lead | none |
| `nbd-comms.js` (stage email) | stage template | `appointment` / `estimate` / none | a lead | none |
| `portal-link-helpers.js` | portal link | `portal_link` | a lead | none |
| `smart-followup.js` | portal link / follow-up | `portal_link` / none | a lead | none |
| `review-engine.js` | review request | `review_request` (not on the list) | - | already commercial |
| `winback.js` | win-back | `winback` (not on the list) | - | already commercial |

Allowlist (`email-send-guard.js` `LEGACY_KIND_NEEDS`): `invoice`, `receipt` need
an invoice record; `estimate`, `proposal`, `portal_link`, `document`,
`appointment` need a lead. `contract` is on the suppression module's list but no
CRM caller sends it, so it is **not** honoured here. Every `email_log` row now
records `kind`, `category`, and `claimedKind` when the claim was not honoured.

**MEDIUM 1 is closed on the draft path and only narrowed on the legacy path.**
Both reviews (silent-failure and security) found the same thing, and it is true:
the server cannot read intent, and "the request carries a lead" is a fact the
caller chooses (sendEmail already requires a lead or an invoice, so for
`estimate`/`proposal`/`portal_link`/`document`/`appointment` the check adds
nothing beyond that). A rep who sends marketing through the legacy path with
`kind:'document'` and a lead the rep can open is still treated as
transactional. What closed: `invoice`/`receipt` without an invoice, `contract`,
any made-up kind, an invoice that belongs to another customer, and the draft
path entirely. Same class on the draft path: a rep can **edit** a transactional
draft's text into a promo; the gate keys on the draft's kind, not on what the
rep typed (a human authoring text, not an integrity control). The same goes for
the warranty years: the generated text is server-fixed, the rep can still type
any term. Real closure = every remaining caller moves to a server-built mode
(the server renders the invoice / receipt / portal / estimate mail from a
template id, the way drafts are), after which `kind` is dropped from the
legacy path. The `email_log` rows (`kind`, `claimedKind`) are the audit trail
until then. **Decision for Jo.**

Also added in review round 1: a request naming a lead AND an invoice that
belongs to a different lead is refused (422 `record_mismatch`), so an invoice's
address cannot ride through another lead's do-not-contact flag; the flag is read
as boolean true, `1`, or `'true'/'yes'/'on'`; a caller whose company is not the
lead's company is refused (403) on the draft path, and a platform admin uses the
LEAD's tenant (register, postal address, brand); a signed estimate counts as
tier evidence only when it names this lead and the lead's user or company.

## Vacuity-audit round (2026-10-13)

The auditor mutated the first cut (~90 mutations, ~70 red, ~30 survivors). All
survivors are now covered or fixed: tier lookups are own-property only (a signed
tier of `constructor` / `__proto__` / `toString` gives the placeholder, never a
function string); the claim also refuses when `channel` or `emailKind` moved
between prepare and claim; a lead-only kind with just an invoice is demoted;
the text cleaning is tested for every stripped code point; the queue UI and
`NBDComms.sendDraftEmail` are driven for real (409 refresh, unconfirmed, stale
claim boundary, no mailto, what the clear writes); rules deny `sending` ->
`sent`, edits on a claimed draft, junk timestamps, over-long subject/body.

## Not done / follow-ups

- No Resend `Idempotency-Key`: a release-then-retry within 24h could reuse a
  key whose first attempt failed. The claim is the guard.
- `tcpaConsent === false` / the consent-declined policy (PR in
  `feat/sms-consent-declined-policy`) is texting-only; email gates are the
  suppression register, STOP and do-not-contact.
- `doNotContact` / `dnc` is read by the server and the queue, but no CRM screen
  writes it yet; the field exists only if a rep or import sets it.
- Unconfirmed sends cannot be re-sent from the card by design; the rep dismisses
  and composes a new message (or marks it sent if the provider shows it went).
- The timeline note (`notes`) is still written by the browser after a delivered
  send; a closed tab loses it (the draft itself is `sent` with `messageId`).

## Tests

- `tests/send-bound-to-draft-2026-10-13.test.js`: real `sendEmail` handler,
  fake Firestore with transaction retry and yielding reads, stub provider.
  Two and five parallel sends -> one provider call; every gate refusal has a
  positive control; the caller table; provider outcomes.
- `tests/firestore-rules.doc-drafts.test.js` (emulator): browser cannot set
  `sent`/`sending`/`sentAt`/`messageId`/`sendNonce`; `copied` allowed; claim
  clearing only when unconfirmed/stale; never back to `draft`.
- Updated: `tests/doc-drafts-2026-10-13.test.js`, `tests/email-unsubscribe.test.js`
  (an `invoice`/`receipt` kind now needs its `invoiceId`).
- Break-test (mutation list, which assertion reddened): see the PR body.
