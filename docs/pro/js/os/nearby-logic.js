/**
 * os/nearby-logic.js — the pure half of the NBD OS Nearby widget (2026-11-09, P3;
 * design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §8 P3 "Nearby").
 *
 * No DOM, no clock, no storage, no network, no geolocation: every function
 * takes what it needs (tested in plain Node, tests/nbd-os-nearby-2026-11-09.test.js).
 *
 * Nearby lists the member's leads closest to where they are standing, by
 * straight-line distance from the coordinates the leads already carry (lead.lat /
 * lead.lng: the fields maps-customers.js plots and backfills, numbers or numeric
 * strings). The position comes from os/nearby.js, read once on a tap, and is
 * passed in here; nothing here keeps it.
 *
 *   coordsOf(lead)        { lat, lng } when the lead has a usable location, else null
 *                         (missing, not a number, out of range, or 0,0: a failed geocode)
 *   miles(a, b)           great-circle distance in miles
 *   miText(mi)            "0.4 mi" (one decimal under 10), "12 mi", "Under 0.1 mi"
 *   ownerOf(lead)         lead.userId, else lead.assignedTo (the CRM's "own" rule)
 *   scope(leads, uid)     { mine, all, others }: mine = own or unowned; all = every lead
 *                         in memory, which is already only what the member's role loads;
 *                         others = true when that list holds a teammate's lead
 *   nearest(leads, pos, o) the n closest (o.n), each { id, name, street, mi, dist, verbs },
 *                         plus how many leads in the scope have a location (located)
 *   verbs(lead, impl)     Open / Call / Navigate: the action runner's leadVerbs
 *                         (command-runner.js, window.NBDRunner._pure) when it is loaded,
 *                         else the same rules here (a parity test pins them); Text is
 *                         left out (the runner's own check gates it)
 *   geoError(err)         a GeolocationPositionError as { kind, text, short }
 *   fresh(fix, now)       a fix is used for 10 minutes, then the widget asks for a tap again
 *
 * Classic script: window.NBDOSNearbyLogic; require()-able for tests. Loaded in
 * the runtime ScriptLoader bundle 'osnearby' (os/home.js registers it).
 */
