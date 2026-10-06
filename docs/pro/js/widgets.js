// ╔═══════════════════════════════════════════════════════════════════╗
// ║  NBD PRO — WIDGET HOME PAGE SYSTEM v1.0                         ║
// ║  30 customizable widgets • drag grid • localStorage persistence  ║
// ╚═══════════════════════════════════════════════════════════════════╝

let _NBD_WIDGETS_DELEGATE_BOUND, _wAddTask, _wAskJoe, _wMiniHeat, _wQuickAddLead, _wQuickDraw, _wQuickEst, _wRadarMap, _wToggleTask; // module-local (globals Tranches 1 + 2b — was window.*)
(function(){
'use strict';

// Wave 102: HIGH XSS fix. Every widget that renders lead names /
// addresses / stages was interpolating Firestore strings directly
// into innerHTML with NO escaping. crm.js had its own escHtml from
// day one; widgets.js was the asymmetric oversight (same shape as
// the W86 portal XSS — a sister surface that DID escape, vs one
// that didn't). A lead with name = '<img src=x onerror="...">'
// would execute on every dashboard render of every rep in the
// company. Threat model: any company-internal authenticated user
// can inject persistent XSS into every coworker's dashboard.
//
// Fix: define esc() at module scope and wrap every user-controlled
// field interpolation. Caught by code-reviewer agent run after the
// W100 milestone.
// Leaflet vendors are a lazy bundle (mapvendor, 2026-08-07): the two home
// widgets that draw a map load it on demand instead of silently rendering
// an empty box (their old guard was `if(!window.L) return;`).
function _withLeaflet(cb) {
  if (window.L) { try { cb(); } catch (e) {} return; }
  if (window.ScriptLoader && window.ScriptLoader.loadBundle) {
    window.ScriptLoader.loadBundle('mapvendor').then(() => {
      if (window.L) { try { cb(); } catch (e) {} }
    });
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// W159 sweep: every widget below was filtering by legacy capitalized
// stage names (l.stage === 'New' etc.) that no longer exist after the
// crm-stages migration to snake_case keys. Helper returns the canonical
// lowercase key for a lead via the cached _stageKey crm.js sets, with
// window.normalizeStage as a fallback for any lead that hydrated before
// the cache was populated.
function _normStage(l) {
  if (!l) return '';
  if (l._stageKey) return l._stageKey;
  if (typeof window.normalizeStage === 'function') {
    try { return window.normalizeStage(l.stage || ''); } catch (_) {}
  }
  return String(l.stage || '').toLowerCase();
}
// Lowercase-key buckets matching the legacy 5-stage funnel labels
// used across the Pipeline-Value, Stage-Funnel, and Close-Board
// widgets. Multiple keys per bucket because the new schema splits
// each legacy bucket across insurance/cash/finance tracks.
const _STAGE_BUCKETS = {
  'New':         new Set(['new']),
  'Contacted':   new Set(['contacted', 'inspected', 'claim_filed', 'adjuster_meeting_scheduled', 'adjuster_inspection_done', 'scope_received']),
  'Est. Sent':   new Set(['estimate_submitted', 'estimate_sent_cash', 'supplement_requested', 'supplement_approved', 'prequal_sent', 'loan_approved']),
  'Negotiating': new Set(['negotiating']),
  'Won':         new Set(['contract_signed', 'install_in_progress', 'install_complete', 'closed']),
};
// Semantic role via crm-stages (custom-pipeline aware), like crm-pipeline.js.
// The widgets below used hand-copied won lists that missed collections /
// warranty_claim / custom won stages and disagreed with the Pipeline header.
const _WON_FALLBACK = ['closed','install_complete','final_photos','final_payment','deductible_collected','collections','warranty_claim'];
function _roleOf(l) {
  if (!l) return 'active';
  if (l._stageRole) return l._stageRole;
  const k = _normStage(l);
  if (typeof window.stageRole === 'function') { try { return window.stageRole(k); } catch (_) {} }
  if (_WON_FALLBACK.includes(k)) return 'won';
  if (k === 'lost') return 'lost';
  return 'active';
}
// In play = not won, not lost, not a signed/in-production job — the same
// bucket crm-pipeline.js calls pipeline value (metrics audit F2).
function _inPlay(l) {
  const r = _roleOf(l);
  if (r === 'won' || r === 'lost' || r === 'job') return false;
  return !(typeof window.isJobStage === 'function' && window.isJobStage(_normStage(l)));
}
// Display label for a lead's stage — never the raw key ("estimate_submitted").
function _stageText(l) {
  const k = _normStage(l);
  return (typeof window.stageLabel === 'function' && window.stageLabel(k)) || (l && l.stage) || '';
}
// Display name for a lead. The lead form writes firstName/lastName and no
// `name` (only seeds, D2D and some imports set it), so reading `l.name` alone
// showed every form-created lead by its address.
let _wGoalSynced = false; // revenue-month: one userSettings read per page
function _leadName(l, fallback) {
  if (!l) return fallback;
  return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || l.customerName || l.address || fallback;
}
// A lead's dollar amount lives in jobValue (see pipeline-value below);
// estValue/value are legacy fallbacks.
// The ONE money reader (customer-estimate-rows.js moneyValue): legacy text
// like '$45,000' reads 45000 here and on the kanban / KPI tiles alike (review
// R2, 2026-10-06). Fallback strips the same characters if that file is absent.
function _wgMoney(v) {
  const R = window.NBDCustomerEstimateRows;
  if (R && typeof R.moneyValue === 'function') return R.moneyValue(v);
  return parseFloat(String(v == null ? '' : v).replace(/[^0-9.-]/g, '')) || 0;
}
function _leadValue(l) {
  return _wgMoney(l.jobValue || l.estValue || l.value || 0);
}
function _bucketOf(l) {
  const k = _normStage(l);
  for (const [bucket, keys] of Object.entries(_STAGE_BUCKETS)) {
    if (keys.has(k)) return bucket;
  }
  return null;
}

// ── WIDGET REGISTRY ─────────────────────────────────────────────
const WIDGETS = [

  // ═══ THURSDAY — AI RECEPTIONIST INBOX (2026-09-26) ═══
  // Calls Thursday (the Bland AI receptionist) answered: new leads, possible
  // matches to confirm, adjusters, calls that need review. Pinned to the top
  // of Home for tenants with thursday_config/{companyId}; removable (the
  // choice persists on userSettings/{uid}, not in wiped nbd_ localStorage).
  {id:'thursday-calls', name:'Thursday — Calls', icon:'📞', cat:'Pipeline & Sales', size:'lg',
    render(el){ _thuRender(el); }},

  // ═══ PIPELINE & SALES ═══
  {id:'pipeline-value', name:'Pipeline Value', icon:'💰', cat:'Pipeline & Sales', size:'md',
    render(el){
      // Every JOB, not every customer (multi-job, 2026-09-30): a customer's
      // second open job adds its own value — the same cards the CRM shows.
      const leads = (window.NBDJobs && typeof window.NBDJobs.recordsFor === 'function') ? window.NBDJobs.recordsFor(window._leads || []) : (window._leads || []);
      const stages = {New:0, Contacted:0, 'Est. Sent':0, Negotiating:0, Won:0};
      let total = 0;
      leads.forEach(l => {
        // Pipeline = deals still in play (matches the CRM header): won, lost
        // and signed jobs used to be summed in too, so Home read higher than
        // the Pipeline page for the same data.
        if (!_inPlay(l)) return;
        // QA 2026-06-21 #3: leads store their amount in `jobValue` (see
        // crm-pipeline.js — the CRM header sums jobValue to $126k). This
        // widget summed `estValue || value`, fields that don't exist on a
        // lead, so Home's Pipeline Value always rendered $0 while the CRM
        // showed the real total. jobValue first, legacy fields as fallback.
        const val = _leadValue(l);
        total += val;
        const bucket = _bucketOf(l);
        if (bucket && stages[bucket] !== undefined) stages[bucket] += val;
      });
      const stageBar = Object.entries(stages).filter(([,v])=>v>0).map(([s,v])=>{
        const pct = total > 0 ? (v/total*100) : 0;
        const colors = {New:'var(--blue)',Contacted:'#A855F7','Est. Sent':'#F97316',Negotiating:'var(--gold)',Won:'var(--green)'};
        return `<div style="flex:${pct};background:${colors[s]||'#666'};height:8px;min-width:2px;" title="${s}: $${v.toLocaleString()}"></div>`;
      }).join('');
      el.innerHTML = `
        <div class="w-big-num">$${total >= 1000 ? (total/1000).toFixed(1)+'k' : total.toFixed(0)}</div>
        <div class="w-sub">Total Pipeline Value</div>
        <div class="wg-segs">${stageBar || '<div class="wg-seg"></div>'}</div>
        <div class="wg-axis">
          <span>${leads.filter(_inPlay).length} in play</span><span>${leads.filter(l=>_roleOf(l)==='won').length} won</span>
        </div>`;
    }},

  {id:'hot-leads', name:'Hot Leads', icon:'🔥', cat:'Pipeline & Sales', size:'md',
    render(el){
      const HOT = ['contacted','estimate_submitted','estimate_sent_cash','negotiating','contract_signed'];
      // A due follow-up counts by THE follow-up rule (today-plan.js
      // followUpDue). This used to read a `callback` field no writer sets
      // (0 leads had it, 2026-10-03 audit).
      const fuDue = window.NBDTodayPlan && window.NBDTodayPlan.followUpDue;
      const leads = (window._leads || []).filter(l => {
        const r = _roleOf(l);
        if (r === 'won' || r === 'lost') return false;
        if (fuDue && fuDue(l)) return true;
        return HOT.includes(_normStage(l));
      }).slice(0, 5);
      if(!leads.length) { el.innerHTML = '<div class="w-empty">No hot leads right now</div>'; return; }
      el.innerHTML = leads.map(l => {
        const k = _normStage(l);
        const color = k === 'contacted' ? '#A855F7' : (k === 'estimate_submitted' || k === 'estimate_sent_cash') ? '#F97316' : 'var(--m)';
        return `
        <div class="w-lead-row" data-w-goto="crm">
          <div class="w-lead-name">${esc(_leadName(l, 'Unknown'))}</div>
          <div class="w-lead-stage" style="color:${color}">${esc(_stageText(l))}</div>
        </div>`;
      }).join('');
    }},

  {id:'win-rate', name:'Win Rate', icon:'🏆', cat:'Pipeline & Sales', size:'sm',
    render(el){
      // THE close rate (numbers-logic.js, 2026-10-04): won ÷ (won + lost),
      // won = won / in production / contract signed. Nothing decided → "—".
      const leads = window._leads || [];
      const cr = window.NBDNumbers ? window.NBDNumbers.closeRate(leads) : { won: 0, decided: 0, rate: null };
      const won = cr.won;
      const closed = { length: cr.decided };
      const rate = cr.rate == null ? 0 : cr.rate * 100;
      const rateTxt = cr.rate == null ? '—' : rate.toFixed(0) + '%';
      const circumference = 2 * Math.PI * 36;
      const offset = circumference - (rate / 100) * circumference;
      el.innerHTML = `
        <svg width="84" height="84" class="wg-svg-center">
          <circle cx="42" cy="42" r="36" stroke="var(--br)" stroke-width="6" fill="none"/>
          <circle cx="42" cy="42" r="36" stroke="var(--orange)" stroke-width="6" fill="none"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 42 42)" stroke-linecap="round"/>
          <text x="42" y="46" text-anchor="middle" fill="var(--t)" font-family="'Barlow Condensed',sans-serif" font-size="20" font-weight="800">${rateTxt}</text>
        </svg>
        <div class="w-sub">${won} won / ${closed.length} closed</div>`;
    }},

  {id:'revenue-month', name:'Revenue This Month', icon:'📈', cat:'Pipeline & Sales', size:'sm',
    render(el){
      const leads = window._leads || [];
      const now = new Date();
      // Which date counts as "when this job earned its money".
      //
      // This used to read updatedAt, which is LAST-TOUCHED, not when the job
      // closed — so any edit to an old won lead silently moved its revenue into
      // the current month. A CSV import of historical wins made it obvious:
      // every backfilled job landed in "this month" at once and the widget
      // reported months of revenue as if it were all earned in August.
      //
      // Order of preference:
      //   closedAt       — explicit close date (set on backfilled/imported wins)
      //   stageStartedAt — when the lead ENTERED its current stage; for a won
      //                    lead that is the moment it closed, and it does not
      //                    move when someone edits a note
      //   updatedAt      — last resort, for legacy docs predating both
      const asDate = v => v?.toDate ? v.toDate() : v?.seconds ? new Date(v.seconds*1000) : (v ? new Date(v) : null);
      const closedDate = l => asDate(l.closedAt) || asDate(l.stageStartedAt) || asDate(l.updatedAt) || new Date(0);
      const thisMonth = leads.filter(l => {
        if(_roleOf(l) !== 'won') return false;
        const d = closedDate(l);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      });
      // Revenue = money COLLECTED this month (invoice payments by the date each
      // arrived) — Jo, 2026-09-28: "Revenue is always collected only." This
      // tile used to sum the jobValue of leads that CLOSED this month (booked,
      // not banked). `thisMonth` above is kept for the won-count sub-line only.
      const R = window.NBDRevenue;
      const invs = R ? R.cached() : null;
      if (R && !invs) {
        R.loadInvoices().then(() => { if (!R.cached()) return; const w = WIDGETS.find(x => x.id === 'revenue-month'); if (w && document.contains(el)) w.render(el); });
      }
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      const rev = invs ? R.collectedBetween(invs, monthStart, now.getTime()).total : 0;
      const revText = invs ? ('$' + (rev >= 1000 ? (rev/1000).toFixed(1)+'k' : rev.toFixed(0))) : '…';
      // nbd_ localStorage is wiped on every sign-out, so the goal also lives on
      // userSettings/{uid}.monthlyGoal (the notification-settings pattern:
      // local cache for the instant paint, Firestore as the source of truth).
      let _cachedGoal = null;
      try { _cachedGoal = localStorage.getItem('nbd_monthly_goal'); } catch (_) {}
      const goal = parseFloat(_cachedGoal || '50000');
      if (!_cachedGoal && !_wGoalSynced && window._user && window.getDoc && window.doc && window.db) {
        _wGoalSynced = true;
        window.getDoc(window.doc(window.db, 'userSettings', window._user.uid)).then(snap => {
          const g = snap && snap.exists() ? Number(snap.data().monthlyGoal) : 0;
          if (g > 0) {
            try { localStorage.setItem('nbd_monthly_goal', String(g)); } catch (_) {}
            const w = WIDGETS.find(x => x.id === 'revenue-month');
            if (w && document.contains(el)) w.render(el);
          }
        }).catch(() => {});
      }
      const pct = goal > 0 ? Math.min(100, rev / goal * 100) : 0;
      // Sweep Pass 4: 'nbd_monthly_goal' was read but never written —
      // no settings UI existed to set it, so the goal was permanently
      // stuck at the hardcoded $50K default. Click-to-edit on the goal
      // text gives the user a way to customize without us having to
      // build a whole settings panel.
      el.innerHTML = `
        <div class="w-big-num wg-green">${revText}</div>
        <div class="w-sub">Revenue This Month <span class="wg-o7">· collected</span>${thisMonth.length ? ' <span class="wg-o7">· ' + thisMonth.length + ' closed</span>' : ''}</div>
        <div class="w-bar-track"><div class="w-bar-fill" style="width:${pct}%"></div></div>
        <div class="w-goal-edit wg-edit-link" data-w-stop="1" title="Click to change your monthly goal">${pct.toFixed(0)}% of $${(goal/1000).toFixed(0)}k goal ✎</div>`;
      const goalEl = el.querySelector('.w-goal-edit');
      if (goalEl) {
        goalEl.addEventListener('click', () => {
          const raw = prompt(
            'Set your monthly revenue goal (USD)',
            String(goal)
          );
          if (raw == null) return;
          const next = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
          if (!isFinite(next) || next <= 0) {
            if (typeof window.showToast === 'function') window.showToast('Enter a positive number', 'warning');
            return;
          }
          try { localStorage.setItem('nbd_monthly_goal', String(next)); } catch (_) {}
          try {
            if (window._user && window.setDoc && window.doc && window.db) {
              window.setDoc(window.doc(window.db, 'userSettings', window._user.uid), { monthlyGoal: next }, { merge: true }).catch(() => {});
            }
          } catch (_) {}
          if (typeof window.showToast === 'function') {
            window.showToast('Monthly goal set to $' + (next/1000).toFixed(0) + 'k', 'success');
          }
          // Re-render this widget in place so the user sees the new
          // goal + percentage immediately without a page reload. (Looked up
          // window._widgets, which never existed — the goal saved but the
          // widget kept showing the old one until a reload.)
          const widget = WIDGETS.find(w => w.id === 'revenue-month');
          if (widget && typeof widget.render === 'function') widget.render(el);
        });
      }
    }},

  {id:'stage-funnel', name:'Stage Funnel', icon:'🔻', cat:'Pipeline & Sales', size:'lg',
    render(el){
      const leads = window._leads || [];
      const stages = ['New','Contacted','Est. Sent','Negotiating','Won'];
      const counts = stages.map(s => leads.filter(l => _bucketOf(l) === s).length);
      const max = Math.max(...counts, 1);
      el.innerHTML = `<div class="w-funnel">` + stages.map((s, i) => {
        const pct = 40 + (1 - i/(stages.length-1)) * 60;
        const colors = ['var(--blue)','#A855F7','#F97316','var(--gold)','var(--green)'];
        return `<div class="w-funnel-row">
          <div class="w-funnel-bar" style="width:${pct}%;background:${colors[i]};">${counts[i]}</div>
          <span class="w-funnel-label">${s}</span>
        </div>`;
      }).join('') + `</div>`;
    }},

  {id:'recent-activity', name:'Recent Activity', icon:'⚡', cat:'Pipeline & Sales', size:'md',
    render(el){
      const leads = (window._leads || []).filter(l => l.updatedAt || l.createdAt)
        .sort((a,b) => _toMs(b.updatedAt||b.createdAt) - _toMs(a.updatedAt||a.createdAt)).slice(0, 5);
      if(!leads.length) { el.innerHTML = '<div class="w-empty">No recent activity</div>'; return; }
      el.innerHTML = leads.map(l => {
        const ago = _timeAgo(l.updatedAt || l.createdAt);
        return `<div class="w-activity-row">
          <div class="w-activity-dot" style="background:${(()=>{const b=_bucketOf(l);const s=_normStage(l);return b==='Won'?'var(--green)':s==='lost'?'#EF4444':'var(--orange)';})()}"></div>
          <div class="wg-grow wg-min0">
            <div class="wg-name">${esc(_leadName(l, 'Lead'))}</div>
            <div class="wg-meta">${esc(_stageText(l))} • ${esc(ago)}</div>
          </div>
        </div>`;
      }).join('');
    }},

  {id:'stale-leads', name:'Stale Leads', icon:'⏰', cat:'Pipeline & Sales', size:'md',
    render(el){
      const now = Date.now();
      const stale = (window._leads || []).filter(l => {
        const b = _bucketOf(l);
        if (b === 'Won' || _normStage(l) === 'lost') return false;
        const last = _toMs(l.updatedAt||l.createdAt);
        return last > 0 && (now - last) > 7*24*60*60*1000;
      }).sort((a,b) => _toMs(a.updatedAt||a.createdAt) - _toMs(b.updatedAt||b.createdAt)).slice(0,5);
      if(!stale.length) { el.innerHTML = '<div class="w-empty wg-green">No stale leads — nice work!</div>'; return; }
      el.innerHTML = `<div class="wg-red-head">${stale.length} leads need attention</div>` +
        stale.map(l => {
          const days = Math.floor((now - _toMs(l.updatedAt||l.createdAt)) / 86400000);
          return `<div class="w-lead-row"><div class="w-lead-name">${esc(_leadName(l, 'Lead'))}</div><div class="wg-red-10">${days > 0 ? days+'d ago' : 'today'}</div></div>`;
        }).join('');
    }},

  {id:'close-board', name:'Close Board', icon:'🎯', cat:'Pipeline & Sales', size:'md',
    render(el){
      const leads = (window._leads || []).filter(l => {
        const b = _bucketOf(l);
        return b === 'Negotiating' || b === 'Est. Sent';
      });
      const total = leads.reduce((s,l) => s + _leadValue(l), 0);
      el.innerHTML = `
        <div class="wg-between wg-mb8">
          <span class="w-big-num wg-fs22">${leads.length}</span>
          <span class="wg-green-sm">$${total>=1000?(total/1000).toFixed(1)+'k':total.toFixed(0)} closeable</span>
        </div>` +
        leads.slice(0,4).map(l => `<div class="w-lead-row">
          <div class="w-lead-name">${esc(_leadName(l, 'Lead'))}</div>
          <div class="wg-orange-10">$${_leadValue(l).toLocaleString()}</div>
        </div>`).join('');
    }},

  // ═══ OPERATIONS ═══
  {id:'weather-radar', name:'Weather Radar', icon:'🌧️', cat:'Operations', size:'md',
    render(el){
      el.innerHTML = `<div id="w-radar-map" class="wg-map wg-map-160"></div>
        <div class="wg-foot wg-center">Live NEXRAD radar • Updates every 10 min</div>`;
      setTimeout(() => _withLeaflet(() => {
        if(!document.getElementById('w-radar-map')) return; // widget re-rendered while loading
        if(_wRadarMap){try{_wRadarMap.remove();}catch(e){}}
        const map = L.map('w-radar-map',{zoomControl:false,attributionControl:false}).setView([39.07,-84.17],7);
        _wRadarMap = map;
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:10}).addTo(map);
        L.tileLayer('https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',{opacity:.6,maxZoom:10}).addTo(map);
      }), 100);
    }},

  {id:'storm-alerts', name:'Storm Alerts', icon:'⛈️', cat:'Operations', size:'sm',
    render(el){
      // Shows what Storm Center last found for THIS rep's area (it localizes
      // to their county). This used to query area=OH for every tenant and
      // print "No active alerts in your area" for everyone outside Ohio,
      // and it put NWS text into innerHTML unescaped (2026-09-29).
      let cached = null;
      try {
        const raw = JSON.parse(localStorage.getItem('nbd_storm_alerts_cache') || 'null');
        if (raw && Array.isArray(raw.data) && Date.now() - raw.ts < 60 * 60 * 1000) cached = raw.data;
      } catch (e) { cached = null; }
      if (cached && cached.length) {
        el.innerHTML = cached.slice(0,3).map(a => `
          <div class="wg-alert">
            <div class="wg-red-bold">${esc(a.event || 'Weather alert')}</div>
            <div class="wg-muted wg-mt2">${esc(String(a.headline || '').substring(0,80))}</div>
          </div>`).join('');
      } else {
        el.innerHTML = `<div class="w-empty wg-fs11">
          <div class="wg-icon20">🛡️</div>
          ${cached ? 'No active alerts in your area.' : 'Check alerts for your area.'}<br>
          <button class="w-mini-btn wg-mt6" data-w-goto="storm">Open Storm Center →</button>
        </div>`;
      }
    }},

  {id:'today-schedule', name:"Today's Schedule", icon:'📅', cat:'Operations', size:'md',
    render(el){
      // Real items (2026-10-03): the same appointments / job days / adjuster
      // meetings as the Today list (today-plan.js collectTodayItems — the
      // morning brief's rule), from the plan Today last painted. It used to
      // be a link to the Schedule and nothing else.
      const p = window.NBDToday && typeof window.NBDToday.last === 'function' ? window.NBDToday.last() : null;
      const items = (p && p.appointments) || [];
      const head = `<div class="wg-between-c wg-mb8"><span class="wg-title-sm">Today</span><button class="w-mini-btn" data-w-goto="schedule">Open Calendar →</button></div>`;
      if (!p) { el.innerHTML = head + '<div class="w-empty wg-fs11">Loading today…</div>'; return; }
      if (!items.length) { el.innerHTML = head + '<div class="w-empty wg-fs11">Nothing on the calendar today.</div>'; return; }
      el.innerHTML = head + items.slice(0, 6).map(it => `
        <div class="w-lead-row" data-w-goto="schedule">
          <div class="w-lead-name">${esc(it.name)}</div>
          <div class="w-lead-stage">${esc(it.timeLabel)}${it.type ? ' · ' + esc(it.type) : ''}</div>
        </div>`).join('') + (items.length > 6 ? `<div class="w-empty wg-fs11">+${items.length - 6} more</div>` : '');
    }},

  // "Personal checklist" (2026-10-03, was "Task Checklist"): a private
  // scratch list on this user's settings — NOT the CRM's tasks (those are on
  // the Today list and each customer).
  {id:'task-checklist', name:'Personal checklist', icon:'✅', cat:'Operations', size:'md',
    render(el){
      const tasks = _getHomeTasks();
      el.innerHTML = `<div id="w-tasks">` + tasks.map((t,i) => `
        <label class="w-task-row">
          <input type="checkbox" ${t.d?'checked':''} data-w-change="toggleTask" data-w-idx="${i}">
          <span style="${t.d?'text-decoration:line-through;opacity:.5;':''}font-size:12px;color:var(--t);">${esc(t.t)}</span>
        </label>`).join('') + `</div>
        <div class="wg-row4 wg-mt6">
          <input type="text" id="w-task-input" placeholder="Add task..." class="wg-input-flex-sm">
          <button class="w-mini-btn" data-w-action="addTask">+</button>
        </div>`;
    }},

  {id:'quick-estimate', name:'Quick Estimate', icon:'🧮', cat:'Operations', size:'sm',
    render(el){
      el.innerHTML = `
        <div class="wg-mb6">
          <label class="wg-cap-label">Sq Ft</label>
          <input type="number" id="w-qe-sqft" placeholder="2000" class="wg-input-sm" data-w-input="quickEst">
        </div>
        <div class="wg-mb6">
          <label class="wg-cap-label">$/sq</label>
          <input type="number" id="w-qe-rate" placeholder="350" value="350" class="wg-input-sm" data-w-input="quickEst">
        </div>
        <div id="w-qe-result" class="wg-streak">$0</div>`;
    }},

  // 'material-watch' (Material Price Watch) REMOVED.
  //
  // It rendered four invented prices — "OC Duration $98/sq +2%", "GAF
  // Timberline $102/sq -1%", "Synthetic Felt $67/roll", "Drip Edge 10ft
  // $4.50/pc" — under the comment "Simulated price data — in production would
  // fetch from supplier API". There is no supplier API, in this repo or
  // anywhere it could reach.
  //
  // Of all the fabricated data on the dashboard this was the dangerous one: it
  // is specific, it looks authoritative, and it is directly ACTIONABLE. A
  // roofer pricing a job off "$98/sq" for a shingle he hasn't quoted this month
  // loses real money on a real roof, and nothing on the widget told him the
  // number was made up.
  //
  // Not replaced with an empty state, because a "Material Price Watch" that
  // never has data is just a permanently broken tile. If a supplier feed (or a
  // read of the tenant's own Product Library pricing) ever lands, re-add it
  // then — pointed at that source. Until then, no widget beats a lying one.

  // Yard signs out in the field — how many, and how many are due back.
  // Reads the same yardSigns docs the Yard Signs view writes; the pickup
  // math is NBDYardSignLogic's when that bundle is loaded, else a plain
  // dueAt <= now count (the widget must not pull the Leaflet bundle).
  {id:'yard-signs', name:'Yard Signs', icon:'🪧', cat:'Operations', size:'sm',
    async render(el){
      el.innerHTML = '<div class="w-empty">Loading…</div>';
      try {
        const uid = window._user && window._user.uid;
        if (!uid || !window.db || !window.getDocs) { el.innerHTML = '<div class="w-empty">Sign in to see signs</div>'; return; }
        const snap = await window.getDocs(window.query(window.collection(window.db, 'yardSigns'),
          window.where('userId', '==', uid), window.where('status', '==', 'out')));
        const now = Date.now();
        let out = 0, due = 0;
        const msOf = (x) => x && x.toMillis ? x.toMillis() : Number(x) || 0;
        // Skip removed signs, and signs logged ahead of time (placedAt in the
        // future) — neither is out in a yard (2026-09-30).
        snap.forEach(d => { const v = d.data(); if (v.deleted || msOf(v.placedAt) > now) return; out++; const t = msOf(v.dueAt);
          if (t && t <= now + 86400000) due++; });
        el.innerHTML = '<div class="w-big-num">' + out + '</div><div class="w-sub">' + (out === 1 ? 'sign' : 'signs') + ' out'
          + (due ? ' · <strong>' + due + ' due for pickup</strong>' : '') + '</div>';
      } catch (e) { el.innerHTML = '<div class="w-empty">Could not load signs</div>'; }
    }
  },

  {id:'team-leaderboard', name:'Team Leaderboard', icon:'🥇', cat:'Operations', size:'sm',
    render(el){
      // REAL data. This used to render three invented reps — "Joe Deal $48.5k
      // / 12 deals", "Mike S. $32.1k", "Sarah K. $27.8k" — with the comment
      // "Pull from leaderboard data or simulate". It's opt-in from an ungated
      // picker, and a brand-new tenant with an empty dashboard is exactly who
      // browses the widget gallery looking for something to fill it. He'd add
      // a leaderboard, see a stranger named Joe Deal topping HIS board with
      // $48.5k, and reasonably conclude the product was showing someone else's
      // data — or that its numbers can't be trusted at all.
      //
      // BOOKED, all time: group non-deleted leads by owner, count won by stage
      // ROLE (not a hardcoded name list, so custom pipelines work), and sum the
      // won jobs' jobValue — what was sold, not what was paid. This is NOT the
      // Leaderboard page's ranking, which is money COLLECTED in the period
      // (pages/leaderboard.js; revenue is collected only), so the widget says
      // "Booked (all time)" on its face (review R2, 2026-10-06).
      // Every won JOB counts (multi-job, 2026-09-30): a customer's second job
      // is its own deal and its own value.
      const _all = (window.NBDJobs && typeof window.NBDJobs.recordsFor === 'function') ? window.NBDJobs.recordsFor(window._leads || []) : (window._leads || []);
      const leads = _all.filter(l => l && !l.deleted);
      const byRep = {};
      leads.forEach(l => {
        const owner = l.userId || '(unknown)';
        if (!byRep[owner]) byRep[owner] = { name: '', rev: 0, deals: 0 };
        if (!byRep[owner].name && l.repName) byRep[owner].name = l.repName;
        const role = l._stageRole
          || (typeof window.stageRole === 'function' ? window.stageRole(l._stageKey || l.stage) : '');
        if (role === 'won' || role === 'job') {
          byRep[owner].deals++;
          byRep[owner].rev += _wgMoney(l.jobValue);
        }
      });
      const reps = Object.entries(byRep)
        .map(([owner, r]) => ({
          // Fall back to the signed-in user's own name for their own row, then
          // a neutral label — never an invented person.
          name: r.name
            || (owner === (window._user && window._user.uid)
                ? ((window._user && (window._user.displayName || window._user.email)) || 'You')
                : 'Teammate'),
          rev: r.rev,
          deals: r.deals,
        }))
        .filter(r => r.deals > 0)
        .sort((a, b) => b.rev - a.rev)
        .slice(0, 3);

      if (!reps.length) {
        el.innerHTML = '<div class="wg-empty-line">'
          + 'No closed jobs yet — reps appear here once deals start closing.</div>';
        return;
      }
      el.innerHTML = '<div class="wg-tiny">Booked (all time)</div>' + reps.map((r,i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;${i<reps.length-1?'border-bottom:1px solid var(--br);':''}">
          <span class="wg-fs14">${i===0?'🥇':i===1?'🥈':'🥉'}</span>
          <div class="wg-grow"><div class="wg-title-sm">${esc(r.name)}</div></div>
          <div class="wg-right"><div class="wg-orange-12">$${(r.rev/1000).toFixed(1)}k</div><div class="wg-tiny">${r.deals} deals</div></div>
        </div>`).join('');
    }},

  // ═══ TOOLS & QUICK ACTIONS ═══
  {id:'quick-add-lead', name:'Quick Add Lead', icon:'➕', cat:'Tools & Quick Actions', size:'md',
    render(el){
      el.innerHTML = `
        <div class="wg-col6">
          <input type="text" id="w-ql-name" placeholder="Homeowner name" class="wg-input">
          <input type="text" id="w-ql-addr" placeholder="Property address" class="wg-input">
          <div class="wg-row6">
            <select id="w-ql-damage" class="wg-select">
              <option value="Roof - Hail">Roof - Hail</option><option value="Roof - Wind">Roof - Wind</option><option value="Siding - Hail">Siding - Hail</option><option value="Siding - Wind">Siding - Wind</option><option value="Full Exterior">Full Exterior</option>
            </select>
            <button class="btn btn-orange wg-btn-p816" data-w-action="quickAddLead">Add →</button>
          </div>
        </div>`;
    }},

  {id:'quick-draw', name:'Quick Draw', icon:'✏️', cat:'Tools & Quick Actions', size:'sm',
    render(el){
      el.innerHTML = `
        <input type="text" id="w-qd-addr" placeholder="Address to measure..." class="wg-input wg-mb8">
        <button class="btn btn-orange wg-btn-full" data-w-action="quickDraw">📏 Open Drawing Tool</button>`;
    }},

  {id:'ask-joe-mini', name:'Ask Joe', icon:'🤠', cat:'Tools & Quick Actions', size:'md',
    render(el){
      el.innerHTML = `
        <div id="w-joe-response" class="wg-joe-out">Ask Joe anything about sales, claims, or your pipeline.</div>
        <div class="wg-row6">
          <input type="text" id="w-joe-input" placeholder="Ask Joe..." class="wg-input-flex" data-w-keydown="askJoe">
          <button class="btn btn-orange wg-btn-p812" data-w-action="askJoe">Ask</button>
        </div>`;
    }},

  {id:'recent-estimates', name:'Recent Estimates', icon:'📋', cat:'Tools & Quick Actions', size:'sm',
    render(el){
      const ests = (window._estimates || []).slice(-3).reverse();
      if(!ests.length) { el.innerHTML = '<div class="w-empty">No estimates yet</div>'; return; }
      el.innerHTML = ests.map(e => `
        <div class="w-lead-row" data-w-goto="est">
          <div class="w-lead-name">${esc(e.address || e.addr || 'Estimate')}</div>
          <div class="wg-orange-10">${e.total ? '$'+parseFloat(e.total).toLocaleString() : '—'}</div>
        </div>`).join('');
    }},

  {id:'recent-docs', name:'Recent Documents', icon:'📄', cat:'Tools & Quick Actions', size:'sm',
    render(el){
      el.innerHTML = `
        <div class="w-lead-row" data-w-goto="docs"><div class="w-lead-name">Template Library</div><div class="wg-meta">24 templates</div></div>
        <button class="btn btn-ghost wg-btn-full-sm" data-w-goto="docs">Open Template Library →</button>`;
    }},

  {id:'booking-link', name:'Booking Link', icon:'🔗', cat:'Tools & Quick Actions', size:'sm',
    render(el){
      const cal = JSON.parse(localStorage.getItem('nbd_cal_settings') || '{}');
      const url = cal.username ? `https://cal.com/${cal.username}/${cal.eventSlug||'roof-inspection'}` : '';
      if(!url) { el.innerHTML = '<div class="w-empty">Set up Cal.com first</div>'; return; }
      el.innerHTML = `
        <div class="wg-link-text">${url}</div>
        <div class="wg-row4">
          <button class="w-mini-btn wg-grow" data-w-action="copyToClipboard" data-w-id="${url}">📋 Copy</button>
          <button class="w-mini-btn wg-grow" data-w-action="smsBookLink" data-w-id="${url}">💬 SMS</button>
        </div>`;
    }},

  // ═══ MOTIVATION & TRACKING ═══
  {id:'north-star', name:'North Star Goal', icon:'⭐', cat:'Motivation & Tracking', size:'sm',
    render(el){
      const cfg = JSON.parse(localStorage.getItem('nbd_ds_config') || '{}');
      const goal = cfg.northStar || 'Set your North Star in Settings → Daily OS';
      const deadline = cfg.northStarDeadline || '';
      el.innerHTML = `
        <div class="wg-headline">${esc(goal)}</div>
        ${deadline ? `<div class="wg-meta">Deadline: ${esc(deadline)}</div>` : ''}`;
    }},

  {id:'daily-floors', name:'Daily Floors', icon:'📏', cat:'Motivation & Tracking', size:'md',
    render(el){
      const cfg = JSON.parse(localStorage.getItem('nbd_ds_config') || '{}');
      const floors = cfg.floors || [{label:'Doors Knocked',target:30,unit:''},{label:'Contacts Made',target:10,unit:''},{label:'Appts Set',target:3,unit:''}];
      // LOCAL date — daily-success writes this key with todayKey() (local);
      // the UTC date read 0 / locked every evening after 8pm ET.
      const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      const progress = JSON.parse(localStorage.getItem('nbd_floor_progress_'+today) || '{}');
      el.innerHTML = floors.map((f,i) => {
        const val = progress[i] || 0;
        const pct = f.target > 0 ? Math.min(100, val/f.target*100) : 0;
        return `<div class="wg-mb8">
          <div class="wg-between wg-fs10 wg-mb3">
            <span class="wg-bold">${esc(f.label)}</span>
            <span style="color:${pct>=100?'var(--green)':'var(--m)'};">${val} / ${f.target}</span>
          </div>
          <div class="w-bar-track"><div class="w-bar-fill" style="width:${pct}%;${pct>=100?'background:var(--green);':''}"></div></div>
        </div>`;
      }).join('') + `<button class="w-mini-btn wg-w100 wg-mt4" data-w-action="openDailyTracker">Open Daily Tracker →</button>`;
    }},

  {id:'streak-counter', name:'Streak Counter', icon:'🔥', cat:'Motivation & Tracking', size:'sm',
    render(el){
      const streak = parseInt(localStorage.getItem('nbd_streak') || '0');
      el.innerHTML = `
        <div class="wg-center">
          <div class="wg-big">${streak > 0 ? '🔥' : '❄️'}</div>
          <div class="w-big-num wg-fs36">${streak}</div>
          <div class="w-sub">${streak === 1 ? 'day streak' : 'day streak'}</div>
          <div class="wg-foot">${streak >= 7 ? 'Unstoppable!' : streak >= 3 ? 'Keep it going!' : 'Build momentum!'}</div>
        </div>`;
    }},

  {id:'quote-widget', name:'Daily Quote', icon:'💬', cat:'Motivation & Tracking', size:'sm',
    render(el){
      const quotes = [
        {q:"The fortune is in the follow-up.",a:"Jim Rohn"},
        {q:"Every no gets you closer to a yes.",a:"Mark Cuban"},
        {q:"Don't find customers for your products, find products for your customers.",a:"Seth Godin"},
        {q:"Success is not final, failure is not fatal.",a:"Winston Churchill"},
        {q:"The best time to plant a tree was 20 years ago. The second best time is now.",a:"Chinese Proverb"},
        {q:"Hustle beats talent when talent doesn't hustle.",a:"Ross Simmonds"},
        {q:"You miss 100% of the shots you don't take.",a:"Wayne Gretzky"},
        {q:"Be so good they can't ignore you.",a:"Steve Martin"},
        {q:"The sale begins when the customer says no.",a:"Jeffrey Gitomer"},
        {q:"Your attitude determines your altitude.",a:"Zig Ziglar"},
      ];
      const today = new Date().getDate();
      const q = quotes[today % quotes.length];
      el.innerHTML = `
        <div class="wg-quote">"${q.q}"</div>
        <div class="wg-orange-10 wg-right">— ${q.a}</div>`;
    }},

  {id:'golden-goose', name:'Golden Goose', icon:'🪿', cat:'Motivation & Tracking', size:'sm',
    render(el){
      const cfg = JSON.parse(localStorage.getItem('nbd_ds_config') || '{}');
      const reward = cfg.goldenGoose || 'Set your reward in Settings → Daily OS';
      // LOCAL date — daily-success writes this key with todayKey() (local);
      // the UTC date read 0 / locked every evening after 8pm ET.
      const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      const progress = JSON.parse(localStorage.getItem('nbd_floor_progress_'+today) || '{}');
      const floors = cfg.floors || [];
      const allHit = floors.length > 0 && floors.every((f,i) => (progress[i]||0) >= f.target);
      el.innerHTML = `
        <div class="wg-center">
          <div class="wg-fs36">${allHit ? '🪿✨' : '🪿'}</div>
          <div style="font-size:12px;font-weight:700;color:${allHit?'var(--green)':'var(--t)'};margin:6px 0;">${allHit ? 'UNLOCKED!' : 'Hit all floors to unlock'}</div>
          <div class="wg-quote-by">${esc(reward)}</div>
        </div>`;
    }},

  // ═══ DATA & ANALYTICS ═══
  {id:'damage-type-chart', name:'Pipeline by Damage', icon:'🥧', cat:'Data & Analytics', size:'md',
    render(el){
      const leads = window._leads || [];
      const types = {};
      leads.forEach(l => { const dt = l.damageType || l.damage || 'Unknown'; types[dt] = (types[dt]||0)+1; });
      const entries = Object.entries(types).sort((a,b) => b[1]-a[1]);
      const total = leads.length || 1;
      const colors = ['var(--orange)','var(--blue)','var(--green)','#A855F7','var(--gold)','#EC4899','#06B6D4'];
      el.innerHTML = entries.slice(0,5).map(([ name, count], i) => {
        const pct = (count/total*100).toFixed(0);
        return `<div class="wg-mb6">
          <div class="wg-between wg-fs10 wg-mb2">
            <span class="wg-strong">${esc(name)}</span>
            <span class="wg-muted">${count} (${pct}%)</span>
          </div>
          <div class="w-bar-track"><div class="w-bar-fill" style="width:${pct}%;background:${colors[i%colors.length]};"></div></div>
        </div>`;
      }).join('');
    }},

  {id:'monthly-trend', name:'Monthly Trend', icon:'📉', cat:'Data & Analytics', size:'lg',
    render(el){
      // Generate last 6 months of simulated data from leads
      const leads = window._leads || [];
      const months = [];
      const now = new Date();
      for(let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
        const label = d.toLocaleDateString('en-US',{month:'short'});
        const count = leads.filter(l => {
          const cd = new Date(l.createdAt || 0);
          return cd.getMonth() === d.getMonth() && cd.getFullYear() === d.getFullYear();
        }).length;
        months.push({label, count});
      }
      const max = Math.max(...months.map(m=>m.count), 1);
      el.innerHTML = `
        <div class="wg-bars">
          ${months.map(m => {
            const h = Math.max(8, m.count/max*90);
            return `<div class="wg-bar-col">
              <span class="wg-bar-val">${m.count}</span>
              <div style="width:100%;height:${h}px;background:var(--orange);border-radius:3px 3px 0 0;"></div>
              <span class="wg-bar-lbl">${m.label}</span>
            </div>`;
          }).join('')}
        </div>`;
    }},

  {id:'source-breakdown', name:'Lead Sources', icon:'📡', cat:'Data & Analytics', size:'sm',
    render(el){
      const leads = window._leads || [];
      const sources = {};
      leads.forEach(l => { const s = l.source || 'Direct'; sources[s] = (sources[s]||0)+1; });
      const entries = Object.entries(sources).sort((a,b) => b[1]-a[1]).slice(0,4);
      if(!entries.length) { el.innerHTML = '<div class="w-empty">No source data yet</div>'; return; }
      el.innerHTML = entries.map(([s,c]) => `
        <div class="wg-kv-row">
          <span class="wg-strong">${esc(s)}</span>
          <span class="wg-orange-bold">${c}</span>
        </div>`).join('');
    }},

  {id:'territory-mini', name:'Territory Heat Map', icon:'🗺️', cat:'Data & Analytics', size:'lg',
    render(el){
      el.innerHTML = `<div id="w-mini-heat" class="wg-map wg-map-180"></div>
        <button class="w-mini-btn wg-w100 wg-mt6" data-w-goto="map">Open Full Map →</button>`;
      setTimeout(() => _withLeaflet(() => {
        if(!document.getElementById('w-mini-heat')) return; // widget re-rendered while loading
        if(_wMiniHeat){try{_wMiniHeat.remove();}catch(e){}}
        const leads = window._leads || [];
        const pts = leads.filter(l=>l.lat&&l.lng).map(l=>[l.lat,l.lng]);
        const center = pts.length ? [pts.reduce((s,p)=>s+p[0],0)/pts.length, pts.reduce((s,p)=>s+p[1],0)/pts.length] : [39.07,-84.17];
        const map = L.map('w-mini-heat',{zoomControl:false,attributionControl:false}).setView(center, pts.length>0?11:7);
        _wMiniHeat = map;
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:18}).addTo(map);
        if(pts.length && window.L.heatLayer) L.heatLayer(pts,{radius:20,blur:15,maxZoom:15}).addTo(map);
      }), 100);
    }},
];


// ── UTILITY HELPERS ─────────────────────────────────────────────
function _toMs(v) { if(!v) return 0; if(v.toDate) return v.toDate().getTime(); if(v.seconds) return v.seconds*1000; const d=new Date(v); return isNaN(d)?0:d.getTime(); }

function _timeAgo(date) {
  // Handle Firestore Timestamps, strings, and Date objects
  let d = date;
  if(d && d.toDate) d = d.toDate();
  else if(d && d.seconds) d = new Date(d.seconds * 1000);
  else if(!(d instanceof Date)) d = new Date(d);
  if(isNaN(d.getTime())) return '';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if(s < 0) return 'just now';
  if(s < 60) return 'just now';
  if(s < 3600) return Math.floor(s/60) + 'm ago';
  if(s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}


// ── THURSDAY INBOX (functions/integrations/thursday.js) ─────────
// Reads thursday_calls with the two-scope shape the rules require (own
// userId always; companyId for company_admin/manager/viewer). Actions go
// through the thursdayCallAction callable; the recording through
// getThursdayRecording (base64 → blob:, never a URL).
let _thuCalls = [];
let _thuOpenId = null;
let _thuShowAll = false;
let _thuBlob = {};
let _thuSearch = '';
const _THU_TYPE = { new_lead:'New lead', existing_customer:'Customer', adjuster:'Adjuster', supplier_sub:'Supplier',
  job_seeker:'Job seeker', spam:'Spam', test:'Test', silent:'Silent', unknown:'Needs review' };

function _thuClaims() { return window._userClaims || {}; }
function _thuIsViewer() { return _thuClaims().role === 'viewer'; }
function _thuTenantKey() {
  const c = _thuClaims();
  const uid = window.auth && window.auth.currentUser && window.auth.currentUser.uid;
  return c.companyId || uid || '';
}

async function _thuCallable(name, data) {
  if (!window._functions || !window._httpsCallable) {
    const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    window._functions = window._functions || mod.getFunctions();
    window._httpsCallable = window._httpsCallable || mod.httpsCallable;
  }
  const r = await window._httpsCallable(window._functions, name)(data);
  return r && r.data;
}

// Is Thursday connected for this tenant, and has this user hidden the card?
// Resolved once per page; renderWidgetHome() re-runs when it changes.
let _thuGateState = null; // null = unknown, then { enabled, hidden }
async function _thuResolveGate() {
  const uid = window.auth && window.auth.currentUser && window.auth.currentUser.uid;
  if (!uid || !window.db || !window.getDoc || !window.doc) { _thuGateState = null; return; } // retry on the next Home render
  let enabled = false, hidden = false;
  try {
    const cfg = await window.getDoc(window.doc(window.db, 'thursday_config', _thuTenantKey()));
    enabled = cfg.exists() && cfg.data().enabled !== false;
  } catch (e) { enabled = false; }
  try {
    const us = await window.getDoc(window.doc(window.db, 'userSettings', uid));
    hidden = us.exists() && us.data().hideThursdayWidget === true;
  } catch (e) { hidden = false; }
  const changed = !_thuGateState || _thuGateState.enabled !== enabled || _thuGateState.hidden !== hidden;
  _thuGateState = { enabled, hidden };
  if (changed) renderWidgetHome();
}
async function _thuSetHidden(hidden) {
  const uid = window.auth && window.auth.currentUser && window.auth.currentUser.uid;
  _thuGateState = Object.assign({ enabled: true }, _thuGateState || {}, { hidden });
  if (!uid || !window.setDoc) return;
  try { await window.setDoc(window.doc(window.db, 'userSettings', uid), { hideThursdayWidget: hidden }, { merge: true }); }
  catch (e) { console.warn('[thursday] could not save widget preference', e && e.code); }
}

// ── Home layout + Task Checklist survive sign-out (2026-09-29) ──
// Both lived only in `nbd_home_widgets` / `nbd_home_tasks`, and
// NBDAuth.purgeAccountStorage() deletes every nbd_ key on every sign-out:
// a rep's arranged Home and their checklist reset at each logout and never
// reached their phone. They now live on userSettings/{uid} (owner read/write
// in firestore.rules — no rules change); localStorage is this device's cache.
// First load with no cloud copy lifts this device's copy up once.
const HOME_TASKS_KEY = 'nbd_home_tasks';
let _homeCloudLoaded = false;
let _homeCloudPending = false;

function _cleanWidgetIds(v) {
  if (!Array.isArray(v)) return null;
  const ids = v.filter(x => typeof x === 'string' && x.length <= 60 && WIDGETS.some(w => w.id === x)).slice(0, 60);
  return ids.length ? ids : null;
}
function _cleanTasks(v) {
  if (!Array.isArray(v)) return null;
  return v.filter(x => x && typeof x.t === 'string').slice(0, 100)
    .map(x => ({ t: String(x.t).slice(0, 200), d: x.d === true }));
}
function _readLocal(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
function _writeLocal(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* quota — cloud still has it */ } }

async function _homeCloudSave(patch) {
  const uid = window.auth && window.auth.currentUser && window.auth.currentUser.uid;
  if (!uid || !window.db || !window.setDoc || !window.doc) return false;
  try { await window.setDoc(window.doc(window.db, 'userSettings', uid), patch, { merge: true }); return true; }
  catch (e) { console.warn('[home] could not save to your account', e && e.code); return false; }
}

async function _homeHydrate() {
  if (_homeCloudLoaded || _homeCloudPending) return;
  const uid = window.auth && window.auth.currentUser && window.auth.currentUser.uid;
  if (!uid || !window.db || !window.getDoc || !window.doc) return; // retry on the next Home render
  _homeCloudPending = true;
  let data = null;
  try {
    const snap = await (window.nbdRetryOffline || (f => f()))(() => window.getDoc(window.doc(window.db, 'userSettings', uid)));
    data = snap.exists() ? (snap.data() || {}) : {};
  } catch (e) {
    _homeCloudPending = false;
    return; // a FAILED read never uploads — try again on the next render
  }
  _homeCloudPending = false;
  _homeCloudLoaded = true;
  const cloudIds = _cleanWidgetIds(data.homeWidgets);
  const cloudTasks = _cleanTasks(data.homeTasks);
  const up = {};
  let changed = false;
  if (cloudIds) {
    if (JSON.stringify(cloudIds) !== JSON.stringify(_readLocal(STORAGE_KEY))) { _writeLocal(STORAGE_KEY, cloudIds); changed = true; }
  } else {
    const localIds = _cleanWidgetIds(_readLocal(STORAGE_KEY));
    if (localIds) up.homeWidgets = localIds;
  }
  if (cloudTasks) {
    if (JSON.stringify(cloudTasks) !== JSON.stringify(_readLocal(HOME_TASKS_KEY))) { _writeLocal(HOME_TASKS_KEY, cloudTasks); changed = true; }
  } else {
    const localTasks = _cleanTasks(_readLocal(HOME_TASKS_KEY));
    if (localTasks && localTasks.length) up.homeTasks = localTasks;
  }
  // Daily Success settings ride on the same doc (ds-firebase-sync.js writes
  // them from the program page). The North Star / Daily Floors / Golden Goose
  // widgets read nbd_ds_config, which sign-out wipes — restore it here so they
  // don't sit on placeholders until the program page is opened.
  const dsKeys = [['nbd_user_config', 'dsConfig'], ['nbd_gt', 'dsGoalTargets']];
  for (const [key, field] of dsKeys) {
    const cv = data[field];
    const cloudAt = Number(data[field + 'At']) || 0;
    const localVal = _readLocal(key);
    const localAt = Number(localStorage.getItem(key + '_at')) || 0;
    if (cv && typeof cv === 'object' && (localVal == null || cloudAt > localAt)) {
      if (JSON.stringify(cv) !== JSON.stringify(localVal)) {
        _writeLocal(key, cv);
        try { localStorage.setItem(key + '_at', String(cloudAt || Date.now())); } catch (e) {}
        if (key === 'nbd_user_config') {
          // Same shape as ds-sync-logic.js widgetCfgFrom / app.js syncToWidgetKeys.
          const ns = cv.northStar || {};
          _writeLocal('nbd_ds_config', {
            northStar: ns.target || ns.category || '',
            northStarDeadline: ns.deadline || '',
            floors: (cv.floors || []).map(f => ({ label: f.label, target: parseFloat(f.targetValue) || 1, unit: f.unit || '' })),
            goldenGoose: cv.goose || '',
          });
        }
        changed = true;
      }
    } else if (localVal && typeof localVal === 'object' && (!cv || localAt > cloudAt)) {
      // First backup of settings that only ever lived on this device.
      up[field] = localVal;
      up[field + 'At'] = localAt || Date.now();
    }
  }
  if (Object.keys(up).length) _homeCloudSave(up);
  if (changed) renderWidgetHome();
}

function _getHomeTasks() {
  const t = _cleanTasks(_readLocal(HOME_TASKS_KEY));
  if (t && t.length) return t;
  return [{t:'Follow up on yesterday\'s leads',d:false},{t:'Send 3 estimates',d:false},{t:'Update pipeline stages',d:false},{t:'Check storm reports',d:false}];
}
function _saveHomeTasks(tasks) {
  const clean = _cleanTasks(tasks) || [];
  _writeLocal(HOME_TASKS_KEY, clean);
  _homeCloudSave({ homeTasks: clean });
}

async function _thuFetch() {
  const db = window.db;
  const uid = window.auth && window.auth.currentUser && window.auth.currentUser.uid;
  if (!db || !uid || !window.query) return [];
  const c = _thuClaims();
  const col = window.collection(db, 'thursday_calls');
  const qs = [window.query(col, window.where('userId', '==', uid), window.orderBy('startedAt', 'desc'), window.limit(25))];
  if (['company_admin', 'manager', 'viewer'].includes(c.role || '') && c.companyId) {
    qs.push(window.query(col, window.where('companyId', '==', c.companyId), window.orderBy('startedAt', 'desc'), window.limit(25)));
  }
  const byId = {};
  for (const q of qs) {
    try {
      const snap = await window.getDocs(q);
      snap.docs.forEach(d => { byId[d.id] = Object.assign({ _id: d.id }, d.data()); });
    } catch (e) { console.warn('[thursday] read failed', e && e.code); }
  }
  return Object.values(byId).sort((a, b) => _toMs(b.startedAt || b.createdAt) - _toMs(a.startedAt || a.createdAt)).slice(0, 25);
}

function _thuBadge(text, bg, fg) {
  return '<span style="display:inline-block;font-size:9px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:1px 6px;border-radius:999px;background:' + bg + ';color:' + fg + ';margin-right:3px;">' + esc(text) + '</span>';
}
function _thuIdOf(c) { return c.callId || String(c._id || '').replace(/^bland_calls__/, ''); }

function _thuRow(c) {
  const id = _thuIdOf(c);
  const ex = c.extraction || {};
  const action = c.route && c.route.action;
  let badges = '';
  if (c.urgent) badges += _thuBadge('Urgent', '#7f1d1d', '#fecaca');
  if (action === 'create_lead') badges += _thuBadge('New lead', '#14532d', '#bbf7d0');
  else if (action === 'possible_match') badges += _thuBadge('Possible match', '#78350f', '#fde68a');
  else if (action === 'attach') badges += _thuBadge('Attached', 'var(--s3,rgba(255,255,255,.08))', 'var(--m)');
  else if (c.status === 'failed') badges += _thuBadge('Needs review', '#7f1d1d', '#fecaca');
  else badges += _thuBadge(_THU_TYPE[c.callerType] || 'Call', 'var(--s3,rgba(255,255,255,.08))', 'var(--m)');
  const who = ex.caller_name || c.callerName || c.from || 'Caller';
  const town = ex.town || c.town || '';
  const unread = !c.reviewed;
  let html = '<div class="w-lead-row" data-w-action="thuToggle" data-w-id="' + esc(id) + '" style="display:block;cursor:pointer;' + (unread ? 'border-left:3px solid var(--orange);padding-left:8px;' : 'opacity:.8;') + '">' +
    '<div class="wg-between-c8">' +
      '<div style="min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:' + (unread ? '700' : '500') + ';font-size:12px;color:var(--t);">' + esc(who) + (town ? ' <span class="wg-muted-normal">· ' + esc(town) + '</span>' : '') + '</div>' +
      '<div class="wg-meta wg-nowrap">' + esc(_timeAgo(c.startedAt || c.createdAt)) + '</div>' +
    '</div>' +
    '<div class="wg-mt2">' + badges + '</div>' +
    '<div class="wg-sub-clip">' + esc(c.issue || (c.call && c.call.summary) || '') + '</div>' +
  '</div>';
  if (_thuOpenId === id) html += _thuDetail(c, id);
  return html;
}

function _thuDetail(c, id) {
  const ex = c.extraction || {};
  const action = c.route && c.route.action;
  const viewer = _thuIsViewer();
  const btn = (act, label, extra, primary) => '<button type="button" class="' + (primary ? 'btn btn-orange' : 'w-mini-btn') + ' wg-btn-p610" data-w-action="' + act + '" data-w-id="' + esc(id) + '"' + (extra || '') + '>' + label + '</button>';
  const facts = [];
  const phone = ex.callback_number ? ex.callback_number.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3') : (c.from || '');
  if (phone) facts.push('📱 <a href="tel:' + esc(String(phone).replace(/[^\d+]/g, '')) + '" data-w-stop="1">' + esc(phone) + '</a>');
  if (ex.callback_window) facts.push('🕑 ' + esc(ex.callback_window));
  if (ex.address || ex.town) facts.push('📍 ' + esc([ex.address, ex.town, ex.zip].filter(Boolean).join(', ')));
  if (ex.insurance && ex.insurance.involved === 'yes') facts.push('🛡 ' + esc(ex.insurance.carrier || 'Insurance') + (ex.insurance.claim_filed === 'yes' ? ' · claim filed' : ''));
  if (ex.urgent_reason) facts.push('🚨 ' + esc(ex.urgent_reason));
  const acts = [];
  if (c.leadId) acts.push(btn('thuOpenLead', 'Open customer →', ' data-lead-id="' + esc(c.leadId) + '"', true));
  if (c.recordingPath) acts.push(btn('thuPlay', '▶ Play'));
  if (!viewer) {
    if (action === 'possible_match') {
      (c.route.possibleMatches || []).slice(0, 3).forEach(pm => acts.push(btn('thuConfirm', 'Yes — ' + esc(pm.name), ' data-lead-id="' + esc(pm.leadId) + '"')));
      acts.push(btn('thuCreate', 'Not them — new lead'));
    } else if (!c.leadId && c.extraction && action !== 'log_only') {
      acts.push(btn('thuCreate', '＋ Create lead', '', true));
    }
    if (c.extraction && (!c.leadId || action === 'possible_match')) acts.push(btn('thuAttachOpen', 'Attach to…'));
    if (c.status === 'failed') acts.push(btn('thuReprocess', '↻ Reprocess'));
    acts.push(btn('thuReviewed', c.reviewed ? 'Mark unread' : '✓ Done', ' data-reviewed="' + (c.reviewed ? '1' : '0') + '"'));
  }
  let attach = '';
  if (_thuOpenId === id && _thuSearch !== null && _thuSearch !== undefined && _thuSearch !== '' ) {
    const q = _thuSearch.trim().toLowerCase();
    const hits = !q ? [] : (window._leads || []).filter(l => !l.deleted && ((l.firstName || '') + ' ' + (l.lastName || '') + ' ' + (l.name || '') + ' ' + (l.address || '')).toLowerCase().indexOf(q) !== -1).slice(0, 6);
    attach = hits.map(l => btn('thuAttach', esc(((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || l.address || 'Lead') + ' <span class="wg-o6">' + esc((l.address || '').slice(0, 30)) + '</span>', ' data-lead-id="' + esc(l.id) + '"')).join('');
  }
  const transcript = (c.call && c.call.transcript) || '';
  return '<div data-w-stop="1" class="wg-panel">' +
    (c.call && c.call.summary ? '<div class="wg-mb6">' + esc(c.call.summary) + '</div>' : '') +
    (facts.length ? '<div class="wg-facts">' + facts.join('') + '</div>' : '') +
    '<div class="wg-wrap6">' + acts.join('') + '</div>' +
    '<div id="thu-attach-' + esc(id) + '" style="display:' + (_thuSearch !== '' && _thuOpenId === id ? 'block' : 'none') + ';margin-top:8px;">' +
      '<input type="text" placeholder="Search leads by name or address…" data-w-input="thuSearch" data-w-id="' + esc(id) + '" value="' + esc(_thuSearch || '') + '" class="wg-search">' +
      '<div class="wg-col4 wg-mt6">' + attach + '</div>' +
    '</div>' +
    '<div id="thu-audio-' + esc(id) + '" class="wg-mt6"></div>' +
    '<div id="thu-status-' + esc(id) + '" class="wg-sub"></div>' +
    (transcript ? '<details class="wg-mt6"><summary class="wg-summary">Transcript</summary><div class="wg-transcript">' + esc(transcript) + '</div></details>' : '') +
  '</div>';
}

function _thuDraw(el) {
  if (!el) el = document.getElementById('wb-thursday-calls');
  if (!el) return;
  const list = _thuShowAll ? _thuCalls : _thuCalls.filter(c => !(c.route && c.route.action === 'log_only'));
  const unread = _thuCalls.filter(c => !c.reviewed).length;
  const hiddenCount = _thuCalls.length - list.length;
  if (!_thuCalls.length) {
    el.innerHTML = '<div class="w-empty">No calls yet. When Thursday answers (513) 940-5589, each call lands here with a summary, the recording, and a lead or task.</div>';
    return;
  }
  el.innerHTML = '<div class="wg-between-c wg-mb6 wg-meta">' +
      '<span>' + (unread ? '<b class="wg-orange">' + unread + ' new</b> · ' : '') + _thuCalls.length + ' recent</span>' +
      (hiddenCount || _thuShowAll ? '<button type="button" class="w-mini-btn wg-fs10" data-w-action="thuShowAll">' + (_thuShowAll ? 'Hide spam/silent' : 'Show ' + hiddenCount + ' spam/silent') + '</button>' : '') +
    '</div>' + list.map(_thuRow).join('');
}

function _thuRender(el) {
  el.innerHTML = '<div class="w-empty">Loading calls…</div>';
  _thuFetch().then(list => { _thuCalls = list; _thuDraw(el); }).catch(() => { el.innerHTML = '<div class="w-empty">Could not load calls.</div>'; });
}

function _thuStatus(id, text) {
  const s = document.getElementById('thu-status-' + id);
  if (s) s.textContent = text;
}

async function _thuAct(id, action, extra) {
  _thuStatus(id, 'Working…');
  try {
    const r = await _thuCallable('thursdayCallAction', Object.assign({ callId: id, action }, extra || {}));
    if ((action === 'create_lead' || action === 'attach_to' || action === 'confirm_match') && r && r.leadId) {
      if (typeof showToast === 'function') showToast(action === 'create_lead' ? 'Lead created' : 'Call attached', 'ok');
    }
    _thuCalls = await _thuFetch();
    _thuSearch = '';
    _thuDraw();
    return r;
  } catch (e) {
    _thuStatus(id, (e && e.message) || 'That did not work.');
    return null;
  }
}

async function _thuPlay(id) {
  const slot = document.getElementById('thu-audio-' + id);
  if (!slot) return;
  if (!_thuBlob[id]) {
    _thuStatus(id, 'Loading recording…');
    try {
      // Streamed in parts (5 MB each; a 10-minute WAV is two).
      const chunks = [];
      let type = 'audio/mpeg', parts = 1;
      for (let part = 0; part < parts; part++) {
        const r = await _thuCallable('getThursdayRecording', { callId: id, part });
        parts = r.parts || 1;
        type = r.contentType || type;
        const bin = atob(r.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        chunks.push(bytes);
      }
      _thuBlob[id] = URL.createObjectURL(new Blob(chunks, { type }));
      _thuStatus(id, '');
    } catch (e) { _thuStatus(id, 'Could not load the recording.'); return; }
  }
  slot.innerHTML = '';
  const a = document.createElement('audio');
  a.controls = true; a.style.width = '100%'; a.src = _thuBlob[id];
  slot.appendChild(a);
  a.play().catch(() => {});
}

// ── WIDGET STATE (localStorage) ─────────────────────────────────
const STORAGE_KEY = 'nbd_home_widgets';
// The DEFAULT set only (2026-10-03): Quote, Streak and North Star kept their
// state in browser storage the sign-out wipe clears, and Radar pulled Leaflet
// + map tiles on every Home paint — they are no longer pre-placed. A user who
// added them keeps them (a saved list is never rewritten); all four stay in
// the picker. Today's Schedule now shows real items, so it is on by default.
const DEFAULT_WIDGETS = ['today-schedule','pipeline-value','hot-leads','win-rate','revenue-month','task-checklist',
  'daily-floors','quick-add-lead','recent-activity'];

function getActiveWidgets() {
  let ids = null;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if(saved && saved.length) ids = saved;
  } catch(e) {}
  if (!ids) ids = [...DEFAULT_WIDGETS];
  // Thursday inbox: pinned first for a tenant with Thursday connected, unless
  // this user removed it (userSettings/{uid}.hideThursdayWidget — survives
  // the logout wipe of nbd_ localStorage). Never shown to other tenants.
  const thu = _thuGateState;
  ids = ids.filter(x => x !== 'thursday-calls' || (thu && thu.enabled && !thu.hidden));
  if (thu && thu.enabled && !thu.hidden) ids = ['thursday-calls'].concat(ids.filter(x => x !== 'thursday-calls'));
  return ids;
}

function saveActiveWidgets(ids) {
  _writeLocal(STORAGE_KEY, ids);
  const clean = _cleanWidgetIds(ids);
  if (clean) _homeCloudSave({ homeWidgets: clean });
}


// ── RENDER ENGINE ───────────────────────────────────────────────
function renderWidgetHome() {
  const grid = document.getElementById('widgetGrid');
  if(!grid) return;
  if (_thuGateState === null) { _thuGateState = { enabled: false, hidden: false, pending: true }; _thuResolveGate(); }
  if (!_homeCloudLoaded) _homeHydrate();

  const activeIds = getActiveWidgets();
  grid.innerHTML = '';

  activeIds.forEach(id => {
    const w = WIDGETS.find(x => x.id === id);
    if(!w) return;

    // Widget → view navigation map. Clicking ANY widget card takes
    // you to a relevant view. Specific widgets get specific targets,
    // everything else defaults to 'crm' since that's where the data
    // lives for most pipeline/sales metrics.
    const NAV_MAP = {
      'pipeline-value': 'crm', 'hot-leads': 'crm', 'win-rate': 'crm',
      'revenue-month': 'crm', 'task-checklist': 'crm', 'stale-leads': 'crm',
      'close-board': 'closeboard', 'source-breakdown': 'crm',
      'stage-funnel': 'crm', 'recent-activity': 'crm', 'recent-estimates': 'est',
      'recent-docs': 'docs', 'damage-type-chart': 'crm', 'monthly-trend': 'crm',
      'd2d-summary': 'd2d', 'd2d-kpi': 'd2d', 'door-knock-heat': 'd2d',
      'weather-radar': 'd2d', 'storm-alerts': 'storm',
      'quick-estimate': 'est', 'quick-draw': 'draw', 'booking-link': 'schedule',
      'ask-joe-mini': 'joe', 'team-leaderboard': 'board',
      // 'material-watch' dropped with the widget itself (see above). This map
      // is keyed by widget id, so a stale entry is harmless — removed anyway so
      // the next reader doesn't go looking for a widget that isn't there.
      'today-schedule': 'schedule', 'yard-signs': 'signs'
    };
    const card = document.createElement('div');
    card.className = 'w-card w-' + w.size;
    card.dataset.widgetId = w.id;
    // EVERY widget is clickable — NAV_MAP for specific targets,
    // default to 'crm' for anything not explicitly mapped.
    const navTarget = NAV_MAP[w.id] || 'crm';
    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      // NEW-C9: only the card CHROME (header/body padding) navigates.
      // Any click that lands on an interactive inner control — a
      // delegated button/row (data-w-action / data-w-goto), the remove
      // ✕, an opt-out marker (data-w-stop), or a native form control
      // (input/select/textarea/button/label/a) — must NOT bounce the
      // user to /crm. We bail HERE (in the per-card listener) rather
      // than via stopPropagation in the document delegate, because the
      // card listener fires first on bubble, so a document-level stop
      // would run too late to cancel this navigation.
      if (e.target.closest(
        '.w-card-remove,[data-w-action],[data-w-goto],[data-w-stop],' +
        'input,select,textarea,button,label,a'
      )) return;
      if (typeof window.goTo === 'function') window.goTo(navTarget);
    });
    card.innerHTML = `
      <div class="w-card-hdr">
        <span class="w-card-icon">${w.icon}</span>
        <span class="w-card-title">${w.name}</span>
        <button class="w-card-remove" data-w-action="removeWidget" data-w-id="${w.id}" data-w-stop="1" title="Remove widget">✕</button>
      </div>
      <div class="w-card-body" id="wb-${w.id}"></div>`;
    grid.appendChild(card);

    // Render widget content
    try { w.render(document.getElementById('wb-' + w.id)); }
    catch(e) { document.getElementById('wb-' + w.id).innerHTML = '<div class="w-empty">Error loading widget</div>'; }
  });

  // Add the "Add Widget" card
  const addCard = document.createElement('div');
  addCard.className = 'w-card w-sm w-add-card';
  addCard.onclick = () => window.NBDWidgets.openPicker();
  addCard.innerHTML = `<div class="wg-add">
    <div class="wg-add-plus">＋</div>
    <div class="wg-sub">Add Widget</div>
  </div>`;
  grid.appendChild(addCard);
}


// ── WIDGET PICKER MODAL ─────────────────────────────────────────
function openWidgetPicker() {
  const activeIds = getActiveWidgets();
  const cats = [...new Set(WIDGETS.map(w => w.cat))];

  let html = `<div class="w-picker-overlay" id="wPickerOverlay" data-w-action="closePickerIfSelf">
    <div class="w-picker">
      <div class="w-picker-hdr">
        <div>
          <div class="wg-kicker">Customize Home</div>
          <div class="wg-num">Widget Library</div>
        </div>
        <button class="wg-close" data-w-action="closePicker">✕</button>
      </div>
      <div class="w-picker-body">`;

  cats.forEach(cat => {
    const catWidgets = WIDGETS.filter(w => w.cat === cat);
    html += `<div class="w-picker-cat">${cat}</div>`;
    catWidgets.forEach(w => {
      const isActive = activeIds.includes(w.id);
      html += `<label class="w-picker-row ${isActive ? 'w-picker-active' : ''}">
        <input type="checkbox" ${isActive ? 'checked' : ''} data-w-change="toggleWidget" data-w-id="${w.id}">
        <span class="w-picker-icon">${w.icon}</span>
        <span class="w-picker-name">${w.name}</span>
        <span class="w-picker-size">${w.size}</span>
      </label>`;
    });
  });

  html += `</div>
      <div class="w-picker-footer">
        <button class="btn btn-ghost wg-btn-p814" data-w-action="resetDefaults">Reset to Defaults</button>
        <button class="btn btn-orange wg-btn-p820" data-w-action="closePicker">Done</button>
      </div>
    </div>
  </div>`;

  const container = document.createElement('div');
  container.id = 'wPickerContainer';
  container.innerHTML = html;
  document.body.appendChild(container);
}

function closePicker() {
  const c = document.getElementById('wPickerContainer');
  if(c) c.remove();
}


// ── WIDGET MANAGEMENT ───────────────────────────────────────────
function toggleWidget(id, on) {
  if (id === 'thursday-calls') _thuSetHidden(!on);
  let active = getActiveWidgets();
  if(on && !active.includes(id)) active.push(id);
  if(!on) active = active.filter(x => x !== id);
  saveActiveWidgets(active);
  renderWidgetHome();
}

function removeWidget(id) {
  if (id === 'thursday-calls') _thuSetHidden(true);
  let active = getActiveWidgets().filter(x => x !== id);
  saveActiveWidgets(active);
  renderWidgetHome();
  showToast('Widget removed', 'info');
}

function resetDefaults() {
  saveActiveWidgets([...DEFAULT_WIDGETS]);
  closePicker();
  renderWidgetHome();
  showToast('Widgets reset to defaults', 'ok');
}


// ── WIDGET INTERACTION HELPERS (global) ─────────────────────────
_wToggleTask = function(idx, done) {
  const tasks = _getHomeTasks();
  if(tasks[idx]) tasks[idx].d = !!done;
  _saveHomeTasks(tasks);
  renderWidgetHome();
};

_wAddTask = function() {
  const input = document.getElementById('w-task-input');
  if(!input || !input.value.trim()) return;
  const tasks = _cleanTasks(_readLocal(HOME_TASKS_KEY)) || [];
  tasks.push({t: input.value.trim(), d: false});
  _saveHomeTasks(tasks);
  renderWidgetHome();
};

_wQuickEst = function() {
  const sqft = parseFloat(document.getElementById('w-qe-sqft')?.value || 0);
  const rate = parseFloat(document.getElementById('w-qe-rate')?.value || 350);
  const squares = sqft / 100;
  const total = squares * rate;
  const el = document.getElementById('w-qe-result');
  if(el) el.textContent = '$' + total.toLocaleString(undefined, {maximumFractionDigits:0});
};

_wQuickAddLead = function() {
  const name = document.getElementById('w-ql-name')?.value?.trim();
  const addr = document.getElementById('w-ql-addr')?.value?.trim();
  const damage = document.getElementById('w-ql-damage')?.value;
  if(!addr) { showToast('Enter an address','error'); return; }
  // Trigger the lead modal if available
  if(window.openLeadModal) {
    openLeadModal();
    // Prefill the real Add Lead modal fields (#lFname/#lLname/#lAddr/#lDamageType).
    // Mirrors the D2D knock->lead prefill idiom in d2d-tracker-core-2026b.js:
    // split the single homeowner name into first/last, fill after open.
    setTimeout(() => {
      const firstName = (name || '').split(' ')[0] || '';
      const lastName  = (name || '').split(' ').slice(1).join(' ') || '';
      const fill = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
      fill('lFname', firstName);
      fill('lLname', lastName);
      fill('lAddr', addr);
      // #lDamageType is a <select>; assigning an unmatched value is a silent
      // no-op (leaves the placeholder), so this degrades gracefully.
      const dmgEl = document.getElementById('lDamageType'); if(dmgEl && damage) dmgEl.value = damage;
    }, 100);
  }
  showToast('Opening lead form...','info');
};

_wQuickDraw = function() {
  const addr = document.getElementById('w-qd-addr')?.value?.trim();
  if(window.goTo) goTo('draw');
  if(addr) {
    setTimeout(() => {
      const el = document.getElementById('drawSearch');
      if(el) { el.value = addr; if(window.searchDraw) searchDraw(); }
    }, 200);
  }
};

_wAskJoe = function() {
  const input = document.getElementById('w-joe-input');
  if(!input || !input.value.trim()) return;
  const q = input.value.trim();
  input.value = '';
  const resp = document.getElementById('w-joe-response');
  if(resp) resp.innerHTML = '<div class="wg-orange">Thinking...</div>';
  // If Joe AI is available, use it
  if(window.sendJoeMessage) {
    // Redirect to full Joe
    goTo('joe');
    setTimeout(() => {
      const joeInput = document.querySelector('.joe-input-area textarea');
      if(joeInput) { joeInput.value = q; sendJoeMessage(); }
    }, 200);
  } else {
    if(resp) resp.innerHTML = '<div class="wg-muted">Open Ask Joe for full AI chat →</div>';
  }
};


// ── PUBLIC API ──────────────────────────────────────────────────
// Today's Schedule follows the Today list: today-home.js paints the plan,
// then this widget repaints from it (2026-10-03).
if (typeof window.addEventListener === 'function') window.addEventListener('nbd:today-rendered', () => {
  const el = document.getElementById('wb-today-schedule');
  const w = WIDGETS.find(x => x.id === 'today-schedule');
  if (el && w) { try { w.render(el); } catch (_) { /* a widget never breaks Home */ } }
});

window.NBDWidgets = {
  WIDGETS,
  render: renderWidgetHome,
  openPicker: openWidgetPicker,
  closePicker: closePicker,
  toggleWidget,
  removeWidget,
  resetDefaults,
  getActive: getActiveWidgets,
  // Test hooks (tests/home-widgets-survive-signout-2026-09-29.test.js).
  _home: {
    hydrate: _homeHydrate, getTasks: _getHomeTasks, saveTasks: _saveHomeTasks,
    saveActive: saveActiveWidgets, toggleTask: (i, d) => _wToggleTask(i, d),
    loaded: () => _homeCloudLoaded,
  },
};

// Home first paints on DOMContentLoaded, before auth, with window._leads
// empty ($0 / "0 leads"). Repaint when the lead cache lands instead of
// relying only on the end of the bootstrap render chain. Leads source only,
// and never mid-typing — a rebuild would wipe Quick Add / task inputs.
if (typeof window.addEventListener === 'function') window.addEventListener('nbd:data-refreshed', (ev) => {
  const src = ev && ev.detail && ev.detail.source;
  if (src !== 'leads') return;
  const grid = document.getElementById('widgetGrid');
  if (!grid) return;
  if (grid.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  try { renderWidgetHome(); } catch (e) { console.warn('[widgets] repaint on leads refresh failed:', e.message); }
});

// ── CSP-SAFE EVENT DELEGATION ──────────────────────────────────
// Prod CSP `script-src-attr 'none'` blocks every inline onclick=, even
// when injected via innerHTML. Widgets render through innerHTML, so
// every button used to be dead in prod. Single document-level click
// listener (addEventListener is NOT blocked by CSP) dispatches based on
// `data-w-action="X"` / `data-w-goto="X"` / `data-w-id="..."` attrs.

const _wActions = {
  addTask:        () => { if (typeof _wAddTask === 'function') _wAddTask(); },
  quickAddLead:   () => { if (typeof _wQuickAddLead === 'function') _wQuickAddLead(); },
  quickDraw:      () => { if (typeof _wQuickDraw === 'function') _wQuickDraw(); },
  askJoe:         () => { if (typeof _wAskJoe === 'function') _wAskJoe(); },
  copyToClipboard: (url) => { if (url) { navigator.clipboard.writeText(url); if (typeof showToast === 'function') showToast('Copied!','ok'); } },
  smsBookLink:    (url) => { if (url) window.open('sms:?body=' + encodeURIComponent('Book here: ' + url)); },
  openDailyTracker: () => window.open('/pro/daily-success/', '_self'),
  removeWidget:   (id) => window.NBDWidgets.removeWidget(id),
  closePicker:    () => window.NBDWidgets.closePicker(),
  closePickerIfSelf: (_id, ev, target) => { if (ev && ev.target === target) window.NBDWidgets.closePicker(); },
  resetDefaults:  () => window.NBDWidgets.resetDefaults(),
  // Thursday inbox (see _thuRender).
  thuToggle:      (id) => { _thuOpenId = _thuOpenId === id ? null : id; _thuSearch = ''; _thuDraw(); },
  thuShowAll:     () => { _thuShowAll = !_thuShowAll; _thuDraw(); },
  thuOpenLead:    (_id, _ev, t) => { const l = t && t.dataset.leadId; if (l) window.location.href = '/pro/customer.html?id=' + encodeURIComponent(l); },
  thuPlay:        (id) => _thuPlay(id),
  thuReviewed:    (id, _ev, t) => _thuAct(id, t && t.dataset.reviewed === '1' ? 'mark_unreviewed' : 'mark_reviewed'),
  thuReprocess:   (id) => _thuAct(id, 'reprocess'),
  thuCreate:      async (id) => { const r = await _thuAct(id, 'create_lead'); if (r && r.leadId) window.location.href = '/pro/customer.html?id=' + encodeURIComponent(r.leadId); },
  thuConfirm:     (id, _ev, t) => _thuAct(id, 'confirm_match', { leadId: t && t.dataset.leadId }),
  thuAttachOpen:  (id) => { _thuOpenId = id; _thuSearch = ' '; _thuDraw(); const i = document.querySelector('[data-w-input="thuSearch"]'); if (i) { i.value = ''; i.focus(); } },
  thuAttach:      (id, _ev, t) => _thuAct(id, 'attach_to', { leadId: t && t.dataset.leadId }),
};

// CSP-dead inline on* on rendered inputs/checkboxes have the same
// problem as onclick=: script-src-attr 'none' blocks them. These
// handlers are dispatched by the change/input/keydown delegates below.
// Signature mirrors _wActions: (wId, ev, target).
const _wChange = {
  toggleTask:   (_id, ev, target) => { if (typeof _wToggleTask === 'function') _wToggleTask(parseInt(target.dataset.wIdx, 10), target.checked); },
  toggleWidget: (id, ev, target) => { window.NBDWidgets.toggleWidget(id, target.checked); },
};
const _wInput = {
  quickEst:     () => { if (typeof _wQuickEst === 'function') _wQuickEst(); },
  // Thursday "Attach to…" lead search: redraw the result list, keep focus.
  thuSearch:    (_id, _ev, target) => {
    _thuSearch = target.value || ' ';
    const pos = target.selectionStart;
    _thuDraw();
    const i = document.querySelector('[data-w-input="thuSearch"]');
    if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (e) {} }
  },
};
const _wKeydown = {
  askJoe:       (_id, ev) => { if (ev && ev.key === 'Enter') { ev.preventDefault(); if (typeof _wAskJoe === 'function') _wAskJoe(); } },
};

if (!_NBD_WIDGETS_DELEGATE_BOUND) {
  _NBD_WIDGETS_DELEGATE_BOUND = true;
  document.addEventListener('click', function (ev) {
    const t = ev.target.closest && ev.target.closest('[data-w-action], [data-w-goto]');
    if (!t) return;
    if (t.dataset.wStop === '1') ev.stopPropagation();
    if (t.dataset.wGoto) {
      if (typeof window.goTo === 'function') window.goTo(t.dataset.wGoto);
      return;
    }
    const fn = _wActions[t.dataset.wAction];
    if (!fn) { console.warn('[widgets] no dispatch for', t.dataset.wAction); return; }
    try {
      fn(t.dataset.wId, ev, t);
    } catch (e) {
      console.error('[widgets] dispatch ' + t.dataset.wAction + ' failed:', e);
    }
  });

  // Non-click delegates: checkboxes/inputs need 'change'/'input', and
  // the Ask-Joe field needs 'keydown'. The click delegate above does
  // NOT see these, so register one listener per event type, each
  // dispatching from its own data-w-* attr + map (same idiom).
  function _wDelegate(attr, map, evName) {
    document.addEventListener(evName, function (ev) {
      const t = ev.target && ev.target.closest && ev.target.closest('[' + attr + ']');
      if (!t) return;
      const key = t.dataset[attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
      const fn = map[key];
      if (!fn) { console.warn('[widgets] no ' + evName + ' dispatch for', key); return; }
      try {
        fn(t.dataset.wId, ev, t);
      } catch (e) {
        console.error('[widgets] ' + evName + ' dispatch ' + key + ' failed:', e);
      }
    });
  }
  _wDelegate('data-w-change', _wChange, 'change');
  _wDelegate('data-w-input', _wInput, 'input');
  _wDelegate('data-w-keydown', _wKeydown, 'keydown');
}

})();
