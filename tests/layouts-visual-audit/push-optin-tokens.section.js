/* Global chrome: the "Turn on appointment reminders" card (push-registration.js) floats
 * over every layout. It read --nbd-surface/-text/-border/-muted/-accent, which no
 * stylesheet defines, so it was always a white card in dark themes with white text on
 * the OLD orange #e8511f (3.7:1). It must use the live tokens (--s --t --rule --m --orange). */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
module.exports = {
  name: 'Global chrome: the push opt-in card uses defined theme tokens',
  async run({ ok }) {
    const js = fs.readFileSync(path.join(ROOT, 'docs/pro/js/push-registration.js'), 'utf8');
    const css = fs.readdirSync(path.join(ROOT, 'docs/pro/css')).filter((f) => /.css$/.test(f)).map((f) => fs.readFileSync(path.join(ROOT, 'docs/pro/css', f), 'utf8')).join('\n');
    const used = [...new Set([...js.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
    ok('push-registration.js reads at least one theme token', used.length > 0);
    const undef = used.filter((v) => !new RegExp(v + '\s*:').test(css));
    ok('every var(--x) the card uses is defined in a stylesheet', undef.length === 0, undef.join(', '));
    ok('the card carries no old-orange #e8511f', !/e8511f/i.test(js));
  },
};
