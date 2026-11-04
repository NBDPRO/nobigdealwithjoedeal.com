/**
 * calendar-trial.js — the EventCalendar trial page (docs/pro/calendar-trial.html).
 *
 * SAMPLE data only, laid out around the current New York week so the board is
 * never empty. Real-shaped docs (leads with the schedule-window fields, Cal.com
 * appointments with ISO startTime) go through the same adapter the CRM would
 * use (js/schedule-ec-events.js), so what renders here is what the real board
 * would render. Drag is on so touch handling can be judged; a drop only
 * reports the fields it WOULD write — nothing reads or writes Firestore.
 *
 * CSP: every event body is built with createElement + textContent and handed
 * over as `domNodes` — never the library's `html` content option.
 */
(function () {
  'use strict';

  var SW = window.NBDScheduleWindow;
  var ECE = window.NBDScheduleEcEvents;
  var host = document.getElementById('ctCal');
  var status = document.getElementById('ctStatus');
  if (!host || !SW || !ECE || !window.EventCalendar) {
    if (status) status.textContent = 'The calendar files did not load.';
    return;
  }

  var today = ECE.nyWall(Date.now()).slice(0, 10);
  var mon = SW.mondayOf(today);
  var d = function (n) { return SW.addDays(mon, n); };
  // A wall-clock New York time on day n → an ISO instant, like Cal.com sends.
  var at = function (n, hm) { return new Date(SW.localToUtcMs(d(n), hm)).toISOString(); };

  var CREWS = [
    { id: 'sub-rivera', title: 'Rivera Roofing (sub)' },
    { id: 'sub-northbank', title: 'Northbank Exteriors (sub)' },
    { id: 'sub-gutterpro', title: 'Gutter Pro (sub)' },
    { id: ECE.NO_CREW, title: 'No crew yet' }
  ];

  var leads = [
    { id: 's1', firstName: 'Sample', lastName: 'Hughes', subId: 'sub-rivera', stage: 'crew_scheduled',
      scheduledDate: d(1), scheduledStart: '07:00', scheduledEndDate: d(2) },
    { id: 's2', firstName: 'Sample', lastName: 'Patel', subId: 'sub-northbank', stage: 'crew_scheduled',
      scheduledDate: d(3), scheduledStart: '07:00', scheduledEndDate: d(3) },
    { id: 's3', firstName: 'Sample', lastName: 'Okafor', subId: 'sub-gutterpro', stage: 'crew_scheduled',
      scheduledDate: d(2), scheduledStart: '13:00', scheduledDurationMin: 180 },
    { id: 's4', address: '100 Sample Ave', stage: 'approved', scheduledDate: d(0), scheduledStart: '10:00', scheduledDurationMin: 90 },
    { id: 's5', firstName: 'Sample', lastName: 'Nguyen', subId: 'sub-rivera', stage: 'approved', scheduledWeek: d(7) },
    { id: 's6', firstName: 'Sample', lastName: 'Brooks', stage: 'approved', scheduledDate: d(4) },
    { id: 's7', firstName: 'Sample', lastName: 'Lopez', stage: 'claim_filed', adjusterMeetingDate: d(2), adjusterMeetingStart: '09:30' },
    { id: 's8', firstName: 'Sample', lastName: 'Fischer', subId: 'sub-northbank', stage: 'crew_scheduled',
      scheduledDate: d(8), scheduledStart: '07:00', scheduledEndDate: d(9) }
  ];
  var appointments = [
    { bookingId: 'b1', title: 'Roof inspection · Sample Carter', startTime: at(0, '15:00'), endTime: at(0, '16:00'), status: 'booked' },
    { bookingId: 'b2', title: 'Roof inspection · Sample Diaz', startTime: at(1, '16:30'), endTime: at(1, '17:30'), status: 'booked' },
    { bookingId: 'b3', title: 'Estimate review · Sample Kim', startTime: at(3, '11:00'), endTime: at(3, '11:30'), status: 'rescheduled' },
    { bookingId: 'b4', title: 'Cancelled — never shows', startTime: at(3, '12:00'), status: 'cancelled' }
  ];

  var events = ECE.toEvents({ leads: leads, appointments: appointments });

  var phone = window.matchMedia('(max-width: 700px)').matches;
  var startView = phone ? 'listWeek' : 'timeGridWeek';

  function body(info) {
    var wrap = document.createElement('span');
    // A custom body replaces the library's, time label included — put it back.
    // The library hands all-day events a "12:00 AM" timeText too; its own
    // body hides that, so this one must as well.
    if (info.timeText && !info.event.allDay) {
      var tm = document.createElement('span');
      tm.className = 'ct-ev-time';
      tm.textContent = info.timeText + ' ';
      wrap.appendChild(tm);
    }
    var t = document.createElement('span');
    t.className = 'ct-ev-title';
    t.textContent = info.event.title;
    wrap.appendChild(t);
    var note = info.event.extendedProps && info.event.extendedProps.note;
    if (note) {
      var n = document.createElement('span');
      n.className = 'ct-ev-note';
      n.textContent = note;
      wrap.appendChild(n);
    }
    return { domNodes: [wrap] };
  }

  function ymdOf(dt) {
    // EventCalendar parses our wall-clock strings as BROWSER-LOCAL time and
    // hands back ordinary local Dates, so the local getters give back exactly
    // the New York wall clock we fed it, whatever the device's timezone.
    // (getUTC* here is the trap: on an EST device a 1 pm drop read as 18:00 —
    // caught in the trial's drag test, 2026-11-04.)
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
  }
  function hmOf(dt) {
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return p(dt.getHours()) + ':' + p(dt.getMinutes());
  }

  var ec = window.EventCalendar.create(host, {
    view: startView,
    date: today,
    firstDay: 1,
    height: phone ? 'auto' : '720px',
    headerToolbar: { start: 'prev,next today', center: 'title', end: '' },
    slotMinTime: '06:00:00',
    slotMaxTime: '21:00:00',
    scrollTime: '07:00:00',
    nowIndicator: true,
    allDaySlot: true,
    dayMaxEvents: true,
    resources: CREWS,
    // Crew scheduling is by the day: one slot per day, not per hour (the
    // default makes a single day several screens wide).
    views: {
      resourceTimelineWeek: { slotDuration: { days: 1 }, slotWidth: 120 }
    },
    events: events,
    eventClassNames: function (info) {
      return ['ct-k-' + ((info.event.extendedProps && info.event.extendedProps.kind) || 'job')];
    },
    eventContent: body,
    editable: false,
    eventStartEditable: true,
    eventDurationEditable: false,
    eventClick: function (info) {
      var e = info.event;
      status.textContent = e.title + ' · ' + (e.allDay ? ymdOf(e.start) + ' (all day)' : ymdOf(e.start) + ' ' + hmOf(e.start));
    },
    eventDrop: function (info) {
      var e = info.event;
      var k = e.extendedProps && e.extendedProps.kind;
      if (k !== 'job') {
        info.revert();
        status.textContent = 'Only crew jobs move here. Cal.com bookings and adjuster meetings change at their source.';
        return;
      }
      // Move the whole window, never shorten it: a 2-day project keeps its
      // last day (shifted) and its 7 am start; a timed job keeps its length.
      var lead = leads.filter(function (l) { return l.id === e.extendedProps.leadId; })[0] || {};
      var oldDay = SW.parseYmd(lead.scheduledDate);
      var newDay = SW.parseYmd(ymdOf(e.start));
      var shift = oldDay && newDay ? newDay.day - oldDay.day : 0;
      var fields = { scheduledDate: ymdOf(e.start) };
      if (!e.allDay) fields.scheduledStart = hmOf(e.start);
      else if (lead.scheduledStart) fields.scheduledStart = lead.scheduledStart;
      if (lead.scheduledDurationMin) fields.scheduledDurationMin = lead.scheduledDurationMin;
      if (lead.scheduledEndDate) fields.scheduledEndDate = SW.addDays(lead.scheduledEndDate, shift);
      var crew = info.newResource ? info.newResource.id : null;
      if (crew) fields.subId = crew === ECE.NO_CREW ? '' : crew;
      var checked = SW.check(Object.assign({}, fields));
      status.textContent = (checked.ok ? 'Would save ' : 'Would refuse ') + JSON.stringify(fields) +
        (checked.ok ? ' — nothing saved (trial).' : ' — ' + SW.ERRORS[checked.error]);
    }
  });

  var buttons = document.querySelectorAll('.ct-views [data-view]');
  function mark(view) {
    buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === view)); });
  }
  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      var v = b.getAttribute('data-view');
      ec.setOption('view', v);
      mark(v);
    });
  });
  mark(startView);
  status.textContent = events.length + ' sample events · tap one for details, drag a job to see what would save.';
})();
