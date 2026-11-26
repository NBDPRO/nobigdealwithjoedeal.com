/**
 * tests/roof-check-merge-2026-11-25.test.js — the three storm tools are one
 * page, /roof-check (documentation/projects/ROOF-CHECK-MERGE-2026-11-25.md).
 *
 *   REDIRECTS  /storm-check, /roof-score, /storm-report (and .html) 301 to
 *              /roof-check; their files are gone (a static file would win).
 *   FLOW       roof-check.js EXECUTED in a vm with a fake DOM and a scripted
 *              fetch, in the order a visitor takes it:
 *                address -> FREE storm history (no lead, no AI yet)
 *                -> roof answers -> contact -> the lead is saved FIRST
 *                (kind 'inspect', source '/roof-check') -> only then the AI
 *                note -> the result with the storm table.
 *   MARKUP     parsed, not grepped: the new "water stains inside" sign tile,
 *              the optional email, the AI-drafted label, one roof-check card
 *              on /free-tools.
 *
 * Zero deps. Run: node tests/roof-check-merge-2026-11-25.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const K = require('./lib/src-kit');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };

const LAT = 39.087, LON = -84.39;
const STORMS = {
  counts: { total: 4, hail: 2, wind: 2, tornado: 0, stormDays: 3 }, maxHail: 1.75, years: 5, radiusMi: 30,
  source: 'NWS Local Storm Reports (NOAA) via Iowa Environmental Mesonet',
  events: [
    { date: '2026-05-17T00:25:00Z', type: 'hail', magnitude: 1.75, unit: 'in', distanceMi: 3, severity: 'severe' },
    { date: '2026-04-02T19:00:00Z', type: 'wind', magnitude: 60, unit: 'mph', distanceMi: 8, severity: 'significant' },
  ],
};

// A fake page: every id resolves to a small element; clicks go through the
// script's one delegated document listener.
function loadPage(opts) {
  const o = opts || {};
  const els = {}; let active = null; let clickHandler = null;
  const log = [];                       // ordered record of side effects
  const events = [];
  function el(id) {
    if (!els[id]) {
      let text = '', html = '';
      els[id] = {
        id, value: '', checked: false, hidden: false, disabled: false, style: {}, dataset: {}, kids: [],
        classList: { add(c) { if (c === 'active') active = id; }, remove() {} },
        get textContent() { return text; }, set textContent(v) { text = String(v); },
        get innerHTML() { return html; }, set innerHTML(v) { html = String(v); },
        appendChild(c) { this.kids.push(c); return c; }, addEventListener() {}, setAttribute() {},
        querySelector() { return null; }, querySelectorAll() { return []; }, focus() {},
        get childElementCount() { return 0; },
      };
    }
    return els[id];
  }
  const doc = {
    readyState: 'complete',
    getElementById: (id) => (/^(lf-css|lf-js|rc-map)$/.test(id) ? null : el(id)),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener(t, fn) { if (t === 'click') clickHandler = fn; },
    createElement() { return { style: {}, setAttribute() {} }; },
    head: { appendChild() {} },
  };
  const win = {
    __NBD_STORM_API: '/api/storm-report', scrollTo() {},
    gtag(type, name, params) { events.push({ name, params }); },
    submitPublicLead: (kind, payload) => { log.push({ what: 'lead', kind, payload }); return Promise.resolve(o.leadResult || { ok: true, id: 'L1' }); },
  };
  win.window = win;
  const sandbox = {
    window: win, document: doc, console,
    fetch: (u, init) => {
      const url = String(u);
      if (/publicFunnelAI/.test(url)) { log.push({ what: 'ai', body: JSON.parse(init.body) }); return Promise.resolve({ ok: true, json: () => Promise.resolve({ text: 'Pat, here is my take.' }) }); }
      if (/\/api\/storm-report/.test(url)) { log.push({ what: 'storms', url }); return o.storms ? o.storms() : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(STORMS) }); }
      log.push({ what: 'other', url });
      return Promise.reject(new Error('offline'));
    },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'docs/assets/js/roof-check.js'), 'utf8'), sandbox, { filename: 'roof-check.js' });
  const act = (action) => clickHandler({ target: { closest: (sel) => (sel === '[data-action]' ? { dataset: { action } } : null) } });
  const step = (n) => clickHandler({ target: { closest: (sel) => (sel === '[data-step]' ? { dataset: { step: String(n) } } : null) } });
  win._rcAc = [{ display_name: '12 Elm St, Goshen, OH 45122', lat: String(LAT), lon: String(LON) }];
  clickHandler({ target: { closest: (sel) => (sel.indexOf('rc-ac-item') >= 0 ? { dataset: { idx: '0' } } : null) } });
  return { el, act, step, log, events, win, get active() { return active; } };
}

(async () => {
  console.log('\nREDIRECTS — the three old tools land on /roof-check');
  {
    const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
    const hosting = [].concat(fb.hosting)[0];
    const red = hosting.redirects || [];
    for (const src of ['/storm-check', '/storm-check.html', '/roof-score', '/roof-score.html', '/storm-report', '/storm-report.html']) {
      const r = red.find((x) => x.source === src);
      ok(src + ' -> 301 /roof-check', !!r && r.destination === '/roof-check' && r.type === 301, r);
    }
    ok('the old pages are deleted (a static file would win over the redirect)',
      ['storm-check.html', 'roof-score.html', 'storm-report.html'].every((f) => !fs.existsSync(path.join(ROOT, 'docs', f))));
    ok('…and their scripts too', ['storm-check.js', 'roof-score.js', 'storm-report-page.js'].every((f) => !fs.existsSync(path.join(ROOT, 'docs/assets/js', f))));
    ok('the storm-history API rewrite is kept (/roof-check reads it)', (hosting.rewrites || []).some((x) => x.source === '/api/storm-report' && x.function && x.function.functionId === 'stormReport'));
  }

  console.log('\nFLOW — the free storm history comes first, with no lead and no AI');
  const p = loadPage();
  p.act('generate'); await settle();
  ok('Check opens the free storm history', p.active === 'rc-teaser', p.active);
  ok('…with the real numbers', p.el('rc-teaser-headline').textContent === 'We found 4 storm events near this address' && /2 hail/.test(p.el('rc-teaser-chips').innerHTML), p.el('rc-teaser-headline').textContent);
  ok('…fetched for the picked point', p.log.some((x) => x.what === 'storms' && /lat=39\.087&lon=-84\.39/.test(x.url)));
  ok('nothing is saved and no AI runs before the visitor gives contact details',
    !p.log.some((x) => x.what === 'lead' || x.what === 'ai'), p.log.map((x) => x.what));

  console.log('\nFLOW — roof answers are required where they matter');
  p.step(3);
  ok('"Get Joe\'s take" opens the roof questions', p.active === 'rc-step3', p.active);
  p.step(4);
  ok('Continue without a roof age stays put', p.active === 'rc-step3', p.active);
  p.win.__nbdRoofCheck.state.roofAge = '20+';
  p.win.__nbdRoofCheck.state.signs = ['leak', 'dents'];
  p.step(4);
  ok('with an age it moves to contact', p.active === 'rc-step4', p.active);

  console.log('\nFLOW — contact: a bad phone saves nothing');
  p.el('rc-firstName').value = 'Pat'; p.el('rc-phone').value = '555-01';
  p.act('submit'); await settle();
  ok('a short phone is refused with a plain message', /10-digit phone/.test(p.el('rc-contact-err').textContent) && !p.log.some((x) => x.what === 'lead'));
  p.el('rc-phone').value = '(513) 555-0101'; p.el('rc-email').value = 'not-an-email';
  p.act('submit'); await settle();
  ok('a typed email that is not one is refused (it is optional, so blank would pass)', /doesn.t look right/.test(p.el('rc-contact-err').textContent) && !p.log.some((x) => x.what === 'lead'));

  console.log('\nFLOW — the lead is saved FIRST, then the AI note, then the result');
  p.el('rc-email').value = 'pat@example.com';
  p.el('rc-consent').checked = true;
  p.act('submit'); await settle();
  const iLead = p.log.findIndex((x) => x.what === 'lead'), iAi = p.log.findIndex((x) => x.what === 'ai');
  ok('submitPublicLead ran, then the AI call (never before)', iLead !== -1 && iAi > iLead, p.log.map((x) => x.what));
  const lead = (p.log[iLead] || {}).payload || {};
  ok('kind "inspect", source "/roof-check"', p.log[iLead] && p.log[iLead].kind === 'inspect' && lead.source === '/roof-check', lead.source);
  ok('name, phone, typed email, consent and the storm point ride along',
    lead.name === 'Pat' && lead.phone === '(513) 555-0101' && lead.email === 'pat@example.com' && lead.tcpaConsent === true && lead.lat === LAT && lead.lon === LON, lead);
  ok('the story carries the storm numbers in the email\'s shape plus the roof answers',
    lead.story === 'ROOF CHECK | 4 events/5yr (2 hail, 2 wind, 0 tornado, max 1.75″) | roof age: 20+ (asphalt) | signs: leak, dents', lead.story);
  ok('a follow-up grant is asked for (the optional details step)', lead.wantsFollowUp === true);
  const ai = (p.log[iAi] || {}).body || {};
  ok('the AI gets structured answers only (no prompt, no storm text)', ai.kind === 'stormCheck' && ai.roofAge === '20+' && Array.isArray(ai.signs) && !('prompt' in ai), ai);
  ok('the result opens', p.active === 'rc-result', p.active);
  ok('…the verdict recommends an inspection, never a claim outcome',
    /free inspection/i.test(p.el('rc-result-headline').textContent) && !/claimable|will (cover|pay)|approved/i.test(p.el('rc-result-headline').textContent + ' ' + p.el('rc-result-detail').textContent),
    p.el('rc-result-headline').textContent);
  ok('…the water-stains sign gets its own plain sentence', /Water stains inside mean water is getting in somewhere/.test(p.el('rc-result-detail').textContent), p.el('rc-result-detail').textContent);
  ok('…the official-records line names the counts', /Official records show 4 storm events/.test(p.el('rc-result-data').textContent), p.el('rc-result-data').textContent);
  ok('…Joe\'s take is the AI text', p.el('rc-result-take').textContent === 'Pat, here is my take.');
  ok('…the storm table is on the result', /rc-tag rc-hail/.test(p.el('rc-rep-rows').innerHTML) && /storm events/.test(p.el('rc-rep-summary').innerHTML));
  ok('…no "could not auto-save" warning', p.el('rc-result-warn').style.display !== 'block');
  const names = p.events.map((e) => e.name);
  ok('GA: generate -> history -> questions -> contact -> submit -> complete, in order',
    ['roof_check_generate', 'roof_check_history', 'roof_check_questions', 'roof_check_contact', 'roof_check_submit', 'roof_check_complete'].every((n, i, a) => names.indexOf(n) !== -1 && (i === 0 || names.indexOf(n) > names.indexOf(a[i - 1]))), names);

  console.log('\nFLOW — a lead that fails to save still shows the result, with the call/text warning');
  {
    const q = loadPage({ leadResult: { ok: false } });
    q.act('generate'); await settle();
    q.win.__nbdRoofCheck.state.roofAge = '5-10';
    q.el('rc-firstName').value = 'Sam'; q.el('rc-phone').value = '5135550102';
    q.act('submit'); await settle();
    const warn = q.el('rc-result-warn');
    ok('result shown with the warning, the number a tap-to-call link', q.active === 'rc-result' && warn.style.display === 'block'
      && /couldn.t auto-save/.test(warn.textContent) && warn.kids.some((k) => k.href === 'tel:+18594207382' && k.textContent === '(859) 420-7382'), { text: warn.textContent, kids: warn.kids });
    ok('no email key when none was typed', !('email' in (q.log.find((x) => x.what === 'lead') || {}).payload));
  }

  console.log('\nMARKUP — parsed');
  {
    const doc = K.parseTags(K.read('docs/roof-check.html'));
    const signs = doc.$$('[data-group="signs"] .rc-tile').map((t) => t.attrs['data-value'] + ':' + t.text.trim());
    ok('the signs include "Water stains on a ceiling or wall inside" (value leak, which the AI allowlist knows)', signs.includes('leak:Water stains on a ceiling or wall inside'), signs);
    ok('Roof Score\'s extras are gone (no moisture / last-inspection groups, no score)', !doc.$('[data-group="moisture"]') && !doc.$('[data-group="lastInspect"]') && !doc.$('[data-group="stormWhen"]'));
    const email = doc.byId('rc-email');
    ok('the contact email is optional (no required attribute, labelled optional)', !!email && !email.has('required') && /optional/i.test(doc.byId('rc-step4').text));
    const take = doc.$('.rc-take');
    ok('the AI note box says it is AI-drafted and Joe hasn\'t seen the roof', !!take && /AI-drafted/.test(take.text) && /hasn(&#8217;|’|')t seen your roof/.test(take.text));
    ok('canonical is /roof-check', doc.$$('link').some((l) => l.attrs.rel === 'canonical' && l.attrs.href === 'https://nobigdealwithjoedeal.com/roof-check'));
    const tools = K.parseTags(K.read('docs/free-tools/index.html'));
    const cards = tools.$$('a.tool-card').map((a) => a.attrs.href);
    ok('/free-tools shows one Roof Check card and none of the three old ones', cards.filter((h) => h === '/roof-check').length === 1 && !cards.some((h) => /^\/(storm-check|roof-score|storm-report)$/.test(h)), cards);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
