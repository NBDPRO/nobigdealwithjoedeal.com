import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { connectEmulatorsIfLocal } from '../nbd-emulator-connect.js'; // Audit #3: localhost-only, no-op in prod

const firebaseConfig = {
  apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain: "nobigdeal-pro.firebaseapp.com",
  projectId: "nobigdeal-pro",
  storageBucket: "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId: "1:717435841570:web:c2338e11052c96fde02e7b"
};

// Escape user-controlled text (rep/member names — set from profile firstName/lastName,
// so a teammate's name is peer-controlled) before innerHTML interpolation on the board.
const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
await connectEmulatorsIfLocal({ auth, db }); // Audit #3: localhost-only, no-op in prod

// ── Stage classification ──
// Kept in step with crm-stages ROLE 'won' (this standalone page doesn't load
// it): collections + warranty_claim were missing, so those jobs fell out of
// "deals closed".
const WON_STAGES = ['closed','install_complete','final_photos','final_payment','deductible_collected','collections','warranty_claim','Complete'];

// ── State ──
let currentTab = 'doors';
let currentPeriod = 'all';
let currentUser = null;
let rawData = { leads: [], knocks: [], invoices: [] };

// ── Helpers ──
function toDate(v) {
  if (!v) return null;
  if (v.toDate) return v.toDate();
  if (v.seconds) return new Date(v.seconds * 1000);
  if (typeof v === 'string' || typeof v === 'number') return new Date(v);
  if (v instanceof Date) return v;
  return null;
}

function periodStart(p) {
  const now = new Date();
  if (p === 'day') { const d = new Date(now); d.setHours(0,0,0,0); return d; }
  // Weeks start MONDAY (Jo 2026-06-25 — the game card, trends and roof-rep do).
  if (p === 'week') { const d = new Date(now); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(0,0,0,0); return d; }
  if (p === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  return new Date(2020, 0, 1);
}

function isInPeriod(dateVal) {
  const d = toDate(dateVal);
  if (!d) return currentPeriod === 'all';
  return d >= periodStart(currentPeriod);
}

function initials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function fmtCurrency(n) {
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
  return '$' + Math.round(n).toLocaleString();
}

function relativeTime(d) {
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 7) return days + 'd ago';
  return d.toLocaleDateString();
}

// ── Data loading ──
async function loadData() {
  const uid = currentUser?.uid;
  if (!uid) return;

  try {
    const [leadsSnap, knocksSnap, invoicesSnap] = await Promise.all([
      getDocs(query(collection(db, 'leads'), where('userId', '==', uid))),
      getDocs(query(collection(db, 'knocks'), where('userId', '==', uid))),
      getDocs(query(collection(db, 'invoices'), where('createdBy', '==', uid)))
    ]);

    rawData.leads = leadsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(l => !l.deleted);
    rawData.knocks = knocksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    rawData.invoices = invoicesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('Leaderboard data load error:', e);
  }

  renderAll();
}

// Per-payment cash ledger (mirrors money-dashboard.js/analytics-kpi.js
// paymentsOf, inlined dependency-free per house style; guarded by
// tests/money-field-contract.test.js). Prefer inv.payments[] so each credit
// lands in its own period; legacy docs fall back to a total−balanceDue lump
// dated lastPaymentAt||paidAt. TRANSITION RECONCILIATION: when the ledger
// sums short of total−balanceDue (pre-ledger partial), append a synthetic
// remainder dated at the EARLIEST ledger entry so totals stay exact.
function paymentsOnlyOf(inv) {
  const collected = Math.max(0,
    (parseFloat(inv.total) || 0)
    - ((inv.balanceDue != null) ? (parseFloat(inv.balanceDue) || 0) : 0));
  if (Array.isArray(inv.payments) && inv.payments.length > 0) {
    const out = [];
    let ledgerCents = 0;
    let earliestAt = null, earliestMs = Infinity;
    for (let i = 0; i < inv.payments.length; i++) {
      const p = inv.payments[i] || {};
      const amt = parseFloat(p.amount);
      const at = p.at != null ? p.at : p.date;
      if (!(amt > 0) || at == null) continue;
      out.push({ amount: amt, at: at });
      ledgerCents += Math.round(amt * 100);
      const d = toDate(at);
      if (d && d.getTime() < earliestMs) { earliestMs = d.getTime(); earliestAt = at; }
    }
    if (out.length) {
      const remainderCents = Math.round(collected * 100) - ledgerCents;
      if (remainderCents >= 1) {
        const remAt = earliestAt != null ? earliestAt
          : (inv.lastPaymentAt != null ? inv.lastPaymentAt : inv.paidAt);
        if (remAt != null) out.push({ amount: remainderCents / 100, at: remAt, synthetic: true });
      }
      return out;
    }
  }
  if (collected <= 0) return [];
  const payDate = inv.lastPaymentAt != null ? inv.lastPaymentAt : inv.paidAt;
  if (payDate == null) return [];
  return [{ amount: collected, at: payDate }];
}

