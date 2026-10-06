/**
 * tests/review-r3-tenant-auth-known-bugs-2026-10-06.test.js
 *
 * Phased review, round 3 (areas 4 tenant isolation + 5 auth/security),
 * 2026-10-06. Report: nbd-content/review-r3-2026-10-06.md (Jo's machine).
 *
 * Every check here is a `KNOWN BUG` pin: it asserts TODAY'S (wrong)
 * behaviour on purpose, so the suite stays green while the bug exists and a
 * change to that code fails loudly here. Flip a pin only in the PR that fixes
 * that bug, with Jo's OK — and keep the label so the history reads.
 *
 * The Firestore/Storage-rules halves of these findings live in
 * firestore-rules.cross-tenant.test.js (section R3) and storage-rules.test.js
 * (R3-4). This file pins the server and page halves.
 *
 * Source pins follow rule-grep-guards-must-strip-comments: comments are
 * stripped (line-oriented stripper, so a `//` inside a URL survives), and each
 * pin is BRACE-SCOPED to the one function it is about, so a benign occurrence
 * elsewhere in the file can neither satisfy nor trip it. Behavioural pins
 * (R3-9) call the real exported function.
 *
 * Pure Node. Run: node tests/review-r3-tenant-auth-known-bugs-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ── helpers ──────────────────────────────────────────────────────────────
// Line-oriented comment stripper: whole-line //, trailing // (not ://), and
// /* */ blocks. Never touches string contents beyond that, so it cannot open
// a phantom string the way a character-level stripper can.
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

