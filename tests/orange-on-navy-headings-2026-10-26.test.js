// Service pages' .content-card h3 and .stat-num, and blog .callout h3, sit on
// navy. Brand orange (#BD5728) there is 2.8 to 3.5:1; they use the light tint
// with a fallback (some pages do not define --orange-light). Jo, 2026-10-26.
const fs = require('fs'), path = require('path');
const RULE = /(^|\n)\s*\.(?:content-card h3|stat-num|callout h3)\s*\{[^}]*\}/g;
let fail = 0, seen = 0;
for (const dir of ['docs/services', 'docs/blog']) {
  for (const n of fs.readdirSync(path.join(__dirname, '..', dir))) {
    if (!n.endsWith('.html')) continue;
    const t = fs.readFileSync(path.join(__dirname, '..', dir, n), 'utf8');
    for (const m of t.matchAll(RULE)) {
      seen++;
      if (/color:\s*var\(--orange\)/.test(m[0])) { fail++; console.log('FAIL', dir + '/' + n, m[0].trim().slice(0, 60)); }
      else if (/var\(--orange-light\)/.test(m[0]) && !/--orange-light\s*:/.test(t)) { fail++; console.log('FAIL (--orange-light used but not defined here)', dir + '/' + n); }
    }
  }
}
if (!seen) { console.log('FAIL: no rules found'); process.exit(1); }
if (fail) process.exit(1);
console.log('ok: ' + seen + ' rules use the light tint on navy');
