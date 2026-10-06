/**
 * tests/sec-r3-e2e-flag-portal-path-2026-10-06.test.js
 *
 * Regression guards for the two HIGH findings of phased review round 3
 * (2026-10-06, report nbd-content/review-r3-2026-10-06.md):
 *
 *   R3-2  Any signed-in user could delete any Storage object. They set
 *         users/{uid}.e2eTestAccount on their own doc (rules let them), planted
 *         a photo whose storagePath named a victim's object, and called
 *         cleanupE2ETestData, which deleted it with the admin SDK.
 *   R3-3  Any user could get a 7-day signed read URL for any object. They put
 *         source:'homeowner' + a foreign `path` on their own photo, and
 *         getHomeownerPortalView signed that path and wrote the URL back.
 *
 * The rules halves live in firestore-rules.cross-tenant.test.js §D2 (emulator).
 * This file covers the server halves: the pure path checks, and source guards
 * that each server path actually CALLS its check, before the dangerous call,
 * with comments stripped so a comment naming the helper cannot satisfy them.
 *
 * Pure Node, no emulator. Run: node tests/sec-r3-e2e-flag-portal-path-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { isOwnE2ECleanupPath } = require(path.join(ROOT, 'functions', 'lead-artifact-paths.js'));

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

// Block comments, then full-line // comments. Trailing comments are left alone
// on purpose: the guarded code contains '//' inside string literals.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// Body of the first brace block that opens after `anchor`.
function bodyAfter(src, anchor) {
  const at = src.indexOf(anchor);
  if (at === -1) return null;
  const open = src.indexOf('{', at + anchor.length - 1);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

// ─── R3-2: isOwnE2ECleanupPath ─────────────────────────────────────────────
console.log('R3-2 isOwnE2ECleanupPath');
const UID = 'e2eUid123';
ok('own photo is deletable', isOwnE2ECleanupPath(`photos/${UID}/lead1/a.jpg`, UID));
ok('own thumb is deletable', isOwnE2ECleanupPath(`photos/${UID}/lead1/thumbs/a_thumb.jpg`, UID));
ok('own docgen html is deletable', isOwnE2ECleanupPath(`documents/${UID}/lead1/doc1.html`, UID));
ok("victim's photo is refused", !isOwnE2ECleanupPath('photos/victim/lead1/a.jpg', UID));
ok("victim's contract render is refused", !isOwnE2ECleanupPath('pdf-renders/victim/1700000000000-contract.pdf', UID));
ok("victim's document is refused", !isOwnE2ECleanupPath('documents/victim/leadA/contract.html', UID));
ok('call recordings are refused', !isOwnE2ECleanupPath(`calls/${UID}/x.mp3`, UID));
ok('esign is refused even under own uid', !isOwnE2ECleanupPath(`esign/${UID}/env/signed.pdf`, UID));
ok('uid-prefix lookalike is refused', !isOwnE2ECleanupPath(`photos/${UID}evil/a.jpg`, UID));
ok('bare prefix (no trailing slash) is refused', !isOwnE2ECleanupPath(`photos/${UID}`, UID));
ok('dot-dot is refused', !isOwnE2ECleanupPath(`photos/${UID}/../victim/a.jpg`, UID));
ok('double slash is refused', !isOwnE2ECleanupPath(`photos/${UID}//a.jpg`, UID));
ok('backslash is refused', !isOwnE2ECleanupPath(`photos/${UID}/..\\victim\\a.jpg`, UID));
ok('leading slash is refused', !isOwnE2ECleanupPath(`/photos/${UID}/a.jpg`, UID));
ok('empty uid is refused', !isOwnE2ECleanupPath('photos//a.jpg', ''));
ok('uid with a slash is refused', !isOwnE2ECleanupPath('photos/a/b/c.jpg', 'a/b'));
ok('non-string path is refused', !isOwnE2ECleanupPath({ toString: () => `photos/${UID}/a` }, UID));
ok('missing path is refused', !isOwnE2ECleanupPath(undefined, UID));

// ─── R3-2: cleanupE2ETestData calls the check before every delete ──────────
console.log('R3-2 cleanupE2ETestData wiring');
{
  const src = stripComments(read('functions/handlers/auth.js'));
  ok('auth.js imports isOwnE2ECleanupPath from lead-artifact-paths',
    /const\s*\{\s*isOwnE2ECleanupPath\s*\}\s*=\s*require\(\s*'\.\.\/lead-artifact-paths'\s*\)/.test(src));
  const exAt = src.indexOf('exports.cleanupE2ETestData = onCall(');
  const body = exAt === -1 ? null : bodyAfter(src.slice(exAt), 'async (request) =>');
  ok('cleanupE2ETestData body found', !!body && body.length > 500);
  const del = body && bodyAfter(body, 'const deleteStorageObject = async (objectPath) =>');
  ok('deleteStorageObject body found', !!del);
  const guardAt = del ? del.search(/if\s*\(\s*!\s*isOwnE2ECleanupPath\(\s*objectPath\s*,\s*uid\s*\)\s*\)/) : -1;
  const deleteAt = del ? del.search(/bucket\.file\(\s*objectPath\s*\)\.delete\(\)/) : -1;
  ok('deleteStorageObject refuses paths outside the caller prefix', guardAt !== -1);
  ok('...and the refusal returns before the delete', guardAt !== -1 && deleteAt !== -1 && guardAt < deleteAt
    && /return\s*;/.test(del.slice(guardAt, deleteAt)));
  // Every Storage delete in the handler goes through the guarded helper.
  const rawDeletes = (body || '').match(/\.file\([^)]*\)\.delete\(/g) || [];
  ok('the handler has exactly one Storage delete (inside the guarded helper)', rawDeletes.length === 1);
}

// ─── R3-3: _isHomeownerUploadPath ──────────────────────────────────────────
console.log('R3-3 _isHomeownerUploadPath');
{
  const src = stripComments(read('functions/portal.js'));
  const fnAt = src.indexOf('function _isHomeownerUploadPath(');
  const fnBody = fnAt === -1 ? null : bodyAfter(src.slice(fnAt), 'function _isHomeownerUploadPath(');
  ok('_isHomeownerUploadPath found', !!fnBody);
  // eslint-disable-next-line no-new-func
  const check = fnBody ? new Function('path', 'ownerUid', 'leadId', fnBody) : () => true;
  const O = 'ownerUid1', L = 'lead1';
  ok('the portal upload path is signable', check(`homeowner-uploads/${O}/${L}/1700000000000.jpg`, O, L) === true);
  ok("another tenant's contract render is refused", check('pdf-renders/victim/1700000000000-contract.pdf', O, L) === false);
  ok("another tenant's document is refused", check('documents/victim/leadA/contract.html', O, L) === false);
  ok("the owner's own pdf-renders are refused", check(`pdf-renders/${O}/x.pdf`, O, L) === false);
  ok("another owner's homeowner upload is refused", check(`homeowner-uploads/victim/${L}/1.jpg`, O, L) === false);
  ok("another lead's homeowner upload is refused", check(`homeowner-uploads/${O}/otherLead/1.jpg`, O, L) === false);
  ok('lead-id lookalike is refused', check(`homeowner-uploads/${O}/${L}x/1.jpg`, O, L) === false);
  ok('dot-dot is refused', check(`homeowner-uploads/${O}/${L}/../../victim/x`, O, L) === false);
  ok('double slash is refused', check(`homeowner-uploads/${O}/${L}//x`, O, L) === false);
  ok('missing ownerUid is refused', check(`homeowner-uploads//${L}/1.jpg`, '', L) === false);
  ok('missing leadId is refused', check(`homeowner-uploads/${O}//1.jpg`, O, '') === false);
  ok('non-string path is refused', check(null, O, L) === false);

  // ─── R3-3: the refresher filters on it, and the portal passes the token ──
  console.log('R3-3 _refreshHomeownerPhotoUrls wiring');
  const refAt = src.indexOf('async function _refreshHomeownerPhotoUrls(');
  const sig = refAt === -1 ? '' : src.slice(refAt, src.indexOf('{', refAt));
  ok('_refreshHomeownerPhotoUrls takes ownerUid and leadId', /\(\s*docs\s*,\s*nowMs\s*,\s*ownerUid\s*,\s*leadId\s*\)/.test(sig));
  const ref = refAt === -1 ? null : bodyAfter(src.slice(refAt), 'async function _refreshHomeownerPhotoUrls(');
  const filterAt = ref ? ref.search(/_isHomeownerUploadPath\(\s*p\.path\s*,\s*ownerUid\s*,\s*leadId\s*\)/) : -1;
  const signAt = ref ? ref.search(/getSignedUrl\(/) : -1;
  ok('the stale filter requires _isHomeownerUploadPath(p.path, ownerUid, leadId)', filterAt !== -1);
  ok('...and the filter runs before any signing', filterAt !== -1 && signAt !== -1 && filterAt < signAt);
  ok('signing reads only filtered docs (stale.map)', !!ref && /stale\.map\(/.test(ref.slice(filterAt)));
  const calls = src.match(/_refreshHomeownerPhotoUrls\([^;\n]*\)/g) || [];
  const callSites = calls.filter((c) => !/\(\s*docs\s*,/.test(c));
  ok('there is exactly one call site', callSites.length === 1);
  ok('the call site passes tok.ownerUid and tok.leadId',
    callSites.length === 1 && /,\s*tok\.ownerUid\s*,\s*tok\.leadId\s*\)$/.test(callSites[0]));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
