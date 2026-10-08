/**
 * claude-proxy.js — Secure Claude API proxy for NBD Pro
 *
 * Routes Claude API calls through Firebase Cloud Function when deployed.
 * Falls back to direct browser call (with localStorage key) when function isn't available.
 *
 * Usage (drop-in replacement for direct fetch):
 *   const result = await callClaude({
 *     model: 'claude-haiku-4-5-20251001',
 *     max_tokens: 1000,
 *     messages: [{ role: 'user', content: 'Hello' }]
 *   });
 *   // result = { content: [...], usage: {...} }
 */

// Emulator switch (same Audit #3 rule as nbd-comms.js): hardcoded prod here
// meant a local/emulator test of any Claude proxy call CORS-failed against
// prod's CORS_ORIGINS allowlist before reaching the local function.
const CLOUD_FUNCTION_URL = (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(
  (typeof location !== 'undefined' && location.hostname) || ''
)
  ? 'http://127.0.0.1:5001/nobigdeal-pro/us-central1'
  : 'https://us-central1-nobigdeal-pro.cloudfunctions.net') + '/claudeProxy';
const LOCAL_KEY_STORE = 'nbd_joe_key';

// Track whether Cloud Function is available (avoids repeated timeout on every call)
let _proxyAvailable = null; // null = unknown, true/false = tested
let _proxyLastCheck = 0;
const PROXY_CHECK_INTERVAL = 300000; // Re-check every 5 minutes

// Reset the proxy-availability cache when the browser reports network
// connectivity restored. Without this, a single transient blip during
// a Cloud Function call put the proxy into "unavailable" mode for the
// next 5 minutes, even after the network came back — every Claude
// call hit the local-fallback path or threw "Claude proxy unavailable"
// for nearly five minutes after the user reconnected.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('online', () => {
    _proxyAvailable = null;
    _proxyLastCheck = 0;
  });
  // Also expose a manual reset for the diagnostic UI / future
  // /pro/diagnostic.html page to call.
  window.resetClaudeProxyCheck = function () {
    _proxyAvailable = null;
    _proxyLastCheck = 0;
  };
}

/**
 * Call Claude API — secure proxy with fallback
 *
 * @param {object} params — { model, max_tokens, messages, system, temperature }
 * @returns {Promise<object>} — Anthropic API response
 */
async function callClaude(params) {
  // C6: auto-attach leadId + feature from the current UI context
  // when the caller didn't supply them. Heuristics:
  //   - If a lead detail modal is open → window._cardDetailLeadId
  //   - If the V2 Builder's customer has a leadId → that
  //   - feature defaults to the active view id from goTo()
  params = Object.assign({}, params);
  if (!params.leadId) {
    params.leadId = window._cardDetailLeadId
      || (window.EstimateV2UI
        && window.EstimateV2UI.getState && window.EstimateV2UI.getState().customer
        && window.EstimateV2UI.getState().customer.leadId)
      || null;
  }
  if (!params.feature) {
    const active = document.querySelector && document.querySelector('.view.active');
    params.feature = active ? (active.id || '').replace(/^view-/, '') : null;
  }
  let result;
  let proxyError = null;
  // Try Cloud Function first (if available or unknown)
  if (_proxyAvailable !== false || Date.now() - _proxyLastCheck > PROXY_CHECK_INTERVAL) {
    try {
      result = await _callViaProxy(params);
      _proxyAvailable = true;
      _proxyLastCheck = Date.now();
    } catch (e) {
      proxyError = e;
      _proxyAvailable = false;
      _proxyLastCheck = Date.now();
    }
  }

  // Fallback: direct browser call with localStorage key.
  // SECURITY: the direct path exposes the user's sk-ant key to the network tab
  // and to any XSS on the page. Disabled by default — users who need it in a
  // dev/local context can opt in with `window.NBD_ALLOW_DIRECT_ANTHROPIC = true`.
  if (!result) {
    if (window.NBD_ALLOW_DIRECT_ANTHROPIC === true) {
      result = await _callDirect(params);
    } else {
      throw new Error(
        // Server messages already end in '.', which read ".." before this.
        'Claude proxy unavailable' + (proxyError ? (': ' + String(proxyError.message || '').replace(/[.\s]+$/, '')) : '') +
        '. Direct browser calls are disabled for key safety.'
      );
    }
  }

  // Track usage for the analytics page
  _trackUsage(result, params.model);
  return result;
}

