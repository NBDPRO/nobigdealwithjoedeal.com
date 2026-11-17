#!/usr/bin/env node
/**
 * honeypot-autofill-contract.test.js
 *
 * Tenant-lifecycle audit P6 (fixed 2026-08-05): the public lead-form
 * honeypot was `name="website"` — a name that matches Chromium's
 * URL-autofill heuristic. Browser autofill could fill the honeypot on a
 * REAL homeowner's form, and the gateway would then swallow the lead with
 * a fake success. The honeypot is now `nbd_hp` (id `fieldNbdHp` on the
 * homepage), a name no autofill heuristic recognizes; naive bots still
 * fill every input, so the trap keeps catching them.
 *
 * This contract pins both halves so the bug class cannot come back:
 *   1. No served page carries a honeypot named/id'd "website" again.
 *   2. Every lead-form emitter uses the nbd_hp honeypot, keeps it
 *      keyboard-invisible (tabindex="-1"), and keeps autocomplete="off".
 *   3. The gateway checks BOTH nbd_hp and the legacy website key
 *      (old cached pages / bot replays of the pre-rename shape).
 *
 * Zero dependencies. Run: node tests/honeypot-autofill-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ── 1. Sweep: no honeypot named "website" anywhere on the served marketing
//      surface. (pro/, admin/, dev/ are app surfaces with real business
//      "website" fields — onboarding, company profile — and are excluded.)
{
  const SKIP = new Set(['pro', 'admin', 'dev', 'node_modules']);
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (!/\.(html|js)$/.test(entry.name)) continue;
      const p = path.join(dir, entry.name);
      const src = fs.readFileSync(p, 'utf8');
      // Honeypot shapes only: an input NAMED/ID'd website. String-literal
      // form catches JS emitters (quick-lead-form.js builds markup).
      if (/name="website"|name='website'|id="fieldWebsite"|id="qWebsite"/.test(src)) {
        offenders.push(path.relative(ROOT, p));
      }
    }
  })(path.join(ROOT, 'docs'));
  ok('no honeypot named "website" on the served surface' +
     (offenders.length ? ' — found: ' + offenders.join(', ') : ''),
     offenders.length === 0);
}

// ── 2. Every emitter uses nbd_hp and keeps the input keyboard-invisible.
{
  const qlf = read('docs/assets/js/quick-lead-form.js');
  ok('quick-lead-form renders name="nbd_hp"', qlf.includes('name="nbd_hp"'));
  ok('quick-lead-form honeypot keeps tabindex="-1" + autocomplete="off"',
     /name="nbd_hp"[^>]*tabindex="-1"[^>]*autocomplete="off"/.test(qlf));
  ok('quick-lead-form posts the nbd_hp key', /nbd_hp:\s/.test(qlf));

  const tHtml = read('docs/sites/t/index.html');
  const tJs = read('docs/sites/t/site.js');
  ok('tenant microsite renders name="nbd_hp"', tHtml.includes('name="nbd_hp"'));
  ok('tenant microsite honeypot keeps tabindex="-1"',
     /name="nbd_hp"[^>]*tabindex="-1"/.test(tHtml));
  ok('tenant microsite posts the nbd_hp key', /nbd_hp:\s/.test(tJs));

  const frHtml = read('docs/free-roof/index.html');
  const frJs = read('docs/assets/js/inline/0a394536a8.js');
  ok('free-roof renders name="nbd_hp"', frHtml.includes('name="nbd_hp"'));
  ok('free-roof inline JS checks nbd_hp', frJs.includes("fd.get('nbd_hp')"));
  ok('free-roof inline JS strips both honeypot keys before posting',
     /k === 'nbd_hp' \|\| k === 'website'/.test(frJs));

  const fgHtml = read('docs/sites/free-guide/index.html');
  const fgJs = read('docs/assets/js/inline/3117b8ac17.js');
  ok('free-guide renders name="nbd_hp" on both forms',
     (fgHtml.match(/name="nbd_hp"/g) || []).length === 2);
  ok('free-guide inline JS checks nbd_hp',
     fgJs.includes('input[name="nbd_hp"]'));

  const homeHtml = read('docs/index.html');
  const homeJs = read('docs/assets/js/inline/72f02d79d0.js');
  // 2026-11-17: #contact hosts the quick form, whose nbd_hp honeypot the component builds.
  ok('homepage #contact hosts the quick form (its honeypot is the component\'s nbd_hp)', /data-nbd-quick-form/.test(homeHtml) && !homeHtml.includes('id="fieldNbdHp"'));
  ok('quick-lead-form honeypot keeps tabindex="-1" and name="nbd_hp"',
     /qlf-hp[\s\S]{0,80}name="nbd_hp" tabindex="-1"/.test(read('docs/assets/js/quick-lead-form.js')));
  ok('homepage inline JS checks fieldNbdHp',
     homeJs.includes("getElementById('fieldNbdHp')"));
}

// ── 3. The gateway checks both keys, live first.
{
  const handler = read('functions/handlers/integrations.js');
  ok('gateway checks nbd_hp AND legacy website',
     /\[\s*'nbd_hp',\s*'website'\s*\]/.test(handler));
  ok('gateway honeypot stays truthy-not-just-string',
     /body\[k\] != null && String\(body\[k\]\)\.length > 0/.test(handler));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failed:\n  - ' + fails.join('\n  - ')); process.exit(1); }
