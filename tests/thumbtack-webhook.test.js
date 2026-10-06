/**
 * tests/thumbtack-webhook.test.js — Thumbtack webhook payload logic.
 *
 * Pure unit test of functions/integrations/thumbtack-logic.js plus the
 * lead-bridge mapping it feeds. Zero deps (no emulator) — the HTTP/Firestore
 * I/O lives in functions/integrations/thumbtack.js; everything tested here is
 * pure.
 *
 * WHY THE SHAPE-TOLERANCE TESTS MATTER: Thumbtack documents which events it
 * sends but NOT the JSON schema, and advises pointing the webhook at Zapier
 * (schema-agnostic). So the parser has to survive several plausible spellings
 * of the same field. These tests pin that tolerance so a future "cleanup" that
 * narrows the accepted paths fails loudly instead of silently dropping leads.
 *
 * Run: node tests/thumbtack-webhook.test.js
 */
'use strict';

const path = require('path');
const T = require(path.join(__dirname, '..', 'functions', 'integrations', 'thumbtack-logic.js'));
const L = require(path.join(__dirname, '..', 'functions', 'lead-bridge-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';

console.log('THUMBTACK — event classification');
ok('explicit lead type', T.classifyEvent({ eventType: 'lead.created' }) === T.EVENT.LEAD);
ok('explicit message type', T.classifyEvent({ eventType: 'message.created' }) === T.EVENT.MESSAGE);
ok('explicit review type', T.classifyEvent({ eventType: 'review.created' }) === T.EVENT.REVIEW);
ok('alt key `event`', T.classifyEvent({ event: 'NEW_REVIEW' }) === T.EVENT.REVIEW);
ok('request/job wording → lead', T.classifyEvent({ type: 'new_request' }) === T.EVENT.LEAD);
ok('sniff lead by customer block', T.classifyEvent({ customer: { name: 'A' } }) === T.EVENT.LEAD);
ok('sniff message by messageBody', T.classifyEvent({ messageBody: 'hi' }) === T.EVENT.MESSAGE);
ok('sniff review by rating', T.classifyEvent({ rating: 5 }) === T.EVENT.REVIEW);
ok('review wins over message-ish text', T.classifyEvent({ review: { text: 'great' }, message: 'x' }) === T.EVENT.REVIEW);
ok('unrecognised → unknown (never guessed)', T.classifyEvent({ wat: 1 }) === T.EVENT.UNKNOWN);
ok('null-safe', T.classifyEvent(null) === T.EVENT.UNKNOWN);

console.log('\nTHUMBTACK — unknown payloads still land somewhere');
ok('unknown routes to thumbtack_events', T.COLLECTION_BY_EVENT[T.EVENT.UNKNOWN] === 'thumbtack_events');
ok('lead routes to thumbtack_leads', T.COLLECTION_BY_EVENT[T.EVENT.LEAD] === 'thumbtack_leads');
ok('messages do NOT share the lead collection', T.COLLECTION_BY_EVENT[T.EVENT.MESSAGE] !== 'thumbtack_leads');
ok('reviews do NOT share the lead collection', T.COLLECTION_BY_EVENT[T.EVENT.REVIEW] !== 'thumbtack_leads');

console.log('\nTHUMBTACK — test-delivery detection (must never reach the pipeline)');
ok('isTest boolean', T.isTestPayload({ isTest: true }) === true);
ok('is_test snake', T.isTestPayload({ is_test: true }) === true);
ok('string "true"', T.isTestPayload({ testLead: 'true' }) === true);
ok('type carries test', T.isTestPayload({ eventType: 'test_lead' }) === true);
ok('real lead is not test', T.isTestPayload({ eventType: 'lead.created', customer: { name: 'A' } }) === false);
ok('null-safe', T.isTestPayload(null) === false);

console.log('\nTHUMBTACK — idempotency id extraction');
ok('leadID (Thumbtack-style caps)', T.extractEventId({ leadID: 'abc123' }) === 'abc123');
ok('leadId camel', T.extractEventId({ leadId: 'abc123' }) === 'abc123');
ok('nested lead.id', T.extractEventId({ lead: { id: 'nested1' } }) === 'nested1');
ok('reviewId', T.extractEventId({ reviewId: 'r9' }) === 'r9');
ok('bare id fallback', T.extractEventId({ id: 'plain' }) === 'plain');
ok('absent → empty (caller hashes)', T.extractEventId({ foo: 1 }) === '');
ok('objects are not stringified into an id', T.extractEventId({ id: { nope: 1 } }) === '');

console.log('\nTHUMBTACK — lead normalization across plausible shapes');
{
  const flat = T.normalizeLead({
    customerName: 'Loletha Rowanly', phone: '(513) 555-0142',
    address: '123 Elm St, Cincinnati, OH 45225', service: 'Roof Install',
  });
  ok('flat: first name', flat.firstName === 'Loletha');
  ok('flat: last name', flat.lastName === 'Rowanly');
  ok('flat: phone kept verbatim', flat.phone === '(513) 555-0142');
  ok('flat: phoneDigits normalized', flat.phoneDigits === '5135550142');
  ok('flat: service', flat.service === 'Roof Install');
}
{
  const nested = T.normalizeLead({
    customer: { firstName: 'Cat', lastName: 'Gainsford', phone: '+1 513 555 0199' },
    request: { category: 'Roof Repair' },
  });
  ok('nested: firstName hint wins', nested.firstName === 'Cat');
  ok('nested: lastName', nested.lastName === 'Gainsford');
  ok('nested: E.164 → 10 digits', nested.phoneDigits === '5135550199');
  ok('nested: service from request.category', nested.service === 'Roof Repair');
}
{
  const snake = T.normalizeLead({ first_name: 'Diane', last_name: 'Sprucewood', phone_number: '513-555-0119' });
  ok('snake_case: names', snake.firstName === 'Diane' && snake.lastName === 'Sprucewood');
  ok('snake_case: phone', snake.phoneDigits === '5135550119');
}
{
  const bare = T.normalizeLead({});
  ok('empty payload does not throw', !!bare);
  ok('empty payload gets a placeholder name', bare.firstName === '(Thumbtack lead)');
  ok('empty payload phoneDigits is empty string', bare.phoneDigits === '');
}
{
  // Thumbtack states it never sends email. Assert we tolerate that and say so.
  const noEmail = T.normalizeLead({ customerName: 'James Tamarackson', phone: '5135550111' });
  ok('email absent → empty string, not undefined', noEmail.email === '');
  const notes = T.leadNotes(noEmail);
  ok('notes explain the missing email', /does not provide customer email/i.test(notes));
}
{
  const withSvc = T.leadNotes({ service: 'Gutter Repair', details: 'Downspout pulled off', email: 'x@y.com' });
  ok('notes lead with the channel + service', withSvc.indexOf('Thumbtack — Gutter Repair') === 0);
  ok('notes carry job details', /Downspout pulled off/.test(withSvc));
  ok('no email caveat when an email exists', !/does not provide/i.test(withSvc));
}

console.log('\nTHUMBTACK — CRM bridge mapping (channel attribution)');
ok('thumbtack_leads has a bridge mapping', !!L.BRIDGE_KINDS.thumbtack_leads);
ok('registered as an external source', L.EXTERNAL_SOURCE_COLLECTIONS.indexOf('thumbtack_leads') !== -1);
{
  const norm = T.normalizeLead({ customerName: 'Adam Willowby', phone: '5135550188', service: 'Gutter Cleaning' });
  norm.notes = T.leadNotes(norm);
  const lead = L.mapPublicLeadToLead({
    collection: 'thumbtack_leads', sourceId: 'tt-1',
    ownerUid: NBD, companyId: NBD, data: norm,
  });
  // The audit's whole point: paid-marketplace spend must not be credited to the
  // website. "Website — Thumbtack" would do exactly that in the scorecard.
  ok('source reads as the channel, not the website', lead.source === 'Thumbtack');
  ok('source is NOT prefixed "Website — "', !/^Website/.test(lead.source));
  ok('webLead false (came from a marketplace)', lead.webLead === false);
  ok('precomputed notes preserved', /Thumbtack — Gutter Cleaning/.test(lead.notes));
  ok('phoneDigits carried onto the CRM lead', lead.phoneDigits === '5135550188');
  ok('tenant stamped', lead.companyId === NBD && lead.userId === NBD);
  // 2026-10-03 data audit: 61 Thumbtack leads sat at 'New' with no stageRole.
  ok('lands in the canonical new stage key', lead.stage === 'new');
  ok('…with stageRole new stamped', lead.stageRole === 'new');
  ok('provenance kind', lead.publicLeadKind === 'thumbtack');
}
{
  // Website kinds must be untouched by the external-source change.
  const web = L.mapPublicLeadToLead({
    collection: 'contact_leads', sourceId: 'c1',
    ownerUid: NBD, companyId: NBD, data: { firstName: 'Web', phone: '5135550100' },
  });
  ok('contact form still reads "Website — Contact form"', web.source === 'Website — Contact form');
  ok('contact form still webLead true', web.webLead === true);
}

// ── THE REAL PAYLOAD ────────────────────────────────────────────
// Captured 2026-08-16 from an actual Thumbtack "Test your webhooks" delivery
// to the live endpoint. Thumbtack publishes no schema, so this fixture IS the
// spec. Trimmed only of the CDN image URL. Do not "tidy" the shape — if these
// assertions fail, Thumbtack changed their contract and the parser must follow.
const REAL = {
  event: {
    triggeredAt: '2026-08-16T17:13:05Z',
    description: '',
    eventType: 'NegotiationCreatedV4',
    webhookID: '587754774977404932',
  },
  data: {
    business: { name: 'Test Business for Webhooks', businessID: '586102014464466945' },
    customer: { phone: '1234567890', customerID: '587754780290080776', firstName: 'Test', lastName: 'Customer' },
    status: 'Open',
    leadPriceBreakdown: { subtotal: '$23.15', salesTax: '$1.85' },
    request: {
      details: [
        { answer: 'One time only', question: 'Frequency of services' },
        { answer: '95010, 78901', question: 'Zip code' },
        { answer: 'The lawn professional travels to me', question: 'Travel Preferences' },
      ],
      location: { state: 'CA', city: 'San Francisco', address1: '123 Main St', zipCode: '94103', address2: 'Apt 4B' },
      requestID: '587754780288884748',
      customerID: '587754780290080776',
      description: 'Need Full Service Lawn Care',
      category: { categoryID: '240123621172183344', name: 'Full Service Lawn Care' },
    },
    leadPrice: '$25.00',
    chargeState: 'Created',
    estimate: { unitName: 'service', unitQuantity: 1, total: '$150.00', type: 'Fixed', pricePerUnit: '150.00' },
    createdAt: '2026-08-16T17:13:00Z',
    negotiationID: '587754780285493250',
  },
};

console.log('\nTHUMBTACK — the REAL payload (regression lock)');
ok('classifies as a lead (eventType NegotiationCreatedV4)', T.classifyEvent(REAL) === T.EVENT.LEAD);
ok('detected as a TEST delivery (no flag — business name is the only tell)', T.isTestPayload(REAL) === true);
ok('event id = negotiationID', T.extractEventId(REAL) === '587754780285493250');
ok('negotiationID outranks requestID (request can fan out to many pros)',
  T.extractEventId(REAL) !== REAL.data.request.requestID);
{
  const n = T.normalizeLead(REAL);
  ok('firstName from data.customer', n.firstName === 'Test');
  ok('lastName from data.customer', n.lastName === 'Customer');
  ok('phone from data.customer', n.phone === '1234567890');
  // Thumbtack's FIXTURE number is '1234567890', whose leading 1 phone-utils
  // strips as a US country code — leaving 9 digits. That is correct behaviour,
  // not a bug: real NANP area codes are [2-9]xx, so a genuine 10-digit number
  // never starts with 1 and never loses a digit here. Asserted explicitly so
  // nobody "fixes" phoneDigits10 to satisfy a fake number.
  ok('phoneDigits strips the fixture\'s leading 1 (country-code rule)', n.phoneDigits === '234567890');
  ok('a real NANP number keeps all 10 digits',
    T.normalizeLead({ data: { customer: { phone: '(513) 555-0120' } } }).phoneDigits === '5135550120');
  ok('address assembled from structured location',
    n.address === '123 Main St Apt 4B, San Francisco, CA 94103');
  ok('service from data.request.category.name', n.service === 'Full Service Lawn Care');
  ok('details from data.request.description', n.details === 'Need Full Service Lawn Care');
  ok('leadPrice captured (audit had to rebuild this by hand)', n.leadPrice === '$25.00');
  ok('thumbtack status captured', n.thumbtackStatus === 'Open');
  ok('questionnaire Q&A captured', n.qa.length === 3);
  ok('Q&A pairs intact', n.qa[0].question === 'Frequency of services' && n.qa[0].answer === 'One time only');
  ok('no email, as Thumbtack documents', n.email === '');

  const notes = T.leadNotes(n);
  ok('notes carry the service', /Full Service Lawn Care/.test(notes));
  ok('notes carry the lead cost', notes.includes('Lead cost: $25.00'));
  ok('notes carry the questionnaire', /Frequency of services: One time only/.test(notes));
  ok('notes carry the no-email caveat', /does not provide customer email/i.test(notes));
}
{
  // A REAL (non-test) lead differs only in the business name — assert it then
  // classifies as a genuine lead and would bridge.
  const live = JSON.parse(JSON.stringify(REAL));
  live.data.business.name = 'No Big Deal Home Solutions';
  ok('same payload with the real business name is NOT a test', T.isTestPayload(live) === false);
  ok('...and still classifies as a lead', T.classifyEvent(live) === T.EVENT.LEAD);
}

console.log('\nTHUMBTACK — location assembly edge cases');
ok('empty location → empty string', T.joinLocation({}) === '');
ok('null-safe', T.joinLocation(null) === '');
ok('zip only', T.joinLocation({ zipCode: '45216' }) === '45216');
ok('no address2', T.joinLocation({ address1: '133 W Marrowbone Ave', city: 'Cincinnati', state: 'OH', zipCode: '45216' })
  === '133 W Marrowbone Ave, Cincinnati, OH 45216');

console.log('\nTHUMBTACK — deterministic idempotency id');
ok('same source+id → same doc id', L.bridgeDocId('thumbtack_leads', 'tt-1') === L.bridgeDocId('thumbtack_leads', 'tt-1'));
ok('different id → different doc id', L.bridgeDocId('thumbtack_leads', 'tt-1') !== L.bridgeDocId('thumbtack_leads', 'tt-2'));

console.log('\n' + (failed === 0
  ? `PASS — ${passed} assertions`
  : `FAIL — ${failed} of ${passed + failed} failed:\n  - ` + fails.join('\n  - ')));
process.exit(failed === 0 ? 0 : 1);
