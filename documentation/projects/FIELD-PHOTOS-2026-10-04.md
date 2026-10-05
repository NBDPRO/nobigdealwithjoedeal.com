# Field photos lane — 2026-10-04

Branch `feat/field-photos`. Jo approved all seven items. What changed, how
it works, and what to check after deploy.

## Why

Audit (2026-10-04): 111 owner photos, 109 of them bulk-imported in April,
so only 2 had come in through the CRM since; 4 of 259 leads had photos;
0 After photos; the AI classifier had run on 1 photo; 0 photos had a
geolocation. Causes, each checked on main before changing it:

- the CRM camera (`photo-engine.js` `openCamera`) opened a 26-tag
  Review & Tag sheet after every shot and restarted the camera;
- `phase` came only from a tag the rep picked per shot;
- `geoLocation: null` was hard-coded in `uploadPhotoToFirebase`;
- photo-editor saves wrote straight to Storage + Firestore with no queue;
- the classifier ran only when the in-app camera / customer uploader called
  the `analyzePhotoVision` callable;
- the inspection report's "Save report to database" box shipped unticked;
- the measurement adapter (Instant Roofer) only ran when a rep pressed
  Auto-measure (2 measurements ever).

## What it does now

| # | Item | Where |
|---|------|-------|
| 1 | **Burst capture** (default). The shutter only shoots: camera stays open, running count, last-shot thumbnail. Each shot is enqueued in the durable IndexedDB queue BEFORE any network, then drained one at a time behind the shutter (`_saveBurstShot`, `_kickDrain`). A **Burst / Tag** chip switches back to the per-shot tag sheet (remembered in `localStorage.photoEngineCaptureMode`). Closing after a burst shows "N photos saved" + **Tag in Photo Review**. | `docs/pro/js/photo-engine.js` |
| 2 | **Phase from the stage** at capture: before contract → Before, `install_in_progress` → During, `install_complete` or later → After; custom stages → no phase. A phase tag wins (`phaseSource: 'tag'`), stage phases carry `phaseSource: 'stage'`, Photo Review counts a stage phase as reviewed only once the photo has a location, and a tag edit that names no phase keeps the stage phase. **Before & After report** builds itself when a lead moves onto `install_complete` (`stage-write.js` → `NBDAutoBeforeAfter` in `photo-report.js`): rendered, filed in the lead's Documents (`autoBeforeAfter: true`), no viewer opened. With no After photo yet it flags `beforeAfterReportPending` and builds 20 s after the first After photos land. Once per lead (`beforeAfterReportAt`). | `photo-engine.js`, `pages/photo-review.js`, `stage-write.js`, `photo-report.js` |
| 3 | **GPS + time.** One `getCurrentPosition` per camera session (reused for 2 min across the tag flow's reopen). Each photo stores `capturedAt`, `geoLocation {lat,lng,accuracy,at}` and `onSite` (true within **75 m** of the lead's lat/lng; null when the fix is vaguer than 150 m or the lead has no coordinates). The inspection report prints "Oct 4, 2026 · 2:14 PM · On-site" under each photo (client templates + `inspection.hbs`) — never coordinates. CRM doc only: the portal projects explicit fields; canvas captures carry no EXIF. | `photo-engine.js`, `inspection-report-engine.js`, `functions/print/templates/inspection.hbs` |
| 4 | **Photo editor.** Save Tags / Save / Save Copy go through `PhotoEngine.enqueueEdit` (same IndexedDB queue; row `capture.edit`, drained by `_applyQueuedEdit`). Save Copy pins its doc id at enqueue, so retries make one copy. Daylight layer (`.nbd-daylight` in `photo-editor.css`): text ≥ 13 px, targets ≥ 44 px, near-white on near-black; default stroke 6 px; no inline style attributes (swatches coloured by CSS). | `photo-editor.js`, `photo-editor.css`, `photo-engine.js`, `photo-queue-store.js` (`capture` field) |
| 5 | **Instant Roofer auto-order** when an appointment is created for a lead or the lead reaches Inspected. Once per lead (transaction marker + `measurements/auto-<leadId>` via `create()`), daily/monthly caps (defaults 6 / 60; override `feature_flags/global.autoMeasureDailyCap` / `autoMeasureMonthlyCap`), kill switch `autoMeasureDisabled`. Uses the web-lead path (`measureLeadAndPublish`) and asks for the outline image, saved to `docs/{owner}/measurements/{leadId}-outline.png`. **Draw tool** shows a cross-check card (vendor roof sf / squares / pitch vs the drawn pitched area, ±10 % = close) with the outline image. **V3 wizard** measure step has **Draw it on the map** (hands address + lead to the Draw view). | `functions/integrations/measure-auto-order.js`, `public-measure.js`, `measurement.js`, `instantroofer-logic.js`, `docs/pro/js/draw-measure-check.js`, `estimate-v3-wizard.js` |
| 6 | **Inspection reports**: the box is ticked by default, and every generated report is filed on the lead's Documents as a generated HTML doc (`documents/{uid}/{leadId}/insp-*.html`, re-opened through `getDocumentHtml`; no token URL). | `inspection-report-engine.js` |
| 7 | **AI tagging for every photo**: `onPhotoCreatedClassify` (Firestore trigger on `photos/{photoId}`) runs the same `classifyPhoto` core as the callable — same caps, cache, `aiDisabled` switch — skipping annotated copies and classified docs; an in-flight claim (`aiClassifyClaimAt`, 2 min TTL) stops the two doors paying twice. Captions pass `functions/photo-caption-safety.js` (drops any sentence about insurance / claims / coverage / deductibles), fresh and cached. | `functions/photo-vision.js`, `functions/photo-caption-safety.js` |

