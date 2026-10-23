/**
 * eod-ui.js — the end-of-day review card on the day page (rules: eod-logic.js).
 * After 5 pm on today's page it offers three quick questions inline; any other
 * time it is one quiet link. "Not tonight" is remembered. No popups, no
 * reminders, nothing is ever required. Classic script after app.js; delegated
 * listeners; every value that reaches innerHTML is escaped.
 */
(function () {
  'use strict';
  if (window.NBDEodUI) return;
  /* global pages, cur */
  const E = () => window.NBDEod;
  const KEY = 'nbd_ds_eod';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { if (typeof window.toast === 'function') window.toast(m); };
  const today = () => (typeof window.todayKey === 'function' ? window.todayKey() : E().addDays(new Date().toISOString().slice(0, 10), 0));
  let editing = null; // the date whose questions are open

  function load() {
    try { const v = JSON.parse(localStorage.getItem(KEY)); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (_) { return {}; }
  }
  function store(map) {
    try { localStorage.setItem(KEY, JSON.stringify(map)); } catch (_) { toast('Could not save on this device'); return false; }
    if (typeof window.dsSettingsChanged === 'function') window.dsSettingsChanged(KEY);
    return true;
  }
  function pageDk() {
    try { const p = typeof pages !== 'undefined' && typeof cur === 'number' ? pages[cur] : null; return p && p.dk ? p.dk : null; } catch (_) { return null; }
  }

  function formHtml(dk, rec) {
    const r = rec && !rec.skipped ? rec : {};
    const chips = [1, 2, 3].map((n) => '<button type="button" class="wc-chip eod-chip' + (r.body === n ? ' on' : '') + '" data-eod-action="body" data-v="' + n + '" aria-pressed="' + (r.body === n) + '">' + esc(E().BODY[n]) + '</button>').join('');
    return '<div class="eod-q"><div class="eod-l">How does your body feel?</div><div class="wc-chips" data-body="' + esc(r.body || 0) + '">' + chips + '</div></div>' +
      '<label class="eod-q"><span class="eod-l">One business win or next action</span><input class="wc-in eod-in" id="eodWin" maxlength="' + E().MAX + '" autocomplete="off" value="' + esc(r.win || '') + '"></label>' +
      '<label class="eod-q"><span class="eod-l">Tomorrow\'s non-negotiable</span><input class="wc-in eod-in" id="eodTomorrow" maxlength="' + E().MAX + '" autocomplete="off" value="' + esc(r.tomorrow || '') + '"></label>' +
      '<div class="eod-foot"><button type="button" class="btn eod-save" data-eod-action="save">Save</button><button type="button" class="btn btn-ghost eod-skip" data-eod-action="skip">Not tonight</button></div>';
  }
  function cardHtml(dk) {
    const map = load();
    const st = editing === dk ? 'edit' : E().state(map, dk, today(), new Date().getHours());
    const rec = map[dk];
    let body;
    if (st === 'saved') {
      body = '<div class="wc-card-h">🌙 Day wrap-up</div>' +
        (rec.body ? '<div class="eod-line"><b>Body:</b> ' + esc(E().BODY[rec.body]) + '</div>' : '') +
        (rec.win ? '<div class="eod-line"><b>Win / next:</b> ' + esc(rec.win) + '</div>' : '') +
        (rec.tomorrow ? '<div class="eod-line"><b>Tomorrow:</b> ' + esc(rec.tomorrow) + '</div>' : '') +
        '<button type="button" class="wc-link eod-edit" data-eod-action="edit">Edit</button>';
    } else if (st === 'prompt' || st === 'edit') {
      body = '<div class="wc-card-h">🌙 Day wrap-up <small>60 seconds, all optional</small></div>' + formHtml(dk, rec);
    } else {
      body = '<button type="button" class="wc-link eod-open" data-eod-action="edit">🌙 ' + (st === 'skipped' ? 'Add a day wrap-up anyway' : 'Wrap up the day') + '</button>';
    }
    return '<div class="wc-card eod-card eod-' + st + '" data-dk="' + esc(dk) + '">' + body + '</div>';
  }
  function mount() {
    const dk = pageDk();
    const host = document.querySelector('.pc[data-sec="log"]');
    document.querySelectorAll('.eod-wrap').forEach((n) => n.remove());
    if (!dk || !host || !E()) return;
    const box = document.createElement('div');
    box.className = 'eod-wrap';
    box.innerHTML = cardHtml(dk);
    host.parentNode.insertBefore(box, host.nextSibling);
  }
  function repaint() {
    const dk = pageDk();
    const box = document.querySelector('.eod-wrap');
    if (dk && box) box.innerHTML = cardHtml(dk); else mount();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-eod-action]');
    if (!t || !E()) return;
    const dk = pageDk();
    if (!dk) return;
    const a = t.dataset.eodAction;
    if (a === 'edit') { editing = dk; repaint(); }
    else if (a === 'body') {
      const row = t.parentNode, v = Number(t.dataset.v);
      const was = Number(row.dataset.body) === v;
      row.dataset.body = was ? '0' : String(v);
      row.querySelectorAll('.eod-chip').forEach((c) => { const on = !was && Number(c.dataset.v) === v; c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); });
    } else if (a === 'save') {
      const row = document.querySelector('.eod-wrap .wc-chips');
      const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
      const rec = { body: row ? Number(row.dataset.body) : 0, win: val('eodWin'), tomorrow: val('eodTomorrow') };
      if (!E().normalize(rec)) { toast('Nothing to save - answer one, or tap Not tonight'); return; }
      if (store(E().save(load(), dk, rec, Date.now()))) { editing = null; repaint(); toast('Wrap-up saved'); }
    } else if (a === 'skip') {
      editing = null;
      if (store(E().skip(load(), dk, Date.now()))) repaint();
    }
  });

  function hook() {
    const orig = window.renderPage;
    if (typeof orig !== 'function' || orig.__eod) return;
    const wrapped = function () { const r = orig.apply(this, arguments); try { mount(); } catch (_) { /* the day page renders without it */ } return r; };
    Object.keys(orig).forEach((k) => { wrapped[k] = orig[k]; });
    wrapped.__eod = true;
    window.renderPage = wrapped;
  }
  function boot() {
    if (!E()) return;
    hook();
    try { if (document.getElementById('fit-pb')) mount(); } catch (_) { /* optional */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDEodUI = { cardHtml, mount, load };
})();