// The body of the function/handler that starts at the first match of
// `anchor` (a string), from its first `{` to the matching `}`.
function bodyAfter(src, anchor) {
  const at = src.indexOf(anchor);
  if (at === -1) return null;
  const open = src.indexOf('{', at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

// The handler body of an onCall/onRequest export: the first
// `async (request|req, res) => {` after `anchor`, brace-matched. Skips the
// options object, which is the first `{` after the anchor.
function handlerAfter(src, anchor) {
  const at = src.indexOf(anchor);
  if (at === -1) return null;
  const rest = src.slice(at);
  const m = rest.match(/async\s*\(\s*(request|req)\b[^)]*\)\s*=>/);
  if (!m) return null;
  return bodyAfter(rest.slice(m.index), "=>");
}

// Stripper self-test: it must remove comment text and keep URLs.
{
  const s = stripComments("a(); // agent_keys\n/* agent_keys\n */ b('https://x.y/z');\n  // calendar_feed_tokens");
  ok('stripper: removes line + block comments', !/agent_keys|calendar_feed_tokens/.test(s));
  ok('stripper: keeps a // inside a URL', s.includes("'https://x.y/z'"));
  const t = stripComments("x(); // under leads/{id}/*\nkeep_me();\n/* real */ y();");
  ok('stripper: a /* inside a // comment does not swallow the next lines', t.includes('keep_me()') && t.includes('y()') && !t.includes('real'));
}

// ═══════════════════════════════════════════════════════════════════════
// R3-1 — a removed member keeps access. removeMember strips claims and
// revokes refresh tokens, but leaves (a) the leads they own (rules allow
// isOwner(userId) with no tenant check — pinned in the rules suite),
// (b) their never-expiring calendar feed token, and (c) any CRM bot key
// they created. authenticate() in agent-mcp.js never re-checks the creator.
// ═══════════════════════════════════════════════════════════════════════
{
  const admin = stripComments(read('functions/handlers/admin.js'));
  const rm = handlerAfter(admin, 'exports.removeMember = onCall(');
  ok('R3-1 anchor: removeMember body found', !!rm && rm.length > 500, rm ? rm.length + ' chars' : 'missing');
  ok('R3-1 anchor: removeMember still strips claims (the pin is on the right function)',
    !!rm && /setCustomUserClaims\(/.test(rm) && /revokeRefreshTokens\(/.test(rm));
  ok('KNOWN BUG R3-1: removeMember never revokes calendar_feed_tokens',
    !!rm && !/calendar_feed_tokens|createCalendarFeedToken|TOKEN_COLLECTION/.test(rm));
  ok('KNOWN BUG R3-1: removeMember never revokes agent_keys',
    !!rm && !/agent_keys/.test(rm));
  ok("KNOWN BUG R3-1: removeMember never reassigns or detaches the member's leads",
    !!rm && !/collection\(\s*['"]leads['"]\s*\)/.test(rm));

  const mcp = stripComments(read('functions/agent-mcp.js'));
  const auth = bodyAfter(mcp, 'async function authenticate(');
  ok('R3-1 anchor: agent-mcp authenticate() found', !!auth && /agent_keys/.test(auth));
  ok("KNOWN BUG R3-1: a bot key is honoured without checking its creator is still enabled / in the company",
    !!auth && !/getUser\(|getAuth\(|disabled|customClaims/.test(auth));
}

// ═══════════════════════════════════════════════════════════════════════
// R3-2 — cleanupE2ETestData is gated only on users/{uid}.e2eTestAccount
// (client-settable — rules suite) and deletes each tagged photo's
// storagePath / thumbStoragePath with the admin SDK, with no check that the
// path is under the caller's own prefix. Any user can delete any Storage
// object whose path they know.
// ═══════════════════════════════════════════════════════════════════════
{
  const src = stripComments(read('functions/handlers/auth.js'));
  const body = handlerAfter(src, 'exports.cleanupE2ETestData = onCall(');
  ok('R3-2 anchor: cleanupE2ETestData body found', !!body && body.length > 500);
  ok('R3-2 anchor: the only gate is the e2eTestAccount field on the users doc',
    !!body && /e2eTestAccount\s*!==\s*true/.test(body));
  ok('KNOWN BUG R3-2: photo storagePath is deleted as stored (no own-prefix check)',
    !!body && /deleteStorageObject\(\s*data\.storagePath\s*\)/.test(body)
      && !/startsWith\(|photos\/\$\{\s*uid\s*\}|indexOf\(\s*['"`]photos\//.test(body));
}

// ═══════════════════════════════════════════════════════════════════════
// R3-3 — getHomeownerPortalView re-signs any photo with source:'homeowner'
// for 7 days using the doc's own `path`, then writes the URL back onto that
// doc. The rules let a client create/update such a photo with any path
// (rules suite), so a user with a portal token for their own lead gets a
// signed read URL for any object in the bucket.
// ═══════════════════════════════════════════════════════════════════════
{
  const src = stripComments(read('functions/portal.js'));
  const body = bodyAfter(src, 'async function _refreshHomeownerPhotoUrls(');
  ok('R3-3 anchor: _refreshHomeownerPhotoUrls found', !!body && /getSignedUrl\(/.test(body));
  ok("KNOWN BUG R3-3: the stored path is signed with no homeowner-uploads/ prefix or owner check",
    !!body && /file\(\s*d\.data\(\)\.path\s*\)/.test(body)
      && !/homeowner-uploads|startsWith\(|ownerUid/.test(body));
}

// ═══════════════════════════════════════════════════════════════════════
// R3-4 — getSharedReport's lead_document branch streams the Storage
// object with the object's CURRENT Content-Type and no CSP / nosniff. The
// storage half (owner may overwrite a filed PDF with text/html) is pinned in
// storage-rules.test.js. The inline-report branch is sandboxed; this one is
// not.
// ═══════════════════════════════════════════════════════════════════════
{
  const src = stripComments(read('functions/report-sharing.js'));
  const at = src.indexOf("if (tok.kind === 'lead_document')");
  const branch = at === -1 ? null : bodyAfter(src.slice(at), "if (tok.kind === 'lead_document')");
  ok('R3-4 anchor: lead_document branch found', !!branch && /createReadStream\(/.test(branch));
  ok("KNOWN BUG R3-4: Content-Type comes from the object's metadata, not a fixed application/pdf",
    !!branch && /set\(\s*'Content-Type'\s*,\s*String\(\s*meta\.contentType/.test(branch));
  ok('KNOWN BUG R3-4: the lead_document branch sets no Content-Security-Policy or nosniff',
    !!branch && !/Content-Security-Policy|X-Content-Type-Options/.test(branch));
}

// ═══════════════════════════════════════════════════════════════════════
// R3-8 — App Check is per page. /pro/esign-setup and /pro/photo-review
// initialise App Check only when window.__NBD_APP_CHECK_KEY is set, which is
// done ONLY by js/dashboard-appcheck-config.js — and neither page loads it
// (live HTML checked 2026-10-06). Every callable they use enforces App
// Check, so in prod those calls 401 (the emulator shim hides it).
// ═══════════════════════════════════════════════════════════════════════
{
  const scriptSrcs = (html) => Array.from(html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)).map((m) => m[1]);
  for (const [page, mod] of [['docs/pro/esign-setup.html', 'docs/pro/js/esign-setup.js'],
                             ['docs/pro/photo-review.html', 'docs/pro/js/pages/photo-review.js']]) {
    const html = read(page);
    const srcs = scriptSrcs(html);
    const js = stripComments(read(mod));
    ok(`R3-8 anchor: ${page} loads ${path.basename(mod)}`, srcs.some((s) => s.includes(path.basename(mod))));
    ok(`R3-8 anchor: ${path.basename(mod)} gates initializeAppCheck on window.__NBD_APP_CHECK_KEY`,
      /initializeAppCheck\(/.test(js) && /__NBD_APP_CHECK_KEY/.test(js));
    ok(`KNOWN BUG R3-8: ${page} never loads dashboard-appcheck-config.js`,
      !srcs.some((s) => /dashboard-appcheck-config\.js/.test(s)));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// R3-9 — callerMayManageTarget ignores the target's platform-admin role.
// A second company_admin in a tenant can therefore re-role the owner (who is
// also the platform admin, e.g. Jo in NBD) via updateUserRole — the owner
// guard there still allows role:'company_admin' — which drops role:'admin'
// and revokes their sessions. Behavioural: calls the real function.
// ═══════════════════════════════════════════════════════════════════════
{
  let shared = null;
  try { shared = require(path.join(ROOT, 'functions', 'handlers', '_shared.js')); }
  catch (e) { ok('R3-9 anchor: functions/handlers/_shared.js loads', false, e.message); }
  if (shared) {
    const f = shared.callerMayManageTarget;
    ok('R3-9 anchor: callerMayManageTarget is exported', typeof f === 'function');
    if (typeof f === 'function') {
      ok('R3-9 control: a foreign-tenant target is refused', f({ companyId: 'co-x', role: 'sales_rep' }, 'co-a', false) === false);
      ok("KNOWN BUG R3-9: a platform admin carrying the tenant's companyId is manageable by a company_admin",
        f({ companyId: 'co-a', role: 'admin' }, 'co-a', false) === true);
    }
  }
  const admin = stripComments(read('functions/handlers/admin.js'));
  const upd = handlerAfter(admin, 'exports.updateUserRole = onCall(');
  ok('R3-9 anchor: updateUserRole body found', !!upd && /setCustomUserClaims\(/.test(upd));
  ok("KNOWN BUG R3-9: updateUserRole's owner guard still lets a company_admin set the owner to company_admin",
    !!upd && /role\s*!==\s*'company_admin'\s*&&\s*!isGlobalAdmin/.test(upd)
      && !/existingClaims\.role\s*===\s*'admin'/.test(upd));
}

// ═══════════════════════════════════════════════════════════════════════
// R3-10 — the Stripe Connect callables (create account, onboarding link,
// Express dashboard link) admit ANY company_admin of the tenant, not only
// the owner. A non-owner admin can onboard or re-bank the tenant's payout
// account. seats.js / public-site.js use { ownerOnly: true } for the same
// class of money decision.
// ═══════════════════════════════════════════════════════════════════════
{
  const src = stripComments(read('functions/handlers/stripe-connect.js'));
  for (const name of ['createConnectAccount', 'createConnectOnboardingLink', 'createConnectDashboardLink']) {
    const body = handlerAfter(src, 'exports.' + name + ' = onCall(');
    ok(`R3-10 anchor: ${name} body found`, !!body && /requireTeamAdmin\(/.test(body));
    ok(`KNOWN BUG R3-10: ${name} calls requireTeamAdmin without ownerOnly`,
      !!body && !/ownerOnly\s*:\s*true/.test(body));
  }
}

// ═══════════════════════════════════════════════════════════════════════
// R3-11 — createSignRequest emails a link to ANY signerEmail the caller
// supplies (never compared to the lead's email), from the platform domain,
// 20/min per uid with no daily cap. With open sign-up that is a phishing
// relay on nobigdealwithjoedeal.com.
// ═══════════════════════════════════════════════════════════════════════
{
  const src = stripComments(read('functions/remote-signing.js'));
  const body = handlerAfter(src, 'exports.createSignRequest = onCall(');
  ok('R3-11 anchor: createSignRequest body found', !!body && /emails\.send\(/.test(body));
  ok('KNOWN BUG R3-11: signerEmail is taken from request data and never bound to lead.email',
    !!body && /d\.signerEmail/.test(body) && !/lead\.email|recipientOnRecord/.test(body));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
