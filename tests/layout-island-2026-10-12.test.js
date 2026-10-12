/**
 * tests/layout-island-2026-10-12.test.js — L04 Island Dock.
 *
 *   1. in play: the PROJECTED pipeline value is every open job's jobValue —
 *      not lost, not won, not in production, not deleted — and reads legacy
 *      "$45,000" text; the same rule as the Pipeline header's "$N pipeline"
 *   2. wording: the headline says projected / not collected; "revenue" never
 *      labels it (revenue = collected money only)
 *   3. timeline: past / now / next / later, exactly one marker
 *   4. registration: lazy assets + kit, every surface, resolvable
 *   5. css: scoped, tokens-only, glass has a no-wallpaper fallback, and drops
 *      under prefers-contrast: more; Reduce Motion drops transitions
 *   6. nothing is written or sent; no inline styles/handlers
 *   7. job view hero: cover > earliest inspection shot > earliest photo, and
 *      only when this screen's resolved layout is island
 *
 * Run: node tests/layout-island-2026-10-12.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const L = require(path.join(ROOT, 'docs/pro/js/layouts/island.js'));
const J = require(path.join(ROOT, 'docs/pro/js/layouts/island-job.js'));
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
const JS = read('docs/pro/js/layouts/island.js');
const JS_CODE = strip(JS);

console.log('\n1. in play (projected)');
{
  const leads = [
    { id: 'a', stage: 'new', jobValue: 10000 },
    { id: 'b', stage: 'estimate_sent', jobValue: '$45,000' },
    { id: 'c', stage: 'lost', jobValue: 99999 },
    { id: 'd', stage: 'closed', jobValue: 88888 },
    { id: 'e', stage: 'new', jobValue: 5000, deleted: true },
    { id: 'f', stage: 'custom', _stageRole: 'won', jobValue: 7777 },
    { id: 'g', stage: 'custom2', _stageRole: 'job', jobValue: 6666 },
    { id: 'h', stage: 'inspected', jobValue: 2500 },
    { id: 'i', stage: 'new' },
    null,
  ];
  const r = L.inPlay(leads);
  ok('sums open jobs only (10,000 + 45,000 + 2,500)', r.value === 57500, JSON.stringify(r));
  ok('counts the open jobs (a, b, h, i)', r.count === 4, JSON.stringify(r));
  ok('positive control: a single open job of 1000 reads 1000', L.inPlay([{ stage: 'new', jobValue: 1000 }]).value === 1000);
  ok('an empty book is $0, not NaN', L.inPlay([]).value === 0 && L.inPlay(null).count === 0 && L.fmtBig(NaN) === '$0');
  ok('the records hook (one card per job) feeds the sum', L.inPlay([{ id: 'x' }], { records: () => [{ stage: 'new', jobValue: 3 }, { stage: 'new', jobValue: 4 }] }).value === 7);
  ok('a records hook that throws falls back to the leads', L.inPlay([{ stage: 'new', jobValue: 9 }], { records: () => { throw new Error('x'); } }).value === 9);
  ok('fmtBig groups thousands', L.fmtBig(126043) === '$126,043' && L.fmtBig(0) === '$0' && L.fmtBig(1234567.4) === '$1,234,567');
  ok('fmtShort', L.fmtShort(126043) === '$126K' && L.fmtShort(1250000) === '$1.3M' && L.fmtShort(950) === '$950');
}

console.log('\n2. wording');
{
  const html = (JS_CODE.match(/function heroHtml[\s\S]*?\n  }\n/) || [''])[0];
  ok('heroHtml located', html.length > 100);
  ok('headline is labelled projected', /In play &middot; projected/.test(html));
  ok('says it is not money collected', /projected value, not money collected/.test(html));
  ok('never labels the number "revenue"', !/revenue/i.test(JS_CODE) && !/revenue/i.test(strip(read('docs/pro/css/layouts/island.css'))));
}

console.log('\n3. timeline');
{
  const NOW = Date.UTC(2026, 9, 12, 15, 0, 0);
  const plan = { appointments: [
    { key: 'k3', name: 'Later', sortMs: NOW + 5 * 3600000 },
    { key: 'k1', name: 'Done', sortMs: NOW - 3 * 3600000 },
    { key: 'k2', name: 'Now', sortMs: NOW - 20 * 60000 },
    { key: 'k4', name: 'Next', sortMs: NOW + 1 * 3600000 },
  ] };
  const t = L.timeline(plan, NOW);
  ok('time order', t.rows.map((r2) => r2.key).join() === 'k1,k2,k4,k3');
  ok('past / now / later / later', t.rows.map((r2) => r2.state).join() === 'past,now,later,later', t.rows.map((r2) => r2.state).join());
  ok('exactly one marker', t.rows.filter((r2) => r2.state === 'now' || r2.state === 'next').length === 1);
  ok('left / done counts', t.left === 3 && t.done === 1);
  const t2 = L.timeline({ appointments: [{ key: 'z', sortMs: NOW + 600000 }] }, NOW);
  ok('before the first stop, it is "next"', t2.rows[0].state === 'next');
  ok('no plan is an empty list, not a throw', L.timeline(null, NOW).rows.length === 0);
  ok('an appointment over by its length is past', L.timeline({ appointments: [{ key: 'q', sortMs: NOW - 2 * 3600000, durationMs: 3600000 }] }, NOW).rows[0].state === 'past');
}

console.log('\n4. registration + nav');
{
  const d = R.get('island');
  ok('registered for every surface with lazy assets + kit', d && d.surfaces.length === 3 && d.script === 'js/layouts/island.js' && d.css === 'css/layouts/island.css' && d.needs.script[0] === 'js/layouts/kit.js' && d.needs.css[0] === 'css/layouts/kit.css');
  ok('assets exist on disk', !!d && fs.existsSync(path.join(ROOT, 'docs/pro', d.script)) && fs.existsSync(path.join(ROOT, 'docs/pro', d.css)));
  ok('supports glass + wallpaper', d && d.supports.glass === true && d.supports.wallpaper === true);
  ok('resolves from a user pick on desktop and phone', R.resolve({ surface: 'desktop', user: { id: 'island' } }).id === 'island' && R.resolve({ surface: 'phone', user: { byDevice: { phone: 'island' } } }).id === 'island');
  ok('a company lock to island wins over the user', R.resolve({ surface: 'tablet', user: { id: 'focus' }, company: { defaultLayout: 'island', locked: true } }).id === 'island');
  const reg = strip(read('docs/pro/js/layout-system.js'));
  ok('registered inside the one deferred file, not a new tag', /id: 'island'/.test(reg));
  ok('pill honours what the sidebar offers', L.pillItems((id) => id !== 'calls').every((i) => i.id !== 'calls') && L.pillItems().length === 5);
  ok('dock is New lead / Filter / Sort', L.DOCK.map((d2) => d2.id).join() === 'newlead,filter,sort');
}

console.log('\n5. css');
{
  const raw = read('docs/pro/css/layouts/island.css');
  const css = strip(raw);
  const sels = css.split('}').map((r2) => r2.split('{')).filter((p) => p.length > 1).map((p) => p[0].trim()).filter(Boolean).filter((s) => !/^@/.test(s));
  const top = (s) => { const out = []; let d = 0, cur = ''; for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  const scoped = (s) => top(s).every((p) => /^(html\[data-layout="island"\]|:root\[data-motion="reduce"\]\[data-layout="island"\])/.test(p.trim()));
  ok('every rule is scoped to the island layout', sels.length > 40 && sels.every(scoped), sels.filter((s) => !scoped(s)).join(' | '));
  const colours = css.replace(/#ffffff|#000000/g, '').replace(/var\(--accent-fg,\s*#fff\)/g, '');
  ok('no hard-coded colours (tokens; white/black only inside color-mix)', !/#[0-9a-f]{3,8}\b/i.test(colours));
  ok('no wallpaper -> soft --glow2 wash on --bg', /:not\(\.my-skin-wallpaper\) body[\s\S]*?var\(--glow2/.test(css) && /background-color:\s*var\(--bg\)/.test(css));
  ok('islands read the Surface style dials', /var\(--glass-blur/.test(css));
  ok('active item is tinted --og', /\.isl-item\.isl-active\s*\{[^}]*background:\s*var\(--og\)/.test(css));
  ok('pill + dock are --s at 85%', /color-mix\(in srgb, var\(--s\) var\(--isl-bar-frost\), transparent\)/.test(css) && /--isl-bar-frost:\s*85%/.test(css));
  const contrast = (css.match(/@media \(prefers-contrast: more\)\s*\{[\s\S]*$/) || [''])[0];
  ok('prefers-contrast: more drops blur + translucency on pill, dock, islands, lanes', /\.isl-pill-in/.test(contrast) && /\.isl-dock-in/.test(contrast) && /\.kanban-col/.test(contrast) && /backdrop-filter:\s*none/.test(contrast) && /background-color:\s*var\(--s2\)/.test(contrast));
  ok('Reduce Motion (setting and OS) drops transitions', /data-motion="reduce"\]\[data-layout="island"\] \.isl-item[\s\S]*?transition:\s*none/.test(css) && /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition:\s*none/.test(css));
  ok('the board snaps to stage lanes', /scroll-snap-type:\s*x mandatory/.test(css) && /scroll-snap-align:\s*start/.test(css));
  ok('sidebar and bottom tab bar are gone', /\.sidebar,[\s\S]*?#mobile-nav\s*\{\s*display:\s*none\s*!important/.test(css));
  ok('tap targets ride --tap', /--isl-bar-h:\s*calc\(var\(--tap\)/.test(css));
  const jobCss = strip(read('docs/pro/css/layouts/island-job.css'));
  const jsels = jobCss.split('}').map((r2) => r2.split('{')).filter((p) => p.length > 1).map((p) => p[0].trim()).filter(Boolean).filter((s) => !/^@/.test(s));
  ok('job css is scoped under html[data-island-job]', jsels.length > 3 && jsels.every((s) => s.split(',').every((p) => /^html\[data-island-job\]/.test(p.trim()))), jsels.join(' | '));
}

console.log('\n6. nothing written, sent, or inline');
{
  ok('no Firestore writes, fetches or sends', !/\b(setDoc|updateDoc|addDoc|deleteDoc|fetch\s*\(|XMLHttpRequest|sendBeacon|httpsCallable)/.test(JS_CODE));
  ok('no inline style attributes or on* handlers in generated markup', !/style="/.test(JS_CODE) && !/\son[a-z]+="/.test(JS_CODE));
  ok('no eval / Function', !/\beval\s*\(|new Function/.test(JS_CODE));
  ok("Filter / Sort click the Pipeline toolbar's own buttons", /pipelineButton\('crmFiltersBtn'\)/.test(JS_CODE) && /pipelineButton\('engagementSortBtn'/.test(JS_CODE));
  ok('New lead runs openLeadModal', /W\.openLeadModal\(\)/.test(JS_CODE));
  ok('the tag in customer.html is deferred', /<script defer src="js\/layouts\/island-job\.js\?v=1"><\/script>/.test(read('docs/pro/customer.html')));
  ok('no new dashboard.html tag for the layout', !/layouts\/island/.test(read('docs/pro/dashboard.html')));
  ok('positive control: the write detector sees a write', /\b(setDoc|fetch\s*\()/.test('setDoc(x)'));
}

console.log('\n7. job view hero');
{
  const photos = [
    { id: 'p3', url: 'https://x.test/3.jpg', createdAt: 3000 },
    { id: 'p1', url: 'https://x.test/1.jpg', createdAt: 1000 },
    { id: 'p2', url: 'https://x.test/2.jpg', createdAt: 2000, phase: 'before' },
    { id: 'p0', url: 'javascript:alert(1)', createdAt: 10 },
  ];
  ok('cover photo wins', J.pickHero({ coverPhotoUrl: 'https://x.test/cover.jpg' }, photos) === 'https://x.test/cover.jpg');
  ok('else the earliest inspection / before shot', J.pickHero({}, photos) === 'https://x.test/2.jpg');
  ok('else the earliest photo', J.pickHero({}, photos.filter((p) => !p.phase)) === 'https://x.test/1.jpg');
  ok('no photos -> no hero', J.pickHero({}, []) === '' && J.pickHero(null, null) === '');
  ok('a non-http url is never used', J.pickHero({}, [photos[3]]) === '' && J.pickHero({ coverPhotoUrl: 'javascript:1' }, []) === '');
  const cache = { byDevice: { phone: 'island', desktop: 'classic' } };
  ok('only when this screen resolved to island', J.wantsIsland(cache, 390, false) === true && J.wantsIsland(cache, 1400, false) === false);
  ok('tablet width + touch reads the tablet entry', J.wantsIsland({ byDevice: { tablet: 'island' } }, 900, true) === true && J.wantsIsland({ byDevice: { tablet: 'island' } }, 900, false) === false);
  ok('no cache -> classic', J.wantsIsland(null, 390, false) === false && J.wantsIsland({}, 390, false) === false);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join('; ')); process.exit(1); }
