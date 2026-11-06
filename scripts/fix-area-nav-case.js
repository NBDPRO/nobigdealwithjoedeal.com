#!/usr/bin/env node
/**
 * fix-area-nav-case.js — the 45 /areas/<town> pages carried their own inline
 * `.nav-links a{...}` rule WITHOUT text-transform, so their desktop header read
 * "Services  About Joe  Reviews" while every other page type reads
 * "SERVICES  ABOUT JOE  REVIEWS" (found 2026-11-06 reading 1440px screenshots).
 * This adds `text-transform:uppercase` to that rule on those pages.
 *
 * Usage: node scripts/fix-area-nav-case.js           # dry run (counts)
 *        node scripts/fix-area-nav-case.js --apply   # write
 *        node scripts/fix-area-nav-case.js --check   # exit 1 if any page still lacks it
 * Preserves each file's EOL; idempotent.
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'areas');
const OLD = '.nav-links a{color:rgba(255,255,255,.85);text-decoration:none;font-size:.82rem;font-weight:600;transition:color .2s}';
const NEW = '.nav-links a{color:rgba(255,255,255,.85);text-decoration:none;font-size:.82rem;font-weight:600;text-transform:uppercase;transition:color .2s}';
const apply = process.argv.includes('--apply');
const check = process.argv.includes('--check');
let todo = 0, done = 0, other = 0;
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.html'))) {
  const p = path.join(DIR, f);
  const s = fs.readFileSync(p, 'utf8');
  const n = s.split(OLD).length - 1;
  if (n === 1) {
    todo++;
    if (apply) {
      const out = s.replace(OLD, () => NEW);
      if (/\r(?!\n)/.test(out)) throw new Error('lone CR in ' + f);
      fs.writeFileSync(p, out);
    }
  } else if (s.includes(NEW)) done++;
  else if (n > 1) throw new Error(f + ': rule appears ' + n + 'x');
  else other++; // index.html etc. already uppercase through another rule
}
console.log(`fix-area-nav-case: ${todo} to change${apply ? ' (written)' : ''}, ${done} already done, ${other} untouched`);
if (check && todo) process.exit(1);