// Refunds (invoices.refunds[], recorded by the Stripe ledger) come off
// revenue on the day they happened — negative entries tagged refund:true.
// They never touch payments[] / amountPaid / balanceDue, so the
// remainder math in paymentsOnlyOf is unaffected. A failed or canceled
// refund, or a dispute Jo won, returned nothing. Same helper in all four
// revenue readers
// (collected-revenue.js, money-dashboard.js, analytics-kpi.js,
// pages/leaderboard.js) — tests/refunds-in-revenue-2026-09-29.test.js.
function refundsOf(inv) {
  const out = [];
  const list = Array.isArray(inv && inv.refunds) ? inv.refunds : [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] || {};
    const amt = parseFloat(r.amount);
    const at = r.at != null ? r.at : r.date;
    if (!(amt > 0) || at == null || r.status === 'failed' || r.status === 'canceled' || r.status === 'won') continue;
    out.push({ amount: -amt, at: at, refund: true });
  }
  return out;
}
function paymentsOf(inv) {
  return paymentsOnlyOf(inv).concat(refundsOf(inv));
}

// ── Compute metrics for the selected period ──
function computeMetrics() {
  const leads = rawData.leads.filter(l => isInPeriod(l.createdAt));
  const knocks = rawData.knocks.filter(k => isInPeriod(k.createdAt));
  // Kept for metrics consumers ("N paid" style displays); revenue no longer
  // gates on it — a deposit is real cash the rep collected this period even
  // while the invoice is still open, and gating on status==='paid' both hid
  // deposits until payoff AND then dumped the full total into the payoff
  // period (disagreeing with Money/Analytics Collected).
  const paidInvoices = rawData.invoices.filter(inv => inv.status === 'paid' && isInPeriod(inv.paidAt));
  const wonLeads = rawData.leads.filter(l => (l._stageRole ? l._stageRole === 'won' : WON_STAGES.includes(l._stageKey || l.stage || '')) && isInPeriod(l.updatedAt));

  const totalKnocks = knocks.length;
  const totalDeals = wonLeads.length;
  // Cash basis, per payment date — same attribution as the Money dashboard.
  let totalRevenue = 0;
  rawData.invoices.forEach(inv => {
    paymentsOf(inv).forEach(p => {
      if (isInPeriod(p.at)) totalRevenue += parseFloat(p.amount) || 0;
    });
  });
  totalRevenue = Math.round(totalRevenue * 100) / 100;
  // No fallback to won jobs' jobValue when no cash came in: revenue is
  // COLLECTED only (Jo, 2026-09-28) — $0 collected reads $0, not a booked total.
  const revenueFallback = totalRevenue;
  const closeRate = (totalDeals + leads.filter(l => ['lost','Lost'].includes(l._stageKey || l.stage || '')).length) > 0
    ? Math.round(totalDeals / (totalDeals + leads.filter(l => ['lost','Lost'].includes(l._stageKey || l.stage || '')).length) * 100)
    : 0;

  // Appointments from knocks
  const appointments = knocks.filter(k => k.disposition === 'appointment' || k.stage === 'appointment').length;

  return {
    totalKnocks, totalDeals, totalRevenue: revenueFallback, closeRate, appointments,
    knocks, wonLeads, paidInvoices, leads
  };
}

// ── Build rep-level data (for multi-rep future use) ──
function buildReps(metrics) {
  const name = currentUser?.displayName || 'You';
  return [{
    name: name,
    uid: currentUser?.uid,
    knocks: metrics.totalKnocks,
    deals: metrics.totalDeals,
    revenue: metrics.totalRevenue,
    appointments: metrics.appointments,
    rate: metrics.closeRate
  }];
}

// ── Render everything ──
function renderAll() {
  const metrics = computeMetrics();
  const reps = buildReps(metrics);

  // Summary stats
  document.getElementById('sumKnocks').textContent = metrics.totalKnocks.toLocaleString();
  document.getElementById('sumDeals').textContent = metrics.totalDeals.toLocaleString();
  document.getElementById('sumRevenue').textContent = fmtCurrency(metrics.totalRevenue);
  document.getElementById('sumRate').textContent = metrics.closeRate + '%';

  renderBoard(reps);
  renderFeed(metrics);
}

