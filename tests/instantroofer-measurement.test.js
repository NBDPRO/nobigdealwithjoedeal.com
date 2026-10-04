/**
 * tests/instantroofer-measurement.test.js — Instant Roofer measurement provider.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The aerial-measurement adapter (functions/integrations/measurement.js) had
 * three providers and zero behavioural tests — every one of them called a
 * bare global fetch, and none had ever been configured in prod (all three
 * keys are the deploy's `__unset__` stub, verified 2026-09-06). Instant
 * Roofer is the first provider with a real key. (The three dead providers
 * were removed 2026-10-04 — VENDOR-COST-LOCKIN Lane C — and section
 * "removed providers" below pins that they stay unreachable.) This suite pins:
 *
 *   1. the pure normalizer against the vendor's documented example response
 *      (functions/integrations/instantroofer-logic.js);
 *   2. the adapter's request/response contract through the `deps.fetchImpl`
 *      seam — URL, bearer header, body shape, error classification;
 *   3. the human-report webhook parser (their payload keys are dashboard-
 *      configured, so both spellings and both `status` types are accepted);
 *   4. coordinate resolution order (client → lead → parcel → geocode);
 *   5. source contracts every touchpoint needs to keep (secret bindings,
 *      configured-map keys, the client default, D2D/V2 passing coords).
 *
 * Run: node tests/instantroofer-measurement.test.js   (needs functions/ deps)
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Strip comments before source-contract greps (2026-09-04: a raw grep matched
// a comment twice and passed over deleted code).
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '').replace(/\s\/\/[^\n]*$/mg, '');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= (tol || 0.5);

const IR = require(path.join(FUNCTIONS, 'integrations', 'instantroofer-logic.js'));

// ── Documented example response, captured 2026-09-06 from
// instantroofer.com/api-instruction ("AI Instant Measure Reports API (June
// 2026)"). lidar.roofPointsFacetedXYZK trimmed to [] as their own docs do;
// imagery.mapWithOutline replaced by a short stand-in for the base64 image.
// Do not "tidy" the shape — the normalizer is tested against it as-is.
const REAL = {
  version: 'v2',
  measurements: {
    sqft: { aerial: 3215, measured: 3483, suggested: 4006 },
    squares: 40.1,
    pitch: '5/12',
    complexity: 3,
    perimeter: 262,
    facets: 6,
    stories: 2,
    confidence: { score: 0.36, display: { value: 'High' } }
  },
  imagery: { mapWithOutline: 'iVBORw0KGgo=' },
  lidar: { facets: { predicted_count: 6 }, roofPointsFacetedXYZK: [] }
};

section('normalizeAiResponse — the documented example');
{
  const m = IR.normalizeAiResponse(REAL);
  ok('rawSqft = sqft.measured (pitch applied, NO waste — consumers add their own)', m.rawSqft === 3483);
  ok('footprintSqft = sqft.aerial', m.footprintSqft === 3215);
  ok('suggestedSqft = sqft.suggested (vendor material figure, waste included)', m.suggestedSqft === 4006);
  ok('squares passed through', m.squares === 40.1);
  ok("pitch kept as the '5/12' string the V2 <select> parses", m.pitch === '5/12');
  ok('perimeterLf / facets / stories', m.perimeterLf === 262 && m.facets === 6 && m.stories === 2);
  ok("complexity 3 → 'Extreme'", m.complexity === 3 && m.complexityLabel === 'Extreme');
  ok("confidence: score kept, label from the vendor's display.value", m.confidence && m.confidence.score === 0.36 && m.confidence.label === 'High');
  ok('no buildingPredictions → wastePct / isTownhome / isCommercial null', m.wastePct === null && m.isTownhome === null && m.isCommercial === null);
  ok('AI report carries no document', m.reportUrl === null);
  ok("source = 'instantroofer-ai'", m.source === 'instantroofer-ai');
  ok('no undefined values (Firestore rejects them)', Object.values(m).every(v => v !== undefined));
}

section('normalizeAiResponse — derivations and tolerance');
{
  const m = IR.normalizeAiResponse({ measurements: { sqft: { aerial: 1000 }, pitch: '6/12' } });
  ok('measured missing → aerial × slope factor (1000 × 1.118 = 1118)', near(m.rawSqft, 1118, 1));
  const noPitch = IR.normalizeAiResponse({ measurements: { sqft: { aerial: 1000 } } });
  ok('measured missing AND pitch unreadable → rawSqft null (never a bare footprint)', noPitch.rawSqft === null);
  const bp = IR.normalizeAiResponse({ measurements: { sqft: { measured: 2000 }, pitch: 6, confidence: { score: 0.1 } },
    buildingPredictions: { complexityClass: 1, complexityWaste: 0.15, isTownhome: true, isCommercial: false } });
  ok('numeric pitch → "6"', bp.pitch === '6');
  ok('complexityClass used when measurements.complexity absent → Moderate', bp.complexity === 1 && bp.complexityLabel === 'Moderate');
  ok('complexityWaste fraction 0.15 → 15 (%)', bp.wastePct === 15);
  ok('isTownhome / isCommercial booleans kept', bp.isTownhome === true && bp.isCommercial === false);
  ok('confidence label derived from score when display absent (0.1 → Low)', bp.confidence.label === 'Low');
  ok('empty body → nulls, no throw', IR.normalizeAiResponse(null).rawSqft === null && IR.normalizeAiResponse({}).source === 'instantroofer-ai');
  ok('garbage measurements → nulls, no throw', IR.normalizeAiResponse({ measurements: 'x' }).rawSqft === null);
}

section('helpers');
{
  ok('confidenceLabel buckets (docs: Low <0.24, Medium 0.24–0.34, High >=0.35)',
    IR.confidenceLabel(0.1) === 'Low' && IR.confidenceLabel(0.24) === 'Medium' && IR.confidenceLabel(0.34) === 'Medium'
    && IR.confidenceLabel(0.35) === 'High' && IR.confidenceLabel(null) === null);
  ok('wastePercent: 0.15→15, 15→15, 0.3333→33.3, null/negative→null',
    IR.wastePercent(0.15) === 15 && IR.wastePercent(15) === 15 && IR.wastePercent(0.3333) === 33.3
    && IR.wastePercent(null) === null && IR.wastePercent(-1) === null);
  ok("parsePitchRise: '5/12'→5, '5:12'→5, '7'→7, 7→7, '6/6'→12, 'x'→null",
    IR.parsePitchRise('5/12') === 5 && IR.parsePitchRise('5:12') === 5 && IR.parsePitchRise('7') === 7
    && IR.parsePitchRise(7) === 7 && IR.parsePitchRise('6/6') === 12 && IR.parsePitchRise('x') === null);
  ok('pitchFactor: flat=1, 12/12=√2, unreadable=null',
    IR.pitchFactor('0/12') === 1 && near(IR.pitchFactor('12/12'), Math.SQRT2, 1e-9) && IR.pitchFactor('') === null);
  ok('validateCoords: numeric strings ok', IR.validateCoords('39.1', '-84.5').ok && IR.validateCoords('39.1', '-84.5').lat === 39.1);
  ok('validateCoords: out of range / null island / NaN rejected',
    !IR.validateCoords(91, 0).ok && !IR.validateCoords(0, 0).ok && !IR.validateCoords('a', 1).ok && !IR.validateCoords(null, null).ok);
  ok('coordKey: 5 decimals, provider-prefixed, stable across float noise',
    IR.coordKey(39.123456789, -84.5) === 'instantroofer:39.12346,-84.50000'
    && IR.coordKey(39.123456789, -84.5) === IR.coordKey(39.1234571, -84.50000001));
}

section('buildRequestBody — the two documented request shapes');
{
  const ai = IR.buildRequestBody('39.1', -84.5, {});
  ok('AI: latitude/longitude as numbers', ai.latitude === 39.1 && ai.longitude === -84.5);
  ok('AI: the three documented resultOptions keys, blobs off, facetMeta on',
    ai.resultOptions && ai.resultOptions.mapWithOutlineFromImageModel === false
    && ai.resultOptions.facetPoints === false && ai.resultOptions.facetMeta === true
    && Object.keys(ai.resultOptions).length === 3);
  ok('AI: no reportType key', !('reportType' in ai));
  const human = IR.buildRequestBody(39.1, -84.5, { reportType: 'human', customerName: 'x'.repeat(300), contractorName: 'NBD', address: 'y'.repeat(1200) });
  ok("human: reportType 'human', no resultOptions", human.reportType === 'human' && !('resultOptions' in human));
  ok('human: optional context capped at their limits (255 / 255 / 1000)',
    human.customerName.length === 255 && human.contractorName === 'NBD' && human.originalAddress.length === 1000);
  ok('human: omitted context keys are absent, not null', !('customerName' in IR.buildRequestBody(1, 1, { reportType: 'human' })));
}

section('classifyHttpError — documented codes → HttpsError codes');
{
  const t = IR.classifyHttpError;
  ok('404 → roof-not-found / not-found (pin not on a building)', t(404).reason === 'roof-not-found' && t(404).code === 'not-found');
  ok('401 → auth / failed-precondition', t(401).reason === 'auth' && t(401).code === 'failed-precondition');
  ok('402 → quota / resource-exhausted', t(402).reason === 'quota' && t(402).code === 'resource-exhausted');
  ok('403 → not-enabled', t(403).reason === 'not-enabled');
  ok('409 → duplicate / already-exists', t(409).code === 'already-exists');
  ok('422 → unmeasurable', t(422).reason === 'unmeasurable');
  ok('429 → rate-limited, retryable', t(429).reason === 'rate-limited' && t(429).retryable === true);
  ok('500/502/504 and unknowns → vendor-error / unavailable, retryable',
    t(500).reason === 'vendor-error' && t(502).code === 'unavailable' && t(504).retryable === true && t(418).reason === 'vendor-error');
  ok("string status '404' tolerated", t('404').reason === 'roof-not-found');
  ok('every entry has a human message', Object.values(IR.HTTP_ERRORS).every(e => e.message && e.code));
}

section('parseHumanAccepted — the HUMAN_QUEUED acknowledgement');
{
  const acc = IR.parseHumanAccepted({ ok: true, code: 'HUMAN_QUEUED', requestId: 'req-1', humanReportId: 'hr-1' });
  ok('requestId → externalJobId (what the webhook echoes back)', acc && acc.externalJobId === 'req-1' && acc.humanReportId === 'hr-1');
  ok('snake_case / requestID spellings', IR.parseHumanAccepted({ request_id: 'r2' }).externalJobId === 'r2' && IR.parseHumanAccepted({ requestID: 'r3' }).externalJobId === 'r3');
  ok('no id → null (adapter refuses to write a pending doc it can never match)', IR.parseHumanAccepted({ ok: true }) === null && IR.parseHumanAccepted(null) === null);
}

section('parseHumanWebhook — dashboard-configured payloads');
{
  // Their documented example payloads, verbatim.
  const completed = { event: 'human_report.completed', reportType: 'pdf', reportUrl: 'https://example.com/report.pdf',
    humanReportId: 'generated-human-report-id', requestId: 'generated-request-id', status: 'completed',
    latitude: 32.865378, longitude: -111.677416, contractorName: 'ABC Roofing', customerName: 'Jane Smith', originalAddress: '123 Main St' };
  const failedEx = { event: 'human_report.failed', reportType: 'pdf', humanReportId: 'generated-human-report-id',
    requestId: 'generated-request-id', status: 'failed', statusCode: 422, failureReason: 'Human report failed' };
  const c = IR.parseHumanWebhook(completed);
  ok('completed example → ready, pdf, https url, ids', c.status === 'ready' && c.reportType === 'pdf'
    && c.reportUrl === 'https://example.com/report.pdf' && c.externalJobId === 'generated-request-id' && c.humanReportId === 'generated-human-report-id');
  const f = IR.parseHumanWebhook(failedEx);
  ok('failed example → failed + reason, no url', f.status === 'failed' && f.failureReason === 'Human report failed' && f.reportUrl === null);
  ok("their 'minimum payload' (requestID / url / numeric status_code) → ready",
    IR.parseHumanWebhook({ requestID: 'r', url: 'https://x/y.csv', status: 200 }).status === 'ready');
  ok('numeric status 422 with no url → failed', IR.parseHumanWebhook({ requestID: 'r', status: 422 }).status === 'failed');
  ok('snake_case dynamics (request_id / report_url / report_type / failure_reason)',
    (() => { const p = IR.parseHumanWebhook({ request_id: 'r', report_url: 'https://x/r.html', report_type: 'html', status: 'completed' });
      return p.externalJobId === 'r' && p.reportUrl === 'https://x/r.html' && p.reportType === 'html' && p.status === 'ready'; })());
  ok('event suffix alone decides when status is absent', IR.parseHumanWebhook({ requestId: 'r', event: 'human_report.failed' }).status === 'failed'
    && IR.parseHumanWebhook({ requestId: 'r', event: 'human_report.completed' }).status === 'ready');
  ok('url alone (no status, no event) → ready', IR.parseHumanWebhook({ requestId: 'r', url: 'https://x/a.pdf' }).status === 'ready');
  ok('nothing decisive → pending', IR.parseHumanWebhook({ requestId: 'r' }).status === 'pending');
  ok('http:// or javascript: report urls are dropped', IR.parseHumanWebhook({ requestId: 'r', reportUrl: 'http://x/a.pdf' }).reportUrl === null
    && IR.parseHumanWebhook({ requestId: 'r', reportUrl: 'javascript:alert(1)' }).reportUrl === null);
  ok('unknown reportType → null (only pdf/csv/html/xml)', IR.parseHumanWebhook({ requestId: 'r', reportType: 'docx' }).reportType === null);
  ok('failureReason capped at 500 chars', IR.parseHumanWebhook({ requestId: 'r', failureReason: 'z'.repeat(900) }).failureReason.length === 500);
  ok('no request id / null body → null', IR.parseHumanWebhook({ status: 'completed' }) === null && IR.parseHumanWebhook(null) === null);
  ok('preferredReportUrl: pdf wins, then html, then anything',
    IR.preferredReportUrl({ csv: 'c', pdf: 'p' }) === 'p' && IR.preferredReportUrl({ csv: 'c', html: 'h' }) === 'h'
    && IR.preferredReportUrl({ xml: 'x' }) === 'x' && IR.preferredReportUrl({}) === null && IR.preferredReportUrl(null) === null);
  ok("preferredReportUrl finds the generic 'report' key the merge uses when the payload names no format",
    IR.preferredReportUrl({ report: 'https://x/a.pdf' }) === 'https://x/a.pdf');
}

section('verifyBearer — the token we mint, compared constant-time');
{
  const secret = 'nbd-webhook-token-0123456789abcdef';
  ok("'Bearer <token>' accepted", IR.verifyBearer('Bearer ' + secret, secret).ok);
  ok('bare token accepted (they prefix Bearer themselves, but be tolerant)', IR.verifyBearer(secret, secret).ok);
  ok('case-insensitive scheme + surrounding whitespace', IR.verifyBearer('  bearer   ' + secret + ' ', secret).ok);
  ok('wrong token rejected', !IR.verifyBearer('Bearer ' + secret + 'x', secret).ok && IR.verifyBearer('Bearer nope', secret).reason === 'token-mismatch');
  ok('missing header rejected', IR.verifyBearer('', secret).reason === 'missing-authorization' && IR.verifyBearer(undefined, secret).reason === 'missing-authorization');
  ok("'Bearer ' with nothing after → missing-token", IR.verifyBearer('Bearer ', secret).reason === 'missing-token');
  ok('short/absent secret fails closed as secret-not-configured', IR.verifyBearer('Bearer x', 'short').reason === 'secret-not-configured'
    && IR.verifyBearer('Bearer x', null).reason === 'secret-not-configured');
}

// ── The adapter itself (needs functions/ deps; hasSecret reads process.env) ──
section('measurement.js loads and exposes the _test seam');
let M = null, loadError = null;
try { M = require(path.join(FUNCTIONS, 'integrations', 'measurement.js')); } catch (e) { loadError = e; }
ok('require() succeeds (ci "Require every integration module" gate)', !loadError, loadError && loadError.message);
ok('_test seam present', !!(M && M._test && M._test.requestInstantRoofer && M._test.resolveCoords && M._test.normalizeWebhookPayload));

if (M && M._test) {
  const T = M._test;
  const shared = require(path.join(FUNCTIONS, 'integrations', '_shared.js'));
  ok('SECRETS registry has both Instant Roofer entries', !!(shared.SECRETS.INSTANTROOFER_API_KEY && shared.SECRETS.INSTANTROOFER_WEBHOOK_SECRET));
  ok("PROVIDERS.measurement defaults to 'instantroofer' (env unset in this process)",
    process.env.NBD_MEASUREMENT_PROVIDER ? true : shared.PROVIDERS.measurement === 'instantroofer');
  const sel = T.selectProvider();
  ok('selectProvider → instantroofer, needsCoords', !process.env.NBD_MEASUREMENT_PROVIDER ? (sel && sel.name === 'instantroofer' && sel.needsCoords === true) : true);

  section('removed providers (HOVER / EagleView / Nearmap, 2026-10-04) stay unreachable');
  {
    const prev = shared.PROVIDERS.measurement;
    for (const p of ['hover', 'eagleview', 'nearmap']) {
      shared.PROVIDERS.measurement = p;
      ok('NBD_MEASUREMENT_PROVIDER=' + p + ' → selectProvider null (callable fails loudly, never bills)', T.selectProvider() === null);
    }
    shared.PROVIDERS.measurement = prev;
    ok("webhook payload for provider 'hover' → null (400 Unknown provider)", T.normalizeWebhookPayload('hover', { job_id: 'j1', status: 'completed', measurements: { total_facets_area_sqft: 2500 } }) === null);
    ok("webhook payload for provider 'eagleview' → null (400 Unknown provider)", T.normalizeWebhookPayload('eagleview', { orderId: 'o1', status: 'Completed', measurementReport: { totalRoofArea: 3000 } }) === null);
    ok('the HMAC verifier and Nearmap sync parser are gone from the _test seam', !('verifyWebhookHmac' in T) && !('parseSync' in T));
  }

  section('requestInstantRoofer — request/response contract via deps.fetchImpl');
  const calls = [];
  const fakeFetch = (reply) => async (url, opts) => { calls.push({ url, opts }); return reply; };
  const jsonReply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

  delete process.env.INSTANTROOFER_API_KEY;
  (async () => {
    let r = await T.requestInstantRoofer({ lat: 39.1, lng: -84.5, reportType: 'ai' }, { fetchImpl: fakeFetch(jsonReply(200, REAL)) });
    ok('no key → configured:false, no fetch', r.configured === false && r.provider === 'instantroofer' && calls.length === 0);

    process.env.INSTANTROOFER_API_KEY = 'test-key-123';
    r = await T.requestInstantRoofer({ lat: 39.1, lng: -84.5, reportType: 'ai', address: '1 Main St' }, { fetchImpl: fakeFetch(jsonReply(200, REAL)), now: () => 1700000000000 });
    const call = calls[0];
    ok('POSTs the documented endpoint', call && call.url === 'https://v5.instantroofer.com/v2' && call.opts.method === 'POST');
    ok('Bearer header from the secret, JSON content type', call.opts.headers.Authorization === 'Bearer test-key-123' && /json/.test(call.opts.headers['Content-Type']));
    const sent = JSON.parse(call.opts.body);
    ok('body = {latitude, longitude, resultOptions} — never an address', sent.latitude === 39.1 && sent.longitude === -84.5 && sent.resultOptions && !('address' in sent) && !('originalAddress' in sent));
    ok('AI: ok, provider, synchronous (estimatedMinutes 0), minted jobId', r.ok && r.provider === 'instantroofer' && r.reportType === 'ai' && r.estimatedMinutes === 0 && r.jobId === 'instantroofer-1700000000000');
    ok('AI: normalized measurements attached (rawSqft 3483, pitch 5/12)', r.measurements && r.measurements.rawSqft === 3483 && r.measurements.pitch === '5/12');
    ok('AI: audit copy keeps facts, strips the two blobs', r.synchronousData && r.synchronousData.measurements.squares === 40.1
      && r.synchronousData.imagery.mapWithOutline === '[stripped]' && r.synchronousData.lidar.roofPointsFacetedXYZK === '[stripped]');
    ok('AI: stripVendorBlobs never throws on odd shapes', T.stripVendorBlobs(null) === null && T.stripVendorBlobs({ a: 1 }).a === 1);

    r = await T.requestInstantRoofer({ lat: 39.1, lng: -84.5 }, { fetchImpl: fakeFetch(jsonReply(404, { error: 'Roof not found' })) });
    ok('404 → ok:false roof-not-found with HttpsError code + message', !r.ok && r.reason === 'roof-not-found' && r.code === 'not-found' && /centre|center/.test(r.message) && r.status === 404);
    r = await T.requestInstantRoofer({ lat: 39.1, lng: -84.5 }, { fetchImpl: fakeFetch(jsonReply(429, {})) });
    ok('429 → rate-limited / resource-exhausted', !r.ok && r.reason === 'rate-limited' && r.code === 'resource-exhausted');
    r = await T.requestInstantRoofer({ lat: 39.1, lng: -84.5 }, { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    ok('fetch throws → network', !r.ok && r.reason === 'network');
    r = await T.requestInstantRoofer({ lat: 39.1, lng: -84.5 }, { fetchImpl: fakeFetch({ ok: true, status: 200, json: async () => { throw new Error('bad'); }, text: async () => 'x' }) });
    ok('non-JSON 200 → bad-json', !r.ok && r.reason === 'bad-json');
    r = await T.requestInstantRoofer({ lat: 39.1, lng: -84.5 }, { fetchImpl: fakeFetch(jsonReply(200, { measurements: { sqft: {} } })) });
    ok('200 with no roof area → no-measurement (never a ready doc with nothing in it)', !r.ok && r.reason === 'no-measurement');

    calls.length = 0;
    r = await T.requestInstantRoofer({ lat: 39.1, lng: -84.5, reportType: 'human', address: '1 Main St, Loveland, OH', customerName: 'Jane', contractorName: 'NBD' },
      { fetchImpl: fakeFetch(jsonReply(200, { ok: true, code: 'HUMAN_QUEUED', requestId: 'req-9', humanReportId: 'hr-9' })) });
    const hsent = JSON.parse(calls[0].opts.body);
    ok("human: body carries reportType 'human' + job context, no resultOptions",
      hsent.reportType === 'human' && hsent.originalAddress === '1 Main St, Loveland, OH' && hsent.customerName === 'Jane' && hsent.contractorName === 'NBD' && !('resultOptions' in hsent));
    ok('human: jobId = requestId (webhook match key), ~60 min, no measurements yet',
      r.ok && r.reportType === 'human' && r.jobId === 'req-9' && r.humanReportId === 'hr-9' && r.estimatedMinutes === 60 && !r.measurements);
    r = await T.requestInstantRoofer({ lat: 39.1, lng: -84.5, reportType: 'human' }, { fetchImpl: fakeFetch(jsonReply(200, { ok: true })) });
    ok('human: ack without requestId → bad-ack', !r.ok && r.reason === 'bad-ack');

    section('normalizeWebhookPayload — Instant Roofer only');
    const ir = T.normalizeWebhookPayload('instantroofer', { requestId: 'req-9', status: 'completed', reportType: 'pdf', reportUrl: 'https://ir/r.pdf' });
    ok('instantroofer → externalJobId from requestId, human block, NO numbers', ir.externalJobId === 'req-9' && ir.status === 'ready' && ir.measurements === null && ir.human.reportUrl === 'https://ir/r.pdf');
    ok('instantroofer with no request id → externalJobId null (400 upstream)', T.normalizeWebhookPayload('instantroofer', { status: 'completed' }).externalJobId === null);
    ok('unknown provider → null', T.normalizeWebhookPayload('roofr', {}) === null);

    section('verifyInstantRooferBearer — fails closed without the secret');
    delete process.env.INSTANTROOFER_WEBHOOK_SECRET;
    ok('secret unset → secret-not-configured (→ 503 upstream)', T.verifyInstantRooferBearer('Bearer x').reason === 'secret-not-configured');
    process.env.INSTANTROOFER_WEBHOOK_SECRET = 'tok-0123456789abcdefghij';
    ok('secret set → matching bearer accepted, wrong rejected', T.verifyInstantRooferBearer('Bearer tok-0123456789abcdefghij').ok && !T.verifyInstantRooferBearer('Bearer nope').ok);
    delete process.env.INSTANTROOFER_WEBHOOK_SECRET;

    section('reuse ages off measuredAt, not the copy\'s own createdAt');
    {
      const ms = (n) => ({ toMillis: () => n });
      ok('measuredAt wins over createdAt (a copy carries the ORIGINAL measurement time)',
        T.measuredAtMs({ measuredAt: ms(1000), createdAt: ms(9_999_999) }) === 1000);
      ok('falls back to createdAt for docs written before measuredAt existed', T.measuredAtMs({ createdAt: ms(42) }) === 42);
      ok('no usable timestamp → null (excluded from reuse, never treated as fresh)',
        T.measuredAtMs({}) === null && T.measuredAtMs({ measuredAt: 'nope' }) === null);
      // The regression this guards: a reuse copy is itself a reuse candidate.
      // If the copy carried its own creation time, every cache hit would
      // restamp the roof as freshly measured and the 90-day window would
      // never expire.
      const day = 24 * 60 * 60 * 1000;
      const original = { measuredAt: ms(Date.now() - 100 * day), createdAt: ms(Date.now() - 100 * day) };
      const copyDoneRight = { measuredAt: original.measuredAt, createdAt: ms(Date.now()) };
      ok('a 100-day-old measurement is outside the 90-day window',
        T.measuredAtMs(original) < Date.now() - T.REUSE_WINDOW_MS);
      ok('its copy is too — the chain expires (the bug: reading createdAt made it immortal)',
        T.measuredAtMs(copyDoneRight) < Date.now() - T.REUSE_WINDOW_MS
        && copyDoneRight.createdAt.toMillis() > Date.now() - T.REUSE_WINDOW_MS);
    }

    section('coordinate resolution — most rooftop-accurate first');
    ok("leadCoords: lead.lat/lng → 'lead'", (() => { const c = T.leadCoords({ lat: 39.1, lng: -84.5 }); return c && c.source === 'lead' && c.lat === 39.1; })());
    ok("leadCoords: falls back to parcel.center → 'parcel'", (() => { const c = T.leadCoords({ lat: null, lng: null, parcel: { center: { lat: 39.2, lng: -84.6 } } }); return c && c.source === 'parcel' && c.lng === -84.6; })());
    ok('leadCoords: nothing usable → null (never 0,0)', T.leadCoords({ lat: 0, lng: 0 }) === null && T.leadCoords({}) === null && T.leadCoords(null) === null);
    let c = await T.resolveCoords({ lat: 39.1, lng: -84.5, lead: { lat: 1, lng: 1 }, address: '1 Main St' });
    ok("explicit client coords win → 'client'", c && c.source === 'client' && c.lat === 39.1);
    c = await T.resolveCoords({ lat: 'bad', lng: null, lead: { lat: 39.3, lng: -84.7 }, address: '1 Main St' });
    ok("invalid client coords ignored, lead used → 'lead'", c && c.source === 'lead' && c.lat === 39.3);
    c = await T.resolveCoords({ lead: null, address: '' });
    ok('no coords, no lead, no address → null', c === null);
    const nomFetch = (rows) => async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => rows }; };
    calls.length = 0;
    c = await T.resolveCoords({ address: '123 Main St, Loveland, OH 45140', db: null }, { fetchImpl: nomFetch([{ lat: '39.2689', lon: '-84.2638', class: 'building', display_name: '123 Main St' }]) });
    ok("Nominatim fallback (Google/Regrid unconfigured) → 'nominatim', precision 'building' when OSM has the footprint",
      c && c.source === 'nominatim' && c.precision === 'building' && near(c.lat, 39.2689, 1e-6) && near(c.lng, -84.2638, 1e-6));
    ok('the Google and Regrid legs are injectable too (no real outbound call from this suite)', await (async () => {
      let googleCalled = false, regridCalled = false;
      await T.resolveCoords({ address: '1 Test St', db: null }, {
        fetchImpl: nomFetch([{ lat: '39.1', lon: '-84.5', class: 'building' }]),
        googleForward: async () => { googleCalled = true; return null; },
        regridAddress: async () => { regridCalled = true; return null; }
      });
      // Neither key is set in this process, so neither leg should even be
      // reached — the point is that the seam EXISTS for a machine where they are.
      return googleCalled === false && regridCalled === false;
    })());
    ok('Nominatim call is polite: identifies the app, limit=1, US only', calls[0] && /nominatim\.openstreetmap\.org\/search/.test(calls[0].url)
      && /limit=1/.test(calls[0].url) && /countrycodes=us/.test(calls[0].url) && /NoBigDealCRM/.test(calls[0].opts.headers['User-Agent']));
    c = await T.resolveCoords({ address: '123 Main St', db: null }, { fetchImpl: nomFetch([{ lat: '39.2', lon: '-84.2', class: 'place', type: 'house' }]) });
    ok("street-interpolated OSM hit → precision 'interpolated' (UI warns the rep)", c && c.precision === 'interpolated');
    c = await T.resolveCoords({ address: '123 Main St', db: null }, { fetchImpl: nomFetch([]) });
    ok('Nominatim miss → null (callable says "drop the pin")', c === null);
    // geocode_cache round-trip through the handlers/geocode.js helpers with a stub db.
    const store = {};
    const fakeDb = { doc: (p) => ({ get: async () => ({ exists: !!store[p], data: () => store[p] }), set: async (v) => { store[p] = Object.assign({}, v, { cachedAt: { toMillis: () => Date.now() } }); } }) };
    calls.length = 0;
    await T.resolveCoords({ address: '9 Oak St, Mason, OH', db: fakeDb }, { fetchImpl: nomFetch([{ lat: '39.36', lon: '-84.31', class: 'building' }]) });
    const cached = await T.resolveCoords({ address: '9 Oak St, Mason, OH', db: fakeDb }, { fetchImpl: nomFetch([{ lat: '0', lon: '0' }]) });
    ok('Nominatim result cached in geocode_cache — second call never hits the network', calls.length === 1 && cached && cached.cached === true && near(cached.lat, 39.36, 1e-6));

    delete process.env.INSTANTROOFER_API_KEY;
    finish();
  })().catch(e => { ok('async section ran without throwing', false, e && e.stack); finish(); });
} else {
  finish();
}

function finish() {
  section('source contracts — every touchpoint keeps its half of the deal');
  const meas = codeOnly(read('functions/integrations/measurement.js'));
  const sharedSrc = read('functions/integrations/_shared.js');
  const status = codeOnly(read('functions/handlers/integrations.js'));
  const client = codeOnly(read('docs/pro/js/integrations-client.js'));
  const v2 = codeOnly(read('docs/pro/js/estimate-v2-ui.js'));
  const d2d = codeOnly(read('docs/pro/js/d2d-tracker-core-2026b.js'));
  const admin = codeOnly(read('functions/handlers/admin.js'));
  const privacy = read('docs/privacy.html');
  const manifest = JSON.parse(read('tests/ci-manifest.json'));

  ok("_shared.js registers INSTANTROOFER_API_KEY in the one-line NAME: defineSecret('NAME') form the D.3 parser reads",
    /INSTANTROOFER_API_KEY:\s*defineSecret\('INSTANTROOFER_API_KEY'\)/.test(sharedSrc));
  ok('_shared.js registers INSTANTROOFER_WEBHOOK_SECRET the same way', /INSTANTROOFER_WEBHOOK_SECRET:\s*defineSecret\('INSTANTROOFER_WEBHOOK_SECRET'\)/.test(sharedSrc));
  ok("_shared.js default measurement provider is 'instantroofer'", /NBD_MEASUREMENT_PROVIDER\s*\|\|\s*'instantroofer'/.test(codeOnly(sharedSrc)));
  ok('requestMeasurement binds the API key + webhook secret + geocoder keys (Gen2 mounts only declared secrets)',
    /secrets:\s*\[[^\]]*SECRETS\.INSTANTROOFER_API_KEY[^\]]*SECRETS\.INSTANTROOFER_WEBHOOK_SECRET[^\]]*GOOGLE_GEOCODING_API_KEY/.test(meas));
  ok('measurementWebhook binds only INSTANTROOFER_WEBHOOK_SECRET', /secrets:\s*\[SECRETS\.INSTANTROOFER_WEBHOOK_SECRET\]/.test(meas));
  ok('callable timeout raised to 60 s for the synchronous vendor call', /timeoutSeconds:\s*60/.test(meas));
  ok('selectProvider has no silent HOVER fallback for unknown values (comment-stripped: the old line is quoted in a comment)',
    !/return requestHOVER;/.test(meas) && /function selectProvider\(\)[\s\S]{0,700}return null;/.test(meas));
  ok('the vendor-side 5/min limit is metered before the call', /callable:requestMeasurement:instantroofer/.test(meas) && /INSTANTROOFER_PER_MINUTE\s*=\s*5/.test(meas));
  ok('reuse window: same roof + same tenant within 90 days copies instead of re-billing', /REUSE_WINDOW_MS\s*=\s*90/.test(meas) && /reusedFrom:/.test(meas) && /findReusableMeasurement/.test(meas));
  ok('synchronous path attaches to the lead (task + activity + measurementReady) like the webhook does',
    /attachMeasurementToLead\(db,/.test(meas) && /measurementReady: true/.test(meas) && (meas.match(/attachMeasurementToLead\(db,/g) || []).length >= 3);
  ok('the task lands on leads/{leadId}/tasks (the collection task UIs read), not top-level tasks',
    /doc\(`leads\/\$\{leadId\}\/tasks\/\$\{taskId\}`\)\.set\(/.test(meas) && !/collection\('tasks'\)\.add/.test(meas));
  ok('the task carries a real dueDate — tasks.js and notif-bell.js both bail on a falsy one, so \'\' meant the alert never surfaced',
    /dueDate: today/.test(meas) && /toISOString\(\)\.slice\(0, 10\)/.test(meas) && !/dueDate: ''/.test(meas));
  ok('task + activity use one deterministic id, so repeat Auto-measure clicks update instead of stacking rows',
    /const taskId = 'measure-' \+ crypto\.createHash\('sha1'\)/.test(meas)
    && /dedupeKey: leadId \+ '\|' \+ ctx\.coordKey/.test(meas)
    && (meas.match(/\{ merge: true \}/g) || []).length >= 2);
  ok('the outline image / LiDAR blobs are never written to Firestore', /stripVendorBlobs/.test(meas) && /'\[stripped\]'/.test(meas));
  ok('the webhook verifies Instant Roofer by bearer token and refuses every other provider (F-02)',
    /verifyInstantRooferBearer\(req\.headers\['authorization'\]/.test(meas)
    && /:\s*\{\s*ok:\s*false,\s*reason:\s*'unknown-provider'\s*\}/.test(meas)
    && !/verifyWebhookHmac|x-hover-signature|x-ev-signature/.test(meas) && /'secret-not-configured' \? 503/.test(meas));
  ok('human-report webhooks merge per-format URLs idempotently and never regress ready',
    /reportUrls\[urlKey\] = human\.reportUrl/.test(meas) && /preferredReportUrl/.test(meas) && /status !== 'failed'\) status = 'ready'/.test(meas));
  ok('the per-format merge is a DOTTED field path — concurrent pdf+csv deliveries would otherwise erase each other',
    /update\['reportUrls\.' \+ urlKey\] = human\.reportUrl/.test(meas));
  ok("a human completion with neither a URL nor numbers stays 'pending' instead of claiming a report that does not exist",
    /if \(status === 'ready' && !headline && !mergedMeasurements\)/.test(meas) && /status = 'pending';/.test(meas));
  ok("the report URL survives a payload with no reportType — their documented MINIMUM payload is {requestID, url, status}",
    /if \(human\.reportUrl\) reportUrls\[/.test(meas) && !/human\.reportUrl && human\.reportType/.test(meas));
  ok('every measurement doc records measuredAt, and a reuse copy inherits it instead of restamping',
    /measuredAt: FieldValue\.serverTimestamp\(\)/.test(meas)
    && /measuredAt: prior\.data\.measuredAt \|\| prior\.data\.createdAt/.test(meas)
    && /at !== null && at > cutoff/.test(meas));
  ok('human orders refuse to fire without the webhook secret (a $10 report we could never receive)',
    /if \(!webhookSecretReady\(\)\)/.test(meas));
  ok('the order gate and the receiver share ONE definition of configured — hasSecret alone would pass a token verifyBearer calls unconfigured',
    /s\.length >= IR\.MIN_WEBHOOK_SECRET_LEN/.test(meas) && /MIN_WEBHOOK_SECRET_LEN/.test(read('functions/integrations/instantroofer-logic.js')));
  ok('$10 human reports have their own spend cap (the 90-day reuse guard is AI-only)',
    /callable:requestMeasurement:human:uid', uid, 2, 60 \* 60_000/.test(meas)
    && /callable:requestMeasurement:human:account', 'account', 20, 24 \* 60 \* 60_000/.test(meas));
  ok('reuse copies do NOT carry coordKey — only vendor-billed originals populate the blind limit() window',
    /Deliberately NO coordKey/.test(read('functions/integrations/measurement.js')) && /\.limit\(50\)/.test(meas));
  ok('both geocoder legs are injectable, so the unit suite can never make a real outbound call',
    /deps\.googleForward \|\| geocodeHandlers\._googleForward/.test(meas) && /deps\.regridAddress \|\| geocodeHandlers\._regridAddress/.test(meas));
  ok("integrationStatus.configured has 'instantroofer' (the exact lowercase key the client indexes) + the webhook twin",
    /instantroofer:\s*_hasInt\('INSTANTROOFER_API_KEY'\)/.test(status) && /instantrooferWebhook:\s*_hasInt\('INSTANTROOFER_WEBHOOK_SECRET'\)/.test(status));
  ok("integrations-client default provider is 'instantroofer' and forwards lat/lng + reportType",
    /providers\?\.measurement \|\| 'instantroofer'/.test(client) && /payload\.lat = lat; payload\.lng = lng;/.test(client) && /payload\.reportType = 'human'/.test(client));
  ok('integrations-client tells the truth about a synchronous result (no "~30 minutes" toast)', /d\.status === 'ready'/.test(client));
  ok('V2 builder applies a synchronous result without polling',
    /result\.status === 'ready' && result\.measurements/.test(v2) && /applyMeasurementResult\(result\.measurements, result\)/.test(v2));
  ok('V2 builder sends leadId, NOT the lead\'s lat/lng — the server reads them itself and tags them geocoded, keeping the warning honest',
    /requestMeasurement\(\{ address, leadId \}\)/.test(v2) && !/lat: lead\.lat/.test(v2));
  ok('V2 pitch is parsed with the server grammar and clamped into the #v2pitch range (3–16) — parseInt(\'0/12\') was 0, an option that does not exist',
    /parsePitchRise\(m\.pitch\)/.test(v2) && /Math\.min\(16, Math\.max\(3, Math\.round\(rise\)\)\)/.test(v2)
    && !/asStr\.includes\('\/'\) \? parseInt/.test(v2));
  ok('V2 builder adds the pass-through only for pass-through-eligible reports, matched by code too',
    /meta\.passThruEligible !== false/.test(v2) && /p\.code === 'SVC MEASURE-RPT'/.test(v2) && /source: 'measurement'/.test(v2));
  ok('every measurement is billable — an AI measure is no longer excluded (Jo, 2026-09-06)',
    /passThruEligible: true,/.test(meas) && !/passThruEligible: !\(result\.provider === 'instantroofer'/.test(meas));
  ok('...including a reuse copy, which costs us nothing but delivers the same work to the customer',
    /billed: false,\s*\n\s*passThruEligible: true,/.test(meas));
  ok('the DOCUMENT flag is what still distinguishes them — an AI measure produces no report',
    /passThruHasDocument: !\(result\.provider === 'instantroofer' && \(result\.reportType \|\| 'ai'\) === 'ai'\)/.test(meas)
    && /passThruHasDocument: doc\.passThruHasDocument/.test(meas));
  ok('the line item is worded honestly: a report only when a document actually exists',
    /meta\.passThruHasDocument === false/.test(v2)
    && /'Aerial roof measurement'/.test(v2) && /'Aerial measurement report'/.test(v2));
  ok('...and the reason is recorded, not just the behaviour (a future reader must not "tidy" it back)',
    /would put a line on an invoice for something that does not[\s\S]{0,40}exist/.test(read('docs/pro/js/estimate-v2-ui.js')));
  ok('V2 builder warns for ANY non-rooftop point, not just the one labelled interpolated',
    /TRUSTED_PRECISION = \['rooftop', 'building', 'parcel-centroid', 'client'\]/.test(v2)
    && /TRUSTED_PRECISION\.indexOf\(meta\.coordPrecision\) === -1/.test(v2));
  ok('D2D "order roof report" sends the knock pin as lat/lng', /lat: knock\.lat, lng: knock\.lng/.test(d2d));
  ok('admin revenue is derived from the billable subset, not the raw ready count',
    /billableMeas = readyMeas\.filter\(m => m\.passThruEligible !== false\)/.test(admin)
    && /passThruRevenueEst = billableMeas\.length/.test(admin));
  ok("...while ready30d still counts every delivered measurement (the 'is it working' tile must not read 0 under the new default provider)",
    /const readyMeas = measurements\.filter\(m => m\.status === 'ready'\);/.test(admin) && /ready30d: readyMeas\.length/.test(admin) && /billable30d: billableMeas\.length/.test(admin));
  ok('privacy page discloses Instant Roofer as a measurement sub-processor', /Instant Roofer/.test(privacy));
  ok('this suite is in the ci-manifest node bucket', manifest.node.includes('instantroofer-measurement.test.js'));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('Failures:\n - ' + fails.join('\n - ')); process.exit(1); }
}
