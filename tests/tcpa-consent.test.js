/**
 * tests/tcpa-consent.test.js
 * ═══════════════════════════════════════════════════════════════
 *
 * Guards the TCPA consent chain end to end, in the REQUIRED unit-suite job
 * (not the advisory emulator bucket), because the failure this protects
 * against is silent by nature: nothing throws, nothing goes red, a homeowner
 * simply gets a text the business cannot prove it was allowed to send.
 *
 * The bug this was written for (2026-09-04), in three links:
 *
 *   1. The /estimate funnel gates its submit button on a consent checkbox and
 *      posts `tcpaConsent: true`.
 *   2. submitPublicLead's M-04 optional-field loop drops every non-string, and
 *      the estimate kind never listed the field — so it was discarded on every
 *      submission and NO lead ever carried a consent record.
 *   3. lead-alert's ackHomeownerSms inferred consent from the collection name
 *      instead of reading the record, so it would have texted anything landing
 *      in estimate_leads by any route.
 *
 * Link 2 is covered by parseSubmittedConsent + a source contract on the
 * gateway's declaration; link 3 by the smsAckGate matrix. The real HTTP
 * round-trip lives in tests/public-intake.test.js (emulator).
 *
 * Run: node tests/tcpa-consent.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const C = require('../functions/tcpa-consent');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push({ name, message: e && e.message ? e.message : String(e) });
  }
}

console.log('TCPA CONSENT — stored fact, not an inference');
console.log('═'.repeat(64));

// ── parseSubmittedConsent: what the gateway is allowed to store ──────────
// The distinction that matters is three-valued. `undefined` must stay
// undefined so an absent field is never written as a decline.

check('T1  boolean true is consent', () => {
  assert.strictEqual(C.parseSubmittedConsent(true), true);
});

check('T2  the string "true" is consent (form-encoded callers)', () => {
  assert.strictEqual(C.parseSubmittedConsent('true'), true);
});

check('T3  boolean false is an explicit decline, stored as false', () => {
  assert.strictEqual(C.parseSubmittedConsent(false), false);
});

check('T4  the string "false" is an explicit decline', () => {
  assert.strictEqual(C.parseSubmittedConsent('false'), false);
});

check('T5  an ABSENT field returns undefined, so nothing is written', () => {
  assert.strictEqual(C.parseSubmittedConsent(undefined), undefined);
  assert.strictEqual(C.parseSubmittedConsent(null), undefined);
});

check('T6  truthy near-misses are NOT consent', () => {
  // Every one of these means somebody wrote the field by a path that was not
  // the consent checkbox. A consent record you cannot explain is worse than
  // none, so each must fall through to undefined rather than to true.
  for (const v of [1, '1', 'yes', 'on', 'TRUE', 'True', {}, [], 'checked']) {
    assert.strictEqual(
      C.parseSubmittedConsent(v),
      undefined,
      `${JSON.stringify(v)} must not parse as a consent value`,
    );
  }
});

// ── hasWrittenConsent: what counts as proof on a stored document ─────────

check('T7  a stored boolean true is provable consent', () => {
  assert.strictEqual(C.hasWrittenConsent({ tcpaConsent: true }), true);
});

check('T8  a MISSING field is not consent — the pre-fix state of every lead', () => {
  assert.strictEqual(C.hasWrittenConsent({}), false);
  assert.strictEqual(C.hasWrittenConsent({ firstName: 'Dana' }), false);
});

check('T9  null/undefined documents do not throw and are not consent', () => {
  assert.strictEqual(C.hasWrittenConsent(null), false);
  assert.strictEqual(C.hasWrittenConsent(undefined), false);
});

check('T10 stored truthy non-booleans are not consent', () => {
  for (const v of [1, 'true', 'yes', 'on', {}]) {
    assert.strictEqual(
      C.hasWrittenConsent({ tcpaConsent: v }),
      false,
      `stored ${JSON.stringify(v)} must not count as consent`,
    );
  }
});

check('T11 an explicit stored false is not consent', () => {
  assert.strictEqual(C.hasWrittenConsent({ tcpaConsent: false }), false);
});

// ── smsAckGate: the send-time decision ──────────────────────────────────

const NBD = { isNbd: true };
const TENANT = { isNbd: false };
const CONSENTED = { tcpaConsent: true, phone: '8594207382' };
const NO_CONSENT = { phone: '8594207382' };

check('T12 the happy path opens the gate', () => {
  const g = C.smsAckGate({ enabled: true, collection: 'estimate_leads', doc: CONSENTED, target: NBD });
  assert.strictEqual(g.allowed, true);
  assert.strictEqual(g.reason, 'consent_on_record');
});

check('T13 THE REGRESSION — a consent-less estimate lead is refused', () => {
  // This is the whole point of the change. Before the fix this document was
  // texted, because the gate stopped at `collection === 'estimate_leads'`.
  const g = C.smsAckGate({ enabled: true, collection: 'estimate_leads', doc: NO_CONSENT, target: NBD });
  assert.strictEqual(g.allowed, false, 'a lead with no stored consent must never be texted');
  assert.strictEqual(g.reason, 'no_stored_consent');
});

check('T14 the flag off refuses everything, even a consented lead', () => {
  const g = C.smsAckGate({ enabled: false, collection: 'estimate_leads', doc: CONSENTED, target: NBD });
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.reason, 'flag_disabled');
});

check('T15 a non-boolean `enabled` does not open the gate', () => {
  // Guards against a caller passing the raw env string, which is truthy for
  // literally any value including 'false'.
  for (const v of ['true', 1, 'yes', {}]) {
    const g = C.smsAckGate({ enabled: v, collection: 'estimate_leads', doc: CONSENTED, target: NBD });
    assert.strictEqual(g.allowed, false, `enabled=${JSON.stringify(v)} must not open the gate`);
    assert.strictEqual(g.reason, 'flag_disabled');
  }
});

check('T16 collections without a consent disclosure are refused', () => {
  // storm_alert_subscribers is the sharp one: storm-watch.js texts that list,
  // and its form collects no texting consent.
  for (const col of ['storm_alert_subscribers', 'contact_leads', 'guide_leads', 'free_roof_entries', '']) {
    const g = C.smsAckGate({ enabled: true, collection: col, doc: CONSENTED, target: NBD });
    assert.strictEqual(g.allowed, false, `${col || '(empty)'} must not be consent-bearing`);
    assert.strictEqual(g.reason, 'collection_not_consent_bearing');
  }
});

check('T17 another tenant’s homeowner is never texted with Joe’s brand', () => {
  const g = C.smsAckGate({ enabled: true, collection: 'estimate_leads', doc: CONSENTED, target: TENANT });
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.reason, 'not_nbd_lead');
});

check('T18 a missing target is refused rather than defaulting to NBD', () => {
  for (const t of [null, undefined, {}]) {
    const g = C.smsAckGate({ enabled: true, collection: 'estimate_leads', doc: CONSENTED, target: t });
    assert.strictEqual(g.allowed, false);
    assert.strictEqual(g.reason, 'not_nbd_lead');
  }
});

check('T19 the gate never throws on a junk call', () => {
  assert.strictEqual(C.smsAckGate().allowed, false);
  assert.strictEqual(C.smsAckGate({}).allowed, false);
  assert.strictEqual(C.smsAckGate({ enabled: true }).allowed, false);
});

check('T20 CONSENT_COLLECTIONS is frozen and holds exactly the funnels that present a disclosure', () => {
  // A collection earns a place here only once its form presents a disclosure
  // and gates submission on it. Widening this list is a legal decision, so it
  // should fail a test rather than pass a review unnoticed — and it did, on
  // 2026-09-04, when inspect_leads was added: three of its four forms
  // (/storm-check, /roof-score, /storm-report) present the texting disclosure
  // and post the checkbox value; the fourth (/inspect) has no checkbox, posts
  // nothing, and so its documents fail hasWrittenConsent and are never texted.
  // T27–T30 below pin each half of that claim.
  assert.deepStrictEqual([...C.CONSENT_COLLECTIONS], ['estimate_leads', 'inspect_leads']);
  assert.strictEqual(Object.isFrozen(C.CONSENT_COLLECTIONS), true);
});

// ── Source contract on the gateway (link 2 of the chain) ─────────────────
// parseSubmittedConsent being correct is worth nothing if submitPublicLead
// stops calling it, or if the estimate kind stops declaring the field. Both
// are one-line deletions that no behavioural unit test would notice.

const GATEWAY = fs.readFileSync(path.join(ROOT, 'functions', 'handlers', 'integrations.js'), 'utf8');

check('T21 the estimate kind still declares tcpaConsent as a boolean field', () => {
  const estimateBlock = GATEWAY.slice(
    GATEWAY.indexOf('  estimate: {'),
    GATEWAY.indexOf('  storm: {'),
  );
  assert.ok(estimateBlock.length > 0, 'could not locate the estimate kind block');
  assert.ok(
    /boolOptional:\s*\[[^\]]*'tcpaConsent'/.test(estimateBlock),
    'estimate kind must declare boolOptional including tcpaConsent — without it the '
      + 'funnel’s consent boolean is silently dropped again',
  );
});

check('T22 the gateway still runs a boolOptional loop through the shared parser', () => {
  assert.ok(
    /for\s*\(const key of \(spec\.boolOptional \|\| \[\]\)\)/.test(GATEWAY),
    'the boolOptional loop is gone — declared consent fields would never persist',
  );
  assert.ok(
    /parseSubmittedConsent/.test(GATEWAY),
    'the gateway must coerce through tcpa-consent.parseSubmittedConsent, not its own inline rule',
  );
});

check('T23 the string allowlist still refuses non-strings (M-04 hardening intact)', () => {
  // The tempting "fix" for the original bug was to relax this guard. That
  // would have re-opened M-04 for every kind, letting arbitrary non-string
  // types be written under allowlisted keys.
  assert.ok(
    /if \(typeof v !== 'string'\) continue;/.test(GATEWAY),
    'the optional-string loop must still drop non-strings — boolean support belongs '
      + 'in the separate boolOptional loop, not in a loosened string guard',
  );
});

// ── Source contract on the send path (link 3) ───────────────────────────

const LEAD_ALERT = fs.readFileSync(path.join(ROOT, 'functions', 'lead-alert.js'), 'utf8');

check('T24 ackHomeownerSms decides through smsAckGate, not an inline collection check', () => {
  const fn = LEAD_ALERT.slice(
    LEAD_ALERT.indexOf('async function ackHomeownerSms'),
    LEAD_ALERT.indexOf('const TRIGGER_OPTS'),
  );
  assert.ok(fn.length > 0, 'could not locate ackHomeownerSms');
  assert.ok(/smsAckGate\(/.test(fn), 'ackHomeownerSms must route its decision through smsAckGate');
  assert.ok(
    !/collection !== 'estimate_leads'/.test(fn),
    'the old collection-name inference is back — consent must be read from the document',
  );
});

check('T25 the bridge carries the consent record onto the CRM lead', () => {
  const BRIDGE = fs.readFileSync(path.join(ROOT, 'functions', 'lead-bridge-logic.js'), 'utf8');
  assert.ok(
    /data\.tcpaConsent === true/.test(BRIDGE),
    'lead-bridge-logic must copy a stored consent onto the CRM lead so the proof '
      + 'lives where Jo looks',
  );
});

// ── Every funnel path that GATES on the box must also SEND the field ────
// The /estimate funnel has TWO submit buttons and both refuse to submit
// without the consent checkbox — but only one of them put the value in its
// payload. That asymmetry is invisible until something reads the flag, and
// then it silently suppresses the acknowledgement for a homeowner who
// consented and explicitly asked to be called. Found by the 2026-09-04 audit
// AFTER the gate had already been written, which is exactly the window in
// which this class of bug ships.

check('T26 every funnel payload that gates on the consent box also sends it', () => {
  const FUNNEL = fs.readFileSync(
    path.join(ROOT, 'docs', 'assets', 'js', 'inline', '4053149b2f.js'), 'utf8',
  );
  // Both submit handlers, sliced to their own bodies.
  const paths = [
    ['submitAndGetEstimate', 'async function submitAndGetEstimate'],
    ['skipOtpAndRequestCall', 'async function skipOtpAndRequestCall'],
  ];
  for (const [name, marker] of paths) {
    const start = FUNNEL.indexOf(marker);
    assert.ok(start > 0, `could not locate ${name} in the funnel`);
    // Each handler builds exactly one `var leadData = {...}`; take that object.
    const ld = FUNNEL.indexOf('var leadData = {', start);
    assert.ok(ld > 0, `${name} has no leadData payload`);
    const body = FUNNEL.slice(ld, FUNNEL.indexOf('};', ld));
    assert.ok(
      /tcpaConsent\s*:/.test(body),
      `${name}'s leadData omits tcpaConsent — it refuses to submit without the `
        + 'checkbox, so the lead would land with no provable consent and the SMS '
        + 'ack would silently never fire for it',
    );
  }
});

// ── The inspect kind's four forms (2026-09-04) ───────────────────────────

check('T27 the inspect kind declares tcpaConsent as a boolean field', () => {
  const inspectBlock = GATEWAY.slice(GATEWAY.indexOf('  inspect: {'), GATEWAY.indexOf('};', GATEWAY.indexOf('  inspect: {')));
  assert.ok(inspectBlock.length > 0, 'could not locate the inspect kind block');
  assert.ok(/boolOptional:\s*\[[^\]]*'tcpaConsent'/.test(inspectBlock),
    'inspect kind must declare boolOptional including tcpaConsent, or the three funnels’ boolean is dropped again');
});

const FUNNELS = {
  '/storm-check':  { js: 'storm-check.js',       html: 'storm-check.html',  checkbox: 'sc-consent' },
  '/roof-score':   { js: 'roof-score.js',        html: 'roof-score.html',   checkbox: 'rs-consent' },
  '/storm-report': { js: 'storm-report-page.js', html: 'storm-report.html', checkbox: 'sr-consent' },
};

check('T28 each of the three inspect-kind funnels posts tcpaConsent in the same payload it gates', () => {
  for (const [route, f] of Object.entries(FUNNELS)) {
    const js = fs.readFileSync(path.join(ROOT, 'docs', 'assets', 'js', f.js), 'utf8');
    const start = js.indexOf('var payload = {');
    assert.ok(start > 0, route + ': no payload literal found');
    const body = js.slice(start, js.indexOf('};', start));
    assert.ok(/tcpaConsent\s*:/.test(body), route + ' gates submit on ' + f.checkbox + ' but its payload omits tcpaConsent');
    assert.ok(js.includes("$('" + f.checkbox + "').checked"), route + ' no longer reads the ' + f.checkbox + ' checkbox');
  }
});

check('T29 each of those three forms presents an express-written-consent TEXTING disclosure', () => {
  for (const [route, f] of Object.entries(FUNNELS)) {
    const html = fs.readFileSync(path.join(ROOT, 'docs', f.html), 'utf8');
    const i = html.indexOf('id="' + f.checkbox + '"');
    assert.ok(i > 0, route + ': checkbox ' + f.checkbox + ' missing');
    const label = html.slice(i, html.indexOf('</label>', i));
    for (const must of ['text', 'Message &amp; data rates', 'Reply STOP', 'Consent is not a condition of purchase', 'No Big Deal Home Solutions']) {
      assert.ok(label.includes(must), route + ": consent label lacks '" + must + "' — a contact-me checkbox is not texting consent");
    }
  }
});

check('T30 /inspect presents the disclosure AND posts the field (never a checkbox that is not recorded)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'docs', 'inspect.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'docs', 'assets', 'js', 'inspect-form.js'), 'utf8');
  assert.ok(/id="ins-consent"/.test(html) && /Reply STOP/.test(html), '/inspect lost its consent checkbox (2026-10-03)');
  assert.ok(/tcpaConsent\s*[:=]/.test(js) && js.includes("getElementById('ins-consent')"),
    'inspect.html shows a consent box but inspect-form.js does not post it — the exact bug #1377 fixed');
});

// ── The consent RECORD (2026-10-03, legal-checklist audit) ───────────────
// A boolean says THAT a box was ticked. A defensible record also says when,
// what text, which page, which IP — stamped by the server.

check('T31 consentRecord stamps when / which text / which page / which IP for a consent', () => {
  const rec = C.consentRecord({
    consent: true, kind: 'storm', referer: 'https://nobigdealwithjoedeal.com/storm-alerts?utm_source=yard-sign',
    source: 'storm-alerts-page', ip: '203.0.113.9', at: '__server_ts__',
  });
  assert.deepStrictEqual(rec, {
    tcpaConsentAt: '__server_ts__',
    tcpaConsentText: 'tcpa-storm-alerts-v2-2026-10-05',
    tcpaConsentSource: '/storm-alerts',
    tcpaConsentIp: '203.0.113.9',
  });
  assert.ok(!/utm_/.test(rec.tcpaConsentSource), 'the query string must never reach the consent record');
});

check('T32 no consent (false / absent / truthy junk) → no record at all', () => {
  for (const v of [false, undefined, null, 'true', 1]) {
    assert.deepStrictEqual(C.consentRecord({ consent: v, kind: 'contact', at: 'x', ip: '1.2.3.4' }), {},
      'consent=' + JSON.stringify(v) + ' must not produce a consent record');
  }
});

check('T33 source falls back to the form tag without a usable Referer; IP omitted when unknown', () => {
  const rec = C.consentRecord({ consent: true, kind: 'inspect', referer: 'not a url', source: '/inspect', at: 't' });
  assert.strictEqual(rec.tcpaConsentSource, '/inspect');
  assert.ok(!('tcpaConsentIp' in rec));
});

check('T34 /estimate and /storm-alerts record THEIR wording versions; every other kind the shared one', () => {
  assert.strictEqual(C.consentVersionForKind('estimate'), C.ESTIMATE_CONSENT_VERSION);
  assert.strictEqual(C.consentVersionForKind('storm'), C.STORM_ALERTS_CONSENT_VERSION);
  for (const k of ['inspect', 'contact']) assert.strictEqual(C.consentVersionForKind(k), C.CONSENT_VERSION);
  assert.ok(C.CONSENT_TEXTS[C.CONSENT_VERSION] && C.CONSENT_TEXTS[C.ESTIMATE_CONSENT_VERSION]
    && C.CONSENT_TEXTS[C.STORM_ALERTS_CONSENT_VERSION]);
  // Old versions are never deleted: records already stamped with them must
  // keep pointing at the words those people saw.
  for (const v of ['tcpa-v1-2026-10-03', 'tcpa-estimate-v1-2026-10-03']) assert.ok(C.CONSENT_TEXTS[v], v + ' was removed');
  assert.strictEqual(Object.isFrozen(C.CONSENT_TEXTS), true);
});

// The stored version id is only evidence if it names the words the person
// actually saw. Pin every page's label to the one shared constant.
function labelText(src, id) {
  const i = src.indexOf('id="' + id + '"');
  assert.ok(i > 0, 'checkbox ' + id + ' missing');
  const raw = src.slice(i, src.indexOf('</label>', i));
  // Link text is not part of the stored words: drop the link group
  // ("Privacy Policy · Terms", Twilio 30564, 2026-10-06) — the anchors AND the
  // separator between them, nothing else.
  return raw.replace(/^[^>]*>/, '').replace(/<a [^>]*>[^<]*<\/a>(?:\s*&middot;\s*<a [^>]*>[^<]*<\/a>)*/g, '').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
