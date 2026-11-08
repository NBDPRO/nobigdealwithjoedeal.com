/**
 * customer-photo-report-lazy.js — the customer page's photo report entry
 * points; the builder itself loads on demand (boot-weight lane, 2026-11-08).
 *
 * customer-photo-report-picker.js (the builder, ~11 KB shipped) was an eager
 * <script defer> on every customer card, but nothing it does shows before a
 * rep opens a photo report: it binds listeners on the hidden
 * #photoReportPicker modal and defines the functions that open it. It is now
 * the ScriptLoader bundle `photoreportpicker`, registered here at runtime (like
 * dark-features.js, so the blocking script-loader.js does not grow). This file
 * keeps on the boot path only what has to be there:
 *
 *   - window.generatePhotoReport: the load-then-run stub for photo-report.js,
 *     moved here from the picker. The "📋 Generate Report" button dispatches it
 *     by name, and tests/e2e/boot-weight.spec.js expects the stub at boot.
 *   - window.openPhotoReportPicker: the "📸 Photo Report" button dispatches it
 *     by name. The stub loads the bundle, the picker's own definition replaces
 *     this one as it runs, and the stub then calls it (load-then-call).
 *   - the #photo-report deep link (photo-review.html, the dashboard's photo
 *     report chip): the bundle loads at once and the picker's own
 *     maybeAutoOpenFromHash opens the builder when it lands.
 *
 * A failed fetch leaves the card working without the builder: ScriptLoader
 * resolves (never rejects) and keeps the failed <script> tag, so a later
 * load() finds the tag and does not fetch again. The stub says so and asks
 * for a refresh, which is the only retry.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var BUNDLE = 'photoreportpicker';
  var FILES = ['js/customer-photo-report-picker.js?v=3'];

  function loader() {
    var sl = window.ScriptLoader;
    if (!sl || typeof sl.loadBundle !== 'function') return null;
    if (sl.bundles && !sl.bundles[BUNDLE]) sl.bundles[BUNDLE] = FILES;
    return sl;
  }

  // photo-report.js is LAZY on this page (ScriptLoader 'photos' bundle) as of
  // 2026-09-06. Both customer-page entry points resolve the global by NAME at
  // click time — pickPhotoReport() in customer-photo-report-picker.js, and the
  // "📋 Generate Report" button (customer-bootstrap.module.js:1354, data-action="generatePhotoReport") —
  // so a load-then-run stub is what keeps the button from being a SILENT
  // no-op: without it the action dispatcher just logs an unknown action and
  // nothing visible happens. tests/smoke/photo.test.js:1224 pins this, and
  // caught its removal during the D-6 rewrite of the picker.
  //
  // `arguments` is forwarded whole, so the third builder argument reaches the
  // real implementation the same as leadId and mode.
  //
  // Guarded on typeof so this never clobbers a real implementation (the
  // dashboard installs its own stub in dashboard-actions.js and is unaffected).
  if (typeof window.generatePhotoReport !== 'function') {
    window.generatePhotoReport = function () {
      var args = arguments;
      if (!(window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function')) {
        if (typeof showToast === 'function') showToast('Report module unavailable — refresh and try again', 'error');
        return;
      }
      if (typeof showToast === 'function') showToast('Preparing photo report…', 'info');
      return window.ScriptLoader.loadBundle('photos').then(function () {
        var fn = window.generatePhotoReport;
        // photo-report.js overwrites the global on arrival; if it is still the
        // stub, the fetch failed (load() never rejects) — say so rather than recursing.
        if (typeof fn === 'function' && !fn.__nbdLazyPhotoReportStub) return fn.apply(null, args);
        if (typeof showToast === 'function') showToast('Report module failed to load — try again', 'error');
      });
    };
    window.generatePhotoReport.__nbdLazyPhotoReportStub = true;
  }

  // The picker assigns window.openPhotoReportPicker unconditionally as it
  // runs, so after the load this name holds the real builder; if it still
  // holds this stub, the fetch failed.
  if (typeof window.openPhotoReportPicker !== 'function') {
    window.openPhotoReportPicker = function () {
      var args = arguments;
      var sl = loader();
      if (!sl) {
        if (typeof showToast === 'function') showToast('Photo report builder unavailable — refresh the page', 'error');
        return;
      }
      return sl.loadBundle(BUNDLE).then(function () {
        var fn = window.openPhotoReportPicker;
        if (typeof fn === 'function' && !fn.__nbdLazyPhotoReportPickerStub) return fn.apply(window, args);
        if (typeof showToast === 'function') showToast('Photo report builder failed to load — refresh the page', 'error');
      });
    };
    window.openPhotoReportPicker.__nbdLazyPhotoReportPickerStub = true;
  }

  var sl = loader();
  if (sl && window.location && window.location.hash === '#photo-report') sl.loadBundle(BUNDLE);
})();
