/**
 * labor-book.js — the Labor hours book editor on the Schedule view
 * (flag `laborHoursBook`, 2026-11-19). Rules: labor-book-logic.js.
 *
 *   Hours per unit   for each labor action (tear-off, install, flashing, ...): how many
 *                    man-hours one unit takes. Stored in the company's PRIVATE book,
 *                    catalogCosts/{companyId}.laborOps[id].hoursPerUnit, through
 *                    NBDCatalogCosts.recordLaborOp (which merges, so a rate on the same
 *                    action is never erased).
 *   Crew size        per sub, on the sub's own doc (companies/{id}/subs/{subId}.crewSize).
 *                    Crew-days = man-hours / (crew size x 8); a sub with none uses 3.
 *
 * The book STARTS EMPTY. Nothing here suggests, estimates or pre-fills a number: a box
 * is empty until the owner types one. Hours are company-internal: never on an estimate,
 * the portal, a customer document or a sub's job sheet. Owner and company_admin only
 * (the catalogCosts write rule). Loaded lazily by schedule-planner.js, and only when the
 * flag is on, so with the flag off this file is never fetched. window.NBDLaborBook.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDLaborBook) return;
  const w = window;
  const FLAG = 'laborHoursBook';
  const ROLES = ['', 'company_admin'];            // '' = the solo owner
  const PANEL_ID = 'laborBookPanel';
  const LG = () => w.NBDLaborBookLogic;
  const MAX_ROWS = 60;
  const JH = () => w.NBDJobHoursLogic;
  // The whole-job book times (job-hours-logic TYPES): per SQ for a replacement, per job for a repair. They live
  // beside the labor actions in the same private book under reserved BOOK: keys, so one writer saves both.
  const bookActions = () => { const T = JH() && JH().TYPES; return T ? Object.keys(T).map((k) => ({ id: T[k].key, name: T[k].label, unit: T[k].unit, category: 'book time' })) : []; };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, k) => { if (typeof w.showToast === 'function') w.showToast(m, k || 'info'); };
  const claims = () => w._userClaims || {};
  const uid = () => (w._user && w._user.uid) || null;
  const tenant = () => claims().companyId || uid();
  // A platform admin (role 'admin') passes only for their OWN tenant (company id = their uid): that is the tenant
  // owner the rules admit. Without this the owner's panel stayed invisible, because the owner IS the platform admin.
  const allowed = () => !!uid() && (ROLES.indexOf(claims().role || '') !== -1 || (claims().role === 'admin' && tenant() === uid()));
  const cc = () => w.NBDCatalogCosts;
  function enabled() {
    return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG))
      && !!LG() && !!w.NBD_LABOR && !!cc() && typeof cc().laborOp === 'function' && allowed();
  }
  const actions = () => (w.NBD_LABOR && typeof w.NBD_LABOR.search === 'function' ? w.NBD_LABOR.search('') : []);
  const op = (id) => cc().laborOp(id);
  const subs = () => ((w.NBDProduction && w.NBDProduction.subs ? w.NBDProduction.subs() : []) || []).filter((s) => s && s.name && s.active !== false);

  // S: { q, typed{actionId:text}, crew{subId:text}, msg, crewMsg, busy, subsLoaded }
  const S = { q: '', typed: {}, crew: {}, msg: '', crewMsg: '', busy: false, subsLoaded: false };

  function hoursRows() {
    const rows = LG().rowsFor(actions(), op, S.q);
    return '<div class="sp-tools"><input type="search" class="sp-search" data-lb-f="q" aria-label="Search labor actions" placeholder="Search tear-off, ridge, gutter..." value="' + esc(S.q) + '"></div>' +
      (rows.length ? rows.slice(0, MAX_ROWS).map((r) => {
        const val = Object.prototype.hasOwnProperty.call(S.typed, r.id) ? S.typed[r.id] : (r.hours == null ? '' : String(r.hours));
        return '<div class="sp-row"><div><span class="sp-name">' + esc(r.name) + '</span></div>' +
          '<div class="sp-sub">' + esc(r.id) + ' · per ' + esc(r.unit || 'unit') + ' · ' + esc(r.category) + '</div>' +
          '<label class="sp-toggle">Man-hours per ' + esc(r.unit || 'unit') + '<input type="text" inputmode="decimal" class="sp-search" data-lb-hours="' + esc(r.id) + '" value="' + esc(val) + '" aria-label="Hours per ' + esc(r.unit || 'unit') + ' for ' + esc(r.name) + '"></label></div>';
      }).join('') + (rows.length > MAX_ROWS ? '<div class="sp-note">Showing ' + MAX_ROWS + ' of ' + rows.length + ': search to find the rest.</div>' : '')
        : '<div class="sp-note">Nothing matches.</div>');
  }

  function bookRows() {
    return bookActions().map((r) => {
      const held = op(r.id), h = held && held.hoursPerUnit != null ? String(held.hoursPerUnit) : '';
      const val = Object.prototype.hasOwnProperty.call(S.typed, r.id) ? S.typed[r.id] : h;
      return '<div class="sp-row"><div><span class="sp-name">' + esc(r.name) + '</span></div>' +
        '<label class="sp-toggle">Man-hours per ' + esc(r.unit) + '<input type="text" inputmode="decimal" class="sp-search" data-lb-hours="' + esc(r.id) + '" value="' + esc(val) + '" aria-label="Man-hours per ' + esc(r.unit) + ' for ' + esc(r.name) + '"></label></div>';
    }).join('');
  }

  function crewRows() {
    const list = subs();
    if (!list.length) return '<div class="sp-note">No subs on the roster yet.</div>';
    return list.map((s) => {
      const val = Object.prototype.hasOwnProperty.call(S.crew, s.id) ? S.crew[s.id] : (s.crewSize ? String(s.crewSize) : '');
      return '<div class="sp-row"><div><span class="sp-name">' + esc(s.name) + '</span>' + (s.trade ? ' <span class="sp-sub">' + esc(s.trade) + '</span>' : '') + '</div>' +
        '<label class="sp-toggle">Usual crew size<input type="text" inputmode="numeric" class="sp-search" data-lb-crew="' + esc(s.id) + '" value="' + esc(val) + '" aria-label="Usual crew size for ' + esc(s.name) + '"></label></div>';
    }).join('');
  }

  function render() {
    const anchor = document.getElementById('subJobBoardPanel') || document.getElementById('schedPlanPanel');
    let panel = document.getElementById(PANEL_ID);
    if (!enabled() || !anchor) { if (panel) panel.remove(); return; }
    if (!S.subsLoaded && w.NBDProduction && typeof w.NBDProduction.loadSubs === 'function') {
      S.subsLoaded = true;
      w.NBDProduction.loadSubs(true).then(render, () => {});
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'panel';
      panel.id = PANEL_ID;
      anchor.insertAdjacentElement('afterend', panel);
    }
    // An empty box over a number the book already holds would be a lie: wait for the book.
    // A company with no book yet is a normal, empty state: after one successful load it counts as ready.
    const ready = S.hydrated || typeof cc().isLoaded !== 'function' || cc().isLoaded() === true;
    if (!ready && !S.hydrating && !S.hydrateFailed) {
      S.hydrating = true;
      Promise.resolve(typeof cc().hydrate === 'function' ? cc().hydrate() : null)
        .then(() => { S.hydrating = false; S.hydrated = true; }, () => { S.hydrating = false; S.hydrateFailed = true; })
        .then(render);
    }
    if (!ready) {
      panel.innerHTML = '<div class="panel-hdr"><div><div class="panel-label">Your own flat-rate book</div><div class="panel-title">Labor hours</div></div></div>' +
        '<div class="panel-body"><div class="sp-note" role="status">' + (S.hydrateFailed ? 'Could not load your labor book. Nothing can be edited until it loads: reload the page and try again.' : 'Loading your labor book…') + '</div></div>';
      return;
    }
    panel.innerHTML = '<div class="panel-hdr"><div><div class="panel-label">Your own flat-rate book</div><div class="panel-title">Labor hours</div></div></div>' +
      '<div class="panel-body">' +
      '<div class="sp-note">Man-hours one unit of each job step takes your crews. This starts empty and nothing is guessed: type your own numbers. Hours are for your planning only. They never go on an estimate, the portal, a customer document or a sub\'s job sheet. Leaving a box blank leaves it as it is.</div>' +
      (bookActions().length ? '<div class="sp-h">Book time per job type</div>' +
        '<div class="sp-note">How many man-hours a whole job of this type takes: per square for a replacement, per job for a repair. The Sub job board uses this to estimate a job. Leave it blank until you know.</div>' + bookRows() : '') +
      '<div class="sp-h">Hours per unit</div>' + hoursRows() +
      '<button type="button" class="btn btn-orange" data-lb-action="save-hours"' + (S.busy ? ' disabled' : '') + '>Save hours</button>' +
      '<div class="sp-note" role="status" data-lb-msg>' + esc(S.msg) + '</div>' +
      '<div class="sp-h">Usual crew size per sub</div>' +
      '<div class="sp-note">Crew-days = man-hours / (crew size x 8-hour days). A sub with no crew size is planned as a crew of ' + LG().DEFAULT_CREW + '.</div>' + crewRows() +
      '<button type="button" class="btn btn-orange" data-lb-action="save-crew"' + (S.busy ? ' disabled' : '') + '>Save crew sizes</button>' +
      '<div class="sp-note" role="status" data-lb-crewmsg>' + esc(S.crewMsg) + '</div>' +
      '</div>';
  }

  async function saveHours() {
    const p = LG().plan(actions().concat(bookActions()), op, S.typed);
    if (p.errors.length) {
      S.msg = p.errors.slice(0, 3).map((e) => e.name + ': ' + e.message).join(' ') + (p.errors.length > 3 ? ' (and ' + (p.errors.length - 3) + ' more)' : '') + ' Nothing was saved.';
      return render();
    }
    if (!p.writes.length) {
      S.msg = p.blanksOverSet.length ? 'Nothing changed. Clearing a number is not supported yet; type 0 only if the step truly takes no time.' : 'Nothing changed.';
      return render();
    }
    S.busy = true; render();
    let saved = 0, refused = 0;
    for (const wr of p.writes) {
      let r = false;
      try { r = await cc().recordLaborOp(wr.id, { hoursPerUnit: wr.value }); } catch (e) { r = false; }
      if (r === true) { saved++; delete S.typed[wr.id]; } else refused++;
    }
    S.busy = false;
    S.msg = (saved ? saved + ' saved. ' : '') + (refused ? refused + ' could not be saved (your role may not allow it, or you are offline). ' : '') +
      (p.blanksOverSet.length ? p.blanksOverSet.length + ' blank box' + (p.blanksOverSet.length === 1 ? '' : 'es') + ' left as they were.' : '');
    if (saved) toast('Labor hours saved ✓', 'success');
    render();
  }

  async function saveCrew() {
    const list = subs(), errs = [], writes = [];
    list.forEach((s) => {
      if (!Object.prototype.hasOwnProperty.call(S.crew, s.id)) return;
      const r = LG().parseCrew(S.crew[s.id]);
      if (!r.ok) { errs.push(s.name + ': ' + r.message); return; }
      if (r.blank) return;
      if (r.value !== Number(s.crewSize)) writes.push({ sub: s, value: r.value });
    });
    if (errs.length) { S.crewMsg = errs.slice(0, 3).join(' ') + ' Nothing was saved.'; return render(); }
    if (!writes.length) { S.crewMsg = 'Nothing changed.'; return render(); }
    S.busy = true; render();
    let saved = 0, refused = 0;
    for (const wr of writes) {
      try {
        await w.updateDoc(w.doc(w.db, 'companies', tenant(), 'subs', wr.sub.id), { crewSize: wr.value, updatedAt: w.serverTimestamp() });
        wr.sub.crewSize = wr.value; delete S.crew[wr.sub.id]; saved++;
      } catch (e) { console.warn('[labor-book] crew size not saved', e && e.code); refused++; }
    }
    S.busy = false;
    S.crewMsg = (saved ? saved + ' saved. ' : '') + (refused ? refused + ' could not be saved. ' : '');
    if (saved) toast('Crew sizes saved ✓', 'success');
    render();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-lb-action]') : null;
    if (!t || !t.closest('#' + PANEL_ID) || S.busy) return;
    const a = t.getAttribute('data-lb-action');
    if (a === 'save-hours') saveHours(); else if (a === 'save-crew') saveCrew();
  });
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t || !t.getAttribute || !(t.closest && t.closest('#' + PANEL_ID))) return;
    const h = t.getAttribute('data-lb-hours'), c = t.getAttribute('data-lb-crew'), f = t.getAttribute('data-lb-f');
    if (h) S.typed[h] = t.value;
    else if (c) S.crew[c] = t.value;
    else if (f === 'q') {
      S.q = t.value; render();
      const q = document.querySelector && document.querySelector('#' + PANEL_ID + ' [data-lb-f="q"]');
      if (q && q.focus) { q.focus(); if (q.setSelectionRange) q.setSelectionRange(q.value.length, q.value.length); }
    }
  });

  function maybeRender() {
    if (!/schedule/.test(w.location.hash || '')) return;
    render();
  }
  w.addEventListener('hashchange', maybeRender);
  w.addEventListener('nbd:data-refreshed', maybeRender);
  w.addEventListener('nbd:subs-changed', () => { if (document.getElementById(PANEL_ID)) maybeRender(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', maybeRender); else maybeRender();

  w.NBDLaborBook = { render, _state: S };
})();
