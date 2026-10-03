/**
 * triage-deck.js — work a long list ONE AT A TIME (Jo, 2026-10-02).
 *
 * "When it says 100+ customers to sort I should be able to do one at a time
 * and have it save that, so if I only have time to do a few I can — almost
 * like swiping left and right through Gmail to archive and delete, or a
 * third … with options to click."
 *
 * A full-screen deck of cards, one item each:
 *   - swipe RIGHT (or the right button, or →) = the deck's main action;
 *   - swipe LEFT  (or "Later", or ←)          = skip it for now: it goes to
 *     the back, and the deck remembers it so the next session starts with
 *     ones you haven't seen;
 *   - ⋯ = the other options for this item, as buttons.
 * Every action saves THE MOMENT it's taken (the caller's act() writes), so
 * stopping after three keeps those three. Undo reverses the last one when
 * the caller gives an undo().
 *
 *   NBDTriageDeck.open({
 *     id: 'sort-customers',                  // remembers skips per deck
 *     title: 'Sort my customers',
 *     items: [...],                          // anything with a stable .id
 *     card(item) -> html,                    // the card body (escape it!)
 *     right(item) -> { label, act } | null,  // null = no main action here
 *     left: { label: 'Later' },              // skip; act optional
 *     more(item) -> [{ label, act }],        // the ⋯ options
 *     doneText: 'All sorted.',
 *   });
 *   act(item) may be async and may return { undo: async fn }.
 *
 * CSP: no inline handlers; one delegated listener on the overlay; pointer
 * events for the swipe. Styles: css/triage-deck.css (deck-*). Test hook:
 * window.NBDTriageDeck.
 */
