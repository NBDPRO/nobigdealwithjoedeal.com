/**
 * tests/smoke/estimates.test.js — V2 Builder (prefill, live snapshot,
 * autosave), measurement pass-through, voice memo transcription,
 * feature flags, V2 preview titleMap, UI-A HOVER Auto-measure.
 */

'use strict';

const path = require('path');
const { ROOT, PRO_JS, FUNCTIONS, read, readDashboard, readFunctionsIndex } = require('./_shared');

module.exports.run = function run(ctx) {
  const { assert, section } = ctx;

section('UI-A: HOVER Auto-measure in V2 Builder');
{
  const src = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  assert('Auto-measure button present', /data-action="auto-measure"/.test(src));
  assert('auto-measure case dispatches autoMeasure()',
    /case 'auto-measure':[\s\S]{0,80}autoMeasure\(\)/.test(src));
  assert('autoMeasure polls measurements/{jobId}',
    /measurements',\s*jobId/.test(src) && /status === 'ready'/.test(src));
  assert('applyMeasurementResult normalizes provider fields',
    /function applyMeasurementResult/.test(src));
}

section('Push-2: measurement pass-through line item');
{
  const src = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  assert('state.passThru seeded', /passThru: \[\]/.test(src));
  assert('applyMeasurementResult adds SVC MEASURE-RPT',
    /source: 'measurement'/.test(src) && /Aerial measurement report/.test(src));
  assert('getCurrentEstimate appends passThru to estimate.lines',
    /for \(const p of \(state\.passThru \|\| \[\]\)\)/.test(src));
  assert('removeFromScope clears from passThru first',
    /state\.passThru\s*=\s*\(state\.passThru \|\| \[\]\)\.filter/.test(src));
  assert('scope empty guard allows passThru-only quotes',
    /!state\.scope\.length && !\(state\.passThru && state\.passThru\.length\)/.test(src));
}

section('Wave B2: V2 prefill from lead');
{
  const src = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  assert('prefillFromLead helper defined', /function prefillFromLead\(leadId\)/.test(src));
  assert('syncCustomerInputs helper defined', /function syncCustomerInputs\(\)/.test(src));
  assert('open() accepts leadId', /function open\(opts\)/.test(src));
  assert('sendForSignature retries prefill before erroring',
    /prefillFromLead\(state\.customer\.leadId\)/.test(src));
}

section('Job Templates: "Add to Existing Customer" survives a repaint (attach fix)');
{
  const src = read(path.join(PRO_JS, 'job-templates-ui.js'));
  // The lead picker must mirror the pick into state.leadId (the source of
  // truth), or a reRender() rebuilds the create step from an empty state.leadId
  // and the estimate saves with leadId:null — "created but not attached".
  assert('_jtWireLeadPicker syncs the pick into state.leadId via onSelect',
    /function _jtWireLeadPicker[\s\S]{0,1600}onSelect:\s*function\s*\(lead\)\s*\{[\s\S]{0,160}state\.leadId\s*=/.test(src));
  // The create step's hidden #jtLeadSel must derive its value from state.leadId
  // so a repaint re-hydrates the selection instead of clearing it.
  assert('create step hydrates #jtLeadSel from state.leadId',
    /id="jtLeadSel"[\s\S]{0,80}state\.leadId\s*\?/.test(src));
  // doCreateEstimate still reads that input to attribute the estimate.
  assert('doCreateEstimate reads #jtLeadSel for attribution',
    /doCreateEstimate[\s\S]{0,260}getElementById\('jtLeadSel'\)/.test(src));
}

section('V2 builder: new estimate keeps its customer link (leadId not orphaned)');
{
  const src = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  // state.leadId is set only on reopen; a fresh estimate links via
  // state.customer.leadId (prefillFromLead). _buildSavePayload must fall back to
  // it, or new estimates save leadId:null — orphaned off the customer + no lead
  // jobValue/primaryEstimate stamp-back.
  assert('_buildSavePayload falls back to state.customer.leadId',
    /function _buildSavePayload[\s\S]{0,1600}leadId:\s*state\.leadId\s*\|\|\s*\(state\.customer && state\.customer\.leadId\)\s*\|\|\s*null/.test(src));
  assert('prefillFromLead is the fresh-open customer link',
    /function prefillFromLead\(leadId\)[\s\S]{0,800}state\.customer\.leadId = leadId/.test(src));
}

section('Linkage invariant: unattached saves are warned; Assign stamps the pipeline');
{
  const src = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  // Save-time guard: an unattached estimate is invisible on every customer
  // page/Activity tab and never reaches the pipeline. save() must confirm
  // before orphaning — and the cancel path must re-enable the Save button
  // (no dead-button state).
  assert('V2 save() confirms before saving with no leadId',
    /if \(!payload\.leadId\) \{[\s\S]{0,900}nbdConfirm[\s\S]{0,900}Save cancelled — attach a customer first/.test(src));
  assert('V2 save() cancel path re-enables the save button',
    /Save cancelled — attach a customer first[\s\S]{0,300}btn\.disabled = false[\s\S]{0,160}return;/.test(src));

  // _assignEstimateToLead must leave the same state a correctly-linked save
  // would — it's the manual remediation path for migration 005's skips.
  // Globals Tranche 3 T3-C (2026-09-18): real declaration now, not window.X.
  const dash = readDashboard();
  const at = dash.indexOf('async function _assignEstimateToLead(id, leadId)');
  const fn = dash.slice(at, at + 6000);
  assert('assign stamps primaryEstimateId + lastEstimateAt on a first-estimate lead',
    /primaryEstimateId: id,\s*lastEstimateAt: serverTimestamp\(\)/.test(fn));
  // Asserted by intent, not by the literal comparison. This pinned
  // `if (newVal > 0) stampUpdate.jobValue = newVal`, which was the rule
  // expressed inline in ONE of the four branches that stamp jobValue — the
  // other three wrote a 0 straight through. The rule now lives in a shared
  // _canStampJobValue() consulted by all of them, so the literal is gone and
  // the guarantee is strictly stronger.
  assert('assign stamps jobValue only when the value is positive (never zeroes a KPI)',
    /_canStampJobValue\(newVal\)\) stampUpdate\.jobValue = newVal/.test(fn));
  // And the value being tested must come from the two-shape reader — a guard
  // in front of a grandTotal-only read still zeroes every Classic estimate.
  assert('assign reads the estimate value two-shape (not grandTotal alone)',
    /const newVal = _estValue\(est\)/.test(fn));
  assert('the re-assign branch shares the same guard (it used to write 0 through)',
    /if \(!_canStampJobValue\(newVal\)\)/.test(fn));
  assert('assign confirms before clobbering an existing rep-confirmed primary',
    /lead\.primaryEstimateId !== id[\s\S]{0,700}nbdConfirm/.test(fn));
  assert('assign bumps a stone-cold NEW lead to Contacted (parity with _saveEstimate)',
    /normalizeStage\(lead\.stage\) === S\.NEW[\s\S]{0,200}S\.CONTACTED/.test(fn));
  assert('re-assign un-dangles the previous lead\'s primaryEstimateId pointer',
    /if \(prevLeadId && prevLeadId !== \(leadId \|\| null\)\)[\s\S]{0,400}\{ primaryEstimateId: null \}/.test(fn));
  assert('assign stamp-back is best-effort (never fails the assign itself)',
    /catch \(stampErr\)[\s\S]{0,200}_assignEstimateToLead\] lead stamp-back failed/.test(fn));
}

section('Phase 1a: shared estimate preview sheet (mobile-first, both doc shapes)');
{
  const fs = require('fs');
  const p = path.join(PRO_JS, 'estimate-preview.js');
  assert('estimate-preview.js exists', fs.existsSync(p));
  const src = read(p);
  assert('exposes EstimatePreview.open with sentinel',
    /window\.EstimatePreview = \{ __sentinel: 'nbd-est-preview-v1', open: open, close: close[,\s]/.test(src));
  // The whole point: ONE normalizer for both estimate shapes. The customer
  // page's legacy modal read classic fields only, so V2 docs previewed as
  // "Untitled, $0, no lines".
  assert('normalizer reads V2 rows AND classic lineItems',
    /Array\.isArray\(est\.rows\)/.test(src) && /Array\.isArray\(est\.lineItems\)/.test(src));
  assert('total falls back grandTotal → total → amount',
    /est\.grandTotal != null \? est\.grandTotal[\s\S]{0,80}est\.total != null \? est\.total[\s\S]{0,80}est\.amount/.test(src));
  assert('unattached estimates get the NOT ATTACHED chip',
    /NOT ATTACHED/.test(src));
  // CSP: one delegated listener on data-ep-action, zero inline handlers.
  assert('single delegated click listener keyed on data-ep-action',
    /ov\.addEventListener\('click'/.test(src) && /closest\('\[data-ep-action\]'\)/.test(src));
  const INLINE = /\son(?:click|change|input|submit|load|error|keydown|keyup|touchstart|touchend)\s*=\s*["'`]/gi;
  assert('estimate-preview.js has zero inline on*= handlers', (src.match(INLINE) || []).length === 0);
  // Action buttons render only for provided callbacks — each page offers
  // exactly what it supports.
  assert('actions are callback-gated (onEdit/onAssign/onDuplicate/onArchive)',
    /typeof opts\.onEdit === 'function'/.test(src) && /typeof opts\.onArchive === 'function'/.test(src));

  // Wire-in 1: dashboard list — card body previews, ✎ Edit stays direct.
  const widgets = read(path.join(PRO_JS, 'dashboard-widgets.js'));
  assert('dashboard est-card body dispatches preview (Edit button keeps open)',
    /est-card-main" data-act="preview"/.test(widgets)
    && /data-act="open" title="Open & edit"/.test(widgets));
  assert('preview case falls back to viewEstimate when module absent',
    /case 'preview':[\s\S]{0,700}EstimatePreview\.open\(est/.test(widgets)
    && /case 'preview':[\s\S]{0,900}else if \(typeof viewEstimate === 'function'\) viewEstimate\(id\);/.test(widgets));

  // Wire-in 2: mobile job-detail Activity rows preview in place.
  const actions = read(path.join(PRO_JS, 'dashboard-actions.js'));
  assert('_mJdOpenEstimate previews over the job detail (edit = old path)',
    /function _mJdOpenEstimate\(estimateId\)[\s\S]{0,900}EstimatePreview\.open\(est/.test(actions));

  // Wire-in 3: customer page viewer prefers the shared sheet (fixes the
  // V2-shape mismatch) and keeps the legacy modal as fallback.
  const cust = read(path.join(PRO_JS, 'customer-bootstrap.module.js'));
  assert('customer viewEstimate prefers EstimatePreview with archive support',
    /window\.viewEstimate = function\(estimateId\)[\s\S]{0,1200}EstimatePreview\.open\(estimate[\s\S]{0,600}onArchive/.test(cust));
  assert('customer archive path stays a SOFT delete',
    /EstimatePreview\.open\(estimate[\s\S]{0,1400}deleted: true/.test(cust));

  // Both pages actually load the module.
  const dashHtml = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const custHtml = read(path.join(ROOT, 'docs/pro/customer.html'));
  assert('dashboard.html loads estimate-preview.js before dashboard-widgets',
    /estimate-preview\.js\?v=\d+"><\/script>\s*<script defer src="js\/dashboard-widgets\.js/.test(dashHtml));
  assert('customer.html loads estimate-preview.js', /estimate-preview\.js\?v=\d+/.test(custHtml));
}

section('Phase 1b: V2 builder mobile step navigation + always-visible total');
{
  const src = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  // The three panes become steps on mobile: Setup → Items → Review.
  assert('panes carry step classes',
    /class="v2-pane pane-setup"/.test(src)
    && /class="v2-pane pane-items"/.test(src)
    && /class="v2-pane right pane-review"/.test(src));
  assert('mobile step bar with mstep actions + live total button',
    /class="v2-mstep-bar" id="v2mStepBar"/.test(src)
    && /data-action="mstep" data-arg="1"/.test(src)
    && /data-action="mstep" data-arg="3"/.test(src)
    && /id="v2mTotal" data-action="mstep" data-arg="3"/.test(src));
  // Desktop untouched: the bar's base rule is display:none, and the
  // step-visibility rules live only inside the ≤1000px media query.
  assert('step bar hidden by default (desktop unaffected)',
    /\.v2-mstep-bar \{ display:none; \}/.test(src));
  assert('data-mstep visibility rules hide the other panes per step',
    /#estV2Modal\[data-mstep="1"\] \.pane-items/.test(src)
    && /#estV2Modal\[data-mstep="2"\] \.pane-review/.test(src)
    && /#estV2Modal\[data-mstep="3"\] \.pane-setup/.test(src));
  assert('dispatcher routes mstep to setMobileStep',
    /case 'mstep':[\s\S]{0,160}setMobileStep\(arg\)/.test(src)
    && /function setMobileStep\(n\)/.test(src));
  // The bar's total mirrors the grand total in BOTH renderScope branches
  // (empty state + priced), so it never shows a stale number. Since the
  // review of #1763 (2026-09-25) both print through _fmtTotal — cents when
  // the total has them (upgrade tax) — and must stay the SAME formatter.
  assert('live total mirrored into the step bar (both branches)',
    /mT0\.textContent = '\$0'/.test(src)
    && /totalEl\.textContent = _fmtTotal\(estimate\.total\)/.test(src)
    && /mT\.textContent = _fmtTotal\(estimate\.total\)/.test(src));
  // Reopen lands on Review (look-at-it step); fresh estimates on Setup.
  assert('open() starts at Review for reopen, Setup for fresh',
    /setMobileStep\(opts\.estimateId \? 3 : 1\)/.test(src));
}

section('Phase 2: template-first New Estimate front door');
{
  // Rock 2 PR 6 split startNewEstimate + showNewEstimateChooser into
  // estimate-entry.js while showEstimateTypeSelector stayed in estimates.js.
  // Concat both (same pattern as readMaps() in smoke/dashboard.test.js) so
  // these assertions keep covering the front door wherever it lives.
  const est = read(path.join(PRO_JS, 'estimates.js'))
    + '\n' + read(path.join(PRO_JS, 'estimate-entry.js'));
  // startNewEstimate leads with the chooser; everything stays V2-only
  // (Classic remains deprecated for new estimates).
  // startNewEstimate takes an EXPLICIT leadId (2026-07-27). The customer-scoped
  // entry points — the lead-edit-modal "Send Estimate" / "Send Service Quote" /
  // "Revise Estimate" chips — call startNewEstimate(leadId), but the chooser used
  // to read ONLY window._cardDetailLeadId, which is null unless a card-detail
  // modal happens to be open. So those chips opened a builder with no customer
  // attached. The global stays as the fallback for the callers that pass nothing.
  assert('startNewEstimate opens the template-or-blank chooser with the lead',
    /function startNewEstimate\(leadId\)[\s\S]{0,1600}showNewEstimateChooser\(leadId \|\| window\._cardDetailLeadId\);/.test(est));
  assert('chooser leads with From Template (recommended) + Start Blank V2',
    /From Template — Fastest/.test(est)
    && /Start Blank/.test(est)
    && /openEstimateV2Builder === 'function'\) window\.openEstimateV2Builder\(\);/.test(est));
  assert('template option load-then-runs the estimates bundle (race-safe)',
    /JobTemplatesUI\.openPicker === 'function'/.test(est)
    && /loadBundle\('estimates'\)\.then\(openJT\)/.test(est));
  // Both chooser branches must thread the resolved lead through, or the estimate
  // saves orphaned (leadId:null) and never reaches the pipeline stamp-back.
  assert('template option honors the lead the chooser was opened for',
    /function showNewEstimateChooser\(leadId\)/.test(est)
    && /openPicker\(leadId \? \{ leadId: leadId \} : \{\}\)/.test(est));
  assert('Start Blank also threads the lead into the V2 builder',
    (est.match(/openEstimateV2Builder\(leadId \? \{ leadId: leadId \} : \{\}\)/g) || []).length >= 2);
  const dashHtml = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  assert('estimates-view header button routes through startNewEstimate',
    /data-fn="startNewEstimate" title="New estimate — start from a job template/.test(dashHtml)
    && !/data-fn="openEstimateV2Builder" title="Build a new estimate with the V2 builder/.test(dashHtml));
}

section('Phase 3: homeowner presentation mode (Good/Better/Best)');
{
  const src = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  assert('Present button in the Review pane dispatches present',
    /data-action="present"[\s\S]{0,220}Present to Homeowner/.test(src));
  assert('presentation overlay lives INSIDE the modal (delegate coverage)',
    /pres\.className = 'v2-present';\s*modal\.appendChild\(pres\)/.test(src));
  // Tier cards drive the REAL tier path — same function as the Setup tabs.
  assert('set-tier and pres-tier share setTierChoice',
    /case 'set-tier':[\s\S]{0,500}setTierChoice\(arg\)/.test(src)
    && /case 'pres-tier':[\s\S]{0,120}setTierChoice\(arg\); openPresentation\(\)/.test(src));
  // Tri-tier pricing: per-SQ uses estimate.prices; line-item swaps
  // state.tier through getCurrentEstimate as a pure compute and always
  // restores; the current tier keeps the replay-aware truthful total.
  assert('triTierTotals prefers per-SQ prices and restores tier after swap',
    // Five tiers since 2026-10-02: the all-null map is _none() over _v2Tiers().
    /function triTierTotals\(current\)[\s\S]{0,400}current\.prices[\s\S]{0,1400}state\.tier = orig;/.test(src)
      && /const _none = \(\) => \{ const o = \{\}; _v2Tiers\(\)\.forEach\(t => \{ o\[t\] = null; \}\); return o; \};/.test(src));
  // The current tier still shows the truthful replay-aware total — but it is
  // no longer taken from a DIFFERENT code path than its siblings. That early
  // return (`if (t === orig) { out[t] = current.total; return; }`) meant the
  // selected card came from effectiveEstimate while the other two came from
  // getCurrentEstimate, so the three could disagree for reasons unrelated to
  // tier. It put GOOD $2,500 / BETTER $725 / BEST $2,500 in front of a
  // homeowner. All three now come from one source and the truthful figure is
  // applied afterwards, only when the two agree.
  assert('all three tiers are computed from ONE source (no per-tier early return)',
    !/if \(t === orig\) \{ out\[t\] = current\.total; return; \}/.test(src));
  assert('current tier still shows the truthful effectiveEstimate total',
    /const truth = current\.total;[\s\S]{0,400}out\[orig\] = truth;/.test(src));
  assert('a disagreement between the two sources collapses to a single tier, not a false compare',
    /Math\.round\(same\) !== Math\.round\(truth\)[\s\S]{0,160}return Object\.assign\(_none\(\), \{ \[orig\]: truth \}\);/.test(src));
  assert('tiers that all price identically collapse to one card',
    /vals\.every\(v => v === vals\[0\]\)[\s\S]{0,160}return Object\.assign\(_none\(\), \{ \[orig\]: out\[orig\] \}\);/.test(src));
  // Fewer than 2 priced tiers → single clean card, never a fake compare.
  assert('single-card fallback when tiers cannot be priced',
    /cardOrder\.length >= 2/.test(src) && /Full scope as reviewed with your estimator\./.test(src));
  // Homeowner-clean + handoff: Sign Now → existing BoldSign flow; close()
  // never leaves the overlay armed.
  assert('Sign Now hands off to sendForSignature',
    /case 'pres-sign':[\s\S]{0,120}sendForSignature\(\)/.test(src));
  assert('builder close() also closes the presentation',
    /m\.classList\.remove\('open'\);\s*closePresentation\(\)/.test(src));
}

section('Photo embeds: selected photos ride the estimate everywhere');
{
  const src = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  // Selection state + Review-pane picker grid.
  assert('state seeds photos[] + _leadPhotos cache',
    /photos: \[\],\s*\n\s*_leadPhotos: null,/.test(src));
  assert('Review pane has the photo picker grid + hint',
    /<div class="v2-section">Photos<\/div>/.test(src)
    && /id="v2photosGrid"/.test(src) && /id="v2photosHint"/.test(src));
  assert('loadLeadPhotos queries the lead\'s photo docs (guarded, capped)',
    /function loadLeadPhotos\(force\)[\s\S]{0,900}where\('leadId', '==', leadId\)/.test(src)
    && /\.slice\(0, 60\)/.test(src));
  assert('toggle-photo dispatches togglePhoto and marks the estimate dirty',
    /case 'toggle-photo':[\s\S]{0,120}togglePhoto\(arg\)/.test(src)
    && /function togglePhoto\(photoId\)[\s\S]{0,700}saveDraftDebounced\(\);/.test(src));
  // Persistence: saved doc, reopen, drafts.
  assert('_buildSavePayload persists the selection ({id,url} only)',
    /photos:\s*\(state\.photos \|\| \[\]\)\.map\(p => \(\{ id: p\.id \|\| null, url: p\.url \}\)\)/.test(src));
  assert('rehydrateFromSaved restores photos + refreshes the pick grid',
    /state\.photos = Array\.isArray\(doc\.photos\)[\s\S]{0,160}loadLeadPhotos\(true\);/.test(src));
  assert('drafts carry photos', /photos: state\.photos,/.test(src));
  // Ride-alongs: presentation strip + doc formats.
  assert('presentation mode renders the photo strip',
    /const photoStrip = \(state\.photos && state\.photos\.length\)/.test(src)
    && /photoStrip \+\s*'<div class="vp-cards">/.test(src));
  assert('finalize passes meta.photos to the formatters',
    /photos: \(state\.photos \|\| \[\]\)\.slice\(\),/.test(src));

  const fin = read(path.join(PRO_JS, 'estimate-finalization.js'));
  assert('photoBlock is print-safe and empty-selection-silent',
    /function photoBlock\(photos, accent\)[\s\S]{0,200}return '';/.test(fin)
    && /print-color-adjust:exact/.test(fin) && /page-break-inside:avoid/.test(fin));
  assert('retail + insurance formats embed the photo block (single-quote inherits retail)',
    /\$\{scopeBlock\}\s*\n\$\{photoBlock\(meta\.photos, _acc\)\}/.test(fin)
    && /\$\{photoSummary\}\s*\n\$\{photoBlock\(meta\.photos, _acc\)\}/.test(fin));

  const prev = read(path.join(PRO_JS, 'estimate-preview.js'));
  assert('preview sheet shows the photo thumbnail row',
    /Array\.isArray\(est\.photos\) && est\.photos\.length/.test(prev));

  // Homeowner share view: server whitelist passes URL-only entries; the
  // client renders them above the total.
  const portal = read(path.join(FUNCTIONS, 'portal.js'));
  assert('getEstimateForView whitelist passes photos URL-only',
    /photos:\s*Array\.isArray\(est\.photos\)[\s\S]{0,200}\.map\(p => \(\{ url: p\.url \}\)\)/.test(portal));
  const view = read(path.join(PRO_JS, 'estimate-view.js'));
  assert('shared view renders the Your Property photo grid',
    /Your Property/.test(view) && /est\.photos\.forEach/.test(view));
}

section('Items step: "✓ Selected (N)" filter shows WHAT is picked, not just how many');
{
  const src = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  // The catalog step showed a selection COUNT but never which items, so
  // checking your picks meant leaving for Review and coming back.
  assert('Selected chip renders only when something is selected',
    /const selectedCount = \(state\.scope \|\| \[\]\)\.length \+ \(\(state\.passThru \|\| \[\]\)\.length\)/.test(src)
    && /selectedCount\s*\?\s*`<button[^`]*data-arg="selected"[^`]*Selected \(\$\{selectedCount\}\)/.test(src));
  assert('selected view short-circuits catalog filtering',
    /if \(state\.categoryFilter === 'selected'\) \{\s*renderSelectedList\(catDiv, cat\);\s*return;\s*\}/.test(src));
  // Rows carry RESOLVED qty + line total (the real numbers), not catalog
  // list price — that's what makes it a scope list instead of a filter.
  assert('rows use resolved lines (qty + lineTotal) with catalog fallback',
    /function renderSelectedList\(catDiv, cat\)[\s\S]{0,900}getCurrentEstimate\(\)[\s\S]{0,300}byCode\[l\.code\] = l/.test(src)
    && /qty: line \? \(Number\(line\.quantity\) \|\| 0\) : null/.test(src));
  assert('pass-through lines are included in the selected view',
    /\(state\.passThru \|\| \[\]\)\.forEach\(p => \{[\s\S]{0,300}passThru: true/.test(src));
  assert('footer shows item count + running total',
    /const sum = rows\.reduce\(\(s, r\) => s \+ \(r\.total \|\| 0\), 0\)/.test(src));
  // × removes; its own dispatcher case because these are .v2-item cards,
  // not the Review pane's .v2-scope-item.
  assert('remove-selected case wired to removeFromScope',
    /case 'remove-selected':[\s\S]{0,400}removeFromScope\(code\)/.test(src)
    && /data-action="remove-selected" data-code="\$\{esc\(r\.code\)\}"/.test(src));
  // Two dead-end guards: removing the last pick, and searching from the view.
  assert('removing the last selection falls back to All',
    /if \(state\.categoryFilter === 'selected' && selectedCount === 0\) state\.categoryFilter = 'all';/.test(src));
  assert('typing a search leaves the Selected view',
    /if \(state\.searchFilter && state\.categoryFilter === 'selected'\) state\.categoryFilter = 'all';/.test(src));
  assert('empty selected view has a real empty state',
    /Nothing selected yet[\s\S]{0,120}Pick items from All or a category/.test(src));
}

section('Wave B3: live estimates snapshot');
{
  // CSP hotfix: subscribe wiring is in dashboard-bootstrap.module.js.
  const dash = readDashboard();
  assert('onSnapshot imported',    /onSnapshot/.test(dash));
  assert('_subscribeEstimates wired', /window\._subscribeEstimates/.test(dash));
  assert('subscribe called on auth ready',
    /window\._subscribeEstimates\(\)/.test(dash));
}

section('Team visibility: estimates readable by company_admin/manager (rules + client)');
{
  const rules = read(path.join(ROOT, 'firestore.rules'));
  const estBlock = rules.slice(rules.indexOf('match /estimates/'),
                              rules.indexOf('match /estimates/') + 2400);
  // Rule: every company reader (admin/manager/viewer) reads the tenant's estimates.
  assert('estimates rule grants isCompanyReader a company-scoped read',
    /allow read:[\s\S]{0,240}isCompanyReader\(\)[\s\S]{0,160}resource\.data\.companyId == myCompanyId\(\)/.test(estBlock));
  // Delete stays owner-only (not widened with read).
  // 2026-09-25 (Jo's decision B): and the owner must not be a viewer.
  assert('estimates delete stays owner-only (and never a viewer)',
    /allow delete:\s*if \(isOwner\(resource\.data\.userId\) && notViewer\(\)\) \|\| isAdmin\(\);/.test(estBlock));
  // Create pins companyId to the caller's tenant (no cross-tenant injection).
  assert('estimates create pins companyId to the caller tenant',
    /allow create:[\s\S]{0,240}request\.resource\.data\.companyId == request\.auth\.token\.get\(\s*['"]companyId['"]/.test(estBlock));
  // Edit freezes companyId so an estimate can't be re-tenanted.
  assert('estimates update freezes companyId',
    /allow update:[\s\S]{0,120}didNotChange\(\[[^\]]*['"]companyId['"]/.test(estBlock));

  const dash = readDashboard();
  // Client stamps companyId on create so the company read has something to match.
  assert('_saveEstimate stamps companyId on create',
    /addDoc\(collection\(db,'estimates'\)[\s\S]{0,200}companyId:\s*\(window\._userClaims/.test(dash));
  // loadEstimates + subscription add the companyId scope for every company reader.
  assert('loadEstimates adds a companyId scope for company readers',
    /async function loadEstimates[\s\S]{0,900}\['company_admin','manager','viewer'\]\.includes\(claims\.role[\s\S]{0,160}where\('companyId','==',claims\.companyId\)/.test(dash));
  assert('_subscribeEstimates adds a team (companyId) listener, merged by id',
    /_subscribeEstimates[\s\S]{0,900}teamRead[\s\S]{0,1800}where\('companyId', '==', claims\.companyId\)/.test(dash));
}

section('F7: V2 Builder autosave');
{
  const src = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  assert('saveDraftDebounced called from render',
    // 600 (was 400): render() now opens with the tier shingle lock (2026-10-02).
    /function render\(\)[\s\S]{0,600}saveDraftDebounced\(\)/.test(src));
  assert('collectDraft bundles state',
    /function collectDraft\(\)[\s\S]{0,400}scope:\s*state\.scope/.test(src));
  assert('restoreDraft merges local + remote',
    /function restoreDraft[\s\S]{0,600}estimate_drafts/.test(src));
  assert('clearDraft on successful save',
    /window\._v2SavedEstimateId = savedId[\s\S]{0,200}clearDraft\(\)/.test(src));
  const rules = read(path.join(ROOT, 'firestore.rules'));
  assert('estimate_drafts rules: owner only',
    /match \/estimate_drafts\/\{uid\}[\s\S]{0,200}isOwner\(uid\)/.test(rules));
}

section('F8: Voice memo transcription');
{
  const srv = read(path.join(FUNCTIONS, 'integrations/voice-memo.js'));
  assert('transcribeVoiceMemo callable exported',
    /exports\.transcribeVoiceMemo\s*=/.test(srv));
  assert('rate-limited 20/hour/uid',
    /callable:transcribeVoiceMemo:uid[\s\S]{0,80}20,\s*60 \* 60_000/.test(srv));
  assert('audio size capped',
    /MAX_AUDIO_BYTES\s*=\s*1_500_000/.test(srv));
  assert('writes activity on the lead',
    /type: 'voice_memo'/.test(srv));
  const cli = read(path.join(PRO_JS, 'voice-memo.js'));
  assert('client exposes window.NBDVoiceMemo',
    /window\.NBDVoiceMemo\s*=/.test(cli));
  assert('client uses MediaRecorder',
    /new MediaRecorder/.test(cli));
  const shared = read(path.join(FUNCTIONS, 'integrations/_shared.js'));
  assert('DEEPGRAM_API_KEY in secrets registry',
    /DEEPGRAM_API_KEY:\s*defineSecret\('DEEPGRAM_API_KEY'\)/.test(shared));
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  // Voice memo button on the lead detail modal. The label was
  // shortened from "Record Voice Memo" to "Voice Memo" in the
  // 2026-05-05 modal redesign (cd-share-row), so the assertion
  // checks for the wiring (NBDVoiceMemo.recordForLead) AND the
  // label text — both must be present for the button to actually
  // record a memo. If you rename the label, update the regex but
  // KEEP the recordForLead wiring check.
  assert('Voice Memo button on lead detail',
    /(Voice Memo|Record Voice Memo)/.test(dash) &&
    /data-action="call" data-fn="cdaVoiceMemo"/.test(dash));
  const idx = readFunctionsIndex();
  assert('integrationStatus reports deepgram',
    /deepgram:\s*_hasInt\('DEEPGRAM_API_KEY'\)/.test(idx));
}

section('F9: Feature flags');
{
  const cli = read(path.join(PRO_JS, 'feature-flags.js'));
  assert('client exposes window.NBDFlags',
    /window\.NBDFlags\s*=/.test(cli));
  assert('reads _default + per-uid override',
    /feature_flags.*_default[\s\S]{0,400}window\._user\.uid/.test(cli));
  const rules = read(path.join(ROOT, 'firestore.rules'));
  assert('_default readable by authed users',
    /match \/feature_flags\/_default[\s\S]{0,200}allow read: if isAuth\(\)/.test(rules));
  assert('platform admin is the only writer',
    /match \/feature_flags\/_default[\s\S]{0,300}allow write: if isAdmin\(\)/.test(rules));
}

// ── V2 preview: titleMap key matches button data-arg ─────────
section('V2 preview titleMap alignment');
{
  const src = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  assert('finalize button data-arg uses internal-view',
    /data-arg="internal-view"/.test(src));
  assert("titleMap has 'internal-view' key (not legacy 'internal')",
    /'internal-view'\s*:/.test(src) && !/'internal'\s*:/.test(src));
  assert('FORMAT_ALIASES maps legacy names',
    /FORMAT_ALIASES\s*=\s*\{[^}]*internal:/.test(src));
  assert('guards formatter exception with try/catch',
    /formatEstimate\s*\(estimate,\s*format,\s*meta\);[\s\S]{0,200}catch/.test(src));
}

// ════════════════════════════════════════════════════════════════════
// JOB TEMPLATES — existence + CSP wiring smoke (appended 2026-07-19,
// job-templates harness buildout; deep data/engine coverage lives in
// tests/job-templates.test.js).
//
// The trio is authored in PARALLEL sessions and lands in arbitrary
// order, so every check is per-file soft-skip: absent → note + skip,
// present → locked in. No cross-file dependency asserts (they'd redline
// CI between landings). Durable existence protection after buildout:
// each landed file must be wired into the script-loader estimates
// bundle (smoke-tests-assert-existence RULE — grep tests/ before
// deleting code; this block is that tripwire).
// ════════════════════════════════════════════════════════════════════
section('Job Templates: existence + CSP wiring');
{
  const fs = require('fs');
  const JT_FILES = ['job-templates-data.js', 'job-templates.js', 'job-templates-ui.js'];
  const present = JT_FILES.filter(f => fs.existsSync(path.join(PRO_JS, f)));
  if (present.length === 0) {
    console.log('  (skip — job-templates files not present yet)');
  } else {
    for (const f of JT_FILES) {
      if (!present.includes(f)) { console.log('  (skip — ' + f + ' not present yet)'); continue; }
      assert('docs/pro/js/' + f + ' exists on disk', fs.existsSync(path.join(PRO_JS, f)));
    }
    // Wiring: every LANDED file must ride the estimates bundle in
    // script-loader.js (a landed-but-unwired file is dead code; checked
    // only for present files so parallel landing order never reds CI).
    const loaderPath = path.join(PRO_JS, 'script-loader.js');
    if (fs.existsSync(loaderPath)) {
      const loader = read(loaderPath);
      for (const f of present) {
        assert(f + ' is wired into the script-loader estimates bundle',
          new RegExp('js/' + f.replace(/[.]/g, '\\.')).test(loader));
      }
    }

    // CSP: /pro ships script-src WITHOUT 'unsafe-inline' — zero inline
    // on*= handler strings allowed, even inside JS-generated markup
    // (csp-onclick sweep RULE). Named-event match avoids false hits on
    // identifiers like "online".
    const INLINE_HANDLER_RE = /\son(?:click|dblclick|change|input|submit|reset|load|error|focus|blur|keydown|keyup|keypress|mouseover|mouseout|mouseenter|mouseleave|mousedown|mouseup|touchstart|touchend|contextmenu|scroll|wheel|dragstart|dragover|drop|paste|copy)\s*=\s*["'`]/gi;
    for (const f of present) {
      const src = read(path.join(PRO_JS, f));
      const hits = (src.match(INLINE_HANDLER_RE) || []).length;
      assert(f + ' has zero inline on*= handler strings', hits === 0,
        'found ' + hits + ' inline handler attribute(s)');
    }

    // UI delegate: ONE delegated listener keyed on data-jt-action (the
    // delegate must load on the page that renders the markup).
    if (present.includes('job-templates-ui.js')) {
      const ui = read(path.join(PRO_JS, 'job-templates-ui.js'));
      assert('job-templates-ui.js uses data-jt-action attributes', /data-jt-action/.test(ui));
      assert('job-templates-ui.js binds its delegated listener (addEventListener + data-jt-action)',
        /addEventListener\(\s*['"](?:click|change|input)['"]/.test(ui) && /data-jt-action|jtAction/.test(ui));
    } else {
      console.log('  (skip — job-templates-ui.js delegate check awaits the file)');
    }
  }
}

section('Per-line supplement money: item decisions, per-line notes, per-item photos');
{
  const supUi = read(path.join(PRO_JS, 'supplement-ui.js'));
  const v2    = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  const fin   = read(path.join(PRO_JS, 'estimate-finalization.js'));

  // ── Behavioral: the engine is Node-requirable — exercise it directly. ──
  const eng = require(path.join(PRO_JS, 'estimate-supplement.js'));
  const s = eng.createSupplement({ rows: [], grandTotal: 1000 }, { leadId: 'L1', parentEstimateId: 'E1' });
  eng.addItem(s, { code: 'RFG X', name: 'Item X', quantity: 2, materialCost: 10, laborCost: 5 });
  assert('setItemPhotos replaces an item photo set by index and drops falsy entries',
    eng.setItemPhotos(s, 'added', 0, [{ id: 'p1', url: 'https://ex/p1.jpg' }, null]) === true
    && s.addedItems[0].photos.length === 1 && s.addedItems[0].photos[0].url === 'https://ex/p1.jpg');
  assert('setItemPhotos rejects an out-of-range index',
    eng.setItemPhotos(s, 'added', 5, [{ id: 'p2', url: 'u' }]) === false);
  assert('sanitizeItemDecisions clamps unknown verdicts to approved and null on empty',
    eng.sanitizeItemDecisions(null) === null
    && eng.sanitizeItemDecisions([])   === null
    && eng.sanitizeItemDecisions([{ kind: 'x', index: '1', decision: 'weird', requested: '30', approved: '20' }])[0].decision === 'approved'
    && eng.sanitizeItemDecisions([{ decision: 'denied' }])[0].decision === 'denied'
    && eng.sanitizeItemDecisions([{ kind: 'modified', decision: 'reduced' }])[0].kind === 'modified');
  eng.recordResponse(s, { status: 'partial', approvedAmount: 20, itemDecisions: [
    { kind: 'added', index: 0, code: 'RFG X', name: 'Item X', requested: 30, approved: 20, decision: 'reduced' },
  ]});
  assert('recordResponse stores sanitized per-line verdicts on submission.itemDecisions',
    Array.isArray(s.submission.itemDecisions) && s.submission.itemDecisions[0].decision === 'reduced'
    && s.submission.itemDecisions[0].approved === 20);
  assert('recordResponse without decisions stores null (plain single-figure responses stay valid)',
    (eng.recordResponse(eng.createSupplement({ rows: [] }, {}), { status: 'approved' })).submission.itemDecisions === null);

  // ── Firestore persist path carries the same field. ──
  const engSrc = read(path.join(PRO_JS, 'estimate-supplement.js'));
  assert('updateResponse persists submission.itemDecisions via the sanitizer',
    /'submission\.itemDecisions':\s*sanitizeItemDecisions\(response\.itemDecisions\)/.test(engSrc));
  assert('formal letter embeds per-item photo strips ({id,url} entries, print-safe) in added AND modified rows',
    /photoStripHtml = \(photos\)/.test(engSrc)
    && /print-color-adjust:exact/.test(engSrc)
    && /\$\{photoStripHtml\(item\.photos\)\}/.test(engSrc)
    && /\$\{photoStripHtml\(mod\.photos\)\}/.test(engSrc));

  // ── Response-recording UI: per-line decision editor + saved summary. ──
  assert('partial response renders the per-line decision editor (kind/index/code/requested data attrs)',
    /nbd-sup-dec-row/.test(supUi)
    && /data-kind="' \+ it\.kind/.test(supUi)
    && /data-requested="' \+ it\.requested/.test(supUi));
  assert('decision editor auto-sums enabled lines into the billable amount field',
    /const resum = function \(\)/.test(supUi)
    && /sum \+= Number\(a && a\.value\) \|\| 0/.test(supUi));
  assert('_collectDecisions maps unchecked→denied and short-paid→reduced',
    /!\(on && on\.checked\) \? 'denied'/.test(supUi)
    && /approved < requested - 0\.005 \? 'reduced' : 'approved'/.test(supUi));
  assert('save passes itemDecisions through updateResponse and mirrors them locally',
    /itemDecisions:\s*itemDecisions,/.test(supUi)
    && /s\.submission\.itemDecisions = itemDecisions/.test(supUi));
  assert('saved verdicts render as a Requested vs Approved table with ✓/✗/↓ chips',
    /_decisionsSummaryHtml/.test(supUi)
    && />Requested<\/th>/.test(supUi) && />Approved<\/th>/.test(supUi)
    && /✗ Denied/.test(supUi) && /✓ Approved/.test(supUi) && /↓ Reduced/.test(supUi));

  // ── Per-item photos UI. ──
  assert('each supplement row gets a 📷 button keyed by kind+index',
    /class="nbd-sup-photo" data-kind="' \+ kind \+ '" data-idx="' \+ idx/.test(supUi));
  assert('photo picker queries the lead\'s photos collection and excludes deleted',
    /window\.where\('leadId', '==', leadId\)/.test(supUi)
    && /p\.url && !p\.deleted/.test(supUi));
  assert('picker attaches {id,url} entries via setItemPhotos',
    /\.map\(p => \(\{ id: p\.id, url: p\.url \}\)\)/.test(supUi)
    && /setItemPhotos\(sup, kind, idx, chosen\)/.test(supUi));

  // ── V2 per-line notes. ──
  assert('overrideNote lives on scope overrides, caps at 500 chars, blank deletes',
    /function overrideNote\(code\)/.test(v2)
    && /trimmed\.slice\(0, 500\)/.test(v2)
    && /delete scopeEntry\.overrides\.note/.test(v2));
  assert('scope rows render the 📝 note button + note line through the delegate',
    /data-action="edit-note"/.test(v2)
    && /case 'edit-note':/.test(v2)
    && /class="line-note"/.test(v2));
  assert('saved rows persist the note and reopen restores it into overrides',
    /note:\s*\(\(state\.scope \|\| \[\]\)\.find\(s => s\.code === line\.code\)\?\.overrides\?\.note \?\? null\)/.test(v2)
    && /r\.note \? \{ note: String\(r\.note\) \} : \{\}/.test(v2));
  assert('_stampLineNotes decorates resolved lines before BOTH formatEstimate calls',
    /function _stampLineNotes\(estimate\)/.test(v2)
    && (v2.match(/_stampLineNotes\(estimate\);/g) || []).length >= 2);

  // ── Documents print the note. ──
  assert('insurance scope rows print the rep note (escaped, distinct from catalog reason)',
    /line\.repNote/.test(fin) && /escapeHtml\(line\.repNote\)/.test(fin));
  assert('retail bullets carry the note as an italic sub-line',
    /note: l\.repNote \|\| ''/.test(fin) && /escapeHtml\(b\.note\)/.test(fin));
}

section('Neutral county default: "Other / My county" everywhere, no Hamilton coercion');
{
  // First-run audit 2026-07-28: every new estimate defaulted to Hamilton
  // County, OH — permit $185 + 7.80% tax + "Hamilton County, OH" on customer
  // paper — for EVERY tenant, with no way to express any other jurisdiction.
  // The neutral '' county rides the engines' existing fail-safes ($150
  // permit, 7% tax), so these checks pin the UI surface, not the math.
  const v2ui = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  assert('#v2county leads with the neutral <option value="">Other / My county</option>',
    /<select id="v2county"[^>]*>\s*<option value="">[^<]*Other\s*\/\s*My county/i.test(v2ui));
  assert('#v2county still offers all 7 named OH/KY counties',
    ['hamilton-oh', 'butler-oh', 'warren-oh', 'clermont-oh', 'kenton-ky', 'boone-ky', 'campbell-ky']
      .every(slug => new RegExp('<option value="' + slug + '">').test(v2ui)));
  assert("V2 session state defaults county to '' (neutral, not hamilton-oh)",
    /county: '',/.test(v2ui) && !/county: 'hamilton-oh'/.test(v2ui));

  const engine = read(path.join(PRO_JS, 'estimate-builder-v2.js'));
  assert('blank-jurisdiction permit line renders "Local Jurisdiction" (customer paper), not "jurisdiction not set"',
    /Local Jurisdiction/.test(engine) && !/jurisdiction not set/.test(engine));

  const jtUi = read(path.join(PRO_JS, 'job-templates-ui.js'));
  assert("job-templates-ui.js no longer coerces blank county to 'hamilton-oh'",
    !/\|\| 'hamilton-oh'/.test(jtUi));
  assert("job-templates-ui.js countyOptions leads with the '' Other / My county option",
    /value: '',\s*label: 'Other \/ My county'/.test(jtUi));

  const jtEngine = read(path.join(PRO_JS, 'job-templates.js'));
  assert("job-templates.js engine no longer defaults opts.county to 'hamilton-oh'",
    !/opts\.county \|\| 'hamilton-oh'/.test(jtEngine)
    && /opts\.county \|\| ''/.test(jtEngine));
  assert('job-templates.js payload stamps null (not hamilton-oh) when no county picked',
    /county:\s*resolved\.county \|\| meta\.county \|\| null,/.test(jtEngine));
}

section('Custom jurisdictions: per-tenant rows reach both pickers + the engine (county-jurisdiction settings)');
{
  // County-jurisdiction settings 2026-07-29: a tenant's "My Jurisdictions"
  // rows (companyProfile.pricing.customJurisdictions) must appear in the V2 +
  // JT county pickers and price the permit line + cash tax on every path.
  // Behavioral coverage lives in tests/custom-jurisdictions.test.js; these
  // pins hold the lexical wiring together.

  // (a) V2 picker: tenant options are APPENDED after the 7 static option
  // literals (the neutral-'' head + 7-literal pins above must keep matching
  // the static markup) — the injection expression sits right after the last
  // static option, before </select>.
  const v2ui = read(path.join(PRO_JS, 'estimate-v2-ui.js'));
  assert('#v2county appends tenant options AFTER the static campbell-ky literal',
    /<option value="campbell-ky">Campbell County, KY<\/option>[^<]{0,40}\$\{_tenantCountyOptions\(\)\}/.test(v2ui));
  assert('v2-ui builds tenant options from companyProfile with HTML-escaped names',
    /function _tenantCountyOptions\(/.test(v2ui)
    && /customJurisdictions/.test(v2ui)
    && /_tenantCountyOptions[\s\S]{0,600}replace\(\/&\/g, '&amp;'\)/.test(v2ui));

  // (b) JT picker: '' Other literal stays FIRST; canonical 7 come from the
  // engine's PERMIT_COSTS export (present on customer.html via inline
  // fallbacks); custom jurisdictions append with their STORED names.
  const jtUi = read(path.join(PRO_JS, 'job-templates-ui.js'));
  assert("countyOptions still leads with the '' Other literal and sources the 7 from EstimateBuilderV2.PERMIT_COSTS",
    /var other = \{ value: '', label: 'Other \/ My county' \};\s*var opts = \[other\];/.test(jtUi)
    && /window\.EstimateBuilderV2/.test(jtUi)
    && /eb2 && eb2\.PERMIT_COSTS/.test(jtUi));
  assert('countyOptions appends custom jurisdictions with their stored display names',
    /customJurisdictions/.test(jtUi));

  // (c) Engine: jurisdictions overlay + overlaid-tax-map getter.
  const engine = read(path.join(PRO_JS, 'estimate-builder-v2.js'));
  assert('engine reads pricing.customJurisdictions behind the typeof-window guard (Node no-op)',
    /function _tenantJurisdictions\(/.test(engine)
    && /_tenantJurisdictions[\s\S]{0,400}typeof window !== 'undefined'[\s\S]{0,200}customJurisdictions/.test(engine));
  // The overlay must be applied at EVERY county-resolving entry point or one
  // estimate prices differently depending on which path computed it. Renamed
  // _withTenantJurisdictions -> _withTenantCounties when the canonical-7
  // overrides joined it (per-tenant county migration); the pin follows the
  // INTENT — both call sites go through the one overlay.
  // 2026-08-19: the pin now matches the CALL, not the whole statement. The
  // cost overlay (_withTenantCosts, tenant job/labor/xact/v2 cost books) wraps
  // these same call sites — `_withTenantCosts(_withTenantCounties(...))` — and
  // an exact-statement pin failed on a change that preserved the invariant it
  // exists to protect. Pinning the surrounding syntax rather than the property
  // makes a guard cry wolf, which is how guards get loosened for real.
  assert('the tenant county overlay applies in applyCompanyPricing AND calculateLineItem',
    /_withTenantCounties\(out\)/.test(engine)
    && /_withTenantCounties\(input\.settingsOverride \|\| loadSettings\(\)\)/.test(engine));
  // Same invariant, same reason, for the cost overlay: an estimate must not
  // price differently depending on which path computed it.
  assert('the tenant COST overlay applies at both pricing entry points',
    /_withTenantCosts\(_withTenantCounties\(settings \|\| loadSettings\(\)\)\)/.test(engine)
    && /_withTenantCosts\(_withTenantCounties\(input\.settingsOverride \|\| loadSettings\(\)\)\)/.test(engine));
  // ...and NOT inside loadSettings(), which is contractually pure so a
  // late-arriving companyProfile or cost book still reaches the next price
  // (tests/custom-jurisdictions.test.js pins the county half of this).
  assert('loadSettings() stays pure — neither overlay is baked in',
    !/if \(!raw\) return _withTenant/.test(engine));
  assert('getCountyTaxMap routes through the SAME overlay (JT / EstimateLogic parity)',
    /return _withTenantCounties\(loadSettings\(\)\)\.countyTax;/.test(engine));
  assert('engine exports getCountyTaxMap (loadSettings().countyTax + tenant overlay)',
    /function getCountyTaxMap\(/.test(engine)
    && /getCountyTaxMap,/.test(engine));
  const logic = read(path.join(PRO_JS, 'estimate-logic-engine.js'));
  assert('EstimateLogic prefers EstimateBuilderV2.getCountyTaxMap, keeps the loadSettings fallback',
    /typeof window\.EstimateBuilderV2\.getCountyTaxMap === 'function'/.test(logic)
    && /window\.EstimateBuilderV2\.loadSettings\(\)\.countyTax \|\| \{\}/.test(logic));

  // (d) Settings markup on the dashboard. (This loop used to pin parity
  // across both dashboard twins; the legacy twin was retired 2026-09-02.)
  const bootSrc = read(path.join(PRO_JS, 'dashboard-bootstrap.module.js'));
  for (const page of ['docs/pro/dashboard.html']) {
    const src = read(path.join(ROOT, page));
    assert(page + ' has the #jurRows container + Add Jurisdiction data-fn wiring',
      /id="jurRows"/.test(src)
      && /data-action="call" data-fn="_addJurisdictionRow"/.test(src));
  }
  assert('add/remove jurisdiction handlers registered in the __NBD_CALL_REGISTRY block (not window-exported)',
    /_addJurisdictionRow: _addJurisdictionRow,/.test(bootSrc)
    && /_removeJurisdictionRow: _removeJurisdictionRow,/.test(bootSrc)
    && !/window\._addJurisdictionRow\s*=/.test(bootSrc)
    && !/window\._removeJurisdictionRow\s*=/.test(bootSrc));
  // Delete semantics: _saveCompanyProfile deep-merges (setDoc {merge:true}
  // merges nested map keys), which would resurrect deleted rows — the save
  // must full-replace the field at its dot-notation path.
  assert('save full-replaces pricing.customJurisdictions (deleted rows must not resurrect)',
    /'pricing\.customJurisdictions': customJurisdictions/.test(bootSrc));
  // Custom rows must NOT ride the per-device localStorage patch or the dead
  // userSettings sink — companyProfile is the single store.
  assert('customJurisdictions never enters the localStorage settings patch',
    !/patch\.customJurisdictions/.test(bootSrc));
  // Review follow-ups (2026-07-29): a pre-hydration empty render must never
  // be persisted as a tenant-wide wipe, and the full-replace must target the
  // same doc key as _saveCompanyProfile.
  // 2026-09-25 (lane profretry): the rows must also have been PAINTED from
  // the hydrated profile (jurReady), not merely hydrated by save time — and
  // (second review of #1774) painted for the tenant the save writes to.
  assert('jurisdiction render/save gate on companyProfile hydration (wipe-race fix)',
    /window\._companyProfileLoaded === true/.test(bootSrc)
    && /window\._companyProfileLoaded = true/.test(read(path.join(PRO_JS, 'company-profile.js')))
    && /const jurReady = profileReady && _jurRowsResolved && paintedHere\(_jurRowsKey\);/.test(bootSrc)
    && /jurReady \? _collectJurisdictionRows\(\) : null/.test(bootSrc));
  assert('full-replace resolves the company key via the shared resolver',
    /window\._resolveCompanyKey/.test(bootSrc)
    && /window\._resolveCompanyKey = _resolveCompanyKey/.test(read(path.join(PRO_JS, 'company-profile.js'))));
  // Stale-options fix: the V2 modal template bakes once per page life, so the
  // tenant tail of #v2county must refresh on every open().
  assert('#v2county tenant option tail refreshes on modal open',
    /_refreshTenantCountyOptions\(\);/.test(v2ui)
    && /data-tenant-option/.test(v2ui));
}

};
