/**
 * quickjump-logic.js — the pure half of "jump anywhere" (audit M6 / M7 and the ?go= links of Q1, 2026-11-09).
 *
 * One registry of places in Daily Success. It drives the ?go= / #go= deep links (the NBD OS widget and the Coach link to them), the Go
 * sheet's "Go to" list, and the section chip row under the Today bar. Also here: date words ("yesterday", "nov 7", "fri"), the field
 * labels, and the text search that lists hits newest day first. No DOM, no storage: quickjump-ui.js renders and opens things.
 */
(function (root) {
  'use strict';

  // id, label, group, keywords. `link` marks the ones a ?go= link may name.
  const DESTS = [
    { id: 'today', label: 'Today', group: 'go', link: true, keywords: ['day', 'now', 'page', 'open today'] },
    { id: 'floors', label: 'Floors', group: 'go', link: true, keywords: ['score', 'tick', 'habits', 'daily floors'] },
    { id: 'food', label: 'Food', group: 'go', link: true, keywords: ['diet', 'protein', 'calories', 'meal', 'macros', 'eat'] },
    { id: 'workout', label: 'Workout', group: 'go', link: true, keywords: ['train', 'coach', 'lift', 'gym', 'exercise', 'start'] },
    { id: 'weigh', label: 'Weigh-in', group: 'go', link: false, keywords: ['weight', 'body', 'scale'] },
    { id: 'wrap', label: 'Wrap up the day', group: 'go', link: true, keywords: ['wrap-up', 'evening', 'journal', 'end of day', 'reflect'] },
    { id: 'review', label: 'Sunday review', group: 'go', link: true, keywords: ['week', 'weekly', 'scorecard'] },
    { id: 'money', label: 'Money', group: 'go', link: true, keywords: ['revenue', 'budget', 'cash', 'expenses'] },
    { id: 'measure', label: 'Measurements', group: 'go', link: false, keywords: ['body', 'chest', 'waist', 'photos'] },
    { id: 'notebook', label: 'Notebook', group: 'go', link: false, keywords: ['pages', 'days', 'history', 'deleted'] },
    { id: 'data', label: 'Download my data', group: 'go', link: false, keywords: ['export', 'backup', 'csv'] },
    { id: 'appearance', label: 'Appearance', group: 'go', link: false, keywords: ['theme', 'font', 'colors', 'look'] },
    { id: 'customize', label: 'Customize', group: 'go', link: false, keywords: ['settings', 'goals', 'floors setup'] },
    { id: 'dash', label: 'Dashboard', group: 'go', link: true, keywords: ['dash', 'home', 'overview', 'stats'] },
    { id: 'crm', label: 'Back to the CRM', group: 'go', link: false, keywords: ['nbd pro', 'leads', 'dashboard'] },
  ];

  // The section chip row under the Today bar: label, and the selector that finds the section on the day page.
  const CHIPS = [
    { id: 'floors', label: 'Floors', sel: '#day-score-wrap' },
    { id: 'food', label: 'Food', sel: '.pc[data-sec="diet"]' },
    { id: 'train', label: 'Train', sel: '.pc[data-sec="fitness"]' },
    { id: 'body', label: 'Body', sel: '.pc[data-sec="pr"]' },
    { id: 'wins', label: 'Wins', sel: '.pc[data-sec="log"]' },
    { id: 'wrap', label: 'Wrap-up', sel: '.eod-wrap' },
    { id: 'habits', label: 'Habits', sel: '.pc[data-sec="habits"]' },
  ];

  const LINKS = DESTS.filter((d) => d.link).map((d) => d.id);

  /** The target a ?go= or #go= link names ('' when none, unknown, or junk). The router's own hashes (#dash, #day-1, #ov-coach) are not links. */
  function parseGo(search, hash) {
    const pick = (s, re) => { const m = re.exec(String(s || '')); return m ? m[1].toLowerCase() : ''; };
    const id = pick(search, /[?&]go=([A-Za-z-]{1,16})(?:&|#|$)/) || pick(hash, /^#?(?:.*&)?go=([A-Za-z-]{1,16})(?:&|$)/);
    return LINKS.indexOf(id) >= 0 ? id : '';
  }

  /** Go-to destinations matching what was typed: label starts, then label contains, then keywords. Empty -> all places. */
  function filterDests(q) {
    const n = String(q || '').trim().toLowerCase();
    const list = DESTS.filter((d) => d.group === 'go');
    if (!n) return list.slice();
    const score = (d) => {
      const lab = d.label.toLowerCase();
      if (lab.indexOf(n) === 0 || d.id.indexOf(n) === 0) return 0;
      if (lab.indexOf(n) > 0) return 1;
      if (d.keywords.some((k) => k.indexOf(n) === 0)) return 2;
      if (d.keywords.some((k) => k.indexOf(n) > -1)) return 3;
      return 9;
    };
    return list.map((d, i) => ({ d, s: score(d), i })).filter((x) => x.s < 9).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.d);
  }

  // ── dates ──────────────────────────────────────────────────────────────────────
  const pad = (n) => String(n).padStart(2, '0');
  const isDk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const fromDk = (dk) => { const [y, m, d] = dk.split('-').map(Number); return new Date(y, m - 1, d, 12); };
  const toDk = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const valid = (y, m, d) => { const t = new Date(y, m - 1, d, 12); return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d; };
  const nameIndex = (list, s) => { if (s.length < 3) return -1; return list.findIndex((n) => n.indexOf(s) === 0); };

  /** A date word -> 'YYYY-MM-DD', or null. today, yesterday, a weekday (its most recent day), "nov 7" / "november 7" / "11/7" (this year, or last when still ahead), 2026-11-07. */
  function dateWord(q, todayDk) {
    const s = String(q || '').trim().toLowerCase();
    if (!s || !isDk(todayDk)) return null;
    const today = fromDk(todayDk), ty = today.getFullYear();
    if (s === 'today') return todayDk;
    if (s === 'yesterday') return toDk(new Date(today.getTime() - 86400000));
    if (isDk(s)) { const [y, m, d] = s.split('-').map(Number); return valid(y, m, d) ? s : null; }
    const wd = nameIndex(WEEKDAYS, s);
    if (wd >= 0) { const back = (today.getDay() - wd + 7) % 7; return toDk(new Date(today.getTime() - back * 86400000)); }
    let m = null, d = null;
    let r = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(s);
    if (r) { const mi = nameIndex(MONTHS, r[1]); if (mi >= 0) { m = mi + 1; d = +r[2]; } }
    if (m == null) { r = /^(\d{1,2})\/(\d{1,2})$/.exec(s); if (r) { m = +r[1]; d = +r[2]; } }
    if (m == null || !valid(ty, m, d)) return null;
    const cand = new Date(ty, m - 1, d, 12);
    return toDk(cand.getTime() > today.getTime() ? new Date(ty - 1, m - 1, d, 12) : cand);
  }

  // ── field labels and text search ──────────────────────────────────────────────
  const LABELS = {
    'l-win': 'Win', 'l-les': 'Lesson', 'l-ov': 'Overall', 'l-en': 'Energy', 'l-fo': 'Focus',
    'ms-nonneg': 'Non-negotiable', 'ms-mantra': 'Mantra', 'reg-notes': 'Schedule notes', 'diet-notes': 'Diet notes',
    'fit-focus': 'Training focus', 'fit-pre': 'Pre-workout', 'fit-dur': 'Workout length', 'fit-notes': 'Workout notes', 'fit-int': 'Intensity', 'fit-rate': 'Rating', 'bm-notes': 'Body notes',
    'g-fin': 'Financial goal', 'g-pers': 'Personal goal', 'g-phys': 'Physical goal', 'g-sun': 'Sunday goal', 'g-vis': 'Vision', 'g-why': 'Why',
    'journal-intention': 'Intention', 'journal-note': 'Journal note', 's-territory': 'Territory', 's-weather': 'Weather',
  };
  function fieldLabel(key) {
    const k = String(key || '');
    if (LABELS[k]) return LABELS[k];
    const t = k.replace(/[-_]+/g, ' ').replace(/\s*\d+\s*/g, ' ').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Note';
  }
  // not words Jo typed: floor ticks, habit cells, macro numbers, stamps, the exercise-log mirror
  const SKIP = /^(floormet-|habit-|diet-m\d+-(p|c|f|cal)$|ex-\d|.*-stamp$|bm-(wt|bf|chest|waist|arms|legs)$|s-(doors|hours|revenue)$|pr-)/;

  /**
   * Text hits for q across the pages, newest day first (then the later entry). Each hit:
   *   { pi (index into pages), dk, key (the data-k field), label (field label), pageLabel, text (short preview around the match) }
   * Returns { hits (capped, default 20), total }. A query under two characters finds nothing.
   */
  function searchNotes(pages, q, opt) {
    const o = opt || {};
    const needle = String(q || '').trim().toLowerCase();
    if (needle.length < 2) return { hits: [], total: 0 };
    const cap = o.cap > 0 ? o.cap : 20;
    const all = [];
    (pages || []).forEach((p, pi) => {
      if (!p || !p.data) return;
      Object.keys(p.data).forEach((key) => {
        const v = p.data[key];
        if (typeof v !== 'string' || !v || SKIP.test(key)) return;
        const at = v.toLowerCase().indexOf(needle);
        if (at < 0) return;
        const from = Math.max(0, at - 24);
        const text = (from > 0 ? '…' : '') + v.slice(from, from + 80).replace(/\s+/g, ' ');
        all.push({ pi, dk: isDk(p.dk) ? p.dk : '', suf: Number(p.suf) || 1, key, label: fieldLabel(key), pageLabel: typeof o.label === 'function' ? o.label(p) : (p.name || p.dk || ''), text: text.length > 88 ? text.slice(0, 88) : text });
      });
    });
    all.sort((a, b) => (a.dk === b.dk ? b.suf - a.suf : a.dk < b.dk ? 1 : -1));
    return { hits: all.slice(0, cap), total: all.length };
  }

  const api = { DESTS, CHIPS, LINKS, parseGo, filterDests, dateWord, fieldLabel, searchNotes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDQuickJump = Object.assign(root.NBDQuickJump || {}, api);
})(typeof window !== 'undefined' ? window : null);
