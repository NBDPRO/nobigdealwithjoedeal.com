// CRM audit 2026-11-06 (PL-F23): the Keyboard Shortcuts "Got it" button closes
// the panel. It targeted div[style*=fixed], but the overlay is class-styled, so
// closest() found nothing and the button did nothing. Runs the shipped function.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/dashboard-bootstrap.module.js'), 'utf8');
let passed = 0, failed = 0;
function check(name, ok) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }

const lines = src.split(/\r?\n/);
const i = lines.findIndex((l) => /^  function showShortcutsHelp\(\)/.test(l));
const j = lines.findIndex((l, k) => k > i && l === '  }');
const fn = i >= 0 && j > i ? lines.slice(i, j + 1).join('\n') : '';
check('showShortcutsHelp is present', !!fn);

let html = '', inserts = 0, attached = null;
const byId = {};
const document = {
  body: { insertAdjacentHTML: (_, h) => { inserts++; html = h; const m = h.match(/<div id="([^"]+)"/); if (m) byId[m[1]] = { id: m[1], remove() { delete byId[m[1]]; } }; } },
  getElementById: (id) => byId[id] || null,
};
const window = { nbdOverlay: { attach: (el, opts) => { attached = { el, opts }; } } };
try { vm.runInNewContext(fn + '\nshowShortcutsHelp(); showShortcutsHelp();', { document, window }); } catch (e) { check('runs: ' + e.message, false); }

const overlay = (html.match(/<div[^>]*data-action="removeSelf"[^>]*>/) || [''])[0];
const target = (html.match(/data-action="removeClosest" data-target="([^"]+)"/) || [])[1] || '';
check('"Got it" has a close target', !!target);
// The target must select the overlay itself: an #id that the overlay carries, or
// an attribute the overlay actually has. div[style*=fixed] does not match a
// class-styled overlay.
const idT = target.match(/^#([\w-]+)$/);
check('the close target selects the overlay that is on the page', !!idT && overlay.includes('id="' + idT[1] + '"'));
check('the old style-attribute selector is gone', !/style\*=/.test(target));
check('pressing ? twice does not stack a second panel', inserts === 1);
check('Escape / focus return come from the shared dialog contract', !!attached && typeof attached.opts.close === 'function');
if (attached) attached.opts.close();
check('Escape (close) removes the panel', !document.getElementById(idT ? idT[1] : 'x'));

console.log('\nshortcuts-help-close: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
