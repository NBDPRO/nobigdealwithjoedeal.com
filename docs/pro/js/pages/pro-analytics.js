/**
 * NBD Pro — /pro/analytics.html controller.
 *
 * Extracted from the inline <script type="module"> so strict CSP can drop
 * 'unsafe-inline' on this page. Event handlers are wired via
 * addEventListener instead of inline onclick=.
 *
 * NOTE: The original file assigned `setRange`, `bootAnalytics`, `loadData`
 * to `window` so inline handlers could find them. `setRange` and `loadData`
 * keep those assignments so any residual inline references elsewhere still
 * work, but this page now binds its own DOM events via addEventListener at
 * the bottom of the file. `bootAnalytics` is off window (Globals Tranche 3,
 * T3-C) — pro-analytics-gate.js reads it from __NBD_CALL_REGISTRY.
 */
import { getFirestore, collection, query, where, orderBy, getDocs, Timestamp } from '/assets/vendor/firebase/10.12.2/firebase-firestore.js';

// Anthropic's published base rates per 1M tokens (claude.com/pricing, checked
// 2026-09-30). Haiku 4.5 is $1/$5 — the page priced it at Haiku 3.5's
// $0.80/$4, so every cost read ~20% low (nearly all usage is Haiku 4.5).
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 1,  output: 5 },
  'claude-sonnet-4-20250514':  { input: 3,  output: 15 },
  'claude-sonnet-4-6':         { input: 3,  output: 15 },
  'claude-opus-4-6':           { input: 5,  output: 25 },
  // Any other model: an estimate at Sonnet rates.
  'default':                   { input: 3,  output: 15 }
};

let range = 'today';
let allDocs = [];
let autoTimer = null;

function getRangeStart(r) {
  const now = new Date();
  if (r === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (r === '7d') return new Date(now.getTime() - 7 * 86400000);
  if (r === '30d') return new Date(now.getTime() - 30 * 86400000);
  return new Date(2020, 0, 1); // all time
}

function costForDoc(d) {
  const p = PRICING[d.model] || PRICING['default'];
  return ((d.inputTokens || 0) * p.input + (d.outputTokens || 0) * p.output) / 1e6;
}

window.setRange = function(r, btn) {
  range = r;
  document.querySelectorAll('.tt').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  render();
};

// Off window (Globals Tranche 3, T3-C): the one caller is pro-analytics-gate.js's
// NBDAuth onReady, which resolves it through __NBD_CALL_REGISTRY. Registered
// right here, not at file end, so the entry exists at the same point in module
// evaluation the old window assignment did. First registry use on
// analytics.html, so the guard creates it.
async function bootAnalytics() {
  await loadData();
  autoTimer = setInterval(loadData, 60000);
}
window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
window.__NBD_CALL_REGISTRY.bootAnalytics = bootAnalytics;

window.loadData = async function() {
  const btn = document.getElementById('refreshBtn');
  btn.textContent = '⏳ Loading…'; btn.disabled = true;

  try {
    const db = window._db;
    if (!db) { btn.textContent = '↻ Refresh'; btn.disabled = false; renderEmpty(); return; }

    // Query all api_usage docs for current user. The old unfiltered
    // fallback (no uid) was guaranteed to permission-deny for non-admins —
    // the rule only allows reads of your OWN uid's docs — so during the
    // auth-not-resolved race we now render empty and let the 60s
    // auto-refresh retry once auth settles, instead of throwing.
    const uid = window._user?.uid || window.auth?.currentUser?.uid || null;
    if (!uid) { btn.textContent = '↻ Refresh'; btn.disabled = false; renderEmpty(); return; }
    const q = query(collection(db, 'api_usage'), where('uid', '==', uid), orderBy('timestamp', 'desc'));

    const snap = await getDocs(q);
    allDocs = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (d.timestamp) {
        allDocs.push({
          ...d,
          ts: d.timestamp.toDate ? d.timestamp.toDate() : new Date(d.timestamp)
        });
      }
    });

    render();
    document.getElementById('lastRefresh').textContent = 'Updated ' + new Date().toLocaleTimeString();
    showToast('✓ Analytics refreshed · ' + allDocs.length + ' records', 'success');
  } catch(e) {
    console.error('Analytics load error:', e);
    if (e.message?.includes('index')) {
      showToast('⚠ Firestore index needed — check console', 'warning');
    } else {
      showToast('⚠ ' + e.message, 'error');
    }
    renderEmpty();
  } finally {
    btn.textContent = '↻ Refresh'; btn.disabled = false;
  }
};

