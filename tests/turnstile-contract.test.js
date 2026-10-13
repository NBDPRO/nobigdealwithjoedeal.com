#!/usr/bin/env node
/**
 * turnstile-contract.test.js
 *
 * The Turnstile client/server pair has a fail-closed landmine. The server
 * (functions/integrations/turnstile.js) rejects every tokenless submission the
 * moment TURNSTILE_SECRET is set (or TURNSTILE_REQUIRED=true). The client can
 * only mint a token on a page that has a site key — so any lead surface
 * without one is silently 403'd by "set the secret".
 *
 * History, because the old docblock here went stale and was believed:
 *   - 2026-08-07: written when the key stub (docs/assets/js/inline/7cd8e505ab.js)
 *     shipped EMPTY. The page list was hardcoded to the four stub pages.
 *   - 2026-09-06: the stub was populated with the real (public) site key.
 *   - 2026-09-09 audit: those four pages were 4 of 181 lead surfaces. Six more
 *     pages load public-lead-submit.js directly, 170 /areas + /services pages
 *     lazy-inject it through quick-lead-form.js, and sites/index.html reaches
 *     it through marketing-firebase.js. None were keyed; this test was green by
 *     construction because it only looked at the pages that were.
 *   - 2026-09-13: the key is hoisted into public-lead-submit.js as a default,
 *     and the page list below is DERIVED, never hardcoded.
 *
 * CI cannot see prod secrets, so this contract pins everything that keeps the
 * half-wired states impossible to ship silently:
 *   1. The stub and the client default both parse and hold the SAME key.
 *   2. Every page that can reach submitPublicLead is keyed — the stub loads
 *      before the client, or the client's default is the stub key — and no
 *      page overrides the key with a different value.
 *   3. No static .cf-turnstile widget pins a different key.
 *   4. Behaviour, in a vm sandbox with a fake window.turnstile: the key
 *      resolution rule, render-once then reset()+execute() so every submit
 *      gets a FRESH token, the safety timeout, and the no-key opt-out.
 *   5. The server keeps all three posture branches plus the bounded fetch.
 *   6. The deployment-order warning stays in the stub.
 *
 * Zero dependencies. Run: node tests/turnstile-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
let passed = 0, failed = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function rel(abs) { return path.relative(ROOT, abs).split(path.sep).join('/'); }
// Comments in this repo quote old code verbatim when explaining a fix, so any
// "does this file reference X" check runs on comment-stripped source.
function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

const STUB_REL = 'docs/assets/js/inline/7cd8e505ab.js';
const CLIENT_REL = 'docs/assets/js/public-lead-submit.js';
const stub = read(STUB_REL);
const client = read(CLIENT_REL);

// ── 1. Both copies of the key parse and agree ──
const keyMatch = stub.match(/window\.__NBD_TURNSTILE_SITEKEY\s*=\s*"([^"]*)"/);
ok('sitekey stub has a parseable window.__NBD_TURNSTILE_SITEKEY assignment', !!keyMatch);
const siteKey = keyMatch ? keyMatch[1].trim() : '';

const defaultMatch = client.match(/const DEFAULT_TURNSTILE_SITEKEY = '([^']*)';/);
ok('public-lead-submit.js declares a parseable DEFAULT_TURNSTILE_SITEKEY', !!defaultMatch);
const clientDefault = defaultMatch ? defaultMatch[1] : null;
ok('client DEFAULT_TURNSTILE_SITEKEY equals the stub key (no drift: "' +
   clientDefault + '" vs "' + siteKey + '")',
   clientDefault !== null && clientDefault === siteKey);

// ── 2. Every lead surface is keyed ──
const htmlFiles = [], jsFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(path.join(dir, entry.name));
      continue;
    }
    if (/\.html$/.test(entry.name)) htmlFiles.push(path.join(dir, entry.name));
    else if (/\.m?js$/.test(entry.name)) jsFiles.push(path.join(dir, entry.name));
  }
})(DOCS);

// Entry points that put submitPublicLead on a page. Anything else under docs/
// that loads one of them (by import or injected src — e.g.
// marketing-firebase-init.js imports marketing-firebase.js) is a loader too,
// discovered transitively so a new indirection cannot hide a surface.
const ENTRY_POINTS = ['public-lead-submit.js', 'quick-lead-form.js', 'marketing-firebase.js'];
const loaders = new Map(ENTRY_POINTS.map((b) => [b, b]));  // basename → entry point it reaches
for (let grew = true; grew;) {
  grew = false;
  for (const f of jsFiles) {
    const base = path.basename(f);
    if (loaders.has(base)) continue;
    const code = stripJsComments(fs.readFileSync(f, 'utf8'));
    for (const [lb, entry] of loaders) {
      if (new RegExp('[\'"`][^\'"`]*/' + lb.replace(/\./g, '\\.') + '[\'"`]').test(code)) {
        loaders.set(base, entry); grew = true; break;
      }
    }
  }
}

