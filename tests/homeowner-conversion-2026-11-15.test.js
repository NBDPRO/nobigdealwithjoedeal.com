/**
 * tests/homeowner-conversion-2026-11-15.test.js — the wave-3 conversion fixes
 * on the homeowner site (shared-notes wave3-homeowner-site-2026-11-14.md,
 * findings #2-#11, #13-#15 and the AI-tell list). /estimate (#1) is #3089's.
 *
 * Structural checks (parseTags) and run-the-code checks (loadInVm) only, so a
 * reflow or a reworded comment does not break them and a deleted fix does.
 *
 *   #2  town heroes carry the credentials strip
 *   #3  the on-page quick form is short; extras sit behind one optional toggle
 *   #4  "Book Inspection" in the nav goes to /inspect, not the long homepage form
 *   #5  "Get My Care Plan" lands on the homepage form with the plan picked
 *   #6  siding/gutter "Book a free estimate" opens the on-page form for that service
 *   #7  /storm-check promises what it delivers ("should it get looked at")
 *   #8  /pro/refer names Joe and gives a way forward without a code
 *   #9  Our Work hero has a booking button and tap-to-call
 *   #10 phone numbers in error and thank-you states are tel: links
 *   #11 /credentials offers the certificate of insurance
 *   #13 no "coming soon" placeholder in the recent-jobs strip
 *   #14 the roof-repair box is titled for repairs
 *   #15 every tel: link carries +1
 *   AI tells: "Actually" headings on /about, emoji H3s on town pages
 *
 * Zero deps. Run: node tests/homeowner-conversion-2026-11-15.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const K = require('./lib/src-kit');
const T = K.suite('HOMEOWNER CONVERSION FIXES (wave 3, 2026-11-15)');
const { ok, section } = T;

const DOCS = path.join(K.ROOT, 'docs');
const rel = (abs) => path.relative(K.ROOT, abs).split(path.sep).join('/');
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.html')) out.push(full);
  }
  return out;
}
const page = (r) => K.parseTags(K.read(r));
const TEL = 'tel:+18594207382';

// ── #2 town heroes ─────────────────────────────────────────────────────────
section('#2 every town page hero carries the credentials strip');
const towns = fs.readdirSync(path.join(DOCS, 'areas')).filter((f) => f.endsWith('.html') && f !== 'index.html');
const noStrip = [], noCss = [], emojiH3 = [];
const EMOJI = /^[☀-➿\u{1F000}-\u{1FAFF}]/u;
for (const f of towns) {
  const doc = page('docs/areas/' + f);
  const hero = doc.$('.city-hero-content');
  if (!hero || !hero.$('.cred-strip .cred-chip')) noStrip.push(f);
  if (!doc.$$('link').some((l) => (l.attr('href') || '').split('?')[0] === '/assets/css/credentials.css')) noCss.push(f);
  for (const h of doc.$$('h3')) if (EMOJI.test(h.text.trim())) emojiH3.push(f + ': ' + h.text.trim().slice(0, 30));
}
ok(towns.length + ' town pages found (45 expected or more)', towns.length >= 45);
ok('every town hero has the credential chips', noStrip.length === 0, noStrip.join(', '));
ok('every town page links credentials.css', noCss.length === 0, noCss.join(', '));
ok('no town-page H3 starts with an emoji', emojiH3.length === 0, emojiH3.slice(0, 5).join(' | '));

// ── #3 / #6 quick form, run in a vm ────────────────────────────────────────
section('#3 the quick form is short (run in a vm)');
function renderQuickForm(attrs) {
  let captured = '';
  const stub = () => ({ addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; }, appendChild() {}, value: '', checked: false, childElementCount: 0 });
  const host = {
    offsetTop: 0,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    set innerHTML(v) { captured = v; }, get innerHTML() { return captured; },
    querySelector: () => stub(),
  };
  const document = {
    readyState: 'complete',
    querySelectorAll: (sel) => (sel === '[data-nbd-quick-form]' ? [host] : []),
    querySelector: () => null,
    getElementById: () => stub(),
    createElement: () => stub(),
    head: { appendChild() {} },
    addEventListener() {},
  };
  K.loadInVm(['docs/assets/js/quick-lead-form.js'], { document, Promise, setTimeout, location: { pathname: '/x' } });
  return K.parseTags(captured);
}
const town = renderQuickForm({ 'data-city': 'Mason', 'data-service': '' });
ok('town form heading: "Book a Free Mason Inspection"', (town.$('.qlf-title') || {}).text === 'Book a Free Mason Inspection', (town.$('.qlf-title') || {}).text);
const svc = renderQuickForm({ 'data-service': 'Siding Replacement' });
ok('service form heading: "Book a Free Siding Replacement Estimate"', (svc.$('.qlf-title') || {}).text === 'Book a Free Siding Replacement Estimate', (svc.$('.qlf-title') || {}).text);
const sched = town.$('[data-nbd-intake]');
ok('the required block is the scheduling choice only (data-extras="false")', !!sched && sched.attr('data-extras') === 'false');
const more = town.$('details.qlf-more');
ok('email and the extras sit inside one optional <details>', !!more && !!more.$('input[type=email]') && !!more.$('[data-qlf-extras]'));
const required = town.$$('input').filter((i) => i.has('required')).map((i) => i.attr('name'));
ok('only name, phone and address are required inputs', required.join(',') === 'given-name,tel,street-address', required.join(','));
ok('the email input is NOT outside the toggle', town.$$('input[type=email]').length === 1);

section('#6 siding/gutter "Book a free estimate" opens the on-page form');
const svcFiles = fs.readdirSync(path.join(DOCS, 'services')).filter((f) => f.endsWith('.html'));
const badCta = [];
let estimateCtas = 0;
for (const f of svcFiles) {
  const doc = page('docs/services/' + f);
  for (const a of doc.$$('.svc-cta a')) {
    if (a.text.trim() !== 'Book a free estimate') continue;
    estimateCtas++;
    if (a.attr('href') !== '#quote' || !doc.byId('quote') || !doc.byId('quote').$('[data-nbd-quick-form]')) badCta.push(f);
  }
}
ok('"Book a free estimate" buttons found (36 expected)', estimateCtas >= 36, estimateCtas);
ok('each goes to #quote, a quick form tagged with the service', badCta.length === 0, badCta.join(', '));

// ── #4 nav, #15 tel hrefs (one pass over the public site) ──────────────────
section('#4 nav "Book Inspection" → /inspect · #15 every tel: link has +1');
const navBad = [], telBad = [];
let navCount = 0;
for (const abs of walk(DOCS, [])) {
  const r = rel(abs);
  if (r.startsWith('docs/pro/') && r !== 'docs/pro/refer.html') continue;
  // /estimate belongs to #3089 (lead intake); this bundle leaves that page as it is.
  if (r === 'docs/estimate.html') continue;
  const doc = K.parseTags(fs.readFileSync(abs, 'utf8'));
  for (const a of doc.$$('a')) {
    const href = a.attr('href') || '';
    if (/^Book Inspection/.test(a.text.trim())) { navCount++; if (href !== '/inspect' && href !== '#quote') navBad.push(r + ' → ' + href); }
    if (/^tel:/i.test(href) && !/^tel:\+1/.test(href)) telBad.push(r + ' ' + href);
  }
}
ok('"Book Inspection" links found (' + navCount + ')', navCount > 200);
ok('none goes to the long homepage form (/#contact)', navBad.length === 0, navBad.slice(0, 5).join(' | '));
ok('every tel: href starts tel:+1', telBad.length === 0, telBad.slice(0, 5).join(' | '));
for (const p of ['site-src/partials/nav-microsite.html']) {
  const a = K.parseTags(K.read(p)).$('a.nav-cta');
  ok(p + ': nav-cta → /inspect', !!a && a.attr('href') === '/inspect');
}

// The blog mid-post CTA is built in JS: run it and read the link it writes.
{
  let html = '';
  const fake = { setAttribute() {}, set innerHTML(v) { html = v; }, get innerHTML() { return html; } };
  const h2 = { nextElementSibling: null, nextSibling: null, parentNode: { insertBefore() {} } };
  const prose = { querySelector: () => null, querySelectorAll: () => [h2, h2, h2] };
  const g = {
    matchMedia: () => ({ matches: false }),
    document: { createElement: () => fake, querySelector: () => prose },
  };
  const fn = K.sliceFn(K.read('docs/assets/js/blog-midpost-cta.js'), 'inject', { unique: true });
  if (fn) K.loadInVm(['cta.js'], g, { src: { 'cta.js': fn + '\ninject();' } });
  const a = html ? K.parseTags(html).$('a.bmc-btn-primary') : null;
  ok('blog mid-post CTA phone link is tel:+1 (run)', !!a && a.attr('href') === TEL, a ? a.attr('href') : 'CTA not built');
}

// ── #5 Care Plan ───────────────────────────────────────────────────────────
section('#5 "Get My Care Plan" lands with the plan picked');
const cp = page('docs/services/roof-care-plan.html');
const cpCtas = cp.$$('a[data-careplan-cta]');
ok('Care Plan CTAs found', cpCtas.length >= 2);
ok('each goes to /?service=care-plan#contact', cpCtas.every((a) => a.attr('href') === '/?service=care-plan#contact'), cpCtas.map((a) => a.attr('href')).join(', '));
const home = page('docs/index.html');
const homeSrc = K.read('docs/index.html');
// 2026-11-17: #contact is the short quick form; ?service=care-plan is read by quick-lead-form.js (data-service-query).
ok('homepage quick form opts into ?service= tagging (data-service-query)', /<div data-nbd-quick-form data-service-query\b/.test(homeSrc));
ok('quick-lead-form.js maps care-plan to "Roof Care Plan"', /'care-plan': 'Roof Care Plan'/.test(K.read('docs/assets/js/quick-lead-form.js')));
{
  const sel = { value: '' };
  const g = {
    document: { getElementById: (id) => (id === 'fieldService' ? sel : null), querySelectorAll: () => [], addEventListener() {}, readyState: 'complete' },
    URLSearchParams, location: { search: '?service=care-plan' },
    matchMedia: () => ({ matches: false, addEventListener() {} }), setInterval() {}, setTimeout() {},
  };
  g.window = g; g.window.location = g.location;
  const fn = K.sliceFn(K.read('docs/assets/js/inline/72f02d79d0.js'), 'preselectServiceFromQuery', { unique: true });
  if (fn) K.loadInVm(['pre.js'], g, { src: { 'pre.js': fn + '\npreselectServiceFromQuery();' } });
  ok('?service=care-plan preselects it (run)', sel.value === 'Roof Care Plan', fn ? sel.value : 'function not found');
  const other = { value: '' };
  if (fn) K.loadInVm(['pre.js'], Object.assign({}, g, { location: { search: '?service=__proto__' }, document: { getElementById: () => other } }), { src: { 'pre.js': fn + '\nwindow.location = location; preselectServiceFromQuery();' } });
  ok('an unknown ?service= picks nothing (run)', other.value === '');
}

// ── #7 storm check ─────────────────────────────────────────────────────────
section('#7 /storm-check promises what it delivers');
const sc = page('docs/storm-check.html');
const scClaim = /worth (a|an insurance) claim|worth filing/i;
ok('<title> no longer promises a claim verdict', !scClaim.test(sc.$('title').text), sc.$('title').text);
ok('H1 no longer promises a claim verdict', !scClaim.test(sc.$('h1').text) && /looked at/i.test(sc.$('h1').text), sc.$('h1').text);
ok('submit button no longer promises a claim verdict', !scClaim.test(sc.byId('sc-submit').text), sc.byId('sc-submit').text);
const scMeta = sc.$$('meta').filter((m) => /description|title/.test(m.attr('name') || m.attr('property') || ''));
ok('meta/og/twitter copy no longer promises a claim verdict', scMeta.length >= 4 && scMeta.every((m) => !scClaim.test(m.attr('content') || '')));

// ── #8 refer ───────────────────────────────────────────────────────────────
section('#8 /pro/refer names Joe and gives a way forward');
const rf = page('docs/pro/refer.html');
const noLink = rf.byId('referNoLinkNbd');
ok('no-code state links /inspect and tap-to-call', !!noLink && !!noLink.$('a[href="/inspect"]') && !!noLink.$('a[href="' + TEL + '"]'));
const done = rf.byId('referDoneText');
ok('thank-you names Joe, not "your rep"', !!done && /Joe/.test(done.text) && !/your rep/i.test(done.text), done && done.text);
{
  // A white-label tenant (?co=) must not see Joe's name or number.
  const els = { referNoLinkNbd: { removed: false, remove() { this.removed = true; } }, referDoneText: { textContent: 'Joe…' } };
  const stub = { style: {}, addEventListener() {}, textContent: '' };
  const g = {
    URLSearchParams, location: { search: '?co=Acme%20Roofing', hostname: 'example.com' }, sessionStorage: { getItem: () => '1', setItem() {} },
    document: { title: '', querySelector: () => stub, getElementById: (id) => els[id] || stub },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  };
  try { K.loadInVm(['docs/pro/js/refer.js'], g); } catch (e) { /* no form wiring needed here */ }
  ok('?co= tenant: the NBD no-code line is removed (run)', els.referNoLinkNbd.removed);
  ok('?co= tenant: thank-you names the tenant, not Joe (run)', /Acme Roofing/.test(els.referDoneText.textContent) && !/Joe/.test(els.referDoneText.textContent), els.referDoneText.textContent);
}

