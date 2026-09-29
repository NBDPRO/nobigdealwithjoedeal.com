// ============================================================
// NBD Pro — smart-calendar.js
// Today's Schedule view inside view-schedule. Pulls appointments
// from /appointments (Cal.com webhook output) for the current rep,
// cross-references with window._leads to attach jobValue + lat/lng,
// then renders a vertical timeline with travel-time warnings,
// priority badges, and a daily route summary.
//
// Drop-in replacement for the placeholder #calUpcoming panel.
// ============================================================

let _NBD_SC_DELEGATE; // module-local (globals Tranche 1 — was window.*)
(function () {
  'use strict';

  // ── tunables ────────────────────────────────────────────────
  // Roofing reps average ~35 mph including stops + traffic in mixed
  // city/suburban driving. This is intentionally conservative: better
  // to warn early than have a rep show up 10 minutes late.
  const AVG_SPEED_MPH = 35;
  // Below this gap-vs-travel-time delta (minutes), flag as tight.
  const TIGHT_BUFFER_MIN = 10;
  // High-value threshold for the $$ badge (jobValue + estimateAmount).
  const HIGH_VALUE = 10000;
  const MED_VALUE = 3000;

  // ── public entry ────────────────────────────────────────────
  async function loadSmartCalendar() {
    const host = document.getElementById('calUpcoming');
    if (!host) return; // panel not in DOM (legacy page or rare standalone)
    const user = window._user;
    if (!user) {
      host.innerHTML = _emptyState('Sign in to see your schedule.');
      return;
    }
    if (!window._db || !window.collection || !window.query || !window.where || !window.getDocs || !window.orderBy) {
      // Firebase not ready — bail without spamming the user. Caller can
      // re-invoke after the auth state settles.
      return;
    }
    _renderLoading(host);

    let appts = [];
    try {
      appts = await _fetchTodaysAppointments(user.uid);
    } catch (e) {
      console.warn('[smart-cal] fetch failed:', e?.message || e);
      host.innerHTML = _emptyState('Could not load appointments. Check your connection.');
      return;
    }

    // Cross-reference leads (prefer the appointment's stamped leadId, else
    // best-effort attendee email/name match) AND surface today's MANUALLY scheduled
    // jobs: a rep-typed Scheduled Date is a flat date-only string on the lead
    // (lead.scheduledDate) that never reaches the appointments collection, so it
    // showed on NO calendar. List those as their own "no set time" block,
    // deduped against any cal.com appointment already shown.
    const leads = Array.isArray(window._leads) ? window._leads : [];
    // Customer-page "Add Event" entries (leads/{id}/tasks, type:'event') for
    // today join the timeline as timed entries (Jo, 2026-09-28: "events on
    // schedule yes") — before, they showed only on that customer's timeline.
    appts = appts.concat(_todaysEvents(user.uid, leads));
    if (appts.length) {
      // Sort by start time so travel-time math is meaningful.
      appts.sort((a, b) => _toMs(a.startTime) - _toMs(b.startTime));
      appts = appts.map(a => _attachLead(a, leads));
    }
    const _t = new Date();
    const todayStr = `${_t.getFullYear()}-${String(_t.getMonth() + 1).padStart(2, '0')}-${String(_t.getDate()).padStart(2, '0')}`;
    const apptLeadIds = new Set(appts.map(a => a._leadId).filter(Boolean));
    const manualToday = leads.filter(l => l && l.scheduledDate === todayStr && !apptLeadIds.has(l.id));

    if (!appts.length && !manualToday.length) {
      host.innerHTML = _emptyState('No appointments today. Time to knock some doors. 🚪');
      return;
    }

    let html = '';
    if (appts.length) {
      const segments = _computeSegments(appts);
      const summary = _summarize(appts, segments);
      html += _renderTimeline(appts, segments, summary);
    }
    if (manualToday.length) html += _renderManualScheduled(manualToday);
    host.innerHTML = html;

    // Rain-day chips land after the first paint — the schedule must never
    // wait on weather.gov, and a forecast failure is a missing chip, nothing
    // more.
    _attachForecasts(host, appts, manualToday).catch((e) => {
      console.warn('[smart-cal] forecast attach failed:', e?.message || e);
    });
  }

  // ── data fetch ──────────────────────────────────────────────
  async function _fetchTodaysAppointments(uid) {
    const db = window._db;
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay   = new Date(); endOfDay.setHours(23, 59, 59, 999);

    // Query by repUid first (matches Cal.com webhook write shape; see
    // functions/integrations/calcom.js). Falls back to userId for
    // legacy/manual appointment docs.
    const apptsCol = window.collection(db, 'appointments');

    const results = [];
    const seen = new Set();

    // ── primary: repUid scope ──
    try {
      const q1 = window.query(
        apptsCol,
        window.where('repUid', '==', uid),
        window.where('startTime', '>=', startOfDay),
        window.where('startTime', '<=', endOfDay),
        window.orderBy('startTime', 'asc')
      );
      const snap1 = await window.getDocs(q1);
      snap1.forEach(d => { if (!seen.has(d.id)) { seen.add(d.id); results.push({ id: d.id, ...d.data() }); } });
    } catch (e) {
      // Composite-index errors come back when the index isn't deployed
      // — log and keep going so the userId fallback still runs.
      console.warn('[smart-cal] repUid query failed:', e?.code || e?.message);
    }

    // ── fallback: userId scope (older docs) ──
    try {
      const q2 = window.query(
        apptsCol,
        window.where('userId', '==', uid),
        window.where('startTime', '>=', startOfDay),
        window.where('startTime', '<=', endOfDay),
        window.orderBy('startTime', 'asc')
      );
      const snap2 = await window.getDocs(q2);
      snap2.forEach(d => { if (!seen.has(d.id)) { seen.add(d.id); results.push({ id: d.id, ...d.data() }); } });
    } catch (e) {
      console.warn('[smart-cal] userId fallback failed:', e?.code || e?.message);
    }

    // Filter out cancelled appointments so the timeline doesn't show
    // ghost events. Webhook keeps them in /appointments for audit.
    return results.filter(a => a.status !== 'cancelled');
  }

  function _toMs(t) {
    if (!t) return 0;
    if (typeof t === 'number') return t;
    if (typeof t === 'string') return new Date(t).getTime();
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    return 0;
  }

  // Today's Add-Event entries from the dashboard's task cache (tasks.js
  // loadAllTasks fills window._taskCache for every lead on the board), shaped
  // like an appointment so the timeline, travel math and lead chip all apply.
  // Mine only — the viewer created it, or it sits on the viewer's own lead —
  // matching how appointments are rep-scoped. Zero duration (the form records
  // a start time only), so an event never manufactures a "conflict". Pure;
  // exported for tests.
  function _todaysEvents(uid, leads, now, taskCache) {
    const cache = taskCache || window._taskCache || {};
    const d = now ? new Date(now) : new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const end = start + 86400000;
    const byId = {};
    (leads || []).forEach(l => { if (l && l.id) byId[l.id] = l; });
    const out = [];
    Object.keys(cache).forEach(leadId => {
      const lead = byId[leadId];
      (cache[leadId] || []).forEach(t => {
        if (!t || t.type !== 'event' || t.done || !t.eventAt) return;
        const at = new Date(t.eventAt).getTime();
        if (!(at >= start && at < end)) return;
        const mine = (uid && t.userId === uid) || (lead && uid && lead.userId === uid);
        if (!mine) return;
        out.push({
          id: 'event:' + leadId + ':' + (t.id || at),
          title: '📅 ' + (t.title || t.text || 'Event'),
          startTime: at, // ms — _toMs reads numbers, not Date objects
          endTime: at,
          leadId: leadId,
          notes: t.notes || '',
          status: 'event',
          _isEvent: true,
        });
      });
    });
    return out;
  }

  // ── lead matching ───────────────────────────────────────────
  function _attachLead(appt, leads) {
    if (!leads.length) return appt;
    let match = null;

    // M-1 (PR #745): the cal.com webhook now stamps an authoritative `leadId`
    // on the appointment. Prefer it — the fuzzy email/name fallback below can
    // mis-link when two leads share a name or a shared/blank inbox email.
    if (appt.leadId) {
      match = leads.find(l => l.id === appt.leadId) || null;
    }
    if (!match) {
      const email = (appt.attendeeEmail || '').toLowerCase().trim();
      const name = (appt.attendeeName || '').toLowerCase().trim();
      if (email) {
        match = leads.find(l => (l.email || '').toLowerCase().trim() === email);
      }
      if (!match && name) {
        match = leads.find(l => {
          const full = `${l.firstName || ''} ${l.lastName || ''}`.toLowerCase().trim();
          return full && full === name;
        });
      }
    }
    if (!match) return appt;

    return {
      ...appt,
      _leadId: match.id,
      _leadValue: (parseFloat(match.jobValue) || 0) + (parseFloat(match.estimateAmount) || 0),
      _leadStage: match.stage || '',
      _leadLat: match.lat || null,
      _leadLng: match.lng || null,
      _leadAddress: match.address || ''
    };
  }

  // ── travel-time + conflict computation ──────────────────────
  function _computeSegments(appts) {
    const out = [];
    for (let i = 0; i < appts.length - 1; i++) {
      const a = appts[i];
      const b = appts[i + 1];
      const gapMin = (_toMs(b.startTime) - _toMs(a.endTime)) / 60000;
      const segment = { gapMin, miles: null, driveMin: null, status: 'ok' };

      // Conflict: B starts before A ends.
      if (gapMin < 0) {
        segment.status = 'conflict';
      } else if (a._leadLat && a._leadLng && b._leadLat && b._leadLng) {
        // hav() returns feet; convert to miles for human-readable display.
        // The function is exposed via maps.js (window.hav).
        if (typeof window.hav === 'function') {
          const feet = window.hav(
            { lat: a._leadLat, lng: a._leadLng },
            { lat: b._leadLat, lng: b._leadLng }
          );
          segment.miles = feet / 5280;
          segment.driveMin = (segment.miles / AVG_SPEED_MPH) * 60;

          if (gapMin < segment.driveMin) segment.status = 'too-tight';
          else if (gapMin - segment.driveMin < TIGHT_BUFFER_MIN) segment.status = 'tight';
        }
      }
      out.push(segment);
    }
    return out;
  }

  function _summarize(appts, segments) {
    const total = appts.length;
    const totalMiles = segments.reduce((s, x) => s + (x.miles || 0), 0);
    const totalDriveMin = segments.reduce((s, x) => s + (x.driveMin || 0), 0);
    const conflicts = segments.filter(s => s.status === 'conflict').length;
    const tooTight  = segments.filter(s => s.status === 'too-tight').length;
    return { total, totalMiles, totalDriveMin, conflicts, tooTight };
  }

  // ── rendering ───────────────────────────────────────────────
  function _renderLoading(host) {
    host.innerHTML = `
      <div style="text-align:center;padding:20px;color:var(--m);font-size:12px;">
        <div style="font-size:18px;margin-bottom:6px;">⏳</div>
        Loading today's schedule…
      </div>`;
  }

  function _emptyState(msg) {
    return `
      <div style="text-align:center;padding:24px 16px;color:var(--m);font-size:13px;">
        <div style="font-size:28px;margin-bottom:8px;">📋</div>
        ${_esc(msg)}
      </div>`;
  }

  // Today's MANUALLY scheduled jobs (lead.scheduledDate is date-only — no set
  // time — so they're listed as a block rather than placed on the hourly
  // timeline). Reuses the timeline's openCardDetail delegate.
  function _renderManualScheduled(leadsToday) {
    const rows = leadsToday.map(l => {
      const name = _esc(`${l.firstName || ''} ${l.lastName || ''}`.trim() || 'Lead');
      const addr = _esc(l.address || '');
      const open = l.id
        ? `<button data-sc-action="openCardDetail" data-sc-id="${_esc(l.id)}" style="background:none;border:none;color:var(--orange);font-size:11px;cursor:pointer;padding:0;text-decoration:underline;white-space:nowrap;">Open →</button>`
        : '';
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--br);">
        <div style="min-width:0;"><div style="font-size:13px;font-weight:600;color:var(--t);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div>
        ${addr ? `<div style="font-size:11px;color:var(--m);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📍 ${addr}</div>` : ''}<span data-sc-forecast="${_esc(l.id || '')}"></span></div>
        ${open}
      </div>`;
    }).join('');
    return `<div style="margin-top:14px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--m);margin-bottom:2px;">📅 Scheduled today · no set time</div>
      ${rows}
    </div>`;
  }

  function _renderTimeline(appts, segments, summary) {
    const head = _renderSummaryHeader(summary);
    const rows = [];
    for (let i = 0; i < appts.length; i++) {
      rows.push(_renderApptRow(appts[i]));
      if (i < segments.length) rows.push(_renderSegmentRow(segments[i]));
    }
    return head + `<div style="display:flex;flex-direction:column;gap:0;margin-top:14px;">${rows.join('')}</div>`;
  }

  function _renderSummaryHeader(s) {
    const miles = s.totalMiles > 0 ? `${s.totalMiles.toFixed(1)} mi` : '—';
    const drive = s.totalDriveMin > 0 ? _fmtMin(s.totalDriveMin) : '—';
    const warnLine = (s.conflicts + s.tooTight) > 0
      ? `<div style="margin-top:8px;padding:8px 12px;background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.3);border-radius:6px;font-size:11px;color:var(--red);">
           ⚠️ ${s.conflicts ? `${s.conflicts} conflict${s.conflicts>1?'s':''}` : ''}${s.conflicts && s.tooTight ? ' · ' : ''}${s.tooTight ? `${s.tooTight} too tight on travel time` : ''}
         </div>`
      : '';
    return `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:11px;">
        <div style="background:var(--s2);border:1px solid var(--br);border-radius:7px;padding:10px;">
          <div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--m);margin-bottom:4px;">Appts</div>
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:700;color:var(--t);">${s.total}</div>
        </div>
        <div style="background:var(--s2);border:1px solid var(--br);border-radius:7px;padding:10px;">
          <div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--m);margin-bottom:4px;">Miles</div>
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:700;color:var(--t);">${_esc(miles)}</div>
        </div>
        <div style="background:var(--s2);border:1px solid var(--br);border-radius:7px;padding:10px;">
          <div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--m);margin-bottom:4px;">Drive Time</div>
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:700;color:var(--t);">${_esc(drive)}</div>
        </div>
      </div>
      ${warnLine}
      <div data-sc-rain-summary></div>`;
  }

  function _renderApptRow(a) {
    const start = _fmtTime(_toMs(a.startTime));
    // A point-in-time entry (an Add-Event with no end) shows its start only.
    const end = _toMs(a.endTime) > _toMs(a.startTime) ? _fmtTime(_toMs(a.endTime)) : '';
    const title = a.title || a.attendeeName || 'Appointment';
    const where = a.location || a._leadAddress || '';
    const valueBadge = _renderValueBadge(a._leadValue);
    const leadLink = a._leadId
      ? `<button data-sc-action="openCardDetail" data-sc-id="${_esc(a._leadId)}" style="background:none;border:none;color:var(--orange);font-size:11px;cursor:pointer;padding:0;text-decoration:underline;">Open lead →</button>`
      : '';
    return `
      <div style="display:grid;grid-template-columns:88px 1fr auto;gap:10px;align-items:flex-start;padding:10px 12px;background:var(--s2);border:1px solid var(--br);border-radius:7px;">
        <div>
          <div style="font-family:'DM Mono',monospace;font-size:13px;font-weight:700;color:var(--t);">${_esc(start)}</div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--m);">${_esc(end)}</div>
        </div>
        <div style="min-width:0;">
          <div style="font-size:13px;font-weight:600;color:var(--t);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(title)}</div>
          ${where ? `<div style="font-size:11px;color:var(--m);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📍 ${_esc(where)}</div>` : ''}
          <span data-sc-forecast="${_esc(a.id || '')}"></span>
          ${leadLink ? `<div style="margin-top:4px;">${leadLink}</div>` : ''}
        </div>
        <div style="text-align:right;">${valueBadge}</div>
      </div>`;
  }

  function _renderSegmentRow(seg) {
    if (seg.status === 'conflict') {
      return `
        <div style="padding:6px 12px;font-size:11px;color:var(--red);background:rgba(220,38,38,.06);border-left:3px solid var(--red);margin-left:12px;border-radius:0 4px 4px 0;">
          ⚠️ Conflict — appointments overlap
        </div>`;
    }
    const gap = seg.gapMin >= 0 ? _fmtMin(seg.gapMin) : '—';
    const drive = seg.driveMin != null ? _fmtMin(seg.driveMin) : '?';
    const miles = seg.miles != null ? `${seg.miles.toFixed(1)} mi` : '? mi';

    if (seg.status === 'too-tight') {
      return `
        <div style="padding:6px 12px;font-size:11px;color:var(--red);background:rgba(220,38,38,.06);border-left:3px solid var(--red);margin-left:12px;border-radius:0 4px 4px 0;">
          🚗 ${_esc(miles)} · ${_esc(drive)} drive — only ${_esc(gap)} gap. Late risk.
        </div>`;
    }
    if (seg.status === 'tight') {
      return `
        <div style="padding:6px 12px;font-size:11px;color:#D4A017;background:rgba(212,160,23,.06);border-left:3px solid #D4A017;margin-left:12px;border-radius:0 4px 4px 0;">
          🚗 ${_esc(miles)} · ${_esc(drive)} drive · ${_esc(gap)} gap — tight.
        </div>`;
    }
    return `
      <div style="padding:6px 12px;font-size:11px;color:var(--m);margin-left:12px;">
        ${seg.driveMin != null ? `🚗 ${_esc(miles)} · ${_esc(drive)} drive · ${_esc(gap)} gap` : `${_esc(gap)} gap`}
      </div>`;
  }

  function _renderValueBadge(v) {
    if (!v || v <= 0) return '';
    if (v >= HIGH_VALUE) {
      return `<span style="display:inline-block;background:var(--orange);color:var(--t);font-size:10px;font-weight:700;letter-spacing:.06em;padding:3px 7px;border-radius:4px;">$$$</span>`;
    }
    if (v >= MED_VALUE) {
      return `<span style="display:inline-block;background:rgba(189,87,40,.18);color:var(--orange);font-size:10px;font-weight:700;letter-spacing:.06em;padding:3px 7px;border-radius:4px;border:1px solid rgba(189,87,40,.35);">$$</span>`;
    }
    return `<span style="display:inline-block;background:var(--s2);color:var(--m);font-size:10px;font-weight:600;padding:3px 7px;border-radius:4px;border:1px solid var(--br);">$</span>`;
  }

  // ── NWS rain-day chip ───────────────────────────────────────
  // api.weather.gov — free, keyless, no published quota, "free to use for
  // any purpose" (verified 2026-09-02); already in connect-src on both
  // dashboard CSP headers. Two hops per distinct point: /points/{lat},{lng}
  // → properties.forecast → 12-hour periods carrying
  // probabilityOfPrecipitation.value (%), temperature, shortForecast. There
  // is NO wind-gust field in this product, so the chip is rain + temp only.
  // Distinct points are keyed at two decimals (~1 km; the NWS grid is 2.5 km)
  // and cached in sessionStorage for an hour, so a day with six appointments
  // in one suburb costs two requests, not twelve. Browsers drop the
  // User-Agent header silently; it is set for parity with storm-center.js.
  const NWS_BASE = 'https://api.weather.gov';
  const NWS_CACHE_PREFIX = 'nbd_nws_fc:';
  const NWS_CACHE_TTL_MS = 60 * 60 * 1000;
  const NWS_MAX_POINTS = 6;
  const NWS_HEADERS = { 'Accept': 'application/geo+json', 'User-Agent': 'NBDProCRM/1.0 (roofing-crm)' };

  function forecastKey(lat, lng) {
    // null/undefined/'' coerce to 0 via Number() — a lead with no coordinates
    // must mean "no request", not a forecast for 0°,0°.
    if (lat == null || lng == null || lat === '' || lng === '') return null;
    const la = Number(lat), ln = Number(lng);
    if (!isFinite(la) || !isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
    return la.toFixed(2) + ',' + ln.toFixed(2);
  }

  // Thresholds a roofer actually acts on: ≥60 % → plan around it, 30–59 % →
  // watch it, below → dry enough to tear off.
  function popLevel(pop) {
    if (pop == null || !isFinite(Number(pop))) return 'unknown';
    const p = Number(pop);
    if (p >= 60) return 'high';
    if (p >= 30) return 'medium';
    return 'low';
  }

  // The period covering the appointment start; a date-only job (no time)
  // gets today's daytime period; otherwise the first period.
  function pickPeriod(periods, atMs) {
    if (!Array.isArray(periods) || !periods.length) return null;
    const t = Number(atMs);
    if (isFinite(t) && t > 0) {
      const hit = periods.find((p) => Date.parse(p.startTime) <= t && t < Date.parse(p.endTime));
      if (hit) return hit;
    }
    return periods.find((p) => p.isDaytime) || periods[0];
  }

  function normalizePeriod(p) {
    if (!p || typeof p !== 'object') return null;
    const popRaw = p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value;
    const pop = (popRaw == null || !isFinite(Number(popRaw))) ? null : Number(popRaw);
    const temp = isFinite(Number(p.temperature)) ? Number(p.temperature) : null;
    return {
      name: String(p.name || ''),
      startTime: p.startTime || null,
      endTime: p.endTime || null,
      isDaytime: !!p.isDaytime,
      pop,
      temp,
      unit: p.temperatureUnit || 'F',
      shortForecast: String(p.shortForecast || ''),
    };
  }

  // "Slight Chance Rain Showers then Slight Chance Showers And Thunderstorms"
  // → "Slight chance showers" — the chip has ~30 characters.
  function shortenForecast(s) {
    return String(s || '')
      .replace(/\s+then\s+.*$/i, '')
      .replace(/Showers And Thunderstorms/ig, 'T-storms')
      .replace(/Thunderstorms/ig, 'T-storms')
      .replace(/Rain Showers/ig, 'Showers')
      .replace(/Slight Chance/ig, 'Slight chance')
      .replace(/Likely/g, 'likely')
      .trim();
  }

  function renderForecastChip(fc) {
    if (!fc) return '';
    const lvl = popLevel(fc.pop);
    const pct = fc.pop == null ? '—' : Math.round(fc.pop) + '%';
    const icon = lvl === 'high' ? '🌧' : lvl === 'medium' ? '🌦' : lvl === 'low' ? '☀️' : '🌤';
    const color = lvl === 'high' ? 'var(--red)' : lvl === 'medium' ? '#D4A017' : 'var(--m)';
    const bg = lvl === 'high' ? 'rgba(220,38,38,.08)' : lvl === 'medium' ? 'rgba(212,160,23,.08)' : 'var(--s2)';
    const border = (lvl === 'high' || lvl === 'medium') ? color : 'var(--br)';
    const temp = fc.temp != null ? ` · ${fc.temp}°` : '';
    return `<span class="sc-fc sc-fc-${lvl}" title="NWS · ${_esc(fc.name)}: ${_esc(fc.shortForecast)}" style="display:inline-block;margin-top:4px;padding:2px 7px;border-radius:4px;border:1px solid ${border};background:${bg};color:${color};font-size:10px;font-weight:600;white-space:nowrap;">${icon} ${_esc(pct)} rain · ${_esc(shortenForecast(fc.shortForecast))}${_esc(temp)}</span>`;
  }

  // One line under the summary tiles: the wettest stop of the day.
  function renderRainSummary(fc) {
    if (!fc || fc.pop == null) return '';
    const lvl = popLevel(fc.pop);
    const pct = Math.round(fc.pop) + '%';
    const color = lvl === 'high' ? 'var(--red)' : lvl === 'medium' ? '#D4A017' : 'var(--m)';
    const icon = lvl === 'high' ? '🌧' : lvl === 'medium' ? '🌦' : '☀️';
    const lead = lvl === 'high' ? 'Rain likely' : lvl === 'medium' ? 'Rain possible' : 'Dry day';
    const temp = fc.temp != null ? ` · ${fc.temp}°` : '';
    return `<div style="margin-top:8px;font-size:11px;color:${color};">${icon} ${lead} — up to ${_esc(pct)} chance · ${_esc(shortenForecast(fc.shortForecast))}${_esc(temp)} <span style="color:var(--m);">· NWS</span></div>`;
  }

  // periods[] (normalized) for a point key, via sessionStorage when fresh.
  async function fetchForecast(key, deps) {
    const fetchImpl = (deps && deps.fetchImpl) || window.fetch.bind(window);
    const store = (deps && deps.store) || (() => { try { return window.sessionStorage; } catch (_) { return null; } })();
    const now = (deps && typeof deps.now === 'number') ? deps.now : Date.now();
    try {
      const raw = store && store.getItem(NWS_CACHE_PREFIX + key);
      if (raw) {
        const c = JSON.parse(raw);
        if (c && typeof c.t === 'number' && now - c.t < NWS_CACHE_TTL_MS && Array.isArray(c.periods)) return c.periods;
      }
    } catch (_) {}
    const [lat, lng] = key.split(',');
    const p = await fetchImpl(`${NWS_BASE}/points/${lat},${lng}`, { headers: NWS_HEADERS });
    if (!p.ok) throw new Error('NWS points ' + p.status);
    const pj = await p.json();
    const url = pj && pj.properties && pj.properties.forecast;
    // Only follow the hop to weather.gov itself — the CSP would block anything
    // else anyway, but a redirect-shaped payload should fail loudly here.
    if (typeof url !== 'string' || !/^https:\/\/api\.weather\.gov\//.test(url)) throw new Error('NWS: no forecast url');
    const f = await fetchImpl(url, { headers: NWS_HEADERS });
    if (!f.ok) throw new Error('NWS forecast ' + f.status);
    const fj = await f.json();
    const periods = ((fj && fj.properties && fj.properties.periods) || []).map(normalizePeriod).filter(Boolean);
    try { store && store.setItem(NWS_CACHE_PREFIX + key, JSON.stringify({ t: now, periods })); } catch (_) {}
    return periods;
  }

  async function _attachForecasts(host, appts, manualToday) {
    const targets = [];
    for (const a of appts || []) {
      const key = forecastKey(a._leadLat, a._leadLng);
      if (key && a.id) targets.push({ key, atMs: _toMs(a.startTime), id: String(a.id) });
    }
    for (const l of manualToday || []) {
      const key = forecastKey(l.lat, l.lng);
      if (key && l.id) targets.push({ key, atMs: 0, id: String(l.id) });
    }
    if (!targets.length) return;
    const keys = Array.from(new Set(targets.map((t) => t.key))).slice(0, NWS_MAX_POINTS);
    const results = {};
    await Promise.all(keys.map(async (k) => {
      try { results[k] = await fetchForecast(k); }
      catch (e) { console.warn('[smart-cal] NWS forecast failed:', e?.message || e); }
    }));
    const esc = (window.CSS && typeof window.CSS.escape === 'function') ? window.CSS.escape : (s) => s;
    let wettest = null;
    for (const t of targets) {
      const periods = results[t.key];
      if (!periods) continue;
      const fc = pickPeriod(periods, t.atMs);
      if (!fc) continue;
      const slot = host.querySelector(`[data-sc-forecast="${esc(t.id)}"]`);
      if (slot) slot.innerHTML = renderForecastChip(fc);
      if (fc.pop != null && (!wettest || fc.pop > wettest.pop)) wettest = fc;
    }
    const sum = host.querySelector('[data-sc-rain-summary]');
    if (sum && wettest) sum.innerHTML = renderRainSummary(wettest);
  }

  // ── small utils ─────────────────────────────────────────────
  function _fmtTime(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function _fmtMin(m) {
    if (!isFinite(m) || m <= 0) return '0 min';
    if (m < 60) return `${Math.round(m)} min`;
    const h = Math.floor(m / 60);
    const r = Math.round(m - h * 60);
    return r ? `${h}h ${r}m` : `${h}h`;
  }
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── auto-load on schedule view ──────────────────────────────
  // Re-render whenever the rep navigates to the schedule view. Hooks
  // into the goTo() wrapper if present, otherwise listens for the
  // hashchange/popstate that view switches dispatch.
  function _attachAutoLoad() {
    const refresh = () => {
      const view = document.getElementById('view-schedule');
      if (!view) return;
      // Only refresh when the schedule view is actually visible to
      // avoid wasted Firestore reads on every nav.
      const isActive = view.classList.contains('active') ||
                       getComputedStyle(view).display !== 'none';
      if (isActive) loadSmartCalendar();
    };

    // Patch goTo() to fire after nav. Wrap rather than replace so we
    // don't fight with any other module that might also wrap it.
    const origGoTo = window.goTo;
    if (typeof origGoTo === 'function' && !origGoTo.__smartCalWrapped) {
      window.goTo = function (...args) {
        const r = origGoTo.apply(this, args);
        if (args[0] === 'schedule') setTimeout(refresh, 50);
        return r;
      };
      window.goTo.__smartCalWrapped = true;
    }

    // First paint after leads load — if user landed on /pro/dashboard.html#schedule
    // we want the timeline to populate without requiring a re-nav.
    document.addEventListener('DOMContentLoaded', () => setTimeout(refresh, 600));
    // Re-render when leads or tasks (re)load — value badges, and today's
    // Add-Event entries, which come from the task cache. This listened for
    // 'nbd:leads-loaded', which nothing dispatches; the loaders announce
    // 'nbd:data-refreshed' with a source (R14, 2026-09-28).
    let _t = null;
    window.addEventListener('nbd:data-refreshed', (e) => {
      const src = e && e.detail && e.detail.source;
      if (src !== 'leads' && src !== 'tasks') return;
      clearTimeout(_t); _t = setTimeout(refresh, 250);
    });
  }

  // Registered, not window-exported (Globals Tranche 3 T3-C, 2026-09-18):
  // the schedule view's manual-refresh button (data-fn, resolved registry-
  // first by dashboard-ui.js _nbdResolveCall) and dashboard-bootstrap.
  // module.js's open-schedule lead action both read it off the registry.
  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  Object.assign(window.__NBD_CALL_REGISTRY, { loadSmartCalendar: loadSmartCalendar });
  // Pure forecast helpers, exposed for tests/smart-calendar-forecast.test.js
  // (no DOM, no network — fetchForecast takes an injected fetch/store).
  window.NBDForecast = {
    forecastKey, popLevel, pickPeriod, normalizePeriod, shortenForecast,
    renderForecastChip, renderRainSummary, fetchForecast,
    NWS_MAX_POINTS, NWS_CACHE_TTL_MS, NWS_CACHE_PREFIX,
  };
  // Schedule-row helpers, exposed for tests/schedule-events-2026-09-28.test.js.
  window.NBDSchedule = { todaysEvents: _todaysEvents, renderApptRow: _renderApptRow };
  _attachAutoLoad();
})();


(function(){if(_NBD_SC_DELEGATE)return;_NBD_SC_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-sc-action]');if(!t)return;if(t.dataset.scAction==='openCardDetail'&&typeof openCardDetailModal==='function')openCardDetailModal(t.dataset.scId);});})();
