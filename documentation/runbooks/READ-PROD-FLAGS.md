# Reading the production feature flags

Added 2026-10-13 (Jo: "we need to figure out how to see the prod flags").

The Cloud Functions switch features on and off with environment variables
(`AWAY_MODE_ENABLED`, `TWILIO_INBOUND_ENABLED`, `CARE_PLAN_MODE` ...). The
committed values live in
[functions/.env.nobigdeal-pro](../../functions/.env.nobigdeal-pro) and the
deploy loads them into every function. Before this panel the only way to see
what a function was *really* running with was `gcloud` on a laptop.

## 1. The panel (from your phone)

**CRM -> Settings -> Access -> Live feature flags.** Owner, `admin` and
`company_admin` only; reps and viewers never see it, and the server refuses them.

- Grouped: Calls & texts, Alerts & away, Customer follow-ups, Money, Public
  forms, Experiments.
- Each flag shows an **ON / OFF / PAUSED / TEST** chip, the plain meaning, the
  raw value (`true`, `false`, `unset`, `off`, `live` ...) and the function file
  that reads it.
- "Dark - needs Jo's go" appears on flags that shipped dark and are still OFF
  (away mode, Thursday playbooks, text inbox/notes, Twilio inbound, Care Plan,
  Google Business posting).
- "Deployed file says X, running says Y" appears when the `.env` file bundled
  with the running deploy disagrees with the live environment - which means
  somebody ran `gcloud ... --update-env-vars` (the next deploy will silently
  undo it) or the revision is stale.
- If the read fails the panel says **"Could not load the flags - this is not an
  all-clear."** Treat that as unknown, not as "everything is fine".

How to read the chip: it is *polarity aware*. `*_DISABLED` flags are kill
switches, so `unset` is **ON** (running) and `true` is **PAUSED**. A few
flags (`ESTIMATE_EMAIL_ENABLED`, `LEAD_FOLLOWUP_ENABLED`) run unless set to the
literal `false`; `NBD_MONEY_PAPER`, `NBD_INVOICE_OVERDUE` and
`NBD_CRM_STRIPE_INVOICES` run unless set to `off`. Many `*_ENABLED` flags
mean "off = dry run, logs only", not "nothing happens" - the one-line meaning
on each row says which.

It is **read-only**. There is no toggle. To change a flag, edit
`functions/.env.nobigdeal-pro` in a PR and let it deploy.

## 2. Emergency: gcloud one-liner

If the CRM itself is down:

```bash
gcloud run services describe <functionname-lowercase> --region us-central1 \
  --project nobigdeal-pro --format=json \
  | node -e "const e=JSON.parse(require('fs').readFileSync(0,'utf8')).spec.template.spec.containers[0].env||[];console.log(e.filter(v=>/_(ENABLED|DISABLED|REQUIRED|MODE)$/.test(v.name)||/^NBD_(MONEY_PAPER|INVOICE_OVERDUE|CRM_STRIPE_INVOICES|CONNECT_ALLOW_TEST_MODE)$/.test(v.name)).map(v=>v.name+'='+v.value).join('\n'))"
```

Gen2 service names are the lowercased function name (`awaymodetick`,
`callwatch`, `twiliosms` ...). Every function in a deploy carries the same
dotenv values, so one service is enough. The filter above prints flag names
only - do not paste a raw `describe` anywhere, because secret-bound variables
show up in the same list.

## 3. What the callable returns (and never returns)

`flagStatus` (handlers/integrations.js) returns one row per entry in
[functions/flags-registry.js](../../functions/flags-registry.js) and nothing
else: name, effective value, state, group, file, one-line meaning, doc, dark
hint, deployed-file value and drift. It never returns any other env var; names
containing KEY / SECRET / TOKEN / PASSWORD are refused even if someone adds
them to the registry, and values are reduced to short plain words (anything
else reads `other`).

## 4. Adding a flag

1. Read it in code as `process.env.X_ENABLED` / `_DISABLED` / `_REQUIRED` /
   `_MODE` (or `=== 'off'`).
2. Add a row to `ROWS` in `functions/flags-registry.js` (group, one-line
   meaning, decision doc, `dark: true` if it ships dark). Cron gates also go
   in `functions/cron-gates.js`.
3. Bump the pinned count in `tests/flags-registry-drift.test.js`.

`tests/flags-registry-drift.test.js` fails the build if a flag is read in
`functions/` without a row, or a row names a flag nothing reads.
