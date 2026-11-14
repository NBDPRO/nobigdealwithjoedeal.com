/**
 * tests/lead-delete-owner-side-2026-11-14.test.js — the CRM client offers
 * "Delete lead" (a soft delete) and the Deleted bin's Restore only to a role
 * the rules let do it.
 *
 * WHY (2026-11-14, Jo's decision): managers do not delete leads; only the
 * owner side does. firestore.rules softDeleteWriteOk() now refuses a lead
 * update that sets or clears deleted / deletedAt / isDeleted unless the caller
 * is a platform admin, a company_admin of the lead's tenant, or the lead's own
 * non-viewer owner (tests/firestore-rules.lead-soft-delete.test.js proves the
 * rules side). This suite proves the CLIENT side by RUNNING the code:
 *
 *   A. crm-portal-bridge.js _mayDeleteLead (window.nbdMayDeleteLead) — the
 *      matrix, the same as the rule. (Not in role-gate.js: that file boots on
 *      customer.html too, whose shipped boot budget has no room left.)
 *   B. crm-portal-bridge.js deleteLead / confirmDeleteLead / bulkDelete —
 *      a manager on a teammate's lead gets an explanation, no dialog, no
 *      write; the owner side goes through.
 *   C. crm-portal-bridge.js renderDeletedDrawer — no Restore for a manager on
 *      a teammate's lead; Restore stays for the owner side.
 *   D. kanban-context-menu.js buildMenu — no "Delete lead" item for a manager
 *      on a teammate's lead; still there for its owner and a company_admin.
 *
 * NBD_ROOT=<dir> reads the docs/pro/js files from another tree (used to show
 * this suite fails on the code before the change).
 *
 * Zero deps.  Run: node tests/lead-delete-owner-side-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.NBD_ROOT || path.join(__dirname, '..');
const JS = path.join(ROOT, 'docs/pro/js');
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// The function that starts inside `anchor`; its end is found by the parser.
function extractFn(src, anchor, file) {
  const at = src.indexOf(anchor);
  if (at < 0 || src.indexOf(anchor, at + 1) >= 0) throw new Error(file + ': anchor not unique: ' + anchor);
  const kw = src.slice(at).search(/(async\s+)?function\b/);
  const start = at + kw;
  for (let i = src.indexOf('}', start); i >= 0; i = src.indexOf('}', i + 1)) {
    const cand = src.slice(start, i + 1);
    try { new Function('return (' + cand + ');'); return cand; } catch (_) { /* not yet */ }
  }
  throw new Error(file + ': could not find the end of ' + anchor);
}
function optionalFn(src, anchor, file) {
  try { return extractFn(src, anchor, file); } catch (_) { return ''; }
}

const CO = 'co-a';
const C = {
  platform: { role: 'admin' },
  coAdmin: { role: 'company_admin', companyId: CO },
  otherCoAdmin: { role: 'company_admin', companyId: 'co-b' },
  manager: { role: 'manager', companyId: CO },
  rep: { role: 'sales_rep', companyId: CO },
  viewer: { role: 'viewer', companyId: CO },
  solo: {},
};
const teammateLead = { id: 'L1', userId: 'alice', companyId: CO, firstName: 'Pat', lastName: 'Home' };
const managersOwn = { id: 'L2', userId: 'eve', companyId: CO, firstName: 'Mo', lastName: 'Own' };
const soloLead = { id: 'L3', userId: 'solo', companyId: 'solo', firstName: 'Sol', lastName: 'O' };

// ── helpers lifted from crm-portal-bridge.js ────────────────────────────────
// Module-level consts / lets the lifted functions close over, then the
// functions themselves. Missing pieces (the code before a change) are skipped,
// so the harness still runs and the checks say what is missing.
const BRIDGE = 'crm-portal-bridge.js';
function bridgeHelpers(src) {
  const lines = ['NO_LEAD_DELETE', 'LEAD_ROLE_LOADING'].map((n) => (src.match(new RegExp('^const ' + n + ' = [^\\n]*;$', 'm')) || [''])[0]);
  lines.push(/^let _binLeads = /m.test(src) ? 'let _binLeads = {};' : '');
  ['function _leadDeletePerm(', 'function _mayDeleteLead(', 'function _deleteRefusal(', 'function _rerenderBinIfOpen(']
    .forEach((a) => lines.push(optionalFn(src, a, BRIDGE)));
  return lines.join('\n');
}

