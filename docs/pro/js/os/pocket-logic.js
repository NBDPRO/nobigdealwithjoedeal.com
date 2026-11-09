/**
 * os/pocket-logic.js — NBD OS P3: Pocket's notes, the pure half (2026-11-09; design:
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6 #9).
 *
 * A typed Pocket note lives on THIS device only (localStorage, one key per user) until
 * the member files it through quick-capture.js's own writer. This file holds the shape:
 * at most MAX_NOTES notes of at most MAX_LEN characters, each {id, text, at}, newest
 * first. add / restore refuse a full Pocket rather than drop the oldest note.
 *
 * No DOM, no storage, no network. Node (tests/nbd-os-pocket-2026-11-09.test.js) and the
 * browser (window.NBDOSPocketLogic, the `ospocket` runtime bundle).
 */
(function (root) {
  'use strict';
  var MAX_NOTES = 20;
  var MAX_LEN = 2000;
  var PREFIX = 'nbd_os_pocket:';
  var DRAFT_PREFIX = 'nbd_os_pocket_draft:';

  function uidPart(uid) {
    var u = String(uid == null ? '' : uid);
    return /^[A-Za-z0-9_-]{1,128}$/.test(u) ? u : null;
  }
  /** The member's notes key, or null with no user (then nothing is stored). */
  function key(uid) { var u = uidPart(uid); return u ? PREFIX + u : null; }
  /** The member's unsent draft key, or null. */
  function draftKey(uid) { var u = uidPart(uid); return u ? DRAFT_PREFIX + u : null; }

  /** Plain text: line breaks kept (\r\n -> \n), other control characters out, trimmed, clipped. */
  function cleanText(s) {
    return String(s == null ? '' : s).replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/^\s+|\s+$/g, '').slice(0, MAX_LEN);
  }

  /** A stored value (JSON string or array) as a clean list, newest first, at most MAX_NOTES. */
  function normalize(raw) {
    var arr = raw;
    if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch (e) { arr = null; } }
    if (!Array.isArray(arr)) return [];
    var seen = {}, out = [];
    arr.forEach(function (n) {
      if (!n || typeof n !== 'object') return;
      var id = String(n.id == null ? '' : n.id);
      if (!/^[a-z0-9]{1,24}$/.test(id) || seen[id]) return;
      var text = cleanText(n.text);
      var at = Number(n.at);
      if (!text || !isFinite(at) || at <= 0) return;
      seen[id] = true;
      out.push({ id: id, text: text, at: Math.floor(at) });
    });
    out.sort(function (a, b) { return b.at - a.at; });
    return out.slice(0, MAX_NOTES);
  }

  function newId(now, list) {
    var base = Math.max(1, Math.floor(Number(now) || 0)).toString(36);
    var id = base, i = 0;
    var taken = function (x) { return list.some(function (n) { return n.id === x; }); };
    while (taken(id)) id = base + (++i).toString(36);
    return id.slice(0, 24);
  }

  /** Keep a note: { list, note } or { list, error: 'empty' | 'full' } (the list unchanged). */
  function add(list, text, now) {
    var cur = normalize(list);
    var t = cleanText(text);
    if (!t) return { list: cur, error: 'empty' };
    if (cur.length >= MAX_NOTES) return { list: cur, error: 'full' };
    var note = { id: newId(now, cur), text: t, at: Math.floor(Number(now) || 0) };
    return { list: normalize([note].concat(cur)), note: note };
  }
  /** Take a note out: { list, removed (null when unknown) }. */
  function remove(list, id) {
    var cur = normalize(list);
    var removed = null;
    var rest = cur.filter(function (n) { if (n.id === id) { removed = n; return false; } return true; });
    return { list: rest, removed: removed };
  }
  /** Undo a remove: { list } or { list, error: 'full' }. Its time puts it back in its place. */
  function restore(list, note) {
    var cur = normalize(list);
    if (cur.length >= MAX_NOTES) return { list: cur, error: 'full' };
    return { list: normalize(cur.concat([note])) };
  }

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function clock(d) {
    var h = d.getHours(), m = d.getMinutes();
    return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  /** When a note was kept, from its own time: "just now", "7 min ago", "3:05 PM", "Nov 6, 3:05 PM"; '' with no time. */
  function when(at, now) {
    var t = Number(at), n = Number(now);
    if (!isFinite(t) || t <= 0 || !isFinite(n)) return '';
    var mins = Math.floor((n - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var d = new Date(t), today = new Date(n);
    if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) return clock(d);
    return MON[d.getMonth()] + ' ' + d.getDate() + ', ' + clock(d);
  }

  var api = {
    MAX_NOTES: MAX_NOTES, MAX_LEN: MAX_LEN,
    key: key, draftKey: draftKey, cleanText: cleanText, normalize: normalize,
    add: add, remove: remove, restore: restore, when: when,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSPocketLogic = api;
})(typeof window !== 'undefined' ? window : null);
