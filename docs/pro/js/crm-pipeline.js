/**
 * crm-pipeline.js — kanban render + card builder + moveCard.
 *
 * Extracted from crm.js (Step 4b — 2026-05-16) as one of four
 * sibling modules. Load order is critical and locked in
 * dashboard.html:
 *
 *   leads → pipeline → snooze → portal-bridge → crm (shim)
 *
 * This file holds the render-heavy kanban logic:
 *   - renderLeads / view-switcher counts / stat helpers
 *   - lead-score last-seen cache (_leadScoreLastSeen + persist)
 *   - _damageToChip helper
 *   - buildCard (the biggest function in the codebase)
 *   - wireKanbanCardListeners (delegated handlers per card body)
 *   - handleCardClick + the global dragend cleanup listener
 *   - promptLostReason (lost-stage modal)
 *   - moveCard (stage advance, persistence, optimistic UI)
 *   - updatePipeline / tagClass
 *   - kanbanFilter + kanbanFilterDebounced + clearCrmSearch
 *
 * It references the Firebase shim consts (db, col, _addDoc, etc.)
 * declared in crm-leads.js as outer-scope globals (classic-script
 * sibling scope). `_dragId` remains an implicit global (used by
 * the kanban drag handlers in renderLeads and the dragend
 * cleanup listener at the bottom of this file) — behaviour-
 * identical to pre-split.
 */

// ══════════════════════════════════════════════
// KANBAN CRM — renderLeads / drag-drop / filter
// ══════════════════════════════════════════════

// ── Ops P1 #4 increment (2026-07-04): per-column render cap ──────
// The fetch keeps the COMPLETE book in window._leads (KPIs, money
// dashboard, search, export all assume completeness — see the ops
// audit), but the DOM paint was unbounded: every lead in every column
// became a card node + listeners on every render, which is the half
// of the "breaks first at scale" P1 we can fix without a consumer
// migration. Cap the initial paint per column; a "Show all" row
// mounts the remainder on demand. Column counts and $ totals are
// computed from the FULL array above, so nothing under-reports.
let _searchQuery; // module-local (globals Tranche 1 — was window.*)
const KANBAN_RENDER_CAP = 75;
const _kbShowAll = {}; // stageKey -> true once the rep expands the column

function renderColumnCards(body, cards, stageKey) {
  const showAll = _kbShowAll[stageKey] || cards.length <= KANBAN_RENDER_CAP;
  const slice = showAll ? cards : cards.slice(0, KANBAN_RENDER_CAP);
  let html = slice.map(l => buildCard(l)).join('');
  if (!showAll) {
    html += '<button type="button" class="k-show-all">Show all '
      + cards.length + ' cards (+' + (cards.length - slice.length) + ' hidden)</button>';
  }
  body.innerHTML = html;
  if (!showAll) {
    const btn = body.querySelector('.k-show-all');
    if (btn) btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _kbShowAll[stageKey] = true;
      // Preserve any active search/damage filter — a bare renderLeads() nulls
      // window._filteredLeads and repaints the whole book unfiltered while the
      // search box + count still show the query (rep thinks they're filtered).
      if (typeof renderLeads === 'function') renderLeads(window._leads, window._filteredLeads);
    });
  }
}

