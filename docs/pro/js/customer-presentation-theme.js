
  // Audit batch 8: Presentation Mode logic. Switches data-theme to
  // 'presentation' (defined in theme-system.css) on toggle, saves the
  // prior theme to sessionStorage, restores on toggle off. Pure DOM
  // attribute change — re-renders via existing CSS cascade.
  (function () {
    var PREV_KEY = 'nbd_pre_presentation_theme';
    function isOn() {
      return document.documentElement.getAttribute('data-theme') === 'presentation';
    }
    function syncBtn() {
      var btn = document.getElementById('presentationModeBtn');
      if (!btn) return;
      btn.setAttribute('aria-pressed', isOn() ? 'true' : 'false');
      btn.style.background = isOn() ? 'var(--orange)' : '';
      btn.style.color = isOn() ? 'var(--accent-fg)' : '';
      // Icon + label spans, not textContent (2026-09-25): customer.html hides
      // .back-btn-label at ≤480px so the header fits a 360px phone; a flat
      // textContent write here put the full label back on first sync. The
      // accessible name is the static aria-label; aria-pressed carries state.
      btn.innerHTML = isOn()
        ? '<span aria-hidden="true">✓</span><span class="back-btn-label">Presentation On</span>'
        // A screen, not a mic (phone audit 2026-10-07 #4): the 🎤 here read
        // as voice notes, which live in Quick Capture.
        : '<span aria-hidden="true">🖥️</span><span class="back-btn-label">Presentation</span>';
    }
    window.togglePresentationMode = function () {
      var html = document.documentElement;
      if (isOn()) {
        var prev = sessionStorage.getItem(PREV_KEY) || 'nbd-original';
        html.setAttribute('data-theme', prev);
        sessionStorage.removeItem(PREV_KEY);
      } else {
        var current = html.getAttribute('data-theme') || 'nbd-original';
        sessionStorage.setItem(PREV_KEY, current);
        html.setAttribute('data-theme', 'presentation');
      }
      syncBtn();
      // Notify ThemeEngine + anyone listening for theme changes.
      try { document.dispatchEvent(new CustomEvent('nbd:theme-change', { detail: { theme: html.getAttribute('data-theme') } })); } catch (_) {}
    };
    // Initial sync (handles back/forward navigation that restores
    // a previously-toggled state).
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', syncBtn);
    } else {
      syncBtn();
    }
  })();
