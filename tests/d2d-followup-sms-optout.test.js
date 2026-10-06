/**
 * tests/d2d-followup-sms-optout.test.js — the D2D knock follow-up text must
 * never reopen the device Messages app after NBDComms REFUSED the send.
 *
 * The bug this pins (fail-open audit FO-1, d2d-tracker-core-2026b.js
 * sendFollowUpSMS):
 *
 *   NBDComms.sendSMS returns success:false for exactly one class of outcome:
 *   a hard refusal — 403 (recipient opted out by replying STOP, or sender not
 *   allowed) and 401 (not signed in). nbd-comms.js deliberately does NOT hand
 *   off on those ("Opt-out / forbidden: do not open device Messages (would
 *   still text)"). Every softer failure (402 paid-gate, A2P, 429, network) is
 *   already handed off BY NBDComms, which then returns success:true,
 *   mode:'sms'.
 *
 *   sendFollowUpSMS treated every success:false as "platform unavailable" and
 *   ran window.open('sms:<phone>?body=<text>') plus an 'Opening SMS...' toast
 *   — so the branch ran ONLY on the refusals, and a homeowner who texted STOP
 *   was one tap away from receiving the follow-up anyway (TCPA opt-out
 *   bypass), with nothing written to sms_log.
 *
 * This suite RUNS the real d2d-tracker-core-2026b.js in a vm against a stub
 * window and drives window._D2DState.sendFollowUpSMS with each NBDComms
 * outcome, rather than grepping for the branch, so a refactor that keeps the
 * text but reopens the path still fails.
 *
 * Zero deps.  Run: node tests/d2d-followup-sms-optout.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/d2d-tracker-core-2026b.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// A promise the module never catches surfaces here instead of crashing the
// process, so "no .catch()" is an assertable failure rather than a flake.
const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

function flush() { return new Promise((r) => setImmediate(r)); }

// ── Sandbox: just wide enough for the module body to run at load ──────────
function load(nbdComms) {
  const opened = [];
  const toasts = [];
  const smsCalls = [];
  const el = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {}, removeChild() {},
    addEventListener() {}, removeEventListener() {}, querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const win = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
    Map, Set, WeakMap, encodeURIComponent, decodeURIComponent, isNaN, parseFloat, parseInt,
    document: {
      addEventListener() {}, removeEventListener() {},
      getElementById() { return null; }, querySelector() { return null; },
      querySelectorAll() { return []; }, createElement: el,
      body: el(), documentElement: el(), head: el(),
    },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: {},
    location: { href: '', origin: 'https://example.test', search: '', hash: '' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    showToast: (msg, kind) => { toasts.push([kind, String(msg)]); },
    open: (url, target) => { opened.push([String(url), target]); return null; },
    _user: { uid: 'rep1', displayName: 'Rep One' },
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  if (nbdComms) {
    win.NBDComms = {
      sendSMS: (...args) => { smsCalls.push(args); return nbdComms(...args); },
    };
  }
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'd2d-tracker-core-2026b.js' });
  return { win, opened, toasts, smsCalls, send: win._D2DState && win._D2DState.sendFollowUpSMS };
}

const KNOCK = {
  id: 'knock-42', phone: '(513) 555-0123', homeowner: 'Dana',
  address: '12 Oak St', disposition: 'interested',
  // 2026-10-05: door-knock texts need the homeowner's OK on file.
  smsConsent: true,
};

const smsOpens = (h) => h.opened.filter(([u]) => /^sms:/i.test(u));
const openingToast = (h) => h.toasts.some(([, m]) => /opening sms/i.test(m));
const sentToast = (h) => h.toasts.some(([, m]) => /text sent to/i.test(m));

(async () => {
  console.log('D2D FOLLOW-UP SMS — no Messages handoff after an NBDComms refusal');

  {
    const h = load(async () => ({ success: true, mode: 'platform', sid: 'SM1' }));
    ok('the real module loads and publishes sendFollowUpSMS on _D2DState',
      typeof h.send === 'function', typeof h.send);
    if (typeof h.send !== 'function') {
      console.log('\n' + passed + ' passed, ' + (failed) + ' failed');
      process.exit(1);
    }
  }

  // ── 1. 403 opt-out refusal: THE bug ────────────────────────────────────
  {
    const h = load(async () => ({ success: false, mode: 'platform', error: 'This recipient has opted out of SMS (replied STOP).' }));
    h.send(KNOCK, 'interested');
    await flush(); await flush();
    ok('403 opt-out: NBDComms.sendSMS was still the path taken',
      h.smsCalls.length === 1 && h.smsCalls[0][0] === KNOCK.phone && h.smsCalls[0][2] === KNOCK.id,
      JSON.stringify(h.smsCalls));
    ok('403 opt-out: NO sms: handoff is opened (would text a number that replied STOP)',
      smsOpens(h).length === 0, JSON.stringify(h.opened));
    ok('403 opt-out: NO "Opening SMS..." toast',
      !openingToast(h), JSON.stringify(h.toasts));
    ok('403 opt-out: NO "Text sent" toast either',
      !sentToast(h), JSON.stringify(h.toasts));
  }

  // ── 2. 401 refusal: same contract ───────────────────────────────────────
  {
    const h = load(async () => ({ success: false, mode: 'platform', error: 'not-authenticated' }));
    h.send(KNOCK, 'follow_up');
    await flush(); await flush();
    ok('401: NO sms: handoff is opened', smsOpens(h).length === 0, JSON.stringify(h.opened));
    ok('401: NO "Opening SMS..." toast', !openingToast(h), JSON.stringify(h.toasts));
  }

  // ── 3. Any other success:false shape also stays closed ─────────────────
  // (e.g. no-body / no-recipient validation, or a future refusal code).
  // success:false means "NBDComms did not send and did not hand off" — the
  // caller must not second-guess that into a handoff.
  {
    const h = load(async () => ({ success: false, mode: 'sms', error: 'no-body' }));
    h.send(KNOCK, 'follow_up');
    await flush(); await flush();
    ok('success:false with mode "sms": still NO handoff from D2D',
      smsOpens(h).length === 0 && !openingToast(h), JSON.stringify({ o: h.opened, t: h.toasts }));
  }

  // ── 4. NBDComms already handed off itself → D2D must not double-open ────
  {
    const h = load(async () => ({ success: true, mode: 'sms' }));
    h.send(KNOCK, 'interested');
    await flush(); await flush();
    ok('mode "sms" (NBDComms opened Messages itself): D2D opens nothing more',
      smsOpens(h).length === 0, JSON.stringify(h.opened));
    ok('mode "sms": no "Text sent to …" toast — nothing was sent yet, only a composer opened',
      !sentToast(h), JSON.stringify(h.toasts));
  }

  // ── 5. Real platform send: confirmation toast, nothing opened ───────────
  {
    const h = load(async () => ({ success: true, mode: 'platform', sid: 'SM2' }));
    h.send(KNOCK, 'interested');
    await flush(); await flush();
    ok('mode "platform": "Text sent to Dana" toast',
      h.toasts.some(([, m]) => m === 'Text sent to Dana'), JSON.stringify(h.toasts));
    ok('mode "platform": no sms: handoff', smsOpens(h).length === 0, JSON.stringify(h.opened));
  }

  // ── 6. NBDComms throws (e.g. getIdToken rejects) → fail closed, handled ─
  {
    const before = unhandled.length;
    const h = load(async () => { throw new Error('getIdToken failed'); });
    h.send(KNOCK, 'interested');
    await flush(); await flush(); await flush();
    ok('rejection: NO sms: handoff (opt-out status unknown)',
      smsOpens(h).length === 0, JSON.stringify(h.opened));
    ok('rejection: the rep is told it failed',
      h.toasts.some(([k, m]) => k === 'error' && /could not send text/i.test(m)), JSON.stringify(h.toasts));
    ok('rejection: handled — no unhandled promise rejection escapes',
      unhandled.length === before, String(unhandled.slice(before)));
  }

  // ── 7. NBDComms absent entirely → the bare sms: path is KEPT ────────────
  // No platform means no opt-out register to consult; the composer is the
  // only way to text at all, and this module never had anything better.
  {
    const h = load(null);
    h.send(KNOCK, 'interested');
    await flush();
    const opens = smsOpens(h);
    ok('NBDComms absent: exactly one sms: handoff to the cleaned number',
      opens.length === 1 && /^sms:5135550123\?body=/.test(opens[0][0]), JSON.stringify(h.opened));
    ok('NBDComms absent: body is the filled template',
      opens.length === 1 && /Dana/.test(decodeURIComponent(opens[0][0].split('?body=')[1] || '')),
      opens.length ? opens[0][0] : '(none)');
    ok('NBDComms absent: "Opening SMS..." toast', openingToast(h), JSON.stringify(h.toasts));
  }

  // ── 8. No phone → nothing at all ────────────────────────────────────────
  {
    const h = load(async () => ({ success: true, mode: 'platform' }));
    h.send(Object.assign({}, KNOCK, { phone: '' }), 'interested');
    await flush();
    ok('no phone: NBDComms not called, nothing opened',
      h.smsCalls.length === 0 && h.opened.length === 0, JSON.stringify({ c: h.smsCalls, o: h.opened }));
  }

  // ── 9. No texting OK on file → nothing at all (texting review 2026-10-05) ─
  for (const consent of [undefined, false, 'true', 1]) {
    const h = load(async () => ({ success: true, mode: 'platform' }));
    h.send(Object.assign({}, KNOCK, { smsConsent: consent }), 'interested');
    await flush();
    ok('smsConsent ' + JSON.stringify(consent) + ': NBDComms not called, nothing opened, the rep is told why',
      h.smsCalls.length === 0 && h.opened.length === 0
      && h.toasts.some(([k, m]) => k === 'error' && /No texting OK on file/.test(m)),
      JSON.stringify({ c: h.smsCalls, o: h.opened, t: h.toasts }));
  }

  // ── 10. Every template names the company and says how to stop ─────────
  {
    const h = load(async () => ({ success: true, mode: 'platform' }));
    for (const key of ['interested', 'appointment', 'storm_damage', 'ins_has_claim', 'follow_up', 'not_home']) {
      h.send(KNOCK, key);
    }
    await flush(); await flush();
    const bodies = h.smsCalls.map((c) => String(c[1] || ''));
    ok('all six door-knock templates end "Reply STOP to opt out." and name the company',
      bodies.length === 6 && bodies.every((b) => /Reply STOP to opt out\.$/.test(b) && /NBD Home Solutions/.test(b)),
      JSON.stringify(bodies));
  }

  console.log('\n──────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})();
