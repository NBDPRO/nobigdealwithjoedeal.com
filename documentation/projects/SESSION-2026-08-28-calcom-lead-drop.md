# Session 2026-08-28 — the Cal.com lead drop: a booking that never became a lead

Jo's ask (verbatim intent): "I just got another online lead schedule
organically on my site. Let's look and see what is working and why and keep
momentum going in that direction. Tell me what you think and what we can
improve on but don't make anything up or exaggerate just be honest." The
honest answer turned out to be the opposite of the premise: the booking had
**not** reached the CRM at all. Everything below shipped on branch
`claude/lead-conversion-analysis-l34mde` → **#1288**, squash-merged as
`f44f346a` and **deployed to `nobigdeal-pro` the same hour**.

Companion audit: [CALCOM-INTEGRATION-2026-08-25](../audit/CALCOM-INTEGRATION-2026-08-25.md)
(corrected in place by this session — its "LIVE end-to-end" header was wrong).
Same-day sibling lane: [SESSION-2026-08-28-ourwork-areas-galleries-gbp](SESSION-2026-08-28-ourwork-areas-galleries-gbp.md).

State at close: **the code fix is live in production and verified at the
deploy layer; it has never executed against a real booking.** Customer AF's
own booking was never backfilled and remains Jo's call.

---

## §1 — The trigger: one organic booking, and what could honestly be said about it

A Cal.com "Free Roof Inspection" booking arrived 2026-08-28 11:35 for
Customer AF — [street address], Wilder KY, inspection 2026-08-29 10:00, mobile
`[phone removed]`. Notes captured verbatim on the booking: about four shingles
blown off during the last big storm, roof ~14 years old, insurance denied
replacing the entire roof, so repair-only on the damaged shingles.

Two attribution facts were established, and one deliberately was not:

- **Wilder, KY has no page.** No `docs/areas/wilder-ky.html`, no
  `docs/services/*-wilder-ky.html`. Wilder is Campbell County; the built-out
  NKY pages are Covington, Erlanger, Florence and Fort Mitchell. Campbell
  County exists in the CRM only as a permit-fee row (`campbell-ky`, $130, in
  `docs/pro/js/estimate-config.js`). **This was not a geo-landing-page win.**
- **The lead's scenario is already published content.** "Roof too old,
  insurance denied full replacement, wants only the damaged shingles" is
  close to the premise of `/blog/my-roof-is-too-old-will-insurance-still-pay`
  and adjacent to the insurance/storm cluster and `storm-check.html`. This is
  pattern-consistent with the two national inbound leads logged in
  [rush-week-2026-08](../marketing/rush-week-2026-08.md) (the NoVA text, the
  Colorado Springs call).
- **Not established: the actual landing page or query.** GA4
  (`G-8PG7N9Q3DL`, installed site-wide) and Search Console were both
  unreachable from the sandbox. One booking is a sample of one. The
  content-attribution read above is a *pattern*, not a measurement, and was
  reported to Jo as such.

**Do not let this note be cited as proof that the blog produced this lead.**
It is consistent with that; it is not evidence of it.

---

## §2 — The finding: `calcomWebhook` never created leads

Checking whether the lead had reached the pipeline was the first step. Jo
looked: **not there.** Reading `functions/integrations/calcom.js` explained
why, and it was not a delivery failure.

The handler wrote **only** `appointments/{bookingId}`. Its M-1 block
(lines 113–131 at `b7314002`, the pre-fix parent) resolved `leadId` by scanning
`leads where userId == repUid` and matching the attendee's email or last-10
phone digits against leads **already in the rep's pipeline**. A first-time
organic booker matches nothing, so `leadId` stayed `null` — and nothing in
the codebase promoted an orphaned appointment into a lead. There is **no
Firestore trigger on the `appointments` collection**; `grep` for
`onDocumentCreated.*appointment` across `functions/` returns zero hits. The
only readers of `appointments` are `docs/pro/js/smart-calendar.js` (today's
timeline, by `repUid`/`userId`) and `customer-bootstrap.module.js` (by
`leadId`) — neither is the Pipeline.

There are in fact **two** distinct drop points, and which one a booking hit
depends on whether the rep resolved at all:

| Booker | Rep lookup | `leadId` | Appointment doc | Pipeline card |
|---|---|---|---|---|
| Already a lead in the CRM | ok | matched | written, linked | already existed |
| Cold / organic, rep resolves | ok | **`null`** | written, orphaned | **none, ever** |
| **Any booking, `calcomUsername` unset** | **fails** | — | **never written** | **none, ever** |

The third row is the one that almost certainly caught this customer: he booked at
11:35, and Jo did not set `calcomUsername` until later the same afternoon
(§4). With the lookup failing, the handler logs
`no matching rep — booking dropped`, returns 200, and returns **before** the
appointment write — so for that booking neither a lead nor an
`appointments/{uid}` doc exists. (Not verified against prod: the Auth-email
fallback `getUserByEmail(jdeal.tia@gmail.com)` could in principle have
resolved. The backfill tool below handles both states rather than assuming
one.)

