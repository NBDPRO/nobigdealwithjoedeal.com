# Build plan v4 — personal, business and home network (2026-10-18)

Status: **locked order, nothing built yet.** Jo chose to lock this on 2026-10-18 after
two Grok critique rounds and a repo cross-check.

## How this plan was made

1. Claude drafted v1 from a brainstorm of everything useful in Jo's personal and
   business life (software, tools, abilities), with a full home-network track.
2. **Grok round 1** (critique of the phase order and tool picks) and **Grok round 2**
   (new skills/agents) ran on grok.com with no personal or customer data sent.
   Grok has no repo access, so its output is **leads, not facts** — every claim below
   is tagged. Mechanics: the grok.com chat is driven through the Chrome extension in
   short typed chunks.
3. A read-only audit of `origin/main`, the office-team tooling in `nbd-ops`, the
   scheduled tasks and the tracker code checked each proposed item against what
   already exists. **Most of Grok's skill ideas already exist.**

Tags: **VERIFIED** = checked against the repo. **LEAD** = unchecked outside claim
(prices, product availability, legal points).

## Ground rules (guardrails)

- Drafts only. Nothing auto-sends to a customer.
- No customer data through free third-party model routers or aggregators.
- Honest marketing only — no invented proof, no fabricated before/afters.
- Kentucky insurance-job wording gate applies to anything claim-related
  (see [KY-OH-CONTRACTOR-LAW-RESEARCH-2026-10-13](../audit/KY-OH-CONTRACTOR-LAW-RESEARCH-2026-10-13.md)).
- Secrets and passwords are never typed into chat.
- Change one thing at a time on the network, with a rollback; never lock yourself
  out of the router.

## What already exists (VERIFIED, do not rebuild)

| Capability | Where it lives |
|---|---|
| Call recordings to CRM notes | `functions/call-center.js`: Cube ACR recordings from Drive, Groq transcription, Claude notes and promise tasks. Text-message ingest is still dry-run. See [CALL-CENTER-2026-10-01](../architecture/CALL-CENTER-2026-10-01.md). |
| Lead follow-up drafting | MCP tools `draft_text`, `draft_email`, `overdue_followups`, `lead_detail`; Agent inbox; smart follow-up panel; 2/5/10-day estimate nudges. |
| Signed-price enforcement | `functions/signed-price.js`; stale deal-room price refused. No side-by-side diff screen. |
| Receipts, mileage, price book | `receipt-vision.js`, `expenses.js`, `hd-import.js`. See [STORE-PRICE-BOOK-PLAN-2026-10-02](STORE-PRICE-BOOK-PLAN-2026-10-02.md). |
| Weekly review | `#/weekreview` page, Sunday scoreboard task, Monday tech check, 6:30am morning brief. |
| Office team | Marcus, Tucker, Quinn, Frank, Theo, Chief of Staff — live, 3x/day, drafts only. |
| Many AI automations | See [AI-AUTOMATIONS-2026-10-04](AI-AUTOMATIONS-2026-10-04.md). |

## Built but off or unmerged (finish or switch on)

- **Missed-call auto-text:** dark; A2P not approved (brand resubmitted around 10-14).
  See [TWILIO-A2P-REGISTRATION](../runbooks/TWILIO-A2P-REGISTRATION.md) and
  [NEVER-FORGET-RELIABILITY-AUDIT-2026-10-12](../audit/NEVER-FORGET-RELIABILITY-AUDIT-2026-10-12.md).
- **Dry-run flags:** weekly digest, anniversary touch, dormant-lead nudge, care plan.
- **Review requests:** email live, auto-text off, Google Business Profile sync waits
  on API access.
- **Storm response:** poller, `storm_near_customers` and Storm Mode exist; no canvass
  priority list by street density.
- **Estimate checks:** margin flags apply to won jobs only; no pre-send check.
- **Claim package:** supplement letter exists; the runtime wording filter is not applied
  to it, and the static wording test excludes `docs/pro/`.
- **Cash flow:** weighted forecast exists; no 30/60/90 buckets.
- **Tracker:** Sunday review, money tab, weight history and food log sit on unmerged
  branches. See [DAILY-TRACKER-REVAMP-PLAN-2026-09-29](DAILY-TRACKER-REVAMP-PLAN-2026-09-29.md)
  and [CALENDAR-HUB-PLAN-2026-09-29](CALENDAR-HUB-PLAN-2026-09-29.md).

## Genuinely new (the real gaps)

