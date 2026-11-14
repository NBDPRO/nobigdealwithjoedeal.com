/**
 * tests/lib/src-kit.js — shared helpers for suites that look at shipped files.
 *
 * Most suites in tests/ match a regex against a source file. That breaks on
 * harmless edits (a reflow, a renamed local) and, in the "must NOT contain"
 * direction, can pass when the code it guards was deleted. These helpers let a
 * suite ask a structural question (which tags, which attributes, which CSS
 * declarations) or run the code, instead of matching its spelling.
 * How to convert a suite: documentation/runbooks/CONVERT-SOURCE-PIN-SUITE.md.
 *
 *   read(rel)                 file text, CRLF folded to LF (checkout-independent)
 *   stripJsComments(src)      tests/lib/strip-js-comments.js (string-aware)
 *   stripCssComments(css)     drops CSS comments, keeps line count
 *   sliceFn(src, name)        one function's source, by brace matching
 *   parseTags(html)           tolerant tag/attribute parser with a tiny selector engine
 *   cssRules(css) / cssRule(css, selector, { media })   declarations, not text
 *   loadInVm(files, globals, opts)   run browser scripts in a vm context
 *   fakeClock(now)            a frozen Date plus hand-fired timers
 *   spy(impl)                 a function that records its calls
 *   suite(title)              the repo's usual ok() / section() / done() reporter
 *   makeDom, fire, click      re-exported from tests/lib/nbd-os-home-harness.js
 *
 * Zero deps (Node built-ins only). Tested by tests/src-kit-2026-11-14.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { stripJsComments } = require('./strip-js-comments');
const osHarness = require('./nbd-os-home-harness');

const ROOT = path.join(__dirname, '..', '..');
const lf = (s) => String(s).replace(/\r\n?/g, '\n');

/** A repo file as text with LF line ends, so a CRLF checkout reads the same. */
function read(rel) {
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error('src-kit read: no such file ' + rel);
  return lf(fs.readFileSync(abs, 'utf8'));
}
const exists = (rel) => fs.existsSync(path.isAbsolute(rel) ? rel : path.join(ROOT, rel));

/** Drop /* … *\/ comments from CSS, keeping newlines so line numbers hold. */
const stripCssComments = (css) => String(css).replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''));

// ── sliceFn ────────────────────────────────────────────────────────────────
/**
 * The source of one function, from its declaration to its closing brace.
 * Finds, in this order: `function name(`, `name = function`, `name: function`,
 * `name = (…) =>` / `name = async (…) =>`, and a method `name(…) {`. Brace
 * matching skips strings, template literals (with ${} nesting), comments and
 * regex literals, so a '}' inside a string does not end the function early.
 * CRLF input is folded to LF first. Returns null if the name is not found.
 */
