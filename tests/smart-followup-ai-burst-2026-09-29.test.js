/**
 * tests/smart-followup-ai-burst-2026-09-29.test.js
 *
 * The rate-limit alarm (claudeProxy:uid, 2026-09-29) was Jo's own phone:
 * the morning briefing and Ask Joe's proactive slice both enriched the same
 * top 5 leads through SmartFollowup.enrichSuggestionAI on every render, with
 * no in-flight de-dupe, no concurrency cap, and a cache wiped on every data
 * refresh — ~10 simultaneous Claude calls per open. This drives the REAL
 * smart-followup.js in a vm with a fake window.callClaude that records how
 * many calls are in flight at once.
 *
 * Run: node tests/smart-followup-ai-burst-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

function load(sessionSeed) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/smart-followup.js'), 'utf8');
  const store = {};
  const sess = Object.assign({}, sessionSeed || {});
  const listeners = {};
  const win = {
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); }, removeEventListener() {},
    dispatch(t) { (listeners[t] || []).forEach((fn) => fn()); },
    location: { pathname: '/pro/dashboard' },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  };
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {}, remove() {} }, dataset: {} });
  const sandbox = {
    window: win,
    sessionStorage: { getItem: (k) => (k in sess ? sess[k] : null), setItem: (k, v) => { sess[k] = String(v); }, removeItem: (k) => { delete sess[k]; } },
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement() { return noop(); }, body: noop(), readyState: 'complete' },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON, Promise,
  };
  vm.runInNewContext(src, sandbox, { filename: 'smart-followup.js' });
  return { win, sess };
}

const now = Date.now();
const leads = [1, 2, 3, 4, 5].map((i) => ({ id: 'L' + i, stage: 'quoted', phone: '555010' + i, email: 'x' + i + '@example.com', name: 'ZZ_QA ' + i }));
const estimates = leads.map((l) => ({ leadId: l.id, respondedAt: now - 3600e3 }));
const tick = () => new Promise((r) => setTimeout(r, 5));

function fakeClaude(win, opts) {
  const o = opts || {};
  const stats = { calls: 0, inFlight: 0, maxInFlight: 0 };
  win.callClaude = async () => {
    stats.calls++; stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    await new Promise((r) => setTimeout(r, 15));
    stats.inFlight--;
    if (o.fail429) throw new Error('Rate limit exceeded');
    return { content: [{ text: JSON.stringify({ headline: 'AI headline', reasoning: 'AI why', draft: 'AI draft' }) }] };
  };
  return stats;
}

(async () => {
  console.log('\n1. the burst that fired the alarm');
  {
    const { win } = load();
    win._estimates = estimates;
    const SF = win.SmartFollowup;
    const stats = fakeClaude(win);
    // The briefing and Ask Joe both enrich the same top 5 at the same moment.
    const all = await Promise.all(leads.concat(leads).map((l) => SF.enrichSuggestionAI(l)));
    ok('10 requests for 5 leads → 5 Claude calls (the second asker shares the first)', stats.calls === 5, 'calls=' + stats.calls);
    ok('never more than 2 in flight at once', stats.maxInFlight <= 2, 'max=' + stats.maxInFlight);
    ok('every caller still gets the AI-enriched result', all.every((r) => r && r._aiEnriched === true && r.headline === 'AI headline'));

    win.dispatch('nbd:data-refreshed');
    await Promise.all(leads.map((l) => SF.enrichSuggestionAI(l)));
    ok('a data refresh that changed nothing for these leads → no new calls', stats.calls === 5, 'calls=' + stats.calls);

    const changed = Object.assign({}, leads[0], { stage: 'inspected' });
    win._estimates = estimates.filter((e) => e.leadId !== 'L1');
    const r = await SF.enrichSuggestionAI(changed);
    ok('a lead whose signals changed gets a fresh AI take', stats.calls === 6 && r._aiEnriched === true, 'calls=' + stats.calls);
  }

  console.log('\n2. rate limited → back off, fall back to the heuristic');
  {
    const { win } = load();
    win._estimates = estimates;
    const SF = win.SmartFollowup;
    const stats = fakeClaude(win, { fail429: true });
    const first = await SF.enrichSuggestionAI(leads[0]);
    ok('a 429 returns the heuristic suggestion (the UI never breaks)', first && !first._aiEnriched && typeof first.headline === 'string');
    const before = stats.calls;
    const rest = await Promise.all(leads.slice(1).map((l) => SF.enrichSuggestionAI(l)));
    ok('for the next minute no further calls are made', stats.calls === before, 'calls ' + before + ' → ' + stats.calls);
    ok('...and every lead still shows its heuristic', rest.every((x) => x && !x._aiEnriched));
  }

  console.log('\n3. the cache survives a reload (same browser session)');
  {
    const a = load();
    a.win._estimates = estimates;
    const s1 = fakeClaude(a.win);
    await Promise.all(leads.map((l) => a.win.SmartFollowup.enrichSuggestionAI(l)));
    const saved = Object.assign({}, a.sess);
    const b = load(saved);
    b.win._estimates = estimates;
    const s2 = fakeClaude(b.win);
    const again = await Promise.all(leads.map((l) => b.win.SmartFollowup.enrichSuggestionAI(l)));
    ok('reopening the app reuses the session cache — zero calls', s1.calls === 5 && s2.calls === 0 && again.every((r) => r._aiEnriched), 's2=' + s2.calls);
  }

  console.log('\n4. no-action states never call Claude');
  {
    const { win } = load();
    const stats = fakeClaude(win);
    await win.SmartFollowup.enrichSuggestionAI({ id: 'Z', stage: 'closed' });
    ok('a closed lead (wait) costs nothing', stats.calls === 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
