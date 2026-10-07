/* tests/pro-demo-sdk-2026-10-06.test.js
 *
 * Pro demo phase 2, wave 1: the browser-only sample account at /pro/explore.
 * Plan: documentation/projects/PRO-DEMO-PHASE2-FULL-ACCOUNT-PLAN-2026-10-06.md
 *
 * Dependency-free contract checks (the Chromium zero-network walk is
 * tests/pro-demo-zero-network-2026-10-06.test.js):
 *
 *   A. The demo route's EFFECTIVE CSP (computed from firebase.json the way
 *      Hosting applies it, last matching block wins) has connect-src 'self'
 *      and nothing else, names no Firebase/Stripe/Twilio/Sentry host
 *      anywhere, and sends no CSP reports (reports POST to /cspReport, a
 *      Cloud Function). The REAL /pro pages keep their own policy.
 *   B. The rewrites serve the real page files under /pro/explore/.
 *   C. Export parity: every name any CRM file imports from the real
 *      gstatic firebase-*.js is exported by the matching fake in
 *      docs/pro/demo-sdk/, so a newly used SDK function fails here instead of
 *      being silently undefined in the demo (page-scoped-helper rule).
 *   D. The demo service worker never intercepts a navigation and never
 *      fetches the gstatic SDK; demo-mode.js is the first script on both
 *      pages and inert off /pro/explore/.
 *   E. The fake Firestore/Auth/Functions/Storage behave (run here in Node).
 *   F. The seed is generated from the story's SAMPLE, is up to date, holds
 *      retail prices only, invented contact details only, and no Kentucky
 *      insurance sample shows money due at signing.
 *   G. /pro/sandbox's "Explore the whole sample account" stays a disabled
 *      placeholder (a later wave turns it on).
 *   H. Wave 3: the offline map, Storm Center, Agent inbox and Ask Joe.
 *   I. Wave 4: invoices and payments (the REAL deposit rule and Kentucky
 *      hold recomputed over the seed), sample pay links, the direct function
 *      answers (endpoints.js) run here, the production seed, the Settings
 *      "available in your real account" cards and the Ask Joe layout rule.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { effectiveHeaders } = require('./lib/hosting-headers');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SDK_DIR = path.join(DOCS, 'pro', 'demo-sdk');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

let failed = 0;
let passed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
}

const fb = JSON.parse(read('firebase.json'));
const hosting = fb.hosting;

// ── A. CSP ────────────────────────────────────────────────────────────────
console.log('A. demo route CSP');
// fonts.googleapis.com serves static CSS only (style-src); every other googleapis host is an API.
const FORBIDDEN = /(?<!fonts\.)googleapis\.com|firebaseio\.com|cloudfunctions\.net|identitytoolkit|securetoken|firebaseapp\.com|firebasestorage|stripe\.com|twilio|sentry|google-analytics|googletagmanager|recaptcha|cloudflare|clarity|bing\.com|nominatim|weather\.gov|run\.app/i;
function directives(csp) {
  const out = {};
  for (const part of String(csp || '').split(';')) {
    const t = part.trim().split(/\s+/);
    if (t[0]) out[t[0].toLowerCase()] = t.slice(1);
  }
  return out;
}
const DEMO_PATHS = ['/pro/explore', '/pro/explore/dashboard', '/pro/explore/customer', '/pro/explore/demo-sw.js', '/pro/explore/js/crm.js', '/pro/explore/explore-entry.js'];
for (const p of DEMO_PATHS) {
  const h = effectiveHeaders(hosting, p);
  for (const key of ['content-security-policy', 'content-security-policy-report-only']) {
    const hit = h.get(key);
    const d = directives(hit && hit.value);
    ok(p + ' ' + key + ': connect-src is exactly \'self\'', d['connect-src'] && d['connect-src'].join(' ') === "'self'", hit && hit.value);
    ok(p + ' ' + key + ': names no Firebase/Stripe/Twilio/Sentry host', hit && !FORBIDDEN.test(hit.value), hit && (hit.value.match(FORBIDDEN) || [])[0]);
    ok(p + ' ' + key + ': no report-uri / report-to', hit && !d['report-uri'] && !d['report-to']);
    ok(p + ' ' + key + ': form-action \'none\', frame-ancestors \'none\', object-src \'none\'',
      d['form-action'] && d['form-action'].join(' ') === "'none'" && d['frame-ancestors'] && d['frame-ancestors'].join(' ') === "'none'" && d['object-src'] && d['object-src'].join(' ') === "'none'");
  }
  const robots = h.get('x-robots-tag');
  ok(p + ' is noindex', robots && /noindex/.test(robots.value));
}
const demoBlockIdx = hosting.headers.findIndex((b) => b.source === '/pro/explore/**');
const lastProBlock = hosting.headers.map((b, i) => (/^\/(@\(pro|pro)/.test(b.source) || b.source === '**') ? i : -1).filter((i) => i >= 0 && i !== demoBlockIdx && hosting.headers[i].source !== '/pro/explore');
ok('the /pro/explore/** block comes after every /pro and ** block (last match wins)', demoBlockIdx > Math.max.apply(null, lastProBlock));
// The real CRM keeps its own policy (the demo block must not leak onto it).
for (const p of ['/pro/dashboard', '/pro/customer']) {
  const csp = effectiveHeaders(hosting, p).get('content-security-policy');
  ok(p + ' (real) still allows Firestore — the demo block did not leak', csp && /firestore|googleapis/.test(csp.value) && csp.source !== '/pro/explore/**');
}

// ── B. rewrites ───────────────────────────────────────────────────────────
console.log('B. rewrites');
const rw = hosting.rewrites || [];
for (const page of ['dashboard', 'customer']) {
  const i = rw.findIndex((r) => r.source === '/pro/explore/' + page);
  ok('/pro/explore/' + page + ' rewrites to /pro/' + page + '.html', i >= 0 && rw[i].destination === '/pro/' + page + '.html');
  ok('no file shadows the /pro/explore/' + page + ' rewrite', !fs.existsSync(path.join(DOCS, 'pro', 'explore', page + '.html')) && !fs.existsSync(path.join(DOCS, 'pro', 'explore', page)));
}
ok('the entry page and the demo service worker are real files', fs.existsSync(path.join(DOCS, 'pro', 'explore', 'index.html')) && fs.existsSync(path.join(DOCS, 'pro', 'explore', 'demo-sw.js')));

// ── C. export parity ──────────────────────────────────────────────────────
console.log('C. fake SDK export parity');
const SDK_URL = /https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/(firebase-[a-z-]+)\.js|\$\{SDK\}\/(firebase-[a-z-]+)\.js/;
const imported = {}; // module -> Map(name -> file)
const modulesSeen = new Map();
function note(mod, name, file) {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
  (imported[mod] = imported[mod] || new Map()).set(name, file);
}
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'demo-sdk' && e.name !== 'node_modules') walk(p); continue; }
    if (!/\.(js|mjs|html)$/.test(e.name)) continue;
    if (/firebase-messaging-sw\.js$/.test(e.name)) continue; // a service worker of its own, never under /pro/explore
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    const src = fs.readFileSync(p, 'utf8');
    let m;
    const urlRe = new RegExp(SDK_URL.source, 'g');
    while ((m = urlRe.exec(src))) modulesSeen.set(m[1] || m[2], rel);
    const staticRe = /import\s*\{([^}]*)\}\s*from\s*['"`]([^'"`]+)['"`]/g;
    while ((m = staticRe.exec(src))) {
      const u = SDK_URL.exec(m[2]); if (!u) continue;
      for (const part of m[1].split(',')) note(u[1] || u[2], part.trim().split(/\s+as\s+/)[0].trim(), rel);
    }
    const dynRe = /\{([\w\s,:$]*)\}\s*=\s*await\s+import\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    while ((m = dynRe.exec(src))) {
      const u = SDK_URL.exec(m[2]); if (!u) continue;
      for (const part of m[1].split(',')) note(u[1] || u[2], part.trim().split(/\s*:\s*/)[0].trim(), rel);
    }
    // const mod = await import('…/firebase-x.js'); mod.name   and   import('…').then((mod) => mod.name)
    const nsRe = /(?:const|let|var)\s+(\w+)\s*=\s*await\s+import\(\s*['"`]([^'"`]+)['"`]\s*\)|import\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\.then\(\s*\(?\s*(\w+)\s*\)?\s*=>/g;
    while ((m = nsRe.exec(src))) {
      const v = m[1] || m[4];
      const u = SDK_URL.exec(m[2] || m[3]); if (!u || !v) continue;
      const tail = src.slice(m.index, m.index + 2500);
      const useRe = new RegExp('\\b' + v + '\\.([A-Za-z_$][\\w$]*)', 'g');
      let n; while ((n = useRe.exec(tail))) note(u[1] || u[2], n[1], rel);
    }
  }
}
walk(path.join(DOCS, 'pro'));
function exportsOf(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const names = new Set();
  let m;
  const declRe = /export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(src))) names.add(m[1]);
  const listRe = /export\s*\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g;
  while ((m = listRe.exec(src))) {
    for (const part of m[1].split(',')) { const t = part.trim().split(/\s+as\s+/); const n = (t[1] || t[0]).trim(); if (n) names.add(n); }
  }
  return names;
}
const swSrc = read('docs/pro/explore/demo-sw.js');
const fakesInSw = new Set((/const FAKES = new Set\(\[([\s\S]*?)\]\)/.exec(swSrc) || ['', ''])[1].match(/firebase-[a-z-]+/g) || []);
for (const [mod, where] of modulesSeen) {
  if (/-compat$/.test(mod)) continue;
  ok('the demo service worker answers ' + mod + ' (used in ' + where + ')', fakesInSw.has(mod));
  ok('docs/pro/demo-sdk/' + mod + '.js exists', fs.existsSync(path.join(SDK_DIR, mod + '.js')));
}
let parityChecked = 0;
for (const mod of Object.keys(imported).sort()) {
  const file = path.join(SDK_DIR, mod + '.js');
  if (!fs.existsSync(file)) continue;
  const have = exportsOf(file);
  const missing = [];
  for (const [name, where] of imported[mod]) { parityChecked++; if (!have.has(name)) missing.push(name + ' (' + where + ')'); }
  ok(mod + ': fake exports every name the CRM imports (' + imported[mod].size + ')', missing.length === 0, missing.join(', '));
}
ok('parity scan found the CRM imports (not vacuous)', parityChecked >= 60 && imported['firebase-firestore'] && imported['firebase-firestore'].has('onSnapshot') && imported['firebase-functions'] && imported['firebase-functions'].has('httpsCallable'), 'checked ' + parityChecked);

// ── D. service worker + shell contracts ───────────────────────────────────
console.log('D. service worker and demo shell');
const sw = stripComments(swSrc);
const fetchHandler = sw.slice(sw.indexOf("addEventListener('fetch'"));
const navIdx = fetchHandler.search(/if\s*\(\s*req\.mode\s*===\s*'navigate'\s*\)\s*return\s*;/);
const firstRespond = fetchHandler.indexOf('respondWith');
ok('demo-sw.js returns on navigate BEFORE any respondWith (never intercepts navigations)', navIdx >= 0 && firstRespond > navIdx);
ok('demo-sw.js never fetches the request it was handed (no pass-through of gstatic)', !/fetch\(\s*(req|event\.request)\s*[,)]/.test(sw));
ok('demo-sw.js answers the SDK with a same-origin re-export', /export \* from ' \+ JSON\.stringify\(self\.location\.origin \+ '\/pro\/demo-sdk\/'/.test(sw));
ok('demo-sw.js blanks the production config scripts', /dashboard-appcheck-config\.js/.test(sw) && /dashboard-fcm-config\.js/.test(sw) && /sentry-config\.js/.test(sw));
for (const page of ['dashboard', 'customer']) {
  const html = read('docs/pro/' + page + '.html');
  const firstScript = /<script\b[^>]*>/i.exec(html.replace(/<!--[\s\S]*?-->/g, ''));
  ok(page + '.html: demo-mode.js is the first <script>, synchronous', firstScript && /src="\/pro\/js\/demo-mode\.js\?v=\d+"/.test(firstScript[0]) && !/\b(defer|async|type=)/.test(firstScript[0]), firstScript && firstScript[0]);
}
const dm = stripComments(read('docs/pro/js/demo-mode.js'));
const body = dm.slice(dm.indexOf("'use strict';") + 13).trim();
ok('demo-mode.js: its first statements return unless the path is under /pro/explore/',
  /^var PREFIX = '\/pro\/explore\/';\s*if \(typeof location === 'undefined' \|\| location\.pathname\.indexOf\(PREFIX\) !== 0\) return;/.test(body), body.slice(0, 160));
ok('demo-mode.js: refuses to run without the demo service worker', /if \(!sw \|\| !sw\.controller\)\s*\{\s*try \{ window\.stop\(\); \} catch \(_\) \{\}\s*location\.replace\('\/pro\/explore\?next='/.test(dm));
ok('demo-mode.js: wraps fetch, XHR, sendBeacon, WebSocket and EventSource', /window\.fetch = function/.test(dm) && /XMLHttpRequest\.prototype\.send = function/.test(dm) && /navigator\.sendBeacon = function/.test(dm) && /\['WebSocket', 'EventSource'\]/.test(dm));

// ── E/F/G run async (ESM fakes) ───────────────────────────────────────────
(async () => {
  console.log('E. fake SDK behaviour (Node)');
  const seedText = fs.readFileSync(path.join(SDK_DIR, 'sample-company.json'), 'utf8');
  globalThis.fetch = async (u) => {
    if (String(u) === '/pro/demo-sdk/sample-company.json') return { ok: true, status: 200, json: async () => JSON.parse(seedText) };
    throw new Error('unexpected fetch in Node test: ' + u);
  };
  const imp = (n) => import(pathToFileURL(path.join(SDK_DIR, n)).href);
  const F = await imp('firebase-firestore.js');
  const A = await imp('firebase-auth.js');
  const FN = await imp('firebase-functions.js');
  const ST = await imp('firebase-storage.js');
  const APP = await imp('firebase-app.js');
  const app = APP.initializeApp({ apiKey: 'real-looking', projectId: 'nobigdeal-pro' });
  ok('initializeApp ignores the real config and tags the app', app.__nbdDemo === true && app.options.projectId === 'sample-account');
  const db = F.getFirestore(app);
  const uid = 'demo-owner';

  const all = await F.getDocs(F.query(F.collection(db, 'leads'), F.where('userId', '==', uid)));
  ok('leads query returns the seeded sample leads', all.size >= 20, 'size ' + all.size);
  const p1 = await F.getDocs(F.query(F.collection(db, 'leads'), F.where('userId', '==', uid), F.limit(10)));
  const p2 = await F.getDocs(F.query(F.collection(db, 'leads'), F.where('userId', '==', uid), F.startAfter(p1.docs[p1.docs.length - 1]), F.limit(10)));
  const overlap = p1.docs.filter((d) => p2.docs.some((e) => e.id === d.id));
  ok('limit + startAfter pages without overlap (the dashboard\'s 500-page loop)', p1.size === 10 && p2.size === 10 && overlap.length === 0);
  const ins = await F.getDocs(F.query(F.collection(db, 'leads'), F.where('jobType', '==', 'insurance'), F.where('state', 'in', ['KY']), F.orderBy('jobValue', 'desc')));
  const vals = ins.docs.map((d) => d.data().jobValue);
  ok('where ==, in and orderBy desc compose', ins.size > 0 && vals.every((v, i) => i === 0 || vals[i - 1] >= v) && ins.docs.every((d) => d.data().state === 'KY'));
  const lead = await F.getDoc(F.doc(db, 'leads', 'sample-lead-01'));
  ok('getDoc reads the story lead with a real Timestamp', lead.exists() && lead.data().createdAt instanceof F.Timestamp && typeof lead.data().createdAt.toDate === 'function');
  const d0 = lead.data(); d0.stage = 'mutated';
  ok('data() is a copy (mutating it does not edit the store)', (await F.getDoc(F.doc(db, 'leads', 'sample-lead-01'))).data().stage !== 'mutated');

  let fired = 0, lastStage = '';
  const off = F.onSnapshot(F.doc(db, 'leads', 'sample-lead-02'), (s) => { fired++; lastStage = s.data().stage; });
  let qFired = 0, lastChanges = [];
  const offQ = F.onSnapshot(F.query(F.collection(db, 'leads'), F.where('stage', '==', 'contacted')), (s) => { qFired++; lastChanges = s.docChanges().map((c) => c.type + ':' + c.doc.id); });
  await new Promise((r) => setTimeout(r, 20));
  await F.updateDoc(F.doc(db, 'leads', 'sample-lead-02'), { stage: 'contacted', 'meta.touched': true, stageHistory: F.arrayUnion({ to: 'contacted' }), touches: F.increment(2), updatedAt: F.serverTimestamp() });
  await new Promise((r) => setTimeout(r, 20));
  const after = (await F.getDoc(F.doc(db, 'leads', 'sample-lead-02'))).data();
  ok('updateDoc applies dotted paths, arrayUnion, increment and serverTimestamp', after.meta && after.meta.touched === true && Array.isArray(after.stageHistory) && after.touches === 2 && after.updatedAt instanceof F.Timestamp);
  ok('onSnapshot(doc) fires on the initial read and on the write', fired === 2 && lastStage === 'contacted', 'fired ' + fired);
  ok('onSnapshot(query) reports the lead entering the filter as "added"', qFired >= 2 && lastChanges.includes('added:sample-lead-02'), JSON.stringify(lastChanges));
  off(); offQ();
  let threw = '';
  try { await F.updateDoc(F.doc(db, 'leads', 'no-such-lead'), { stage: 'x' }); } catch (e) { threw = e.code; }
  ok('updateDoc on a missing document rejects not-found (like Firestore)', threw === 'not-found');
  const ref = await F.addDoc(F.collection(db, 'leads', 'sample-lead-01', 'tasks'), { text: 'demo task', done: false });
  const tasks = await F.getDocs(F.collection(db, 'leads', 'sample-lead-01', 'tasks'));
  ok('addDoc writes a subcollection doc with an auto id', /^[A-Za-z0-9]{20}$/.test(ref.id) && tasks.docs.some((d) => d.id === ref.id));
  const b = F.writeBatch(db);
  b.set(F.doc(db, 'notes', 'n-test'), { text: 'a' }); b.update(F.doc(db, 'leads', 'sample-lead-01'), { batchTouched: true });
  await b.commit();
  ok('writeBatch commits set + update', (await F.getDoc(F.doc(db, 'notes', 'n-test'))).exists() && (await F.getDoc(F.doc(db, 'leads', 'sample-lead-01'))).data().batchTouched === true);
  const txOut = await F.runTransaction(db, async (tx) => { const s = await tx.get(F.doc(db, 'leads', 'sample-lead-01')); tx.update(s.ref, { txStage: s.data().stage }); return 'done'; });
  ok('runTransaction reads then writes', txOut === 'done' && (await F.getDoc(F.doc(db, 'leads', 'sample-lead-01'))).data().txStage === 'estimate_submitted');
  const cnt = await F.getCountFromServer(F.query(F.collection(db, 'leads'), F.where('stage', '==', 'lost')));
  ok('getCountFromServer counts', cnt.data().count === 1);
  const sub = await F.getDoc(F.doc(db, 'subscriptions', uid));
  ok('the sample company has a subscription doc (no upgrade wall)', sub.exists() && sub.data().status === 'active');

  const auth = A.getAuth(app);
  const user = await new Promise((r) => A.onAuthStateChanged(auth, r));
  const tok = await user.getIdTokenResult();
  ok('auth: one signed-in sample owner with a companyId claim', user.uid === uid && tok.claims.companyId === uid && auth.currentUser === user);
  let signInErr = '';
  try { await A.signInWithEmailAndPassword(auth, 'a@b.c', 'x'); } catch (e) { signInErr = e.code; }
  ok('auth: real sign-in rejects honestly', signInErr === 'auth/operation-not-allowed');

  const fns = FN.getFunctions(app);
  const canned = await FN.httpsCallable(fns, 'claimInvite')({});
  ok('functions: boot-time callables get a canned answer', canned.data && canned.data.reason === 'no_invite');
  let cErr = null;
  try { await FN.httpsCallable(fns, 'sendEstimateEnvelope')({ to: 'x@example.com' }); } catch (e) { cErr = e; }
  ok('functions: a send/charge callable rejects with what it WOULD do, never a fake success', cErr && cErr.code === 'functions/failed-precondition' && /In your real account this would email the estimate/.test(cErr.message));
  let uErr = null;
  try { await FN.httpsCallable(fns, 'someBrandNewCallable')({}); } catch (e) { uErr = e; }
  ok('functions: an unknown callable rejects clearly instead of hanging', uErr && /not in the sample account/.test(uErr.message));

  const st = ST.getStorage(app);
  const r1 = ST.ref(st, 'photos/sample-lead-01/a.jpg');
  await ST.uploadBytes(r1, new Blob(['x'], { type: 'image/jpeg' }));
  const url = await ST.getDownloadURL(r1);
  ok('storage: an upload stays local (blob: URL, no bucket host)', /^blob:/.test(url));

  // ── F. seed ─────────────────────────────────────────────────────────────
  console.log('F. seed');
  const { build, readSample } = require('../scripts/build-demo-seed.js');
  const fresh = JSON.stringify(build(), null, 1) + '\n';
  ok('sample-company.json is up to date with build-demo-seed.js + the story SAMPLE', fresh === seedText.replace(/\r\n/g, '\n'), 'run: node scripts/build-demo-seed.js');
  const seed = JSON.parse(seedText);
  const S = readSample();
  const story = seed.docs['leads/sample-lead-01'];
  const preferred = S.tiers.find((t) => t.key === 'better');
  ok('the story customer, street, carrier and Preferred price come from the story SAMPLE',
    story && story.name === S.customer && story.address.startsWith(S.street) && story.insuranceCarrier === S.carrier && story.jobValue === preferred.priceCents / 100 && seed.company.name === S.company);
  const badKeys = [];
  (function scan(v, at) {
    if (v && typeof v === 'object') for (const k of Object.keys(v)) {
      if (/cost|margin|contractor|wholesale|profit|markup|overhead/i.test(k)) badKeys.push(at + '.' + k);
      scan(v[k], at + '.' + k);
    }
  })(seed.docs, 'docs');
  ok('seed carries no cost/margin/contractor keys (retail only)', badKeys.length === 0, badKeys.slice(0, 5).join(', '));
  const leads = Object.entries(seed.docs).filter(([p]) => /^leads\/[^/]+$/.test(p)).map(([, d]) => d);
  ok('about 25 leads, every stage group, OH and KY, insurance and retail, one lost',
    leads.length >= 24 && leads.some((l) => l.state === 'OH') && leads.some((l) => l.state === 'KY') &&
    leads.some((l) => l.jobType === 'insurance') && leads.some((l) => l.jobType === 'cash') && leads.filter((l) => l.stage === 'lost').length === 1 &&
    leads.some((l) => l.stage === 'new') && leads.some((l) => l.stage === 'contract_signed') && leads.some((l) => l.stage === 'closed'));
  ok('every phone is a fictional 555-01xx number', leads.every((l) => /\) 555-01\d\d$/.test(l.phone)));
  ok('every email is @example.com', leads.every((l) => /@example\.com$/.test(l.email)));
  ok('every street is an invented Sample/Example/Placeholder street', leads.every((l) => /\b(Sample|Example|Placeholder)\b/.test(l.address)));
  const kyIns = leads.filter((l) => l.state === 'KY' && l.jobType === 'insurance');
  const dueKeys = [];
  for (const l of kyIns) for (const k of Object.keys(l)) if (/deposit|dueAtSign|due_at_sign|downPayment|aob|assignment/i.test(k)) dueKeys.push(l.name + '.' + k);
  ok('no Kentucky insurance sample carries a deposit / due-at-signing / AOB field', kyIns.length > 3 && dueKeys.length === 0, dueKeys.join(', '));
  const seedText2 = JSON.stringify(seed.docs);
  ok('no lifetime or claim-outcome promise in the seed copy', !/lifetime|guarantee(d)? (approval|coverage)|we('| wi)ll get (it|your claim) (approved|paid)/i.test(seedText2));

  // ── H. wave 3: the maps, Storm Center, Agent inbox and Ask Joe ──────────
  console.log('H. wave 3 (D2D, Storm Center, Agent inbox, Ask Joe)');
  const vm = require('vm');
  const D = seed.docs;
  // H1. The offline sample map: drawn here, never fetched.
  const bmSrc = read('docs/pro/demo-sdk/basemap.js');
  const bmCtx = { Math, Object, String, Number, Array, JSON };
  bmCtx.window = bmCtx;
  vm.runInNewContext(bmSrc, bmCtx);
  const BM = bmCtx.NBD_DEMO_BASEMAP;
  const NET = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|EventSource|\bimport\s*\(|\.src\s*=/;
  for (const f of ['basemap.js', 'offline.js', 'ask-joe-canned.js', 'claude-proxy.js']) {
    const code = stripComments(read('docs/pro/demo-sdk/' + f));
    ok('demo-sdk/' + f + ' makes no request of its own (no fetch / XHR / beacon / socket / import() / .src=)', !NET.test(code), (code.match(NET) || [])[0]);
  }
  ok('basemap.js names no other site (only the SVG namespace)', (stripComments(bmSrc).match(/https?:\/\/[^'"\s)]+/g) || []).every((u) => u === 'http://www.w3.org/2000/svg'));
  ok('basemap.js: a base map is drawn, the USGS underlay and radar / label / Kentucky overlays draw nothing live',
    BM.roleFor('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { zIndex: -1 }) === 'base' &&
    BM.roleFor('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', {}) === 'underlay' &&
    BM.roleFor('https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png', { opacity: 0.6 }) === 'overlay' &&
    BM.roleFor('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { zIndex: 0 }) === 'overlay' &&
    BM.roleFor('https://kygisserver.ky.gov/arcgis/rest/services/x/MapServer/tile/{z}/{y}/{x}', { zIndex: 0 }) === 'overlay');
  // install() on a stand-in Leaflet: L.tileLayer stops making tile layers.
  const fakeL = { GridLayer: { extend(proto) { function C(o) { this.options = Object.assign({}, proto.options, o); } Object.assign(C.prototype, proto); return C; }, prototype: {} }, tileLayer() { throw new Error('a real tile layer was made'); } };
  BM.install(fakeL);
  let swapped = null;
  try { swapped = fakeL.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { zIndex: -1 }); } catch (e) { swapped = e; }
  ok('basemap.install(L) swaps L.tileLayer for the drawn sample map (imagery look, sample attribution)',
    swapped && !(swapped instanceof Error) && swapped.options.role === 'base' && swapped.options.variant === 'imagery' && /Sample map: invented streets/.test(swapped.options.attribution) && typeof fakeL.tileLayer.wms === 'function', swapped && swapped.message);
  const streets = (BM.DATA.roads || []).map((r) => r.name);
  ok('every street on the sample map is invented (Sample / Example / Placeholder / Demo / Test / Mock)', streets.length >= 8 && streets.every((n) => /\b(Sample|Example|Placeholder|Demo|Test|Mock)\b/.test(n)), streets.join(', '));

  // H2. Knocks, the swath, the territory, the Storm Center zone and alert.
  const houses = new Map(BM.houses().map((h) => [h.address + ', ' + seed.offline.city, h]));
  const coreSrc = read('docs/pro/js/d2d-tracker-core-2026b.js');
  const dispoKeys = new Set(Array.from((/const DISPOSITIONS = \{([\s\S]*?)\n {2}\};/.exec(coreSrc) || ['', ''])[1].matchAll(/^\s{4}(\w+):\s*\{/gm)).map((m) => m[1]));
  const knocks = Object.entries(D).filter(([p]) => /^knocks\//.test(p)).map(([, d]) => d);
  ok('the D2D disposition list was read from the real tracker (not vacuous)', dispoKeys.size >= 14 && dispoKeys.has('not_home') && dispoKeys.has('appointment'));
  ok('~70 sample knocks, every one a real disposition, by the sample owner, with a createdAt (orderBy needs it)',
    knocks.length >= 50 && knocks.every((k) => dispoKeys.has(k.disposition) && k.userId === 'demo-owner' && k.companyId === 'demo-owner' && k.createdAt && k.createdAt.__ts),
    knocks.filter((k) => !dispoKeys.has(k.disposition)).map((k) => k.disposition).join(','));
  ok('every knock sits on a house of the sample map (its address and coordinates)', knocks.every((k) => { const h = houses.get(k.address); return h && h.lat === k.lat && h.lng === k.lng; }),
    knocks.filter((k) => !houses.has(k.address)).map((k) => k.address).slice(0, 3).join(' | '));
  const swath = seed.offline.swath;
  const jordanK = knocks.find((k) => k.leadId === 'sample-lead-01');
  ok('the story customer\'s door: an appointment that became the lead, inside the hail swath, on her pin',
    jordanK && jordanK.disposition === 'appointment' && jordanK.convertedToLead && BM.inRing([jordanK.lat, jordanK.lng], swath) && story.lat === jordanK.lat && story.lng === jordanK.lng);
  const terr = D['territories/sample-territory-01'];
  const ringT = terr && terr.geoJSON.geometry.coordinates[0];
  ok('the storm territory is GeoJSON [lng, lat] (D2D order) and matches the swath', ringT && ringT.length === swath.length && ringT.every((p, i) => p[0] === swath[i][1] && p[1] === swath[i][0]) && ringT[0][0] < -80);
  const zone = (seed.offline.stormZones || [])[0];
  ok('the Storm Center zone is [lat, lng] (Storm Center order), names the story\'s zone and is linked from the territory',
    zone && zone.polygon[0][0] > 30 && zone.polygon[0][1] < -80 && zone.id === terr.stormZoneId && zone.name.indexOf(S.zone) !== -1 && /sample/i.test(zone.name));
  ok('every sample hail report lies in the swath and says it is sample data', seed.offline.hail.length >= 5 && seed.offline.hail.every((h) => BM.inRing([h.lat, h.lng], swath) && /sample/i.test(h.source)));
  const al = (seed.offline.nwsAlerts || [])[0] || { properties: {} };
  ok('the one weather alert is marked as sample data, not a National Weather Service warning', /^SAMPLE ALERT \(not a real warning\)/.test(al.properties.headline || '') && /not the National Weather Service/.test(al.properties.senderName || '') && /\(sample\)/.test(al.properties.areaDesc || ''));

  // H3. The Agent inbox: the sample company's own bots, drafts waiting.
  const inbox = Object.entries(D).filter(([p]) => /^agent_inbox\//.test(p)).map(([id, d]) => Object.assign({ id: id.split('/')[1] }, d));
  const kinds = new Set(inbox.map((i) => i.kind));
  ok('the inbox seeds every kind (text + email drafts, social draft, note, reminder, report), all pending, all the sample company\'s',
    ['draft_text', 'draft_email', 'social_draft', 'note', 'reminder', 'report'].every((k) => kinds.has(k)) && inbox.every((i) => i.status === 'pending' && i.companyId === 'demo-owner'));
  ok('the bots are the sample company\'s own, never NBD\'s (Marcus, Quinn, Tucker, Dana, …)', inbox.every((i) => !/marcus|quinn|tucker|dana|frank|priya|theo|nbd/i.test(String(i.bot) + ' ' + String(i.botId) + ' ' + String(i.verifiedBy || ''))), inbox.map((i) => i.bot).join(', '));
  const storySrc = read('docs/pro/js/sandbox-story.js');
  const storyDraft = (/var DRAFT = '([^'\n]*)';/.exec(storySrc) || [])[1];
  ok('the text draft is the story\'s own follow-up text, for the story customer', !!storyDraft && inbox.some((i) => i.kind === 'draft_text' && i.text === storyDraft && i.leadId === 'sample-lead-01'));
  const inboxText = JSON.stringify(inbox);
  ok('no inbox item claims the NBD Pledge, an NBD warranty, "lifetime" or a claim outcome', !/pledge|no big deal|\bnbd\b|lifetime|guarantee|approved by (your|the) (insurance|carrier)|we('| wi)ll get/i.test(inboxText));
  ok('the Kentucky insurance note: nothing collected at signing', inbox.some((i) => i.leadId === 'sample-lead-16' && /nothing is collected at signing/i.test(i.text)) && D['leads/sample-lead-16'].state === 'KY' && D['leads/sample-lead-16'].jobType === 'insurance');

  // H4. The shell wiring (comments stripped, call ORDER asserted).
  const dm2 = stripComments(read('docs/pro/js/demo-mode.js'));
  const fetchFn = (/window\.fetch = function \(input, init\) \{([\s\S]*?)\n {4}\};/.exec(dm2) || ['', ''])[1];
  ok('demo-mode.js: the fetch wrapper answers the maps\' reads offline BEFORE the block check (never made, never blocked)',
    fetchFn.indexOf('offlineKey(url, method)') !== -1 && fetchFn.indexOf('offlineKey(url, method)') < fetchFn.indexOf('allowed(url, method)'));
  ok('demo-mode.js: only GET/HEAD of the listed weather / geocoder / storm-report reads go offline', /var OFFLINE = \/\^\(https:\\\/\\\/\(nominatim\\\.openstreetmap\\\.org\\\/\(reverse\|search\)\\b\|api\\\.weather\\\.gov\\\/\(points\\\/\|alerts\\b\)\|www\\\.spc\\\.noaa\\\.gov\\\/products\\\/outlook\\\/\)\|\\\/api\\\/storm-report\\b\)\/;/.test(dm2) && /if \(m !== 'GET' && m !== 'HEAD'\) return null;/.test(dm2));
  ok('demo-mode.js: traps window.L and swaps the tiles the moment Leaflet loads', /Object\.defineProperty\(window, 'L', \{[\s\S]*?set: function \(v\) \{ leaflet = v; swapTiles\(v\); \}/.test(dm2) && /NBD_DEMO_BASEMAP\.install\(L\)/.test(dm2));
  ok('demo-mode.js: loads the sample map and the offline answers', /loadScript\('\/pro\/demo-sdk\/basemap\.js\?v=\d+', false\)/.test(dm2) && /loadScript\('\/pro\/demo-sdk\/offline\.js\?v=\d+', true\)/.test(dm2));
  ok('demo-mode.js: the maps get the sample location, never the visitor\'s', /geo\.getCurrentPosition = function/.test(dm2) && /geo\.watchPosition = function/.test(dm2));
  ok('demo-mode.js: sms: / mailto: / tel: links never open the visitor\'s apps', /\(sms\|mailto\|tel\):\/i\.exec[\s\S]{0,120}if \(scheme\) \{\s*e\.preventDefault\(\);/.test(dm2));
  const sw2 = stripComments(read('docs/pro/explore/demo-sw.js'));
  ok('demo-sw.js swaps the AI proxy client for the sample one (no claudeProxy POST, no model)', /\['\/pro\/js\/claude-proxy\.js', '\/pro\/demo-sdk\/claude-proxy\.js'\]/.test(sw2) && sw2.indexOf('SWAPS.has(path)') !== -1 && sw2.indexOf('SWAPS.has(path)') < sw2.indexOf('if (path !== url.pathname)'));

  // H5. The offline answers and the canned callables, run here.
  globalThis.window = globalThis;
  globalThis.location = { href: 'https://example.test/pro/explore/dashboard', origin: 'https://example.test' };
  const lsMem = new Map();
  globalThis.localStorage = { getItem: (k) => (lsMem.has(k) ? lsMem.get(k) : null), setItem: (k, v) => lsMem.set(k, String(v)), removeItem: (k) => lsMem.delete(k) };
  globalThis.NBD_DEMO_BASEMAP = BM;
  const store = await imp('_store.js');
  globalThis._leads = Object.entries(D).filter(([p]) => /^leads\/[^/]+$/.test(p)).map(([p, d]) => Object.assign({ id: p.split('/')[1] }, store.reviveSeed(d)));
  const OFF = (await imp('offline.js')).default;
  await OFF.ready;
  const rj = async (u) => (await OFF.answer(u)).json();
  const rev = await rj('https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&zoom=18&lat=' + story.lat + '&lon=' + story.lng);
  ok('offline geocoder: a tap on the story customer\'s house answers 214 Sample Ridge Rd', rev.address && rev.address.house_number === '214' && rev.address.road === 'Sample Ridge Rd' && rev.type === 'house', JSON.stringify(rev).slice(0, 300));
  const fwd = await rj('https://nominatim.openstreetmap.org/search?format=json&countrycodes=us&addressdetails=1&limit=5&q=' + encodeURIComponent('214 Sample Ridge Rd, Fort Thomas, KY 41075'));
  ok('offline geocoder: the forward check finds the same house', Array.isArray(fwd) && fwd[0] && fwd[0].address.house_number === '214' && Number(fwd[0].lat) === story.lat);
  const alerts = await rj('https://api.weather.gov/alerts/active?status=actual&message_type=alert&zone=KYC037');
  ok('offline weather: the sample alert is live now (expires later) and marked sample', alerts.features.length === 1 && Date.parse(alerts.features[0].properties.expires) > Date.now() && /SAMPLE ALERT/.test(alerts.features[0].properties.headline));
  const spc = await rj('https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson');
  ok('offline weather: no made-up Storm Prediction Center outlook (empty)', Array.isArray(spc.features) && spc.features.length === 0);
  const lsr2 = await rj('/api/storm-report?lat=39.075&lon=-84.447');
  ok('offline storm reports: the story\'s storm and older sample reports, /api/storm-report shape (lat, lon, type, date)', lsr2.events.length >= 9 && lsr2.events.every((e) => typeof e.lat === 'number' && typeof e.lon === 'number' && /hail|wind|tornado/.test(e.type) && !isNaN(Date.parse(e.date))));
  ok('first load puts Storm Center\'s zone and the "show me the storm" hint in this tab\'s storage', /Fort Thomas north/.test(lsMem.get('nbd_storm_zones') || '') && JSON.parse(lsMem.get('nbd_d2d_focus_bounds') || '{}').north > 39);
  const pos = OFF.position();
  ok('the sample location is the story customer\'s street', Math.abs(pos.coords.latitude - story.lat) < 0.001 && Math.abs(pos.coords.longitude - story.lng) < 0.001);
  const ask = async (q) => { const r = await OFF.callClaude({ toolset: 'joe-actions-v1', system: 'x', messages: [{ role: 'user', content: q }] }); return (r.content || []).map((b) => b.text).join(''); };
  const QS = ['What should I focus on today?', 'Which leads are most likely to close?', 'Help me write a supplement request', 'How do I handle a lowball adjuster estimate?',
    'What does my pipeline look like right now?', 'What is due at signing on a Kentucky insurance job?', 'Do you offer the NBD Pledge or a lifetime warranty?', 'Tell me about the storm', 'Write me a poem'];
  const answers = [];
  for (const q of QS) answers.push(await ask(q));
  ok('Ask Joe: every answer is labelled a sample answer, no AI model called', answers.every((a) => /No AI model was called/.test(a)));
  ok('Ask Joe: the five starter questions each get their own answer (not the fallback)', answers.slice(0, 5).every((a) => !/answers a few set questions\. Try one/.test(a)) && new Set(answers.slice(0, 5)).size === 5);
  ok('Ask Joe: Kentucky insurance job: nothing is due at signing', /nothing is due at signing/i.test(answers[5]));
  ok('Ask Joe: no answer claims the NBD Pledge, NBD, "lifetime" or a claim outcome', answers.every((a) => !/pledge|no big deal|\bnbd\b|lifetime|will (be )?(approve|pay)|guarantee(d)? (approval|coverage)/i.test(a)), answers.find((a) => /pledge|no big deal|\bnbd\b|lifetime/i.test(a)));
  let aiErr = null;
  try { await OFF.callClaude({ messages: [{ role: 'user', content: 'Return JSON' }], feature: 'est' }); } catch (e) { aiErr = e.message; }
  ok('any other AI caller is told AI is not in the sample account (rejects, no fake answer)', /not in the sample account/.test(aiErr || ''));
  const call = (n, p) => FN.httpsCallable(FN.getFunctions(), n)(p).then((r) => r.data);
  const chk = await call('agentDraftAction', { action: 'check', ids: ['sample-inbox-01', 'sample-inbox-02'] });
  ok('agentDraftAction check: the sample drafts\' customers are reachable (send buttons on)', chk.results['sample-inbox-01'].ok && /^\+1859555\d{4}$/.test(chk.results['sample-inbox-01'].to) && chk.results['sample-inbox-02'].to === 'caleb.ross@example.com', JSON.stringify(chk));
  const sent = await call('agentDraftAction', { action: 'sent', id: 'sample-inbox-01', body: storyDraft });
  const itemAfter = store.rawGet('agent_inbox/sample-inbox-01');
  const noteAfter = store.rawList('notes').map(([, d]) => d).find((n) => n.agentItemId === 'sample-inbox-01');
  ok('agentDraftAction sent: says it was NOT sent, files the draft, notes it on the card', sent.ok && sent.sent === false && itemAfter.status === 'approved' && itemAfter.result === 'sample:not-sent' && noteAfter && /Nothing was sent/.test(noteAfter.text));
  const hh = await call('getHailHistory', { lat: 39.0752, lng: -84.4468, radiusMi: 5 });
  ok('getHailHistory: the sample hail reports, the swath on the first (GeoJSON [lng, lat])', hh.hits.length >= 5 && hh.hits[0].polygon.coordinates[0][0][0] < -80 && /sample/i.test(hh.source));
  let spErr = null;
  try { await call('attachStormProof', { leadId: 'sample-lead-01' }); } catch (e) { spErr = e.message; }
  ok('attachStormProof says what it would do (no fake "verified" proof)', /In your real account this would look up verified hail reports/.test(spErr || ''));

  // ── I. wave 4: invoices, payments, production, Settings ─────────────────
  console.log('I. wave 4 (invoices, payments, pay links, production strip, Settings)');
  const R = require(path.join(DOCS, 'pro', 'js', 'deposit-rule.js'));
  const KYL = require(path.join(DOCS, 'pro', 'js', 'ky-insurance-law.js'));
  const live = (d) => store.reviveSeed(d);
  const invs = Object.entries(D).filter(([p]) => /^invoices\//.test(p)).map(([p, d]) => Object.assign({ id: p.split('/')[1] }, live(d)));
  const leadOfInv = (inv) => Object.assign({ id: inv.leadId }, live(D['leads/' + inv.leadId]));
  const isKyIns = (l) => !!KYL.classify({ address: l.address, zip: l.zip, state: l.state, jobType: l.jobType, claimNumber: l.claimNumber, insuranceCarrier: l.insuranceCarrier }).kyInsurance;
  ok('seed v4 or later carries invoices: paid, part-paid and draft, cash and Kentucky insurance',
    seed.version >= 4 && invs.length >= 6 && ['paid', 'partial', 'draft'].every((s) => invs.some((i) => i.status === s)) &&
    invs.some((i) => isKyIns(leadOfInv(i))) && invs.some((i) => !isKyIns(leadOfInv(i))), invs.map((i) => i.id + ':' + i.status).join(' '));
  ok('every invoice is the sample company\'s and labelled a sample (description and line items)',
    invs.every((i) => i.companyId === 'demo-owner' && i.createdBy === 'demo-owner' && i.isSample === true && /\(sample\)/.test(i.description) && i.items.every((it) => /\(sample price\)/.test(it.description))));
  // The deposit rule, recomputed by the REAL deposit-rule.js and spelled out.
  const ruleBad = invs.filter((i) => {
    const l = leadOfInv(i);
    if (isKyIns(l)) return !(i.depositAmount === 0 && /^Nothing is due at signing/.test(i.depositTerms) && i.kyInsuranceHold === true);
    const want = i.total < 2000 ? 0 : Math.round(i.total * 0.5 / 25) * 25;
    const plan = R.fromEstimate({ total: i.total, mode: 'cash' }, { totalCents: Math.round(i.total * 100), lead: l });
    return i.depositAmount !== want || plan.depositCents !== want * 100 || !/due at signing/.test(i.depositTerms);
  });
  ok('deposits follow the rule: cash under $2,000 none, $2,000+ 50% at signing; Kentucky insurance nothing at signing', ruleBad.length === 0, ruleBad.map((i) => i.id + ' ' + i.depositAmount).join(', '));
  const ledgerBad = invs.filter((i) => {
    const paid = Math.round((i.payments || []).reduce((s, p) => s + p.amount * 100, 0));
    const bal = Math.round(i.total * 100) - paid;
    const st = bal === 0 ? 'paid' : paid > 0 ? 'partial' : i.status;
    return Math.round(i.amountPaid * 100) !== paid || Math.round(i.balanceDue * 100) !== bal || i.status !== st;
  });
  ok('every invoice\'s ledger adds up (amountPaid = its payments, balanceDue = total − paid, status matches)', ledgerBad.length === 0, ledgerBad.map((i) => i.id).join(', '));
  // Kentucky insurance: no money asked before the carrier's written decision + the window; no live pay link.
  const kyInvs = invs.filter((i) => isKyIns(leadOfInv(i)));
  const kyEarly = [];
  kyInvs.forEach((i) => (i.payments || []).forEach((p) => { if (!KYL.kyPaymentsReleased(leadOfInv(i).carrierDecisionAt, p.at.toDate())) kyEarly.push(i.id + ' ' + p.paymentId); }));
  ok('Kentucky insurance: every payment is dated after the written decision and the 5-business-day window', kyInvs.length >= 3 && kyEarly.length === 0, kyEarly.join(', '));
  const linkBad = invs.filter((i) => i.stripePaymentLink && (KYL.payLinkHold(leadOfInv(i), i, new Date()).held || !/^https:\/\/example\.test\/pro\/explore\/sample-pay\?invoice=[\w-]+&amount=\d+\.\d\d$/.test(i.stripePaymentLink)));
  ok('pay links in the seed are sample links only, and never on a held Kentucky insurance invoice', invs.some((i) => i.stripePaymentLink) && linkBad.length === 0, linkBad.map((i) => i.id).join(', '));
  const grace = invs.find((i) => i.leadId === 'sample-lead-16');
  ok('the signed Kentucky insurance job (no carrier decision yet): draft, $0 deposit, pay link held by the REAL ky-insurance-law.js',
    grace && grace.status === 'draft' && !grace.stripePaymentLink && KYL.payLinkHold(leadOfInv(grace), grace, new Date()).held === true);
  const moneyText = JSON.stringify(invs) + JSON.stringify(Object.entries(D).filter(([p]) => /^(notes|companies\/demo-owner\/subs|leads\/[^/]+\/jobs)\//.test(p)));
  ok('no assignment of benefits and no claim-outcome copy in invoices, payment notes, subs or orders',
    !/assignment of benefits|\baob\b|direction to pay|we (handle|negotiate|fight)|underpaid|recovered|get (you|it) approved|lifetime/i.test(moneyText));
  const ca = D['connectAccounts/demo-owner'];
  ok('the sample payout account is test mode (never livemode) and marked as a sample', ca && ca.livemode === false && ca.isSample === true && /^acct_sample/.test(ca.accountId));
  const subs = Object.entries(D).filter(([p]) => /^companies\/demo-owner\/subs\//.test(p)).map(([, d]) => d);
  ok('the sub roster: invented independent subcontractors, never employees or "our crew"',
    subs.length >= 2 && subs.every((s) => /\(sample sub\)/.test(s.name) && /independent subcontractor/i.test(s.notes)) && !/employee|our (crew|team)|in-house/i.test(JSON.stringify(subs)));
  const orders = Object.entries(D).filter(([p]) => /^leads\/[^/]+\/jobs\/[^/]+\/orders\//.test(p)).map(([, d]) => d);
  const priceKey = (o) => JSON.stringify(o).match(/"(price|cost|unitPrice|amount|rate|total|cents)\w*"\s*:/i);
  ok('material orders carry quantities only (no price, cost or amount field)', orders.length >= 3 && orders.every((o) => !priceKey(o)), (orders.map(priceKey).find(Boolean) || [])[0]);
  const prodLead = D['leads/sample-lead-17'];
  ok('a job in production fills the strip: permit filed, sub on the roster, a start window', prodLead.permitFiledAt && prodLead.subId === 'sample-sub-01' && prodLead.scheduledDate && prodLead.scheduledStart === '07:00');

  // I1b. A Date written by the CRM (invoice createdAt / dueDate) is stored as a
  // Timestamp, like Firestore does (it used to be walked as a map: {}).
  const when = new Date('2026-09-01T15:00:00Z');
  await F.setDoc(F.doc(db, 'invoices', 'date-probe'), { createdAt: when, nested: { at: when }, list: [when] });
  const probe = (await F.getDoc(F.doc(db, 'invoices', 'date-probe'))).data();
  ok('a Date field is stored as a Timestamp (top level, nested and in an array), as Firestore does',
    [probe.createdAt, probe.nested.at, probe.list[0]].every((t) => t instanceof F.Timestamp && t.toDate().getTime() === when.getTime()), JSON.stringify(probe));
  await F.updateDoc(F.doc(db, 'invoices', 'date-probe'), { paidAt: when });
  ok('…updateDoc too', (await F.getDoc(F.doc(db, 'invoices', 'date-probe'))).data().paidAt instanceof F.Timestamp);
  await F.deleteDoc(F.doc(db, 'invoices', 'date-probe'));

  // I2. The direct function answers (endpoints.js), run here.
  const epCode = stripComments(read('docs/pro/demo-sdk/endpoints.js'));
  ok('demo-sdk/endpoints.js makes no request of its own', !NET.test(epCode), (epCode.match(NET) || [])[0]);
  globalThis.NBDJurisdiction = KYL;
  const EP = (await imp('endpoints.js')).default;
  const ans = async (n, b) => { const r = await EP.answerFunction(n, JSON.stringify(b || {})); return { status: r.status, body: await r.json() }; };
  ok('endpoints.js answers exactly the three direct POSTs (pay link, email, text)', EP.NAMES.slice().sort().join(',') === 'createStripePaymentLink,sendEmail,sendSMS');
  const heldAns = await ans('createStripePaymentLink', { invoiceId: grace.id });
  ok('pay link on a held Kentucky insurance invoice: refused with the CRM\'s own KY_CANCELLATION_WINDOW error', heldAns.status === 409 && /^KY_CANCELLATION_WINDOW: Online payment link withheld: Kentucky insurance job \(KRS 367\.626\)/.test(heldAns.body.error), JSON.stringify(heldAns));
  const felix = invs.find((i) => i.leadId === 'sample-lead-21');
  const okAns = await ans('createStripePaymentLink', { invoiceId: felix.id });
  ok('pay link on an owed cash invoice: a sample link for the balance, never a Stripe URL', okAns.status === 200 && okAns.body.url === 'https://example.test/pro/explore/sample-pay?invoice=' + felix.id + '&amount=6900.00' && okAns.body.sample === true && !/stripe\.com/.test(JSON.stringify(okAns.body)), JSON.stringify(okAns));
  const paidAns = await ans('createStripePaymentLink', { invoiceId: invs.find((i) => i.status === 'paid').id });
  ok('pay link on a paid invoice: refused (nothing owed)', paidAns.status === 400);
  const smsAns = await ans('sendSMS', { to: '+15135550120', body: 'Your invoice is ready.', leadId: 'sample-lead-21' });
  const mailAns = await ans('sendEmail', { to: 'felix.grant@example.com', subject: 'Invoice', html: '<p>Hi</p>', invoiceId: felix.id });
  ok('a text or an email: refused 403 "nothing was sent" (nbd-comms.js then never hands off to sms: / mailto:)',
    smsAns.status === 403 && mailAns.status === 403 && smsAns.body.code === 'sample_account' && /nothing was sent/.test(smsAns.body.error) && /nothing was sent/.test(mailAns.body.error));
  const nc = stripComments(read('docs/pro/js/nbd-comms.js'));
  ok('…nbd-comms.js really treats a 403 as a final refusal with no handoff (the contract the answer relies on)',
    /if \(plat\.status === 403 \|\| plat\.status === 401\) \{[\s\S]{0,400}return \{ success: false, mode: 'platform'/.test(nc) && /if \(plat\.status === 403 \|\| \(plat\.status >= 500/.test(nc));
  const unk = await ans('stripeWebhook', {});
  ok('any other function name is not answered (404)', unk.status === 404);

  // I3. The shell wiring for wave 4 (comments stripped).
  ok('demo-mode.js: the fetch wrapper answers the three function POSTs BEFORE the block check',
    fetchFn.indexOf('endpointName(url, method)') !== -1 && fetchFn.indexOf('endpointName(url, method)') < fetchFn.indexOf('allowed(url, method)'));
  ok('demo-mode.js: only POSTs to the CRM\'s own two function bases, only those three names',
    dm2.indexOf("var FN_URL = /^(?:https:\\/\\/us-central1-nobigdeal-pro\\.cloudfunctions\\.net|http:\\/\\/127\\.0\\.0\\.1:5001\\/nobigdeal-pro\\/us-central1)\\/([A-Za-z]+)$/;") !== -1 &&
    /var ENDPOINTS = \{ createStripePaymentLink: true, sendEmail: true, sendSMS: true \};/.test(dm2) && /if \(String\(method \|\| 'GET'\)\.toUpperCase\(\) !== 'POST'\) return null;/.test(dm2));
  ok('demo-mode.js: loads endpoints.js and real-account.js, turns on Stripe test mode for the sample payout account, guards the share sheet',
    /loadScript\('\/pro\/demo-sdk\/endpoints\.js\?v=\d+', true\)/.test(dm2) && /loadScript\('\/pro\/demo-sdk\/real-account\.js\?v=\d+', false\)/.test(dm2) &&
    /window\.__NBD_CONNECT_ALLOW_TEST_MODE = true;/.test(dm2) && /Object\.defineProperty\(navigator, 'share'/.test(dm2) && /new DOMException\('Nothing is shared from the sample account', 'AbortError'\)/.test(dm2));
  const ra = stripComments(read('docs/pro/demo-sdk/real-account.js'));
  ok('real-account.js: cards over billing, team, sign-in, Bots & API keys and AI texting; a note over push', ['billing', 'team', 'access', 'bots', 'ai-texting'].every((p) => ra.indexOf("'stab-panel-" + p + "'") !== -1) && /'stab-panel-notifications'/.test(ra) && /push\.disabled = true/.test(ra));
  ok('real-account.js: data import opens the card, never the importer (window capture + the global)', /window\.addEventListener\('click', function \(e\) \{[\s\S]{0,200}e\.stopImmediatePropagation\(\);\s*openSheet\(IMPORT\);[\s\S]{0,20}\}, true\);/.test(ra) && /Object\.defineProperty\(window, 'openLeadImport'/.test(ra) && !NET.test(ra));
  const css4 = read('docs/pro/css/demo-mode.css');
  ok('demo-mode.css: a sealed panel shows only its card (its own controls hidden)', /html\.nbd-demo \[data-nbd-demo-sealed\] > :not\(\.nbd-demo-real-card\) \{ display: none !important; \}/.test(css4));
  ok('demo-mode.css: Ask Joe reserves room under its input for the strip (desktop) and moves the strip to the top (phones)',
    /html\.nbd-demo #view-joe\.active \.joe-input-area \{ padding-bottom: calc\(14px \+ 58px/.test(css4) &&
    /@media \(max-width: 900px\) \{[\s\S]*?html\.nbd-demo body:has\(#view-joe\.active\) \.nbd-demo-strip \{ top: calc\(50px \+ env\(safe-area-inset-top, 0px\)\); bottom: auto; \}/.test(css4));
  ok('demo-mode.js loads the wave 4 stylesheet (v=4 or later)', /demo-mode\.css\?v=([4-9]|\d\d+)'/.test(dm2));
  const pay = read('docs/pro/explore/sample-pay.html');
  ok('the sample pay page: noindex, says it is a sample, takes no card (no form, no input, button disabled), no inline script',
    /<meta name="robots" content="noindex, nofollow">/.test(pay) && /This is a sample\./.test(pay) && !/<form|<input/i.test(pay) && /<button[^>]*disabled/.test(pay) &&
    !/<script(?![^>]*\bsrc=)[^>]*>/i.test(pay) && /<script defer src="\/pro\/explore\/explore-pay\.js\?v=\d+"><\/script>/.test(pay));
  ok('…its script is one the demo worker serves from /pro/explore/ itself (explore-*.js)', /explore-\[\\w-\]\+\\\.\(js\|css\)/.test(read('docs/pro/explore/demo-sw.js')) && !NET.test(stripComments(read('docs/pro/explore/explore-pay.js'))));
  const fnsSrc = stripComments(read('docs/pro/demo-sdk/firebase-functions.js'));
  ok('screens behind a card refuse quietly (no second notice): payout status, bot keys, AI persona, Stripe balance', /const QUIET = new Set\(\['getConnectStatus', 'listAgentKeys', 'previewAiPersona', 'getStripeOverview', 'getJobWeather'\]\);/.test(fnsSrc) && /if \(!shown && !QUIET\.has\(name\)\) demoNotice/.test(fnsSrc));

  // ── G. sandbox placeholder ──────────────────────────────────────────────
  console.log('G. /pro/sandbox placeholder');
  const sb = read('docs/pro/sandbox.html');
  const ph = (/<div class="sx-next-phase"[\s\S]*?<\/div>/.exec(sb) || [''])[0];
  ok('"Explore the whole sample account" is still a disabled placeholder, not a link', /aria-disabled="true"/.test(ph) && !/<a\b|href=/.test(ph));
  ok('nothing on /pro/sandbox links to /pro/explore yet', !/\/pro\/explore/.test(sb) && !/\/pro\/explore/.test(read('docs/pro/js/sandbox-story.js')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