// Follow-up alert rows (renderLeads). A phone shows three rows and a
// "+ N more" button that opens the rest in place; a wider screen keeps its
// five (2026-09-25 phone audit: five rows filled y≈225–572, so the first
// pipeline card started near the bottom of an 860px screen). The fa-icon /
// fa-addr hooks let kanban-force.css stack each row into two lines on a
// phone, where the one-line flex row split names, "Due: 2026- / 09-26" and
// a 20px-tall "View / →" button across lines. Expanded stays expanded for
// the session: renderLeads re-runs on every data refresh.
let _fuShowAll = false;
// The phone-or-wider choice above is made at render time, so a rotate kept
// the other width's row count (and a phone kept five rows) until the next
// refresh. The last render is kept, and a flip of the phone query re-renders
// it while its box is still on the page (2026-09-25 phone nav polish).
let _fuLast = null; // { box, overdue } from the latest render
try {
  const mq = window.matchMedia && window.matchMedia('(max-width: 768px)');
  const refit = () => { if (_fuLast && _fuLast.box.isConnected) _renderFollowUpRows(_fuLast.box, _fuLast.overdue); };
  if (mq && mq.addEventListener) mq.addEventListener('change', refit);
  else if (mq && mq.addListener) mq.addListener(refit);
} catch (_) {}
// A follow-up date as LOCAL midnight. followUp is stored 'YYYY-MM-DD' (the
// <input type="date"> value), and new Date('YYYY-MM-DD') is UTC midnight —
// the previous evening anywhere in the US — so every follow-up read as due a
// day early (banner, card badge, "Overdue Follow-Up" notifications).
function _followUpDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v == null ? '' : v).trim());
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
  d.setHours(0, 0, 0, 0);
  return d;
}
window.nbdFollowUpDay = _followUpDay;
// "Due today" / "Due Sep 29" / "3 days overdue" — the banner printed the raw
// "Due: 2026-09-29".
function _followUpDueText(v) {
  const d = _followUpDay(v);
  if (isNaN(d)) return 'Due: ' + String(v || '');
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const days = Math.round((t - d) / 86400000);
  if (days === 0) return 'Due today';
  if (days > 0) return days + (days === 1 ? ' day' : ' days') + ' overdue';
  return 'Due ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function _renderFollowUpRows(box, overdue) {
  _fuLast = { box, overdue };
  const phone = !!(window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
  const cap = _fuShowAll ? overdue.length : (phone ? 3 : 5);
  // One at a time (Jo, 2026-10-02): the whole list as a swipe deck.
  const deckBtn = (window.NBDFollowUpDeck && window.NBDTriageDeck && overdue.length > 1)
    ? `<button type="button" class="fa-deck">One at a time (${overdue.length})</button>` : '';
  box.innerHTML = deckBtn + overdue.slice(0, cap).map(l => `
        <div class="follow-up-alert">
          <span class="fa-icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="cpx-wd12px-hei12px-vermiddle"><rect x="3" y="4" width="14" height="13" rx="1.5"/><path d="M3 8h14"/><path d="M7 2v4M13 2v4"/></svg></span>
          <span class="fa-name">${escHtml(l.firstName||'')} ${escHtml(l.lastName||'')}</span>
          <span class="fa-addr cpx-cm-fs11px">${escHtml(String(l.address||'').split(',')[0])}</span>
          <span class="fa-date">${escHtml(_followUpDueText(l.followUp))}</span>
          <button class="fa-btn nbd-fa-edit" data-lead-id="${escHtml(l.id)}">View →</button>
        </div>`).join('')
    + (overdue.length > cap ? `<button type="button" class="fa-more">+ ${overdue.length - cap} more</button>` : '');
  box.querySelectorAll('.nbd-fa-edit').forEach(btn => {
    btn.addEventListener('click', () => editLead(btn.dataset.leadId));
  });
  const more = box.querySelector('.fa-more');
  if (more) more.addEventListener('click', () => { _fuShowAll = true; _renderFollowUpRows(box, overdue); });
  const deck = box.querySelector('.fa-deck');
  if (deck) deck.addEventListener('click', () => window.NBDFollowUpDeck.open(overdue));
}

// Customers → pipeline cards. Without jobs-store.js (or before its first load)
// every customer is its own single card, exactly as before multi-job.
function _expandJobCards(list) {
  const J = window.NBDJobs;
  if (!J || typeof J.cardsFor !== 'function' || !J.loadedAt || !J.loadedAt()) return list;
  const norm = window.normalizeStage;
  const roleOf = window.stageRole;
  const out = [];
  for (const l of list) {
    const cards = J.cardsFor(l, J.forLead(l.id));
    for (const c of cards) {
      if (c !== l && c._jobId) {
        // The copy still carries the customer's stamped stage keys; restamp
        // them from THIS job's stage so bucketing + filters see the job.
        c._stageKey = norm ? norm(c.stage || 'new') : (c.stage || 'new');
        c._stageRole = c.stageRole || (typeof roleOf === 'function' ? roleOf(c._stageKey) : undefined);
      }
      out.push(c);
    }
  }
  return out;
}

// { new, working, estimate, production, won, lost } for the dashboard tiles.
// window.dashboardTileFor is published by crm-stages.js (both bootstraps
// import it); before it lands every lead counts by role alone.
function _dashboardTileCounts(all) {
  const counts = { new: 0, working: 0, estimate: 0, production: 0, won: 0, lost: 0 };
  const _normalize = window.normalizeStage || (s => s);
  const roleOf = typeof window.stageRole === 'function' ? window.stageRole : null;
  (all || []).forEach(l => {
    if (!l) return;
    const sk = l._stageKey || _normalize(l.stage || 'new');
    let tile = null;
    if (typeof window.dashboardTileFor === 'function') {
      // The lead's own stamped role wins (a custom stage's role is on it).
      tile = window.dashboardTileFor(sk, l._stageRole ? () => l._stageRole : roleOf);
    } else {
      const role = l._stageRole || (roleOf ? roleOf(sk) : 'active');
      tile = role === 'won' ? 'won' : role === 'lost' ? 'lost' : role === 'job' ? 'production' : role === 'new' ? 'new' : 'working';
    }
    if (Object.prototype.hasOwnProperty.call(counts, tile)) counts[tile]++;
  });
  return counts;
}
window.nbdDashboardTileCounts = _dashboardTileCounts;

function renderLeads(leads, filtered){
  const all   = (leads  || window._leads || []);
  // No subset passed (undefined, or the explicit "unfiltered" null) → keep
  // any active search applied, computed fresh from THIS render's leads (see
  // _crmSearchFilter). An explicit array (a filter chip's subset) is used as-is.
  if ((filtered === undefined || filtered === null) && typeof _crmSearchFilter === 'function') {
    filtered = _crmSearchFilter(all);
  }
  let list    = (filtered !== undefined && filtered !== null) ? filtered : all;
  window._filteredLeads = (filtered !== undefined && filtered !== null) ? filtered : null;

  // R5.4: per-track counts on the view switcher (Ins/Cash/Fin/War/Svc/Jobs/All).
  // Computed from `all` (pre-filter) so the counts reflect the rep's
  // real workload, not what's currently filtered in. Skipped if the
  // switcher isn't rendered yet (initial boot before kanban mounts).
  (() => {
    const swEl = document.getElementById('kview-count-insurance');
    if (!swEl) return;
    // 2026-09-15 (Kanban filter unification): was a hand-copied Set that had
    // already drifted from crm-stages.js's VIEW_JOBS within hours of the
    // Collections stage being added — window.isJobStage is the one
    // canonical membership test now (crm-stages.js), so this count can
    // never drift from the filter below or from the Jobs board's own
    // column list again.
    const _norm = window.normalizeStage;
    const counts = { insurance: 0, cash: 0, finance: 0, warranty: 0, service: 0, jobs: 0, simple: all.length };
    for (const l of all) {
      if (!l) continue;
      const jt = l.jobType || '';
      // Same logic as the view-filter in renderLeads below
      if (!jt || jt === 'insurance') counts.insurance++;
      if (jt === 'cash')             counts.cash++;
      if (jt === 'finance')          counts.finance++;
      if (jt === 'warranty')         counts.warranty++;
      if (jt === 'service')          counts.service++;
      const sk = l._stageKey || (_norm ? _norm(l.stage) : l.stage || 'new');
      if (window.isJobStage && window.isJobStage(sk)) counts.jobs++;
    }
    ['insurance','cash','finance','warranty','service','jobs','simple'].forEach(k => {
      const el = document.getElementById('kview-count-' + k);
      if (el) el.textContent = counts[k] > 0 ? String(counts[k]) : '';
    });
  })();

  // ─── Prospect segregation (April 2026) ─────────────────
  // Leads marked { isProspect: true } represent knocks that
  // auto-created a lead record but haven't been qualified yet
  // (i.e. not-home, interested, storm-damage, etc. dispositions).
  // By default the kanban HIDES prospects so they don't crowd real
  // customer data. A toggle in the CRM header lets the user flip
  // 'Show prospects' on when they want to triage.
  //
  // Appointments are the exception — they skip the Prospect stage
  // entirely because a set meeting is already a qualified customer.
  // See convertToLead() in d2d-tracker.js for the routing logic.
  const _showProspects = (localStorage.getItem('nbd_crm_show_prospects') === '1');
  if (!_showProspects) {
    list = list.filter(l => !l.isProspect);
  }

  // Wave 35: hide snoozed leads from the kanban by default. The rep
  // can flip "Show snoozed" in the CRM header to bring them back.
  // We keep snoozed leads in `all` so the stat row totals are
  // unaffected — the filter only narrows what renders as cards.
  const _showSnoozed = (localStorage.getItem('nbd_crm_show_snoozed') === '1');
  if (!_showSnoozed && window.LeadSnooze) {
    list = list.filter(l => !window.LeadSnooze.isSnoozed(l));
  }

  // ─── Rep scoping (Enterprise) ─────────────────
  // When a user has a 'role' custom claim that is NOT 'admin' or
  // 'owner', they only see their own leads. Managers see all leads
  // in their company. Owners/admins see everything (no filter).
  // The claims are set by claimInvite on first dashboard load (the
  // de-GCIP'd Pillar 1 Phase 3 path; onRepSignup never deploys) and
  // are available on window._userClaims after login. Since 2026-07
  // the FETCH itself is role-branched too (dashboard-bootstrap
  // loadLeads) — this render filter is defense-in-depth for reps.
  const _userRole = (window._userClaims && window._userClaims.role) || null;
  if (_userRole === 'sales_rep') {
    // Sales reps see only their own leads
    list = list.filter(l => l.userId === window._user?.uid);
  } else if (_userRole === 'viewer') {
    // Viewers see all leads but read-only (handled in UI, not here)
  }
  // Owners, admins, managers see all leads (no filter)

  // ── One card per OPEN job (2026-09-30, multi-job stage 2a) ──
  // A customer with a second job still open shows two cards (Jo J3); see
  // docs/pro/js/jobs-store.js cardsFor. The ACTIVE job's card IS the lead
  // object, so a customer with one job renders exactly as before. Done HERE —
  // after prospect/snooze/rep scoping (customer-level) and before the track
  // filters below (job-level: each card is filtered on its own job type and
  // stage). window._filteredLeads stays LEADS (set above), never cards.
  list = _expandJobCards(list);

  // ── Per-pipeline filter: only show leads that belong to the active track ──
  // Simple view: show all leads (no filter)
  // Insurance view: show insurance + unset jobType leads (NBD defaults to insurance)
  // Cash view: show only cash leads
  // Finance view: show only finance leads
  // Jobs view: show leads Jo considers a job — post-contract stages PLUS
  // contract_signed itself (2026-09-15 Kanban filter unification, Jo's
  // call: a signed, materials-on-order deal IS a job to him — the CRM's
  // own revenue math already agreed, see _closedKeys below). Uses
  // window.isJobStage (crm-stages.js) instead of a hand-copied stage-key
  // Set — that Set had already drifted from VIEW_JOBS within hours of the
  // Collections stage being added; this is the one place that fact lives now.
  const _view = window._currentViewKey || 'simple';
  const _norm = window.normalizeStage;
  if (_view === 'insurance') {
    // Insurance view still catches unset jobType (NBD's historical default)
    list = list.filter(l => !l.jobType || l.jobType === 'insurance');
  } else if (_view === 'cash') {
    list = list.filter(l => l.jobType === 'cash');
  } else if (_view === 'finance') {
    list = list.filter(l => l.jobType === 'finance');
  } else if (_view === 'warranty') {
    list = list.filter(l => l.jobType === 'warranty');
  } else if (_view === 'service') {
    list = list.filter(l => l.jobType === 'service');
  } else if (_view === 'jobs') {
    list = list.filter(l => {
      const sk = l._stageKey || (_norm ? _norm(l.stage) : l.stage || 'new');
      return window.isJobStage && window.isJobStage(sk);
    });
  }
  // simple view: no filter (list stays as-is)

  // Search count = what the board actually shows. kanbanFilter used to count
  // before the prospect/snooze/track filters above, so a match hidden as a
  // prospect read "1 match" over an empty board.
  if (filtered !== undefined && filtered !== null) {
    const countSpan = document.getElementById('crmSearchCount');
    if (countSpan) {
      // Customers, not cards: a customer with two open jobs is one match.
      const shown = new Set(list.map((c) => c.id)).size;
      const hiddenN = Math.max(0, filtered.length - shown);
      countSpan.textContent = `${shown} match${shown === 1 ? '' : 'es'}`
        + (hiddenN ? ` · ${hiddenN} hidden (prospects, snoozed, or another pipeline tab)` : '');
    }
  }

  // ── stat helpers ──
  const setEl = (id,v)=>{ const e=document.getElementById(id); if(e) e.textContent=v; };

  // Revenue calcs — use stage keys when available
  let pipeVal=0, closedRev=0, approvedCount=0;
  const _lostKeys = ['lost', 'Lost'];
  const _approvedKeys = ['contract_signed','Approved'];
  all.forEach(l=>{
    const v=parseFloat(l.jobValue||0);
    const sk = l._stageKey || l.stage || 'new';
    // Role-aware buckets so CUSTOM/freeform won/lost stages count correctly.
    // The built-in key lists still match built-in stages exactly (no behavior
    // change there); the role check only ADDS custom stages, which no built-in
    // list knows about — otherwise a custom Lost stage inflated pipeline value
    // and a custom Won stage was excluded from closed revenue.
    const role = l._stageRole || (typeof window.stageRole === 'function' ? window.stageRole(sk) : 'active');
    const isLost = _lostKeys.includes(sk) || role === 'lost';
    // 2026-09-15 (Kanban filter unification): was its own hand-copied
    // _closedKeys list (contract_signed through closed, plus 3 legacy
    // display names) — window.isJobStage already normalizes legacy aliases
    // via the same normalizeStage() path (Approved -> contract_signed,
    // In Progress -> install_in_progress, Complete -> closed), so this is
    // strictly the same classification with one fewer place to drift.
    const isClosed = (window.isJobStage && window.isJobStage(sk)) || role === 'won' || role === 'job';
    // Metrics audit F2: pipeline = deals still IN PLAY only. The old
    // "everything not lost" definition counted won/in-production money as
    // pipeline while the Closed Revenue tile showed a subset of the same
    // dollars — the two tiles double-reported. A dollar now lives in exactly
    // one bucket: pipeline until it closes, closedRev after.
    if(!isLost && !isClosed) pipeVal+=v;
    if(isClosed) closedRev+=v;
    if(_approvedKeys.includes(sk)) approvedCount++;
  });
  // Count prospects (hidden from kanban when toggle is off)
  const _prospectCount = all.filter(l => l.isProspect).length;
  const _realCount = all.length - _prospectCount;
  // Update the Prospects toggle button label + badge so user
  // knows how many are hiding.
  const _prospectBadge = document.getElementById('prospectsCountBadge');
  const _prospectLabel = document.getElementById('prospectsBtnLabel');
  const _prospectBtn = document.getElementById('prospectsToggleBtn');
  if (_prospectBadge) {
    _prospectBadge.textContent = _prospectCount;
    _prospectBadge.style.display = _prospectCount > 0 ? 'inline-block' : 'none';
  }
  if (_prospectLabel) {
    _prospectLabel.textContent = _showProspects ? 'Hide Prospects' : 'Show Prospects';
  }
  if (_prospectBtn) {
    if (_showProspects) {
      _prospectBtn.style.background = 'rgba(189,87,40,.1)';
      _prospectBtn.style.borderColor = 'var(--orange)';
      _prospectBtn.style.color = 'var(--orange)';
    } else {
      _prospectBtn.style.background = '';
      _prospectBtn.style.borderColor = '';
      _prospectBtn.style.color = '';
    }
  }

  // Notify Prospects page (and any future listener) that the lead set
  // changed so it can refresh its filtered view + badge count.
  try { document.dispatchEvent(new CustomEvent('leadsChanged', { detail: { count: all.length, prospects: _prospectCount } })); } catch (e) {}

  setEl('crmTotalLeads', _realCount);
  setEl('crmPipeVal',    '$'+pipeVal.toLocaleString());
  setEl('crmApproved',  approvedCount);
  setEl('crmClosedRev', '$'+closedRev.toLocaleString());
  // Stat line — span-wrapped so CSS can hide the wordy bits on mobile.
  // Desktop reads:  "13 customers · $126,043 pipeline · 3 prospects"
  // Mobile  reads:  "13 · $126K · 3"  (.crm-stat-word + .crm-stat-money-full
  // hidden, .crm-stat-money-short shown via the responsive rule in
  // dashboard.html).
  const _fmtMoneyShort = pipeVal >= 1000000
    ? '$' + (pipeVal/1000000).toFixed(pipeVal >= 10000000 ? 0 : 1) + 'M'
    : pipeVal >= 1000
      ? '$' + Math.round(pipeVal/1000) + 'K'
      : '$' + pipeVal;
  const _subLineEl = document.getElementById('crmSubLine');
  if (_subLineEl) {
    _subLineEl.innerHTML =
      '<span class="crm-stat-num">' + _realCount + '</span>' +
      '<span class="crm-stat-word"> customers</span>' +
      ' · ' +
      '<span class="crm-stat-money-full">$' + pipeVal.toLocaleString() + '</span>' +
      '<span class="crm-stat-money-short">' + _fmtMoneyShort + '</span>' +
      '<span class="crm-stat-word"> pipeline</span>' +
      (_prospectCount > 0
        ? ' · <span class="crm-stat-num">' + _prospectCount + '</span>' +
          '<span class="crm-stat-word"> prospects</span>'
        : '');
  }
  // dashboard cards
  setEl('statLeads', all.length);
  setEl('statVal',   '$'+pipeVal.toLocaleString());
  setEl('statClosed','$'+closedRev.toLocaleString());
  const lb=document.getElementById('leadBadge'); if(lb) lb.textContent=all.length;

  // Dashboard "Lead Stages" tiles — every lead counts in exactly ONE tile,
  // decided by crm-stages.js dashboardTileFor (role first, then the Simple
  // board column an active stage folds into). Until 2026-10-03 this was a
  // hand-copied 6-bucket map: signed contracts counted as "Estimate Sent",
  // production as "Negotiating", and Inspected + every insurance stage were
  // never counted at all. Rules + fixture: tests/dashboard-stage-tiles-2026-10-03.test.js.
  const _stageCounts = _dashboardTileCounts(all);
  setEl('dp-new', _stageCounts.new);
  setEl('dp-ct', _stageCounts.working);
  setEl('dp-es', _stageCounts.estimate);
  setEl('dp-ng', _stageCounts.production);
  setEl('dp-won', _stageCounts.won);
  setEl('dp-lost', _stageCounts.lost);

  // Show/hide Load Sample Data button (only when a CONFIRMED load returned
  // zero leads). `all` is [] while the first loadLeads() is in flight and
  // after it fails, so gating on the count alone offered "Sample data" on
  // an unloaded board — the same "not loaded ≠ empty" rule the diagnostic
  // below and loadSampleData() itself (dashboard-actions.js) key off.
  const sampleBtn = document.getElementById('loadSampleDataBtn');
  if (sampleBtn) {
    sampleBtn.style.display = (all.length === 0 && window._leadsLoaded === true) ? 'inline-block' : 'none';
  }

  // Show diagnostic panel ONLY if a successful load returned zero leads.
  // Previously this fired any time `all.length === 0`, including the
  // transient empty cache that loadLeads writes when its first Firestore
  // read fails (common on iOS app-wake — the SDK retries internally and
  // recovers within seconds). The user got a scary "Your kanban isn't
  // loading" screen on cold start that vanished on the next refresh.
  // Now we wait for window._leadsLoaded === true before deciding the
  // account is genuinely empty. While the load is still pending we
  // simply hide the diagnostic and let the loader's auto-retry resolve.
  const diagnostic = document.getElementById('crmDiagnostic');
  const diagnosticDetails = document.getElementById('crmDiagnosticDetails');
  const loadCompleted = window._leadsLoaded === true;
  // AN EMPTY BOARD IS NOT A BROKEN BOARD.
  //
  // This gate was (loadCompleted && all.length === 0), which every brand-new
  // account satisfies permanently — they have no leads by definition. So a
  // first-time contractor clicking any track tab, toggling Board/List, clearing
  // a search or reloading on #/crm was shown an orange-bordered panel reading
  // "⚠️ CRM Diagnostic — Your kanban isn't loading", above a monospace dump of
  // his email and Firebase UID and the line "Firestore rules blocking reads
  // (check Firebase Console)". Nothing was wrong. It is the most alarming
  // thing this product can say to someone on day one, and it recurred all
  // session because the dismiss isn't persisted.
  //
  // The diagnostic is genuinely valuable when a read actually FAILS, so the
  // discriminator is the error, not the count — same correction as the
  // load-status banner (#1118).
  const loadErr = window._loadLeadsLastError || null;
  const title = document.getElementById('crmDiagnosticTitle');
  const lede = document.getElementById('crmDiagnosticLede');
  const debugTools = document.getElementById('crmDiagnosticDebugTools');
  const debugToggle = document.getElementById('crmDiagnosticDebugToggle');
  const _setDebugVisible = (on) => {
    if (debugTools) debugTools.style.display = on ? 'contents' : 'none';
    if (debugToggle) debugToggle.style.display = on ? '' : 'none';
    if (diagnosticDetails) diagnosticDetails.style.display = on ? '' : 'none';
  };

  if (loadCompleted && all.length === 0 && window._user?.uid && diagnostic && diagnosticDetails) {
    if (loadErr) {
      // Genuine failure — the original diagnostic, unchanged.
      if (title) title.textContent = '⚠️ CRM Diagnostic';
      if (lede) lede.textContent = "Your kanban isn't loading. Here's what we're seeing:";
      _setDebugVisible(true);
      const details = [
        `✓ User authenticated: ${window._user.email}`,
        `✓ User ID: ${window._user.uid}`,
        `✓ Database connected: ${window.db ? 'Yes' : 'No'}`,
        `✓ Leads in memory: ${all.length}`,
        `✗ Last error: ${(loadErr.code || loadErr.name || 'error')}: ${(loadErr.message || '').slice(0, 160)}`,
        ``,
        `Possible causes:`,
        `1. Firestore rules blocking reads (check Firebase Console)`,
        `2. Network connectivity issue`,
        ``,
        `Click Retry Load, or Load Sample Data to add 5 test leads`
      ];
      diagnosticDetails.textContent = details.join('\n');
    } else {
      // Simply empty — a first-run invitation, not an error report. No UID
      // dump, no rules blame, no debug tools; Load Sample Data stays because
      // an empty account is exactly who wants to see a populated board.
      if (title) title.textContent = '👋 Your pipeline is ready';
      if (lede) {
        lede.textContent = 'No leads yet — tap ＋ Add Lead to create your first one, '
          + 'or load a few samples to see how the board works.';
      }
      _setDebugVisible(false);
    }
    diagnostic.style.display = 'block';
  } else if (diagnostic) {
    diagnostic.style.display = 'none';
  }

  // Follow-up overdue — skip effectively-closed deals by semantic stageRole
  // (won / lost / in-production job) rather than a hardcoded name list, which
  // missed final_payment + any custom won/lost stage and so nagged "due" on
  // done deals. Mirrors the role idiom used for pipeline value above; the name
  // list stays as a fallback for before stageRole is loaded.
  const today=new Date(); today.setHours(0,0,0,0);
  const _terminalStages = ['closed','lost','Complete','Lost','final_payment'];
  const overdue = all.filter(l=>{
    if(!l.followUp) return false;
    const sk = l._stageKey || l.stage || '';
    const role = l._stageRole || (typeof window.stageRole === 'function' ? window.stageRole(sk) : 'active');
    if(role === 'won' || role === 'lost' || role === 'job') return false;
    if(_terminalStages.includes(sk) || _terminalStages.includes(l.stage||'')) return false;
    const d=_followUpDay(l.followUp); return d<=today;
  });
  setEl('crmFollowUps', overdue.length);
  const fp=document.getElementById('followUpPill');
  if(fp) fp.style.display = overdue.length ? 'flex':'none';
  // Follow-up alerts — render into the inner div, show/hide the wrapper.
  // Respect the dismiss flag so the user can hide them for the session.
  // Also stand aside while the board is narrowed (2026-09-25 phone audit):
  // `overdue` comes from the whole book, not the search/filter result, so a
  // search for "deluca" kept five unrelated follow-up rows (~350px on a
  // phone) above its two matches, and with the keyboard up not one match
  // was on screen. window._filteredLeads is non-null exactly when a search,
  // damage-type or filter-registry subset is showing; the block comes back
  // when it clears, and the header's follow-up pill keeps the count. The
  // rows still render while hidden, so the pill's scrollToFollowUps (an
  // explicit "show me") never unhides a stale list.
  const alertWrap=document.getElementById('followUpAlertsWrap');
  const alertBox=document.getElementById('followUpAlerts');
  const dismissed = localStorage.getItem('nbd_crm_followup_hidden') === '1';
  const narrowed = window._filteredLeads != null;
  if(alertWrap && alertBox){
    if(overdue.length && !dismissed){
      const label = document.getElementById('followUpAlertsLabel');
      if (label) label.textContent = overdue.length + ' Follow-up' + (overdue.length === 1 ? '' : 's') + ' Due';
      _renderFollowUpRows(alertBox, overdue);
      alertWrap.style.display = narrowed ? 'none' : 'block';
    } else { alertWrap.style.display='none'; }
  }

  // ── Lean triage list (2026-07-06) ──
  // When list mode is on (body.crm-list-mode, persisted per device),
  // render the SAME fully-narrowed `list` as a sortable table. The
  // kanban columns below STILL build (hidden by CSS) so every side
  // effect — counts, badges, per-column totals — keeps running and
  // toggling back to Board is instant.
  if (window.CrmListView) {
    if (window.CrmListView.isActive()) window.CrmListView.render(list);
    else window.CrmListView.clear();
  }

  // ── Build kanban columns ──
  // Use stage keys if available (new system), fall back to legacy display names
  const stageKeys = window._stageKeys || null;
  const byStage = {};
  // Leads whose OWN stage is hidden (builder eye-toggle) have no column to live
  // in. partitionLeadsByColumn keeps them OUT of the columns (so they don't
  // mislabel/inflate the first column) and hands them back here so the board's
  // hidden-stage chip can surface them instead of silently dropping them from
  // the counts + $ totals. Populated by the new-system branch below; stays
  // empty on the legacy path (which has no hidden-stage concept). #921 follow-up.
  let _hiddenStageLeads = [];

  if (stageKeys) {
    // NEW SYSTEM: Use internal stage keys + resolveColumn for mapping.
    const _resolve = window.resolveColumn;
    const _normalize = window.normalizeStage;
    const _META = window.STAGE_META || {};
    // partitionLeadsByColumn (crm-stages.js) is the single source of truth for
    // "which lead lands in which column, and which have no column at all". The
    // board, the hidden-stage chip, and the unit test all share it so the
    // bucketing, the $ totals, and the chip's count can never drift apart.
    // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window
    // global; registry missing → the inline fallback below, as before.
    const _nbdReg = window.__NBD_CALL_REGISTRY;
    if (_nbdReg && typeof _nbdReg.partitionLeadsByColumn === 'function') {
      const _part = _nbdReg.partitionLeadsByColumn(list, stageKeys, {
        stageMeta: _META, normalize: _normalize, resolve: _resolve,
      });
      Object.assign(byStage, _part.columns);
      _hiddenStageLeads = _part.hidden;
    } else {
      // Fallback (crm-stages failed to load) — behaviour-identical inline loop.
      stageKeys.forEach(k => byStage[k] = []);
      list.forEach(l => {
        const sk = l._stageKey || (_normalize ? _normalize(l.stage) : (l.stage || 'new'));
        const _hk = _normalize ? _normalize(sk) : sk;
        if (_META[_hk] && _META[_hk].hidden) { _hiddenStageLeads.push(l); return; }
        const col = _resolve ? _resolve(sk, stageKeys) : sk;
        if (byStage[col]) byStage[col].push(l);
        else if (byStage[stageKeys[0]]) byStage[stageKeys[0]].push(l);
      });
    }

    // W93: optional sort within each column by engagement tier
    // descending. Toggled via the kanban header "🔥 Hot first"
    // button. Stable sort — leads with the same tier preserve
    // their original order so the rep sees a consistent shuffle
    // (Hot leads bubble up, everything else stays put).
    const _engSort = (typeof localStorage !== 'undefined') &&
                     (localStorage.getItem('nbd_crm_sort_engagement') === '1');
    if (_engSort && window.CustomerEngagementScore
        && typeof window.CustomerEngagementScore.computeTier === 'function') {
      const allEsts = Array.isArray(window._estimates) ? window._estimates : [];
      const tierFor = (l) => {
        const t = window.CustomerEngagementScore.computeTier(l, allEsts);
        return t ? t.tier : 0;
      };
      stageKeys.forEach(k => {
        // Decorate-sort-undecorate so we don't recompute tier per
        // comparison (N×log(N) computeTier calls becomes N).
        const decorated = byStage[k].map((l, i) => ({ l, i, t: tierFor(l) }));
        decorated.sort((a, b) => (b.t - a.t) || (a.i - b.i));
        byStage[k] = decorated.map(d => d.l);
      });
    }

    stageKeys.forEach(stageKey => {
      const body  = document.getElementById('kbody-'+stageKey);
      const count = document.getElementById('kcount-'+stageKey);
      const total = document.getElementById('ktotal-'+stageKey);
      if(!body) return;
      const cards = byStage[stageKey]||[];
      if(count) count.textContent = cards.length;
      // R5.5: per-column $ total. Sums jobValue across cards in this
      // stage so the rep sees both "how many" and "how much" without
      // counting in their head. Hidden when 0 cards or 0 total value
      // (e.g. all leads at this stage are pre-estimate).
      if (total) {
        const sumVal = cards.reduce((s, l) => s + (Number(l && l.jobValue) || 0), 0);
        if (cards.length && sumVal > 0) {
          const fmt = sumVal >= 1000
            ? (sumVal >= 1000000
                ? '$' + (sumVal / 1000000).toFixed(sumVal >= 10000000 ? 0 : 1) + 'M'
                : '$' + Math.round(sumVal / 1000) + 'K')
            : '$' + sumVal.toLocaleString();
          total.textContent = fmt;
          total.style.display = '';
          total.title = '$' + sumVal.toLocaleString() + ' total in this stage';
        } else {
          total.style.display = 'none';
        }
      }
      if(!cards.length){ body.innerHTML='<div class="k-empty"><div class="k-empty-line">Drop leads here</div></div>'; return; }
      renderColumnCards(body, cards, stageKey);
      _highlightCardMatches(body); // CO-M-1: highlight after parse, text nodes only
      wireKanbanCardListeners(body);
      // attach drag events to cards
      body.querySelectorAll('.k-card').forEach(card=>{
        card.addEventListener('dragstart', e=>{ _dragId=card.dataset.id; window._dragJobId = card.dataset.jobId || null; card.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', card.dataset.id); e.dataTransfer.setData('application/x-nbd-job', card.dataset.jobId || ''); });
        card.addEventListener('dragend',   e=>{ card.classList.remove('dragging'); });
      });
      // Clean up previous drag listeners before adding new ones (prevents memory leak)
      if (body._dragHandlers) {
        body.removeEventListener('dragover', body._dragHandlers.over);
        body.removeEventListener('dragleave', body._dragHandlers.leave);
        body.removeEventListener('drop', body._dragHandlers.drop);
      }
      const overHandler = e=>{ e.preventDefault(); e.dataTransfer.dropEffect='move'; body.classList.add('drag-over'); };
      const leaveHandler = e=>{ if(e.target===body) body.classList.remove('drag-over'); };
      // Wave 103: race-safe drop. Read the dragged ID from
      // dataTransfer (event-scoped) rather than the module-global
      // _dragId. On rapid re-drag or multi-touch hybrid input the
      // module global gets overwritten by the second dragstart
      // before the first drop reads it — wrong card moves to the
      // target column with no error surfaced. dataTransfer is per
      // event so it's race-safe by construction. Fall back to
      // _dragId if dataTransfer is empty (some legacy browsers).
      const dropHandler = e => {
        e.preventDefault();
        // Stop the drop from bubbling to the board-level delegated drop handler
        // (#kanbanBoard) — without this BOTH fire and moveCard runs twice for
        // one drop (double timeline note / double stageStartedAt churn, and a
        // race window on the second move).
        e.stopPropagation();
        body.classList.remove('drag-over');
        const draggedId = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || _dragId;
        if (!draggedId) return;
        const draggedJob = (e.dataTransfer && e.dataTransfer.getData('application/x-nbd-job')) || window._dragJobId || null;
        moveCard(draggedId, stageKey, { isDrag: true, jobId: draggedJob || undefined });
        _dragId = null; window._dragJobId = null;
      };
      body.addEventListener('dragover', overHandler);
      body.addEventListener('dragleave', leaveHandler);
      body.addEventListener('drop', dropHandler);
      body._dragHandlers = { over: overHandler, leave: leaveHandler, drop: dropHandler };
    });
  } else {
    // LEGACY FALLBACK: Use display name stages
    const STAGES = window.STAGES || ['New','Inspected','Estimate Sent','Approved','In Progress','Complete','Lost'];
    STAGES.forEach(s=>byStage[s]=[]);
    list.forEach(l=>{ const s=l.stage||'New'; if(byStage[s]) byStage[s].push(l); else byStage['New'].push(l); });

    // W93: same engagement-tier sort applied to the legacy path
    // for full coverage. Same compute + decorate-sort-undecorate
    // shape as the new-system branch above.
    const _engSortLegacy = (typeof localStorage !== 'undefined') &&
                           (localStorage.getItem('nbd_crm_sort_engagement') === '1');
    if (_engSortLegacy && window.CustomerEngagementScore
        && typeof window.CustomerEngagementScore.computeTier === 'function') {
      const allEsts = Array.isArray(window._estimates) ? window._estimates : [];
      const tierFor = (l) => {
        const t = window.CustomerEngagementScore.computeTier(l, allEsts);
        return t ? t.tier : 0;
      };
      STAGES.forEach(s => {
        const decorated = byStage[s].map((l, i) => ({ l, i, t: tierFor(l) }));
        decorated.sort((a, b) => (b.t - a.t) || (a.i - b.i));
        byStage[s] = decorated.map(d => d.l);
      });
    }

    STAGES.forEach(stage=>{
      const body  = document.getElementById('kbody-'+stage);
      const count = document.getElementById('kcount-'+stage);
      if(!body) return;
      const cards = byStage[stage]||[];
      if(count) count.textContent = cards.length;
      if(!cards.length){ body.innerHTML='<div class="k-empty"><div class="k-empty-line">Drop leads here</div></div>'; return; }
      renderColumnCards(body, cards, stage);
      _highlightCardMatches(body); // CO-M-1: highlight after parse, text nodes only
      // Wire card-click / checkbox / task-badge / ◀▶ arrows / ⋮ menu — the
      // new-system branch calls this (line ~480) but the legacy fallback never
      // did, so in the fallback state (crm-stages load race → _stageKeys unset)
      // every card was non-interactive (only drag worked).
      wireKanbanCardListeners(body);
      body.querySelectorAll('.k-card').forEach(card=>{
        card.addEventListener('dragstart', e=>{ _dragId=card.dataset.id; window._dragJobId = card.dataset.jobId || null; card.classList.add('dragging'); e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', card.dataset.id); e.dataTransfer.setData('application/x-nbd-job', card.dataset.jobId || ''); });
        card.addEventListener('dragend',   e=>{ card.classList.remove('dragging'); });
      });
      // Clean up previous drag listeners (prevents memory leak on re-render)
      if (body._dragHandlers) {
        body.removeEventListener('dragover', body._dragHandlers.over);
        body.removeEventListener('dragleave', body._dragHandlers.leave);
        body.removeEventListener('drop', body._dragHandlers.drop);
      }
      const overH = e=>{ e.preventDefault(); e.dataTransfer.dropEffect='move'; body.classList.add('drag-over'); };
      const leaveH = e=>{ if(e.target===body) body.classList.remove('drag-over'); };
      // W103: same race-safe drop as the new-system path above.
      const dropH = e => {
        e.preventDefault();
        body.classList.remove('drag-over');
        const draggedId = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || _dragId;
        if (!draggedId) return;
        const draggedJob = (e.dataTransfer && e.dataTransfer.getData('application/x-nbd-job')) || window._dragJobId || null;
        moveCard(draggedId, stage, { isDrag: true, jobId: draggedJob || undefined });
        _dragId = null; window._dragJobId = null;
      };
      body.addEventListener('dragover', overH);
      body.addEventListener('dragleave', leaveH);
      body.addEventListener('drop', dropH);
      body._dragHandlers = { over: overH, leave: leaveH, drop: dropH };
    });
  }

  // Surface the leads that were kept off the board because their stage is
  // hidden — otherwise their count + $ silently vanish from the pipeline.
  renderHiddenStageChip(_hiddenStageLeads);
  // "N customers have no job type — Sort them" (sort-customers.js).
  if (window.NBDSortCustomers && typeof window.NBDSortCustomers.refresh === 'function') {
    try { window.NBDSortCustomers.refresh(); } catch (e) { console.warn('[sort-customers] banner failed', e); }
  }
}

// ── Hidden-stage leads chip (board-level affordance) ──────────────
// A company_admin can hide a built-in stage via the Pipelines builder
// eye-toggle. Leads still sitting on that stage have no column, so
// partitionLeadsByColumn keeps them off the board (see the render loop above).
// Without an affordance they'd vanish from the board's counts + $ totals with
// no trace — e.g. hiding "Negotiating" with 5 live leads worth $80k would drop
// $80k off the visible pipeline. This chip restores that visibility: it shows
// the count + $ and expands to a filtered list grouped by hidden stage, each
// row deep-linking into the lead. The stage field is untouched and the leads
// remain fully visible in List view. Rendered directly (with addEventListener
// wiring, not inline on*= handlers) so it stays live under the prod CSP.
function renderHiddenStageChip(leads) {
  const wrap = document.getElementById('hiddenStageWrap');
  if (!wrap) return;
  if (!leads || !leads.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }

  const META = window.STAGE_META || {};
  const _norm = window.normalizeStage;
  const sumVal = leads.reduce((s, l) => s + (Number(l && l.jobValue) || 0), 0);
  const fmtMoney = (n) => n >= 1000000
    ? '$' + (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M'
    : (n >= 1000 ? '$' + Math.round(n / 1000) + 'K' : '$' + n.toLocaleString());

  // Group by the hidden stage so the expanded list reads "Negotiating · 5 …".
  const byHidden = {};
  leads.forEach(l => {
    const sk = l._stageKey || (_norm ? _norm(l.stage) : (l.stage || 'new'));
    const hk = _norm ? _norm(sk) : sk;
    (byHidden[hk] = byHidden[hk] || []).push(l);
  });

  const n = leads.length;
  const moneyBit = sumVal > 0 ? ' · ' + fmtMoney(sumVal) : '';
  const chipLabel = '⚠️ ' + n + ' lead' + (n === 1 ? '' : 's') +
    ' on hidden stage' + (n === 1 ? '' : 's') + moneyBit;

  const rowsHtml = Object.keys(byHidden).map(hk => {
    const label = (META[hk] && META[hk].label) || hk;
    const grp = byHidden[hk];
    const cards = grp.map(l => `
        <div class="follow-up-alert">
          <span class="fa-name">${escHtml(l.firstName || '')} ${escHtml(l.lastName || '')}</span>
          <span class="fa-addr cpx-cm-fs11px">${escHtml(String(l.address || '').split(',')[0])}</span>
          <button class="fa-btn nbd-hidden-edit" data-lead-id="${escHtml(l.id)}">View →</button>
        </div>`).join('');
    return `<div class="cpx-mb8px">
        <div class="cpx-fs10px-w700-ls08em">${escHtml(label)} · ${grp.length}</div>
        ${cards}
      </div>`;
  }).join('');

  wrap.style.display = 'block';
  wrap.innerHTML = `
    <button type="button" id="hiddenStageChip" title="These leads are on a stage you've hidden from the board. Their $ is excluded from the column totals. Click to view them." class="cpx-dinlinefl-aicenter-gap6px">
      <span>${escHtml(chipLabel)}</span>
      <span class="hs-caret cpx-cm">▸</span>
    </button>
    <div id="hiddenStageList" style="display:none;margin-top:8px;">${rowsHtml}</div>`;

  const chip = document.getElementById('hiddenStageChip');
  const listEl = document.getElementById('hiddenStageList');
  const caret = wrap.querySelector('.hs-caret');
  if (chip && listEl) {
    chip.addEventListener('click', () => {
      const open = listEl.style.display !== 'none';
      listEl.style.display = open ? 'none' : 'block';
      if (caret) caret.textContent = open ? '▸' : '▾';
    });
  }
  wrap.querySelectorAll('.nbd-hidden-edit').forEach(btn => {
    btn.addEventListener('click', () => editLead(btn.dataset.leadId));
  });
}

// W136: per-page localStorage cache of last-seen score per lead so
// the kanban can render a tiny ↑/↓/─ trend arrow next to the score
// badge. Initialized lazily on first card render.
const _leadScoreLastSeen = (function () {
  try {
    const raw = localStorage.getItem('nbd_lead_score_last_v1');
    return raw ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
})();
function _persistLeadScoreLastSeen() {
  try { localStorage.setItem('nbd_lead_score_last_v1', JSON.stringify(_leadScoreLastSeen)); }
  catch (_) { /* quota / private mode — best effort */ }
}
let _leadScoreFlushTimer = 0;
function _scheduleLeadScorePersist() {
  if (_leadScoreFlushTimer) return;
  _leadScoreFlushTimer = setTimeout(() => {
    _leadScoreFlushTimer = 0;
    _persistLeadScoreLastSeen();
  }, 1500);
}

// ── Damage-type → trade-iconed chip ──
// Sweep R3: was rendering raw "ROOF - WIND" with the dated
// space-hyphen-space format and no visual cue to the trade. Now
// produces { icon, label } from the canonical TRADES icon set
// (defined in crm-stages.js) so cards read like "🏠 Wind" or
// "🧱 Hail" at a glance. Falls back to the raw label for any
// unrecognized damage strings so we never blank-render bad data.
function _damageToChip(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Map the lowercase trade prefix to an icon. The trade icons mirror
  // window.TRADES from crm-stages.js — duplicated here as a small
  // lookup so the card render doesn't have to wait for the ES module
  // to expose TRADES on window (which only happens after the
  // dashboard.html module script runs).
  const TRADE_ICON = {
    roof:      '🏠',
    gutters:   '🌧️',
    siding:    '🧱',
    windows:   '🪟',
    fascia:    '🔲',
    paint:     '🎨',
    skylights: '☀️',
    other:     '🔧'
  };
  // Common damage strings split on " - " (hyphen with spaces) into
  // <trade> - <cause>. Anything that doesn't match the pattern gets
  // a heuristic icon based on keyword sniff.
  let icon = '';
  let label = s;
  const m = /^([A-Za-z][A-Za-z\/ ]+?)\s*-\s*(.+)$/.exec(s);
  if (m) {
    const tradeWord = m[1].trim().toLowerCase().split(/\s|\//)[0];
    icon = TRADE_ICON[tradeWord] || '';
    label = m[2].trim();
  } else {
    // Single-word damage types from the existing form options.
    const lower = s.toLowerCase();
    if (/^gutters?$/.test(lower))           icon = TRADE_ICON.gutters;
    else if (/^siding/.test(lower))          icon = TRADE_ICON.siding;
    else if (/^windows?$/.test(lower))       icon = TRADE_ICON.windows;
    else if (/^skylights?$/.test(lower))     icon = TRADE_ICON.skylights;
    else if (/^paint/.test(lower))           icon = TRADE_ICON.paint;
    else if (/^fascia|soffit/.test(lower))   icon = TRADE_ICON.fascia;
    else if (/^full\s*exterior$/.test(lower)) icon = '🏘️';
    else if (/^fire$/.test(lower))           icon = '🔥';
    else if (/^water$/.test(lower))          icon = '💧';
    else if (/^storm\s*damage$/.test(lower)) icon = '⛈';
    else if (/^other$/.test(lower))          icon = TRADE_ICON.other;
    else if (/^roof/.test(lower))            icon = TRADE_ICON.roof;
  }
  return { icon, label };
}

function buildCard(l){
  const nameRaw = ((l.firstName||l.fname||'')+'  '+(l.lastName||l.lname||'')).trim() || l.name||'Unknown';
  const name  = escHtml(nameRaw);
  // T1.e: strip the leading-comma artifact some upstream USPS-style
  // formatters insert between house number and street ("3424, Moria Drive").
  // Display as plain "3424 Moria Drive, Cincinnati" by collapsing
  // "<digits>,<space>" → "<digits> ".
  // Audit C — wrap in String() so a malformed lead with `address` stored
  // as an object/array/number (possible via Firestore-console hand edits or
  // bad imports) doesn't blow up the entire kanban column when buildCard
  // throws TypeError on `.replace`. Same defense applied to `phone`/`email`
  // below.
  const _addrRaw = String(l.address||'').replace(/^(\d+),\s+/, '$1 ');
  const addr  = escHtml(_addrRaw.split(',').slice(0,2).join(','));
  const val   = l.jobValue ? '$'+parseFloat(l.jobValue).toLocaleString() : '';
  const today = new Date(); today.setHours(0,0,0,0);
  const _sk = l._stageKey || (window.normalizeStage ? window.normalizeStage(l.stage) : l.stage || 'new');
  const isTerminal = ['closed','lost','Complete','Lost'].includes(_sk) || ['closed','lost','Complete','Lost'].includes(l.stage||'');
  const overdue = l.followUp && _followUpDay(l.followUp)<=today && !isTerminal;
  // Prev/next arrows use stage keys
  const _keys = window._stageKeys || [];
  const stageIdx = _keys.indexOf(_sk);
  const prevS = stageIdx>0 ? _keys[stageIdx-1] : null;
  // "Next" never means Lost (CRM sweep R14, 2026-09-28): Lost sorts last in
  // every view, so the last working column's ▶ read "→ Lost" (Contract Signed
  // on the stock Insurance board) — one tap toward losing a signed job.
  // Losing is its own action (context menu / stage picker), not progress.
  let nextS = null;
  if (stageIdx >= 0) {
    for (let _i = stageIdx + 1; _i < _keys.length; _i++) {
      const _role = typeof window.stageRole === 'function' ? window.stageRole(_keys[_i]) : (_keys[_i] === 'lost' ? 'lost' : '');
      if (_role !== 'lost') { nextS = _keys[_i]; break; }
    }
  }
  const prevLabel = prevS && window.STAGE_META?.[prevS]?.label || prevS || '';
  const nextLabel = nextS && window.STAGE_META?.[nextS]?.label || nextS || '';

  // Task badge. Add-Event entries (type:'event', customer page) share the
  // tasks subcollection but are dated appointments, not to-dos — counting
  // them left a card at "☑ 0/2" forever for one real task + one meeting
  // (CRM sweep R14, 2026-09-28). The customer page already excludes them.
  const tasks = (window._taskCache?.[l.id] || []).filter(t => t && t.type !== 'event');
  const totalT = tasks.length;
  const doneT  = tasks.filter(t=>t.done).length;
  
  // Task completion rate
  let completionRate = 0;
  if(totalT > 0) {
    completionRate = Math.round((doneT / totalT) * 100);
  }
  const overdueT = tasks.filter(t=>!t.done && t.dueDate && new Date(t.dueDate+'T23:59:59') < new Date()).length;
  // R4.4 + R5.11: when the lead has 0 tasks, render an icon-only ghost
  // pill so the CTA stops competing with real action signals (Due /
  // Needs X / next-best-action). Tooltip carries the "+ Tasks" intent
  // for discoverability.
  let taskBadgeClass = totalT ? 'kc-task-badge' : 'kc-task-badge empty';
  let taskBadgeLabel = totalT ? `☑ ${doneT}/${totalT}` : '+';
  if(totalT && overdueT){ taskBadgeClass += ' has-overdue'; taskBadgeLabel = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="cpx-wd11px-hei11px-vermiddle"><path d="M10 3L2 17h16L10 3z"/><path d="M10 8v4M10 14.5v.5"/></svg> ${overdueT} overdue`; }
  else if(totalT && doneT===totalT) { 
    taskBadgeClass += ' all-done'; 
    taskBadgeLabel = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="cpx-wd11px-hei11px-vermiddle"><circle cx="10" cy="10" r="7"/><path d="M7 10l2 2 4-5"/></svg> 100%`;
  }
  else if(totalT && completionRate >= 50) {
    taskBadgeClass += ' has-tasks';
    taskBadgeLabel = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="cpx-wd11px-hei11px-vermiddle"><path d="M4 10.5l4 4 8-9"/></svg> ${doneT}/${totalT} (${completionRate}%)`;
  }
  else if(totalT) taskBadgeClass += ' has-tasks';

  // Days since last contact / created
  let daysLabel = '', daysClass = 'kc-days-fresh';
  if(!['Complete','Lost'].includes(l.stage||'')) {
    let ref = null;
    if(l.updatedAt?.toDate) ref = l.updatedAt.toDate();
    else if(l.createdAt?.toDate) ref = l.createdAt.toDate();
    else if(l.createdAt instanceof Date) ref = l.createdAt;
    else if(l.createdAt) ref = new Date(l.createdAt);

    if(ref && ref instanceof Date && !isNaN(ref)) {
      // Normalize ref to midnight for accurate day comparison
      const refNorm = new Date(ref);
      refNorm.setHours(0,0,0,0);
      const days = Math.floor((today - refNorm) / 86400000);

      if(days < 0)        { daysLabel = 'Today';        daysClass = 'kc-days-fresh'; } // Future date edge case
      else if(days === 0) { daysLabel = 'Today';        daysClass = 'kc-days-fresh'; }
      else if(days === 1) { daysLabel = '1d ago';       daysClass = 'kc-days-fresh'; }
      else if(days <= 5)  { daysLabel = `${days}d ago`; daysClass = 'kc-days-warm'; }
      else                { daysLabel = `${days}d ago`; daysClass = 'kc-days-cold'; }
    }
  }

  // ── Wave 17: stage-aging cue ──
  // Distinct from the "days since last contact" badge above — this
  // measures how long the lead has sat AT THE CURRENT STAGE. A lead
  // that was contacted yesterday but stuck at "estimate sent" for 21
  // days is a different problem than a lead that's only 1 day old.
  // Skipped on terminal stages (closed/lost/Complete) since those
  // don't need attention. The visual cue is two parts: a left-border
  // tint via k-card-aging-* classes, and a compact "Nd in stage" pill
  // next to the customer name.
  let stageAgingClass = '';   // applied to .k-card root
  let stageAgeBadge   = '';   // injected next to the name
  const _terminal = ['closed','lost','Complete','Lost','final_payment'];
  if(!_terminal.includes(l.stage||'') && !_terminal.includes(_sk||'')) {
    let stageRef = null;
    const stageStart = l.stageStartedAt;
    if(stageStart?.toDate)        stageRef = stageStart.toDate();
    else if(stageStart instanceof Date) stageRef = stageStart;
    else if(stageStart)           stageRef = new Date(stageStart);
    // Fall back to updatedAt → createdAt so cards predating the
    // stageStartedAt rollout still get an aging signal.
    else if(l.updatedAt?.toDate)  stageRef = l.updatedAt.toDate();
    else if(l.createdAt?.toDate)  stageRef = l.createdAt.toDate();

    if(stageRef && !isNaN(stageRef)) {
      const stageNorm = new Date(stageRef);
      stageNorm.setHours(0,0,0,0);
      const stageDays = Math.floor((today - stageNorm) / 86400000);
      // R4.2: shortened stage-age label. Was '33d in stage' (~13 chars)
      // which forced the top row to compete for space with the value
      // badge + count chips. Now just '33d' — the tooltip carries the
      // full context, and the semantic color already communicates
      // 'this is a stage-age signal, not a generic last-touch one.'
      if(stageDays >= 14) {
        stageAgingClass = 'k-card-aging-critical';
        stageAgeBadge = `<span class="kc-stage-age kc-stage-age-critical" title="In current stage for ${stageDays} days">${stageDays}d</span>`;
      } else if(stageDays >= 7) {
        stageAgingClass = 'k-card-aging-stale';
        stageAgeBadge = `<span class="kc-stage-age kc-stage-age-stale" title="In current stage for ${stageDays} days">${stageDays}d</span>`;
      } else if(stageDays >= 3) {
        stageAgingClass = 'k-card-aging-warming';
        stageAgeBadge = `<span class="kc-stage-age kc-stage-age-warming" title="In current stage for ${stageDays} days">${stageDays}d</span>`;
      }
    }
  }

  // T1.a: dedupe days. Two waves added overlapping signals to the card —
  // W17 "Nd in stage" (action signal: "this lead is stuck") and the older
  // "Nd ago" last-touch (freshness signal). They were both rendered on
  // every card, often showing the SAME number. Pick one:
  //   - stage stuck for 3+ days → show ONLY the stage-age badge
  //   - otherwise → show ONLY the last-touch label on the phone row
  if (stageAgeBadge) daysLabel = '';

  // ── Wave 44: last-shared badge ──
  // Surfaces a small "📤 shared 3d via SMS" pill when the rep has
  // shared the portal link with this customer. Helps reps remember
  // who they've reached out to and through which channel without
  // opening the customer detail page. Skipped when not yet shared.
  let lastSharedBadge = '';
  (function buildLastSharedBadge() {
    const sharedAt = l.lastSharedAt;
    if (!sharedAt) return;
    let ms = 0;
    if (typeof sharedAt.toMillis === 'function')      ms = sharedAt.toMillis();
    else if (typeof sharedAt.toDate === 'function')   ms = sharedAt.toDate().getTime();
    else if (sharedAt instanceof Date)                ms = sharedAt.getTime();
    else if (typeof sharedAt === 'number')            ms = sharedAt;
    if (!ms) return;
    const days = Math.floor((Date.now() - ms) / 86400000);
    let label;
    if (days <= 0)      label = 'today';
    else if (days === 1) label = 'yesterday';
    else if (days < 7)   label = `${days}d ago`;
    else if (days < 30)  label = `${Math.floor(days / 7)}w ago`;
    else                 label = `${Math.floor(days / 30)}mo ago`;
    const viaMap = { copy: 'copied', sms: 'SMS', email: 'email' };
    const via = viaMap[l.lastSharedVia] || 'shared';
    // Wave 57: fresh-share pulse. Shares within the last 24 hours
    // get a subtle 2.4s pulse animation so reps get a passive
    // visual cue when scrolling the kanban: "this just went out
    // a few hours ago." Older shares stay calm — pulsing every
    // single share badge would defeat the purpose.
    const ageMs = Date.now() - ms;
    const isFresh = ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000;
    const freshClass = isFresh ? ' kc-shared-fresh' : '';
    lastSharedBadge = `<span class="kc-tag${freshClass} cpx-bgcolormix-cpurple-borrgba1551" title="Portal link last shared via ${escHtml(via)} — ${escHtml(label)}">📤 ${escHtml(via)} ${escHtml(label)}</span>`;
  })();

  // ── Wave 58: customer-engagement indicator ──
  // Companion to the W44 share badge. Where W44 says "I sent it",
  // this badge says "they OPENED it" — by far the strongest buying
  // signal short of a signature. Pulls from window._estimates:
  // surfaces the latest viewedAt across the lead's estimates that
  // haven't been responded to.
  //
  // Skipped when: any estimate already responded to (signed /
  // declined / replied — the customer's already past the
  // viewing-but-uncommitted state); lead is in a terminal stage;
  // no viewed estimate exists.
  let viewedBadge = '';
  (function buildViewedBadge() {
    const estimates = Array.isArray(window._estimates) ? window._estimates : [];
    const sk = (l._stageKey || l.stage || 'new').toString();
    if (sk === 'closed' || sk === 'lost' || sk === 'Lost' || sk === 'Complete') return;

    let latestViewMs = 0;
    let anyResponded = false;
    for (const e of estimates) {
      if (!e || e.leadId !== l.id) continue;
      if (e.respondedAt) { anyResponded = true; break; }
      let ms2 = 0;
      const v = e.viewedAt;
      if (v && typeof v.toMillis === 'function')      ms2 = v.toMillis();
      else if (v && typeof v.toDate === 'function')   ms2 = v.toDate().getTime();
      else if (v instanceof Date)                     ms2 = v.getTime();
      else if (typeof v === 'number')                 ms2 = v;
      if (ms2 > latestViewMs) latestViewMs = ms2;
    }
    if (anyResponded) return;
    // 2026-09-16 (view-tracking fix, kept in lockstep with
    // customer-viewed-chip.js's matching badge — see that file's header
    // comment): estimate.viewedAt only fires from the standalone
    // estimate-view.html link. A homeowner who opens the main portal
    // (functions/portal.js stamps lead.lastPortalOpenAt on a genuine open)
    // never moved this badge before — it required at least one estimate to
    // exist at all. Counts exactly like an estimate view for "latest".
    let portalMs = 0;
    const po = l.lastPortalOpenAt;
    if (po && typeof po.toMillis === 'function')      portalMs = po.toMillis();
    else if (po && typeof po.toDate === 'function')   portalMs = po.toDate().getTime();
    else if (po instanceof Date)                      portalMs = po.getTime();
    else if (typeof po === 'number')                  portalMs = po;
    if (portalMs > latestViewMs) latestViewMs = portalMs;
    if (latestViewMs === 0) return;

    const days = Math.floor((Date.now() - latestViewMs) / 86400000);
    let label;
    if (days <= 0)      label = 'today';
    else if (days === 1) label = 'yesterday';
    else if (days < 7)   label = `${days}d ago`;
    else if (days < 30)  label = `${Math.floor(days / 7)}w ago`;
    else                 label = `${Math.floor(days / 30)}mo ago`;
    const ageMs2 = Date.now() - latestViewMs;
    const isFreshView = ageMs2 >= 0 && ageMs2 < 24 * 60 * 60 * 1000;
    const freshClass2 = isFreshView ? ' kc-viewed-fresh' : '';
    viewedBadge = `<span class="kc-tag${freshClass2} cpx-bgrgba4620-cgreen-borrgba4620" title="Customer opened the portal — ${escHtml(label)}">👁 viewed ${escHtml(label)}</span>`;
  })();

  // ── Wave 112: smart-follow-up suggestion pill ──
  // Shows the next-best-action priority + channel as a compact pill
  // in the kc-tags row. Clicking the pill is a no-op for now (the
  // W113 customer page panel hosts the full action UI). Skipped
  // when SmartFollowup isn't loaded or returns 'wait' / 'monitor'
  // — those are explicitly "no action" states and the pill would
  // just be visual noise.
  let smartFollowupBadge = '';
  (function buildSmartFollowupBadge() {
    if (!window.SmartFollowup
        || typeof window.SmartFollowup.computeSuggestion !== 'function') return;
    const sug = window.SmartFollowup.computeSuggestion(l);
    if (!sug) return;
    if (sug.priority === 'wait' || sug.priority === 'monitor') return;
    // T1.b: dedupe with the explicit overdue ⚠ Due chip. If the rep has
    // an overdue follow-up date AND the smart-followup engine also says
    // "Today", they're the same signal — skip this badge so we don't
    // render two-chips-for-one-meaning.
    if (overdue && sug.priority === 'today') return;
    // Color register matches the priority severity:
    //   urgent    → red    (act now)
    //   today     → orange (do today)
    //   this-week → blue   (sometime soon)
    let bg, color, border, icon, label;
    if (sug.priority === 'urgent') {
      bg = 'rgba(239,68,68,0.16)'; color = '#fca5a5'; border = 'rgba(239,68,68,0.45)';
      icon = '⚡'; label = 'Urgent';
    } else if (sug.priority === 'today') {
      bg = 'rgba(245,158,11,0.16)'; color = '#fcd34d'; border = 'rgba(245,158,11,0.45)';
      icon = '💡'; label = 'Today';
    } else { // this-week
      bg = 'rgba(96,165,250,0.16)'; color = '#93c5fd'; border = 'rgba(96,165,250,0.45)';
      icon = '👁'; label = 'Watch';
    }
    // Title attribute carries the headline + reasoning so reps can
    // hover to see WHY the suggestion fires without leaving the
    // kanban. The W113 panel will give the full UI.
    const tooltip = `${sug.headline}\n\n${sug.reasoning}`;
    smartFollowupBadge = `<span class="kc-tag" style="background:${bg};color:${color};border-color:${border};" title="${escHtml(tooltip)}">${icon} ${escHtml(label)}</span>`;
  })();

  // ── Wave 92: engagement tier badge ──
  // Compact aggregate of W44 share + W58 viewed + respondedAt
  // signals into a single chip on the kanban card. The customer
  // page got the same tier in W91; this brings it to the kanban
  // so reps can prioritize their column at a glance without
  // having to read three separate badges.
  //
  // Skipped on tier 0 (no signals) so non-engaged cards stay
  // clean. Also skipped on terminal stages — a "Responded"
  // badge on a closed deal is just visual noise.
  let engagementBadge = '';
  (function buildEngagementBadge() {
    if (!window.CustomerEngagementScore
        || typeof window.CustomerEngagementScore.computeTier !== 'function') return;
    const sk = (l._stageKey || l.stage || 'new').toString().toLowerCase();
    if (sk === 'closed' || sk === 'lost' || sk === 'complete') return;
    const allEsts = Array.isArray(window._estimates) ? window._estimates : [];
    const tier = window.CustomerEngagementScore.computeTier(l, allEsts);
    if (!tier || tier.tier === 0) return;
    engagementBadge = `<span class="kc-tag" style="background:${tier.bg};color:${tier.color};border-color:${tier.border};" title="${escHtml(tier.title || tier.label)}">${tier.icon} ${escHtml(tier.label)}</span>`;
  })();

  // ── Wave 136: Lead Intelligence score badge ──
  // Single 0-100 priority pill in the top-meta row. Tier color +
  // optional trend arrow vs. the last score we persisted for this
  // lead. The number itself is intentionally small and quiet — the
  // colored dot is the at-a-glance signal; the digits answer
  // "exactly how hot?" only when the rep zooms in.
  //
  // Wave 137 will make this clickable to open the breakdown panel
  // on the customer page; for now it's purely visual.
  let leadScoreBadge = '';
  try {
    if (window.NBDLeadScore && typeof window.NBDLeadScore.breakdown === 'function') {
      const b = window.NBDLeadScore.breakdown(l, { estimates: window._estimates || [] });
      const score = b.score;
      const color = window.NBDLeadScore.tierColor(score);
      // Trend arrow vs. previous render. ±2 deadband so the arrow
      // doesn't flicker on every recency-drift point.
      const prev = _leadScoreLastSeen[l.id];
      let trend = '';
      if (typeof prev === 'number') {
        const delta = score - prev;
        if (delta >= 2) trend = '<span class="cpx-c10b981-w700">↑</span>';
        else if (delta <= -2) trend = '<span class="cpx-cef4444-w700">↓</span>';
      }
      // Persist the new value (debounced to localStorage so we don't
      // hammer it on every kanban re-render).
      if (prev !== score) {
        _leadScoreLastSeen[l.id] = score;
        _scheduleLeadScorePersist();
      }
      const reason = b.topReason || '';
      const titleAttr = escHtml(`Lead score ${score}/100 (${b.label}). ${reason}`);
      leadScoreBadge =
        '<span class="kc-tag" title="' + titleAttr + '" ' +
          'style="background:' + color + '22;color:' + color + ';' +
          'border-color:' + color + '88;display:inline-flex;align-items:center;' +
          'gap:3px;font-variant-numeric:tabular-nums;font-weight:700;">' +
          '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + color + ';"></span>' +
          score + (trend ? ' ' + trend : '') +
        '</span>';
    }
  } catch (e) {
    // Engine threw — silently skip the badge so a single bug doesn't
    // bring down the whole kanban render.
    leadScoreBadge = '';
  }

  // ── Wave 28: jobType badge ──
  // Icon-only pill tinted with the type's brand color from JOB_TYPE_META.
  // Lets reps scan Insurance vs Cash vs Finance at a glance without
  // opening the card. Falls back to inferJobType() for older records
  // that predate the explicit field. Silently empty if unknowable.
  let jobTypeBadge = '';
  try {
    const _jt = l.jobType ||
      (typeof window.inferJobType === 'function' ? window.inferJobType(l) : null);
    const _jtm = (window.JOB_TYPE_META && _jt) ? window.JOB_TYPE_META[_jt] : null;
    if (_jtm) {
      const _c = _jtm.color || '#888';
      jobTypeBadge =
        '<span class="kc-tag kct-jobtype" title="' + escHtml(_jtm.label) + '" ' +
          'style="background:color-mix(in srgb,' + _c + ' 18%, var(--s3));color:' + _c + ';' +
          'border-color:color-mix(in srgb,' + _c + ' 50%, var(--br));font-size:10px;padding:2px 6px;">' +
          (_jtm.icon || '?') +
        '</span>';
    }
  } catch (e) { jobTypeBadge = ''; }

  // ── Wave 75: snoozed-card pills ──
  // Only renders when this lead is snoozed AND the W37 show-snoozed
  // toggle is on (otherwise the lead is filtered out at line 267
  // and we never reach this branch). Two separate pills so reps
  // can scan their snoozed kanban for category + indecision pattern
  // at the same time:
  //
  //   - Snooze pill (purple)  → "💤 <date> · <reason>"
  //   - Stale pill  (amber)   → "⚠️ Snoozed 3×"  (only when count ≥ 3)
  //
  // Mirrors the W36 customer-banner pill row + the W71 cmd+K
  // subtitle so the snooze metadata reads identically across all
  // three surfaces.
  let snoozeBadge = '';
  let staleSnoozeBadge = '';
  (function buildSnoozePills() {
    if (!window.LeadSnooze || !window.LeadSnooze.isSnoozed(l)) return;
    const d = window.LeadSnooze.snoozedUntilDate(l);
    if (!d) return;
    const dateLabel = window.LeadSnooze.formatSnoozeLabel(d);
    const reason = (typeof l.snoozedReason === 'string' && l.snoozedReason.trim())
      ? l.snoozedReason.trim()
      : '';
    const reasonTail = reason ? ` · ${reason}` : '';
    snoozeBadge = `<span class="kc-tag cpx-bgcolormix-cpurple-borrgba1551" title="Snoozed until ${escHtml(dateLabel)}${reasonTail ? ' — ' + escHtml(reason) : ''}">💤 ${escHtml(dateLabel)}${escHtml(reasonTail)}</span>`;

    if (typeof window.LeadSnooze.isStaleSnooze === 'function'
        && window.LeadSnooze.isStaleSnooze(l)) {
      const n = l.snoozeCount || 0;
      staleSnoozeBadge = `<span class="kc-tag cpx-bgcolormix-cgold-borrgba2451" title="This lead has been snoozed ${n}+ times — consider a different action.">⚠️ Snoozed ${escHtml(String(n))}×</span>`;
    }
  })();

  // Photo thumbnails (from cache). Click behavior is wired via data-* +
  // delegated event listener in wireKanbanCardListeners(), so attacker-
  // controlled fields like `l.address` can never break out of an onclick
  // attribute. Only http(s) photo URLs are rendered.
  const photos = window._photoCache?.[l.id] || [];
  // Rep-chosen cover (lead.coverPhotoUrl) leads the thumb strip; the rest
  // follow in cache order with the cover deduped out.
  const orderedPhotos = (l.coverPhotoUrl && /^https?:/i.test(String(l.coverPhotoUrl)))
    ? [{ url: l.coverPhotoUrl }, ...photos.filter(p => p.url !== l.coverPhotoUrl)]
    : photos;
  const safePhotos = orderedPhotos.filter(p => /^https?:/i.test(String(p.url || '')));
  const photoHTML = safePhotos.length ? `<div class="kc-photos">
    ${safePhotos.slice(0,3).map(p=>`<img class="kc-photo-thumb nbd-kc-photo" data-lead-id="${escHtml(l.id)}" src="${escHtml(p.url)}" loading="lazy">`).join('')}
    ${safePhotos.length > 3 ? `<div class="kc-photo-more nbd-kc-photo" data-lead-id="${escHtml(l.id)}">+${safePhotos.length-3}</div>` : ''}
  </div>` : '';

  // Roof age
  const roofBadge = (()=>{
    if(!l.yearBuilt) return '';
    const age = new Date().getFullYear() - parseInt(l.yearBuilt);
    const cls = age<10?'kct-roof-new':age<20?'kct-roof-mid':age<30?'kct-roof-old':'kct-roof-ancient';
    return `<span class="kc-tag kct-roof ${cls}"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="cpx-wd11px-hei11px-vermiddle"><path d="M2 10l8-7 8 7"/><path d="M4 9v7a1 1 0 001 1h10a1 1 0 001-1V9"/></svg> ${age}yr</span>`;
  })();

  // R4.3: Phone display normalization. Some leads were imported with
  // raw '5135550147', some hand-typed '513-555-0147', some pasted
  // '(513) 555-0192'. Normalize to one consistent display format —
  // '(xxx) xxx-xxxx' — at render time so the kanban scans cleanly.
  // The href:tel: link still strips to digits independently.
  const _phoneRaw = String(l.phone || '').trim();
  let _phoneFmt = _phoneRaw;
  const _phoneDigits = _phoneRaw.replace(/\D/g, '');
  if (_phoneDigits.length === 10) {
    _phoneFmt = `(${_phoneDigits.slice(0,3)}) ${_phoneDigits.slice(3,6)}-${_phoneDigits.slice(6)}`;
  } else if (_phoneDigits.length === 11 && _phoneDigits.startsWith('1')) {
    _phoneFmt = `(${_phoneDigits.slice(1,4)}) ${_phoneDigits.slice(4,7)}-${_phoneDigits.slice(7)}`;
  }
  const phone = escHtml(_phoneFmt);
  // R5.10: emails are case-insensitive per RFC; user-entered casing
  // ('SomeOwner918@example.com') reads as awkward on the kanban scan.
  // Normalize display to lowercase. mailto: and downstream consumers
  // see the original l.email value via the lead record.
  const email = escHtml(String(l.email||'').toLowerCase());
  // T1.c: normalize carrier. The codebase historically stored under
  // both `insCarrier` and `insuranceCarrier`; some imports wrote
  // "State Farm", others "StateFarm". Collapse whitespace + trim so
  // the kc-carrier pill renders consistently. We do NOT case-normalize
  // because that would mangle acronyms (USAA → Usaa).
  const carrier = escHtml(((l.insCarrier||l.insuranceCarrier||'')+'').replace(/\s+/g,' ').trim());
  const claimNum = escHtml(l.claimNumber||l.claimNum||'');
  // R5.2: humanize raw enum values like 'in_progress' / 'under_review' that
  // some pages (insurance-claim.js, doc-preflight) write to claimStatus.
  // Strip underscores, then title-case each word. CSS still uppercases via
  // text-transform so the chip reads as 'IN PROGRESS' instead of 'IN_PROGRESS'.
  const _humanizeStatus = s => String(s||'').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
  const claimStatus = escHtml(_humanizeStatus(l.claimStatus||''));
  
  // Count badges for estimates and photos
  const estimates = (window._estimates || []).filter(e => e.leadId === l.id);
  const estCount = estimates.length;
  const photoCount = photos.length;

  // Sync status indicators
  const syncClass = l._syncing ? 'k-card-syncing' : (l._syncSuccess ? 'k-card-sync-success' : (l._syncError ? 'k-card-sync-error' : ''));
  const syncIndicator = l._syncing ? '<div class="k-card-sync-icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="cpx-wd11px-hei11px-vermiddle"><path d="M5 2h10v4l-3 3 3 3v4H5v-4l3-3-3-3V2z"/></svg></div>' : 
                        l._syncSuccess ? '<div class="k-card-sync-icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="cpx-wd11px-hei11px-vermiddle"><path d="M4 10.5l4 4 8-9"/></svg></div>' : 
                        l._syncError ? '<div class="k-card-sync-icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="cpx-wd11px-hei11px-vermiddle"><path d="M10 3L2 17h16L10 3z"/><path d="M10 8v4M10 14.5v.5"/></svg></div>' : '';

  // All click behavior is wired by wireKanbanCardListeners() via delegation
  // off the kanban body. Each action is encoded as a data-action attribute
  // and every user-controlled value (id, phone, nameRaw) is escaped via
  // escHtml before interpolation. An attacker-controlled lead field can
  // therefore never break out of an attribute or inject a handler.
  const safeId = escHtml(l.id);
  // A non-active job's card (multi-job stage 2a): its moves must write THAT
  // job, so the job id rides on the card and on the ◀▶ arrows.
  const jobAttr = l._jobId ? ' data-job-id="' + escHtml(l._jobId) + '"' : '';
  const firstName = escHtml(nameRaw.split(' ')[0] || '');
  const showSmsBtn = ['new','contacted','inspected'].includes(_sk) && phone;

  // ── Missing-required-field badge ──
  // Phase 4 polish — surface what's blocking this lead from advancing
  // to its next stage so the rep can fix it without dragging the card
  // and getting bounced by the required-field gate in moveCard. Only
  // shown for non-terminal stages where requiredFieldsFor() actually
  // declares something. Click target is the card itself (opens edit
  // modal), so we don't add another button — just a clear visual.
  // ── Next-best-action hint chip ──
  // Sweep R3 (B): closes the loop on Phase 1's STAGE_ACTIONS map by
  // surfacing the #1 action for this stage + job type on the card face
  // itself, not just inside the Next Actions panel in the lead modal.
  // Reps see "→ File Claim" / "→ Pull Permit" on every
  // card so they can scan the column for what to do, not just where
  // each lead sits.
  //
  // Skipped on terminal stages (closed / lost) and skipped if there's
  // already a 'needs X' warning chip — the rep should fix the missing
  // field before doing the next action.
  let nextActionChip = '';
  if (!isTerminal && typeof window.preferredActionFor === 'function') {
    try {
      const jt = l.jobType || (typeof window.inferJobType === 'function' ? window.inferJobType(l) : null);
      // Skip purely-cosmetic actions like "Log Contact" / "Follow Up"
      // when the stage has a real document or stage-advance action
      // available; reps want to know the *progression* step, not the
      // catch-all log. preferredActionFor (crm-stages.js) prefers
      // kind:'doc' or kind:'stage' first, falls back to the first action
      // otherwise — single source, shared with stage-checklist.js's
      // auto-task generator so the chip and the auto-created task always
      // agree on what "next" means for a given stage.
      const preferred = window.preferredActionFor(l._stageKey || l.stage, jt);
      if (preferred) {
        const icon = preferred.icon || '→';
        const label = preferred.label || preferred.id || '';
        const kindTag = preferred.kind === 'doc' ? 'kct-action-doc'
                      : preferred.kind === 'stage' ? 'kct-action-stage'
                      : 'kct-action';
        // 2026-09-15: was display-only ("clicking the chip is a no-op for
        // now" per the sibling comment on the viewed-badge above it) — the
        // real action list lived only inside the edit modal's Next Actions
        // panel, one of the concrete "driven UX" gaps from the CRM
        // streamlining pass. Now runs the SAME runLeadAction() that panel's
        // buttons call (dashboard-bootstrap.module.js), via a dedicated
        // data-action handled in wireKanbanCardListeners — one dispatcher,
        // two entry points, not a second implementation.
        nextActionChip = `<span class="kc-tag ${kindTag}" data-action="run-next-action" data-id="${safeId}" data-action-id="${escHtml(preferred.id || '')}" data-action-kind="${escHtml(preferred.kind || '')}" role="button" tabindex="0" title="Click to: ${escHtml(label)}">${icon} ${escHtml(label)}</span>`;
      }
    } catch (_) { /* degrade silently */ }
  }

  let needsBadge = '';
  if (!isTerminal && typeof window.missingRequiredFields === 'function') {
    try {
      const missing = window.missingRequiredFields(l) || [];
      if (missing.length > 0) {
        const FIELD_LABELS = {
          jobType:              'Job Type',
          insCarrier:           'Carrier',
          claimNumber:          'Claim #',
          policyNumber:         'Policy #',
          dateOfLoss:           'Date of Loss',
          estimateAmount:       'Estimate $',
          deductibleOrOwedByHO: 'Deductible',
          jobValue:             'Job Value',
          financeCompany:       'Lender',
          loanAmount:           'Loan $',
          scheduledDate:        'Schedule Date',
          // 2026-09-15 (Paperwork Filing)
          contractFiledAt:      'Contract Filed',
          permitFiledAt:        'Permit Filed',
          aobFiledAt:           'AOB filed (retired)',
          warrantyCertFiledAt:  'Warranty Cert Filed',
          cocFiledAt:           'COC Filed'
        };
        const niceList = missing.map(f => FIELD_LABELS[f] || f);
        const head = niceList[0];
        const moreCount = niceList.length - 1;
        const text = moreCount > 0 ? `Needs ${head} +${moreCount}` : `Needs ${head}`;
        const tip = niceList.join(', ');
        needsBadge = `<span class="kc-tag kct-needs" title="To advance this stage, fill: ${escHtml(tip)}">⚠ ${escHtml(text)}</span>`;
      }
    } catch (e) { /* missingRequiredFields can throw on malformed lead — degrade silently */ }
  }

  // 2026-09-15 (Warranty Claim lane): flags a lead carrying an OPEN claim
  // while sitting somewhere other than the Warranty Claim column itself —
  // that column's own header already says "Warranty Claim" for a card
  // there, so a second badge would be redundant. Anywhere else,
  // openWarrantyClaimId with no matching stage is a data-integrity drift
  // (e.g. a bulk-edit or resync bypassing moveCard()'s guard) worth a
  // visible flag rather than a silent dangling pointer.
  const claimBadge = (l.openWarrantyClaimId && l._stageKey !== 'warranty_claim')
    ? `<span class="kc-tag cpx-bgrgba1946-cc2410c-borc2410c" title="This lead has an open warranty claim">🛟 Open Claim</span>`
    : '';

  let html = `<div class="k-card nbd-kc-main ${stageAgingClass}" draggable="true" data-id="${safeId}"${jobAttr} data-action="card-click">
    <div class="k-card-checkbox nbd-kc-stop" data-action="toggle-select" data-id="${safeId}">
      <span class="k-card-checkbox-icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="cpx-wd11px-hei11px-vermiddle"><path d="M4 10.5l4 4 8-9"/></svg></span>
    </div>
    <!-- R6: value gets its own row.
         History: R4 moved value out of the left cluster and into the
         right cluster alongside the est/photo count chips, on the
         theory that money belongs on the right. That looked clean in
         the abstract — but in production the .kc-val-badge has a
         20px-blur orange text-shadow glow that visually bleeds into
         the count badges 4px away, creating the overlap the user
         keeps flagging. Real fix: give the value its own row right-
         aligned, with no horizontal neighbor to collide with. The
         glow now has 12px of empty space to fade into. Plus we
         tightened the glow itself in the CSS rule (8px not 20px). -->
    <div class="cpx-dflex-aicenter-jcspacebet">
      <div class="cpx-dflex-aicenter-gap4px">${jobTypeBadge}${leadScoreBadge}${stageAgeBadge}</div>
      <div class="cpx-dflex-aicenter-gap4px-2">
        ${estCount > 0 ? `<span class="cpx-fs10px-bgs3-bd1pxsolid"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="cpx-wd11px-hei11px-vermiddle"><rect x="4" y="3" width="12" height="14" rx="1.5"/><path d="M7 3V1.5h6V3"/><path d="M7 8h6M7 11h4"/></svg> ${estCount}</span>` : ''}
        ${photoCount > 0 ? `<span class="cpx-fs10px-bgs3-bd1pxsolid-2"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="cpx-wd11px-hei11px-vermiddle"><rect x="2" y="6" width="16" height="11" rx="1.5"/><circle cx="10" cy="11" r="3"/><path d="M7 6l1-3h4l1 3"/></svg> ${photoCount}</span>` : ''}
      </div>
    </div>
    ${val ? `<div class="kc-val-row cpx-taright-mb6px-lh1"><span class="kc-val-badge">${val}</span></div>` : ''}
    <div class="kc-name"${l.customerId ? ` data-customer-id="${escHtml(l.customerId)}" title="${escHtml(l.customerId)}"` : ''}>${name}</div>
    ${addr ? `<div class="kc-addr" title="${escHtml(l.address||'')}">${addr}</div>` : ''}
    ${phone ? `<div class="kc-phone-row">
      <a class="kc-phone-link nbd-kc-stop" href="tel:${phone.replace(/\D/g,'')}"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="cpx-wd11px-hei11px-vermiddle"><path d="M4 3h3l2 4-2.5 1.5A9 9 0 0011.5 13.5L13 11l4 2v3a1 1 0 01-1 1C8.4 17 3 11.6 3 4a1 1 0 011-1z"/></svg> ${phone}</a>
      ${daysLabel ? `<span class="kc-days ${daysClass} cpx-mlauto">${daysLabel}</span>` : ''}
    </div>` : (daysLabel ? `<div class="cpx-taright-mb4px"><span class="kc-days ${daysClass}">${daysLabel}</span></div>` : '')}
    ${email ? `<div class="kc-email-line" title="${email}"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="cpx-wd11px-hei11px-vermiddle"><rect x="2" y="4" width="16" height="12" rx="1.5"/><path d="M2 6l8 5 8-5"/></svg> ${email}</div>` : ''}
    ${carrier || claimStatus !== 'No Claim' ? `<div class="kc-ins-row">
      ${carrier ? `<span class="kc-carrier">${carrier}</span>` : ''}
      ${claimStatus && claimStatus!=='No Claim' ? `<span class="kc-tag kct-claim">${claimStatus}</span>` : ''}
      ${claimNum ? `<span class="kc-claim-num">#${claimNum}</span>` : ''}
    </div>` : ''}
    <!-- T3.c: inline photo thumbnails removed from card face — the
         📷 count chip in the top-right corner is enough at-a-glance.
         Full gallery still accessible via the lead modal + photo tab. -->
    <div class="kc-tags">
      ${(() => {
        const dc = _damageToChip(l.damageType);
        if (!dc) return '';
        return `<span class="kc-tag kct-dmg" title="${escHtml(l.damageType)}">${dc.icon ? dc.icon + ' ' : ''}${escHtml(dc.label)}</span>`;
      })()}
      ${needsBadge ? '' : nextActionChip}
      ${overdue      ? `<span class="kc-tag kct-due"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="cpx-wd11px-hei11px-vermiddle"><path d="M10 3L2 17h16L10 3z"/><path d="M10 8v4M10 14.5v.5"/></svg> Due</span>` : ''}
      ${needsBadge}
      ${claimBadge}
      ${roofBadge}
      ${l.hailHit && l.hailHit.sizeInches ? `<span class="kc-tag kct-dmg cpx-bgrgba2555-cred-borred" title="Recent hail near this property">⛈ ${Number(l.hailHit.sizeInches).toFixed(1)}&quot; hail</span>` : ''}
      ${l.measurementReady ? `<span class="kc-tag cpx-bgrgba4620-cgreen-borgreen" title="Aerial measurement — Joe still confirms on site">📐 ${/^[0-9.]{1,8} sq(?: · [0-9]{1,2}\/[0-9]{1,2})?$/.test(String(l.measurementSummary || '')) ? l.measurementSummary : 'Measurement'}</span>` : ''}
      ${smartFollowupBadge}
      ${lastSharedBadge}
      ${viewedBadge}
      ${engagementBadge}
      ${snoozeBadge}
      ${staleSnoozeBadge}
    </div>
    <div class="kc-footer">
      <button type="button" class="${taskBadgeClass}" data-action="open-tasks" data-id="${safeId}" title="${totalT ? 'View ' + totalT + ' task' + (totalT===1?'':'s') : 'Add a task'}" aria-label="${totalT ? 'View tasks' : 'Add a task'}">${taskBadgeLabel}</button>
      <div class="kc-actions">
        <div class="kc-move">
          ${prevS ? `<button type="button" class="kc-arrow nbd-kc-stop" title="← ${escHtml(prevLabel)}" aria-label="Move to previous stage: ${escHtml(prevLabel)}" data-action="move-card" data-id="${safeId}"${jobAttr} data-target-stage="${escHtml(prevS)}">◀</button>` : '<span class="cpx-wd18px"></span>'}
          ${nextS ? `<button type="button" class="kc-arrow nbd-kc-stop" title="→ ${escHtml(nextLabel)}" aria-label="Move to next stage: ${escHtml(nextLabel)}" data-action="move-card" data-id="${safeId}"${jobAttr} data-target-stage="${escHtml(nextS)}">▶</button>` : '<span class="cpx-wd18px"></span>'}
        </div>
        <!-- T2: action-bar consolidation. The four icon buttons (SMS,
             email, edit, delete) all duplicated functionality already
             reachable via right-click / long-press → kanban context
             menu (View / Edit / Add Task / Call / Copy phone-address /
             Open in Maps / Delete). Replaced with a single ⋮ overflow
             that opens that menu next to the button. Prev/next stage
             arrows kept since drag-substitute is core kanban grammar. -->
        <button type="button" class="kc-btn kc-overflow nbd-kc-stop" title="More actions" aria-label="More actions" data-action="card-overflow" data-id="${safeId}">⋮</button>
      </div>
    </div>
  </div>`;

  // CO-M-1 fix: search highlighting is NO LONGER done here by string-
  // replacing across the serialized card HTML — that injected <mark> into
  // the middle of tags/attributes/styles and leaked raw markup as text
  // (e.g. 'content:space-between;...">', 'data-action="card" data-id="...').
  // Highlighting now runs AFTER the card is parsed into the DOM, walking
  // text nodes only via _highlightCardMatches() (called from renderLeads).
  return html;
}

// CO-M-1: TreeWalker-based search highlighter. Walks only TEXT nodes of
// the freshly-rendered column, so existing tag/attribute/style/badge markup
// is never touched. Wraps each case-insensitive match in a <mark> via DOM
// node splitting (no innerHTML reassignment of any element that holds
// markup). Skips text inside <mark>/<script>/<style> and inside elements
// whose text is structural (svg). Reversible by construction: clearing the
// search sets _searchQuery = null and renderLeads() rebuilds the
// columns from clean buildCard() output, so no un-highlight pass is needed.
function _highlightCardMatches(rootEl){
  const q = _searchQuery;
  if(!rootEl || !q || q.length < 2) return;
  // Case-insensitive literal match — escape regex metachars in the query.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let regex;
  try { regex = new RegExp(escaped, 'gi'); } catch(_){ return; }
  const SKIP_TAGS = { MARK:1, SCRIPT:1, STYLE:1, SVG:1, PATH:1, RECT:1, CIRCLE:1 };
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node){
      if(!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      // Skip text already inside a <mark> or inside non-text containers.
      let p = node.parentNode;
      while(p && p !== rootEl){
        if(p.nodeType === 1 && SKIP_TAGS[p.nodeName]) return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      regex.lastIndex = 0;
      return regex.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  // Collect first (mutating during walk invalidates the walker).
  const targets = [];
  let n;
  while((n = walker.nextNode())) targets.push(n);
  targets.forEach(textNode => {
    const text = textNode.nodeValue;
    regex.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while((m = regex.exec(text))){
      if(m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.style.cssText = 'background:var(--orange);color:var(--accent-fg);padding:0 2px;border-radius:2px;font-weight:600;';
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
      if(m[0].length === 0){ regex.lastIndex++; } // guard against zero-width loops
    }
    if(last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if(frag.childNodes.length) textNode.parentNode.replaceChild(frag, textNode);
  });
}

function handleCardClick(id, event) {
  // If clicking a button/link inside card, don't open modal
  if(event.target.closest('button,a')) return;
  // Open card detail modal (snapshot view with quick actions)
  openLeadDetail(id);
}

// Drag & drop — handlers now attached per-column in renderLeads()
// Global cleanup of drag state
document.addEventListener('dragend', e=>{
  document.querySelectorAll('.kcol-body').forEach(b=>b.classList.remove('drag-over'));
  _dragId = null;
});

// ═══════════════════════════════════════════════════════════
// Lost reason prompt — shown once when a lead is first moved to
// the 'Lost' stage. Captures a reason (optional) so the Rep
// Report Generator's Win/Loss Analysis metric has data to
// pattern-match on. Returns:
//   - string    (user picked a reason or typed a custom one)
//   - null      (user skipped, no reason recorded)
//   - false     (user hit Cancel — caller should abort the move)
// DOM built with createElement so no XSS risk from user notes.
// ═══════════════════════════════════════════════════════════
function promptLostReason(lead) {
  return new Promise((resolve) => {
    const existing = document.getElementById('nbd-lost-reason-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'nbd-lost-reason-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;padding:20px;';

    const sheet = document.createElement('div');
    sheet.style.cssText = 'background:var(--s, #1a1d23);border:1px solid var(--br, #2a2d35);border-radius:12px;padding:28px;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.5);';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'margin-bottom:16px;';
    const hdrTitle = document.createElement('div');
    hdrTitle.style.cssText = "font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:800;color:var(--t);text-transform:uppercase;letter-spacing:.04em;";
    hdrTitle.textContent = 'Why Lost?';
    const hdrSub = document.createElement('div');
    hdrSub.style.cssText = 'font-size:12px;color:var(--m);margin-top:4px;';
    const customerName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.address || 'This customer';
    hdrSub.textContent = customerName + ' — pick a reason to help future reporting (optional)';
    hdr.appendChild(hdrTitle);
    hdr.appendChild(hdrSub);
    sheet.appendChild(hdr);

    const reasons = [
      { key: 'price',              label: 'Price — too expensive' },
      { key: 'timing',             label: 'Timing — not ready yet' },
      { key: 'no_claim',           label: 'No insurance claim approved' },
      { key: 'no_response',        label: 'Ghosted / no response' },
      { key: 'competitor',         label: 'Chose a competitor' },
      { key: 'insurance_denial',   label: 'Insurance denied the claim' },
      { key: 'other',              label: 'Other (type below)' }
    ];
    let selected = null;

    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;';
    reasons.forEach(r => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = r.label;
      btn.style.cssText = 'background:var(--s2);border:1px solid var(--br);color:var(--t);padding:10px 12px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;text-align:left;transition:all .15s;';
      btn.addEventListener('mouseenter', () => { btn.style.borderColor = 'var(--orange)'; });
      btn.addEventListener('mouseleave', () => { if (selected !== r.key) btn.style.borderColor = 'var(--br)'; });
      btn.addEventListener('click', () => {
        selected = r.key;
        grid.querySelectorAll('button').forEach(b => { b.style.borderColor = 'var(--br)'; b.style.background = 'var(--s2)'; });
        btn.style.borderColor = 'var(--orange)';
        btn.style.background = 'rgba(189,87,40,.08)';
        if (r.key === 'other') customInput.focus();
      });
      grid.appendChild(btn);
    });
    sheet.appendChild(grid);

    const customLabel = document.createElement('label');
    customLabel.style.cssText = 'display:block;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--m);margin-bottom:6px;';
    customLabel.textContent = 'Or type a custom reason';
    const customInput = document.createElement('textarea');
    customInput.rows = 2;
    customInput.placeholder = 'Optional — e.g. adjuster lowballed and customer would not negotiate';
    customInput.style.cssText = 'width:100%;background:var(--s2);border:1px solid var(--br);border-radius:6px;padding:10px 12px;color:var(--t);font-family:inherit;font-size:12px;outline:none;resize:vertical;';
    sheet.appendChild(customLabel);
    sheet.appendChild(customInput);

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:18px;gap:8px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel Move';
    cancelBtn.style.cssText = 'background:none;border:1px solid var(--br);color:var(--m);padding:10px 16px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;';
    cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(false); });

    const right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:8px;';

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.textContent = 'Skip — no reason';
    skipBtn.style.cssText = 'background:var(--s2);border:1px solid var(--br);color:var(--m);padding:10px 16px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;';
    skipBtn.addEventListener('click', () => { overlay.remove(); resolve(null); });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Mark Lost';
    saveBtn.style.cssText = 'background:var(--orange);border:1px solid var(--orange);color:var(--accent-fg);box-shadow:inset 0 0 0 1px var(--accent-ring);padding:10px 18px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;';
    saveBtn.addEventListener('click', () => {
      const custom = customInput.value.trim();
      let reason = null;
      if (custom) {
        // Custom takes precedence over preset if both are present
        reason = custom.substring(0, 300);
      } else if (selected) {
        const r = reasons.find(x => x.key === selected);
        reason = r ? r.label : null;
      }
      overlay.remove();
      resolve(reason);
    });

    right.appendChild(skipBtn);
    right.appendChild(saveBtn);
    footer.appendChild(cancelBtn);
    footer.appendChild(right);
    sheet.appendChild(footer);

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    // Click outside cancels (same as Cancel button)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(false); }
    });
    // Esc cancels
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', escHandler);
        resolve(false);
      }
    };
    document.addEventListener('keydown', escHandler);
  });
}

// ═══════════════════════════════════════════════════════════
// Required-field gate — modal banner + click-to-jump
// When moveCard's gate blocks an advance, we open the lead modal
// AND surface a sticky banner at the top listing exactly which
// fields are missing for the target stage. Clicking a field name
// scrolls + focuses + pulses that input so the rep knows where to
// type. No toast — the banner is right there in the modal we just
// opened, so a duplicate toast just means two things to dismiss.
// ═══════════════════════════════════════════════════════════
const _GATE_FIELD_META = {
  jobType:              { label: 'Job Type',          inputId: 'lJobType' },
  insCarrier:           { label: 'Insurance Carrier', inputId: 'lInsCarrier' },
  claimNumber:          { label: 'Claim Number',      inputId: 'lClaimNumber' },
  policyNumber:         { label: 'Policy Number',     inputId: 'lPolicyNumber' },
  dateOfLoss:           { label: 'Date of Loss',      inputId: 'lDateOfLoss' },
  estimateAmount:       { label: 'Estimate Amount',   inputId: 'lEstimateAmount' },
  deductibleOrOwedByHO: { label: 'Deductible',        inputId: 'lDeductible' },
  jobValue:             { label: 'Job Value',         inputId: 'lJobValue' },
  financeCompany:       { label: 'Finance Company',   inputId: 'lFinanceCompany' },
  loanAmount:           { label: 'Loan Amount',       inputId: 'lLoanAmount' },
  scheduledDate:        { label: 'Scheduled Date',    inputId: 'lScheduledDate' },
  // 2026-09-15 (Paperwork Filing)
  contractFiledAt:      { label: 'Contract Filed',           inputId: 'lContractFiled' },
  permitFiledAt:        { label: 'Permit Filed',             inputId: 'lPermitFiled' },
  aobFiledAt:           { label: 'AOB filed (retired)',      inputId: 'lAobFiled' },
  warrantyCertFiledAt:  { label: 'Warranty Cert Filed',      inputId: 'lWarrantyCertFiled' },
  cocFiledAt:           { label: 'Certificate of Completion Filed', inputId: 'lCocFiled' },
};

function _openLeadModalWithMissingFieldsBanner(lead, targetStage, missingFields) {
  const stageLabel = (window.STAGE_META && window.STAGE_META[targetStage] && window.STAGE_META[targetStage].label) || targetStage;
  const items = (missingFields || []).map(f => _GATE_FIELD_META[f] || { label: f, inputId: null });

  if (typeof window.editLead !== 'function') return;
  try { window.editLead(lead.id); } catch (_) { return; }

  // editLead is sync but lays out the modal across a tick (option
  // groups, smart filter, intel hooks). Defer banner injection + focus
  // until the next frame so the inputs are settled.
  setTimeout(() => {
    const modal = document.getElementById('leadModal');
    if (!modal) return;
    const modalBox = modal.querySelector('.modal');
    if (!modalBox) return;

    const existing = document.getElementById('mFieldGateBanner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'mFieldGateBanner';
    banner.setAttribute('role', 'alert');
    banner.style.cssText = 'background:rgba(234,88,12,.10);border:1px solid var(--orange,#ea580c);border-left:3px solid var(--orange,#ea580c);border-radius:6px;padding:10px 12px;margin:0 0 12px 0;font-size:13px;color:var(--t,#fff);line-height:1.4;';

    const eyebrow = document.createElement('div');
    eyebrow.style.cssText = 'font-weight:700;letter-spacing:.02em;text-transform:uppercase;font-size:11px;color:var(--orange,#ea580c);margin-bottom:4px;';
    eyebrow.textContent = `⚠ Move to "${stageLabel}" blocked — fill these in to advance`;
    banner.appendChild(eyebrow);

    const list = document.createElement('div');
    items.forEach((it, idx) => {
      if (idx > 0) list.appendChild(document.createTextNode(', '));
      if (it.inputId) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = it.label;
        btn.dataset.gateJump = it.inputId;
        btn.style.cssText = 'background:none;border:none;padding:0;color:var(--orange,#ea580c);text-decoration:underline;cursor:pointer;font:inherit;';
        list.appendChild(btn);
      } else {
        list.appendChild(document.createTextNode(it.label));
      }
    });
    banner.appendChild(list);

    const bar = modalBox.querySelector('.m-modal-bar');
    if (bar && bar.nextElementSibling) bar.parentNode.insertBefore(banner, bar.nextElementSibling);
    else modalBox.prepend(banner);

    // Jump to a missing field. When the input is hidden because its
    // parent job-type block (insurance/finance/job) hasn't been
    // unlocked yet, scrolling/focusing it no-ops silently — the rep
    // sees nothing happen. Fall back to focusing the Job Type select
    // so the rep knows the gate is "pick a job type first, then this
    // field appears." (Job Type itself is now included in
    // missingRequiredFields when unset on a stage that needs fields,
    // so this fallback is rare — kept as belt-and-suspenders for the
    // hidden-but-jobType-set case, e.g. finance fields on insurance.)
    const _jumpTo = (inp) => {
      if (!inp) return;
      if (inp.offsetParent === null) {
        const jt = document.getElementById('lJobType');
        if (jt) {
          try { jt.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
          try { jt.focus({ preventScroll: true }); } catch (_) { try { jt.focus(); } catch (__) {} }
          try {
            jt.style.transition = 'box-shadow .25s ease';
            jt.style.boxShadow = '0 0 0 3px rgba(234,88,12,.55)';
            setTimeout(() => { jt.style.boxShadow = ''; }, 1600);
          } catch (_) {}
        }
        return;
      }
      try { inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
      try { inp.focus({ preventScroll: true }); } catch (_) { try { inp.focus(); } catch (__) {} }
      try {
        inp.style.transition = 'box-shadow .25s ease';
        inp.style.boxShadow = '0 0 0 3px rgba(234,88,12,.55)';
        setTimeout(() => { inp.style.boxShadow = ''; }, 1600);
      } catch (_) {}
    };

    banner.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-gate-jump]');
      if (!t) return;
      _jumpTo(document.getElementById(t.dataset.gateJump));
    });

    // Auto-jump to the first missing field so the rep lands on the
    // exact input they need to fill in, not on the modal header.
    const firstId = items.find(i => i.inputId)?.inputId;
    if (firstId) _jumpTo(document.getElementById(firstId));
  }, 30);
}

// Lazily-loaded, cached handle on stage-write.js's shared commitStageChange
// — the single transactional write path also used by progressStage() on
// customer.html (2026-09-15 foundation work). A plain <script> file can't
// use a static `import`, so this is a dynamic import cached after the first
// call; dashboard.html modulepreloads the file so that first call doesn't
// cost a cold fetch on the hottest path in the app (every kanban move).
let _stageWriteModPromise = null;
function _stageWriteMod() {
  if (!_stageWriteModPromise) _stageWriteModPromise = import('./stage-write.js');
  return _stageWriteModPromise;
}

// Move one of a customer's NON-active jobs to newStage. Same gates the lead
// path applies that make sense per job (viewer, same-stage no-op, required
// fields for the destination), written through NBDJobs.update to
// leads/{id}/jobs/{jobId}. → true when the move committed.
async function _moveJobCard(lead, jobId, newStage, isDrag) {
  const J = window.NBDJobs;
  if (window.NBDRole && typeof window.NBDRole.guard === 'function' && !window.NBDRole.guard()) return false;
  const card = (J.cardsFor(lead, J.forLead(lead.id)) || []).find((c) => c._jobId === jobId)
    || Object.assign({}, lead, (J.forLead(lead.id) || []).find((j) => j.id === jobId) || {}, { _jobId: jobId });
  const norm = window.normalizeStage || ((x) => x);
  const fromKey = norm(card.stage || 'new');
  const toKey = norm(newStage);
  if (fromKey === toKey) return false;
  if (typeof window.missingRequiredFields === 'function') {
    const missing = window.missingRequiredFields(Object.assign({}, card, { stage: newStage })) || [];
    if (missing.length) {
      const lbl = (f) => (typeof window.requiredFieldLabel === 'function' ? window.requiredFieldLabel(f) : f);
      if (typeof showToast === 'function') showToast('To move this job, fill in: ' + missing.map(lbl).join(', ') + '.', 'error');
      return false;
    }
  }
  const role = typeof window.stageRole === 'function' ? window.stageRole(toKey) : undefined;
  const now = new Date();
  const patch = { stage: newStage, stageStartedAt: now };
  if (role) patch.stageRole = role;
  if (typeof window.arrayUnion === 'function') {
    patch.stageHistory = window.arrayUnion({ from: card.stage || null, to: newStage, at: now.toISOString(), by: (window._user && window._user.uid) || null, drag: !!isDrag });
  }
  if (role === 'won' && toKey === 'closed') patch.closedAt = now;
  try {
    await J.update(lead, jobId, patch);
    if (typeof showToast === 'function') showToast('Job moved', 'ok');
    renderLeads(window._leads, window._filteredLeads);
    return true;
  } catch (e) {
    console.warn('[moveJobCard] failed', e && e.code, e && e.message);
    if (typeof showToast === 'function') showToast('Could not move that job — try again', 'error');
    return false;
  }
}

async function moveCard(id, newStage, opts){
  // isDrag: true ONLY for the 3 genuine drag-and-drop call sites, where
  // `newStage` is a COLUMN key the card was physically dropped on — several
  // real stages can collapse into that one column (Simple/Service views), so
  // "dropped back on its own column" must NOOP even though it's not an exact
  // stage match. Every OTHER caller (Close-Job / prev-next arrows, the
  // right-click "Move to stage…" submenu, the card-detail stage chip, the
  // list-view dropdown, bulk-move, portal-driven advances) passes a SPECIFIC
  // real stage the user explicitly chose — those must NOT be coerced through
  // the column-collapse comparison, or an explicit distinct-stage change gets
  // silently discarded whenever it happens to land in the same visible
  // column as the lead's current stage (2026-07-18 post-sprint certification:
  // #985 made install_complete…final_payment render in the "Closed" column
  // in Simple/Service views, so "Close Job" — a genuine install_complete →
  // closed transition — was hitting the drag-NOOP guard and no-opping).
  const isDrag = !!(opts && opts.isDrag);
  const lead = (window._leads||[]).find(l=>l.id===id);
  if(!lead) return;
  // Multi-job (stage 2a): a card for one of the customer's OTHER jobs moves
  // that job, never the customer's active job. The active job's card carries
  // no jobId (or the active id) and takes the path below, unchanged.
  if (opts && opts.jobId && opts.jobId !== lead.activeJobId && window.NBDJobs) {
    return _moveJobCard(lead, String(opts.jobId), newStage, isDrag);
  }
  // Prevent concurrent moves on the same card
  if(lead._pending){ if(typeof showToast==='function') showToast('Move in progress...','info'); return; }

  // Team visibility (2026-07): company_admin/manager/viewer now SEE
  // teammates' cards on the shared board, but lead mutation stays
  // owner-only at the rules layer (update requires isOwner). Block the
  // move client-side with a clear message instead of letting the
  // optimistic UI move a card the rules will silently bounce back.
  const _meUid = window._user && window._user.uid;
  const _mcClaims = window._userClaims || {};
  const _myRole = _mcClaims.role || '';
  if (_myRole === 'viewer') {
    // Viewer writes are rules-denied even on leads they own (Audit #3 F-1).
    if (typeof showToast === 'function') showToast('Your role is read-only — ask the lead owner to move it.', 'info');
    return;
  }
  // Manager edit rights (2026-07, Jo's call): same-company staff can move
  // any tenant card — the rules' staff-update clause allows it. Everyone
  // else still gets the teammate block instead of a silent rules bounce.
  const _mcStaff = ['company_admin', 'manager'].includes(_myRole)
    && !!_mcClaims.companyId && lead.companyId === _mcClaims.companyId;
  if (lead.userId && _meUid && lead.userId !== _meUid && _myRole !== 'admin' && !_mcStaff) {
    if (typeof showToast === 'function') showToast("This lead belongs to a teammate — only its owner can move it.", 'info');
    return;
  }

  // ─── Prospect status-change trap ───
  // If the user tries to move a prospect (which shouldn't normally
  // appear on the kanban — they live on the Prospects page now), pop
  // a confirm dialog: "This is a prospect. Promote first?" so we never
  // silently graduate a prospect into the customer pipeline. The
  // exception is moves to 'lost', which we let through so reps can
  // immediately discard a dead prospect without a promote dance.
  if (lead.isProspect && !/^lost$/i.test(String(newStage || ''))) {
    // Prefer the in-app uiConfirm (works in iOS PWA standalone where
    // native confirm() can silently no-op). Fall back to native only
    // if D2D hasn't loaded yet — that's a vanishingly small window.
    let ok;
    if (window.D2D && typeof window.D2D.uiConfirm === 'function') {
      ok = await window.D2D.uiConfirm(
        `This is a prospect that hasn't been promoted yet.\n\nPromote them to a customer and move to "${newStage}"?\n\nClick Cancel to leave them as a prospect.`,
        { okLabel: 'Promote & Move', cancelLabel: 'Cancel' }
      );
    } else {
      // Batch 2 (iOS PWA): standalone-compat.js replaces native confirm()
      // with a toast that ALWAYS returns true in the installed app, so this
      // fallback would silently promote + move the prospect — exactly the
      // "never silently graduate a prospect" guard this block exists to be,
      // and there's no demote path to undo it. nbdConfirm returns a real
      // Promise<boolean> via a modal in PWA mode and falls back to native
      // confirm on desktop.
      const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
      ok = await _ask(`This is a prospect that hasn't been promoted yet.\n\nPromote them to a customer and move to "${newStage}"?\n\nClick Cancel to leave them as a prospect.`);
    }
    if (!ok) {
      if (typeof showToast === 'function') showToast('Move cancelled — still a prospect', 'info');
      return;
    }
    // Promote first; promoteProspect handles the isProspect flip + serverTimestamp.
    try {
      if (typeof window.promoteProspect === 'function') {
        await window.promoteProspect(id);
      } else {
        lead.isProspect = false;
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('Promote failed: ' + e.message, 'error');
      return;
    }
    // Fall through to the normal stage-change path below.
  }

  const oldStage = lead.stage || 'New';
  const oldStageKey = lead._stageKey || oldStage;

  // ─── Lost-reason prompt ───
  // When a lead moves to 'lost' (or 'Lost'), capture an optional
  // reason so the Win/Loss Analysis metric in the Rep Report
  // Generator can show patterns. User can pick a preset, type a
  // custom reason, or skip entirely. Canceling the prompt cancels
  // the move.
  let lostReason = null;
  const isLostMove = /^lost$/i.test(String(newStage || ''));
  if (isLostMove && !lead.lostReason) {
    lostReason = await promptLostReason(lead);
    if (lostReason === false) {
      // User canceled the prompt — do NOT move the card
      if (typeof showToast === 'function') showToast('Move canceled', 'info');
      return;
    }
    // lostReason is either a string or null (skip)
  }

  // ─── Required-field gate ───
  // Runs BEFORE the warranty guard (CRM sweep R14, 2026-09-28): that guard
  // WRITES (files a claim / resolves one) — resolving a claim and then being
  // refused here (Closed needs warranty cert + COC dates) left the lead in
  // Warranty Claim with no open claim behind it. Check first, write after.
  // Block stage advancement when the destination stage has required fields
  // missing on the lead (e.g., can't move to claim_filed without claimNumber).
  // Skip for moves to 'lost' — reps need to dispose of dead leads regardless.
  // The check uses missingRequiredFields against a hypothetical lead at the
  // new stage so we evaluate the destination's requirements, not the current.
  // The helper opens the lead modal with an in-place banner listing what's
  // missing + click-to-jump anchors; see _openLeadModalWithMissingFieldsBanner
  // above for the UX rationale (banner-instead-of-flash-toast).
  if (!isLostMove && typeof window.missingRequiredFields === 'function') {
    const missing = window.missingRequiredFields({ ...lead, stage: newStage });
    if (missing.length > 0) {
      _openLeadModalWithMissingFieldsBanner(lead, newStage, missing);
      return;
    }
  }

  // ─── Warranty-claim guard ───
  // 2026-09-15 (Warranty Claim lane). Two directions, both must run BEFORE
  // the lead.stage write below (same contract as the lost-reason prompt):
  //  1. Moving INTO warranty_claim (the "File Warranty Claim" chip, or a
  //     manual stage-picker/list-view/context-menu move) must gather a
  //     reason + issue description and open the claim doc FIRST — a bare
  //     stage flip with no claim record would leave the board showing "in
  //     claim" with nothing behind it.
  //  2. Moving AWAY from warranty_claim while a claim is still open must be
  //     resolved or denied first — otherwise a rep could drag the card back
  //     to Closed (or anywhere else) and silently orphan an open claim
  //     forever, with lead.openWarrantyClaimId left dangling.
  // Canceling either prompt cancels the whole move, exactly like a canceled
  // lost-reason prompt above.
  const newStageKey = window.normalizeStage ? window.normalizeStage(newStage) : newStage;
  if (!isLostMove && newStageKey === 'warranty_claim' && oldStageKey !== 'warranty_claim') {
    if (!(window.WarrantyClaim && typeof window.WarrantyClaim.promptIntake === 'function')) {
      if (typeof showToast === 'function') showToast('Warranty claim tool not loaded — reload and try again', 'warning');
      return;
    }
    let opened;
    try {
      opened = await window.WarrantyClaim.promptIntake(lead);
    } catch (e) {
      if (typeof showToast === 'function') showToast('Could not open the claim: ' + e.message, 'error');
      return;
    }
    if (!opened) {
      if (typeof showToast === 'function') showToast('Move canceled', 'info');
      return;
    }
  } else if (oldStageKey === 'warranty_claim' && newStageKey !== 'warranty_claim' && lead.openWarrantyClaimId) {
    if (!(window.WarrantyClaim && typeof window.WarrantyClaim.promptResolution === 'function')) {
      if (typeof showToast === 'function') showToast('Warranty claim tool not loaded — reload and try again', 'warning');
      return;
    }
    let resolved;
    try {
      resolved = await window.WarrantyClaim.promptResolution(lead);
    } catch (e) {
      if (typeof showToast === 'function') showToast('Could not resolve the claim: ' + e.message, 'error');
      return;
    }
    if (!resolved) {
      if (typeof showToast === 'function') showToast('Move canceled — claim still open', 'info');
      return;
    }
  }


  lead._pending = true;

  // ══════════════════════════════════════════════
  // OPTIMISTIC UPDATE — Update UI immediately
  // ══════════════════════════════════════════════
  lead.stage = newStage;
  lead._stageKey = window.normalizeStage ? window.normalizeStage(newStage) : newStage;
  lead._stageRole = window.stageRole ? window.stageRole(newStage) : lead._stageRole;
  if (isLostMove && lostReason) lead.lostReason = lostReason;

  // Mark as syncing (add visual indicator)
  lead._syncing = true;

  // Render immediately with new stage
  renderLeads(window._leads, window._filteredLeads);

  // If the card-detail modal is open on this lead, re-populate its chips
  // so the rep sees the new stage reflected immediately (without this the
  // chip in the header bar stays on the old value until they close + reopen).
  if (typeof window.refreshCardDetailChips === 'function') {
    try { window.refreshCardDetailChips(id); } catch (_) {}
  }

  try {
    // Save to Firebase via the shared commitStageChange() (stage-write.js) —
    // a Firestore transaction that aborts as STAGE_RACE_NOOP/STAGE_RACE_LOST
    // if another tab/session already moved this lead since our `oldStage`
    // snapshot. Also used by customer.html's progressStage() (2026-09-15
    // foundation work) so both write paths share one set of race guards
    // instead of the kanban being the only safe one.
    const { commitStageChange } = await _stageWriteMod();
    const { historyEvent } = await commitStageChange(id, newStage, oldStage, {
      isDrag, isLostMove, lostReason, actorLabel: window._currentUser?.email,
      jobType: lead.jobType || null,
    });

    // Update local state with history
    if(!lead.stageHistory) lead.stageHistory = [];
    lead.stageHistory.push(historyEvent);

    // Mark as synced
    lead._syncing = false;
    lead._syncSuccess = true;
    delete lead._pending;

    // Render once now to reflect the success state. Wave 103: the
    // t+1s "clear success" callback used to call renderLeads again
    // — full re-serialize of every card on every move just to drop
    // a class on one element. Replaced with a targeted DOM update
    // so the success badge fades on its own card without re-render.
    renderLeads(window._leads, window._filteredLeads);
    setTimeout(() => {
      delete lead._syncSuccess;
      try {
        const card = document.querySelector(`.k-card[data-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
        if (card) card.classList.remove('k-card-sync-success');
      } catch (_) { /* fall back to next nbd:data-refreshed cycle */ }
    }, 1000);
    // true ONLY when the move committed. Every refusal above (teammate's
    // lead, prospect not promoted, lost/warranty prompt cancelled, required
    // fields missing) and every failure below returns undefined — bulk move
    // counts on this: it used to count "no throw" as moved and toasted
    // "Moved 2 lead(s)" for two leads the required-field gate had refused.
    return true;

  } catch(e){
    console.error('moveCard error',e);

    // ══════════════════════════════════════════════
    // ROLLBACK — Revert UI if Firebase fails
    // ══════════════════════════════════════════════
    // STAGE_RACE_NOOP: another tab already moved this card to the
    // same stage we wanted. The destination is correct — clear the
    // syncing flag and pull the latest doc so we agree with Firestore.
    if (e && e.message === 'STAGE_RACE_NOOP') {
      lead._syncing = false;
      delete lead._pending;
      try { await loadLeads(); } catch(_) {}
      return true; // already at the destination — the move's outcome holds
    }
    // STAGE_RACE_LOST: another tab moved this card to a DIFFERENT
    // stage. Don't override their move — restore from Firestore so
    // the kanban reflects the actual stored stage.
    if (e && e.message === 'STAGE_RACE_LOST') {
      lead._syncing = false;
      delete lead._pending;
      if (typeof window.showToast === 'function') {
        window.showToast('Another tab moved this card — refreshed.', 'info');
      }
      try { await loadLeads(); } catch(_) {}
      return;
    }

    lead.stage = oldStage;
    lead._stageKey = oldStageKey;
    lead._stageRole = window.stageRole ? window.stageRole(oldStageKey) : lead._stageRole;
    lead._syncing = false;
    lead._syncError = true;
    delete lead._pending;

    renderLeads(window._leads, window._filteredLeads);

    // Show error toast with undo action
    if (typeof window.showToast === 'function') {
      window.showToast({
        message: `Failed to move "${lead.firstName || lead.name || 'lead'}" to ${newStage}. Changes reverted.`,
        type: 'error',
        duration: 5000,
        undoAction: () => {
          // Retry the move — carry the original isDrag flag forward so a
          // retried drag stays column-NOOP-safe and a retried explicit move
          // stays exact-match (see moveCard's opts.isDrag doc comment).
          moveCard(id, newStage, { isDrag });
        },
        undoText: 'Retry'
      });
    }
    
    // Clear error flag
    setTimeout(() => {
      delete lead._syncError;
      renderLeads(window._leads, window._filteredLeads);
    }, 3000);
  }
}

/**
 * Change a lead's classification (jobType) — Insurance / Cash / Finance /
 * Warranty / Service. Mirrors moveCard's optimistic-update + rollback
 * pattern but leaves `stage` alone; resolveColumn() handles cross-track
 * display in the kanban. We log a timeline note so the change is auditable.
 */
async function changeLeadType(id, newType){
  const lead = (window._leads||[]).find(l=>l.id===id);
  if(!lead) return;
  if(lead._pending){ if(typeof showToast==='function') showToast('Change in progress...','info'); return; }

  // Same guard as moveCard (manager edit rights, 2026-07): viewers are
  // read-only; same-company staff can edit any tenant lead; everyone else
  // is blocked from teammate leads instead of a silent rules bounce.
  const _clClaims = window._userClaims || {};
  const _clRole = _clClaims.role || '';
  const _clMe = window._user && window._user.uid;
  const _clStaff = ['company_admin', 'manager'].includes(_clRole)
    && !!_clClaims.companyId && lead.companyId === _clClaims.companyId;
  if (_clRole === 'viewer'
      || (lead.userId && _clMe && lead.userId !== _clMe && _clRole !== 'admin' && !_clStaff)) {
    if (typeof showToast === 'function') showToast(_clRole === 'viewer'
      ? 'Your role is read-only.'
      : "This lead belongs to a teammate — only its owner can change it.", 'info');
    return;
  }

  const oldType = lead.jobType || (typeof window.inferJobType==='function' ? window.inferJobType(lead) : null) || '';
  if(oldType === newType){ return; }

  // Validate against known types so a typo can't write garbage to Firestore.
  const validTypes = Object.keys(window.JOB_TYPE_META || {});
  if(validTypes.length && !validTypes.includes(newType)){
    if(typeof showToast==='function') showToast(`Unknown classification: ${newType}`,'error');
    return;
  }

  lead._pending = true;

  lead.jobType = newType;
  lead._syncing = true;
  renderLeads(window._leads, window._filteredLeads);

  // Mirror moveCard: refresh the open detail modal so the type chip
  // reflects the new classification right away.
  if (typeof window.refreshCardDetailChips === 'function') {
    try { window.refreshCardDetailChips(id); } catch (_) {}
  }

  const oldLabel = (window.JOB_TYPE_META?.[oldType]?.label) || oldType || 'Unset';
  const newLabel = (window.JOB_TYPE_META?.[newType]?.label) || newType;

  try{
    const leadRef = window.doc(window.db, 'leads', id);
    await window.updateDoc(leadRef, {
      jobType: newType,
      updatedAt: window.serverTimestamp()
    });

    // Auto-log activity note for timeline (best-effort, matches moveCard).
    try{
      await window.addDoc(window.collection(window.db, 'notes'), {
        leadId: id,
        userId: window._user?.uid,
        text: `Classification changed: ${oldLabel} → ${newLabel}`,
        type: 'type_change',
        createdAt: window.serverTimestamp(),
        createdBy: window._user?.email || 'system'
      });
    } catch(e){ console.warn('Activity log write failed:', e.message); }

    lead._syncing = false;
    lead._syncSuccess = true;
    delete lead._pending;
    renderLeads(window._leads, window._filteredLeads);
    setTimeout(() => {
      delete lead._syncSuccess;
      try{
        const card = document.querySelector(`.k-card[data-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
        if(card) card.classList.remove('k-card-sync-success');
      } catch(_){}
    }, 1000);

    if(typeof showToast==='function') showToast(`Classification → ${newLabel}`, 'success');
  } catch(e){
    console.error('changeLeadType error', e);
    lead.jobType = oldType || undefined;
    lead._syncing = false;
    lead._syncError = true;
    delete lead._pending;
    renderLeads(window._leads, window._filteredLeads);
    if(typeof window.showToast==='function'){
      window.showToast({
        message: `Failed to change classification to ${newLabel}. Reverted.`,
        type: 'error',
        duration: 5000,
        undoAction: () => { changeLeadType(id, newType); },
        undoText: 'Retry'
      });
    }
    setTimeout(() => {
      delete lead._syncError;
      renderLeads(window._leads, window._filteredLeads);
    }, 3000);
  }
}

function updatePipeline(leads){ renderLeads(leads); }

function tagClass(s){
  // Use new stage system if available
  if (window.normalizeStage) {
    const key = window.normalizeStage(s);
    return `tag-${key.replace(/_/g, '-')}`;
  }
  // Legacy fallback
  return({'New':'tag-new','Inspected':'tag-insp','Estimate Sent':'tag-es',
    'Approved':'tag-appr','In Progress':'tag-prog','Complete':'tag-won','Lost':'tag-lost',
    'New Lead':'tag-new','Contacted':'tag-insp','Negotiating':'tag-appr',
    'Closed Won':'tag-won','Closed Lost':'tag-lost'}[s]||'tag-new');
}

function kanbanFilter(){
  const searchInput = document.getElementById('crmSearch');
  const search = (searchInput?.value||'').toLowerCase().trim();
  const dmg    = (document.getElementById('crmDmgFilter')?.value||'').toLowerCase();
  
  // The search is NOT saved (Jo, 2026-10-02: "it sticks even when I refresh
  // or come back to CRM page"). It used to go to localStorage, which outlives
  // the session, contrary to prefs-sync.js's "session-local" note. It now
  // lives only in the box; a leftover from the old behaviour is dropped.
  try { localStorage.removeItem('nbd_crm_search'); } catch (_) {}
  
  // Show/hide clear button
  const clearBtn = document.getElementById('crmSearchClear');
  if(clearBtn) clearBtn.style.display = search ? 'flex' : 'none';
  
  if(!search && !dmg){ 
    _searchQuery = null;
    const countSpan = document.getElementById('crmSearchCount');
    if(countSpan) countSpan.textContent = '';
    renderLeads(window._leads); 
    return; 
  }
  
  _searchQuery = search;

  // renderLeads writes #crmSearchCount from what it actually renders.
  renderLeads(window._leads, _crmSearchFilter(window._leads));
}

// The pipeline search + damage filter as a pure function of the CURRENT
// inputs. Returns null when neither is set (no narrowing).
//
// renderLeads re-applies this itself whenever a caller passes no subset
// (2026-09-30). The search used to live only in the one array kanbanFilter
// handed to renderLeads. Every other re-render — the live leads snapshot,
// the Board/List toggle, a view switch — called renderLeads(leads) bare and
// silently showed the WHOLE book while the box still read the query. Jo's
// live session: "1 match", toggle to List → every lead; back to Board → the
// filter gone.
function _crmSearchFilter(leads) {
  const search = (document.getElementById('crmSearch')?.value||'').toLowerCase().trim();
  const dmg    = (document.getElementById('crmDmgFilter')?.value||'').toLowerCase();
  if (!search && !dmg) return null;
  // Digit-normalized phone matching: "(513) 555" must find 5135550100
  // no matter how either side is formatted. 3-digit floor so one digit
  // doesn't match the whole board.
  const searchDigits = search.replace(/\D/g, '');

  // Filter with email + notes included
  return (leads||[]).filter(l=>{
    if (!l) return false;
    const searchStr = [
      l.firstName||'', l.lastName||'', l.address||'',
      l.damageType||'', l.phone||'', l.email||'', l.notes||''
    ].join(' ').toLowerCase();

    const phoneDigits = String(l.phoneDigits || l.phone || '').replace(/\D/g, '');
    const matchS = !search || searchStr.includes(search)
      || (searchDigits.length >= 3 && phoneDigits.includes(searchDigits));
    const matchD = !dmg    || (l.damageType||'').toLowerCase()===dmg;
    return matchS && matchD;
  });
}


// Debounced version for keystroke events (250ms delay)
const kanbanFilterDebounced = debounce(kanbanFilter, 250, 'kanbanFilter');

function clearCrmSearch(){
  const searchInput = document.getElementById('crmSearch');
  const dmgFilter = document.getElementById('crmDmgFilter');
  if(searchInput) searchInput.value = '';
  if(dmgFilter) dmgFilter.value = '';
  localStorage.removeItem('nbd_crm_search');
  _searchQuery = null;
  kanbanFilter();
}

function wireKanbanCardListeners(container) {
  if (!container || container.__nbdWired) return;
  container.__nbdWired = true;

  const handlers = {
    'card-click':   (el, ev) => typeof handleCardClick === 'function' && handleCardClick(el.dataset.id, ev),
    'toggle-select':(el)     => typeof toggleCardSelection === 'function' && toggleCardSelection(el.dataset.id),
    'open-tasks':   (el, ev) => typeof openTaskModal === 'function' && openTaskModal(el.dataset.id, ev),
    'move-card':    (el)     => typeof moveCard === 'function' && moveCard(el.dataset.id, el.dataset.targetStage, el.dataset.jobId ? { jobId: el.dataset.jobId } : undefined),
    'edit-lead':    (el)     => typeof editLead === 'function' && editLead(el.dataset.id),
    'delete-lead':  (el)     => typeof deleteLead === 'function' && deleteLead(el.dataset.id),
    'booking-sms':  (el)     => typeof sendBookingSMS === 'function' && sendBookingSMS(el.dataset.id, el.dataset.phone, el.dataset.firstName),
    'email-lead':   (el)     => {
      if (typeof emailByStage === 'function') return emailByStage(el.dataset.id);
      if (typeof window.emailByStage === 'function') return window.emailByStage(el.dataset.id);
    },
    'open-photo':   (el)     => typeof openPhotoFor === 'function' && openPhotoFor(el.dataset.leadId, ''),
    // T2: ⋮ overflow opens the existing kanban context menu next to the
    // button. Same set of actions (View / Edit / Add Task / Call / Copy /
    // Maps / Delete) the user gets from right-click and long-press, just
    // accessible via a visible tap target. We pass the button's bounding
    // rect so the menu anchors next to it instead of at (100, 100).
    'card-overflow':(el, ev)  => {
      if (!window.KanbanContextMenu || typeof window.KanbanContextMenu.open !== 'function') return;
      const r = el.getBoundingClientRect();
      const cardEl = el.closest && el.closest('.k-card');
      window.KanbanContextMenu.open(el.dataset.id, r.right, r.bottom, (cardEl && cardEl.dataset.jobId) || undefined);
    },
    // 2026-09-15: the next-best-action chip — was display-only, now runs
    // the SAME runLeadAction() the edit modal's Next Actions panel calls
    // (dashboard-bootstrap.module.js), registered via __NBD_CALL_REGISTRY
    // (the CSP-safe delegated-dispatch allowlist every other cross-module
    // action call in this app already goes through) with the card's own
    // lead id as an explicit 3rd arg — the panel's version infers the lead
    // from the currently-open edit modal, which isn't open here.
    'run-next-action': (el) => {
      const registry = window.__NBD_CALL_REGISTRY;
      if (registry && typeof registry.runLeadAction === 'function') {
        registry.runLeadAction(el.dataset.actionId, el.dataset.actionKind, el.dataset.id);
      }
    },
  };

  container.addEventListener('click', (ev) => {
    // Let <a href="tel:..."> links and elements marked nbd-kc-stop swallow
    // propagation before we dispatch, so they don't open the card behind.
    const stopEl = ev.target.closest('.nbd-kc-stop');
    const actionEl = ev.target.closest('[data-action]');
    if (!actionEl || !container.contains(actionEl)) return;
    const action = actionEl.dataset.action;

    // Every non-card-click action must not bubble up to re-open the card.
    if (action !== 'card-click') ev.stopPropagation();
    if (stopEl && stopEl !== actionEl && action === 'card-click') return;

    const fn = handlers[action];
    if (fn) fn(actionEl, ev);
  });

  // Keyboard activation for the handful of data-action elements that carry
  // role="button" (currently just the next-action chip — a real focusable
  // control on the card face, not just click-only).
  container.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const actionEl = ev.target.closest('[data-action][role="button"]');
    if (!actionEl || !container.contains(actionEl)) return;
    ev.preventDefault();
    actionEl.click();
  });

  // Photo thumbs use a separate class because they don't have a data-action.
  container.addEventListener('click', (ev) => {
    const photo = ev.target.closest('.nbd-kc-photo');
    if (!photo || !container.contains(photo)) return;
    ev.stopPropagation();
    if (typeof openPhotoFor === 'function') openPhotoFor(photo.dataset.leadId, '');
  });
}