const PAGES_V1 = [
  ['docs/storm-check.html', 'sc-consent'], ['docs/roof-score.html', 'rs-consent'],
  ['docs/storm-report.html', 'sr-consent'], ['docs/inspect.html', 'ins-consent'],
  ['docs/index.html', 'fieldConsent'],
  ['docs/assets/js/quick-lead-form.js', "' + uid + '-consent"],
];

check('T35 every consent label is word-for-word the text its stored version id names', () => {
  for (const [file, id] of PAGES_V1) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.strictEqual(labelText(src, id), C.CONSENT_TEXTS[C.CONSENT_VERSION],
      file + ': label differs from CONSENT_TEXTS[' + C.CONSENT_VERSION + '] — new wording needs a NEW version id');
  }
  const est = fs.readFileSync(path.join(ROOT, 'docs', 'estimate.html'), 'utf8');
  assert.strictEqual(labelText(est, 'tcpaConsent'), C.CONSENT_TEXTS[C.ESTIMATE_CONSENT_VERSION]);
  const sa = fs.readFileSync(path.join(ROOT, 'docs', 'storm-alerts.html'), 'utf8');
  assert.strictEqual(labelText(sa, 'sa-consent'), C.CONSENT_TEXTS[C.STORM_ALERTS_CONSENT_VERSION]);
});

