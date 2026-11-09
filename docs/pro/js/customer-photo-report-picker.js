/**
 * customer-photo-report-picker.js — the photo report builder.
 *
 * This was two buttons. It called generatePhotoReport(customerId, mode) and
 * that was the entire configuration surface of the document: homeowner or
 * adjuster. Its own copy promised "numbered photos for supplements" while the
 * server template — the path that actually runs — emitted no numbers at all,
 * which is what happens when the control surface and the renderer are written
 * years apart with nothing tying them together.
 *
 * D-6: the presets stay (most reports want one of the two, one click), and
 * "Customize…" opens the real option set. The controls are GENERATED from a
 * spec that mirrors REPORT_DEFAULTS in photo-report.js, so a new option means
 * one entry in one list rather than markup here drifting from behaviour there.
 *
 * CSP: /pro ships `script-src-attr 'none'` with no unsafe-inline, so there is
 * not an on* attribute anywhere below. Every control is bound with
 * addEventListener against elements this file created.
 */
(function () {
  'use strict';

  var BUILDER_ID = 'prpBuilder';

  // This file is LAZY on customer.html (ScriptLoader 'photoreportpicker', since
  // 2026-11-08). customer-photo-report-lazy.js, on the boot path, registers the
  // bundle, keeps the generatePhotoReport stub that used to live here, and
  // stubs openPhotoReportPicker until the definition below replaces it.

  // The control spec. `key` matches a field of REPORT_DEFAULTS; the builder
  // reads current values from photo-report.js's _photoReportOptions(mode) (via
  // __NBD_CALL_REGISTRY — see _reportOptionsFn below) so the UI opens
  // showing the real defaults for the chosen preset rather than a second copy
  // of them maintained here.
  var CONTROLS = [
    { group: 'Cover & style', items: [
      { key: 'cover',     label: 'Cover',     type: 'seg', options: [['hero', 'Photo'], ['minimal', 'Text only'], ['none', 'None']] },
      { key: 'density',   label: 'Style',     type: 'seg', options: [['comfortable', 'Editorial'], ['compact', 'Compact'], ['evidence', 'Evidence']] },
      { key: 'columns',   label: 'Per row',   type: 'seg', options: [[0, 'Auto'], [1, '1'], [2, '2'], [3, '3'], [4, '4']] },
      { key: 'fit',       label: 'Images',    type: 'seg', options: [['cover', 'Crop to fit'], ['contain', 'Show whole photo']] },
    ] },
    { group: 'Numbering & detail', items: [
      { key: 'numbering', label: 'Numbering', type: 'seg', options: [['continuous', 'Continuous'], ['section', 'Per section'], ['none', 'Off']] },
      { key: 'signature', label: 'Signature', type: 'seg', options: [['none', 'None'], ['homeowner', 'Homeowner'], ['adjuster', 'Adjuster'], ['both', 'Both']] },
      { key: 'showToc',      label: 'Contents page', type: 'check' },
      { key: 'showStats',    label: 'At-a-glance counts', type: 'check' },
      { key: 'showPairs',    label: 'Before / after pairs', type: 'check' },
      { key: 'showDate',     label: 'Capture date on each photo', type: 'check' },
      { key: 'showLocation', label: 'Location tag', type: 'check' },
      { key: 'showDamage',   label: 'Damage type', type: 'check' },
      { key: 'showSeverity', label: 'Severity badge', type: 'check' },
    ] },
  ];

  var NOTE_FIELDS = [
    { key: 'coverLetter', label: 'Cover letter', rows: 4, ph: 'A note to open the report. Appears on its own page, before anything else.' },
    { key: 'summaryBody', label: 'Summary',      rows: 3, ph: 'Replaces the stock line under "At a Glance".' },
    { key: 'closing',     label: 'Closing note', rows: 3, ph: 'The last word — warranty, what happens next, how to reach you.' },
  ];

  var SECTION_IDS = ['before', 'during', 'after'];
  var SECTION_TITLES = { before: 'Before', during: 'During', after: 'After' };

  // Live builder state. Rebuilt from the preset each time one is chosen, so
  // switching Homeowner -> Adjuster genuinely resets to that mode's defaults
  // instead of leaving half the previous preset behind.
  var state = null;

  function esc(s) {
    return (window.nbdEsc || function (v) {
      return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
      });
    })(s);
  }

  // photo-report.js's option merger. Off window (Globals Tranche 3, T3-C) —
  // registered on __NBD_CALL_REGISTRY when the lazy 'photos' bundle executes.
  // null until then; every caller treats null as "not loaded yet".
  function _reportOptionsFn() {
    var reg = window.__NBD_CALL_REGISTRY;
    return (reg && typeof reg._photoReportOptions === 'function') ? reg._photoReportOptions : null;
  }

  function resetState(mode) {
    var optsFn = _reportOptionsFn();
    var opts = optsFn
      ? optsFn(mode)
      // photo-report.js is lazy (ScriptLoader 'photos'). If the builder is
      // opened before it lands we still render, with the options object empty;
      // generate() sends `undefined` and the report falls back to its own
      // per-mode defaults, which are the same values.
      : {};
    state = {
      mode: mode,
      options: opts,
      notes: { coverLetter: '', summaryBody: '', closing: '', sections: {} },
      order: SECTION_IDS.slice(),
      disabled: {},
      titles: {},
    };
  }

  function photoCounts() {
    // window._allPhotos is the customer page's live photo list
    // (customer-tasks-ui.js photoDocToView). Used only to show the rep how many
    // photos each section will contribute — the report re-queries for itself.
    var out = { before: 0, during: 0, after: 0, unphased: 0 };
    (window._allPhotos || []).forEach(function (p) {
      var ph = String((p && p.phase) || '').toLowerCase();
      if (ph.indexOf('before') >= 0) out.before++;
      else if (ph.indexOf('during') >= 0) out.during++;
      else if (ph.indexOf('after') >= 0) out.after++;
      else out.unphased++;
    });
    return out;
  }

  function segHtml(item, current) {
    return item.options.map(function (o) {
      var val = o[0], text = o[1];
      var on = String(current) === String(val);
      return '<button type="button" data-opt="' + esc(item.key) + '" data-val="' + esc(val) + '"'
        + ' aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(text) + '</button>';
    }).join('');
  }

  function render() {
    var el = document.getElementById(BUILDER_ID);
    if (!el || !state) return;
    var counts = photoCounts();
    var html = '';

    CONTROLS.forEach(function (g) {
      html += '<div class="prp-group"><div class="prp-legend">' + esc(g.group) + '</div>';
      g.items.forEach(function (item) {
        if (item.type === 'seg') {
          html += '<div class="prp-row"><span class="prp-label">' + esc(item.label) + '</span>'
            + '<span class="prp-seg">' + segHtml(item, state.options[item.key]) + '</span></div>';
        }
      });
      var checks = g.items.filter(function (i) { return i.type === 'check'; });
      if (checks.length) {
        html += '<div class="prp-row" style="gap:14px;">';
        checks.forEach(function (item) {
          html += '<label class="prp-check"><input type="checkbox" data-opt="' + esc(item.key) + '"'
            + (state.options[item.key] === false ? '' : ' checked') + '> ' + esc(item.label) + '</label>';
        });
        html += '</div>';
      }
      html += '</div>';
    });

    // Sections — order, on/off, title, and the rep's own note under the heading.
    html += '<div class="prp-group"><div class="prp-legend">Sections</div>';
    state.order.forEach(function (id, i) {
      var n = counts[id] || 0;
      html += '<div class="prp-sec" data-sec="' + esc(id) + '">'
        + '<div class="prp-sec-head">'
        + '<label class="prp-check"><input type="checkbox" data-sec-on="' + esc(id) + '"'
        + (state.disabled[id] ? '' : ' checked') + '></label>'
        + '<input type="text" data-sec-title="' + esc(id) + '" value="'
        + esc(state.titles[id] || SECTION_TITLES[id]) + '" aria-label="Section title">'
        + '<span class="prp-count">' + n + ' photo' + (n === 1 ? '' : 's') + '</span>'
        + '<button type="button" class="prp-move" data-sec-up="' + esc(id) + '"'
        + (i === 0 ? ' disabled' : '') + ' aria-label="Move up">↑</button>'
        + '<button type="button" class="prp-move" data-sec-down="' + esc(id) + '"'
        + (i === state.order.length - 1 ? ' disabled' : '') + ' aria-label="Move down">↓</button>'
        + '</div>'
        + '<textarea data-sec-note="' + esc(id) + '" rows="2" style="margin-top:8px;"'
        + ' placeholder="Note under this heading (optional)">' + esc(state.notes.sections[id] || '') + '</textarea>'
        + '</div>';
    });
    if (counts.unphased) {
      html += '<div class="prp-count" style="padding:2px 2px 0;">'
        + (counts.unphased === 1
          ? '1 photo has no phase tag — it is'
          : counts.unphased + ' photos have no phase tag — they are')
        + ' reported together under the first section.</div>';
    }
    html += '</div>';

    html += '<div class="prp-group"><div class="prp-legend">Your words</div>';
    NOTE_FIELDS.forEach(function (f) {
      html += '<div style="margin-bottom:10px;">'
        + '<label class="prp-label" style="display:block;margin-bottom:4px;" for="prpNote_' + esc(f.key) + '">'
        + esc(f.label) + '</label>'
        + '<textarea id="prpNote_' + esc(f.key) + '" data-note="' + esc(f.key) + '" rows="' + f.rows + '"'
        + ' placeholder="' + esc(f.ph) + '">' + esc(state.notes[f.key]) + '</textarea></div>';
    });
    html += '</div>';

    el.innerHTML = html;
  }

  function setPreset(mode) {
    resetState(mode);
    var wrap = document.getElementById('photoReportPicker');
    if (wrap) {
      wrap.querySelectorAll('[data-prp-preset]').forEach(function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-prp-preset') === mode ? 'true' : 'false');
      });
    }
    render();
  }

  function collect() {
    // state is already the source of truth — inputs write into it on change —
    // so this only strips empties so the payload does not carry a dozen ''
    // fields the template would then have to guard.
    var notes = {};
    NOTE_FIELDS.forEach(function (f) { if (state.notes[f.key]) notes[f.key] = state.notes[f.key]; });
    var secNotes = {};
    SECTION_IDS.forEach(function (id) { if (state.notes.sections[id]) secNotes[id] = state.notes.sections[id]; });
    if (Object.keys(secNotes).length) notes.sections = secNotes;

    var titles = {};
    SECTION_IDS.forEach(function (id) {
      if (state.titles[id] && state.titles[id] !== SECTION_TITLES[id]) titles[id] = state.titles[id];
    });

    var disabled = Object.keys(state.disabled).filter(function (k) { return state.disabled[k]; });

    return {
      options: state.options,
      notes: notes,
      sectionOrder: state.order.slice(),
      disabledSections: disabled,
      sectionTitles: titles,
    };
  }

  // ── Wiring ────────────────────────────────────────────────────
  function onBuilderInput(e) {
    var t = e.target;
    if (!t || !state) return;
    if (t.matches('input[type="checkbox"][data-opt]')) {
      state.options[t.getAttribute('data-opt')] = t.checked;
    } else if (t.matches('[data-note]')) {
      state.notes[t.getAttribute('data-note')] = t.value;
    } else if (t.matches('[data-sec-note]')) {
      state.notes.sections[t.getAttribute('data-sec-note')] = t.value;
    } else if (t.matches('[data-sec-title]')) {
      state.titles[t.getAttribute('data-sec-title')] = t.value;
    } else if (t.matches('[data-sec-on]')) {
      state.disabled[t.getAttribute('data-sec-on')] = !t.checked;
    }
  }

  function onBuilderClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!t || !state) return;
    if (t.hasAttribute('data-opt')) {
      e.preventDefault();
      var key = t.getAttribute('data-opt');
      var raw = t.getAttribute('data-val');
      // `columns` is the one numeric option; every other seg value is a string
      // enum, and photo-report.js coerces anything it does not recognise.
      state.options[key] = (key === 'columns') ? Number(raw) : raw;
      render();
      return;
    }
    var up = t.getAttribute('data-sec-up');
    var down = t.getAttribute('data-sec-down');
    if (up || down) {
      e.preventDefault();
      var id = up || down;
      var i = state.order.indexOf(id);
      var j = up ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= state.order.length) return;
      var tmp = state.order[i]; state.order[i] = state.order[j]; state.order[j] = tmp;
      render();
    }
  }

  window.openPhotoReportPicker = function () {
    if (!window._customerId) {
      if (typeof showToast === 'function') showToast('No customer loaded yet', 'error');
      return;
    }
    setPreset('homeowner');
    var b = document.getElementById(BUILDER_ID);
    var tgl = document.getElementById('prpToggle');
    if (b) b.hidden = true;
    if (tgl) tgl.textContent = 'Customize…';
    window.nbdModal.open('photoReportPicker');
    // photo-report.js is lazy (ScriptLoader 'photos'), and it owns
    // REPORT_DEFAULTS. Until it lands, _reportOptionsFn() is null and the
    // builder would render every toggle checked rather than this mode's real
    // defaults. Warm the bundle on open and re-seed once it arrives; the rep is
    // reading the two preset cards while it loads.
    if (!_reportOptionsFn()
        && window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
      window.ScriptLoader.loadBundle('photos').then(function () {
        if (_reportOptionsFn() && state) setPreset(state.mode);
      }).catch(function () { /* builder still works on the report's own defaults */ });
    }
  };
  window.closePhotoReportPicker = function () {
    window.nbdModal.close('photoReportPicker');
  };

  /**
   * Kept as a global because the two-argument form is a documented entry point
   * (photo-review.html deep-links here) and because dashboard-actions.js
   * dispatches to it by name.
   */
  window.pickPhotoReport = function (mode, build) {
    closePhotoReportPicker();
    if (typeof generatePhotoReport === 'function') {
      generatePhotoReport(window._customerId, mode, build);
    } else if (typeof showToast === 'function') {
      showToast('Report module not loaded yet — try again in a moment', 'error');
    }
  };

  function bind() {
    var wrap = document.getElementById('photoReportPicker');
    if (!wrap || wrap.__prpBound) return;
    wrap.__prpBound = true;

    wrap.addEventListener('click', function (e) {
      var preset = e.target && e.target.closest ? e.target.closest('[data-prp-preset]') : null;
      if (preset) { e.preventDefault(); setPreset(preset.getAttribute('data-prp-preset')); return; }
      if (e.target.closest('#prpCancel')) { e.preventDefault(); closePhotoReportPicker(); return; }
      if (e.target.closest('#prpToggle')) {
        e.preventDefault();
        var b = document.getElementById(BUILDER_ID);
        var tgl = document.getElementById('prpToggle');
        if (!b) return;
        b.hidden = !b.hidden;
        if (tgl) tgl.textContent = b.hidden ? 'Customize…' : 'Hide options';
        return;
      }
      if (e.target.closest('#prpGenerate')) {
        e.preventDefault();
        var build = state ? collect() : undefined;
        window.pickPhotoReport(state ? state.mode : 'homeowner', build);
        return;
      }
      if (e.target.closest('#' + BUILDER_ID)) onBuilderClick(e);
    });

    // `input` for typing, `change` for checkboxes — one handler, both events,
    // so a note the rep is still typing is captured without a re-render
    // stealing the caret.
    var b = document.getElementById(BUILDER_ID);
    if (b) {
      b.addEventListener('input', onBuilderInput);
      b.addEventListener('change', onBuilderInput);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  // Backdrop click + Esc dismiss are handled by nbdModal (batch-4 consolidation).
  // Phase 5: auto-open the builder when arriving from photo-review.html
  // with a #photo-report hash. Defer until _customerId is populated.
  function maybeAutoOpenFromHash() {
    if (window.location.hash !== '#photo-report') return;
    if (!window._customerId) { setTimeout(maybeAutoOpenFromHash, 250); return; }
    history.replaceState(null, '', window.location.pathname + window.location.search);
    openPhotoReportPicker();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(maybeAutoOpenFromHash, 600); });
  } else {
    setTimeout(maybeAutoOpenFromHash, 600);
  }

  // Exported for tests: the spec-to-payload shape is the contract between this
  // builder and generatePhotoReport, and it is worth asserting directly.
  window._prpCollect = function () { return state ? collect() : null; };
  window._prpSetPreset = setPreset;
  window._prpControls = CONTROLS;
})();
