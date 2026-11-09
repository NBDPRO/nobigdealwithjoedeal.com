/**
 * tests/pwa-confirm-guard.test.js
 *
 * Keeps the iOS-PWA confirm() migration from silently backsliding.
 *
 * THE BUG THIS GUARDS
 * ───────────────────
 * docs/pro/js/standalone-compat.js runs ONLY when the site is open from the
 * home screen (`if (!isStandalone) return;`) and replaces window.confirm with:
 *
 *     window.confirm = function(msg) { ...toast...; return true; };
 *
 * So in the installed PWA — the owner's actual platform — every native
 * confirm() answers YES. "Delete this expense?", "Reset all products to
 * defaults?", "Reset every Company Profile field?" all just happened, and
 * generating a photo report silently EMAILED it to the homeowner because that
 * confirm was an OK=email / Cancel=download choice.
 *
 * The fix is per-call-site: route through window.nbdConfirm (a real
 * Promise<boolean> modal that only exists in standalone mode) with a native
 * fallback for desktop:
 *
 *     const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
 *     if (!(await ask('…'))) return;
 *
 * A previous batch converted ~20 files and stopped; 2026-09-03 finished the
 * sweep. This test exists so the next raw confirm() someone adds is caught at
 * review time rather than discovered by a contractor losing a day of work.
 *
 * Pure-Node, no emulator. Run: node tests/pwa-confirm-guard.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'docs', 'pro', 'js');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else {
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''));
    failed++; fails.push(label + (detail ? ' — ' + detail : ''));
  }
}

/**
 * Raw native-confirm call sites that are allowed to remain, with the reason.
 * Counts are EXACT: a new one fails the test, and so does a stale entry, so
 * the list can only shrink deliberately. Keyed by file, not by line number,
 * so ordinary edits above a site do not churn this table.
 *
 * Dated 2026-09-03. Shrink it; do not grow it.
 */
const ALLOWLIST = {
  // The documented last-resort tail of _prospectConfirm: it tries
  // window.nbdConfirm first and only falls through to native confirm when the
  // modal helper is absent (i.e. desktop). Converting it would remove the
  // fallback the whole idiom depends on.
  'dashboard-actions.js': { count: 1, why: 'native tail of _prospectConfirm, after its nbdConfirm branch' },
  // (maps-routing.js's one site — Generate Estimate's V2-or-Classic native
  // confirm — is gone: draw lane L2, 2026-09-25, replaced it with an in-page
  // chooser that names both builders. The list shrank, as intended.)
  // (pricing-page.module.js's one site — "Create your account to continue?"
  // before the register redirect — is gone: CRM audit ST-F63, 2026-11-08, a
  // signed-out visitor now goes straight to register. The list shrank.)
  // Both are the `else` branch of a nbdModal.confirm() call — the desktop
  // fallback, same role as the `||` in the canonical idiom.
  'storm-center.js': { count: 2, why: 'desktop fallback branches of nbdModal.confirm' },
};

// A confirm( that is a real call: not nbdConfirm, not nbdModal.confirm, not
// the patch's own assignment, and not inside a line comment.
function rawConfirmSites(src) {
  const out = [];
  src.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (!/\bconfirm\s*\(/.test(line)) return;
    if (/nbdConfirm|nbdModal\s*\.\s*confirm|window\.confirm\s*=|_origConfirm/.test(line)) return;
    out.push({ line: i + 1, text: trimmed.slice(0, 120) });
  });
  return out;
}

