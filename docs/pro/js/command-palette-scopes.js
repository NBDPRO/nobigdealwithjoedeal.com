/**
 * command-palette-scopes.js — window.NBDCommandX: the Command palette 2.0
 * layer (CRM style integration C4, Grok idea #07, Jo-approved 2026-10-11).
 * Loaded on demand by command-palette.js the first time the palette opens
 * (no boot script), and Node-testable through module.exports.
 *
 * What it adds on top of the Cmd+K palette:
 *   - scope prefixes: @ people, # jobs, > actions, t: themes, = math;
 *   - actions for a SELECTED lead (Tab on a lead row pins it; the customer
 *     page pins its own) through a lead-action registry
 *     {id, label, icon, keywords, when(lead), run(lead)};
 *   - themes from ThemeEngine.getAll(), with a live preview while a theme row
 *     is highlighted (ThemeEngine.previewCSS) and Enter to apply; locked
 *     themes say what unlocks them and open the Trophy Case when it exists;
 *   - usage-count ranking (per device) so the actions you use float up;
 *   - `=` math: a SAFE expression parser — a hand-written tokenizer + recursive
 *     descent over numbers, units and + - * / ^ ( ) %. It never calls eval or
 *     Function. Roofing units: sq (100 sqft), sqft, lf, and $; "32.4 sq x
 *     $485" is $15,714. Money is held in cents and rounded once, at the end.
 *
 * Everything here is draft-only: the lead actions open the CRM's own
 * openers (card, edit, task, portal-link composers); nothing sends.
 *
 * Strict CSP: no inline handlers; markup is built with classes (css/
 * command-palette-scopes.css), not style attributes.
 */
