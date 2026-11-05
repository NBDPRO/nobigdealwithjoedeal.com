/* portal-photo-self-announce-2026-09-16.test.js
 *
 * A 2026-09-08 recon flagged: "homeowner's own photo upload gets announced
 * back to them as 'new photo from your rep'." Re-verified live: still true.
 *
 * Root cause: uploadHomeownerPhoto writes the homeowner's own submission
 * into the SAME sharedWithHomeowner-gated photos array the gallery reads,
 * and the live-update diff compared bare photo-count (prev.length vs
 * next.length) with no idea which photo was added or who added it. Every
 * self-upload silently misattributed itself as a rep action within one
 * 30s poll cycle.
 *
 * Two-part fix, tested together since patching only one half is a no-op:
 *   1. functions/portal.js's getHomeownerPortalView now sends `source` on
 *      each photo ('homeowner' | 'rep') — previously stripped along with
 *      the other internal-only fields.
 *   2. docs/pro/js/portal.js's _diffView now diffs photos by id (not bare
 *      length) and excludes source:'homeowner' entries before deciding
 *      whether to fire the "from your rep" banner.
 *
 * Same house style as portal-scheduled-date.test.js: vm-lift the pure
 * function, run direct scenario assertions (no browser/emulator needed for
 * the client half), and regex-assert the server half's shape against raw
 * source text.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const PORTAL = read('docs/pro/js/portal.js');
const PORTAL_FN = read('functions/portal.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

/* ── lift _diffView by matching brace depth, not a naive '\n  }\n' scan —
   the function contains nested if-blocks that close at the same 2-space
   indent, which is exactly the trap that bit the first draft of this test. ── */
function liftFunction(src, name) {
  const sig = 'function ' + name + '(';
  const start = src.indexOf(sig);
  if (start < 0) return null;
  const bodyStart = src.indexOf('{', start);
  let depth = 0, i = bodyStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return i < src.length ? src.slice(start, i + 1) : null;
}

const diffSrc = liftFunction(PORTAL, '_diffView');
group('_diffView is present and liftable', () => {
  assert('found _diffView in docs/pro/js/portal.js', !!diffSrc,
    'if it moved or its brace structure changed, update the extractor — do NOT delete the suite');
});
if (!diffSrc) { console.log('\ncannot continue'); console.log(passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); }

// 2026-11-04: _diffView also repaints on a posted payment and reads the
// paidSoFarCents helper (tests/portal-pay-panel-2026-11-04.test.js).
const paidSrc = liftFunction(PORTAL, 'paidSoFarCents') || '';
const ctx = { Set, Array, Number, Math };
vm.createContext(ctx);
vm.runInContext(paidSrc + '\n' + diffSrc + '\nthis.__d = _diffView;', ctx);
const diffView = ctx.__d;

/* ══════════════════════════════════════════════════════════════════
   1. The bug scenario, exactly — and its inverse
   ══════════════════════════════════════════════════════════════════ */
group('A homeowner\'s own upload never announces "from your rep"', () => {
  const prev = { photos: [{ id: 'a', source: 'rep' }] };
  const next = { photos: [{ id: 'a', source: 'rep' }, { id: 'b', source: 'homeowner' }] };
  const events = diffView(prev, next);
  const photoEvents = (events || []).filter((e) => e.kind === 'photos');
  assert('no photos event fires for a homeowner-only addition', photoEvents.length === 0,
    JSON.stringify(events));
});

group('A rep-shared photo still announces correctly (the fix must not break the real case)', () => {
  const prev = { photos: [{ id: 'a', source: 'rep' }] };
  const next = { photos: [{ id: 'a', source: 'rep' }, { id: 'c', source: 'rep' }] };
  const events = diffView(prev, next);
  const photoEvents = (events || []).filter((e) => e.kind === 'photos');
  assert('exactly one photos event, delta 1', photoEvents.length === 1 && photoEvents[0].delta === 1,
    JSON.stringify(events));
  assert('message says "from your rep"', /from your rep/.test(photoEvents[0].msg), photoEvents[0].msg);
});

group('Mixed batch: only the rep-sourced photo counts', () => {
  const prev = { photos: [] };
  const next = { photos: [{ id: 'x', source: 'homeowner' }, { id: 'y', source: 'rep' }] };
  const events = diffView(prev, next);
  const photoEvents = (events || []).filter((e) => e.kind === 'photos');
  assert('delta is 1, not 2 — the homeowner\'s own photo is excluded from the count',
    photoEvents.length === 1 && photoEvents[0].delta === 1, JSON.stringify(events));
});

group('Legacy/missing source field defaults to counting (matches pre-fix behavior for anything not explicitly homeowner-tagged)', () => {
  const prev = { photos: [{ id: 'a' }] };
  const next = { photos: [{ id: 'a' }, { id: 'b' }] };
  const events = diffView(prev, next);
  const photoEvents = (events || []).filter((e) => e.kind === 'photos');
  assert('a photo with no source at all still announces (fail-open to the old behavior, not silently swallowed)',
    photoEvents.length === 1 && photoEvents[0].delta === 1, JSON.stringify(events));
});

group('Diffing by id, not length — a same-count swap does not fire, and a removal+add nets correctly', () => {
  // Same COUNT before/after (one photo removed, one different one added) —
  // a naive length-only diff would see pPhotos === nPhotos and announce
  // nothing, which is coincidentally correct here but for the wrong
  // reason; assert the id-based diff still gets the right answer when the
  // removed and added photos are BOTH rep-sourced (must announce the add).
  const prev = { photos: [{ id: 'old', source: 'rep' }] };
  const next = { photos: [{ id: 'new', source: 'rep' }] };
  const events = diffView(prev, next);
  const photoEvents = (events || []).filter((e) => e.kind === 'photos');
  assert('a same-count swap (one removed, one different one added) still announces the genuinely new photo',
    photoEvents.length === 1 && photoEvents[0].delta === 1,
    'A length-only diff would have missed this entirely — got ' + JSON.stringify(events));
});

group('No prior view (first paint) still returns null, unchanged', () => {
  assert('first paint announces nothing', diffView(null, { photos: [{ id: 'a', source: 'rep' }] }) === null);
});

/* ══════════════════════════════════════════════════════════════════
   2. The server half — source actually travels, and stays out of the
      docType/damageType-style internal fields it should NOT expose
   ══════════════════════════════════════════════════════════════════ */
group('getHomeownerPortalView ships photo source', () => {
  const block = PORTAL_FN.slice(
    PORTAL_FN.indexOf('photos: photoSnap.docs.map(d => {'),
    PORTAL_FN.indexOf('// D-2.7: auto-pair')
  );
  assert('found the photos redaction block', block.length > 0);
  assert('source is included, normalized to exactly \'homeowner\' or \'rep\'',
    /source:\s*p\.source === 'homeowner' \? 'homeowner' : 'rep'/.test(block), block);
  assert('still redacts the internal-only fields (no damageType/severity/location/tags leak)',
    !/damageType|severity|location|tags/.test(block), block);
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