## Dependency: PR #2142

PR #2142 adds `docs/pro/js/claim-wording-filter.js` (the full KY rule set
as a client runtime filter over report strings). It was **not merged** when
this lane was built. The server-side caption filter here does not depend on
it (that file is under `docs/` and not part of the functions deploy); once
#2142 merges, its `_claimSafe` also runs over captions in the report
engines. Expect a text conflict in `inspection-report-engine.js` with #2142
— both edit `_generateAndOpen`'s neighbourhood.

## Not done / left alone

- `draw-reticle.js` `CROSSHAIR_DEFAULT_ON` untouched (waits on Jo's daylight test).
- `nbd-auth.js`, `sw.js`, the D2D photo upload path and the knock queue are
  the `fix/offline-safety` helper's. Door-knock photos are not `/photos` docs
  (they live on `knocks/{id}.photoUrls`), so the classifier trigger reaches
  them once a knock becomes a lead's photo, not before.
- The Instant Roofer outline is a picture, not geometry: it cannot be laid
  over the Leaflet map, so the cross-check is numbers + image side by side.

## Check after deploy

1. One burst on a real phone: count ticks, photos appear with Before/During/After matching the stage.
2. `firebase functions:log --only onPhotoCreatedClassify` — `photo-vision.trigger.skip` reasons are sane; spend stays under the caps.
3. Move a test lead to Inspected → `measurementAutoOrders/lead_<id>` status `ordered` and the outline file under `docs/<uid>/measurements/`.
4. Generate an inspection report → it appears in the lead's Documents.

## Tests

- `tests/field-photos-client-2026-10-04.test.js` — photo-engine loaded whole in a vm (Firebase stubbed), photo-report, inspection engine, draw cross-check, V3 hand-off.
- `tests/field-photos-server-2026-10-04.test.js` — classifier trigger + caption filter + auto-order + outline, with an in-memory Firestore.
- `tests/e2e/phone-field-photos.spec.js` — 390 × 844 installed-app mode: burst with a fake camera stream, editor target / text sizes.
