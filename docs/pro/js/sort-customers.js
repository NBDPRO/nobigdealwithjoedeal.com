/**
 * sort-customers.js — "Sort my customers" (Jo, 2026-10-01).
 *
 * 118 of 182 live customers had no job type, so the Insurance / Cash /
 * Finance / Service / Warranty boards looked empty and Jo only ever used
 * All. Jo chose "suggest + sort":
 *
 *   - A banner above the board: "N customers have no job type · Sort them".
 *   - A screen listing each one with a SUGGESTED type and why
 *     (window.suggestJobType in crm-stages.js — reads the claim/loan fields,
 *     the stage and the request text, never writes), a per-row picker
 *     (44px), and filters: Suggested / No clues / All.
 *   - "Save" writes only the rows that have a type picked: jobType +
 *     updatedAt on the lead (writeBatch, chunked), then a best-effort
 *     "Classification changed" timeline note per lead, the same note
 *     changeLeadType writes. Nothing saves until Jo taps Save.
 *
 * Only leads the user may edit are listed: their own, or the company's
 * when they are company_admin / manager (rules allow both). Viewers never
 * see the banner. Prospects and deleted leads are out.
 *
 * CSP: no inline handlers; one delegated listener. Styles: css/sort-customers.css.
 * Test hook: window.NBDSortCustomers.
 */
