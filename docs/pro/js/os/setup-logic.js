/**
 * os/setup-logic.js — the pure half of NBD OS "Copy my setup" (2026-11-09, P3; design:
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §3.5, §8 P3).
 *
 * The member's home as text to copy, and a pasted text back as a home, through
 * os/home-logic.js (NBDOSHomeLogic) and nothing else: its normalize rules are the only
 * gate, so a pasted setup can hold no more than a saved one (24 widgets a surface,
 * catalog ids, sizes, enum or id settings, desk cells, Smart Stack cards, wallpaper ids,
 * the four modes), and every unknown key is dropped.
 *
 * The text:  { "nbd": "nbd-os-setup", "v": 1, "home": { phone, desk, wp, acts } }
 *   phone / desk  what the member sees on each surface (their own, or the company's home)
 *   wp            each surface's wallpaper: 'tod', 'none' or a My Skin picture id
 *   acts          the four modes (Activities), with their names and own widgets
 * Never a customer, a lead, a count, money, a name from the CRM or a URL: a Saved view
 * tile carries its view's 8-character id only. Which mode is on (`on`) is not a setup:
 * it is not copied, and a paste keeps the member's own.
 *
 *   exportKey(seen, own)     { nbd, v, home } from the home on screen (resolveHome) and the own key
 *   exportText(seen, own)    that, as JSON text
 *   parse(text)              { ok:true, home } | { ok:false, error } (a plain sentence)
 *   merge(own, home, locked) the member's next own key: the pasted surfaces, wallpaper and
 *                            modes over their own; a surface the company locked keeps theirs
 *                            (locked: { phone, desk } booleans; the lock wins)
 *   summary(home, locked)    plain lines for the preview (a My Skin picture id may not carry over:
 *                            it is the exporter's, and shows as Time of day where it is missing)
 *   same(a, b)               two keys that save the same thing
 *
 * Classic script: window.NBDOSSetupLogic; require()-able for tests (it requires
 * home-logic.js there). Loaded with os/setup.js as the runtime ScriptLoader bundle
 * 'ossetup' that layouts/os.js registers on the first tap.
 */