function scriptSrcs(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => ({ src: m[1], at: m.index }));
}
function keyAssignments(src) {
  return [...src.matchAll(/__NBD_TURNSTILE_SITEKEY\s*=\s*(["'])([^"']*)\1/g)].map((m) => m[2].trim());
}

const surfaces = [];
const perEntry = Object.fromEntries(ENTRY_POINTS.map((e) => [e, 0]));
for (const f of htmlFiles) {
  const html = fs.readFileSync(f, 'utf8');
  const srcs = scriptSrcs(html);
  const hits = srcs.filter((s) => loaders.has(path.basename(s.src.split('?')[0])));
  if (!hits.length) continue;
  const entries = new Set(hits.map((h) => loaders.get(path.basename(h.src.split('?')[0]))));
  for (const e of entries) perEntry[e]++;
  const clientAt = Math.min(...hits.map((h) => h.at));
  const stubHit = srcs.find((s) => /\/7cd8e505ab\.js$/.test(s.src.split('?')[0]));
  // Any key assignment the page carries (inline, or in a same-origin script it
  // loads) must be the stub key — an explicit '' is a deliberate opt-out and
  // would leave the surface tokenless under enforcement.
  const assigned = keyAssignments(html);
  for (const s of srcs) {
    if (!s.src.startsWith('/')) continue;
    const p = path.join(DOCS, s.src.split('?')[0]);
    if (fs.existsSync(p) && p !== path.join(ROOT, CLIENT_REL)) assigned.push(...keyAssignments(fs.readFileSync(p, 'utf8')));
  }
  surfaces.push({
    page: rel(f),
    stubFirst: !!stubHit && stubHit.at < clientAt,
    overrides: assigned.filter((v) => v !== siteKey),
  });
}

console.log('  · derived ' + surfaces.length + ' lead surfaces (' +
  ENTRY_POINTS.map((e) => e + ': ' + perEntry[e]).join(', ') + ')');
for (const e of ENTRY_POINTS) {
  ok('page walk finds at least one page reaching ' + e + ' (a rename must not blind this test)',
     perEntry[e] > 0);
}
ok('page walk finds a plausible number of lead surfaces (>= 100, got ' + surfaces.length + ')',
   surfaces.length >= 100);

const defaultKeys = clientDefault !== null && clientDefault !== '' && clientDefault === siteKey;
const unkeyed = surfaces.filter((s) => !(s.stubFirst || defaultKeys)).map((s) => s.page);
ok('every lead surface is keyed (stub before client, or client default === stub key)' +
   (unkeyed.length ? ' — unkeyed ' + unkeyed.length + ': ' + unkeyed.slice(0, 8).join(', ') +
     (unkeyed.length > 8 ? ', …' : '') : ''),
   unkeyed.length === 0);
const overriding = surfaces.filter((s) => s.overrides.length).map((s) => s.page + ' → "' + s.overrides[0] + '"');
ok('no lead surface overrides the site key with a different value' +
   (overriding.length ? ' — found: ' + overriding.join(', ') : ''),
   overriding.length === 0);

// ── 3. Static widget markup must not pin a different key ──
{
  const SKIP = /^docs\/(pro|admin|dev)\//;
  const widgetPages = htmlFiles.filter((f) => !SKIP.test(rel(f)) &&
    /class="[^"]*cf-turnstile\b/.test(fs.readFileSync(f, 'utf8')));
  if (siteKey === '') {
    ok('empty sitekey ⇒ no static .cf-turnstile widget on the served surface' +
       (widgetPages.length ? ' — found: ' + widgetPages.map(rel).join(', ') : ''),
       widgetPages.length === 0);
  } else {
    // Widgets are optional (the executor auto-creates an invisible one), but
    // any hand-placed widget must not pin a different key.
    const mismatched = widgetPages.filter((f) => {
      const m = fs.readFileSync(f, 'utf8').match(/class="[^"]*cf-turnstile[^"]*"[^>]*data-sitekey="([^"]*)"/);
      return m && m[1] && m[1] !== siteKey;
    });
    ok('populated sitekey ⇒ no widget pins a different data-sitekey' +
       (mismatched.length ? ' — found: ' + mismatched.map(rel).join(', ') : ''),
       mismatched.length === 0);
  }
}

// Client executor keeps the graceful no-key path and the auto-widget path.
ok('client skips the Turnstile script load when no key and no widget',
   /if \(!hasKey && !hasWidget\) return resolve\(false\);/.test(client));
ok('client auto-creates the invisible widget container when a key exists',
   /cf-turnstile-auto/.test(client) && /document\.createElement\('div'\)/.test(client));
ok('client only attaches turnstileToken when a token was obtained',
   /if \(turnstileToken\) payload\.turnstileToken = turnstileToken;/.test(client));

// Safety timeout: Jo's decision 2026-09-13, cut from 8s to 6s. It is the
// worst-case wait a visitor on a stalled network sits through before the lead
// is sent tokenless. 4s was tried first and rejected: it cut off 1 of 10
// always-pass test-key first submits (4,007ms, no token) on a fast connection.
// After enforcement a submit that hits the timeout is 403'd, so do not change
// this number without re-measuring (runbook:
// documentation/runbooks/TURNSTILE-SETUP.md) and updating this pin.
const DECIDED_TIMEOUT_MS = 6000;
const timeoutMatch = client.match(/const TURNSTILE_TIMEOUT_MS = (\d+);/);
ok('client declares TURNSTILE_TIMEOUT_MS = ' + DECIDED_TIMEOUT_MS + ' (got ' +
   (timeoutMatch ? timeoutMatch[1] : 'none') + ')',
   !!timeoutMatch && Number(timeoutMatch[1]) === DECIDED_TIMEOUT_MS);

// ── 4. Behaviour in a sandbox ──
// A fake Turnstile modelled on what real api.js did in Chromium on 2026-09-13
// (console warnings quoted): render() into a container that already holds a
// widget is REJECTED ("Turnstile has already been rendered in this container");
// execute() on a widget that already produced a token hands back THAT token
// ("execute() will return the previous token obtained. Consider using reset()");
// reset() clears it so the next execute() mints a fresh one.
function makeHarness(opts) {
  opts = opts || {};
  const log = [];
  const timers = new Map();
  let timerSeq = 0, tokenSeq = 0;
  const widgets = new Map();
  const containers = new Set();
  const flush = () => new Promise((r) => setImmediate(r));

  const turnstile = {
    render(el, cfg) {
      log.push(['render', cfg.sitekey]);
      if (containers.has(el)) return undefined;
      containers.add(el);
      const id = 'w' + (widgets.size + 1);
      widgets.set(id, { cfg, token: null });
      if (cfg.execution !== 'execute') this._run(id);
      return id;
    },
    reset(id) { log.push(['reset', id]); const w = widgets.get(id); if (w) w.token = null; },
    execute(id) {
      log.push(['execute', id]);
      const w = widgets.get(id);
      if (!w) return;
      if (w.token) { const t = w.token; Promise.resolve().then(() => w.cfg.callback(t)); return; }
      this._run(id);
    },
    _run(id) {
      const w = widgets.get(id);
      if (opts.challenge === 'never') return;
      Promise.resolve().then(() => {
        if (opts.challenge === 'error') return w.cfg['error-callback']();
        w.token = 'tok-' + (++tokenSeq);
        w.cfg.callback(w.token);
      });
    },
  };

  const posts = [];
  const body = { children: [], appendChild(n) { this.children.push(n); } };
  const head = { children: [], appendChild(n) {
    this.children.push(n);
    if (/challenges\.cloudflare\.com\/turnstile/.test(n.src || '')) {
      log.push(['load-script']);
      if (opts.script === 'stall') return;
      Promise.resolve().then(() => { window.turnstile = turnstile; n.onload && n.onload(); });
    }
  } };
  const document = {
    head, body,
    createElement(tag) { return { tagName: tag, style: {}, dataset: {}, className: '' }; },
    querySelector(sel) {
      return /cf-turnstile-auto/.test(sel) ? (body.children.find((c) => c.className === 'cf-turnstile-auto') || null) : null;
    },
  };
  const window = {
    document,
    setTimeout(fn, ms) { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, init) {
      posts.push(JSON.parse(init.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'lead-' + posts.length }) });
    },
    console,
  };
  if (opts.preloaded !== false) window.turnstile = turnstile;
  if ('key' in opts) window.__NBD_TURNSTILE_SITEKEY = opts.key;
  window.window = window;
  vm.createContext(window);
  vm.runInContext(client, window, { filename: CLIENT_REL });
  return {
    window, log, posts, timers, flush,
    fireTimers() { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } },
  };
}

