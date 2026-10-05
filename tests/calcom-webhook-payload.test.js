/**
 * tests/calcom-webhook-payload.test.js — the Cal.com booking webhook captures
 * the homeowner's phone and address from the fields Cal.com actually sends.
 *
 * WHY THIS EXISTS (2026-09-13)
 * ────────────────────────────
 * An organic gutter/siding lead reached Jo with an email and no phone.
 * functions/integrations/calcom.js read the phone from attendees[0].phoneNumber
 * only; Cal.com's documented BOOKING_CREATED payload carries no phone on the
 * attendee — the Phone booking question arrives at
 * responses.attendeePhoneNumber ({label, value, isHidden}) and a phone-call
 * event's number at responses.location.value.optionValue. So making the phone
 * REQUIRED in Cal.com would still have produced a phone-less CRM lead. The
 * pre-existing guard (tests/smoke/functions.test.js 'Cal.com webhook') is a
 * set of source regexes, which passed happily while every booking dropped the
 * number.
 *
 * This suite EXECUTES functions/integrations/calcom-logic.js against payloads
 * built from Cal.com's documented shape (plus the legacy attendee shape and
 * the hostile cases), and then asserts calcom.js is actually wired to it.
 * Fixture numbers are 555-01xx (reserved fictional); no customer data.
 *
 * Zero deps. Run: node tests/calcom-webhook-payload.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'functions', 'integrations', 'calcom-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

// Documented BOOKING_CREATED shape (cal.com/docs/developing/guides/automation/webhooks):
// attendees carry email/name/timeZone/language, answers live in `responses`.
function documented(over = {}) {
  return Object.assign({
    type: 'roof-inspection',
    title: 'Free Roof Inspection between Joe Deal and Pat Example',
    eventTypeId: 5279797,
    uid: 'bk_documented_1',
    location: 'attendeeInPerson',
    additionalNotes: 'Two shingles missing after the storm',
    organizer: { username: 'nobigdeal', email: 'owner@example.com' },
    attendees: [{ email: 'pat@example.com', name: 'Pat Example', firstName: 'Pat', lastName: 'Example', timeZone: 'America/New_York', language: { locale: 'en' } }],
    responses: {
      name: { label: 'your_name', value: 'Pat Example', isHidden: false },
      email: { label: 'email_address', value: 'pat@example.com', isHidden: false },
      attendeePhoneNumber: { label: 'Mobile phone', value: '+15135550100', isHidden: false },
      location: { label: 'location', value: { value: 'attendeeInPerson', optionValue: '12 Elm St, Goshen, OH 45122' }, isHidden: false },
      notes: { label: 'additional_notes', value: 'Two shingles missing after the storm', isHidden: false },
    },
  }, over);
}

console.log('\nF1 — the documented shape: phone in responses, address in the location response');
{
  const lead = C.buildCalcomLeadFields({ payload: documented(), bookingId: 'bk_documented_1' });
  ok('phone captured from responses.attendeePhoneNumber', lead.phone === '+15135550100', lead.phone);
  ok('phoneDigits is the canonical 10-digit key', lead.phoneDigits === '5135550100', lead.phoneDigits);
  ok('phoneSource records where it came from', lead.phoneSource === 'responses.attendeePhoneNumber', lead.phoneSource);
  ok('needsPhone is false', lead.needsPhone === false);
  ok('address is the typed address, not the location token', lead.address === '12 Elm St, Goshen, OH 45122', lead.address);
  ok('addressSource is the location response', lead.addressSource === 'responses.location', lead.addressSource);
  ok('name split from the attendee', lead.firstName === 'Pat' && lead.lastName === 'Example');
  ok('email carried', lead.email === 'pat@example.com');
  ok('booked notes carried with no NO-PHONE line', lead.notes === 'Two shingles missing after the storm', lead.notes);
  ok('event slug + id + attribution recorded', lead.calcomEventSlug === 'roof-inspection' && lead.calcomEventTypeId === 5279797 && lead.sourcePage === 'calcom:roof-inspection');
  ok('provenance unchanged from the pre-fix doc (source label, kind, webLead)', lead.source === 'Website — Cal.com booking' && lead.publicLeadKind === 'calcom_booking' && lead.webLead === true && lead.stage === 'new' && lead.stageRole === 'new' && lead.status === 'new');
  ok('booking id carried', lead.calcomBookingId === 'bk_documented_1');
  const legacyRead = (documented().attendees[0].phoneNumber || '');
  ok('…and the field the old code read is empty on this shape (the bug, pinned)', legacyRead === '');
}

console.log('\nF2 — legacy / REST shape: phone on the attendee');
{
  const p = documented({ responses: {}, location: '44 Oak Ave, Milford, OH 45150', attendees: [{ name: 'Lee Legacy', email: 'lee@example.com', phoneNumber: '(513) 555-0101' }] });
  const r = C.resolveAttendeePhone(p);
  ok('attendees[0].phoneNumber still wins when present', r.phone === '(513) 555-0101' && r.phoneDigits === '5135550101' && r.phoneSource === 'attendees[0].phoneNumber', r);
  const a = C.resolveBookingAddress(p);
  ok('a real address in top-level location is used when the response is absent', a.address === '44 Oak Ave, Milford, OH 45150' && a.addressSource === 'location', a);
  ok('attendees[0].phone alias (REST) is read too', C.resolveAttendeePhone({ attendees: [{ phone: '513.555.0109' }] }).phoneDigits === '5135550109');
}

console.log('\nF3 — bare-string responses (REST bookingFieldsResponses)');
{
  const r = C.resolveAttendeePhone({ attendees: [{ name: 'X' }], responses: { attendeePhoneNumber: '1-513-555-0102' } });
  ok('a bare string response is read', r.phoneDigits === '5135550102' && r.phoneSource === 'responses.attendeePhoneNumber', r);
  const a = C.resolveBookingAddress({ responses: { location: { value: 'attendeeInPerson', optionValue: '9 Pine Rd, Batavia, OH' } } });
  ok('a flat location response {value, optionValue} is read', a.address === '9 Pine Rd, Batavia, OH', a);
}

console.log('\nF4 — phone-call event: the number arrives in the location prompt');
{
  const p = documented({
    type: 'roof-question-call', location: '+15135550103',
    responses: {
      attendeePhoneNumber: { label: 'phone_number', isHidden: true },
      location: { label: 'location', value: { value: 'phone', optionValue: '+15135550103' }, isHidden: false },
    },
  });
  const lead = C.buildCalcomLeadFields({ payload: p, bookingId: 'bk_call' });
  ok('phone taken from responses.location when its type is the attendee phone', lead.phoneDigits === '5135550103' && lead.phoneSource === 'responses.location', lead);
  ok('the number is NOT written as the address', lead.address === '' && lead.addressSource === 'none', lead.address);
  ok('needsPhone false', lead.needsPhone === false);
}

console.log('\nF5 — no phone anywhere');
{
  const p = documented({ type: 'gutter-siding-estimate', responses: { location: { value: { value: 'attendeeInPerson', optionValue: '3 Birch Ct, Mason, OH' } } } });
  const lead = C.buildCalcomLeadFields({ payload: p, bookingId: 'bk_nophone' });
  ok('phone empty, phoneDigits empty, phoneSource none', lead.phone === '' && lead.phoneDigits === '' && lead.phoneSource === 'none', lead);
  ok('needsPhone is true', lead.needsPhone === true);
  ok('notes lead with the NO-PHONE instruction, booked notes kept below it', lead.notes.startsWith(C.NO_PHONE_NOTE) && lead.notes.includes('Two shingles missing'), lead.notes);
  ok('the rest of the lead still lands (address, email, attribution)', lead.address === '3 Birch Ct, Mason, OH' && lead.email === 'pat@example.com' && lead.sourcePage === 'calcom:gutter-siding-estimate');
}

console.log('\nF6 — hostile values are rejected, never stored');
{
  ok('"call me" in the phone question is not a phone', C.resolveAttendeePhone({ responses: { attendeePhoneNumber: { value: 'call me' } } }).phoneSource === 'none');
  ok('the location TYPE token "phone" with no number is not a phone', C.resolveAttendeePhone({ responses: { location: { value: { value: 'phone', optionValue: '' } } } }).phoneSource === 'none');
  const organizerPhone = C.resolveAttendeePhone({ responses: { location: { value: { value: 'userPhone', optionValue: '+18595550199' } } } });
  ok("the ORGANIZER's phone (userPhone location) is never taken as the homeowner's", organizerPhone.phoneSource === 'none', organizerPhone);
  const organizerAddr = C.resolveBookingAddress({ location: 'inPerson', responses: { location: { value: { value: 'inPerson', optionValue: '1 Office Park, Goshen, OH' } } } });
  ok("the ORGANIZER's address (inPerson location) is never taken as the property", organizerAddr.addressSource === 'none', organizerAddr);
  for (const token of ['attendeeInPerson', 'integrations:google_meet', 'https://cal.com/video/abc', '+15135550104', 'link']) {
    ok(`top-level location ${JSON.stringify(token)} is not an address`, C.resolveBookingAddress({ location: token }).address === '');
  }
  ok('a 9-digit number is not a US phone', C.isUsPhone('513555010') === false);
  const intl = C.resolveAttendeePhone({ responses: { attendeePhoneNumber: { value: '+44 20 7946 0958' } } });
  ok('a real non-US number is kept but flagged unverified (never silently dropped)', intl.phone === '+44 20 7946 0958' && /:unverified$/.test(intl.phoneSource), intl);
  const usBeatsOther = C.resolveAttendeePhone({ attendees: [{ phoneNumber: '12345678' }], responses: { attendeePhoneNumber: { value: '(859) 555-0105' } } });
  ok('a US-shaped candidate beats an earlier malformed one', usBeatsOther.phoneDigits === '8595550105' && usBeatsOther.phoneSource === 'responses.attendeePhoneNumber', usBeatsOther);
  let threw = false;
  try { C.buildCalcomLeadFields({ payload: null }); C.buildCalcomLeadFields({ payload: { attendees: 'nope', responses: [] } }); C.resolveAttendeePhone(undefined); C.resolveBookingAddress(7); }
  catch (e) { threw = e.message; }
  ok('nothing throws on garbage payloads', threw === false, threw);
}

console.log('\nF7 — event type extraction');
{
  ok('slug from `type`', C.extractEventType({ type: 'adjuster-meeting' }).slug === 'adjuster-meeting');
  ok('slug from eventType.slug', C.extractEventType({ eventType: { slug: 'estimate-walkthrough', id: 9 } }).slug === 'estimate-walkthrough');
  ok('id 0 is not mistaken for missing', C.extractEventType({ eventTypeId: 0 }).eventTypeId === 0);
  ok('no slug → sourcePage "calcom"', C.buildCalcomLeadFields({ payload: { attendees: [{ name: 'A' }] } }).sourcePage === 'calcom');
}

console.log('\nM-1 — matching an existing pipeline lead');
{
  const leads = [
    { id: 'a', data: { email: 'Someone@Example.com', phone: '' } },
    { id: 'b', data: { email: '', phone: '(513) 555-0106' } },
    { id: 'c', data: { email: '', phone: 'x', phoneDigits: '5135550107' } },
  ];
  ok('matches on email, case-insensitive', C.matchExistingLead(leads, { email: 'someone@example.com' }) === 'a');
  ok('matches on phone via the canonical transform', C.matchExistingLead(leads, { phoneDigits: '5135550106' }) === 'b');
  ok('matches on a stored phoneDigits key', C.matchExistingLead(leads, { phoneDigits: '5135550107' }) === 'c');
  ok('9 digits never match', C.matchExistingLead(leads, { phoneDigits: '513555010' }) === null);
  ok('nothing to match on → null (never "first lead")', C.matchExistingLead(leads, {}) === null);
}

console.log('\nWIRING — calcom.js actually uses the resolver (source checks on the real file)');
{
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'integrations', 'calcom.js'), 'utf8');
  ok('calcom.js requires ./calcom-logic', /require\(['"]\.\/calcom-logic['"]\)/.test(src));
  const m1 = src.indexOf('M-1:');
  const m2 = src.indexOf('M-2:');
  const resolveAt = src.search(/resolveAttendeePhone\(payload\)/);
  ok('the phone is resolved from the payload BEFORE the M-1 match', resolveAt > -1 && m1 > -1 && resolveAt < src.indexOf('matchExistingLead('), { resolveAt, m1 });
  ok('M-1 matches through matchExistingLead', /matchExistingLead\(/.test(src));
  ok('M-2 builds the lead through buildCalcomLeadFields', m2 > -1 && src.indexOf('buildCalcomLeadFields(', m2) > -1);
  ok('the only attendee-phone read left is inside calcom-logic (no stray attendees[0].phoneNumber / attendee.phoneNumber in calcom.js)',
     !/attendee\s*&&\s*attendee\.phoneNumber|attendees\[0\]\.phoneNumber/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('the created-lead log line carries phonePresent + phoneSource breadcrumbs', /created CRM lead for unmatched booking[^)]*phonePresent[^)]*phoneSource/.test(src));
  ok('the appointment doc stores the resolved phone', /attendeePhone:\s*resolved\.phone/.test(src));
  ok('the HMAC block is untouched (signature verified before any payload read)', src.indexOf('timingSafeEqual') > -1 && src.indexOf("createHmac('sha256'") < src.indexOf('resolveAttendeePhone(payload)'));
}

console.log('\nBACKFILL — the repair tool resolves phones the same way');
{
  const bf = fs.readFileSync(path.join(ROOT, 'scripts', 'backfill-calcom-dropped-leads.js'), 'utf8');
  ok('backfill requires the shared calcom-logic module', /require\(['"]\.\.\/functions\/integrations\/calcom-logic['"]\)/.test(bf));
  ok('backfill resolves the attendee phone through it (reads bookingFieldsResponses too)', /resolveAttendeePhone\(/.test(bf) && /bookingFieldsResponses/.test(bf));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
