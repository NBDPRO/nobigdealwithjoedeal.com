/**
 * tests/draft-project-page-2026-11-09.test.js — scripts/draft-project-page.mjs,
 * the "Draft project page" step (content plan §2 step 2).
 *
 * From one consented CRM job (leads/{id}, read only) it drafts a
 * docs/assets/data/projects.json entry that follows
 * documentation/runbooks/PUBLISH-PROJECT.md: town only (never the street),
 * a rounded retail range (never the exact sold price, never a cost key),
 * case-study fields from the job only when they are clean, consentOnFile:
 * true, and fresh alt text (never CRM photo captions). It refuses a job
 * without lead.projectConsent.on === true, and a joint or subcontracted job
 * (runbook hard rule 3: Jo's call). Default is a dry run; --write only appends
 * to the LOCAL projects.json.
 *
 * Run: node tests/draft-project-page-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'draft-project-page.mjs');
let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label + (extra ? '  >>> ' + extra : '')); }
}

// A fake lead in the shape the CRM writes (no real customer).
function fakeLead(over) {
  return Object.assign({
    id: 'ZZqaLead01',
    companyId: 'co-test', userId: 'co-test',
    firstName: 'Zed', lastName: 'Testerson', phone: '513-555-0142', email: 'zed@example.com',
    address: '4417 Quailhollow Lane, Mason, OH 45040',
    jobType: 'insurance', damageType: 'Hail',
    scopeOfWork: 'Tore off the hail-damaged shingles and installed a new architectural shingle roof with new underlayment and ridge vent.',
    jobValue: 18740,
    materialCost: 7311,
    stage: 'install_complete',
    installCompletedAt: new Date('2026-10-14T18:00:00Z'),
    projectConsent: { on: true, by: 'co-test', at: new Date('2026-11-09T12:00:00Z') },
  }, over || {});
}

(async () => {
  ok('scripts/draft-project-page.mjs exists', fs.existsSync(SCRIPT));
  if (!fs.existsSync(SCRIPT)) { console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
  const M = await import('file://' + SCRIPT);
  const src = fs.readFileSync(SCRIPT, 'utf8');

  // ── refusals ──
  ok('refuses a lead with no projectConsent', /consent/i.test(M.refusalFor(fakeLead({ projectConsent: undefined })) || ''));
  ok('refuses consent on: false', /consent/i.test(M.refusalFor(fakeLead({ projectConsent: { on: false, by: 'x', at: new Date() } })) || ''));
  ok('refuses a truthy-but-not-true consent ("true")', /consent/i.test(M.refusalFor(fakeLead({ projectConsent: { on: 'true' } })) || ''));
  ok('refuses a job with a sub on it (subId): Jo\'s call', /Jo/.test(M.refusalFor(fakeLead({ subId: 'sub1' })) || ''));
  ok('refuses a job with a legacy crew name', /Jo/.test(M.refusalFor(fakeLead({ crew: 'Ace Roofing' })) || ''));
  ok('refuses a job marked joint', /Jo/.test(M.refusalFor(fakeLead({ jointJob: true })) || ''));
  ok('refuses a job marked subcontracted', /Jo/.test(M.refusalFor(fakeLead({ subcontracted: true })) || ''));
  ok('a consented NBD job is not refused', M.refusalFor(fakeLead()) === null, M.refusalFor(fakeLead()));

  // ── town only ──
  ok('town from the free-text address', M.townFromLead(fakeLead()) === 'Mason, OH', M.townFromLead(fakeLead()));
  ok('town from city/state fields when present', M.townFromLead(fakeLead({ city: 'West Chester', state: 'oh', address: '' })) === 'West Chester, OH');
  ok('town from "street, town ST zip" without a comma before the state', M.townFromLead(fakeLead({ address: '12 Elm St, Loveland OH 45140' })) === 'Loveland, OH', M.townFromLead(fakeLead({ address: '12 Elm St, Loveland OH 45140' })));
  ok('no town when the address has none', M.townFromLead(fakeLead({ address: '4417 Quailhollow Lane' })) === null);

  // ── rounded retail range ──
  const r = M.roundedRange(18740);
  ok('a range, not the sold price', r && r.priceLow < 18740 && r.priceHigh > 18740, JSON.stringify(r));
  ok('rounded to $1,000 on a five-figure job', r && r.priceLow % 1000 === 0 && r.priceHigh % 1000 === 0, JSON.stringify(r));
  const r2 = M.roundedRange(6200);
  ok('rounded to $500 on a four-figure job', r2 && r2.priceLow % 500 === 0 && r2.priceHigh % 500 === 0 && r2.priceLow < 6200 && r2.priceHigh > 6200, JSON.stringify(r2));
  const r3 = M.roundedRange(180);
  ok('a small repair still gets a positive range', r3 && r3.priceLow > 0 && r3.priceLow < r3.priceHigh, JSON.stringify(r3));
  ok('no price means no range', M.roundedRange(0) === null && M.roundedRange(undefined) === null && M.roundedRange('abc') === null);

  // ── services ──
  ok('hail + new roof -> storm-damage + roof-replacement', JSON.stringify(M.servicesFromLead(fakeLead())) === '["storm-damage","roof-replacement"]', JSON.stringify(M.servicesFromLead(fakeLead())));
  ok('a gutter job -> gutter-replacement', M.servicesFromLead(fakeLead({ damageType: '', jobType: 'service', scopeOfWork: 'Replaced the gutters and downspouts.' })).includes('gutter-replacement'));
  ok('no clue -> no services (the CLI then asks for --services)', M.servicesFromLead(fakeLead({ damageType: '', jobType: '', scopeOfWork: '' })).length === 0);

  // ── the entry ──
  const existing = [{ slug: 'mason-oh-roof-replacement-2026' }];
  const { entry, warnings } = M.buildEntry(fakeLead(), { photos: 3, published: '2026-11-10', existingSlugs: existing.map((p) => p.slug) });
  ok('consentOnFile: true', entry.consentOnFile === true);
  ok('city is town only', entry.city === 'Mason, OH');
  ok('year from installCompletedAt', entry.year === 2026);
  ok('services set', Array.isArray(entry.services) && entry.services[0] === 'storm-damage');
  ok('slug is kebab-case and unique against existing slugs', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.slug) && !existing.some((p) => p.slug === entry.slug), entry.slug);
  ok('three photos with repo-local src, hero = first', entry.photos.length === 3 && entry.photos.every((p, i) => p.src === '/assets/images/projects/' + entry.slug + '-' + (i + 1) + '.jpg') && entry.hero === entry.photos[0].src, JSON.stringify(entry.photos));
  ok('every photo has non-empty alt text', entry.photos.every((p) => typeof p.alt === 'string' && p.alt.trim().length > 10));
  ok('published as given', entry.published === '2026-11-10');
  ok('required fields present (title, tag, description)', ['title', 'tag', 'description'].every((k) => typeof entry[k] === 'string' && entry[k].trim()));
  ok('scope filled from the job', typeof entry.scope === 'string' && /architectural shingle/.test(entry.scope));
  ok('priceLow/priceHigh are the rounded range', entry.priceLow === r.priceLow && entry.priceHigh === r.priceHigh);

  const blob = JSON.stringify(entry);
  ok('no street, no house number in the entry', !/Quailhollow|4417|45040/.test(blob), blob);
  ok('no customer name, phone or email', !/Zed|Testerson|555-0142|example\.com/.test(blob), blob);
  ok('no exact sold price', !/18740|18,740/.test(blob));
  ok('no cost / margin / contractor / address keys', !/"[^"]*(cost|margin|contractor|token|address|street)[^"]*":/i.test(blob), blob);
  ok('no material cost figure', !/7311|7,311/.test(blob));

  // Fresh alt text: never a CRM caption.
  const withCaptions = fakeLead({ photos: [{ description: 'Front of the Testerson house on Quailhollow', location: '4417 Quailhollow Lane' }] });
  const e2 = M.buildEntry(withCaptions, { photos: 1, published: '2026-11-10', existingSlugs: [] }).entry;
  ok('alt text never copies CRM photo captions', !/Testerson|Quailhollow/.test(JSON.stringify(e2.photos)), JSON.stringify(e2.photos));

  // Dirty case-study text is dropped with a warning, never published.
  const dirty = M.buildEntry(fakeLead({ scopeOfWork: 'Replaced roof at 4417 Quailhollow Lane, call Zed at 513-555-0142, $18,740 total' }), { photos: 1, published: '2026-11-10', existingSlugs: [] });
  ok('scope with an address / phone / price is left out', dirty.entry.scope === undefined && !/Quailhollow|555-0142|18,740/.test(JSON.stringify(dirty.entry)), JSON.stringify(dirty.entry));
  ok('…and the drop is reported as a warning', dirty.warnings.some((w) => /scope/i.test(w)), JSON.stringify(dirty.warnings));

  // Unique slug when one already exists.
  const first = M.buildEntry(fakeLead(), { photos: 1, published: '2026-11-10', existingSlugs: [] }).entry.slug;
  const second = M.buildEntry(fakeLead(), { photos: 1, published: '2026-11-10', existingSlugs: [first] }).entry.slug;
  ok('a taken slug gets a -2 suffix', second === first + '-2', first + ' / ' + second);

  // buildEntry refuses on its own too (not only the CLI).
  let threw = '';
  try { M.buildEntry(fakeLead({ projectConsent: undefined }), { photos: 1, published: '2026-11-10', existingSlugs: [] }); } catch (e) { threw = e.message; }
  ok('buildEntry throws without consent', /consent/i.test(threw), threw);
  ok('warnings is an array', Array.isArray(warnings));

  // ── script hygiene ──
  ok('reads Firestore read-only (no set/update/create/delete calls)', !/\.(set|update|create|delete)\(/.test(src.replace(/projects\.(push|splice)/g, '')));
  ok('no model ids or secrets in the script', !/claude-|sk-ant|AIza/.test(src));

  // ── CLI: dry run by default, --write only touches the given projects.json ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'draftproj-'));
  const leadFile = path.join(tmp, 'lead.json');
  const projFile = path.join(tmp, 'projects.json');
  fs.writeFileSync(leadFile, JSON.stringify(fakeLead({ installCompletedAt: '2026-10-14T18:00:00Z', projectConsent: { on: true, by: 'co-test', at: { _seconds: 1794258512, _nanoseconds: 0 } } })));
  const projBefore = JSON.stringify({ _readme: ['x'], projects: [{ slug: 'old-one' }] }, null, 2) + '\n';
  fs.writeFileSync(projFile, projBefore);
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: Object.assign({}, process.env, { NBD_ACCESS_TOKEN: '' }) });

  const dry = run(['--from', leadFile, '--projects', projFile, '--photos', '2', '--published', '2026-11-10']);
  ok('dry run exits 0', dry.status === 0, dry.stderr);
  ok('dry run prints the entry', /"consentOnFile": true/.test(dry.stdout) && /"city": "Mason, OH"/.test(dry.stdout), dry.stdout.slice(0, 400));
  ok('dry run leaves projects.json untouched', fs.readFileSync(projFile, 'utf8') === projBefore);
  ok('dry run says it is a dry run', /dry run/i.test(dry.stdout));

  const wr = run(['--from', leadFile, '--projects', projFile, '--photos', '2', '--published', '2026-11-10', '--write']);
  ok('--write exits 0', wr.status === 0, wr.stderr);
  const after = JSON.parse(fs.readFileSync(projFile, 'utf8'));
  ok('--write APPENDS the entry at the end', after.projects.length === 2 && after.projects[0].slug === 'old-one' && after.projects[1].consentOnFile === true, JSON.stringify(after.projects.map((p) => p.slug)));
  ok('--write keeps the file\'s 2-space JSON + trailing newline', fs.readFileSync(projFile, 'utf8') === JSON.stringify(after, null, 2) + '\n');
  ok('--write prints the prepare-project-images and build-projects steps', /prepare-project-images\.mjs/.test(wr.stdout) && /build-projects\.mjs/.test(wr.stdout), wr.stdout);

  const again = run(['--from', leadFile, '--projects', projFile, '--photos', '2', '--published', '2026-11-10', '--write', '--slug', after.projects[1].slug]);
  ok('--write refuses a slug that is already in projects.json', again.status !== 0 && /already/i.test(again.stderr), again.stderr);

  fs.writeFileSync(leadFile, JSON.stringify(fakeLead({ projectConsent: { on: false } })));
  const no = run(['--from', leadFile, '--projects', projFile]);
  ok('CLI refuses a job without consent (non-zero exit)', no.status !== 0 && /consent/i.test(no.stderr), no.stderr);

  fs.writeFileSync(leadFile, JSON.stringify(fakeLead({ subId: 'sub9' })));
  const sub = run(['--from', leadFile, '--projects', projFile]);
  ok('CLI refuses a subcontracted job and names Jo', sub.status !== 0 && /Jo/.test(sub.stderr), sub.stderr);

  const none = run(['--projects', projFile]);
  ok('CLI with no --lead / --from prints usage and fails', none.status !== 0 && /usage/i.test(none.stderr), none.stderr);

  const tokenless = run(['--lead', 'ZZqaLead01', '--projects', projFile]);
  ok('--lead without NBD_ACCESS_TOKEN fails clearly (no other credential path)', tokenless.status !== 0 && /NBD_ACCESS_TOKEN/.test(tokenless.stderr), tokenless.stderr);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\ndraft project page: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
