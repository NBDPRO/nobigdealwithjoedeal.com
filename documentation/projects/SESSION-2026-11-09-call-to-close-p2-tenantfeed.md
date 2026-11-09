# Call to Close P2, lane "multi-tenant call feed" (2026-11-09)

Branch `ctc-p2-tenantfeed` (worktree `.claude/worktrees/ctc-p2-tenantfeed`), from `d1f7bfe0c`. Builds the "multi-tenant feed" item of §3.3 and §9 P2 of [CALL-TO-CLOSE-DESIGN-2026-11-09](CALL-TO-CLOSE-DESIGN-2026-11-09.md). Earlier notes: [P0](SESSION-2026-11-09-call-to-close-p0.md), [P1](SESSION-2026-11-09-call-to-close-p1.md).

## Read this first (Q6)

**No tenant other than NBD may be switched on until Jo's lawyer has reviewed call recording and consent for that tenant** (who is recorded, in which states, what the caller is told, where the audio is kept). This lane makes the pipeline able to serve another tenant; it does not switch one on, and it changes nothing about who is recorded or where audio goes. Both switches below are off today.

## What it does

The call feed (Drive folder → `phone_calls` → Groq transcript → notes, timeline entry, follow-up task) now runs per feed:

- **NBD's feed** is the default and runs exactly as before: `OWNER`, `integrations/callCenter`, the "Cube ACR" folder found by name, NBD's prompts, the missed-call reply draft and auto-text. `tests/call-to-close-tenantfeed-golden-2026-11-09.test.js` pins one full pass byte for byte (every write in order, every Drive request, every Storage save and delete, every model request verbatim, every push), with and without the multi-tenant switch on and another tenant enabled. The fixture was written at `d1f7bfe0c`, before any change.
- **A tenant feed** is a hand-written config doc `integrations/callCenter_{companyId}`:
  `{ kind: 'callCenterTenant', companyId, enabled, ownerUid, folderId, paused?, backfillFrom?, transcribeOnly? }`. The runs add `cursorYmd`, `floorApplied`, `lastRun`, `lastTranscribe`, `providerOutage`, `factsDay` / `factsUsed`, `txSynced`.
