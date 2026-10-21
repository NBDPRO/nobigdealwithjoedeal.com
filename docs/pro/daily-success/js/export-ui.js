/**
 * export-ui.js — the "Download my data" card on the dashboard (tracker idea
 * #8). Rules and file contents: export-logic.js (window.NBDExport).
 *
 * Everything happens on the device: the stores are read from localStorage,
 * wrapped in a Blob and handed to a temporary <a download>. Nothing is sent
 * anywhere. Each file is its own tap, so iOS never sees a burst of automatic
 * downloads; where the browser can share files (iPhone), each row also gets a
 * "Share" button — the sheet's "Save to Files" is the dependable route in the
 * installed app.
 *
 * Classic script after money-ui.js. Delegated listeners; every value into
 * innerHTML is escaped.
 */
(function () {
  'use strict';
  if (window.NBDExportUI) return;
  const X = () => window.NBDExport;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { if (typeof window.toast === 'function') window.toast(m); };

  let _files = null;

  function readStores() {
    const raw = {};
    Object.keys(X().KEYS).forEach((k) => {
      const key = X().KEYS[k];
      try { raw[key] = localStorage.getItem(key); } catch (_) { raw[key] = null; }
    });
    return raw;
  }
  const blobOf = (f) => new Blob([f.text], { type: f.mime });
  const fileOf = (f) => new File([f.text], f.name, { type: f.mime.split(';')[0] });
  function canShareFiles() {
    try { return !!(navigator.canShare && typeof File === 'function' && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] })); } catch (_) { return false; }
  }

  function cardHtml() {
    return '<div class="wc-card ex-card" id="exCard"><div class="wc-card-h">💾 Your data</div>' +
      '<div class="wc-meta">Everything you have logged, saved to this device. Nothing leaves your phone.</div>' +
      '<div id="exPanel"></div>' +
      '<button type="button" class="btn btn-ghost ex-open" data-ex-action="open">Download my data</button></div>';
  }
  function panelHtml(files) {
    const share = canShareFiles();
    return '<div class="ex-list">' + files.map((f, i) =>
      '<div class="ex-row"><div class="ex-info"><b>' + esc(f.label) + '</b><span class="wc-meta">' + esc(f.count) + '</span></div>' +
      '<button type="button" class="btn ex-dl" data-ex-action="download" data-ex-i="' + i + '">Download</button>' +
      (share ? '<button type="button" class="btn btn-ghost ex-sh" data-ex-action="share" data-ex-i="' + i + '">Share / Save to Files</button>' : '') +
      '</div>').join('') + '</div>' +
      '<div class="wc-meta ex-note">Open the CSV files in Excel or Numbers. The JSON is the complete backup.</div>';
  }

  function open() {
    if (!X()) return;
    try { _files = X().buildFiles(readStores(), Date.now()); } catch (e) { toast('Could not read your data'); return; }
    const p = document.getElementById('exPanel');
    if (p) p.innerHTML = panelHtml(_files);
    const b = document.querySelector('[data-ex-action="open"]');
    if (b) b.textContent = 'Refresh the files';
  }
  function download(i) {
    const f = _files && _files[i];
    if (!f) return;
    try {
      const url = URL.createObjectURL(blobOf(f));
      const a = document.createElement('a');
      a.href = url; a.download = f.name; a.rel = 'noopener'; a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);   // iOS reads the blob late
      toast('Saving ' + f.name);
    } catch (_) { toast('Download did not start — try Share / Save to Files'); }
  }
  async function share(i) {
    const f = _files && _files[i];
    if (!f) return;
    try { await navigator.share({ files: [fileOf(f)], title: f.label }); }
    catch (e) { if (!e || e.name !== 'AbortError') toast('Could not open the share sheet'); }
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-ex-action]');
    if (!t) return;
    const a = t.dataset.exAction;
    if (a === 'open') open();
    else if (a === 'download') download(Number(t.dataset.exI));
    else if (a === 'share') share(Number(t.dataset.exI));
  });

  // ── hooks (same shape as money-ui) ─────────────────────────────────────
  function mountDash() {
    const main = document.getElementById('main');
    if (!main || document.getElementById('fit-pb') || document.getElementById('exCard')) return;
    const box = document.createElement('div');
    box.className = 'ex-dash';
    box.innerHTML = cardHtml();
    const after = document.querySelector('.mn-dash') || document.querySelector('.rv-dash');
    if (after && after.parentNode === main) main.insertBefore(box, after.nextSibling); else main.insertBefore(box, main.firstChild);
    _files = null;
  }
  function hook() {
    const orig = window.renderDash;
    if (typeof orig === 'function' && !orig.__export) {
      const wrapped = function () { const r = orig.apply(this, arguments); try { mountDash(); } catch (_) {} return r; };
      Object.keys(orig).forEach((k) => { wrapped[k] = orig[k]; });
      wrapped.__export = true;
      window.renderDash = wrapped;
    }
  }
  function boot() {
    if (!X()) return;
    hook();
    try { if (typeof window.renderDash === 'function' && document.getElementById('main') && !document.getElementById('fit-pb')) mountDash(); } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDExportUI = { cardHtml, open };
})();