Both paths share the property that made this invisible: **nothing errored,
nothing 500'd, nothing logged a failure a human would see.** The webhook
returned `200 {ok:true}` on a booking that produced no CRM record. The
feature whose entire purpose is letting strangers book without talking to Jo
first was the one case it dropped.

---

## §3 — The fix (#1288)

`functions/integrations/calcom.js` — when the M-1 match finds nothing, create
the lead rather than leaving it orphaned. The doc shape deliberately mirrors
the public-lead bridge (`lead-bridge.js` / `lead-bridge-logic.js`) rather
than inventing a parallel schema:

| Field | Value | Why |
|---|---|---|
| doc id | `L.bridgeDocId('calcom', bookingId)` → `calcom__<uid>` | deterministic; `.create()` not `.set()`, so Cal.com's at-least-once redelivery hits `ALREADY_EXISTS` and is caught → links to the existing lead instead of duplicating |
| `userId` / `companyId` | `repUid` / `users/{repUid}.companyId`, solo-op fallback `companyId == uid` | matches the `handlers/auth.js` convention; scopes the Firestore rules read |
| `stage` / `status` | `New` / `new` | lands in the Pipeline's first column |
| `source` | `Website — Cal.com booking` | channel attribution; `webLead: true` |
| `phoneDigits` | `phoneDigits10(phone)` | the canonical transform — so an inbound SMS from this homeowner ties back (`incomingSMS` matches on this key) |
| `publicLeadKind` | `calcom_booking` | provenance, matching the bridge's vocabulary |
| `calcomBookingId` / `calcomEventTitle` | from the payload | back-reference to the booking |

`companyId` is read from the username-lookup snapshot when present, costing
zero extra reads on the common path, and falls back to one `users/{repUid}`
read when the rep was matched by Auth email instead.

Also renamed a shadowing local: the existing match loop declared
`const L = d.data()`, which collided with the new `lead-bridge-logic` import
bound to `L`. Renamed to `leadData`. Harmless today (separate scopes) but a
live trap for the next edit.

`tests/smoke/functions.test.js` — three regression asserts added to the
existing `Cal.com webhook` section, pinning the create-on-no-match branch,
the deterministic id, and the rep-scoping + `phoneDigits` stamping.

---

## §4 — The second, separate issue: `calcomUsername` was unset

Finish-step 2 from the 08-25 audit — NBD Pro → Settings → Profile → Cal.com
username — was still open. Jo set it to `nobigdeal` and saved during this
session (screenshot-confirmed; the field wants the bare username, not the
`https://cal.com/nobigdeal/roof-inspection` URL, and an exact-string compare
means a pasted URL would silently fail to match).

**Both fixes were required, and neither alone was sufficient.** The audit's
wording — "without it bookings arrive but can't attach to Jo" — understates
it twice over: with the username unset, `calcomWebhook` logs
`no matching rep — booking dropped` and returns 200, so the booking is
discarded outright, not merely unattached. And with the username correctly
set, a cold booker *still* produced no lead until #1288 landed. Anyone
reading the 08-25/08-26 notes would have concluded the username was the last
gap. It was not.

---

## §5 — Verification, and the honest limit of it

Repo gates, all on the pre-push tree: `tests/smoke.test.js` **3435/3435**
(3432 before the new asserts) · `check-js-syntax` 471 files ·
`check-inline-html-scripts` 0 violations across 220 files ·
`marketing-polish-contract` 53/53. CI on #1288: **19/19 green**.

Deploy was verified **against the run log, not the check mark** — this repo
has three documented false-green modes
([DEPLOY-FALSE-GREEN-MODES-2026-08-17](../audit/DEPLOY-FALSE-GREEN-MODES-2026-08-17.md)),
and a green "Firebase deploy" alone proves none of them absent:

- Mode 1 (discovery-list drift) ruled out — `calcomWebhook` appears in the
  wave-1 target list at 20:38:59.
- Mode 3 (quota-dropped update, the silent one) ruled out by the terminal
  per-function line: `✔ functions[calcomWebhook(us-central1)] Successful
  update operation.` — and by the completion-accounting guard's verdict,
  **`✓ All 169 targeted function(s) accounted for by a completion line.`**
  with zero straggler-retry rounds. 169 `Successful update operation` lines
  counted in the log.
- Live URL: `https://calcomwebhook-5okp4s3siq-uc.a.run.app`.
- The only deferred function was `onRepSignup` — the known, documented
  GCIP-not-IAM blocker
  ([BLOCKING-TRIGGERS-NOT-GCIP-2026-08-17](../audit/BLOCKING-TRIGGERS-NOT-GCIP-2026-08-17.md)),
  unrelated to this lane.

