/**
 * tests/skin-quota-2026-10-11.test.js — My Skin hard storage caps (Cloud
 * Function on Storage finalize): a person's skins/{uid}/** at 1 GB and a
 * company's companies/{id}/skins/** at 500 MB.
 *
 * Run: node tests/skin-quota-2026-10-11.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: 'demo-skin', storageBucket: 'demo-skin.appspot.com' });
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const Q = require(path.join(ROOT, 'functions/skin-quota-logic.js'));
const MB = 1024 * 1024;

console.log('\n1. classify');
{
  const c = (n) => Q.classify(n);
  ok('the three fixed personal slots', ['wallpaper', 'texture', 'mascot'].every((s) => c('skins/u1/' + s) && c('skins/u1/' + s).kind === 'personal' && c('skins/u1/' + s).owner === 'u1'));
  ok('a per-theme picture and its thumbnail', c('skins/u1/themes/pokemon/lq3x9a1b2c').prefix === 'skins/u1/' && c('skins/u1/themes/_custom/lq3x9a1b2c_t').kind === 'personal');
  ok('a company picture, its thumbnail, and the _all slot', c('companies/co1/skins/themes/pokemon/lq3x9a1b2c').kind === 'company'
    && c('companies/co1/skins/themes/_all/lq3x9a1b2c_t').prefix === 'companies/co1/skins/');
  ok('everything else is ignored', ['photos/u1/x.jpg', 'skins/u1/avatar', 'skins/u1/themes/Pokemon/lq3x9a1b2c', 'skins/u1/themes/pokemon/short',
    'skins/u1/themes/pokemon/lq3x9a1b2c/extra', 'companies/co1/skins/wallpaper', 'companies/co1/other/themes/a/lq3x9a1b2c', 'skins', ''].every((n) => c(n) === null));
  ok('a path-y owner id is refused', c('skins/a b/wallpaper') === null && c('skins/../wallpaper') === null);
}

console.log('\n2. decide');
{
  ok('personal: 1 GB is allowed, 1 GB + 1 byte is not', !Q.decide('personal', 1024 * MB).over && Q.decide('personal', 1024 * MB + 1).over);
  ok('company: 500 MB is allowed, 500 MB + 1 byte is not', !Q.decide('company', 500 * MB).over && Q.decide('company', 500 * MB + 1).over);
  ok('the caps are 1 GB and 500 MB', Q.PERSONAL_HARD_BYTES === 1024 * MB && Q.COMPANY_CAP_BYTES === 500 * MB);
}

console.log('\n3. the trigger core (fake bucket)');
(async () => {
  const S = require(path.join(ROOT, 'functions/skin-quota.js'))._test;
  function deps(listing) {
    const log = { deleted: [], usage: [] };
    return { log, listSizes: async () => listing.slice(), deleteObjects: async (n) => { log.deleted.push.apply(log.deleted, n); listing.length = Math.max(0, listing.length - 1); },
      writeUsage: async (id, u) => { log.usage.push([id, u]); }, now: () => 1234 };
  }
  let d = deps([10 * MB, 20 * MB]);
  let r = await S.onFinalized('companies/co1/skins/themes/pokemon/lq3x9a1b2c', d);
  ok('a company picture under the cap is kept and usage is written', r.ok && d.log.deleted.length === 0 && d.log.usage.length === 1
    && d.log.usage[0][0] === 'co1' && d.log.usage[0][1].bytes === 30 * MB && d.log.usage[0][1].count === 2 && !d.log.usage[0][1].rejectedAt);
  d = deps([300 * MB, 201 * MB]);
  r = await S.onFinalized('companies/co1/skins/themes/pokemon/lq3x9a1b2d', d);
  ok('a company picture past 500 MB is deleted with its thumbnail and rejectedAt is written',
    r.rejected && d.log.deleted.join() === 'companies/co1/skins/themes/pokemon/lq3x9a1b2d,companies/co1/skins/themes/pokemon/lq3x9a1b2d_t'
    && d.log.usage[0][1].rejectedAt === 1234);
  d = deps([600 * MB, 500 * MB]);
  r = await S.onFinalized('skins/u1/themes/pokemon/lq3x9a1b2c', d);
  ok('a personal picture past 1 GB is deleted (no company usage write)', r.rejected && r.kind === 'personal' && d.log.deleted.length === 2 && d.log.usage.length === 0);
  d = deps([900 * MB]);
  r = await S.onFinalized('skins/u1/themes/pokemon/lq3x9a1b2c', d);
  ok('a personal picture under 1 GB is kept', r.ok && d.log.deleted.length === 0);
  d = deps([600 * MB, 500 * MB]);
  r = await S.onFinalized('companies/co1/skins/themes/pokemon/lq3x9a1b2c_t', d);
  ok('refusing a thumbnail deletes only itself', r.rejected && d.log.deleted.join() === 'companies/co1/skins/themes/pokemon/lq3x9a1b2c_t');
  d = deps([1]);
  r = await S.onFinalized('photos/u1/x.jpg', d);
  ok('an unrelated object is ignored without listing or writing', r.ignored && d.log.usage.length === 0 && d.log.deleted.length === 0);
  d = deps([5 * MB]);
  await S.onDeleted('companies/co1/skins/themes/pokemon/lq3x9a1b2c', d);
  ok('a company delete recomputes usage', d.log.usage.length === 1 && d.log.usage[0][1].bytes === 5 * MB);
  d = deps([5 * MB]);
  r = await S.onDeleted('skins/u1/wallpaper', d);
  ok('a personal delete writes nothing', r.ignored && d.log.usage.length === 0);

  console.log('\n4. wiring');
  const src = read('functions/skin-quota.js');
  ok('Storage triggers only: finalize and delete, no callable', /onObjectFinalized\(/.test(src) && /onObjectDeleted\(/.test(src) && !/onCall\(|onRequest\(/.test(src));
  ok('usage is written with the Admin SDK (clients are denied by rules)', /\.set\(\{ usage: u,/.test(src));
  const idx = read('functions/index.js');
  ok('exported from index.js', /skinQuotaFinalize = skinQuota\.skinQuotaFinalize/.test(idx) && /skinQuotaDeleted = skinQuota\.skinQuotaDeleted/.test(idx));
  const md = read('functions/FUNCTIONS_INDEX.md');
  ok('documented in FUNCTIONS_INDEX.md', /\| `skinQuotaFinalize` \|/.test(md) && /\| `skinQuotaDeleted` \|/.test(md));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
