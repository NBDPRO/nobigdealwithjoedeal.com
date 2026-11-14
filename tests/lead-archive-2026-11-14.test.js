/**
 * tests/lead-archive-2026-11-14.test.js — Archive / Un-archive a lead.
 *
 * WHY (2026-11-14, Jo): managers no longer delete leads (#3082), so they
 * ARCHIVE them. leads/{id}.archived + archivedAt + archivedBy; firestore.rules
 * archiveWriteOk() checks the shape (tests/firestore-rules.lead-archive.test.js).
 * This suite proves the client by RUNNING the code:
 *
 *   A. dashboard-bootstrap.module.js _splitArchived — the loader keeps archived
 *      leads OUT of window._leads (board, kanban, map, search and every reader
 *      of the cache) and IN window._archivedLeads.
 *   B. crm-portal-bridge.js _leadArchivePerm / archiveLead / unarchiveLead —
 *      who may (owner unless a viewer, same-company manager / company_admin,
 *      platform admin), the exact write, refusals that write nothing.
 *   C. crm-portal-bridge.js renderArchivedDrawer — the Archived view lists the
 *      archived leads, escaped, with Un-archive only where allowed; redrawn
 *      when the leads land.
 *   D. kanban-context-menu.js buildMenu — "Archive lead" where allowed.
 *   E. markup + wiring — the drawer and its button in dashboard.html (no inline
 *      handlers), the close-map entry, the registry entries.
 *
 * NBD_ROOT=<dir> reads the files from another tree (used to show this suite
 * fails on the code before the change).
 *
 * Zero deps.  Run: node tests/lead-archive-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.env.NBD_ROOT || path.join(__dirname, '..');
const readAny = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const read = (f) => readAny('docs/pro/js/' + f);

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function extractFn(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0 || src.indexOf(anchor, at + 1) >= 0) return '';
  const kw = src.slice(at).search(/(async\s+)?function\b/);
  const start = at + kw;
  for (let i = src.indexOf('}', start); i >= 0; i = src.indexOf('}', i + 1)) {
    const cand = src.slice(start, i + 1);
    try { new Function('return (' + cand + ');'); return cand; } catch (_) { /* not yet */ }
  }
  return '';
}
const konst = (src, n) => (src.match(new RegExp('^const ' + n + ' = [^\\n]*;$', 'm')) || [''])[0];

const CO = 'co-a';
const C = {
  platform: { role: 'admin' },
  coAdmin: { role: 'company_admin', companyId: CO },
  manager: { role: 'manager', companyId: CO },
  otherMgr: { role: 'manager', companyId: 'co-b' },
  rep: { role: 'sales_rep', companyId: CO },
  viewer: { role: 'viewer', companyId: CO },
  solo: {},
};
const teammate = { id: 'L1', userId: 'alice', companyId: CO, firstName: 'Pat', lastName: 'Home', address: '1 Main St, Town, OH' };
const evil = { id: 'L9', userId: 'alice', companyId: CO, firstName: '<img src=x onerror=alert(1)>', lastName: '', archived: true, archivedAt: null, archivedBy: 'eve' };
const archivedOne = { id: 'A1', userId: 'alice', companyId: CO, firstName: 'Ann', lastName: 'Arch', archived: true, archivedBy: 'eve' };

