/**
 * tests/guide-email-copy-2026-11-26.test.js — "Email me a copy" on the
 * homeowner guides (2026-11-26).
 *
 *   SLUGS    guide-copy-logic GUIDES == the inject script's list == the guide
 *            pages that carry a PDF slot, and every PDF is on disk.
 *   EMAIL    the real guideCopyEmail handler (firebase stubbed at the module
 *            loader): sends once, to the typed address only, with that guide's
 *            PDF attached by URL; echoes nothing typed; skips an unknown guide,
 *            a bad address, an intake-suppressed doc, a paused channel, an
 *            already-claimed doc; releases the claim on a canary.
 *   GATEWAY  kind guide_copy: email + guide + source required, email shape and
 *            slug checked, consent stamped with its version; never alert-eligible.
 *   BRIDGE   a cold CRM lead "Website — Guide copy" with the guide named.
 *   PAGES    one hidden box per PDF guide, after GUIDE-BODY:END, scripts loaded,
 *            checkbox wording unchanged unless the consent version changes;
 *            how-a-roof-works has none; the inject script is idempotent.
 *
 * Zero deps. Run: node tests/guide-email-copy-2026-11-26.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const F = (rel) => path.join(ROOT, 'functions', rel);

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

const G = require(F('guide-copy-logic.js'));

console.log('\nSLUGS');
const scriptSrc = read('scripts/add-guide-email-copy.js');
const scriptSlugs = (scriptSrc.match(/const SLUGS = \[([\s\S]*?)\];/) || [, ''])[1].match(/'([a-z0-9-]+)'/g).map((s) => s.slice(1, -1));
const pagesWithPdf = fs.readdirSync(path.join(ROOT, 'docs/guides')).filter((f) => f.endsWith('.html'))
  .filter((f) => /data-pdf-href="\/guides\/pdf\//.test(read('docs/guides/' + f))).map((f) => f.replace(/\.html$/, '')).sort();
ok('control: six homeowner guides have a PDF slot', pagesWithPdf.length === 6, pagesWithPdf);
ok('GUIDES == inject script list == pages with a PDF slot',
  JSON.stringify(G.GUIDE_SLUGS.slice().sort()) === JSON.stringify(pagesWithPdf) && JSON.stringify(scriptSlugs.slice().sort()) === JSON.stringify(pagesWithPdf),
  { logic: G.GUIDE_SLUGS, script: scriptSlugs });
ok('every guide PDF exists under docs/guides/pdf', G.GUIDE_SLUGS.every((s) => fs.existsSync(path.join(ROOT, 'docs/guides/pdf', s + '.pdf'))));
ok('the Pro playbook is not offered here', !G.isGuideSlug('nbd-pro-playbook') && !G.isGuideSlug('how-a-roof-works'));
ok('isGuideSlug refuses prototype keys and junk', !G.isGuideSlug('constructor') && !G.isGuideSlug('__proto__') && !G.isGuideSlug('../x') && !G.isGuideSlug(null));
ok('isValidEmail: shape + length', G.isValidEmail('a@b.co') && !G.isValidEmail('a@b') && !G.isValidEmail('a b@c.d') && !G.isValidEmail('x'.repeat(195) + '@b.com'));

console.log('\nEMAIL (the real handler, firebase stubbed)');
const realLoad = Module._load;
let stubs = null;
Module._load = function (request) {
  if (stubs && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};
function loadEmail(opts) {
  const o = opts || {};
  const sent = [];
  const updates = [];
  const capped = [];
  const DELETE = { __delete: true };
  const ts = { __ts: true };
  stubs = {
    'firebase-functions/v2/firestore': { onDocumentCreated: (cfg, h) => ({ cfg, h }) },
    'firebase-functions/params': { defineSecret: (n) => ({ value: () => 'stub-' + n }) },
    'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
    'firebase-admin/firestore': {
      FieldValue: { serverTimestamp: () => ts, delete: () => DELETE },
      getFirestore: () => ({
        runTransaction: async (fn) => fn({
          get: async (ref) => ({ exists: true, get: (k) => ref.__data[k] }),
          update: (ref, v) => { Object.assign(ref.__data, v); },
        }),
      }),
    },
    resend: { Resend: function () { this.emails = { send: async (m) => { sent.push(m); return { data: { id: 'em_1' } }; } }; } },
    './integrations/_shared': { secretOr: (s, d) => d },
    './resend-guard': { resendRejected: () => false, resendErrorMessage: () => '' },
    './messaging-controls': {
      channelStatus: async () => ({ allowed: o.paused !== true, canary: o.canary === 'pre', reason: o.paused ? 'paused' : null }),
      guardEmail: async (db, msg) => o.canary === 'post' ? { send: true, canary: true, msg } : { send: true, canary: false, msg },
    },
    './alert-recipients': { capRecipients: async (k, list) => { capped.push(k); return { allowed: o.capFull ? [] : list }; } },
    './email-suppression': { tenantPostalAddress: async () => '123 Main St, Goshen OH 45122' },
  };
  delete require.cache[F('guide-copy-email.js')];
  const mod = require(F('guide-copy-email.js'));
  stubs = null;
  async function run(data) {
    const ref = { __data: Object.assign({}, data), update: async (v) => { updates.push(v); Object.assign(ref.__data, v); } };
    await mod.guideCopyEmail.h({ data: { data: () => data, ref }, params: { reqId: 'r1' } });
    return ref.__data;
  }
  return { mod, run, sent, updates, capped, DELETE };
}

(async () => {
  {
    const t = loadEmail();
    ok('trigger is on guide_copy_requests/{reqId}', t.mod.guideCopyEmail.cfg.document === 'guide_copy_requests/{reqId}');
    const doc = await t.run({ email: 'home@owner.com', guide: 'hail-photo-baseline-sheet', source: '/guides/hail-photo-baseline-sheet', utm_source: '<a href=x>evil</a>' });
    const m = t.sent[0] || {};
    ok('sends exactly one email, to the address on the doc', t.sent.length === 1 && m.to === 'home@owner.com');
    ok('attaches that guide\'s PDF by its published URL',
      Array.isArray(m.attachments) && m.attachments.length === 1 &&
      m.attachments[0].path === 'https://nobigdealwithjoedeal.com/guides/pdf/hail-photo-baseline-sheet.pdf' &&
      /\.pdf$/.test(m.attachments[0].filename), m.attachments);
    ok('subject + body name the guide from the table, link back to it, print the postal address',
      /Pre-Storm Photo Baseline/.test(m.subject) && /\/guides\/hail-photo-baseline-sheet"/.test(m.html) && /Goshen OH 45122/.test(m.html));
    ok('nothing typed is echoed (no utm, no address text)', !/evil|home@owner/.test(m.html));
    ok('claimed (guideEmailedAt) and the send id stored', !!doc.guideEmailedAt && doc.guideEmailId === 'em_1');
    ok('per-inbox cap is spent under its own key', t.capped.join() === 'guideCopy');
    ok('reply-to is Joe', m.reply_to === 'jd@nobigdealwithjoedeal.com');
  }
  {
    const t = loadEmail();
    await t.run({ email: 'a@b.com', guide: 'nbd-pro-playbook', source: 'x' });
    await t.run({ email: 'not-an-email', guide: 'hail-photo-baseline-sheet', source: 'x' });
    await t.run({ email: 'a@b.com', guide: 'hail-photo-baseline-sheet', source: 'x', alertSuppressed: 'volume' });
    await t.run({ email: 'a@b.com', guide: 'hail-photo-baseline-sheet', source: 'x', guideEmailedAt: 'earlier' });
    ok('unknown guide, bad email, intake-suppressed and already-claimed docs send nothing', t.sent.length === 0);
  }
  {
    const t = loadEmail({ paused: true });
    const doc = await t.run({ email: 'a@b.com', guide: 'roof-financing-explained', source: 'x' });
    ok('paused channel: nothing sent, not claimed, marked held', t.sent.length === 0 && !doc.guideEmailedAt && doc.guideEmailHeld === 'messaging_paused');
  }
  {
    const t = loadEmail({ canary: 'post' });
    await t.run({ email: 'a@b.com', guide: 'roof-financing-explained', source: 'x' });
    ok('canary after the claim: nothing sent, claim released', t.sent.length === 0 && t.updates.some((u) => u.guideEmailedAt === t.DELETE));
  }
  {
    const t = loadEmail({ capFull: true });
    const doc = await t.run({ email: 'a@b.com', guide: 'roof-financing-explained', source: 'x' });
    ok('inbox at its daily cap: nothing sent, marked', t.sent.length === 0 && doc.guideEmailHeld === 'recipient_cap');
  }
  {
    const html = G.emailHtml({ slug: 'siding-gutter-buyers-guide', postalAddress: '<b>x</b>' });
    ok('titles and the postal address are escaped', /Siding &amp; Gutter Buyer's Guide/.test(html) && /&lt;b&gt;x&lt;\/b&gt;/.test(html) && !/<b>x<\/b>/.test(html));
  }

  console.log('\nGATEWAY + GUARD + RULES');
  const integ = read('functions/handlers/integrations.js');
  const kindBlock = (integ.match(/guide_copy: \{[\s\S]*?\n  \},/) || [''])[0];
  ok('kind guide_copy → guide_copy_requests, email/guide/source required, emailConsent boolean',
    /collection: 'guide_copy_requests'/.test(kindBlock) && /required: \['email', 'guide', 'source'\]/.test(kindBlock) && /boolOptional: \['emailConsent'\]/.test(kindBlock), kindBlock.slice(0, 200));
  ok('the gateway refuses a bad email and an unknown guide for this kind',
    /kind === 'guide_copy'\) \{[\s\S]{0,300}isValidEmail\(data\.email\)[\s\S]{0,300}isGuideSlug\(data\.guide\)/.test(integ));
  ok('consent is stamped server-side with the storm-tips version',
    /kind === 'guide_copy' && data\.emailConsent === true\) \{[\s\S]{0,120}emailConsentAt = FieldValue\.serverTimestamp\(\)[\s\S]{0,160}STORM_TIPS_CONSENT_VERSION/.test(integ));
  const PLG = require(F('public-lead-guard.js'));
  ok('a guide copy is never alert-eligible (spends no alert budget); a contact lead still is',
    PLG.isAlertEligible('guide_copy_requests', { email: 'a@b.com' }) === false && PLG.isAlertEligible('contact_leads', {}) === true);
  const rules = read('firestore.rules');
  ok('rules: clients can never write guide_copy_requests', /match \/guide_copy_requests\/\{reqId\} \{\s*allow create, update, delete: if false;\s*allow read: if isAdmin\(\);/.test(rules));
  ok('the sender is classified transactional in SEND_PATHS', /'guide-copy-email\.js': 'transactional'/.test(read('functions/email-suppression.js')));
  ok('exported from index.js', /exports\.guideCopyEmail = require\('\.\/guide-copy-email'\)\.guideCopyEmail/.test(read('functions/index.js')));

  console.log('\nBRIDGE');
  const L = require(F('lead-bridge-logic.js'));
  const lead = L.mapPublicLeadToLead({ collection: 'guide_copy_requests', data: { email: 'a@b.com', guide: 'kentucky-ohio-storm-claim-guide', source: '/guides/kentucky-ohio-storm-claim-guide', emailConsent: true }, sourceId: 'r9', ownerUid: 'u', companyId: 'c' });
  ok('cold CRM lead: source "Website — Guide copy", email carried, no phone',
    lead.source === 'Website — Guide copy' && lead.email === 'a@b.com' && lead.phone === '' && lead.publicLeadKind === 'guide_copy');
  ok('the card names the guide and the storm-tips answer', /Storm Claim Guide \(KY & OH\)/.test(lead.notes) && /Storm tips email OK: yes/.test(lead.notes), lead.notes);
  ok('a leadBridgeGuideCopy trigger exists on the collection', /exports\.leadBridgeGuideCopy = onDocumentCreated\(\{ \.\.\.TRIGGER_OPTS, document: 'guide_copy_requests\/\{leadId\}' \}, onLeadCreated\('guide_copy_requests'\)\)/.test(read('functions/lead-bridge.js')));

  console.log('\nPAGES');
  const consentText = (scriptSrc.match(/const CONSENT_TEXT = '([^']+)'/) || [, ''])[1];
  ok('checkbox wording is the one versioned guide-storm-tips-2026-11-26 (change both together)',
    G.STORM_TIPS_CONSENT_VERSION === 'guide-storm-tips-2026-11-26' && consentText === 'Also email me storm-season tips from Joe now and then. Unsubscribe any time.');
  const count = (s, n) => s.split(n).length - 1;
  for (const slug of pagesWithPdf) {
    const s = read('docs/guides/' + slug + '.html');
    const box = s.indexOf('data-guide-copy="' + slug + '"');
    const end = s.indexOf('<!-- GUIDE-BODY:END ' + slug + ' -->');
    const tag = (s.match(/<section [^>]*data-guide-copy="[^"]*"[^>]*>/) || [''])[0];
    ok(slug + ': one hidden box after the generated body, consent text, scripts loaded',
      count(s, 'data-guide-copy=') === 1 && end !== -1 && box > end && / hidden>$/.test(tag) &&
      s.includes(consentText) && s.includes('/assets/js/public-lead-submit.js') && s.includes('/assets/js/guide-email-copy.js'),
      { box, end, tag });
  }
  ok('how-a-roof-works (no PDF) has no box', !read('docs/guides/how-a-roof-works.html').includes('data-guide-copy'));
  const js = read('docs/assets/js/guide-email-copy.js');
  ok('client posts kind guide_copy with the page slug as guide and /guides/<slug> as source',
    /submitPublicLead\('guide_copy'/.test(js) && /guide: slug, source: '\/guides\/' \+ slug/.test(js));
  ok('client shows success only after res.ok', /if \(!res \|\| !res\.ok\) \{[\s\S]*?return;\s*\}\s*form\.reset\(\);/.test(js));

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-gcopy-'));
    try {
      fs.mkdirSync(path.join(tmp, 'scripts')); fs.mkdirSync(path.join(tmp, 'docs', 'guides'), { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'scripts/add-guide-email-copy.js'), path.join(tmp, 'scripts/add-guide-email-copy.js'));
      for (const slug of pagesWithPdf) fs.copyFileSync(path.join(ROOT, 'docs/guides', slug + '.html'), path.join(tmp, 'docs/guides', slug + '.html'));
      const before = pagesWithPdf.map((s) => fs.readFileSync(path.join(tmp, 'docs/guides', s + '.html'), 'utf8'));
      const out = execFileSync(process.execPath, [path.join(tmp, 'scripts/add-guide-email-copy.js')], { encoding: 'utf8' });
      const after = pagesWithPdf.map((s) => fs.readFileSync(path.join(tmp, 'docs/guides', s + '.html'), 'utf8'));
      ok('the inject script is idempotent', before.every((b, i) => b === after[i]) && /0 changed, 6 skipped, 0 failed/.test(out), out.trim().split('\n').pop());
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
