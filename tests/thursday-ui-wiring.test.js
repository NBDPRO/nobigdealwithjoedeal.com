/**
 * tests/thursday-ui-wiring.test.js — the CRM wiring for Thursday calls
 * (2026-09-26) that would regress silently:
 *
 *   1. customer.html jump-nav order === section DOM order (the scroll-spy in
 *      customer-tasks-ui.js maps them positionally; a mismatch makes the
 *      highlight jump) — and the new Calls section is in both.
 *   2. Every lead-source <select> in dashboard.html offers exactly the twelve
 *      canonical sources (functions/integrations/thursday-logic.js
 *      CANONICAL_SOURCES). Thursday writes Google / Direct / Storm Alert; a
 *      select missing one shows blank and the next Save wipes the source.
 *   3. The site CSP lets the recording play from a blob: URL (media-src),
 *      and the portal policy mirrors it.
 *   4. widgets.js getActiveWidgets() — run in a vm sandbox — shows the
 *      Thursday card only when the tenant is connected and the user has not
 *      hidden it, and always pins it first.
 *
 * Run: node tests/thursday-ui-wiring.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'functions', 'integrations', 'thursday-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('THURSDAY UI WIRING');

// 1. customer.html nav order
{
  const html = fs.readFileSync(path.join(ROOT, 'docs/pro/customer.html'), 'utf8');
  const nav = (/<nav class="jump-nav" id="tabBar"[\s\S]*?<\/nav>/.exec(html) || [''])[0];
  const links = [...nav.matchAll(/href="#([A-Za-z]+)"/g)].map((m) => m[1]);
  const sections = [...html.matchAll(/<div class="tab-content[^"]*" id="([A-Za-z]+)"/g)].map((m) => m[1]);
  ok('jump-nav order matches section DOM order', JSON.stringify(links) === JSON.stringify(sections),
    'nav ' + links.join(',') + ' vs sections ' + sections.join(','));
  ok('Calls section present in nav and DOM', links.indexOf('callsTab') !== -1 && sections.indexOf('callsTab') !== -1);
  ok('Calls sits between Messages and Voice Intel',
    sections.indexOf('callsTab') === sections.indexOf('messagesTab') + 1 && sections.indexOf('voiceTab') === sections.indexOf('callsTab') + 1);
  ok('customer-calls.js loaded with defer', /<script defer src="js\/customer-calls\.js\?v=\d+"><\/script>/.test(html));
  ok('Calls nav badge exists for nbdNavCount', /id="navCountCalls"/.test(html));
}

// 2. lead-source selects
{
  const html = fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8');
  for (const id of ['lSource', 'qaSource', 'bulkSourceSelect']) {
    const m = new RegExp('<select[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</select>').exec(html);
    const opts = m ? [...m[1].matchAll(/<option(?:\s+value="([^"]*)")?[^>]*>([^<]*)<\/option>/g)]
      .map((o) => (o[1] !== undefined ? o[1] : o[2]).trim()).filter(Boolean) : [];
    const missing = T.CANONICAL_SOURCES.filter((s) => opts.indexOf(s) === -1);
    const extra = opts.filter((s) => T.CANONICAL_SOURCES.indexOf(s) === -1);
    ok('#' + id + ' offers all twelve canonical sources', m && !missing.length && !extra.length,
      'missing ' + missing.join('/') + ' extra ' + extra.join('/'));
  }
}

// 3. CSP media-src
{
  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const hosting = [].concat(fb.hosting)[0];
  const cspOf = (src) => {
    const r = hosting.headers.find((h) => h.source === src);
    return r ? r.headers.filter((x) => /^Content-Security-Policy/i.test(x.key)).map((x) => x.value) : [];
  };
  for (const src of ['**', '/pro/portal']) {
    const vals = cspOf(src);
    ok(src + ': enforced + report-only CSP allow media from self and blob:',
      vals.length === 2 && vals.every((v) => /media-src 'self' blob:/.test(v)), vals.length + ' policies');
  }
}

// 4. widgets.js gating, executed
{
  const src = fs.readFileSync(path.join(ROOT, 'docs/pro/js/widgets.js'), 'utf8');
  const store = {};
  const sandbox = {
    window: {}, document: { getElementById: () => null, addEventListener() {}, querySelector: () => null },
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    console, setTimeout, Promise, JSON, Date, Math,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  let loadErr = null;
  try { vm.runInContext(src, sandbox); } catch (e) { loadErr = e; }
  ok('widgets.js loads in a sandbox', !loadErr && sandbox.NBDWidgets, loadErr && loadErr.message);
  if (sandbox.NBDWidgets) {
    const get = sandbox.NBDWidgets.getActive;
    ok('registry has the thursday-calls widget', sandbox.NBDWidgets.WIDGETS.some((w) => w.id === 'thursday-calls'));
    ok('gate unknown → not shown', get().indexOf('thursday-calls') === -1);
    // _thuGateState is module-local (inside the IIFE), as intended, so it is
    // exercised through the only public paths that change it.
    sandbox.showToast = () => {};
    store.nbd_home_widgets = JSON.stringify(['pipeline-value', 'thursday-calls', 'hot-leads']);
    ok('saved layout containing thursday-calls is filtered while the gate is unknown', get().indexOf('thursday-calls') === -1);
    sandbox.NBDWidgets.toggleWidget('thursday-calls', true); // user turns it on → gate { enabled:true, hidden:false }
    const after = get();
    ok('once enabled + not hidden → pinned first', after[0] === 'thursday-calls' && after.filter((x) => x === 'thursday-calls').length === 1, JSON.stringify(after));
    sandbox.NBDWidgets.removeWidget('thursday-calls');
    ok('after the user removes it → hidden', get().indexOf('thursday-calls') === -1, JSON.stringify(get()));
  }
}

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
