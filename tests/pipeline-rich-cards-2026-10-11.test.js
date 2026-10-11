/**
 * tests/pipeline-rich-cards-2026-10-11.test.js — the Pipeline board's rich
 * card density (CRM style integration C5).
 *
 * Checks:
 *   - PURE: aging heat thresholds (green < 50% of a stage's target, gold to
 *     100%, red at/after it), days-in-stage fallback chain, roof thumbnail
 *     choice (cover, then the earliest "before" shot; http(s) only, thumb
 *     variant preferred), squares, Insurance/Retail, hail chip, due labels,
 *     next step, and the strip's Open / Weighted / Going cold numbers;
 *   - the card block escapes lead text, carries no inline handler / style /
 *     token URL, and prints nothing for won or lost cards;
 *   - the strip labels pipeline money "projected" and never "revenue";
 *   - wiring: setKanbanDensity accepts `rich` and announces the change,
 *     crm-pipeline.js asks the module for the block and the strip, and
 *     dashboard.html loads the script + css;
 *   - the css paints from tokens (no hex) and every var(--x) it reads is a
 *     token some theme/foundation file defines.
 *
 * Zero deps. Run: node tests/pipeline-rich-cards-2026-10-11.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// Stage helpers the CRM loads before the board paints (crm-stages.js).
const JOB = ['job_created', 'permit_pulled', 'materials_ordered', 'materials_delivered', 'crew_scheduled', 'install_in_progress'];
const WON = ['closed', 'install_complete', 'final_photos', 'final_payment', 'deductible_collected', 'collections', 'warranty_claim'];
globalThis.stageRole = (k) => (k === 'lost' ? 'lost' : WON.includes(k) ? 'won' : JOB.includes(k) ? 'job' : k === 'new' ? 'new' : 'active');
globalThis.isJobStage = (k) => JOB.includes(k) || WON.includes(k) || k === 'contract_signed';

const R = require('../docs/pro/js/pipeline-rich-cards.js');
const P = R._pure;
const NOW = new Date(2026, 9, 11, 14, 0, 0).getTime();      // Oct 11 2026, afternoon
const daysAgo = (n) => new Date(2026, 9, 11 - n, 9, 0, 0);

console.log('RICH CARDS — aging heat');
{
  ok('0 days in a 7-day stage is ok, no segments filled', P.heatFor(0, 7).level === 'ok' && P.heatFor(0, 7).filled === 0);
  ok('3 of 7 days (43%) is still ok', P.heatFor(3, 7).level === 'ok');
  ok('4 of 7 days (57%) is warn', P.heatFor(4, 7).level === 'warn');
  ok('6 of 7 days is warn, 7 of 7 is late', P.heatFor(6, 7).level === 'warn' && P.heatFor(7, 7).level === 'late');
  ok('the bar never exceeds 10 segments', P.heatFor(70, 7).filled === 10);
  ok('a deal with any days shows at least one segment', P.heatFor(1, 60).filled === 1);
  ok('each stage has its own target; unknown / custom stages get the default', P.slaFor('new') === 2 && P.slaFor('permit_pulled') === 14 && P.slaFor('custom_x') === R.SLA_DEFAULT);
  const l = { stageStartedAt: daysAgo(5), updatedAt: daysAgo(1), createdAt: daysAgo(30) };
  ok('days in stage reads stageStartedAt first', P.stageDays(l, NOW) === 5);
  ok('...then updatedAt, then createdAt', P.stageDays({ updatedAt: daysAgo(2), createdAt: daysAgo(30) }, NOW) === 2 && P.stageDays({ createdAt: daysAgo(30) }, NOW) === 30);
  ok('a Firestore Timestamp-shaped value works', P.stageDays({ stageStartedAt: { toDate: () => daysAgo(4) } }, NOW) === 4);
  ok('no usable date → null (no bar)', P.stageDays({}, NOW) === null);
}

console.log('\nRICH CARDS — chips, squares, thumbnail');
{
  ok('squares: the aerial figure, else sqft / 100', P.squaresOf({ measurementSquares: 32.46 }) === 32.5 && P.squaresOf({ measurementSqft: 2410 }) === 24.1 && P.squaresOf({}) === null);
  ok('Insurance when insurance or unset (NBD default)', P.typeChip({ jobType: 'insurance' }).label === 'Insurance' && P.typeChip({}).label === 'Insurance');
  ok('cash / finance / service read Retail', ['cash', 'finance', 'service'].every((j) => P.typeChip({ jobType: j }).label === 'Retail'));
  ok('hail chip only when the cron stamped a hit', P.hailChip({ hailHit: { sizeInches: 1.25 } }).label === 'Hail verified' && P.hailChip({}) === null && P.hailChip({ hailHit: { sizeInches: 0 } }) === null);
  const photos = [
    { id: 'p3', url: 'https://x/p3.jpg', phase: 'After', createdAt: daysAgo(1) },
    { id: 'p2', url: 'https://x/p2.jpg', thumbUrl: 'https://x/p2_t.webp', phase: 'Before', createdAt: daysAgo(6) },
    { id: 'p1', url: 'https://x/p1.jpg', phase: 'During', createdAt: daysAgo(9) },
  ];
  ok('thumbnail = the earliest "before" shot, its 200px variant', P.pickThumb({}, photos, true) === 'https://x/p2_t.webp');
  ok('the photo style asks for the full image', P.pickThumb({}, photos, false) === 'https://x/p2.jpg');
  ok('the rep\'s cover wins', P.pickThumb({ coverPhotoUrl: 'https://x/cover.jpg' }, photos, true) === 'https://x/cover.jpg');
  ok('no "before" shot → the earliest photo', P.pickThumb({}, [photos[0], photos[2]], true) === 'https://x/p1.jpg');
  ok('non-http(s) urls are never used', P.pickThumb({}, [{ url: 'javascript:alert(1)' }, { url: 'data:image/png;base64,AAAA' }], true) === '' && P.pickThumb({ coverPhotoUrl: 'javascript:1' }, [], true) === '');
  ok('initials: two letters from a name, one from a single word, none from nothing',
    P.initialsOf('Joe Deal') === 'JD' && P.initialsOf('casey') === 'C' && P.initialsOf('') === '' && P.initialsOf('pat.lee@x.com') === 'PL');
}

console.log('\nRICH CARDS — due + next step');
{
  ok('due labels', P.dueInfo('2026-10-11', NOW).text === 'Due today' && P.dueInfo('2026-10-12', NOW).text === 'Due tomorrow'
    && P.dueInfo('2026-10-20', NOW).text === 'Due Oct 20' && P.dueInfo('2026-10-08', NOW).text === '3d overdue');
  ok('"YYYY-MM-DD" is a LOCAL day (not UTC midnight)', P.dueInfo('2026-10-11', new Date(2026, 9, 11, 0, 5).getTime()).text === 'Due today');
  const tasks = [
    { title: 'Send supplement', dueDate: '2026-10-15', done: false },
    { title: 'Call adjuster', dueDate: '2026-10-12', done: false },
    { title: 'Old', dueDate: '2026-10-01', done: true },
    { title: 'Site visit', dueDate: '2026-10-11', type: 'event' },
  ];
  const n1 = P.nextStep({}, tasks, { label: 'File Claim' }, NOW);
  ok('next step = the earliest-due OPEN task (events and done tasks are not steps)', n1.text === 'Call adjuster' && n1.due.text === 'Due tomorrow' && n1.kind === 'task');
  const n2 = P.nextStep({ followUp: '2026-10-09' }, [], { label: 'File Claim' }, NOW);
  ok('no tasks → the stage\'s action with the follow-up date', n2.text === 'File Claim' && n2.due.text === '2d overdue');
  ok('nothing at all → "No next step"', P.nextStep({}, [], null, NOW).kind === 'none');
}

console.log('\nRICH CARDS — board strip numbers');
{
  const cards = [
    { id: 'a', _stageKey: 'inspected', jobValue: 10000, stageStartedAt: daysAgo(1) },
    { id: 'b', _stageKey: 'estimate_submitted', jobValue: '$20,000', stageStartedAt: daysAgo(9) },   // late (7d)
    { id: 'c', _stageKey: 'contract_signed', jobValue: 30000, stageStartedAt: daysAgo(40) },          // a job: not open
    { id: 'd', _stageKey: 'lost', jobValue: 50000, stageStartedAt: daysAgo(40) },
    { id: 'e', _stageKey: 'new', jobValue: 0, stageStartedAt: daysAgo(3) },                           // late (2d)
  ];
  const prob = (l, k) => ({ inspected: 0.25, estimate_submitted: 0.7, new: 0.05 }[k] || 0);
  const s = P.summarize(cards, { prob, now: NOW });
  ok('Open counts only deals still in play', s.openCount === 3);
  ok('Open value is the sum of their job values ($ strings read)', s.openValue === 30000);
  ok('Weighted = sum(value x stage odds)', Math.abs(s.weightedValue - (10000 * 0.25 + 20000 * 0.7)) < 1e-6);
  ok('Going cold = open deals past their stage target', s.coldCount === 2 && s.coldIds.sort().join() === 'b,e');
  ok('a signed contract 40 days old is a job, never "going cold"', s.coldIds.indexOf('c') === -1);
  ok('money formats K / M', P.fmtMoney(412000) === '$412K' && P.fmtMoney(1250000) === '$1.3M' && P.fmtMoney(950) === '$950');
}

console.log('\nRICH CARDS — the card block');
{
  const lead = {
    id: 'L"1', jobType: 'insurance', userId: 'uid-1', hailHit: { sizeInches: 1.5 }, measurementSquares: 28,
    stageStartedAt: daysAgo(12), coverPhotoUrl: 'https://x/c.jpg',
  };
  const html = P.cardBlock(lead, {
    stageKey: 'estimate_submitted', now: NOW, photos: [], style: 'rich',
    tasks: [{ title: '<img src=x onerror=alert(1)>', dueDate: '2026-10-12' }], preferred: null,
  });
  ok('squares, type chip, hail chip and heat all print', /28 SQ/.test(html) && />Insurance</.test(html) && />Hail verified</.test(html) && /kr-heat-late/.test(html));
  ok('12 days in a 7-day stage reads late and says so for assistive tech', /12 days in this stage/.test(html));
  ok('task text and lead ids are escaped', !/<img src=x/.test(html) && /&lt;img src=x/.test(html) && /data-kr-lead="L&quot;1"/.test(html));
  const clean = P.cardBlock(lead, { stageKey: 'estimate_submitted', now: NOW, photos: [], style: 'rich', tasks: [{ title: 'Call adjuster', dueDate: '2026-10-12' }] });
  ok('no inline handler, no style attribute, no token URL', clean.length > 200 && !/\son[a-z]+\s*=/i.test(clean) && !/\sstyle\s*=/i.test(clean) && !/[?&]token=/.test(clean));
  ok('positive control: the handler regex does trip on live markup', /\son[a-z]+\s*=/i.test('<img src=x onerror=alert(1)>'));
  ok('the thumbnail is the cover, lazy', /<img src="https:\/\/x\/c\.jpg"[^>]*loading="lazy"/.test(html));
  const won = P.cardBlock({ id: 'w', stageStartedAt: daysAgo(90) }, { stageKey: 'closed', now: NOW });
  ok('a closed card has no heat bar and no next step', !/kr-heat/.test(won) && !/kr-next/.test(won));
  const photo = P.cardBlock(lead, { stageKey: 'inspected', now: NOW, photos: [], style: 'photo' });
  ok('the photo style tags the block', /kr-block kr-photo/.test(photo));
}

console.log('\nRICH CARDS — wording + wiring');
{
  const src = strip(read('docs/pro/js/pipeline-rich-cards.js'));
  ok('the strip says "projected" (positive control)', /projected/.test(src));
  ok('and never labels pipeline money "revenue"', !/revenue/i.test(src));
  const ui = read('docs/pro/js/dashboard-ui.js');
  ok('setKanbanDensity accepts rich', /\['compact', 'comfortable', 'spacious', 'rich'\]\.includes\(d\)/.test(ui));
  ok('...and announces the change for the board', /nbd:density-changed/.test(ui));
  ok('the density cycle includes rich', /order = \['compact', 'comfortable', 'spacious', 'rich'\]/.test(ui));
  const pipe = read('docs/pro/js/crm-pipeline.js');
  ok('buildCard asks the module for the block', /NBDPipelineRich\.blockFor\(l,/.test(pipe) && /\$\{richBlock\}/.test(pipe));
  ok('renderLeads hands the module the cards for the strip', /NBDPipelineRich\.afterRender\(list\)/.test(pipe));
  const html = read('docs/pro/dashboard.html');
  ok('dashboard.html loads the script (defer) before crm-pipeline.js and links the css',
    /<script defer src="js\/pipeline-rich-cards\.js\?v=\d+"><\/script>\s*<script defer src="js\/crm-pipeline\.js/.test(html)
    && /css\/pipeline-rich-cards\.css/.test(html));
  ok('Settings > Card Density offers Rich', /data-density="rich"[^>]*data-arg="rich"/.test(html));
}

console.log('\nRICH CARDS — css tokens');
{
  const css = strip(read('docs/pro/css/pipeline-rich-cards.css'));
  ok('no hex colour literal', (css.match(/#[0-9a-f]{3,8}\b/gi) || []).length === 0);
  const used = [...new Set((css.match(/var\(\s*(--[a-z0-9-]+)/g) || []).map((s) => s.replace(/var\(\s*/, '')))];
  const defined = (name) => ['docs/pro/css/theme-system.css', 'docs/pro/css/dashboard-app.css', 'docs/pro/css/ui-primitives.css', 'docs/pro/css/theme-bridge.css']
    .some((f) => new RegExp(name.replace(/-/g, '\\-') + '\\s*:').test(read(f)));
  const undef = used.filter((t) => !defined(t));
  ok('every custom property it reads is defined by the theme / foundation files (' + used.length + ')', used.length >= 8 && undef.length === 0, undef.join(', '));
  ok('rich-only rules hang off data-density="rich"', /:root\[data-density="rich"\] \.k-card \.kc-email-line/.test(css));
  ok('no transition:all, no !important', !/transition:\s*all/.test(css) && !/!important/.test(css));
}

console.log('\n' + (failed ? 'FAILED ' + failed : 'PASSED ' + passed) + ' (' + passed + ' ok)');
process.exit(failed ? 1 : 0);
