# Portal key-moment emails: how to turn them on

2026-11-04. Customer portal plan, Phase 5 (`functions/portal-moments.js`).
**Shipped dark.** Nothing goes to a homeowner until Jo turns on all three switches below.

## What it sends

Each email sends once per job. The build-day email sends once per build date, so a moved date gets one more.
Every email carries the homeowner's project-page link.

| Moment | When | Subject |
|---|---|---|
| Booked | A Cal.com inspection booking lands (`appointments` create, `source: calcom`, `status: booked`, a lead attached, in the future) | Your inspection is booked: here is your project page |
| Build day set | A signed job gets a build date, or the date moves | Your build day: Tuesday, November 10 |
| Job done | The job reaches the final walkthrough step | The work at your home is done |

The wording lives in `MOMENT_COPY` in `functions/portal-moments.js`, the only place it is written. It has no claim, carrier or adjuster words and no "our team".

## The gates (every one fails closed)

1. **Env flag** `PORTAL_MOMENT_EMAILS_ENABLED=true` on the `portalMomentOnLead` and `portalMomentOnBooking` functions. It is checked before any read, so a dark trigger costs nothing.
2. **The automation switch.** `messaging_controls/automations.portalMomentEmail` must be `true`, along with the customer master switch and the email switch. All three are in the Messaging Center, on the row "Portal key-moment email".
3. **NBD jobs only.** The sender is Joe's own address. Tenants need their own sender before this can speak for them.
4. **Unsubscribe.** The address must not be on the suppression register, and NBD's postal address must be set. Every email gets List-Unsubscribe headers and the footer (`email-suppression.js gateCommercialEmail`).
5. **Per-recipient cap.** At most 3 a day.
6. **One-time claim.** `portal_moment_sends/{lead}_{moment}_{key}` is created *before* the send. A redelivered trigger or a second save can never send twice. A failed send stays `failed` for a person to look at; it is never retried into a duplicate.

## Turning it on

1. Set the env flag on the two functions. Claude cannot write production flags, so Jo does this step.
2. In the Messaging Center, turn on "Portal key-moment email". Leaving canary on sends the first ones to Jo instead of the homeowner.
3. Check one with the Cloud Logging query `jsonPayload.message="portal_moment_sent"`, or read `portal_moment_sends` for its `status`.

## The link

An existing live portal link with at least 7 days left is reused. Otherwise a fresh 30-day link is minted through `functions/portal-token-mint.js`, the same writer the CRM's portal button now uses.
