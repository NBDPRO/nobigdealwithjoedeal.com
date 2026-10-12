/**
 * schedule-window-ui.js — the arrival-window controls beside a Scheduled Date
 * input (2026-09-29, calendar hub plan Phase 0).
 *
 * Two forms carry them: the dashboard lead modal (#lScheduledDate, prefix
 * 'l') and the customer page's Edit Customer modal (#editScheduledDate,
 * prefix 'edit'). Each has the same markup, keyed by prefix:
 *
 *   <div data-schedwin="<prefix>" data-schedwin-date="<date input id>">
 *     three [data-schedwin-preset] buttons: allday | project | repair
 *     #<prefix>SchedStart (time) · #<prefix>SchedDays · #<prefix>SchedDuration
 *     #<prefix>SchedPreview
 *   </div>
 *
 * Jo's presets (plan "Jo's answers" §1):
 *   All day / no time   — the three new fields stay empty; the lead saves
 *                         exactly as it always has.
 *   Full project        — pre-fills 7:00 am and 1 day (2 or 3 in the picker);
 *                         saves scheduledStart + scheduledEndDate.
 *   Repair / inspection — asks for a time and a length; saves scheduledStart
 *                         + scheduledDurationMin.
 *
 * The date math is schedule-window.js's; this file only reads and writes the
 * DOM. CSP: no inline handlers — one delegated click + input listener on
 * document, keyed on data-schedwin*. The presets change the form only; the
 * form's own Save (role-gated) does the write.
 */
