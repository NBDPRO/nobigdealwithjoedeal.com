/**
 * The homeowner estimate link wears the right company (2026-11-08, ED-F11 + VW-F102).
 *
 * A contractor who had not set a company name (or whose profile read failed)
 * texted a homeowner the estimate link, and the page said "NBD · No Big Deal /
 * Roofing & Restoration" with the tab "Your Estimate — No Big Deal Home
 * Solutions". getEstimateForView seeded NBD's name for every tenant and sent no
 * isNbd flag; estimate-view.js read a blank name as NBD.
 *
 * The rule (tenant-branding-by-company-2026-10-05, approved by Jo): NBD is
 * decided by the tenant key (lead companyId, else the token owner uid) ===
 * the NBD owner uid, never by a brand string. Another company with no name
 * gets '' + isNbd:false and a neutral page. NBD's own page stays byte-identical.
 *
 *   A. server: functions/portal.js getEstimateForView company block, lifted and run
 *   B. client: docs/pro/js/estimate-view.js, run for real with a fetch stub
 *
 * Run: node tests/estimate-view-tenant-identity-2026-11-08.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '\n       ' + String(detail).slice(0, 400) : '')); }
}

const NBD_UID = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const NBD_LEGAL = 'No Big Deal Home Solutions';
const NBD_MARKS = /No Big Deal|NBD|Roofing &amp; Restoration/;
const NBD_WORDMARK = '<div class="ev-brand"><span>NBD</span> · No Big Deal</div>';
const NBD_BADGE = '<div class="ev-badge">Roofing &amp; Restoration</div>';

// ── A. server ─────────────────────────────────────────────────────────
const portalSrc = read('functions/portal.js');
const fnAt = portalSrc.indexOf('exports.getEstimateForView');
const startMark = '// Full white-label (2026-07-19): the renderer hardcoded';
const start = portalSrc.indexOf(startMark, fnAt);
const end = portalSrc.indexOf('res.status(200).json({ estimate: safeEstimate, company })', start);
const slice = (fnAt >= 0 && start > fnAt && end > start) ? portalSrc.slice(start, end) : null;

async function resolveCompany({ tok, tokLead, profile }) {
  const db = {
    doc(p) {
      return {
        get: async () => {
          if (p === 'leads/' + tok.leadId) return { exists: !!tokLead, data: () => tokLead };
          if (p.startsWith('companyProfile/')) {
            if (profile === 'throw') throw new Error('read failed');
            return { exists: !!profile, data: () => profile };
          }
          return { exists: false, data: () => undefined };
        },
      };
    },
  };
  const sb = { db, tok, tokLead, PORTAL_NBD_OWNER_UID: NBD_UID, logger: { warn() {} }, String, RegExp };
  return vm.runInNewContext('(async () => {\n' + slice + '\nreturn company;\n})()', sb, { filename: 'portal-getEstimateForView-company.js' });
}

async function serverSection() {
  console.log('\nA. getEstimateForView company block (functions/portal.js)');
  ok('company block found in getEstimateForView', !!slice);
  if (!slice) return;
  const tok = { leadId: 'L1', ownerUid: 'rep-1' };
  const lead = { companyId: 'co-x' };
  const neutral = (c) => !!c && c.name === '' && c.isNbd === false && c.logoUrl === null && c.colors === null;

  let c = await resolveCompany({ tok, tokLead: lead, profile: null });
  ok('another company, no profile doc → { name: "", isNbd: false }', neutral(c), JSON.stringify(c));
  c = await resolveCompany({ tok, tokLead: lead, profile: { brand: { legalName: '' } } });
  ok('another company, blank legalName → { name: "", isNbd: false }', neutral(c), JSON.stringify(c));
  c = await resolveCompany({ tok, tokLead: lead, profile: 'throw' });
  ok('another company, profile read throws → { name: "", isNbd: false }', neutral(c), JSON.stringify(c));
  c = await resolveCompany({ tok, tokLead: {}, profile: null });
  ok('no companyId falls back to the token owner uid (non-NBD) → neutral', neutral(c), JSON.stringify(c));

  c = await resolveCompany({ tok, tokLead: { companyId: NBD_UID }, profile: null });
  ok('NBD tenant key, no profile → NBD name, isNbd true',
    !!c && c.name === NBD_LEGAL && c.isNbd === true && c.logoUrl === null && c.colors === null, JSON.stringify(c));
  c = await resolveCompany({ tok: { leadId: 'L1', ownerUid: NBD_UID }, tokLead: {}, profile: { brand: { legalName: NBD_LEGAL } } });
  ok('NBD owner uid, NBD legalName → NBD name, isNbd true', !!c && c.name === NBD_LEGAL && c.isNbd === true, JSON.stringify(c));
  c = await resolveCompany({ tok: { leadId: 'L1' }, tokLead: {}, profile: null });
  ok('key-less legacy token → NBD (esign-logic convention)', !!c && c.name === NBD_LEGAL && c.isNbd === true, JSON.stringify(c));

  c = await resolveCompany({ tok, tokLead: lead, profile: { brand: { legalName: 'Oaks Roofing', logoUrl: 'https://x/l.png', colors: { accent: '#123456' } } } });
  ok('named tenant → its name, https logo, hex accent, isNbd false',
    !!c && c.name === 'Oaks Roofing' && c.isNbd === false && c.logoUrl === 'https://x/l.png'
      && !!c.colors && c.colors.accent === '#123456' && c.colors.primary === null, JSON.stringify(c));
}

// ── B. client ─────────────────────────────────────────────────────────
async function renderView(company) {
  const root = { _h: '', set innerHTML(v) { this._h = String(v); }, get innerHTML() { return this._h; }, addEventListener() {}, querySelector() { return null; } };
  const sb = {
    document: { getElementById: (id) => (id === 'evRoot' ? root : null), title: 'Your Estimate', documentElement: { style: { setProperty() {} } }, body: null, referrer: '' },
    location: { hostname: 'example.test', search: '?token=abcdefghij1234&estimateId=est1', origin: 'https://example.test' },
    history: { length: 1, back() {} }, URLSearchParams, URL, JSON, Math, Number, String, Promise, setTimeout,
    console: { log() {}, warn() {}, error() {} },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ estimate: { number: 'E-1', grandTotal: 100 }, company }) }),
  };
  sb.window = sb;
  vm.runInNewContext(read('docs/pro/js/estimate-view.js'), sb, { filename: 'estimate-view.js' });
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  return { html: root.innerHTML, title: sb.document.title };
}

async function clientSection() {
  console.log('\nB. estimate-view.js (homeowner page)');
  let r = await renderView({ name: '', isNbd: false, logoUrl: null, colors: null });
  ok('nameless non-NBD company: no NBD name, wordmark or badge', !NBD_MARKS.test(r.html), r.html.slice(0, 300));
  ok('nameless non-NBD company: neutral tab title "Your Estimate"', r.title === 'Your Estimate', r.title);
  ok('nameless non-NBD company: no empty brand block', !/<div class="ev-brand"><\/div>/.test(r.html), r.html.slice(0, 300));
  ok('nameless non-NBD company: the estimate itself still renders',
    /<h1 class="ev-doc-title">Estimate<\/h1>/.test(r.html) && r.html.includes('E-1'), r.html.slice(0, 300));

  r = await renderView(null);
  ok('company null (older server) → NBD wordmark + badge byte-identical', r.html.includes(NBD_WORDMARK) && r.html.includes(NBD_BADGE));
  ok('company null → title names NBD as before', r.title === 'Your Estimate — ' + NBD_LEGAL, r.title);
  r = await renderView({ name: NBD_LEGAL, isNbd: true, logoUrl: null, colors: null });
  ok('NBD company → NBD wordmark + badge byte-identical', r.html.includes(NBD_WORDMARK) && r.html.includes(NBD_BADGE));
  ok('NBD company → title unchanged', r.title === 'Your Estimate — ' + NBD_LEGAL, r.title);
  r = await renderView({ name: '', logoUrl: null, colors: null });
  ok('blank name without an isNbd flag (older server) → NBD as before', r.html.includes(NBD_WORDMARK));

  r = await renderView({ name: 'Oaks Roofing', isNbd: false, logoUrl: null, colors: null });
  ok('named tenant → its name, no NBD marks',
    r.html.includes('<div class="ev-brand">Oaks Roofing</div>') && !NBD_MARKS.test(r.html), r.html.slice(0, 300));
  ok('named tenant → title names the tenant', r.title === 'Your Estimate — Oaks Roofing', r.title);
  r = await renderView({ name: 'Oaks', isNbd: false, logoUrl: 'https://x/l.png', colors: null });
  ok('named tenant with logo → logo image, no NBD marks',
    r.html.includes('<img class="ev-brand-logo" src="https://x/l.png"') && !NBD_MARKS.test(r.html));
}

(async () => {
  await serverSection();
  await clientSection();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
