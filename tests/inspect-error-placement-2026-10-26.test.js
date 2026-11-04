// /inspect: a validation message must sit next to the first invalid field
// (it used to be appended at the form's far end, 900+ px below the focus).
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../docs/assets/js/inspect-form.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../docs/inspect.html'), 'utf8');
let fail = 0;
function ok(c, m) { if (!c) { fail++; console.log('FAIL', m); } }
ok(/function showError\(btn, msg, anchor\)/.test(src), 'showError takes an anchor');
ok(/insertBefore\(p, anchor\.nextSibling\)/.test(src), 'message inserted after the anchor field');
ok(/showError\(btn, invalidMessage\(bad\), bad\[0\]\)/.test(src), 'validation passes the first invalid field');
ok(/aria-describedby/.test(src), 'field points at the message');
ok(/inspect-form\.js\?v=8/.test(html), 'script cache-bust bumped');
if (fail) process.exit(1);
console.log('ok: inspect error placement');
