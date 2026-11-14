/**
 * nav-router.js - a small hash router so the back button (and the iOS edge swipe) stays inside the app (audit M8).
 *
 *   - switchTo() calls NBDNav.viewChanged(): a new view (the Dashboard, or a day) pushes one history entry, `#dash` / `#day-<id>`.
 *   - Each overlay (coach, money sheet, Sunday review, history import) calls NBDNav.opened(name, closeFn) when it opens and
 *     NBDNav.closed(name) when it closes. Opening pushes `#ov-<name>`; closing from the screen takes that entry back off.
 *   - popstate closes the top overlay first. With none open it returns to the view the entry names.
 *
 * The page never reads the hash on load: it opens where it always did, and the first view is recorded in place (replaceState)
 * so the first back goes to whatever was before the app, as the browser expects. Needs app.js's `pages` / `cur` (read at call time).
 */
(function () {
  'use strict';
  const MARK = 'nbdDs';
  const stack = [];           // overlay names, bottom to top
  const closers = {};
  let pop = false;            // a popstate is being applied: switchTo must not push
  let busy = false;           // our own history.back() is in flight: pushes wait for its popstate
  let busyT = null;
  let queue = [];

  const hist = () => window.history;
  const stateOf = () => { try { return hist().state; } catch (_) { return null; } };
  const pagesNow = () => (typeof pages !== 'undefined' && Array.isArray(pages) ? pages : []);   // eslint-disable-line no-undef
  const curNow = () => (typeof cur !== 'undefined' ? cur : -1);                                  // eslint-disable-line no-undef

  function keyOf() {
    const p = pagesNow()[curNow()];
    return curNow() < 0 || !p ? 'dash' : 'day-' + p.id;
  }
  function idxOf(key) {
    if (key === 'dash') return -1;
    const id = String(key).replace(/^day-/, '');
    const i = pagesNow().findIndex((p) => String(p.id) === id);
    return i;
  }
  const flush = () => { busy = false; clearTimeout(busyT); const q = queue; queue = []; q.forEach((f) => { try { f(); } catch (_) { /* a stale push is not worth breaking the app */ } }); };
  const later = (f) => { if (busy) queue.push(f); else f(); };
  const push = (state, hash) => { try { hist().pushState(state, '', hash); } catch (_) { /* a sandboxed frame: no history, no router */ } };

  // Record the view the page opened on, without adding an entry.
  function base() {
    const s = stateOf();
    if (s && s[MARK] === 'view') return;     // an overlay entry left by a reload is replaced: no overlay is open now, so it would be a dead step
    try { hist().replaceState({ [MARK]: 'view', key: keyOf() }, '', '#' + keyOf()); } catch (_) { /* as above */ }
  }

  function viewChanged() {
    if (pop) return;
    const key = keyOf();
    later(() => {
      const s = stateOf();
      if (s && s[MARK] === 'view' && s.key === key && !stack.length) return;
      push({ [MARK]: 'view', key }, '#' + key);
    });
  }

  function opened(name, closeFn) {
    if (stack.indexOf(name) > -1) return;
    stack.push(name); closers[name] = closeFn;
    later(() => push({ [MARK]: 'ov', name }, '#ov-' + name));
  }

  function closed(name) {
    const i = stack.lastIndexOf(name);
    if (i < 0) return;                       // closed by popstate, or never registered
    stack.splice(i, 1); delete closers[name];
    const s = stateOf();
    if (s && s[MARK] === 'ov' && s.name === name && !pop) {
      busy = true; clearTimeout(busyT); busyT = setTimeout(flush, 600);
      try { hist().back(); } catch (_) { flush(); }
    }
  }

  // Closes the top overlay as if its own Close button was pressed (the overlay calls closed(), which takes its history entry back off).
  function closeTop() {
    const name = stack[stack.length - 1];
    if (!name) return false;
    try { if (closers[name]) closers[name](); } catch (_) { /* the overlay is already gone */ }
    if (stack.lastIndexOf(name) > -1) closed(name);
    return true;
  }
  // popstate already moved history: close the top overlay without touching it again.
  function popTop() {
    const name = stack.pop();
    if (!name) return;
    const f = closers[name]; delete closers[name];
    try { if (f) f(); } catch (_) { /* the overlay is already gone */ }
  }

  window.addEventListener('popstate', () => {
    if (busy) { flush(); return; }
    if (stack.length) {
      const here = stateOf();
      if (here && here[MARK] === 'ov' && here.name === stack[stack.length - 1]) return;   // landed on the open overlay's own entry: keep it open
      pop = true;
      try { popTop(); } finally { pop = false; }
      return;
    }
    const s = stateOf();
    if (!s || !s[MARK]) return;
    // An overlay entry with no overlay behind it (the view changed under the overlay, so its entry could not be taken back): step over it.
    if (s[MARK] === 'ov') { try { hist().back(); } catch (_) { /* as above */ } return; }
    if (s.key === keyOf()) return;
    let i = idxOf(s.key);
    if (i < 0 && s.key !== 'dash') i = -1;     // that day is gone: the Dashboard
    pop = true;
    try { if (typeof window.switchTo === 'function') window.switchTo(i); } finally { pop = false; }
  });

  if (document.readyState === 'complete') base(); else window.addEventListener('load', base);

  window.NBDNav = { base, viewChanged, opened, closed, closeTop, depth: () => stack.length };
})();
