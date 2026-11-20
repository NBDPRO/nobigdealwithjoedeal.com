/**
 * tests/nbd-dialog-2026-11-19.test.js — agents can see and click NBD Pro dialogs.
 *
 * A native confirm/alert/prompt is outside the DOM and blocks CDP, so Claude in
 * Chrome / Playwright time out and the tab looks frozen. This pins:
 *   1. the helper contract (nbd-dialog.js + standalone-compat.js: roles, stable ids),
 *   2. nbdConfirm/nbdPrompt exist in a normal browser tab, not only the installed app,
 *   3. every docs/pro/*.html page whose scripts use the dialog helpers (or native
 *      dialogs) loads a provider,
 *   4. no raw native prompt()/alert() in docs/pro outside an explicit allowlist.
 * Pure Node. Run: node tests/nbd-dialog-2026-11-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const PRO = path.join(__dirname, '..', 'docs', 'pro');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const read = (p) => fs.readFileSync(p, 'utf8');

console.log('\n1. helper contract');
const dlg = read(path.join(PRO, 'js', 'nbd-dialog.js'));
const sc = read(path.join(PRO, 'js', 'standalone-compat.js'));
for (const [name, src] of [['nbd-dialog.js', dlg], ['standalone-compat.js', sc]]) {
  ok(name + ': role=dialog + aria-modal', /'role',\s*(kind === 'alert' \? 'alertdialog' : )?'dialog'/.test(src) && /'aria-modal',\s*'true'/.test(src));
  ok(name + ': stable ids nbd-dialog / -confirm / -cancel / -input',
    ['nbd-dialog', 'nbd-dialog-confirm', 'nbd-dialog-cancel', 'nbd-dialog-input'].every((id) => src.includes("'" + id + "'")));
  ok(name + ': data-testid hooks', /data-testid/.test(src));
  ok(name + ': Escape handled', /'Escape'/.test(src));
  ok(name + ': no inline handlers', !/\bon(click|keydown)\s*=/.test(src));
}
ok('nbd-dialog.js: Tab is trapped', /'Tab'/.test(dlg));
ok('nbd-dialog.js: yields to an existing provider', /if \(window\.nbdConfirm\) return;/.test(dlg));
ok('nbd-dialog.js: strings via textContent, never innerHTML', /textContent/.test(dlg) && !/innerHTML/.test(dlg));

console.log('\n2. dialogs exist in a normal browser tab');
{
  const gate = sc.indexOf('if (!isStandalone) return;');
  const def = sc.indexOf('window.nbdConfirm = function');
  ok('standalone-compat defines nbdConfirm BEFORE the standalone-only gate', def > 0 && gate > def);
  ok('standalone-compat defines nbdPrompt before the gate', sc.indexOf('window.nbdPrompt = function') < gate);
  ok('no early standalone return above the dialog definitions', sc.indexOf('if (!isStandalone) return;') === gate);
}

console.log('\n3. every page that needs a dialog provider loads one');
{
  const pages = fs.readdirSync(PRO).filter((f) => f.endsWith('.html'));
  let needed = 0;
  for (const page of pages) {
    const html = read(path.join(PRO, page));
    const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"?#]+)/g)].map((m) => m[1])
      .filter((s) => !/^(https?:)?\/\//.test(s));
    const hasProvider = srcs.some((s) => /(^|\/)(nbd-dialog|standalone-compat)\.js$/.test(s));
    const uses = srcs.some((s) => {
      const p = path.join(PRO, s.replace(/^\/pro\//, ''));
      if (!fs.existsSync(p)) return false;
      return /nbdConfirm|nbdPrompt|(^|[^.\w$])(confirm|alert|prompt)\(/m.test(read(p));
    });
    if (uses) needed++;
    if (uses) ok(page + ' loads nbd-dialog.js or standalone-compat.js', hasProvider);
  }
  ok('found pages that use dialogs (' + needed + ')', needed >= 6);
}

console.log('\n4. no raw native prompt()/alert() — allowlist, counts exact');
const ALLOW = {
  // Last-resort tails after a typeof window.nbdPrompt === 'function' branch.
  'js/customer-gallery-share.js': 1, 'js/estimate-crm-ops.js': 1, 'js/invoice-pipeline.js': 1,
  // Public, customer-facing deal-room page: carries no CRM scripts, not agent-driven.
  'deal-room.js': 2,
  // alert() is rerouted globally (standalone-compat.js on dashboard/customer, nbd-dialog.js
  // elsewhere), so these never reach a native alert on a page that loads a provider.
  'js/data-import.js': 1, 'js/document-generator.js': 1, 'js/email_system.js': 5, 'js/pricing-page.module.js': 1,
};
function walk(d, out) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js') && !e.name.endsWith('.min.js')) out.push(p);
  }
  return out;
}
const found = {};
for (const f of walk(PRO, [])) {
  const rel = path.relative(PRO, f).split(path.sep).join('/');
  if (rel === 'js/nbd-dialog.js' || rel === 'js/standalone-compat.js') continue;
  let n = 0;
  read(f).split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    if (/nbdPrompt|nbdAlert|function prompt\b/.test(line)) return;
    const code = line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`/g, "''");
    n += (code.match(/(^|[^.\w$])(window\.)?(prompt|alert)\(/g) || []).length;
    if (/window\.(prompt|alert)\(/.test(code) && !/(^|[^.\w$])(window\.)?(prompt|alert)\(/.test(code)) n++;
  });
  if (n) found[rel] = n;
}
for (const [f, n] of Object.entries(found)) ok(f + ' native prompt/alert count ' + n + ' = allowed ' + (ALLOW[f] || 0), (ALLOW[f] || 0) === n);
for (const f of Object.keys(ALLOW)) ok(f + ' allowlist entry is not stale', !!found[f]);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
