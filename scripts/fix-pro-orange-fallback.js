#!/usr/bin/env node
/**
 * scripts/fix-pro-orange-fallback.js — retire the old orange (#e8720c) used as the
 * FALLBACK literal inside `var(--orange, #e8720c)` in docs/pro CSS/JS. The token
 * still wins at runtime; the fallback only paints where theme-system.css has not
 * loaded, and it must be the current brand orange (#BD5728), never a retired hex.
 *
 *   node scripts/fix-pro-orange-fallback.js            # dry run: list files + counts
 *   node scripts/fix-pro-orange-fallback.js --apply    # write (EOL of each file preserved)
 *   node scripts/fix-pro-orange-fallback.js --check    # exit 1 if any var(--orange, #e8720c) remains
 *
 * Only touches the fallback slot of var(--orange, ...) under docs/pro/{css,js}.
 * Comments, tests, docs/sites (B2B / other tenants) and codemod history are left alone.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const RE = /(var\(\s*--orange\s*,\s*)#e8720c/gi;
const apply = process.argv.includes('--apply');
const check = process.argv.includes('--check');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(css|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

let total = 0; const hits = [];
for (const sub of ['css', 'js']) {
  for (const f of walk(path.join(ROOT, 'docs', 'pro', sub), [])) {
    const buf = fs.readFileSync(f);
    const src = buf.toString('utf8');
    const n = (src.match(RE) || []).length;
    if (!n) continue;
    total += n; hits.push([path.relative(ROOT, f), n]);
    if (apply) fs.writeFileSync(f, Buffer.from(src.replace(RE, '$1#BD5728'), 'utf8')); // same-length swap: EOLs untouched
  }
}
if (check) {
  if (total) { console.error('fix-pro-orange-fallback: ' + total + ' stale var(--orange, #e8720c) fallback(s) in ' + hits.length + ' file(s)'); hits.forEach(([f, n]) => console.error('  ' + n + '  ' + f)); process.exit(1); }
  console.log('fix-pro-orange-fallback: clean'); process.exit(0);
}
hits.forEach(([f, n]) => console.log((apply ? 'fixed ' : 'would fix ') + n + '  ' + f));
console.log((apply ? 'fixed ' : 'would fix ') + total + ' fallback(s) in ' + hits.length + ' file(s)');
