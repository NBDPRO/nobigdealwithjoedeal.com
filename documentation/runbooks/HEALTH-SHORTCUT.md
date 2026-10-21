# HEALTH-SHORTCUT — Apple Health weight into the Daily Success tracker

Shipped **dark** on 2026-10-20 (research idea #9 in
[TRACKER-IDEAS-RESEARCH-2026-10-20](../projects/TRACKER-IDEAS-RESEARCH-2026-10-20.md)).
An iPhone Shortcut reads the day's weight from Apple Health (Hume and Active
Era both write there) and POSTs it to a small endpoint; the weight lands in
that day's tracker page by itself. No third-party app, and no server of ours
ever holds Apple Health credentials: the Shortcut runs on the phone.

Code: `functions/health-shortcut.js` + `health-shortcut-logic.js`; card:
`docs/pro/daily-success/js/health-shortcut-ui.js`; tests:
`tests/health-shortcut-2026-10-20.test.js`, `health-shortcut-ui-2026-10-20.test.js`,
`firestore-rules.health-shortcut.test.js`.

## Turn it on (Jo, in the Firebase console — Claude cannot write prod flags)

1. Deploy happens by the normal merge to `main`. Until the next step the
   endpoint answers **404 to everyone** and the tracker shows no card.
2. Firebase console → Firestore → collection `system` → document
   `healthShortcut` (create it) → field `enabled` = boolean `true`.
   (A string `"true"` does not count.)
3. Open the tracker on the phone → the dashboard shows **⌚ Apple Health
   weight** → **Create Shortcut key** → copy the key → follow the steps on the
   card (they are written for the Shortcuts app, tap by tap).
4. First test: tap Play in Shortcuts, then look at the card: it shows the
   weight, the date and what the server did with it.

Turn it off for everyone at any time: set `enabled` to `false` (or delete the
doc). Emergency stop without a console edit: set the function env
`HEALTH_SHORTCUT_DISABLED=true` and redeploy.

## What it does with a reading

POST `{date:'YYYY-MM-DD', weightLbs:185.2, sleepHours?:7.5}` with
`Authorization: Bearer <key>`.

- Weight 60-700 lb (the range `weightSeries` already uses), a real date from
  400 days ago to 2 days ahead, body under 512 bytes, JSON only, POST only.
  Anything else is a generic 400.
- Writes only `data['bm-wt']` (plus an `hw` marker and the change stamp `mt`)
  on that day's page under `users/{uid}/ds_pages`, so the phone's newer-`mt`-wins
  sync picks it up on its next load. Every other field on the page is left alone.
- **Hand-typed weight is never overwritten.** An empty weight box takes the
  reading; a weight that is exactly what this endpoint last wrote takes a newer
  reading (last one wins, so a second weigh-in the same day replaces the first);
  anything else is treated as typed by hand and kept. The response says
  `hand_entered`.
- **A deleted day stays deleted.** If every page for that date is a tombstone
  the reading is skipped (`deleted`) and nothing is recreated. To bring the day
  back, weigh in by hand there.
- No page for the date: one is created in the client's own shape (`suf` 1,
  empty KPIs).
- **Sleep is not stored in v1.** The day page has no sleep-hours field (the
  Sleep floor is a checkbox), so `sleepHours` is validated and discarded.
- Rate limits: 20 requests per 10 minutes per IP, 10 an hour per key, 50 a day
  per user.

## Threat model (short)

| Threat | Control |
|---|---|
| Guess a key | 256 random bits; per-IP limit before any lookup; 401 for every bad key with no detail |
| Steal the database | only SHA-256 of the key is stored (`health_shortcut_keys/{hash}`, `health_shortcut_state/{uid}`); both denied to every client by rules and proven in `firestore-rules.health-shortcut.test.js` |
| Leaked key | writes one number for one user, bounded by the limits above; Rotate or Turn off deletes the lookup doc in the same transaction, so the old key dies at once |
| Key in logs/URLs | only the Authorization header carries it; handler never reads the query string; logs hold the 6-character uid prefix, status and date only (test pins it) |
| Wrong data in | strict validation; a unit mix-up (kg) is the one thing it cannot catch: set Health → Weight → Unit to lb (step 1 on the card) and glance at the card after the first run |
| Clobbering Jo's data | merge of one field; hand-typed wins; deleted stays deleted |
| Browser abuse | no CORS headers, POST only |

Known limit: a weight typed on the phone while it is offline, with an edit time
older than the server's write, can lose to the server copy on the next sync
(newer `mt` wins). In practice sync runs two seconds after a save.

## Rotate / revoke

Card → **Rotate key** (tap twice) shows a new key once; paste it into the
Shortcut's Authorization header. **Turn off** (tap twice) deletes the key.
