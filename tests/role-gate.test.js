/**
 * tests/role-gate.test.js — the CRM client must be honest that 'viewer' is a
 * read-only role.
 *
 * WHY (2026-09-25, Jo's decision B, final): "The 'viewer' role is READ-ONLY
 * everywhere: a viewer can read what their company role allows but cannot
 * create, update or delete any tenant data — including rows under leads they
 * own." firestore.rules / storage.rules now refuse those writes (the rules
 * suites prove that side: firestore-rules.test.js 34, the cross-tenant suite
 * section I, storage-rules.test.js 29). This suite proves the CLIENT side,
 * docs/pro/js/role-gate.js plus the guards it asks the core save functions to
 * call, by RUNNING them, not by matching their source:
 *
 *   A. role-gate.js in a sandbox with a minimal fake DOM:
 *      - the <html> class follows window._userClaims through the accessor
 *        (every later assignment, not only the first);
 *      - guard() refuses and explains for a viewer, is silent for every
 *        other role, a claim-less solo included;
 *      - a write refused with permission-denied while the user is a viewer
 *        produces the "Your role is view-only" notice, and the caller still
 *        receives the ORIGINAL rejection (nothing is swallowed); other roles
 *        and other errors stay silent; successes pass through untouched;
 *      - for every OTHER role the wrapper returns the very same promise with
 *        no handler attached, so an un-awaited failed write still raises an
 *        unhandled rejection (the event Sentry reports from) — review of
 *        #1776: the observer used to ride every role's writes and hid them;
 *      - the capture-phase click guard stops a gated control for a viewer
 *        (before the page's own delegate) and leaves everyone else alone;
 *      - the gated selector covers the write controls the brief names and
 *        none of a viewer's own user-scoped controls.
 *   B. Each of the 37 guarded entry points, extracted from its real file and
 *      executed: for a viewer it returns at the guard having touched nothing
 *      but window.NBDRole; for a sales_rep it goes past the guard.
 *
 * Zero deps.  Run: node tests/role-gate.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'docs/pro/js');
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ── A. role-gate.js in a sandbox ─────────────────────────────────────────────
function fakeDom() {
  const listeners = [];
  const byId = {};
  const classes = new Set();
  const mk = (tag) => ({
    tagName: String(tag).toUpperCase(), id: '', style: {}, textContent: '', children: [],
    setAttribute() {}, appendChild(c) { this.children.push(c); if (c.id) byId[c.id] = c; return c; },
    parentNode: null,
  });
  const head = mk('head');
  const body = mk('body');
  const documentElement = {
    classList: {
      toggle(c, on) { if (on) classes.add(c); else classes.delete(c); return on; },
      contains(c) { return classes.has(c); },
    },
    appendChild(c) { return head.appendChild(c); },
  };
  const document = {
    documentElement, head, body,
    getElementById: (id) => byId[id] || null,
    createElement: mk,
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: !!capture }); },
  };
  return { document, listeners, classes, head };
}

function loadGate() {
  const dom = fakeDom();
  const toasts = [];
  const win = {
    document: dom.document,
    showToast: (msg, kind) => toasts.push({ msg, kind }),
    Date, setTimeout, clearTimeout, Object, Array, String, Promise, console,
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(read('role-gate.js'), ctx, { filename: 'role-gate.js' });
  return { win, dom, toasts, ctx };
}
const tick = () => new Promise((r) => setImmediate(r));

async function partA() {
  console.log('A. role-gate.js');
  const { win, dom, toasts } = loadGate();
  const R = win.NBDRole;
  ok('NBDRole is defined', !!R && typeof R.guard === 'function');
  ok('no claims yet: not a viewer, no class', !R.isViewer() && !dom.classes.has('nbd-role-viewer'));

  // The accessor: the bootstrap assigns window._userClaims AFTER role-gate runs.
  win._userClaims = { role: 'viewer', companyId: 'co-x' };
  ok('assigning viewer claims turns the class on', dom.classes.has('nbd-role-viewer'));
  ok('…and the value reads back unchanged', win._userClaims.role === 'viewer' && win._userClaims.companyId === 'co-x');
  win._userClaims = { role: 'sales_rep', companyId: 'co-x' };
  ok('a later assignment (sales_rep) turns it off again', !dom.classes.has('nbd-role-viewer'));
  for (const c of [{}, { companyId: 'co-d' }, { role: 'manager', companyId: 'co-x' }, { role: 'company_admin', companyId: 'co-x' }, { role: 'admin' }]) {
    win._userClaims = c;
    ok('not read-only: ' + JSON.stringify(c), !R.isViewer() && R.canWrite() && !dom.classes.has('nbd-role-viewer'));
  }

  // guard(): refuse + explain for a viewer only.
  toasts.length = 0;
  win._userClaims = { role: 'sales_rep' };
  ok('guard() passes a sales_rep silently', R.guard() === true && toasts.length === 0);
  win._userClaims = { role: 'viewer' };
  const g = R.guard();
  ok('guard() refuses a viewer', g === false);
  ok('…and says "Your role is view-only"', toasts.length === 1 && /Your role is view-only/.test(toasts[0].msg), JSON.stringify(toasts));
  R.guard();
  ok('a burst of refusals shows one notice, not one per call', toasts.length === 1);

  // Layer 3: watched writes. Assigned AFTER role-gate loaded, like the bootstraps do.
  const denied = () => Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
  const orig = function addDoc() { return Promise.reject(denied()); };
  win.addDoc = orig;
  ok('window.addDoc assigned later is wrapped', win.addDoc !== orig && win.addDoc.__nbdRoleGate === true);
  win.addDoc = win.addDoc;
  ok('re-assigning a wrapped function does not wrap it twice', win.addDoc.__nbdRoleGate === true);

  const resetNotice = () => { toasts.length = 0; };
  // viewer + permission-denied → notice, and the caller still sees the rejection
  resetNotice();
  win._userClaims = { role: 'viewer' };
  R._resetNoticeThrottle(); // start a fresh notice burst
  let caught = null;
  try { await win.addDoc('coll', {}); } catch (e) { caught = e; }
  await tick();
  ok('the caller still receives the original rejection', caught && caught.code === 'permission-denied');
  ok('a viewer refused by the rules is told why', toasts.length === 1 && /view-only/.test(toasts[0].msg));

  // other role, same rejection → silent (the caller's own error handling applies).
  // Reset the burst throttle first, or the viewer notice just above would
  // mask a wrongly-shown one here.
  R._resetNoticeThrottle();
  resetNotice();
  win._userClaims = { role: 'sales_rep' };
  try { await win.addDoc('coll', {}); } catch (_) { /* expected */ }
  await tick();
  ok('a sales_rep refused for another reason gets no view-only notice', toasts.length === 0);

  // viewer + a non-permission error → silent
  R._resetNoticeThrottle();
  resetNotice();
  win._userClaims = { role: 'viewer' };
  win.updateDoc = () => Promise.reject(Object.assign(new Error('offline'), { code: 'unavailable' }));
  try { await win.updateDoc('d', {}); } catch (_) { /* expected */ }
  await tick();
  ok('a viewer hit by an unrelated error (unavailable) gets no view-only notice', toasts.length === 0);

  // successes pass through untouched
  win.setDoc = () => Promise.resolve('RESULT');
  ok('a successful write resolves to the same value', (await win.setDoc('d', {})) === 'RESULT' && toasts.length === 0);

  // writeBatch().commit, runTransaction, storage uploads are watched too
  for (const [name, install, call] of [
    ['writeBatch().commit', () => { win.writeBatch = () => ({ set() {}, commit: () => Promise.reject(denied()) }); }, () => win.writeBatch().commit()],
    ['runTransaction', () => { win.runTransaction = () => Promise.reject(denied()); }, () => win.runTransaction(null, () => {})],
    ['uploadBytes (storage/unauthorized)', () => { win.uploadBytes = () => Promise.reject(Object.assign(new Error('User does not have permission'), { code: 'storage/unauthorized' })); }, () => win.uploadBytes('r', 'b')],
    ['deleteDoc', () => { win.deleteDoc = () => Promise.reject(denied()); }, () => win.deleteDoc('d')],
  ]) {
    R._resetNoticeThrottle();
    resetNotice();
    install();
    let rejected = false;
    try { await call(); } catch (_) { rejected = true; }
    await tick();
    ok(name + ': viewer refusal is explained and still rejects', rejected && toasts.length === 1);
  }

  // Every OTHER role's write is left exactly as it was (review of #1776,
  // 2026-09-25). Attaching any handler marks a promise handled, so when the
  // observer rode every role's writes, an owner's / rep's un-awaited write
  // that failed stopped raising 'unhandledrejection' — the event Sentry's
  // global handler reports from (maps-routing.js fires its ml_training_data
  // addDoc and forgets it). Proven the way the browser sees it: a bare call,
  // nobody awaiting, and Node's own unhandled-rejection tracking.
  const unhandled = [];
  const onUR = (reason) => { unhandled.push(String((reason && reason.code) || reason)); };
  process.on('unhandledRejection', onUR);
  try {
    for (const c of [{ role: 'sales_rep', companyId: 'co-x' }, { role: 'manager', companyId: 'co-x' },
      { role: 'company_admin', companyId: 'co-x' }, {}]) {
      const who = c.role || 'no role claim (solo)';
      win._userClaims = c;
      unhandled.length = 0;
      let made = null;
      win.deleteDoc = () => (made = Promise.reject(denied()));
      const p = win.deleteDoc('d');            // fire-and-forget
      ok(who + ': the wrapper hands back the very same promise', p === made);
      await tick(); await tick();
      ok(who + ': an un-awaited refused write still raises an unhandled rejection',
        unhandled.length === 1 && unhandled[0] === 'permission-denied', JSON.stringify(unhandled));
      // Left unhandled on purpose: the listener above already consumed it, and
      // a late .catch() would only print PromiseRejectionHandledWarning.
    }
    // A viewer's bare refused write IS observed: explained on screen, and not
    // reported as an app failure (it is the rules working).
    win._userClaims = { role: 'viewer' };
    R._resetNoticeThrottle();
    resetNotice();
    unhandled.length = 0;
    win.deleteDoc = () => Promise.reject(denied());
    win.deleteDoc('d');
    await tick(); await tick();
    ok('viewer: a fire-and-forget refused write is explained, not reported as unhandled',
      toasts.length === 1 && unhandled.length === 0, 'toasts=' + toasts.length + ' unhandled=' + JSON.stringify(unhandled));
  } finally {
    process.removeListener('unhandledRejection', onUR);
  }

  // Layer 2: the capture-phase click guard.
  const clickL = dom.listeners.find((l) => l.type === 'click');
  const keyL = dom.listeners.find((l) => l.type === 'keydown');
  ok('click guard registered in the CAPTURE phase', !!clickL && clickL.capture === true);
  ok('keydown guard registered in the CAPTURE phase', !!keyL && keyL.capture === true);
  const ev = (matches, extra) => {
    const e = Object.assign({
      type: 'click', prevented: false, stopped: false,
      target: { tagName: 'DIV', closest: (sel) => (sel === win.NBDRole._gatedSelector && matches ? {} : null) },
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
    }, extra || {});
    return e;
  };
  R._resetNoticeThrottle();
  resetNotice();
  win._userClaims = { role: 'viewer' };
  let e1 = ev(true); clickL.fn(e1);
  ok('viewer click on a gated control: stopped before the page delegate + explained', e1.prevented && e1.stopped && toasts.length === 1);
  let e2 = ev(false); clickL.fn(e2);
  ok('viewer click on an ungated control passes through', !e2.prevented && !e2.stopped);
  win._userClaims = { role: 'manager', companyId: 'co-x' };
  let e3 = ev(true); clickL.fn(e3);
  ok('manager click on the same gated control passes through', !e3.prevented && !e3.stopped);
  win._userClaims = { role: 'viewer' };
  let e4 = ev(true, { type: 'keydown', key: 'Enter' }); keyL.fn(e4);
  ok('viewer Enter on a gated non-native control is stopped', e4.prevented && e4.stopped);
  let e5 = ev(true, { type: 'keydown', key: 'a' }); keyL.fn(e5);
  ok('ordinary typing is never intercepted', !e5.prevented && !e5.stopped);
  let e6 = ev(true, { type: 'keydown', key: ' ', target: { tagName: 'TEXTAREA', closest: () => ({}) } }); keyL.fn(e6);
  ok('Space inside a text field is never intercepted', !e6.prevented && !e6.stopped);
  // The ⓘ "Preview blank template" button sits INSIDE a generateCustomerDoc
  // tile (gated). It writes nothing, so a viewer's click on it goes through.
  R._resetNoticeThrottle();
  resetNotice();
  const inTile = (sel) => (sel === R._readInside || sel === R._gatedSelector ? {} : null);
  let e7 = ev(true, { target: { tagName: 'BUTTON', closest: inTile } }); clickL.fn(e7);
  ok('viewer click on the blank-preview ⓘ inside a gated tile goes through', !e7.prevented && !e7.stopped && toasts.length === 0);
  ok('…and the exemption is exactly that control', R._readInside === '[data-action="_previewBlankDoc"]', R._readInside);

  // The selector: the brief's minimum list is covered…
  const S = win.NBDRole._gatedSelector;
  const has = (s) => S.split(',').includes(s);
  const A = (a) => '[data-action="' + a + '"]';
  const F = (f) => '[data-action="call"][data-fn="' + f + '"]';
  const MUST = {
    'notes add/edit': [A('quickAddNote'), A('saveNote'), A('openNotesModal'), '#quickNoteWrap', F('_mJdQuickAddNote')],
    'tasks': [A('openTaskModal'), A('saveTask'), F('addTask'), F('cdaOpenTaskModal'), '.nbd-tl-task', '.nbd-tl-task-check'],
    'drawings save': [F('saveDrawingToCustomer')],
    'documents generate/upload/sign/delete': [A('openDocCreateModal'), A('_pickCustomerDoc'), A('generateCustomerDoc'), A('uploadSignedDoc'), A('openDocUploadModal'), A('deleteCustomerDoc'), A('docgen'), F('saveDocUpload')],
    'photo upload/edit': [A('openUploadModal'), A('uploadPhotos'), A('deletePhoto'), A('applyBulkPhotoDelete'), A('quickSetPhase'), '.nbd-share-toggle'],
    'estimate save': [A('openEstimateModal'), A('saveEstimate'), A('newEstimate'), F('startNewEstimate'), F('saveEstimate'), '#editEstimateBtn', '#deleteEstimateBtn'],
    'lead create/edit/delete': [A('openEditCustomerModal'), A('saveCustomerEdits'), A('progressStage'), F('openLeadModal'), F('saveLead'), F('editCardDetails'), F('confirmDeleteLead'), F('bulkMoveStage'), F('_mCreate'), A('edit-lead'), A('delete-lead'), A('move-card')],
    'kanban next action + job checklist (kept visible, blocked)': ['[data-action="run-next-action"]', '[data-change-action="toggleJobChecklistItem"]'],
    // Review of #1776 (2026-09-25): still offered to a viewer, failing with a
    // generic error or a bare toast once the rules refused them.
    'estimates list duplicate/rename/assign/delete': ['.est-act-btn[data-act="duplicate"]', '.est-act-btn[data-act="rename"]',
      '.est-act-btn[data-act="assign"]', '.est-act-btn[data-act="delete"]', '.est-lead-chip.unassigned'],
    'EstimatePreview + customer estimate hub writes': ['[data-ep-action="assign"]', '[data-ep-action="duplicate"]', '[data-ep-action="archive"]',
      '[data-ceh-act="primary"]', '[data-ceh-act="duplicate"]', '[data-ceh-act="assign"]', '[data-ceh-act="archive"]', '[data-ceh-act="new"]'],
    'expenses log/supplier/recurring/delete': ['[data-exp-action="open-form"]', '[data-exp-action="open-supplier"]',
      '[data-exp-action="add-recurring"]', '[data-exp-action="del-recurring"]', '[data-exp-action="del-supplier"]', '[data-exp-action="delete"]'],
    'knock, kanban "+ task", phone Task, portal reply, rules self-test, follow-up sends': [F('openD2DOrGo'), '.kc-task-badge.empty',
      '#nbd-quick-action-bar .qab-task', '#repMsgText', '#repMsgSend', F('testFirestoreRules'), '[data-csf-action="sms"]', '[data-csf-action="email"]'],
    'document generation (kept visible, blocked)': [A('docgen'), A('generateCustomerDoc')],
    // 2026-09-25 (callables follow-up): each reaches a Cloud Function that now
    // refuses a viewer (functions/shared.js assertNotViewer).
    'storm proof, portal link share/revoke, enrich data, auto-measure, deal accept link, roof report order, AI photo analysis':
      [F('verifyStormProofForLead'), F('cdaSharePortalLink'), F('cdaRevokePortalLink'), F('enrichReportData'), '#v2measureBtn',
        '[data-cb-action="sendSMS"]', '[data-cb-action="sendEmail"]', '[data-cb-action="copyLink"]',
        '[data-d2d-action="orderRoofReport"]', '.pa-analyze-btn'],
    // 2026-09-25 (#1780 review): resolveAddress now refuses a viewer; these
    // bill it and then rewrite the knock.
    'D2D address re-verify, one knock and the batch':
      ['[data-d2d-action="reverifyKnock"]', '[data-d2d-action="reverifyPending"]'],
  };
  for (const [what, sels] of Object.entries(MUST)) {
    const missing = sels.filter((s) => !has(s));
    ok('gated: ' + what, missing.length === 0, 'missing ' + missing.join(' '));
  }
  // …and a viewer's own user-scoped / read-only controls are NOT.
  const MUST_NOT = [F('_saveSettings'), F('_saveNotifSettings'), F('markAllNotificationsRead'), F('clearAllNotifications'),
    A('exportCustomerPDF'), A('filterPhotos'), A('filterTimeline'), A('togglePresentationMode'), A('_previewBlankDoc'),
    F('exportLeadsCSV'), F('crmViewBoard'), A('goTo'), A('signOut'), F('openSettingsTab'),
    // reading an estimate, a receipt, an export; calling the homeowner
    '.est-act-btn[data-act="open"]', '[data-ep-action="edit"]', '[data-ceh-act="edit"]', '[data-ceh-act="toggle"]',
    '[data-exp-action="export-csv"]', '[data-exp-action="receipt"]', '[data-csf-action="dismiss"]', '#nbd-quick-action-bar .qab-call',
    // 2026-09-25: reading a deal room, and opening a lead's photos / docs
    '[data-cb-action="preview"]', F('openPhotosForLead'), F('openDocsForLead'),
    // 2026-09-25 (#1780 review): the knock detail's owner & roof intel (lookupParcel stays open: reading)
    '[data-d2d-action="loadPropertyIntel"]'];
  const wrong = MUST_NOT.filter(has);
  ok('not gated: settings, notification read state, exports, filters, navigation', wrong.length === 0, 'gated by mistake: ' + wrong.join(' '));

  // Layer 1: the stylesheet hides exactly the HIDE list, only under the class.
  const style = dom.head.children.find((c) => c.id === 'nbdRoleGateStyle');
  ok('style injected', !!style);
  ok('style hides gated controls only under html.nbd-role-viewer',
    !!style && /html\.nbd-role-viewer \[data-action="quickAddNote"\]/.test(style.textContent)
      && /display:none!important/.test(style.textContent)
      && !/html\.nbd-role-viewer \.nbd-tl-task/.test(style.textContent));
  // Block-only controls stay on screen: the Templates rows (their category
  // headers count them) and the customer page's tiles (the ⓘ lives inside).
  ok('document generation rows/tiles are NOT hidden (block-only)', !!style
    && !/html\.nbd-role-viewer \[data-action="docgen"\]/.test(style.textContent)
    && !/html\.nbd-role-viewer \[data-action="generateCustomerDoc"\]/.test(style.textContent)
    && !/html\.nbd-role-viewer \.est-lead-chip/.test(style.textContent));
  ok('the estimates-card write buttons ARE hidden', !!style
    && /html\.nbd-role-viewer \.est-act-btn\[data-act="duplicate"\]/.test(style.textContent)
    && /html\.nbd-role-viewer \.est-act-btn\[data-act="delete"\]/.test(style.textContent));
}

