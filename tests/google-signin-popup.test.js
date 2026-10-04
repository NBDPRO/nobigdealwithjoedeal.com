/* tests/google-signin-popup.test.js
 *
 * "Continue with Google" on /pro/register had never worked. Two independent
 * faults, and fixing either alone still leaves it broken:
 *
 *   1. The Google provider was never enabled on the Firebase project (a
 *      console setting — Jo's step, not code; nothing here can test it).
 *   2. firebase.json's global '**' rule sends Cross-Origin-Opener-Policy:
 *      same-origin. signInWithPopup opens nobigdeal-pro.firebaseapp.com's
 *      /__/auth/handler — cross-origin — so the browser puts the popup in a
 *      new browsing-context group: window.opener is null inside it, the page
 *      sees popup.closed === true at once, and the SDK rejects with
 *      auth/popup-closed-by-user ("Sign-in cancelled.") even when the
 *      provider is on. Reproduced in the emulator 2026-09-18 (COOP
 *      same-origin: severed; same-origin-allow-popups: signInWithIdp 200 →
 *      createCompany 200 → /pro/onboarding).
 *
 * This suite guards the code half, three ways:
 *
 *   A. EFFECTIVE headers, not "a block mentions COOP". Every page whose
 *      scripts can reach a popup-auth call (signInWithPopup, linkWithPopup,
 *      reauthenticateWithPopup) is DISCOVERED — docs/ JS and inline scripts
 *      are scanned, then mapped to the HTML pages that load them through
 *      <script src>, static import and literal dynamic import(). For each
 *      such page the header Firebase Hosting would actually send is computed
 *      from firebase.json (tests/lib/hosting-headers.js: last matching block
 *      wins per key, minimatch globs) and must let popups keep their opener.
 *      Every OTHER page must still get same-origin, so "fixing" this by
 *      weakening '**' fails too. A Google button added to /pro/login later
 *      is covered with no edit here.
 *      Redirect flows (signInWithRedirect) are deliberately NOT in the
 *      requirement set: they are top-level navigations, which COOP does not
 *      touch, so demanding a looser COOP for them would loosen isolation for
 *      nothing. They are reported, not asserted.
 *
 *   B. register.js runs for real in a vm (only its import lines are swapped
 *      for stubs) to prove the App Check warm-up: firebase-auth 10.12.2
 *      awaits an App Check token between the click and window.open (checked
 *      in the gstatic build: _openPopup → _getRedirectUrl →
 *      `await auth._getAppCheckToken()` → _open → window.open). Cold, that is
 *      IndexedDB + reCAPTCHA Enterprise + an exchange round trip inside the
 *      click, which spends the user activation and gets the popup blocked on
 *      Safari/iOS. The page now fetches the token at load and holds the
 *      button until it lands (or a short timeout).
 *
 *   C. The same vm harness clicks the button with signInWithPopup rejecting
 *      each error code and reads #regErr, so the new copy is proven through
 *      the real catch block, not by grepping for strings.
 *
 *   D. login.js runs in the same kind of vm: App Check warm-up and button
 *      hold, mirrored from register.js (/pro/login grew its own "Continue
 *      with Google" 2026-09-22).
 *
 *   E. login.js's Google handler is SIGN-IN ONLY: an existing users/{uid}
 *      lands on POST_LOGIN_DEST (?redirect=pricing / plan intent honoured);
 *      a Google identity with no users/{uid} is signed back out and shown
 *      a DOM-built link to /pro/register, with NO Firestore write, NO
 *      createCompany and NO ensureProvisioned; error codes map to copy.
 *
 * The runtime half — the popup really completes with the header this file
 * computes — is tests/e2e/google-signin-popup.spec.js (@stranger shard).
 *
 * Zero deps. Run: node tests/google-signin-popup.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { effectiveHeaders, canonicalPagePath } = require('./lib/hosting-headers');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
// Normalise EOLs: CRLF working tree on Windows, LF in the index and on CI.
const read = (abs) => fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
const FIREBASE = JSON.parse(read(path.join(ROOT, 'firebase.json')));
const HOSTING = FIREBASE.hosting;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name) { console.log('\n' + name); }

/* ══════════════════════════════════════════════════════════════════
   Discovery: which pages can run a popup-auth call?
   ══════════════════════════════════════════════════════════════════ */