// ── A ────────────────────────────────────────────────────────────────────────
function loadPerm(win) {
  const src = read(BRIDGE);
  const body = bridgeHelpers(src) + '\nreturn { perm: typeof _leadDeletePerm === "function" ? _leadDeletePerm : null,'
    + ' may: typeof _mayDeleteLead === "function" ? _mayDeleteLead : null };';
  return new Function('window', 'document', 'renderDeletedDrawer', body)(win, { getElementById: () => null }, () => {});
}
function partA() {
  console.log('A. _leadDeletePerm / _mayDeleteLead');
  const win = {};
  const { perm, may } = loadPerm(win);
  ok('crm-portal-bridge.js defines _leadDeletePerm', typeof perm === 'function');
  ok('crm-portal-bridge.js defines _mayDeleteLead', typeof may === 'function');
  const P = (lead, c, uid) => { win._userClaims = c; win._user = { uid }; return perm ? perm(lead) : '(none)'; };
  ok('a manager on a teammate\'s lead: no', P(teammateLead, C.manager, 'eve') === 'no');
  // Jo (2026-11-14, decision a): managers delete no lead, their own included.
  ok('a manager on a lead they own: no (managers delete no lead)', P(managersOwn, C.manager, 'eve') === 'no');
  ok('a rep on their own lead: yes', P(teammateLead, C.rep, 'alice') === 'yes');
  ok('a rep on a teammate\'s lead: no', P(managersOwn, C.rep, 'alice') === 'no');
  ok('a company_admin on a lead in their tenant: yes', P(teammateLead, C.coAdmin, 'carol') === 'yes');
  ok('another tenant\'s company_admin: no', P(teammateLead, C.otherCoAdmin, 'bob') === 'no');
  ok('a platform admin: yes', P(teammateLead, C.platform, 'pat') === 'yes');
  ok('a solo owner (no role claim) on their own lead: yes', P(soloLead, C.solo, 'solo') === 'yes');
  ok('a viewer, even their own lead: no', P({ id: 'V', userId: 'vic', companyId: CO }, C.viewer, 'vic') === 'no');
  ok('claims not loaded yet: loading (not a yes)', P(teammateLead, undefined, 'carol') === 'loading');
  win._leads = [teammateLead]; win._userClaims = C.manager; win._user = { uid: 'eve' };
  ok('looks a lead up by id in window._leads', !!perm && perm('L1') === 'no');
  ok('an id it cannot find: unknown (not a yes)', !!perm && perm('ghost') === 'unknown');
  win._userClaims = undefined; win._user = { uid: 'alice' };
  ok('_mayDeleteLead is false while claims load (the card menu hides Delete)', !!may && may(teammateLead) === false);
  win._userClaims = C.rep;
  ok('…and true once they say the rep owns it', !!may && may(teammateLead) === true);
  const S = read(BRIDGE);
  ok('exported as window.nbdMayDeleteLead for the card menu', /\nwindow\.nbdMayDeleteLead = _mayDeleteLead;/.test(S));
}