// ── B. The 37 guarded entry points, executed ─────────────────────────────────
// Find the function that starts inside `anchor` and return its full source.
// The end is found by the parser, not by counting braces: the first `}` after
// which the text compiles as a function expression is the matching one (any
// earlier `}` leaves it unterminated, including a `}` inside a string).
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

class Proceeded extends Error {}
// A scope in which every free identifier resolves through a Proxy. Any access
// other than window.NBDRole (and the per-case `pre` bindings that run BEFORE
// the guard) throws Proceeded, so "returned at the guard" is observable.
function runGuarded(fnSrc, role, pre, args) {
  const touched = [];
  let guardCalls = 0;
  const NBDRole = {
    guard() { guardCalls++; return role !== 'viewer'; },
    canWrite() { return role !== 'viewer'; },
  };
  const trip = (what) => { touched.push(what); throw new Proceeded(what); };
  const win = new Proxy({}, {
    get(_, k) { if (k === 'NBDRole') return NBDRole; if (typeof k === 'symbol') return undefined; return trip('window.' + String(k)); },
    set(_, k) { return trip('window.' + String(k) + '='); },
  });
  const bindings = Object.assign({ window: win }, pre || {});
  const scope = new Proxy(bindings, {
    has(_, k) { return typeof k !== 'symbol'; },
    get(t, k) {
      if (typeof k === 'symbol') return undefined;
      if (Object.prototype.hasOwnProperty.call(t, k)) return t[k];
      return trip(String(k));
    },
    set(t, k, v) { if (Object.prototype.hasOwnProperty.call(t, k)) { t[k] = v; return true; } return trip(String(k) + '='); },
  });
  const fn = new Function('scope', 'with (scope) { return (' + fnSrc + '); }')(scope);
  let result, threw = null;
  try { result = fn.apply(undefined, args || []); } catch (e) { threw = e; }
  return { result, threw, touched, guardCalls };
}