(function () {
  'use strict';
  if (window.NBDScheduleWindowUI) return;

  var MODES = ['allday', 'project', 'repair'];

  function W() { return window.NBDScheduleWindow || null; }
  function root(prefix) { return document.querySelector('[data-schedwin="' + prefix + '"]'); }
  function el(prefix, suffix) { return document.getElementById(prefix + suffix); }
  function dateOf(prefix) {
    var r = root(prefix);
    var d = r && document.getElementById(r.getAttribute('data-schedwin-date'));
    return d ? String(d.value || '').trim() : '';
  }
  function modeOf(prefix) {
    var r = root(prefix);
    var m = r && r.getAttribute('data-schedwin-mode');
    return MODES.indexOf(m) === -1 ? 'allday' : m;
  }
  function todayYmd() {
    var n = new Date();
    var p = function (v) { return (v < 10 ? '0' : '') + v; };
    return n.getFullYear() + '-' + p(n.getMonth() + 1) + '-' + p(n.getDate());
  }

  // A stored value the picker does not list (a 45-minute job, a 5-day
  // project) gets its own option rather than silently becoming the default.
  function ensureOption(select, value, label) {
    if (!select) return;
    var v = String(value);
    for (var i = 0; i < select.options.length; i++) if (select.options[i].value === v) return;
    var o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    select.appendChild(o);
  }

  function setMode(prefix, mode) {
    var r = root(prefix);
    if (!r) return;
    var m = MODES.indexOf(mode) === -1 ? 'allday' : mode;
    r.setAttribute('data-schedwin-mode', m);
    Array.prototype.forEach.call(r.querySelectorAll('[data-schedwin-preset]'), function (b) {
      var on = b.getAttribute('data-schedwin-preset') === m;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.style.background = on ? 'var(--orange,#BD5728)' : 'transparent';
      b.style.color = on ? '#fff' : 'var(--t)';
      b.style.borderColor = on ? 'var(--orange,#BD5728)' : 'var(--br)';
    });
    // hidden AND display:none — a stylesheet `display` on .mfield outranks the
    // browser's [hidden] rule, so the attribute alone can leave a field showing.
    var show = function (x, on) { x.hidden = !on; x.style.display = on ? '' : 'none'; };
    var fields = r.querySelector('[data-schedwin-fields]');
    if (fields) show(fields, m !== 'allday');
    Array.prototype.forEach.call(r.querySelectorAll('[data-schedwin-for]'), function (x) {
      show(x, x.getAttribute('data-schedwin-for') === m);
    });
    preview(prefix);
  }

  // The three lead fields this form would save. Empty ones are null, so a
  // switch back to "All day" clears a window that was saved before.
  function read(prefix) {
    var out = { scheduledStart: null, scheduledDurationMin: null, scheduledEndDate: null };
    var mode = modeOf(prefix);
    if (mode === 'allday') return out;
    var s = el(prefix, 'SchedStart');
    out.scheduledStart = s && s.value ? String(s.value).slice(0, 5) : null;
    if (mode === 'project') {
      var days = parseInt((el(prefix, 'SchedDays') || {}).value, 10) || 1;
      var date = dateOf(prefix);
      out.scheduledEndDate = date && W() ? W().addDays(date, days - 1) : null;
    } else {
      var d = el(prefix, 'SchedDuration');
      out.scheduledDurationMin = d && d.value ? parseInt(d.value, 10) : null;
    }
    return out;
  }

  // null when the form may save, else the message to show.
  function validate(prefix) {
    var mode = modeOf(prefix);
    if (mode === 'allday' || !W()) return null;
    var date = dateOf(prefix);
    if (!date) return W().ERRORS['no-date'];
    var f = read(prefix);
    if (mode === 'repair' && !f.scheduledStart) return 'Pick a start time for the repair / inspection.';
    var r = W().check(Object.assign({ scheduledDate: date }, f));
    return r.ok ? null : (W().ERRORS[r.error] || 'Check the arrival window.');
  }

  function preview(prefix) {
    var out = el(prefix, 'SchedPreview');
    if (!out || !W()) return;
    var date = dateOf(prefix);
    var err = validate(prefix);
    out.style.color = err ? 'var(--red,#ef4444)' : 'var(--m)';
    out.textContent = err || (date ? W().formatWindow(Object.assign({ scheduledDate: date }, read(prefix)), todayYmd()) : '');
  }

  // Open the form on a lead's saved window (or blank for a new lead).
  function fill(prefix, lead) {
    var l = lead || {};
    var start = el(prefix, 'SchedStart');
    var days = el(prefix, 'SchedDays');
    var dur = el(prefix, 'SchedDuration');
    var w = W() && W().normalize(l);
    if (start) start.value = (w && w.start) || '';
    if (days) days.value = '1';
    if (dur) dur.value = '';
    var mode = 'allday';
    if (w && w.kind === 'project') {
      mode = 'project';
      ensureOption(days, w.days, w.days + ' days');
      if (days) days.value = String(w.days);
    } else if (w && w.kind === 'timed') {
      mode = 'repair';
      if (w.durationMin) {
        ensureOption(dur, w.durationMin, w.durationMin + ' min');
        if (dur) dur.value = String(w.durationMin);
      }
    }
    setMode(prefix, mode);
  }

  function reset(prefix) { fill(prefix, null); }

  // Preset tap: switch mode and pre-fill what Jo said each one means.
  function applyPreset(prefix, mode) {
    var start = el(prefix, 'SchedStart');
    if (mode === 'project') {
      var P = (W() && W().PRESETS.project) || { start: '07:00' };
      if (start && !start.value) start.value = P.start;
    } else if (mode === 'repair') {
      var dur = el(prefix, 'SchedDuration');
      if (dur && !dur.value) dur.value = '60';
    }
    setMode(prefix, mode);
    if (mode === 'repair' && start && !start.value) { try { start.focus(); } catch (_) {} }
  }

  document.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest && ev.target.closest('[data-schedwin-preset]');
    if (!b) return;
    var r = b.closest('[data-schedwin]');
    if (!r) return;
    ev.preventDefault();
    applyPreset(r.getAttribute('data-schedwin'), b.getAttribute('data-schedwin-preset'));
  });
  // Any edit inside a window block — or to the date input it hangs off —
  // refreshes that block's preview line.
  function onEdit(ev) {
    var t = ev.target;
    if (!t) return;
    var r = t.closest && t.closest('[data-schedwin]');
    if (r) { preview(r.getAttribute('data-schedwin')); return; }
    if (!t.id) return;
    var owner = document.querySelector('[data-schedwin-date="' + t.id + '"]');
    if (owner) preview(owner.getAttribute('data-schedwin'));
  }
  document.addEventListener('input', onEdit);
  document.addEventListener('change', onEdit);

  window.NBDScheduleWindowUI = {
    fill: fill,
    reset: reset,
    read: read,
    validate: validate,
    setMode: setMode,
    preview: preview
  };
})();
