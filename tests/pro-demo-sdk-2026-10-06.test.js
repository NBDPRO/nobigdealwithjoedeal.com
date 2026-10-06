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

  // ── G. sandbox placeholder ──────────────────────────────────────────────
  console.log('G. /pro/sandbox placeholder');
  const sb = read('docs/pro/sandbox.html');
  const ph = (/<div class="sx-next-phase"[\s\S]*?<\/div>/.exec(sb) || [''])[0];
  ok('"Explore the whole sample account" is still a disabled placeholder, not a link', /aria-disabled="true"/.test(ph) && !/<a\b|href=/.test(ph));
  ok('nothing on /pro/sandbox links to /pro/explore yet', !/\/pro\/explore/.test(sb) && !/\/pro\/explore/.test(read('docs/pro/js/sandbox-story.js')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