// RECURSIVE since 2026-09-03. This was `fs.readdirSync(JS_DIR)` — one level —
// so the whole of docs/pro/js/pages/ (20 files) was never scanned, and it
// contained two live destructive raw confirms the guard structurally could not
// see: photo-review.js ("Delete N photos? This can't be undone.") and
// understand.js ("Delete all saved insights?"). photo-review is the exact
// surface this suite's own docblock names as the motivating bug.
//
// The anti-vacuity assertion below (files.length > 100) passed the whole time
// and read as proof of coverage while a subtree was invisible — a gate that
// counts what it looked at, not what exists. Walk everything, and let the
// count assertion cover the walk.
function walkJs(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...walkJs(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}
const files = walkJs(JS_DIR, '').sort();
// standalone-compat.js DEFINES the patch and nbd-modal.js defines the modal —
// both legitimately contain the word.
const EXEMPT = new Set(['standalone-compat.js', 'nbd-modal.js']);

console.log('\nNO NEW RAW confirm() — the PWA answers every one of them YES');
{
  const found = {};
  for (const f of files) {
    if (EXEMPT.has(f)) continue;
    const sites = rawConfirmSites(fs.readFileSync(path.join(JS_DIR, f), 'utf8'));
    if (sites.length) found[f] = sites;
  }

  ok('scanned a plausible number of CRM modules (' + files.length + ')', files.length > 100);

  for (const [f, sites] of Object.entries(found)) {
    const alw = ALLOWLIST[f];
    if (!alw) {
      ok('NEW raw confirm() in ' + f, false,
         'line ' + sites[0].line + ': ' + sites[0].text
         + ' — route it through nbdConfirm, or add it to ALLOWLIST with a reason');
      continue;
    }
    ok(f + ' has exactly its ' + alw.count + ' allowed site(s) [' + alw.why + ']',
       sites.length === alw.count,
       'found ' + sites.length + ' (' + sites.map((s) => s.line).join(', ') + ')');
  }

  // Stale entries: an allowlisted file whose sites are all gone should be
  // removed from the table, so the list stays an honest inventory.
  for (const f of Object.keys(ALLOWLIST)) {
    ok('allowlist entry for ' + f + ' is not stale', !!found[f],
       'no raw confirm() left in that file — delete its ALLOWLIST entry');
  }
}

console.log('\nDESKTOP STILL WORKS — every nbdConfirm use keeps a native fallback');
{
  // window.nbdConfirm is defined ONLY inside standalone-compat's
  // `if (!isStandalone) return;` guard, so on desktop it is undefined. A
  // conversion that called it bare would throw and the guard would never
  // appear — worse than the bug being fixed.
  let checked = 0;
  for (const f of files) {
    if (EXEMPT.has(f)) continue;
    const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/nbdConfirm/.test(line)) return;
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      checked++;
      // Look at the whole STATEMENT, not the line: the fallback is routinely
      // wrapped onto the next line to stay inside the column limit. (The
      // first cut of this test read one line at a time and reported
      // referral-rewards-ui.js as unguarded when it was simply wrapped.)
      const stmt = lines.slice(i, i + 3).join(' ');
      // Acceptable shapes: the `||` fallback idiom, or an explicit
      // typeof/truthiness guard before use.
      const guarded = /nbdConfirm\s*\|\|/.test(stmt)
        || /typeof\s+window\.nbdConfirm\s*===\s*'function'/.test(stmt)
        || /window\.nbdConfirm\s*\?/.test(stmt)
        || /if\s*\(\s*window\.nbdConfirm\s*\)/.test(stmt);
      ok(f + ':' + (i + 1) + ' guards nbdConfirm', guarded, trimmed.slice(0, 100));
    });
  }
  ok('found nbdConfirm uses to check (' + checked + ')', checked > 20);
}

console.log('\nTHE NATIVE OVERRIDES MUST STAY DEAD');
{
  const src = fs.readFileSync(path.join(JS_DIR, 'standalone-compat.js'), 'utf8');

  // This block used to assert the OPPOSITE — that the confirm stub still
  // returned true — as a deliberate tripwire saying "if anyone makes this
  // honest, come back and revisit the migration". On 2026-09-03 it did its
  // job: the premise it was built on turned out to be false, the overrides
  // were removed, and the assertions flipped. Kept flipped, because
  // reintroducing them is the regression now.
  ok('window.confirm is NOT overridden', !/window\.confirm\s*=\s*function/.test(src));
  ok('window.prompt is NOT overridden', !/window\.prompt\s*=\s*function/.test(src));
  // The dead captures went with them; a fresh one is a sign someone is
  // rebuilding the stub. Match a DECLARATION, not the identifier — the
  // explanatory comment above the removal names _origConfirm in prose, and
  // the first cut of this assertion flagged that comment as the bug it was
  // describing. (_origOpen is a different thing and is still live: the
  // window.open patch genuinely calls through to it.)
  ok('no _origConfirm / _origPrompt captures remain',
     !/(?:const|let|var)\s+_orig(?:Confirm|Prompt|Alert)\b/.test(src));

  // alert() is deliberately still overridden: no return value, so it cannot
  // answer for the user, and a toast beats a blocking OS dialog on a phone.
  ok('window.alert IS still overridden (deliberate — it returns nothing)',
     /window\.alert\s*=\s*function/.test(src));

  // The landing pad for the whole migration lives in this file, inside the
  // standalone guard. Deleting the file — which an earlier plan proposed —
  // would silently revert all 61 migrated call sites to raw native confirm.
  ok('standalone-compat still defines window.nbdConfirm',
     /window\.nbdConfirm\s*=/.test(src));
  ok('standalone-compat still defines window.nbdPrompt',
     /window\.nbdPrompt\s*=/.test(src));
  ok('the file is still gated on standalone mode',
     /if\s*\(\s*!\s*isStandalone\s*\)\s*return/.test(src));

  // The corrected reasoning must stay with the code. A future reader who
  // finds a bare deletion will re-add the stub; one who finds the argument
  // will not.
  ok('the correction is documented at the override site',
     /NO LONGER OVERRIDDEN/.test(src) && /LocalDOMWindow/.test(src));
}

console.log('\n──────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
