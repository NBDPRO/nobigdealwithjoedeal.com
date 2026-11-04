// CRM boot built an Intl.DateTimeFormat per owed invoice (ky-insurance-law toUtcDay)
// and a toLocaleDateString per estimate lead (estimate-followups isSnoozed).
// Construction is milliseconds each; the formatters are now cached.
const fs = require('fs'), path = require('path');
const real = Intl.DateTimeFormat;
let built = 0;
Intl.DateTimeFormat = function (...a) { built++; return new real(...a); };
Intl.DateTimeFormat.prototype = real.prototype;
let fail = 0;
function ok(c, m) { if (!c) { fail++; console.log('FAIL', m); } }

const K = require('../docs/pro/js/ky-insurance-law.js');
for (let i = 0; i < 300; i++) K.toUtcDay(1790000000000 + i * 3600000);
ok(built <= 3, 'toUtcDay: 300 calls build at most 3 formatters (built ' + built + ')');
built = 0;
for (let i = 0; i < 300; i++) K.todayIn('Europe/London');
ok(built <= 3, 'todayIn with another zone: cached too (built ' + built + ')');
// same answers as before
ok(K.toUtcDay(Date.UTC(2026, 8, 28, 2, 30)) === Date.UTC(2026, 8, 27), 'an instant is the New York date, not the UTC date');
ok(K.toUtcDay('2026-09-27') === Date.UTC(2026, 8, 27), 'a bare date is taken as written');
ok(K.todayIn('not/a-zone') === K.todayIn('America/New_York'), 'an invalid zone falls back to New York');

const src = fs.readFileSync(path.join(__dirname, '../docs/pro/js/estimate-followups.js'), 'utf8');
ok(!/toLocaleDateString\('en-CA', \{ timeZone: 'America\/New_York' \}\)/.test(src), 'isSnoozed no longer builds a formatter per row');
ok(/new Intl\.DateTimeFormat\('en-CA', \{ timeZone: 'America\/New_York' \}\)/.test(src), 'a shared en-CA New York formatter exists');
ok(fs.readFileSync(path.join(__dirname, '../docs/pro/js/ky-insurance-law.js'), 'utf8') === fs.readFileSync(path.join(__dirname, '../functions/ky-insurance-law.js'), 'utf8'), 'client and server copies of ky-insurance-law stay identical');
Intl.DateTimeFormat = real;
if (fail) process.exit(1);
console.log('ok: intl formatter cache');
