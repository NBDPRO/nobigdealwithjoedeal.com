#!/usr/bin/env node
/**
 * tests/pro-playbook-2026-10-16.test.js — the honest 2026 NBD Pro playbook at
 * /pro/playbook, its generator, and the one welcome email.
 *
 *   A. the page is built from site-src/guides/nbd-pro-playbook.md by
 *      scripts/build-guides.js (stale = fail), and the renderer escapes text
 *   B. the content: the compliance phrases are there (FTC review rule, no
 *      gating, no incentives, "Reply STOP to opt out", TCPA hours and opt-out,
 *      CAN-SPAM postal address, Google spam policies) and the banned ones are
 *      not (Masterclass, contractor counts, revenue figures, invented ranking
 *      weights, scarcity)
 *   C. the page: indexable, canonical, Article + BreadcrumbList schema, no
 *      inline script, deferred ?v= scripts, the PDF slot hidden until a PDF
 *      exists, the optional email form (unticked consent, honeypot)
 *   D. routing and links: every old guide URL 301s here, sitemap-pro lists it,
 *      /pro, /pro/pricing and each pro blog post link to a real chapter
 *   E. the welcome email: one per lead, commercial-gated (unsubscribe +
 *      postal address), never sent when suppressed / no address / capped,
 *      nothing typed echoed but a safe first name, PDF line only when the PDF
 *      is really published
 *
 * Run: node tests/pro-playbook-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}

const B = require(path.join(ROOT, 'scripts/build-guides.js'));
const PAGE = 'docs/pro/playbook.html';
const MD = 'site-src/guides/nbd-pro-playbook.md';

(async () => {
  console.log('A. generator');
  {
    const md = read(MD);
    const page = read(PAGE);
    const stamped = B.stamp(page, 'nbd-pro-playbook', B.render(md).html).replace(/\r\n/g, '\n');
    ok('the page body matches its Markdown (run node scripts/build-guides.js)', stamped === page);
    ok('the guide is registered with the generator', B.GUIDES.some((g) => g.slug === 'nbd-pro-playbook' && g.page === PAGE));
    const evil = B.inline('<script>alert(1)</script> **bold** [x](javascript:alert(1))'.replace('[x](javascript:alert(1))', ''));
    ok('the renderer escapes markup in the text', !/<script>/.test(evil) && /&lt;script&gt;/.test(evil) && /<strong>bold<\/strong>/.test(evil));
    let threw = false;
    try { B.inline('[x](javascript:alert(1))'); } catch (_) { threw = true; }
    ok('the renderer refuses a javascript: link', threw);
    ok('external links open safely; NBD links become relative', /<a href="https:\/\/business\.google\.com" target="_blank" rel="noopener">/.test(page) && /href="\/pro\/pricing"/.test(page) && !/href="https:\/\/nobigdealwithjoedeal\.com/.test(page.split('GUIDE-BODY:START')[1] || ''));
    ok('phone and email in the text are tappable', /href="tel:\+18594207382"/.test(page) && /href="mailto:jd@nobigdealwithjoedeal\.com"/.test(page));
    const fm = B.splitFrontMatter(md).meta;
    ok('front matter names the slug, URL and audience', fm.slug === 'nbd-pro-playbook' && fm.url === 'https://nobigdealwithjoedeal.com/pro/playbook' && /Contractors/.test(fm.audience || ''));
    ok('front matter carries compliance notes', /^compliance:\n(\s+- .+\n){4,}/m.test(md.split('\n---')[0] + '\n'));
  }

  console.log('B. content');
  {
    const md = read(MD).split(/\n---\n/).slice(1).join('\n---\n');
    const REQUIRED = [
      [/Reply STOP to opt out/, 'Reply STOP to opt out (text template)'],
      [/16 CFR Part 465/, 'FTC consumer reviews rule'],
      [/Ask everyone/, 'ask everyone'],
      [/review gating/, 'no review gating'],
      [/\*\*No incentives\.\*\*/, 'no incentives'],
      [/\*\*No fake reviews\.\*\*/, 'no fake reviews'],
      [/between 8am and 9pm/, 'TCPA quiet hours'],
      [/within 10 business days/, 'opt-out honored within 10 business days'],
      [/permission to text them, in writing/, 'written consent to text'],
      [/A2P 10DLC/, 'registered sender'],
      [/physical postal address/, 'CAN-SPAM postal address'],
      [/doorway pages/, 'no doorway pages'],
      [/scaled content abuse/, 'no scaled AI content'],
      [/paid links as link spam/, 'no bought links'],
      [/relevance[\s\S]{0,400}distance[\s\S]{0,400}prominence/i, "Google's own local ranking factors"],
      [/started my own company, No Big Deal Home Solutions/, 'honest origin (NBD started 2026)'],
      [/It is not a promise/, 'no results promise'],
      [/not legal advice/, 'not legal advice'],
    ];
    for (const [re, label] of REQUIRED) ok('says: ' + label, re.test(md));
    const BANNED = [
      [/masterclass/i, 'Masterclass'],
      [/\d[\d,]*\+?\s+contractors/i, 'contractor counts'],
      [/\$\s?\d+(\.\d+)?\s?[MK]\b|\$1M|million/i, 'revenue figures'],
      [/\(\d+%\)|\d+%\s+of\s+(the\s+)?rank/i, 'invented ranking weights'],
      [/won'?t be free|limited time|only available to readers|founding member/i, 'scarcity / upsell'],
      [/5 years testing|10\+ (qualified )?leads|4\.9/i, 'old claims'],
      [/guarantee(d)? (results|ranking|you)/i, 'guarantees'],
      [/50 directories|2,000\+ words/i, 'dated SEO advice'],
      [/case study|real result/i, 'unverifiable case studies'],
    ];
    for (const [re, label] of BANNED) ok('never says: ' + label, !re.test(md), (md.match(re) || [''])[0]);
    const words = md.split(/\s+/).filter(Boolean).length;
    ok('long enough for the ~20-page PDF (3,500+ words) but not padded (under 9,000)', words >= 3500 && words <= 9000, words + ' words');
    const chapters = (md.match(/^# \d+\. /gm) || []).length;
    ok('twelve numbered chapters', chapters === 12, chapters);
  }

  console.log('C. the page');
  {
    const h = read(PAGE);
    ok('indexable, with a canonical', /<meta name="robots" content="index,follow">/.test(h) && /<link rel="canonical" href="https:\/\/nobigdealwithjoedeal\.com\/pro\/playbook">/.test(h));
    const fb = JSON.parse(read('firebase.json'));
    const noindex = fb.hosting.headers.filter((x) => (x.headers || []).some((k) => k.key === 'X-Robots-Tag'))
      .map((x) => x.source || '').filter((s) => s === '/pro/playbook' || s === '/pro' || s === '/pro/**');
    ok('no X-Robots noindex header covers /pro/playbook', noindex.length === 0, noindex.join(','));
    const ld = [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const art = ld.find((x) => x['@type'] === 'Article');
    ok('Article schema: headline, author is Joe (the site-wide #joe entity), free, dates', art && /Local Marketing Playbook/.test(art.headline) && art.author && art.author['@id'] === 'https://nobigdealwithjoedeal.com/#joe' && art.isAccessibleForFree === true && art.datePublished);
    ok('BreadcrumbList schema', ld.some((x) => x['@type'] === 'BreadcrumbList'));
    const scripts = [...h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    ok('no inline script (only JSON-LD has a body)', scripts.every((m) => /application\/ld\+json/.test(m[1]) || m[2].trim() === ''));
    ok('every external script is deferred', scripts.filter((m) => /\ssrc=/.test(m[1])).every((m) => /\bdefer\b/.test(m[1])));
    ok('changed assets are cache-busted', /nbd-guide\.css\?v=\d+/.test(h) && /playbook-form\.js\?v=\d+/.test(h) && /guide-pdf-slot\.js\?v=\d+/.test(h));
    ok('no on*= handlers and no inline style attributes', !/\son[a-z]+=\s*"/i.test(h) && !/\sstyle="/.test(h));
    ok('fonts are self-hosted and preloaded (no Google Fonts)', /nbd-fonts\.css/.test(h) && /rel="preload" href="\/assets\/fonts\/bebas-neue/.test(h) && !/fonts\.googleapis/.test(h));
    ok('the PDF link is hidden until the PDF exists, with a "coming soon" note', /<a class="g-btn g-btn-ghost" data-pdf-slot data-pdf-href="\/guides\/pdf\/nbd-pro-playbook\.pdf" hidden>/.test(h) && !/\shref="\/guides\/pdf\//.test(h) && /data-pdf-soon>Printable PDF coming soon/.test(h));
    const slot = read('docs/assets/js/guide-pdf-slot.js');
    ok('the slot shows the link only for a same-origin 200 application/pdf', /method: 'HEAD'/.test(slot) && /res\.ok && type\.indexOf\('application\/pdf'\) !== -1/.test(slot) && /\^\\\/guides\\\/pdf\\\/\[a-z0-9-\]\+\\\.pdf\$/.test(slot));
    ok('the whole guide is on the page, ungated (no form before the contents)', h.indexOf('id="playbookForm"') > h.indexOf('GUIDE-BODY:END'));
    ok('the email form: name, email, UNTICKED optional consent, honeypot', /name="name"/.test(h) && /type="email"/.test(h) && /<input type="checkbox" id="pbConsent" name="emailConsent" value="yes">/.test(h) && /name="nbd_hp"/.test(h));
    const P = require(path.join(ROOT, 'functions/pro-prospects-logic.js'));
    ok('the consent words match the versioned text the server records', h.includes(P.EMAIL_CONSENT_TEXT));
    const js = read('docs/assets/js/playbook-form.js');
    ok('the form posts kind guide, source pro-playbook, consent as a boolean', /submitPublicLead\('guide'/.test(js) && /source: 'pro-playbook'/.test(js) && /emailConsent: !!\(consent && consent\.checked\)/.test(js));
    ok('a failed save is never shown as success', /if \(!res \|\| !res\.ok\) \{\s*say\('err'/.test(js));
    ok('loads the Turnstile key and the lead client before the form script', h.indexOf('inline/7cd8e505ab.js') < h.indexOf('public-lead-submit.js') && h.indexOf('public-lead-submit.js') < h.indexOf('playbook-form.js'));
    const css = read('docs/assets/css/nbd-guide.css');
    const radii = [...css.matchAll(/border-radius:\s*([^;}]+)/g)].map((m) => m[1].trim());
    ok('guide CSS: radii are 8px and pills only (DESIGN.md)', radii.every((r) => /^(8px|100px|0 0 8px 0)$/.test(r)), radii.join(' | '));
    ok('guide CSS: brand orange, never the old oranges or #6b7280', /#bd5728/i.test(css) && !/#E8720C|#F08030|#6b7280/i.test(css));
    ok('guide CSS: 44px tap targets', /--tap-min:44px/.test(css) && /min-height:var\(--tap-min\)/.test(css));
  }

  console.log('D. routing and links');
  {
    const fb = JSON.parse(read('firebase.json'));
    const r = (src) => (fb.hosting.redirects || []).find((x) => x.source === src);
    for (const src of ['/sites/free-guide', '/sites/free-guide/**', '/free-guide', '/lead-magnet.pdf']) {
      const x = r(src);
      ok(src + ' 301s to /pro/playbook', x && x.type === 301 && x.destination === '/pro/playbook', JSON.stringify(x));
    }
    ok('sitemap-pro.xml lists /pro/playbook', /<loc>https:\/\/nobigdealwithjoedeal\.com\/pro\/playbook<\/loc>/.test(read('docs/sitemap-pro.xml')));
    ok('the homeowner sitemap does not', !/pro\/playbook/.test(read('docs/sitemap.xml')));
    ok('/pro links the playbook', /<a href="\/pro\/playbook" data-nbd-freeguide="v2">/.test(read('docs/pro/index.html')));
    ok('/pro/pricing links the playbook', /href="\/pro\/playbook">Free Marketing Playbook</.test(read('docs/pro/pricing.html')));
    const page = read(PAGE);
    const ids = new Set([...page.matchAll(/<section class="g-chapter" id="([^"]+)"/g)].map((m) => m[1]));
    for (const slug of ['google-maps-contractor-ranking', 'contractor-review-system', 'contractor-seo-90-day-fix', 'competition-crusher-contractor-marketing', 'ai-search-contractors-geo']) {
      const s = read('docs/pro/blog/' + slug + '.html');
      const anchors = [...s.matchAll(/href="\/pro\/playbook#([a-z0-9-]+)"/g)].map((m) => m[1]);
      ok(slug + ' links a real playbook chapter', anchors.length >= 2 && anchors.every((a) => ids.has(a)), anchors.join(','));
      ok(slug + ' no longer links the old guide URL', !/\/sites\/free-guide/.test(s));
    }
    const toc = [...page.matchAll(/<a href="#([a-z0-9-]+)">/g)].map((m) => m[1]);
    ok('every contents link has a target', toc.length >= 14 && toc.every((a) => ids.has(a)), toc.filter((a) => !ids.has(a)).join(','));
  }

  console.log('E. the welcome email');
  {
    const P = require(path.join(ROOT, 'functions/pro-prospects-logic.js'));
    const S = require(path.join(ROOT, 'functions/email-suppression.js'));
    const { _test } = require(path.join(ROOT, 'functions/pro-prospects.js'));
    ok('registered as a COMMERCIAL send path', S.SEND_PATHS['pro-prospects.js'] === 'commercial');
    ok('plan: no email / other page / already sent → no send', P.welcomePlan({ source: 'pro-playbook' }).send === false
      && P.welcomePlan({ email: 'a@b.co', source: 'somewhere' }).reason === 'other_source'
      && P.welcomePlan({ email: 'a@b.co', source: 'pro-playbook', welcomeEmailedAt: 1 }).reason === 'already_sent'
      && P.welcomePlan({ email: 'a@b.co', source: 'free-guide' }).send === true);
    function fakeDb(lead) {
      const docs = Object.assign({}, require('./lib/messaging-controls-open').OPEN_CONTROLS, { 'guide_leads/L1': Object.assign({}, lead) });
      const ref = (p) => ({
        path: p,
        async get() { return { exists: !!docs[p], data: () => docs[p] }; },
        async set(v) { docs[p] = Object.assign({}, docs[p] || {}, v); },
        async create(v) { if (docs[p]) { const e = new Error('already exists'); e.code = 6; throw e; } docs[p] = v; },
      });
      return {
        docs,
        doc: ref,
        async runTransaction(fn) {
          return fn({
            async get(r) { return { exists: !!docs[r.path], data: () => docs[r.path] }; },
            update(r, v) { docs[r.path] = Object.assign({}, docs[r.path], v); },
          });
        },
      };
    }
    const sent = [];
    const resend = { emails: { send: async (m) => { sent.push(m); return { data: { id: 'em_1' } }; } } };
    const gateOk = async () => ({ suppressed: false, footerHtml: '<p>FOOT-UNSUB 1 Main St</p>', footerText: '\nFOOT-UNSUB 1 Main St\n', headers: { 'List-Unsubscribe': '<https://x/unsubscribe/t>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, tags: [{ name: 'nbd_unsub', value: 't' }] });
    const capOk = async () => ({ allowed: ['x'], capped: [] });
    const base = { resend, from: 'NBD <noreply@x>', gate: gateOk, capRecipients: capOk, pdfReady: async () => false, serverTimestamp: () => 'TS' };
    const lead = { name: 'Sam <a href=x>click</a>', email: 'sam@example.com', source: 'pro-playbook' };

    let db = fakeDb(lead);
    const r1 = await _test.sendWelcome(db, 'L1', lead, base);
    const m = sent[0] || {};
    ok('sends one email to the address on the lead, reply-to Jo', r1.sent === true && sent.length === 1 && m.to === 'sam@example.com' && m.reply_to === 'jd@nobigdealwithjoedeal.com');
    ok('carries the gate footer (unsubscribe + postal) in HTML and text, and the one-click headers', /FOOT-UNSUB 1 Main St/.test(m.html) && /FOOT-UNSUB 1 Main St/.test(m.text) && m.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click' && m.tags && m.tags[0].name === 'nbd_unsub');
    ok('links the playbook page; no PDF line while the PDF is unpublished', m.html.includes(P.PLAYBOOK_URL) && !m.html.includes(P.PLAYBOOK_PDF_URL) && !m.text.includes('.pdf'));
    ok('echoes nothing typed except a safe one-word name', /Hi Sam,/.test(m.text) && !/click|href=x/.test(m.html + m.text));
    ok('stamps the outcome on the lead', db.docs['guide_leads/L1'].welcomeEmailedAt === 'TS' && db.docs['guide_leads/L1'].welcomeEmailId === 'em_1');
    const r2 = await _test.sendWelcome(db, 'L1', lead, base);
    ok('a redelivered trigger sends nothing more', r2.sent === false && r2.reason === 'claimed' && sent.length === 1);

    sent.length = 0; db = fakeDb(lead);
    await _test.sendWelcome(db, 'L1', lead, Object.assign({}, base, { pdfReady: async () => true }));
    ok('adds the PDF link once the PDF is published', sent[0] && sent[0].html.includes(P.PLAYBOOK_PDF_URL));

    const cases = [
      ['unsubscribed', { gate: async () => ({ suppressed: true }) }],
      ['no_postal_address', { gate: async () => ({ suppressed: false, blocked: true }) }],
      ['suppression_unverified', { gate: async () => { throw new Error('read timeout'); } }],
      ['recipient_cap', { capRecipients: async () => ({ allowed: [], capped: ['x'] }) }],
    ];
    for (const [reason, over] of cases) {
      sent.length = 0; db = fakeDb(lead);
      const r = await _test.sendWelcome(db, 'L1', lead, Object.assign({}, base, over));
      ok(reason + ' → not sent, and recorded', r.sent === false && r.reason === reason && sent.length === 0 && db.docs['guide_leads/L1'].welcomeSkipped === reason);
    }
    sent.length = 0; db = fakeDb(lead);
    const rejected = await _test.sendWelcome(db, 'L1', lead, Object.assign({}, base, { resend: { emails: { send: async () => ({ data: null, error: { message: 'bad from' } }) } } }));
    ok('a Resend rejection is recorded as send_failed, not as sent', rejected.sent === false && db.docs['guide_leads/L1'].welcomeSkipped === 'send_failed' && !db.docs['guide_leads/L1'].welcomeEmailedAt);

    const w = P.welcomeEmail({ firstName: '', pdfReady: false });
    const all = w.subject + w.text + w.html;
    ok('the email makes no banned claims', !/masterclass|\d+\+\s+contractors|\$\d+[MK]|guarantee|won'?t be free|limited time/i.test(all));
    ok('the email says why it was sent and offers nothing in exchange for anything', /because you asked for the playbook/.test(w.text) && !/gift|discount|reward/i.test(all));
    const src = read('functions/pro-prospects.js');
    ok('the trigger binds the Resend secrets and calls the commercial gate in code', /secrets: \[RESEND_API_KEY, EMAIL_FROM\]/.test(src) && /Suppression\.gateCommercialEmail/.test(src) && /companyId: NBD_OWNER_UID/.test(src));
    ok('one welcome email per inbox per 24h', _test.WELCOME_RECIPIENT_DAILY_CAP === 1 && /cap\('proWelcome', \[email\], \{ limit: WELCOME_RECIPIENT_DAILY_CAP \}\)/.test(src));
    ok('no follow-up sequence is scheduled', !/drip_queue|lead_followup|sendAt|scheduledFor|onSchedule/.test(src + read('functions/pro-prospects-logic.js')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
