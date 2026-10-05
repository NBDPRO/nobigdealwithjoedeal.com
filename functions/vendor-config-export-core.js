/**
 * functions/vendor-config-export-core.js — pull the config that lives ONLY at a
 * vendor (Bland "Thursday", Cal.com, BoldSign, Stripe catalog) into JSON, with
 * every token-looking string scrubbed, ready to upload to the PRIVATE bucket
 * gs://nobigdeal-pro-vendor-backups/vendor-config/YYYY-MM-DD/.
 *
 * Why: documentation/audit/VENDOR-COST-LOCKIN-2026-10-04.md §4 / Lane B. The
 * Thursday agent, pathway, persona and number config existed only at Bland,
 * with the one backup in %TEMP% on Jo's PC.
 *
 * Zero dependencies on purpose: the CLI (scripts/export-vendor-config.js) and
 * the weekly scheduled function (functions/vendor-config-export.js) both drive
 * this file, and tests/vendor-config-export.test.js loads it with a fake fetch.
 *
 * NEVER write the output anywhere public. The repo and docs/ are public. The
 * output holds the Thursday prompt and pathway, which are Jo's IP.
 *
 * Restore: documentation/runbooks/BACKUP-RESTORE.md.
 */
'use strict';

const REDACTED = '[REDACTED]';

// Key names whose STRING values are credentials. Numbers (max_tokens) and
// booleans are left alone; only strings of 8+ chars are replaced.
const SECRET_KEY_RE = /(secret|token|passw|api[_-]?key|apikey|authorization|bearer|credential|private[_-]?key|signing[_-]?key)/i;
// Key names that match the pattern above but are not credentials.
const SAFE_KEY_RE = /^(max_tokens|token_count|tokens|max_token|tokenizer|token_limit)$/i;

// Value shapes that are credentials wherever they appear (inside prompts,
// code nodes, URLs, headers). Each entry: [regex, replacement].
const VALUE_PATTERNS = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 ' + REDACTED],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g, REDACTED],          // Stripe keys
  [/\bwhsec_[A-Za-z0-9+/=]{10,}/g, REDACTED],                          // Stripe/Svix webhook secrets
  [/\bcal_(live|test)_[A-Za-z0-9]{10,}/g, REDACTED],                   // Cal.com
  [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/g, REDACTED],                 // Resend
  [/\bsk-(ant-)?[A-Za-z0-9_-]{20,}/g, REDACTED],                        // Anthropic / OpenAI style
  [/\b(org|gsk|xai)_[A-Za-z0-9]{20,}/g, REDACTED],                      // Bland org key, Groq, xAI
  [/\bxai-[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],                             // Google API key
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, REDACTED],                          // GitHub
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED], // JWT
  [/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g, 'hooks.slack.com/services/' + REDACTED],
  // ?token=… &key=… &signature=… in any URL
  [/([?&](?:token|key|api_key|apikey|access_token|auth|signature|sig|secret)=)[^&\s"'#]+/gi, '$1' + REDACTED],
];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Deep-copy `obj` with credentials replaced by "[REDACTED]".
 * knownSecrets: literal secret values (every key this run loaded, plus
 * THURSDAY_LOOKUP_TOKEN) scrubbed wherever they appear verbatim.
 * Returns { data, count } — count is the number of replacements (no values).
 */
function redactTokens(obj, knownSecrets) {
  const literals = (knownSecrets || [])
    .filter((s) => typeof s === 'string' && s.trim().length >= 8 && s !== '__unset__')
    .map((s) => new RegExp(escapeRe(s.trim()), 'g'));
  let count = 0;
  function scrubString(s) {
    let out = s;
    for (const re of literals) {
      out = out.replace(re, () => { count++; return REDACTED; });
    }
    for (const [re, rep] of VALUE_PATTERNS) {
      out = out.replace(re, function () {
        count++;
        // Expand $1/$2 the way String#replace would with a string replacement.
        const groups = Array.prototype.slice.call(arguments, 1, -2);
        return rep.replace(/\$(\d)/g, (_, n) => groups[n - 1] || '');
      });
    }
    return out;
  }
  function walk(v, key) {
    if (typeof v === 'string') {
      if (key && SECRET_KEY_RE.test(key) && !SAFE_KEY_RE.test(key) && v.length >= 8 && v !== REDACTED) {
        count++;
        return REDACTED;
      }
      return scrubString(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k], k);
      return o;
    }
    return v;
  }
  const data = walk(obj, null);
  return { data, count };
}

/** True when any known secret literal survives in `text` (a last-line guard). */
function containsKnownSecret(text, knownSecrets) {
  return (knownSecrets || []).some((s) => typeof s === 'string' && s.trim().length >= 8 &&
    s !== '__unset__' && text.indexOf(s.trim()) !== -1);
}