function sliceFn(src, name) {
  const s = lf(src);
  const n = name.replace(/[$.*+?^()[\]{}|\\]/g, '\\$&');
  const heads = [
    new RegExp('(?:async\\s+)?\\bfunction\\s*\\*?\\s*' + n + '\\s*\\('),
    new RegExp('(?:^|[^\\w$.])(?:[\\w$]+\\.)*' + n + '\\s*=\\s*(?:async\\s+)?function\\b'),
    new RegExp('(?:^|[^\\w$])[\'"]?' + n + '[\'"]?\\s*:\\s*(?:async\\s+)?function\\b'),
    new RegExp('(?:^|[^\\w$.])(?:[\\w$]+\\.)*' + n + '\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[\\w$]+)\\s*=>\\s*\\{'),
    new RegExp('^[ \\t]*(?:async\\s+)?' + n + '\\s*\\([^)]*\\)\\s*\\{', 'm'),
  ];
  for (const re of heads) {
    const m = re.exec(s);
    if (!m) continue;
    const start = m.index + (m[0].length - m[0].replace(/^[^\w$'"]+/, '').length);
    // first '{' after the parameter list: skip the (…) so a default value `= {}` is not taken for the body
    let i = s.indexOf('(', start);
    const arrowOrBody = s.indexOf('{', start);
    if (i !== -1 && i < arrowOrBody) i = skipBalanced(s, i, '(', ')');
    const open = s.indexOf('{', i === -1 ? start : i);
    if (open === -1) return null;
    const close = matchBrace(s, open);
    return close === -1 ? null : s.slice(start, close + 1);
  }
  return null;
}

function skipBalanced(s, i, o, c) {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    j = skipLiteral(s, j);
    if (s[j] === o) d++;
    else if (s[j] === c && --d === 0) return j + 1;
  }
  return -1;
}

/** If s[j] starts a string/comment/regex, return the index of its last char; else j. */
function skipLiteral(s, j) {
  const c = s[j], d = s[j + 1];
  if (c === '/' && d === '/') { const e = s.indexOf('\n', j); return e === -1 ? s.length : e; }
  if (c === '/' && d === '*') { const e = s.indexOf('*/', j + 2); return e === -1 ? s.length : e + 1; }
  if (c === '"' || c === "'") {
    let k = j + 1;
    while (k < s.length && s[k] !== c && s[k] !== '\n') k += s[k] === '\\' ? 2 : 1;
    return k;
  }
  if (c === '`') return skipTemplate(s, j);
  if (c === '/' && regexAllowed(s, j)) {
    let k = j + 1, cls = false;
    while (k < s.length && s[k] !== '\n') {
      if (s[k] === '\\') { k += 2; continue; }
      if (s[k] === '[') cls = true; else if (s[k] === ']') cls = false;
      else if (s[k] === '/' && !cls) return k;
      k++;
    }
    return j; // not a regex after all (a lone '/'): treat as division
  }
  return j;
}
function skipTemplate(s, j) {
  let k = j + 1;
  while (k < s.length && s[k] !== '`') {
    if (s[k] === '\\') { k += 2; continue; }
    if (s[k] === '$' && s[k + 1] === '{') { const e = matchBrace(s, k + 1); if (e === -1) return s.length; k = e + 1; continue; }
    k++;
  }
  return k;
}
function regexAllowed(s, j) {
  let k = j - 1;
  while (k >= 0 && /\s/.test(s[k])) k--;
  if (k < 0) return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]/.test(s[k])) return true;
  const word = /([\w$]+)$/.exec(s.slice(Math.max(0, k - 10), k + 1));
  return !!word && /^(return|typeof|case|in|of|delete|void|throw|new|else|do)$/.test(word[1]);
}
/** Index of the '}' that closes the '{' at `open`, or -1. */
function matchBrace(s, open) {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    j = skipLiteral(s, j);
    const c = s[j];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  return -1;
}

// ── parseTags ──────────────────────────────────────────────────────────────
const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));
const RAW = new Set(['script', 'style', 'textarea', 'title']);
// an open <li> ends where the next <li> starts (and so on), as a browser does
const SELF_ENDING = new Set(['li', 'option', 'dt', 'dd', 'tr', 'td', 'th', 'p']);
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * Parse HTML (a whole page or a fragment) into elements. Tolerant: comments and
 * <!doctype> are skipped, attribute values may be "…", '…', bare or absent,
 * script/style bodies are not parsed as HTML, unclosed or stray end tags never
 * throw. Each element: { tag, attrs, line, start, end, parent, children, html,
 * text, classes, attr(k), has(k), $(sel), $$(sel) }. `start`/`end` are offsets
 * in the input, so `a.start < b.start` is document order; `html` is the source
 * between the open and close tags; `text` is that with tags removed.
 * The returned document has .all (every element in order), $(sel), $$(sel),
 * byId(id).
 */
