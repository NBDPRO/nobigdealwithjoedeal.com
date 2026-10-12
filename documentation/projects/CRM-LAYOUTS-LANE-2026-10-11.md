# CRM layouts lane (Track D) — build log, 2026-10-11

Lane "layouts" of the CRM style integration (plan: Grok's Drive docs "NBD CRM
custom layouts" and "NBD CRM design ideas", ordered in the style-integration
roadmap PR #2322). One PR per slice; this note is the running log and the
reference for how the layout system works. Update it in place when a slice
changes a fact below.

## How the system works (D0)

| Piece | Where | Notes |
| --- | --- | --- |
| Registry + precedence rule | `docs/pro/js/layout-system.js` part 1 | Pure; `require()`-able. `LayoutRegistry.register / resolve / surfaceFor` |
| Engine | same file, part 2 | `LayoutEngine.apply / refresh / saveUser / implement`; fires `layoutchange` on `document` (mirrors `themechange`) |
| Pre-paint stamp | `docs/pro/js/shape-preboot.js` (second block) | Reads `localStorage nbd_layout_resolved` and stamps `<html data-layout>` / `data-tap` before first paint |
| `--tap` token | `docs/pro/css/layout-system.css` | 56px default, 64px with `data-tap="glove"` |
| User setting | `userSettings/{uid}.layout` | `{ id, byDevice:{phone,tablet,desktop}, layoutState:{<id>:…}, glove }`, merge write, `null` clears a device override |
| Company default / lock | `companies/{companyId}/settings/layout` | `{ defaultLayout, defaultByDevice, allowed, locked }` (rules + UI arrive in D2) |

**Precedence (Jo's rule):** locked company layout > the user's choice > company
default > Classic. A layout is only ever picked for a surface it supports
(phone <= 768px, tablet = touch <= 1180px, else desktop). A lock whose pick
cannot show on this screen resolves to Classic, never to the user's choice.
`allowed` hides layouts from the user's choice and the company default but never
hides Classic.

**Classic** is today's dashboard, unchanged: registered with no script and no
stylesheet. Nobody's experience changes unless they, or their admin, choose
another layout.

### Things a future layout author must know

- **Layout stylesheets scope under `html[data-layout="<id>"]`.** The preboot
  writes the sheet as a parser-inserted `<link>` from `<head>` (so first paint is
  not unstyled), which means it lands *before* the base styles in the cascade.
  The attribute prefix is what wins the specificity fight.
- **Lazy assets by convention:** `js/layouts/<id>.js` calls
  `LayoutEngine.implement('<id>', { mount(ctx), unmount(ctx) })`;
  `css/layouts/<id>.css` is linked only while that layout is active.
- **No new script tags.** `tests/dashboard-boot-budget-2026-10-03.test.js` is a
  ratchet: the preboot rides inside the existing blocking `shape-preboot.js`,
  and registry + engine are ONE deferred file. D0 made one deliberate raise
  (+1 local tag, +24 KB), recorded in that test.
- **The budget test measures bytes with LF on CI.** On Windows with
  `core.autocrlf=true` it reads ~90 KB high and fails locally on a clean
  `origin/main` too; compute LF-normalised sizes before believing it.
- `nbd_layout_resolved` is in the `KEEP` set of `purgeAccountStorage()` (a
  device UI preference, no account data) so a sign-out does not flash Classic on
  the next sign-in; `nbd_layout_prefs` is not, and is purged per account.
- A boot read can answer from Firestore's empty local cache; the engine retries
  `fromCache` misses and, when a read *fails*, keeps the cached company lock
  rather than dropping it.

## Shared components (D1)

`docs/pro/js/layouts/kit.js` + `css/layouts/kit.css` (`window.NBDLayoutKit`),
loaded lazily and only by a layout that lists them in `needs`:

```js
LayoutRegistry.register({ id: 'field', script: 'js/layouts/field.js', css: 'css/layouts/field.css',
  needs: { script: ['js/layouts/kit.js'], css: ['css/layouts/kit.css'] } });
```

| Component | What it is |
| --- | --- |
| `card(item, {density})` | LeadCard as `row` / `card` / `hero`; one normalised item from `fromLead(lead, {why, timeLabel, badge})` |
| `actionBar(item, ids, opts)` | Call / Text / Navigate / Open are plain `tel:` `sms:` maps and customer links; Snooze / Photo / Done are `data-lk-act` buttons. An action with nothing to link to renders **disabled**, not a dead anchor |
| `widget({title, size, state, body})` | size contract `1x1`..`4x2`, loading / empty / ok states |
| `nav('bottom', items, active)` | bottom tab bar; an item with `raised: true` is the camera button |
| `bind(root, handlers, lookup)` | ONE delegated click listener; handler > `LeadSnooze.prompt` > bubbling `nbd:layout-action` event |

Everything returns an escaped HTML string. Nothing sends anything: Call and
Text open the phone's own dialer / composer and the rep presses Send there.

**Finding (verified 2026-10-11):** Grok's layouts doc says to wire ActionBar
"once to customer-quick-actions.js". That file exists but is the customer-page
header's collapse-to-"More" helper, not an action API; there is nothing to wire
to. The ActionBar defines the actions once instead, from the same primitives.

## Layout picker and company lock (D2)

Settings > Appearance > **Layouts** panel (`#layoutsPanel` in dashboard.html;
`js/layouts/picker.js` + `css/layouts/picker.css` load lazily the first time the
Appearance tab is actually displayed, so a Classic rep never pays for them).

- **Device toggle** (Computer / Tablet / Phone): choices are stored per device
  in `userSettings.layout.byDevice`. A cleared override is written as `null`.
- **Try it (30s)**: previews on this screen without saving; a bottom bar offers
  Keep or Revert and reverts by itself when the time is up.
- **Glove mode** flips `--tap` to 64px (`userSettings.layout.glove`).
- **Company default / lock** (owner or company_admin; `details` block in the
  panel): a default per device, which layouts the team may pick, and Lock.
  Stored at `companies/{companyId}/settings/layout`. Rules: the tenant reads;
  the solo owner or a company_admin of that company writes; manager / rep /
  viewer / another tenant cannot; shape-checked; no other doc id under
  `settings`. Section 61 of `tests/firestore-rules.test.js` (27 checks, with
  the negative controls; break-tested by letting a manager write).
- A **locked** layout wins over the user's choice, and the picker says so and
  disables Use / Try it. A lock whose pick cannot show on this screen resolves
  to Classic, not to the user's choice.
- The Settings view is a `<template>` hydrated on navigation and shows a panel
  with `style.display` (the `dn` class stays on it) — the lazy loader looks at
  computed display, not the class. Found the hard way in the E2E.
- E2E: `tests/e2e/layouts.spec.js` (@shard2): Classic + `--tap`, picker, try /
  revert / keep, reload brings the layout back before the app's scripts run,
  glove, and a company lock through the real picker and rules.

## Field App (D3) — L08

`js/layouts/field.js` + `css/layouts/field.css`, registered in layout-system.js for
**phone and tablet only** (never resolved for a desktop window; the picker can
still preview it). Needs the D1 kit. It is a shell over what the CRM already
has — not a copy:

| Screen | Built from |
| --- | --- |
| Today | `NBDToday.compute()` appointments (today-home.js, #2137); weather from `api.weather.gov` (CSP-allowed, keyless, cached an hour); the storm cache line (`NBDTodayPlan.stormLine`) as the hail check. A big **Now** card with Navigate / Call / Photo, "Up next" rows, and "Done · next" |
| Lead | name, a plain "Why you are here" line from the visit type, four tiles (Test square / Call / Text / Voice note via `NBDQuickCapture`), a 3-item checklist (per account, per day), and a **slide-to-confirm** "I'm on site" that needs >= 90% travel; it writes a `leads/{id}/activity` note (`type 'note'`, `source 'rep'`, `channel 'field-app'`, lat/lng/accuracy) |
| Capture | `getUserMedia` camera, a 10x10 test-square overlay, slope chips (S W N E Ridge Soft metals), +/- counter with `navigator.vibrate`, and shots through the **existing** durable queue: `PhotoEngine.enqueueForRetry` + `flushUploadQueue` (the 'photos' ScriptLoader bundle is loaded when the camera opens — `photo-engine.js` is not an eager tag). Offline shows "No signal · N queued" |
| Sunlight | `html.sun`: black on white, 2.5px outlines; only colour custom properties + `--fa-bw`; id-boosted selector so no theme/mode selector out-ranks it; device preference `nbd_field_sun` (in the sign-out KEEP set) |

Decisions and gotchas worth keeping:

- **Kentucky wording.** The counter reads "N hits counted in this square ·
  example guide: 8 (your carrier sets the real number)". The photo description
  is "Test square, S: 3 hits counted in 10 ft x 10 ft". Nothing says we handle
  or negotiate a claim or predicts an outcome; `tests/layout-field-2026-10-11.test.js`
  runs every string through `claim-wording-filter.js` (with a control that it can fail).
- **Nothing is sent.** Call and Text are `tel:` / `sms:` links; the only
  network call of its own is the weather forecast.
- **No `<header>` elements in layouts** — `dashboard-app.css` styles every
  `header` as the app's dark top bar (it painted an unreadable band on Today).
- Not built (and why): the geofence auto-switch to sunlight and the phone light
  sensor (optional in Grok's spec; a geofence needs background GPS, which a PWA
  does not get), route distance / "home by" (no data source), the gate code (no
  such lead field today). The Map tab opens the existing D2D map.
- E2E: `tests/e2e/field-app.spec.js` at 390px with a fake camera: Now card
  links, 56px tap targets, short slide stamps nothing / full slide writes the
  note, offline shot is held then drains into a `photos` doc tagged
  `test_square`, sunlight tokens and persistence.

## Focus Mode (D4) — L03

`js/layouts/focus.js` + `css/layouts/focus.css`, every surface. The pure half
(`NBDFocusLogic`: `buildQueue`, `whyNow`, `draftFor`) is require()-able and
unit-tested; the screen half is an overlay on Home like the Field App.

- **Queue** = `NBDToday.compute()` rows (appointments, promised, calls, estimates,
  stalled follow-ups) ranked by a rule table; a person appears once. Order:
  appointment within 3h > you promised > overdue task > urgent call > missed
  call > texted you > task due today > opened estimate > follow-up (most late
  first) > quiet estimate > later appointments.
- **Why now** is the same rule table's wording (no AI). **Drafted text** is by
  rule, short, no insurance / claim / price / outcome words (tested against
  `claim-wording-filter.js`); Text is an `sms:` link with the draft, the rep
  presses Send in the composer.
- **Done · Next** completes a promised row's tasks through `NBDTasks.setDone` (what
  Today's Done does). Every other row is only SET ASIDE on this device for the day
  and the button says **Next**, and the wrap-up says it was not changed in the CRM.
  (today-home.js's own `act` needs its painted `last` plan, which exists only when
  Home is mounted, so it is not reusable from an overlay.)
- Keys: arrows move, C call, T text, S snooze, D next. Ignored inside inputs.
- Glass card only behind the My Skin wallpaper class; solid surface otherwise.
- E2E `tests/e2e/focus-mode.spec.js`: queue number, why-now, draft, 56px targets,
  set-aside leaves the lead's follow-up untouched, menu leads to the pipeline.

## Slice log

| Slice | Status | PR |
| --- | --- | --- |
| D0 layout foundation | built, in review | #2328 |
| D1 shared components | built, stacked on D0 | #2331 |
| D2 picker + company default/lock | built, stacked on D1 | #2344 |
| D3 Field App (L08) + sunlight | built, stacked on D2 | #2349 |
| D4 Focus Mode (L03) | built, stacked on D3 | see PR list |
