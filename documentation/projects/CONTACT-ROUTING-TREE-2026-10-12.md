# Contact labels and routing on Today — design (2026-10-12)

Jo's ask, verbatim: *"we should deepen or add further optionality or
complexity to the things today section on the today screen. i think you
should be able to label each contact there and decide - continue screening
this number's calls / tag contractor / sub / customer / personal / etc. also
we should explore a deeper tree of abilities and actions on the same section
to be able to most effectively route each one."*

Status: **design (stage 1) + phase 1 build (stage 2) in the same session.**
Phase 1 = the label registry, the Label sheet on Today call rows, label-aware
"needs you", chips and a filter in the Call Center. Everything else below is
designed so phase 1's data model carries it, and built later. Examples in this
note use fictional numbers (555) only — the repo is public.

## 1. What exists today (inventory, verified on main 8ce45701)

There is **no per-number label registry.** Eight separate classifications
describe a caller and each is written once, by a machine, per call:

| Signal | Values | Written by | Read by |
| --- | --- | --- | --- |
| `bucket` (phone_calls, phone_texts) | customer / insurance / contact / unknown | `call-center-logic.js` `classifyCall` at ingest: number on a lead → customer; contact name matches `CARRIER_RE` → insurance; saved contact → contact; else unknown | `home-attention.js` `callNeedsYou` (insurance + unknown count), `call-center-view.js` filters + chips, `fileTarget` |
| `callType` (AI notes) | customer / insurance / supplier / sub / lead / personal / spam / other | Claude notes pass (`CALL_TYPES`, `sanitizeNotes`) | `callNeedsYou` (spam never; sub/supplier only via a promise), tag-match, sweep email |
| `status` | stored / short / noted / personal / … | ingest + notes; `personal` = the model's verdict, **audio deleted** | `callNeedsYou` (personal never), missed-call rule (`short` + inbound) |
| `notPersonal` | bool | `callCenterAction notpersonal` (re-queues the recording) | notes pass overrides the personal verdict |
| `tags` (from Jo's phone-contact name) | customer / referral / sub / vendor | `parseCubeAcrName` TAGS: "NBD Customer", "NBD Referral", "NBD Sub", "NBD Vendor" | **only `customer`** is read (`taggedNotInCrm`, `matchTaggedContacts`). `referral`, `sub`, `vendor` are stored and never consumed |
| `leadId` / `alternateLeadIds` | lead id | `matchLead` at ingest, `callCenterAction attach/move`, `refileNumber` | everywhere; a number on 3+ leads is a proxy (`PROXY_MIN_LEADS`) and identifies nobody |
| Thursday `caller_type` | new_lead / existing_customer / adjuster / supplier_sub / job_seeker / spam / test / silent | Bland extraction, `thursday-logic.js` `sanitizeExtraction` | `decideRoute` (log-only for spam/test/silent, inbox for job_seeker, loud notify for the rest); `thursday_calls.callerType` |
| `lead.source` / Thursday route label | CANONICAL_SOURCES | lead create paths | reporting only — not a caller classification |

Where "needs you" is decided (and so what a label has to reach):

| Surface | File | Rule |
| --- | --- | --- |
| Home strip "N people need you" | `home-attention.js` `groupNeeds` | THE rule; counts people (`callerKey` = `lead:<id>` else `num:<digits10>`) |
| Today "Calls owed" + "N things today" | `today-plan.js` `buildTodayPlan` | consumes `groupNeeds` output (never re-implements); a lead's calls merge into its Promised row |
| Call Center "Needs attention" + nav badge | `call-center-view.js` | calls `NBDHomeAttention.callNeedsYou` / `groupNeeds` |
| callWatch 2-hourly alert | `functions/call-watch-logic.js` | **server mirror** of `callNeedsYou`/`callerKey`; a test pins the two |
| Thursday live greeting | `thursdayCallerLookup` / `buildLookupResponse` | exactly one non-proxy lead match → first name + stage phrase; nothing else |

Findings that shape the design:

1. Three of the four phone tags Jo already types into his contacts do
   nothing. Labels should *seed from* them rather than ask him again.
2. The only per-number memory is the lead. A contractor, a supplier rep or an
   aunt has no record, so each of their calls is re-sorted by the model and
   can flip between `sub`, `other` and `personal` call to call.
3. `personal` as a model verdict is destructive (audio deleted) and
   per-call. Jo needs a **per-number, non-destructive** "never surface this".
4. There are four places that decide "needs you" and one is server-side. Any
   label rule must live in `callNeedsYou` (and its server mirror) or the
   surfaces drift apart — exactly the failure `calls-need-you-counts-people`
   warns about.

## 2. The label model

**One record per normalized 10-digit number, per company.**

Key: `companies/{companyId}/contact_labels/{digits10}` where `companyId` is the
tenant key the client already stamps (`claims.companyId`, or the solo owner's
uid) — the same key `companies/{cid}/subs/{subId}` uses.

```
{
  digits:      '5550142222',          // == doc id, 10 digits
  kind:        'sub',                 // see KINDS
  policy:      'quiet',               // see POLICIES (derived default, overridable)
  name:        'Pat (roofing sub)',   // optional, <= 80 chars, so a label outlives the call rows
  note:        '',                    // optional, <= 200 chars
  source:      'manual',              // manual | seed-tag | thursday | lead   (provenance)
  companyId, updatedBy (uid), updatedAtMs, createdAtMs
}
```

### Kinds (what the number IS)

| kind | Jo's words | Default policy | Notes |
| --- | --- | --- | --- |
| `customer` | customer | surface | explicit; a lead match is a customer anyway |
| `prospect` | lead / maybe-customer | surface | not on a lead yet |
| `contractor` | contractor | quiet* | another roofer / GC (not our sub) |
| `sub` | sub | quiet* | NBD's independent crews; subs carry their own insurance (never "in-house") |
| `supplier` | vendor / supplier | quiet* | merges the model's `supplier` and the "NBD Vendor" tag |
| `insurance` | adjuster / carrier | surface | counts as `bucket: insurance` even with no CARRIER_RE match |
| `referral` | referral partner | surface | seeds from "NBD Referral" |
| `personal` | personal | hide | family, friends |
| `spam` | spam / solicitor | hide | robocalls, vendors selling to Jo |
| `recruiter` | job seeker / recruiter | quiet | people asking for work |
| `other` | other | surface | explicit "I looked at it" |

\* "quiet" keeps today's sub/supplier behaviour: counted **only** through a
promise Jo made on a call.

### Policies (what the CRM does with calls from it) — the "screening" answer

| policy | Today / Home / badge | Call Center | Notes |
| --- | --- | --- | --- |
| `surface` | normal rules (`callNeedsYou`) | listed, chip | the default for an unlabeled number |
| `quiet` | counts **only** if Jo promised something | listed, chip | "log it, don't nag me" |
| `hide` | **never** counts, promise or not | only under the "Hidden" filter and in All, chip | personal, spam |

Precedence: explicit label **>** lead match **>** AI `callType` / `bucket` /
tags. (A number on a lead is a customer *unless Jo explicitly labels it
otherwise* — e.g. his brother-in-law is a lead and also "personal".)

### What "continue screening this number's calls" can and cannot mean

The CRM does not sit in the carrier path. It sees a call only **after** it
happened (Cube ACR file → Drive → ingest, up to ~30 min later) or as a
Thursday webhook. So:

| Meaning | Can the CRM do it? |
| --- | --- |
| Stop the phone ringing / forward to Thursday / block at the carrier | **No.** Carrier or handset setting. A `spam` label can only *list* the number for Jo to block on his phone |
| Keep Thursday answering this number's calls | **No** (carrier forwarding rule). It *can* change what Thursday is told when she looks the caller up (§6) |
| Keep surfacing this number on Today / the badge / the alert | **Yes** — `surface`. This is "continue screening": the number stays in front of Jo |
| Surface only when it matters (a promise) | **Yes** — `quiet` |
| Stop surfacing | **Yes** — `hide` |
| Keep a record without notifications | **Yes** — every policy keeps the call in the Call Center |
| Skip transcription / notes for it (saves Groq quota, honours privacy) | **Yes, later** — the ingest can read the registry. Phase 3 |
| Auto-reply / auto-text | **No** — and not wanted: no customer-facing send is ever triggered by a label |

**Jo's answer (2026-10-12): "keep surfacing it on Today so I decide."** So
"keep screening this number" means exactly one thing: the CRM keeps showing
that number's calls on Today and in the Call Center and **Jo decides each
time**. It does not mean Thursday answers it, and no carrier forwarding,
auto-reply or auto-text is involved. This is the **default meaning of the
per-number policy** (`surface`). Screening stays **inbound-only** and never
sends. "Let Thursday handle it" and "block" are recorded below as later-phase
options, **not built, not offered in the sheet** (see §9, deferred).

So "continue screening" = policy `surface`; "tag contractor/sub/customer/
personal" = kind. The sheet asks the two questions in that order and
pre-picks the policy from the kind, so one tap is usually enough.

**Screening and blocking are two different things** (the call tools all draw
this line: screening = show who it is and let the owner decide; blocking =
refuse). The CRM only ever does *screening*. Blocking stays a phone/carrier
act; the CRM can at most keep a list (phase 3). The sheet never says "block".

**Keep the sheet small (solo operator).** Seven primary kind chips —
customer, sub, supplier, adjuster (`insurance`), personal, spam, recruiter —
and a "More" row for prospect / contractor / referral / other. Policy is shown
as **two big choices**, "Keep screening" (`surface`) and "Stop surfacing"
(`hide`), with a small third, "Only if I promised something" (`quiet`),
pre-selected for sub/supplier/contractor/recruiter. So the common case is
one tap on a kind; the policy only needs a second tap when Jo disagrees with
the default.

### Patterns borrowed (vendor docs, via a Grok research pass — leads, not facts)

| Pattern (OpenPhone/Quo, Dialpad, Smith.ai, Hiya) | Used here |
| --- | --- |
| Label applied *after* the call, searchable, reusable | Label on the number, chip on every call row, Hidden/label filter in the Call Center |
| Label stays on the call record so the next person has context | `name`/`kind` persist on the registry doc after the call rows age out; chip shows on the row |
| Screening distinct from blocking | Above; no block verb |
| Dismiss an AI suggestion per number so it stops nagging | Seed suggestions get a "Not them" dismiss that writes `dismissedSeed` on the doc (phase 2); a dismissed number is never re-suggested |
| Caller-type playbooks (new lead vs existing client) | The action tree in §4 is the playbook per kind |
| Role-based actions on shared numbers | Rules table in §5; viewer read-only |
| Traps: address-book upload (privacy), TCPA on auto-text | No contact upload — labels are typed per number; labels never cause a customer-facing send |

## 3. Conflict and seeding rules

- **Lead match vs label:** label wins for *policy*, never rewrites the lead.
  A labeled-`personal` number on a lead shows a "On lead: <name>" hint in the
  sheet so Jo knows what he is hiding.
- **Cube ACR tags are a SEED, not an override.** On first sight of a number
  with no label, a tag proposes a *suggested* label (`source: 'seed-tag'`):
  customer→customer, sub→sub, vendor→supplier, referral→referral. A seed is
  shown as a dashed chip with "Confirm"; it **does not hide anything** until
  confirmed (seeds only ever propose `surface`/`quiet` kinds, never `hide`).
  A manual label is never overwritten by a later tag.
- **Thursday `caller_type`** the same: spam → *suggest* `spam`; supplier_sub →
  suggest `supplier`; adjuster → `insurance`; job_seeker → `recruiter`.
  Suggestions only; one tap to accept.
- **Proxy numbers** (on 3+ leads) are never labelable `customer`; the sheet
  refuses and says why (it identifies nobody).
- **Unknown/blocked caller ID** has no digits → no label, row unchanged.
- **Own numbers** (Jo's Thursday line, the CRM sender) are refused.

## 4. The action tree (label × situation)

Row = what Today shows by default; **1-tap** = buttons on the row; **more** =
the ⋯ sheet. ✓ = built in phase 1, others are phases 2–4.

| Label | New call (answered, noted) | Missed call | Voicemail (Thursday) | Text day |
| --- | --- | --- | --- | --- |
| *(unlabeled)* | row; 1-tap: Call, Text, ✓ Handled, **🏷 Label ✓**; more: File on customer, New lead, Mark spam, Not personal | row "missed call"; same | row with Thursday's one-line summary; same + "Call back" | row "texts"; same |
| customer | row (on lead: merges into its Promised row); 1-tap: Call, Open, ✓ | row; Call back | row | row |
| prospect | row; 1-tap: Call, **Make lead**, ✓; more: Snooze 1 wk | Call back | Make lead from voicemail | Reply, Make lead |
| contractor | **quiet**: row only if Jo promised; more: Attach to a job, Ask for COI*, Add to contacts | no row | no row, logged | no row |
| sub | **quiet** (promise only); 1-tap: Open sub profile*; more: Attach to a job, Ask for COI*, Add to roster* | no row | no row | no row |
| supplier | **quiet** (promise only); more: Attach to job (material order), Tag vendor | no row | no row | no row |
| insurance | row (counts even with no lead); 1-tap: Call, **Attach to claim***, ✓ | row | row | row |
| referral | row; 1-tap: Call, Text, ✓; more: "Thank-you task"* (a task, never a send) | row | row | row |
| personal | **hidden**; Call Center "Hidden" filter only | hidden | hidden | hidden |
| spam | **hidden**; more: Block list*, Report* | hidden | hidden | hidden |
| recruiter | **quiet**; more: Send to the careers answer* (a draft only) | hidden unless promised | inbox as Thursday does today | hidden |

\* = needs a later phase (roster/COI/claim attach hooks exist elsewhere in the
CRM; phase 1 only records the label so the action can key off it).

Rules every action obeys: writes only the rep's own records; never sends to a
customer (drafts and tasks only, per the standing bot/comm rules); viewer =
no buttons; on a Kentucky insurance job nothing here adds "we handle the
claim" wording (kentucky-insurance-job-law).

## 5. Data, rules, indexes, audit

**Collection:** `companies/{companyId}/contact_labels/{digits10}` (above).

**Rules** (modelled on `companies/{cid}/subs`):

| Role | read | create / update / delete |
| --- | --- | --- |
| platform admin | yes | yes |
| solo owner (`uid == companyId`) | yes | yes |
| company_admin, manager | yes (own company) | yes (own company) |
| viewer | yes (own company) | **no** (decision B: viewer read-only) |
| sales_rep | **no** (rep never reads teammates' phone numbers — same as `phone_calls`) | **no** |
| other tenant / anon | no | no |

Write shape is validated server-side by the rules: doc id = 10 digits;
`digits == id`; `kind` and `policy` in their enums; string sizes bounded;
`companyId == path companyId`; `updatedBy == auth.uid`; **only the listed keys**
(`hasOnly`).

**Indexes:** none. Reads are the whole (small, equality-free) collection by
path; lookups are by doc id. `firestore.indexes.json` unchanged — and
`emulator-never-enforces-indexes` applies to anything added later: tie it to
that file.

**Client cache:** one `getDocs` of the collection per Today render cycle,
memoised ~60 s; in-memory only. **Not localStorage** — `nbd_`-prefixed keys
are wiped on logout (`client-state-has-hidden-lifetimes`) and a stale label
cache would hide a real customer.

**Audit / undo:** phase 1 = one-step undo (the sheet keeps the prior doc in
memory and restores or deletes) plus `updatedBy/updatedAtMs/source` on the doc.
Phase 2 moves writes behind a `setContactLabel` callable that also appends
`contact_labels/{digits}/history/{autoId}` (who, when, from → to) and runs
side effects (attach, roster) atomically; the client rules stay for the
fallback.

**PII:** the doc id is a phone number, which is tenant data in private
Firestore — same sensitivity as `phone_calls.phoneDigits`. No numbers in
logs, fixtures (555 only), notes or the repo.

## 6. How Thursday consumes labels (phase 4, read-only)

- `thursdayCallerLookup` stays the live greeting. Add one read of the label
  doc by caller digits and **widen the response**, never narrow it:
  `{ known, first_name, job_hint, label_kind }`. Thursday's prompt then
  branches: `sub`/`supplier` → "Hi, this is Thursday for Jo — is this about a
  job?" and take a message rather than run the new-lead script; `personal` →
  short and warm, no intake; `spam` → end politely.
- Minimal disclosure is unchanged: `label_kind` is a coarse enum; no name,
  note or lead data beyond what is already returned. A spoofed caller ID learns
  at most the kind of person the number is (and for `personal`/`spam`, no first
  name).
- `decideRoute` may *downgrade* notify loudness for `quiet`/`hide` numbers
  (log-only) and may *suggest* a label from `caller_type`. It never creates a
  send, a lead or a task that was not already created for that route.
- A label read failure = the greeting proceeds as today (never block).
- Needs the Bland tool/pathway edit (`thursday-bland-wiring`: tools bind only
  via node `data.tools`, owned by the agent) — a separate, owner-approved
  change.

## 7. Failure modes

| Failure | Behaviour |
| --- | --- |
| Offline / write rejected | Optimistic: the row hides at once and the chip shows; on failure the label rolls back, the row **returns**, and a toast says "Couldn't save that label — tap it again" (an honest rollback, not a silent keep). |
| Registry read fails / permission denied (rep) | Treated as **no labels** — every call surfaces under the old rule. Fails open toward showing Jo the call. |
| Label hides a real customer | Home/Today say how many are hidden ("2 hidden — see Call Center"); the Hidden filter lists them with one-tap Unhide; `personal`/`spam` never hide a call that is on a lead without the sheet having told Jo ("On lead: …"). |
| Stale cache in a second tab | 60-s memo + refetch on `nbd:data-refreshed`; worst case a label applies a minute late. |
| callWatch (server) still alerts on a hidden number | **Known phase-1 gap** — the alert mirrors `callNeedsYou` and does not read labels yet. Phase 2 reads the registry in `call-watch.js` and `callNeedsYou`'s mirror test gains the label cases. Until then the push can fire for a number Jo hid. |
| Concurrent edits (two admins) | last write wins; `updatedBy/At` shows who. No merge needed — a label is one small record. |

## 8. Phased plan

| Phase | Scope | Gate |
| --- | --- | --- |
| **1 (built with this note)** | Registry (pure logic + data module), rules + rules tests, Label sheet on Today call rows (kind + policy, one tap, undo), `callNeedsYou`/`groupNeeds` consult labels (Home, Today, Call Center, badge), chips + "Hidden" filter in Call Center | unit + rules tests, 390 px light+dark, no new boot bytes |
| 2 | `setContactLabel` callable + history; callWatch + `callNeedsYou` mirror read labels; seed suggestions (tags, Thursday types) with a confirm chip; Label from the Call Center card; bulk "label these 12 unknowns" | server tests; index check |
| 3 | Actions: attach label→job/claim, sub roster + COI ask, vendor tag, block-list view (a *list* — blocking is on the phone), ingest skips transcription for `hide` numbers | per-action role tests |
| 4 | Thursday consumption (§6), `quiet` downgrades in `decideRoute`, Bland prompt change | Jo approves the prompt; pathway_logs read |

## 9. Decisions for Jo

0. **Start small?** Research on call tools says a solo operator should begin
   with ~7 labels and one on/off policy. The build keeps all 11 kinds in the
   data model but shows only 7 chips plus "More", and two policy buttons plus
   a small "only if I promised". Say if you want it even smaller (hide
   `quiet` entirely and treat sub/supplier as "keep screening" with the
   current promise-only rule).
1. **Kinds list** — is `contractor` distinct from `sub` for you, or one
   "contractor/sub"? Is `recruiter` worth a kind (Thursday already has
   job_seeker)? (Build assumes the 11 above.)
2. **`hide` really means never** — even when you promised something on that
   call? The build says yes for `hide`, promise-only for `quiet`. Safer
   alternative: `hide` also lets a promise through.
3. **Reps:** no read and no write in phase 1 (a rep never sees teammates'
   phone numbers). OK, or should a rep label numbers on their own calls?
4. **Seeds:** auto-propose a label from "NBD Sub / Vendor / Referral" tags and
   Thursday's caller types, shown for one-tap confirm (never auto-applied)?
5. **Personal and the recording:** should a `personal`-labeled number also stop
   the call being transcribed/stored at all (phase 3), the way the AI's
   personal verdict deletes audio today?
6. **Block list (deferred, not built):** the CRM can only *list* numbers to
   block on the phone. Is a "numbers to block" list useful, or skip it?
7. **Thursday for `sub`/`supplier`/`personal` (deferred, not built):** OK to
   change her script for those callers (phase 4), or keep her identical for
   everyone?
8. **"Let Thursday handle this number" (deferred, not built):** would be a
   carrier forwarding rule Jo sets on the phone, which the CRM cannot do. The
   CRM's part would only be to quiet that number's rows. Not offered until you
   ask for it.

**Answered:** screening means "keep surfacing it on Today so I decide"
(Jo, 2026-10-12) — now the default meaning of `surface`.
