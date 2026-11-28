/**
 * tests/repair-or-replace-2026-11-28.test.js — the /repair-or-replace quick check.
 *
 * WHAT IT PINS
 *  1. Scoring (docs/assets/js/repair-or-replace.js, run, not read): every
 *     answer table, the three leans and their thresholds, the signs cap, the
 *     overrides (soft decking never reads "repair"; 20+ years worn across the
 *     roof reads "replace"; a young roof with one spot reads "repair"), the
 *     storm and leak notes, "nothing specific" dropping out next to a real
 *     sign, every result ending "An inspection confirms it.", and missing or
 *     unknown answers refusing to score.
 *  2. The page (parsed, not regex-matched): five fieldsets with legends,
 *     native radio/checkbox inputs inside labels, an aria-live result region,
 *     the script external and deferred with no inline script, the noscript
 *     rule hiding the form, the JS-off guide with all three leans and an
 *     /inspect link, canonical, matching visible and schema dates, and no
 *     price or "licensed" anywhere on the page or in the script's strings.
 *  3. It is findable: /free-tools, /services/roof-repair and
 *     /services/roof-replacement link to it, the sitemap lists it, and
 *     llms.txt has an entry.
 *
 * Zero deps. Run: node tests/repair-or-replace-2026-11-28.test.js
 */
'use strict';
const K = require('./lib/src-kit');
const RR = require('../docs/assets/js/repair-or-replace.js');

const T = K.suite('\nREPAIR OR REPLACE — scoring, page structure, links');
const { ok } = T;
const base = { age: '10-15', signs: ['missing'], spread: 'one', repairs: 'none', stay: 'medium' };
const run = (over) => RR.score(Object.assign({}, base, over));

// ── 1. scoring ─────────────────────────────────────────────────────────────
T.section('scoring');
ok('the three leans have the agreed labels', RR.LEANS.repair === 'Likely a repair' && RR.LEANS.inspect === 'Worth an inspection to decide' && RR.LEANS.replace === 'Likely nearing replacement');
ok('thresholds: <=2 repair, >=6 replace', RR.REPAIR_MAX === 2 && RR.REPLACE_MIN === 6);

const young = run({ age: 'under-10' });
ok('young roof, one spot, no repairs → likely a repair', young.lean === 'repair' && young.label === 'Likely a repair', young.points);
const old = run({ age: '20-plus', signs: ['worn', 'granules'], spread: 'wide', repairs: 'several', stay: 'long' });
ok('20+ years, worn across the roof, 2+ repairs, staying → likely nearing replacement', old.lean === 'replace', old.points);
const mid = run({ age: '15-20', signs: ['leak'], spread: 'side', repairs: 'one' });
ok('15–20 years, a leak on one side, one repair → worth an inspection', mid.lean === 'inspect', mid.points);

// every possible answer combination scores, and always ends with the confirm line
let combos = 0, bad = [];
const t = RR.TABLES;
for (const age of Object.keys(t.AGE)) for (const s of Object.keys(t.SIGNS)) for (const spread of Object.keys(t.SPREAD))
  for (const repairs of Object.keys(t.REPAIRS)) for (const stay of Object.keys(t.STAY)) {
    combos++;
    const r = RR.score({ age, signs: [s], spread, repairs, stay });
    if (!RR.LEANS[r.lean] || r.confirm !== 'An inspection confirms it.' || !r.reasons.length) bad.push([age, s, spread, repairs, stay].join('/'));
  }
ok(`all ${combos} single-sign combinations score to a known lean with reasons and "An inspection confirms it."`, combos === 5 * 7 * 4 * 4 * 4 && bad.length === 0, bad.slice(0, 5));

// boundaries: walk points across the thresholds with otherwise neutral answers
const pts = (o) => run(o).points;
ok('boundary: 2 points is still a repair', pts({ age: '15-20', signs: ['missing'], spread: 'one', repairs: 'none', stay: 'medium' }) === 2 && run({ age: '15-20' }).lean === 'repair');
ok('boundary: 3 points tips to inspection', run({ age: '15-20', repairs: 'one' }).points === 3 && run({ age: '15-20', repairs: 'one' }).lean === 'inspect');
const five = run({ age: '20-plus', signs: ['leak'], spread: 'side', repairs: 'none', stay: 'medium' });
const six = run({ age: '20-plus', signs: ['leak'], spread: 'side', repairs: 'one', stay: 'medium' });
ok('boundary: 5 points is inspection, 6 is replacement', five.points === 5 && five.lean === 'inspect' && six.points === 6 && six.lean === 'replace', [five.points, six.points]);

