/**
 * tests/lazy-ask-joe-actions-2026-11-08.test.js — Ask Joe's tools and confirm
 * cards (js/ask-joe-actions.js, window.NBDJoeActions) load with the Ask Joe
 * view, not on every dashboard boot (boot-weight lane, 2026-11-08).
 *
 * Before: an eager deferred <script> on every boot for a module only the Ask
 * Joe view reads. After: ai.js registers it at runtime as the ScriptLoader
 * bundle `askjoe` and maps the `joe` view to it (so goTo('joe') fetches it),
 * waits for it before a send and before drawing a saved transcript, and
 * guards the one reader that did not check (repaintJoeCard). Pins, with the
 * REAL script-loader.js, ai.js and ask-joe-actions.js in a vm (a fake <head>
 * runs the real file when the loader injects its tag):
 *   - nothing fetches ask-joe-actions.js at boot or on another view; ai.js
 *     registers the bundle and the view on the real ScriptLoader, and
 *     script-loader.js (blocking, at its byte ceiling) does not grow;
 *   - goTo('joe') loads the module;
 *   - a reload on #/joe with a saved transcript draws its confirm card and
 *     its tool-turn text once the module lands (also from a bare initJoeChat);
 *   - the first message sent before the module landed still carries the
 *     toolset and the tools addendum, and a tool_use becomes a card;
 *   - a failed fetch leaves a working text-only chat: the transcript draws,
 *     a send goes out, cancelling a restored pending card never throws, and
 *     the next send retries the fetch;
 *   - no ScriptLoader, or a loadBundle that throws: the chat still sends;
 *   - dashboard.html has no eager tag for the file, keeps ai.js deferred and
 *     after ask-joe-rules.js, and keeps the late stylesheet.
 *
 * Run: node tests/lazy-ask-joe-actions-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}

const LOADER = read('docs/pro/js/script-loader.js');
const AI = read('docs/pro/js/ai.js');
const LEADS = [{ id: 'L1', firstName: 'Maria', lastName: 'Lopez', phone: '8595550147', stage: 'new' }];
// A transcript saved mid-card: Joe's tool turn (content blocks) and the
// pending confirm card it raised. Both are drawn by ask-joe-actions.js.
const SAVED = [
  { role: 'joe', content: 'Hey Pat' },
  { role: 'user', content: 'text Maria' },
  { role: 'joe', content: [{ type: 'text', text: 'Texting Maria now.' }, { type: 'tool_use', id: 't2', name: 'send_text', input: { lead_id: 'L1', message: 'Hi Maria' } }] },
  { role: 'card', id: 't2', name: 'send_text', input: { lead_id: 'L1', message: 'Hi Maria' }, status: 'pending', partial: [] },
];

class El {
  constructor(tag, id) { this.tag = tag; this.id = id || ''; this.style = {}; this.innerHTML = ''; this.value = ''; this.disabled = false; this.dataset = {}; this.scrollTop = 0; this.scrollHeight = 0; this.textContent = ''; }
  get firstChild() { return { __html: this.innerHTML }; }
  appendChild(n) { this.innerHTML += n && n.__html != null ? n.__html : '<div id="' + ((n && n.id) || '') + '">' + ((n && n.innerHTML) || '') + '</div>'; return n; }
  replaceWith(n) { this.replacedWith = n && n.__html; }
  remove() {}
}

// A dashboard-like window: real loader + real ai.js, fake DOM, fake fetch.
function makeEnv(opts) {
  opts = opts || {};
  const env = { injected: [], requests: [], replies: (opts.replies || []).slice(), fail: !!opts.fail };
  const storage = (seed) => { const s = Object.assign({}, seed || {}); return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; }, _s: s }; };
  const els = {};
  ['joeNoKey', 'joeMessages', 'joeInputArea', 'joeContextBar', 'joeInput', 'joeSendBtn'].forEach((id) => { els[id] = new El('div', id); });
  const head = {
    appendChild(node) {
      if (node.tag !== 'script') { if (node.rel === 'stylesheet' && node.onload) setTimeout(() => node.onload(), 0); return node; }
      env.injected.push(node.src);
      setTimeout(() => {
        if (env.fail) { if (node.onerror) node.onerror(); return; }
        const file = path.join(ROOT, 'docs/pro', String(node.src).split('?')[0]);
        vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: path.basename(file) });
        if (node.onload) node.onload();
      }, 0);
      return node;
    },
  };
  const document = {
    baseURI: 'https://crm.test/pro/dashboard.html',
    head,
    getElementById: (id) => els[id] || null,
    createElement: (tag) => new El(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const ctx = {
    document, URL, setTimeout, clearTimeout, JSON, Date, Math, Promise, Set, Map,
    console: { log() {}, warn() {}, info() {}, error: console.error },
    sessionStorage: storage(opts.saved ? { nbd_joe_chat: JSON.stringify(opts.saved) } : {}),
    localStorage: storage(),
    showToast() {},
    _leads: LEADS.slice(),
    // The dashboard's goTo preloads the view's bundles (dashboard-actions.js, pinned below).
    goTo(name) { if (ctx.ScriptLoader && typeof ctx.ScriptLoader.preloadForView === 'function') ctx.ScriptLoader.preloadForView(name); },
    callClaude: async (req) => { env.requests.push(req); return env.replies.shift() || { content: [{ type: 'text', text: 'Sure thing.' }], stop_reason: 'end_turn' }; },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  if (opts.loader !== false) vm.runInContext(LOADER, ctx, { filename: 'script-loader.js' });
  if (opts.before) opts.before(ctx);
  vm.runInContext(AI, ctx, { filename: 'ai.js' });
  env.ctx = ctx; env.els = els; env.session = ctx.sessionStorage._s;
  env.msgs = () => els.joeMessages.innerHTML;
  return env;
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
async function waitFor(fn, ms) { const end = Date.now() + (ms || 1000); while (Date.now() < end) { if (fn()) return true; await tick(10); } return !!fn(); }
async function send(env, text) { env.els.joeInput.value = text; await env.ctx.sendJoeMessage(); }
async function scenario(name, fn) { try { await fn(); } catch (e) { ok(name + ': ran without throwing', false, e && e.stack); } }

(async () => {
  console.log('\nASK JOE ACTIONS LAZY: registration and boot');
  await scenario('boot', async () => {
    const env = makeEnv({ before: (c) => {
      ok('control: script-loader.js itself carries no askjoe bundle and no joe view (it is blocking and at its byte ceiling)', !c.ScriptLoader.bundles.askjoe && !c.ScriptLoader.views.joe);
    } });
    const SL = env.ctx.ScriptLoader;
    const b = SL.bundles.askjoe;
    ok('ai.js registers the askjoe bundle on the real ScriptLoader: exactly js/ask-joe-actions.js', Array.isArray(b) && b.length === 1 && /^js\/ask-joe-actions\.js\?v=\d+$/.test(b[0]), JSON.stringify(b));
    ok('ai.js maps the joe view to it, so goTo(\'joe\') preloads it', JSON.stringify(SL.views.joe) === '["askjoe"]', JSON.stringify(SL.views.joe));
    await tick(20);
    ok('nothing fetches ask-joe-actions.js at boot', env.injected.length === 0 && env.ctx.NBDJoeActions === undefined, env.injected);
    env.ctx.goTo('crm'); env.ctx.goTo('home');
    await tick(120);
    ok('opening another view does not fetch it either', env.injected.length === 0, env.injected);
    env.ctx.goTo('joe');
    ok('goTo(\'joe\') fetches it', await waitFor(() => !!env.ctx.NBDJoeActions) && env.injected.filter((s) => /ask-joe-actions\.js/.test(s)).length === 1, env.injected);
    env.ctx.goTo('joe');
    await tick(120);
    ok('opening the view again does not fetch it twice (ScriptLoader dedupes)', env.injected.length === 1, env.injected);
  });
  await scenario('registered-once', async () => {
    const env = makeEnv({ before: (c) => { c.ScriptLoader.bundles.askjoe = ['js/other.js']; c.ScriptLoader.views.joe = ['other']; } });
    ok('an existing askjoe / joe registration is left alone (registered-once guard, like today-home.js)', env.ctx.ScriptLoader.bundles.askjoe[0] === 'js/other.js' && env.ctx.ScriptLoader.views.joe[0] === 'other');
  });

  console.log('\nASK JOE ACTIONS LAZY: a reload on #/joe with a saved transcript');
  await scenario('reload', async () => {
    const env = makeEnv({ saved: SAVED });
    env.ctx.goTo('joe'); // dashboard-main.js replays #/joe through goTo on DOMContentLoaded; ai.js runs initJoeChat 80 ms later
    const drawn = await waitFor(() => /id="joeCard-t2"/.test(env.msgs()));
    ok('the saved confirm card is drawn once the module lands', drawn && /Text Maria Lopez/.test(env.msgs()) && /data-joe-card="confirm"/.test(env.msgs()), env.msgs().slice(0, 400));
    ok('Joe\'s saved tool turn shows its text', /Texting Maria now\./.test(env.msgs()), env.msgs().slice(0, 400));
    ok('the plain bubbles are still there, each once', (env.msgs().match(/Hey Pat/g) || []).length === 1 && (env.msgs().match(/text Maria/g) || []).length === 1, env.msgs().slice(0, 400));
  });
  await scenario('bare-init', async () => {
    const env = makeEnv({ saved: SAVED });
    env.ctx.initJoeChat(); // window.initJoeChat with no view open (no preloadForView): initJoeChat loads it itself
    ok('a bare initJoeChat loads the module and draws the card', await waitFor(() => /id="joeCard-t2"/.test(env.msgs())) && env.injected.length === 1, env.msgs().slice(0, 300));
  });

  console.log('\nASK JOE ACTIONS LAZY: the first send');
  await scenario('first-send', async () => {
    const env = makeEnv({ replies: [{ content: [{ type: 'text', text: 'Texting her.' }, { type: 'tool_use', id: 'tu1', name: 'send_text', input: { lead_id: 'L1', message: 'Hi Maria' } }], stop_reason: 'tool_use' }] });
    await send(env, 'text Maria hi'); // before the module was ever fetched
    const req = env.requests[0] || {};
    ok('the first message sent before the module landed carries the toolset', req.toolset === 'joe-actions-v1', JSON.stringify(Object.keys(req)));
    ok('...and the tools addendum in the system prompt', /TOOLS \(you can act in the CRM\)/.test(req.system || ''));
    ok('...and Joe\'s tool_use becomes a confirm card', /id="joeCard-tu1"/.test(env.msgs()), env.msgs().slice(-300));
    ok('the send button is enabled again', env.els.joeSendBtn.disabled === false);
  });

  console.log('\nASK JOE ACTIONS LAZY: a failed fetch leaves a working chat');
  await scenario('failed-fetch', async () => {
    const env = makeEnv({ saved: SAVED, fail: true });
    env.ctx.goTo('joe');
    ok('the saved transcript still draws (text only, no card)', await waitFor(() => /Hey Pat/.test(env.msgs())) && /text Maria/.test(env.msgs()) && !/joeCard-t2/.test(env.msgs()), env.msgs().slice(0, 300));
    ok('the module is not on the page', env.ctx.NBDJoeActions === undefined);
    // The restored card's node is on the page (drawn earlier in this tab) but the module is not: typing on cancels it.
    env.els['joeCard-t2'] = new El('div', 'joeCard-t2');
    let threw = null;
    try { await send(env, 'hello'); } catch (e) { threw = e; }
    ok('typing on with a restored pending card does not throw (repaintJoeCard is guarded)', !threw, threw && threw.message);
    const req = env.requests[0] || {};
    ok('the message still goes out, text-only (no toolset)', env.requests.length === 1 && req.toolset === undefined && /hello/.test(JSON.stringify(req.messages || [])), JSON.stringify(req).slice(0, 300));
    ok('the reply is drawn and the send button is enabled again', /Sure thing\./.test(env.msgs()) && env.els.joeSendBtn.disabled === false);
    const hist = JSON.parse(env.session.nbd_joe_chat || '[]');
    ok('the pending card is answered "cancelled" in the saved history', hist.some((m) => m.role === 'card' && m.id === 't2' && m.status === 'cancelled') && hist.some((m) => m.role === 'tool' && /cancelled/.test(JSON.stringify(m.content))));
    env.fail = false;
    const before = env.injected.length;
    await send(env, 'text Maria');
    ok('the next send retries the fetch and gets the toolset', env.injected.length === before + 1 && (env.requests[1] || {}).toolset === 'joe-actions-v1', JSON.stringify({ injected: env.injected, toolset: (env.requests[1] || {}).toolset }));
  });
  await scenario('no-loader', async () => {
    let threw = null, env = null;
    try { env = makeEnv({ loader: false }); await send(env, 'hi'); } catch (e) { threw = e; }
    ok('no ScriptLoader on the page: ai.js loads and a send goes out text-only', !threw && env && env.requests.length === 1 && env.requests[0].toolset === undefined && /Sure thing\./.test(env.msgs()), threw && threw.message);
  });
  await scenario('throwing-loader', async () => {
    let threw = null, env = null;
    try {
      env = makeEnv({ loader: false, before: (c) => { c.ScriptLoader = { bundles: {}, views: {}, loadBundle() { throw new Error('boom'); } }; } });
      await send(env, 'hi');
    } catch (e) { threw = e; }
    ok('a loadBundle that throws: the send still goes out text-only and the reply shows', !threw && env && env.requests.length === 1 && env.requests[0].toolset === undefined && /Sure thing\./.test(env.msgs()), threw && threw.message);
  });

  console.log('\nASK JOE ACTIONS LAZY: the page');
  {
    const dash = read('docs/pro/dashboard.html');
    ok('dashboard.html has no eager tag for ask-joe-actions.js', !/<script[^>]*src="[^"]*ask-joe-actions\.js/.test(dash));
    ok('ai.js stays a deferred tag, after the blocking script-loader.js (registration needs it)', /<script defer src="js\/ai\.js\?v=\d+"><\/script>/.test(dash) && dash.indexOf('js/script-loader.js') > 0 && dash.indexOf('js/ai.js') > dash.indexOf('js/script-loader.js'));
    ok('deposit-rule → ask-joe-rules → ai.js order is unchanged (claim-wording pin)', dash.indexOf('js/ask-joe-rules.js') > dash.indexOf('js/deposit-rule.js') && dash.indexOf('js/ai.js') > dash.indexOf('js/ask-joe-rules.js'));
    ok('the card stylesheet is still linked, late (goTo flips it before the view paints)', /<link rel="stylesheet" media="print" data-late-css href="css\/ask-joe-actions\.css\?v=\d+">/.test(dash));
    ok('script-loader.js is untouched by this lane', !/askjoe|ask-joe-actions/.test(LOADER));
    ok('the dashboard\'s goTo preloads the view\'s bundles (what the fake goTo above mirrors)', /window\.ScriptLoader\.preloadForView\(name\)/.test(read('docs/pro/js/dashboard-actions.js')));
    ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"lazy-ask-joe-actions-2026-11-08.test.js"') >= 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