(function () {
  'use strict';
  if (window.NBDTriageDeck) return;

  var ID = 'nbdTriageDeck';
  var SWIPE = 0.28;          // fraction of the card width that commits a swipe
  var st = null;             // the open deck

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function uid() { return (window._user && window._user.uid) || 'anon'; }
  function skipKey(id) { return 'nbd_triage_skips:' + uid() + ':' + id; }
  function loadSkips(id) {
    try { return JSON.parse(localStorage.getItem(skipKey(id)) || '{}') || {}; } catch (_) { return {}; }
  }
  function saveSkips() {
    try { localStorage.setItem(skipKey(st.cfg.id), JSON.stringify(st.skips)); } catch (_) { /* private mode */ }
  }

  function el() {
    var o = document.getElementById(ID);
    if (o) return o;
    o = document.createElement('div');
    o.id = ID;
    o.className = 'deck-overlay';
    o.setAttribute('role', 'dialog');
    o.setAttribute('aria-modal', 'true');
    o.innerHTML =
      '<div class="deck-shell">' +
        '<div class="deck-head"><div class="deck-titles"><div class="deck-title"></div><div class="deck-progress" aria-live="polite"></div></div>' +
          '<button type="button" class="deck-btn deck-close" data-deck="close" aria-label="Close">✕</button></div>' +
        '<div class="deck-stage"></div>' +
        '<div class="deck-more" hidden></div>' +
        '<div class="deck-bar">' +
          '<button type="button" class="deck-btn deck-left" data-deck="left">‹ Later</button>' +
          '<button type="button" class="deck-btn deck-dots" data-deck="more" aria-label="More options">⋯</button>' +
          '<button type="button" class="deck-btn deck-right" data-deck="right">✓</button>' +
        '</div>' +
        '<div class="deck-foot"><button type="button" class="deck-btn deck-undo" data-deck="undo" hidden>↶ Undo</button>' +
          '<span class="deck-status" aria-live="polite"></span></div>' +
      '</div>';
    document.body.appendChild(o);
    o.addEventListener('click', onClick);
    o.addEventListener('pointerdown', onDown);
    return o;
  }

  function current() { return st && st.queue.length ? st.queue[0] : null; }

  function paint() {
    var o = el();
    var item = current();
    o.querySelector('.deck-title').textContent = st.cfg.title || '';
    var left = st.queue.length;
    o.querySelector('.deck-progress').textContent = left
      ? left + ' left' + (st.done ? ' · ' + st.done + ' done' : '') + (st.skipped ? ' · ' + st.skipped + ' for later' : '')
      : (st.done ? st.done + ' done' : '');
    var stage = o.querySelector('.deck-stage');
    var more = o.querySelector('.deck-more');
    more.hidden = true; more.innerHTML = '';
    var R = o.querySelector('.deck-right'), L = o.querySelector('.deck-left'), D = o.querySelector('.deck-dots');
    if (!item) {
      stage.innerHTML = '<div class="deck-card deck-empty"><div class="deck-empty-icon">✓</div><div>' + esc(st.cfg.doneText || 'All done.') + '</div></div>';
      R.hidden = L.hidden = D.hidden = true;
    } else {
      var r = st.cfg.right ? st.cfg.right(item) : null;
      R.hidden = !r; R.textContent = r ? r.label + ' ›' : '';
      L.hidden = false; L.textContent = '‹ ' + ((st.cfg.left && st.cfg.left.label) || 'Later');
      var opts = st.cfg.more ? st.cfg.more(item) : [];
      D.hidden = !opts.length;
      stage.innerHTML = '<div class="deck-card" data-id="' + esc(item.id) + '">' +
        '<div class="deck-hint deck-hint-right">' + esc(r ? r.label : '') + '</div>' +
        '<div class="deck-hint deck-hint-left">' + esc((st.cfg.left && st.cfg.left.label) || 'Later') + '</div>' +
        st.cfg.card(item) + '</div>';
      // No main action (e.g. no suggestion): open the options straight away.
      if (!r && opts.length) openMore();
    }
    o.querySelector('.deck-undo').hidden = !st.undo;
  }

  function status(t) { var s = document.querySelector('#' + ID + ' .deck-status'); if (s) s.textContent = t || ''; }

  function openMore() {
    var item = current();
    if (!item) return;
    var opts = st.cfg.more ? st.cfg.more(item) : [];
    var more = el().querySelector('.deck-more');
    more.innerHTML = opts.map(function (o, i) {
      return '<button type="button" class="deck-btn deck-opt' + (o.primary ? ' deck-opt-primary' : '') + '" data-deck="opt" data-i="' + i + '">' + esc(o.label) + '</button>';
    }).join('');
    more.hidden = false;
  }

  async function run(kind, fn, item) {
    if (st.busy) return;
    st.busy = true;
    status('Saving…');
    var card = el().querySelector('.deck-card');
    if (card) card.classList.add(kind === 'left' ? 'deck-out-left' : 'deck-out-right');
    try {
      var res = fn ? await fn(item) : null;
      st.queue.shift();
      if (kind === 'left') {
        st.queue.push(item);                // back of the line this session
        st.skips[item.id] = Date.now();     // and next session
        saveSkips();
        st.skipped++;
        st.undo = null;
      } else {
        delete st.skips[item.id]; saveSkips();
        st.done++;
        st.undo = res && typeof res.undo === 'function' ? { item: item, fn: res.undo } : null;
      }
      status(kind === 'left' ? '' : 'Saved.');
    } catch (e) {
      status((e && e.message) || 'That did not save — try again.');
    }
    st.busy = false;
    setTimeout(paint, 120);
  }

  async function undo() {
    if (!st || !st.undo || st.busy) return;
    var u = st.undo; st.undo = null;
    st.busy = true; status('Undoing…');
    try {
      await u.fn();
      st.queue.unshift(u.item);
      st.done = Math.max(0, st.done - 1);
      status('Undone.');
    } catch (e) { status((e && e.message) || 'Could not undo.'); }
    st.busy = false;
    paint();
  }

  function onClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-deck]') : null;
    if (!b || !st) return;
    var a = b.getAttribute('data-deck'), item = current();
    if (a === 'close') return close();
    if (a === 'undo') return undo();
    if (!item) return;
    if (a === 'right') { var r = st.cfg.right && st.cfg.right(item); if (r) run('right', r.act, item); }
    else if (a === 'left') run('left', st.cfg.left && st.cfg.left.act, item);
    else if (a === 'more') { var m = el().querySelector('.deck-more'); if (m.hidden) openMore(); else m.hidden = true; }
    else if (a === 'opt') {
      var o = (st.cfg.more(item) || [])[Number(b.getAttribute('data-i'))];
      if (o && o.href) { window.open(o.href, '_blank', 'noopener'); return; }
      if (o) run(o.kind === 'left' ? 'left' : 'right', o.act, item);
    }
  }

  // Swipe: drag the card; past SWIPE × width commits, otherwise it springs back.
  function onDown(e) {
    var card = e.target.closest && e.target.closest('.deck-card[data-id]');
    if (!card || !st || st.busy || e.target.closest('a,button,select,input')) return;
    var x0 = e.clientX, y0 = e.clientY, dx = 0, horiz = null, w = card.getBoundingClientRect().width || 300;
    card.setPointerCapture && card.setPointerCapture(e.pointerId);
    function move(ev) {
      dx = ev.clientX - x0;
      var dy = ev.clientY - y0;
      if (horiz === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) horiz = Math.abs(dx) > Math.abs(dy);
      if (!horiz) return;
      ev.preventDefault();
      card.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx / w * 8) + 'deg)';
      card.classList.toggle('deck-lean-right', dx > w * SWIPE * 0.5);
      card.classList.toggle('deck-lean-left', dx < -w * SWIPE * 0.5);
    }
    function up() {
      card.removeEventListener('pointermove', move);
      card.removeEventListener('pointerup', up);
      card.removeEventListener('pointercancel', up);
      var item = current();
      var r = st.cfg.right && item && st.cfg.right(item);
      if (horiz && dx > w * SWIPE && r) return run('right', r.act, item);
      if (horiz && dx < -w * SWIPE && item) return run('left', st.cfg.left && st.cfg.left.act, item);
      card.style.transform = '';
      card.classList.remove('deck-lean-right', 'deck-lean-left');
    }
    card.addEventListener('pointermove', move);
    card.addEventListener('pointerup', up);
    card.addEventListener('pointercancel', up);
  }

  function onKey(e) {
    if (!st || !document.getElementById(ID) || !document.getElementById(ID).classList.contains('open')) return;
    if (/input|select|textarea/i.test((e.target && e.target.tagName) || '')) return;
    if (e.key === 'Escape') return close();
    var item = current(); if (!item) return;
    if (e.key === 'ArrowRight') { var r = st.cfg.right && st.cfg.right(item); if (r) run('right', r.act, item); }
    else if (e.key === 'ArrowLeft') run('left', st.cfg.left && st.cfg.left.act, item);
  }
  document.addEventListener('keydown', onKey);

  function open(cfg) {
    var skips = loadSkips(cfg.id);
    // Not-yet-seen first; skipped ones after, oldest skip first.
    var fresh = [], later = [];
    (cfg.items || []).forEach(function (it) { (skips[it.id] ? later : fresh).push(it); });
    later.sort(function (a, b) { return skips[a.id] - skips[b.id]; });
    st = { cfg: cfg, queue: fresh.concat(later), skips: skips, done: 0, skipped: 0, undo: null, busy: false };
    var o = el();
    o.classList.add('open');
    document.documentElement.classList.add('deck-locked');
    status('');
    paint();
  }
  function close() {
    var o = document.getElementById(ID);
    if (o) o.classList.remove('open');
    document.documentElement.classList.remove('deck-locked');
    var cb = st && st.cfg.onClose; var done = st ? st.done : 0;
    st = null;
    if (typeof cb === 'function') { try { cb(done); } catch (_) {} }
  }

  window.NBDTriageDeck = { open: open, close: close, _state: function () { return st; } };
})();