function safeSeg(s) { return String(s).replace(/[^A-Za-z0-9._+-]/g, '_').slice(0, 120); }
function listOf(j, keys) {
  if (Array.isArray(j)) return j;
  for (const k of keys || ['data']) if (j && Array.isArray(j[k])) return j[k];
  return [];
}

// The secret each vendor needs. Secret Manager names (same as the functions bind).
const VENDOR_SECRETS = {
  bland: 'BLAND_API_KEY',
  calcom: 'CALCOM_API_KEY',
  boldsign: 'BOLDSIGN_API_KEY',
  stripe: 'STRIPE_SECRET_KEY',
};
// Not used to call anything — loaded only so its literal is scrubbed (the
// Thursday pathway's lookup tool authenticates with it).
const SCRUB_ONLY_SECRETS = ['THURSDAY_LOOKUP_TOKEN'];

/**
 * Collect every vendor's config.
 *   getSecret(name) → string | null   (null/'' /'__unset__' = not configured)
 *   fetchImpl       → fetch-compatible
 * Returns { files: [{ path, data }], manifest } — already redacted.
 */
async function collectVendorConfig(opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || fetch;
  const getSecret = (n) => {
    let v = null;
    try { v = o.getSecret(n); } catch (e) { v = null; }
    v = typeof v === 'string' ? v.trim() : '';
    return v && v !== '__unset__' ? v : null;
  };
  const known = [];
  const keys = {};
  for (const [vendor, name] of Object.entries(VENDOR_SECRETS)) {
    keys[vendor] = getSecret(name);
    if (keys[vendor]) known.push(keys[vendor]);
  }
  for (const n of SCRUB_ONLY_SECRETS) { const v = getSecret(n); if (v) known.push(v); }

  const raw = [];          // { path, data }
  const items = [];        // manifest rows
  const vendors = {};

  // One GET. Never throws; { ok, status, json, error } with error pre-redacted.
  async function fetchJson(url, headers) {
    try {
      const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30000) });
      const text = await r.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
      if (!r.ok || json == null) {
        return { ok: false, status: r.status, error: redactTokens(String(text).slice(0, 200), known).data };
      }
      return { ok: true, status: r.status, json };
    } catch (e) {
      return { ok: false, status: 0, error: redactTokens(String(e && e.message || e).slice(0, 200), known).data };
    }
  }
  function record(vendor, path, res, optional, data) {
    const row = { vendor, path, ok: res.ok, optional: !!optional, status: res.status };
    if (!res.ok) row.error = res.error;
    items.push(row);
    if (res.ok) raw.push({ path, data: data !== undefined ? data : res.json });
  }
  async function get(vendor, path, url, headers, optional) {
    const res = await fetchJson(url, headers);
    record(vendor, path, res, optional);
    return res.ok ? res.json : null;
  }

  // ── Bland (Thursday) ────────────────────────────────────────────────
  if (keys.bland) {
    vendors.bland = 'exported';
    const h = { authorization: keys.bland };
    const v1 = 'https://api.bland.ai/v1';
    const v2 = 'https://api.bland.ai/v2';
    const agents = listOf(await get('bland', 'bland/agents.json', v2 + '/agents', h));
    for (const a of agents) {
      if (!a || !a.id) continue;
      const id = safeSeg(a.id);
      await get('bland', 'bland/agents/' + id + '.json', v2 + '/agents/' + encodeURIComponent(a.id), h);
      const versions = listOf(await get('bland', 'bland/agents/' + id + '/versions.json',
        v2 + '/agents/' + encodeURIComponent(a.id) + '/versions', h));
      for (const ver of versions) {
        // Only published versions have a semver; Bland's version endpoint
        // rejects autosave drafts (semver null) with 400 INVALID_VERSION.
        // Production and staging always point at a semver version.
        const sv = ver && ver.semver;
        if (!sv) continue;
        await get('bland', 'bland/agents/' + id + '/versions/' + safeSeg(sv) + '.json',
          v2 + '/agents/' + encodeURIComponent(a.id) + '/versions/' + encodeURIComponent(sv), h);
      }
    }
    const pathways = listOf(await get('bland', 'bland/pathways.json', v1 + '/pathway', h));
    for (const p of pathways) {
      if (!p || !p.id) continue;
      await get('bland', 'bland/pathways/' + safeSeg(p.id) + '.json', v1 + '/pathway/' + encodeURIComponent(p.id), h);
    }
    const numbers = listOf(await get('bland', 'bland/inbound-numbers.json', v1 + '/inbound', h), ['inbound_numbers', 'data']);
    for (const n of numbers) {
      if (!n || !n.phone_number) continue;
      await get('bland', 'bland/inbound/' + safeSeg(n.phone_number) + '.json',
        v1 + '/inbound/' + encodeURIComponent(n.phone_number), h);
    }
    await get('bland', 'bland/personas.json', v1 + '/personas', h);
    await get('bland', 'bland/tools.json', v1 + '/tools', h, true);
    await get('bland', 'bland/knowledgebases.json', v1 + '/knowledgebases', h, true);
  } else {
    vendors.bland = 'skipped: BLAND_API_KEY not set';
  }

  // ── Cal.com (event types, schedules, webhooks) ──────────────────────
  if (keys.calcom) {
    vendors.calcom = 'exported';
    const base = 'https://api.cal.com/v2';
    const auth = { authorization: 'Bearer ' + keys.calcom };
    await get('calcom', 'calcom/event-types.json', base + '/event-types',
      Object.assign({ 'cal-api-version': '2024-06-14' }, auth));
    await get('calcom', 'calcom/schedules.json', base + '/schedules',
      Object.assign({ 'cal-api-version': '2024-06-11' }, auth), true);
    await get('calcom', 'calcom/webhooks.json', base + '/webhooks', auth, true);
  } else {
    vendors.calcom = 'skipped: CALCOM_API_KEY not set (create a Cal.com API key and store it in Secret Manager)';
  }

  // ── BoldSign (templates) ────────────────────────────────────────────
  if (keys.boldsign) {
    vendors.boldsign = 'exported';
    await get('boldsign', 'boldsign/templates.json',
      'https://api.boldsign.com/v1/template/list?PageSize=100&Page=1', { 'X-API-KEY': keys.boldsign });
  } else {
    vendors.boldsign = 'skipped: BOLDSIGN_API_KEY not set';
  }

  // ── Stripe catalog config (not customer data) ───────────────────────
  if (keys.stripe) {
    vendors.stripe = 'exported';
    const h = { authorization: 'Bearer ' + keys.stripe };
    const lists = {
      'stripe/products.json': '/products',
      'stripe/prices.json': '/prices',
      'stripe/webhook-endpoints.json': '/webhook_endpoints',
      'stripe/billing-portal-configurations.json': '/billing_portal/configurations',
      'stripe/coupons.json': '/coupons',
    };
    for (const [path, ep] of Object.entries(lists)) {
      // Paginate (100 per page, at most 10 pages) into one file.
      const all = [];
      let after = null;
      let res = null;
      for (let page = 0; page < 10; page++) {
        const qs = '?limit=100' + (after ? '&starting_after=' + encodeURIComponent(after) : '');
        res = await fetchJson('https://api.stripe.com/v1' + ep + qs, h);
        if (!res.ok) break;
        const data = listOf(res.json);
        all.push.apply(all, data);
        if (!res.json.has_more || !data.length) break;
        after = data[data.length - 1].id;
      }
      record('stripe', path, res, false, { object: 'list', data: all });
    }
  } else {
    vendors.stripe = 'skipped: STRIPE_SECRET_KEY not set';
  }

  // ── Redact everything, then assert no known literal survived ────────
  const files = [];
  for (const f of raw) {
    const { data, count } = redactTokens(f.data, known);
    const text = JSON.stringify(data);
    if (containsKnownSecret(text, known)) {
      throw new Error('vendor-config-export: a secret survived redaction in ' + f.path + ' — refusing to upload');
    }
    files.push({ path: f.path, data });
    const row = items.find((i) => i.path === f.path);
    if (row) { row.redactions = count; row.bytes = Buffer.byteLength(text); }
  }
  const failed = items.filter((i) => !i.ok && !i.optional).length;
  const manifest = {
    exportedAt: (o.now || new Date()).toISOString(),
    vendors,
    summary: { files: files.length, failed, optionalFailed: items.filter((i) => !i.ok && i.optional).length },
    items,
  };
  if (containsKnownSecret(JSON.stringify(manifest), known)) {
    throw new Error('vendor-config-export: a secret reached the manifest — refusing to upload');
  }
  return { files, manifest };
}

function datePrefix(now) {
  return 'vendor-config/' + (now || new Date()).toISOString().slice(0, 10) + '/';
}

const BUCKET_SUFFIX = '-vendor-backups';

module.exports = {
  REDACTED,
  VENDOR_SECRETS,
  SCRUB_ONLY_SECRETS,
  BUCKET_SUFFIX,
  redactTokens,
  containsKnownSecret,
  collectVendorConfig,
  datePrefix,
};