async function partB() {
  console.log('B. guarded entry points (executed)');
  const NOOP = () => {};
  const CASES = [
    ['customer-photo-report-generator.js', 'window.uploadDocuments = async function() {'],
    ['customer-photo-report-generator.js', 'window.saveNote = async function() {'],
    ['customer-photo-report-generator.js', 'window.quickAddNote = async function () {'],
    ['customer-photo-report-generator.js', 'window.openEstimateModal = function() {'],
    ['customer-photo-report-generator.js', 'window.saveEstimate = async function() {'],
    ['customer-tasks-ui.js', 'window.openTaskModal = function() {'],
    ['customer-tasks-ui.js', 'window.saveEvent = async function() {'],
    ['customer-tasks-ui.js', 'window.saveTask = async function() {'],
    ['customer-tasks-ui.js', 'window.openDocCreateModal = function() {'],
    ['customer-tasks-ui.js', 'window.generateCustomerDoc = async function(type) {', null, ['contract']],
    ['customer-documents.js', 'window.deleteCustomerDoc = async function (docId, label) {', null, ['d1', 'Contract']],
    ['customer-signed-doc-upload.js', 'function uploadSignedDoc(mode) {', null, ['file']],
    ['warranty-claim.js', 'async function promptIntake(lead) {', null, [{ id: 'l1' }], false],
    ['warranty-claim.js', 'async function promptResolution(lead) {', null, [{ id: 'l1', openWarrantyClaimId: 'c1' }], false],
    ['customer-bootstrap.module.js', 'window.progressStage = async function() {'],
    ['customer-bootstrap.module.js', 'const originalOpenUploadModal = window.openUploadModal;\nwindow.openUploadModal = function() {'],
    ['customer-bootstrap.module.js', 'window.uploadPhotos = async function() {'],
    // onDrop runs three lines of drag bookkeeping before the guard; bind them.
    ['customer-dnd-upload.js', 'function onDrop(ev) {',
      { dragHasFiles: () => true, isInsideNativeUploader: () => false, dragDepth: 1, hideOverlay: NOOP },
      [{ target: {}, preventDefault: NOOP, get dataTransfer() { throw new Proceeded('ev.dataTransfer'); } }]],
    ['customer-edit-modal.js', 'function openEditCustomerModal() {'],
    ['customer-edit-modal.js', 'async function saveCustomerEdits() {'],
    ['maps-routing.js', 'async function saveDrawingToCustomer() {'],
    ['crm-leads.js', 'function openLeadModal(){'],
    ['crm-leads.js', 'async function saveLead(){'],
    ['tools.js', 'async function saveQuickLead() {'],
    ['estimates.js', 'async function saveEstimate() {'],
    ['dashboard-actions.js', 'async function _mJdQuickAddNote() {'],
    ['dashboard-actions.js', 'function editCardDetails() {'],
    ['tasks.js', 'async function openTaskModal(leadId,event){', null, ['l1', null]],
    ['tasks.js', 'async function addTask(){'],
    // Review of #1776 (2026-09-25): the estimates list and the EstimatePreview
    // sheet reach these, and they wrote through module-local Firestore
    // functions role-gate's layer 3 never sees ("Failed to rename" etc.).
    ['estimate-crm-ops.js', 'async function duplicateEstimateAction(id) {', null, ['e1']],
    ['estimate-crm-ops.js', 'async function renameEstimateAction(id) {', null, ['e1']],
    ['estimate-crm-ops.js', 'async function assignEstimateAction(id) {', null, ['e1']],
    ['estimate-crm-ops.js', 'async function deleteEstimateAction(id) {', null, ['e1']],
    ['customer-estimate-hub.js', 'function newEstimate() {'],
    ['customer-estimate-hub.js', 'function makePrimary(estId) {', null, ['e1']],
    ['customer-estimate-hub.js', 'function doDuplicate(id) {', null, ['e1']],
    // Every knock entry (Prospects button, D2D KNOCK, map long-press, re-knock).
    ['d2d-tracker-ui-2026b.js', 'function openQuickKnock(opts) {', null, [{}]],
  ];
  ok('37 guarded entry points listed', CASES.length === 37, String(CASES.length));
  for (const [file, anchor, pre, args, viewerReturn] of CASES) {
    const label = file + ' :: ' + anchor.split('\n').pop().replace(/\s*\{$/, '');
    let fnSrc;
    try { fnSrc = extractFn(read(file), anchor, file); }
    catch (e) { ok(label + ' — extract', false, e.message); continue; }

    const v = runGuarded(fnSrc, 'viewer', pre && Object.assign({}, pre), args);
    let vResult = v.result;
    let vThrew = v.threw;
    if (vResult && typeof vResult.then === 'function') {
      try { vResult = await vResult; } catch (e) { vThrew = e; }
    }
    ok(label + ' — viewer: stops at the guard, touches nothing else',
      v.guardCalls === 1 && !vThrew && v.touched.length === 0
        && vResult === (viewerReturn === undefined ? undefined : viewerReturn),
      'guard=' + v.guardCalls + ' threw=' + (vThrew && vThrew.message) + ' touched=' + v.touched.join(',') + ' result=' + vResult);

    const r = runGuarded(fnSrc, 'sales_rep', pre && Object.assign({}, pre), args);
    let rThrew = r.threw;
    if (r.result && typeof r.result.then === 'function') {
      try { await r.result; } catch (e) { rThrew = e; }
    }
    ok(label + ' — sales_rep: goes past the guard',
      r.guardCalls === 1 && rThrew instanceof Proceeded,
      'guard=' + r.guardCalls + ' threw=' + (rThrew && rThrew.message));
  }

  // Both CRM pages load role-gate.js deferred and BEFORE their bootstrap module
  // (the accessors must exist before the bootstrap assigns through them).
  for (const page of ['customer.html', 'dashboard.html']) {
    const html = fs.readFileSync(path.join(ROOT, 'docs/pro', page), 'utf8');
    const gateAt = html.search(/<script defer src="js\/role-gate\.js\?v=\d+"><\/script>/);
    const bootAt = html.search(/<script type="module" src="js\/(customer|dashboard)-bootstrap\.module\.js/);
    ok(page + ' loads role-gate.js with defer, before the bootstrap module', gateAt >= 0 && bootAt > gateAt,
      'gate@' + gateAt + ' boot@' + bootAt);
  }
}

(async () => {
  try {
    await partA();
    await partB();
  } catch (e) {
    failed++;
    console.log('  ✗ harness error: ' + (e && e.stack || e));
  }
  console.log('\nrole-gate: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