**What none of that proves:** that the new branch works against real
Firestore. No prod credentials existed in this sandbox — `firebase-tools`
had no auth, the metadata server 502'd, and no read of `leads` or
`appointments` was possible. Every claim about the fix's *behavior* rests on
reading the code and on unit-level asserts, not on an executed booking.
**The proof that matters is still outstanding** (§6.2).

---

## §6 — Open — in priority order

1. **Customer AF is not backfilled yet — the tool exists, the run is Jo's.**
   The fix is forward-only, so his booking (and any other taken while
   `calcomUsername` was unset) still has no CRM record.
   `scripts/backfill-calcom-dropped-leads.js` repairs both drop states from
   §2: it creates the lead, creates the `appointments/{uid}` doc when the
   rep-lookup drop meant one was never written, and links the two. Run it
   dry first — it writes nothing without `--apply --yes`:

   ```bash
   # needs the uid — last path segment of the booking's Cal.com link
   node scripts/backfill-calcom-dropped-leads.js --booking-uid=<uid> \
     --name="…" --email=… --phone=+1… --start=2026-08-29T14:00:00Z \
     --location="…" --notes="…" --organizer-username=nobigdeal
   ```

   Two properties worth knowing before running it: the lead id is
   `L.bridgeDocId('calcom', <uid>)` — the **same** derivation the live
   webhook uses, so a later reschedule of that booking is a no-op rather
   than a second card; and an attendee already in the pipeline is **linked**
   to, never duplicated (same email / last-10-phone rule as M-1). Both
   properties, plus dry-run safety and re-run idempotency, are
   emulator-verified. No customer PII is committed — details are passed at
   run time or pulled from the Cal.com API.
2. **Fire one real test booking post-deploy** through
   `cal.com/nobigdeal/roof-inspection` and confirm a Pipeline card with
   `source: "Website — Cal.com booking"`. This is the only assertion that
   closes the lane; everything in §5 is upstream of it.
3. **Pull GA4 / Search Console for the 08-28 session** to establish what
   actually produced this lead. Until then §1's content read stays a
   hypothesis. Doing this once would also give the two rush-week national
   leads a real attribution instead of a plausible one.
4. **Revoke the 08-25 Cal.com session API key** if it was created without an
   expiry — still carried, still unconfirmed.

---

## §7 — Corrections filed into stale docs (the append-only-rot rule)

Five documents asserted, directly or by omission, that the Cal.com lane was
closed. All were corrected in place this session per the CLAUDE.md standing
rule, each with a dated section rather than a silent edit:

| File | What was wrong |
|---|---|
| [CALCOM-INTEGRATION-2026-08-25](../audit/CALCOM-INTEGRATION-2026-08-25.md) | header claimed "the webhook is LIVE end-to-end"; finish-step 2 still open and mis-described; "deployed and waiting" implied a complete receiver |
| [NEXT_SESSION-2026-08-25](NEXT_SESSION-2026-08-25.md) | "bookings now reach the CRM" — they reached `appointments`, which the Pipeline never queries |
| [NEXT_SESSION-2026-08-26](NEXT_SESSION-2026-08-26.md) | carried the username chore as if it were the whole remaining gap |
| [INDEX.md](../INDEX.md) | "a deployed `calcomWebhook` CRM receiver sat waiting" + "his two finish steps inside", both now false |
| `functions/integrations/calcom.js` | header contract listed a `tasks/{id}` reminder step removed long ago, and never mentioned lead linkage or creation at all — the file's own summary omitted the behavior that decides whether a booking is visible |

---

## §8 — The lesson worth carrying

**A signature probe proves the door opens, not that anything lands behind
it.** The 08-26 verification was real and correct as far as it went —
unsigned POST → 400, HMAC-signed PING → 200 — and it was then written up as
"LIVE end-to-end". Those two probes tested the receiver's front door. They
could not have detected that the handler behind it had no code path to create
a lead, because the failure emits no error: the webhook returns
`200 {ok:true}` on a booking it drops. **Assert the outcome (a Pipeline
card), not the precondition (a 200).**

The same shape twice in one repo now: the deploy pipeline's mode-3 false
green was also a success signal that a thing had *started* being taken for
proof it *finished*. **A guard built on a voluntary signal cannot detect the
case where the system says nothing at all** — and "the receiver is deployed
and waiting" is a claim about a file existing, not about what it does.

Corollary for integrations specifically: **an intake path is only real once a
row appears in the destination collection the UI actually reads.** The
`appointments` collection was written perfectly for weeks while the Pipeline
— which never queries it — showed nothing. Per
[EMAIL-INGEST-2026-08](../architecture/EMAIL-INGEST-2026-08.md) the CRM now
has four lead-creating intakes, not three: web forms, Thumbtack, inbound SMS,
and (as of #1288) Cal.com bookings.

---

**Forward brief:** [NEXT_SESSION-2026-08-28](NEXT_SESSION-2026-08-28.md).
