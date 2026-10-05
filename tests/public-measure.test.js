/**
 * tests/public-measure.test.js — measuring a public estimate lead's roof.
 *
 * WHY THIS EXISTS
 * ───────────────
 * This is the first thing in the repo that spends money with no human in the
 * loop: a homeowner completes the /estimate wizard and the server buys a $3
 * aerial measurement. Everything below exists to pin the guards that keep that
 * from becoming a bill —
 *
 *   1. only ONE code path may spend (the trigger), and the endpoint the
 *      anonymous wizard calls is read-only;
 *   2. the trigger is gated to bridged estimate leads that carry coordinates;
 *   3. a redelivery collides on a deterministic doc id instead of re-billing;
 *   4. there is a daily cap and a no-deploy kill switch;
 *   5. only homeowner-safe fields cross to the public document;
 *   6. the kanban chip cannot render vendor-supplied markup.
 *
 * Pure-Node, no network, no emulator. Run: node tests/public-measure.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '').replace(/\s\/\/[^\n]*$/mg, '');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

let PM = null, loadError = null;
try { PM = require(path.join(FUNCTIONS, 'integrations', 'public-measure.js')); } catch (e) { loadError = e; }

section('module loads (the CI "require every integration module" gate)');
ok('require() succeeds', !loadError, loadError && loadError.message);
ok('_test seam present', !!(PM && PM._test && PM._test.publicSummary && PM._test.measureLeadAndPublish));

const src = codeOnly(read('functions/integrations/public-measure.js'));

section('exactly one code path may spend money');
{
  ok('the trigger is the only caller of requestInstantRoofer',
    (src.match(/requestInstantRoofer/g) || []).length === 1);
  ok('publicRoofMeasure never calls the vendor, only reads the lead doc',
    /exports\.publicRoofMeasure = onRequest/.test(src)
    && !/publicRoofMeasure[\s\S]*requestInstantRoofer/.test(src)
    && /ref\.get\(\)/.test(src));
  ok('the read-only endpoint has NO enforceAppCheck (dead config on onRequest, and CI rejects it)',
    !/enforceAppCheck/.test(src));
  ok('only the trigger binds the API keys (Instant Roofer + Google Solar for NBD_MEASUREMENT_PROVIDER=solar|auto)',
    /secrets: \[SECRETS\.INSTANTROOFER_API_KEY, SECRETS\.SOLAR_API_KEY\]/.test(src)
    && (src.match(/SECRETS\.SOLAR_API_KEY/g) || []).length === 1
    && (src.match(/SECRETS\.INSTANTROOFER_API_KEY/g) || []).length === 1);
  ok('both exports keep the literal factory RHS the deploy allowlist greps for',
    /^exports\.measureNewWebLead = onDocumentCreated/m.test(src)
    && /^exports\.publicRoofMeasure = onRequest/m.test(src));
}

section('the trigger is gated so it cannot bill the wrong things');
{
  ok('CRM-entered leads are skipped (webLead must be true)', /lead\.webLead !== true\) return;/.test(src));
  ok('only estimate-funnel leads (a contact/Thumbtack lead never measures)', /lead\.publicLeadKind !== 'estimate'\) return;/.test(src));
  ok('a lead with no usable coordinates is skipped, never geocoded blind',
    /!IR\.validateCoords\(lead\.lat, lead\.lng\)\.ok/.test(src));
  ok('it fires on leads/{leadId}, NOT estimate_leads — a completed funnel writes up to 4 public docs but only one CRM lead',
    /document: 'leads\/\{leadId\}'/.test(src) && !/document: 'estimate_leads/.test(src));
  ok('60s timeout (the vendor answers in 10-20s; 30s dies mid-call, after billing)', /timeoutSeconds: 60/.test(src));
  ok('retry:false — a paid call must never be auto-retried', /retry: false/.test(src));
  ok('the handler never throws (a throw on a paid trigger is a retry)', /measureNewWebLead threw/.test(src));
}

section('spend guards');
{
  ok('a redelivery collides on a deterministic doc id instead of re-billing',
    // jobId defaults to 'weblead-'+leadId; the CRM auto-order passes 'auto-'+leadId.
    /const jobId = jobDocId \|\| \('weblead-' \+ leadId\)/.test(src) && /\.doc\(jobId\)/.test(src)
      && /jobRef\.create\(jobDoc\)/.test(src) && /e\.code === 6/.test(src));
  ok('same-roof reuse is attempted before the vendor is called',
    src.indexOf('findReusableMeasurement') < src.indexOf('requestInstantRoofer'));
  ok('a daily cap on AUTOMATED spend exists', /trigger:measureNewWebLead:daily/.test(src) && /AUTO_MEASURE_DAILY_CAP/.test(src));
  ok('the cap is a sane multiple of real volume (~1 lead/day), not unbounded',
    PM && PM._test.AUTO_MEASURE_DAILY_CAP >= 5 && PM._test.AUTO_MEASURE_DAILY_CAP <= 50);
  ok('the daily cap does NOT reuse the rep-facing 5/min account meter (a storm burst must not starve the rep on a roof)',
    !/INSTANTROOFER_PER_MINUTE/.test(src));
  ok('a no-deploy kill switch is checked before spending', /isWebLeadMeasureDisabled\(\)/.test(src));
  ok('the kill switch is a real flag on feature_flags/global',
    /webLeadMeasureDisabled/.test(codeOnly(read('functions/integrations/killswitch.js')))
    && /isWebLeadMeasureDisabled/.test(read('functions/integrations/killswitch.js')));
  ok('killswitch still exports its original surface', (() => {
    const K = require(path.join(FUNCTIONS, 'integrations', 'killswitch.js'));
    return typeof K.isAiDisabled === 'function' && typeof K.isWebLeadMeasureDisabled === 'function' && typeof K._resetCache === 'function';
  })());
  ok('the public endpoint buckets IPv6 by /64 (a raw v6 key is no cap at all)',
    /rateLimitIpKey\(clientIp\(req\)\)/.test(src));
  ok('...using the canonical helper, not a hand-rolled fork', /require\('\.\.\/rate-limit'\)/.test(src));
}

section('an automatically measured web lead is billable like any other');
{
  ok('the web-lead measurement doc is pass-through eligible',
    /passThruEligible: true,/.test(src) && !/passThruEligible: false/.test(src));
  ok('...but carries no document, so the quote line reads as a service performed',
    /passThruHasDocument: false/.test(src));
}

section('only a BRIDGE-created lead may spend or write back (client-set fields are not trusted)');
if (PM && PM._test && PM._test.bridgedEstimateId) {
  const B = require(path.join(FUNCTIONS, 'lead-bridge-logic.js'));
  const f = PM._test.bridgedEstimateId;
  // Positive control: the bridge's OWN mapper + id for a real estimate lead.
  const srcId = 'aB3xYz09QrStUvWx12Cd';
  const real = B.mapPublicLeadToLead({ collection: 'estimate_leads', sourceId: srcId, data: { name: 'ZZ_QA Test', address: '1 Test St' }, ownerUid: 'o1', companyId: 'c1' });
  const realId = B.bridgeDocId('estimate_leads', srcId);
  ok('a real bridged estimate lead passes (positive control — the gate did not switch the feature off)', f(real, realId) === srcId);
  ok('a hand-made lead with the same fields but its own doc id is refused', f(real, 'clientChosenId') === null);
  ok('a lead aiming the write at another collection is refused',
    f(Object.assign({}, real, { publicLeadCollection: 'users', publicLeadId: 'victimUid' }), B.bridgeDocId('users', 'victimUid')) === null);
  ok('a path-shaped public id is refused', f(Object.assign({}, real, { publicLeadId: 'x/../../users/victim' }), 'estimate_leads__x/../../users/victim') === null);
  ok('non-estimate / non-web leads are refused', f(Object.assign({}, real, { publicLeadKind: 'contact' }), realId) === null && f(Object.assign({}, real, { webLead: false }), realId) === null);
  ok('the paid trigger checks it before spending', src.indexOf('bridgedEstimateId(lead, leadId)') > 0 && src.indexOf('bridgedEstimateId(lead, leadId)') < src.indexOf('isWebLeadMeasureDisabled()'));
  ok('the write-back uses the fixed collection, never a path read off the lead',
    /db\.collection\(ESTIMATE_COLLECTION\)\.doc\(pubId\)/.test(src) && !/db\.doc\(`\$\{coll\}/.test(src) && !/lead\.publicLeadCollection;/.test(src));
} else {
  ok('bridgedEstimateId exported on the test seam', false);
}

section('publicSummary — only homeowner-safe fields cross the line');
if (PM && PM._test) {
  const full = {
    rawSqft: 3482.4, footprintSqft: 3214, suggestedSqft: 3866, squares: 38.7,
    pitch: '5/12', perimeterLf: 251, facets: 8, stories: 1, complexity: 2,
    complexityLabel: 'High', wastePct: 11,
    confidence: { score: 0.408, label: 'High' },
    isTownhome: false, isCommercial: false, reportUrl: null, source: 'instantroofer-ai'
  };
  const s = PM._test.publicSummary(full);
  // 3482.4 sq ft of roof = 34.8 squares. NOT the fixture's `squares: 38.7`,
  // which is the vendor's suggested/100 (3866/100) — its material-order figure
  // with waste already added.
  ok('carries the numbers the estimate is built from', s.sqft === 3482 && s.squares === 34.8 && s.pitch === '5/12');
  ok('carries the caveat fields (confidence, complexity, stories)', s.confidence === 'High' && s.complexity === 'High' && s.stories === 1);
  ok('marks itself measured', s.measured === true);
  ok('does NOT leak the raw confidence score', s.score === undefined && JSON.stringify(s).indexOf('0.408') === -1);
  ok('does NOT leak internal or vendor-cost fields',
    ['footprintSqft', 'suggestedSqft', 'wastePct', 'perimeterLf', 'facets', 'source', 'reportUrl', 'isCommercial']
      .every(k => s[k] === undefined));
  ok('squares derived from area when the vendor omits it',
    PM._test.publicSummary({ rawSqft: 2000 }).squares === 20);

  // ── The waste double-count. This is the assertion that was missing. ──
  // The wizard multiplies these squares by PRICING.roof bands that are built
  // as rate × 1.12 .. rate × 1.25 — the CRM's pitch waste factor, already in
  // the band (docs/assets/js/inline/4053149b2f.js:61-76 → tiersFromSquares).
  // So this field MUST be waste-excluded. Passing the vendor's own `squares`
  // through counted waste twice and quoted the homeowner ~15% high.
  ok('IGNORES the vendor waste-inclusive squares and derives from roof area',
    PM._test.publicSummary({ rawSqft: 3483, squares: 40.1 }).squares === 34.8);
  ok('...so the same roof prices identically with or without that vendor field',
    PM._test.publicSummary({ rawSqft: 3483, squares: 40.1 }).squares
      === PM._test.publicSummary({ rawSqft: 3483 }).squares);
  ok('...and squares always agrees with the sqft printed beside it',
    (() => {
      const a = PM._test.publicSummary({ rawSqft: 3483, squares: 40.1 });
      return Math.abs(a.squares - a.sqft / 100) < 0.05;
    })());
  ok('no area → null (never a summary claiming a measurement it does not have)',
    PM._test.publicSummary({ rawSqft: 0 }) === null && PM._test.publicSummary(null) === null);
  ok('the endpoint only answers for a doc whose summary says measured:true', /publicMeasurement\.measured/.test(src));
}

section('the kanban chip cannot render vendor-supplied markup');
{
  const crm = read('docs/pro/js/crm-pipeline.js');
  const m = /\/\^\[0-9\.\]\{1,8\} sq\(\?: · \[0-9\]\{1,2\}\\\/\[0-9\]\{1,2\}\)\?\$\//.exec(crm);
  ok('the card re-validates measurementSummary against a numbers-only pattern before printing it', !!m);
  ok('...and falls back to a static label when it fails', /: 'Measurement'\}<\/span>/.test(crm));
  ok('no bare esc() — that identifier is not defined in this file and would throw', !/\besc\(/.test(crm));
  // Prove the pattern the card uses actually rejects markup.
  const RE = /^[0-9.]{1,8} sq(?: · [0-9]{1,2}\/[0-9]{1,2})?$/;
  ok('pattern accepts a real chip', RE.test('38.7 sq · 5/12') && RE.test('20.0 sq'));
  ok('pattern rejects injected markup', !RE.test('38.7 sq · 5/12<img src=x onerror=alert(1)>') && !RE.test('<b>x</b> sq'));
  ok('the server also sanitises pitch to n/n before storing the chip',
    /\^\[0-9\]\{1,2\}\\\/\[0-9\]\{1,2\}\$/.test(src) && /safePitch/.test(src));
}

section('the coordinates finally survive to the CRM');
{
  const gw = codeOnly(read('functions/handlers/integrations.js'));
  const bridge = codeOnly(read('functions/lead-bridge-logic.js'));
  ok('submitPublicLead declares numeric optionals for the estimate kind',
    /numOptional: \{ lat: \{ min: -90, max: 90 \}, lon: \{ min: -180, max: 180 \} \}/.test(gw));
  ok('...with a strict loop that range-checks and never widens the string loop',
    /for \(const key of Object\.keys\(spec\.numOptional \|\| \{\}\)\)/.test(gw)
    && /if \(!isFinite\(n\)\) continue;/.test(gw)
    && /typeof v !== 'string'\) continue;/.test(gw));
  ok('0,0 is rejected rather than stored as a point in the Gulf of Guinea',
    /data\.lat === 0 && data\.lon === 0/.test(gw));
  ok('the bridge copies them onto the CRM lead as lat/lng (canonical names)',
    /doc\.lat = _lat;/.test(bridge) && /doc\.lng = _lng;/.test(bridge));
  ok('...normalising the public form\'s `lon`, and not inventing latitude/longitude drift',
    /data\.lon != null \? data\.lon : data\.lng/.test(bridge) && !/doc\.longitude/.test(bridge));
  ok('the bridge validates range and rejects 0,0 too',
    /Math\.abs\(_lat\) <= 90 && Math\.abs\(_lng\) <= 180/.test(bridge) && /_lat === 0 && _lng === 0/.test(bridge));
}

section('the wizard uses the measurement without letting a model do the money math');
{
  const wiz = codeOnly(read('docs/assets/js/inline/4053149b2f.js'));
  ok('it asks the read-only endpoint, keyed on the lead id it just created',
    /MEASURE_URL/.test(wiz) && /kind: 'estimate', leadId: publicLeadId/.test(wiz));
  ok('the lead id is captured (it used to be thrown away by a !! coercion)',
    /_publicLeadId = await window\._saveLead\(leadData\)/.test(wiz) && !/_leadSaved = !!\(await window\._saveLead/.test(wiz));
  ok('a missing measurement is a normal outcome — returns null, estimate falls back to the size tile',
    /if \(!m \|\| !m\.measured \|\| !\(Number\(m\.squares\) > 0\)\) return null;/.test(wiz));
  ok('tier pricing is computed from real squares, never taken from the model',
    /function tiersFromSquares/.test(wiz) && /est\.tiers = tiersFromSquares\(est\.squares\)/.test(wiz));
  ok('the model is told the size is measured and must not re-estimate it',
    /use it EXACTLY and do not re-estimate the size/.test(wiz));
  ok('the offline fallback also uses the measurement when the AI call fails',
    /var measured = !!\(meas && Number\(meas\.squares\) > 0\)/.test(wiz));
  ok('a measured roof drops the "~" so the page stops hedging a real number',
    /_isMeasured \? '' : '~'/.test(wiz));
  ok('low confidence is surfaced to the homeowner as a caveat', /conf !== 'High'/.test(wiz));
  ok('the ToS attribution ships with the measured note',
    /Roof measurement powered by Instant Roofer/.test(read('docs/estimate.html')));
  ok('the note is hidden until a measurement actually exists',
    /id="measuredNote" style="display:none/.test(read('docs/estimate.html')));
  ok('no inline handler or inline script was added (strict CSP)',
    !/onclick=|onload=/.test(read('docs/estimate.html').split('<div id="measuredNote"')[1] || ''));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failures:\n - ' + fails.join('\n - ')); process.exit(1); }