function render() {
  const start = getRangeStart(range);
  const docs = allDocs.filter(d => d.ts >= start);
  const labels = { today: 'Today', '7d': 'Last 7 Days', '30d': 'Last 30 Days', all: 'All Time' };
  const label = labels[range];

  // Stats
  const totalReq = docs.length;
  const totalInput = docs.reduce((s, d) => s + (d.inputTokens || 0), 0);
  const totalOutput = docs.reduce((s, d) => s + (d.outputTokens || 0), 0);
  const totalTokens = totalInput + totalOutput;
  const totalCost = docs.reduce((s, d) => s + costForDoc(d), 0);
  const avgTokens = totalReq > 0 ? Math.round(totalTokens / totalReq) : 0;

  document.getElementById('lReq').textContent = 'Requests · ' + label;
  document.getElementById('vReq').textContent = totalReq.toLocaleString();
  document.getElementById('mReq').textContent = totalReq > 0 ? (range === 'today' ? 'Since midnight' : docs.length + ' total records') : 'No requests yet';

  document.getElementById('lTok').textContent = 'Tokens · ' + label;
  document.getElementById('vTok').textContent = totalTokens > 1e6 ? (totalTokens / 1e6).toFixed(2) + 'M' : totalTokens.toLocaleString();
  document.getElementById('mTok').textContent = 'Input: ' + totalInput.toLocaleString() + ' · Output: ' + totalOutput.toLocaleString();

  document.getElementById('lCost').textContent = 'Cost · ' + label;
  document.getElementById('vCost').textContent = totalCost < 1 ? '$' + totalCost.toFixed(4) : '$' + totalCost.toFixed(2);
  // "Today × 30" swung from tiny at 9 am to huge after a busy evening: project
  // Today from the last 7 days' daily average instead.
  const week = allDocs.filter(d => d.ts >= getRangeStart('7d'));
  const weekCost = week.reduce((s, d) => s + costForDoc(d), 0);
  const projected = (range === 'today' || range === '7d') ? (weekCost / 7) * 30 : totalCost;
  document.getElementById('mCost').textContent = range !== 'all' ? 'Projected 30d: $' + projected.toFixed(2) : 'Lifetime total';

  document.getElementById('vAvg').textContent = avgTokens.toLocaleString();
  document.getElementById('mAvg').textContent = totalReq > 0 ? 'In: ' + Math.round(totalInput / totalReq) + ' · Out: ' + Math.round(totalOutput / totalReq) : '—';

  // Chart
  renderChart(docs);

  // Features
  renderFeatures(docs);

  // Models
  renderModels(docs);

  // Cost breakdown
  renderCostBreakdown(docs, totalCost);
}

function renderChart(docs) {
  const el = document.getElementById('chart');
  if (!docs.length) { el.innerHTML = '<div class="empty"><div class="empty-icon">📈</div><div class="empty-title">No Data Yet</div><div class="empty-desc">API requests will appear here once the proxy is in use.</div></div>'; return; }

  // Continuous, oldest → newest: every hour / day / month in the range gets a
  // bar, so quiet stretches show as gaps instead of vanishing. (Bars used to
  // follow the query's newest-first order — time ran right to left.)
  const entries = chartBuckets(docs, range, new Date());
  const max = Math.max(...entries.map(e => e[1]), 1);
  // A phone fits ~8 readable labels; show every Nth, the rest blank.
  const every = Math.max(1, Math.ceil(entries.length / (el.clientWidth && el.clientWidth < 600 ? 7 : 16)));

  el.innerHTML = entries.map(([label, count], i) => {
    const pct = (count / max * 100);
    const shown = (i % every === 0 || i === entries.length - 1) ? label : '';
    return `<div class="chart-bar-wrap"><div class="chart-val">${count || ''}</div><div style="flex:1;display:flex;align-items:flex-end;width:100%"><div class="chart-bar" style="height:${pct}%;background:var(--blue);opacity:.7;width:100%" title="${count} requests · ${label}"></div></div><div class="chart-label">${shown}</div></div>`;
  }).join('');
}

