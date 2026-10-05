/**
 * schedule-planner.js — the "Plan jobs" panel on the Schedule view
 * (#schedPlanPanel). Rules: schedule-planner-logic.js.
 *
 * Two lists, each row a week OR a date / start time / days, and a Save button.
 * A week is the rough plan (scheduledWeek); a date is the real booking and
 * replaces it (Jo, 2026-09-29: "assign them to a week and then refine"):
 *   Needs a date — committed jobs with no scheduledDate (a switch shows every
 *                  open lead instead; a search box narrows either).
 *   Next 30 days — jobs already scheduled, to move or clear.
 * A save writes only the four schedule fields to leads/{id} (updateDoc), the
 * same fields the customer page writes, so the Google Calendar sync
 * (functions/google-calendar.js onLeadCalendarWrite) picks it up the same way.
 * Viewers don't see the panel (rules refuse their writes anyway).
 *
 * The Schedule view is a template stamped on first visit, so rendering waits
 * for #schedPlanPanel and re-renders on hashchange / nbd:data-refreshed. A
 * re-render keeps what Jo typed but has not saved (_drafts), so a background
 * data refresh never wipes a half-planned month.
 * Picking a day asks Google what is already booked then — the same
 * double-booking warning as the customer page (google-calendar-ui.js
 * checkRow → getBusyTimes). Warn, never block (Jo, 2026-09-29). The warning
 * is kept per row (_warn) so a re-render doesn't drop it.
 * Saving a real build day on a committed job then offers a one-tap "Move to
 * Crew Scheduled?" chip on that row (2026-10-03, stage-flow lane) — only when
 * that is a forward move on the lead's own track (crewMoveOffer). The tap goes
 * through window.moveCard → stage-write.js commitStageChange, the same gates
 * and race guards as a kanban move. Saving the date alone never moves a stage.
 * Delegated listeners; every value into innerHTML is escaped.
 */