const capped = run({ age: 'under-10', signs: ['leak', 'worn', 'granules', 'soft'], spread: 'side' });
ok('several signs cap at 3 points (one problem, not five)', capped.points === 0 + 3 + 1 + 0 + 0, capped.points);

// overrides
const soft = run({ age: 'under-10', signs: ['soft'], spread: 'one', stay: 'short' });
ok('soft/sagging decking never reads "likely a repair", even on a young roof', soft.lean === 'inspect', soft.lean);
const oldWorn = run({ age: '20-plus', signs: ['worn'], spread: 'wide', repairs: 'none', stay: 'short' });
ok('20+ years with wear across several slopes reads replacement even when selling soon', oldWorn.lean === 'replace', oldWorn.points);
const youngOne = run({ age: 'under-10', signs: ['leak', 'worn'], spread: 'one', repairs: 'several', stay: 'long' });
ok('a young roof with one problem spot and no soft decking reads repair', youngOne.lean === 'repair', youngOne.points);
const selling = run({ age: '20-plus', signs: ['missing'], spread: 'one', stay: 'short' });
const staying = run({ age: '20-plus', signs: ['missing'], spread: 'one', stay: 'long' });
ok('plan to stay moves the lean: selling soon leans repair, staying 10+ leans further toward replacement', selling.lean === 'repair' && staying.points === selling.points + 2 && staying.lean === 'inspect', [selling.points, staying.points]);

// notes
ok('a storm adds the documentation note; a leak adds the call-now note', run({ signs: ['storm'] }).notes.includes('storm') && run({ signs: ['leak'] }).notes.includes('leak') && run({}).notes.length === 0);
const noneMixed = run({ signs: ['none', 'worn'] });
ok('"nothing specific" next to a real sign is dropped, so it can\'t water the sign down', noneMixed.points === run({ signs: ['worn'] }).points);

// refuses half a form
ok('missing answers are listed in form order', RR.missing({}).join() === 'age,signs,spread,repairs,stay');
let threw = 0;
for (const o of [{ age: '' }, { age: '30' }, { signs: [] }, { signs: ['hail'] }, { spread: 'everywhere' }, { repairs: undefined }, { stay: 'forever' }]) {
  try { RR.score(Object.assign({}, base, o)); } catch (e) { threw++; }
}
ok('a missing or unknown answer throws instead of scoring', threw === 7, threw);

// no prices or banned claims in anything the script can show
const shown = [];
for (const k of Object.keys(RR.LEANS)) shown.push(RR.LEANS[k]);
for (const age of Object.keys(t.AGE)) for (const s of Object.keys(t.SIGNS)) for (const spread of Object.keys(t.SPREAD)) {
  const r = RR.score({ age, signs: [s], spread, repairs: 'several', stay: 'long' });
  shown.push(...r.reasons);
}
const shownText = shown.join(' ');
ok('result text never shows a price, "licensed", "cheapest", "half price" or a claim promise', !/\$\s?\d|licensed|cheapest|half price|guarantee[ds]? (approval|coverage)|insurance (will|pays)/i.test(shownText));

