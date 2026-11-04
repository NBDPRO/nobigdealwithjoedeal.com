/**
 * layout-ui.js — applies the chosen layout (data-ui on <html>) and renders the picker in two places: the appearance modal's
 * "Layouts" tab (#npm-layouts) and the first-run welcome (#wg-layouts). Pure rules live in layout-logic.js.
 *
 * A layout is a per-device look, like the theme: it is not account data and does not sync. Storage can be blocked (private
 * window), so every read and write is guarded and the page works without it.
 */
(function () {
  'use strict';
  const L = window.NBDLayout;
  if (!L) return;
  const html = document.documentElement;

  function stored() { try { return localStorage.getItem(L.KEY); } catch (_) { return null; } }
  function current() { return L.normLayout(stored()); }
  function apply(id) { html.setAttribute('data-ui', id); }

  function set(id) {
    const want = L.byId(id);
    if (!want || !want.ready) return current(); // not offered yet: leave the active layout alone, never reset it
    const next = want.id;
    try { localStorage.setItem(L.KEY, next); } catch (_) { /* blocked: still applies for this visit */ }
    apply(next);
    render();
    try { window.dispatchEvent(new CustomEvent('nbd-layout', { detail: next })); } catch (_) { /* old browser: a reload still applies it */ }
    return next;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function pickerHtml() {
    const cur = current();
    return '<div class="ui-picks" role="radiogroup" aria-label="Layout">' + L.LAYOUTS.map((l) => {
      const on = l.id === cur;
      return '<button type="button" class="ui-pick' + (on ? ' on' : '') + (l.ready ? '' : ' soon') + '" role="radio" aria-checked="' + on + '"'
        + (l.ready ? ' data-ui-pick="' + esc(l.id) + '"' : ' disabled aria-disabled="true"') + '>'
        + '<span class="ui-pick-n">' + esc(l.label) + (l.ready ? '' : ' <em>coming</em>') + '</span>'
        + '<span class="ui-pick-d">' + esc(l.blurb) + '</span></button>';
    }).join('') + '</div>';
  }

  function render() {
    ['npm-layouts', 'wg-layouts'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = pickerHtml();
    });
  }

  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-ui-pick]') : null;
    if (b) set(b.getAttribute('data-ui-pick'));
  });

  apply(current());
  render();
  window.NBDLayout.set = set;
  window.NBDLayout.current = current;
})();
