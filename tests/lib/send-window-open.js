/**
 * tests/lib/send-window-open.js — functions/send-window.js with the customer
 * send window always OPEN, for the older suites that build their own stubbed
 * module graph (Module._load maps) and run sweeps at Date.now()-based
 * instants. With the real window those suites would pass or fail by the hour
 * CI happens to run them. Everything else is the real module.
 *
 * The window itself (and every deferral) is tested against the REAL module in
 * tests/send-window-2026-11-22.test.js.
 *
 * Usage in a stubs map: { './send-window': require('./lib/send-window-open') }
 */
'use strict';

const path = require('path');
const real = require(path.join(__dirname, '..', '..', 'functions', 'send-window.js'));

module.exports = Object.assign({}, real, {
  inWindow: () => true,
  check: (nowMs) => ({ ok: true, zones: [real.DEFAULT_TZ], basis: 'test', nextOpenMs: Number(nowMs) }),
});