(function (root) {
  'use strict';

  var FORMAT = 'nbd-os-setup';
  var MAX_TEXT = 20000;   // a max-fill home with four full modes is under 12,000 (the os-home budget)
  var SURF = ['phone', 'desk'];
  var SURF_NAME = { phone: 'Phone', desk: 'Laptop' };

  function HL() {
    var H = root && root.NBDOSHomeLogic;
    if (!H && typeof require === 'function') { try { H = require('./home-logic.js'); } catch (e) { H = null; } }
    return H;
  }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function list(it) { return Array.isArray(it) ? it : null; }

  /** The setup to copy: the surfaces as seen, the own wallpaper and modes; `on` left out. */
  function exportKey(seen, own) {
    var H = HL(), s = isObj(seen) ? seen : {}, o = isObj(own) ? own : {};
    var raw = { v: 1 };
    SURF.forEach(function (k) { if (list(s[k])) raw[k] = s[k]; });
    if (isObj(o.wp)) raw.wp = o.wp;
    if (list(o.acts)) raw.acts = o.acts;
    var home = H.keep(raw);
    delete home.on;
    return { nbd: FORMAT, v: 1, home: home };
  }
  function exportText(seen, own) { return JSON.stringify(exportKey(seen, own)); }

  // a list whose every item was garbage is not a choice (normalize would put the defaults there)
  function anyKnown(arr) {
    var H = HL();
    return arr.some(function (it) { return isObj(it) && typeof it.id === 'string' && Object.prototype.hasOwnProperty.call(H.CATALOG, it.id); });
  }

  function parse(text) {
    var H = HL();
    if (!H) return { ok: false, error: 'The home screen is not ready. Try again.' };
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Paste a setup first.' };
    if (text.length > MAX_TEXT) return { ok: false, error: 'That text is too long to be a setup.' };
    var raw;
    try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: 'That isn\'t a setup. Copy it again from Copy my setup and paste all of it.' }; }
    if (!isObj(raw) || raw.nbd !== FORMAT || raw.v !== 1 || !isObj(raw.home)) {
      return { ok: false, error: 'That isn\'t a setup. Copy it again from Copy my setup and paste all of it.' };
    }
    var r = raw.home, pick = { v: 1 };
    SURF.forEach(function (k) {
      var a = list(r[k]);
      if (a && (!a.length || anyKnown(a))) pick[k] = a;
    });
    if (isObj(r.wp)) pick.wp = r.wp;
    if (list(r.acts)) pick.acts = r.acts;
    var home = H.keep(pick);
    delete home.on;
    if (!home.phone && !home.desk && !home.wp && !home.acts) return { ok: false, error: 'Nothing in that text is part of a home setup.' };
    return { ok: true, home: home };
  }

  function merge(own, home, locked) {
    var H = HL(), lk = isObj(locked) ? locked : {}, h = isObj(home) ? home : {};
    var out = H.keep(own);
    SURF.forEach(function (k) { if (list(h[k]) && lk[k] !== true) out[k] = h[k]; });
    if (isObj(h.wp)) out.wp = h.wp;
    if (list(h.acts)) out.acts = h.acts;
    return H.keep(out);
  }

  function titles(arr) {
    var H = HL(), seen = {};
    return arr.map(function (it) {
      var t = H.CATALOG[it.id].title;
      seen[t] = (seen[t] || 0) + 1;
      return t;
    }).filter(function (t, i, a) { return a.indexOf(t) === i; }).map(function (t) { return seen[t] > 1 ? t + ' (' + seen[t] + ')' : t; });
  }
  function isPic(v) { return typeof v === 'string' && !!v && v !== 'tod' && v !== 'none'; }
  function wpName(v) { return v === 'tod' ? 'Time of day' : v === 'none' ? 'None' : v ? 'a My Skin picture' : 'the default'; }

  function summary(home, locked) {
    var H = HL(), h = isObj(home) ? home : {}, lk = isObj(locked) ? locked : {}, out = [];
    SURF.forEach(function (k) {
      if (!list(h[k])) return;
      if (lk[k] === true) { out.push(SURF_NAME[k] + ': your company set this home, so it stays as it is.'); return; }
      var n = H.weight(h[k]);
      out.push(SURF_NAME[k] + ': ' + (h[k].length ? String(n) + (n === 1 ? ' widget' : ' widgets') + ' (' + titles(h[k]).join(', ') + ')' : 'no widgets'));
    });
    if (isObj(h.wp)) out.push('Wallpaper: phone ' + wpName(h.wp.phone) + ', laptop ' + wpName(h.wp.desk));
    if (list(h.acts)) out.push('Modes: ' + h.acts.map(function (a) { return a.name; }).join(', '));
    var kpis = SURF.some(function (k) { return list(h[k]) && lk[k] !== true && h[k].some(function (it) { return it.id === 'kpi'; }); });
    if (kpis) out.push('A Saved view tile counts only a view your team has saved; any other shows no number.');
    // a My Skin picture id is the exporter's: on another account it does not resolve, and the
    // surface shows Time of day instead (layouts/os.js paintWp), so the preview says so
    var pics = [h.wp].concat(list(h.acts) ? h.acts.map(function (a) { return a && a.wp; }) : []).some(function (w) {
      return isObj(w) && [w.phone, w.desk].some(isPic);
    });
    if (pics) out.push('A My Skin picture shows only on an account that has that picture; anywhere else it is Time of day.');
    return out;
  }

  function same(a, b) { var H = HL(); return JSON.stringify(H.keep(a)) === JSON.stringify(H.keep(b)); }

  var api = { FORMAT: FORMAT, MAX_TEXT: MAX_TEXT, exportKey: exportKey, exportText: exportText, parse: parse, merge: merge, summary: summary, same: same };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSSetupLogic = api;
})(typeof window !== 'undefined' ? window : null);