(function () {
  'use strict';
  if (window.NBDSortCustomers) return;

  var TYPES = ['insurance', 'cash', 'finance', 'service', 'warranty'];
  var MODAL_ID = 'sortCustomersModal';
  var CHUNK = 200;
  var state = { filter: 'suggested', picks: {}, rows: [], saving: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function meta() { return window.JOB_TYPE_META || {}; }
  function typeLabel(t) { return (meta()[t] && meta()[t].label) || t; }
  function claims() { return window._userClaims || {}; }
  function me() { return window._user && window._user.uid; }

  function canEdit(l) {
    var c = claims();
    if (c.role === 'viewer') return false;
    if (c.role === 'admin') return true;
    if (l.userId && l.userId === me()) return true;
    return ['company_admin', 'manager'].indexOf(c.role || '') !== -1 && !!c.companyId && l.companyId === c.companyId;
  }
  function hasType(l) {
    var t = String(l.jobType || '').trim().toLowerCase();
    return TYPES.indexOf(t) !== -1;
  }
  function untyped() {
    return (window._leads || []).filter(function (l) {
      return l && !l.deleted && !l.isDeleted && !l.deletedAt && !l.isProspect && !hasType(l) && canEdit(l);
    });
  }
  function suggest(l) {
    try { return typeof window.suggestJobType === 'function' ? window.suggestJobType(l) : null; } catch (_) { return null; }
  }
  function nameOf(l) {
    return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || l.address || 'Unnamed';
  }
  function stageText(l) {
    var key = typeof window.normalizeStage === 'function' ? window.normalizeStage(l.stage || 'new') : (l.stage || 'new');
    var M = window.STAGE_META || {};
    return (M[key] && M[key].label) || key;
  }

  // ── Banner ───────────────────────────────────────────────────────
  function refresh() {
    var wrap = document.getElementById('sortCustomersWrap');
    if (!wrap) return;
    var n = untyped().length;
    if (!n) { wrap.hidden = true; wrap.innerHTML = ''; return; }
    wrap.hidden = false;
    wrap.innerHTML = '<div class="sc-banner" role="status">' +
      '<span class="sc-banner-text"><strong>' + n + '</strong> customer' + (n === 1 ? ' has' : 's have') +
      ' no job type, so they only show on <em>All</em> and Insurance.</span>' +
      '<button type="button" class="sc-btn sc-btn-primary" data-sc="open">Sort them</button></div>';
  }

  // ── Screen ───────────────────────────────────────────────────────
  function ensureModal() {
    var m = document.getElementById(MODAL_ID);
    if (m) return m;
    m = document.createElement('div');
    m.className = 'modal-bg';
    m.id = MODAL_ID;
    m.innerHTML = '<div class="modal sc-modal" role="dialog" aria-modal="true" aria-labelledby="scTitle">' +
      '<div class="sc-head"><h2 id="scTitle" class="sc-title">Sort my customers</h2>' +
      '<button type="button" class="sc-btn sc-close" data-sc="close" aria-label="Close">✕</button></div>' +
      '<p class="sc-lede">Each customer needs a job type so it shows on the right board. Suggestions come from what\'s on file (claim info, the request, the stage). Change any you disagree with, then Save. Nothing changes until you do.</p>' +
      '<div class="sc-filters" role="tablist"></div>' +
      '<div class="sc-bulk"></div>' +
      '<div class="sc-list"></div>' +
      '<div class="sc-foot"><span class="sc-status" aria-live="polite"></span>' +
      '<button type="button" class="sc-btn sc-btn-primary sc-save" data-sc="save">Save</button></div>' +
      '</div>';
    document.body.appendChild(m);
    return m;
  }

  function buildRows() {
    state.rows = untyped().map(function (l) { return { lead: l, s: suggest(l) }; })
      .sort(function (a, b) {
        // Strong suggestions first, then likely, then no clues; by name within.
        var rank = function (r) { return !r.s ? 2 : r.s.strength === 'strong' ? 0 : 1; };
        return rank(a) - rank(b) || nameOf(a.lead).localeCompare(nameOf(b.lead));
      });
    state.rows.forEach(function (r) {
      if (!(r.lead.id in state.picks)) state.picks[r.lead.id] = r.s ? r.s.type : '';
    });
  }

  function visibleRows() {
    return state.rows.filter(function (r) {
      if (state.filter === 'suggested') return !!r.s;
      if (state.filter === 'none') return !r.s;
      return true;
    });
  }

  function pickedCount() {
    return state.rows.filter(function (r) { return !!state.picks[r.lead.id]; }).length;
  }

  function render() {
    var m = ensureModal();
    var withS = state.rows.filter(function (r) { return !!r.s; }).length;
    var tabs = [['suggested', 'Suggested', withS], ['none', 'No clues', state.rows.length - withS], ['all', 'All', state.rows.length]];
    m.querySelector('.sc-filters').innerHTML = tabs.map(function (t) {
      return '<button type="button" role="tab" class="sc-btn sc-tab' + (state.filter === t[0] ? ' is-on' : '') + '" aria-selected="' + (state.filter === t[0]) +
        '" data-sc="filter" data-arg="' + t[0] + '">' + t[1] + ' <span class="sc-count">' + t[2] + '</span></button>';
    }).join('');
    m.querySelector('.sc-bulk').innerHTML = '<label class="sc-bulk-label" for="scBulkType">Set everyone shown to</label>' +
      '<select id="scBulkType" class="sc-select"><option value="">…</option>' +
      TYPES.map(function (t) { return '<option value="' + t + '">' + esc(typeLabel(t)) + '</option>'; }).join('') +
      '<option value="__clear">Skip (leave untyped)</option></select>';

    var rows = visibleRows();
    m.querySelector('.sc-list').innerHTML = rows.length ? rows.map(function (r) {
      var l = r.lead, pick = state.picks[l.id] || '';
      var why = r.s ? '<span class="sc-why sc-why-' + r.s.strength + '">' + (r.s.strength === 'strong' ? '' : 'Looks like: ') + esc(r.s.reason) + '</span>'
        : '<span class="sc-why sc-why-none">No clues on file. Your call.</span>';
      return '<div class="sc-row" data-lead-id="' + esc(l.id) + '">' +
        '<div class="sc-who"><a class="sc-name" href="/pro/customer.html?id=' + encodeURIComponent(l.id) + '" target="_blank" rel="noopener">' + esc(nameOf(l)) + '</a>' +
        '<span class="sc-meta">' + esc(stageText(l)) + (l.source ? ' · ' + esc(l.source) : '') + '</span>' + why + '</div>' +
        '<select class="sc-select sc-pick" data-sc-pick="' + esc(l.id) + '" aria-label="Job type for ' + esc(nameOf(l)) + '">' +
        '<option value=""' + (pick ? '' : ' selected') + '>Skip</option>' +
        TYPES.map(function (t) { return '<option value="' + t + '"' + (pick === t ? ' selected' : '') + '>' + esc(typeLabel(t)) + '</option>'; }).join('') +
        '</select></div>';
    }).join('') : '<div class="sc-empty">' + (state.rows.length ? 'Nothing in this list.' : 'Every customer has a job type. Nice.') + '</div>';

    var n = pickedCount();
    var save = m.querySelector('.sc-save');
    save.textContent = state.saving ? 'Saving…' : (n ? 'Save ' + n + ' customer' + (n === 1 ? '' : 's') : 'Save');
    save.disabled = state.saving || !n;
  }

  function status(text) {
    var s = document.querySelector('#' + MODAL_ID + ' .sc-status');
    if (s) s.textContent = text || '';
  }

  function open() {
    state.picks = {};
    state.filter = 'suggested';
    buildRows();
    if (!state.rows.some(function (r) { return !!r.s; })) state.filter = 'all';
    render();
    status('');
    if (window.nbdModal) window.nbdModal.open(MODAL_ID, { onClose: function () { status(''); } });
    else ensureModal().classList.add('open');
  }
  function close() {
    if (window.nbdModal) window.nbdModal.close(MODAL_ID);
    else { var m = document.getElementById(MODAL_ID); if (m) m.classList.remove('open'); }
  }

  async function save() {
    if (state.saving) return { saved: 0 };
    var todo = state.rows.filter(function (r) { return TYPES.indexOf(state.picks[r.lead.id]) !== -1; });
    if (!todo.length) return { saved: 0 };
    if (!window.writeBatch || !window.db || !window.doc || !window.serverTimestamp) {
      status('Could not save: the database is not loaded. Refresh and try again.');
      return { saved: 0, error: 'no_db' };
    }
    state.saving = true; render();
    var saved = 0, failedChunks = 0;
    for (var i = 0; i < todo.length; i += CHUNK) {
      var part = todo.slice(i, i + CHUNK);
      status('Saving ' + Math.min(i + part.length, todo.length) + ' of ' + todo.length + '…');
      try {
        var batch = window.writeBatch(window.db);
        part.forEach(function (r) {
          batch.update(window.doc(window.db, 'leads', r.lead.id), { jobType: state.picks[r.lead.id], updatedAt: window.serverTimestamp() });
        });
        await batch.commit();
        part.forEach(function (r) { r.lead.jobType = state.picks[r.lead.id]; });
        saved += part.length;
        // Timeline notes: best-effort, their own batch, so a note the rules
        // refuse never undoes the type change.
        try {
          var nb = window.writeBatch(window.db);
          part.forEach(function (r) {
            nb.set(window.doc(window.collection(window.db, 'notes')), {
              leadId: r.lead.id, userId: me(),
              text: 'Classification changed: Unset → ' + typeLabel(state.picks[r.lead.id]) + ' (Sort my customers)',
              type: 'type_change', createdAt: window.serverTimestamp(),
              createdBy: (window._user && window._user.email) || 'system',
            });
          });
          await nb.commit();
        } catch (e) { console.warn('[sort-customers] timeline notes skipped:', e && e.message); }
      } catch (e) {
        failedChunks++;
        console.error('[sort-customers] save failed', e);
      }
    }
    state.saving = false;
    if (typeof window.renderLeads === 'function') {
      try { window.renderLeads(window._leads, window._filteredLeads); } catch (_) {}
    }
    refresh();
    buildRows();
    render();
    var msg = 'Sorted ' + saved + ' customer' + (saved === 1 ? '' : 's') + '.' + (failedChunks ? ' Some could not be saved; try again.' : '');
    status(msg);
    if (typeof window.showToast === 'function') window.showToast(msg, failedChunks ? 'error' : 'ok');
    return { saved: saved, failed: failedChunks };
  }

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-sc]') : null;
    if (!b) return;
    var a = b.getAttribute('data-sc');
    if (a === 'open') open();
    else if (a === 'close') close();
    else if (a === 'save') save();
    else if (a === 'filter') { state.filter = b.getAttribute('data-arg') || 'all'; render(); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.closest || !t.closest('#' + MODAL_ID)) return;
    if (t.hasAttribute('data-sc-pick')) {
      state.picks[t.getAttribute('data-sc-pick')] = t.value;
      render();
    } else if (t.id === 'scBulkType' && t.value) {
      var v = t.value === '__clear' ? '' : t.value;
      visibleRows().forEach(function (r) { state.picks[r.lead.id] = v; });
      render();
    }
  });
  window.addEventListener('nbd:data-refreshed', refresh);

  window.NBDSortCustomers = { refresh: refresh, open: open, close: close, save: save, _state: state, _untyped: untyped };
  refresh();
})();
