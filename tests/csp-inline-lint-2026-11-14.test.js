/**
 * tests/csp-inline-lint-2026-11-14.test.js — one repo-wide CSP lint, so a
 * suite no longer needs its own `!/\son[a-z]+=/.test(src)` copy.
 *
 * The CSP (firebase.json) has no 'unsafe-inline' in script-src and sets
 * script-src-attr 'none', so the browser silently drops an inline handler,
 * an inline <script> or a javascript: URL. This walks EVERY shipped file
 * under docs/ (the hosting root):
 *   HTML (parsed with tests/lib/src-kit.js parseTags, not regex-matched):
 *     - no on* event-handler attribute on any element
 *     - no executable inline <script> (a script with no src whose type is
 *       JavaScript or module; JSON-LD, application/json and templates are data)
 *     - no javascript: URL in href / src / action / formaction
 *   JS (markup the code writes into the page):
 *     - no on*= attribute inside an emitted tag, no javascript: URL in one,
 *       no setAttribute('on…') / setAttribute('href', 'javascript:…')
 * Each detector is first run on fixtures with every violation it claims to
 * catch, and on lookalikes it must not flag (data-onclick, online, JSON-LD).
 *
 * Covers what the per-suite CSP copies check (about 150 of them, e.g.
 * tests/home-strips-2026-10-16.test.js "CSP: no inline handlers"); a later
 * PR can delete those copies. Inline style attributes stay with
 * tests/inline-style-ratchet-2026-10-01.test.js (style-src allows them today).
 *
 * Zero deps. Run: node tests/csp-inline-lint-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const K = require('./lib/src-kit');
const T = K.suite('CSP INLINE LINT — nothing the strict CSP would silently drop ships under docs/');
const { ok, section } = T;

const DOCS = path.join(K.ROOT, 'docs');
const SKIP_DIR = /[\\/](node_modules|\.git)[\\/]/;
function walk(dir, test, out) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (!SKIP_DIR.test(p + path.sep)) walk(p, test, out); } else if (test(f.name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(K.ROOT, p).replace(/\\/g, '/');

// ── detectors ──────────────────────────────────────────────────────────────
const DATA_SCRIPT = /^(application\/(ld\+)?json|application\/importmap\+json|text\/(template|x-template|html|plain)|importmap|speculationrules)$/i;
const JS_URL = /^\s*javascript:/i;
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'xlink:href'];
/** Violations in one HTML document: [{ line, what }]. */
function htmlViolations(html) {
  const out = [];
  for (const el of K.parseTags(html).all) {
    for (const k of Object.keys(el.attrs)) if (/^on[a-z]+$/.test(k)) out.push({ line: el.line, what: '<' + el.tag + ' ' + k + '=…> inline handler' });
    for (const k of URL_ATTRS) if (k in el.attrs && JS_URL.test(el.attrs[k])) out.push({ line: el.line, what: '<' + el.tag + ' ' + k + '="javascript:…">' });
    if (el.tag === 'script' && !el.has('src') && !DATA_SCRIPT.test((el.attrs.type || '').trim()) && el.text.trim()) out.push({ line: el.line, what: 'inline <script' + (el.attrs.type ? ' type="' + el.attrs.type + '"' : '') + '>' });
  }
  return out;
}
// an attribute inside an emitted tag: `<tag … onclick="` (quote may be escaped)
// (any case: HTML attribute names are case-insensitive, so ONCLICK= runs too)
const JS_HANDLER = /<[a-zA-Z][\w-]*\b[^<>]*?\son[a-z]{3,}\s*=\s*(?:\\?["'`]|[^\s>]*\()/gi;
// an unquoted value with no call in it (`ONCLICK=go`): only for real event names, so `online=1` is not flagged
const JS_HANDLER_BARE = /<[a-zA-Z][\w-]*\b[^<>]*?\son(?:click|dblclick|mouse\w+|key\w+|load|error|change|input|submit|focus\w*|blur|touch\w+|pointer\w+|drag\w*|drop|scroll|wheel|contextmenu|resize|reset|select|toggle|abort|animation\w+|transition\w+|play|pause|ended|beforeunload|unload)\s*=\s*[^\s>"'`\\(]+[\s>]/gi;
const JS_JSURL = /<[a-zA-Z][\w-]*\b[^<>]*?\s(?:href|src|action|formaction)\s*=\s*\\?["'`]?\s*javascript:/gi;
const JS_SETATTR = /setAttribute\(\s*["'`]on[a-z]+["'`]|setAttribute\(\s*["'`](?:href|src|action)["'`]\s*,\s*["'`]\s*javascript:/gi;
/** Violations in one JS file's text: [{ line, what }]. */
function jsViolations(code) {
  const s = K.stripJsComments(code);
  const out = [];
  const lineOf = (i) => s.slice(0, i).split('\n').length;
  const seen = new Set();
  for (const [re, what] of [[JS_HANDLER, 'emitted inline handler'], [JS_HANDLER_BARE, 'emitted inline handler'], [JS_JSURL, 'emitted javascript: URL'], [JS_SETATTR, 'setAttribute handler / javascript: URL']]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      if (seen.has(what + '@' + m.index)) continue;   // one tag caught by both handler patterns counts once
      seen.add(what + '@' + m.index);
      out.push({ line: lineOf(m.index), what: what + ': ' + m[0].slice(0, 70) });
    }
  }
  return out;
}

section('the detectors catch what they claim (positive controls) and nothing else');
{
  const bad = htmlViolations([
    '<button onclick="go()">a</button>',
    "<body onload='x()'>",
    '<img src=x.png onerror=alert(1)>',
    '<a href="javascript:void(0)">b</a>',
    '<form action=" JavaScript:alert(1)"></form>',
    '<script>console.log(1)</script>',
    '<script type="module">import "./a.js";</script>',
    '<script type="text/javascript">x()</script>',
  ].join('\n'));
  ok('HTML: handlers (quoted, single, bare), javascript: URLs, classic + module + typed inline scripts — all 8',
    bad.length === 8 && bad.map((v) => v.line).join() === '1,2,3,4,5,6,7,8', JSON.stringify(bad));
  const fine = htmlViolations([
    '<button data-onclick="go" data-action="online" class="onclick">a</button>',
    '<script type="application/ld+json">{"@type":"Roofer"}</script>',
    '<script type="application/json" id="cfg">{}</script>',
    '<script defer src="js/a.js?v=1"></script>',
    '<script></script>',
    '<p>use onclick="x" in text, javascript: in prose</p>',
    '<!-- <button onclick="x()"> -->',
    '<a href="/javascript-guide">c</a>',
  ].join('\n'));
  ok('HTML: data-on*, JSON-LD / JSON data, src scripts, empty script, text and comments are not flagged', fine.length === 0, JSON.stringify(fine));

  const jsBad = jsViolations([
    "h += '<button class=\"b\" onclick=\"go()\">';",
    'el.innerHTML = `<img src="${u}" onerror="x()">`;',
    "h += '<a onclick=\\'x()\\'>';",
    "h += '<a href=\"javascript:void(0)\">';",
    "el.setAttribute('onclick', 'go()');",
    "a.setAttribute('href', 'javascript:x()');",
    "h += '<div onmouseover=go()>';",
    "h += '<button ONCLICK=go>';",
    "h += '<a OnClick=\"go()\">';",
  ].join('\n'));
  ok('JS: emitted handlers ("…", `…`, escaped \\\'…\\\', bare call, bare name, any case), emitted javascript: URLs, setAttribute — all 9',
    jsBad.length === 9, JSON.stringify(jsBad));
  const jsFine = jsViolations([
    "btn.addEventListener('click', go);",
    "h += '<button data-onclick=\"go\" data-act=\"x\">';",
    "if (navigator.onLine) h += '<span class=\"online\">';",
    "// h += '<button onclick=\"go()\">';",
    "/* el.setAttribute('onclick', 'x') */",
    'const s = "onclick=\\"x\\""; // a string with no tag around it',
    "el.setAttribute('href', '/js-guide');",
    "h += '<input data-v=1 online=yes>';",
  ].join('\n'));
  ok('JS: listeners, data-on*, navigator.onLine, comments, and a bare string with no tag are not flagged', jsFine.length === 0, JSON.stringify(jsFine));
}

section('every shipped HTML page');
{
  const files = walk(DOCS, (f) => /\.html?$/i.test(f), []);
  const bad = [];
  for (const f of files) for (const v of htmlViolations(fs.readFileSync(f, 'utf8'))) bad.push(rel(f) + ':' + v.line + '  ' + v.what);
  ok('found the shipped pages (the walk is not empty)', files.length > 300 && files.some((f) => rel(f) === 'docs/pro/dashboard.html'), files.length);
  ok(files.length + ' HTML files: no inline handlers, inline scripts or javascript: URLs', bad.length === 0,
    bad.slice(0, 20).join('\n      ') + (bad.length > 20 ? '\n      … ' + (bad.length - 20) + ' more' : '')
    + '\n      fix: move the code to an external file under docs/assets/js/ (or docs/pro/js/) loaded with defer, and wire it with addEventListener or a data-* delegate.');
}

section('every shipped JS file (the markup it writes)');
{
  const files = walk(DOCS, (f) => /\.m?js$/.test(f) && !/\.min\.js$/.test(f), []);
  const bad = [];
  for (const f of files) for (const v of jsViolations(fs.readFileSync(f, 'utf8'))) bad.push(rel(f) + ':' + v.line + '  ' + v.what);
  ok('found the shipped scripts', files.length > 500 && files.some((f) => rel(f) === 'docs/pro/js/stage-write.js'), files.length);
  ok(files.length + ' JS files: no emitted inline handlers or javascript: URLs', bad.length === 0,
    bad.slice(0, 20).join('\n      ') + '\n      fix: emit a data-* attribute and handle it in a delegated addEventListener (see docs/pro/js/phone-share.js for the pattern).');
}

T.done();
