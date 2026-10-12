/**
 * layouts/kit.js — the shared building blocks layouts are made of (2026-10-11,
 * D1 of the style integration). Loaded lazily, and only by a layout that lists
 * it in `needs.script`; Classic never loads it.
 *
 * Layouts are arrangements of existing building blocks, not rewrites, so this
 * holds ONLY what the first two layouts (Field App, Focus) actually need:
 *
 *   LeadCard   three densities — row | card | hero — of one normalised item
 *   ActionBar  Call / Text / Navigate / Open / Snooze / Photo / Done, ONE
 *              definition of what each button is and does
 *   Widget     title + size contract + loading / empty / ok states
 *   Nav        adapters: `bottom` (tab bar with an optional raised centre
 *              button). More adapters are added when a layout needs one.
 *
 * Everything returns an HTML STRING with every dynamic value escaped; layouts
 * assign it to innerHTML of a container they own. Everything reads theme tokens
 * and --tap only (css/layouts/kit.css), so any theme works.
 *
 * Nothing here sends anything. Call and Text are `tel:` / `sms:` links — the
 * phone's own dialer / composer opens and the rep presses Send there (the same
 * thing today-home.js's rows do). Snooze goes through LeadSnooze.prompt, the
 * CRM's existing modal. Done / Photo / anything layout-specific is emitted as a
 * bubbling `nbd:layout-action` CustomEvent for the layout to handle.
 *
 * Note on "wired once to customer-quick-actions.js" (Grok's layouts doc): that
 * file is the customer-page header's collapse helper, not an action API — there
 * is nothing in it to wire to. The primitives it carries (tel/sms/email links)
 * are what this ActionBar defines once for the layouts.
 *
 * Classic script: window.NBDLayoutKit; require()-able for tests.
 */
