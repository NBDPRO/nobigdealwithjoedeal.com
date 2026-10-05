/**
 * tests/field-photos-server-2026-10-04.test.js — the field-photo lane, server
 * side, run for real (functions/ modules required, Firestore faked in memory,
 * Anthropic and Instant Roofer stubbed — nothing leaves the machine).
 *
 *   7. onPhotoCreatedClassify: the existing classifier runs on EVERY newly
 *      stored photo, under the existing caps, never twice for one photo (the
 *      callable and the trigger share an in-flight claim), skips annotated
 *      copies, and every caption passes the claim-wording filter.
 *   5. Instant Roofer auto-order: appointment set / Inspected → one paid
 *      order per lead, daily + monthly caps, kill switch, outline image to a
 *      private Storage path for the Draw tool cross-check.
 *
 * Run: node tests/field-photos-server-2026-10-04.test.js   (needs functions/ deps)
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }
async function guard(fn) {
  try { await fn(); }
  catch (e) { ok('section ran without throwing', false, (e && e.stack || String(e)).split('\n').slice(0, 2).join(' | ')); }
}

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'nobigdeal-pro';
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: 'nobigdeal-pro', storageBucket: 'nobigdeal-pro.appspot.com' });

// ── In-memory Firestore that understands the admin FieldValue sentinels ──
function applyField(cur, v) {
  const n = v && v.constructor && v.constructor.name;
  if (n === 'NumericIncrementTransform') return (Number(cur) || 0) + v.operand;
  if (n === 'ServerTimestampTransform') return { __ts: Date.now(), toMillis: () => Date.now() };
  return v;
}
function merge(target, patch) {
  const out = Object.assign({}, target || {});
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && v.constructor && v.constructor.name === 'DeleteTransform') { delete out[k]; continue; }
    out[k] = applyField(out[k], v);
  }
  return out;
}
function makeDb(seed) {
  const data = Object.assign({}, seed || {});
  const log = [];
  function ref(p) {
    return {
      path: p,
      async get() { return snap(p); },
      async set(v, opts) { log.push(['set', p]); data[p] = opts && opts.merge ? merge(data[p], v) : merge({}, v); },
      async update(v) { if (!data[p]) { const e = new Error('NOT_FOUND'); e.code = 5; throw e; } log.push(['update', p]); data[p] = merge(data[p], v); },
      async create(v) { if (data[p]) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } log.push(['create', p]); data[p] = merge({}, v); },
    };
  }
  function snap(p) { return { exists: !!data[p], data: () => data[p], id: p.split('/').pop(), ref: ref(p) }; }
  const db = {
    data, log,
    doc: ref,
    collection: (c) => ({
      doc: (id) => ref(c + '/' + id),
      where() { return this; }, limit() { return this; },
      async get() { return { docs: [] }; },
      async add(v) { const id = 'auto' + Math.random().toString(36).slice(2, 8); data[c + '/' + id] = merge({}, v); return ref(c + '/' + id); },
    }),
    async runTransaction(fn) {
      const tx = {
        get: async (r) => snap(r.path),
        set: (r, v, o) => { data[r.path] = o && o.merge ? merge(data[r.path], v) : merge({}, v); },
        update: (r, v) => { data[r.path] = merge(data[r.path], v); },
      };
      return fn(tx);
    },
  };
  return db;
}

function anthropicStub(caption, calls) {
  return async (url, init) => {
    calls.push(JSON.parse(init.body));
    return {
      ok: true, status: 200,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ phase: 'Before', damageType: 'hail', severity: 'moderate', caption, confidence: 0.8 }) }],
        usage: { input_tokens: 1000, output_tokens: 100 },
      }),
    };
  };
}

(async () => {
  // ════════════════════════════════════════════════════════════════
  section('7 — the classifier on every newly stored photo');
  const PV = require(path.join(FN, 'photo-vision.js'));
  const T = PV._test || {};
  ok('photo-vision exports the trigger door', typeof PV.onPhotoCreatedClassify === 'function' && typeof T.handlePhotoCreated === 'function');

  const killOff = { isAiDisabled: async () => false };
  const photo = (extra) => Object.assign({ userId: 'u1', companyId: 'c1', leadId: 'L1', url: 'https://dl.example/p.jpg' }, extra || {});

  await guard(async () => {
    const calls = [];
    const db = makeDb({ 'photos/p1': photo() });
    const out = await T.handlePhotoCreated('p1', db.data['photos/p1'],
      { db, killswitch: killOff, apiKey: 'k', fetchImpl: anthropicStub('Hail bruising on the north slope.', calls) });
    ok('a newly stored photo is classified (an imported / drag-dropped one, not only the camera\'s)', calls.length === 1 && out && out.suggestion, JSON.stringify(out));
    ok('the suggestion lands on the photo doc', db.data['photos/p1'].aiSuggestion && db.data['photos/p1'].aiSuggestion.damageType === 'hail');
    ok('the in-flight claim is cleared afterwards', !('aiClassifyClaimAt' in db.data['photos/p1']));
    ok('spend is metered on the lead and the owner, like the callable', db.data['leadCostMeter/L1'].visionUsd > 0
      && Object.keys(db.data).some((k) => /^userCostMeter\/u1__/.test(k)));

    const again = await T.handlePhotoCreated('p1', db.data['photos/p1'],
      { db, killswitch: killOff, apiKey: 'k', fetchImpl: anthropicStub('x', calls) });
    ok('an already-classified photo is never paid for twice', again.skipped && again.reason === 'already-classified' && calls.length === 1);
  });
  await guard(async () => {
    // The callable claimed the photo a moment ago: the trigger must not pay too.
    const calls = [];
    const db = makeDb({ 'photos/p2': photo({ aiClassifyClaimAt: { toMillis: () => Date.now() - 5000 } }) });
    const out = await T.classifyPhoto({ db, photoRef: db.doc('photos/p2'), photo: db.data['photos/p2'], uid: 'u1', billingKey: 'c1', apiKey: 'k',
      source: 'trigger', skipIfClassified: true, fetchImpl: anthropicStub('x', calls) });
    ok('a photo another door is classifying right now is left alone (pending, no spend)', out.pending === true && calls.length === 0);
    ok('pending is not reported as a cap "skip" (the client toasts every skip as a cap)', !out.skipped);
    const stale = makeDb({ 'photos/p3': photo({ aiClassifyClaimAt: { toMillis: () => Date.now() - 10 * 60 * 1000 } }) });
    const o2 = await T.classifyPhoto({ db: stale, photoRef: stale.doc('photos/p3'), photo: stale.data['photos/p3'], uid: 'u1', billingKey: 'c1', apiKey: 'k',
      source: 'trigger', skipIfClassified: true, fetchImpl: anthropicStub('Clean ridge.', calls) });
    ok('a claim left by a crashed attempt expires', o2.suggestion && calls.length === 1);
  });
  await guard(async () => {
    const calls = [];
    const db = makeDb({ 'photos/p4': photo(), 'leadCostMeter/L1': { visionUsd: 10 } });
    const out = await T.handlePhotoCreated('p4', db.data['photos/p4'], { db, killswitch: killOff, apiKey: 'k', fetchImpl: anthropicStub('x', calls) });
    ok('the existing $10/lead cap holds on the trigger door', out.skipped && out.reason === 'lead-cap' && calls.length === 0);
    ok('and the claim is released so a later door can try', !('aiClassifyClaimAt' in db.data['photos/p4']));
    const db2 = makeDb({ 'photos/p5': photo(), 'subscriptions/c1': { plan: 'starter' } });
    const month = new Date().toISOString().slice(0, 7);
    db2.data['userCostMeter/u1__' + month] = { visionUsd: 25 };
    const o2 = await T.handlePhotoCreated('p5', db2.data['photos/p5'], { db: db2, killswitch: killOff, apiKey: 'k', fetchImpl: anthropicStub('x', calls) });
    ok('and the per-user monthly cap, resolved from the photo\'s company plan', o2.skipped && o2.reason === 'user-cap' && calls.length === 0);
    const off = await T.handlePhotoCreated('p5', db2.data['photos/p5'], { db: db2, killswitch: { isAiDisabled: async () => true }, apiKey: 'k', fetchImpl: anthropicStub('x', calls) });
    ok('the aiDisabled kill switch stops it', off.skipped && off.reason === 'ai-disabled' && calls.length === 0);
  });
  await guard(async () => {
    ok('an annotated copy is not re-classified', T.triggerSkipReason(photo({ originalPhotoId: 'p1' })) === 'annotated-copy');
    ok('a photo with no lead is skipped', T.triggerSkipReason(photo({ leadId: '' })) === 'no-lead');
    ok('a photo with no usable URL is skipped', T.triggerSkipReason(photo({ url: 'blob:x' })) === 'no-url');
    ok('a fresh lead photo goes ahead', T.triggerSkipReason(photo()) === null);
  });
  await guard(async () => {
    // Claim wording: no claim talk reaches a caption.
    const calls = [];
    const db = makeDb({ 'photos/p6': photo() });
    await T.handlePhotoCreated('p6', db.data['photos/p6'], { db, killswitch: killOff, apiKey: 'k',
      fetchImpl: anthropicStub('Hail bruising on the third course. Recommend filing an insurance claim — this should be covered.', calls) });
    const cap = db.data['photos/p6'].aiSuggestion.caption;
    ok('a caption with claim talk keeps the observation and drops the claim sentence', cap === 'Hail bruising on the third course.', JSON.stringify(cap));
    ok('the model is told not to write it in the first place', /Never mention insurance, claims/.test(calls[0].system));
    // A cached suggestion from before the filter existed is re-filtered.
    const crypto = require('crypto');
    const key = crypto.createHash('sha256').update('https://dl.example/p7.jpg').digest('hex').slice(0, 32);
    const db2 = makeDb({ 'photos/p7': photo({ url: 'https://dl.example/p7.jpg' }),
      ['visionCache/' + key]: { suggestion: { phase: 'After', damageType: 'none', caption: 'New roof installed. Insurance will cover the deductible.', confidence: 0.9 } } });
    const o2 = await T.handlePhotoCreated('p7', db2.data['photos/p7'], { db: db2, killswitch: killOff, apiKey: 'k', fetchImpl: anthropicStub('x', calls) });
    ok('a cache hit is free and its old caption is filtered on the way out', o2.cached === true && o2.suggestion.caption === 'New roof installed.', JSON.stringify(o2.suggestion));

    const S = require(path.join(FN, 'photo-caption-safety.js'));
    const cases = [
      ['Missing shingles on the rear slope.', 'Missing shingles on the rear slope.'],
      ['Wind crease on the ridge. Adjuster should approve a full replacement.', 'Wind crease on the ridge.'],
      ["We'll handle everything with them. Lifted tabs near the vent.", 'Lifted tabs near the vent.'],
      ['Your deductible may be waived.', ''],
    ];
    const bad = cases.filter(([i, o]) => S.safeCaption(i) !== o);
    ok('safeCaption drops claim sentences and keeps the rest byte for byte', bad.length === 0, bad.map(([i]) => i + ' → ' + JSON.stringify(S.safeCaption(i))).join(' | '));
  });
  await guard(async () => {
    const IDX = require('fs').readFileSync(path.join(FN, 'index.js'), 'utf8');
    ok('index.js deploys the trigger', /exports\.onPhotoCreatedClassify = photoVision\.onPhotoCreatedClassify/.test(IDX));
    const SRC = require('fs').readFileSync(path.join(FN, 'photo-vision.js'), 'utf8');
    ok('it is an onDocumentCreated on photos/{photoId}, retry off', /exports\.onPhotoCreatedClassify = onDocumentCreated\(\{\s*document: 'photos\/\{photoId\}'/.test(SRC) && /retry: false/.test(SRC));
  });

  // ════════════════════════════════════════════════════════════════
  section('5 — Instant Roofer auto-order on appointment set / Inspected');
  let AO = {};
  try { AO = require(path.join(FN, 'integrations', 'measure-auto-order.js')); }
  catch (e) { ok('integrations/measure-auto-order.js loads', false, e.message.split('\n')[0]); }
  const A = AO._test || {};
  ok('measure-auto-order exports both doors', typeof AO.autoMeasureOnStage === 'function' && typeof AO.autoMeasureOnAppointment === 'function');
  await guard(async () => {
    ok('entering Inspected triggers', A.enteredTriggerStage({ stage: 'contacted' }, { stage: 'inspected' }) === true);
    ok('staying on Inspected does not', A.enteredTriggerStage({ stage: 'inspected' }, { stage: 'inspected' }) === false);
    ok('other stages do not', A.enteredTriggerStage({ stage: 'new' }, { stage: 'contacted' }) === false);
    const lead = { userId: 'u1', lat: 39.1, lng: -84.5, stage: 'inspected' };
    ok('a lead already measured is skipped', A.leadSkipReason(Object.assign({ measurementJobId: 'm1' }, lead)) === 'already-measured');
    ok('a lead with no coordinates is skipped (no geocode spend here)', A.leadSkipReason({ userId: 'u1', stage: 'inspected' }) === 'no-coords');
    ok('a lost lead is skipped', A.leadSkipReason(Object.assign({}, lead, { stage: 'lost' })) === 'lost');
    ok('config: defaults, overridable from feature_flags', A.resolveCaps({}).dailyCap === A.AUTO_ORDER_DEFAULTS.dailyCap
      && A.resolveCaps({ autoMeasureDailyCap: 2, autoMeasureMonthlyCap: 9 }).dailyCap === 2 && A.resolveCaps({ autoMeasureMonthlyCap: 9 }).monthlyCap === 9);

    const db = makeDb();
    const measured = [];
    const measure = async (_db, args) => { measured.push(args); return { ok: true, jobId: args.jobDocId }; };
    const deps = { flags: { autoMeasureDailyCap: 2, autoMeasureMonthlyCap: 3 }, measure, provider: 'instantroofer' };
    const o1 = await A.autoOrderForLead(db, { leadId: 'L1', lead, trigger: 'stage' }, deps);
    ok('an Inspected lead with coordinates is ordered', o1.ok === true && measured.length === 1);
    ok('under a deterministic job id, with the outline image requested', measured[0].jobDocId === 'auto-L1' && measured[0].withOutline === true);
    const dup = await A.autoOrderForLead(db, { leadId: 'L1', lead, trigger: 'appointment' }, deps);
    ok('never twice per lead (the appointment door finds the marker)', dup.ok === false && dup.reason === 'already-ordered' && measured.length === 1);
    await A.autoOrderForLead(db, { leadId: 'L2', lead, trigger: 'stage' }, deps);
    const capped = await A.autoOrderForLead(db, { leadId: 'L3', lead, trigger: 'stage' }, deps);
    ok('the daily cap stops the third order of the day', capped.ok === false && capped.reason === 'daily-cap' && measured.length === 2);
    const tomorrow = { flags: deps.flags, measure, provider: 'instantroofer', now: () => Date.now() + 86400000 };
    await A.autoOrderForLead(db, { leadId: 'L4', lead, trigger: 'stage' }, tomorrow);
    const mcap = await A.autoOrderForLead(db, { leadId: 'L5', lead, trigger: 'stage' }, { flags: { autoMeasureDailyCap: 9, autoMeasureMonthlyCap: 3 }, measure, provider: 'instantroofer', now: () => Date.now() + 2 * 86400000 });
    const sameMonth = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 7) === new Date().toISOString().slice(0, 7);
    ok('the monthly cap stops the order after the third this month', !sameMonth || (mcap.ok === false && mcap.reason === 'monthly-cap'), JSON.stringify(mcap));
    const off = await A.autoOrderForLead(makeDb(), { leadId: 'L9', lead, trigger: 'stage' }, { flags: { autoMeasureDisabled: true }, measure, provider: 'instantroofer' });
    ok('feature_flags/global.autoMeasureDisabled stops it', off.ok === false && off.reason === 'disabled');
    ok('the lead marker records the outcome', db.data['measurementAutoOrders/lead_L1'] && db.data['measurementAutoOrders/lead_L1'].status === 'ordered');
  });
  await guard(async () => {
    // The real order path (public-measure's measureLeadAndPublish) with the
    // vendor stubbed: the outline lands in private Storage, the lead gets the
    // cross-check fields.
    process.env.INSTANTROOFER_API_KEY = 'test-key-123';
    const PM = require(path.join(FN, 'integrations', 'public-measure.js'));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    let sentBody = null;
    const fetchImpl = async (_u, init) => {
      sentBody = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({
        measurements: { sqft: { aerial: 3215, measured: 3483, suggested: 4006 }, squares: 40.1, pitch: '5/12', perimeter: 262, facets: 6, confidence: { score: 0.4, display: { value: 'High' } } },
        imagery: { mapWithOutline: png.toString('base64') },
      }) };
    };
    const saved = [];
    const bucket = { file: (p) => ({ save: async (buf, opts) => { saved.push([p, buf.length, opts.contentType]); } }) };
    const db = makeDb();
    const lead = { userId: 'u1', companyId: 'c1', lat: 39.1, lng: -84.5, address: '12 Oak St', stage: 'inspected' };
    const out = await PM._test.measureLeadAndPublish(db, { leadId: 'L1', lead, jobDocId: 'auto-L1', source: 'auto-order:stage', withOutline: true, deps: { fetchImpl, bucket } });
    ok('the vendor is asked for the outline image', sentBody && sentBody.resultOptions && sentBody.resultOptions.mapWithOutlineFromImageModel === true);
    ok('the measurement doc is the deterministic auto-<leadId>', out.ok === true && !!db.data['measurements/auto-L1'] && db.data['measurements/auto-L1'].source === 'auto-order:stage');
    ok('the outline image is saved to the owner\'s private docs/ path, as a PNG', saved.length === 1 && saved[0][0] === 'docs/u1/measurements/L1-outline.png' && saved[0][2] === 'image/png');
    const L = db.data['leads/L1'] || {};
    ok('the lead carries the cross-check numbers + outline path', L.measurementSqft === 3483 && L.measurementFootprintSqft === 3215 && L.measurementPerimeterLf === 262 && L.measurementOutlinePath === 'docs/u1/measurements/L1-outline.png', JSON.stringify(L));
    ok('no base64 blob reaches Firestore', !JSON.stringify(db.data).includes(png.toString('base64')));
    const again = await PM._test.measureLeadAndPublish(db, { leadId: 'L1', lead: Object.assign({}, lead, { measurementJobId: 'auto-L1' }), jobDocId: 'auto-L1', withOutline: true, deps: { fetchImpl, bucket } });
    ok('a lead that already has a measurement is not re-ordered', again.ok === false && again.reason === 'already-measured');
    // The web-lead path is unchanged: no outline unless asked.
    sentBody = null;
    await PM._test.measureLeadAndPublish(makeDb(), { leadId: 'W1', lead, deps: { fetchImpl, bucket } });
    ok('the public web-lead path still asks for no outline', sentBody && sentBody.resultOptions && sentBody.resultOptions.mapWithOutlineFromImageModel === false);
    // Merged with #2164 (NBD_MEASUREMENT_PROVIDER solar|auto): the provider
    // prefixes externalJobId; the web lead keeps '<provider>-weblead-<id>' and
    // the auto-order gets its own '<provider>-auto-<id>'.
    ok('auto-order externalJobId = <provider>-auto-<leadId>', db.data['measurements/auto-L1'].externalJobId === 'instantroofer-auto-L1', db.data['measurements/auto-L1'].externalJobId);
    const wdb = makeDb();
    await PM._test.measureLeadAndPublish(wdb, { leadId: 'W2', lead, deps: { fetchImpl, bucket } });
    ok('web-lead externalJobId stays <provider>-weblead-<leadId>', wdb.data['measurements/weblead-W2'] && wdb.data['measurements/weblead-W2'].externalJobId === 'instantroofer-weblead-W2');
    // 'auto' with no Solar key falls back to Instant Roofer — the outline
    // request must survive the Solar wrapper's ctx hand-off.
    const { PROVIDERS } = require(path.join(FN, 'integrations', '_shared.js'));
    const prevMode = PROVIDERS.measurement, prevSolar = process.env.SOLAR_API_KEY;
    PROVIDERS.measurement = 'auto'; delete process.env.SOLAR_API_KEY;
    try {
      sentBody = null; saved.length = 0;
      const adb = makeDb();
      const aout = await PM._test.measureLeadAndPublish(adb, { leadId: 'A1', lead, jobDocId: 'auto-A1', source: 'auto-order:stage', withOutline: true, deps: { fetchImpl, bucket } });
      ok('provider=auto (Solar unconfigured) still asks Instant Roofer for the outline', aout.ok === true && sentBody && sentBody.resultOptions && sentBody.resultOptions.mapWithOutlineFromImageModel === true);
      ok('provider=auto saves the fallback outline too', saved.length === 1 && saved[0][0] === 'docs/u1/measurements/A1-outline.png');
    } finally {
      PROVIDERS.measurement = prevMode; if (prevSolar !== undefined) process.env.SOLAR_API_KEY = prevSolar;
    }
    const IR = require(path.join(FN, 'integrations', 'instantroofer-logic.js'));
    ok('outlineImage refuses bytes that are not an image', IR.outlineImage({ imagery: { mapWithOutline: Buffer.from('<svg onload=x>hello</svg>').toString('base64') } }) === null);
    delete process.env.INSTANTROOFER_API_KEY;
  });
  await guard(async () => {
    const IDX = require('fs').readFileSync(path.join(FN, 'index.js'), 'utf8');
    ok('index.js deploys both auto-order doors', /exports\.autoMeasureOnStage = measureAutoOrder\.autoMeasureOnStage/.test(IDX) && /exports\.autoMeasureOnAppointment = measureAutoOrder\.autoMeasureOnAppointment/.test(IDX));
  });

  console.log('\n──────────────────────────────────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failures:\n - ' + fails.join('\n - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
