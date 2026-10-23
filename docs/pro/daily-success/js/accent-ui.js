/**
 * accent-ui.js — applies the chosen accent over the active theme and renders the swatch row in the appearance modal
 * (#npm-accents, Themes tab). Pure rules and the colour list live in accent-logic.js.
 *
 * Like the theme, an accent is a per-device look and does not sync. Storage can be blocked (private window), so every read and
 * write is guarded. With no accent chosen nothing is set inline and the theme's own accent shows.
 */
(function () {
  'use strict';
  const A = window.NBDAccent;
  if (!A) return;
  const html = document.documentElement;
  let memory; // set once the user picks, so a blocked store still behaves for this visit

  function stored() { try { return localStorage.getItem(A.KEY); } catch (_) { return null; } }
  const pick = () => (memory !== undefined ? memory : A.normAccent(stored()));

  // The active theme's own accent (app.js writes it inline as --ac; a saved custom theme has no CSS skin to fall back on).
  function themeAccent() { // the active theme object (its accent and, for a custom theme, its bg)
    try { return _nbdGetTheme(_nbd_activeTheme) || null; } catch (_) { return null; }
  }

  // Drop our inline text values first so the skin's own --paper is what gets read, then lay the accent over it.
  function apply() {
    html.style.removeProperty('--ac-text');
    html.style.removeProperty('--ac-on-dark');
    const id = pick();
    const theme = themeAccent();
    if (!id) {
      ['--ac', '--orange'].forEach((p) => { if (theme && theme.accent) html.style.setProperty(p, theme.accent); else html.style.removeProperty(p); });
      return;
    }
    const paper = A.surfaceOf(getComputedStyle(html).getPropertyValue('--paper'), theme && theme.bg);
    const v = A.vars(id, paper);
    if (v) Object.keys(v).forEach((p) => html.style.setProperty(p, v[p]));
  }

  function set(id) {
    const next = A.normAccent(id);
    try { if (next) localStorage.setItem(A.KEY, next); else localStorage.removeItem(A.KEY); } catch (_) { /* blocked: still applies for this visit */ }
    memory = next;
    apply();
    render();
    return next;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render() {
    const el = document.getElementById('npm-accents');
    if (!el) return;
    const cur = pick();
    el.innerHTML = '<div class="acc-row" role="radiogroup" aria-label="Accent colour">' + A.ACCENTS.map((a) => {
      const on = a.id === cur;
      return '<button type="button" class="acc-sw' + (on ? ' on' : '') + '" role="radio" aria-checked="' + on + '" aria-label="' + esc(a.label) + '"'
        + ' data-accent-pick="' + esc(a.id) + '" style="background:' + a.fill + '"></button>';
    }).join('') + '<button type="button" class="acc-reset" data-accent-pick="">Theme default</button></div>';
  }

  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-accent-pick]') : null;
    if (b) set(b.getAttribute('data-accent-pick'));
  });

  // nbdApplyTheme sets data-theme and then writes the theme's --ac inline; the observer fires after that, so the accent goes on top.
  new MutationObserver(apply).observe(html, { attributes: true, attributeFilter: ['data-theme'] });

  apply();
  render();
  window.NBDAccent.set = set;
  window.NBDAccent.current = pick;
})();
