let autoRefreshTimer = null;

// Lazy-loaded Firebase Functions handle, same pattern as admin-manager.js's
// callable() helper — this page is a classic (non-module) script, so a
// dynamic import() picks up the default app already initialized by
// analytics-gate.js's module rather than re-initializing a second one.
async function callable(name) {
  if (!window._functions || !window._httpsCallable) {
    const mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
    window._functions = mod.getFunctions();
    window._httpsCallable = mod.httpsCallable;
  }
  return window._httpsCallable(window._functions, name);
}

// F-03: custom-claim gate, no email comparison. The previous check
// used string match on two hardcoded admin emails (`demo@nbdpro.com`
// and Joe's real address). That's a client-side gate trivially bypassed
// in DevTools AND it leaked Joe's admin email to anyone who fetched
// the script. Matches the pattern used by login.js / vault.html /
// project-codex.html.
window.addEventListener('auth-ready', async () => {
  const user = window._currentUser;
  if (!user) {
    document.body.innerHTML = '<div style="text-align:center; padding:100px; color:var(--red);">🚫 Sign in required</div>';
    return;
  }
  try {
    // `true` forces a refresh so a just-granted claim is picked up
    // immediately instead of waiting for the ID token's natural rollover.
    const result = await user.getIdTokenResult(true);
    if (result.claims.role !== 'admin') {
      document.body.innerHTML = '<div style="text-align:center; padding:100px; color:var(--red);">🚫 Admin access required</div>';
      return;
    }
  } catch (_e) {
    document.body.innerHTML = '<div style="text-align:center; padding:100px; color:var(--red);">🚫 Admin access required</div>';
    return;
  }

  loadAnalytics();

  // Auto-refresh every 60 seconds — halves steady-state callable load
  // against getAiUsageAnalytics's 90/hr rate limit vs. the old 30s cadence.
  autoRefreshTimer = setInterval(loadAnalytics, 60000);
});

async function loadAnalytics() {
  try {
    const getAiUsageAnalytics = await callable('getAiUsageAnalytics');
    const { data } = await getAiUsageAnalytics();

    // Update stats
    document.getElementById('requestsToday').textContent = data.today.requests.toLocaleString();
    document.getElementById('requestsLastHour').textContent = data.today.lastHour;
    document.getElementById('tokensToday').textContent = data.today.tokens.toLocaleString();
    document.getElementById('avgTokens').textContent = data.today.requests
      ? Math.round(data.today.tokens / data.today.requests) : 0;
    document.getElementById('costToday').textContent = `$${data.today.cost.toFixed(4)}`;
    document.getElementById('projectedCost').textContent = `$${(data.today.cost * 30).toFixed(2)}`;

    // errors/rateLimits have no real backing data yet — claudeProxy only
    // persists successful calls (failures go to Cloud Logging only). Show
    // that honestly rather than a fabricated number or a fake 100% rate.
    const successRateEl = document.getElementById('successRate');
    if (data.today.errors == null) {
      successRateEl.textContent = '—';
      successRateEl.className = 'stat-value';
    } else {
      const successRate = data.today.requests
        ? ((data.today.requests - data.today.errors) / data.today.requests * 100).toFixed(1)
        : '100.0';
      successRateEl.textContent = `${successRate}%`;
      successRateEl.className = 'stat-value ' + (successRate >= 99 ? 'green' : successRate >= 95 ? 'orange' : 'red');
    }
    document.getElementById('errorCount').textContent = data.today.errors ?? 'not tracked';
    document.getElementById('rateLimitCount').textContent = data.today.rateLimits ?? 'not tracked';

    // Render chart
    renderChart(data.hourly);

    // Render top users
    renderTopUsers(data.topUsers);

    // Render features
    renderFeatures(data.features);

    // Update timestamp
    const now = new Date();
    document.getElementById('lastRefresh').textContent = `Last refreshed ${now.toLocaleTimeString()} · trailing 24h`;

  } catch (error) {
    console.error('Analytics load error:', error);
    const el = document.getElementById('chartContainer');
    el.textContent = '';
    const box = document.createElement('div');
    box.className = 'error';
    box.textContent = 'Failed to load analytics: ' + (error && error.message ? error.message : 'unknown error');
    el.appendChild(box);
  }
}

function renderChart(hourlyData) {
  const container = document.getElementById('chartContainer');
  const max = Math.max(...hourlyData.map(d => d.requests));
  
  let html = '<div style="display:flex; align-items:flex-end; gap:8px; height:100%; padding:20px 0;">';
  
  hourlyData.forEach(d => {
    const reqs = Number(d.requests || 0);
    const hour = Number(d.hour || 0);
    const height = Math.max(0, Math.min(100, (reqs / max) * 100));
    html += `
      <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:8px;">
        <div style="font-size:11px; color:var(--text3); font-family:'Syne Mono',monospace;">${reqs}</div>
        <div style="
          width:100%;
          background:var(--blue);
          height:${height}%;
          border-radius:4px 4px 0 0;
          transition:all 0.3s var(--ease);
          opacity:0.7;
        " title="${reqs} requests at ${hour}:00"></div>
        <div style="font-size:10px; color:var(--text3);">${hour}</div>
      </div>
    `;
  });
  
  html += '</div>';
  container.innerHTML = html;
}

// Tiny HTML escaper used by every render* helper in this file. Admin pages
// are behind the custom-claim gate but authored data (user emails, feature
// names) is still escaped defence-in-depth.
function _analyticsEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderTopUsers(users) {
  const container = document.getElementById('topUsers');

  if (users.length === 0) {
    container.innerHTML = '<div style="color:var(--text3); font-size:14px;">No user data available</div>';
    return;
  }

  let html = '';
  users.forEach((user, i) => {
    const cost = Number(user.cost || 0).toFixed(4);
    const requests = Number(user.requests || 0);
    const tokens = Number(user.tokens || 0).toLocaleString();
    html += `
      <div class="user-item">
        <div class="user-rank">${i + 1}</div>
        <div class="user-info">
          <div class="user-email">${_analyticsEsc(user.email)}</div>
          <div class="user-meta">${requests} requests • ${_analyticsEsc(tokens)} tokens</div>
        </div>
        <div class="user-stats">
          <div class="user-stat">
            <div class="user-stat-val">$${_analyticsEsc(cost)}</div>
            <div class="user-stat-lbl">Cost</div>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function renderFeatures(features) {
  const container = document.getElementById('featureBreakdown');

  let html = '<div class="user-list">';

  Object.entries(features).forEach(([name, data]) => {
    const reqs = Number(data.requests || 0);
    const tokens = Number(data.tokens || 0).toLocaleString();
    const cost = Number(data.cost || 0).toFixed(4);
    html += `
      <div class="user-item">
        <div class="user-info">
          <div class="user-email">${_analyticsEsc(name)}</div>
          <div class="user-meta">${reqs} requests • ${_analyticsEsc(tokens)} tokens</div>
        </div>
        <div class="user-stats">
          <div class="user-stat">
            <div class="user-stat-val">$${_analyticsEsc(cost)}</div>
            <div class="user-stat-lbl">Cost</div>
          </div>
        </div>
      </div>
    `;
  });

  html += '</div>';
  container.innerHTML = html;
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
});

// Wire the refresh button that was previously an inline onclick=.
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.refresh-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (typeof window.loadAnalytics === 'function') window.loadAnalytics();
    });
  });
});
