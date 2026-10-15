/**
 * tests/public-form-fixes-2026-10-15.test.js — public form fixes from the
 * 2026-10-14 site code review (nbd-agents/reports/site-code-review-2026-10-14.md).
 *
 *   H2  generate_lead fires once per lead, not on /estimate's follow-up saves
 *   M5  the gateway POST has a client timeout, so "Sending…" ends and the
 *       call/text fallback shows
 *
 * The gateway client (docs/assets/js/public-lead-submit.js) is EXECUTED in a
 * vm sandbox with a fake fetch, gtag and timers.
 *
 * Zero deps. Run: node tests/public-form-fixes-2026-10-15.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

const CLIENT_REL = 'docs/assets/js/public-lead-submit.js';
const client = read(CLIENT_REL);

// fetchMode: 'ok' answers 200; 'stall' never answers until the signal aborts.
function loadClient({ fetchMode = 'ok' } = {}) {
  const events = [];
  const timers = new Map(); let seq = 0;
  const document = {
    head: { appendChild() {} }, body: { appendChild() {} },
    activeElement: null,
    addEventListener() {},
    createElement() { return { style: {}, dataset: {}, setAttribute() {}, appendChild() {} }; },
    createTextNode() { return {}; },
    querySelector() { return null; },
  };
  const window = {
    document,
    location: { pathname: '/estimate', hostname: 'nobigdealwithjoedeal.com' },
    AbortController,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    gtag(type, name, params) { events.push({ type, name, params }); },
    fetch(url, init) {
      if (fetchMode === 'stall') {
        return new Promise((resolve, reject) => {
          if (init.signal) init.signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted.'); e.name = 'AbortError'; reject(e);
          });
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'lead-1' }) });
    },
    console,
  };
  window.window = window;
  vm.createContext(window);
  vm.runInContext(client, window, { filename: CLIENT_REL });
  // No Turnstile key/widget on this fake page → the token step resolves ''.
  window.__NBD_TURNSTILE_SITEKEY = '';
  return { window, events, timers };
}
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  console.log('\nH2 — generate_lead once per lead');
  {
    const { window, events } = loadClient();
    const r1 = await window.submitPublicLead('estimate', { firstName: 'Pat', phone: '8595550100', source: 'estimate-funnel-v2' });
    ok('the lead save succeeds', r1.ok === true, r1);
    for (const type of ['estimate_result', 'cta_click', 'email_estimate_request']) {
      const r = await window.submitPublicLead('estimate', { type, source: 'estimate-funnel-v2' });
      ok(`follow-up save "${type}" still succeeds`, r.ok === true, r);
    }
    const leads = events.filter((e) => e.name === 'generate_lead');
    ok('generate_lead fired exactly once across the lead + 3 follow-up saves', leads.length === 1, leads.length);
    ok('…for the lead itself (kind estimate)', leads[0] && leads[0].params.lead_kind === 'estimate');
  }
  {
    const { window, events } = loadClient();
    await window.submitPublicLead('inspect', { name: 'Pat', phone: '8595550100', source: '/inspect' });
    ok('a normal /inspect lead still fires generate_lead', events.filter((e) => e.name === 'generate_lead').length === 1);
  }

  console.log('\nM5 — the gateway POST times out');
  {
    const { window, timers, events } = loadClient({ fetchMode: 'stall' });
    const p = window.submitPublicLead('inspect', { name: 'Pat', phone: '8595550100' });
    let settled = null; p.then((r) => { settled = r; });
    for (let i = 0; i < 5; i++) await tick();
    ok('a stalled POST has not settled yet', settled === null);
    const abortTimer = [...timers.entries()].find(([, t]) => t.ms >= 15000 && t.ms <= 30000);
    ok('a 15–30 s abort timer is armed for the POST', !!abortTimer, [...timers.values()].map((t) => t.ms));
    if (abortTimer) { timers.delete(abortTimer[0]); abortTimer[1].fn(); }
    for (let i = 0; i < 5; i++) await tick();
    ok('after the timeout the submit resolves ok:false (so the form can recover)', settled && settled.ok === false, settled);
    ok('…flagged timedOut with a plain-language reason', settled && settled.timedOut === true && /taking too long/i.test(settled.reason) && !/abort/i.test(settled.reason), settled);
    ok('…and no generate_lead fired', events.filter((e) => e.name === 'generate_lead').length === 0);
  }
  {
    const { window, timers } = loadClient();
    await window.submitPublicLead('inspect', { name: 'Pat', phone: '8595550100' });
    ok('a successful POST clears its abort timer', ![...timers.values()].some((t) => t.ms >= 15000 && t.ms <= 30000), [...timers.values()].map((t) => t.ms));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
