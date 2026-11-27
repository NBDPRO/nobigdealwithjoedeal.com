/**
 * tests/lead-submit-failure-signal-2026-11-25.test.js — a failed public lead
 * submit is visible in GA4.
 *
 * From 2026-10-13 to 2026-11-25 every submitPublicLead POST got 403
 * (TURNSTILE_REQUIRED=true with the secret still the `__unset__` stub) and GA
 * recorded nothing, because the client only fired generate_lead on success
 * (documentation/audit/WEB-LEADS-TURNSTILE-OUTAGE-2026-11-25.md).
 *
 * docs/assets/js/public-lead-submit.js now fires `lead_submit_failed` on every
 * failure path. The client is EXECUTED in a vm sandbox with a fake fetch, gtag
 * and timers; no source-text pins.
 *
 * Zero deps. Run: node tests/lead-submit-failure-signal-2026-11-25.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CLIENT_REL = 'docs/assets/js/public-lead-submit.js';
const client = fs.readFileSync(path.join(ROOT, CLIENT_REL), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

// mode: 'ok' → 200; 'http' → `status` with `body`; 'stall' → never answers
// until aborted; 'network' → fetch rejects (offline, blocked, DNS).
function loadClient({ mode = 'ok', status = 403, body = {}, gtag = true, gtagThrows = false } = {}) {
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
    location: { pathname: '/inspect', hostname: 'nobigdealwithjoedeal.com' },
    AbortController,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, init) {
      if (mode === 'stall') {
        return new Promise((resolve, reject) => {
          if (init.signal) init.signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted.'); e.name = 'AbortError'; reject(e);
          });
        });
      }
      if (mode === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      if (mode === 'http') return Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 'lead-1' }) });
    },
    console: { log() {}, warn() {}, error() {} },
  };
  if (gtag) window.gtag = (type, name, params) => { if (gtagThrows) throw new Error('gtag boom'); events.push({ type, name, params }); };
  window.window = window;
  vm.createContext(window);
  vm.runInContext(client, window, { filename: CLIENT_REL });
  window.__NBD_TURNSTILE_SITEKEY = ''; // no widget on the fake page → token ''
  return { window, events, timers };
}
const tick = () => new Promise((r) => setImmediate(r));
const failures = (events) => events.filter((e) => e.name === 'lead_submit_failed');

(async () => {
  console.log('\nHTTP failure (the 2026-10-13 outage shape)');
  {
    const { window, events } = loadClient({ mode: 'http', status: 403, body: { error: 'Verification failed', reason: 'turnstile-required' } });
    const r = await window.submitPublicLead('inspect', { name: 'Pat', phone: '8595550100', address: '1 Main St', source: '/inspect' });
    ok('the submit still resolves ok:false', r.ok === false && r.status === 403, r);
    const f = failures(events);
    ok('exactly one lead_submit_failed fired', f.length === 1, f.length);
    const p = (f[0] && f[0].params) || {};
    ok('…kind, page source, status and server reason are reported', p.lead_kind === 'inspect' && p.lead_source === '/inspect' && p.http_status === 403 && p.server_reason === 'turnstile-required' && p.failure === 'http', p);
    ok('…had_token is false when no token was sent', p.had_token === false, p);
    ok('…carries no PII (no name, phone or address in any param)', !/Pat|8595550100|Main St/.test(JSON.stringify(p)), p);
    ok('…and no generate_lead fired', events.filter((e) => e.name === 'generate_lead').length === 0);
  }
  {
    const { window, events } = loadClient({ mode: 'http', status: 500, body: {} });
    await window.submitPublicLead('contact', { source: 'homepage' });
    const p = (failures(events)[0] || {}).params || {};
    ok('a 500 with no reason reports http_status 500 and an empty reason', p.http_status === 500 && p.server_reason === '', p);
  }
  {
    const { window, events } = loadClient({ mode: 'http', status: 400, body: { error: 'Invalid submission' } });
    await window.submitPublicLead('estimate', { source: 'estimate-funnel-v2' }, { silent: true });
    ok('a silent background save that fails is counted too', failures(events).length === 1);
  }

  console.log('\nNever reached the server');
  {
    const { window, events } = loadClient({ mode: 'network' });
    const r = await window.submitPublicLead('storm', { source: 'storm-alerts-page' });
    ok('a rejected fetch resolves ok:false network:true', r.ok === false && r.network === true, r);
    const p = (failures(events)[0] || {}).params || {};
    ok('…and reports failure "network" with http_status 0', p.failure === 'network' && p.http_status === 0, p);
  }
  {
    const { window, timers, events } = loadClient({ mode: 'stall' });
    const pr = window.submitPublicLead('inspect', { source: '/storm-check' });
    for (let i = 0; i < 5; i++) await tick();
    const abortTimer = [...timers.entries()].find(([, t]) => t.ms >= 15000 && t.ms <= 30000);
    if (abortTimer) { timers.delete(abortTimer[0]); abortTimer[1].fn(); }
    const r = await pr;
    ok('a stalled POST times out ok:false', r.ok === false && r.timedOut === true, r);
    const p = (failures(events)[0] || {}).params || {};
    ok('…and reports failure "timeout"', p.failure === 'timeout' && p.lead_source === '/storm-check', p);
  }

  console.log('\nlead_submit — one attempt event per new lead (2026-11-26, form-funnel events)');
  {
    const { window, events } = loadClient({ mode: 'http', status: 403, body: { reason: 'turnstile-required' } });
    await window.submitPublicLead('inspect', { name: 'Pat', phone: '8595550100', address: '1 Main St', source: '/inspect' });
    const s = events.filter((e) => e.name === 'lead_submit');
    ok('a failed submit still counts as one attempt (lead_submit before lead_submit_failed)', s.length === 1 && events.indexOf(s[0]) < events.indexOf(failures(events)[0]), events.map((e) => e.name));
    ok('…with kind and page source only, no PII', s[0] && s[0].params.lead_kind === 'inspect' && s[0].params.lead_source === '/inspect' && !/Pat|8595550100|Main St/.test(JSON.stringify(s[0].params)), s[0]);
  }
  {
    const { window, events } = loadClient({ mode: 'ok' });
    await window.submitPublicLead('contact', { source: 'homepage' });
    ok('a saved lead sends lead_submit then generate_lead', events.map((e) => e.name).join(',') === 'lead_submit,generate_lead', events.map((e) => e.name));
  }
  {
    const { window, events } = loadClient({ mode: 'ok' });
    await window.submitPublicLead('estimate', { source: 'estimate-funnel-v2', type: 'estimate_result' });
    await window.submitPublicLead('estimate', { source: 'estimate-funnel-v2', leadToken: 'a'.repeat(48) });
    ok('follow-up saves and step-1 updates send no lead_submit (same rule as generate_lead)', events.filter((e) => e.name === 'lead_submit').length === 0, events.map((e) => e.name));
  }

  console.log('\nSuccess and robustness');
  {
    const { window, events } = loadClient({ mode: 'ok' });
    const r = await window.submitPublicLead('inspect', { source: '/inspect' });
    ok('a successful submit fires no lead_submit_failed', r.ok === true && failures(events).length === 0, events);
  }
  {
    const { window } = loadClient({ mode: 'http', status: 403, body: { reason: 'missing-token' }, gtag: false });
    const r = await window.submitPublicLead('inspect', { source: '/inspect' });
    ok('no gtag on the page: the failure path still returns normally', r.ok === false && r.status === 403, r);
  }
  {
    const { window } = loadClient({ mode: 'http', status: 403, body: {}, gtagThrows: true });
    const r = await window.submitPublicLead('inspect', { source: '/inspect' });
    ok('a throwing gtag never breaks the submit result', r.ok === false && r.status === 403, r);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
