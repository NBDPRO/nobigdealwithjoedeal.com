/**
 * Daily Success accessibility layer (2026-10-23 audit). The page is built from innerHTML strings in a dozen files, so
 * instead of patching every template this watches the page and applies the same few rules everywhere:
 *
 *   - clickable divs (accordion headers, page tabs, dashboard rows) become keyboard buttons (role, tabindex, Enter/Space)
 *   - the accordion gets aria-expanded + aria-controls, kept in step with the .collapsed class
 *   - controls with no accessible name take their title / placeholder / neighbouring label
 *   - full-screen sheets and modals (.wc-ov, .mbg, the welcome guide) are dialogs: the page behind goes inert, Tab stays
 *     inside, focus moves in on open and goes back to the opener on close, and a redraw does not drop the focus
 *   - landmarks and the page h1, the toast live region
 *
 * The rules themselves are in a11y-logic.js (pure, tested). External file, deferred: strict CSP, no inline handlers.
 */
(function () {
  'use strict';
  const L = window.NBDA11yLogic;
  if (!L) return;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  // ── names, roles, landmarks ──────────────────────────────────────────
  const DIALOG_NAMES = { mDel: 'Delete page', mRen: 'Rename tab', mPRH: 'Lift history', mOnboard: 'Customize your Daily OS', welcomeModal: 'Welcome to Daily Success', thOverlay: 'Import history' };

  function labelNear(el) {
    let p = el.previousElementSibling;
    for (let n = 0; p && n < 3; n++, p = p.previousElementSibling) {
      if (p.tagName === 'LABEL' || /\blabel\b|-lbl\b|\bob-label\b/.test(p.className || '')) return p.textContent.replace(/\s+/g, ' ').trim();
    }
    return '';
  }

  function nameControls(root) {
    $$('button,input,select,textarea,[role=button],[role=tab]', root).forEach((el) => {
      if (el.type === 'hidden' || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return;
      if (el.labels && el.labels.length) return;
      const tag = el.tagName.toLowerCase();
      const text = el.textContent;
      const isField = tag === 'input' || tag === 'select' || tag === 'textarea';
      if (!isField && !L.glyphOnly(text)) return;
      if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio') && el.closest('label')) return;
      const name = L.nameFor({ tag, title: el.getAttribute('title'), placeholder: el.getAttribute('placeholder'), text }) || (isField ? (L.humanKey(el.getAttribute('data-k')) || labelNear(el)) : '');
      if (name) el.setAttribute('aria-label', name);
    });
  }

  function roleClickables(root) {
    $$('[data-action]:not(button):not(a):not(input):not(select):not(textarea):not([role])', root).forEach((el) => {
      el.setAttribute('role', 'button');
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    });
  }

  function sections(root) {
    $$('.pc[data-sec] > .ph[data-action="toggle-section"]', root).forEach((ph) => {
      const card = ph.parentElement;
      const body = $('.pb', card);
      if (body && !body.id) body.id = 'secbody-' + card.dataset.sec;
      const attrs = L.sectionAria(card.classList.contains('collapsed'), body && body.id);
      Object.keys(attrs).forEach((k) => { if (ph.getAttribute(k) !== attrs[k]) ph.setAttribute(k, attrs[k]); });
      if (body && body.getAttribute('role') !== 'region') { body.setAttribute('role', 'region'); }
      if (body && !body.getAttribute('aria-labelledby')) {
        const t = $('.pt', ph);
        if (t) { if (!t.id) t.id = 'sect-' + card.dataset.sec; body.setAttribute('aria-labelledby', t.id); }
      }
    });
  }

  // habit dots are bare spans in a table: name them "<habit>, <weekday>" and expose on/off
  function habits(root) {
    $$('.hd[data-action="toggle-habit"]', root).forEach((dot) => {
      const td = dot.closest('td'), tr = dot.closest('tr');
      if (td && tr && !dot.getAttribute('aria-label')) {
        const th = td.closest('table') && td.closest('table').querySelectorAll('thead th')[td.cellIndex];
        dot.setAttribute('aria-label', (tr.cells[0].textContent.trim() + (th ? ', ' + th.textContent.trim() : '')));
      }
      const on = dot.classList.contains('on') ? 'true' : 'false';
      if (dot.getAttribute('aria-pressed') !== on) dot.setAttribute('aria-pressed', on);
    });
  }

  function tabs(root) {
    $$('#tabrow .tab', root).forEach((t) => {
      if (t.classList.contains('active')) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    $$('#tabrow .tplus', root).forEach((t) => { t.setAttribute('aria-label', 'New page'); });
    $$('#tabrow .tab', root).forEach((t) => {
      const x = $('.tx', t);
      if (x && !x.getAttribute('aria-label')) {
        const label = t.textContent.replace(x.textContent, '').replace(/\s+/g, ' ').trim();
        x.setAttribute('aria-label', 'Delete page ' + label);
      }
    });
  }

  function landmarks() {
    const set = (el, attrs) => { if (el) Object.keys(attrs).forEach((k) => { if (el.getAttribute(k) !== attrs[k]) el.setAttribute(k, attrs[k]); }); };
    set($('.topbar'), { role: 'banner' });
    set($('#tabrow'), { role: 'navigation', 'aria-label': 'Pages' });
    set($('#main'), { role: 'main', 'aria-label': 'Daily Success' });
    set($('#sbar'), { role: 'search', 'aria-label': 'Search all pages' });
    set($('.tbtitle'), { role: 'heading', 'aria-level': '1' });
    const toast = $('#nbd-toast');
    set(toast, { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  }

  // ── dialogs ──────────────────────────────────────────────────────────
  const stack = []; // open dialog hosts, oldest first; each { host, box, opener, openerSel, lastSel }

  function dialogHosts() {
    const hosts = $$('.wc-ov.open, .mbg.open');
    const w = document.getElementById('welcomeModal');
    if (w && w.style.display && w.style.display !== 'none') hosts.push(w);
    return hosts;
  }
  function boxOf(host) { return host.classList.contains('mbg') ? ($('.mbox', host) || host) : (host.id === 'welcomeModal' ? host.firstElementChild || host : host); }

  function nameDialog(host, box) {
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    if (!box.getAttribute('aria-label') && !box.getAttribute('aria-labelledby')) {
      const h = $('h2,h3', box);
      box.setAttribute('aria-label', DIALOG_NAMES[host.id] || (h && h.textContent.trim()) || 'Dialog');
    }
  }

  function selFor(el) {
    if (!el || !el.tagName) return '';
    if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    return L.focusSelector(el.tagName, el.dataset);
  }

  function setInert(top) {
    Array.from(document.body.children).forEach((c) => {
      const tag = c.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'NOSCRIPT') return;
      const skip = !top || c === top || c.contains(top) || c.id === 'toastContainer' || c.id === 'nbd-toast' || c.getAttribute('aria-live');
      if (skip) { if (c.hasAttribute('data-a11y-inert')) { c.removeAttribute('inert'); c.removeAttribute('data-a11y-inert'); } }
      else if (!c.hasAttribute('inert')) { c.setAttribute('inert', ''); c.setAttribute('data-a11y-inert', '1'); }
    });
  }

  function syncDialogs() {
    const open = dialogHosts();
    // closed since last time: drop it, lift the inert marks, THEN give focus back (an inert opener cannot take focus)
    const closed = [];
    for (let i = stack.length - 1; i >= 0; i--) {
      if (open.indexOf(stack[i].host) >= 0) continue;
      closed.push(stack[i]);
      stack.splice(i, 1);
    }
    if (closed.length) setInert(stack.length ? stack[stack.length - 1].host : null);
    closed.forEach((d) => {
      const was = document.activeElement;
      const inside = !was || was === document.body || d.host.contains(was) || !document.contains(was);
      let target = d.opener && document.contains(d.opener) ? d.opener : null;
      if (!target && d.openerSel) target = $(d.openerSel);
      // the Coach card is redrawn when the sheet closes ("Start" becomes "Resume"): land on its first button
      if (!target && /coach-action/.test(d.openerSel || '')) target = $('#wcCard button');
      if (inside) {
        const next = stack.length ? stack[stack.length - 1] : null;
        if (target && !next) { try { target.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
        else if (next) { const nb = boxOf(next.host); const f = $(FOCUSABLE, nb); (f || nb).focus({ preventScroll: true }); }
      }
    });
    // newly opened
    open.forEach((host) => {
      if (stack.some((d) => d.host === host)) return;
      const box = boxOf(host);
      nameDialog(host, box);
      const was = document.activeElement;
      stack.push({ host, box, opener: was && was !== document.body ? was : null, openerSel: selFor(was), lastSel: '' });
      // move focus in: the box itself, so the dialog's name is read first; Tab then walks its controls.
      // (A caller that focuses a field itself a moment later, like Rename, still wins.)
      if (!host.contains(document.activeElement)) {
        if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');
        try { box.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
      }
    });
    setInert(stack.length ? stack[stack.length - 1].host : null);
  }

  // after a redraw inside a dialog, put focus back on "the same button"
  function recoverFocus() {
    const top = stack[stack.length - 1];
    if (!top || !top.lastSel) return;
    const a = document.activeElement;
    if (a && a !== document.body && document.contains(a) && top.host.contains(a)) return;
    let el = null;
    try { el = $(top.lastSel, top.host); } catch (_) { el = null; }
    if (el && !el.disabled) { try { el.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
  }

  document.addEventListener('click', (ev) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    const t = ev.target.closest && ev.target.closest('button,[role=button],input,select');
    if (t && top.host.contains(t)) top.lastSel = selFor(t);
  }, true);
  document.addEventListener('change', (ev) => {
    const top = stack[stack.length - 1];
    if (top && ev.target && top.host.contains(ev.target)) top.lastSel = selFor(ev.target);
  }, true);

  document.addEventListener('keydown', (ev) => {
    // Enter / Space on a div-button
    const t = ev.target;
    if ((ev.key === 'Enter' || ev.key === ' ') && t && t.matches && t.matches('[role=button][data-action]:not(button):not(a)')) {
      ev.preventDefault();
      t.click();
      return;
    }
    const top = stack[stack.length - 1];
    if (!top) return;
    if (ev.key === 'Escape') {
      // overlays that do not close themselves on Escape: press their own close button (only if still open afterwards)
      setTimeout(() => {
        if (stack[stack.length - 1] !== top || !document.contains(top.host) || dialogHosts().indexOf(top.host) < 0) return;
        const close = $('[data-coach-action="close"],.wc-x,[data-action="close-m"],[aria-label="Close"]', top.box) || null;
        if (close) close.click();
      }, 0);
      return;
    }
    if (ev.key !== 'Tab') return;
    const items = $$(FOCUSABLE, top.box).filter(visible);
    if (!items.length) { ev.preventDefault(); top.box.focus(); return; }
    const i = items.indexOf(document.activeElement);
    const wrapping = ev.shiftKey ? i <= 0 : i === items.length - 1;
    if (i < 0 || wrapping) { ev.preventDefault(); items[L.trapTab(items.length, i, ev.shiftKey)].focus(); }
  });

  // ── run + watch ──────────────────────────────────────────────────────
  let queued = false;
  function pass() {
    queued = false;
    landmarks();
    roleClickables(document);
    nameControls(document);
    sections(document);
    habits(document);
    tabs(document);
    syncDialogs();
    recoverFocus();
  }
  function schedule() { if (!queued) { queued = true; (window.requestAnimationFrame || setTimeout)(pass); } }

  function boot() {
    pass();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    const w = document.getElementById('welcomeModal');
    if (w) new MutationObserver(schedule).observe(w, { attributes: true, attributeFilter: ['style'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDA11y = { pass };
})();
