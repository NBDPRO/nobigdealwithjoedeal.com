/**
 * tests/stale-leads-cleanup-2026-10-19.test.js
 *
 * "Clean up stale leads" (docs/pro/js/stale-leads-cleanup.js, flag
 * bulkCloseStaleLeads). Pins:
 *   1. the pure stale-selection logic (age cutoff, source filter, what is never
 *      listed, oldest first, per-row checkboxes, chunking, the undo patch);
 *   2. the flag-off path renders nothing and writes nothing (driven through the
 *      REAL module in a vm sandbox with a fake DOM, with a flag-on positive
 *      control so the "nothing" is not vacuous);
 *   3. nothing is written before the confirm step, only CHECKED leads are
 *      closed, through window.moveCard with the "Stale - no response" reason;
 *   4. Undo restores the previous stage and leaves a lead that moved since alone;
 *   5. source-level guards (comments stripped first): no delete, no `deleted`,
 *      no raw batch write, flag name; markup + phone-fit CSS wiring.
 *
 * Synthetic data only (public repo): ZZ_QA ids.
 * Run: node tests/stale-leads-cleanup-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'docs/pro/js/stale-leads-cleanup.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const CODE = strip(SRC);

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, what) {
  for (let i = 0; i < 400; i++) { if (fn()) return true; await tick(); }
  throw new Error('timed out waiting for ' + what);
}

const P = require(SRC_PATH);
const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 19, 15, 0, 0);
const ago = (d) => NOW - d * DAY;
const mk = (id, over) => Object.assign({
  id, firstName: 'ZZ_QA', lastName: id, source: 'Thumbtack', stage: 'new', _stageKey: 'new',
  createdAt: ago(60), updatedAt: ago(45),
}, over || {});

// ── 1. pure logic ────────────────────────────────────────────────────────
console.log('pure selection');
{
  const leads = [
    mk('a_old', { updatedAt: ago(45) }),
    mk('b_edge', { updatedAt: ago(30) }),                       // exactly 30 days: stale
    mk('c_fresh', { updatedAt: ago(29) }),                      // 29 days: not stale
    mk('d_contacted', { updatedAt: ago(90), lastContactedAt: ago(5) }),   // touched by a call
    mk('e_other', { source: 'Google', updatedAt: ago(70) }),
    mk('f_contacted_stage', { stage: 'contacted', _stageKey: 'contacted', updatedAt: ago(90) }),
    mk('g_deleted', { deleted: true, updatedAt: ago(90) }),
    mk('h_prospect', { isProspect: true, updatedAt: ago(90) }),
    mk('i_snoozed', { updatedAt: ago(90), snoozedUntil: NOW + 3 * DAY }),
    mk('j_followup', { updatedAt: ago(90), followUp: '2026-10-25' }),
    mk('k_pastfollowup', { updatedAt: ago(90), followUp: '2026-09-01' }),
    mk('l_undated', { createdAt: undefined, updatedAt: undefined }),
    mk('m_lost', { stage: 'Lost', _stageKey: 'lost', updatedAt: ago(90) }),
    mk('n_nosource', { source: '', createdAt: ago(120), updatedAt: ago(100) }),
  ];
  const ids = (r) => r.map((x) => x.id);
  const r30 = P.selectStale(leads, { days: 30, now: NOW });
  ok('30 days: stale new leads, oldest first', JSON.stringify(ids(r30)) === JSON.stringify(['n_nosource', 'e_other', 'k_pastfollowup', 'a_old', 'b_edge']), ids(r30).join(','));
  ok('exactly-N-days-old counts, N-1 does not', ids(r30).includes('b_edge') && !ids(r30).includes('c_fresh'));
  ok('a recent contact keeps a lead off the list', !ids(r30).includes('d_contacted'));
  ok('only stage new (not contacted / lost)', !ids(r30).includes('f_contacted_stage') && !ids(r30).includes('m_lost'));
  ok('deleted and prospect leads never listed', !ids(r30).includes('g_deleted') && !ids(r30).includes('h_prospect'));
  ok('snoozed / future follow-up leads never listed; a past follow-up date does not hide one', !ids(r30).includes('i_snoozed') && !ids(r30).includes('j_followup') && ids(r30).includes('k_pastfollowup'));
  ok('a lead with no usable date is left out (cannot prove stale)', !ids(r30).includes('l_undated'));
  ok('missing source is listed as Unknown', r30.find((x) => x.id === 'n_nosource').source === 'Unknown');
  ok('ageDays counts from the latest activity', r30.find((x) => x.id === 'a_old').ageDays === 45);
  ok('90 days keeps only leads idle 90+ days', JSON.stringify(ids(P.selectStale(leads, { days: 90, now: NOW }))) === JSON.stringify(['n_nosource']), ids(P.selectStale(leads, { days: 90, now: NOW })).join(','));
  ok('14 days includes the 29-day lead', ids(P.selectStale(leads, { days: 14, now: NOW })).includes('c_fresh'));
  ok('an unsupported day count falls back to 30', JSON.stringify(ids(P.selectStale(leads, { days: 7, now: NOW }))) === JSON.stringify(ids(r30)));
  const tt = P.selectStale(leads, { days: 30, source: 'thumbtack', now: NOW });
  ok('source filter is case-insensitive and exact', tt.length === 3 && tt.every((x) => x.source === 'Thumbtack'), String(tt.length));
  ok('source "all" means every source', P.selectStale(leads, { days: 30, source: 'all', now: NOW }).length === r30.length);
  const mine = P.selectStale(leads, { days: 30, now: NOW }, { canChange: (l) => l.id !== 'a_old' });
  ok('canChange (role / tenant rule) removes leads the user may not edit', !ids(mine).includes('a_old') && ids(mine).length === r30.length - 1);
  const so = P.sourceOptions(leads, { days: 30, now: NOW });
  ok('source options carry stale counts, biggest first', so[0].label === 'Thumbtack' && so[0].count === 3 && so.some((o) => o.label === 'Google' && o.count === 1), JSON.stringify(so));
  ok('a Firestore Timestamp-like updatedAt works', P.selectStale([mk('ts', { updatedAt: { toMillis: () => ago(40) } })], { days: 30, now: NOW }).length === 1);
}
console.log('selection, chunking, undo patch');
{
  const cands = ['x1', 'x2', 'x3'].map((id) => ({ id }));
  ok('all rows are checked by default', P.selectedIds(cands, new Set()).join() === 'x1,x2,x3');
  ok('unchecked rows are skipped, order kept', P.selectedIds(cands, new Set(['x2'])).join() === 'x1,x3');
  ok('everything unchecked selects nothing', P.selectedIds(cands, new Set(['x1', 'x2', 'x3'])).length === 0);
  const big = Array.from({ length: 1203 }, (_, i) => i);
  const ch = P.chunk(big, P.CHUNK);
  ok('chunks cover every item once and never exceed the chunk size', ch.reduce((n, c) => n + c.length, 0) === 1203 && ch.every((c) => c.length <= P.CHUNK) && ch.length === Math.ceil(1203 / P.CHUNK));
  ok('chunk size stays far below the Firestore 500 limit', P.CHUNK > 0 && P.CHUNK <= 500);
  ok('reason constants', P.REASON === 'Stale - no response' && P.REASON_KEY === 'no_response' && P.FLAG === 'bulkCloseStaleLeads');
  const snap = P.snapshotForUndo({ id: 'a', stage: 'New', stageRole: 'new', stageStartedAt: 111, closedAt: undefined, updatedAt: 222 });
  ok('undo snapshot keeps the previous stage, role and dates', snap.stage === 'New' && snap.stageRole === 'new' && snap.stageStartedAt === 111 && snap.closedAt === null && snap.updatedAt === 222);
  const patch = P.undoPatch({ stage: 'lost', lostReason: P.REASON }, snap);
  ok('undo patch restores the stage and clears the lost fields', patch.stage === 'New' && patch.lostReason === null && patch.lostReasonKey === null && patch.lostReasonNote === null && patch.closedAt === null);
  ok('undo patch never sets deleted', !('deleted' in patch) && !('deletedAt' in patch));
  ok('undo leaves a lead alone that is no longer lost', P.undoPatch({ stage: 'contacted', lostReason: P.REASON }, snap) === null);
  ok('undo leaves a lead alone that was lost for another reason', P.undoPatch({ stage: 'lost', lostReason: 'Price' }, snap) === null);
}

// ── 2-4. the real module in a sandbox ───────────────────────────────────
function boot(opts) {
  opts = opts || {};
  const handlers = {};
  const created = [];
  const body = { children: [], appendChild(n) { n.parentNode = body; body.children.push(n); }, removeChild(n) { body.children = body.children.filter((c) => c !== n); n.parentNode = null; } };
  const btn = { id: 'staleLeadsBtn', hidden: true, getAttribute() { return null; } };
  btn.closest = () => btn;
  const document = {
    readyState: 'complete', body,
    getElementById: (id) => (id === 'staleLeadsBtn' ? btn : null),
    createElement() { const n = { className: '', innerHTML: '', scrollTop: 0, setAttribute() {}, remove() { body.removeChild(n); } }; created.push(n); return n; },
    addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
  };
  const moves = [];
  const txWrites = [];
  const stored = {};     // id → server copy for the fake transaction
  const win = {
    document,
    _leads: opts.leads || [],
    _estimates: opts.estimates || [],
    _taskCache: opts.taskCache || {},
    _userClaims: opts.claims || { role: 'owner' },
    _user: { uid: 'u1' },
    NBDFlags: { enabled: (n) => !!opts.flag && n === 'bulkCloseStaleLeads', load: () => Promise.resolve() },
    addEventListener() {},
    showToast() {},
    moveCard: opts.moveCard || (async (id, to, o) => { moves.push({ id, to, o }); return true; }),
    normalizeStage: (s) => String(s || 'new').toLowerCase(),
    stageRole: () => 'active',
    db: {}, doc: (db, c, id) => ({ c, id }), collection: () => ({}), addDoc: async () => {},
    serverTimestamp: () => 'SERVER_TS', arrayUnion: (x) => ({ union: x }),
    runTransaction: async (db, fn) => fn({
      get: async (ref) => ({ exists: () => !!stored[ref.id], data: () => stored[ref.id] }),
      update: (ref, patch) => { txWrites.push({ id: ref.id, patch }); Object.assign(stored[ref.id], patch); },
    }),
  };
  const ctx = { window: win, document, setTimeout: () => 0, setInterval: () => 0, console, Date, Promise, Set, Math, JSON, parseInt, String, Object, Array, isFinite };
  win.window = win;
  vm.runInNewContext(SRC, ctx, { filename: 'stale-leads-cleanup.js' });
  const fire = (type, ev) => (handlers[type] || []).forEach((fn) => fn(ev));
  const clickAct = (act) => { const t = { id: '', getAttribute: (n) => (n === 'data-slc-act' ? act : null) }; t.closest = () => t; fire('click', { target: t, preventDefault() {} }); };
  const clickBtn = () => fire('click', { target: btn, preventDefault() {} });
  const toggle = (id, checked) => { const t = { checked, getAttribute: (n) => (n === 'data-slc-id' ? id : null) }; fire('change', { target: t }); };
  const setFilter = (f, value) => { const t = { value, getAttribute: (n) => (n === 'data-slc-f' ? f : null) }; fire('change', { target: t }); };
  return { win, created, body, btn, moves, txWrites, stored, clickAct, clickBtn, toggle, setFilter, overlay: () => created[0] };
}
const staleLeads = () => [mk('ZZ_QA_1'), mk('ZZ_QA_2'), mk('ZZ_QA_3'), mk('ZZ_QA_G', { source: 'Google' })];

(async () => {
  // The module reads Date.now() for "now"; pin it so the 45-day-old fixtures are stable.
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    console.log('flag off renders nothing');
    {
      const e = boot({ flag: false, leads: staleLeads() });
      e.win.NBDStaleLeads.sync();
      ok('toolbar button stays hidden', e.btn.hidden === true);
      ok('open() refuses', e.win.NBDStaleLeads.open() === false);
      e.clickBtn();
      ok('clicking the button creates no element and mounts nothing', e.created.length === 0 && e.body.children.length === 0);
      e.clickAct('go');
      ok('no write was attempted', e.moves.length === 0 && e.txWrites.length === 0);
    }
    {
      const e = boot({ flag: true, claims: { role: 'viewer' }, leads: staleLeads() });
      e.win.NBDStaleLeads.sync();
      ok('flag on but viewer: button hidden, open() refuses, nothing mounted', e.btn.hidden === true && e.win.NBDStaleLeads.open() === false && e.created.length === 0);
    }
    console.log('flag on (positive control)');
    {
      const e = boot({ flag: true, leads: staleLeads() });
      e.win.NBDStaleLeads.sync();
      ok('toolbar button shows', e.btn.hidden === false);
      e.clickBtn();
      ok('the overlay mounts with a preview table', e.created.length === 1 && e.body.children.length === 1 && /slc-table/.test(e.overlay().innerHTML));
      const h = e.overlay().innerHTML;
      ok('one row per stale lead, all checked', (h.match(/class="slc-check"/g) || []).length === 4 && (h.match(/ checked/g) || []).length === 4);
      ok('shows name, source, created, last activity and age columns', /Source/.test(h) && /Created/.test(h) && /Last activity/.test(h) && /Age/.test(h) && /45 days/.test(h));
      ok('count line', /4 of 4 selected/.test(h));
      ok('default is 30 days with 14/30/60/90 choices', /value="30" selected/.test(h) && /value="14"/.test(h) && /value="60"/.test(h) && /value="90"/.test(h));

      console.log('confirm step and the write');
      e.clickAct('go');
      await tick();
      ok('Yes-button with no confirm step writes nothing', e.moves.length === 0);
      e.toggle('ZZ_QA_2', false);
      ok('unchecking updates the count', /3 of 4 selected/.test(e.overlay().innerHTML));
      e.clickAct('review');
      ok('review shows the confirm panel naming the count and reason', /slc-confirm/.test(e.overlay().innerHTML) && /Mark 3 leads as Lost/.test(e.overlay().innerHTML) && /Stale - no response/.test(e.overlay().innerHTML));
      ok('nothing written yet while confirming', e.moves.length === 0);
      e.clickAct('back');
      ok('Back returns to the preview', !/slc-confirm/.test(e.overlay().innerHTML));
      e.clickAct('review');
      e.clickAct('go');
      await until(() => e.moves.length === 3, 'three moves');
      ok('only CHECKED leads are closed', e.moves.map((m) => m.id).join() === 'ZZ_QA_1,ZZ_QA_3,ZZ_QA_G');
      ok('each move goes to lost with the stale reason + no_response key', e.moves.every((m) => m.to === 'lost' && m.o.lostReason === 'Stale - no response' && m.o.lostReasonKey === 'no_response'));
      await until(() => /Closed 3 leads/.test(e.overlay().innerHTML), 'result line');
      ok('result line + Undo button after the batch', /Closed 3 leads as Lost/.test(e.overlay().innerHTML) && /data-slc-act="undo"/.test(e.overlay().innerHTML));
    }
    console.log('filters reset to all-checked');
    {
      const e = boot({ flag: true, leads: staleLeads() });
      e.clickBtn();
      e.toggle('ZZ_QA_1', false);
      e.setFilter('source', 'thumbtack');
      ok('source filter narrows the list and re-checks everything', /3 of 3 selected/.test(e.overlay().innerHTML));
      e.setFilter('days', '90');
      ok('a longer window drops the 45-day leads', /No stale leads match/.test(e.overlay().innerHTML));
    }
    console.log('undo');
    {
      const leads = [mk('ZZ_QA_U1', { stageRole: 'new', stageStartedAt: 7 }), mk('ZZ_QA_U2'), mk('ZZ_QA_U3')];
      const e = boot({
        flag: true, leads,
        moveCard: async (id) => {            // like moveCard: mutate the local lead, mark it lost on the "server"
          const l = leads.find((x) => x.id === id); l.stage = 'lost'; l._stageKey = 'lost';
          e.stored[id] = { stage: 'lost', lostReason: 'Stale - no response', closedAt: 'X' }; return true;
        },
      });
      e.clickBtn(); e.clickAct('review'); e.clickAct('go');
      await until(() => /Closed 3 leads/.test(e.overlay().innerHTML), 'batch done');
      e.stored.ZZ_QA_U3 = { stage: 'contacted', lostReason: null };     // somebody moved this one since
      e.clickAct('undo');
      await until(() => /Undone:/.test(e.overlay().innerHTML), 'undo done');
      ok('leads still lost for the stale reason go back to their previous stage', e.txWrites.length === 2 && e.txWrites.every((t) => t.patch.stage === 'new' && t.patch.lostReason === null));
      ok('the undo is recorded in stageHistory', e.txWrites.every((t) => t.patch.stageHistory && t.patch.stageHistory.union.staleCleanupUndo === true));
      ok('a lead that moved since is left alone and reported', !e.txWrites.some((t) => t.id === 'ZZ_QA_U3') && /1 left alone/.test(e.overlay().innerHTML));
      ok('the previous stageStartedAt comes back', e.txWrites.find((t) => t.id === 'ZZ_QA_U1').patch.stageStartedAt === 7);
      ok('no deleted flag is ever written', e.txWrites.every((t) => !('deleted' in t.patch)));
      ok('the undo button is gone once used', !/data-slc-act="undo"/.test(e.overlay().innerHTML));
    }
    console.log('review fixes: frozen allow-list, batch-bound undo, evidence');
    {
      // 1. a lead that turns stale AFTER the preview is never closed
      const leads = [mk('ZZ_QA_F1'), mk('ZZ_QA_F2')];
      const e = boot({ flag: true, leads });
      e.clickBtn(); e.clickAct('review');
      leads.push(mk('ZZ_QA_LATE'));                       // refresh brings in a newly stale lead mid-review
      ok('confirm count is the frozen count', /Mark 2 leads as Lost/.test(e.overlay().innerHTML));
      e.clickAct('go');
      await until(() => /Closed 2 leads/.test(e.overlay().innerHTML), 'frozen close');
      ok('only the previewed leads were closed', e.moves.map((m) => m.id).join() === 'ZZ_QA_F1,ZZ_QA_F2');
      // a previewed lead that stopped being stale before the write is skipped too
      const l2 = [mk('ZZ_QA_S1'), mk('ZZ_QA_S2')];
      const e2 = boot({ flag: true, leads: l2 });
      e2.clickBtn(); e2.clickAct('review');
      l2[1].lastContactedAt = NOW - DAY;                  // called yesterday, meanwhile
      e2.clickAct('go');
      await until(() => /Closed 1 lead /.test(e2.overlay().innerHTML), 'skip fresh');
      ok('a lead that became active after the preview is not closed', e2.moves.map((m) => m.id).join() === 'ZZ_QA_S1');
    }
    {
      // 2. toast Undo is bound to ITS batch; double tap is single-flight
      const toasts = [];
      const leads = [mk('ZZ_QA_B1'), mk('ZZ_QA_B2')];
      const e = boot({
        flag: true, leads,
        moveCard: async (id) => { const l = leads.find((x) => x.id === id); l.stage = 'lost'; l._stageKey = 'lost'; e.stored[id] = { stage: 'lost', lostReason: 'Stale - no response' }; return true; },
      });
      e.win.showToast = (m) => { if (m && m.undoAction) toasts.push(m); };
      e.clickBtn(); e.clickAct('review'); e.clickAct('go');
      await until(() => toasts.length === 1, 'first toast');
      leads.push(mk('ZZ_QA_B3')); e.clickAct('close');       // second cleanup, one more lead
      e.clickBtn(); e.clickAct('review'); e.clickAct('go');
      await until(() => toasts.length === 2, 'second toast');
      toasts[0].undoAction(); toasts[0].undoAction();         // first toast, tapped twice
      await until(() => e.txWrites.length >= 2, 'undo writes');
      await tick(); await tick();
      ok('the first toast undoes the FIRST batch only, once', e.txWrites.map((t) => t.id).sort().join() === 'ZZ_QA_B1,ZZ_QA_B2');
      ok('undo stamps updatedAt with the server time, not the old value', e.txWrites.every((t) => t.patch.updatedAt === 'SERVER_TS'));
    }
    {
      // 4. signs of real work start unchecked
      const leads = [mk('ZZ_QA_E1'), mk('ZZ_QA_E2'), mk('ZZ_QA_E3', { notes: 'spoke at the door' }), mk('ZZ_QA_E4')];
      const e = boot({ flag: true, leads, estimates: [{ leadId: 'ZZ_QA_E1' }], taskCache: { ZZ_QA_E2: [{ done: true }] } });
      e.clickBtn();
      const h = e.overlay().innerHTML;
      ok('leads with an estimate / task / notes start unchecked and say why', /1 of 4 selected/.test(h) && /has estimate/.test(h) && /has task/.test(h) && /has notes/.test(h));
      e.clickAct('all');
      ok('Select all still lets the user include them', /4 of 4 selected/.test(e.overlay().innerHTML));
      ok('evidenceOf is pure and empty for an untouched lead', P.evidenceOf(mk('x'), {}).length === 0 && P.evidenceOf(mk('y', { lastContactType: 'call' }), {}).join() === 'contact');
    }
    {
      // real moveCard contract: a supplied reason skips the Why-Lost sheet and is stored with its key
      const mp = fs.readFileSync(path.join(ROOT, 'docs/pro/js/crm-pipeline.js'), 'utf8');
      const fn = /function _lostFieldsFromText\(text, key\) \{[\s\S]*?\n\}/.exec(mp);
      const fields = fn && vm.runInNewContext('window={NBDNumbers:null};' + fn[0] + ';_lostFieldsFromText("Stale - no response","no_response")');
      ok('moveCard stores the supplied reason and key verbatim', !!fields && fields.lostReason === 'Stale - no response' && fields.lostReasonKey === 'no_response');
      const given = mp.indexOf('if (_givenLostReason) {');
      ok('moveCard checks the supplied reason before it can open the Why-Lost sheet', given > 0 && given < mp.indexOf('await promptLostReason(lead)', given));
    }
  } finally { Date.now = realNow; }

  // ── 5. source + wiring guards ──────────────────────────────────────────
  console.log('source guards (comments stripped)');
  ok('guard has teeth: the stripper keeps real code and drops comments', /function selectStale/.test(CODE) && !/86 leads/.test(CODE) && /86 leads/.test(SRC));
  ok('closes through window.moveCard (the one stage path)', /w\.moveCard\(id, 'lost'/.test(CODE));
  ok('never deletes: no deleteDoc / .delete( / writeBatch / deleted:true', !/deleteDoc|writeBatch|deleted\s*:\s*true/.test(CODE) && !/\.delete\(/.test(CODE.replace(/st\.unchecked\.delete\(id\)/g, '')));
  ok('the flag name is the registered one and is read through NBDFlags', /FLAG = 'bulkCloseStaleLeads'/.test(CODE) && /NBDFlags\.enabled\(FLAG\)/.test(CODE));
  ok('no inline handlers or styles in the generated markup', !/\son[a-z]+=/.test(CODE) && !/style="/.test(CODE));
  const html = fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8');
  ok('dashboard: button ships hidden', /id="staleLeadsBtn"[^>]*\shidden/.test(html));
  ok('dashboard: external deferred script + stylesheet', /<script defer src="js\/stale-leads-cleanup\.js\?v=\d+"><\/script>/.test(html) && /css\/stale-leads-cleanup\.css/.test(html));
  const css = fs.readFileSync(path.join(ROOT, 'docs/pro/css/stale-leads-cleanup.css'), 'utf8');
  ok('phone fit: card layout under 480px, rows stop being table cells', /@media \(max-width: 480px\)[\s\S]*\.slc-table tr[\s\S]*display: block/.test(css));
  ok('phone fit: 44px tap targets', /\.slc-btn[^}]*min-height: 44px/.test(css) && /\.slc-sel[^}]*min-height: 44px/.test(css));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
