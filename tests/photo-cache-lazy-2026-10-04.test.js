/**
 * tests/photo-cache-lazy-2026-10-04.test.js
 *
 * Startup audit (2026-10-04): loadLeads ended every dashboard boot by reading
 * EVERY photos doc in scope (no limit), and loadPins / loadZones read whole
 * collections. Photos now load per lead on demand through
 * docs/pro/js/photo-cache.js (window.NBDPhotoCache); pins are capped to the
 * most recent PIN_CAP per scope, zones to ZONE_CAP.
 *
 * BEHAVIOUR (vm-loaded photo-cache.js against a fake Firestore):
 *   - ensure() batches a tick's requests into `leadId in [≤30]` queries, one
 *     per scope (own userId; + companyId for company readers), never re-reads
 *     a loaded lead, and coalesces concurrent asks for the same lead;
 *   - results merge into window._photoCache WITHOUT dropping a photo a surface
 *     pushed meanwhile; every requested lead ends with an array;
 *   - `nbd:photos-loaded` fires with the lead ids;
 *   - a failed read does not mark the lead loaded (a later ask retries);
 *   - an account switch mid-read discards the result; a switch resets the cache.
 * WIRING (source contracts, comments stripped):
 *   - loadLeads reads no photos collection; pins/zones queries are capped;
 *   - the pins orderBy has its composite indexes and a failed-precondition
 *     fallback; dashboard.html loads photo-cache.js deferred;
 *   - the on-demand consumers ask NBDPhotoCache (preflight waits once, the
 *     staging re-stages, the hero / Photos tab repaint on the event, the
 *     inspection report waits once).
 *
 * Run: node tests/photo-cache-lazy-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PRO = path.join(ROOT, 'docs', 'pro');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

/** Fresh sandbox: photo-cache.js loaded against a fake Firestore over `photos`. */
function sandbox(photos, opts = {}) {
  const queries = [];
  const events = [];
  const win = {
    _user: { uid: opts.uid || 'u1' },
    _userClaims: opts.claims || {},
    _photoCache: opts.cache || {},
    db: {},
    collection: (_db, name) => ({ name }),
    where: (field, op, value) => ({ field, op, value }),
    query: (coll, ...cons) => ({ coll: coll.name, cons }),
    getDocs: async (q) => {
      queries.push(q);
      if (opts.fail) { const e = new Error('unavailable'); e.code = 'unavailable'; throw e; }
      if (opts.onQuery) await opts.onQuery(win, q);
      const inC = q.cons.find((c) => c.op === 'in');
      const scope = q.cons.find((c) => c.op === '==');
      const hits = photos.filter((p) => inC.value.includes(p.leadId) && p[scope.field] === scope.value);
      return { forEach: (fn) => hits.forEach((p) => fn({ id: p.id, data: () => { const { id, ...rest } = p; void id; return rest; } })) };
    },
    dispatchEvent: (ev) => { events.push(ev); return true; },
  };
  const ctx = { window: win, globalThis: win, console: { warn() {}, log() {} }, setTimeout, Promise, Object, Array, String, CustomEvent: class { constructor(t, i) { this.type = t; this.detail = (i || {}).detail; } } };
  vm.createContext(ctx);
  vm.runInContext(read('docs/pro/js/photo-cache.js'), ctx, { filename: 'photo-cache.js' });
  return { win, api: win.NBDPhotoCache, queries, events };
}
const P = (id, leadId, userId, companyId) => ({ id, leadId, userId, companyId, url: 'https://x/' + id });

