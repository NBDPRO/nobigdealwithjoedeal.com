/**
 * Daily Success accessibility rules (pure, no DOM). a11y-ui.js applies them to the page; the Workout Coach reads
 * restSay() for its rest-timer announcements. tests/a11y-audit-2026-10-23.test.js pins every function here.
 *
 * Keep this file free of document/window so the same rules can be tested in node.
 */
(function (root) {
  'use strict';

  /** "1:05" for a number of seconds (never negative). */
  function fmtRest(left) {
    const s = Math.max(0, Math.round(Number(left) || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  /**
   * What the rest timer should SAY right now, so a screen reader hears three things per rest and not a tick a second:
   * the start ("Rest 1:30"), the last ten seconds, and the end. said = the last milestone already spoken
   * ('' | 'start' | 'ten' | 'done'); returns { say, said }. say === '' means stay quiet.
   */
  function restSay(left, said) {
    const l = Math.round(Number(left) || 0);
    if (l <= 0) return said === 'done' ? { say: '', said } : { say: 'Rest over. Go.', said: 'done' };
    if (l <= 10) return said === 'ten' || said === 'done' ? { say: '', said } : { say: '10 seconds left', said: 'ten' };
    if (!said) return { say: 'Rest ' + fmtRest(l), said: 'start' };
    return { say: '', said };
  }

  /** The visible text has no letter or digit in it, so a screen reader would read an emoji name or nothing. */
  function glyphOnly(text) {
    const t = String(text == null ? '' : text).trim();
    return !/[A-Za-z0-9]/.test(t);
  }

  /**
   * The accessible name to give a control that has none. An icon-only button takes its title; a bare text box takes its
   * placeholder (never the other way round: a visible label always wins, so this is only asked when there is none).
   * info = { tag, title, placeholder, text }. Returns '' when nothing sensible exists.
   */
  function nameFor(info) {
    const i = info || {};
    const tag = String(i.tag || '').toLowerCase();
    const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return clean(i.placeholder) || clean(i.title);
    if (glyphOnly(i.text)) return clean(i.title);
    return '';
  }

  /** A name for a day-page field that has no placeholder, from its data-k: "l-p2" -> "Priority 2", "l-g1" -> "Gratitude 1". '' if unknown. */
  function humanKey(k) {
    const m = /^l-([pg])([1-9])$/.exec(String(k || ''));
    return m ? (m[1] === 'p' ? 'Priority ' : 'Gratitude ') + m[2] : '';
  }

  /** aria-expanded / aria-controls for an accordion header. collapsed = the card has the .collapsed class. */
  function sectionAria(collapsed, bodyId) {
    const o = { 'aria-expanded': collapsed ? 'false' : 'true' };
    if (bodyId) o['aria-controls'] = bodyId;
    return o;
  }

  /** The next focus index inside a trapped dialog: Tab wraps last -> first, Shift+Tab first -> last. */
  function trapTab(count, index, shift) {
    if (!count || count < 1) return -1;
    if (index < 0 || index >= count) return shift ? count - 1 : 0;
    return shift ? (index - 1 + count) % count : (index + 1) % count;
  }

  /**
   * Arrow-key roving for a row of tabs/chips: returns the index to focus, or -1 for a key that is not ours.
   */
  function rove(key, index, count) {
    if (!count || count < 1) return -1;
    if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count;
    if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return -1;
  }

  /**
   * A CSS selector that finds "the same button" after the screen was redrawn: its data-* attributes, e.g.
   * { coachAction: 'done', i: '2', s: '0' } -> [data-coach-action="done"][data-i="2"][data-s="0"]. '' when there are none.
   */
  function focusSelector(tag, dataset) {
    const keys = Object.keys(dataset || {});
    if (!keys.length) return '';
    const kebab = (k) => 'data-' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return String(tag || '').toLowerCase() + keys.map((k) => '[' + kebab(k) + '="' + esc(dataset[k]) + '"]').join('');
  }

  /** 'auto' when the phone asks for reduced motion, else 'smooth'. win is passed in so node can test it. */
  function scrollBehavior(win) {
    const w = win || (typeof window !== 'undefined' ? window : null);
    try { if (w && w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'auto'; } catch (_) { /* ignore */ }
    return 'smooth';
  }

  const api = { humanKey, scrollBehavior, fmtRest, restSay, glyphOnly, nameFor, sectionAria, trapTab, rove, focusSelector };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDA11yLogic = api;
})(typeof window !== 'undefined' ? window : null);
