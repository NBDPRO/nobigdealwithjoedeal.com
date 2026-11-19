/* nbd-dialog.js — in-tab replacements for native confirm / alert / prompt.
 *
 * WHY: a native dialog sits outside the page DOM and blocks CDP, so agent and
 * browser tools (Claude in Chrome, Playwright, bots) time out on screenshots,
 * find and read_page while the tab "looks frozen". These are real DOM dialogs
 * with real buttons.
 *
 *   await nbdConfirm('Void this link?')                       -> boolean
 *   await nbdConfirm({title, message, confirmText, cancelText, danger})
 *   alert('Saved.')   -> non-blocking DOM dialog with an OK button (fire-and-forget)
 *   await nbdPrompt('Name?', 'default')  /  nbdPrompt({title, message, value}) -> string | null
 *
 * Stable hooks: #nbd-dialog (overlay, data-testid="nbd-dialog"), #nbd-dialog-confirm,
 * #nbd-dialog-cancel, #nbd-dialog-input. Esc = cancel, Enter = confirm (unless
 * focus is on Cancel), Tab is trapped, focus returns to the opener.
 *
 * Defined only when no other provider (standalone-compat.js on the dashboard and
 * customer pages carries the same contract) has already set window.nbdConfirm.
 * window.alert is also routed here so legacy alert() sites stop blocking; confirm()
 * and prompt() are NOT overridden (they need an answer, so call sites await the
 * helper). Strings render via textContent. CSP-safe: no inline handlers.
 */
(function () {
  'use strict';
  if (window.nbdConfirm) return;

  var CSS = '.nbd-dlg-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px}' +
    '.nbd-dlg{background:var(--s2,#fff);color:var(--t,#14181F);border:1px solid var(--br,#DFE2E7);border-radius:14px;padding:22px;max-width:420px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.4);font-family:Lato,-apple-system,BlinkMacSystemFont,Arial,sans-serif}' +
    '.nbd-dlg h2{font:700 17px/1.3 Montserrat,Lato,Arial,sans-serif;margin:0 0 8px}' +
    '.nbd-dlg p{font-size:14px;line-height:1.5;margin:0 0 16px;white-space:pre-wrap;word-break:break-word;color:var(--m,#4C4C4D)}' +
    '.nbd-dlg input{width:100%;box-sizing:border-box;padding:10px 12px;margin:0 0 14px;border:1px solid var(--br,#DFE2E7);border-radius:8px;font-size:16px;background:var(--s,#fff);color:inherit}' +
    '.nbd-dlg-row{display:flex;gap:10px;justify-content:flex-end}' +
    '.nbd-dlg button{min-height:44px;padding:10px 20px;border-radius:8px;font:600 15px Lato,Arial,sans-serif;cursor:pointer;border:1px solid var(--br,#DFE2E7);background:transparent;color:inherit}' +
    '.nbd-dlg button.nbd-dlg-ok{background:var(--orange,#BD5728);border-color:var(--orange,#BD5728);color:var(--accent-fg,#fff)}' +
    '.nbd-dlg button.nbd-dlg-ok.is-danger{background:var(--red,#dc2626);border-color:var(--red,#dc2626);color:#fff}' +
    '.nbd-dlg button:focus-visible,.nbd-dlg input:focus-visible{outline:2px solid var(--orange,#BD5728);outline-offset:2px}';
  var styled = false, seq = 0;

  function norm(a, b) {
    if (a && typeof a === 'object') return a;
    return { message: a == null ? '' : String(a), value: b };
  }

  function show(kind, o) {
    return new Promise(function (resolve) {
      if (!styled) {
        var st = document.createElement('style');
        st.textContent = CSS;
        document.head.appendChild(st);
        styled = true;
      }
      var prev = document.activeElement;
      var n = ++seq;
      var ov = document.createElement('div');
      ov.className = 'nbd-dlg-ov';
      ov.id = 'nbd-dialog';
      ov.setAttribute('data-testid', 'nbd-dialog');
      ov.setAttribute('data-kind', kind);
      var box = document.createElement('div');
      box.className = 'nbd-dlg';
      box.setAttribute('role', kind === 'alert' ? 'alertdialog' : 'dialog');
      box.setAttribute('aria-modal', 'true');
      var h = document.createElement('h2');
      h.id = 'nbd-dialog-title-' + n;
      h.textContent = o.title || (kind === 'confirm' ? 'Please confirm' : kind === 'prompt' ? 'Input needed' : 'Heads up');
      var p = document.createElement('p');
      p.id = 'nbd-dialog-msg-' + n;
      p.textContent = o.message == null ? '' : String(o.message);
      box.setAttribute('aria-labelledby', h.id);
      box.setAttribute('aria-describedby', p.id);
      box.appendChild(h);
      box.appendChild(p);
      var input = null;
      if (kind === 'prompt') {
        input = document.createElement('input');
        input.type = 'text';
        input.id = 'nbd-dialog-input';
        input.setAttribute('data-testid', 'nbd-dialog-input');
        input.setAttribute('aria-labelledby', h.id);
        input.value = o.value == null ? '' : String(o.value);
        box.appendChild(input);
      }
      var row = document.createElement('div');
      row.className = 'nbd-dlg-row';
      var cancel = null;
      if (kind !== 'alert') {
        cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.id = 'nbd-dialog-cancel';
        cancel.setAttribute('data-testid', 'nbd-dialog-cancel');
        cancel.textContent = o.cancelText || 'Cancel';
        row.appendChild(cancel);
      }
      var ok = document.createElement('button');
      ok.type = 'button';
      ok.id = 'nbd-dialog-confirm';
      ok.setAttribute('data-testid', 'nbd-dialog-confirm');
      ok.className = 'nbd-dlg-ok' + (o.danger ? ' is-danger' : '');
      ok.textContent = o.confirmText || o.okText || (kind === 'confirm' ? 'Confirm' : 'OK');
      row.appendChild(ok);
      box.appendChild(row);
      ov.appendChild(box);

      var done = false;
      function finish(yes) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        ov.remove();
        if (prev && prev.focus) { try { prev.focus(); } catch (e) { /* gone */ } }
        if (kind === 'confirm') resolve(!!yes);
        else if (kind === 'prompt') resolve(yes ? input.value : null);
        else resolve();
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); return; }
        if (e.key === 'Enter' && document.activeElement !== cancel) { e.preventDefault(); e.stopPropagation(); finish(true); return; }
        if (e.key === 'Tab') {
          var f = Array.prototype.filter.call(box.querySelectorAll('input,button'), function (x) { return !x.disabled; });
          var i = f.indexOf(document.activeElement);
          var nx = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === f.length - 1 ? 0 : i + 1);
          e.preventDefault();
          f[nx].focus();
        }
      }
      ok.addEventListener('click', function () { finish(true); });
      if (cancel) cancel.addEventListener('click', function () { finish(false); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(ov);
      (input || (o.danger && cancel) || ok).focus();
      if (input) input.select();
    });
  }

  window.nbdConfirm = function (a) { return show('confirm', norm(a)); };
  window.nbdPrompt = function (a, b) { return show('prompt', norm(a, b)); };
  // Legacy alert(): fire-and-forget, never blocks the page. (The alert helper stays
  // module-local, like standalone-compat.js: a window global of that name is retired.)
  window.alert = function (m) { show('alert', norm(m)); };
})();