// A client that never settles must fail loudly, not leave Node to exit 0 with
// the summary unprinted. Real (host) timers — the sandbox's are fakes.
const HUNG = Symbol('hung');
const PAGE_KEY = '0xPAGEKEY';
function within(p, ms) {
  let t;
  return Promise.race([p, new Promise((r) => { t = setTimeout(() => r(HUNG), ms || 1500); })])
    .finally(() => clearTimeout(t));
}
let summaryPrinted = false;
process.on('exit', (code) => {
  if (!summaryPrinted && code === 0) {
    console.log('✗ exited before the summary — a sandbox promise hung');
    process.exitCode = 1;
  }
});

async function behaviour() {
  // Key resolution: undefined → default; '' → opt-out; padded value → trimmed.
  {
    const h = makeHarness({ preloaded: false });
    const p = h.window.nbdTurnstileExecute();
    await h.flush();
    ok('behaviour: no window key ⇒ the client still loads Turnstile (default key)',
       h.log.some((e) => e[0] === 'load-script'));
    const tok = await within(p);
    ok('behaviour: no window key ⇒ render() receives DEFAULT_TURNSTILE_SITEKEY',
       h.log.some((e) => e[0] === 'render' && e[1] === clientDefault) && tok === 'tok-1');
  }
  {
    const h = makeHarness({ preloaded: false, key: '' });
    const tok = await within(h.window.nbdTurnstileExecute());
    ok('behaviour: explicit window key "" stays an opt-out (no script load, empty token)',
       tok === '' && !h.log.some((e) => e[0] === 'load-script' || e[0] === 'render'));
  }
  {
    const h = makeHarness({ key: '  ' + PAGE_KEY + '  ' });
    await within(h.window.nbdTurnstileExecute());
    ok('behaviour: a page-set key wins over the default, trimmed',
       h.log.some((e) => e[0] === 'render' && e[1] === PAGE_KEY));
  }

  // Render once, then reset()+execute() — every submit gets a fresh token.
  // These pass an explicit page key so they exercise the widget lifecycle
  // independently of the default-key hoist tested above.
  {
    const h = makeHarness({ key: PAGE_KEY });
    const first = await within(h.window.submitPublicLead('contact', { firstName: 'A' }));
    const second = await within(h.window.submitPublicLead('contact', { firstName: 'A' }));
    ok('behaviour: both submits settle without waiting on the safety timeout',
       first !== HUNG && second !== HUNG);
    const renders = h.log.filter((e) => e[0] === 'render').length;
    ok('behaviour: two submits render the widget exactly once (got ' + renders + ')', renders === 1);
    const resetAt = h.log.findIndex((e) => e[0] === 'reset');
    const lastExec = h.log.map((e) => e[0]).lastIndexOf('execute');
    ok('behaviour: the second submit calls reset(widgetId) before execute(widgetId)',
       resetAt !== -1 && lastExec > resetAt && h.log[resetAt][1] === 'w1' && h.log[lastExec][1] === 'w1');
    ok('behaviour: first POST carries the first token',
       first.ok && h.posts[0] && h.posts[0].turnstileToken === 'tok-1');
    ok('behaviour: second POST carries a FRESH token, not the spent one (got ' +
       JSON.stringify(h.posts[1] && h.posts[1].turnstileToken) + ')',
       second.ok && h.posts[1] && h.posts[1].turnstileToken === 'tok-2');
    ok('behaviour: the safety timeout is cleared once the callback settles the submit (' +
       h.timers.size + ' timer(s) left pending)', h.timers.size === 0);
  }

  // Callback never arrives ⇒ the safety timeout settles empty, and the POST
  // still goes out (the server decides; unconfigured = allow).
  {
    const h = makeHarness({ key: PAGE_KEY, challenge: 'never' });
    const p = h.window.submitPublicLead('contact', { firstName: 'A' });
    await h.flush();
    const pendingMs = [...h.timers.values()].map((t) => t.ms);
    ok('behaviour: a challenge that never answers arms the ' + DECIDED_TIMEOUT_MS + 'ms safety timeout (' + pendingMs.join(',') + ')',
       pendingMs.includes(DECIDED_TIMEOUT_MS));
    h.fireTimers();
    const out = await within(p);
    ok('behaviour: when the safety timeout fires the submit proceeds without a token',
       out.ok && h.posts.length === 1 && !('turnstileToken' in h.posts[0]));
  }
  // The script load itself can stall — a network that drops, rather than
  // refuses, challenges.cloudflare.com. Measured 2026-09-13 in Chromium: with
  // the load inside no deadline, the submit never POSTed at all (> 45s).
  {
    const h = makeHarness({ preloaded: false, script: 'stall' });
    const p = h.window.submitPublicLead('contact', { firstName: 'A' });
    await h.flush();
    const pendingMs = [...h.timers.values()].map((t) => t.ms);
    ok('behaviour: a stalled Turnstile script load is inside the ' + DECIDED_TIMEOUT_MS + 'ms safety timeout (' + pendingMs.join(',') + ')',
       h.log.some((e) => e[0] === 'load-script') && pendingMs.includes(DECIDED_TIMEOUT_MS));
    h.fireTimers();
    const out = await within(p);
    ok('behaviour: a stalled script load still POSTs the lead, tokenless, when the timeout fires',
       out !== HUNG && out.ok && h.posts.length === 1 && !('turnstileToken' in h.posts[0]));
  }
  {
    const h = makeHarness({ key: PAGE_KEY, challenge: 'error' });
    const tok = await within(h.window.nbdTurnstileExecute());
    ok('behaviour: error-callback settles the submit with an empty token', tok === '');
  }
}

