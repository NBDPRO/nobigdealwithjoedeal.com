#!/usr/bin/env node
/**
 * tests/free-guide-honesty-2026-10-16.test.js — the contractor free guide
 * (/sites/free-guide), its 5 pro blog chapter posts and its lead path, after
 * the site-docs audit (2026-10-16).
 *
 *   A. banned claims never come back anywhere on the public site: the wrong
 *      phone the old PDF printed (built from parts below, so this file never
 *      carries it), "500+ contractors", a /masterclass link or
 *      Masterclass pitch, "$2M", "won't be free forever", "5 years testing",
 *      "10+ qualified leads per week", "$1M+"
 *   B. the old PDF is gone (file removed, /lead-magnet.pdf 301s to the page),
 *      no page links it, and .gitattributes keeps *.pdf binary
 *   C. the page: both forms carry the optional email-consent box and post it;
 *      the MailerLite FORM_ACTION_URL stub is gone; every local link resolves
 *   D. the pro blog posts: no homeowner cal.com booking, CTAs point at NBD
 *      Pro, no empty inline <script> (it threw a CSP violation on every load)
 *   E. the server: guide kind accepts emailConsent (boolean) and stamps the
 *      wording version; prospects alert Jo via email_queue (deterministic id,
 *      daily cap) and list on /admin/tenants.html; never bridged into the
 *      homeowner pipeline
 *   F. the storm-report email prints the postal address, escaped
 *
 * Run: node tests/free-guide-honesty-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}

// Public pages + their scripts. The CRM app (docs/pro/js, the app shells) is
// a signed-in product; its own "Masterclass" academy content is not a pitch for
// the retired /masterclass page and is out of scope here.
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(p, out); }
    else if (/\.(html|js|txt|xml|json)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(DOCS, []);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

const PRO_BLOG = ['google-maps-contractor-ranking', 'contractor-review-system', 'contractor-seo-90-day-fix', 'competition-crusher-contractor-marketing', 'ai-search-contractors-geo']
  .map((s) => 'docs/pro/blog/' + s + '.html');
const GUIDE_SURFACES = ['docs/sites/free-guide/index.html', 'docs/pro/playbook.html', 'docs/pro/blog/index.html', ...PRO_BLOG];

(async () => {
  console.log('A. banned claims');
  {
    // The wrong number, assembled from parts: the repo's personal-data guard
    // (no-personal-data-in-repo) must never find it written out in a tracked file.
    const P1 = '5' + '13', P2 = '3' + '15', P3 = '24' + '06';
    const WRONG_PHONE = new RegExp(P1 + '[\\s.\\-)]*' + P2 + '[\\s.\\-]*' + P3);
    ok('the phone pattern is live (sanity)', WRONG_PHONE.test(P1 + '-' + P2 + '-' + P3) && WRONG_PHONE.test('(' + P1 + ') ' + P2 + '.' + P3) && !WRONG_PHONE.test('(859) 420-7382'));
    const phoneHits = files.filter((f) => WRONG_PHONE.test(fs.readFileSync(f, 'utf8'))).map(rel);
    ok("the old PDF's wrong phone number appears nowhere under docs/", phoneHits.length === 0, phoneHits.join(', '));
    const fnPhone = fs.readdirSync(path.join(ROOT, 'functions')).filter((n) => n.endsWith('.js'))
      .filter((n) => WRONG_PHONE.test(fs.readFileSync(path.join(ROOT, 'functions', n), 'utf8')));
    ok('…nor in any functions/*.js email', fnPhone.length === 0, fnPhone.join(', '));
    const mc = files.filter((f) => /nobigdealwithjoedeal\.com\/masterclass|href="\/masterclass/i.test(fs.readFileSync(f, 'utf8'))).map(rel);
    ok('no link to the 404 /masterclass page anywhere', mc.length === 0, mc.join(', '));
    const c500 = files.filter((f) => /500\+\s*contractors/i.test(fs.readFileSync(f, 'utf8'))).map(rel);
    ok('"500+ contractors" appears nowhere', c500.length === 0, c500.join(', '));
    const BANNED = [
      [/masterclass/i, 'Masterclass'],
      [/\$2M/, '$2M'],
      [/\$1M\+/, '$1M+'],
      [/won'?t be free forever/i, "won't be free forever"],
      [/5 years testing/i, '5 years testing'],
      [/10\+ (qualified )?leads (per|a|\/) ?week/i, '10+ leads/week'],
      [/join \d[\d,]*\+? contractors/i, 'Join N contractors'],
      [/4\.9\+? star/i, '4.9+ star'],
      [/\$97/, '$97'],
      [/cal\.com\/nobigdeal\/roof-inspection/, 'homeowner booking link'],
      [/lead-magnet\.pdf/, 'old PDF link'],
    ];
    for (const f of GUIDE_SURFACES) {
      const s = read(f);
      const hits = BANNED.filter(([re]) => re.test(s)).map(([, l]) => l);
      ok(f + ' carries none of the banned claims/links', hits.length === 0, hits.join(', '));
    }
  }

  console.log('B. old PDF');
  {
    ok('docs/lead-magnet.pdf is removed', !fs.existsSync(path.join(DOCS, 'lead-magnet.pdf')));
    const fb = JSON.parse(read('firebase.json'));
    const r = (fb.hosting.redirects || []).find((x) => x.source === '/lead-magnet.pdf');
    // Since the playbook rewrite (2026-10-16, PR 2) every old guide URL lands on /pro/playbook.
    ok('/lead-magnet.pdf 301s to the playbook', r && r.type === 301 && r.destination === '/pro/playbook', JSON.stringify(r));
    const fg = (fb.hosting.redirects || []).find((x) => x.source === '/free-guide');
    ok('/free-guide 301s straight to the playbook (no double hop)', fg && fg.type === 301 && fg.destination === '/pro/playbook');
    const ga = fs.existsSync(path.join(ROOT, '.gitattributes')) ? read('.gitattributes') : '';
    ok('.gitattributes marks *.pdf binary', /^\*\.pdf\s+binary\s*$/m.test(ga));
  }

  console.log('C. the free-guide page');
  {
    const html = read('docs/sites/free-guide/index.html');
    const js = read('docs/assets/js/inline/3117b8ac17.js');
    const cap = read('docs/assets/js/inline/0a1da782e5.js');
    const boxes = html.match(/<input type="checkbox" id="emailConsent2?" name="emailConsent" value="yes">/g) || [];
    ok('both forms carry an UNCHECKED optional email-consent box', boxes.length === 2 && !/name="emailConsent"[^>]*checked/.test(html));
    ok('the consent label says what it is and how to stop', (html.match(/Also email me occasional NBD Pro tips from Joe \(a few emails at most\)\. Unsubscribe any time\./g) || []).length === 2);
    const P = require(path.join(ROOT, 'functions/pro-prospects-logic.js'));
    ok('the page wording matches the versioned consent text the server records', html.includes(P.EMAIL_CONSENT_TEXT) && /^pro-guide-email-\d{4}-\d{2}-\d{2}$/.test(P.EMAIL_CONSENT_VERSION));
    ok('the form JS reads the box and posts it as a boolean', /consentInput && consentInput\.checked/.test(js) && /_captureGuideLeads\(formData\.name, formData\.email, formData\.emailConsent\)/.test(js)
      && /emailConsent: emailConsent === true/.test(cap));
    ok('the FORM_ACTION_URL MailerLite stub is gone', !/FORM_ACTION_URL'|fetch\(FORM_ACTION_URL/.test(js));
    ok('a failed save is still never shown as success', /if \(!res \|\| !res\.ok\) \{ showFormError\(form\); return; \}/.test(js));
    ok('the success state promises an email, not a download', (html.match(/I'll email it to you as soon as it's done/g) || []).length === 2 && !/download/i.test(html.replace(/<head>[\s\S]*?<\/head>/, '')));
    ok('the changed scripts carry a ?v= cache-buster', /inline\/3117b8ac17\.js\?v=\d+/.test(html) && /inline\/0a1da782e5\.js\?v=\d+/.test(html));
    ok('Joe is described honestly: a roofer, NBD started in 2026, NBD Pro built for his own company', /started No Big Deal Home Solutions in 2026/.test(html) && /built <a href="\/pro" class="inline-link">NBD Pro<\/a> to run his own company/.test(html));
    ok('no results promise', /not a promise of results/.test(html));
    // Every local link on the guide surfaces resolves to a file (cleanUrls).
    const missing = [];
    for (const f of GUIDE_SURFACES) {
      const s = read(f);
      for (const m of s.matchAll(/\shref="(\/[^"#?]*)/g)) {
        let u = m[1];
        if (/^\/(unsubscribe|r)\b/.test(u)) continue;
        // PDF slots: hidden until the typeset PDF is published (guide-pdf-slot.js).
        if (/^\/guides\/pdf\/[a-z0-9-]+\.pdf$/.test(u) && new RegExp('data-pdf-slot href="' + u.replace(/[.]/g, '\\.') + '" hidden').test(s)) continue;
        const cands = [u, u + '.html', u.replace(/\/$/, '') + '/index.html', u + '/index.html'];
        if (!cands.some((c) => fs.existsSync(path.join(DOCS, c)) && fs.statSync(path.join(DOCS, c)).isFile())) missing.push(f + ' → ' + u);
      }
    }
    ok('every local link on the guide surfaces resolves', missing.length === 0, missing.join(', '));
  }

  console.log('D. pro blog chapter posts');
  for (const f of PRO_BLOG) {
    const s = read(f);
    ok(f + ': no empty inline <script> (CSP violation)', !/<script>\s*<\/script>/.test(s) && !/<script>(?!\s*$)/.test(s.replace(/<script type="application\/ld\+json">/g, '')));
    ok(f + ': sidebar and series CTAs go to NBD Pro sign-up', /href="\/pro\/register\.html\?utm_source=pro-blog&amp;utm_medium=sidebar/.test(s) && /href="\/pro\/register\.html\?utm_source=pro-blog&amp;utm_medium=series/.test(s));
    ok(f + ': no "Chapter N of the masterclass" label', !/Chapter \d+ of the (NBD Pro )?(masterclass|Local Authority)/i.test(s) && !/masterclass/i.test(s));
  }

  console.log('E. server: consent, alert, admin list, no pipeline');
  {
    const I = read('functions/handlers/integrations.js');
    const guide = I.slice(I.indexOf('  guide: {'), I.indexOf('  contact: {'));
    ok('guide kind declares emailConsent as a boolean optional', /boolOptional: \['emailConsent'\]/.test(guide));
    ok('the consent record is server-stamped (time + wording version) only when ticked',
      /if \(kind === 'guide' && data\.emailConsent === true\) \{\n\s+data\.emailConsentAt = FieldValue\.serverTimestamp\(\);\n\s+data\.emailConsentVersion = require\('\.\.\/pro-prospects-logic'\)\.EMAIL_CONSENT_VERSION;/.test(I));
    const L = require(path.join(ROOT, 'functions/lead-bridge-logic.js'));
    ok('guide_leads is still never bridged into the homeowner pipeline', !Object.prototype.hasOwnProperty.call(L.BRIDGE_KINDS, 'guide_leads'));
    const PLG = require(path.join(ROOT, 'functions/public-lead-guard.js'));
    ok('…and never pages the homeowner alert path', PLG.isAlertEligible('guide_leads', {}) === false);

    const P = require(path.join(ROOT, 'functions/pro-prospects-logic.js'));
    const mail = P.prospectAlertEmail({ name: 'Sam <b>Roof</b>\nCo', email: 'sam@example.com', emailConsent: true, source: 'free-guide', utm_source: 'pro-blog', utm_campaign: 'maps' }, 'abc123');
    ok('alert subject names the prospect, markup and newlines stripped', mail.subject === 'New NBD Pro prospect: Sam bRoof/b Co', mail.subject);
    ok('alert body: email, consent, campaign, record id, admin link, "not a homeowner lead"',
      /Email: sam@example\.com/.test(mail.bodyPlain) && /Tips emails OK: yes/.test(mail.bodyPlain) && /Campaign: source=pro-blog, campaign=maps/.test(mail.bodyPlain)
      && /guide_leads\/abc123/.test(mail.bodyPlain) && /admin\/tenants\.html#prospects/.test(mail.bodyPlain) && /not a homeowner lead/.test(mail.bodyPlain));
    const m2 = P.prospectAlertEmail({ name: 'Pat', email: 'p@x.co' }, 'z');
    ok('no consent → "playbook only", no empty Campaign line', /Tips emails OK: no \(send the playbook only\)/.test(m2.bodyPlain) && !/Campaign:/.test(m2.bodyPlain));
    const row = P.prospectRow('id1', { name: 'A', email: 'a@b.co', emailConsent: 'true', createdAt: { toDate: () => new Date('2026-10-16T12:00:00Z') }, ip: '1.2.3.4', userAgent: 'x' });
    ok('admin row: consent only on a real boolean true, ISO date, no IP or user agent', row.emailConsent === false && row.createdAt === '2026-10-16T12:00:00.000Z' && !('ip' in row) && !('userAgent' in row));

    const { _test } = require(path.join(ROOT, 'functions/pro-prospects.js'));
    function fakeDb() {
      const docs = {};
      return {
        docs,
        doc(p) {
          return {
            async create(v) { if (docs[p]) { const e = new Error('already exists'); e.code = 6; throw e; } docs[p] = v; },
            async set(v) { docs[p] = Object.assign({}, docs[p] || {}, v); },
          };
        },
      };
    }
    const db = fakeDb();
    const r1 = await _test.handleGuideLead(db, 'L1', { name: 'Sam', email: 'sam@example.com' }, { alertAllowed: async () => true });
    const q = db.docs['email_queue/pro-prospect-alert-L1'];
    ok('a new prospect queues ONE alert to Jo with a deterministic id', r1.alerted === true && q && q.to === 'jd@nobigdealwithjoedeal.com' && q.source === 'pro_prospect_alert' && q.status === 'pending' && /New NBD Pro prospect: Sam/.test(q.subject));
    ok('…and stamps the prospect as alerted', !!(db.docs['guide_leads/L1'] && db.docs['guide_leads/L1'].prospectAlertedAt));
    const r2 = await _test.handleGuideLead(db, 'L1', { name: 'Sam' }, { alertAllowed: async () => true });
    ok('a retried trigger does not queue a second alert', r2.alerted === false && r2.reason === 'duplicate');
    const db2 = fakeDb();
    const r3 = await _test.handleGuideLead(db2, 'L2', { name: 'Flood' }, { alertAllowed: async () => false });
    ok('over the daily cap: stored, not alerted', r3.alerted === false && r3.reason === 'cap' && Object.keys(db2.docs).length === 0);
    ok('the cap is a sane daily number', P.ALERT_DAILY_CAP >= 10 && P.ALERT_DAILY_CAP <= 200);

    const idx = read('functions/index.js');
    const map = JSON.parse(read('functions/function-map.json'));
    ok('both functions are exported and mapped', /exports\.onGuideLeadCreated = proProspects\.onGuideLeadCreated;/.test(idx) && /exports\.adminListProProspects = proProspects\.adminListProProspects;/.test(idx)
      && map.onGuideLeadCreated === './pro-prospects' && map.adminListProProspects === './pro-prospects');
    const src = read('functions/pro-prospects.js');
    ok('the admin list is platform-admin only, App Check enforced, rate limited',
      /const platform = t\.role === 'admin' \|\| request\.auth\.uid === NBD_OWNER_UID;\n\s+if \(!platform\) throw new HttpsError\('permission-denied'/.test(src) && /enforceAppCheck: true/.test(src) && /callableRateLimit\(request, 'adminListProProspects'/.test(src));
    ok('the deploy workflow will pick both up (exports.X = onCall/onDocumentCreated( at line start)', /^exports\.onGuideLeadCreated = onDocumentCreated\(/m.test(src) && /^exports\.adminListProProspects = onCall\(/m.test(src));
    const adm = read('docs/admin/js/pages/tenants.js');
    const admHtml = read('docs/admin/tenants.html');
    ok('/admin/tenants.html lists the prospects (escaped, callable, cache-busted)', /callable\('adminListProProspects'\)/.test(adm) && /esc\(p\.name/.test(adm) && /id="prospectsList"/.test(admHtml) && /tenants\.js\?v=\d+/.test(admHtml));
    ok('the admin list has no inline style attribute (CSP)', !/style="/.test(adm));
  }

  console.log('F. storm-report email postal address');
  {
    const S = require(path.join(ROOT, 'functions/storm-report-email.js'))._test;
    const withAddr = S.EMAIL_HTML({ firstName: 'Ann', address: 'ZIP 45202', summary: 'x', gust: null, postalAddress: '123 Main St <b>, Cincinnati, OH 45202' });
    ok('the footer prints the postal address, escaped', withAddr.includes('<p>123 Main St &lt;b&gt;, Cincinnati, OH 45202</p>'));
    const without = S.EMAIL_HTML({ firstName: 'Ann', address: '', summary: 'x', gust: null, postalAddress: '' });
    ok('no address → no empty line, and the email still renders', !/<p><\/p>/.test(without) && /Your 5-Year Storm History/.test(without));
    const src = read('functions/storm-report-email.js');
    ok('the address comes from NBD\'s Company Profile (same source as the other NBD emails), never hard-coded',
      /Suppression\.tenantPostalAddress\(getFirestore\(\), NBD_OWNER_UID\)/.test(src));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