// ── B + C: crm-portal-bridge.js ──────────────────────────────────────────────
function loadBridge(claims, uid, leads, opts) {
  const o = opts || {};
  const src = read(BRIDGE);
  const body = [
    'let _pendingDeleteId = null;',
    bridgeHelpers(src),
    extractFn(src, 'function deleteLead(id)', BRIDGE),
    extractFn(src, 'function showDeleteConfirm(', BRIDGE),
    extractFn(src, 'async function confirmDeleteLead(', BRIDGE),
    extractFn(src, 'async function bulkDelete(', BRIDGE),
    extractFn(src, 'async function renderDeletedDrawer(', BRIDGE),
    extractFn(src, 'async function restoreDeletedLead(', BRIDGE),
    'return { deleteLead, confirmDeleteLead, bulkDelete, renderDeletedDrawer, restoreDeletedLead, pending: () => _pendingDeleteId,',
    '  rerender: typeof _rerenderBinIfOpen === "function" ? _rerenderBinIfOpen : null };',
  ].join('\n');
  const log = { toasts: [], writes: [], restores: [], dialogs: 0, asked: 0, binLoads: 0 };
  const overlay = { classList: { add() { log.dialogs++; }, remove() {} } };
  const drawerBody = { innerHTML: '', querySelectorAll: () => [] };
  const drawer = { classList: { contains: (c) => c === 'open' && !!o.drawerOpen } };
  const els = { delConfirmOverlay: overlay, delConfirmName: { textContent: '' }, deletedDrawerBody: drawerBody, deletedDrawer: drawer };
  const win = {
    _userClaims: claims, _user: { uid }, _leads: o.binOnly ? [] : leads,
    nbdConfirm: (m) => { log.asked++; log.askText = String(m); return Promise.resolve(true); },
    writeBatch: () => ({}), db: {}, doc: () => ({}),
    _restoreLead: (id) => { log.restores.push(id); return Promise.resolve(true); },
    _loadLeads: () => Promise.resolve(),
    __NBD_CALL_REGISTRY: {
      _deleteLead: (id) => { log.writes.push(['soft-delete', id]); return Promise.resolve(true); },
      _loadDeletedLeads: () => { log.binLoads++; return Promise.resolve(leads.map((l) => Object.assign({ deleted: true }, l))); },
    },
    stageLabel: (s) => s,
  };
  const selected = new Set();
  const fn = new Function('window', 'document', 'showToast', 'getBulkSelected', 'commitBulkLeadOp', 'loadLeads',
    'clearBulkSelection', 'toggleBulkMode', '_serverTimestamp', 'refreshTrashBadge', 'escHtml', body);
  const api = fn(win, { getElementById: (id) => els[id] || null }, (m, k) => log.toasts.push({ m: String(m), k }),
    () => selected,
    (ids) => { ids.forEach((id) => log.writes.push(['bulk-soft-delete', id])); return Promise.resolve({ applied: ids.length }); },
    () => Promise.resolve(), () => {}, () => {}, () => 'ts', () => {},
    (s) => String(s == null ? '' : s));
  return { api, log, selected, drawerBody, win };
}
const toasted = (b, re) => b.log.toasts.some((t) => re.test(t.m));

