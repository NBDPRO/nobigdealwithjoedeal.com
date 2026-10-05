#!/usr/bin/env node
/**
 * oaks-own-intake-2026-10-04.test.js
 *
 * The Oaks tenant site (docs/sites/oaks/) used to submit its quote form by
 * opening the visitor's mail app (formEmail), with a commented-out FormSubmit
 * relay as the "upgrade". Leads never reached the CRM. It now posts through
 * the same submitPublicLead intake every NBD form uses, tagged siteKey 'oaks'
 * so the server files the lead under companies/oaks (and lead-alert routes the
 * alert per companyProfile/oaks), with the mail app kept only as a last resort.
 *
 * Behaviour, not regex: the REAL docs/assets/js/public-lead-submit.js and the
 * REAL docs/sites/oaks/assets/js/site.js run together in a vm sandbox with a
 * fake DOM, a fake fetch and a fake window.turnstile. The form is submitted and
 * the captured request is checked: host, path, payload, tenant tag, Turnstile
 * token. Then the failure, no-gateway and honeypot paths. Then the static
 * contract: no FormSubmit anywhere in the Oaks folder, the four form pages load
 * the intake client, the Oaks pages' CSP allows the intake, and the privacy
 * page no longer claims the form only opens a mail app.
 *
 * Zero dependencies. Run: node tests/oaks-own-intake-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OAKS = path.join(ROOT, 'docs', 'sites', 'oaks');
const SITE_JS = fs.readFileSync(path.join(OAKS, 'assets', 'js', 'site.js'), 'utf8');
const CLIENT_JS = fs.readFileSync(path.join(ROOT, 'docs', 'assets', 'js', 'public-lead-submit.js'), 'utf8');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ ' + msg); }
}

const FIELDS = {
  first_name: 'Pat', last_name: 'Tester', email: 'pat@nbd.test', phone: '(513) 555-0142',
  zip: '45122', service: 'Roof Repair', message: 'Leak over the kitchen', company_website: ''
};

// ── Fake DOM + browser globals ─────────────────────────────────────────
function makeEnv(opts) {
  opts = opts || {};
  const fetchCalls = [];
  const rendered = [];
  const appended = [];
  const msg = { className: '', textContent: '', scrollIntoView() {} };
  const btn = { disabled: false };
  const hp = { value: opts.honeypot || '' };
  let submitHandler = null;
  const form = {
    _values: Object.assign({}, FIELDS, { company_website: hp.value }),
    resetCount: 0,
    querySelector(sel) {
      if (sel === '.orc-form-msg') return msg;
      if (sel === '[type="submit"]') return btn;
      if (sel === '.orc-hp input') return hp;
      return null;
    },
    checkValidity() { return true; },
    reportValidity() {},
    addEventListener(type, fn) { if (type === 'submit') submitHandler = fn; },
    reset() { this.resetCount++; },
    appendChild(el) { appended.push(el); return el; },
    closest() { return form; },
  };
  function el(tag) {
    return {
      tagName: String(tag).toUpperCase(), style: {}, dataset: {}, children: [],
      setAttribute() {}, appendChild(c) { this.children.push(c); appended.push(c); return c; },
    };
  }
  const document = {
    readyState: 'complete',
    activeElement: null,
    head: { appendChild(c) { appended.push(c); return c; } },
    body: { children: [], appendChild(c) { appended.push(c); return c; } },
    createElement: el,
    createTextNode(t) { return { text: t }; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll(sel) { return sel === 'form[data-orc-form]' ? [form] : []; },
  };
  class FormData {
    constructor(f) { this._f = f; }
    forEach(cb) { Object.keys(this._f._values).forEach((k) => cb(this._f._values[k], k)); }
  }
  const ctx = {
    document, FormData, console, Promise, JSON, Object, Array, String, Error, URL,
    setTimeout, clearTimeout, encodeURIComponent,
    location: { href: 'http://127.0.0.1:5000/sites/oaks/contact', pathname: '/sites/oaks/contact' },
    fetch(url, init) {
      fetchCalls.push({ url, init });
      if (opts.fetchThrows) return Promise.reject(new Error('offline'));
      const status = opts.status || 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300, status,
        json: () => Promise.resolve(status === 200 ? { success: true, id: 'pub-1' } : { error: 'Submission failed' }),
      });
    },
    turnstile: {
      render(box, o) { rendered.push(o); this._o = o; return 'w1'; },
      reset() {},
      execute() { const o = this._o; Promise.resolve().then(() => o.callback('tok-oaks-1234567890')); },
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  if (!opts.noGateway) vm.runInContext(CLIENT_JS, ctx, { filename: 'public-lead-submit.js' });
  vm.runInContext(SITE_JS, ctx, { filename: 'oaks/site.js' });
  return {
    ctx, form, msg, btn, fetchCalls, rendered, appended,
    async submit() {
      if (!submitHandler) throw new Error('site.js never wired the form');
      submitHandler({ preventDefault() {} });
      for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

function textOf(nodes) {
  return JSON.stringify(nodes, (k, v) => (k === 'children' || typeof v !== 'function' ? v : undefined));
}

(async function main() {
  console.log('\nOaks quote form → our own lead intake');

  // 1. Happy path
  {
    const env = makeEnv();
    await env.submit();
    ok(env.fetchCalls.length === 1, 'exactly one request is made on submit (got ' + env.fetchCalls.length + ')');
    const call = env.fetchCalls[0] || { url: '', init: {} };
    let u = null;
    try { u = new URL(call.url); } catch (_) {}
    ok(!!u && u.protocol === 'https:' && u.hostname === 'us-central1-nobigdeal-pro.cloudfunctions.net',
      'request goes to our own Cloud Functions host, nothing third-party (got ' + call.url + ')');
    ok(!!u && u.pathname === '/submitPublicLead', 'request hits the submitPublicLead intake');
    ok(call.init && call.init.method === 'POST' && call.init.credentials === 'omit', 'POST without credentials');
    let body = {};
    try { body = JSON.parse(call.init.body); } catch (_) {}
    ok(body.kind === 'contact', 'payload kind is contact');
    ok(body.siteKey === 'oaks', 'payload carries the Oaks tenant key (siteKey "oaks")');
    ok(body.source === 'tenant-site:oaks', 'payload source names the Oaks tenant site');
    ok(body.firstName === 'Pat' && body.lastName === 'Tester' && body.email === 'pat@nbd.test' &&
      body.phone === '(513) 555-0142' && body.zip === '45122' && body.service === 'Roof Repair' &&
      body.message === 'Leak over the kitchen', 'form fields map onto the intake field names');
    ok(body.nbd_hp === '', 'honeypot is sent under the name the intake checks (nbd_hp)');
    ok(!('first_name' in body) && !('company_website' in body) && !('companyId' in body),
      'no raw form names, no honeypot name leak, no client-asserted companyId');
    ok(body.turnstileToken === 'tok-oaks-1234567890', 'a Turnstile token is attached (same protection as NBD forms)');
    ok(env.rendered.length === 1 && env.rendered[0].sitekey === '0x4AAAAAAEqcVVOXW3xyusXQ',
      'Turnstile widget rendered with the site key every NBD form uses');
    ok(!/^mailto:/.test(env.ctx.location.href), 'success does NOT open the mail app');
    ok(env.form.resetCount === 1 && /request is in/.test(env.msg.textContent), 'success resets the form and says so');
    ok(env.btn.disabled === false, 'submit button re-enabled');
  }

  // 2. Intake fails → mail app as last resort, never NBD's number
  for (const mode of [{ status: 500 }, { fetchThrows: true }]) {
    const env = makeEnv(mode);
    await env.submit();
    const label = mode.status ? 'HTTP 500' : 'network error';
    ok(env.fetchCalls.length === 1, label + ': the intake was tried first');
    ok(/^mailto:scott@oaksroofingandconstruction\.com\?/.test(env.ctx.location.href),
      label + ': falls back to the mail app, addressed to Oaks');
    ok(/Pat/.test(decodeURIComponent(env.ctx.location.href)), label + ': the fallback email carries the request');
    ok(env.msg.className.indexOf('err') !== -1 && /\(513\) 827-5297/.test(env.msg.textContent),
      label + ': visitor is told it failed and given the Oaks phone');
    ok(env.ctx.__NBD_LEAD_FALLBACK === false && !/859|Joe/.test(textOf(env.appended)),
      label + ': NBD’s "Call or text Joe" fallback never appears on the Oaks site');
    ok(env.form.resetCount === 0, label + ': form keeps what the visitor typed');
  }

  // 3. Gateway client not loaded (folder hosted elsewhere) → mail app
  {
    const env = makeEnv({ noGateway: true });
    await env.submit();
    ok(env.fetchCalls.length === 0, 'no gateway: site.js makes no request of its own');
    ok(/^mailto:scott@oaksroofingandconstruction\.com\?/.test(env.ctx.location.href), 'no gateway: mail app fallback');
  }

  // 4. Honeypot filled → nothing sent anywhere
  {
    const env = makeEnv({ honeypot: 'http://spam.example' });
    await env.submit();
    ok(env.fetchCalls.length === 0 && !/^mailto:/.test(env.ctx.location.href), 'filled honeypot: nothing is sent');
  }

  // 5. Static contract
  console.log('\nStatic contract');
  const oaksFiles = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(html|js|md|css)$/.test(n)) oaksFiles.push(p);
    }
  })(OAKS);
  const fsHits = oaksFiles.filter((p) => /formsubmit/i.test(fs.readFileSync(p, 'utf8')));
  ok(fsHits.length === 0, 'no FormSubmit reference anywhere under docs/sites/oaks (' + fsHits.map((p) => path.relative(ROOT, p)).join(', ') + ')');
  ok(!/formEndpoint/.test(SITE_JS), 'site.js has no generic formEndpoint relay hook');
  ok(!/\bfetch\s*\(/.test(SITE_JS.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'site.js never calls fetch itself (only the shared intake does)');

  for (const page of ['index.html', 'about.html', 'service-areas.html', 'contact.html']) {
    const html = fs.readFileSync(path.join(OAKS, page), 'utf8');
    const iClient = html.indexOf('<script defer src="/assets/js/public-lead-submit.js"></script>');
    const iSite = html.indexOf('<script defer src="assets/js/site.js"></script>');
    ok(html.indexOf('data-orc-form') !== -1 && iClient !== -1 && iSite !== -1 && iClient < iSite,
      page + ': has the form and loads the intake client (defer) before site.js');
    const srcs = (html.match(/<script[^>]*\ssrc="([^"]+)"/g) || []).map((t) => t.match(/src="([^"]+)"/)[1]);
    ok(srcs.every((s) => !/^(https?:)?\/\//.test(s)), page + ': loads no third-party script directly');
  }

  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const cspEntries = fb.hosting.headers.filter((h) =>
    (h.headers || []).some((x) => x.key === 'Content-Security-Policy'));
  const oaksSpecific = cspEntries.filter((h) => /^\/sites/.test(h.source));
  ok(oaksSpecific.length === 0, 'no /sites-specific CSP override, so the Oaks pages get the global policy');
  const global = cspEntries.find((h) => h.source === '**');
  const csp = global ? global.headers.find((x) => x.key === 'Content-Security-Policy').value : '';
  const dir = (name) => ((csp.split(';').map((s) => s.trim()).find((s) => s.indexOf(name + ' ') === 0)) || '').split(/\s+/);
  ok(dir('connect-src').indexOf('https://*.cloudfunctions.net') !== -1, 'CSP connect-src allows the intake host');
  ok(dir('script-src-elem').indexOf('https://challenges.cloudflare.com') !== -1 &&
    dir('frame-src').indexOf('https://challenges.cloudflare.com') !== -1 &&
    dir('connect-src').indexOf('https://challenges.cloudflare.com') !== -1, 'CSP allows the Turnstile challenge');
  ok(dir('script-src-attr').indexOf("'none'") !== -1, "CSP still blocks inline handlers (script-src-attr 'none')");

  const privacy = fs.readFileSync(path.join(OAKS, 'privacy.html'), 'utf8');
  ok(!/does not send anything by itself/.test(privacy) && !/do not pass through this website/.test(privacy),
    'privacy page no longer claims the form only composes an email');
  ok(/own customer records/.test(privacy) && /automated check/.test(privacy),
    'privacy page describes our own intake and the spam check');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