// ── 2. the page ────────────────────────────────────────────────────────────
T.section('page');
const doc = K.parseTags(K.read('docs/repair-or-replace.html'));
const form = doc.byId('rr-form');
const sets = form ? form.$$('fieldset') : [];
ok('five fieldsets, each with a legend', sets.length === 5 && sets.every((f) => !!f.$('legend')), sets.length);
ok('the fieldsets ask age, signs, spread, repairs, stay in that order', sets.map((f) => f.attrs['data-q']).join() === 'age,signs,spread,repairs,stay');
const inputs = form ? form.$$('input') : [];
ok('every answer is a native radio/checkbox inside its label (keyboard and screen-reader friendly)', inputs.length >= 20 && inputs.every((i) => /^(radio|checkbox)$/.test(i.attrs.type) && i.parent && i.parent.tag === 'label'));
ok('every input value is one the scoring knows', inputs.every((i) => Object.prototype.hasOwnProperty.call(RR.TABLES[{ age: 'AGE', signs: 'SIGNS', spread: 'SPREAD', repairs: 'REPAIRS', stay: 'STAY' }[i.attrs.name]] || {}, i.attrs.value)));
const res = doc.byId('rr-result');
ok('the result region is aria-live polite with role=status', !!res && res.attrs['aria-live'] === 'polite' && res.attrs.role === 'status');
ok('the form error is role=alert', !!doc.byId('rr-error') && doc.byId('rr-error').attrs.role === 'alert');
const scripts = doc.$$('script');
const tool = scripts.find((s) => /^\/assets\/js\/repair-or-replace\.js(\?v=\d+)?$/.test(s.attrs.src || ''));
ok('repair-or-replace.js is external and deferred', !!tool && tool.has('defer'));
ok('no inline script except JSON-LD', scripts.every((s) => s.attrs.src || s.attrs.type === 'application/ld+json'));
ok('no inline event handlers', doc.all.every((e) => !Object.keys(e.attrs).some((a) => /^on/i.test(a))));
const ns = doc.$$('noscript').map((n) => n.$('style')).filter(Boolean)[0];
ok('with JS off a noscript rule hides the form and the empty result', !!ns && ['#rr-form', '#rr-result'].every((sel) => /^none(!important)?$/.test((K.cssRule(ns.html, sel) || {}).display || '')));
const guide = doc.byId('rr-guide-h') && doc.byId('rr-guide-h').parent;
const guideText = guide ? guide.text : '';
ok('the JS-off guide names all three leans', ['Likely a repair', 'Worth an inspection to decide', 'Likely nearing replacement'].every((l) => guide && guide.$$('h3').some((h) => h.text.trim() === l)));
ok('the guide says an inspection confirms it and links /inspect', /an inspection confirms it/i.test(guideText) && guide.$$('a').some((a) => a.attrs.href === '/inspect'));
ok('canonical is /repair-or-replace', doc.$$('link').some((l) => l.attrs.rel === 'canonical' && l.attrs.href === 'https://nobigdealwithjoedeal.com/repair-or-replace'));
const ld = doc.$$('script').filter((s) => s.attrs.type === 'application/ld+json').map((s) => { try { return JSON.parse(s.html); } catch (e) { return null; } });
const webpage = ld.find((j) => j && j['@type'] === 'WebPage');
const timeEl = doc.$('.nbd-updated time');
ok('visible "Last updated" date matches the WebPage dateModified', !!webpage && !!timeEl && timeEl.attrs.datetime === webpage.dateModified && /^\d{4}-\d{2}-\d{2}$/.test(webpage.dateModified));
const main = doc.$('main');
ok('the page shows no price and never says "licensed"', !!main && !/\$\s?\d/.test(main.text) && !/licensed/i.test(main.text));

// ── 3. findable ────────────────────────────────────────────────────────────
T.section('links');
const linksTo = (rel) => K.parseTags(K.read(rel)).$$('a').some((a) => a.attrs.href === '/repair-or-replace');
ok('/free-tools has a card for it', K.parseTags(K.read('docs/free-tools/index.html')).$$('a.tool-card').some((a) => a.attrs.href === '/repair-or-replace'));
ok('/services/roof-repair links to it', linksTo('docs/services/roof-repair.html'));
ok('/services/roof-replacement links to it', linksTo('docs/services/roof-replacement.html'));
const locs = K.parseTags(K.read('docs/sitemap.xml')).$$('loc').map((l) => l.text.trim());
ok('the sitemap lists it', locs.includes('https://nobigdealwithjoedeal.com/repair-or-replace'));
const llmsLinks = K.read('docs/llms.txt').split('\n').filter((l) => l.startsWith('- [') && l.includes('(https://nobigdealwithjoedeal.com/repair-or-replace)'));
ok('llms.txt has exactly one entry for it', llmsLinks.length === 1);

T.done();
