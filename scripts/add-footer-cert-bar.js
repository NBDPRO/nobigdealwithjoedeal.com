#!/usr/bin/env node
/**
 * add-footer-cert-bar.js — footer GAF+TAMKO cert bar sweep (2026-07-20).
 *
 * The hub/blog/legal pages (51 of them) carry a footer certification bar:
 * GAF Certified badge + TAMKO Pro Gold badge, each linking to the
 * manufacturer's verify page, plus the full independent-contractor
 * disclaimer including "GAF ID 1162011" / "TAMKO Pro ID 181382".
 * The 121 city service pages and 25 area city pages were missing it —
 * they had either a short trademark-only line (the 25 roof-replacement
 * city pages) or nothing at all.
 *
 * This sweep ports the bar from docs/services/roof-replacement.html
 * (inner markup byte-identical; only the wrapper div is adapted for the
 * centered single-column footers these pages use), inserts it as the
 * first child of <footer>, and removes the superseded short disclaimer
 * where present.
 *
 * Targets: docs/services/*-oh.html + *-ky.html (city service pages) and
 * docs/areas/*.html minus index.html (area city pages).
 *
 * Idempotent — skips files already carrying data-nbd-certbar="v1" or the
 * GAF ID. Preserves each file's CRLF/LF line endings.
 *
 * Run: node scripts/add-footer-cert-bar.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DOCS = path.resolve(__dirname, '..', 'docs');
const MARKER = 'data-nbd-certbar="v1"';

// Wrapper adapted for the centered 40px-padding city/area footers
// (max-width + auto margins + left-aligned text); badge anchors, badge
// imgs and the disclaimer <p> are byte-identical to the hub footer bar
// in docs/services/roof-replacement.html.
const CERT_BAR = [
  '  <!-- FOOTER CERT BAR (injected 2026-07-20) -->',
  `  <div ${MARKER} style="max-width:1100px;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;text-align:left">`,
  '    <a href="https://www.gaf.com/en-us/roofing-contractors/residential" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 12px;text-decoration:none;line-height:1.2">',
  '      <img src="/assets/gaf/gaf-certified-badge-120.png" alt="GAF Certified™ Residential Roofing Contractor" width="40" height="40" loading="lazy" style="display:block">',
  '      <span style="color:rgba(255,255,255,.8);font-size:.72rem;font-weight:700">GAF Certified™ Contractor<br><span style="color:rgba(255,255,255,.62);font-weight:600;font-size:.65rem">Verify on GAF.com →</span></span>',
  '    </a>',
  '    <a href="https://www.tamko.com/locate-a-contractor" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 12px;text-decoration:none;line-height:1.2">',
  '      <img src="/assets/tamko/tamko-pro-gold-badge-120.png" alt="TAMKO Pro Gold™ Certified Roofing Contractor badge" width="36" height="40" loading="lazy" style="display:block;height:40px;width:auto">',
  '      <span style="color:rgba(255,255,255,.8);font-size:.72rem;font-weight:700">TAMKO Pro Gold™ Certified<br><span style="color:rgba(255,255,255,.62);font-weight:600;font-size:.65rem">Verify on TAMKO.com →</span></span>',
  '    </a>',
  '    <p style="font-size:.62rem;color:rgba(255,255,255,.62);line-height:1.6;flex:1;min-width:280px"><span data-nosnippet>Independent Contractor. Not an employee or agent of GAF Materials LLC or TAMKO Building Products LLC. Contractors enrolled in GAF or TAMKO certification programs are not employees or agents of those manufacturers, and neither controls or otherwise supervises these independent businesses. GAF® and GAF Certified™ are either registered trademarks or trademarks of BMIC LLC in the United States and/or other countries. GAF ID 1162011. TAMKO®, TAMKO Pro™, ProShield® and HailGuard™ are trademarks or registered trademarks of TAMKO Building Products LLC. TAMKO Pro ID 181382.</span></p>',
  '  </div>',
].join('\n');

// Superseded short trademark-only line on the 25 roof-replacement city
// pages (byte-uniform; verified before this sweep).
const SHORT_DISCLAIMER =
  '<p style="font-size:.6rem;color:rgba(255,255,255,.5);line-height:1.6;max-width:1100px;margin:0 auto 12px">Independent Contractor &mdash; not an employee or agent of GAF Materials LLC or TAMKO Building Products LLC. GAF&reg; and GAF Certified&trade; are trademarks of BMIC LLC. TAMKO&reg;, TAMKO Pro&trade;, and ProShield&reg; are trademarks or registered trademarks of TAMKO Building Products LLC.</p>';

function targets() {
  const out = [];
  for (const name of fs.readdirSync(path.join(DOCS, 'services'))) {
    if (/^[a-z0-9-]+-(oh|ky)\.html$/.test(name)) out.push(path.join(DOCS, 'services', name));
  }
  for (const name of fs.readdirSync(path.join(DOCS, 'areas'))) {
    if (name.endsWith('.html') && name !== 'index.html') out.push(path.join(DOCS, 'areas', name));
  }
  return out;
}

const stats = { scanned: 0, injected: 0, shortLineRemoved: 0, skippedAlready: 0, noFooter: 0 };
const problems = [];

for (const file of targets()) {
  stats.scanned++;
  const relName = path.relative(DOCS, file).replace(/\\/g, '/');
  let html = fs.readFileSync(file, 'utf8');

  if (html.includes(MARKER) || html.includes('GAF ID 1162011')) {
    stats.skippedAlready++;
    continue;
  }

  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const block = CERT_BAR.split('\n').join(eol);

  // 1. Drop the superseded short trademark line (full disclaimer replaces it).
  const shortIdx = html.indexOf(SHORT_DISCLAIMER);
  if (shortIdx >= 0) {
    // Also swallow the leading indent + trailing EOL so no blank line is left.
    const lineStart = html.lastIndexOf(eol, shortIdx);
    const lineEnd = shortIdx + SHORT_DISCLAIMER.length;
    const after = html.slice(lineEnd, lineEnd + eol.length) === eol ? lineEnd + eol.length : lineEnd;
    html = html.slice(0, lineStart >= 0 ? lineStart + eol.length : shortIdx) + html.slice(after);
    stats.shortLineRemoved++;
  }

  // 2. Insert the cert bar as the first child of <footer>.
  const anchor = '<footer>' + eol;
  const i = html.indexOf(anchor);
  if (i < 0) {
    stats.noFooter++;
    problems.push(relName + ' — no <footer> anchor found, untouched');
    continue;
  }
  const at = i + anchor.length;
  html = html.slice(0, at) + block + eol + html.slice(at);
  fs.writeFileSync(file, html, 'utf8');
  stats.injected++;
}

console.log('add-footer-cert-bar sweep');
console.log('  scanned:            ' + stats.scanned);
console.log('  cert bar injected:  ' + stats.injected);
console.log('  short line removed: ' + stats.shortLineRemoved);
console.log('  already had bar:    ' + stats.skippedAlready);
console.log('  no footer anchor:   ' + stats.noFooter);
if (problems.length) {
  console.log('\nPROBLEMS:');
  problems.forEach((p) => console.log('  - ' + p));
  process.exit(1);
}