check('T36 the three newly-gated forms read their box, refuse without it, and post tcpaConsent', () => {
  const forms = [
    ['docs/assets/js/inline/c5a2295382.js', "getElementById('sa-consent')"],
    ['docs/assets/js/inline/72f02d79d0.js', "getElementById('fieldConsent')"],
    ['docs/assets/js/quick-lead-form.js', "getElementById(uid + '-consent')"],
  ];
  for (const [file, read] of forms) {
    const js = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(js.includes(read), file + ' no longer reads its consent checkbox');
    assert.ok(/if\s*\(\s*!consent\s*\)\s*\{/.test(js), file + ' no longer refuses to submit without consent');
    assert.ok(/tcpaConsent:\s*consent === true/.test(js), file + ' does not post tcpaConsent');
  }
});

check('T37 the storm and contact kinds declare tcpaConsent, and the gateway stamps the record', () => {
  for (const [from, to] of [['  storm: {', '  free_roof: {'], ['  contact: {', '  estimate: {']]) {
    const block = GATEWAY.slice(GATEWAY.indexOf(from), GATEWAY.indexOf(to));
    assert.ok(block.length > 0 && /boolOptional:\s*\[[^\]]*'tcpaConsent'/.test(block), from.trim() + ' kind must declare tcpaConsent');
  }
  assert.ok(/TCPA\.consentRecord\(/.test(GATEWAY), 'submitPublicLead no longer stamps the consent record');
});

// ── Behaviour: one real submitPublicLead round-trip per newly-gated kind ──
// Loads functions/handlers/integrations.js with Firestore / limiter /
// Turnstile stubbed, posts the way each page posts, and reads what was
// written. A source contract can pass with the record missing; this cannot.
async function gatewayRoundTrip(kind, body, headers) {
  const Module = require('module');
  const added = [];
  const stubs = {
    'firebase-functions/v2/https': { onRequest: (o, h) => ({ __handler: h }), onCall: (o, h) => ({ __handler: h }), HttpsError: Error },
    'firebase-admin/firestore': {
      getFirestore: () => ({
        collection: (name) => ({
          add: async (row) => { added.push({ name, row }); return { id: 'doc-1' }; },
          doc: () => ({ get: async () => ({ exists: false }) }),
        }),
      }),
      FieldValue: { serverTimestamp: () => '__server_ts__' },
    },
    '../integrations/upstash-ratelimit': {
      enforceRateLimit: async () => ({}), httpRateLimit: async () => true, clientIp: () => '198.51.100.7', provider: 'stub',
    },
    '../integrations/turnstile': { verifyTurnstile: async () => ({ ok: true, configured: false }) },
  };
  const real = Module._load;
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return real.apply(this, arguments);
  };
  const file = path.join(ROOT, 'functions', 'handlers', 'integrations.js');
  delete require.cache[file];
  let mod;
  try { mod = require(file); } finally { Module._load = real; }
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
  await mod.submitPublicLead.__handler({ method: 'POST', headers: headers || {}, body: Object.assign({ kind }, body) }, res);
  delete require.cache[file];
  return { res, added };
}

const ROUND_TRIPS = [
  ['storm', { name: 'Sam', phone: '8594207382', zip: '45122', source: 'storm-alerts-page', tcpaConsent: true },
    'https://nobigdealwithjoedeal.com/storm-alerts', 'storm_alert_subscribers', '/storm-alerts'],
  ['contact', { firstName: 'Sam', phone: '8594207382', address: '12 Main St, Mason, OH', source: 'homepage', tcpaConsent: true },
    'https://nobigdealwithjoedeal.com/', 'contact_leads', '/'],
  ['inspect', { name: 'Sam', phone: '8594207382', address: '12 Main St, Mason, OH', source: '/inspect', tcpaConsent: true },
    undefined, 'inspect_leads', '/inspect'],
];

const asyncChecks = [];
for (const [kind, body, referer, coll, srcPath] of ROUND_TRIPS) {
  asyncChecks.push(['T38 gateway round-trip (' + kind + '): consent posted → consent record stored', async () => {
    const { res, added } = await gatewayRoundTrip(kind, body, referer ? { referer } : {});
    assert.strictEqual(res.code, 200, JSON.stringify(res.body));
    assert.strictEqual(added.length, 1);
    const { name, row } = added[0];
    assert.strictEqual(name, coll);
    assert.strictEqual(row.tcpaConsent, true, kind + ': the boolean was dropped');
    assert.strictEqual(row.tcpaConsentAt, '__server_ts__', kind + ': no server timestamp on the consent');
    assert.strictEqual(row.tcpaConsentText, C.consentVersionForKind(kind));
    assert.strictEqual(row.tcpaConsentSource, srcPath);
    assert.strictEqual(row.tcpaConsentIp, '198.51.100.7');
  }]);
}
asyncChecks.push(['T39 gateway round-trip: no consent posted → no consent fields at all', async () => {
  const { res, added } = await gatewayRoundTrip('contact',
    { firstName: 'Sam', phone: '8594207382', address: '12 Main St, Mason, OH', source: 'homepage' });
  assert.strictEqual(res.code, 200);
  const row = added[0].row;
  for (const k of ['tcpaConsent', 'tcpaConsentAt', 'tcpaConsentText', 'tcpaConsentSource', 'tcpaConsentIp']) {
    assert.ok(!(k in row), k + ' written for a submission that never consented');
  }
}]);

// ── Report ──────────────────────────────────────────────────────────────

(async () => {
  for (const [name, fn] of asyncChecks) {
    try { await fn(); passed++; } catch (e) { failures.push({ name, message: e && e.message ? e.message : String(e) }); }
  }
  console.log('');
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.message}`);
    console.log('');
    console.log(`FAILED — ${passed} passed, ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`PASSED — ${passed} assertions across the consent chain`);
  process.exit(0);
})();
