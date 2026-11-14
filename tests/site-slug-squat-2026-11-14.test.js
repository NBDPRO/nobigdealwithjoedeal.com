/**
 * tests/site-slug-squat-2026-11-14.test.js
 *
 * A tenant microsite slug belongs to whoever holds the siteSlugs/{slug} claim
 * (written only by the setSiteSlug callable). Before 2026-11-14 a client could
 * CREATE its own companies doc already carrying another tenant's siteSlug (the
 * rules froze the field on update only), and resolveCompanyByKey's unordered
 * where('siteSlug','==',key).limit(1) returned the lowest doc id, so a
 * squatter whose uid sorted first took over the tenant's public site (404)
 * and every lead posted with that siteKey (submitPublicLead tags by it).
 *
 * Part 1 drives the real resolver against an in-memory Firestore. Part 2 pins
 * the create rule's denylist; the emulator suite (tests/firestore-rules.test.js
 * 23e-3) proves the rule itself. Synthetic data only.
 *
 * Run: node tests/site-slug-squat-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { resolveCompanyByKey } = require(path.join(ROOT, 'functions', 'handlers', 'public-site.js'))._test;

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

// Firestore returns an unordered equality query in doc-id order; the fake does too.
function makeDb(seed) {
  const data = new Map(Object.entries(seed));
  const snap = (p) => ({ id: p.split('/').pop(), exists: data.has(p), data: () => data.get(p) });
  return {
    doc: (p) => ({ get: async () => snap(p) }),
    collection: (col) => ({
      where: (f, op, v) => ({
        limit: (n) => ({
          get: async () => {
            const docs = [...data.keys()].filter((k) => k.startsWith(col + '/') && k.split('/').length === 2 && (data.get(k) || {})[f] === v)
              .sort().slice(0, n).map(snap);
            return { empty: !docs.length, size: docs.length, docs };
          },
        }),
      }),
    }),
  };
}

(async () => {
  console.log('\n1. resolveCompanyByKey');
  {
    const db = makeDb({
      'companies/zzz-victim': { ownerId: 'zzz-victim', status: 'active', sitePublished: true, siteSlug: 'acme-roofing' },
      'siteSlugs/acme-roofing': { companyId: 'zzz-victim' },
      // The squatter: created by a client with the victim's slug, no status, id sorts first.
      'companies/aaa-attacker': { ownerId: 'aaa-attacker', name: 'x', siteSlug: 'acme-roofing' },
    });
    const r = await resolveCompanyByKey(db, 'acme-roofing');
    ok('a claimed slug resolves to the claim holder, not the lowest doc id', r && r.companyId === 'zzz-victim', JSON.stringify(r && r.companyId));
  }
  {
    const db = makeDb({
      'companies/zzz-real': { ownerId: 'zzz-real', status: 'active', siteSlug: 'oak-roofs' },
      'companies/aaa-other': { ownerId: 'aaa-other', siteSlug: 'oak-roofs' },
    });
    const r = await resolveCompanyByKey(db, 'oak-roofs');
    ok('an UNclaimed slug carried by two companies resolves to nobody (ambiguous)', r === null, JSON.stringify(r && r.companyId));
  }
  {
    const db = makeDb({ 'companies/co-legacy': { ownerId: 'co-legacy', siteSlug: 'legacy-co' } });
    const r = await resolveCompanyByKey(db, 'legacy-co');
    ok('control: an unclaimed slug on exactly one company still resolves (legacy)', r && r.companyId === 'co-legacy');
  }
  {
    const db = makeDb({
      'companies/co-moved': { ownerId: 'co-moved', siteSlug: 'new-name' },
      'siteSlugs/old-name': { companyId: 'co-moved' },
    });
    const r = await resolveCompanyByKey(db, 'old-name');
    ok('a stale claim whose company no longer carries the slug → nobody', r === null);
  }
  {
    const db = makeDb({ 'companies/co-a': { ownerId: 'co-a', status: 'active', siteSlug: 'a-site' } });
    const r = await resolveCompanyByKey(db, 'co-a');
    ok('control: a company id key still resolves directly', r && r.companyId === 'co-a');
  }

  console.log('\n2. firestore.rules: companies create refuses a slug');
  {
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    const i = rules.indexOf('match /companies/{companyId}');
    const block = rules.slice(i, rules.indexOf('allow update', i));
    const create = block.slice(block.indexOf('allow create'));
    const deny = (create.match(/hasAny\(\[([\s\S]*?)\]\)/) || ['', ''])[1];
    ok('companies create rule found', i !== -1 && create.length > 50);
    ok('create denies siteSlug', /'siteSlug'/.test(deny), deny);
    ok('create denies siteSlugUpdatedAt', /'siteSlugUpdatedAt'/.test(deny));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
