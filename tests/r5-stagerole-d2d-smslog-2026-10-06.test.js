/**
 * tests/r5-stagerole-d2d-smslog-2026-10-06.test.js
 *
 * Phased review round 5, findings R5-8-3 and R5-8-4.
 *
 *   R5-8-3  window._saveLead (dashboard-bootstrap.module.js) wrote `stage` but
 *           never `stageRole`, so every lead made through it (quick add, call
 *           center, D2D convert, the Edit Lead form) landed with no role, the
 *           field every server classifier trusts first (functions/stage-roles.js
 *           roleFor). Migration 008 healed the backlog once; new leads drifted
 *           back. The D2D direct-write fallback and the sample-data seeder
 *           (demo.js) had the same gap. Each now stamps the role computed by the
 *           tenant-aware window.stageRole, and never writes undefined or a value
 *           outside the five roles firestore.rules stageWriteOk() accepts.
 *   R5-8-4  sendD2DSMS logged the KNOCK id as sms_log.leadId, so the text showed
 *           up on no customer's Communication Log (or the wrong one). It now
 *           logs the knock's linked lead (knock.leadId, set when the knock was
 *           converted) or null, and records the knock id in its own field.
 *
 * Behavioural where it can be: _saveLead is lifted out of the module and run
 * against stub Firestore writers; sendD2DSMS runs against a stub admin SDK.
 * The D2D / demo create paths are comment-stripped, brace-scoped source checks.
 *
 * Pure Node, no emulator. Run: node tests/r5-stagerole-d2d-smslog-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '\n       ' + detail : '')); }
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// Body of the first brace block that opens after `anchor`.
function bodyAfter(src, anchor) {
  const at = src.indexOf(anchor);
  if (at === -1) return null;
  const open = src.indexOf('{', at + anchor.length - 1);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

const VALID_ROLES = ['new', 'active', 'job', 'won', 'lost'];

(async () => {
  // ═══ R5-8-3 (a): _saveLead, run for real ═══════════════════════════════
  console.log('R5-8-3 _saveLead stamps stageRole (behavioural)');
  const DASH = 'docs/pro/js/dashboard-bootstrap.module.js';
  const dashRaw = read(DASH);
  const saveBody = bodyAfter(dashRaw, 'window._saveLead = async (data) =>');
  const helperBody = bodyAfter(dashRaw, 'function _stageRoleForWrite(stage)');
  ok('_saveLead found in ' + DASH, !!saveBody);
  ok('_stageRoleForWrite helper exists in ' + DASH, !!helperBody);

  // Built-in roles, plus one tenant custom stage the pipeline config re-roles
  // (what the resolved roleOf behind window.stageRole answers).
  const BUILTIN = { new: 'new', contacted: 'active', claim_filed: 'active', approved: 'active',
    job_created: 'job', closed: 'won', install_complete: 'won', lost: 'lost' };
  const LEGACY = { New: 'new', Approved: 'approved', 'In Progress': 'install_in_progress', Complete: 'install_complete', Lost: 'lost' };
  const tenantRoleOf = (k) => (k === 'custom_roof_walk' ? 'job' : (BUILTIN[k] || 'active'));
  const normalizeStage = (s) => (s === 'custom_roof_walk' ? s : (LEGACY[s] || String(s || '').toLowerCase() || 'new'));

  function makeSaveLead(winOver) {
    const writes = [];
    const win = Object.assign({
      _user: { uid: 'u1' }, _userClaims: { companyId: 'co1' }, _leads: [],
      _companyProfileLoaded: false, stageRole: tenantRoleOf, normalizeStage,
    }, winOver || {});
    const stubs = {
      window: win,
      db: {},
      collection: (_db, name) => ({ col: name }),
      doc: (_db, name, id) => ({ col: name, id }),
      addDoc: async (ref, payload) => { writes.push({ op: 'add', col: ref.col, payload }); return { id: 'new-' + writes.length }; },
      updateDoc: async (ref, payload) => { writes.push({ op: 'update', col: ref.col, id: ref.id, payload }); },
      serverTimestamp: () => '__ts__',
      geocode: async () => (win.__geo || null),
      loadLeads: async () => {}, loadPins: async () => {}, _savePin: async () => {},
      _optimisticInsertLead: () => {}, runTransaction: async () => null, showToast: () => {},
      normalizeStage,
      // the real _saveLead logs its customer-ID deferral etc.; keep the run quiet
      console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
    };
    const helper = helperBody
      ? new Function('window', 'return function _stageRoleForWrite(stage) ' + helperBody)(win)
      : undefined;
    const names = Object.keys(stubs).concat(['_stageRoleForWrite']);
    const vals = names.map((n) => (n === '_stageRoleForWrite' ? helper : stubs[n]));
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, 'return async (data) => ' + saveBody)(...vals);
    return { fn, writes, win };
  }

  if (saveBody) {
    // 1. New lead, no address → the inline addDoc fallback.
    {
      const { fn, writes } = makeSaveLead();
      await fn({ firstName: 'A', stage: 'new', source: 'Quick Add' });
      const w = writes.find((x) => x.op === 'add' && x.col === 'leads');
      ok('create (no-geocode fallback addDoc): stageRole "new" written beside stage "new"',
        w && w.payload.stageRole === 'new' && w.payload.stage === 'new', JSON.stringify(w && w.payload));
    }
    // 2. New lead with an address that geocodes → NBDRepos.leads.create.
    {
      const created = [];
      const { fn } = makeSaveLead({
        __geo: { lat: '39.1', lon: '-84.5' },
        NBDRepos: { leads: { create: async (p) => { created.push(p); return { id: 'r1' }; } } },
      });
      await fn({ firstName: 'B', address: '1 Main St', stage: 'claim_filed' });
      ok('create (geocoded NBDRepos.leads.create): stageRole "active" for claim_filed',
        created[0] && created[0].stageRole === 'active' && created[0].stage === 'claim_filed', JSON.stringify(created[0]));
    }
    // 3. Geocoded path, NBDRepos missing → its own inline addDoc.
    {
      const { fn, writes } = makeSaveLead({ __geo: { lat: '39.1', lon: '-84.5' } });
      await fn({ firstName: 'C', address: '2 Main St', stage: 'closed' });
      const w = writes.find((x) => x.op === 'add' && x.col === 'leads');
      ok('create (geocoded inline addDoc): stageRole "won" for closed',
        w && w.payload.stageRole === 'won', JSON.stringify(w && w.payload));
    }
    // 4. Tenant custom stage → the tenant-aware role (window.stageRole), not the
    //    ES import's built-in-only answer.
    {
      const { fn, writes } = makeSaveLead();
      await fn({ firstName: 'D', stage: 'custom_roof_walk' });
      const w = writes.find((x) => x.op === 'add');
      ok('create on a tenant custom stage: role comes from window.stageRole ("job")',
        w && w.payload.stageRole === 'job' && w.payload.stage === 'custom_roof_walk', JSON.stringify(w && w.payload));
    }
    // 5. Legacy display name: stage untouched, role from its normalised key.
    {
      const { fn, writes } = makeSaveLead();
      await fn({ firstName: 'E', stage: 'Complete' });
      const w = writes.find((x) => x.op === 'add');
      ok('create on legacy "Complete": stage kept as typed, stageRole "won"',
        w && w.payload.stage === 'Complete' && w.payload.stageRole === 'won', JSON.stringify(w && w.payload));
    }
    // 6. Edit with a stage → updateDoc carries the role.
    {
      const { fn, writes } = makeSaveLead();
      await fn({ id: 'lead-7', firstName: 'F', stage: 'lost' });
      const w = writes.find((x) => x.op === 'update' && x.id === 'lead-7');
      ok('edit with a stage: updateDoc writes stageRole "lost"',
        w && w.payload.stageRole === 'lost', JSON.stringify(w && w.payload));
    }
    // 7. Edit WITHOUT a stage (Edit Lead omits it when the select is blank or a
    //    stage move goes through commitStageChange) → no stageRole key at all.
    {
      const { fn, writes } = makeSaveLead();
      await fn({ id: 'lead-8', firstName: 'G' });
      const w = writes.find((x) => x.op === 'update' && x.id === 'lead-8');
      ok('edit without a stage: no stageRole key written (stored role left alone)',
        w && !Object.prototype.hasOwnProperty.call(w.payload, 'stageRole'), JSON.stringify(w && w.payload));
    }
    // 8. Never undefined / never a value the rules reject.
    {
      const { fn, writes } = makeSaveLead({ stageRole: () => undefined });
      await fn({ firstName: 'H', stage: 'new' });
      const w = writes.find((x) => x.op === 'add');
      ok('window.stageRole answering undefined: key omitted, lead still created',
        w && !Object.prototype.hasOwnProperty.call(w.payload, 'stageRole'), JSON.stringify(w && w.payload));
    }
    {
      const { fn, writes } = makeSaveLead({ stageRole: () => 'pending' });
      await fn({ firstName: 'I', stage: 'new' });
      const w = writes.find((x) => x.op === 'add');
      ok('window.stageRole answering a non-role ("pending"): key omitted (rules would deny the create)',
        w && !Object.prototype.hasOwnProperty.call(w.payload, 'stageRole'), JSON.stringify(w && w.payload));
    }
    {
      const { fn, writes } = makeSaveLead({ stageRole: undefined });
      let threw = null;
      try { await fn({ firstName: 'J', stage: 'new' }); } catch (e) { threw = e; }
      const w = writes.find((x) => x.op === 'add');
      ok('window.stageRole not loaded: lead still created, no stageRole key',
        !threw && w && !Object.prototype.hasOwnProperty.call(w.payload, 'stageRole'), threw ? String(threw) : JSON.stringify(w && w.payload));
    }
    // 9. Default stage unchanged: a lead with no stage gets no stage invented.
    {
      const { fn, writes } = makeSaveLead();
      await fn({ firstName: 'K' });
      const w = writes.find((x) => x.op === 'add');
      ok('create with no stage: no stage and no stageRole invented',
        w && !('stage' in w.payload) && !('stageRole' in w.payload), JSON.stringify(w && w.payload));
    }
  }

  // ─── source: the helper reads window.stageRole, not the ES import ───────
  if (helperBody) {
    const h = stripComments(helperBody);
    ok('_stageRoleForWrite calls window.stageRole', /window\.stageRole\s*\(/.test(h));
    ok('_stageRoleForWrite never calls the bare ES-import stageRole(', !/(^|[^.\w])stageRole\s*\(/.test(h));
  }
  if (saveBody) {
    const s = stripComments(saveBody);
    const stamp = s.search(/data\.stageRole\s*=\s*_\w+/);
    const firstWrite = s.search(/addDoc\(|NBDRepos\.leads\.create\(|updateDoc\(doc\(db,\s*'leads',\s*editId\)/);
    ok('_saveLead stamps data.stageRole BEFORE its first lead write', stamp !== -1 && firstWrite !== -1 && stamp < firstWrite,
      'stamp@' + stamp + ' firstWrite@' + firstWrite);
    ok('_saveLead computes it through _stageRoleForWrite', /_stageRoleForWrite\s*\(\s*data\.stage\s*\)/.test(s));
  }

  // ═══ R5-8-3 (b): the other client lead-create paths ═══════════════════
  console.log('R5-8-3 other lead-create paths');
  const ROLES_RE = /\[\s*'new',\s*'active',\s*'job',\s*'won',\s*'lost'\s*\]/;
  {
    const src = stripComments(read('docs/pro/js/d2d-tracker-core-2026b.js'));
    const body = bodyAfter(src, 'async function convertToLead(');
    ok('D2D convertToLead found', !!body);
    if (body) {
      const lit = bodyAfter(body, 'const leadData =');
      ok('D2D leadData carries stageRole', !!lit && /stageRole/.test(lit));
      ok('D2D role computed via window.stageRole(stage…)', /window\.stageRole\s*\(/.test(body));
      ok('D2D role limited to the five rules roles (no undefined / invalid write)', ROLES_RE.test(body));
      const fb = bodyAfter(body, "window.addDoc(window.collection(window._db, 'leads'),");
      ok('D2D direct-write fallback spreads leadData (so it carries stageRole)', !!fb && /\.\.\.leadData/.test(fb));
    }
  }
  {
    const src = stripComments(read('docs/pro/js/demo.js'));
    const body = bodyAfter(src, 'async function seedDemoLeads(');
    ok('demo.js seedDemoLeads found', !!body);
    if (body) {
      const add = bodyAfter(body, "addDoc(collection(db,'leads'),");
      ok('sample-data lead addDoc writes stageRole', !!add && /stageRole/.test(add));
      ok('sample-data role computed via window.stageRole', /window\.stageRole\s*\(/.test(body));
      ok('sample-data role limited to the five rules roles', ROLES_RE.test(body));
    }
  }
  {
    // Already stamped since R13 (2026-09-28); pinned here so this file lists
    // every client create path.
    const src = stripComments(read('docs/pro/js/data-import.js'));
    const body = bodyAfter(src, 'function prepareImportedLead(');
    ok('CSV import stamps stageRole via window.stageRole', !!body && /out\.stageRole\s*=\s*window\.stageRole\(/.test(body));
  }
  for (const f of ['docs/pro/js/tools.js', 'docs/pro/js/call-center-view.js', 'docs/pro/js/crm-leads.js']) {
    const src = stripComments(read(f));
    ok(f + ' creates leads through window._saveLead (inherits the stamp)', /await window\._saveLead\(/.test(src)
      && !/addDoc\(\s*(window\.)?collection\([^)]*'leads'\s*\)/.test(src));
  }

  // ═══ R5-8-4: sendD2DSMS logs the linked lead, not the knock ═══════════
  console.log('R5-8-4 sendD2DSMS sms_log leadId');
  const TS = { __ts: true };
  const NOON = Date.UTC(2026, 8, 18, 16, 0); // 12:00 EDT
  let world = null;
  const realLoad = Module._load;
  Module._load = function (request) {
    if (world && world.stubs[request] !== undefined) return world.stubs[request];
    return realLoad.apply(this, arguments);
  };
  function makeWorld(docsIn) {
    const docs = new Map(Object.entries(docsIn));
    let auto = 0;
    const twilioCalls = [];
    const resolve = (d) => { const o = {}; for (const [k, v] of Object.entries(d)) o[k] = v === TS ? NOON : v; return o; };
    function docRef(p) {
      return {
        path: p,
        collection: (sub) => colRef(p + '/' + sub),
        get: async () => {
          if (p.startsWith('sms_settings/') && !docs.has(p)) return { exists: true, data: () => ({ registered: true }) };
          return { exists: docs.has(p), data: () => docs.get(p) };
        },
        set: async (d, o) => { docs.set(p, (o && o.merge && docs.has(p)) ? Object.assign({}, docs.get(p), resolve(d)) : resolve(d)); },
        create: async (d) => { docs.set(p, resolve(d)); },
        update: async (d) => { docs.set(p, Object.assign({}, docs.get(p) || {}, resolve(d))); },
        delete: async () => { docs.delete(p); },
      };
    }
    function q(name) {
      const self = { where: () => self, orderBy: () => self, limit: () => self,
        get: async () => ({ empty: true, size: 0, docs: [] }) };
      return self;
    }
    function colRef(name) {
      return Object.assign(q(name), {
        add: async (row) => { const id = 'auto' + (++auto); docs.set(name + '/' + id, resolve(row)); return { id }; },
        doc: (id) => docRef(name + '/' + id),
      });
    }
    const db = { doc: docRef, collection: colRef, runTransaction: async (fn) => fn({
      get: async (r) => ({ exists: docs.has(r.path), data: () => docs.get(r.path) }),
      create: (r, d) => docs.set(r.path, resolve(d)), set: (r, d) => docs.set(r.path, resolve(d)) }) };
    const noop = () => {};
    const stubs = {
      'firebase-functions/v2/https': { onRequest: (o, h) => ({ __handler: h }) },
      'firebase-functions/v2/firestore': { onDocumentUpdated: (o, h) => ({ __handler: h }), onDocumentCreated: (o, h) => ({ __handler: h }) },
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'secret-' + n }) },
      'firebase-functions/v2': { logger: { error: noop, warn: noop, info: noop } },
      'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => TS } },
      'firebase-admin/auth': { getAuth: () => ({ verifyIdToken: async () => ({ uid: 'rep-1', companyId: 'co-1', email_verified: true }) }) },
      'firebase-admin/messaging': { getMessaging: () => ({ send: async () => {} }) },
      './integrations/upstash-ratelimit': { httpRateLimit: async () => true, enforceRateLimit: async () => ({ count: 1 }), clientIp: () => '203.0.113.9' },
      './shared': { requirePaidSubscription: async () => ({ ok: true, plan: 'growth' }), viewOnlyRefusal: () => null },
      './handlers/ai-texting': { generateAIDraft: async () => null, ANTHROPIC_API_KEY: { value: () => '' } },
      './ai-draft-routing': { isPortalDraft: () => false, clampPortalText: (s) => s },
      './portal-reply-effects': { applyRepReplyEffects: async () => {} },
      './integrations/heartbeat': { onSchedule: (o, h) => ({ __handler: h }) },
      twilio: Object.assign(() => ({ messages: { create: async (m) => { twilioCalls.push(m); return { sid: 'SM-' + twilioCalls.length }; } } }), { validateRequest: () => true }),
    };
    return { stubs, docs, twilioCalls };
  }
  async function runD2D(knock) {
    world = makeWorld({
      'knocks/k1': Object.assign({ userId: 'rep-1', companyId: 'co-1', phone: '(859) 555-0134', homeowner: 'Sam', smsConsent: true }, knock),
      'companyProfile/co-1': { brand: { legalName: 'Acme Roofing' } },
    });
    for (const f of ['sms-functions.js', 'sms-optout.js', 'phone-utils.js', 'inbound-sms-route-logic.js', 'sms-outbox-guard.js']) {
      delete require.cache[path.join(FUNCTIONS, f)];
    }
    const mod = require(path.join(FUNCTIONS, 'sms-functions.js'));
    require(path.join(FUNCTIONS, 'sms-outbox-guard.js')).nowMs = () => NOON;
    const res = { statusCode: 200, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.set = () => res; res.type = () => res; res.send = (b) => { res.body = b; return res; };
    await mod.sendD2DSMS.__handler({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { knockId: 'k1', templateKey: 'follow_up' } }, res);
    const rows = [...world.docs.entries()].filter(([p]) => p.startsWith('sms_log/')).map(([, d]) => d);
    return { res, row: rows[0] || null, twilio: world.twilioCalls.length };
  }
  {
    const r = await runD2D({ leadId: 'lead-9', convertedToLead: true });
    ok('converted knock: sent', r.res.statusCode === 200 && r.twilio === 1, r.res.statusCode + ' ' + JSON.stringify(r.res.body));
    ok('converted knock: sms_log.leadId is the LINKED lead (lead-9), not the knock id',
      r.row && r.row.leadId === 'lead-9', JSON.stringify(r.row));
    ok('converted knock: sms_log.knockId records the knock (k1)', r.row && r.row.knockId === 'k1', JSON.stringify(r.row));
    ok('comm-log contract intact: uid + date + companyId stamped',
      r.row && r.row.uid === 'rep-1' && r.row.date === NOON && r.row.companyId === 'co-1', JSON.stringify(r.row));
  }
  {
    const r = await runD2D({});
    ok('unconverted knock: sms_log.leadId is null (never the knock id)',
      r.res.statusCode === 200 && r.row && r.row.leadId === null, JSON.stringify(r.row));
    ok('unconverted knock: sms_log.knockId still records the knock', r.row && r.row.knockId === 'k1', JSON.stringify(r.row));
  }
  {
    const r = await runD2D({ leadId: { not: 'a string' } });
    ok('a non-string knock.leadId is not logged as a lead id', r.row && r.row.leadId === null, JSON.stringify(r.row));
  }
  Module._load = realLoad;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
