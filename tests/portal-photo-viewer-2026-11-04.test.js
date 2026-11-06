/**
 * tests/portal-photo-viewer-2026-11-04.test.js
 *
 * Customer portal Phase 7 polish (documentation/projects/CUSTOMER-PORTAL-PLAN-2026-11-04.md):
 * project photos open in a native <dialog> viewer instead of dropping the
 * homeowner into a new tab. Behaviour was checked in a browser under the real
 * /pro CSP (open on tap, arrow keys + wrap, ✕ and backdrop close); this suite
 * guards the contract so a refactor cannot quietly break it.
 *
 * Run: node tests/portal-photo-viewer-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const code = stripComments(read('docs/pro/js/portal.js'));
const html = read('docs/pro/portal.html');
const viewer = code.slice(code.indexOf('function _photoViewer()'), code.indexOf("const A2HS_DISMISS_KEY"));

ok('a native <dialog>, opened modal', /document\.createElement\('dialog'\)/.test(viewer) && /dlg\.showModal\(\)/.test(viewer));
ok('only plain left clicks are taken over (ctrl/cmd/shift/alt/middle keep the new tab)',
  /e\.button !== 0 \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey\) return;/.test(viewer));
ok('no <dialog> support → the old link behaviour stays', /if \(typeof HTMLDialogElement !== 'function'\) return;/.test(viewer));
ok('only tiles in the project photo grid', /closest\('#portalPhotoGrid \.ph-tile'\)/.test(viewer) && /querySelectorAll\('#portalPhotoGrid \.ph-tile'\)/.test(viewer));
ok('the grid\'s photo_view listener is untouched (no stopPropagation)', !/stopPropagation/.test(viewer) && /if \(photoId\) _emitAuditEvent\('photo_view', photoId\);/.test(code));
ok('arrow keys and a 40px swipe step; the index wraps', /e\.key === 'ArrowLeft'/.test(viewer) && /e\.key === 'ArrowRight'/.test(viewer) && /Math\.abs\(dx\) > 40/.test(viewer) && /% tiles\.length/.test(viewer));
ok('close by ✕ and by the backdrop', /ph-viewer-close'\)\.addEventListener\('click', function \(\) \{ dlg\.close\(\); \}\)/.test(viewer) && /if \(e\.target === dlg\) dlg\.close\(\);/.test(viewer));
ok('the image comes from the tile\'s own (already-sanitized) href; nothing user-written goes into innerHTML', /img\.src = t\.getAttribute\('href'\);/.test(viewer)
  && /dlg\.innerHTML =\s*'<div class="ph-viewer-bar">'/.test(viewer) && !/dlg\.innerHTML[^;]*\+\s*(t\.|p\.|esc\()/.test(viewer));
ok('"Open full size" keeps the full image one tap away, in a new tab', /class="ph-viewer-full" target="_blank" rel="noopener"/.test(viewer));
ok('a count the screen reader hears ("2 of 3")', /aria-live="polite"/.test(viewer) && /\(_photoIdx \+ 1\) \+ ' of ' \+ tiles\.length/.test(viewer));
ok('44px touch targets and a contained image (no overflow)', /\.ph-viewer-close, \.ph-viewer-nav button\{[^}]*min-width:44px; min-height:44px/.test(html)
  && /\.ph-viewer-img\{[^}]*max-width:100%; max-height:100%/.test(html) && /\.ph-viewer\{[^}]*overflow:hidden/.test(html));
ok('portal.js cache-buster bumped (v>=25)', Number((html.match(/js\/portal\.js\?v=(\d+)/) || [])[1]) >= 25);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