// ── A ────────────────────────────────────────────────────────────────────────
function partA() {
  console.log('A. the loader splits archived leads out');
  const BOOT = read('dashboard-bootstrap.module.js');
  const src = extractFn(BOOT, 'function _splitArchived(');
  ok('dashboard-bootstrap.module.js defines _splitArchived', !!src);
  if (src) {
    const split = new Function('return (' + src + ');')();
    const r = split([{ id: 'a' }, { id: 'b', archived: true }, { id: 'c', archived: false }, { id: 'd', archived: 'yes' }]);
    ok('live keeps everything not archived === true', r.live.map((l) => l.id).join() === 'a,c,d', JSON.stringify(r));
    ok('archived holds only archived === true', r.archived.map((l) => l.id).join() === 'b', JSON.stringify(r));
  }
  ok('loadLeads assigns window._leads from the split (archived never reach the board, map or search)',
    /const _split = _splitArchived\(/.test(BOOT) && /window\._leads = _split\.live/.test(BOOT));
  ok('…and window._archivedLeads from it', /window\._archivedLeads = _split\.archived/.test(BOOT));
  ok('sign-out resets the archived cache too', /function _resetLeadsCache\(\) \{[\s\S]{0,200}window\._archivedLeads = undefined/.test(BOOT));
}

// ── B + C: crm-portal-bridge.js ──────────────────────────────────────────────
const BRIDGE = 'crm-portal-bridge.js';
function loadBridge(claims, uid, opts) {
  const o = opts || {};
  const src = read(BRIDGE);
  const parts = [konst(src, 'LEAD_ROLE_LOADING'), konst(src, 'NO_LEAD_ARCHIVE'),
    extractFn(src, 'function _leadArchivePerm(') + '\n' + extractFn(src, 'async function _writeArchive('), extractFn(src, 'async function archiveLead('),
    extractFn(src, 'async function unarchiveLead('), extractFn(src, 'function renderArchivedDrawer('),
    extractFn(src, 'function _rerenderArchivedIfOpen(')];
  const missing = ['_leadArchivePerm', 'archiveLead', 'unarchiveLead', 'renderArchivedDrawer', '_rerenderArchivedIfOpen']
    .filter((n, i) => !parts[i + 2]);
  const body = parts.join('\n') + '\nreturn {'
    + ['_leadArchivePerm', 'archiveLead', 'unarchiveLead', 'renderArchivedDrawer', '_rerenderArchivedIfOpen']
      .map((n) => n + ': typeof ' + n + ' === "function" ? ' + n + ' : null').join(', ') + ' };';
  const log = { toasts: [], writes: [], reloads: 0, listeners: [] };
  const drawerBody = { innerHTML: '', querySelectorAll: (sel) => (sel === '.nbd-ar-unarchive' ? log.buttons || [] : []) };
  const drawer = { classList: { contains: (c) => c === 'open' && !!o.drawerOpen, add() {}, remove() {} } };
  const els = { archivedDrawerBody: drawerBody, archivedDrawer: drawer };
  const win = {
    _userClaims: claims, _user: { uid },
    _leads: o.leads || [teammate], _archivedLeads: 'archived' in o ? o.archived : [archivedOne],
    db: {}, doc: (_db, c, id) => ({ c, id }),
    serverTimestamp: () => 'ts',
    updateDoc: (ref, patch) => { log.writes.push({ id: ref.id, patch }); return o.writeFails ? Promise.reject(Object.assign(new Error('denied'), { code: 'permission-denied' })) : Promise.resolve(); },
    _loadLeads: () => { log.reloads++; return Promise.resolve(); },
  };
  const api = new Function('window', 'document', 'showToast', 'escHtml', body)(
    win, { getElementById: (id) => els[id] || null }, (m, k) => log.toasts.push({ m: String(m), k }),
    (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
  return { api, log, win, drawerBody, missing };
}
const toasted = (b, re) => b.log.toasts.some((t) => re.test(t.m));

async function partB() {
  console.log('B. who may archive, and the write');
  let b = loadBridge(C.manager, 'eve');
  ok('crm-portal-bridge.js defines the archive helpers', b.missing.length === 0, 'missing: ' + b.missing.join(', '));
  const P = (claims, uid, lead) => { const x = loadBridge(claims, uid); return x.api._leadArchivePerm ? x.api._leadArchivePerm(lead) : '(none)'; };
  ok('a manager on a teammate\'s lead: yes', P(C.manager, 'eve', teammate) === 'yes');
  ok('a company_admin on a tenant lead: yes', P(C.coAdmin, 'carol', teammate) === 'yes');
  ok('the lead\'s own rep: yes', P(C.rep, 'alice', teammate) === 'yes');
  ok('another rep: no', P(C.rep, 'rick', teammate) === 'no');
  ok('a viewer, even their own lead: no', P(C.viewer, 'vic', { id: 'V', userId: 'vic', companyId: CO }) === 'no');
  ok('another tenant\'s manager: no', P(C.otherMgr, 'mo', teammate) === 'no');
  ok('a platform admin: yes', P(C.platform, 'pat', teammate) === 'yes');
  ok('a solo owner on their own lead: yes', P(C.solo, 'solo', { id: 'S', userId: 'solo', companyId: 'solo' }) === 'yes');
  ok('claims not loaded: loading', P(undefined, 'eve', teammate) === 'loading');
  b = loadBridge(C.manager, 'eve');
  ok('an archived lead is found by id (window._archivedLeads)', !!b.api._leadArchivePerm && b.api._leadArchivePerm('A1') === 'yes');

  b = loadBridge(C.manager, 'eve');
  const r = b.api.archiveLead ? await b.api.archiveLead('L1') : null;
  const w = b.log.writes[0];
  ok('manager → Archive writes the lead once', b.log.writes.length === 1 && w.id === 'L1', JSON.stringify(b.log.writes));
  ok('…archived: true, archivedAt: serverTimestamp, archivedBy: the caller',
    !!w && w.patch.archived === true && w.patch.archivedAt === 'ts' && w.patch.archivedBy === 'eve', w && JSON.stringify(w.patch));
  ok('…never touches deleted', !!w && !('deleted' in w.patch) && !('deletedAt' in w.patch));
  ok('…reloads the board and says where it went', b.log.reloads === 1 && toasted(b, /[Aa]rchived/), JSON.stringify(b.log.toasts));
  ok('…and resolves true', r === true);

  b = loadBridge(C.viewer, 'vic', { leads: [{ id: 'V', userId: 'vic', companyId: CO }] });
  const rv = b.api.archiveLead ? await b.api.archiveLead('V') : null;
  ok('viewer → Archive writes nothing and explains', b.log.writes.length === 0 && toasted(b, /owner, a manager or a company admin/) && rv === false, JSON.stringify(b.log));
  b = loadBridge(C.rep, 'rick');
  if (b.api.archiveLead) await b.api.archiveLead('L1');
  ok('another rep → Archive writes nothing', b.log.writes.length === 0 && toasted(b, /owner, a manager or a company admin/));
  b = loadBridge(undefined, 'eve');
  if (b.api.archiveLead) await b.api.archiveLead('L1');
  ok('claims still loading → Archive writes nothing and says so', b.log.writes.length === 0 && toasted(b, /[Ss]till loading/), JSON.stringify(b.log.toasts));
  b = loadBridge(C.manager, 'eve', { writeFails: true });
  const rf = b.api.archiveLead ? await b.api.archiveLead('L1') : null;
  ok('a refused write is reported, not a success toast', rf === false && toasted(b, /[Cc]ould not archive/) && !toasted(b, /^Lead archived/), JSON.stringify(b.log.toasts));

  b = loadBridge(C.manager, 'eve');
  const ru = b.api.unarchiveLead ? await b.api.unarchiveLead('A1') : null;
  const u = b.log.writes[0];
  ok('manager → Un-archive clears all three', !!u && u.id === 'A1' && u.patch.archived === false && u.patch.archivedAt === null && u.patch.archivedBy === null, u && JSON.stringify(u.patch));
  ok('…reloads and resolves true', b.log.reloads === 1 && ru === true);
  b = loadBridge(C.viewer, 'vic');
  if (b.api.unarchiveLead) await b.api.unarchiveLead('A1');
  ok('viewer → Un-archive writes nothing', b.log.writes.length === 0);
}

async function partC() {
  console.log('C. the Archived view');
  let b = loadBridge(C.manager, 'eve', { archived: [archivedOne, evil] });
  if (b.api.renderArchivedDrawer) b.api.renderArchivedDrawer();
  const h = b.drawerBody.innerHTML;
  ok('lists every archived lead', /ar-A1/.test(h) && /ar-L9/.test(h), h.slice(0, 120));
  ok('…with Un-archive for a manager', /nbd-ar-unarchive" data-id="A1"/.test(h));
  ok('…escaping lead text (no live tag)', !/<img/.test(h) && /&lt;img/.test(h));
  ok('…and no inline handler', !/\son[a-z]+=/i.test(h.replace(/&lt;[^]*?&gt;/g, '')));
  b = loadBridge(C.viewer, 'vic', { archived: [archivedOne] });
  if (b.api.renderArchivedDrawer) b.api.renderArchivedDrawer();
  ok('a viewer sees the list with no Un-archive', /ar-A1/.test(b.drawerBody.innerHTML) && !/nbd-ar-unarchive/.test(b.drawerBody.innerHTML));
  b = loadBridge(C.manager, 'eve', { archived: [] });
  if (b.api.renderArchivedDrawer) b.api.renderArchivedDrawer();
  ok('none archived: an empty state, not a blank drawer', /No archived leads/.test(b.drawerBody.innerHTML), b.drawerBody.innerHTML);
  b = loadBridge(C.manager, 'eve', { archived: undefined });
  if (b.api.renderArchivedDrawer) b.api.renderArchivedDrawer();
  ok('leads not loaded yet: Loading..., never "No archived leads"', /Loading/.test(b.drawerBody.innerHTML) && !/No archived/.test(b.drawerBody.innerHTML));
  // Un-archive buttons are wired with addEventListener.
  b = loadBridge(C.manager, 'eve', { archived: [archivedOne] });
  const btn = { dataset: { id: 'A1' }, handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } };
  b.log.buttons = [btn];
  if (b.api.renderArchivedDrawer) b.api.renderArchivedDrawer();
  ok('Un-archive buttons get a click listener', typeof btn.handlers.click === 'function');
  // Redrawn when the leads land.
  b = loadBridge(C.manager, 'eve', { drawerOpen: true, archived: [] });
  if (b.api._rerenderArchivedIfOpen) { b.win._archivedLeads = [archivedOne]; b.api._rerenderArchivedIfOpen({ detail: { source: 'leads' } }); }
  ok('an open Archived view is redrawn on nbd:data-refreshed (leads)', /ar-A1/.test(b.drawerBody.innerHTML));
  ok('…the listener is registered', /window\.addEventListener\('nbd:data-refreshed', _rerenderArchivedIfOpen\)/.test(read(BRIDGE)));
}

function partD() {
  console.log('D. kanban card menu');
  const fnSrc = extractFn(read('kanban-context-menu.js'), 'function buildMenu(lead, x, y)');
  const run = (may) => {
    let got = null;
    const win = { nbdMayArchiveLead: () => may, nbdArchiveLead: (id) => { win.archived = id; } };
    new Function('window', 'renderMenu', 'openSubmenu', 'buildStageSubmenuItems', 'buildTypeSubmenuItems',
      'copyToClipboard', '_toast', 'mapsUrl', 'return (' + fnSrc + ');')(win, (items) => { got = items; }, () => {}, () => [], () => [], () => {}, () => {}, () => '')(teammate, 1, 1);
    const it = (got || []).find((x) => /^Archive lead/.test(x.label || ''));
    if (it) it.onSelect();
    return { shown: !!it, archived: win.archived };
  };
  const yes = run(true);
  ok('"Archive lead" offered where allowed', yes.shown);
  ok('…and it archives that lead', yes.archived === 'L1');
  ok('not offered where refused', run(false).shown === false);
  const S = read(BRIDGE);
  ok('the bridge exports the two the menu reads', /\nwindow\.nbdArchiveLead = archiveLead;/.test(S) && /\nwindow\.nbdMayArchiveLead = /.test(S));
}

function partE() {
  console.log('E. markup and wiring');
  const html = readAny('docs/pro/dashboard.html');
  const m = html.match(/<div class="deleted-drawer" id="archivedDrawer">[\s\S]*?id="archivedDrawerBody"[\s\S]*?<\/div>\s*<\/div>/);
  ok('dashboard.html has the Archived drawer (Deleted bin layout)', !!m);
  ok('…closed through the closeModal dispatcher', !!m && /data-action="closeModal" data-target="archivedDrawer"/.test(m[0]));
  ok('…with no inline handler', !!m && !/\son[a-z]+=/i.test(m[0]));
  ok('the tools menu opens it through the call dispatcher', /data-action="call" data-fn="openArchivedDrawer"/.test(html));
  ok('dashboard-state.js maps archivedDrawer to its close handler', /archivedDrawer:\s*'closeArchivedDrawer'/.test(read('dashboard-state.js')));
  const S = read(BRIDGE);
  ok('the registry carries openArchivedDrawer / closeArchivedDrawer', /openArchivedDrawer: openArchivedDrawer/.test(S) && /closeArchivedDrawer: closeArchivedDrawer/.test(S));
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
