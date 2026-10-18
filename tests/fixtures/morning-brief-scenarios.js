'use strict';

/**
 * Deterministic buildBrief inputs for tests/morning-brief-delta-2026-10-18.test.js.
 * The golden file next to it (morning-brief-flag-off-golden.json) was generated
 * by running these through the ORIGINAL functions/morning-brief-logic.js (before
 * delta mode existed), so the flag-off snapshot test compares against the old
 * code's bytes, not against itself.
 */

const NOW = Date.parse('2026-10-19T10:45:00Z'); // 06:45 EDT
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });

const leads = [
  { id: 'L1', companyId: 'o', firstName: 'Ann', lastName: 'Roe', address: '12 Elm St, Mason OH', phone: '513-555-0111', stage: 'new', jobType: 'insurance', scheduledDate: '2026-10-19', scheduledStart: '09:00' },
  { id: 'L2', companyId: 'o', firstName: 'Bo', lastName: 'Kim', address: '40 Oak Ave', stage: 'crew_scheduled', scheduledDate: '2026-10-19', scheduledStart: '13:00' },
];
const appointments = [
  { id: 'a1', repUid: 'o', title: 'Free roof inspection', attendeeName: 'Cy Lee', location: '1 Dawn Ct', startTime: ts('2026-10-19T14:00:00Z'), endTime: ts('2026-10-19T15:00:00Z') },
];

const needsWeek = Array.from({ length: 8 }, (_, i) => ({ leadId: 'NW' + (i + 1), jobId: null, name: 'Signed Person ' + (i + 1), stage: 'signed' }));
const promises = [
  { callId: 'promise:P1', leadId: 'P1', kind: 'urgent', who: 'Dee Fox', promises: ['Send the estimate', 'Call back Tuesday'], due: '2026-10-18' },
  { callId: 'promise:P2', leadId: 'P2', kind: 'due', who: 'Eli Gray', promises: ['Text the photos'], due: '2026-10-19' },
  { callId: 'call-77', leadId: null, kind: 'nofile', who: '(513) 555-0199', summary: 'Asked about gutters', due: '' },
];
const reviewAsks = [
  { id: 'R1', firstName: 'Flo', lastName: 'Hart', jobTitle: 'Roof replacement' },
  { id: 'R2', firstName: '', lastName: '', jobTitle: '' },
];
const newLeads = [
  { name: 'Gus Ivy', phone: '513-555-0123', label: 'Website', when: 'Oct 18, 8:15 PM', address: '9 Pine Rd' },
];

const base = () => ({ appointments, leads, jobs: [], nowMs: NOW, invoices: [], activityByLead: {}, stormProofsByLead: {}, briefLines: {}, weatherByLead: {} });

function scenarios() {
  const full = { newLeads, promises, reviewAsks, quietLines: ['3 calls from (513) 555-0000 - unlabelled'], promiseCheckFailed: false };
  return {
    // appointments + all standing lists + every absorbed section
    full: Object.assign(base(), { sections: full, needsWeek }),
    // no appointments, only signed jobs needing a week
    needsWeekOnly: Object.assign(base(), { appointments: [], leads: [], needsWeek }),
    // no appointments, sections only, promise read failed
    sectionsFailed: Object.assign(base(), { appointments: [], leads: [], sections: { newLeads: [], promises: [], reviewAsks: [], promiseCheckFailed: true, quietLines: [] } }),
    // appointments only, no absorb, nothing standing
    apptsOnly: Object.assign(base(), {}),
    // nothing at all
    empty: Object.assign(base(), { appointments: [], leads: [] }),
  };
}

module.exports = { NOW, scenarios, newLeads, promises, reviewAsks, needsWeek };