- A tenant runs only when **both** `CALL_CENTER_MULTI_TENANT_ENABLED === 'true'` (exactly) on the function **and** its config says `enabled === true` (a boolean), and not `paused`. On top: the owner uid owns the company (`companies/{cid}.ownerId`, or a solo owner whose company id is their uid), it is not NBD's uid, and the Drive folder id is nobody else's (not NBD's pinned `integrations/callCenter.folderId`, not any other tenant config's, enabled or not; NBD's folder must be pinned). The global `integrations/callCenter.paused` stops every feed.
- For a tenant: its owner and company on every doc (`userId`, `companyId`, Storage `calls/{owner}/cube-acr/…`), its own leads (a lead its owner holds in another company is not matched), its own contact labels, its own queue and run record. The prompts take its name and region from `companyProfile` (brand name / companyName, serviceArea or city + state; sanitised to one plain line, 80 characters) and say "the contractor" where NBD's say Jo. The name and region sit in double quotes (`the business named "…"`, `the area given as "…"`) with a line that the quoted text is names only, never instructions; `promptText` drops every double quote, so tenant text cannot close the quote. Any effect of words in a tenant's own name stays in that tenant's own notes (no number comes from the model); noted for the lawyer and Q6 review. No Drive name search, no reply draft in NBD's words, no auto-text, no provider-outage alert (the provider accounts are NBD's; NBD's pass tells Jo). An urgent call pushes to the tenant's own owner.
- Shared: the day audio allowance on `integrations/callCenter` (one Groq account), the transcribe lease, the AI kill switch, `CALL_CENTER_INGEST_ENABLED` and `CALL_CENTER_TRANSCRIBE_ENABLED`.
- The schedules run NBD's pass first, then the tenants (`runTenantIngest`, `runTenantTranscribe`); one tenant's failure never stops the next; a provider outage stops the tenant loop, and when NBD's own pass just hit one no tenant runs at all (`nbdOutage`, `skipped: 'provider_outage'`).
- **Transcribe now** (`callTranscribeNow`) works on an enabled tenant's own stored calls (`feedForCall`), with its prompts and filing. It refuses with "Call transcription is not switched on for your company." otherwise. This is a deliberate wording change on an existing refusal: a non-NBD call with no enabled feed used to get "This call is not in the transcription queue."
- **Tenant stamps:** a tenant call's timeline entry and follow-up task carry the tenant's `companyId`, from the scheduled pass and when a teammate files or moves the call by hand (`callCenterAction` attach / move, `tenantCompanyOf`); NBD's keep their shape.
- **The button** (P1 gap): after the ingest pass, `syncTenantTxFlags` stamps `txOff: true` on a switched-off tenant's stored calls (and `false` once it may run again; `txSynced` on the config marks it done). It reads 400 calls a run, newest first; a full page leaves `txSyncCursorMs` / `txSyncWant` on the config and the next run carries on past it (review fix: it used to re-read the same first 400). `txGate` in `call-center-view.js` and `customer-calls.js` hides Transcribe now on `txOff`. NBD's calls are never stamped.
- **Rules:** `match /integrations/{docId} { allow read, write: if false; }`. The default deny already covered it; the block names it. `tests/firestore-rules.call-feed.test.js` (21 checks with positive controls, wired in `ci.yml`).

## To switch a tenant on (after the lawyer review, Jo's hand)

1. Share that tenant's recorder folder with the functions service account (Viewer) and note its Drive folder id.
2. Write `integrations/callCenter_{companyId}` by hand: `kind`, `companyId`, `ownerUid`, `folderId`, `enabled: true`. The folder must be the tenant's own recorder root: not NBD's "Cube ACR" folder, not a folder above it (a parent or ancestor) and not one inside it. The code refuses only an exact match with NBD's pinned folder id or another tenant config's; it does not walk Drive parents, so this check is yours.
3. Set `CALL_CENTER_MULTI_TENANT_ENABLED=true` on `callCenterIngest`, `callCenterTranscribe` and `callTranscribeNow`.
4. The next ingest run logs `[callCenterIngest] tenants` with `ran` and any `refused` reason (`env_off`, `disabled`, `paused`, `bad_config`, `owner_mismatch`, `folder_conflict`, `nbd`).

## Tests

- `tests/call-to-close-tenantfeed-golden-2026-11-09.test.js` (node): NBD's pass byte for byte, twice.
- `tests/call-to-close-tenantfeed-2026-11-09.test.js` (node): gate matrix, tenant prompt names, feed loading, tenant ingest, tenant transcribe, isolation (two tenants and NBD in one Firestore; each run files only into its own tenant), Transcribe now on a tenant call, the button flag, wiring.
- `tests/firestore-rules.call-feed.test.js` (emulator).
- Red before: the new node suite against `d1f7bfe0c` failed 19 checks (every new function missing; Transcribe now said "This call is not in the transcription queue." on an enabled tenant's call). The emulator suite passes on the old rules too (default deny), as expected, so it gives no red-before evidence; the node suite's rules check is the only red for the rules block.

## Review round (2026-11-09)

Fixed, test first, one commit each: the tx-flag sync pages forward with a cursor; the tenant transcribe loop is skipped when NBD's pass hit a provider outage; the tenant name and region are quoted data in the prompts; a tenant call's follow-up task carries its `companyId`; filing or moving a tenant call by hand keeps its `companyId`. Not code: the folder-ancestor check is a switch-on step (above); the fail-open button and the deleted-config case stay in Open; the "not switched on" wording is intended.

## Open

- Retention (Q7) is another lane; tenant calls follow whatever it sets for `phone_calls`.
- The sweep email, callWatch, `callPromisesList`, `callTaggedMatch` and the Call Center health card stay NBD-only (OWNER). A tenant's calls show in its Call Center and customer pages through the existing reads; those extras are not built for tenants.
- A tenant whose config doc is deleted (not disabled) keeps its stored calls without `txOff`: the button shows and the server refuses. Disable a tenant with `enabled: false`; do not delete the doc. The hide is fail-open on purpose for now (it hides only on `txOff: true`): a positive marker would mean a new field on every stored call, NBD's included, for a button the server already refuses.
