// @ts-check
// "Today" the way the product reads it: the America/New_York calendar day. The Today plan, the Day route
// (Mission Control), the Field App's stops and the visit recorder's appointment rows all list an appointment
// only when its New York day is today's (today-plan.js collectTodayItems: nyDateOf(startMs) === nyDateOf(now)),
// whatever zone the runner or the browser is in. So "now + N minutes" is TOMORROW's row for the last N minutes
// of every Eastern day (mission-control +240 min from 8 pm: the CI run that started 2026-10-26 00:00 UTC listed 2
// of 3 stops; field-app +40 from 11:20 pm; visit-recorder +15 from 11:45 pm). A spec that needs "an appointment
// today" puts it at a fixed Eastern time of today's Eastern day instead.
'use strict';

/** The America/New_York calendar day (YYYY-MM-DD) of a timestamp (default: now). */
const nyDay = (ms = Date.now()) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** The instant at which the New York wall clock reads hh:mm on that YYYY-MM-DD (daytime hours: no DST edge). */
function nyAt(/** @type {string} */ ymd, /** @type {number} */ hh, /** @type {number} */ mm) {
  const guess = Date.parse(ymd + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00Z');
  // the New York wall clock of that instant, read back as UTC: the difference is the zone's offset that day
  const wall = Date.parse(new Date(guess).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(' ', 'T') + 'Z');
  return new Date(guess + (guess - wall));
}

module.exports = { nyDay, nyAt };
