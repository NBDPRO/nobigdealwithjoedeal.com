// A stylesheet linked twice (two ?v= values) is fetched twice for nothing.
// Guards the CRM pages against the pattern; fonts.googleapis excluded.
const fs = require('fs'), path = require('path');
let fail = 0;
for (const f of ['docs/pro/dashboard.html', 'docs/pro/customer.html']) {
  const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const seen = {};
  for (const m of t.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/g)) {
    const h = (m[0].match(/href=["']([^"']+)["']/) || [])[1];
    if (!h || /^https?:/.test(h)) continue;
    const k = h.split('?')[0];
    if (seen[k]) { fail++; console.log('FAIL', f, 'links', k, 'twice'); }
    seen[k] = 1;
  }
}
if (fail) process.exit(1);
console.log('ok: no duplicate local stylesheet links');
