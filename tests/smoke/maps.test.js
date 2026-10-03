/**
 * tests/smoke/maps.test.js — Hail overlay on D2D + Pipeline badge,
 * Storm Briefing automation, large-view extractions for photos +
 * admin templates.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, PRO_JS, FUNCTIONS, read, readCrm, readD2DLive, readMaps } = require('./_shared');

module.exports.run = function run(ctx) {
  const { assert, section } = ctx;

section('UI-D: Hail overlay on D2D + Pipeline badge');
{
  // Step 5 (2026-05-17): legacy docs/pro/js/d2d-tracker.js was deleted
  // (not loaded by any HTML; split into d2d-tracker-{core,ui}-2026b.js +
  // d2d-tracker-2026b.js in step 4f). Use readD2DLive() to grep the
  // post-split surface for showHail / hideHail / _d2dHailLayer.
  const src = readD2DLive();
  assert('D2D exposes showHail', /showHail:\s*async/.test(src));
  assert('D2D exposes hideHail', /hideHail:\s*\(\)\s*=>/.test(src));
  assert('Hail button rendered in map controls',
    /data-d2d-action="toggleHail"/.test(src));
  // Step 4b: buildCard (which renders the hail badge) lives in
  // crm-pipeline.js post-split — concat via readCrm() so the
  // assertion finds the pattern.
  const crm = readCrm();
  assert('Kanban card renders hail badge when hailHit.sizeInches present',
    /l\.hailHit && l\.hailHit\.sizeInches/.test(crm));
}

section('D2D delegate registry — data-d2d-action ⇄ window.D2D shim contract');
{
  // The document-level click delegate (d2d-tracker-ui-2026b.js) resolves
  // data-d2d-action names ONLY through window.D2D, which is composed from an
  // explicit export list in d2d-tracker-2026b.js. A helper that exists on
  // window._D2DState but is missing from the shim renders a button that
  // silently no-ops ('[d2d] no dispatch'). 2026-07-06: the hot-lead
  // conversion prompt's three buttons + toggleHail + dismissFollowupsBanner
  // were all dead this way.
  const shim = read(path.join(PRO_JS, 'd2d-tracker-2026b.js'));
  for (const name of [
    'convertToLeadAndDismissPrompt',
    'convertToLeadWithEditAndDismissPrompt',
    'dismissConvertPrompt',
    'toggleHail',
    'dismissFollowupsBanner',
  ]) {
    assert('D2D shim exports ' + name,
      new RegExp('^\\s*' + name + ':\\s*state\\.' + name + ',', 'm').test(shim),
      'expected `' + name + ': state.' + name + ',` in the window.D2D literal');
  }
  // General contract: every action name rendered in the tracker sources must
  // be a key in the shim's window.D2D literal. Skip comment lines so the
  // delegate's own `data-d2d-action="methodName"` doc example doesn't count.
  const rendered = new Set();
  for (const shard of ['d2d-tracker-core-2026b.js', 'd2d-tracker-ui-2026b.js', 'd2d-tracker-2026b.js']) {
    for (const line of read(path.join(PRO_JS, shard)).split('\n')) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      for (const m of line.matchAll(/data-d2d-action="(\w+)"/g)) rendered.add(m[1]);
    }
  }
  const missing = [...rendered].filter(name => !new RegExp('^\\s*' + name + ':', 'm').test(shim));
  assert('every rendered data-d2d-action has a window.D2D export (found ' + rendered.size + ' actions)',
    missing.length === 0,
    'dead buttons — rendered but not exported by the shim: ' + missing.join(', '));
}

section('Phase C.3 — large-view extractions (photos + admin)');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  for (const v of ['photos','admin']) {
    assert('view-' + v + ' is an empty mount with data-view-template (C.3)',
      new RegExp('<div class="view" id="view-' + v + '"\\s+data-view-template="tpl-view-' + v + '"></div>').test(dash),
      'expected mount div for view-' + v);
    assert('<template id="tpl-view-' + v + '"> exists',
      new RegExp('<template id="tpl-view-' + v + '">').test(dash),
      'expected tpl-view-' + v + ' template element');
  }
  // Spot-check Wave 2C.2 shutter FAB survived the photos extraction —
  // it moves INTO the template so the CSS selector
  //   #view-photos.active > .m-shutter-fab
  // matches once the template is cloned at hydration time.
  assert('tpl-view-photos contains the m-shutter-fab as a direct child',
    /<template id="tpl-view-photos">[\s\S]*?<button class="m-shutter-fab"/.test(dash),
    'expected the Wave 2C.2 shutter FAB to live inside tpl-view-photos');
  // adminCreateModal + adminEditModal stay top-level (sit OUTSIDE
  // view-admin, independently toggled by AdminManager). Check that
  // the admin template's body doesn't contain adminCreateModal.
  {
    const tplStart = dash.indexOf('<template id="tpl-view-admin">');
    const tplEnd = dash.indexOf('</template>', tplStart);
    const adminTplBody = dash.slice(tplStart, tplEnd);
    assert('adminCreateModal stays top-level (outside tpl-view-admin)',
      /<div id="adminCreateModal" class="modal-overlay"/.test(dash)
      && !/id="adminCreateModal"/.test(adminTplBody),
      'expected adminCreateModal to remain top-level, not inside the admin template body');
  }
}

section('Phase B.2 — Storm Briefing automation');
{
  const sb = read(path.join(ROOT, 'functions/integrations/storm-briefing.js'));
  const idx = read(path.join(ROOT, 'functions/index.js'));
  assert('storm-briefing module exists with onDocumentCreated trigger',
    /exports\.stormBriefing_onAlertSent\s*=\s*onDocumentCreated/.test(sb),
    'expected stormBriefing_onAlertSent registered');
  assert('storm-briefing module guards SLACK_WEBHOOK_URL secret',
    /SECRETS\.SLACK_WEBHOOK_URL/.test(sb),
    'expected SLACK_WEBHOOK_URL declared as a secret on the trigger');
  assert('storm-briefing uses atomic sentinel to dedup',
    /storm_briefings_sent\/\$\{alertId\}/.test(sb)
    && /runTransaction/.test(sb),
    'expected dedup via storm_briefings_sent sentinel + runTransaction');
  assert('storm-briefing scoring exports for unit tests',
    /exports\._test\s*=\s*\{[\s\S]*scoreLead/.test(sb),
    'expected scoreLead exported via _test');
  assert('functions/index.js registers stormBriefingIntegration',
    /stormBriefingIntegration\s*=\s*require\('\.\/integrations\/storm-briefing'\)/.test(idx)
    && /Object\.assign\(exports,\s*stormBriefingIntegration\)/.test(idx),
    'expected index.js to require + Object.assign stormBriefingIntegration');
  // Static checks on the ranking contract — STAGE_WEIGHTS table + the
  // shape of scoreLead. We don't require() the module here because it
  // depends on firebase-functions which isn't in tests/node_modules.
  assert('STAGE_WEIGHTS ranks early-stage > install_in_progress',
    /STAGE_WEIGHTS\s*=\s*\{[\s\S]{0,1500}new:\s*1\.00/.test(sb)
    && /install_in_progress:\s*0\.10/.test(sb),
    'expected new=1.00 and install_in_progress=0.10 in STAGE_WEIGHTS');
  assert('recencyWeight returns 1.00 for leads ≤30 days old',
    /if \(ageDays <= RECENT_LEAD_DAYS\) return 1\.00/.test(sb),
    'expected recencyWeight to cap at 1.00 for the recent window');
  assert('storm-briefing composes a Slack briefing with leadCount + topLeadIds',
    /leadCount:\s*scored\.length/.test(sb)
    && /topLeadIds:\s*scored\.slice\(0, BRIEFING_LEAD_LIMIT\)\.map/.test(sb),
    'expected the storm_briefings_sent sentinel to carry leadCount + topLeadIds for Viktor');
}

section('Customers map layer — all leads on the map, role-coloured');
{
  const maps = readMaps(); // includes maps-customers.js via MAPS_SPLIT
  // The layer builds from the company-scoped CRM book, not the userId-scoped
  // door-knock _pins, so the whole team's customers show.
  assert('Customers layer builds from window._leads',
    /function buildCustomersLayer[\s\S]{0,400}window\._leads/.test(maps),
    'expected buildCustomersLayer() to iterate window._leads');
  // The stage dimension classifies by the LIVE pipeline role (window.stageRole)
  // so it matches the kanban and honours a tenant's custom stages; the legend +
  // dots share the role palette for consistency.
  assert('stage dimension classifies via window.stageRole',
    /function _custRoleOf\(lead\)[\s\S]{0,200}window\.stageRole/.test(maps)
    && /catOf:\s*_custRoleOf/.test(maps),
    'expected the stage dimension catOf to resolve the role via window.stageRole');
  // Rolling geocode-backfill: lazy, fair-use capped, and PERSISTED so a lead
  // is only ever geocoded once.
  assert('Customers layer persists geocoded coords via _saveLeadCoords',
    /window\._saveLeadCoords\(lead\.id/.test(maps),
    'expected the backfill to call window._saveLeadCoords to persist lat/lng');
  assert('Customers layer respects a live-geocode fair-use cap',
    /_CUST_GEOCODE_CAP/.test(maps) && /liveRequests\s*>=\s*_CUST_GEOCODE_CAP/.test(maps),
    'expected a per-build geocode cap like the Jobs overlay');
  // Wired into the generic overlay toggle path.
  assert('toggleOverlay routes the customers layer',
    /type==='customers'[\s\S]{0,120}showCustomersLayer\(\)[\s\S]{0,40}hideCustomersLayer\(\)/.test(maps),
    'expected toggleOverlay to show/hide the customers layer');
  assert('overlayState seeds a customers flag',
    /overlayState\s*=\s*\{[^}]*customers:\s*false/.test(maps),
    'expected overlayState to include customers:false');
  // Legacy customer pins must no longer trust the dead static STAGE_COLORS map
  // for post-migration/custom stages.
  assert('addPinMarker colours customer pins via the live engine',
    /p\.type === 'customer'[\s\S]{0,400}window\.STAGE_META/.test(maps),
    'expected addPinMarker() to colour customer pins from window.STAGE_META');
  // Clusters at low zoom (like the D2D pins) so a big book stays readable.
  assert('Customers layer clusters when markerClusterGroup is available',
    /L\.markerClusterGroup === 'function'[\s\S]{0,120}L\.markerClusterGroup\(/.test(maps)
    && /L\.layerGroup\(\)/.test(maps),
    'expected _ensureCustomersLayer() to prefer L.markerClusterGroup with a layerGroup fallback');
  // Control panel: color-by, legend/filter, cross-dimension AND filters.
  assert('Customers panel offers color-by dimensions (stage/damage/value/rep)',
    /_CUST_DIM_KEYS\s*=\s*\['stage',\s*'damage',\s*'value',\s*'rep'\]/.test(maps)
    && /data-cust-colorby/.test(maps),
    'expected a color-by selector over stage/damage/value/rep dimensions');
  assert('dot colour follows the active color-by dimension',
    /function _custColorOf\(lead\)[\s\S]{0,200}_CUST_DIMENSIONS\[_custColorBy\]/.test(maps),
    'expected _custColorOf to resolve via the active color-by dimension');
  assert('filters compose across dimensions (AND)',
    /function _custPasses\(lead\)[\s\S]{0,260}for \(const dk of _CUST_DIM_KEYS\)[\s\S]{0,160}return false/.test(maps)
    && /if \(!_custPasses\(lead\)\) continue;/.test(maps),
    'expected _custPasses to AND every dimension filter and gate the build');
  assert('damage + value dimensions normalise lead fields',
    /function _custDamageKey\(lead\)/.test(maps) && /function _custValueKey\(lead\)/.test(maps),
    'expected damage-type and value-tier categorisers');
  assert('zoom-gated $ labels bloom past the label zoom',
    /_CUST_LABEL_ZOOM/.test(maps)
    && /labelMode && v > 0/.test(maps) && /💰/.test(maps)
    && /zoomend[\s\S]{0,200}buildCustomersLayer\(\)/.test(maps),
    'expected a $ value pill icon past _CUST_LABEL_ZOOM, rebuilt on zoomend');
  assert('panel filter keeps at least one category per dimension',
    /f\.size > 1[\s\S]{0,30}f\.delete\(cat\)/.test(maps),
    'expected the chip toggle to never empty a dimension filter');
  assert('panel is CSP-safe (delegated listeners, no inline handlers)',
    /_custPanelEl\.addEventListener\('click'/.test(maps)
    && /_custPanelEl\.addEventListener\('change'/.test(maps),
    'expected delegated click + change listeners on the panel');
  // Value-range slider — min/max $ filter, live readout on input, commit on change.
  assert('value-range slider filters by min/max deal value',
    /function _custValRangePasses\(lead\)/.test(maps)
    && /return _custValRangePasses\(lead\);/.test(maps)
    && /data-cust-valmin/.test(maps) && /data-cust-valmax/.test(maps),
    'expected a value-range filter gated in _custPasses with min/max range inputs');
  assert('value-range readout updates live on input (no rebuild mid-drag)',
    /_custPanelEl\.addEventListener\('input'/.test(maps)
    && /read\.textContent = _custValLabel\(_custValMin\)/.test(maps),
    'expected an input listener that updates the readout without a full rebuild');
  // Saved views — TEAM-SHARED: persisted to companyProfile.mapViews (read by
  // all, write by owner/admin), snapshot/apply the whole panel state.
  assert('saved views are team-shared via companyProfile.mapViews',
    /window\._companyProfile && window\._companyProfile\.mapViews/.test(maps)
    && /_saveCompanyProfile\(\{ mapViews: v \}\)/.test(maps)
    && /function _custSnapshot\(\)/.test(maps) && /function _custApplyView\(v\)/.test(maps),
    'expected saved views backed by companyProfile.mapViews + snapshot/apply helpers');
  assert('saved-view save/delete gated to owner/admin (everyone can apply)',
    /function _custCanEditViews\(\)/.test(maps)
    && /canEditViews[\s\S]{0,120}data-cust-saveview/.test(maps),
    'expected _custCanEditViews to gate the save/delete controls');
  assert('saved views wired: apply on select, save + delete buttons',
    /data-cust-view/.test(maps) && /data-cust-saveview/.test(maps) && /data-cust-delview/.test(maps),
    'expected a view select + save/delete controls');
  // Rep / owner — a DYNAMIC color-by dimension (cats computed from lead owners).
  assert('rep/owner is a dynamic color-by dimension over lead owners',
    /rep:\s*\{ label: 'Rep \/ Owner', catsFn: _custRepCats/.test(maps)
    && /_CUST_DIM_KEYS = \['stage', 'damage', 'value', 'rep'\]/.test(maps)
    && /function _custRepCats\(\)[\s\S]{0,300}window\._leads/.test(maps),
    'expected a rep dimension whose categories are the distinct lead owners');
  assert('dynamic dimensions resolve cats via _dimCats',
    /function _dimCats\(dim\)\s*\{\s*return dim\.catsFn \? dim\.catsFn\(\)/.test(maps)
    && /_dimCats\(dim\)\.forEach/.test(maps),
    'expected _dimCats() used wherever a dimension enumerates categories');
  assert('rep names are best-effort (Me / team maps / short uid)',
    /function _custRepName\(uid\)[\s\S]{0,300}window\._user[\s\S]{0,200}'Me'/.test(maps),
    'expected _custRepName to label the current user Me and fall back gracefully');
  // Route optimizer — nearest-neighbor over the currently-filtered stops.
  assert('route optimizer orders filtered stops nearest-neighbor from map centre',
    /function _custRoutableStops\(\)[\s\S]{0,200}_custPasses\(l\)/.test(maps)
    && /function _custNnOrder\(start, pts\)/.test(maps)
    && /mainMap\.getCenter\(\)/.test(maps),
    'expected _custRoutableStops (filter-aware) + _custNnOrder from the map centre');
  assert('route draws a polyline + numbered stop markers, capped',
    /L\.polyline\(latlngs/.test(maps)
    && /_custNumIcon\(i \+ 1\)/.test(maps)
    && /_CUST_ROUTE_CAP/.test(maps),
    'expected a dashed polyline, numbered markers, and a stop cap');
  assert('route toggle wired in the panel',
    /data-cust-route/.test(maps) && /toggleCustomerRoute\(\)/.test(maps),
    'expected a Route button wired to toggleCustomerRoute');
  // Field-ready: start from the rep's GPS (fall back to map centre) + hand off
  // to Google Maps for turn-by-turn.
  assert('route starts from GPS with a map-centre fallback',
    /function _custResolveStart\(\)/.test(maps)
    && /navigator\.geolocation\.getCurrentPosition/.test(maps)
    && /const start = await _custResolveStart\(\)/.test(maps),
    'expected _custResolveStart to prefer geolocation and buildCustomerRoute to await it');
  assert('route hands off to Google Maps directions (origin/dest/waypoints/driving)',
    /google\.com\/maps\/dir\/\?api=1/.test(maps)
    && /destination=/.test(maps) && /&waypoints=/.test(maps) && /travelmode=driving/.test(maps)
    && /_CUST_GMAPS_WP_CAP/.test(maps),
    'expected _custGmapsUrl to build a directions URL capped at Google’s waypoint limit');
  assert('Open-in-Maps button shows only while a route is active',
    /_custRouteOn[\s\S]{0,80}data-cust-gmaps/.test(maps)
    && /openRouteInGmaps\(\)/.test(maps),
    'expected the gmaps hand-off button gated on _custRouteOn');
}

section('D2D pins — disposition legend + filter (second layer)');
{
  const maps = readMaps();
  // A disposition filter panel over the pins layer (PIN_LABELS categories).
  assert('pins layer renders a disposition filter panel',
    /function renderPinDispPanel\(\)/.test(maps)
    && /nbd-pin-panel/.test(maps)
    && /Object\.keys\(PIN_LABELS\)/.test(maps)
    && /data-pin-disp/.test(maps),
    'expected renderPinDispPanel() with a chip per PIN_LABELS disposition');
  // Filter hides/shows pin markers via the cluster group; status-less pins pass.
  assert('pin disposition filter shows/hides markers via applyPinDispFilter',
    /function applyPinDispFilter\(\)[\s\S]{0,200}pinMarkers\[p\.id\]/.test(maps)
    && /function _pinPassesDisp\(p\)[\s\S]{0,120}_pinDispFilter\.has\(p\.status\)/.test(maps),
    'expected applyPinDispFilter to gate each pin marker by _pinPassesDisp');
  assert('status-less (customer/legacy) pins always pass the disposition filter',
    /if \(!p \|\| !p\.status\) return true;/.test(maps),
    'expected pins without a status to bypass the disposition filter');
  assert('pins panel filter keeps at least one disposition + drops to no-filter when all on',
    /_pinDispFilter\.size > 1[\s\S]{0,30}_pinDispFilter\.delete\(st\)/.test(maps)
    && /_pinDispFilter\.size === all\.length[\s\S]{0,30}_pinDispFilter = null/.test(maps),
    'expected the pins chip toggle to never empty and to clear when all-on');
  assert('pins panel is CSP-safe (delegated listener)',
    /_pinPanelEl\.addEventListener\('click'/.test(maps),
    'expected a delegated click listener on the pins panel');
  // Wired into the pins overlay toggle + initial load.
  assert('toggleOverlay shows/hides the pins disposition panel',
    /overlayState\.pins[\s\S]{0,120}renderPinDispPanel\(\)[\s\S]{0,80}hidePinDispPanel\(\)/.test(maps),
    'expected the pins toggle to render/hide the disposition panel');
}

section('Customers map layer — dashboard.html wiring');
{
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const maps = readMaps(); // for the window.nbdRepList export check below
  // maps-routing.js moved off the static eager chain (2026-09-14,
  // boot-weight containment — see documentation/audit/BOOT-WEIGHT-2026-09-06.md).
  // The remaining three siblings stay in their locked static order; routing
  // is checked separately below, in script-loader.js's `drawtool` bundle.
  assert('dashboard.html loads maps-customers.js between overlays and maps.js (locked static order)',
    /maps-overlays\.js[\s\S]{0,300}maps-customers\.js[\s\S]{0,200}maps\.js/.test(dash),
    'expected the customers module in the locked core→overlays→customers→maps order');
  assert('maps-routing.js is NOT a static tag on dashboard.html (lazy since 2026-09-14)',
    !/<script\s+defer\s+src="js\/maps-routing\.js/.test(dash),
    'expected maps-routing.js to load only via ScriptLoader\'s drawtool bundle');
  const scriptLoader = read(path.join(PRO_JS, 'script-loader.js'));
  // 2026-09-25 (draw lane L1): draw-geom.js (window.NBDDrawGeom, the pure
  // geometry/totals module) rides the same bundle and must load FIRST, so
  // maps-routing.js can call it from its first line once L2 wires it in.
  assert('script-loader.js defines a drawtool bundle: draw-geom.js, then maps-routing.js',
    // An optional leading stylesheet (css/maps-routing-view.css, 2026-10-03)
    // loads before either script so the panels are styled on first paint.
    /drawtool:\s*\[\s*(?:'css\/[\w-]+\.css\?v=\d+',\s*)?'js\/draw-geom\.js\?v=\d+',\s*'js\/maps-routing\.js/.test(scriptLoader),
    'expected BUNDLES.drawtool to list draw-geom.js immediately before maps-routing.js');
  assert("the 'draw' view resolves both mapvendor and drawtool",
    /draw:\s*\['mapvendor',\s*'drawtool'\]/.test(scriptLoader),
    "expected VIEW_BUNDLES.draw = ['mapvendor', 'drawtool']");
  assert('Customers overlay toggle rendered',
    /data-action="mapOverlay"\s+data-target="customers"/.test(dash),
    'expected a Customers overlay-row toggle');
  // Territory zones shaded by rep (session-only zones; assignment + colour).
  assert('zone panel has a rep assignment select',
    /id="zoneRepSelect"/.test(dash),
    'expected a #zoneRepSelect in the zone panel');
  const actions = read(path.join(ROOT, 'docs/pro/js/dashboard-actions.js'));
  assert('zones populate reps from the shared palette (window.nbdRepList)',
    /function _populateZoneReps\(\)/.test(actions) && /window\.nbdRepList\(\)/.test(actions),
    'expected _populateZoneReps to read window.nbdRepList');
  assert('saveZone shades the zone in the assigned rep colour + labels it',
    /getElementById\('zoneRepSelect'\)/.test(actions)
    && /getAttribute\('data-color'\)/.test(actions)
    && /rep:\s*repKey,\s*repLabel/.test(actions),
    'expected saveZone to colour by the rep data-color and store rep/repLabel');
  assert('maps-customers exposes the shared rep palette as window.nbdRepList',
    /window\.nbdRepList\s*=\s*_custRepCats/.test(maps),
    'expected window.nbdRepList = _custRepCats');
  const widgets = read(path.join(ROOT, 'docs/pro/js/dashboard-widgets.js'));
  assert('zone list shows the assigned rep label',
    /z\.repLabel \? [\s\S]{0,80}esc\(z\.repLabel\)/.test(widgets),
    'expected renderZoneList to render z.repLabel');

  // Zones are now PERSISTED + team-shared (Firestore /zones), not session-only.
  const boot = read(path.join(ROOT, 'docs/pro/js/dashboard-bootstrap.module.js'));
  assert('zones have Firestore CRUD (load/save/delete) with companyId stamping',
    /async function loadZones\(\)/.test(boot)
    // Globals Tranche 3 T3-C (2026-09-18): _saveZone/_deleteZone are real
    // declarations registered in __NBD_CALL_REGISTRY now, not window.X = ...
    && /async function _saveZone\(data\)/.test(boot) && /async function _deleteZone\(id\)/.test(boot)
    && /_saveZone: _saveZone/.test(boot) && /_deleteZone: _deleteZone/.test(boot)
    && /collection\(db,'zones'\)/.test(boot)
    && /zoneDoc\.companyId = \(window\._userClaims\?\.companyId\) \|\| _uid/.test(boot),
    'expected loadZones/_saveZone/_deleteZone against /zones with companyId stamped');
  assert('zones load at boot alongside pins',
    /loadPins\(\); loadZones\(\)/.test(boot),
    'expected loadZones() called in the boot sequence');
  assert('saveZone persists (serialized points) + renderSavedZones draws loaded zones',
    /_nbdReg\._saveZone\(\{ name, color: fillColor, points: pts/.test(actions)
    && /function renderSavedZones\(\)/.test(actions)
    && /window\.renderSavedZones = renderSavedZones/.test(actions),
    'expected saveZone to persist serialized points (via the registry) and a renderSavedZones() to draw window._zones');
  assert('map init draws persisted zones',
    /renderSavedZones==='function'\) window\.renderSavedZones\(\)/.test(maps),
    'expected initMainMap to render saved zones');
  const rules = read(path.join(ROOT, 'firestore.rules'));
  assert('/zones rule is team-shared (mirrors /pins)',
    /match \/zones\/\{zoneId\}[\s\S]{0,900}sameCompanyAsResource\(\)[\s\S]{0,900}request\.resource\.data\.companyId == myCompanyId\(\)/.test(rules),
    'expected a /zones rule with same-company read + companyId-pinned create');
  // Audit fix: /pins + /zones UPDATE must freeze provenance (companyId) so an
  // owner can't repoint their doc into a victim tenant's shared map.
  assert('/pins + /zones update freezes userId/companyId (didNotChange)',
    // 2026-09-25: the owner branch may now be wrapped as `((isOwner(..) && notViewer())`.
    (rules.match(/allow update: if \(\(?isOwner\(resource\.data\.userId\)[\s\S]{0,220}didNotChange\(\['userId', 'companyId'\]\)/g) || []).length >= 2,
    'expected both /pins and /zones update rules to guard didNotChange([userId, companyId])');
  // Zone insights — point-in-polygon aggregation of the leads inside a zone.
  assert('zones show insights (point-in-polygon leads → count/$ /roles/damage)',
    /function _pointInPolygon\(lat, lng, poly\)/.test(actions)
    && /function _zoneInsights\(zone\)/.test(actions)
    && /_bindZoneInsights\(layer/.test(actions),
    'expected _pointInPolygon + _zoneInsights bound to the zone layer');
  assert('Customers map FAB rendered',
    /id="fab-customers"[\s\S]{0,120}data-arg="customers"/.test(dash),
    'expected a Customers map FAB wired to fabToggle');
}

section('Map heat + pins toggle + mobile');
{
  const maps = readMaps();
  // Heat weighted by money/intent, not a flat constant.
  assert('heat layer weights points by deal $ / disposition (not flat)',
    /function _pinHeatWeight\(p\)/.test(maps)
    && /_DISPO_HEAT/.test(maps)
    && /window\._pins\.map\(p => \[p\.lat, p\.lng, _pinHeatWeight\(p\)\]\)/.test(maps),
    'expected buildHeatLayer to weight each point via _pinHeatWeight');
  // Pins toggle bug fix: operate on the cluster group, not per-marker.
  assert('pins show/hide toggles the cluster group (fixes the no-op toggle)',
    /function showAllPins\(\)[\s\S]{0,200}mainMap\.addLayer\(pinClusterGroup\)/.test(maps)
    && /function hideAllPins\(\)[\s\S]{0,200}mainMap\.removeLayer\(pinClusterGroup\)/.test(maps),
    'expected showAllPins/hideAllPins to add/remove pinClusterGroup');
  // Mobile: both floating panels constrain on small viewports.
  assert('map panels are mobile-constrained (@media max-width:640px)',
    /@media \(max-width:640px\)\{[\s\S]{0,120}\.nbd-cust-panel\{width:46vw/.test(maps)
    && /@media \(max-width:640px\)\{[\s\S]{0,120}\.nbd-pin-panel\{width:46vw/.test(maps),
    'expected mobile media queries capping both the customers + pins panels');
  // ── Audit regression guards (2026-07-08) ──
  assert('route cap fits the Google Maps hand-off (no silently-dropped stop)',
    /_CUST_ROUTE_CAP = 24\b/.test(maps),
    'expected _CUST_ROUTE_CAP = 24 so map pins == URL stops (origin + 23 waypoints + dest)');
  assert('value-range max slider NaN-guards (0 is a valid max, not "no cap")',
    /data-cust-valmax'\)\) \{ const n = parseInt\(t\.value, 10\); _custValMax = Math\.max\(isNaN\(n\) \? _CUST_VAL_CAP : n/.test(maps),
    'expected the max handler to use isNaN(n), not `parseInt||CAP` which snapped 0 to no-cap');
  assert('Filters toggle re-renders with fresh counts (no stale closure)',
    /_custFiltersOpen = !_custFiltersOpen; _renderCustPanel\(\); return/.test(maps),
    'expected the more-filters branch to call _renderCustPanel() no-arg (fresh _custLastCounts)');
  const actionsSrc = read(path.join(ROOT, 'docs/pro/js/dashboard-actions.js'));
  // Globals Tranche 3 T3-C (2026-09-18): _deleteZone reads off the registry now.
  assert('deleteZone confirms the server delete before removing locally',
    /async function deleteZone\(id\)[\s\S]{0,800}ok = await _nbdReg\._deleteZone\(zone\.id\)[\s\S]{0,200}if \(!ok\)/.test(actionsSrc)
    && /async function _deleteZone\(id\)[\s\S]{0,300}return true;[\s\S]{0,300}return false;/.test(read(path.join(ROOT, 'docs/pro/js/dashboard-bootstrap.module.js'))),
    'expected deleteZone to await _deleteZone (via the registry, which returns bool) and skip local removal on denial');
  assert('zone color swatches emit hex (survive reload through safeColor)',
    /data-target="#[0-9A-Fa-f]{6}"/.test(read(path.join(ROOT, 'docs/pro/dashboard.html'))),
    'expected zone color picker data-target values to be hex, not var(--x)');
  // ── Round-2 audit regression guards ──
  assert('buildCustomersLayer has a re-entrancy token guard (no duplicate pins)',
    /let _custBuildToken = 0/.test(maps)
    && /const token = \+\+_custBuildToken/.test(maps)
    && (maps.match(/if \(token !== _custBuildToken\) return;/g) || []).length >= 2,
    'expected a build token bumped per call + aborted after each geocode await');
  assert('geocode-backfill only runs on show/refresh (doGeocode), not re-renders',
    /async function buildCustomersLayer\(doGeocode\)/.test(maps)
    && /if \(!doGeocode\) continue;/.test(maps)
    && /getLayers\(\)\.length === 0\) \{ buildCustomersLayer\(true\)/.test(maps)
    && /overlayState\.customers\) \{ buildCustomersLayer\(true\)/.test(maps),
    'expected doGeocode gate + show/refresh passing true (filter/color/zoom pass false)');
  assert('zone rep label resolves per-viewer at render (not the stored "Me")',
    /function _zoneRepLabel\(zoneData\)[\s\S]{0,220}window\.nbdRepList/.test(actionsSrc)
    && /repLabel = window\._user\.displayName \|\| window\._user\.email/.test(actionsSrc),
    'expected _zoneRepLabel() to re-resolve via nbdRepList + saveZone to store a real name');
  // ── Round-3 audit regression guards ──
  // deletePin now mirrors deleteZone: await the server delete (which returns a
  // bool) and only strip the marker on success. Pins went team-visible, so a
  // manager/viewer can click Delete on a teammate's pin — the /pins rule denies
  // it, and an optimistic removal silently reappears on reload.
  // Globals Tranche 3 T3-C (2026-09-18): _deletePin reads off the registry now.
  assert('deletePin confirms the server delete before removing the marker',
    /async function deletePin\(id\)[\s\S]{0,600}await _nbdReg\._deletePin\(id\)[\s\S]{0,120}if \(!ok\)/.test(maps)
    && /async function _deletePin\(id\)[\s\S]{0,260}return true;[\s\S]{0,200}return false;/.test(read(path.join(ROOT, 'docs/pro/js/dashboard-bootstrap.module.js'))),
    'expected deletePin to await _deletePin (via the registry, which returns bool) and skip marker removal on denial');
  // _zoneRepLabel must not let nbdRepList's degenerate uid-slice fallback
  // (String(uid).slice(0,6), used when the rep has no leads in THIS viewer's
  // book) clobber the real name the assigner persisted in repLabel.
  assert('zone rep label prefers stored real name over a uid-slice fallback',
    /const isUidSlice = r\.label === String\(zoneData\.rep\)\.slice\(0, 6\)/.test(actionsSrc)
    && /if \(!isUidSlice \|\| !zoneData\.repLabel\) return r\.label;/.test(actionsSrc),
    'expected _zoneRepLabel to fall back to zoneData.repLabel when the live label is just the uid-slice');
  // ── Round-4 audit regression guards ──
  // makePinIcon interpolates the pin colour into the divIcon SVG (fill="…").
  // Pins are team-visible and `color` is an unvalidated /pins field, so a
  // teammate-controlled colour is cross-user stored XSS unless escaped. Every
  // other colour sink in the file already routes through _mapsEscHtml.
  assert('makePinIcon escapes the pin colour before interpolating (XSS guard)',
    /function makePinIcon\(color, status\)[\s\S]{0,700}const safe = \(typeof _mapsEscHtml === 'function'\) \? _mapsEscHtml\(color\)[\s\S]{0,500}fill="\$\{safe\}"/.test(maps),
    'expected makePinIcon to escape color via _mapsEscHtml and interpolate the escaped value into fill=""');
  // deleteZone awaits a server round-trip; a second concurrent delete can splice
  // the array mid-flight, so the pre-await index goes stale. Recompute by
  // identity after the await instead of splicing the captured idx.
  assert('deleteZone recomputes the splice index by identity after the await',
    /if \(zone\.layer\) mainMap\?\.removeLayer\(zone\.layer\);[\s\S]{0,260}const realIdx = zones\.findIndex\(z => String\(z\.id\) === String\(zone\.id\)\);[\s\S]{0,80}if \(realIdx >= 0\) zones\.splice\(realIdx, 1\);/.test(actionsSrc),
    'expected deleteZone to re-find the index after awaiting _deleteZone, not splice the stale captured idx');
  // ── Round-5 audit regression guards ──
  // buildCustomerRoute awaits GPS (~6s). If the overlay is toggled off during
  // the await, resuming would draw an orphaned route on mainMap + reopen the
  // panel. Re-check overlayState.customers after the await.
  assert('buildCustomerRoute aborts if the overlay was hidden during the GPS await',
    /const start = await _custResolveStart\(\);[\s\S]{0,320}if \(!overlayState \|\| !overlayState\.customers\) return;/.test(maps),
    'expected buildCustomerRoute to re-check overlayState.customers after awaiting _custResolveStart');
  // hideCustomersLayer must bump the build token so an in-flight geocode build
  // supersedes (its post-await guards return before _renderCustPanel) instead
  // of reopening the hidden control panel ~13s later.
  assert('hideCustomersLayer supersedes an in-flight build (no panel re-show after hide)',
    /function hideCustomersLayer\(\)\s*\{[\s\S]{0,260}_custBuildToken\+\+;/.test(maps),
    'expected hideCustomersLayer to bump _custBuildToken so a running backfill build aborts before re-showing the panel');
}

section('D2D map — "Search this area" viewport knock loader (fixes the 500-recent cap)');
{
  const src = readD2DLive();

  // The spatial loader exists and is wired into the public shim so the map
  // control (and any future caller) can reach it.
  assert('D2D core defines loadKnocksInViewport()',
    /async function loadKnocksInViewport\s*\(/.test(src));
  assert('window.D2D shim exports loadKnocksInViewport',
    /loadKnocksInViewport:\s*state\.loadKnocksInViewport/.test(src));

  // Bounding-box strategy: Firestore permits a range on ONE field, so lat is
  // range-filtered server-side and lng is filtered client-side.
  assert('viewport query range-filters lat server-side (>= and <=)',
    /where\(\s*['"]lat['"]\s*,\s*['"]>=['"]/.test(src) &&
    /where\(\s*['"]lat['"]\s*,\s*['"]<=['"]/.test(src));
  assert('viewport query filters lng client-side',
    /lng\s*>=\s*west\s*&&\s*lng\s*<=\s*east/.test(src));

  // Tenancy: the viewport query must stay scoped to userId / companyId — it
  // must never widen the read surface. Scope the check to the function body.
  const vp = src.slice(src.indexOf('async function loadKnocksInViewport'));
  const vpBody = vp.slice(0, 2200);
  assert('viewport query keeps rep (userId) tenancy scope',
    /where\(\s*['"]userId['"]\s*,\s*['"]==['"]/.test(vpBody));
  assert('viewport query keeps team (companyId) tenancy scope',
    /where\(\s*['"]companyId['"]\s*,\s*['"]==['"]/.test(vpBody));

  // Default first paint is UNCHANGED — 500-most-recent is still the boot
  // loader, so nothing regresses.
  assert('KNOCK_PAGE_SIZE default stays 500 (no regression to first paint)',
    /KNOCK_PAGE_SIZE\s*=\s*500/.test(src));

  // The Search-this-area control is created and CSP-safe (addEventListener,
  // not inline onclick).
  assert('createSearchAreaControl builds the #d2d-search-area button',
    /function createSearchAreaControl\s*\(/.test(src) &&
    /id\s*=\s*['"]d2d-search-area['"]/.test(src));
  assert('search control is wired via addEventListener (CSP-safe, no inline onclick)',
    /search\.addEventListener\(\s*['"]click['"]/.test(src));
  // The corner button is a permanent reload affordance (display:flex, not
  // hidden) and taps can't fall through to the map's click→quick-knock handler.
  assert('search-area wrap is always visible and does not leak clicks to the map',
    /wrap\.id = ['"]d2d-search-area-wrap['"][\s\S]{0,600}display:flex/.test(src) &&
    /disableClickPropagation\(wrap\)/.test(src));
  assert('moveend handler is armed after init (no flash on the setView/invalidateSize settle)',
    /_searchAreaArmed/.test(src) &&
    /on\(\s*['"]moveend['"]\s*,\s*_onMapMoveForSearch\)/.test(src));
  // The "you moved — tap to load here" hint is a class toggle (the button stays
  // put), so it mutates no layout and can't oscillate the moveend loop.
  assert('_setSearchAreaVisible arms via the d2d-search-armed class (no layout mutation)',
    /function _setSearchAreaVisible[\s\S]{0,400}classList\.(add|contains)\(\s*['"]d2d-search-armed['"]/.test(src));

  // Oscillation guard (the #1061/#1062 lesson): the moveend handler and its
  // visibility toggle must NOT mutate the map — no setView/fitBounds/
  // invalidateSize — so the handler can't re-trigger its own moveend.
  const mh = src.slice(src.indexOf('function _onMapMoveForSearch'),
                       src.indexOf('async function runSearchThisArea'));
  assert('search move/visibility handlers perform no map mutation (no oscillation)',
    !/(setView|fitBounds|invalidateSize|flyTo|panTo|panBy)/.test(mh));

  // Honest feedback: loading state, result count, and an empty state that
  // reads "searched, none here" — distinct from "not loaded yet".
  assert('viewport search has an honest empty state',
    /No knocks logged in this area/.test(src));
  assert('viewport search reports a result count',
    /\$\{n\} knock/.test(src) && /in this area/.test(src));

  // Plain refresh affordance (there was previously no re-pull short of reload).
  assert('D2D exposes a plain refreshKnocks re-pull',
    /async function refreshKnocks\s*\(/.test(src) &&
    /refreshKnocks:\s*state\.refreshKnocks/.test(src));
}

section('D2D map — map-data diagnostic ("why is my map empty?")');
{
  const src = readD2DLive();

  // The diagnostic exists and is reachable from the shim (button + console).
  assert('D2D core defines runMapDiagnostics()',
    /async function runMapDiagnostics\s*\(/.test(src));
  assert('window.D2D shim exports mapDiagnostics',
    /mapDiagnostics:\s*state\.runMapDiagnostics/.test(src));

  // It uses a cheap server-side COUNT aggregation (no doc reads) to learn the
  // true total for the account — the number that disambiguates #1 vs #2 vs #3.
  assert('diagnostic uses getCountFromServer (aggregation, not a full read)',
    /getCountFromServer/.test(src));

  // Tenancy: the count query stays scoped to userId / companyId.
  const diag = src.slice(src.indexOf('async function runMapDiagnostics'));
  const diagBody = diag.slice(0, 2600);
  assert('diagnostic count query keeps rep (userId) tenancy scope',
    /where\(\s*['"]userId['"]\s*,\s*['"]==['"]/.test(diagBody));
  assert('diagnostic count query keeps team (companyId) tenancy scope',
    /where\(\s*['"]companyId['"]\s*,\s*['"]==['"]/.test(diagBody));

  // It distinguishes a silent load failure (#3) from a genuinely-empty
  // account (#2): loadKnocks must record the error, and the diagnostic reads it.
  assert('loadKnocks records state.lastKnockLoadError on failure',
    /state\.lastKnockLoadError\s*=\s*\{\s*message:/.test(src));
  assert('loadKnocks clears state.lastKnockLoadError on a clean load',
    /state\.lastKnockLoadError\s*=\s*null/.test(src));
  assert('diagnostic reads the recorded load error',
    /state\.lastKnockLoadError/.test(diagBody));

  // It names all five ranked hypotheses in its verdict text.
  assert('diagnostic verdict covers hypotheses #1–#5',
    /\(#1\)/.test(src) && /\(#2\)/.test(src) && /\(#3\)/.test(src) &&
    /\(#4\)/.test(src) && /\(#5\)/.test(src));

  // Surfaced via a CSP-safe button in the (existing) layer panel.
  assert('layer panel exposes a CSP-safe diagnostics button',
    /id\s*=\s*['"]d2d-map-diag['"]/.test(src) &&
    /diag\.addEventListener\(\s*['"]click['"][\s\S]*?runMapDiagnostics\(\)/.test(src));
}

section('D2D map — dots ⇄ pins look toggle (map unification, phase 1)');
{
  const src = readD2DLive();

  // The look toggle exists, is exposed on the shim, and persists per device.
  assert('D2D core defines toggleMarkStyle()',
    /function toggleMarkStyle\s*\(/.test(src));
  assert('window.D2D shim exports toggleMarkStyle',
    /toggleMarkStyle:\s*state\.toggleMarkStyle/.test(src));
  assert('mark style is persisted (MARK_STYLE_PREF localStorage)',
    /MARK_STYLE_PREF\s*=/.test(src) &&
    /localStorage\.setItem\(MARK_STYLE_PREF/.test(src) &&
    /localStorage\.getItem\(MARK_STYLE_PREF\)/.test(src));

  // Both looks are built by one icon helper, branched on the style.
  assert('_d2dMarkerIcon branches on the pins style',
    /function _d2dMarkerIcon\s*\(/.test(src) &&
    /state\.d2dMarkStyle\s*===\s*['"]pins['"]/.test(src));
  assert('pins style renders the teardrop SVG',
    /M12 0C7\.6 0 4 3\.6 4 8/.test(src));
  assert('dots style keeps the disposition short-code circle',
    /\(dispo && dispo\.short\)\s*\|\|\s*['"]\?['"]/.test(src));

  // Colour still encodes status in the pins style, and is escaped (XSS guard).
  const iconFn = src.slice(src.indexOf('function _d2dMarkerIcon'),
                          src.indexOf('function _markStyleBtnLabel'));
  assert('pins style escapes the colour before interpolating into the SVG',
    /const safe = esc\(color\)/.test(iconFn) && /fill="'\s*\+\s*safe/.test(iconFn));

  // Surfaced via a CSP-safe button in the existing layer panel.
  assert('layer panel exposes a CSP-safe mark-style toggle button',
    /id\s*=\s*['"]d2d-mark-style['"]/.test(src) &&
    /styleBtn\.addEventListener\(\s*['"]click['"][\s\S]*?toggleMarkStyle\(\)/.test(src));

  // Default first paint is unchanged (dots), so nothing regresses visually.
  assert("default mark style stays 'dots'",
    /state\.d2dMarkStyle\s*=\s*['"]dots['"]/.test(src));
}

section('D2D map — Customers layer (map unification, phase 2)');
{
  const src = readD2DLive();

  // The old jobs-only ($-label) layer is replaced by a full Customers layer.
  assert('D2D layer state uses a customers layer (not the old jobs key)',
    /d2dLayerState\s*=\s*\{[^}]*customers:\s*false/.test(src) &&
    !/d2dLayerState\s*=\s*\{[^}]*\bjobs\b:/.test(src));
  assert('layer panel shows a Customers entry',
    /key:\s*['"]customers['"][\s\S]{0,40}label:\s*['"]Customers['"]/.test(src));
  assert('toggleLayer handles the customers layer',
    /case\s*['"]customers['"]:[\s\S]{0,160}buildD2DCustomersLayer\(\)/.test(src));
  assert('D2D core defines buildD2DCustomersLayer()',
    /async function buildD2DCustomersLayer\s*\(/.test(src));

  // Colour = pipeline stage, from the live stage engine (same source as kanban).
  const build = src.slice(src.indexOf('function _leadStageColor'),
                         src.indexOf('async function buildD2DCustomersLayer') + 4000);
  assert('customer colour comes from the live stage engine',
    /window\.STAGE_META/.test(build) && /window\.stageRole/.test(build) && /window\.normalizeStage/.test(build));

  // Customers honour the SAME dots/pins look toggle as knocks (one visual language).
  assert('customer marks reuse _d2dMarkerIcon (shared dots/pins look)',
    /const icon = _d2dMarkerIcon\(\{\s*color:\s*color/.test(src));
  assert('flipping the look restyles the customers layer too',
    /if \(d2dLayerState\.customers\) buildD2DCustomersLayer\(\)/.test(src));

  // Whole pipeline minus soft-deleted (broader than the old job-stages-only filter).
  assert('customers layer covers the whole pipeline (skips soft-deleted)',
    /window\._leads\s*\|\|\s*\[\]\)\.filter\(l => l && !l\.deleted\)/.test(src));

  // Reuses the fair-use geocode discipline (cache + per-build cap + 1.1s spacing).
  assert('customers layer keeps the geocode cache + per-build cap',
    /D2D_GEOCODE_CACHE/.test(build) && /D2D_GEOCODE_PER_BUILD_CAP/.test(build) && /1100/.test(build));

  // CSP-safe "View lead" (addEventListener, not inline onclick).
  assert('customer popup View-lead button is CSP-safe',
    /view\.addEventListener\(\s*['"]click['"]/.test(src) && /openCardDetailModal/.test(src));
}

section('D2D map — one mark per house (map unification, phase 3)');
{
  const src = readD2DLive();

  // Suppression set: leads that can be placed (coords required so a house
  // never vanishes), keyed by the same normalizeAddress used for knock dedupe.
  assert('D2D core defines _leadAddrSetWithCoords()',
    /function _leadAddrSetWithCoords\s*\(/.test(src));
  const setFn = src.slice(src.indexOf('function _leadAddrSetWithCoords'),
                         src.indexOf('function _leadStageColor'));
  assert('suppression set requires lead coordinates',
    /Number\(l\.lat\)\s*&&\s*Number\(l\.lng\)/.test(setFn));
  assert('suppression set keys by normalizeAddress',
    /normalizeAddress\(l\.address/.test(setFn));

  // refreshMapMarkers drops a knock mark when a coords-bearing lead shares its
  // address AND the customers layer is on (no effect when the layer is off).
  assert('knock render suppresses houses shown as customers (only when layer on)',
    /const suppressAddrs = d2dLayerState\.customers \? _leadAddrSetWithCoords\(\) : null/.test(src) &&
    /if \(suppressAddrs && suppressAddrs\.has\(norm\)\) return/.test(src));

  // Toggling the customers layer re-renders knocks so suppression tracks it.
  assert('toggling customers re-runs refreshMapMarkers (suppression stays in sync)',
    /case\s*['"]customers['"]:[\s\S]{0,500}refreshMapMarkers\(\)/.test(src));
}

section('scripts/backfill-pins-to-knocks.js — legacy pin → knock migration (phase 4)');
{
  const p = path.join(ROOT, 'scripts', 'backfill-pins-to-knocks.js');
  assert('migration script exists', fs.existsSync(p));
  const mig = fs.existsSync(p) ? read(p) : '';

  // Same safety discipline as the other backfills: dry-run by default,
  // --apply needs --yes, idempotent, non-destructive.
  assert('migration is dry-run by default (--apply needs --yes)',
    /APPLY\s*&&\s*!YES/.test(mig) && /--apply.*--yes|--apply --yes/.test(mig));
  assert('migration is idempotent (skips already-migrated pins)',
    /pin\.migratedToKnock\s*===\s*true/.test(mig) && /migratedFromPinId/.test(mig));
  assert('migration is non-destructive (never deletes the source pin)',
    !/\.delete\(\)/.test(mig));

  // Only hand-dropped door-knock pins migrate — customer/lead pins are skipped
  // (they re-derive from /leads via the Customers layer).
  assert('migration skips lead/customer pins',
    /if \(p\.leadId\) return false/.test(mig) && /p\.type === ['"]customer['"]/.test(mig));

  // Legacy status → disposition mapping (with the two best-effort cases).
  assert('migration maps legacy pin statuses to knock dispositions',
    /'not-home':\s*'not_home'/.test(mig) &&
    /'do-not-knock':\s*'do_not_knock'/.test(mig) &&
    /'signed':\s*'appointment'/.test(mig));

  // Tenancy carried onto the knock (owner uid required; company scoped).
  assert('migrated knock keeps userId/companyId tenancy',
    /userId:\s*pin\.userId/.test(mig) && /companyId:\s*pin\.companyId\s*\|\|\s*pin\.userId/.test(mig) &&
    /if \(!pin\.userId\)/.test(mig));
}

section('D2D map — follow mode + heading arrow (field navigation, phase A)');
{
  const src = readD2DLive();

  // Follow toggle exists, is exposed, and persists.
  assert('D2D core defines toggleFollow()',
    /function toggleFollow\s*\(/.test(src));
  assert('window.D2D shim exports toggleFollow',
    /toggleFollow:\s*state\.toggleFollow/.test(src));
  assert('follow preference persists (FOLLOW_PREF localStorage)',
    /FOLLOW_PREF\s*=/.test(src) && /localStorage\.setItem\(FOLLOW_PREF/.test(src) &&
    /localStorage\.getItem\(FOLLOW_PREF\)/.test(src));

  // Pause-on-drag → Recenter resumes.
  assert('a manual drag pauses follow',
    /on\(\s*['"]dragstart['"]\s*,\s*_onUserDragStart\)/.test(src) &&
    /function _onUserDragStart[\s\S]{0,180}state\.d2dFollowPaused = true/.test(src));
  assert('Recenter control exists and resumes follow (CSP-safe)',
    /id\s*=\s*['"]d2d-recenter['"]/.test(src) &&
    /addEventListener\(\s*['"]click['"][\s\S]{0,120}d2dFollowPaused = false[\s\S]{0,60}_recenterFollow\(\)/.test(src));

  // Follow's own setView must NOT pop the "Search this area" pill.
  assert('follow moves are flagged so they do not trigger the search pill',
    /_followProgrammaticMove = true/.test(src) &&
    /function _onMapMoveForSearch[\s\S]{0,320}if \(_followProgrammaticMove\)/.test(src));

  // Heading arrow: rotated location marker, driven by compass or GPS course.
  assert('location marker becomes a rotatable heading arrow',
    /function _locationIcon\s*\(/.test(src) && /d2d-loc-arrow/.test(src) &&
    /rotate\('\s*\+\s*\(hasH \? heading : 0\)/.test(src));
  assert('heading comes from the compass (iOS webkitCompassHeading) or GPS course',
    /webkitCompassHeading/.test(src) && /pos\.coords\.heading/.test(src));

  // Perf/oscillation guard: the high-frequency compass handler rAF-coalesces,
  // thresholds sub-3° jitter, and writes ONE element's transform.
  const oh = src.slice(src.indexOf('function _onHeading'), src.indexOf('function _deviceOrientationHandler'));
  assert('compass updates are rAF-coalesced + 3° thresholded (no DOM churn)',
    /requestAnimationFrame\(_applyHeadingToMarker\)/.test(oh) && /Math\.min\(d, 360 - d\) < 3/.test(oh));

  // iOS 13+ permission requested from the toggle gesture; watch released on teardown.
  assert('iOS compass permission requested from the user gesture',
    /DeviceOrientationEvent\.requestPermission\(\)/.test(src));
  assert('heading watch is released when the location watch stops',
    /function stopLocationWatch[\s\S]{0,260}_stopHeadingWatch\(\)/.test(src));
}

section('D2D map — opt-in map rotation / "spin to heading" (field navigation, phase B)');
{
  const src = readD2DLive();

  // Toggle exists, exposed, persisted.
  assert('D2D core defines toggleMapRotate()',
    /function toggleMapRotate\s*\(/.test(src));
  assert('window.D2D shim exports toggleMapRotate',
    /toggleMapRotate:\s*state\.toggleMapRotate/.test(src));
  assert('rotation preference persists (ROTATE_PREF)',
    /ROTATE_PREF\s*=/.test(src) && /localStorage\.setItem\(ROTATE_PREF/.test(src) &&
    /localStorage\.getItem\(ROTATE_PREF\)/.test(src));

  // Safe-by-construction: the plugin is LAZY-loaded (injected script) only on
  // opt-in, and the map only gets rotate:true once the plugin is ready — so a
  // default user never loads it.
  assert('rotation plugin is lazy-loaded via an injected script',
    /LEAFLET_ROTATE_URL/.test(src) &&
    /createElement\(['"]script['"]\)/.test(src.slice(src.indexOf('function _loadRotatePlugin'), src.indexOf('function _rebuildD2DMap'))));

  // CSP: the /pro script-src is 'self' + a fixed host list (no CDN). The plugin
  // must be VENDORED same-origin, not pulled from an external CDN.
  assert('rotation plugin loads same-origin (CSP-clean, no external CDN)',
    /LEAFLET_ROTATE_URL\s*=\s*['"]\/assets\/vendor\/leaflet-rotate\//.test(src) &&
    !/LEAFLET_ROTATE_URL\s*=\s*['"]https?:/.test(src));
  assert('leaflet-rotate is vendored in the repo',
    fs.existsSync(path.join(ROOT, 'docs/assets/vendor/leaflet-rotate/leaflet-rotate.js')));
  assert('map only gets rotate:true once the plugin is ready (default users unaffected)',
    /if \(_rotateReady\) \{ _mapOpts\.rotate = true/.test(src));

  // Graceful failure: a blocked/absent plugin reverts the toggle instead of
  // breaking the map.
  const en = src.slice(src.indexOf('async function _enableRotation'), src.indexOf('function _applyBearingFromHeading'));
  assert('a failed plugin load reverts the toggle (no broken map)',
    /if \(!ok\)/.test(en) && /state\.d2dRotateEnabled = false/.test(en) && /unavailable/.test(en));

  // Heading drives the bearing when rotating; arrow points up while the map spins.
  assert('heading drives map bearing when rotation is on',
    /function _applyBearingFromHeading[\s\S]{0,220}setBearing\(-deg\)/.test(src));
  assert('arrow points up (0) while the map itself spins',
    /const rotating = state\.d2dRotateEnabled && _rotateReady/.test(src) &&
    /const arrowDeg = rotating \? 0 : deg/.test(src));

  // Rebuild preserves the viewport; re-entrancy guarded.
  assert('rotation rebuild preserves view + guards re-entrancy',
    /_pendingRebuildView/.test(src) && /_rotateRebuilding/.test(src));

  // CSP-safe control.
  assert('layer panel exposes a CSP-safe Spin (beta) button',
    /id\s*=\s*['"]d2d-rotate['"]/.test(src) &&
    /rotateBtn\.addEventListener\(\s*['"]click['"][\s\S]{0,80}toggleMapRotate\(\)/.test(src));
}

section('Maps & Pins retired → D2D + on-map search (map unification, phase C)');
{
  const src = readD2DLive();
  const actions = read(path.join(PRO_JS, 'dashboard-actions.js'));

  // The 'map' route redirects to D2D — placed AFTER the lite gate so gating
  // is unchanged, with a one-time heads-up.
  assert("goTo('map') redirects to the D2D view",
    /if \(name === ['"]map['"]\) \{[\s\S]{0,120}name = ['"]d2d['"]/.test(actions));
  assert('the retire redirect sits after the lite-tier gate (gating preserved)',
    actions.indexOf("PRO_ONLY_VIEWS.includes(name)") < actions.indexOf("if (name === 'map') {"));
  assert('one-time redirect notice is shown',
    /nbd_maps_redirect_seen/.test(actions));

  // On-map address search ported into D2D (the one thing Maps & Pins had that
  // D2D lacked; county-records intel still lives on the lead modal).
  assert('D2D core defines d2dSearchAddress()',
    /async function d2dSearchAddress\s*\(/.test(src));
  assert('window.D2D shim exports d2dSearchAddress',
    /d2dSearchAddress:\s*state\.d2dSearchAddress/.test(src));
  assert('D2D search geocodes (Nominatim), flies there, drops a result pin',
    /NOMINATIM_SEARCH \+ encodeURIComponent\(q\)/.test(src) &&
    /_d2dSearchMarker\s*=\s*L\.marker/.test(src));
  assert('D2D search result can spin up a lead (reuses the existing flow)',
    /window\.openLeadModal/.test(src.slice(src.indexOf('async function d2dSearchAddress'), src.indexOf('function _createD2DSearchControl'))));

  // CSP-safe search box that doesn't drive the map underneath it.
  assert('D2D search control is CSP-safe + does not leak clicks to the map',
    /id\s*=\s*['"]d2d-addr-search['"]/.test(src) &&
    /addEventListener\(\s*['"]keydown['"]/.test(src) &&
    /disableClickPropagation\(wrap\)/.test(src));

  // The search jump must not pop the "Search this area" pill.
  assert('the search fly-to is flagged so it does not pop the area pill',
    /d2dSearchAddress[\s\S]{0,700}_followProgrammaticMove = true[\s\S]{0,160}setView/.test(src));
}

section('D2D map — Customers layer persists geocoded coords (geocode once ever)');
{
  const src = readD2DLive();
  // After a live geocode, the customers layer persists lat/lng via the shared
  // rolling-backfill helper (same as the old map), guarded against temp ids.
  const build = src.slice(src.indexOf('async function buildD2DCustomersLayer'),
                         src.indexOf('async function buildD2DCustomersLayer') + 3200);
  assert('D2D customers layer persists geocoded coords via _saveLeadCoords',
    /window\._saveLeadCoords\(lead\.id,\s*lat,\s*lng\)/.test(build));
  assert('geocode-persist skips temp/demo lead ids',
    /lead\.id && !String\(lead\.id\)\.startsWith\(['"]d-['"]\)/.test(build));
}

section('D2D map — navigation polish (heading smoothing + "you are here" pulse)');
{
  const src = readD2DLive();

  // Circular low-pass filter smooths the jittery compass (unit-vector average
  // so it eases across the 0°/360° wrap) and _onHeading runs through it.
  assert('heading is smoothed by a circular low-pass filter',
    /function _smoothHeading\s*\(/.test(src) &&
    /Math\.atan2\(_headingSmY, _headingSmX\)/.test(src) &&
    /Math\.cos\(rad\)/.test(src) && /Math\.sin\(rad\)/.test(src));
  assert('_onHeading applies the smoothing filter',
    /function _onHeading[\s\S]{0,140}deg = _smoothHeading\(deg\)/.test(src));
  assert('the smoothing filter resets on teardown',
    /function _stopHeadingWatch[\s\S]{0,600}_headingSmX = null; _headingSmY = null/.test(src));

  // The location marker gets the radiating "you are here" pulse back.
  assert('location dot uses the d2d-location-pulse treatment',
    /class="d2d-location-pulse"/.test(src));
}

section('D2D map — 🔍 Check now reports navigation health');
{
  const src = readD2DLive();
  const diag = src.slice(src.indexOf('async function runMapDiagnostics'),
                        src.indexOf('async function runMapDiagnostics') + 7000);

  // The diagnostic now carries a navigation block alongside the data verdict.
  assert('runMapDiagnostics returns a navigation block',
    /navigation:\s*nav/.test(diag) && /const nav = \{/.test(diag));
  // GPS health: fix presence + accuracy + age (needs the fix timestamp).
  assert('reports GPS fix age + accuracy',
    /state\.gpsFixAt/.test(diag) && /gpsAccuracyM/.test(diag));
  assert('GPS fix timestamp is stamped on each watchPosition fix',
    /state\.gpsFixAt = Date\.now\(\)/.test(src));
  // Compass: support + permission + whether it's actually the heading source.
  assert('reports compass support/permission + heading source',
    /compassSupported/.test(diag) && /headingSource/.test(diag) &&
    /_compassActive \? ['"]compass['"] : \(state\.d2dHeading != null \? ['"]gps-course['"]/.test(diag));
  // Rotation: state + plugin-loaded + current bearing (so the spin sign is
  // inspectable next to heading).
  assert('reports rotation state, plugin-loaded, and current bearing',
    /rotationPluginLoaded:\s*_rotatePluginPresent\(\)/.test(diag) &&
    /getBearing\(\)/.test(diag));
  assert('readout has a NAVIGATION section next to DATA',
    /'NAVIGATION'/.test(diag) && /'DATA'/.test(diag));
}

section('D2D map — control layout (no top-edge overlap)');
{
  const src = readD2DLive();
  // Search box: top bar, inset past the top-left zoom control, spanning right —
  // NOT the old top-left box that collided with the layer panel.
  assert('search box is a top bar inset from the left zoom control',
    /d2d-addr-search[\s\S]{0,400}top:8px;left:52px;right:8px/.test(src) &&
    !/top:10px;left:10px;z-index:1000;display:flex;gap:4px;max-width:62vw/.test(src));
  // Layer panel ("filters") sits below the top search bar (drops from the
  // row-2 "Layers" toggle at top:56 to top:100 when opened) — never shares the
  // top row with search.
  assert('layer panel is below the search bar (row 2+)',
    /d2d-layer-panel[\s\S]{0,320}top:100px;right:10px/.test(src) &&
    /d2d-layer-toggle[\s\S]{0,200}top:56px;right:10px/.test(src));
  // "Search this area" is now a compact reload button parked in the
  // bottom-RIGHT corner, floated ABOVE the Leaflet/Google attribution (so the
  // required attribution stays visible) — off the top cluster AND the
  // bottom-center recenter/follow controls.
  assert('search-this-area reload button is anchored bottom-right (clear of attribution)',
    /d2d-search-area-wrap[\s\S]{0,320}bottom:26px;right:8px/.test(src) &&
    !/d2d-search-area-wrap[\s\S]{0,200}bottom:136px;left:50%/.test(src));
}

section('D2D map — collapsible layers panel (frees the map)');
{
  const src = readD2DLive();
  // Panel is collapsed by default and toggled by a compact button.
  assert('layer panel is collapsed by default',
    /let _layerPanelOpen = false/.test(src));
  assert('a CSP-safe "Layers" toggle button controls the panel',
    /id\s*=\s*['"]d2d-layer-toggle['"]/.test(src) &&
    /toggle\.addEventListener\(\s*['"]click['"][\s\S]{0,90}_setLayerPanelOpen\(!_layerPanelOpen\)/.test(src));
  assert('_setLayerPanelOpen shows/hides the panel + updates the label',
    /function _setLayerPanelOpen[\s\S]{0,320}panel\.style\.display = _layerPanelOpen \? ['"]flex['"] : ['"]none['"]/.test(src));
  assert('initial collapsed state is applied on panel build',
    /_setLayerPanelOpen\(_layerPanelOpen\)/.test(src));
  assert('window.D2D exposes toggleLayerPanel',
    /toggleLayerPanel:\s*state\.toggleLayerPanel/.test(src));

  // The base-map "view type" switcher is folded INTO the layer panel (one
  // collapsible panel) — no separate always-on bottom-left control.
  assert('basemap buttons build into any container (reusable helper)',
    /function _buildBasemapButtons\s*\(\s*container\s*\)/.test(src) &&
    /container\.appendChild\(btn\)/.test(src));
  assert('the layer panel builds a "view type" group via _buildBasemapButtons',
    /createLayerPanel[\s\S]{0,2600}d2d-viewtype-group[\s\S]{0,200}_buildBasemapButtons\(viewGroup\)/.test(src));
  assert('the standalone bottom-left basemap control is gone',
    !/createBasemapControl/.test(src) && !/id\s*=\s*['"]d2d-basemap-ctrl['"]/.test(src) &&
    !/ctrl\.className = ['"]d2d-basemap-ctrl['"]/.test(src));
  // Basemap buttons keep their ids/.active so updateBasemapControl still tracks
  // the current view, and they're still CSP-safe (addEventListener).
  assert('basemap buttons keep d2d-basemap-<key> ids + CSP-safe wiring',
    /id\s*=\s*['"]d2d-basemap-['"]\s*\+\s*key/.test(src) &&
    /btn\.addEventListener\(\s*['"]click['"][\s\S]{0,60}setBasemap\(key\)/.test(src));
}

section('firestore.indexes.json — knocks [tenant, lat] viewport indexes (deploy on merge)');
{
  const idx = JSON.parse(read(path.join(ROOT, 'firestore.indexes.json')));
  const hasKnockIndex = (fields) => idx.indexes.some(i =>
    i.collectionGroup === 'knocks' &&
    Array.isArray(i.fields) &&
    i.fields.length === fields.length &&
    i.fields.every((f, n) => f.fieldPath === fields[n]));
  assert('knocks [userId, lat] index present (rep viewport scope)',
    hasKnockIndex(['userId', 'lat']));
  assert('knocks [companyId, lat] index present (team viewport scope)',
    hasKnockIndex(['companyId', 'lat']));
}

section('D2D "Value Per Door" — address-less knocks do not collapse into one door');
{
  const src = readD2DLive();
  // doorKey gives address-less knocks a distinct identity (coords, then id) so
  // they no longer all normalize to '' and collapse into a single door (which
  // shrank the denominator and inflated Value Per Door).
  assert('doorKey falls back address → coords → id',
    /function doorKey\(k\)[\s\S]{0,320}geo:['"] \+ Number\(k\.lat\)\.toFixed\(5\)[\s\S]{0,120}return ['"]k:['"] \+ \(\(k && k\.id\)/.test(src));
  // getRevenueMetrics must count doors AND weight the pipeline by doorKey (same
  // key both sides) — not bare normalizeAddress — so the denominator is right.
  const grm = src.slice(src.indexOf('function getRevenueMetrics'),
                        src.indexOf('function getRevenueMetrics') + 3600);
  assert('getRevenueMetrics counts doors via doorKey',
    /doorsKnocked = new Set\(knocks\.map\(k => doorKey\(k\)\)\)\.size/.test(grm) &&
    /const norm = doorKey\(k\)/.test(grm));

  // #3 — the revenue card respects the DATE-range filter (period-scoped) but NOT
  // the disposition filter (which would degenerate the per-door mix).
  const rsk = src.slice(src.indexOf('function revenueScopedKnocks'),
                        src.indexOf('function revenueScopedKnocks') + 500);
  assert('revenueScopedKnocks applies the date range only (not filterDispo)',
    /state\.filterDateRange === 'today'/.test(rsk) &&
    /state\.filterDateRange === 'week'/.test(rsk) &&
    !/filterDispo/.test(rsk));
  assert('getRevenueMetrics operates on the date-scoped knocks',
    /const knocks = revenueScopedKnocks\(\)/.test(grm));

  // #4 — the headline is labeled EXPECTED/projected, not "Value Per Door" /
  // "Live" (so a rep doesn't read it as money earned).
  assert('headline reads "Expected Value / Door" + projected tag (not the old label)',
    /Expected Value \/ Door/.test(src) &&
    /Projected — not yet earned/.test(src) &&
    !/>Value Per Door</.test(src) &&
    !/◉ Live pipeline value/.test(src));
}

};