(async () => {
  console.log('\nPURE HELPERS');
  {
    const { api } = sandbox([]);
    const { chunk, scopesFor, mergeInto, IN_LIMIT } = api._pure;
    ok('IN_LIMIT is Firestore\'s 30', IN_LIMIT === 30);
    ok('chunk(65, 30) → 30/30/5', JSON.stringify(chunk([...Array(65).keys()], 30).map((c) => c.length)) === '[30,30,5]');
    ok('solo / sales_rep → own scope only', JSON.stringify(scopesFor('u1', { role: 'sales_rep', companyId: 'c1' })) === '[["userId","u1"]]');
    ok('company_admin → own + company scope', JSON.stringify(scopesFor('u1', { role: 'company_admin', companyId: 'c1' })) === '[["userId","u1"],["companyId","c1"]]');
    ok('no uid → no scope (no read)', scopesFor('', {}).length === 0);
    const cache = { L1: [{ id: 'uploaded-meanwhile', leadId: 'L1' }, { id: 'p1', leadId: 'L1', stale: true }] };
    mergeInto(cache, ['L1', 'L2'], [{ id: 'p1', leadId: 'L1' }, { id: 'p1', leadId: 'L1' }, { id: 'pX', leadId: 'OTHER' }]);
    ok('merge keeps a photo pushed meanwhile', cache.L1.some((p) => p.id === 'uploaded-meanwhile'));
    ok('merge replaces a same-id entry with the fetched doc (no dupes)', cache.L1.filter((p) => p.id === 'p1').length === 1 && !cache.L1.find((p) => p.id === 'p1').stale);
    ok('a requested lead with no photos gets []', Array.isArray(cache.L2) && cache.L2.length === 0);
    ok('docs for leads nobody asked about are ignored', !cache.OTHER);
  }

  console.log('\nENSURE — batching, scopes, once-only');
  {
    const photos = [P('a', 'L1', 'u1'), P('b', 'L2', 'u1'), P('c', 'L2', 'u2', 'c1'), P('d', 'L9', 'u1')];
    const s = sandbox(photos, { claims: { role: 'company_admin', companyId: 'c1' } });
    await Promise.all([s.api.ensure(['L1']), s.api.ensure(['L2', 'L1'])]);
    ok('one tick of asks → one query per scope (2 scopes)', s.queries.length === 2, String(s.queries.length));
    ok('queries are leadId-in + scope equality on photos', s.queries.every((q) => q.coll === 'photos' && q.cons.length === 2 && q.cons[0].field === 'leadId' && q.cons[0].op === 'in'));
    ok('…carrying both requested leads, no others', JSON.stringify(s.queries[0].cons[0].value.slice().sort()) === '["L1","L2"]');
    ok('teammate photo (company scope) is included', s.win._photoCache.L2.some((p) => p.id === 'c'));
    ok('unrequested lead L9 not read into the cache', !s.win._photoCache.L9);
    ok('isLoaded true after the read', s.api.isLoaded('L1') && s.api.isLoaded('L2') && !s.api.isLoaded('L9'));
    ok('nbd:photos-loaded fired with the lead ids', s.events.length === 1 && s.events[0].type === 'nbd:photos-loaded' && s.events[0].detail.leadIds.length === 2);
    await s.api.ensure(['L1', 'L2']);
    ok('asking again for loaded leads reads nothing', s.queries.length === 2);
    const many = [...Array(65).keys()].map((i) => 'M' + i);
    const s2 = sandbox([]);
    await s2.api.ensure(many);
    ok('65 leads, own scope → 3 chunked queries (≤30 ids each)', s2.queries.length === 3 && s2.queries.every((q) => q.cons[0].value.length <= 30));
  }

  console.log('\nFAILURE + ACCOUNT SWITCH');
  {
    const s = sandbox([P('a', 'L1', 'u1')], { fail: true });
    await s.api.ensure(['L1']);
    ok('a failed read resolves (never rejects) and does NOT mark loaded', !s.api.isLoaded('L1'));
    ok('…and fires no loaded event', s.events.length === 0);
    const s2 = sandbox([P('a', 'L1', 'u1')], { onQuery: async (win) => { win._user = { uid: 'u2' }; } });
    await s2.api.ensure(['L1']);
    ok('account changed mid-read → result discarded', !(s2.win._photoCache.L1 || []).length && !s2.api.isLoaded('L1'));
    const s3 = sandbox([P('a', 'L1', 'u1')]);
    await s3.api.ensure(['L1']);
    s3.win._user = { uid: 'u2' };
    ok('after a switch, the old account\'s lead is not "loaded"', !s3.api.isLoaded('L1'));
    ok('…and the old bags are gone', !s3.win._photoCache.L1);
    const s4 = sandbox([], { cache: { L5: [{ id: 'early' }] } });
    s4.api.isLoaded('L5');
    ok('first sighting of the account keeps bags a surface already pushed', s4.win._photoCache.L5 && s4.win._photoCache.L5.length === 1);
  }

  console.log('\nWIRING — the boot no longer reads photos; pins/zones capped');
  {
    const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
    const a = boot.indexOf('async function loadLeads()');
    const b = boot.indexOf('window._loadLeads = loadLeads');
    const loadLeads = codeOnly(boot.slice(a, b));
    ok('found loadLeads', a > 0 && b > a);
    ok('loadLeads reads no photos collection', !/collection\(\s*db\s*,\s*['"]photos['"]/.test(loadLeads));
    ok('loadLeads issues no getDocs over photos at all', !/photos/.test(loadLeads.replace(/_photoCache/g, '')));
    const pa = boot.indexOf('async function loadPins()');
    const pins = codeOnly(boot.slice(pa, boot.indexOf('async function _savePin', pa)));
    const pinQueries = pins.match(/getDocs\(query\(collection\(db,'pins'\)[^;]*;/g) || [];
    ok('every pins getDocs carries limit(PIN_CAP)', pinQueries.length >= 2 && pinQueries.every((q) => /limit\(PIN_CAP\)/.test(q)), pinQueries.join(' | '));
    ok('pins ordered by createdAt desc (most recent first)', /orderBy\('createdAt','desc'\), limit\(PIN_CAP\)/.test(pins));
    ok('pins fall back on failed-precondition (index building) instead of an empty map', /failed-precondition/.test(pins));
    ok('legacy no-createdAt pins: count check before an unordered capped read', /getCountFromServer\(/.test(pins));
    const za = boot.indexOf('async function loadZones()');
    const zones = codeOnly(boot.slice(za, boot.indexOf('window.loadZones = loadZones', za)));
    ok('zones getDocs carries limit(ZONE_CAP)', /getDocs\(query\(collection\(db,'zones'\), scope, limit\(ZONE_CAP\)\)\)/.test(zones));
    const caps = boot.match(/const PIN_CAP = (\d+);[\s\S]{0,40}const ZONE_CAP = (\d+);/);
    ok('caps are defined and sane', !!caps && +caps[1] >= 500 && +caps[2] >= 100, caps && caps.slice(1).join('/'));
    ok('getCountFromServer is imported', /enableNetwork, getCountFromServer \}/.test(boot));
    const idx = JSON.parse(read('firestore.indexes.json'));
    const has = (f1) => idx.indexes.some((i) => i.collectionGroup === 'pins' && i.queryScope === 'COLLECTION' && i.fields.map((f) => f.fieldPath + ':' + f.order).join(',') === f1 + ':ASCENDING,createdAt:DESCENDING');
    ok('pins (userId, createdAt desc) index', has('userId'));
    ok('pins (companyId, createdAt desc) index', has('companyId'));
    const html = fs.readFileSync(path.join(PRO, 'dashboard.html'), 'utf8');
    ok('dashboard.html loads photo-cache.js deferred', /<script defer src="js\/photo-cache\.js\?v=\d+"><\/script>/.test(html));
  }

  console.log('\nWIRING — on-demand consumers ask NBDPhotoCache');
  {
    const boot = codeOnly(read('docs/pro/js/dashboard-bootstrap.module.js'));
    const pre = boot.slice(boot.indexOf('function _generateDocWithPreflight('), boot.indexOf('const data = _dashGetCustomerDocData(leadId);', boot.indexOf('function _generateDocWithPreflight(')));
    ok('doc preflight waits for the lead\'s photos ONCE before the prerequisite check', /ensure\(\[leadId\]\)\.then\(\(\) => _generateDocWithPreflight\(docType, leadId, true\)\)/.test(pre) && /!_photosReady/.test(pre));
    const stage = boot.slice(boot.indexOf('function _stageWindowStateForLead('), boot.indexOf('window._stageWindowStateForLead = _stageWindowStateForLead'));
    ok('staging kicks ensure and re-stages _allPhotos for the still-open lead', /_pc\.ensure\(\[leadId\]\)/.test(stage) && /window\._customerId === leadId/.test(stage));
    const act = codeOnly(read('docs/pro/js/dashboard-actions.js'));
    ok('job-detail hero repaints on nbd:photos-loaded for the open lead', /addEventListener\('nbd:photos-loaded'[\s\S]{0,200}_repaintJobDetailHero\(\)/.test(act));
    const hub = codeOnly(read('docs/pro/js/customer-photo-hub.js'));
    ok('Photos tab: mount asks for the lead and repaints on the event', /pc\.ensure\(\[leadId\]\)/.test(hub) && /'nbd:photos-loaded'[\s\S]{0,200}refresh\(\)/.test(hub));
    const ire = codeOnly(read('docs/pro/js/inspection-report-engine.js'));
    ok('inspection report waits once (no loop on a failed read)', /_photosTriedFor !== state\.leadId/.test(ire) && /_pc\.ensure\(\[state\.leadId\]\)/.test(ire));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