(function (root) {
  'use strict';

  var USAGE_KEY = 'nbd_cmd_usage_v1';
  var USAGE_MAX = 150;
  var THEME_ROWS = 40;

  // ── PURE: scope prefixes ─────────────────────────────────────────────
  var SCOPES = [
    { key: 'people', prefix: '@', hint: 'people' },
    { key: 'jobs', prefix: '#', hint: 'jobs' },
    { key: 'actions', prefix: '>', hint: 'actions' },
    { key: 'themes', prefix: 't:', hint: 'themes' },
    { key: 'math', prefix: '=', hint: 'math' }
  ];

  /** "@maya" -> {scope:'people', q:'maya'}; no prefix -> {scope:'all'}. */
  function parseScope(raw) {
    var s = String(raw == null ? '' : raw).replace(/^\s+/, '');
    if (s.charAt(0) === '@') return { scope: 'people', q: s.slice(1).trim() };
    if (s.charAt(0) === '#') return { scope: 'jobs', q: s.slice(1).trim() };
    if (s.charAt(0) === '>') return { scope: 'actions', q: s.slice(1).trim() };
    if (s.charAt(0) === '=') return { scope: 'math', q: s.slice(1).trim() };
    var m = /^(?:t|theme|themes)\s*:\s*/i.exec(s);
    if (m) return { scope: 'themes', q: s.slice(m[0].length).trim() };
    return { scope: 'all', q: s.trim() };
  }

  // ── PURE: the safe expression parser ─────────────────────────────────
  var MAX_LEN = 120, MAX_TOKENS = 60, MAX_DEPTH = 16;
  var AREA = ['sq', 'sqft', 'lf'];

  function dimsZero() { return { usd: 0, sq: 0, sqft: 0, lf: 0 }; }
  function dimsIsScalar(d) { return !d.usd && !d.sq && !d.sqft && !d.lf; }
  function dimsEq(a, b) { return a.usd === b.usd && a.sq === b.sq && a.sqft === b.sqft && a.lf === b.lf; }
  function dimsAdd(a, b, sign) {
    return { usd: a.usd + sign * b.usd, sq: a.sq + sign * b.sq, sqft: a.sqft + sign * b.sqft, lf: a.lf + sign * b.lf };
  }
  function val(v, d, pct) { return { v: v, d: d || dimsZero(), pct: !!pct }; }

  function MathError(msg) { this.message = msg; }

  var UNIT_WORDS = {
    sq: 'sq', sqs: 'sq', square: 'sq', squares: 'sq',
    sqft: 'sqft', sf: 'sqft', ft2: 'sqft',
    lf: 'lf', ft: 'lf', feet: 'lf', foot: 'lf'
  };

  function tokenize(src) {
    var s = String(src).toLowerCase();
    if (s.length > MAX_LEN) throw new MathError('That is a long one. Keep it under ' + MAX_LEN + ' characters.');
    var toks = [], i = 0;
    while (i < s.length) {
      var c = s.charAt(i);
      if (/\s/.test(c)) { i++; continue; }
      var m;
      if ((m = /^(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)/.exec(s.slice(i)))) {
        var n = parseFloat(m[1].replace(/,/g, ''));
        i += m[1].length;
        // "15k" = 15,000 (only when the k is not the start of a longer word)
        if (s.charAt(i) === 'k' && !/[a-z]/.test(s.charAt(i + 1))) { n *= 1000; i++; }
        toks.push({ t: 'num', v: n });
      } else if (c === '$') { toks.push({ t: 'usd' }); i++; }
      else if ('+-*/^()%'.indexOf(c) !== -1) { toks.push({ t: c }); i++; }
      else if (c === '×') { toks.push({ t: '*' }); i++; }
      else if (c === '÷') { toks.push({ t: '/' }); i++; }
      else if ((m = /^[a-z]+/.exec(s.slice(i)))) {
        var w = m[0]; i += w.length;
        if (w === 'x') toks.push({ t: '*' });
        else if (w === 'per') toks.push({ t: '/' });
        else if (w === 'in' || w === 'to') toks.push({ t: 'conv' });
        else if (Object.prototype.hasOwnProperty.call(UNIT_WORDS, w)) toks.push({ t: 'unit', u: UNIT_WORDS[w] });
        else throw new MathError('I do not know "' + w + '". Units: sq, sqft, lf, $.');
      } else {
        throw new MathError('Unexpected "' + c + '".');
      }
      if (toks.length > MAX_TOKENS) throw new MathError('Too many parts in that one.');
    }
    // "sq ft" is two words for one unit
    for (var k = 0; k < toks.length - 1; k++) {
      if (toks[k].t === 'unit' && toks[k].u === 'sq' && toks[k + 1].t === 'unit' && toks[k + 1].u === 'lf') {
        toks.splice(k, 2, { t: 'unit', u: 'sqft' });
      }
    }
    return toks;
  }

  function unitDims(u) { var d = dimsZero(); d[u] = 1; return d; }

  function mul(a, b) {
    var d = dimsAdd(a.d, b.d, 1);
    // squares x $485 reads as $485 PER square: a bare $ times an area/length is a rate
    if (d.usd > 0 && (d.sq > 0 || d.sqft > 0 || d.lf > 0)) { d.sq = 0; d.sqft = 0; d.lf = 0; }
    return val(a.v * b.v, d);
  }
  function div(a, b) {
    if (b.v === 0) throw new MathError('Cannot divide by zero.');
    return val(a.v / b.v, dimsAdd(a.d, b.d, -1));
  }

  function parseExpr(toks) {
    var pos = 0, depth = 0;
    function peek() { return toks[pos]; }
    function take() { return toks[pos++]; }

    function primary() {
      var t = take();
      if (!t) throw new MathError('That ended early.');
      if (t.t === '(') {
        if (++depth > MAX_DEPTH) throw new MathError('Too many brackets.');
        var inner = additive();
        var close = take();
        if (!close || close.t !== ')') throw new MathError('Missing ")".');
        depth--;
        // "(32.4 + 8) sq": a unit right after a bracketed plain number
        var after = peek();
        if (after && after.t === 'unit' && dimsIsScalar(inner.d) && !inner.pct) {
          take();
          return val(inner.v, unitDims(after.u));
        }
        return inner;
      }
      var isUsd = false;
      if (t.t === 'usd') { isUsd = true; t = take(); }
      if (t && t.t === 'num') {
        var out = isUsd ? val(Math.round(t.v * 100), { usd: 1, sq: 0, sqft: 0, lf: 0 }) : val(t.v);
        var nx = peek();
        // "$485/sq" and "$485 per sq": a rate binds tighter than the x before it
        if (isUsd && nx && nx.t === '/' && toks[pos + 1] && toks[pos + 1].t === 'unit') {
          take();
          out.d = dimsAdd(out.d, unitDims(take().u), -1);
          return out;
        }
        if (nx && nx.t === 'unit') {
          take();
          if (isUsd) {
            // "$485 sq" is unusual; read it as a rate
            out.d = dimsAdd(out.d, unitDims(nx.u), -1);
          } else {
            out.d = unitDims(nx.u);
          }
        }
        return out;
      }
      if (t && t.t === 'unit' && !isUsd) return val(1, unitDims(t.u));   // the "sq" in "$485 / sq"
      if (isUsd && (!t || t.t !== 'num')) throw new MathError('A $ needs an amount.');
      throw new MathError('Unexpected ' + (t ? '"' + (t.t === 'conv' ? 'in' : t.t) + '"' : 'end') + '.');
    }

    function unary() {
      var t = peek();
      if (t && t.t === '-') { take(); var u = unary(); return val(-u.v, u.d, u.pct); }
      if (t && t.t === '+') { take(); return unary(); }
      var p = primary();
      var nx = peek();
      if (nx && nx.t === '%') {
        take();
        if (!dimsIsScalar(p.d)) throw new MathError('A percent needs a plain number.');
        return val(p.v / 100, dimsZero(), true);
      }
      return p;
    }

    function power() {
      var base = unary();
      var nx = peek();
      if (nx && nx.t === '^') {
        take();
        var ex = power();
        if (!dimsIsScalar(ex.d)) throw new MathError('An exponent must be a plain number.');
        if (!dimsIsScalar(base.d)) throw new MathError('Powers are for plain numbers.');
        var r = Math.pow(base.v, ex.v);
        if (!isFinite(r)) throw new MathError('That is too big.');
        return val(r);
      }
      return base;
    }

    function multiplicative() {
      var left = power();
      for (;;) {
        var nx = peek();
        if (nx && nx.t === '*') { take(); left = mul(left, power()); }
        else if (nx && nx.t === '/') { take(); left = div(left, power()); }
        else break;
      }
      return left;
    }

    function additive() {
      var left = multiplicative();
      for (;;) {
        var nx = peek();
        if (!nx || (nx.t !== '+' && nx.t !== '-')) break;
        take();
        var right = multiplicative();
        var sign = nx.t === '+' ? 1 : -1;
        // "$15,000 + 10%" = $15,000 plus 10% of it
        if (right.pct && !left.pct) right = val(left.v * right.v, left.d);
        if (!dimsEq(left.d, right.d)) throw new MathError('Cannot add or subtract different units.');
        left = val(left.v + sign * right.v, left.d, left.pct && right.pct);
      }
      return left;
    }

    var result = additive();
    var tail = peek();
    if (tail && tail.t === 'conv') {
      take();
      var u = take();
      if (!u || u.t !== 'unit') throw new MathError('Convert to sq, sqft or lf.');
      result = convert(result, u.u);
      tail = peek();
    }
    if (tail) throw new MathError('I could not read the end of that.');
    return result;
  }

  function convert(r, to) {
    var from = null;
    AREA.forEach(function (a) { if (r.d[a] === 1) from = a; });
    var single = from && r.d.usd === 0 && AREA.every(function (a) { return a === from ? r.d[a] === 1 : r.d[a] === 0; });
    if (!single) throw new MathError('Only plain areas convert (sq <-> sqft).');
    if (from === to) return r;
    if (from === 'sqft' && to === 'sq') return val(r.v / 100, unitDims('sq'));
    if (from === 'sq' && to === 'sqft') return val(r.v * 100, unitDims('sqft'));
    throw new MathError('Cannot convert ' + from + ' to ' + to + '.');
  }

  function trimNum(n, maxDp) {
    var s = (Math.round(n * Math.pow(10, maxDp)) / Math.pow(10, maxDp)).toString();
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }
  function fmtUsd(cents) {
    var c = Math.round(cents);
    var neg = c < 0; c = Math.abs(c);
    var dollars = Math.floor(c / 100), rem = c % 100;
    var s = '$' + String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (rem ? '.' + (rem < 10 ? '0' : '') + rem : '');
    return neg ? '-' + s : s;
  }

  function format(r) {
    var d = r.d;
    if (dimsIsScalar(d)) return r.pct ? trimNum(r.v * 100, 4) + '%' : trimNum(r.v, 4);
    if (d.usd === 1 && !d.sq && !d.sqft && !d.lf) return fmtUsd(r.v);
    if (d.usd === 1) {
      var per = AREA.filter(function (a) { return d[a] === -1; })[0];
      if (per && AREA.every(function (a) { return a === per || d[a] === 0; })) return fmtUsd(r.v) + '/' + per;
    }
    if (!d.usd) {
      var one = AREA.filter(function (a) { return d[a] === 1; })[0];
      if (one && AREA.every(function (a) { return a === one || d[a] === 0; })) return trimNum(r.v, 3) + ' ' + one;
    }
    throw new MathError('Those units do not combine into something I can show.');
  }

  /** => {ok:true, text, value} | {ok:false, error}. Never throws, never evals. */
  function evalMath(src) {
    var s = String(src == null ? '' : src).trim();
    if (!s) return { ok: false, error: 'Type a calculation, like 32.4 sq x $485.' };
    try {
      var r = parseExpr(tokenize(s));
      if (!isFinite(r.v)) throw new MathError('That is too big.');
      return { ok: true, text: format(r), value: r.v, dims: r.d };
    } catch (e) {
      if (e instanceof MathError) return { ok: false, error: e.message };
      return { ok: false, error: 'I could not work that out.' };
    }
  }

  /** In the plain (no prefix) scope, treat input as math only when it clearly is. */
  function looksLikeMath(raw) {
    var s = String(raw || '').trim();
    if (!/^[\d$(.]/.test(s)) return false;
    if (/^\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}$/.test(s)) return false;     // a phone number
    return /[$*×]|\bx\b|\b(sq|sqft|lf|squares?)\b/i.test(s) && /\d/.test(s);
  }

  // ── PURE: usage ranking ──────────────────────────────────────────────
  function usageBoostFor(count) {
    var n = Number(count) || 0;
    return Math.min(20, n * 3);
  }
  function prunedUsage(map) {
    var ids = Object.keys(map);
    if (ids.length <= USAGE_MAX) return map;
    ids.sort(function (a, b) { return map[b] - map[a]; });
    var out = {};
    ids.slice(0, USAGE_MAX - 30).forEach(function (id) { out[id] = map[id]; });
    return out;
  }
  function topUsed(map, n, exclude) {
    var skip = {};
    (exclude || []).forEach(function (x) { skip[x] = true; });
    return Object.keys(map || {}).filter(function (id) { return !skip[id] && map[id] > 0; })
      .sort(function (a, b) { return map[b] - map[a]; }).slice(0, n);
  }

  // ── PURE: themes ─────────────────────────────────────────────────────
  function themeRows(all, q, opts) {
    var o = opts || {};
    var query = String(q || '').toLowerCase().trim();
    var rows = [];
    Object.keys(all || {}).forEach(function (key) {
      var t = all[key];
      if (!t) return;
      var name = String(t.name || key);
      var hay = (name + ' ' + key + ' ' + (t.category || '')).toLowerCase();
      var score = 0;
      if (!query) score = 1;
      else if (name.toLowerCase().indexOf(query) === 0) score = 100;
      else if (name.toLowerCase().indexOf(query) !== -1) score = 70;
      else if (hay.indexOf(query) !== -1) score = 40;
      else {
        var toks = query.split(/\s+/).filter(Boolean);
        if (toks.length && toks.every(function (tk) { return hay.indexOf(tk) !== -1; })) score = 30;
      }
      if (!score) return;
      var locked = !!t.locked && !(typeof o.isUnlocked === 'function' ? o.isUnlocked(key) : false);
      rows.push({
        key: key, name: name, category: t.category || '', mode: t.mode || '',
        locked: locked, condition: t.unlockCondition || '', current: key === o.current, score: score
      });
    });
    rows.sort(function (a, b) {
      if (a.current !== b.current) return a.current ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      if (a.locked !== b.locked) return a.locked ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    return rows.slice(0, o.limit || THEME_ROWS);
  }

  // ── DOM side ─────────────────────────────────────────────────────────
  var doc = root.document;
  var X = {
    ctxLead: null,
    usage: null,
    previewKey: null,
    previewTimer: 0,
    leadActions: new Map(),
    cssAdded: false
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function leadName(l) {
    return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || 'This customer';
  }

  function loadUsage() {
    if (X.usage) return X.usage;
    var m = {};
    try {
      var raw = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        Object.keys(raw).forEach(function (k) { var n = Number(raw[k]); if (n > 0 && isFinite(n)) m[k] = n; });
      }
    } catch (_) {}
    X.usage = m;
    return m;
  }
  function bump(id) {
    if (!id) return;
    var m = loadUsage();
    m[id] = (m[id] || 0) + 1;
    X.usage = prunedUsage(m);
    try { localStorage.setItem(USAGE_KEY, JSON.stringify(X.usage)); } catch (_) {}
  }

  function ensureCss() {
    if (!doc || X.cssAdded) return;
    X.cssAdded = true;
    var l = doc.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/pro/css/command-palette-scopes.css?v=1';
    doc.head.appendChild(l);
  }

  // ── lead actions (the registry) ──────────────────────────────────────
  function copy(text, label) {
    var done = function (okc) {
      if (typeof root.showToast === 'function') root.showToast(okc ? label + ' copied' : 'Could not copy', okc ? 'success' : 'error');
    };
    try {
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
        root.navigator.clipboard.writeText(String(text)).then(function () { done(true); }, function () { done(false); });
        return;
      }
    } catch (_) {}
    done(false);
  }
  function digits(s) { return String(s || '').replace(/\D+/g, ''); }

  var BUILTIN_LEAD_ACTIONS = [
    { id: 'lead-view', label: 'View details', icon: '👁', keywords: 'open card customer',
      run: function (l) { var f = root.openCardDetailModal || root.openLeadDetail; if (typeof f === 'function') f(l.id); else root.location.href = '/pro/customer.html?id=' + encodeURIComponent(l.id); } },
    { id: 'lead-edit', label: 'Edit lead', icon: '✏️', keywords: 'change update', when: function () { return typeof root.editLead === 'function'; },
      run: function (l) { root.editLead(l.id); } },
    { id: 'lead-task', label: 'Add task', icon: '✓', keywords: 'todo reminder follow up', when: function () { return typeof root.openTaskModal === 'function'; },
      run: function (l) { root.openTaskModal(l.id, null); } },
    { id: 'lead-call', label: 'Call', icon: '📞', keywords: 'phone dial', when: function (l) { return !!digits(l.phone); },
      run: function (l) { root.location.href = 'tel:' + digits(l.phone); } },
    { id: 'lead-copy-phone', label: 'Copy phone', icon: '📋', keywords: 'number', when: function (l) { return !!l.phone; },
      run: function (l) { copy(l.phone, 'Phone'); } },
    { id: 'lead-copy-address', label: 'Copy address', icon: '📋', keywords: 'street', when: function (l) { return !!l.address; },
      run: function (l) { copy(l.address, 'Address'); } },
    { id: 'lead-maps', label: 'Open in Maps', icon: '🗺', keywords: 'directions navigate', when: function (l) { return !!l.address; },
      run: function (l) { root.open('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(l.address), '_blank', 'noopener'); } },
    { id: 'lead-portal-copy', label: 'Copy portal link', icon: '🔗', keywords: 'share customer page', when: function () { return !!root.PortalLinkHelpers; },
      run: function (l) { root.PortalLinkHelpers.copyForLead(l); } },
    { id: 'lead-portal-text', label: 'Text portal link (opens your message app)', icon: '💬', keywords: 'sms share', when: function (l) { return !!(root.PortalLinkHelpers && l.phone); },
      run: function (l) { root.PortalLinkHelpers.smsForLead(l); } },
    { id: 'lead-portal-email', label: 'Email portal link (opens your mail app)', icon: '📧', keywords: 'share', when: function (l) { return !!(root.PortalLinkHelpers && l.email); },
      run: function (l) { root.PortalLinkHelpers.emailForLead(l); } }
  ];

  function registerLeadAction(a) {
    if (!a || typeof a.id !== 'string' || typeof a.run !== 'function') return;
    X.leadActions.set(a.id, {
      id: a.id, label: String(a.label || a.id), icon: a.icon || '•', keywords: a.keywords || '',
      when: typeof a.when === 'function' ? a.when : null, run: a.run
    });
  }
  function allLeadActions() {
    var arr = BUILTIN_LEAD_ACTIONS.slice();
    X.leadActions.forEach(function (a) { arr.push(a); });
    return arr;
  }

  // ── result builders ──────────────────────────────────────────────────
  function mathRow(raw) {
    var r = evalMath(raw);
    if (!r.ok) {
      return { id: 'math:err', xrow: 'math', group: 'Math', label: r.error, icon: '🧮', error: true, run: function () {} };
    }
    return {
      id: 'math:result', xrow: 'math', group: 'Math', icon: '🧮', label: r.text,
      sublabel: String(raw).trim() + '  ·  Enter copies', copyText: r.text,
      run: function () { copy(r.text, r.text); }
    };
  }

  function themeItem(t) {
    return {
      id: 'theme:' + t.key, xrow: 'theme', group: 'Themes', icon: '🎨', label: t.name,
      sublabel: (t.category ? t.category : '') + (t.mode ? ' · ' + t.mode : '') + (t.locked ? ' · locked' + (t.condition ? ': ' + t.condition : '') : ''),
      themeKey: t.key, locked: t.locked, current: t.current,
      run: function () {
        var TE = root.ThemeEngine;
        if (t.locked) {
          if (root.NBDTrophyCase && typeof root.NBDTrophyCase.open === 'function') root.NBDTrophyCase.open();
          else if (typeof root.showToast === 'function') root.showToast(t.name + ' is locked' + (t.condition ? ': ' + t.condition : ''), 'info');
          return;
        }
        if (TE && typeof TE.apply === 'function') TE.apply(t.key);
      }
    };
  }

  function ensureThemes(rerender) {
    if (root.ThemeEngine && typeof root.ThemeEngine.getAll === 'function') return true;
    if (root.ScriptLoader && typeof root.ScriptLoader.loadBundle === 'function' && !ensureThemes._asked) {
      ensureThemes._asked = true;
      Promise.resolve(root.ScriptLoader.loadBundle('theme')).then(function () { if (rerender) rerender(); }).catch(function () {});
    }
    return false;
  }

  function themeResults(q, rerender) {
    if (!ensureThemes(rerender)) {
      return [{ id: 'themes:loading', xrow: 'note', group: 'Themes', icon: '⏳', label: 'Loading themes…', run: function () {} }];
    }
    var TE = root.ThemeEngine;
    var rows = themeRows(TE.getAll(), q, {
      current: typeof TE.getCurrent === 'function' ? TE.getCurrent() : null,
      isUnlocked: function (k) { return typeof TE.isUnlocked === 'function' ? TE.isUnlocked(k) : true; }
    });
    if (!rows.length) return [{ id: 'themes:none', xrow: 'note', group: 'Themes', icon: '🎨', label: 'No theme matches “' + q + '”.', run: function () {} }];
    return rows.map(themeItem);
  }

  function leadActionResults(lead, q, score) {
    var out = [];
    allLeadActions().forEach(function (a) {
      try { if (a.when && !a.when(lead)) return; } catch (_) { return; }
      var s = score(q, a.label, a.keywords);
      if (s <= 0) return;
      out.push({
        id: 'leadact:' + a.id, label: a.label, icon: a.icon, group: 'Actions for ' + leadName(lead),
        score: s + usageBoostFor(loadUsage()['leadact:' + a.id]), run: function () { a.run(lead); }
      });
    });
    out.sort(function (x, y) { return y.score - x.score; });
    return out;
  }

  var JOB_RE = /^(job_created|permit_pulled|materials_ordered|materials_delivered|crew_scheduled|install_in_progress|install_complete|final_photos|deductible_collected|final_payment|collections|closed|contract_signed)$/;
  function isJobLead(l) {
    var sk = l._stageKey || (typeof root.normalizeStage === 'function' ? root.normalizeStage(l.stage || '') : l.stage) || '';
    if (typeof root.isJobStage === 'function') { try { return !!root.isJobStage(sk); } catch (_) {} }
    return JOB_RE.test(sk);
  }

  /**
   * Scoped results, or null to let the palette build its normal mixed list.
   * ctx: { buildLeadResults(q, pool), score(q,label,kw), allActions(), rerender() }
   */
  function compute(raw, ctx) {
    ensureCss();
    var ps = parseScope(raw);
    var q = ps.q;

    if (ps.scope === 'math') return [mathRow(q)];

    if (ps.scope === 'themes') return themeResults(q, ctx.rerender);

    if (ps.scope === 'people') return ctx.buildLeadResults(q);

    if (ps.scope === 'jobs') {
      var pool = (Array.isArray(root._leads) ? root._leads : []).filter(function (l) { return l && !l.deleted && isJobLead(l); });
      return ctx.buildLeadResults(q, pool);
    }

    if (ps.scope === 'actions') {
      var out = [];
      if (X.ctxLead) out = out.concat(leadActionResults(X.ctxLead, q, ctx.score));
      var m = loadUsage();
      var globals = ctx.allActions().map(function (a) {
        var s = ctx.score(q, a.label, a.keywords);
        return s > 0 ? Object.assign({}, a, { group: a.group || 'Actions', score: s + usageBoostFor(m[a.id]) }) : null;
      }).filter(Boolean).sort(function (a, b) { return b.score - a.score; });
      return out.concat(globals.slice(0, 20));
    }

    // plain scope
    if (X.ctxLead) {
      var la = leadActionResults(X.ctxLead, q, ctx.score);
      if (la.length) return la;
    }
    // Otherwise the palette builds its normal mixed list and augment() adds a
    // math answer (when the input is clearly a calculation) and theme matches.
    return null;
  }

  /** Extra rows for the plain scope: a math answer first, up to 3 theme matches last. */
  function augment(results, raw, ctx) {
    var out = results.slice();
    if (!X.ctxLead && looksLikeMath(raw) && evalMath(raw).ok) out.unshift(mathRow(raw));
    var q = parseScope(raw).q;
    if (q.length >= 2 && root.ThemeEngine && typeof root.ThemeEngine.getAll === 'function') {
      var TE = root.ThemeEngine;
      var rows = themeRows(TE.getAll(), q, {
        current: typeof TE.getCurrent === 'function' ? TE.getCurrent() : null,
        isUnlocked: function (k) { return typeof TE.isUnlocked === 'function' ? TE.isUnlocked(k) : true; },
        limit: 3
      }).filter(function (r) { return r.score >= 70; });
      rows.forEach(function (r) { out.push(themeItem(r)); });
    }
    return out;
  }

  // ── row markup ───────────────────────────────────────────────────────
  var HEX = /^#[0-9a-f]{3,8}$/i;
  function swatchSpan(c) {
    var v = String(c || '');
    return '<i class="cmdx-sw"' + (HEX.test(v) || /^rgba?\([\d\s.,%]+\)$/i.test(v) ? ' data-sw="' + esc(v) + '"' : '') + '></i>';
  }
  function rowHtml(item, idx) {
    if (item.xrow === 'theme') {
      var c = null;
      try { c = root.ThemeEngine && root.ThemeEngine.previewResolvedColors(item.themeKey); } catch (_) {}
      var sw = c ? '<span class="cmdx-sws" aria-hidden="true">' + swatchSpan(c.bg) + swatchSpan(c.surface) + swatchSpan(c.accent) + swatchSpan(c.text) + '</span>' : '';
      return '<div class="nbd-cmd-row cmdx-row" data-idx="' + idx + '">' +
        '<span class="cmdx-ico">' + (item.locked ? '🔒' : esc(item.icon)) + '</span>' +
        '<div class="cmdx-main"><div class="cmdx-label">' + esc(item.label) + (item.current ? ' <span class="cmdx-tag">current</span>' : '') + '</div>' +
        (item.sublabel ? '<div class="cmdx-sub">' + esc(item.sublabel) + '</div>' : '') + '</div>' + sw + '</div>';
    }
    if (item.xrow === 'math') {
      return '<div class="nbd-cmd-row cmdx-row cmdx-math' + (item.error ? ' cmdx-err' : '') + '" data-idx="' + idx + '">' +
        '<span class="cmdx-ico">' + esc(item.icon) + '</span>' +
        '<div class="cmdx-main"><div class="cmdx-label cmdx-big">' + (item.error ? '' : '= ') + esc(item.label) + '</div>' +
        (item.sublabel ? '<div class="cmdx-sub">' + esc(item.sublabel) + '</div>' : '') + '</div></div>';
    }
    return '<div class="nbd-cmd-row cmdx-row" data-idx="' + idx + '"><span class="cmdx-ico">' + esc(item.icon) + '</span>' +
      '<div class="cmdx-main"><div class="cmdx-label">' + esc(item.label) + '</div></div></div>';
  }

  /** After the palette paints rows: set swatch colours (custom property, no style attribute). */
  function afterRender(listEl) {
    if (!listEl) return;
    listEl.querySelectorAll('[data-sw]').forEach(function (n) { n.style.setProperty('--cmdx-sw', n.getAttribute('data-sw')); });
  }

  // ── preview while a theme row is highlighted ─────────────────────────
  function setPreview(key) {
    if (!doc) return;
    var TE = root.ThemeEngine;
    var tag = doc.getElementById('nbd-cmdx-preview');
    if (!key || !TE || typeof TE.previewCSS !== 'function') {
      if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
      doc.documentElement.removeAttribute('data-nbd-preview');
      X.previewKey = null;
      return;
    }
    if (X.previewKey === key) return;
    var css = '';
    try { css = String(TE.previewCSS(key) || ''); } catch (_) {}
    if (!css) return;
    // the engine scopes its block to :root[data-theme="key"]; rescope it to win over the active theme
    css = css.replace(/^\s*:root\[data-theme="[^"]*"\]/, ':root[data-nbd-preview][data-theme]');
    if (!tag) { tag = doc.createElement('style'); tag.id = 'nbd-cmdx-preview'; doc.head.appendChild(tag); }
    tag.textContent = css;
    doc.documentElement.setAttribute('data-nbd-preview', key);
    X.previewKey = key;
  }
  function onSelect(item) {
    clearTimeout(X.previewTimer);
    var key = item && item.xrow === 'theme' && !item.locked && !item.current ? item.themeKey : null;
    X.previewTimer = setTimeout(function () { setPreview(key); }, key ? 120 : 0);
  }

  // ── chip + hints + keys ──────────────────────────────────────────────
  function paintChrome(wrap) {
    if (!wrap) return;
    var bar = wrap.querySelector('.cmdx-bar');
    if (!bar) return;
    var html = '';
    if (X.ctxLead) {
      html += '<button type="button" class="cmdx-chip" data-cmdx-clear="1" title="Back to everything (Backspace on an empty box)">' +
        '👤 ' + esc(leadName(X.ctxLead)) + ' <span aria-hidden="true">✕</span></button>';
    }
    SCOPES.forEach(function (s) {
      html += '<button type="button" class="cmdx-hint" data-cmdx-prefix="' + esc(s.prefix) + '"><b>' + esc(s.prefix) + '</b> ' + esc(s.hint) + '</button>';
    });
    bar.innerHTML = html;
  }

  function decorate(wrap) {
    if (!wrap || wrap.querySelector('.cmdx-bar')) return;
    ensureCss();
    var input = wrap.querySelector('#nbd-cmd-input');
    if (input) input.setAttribute('placeholder', 'Search leads, actions, themes…');
    var bar = doc.createElement('div');
    bar.className = 'cmdx-bar';
    var head = input && input.parentNode;
    if (head && head.parentNode) head.parentNode.insertBefore(bar, head.nextSibling);
    paintChrome(wrap);
    wrap.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('[data-cmdx-prefix],[data-cmdx-clear]') : null;
      if (!t) return;
      var inp = wrap.querySelector('#nbd-cmd-input');
      if (t.hasAttribute('data-cmdx-clear')) { X.ctxLead = null; paintChrome(wrap); if (inp) { inp.value = ''; inp.dispatchEvent(new root.Event('input')); inp.focus(); } return; }
      if (inp) { inp.value = t.getAttribute('data-cmdx-prefix') + (t.getAttribute('data-cmdx-prefix') === 't:' ? ' ' : ''); inp.dispatchEvent(new root.Event('input')); inp.focus(); }
    });
  }

  function onOpen() {
    X.ctxLead = null;
    try {
      var cur = root._currentLead;
      if (cur && cur.id && (root._customerId === cur.id || /\/customer(\.html)?$/.test(root.location.pathname))) X.ctxLead = cur;
    } catch (_) {}
  }
  function onClose() { clearTimeout(X.previewTimer); setPreview(null); }

  /** Tab pins the highlighted lead; Backspace on an empty box un-pins. Returns true if handled. */
  function onKey(e, st) {
    if (!st) return false;
    var wrap = doc && doc.getElementById('nbd-cmd-modal');
    if (e.key === 'Tab' && !e.shiftKey) {
      var item = st.results[st.index];
      if (item && /^lead:/.test(String(item.id))) {
        var id = String(item.id).slice(5);
        var lead = (root._leads || []).filter(function (l) { return l && l.id === id; })[0];
        if (lead) {
          e.preventDefault();
          X.ctxLead = lead;
          st.input.value = '';
          paintChrome(wrap);
          st.rerender('');
          return true;
        }
      }
      return false;
    }
    if (e.key === 'Backspace' && X.ctxLead && st.input.value === '') {
      e.preventDefault();
      X.ctxLead = null;
      paintChrome(wrap);
      st.rerender('');
      return true;
    }
    return false;
  }

  var api = {
    __sentinel: 'nbd-cmdx-v1',
    parseScope: parseScope, evalMath: evalMath,
    compute: compute, augment: augment, rowHtml: rowHtml, afterRender: afterRender,
    decorate: decorate, onOpen: onOpen, onClose: onClose, onSelect: onSelect, onKey: onKey,
    usageBoost: function (id) { return usageBoostFor(loadUsage()[id]); },
    topUsed: function (n, exclude) { return topUsed(loadUsage(), n, exclude); },
    bump: bump,
    contextLead: function () { return X.ctxLead; },
    registerLeadAction: registerLeadAction,
    _pure: {
      tokenize: tokenize, looksLikeMath: looksLikeMath, usageBoostFor: usageBoostFor, prunedUsage: prunedUsage,
      topUsed: topUsed, themeRows: themeRows, fmtUsd: fmtUsd, SCOPES: SCOPES, BUILTIN_LEAD_ACTIONS: BUILTIN_LEAD_ACTIONS
    }
  };
  root.NBDCommandX = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