(function () {
  'use strict';
  if (window.NBDSchedulePlannerUI) return;
  const P = () => window.NBDSchedulePlanner;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, t) => { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); };
  const role = () => (window._userClaims || {}).role || '';
  const todayYmd = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const weekLabel = (ymd) => { const [y, m, d] = String(ymd).split('-').map(Number); try { return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch (_) { return ymd; } };
  const stageLabel = (s) => (window.STAGE_META && window.STAGE_META[s] && window.STAGE_META[s].label) || s || '—';

  let _all = false, _q = '';
  const _saving = {};
  const _drafts = {};           // lead id → { date, start, days } typed, not saved
  const _warn = {};             // lead id → the double-booking warning's HTML (escaped by google-calendar-ui)
  const _warnSeq = {};          // lead id → the latest check, so a slow answer can't overwrite a newer one
  const _warnTimers = {};
  const _offer = {};            // lead id → offer "Move to Crew Scheduled?" (set by a date save)

  function rowHtml(r, kind) {
    const v = _drafts[r.id] || P().inputsOf(r.lead);
    const id = esc(r.id);
    return '<div class="sp-row" data-id="' + id + '">' +
      '<div class="sp-who"><a href="/pro/customer.html?id=' + encodeURIComponent(r.id) + '" class="sp-name">' + esc(r.name) + '</a>' +
      '<div class="sp-sub">' + esc(stageLabel(r.stage)) + (r.address ? ' · ' + esc(r.address) : '') + '</div>' +
      (r.week ? '<div class="sp-week' + (r.weekPassed ? ' sp-week-late' : '') + '">📆 ' + (r.weekPassed ? 'Was planned for the week of ' : 'Week of ') + esc(weekLabel(r.week)) + (r.weekPassed ? ' — needs a new plan' : ' — no day yet') + '</div>' : '') +
      '</div>' +
      '<div class="sp-in">' +
        '<label>Week of<input type="date" class="sp-week-in" value="' + esc(v.week || '') + '" title="Any day that week — it saves as the week"></label>' +
        '<span class="sp-or">or day</span>' +
        '<label>Date<input type="date" class="sp-date" value="' + esc(v.date) + '"></label>' +
        '<label>Start<input type="time" class="sp-start" value="' + esc(v.start) + '"></label>' +
        '<label>Days<input type="number" class="sp-days" min="1" max="14" inputmode="numeric" value="' + esc(v.days) + '"></label>' +
        '<button type="button" class="btn btn-orange sp-save" data-sp-action="save">Save</button>' +
        (kind === 'scheduled' ? '<button type="button" class="btn btn-ghost sp-clear" data-sp-action="clear" title="Remove the date">Clear</button>' : '') +
      '</div>' +
      // Production flow (2026-10-04, production.js): the sub picker, the
      // weather.gov badge and the rain-day push.
      (window.NBDProduction && typeof window.NBDProduction.rowExtrasHtml === 'function' ? window.NBDProduction.rowExtrasHtml(Object.assign({}, r, { subDraft: _drafts[r.id] && _drafts[r.id].sub }), kind) : '') +
      '<div class="sp-conflict gcal-conflict" aria-live="polite">' + (_warn[r.id] || '') + '</div>' +
      '<div class="sp-msg" aria-live="polite"></div>' +
      (_offer[r.id] ? '<div class="sp-stage-offer">' +
        '<button type="button" class="sp-stage-chip" data-sp-action="stage">Move to ' + esc(stageLabel('crew_scheduled')) + '?</button>' +
        '<button type="button" class="sp-stage-no" data-sp-action="stage-no">Not now</button></div>' : '') +
      '</div>';
  }

  // The lead's own ordered track (tenant-aware on the dashboard).
  function trackOf(lead) {
    if (typeof window.stageOptionsForType !== 'function') return [];
    try { return (window.stageOptionsForType((lead && lead.jobType) || 'insurance') || []).map((o) => o && o.value); } catch (_) { return []; }
  }
  function offerFor(lead) {
    if (!lead || !P() || typeof P().crewMoveOffer !== 'function') return false;
    const norm = typeof window.normalizeStage === 'function' ? (s) => { try { return window.normalizeStage(s); } catch (_) { return String(s || ''); } } : undefined;
    return P().crewMoveOffer(lead, trackOf(lead), { normalize: norm, roleOf: typeof window.stageRole === 'function' ? window.stageRole : undefined });
  }

  async function moveToCrew(id) {
    const lead = (window._leads || []).find((l) => l && l.id === id);
    if (!lead || _saving[id]) return;
    _saving[id] = true;
    try {
      let moved = false;
      if (typeof window.moveCard === 'function') {
        moved = (await window.moveCard(id, 'crew_scheduled')) === true;
      } else {
        const { commitStageChange } = await import('./stage-write.js');
        await commitStageChange(id, 'crew_scheduled', lead.stage, { jobType: lead.jobType || null });
        lead.stage = 'crew_scheduled';
        moved = true;
      }
      delete _offer[id];
      if (moved) toast('Moved to ' + stageLabel('crew_scheduled') + ' ✓', 'success');
    } catch (e) {
      toast('Could not move the stage: ' + ((e && (e.code || e.message)) || 'unknown'), 'error');
    } finally {
      delete _saving[id];
      render();
    }
  }

  function render() {
    const host = $('schedPlanBody');
    const panel = $('schedPlanPanel');
    if (!host || !panel || !P()) return;
    if (role() === 'viewer') { panel.hidden = true; return; }
    panel.hidden = false;
    const norm = typeof window.normalizeStage === 'function' ? (s) => { try { return window.normalizeStage(s); } catch (_) { return String(s || '').toLowerCase(); } } : undefined;
    const { needs, scheduled } = P().rowsFor(window._leads || [], { today: todayYmd(), all: _all, q: _q, normalize: norm });
    host.innerHTML =
      '<div class="sp-tools">' +
        '<input type="search" id="spSearch" class="sp-search" placeholder="Search name, address or customer #" value="' + esc(_q) + '">' +
        '<label class="sp-toggle"><input type="checkbox" id="spAll"' + (_all ? ' checked' : '') + '> Show all open leads</label>' +
      '</div>' +
      '<div class="sp-h">Needs a date <span class="sp-count">' + needs.length + '</span></div>' +
      (needs.length ? needs.slice(0, 60).map((r) => rowHtml(r, 'needs')).join('') +
        (needs.length > 60 ? '<div class="sp-note">Showing 60 — search to find the rest.</div>' : '')
        : '<div class="sp-note">' + (_all || _q ? 'Nothing matches.' : 'Every signed job has a date. Turn on "Show all open leads" to schedule an earlier-stage one.') + '</div>') +
      '<div class="sp-h">Next 30 days <span class="sp-count">' + scheduled.length + '</span></div>' +
      (scheduled.length ? scheduled.map((r) => rowHtml(r, 'scheduled')).join('') : '<div class="sp-note">Nothing scheduled in the next 30 days yet.</div>');
  }

  async function save(row, clear) {
    const id = row.dataset.id;
    if (!id || _saving[id]) return;
    const msg = row.querySelector('.sp-msg');
    const input = clear ? { date: '', week: '' } : {
      week: row.querySelector('.sp-week-in').value,
      date: row.querySelector('.sp-date').value,
      start: row.querySelector('.sp-start').value,
      days: row.querySelector('.sp-days').value,
    };
    // The row's sub (production flow, 2026-10-04): {} when it didn't change.
    const leadNow = (window._leads || []).find((l) => l && l.id === id);
    const subPatch = !clear && window.NBDProduction && typeof window.NBDProduction.rowSubPatch === 'function' ? window.NBDProduction.rowSubPatch(row, leadNow) : {};
    const subOnly = !clear && !input.date && !input.week && Object.keys(subPatch).length > 0;
    if (!clear && !input.date && !input.week && !subOnly) { msg.textContent = 'Pick a week or a day first.'; return; }
    const out = subOnly ? { ok: true, fields: {} } : P().fieldsFor(input);
    if (!out.ok) { msg.textContent = out.message; return; }
    Object.assign(out.fields, subPatch);
    if (!window.updateDoc || !window.doc || !window.db) { msg.textContent = 'Not connected yet — try again in a moment.'; return; }
    _saving[id] = true;
    row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    msg.textContent = 'Saving…';
    try {
      await window.updateDoc(window.doc(window.db, 'leads', id), out.fields);
      delete _drafts[id];
      delete _warn[id];
      _warnSeq[id] = (_warnSeq[id] || 0) + 1;
      const lead = (window._leads || []).find((l) => l && l.id === id);
      if (lead) Object.assign(lead, out.fields);
      if (!clear && out.fields.scheduledDate && offerFor(lead)) _offer[id] = true;
      else delete _offer[id];
      toast(clear ? 'Schedule cleared'
        : subOnly ? (subPatch.crew ? subPatch.crew + ' is on this job ✓' : 'Sub cleared')
        : out.fields.scheduledWeek ? 'Planned for the week of ' + weekLabel(out.fields.scheduledWeek) + ' ✓'
        : 'Scheduled ✓ — on your Google Calendar in a few seconds', 'success');
      render();
      // The row can leave both lists (a date past the next 30 days) — then
      // the offer rides on a toast action instead of the row chip.
      if (_offer[id] && !document.querySelector('.sp-row[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"] .sp-stage-chip')
        && typeof window.showToast === 'function') {
        window.showToast({ message: 'Scheduled ✓ — move it to ' + stageLabel('crew_scheduled') + '?', type: 'info', duration: 10000,
          undoText: 'Move', undoAction: () => { moveToCrew(id); } });
      }
      const reg = window.__NBD_CALL_REGISTRY;
      if (reg && typeof reg.loadSmartCalendar === 'function') { try { reg.loadSmartCalendar(); } catch (_) {} }
    } catch (e) {
      msg.textContent = 'Could not save: ' + ((e && e.code) || (e && e.message) || 'unknown');
      row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    } finally {
      delete _saving[id];
    }
  }

  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-sp-action]');
    if (!b) return;
    const row = b.closest('.sp-row');
    if (!row) return;
    const act = b.dataset.spAction;
    if (act === 'stage') { moveToCrew(row.dataset.id); return; }
    if (act === 'stage-no') { delete _offer[row.dataset.id]; render(); return; }
    save(row, act === 'clear');
  });
  document.addEventListener('change', (ev) => {
    if (ev.target && ev.target.id === 'spAll') { _all = !!ev.target.checked; render(); }
  });
  function keepDraft(ev) {
    const row = ev.target && ev.target.closest && ev.target.closest('.sp-row');
    if (!row || !row.dataset.id) return;
    _drafts[row.dataset.id] = {
      week: row.querySelector('.sp-week-in').value,
      date: row.querySelector('.sp-date').value,
      start: row.querySelector('.sp-start').value,
      days: row.querySelector('.sp-days').value,
      sub: row.querySelector('.sp-sub-sel') ? row.querySelector('.sp-sub-sel').value : undefined,
    };
  }
  document.addEventListener('input', keepDraft);
  document.addEventListener('change', keepDraft);

  // A day, start or length changed → ask Google (debounced per row).
  async function checkBusy(id) {
    const row = document.querySelector('.sp-row[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    const G = window.NBDGoogleCalendarUI;
    if (!row || !G || typeof G.checkRow !== 'function') return;
    const seq = _warnSeq[id] = (_warnSeq[id] || 0) + 1;
    const html = await G.checkRow({
      date: row.querySelector('.sp-date').value,
      start: row.querySelector('.sp-start').value,
      days: row.querySelector('.sp-days').value,
    }, id);
    if (_warnSeq[id] !== seq) return;
    _warn[id] = html;
    const live = document.querySelector('.sp-row[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"] .sp-conflict');
    if (live) live.innerHTML = html;
  }
  function onBusyField(ev) {
    const t = ev.target;
    if (!t || !t.classList || !(t.classList.contains('sp-date') || t.classList.contains('sp-start') || t.classList.contains('sp-days'))) return;
    const row = t.closest('.sp-row');
    const id = row && row.dataset.id;
    if (!id) return;
    clearTimeout(_warnTimers[id]);
    _warnTimers[id] = setTimeout(() => { checkBusy(id); }, 500);
  }
  document.addEventListener('input', onBusyField);
  document.addEventListener('change', onBusyField);

  let _qTimer = null;
  document.addEventListener('input', (ev) => {
    if (!ev.target || ev.target.id !== 'spSearch') return;
    clearTimeout(_qTimer);
    _qTimer = setTimeout(() => {
      _q = ev.target.value;
      render();
      const s = $('spSearch');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }, 250);
  });

  // Template-stamped view: wait for the panel and the leads, then render.
  let _tries = 0, _timer = null;
  function maybeRender() {
    if (!/schedule/.test(location.hash || '')) return;
    clearTimeout(_timer); _tries = 0;
    const tick = () => {
      if ($('schedPlanPanel') && Array.isArray(window._leads)) { render(); return; }
      if (++_tries < 40) _timer = setTimeout(tick, 500);
    };
    _timer = setTimeout(tick, 200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', maybeRender); else maybeRender();
  window.addEventListener('hashchange', maybeRender);
  window.addEventListener('nbd:data-refreshed', maybeRender);

  window.NBDSchedulePlannerUI = { render, _checkBusy: checkBusy, _offerFor: offerFor };
})();
