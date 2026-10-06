#!/usr/bin/env node
/*
 * appcheck-config-per-page-2026-10-06.test.js
 *
 * RULE (appcheck-init-required-per-page): App Check is per page. The only
 * thing that sets window.__NBD_APP_CHECK_KEY is the classic script
 * docs/pro/js/dashboard-appcheck-config.js. A page whose script graph calls
 * an onCall callable (httpsCallable / getFunctions) but never loads that
 * file never initialises App Check, so every enforceAppCheck:true callable
 * 401s in production. The emulator shim hides this in every test rig, which
 * is how /pro/esign-setup (all five e-sign callables), /pro/photo-review
 * (createPortalToken) and the nbd-auth.js owner pages (mintOwnerClaims
 * self-heal) shipped broken.
 *
 * Built by SCANNING, not by a hand list: every docs/**.html page is parsed
 * for <script src>, each local script is followed through its static and
 * dynamic local imports (comments stripped first, so a commented-out import
 * or a comment that names httpsCallable cannot satisfy or trip the check),
 * and any page whose graph contains a callable call site must:
 *   1. load dashboard-appcheck-config.js as a classic script (plain or
 *      defer; never async, whose run order is not guaranteed),
 *   2. BEFORE the first <script> whose graph reaches the callable, and
 *   3. have an initializeAppCheck(app, { provider: new ReCaptcha…Provider(
 *      call somewhere in that graph (the key on its own does nothing), and
 *   4. get an effective CSP that admits reCAPTCHA (www.google.com and
 *      www.recaptcha.net).
 *
 * Run: node tests/appcheck-config-per-page-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const CONFIG_BASENAME = 'dashboard-appcheck-config.js';

// Files whose callable call sites are not real onCall traffic.
const NOT_A_CALLABLE_CALLER = new Set([
  // Emulator-only: getFunctions() there wires connectFunctionsEmulator on
  // localhost and is a no-op in production.
  path.join(DOCS, 'pro', 'js', 'nbd-emulator-connect.js'),
]);

// Comment stripper that respects string and template literals, so a URL like
// 'https://www.gstatic.com/...' is not cut at its "//".
function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (src[i] === '\n' && q !== '`') break;
        out += src[i];
        i++;
      }
      if (i < n) { out += src[i]; i++; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function walk(dir, ext, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, ext, acc);
    else if (ent.name.endsWith(ext)) acc.push(p);
  }
  return acc;
}

// Resolve a script/import specifier to a local file under docs/, or null for
// remote (gstatic, CDN) or unresolvable specifiers.
function resolveLocal(spec, fromFile) {
  if (!spec || /^[a-z]+:\/\//i.test(spec) || spec.startsWith('//') || spec.startsWith('data:')) return null;
  const clean = spec.split('?')[0].split('#')[0];
  let abs;
  if (clean.startsWith('/')) abs = path.join(DOCS, clean);
  else if (clean.startsWith('.') || /^[\w-]/.test(clean)) abs = path.join(path.dirname(fromFile), clean);
  else return null;
  return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
}

const fileInfoCache = new Map();
function fileInfo(file) {
  if (fileInfoCache.has(file)) return fileInfoCache.get(file);
  const code = stripJsComments(fs.readFileSync(file, 'utf8'));
  const imports = [];
  const re = /\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  let m;
  while ((m = re.exec(code))) {
    const r = resolveLocal(m[1] || m[2], file);
    if (r) imports.push(r);
  }
  const info = {
    imports,
    callsCallable: !NOT_A_CALLABLE_CALLER.has(file) && /\b(?:httpsCallable|_httpsCallable|getFunctions)\s*\(/.test(code),
    // A reCAPTCHA init, not just any initializeAppCheck( — the emulator
    // shim's CustomProvider call would otherwise satisfy every page.
    initsAppCheck: /\binitializeAppCheck\s*\(\s*\w+\s*,\s*\{\s*provider\s*:\s*new\s+ReCaptcha(?:Enterprise|V3)Provider\s*\(/.test(code),
  };
  fileInfoCache.set(file, info);
  return info;
}

function graphOf(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const i of fileInfo(f).imports) stack.push(i);
  }
  return [...seen];
}

function scriptsOf(htmlFile) {
  const html = stripHtmlComments(fs.readFileSync(htmlFile, 'utf8'));
  const out = [];
  const re = /<script\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!src) continue;
    out.push({
      src,
      file: resolveLocal(src, htmlFile),
      isModule: /\btype\s*=\s*["']module["']/i.test(attrs),
      isAsync: /\basync\b/i.test(attrs),
    });
  }
  return out;
}

function auditPage(htmlFile) {
  const scripts = scriptsOf(htmlFile);
  const configIdx = scripts.findIndex((s) => s.file && path.basename(s.file) === CONFIG_BASENAME);
  let firstCallerIdx = -1;
  const callers = [];
  let initsAppCheck = false;
  scripts.forEach((s, idx) => {
    if (!s.file || !s.file.endsWith('.js') && !s.file.endsWith('.mjs')) return;
    const g = graphOf(s.file);
    const hit = g.filter((f) => fileInfo(f).callsCallable);
    if (g.some((f) => fileInfo(f).initsAppCheck)) initsAppCheck = true;
    if (hit.length) {
      if (firstCallerIdx === -1) firstCallerIdx = idx;
      callers.push(...hit.map((f) => path.relative(DOCS, f).replace(/\\/g, '/')));
    }
  });
  if (firstCallerIdx === -1) return null; // page never calls a callable
  const problems = [];
  if (configIdx === -1) problems.push('does not load ' + CONFIG_BASENAME);
  else {
    const c = scripts[configIdx];
    if (configIdx > firstCallerIdx) problems.push(CONFIG_BASENAME + ' loads AFTER ' + scripts[firstCallerIdx].src);
    if (c.isModule || c.isAsync) problems.push(CONFIG_BASENAME + ' must be a classic (plain or defer) script, not module/async');
  }
  if (!initsAppCheck) problems.push('script graph never calls initializeAppCheck(');
  return { page: path.relative(DOCS, htmlFile).replace(/\\/g, '/'), callers: [...new Set(callers)], problems };
}

function auditAll() {
  return walk(DOCS, '.html', []).map(auditPage).filter(Boolean);
}

// ── Effective CSP per path (same matcher as csp-hardening-2026-10-05) ──
const CSP_KEYS = ['Content-Security-Policy', 'Content-Security-Policy-Report-Only'];
const RECAPTCHA_HOSTS = ['https://www.google.com', 'https://www.recaptcha.net'];
// /admin/analytics: its narrow CSP also lacks *.cloudfunctions.net, so its
// callables are blocked before App Check matters. A separate fix (2026-10-06).
const KNOWN_CSP_GAPS = new Set(['admin/analytics.html']);
const HEADER_RULES = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8')).hosting.headers;
function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '@' && g[i + 1] === '(') {
      const end = g.indexOf(')', i);
      re += '(?:' + g.slice(i + 2, end).split('|').map((s) => s.replace(/[.+?^${}()[\]\\]/g, '\\$&')).join('|') + ')';
      i = end;
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
function effectiveHeader(urlPath, key) {
  let val = null;
  for (const r of HEADER_RULES) {
    const hit = r.source ? globRe(r.source).test(urlPath) : (r.regex ? new RegExp(r.regex).test(urlPath) : false);
    if (!hit) continue;
    const h = (r.headers || []).find((x) => x.key === key);
    if (h) val = h.value;
  }
  return val;
}
function parseCsp(v) {
  const out = {};
  String(v || '').split(';').map((x) => x.trim()).filter(Boolean).forEach((x) => {
    const t = x.split(/\s+/); out[t[0]] = t.slice(1);
  });
  return out;
}
// docs/pro/ask-joe.html -> /pro/ask-joe ; docs/tools/index.html -> /tools
function pageUrl(page) {
  let u = '/' + page.replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '');
  if (u.length > 1 && u.endsWith('/')) u = u.slice(0, -1);
  return u;
}

module.exports = { auditAll, auditPage, scriptsOf, graphOf, fileInfo, stripJsComments };

if (require.main === module) {
  let failed = 0;
  let passed = 0;
  const check = (ok, msg) => {
    if (ok) { passed++; } else { failed++; console.error('  FAIL ' + msg); }
  };

  const results = auditAll();
  const byPage = new Map(results.map((r) => [r.page, r]));

  // Non-vacuity: the scan must actually find the pages this guard exists
  // for, so a resolver regression cannot make it pass by seeing nothing.
  const MUST_BE_CALLER_PAGES = [
    'pro/dashboard.html',
    'pro/customer.html',
    'pro/esign-setup.html',
    'pro/photo-review.html',
    'pro/vault.html',
    'pro/index.html',
    'estimate.html',
  ];
  for (const p of MUST_BE_CALLER_PAGES) {
    check(byPage.has(p), 'scanner did not detect a callable in the script graph of ' + p + ' (resolver regression?)');
  }
  check(results.length >= 15, 'scanner found only ' + results.length + ' callable pages (expected >= 15)');

  for (const r of results) {
    check(r.problems.length === 0,
      r.page + ': ' + r.problems.join('; ') + '  [callers: ' + r.callers.join(', ') + ']');
  }

  // 4. The key is useless if the page's CSP blocks reCAPTCHA Enterprise
  //    (www.google.com / www.recaptcha.net) — /pro/ask-joe had its own
  //    narrower policy that did. Checked against the EFFECTIVE header
  //    (firebase.json header rules are last-match-wins per key).
  for (const r of results) {
    if (KNOWN_CSP_GAPS.has(r.page)) continue;
    for (const key of CSP_KEYS) {
      const d = parseCsp(effectiveHeader(pageUrl(r.page), key));
      for (const dir of ['script-src', 'script-src-elem', 'frame-src', 'connect-src']) {
        if (!d[dir]) continue; // falls back to a checked directive / default-src
        check(RECAPTCHA_HOSTS.every((h) => d[dir].includes(h)),
          r.page + ' (' + pageUrl(r.page) + '): ' + key + ' ' + dir + ' must allow ' + RECAPTCHA_HOSTS.join(' + '));
      }
    }
  }

  // Comment-stripping must not let a commented-out tag or call count.
  const stripped = stripJsComments("// httpsCallable(x)\n/* getFunctions() */ const u = 'https://a//b';");
  check(!/httpsCallable|getFunctions/.test(stripped) && stripped.includes("'https://a//b'"),
    'stripJsComments must drop comments but keep string literals intact');

  console.log(`appcheck-config-per-page: ${results.length} callable pages scanned, ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