async function partB() {
  console.log('B. crm-portal-bridge.js delete paths');
  const leads = [teammateLead, managersOwn];

  let b = loadBridge(C.manager, 'eve', leads);
  b.api.deleteLead('L1');
  ok('manager → Delete on a teammate\'s lead opens no dialog', b.log.dialogs === 0, 'dialogs=' + b.log.dialogs);
  ok('…and explains who can', toasted(b, /owner or a company admin/), JSON.stringify(b.log.toasts));
  await b.api.confirmDeleteLead();
  ok('…and writes nothing', b.log.writes.length === 0, JSON.stringify(b.log.writes));

  b = loadBridge(C.manager, 'eve', leads);
  b.api.deleteLead('L2');
  ok('manager → Delete on their OWN lead is refused too (no dialog)', b.log.dialogs === 0);
  ok('…and explains who can', toasted(b, /owner or a company admin/), JSON.stringify(b.log.toasts));
  await b.api.confirmDeleteLead();
  ok('…and writes nothing', b.log.writes.length === 0, JSON.stringify(b.log.writes));

  b = loadBridge(C.coAdmin, 'carol', leads);
  b.api.deleteLead('L1');
  await b.api.confirmDeleteLead();
  ok('positive control: a company_admin deletes the teammate\'s lead', b.log.dialogs === 1 && b.log.writes.length === 1 && b.log.writes[0][1] === 'L1', JSON.stringify(b.log));

  b = loadBridge(C.rep, 'alice', leads);
  b.api.deleteLead('L1');
  await b.api.confirmDeleteLead();
  ok('positive control: a rep deletes their own lead', b.log.writes.length === 1 && b.log.writes[0][1] === 'L1');

  // Claims not loaded: no fail-open (review 2026-11-14).
  b = loadBridge(undefined, 'eve', leads);
  b.api.deleteLead('L2');
  ok('claims still loading → Delete opens no dialog', b.log.dialogs === 0);
  ok('…and says it is still loading', toasted(b, /[Ss]till loading/), JSON.stringify(b.log.toasts));
  b = loadBridge(undefined, 'eve', leads);
  b.selected.add('L2');
  await b.api.bulkDelete();
  ok('claims still loading → bulk Delete writes nothing and does not ask', b.log.writes.length === 0 && b.log.asked === 0, JSON.stringify(b.log));
  ok('…and says it is still loading', toasted(b, /[Ss]till loading/), JSON.stringify(b.log.toasts));

  // A single lead the cache does not hold, claims loaded: one doc, the rules decide.
  b = loadBridge(C.coAdmin, 'carol', leads);
  b.api.deleteLead('ghost');
  ok('positive control: an uncached lead still opens the dialog (one write, the rules decide)', b.log.dialogs === 1);

  // Bulk: anything not a clear yes is left out (one refused update fails the whole batch).
  b = loadBridge(C.rep, 'alice', leads);
  b.selected.add('L1'); b.selected.add('L2');
  await b.api.bulkDelete();
  ok('rep → bulk Delete over a teammate\'s lead + their own writes only their own',
    b.log.writes.length === 1 && b.log.writes[0][1] === 'L1', JSON.stringify(b.log.writes));
  ok('…the confirm says one will stay', /Delete 1 lead[\s\S]*1 you can't delete will stay/.test(b.log.askText || ''), b.log.askText);
  ok('…and the success toast says 1 skipped', toasted(b, /^Deleted 1 lead[\s\S]*1 skipped/), JSON.stringify(b.log.toasts));

  b = loadBridge(C.coAdmin, 'carol', leads);
  b.selected.add('L1'); b.selected.add('ghost');
  await b.api.bulkDelete();
  ok('bulk Delete leaves out an id the cache cannot vouch for (no fail-open)', b.log.writes.length === 1 && b.log.writes[0][1] === 'L1', JSON.stringify(b.log.writes));
  ok('…and counts it as skipped', toasted(b, /^Deleted 1 lead[\s\S]*1 skipped/), JSON.stringify(b.log.toasts));

  b = loadBridge(C.manager, 'eve', leads);
  b.selected.add('L1');
  await b.api.bulkDelete();
  ok('manager → bulk Delete of only a teammate\'s lead writes nothing', b.log.writes.length === 0, JSON.stringify(b.log.writes));
  ok('…does not even ask', b.log.asked === 0);
  ok('…and says why', toasted(b, /owner or a company admin[\s\S]*Nothing was deleted/), JSON.stringify(b.log.toasts));

  b = loadBridge(C.manager, 'eve', leads);
  b.selected.add('L2');
  await b.api.bulkDelete();
  ok('manager → bulk Delete of only their own lead writes nothing (managers delete no lead)', b.log.writes.length === 0 && b.log.asked === 0, JSON.stringify(b.log));

  b = loadBridge(C.rep, 'alice', leads);
  b.selected.add('L1');
  await b.api.bulkDelete();
  ok('positive control: rep → bulk Delete of only their own lead goes through', b.log.writes.length === 1 && b.log.writes[0][1] === 'L1', JSON.stringify(b.log));
  ok('…with no "skipped" in the toast', toasted(b, /^Deleted 1 lead/) && !toasted(b, /skipped/), JSON.stringify(b.log.toasts));

  b = loadBridge(C.coAdmin, 'carol', leads);
  b.selected.add('L1'); b.selected.add('L2');
  await b.api.bulkDelete();
  ok('positive control: a company_admin bulk-deletes both', b.log.writes.length === 2);
}

async function partC() {
  console.log('C. Deleted bin: Restore');
  const leads = [teammateLead];
  // Binned leads are not in window._leads (the loader drops deleted ones).
  let b = loadBridge(C.manager, 'eve', leads, { binOnly: true });
  await b.api.renderDeletedDrawer();
  ok('the bin renders the teammate\'s lead for a manager', /dc-L1/.test(b.drawerBody.innerHTML));
  ok('…with no Restore button', !/nbd-dc-restore/.test(b.drawerBody.innerHTML));
  await b.api.restoreDeletedLead('L1');
  ok('restoreDeletedLead itself refuses the manager (no un-delete write)', b.log.restores.length === 0, JSON.stringify(b.log.restores));
  ok('…and says who can', toasted(b, /owner or a company admin/), JSON.stringify(b.log.toasts));

  b = loadBridge(C.coAdmin, 'carol', leads, { binOnly: true });
  await b.api.renderDeletedDrawer();
  ok('positive control: a company_admin gets Restore', /nbd-dc-restore/.test(b.drawerBody.innerHTML));
  await b.api.restoreDeletedLead('L1');
  ok('positive control: …and restoreDeletedLead writes it', b.log.restores.join() === 'L1', JSON.stringify(b.log.restores));
  b = loadBridge(C.rep, 'alice', leads, { binOnly: true });
  await b.api.renderDeletedDrawer();
  ok('positive control: the lead\'s own rep gets Restore', /nbd-dc-restore/.test(b.drawerBody.innerHTML));
  b = loadBridge(C.manager, 'eve', [managersOwn], { binOnly: true });
  await b.api.renderDeletedDrawer();
  ok('a manager gets no Restore / Remove even on a lead they own', /dc-L2/.test(b.drawerBody.innerHTML) && !/nbd-dc-restore|nbd-dc-perm/.test(b.drawerBody.innerHTML));

  // One predicate: claims not loaded → the bin offers nothing (the guard refuses too).
  b = loadBridge(undefined, 'carol', leads, { binOnly: true });
  await b.api.renderDeletedDrawer();
  ok('claims still loading: the bin shows the lead with no Restore / Remove', /dc-L1/.test(b.drawerBody.innerHTML) && !/nbd-dc-restore|nbd-dc-perm/.test(b.drawerBody.innerHTML));

  // …and is drawn again once the leads (and so the claims) land.
  b = loadBridge(C.coAdmin, 'carol', leads, { binOnly: true, drawerOpen: true });
  ok('crm-portal-bridge.js defines _rerenderBinIfOpen', typeof b.api.rerender === 'function');
  if (b.api.rerender) {
    await b.api.rerender({ detail: { source: 'leads' } });
    ok('an open bin is re-rendered on nbd:data-refreshed (leads)', b.log.binLoads === 1, 'binLoads=' + b.log.binLoads);
    await b.api.rerender({ detail: { source: 'estimates' } });
    ok('…not on an estimates refresh', b.log.binLoads === 1, 'binLoads=' + b.log.binLoads);
  }
  b = loadBridge(C.coAdmin, 'carol', leads, { binOnly: true, drawerOpen: false });
  if (b.api.rerender) await b.api.rerender({ detail: { source: 'leads' } });
  ok('a closed bin is not re-rendered', b.log.binLoads === 0);
  ok('…the listener is registered', /window\.addEventListener\('nbd:data-refreshed', _rerenderBinIfOpen\)/.test(read(BRIDGE)));
}

function partD() {
  console.log('D. kanban card menu');
  const file = 'kanban-context-menu.js';
  const fnSrc = extractFn(read(file), 'function buildMenu(lead, x, y)', file);
  const run = (claims, uid, lead) => {
    let got = null;
    // The real bridge helper, as the dashboard exports it.
    const win = { _userClaims: claims, _user: { uid } };
    const { may } = loadPerm(win);
    if (may) win.nbdMayDeleteLead = may;
    const build = new Function('window', 'renderMenu', 'openSubmenu', 'buildStageSubmenuItems', 'buildTypeSubmenuItems',
      'copyToClipboard', '_toast', 'mapsUrl', 'return (' + fnSrc + ');')(win, (items) => { got = items; }, () => {}, () => [], () => [], () => {}, () => {}, () => '');
    build(lead, 1, 1);
    return (got || []).some((it) => /^Delete (lead|customer)/.test(it.label || ''));
  };
  ok('no "Delete lead" for a manager on a teammate\'s lead', run(C.manager, 'eve', teammateLead) === false);
  ok('no "Delete lead" for a manager even on their own lead', run(C.manager, 'eve', managersOwn) === false);
  ok('positive control: "Delete lead" for a company_admin', run(C.coAdmin, 'carol', teammateLead) === true);
  ok('positive control: "Delete lead" for the lead\'s own rep', run(C.rep, 'alice', teammateLead) === true);
}

function partE() {
  console.log('E. crm.js restore aliases');
  const crm = read('crm.js');
  ok('crm.js no longer defines the unguarded window.restoreLead alias', !/window\.restoreLead\s*=/.test(crm));
  ok('crm.js no longer defines the unguarded window.restoreDeletedLead alias', !/window\.restoreDeletedLead\s*=/.test(crm));
}

(async () => {
  partA();
  await partB();
  await partC();
  partD();
  partE();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
