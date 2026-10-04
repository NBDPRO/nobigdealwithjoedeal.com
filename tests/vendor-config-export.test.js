/**
 * tests/vendor-config-export.test.js — the vendor-config backup never ships a
 * credential, and exports what it claims to.
 *
 * functions/vendor-config-export-core.js pulls the Bland "Thursday" agent,
 * pathway, persona and numbers (plus Cal.com, BoldSign and the Stripe catalog)
 * and uploads them to a private bucket. The one way this goes badly wrong is a
 * key or token inside an export (a tool header, a webhook ?token=, a prompt
 * that quotes a key), so most of this suite drives redactTokens() and
 * collectVendorConfig() with a fake fetch whose responses ECHO the API key and
 * the Thursday lookup token, then asserts neither literal survives anywhere in
 * the files or the manifest — with a presence control proving the fake really
 * did put them there.
 *
 * Also pinned: a vendor with no secret (or the deploy's `__unset__` stub) is
 * skipped and named in the manifest; an optional endpoint failing does not
 * count as a failure; Bland autosave drafts (semver null) are not requested
 * (Bland 400s them); Stripe pages merge into one file; and the scheduled
 * function binds every secret the core reads and uses the heartbeat wrapper.
 *
 * Pure Node, no network. Run: node tests/vendor-config-export.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const core = require(path.join(ROOT, 'functions', 'vendor-config-export-core.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const BLAND_KEY = 'org_fakeblandkey0123456789abcdefABCDEF';
const LOOKUP = 'lookup-token-9f8e7d6c5b4a3210';
// Assembled at run time so push protection does not read a fixture as a key.
const STRIPE_KEY = ['sk', 'live', 'FAKEfake0123456789abcdef'].join('_');
const AGENT = '4c2b2b93-9251-4477-b9b3-3dbfae4eccfe';
const PATHWAY = '771a3ea4-1e79-40da-aafa-6ec086688913';

// ── 1. redactTokens on its own ─────────────────────────────────────────
console.log('redactTokens');
{
  const input = {
    id: AGENT,
    phone_number: '+15139405589',
    max_tokens: 250,
    tokens: 'not-a-secret-just-a-label-word',
    headers: { authorization: 'Bearer abcdefghijklmnop1234', 'x-api-key': 'plainvalue12345' },
    webhook: 'https://example.test/hook?token=' + LOOKUP + '&x=1',
    prompt: 'Use key ' + STRIPE_KEY + ' and whsec_abcdefghij1234567890 and the code ' + LOOKUP + ' never.',
    code: "fetch(u, { headers: { authorization: 'Bearer ' + env.T } })",
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstu',
    nested: [{ client_secret: 'cs_abcdefghijk' }, { note: 'Google AIzaSyA1234567890abcdefghijklmnopqrstuv1 here' }],
    short_token: 'abc',
  };
  const { data, count } = core.redactTokens(input, [LOOKUP]);
  const text = JSON.stringify(data);
  ok('UUID ids survive', data.id === AGENT);
  ok('phone number survives', data.phone_number === '+15139405589');
  ok('numeric max_tokens survives', data.max_tokens === 250);
  ok('"tokens" label key is not treated as a secret', data.tokens === input.tokens);
  ok('authorization header value redacted', data.headers.authorization === core.REDACTED);
  ok('x-api-key header value redacted', data.headers['x-api-key'] === core.REDACTED);
  ok('?token= in a URL redacted, rest of URL kept',
    data.webhook === 'https://example.test/hook?token=' + core.REDACTED + '&x=1', data.webhook);
  ok('Stripe live key inside prose redacted', text.indexOf(STRIPE_KEY) === -1);
  ok('whsec_ inside prose redacted', !/whsec_abcdefghij/.test(text));
  ok('known literal (lookup token) inside prose redacted', text.indexOf(LOOKUP) === -1);
  ok('prose around a redaction is kept', /Use key \[REDACTED\] and/.test(data.prompt), data.prompt);
  ok('code that only references env keeps its shape', data.code === input.code);
  ok('JWT redacted', data.jwt === core.REDACTED);
  ok('client_secret key redacted', data.nested[0].client_secret === core.REDACTED);
  ok('Google API key in prose redacted', !/AIzaSy/.test(text));
  ok('short string under a secret-ish key left alone (not a credential)', data.short_token === 'abc');
  ok('count reports replacements', count >= 9, 'count=' + count);
  ok('input object not mutated', input.headers.authorization.startsWith('Bearer abc'));
  ok('containsKnownSecret finds a literal', core.containsKnownSecret('x ' + LOOKUP + ' y', [LOOKUP]));
  ok('containsKnownSecret ignores the __unset__ stub', !core.containsKnownSecret('__unset__', ['__unset__']));
}

// ── 2. collectVendorConfig with a fake fetch that echoes the secrets ────
function fakeFetchFactory(log) {
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
  return async (url, init) => {
    const h = (init && init.headers) || {};
    log.push({ url, auth: h.authorization || h['X-API-KEY'] || '' });
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname);
    if (u.host === 'api.bland.ai') {
      if (h.authorization !== BLAND_KEY) return json(401, { error: 'bad key' });
      if (p === '/v2/agents') return json(200, { data: [{ id: AGENT, name: 'Thursday' }], errors: null });
      if (p === '/v2/agents/' + AGENT) return json(200, { data: { id: AGENT, environments: [] } });
      if (p === '/v2/agents/' + AGENT + '/versions') {
        return json(200, { data: [{ id: 'v-1', semver: '0.7.0' }, { id: 'draft-1', semver: null, created_via: 'autosave' }] });
      }
      if (p === '/v2/agents/' + AGENT + '/versions/0.7.0') {
        // An agent version that quotes both secrets (the case redaction exists for).
        return json(200, { data: { prompt: 'Thursday. Debug key ' + BLAND_KEY, tool_headers: { authorization: 'Bearer ' + LOOKUP } } });
      }
      if (p === '/v1/pathway') return json(200, [{ id: PATHWAY, name: 'Thursday' }]);
      if (p === '/v1/pathway/' + PATHWAY) {
        return json(200, { name: 'Thursday', nodes: [{ id: '__start', data: { isStart: true, url: 'https://x.test/lookup?token=' + LOOKUP } }], edges: [] });
      }
      if (p === '/v1/inbound') return json(200, { inbound_numbers: [{ phone_number: '+15139405589' }] });
      if (p === '/v1/inbound/+15139405589') return json(200, { phone_number: '+15139405589', webhook: 'https://x.test/w?key=' + LOOKUP });
      if (p === '/v1/personas') return json(200, { data: [{ id: 'p1', name: 'Thursday' }] });
      if (p === '/v1/tools') return json(500, { error: 'boom ' + BLAND_KEY }); // optional + echoes key in error
      if (p === '/v1/knowledgebases') return json(200, { data: { vectors: [], total: 0 } });
      return json(404, { error: 'unexpected ' + p });
    }
    if (u.host === 'api.stripe.com') {
      if (h.authorization !== 'Bearer ' + STRIPE_KEY) return json(401, {});
      const after = u.searchParams.get('starting_after');
      if (p === '/v1/products') {
        return after ? json(200, { object: 'list', data: [{ id: 'prod_2' }], has_more: false })
          : json(200, { object: 'list', data: [{ id: 'prod_1' }], has_more: true });
      }
      return json(200, { object: 'list', data: [], has_more: false });
    }
    return json(404, { error: 'unknown host ' + u.host });
  };
}

(async () => {
  console.log('collectVendorConfig');
  const log = [];
  const secrets = {
    BLAND_API_KEY: BLAND_KEY + '\n',          // trailing newline, as pasted secrets often have
    THURSDAY_LOOKUP_TOKEN: LOOKUP,
    STRIPE_SECRET_KEY: STRIPE_KEY,
    BOLDSIGN_API_KEY: '__unset__',            // the deploy stub
    // CALCOM_API_KEY absent
  };
  const { files, manifest } = await core.collectVendorConfig({
    getSecret: (n) => (n in secrets ? secrets[n] : null),
    fetchImpl: fakeFetchFactory(log),
    now: new Date('2026-10-04T12:00:00Z'),
  });
  const paths = files.map((f) => f.path);
  const all = JSON.stringify(files) + JSON.stringify(manifest);

  // Presence control: the fake really served the secrets, so their absence
  // below is the redactor's doing and not an empty export.
  const rawEcho = log.some((l) => /\/versions\/0\.7\.0$/.test(l.url));
  ok('presence control: the version that echoes both secrets was fetched', rawEcho);
  ok('agent version file exported', paths.includes('bland/agents/' + AGENT + '/versions/0.7.0.json'), paths.join(','));
  ok('pathway exported', paths.includes('bland/pathways/' + PATHWAY + '.json'));
  ok('inbound number exported', paths.includes('bland/inbound/+15139405589.json'));
  ok('personas exported', paths.includes('bland/personas.json'));
  ok('Bland API key literal absent from every file and the manifest', all.indexOf(BLAND_KEY) === -1);
  ok('Thursday lookup token literal absent everywhere', all.indexOf(LOOKUP) === -1);
  ok('Stripe key literal absent everywhere', all.indexOf(STRIPE_KEY) === -1);
  const ver = files.find((f) => /0\.7\.0\.json$/.test(f.path));
  ok('redacted prompt keeps its words', ver && /Thursday\. Debug key \[REDACTED\]/.test(ver.data.data.prompt));
  ok('the trimmed key was used to authenticate', log.some((l) => l.auth === BLAND_KEY));
  ok('autosave draft (semver null) not requested', !log.some((l) => /draft-1/.test(l.url)));
  ok('Cal.com skipped and named', /^skipped: CALCOM_API_KEY/.test(manifest.vendors.calcom), manifest.vendors.calcom);
  ok('BoldSign __unset__ stub treated as not set', /^skipped/.test(manifest.vendors.boldsign));
  ok('no request sent to BoldSign or Cal.com', !log.some((l) => /boldsign|cal\.com/.test(l.url)));
  ok('optional /tools failure is not a required failure', manifest.summary.failed === 0 && manifest.summary.optionalFailed === 1,
    JSON.stringify(manifest.summary));
  const toolsRow = manifest.items.find((i) => i.path === 'bland/tools.json');
  ok('failed item error text is redacted too', toolsRow && toolsRow.error.indexOf(BLAND_KEY) === -1);
  const prods = files.find((f) => f.path === 'stripe/products.json');
  ok('Stripe pages merged into one file', prods && prods.data.data.map((x) => x.id).join() === 'prod_1,prod_2');
  ok('Stripe second page used starting_after', log.some((l) => /starting_after=prod_1/.test(l.url)));
  ok('manifest rows carry redaction counts', ver && manifest.items.find((i) => i.path === ver.path).redactions >= 2);
  ok('datePrefix is vendor-config/YYYY-MM-DD/', core.datePrefix(new Date('2026-10-04T23:00:00Z')) === 'vendor-config/2026-10-04/');

  // A required endpoint failing is counted.
  const log2 = [];
  const r2 = await core.collectVendorConfig({
    getSecret: (n) => (n === 'BLAND_API_KEY' ? 'org_wrongkey000000000000000000' : null),
    fetchImpl: fakeFetchFactory(log2),
  });
  ok('a rejected key counts as a required failure', r2.manifest.summary.failed >= 1, JSON.stringify(r2.manifest.summary));

  // ── 3. The scheduled function and the CLI are wired to the core ───────
  console.log('wiring');
  const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
  const fnSrc = codeOnly(fs.readFileSync(path.join(ROOT, 'functions', 'vendor-config-export.js'), 'utf8'));
  ok('scheduled function uses the heartbeat onSchedule', /require\('\.\/integrations\/heartbeat'\)/.test(fnSrc));
  for (const n of Object.values(core.VENDOR_SECRETS).concat(core.SCRUB_ONLY_SECRETS)) {
    ok('scheduled function binds ' + n, new RegExp('\\b' + n + '\\s*:').test(fnSrc));
  }
  ok('scheduled function passes its params as secrets', /secrets:\s*Object\.values\(PARAMS\)/.test(fnSrc));
  const idx = codeOnly(fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8'));
  ok('index.js exports the scheduled function', /require\('\.\/vendor-config-export'\)/.test(idx));
  const cli = codeOnly(fs.readFileSync(path.join(ROOT, 'scripts', 'export-vendor-config.js'), 'utf8'));
  ok('CLI never writes exports to local disk', !/writeFileSync|createWriteStream/.test(cli));
  ok('CLI reads keys from Secret Manager', /'secrets', 'versions', 'access', 'latest'/.test(cli));
  ok('CLI never logs a secret value', !/console\.(log|error)\([^)]*readSecret\(/.test(cli));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