(function (root) {
  'use strict';

  var R_MI = 3958.8;
  var FIX_MS = 10 * 60000;
  var MAPS = 'https://www.google.com/maps/search/?api=1&query=';
  var KEEP = { open: 1, call: 1, nav: 1 };

  function num(v) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    var n = typeof v === 'number' ? v : Number(String(v).trim());
    return isFinite(n) ? n : null;
  }
  function coordsOf(l) {
    if (!l || typeof l !== 'object') return null;
    var lat = num(l.lat), lng = num(l.lng);
    if (lat === null || lng === null) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    if (lat === 0 && lng === 0) return null;
    return { lat: lat, lng: lng };
  }
  function miles(a, b) {
    var r = Math.PI / 180;
    var dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R_MI * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  function miText(mi) {
    if (typeof mi !== 'number' || !isFinite(mi) || mi < 0) return '';
    if (mi < 0.1) return 'Under 0.1 mi';
    var tenths = Math.round(mi * 10) / 10;   // round first, then pick the format: 9.96 is "10 mi", not "10.0 mi"
    if (tenths < 10) return tenths.toFixed(1) + ' mi';
    return String(Math.round(mi)) + ' mi';
  }
  function ownerOf(l) { return l ? String(l.userId || l.assignedTo || '') : ''; }
  function live(l) { return !!l && typeof l === 'object' && !l.deleted && l.id != null && String(l.id) !== ''; }
  function scope(leads, uid) {
    var me = String(uid || ''), mine = [], all = [], others = false;
    (Array.isArray(leads) ? leads : []).forEach(function (l) {
      if (!live(l)) return;
      all.push(l);
      var o = ownerOf(l);
      if (!o || (me && o === me)) mine.push(l);
      else others = true;
    });
    return { mine: mine, all: all, others: others };
  }
  function leadName(l) {
    var n = (String(l.firstName || '') + ' ' + String(l.lastName || '')).trim();
    return n || String(l.name || '').trim() || 'Lead';
  }
  /** The street line: the address up to its first comma. */
  function street(l) {
    var a = String((l && (l.address || l.addr)) || '').trim();
    var i = a.indexOf(',');
    return i > 0 ? a.slice(0, i).trim() : a;
  }

  // the runner's rules (command-runner.js digits10 / telUrl / mapsUrl / leadVerbs), for when it is not loaded
  function digits10(p) {
    var d = String(p == null ? '' : p).replace(/\D+/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length === 10 ? d : '';
  }
  function ownVerbs(l) {
    var out = [{ id: 'open', label: 'Open' }];
    var d = digits10(l && (l.phone || l.phoneDigits));
    var a = String((l && l.address) == null ? '' : l.address).trim();
    if (d) out.push({ id: 'call', label: 'Call', href: 'tel:+1' + d });
    if (d) out.push({ id: 'text', label: 'Text', href: 'sms:+1' + d, sms: true });
    if (a) out.push({ id: 'nav', label: 'Navigate', href: MAPS + encodeURIComponent(a), ext: true });
    return out;
  }
  var SAFE = /^(tel:\+?[\d-]+|https:\/\/[^\s"'<>]+)$/i;
  /** Open / Call / Navigate for a lead: Open goes to the customer page; Call and Navigate keep the runner's hrefs. */
  function verbs(l, impl) {
    var list = null;
    if (typeof impl === 'function') { try { list = impl(l); } catch (e) { list = null; } }
    if (!Array.isArray(list)) list = ownVerbs(l);
    var out = [];
    list.forEach(function (v) {
      if (!v || !KEEP[v.id]) return;
      if (v.id === 'open') out.push({ id: 'open', label: 'Open', href: '/pro/customer.html?id=' + encodeURIComponent(String(l.id)), ext: false });
      else if (typeof v.href === 'string' && SAFE.test(v.href)) out.push({ id: v.id, label: v.id === 'call' ? 'Call' : 'Navigate', href: v.href, ext: v.id === 'nav' });
    });
    return out;
  }

  /**
   * The n leads closest to pos in the scope ('mine' or 'all'), nearest first; ties keep
   * the list order. -> { rows, located, inScope, others }. No position -> rows [].
   */
  function nearest(leads, pos, o) {
    var opt = o || {};
    var s = scope(leads, opt.uid);
    var list = opt.scope === 'all' ? s.all : s.mine;
    var n = Math.max(1, Math.min(10, Math.floor(Number(opt.n) || 3)));
    var p = pos && coordsOf(pos);
    var placed = [];
    list.forEach(function (l, i) {
      var c = coordsOf(l);
      if (c) placed.push({ l: l, i: i, mi: p ? miles(p, c) : null });
    });
    var rows = [];
    if (p) {
      placed.sort(function (a, b) { return a.mi - b.mi || a.i - b.i; });
      rows = placed.slice(0, n).map(function (x) {
        return { id: String(x.l.id), name: leadName(x.l), street: street(x.l), mi: x.mi, dist: miText(x.mi), verbs: verbs(x.l, opt.verbs) };
      });
    }
    return { rows: rows, located: placed.length, inScope: list.length, others: s.others };
  }

  /** text for M / L, short for S (one 92px phone cell: the title line and one button) */
  function geoError(err) {
    var code = err && typeof err.code === 'number' ? err.code : 0;
    if (code === 1) return { kind: 'denied', text: 'Location is off for this site. Turn it on in your browser settings.', short: 'Location off' };
    if (code === 3) return { kind: 'timeout', text: 'Finding your location took too long.', short: 'No location' };
    if (err && err.kind === 'none') return { kind: 'none', text: 'This device can\'t share a location.', short: 'No location' };
    return { kind: 'unavailable', text: 'Couldn\'t find your location.', short: 'No location' };
  }
  function fresh(fix, now) {
    return !!fix && typeof fix.at === 'number' && typeof now === 'number' && now - fix.at >= 0 && now - fix.at < FIX_MS && !!coordsOf(fix);
  }

  var api = {
    coordsOf: coordsOf, miles: miles, miText: miText, ownerOf: ownerOf, scope: scope, nearest: nearest,
    verbs: verbs, ownVerbs: ownVerbs, geoError: geoError, fresh: fresh, street: street, leadName: leadName, FIX_MS: FIX_MS,
  };
  if (root) root.NBDOSNearbyLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
