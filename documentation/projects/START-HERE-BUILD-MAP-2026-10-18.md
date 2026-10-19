# Start here: how this build is organized (2026-10-18)

Public orientation for anyone (human or AI session) picking up the work. It describes **structure only**. It deliberately contains no account details, vendor lists, security settings, or private operational notes: those are kept outside this repository.

## Read in this order

1. [CLAUDE.md](../../CLAUDE.md) at the repo root: the standing rules and the CI gates that enforce them.
2. [INDEX](../INDEX.md): the home note of this knowledge base; the "Session handoffs" line names the current brief.
3. [QUICK_START](../QUICK_START.md): orientation.
4. [BUILD-PLAN-2026-10-18](BUILD-PLAN-2026-10-18.md): the phased plan, what already exists versus what is new, and the guardrails.

## Where each current feature is explained

| Area | Note |
|---|---|
| Notification policy (tiers, delta-only brief, caps) | [NOTIFICATION-POLICY-2026-10-18](NOTIFICATION-POLICY-2026-10-18.md) |
| Morning brief delta mode | [MORNING-BRIEF-DELTA-2026-10-18](MORNING-BRIEF-DELTA-2026-10-18.md) |
| Company document expiry watcher | [COMPANY-DOC-EXPIRY-2026-10-18](COMPANY-DOC-EXPIRY-2026-10-18.md) |
| Receipt capture and the receipt sorter | [RECEIPT-CAPTURE-AUDIT-2026-10-18](RECEIPT-CAPTURE-AUDIT-2026-10-18.md) and the per-piece `RECEIPT-SORTER-PR*` notes |
| Kentucky claim-wording gate | [KY-CLAIM-WORDING-2026-09-27](../audit/KY-CLAIM-WORDING-2026-09-27.md) |

## How a piece of work is built and tracked

1. A plan or audit note says what and why.
2. One small pull request per piece, from a fresh worktree off current `main`.
3. Each pull request adds a dated note under `documentation/` and links it from `INDEX.md` in the same change (CI-enforced).
4. New behavior ships **dark**, behind a flag that defaults to off, with the turn-on order written in its note.
5. Changes merge through the merge queue. A note's claims are verified against the diff, never trusted alone.
6. Anything that writes to live data is first run as a dry run and read back afterward, on the owner's explicit go-ahead.

## What never goes in this repository

This repository is public. By policy it never holds:

- customer names, contact details, photos, receipts or amounts;
- cost, contractor-price or margin figures;
- credentials, tokens or account identifiers;
- security configurations, filtering or allow/deny rules;
- details of the owner's personal accounts, subscriptions, devices or home network.

Notes that need any of the above are kept private, outside the repo. A session that finds it needs one should ask the owner rather than copy it here.

## Standing guardrails (public summary)

- Drafts only: nothing is sent to a customer automatically.
- Humans enter secrets; automation never does.
- Nothing is permanently deleted by automation: archive or label instead.
- Features ship flagged off, one small change at a time, with tests that can be shown to fail.
- Honest marketing only; Kentucky insurance-job wording rules apply to anything claim-related.
