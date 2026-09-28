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
      const leads = window._leads || [];
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
        const val = parseFloat(l.jobValue || l.estValue || l.value || 0);
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
        <div style="display:flex;border-radius:4px;overflow:hidden;margin-top:10px;gap:1px;">${stageBar || '<div style="flex:1;background:var(--br);height:8px;"></div>'}</div>
        <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:9px;color:var(--m);">
          <span>${leads.filter(_inPlay).length} in play</span><span>${leads.filter(l=>_roleOf(l)==='won').length} won</span>
        </div>`;
    }},

  {id:'hot-leads', name:'Hot Leads', icon:'🔥', cat:'Pipeline & Sales', size:'md',
    render(el){
      const HOT = ['contacted','estimate_submitted','estimate_sent_cash','negotiating','contract_signed'];
      const leads = (window._leads || []).filter(l => {
        const r = _roleOf(l);
        if (r === 'won' || r === 'lost') return false;
        if(l.callback) { const cb = new Date(l.callback); return cb <= new Date(); }
        return HOT.includes(_normStage(l));
      }).slice(0, 5);
      if(!leads.length) { el.innerHTML = '<div class="w-empty">No hot leads right now</div>'; return; }
      el.innerHTML = leads.map(l => {
        const k = _normStage(l);
        const color = k === 'contacted' ? '#A855F7' : (k === 'estimate_submitted' || k === 'estimate_sent_cash') ? '#F97316' : 'var(--m)';
        return `
        <div class="w-lead-row" data-w-goto="crm">
          <div class="w-lead-name">${esc(l.name || l.address || 'Unknown')}</div>
          <div class="w-lead-stage" style="color:${color}">${esc(_stageText(l))}</div>
        </div>`;
      }).join('');
    }},

  {id:'win-rate', name:'Win Rate', icon:'🏆', cat:'Pipeline & Sales', size:'sm',
    render(el){
      const leads = window._leads || [];
      const decided = leads.filter(l => { const r = _roleOf(l); return r === 'won' || r === 'lost'; });
      const won = decided.filter(l => _roleOf(l) === 'won').length;
      const closed = decided;
      const rate = closed.length > 0 ? (won / closed.length * 100) : 0;
      const circumference = 2 * Math.PI * 36;
      const offset = circumference - (rate / 100) * circumference;
      el.innerHTML = `
        <svg width="84" height="84" style="display:block;margin:0 auto 8px;">
          <circle cx="42" cy="42" r="36" stroke="var(--br)" stroke-width="6" fill="none"/>
          <circle cx="42" cy="42" r="36" stroke="var(--orange)" stroke-width="6" fill="none"
            stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" transform="rotate(-90 42 42)" stroke-linecap="round"/>
          <text x="42" y="46" text-anchor="middle" fill="var(--t)" font-family="'Barlow Condensed',sans-serif" font-size="20" font-weight="800">${rate.toFixed(0)}%</text>
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
      const rev = thisMonth.reduce((s,l) => s + parseFloat(l.jobValue || l.estValue || l.value || 0), 0);
      const goal = parseFloat(localStorage.getItem('nbd_monthly_goal') || '50000');
      const pct = goal > 0 ? Math.min(100, rev / goal * 100) : 0;
      // Sweep Pass 4: 'nbd_monthly_goal' was read but never written —
      // no settings UI existed to set it, so the goal was permanently
      // stuck at the hardcoded $50K default. Click-to-edit on the goal
      // text gives the user a way to customize without us having to
      // build a whole settings panel.
      el.innerHTML = `
        <div class="w-big-num" style="color:var(--green);">$${rev >= 1000 ? (rev/1000).toFixed(1)+'k' : rev.toFixed(0)}</div>
        <div class="w-sub">Revenue This Month</div>
        <div class="w-bar-track"><div class="w-bar-fill" style="width:${pct}%"></div></div>
        <div class="w-goal-edit" data-w-stop="1" title="Click to change your monthly goal" style="font-size:9px;color:var(--m);text-align:right;margin-top:3px;cursor:pointer;user-select:none;">${pct.toFixed(0)}% of $${(goal/1000).toFixed(0)}k goal ✎</div>`;
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
          if (typeof window.showToast === 'function') {
            window.showToast('Monthly goal set to $' + (next/1000).toFixed(0) + 'k', 'success');
          }
          // Re-render this widget in place so the user sees the new
          // goal + percentage immediately without a page reload.
          const widget = window._widgets && window._widgets.find(w => w.id === 'revenue-month');
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
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:11px;color:var(--t);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(l.name||l.address||'Lead')}</div>
            <div style="font-size:10px;color:var(--m);">${esc(_stageText(l))} • ${esc(ago)}</div>
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
      if(!stale.length) { el.innerHTML = '<div class="w-empty" style="color:var(--green);">No stale leads — nice work!</div>'; return; }
      el.innerHTML = `<div style="font-size:10px;color:var(--red);margin-bottom:6px;font-weight:700;">${stale.length} leads need attention</div>` +
        stale.map(l => {
          const days = Math.floor((now - _toMs(l.updatedAt||l.createdAt)) / 86400000);
          return `<div class="w-lead-row"><div class="w-lead-name">${esc(l.name||l.address||'Lead')}</div><div style="color:var(--red);font-size:10px;">${days > 0 ? days+'d ago' : 'today'}</div></div>`;
        }).join('');
    }},

  {id:'close-board', name:'Close Board', icon:'🎯', cat:'Pipeline & Sales', size:'md',
    render(el){
      const leads = (window._leads || []).filter(l => {
        const b = _bucketOf(l);
        return b === 'Negotiating' || b === 'Est. Sent';
      });
      const total = leads.reduce((s,l) => s + parseFloat(l.estValue||l.value||0), 0);
      el.innerHTML = `
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
          <span class="w-big-num" style="font-size:22px;">${leads.length}</span>
          <span style="font-size:11px;color:var(--green);font-weight:700;">$${total>=1000?(total/1000).toFixed(1)+'k':total.toFixed(0)} closeable</span>
        </div>` +
        leads.slice(0,4).map(l => `<div class="w-lead-row">
          <div class="w-lead-name">${esc(l.name||l.address||'Lead')}</div>
          <div style="color:var(--orange);font-size:10px;font-weight:700;">$${parseFloat(l.estValue||l.value||0).toLocaleString()}</div>
        </div>`).join('');
    }},

  // ═══ OPERATIONS ═══
  {id:'weather-radar', name:'Weather Radar', icon:'🌧️', cat:'Operations', size:'md',
    render(el){
      el.innerHTML = `<div id="w-radar-map" style="height:160px;border-radius:6px;overflow:hidden;"></div>
        <div style="font-size:9px;color:var(--m);margin-top:4px;text-align:center;">Live NEXRAD radar • Updates every 10 min</div>`;
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
      el.innerHTML = `<div class="w-empty" style="font-size:11px;">
        <div style="font-size:20px;margin-bottom:6px;">🛡️</div>
        No active alerts in your area.<br>
        <span style="font-size:9px;color:var(--m);">Checks NWS alerts API</span>
      </div>`;
      // Attempt to fetch NWS alerts
      fetch('https://api.weather.gov/alerts/active?area=OH&severity=Severe,Extreme&limit=3')
        .then(r => r.json()).then(data => {
          if(data.features && data.features.length) {
            el.innerHTML = data.features.slice(0,3).map(f => `
              <div style="padding:6px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:5px;margin-bottom:4px;font-size:10px;">
                <div style="font-weight:700;color:var(--red);">${f.properties.event}</div>
                <div style="color:var(--m);margin-top:2px;">${(f.properties.headline||'').substring(0,80)}</div>
              </div>`).join('');
          }
        }).catch(() => {});
    }},

  {id:'today-schedule', name:"Today's Schedule", icon:'📅', cat:'Operations', size:'md',
    render(el){
      const calSettings = JSON.parse(localStorage.getItem('nbd_cal_settings') || '{}');
      if(!calSettings.username) {
        el.innerHTML = '<div class="w-empty"><div style="font-size:20px;margin-bottom:6px;">📅</div>Connect Cal.com in Settings to see today\'s appointments</div>';
        return;
      }
      el.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-size:11px;font-weight:700;color:var(--t);">Today</span>
          <button class="w-mini-btn" data-w-goto="schedule">Open Calendar →</button>
        </div>
        <div class="w-empty" style="font-size:11px;">Cal.com appointments will appear here with future webhook integration.</div>`;
    }},

  {id:'task-checklist', name:'Task Checklist', icon:'✅', cat:'Operations', size:'md',
    render(el){
      let tasks = JSON.parse(localStorage.getItem('nbd_home_tasks') || '[]');
      if(!tasks.length) tasks = [{t:'Follow up on yesterday\'s leads',d:false},{t:'Send 3 estimates',d:false},{t:'Update pipeline stages',d:false},{t:'Check storm reports',d:false}];
      el.innerHTML = `<div id="w-tasks">` + tasks.map((t,i) => `
        <label class="w-task-row">
          <input type="checkbox" ${t.d?'checked':''} data-w-change="toggleTask" data-w-idx="${i}">
          <span style="${t.d?'text-decoration:line-through;opacity:.5;':''}font-size:12px;color:var(--t);">${esc(t.t)}</span>
        </label>`).join('') + `</div>
        <div style="margin-top:6px;display:flex;gap:4px;">
          <input type="text" id="w-task-input" placeholder="Add task..." style="flex:1;background:var(--s2);border:1px solid var(--br);border-radius:5px;padding:5px 8px;font-size:11px;color:var(--t);font-family:inherit;">
          <button class="w-mini-btn" data-w-action="addTask">+</button>
        </div>`;
    }},

  {id:'quick-estimate', name:'Quick Estimate', icon:'🧮', cat:'Operations', size:'sm',
    render(el){
      el.innerHTML = `
        <div style="margin-bottom:6px;">
          <label style="font-size:9px;color:var(--m);text-transform:uppercase;letter-spacing:.08em;">Sq Ft</label>
          <input type="number" id="w-qe-sqft" placeholder="2000" style="width:100%;background:var(--s2);border:1px solid var(--br);border-radius:5px;padding:6px 8px;font-size:13px;color:var(--t);font-family:inherit;margin-top:2px;" data-w-input="quickEst">
        </div>
        <div style="margin-bottom:6px;">
          <label style="font-size:9px;color:var(--m);text-transform:uppercase;letter-spacing:.08em;">$/sq</label>
          <input type="number" id="w-qe-rate" placeholder="350" value="350" style="width:100%;background:var(--s2);border:1px solid var(--br);border-radius:5px;padding:6px 8px;font-size:13px;color:var(--t);font-family:inherit;margin-top:2px;" data-w-input="quickEst">
        </div>
        <div id="w-qe-result" style="font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:800;color:var(--orange);text-align:center;padding:6px 0;">$0</div>`;
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
      // Same aggregation the real Leaderboard view uses: group non-deleted
      // leads by owner, count won by stage ROLE (not a hardcoded name list, so
      // custom pipelines work), and sum jobValue — the canonical money field.
      const leads = (window._leads || []).filter(l => l && !l.deleted);
      const byRep = {};
      leads.forEach(l => {
        const owner = l.userId || '(unknown)';
        if (!byRep[owner]) byRep[owner] = { name: '', rev: 0, deals: 0 };
        if (!byRep[owner].name && l.repName) byRep[owner].name = l.repName;
        const role = l._stageRole
          || (typeof window.stageRole === 'function' ? window.stageRole(l._stageKey || l.stage) : '');
        if (role === 'won' || role === 'job') {
          byRep[owner].deals++;
          byRep[owner].rev += parseFloat(l.jobValue) || 0;
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
        el.innerHTML = '<div style="padding:10px 0;font-size:11px;color:var(--m);">'
          + 'No closed jobs yet — reps appear here once deals start closing.</div>';
        return;
      }
      el.innerHTML = reps.map((r,i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:5px 0;${i<reps.length-1?'border-bottom:1px solid var(--br);':''}">
          <span style="font-size:14px;">${i===0?'🥇':i===1?'🥈':'🥉'}</span>
          <div style="flex:1;"><div style="font-size:11px;font-weight:700;color:var(--t);">${esc(r.name)}</div></div>
          <div style="text-align:right;"><div style="font-size:12px;font-weight:700;color:var(--orange);">$${(r.rev/1000).toFixed(1)}k</div><div style="font-size:9px;color:var(--m);">${r.deals} deals</div></div>
        </div>`).join('');
    }},

  // ═══ TOOLS & QUICK ACTIONS ═══
  {id:'quick-add-lead', name:'Quick Add Lead', icon:'➕', cat:'Tools & Quick Actions', size:'md',
    render(el){
      el.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:6px;">
          <input type="text" id="w-ql-name" placeholder="Homeowner name" style="width:100%;background:var(--s2);border:1px solid var(--br);border-radius:5px;padding:8px 10px;font-size:12px;color:var(--t);font-family:inherit;">
          <input type="text" id="w-ql-addr" placeholder="Property address" style="width:100%;background:var(--s2);border:1px solid var(--br);border-radius:5px;padding:8px 10px;font-size:12px;color:var(--t);font-family:inherit;">
          <div style="display:flex;gap:6px;">
            <select id="w-ql-damage" style="flex:1;background:var(--s2);border:1px solid var(--br);border-radius:5px;padding:8px;font-size:11px;color:var(--t);font-family:inherit;">
              <option value="Roof - Hail">Roof - Hail</option><option value="Roof - Wind">Roof - Wind</option><option value="Siding - Hail">Siding - Hail</option><option value="Siding - Wind">Siding - Wind</option><option value="Full Exterior">Full Exterior</option>
            </select>
            <button class="btn btn-orange" style="padding:8px 16px;font-size:11px;" data-w-action="quickAddLead">Add →</button>
          </div>
        </div>`;
    }},

  {id:'quick-draw', name:'Quick Draw', icon:'✏️', cat:'Tools & Quick Actions', size:'sm',
    render(el){
      el.innerHTML = `
        <input type="text" id="w-qd-addr" placeholder="Address to measure..." style="width:100%;background:var(--s2);border:1px solid var(--br);border-radius:5px;padding:8px 10px;font-size:12px;color:var(--t);font-family:inherit;margin-bottom:8px;">
        <button class="btn btn-orange" style="width:100%;padding:10px;font-size:12px;justify-content:center;" data-w-action="quickDraw">📏 Open Drawing Tool</button>`;
    }},

  {id:'ask-joe-mini', name:'Ask Joe', icon:'🤠', cat:'Tools & Quick Actions', size:'md',
    render(el){
      el.innerHTML = `
        <div id="w-joe-response" style="font-size:12px;color:var(--m);min-height:40px;margin-bottom:8px;max-height:120px;overflow-y:auto;">Ask Joe anything about sales, claims, or your pipeline.</div>
        <div style="display:flex;gap:6px;">
          <input type="text" id="w-joe-input" placeholder="Ask Joe..." style="flex:1;background:var(--s2);border:1px solid var(--br);border-radius:5px;padding:8px 10px;font-size:12px;color:var(--t);font-family:inherit;" data-w-keydown="askJoe">
          <button class="btn btn-orange" style="padding:8px 12px;font-size:11px;" data-w-action="askJoe">Ask</button>
        </div>`;
    }},

  {id:'recent-estimates', name:'Recent Estimates', icon:'📋', cat:'Tools & Quick Actions', size:'sm',
    render(el){
      const ests = (window._estimates || []).slice(-3).reverse();
      if(!ests.length) { el.innerHTML = '<div class="w-empty">No estimates yet</div>'; return; }
      el.innerHTML = ests.map(e => `
        <div class="w-lead-row" data-w-goto="est">
          <div class="w-lead-name">${esc(e.address || e.addr || 'Estimate')}</div>
          <div style="font-size:10px;color:var(--orange);font-weight:700;">${e.total ? '$'+parseFloat(e.total).toLocaleString() : '—'}</div>
        </div>`).join('');
    }},

  {id:'recent-docs', name:'Recent Documents', icon:'📄', cat:'Tools & Quick Actions', size:'sm',
    render(el){
      el.innerHTML = `
        <div class="w-lead-row" data-w-goto="docs"><div class="w-lead-name">Template Library</div><div style="font-size:10px;color:var(--m);">24 templates</div></div>
        <button class="btn btn-ghost" style="width:100%;margin-top:6px;font-size:11px;padding:7px;justify-content:center;" data-w-goto="docs">Open Template Library →</button>`;
    }},

  {id:'booking-link', name:'Booking Link', icon:'🔗', cat:'Tools & Quick Actions', size:'sm',
    render(el){
      const cal = JSON.parse(localStorage.getItem('nbd_cal_settings') || '{}');
      const url = cal.username ? `https://cal.com/${cal.username}/${cal.eventSlug||'roof-inspection'}` : '';
      if(!url) { el.innerHTML = '<div class="w-empty">Set up Cal.com first</div>'; return; }
      el.innerHTML = `
        <div style="font-size:11px;color:var(--m);margin-bottom:8px;word-break:break-all;">${url}</div>
        <div style="display:flex;gap:4px;">
          <button class="w-mini-btn" style="flex:1;" data-w-action="copyToClipboard" data-w-id="${url}">📋 Copy</button>
          <button class="w-mini-btn" style="flex:1;" data-w-action="smsBookLink" data-w-id="${url}">💬 SMS</button>
        </div>`;
    }},

  // ═══ MOTIVATION & TRACKING ═══
  {id:'north-star', name:'North Star Goal', icon:'⭐', cat:'Motivation & Tracking', size:'sm',
    render(el){
      const cfg = JSON.parse(localStorage.getItem('nbd_ds_config') || '{}');
      const goal = cfg.northStar || 'Set your North Star in Settings → Daily OS';
      const deadline = cfg.northStarDeadline || '';
      el.innerHTML = `
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:800;color:var(--orange);text-transform:uppercase;line-height:1.3;margin-bottom:6px;">${esc(goal)}</div>
        ${deadline ? `<div style="font-size:10px;color:var(--m);">Deadline: ${esc(deadline)}</div>` : ''}`;
    }},

  {id:'daily-floors', name:'Daily Floors', icon:'📏', cat:'Motivation & Tracking', size:'md',
    render(el){
      const cfg = JSON.parse(localStorage.getItem('nbd_ds_config') || '{}');
      const floors = cfg.floors || [{label:'Doors Knocked',target:30,unit:''},{label:'Contacts Made',target:10,unit:''},{label:'Appts Set',target:3,unit:''}];
      const today = new Date().toISOString().split('T')[0];
      const progress = JSON.parse(localStorage.getItem('nbd_floor_progress_'+today) || '{}');
      el.innerHTML = floors.map((f,i) => {
        const val = progress[i] || 0;
        const pct = f.target > 0 ? Math.min(100, val/f.target*100) : 0;
        return `<div style="margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:3px;">
            <span style="font-weight:700;color:var(--t);">${esc(f.label)}</span>
            <span style="color:${pct>=100?'var(--green)':'var(--m)'};">${val} / ${f.target}</span>
          </div>
          <div class="w-bar-track"><div class="w-bar-fill" style="width:${pct}%;${pct>=100?'background:var(--green);':''}"></div></div>
        </div>`;
      }).join('') + `<button class="w-mini-btn" style="width:100%;margin-top:4px;" data-w-action="openDailyTracker">Open Daily Tracker →</button>`;
    }},

  {id:'streak-counter', name:'Streak Counter', icon:'🔥', cat:'Motivation & Tracking', size:'sm',
    render(el){
      const streak = parseInt(localStorage.getItem('nbd_streak') || '0');
      el.innerHTML = `
        <div style="text-align:center;">
          <div style="font-size:42px;line-height:1;">${streak > 0 ? '🔥' : '❄️'}</div>
          <div class="w-big-num" style="font-size:36px;">${streak}</div>
          <div class="w-sub">${streak === 1 ? 'day streak' : 'day streak'}</div>
          <div style="font-size:9px;color:var(--m);margin-top:4px;">${streak >= 7 ? 'Unstoppable!' : streak >= 3 ? 'Keep it going!' : 'Build momentum!'}</div>
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
        <div style="font-size:13px;font-style:italic;color:var(--t);line-height:1.5;margin-bottom:8px;">"${q.q}"</div>
        <div style="font-size:10px;color:var(--orange);font-weight:700;text-align:right;">— ${q.a}</div>`;
    }},

  {id:'golden-goose', name:'Golden Goose', icon:'🪿', cat:'Motivation & Tracking', size:'sm',
    render(el){
      const cfg = JSON.parse(localStorage.getItem('nbd_ds_config') || '{}');
      const reward = cfg.goldenGoose || 'Set your reward in Settings → Daily OS';
      const today = new Date().toISOString().split('T')[0];
      const progress = JSON.parse(localStorage.getItem('nbd_floor_progress_'+today) || '{}');
      const floors = cfg.floors || [];
      const allHit = floors.length > 0 && floors.every((f,i) => (progress[i]||0) >= f.target);
      el.innerHTML = `
        <div style="text-align:center;">
          <div style="font-size:36px;">${allHit ? '🪿✨' : '🪿'}</div>
          <div style="font-size:12px;font-weight:700;color:${allHit?'var(--green)':'var(--t)'};margin:6px 0;">${allHit ? 'UNLOCKED!' : 'Hit all floors to unlock'}</div>
          <div style="font-size:11px;color:var(--orange);font-style:italic;">${esc(reward)}</div>
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
        return `<div style="margin-bottom:6px;">
          <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:2px;">
            <span style="color:var(--t);font-weight:600;">${name}</span>
            <span style="color:var(--m);">${count} (${pct}%)</span>
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
        <div style="display:flex;align-items:flex-end;gap:6px;height:100px;">
          ${months.map(m => {
            const h = Math.max(8, m.count/max*90);
            return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;">
              <span style="font-size:9px;color:var(--t);font-weight:700;">${m.count}</span>
              <div style="width:100%;height:${h}px;background:var(--orange);border-radius:3px 3px 0 0;"></div>
              <span style="font-size:8px;color:var(--m);">${m.label}</span>
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
        <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--br);font-size:11px;">
          <span style="color:var(--t);font-weight:600;">${s}</span>
          <span style="color:var(--orange);font-weight:700;">${c}</span>
        </div>`).join('');
    }},

  {id:'territory-mini', name:'Territory Heat Map', icon:'🗺️', cat:'Data & Analytics', size:'lg',
    render(el){
      el.innerHTML = `<div id="w-mini-heat" style="height:180px;border-radius:6px;overflow:hidden;"></div>
        <button class="w-mini-btn" style="width:100%;margin-top:6px;" data-w-goto="map">Open Full Map →</button>`;
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
    '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">' +
      '<div style="min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:' + (unread ? '700' : '500') + ';font-size:12px;color:var(--t);">' + esc(who) + (town ? ' <span style="color:var(--m);font-weight:400;">· ' + esc(town) + '</span>' : '') + '</div>' +
      '<div style="font-size:10px;color:var(--m);white-space:nowrap;">' + esc(_timeAgo(c.startedAt || c.createdAt)) + '</div>' +
    '</div>' +
    '<div style="margin-top:2px;">' + badges + '</div>' +
    '<div style="font-size:11px;color:var(--m);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(c.issue || (c.call && c.call.summary) || '') + '</div>' +
  '</div>';
  if (_thuOpenId === id) html += _thuDetail(c, id);
  return html;
}

function _thuDetail(c, id) {
  const ex = c.extraction || {};
  const action = c.route && c.route.action;
  const viewer = _thuIsViewer();
  const btn = (act, label, extra, primary) => '<button type="button" class="' + (primary ? 'btn btn-orange' : 'w-mini-btn') + '" style="font-size:11px;padding:6px 10px;" data-w-action="' + act + '" data-w-id="' + esc(id) + '"' + (extra || '') + '>' + label + '</button>';
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
    attach = hits.map(l => btn('thuAttach', esc(((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || l.address || 'Lead') + ' <span style="opacity:.6">' + esc((l.address || '').slice(0, 30)) + '</span>', ' data-lead-id="' + esc(l.id) + '"')).join('');
  }
  const transcript = (c.call && c.call.transcript) || '';
  return '<div data-w-stop="1" style="background:var(--s2);border:1px solid var(--br);border-radius:8px;padding:10px;margin:4px 0 8px;font-size:12px;cursor:default;">' +
    (c.call && c.call.summary ? '<div style="margin-bottom:6px;">' + esc(c.call.summary) + '</div>' : '') +
    (facts.length ? '<div style="display:flex;flex-wrap:wrap;gap:6px 12px;color:var(--m);font-size:11px;margin-bottom:8px;">' + facts.join('') + '</div>' : '') +
    '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + acts.join('') + '</div>' +
    '<div id="thu-attach-' + esc(id) + '" style="display:' + (_thuSearch !== '' && _thuOpenId === id ? 'block' : 'none') + ';margin-top:8px;">' +
      '<input type="text" placeholder="Search leads by name or address…" data-w-input="thuSearch" data-w-id="' + esc(id) + '" value="' + esc(_thuSearch || '') + '" style="width:100%;background:var(--bg);border:1px solid var(--br);border-radius:6px;padding:6px 8px;font-size:12px;color:var(--t);font-family:inherit;box-sizing:border-box;">' +
      '<div style="display:flex;flex-direction:column;gap:4px;margin-top:6px;">' + attach + '</div>' +
    '</div>' +
    '<div id="thu-audio-' + esc(id) + '" style="margin-top:6px;"></div>' +
    '<div id="thu-status-' + esc(id) + '" style="font-size:11px;color:var(--m);margin-top:4px;"></div>' +
    (transcript ? '<details style="margin-top:6px;"><summary style="cursor:pointer;color:var(--m);font-size:11px;">Transcript</summary><div style="white-space:pre-wrap;max-height:240px;overflow-y:auto;margin-top:4px;line-height:1.45;">' + esc(transcript) + '</div></details>' : '') +
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
  el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:10px;color:var(--m);">' +
      '<span>' + (unread ? '<b style="color:var(--orange);">' + unread + ' new</b> · ' : '') + _thuCalls.length + ' recent</span>' +
      (hiddenCount || _thuShowAll ? '<button type="button" class="w-mini-btn" style="font-size:10px;" data-w-action="thuShowAll">' + (_thuShowAll ? 'Hide spam/silent' : 'Show ' + hiddenCount + ' spam/silent') + '</button>' : '') +
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
const DEFAULT_WIDGETS = ['pipeline-value','hot-leads','win-rate','revenue-month','task-checklist',
  'daily-floors','quick-add-lead','recent-activity','weather-radar','north-star','quote-widget','streak-counter'];

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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
}


// ── RENDER ENGINE ───────────────────────────────────────────────
function renderWidgetHome() {
  const grid = document.getElementById('widgetGrid');
  if(!grid) return;
  if (_thuGateState === null) { _thuGateState = { enabled: false, hidden: false, pending: true }; _thuResolveGate(); }

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
      'today-schedule': 'schedule'
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
  addCard.innerHTML = `<div style="text-align:center;padding:20px 0;cursor:pointer;">
    <div style="font-size:28px;opacity:.4;">＋</div>
    <div style="font-size:11px;color:var(--m);margin-top:4px;">Add Widget</div>
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
          <div style="font-size:9px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--orange);">Customize Home</div>
          <div style="font-size:18px;font-weight:800;color:var(--t);">Widget Library</div>
        </div>
        <button style="background:none;border:none;color:var(--m);font-size:20px;cursor:pointer;" data-w-action="closePicker">✕</button>
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
        <button class="btn btn-ghost" style="font-size:11px;padding:8px 14px;" data-w-action="resetDefaults">Reset to Defaults</button>
        <button class="btn btn-orange" style="font-size:12px;padding:8px 20px;" data-w-action="closePicker">Done</button>
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
  let tasks = JSON.parse(localStorage.getItem('nbd_home_tasks') || '[]');
  if(!tasks.length) tasks = [{t:'Follow up on yesterday\'s leads',d:false},{t:'Send 3 estimates',d:false},{t:'Update pipeline stages',d:false},{t:'Check storm reports',d:false}];
  if(tasks[idx]) tasks[idx].d = done;
  localStorage.setItem('nbd_home_tasks', JSON.stringify(tasks));
  renderWidgetHome();
};

_wAddTask = function() {
  const input = document.getElementById('w-task-input');
  if(!input || !input.value.trim()) return;
  let tasks = JSON.parse(localStorage.getItem('nbd_home_tasks') || '[]');
  tasks.push({t: input.value.trim(), d: false});
  localStorage.setItem('nbd_home_tasks', JSON.stringify(tasks));
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
  if(resp) resp.innerHTML = '<div style="color:var(--orange);">Thinking...</div>';
  // If Joe AI is available, use it
  if(window.sendJoeMessage) {
    // Redirect to full Joe
    goTo('joe');
    setTimeout(() => {
      const joeInput = document.querySelector('.joe-input-area textarea');
      if(joeInput) { joeInput.value = q; sendJoeMessage(); }
    }, 200);
  } else {
    if(resp) resp.innerHTML = '<div style="color:var(--m);">Open Ask Joe for full AI chat →</div>';
  }
};


// ── PUBLIC API ──────────────────────────────────────────────────
window.NBDWidgets = {
  WIDGETS,
  render: renderWidgetHome,
  openPicker: openWidgetPicker,
  closePicker: closePicker,
  toggleWidget,
  removeWidget,
  resetDefaults,
  getActive: getActiveWidgets,
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
