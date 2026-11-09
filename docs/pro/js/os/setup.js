/**
 * os/setup.js — NBD OS "Copy my setup" (2026-11-09, P3; design:
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §8 P3).
 *
 * One native <dialog> with two halves:
 *   Copy   the member's setup as text (os/setup-logic.js exportText): widgets, their
 *          places and sizes, wallpaper choices and modes. No customer, lead or money data.
 *   Paste  a setup copied from another device or teammate: Check shows what it holds
 *          (summary), Use this setup writes it, Cancel leaves everything as it is.
 * Nothing is written before Use this setup. The write is the layout's (opts.apply, which
 * saves layoutState['os-home'] through LayoutEngine.saveUser, patch-only); a surface the
 * company locked keeps its home (setup-logic merge).
 *
 *   NBDOSSetup.open({ seen, own, locked, apply(nextKey), returnFocus })
 *
 * Loaded as the runtime ScriptLoader bundle 'ossetup' that layouts/os.js registers
 * (css/os/setup.css, os/setup-logic.js, this file). Every value escaped; no inline
 * handlers, no style attributes.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  var doc = W && W.document;
  if (!W || !doc || W.NBDOSSetup) return;
  var SLg = W.NBDOSSetupLogic;
  if (!SLg) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function outside(d, ev) {
    var r = d.getBoundingClientRect();
    var x = ev.clientX, y = ev.clientY;
    return typeof x === 'number' && typeof y === 'number' && (x < r.left || y < r.top || x > r.left + r.width || y > r.top + r.height);
  }

  var dlg = null;
  function open(opts) {
    var o = opts || {};
    if (dlg && dlg.parentNode) dlg.parentNode.removeChild(dlg);
    var text = SLg.exportText(o.seen, o.own);
    var pending = null;   // the checked paste: { home, next }
    var d = doc.createElement('dialog');
    d.className = 'os-hw-add os-su';
    d.setAttribute('aria-labelledby', 'osSuTitle');
    d.innerHTML =
      '<div class="os-hw-add-hd"><h2 class="os-hw-add-title" id="osSuTitle">Copy my setup</h2>' +
        '<button type="button" class="btn btn-ghost os-hw-add-close" data-ossu="close">Close</button></div>' +
      '<section class="os-su-part" aria-labelledby="osSuCopyT"><h3 class="os-hw-add-gt" id="osSuCopyT">Copy</h3>' +
        '<p class="os-su-p">Your widgets, where they sit and their sizes, your wallpaper choices and your modes, as text. No customer, lead or money data.</p>' +
        '<label class="os-su-label" for="osSuOut">Your setup</label>' +
        '<textarea class="os-su-text" id="osSuOut" rows="3" readonly spellcheck="false">' + esc(text) + '</textarea>' +
        '<div class="os-su-row"><button type="button" class="btn btn-ghost os-hw-btn" data-ossu="copy">Copy text</button>' +
        '<p class="os-su-status" role="status" aria-live="polite" data-ossu-copied=""></p></div></section>' +
      '<section class="os-su-part" aria-labelledby="osSuPasteT"><h3 class="os-hw-add-gt" id="osSuPasteT">Paste a setup</h3>' +
        '<label class="os-su-label" for="osSuIn">Paste a setup copied on another device or by a teammate</label>' +
        '<textarea class="os-su-text" id="osSuIn" rows="3" spellcheck="false" autocomplete="off"></textarea>' +
        '<div class="os-su-row"><button type="button" class="btn btn-ghost os-hw-btn" data-ossu="check">Check it</button></div>' +
        '<div class="os-su-preview" data-ossu-preview="" aria-live="polite"></div></section>';
    var out = d.querySelector('#osSuOut'), inp = d.querySelector('#osSuIn');
    var copied = d.querySelector('[data-ossu-copied]'), prev = d.querySelector('[data-ossu-preview]');

    function say(el, msg) { el.textContent = ''; if (msg) el.textContent = msg; }
    function copy() {
      var C = W.navigator && W.navigator.clipboard;
      function fallback() {
        try { out.focus(); out.select(); } catch (e) {}
        say(copied, 'Selected. Copy it with your device\'s Copy.');
      }
      if (C && typeof C.writeText === 'function') {
        Promise.resolve().then(function () { return C.writeText(text); }).then(function () { say(copied, 'Copied.'); }, fallback);
      } else fallback();
    }
    function check() {
      pending = null;
      var r = SLg.parse(inp ? inp.value : '');
      if (!r.ok) {
        prev.innerHTML = '<p class="os-su-err" role="alert">' + esc(r.error) + '</p>';
        return;
      }
      var next = SLg.merge(o.own, r.home, o.locked);
      if (SLg.same(next, o.own)) {
        prev.innerHTML = '<p class="os-su-p">That is already your setup. Nothing to change.</p>';
        return;
      }
      pending = { home: r.home, next: next };
      prev.innerHTML = '<p class="os-su-p">This setup has:</p><ul class="os-su-list">' +
        SLg.summary(r.home, o.locked).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' +
        '<p class="os-su-p">It replaces what it has on this account, on every device. Your leads and numbers stay as they are.</p>' +
        '<div class="os-su-row"><button type="button" class="btn btn-orange os-hw-btn" data-ossu="use">Use this setup</button>' +
        '<button type="button" class="btn btn-ghost os-hw-btn" data-ossu="cancel">Cancel</button></div>';
      var u = prev.querySelector('[data-ossu="use"]');
      if (u) { try { u.focus(); } catch (e) {} }
    }
    d.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (t === d && outside(d, ev)) { d.close(); return; }
      var b = t.closest('[data-ossu]');
      if (!b) return;
      var what = b.getAttribute('data-ossu');
      if (what === 'close') return d.close();
      if (what === 'copy') return copy();
      if (what === 'check') return check();
      if (what === 'cancel') { pending = null; prev.innerHTML = ''; if (inp) { try { inp.focus(); } catch (e) {} } return; }
      if (what === 'use' && pending) {
        var next = pending.next;
        pending = null;
        d.close();
        if (typeof o.apply === 'function') o.apply(next);
      }
    });
    d.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); d.close(); } });
    d.addEventListener('close', function () {
      if (d.parentNode) d.parentNode.removeChild(d);
      if (dlg === d) dlg = null;
      var back = o.returnFocus;
      if (back && back.isConnected !== false) { try { back.focus(); } catch (e) {} }
    });
    doc.body.appendChild(d);
    dlg = d;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    var first = d.querySelector('[data-ossu="copy"]');
    if (first) { try { first.focus(); } catch (e) {} }
    return d;
  }

  W.NBDOSSetup = { open: open };
})();
