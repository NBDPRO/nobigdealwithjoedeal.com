/**
 * NBD Pro — Prospects Page (Phase 1)
 *
 * Dedicated workspace for D2D knocks that auto-created lead records
 * with isProspect:true and have not yet been promoted to full customers.
 *
 * Phase 1 surface: kanban-by-disposition + list view, stats strip,
 * filter bar, click-to-open existing lead detail. Promotion confirm,
 * 3-step delete, multi-photo, follow-up reminders, and analytics
 * land in subsequent phases.
 *
 * IIFE — exposed as window.Prospects.
 */

(function() {
  'use strict';

  // ── Door-knock source matching ─────────────────────────────────────
  // The same act got written three different ways: d2d-tracker wrote
  // 'Door-to-Door', maps-overlays wrote 'Door Knock', an old import wrote
  // 'door_knock'. An equality test against any ONE of them silently dropped
  // the other two — which is why the conversion rate below read 0% while
  // knocks were demonstrably converting.
  //
  // 'Door Knock' is canonical as of 2026-09-06 and the data has been
  // normalized, but this stays a pattern test on purpose: it costs nothing
  // and it means a stray old spelling from an unmigrated import, a restored
  // backup, or a future integration can never zero this number again.
  function isDoorKnock(src) {
    const s = String(src || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
    return s === 'door knock' || s === 'door to door' || s === 'd2d';
  }

  // ── Disposition taxonomy ───────────────────────────────────────────
  // MUST mirror the DISPOSITIONS map in d2d-tracker.js exactly — keys are
  // what we read off lead.disposition AND substring-match against notes
  // ("D2D Knock #N: <Label>"). Adding a key here without adding it in
  // d2d-tracker has no effect; missing keys here cause those prospects to
  // fall into the 'other' column with broken bucketing. The label strings
  // below match d2d-tracker.js lines 7–24 verbatim.
  // Appointments NEVER show here — they auto-promote to customers.
  const DISPOSITIONS = [
    // Hot — high intent
    { key: 'interested',     label: 'Interested',                bucket: 'hot',  color: '#EAB308' },
    { key: 'storm_damage',   label: 'Storm Damage Noted',        bucket: 'hot',  color: '#BD5728' },
    { key: 'callback',       label: 'Callback Requested',        bucket: 'hot',  color: '#14B8A6' },
    // Warm — insurance pipeline + come-back-later
    { key: 'ins_has_claim',  label: 'Insurance - Has Claim',     bucket: 'warm', color: '#9B6DFF' },
    { key: 'ins_needs_file', label: 'Insurance - Needs Filing',  bucket: 'warm', color: '#D946EF' },
    { key: 'ins_denied',     label: 'Insurance - Denied',        bucket: 'warm', color: '#78350F' },
    { key: 'come_back',      label: 'Come Back — They Asked',    bucket: 'warm', color: '#4A9EFF' },
    { key: 'revisit',        label: 'Revisit — No Answer',       bucket: 'warm', color: '#38BDF8' },
    { key: 'left_material',  label: 'Left Material',             bucket: 'warm', color: '#0EA5E9' },
    // Cold — low intent / unreachable
    { key: 'not_home',       label: 'Not Home',                  bucket: 'cold', color: '#6B7280' },
    { key: 'not_interested', label: 'Not Interested',            bucket: 'cold', color: '#E05252' },
    { key: 'tenant',         label: 'Tenant (Not Owner)',        bucket: 'cold', color: '#94A3B8' },
    { key: 'vacant',         label: 'Vacant Property',           bucket: 'cold', color: '#475569' },
    { key: 'cold_dead',      label: 'Cold / Dead Lead',          bucket: 'cold', color: '#374151' },
    { key: 'do_not_knock',   label: 'Do Not Knock',              bucket: 'cold', color: '#1F2937' },
    { key: 'other',          label: 'Other',                     bucket: 'cold', color: '#6b7280' }
  ];
  const DISP_BY_KEY = Object.fromEntries(DISPOSITIONS.map(d => [d.key, d]));

  const HOT_DISPS  = DISPOSITIONS.filter(d => d.bucket === 'hot' ).map(d => d.key);
  const WARM_DISPS = DISPOSITIONS.filter(d => d.bucket === 'warm').map(d => d.key);
  const COLD_DISPS = DISPOSITIONS.filter(d => d.bucket === 'cold').map(d => d.key);

  // ── Filter state (persisted to localStorage) ───────────────────────
  const STATE_KEY = 'nbd_prospects_state_v1';
  const DEFAULT_STATE = {
    view: 'kanban',           // 'kanban' | 'list'
    bucketFilter: 'all',      // 'all' | 'hot' | 'warm' | 'cold'
    dispositions: [],         // empty = all dispositions
    age: 'all',               // 'all' | 'fresh' | 'warm' | 'cold' | 'ice'
    attempts: 'all',          // 'all' | '1' | '2' | '3'
    rep: 'all',               // 'all' | userId — only meaningful for owners/admins
    followUpDue: false,
    showHidden: false
  };

  function loadState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return { ...DEFAULT_STATE };
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_STATE, ...parsed };
    } catch (e) { return { ...DEFAULT_STATE }; }
  }
  function saveState(s) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch (e) {}
  }
  let state = loadState();

  // ── Source: window._leads (already loaded by crm.js) ───────────────
  function allProspects() {
    const leads = window._leads || [];
    return leads.filter(l => l.isProspect === true);
  }

  // ── Derived helpers ────────────────────────────────────────────────
  function ageInDays(lead) {
    const ts = lead.createdAt?.toDate ? lead.createdAt.toDate()
             : lead.createdAt?._seconds ? new Date(lead.createdAt._seconds * 1000)
             : (lead.createdAt instanceof Date ? lead.createdAt : null);
    if (!ts) return null;
    return Math.floor((Date.now() - ts.getTime()) / (1000 * 60 * 60 * 24));
  }
  function ageBucket(days) {
    if (days == null) return 'all';
    if (days < 7) return 'fresh';
    if (days < 14) return 'warm';
    if (days < 30) return 'cold';
    return 'ice';
  }
  function dispositionKey(lead) {
    // Prefer the structured disposition key (d2d-tracker now persists it on the
    // lead). Then damageType. Then parse the label from the CANONICAL
    // "D2D Knock #N: <Label>" notes PREFIX only — never substring-search the
    // whole notes, which mis-bucketed when a rep's free-text note happened to
    // contain another disposition's label (e.g. "come back later" typed on an
    // Interested knock would re-bucket hot->warm). Falls back to 'other'.
    if (lead.disposition && DISP_BY_KEY[lead.disposition]) return lead.disposition;
    if ((lead.damageType || '').toLowerCase() === 'storm damage') return 'storm_damage';
    const m = (lead.notes || '').match(/D2D Knock(?: #\d+)?:\s*([^\n]+)/i);
    if (m) {
      const labelLine = m[1].trim().toLowerCase();
      const exact = DISPOSITIONS.find(d => d.label.toLowerCase() === labelLine);
      if (exact) return exact.key;
      // Drift-tolerant: longest-label-first match WITHIN the label line only
      // (not the rep's free text), so "Not Interested" still beats "Interested".
      const sorted = [...DISPOSITIONS].sort((a, b) => b.label.length - a.label.length);
      const sub = sorted.find(d => labelLine.includes(d.label.toLowerCase()));
      if (sub) return sub.key;
      // Legacy relabeled dispositions — old "D2D Knock #N: <old label>" notes on
      // pre-structured leads (e.g. come_back was "Come Back Later" before it
      // became "Come Back — They Asked"). Keep them bucketing correctly.
      const LEGACY_LABELS = { 'come back later': 'come_back' };
      if (LEGACY_LABELS[labelLine]) return LEGACY_LABELS[labelLine];
    }
    return 'other';
  }
  function attemptCount(lead) {
    // d2d-tracker writes attempt # into notes as "D2D Knock #N: ..."
    const m = (lead.notes || '').match(/D2D Knock #(\d+)/);
    return m ? parseInt(m[1], 10) : 1;
  }
  function isFollowUpDue(lead) {
    if (!lead.followUp) return false;
    return new Date(lead.followUp + 'T23:59:59') < new Date();
  }

  // ── Filter pipeline ────────────────────────────────────────────────
  function applyFilters(prospects) {
    let list = prospects;

    // Visibility scoping — sales reps see only their own
    const role = window._userClaims?.role;
    if (role === 'sales_rep') {
      list = list.filter(p => p.userId === window._user?.uid);
    }

    // Show hidden toggle
    if (!state.showHidden) {
      list = list.filter(p => !p.prospectHidden);
    }

    // Bucket
    if (state.bucketFilter !== 'all') {
      const set = state.bucketFilter === 'hot' ? HOT_DISPS
                : state.bucketFilter === 'warm' ? WARM_DISPS
                : COLD_DISPS;
      list = list.filter(p => set.includes(dispositionKey(p)));
    }

    // Disposition multi-select
    if (state.dispositions.length) {
      list = list.filter(p => state.dispositions.includes(dispositionKey(p)));
    }

    // Age
    if (state.age !== 'all') {
      list = list.filter(p => ageBucket(ageInDays(p)) === state.age);
    }

    // Attempts
    if (state.attempts !== 'all') {
      const target = state.attempts === '3' ? (n => n >= 3)
                   : (n => n === parseInt(state.attempts, 10));
      list = list.filter(p => target(attemptCount(p)));
    }

    // Rep (owner/admin only)
    if (state.rep !== 'all' && (role === 'admin' || role === 'owner' || !role)) {
      list = list.filter(p => p.userId === state.rep);
    }

    // Follow-up due
    if (state.followUpDue) {
      list = list.filter(isFollowUpDue);
    }

    return list;
  }

  // ── Stats ─────────────────────────────────────────────────────────
  function computeStats(allP) {
    const total = allP.length;
    const hot   = allP.filter(p => HOT_DISPS.includes(dispositionKey(p))).length;
    const warm  = allP.filter(p => WARM_DISPS.includes(dispositionKey(p))).length;
    const cold  = allP.filter(p => COLD_DISPS.includes(dispositionKey(p))).length;

    // Conversion rate = promoted leads / (promoted + still-prospect) over last 90d
    const allLeads = window._leads || [];
    const ninetyAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const recent = allLeads.filter(l => {
      const ts = l.createdAt?.toDate ? l.createdAt.toDate() : null;
      return ts && ts.getTime() > ninetyAgo && isDoorKnock(l.source);
    });
    const promotedCount = recent.filter(l => !l.isProspect).length;
    const convRate = recent.length ? Math.round((promotedCount / recent.length) * 100) : 0;

    return { total, hot, warm, cold, convRate };
  }

  // ── Render: stats strip ────────────────────────────────────────────
  function renderStats(stats) {
    const wrap = document.getElementById('prospects-stats');
    if (!wrap) return;
    const tile = (key, label, value, color) => {
      const active = (key === 'all' && state.bucketFilter === 'all')
                  || (key !== 'all' && state.bucketFilter === key);
      return `
        <button class="prosp-stat ${active ? 'active' : ''}" data-bucket="${key}" type="button" style="
          flex:1; min-width:80px; padding:10px 12px; border-radius:8px;
          background:${active ? `color-mix(in srgb, ${color} 18%, var(--s2))` : 'var(--s2)'};
          border:1px solid ${active ? color : 'var(--br)'};
          cursor:pointer; transition:all .15s; font-family:inherit; text-align:left;
          color:var(--t);
        ">
          <div style="font-size:10px;font-weight:700;color:${color};letter-spacing:.08em;text-transform:uppercase;">${label}</div>
          <div style="font-size:22px;font-weight:800;font-family:'Barlow Condensed',sans-serif;line-height:1;margin-top:4px;">${value}</div>
        </button>
      `;
    };
    wrap.innerHTML = `
      ${tile('all',  'Total',     stats.total, 'var(--orange)')}
      ${tile('hot',  'Hot',       stats.hot,   '#f97316')}
      ${tile('warm', 'Warm',      stats.warm,  '#3b82f6')}
      ${tile('cold', 'Cold',      stats.cold,  '#94a3b8')}
      <div class="prosp-stat" style="
        flex:1; min-width:80px; padding:10px 12px; border-radius:8px;
        background:var(--s2); border:1px solid var(--br);
      ">
        <div style="font-size:10px;font-weight:700;color:var(--green);letter-spacing:.08em;text-transform:uppercase;">Conv. Rate</div>
        <div style="font-size:22px;font-weight:800;font-family:'Barlow Condensed',sans-serif;line-height:1;margin-top:4px;">${stats.convRate}%</div>
        <div style="font-size:9px;color:var(--m);margin-top:2px;">last 90 days</div>
      </div>
    `;
    wrap.querySelectorAll('.prosp-stat[data-bucket]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.bucketFilter = btn.dataset.bucket;
        saveState(state);
        render();
      });
    });
  }

  // ── Render: filter bar ─────────────────────────────────────────────
  function renderFilters() {
    const wrap = document.getElementById('prospects-filters');
    if (!wrap) return;

    const ageOpts = [
      ['all', 'Any age'], ['fresh', 'Fresh <7d'],
      ['warm', '7-14d'], ['cold', '14-30d'], ['ice', '30d+']
    ];
    const attemptOpts = [
      ['all', 'Any attempts'], ['1', '1st knock'],
      ['2', '2nd knock'], ['3', '3+ knocks']
    ];
    const role = window._userClaims?.role;
    const showRepFilter = (role === 'admin' || role === 'owner' || !role);
    const reps = showRepFilter ? collectReps() : [];

    wrap.innerHTML = `
      <div class="prosp-filter-row">
        <select class="prosp-sel" id="pf-age" aria-label="Filter by age">
          ${ageOpts.map(([v,l]) => `<option value="${v}" ${state.age===v?'selected':''}>${l}</option>`).join('')}
        </select>
        <select class="prosp-sel" id="pf-attempts" aria-label="Filter by knock attempts">
          ${attemptOpts.map(([v,l]) => `<option value="${v}" ${state.attempts===v?'selected':''}>${l}</option>`).join('')}
        </select>
        ${showRepFilter ? `
          <select class="prosp-sel" id="pf-rep">
            <option value="all" ${state.rep==='all'?'selected':''}>All reps</option>
            ${reps.map(r => `<option value="${escapeAttr(r.uid)}" ${state.rep===r.uid?'selected':''}>${escapeHtml(r.label)}</option>`).join('')}
          </select>
        ` : ''}
        <label class="prosp-check">
          <input type="checkbox" id="pf-followup" ${state.followUpDue?'checked':''}>
          <span>Follow-up due</span>
        </label>
        <label class="prosp-check">
          <input type="checkbox" id="pf-hidden" ${state.showHidden?'checked':''}>
          <span>Show hidden</span>
        </label>
        <div class="prosp-view-toggle">
          <button type="button" class="${state.view==='kanban'?'active':''}" data-view="kanban">▦ Kanban</button>
          <button type="button" class="${state.view==='list'?'active':''}"   data-view="list">≡ List</button>
        </div>
      </div>
    `;

    wrap.querySelector('#pf-age')?.addEventListener('change', e => { state.age = e.target.value; saveState(state); render(); });
    wrap.querySelector('#pf-attempts')?.addEventListener('change', e => { state.attempts = e.target.value; saveState(state); render(); });
    wrap.querySelector('#pf-rep')?.addEventListener('change', e => { state.rep = e.target.value; saveState(state); render(); });
    wrap.querySelector('#pf-followup')?.addEventListener('change', e => { state.followUpDue = e.target.checked; saveState(state); render(); });
    wrap.querySelector('#pf-hidden')?.addEventListener('change', e => { state.showHidden = e.target.checked; saveState(state); render(); });
    wrap.querySelectorAll('.prosp-view-toggle button').forEach(b => {
      b.addEventListener('click', () => { state.view = b.dataset.view; saveState(state); render(); });
    });
  }

  function collectReps() {
    const seen = new Map();
    (window._leads || []).forEach(l => {
      if (l.userId && !seen.has(l.userId)) {
        seen.set(l.userId, { uid: l.userId, label: l.repName || l.userId.slice(0, 6) });
      }
    });
    return [...seen.values()];
  }

  // ── Render: kanban (columns by disposition) ────────────────────────
  function renderKanban(filtered) {
    const wrap = document.getElementById('prospects-board');
    if (!wrap) return;
    const grouped = {};
    DISPOSITIONS.forEach(d => grouped[d.key] = []);
    filtered.forEach(p => {
      const k = dispositionKey(p);
      (grouped[k] || (grouped[k] = [])).push(p);
    });
    // Show:
    //   - any column that has prospects, OR
    //   - all columns in the active bucket (so a Hot filter shows all hot lanes,
    //     even empty ones, to make routing obvious).
    const inBucket = d => state.bucketFilter === 'all'
      ? false
      : d.bucket === state.bucketFilter;
    const visibleDisps = DISPOSITIONS.filter(d =>
      (grouped[d.key] || []).length > 0 || inBucket(d)
    );
    // If everything is empty (no prospects at all + bucket=all), still show
    // the four most-common columns as placeholders so the page isn't blank.
    const fallback = ['interested','storm_damage','not_home','callback'];
    const finalDisps = visibleDisps.length
      ? visibleDisps
      : DISPOSITIONS.filter(d => fallback.includes(d.key));

    const cols = finalDisps.map(d => {
      const items = grouped[d.key] || [];
      return `
        <div class="prosp-col" style="border-top:3px solid ${d.color};">
          <div class="prosp-col-hdr">
            <span style="color:${d.color};font-weight:800;">${d.label}</span>
            <span class="prosp-col-count">${items.length}</span>
          </div>
          <div class="prosp-col-body">
            ${items.length ? items.map(renderCard).join('') :
              `<div class="prosp-empty">No ${d.label.toLowerCase()} prospects</div>`}
          </div>
        </div>
      `;
    }).join('');

    wrap.innerHTML = `<div class="prosp-board">${cols}</div>`;
    wireCardClicks(wrap);
  }

  // ── Render: list view ──────────────────────────────────────────────
  function renderList(filtered) {
    const wrap = document.getElementById('prospects-board');
    if (!wrap) return;
    const sorted = [...filtered].sort((a, b) => {
      const ad = ageInDays(a) ?? 9999;
      const bd = ageInDays(b) ?? 9999;
      return ad - bd;
    });
    if (!sorted.length) {
      wrap.innerHTML = `<div class="prosp-empty-full">No prospects match these filters.</div>`;
      return;
    }
    wrap.innerHTML = `
      <div class="prosp-list">
        ${sorted.map(renderRow).join('')}
      </div>
    `;
    wireCardClicks(wrap);
  }

  // ── Render: card (kanban) ──────────────────────────────────────────
  function renderCard(p) {
    const disp = DISP_BY_KEY[dispositionKey(p)] || DISP_BY_KEY.other;
    const att = attemptCount(p);
    const days = ageInDays(p);
    // Prefer the pipeline's 200px WebP thumb (photoVariants is
    // index-aligned with photoUrls, copied from the knock at
    // conversion); fall back to the full original for pre-variant leads.
    const photos = (Array.isArray(p.photoUrls) ? p.photoUrls.slice(0, 3) : [])
      .map((url, i) => (Array.isArray(p.photoVariants) && p.photoVariants[i] && p.photoVariants[i].thumb) || url);
    const fuDue = isFollowUpDue(p);
    return `
      <div class="prosp-card" data-lead-id="${escapeAttr(p.id)}">
        <div class="prosp-card-hdr">
          <div class="prosp-addr">${escapeHtml(p.address || '(no address)')}</div>
          <div class="prosp-attempt" title="Knock attempt #${att}">#${att}</div>
        </div>
        ${(p.firstName || p.lastName) ? `<div class="prosp-name">${escapeHtml((p.firstName||'') + ' ' + (p.lastName||'')).trim()}</div>` : ''}
        <div class="prosp-meta">
          <span class="prosp-disp" style="background:color-mix(in srgb, ${disp.color} 18%, transparent);color:${disp.color};">${disp.label}</span>
          ${days != null ? `<span class="prosp-age">${days === 0 ? 'today' : days + 'd ago'}</span>` : ''}
          ${fuDue ? `<span class="prosp-fu-due" title="Follow-up overdue">⏰ Due</span>` : ''}
        </div>
        ${photos.length ? `
          <div class="prosp-photos">
            ${photos.map(url => `<img src="${escapeAttr(url)}" alt="" class="prosp-photo-thumb">`).join('')}
            ${(p.photoUrls?.length || 0) > 3 ? `<span class="prosp-photo-more">+${p.photoUrls.length - 3}</span>` : ''}
          </div>
        ` : ''}
      </div>
    `;
  }

  // ── Render: row (list) ─────────────────────────────────────────────
  function renderRow(p) {
    const disp = DISP_BY_KEY[dispositionKey(p)] || DISP_BY_KEY.other;
    const att = attemptCount(p);
    const days = ageInDays(p);
    const fuDue = isFollowUpDue(p);
    return `
      <div class="prosp-row" data-lead-id="${escapeAttr(p.id)}">
        <div class="prosp-row-main">
          <div class="prosp-addr">${escapeHtml(p.address || '(no address)')}</div>
          <div class="prosp-row-sub">
            <span class="prosp-disp" style="background:color-mix(in srgb, ${disp.color} 18%, transparent);color:${disp.color};">${disp.label}</span>
            <span class="prosp-attempt-inline">Knock #${att}</span>
            ${days != null ? `<span class="prosp-age">${days === 0 ? 'today' : days + 'd'}</span>` : ''}
            ${fuDue ? `<span class="prosp-fu-due">⏰ Follow-up due</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  // ── Card / row click → opens lead detail (with prospect actions) ──
  function wireCardClicks(scope) {
    scope.querySelectorAll('[data-lead-id]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.leadId;
        if (typeof window.openCardDetailModal === 'function') {
          window.openCardDetailModal(id);
        } else if (typeof window.showToast === 'function') {
          window.showToast('Lead detail not loaded yet — try again', 'error');
        }
      });
    });
  }

  // ── Conversion analytics ───────────────────────────────────────────
  // Tracks promotion patterns over the last 90 days. Helps the rep
  // understand which dispositions / attempt counts / age buckets actually
  // produce real customers vs. dead-end prospects.
  function computeAnalytics() {
    const allLeads = window._leads || [];
    const ninetyAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const d2dRecent = allLeads.filter(l => {
      const ts = l.createdAt?.toDate ? l.createdAt.toDate() : null;
      return ts && ts.getTime() > ninetyAgo && isDoorKnock(l.source);
    });
    const promoted = d2dRecent.filter(l => !l.isProspect);
    const stillProspect = d2dRecent.filter(l => l.isProspect === true);

    // By disposition
    const byDisposition = {};
    DISPOSITIONS.forEach(d => byDisposition[d.key] = { promoted: 0, total: 0, label: d.label, color: d.color });
    d2dRecent.forEach(l => {
      const k = dispositionKey(l);
      if (!byDisposition[k]) byDisposition[k] = { promoted: 0, total: 0, label: k, color: '#888' };
      byDisposition[k].total++;
      if (!l.isProspect) byDisposition[k].promoted++;
    });
    const dispositionRows = Object.entries(byDisposition)
      .filter(([, v]) => v.total > 0)
      .sort((a, b) => b[1].total - a[1].total);

    // By attempt count
    const byAttempt = { 1: { promoted: 0, total: 0 }, 2: { promoted: 0, total: 0 }, 3: { promoted: 0, total: 0 } };
    d2dRecent.forEach(l => {
      const a = Math.min(attemptCount(l), 3);
      byAttempt[a].total++;
      if (!l.isProspect) byAttempt[a].promoted++;
    });

    return {
      total: d2dRecent.length,
      promoted: promoted.length,
      stillProspect: stillProspect.length,
      dispositionRows,
      byAttempt
    };
  }

  function renderAnalytics() {
    const wrap = document.getElementById('prospects-analytics');
    if (!wrap) return;
    const a = computeAnalytics();
    if (!a.total) {
      wrap.innerHTML = '';
      return;
    }
    const rate = (n, d) => d ? Math.round((n / d) * 100) : 0;
    const overallRate = rate(a.promoted, a.total);

    const dispRows = a.dispositionRows.slice(0, 6).map(([key, v]) => {
      const r = rate(v.promoted, v.total);
      return `
        <div class="prosp-an-row">
          <span class="prosp-an-row-label" style="color:${v.color};">${v.label}</span>
          <div class="prosp-an-bar"><div class="prosp-an-bar-fill" style="width:${r}%;background:${v.color};"></div></div>
          <span class="prosp-an-row-pct">${r}%</span>
          <span class="prosp-an-row-count">${v.promoted}/${v.total}</span>
        </div>
      `;
    }).join('');

    const attRows = [1,2,3].map(n => {
      const v = a.byAttempt[n];
      const r = rate(v.promoted, v.total);
      const label = n === 3 ? '3+ knocks' : (n === 1 ? '1st knock' : '2nd knock');
      return `
        <div class="prosp-an-row">
          <span class="prosp-an-row-label">${label}</span>
          <div class="prosp-an-bar"><div class="prosp-an-bar-fill" style="width:${r}%;background:var(--orange);"></div></div>
          <span class="prosp-an-row-pct">${r}%</span>
          <span class="prosp-an-row-count">${v.promoted}/${v.total}</span>
        </div>
      `;
    }).join('');

    wrap.innerHTML = `
      <details class="prosp-analytics" ${a.total >= 5 ? 'open' : ''}>
        <summary>📊 Conversion Analytics — last 90 days
          <span style="margin-left:8px;color:var(--green);font-weight:800;">${overallRate}%</span>
          <span style="font-size:10px;color:var(--m);margin-left:6px;">(${a.promoted}/${a.total} promoted)</span>
        </summary>
        <div class="prosp-an-grid">
          <div class="prosp-an-block">
            <div class="prosp-an-title">By disposition</div>
            ${dispRows || '<div class="prosp-an-empty">No data yet</div>'}
          </div>
          <div class="prosp-an-block">
            <div class="prosp-an-title">By knock attempt</div>
            ${attRows}
          </div>
        </div>
      </details>
    `;
  }

  // ── Stale-prospect cleanup banner ──────────────────────────────────
  // Surfaces a one-time-per-session suggestion when prospects older than
  // 60 days exist. User can accept (filter the view to ice-cold prospects)
  // or dismiss for the session. Never auto-archives — only suggests.
  const STALE_DISMISS_KEY = 'nbd_prospects_stale_dismissed_v1';
  function staleCount() {
    return allProspects().filter(p => {
      const days = ageInDays(p);
      return days != null && days >= 60 && !p.prospectHidden;
    }).length;
  }
  function isStaleDismissedThisSession() {
    try {
      const dismissed = sessionStorage.getItem(STALE_DISMISS_KEY);
      return dismissed === '1';
    } catch (e) { return false; }
  }
  function dismissStale() {
    try { sessionStorage.setItem(STALE_DISMISS_KEY, '1'); } catch (e) {}
    renderStaleBanner();
  }
  function reviewStale() {
    state.age = 'ice';
    saveState(state);
    dismissStale();
    render();
    if (typeof window.showToast === 'function') {
      window.showToast('Filtered to 30d+ prospects — Hide or Delete the dead ones', 'info');
    }
  }
  function renderStaleBanner() {
    const wrap = document.getElementById('prospects-stale-banner');
    if (!wrap) return;
    if (isStaleDismissedThisSession()) { wrap.innerHTML = ''; return; }
    const n = staleCount();
    if (n < 1) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `
      <div class="prosp-stale">
        <span class="prosp-stale-icon">🧹</span>
        <span class="prosp-stale-text">
          You have <b>${n}</b> prospect${n===1?'':'s'} older than 60 days. Want to review and archive the dead ones?
        </span>
        <div class="prosp-stale-actions">
          <button type="button" class="prosp-stale-btn primary" data-pr-action="reviewStale">Review</button>
          <button type="button" class="prosp-stale-btn" data-pr-action="dismissStale">Not now</button>
        </div>
      </div>
    `;
  }

  // ── Top-level render orchestrator ──────────────────────────────────
  function render() {
    const all = allProspects();
    const filtered = applyFilters(all);
    renderStats(computeStats(all));
    renderFilters();
    renderStaleBanner();
    if (state.view === 'kanban') renderKanban(filtered);
    else renderList(filtered);
    renderAnalytics();
    updateNavBadge(all.length);
  }

  function updateNavBadge(count) {
    const badge = document.getElementById('prospectsNavBadge');
    if (!badge) return;
    // Show count of OVERDUE follow-ups when any exist; otherwise show
    // total prospects (so the rep always sees a meaningful number).
    // Overdue badge gets a red tint to mark urgency.
    const overdue = allProspects().filter(isFollowUpDue).length;
    if (overdue > 0) {
      badge.textContent = overdue;
      badge.style.display = 'inline-block';
      badge.style.background = 'var(--red)';
      badge.title = overdue + ' prospect follow-up' + (overdue === 1 ? '' : 's') + ' overdue';
    } else if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-block';
      badge.style.background = '';
      badge.title = count + ' prospect' + (count === 1 ? '' : 's');
    } else {
      badge.style.display = 'none';
    }
  }

  // ── Tiny escapers ──────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ── Public API ─────────────────────────────────────────────────────
  const Prospects = {
    init() {
      // Re-render whenever leads change. crm.js dispatches 'leadsChanged'
      // after every save/load, so we hook there. Falls back to polling.
      document.addEventListener('leadsChanged', render);
      // First render after leads are loaded
      if ((window._leads || []).length) render();
      else {
        const t = setInterval(() => {
          if ((window._leads || []).length) { clearInterval(t); render(); }
        }, 200);
        setTimeout(() => clearInterval(t), 8000);
      }
    },
    render,
    refresh: render,
    state() { return { ...state }; },
    setBucket(b) { state.bucketFilter = b; saveState(state); render(); },
    reviewStale,
    dismissStale,
  };

  window.Prospects = Prospects;
})();


(function(){if(window._NBD_PR_DELEGATE)return;window._NBD_PR_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-pr-action]');if(!t)return;var a=t.dataset.prAction;var P=window.Prospects;if(P&&typeof P[a]==='function'){try{P[a]();}catch(e){console.error('[prospects]',e);}}});})();
