/* /pro/js/toast.js — shared toast module (2026-07-19 satellite-page consolidation).
 *
 * Single implementation of the dashboard toast contract (same visual +
 * behavioral spec as ui.js / customer-tasks-ui.js) for satellite pages
 * that previously each shipped a divergent local toast:
 *   - themed surface, per-type left-border colors (--green/--red/--gold/--blue)
 *   - bottom-right stacking #toastContainer, z-index var(--z-toast,10002)
 *   - max 5 concurrent, evict oldest
 *   - per-type durations: success 4000 / info 5000 / warning 7000 / error 9000
 *   - ✕ dismiss button
 *   - message set via textContent — NEVER innerHTML
 *   - the container is a polite live region (role=status) so a screen reader hears each toast; an error toast is role=alert.
 *     A region only announces content added AFTER it exists, so the first toast of a page is added a beat after the container.
 *
 * Exposes window.showToast(message, type) with type in
 * {success, error, warning, info}; anything else falls back to info.
 *
 * Guarded: pages that already provide window.showToast (dashboard pages
 * via ui.js / customer-tasks-ui.js, test sandboxes that stub it) keep
 * their own implementation — this module then does nothing.
 * CSP: external classic script, no inline handlers.
 */
(function () {
  'use strict';
  if (window.showToast) return;

  // Entry animation keyframes — injected once, only when this module owns the toast.
  const style = document.createElement('style');
  style.textContent = '@keyframes nbdToastIn{from{transform:translateX(40px);opacity:0}to{transform:none;opacity:1}}';
  document.head.appendChild(style);

  const DURATIONS = { success: 4000, info: 5000, warning: 7000, error: 9000 };
  const BORDER = { success: 'var(--green,#2ECC8A)', error: 'var(--red,#E05252)', warning: 'var(--gold,#eab308)', info: 'var(--blue,#3b82f6)' };

  window.showToast = function (message, type = 'info') {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:var(--z-toast,10002);display:flex;flex-direction:column;gap:8px;align-items:flex-end;';
      container.setAttribute('role', 'status');
      container.setAttribute('aria-live', 'polite');
      container.setAttribute('aria-relevant', 'additions');
      document.body.appendChild(container);
      container.__fresh = true;
    }
    while (container.children.length >= 5) container.firstChild.remove();
    const toast = document.createElement('div');
    toast.style.cssText = 'display:flex;align-items:center;gap:10px;background:var(--s,#1a1d23);color:var(--t,#e8eaf0);border:1px solid var(--br,rgba(255,255,255,.1));border-left:3px solid ' + (BORDER[type] || BORDER.info) + ';border-radius:8px;padding:10px 14px;font-size:13px;font-weight:500;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:340px;pointer-events:auto;animation:nbdToastIn .25s ease-out;';
    const msg = document.createElement('span');
    msg.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '✕';
    close.style.cssText = 'background:none;border:none;color:var(--m,#8a93a8);cursor:pointer;font-size:12px;padding:2px 4px;flex-shrink:0;';
    close.addEventListener('click', () => toast.remove());
    toast.appendChild(msg);
    toast.appendChild(close);
    if (type === 'error') toast.setAttribute('role', 'alert');
    if (container.__fresh) { container.__fresh = false; setTimeout(() => container.appendChild(toast), 50); }
    else container.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = 'opacity .25s, transform .25s';
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(30px)';
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 260);
    }, DURATIONS[type] || 5000);
  };
})();
