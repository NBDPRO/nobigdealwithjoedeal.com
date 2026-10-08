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
    const _t = new Date();
    const todayStr = `${_t.getFullYear()}-${String(_t.getMonth() + 1).padStart(2, '0')}-${String(_t.getDate()).padStart(2, '0')}`;
    // A lead that already has a Cal.com appointment (or an Add-Event) today is
    // not listed again as a job — same dedup as before the window existed.
    const apptLeadIds = new Set(appts.map(a => _attachLead(a, leads)._leadId).filter(Boolean));
    // Today's jobs and adjuster meetings off the lead book (2026-09-29): a
    // job with a start time and an adjuster meeting with a time join the
    // timeline; the rest are listed under "no set time".
    const dayItems = _leadDayItems(leads, todayStr, apptLeadIds);
    appts = appts.concat(dayItems.timed);
    if (appts.length) {
      // Sort by start time so travel-time math is meaningful.
      appts.sort((a, b) => _toMs(a.startTime) - _toMs(b.startTime));
      appts = appts.map(a => _attachLead(a, leads));
    }
    const manualToday = dayItems.untimed;

    // Each paint gets a number so a slow Google answer for an earlier paint
    // never lands on a newer one (the refresh button repaints).
    const paintSeq = host.dataset.scSeq = String((+host.dataset.scSeq || 0) + 1);
    if (!appts.length && !manualToday.length) {
      host.innerHTML = _emptyState('No appointments today. Time to knock some doors. 🚪');
      _attachBusy(host, [], paintSeq).catch((e) => console.warn('[smart-cal] busy attach failed:', e?.message || e));
      _attachNeedsOutcome(host, user.uid, paintSeq).catch((e) => console.warn('[smart-cal] outcome attach failed:', e?.message || e));
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
    // Busy blocks off Jo's own Google calendar (calendar hub Phase 3) — also
    // after the first paint, for the same reason.
    _attachBusy(host, appts, paintSeq).catch((e) => {
      console.warn('[smart-cal] busy attach failed:', e?.message || e);
    });
    // Earlier appointments still sitting on 'booked' — after the first paint.
    _attachNeedsOutcome(host, user.uid, paintSeq).catch((e) => {
      console.warn('[smart-cal] outcome attach failed:', e?.message || e);
    });
  }

  // ── "Needs an outcome" ──────────────────────────────────────
  // 2026-10-03 data audit: past Cal.com appointments stayed 'booked' forever —
  // nothing asked what happened (inspected? no-show? rescheduled?), so the
  // calendar and the lead both kept reading as an upcoming visit. An
  // appointment whose time has passed and is still booked/rescheduled, with
  // no outcome recorded, is flagged. Pure; exported for tests.
  const OUTCOME_LOOKBACK_DAYS = 14;
  function _apptNeedsOutcome(a, nowMs) {
    if (!a || a.outcome) return false;
    const st = String(a.status || '').toLowerCase();
    if (st !== 'booked' && st !== 'rescheduled') return false;
    const end = _toMs(a.endTime) || _toMs(a.startTime);
    return end > 0 && end < (nowMs == null ? Date.now() : nowMs);
  }

  // The last OUTCOME_LOOKBACK_DAYS of this rep's appointments before today
  // that still need an outcome. Scoped by userId — the appointments read rule
  // is isOwner(userId), so a repUid query is denied for everyone but admins
  // (the today query falls back to the same userId + startTime shape/index).
  async function _fetchPastNeedingOutcome(uid, nowMs) {
    const now = nowMs == null ? Date.now() : nowMs;
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const from = new Date(startOfToday); from.setDate(from.getDate() - OUTCOME_LOOKBACK_DAYS);
    const q = window.query(
      window.collection(window._db, 'appointments'),
      window.where('userId', '==', uid),
      window.where('startTime', '>=', from),
      window.where('startTime', '<', startOfToday),
      window.orderBy('startTime', 'asc')
    );
    const snap = await window.getDocs(q);
    const out = [];
    snap.forEach(d => { const a = Object.assign({ id: d.id }, d.data()); if (_apptNeedsOutcome(a, now)) out.push(a); });
    return out;
  }

  function _renderNeedsOutcome(list) {
    if (!list || !list.length) return '';
    const rows = list.map(a => {
      const ms = _toMs(a.startTime);
      const when = ms ? new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      const title = a.title || a.attendeeName || 'Appointment';
      const lead = a.leadId || a._leadId;
      const open = lead ? '<button type="button" class="sc-outcome-open" data-sc-action="openCardDetail" data-sc-id="' + _esc(lead) + '">Open lead →</button>' : '';
      return '<div class="sc-outcome-row"><div class="sc-outcome-main"><div class="sc-outcome-title">' + _esc(title) + '</div>' +
        '<div class="sc-outcome-when">' + _esc(when) + ' · still booked</div></div>' + open + '</div>';
    }).join('');
    return '<div class="sc-outcome-list" data-sc-outcome-list><div class="sc-outcome-head">⚠ ' + list.length +
      ' past appointment' + (list.length === 1 ? '' : 's') + ' need' + (list.length === 1 ? 's' : '') + ' an outcome</div>' + rows + '</div>';
  }

  async function _attachNeedsOutcome(host, uid, paintSeq) {
    if (!window._db || !window.query || !window.where || !window.getDocs || !window.orderBy) return;
    const list = await _fetchPastNeedingOutcome(uid);
    if (!list.length || host.dataset.scSeq !== paintSeq || !host.isConnected) return;
    host.insertAdjacentHTML('afterbegin', _renderNeedsOutcome(list));
  }

  // ── Google busy blocks ──────────────────────────────────────
  // Untitled "busy" time from Jo's main calendar (shared free/busy with the
  // CRM's service account) that no timeline entry already covers — a dentist
  // visit, a kid's game — so the day's real gaps show. Owner / admin only;
  // nothing at all when the calendar isn't shared or Google is unreachable.
  async function _attachBusy(host, appts, paintSeq) {
    const G = window.NBDGoogleCalendarUI;
    if (!G || typeof G.busyBetween !== 'function' || typeof G.freeBusyGaps !== 'function') return;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const r = await G.busyBetween(start.getTime(), end.getTime());
    if (!r || host.dataset.scSeq !== paintSeq || !host.isConnected) return;
    const entries = (appts || []).map((a) => ({ startMs: _toMs(a.startTime), endMs: _toMs(a.endTime) }));
    const gaps = G.freeBusyGaps(r, entries);
    if (!gaps.length) return;
    const tl = host.querySelector('[data-sc-timeline]');
    if (tl) {
      for (const b of gaps) {
        const row = document.createElement('div');
        row.innerHTML = _renderBusyRow(b, start.getTime(), end.getTime());
        const el = row.firstElementChild;
        const next = Array.from(tl.querySelectorAll('[data-sc-start]')).find((n) => Number(n.dataset.scStart) > b.startMs);
        tl.insertBefore(el, next || null);
      }
    } else {
      host.insertAdjacentHTML('beforeend',
        '<div class="sc-busy-list"><div class="sc-busy-head">On your Google calendar</div>' +
        gaps.map((b) => _renderBusyRow(b, start.getTime(), end.getTime())).join('') + '</div>');
    }
  }

  function _renderBusyRow(b, dayStartMs, dayEndMs) {
    const allDay = b.startMs <= dayStartMs && b.endMs >= dayEndMs;
    const when = allDay ? 'All day' : (_fmtTime(Math.max(b.startMs, dayStartMs)) + '–' + _fmtTime(Math.min(b.endMs, dayEndMs)));
    return '<div class="sc-busy" data-sc-busy><span class="sc-busy-time">' + _esc(when) + '</span>' +
      '<span class="sc-busy-lbl">Busy · your Google calendar</span></div>';
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

  // Today's install/repair jobs and adjuster meetings from the lead book
  // (calendar hub Phase 0, 2026-09-29). A lead's arrival window
  // (schedule-window.js) decides where it goes:
  //   • a start time on the job's first day → a timed entry on the timeline,
  //     start + length (a point in time with no length, like an Add-Event, so
  //     it never manufactures a "conflict");
  //   • no start time, or day 2+ of a multi-day project → the "no set time"
  //     block, labelled ("7:00 am · day 2 of 2").
  // A multi-day project is on the board EVERY day it covers — before the
  // window existed only its first day was. Adjuster meetings
  // (adjusterMeetingDate / adjusterMeetingStart, claim-core.js) follow the
  // same split and are never deduped: a Cal.com booking on the lead is the
  // homeowner's visit, not the carrier's. Pure; exported for tests.
  function _leadDayItems(leads, todayYmd, skipJobLeadIds) {
    const W = window.NBDScheduleWindow || null;
    const skip = skipJobLeadIds || new Set();
    const timed = [], untimed = [];
    const at = (ymd, hm) => {
      const [y, m, d] = String(ymd).split('-').map(Number);
      const [h, mi] = String(hm).split(':').map(Number);
      return new Date(y, m - 1, d, h, mi).getTime(); // local wall clock, never UTC-parsed
    };
    (leads || []).forEach(l => {
      if (!l || !l.id || l.deleted === true) return;
      const name = `${l.firstName || ''} ${l.lastName || ''}`.trim() || l.address || 'Lead';

      if (!skip.has(l.id)) {
        const w = W ? W.normalize(l) : null;
        // No module, or a window that contradicts itself: the date alone, as before.
        const onToday = w ? W.coversDay(l, todayYmd) : l.scheduledDate === todayYmd;
        if (onToday) {
          const dayN = w ? W.parseYmd(todayYmd).day - W.parseYmd(w.date).day + 1 : 1;
          const ofDays = w && w.days > 1 ? `day ${dayN} of ${w.days}` : '';
          if (w && w.start && dayN === 1) {
            const s = at(todayYmd, w.start);
            timed.push({
              id: 'job:' + l.id,
              title: '🔨 ' + name + (ofDays ? ' · ' + ofDays : ''),
              startTime: s,
              endTime: s + (w.durationMin || 0) * 60000,
              leadId: l.id,
              status: 'job',
              _isLeadJob: true,
            });
          } else {
            untimed.push({ lead: l, label: [w && w.start ? W.timeLabel(w) : '', ofDays].filter(Boolean).join(' · ') });
          }
        }
      }

      if (l.adjusterMeetingDate === todayYmd) {
        const start = String(l.adjusterMeetingStart || '');
        const label = 'Adjuster meeting' + (l.adjusterName ? ' · ' + l.adjusterName : '');
        if (/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) {
          const s = at(todayYmd, start);
          timed.push({
            id: 'adj:' + l.id,
            title: '🧾 ' + label + ' · ' + name,
            startTime: s,
            endTime: s,
            leadId: l.id,
            status: 'adjuster',
            _isAdjuster: true,
          });
        } else {
          untimed.push({ lead: l, label: label });
        }
      }
    });
    return { timed, untimed };
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

  // Today's MANUALLY scheduled jobs with no set time (a date-only
  // scheduledDate, day 2+ of a project, an adjuster meeting with no time) —
  // listed as a block rather than placed on the hourly timeline. Items are
  // { lead, label } from _leadDayItems; label is the window ("7:00 am · day 2
  // of 2") or "Adjuster meeting". Reuses the timeline's openCardDetail delegate.
  function _renderManualScheduled(items) {
    const rows = items.map(item => {
      const l = item.lead || {};
      const name = _esc(`${l.firstName || ''} ${l.lastName || ''}`.trim() || 'Lead');
      const label = item.label ? `<div style="font-size:11px;color:var(--orange);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(item.label)}</div>` : '';
      const addr = _esc(l.address || '');
      const open = l.id
        ? `<button data-sc-action="openCardDetail" data-sc-id="${_esc(l.id)}" style="background:none;border:none;color:var(--orange);font-size:11px;cursor:pointer;padding:0;text-decoration:underline;white-space:nowrap;">Open →</button>`
        : '';
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--br);">
        <div style="min-width:0;"><div style="font-size:13px;font-weight:600;color:var(--t);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${name}</div>${label}
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
    return head + `<div data-sc-timeline style="display:flex;flex-direction:column;gap:0;margin-top:14px;">${rows.join('')}</div>`;
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
    const outcomeFlag = _apptNeedsOutcome(a) ? '<span class="sc-outcome-chip">Needs an outcome</span>' : '';
    const leadLink = a._leadId
      ? `<button type="button" class="sc-lead-open" data-sc-action="openCardDetail" data-sc-id="${_esc(a._leadId)}">Open lead →</button>`
      : '';
    return `
      <div data-sc-start="${_toMs(a.startTime)}" style="display:grid;grid-template-columns:88px 1fr auto;gap:10px;align-items:flex-start;padding:10px 12px;background:var(--s2);border:1px solid var(--br);border-radius:7px;">
        <div>
          <div style="font-family:'DM Mono',monospace;font-size:13px;font-weight:700;color:var(--t);">${_esc(start)}</div>
          <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--m);">${_esc(end)}</div>
        </div>
        <div style="min-width:0;">
          <div style="font-size:13px;font-weight:600;color:var(--t);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(title)}</div>
          ${where ? `<div style="font-size:11px;color:var(--m);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📍 ${_esc(where)}</div>` : ''}
          <span data-sc-forecast="${_esc(a.id || '')}"></span>
          ${outcomeFlag}
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
    for (const item of manualToday || []) {
      // { lead, label } from _leadDayItems (2026-09-29); a bare lead still works.
      const l = (item && item.lead) || item || {};
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
  window.NBDSchedule = {
    todaysEvents: _todaysEvents, renderApptRow: _renderApptRow, renderBusyRow: _renderBusyRow, attachBusy: _attachBusy,
    // "needs an outcome" (2026-10-03) — tests/data-integrity-guards-2026-10-03.test.js
    apptNeedsOutcome: _apptNeedsOutcome, fetchPastNeedingOutcome: _fetchPastNeedingOutcome, renderNeedsOutcome: _renderNeedsOutcome,
    // tests/calendar-phase0-2026-09-29.test.js
    leadDayItems: _leadDayItems, renderManualScheduled: _renderManualScheduled,
  };
  _attachAutoLoad();
})();


(function(){if(_NBD_SC_DELEGATE)return;_NBD_SC_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-sc-action]');if(!t)return;if(t.dataset.scAction==='openCardDetail'&&typeof openCardDetailModal==='function')openCardDetailModal(t.dataset.scId);});})();
