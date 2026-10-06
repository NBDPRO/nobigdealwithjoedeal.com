/**
 * NBD branding decided by company, not by brand name (2026-10-05, approved by Jo).
 *
 * NBD is one tenant. Its identity — name, (859) 420-7382, the website, Joe,
 * its Google reviews, its alert inbox — may appear ONLY on NBD's own output,
 * and "is this NBD" is decided by the tenant key (companyId, else the owner
 * uid) === the NBD owner uid, never by a blank or matching brand name. Every
 * NBD output stays byte-identical; another company gets its own values or
 * neutral wording.
 *
 *   A. maps-routing.js drawing-tool documents (Scope of Work, Measurement
 *      Report, Material Takeoff, Supplement Request)
 *   B. lead-alert: a non-NBD company with no alert contacts is alerted NOWHERE
 *      (Jo's decision), and its CRM Settings shows "Set your lead alert contacts"
 *   C. lead-followup isNbdLead, social-studio googleReviews
 *   D. blank-name fallbacks: cancellation-notice seller (and the send is
 *      refused), e-sign copy, portal, share-ssr, report-sharing, the
 *      estimate supplement, the AI-texting persona
 *   E. public-lead-photos help lines name the tenant, never Joe
 *
 * Run: node tests/tenant-branding-by-company-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const fn = (rel) => path.join(ROOT, 'functions', rel);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const NBD_LEGAL = 'No Big Deal Home Solutions';
const NBD_MARKS = /No Big Deal|420-7382|nobigdealwithjoedeal|\bJoe\b/;

// ── Stubs: only the I/O modules lead-alert touches at call time ──────────
const rec = { emails: [], sms: [], outbox: [] };
const profiles = {};
const fakeDb = {
  collection: (name) => ({
    add: async (doc) => { if (name === 'alert_outbox') rec.outbox.push(doc); return { id: 'obx' }; },
    doc: (id) => ({
      get: async () => (name === 'companyProfile' && profiles[id]
        ? { exists: true, data: () => profiles[id] }
        : { exists: false, data: () => undefined }),
      update: async () => {},
      collection: () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) }),
    }),
  }),
};
const quiet = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
const stubs = {
  'firebase-functions/v2': { logger: quiet },
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'test-' + n }), defineString: (n) => ({ name: n, value: () => '' }) },
  resend: { Resend: class { constructor() { this.emails = { send: async (p) => { rec.emails.push(p); return { data: { id: 'em' }, error: null }; } }; } } },
  twilio: () => ({ messages: { create: async (p) => { rec.sms.push(p); return { sid: 'SM' }; } } }),
  'firebase-admin/firestore': {
    FieldValue: { serverTimestamp: () => '__ts__', increment: (n) => ({ __inc: n }) },
    Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
    getFirestore: () => fakeDb,
  },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};

(async () => {
  // ══════════════════════════════════════════════════════════════════
  console.log('\nA. maps-routing.js — the four drawing-tool documents');
  // ══════════════════════════════════════════════════════════════════
  const MR = read('docs/pro/js/maps-routing.js');
  {
    const esc = MR.match(/function _esc\(s\) \{[\s\S]*?\n\}/);
    const a = MR.indexOf('async function _mrDocBrand()');
    const b = MR.indexOf('function _mrFootShort(t)');
    const helpers = a > -1 && b > -1 ? MR.slice(a, MR.indexOf('\n', b)) : '';
    ok('the tenant-doc helpers exist', !!(esc && helpers));
    const run = async (win) => {
      const ctx = { window: win, String, Object };
      vm.createContext(ctx);
      vm.runInContext((esc ? esc[0] : '') + '\n' + helpers + '\nthis.H = { _mrDocBrand, _mrBrandHtml, _mrFootFull, _mrFootShort };', ctx);
      const t = await ctx.H._mrDocBrand();
      return { t, brand: ctx.H._mrBrandHtml(t), full: ctx.H._mrFootFull(t), short: ctx.H._mrFootShort(t) };
    };
    if (esc && helpers) {
      const nbd = await run({ NBDTenantRules: { isPlatformTenant: () => true }, _brand: () => ({ legalName: NBD_LEGAL }), _companyProfileLoaded: true });
      ok('NBD: header is the exact literal', nbd.brand === 'No Big Deal <span>Home Solutions</span>', nbd.brand);
      ok('NBD: Scope / Supplement footer is the exact literal', nbd.full === 'No Big Deal Home Solutions · (859) 420-7382 · nobigdealwithjoedeal.com', nbd.full);
      ok('NBD: Measurement / Takeoff footer is the exact literal', nbd.short === 'No Big Deal Home Solutions — nobigdealwithjoedeal.com', nbd.short);
      let loaded = false;
      const co = await run({
        NBDTenantRules: { isPlatformTenant: () => false },
        _companyProfileLoaded: false,
        _loadCompanyProfile: async () => { loaded = true; },
        _brand: () => ({ legalName: 'Oak & <Sons> Roofing', contact: { phone: '(513) 555-0199', website: 'oaksroof.test' } }),
      });
      ok('another company: hydration awaited before reading the brand', loaded);
      ok('another company: its own name (escaped) in the header', co.brand === 'Oak &amp; &lt;Sons&gt; Roofing', co.brand);
      ok('another company: its own phone + website in the footer', co.full === 'Oak &amp; &lt;Sons&gt; Roofing · (513) 555-0199 · oaksroof.test', co.full);
      const unset = await run({ NBDTenantRules: { isPlatformTenant: () => false }, _companyProfileLoaded: true, _brand: () => ({ legalName: NBD_LEGAL, contact: { phone: '(859) 420-7382', website: 'nobigdealwithjoedeal.com' } }) });
      ok('another company still showing NBD defaults (un-hydrated / unset): blank, never NBD',
        unset.brand === '' && unset.full === '' && unset.short === '', [unset.brand, unset.full, unset.short]);
      const brandNbdKeyNot = await run({ NBDTenantRules: { isPlatformTenant: () => false }, _companyProfileLoaded: true, _brand: () => ({ legalName: '' }) });
      ok('decided by company key: a blank brand name on a non-NBD company is NOT NBD', !NBD_MARKS.test(brandNbdKeyNot.brand + brandNbdKeyNot.full));
    }
    const code = stripComments(MR);
    const docs = [
      ['generateScopeFromDrawing', 'Scope of Work'], ['exportDrawReport', 'Drawing Measurement Report'],
      ['showMaterialTakeoff', 'Material Takeoff'], ['generateSupplementFromComparison', 'Supplement Request'],
    ];
    for (const [name, badge] of docs) {
      const at = code.indexOf('async function ' + name + '(');
      const body = at > -1 ? code.slice(at, code.indexOf('\nasync function ', at + 10) > -1 ? code.indexOf('\nasync function ', at + 10) : at + 9000) : '';
      const awaitAt = body.indexOf('await _mrDocBrand()');
      const htmlAt = body.indexOf('<!DOCTYPE html>');
      ok(name + ': resolves the tenant BEFORE building the HTML', awaitAt > -1 && htmlAt > awaitAt);
      ok(name + ': "' + badge + '" header uses the tenant helper', body.indexOf('<div class="brand">${_mrBrandHtml(_t)}</div><div class="badge">' + badge) > -1);
    }
    const outsideHelpers = code.slice(0, code.indexOf('async function _mrDocBrand')) + code.slice(code.indexOf('\n', code.indexOf('function _mrFootShort(t)')));
    const leftovers = (outsideHelpers.match(/No Big Deal <span>|\(859\) 420-7382 · nobigdeal|No Big Deal Home Solutions — nobigdeal/g) || []);
    ok('no hard-coded NBD header/footer left in the documents', leftovers.length === 0, leftovers);
    ok('the Scope terms name NBD only on NBD', /All work performed\$\{_t\.isNbd \? ' by No Big Deal Home Solutions' : \(_t\.name \? ' by ' \+ _t\.name : ''\)\} includes/.test(code));
    ok('maps-routing.js cache-bust bumped in ScriptLoader', /'js\/maps-routing\.js\?v=10'/.test(read('docs/pro/js/script-loader.js')));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nB. lead alerts — a company with no alert contacts is alerted nowhere');
  // ══════════════════════════════════════════════════════════════════
  {
    process.env.NBD_OWNER_UID = NBD;
    delete require.cache[require.resolve(fn('lead-alert.js'))];
    const LA = require(fn('lead-alert.js'));
    const handler = LA.leadAlertContact && (LA.leadAlertContact.run || LA.leadAlertContact.__handler || LA.leadAlertContact);
    const fire = async (doc) => {
      rec.emails = []; rec.sms = []; rec.outbox = [];
      const run = (LA.leadAlertContact && typeof LA.leadAlertContact.run === 'function') ? LA.leadAlertContact.run.bind(LA.leadAlertContact) : handler;
      await run({ data: { data: () => doc }, params: { leadId: 'L1' } });
    };
    const lead = (extra) => Object.assign({ firstName: 'Pat', lastName: 'Example', email: 'pat@example.com', phone: '5135550100', message: 'leak' }, extra);
    await fire(lead({ companyId: 'co-unset' }));
    ok('non-NBD company with no alert contacts: no email to anyone', rec.emails.length === 0, rec.emails.map((m) => m.to));
    ok('…no SMS to anyone (never Joe\'s cell)', rec.sms.length === 0, rec.sms.map((m) => m.to));
    ok('…and the outbox records no target', rec.outbox.length === 1 && rec.outbox[0].target.emails === null && rec.outbox[0].target.sms === null, rec.outbox[0] && rec.outbox[0].target);
    profiles['co-set'] = { brand: { legalName: 'Oaks Roofing', contact: { alertEmail: 'scott@oaks.test' } } };
    await fire(lead({ companyId: 'co-set' }));
    ok('configured company: alert goes to its own inbox', rec.emails.length === 1 && JSON.stringify(rec.emails[0].to) === JSON.stringify(['scott@oaks.test']), rec.emails.map((m) => m.to));
    await fire(lead({ companyId: NBD }));
    const toJoe = rec.emails.filter((m) => /jd@nobigdealwithjoedeal\.com/.test(JSON.stringify(m.to)));
    ok('NBD lead: still alerts Joe (unchanged)', toJoe.length === 1, rec.emails.map((m) => m.to));
    await fire(lead({}));
    ok('untagged public lead (no companyId) = NBD: alerts Joe (unchanged)', rec.emails.some((m) => /jd@nobigdealwithjoedeal\.com/.test(JSON.stringify(m.to))));

    const html = stripHtmlComments(read('docs/pro/dashboard.html'));
    ok('Settings → Brand Identity carries the "Set your lead alert contacts" warning (hidden by default)',
      /<div id="cp_alertWarn" role="status" hidden[^>]*><strong>Set your lead alert contacts\.<\/strong>/.test(html));
    const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
    const fnAt = boot.indexOf('function _cpAlertContactsWarning(rawContact)');
    ok('the warning is driven from the populated profile', /_cpAlertContactsWarning\(rawContact\);/.test(boot) && fnAt > -1);
    if (fnAt > -1) {
      const src = boot.slice(fnAt, boot.indexOf('\n  }\n', fnAt) + 4).replace(/\r/g, '');
      const show = (isNbd, contact) => {
        const el = { hidden: true };
        const ctx = { window: { NBDTenantRules: { isPlatformTenant: () => isNbd } }, document: { getElementById: () => el } };
        vm.createContext(ctx);
        vm.runInContext(src + '\n_cpAlertContactsWarning(' + JSON.stringify(contact) + ');', ctx);
        return !el.hidden;
      };
      ok('shown for a non-NBD company with no alert contact', show(false, {}) === true);
      ok('hidden once the company has an alert email', show(false, { alertEmail: 'a@b.test' }) === false);
      ok('never shown to NBD (decided by company key)', show(true, {}) === false);
    }
    ok('dashboard-bootstrap cache-bust bumped', +((read('docs/pro/dashboard.html').match(/dashboard-bootstrap\.module\.js\?v=(\d+)/) || [])[1] || 0) >= 36);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nC. follow-up sweep + social plan decide NBD by company');
  // ══════════════════════════════════════════════════════════════════
  {
    const lf = stripComments(read('functions/lead-followup.js'));
    ok('isNbdLead = no companyId, or the NBD owner uid', /async function isNbdLead\(companyId\) \{\s*return !companyId \|\| String\(companyId\) === NBD_OWNER_UID;\s*\}/.test(lf));
    ok('…no longer treats a company without alert contacts as NBD', !/alertEmail|alertSms/.test(lf.slice(lf.indexOf('async function isNbdLead'), lf.indexOf('async function isNbdLead') + 400)));
    const ss = stripComments(read('functions/social-studio.js'));
    const gate = ss.indexOf("if (String(ctx.companyId) === NBD_OWNER_UID) {");
    const readAt = ss.indexOf("db.doc('siteContent/googleReviews')");
    ok('socialPlanWeeks reads NBD\'s Google reviews only for NBD', gate > -1 && readAt > gate && readAt - gate < 200);
    ok('…and that is the only read of them', ss.split("siteContent/googleReviews").length === 2);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nD. blank-name fallbacks');
  // ══════════════════════════════════════════════════════════════════
  {
    const CW = require(fn('cancel-window.js'));
    const nbdOpts = CW.packetOptsFrom({ companyId: NBD, firstName: 'Pat' }, {});
    const coOpts = CW.packetOptsFrom({ companyId: 'co-x', firstName: 'Pat' }, {});
    const legacy = CW.packetOptsFrom({ firstName: 'Pat' }, {});
    ok('Notice of Cancellation seller: NBD\'s own lead keeps NBD', nbdOpts.sellerName === NBD_LEGAL);
    ok('…a key-less legacy lead is NBD\'s', legacy.sellerName === NBD_LEGAL);
    ok('…another company with no legal name gets a blank seller (never NBD)', coOpts.sellerName === '', coOpts.sellerName);
    ok('…its own legal name when set', CW.packetOptsFrom({ companyId: 'co-x' }, { brand: { legalName: 'Oaks Roofing' } }).sellerName === 'Oaks Roofing');
    ok('a clear "add your legal business name" message is exported', typeof CW.SELLER_NAME_REQUIRED_MSG === 'string' && /legal business name/i.test(CW.SELLER_NAME_REQUIRED_MSG));
    const env = stripComments(read('functions/esign-envelope.js'));
    const sendAt = env.indexOf('exports.sendEsignEnvelope');
    const sendBody = env.slice(sendAt, env.indexOf('exports.sendEstimateEnvelope'));
    const chk = sendBody.indexOf('CW.envelopeNeedsCancelNotice(env)');
    const thr = sendBody.indexOf("throw new HttpsError('failed-precondition', CW.SELLER_NAME_REQUIRED_MSG)");
    const disp = sendBody.indexOf('dispatchToSigner(');
    ok('sendEsignEnvelope refuses a contract with a blank seller BEFORE anything is sent', chk > -1 && thr > chk && (disp === -1 || disp > thr), [chk, thr, disp]);
    const estBody = env.slice(env.indexOf('exports.sendEstimateEnvelope'), env.indexOf('exports.voidEsignEnvelope'));
    const sAt = estBody.indexOf("const sellerName = ESL.senderName(companyName, lead.companyId || lead.userId);");
    const tAt = estBody.indexOf("if (!sellerName) throw new HttpsError('failed-precondition', CW.SELLER_NAME_REQUIRED_MSG);");
    const pAt = estBody.indexOf('buildEstimateContractPdf(');
    ok('sendEstimateEnvelope refuses a blank seller before building the contract PDF', sAt > -1 && tAt > sAt && pAt > tAt);
    ok('…and the contract names that seller, never an NBD literal', /companyName: sellerName,/.test(estBody) && !/companyName \|\| 'No Big Deal Home Solutions'/.test(estBody));

    const ESL = require(fn('esign-logic.js'));
    ok('senderName: NBD keeps its name; a key-less record is NBD; another company gets \'\'',
      ESL.senderName('', NBD) === NBD_LEGAL && ESL.senderName('', '') === NBD_LEGAL && ESL.senderName('', 'co-x') === '' && ESL.senderName('Oaks', 'co-x') === 'Oaks');
    const nbdLink = ESL.linkEmail({ brand: '', tenantKey: NBD, name: 'Pat', title: 'Contract', link: 'https://x/s/T' });
    ok('NBD signing email: unchanged wording', /No Big Deal Home Solutions has <strong>Contract<\/strong> ready for your signature\./.test(nbdLink.html));
    const coLink = ESL.linkEmail({ brand: '', tenantKey: 'co-x', name: 'Pat', title: 'Contract', link: 'https://x/s/T' });
    const coRem = ESL.linkEmail({ brand: '', tenantKey: 'co-x', name: 'Pat', title: 'Contract', link: 'https://x/s/T', reminder: true });
    const coCopy = ESL.signedCopyEmail({ brand: '', tenantKey: 'co-x', name: 'Pat', title: 'Contract' });
    ok('another company, no name: signing email + reminder + signed copy are neutral',
      !NBD_MARKS.test(coLink.html + coRem.html + coCopy.html) && /<strong>Contract<\/strong> is ready for your signature/.test(coLink.html) && /<strong>Contract<\/strong> is fully signed/.test(coCopy.html));
    const certNbd = ESL.certificateLines({ companyName: '', companyId: NBD, signers: [] }, {});
    const certCo = ESL.certificateLines({ companyName: '', companyId: 'co-x', signers: [] }, {});
    ok('certificate "Sent by": NBD unchanged, another company "-"',
      certNbd.some((l) => l.t === 'Sent by: ' + NBD_LEGAL) && certCo.some((l) => l.t === 'Sent by: -'));
    ok('e-sign callers pass the tenant key',
      /tenantKey: env\.companyId \|\| env\.ownerUid/.test(read('functions/esign-io.js')) && /signedCopyEmail\(\{ brand: env\.companyName, tenantKey: env\.companyId \|\| env\.ownerUid/.test(env));

    // portal (server + client)
    const portal = stripComments(read('functions/portal.js'));
    ok('portal view: NBD name only when the tenant key is NBD\'s, + isNbd flag',
      /const _portalIsNbd = !tenantKey \|\| String\(tenantKey\) === PORTAL_NBD_OWNER_UID;/.test(portal)
      && /name: tenantName \|\| rep\.companyName \|\| rep\.company \|\| \(_portalIsNbd \? 'No Big Deal Home Solutions' : ''\),\s*isNbd: _portalIsNbd,/.test(portal));
    const pc = read('docs/pro/js/portal.js');
    ok('portal client: a blank name flagged isNbd:false stays neutral (not read as NBD)',
      /const _coNotNbd = !_coNamed && !!view\.company && view\.company\.isNbd === false;/.test(pc)
      && /const isNbdCompany = _coNotNbd \? false : \(!_coNamed \|\| view\.company\.name === 'No Big Deal Home Solutions'\);/.test(pc));
    ok('portal.js cache-bust bumped', /js\/portal\.js\?v=9/.test(read('docs/pro/portal.html')));

    // share-ssr: run the real renderPage/projectPage
    const ssr = read('functions/share-ssr.js');
    const seg = ssr.slice(ssr.indexOf('function escHtml'), ssr.indexOf('exports.shareSSR'));
    const sctx = {}; vm.createContext(sctx);
    vm.runInContext(seg + '\nthis.projectPage = projectPage;', sctx);
    const lead = { firstName: 'Pat' };
    const pNbd = sctx.projectPage({ lead, rep: { displayName: 'Joe' }, token: 'T', tenantName: '', isNbd: true }).html;
    const pCo = sctx.projectPage({ lead, rep: { displayName: 'Sam' }, token: 'T', tenantName: '', isNbd: false }).html;
    const pOwn = sctx.projectPage({ lead, rep: { displayName: 'Sam' }, token: 'T', tenantName: 'Oaks Roofing', isNbd: false }).html;
    ok('share card: NBD keeps its name in title, og:site_name and footer',
      /<meta property="og:site_name" content="No Big Deal Home Solutions">/.test(pNbd) && /Powered by No Big Deal Home Solutions/.test(pNbd) && /Your roofing project — No Big Deal Home Solutions/.test(pNbd));
    ok('share card: another company with no name has no NBD identity anywhere', !/No Big Deal|nobigdeal|420-7382/.test(pCo), pCo.slice(0, 300));
    ok('share card: …and no empty site name / "Powered by"', !/og:site_name/.test(pCo) && !/Powered by/.test(pCo));
    ok('share card: a named company shows its own name', /Powered by Oaks Roofing/.test(pOwn) && !/No Big Deal/.test(pOwn));
    ok('share-ssr passes isNbd from the tenant key', /isNbd: !tenantKey \|\| String\(tenantKey\) === SSR_NBD_OWNER_UID/.test(ssr));

    // report-sharing subject
    const rs = stripComments(read('functions/report-sharing.js'));
    ok('report share email: NBD\'s name only on NBD\'s report, else "is ready"',
      /subject: \(tenantName \|\| String\(subject\.companyId \|\| ''\) === REPORT_NBD_OWNER_UID\)\s*\? `Your \$\{subject\.subjectNoun\} from \$\{tenantName \|\| 'No Big Deal Home Solutions'\}`\s*: `Your \$\{subject\.subjectNoun\} is ready`,/.test(rs));

    // estimate supplement (client)
    const sup = read('docs/pro/js/estimate-supplement.js');
    ok('supplement: NBD decided by company key (tenant-rules), with blank fallbacks for others',
      /_TR\.isPlatformTenant\(\)/.test(sup) && /legalName: _rawBrand\.legalName \|\| \(isNbd \? 'No Big Deal Home Solutions' : ''\)/.test(sup)
      && /\(isNbd \? 'NBD' : ''\)/.test(sup) && /estimate-supplement\.js\?v=3/.test(read('docs/pro/customer.html')));

    // AI texting persona: run resolvePersona against a fake db
    const AIT = require(fn('handlers/ai-texting.js'));
    const pdb = (brand) => ({
      collection: (n) => ({ doc: () => ({
        get: async () => (n === 'companyProfile' ? { exists: true, data: () => ({ brand }) } : { exists: false, data: () => undefined }),
        collection: () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) }),
      }) }),
    });
    const pNbdP = await AIT.resolvePersona(pdb({ legalName: NBD_LEGAL }), NBD, NBD, '');
    ok('AI persona: NBD with no persona → null (the locked Joe prompt, unchanged)', pNbdP === null);
    const pBlank = await AIT.resolvePersona(pdb({}), 'u-x', 'co-x', '');
    ok('AI persona: another company with NO legal name is not NBD — neutral identity, never Joe/NBD',
      !!pBlank && pBlank.companyName && pBlank.identityName && !NBD_MARKS.test(pBlank.companyName + ' ' + pBlank.identityName), pBlank);
    const { buildPersonaPrompt } = require(fn('handlers/ai-persona.js'));
    ok('…and its built prompt never names Joe or NBD', !!pBlank && !/Joe|No Big Deal/.test(buildPersonaPrompt(pBlank)));
    const pDefaults = await AIT.resolvePersona(pdb({ legalName: NBD_LEGAL }), 'u-x', 'co-x', '');
    ok('AI persona: another company still on NBD defaults is not NBD either', !!pDefaults && !/No Big Deal/.test(pDefaults.companyName || ''), pDefaults);
    const pOwn2 = await AIT.resolvePersona(pdb({ legalName: 'Oaks Roofing' }), 'u-x', 'co-x', 'Sam');
    ok('AI persona: a named company keeps its own name + rep', !!pOwn2 && pOwn2.companyName === 'Oaks Roofing' && pOwn2.identityName === 'Sam', pOwn2);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nE. public-lead-photos — help lines name the tenant, never Joe');
  // ══════════════════════════════════════════════════════════════════
  {
    const PLP = require(fn('public-lead-photos.js'))._internal;
    ok('helpLine is exported', !!(PLP && PLP.helpLine && PLP.grantContact));
    if (PLP && PLP.helpLine) {
      const kinds = ['uploadClosed', 'attachFailed', 'saveFailed', 'intakeClosed', 'intakeFailed'];
      const want = {
        uploadClosed: 'This upload window has closed. Text your photos to (859) 420-7382 instead.',
        attachFailed: 'We could not attach this photo. Text it to (859) 420-7382.',
        saveFailed: 'The photo did not save. Try again, or text it to (859) 420-7382.',
        intakeClosed: 'This window has closed. Call or text Joe at (859) 420-7382 with anything else.',
        intakeFailed: 'Could not save that. Call or text Joe at (859) 420-7382.',
      };
      ok('NBD keeps every message byte-identical', kinds.every((k) => PLP.helpLine(k, null) === want[k]), kinds.map((k) => PLP.helpLine(k, null)));
      const own = { name: 'Oaks Roofing', phone: '(513) 555-0199' };
      ok('another company: its own phone (and name), never Joe\'s', kinds.every((k) => !NBD_MARKS.test(PLP.helpLine(k, own))) && /\(513\) 555-0199/.test(PLP.helpLine('uploadClosed', own)) && /Oaks Roofing at \(513\) 555-0199/.test(PLP.helpLine('intakeClosed', own)));
      ok('another company with no phone or name: neutral', kinds.every((k) => !NBD_MARKS.test(PLP.helpLine(k, { name: '', phone: '' })) && PLP.helpLine(k, { name: '', phone: '' })));
      const now = Date.now();
      const g = { exp: now - 1, used: 0, max: 10, collection: 'contact_leads', publicId: 'p1' };
      ok('checkGrant: expired NBD grant keeps the exact text', PLP.checkGrant(g, now).error === want.uploadClosed);
      ok('checkGrant: expired company grant names that company\'s phone', PLP.checkGrant(g, now, own).error === 'This upload window has closed. Text your photos to (513) 555-0199 instead.');
      profiles['co-p'] = { brand: { legalName: 'Oaks Roofing', contact: { phone: '(513) 555-0199' } } };
      ok('grantContact: NBD / untagged → null (NBD wording)', (await PLP.grantContact(fakeDb, NBD)) === null && (await PLP.grantContact(fakeDb, null)) === null);
      const gc = await PLP.grantContact(fakeDb, 'co-p');
      ok('grantContact: a company → its own name + phone', gc && gc.name === 'Oaks Roofing' && gc.phone === '(513) 555-0199', gc);
      const gcNone = await PLP.grantContact(fakeDb, 'co-none');
      ok('grantContact: an unknown company → blank, never null (null would mean NBD)', gcNone && gcNone.name === '' && gcNone.phone === '', gcNone);
    }
    const src = stripComments(read('functions/public-lead-photos.js'));
    const helpAt = src.indexOf('function helpLine');
    const outside = src.slice(0, helpAt) + src.slice(src.indexOf('\n}\n', helpAt));
    ok('no "(859) 420-7382" left outside helpLine', !/420-7382/.test(outside));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  Module._load = realLoad;
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
