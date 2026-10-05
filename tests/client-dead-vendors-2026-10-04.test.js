/**
 * tests/client-dead-vendors-2026-10-04.test.js
 *
 * Vendor audit Lane D (documentation/audit/VENDOR-COST-LOCKIN-2026-10-04.md):
 * client-side third parties that were dead, dormant, or a privacy leak.
 *
 *  1. The homepage contact form copied every lead (name, phone, address) to
 *     FormSubmit.co, a free third party, as a "backup". Our own intake
 *     (submitPublicLead → contact_leads → lead-alert email/SMS) already does
 *     that job. The form must now post ONLY to our intake, with every field.
 *  2. EmailJS: vendored SDK + a never-configured send path. Gone.
 *  3. OpenWeatherMap (D2D storm banner, Rep OS weather card) and RainViewer
 *     radar tiles (D2D + Maps "Live Weather") — their hosts were never in the
 *     CSP, so they could never have worked. Gone, and a generic guard below
 *     makes sure every tile host the CRM asks Leaflet for IS in img-src.
 *  4. D2D / Maps / Storm Center imagery no longer uses the undocumented Google
 *     mt*.google.com/vt endpoint: Esri World Imagery with attribution, a USGS
 *     National Map (public domain) underlay, one retry on Esri's other host.
 *
 * Behavioural where it matters: the contact form's submitForm() and the D2D
 * basemap builder are executed in a vm sandbox against fakes.
 *
 * Run: node tests/client-dead-vendors-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Homepage contact form — executed.
// ─────────────────────────────────────────────────────────────────────────
console.log('\nHOMEPAGE CONTACT FORM — posts only to our own intake, with every field');

function runHomepageSubmit({ withBridge }) {
  const src = read('docs/assets/js/inline/72f02d79d0.js').split('\r\n').join('\n');
  const from = src.indexOf('function _formShowError(');
  const body = from === -1 ? '' : src.slice(from);
  const fetches = [];
  const bridgeCalls = [];
  const gatewayCalls = [];
  const els = {};
  const mk = (id, props) => {
    els[id] = Object.assign({
      id, value: '', checked: false, hidden: true, textContent: '', innerHTML: '', disabled: false,
      style: {}, attrs: {}, classList: { add() {}, remove() {} },
      setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; },
      focus() {}, scrollIntoView() {},
    }, props || {});
    return els[id];
  };
  mk('fieldFirst', { value: 'Pat' });
  mk('fieldLast', { value: 'Homeowner' });
  mk('fieldPhone', { value: '(513) 555-0142' });
  mk('fieldEmail', { value: 'pat@test.invalid' });
  mk('fieldAddress', { value: '123 Main St, Batavia OH' });
  mk('fieldService', { value: 'Roof Replacement' });
  mk('fieldMessage', { value: 'Shingles in the yard after the storm' });
  mk('fieldNbdHp', { value: '' });
  mk('fieldConsent', { checked: true });
  mk('formError'); mk('formFields'); mk('formSuccess');
  const btn = mk('__btn', { textContent: 'Get My Free Estimate →' });
  const document = {
    getElementById: (id) => els[id] || null,
    querySelector: (sel) => (sel === '.form-submit' ? btn : null),
    querySelectorAll: () => [],
  };
  const window = {
    NBDIntake: {
      read: () => ({ fields: { scheduling: 'calendar' }, files: [] }),
      afterSubmit() {},
    },
    submitPublicLead: async (kind, fields) => { gatewayCalls.push({ kind, fields }); return { ok: true, id: 'x1', photoToken: null }; },
  };
  if (withBridge) window._captureContactLead = async (data) => { bridgeCalls.push(data); return true; };
  const fetch = (url, opts) => { fetches.push({ url: String(url), opts }); return Promise.resolve({ ok: true }); };
  const FormData = function () { this._e = []; this.append = (k, v) => this._e.push([k, v]); };
  const ctx = vm.createContext({ window, document, fetch, FormData, console: { log() {}, warn() {}, error() {} }, setTimeout, Promise });
  vm.runInContext(body + '\n;this.__submit = submitForm;', ctx);
  return ctx.__submit().then(() => ({ fetches, bridgeCalls, gatewayCalls, els }));
}

const FIELDS = {
  firstName: 'Pat', lastName: 'Homeowner', phone: '(513) 555-0142', email: 'pat@test.invalid',
  address: '123 Main St, Batavia OH', service: 'Roof Replacement',
  message: 'Shingles in the yard after the storm', scheduling: 'calendar', tcpaConsent: true,
};

const asyncChecks = (async () => {
  try {
    const r = await runHomepageSubmit({ withBridge: true });
    ok('no request to formsubmit.co (or any third party) — the form made no fetch() of its own',
       r.fetches.length === 0, r.fetches.map((f) => f.url).join(', '));
    ok('exactly one lead handed to our intake bridge (_captureContactLead → submitPublicLead)', r.bridgeCalls.length === 1);
    const got = r.bridgeCalls[0] || {};
    const missing = Object.keys(FIELDS).filter((k) => got[k] !== FIELDS[k]);
    ok('the intake receives EVERY field the old relay carried (name, phone, email, address, service, message, scheduling) + TCPA consent',
       missing.length === 0, 'missing/different: ' + missing.join(', '));
    ok('success card shown on a captured lead', r.els.formSuccess.style.display === 'block');

    const r2 = await runHomepageSubmit({ withBridge: false });
    ok('bridge stub missing: still no third-party fetch', r2.fetches.length === 0, r2.fetches.map((f) => f.url).join(', '));
    ok('bridge stub missing: posts straight to submitPublicLead("contact") with source "homepage" and every field',
       r2.gatewayCalls.length === 1 && r2.gatewayCalls[0].kind === 'contact' && r2.gatewayCalls[0].fields.source === 'homepage' &&
       Object.keys(FIELDS).every((k) => r2.gatewayCalls[0].fields[k] === FIELDS[k]));
  } catch (e) {
    ok('homepage submitForm() runs in the sandbox', false, e && e.stack || String(e));
  }
})();

{
  const js = codeOnly(read('docs/assets/js/inline/72f02d79d0.js'));
  ok('homepage form JS no longer names formsubmit.co', !/formsubmit/i.test(js));
  ok('index.html cache-busts the form JS past v=2', /72f02d79d0\.js\?v=(\d+)/.test(read('docs/index.html')) && Number(/72f02d79d0\.js\?v=(\d+)/.exec(read('docs/index.html'))[1]) >= 3);
  const priv = read('docs/privacy.html');
  ok('privacy policy no longer says leads are relayed through FormSubmit', !/formsubmit/i.test(priv));
  // The server side of the claim above: the `contact` kind allowlists every field.
  const { _publicLeadSpec } = require(path.join(ROOT, 'functions/handlers/integrations.js'));
  const spec = _publicLeadSpec && _publicLeadSpec.PUBLIC_LEAD_KINDS && _publicLeadSpec.PUBLIC_LEAD_KINDS.contact;
  const accepted = spec ? [].concat(spec.required, spec.optional, spec.boolOptional || []) : [];
  const notAccepted = Object.keys(FIELDS).filter((k) => !accepted.includes(k));
  ok('submitPublicLead("contact") accepts every field the form posts (nothing silently stripped)',
     !!spec && notAccepted.length === 0, 'not accepted: ' + notAccepted.join(', '));
}

// ─────────────────────────────────────────────────────────────────────────
// 2. EmailJS — removed with its callers.
// ─────────────────────────────────────────────────────────────────────────
console.log('\nEMAILJS — vendored SDK and dormant send path removed');
{
  ok('docs/assets/vendor/emailjs/ is gone', !exists('docs/assets/vendor/emailjs'));
  const es = codeOnly(read('docs/pro/js/email_system.js'));
  ok('email_system.js has no EmailJS code path', !/emailjs/i.test(es));
  ok('email_system.js keeps the live API (stage emails + brand fields)',
     /window\.emailByStage\s*=/.test(es) && /buildStageEmail/.test(es) && /_brandFields/.test(es));
}

// ─────────────────────────────────────────────────────────────────────────
// 3 + 4. CSP vs. the hosts the code actually uses.
// ─────────────────────────────────────────────────────────────────────────
const fb = JSON.parse(read('firebase.json'));
const allRule = fb.hosting.headers.filter((h) => h.source === '**')[0];
const dashCsp = (allRule.headers || []).filter((h) => /^Content-Security-Policy(-Report-Only)?$/.test(h.key));
function directive(value, name) {
  const m = new RegExp('(?:^|;)\\s*' + name + ' ([^;]+)').exec(value);
  return m ? m[1].trim().split(/\s+/) : [];
}
function allowed(sources, host) {
  return sources.some((s) => {
    const h = s.replace(/^https:\/\//, '');
    if (h === host) return true;
    if (h.startsWith('*.')) return host.endsWith(h.slice(1));
    return false;
  });
}

console.log('\nCSP — formsubmit.co dropped everywhere; the imagery underlay host allowed');
{
  ok('no CSP in firebase.json still allows formsubmit.co', !/formsubmit/i.test(read('firebase.json')));
  ok('the `**` rule still carries an enforced AND a Report-Only CSP', dashCsp.length === 2);
  for (const h of dashCsp) {
    const img = directive(h.value, 'img-src');
    ok(`${h.key}: img-src allows the USGS National Map imagery host`, allowed(img, 'basemap.nationalmap.gov'));
    ok(`${h.key}: img-src allows both Esri hosts (primary + retry)`, allowed(img, 'server.arcgisonline.com') && allowed(img, 'services.arcgisonline.com'));
    ok(`${h.key}: Google Fonts hosts kept (separate lane)`, allowed(directive(h.value, 'style-src'), 'fonts.googleapis.com') && allowed(directive(h.value, 'font-src'), 'fonts.gstatic.com'));
  }
}

console.log('\nDEAD WEATHER VENDORS — OpenWeatherMap + RainViewer gone from the CRM');
{
  const files = fs.readdirSync(path.join(ROOT, 'docs/pro/js')).filter((f) => f.endsWith('.js'));
  const owm = files.filter((f) => /openweathermap\.org/.test(codeOnly(read('docs/pro/js/' + f))));
  const rv = files.filter((f) => /rainviewer\.com/.test(codeOnly(read('docs/pro/js/' + f))));
  ok('no docs/pro/js file calls api.openweathermap.org', owm.length === 0, owm.join(', '));
  ok('no docs/pro/js file loads RainViewer tiles', rv.length === 0, rv.join(', '));
  const d2dUi = codeOnly(read('docs/pro/js/d2d-tracker-ui-2026b.js'));
  ok('D2D UI no longer calls the removed state.getWeatherAlerts()', !/getWeatherAlerts/.test(d2dUi));
  const dash = read('docs/pro/dashboard.html');
  ok('Maps view: the dead "Live Weather" toggle and FAB are gone (Storm = the NEXRAD radar stays)',
     !/id="tog-weather"/.test(dash) && !/id="fab-weather"/.test(dash) && /id="tog-storm"/.test(dash) && /id="fab-storm"/.test(dash));
  const core = codeOnly(read('docs/pro/js/maps-core.js'));
  ok('maps-core toggleOverlay no longer routes to the removed weather layer', !/showWeatherLayer|hideWeatherLayer/.test(core));

  // Generic guard (would have caught RainViewer): every https tile host a
  // docs/pro/js file hands to L.tileLayer must be allowed by img-src on both
  // dashboard CSPs, or Leaflet draws nothing and nobody sees an error.
  const hosts = new Map();
  for (const f of files) {
    const src = codeOnly(read('docs/pro/js/' + f));
    const re = /L\.tileLayer\(\s*['"`]https:\/\/([^/'"`]+)\//g;
    let m;
    while ((m = re.exec(src))) {
      const host = m[1];
      if (!hosts.has(host)) hosts.set(host, f);
    }
    // Constants that are passed to L.tileLayer by name (ESRI_TILE / USGS_IMAGERY_TILE / overlay urls).
    const re2 = /'https:\/\/([^/'{]*(?:\{s\})?[^/']*)\/[^']*\{z\}[^']*'/g;
    while ((m = re2.exec(src))) {
      const host = m[1];
      if (!hosts.has(host)) hosts.set(host, f);
    }
  }
  ok('found the tile hosts to check (scan is not vacuous)', hosts.size >= 4, [...hosts.keys()].join(' '));
  for (const h of dashCsp) {
    const img = directive(h.value, 'img-src');
    // {s} is a Leaflet subdomain slot: a/b/c for OSM, 0-3 for subdomains '0123'.
    const ok1 = (host) => !/\{s\}/.test(host) ? allowed(img, host)
      : (allowed(img, host.replace(/\{s\}/g, 'a')) || allowed(img, host.replace(/\{s\}/g, '0')));
    const blocked = [...hosts].filter(([host]) => !ok1(host)).map(([host, f]) => host + ' (' + f + ')');
    ok(`${h.key}: every tile host used in docs/pro/js is in img-src`, blocked.length === 0, blocked.join(', '));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 4. D2D basemaps — executed against a fake Leaflet.
// ─────────────────────────────────────────────────────────────────────────
console.log('\nD2D BASEMAPS — Esri + USGS underlay, no Google mt* tiles');
{
  const raw = read('docs/pro/js/d2d-tracker-core-2026b.js').split('\r\n').join('\n');
  const a = raw.indexOf('  const ESRI_TILE = ');
  const b = raw.indexOf('  const BASEMAP_ORDER = ');
  const f1 = raw.indexOf('  function _esriTileRetry(');
  const f2 = raw.indexOf('  function setBasemap(');
  ok('basemap constants and builder are where the test expects them', a > 0 && b > a && f1 > 0 && f2 > f1);
  const made = [];
  const L = {
    tileLayer(url, opts) { const handlers = {}; const l = { url, opts: opts || {}, handlers, on(ev, fn) { handlers[ev] = fn; return l; } }; made.push(l); return l; },
    layerGroup(parts) { return { group: true, parts }; },
  };
  const ctx = vm.createContext({ L });
  try {
    vm.runInContext(raw.slice(a, b) + raw.slice(f1, f2) + '\n;this.__B = BASEMAPS; this.__make = _makeBasemapLayer; this.__retry = _esriTileRetry;', ctx);
  } catch (e) { ok('basemap block evaluates', false, e.message); }
  const B = ctx.__B || {};
  const urls = [];
  Object.values(B).forEach((e) => { urls.push(e.url); (e.overlays || []).forEach((o) => urls.push(o.url)); });
  ok('five basemap choices still exist', ['satellite', 'hybrid', 'ky3in', 'streets', 'terrain'].every((k) => B[k]));
  ok('no basemap or overlay URL uses google.com', urls.length >= 5 && urls.every((u) => !/google\.com/.test(u)), urls.join(' '));
  ok('satellite / hybrid / KY 3-in are Esri World Imagery and flagged as imagery',
     ['satellite', 'hybrid', 'ky3in'].every((k) => /server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}$/.test((B[k] || {}).url) && (B[k] || {}).imagery === true));
  ok('every Esri basemap carries an Esri attribution (required by Esri)',
     Object.values(B).every((e) => /© Esri/.test(e.attribution || '')));
  ok('KY 3-in still overlays the KyFromAbove 3-inch MapServer at native z21',
     (B.ky3in && B.ky3in.overlays || []).some((o) => /kygisserver\.ky\.gov\/arcgis\/rest\/services\/WGS84WM_Services\/Ky_Imagery_Phase3_3IN_WGS84WM\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}/.test(o.url) && o.maxNativeZoom === 21));

  if (typeof ctx.__make === 'function') {
    made.length = 0;
    const sat = ctx.__make('satellite');
    ok('satellite = a group of [USGS underlay, Esri imagery]',
       sat.group && sat.parts.length === 2 && /basemap\.nationalmap\.gov/.test(sat.parts[0].url) && /World_Imagery/.test(sat.parts[1].url));
    ok('USGS underlay is capped at its cached z16 and sits below Esri (zIndex)',
       sat.parts && sat.parts[0].opts.maxNativeZoom === 16 && sat.parts[0].opts.zIndex < sat.parts[1].opts.zIndex);
    ok('Esri imagery upscales past its z19 cache instead of fetching "not available" tiles',
       sat.parts && sat.parts[1].opts.maxNativeZoom === 19);
    ok('every basemap part stays under the weather overlays (zIndex <= 0 < default 1)',
       sat.parts && sat.parts.every((p) => p.opts.zIndex <= 0));
    const hy = ctx.__make('hybrid');
    ok('hybrid = USGS + imagery + road and place-name reference overlays',
       hy.group && hy.parts.length === 4 && /World_Transportation/.test(hy.parts[2].url) && /World_Boundaries_and_Places/.test(hy.parts[3].url));
    const st = ctx.__make('streets');
    ok('streets is a single Esri street layer (no imagery underlay)', !st.group && /World_Street_Map/.test(st.url));
    // Retry rewrites the failed tile to Esri's other host exactly once.
    const tile = { src: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/18/98689/70306', dataset: {} };
    ctx.__retry({ tile, coords: { z: 18, x: 70306, y: 98689 } });
    ok('a failed Esri tile retries once on services.arcgisonline.com',
       tile.src === 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/18/98689/70306');
    const again = tile.src;
    ctx.__retry({ tile, coords: { z: 18, x: 70306, y: 98689 } });
    ok('…and never loops (second error leaves the tile for the underlay)', tile.src === again);
    ok('the Esri layer is wired to the retry handler', typeof (sat.parts && sat.parts[1].handlers.tileerror) === 'function');
  }
  const d2d = codeOnly(raw);
  ok('D2D no longer references OpenWeatherMap, RainViewer or mt*.google.com tiles',
     !/openweathermap|rainviewer|mt\{s\}\.google\.com|mt\d\.google\.com/.test(d2d));
  for (const f of ['docs/pro/js/storm-center.js', 'docs/pro/js/maps-core.js']) {
    const s = codeOnly(read(f));
    ok(`${f}: no Google mt* tiles; Esri imagery with attribution over a USGS underlay`,
       !/mt\{s\}\.google\.com|mt\$\{|google\.com\/vt/.test(s) && /World_Imagery/.test(s) && /© Esri/.test(s) && /basemap\.nationalmap\.gov/.test(s));
  }
}

asyncChecks.then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
});