// ── Usage tracking → localStorage → AI Usage analytics page ──
// Pricing per million tokens (Haiku 4.5 defaults, adjust if model changes)
const _MODEL_PRICING = {
  'claude-haiku-4-5-20251001':  { input: 1.00, output: 5.00 },
  'claude-sonnet-4-20250514':   { input: 3.00, output: 15.00 },
  'claude-sonnet-5-5':          { input: 2.00, output: 10.00 },
  'claude-opus-4-20250514':     { input: 15.00, output: 75.00 },
};
function _trackUsage(response, model) {
  try {
    if (!response?.usage) return;
    const inp = response.usage.input_tokens || 0;
    const out = response.usage.output_tokens || 0;
    const total = inp + out;
    const pricing = _MODEL_PRICING[model] || _MODEL_PRICING['claude-haiku-4-5-20251001'];
    const cost = (inp / 1e6) * pricing.input + (out / 1e6) * pricing.output;

    const now = new Date();
    const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const raw = localStorage.getItem('nbd_ai_usage') || '{}';
    const usage = JSON.parse(raw);
    if (!usage[monthKey]) usage[monthKey] = { calls: 0, tokens: 0, cost: 0 };
    usage[monthKey].calls += 1;
    usage[monthKey].tokens += total;
    usage[monthKey].cost = Math.round((usage[monthKey].cost + cost) * 10000) / 10000;
    localStorage.setItem('nbd_ai_usage', JSON.stringify(usage));
  } catch (_) { /* non-critical — never break the API call */ }
}

/**
 * Call via Firebase Cloud Function (secure — key is server-side)
 */
async function _callViaProxy(params) {
  // Get Firebase auth token
  const user = window._auth?.currentUser || window.auth?.currentUser;
  if (!user) throw new Error('Not authenticated');

  const idToken = await user.getIdToken();

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${idToken}`,
  };
  // claudeProxy declares enforceAppCheck:true — attach token when available
  // (window.__NBD_APP_CHECK set by dashboard/nbd-auth/customer bootstrap).
  try {
    const ac = window.__NBD_APP_CHECK;
    if (ac) {
      const mod = await import('/assets/vendor/firebase/10.12.2/firebase-app-check.js');
      if (mod && typeof mod.getToken === 'function') {
        const tok = await mod.getToken(ac, false);
        if (tok && tok.token) headers['X-Firebase-AppCheck'] = tok.token;
      }
    }
  } catch (_) { /* best-effort; missing token surfaces as 401 from the proxy */ }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    const response = await fetch(CLOUD_FUNCTION_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    return await response.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

/**
 * Call Anthropic API directly from browser (fallback — key in localStorage)
 */
async function _callDirect(params) {
  // Prefer sessionStorage (xss-narrower); migrate any legacy localStorage value once.
  let apiKey = '';
  try {
    apiKey = sessionStorage.getItem(LOCAL_KEY_STORE) || '';
    if (!apiKey) {
      const legacy = localStorage.getItem(LOCAL_KEY_STORE);
      if (legacy) {
        sessionStorage.setItem(LOCAL_KEY_STORE, legacy);
        localStorage.removeItem(LOCAL_KEY_STORE);
        apiKey = legacy;
      }
    }
  } catch(e) {}
  if (!apiKey || !apiKey.startsWith('sk-ant')) {
    throw new Error('No API key configured. Add your Anthropic key in Settings → Ask Joe AI.');
  }

  const body = {
    model: params.model || 'claude-haiku-4-5-20251001',
    max_tokens: params.max_tokens || 1000,
    messages: params.messages,
  };
  if (params.system) body.system = params.system;
  if (params.temperature !== undefined) body.temperature = params.temperature;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-allow-browser': 'true',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${response.status}`);
  }

  return await response.json();
}

/**
 * Check if secure proxy is available
 */
function isProxyAvailable() {
  return _proxyAvailable === true;
}

/**
 * Force re-check proxy availability on next call
 */
function resetProxyCheck() {
  _proxyAvailable = null;
  _proxyLastCheck = 0;
}

// Expose globally
window.callClaude = callClaude;
window.resetClaudeProxyCheck = resetProxyCheck;

// Load marker removed — no console spam in production. The direct-browser
// fallback is disabled by default now; see callClaude() for the opt-in.
