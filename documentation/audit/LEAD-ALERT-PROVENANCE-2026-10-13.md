# Lead-alert provenance hardening (2026-10-13)

Scope: `functions/lead-alert.js` (`leadAlertCalcom`, `alertJoe`),
`firestore.rules` `match /leads/{leadId}` create. Branch
`fix/lead-alert-calcom-auth`.

## What was wrong

`leadAlertCalcom` is a Firestore trigger on every `leads/{leadId}` create. It
decided "this is a Cal.com booking, page the alert contacts" from fields on the
document (`publicLeadKind: 'calcom_booking'`, `webLead: true`). Those fields
were not server-owned: the `leads` create rule lets any signed-in non-viewer
create a lead in their own tenant with arbitrary extra fields. The alert is
sent on NBD's Resend domain and Twilio number, so a client-authored document
could cause NBD-branded email/SMS to go to whatever contacts the tenant had
configured, with client-chosen text.

## What changed

1. **Trigger provenance** (`planLeadsDoc`): a Cal.com booking alerts only when
   the doc id is exactly `calcom__<calcomBookingId>`, the id the webhook mints
   (`integrations/calcom.js`) from the same booking id it stamps on the doc.
   Same idea as `isBridgedThumbtackLead`. The backfill skip is evaluated first,
   so its log line is unchanged.
2. **Rules** (`leadCreateHasNoServerFields` + create clause): a client create
   may not carry `publicLeadKind`, `publicLeadCollection`, `publicLeadId`,
   `webLead`, `calcomBookingId`, `backfilledBy`, and may not use a doc id that
   starts `calcom__` or `thumbtack_leads__`. Admin-SDK writers are unaffected.
   Updates are untouched (the trigger is create-only).
3. **Per-tenant ceiling** (`alertJoe`): a non-NBD tenant's email/SMS alerts are
   capped at `TENANT_ALERT_DAILY_CAP` (60) per rolling day through the existing
   `rate-limit.js` `enforceRateLimit` pattern. Over the ceiling the CRM lead and
   the tenant's own push are unchanged; the outbox row records
   `skipped:rate-limited`. NBD's own leads are never capped. A limiter error
   fails open (a dropped lead alert costs a customer; a missed cap costs one
   message).

## Proof

- `tests/lead-alert-calcom.test.js` sections (g) and (h): stubbed Resend /
  Twilio / push only (no real sends). Each absence assertion has a positive
  control (the same document at the webhook id DOES alert). Against
  `origin/main` the five forged-booking assertions go red; with the fix they
  pass.
- Break tests (mutate the fix, confirm which assertion reddens): removing the id
  check reddens the "client-minted id" / "different booking" / "stamped with
  NBD's tenant" assertions; making email or SMS ignore the cap reddens "alert
  number 61 sends no email and no SMS"; capping NBD reddens "an NBD lead never
  touches the tenant limiter"; failing closed on limiter error reddens "a
  limiter outage fails OPEN".
- `tests/firestore-rules.test.js` section 63: 3 controls allow, 9 forged shapes
  deny. Against `origin/main` rules the 9 denies go red.

## Not covered here (follow-ups, owner decision needed)

The alert contact addresses a tenant configures are still unverified, and other
send paths bind their recipient less tightly than this one. Those are larger
design changes (a verification flow and a migration for existing tenants) and
were reported to Jo in the session rather than detailed in this public file.
The per-tenant ceiling above bounds the damage in the meantime.
