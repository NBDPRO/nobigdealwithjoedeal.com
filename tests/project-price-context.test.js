/**
 * tests/project-price-context.test.js — older job prices carry an honest
 * "priced in <year>" line (2026-09-27, Joe: "some jobs are years old and
 * unrealistic to match today's pricing scale").
 *
 * The rule lives in scripts/project-price-context.mjs and is tested here with
 * an INJECTED as-of date, so nothing depends on the day this runs:
 *   - a job with a price whose year is more than 12 months before the as-of
 *     date gets the line; the job is dated to Dec 31 of its year (generous)
 *   - a current-year job and an unpriced job never do; a priced LEGACY job
 *     with no year is labelled "Priced before 2025." (Jo, 2026-09-27) — only
 *     the slugs in LEGACY_UNDATED_PRICED; any other live priced job with no
 *     year fails yearRuleErrors (and so the build), naming the slug
 *   - roofing jobs link the roof cost guide; others their own service hub
 * Then the stamped tree is checked against the same rule at the as-of date
 * build-projects.mjs uses by default (newest published), and the CLI's
 * --as-of injection is shown to actually move the output.
 *
 * Zero deps. Run: node tests/project-price-context.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'scripts', 'project-price-context.mjs')).href);
  const { priceContext, isPriceDated, parseAsOf, ROOF_COST_GUIDE } = mod;
  const d = (s) => parseAsOf(s);
  const job = (over) => Object.assign({ priceLow: 10500, priceHigh: 11500, services: ['roof-replacement'] }, over);

  console.log('\nPRICE CONTEXT — the rule, at an injected date\n');
  const TODAY = d('2026-09-27');
  const old = priceContext(job({ year: 2023 }), TODAY);
  ok('a 2023 roofing job gets the line on 2026-09-27', !!old);
  ok('  …naming its year', old && old.year === 2023 && /^Priced in 2023\./.test(old.lead) && /^Priced in 2023\./.test(old.short));
  ok('  …saying prices have moved, in plain words', old && /Materials and labor have gone up since/.test(old.lead) && /tier and scope move a price by thousands/.test(old.lead));
  ok('  …and linking the roof cost guide', old && old.href === ROOF_COST_GUIDE && old.href === '/blog/how-much-does-roof-cost-cincinnati-2026');
  ok('a current-year (2026) job does NOT get the line', priceContext(job({ year: 2026 }), TODAY) === null);
  ok('a 2025 job does not either — dated Dec 31, 2025 is under 12 months old', priceContext(job({ year: 2025 }), TODAY) === null);
  ok('the same 2025 job gets it once 12 months have passed (2027-01-01)', !!priceContext(job({ year: 2025 }), d('2027-01-01')));
  ok('the boundary is strict: a 2024 job on 2025-12-31 is exactly 12 months, no line', !isPriceDated(job({ year: 2024 }), d('2025-12-31')));
  ok('…and gets it the next day', isPriceDated(job({ year: 2024 }), d('2026-01-01')));
  ok('an unpriced 2023 job gets nothing (no price, nothing to put in context)', priceContext(job({ year: 2023, priceLow: undefined, priceHigh: undefined }), TODAY) === null);
  // Jo, 2026-09-27: undated jobs are the legacy ones, all priced before 2025 —
  // named one by one in LEGACY_UNDATED_PRICED; only they carry the label.
  const LEGACY = mod.LEGACY_UNDATED_PRICED[0];
  const undated = priceContext(job({ slug: LEGACY, year: undefined }), TODAY);
  ok('an undated priced job is labelled "Priced before 2025." (Jo 2026-09-27; the year itself is still not guessed)',
    !!undated && undated.year === 'before-2025' && undated.when === 'before 2025'
      && /^Priced before 2025\. Materials and labor have gone up since, and tier and scope move a price by thousands —$/.test(undated.lead)
      && undated.short === 'Priced before 2025. Materials and labor have gone up since.');
  ok('  …with the same prices-rise link as a dated job', undated && undated.href === ROOF_COST_GUIDE && undated.linkText === old.linkText);
  ok('  …whatever the as-of date (it is not an age rule)', !!priceContext(job({ slug: LEGACY, year: undefined }), d('2025-06-01')));
  ok('an undated UNPRICED job still gets nothing', priceContext(job({ slug: LEGACY, year: undefined, priceLow: undefined, priceHigh: undefined }), TODAY) === null);
  ok('an undated priced job OUTSIDE the legacy list is NOT labelled "before 2025" (the build refuses it instead)',
    priceContext(job({ slug: 'new-job-2026', year: undefined }), TODAY) === null && !mod.isUndatedPriced(job({ slug: 'new-job-2026' })));

  console.log('\nYEAR RULE — a priced job must carry a year (injected data)\n');
  const { yearRuleErrors } = mod;
  const P = (over) => Object.assign({ slug: 'x', published: '2026-09-01', priceLow: 9000, priceHigh: 10000, year: 2026 }, over);
  const inj = ['old-legacy-job'];
  ok('a dated priced job passes', yearRuleErrors([P({ slug: 'dated' })], TODAY, []).length === 0);
  const miss = yearRuleErrors([P({ slug: 'fresh-reroof-mason', year: undefined })], TODAY, []);
  ok('a live priced job with no year FAILS, naming the slug', miss.length === 1 && /"fresh-reroof-mason"/.test(miss[0]) && /needs "year"/.test(miss[0]), miss.join(' | '));
  ok('a legacy-listed undated priced job passes', yearRuleErrors([P({ slug: 'old-legacy-job', year: undefined })], TODAY, inj).length === 0);
  ok('an unpriced undated job passes (the rule is about prices)', yearRuleErrors([P({ slug: 'u', year: undefined, priceLow: undefined, priceHigh: undefined }), P({ slug: 'old-legacy-job', year: undefined })], TODAY, inj).length === 0);
  ok('a staged (future-published) undated priced job is not live yet — passes until it is',
    yearRuleErrors([P({ slug: 'staged', year: undefined, published: '2026-12-01' })], TODAY, []).length === 0
      && yearRuleErrors([P({ slug: 'staged', year: undefined, published: '2026-12-01' })], d('2026-12-02'), []).length === 1);
  ok('a garbage year fails', yearRuleErrors([P({ slug: 'g', year: '2024ish' })], TODAY, []).some((e) => /4-digit year/.test(e)));
  ok('a legacy entry that now has a year fails (the list only shrinks)', yearRuleErrors([P({ slug: 'old-legacy-job', year: 2023 })], TODAY, inj).some((e) => /now has a year/.test(e)));
  ok('a legacy entry missing from the data fails', yearRuleErrors([P({ slug: 'dated' })], TODAY, inj).some((e) => /not in projects\.json/.test(e)));
  ok('the real legacy list is exactly the 7 undated priced jobs named in Jo\'s 2026-09-27 call', mod.LEGACY_UNDATED_PRICED.length === 7 && Object.isFrozen(mod.LEGACY_UNDATED_PRICED));
  {
    const realProjects = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'assets', 'data', 'projects.json'), 'utf8')).projects;
    // Real data at the real date — the same thing the build checks.
    const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
    const errs = yearRuleErrors(realProjects, endOfToday);
    ok('the real projects.json passes the year rule', errs.length === 0, errs.join(' | '));
    const planted = realProjects.concat([P({ slug: 'planted-undated-job', year: undefined, published: '2026-09-01' })]);
    ok('…and fails once an undated priced job is planted in it', yearRuleErrors(planted, TODAY).some((e) => /"planted-undated-job"/.test(e)));
  }
  ok('a dated job keeps "in <year>"', old && old.when === 'in 2023');
  ok('a commercial job links the commercial hub, not the residential cost guide',
    (priceContext(job({ year: 2023, services: ['commercial-roofing', 'storm-damage', 'roof-replacement'] }), TODAY) || {}).href === '/services/commercial-roofing');
  ok('a storm job that was a re-roof links the cost guide',
    (priceContext(job({ year: 2023, services: ['storm-damage', 'roof-replacement'] }), TODAY) || {}).href === ROOF_COST_GUIDE);
  ok('a repair job links its own service hub',
    (priceContext(job({ year: 2023, services: ['roof-repair', 'storm-damage'] }), TODAY) || {}).href === '/services/roof-repair');
  let threw = false;
  try { isPriceDated(job({ year: 2023 }), new Date('nope')); } catch (_) { threw = true; }
  ok('an invalid as-of date throws instead of silently flagging nothing', threw);
  ok('parseAsOf refuses anything but YYYY-MM-DD', parseAsOf('09/27/2026') === null && parseAsOf('') === null && parseAsOf('2026-09-27') instanceof Date);

  console.log('\nPRICE CONTEXT — the stamped tree follows the same rule\n');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'assets', 'data', 'projects.json'), 'utf8'));
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const live = manifest.projects.filter((p) => { const t = new Date(p.published); t.setHours(0, 0, 0, 0); return t <= now; });
  const asOf = parseAsOf(live.map((p) => p.published).sort().at(-1).slice(0, 10));
  const flagged = live.filter((p) => priceContext(p, asOf));
  const clean = live.filter((p) => p.priceLow != null && !priceContext(p, asOf));
  ok(`some live jobs are dated at the default as-of (${flagged.length})`, flagged.length > 0);
  const page = (slug) => fs.readFileSync(path.join(ROOT, 'docs', 'our-work', `${slug}.html`), 'utf8');
  const undatedLive = flagged.filter((p) => p.year == null);
  ok(`every undated priced live job is flagged "before 2025" (${undatedLive.length})`,
    undatedLive.length > 0 && live.filter((p) => p.year == null && p.priceLow != null).length === undatedLive.length);
  const missing = flagged.filter((p) => {
    const html = page(p.slug);
    const c = priceContext(p, asOf);
    return !html.includes(`data-price-context="${c.year}"`) || !html.includes(`href="${c.href}"`) || !html.includes(`Priced ${c.when}.`)
      || !html.includes(`(retail, priced ${c.when})`);
  });
  ok('every dated job\'s case page carries the line and its link', missing.length === 0, missing.map((p) => p.slug).join(', '));
  const leaked = clean.filter((p) => page(p.slug).includes('data-price-context'));
  ok('no current-priced job\'s case page carries it', leaked.length === 0, leaked.map((p) => p.slug).join(', '));
  const OUR_WORK = fs.readFileSync(path.join(ROOT, 'docs', 'our-work.html'), 'utf8');
  const cardLines = (OUR_WORK.match(/<p data-price-context="(\d{4}|before-2025)">/g) || []).length;
  ok('/our-work carries exactly one line per dated live job', cardLines === flagged.length, `${cardLines} vs ${flagged.length}`);
  ok('the price and its year are still shown (context is added, nothing is hidden)',
    flagged.every((p) => page(p.slug).includes(`$${p.priceLow.toLocaleString('en-US')}–$${p.priceHigh.toLocaleString('en-US')}`)));
  ok('no inline style on the new line (existing classes only)', !/data-price-context="(\d{4}|before-2025)"[^>]*style=/.test(OUR_WORK));

  console.log('\nPRICE CONTEXT — the as-of date is injectable\n');
  const gen = path.join(ROOT, 'scripts', 'build-projects.mjs');
  const run = (...args) => spawnSync(process.execPath, [gen, '--check', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const base = run();
  ok('--check is clean at the default as-of', base.status === 0, (base.stdout + base.stderr).slice(-300));
  const later = run('--as-of=2030-01-01');
  ok('--as-of=2030-01-01 moves the output (every priced job with a year would be dated) → drift', later.status === 1 && /stale generated surfaces/.test(later.stderr), (later.stdout + later.stderr).slice(-300));
  const bad = run('--as-of=soon');
  ok('a malformed --as-of is fatal, not ignored', bad.status === 1 && /not YYYY-MM-DD/.test(bad.stderr));

  console.log('\n──────────────────────────────────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