function renderBoard(reps) {
  const board = document.getElementById('board');
  const banner = document.getElementById('my-rank-banner');

  const TABS = {
    doors:   { field: 'knocks',   label: 'Doors',   fmtFn: v => v.toLocaleString() },
    deals:   { field: 'deals',    label: 'Deals',    fmtFn: v => v.toLocaleString() },
    revenue: { field: 'revenue',  label: 'Revenue',  fmtFn: v => fmtCurrency(v) }
  };
  const t = TABS[currentTab];

  const sorted = [...reps].sort((a, b) => (b[t.field] || 0) - (a[t.field] || 0));

  if (sorted.length === 0 || sorted.every(r => !r[t.field])) {
    board.innerHTML = '<div class="state-msg"><div class="icon">📊</div>No data for this period yet. Get out there and knock some doors.</div>';
    banner.style.display = 'none';
    return;
  }

  // My rank banner
  if (currentUser) {
    const myIdx = sorted.findIndex(r => r.uid === currentUser.uid);
    if (myIdx !== -1) {
      const my = sorted[myIdx];
      banner.style.display = 'block';
      banner.innerHTML = '<div class="my-rank-inner"><span>Your rank: <strong>#' + (myIdx + 1) + '</strong></span><span><strong>' + t.fmtFn(my[t.field] || 0) + '</strong> ' + t.label + (my.appointments > 0 ? ' · ' + my.appointments + ' appts set' : '') + '</span></div>';
    } else {
      banner.style.display = 'none';
    }
  }

  const rows = sorted.slice(0, 25).map((entry, i) => {
    const rankClass = i === 0 ? 'top-1' : i === 1 ? 'top-2' : i === 2 ? 'top-3' : '';
    const rankIcon = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i + 1);
    const name = entry.name || 'NBD Member';
    const sub = currentTab === 'doors'
      ? entry.appointments + ' appointments · ' + entry.rate + '% close rate'
      : currentTab === 'deals'
        ? fmtCurrency(entry.revenue) + ' revenue · ' + entry.rate + '% close rate'
        : entry.deals + ' deals · ' + entry.knocks + ' doors knocked';

    return '<div class="lb-row ' + rankClass + '">' +
      '<div class="rank">' + rankIcon + '</div>' +
      '<div class="avatar">' + esc(initials(name)) + '</div>' +
      '<div class="lb-info">' +
        '<div class="lb-name">' + esc(name) + '</div>' +
        '<div class="lb-sub">' + sub + '</div>' +
      '</div>' +
      '<div class="lb-stat">' +
        '<div class="lb-stat-val">' + t.fmtFn(entry[t.field] || 0) + '</div>' +
        '<div class="lb-stat-label">' + t.label + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  board.innerHTML = rows;
}

function renderFeed(metrics) {
  const feedEl = document.getElementById('feed');
  const feedItems = document.getElementById('feedItems');

  // Build recent activity from won leads and knocks
  const events = [];
  // Escape lead/knock fields (name/address can originate from public intake) — the
  // feed text mixes intentional <strong> markup with user data and is set via innerHTML.
  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  metrics.wonLeads.slice(0, 5).forEach(l => {
    const d = toDate(l.updatedAt);
    if (d) events.push({ icon: '🏆', text: '<strong>Deal closed</strong> — ' + esc(((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || l.address || 'Lead') + (l.jobValue ? ' · ' + fmtCurrency(parseFloat(l.jobValue)) : ''), time: d });
  });

  const recentKnocks = metrics.knocks.filter(k => k.disposition === 'appointment').slice(0, 5);
  recentKnocks.forEach(k => {
    const d = toDate(k.createdAt);
    if (d) events.push({ icon: '📋', text: '<strong>Appointment set</strong> — ' + esc(k.address || 'Address'), time: d });
  });

  events.sort((a, b) => b.time - a.time);

  if (events.length === 0) {
    feedEl.style.display = 'none';
    return;
  }

  feedEl.style.display = 'block';
  feedItems.innerHTML = events.slice(0, 8).map(e =>
    '<div class="feed-item">' +
      '<div class="feed-icon">' + e.icon + '</div>' +
      '<div class="feed-text">' + e.text + '</div>' +
      '<div class="feed-time">' + relativeTime(e.time) + '</div>' +
    '</div>'
  ).join('');
}

// ── Tab switching ──
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTab = btn.dataset.tab;
    renderAll();
  });
});

// ── Period switching ──
document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;
    renderAll();
  });
});

// ── Auth gate ──
onAuthStateChanged(auth, user => {
  currentUser = user;
  document.documentElement.style.visibility = 'visible';
  if (user) {
    document.getElementById('auth-wall').style.display = 'none';
    document.getElementById('board').style.display = 'block';
    loadData();
  } else {
    document.getElementById('board').style.display = 'none';
    document.getElementById('auth-wall').style.display = 'block';
    document.getElementById('my-rank-banner').style.display = 'none';
    document.getElementById('feed').style.display = 'none';
  }
});