const POPUP_CALL_RE = /\b(?:signInWithPopup|linkWithPopup|reauthenticateWithPopup)\s*\(/;
const REDIRECT_CALL_RE = /\b(?:signInWithRedirect|linkWithRedirect|reauthenticateWithRedirect)\s*\(/;
const COOP_ALLOWS_POPUPS = ['same-origin-allow-popups', 'unsafe-none'];
const COOP_DEFAULT = 'same-origin';

/** Map<relFromDocs, content> of every .html / .js / .mjs under a docs root. */
function loadDocsTree(dir) {
  const files = new Map();
  (function walk(abs, rel) {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const r = rel ? rel + '/' + e.name : e.name;
      // The self-hosted Firebase SDK (2026-10-04) DEFINES signInWithPopup;
      // it is library code, not a call site. Scanning it would mark every
      // page that imports firebase-auth.js as a popup page. (It used to live
      // on gstatic, outside this tree.)
      if (r === 'assets/vendor/firebase') continue;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (/\.(html|m?js)$/.test(e.name)) files.set(r, read(path.join(abs, e.name)));
    }
  })(dir, '');
  return files;
}

// Resolve a script reference the way the browser would, from the URL path of
// the document/module that holds it, to a docs-relative file (or null when it
// is external, bare, or points at nothing we serve). An HTML src is an
// ordinary relative URL ('js/x.js' is fine); an ES import specifier must start
// with './', '../' or '/' — anything else is bare and the browser refuses it.
function resolveRef(spec, fromUrlPath, files, { moduleSpecifier = false } = {}) {
  if (!spec || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(spec)) return null; // http(s):, data:, //cdn
  if (moduleSpecifier && !/^(?:\.{1,2}\/|\/)/.test(spec)) return null;
  let p;
  try { p = decodeURIComponent(new URL(spec, 'https://site.invalid' + fromUrlPath).pathname); } catch (_) { return null; }
  const rel = p.replace(/^\/+/, '');
  return files.has(rel) ? rel : null;
}

const IMPORT_RES = [
  /\bimport\s+(?:[\w$*{}\s,]+?\s+from\s+)?["']([^"'\n]+)["']/g, // import x from '…' / import '…'
  /\bexport\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["'`]([^"'`$\n]+)["'`]\s*\)/g, // literal dynamic import()
];
function moduleRefs(src) {
  const out = [];
  for (const re of IMPORT_RES) for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SRC_ATTR_RE = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * @param {Map<string,string>} files docs-relative path → content
 * @returns {{ popupPages: Map<string, string[]>, redirectPages: Map<string, string[]>,
 *             popupFiles: string[], orphans: string[], pageCount: number, allPages: string[] }}
 *   popupPages maps a page's canonical URL to the file(s) that carry the call.
 */
function discover(files) {
  const reachCache = new Map();
  // Every docs file reachable from a JS file via static/dynamic imports.
  function reach(rel, seen = new Set()) {
    if (seen.has(rel)) return seen;
    seen.add(rel);
    const src = files.get(rel) || '';
    const fromUrl = '/' + rel;
    for (const spec of moduleRefs(src)) {
      const dep = resolveRef(spec, fromUrl, files, { moduleSpecifier: true });
      if (dep && /\.m?js$/.test(dep)) reach(dep, seen);
    }
    return seen;
  }
  function reachable(rel) {
    if (!reachCache.has(rel)) reachCache.set(rel, reach(rel));
    return reachCache.get(rel);
  }

  const popupPages = new Map();
  const redirectPages = new Map();
  const loadedAnywhere = new Set();
  const allPages = [];
  for (const [rel, raw] of files) {
    if (!rel.endsWith('.html')) continue;
    const page = canonicalPagePath(rel, { cleanUrls: true, trailingSlash: false });
    allPages.push(page);
    const html = raw.replace(/<!--[\s\S]*?-->/g, ''); // a commented-out tag loads nothing
    const carriers = { popup: [], redirect: [] };
    const note = (label, src) => {
      if (POPUP_CALL_RE.test(src)) carriers.popup.push(label);
      if (REDIRECT_CALL_RE.test(src)) carriers.redirect.push(label);
    };
    for (const m of html.matchAll(SCRIPT_TAG_RE)) {
      const attrs = m[1];
      const sm = SRC_ATTR_RE.exec(attrs);
      if (sm) {
        const target = resolveRef(sm[1] ?? sm[2] ?? sm[3], page, files);
        if (!target) continue;
        for (const dep of reachable(target)) {
          loadedAnywhere.add(dep);
          note(dep, files.get(dep));
        }
      } else {
        // Inline script body: may call directly, or import modules itself.
        const body = m[2];
        note(rel + ' (inline <script>)', body);
        for (const spec of moduleRefs(body)) {
          const dep = resolveRef(spec, page, files, { moduleSpecifier: true });
          if (!dep) continue;
          for (const d of reachable(dep)) { loadedAnywhere.add(d); note(d, files.get(d)); }
        }
      }
    }
    if (carriers.popup.length) popupPages.set(page, [...new Set(carriers.popup)]);
    if (carriers.redirect.length) redirectPages.set(page, [...new Set(carriers.redirect)]);
  }
  const popupFiles = [...files].filter(([rel, src]) => /\.m?js$/.test(rel) && POPUP_CALL_RE.test(src)).map(([rel]) => rel);
  const orphans = popupFiles.filter((rel) => !loadedAnywhere.has(rel));
  return { popupPages, redirectPages, popupFiles, orphans, pageCount: allPages.length, allPages };
}

const coopOf = (hosting, page) => {
  const hit = effectiveHeaders(hosting, page).get('cross-origin-opener-policy');
  return hit ? hit : { value: undefined, ruleIndex: -1, source: '(none)' };
};

/* ══════════════════════════════════════════════════════════════════
   A0. The instruments work (synthetic inputs — no repo state)
   ══════════════════════════════════════════════════════════════════ */
group('A0. Discovery + effective-header instruments, on synthetic inputs');
{
  const fake = new Map(Object.entries({
    'pro/login.html': '<script type="module" src="js/pages/login.js"></script>',
    'pro/js/pages/login.js': "import { go } from '../auth/google.js';\ngo();",
    'pro/js/auth/google.js': 'export function go(a, p) { return signInWithPopup(a, p); }',
    // Named in an import list but never CALLED — not a popup page.
    'pro/quiet.html': '<script type="module" src="/pro/js/quiet.js"></script>',
    'pro/js/quiet.js': 'import { signInWithPopup } from "/assets/vendor/firebase/10.12.2/firebase-auth.js";',
    // A commented-out tag loads nothing.
    'index.html': '<!-- <script src="/pro/js/auth/google.js"></script> -->',
    // Compat-API call in an inline script, odd spacing.
    'pro/inline.html': '<script>auth.signInWithPopup (provider);</script>',
    // Redirect only: reported, not a popup page.
    'pro/redir.html': '<script src="/pro/js/redir.js" defer></script>',
    'pro/js/redir.js': 'signInWithRedirect(auth, p);',
    // Loaded by nothing we can trace — must surface as an orphan.
    'pro/js/lazy/popup-lazy.js': 'reauthenticateWithPopup(user, p);',
    // Directory index served at /pro (no trailing slash): 'js/x.js' resolves to /js/x.js.
    'pro/index.html': '<script src="js/pages/login.js"></script>',
    // A bare import specifier never loads in a browser (no import map here).
    'pro/bare.html': '<script type="module" src="/pro/js/bare.js"></script>',
    'pro/js/bare.js': "import { go } from 'pro/js/auth/google.js';\ngo();",
  }));
  const d = discover(fake);
  assert('a call two imports deep marks the page that loads the entry script',
    d.popupPages.has('/pro/login') && d.popupPages.get('/pro/login').includes('pro/js/auth/google.js'),
    JSON.stringify([...d.popupPages]));
  assert('an import-only mention (no call) does not', !d.popupPages.has('/pro/quiet'));
  assert('a commented-out <script> does not', !d.popupPages.has('/'));
  assert('an inline compat-API call does', d.popupPages.has('/pro/inline'));
  assert('a redirect-only page is reported separately, not as a popup page',
    d.redirectPages.has('/pro/redir') && !d.popupPages.has('/pro/redir'));
  assert('a popup file no page loads is an orphan', d.orphans.includes('pro/js/lazy/popup-lazy.js'),
    JSON.stringify(d.orphans));
  assert('relative srcs resolve like the browser (/pro index → /js/…, which is not served)',
    !d.popupPages.has('/pro'));
  assert('a bare import specifier is not followed (the browser refuses it)', !d.popupPages.has('/pro/bare'));

  const hosting = (blocks) => ({ cleanUrls: true, trailingSlash: false, headers: blocks });
  const G = { source: '**', headers: [{ key: 'Cross-Origin-Opener-Policy', value: 'same-origin' }] };
  const O = { source: '/pro/login', headers: [{ key: 'cross-origin-opener-policy', value: 'same-origin-allow-popups' }] };
  assert('a later matching block wins (key compared case-insensitively)',
    coopOf(hosting([G, O]), '/pro/login').value === 'same-origin-allow-popups');
  assert('an override placed BEFORE "**" is overwritten by it',
    coopOf(hosting([O, G]), '/pro/login').value === 'same-origin');
  assert('the override does not leak to a neighbour path',
    coopOf(hosting([G, O]), '/pro/dashboard').value === 'same-origin');
  assert('a ".html" source never matches the served (clean) URL',
    coopOf(hosting([G, { ...O, source: '/pro/login.html' }]), '/pro/login').value === 'same-origin');
  assert('canonicalPagePath: register.html → /pro/register, pro/index.html → /pro, index.html → /',
    canonicalPagePath('pro/register.html', hosting([])) === '/pro/register'
    && canonicalPagePath('pro/index.html', hosting([])) === '/pro'
    && canonicalPagePath('index.html', hosting([])) === '/');
}

/* ══════════════════════════════════════════════════════════════════
   A. The real site: popup pages get a popup-safe COOP, nothing else does
   ══════════════════════════════════════════════════════════════════ */
const tree = loadDocsTree(DOCS);
const found = discover(tree);

group('A1. Discovery over docs/');
assert(`docs/ scanned (${found.pageCount} pages, ${tree.size} html/js files)`, found.pageCount >= 100 && tree.size >= 300,
  'the scan found too little — is DOCS pointing at the hosting root?');
assert('at least one popup-auth call exists in docs/ JS', found.popupFiles.length > 0,
  'if Google sign-in was removed on purpose, delete this suite with it');
assert('discovery attributes docs/pro/js/pages/register.js to /pro/register (the page this override was written for)',
  (found.popupPages.get('/pro/register') || []).includes('pro/js/pages/register.js'),
  'got ' + JSON.stringify([...found.popupPages]));
assert('discovery attributes docs/pro/js/pages/login.js to /pro/login (the "Continue with Google" sign-in button)',
  (found.popupPages.get('/pro/login') || []).includes('pro/js/pages/login.js'),
  'got ' + JSON.stringify([...found.popupPages]));
assert('every JS file with a popup-auth call is loaded by a page discovery can see',
  found.orphans.length === 0,
  'unattributed: ' + found.orphans.join(', ') + ' — it is loaded some way this suite cannot trace '
  + '(ScriptLoader, injected <script>, computed import()). Teach discover() that loader, or its '
  + 'page ships with COOP same-origin and the popup is severed.');
console.log('    popup pages: ' + [...found.popupPages.keys()].join(', '));
console.log('    redirect-flow pages (COOP-insensitive, not asserted): '
  + ([...found.redirectPages.keys()].join(', ') || 'none'));

group('A2. Every popup page is served a COOP that lets its popup keep window.opener');
for (const [page, carriers] of found.popupPages) {
  const c = coopOf(HOSTING, page);
  assert(`${page}: Cross-Origin-Opener-Policy is ${JSON.stringify(c.value)} (block #${c.ruleIndex} "${c.source}")`,
    COOP_ALLOWS_POPUPS.includes(c.value),
    `calls a popup-auth API via ${carriers.join(', ')}; under ${JSON.stringify(c.value)} the Firebase `
    + 'auth popup is severed from the page and sign-in ends in auth/popup-closed-by-user. Add '
    + '{ "key": "Cross-Origin-Opener-Policy", "value": "same-origin-allow-popups" } to a firebase.json '
    + `header block whose source is exactly "${page}" and that sits AFTER the "**" block.`);
}

group('A3. The rest of the site keeps COOP same-origin');
{
  const globalRule = HOSTING.headers.find((r) => r.source === '**');
  const g = globalRule && (globalRule.headers || []).find((h) => /^cross-origin-opener-policy$/i.test(h.key));
  assert('the global "**" block still sets Cross-Origin-Opener-Policy: same-origin',
    !!g && g.value === COOP_DEFAULT,
    'got ' + JSON.stringify(g && g.value) + ' — relaxing the global default to un-break one page '
    + 'strips cross-origin isolation from every page');

  for (const page of ['/pro/login', '/pro/dashboard', '/pro/customer', '/pro', '/', '/admin/login']) {
    if (found.popupPages.has(page)) continue;
    const c = coopOf(HOSTING, page);
    assert(`${page}: Cross-Origin-Opener-Policy is same-origin`, c.value === COOP_DEFAULT,
      `got ${JSON.stringify(c.value)} from block #${c.ruleIndex} "${c.source}"`);
  }

  const others = found.allPages.filter((p) => !found.popupPages.has(p));
  const loosened = others
    .map((p) => ({ p, c: coopOf(HOSTING, p) }))
    .filter(({ c }) => c.value !== COOP_DEFAULT);
  assert(`all ${others.length} non-popup pages resolve to same-origin`,
    others.length >= 100 && loosened.length === 0,
    loosened.slice(0, 8).map(({ p, c }) => `${p} → ${JSON.stringify(c.value)} (block #${c.ruleIndex} "${c.source}")`).join('; ')
    + ' — the popup override must stay on the popup pages only');
}

/* ══════════════════════════════════════════════════════════════════
   B + C. register.js, executed for real in a vm
   ══════════════════════════════════════════════════════════════════ */
const REGISTER_REL = 'docs/pro/js/pages/register.js';
const REGISTER_SRC = read(path.join(ROOT, REGISTER_REL));

// Swap each `import { a, b as c } from "spec";` for a destructure from stubs.
// Any other import shape throws, so a refactor cannot quietly bypass the harness.
function toScript(src) {
  const IMPORT_RE = /^\s*import\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\2\s*;?/gm;
  let body = src.replace(IMPORT_RE, (_, names, _q, spec) => {
    const binds = names.split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => s.replace(/^([\w$]+)\s+as\s+([\w$]+)$/, '$1: $2'));
    return `const { ${binds.join(', ')} } = __imports(${JSON.stringify(spec)});`;
  });
  if (/^\s*import[\s{*]/m.test(body)) throw new Error('register.js has an import shape the harness does not understand');
  return `(async () => {\n${body}\n})()`;
}

function strictModule(spec, obj) {
  return new Proxy(obj, {
    get(t, k) {
      if (typeof k === 'symbol' || k === 'then') return t[k];
      if (!(k in t)) throw new Error(`harness: ${spec} has no stub for "${String(k)}"`);
      return t[k];
    },
  });
}

function makeEl(id) {
  return {
    id, value: '', textContent: '', style: {}, disabled: false, _attrs: {}, _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    removeAttribute(k) { delete this._attrs[k]; },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

/**
 * Evaluate register.js with stubbed SDKs.
 * @param {{ emulator?: boolean, key?: string|undefined, warm?: 'pending'|'resolve'|'reject', popupError?: object }} opt
 */
async function runRegister(opt = {}) {
  const calls = [];
  const timers = [];
  const warns = [];
  let settleWarm;
  const APPCHECK = { __appCheck: true };
  const warmPromise = opt.warm === 'reject'
    ? Promise.reject(Object.assign(new Error('recaptcha blocked'), { code: 'appCheck/recaptcha-error' }))
    : new Promise((res) => { settleWarm = res; if (opt.warm === 'resolve') res({ token: 't' }); });
  const els = {};
  for (const id of ['regPlanBanner', 'regForm', 'googleRegBtn', 'regCode', 'regPass', 'regErr', 'regOk',
    'regFirst', 'regLast', 'regCompany', 'regEmail', 'regConfirm', 'regBtn', 'strengthBar', 'regTerms', 'regTermsErr']) els[id] = makeEl(id);
  // Clickwrap box (2026-10-03): ticked unless a case says otherwise.
  els.regTerms.checked = opt.terms !== false;
  els.regTerms.focus = () => {};

  const SDK = '/assets/vendor/firebase/10.12.2/';
  const stubs = {
    [SDK + 'firebase-app.js']: { initializeApp: () => { calls.push('initializeApp'); return { name: '[DEFAULT]' }; } },
    [SDK + 'firebase-app-check.js']: {
      initializeAppCheck: (app, o) => { calls.push('initializeAppCheck'); return APPCHECK; },
      ReCaptchaEnterpriseProvider: class { constructor(k) { this.key = k; } },
      getToken: (instance, forceRefresh) => { calls.push({ getToken: instance === APPCHECK, forceRefresh }); return warmPromise; },
    },
    [SDK + 'firebase-auth.js']: {
      getAuth: () => { calls.push('getAuth'); return { currentUser: null }; },
      createUserWithEmailAndPassword: async () => { throw new Error('not in this harness'); },
      updateProfile: async () => {},
      GoogleAuthProvider: class {},
      signInWithPopup: async () => {
        calls.push('signInWithPopup');
        if (opt.popupError) throw opt.popupError;
        throw new Error('harness: success path not modelled');
      },
      signInWithCustomToken: async () => {},
      sendEmailVerification: async () => {},
    },
    [SDK + 'firebase-firestore.js']: {
      getFirestore: () => ({}), doc: () => ({}), setDoc: async () => {}, getDoc: async () => ({ exists: () => true }),
      serverTimestamp: () => 'ts',
    },
    [SDK + 'firebase-functions.js']: { getFunctions: () => ({}), httpsCallable: () => async () => ({ data: {} }) },
    '../nbd-emulator-connect.js': {
      connectEmulatorsIfLocal: async () => !!opt.emulator,
      emulatorAppCheckIfLocal: async () => !!opt.emulator,
    },
    '../provisioning-retry.js': { ensureProvisioned: async () => {} },
  };
  const window = {
    location: { search: '', href: '', replace() {} },
    ...(opt.key === undefined ? {} : { __NBD_APP_CHECK_KEY: opt.key }),
  };
  const ctx = vm.createContext({
    __imports: (spec) => {
      if (!stubs[spec]) throw new Error('harness: register.js imports an unstubbed module: ' + spec);
      return strictModule(spec, stubs[spec]);
    },
    window,
    document: {
      readyState: 'complete',
      getElementById: (id) => els[id] || null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    sessionStorage: { getItem: () => null, setItem() {} },
    URLSearchParams,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    console: { warn: (...a) => warns.push(a), log() {}, info() {}, error() {} },
  });
  await vm.runInContext(toScript(REGISTER_SRC), ctx, { filename: REGISTER_REL });
  await flush();
  return {
    els, calls, timers, warns,
    settleWarm: () => settleWarm && settleWarm({ token: 't' }),
    async click() {
      const fns = els.googleRegBtn._listeners.click || [];
      for (const fn of fns) await fn({ preventDefault() {} });
      await flush();
    },
  };
}

async function partB() {
  group('B. App Check token is warmed at load; the Google button waits for it');

  const cold = await runRegister({ key: 'site-key', warm: 'pending' });
  const tokenCalls = cold.calls.filter((c) => c && typeof c === 'object' && 'getToken' in c);
  assert('production path calls App Check getToken() at load, on the instance initializeAppCheck returned',
    tokenCalls.length === 1 && tokenCalls[0].getToken === true && !tokenCalls[0].forceRefresh,
    'calls: ' + JSON.stringify(cold.calls));
  assert('…and App Check is still initialised before getAuth (C-4 ordering)',
    cold.calls.indexOf('initializeAppCheck') > -1
    && cold.calls.indexOf('initializeAppCheck') < cold.calls.indexOf('getAuth'),
    'calls: ' + JSON.stringify(cold.calls));
  const btn = cold.els.googleRegBtn;
  assert('the Google button has its click handler', (btn._listeners.click || []).length === 1);
  assert('while the token is in flight the button is disabled and aria-busy',
    btn.disabled === true && btn.getAttribute('aria-busy') === 'true');
  const hold = cold.timers.find((t) => t.ms >= 1000 && t.ms <= 5000);
  assert('a short (1–5 s) fallback timer is armed so the button can never stay dead',
    !!hold, 'timers: ' + JSON.stringify(cold.timers.map((t) => t.ms)));
  cold.settleWarm();
  await flush();
  assert('the token landing re-enables the button and clears aria-busy',
    btn.disabled === false && btn.getAttribute('aria-busy') === null);

  const stuck = await runRegister({ key: 'site-key', warm: 'pending' });
  const stuckHold = stuck.timers.find((t) => t.ms >= 1000 && t.ms <= 5000);
  if (stuckHold) stuckHold.fn();
  await flush();
  assert('a token that never arrives still releases the button when the timer fires',
    stuck.els.googleRegBtn.disabled === false && stuck.els.googleRegBtn.getAttribute('aria-busy') === null);

  const failing = await runRegister({ key: 'site-key', warm: 'reject' });
  assert('a failed token fetch (reCAPTCHA blocked) releases the button at once — no unhandled rejection',
    failing.els.googleRegBtn.disabled === false);

  const emu = await runRegister({ emulator: true, key: 'site-key', warm: 'pending' });
  assert('emulator path: no production getToken, button never held',
    !emu.calls.some((c) => c && typeof c === 'object' && 'getToken' in c)
    && emu.els.googleRegBtn.disabled === false && emu.timers.length === 0);

  const nokey = await runRegister({ key: undefined, warm: 'pending' });
  assert('no App Check key: nothing awaited before window.open, so the button is not held',
    !nokey.calls.includes('initializeAppCheck') && nokey.els.googleRegBtn.disabled === false);
}

async function partC() {
  group('C. #regErr copy for each Google sign-in failure (through the real catch block)');
  const cases = [
    ['auth/operation-not-allowed', "Google sign-in isn't available yet — please sign up with email."],
    ['auth/popup-closed-by-user', 'Sign-in window closed before finishing. Try again, or sign up with email.'],
    ['auth/popup-blocked', 'Your browser blocked the Google window — allow pop-ups for this site or sign up with email.'],
    ['auth/account-exists-with-different-credential', null],
    ['auth/cancelled-popup-request', ''],
    ['auth/internal-error', null],
    [undefined, null],
  ];
  for (const [code, expected] of cases) {
    const err = Object.assign(new Error(`Firebase: Error (${code || 'unknown'}).`), code ? { code } : {});
    const h = await runRegister({ emulator: true, popupError: err });
    h.els.regErr.textContent = 'stale text from an earlier attempt';
    await h.click();
    const got = h.els.regErr.textContent;
    const label = code || '(no code)';
    assert(`${label}: signInWithPopup was actually reached by the click`, h.calls.includes('signInWithPopup'));
    if (expected !== null) {
      assert(`${label} → ${JSON.stringify(expected)}`, got === expected, 'got ' + JSON.stringify(got));
    } else if (code === 'auth/account-exists-with-different-credential') {
      assert(`${label} → tells them to log in with email + password`,
        /already has an account/i.test(got) && /log in with your email and password/i.test(got),
        'got ' + JSON.stringify(got));
    } else {
      assert(`${label} → a fallback that points at email signup`,
        /try again, or sign up with email\.$/i.test(got)
        && (code ? got.includes('(' + code + ')') : /^Google sign-in failed\. /.test(got)),
        'got ' + JSON.stringify(got));
    }
    assert(`${label}: no raw Firebase text and no old "Sign-in cancelled." copy`,
      !/Firebase:|Sign-in cancelled\./.test(got), 'got ' + JSON.stringify(got));
  }
  // Clickwrap (2026-10-03): the Google path is gated by the same required box.
  {
    const h = await runRegister({ emulator: true, terms: false });
    await h.click();
    assert('Terms box unticked: Google sign-up never opens the popup', !h.calls.includes('signInWithPopup'));
    assert('Terms box unticked: says to agree to the Terms of Service and Privacy Policy',
      /agree to the Terms of Service and Privacy Policy/.test(h.els.regTermsErr.textContent), 'got ' + JSON.stringify(h.els.regTermsErr.textContent));
  }
  // ...and the email form path too: a fully valid form is refused until the box is ticked.
  for (const ticked of [false, true]) {
    const h = await runRegister({ emulator: true, terms: ticked });
    Object.assign(h.els.regFirst, { value: 'Sam' }); Object.assign(h.els.regEmail, { value: 'sam@example.com' });
    Object.assign(h.els.regPass, { value: 'pw-123456789' }); Object.assign(h.els.regConfirm, { value: 'pw-123456789' });
    for (const fn of (h.els.regForm._listeners.submit || [])) { await fn({ preventDefault() {} }); }
    await flush();
    const msg = h.els.regErr.textContent;
    if (!ticked) assert('email sign-up with the Terms box unticked → refused with the agree message', /agree to the Terms of Service and Privacy Policy/.test(msg), 'got ' + JSON.stringify(msg));
    else assert('email sign-up with the box ticked → gets past the Terms gate', !/agree to the Terms/.test(msg), 'got ' + JSON.stringify(msg));
  }
}

/* ══════════════════════════════════════════════════════════════════
   D + E. login.js, executed for real in a vm
   "Continue with Google" on /pro/login is SIGN-IN ONLY: a Google identity
   whose users/{uid} exists goes to POST_LOGIN_DEST; one without is signed
   back out and pointed at /pro/register — nothing is provisioned (no
   users/{uid} write, no createCompany, no ensureProvisioned).
   ══════════════════════════════════════════════════════════════════ */
const LOGIN_REL = 'docs/pro/js/pages/login.js';
const LOGIN_SRC = read(path.join(ROOT, LOGIN_REL));

// A DOM element just rich enough for login.js: classList, attributes that
// mirror .disabled, textContent that replaces children, appendChild, and an
// innerHTML that is COUNTED (the no-account message must be built with DOM
// APIs, never interpolated markup).
function makeLoginEl(id, tag = 'div') {
  return {
    id, tagName: tag.toUpperCase(), value: '', type: '', checked: false, style: {}, href: '',
    _disabled: false, _attrs: {}, _listeners: {}, children: [], _text: '', innerHTMLWrites: 0,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    get disabled() { return this._disabled; },
    set disabled(v) { this._disabled = !!v; },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); this.children = []; },
    get innerHTML() { return this.textContent; },
    set innerHTML(v) { this.innerHTMLWrites++; this._text = String(v); this.children = []; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'disabled') this._disabled = true; },
    removeAttribute(k) { delete this._attrs[k]; if (k === 'disabled') this._disabled = false; },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    focus() {},
  };
}

/**
 * Evaluate login.js with stubbed SDKs.
 * @param {{ emulator?: boolean, key?: string|undefined, warm?: 'pending'|'resolve'|'reject',
 *           search?: string, popupError?: object, profileExists?: boolean, profileError?: object }} opt
 */
async function runLogin(opt = {}) {
  const calls = [];
  const timers = [];
  const writes = [];     // any Firestore write or provisioning call — must stay empty
  const replaced = [];   // window.location.replace targets
  let settleWarm;
  const APPCHECK = { __appCheck: true };
  const AUTH = { currentUser: null, __auth: true };
  const warmPromise = opt.warm === 'reject'
    ? Promise.reject(Object.assign(new Error('recaptcha blocked'), { code: 'appCheck/recaptcha-error' }))
    : new Promise((res) => { settleWarm = res; if (opt.warm === 'resolve') res({ token: 't' }); });

  const els = {};
  const ids = ['emailInput', 'passwordInput', 'loginBtn', 'loginError', 'loginErrorMsg', 'rememberMe', 'togglePw',
    'mainView', 'resetView', 'loginForm', 'googleLoginBtn', 'showResetBtn', 'backToLogin', 'resetForm', 'resetEmail',
    'resetBtn', 'resetError', 'resetErrorMsg', 'resetSuccess', 'codeInput', 'codeBtn', 'codeError', 'codeErrorMsg',
    'demoBtn', 'demoError', 'demoErrorMsg', 'view-member', 'view-code', 'view-demo', 'tab-member', 'tab-code', 'tab-demo'];
  for (const id of ids) els[id] = makeLoginEl(id);
  // login.html ships these disabled until login.js has wired them.
  for (const id of ['loginBtn', 'codeBtn', 'demoBtn', 'googleLoginBtn']) els[id].setAttribute('disabled', '');

  const SDK = '/assets/vendor/firebase/10.12.2/';
  const write = (name) => async (...a) => { writes.push({ name, path: a[0] && a[0].path }); };
  const stubs = {
    [SDK + 'firebase-app.js']: { initializeApp: () => { calls.push('initializeApp'); return { name: '[DEFAULT]' }; } },
    [SDK + 'firebase-app-check.js']: {
      initializeAppCheck: () => { calls.push('initializeAppCheck'); return APPCHECK; },
      ReCaptchaEnterpriseProvider: class { constructor(k) { this.key = k; } },
      getToken: (instance, forceRefresh) => { calls.push({ getToken: instance === APPCHECK, forceRefresh }); return warmPromise; },
    },
    [SDK + 'firebase-auth.js']: {
      getAuth: () => { calls.push('getAuth'); return AUTH; },
      signInWithEmailAndPassword: async () => { throw new Error('not in this harness'); },
      signInWithCustomToken: async () => { throw new Error('not in this harness'); },
      sendPasswordResetEmail: async () => {},
      setPersistence: async (a, p) => { calls.push({ setPersistence: p }); },
      browserLocalPersistence: 'LOCAL', browserSessionPersistence: 'SESSION',
      GoogleAuthProvider: class { constructor() { this.providerId = 'google.com'; } },
      signInWithPopup: async (a, provider) => {
        calls.push({ signInWithPopup: provider && provider.providerId, auth: a === AUTH });
        if (opt.popupError) throw opt.popupError;
        AUTH.currentUser = { uid: 'g-uid-1', email: 'someone@gmail.com', displayName: 'Some One' };
        return { user: AUTH.currentUser };
      },
      signOut: async (a) => { calls.push({ signOut: a === AUTH }); AUTH.currentUser = null; },
      // Present so a mutation that imports them is RECORDED, not a crash.
      createUserWithEmailAndPassword: write('createUserWithEmailAndPassword'),
      updateProfile: write('updateProfile'),
    },
    [SDK + 'firebase-firestore.js']: {
      getFirestore: () => ({}),
      doc: (db, ...segs) => ({ path: segs.join('/') }),
      getDoc: async (ref) => {
        calls.push({ getDoc: ref.path });
        if (opt.profileError) throw opt.profileError;
        return { exists: () => !!opt.profileExists };
      },
      setDoc: write('setDoc'), addDoc: write('addDoc'), updateDoc: write('updateDoc'),
      serverTimestamp: () => 'ts',
    },
    [SDK + 'firebase-functions.js']: {
      getFunctions: () => ({}),
      httpsCallable: (fns, name) => async (data) => {
        if (name !== 'validateAccessCode') writes.push({ name: 'callable:' + name, data });
        return { data: {} };
      },
    },
    '../nbd-emulator-connect.js': {
      connectEmulatorsIfLocal: async () => !!opt.emulator,
      emulatorAppCheckIfLocal: async () => !!opt.emulator,
    },
    '../provisioning-retry.js': { ensureProvisioned: write('ensureProvisioned') },
  };
  const window = {
    location: { search: opt.search || '', href: '', replace(u) { replaced.push(u); } },
    ...(opt.key === undefined ? {} : { __NBD_APP_CHECK_KEY: opt.key }),
  };
  const ctx = vm.createContext({
    __imports: (spec) => {
      if (!stubs[spec]) throw new Error('harness: login.js imports an unstubbed module: ' + spec);
      return strictModule(spec, stubs[spec]);
    },
    window,
    navigator: {},
    document: {
      readyState: 'complete',
      getElementById: (id) => els[id] || null,
      querySelectorAll: (sel) => (sel === '.tab-btn' ? [els['tab-member'], els['tab-code'], els['tab-demo']] : []),
      createElement: (tag) => makeLoginEl('', tag),
      addEventListener() {},
    },
    sessionStorage: { _m: {}, getItem(k) { return k in this._m ? this._m[k] : null; }, setItem(k, v) { this._m[k] = String(v); } },
    URLSearchParams,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    console: { warn() {}, log() {}, info() {}, error() {} },
  });
  await vm.runInContext(toScript(LOGIN_SRC), ctx, { filename: LOGIN_REL });
  await flush();
  return {
    els, calls, timers, writes, replaced, AUTH,
    settleWarm: () => settleWarm && settleWarm({ token: 't' }),
    async click() {
      const fns = els.googleLoginBtn._listeners.click || [];
      for (const fn of fns) await fn({ preventDefault() {} });
      await flush();
    },
  };
}

const callsOf = (h, key) => h.calls.filter((c) => c && typeof c === 'object' && key in c);

async function partD() {
  group('D. /pro/login: App Check token is warmed at load; the Google button waits for it');
  const cold = await runLogin({ key: 'site-key', warm: 'pending' });
  const tok = callsOf(cold, 'getToken');
  assert('production path calls App Check getToken() at load, on the instance initializeAppCheck returned',
    tok.length === 1 && tok[0].getToken === true && !tok[0].forceRefresh, 'calls: ' + JSON.stringify(cold.calls));
  assert('…and App Check is initialised before getAuth',
    cold.calls.indexOf('initializeAppCheck') > -1 && cold.calls.indexOf('initializeAppCheck') < cold.calls.indexOf('getAuth'),
    'calls: ' + JSON.stringify(cold.calls));
  const btn = cold.els.googleLoginBtn;
  assert('#googleLoginBtn has exactly one click handler', (btn._listeners.click || []).length === 1);
  assert('while the token is in flight the button is disabled and aria-busy',
    btn.disabled === true && btn.getAttribute('aria-busy') === 'true');
  const hold = cold.timers.find((t) => t.ms >= 1000 && t.ms <= 5000);
  assert('a short (1–5 s) fallback timer is armed', !!hold, 'timers: ' + JSON.stringify(cold.timers.map((t) => t.ms)));
  cold.settleWarm();
  await flush();
  assert('the token landing re-enables the button and clears aria-busy',
    btn.disabled === false && btn.getAttribute('aria-busy') === null);

  const stuck = await runLogin({ key: 'site-key', warm: 'pending' });
  const stuckHold = stuck.timers.find((t) => t.ms >= 1000 && t.ms <= 5000);
  if (stuckHold) stuckHold.fn();
  await flush();
  assert('a token that never arrives still releases the button when the timer fires',
    stuck.els.googleLoginBtn.disabled === false);

  const failing = await runLogin({ key: 'site-key', warm: 'reject' });
  assert('a failed token fetch releases the button at once — no unhandled rejection',
    failing.els.googleLoginBtn.disabled === false);

  const emu = await runLogin({ emulator: true, key: 'site-key', warm: 'pending' });
  assert('emulator path: no production getToken, and the HTML-disabled button is enabled once wired',
    callsOf(emu, 'getToken').length === 0 && emu.els.googleLoginBtn.disabled === false && emu.timers.length === 0);

  const nokey = await runLogin({ key: undefined, warm: 'pending' });
  assert('no App Check key: App Check not initialised, button not held',
    !nokey.calls.includes('initializeAppCheck') && nokey.els.googleLoginBtn.disabled === false);

  assert('the email form is still wired (#loginBtn enabled after module load)', emu.els.loginBtn.disabled === false);
}

async function partE() {
  group('E. /pro/login Google sign-in: existing member in, stranger out — nothing provisioned');

  for (const [search, dest] of [['', '/pro/dashboard.html'], ['?redirect=pricing', '/pro/pricing.html'], ['?plan=growth', '/pro/pricing.html']]) {
    const h = await runLogin({ emulator: true, profileExists: true, search });
    await h.click();
    const label = 'existing users/{uid}' + (search ? ' + ' + search : '');
    const popup = callsOf(h, 'signInWithPopup')[0];
    assert(label + ': signInWithPopup with a Google provider, then users/{uid} is read',
      !!popup && popup.signInWithPopup === 'google.com' && popup.auth === true
      && callsOf(h, 'getDoc').some((c) => c.getDoc === 'users/g-uid-1'), JSON.stringify(h.calls));
    assert(label + ' → location.replace(' + JSON.stringify(dest) + ')',
      h.replaced.length === 1 && h.replaced[0] === dest, 'replaced: ' + JSON.stringify(h.replaced));
    assert(label + ': stays signed in (no signOut), remember-me persistence applied, no writes',
      callsOf(h, 'signOut').length === 0 && callsOf(h, 'setPersistence').length === 1 && h.writes.length === 0,
      JSON.stringify({ calls: h.calls, writes: h.writes }));
    assert(label + ': no error shown', !h.els.loginError.classList.contains('show'));
  }

  {
    const h = await runLogin({ emulator: true, profileExists: false });
    await h.click();
    const msg = h.els.loginErrorMsg;
    const link = msg.children.find((c) => c.tagName === 'A');
    assert('no users/{uid}: signed back out (signOut on the page auth instance)',
      callsOf(h, 'signOut').length === 1 && callsOf(h, 'signOut')[0].signOut === true && h.AUTH.currentUser === null,
      JSON.stringify(h.calls));
    assert('no users/{uid}: NOTHING provisioned — no Firestore write, no createCompany, no ensureProvisioned',
      h.writes.length === 0, 'writes: ' + JSON.stringify(h.writes));
    assert('no users/{uid}: no redirect, no persistence change',
      h.replaced.length === 0 && callsOf(h, 'setPersistence').length === 0,
      JSON.stringify({ replaced: h.replaced, calls: h.calls }));
    assert('no users/{uid}: the error shows "No NBD Pro account is linked to that Google account yet."',
      h.els.loginError.classList.contains('show')
      && msg.textContent.startsWith('No NBD Pro account is linked to that Google account yet.'),
      'got ' + JSON.stringify(msg.textContent));
    assert('…with a real <a href="/pro/register"> built by DOM APIs (no innerHTML)',
      !!link && link.href === '/pro/register' && link.textContent.trim().length > 0 && msg.innerHTMLWrites === 0,
      JSON.stringify({ link: link && { href: link.href, text: link.textContent }, innerHTMLWrites: msg.innerHTMLWrites }));
    assert('…and the Google button is usable again', h.els.googleLoginBtn.disabled === false);
  }

  {
    const h = await runLogin({ emulator: true, profileError: Object.assign(new Error('offline'), { code: 'unavailable' }) });
    await h.click();
    assert('profile read fails: fail closed — signed out, not redirected, nothing written',
      callsOf(h, 'signOut').length === 1 && h.replaced.length === 0 && h.writes.length === 0,
      JSON.stringify({ calls: h.calls, replaced: h.replaced, writes: h.writes }));
    assert('…and says it could not check the account',
      /couldn't check your nbd pro account/i.test(h.els.loginErrorMsg.textContent),
      'got ' + JSON.stringify(h.els.loginErrorMsg.textContent));
  }

  const cases = [
    ['auth/operation-not-allowed', "Google sign-in isn't available yet — please sign in with your email and password."],
    ['auth/popup-closed-by-user', 'Sign-in window closed before finishing. Try again, or sign in with your email and password.'],
    ['auth/popup-blocked', 'Your browser blocked the Google window — allow pop-ups for this site or sign in with your email and password.'],
    ['auth/account-exists-with-different-credential', 'This email already has an account that uses a password. Sign in with your email and password instead.'],
    ['auth/cancelled-popup-request', ''],
    ['auth/internal-error', 'Google sign-in failed (auth/internal-error). Try again, or sign in with your email and password.'],
    [undefined, 'Google sign-in failed. Try again, or sign in with your email and password.'],
  ];
  for (const [code, expected] of cases) {
    const err = Object.assign(new Error('Firebase: Error (' + (code || 'unknown') + ').'), code ? { code } : {});
    const h = await runLogin({ emulator: true, popupError: err, profileExists: true });
    h.els.loginErrorMsg.textContent = 'stale text';
    await h.click();
    const label = code || '(no code)';
    const shown = h.els.loginError.classList.contains('show');
    if (expected === '') {
      assert(label + ' → no error shown', !shown);
    } else {
      assert(label + ' → ' + JSON.stringify(expected), shown && h.els.loginErrorMsg.textContent === expected,
        'got ' + JSON.stringify(h.els.loginErrorMsg.textContent));
    }
    assert(label + ': no profile read, no signOut, no redirect, no writes',
      callsOf(h, 'getDoc').length === 0 && callsOf(h, 'signOut').length === 0
      && h.replaced.length === 0 && h.writes.length === 0);
  }
}

// A rejection that escapes register.js (e.g. a warm-up with no rejection
// handler) is a page-console error in the browser; here it must be a named
// failure, not an anonymous process crash.
process.on('unhandledRejection', (e) => {
  failed++;
  console.log('  ✗ a promise rejection escaped register.js/login.js unhandled: ' + ((e && e.message) || e));
});

(async () => {
  try {
    await partB();
    await partC();
    await partD();
    await partE();
  } catch (e) {
    failed++;
    console.log('  ✗ register.js/login.js harness crashed: ' + (e && e.stack || e));
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
