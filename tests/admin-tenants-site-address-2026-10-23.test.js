'use strict';
// Admin Tenants "Site address" column (read-only). The slug is the public URL
// segment, so showing it leaks nothing; the card must escape it.
const fs = require('fs');
const path = require('path');
const { tenantRow } = require('../functions/tenant-ops-logic');

let failed = 0;
function ok(name, cond) { console.log((cond ? '  ok   ' : '  FAIL ') + name); if (!cond) failed++; }

const withSlug = tenantRow({ companyId: 'c1', company: { name: 'Oaks', status: 'active', siteSlug: 'oaks' } });
ok('row carries the slug', withSlug.siteSlug === 'oaks');
ok('control: no slug -> empty string, not "undefined"', tenantRow({ companyId: 'c2', company: { name: 'Elm' } }).siteSlug === '');
ok('a value that is not a valid slug (too long) shows blank', tenantRow({ companyId: 'c3', company: { siteSlug: 'x'.repeat(200) } }).siteSlug === '');
ok('a value carrying markup shows blank', tenantRow({ companyId: 'c5', company: { siteSlug: '<img src=x>' } }).siteSlug === '');
ok('row adds no private fields', !('alertSms' in withSlug) && !('ownerId' in withSlug));
ok('publish state unchanged (control)', withSlug.sitePublished === 'yes (legacy)'
  && tenantRow({ companyId: 'c4', company: { status: 'active', sitePublished: false } }).sitePublished === 'no');

const ui = fs.readFileSync(path.join(__dirname, '..', 'docs/admin/js/pages/tenants.js'), 'utf8');
ok('card renders the Site address cell through esc()', /Site address[\s\S]{0,120}esc\(t\.siteSlug \?/.test(ui));
ok('card shows a dash when there is no slug', /'\/sites\/t\/' \+ t\.siteSlug : '—'/.test(ui));
process.exit(failed ? 1 : 0);