/** [[label, count], …] oldest → newest, one per hour (today) / day (7d, 30d) /
 *  month (all), including empty ones. Exported for the unit test. */
function chartBuckets(docs, r, now) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const keys = [];
  const keyOf = (t) => r === 'today' ? t.getHours() + ':00'
    : r === 'all' ? months[t.getMonth()] + ' ' + t.getFullYear()
    : (t.getMonth() + 1) + '/' + t.getDate();
  if (r === 'today') {
    for (let h = 0; h <= now.getHours(); h++) keys.push(h + ':00');
  } else if (r === '7d' || r === '30d') {
    const n = r === '7d' ? 7 : 30;
    for (let i = n - 1; i >= 0; i--) { const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i); keys.push(keyOf(t)); }
  } else {
    const first = docs.reduce((m, d) => (d.ts < m ? d.ts : m), now);
    for (let t = new Date(first.getFullYear(), first.getMonth(), 1); t <= now; t = new Date(t.getFullYear(), t.getMonth() + 1, 1)) keys.push(keyOf(t));
  }
  const counts = Object.fromEntries(keys.map((k) => [k, 0]));
  docs.forEach((d) => { const k = keyOf(d.ts); if (k in counts) counts[k]++; });
  return keys.map((k) => [k, counts[k]]);
}
window.__NBD_ANALYTICS_TEST = { chartBuckets, costForDoc, PRICING };

function renderFeatures(docs) {
  const el = document.getElementById('featureBody');
  // Group by feature (extracted from model or context — we'll use model as proxy)
  const features = {};
  docs.forEach(d => {
    const feat = d.feature || d.model || 'unknown';
    if (!features[feat]) features[feat] = { requests: 0, tokens: 0, cost: 0 };
    features[feat].requests++;
    features[feat].tokens += (d.inputTokens || 0) + (d.outputTokens || 0);
    features[feat].cost += costForDoc(d);
  });

  const sorted = Object.entries(features).sort((a, b) => b[1].requests - a[1].requests);
  if (!sorted.length) { el.innerHTML = '<div class="empty"><div class="empty-desc">No feature data yet</div></div>'; return; }

  const icons = { 'ask-joe': '🤖', 'vault-analyzer': '🔐', 'property-intel': '🏠', 'comparison': '⚖️', 'tenx': '🔭' };

  el.innerHTML = '<table class="tbl"><thead><tr><th>Feature</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>' +
    sorted.map(([name, d]) => `<tr><td><span class="feature-icon">${icons[name] || '⚡'}</span><span class="feature-name">${name}</span></td><td>${d.requests.toLocaleString()}</td><td>${d.tokens.toLocaleString()}</td><td class="cost-cell green">$${d.cost.toFixed(4)}</td></tr>`).join('') +
    '</tbody></table>';
}

function renderModels(docs) {
  const el = document.getElementById('modelBody');
  const models = {};
  docs.forEach(d => {
    const m = d.model || 'unknown';
    if (!models[m]) models[m] = { requests: 0, input: 0, output: 0, cost: 0 };
    models[m].requests++;
    models[m].input += d.inputTokens || 0;
    models[m].output += d.outputTokens || 0;
    models[m].cost += costForDoc(d);
  });

  const sorted = Object.entries(models).sort((a, b) => b[1].cost - a[1].cost);
  if (!sorted.length) { el.innerHTML = '<div class="empty"><div class="empty-desc">No model data yet</div></div>'; return; }

  const colors = { 'claude-opus-4-6': 'var(--blue)', 'claude-sonnet-4-6': 'var(--orange)', 'claude-haiku-4-5-20251001': 'var(--green)' };

  el.innerHTML = '<table class="tbl"><thead><tr><th>Model</th><th>Calls</th><th>Input</th><th>Output</th><th>Cost</th></tr></thead><tbody>' +
    sorted.map(([name, d]) => {
      const color = colors[name] || 'var(--text2)';
      const shortName = name.replace('claude-','').replace('-20251001','');
      return `<tr><td><span style="color:${color};font-weight:600">${shortName}</span></td><td>${d.requests}</td><td>${d.input.toLocaleString()}</td><td>${d.output.toLocaleString()}</td><td class="cost-cell" style="color:${color}">$${d.cost.toFixed(4)}</td></tr>`;
    }).join('') +
    '</tbody></table>';
}

