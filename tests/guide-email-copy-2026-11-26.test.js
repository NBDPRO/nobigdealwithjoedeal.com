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
const INJ = require(path.join(ROOT, 'scripts', 'add-guide-email-copy.js'));
const scriptSlugs = INJ.SLUGS;
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

  console.log('\nGATEWAY (the real submitPublicLead, firebase stubbed) + GUARD');
  {
    const gwStubs = (added) => ({
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
      '../integrations/upstash-ratelimit': { enforceRateLimit: async () => ({}), httpRateLimit: async () => true, clientIp: () => '198.51.100.7', provider: 'stub' },
      '../integrations/turnstile': { verifyTurnstile: async () => ({ ok: true, configured: false }) },
    });
    const GW = F('handlers/integrations.js');
    async function submit(body) {
      const added = [];
      delete require.cache[GW];
      stubs = gwStubs(added);
      const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
      try {
        const mod = require(GW);
        await mod.submitPublicLead.__handler({ method: 'POST', headers: {}, body: Object.assign({ kind: 'guide_copy' }, body) }, res);
      } finally { stubs = null; delete require.cache[GW]; }
      return { res, added };
    }
    const good = await submit({ email: 'home@owner.com', guide: 'roof-financing-explained', source: '/guides/roof-financing-explained', emailConsent: true });
    const row = (good.added[0] || {}).row || {};
    ok('a valid request is stored in guide_copy_requests with email, guide and source',
      good.res.code === 200 && (good.added[0] || {}).name === 'guide_copy_requests' && row.email === 'home@owner.com' && row.guide === 'roof-financing-explained',
      { code: good.res.code, body: good.res.body, added: good.added.map((a) => a.name) });
    ok('a ticked box is stamped server-side with the storm-tips wording version',
      row.emailConsent === true && row.emailConsentAt === '__server_ts__' && row.emailConsentVersion === G.STORM_TIPS_CONSENT_VERSION);
    const noBox = await submit({ email: 'home@owner.com', guide: 'roof-financing-explained', source: 'x' });
    ok('an unticked box stores no consent', noBox.added.length === 1 && !('emailConsentAt' in noBox.added[0].row) && noBox.added[0].row.emailConsent !== true);
    const badEmail = await submit({ email: 'not-an-email', guide: 'roof-financing-explained', source: 'x' });
    const badGuide = await submit({ email: 'a@b.com', guide: 'nbd-pro-playbook', source: 'x' });
    const noGuide = await submit({ email: 'a@b.com', source: 'x' });
    ok('a bad email, an unknown guide and a missing guide are refused (400) and nothing is stored',
      badEmail.res.code === 400 && (badEmail.res.body || {}).field === 'email' && badGuide.res.code === 400 && noGuide.res.code === 400 &&
      !badEmail.added.length && !badGuide.added.length && !noGuide.added.length, [badEmail.res.code, badGuide.res.code, noGuide.res.code]);
    const extra = await submit({ email: 'a@b.com', guide: 'hail-photo-baseline-sheet', source: 'x', leadScore: '99', phone: '5135550142' });
    ok('fields outside the kind allowlist are dropped', extra.added.length === 1 && !('leadScore' in extra.added[0].row) && !('phone' in extra.added[0].row));
  }
  const PLG = require(F('public-lead-guard.js'));
  ok('a guide copy is never alert-eligible (spends no alert budget); a contact lead still is',
    PLG.isAlertEligible('guide_copy_requests', { email: 'a@b.com' }) === false && PLG.isAlertEligible('contact_leads', {}) === true);
  const rules = read('firestore.rules');
  ok('rules: clients can never write guide_copy_requests', /match \/guide_copy_requests\/\{reqId\} \{\s*allow create, update, delete: if false;\s*allow read: if isAdmin\(\);/.test(rules));
  ok('the sender is classified transactional in SEND_PATHS', require(F('email-suppression.js')).SEND_PATHS['guide-copy-email.js'] === 'transactional');
  {
    const fmap = JSON.parse(read('functions/function-map.json'));
    const names = [];
    (function walk(v) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.keys(v).forEach((k) => { names.push(k); walk(v[k]); }); else if (typeof v === 'string') names.push(v); })(fmap);
    ok('both new functions are exported (function-map.json)', names.indexOf('guideCopyEmail') !== -1 && names.indexOf('leadBridgeGuideCopy') !== -1);
  }

  console.log('\nBRIDGE');
  const L = require(F('lead-bridge-logic.js'));
  const lead = L.mapPublicLeadToLead({ collection: 'guide_copy_requests', data: { email: 'a@b.com', guide: 'kentucky-ohio-storm-claim-guide', source: '/guides/kentucky-ohio-storm-claim-guide', emailConsent: true }, sourceId: 'r9', ownerUid: 'u', companyId: 'c' });
  ok('cold CRM lead: source "Website — Guide copy", email carried, no phone',
    lead.source === 'Website — Guide copy' && lead.email === 'a@b.com' && lead.phone === '' && lead.publicLeadKind === 'guide_copy');
  ok('the card names the guide and the storm-tips answer', /Storm Claim Guide \(KY & OH\)/.test(lead.notes) && /Storm tips email OK: yes/.test(lead.notes), lead.notes);

  console.log('\nPAGES');
  ok('checkbox wording is the one versioned guide-storm-tips-2026-11-26 (change both together)',
    G.STORM_TIPS_CONSENT_VERSION === 'guide-storm-tips-2026-11-26' && INJ.CONSENT_TEXT === 'Also email me storm-season tips from Joe now and then. Unsubscribe any time.');
  for (const slug of pagesWithPdf) {
    const page = fs.readFileSync(path.join(ROOT, 'docs/guides', slug + '.html'), 'utf8').replace(/\r\n/g, '\n');
    const parts = page.split('<!-- GUIDE-BODY:END ' + slug + ' -->\n');
    const tail = parts[1] || '';
    const want = '  ' + INJ.block(slug);
    const scripts = tail.split('<script defer src="').slice(1).map((x) => x.split('"')[0]);
    ok(slug + ': exactly the injected (hidden) box right after the generated body, with its scripts',
      parts.length === 2 && tail.slice(0, want.length) === want && page.split('data-guide-copy=').length === 2 &&
      scripts.indexOf('/assets/js/public-lead-submit.js') !== -1 && scripts.indexOf('/assets/js/guide-email-copy.js?v=2') !== -1,
      { parts: parts.length, scripts });
  }
  ok('how-a-roof-works (no PDF) has no box', fs.readFileSync(path.join(ROOT, 'docs/guides/how-a-roof-works.html'), 'utf8').split('data-guide-copy').length === 1);

  console.log('\nCLIENT (guide-email-copy.js run in a vm)');
  {
    const vm = require('vm');
    const mkEl = (extra) => Object.assign({ hidden: true, value: '', checked: false, textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } }, extra || {});
    const SRC = fs.readFileSync(path.join(ROOT, 'docs/assets/js/guide-email-copy.js'), 'utf8');
    const boot = (result) => {
      const calls = [];
      const box = mkEl(); box.attrs['data-guide-copy'] = 'home-care-warranty-card';
      const msg = mkEl(); const btn = mkEl({ textContent: 'Email me the PDF', disabled: false });
      const email = mkEl(); const consent = mkEl(); const hp = mkEl();
      let onSubmit = null; let resets = 0;
      const els = { 'button[type="submit"]': btn, 'input[name="email"]': email, 'input[name="emailConsent"]': consent, 'input[name="nbd_hp"]': hp };
      const form = { querySelector: (sel) => els[sel] || null, addEventListener: (t, h) => { if (t === 'submit') onSubmit = h; }, reset: () => { resets++; email.value = ''; } };
      const win = { submitPublicLead: async (kind, fields) => { calls.push({ kind, fields }); return result; }, location: { search: '?utm_source=fb' } };
      const ctx = { window: win, URLSearchParams, document: { querySelector: (s) => (s === '[data-guide-copy]' ? box : null), getElementById: (id) => ({ guideCopyForm: form, guideCopyMsg: msg }[id] || null) } };
      vm.runInNewContext(SRC, ctx);
      return { box, msg, email, consent, calls, submit: async () => { await onSubmit({ preventDefault() {} }); }, resets: () => resets };
    };
    const a = boot({ ok: true });
    ok('the box is revealed when the script runs', a.box.hidden === false);
    a.email.value = 'nope'; await a.submit();
    ok('a bad email shows an error and posts nothing', a.calls.length === 0 && a.msg.attrs['data-kind'] === 'err');
    a.email.value = ' home@owner.com '; a.consent.checked = true; await a.submit();
    const c = a.calls[0] || { fields: {} };
    ok('posts kind guide_copy with the page slug, /guides/<slug> as source, the box and UTMs',
      c.kind === 'guide_copy' && c.fields.email === 'home@owner.com' && c.fields.guide === 'home-care-warranty-card' &&
      c.fields.source === '/guides/home-care-warranty-card' && c.fields.emailConsent === true && c.fields.utm_source === 'fb', c);
    ok('success only after ok: form reset and the ok message', a.resets() === 1 && a.msg.attrs['data-kind'] === 'ok');
    const b = boot({ ok: false });
    b.email.value = 'home@owner.com'; await b.submit();
    ok('a failed save is never shown as success (no reset, error message)', b.resets() === 0 && b.msg.attrs['data-kind'] === 'err');
  }

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