// ── #9 Our Work hero ───────────────────────────────────────────────────────
section('#9 Our Work hero: booking button and tap-to-call');
const ow = page('docs/our-work.html').$('section.hero');
ok('hero links /inspect', !!ow && !!ow.$('a[href="/inspect"]'));
ok('hero has a tel:+1 link', !!ow && !!ow.$('a[href="' + TEL + '"]'));

// ── #10 tap-to-call in error states (run telify) ───────────────────────────
section('#10 phone numbers in error and thank-you states are tel: links');
function fakeEl(text) {
  return { textContent: text, children: [], appendChild(c) { this.children.push(c); } };
}
for (const f of ['docs/assets/js/inspect-form.js', 'docs/assets/js/storm-check.js', 'docs/assets/js/roof-score.js']) {
  const fn = K.sliceFn(K.read(f), 'telify', { unique: true });
  ok(f + ': has one telify()', !!fn);
  if (!fn) continue;
  const ctx = K.loadInVm(['telify.js'], {
    document: { createElement: () => ({ href: '', textContent: '' }), createTextNode: (t) => ({ textContent: t }) },
  }, { src: { 'telify.js': fn } });
  const el = fakeEl('Please call or text Joe at (859) 420-7382 so it isn’t lost.');
  ctx.telify(el);
  const a = el.children[0];
  ok(f + ': the number becomes a tel:+1 link with the rest of the sentence kept (run)',
    !!a && a.href === TEL && a.textContent === '(859) 420-7382' && el.textContent === 'Please call or text Joe at ' && el.children[1].textContent === ' so it isn’t lost.');
}
// Each message site calls telify on the element it just filled.
{
  const st = fakeEl('');
  const g = {
    document: { getElementById: (id) => (id === 'insDetailsStatus' ? st : null), createElement: () => ({ href: '', textContent: '' }), createTextNode: (t) => ({ textContent: t }) },
  };
  const src = K.read('docs/assets/js/inspect-form.js');
  const tf = K.sliceFn(src, 'telify', { unique: true });
  const ds = K.sliceFn(src, 'detailsStatus', { unique: true });
  if (tf && ds) {
    const ctx = K.loadInVm(['x.js'], g, { src: { 'x.js': tf + '\n' + ds } });
    ctx.detailsStatus('Couldn’t save that. Call or text Joe at (859) 420-7382.', true);
  }
  ok('inspect-form: detailsStatus() leaves a tel: link in the status line (run)', !!st.children[0] && st.children[0].href === TEL);
}
const ins = page('docs/inspect.html').byId('insThanksText');
ok('/inspect thank-you text has a tel:+1 link', !!ins && !!ins.$('a[href="' + TEL + '"]'));