function parseTags(html) {
  const src = lf(html);
  const lineAt = lineIndex(src);
  const root = mkEl('#document', {}, 0, null);
  root.end = src.length;
  const all = [];
  const stack = [root];
  const re = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+(?:[^\s"'>\/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?|\s*\/(?!>))*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) {
      const t = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === t) {
          while (stack.length > i) { const e = stack.pop(); e.innerEnd = m.index; e.end = m.index + m[0].length; }
          break;
        }
      }
      continue;
    }
    if (!m[2]) continue; // comment / doctype
    const tag = m[2].toLowerCase();
    const attrs = {};
    const ar = /([^\s"'>\/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
    let a;
    while ((a = ar.exec(m[3] || ''))) {
      const k = a[1].toLowerCase();
      if (k in attrs) continue; // the first one wins, as in a browser
      const v = a[2] === undefined ? '' : a[2].replace(/^(["'])([\s\S]*)\1$/, '$2');
      attrs[k] = unesc(v);
    }
    if (SELF_ENDING.has(tag) && stack.length > 1 && stack[stack.length - 1].tag === tag) { const e = stack.pop(); e.innerEnd = m.index; e.end = m.index; }
    const parent = stack[stack.length - 1];
    const el = mkEl(tag, attrs, m.index, parent);
    el.line = lineAt(m.index);
    el.openEnd = m.index + m[0].length;
    el.end = el.openEnd; el.innerEnd = el.openEnd;
    parent.children.push(el);
    all.push(el);
    if (VOID.has(tag) || m[4] === '/') continue;
    if (RAW.has(tag)) {
      const close = new RegExp('</' + tag + '\\s*>', 'ig');
      close.lastIndex = el.openEnd;
      const c = close.exec(src);
      el.innerEnd = c ? c.index : src.length;
      el.end = c ? c.index + c[0].length : src.length;
      re.lastIndex = el.end;
      continue;
    }
    stack.push(el);
  }
  while (stack.length > 1) { const e = stack.pop(); e.innerEnd = src.length; e.end = src.length; }
  for (const el of all) {
    el.html = src.slice(el.openEnd, el.innerEnd);
    el.text = RAW.has(el.tag) ? el.html : unesc(el.html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, ''));
  }
  root.html = src;
  root.all = all;
  root.byId = (id) => all.find((e) => e.attrs.id === id) || null;
  return root;
}

function mkEl(tag, attrs, start, parent) {
  const el = {
    tag, attrs, start, parent, children: [], line: 1,
    get classes() { return (this.attrs.class || '').split(/\s+/).filter(Boolean); },
    attr(k) { return k in this.attrs ? this.attrs[k] : null; },
    has(k) { return k in this.attrs; },
    $$(sel) { return selectAll(this, sel); },
    $(sel) { return selectAll(this, sel)[0] || null; },
    contains(o) { for (let n = o; n; n = n.parent) if (n === this) return true; return false; },
  };
  return el;
}
function descendants(el) {
  const out = [];
  (function walk(n) { for (const c of n.children) { out.push(c); walk(c); } })(el);
  return out;
}
/**
 * Selectors: tag, .class, #id, [attr], [attr=v], [attr^=v], [attr$=v],
 * [attr*=v], [attr~=v] (values may be quoted), compounds of those, the
 * descendant (space) and child (>) combinators, and comma lists.
 */
function selectAll(scope, sel) {
  const groups = splitTop(sel, ',').map((g) => parseSelector(g.trim()));
  return descendants(scope).filter((el) => groups.some((g) => matchChain(el, g, g.length - 1, scope)));
}
function splitTop(s, ch) {
  const out = []; let depth = 0, q = null, cur = '';
  for (const c of s) {
    if (q) { if (c === q) q = null; cur += c; continue; }
    if (c === '"' || c === "'") q = c;
    if (c === '[') depth++; else if (c === ']') depth--;
    if (c === ch && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
function parseSelector(sel) {
  const parts = [];
  const re = /\s*(>)?\s*((?:[a-zA-Z*][\w-]*)?(?:[.#][\w-]+|\[[^\]]+\])*)/g;
  let m, comb = ' ';
  while ((m = re.exec(sel)) && m[0].length) {
    if (m[1]) comb = '>';
    if (!m[2]) continue;
    parts.push({ comb, test: compound(m[2]) });
    comb = ' ';
  }
  if (!parts.length) throw new Error('src-kit: cannot parse selector ' + JSON.stringify(sel));
  return parts;
}
function compound(c) {
  const checks = [];
  const re = /^([a-zA-Z*][\w-]*)|\.([\w-]+)|#([\w-]+)|\[\s*([^\s~|^$*=\]]+)\s*(?:([~^$*]?=)\s*("[^"]*"|'[^']*'|[^\]\s]*))?\s*\]/g;
  let m;
  while ((m = re.exec(c)) && m[0].length) {
    if (m[1] && m[1] !== '*') { const t = m[1].toLowerCase(); checks.push((e) => e.tag === t); }
    else if (m[2]) { const k = m[2]; checks.push((e) => e.classes.includes(k)); }
    else if (m[3]) { const k = m[3]; checks.push((e) => e.attrs.id === k); }
    else if (m[4]) {
      const k = m[4].toLowerCase(), op = m[5], v = m[6] === undefined ? null : m[6].replace(/^(["'])([\s\S]*)\1$/, '$2');
      checks.push((e) => {
        if (!(k in e.attrs)) return false;
        const a = e.attrs[k];
        if (!op) return true;
        if (op === '=') return a === v;
        if (op === '^=') return a.startsWith(v);
        if (op === '$=') return a.endsWith(v);
        if (op === '*=') return a.includes(v);
        if (op === '~=') return a.split(/\s+/).includes(v);
        return false;
      });
    }
  }
  return (e) => checks.every((f) => f(e));
}
function matchChain(el, parts, i, scope) {
  if (!parts[i].test(el)) return false;
  if (i === 0) return true;
  if (parts[i].comb === '>') { const p = el.parent; return !!p && p !== scope && p.tag !== '#document' && matchChain(p, parts, i - 1, scope); }
  for (let p = el.parent; p && p !== scope && p.tag !== '#document'; p = p.parent) if (matchChain(p, parts, i - 1, scope)) return true;
  return false;
}
function lineIndex(s) {
  const starts = [0];
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') starts.push(i + 1);
  return (pos) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };
}

// ── CSS ────────────────────────────────────────────────────────────────────
const normSel = (s) => String(s).replace(/\s+/g, ' ').replace(/\s*([>+~,])\s*/g, '$1').trim();
const normMedia = (s) => String(s).replace(/\s+/g, '').toLowerCase();

/**
 * Every style rule in a stylesheet: { selectors: [normalised], decls: {prop: value},
 * media: normalised @media prelude or null, line }. Nested @media/@supports are
 * walked (the innermost @media wins); @keyframes and @font-face bodies are skipped.
 */
function cssRules(css) {
  const s = stripCssComments(lf(css));
  const lineAt = lineIndex(s);
  const out = [];
  (function walk(from, to, media) {
    let i = from;
    while (i < to) {
      const open = s.indexOf('{', i);
      if (open === -1 || open >= to) break;
      const prelude = s.slice(i, open).replace(/^[\s;}]+/, '').trim();
      const close = cssClose(s, open);
      if (/^@media\b/i.test(prelude)) walk(open + 1, close, normMedia(prelude.replace(/^@media/i, '')));
      else if (/^@(supports|layer|container)\b/i.test(prelude)) walk(open + 1, close, media);
      else if (!/^@/.test(prelude) && prelude) {
        const decls = {};
        for (const d of splitTop(s.slice(open + 1, close), ';')) {
          const c = d.indexOf(':');
          if (c === -1) continue;
          const k = d.slice(0, c).trim().toLowerCase();
          if (k) decls[k] = d.slice(c + 1).trim();
        }
        out.push({ selectors: splitTop(prelude, ',').map(normSel), decls, media, line: lineAt(open) });
      }
      i = close + 1;
    }
  })(0, s.length, null);
  return out;
}
function cssClose(s, open) {
  let d = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === '"' || s[j] === "'") { const q = s[j]; j++; while (j < s.length && s[j] !== q) j += s[j] === '\\' ? 2 : 1; continue; }
    if (s[j] === '{') d++; else if (s[j] === '}' && --d === 0) return j;
  }
  return s.length;
}
/**
 * The declarations a selector gets, merged over every rule that lists exactly
 * that selector (later wins). opts.media: undefined/null = rules outside any
 * @media only; a string = rules whose @media prelude contains it (whitespace
 * and case ignored, e.g. '(max-width:768px)'); '*' = anywhere. Returns null
 * when no rule matches, so `cssRule(…).display` throws loudly on a typo
 * instead of comparing undefined.
 */
function cssRule(css, selector, opts) {
  const want = normSel(selector);
  const media = opts && opts.media;
  const hit = (Array.isArray(css) ? css : cssRules(css)).filter((r) => r.selectors.includes(want)
    && (media === '*' || (media == null ? r.media === null : r.media !== null && r.media.includes(normMedia(media)))));
  if (!hit.length) return null;
  return Object.assign({}, ...hit.map((r) => r.decls));
}

// ── vm ─────────────────────────────────────────────────────────────────────
/**
 * Run one or more browser scripts in a fresh vm context and return it.
 *   files    a repo path or an array of them (run in order, like <script> tags)
 *   globals  copied onto the context; `window` defaults to the context itself
 *            and `console` to the real one
 *   opts.dom true → a fake document from tests/lib/nbd-os-home-harness.js
 *            (selector matching, innerHTML parsing, events via fire/click);
 *            the dom object is returned as ctx.__dom
 *   opts.esm true → strip `export` keywords and `import … from` lines so an ES
 *            module's functions run as plain script declarations
 *   opts.expose ['name', …] → copy those top-level bindings (const/let/class,
 *            which a vm does not put on the global) to ctx.__exposed
 *   opts.src  { 'path': text } overrides a file's text (for mutation tests)
 * Top-level `function` declarations land on the context directly.
 */
function loadInVm(files, globals, opts) {
  const o = opts || {};
  const ctx = Object.assign({ console }, globals || {});
  if (!('window' in ctx)) ctx.window = ctx;
  if (o.dom) {
    const dom = osHarness.makeDom();
    ctx.document = dom.document;
    if (ctx.window !== ctx && !ctx.window.document) ctx.window.document = dom.document;
    ctx.__dom = dom;
  }
  vm.createContext(ctx);
  for (const f of [].concat(files)) {
    let code = o.src && o.src[f] != null ? lf(o.src[f]) : read(f);
    if (o.esm) code = code.replace(/^\s*import\s[\s\S]*?from\s*['"][^'"]+['"];?[ \t]*$/mg, '').replace(/^\s*import\s*['"][^'"]+['"];?/mg, '').replace(/^(\s*)export\s+(default\s+)?/mg, '$1');
    vm.runInContext(code, ctx, { filename: f });
  }
  if (o.expose && o.expose.length) {
    vm.runInContext('this.__exposed = {' + o.expose.map((n) => JSON.stringify(n) + ': typeof ' + n + " === 'undefined' ? undefined : " + n).join(', ') + '};', ctx);
  }
  return ctx;
}

/** A Date frozen at `now` (ms) and timers that only fire on tick(). */
function fakeClock(now) {
  let t = now;
  const timers = [];
  let seq = 0;
  const Real = Date;
  class FakeDate extends Real {
    constructor(...a) { if (a.length) super(...a); else super(t); }
    static now() { return t; }
  }
  const add = (fn, ms, every) => { const id = ++seq; timers.push({ id, at: t + (ms || 0), fn, every }); return id; };
  const clear = (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); };
  return {
    Date: FakeDate,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    setInterval: (fn, ms) => add(fn, ms, ms || 1),
    clearTimeout: clear, clearInterval: clear,
    now: () => t,
    pending: () => timers.length,
    /** Advance the clock, firing each due timer in time order. */
    tick(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        t = next.at;
        if (next.every) next.at += next.every; else timers.shift();
        next.fn();
      }
      t = end;
    },
  };
}

/** A function that records each call's arguments in .calls (and returns impl's result). */
function spy(impl) {
  const f = function (...args) { f.calls.push(args); return impl ? impl.apply(this, args) : undefined; };
  f.calls = [];
  return f;
}

/** The ok()/section()/done() reporter most suites define for themselves. */
function suite(title) {
  let passed = 0, failed = 0;
  const fails = [];
  if (title) console.log(title);
  const ok = (name, cond, detail) => {
    if (cond) { passed++; console.log('  ✓ ' + name); }
    else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 800) : '')); }
    return !!cond;
  };
  return {
    ok,
    section: (t) => console.log('\n' + t),
    get passed() { return passed; },
    get failed() { return failed; },
    done() {
      console.log('\n' + passed + ' passed, ' + failed + ' failed');
      if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exitCode = 1; }
    },
  };
}

module.exports = {
  ROOT, read, exists, lf, stripJsComments, stripCssComments, sliceFn, matchBrace,
  parseTags, cssRules, cssRule, loadInVm, fakeClock, spy, suite,
  makeDom: osHarness.makeDom, fire: osHarness.fire, click: osHarness.click,
};
