/**
 * tests/q11-thursday-lead-notes-2026-11-09.test.js — Call to Close Q11, Jo's
 * decision on review item 3 (2026-11-09): a lead that Thursday creates must
 * not carry the call in lead.notes, which a viewer reads.
 *
 * functions/integrations/thursday-logic.js callNotes() used to be the new
 * lead's notes: the issue / summary, the urgent reason, the best time, the
 * insurance carrier and claim number. Now:
 *   - lead.notes is a short pointer ("From a Thursday call on <day>. The
 *     details are on the call.");
 *   - the same lines are written to the call doc (thursday_calls/<id>.callNotes),
 *     which firestore.rules keeps from a viewer;
 *   - the customer page's Thursday row (owners only: a viewer never reads
 *     thursday_calls) shows them, so an owner still sees carrier and claim #
 *     on the customer; the lead's own insurance fields (insCarrier,
 *     claimNumber, claimStatus) are kept as they were.
 *
 * Run: node tests/q11-thursday-lead-notes-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const T = require(path.join(ROOT, 'functions/integrations/thursday-logic.js'));
const ex = T.sanitizeExtraction({
  caller_name: 'halina nowicka', callback_number: '5135559876', address: '7420 Birchwood Ct', town: 'west chester', state: 'OH', zip: '45069',
  issue: 'ISSUESECRET shingles blown off', urgent: true, urgent_reason: 'URGENTSECRET tarp tonight', callback_window: 'after 3pm',
  heard_about_us: 'Google', insurance: { involved: 'yes', carrier: 'CarrierCo', claim_filed: 'yes', claim_number: 'CLM-0042' },
});
const call = { callId: 'abc123', from: '+15135559876', startedAt: '2026-11-09T14:00:00.000Z', summary: 'SUMMARYSECRET storm damage' };

console.log('\n1. the lead Thursday creates');
const lead = T.buildLeadDoc({ extraction: ex, call, ownerUid: 'U', companyId: 'U' });
ok('lead.notes is a short pointer to the call', lead.notes === '📞 From a Thursday call on 2026-11-09. The details are on the call.', lead.notes);
ok('lead.notes carries no issue, urgent reason, carrier or claim number', !/ISSUESECRET|SUMMARYSECRET|URGENTSECRET|CarrierCo|CLM-0042|after 3pm/.test(lead.notes), lead.notes);
ok('positive control: the lead still has its insurance fields (the CRM\'s own, as before)', lead.jobType === 'insurance' && lead.insCarrier === 'CarrierCo' && lead.claimNumber === 'CLM-0042' && lead.claimStatus === 'Claim Filed');
ok('positive control: the rest of the lead is as before', lead.firstName === 'Halina' && lead.source === 'Google' && lead.thursdayCallId === 'abc123' && lead.urgent === true);
const noDate = T.buildLeadDoc({ extraction: ex, call: Object.assign({}, call, { startedAt: null }), ownerUid: 'U', companyId: 'U' });
ok('a call with no start time: the pointer drops the day', noDate.notes === '📞 From a Thursday call. The details are on the call.', noDate.notes);

console.log('\n2. the call keeps the lines');
ok('callNotes is exported', typeof T.callNotes === 'function');
const cn = typeof T.callNotes === 'function' ? T.callNotes(ex, call) : '';
ok('…and holds what lead.notes used to: issue, urgent reason, best time, carrier, claim #', /ISSUESECRET/.test(cn) && /URGENTSECRET/.test(cn) && /Best time to call: after 3pm/.test(cn)
  && /Insurance: CarrierCo, claim filed \(#CLM-0042\)/.test(cn), cn);
const TH = read('functions/integrations/thursday.js');
ok('thursday.js writes them on the call doc (thursday_calls, viewer-closed)', /callNotes: extraction \? T\.callNotes\(extraction, call\) : null/.test(TH));

console.log('\n3. the customer page (owners)');
const CB = read('docs/pro/js/customer-bootstrap.module.js');
const row = CB.slice(CB.indexOf("title: 'Thursday took a call'"), CB.indexOf("title: 'Thursday took a call'") + 400);
ok('the Thursday row shows the call\'s notes (carrier, claim #) when it has them', /c\.callNotes/.test(row), row);
ok('…and that read is still skipped for a viewer', /\(claims\.role \|\| ''\) !== 'viewer'\) for \(const scope of scopes\)/.test(CB));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