// ── #11 credentials ────────────────────────────────────────────────────────
section('#11 /credentials offers the certificate of insurance');
const ins2 = page('docs/credentials.html').byId('fully-insured');
const sum = ins2 && ins2.$('.cred-summary');
ok('"Fully insured" card offers a certificate of insurance', !!sum && /certificate of insurance/i.test(sum.text), sum && sum.text);

// ── #13 / #14 placeholders and titles ──────────────────────────────────────
section('#13 no "coming soon" placeholder · #14 repair box titled for repairs');
const sid = page('docs/services/siding-replacement.html').byId('recent-jobs');
ok('siding recent-jobs strip has no "coming soon"', !!sid && !/coming soon/i.test(sid.text), sid && sid.text.trim().slice(0, 120));
const rr = page('docs/services/roof-repair.html');
const rrH3 = rr.$$('h3').map((h) => h.text.trim());
ok('roof-repair has no "Every Replacement Includes"', !rrH3.includes('Every Replacement Includes') && rrH3.includes('Every Repair Includes'));

// ── AI tells ───────────────────────────────────────────────────────────────
section('AI tells');
const about = page('docs/about.html');
const actually = about.$$('h2').filter((h) => /\bActually\b/.test(h.text));
ok('/about has no "Actually" headings', actually.length === 0, actually.map((h) => h.text).join(' | '));
const faq = home.$$('.faq-a').map((d) => d.text.trim());
ok('homepage FAQ answers do not open with "Absolutely"', faq.length > 0 && faq.every((t) => !/^Absolutely\b/.test(t)));

T.done();