1. Own-document expiry watcher (COI, licenses, manufacturer certs, vehicle
   registration, warranties; 30/14/7-day alerts). Only sub certificates are tracked now.
2. Equipment and vehicle maintenance reminders.
3. Per-job permit/code lookup (risk: wrong code claims; verify per jurisdiction).
4. Review-response drafting.
5. Estimate-vs-invoice diff screen.
6. Everything personal and home: subscription auditor, household maintenance,
   health log, personal capture, backups, password manager, home network, HomeNetDoctor.

## Corrections to Grok's advice

- "Pick a phone system before the transcription pipeline": dropped; the recording
  pipeline exists.
- MaterialPriceWatcher by scraping: conflicts with the store-price-book decision (own
  receipts and manual links, no scraping). Extend with price-change alerts instead.
- "Avoid autonomous AI receptionists": Thursday on Bland is already wired; keep a
  human review loop instead of removing it.
- Tailscale is already in use (a scheduled task checks the `nbd-server` host).

## Phases (locked order)

**Phase 0 — Housekeeping and inventory.** Update the stale local checkout (it was 621
commits behind main), merge the tracker branches, decide the dry-run flags, and write a
capability map. Business data inventory plus retention, access and encryption policy
for photos, claims, COIs, contracts and call audio. Tested-restore drill and a "server
died mid-job" card. Price cyber/data-breach liability insurance (LEAD).

**Phase 1 — Unblock value already built.** Finish A2P, then missed-call auto-text.
Turn on the weekly digest and any other dry-run job Jo approves. Apply the claim
wording filter to the supplement letter.

**Phase 2 — Personal security (parallel with 3).** Password manager with passkeys and
hardware keys on Google, iCloud, Firebase, GitHub and Stripe; free credit freezes at
all three bureaus; data-broker removal (Incogni / Optery / DeleteMe, LEAD); Have I Been
Pwned for the two business mailboxes; SIM PIN; 3-2-1 backup with one real restore test;
an emergency "if something happens to me" document.

**Phase 3 — Personal OS (parallel with 2).** Merge and finish the tracker (floors,
Sunday review, money, weight, food). One-tap capture, Espanso, PowerToys, household
lists, maintenance calendar, subscription audit.

**Phase 4 — New business pieces.** Own-document expiry, review responses, 30/60/90
cash buckets, canvass priority list, estimate-vs-invoice diff, equipment reminders.
Photo intake: evaluate CompanyCam as a buy (LEAD) versus extending the existing
classifier and GPS-match tool.

**Phase 5 — Home network core.** Tailscale (already used), one mini-server (N100/N150
16GB class or refurbished micro PC, LEAD), AdGuard Home, three or four networks
(trusted, work, IoT, guest) with real firewall rules (VLANs alone do not isolate),
UPS, offsite backups with a restore drill. Phone hotspot is the failover until proven
insufficient. Router choice (UniFi Cloud Gateway Ultra, OPNsense on a mini-PC, or TP-Link
Omada) waits for Jo's router and ISP details; run one more Grok round then.

**Phase 6 — Extended home network and the rest.** Full VLAN set, local-storage cameras
(exterior microphones off), Home Assistant, LTE failover, paperless-ngx only if paper
volume justifies it, one owner per data type (Immich vs Nextcloud). HomeNetDoctor,
DeviceInventory and FirmwareWatch as local-only reports to Obsidian. Honest content and
SEO work. New skills last, once capture pipelines have run quietly for weeks.

## Avoid

AI SDR / autonomous outreach tools; Jasper / Copy.ai style wrappers; bank-linked
subscription cancelers when a self-hosted tracker (Wallos, LEAD) plus an email scan will
do; tools that fabricate before/afters; free model routers; competitor cloning; AI
influencers; people-search OSINT; AI-detector evasion rewriters.

## Legal leads (confirm with the LegalShield attorney; not legal advice)

- Call recording: Ohio ORC 2933.52 and Kentucky KRS 526.010 are one-party; risk is the
  other party in an all-party state; disclose "may be recorded" as practice (LEAD).
- Camera audio triggers wiretap rules; never aim at private spaces; jobsite cameras
  need customer permission (LEAD).
- A2P 10DLC is a blocking dependency for automated texting; TCPA applies.

## Open questions

- Jo's router, modem and ISP details for Phase 5.
- Which dry-run flags to switch on, and in what order.
- Whether Jo wants the housekeeping merges (tracker branches) done first.