(function (root) {
  'use strict';

  // ── helpers (pure) ───────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function digits10(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length === 10 ? d : '';
  }
  function fmtPhone(v) {
    var d = digits10(v);
    return d ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : '';
  }
  function leadName(l) {
    if (!l) return '';
    var full = (String(l.firstName || '') + ' ' + String(l.lastName || '')).trim();
    return full || String(l.name || l.customerName || '').trim() || String(l.address || '').split(',')[0].trim() || 'Customer';
  }
  function customerUrl(id) {
    if (id == null || id === '') return '';
    if (root && root.NBDUrl && typeof root.NBDUrl.customer === 'function') return root.NBDUrl.customer(id);
    return '/pro/customer.html?id=' + encodeURIComponent(id);
  }
  function mapsUrl(address) {
    var a = String(address || '').trim();
    return a ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(a) : '';
  }
  function telUrl(phone) { var d = digits10(phone); return d ? 'tel:+1' + d : ''; }
  function smsUrl(phone) { var d = digits10(phone); return d ? 'sms:+1' + d : ''; }

  /** A CRM lead (or an item a layout built) -> the one shape the components take. */
  function fromLead(l, extra) {
    var x = extra || {};
    return {
      id: l && l.id != null ? String(l.id) : '',
      name: x.name || leadName(l),
      address: String((x.address != null ? x.address : l && l.address) || ''),
      phone: String((x.phone != null ? x.phone : l && (l.phone || l.phoneDigits)) || ''),
      stage: String((x.stage != null ? x.stage : l && (l._stageKey || l.stage)) || ''),
      why: String(x.why || ''),            // one plain line: why this lead, why now
      timeLabel: String(x.timeLabel || ''),
      type: String(x.type || ''),
      badge: String(x.badge || ''),
    };
  }

  // ── icons: stroke SVG, currentColor, so they follow the theme ────────
  var ICONS = {
    call: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
    text: 'M4 5h16v11H9l-5 4z',
    navigate: 'M12 2l7 19-7-4-7 4z',
    open: 'M9 6l6 6-6 6',
    snooze: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
    photo: 'M4 8h4l2-3h4l2 3h4v11H4zM12 11a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
    done: 'M5 12l5 5 9-10',
    voice: 'M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4',
    today: 'M4 5h16v15H4zM4 10h16M9 3v4M15 3v4',
    map: 'M9 4l6 2 5-2v14l-5 2-6-2-5 2V6zM9 4v14M15 6v14',
    leads: 'M16 11a3 3 0 1 0-6 0 3 3 0 0 0 6 0zM5 20a7 7 0 0 1 14 0',
    me: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  };
  function icon(name) {
    var d = ICONS[name];
    if (!d) return '';
    return '<svg class="lk-ic" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
  }

  // ── ActionBar: ONE definition of every action ────────────────────────
  // kind 'link': a plain anchor, the browser does it (works with no JS).
  // kind 'button': data-lk-act, handled by bind() below.
  var ACTIONS = {
    call:     { label: 'Call',     icon: 'call',     kind: 'link',   href: function (it) { return telUrl(it.phone); } },
    text:     { label: 'Text',     icon: 'text',     kind: 'link',   href: function (it) { return smsUrl(it.phone); } },
    navigate: { label: 'Navigate', icon: 'navigate', kind: 'link',   href: function (it) { return mapsUrl(it.address); }, external: true },
    open:     { label: 'Open',     icon: 'open',     kind: 'link',   href: function (it) { return customerUrl(it.id); } },
    snooze:   { label: 'Snooze',   icon: 'snooze',   kind: 'button' },
    photo:    { label: 'Photo',    icon: 'photo',    kind: 'button' },
    done:     { label: 'Done',     icon: 'done',     kind: 'button' },
    voice:    { label: 'Voice note', icon: 'voice',  kind: 'button' },
  };

  /**
   * ActionBar html for one item. A link action with nothing to link to (no
   * phone, no address) renders as a disabled button, not a dead anchor — a rep
   * on a roof must be able to see "no phone on file" instead of tapping a
   * button that does nothing.
   * opts.size 'lg' (tap-sized, labelled) | 'sm' (compact); opts.primary: action id to emphasise.
   */
  function actionBar(item, ids, opts) {
    var o = opts || {};
    var it = item || {};
    var out = '<div class="lk-actions lk-actions-' + (o.size === 'sm' ? 'sm' : 'lg') + '" role="group" aria-label="Actions for ' + esc(it.name || 'lead') + '">';
    (ids || []).forEach(function (id) {
      var a = ACTIONS[id];
      if (!a) return;
      var cls = 'lk-act lk-act-' + id + (o.primary === id ? ' lk-act-primary' : '');
      var inner = icon(a.icon) + '<span class="lk-act-lbl">' + esc(o.labels && o.labels[id] || a.label) + '</span>';
      if (a.kind === 'link') {
        var href = a.href(it);
        if (!href) {
          out += '<button type="button" class="' + cls + ' lk-act-off" disabled aria-disabled="true">' + inner + '</button>';
        } else {
          out += '<a class="' + cls + '" href="' + esc(href) + '" data-lk-link="' + id + '"' +
            (a.external ? ' target="_blank" rel="noopener"' : '') + '>' + inner + '</a>';
        }
      } else {
        out += '<button type="button" class="' + cls + '" data-lk-act="' + id + '" data-lead-id="' + esc(it.id) + '">' + inner + '</button>';
      }
    });
    return out + '</div>';
  }

  // ── LeadCard: row | card | hero ──────────────────────────────────────
  var DENSITIES = ['row', 'card', 'hero'];
  function card(item, opts) {
    var o = opts || {};
    var it = item || {};
    var d = DENSITIES.indexOf(o.density) !== -1 ? o.density : 'card';
    var open = customerUrl(it.id);
    var html = '<div class="lk-card lk-card-' + d + (o.current ? ' lk-card-current' : '') + (o.done ? ' lk-card-done' : '') +
      '" data-lead-id="' + esc(it.id) + '">';
    if (it.timeLabel) html += '<div class="lk-time">' + esc(it.timeLabel) + '</div>';
    html += '<div class="lk-main">';
    html += '<div class="lk-name">' + esc(it.name || 'Customer') + (it.badge ? ' <span class="lk-badge">' + esc(it.badge) + '</span>' : '') + '</div>';
    if (it.address) html += '<div class="lk-addr">' + esc(it.address) + '</div>';
    if (d !== 'row' && it.why) html += '<div class="lk-why">' + esc(it.why) + '</div>';
    if (d === 'hero' && it.phone && fmtPhone(it.phone)) html += '<div class="lk-phone">' + esc(fmtPhone(it.phone)) + '</div>';
    html += '</div>';
    if (d === 'row' && open) html += '<a class="lk-open" href="' + esc(open) + '" data-lk-link="open" aria-label="Open ' + esc(it.name || 'lead') + '">' + icon('open') + '</a>';
    if (d !== 'row' && Array.isArray(o.actions) && o.actions.length) {
      html += actionBar(it, o.actions, { size: d === 'hero' ? 'lg' : 'sm', primary: o.primary });
    }
    return html + '</div>';
  }

  // ── Widget: title, size contract, states ─────────────────────────────
  var SIZES = ['1x1', '2x1', '2x2', '3x1', '4x1', '4x2'];
  function widget(w) {
    var x = w || {};
    var size = SIZES.indexOf(x.size) !== -1 ? x.size : '1x1';
    var state = x.state === 'loading' || x.state === 'empty' ? x.state : 'ok';
    var body;
    if (state === 'loading') body = '<div class="lk-w-state" role="status">' + esc(x.loadingText || 'Loading...') + '</div>';
    else if (state === 'empty') body = '<div class="lk-w-state lk-w-empty">' + esc(x.emptyText || 'Nothing here yet') + '</div>';
    else body = String(x.body == null ? '' : x.body);   // already-escaped html from the layout
    return '<section class="lk-widget lk-w-' + size + ' lk-w-' + state + '" data-widget="' + esc(x.id || '') + '">' +
      (x.title ? '<header class="lk-w-hdr"><h3 class="lk-w-title">' + esc(x.title) + '</h3>' + (x.aside ? '<span class="lk-w-aside">' + esc(x.aside) + '</span>' : '') + '</header>' : '') +
      '<div class="lk-w-body">' + body + '</div></section>';
  }

  // ── Nav adapters ─────────────────────────────────────────────────────
  // items: [{ id, label, icon, raised? }]; the raised one is the camera.
  function nav(kind, items, activeId) {
    var k = kind === 'bottom' ? 'bottom' : 'bottom';   // only adapter so far; others arrive with their layout
    var out = '<nav class="lk-nav lk-nav-' + k + '" aria-label="Field navigation">';
    (items || []).forEach(function (it) {
      var cls = 'lk-nav-item' + (it.raised ? ' lk-nav-raised' : '') + (it.id === activeId ? ' lk-nav-active' : '');
      out += '<button type="button" class="' + cls + '" data-lk-nav="' + esc(it.id) + '"' +
        (it.id === activeId ? ' aria-current="page"' : '') + ' aria-label="' + esc(it.label) + '">' +
        icon(it.icon) + '<span class="lk-nav-lbl">' + esc(it.label) + '</span></button>';
    });
    return out + '</nav>';
  }

  // ── delegated events: one listener on the layout's container ─────────
  // handlers: { photo(item), done(item), snooze(item), nav(id), <action>(item) }
  // Anything not handled here is emitted as `nbd:layout-action` (bubbles) so a
  // layout can listen once on its root instead of wiring each button.
  function bind(rootEl, handlers, lookup) {
    var h = handlers || {};
    function onClick(ev) {
      var t = ev.target && ev.target.closest ? ev.target : null;
      if (!t) return;
      var navBtn = t.closest('[data-lk-nav]');
      if (navBtn && rootEl.contains(navBtn)) {
        if (typeof h.nav === 'function') { ev.preventDefault(); h.nav(navBtn.getAttribute('data-lk-nav')); }
        return;
      }
      var btn = t.closest('[data-lk-act]');
      if (!btn || !rootEl.contains(btn)) return;
      ev.preventDefault();
      var act = btn.getAttribute('data-lk-act');
      var id = btn.getAttribute('data-lead-id') || '';
      var item = typeof lookup === 'function' ? (lookup(id) || { id: id }) : { id: id };
      if (typeof h[act] === 'function') { h[act](item, btn); return; }
      if (act === 'snooze' && root && root.LeadSnooze && typeof root.LeadSnooze.prompt === 'function') {
        root.LeadSnooze.prompt(id, item.name || '');
        return;
      }
      var CE = (root && root.CustomEvent) || (typeof CustomEvent === 'function' ? CustomEvent : null);
      if (rootEl.dispatchEvent && CE) {
        rootEl.dispatchEvent(new CE('nbd:layout-action', { bubbles: true, detail: { action: act, leadId: id, item: item } }));
      }
    }
    rootEl.addEventListener('click', onClick);
    return function unbind() { rootEl.removeEventListener('click', onClick); };
  }

  var api = {
    esc: esc, digits10: digits10, fmtPhone: fmtPhone, leadName: leadName, customerUrl: customerUrl,
    mapsUrl: mapsUrl, telUrl: telUrl, smsUrl: smsUrl, fromLead: fromLead, icon: icon,
    ACTIONS: ACTIONS, DENSITIES: DENSITIES, SIZES: SIZES,
    actionBar: actionBar, card: card, widget: widget, nav: nav, bind: bind,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDLayoutKit = api;
})(typeof window !== 'undefined' ? window : null);
