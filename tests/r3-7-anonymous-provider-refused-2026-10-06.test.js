/**
 * tests/r3-7-anonymous-provider-refused-2026-10-06.test.js
 *
 * R3-7 (phased review round 3, 2026-10-06): the Anonymous auth provider was
 * enabled in prod and no page used it. Any anonymous account passed every
 * "signed in" check, so with only the public web key it could read
 * docPrefixes (every tenant's owner uid), create companies/{its uid} and
 * solo leads, call createCompany (which mints company_admin claims), and
 * start over with a fresh uid to reset every per-uid rate limit.
 *
 * Jo turned Anonymous sign-in OFF in the Firebase console on 2026-10-06.
 * That stops NEW anonymous accounts, but an account created before then can
 * keep refreshing its ID token. So the code refuses the provider too:
 *
 *   1. firestore.rules + storage.rules: isAuth() is false for
 *      sign_in_provider 'anonymous' (the emulator proof is the R3-7 section
 *      of tests/firestore-rules.cross-tenant.test.js; this file guards the
 *      helper's shape).
 *   2. functions/shared.js: callableRateLimit (called by 80 callables,
 *      createCompany / mintOwnerClaims / claimInvite / reserveCompanyPrefix
 *      among them), assertNotViewer / viewOnlyRefusal (the write callables
 *      and HTTP writers) and requireAuth (the onRequest Bearer helper) all
 *      refuse an anonymous token. EXECUTED here against stubs, not grepped.
 *   3. No client page calls signInAnonymously (the one leftover import in
 *      docs/admin/js/vault-firebase.js was never called and is gone).
 *
 * Pure Node: no emulator, no firebase-admin.
 * Run: node tests/r3-7-anonymous-provider-refused-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '  — ' + detail : '')); }
}

// Comment stripper (same as tests/review-r3-tenant-auth-known-bugs-2026-10-06.test.js):
// line-based, so a "/*" inside a "//" comment (rules comments say things like
// "photos/*") never opens a phantom block, and a "//" in a URL is kept.
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (let line of src.split(/\r?\n/)) {
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      line = line.slice(end + 2); inBlock = false;
    }
    let s = line;
    // Whichever comes first on the line wins: a `//` line comment (so a
    // `leads/{id}/*` inside one never opens a phantom block) or a `/*` block.
    for (;;) {
      const lc = s.match(/(^|[^:'"`\\])\/\//);
      const lcAt = lc ? lc.index + lc[1].length : -1;
      const a = s.indexOf('/*');
      if (lcAt !== -1 && (a === -1 || lcAt < a)) { s = s.slice(0, lcAt); break; }
      if (a === -1) break;
      const b = s.indexOf('*/', a + 2);
      if (b === -1) { s = s.slice(0, a); inBlock = true; break; }
      s = s.slice(0, a) + s.slice(b + 2);
    }
    if (/^\s*$/.test(s) && /^\s*\/\//.test(line)) { out.push(''); continue; }
    out.push(s);
  }
  return out.join('\n');
}
{
  const s = stripComments("a(); // signInAnonymously\n/* sign_in_provider */ b('https://x.y/z');");
  ok('stripper: removes line + block comments', !/signInAnonymously|sign_in_provider/.test(s));
  ok('stripper: keeps a // inside a URL', s.includes("'https://x.y/z'"));
  const t = stripComments("x(); // under photos/*\nkeep_me();\n/* real */ y();");
  ok('stripper: a /* inside a // comment does not swallow the next lines', t.includes('keep_me()') && t.includes('y()') && !t.includes('real'));
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Rules: isAuth() refuses the anonymous provider (firestore + storage).
// ═══════════════════════════════════════════════════════════════════════
for (const rel of ['firestore.rules', 'storage.rules']) {
  const src = stripComments(read(rel));
  const m = src.match(/function\s+isAuth\s*\(\s*\)\s*\{([\s\S]*?)\}\s*\r?\n/);
  const body = m ? m[1] : '';
  ok(`${rel}: isAuth() found`, !!m);
  ok(`${rel}: isAuth() still requires request.auth != null`, /request\.auth\s*!=\s*null/.test(body), body.trim());
  ok(`${rel}: isAuth() refuses sign_in_provider 'anonymous'`,
    /sign_in_provider/.test(body) && /!=\s*'anonymous'/.test(body), body.trim());
  // Absence-safe: a bare token.firebase.sign_in_provider throws when the map
  // key is missing (the NEW-5 lesson) and would deny everyone.
  ok(`${rel}: the provider read is .get()-safe`, /\.get\(\s*'firebase'/.test(body) && /\.get\(\s*'sign_in_provider'/.test(body), body.trim());
  // No rule may bypass the helper with its own bare null check.
  const bare = src.replace(m ? m[0] : '', '').match(/request\.auth\s*!=\s*null/g) || [];
  ok(`${rel}: no other rule re-implements "request.auth != null"`, bare.length === 0, bare.length + ' found');
}

// ═══════════════════════════════════════════════════════════════════════
// 2. functions/shared.js — executed against stubs.
// ═══════════════════════════════════════════════════════════════════════
function loadShared({ verifyIdToken } = {}) {
  const SRC = read('functions/shared.js');
  class HttpsError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  const rl = [];
  const stubs = {
    './integrations/upstash-ratelimit': { enforceRateLimit: async (ns, key) => { rl.push(ns + '|' + key); } },
    'firebase-functions/v2/https': { HttpsError },
    'firebase-admin/auth': { getAuth: () => ({ verifyIdToken: verifyIdToken || (async () => ({ uid: 'u1' })) }) },
  };
  const req = (id) => {
    if (!Object.prototype.hasOwnProperty.call(stubs, id)) throw new Error('unstubbed require(' + id + ')');
    return stubs[id];
  };
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', SRC)(mod, mod.exports, req);
  return { m: mod.exports, rl, HttpsError };
}
const anonToken = { uid: 'a1', firebase: { sign_in_provider: 'anonymous' } };
const pwToken   = { uid: 'p1', firebase: { sign_in_provider: 'password' } };
const custToken = { uid: 'c1', firebase: { sign_in_provider: 'custom' } };

async function threw(fn) { try { await fn(); return null; } catch (e) { return e; } }

(async function main() {
  console.log('\nshared.js — anonymous refusal');
  {
    const { m } = loadShared();
    ok('isAnonymousToken exported', typeof m.isAnonymousToken === 'function');
    ok('isAnonymousToken: anonymous → true', m.isAnonymousToken && m.isAnonymousToken(anonToken) === true);
    ok('isAnonymousToken: password → false', m.isAnonymousToken && m.isAnonymousToken(pwToken) === false);
    ok('isAnonymousToken: custom (access-code) → false', m.isAnonymousToken && m.isAnonymousToken(custToken) === false);
    ok('isAnonymousToken: no firebase map → false', m.isAnonymousToken && m.isAnonymousToken({ uid: 'x' }) === false);
    ok('isAnonymousToken: null → false', m.isAnonymousToken && m.isAnonymousToken(null) === false);
  }
  {
    const { m, rl } = loadShared();
    const e = await threw(() => m.callableRateLimit({ auth: { uid: 'a1', token: anonToken } }, 'createCompany', 5, 1000));
    ok('callableRateLimit: anonymous caller is refused (permission-denied)', !!e && e.code === 'permission-denied', e ? e.code : 'no throw');
    ok('callableRateLimit: anonymous caller never reaches the limiter', rl.length === 0);
    const e2 = await threw(() => m.callableRateLimit({ auth: { uid: 'p1', token: pwToken } }, 'createCompany', 5, 1000));
    ok('callableRateLimit control: password caller passes and is metered', !e2 && rl.length === 1, e2 ? e2.message : rl.join());
    const e3 = await threw(() => m.callableRateLimit({ auth: { uid: 'c1', token: custToken } }, 'x', 5, 1000));
    ok('callableRateLimit control: custom-token caller passes', !e3);
    const e4 = await threw(() => m.callableRateLimit({}, 'x', 5, 1000));
    ok('callableRateLimit control: unauthenticated is still a no-op (handler rejects)', !e4 && rl.length === 2);
  }
  {
    const { m } = loadShared();
    const e = await threw(() => m.assertNotViewer(anonToken));
    ok('assertNotViewer: anonymous token is refused', !!e && e.code === 'permission-denied', e ? e.code : 'no throw');
    ok('assertNotViewer control: password token passes', !(await threw(() => m.assertNotViewer(pwToken))));
    const v = await threw(() => m.assertNotViewer({ role: 'viewer' }));
    ok('assertNotViewer control: viewer still refused with the view-only message', !!v && v.message === m.VIEW_ONLY_MESSAGE);
    const r = m.viewOnlyRefusal(anonToken);
    ok('viewOnlyRefusal: anonymous decoded token → 403', !!r && r.status === 403, JSON.stringify(r));
    ok('viewOnlyRefusal control: password → null', m.viewOnlyRefusal(pwToken) === null);
  }
  {
    const { m } = loadShared({ verifyIdToken: async () => anonToken });
    const r = await m.requireAuth({ headers: { authorization: 'Bearer abc' } });
    ok('requireAuth: anonymous ID token is refused', !!r.error && !r.decoded && (r.error.status === 401 || r.error.status === 403), JSON.stringify(r));
    const { m: m2 } = loadShared({ verifyIdToken: async () => pwToken });
    const r2 = await m2.requireAuth({ headers: { authorization: 'Bearer abc' } });
    ok('requireAuth control: password ID token passes', !!r2.decoded && !r2.error);
  }

  // Provisioning callables reach the refusal through callableRateLimit:
  // prove each one still calls it (comment-stripped, inside its handler).
  console.log('\nprovisioning callables call callableRateLimit');
  for (const [rel, name] of [
    ['functions/handlers/provisioning.js', 'createCompany'],
    ['functions/handlers/provisioning.js', 'reserveCompanyPrefix'],
    ['functions/handlers/auth.js', 'mintOwnerClaims'],
    ['functions/handlers/invites.js', 'claimInvite'],
  ]) {
    const src = stripComments(read(rel));
    const at = src.indexOf('exports.' + name + ' = onCall(');
    const next = src.indexOf('\nexports.', at + 10);
    const body = at === -1 ? '' : src.slice(at, next === -1 ? undefined : next);
    ok(`${name}: calls callableRateLimit(request, …) in its handler`, /callableRateLimit\(\s*request\s*,/.test(body));
  }

  // ═════════════════════════════════════════════════════════════════════
  // 3. No client code path signs in anonymously.
  // ═════════════════════════════════════════════════════════════════════
  console.log('\nclient: no signInAnonymously');
  const hits = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(m?js|html)$/.test(ent.name) && !/\.min\.js$/.test(ent.name)) {
        const raw = fs.readFileSync(p, 'utf8');
        if (!raw.includes('signInAnonymously')) continue;
        if (/signInAnonymously/.test(stripComments(raw))) hits.push(path.relative(ROOT, p));
      }
    }
  })(path.join(ROOT, 'docs'));
  ok('no docs/ page imports or calls signInAnonymously', hits.length === 0, hits.join(', '));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
