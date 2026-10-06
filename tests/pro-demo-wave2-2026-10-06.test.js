/* tests/pro-demo-wave2-2026-10-06.test.js
 *
 * Pro demo phase 2, wave 2: estimates, documents and the e-sign preview in
 * the browser-only sample account (/pro/explore). Plan:
 * documentation/projects/PRO-DEMO-PHASE2-FULL-ACCOUNT-PLAN-2026-10-06.md
 *
 * Dependency-free checks (the Chromium walk that builds an estimate,
 * generates documents and opens the e-sign preview with zero network is
 * tests/pro-demo-zero-network-2026-10-06.test.js):
 *
 *   A. The sample company is its OWN tenant on every document: the seed's
 *      companyProfile carries its own brand (so company-profile.js never
 *      falls back to NBD's name, phone or GAF/TAMKO numbers), no credential
 *      badges, and the real tenant-rules.js reads it as a non-NBD company.
 *   B. Packages, through the real tenant-rules.js: Standard / Preferred /
 *      Elite, GAF System Plus on Standard and up, every card note says
 *      "sample price", no "lifetime" promise, per-square rates = the story's
 *      prices over its squares.
 *   C. What is due when, through the real deposit-rule.js with the sample
 *      company's rules: the retail sample job shows a 50% deposit at
 *      signing; the Kentucky insurance sample job shows nothing at signing.
 *   D. Sample photos: every seeded photo resolves to a committed drawing
 *      under docs/pro/demo-sdk/media/, each file is a small self-contained
 *      SVG (no script, no external reference, no embedded raster), labelled
 *      "SAMPLE DRAWING"; the store turns {"__media"} into an absolute
 *      same-origin URL (the CRM renders absolute photo URLs only).
 *   E. The e-sign preview: the three send-to-sign callables show what they
 *      would send and still reject honestly; the preview frame is sandboxed
 *      with no permissions; getDocumentHtml reopens a generated document
 *      from the in-browser store; the strip never covers the builder's or the
 *      viewer's action bar.
 *   F. Proposal photos (a real-CRM bug the sample photos surfaced): the
 *      proposal's photo grid printed <img src="[object Object]"> for every
 *      photo the pre-flight photo selector handed it, and put the URL in
 *      the attribute unescaped.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'docs', 'pro', 'js');
const SDK = path.join(ROOT, 'docs', 'pro', 'demo-sdk');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

let failed = 0;
let passed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + String(detail).slice(0, 600) : '')); }
}

const seed = JSON.parse(read('docs/pro/demo-sdk/sample-company.json'));
const D = seed.docs;
const UID = seed.claims.companyId;
const profile = D['companyProfile/' + UID] || {};
const { readSample } = require('../scripts/build-demo-seed.js');
const S = readSample();

// ── A. the sample company is its own tenant ──────────────────────────────
console.log('A. the sample company brand');
const brand = profile.brand || {};
ok('seed version is 2 (returning browsers reseed: _store.js compares it)', seed.version === 2, seed.version);
ok('companyProfile.brand.legalName is the sample company, not NBD', brand.legalName === S.company && !/No Big Deal/i.test(JSON.stringify(brand)), JSON.stringify(brand).slice(0, 200));
ok('no credential badges (affiliates is an empty list, so NBD\'s GAF/TAMKO numbers can never print)', Array.isArray(brand.affiliates) && brand.affiliates.length === 0);
ok('no logo of anyone\'s', brand.logoUrl === '');
ok('the mailing + physical address a Kentucky contract requires is set (invented street)', /Sample Way/.test((brand.contact || {}).mailingAddress || '') && /Sample Way/.test((brand.contact || {}).address || ''));
ok('contact details are invented (555 phone, .example email)', /555-01\d\d/.test((brand.contact || {}).phone || '') && /\.example$/.test((brand.contact || {}).email || ''));

// Real tenant-rules.js + deposit-rule.js, the browser way, on the seed profile.
function loadRules(prof) {
  const win = { _companyProfile: prof, _userClaims: { companyId: UID, role: 'company_admin' }, _user: { uid: UID } };
  win.window = win;
  const sb = { window: win, console: { log() {}, warn() {}, error() {} }, Date, Math, JSON, Intl };
  vm.createContext(sb);
  for (const f of ['ky-insurance-law.js', 'estimate-config.js', 'tenant-rules.js', 'deposit-rule.js']) {
    vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sb, { filename: f });
  }
  return win;
}
const W = loadRules(profile);
const TR = W.NBDTenantRules;
ok('tenant-rules.js reads the sample company as a non-NBD tenant', TR && TR.isPlatformTenant() === false);

// ── B. packages ─────────────────────────────────────────────────────────
console.log('B. packages (real tenant-rules.js)');
const enabled = TR.tierOrder();
ok('the sample company offers the story\'s three packages', JSON.stringify(enabled) === JSON.stringify(S.tiers.map((t) => t.key)), JSON.stringify(enabled));
ok('labelled Standard / Preferred / Elite', enabled.map((t) => TR.labelOverride(t)).join('/') === 'Standard/Preferred/Elite', enabled.map((t) => TR.labelOverride(t)).join('/'));
const notes = enabled.map((t) => TR.noteFor(t) || '');
ok('GAF System Plus on Standard and up (every offered package card says System Plus)', notes.every((n) => /System Plus/.test(n)), notes.join(' | '));
ok('every package card says "sample price"', notes.every((n) => /sample price/.test(n)), notes.join(' | '));
ok('each card names the story\'s GAF shingle for that package', enabled.every((t, i) => notes[i].indexOf(S.tiers[i].shingle) === 0), notes.join(' | '));
const warr = enabled.map((t) => TR.warrantyTextOverride(t) || '');
ok('warranty sentences name System Plus and promise no "lifetime" workmanship', warr.every((w) => /System Plus/.test(w) && !/lifetime/i.test(w)), warr.join(' | '));
const rates = (profile.pricing || {}).tierRates || {};
ok('per-square package rates = the story\'s prices over its squares', S.tiers.every((t) => rates[t.key] === Math.round(t.priceCents / 100 / S.squares)), JSON.stringify(rates));
ok('the "starter prices" hint is off (the company has its own rates)', TR.ratesSet() === true);

// ── C. what is due when ─────────────────────────────────────────────────
console.log('C. due at signing (real deposit-rule.js, sample rules)');
const R = W.NBDDepositRule;
const leadOf = (n) => D['leads/sample-lead-' + String(n).padStart(2, '0')];
const retail = leadOf(13);
const ky = leadOf(1);
ok('fixtures: lead 13 is an Ohio retail job, lead 1 a Kentucky insurance job', retail.state === 'OH' && retail.jobType === 'cash' && ky.state === 'KY' && ky.jobType === 'insurance');
const retailPlan = R.compute({ total: 13900, mode: 'cash', address: retail.address, lead: retail });
ok('retail sample job: 50% deposit due at signing', retailPlan.depositCents === 695000 && /50% deposit/.test(retailPlan.summary || ''), JSON.stringify(retailPlan).slice(0, 300));
const kyPlan = R.compute({ total: 17160, mode: 'insurance', deductible: S.deductible, acv: S.acv, address: ky.address, lead: ky });
ok('Kentucky insurance sample job: nothing due at signing', kyPlan.depositCents === 0 && /Nothing is due at signing/.test(kyPlan.summary || ''), JSON.stringify(kyPlan).slice(0, 300));
const kyCash = R.compute({ total: 17160, mode: 'cash', address: ky.address, lead: ky });
ok('…even when that Kentucky insurance job is priced in cash mode', kyCash.depositCents === 0, JSON.stringify(kyCash).slice(0, 200));
// Positive control: the same rule without the sample company's deposit
// setting (a brand-new company) takes no deposit at all, so the 50% above is
// the seed's setting at work, not a default.
const W0 = loadRules(Object.assign({}, profile, { businessRules: Object.assign({}, profile.businessRules, { deposit: undefined }) }));
ok('control: without the seed\'s deposit setting the retail job would show no deposit', W0.NBDDepositRule.compute({ total: 13900, mode: 'cash', address: retail.address, lead: retail }).depositCents === 0);
const est1 = D['estimates/sample-est-01'];
ok('Jordan\'s saved estimate carries retail line items that foot to the Preferred price', Array.isArray(est1.lineItems) && est1.lineItems.reduce((s, l) => s + l.total, 0) === S.tiers[1].priceCents / 100 && est1.tier === 'better');
ok('…and is the lead\'s primary estimate; the lead has a scope of work for the contract', ky.primaryEstimateId === 'sample-est-01' && /System|Timberline/.test(ky.scopeOfWork || ''));

// ── D. sample photos ────────────────────────────────────────────────────
console.log('D. sample photos');
const photos = Object.keys(D).filter((p) => p.indexOf('photos/') === 0).map((p) => D[p]);
ok('the story customer\'s card has photos (at least 4)', photos.filter((p) => p.leadId === 'sample-lead-01').length >= 4);
ok('there are before AND after photos in the account', photos.some((p) => p.phase === 'Before') && photos.some((p) => p.phase === 'After'));
const files = new Set();
for (const p of photos) {
  const m = p.url && p.url.__media;
  if (m) files.add(m);
  ok('photo ' + (p.filename || '?') + ' points at a committed sample drawing, scoped to the sample company', !!m && fs.existsSync(path.join(SDK, 'media', m)) && p.userId === UID && p.companyId === UID && p.isSample === true && p.storagePath === 'sample/' + m);
}
const mediaDir = path.join(SDK, 'media');
for (const f of fs.readdirSync(mediaDir)) {
  const src = fs.readFileSync(path.join(mediaDir, f), 'utf8');
  const refs = (src.match(/https?:\/\/[^"'\s)]+/g) || []).filter((u) => u !== 'http://www.w3.org/2000/svg');
  ok('media/' + f + ': small self-contained SVG, labelled SAMPLE DRAWING', /\.svg$/.test(f) && src.length < 8000 && /^<svg[\s>]/.test(src) &&
    !/<script|<image|<foreignObject|\bon[a-z]+\s*=|href\s*=|data:/i.test(src) && refs.length === 0 && /SAMPLE DRAWING/.test(src),
    'len ' + src.length + ' refs ' + refs.join(','));
  ok('media/' + f + ' is used by a seeded photo', files.has(f));
}

(async () => {
  const store = await import(pathToFileURL(path.join(SDK, '_store.js')).href);
  global.location = { origin: 'https://example.test' };
  try {
    const u = store.reviveSeed({ url: { __media: 'roof-front.svg' }, bad: { __media: '../../x.svg' } });
    ok('{"__media"} revives to an absolute same-origin /pro/demo-sdk/media/ URL', u.url === 'https://example.test/pro/demo-sdk/media/roof-front.svg', u.url);
    ok('a __media name that is not a plain file name revives to nothing', u.bad === '', u.bad);
  } finally { delete global.location; }

  // ── E. e-sign preview ─────────────────────────────────────────────────
  console.log('E. e-sign preview');
  const fnSrc = stripComments(read('docs/pro/demo-sdk/firebase-functions.js'));
  const spSrc = stripComments(read('docs/pro/demo-sdk/send-preview.js'));
  const body = /export function httpsCallable[\s\S]*?\n\}/.exec(fnSrc);
  const call = body ? body[0] : '';
  ok('httpsCallable shows the preview BEFORE it rejects', /await previewFor\(name, payload\)[\s\S]*throw e/.test(call), call.slice(0, 400));
  ok('…and still rejects every send-to-sign callable (never a fake success)', !/sendEstimateEnvelope|createSignRequest|createDealAcceptToken/.test(/const CANNED = \{[\s\S]*?\n\};/.exec(fnSrc)[0]));
  for (const n of ['sendEstimateEnvelope', 'createSignRequest', 'createDealAcceptToken']) {
    ok(n + ' has a preview builder', new RegExp('async ' + n + '\\(p\\)').test(spSrc));
  }
  ok('the preview frame is sandboxed with NO permissions (nothing on it can run, sign or submit)', /setAttribute\('sandbox', ''\)/.test(spSrc) && !/allow-/.test(spSrc));
  ok('the preview builds its DOM with textContent (no innerHTML of payload data)', !/innerHTML/.test(spSrc));
  ok('the preview fetches nothing (reads only the in-browser store)', !/fetch\(|XMLHttpRequest|sendBeacon|import\(/.test(spSrc));
  const fns = await import(pathToFileURL(path.join(SDK, 'firebase-functions.js')).href);
  ok('the would-message for the doc viewer\'s in-person signature is honest', /record the in-person signature/.test(fns.sampleCallableMessage('recordInPersonSignature')));
  ok('sendEstimateEnvelope still says it would email the estimate (wave 1 contract)', /In your real account this would email the estimate/.test(fns.sampleCallableMessage('sendEstimateEnvelope')));
  ok('getDocumentHtml is answered from the store (reopen a generated document)', /getDocumentHtml: async \(p\)/.test(fnSrc) && /htmlPath/.test(fnSrc));
  const css = read('docs/pro/css/demo-mode.css');
  ok('the strip drops below the estimate builder\'s Back/Next bar and the viewer\'s action row', /body:has\(#estV2Modal\.open\) \.nbd-demo-strip/.test(css) && /body:has\(#nbd-doc-viewer-overlay\.open\) \.nbd-demo-strip/.test(css) &&
    /#estV2Modal\.v3-on \.v3-bar \{ padding-bottom: calc\(56px/.test(css) && /\.nbdv-footer \{ padding-bottom: calc\(56px/.test(css));
  ok('demo-mode.js loads the new stylesheet version', /demo-mode\.css\?v=2'/.test(read('docs/pro/js/demo-mode.js')));

  // ── F. proposal photo grid ────────────────────────────────────────────
  console.log('F. proposal photo grid (document-generator.js renderPhotoGrid)');
  const win = { _brand: () => ({ legalName: 'X', colors: {}, contact: {} }) };
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
  const sb = { window: win, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() }, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON, Intl };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(JS, 'document-generator.js'), 'utf8'), sb, { filename: 'document-generator.js' });
  const grid = win.NBDDocGen.renderPhotoGrid([{ id: 'p1', url: 'https://example.test/a.jpg' }, 'https://example.test/b.jpg', { id: 'p3' }, 'https://example.test/c.jpg?x="><b>'], 2);
  ok('a photo record ({ url }) renders its URL, never "[object Object]"', /src="https:\/\/example\.test\/a\.jpg"/.test(grid) && !/object Object/.test(grid), grid.slice(0, 400));
  ok('a plain URL string still renders as before', /src="https:\/\/example\.test\/b\.jpg"/.test(grid));
  ok('a record with no URL gets the empty "Photo" placeholder, not a broken image', (grid.match(/<div class="photo-zone">Photo<\/div>/g) || []).length === 1, grid);
  ok('the URL is escaped inside the attribute', /c\.jpg\?x=&quot;&gt;&lt;b&gt;/.test(grid) && !/x="><b>/.test(grid), grid);
  ok('no photos still renders the two empty placeholders', (win.NBDDocGen.renderPhotoGrid([], 2).match(/photo-zone">Photo/g) || []).length === 2);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