// ── 5. Server posture branches ──
{
  const server = read('functions/integrations/turnstile.js');
  ok('server keeps the unconfigured passthrough (secret unset ⇒ allow)',
     /return \{ ok: true, configured: false \};/.test(server));
  ok('server keeps the TURNSTILE_REQUIRED fail-closed branch',
     /TURNSTILE_REQUIRED/.test(server) && /reason: 'turnstile-required'/.test(server));
  ok('server rejects short/absent tokens when configured',
     /token\.length < 10/.test(server) && /reason: 'missing-token'/.test(server));
  ok('server fails CLOSED on verifier error',
     /reason: 'verify-error'/.test(server));
  ok('server verify fetch is time-bounded',
     /AbortSignal\.timeout\(/.test(server));
}

// ── 5b. Prod posture: an unset secret fails CLOSED (2026-10-13) ──
// TURNSTILE_REQUIRED=true in the one tracked, project-scoped env file the
// deploy reads. It is only safe while EVERY function that calls
// verifyTurnstile binds TURNSTILE_SECRET: a caller without the binding would
// read the secret as unset and 403 every submit. Walk the sources for
// callers instead of trusting a list.
{
  const envSrc = read('functions/.env.nobigdeal-pro');
  const live = envSrc.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  ok('prod env file sets TURNSTILE_REQUIRED=true (live line, not a comment)', live.some((l) => /^TURNSTILE_REQUIRED=true\s*$/.test(l)));
  ok('no second, conflicting TURNSTILE_REQUIRED line', live.filter((l) => /^TURNSTILE_REQUIRED=/.test(l)).length === 1);
  const callers = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      if (e.name === 'node_modules' || e.name.startsWith('.')) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!/\.js$/.test(e.name)) return;
      const src = stripJsComments(fs.readFileSync(p, 'utf8'));
      if (/\bverifyTurnstile\(/.test(src) && !/integrations\/turnstile\.js$/.test(rel(p).replace(/\\/g, '/'))) callers.push({ file: rel(p), binds: /TURNSTILE_SECRET/.test(src) });
    });
  })(path.join(ROOT, 'functions'));
  ok('positive control: the walk finds the two known callers', callers.some((c) => c.file === 'functions/care-plan.js') && callers.some((c) => c.file === 'functions/handlers/integrations.js'), JSON.stringify(callers));
  ok('every verifyTurnstile caller binds TURNSTILE_SECRET (else the fail-closed flag would 403 it)', callers.length > 0 && callers.every((c) => c.binds), JSON.stringify(callers));
  const runbook = read('documentation/runbooks/TURNSTILE-SETUP.md');
  ok('runbook Emergency no longer says blanking the secret opens the gate', !/destroy or blank `TURNSTILE_SECRET` and redeploy; the\s+verifier returns to its unconfigured passthrough/.test(runbook) && /TURNSTILE_REQUIRED=false/.test(runbook));
}

// ── 6. Deployment-order warning stays where the human will look ──
ok('sitekey stub carries the populate-key-BEFORE-secret deployment warning',
   /BEFORE TURNSTILE_SECRET/.test(stub));

behaviour().catch((e) => ok('behaviour sandbox ran without throwing: ' + (e && e.stack || e), false)).then(() => {
  summaryPrinted = true;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('Failures:\n' + fails.map((f) => '  - ' + f).join('\n'));
    process.exit(1);
  }
});