function renderCostBreakdown(docs, totalCost) {
  const el = document.getElementById('costBreakdown');
  const bar = document.getElementById('costBar');

  if (!docs.length || totalCost === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-desc">No cost data yet</div></div>';
    bar.innerHTML = '';
    return;
  }

  // Split by input vs output
  const totalInput = docs.reduce((s, d) => {
    const p = PRICING[d.model] || PRICING['default'];
    return s + ((d.inputTokens || 0) * p.input / 1e6);
  }, 0);
  const totalOutput = totalCost - totalInput;
  const inputPct = (totalInput / totalCost * 100).toFixed(1);
  const outputPct = (100 - parseFloat(inputPct)).toFixed(1);

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap">
      <div><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--blue);margin-right:8px"></span><span style="font-size:13px;color:var(--text2)">Input tokens</span><div style="font-family:'Barlow Condensed',sans-serif;font-size:28px;color:var(--blue);margin-top:4px">$${totalInput.toFixed(4)}</div><div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--text3)">${inputPct}% of total</div></div>
      <div><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--orange);margin-right:8px"></span><span style="font-size:13px;color:var(--text2)">Output tokens</span><div style="font-family:'Barlow Condensed',sans-serif;font-size:28px;color:var(--orange);margin-top:4px">$${totalOutput.toFixed(4)}</div><div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--text3)">${outputPct}% of total</div></div>
      <div><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--green);margin-right:8px"></span><span style="font-size:13px;color:var(--text2)">Total cost</span><div style="font-family:'Barlow Condensed',sans-serif;font-size:28px;color:var(--green);margin-top:4px">$${totalCost.toFixed(4)}</div><div style="font-family:'DM Mono',monospace;font-size:10px;color:var(--text3)">${docs.length} requests</div></div>
    </div>
  `;

  bar.innerHTML = `<div class="cost-seg" style="width:${inputPct}%;background:var(--blue)"></div><div class="cost-seg" style="width:${outputPct}%;background:var(--orange)"></div>`;
}

function renderEmpty() {
  document.getElementById('vReq').textContent = '0';
  document.getElementById('vTok').textContent = '0';
  document.getElementById('vCost').textContent = '$0.00';
  document.getElementById('vAvg').textContent = '0';
  document.getElementById('chart').innerHTML = '<div class="empty"><div class="empty-icon">📈</div><div class="empty-title">No Data Yet</div><div class="empty-desc">API requests will appear here once the Cloud Function proxy is deployed and in use.<br><br>Deploy with: <code style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:var(--orange)">firebase deploy --only functions</code></div></div>';
}

// 2026-07-19 consolidation: delegates to the shared /pro/js/toast.js module
// (dashboard contract, loaded by analytics.html before this script). The old
// local builder ignored type entirely; it now passes through
// (success/error/warning/info, default info).
function showToast(msg, type) {
  window.showToast(msg, type);
}

// Cleanup
window.addEventListener('beforeunload', () => { if (autoTimer) clearInterval(autoTimer); });

// ─────────────────────────────────────────────────
// Wire DOM events in place of inline onclick= handlers.
// ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-range]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (typeof window.setRange === 'function') window.setRange(btn.dataset.range, btn);
    });
  });
  const refresh = document.getElementById('refreshBtn');
  if (refresh) refresh.addEventListener('click', () => {
    if (typeof window.loadData === 'function') window.loadData();
  });
});
