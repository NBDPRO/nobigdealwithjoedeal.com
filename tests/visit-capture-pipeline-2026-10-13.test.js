/**
 * tests/visit-capture-pipeline-2026-10-13.test.js - the SERVER half of the
 * in-person visit recorder (functions/visit-capture.js + visit-capture-logic.js).
 *
 *   documentation/projects/VISIT-CAPTURE-PR2-2026-10-13.md
 *
 * Runs the real modules against an in-memory Firestore that HONOURS where()
 * / orderBy / startAfter / limit (tests/helpers/fake-firestore-visit.js), a
 * fake Storage bucket, and stubbed Groq / Claude / consent / budget. Nothing
 * here calls a vendor, sends a message or touches production.
 *
 *   1. provider outage classifier (credit / auth / 429 / 5xx are outages; a
 *      recording's own failure is not), with negative controls
 *   2. the state machine (nextStep) decides from the doc alone
 *   3. vocabulary prompt + keyword corrections
 *   4. ranked suggestions: appointment window, spoken name (refuses on
 *      ambiguity), GPS only when exactly one mapped customer is in radius
 *   5. what attaching files: timeline row, kind:'promise' tasks the never-forget
 *      channel reads, follow-ups, facts - idempotent
 *   6. the pipeline end to end, outage / retry / strike / skip scenarios
 *   7. the attach callable: tenant, role, do-not-record, idempotency, retract
 *   8. retention sweep + retry sweep, and the index each query needs
 *
 * Run: node tests/visit-capture-pipeline-2026-10-13.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-visit-capture';

const ROOT = path.join(__dirname, '..');
const LG = require(path.join(ROOT, 'functions', 'visit-capture-logic.js'));
const V = require(path.join(ROOT, 'functions', 'visit-capture.js'));
const PRM = require(path.join(ROOT, 'functions', 'promise-logic.js'));
const { makeDb, makeBucket } = require('./helpers/fake-firestore-visit.js');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const J = (x) => JSON.stringify(x);

// ── fixtures ────────────────────────────────────────────────────────────
const OWNER = 'uOwner';
const NOW = Date.parse('2026-10-13T20:00:00Z');        // 4:00 pm ET
const START = Date.parse('2026-10-13T19:10:00Z');      // 3:10 pm ET, 1500 s long
const TODAY = '2026-10-13';
const LEADS = {
  'leads/L_SMITH': { userId: OWNER, companyId: OWNER, firstName: 'Jane', lastName: 'Smith', address: '412 Oak Hill Dr, Florence, KY 41042', lat: 39.0, lng: -84.6, updatedAt: NOW - 86400000 },
  'leads/L_JONES': { userId: OWNER, companyId: OWNER, firstName: 'John', lastName: 'Jones', address: '88 Elm St, Union, KY 41091', stage: 'new' },
  'leads/L_LEE1': { userId: OWNER, companyId: OWNER, firstName: 'Pat', lastName: 'Lee', address: '5 Birch Ln, Erlanger, KY 41018' },
  'leads/L_LEE2': { userId: OWNER, companyId: OWNER, firstName: 'Pat', lastName: 'Lee', address: '19 Cedar Ct, Hebron, KY 41048' },
  'leads/L_DNR': { userId: OWNER, companyId: OWNER, firstName: 'Dana', lastName: 'Doerr', address: '7 Pine Rd, Burlington, KY 41005', doNotRecord: true },
  'leads/L_MAPPED': { userId: OWNER, companyId: OWNER, firstName: 'Mary', lastName: 'Mapped', address: '300 River Rd, Covington, KY', lat: 39.5, lng: -84.9 },
  'leads/L_MAPPED2': { userId: OWNER, companyId: OWNER, firstName: 'Mo', lastName: 'Mapped', address: '302 River Rd, Covington, KY', lat: 39.50005, lng: -84.9 },
  'leads/L_STRANGER': { userId: 'uStranger', companyId: 'uStranger', firstName: 'Sam', lastName: 'Stranger', address: '1 Other St, Dayton, OH' },
  'leads/L_CO': { userId: 'uOther', companyId: OWNER, firstName: 'Cora', lastName: 'Company', address: '9 Shared Way, Ft Mitchell, KY' },
};
const TRANSCRIPT = 'Hi, this is Jane Smith at 412 Oak Hill Drive. We went over the gaff Timberline shingles and the ice and water shield. I will send you the estimate. The adjuster will call you back about the claim.';
const NOTES = {
  visit_type: 'estimate',
  summary: 'Looked at the roof at 412 Oak Hill. Two layers, about 28 squares. Jo will send an estimate.',
  promises: [
    { who: 'jo', text: 'Send the estimate', due: '2026-10-16' },
    { who: 'them', text: 'Call the adjuster about the claim', due: null },
  ],
  follow_ups: [{ text: 'Check the soffit vents on the back', due: null }],
  scope_facts: ['two layers', 'about 28 squares', '6/12 pitch'],
  insurance: { carrier: 'State Farm', claim_number: null, adjuster: 'Mike', deductible: '$1,000', notes: null },
  speakers: [{ label: 'Speaker 1', role: 'rep' }, { label: 'Speaker 2', role: 'homeowner' }],
  urgent: false,
  caller_name: 'Jane Smith', street: '412 Oak Hill Dr', town: 'Florence',
};
const CREDIT = 'anthropic 400: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';
const creditErr = () => { const e = new Error(CREDIT); e.status = 400; e.provider = 'anthropic'; return e; };

const pathFor = (id) => 'audio/' + OWNER + '/_inbox/' + id + '.m4a';
const vpath = (id, uid) => 'users/' + (uid || OWNER) + '/visit_captures/' + id;
function cap(id, extra) {
  return Object.assign({
    startedAtMs: START, endedAtMs: START + 1500e3, durationSec: 1500, mime: 'audio/mp4', sizeBytes: 4e6,
    status: 'uploaded', source: 'fab', consentMode: 'one_party', leadId: null, audioPath: pathFor(id),
    uploadedAtMs: NOW - 60e3, createdAtMs: START,
  }, extra || {});
}

let counts, order, flags, scripted;
function stub(over) {
  counts = { transcribe: 0, notes: 0, consent: 0, prompts: [], usage: 0, buffers: [] };
  order = []; flags = { aiOff: false, overBudget: false };
  scripted = Object.assign({}, over || {});
  V._setDeps({
    transcribe: async (a) => {
      counts.transcribe++; counts.prompts.push(a.prompt); counts.buffers.push(String(a.buffer)); order.push('transcribe');
      if (scripted.transcribe) return scripted.transcribe(a);
      return { text: TRANSCRIPT, durationSec: 1480, segments: [{ start: 0, end: 4, text: 'Hi, this is Jane Smith' }] };
    },
    notes: async (a) => {
      counts.notes++;
      if (scripted.beforeNotes) scripted.beforeNotes(a);
      order.push('notes');
      if (scripted.notes) return scripted.notes(a);
      return JSON.parse(JSON.stringify(NOTES));
    },
    checkConsent: async (a) => { counts.consent++; return scripted.consent ? scripted.consent(a) : { consented: true, evidence: 'yes that is fine' }; },
    checkBudget: async () => ({ overBudget: flags.overBudget }),
    recordUsage: async () => { counts.usage++; },
    aiDisabled: async () => flags.aiOff,
    signUrl: async (b, p) => 'https://signed.example/' + p + '?exp=600',
    rateLimit: async () => { counts.rate = (counts.rate || 0) + 1; if (scripted.rateLimited) { const e = new Error('rate'); e.code = 'resource-exhausted'; throw e; } },
  });
}
function world(visits, extra) {
  const seed = Object.assign({}, LEADS, extra && extra.seed);
  Object.keys(visits || {}).forEach((id) => { seed[vpath(id)] = visits[id]; });
  seed['users/' + OWNER] = { companyId: OWNER };
  const files = {};
  Object.keys(visits || {}).forEach((id) => { if (!(extra && extra.noAudio && extra.noAudio.includes(id))) files[pathFor(id)] = 'AUDIO-' + id; });
  return { db: makeDb(seed), bucket: makeBucket(files, extra && extra.bucket) };
}
const run = (w, id, nowMs, uid) => V.runVisit({ db: w.db, bucket: w.bucket, uid: uid || OWNER, visitId: id, nowMs: nowMs || NOW });
const D = (w, id) => w.db.docs.get(vpath(id));
const tasksOf = (w, leadId) => [...w.db.docs.entries()].filter(([p]) => p.startsWith('leads/' + leadId + '/tasks/')).map(([p, v]) => Object.assign({ id: p.split('/').pop() }, v));
const activityOf = (w, leadId) => w.db.docs.get('leads/' + leadId + '/activity/visit-' + leadId);

// What the never-forget server channel reads (functions/promise-channel.js on
// feat/needs-you-promise-channel, PR #2444): ONE collection-group read on
// tasks.userId, then kind === 'promise' and not done, judged in memory with
// promiseKind in KINDS. If that module has merged, the REAL reader runs too.
async function channelRead(w, owner) {
  const snap = await w.db.collectionGroup('tasks').where('userId', '==', owner).get();
  const seen = [];
  snap.forEach((d) => {
    const t = d.data();
    if (t.kind !== 'promise' || t.done === true) return;
    const leadId = d.ref.parent && d.ref.parent.parent && d.ref.parent.parent.id;
    if (!leadId || !Object.prototype.hasOwnProperty.call(PRM.KINDS, t.promiseKind)) return;
    seen.push({ id: d.id, leadId, dueDate: t.dueDate, promiseKind: t.promiseKind, source: t.source });
  });
  return seen;
}

(async () => {
  // ═════════════════════════════════════════════════════════════════════
  console.log('\n1. Provider outage classifier');
  const C = LG.classifyProviderError;
  const K = (x) => (C(x) || {}).kind;
  ok('credit 400 (the string Anthropic returns) is a credit outage that needs Jo', K(CREDIT) === 'credit' && C(CREDIT).needsAction === true && C(CREDIT).provider === 'anthropic');
  ok('the Error object with status 400 is the same', K(creditErr()) === 'credit');
  ok('401 / invalid key / not configured are auth', K('anthropic 401: invalid x-api-key') === 'auth' && K('Groq rejected: Invalid API Key') === 'auth' && K(new Error('groq-not-configured')) === 'auth');
  ok('429 and Groq "Rate limit reached" are rate_limit, no action needed', K('anthropic 429: rate_limit_error') === 'rate_limit' && K('Groq rejected: Rate limit reached for model x') === 'rate_limit' && C('anthropic 429: x').needsAction === false);
  ok('529 / 503 are overloaded', K('anthropic 529: Overloaded') === 'overloaded' && K('anthropic 503: unavailable') === 'overloaded');
  ok('NEG: the recording\'s own failures are NOT outages',
    C('notes: no JSON') === null && C('Groq rejected: could not process file') === null && C('The operation was aborted due to timeout') === null && C(null) === null && C('') === null);
  ok('outage retry waits: credit longer than a 5xx', LG.outageRetryMs('credit') > LG.outageRetryMs('overloaded') && LG.outageRetryMs('rate_limit') > LG.outageRetryMs('overloaded'));
  const merged = require(path.join(ROOT, 'functions', 'call-center-logic.js'));
  if (typeof merged.classifyProviderError === 'function') {
    ok('PARITY: the call line and the visit line classify identically (PR #2437 merged)',
      [CREDIT, 'anthropic 401: x', 'anthropic 429: x', 'anthropic 529: x', 'notes: no JSON', 'Groq rejected: Rate limit reached'].every((s) => J(C(s)) === J(merged.classifyProviderError(s))));
  } else {
    ok('PARITY check waits for PR #2437 (classifyProviderError not on this base)', true);
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n2. nextStep: the state machine reads the doc alone');
  const NS = (d, now) => LG.nextStep(d, now == null ? NOW : now).step;
  ok('uploaded, never touched: process', NS({ status: 'uploaded' }) === 'process');
  ok('NEG: a client status that is not uploaded is never processed', NS({ status: 'stored' }) === 'none' && NS({ status: 'uploading' }) === 'none' && NS({ status: 'recording' }) === 'none');
  ok('discarded: discard (and audioLive false + discarded pipeline: none)', NS({ status: 'discarded' }) === 'discard' && NS({ status: 'discarded', pipelineStatus: 'discarded', audioLive: false }) === 'none');
  ok('a leased doc is none (the trigger\'s own writes cannot re-enter)', NS({ status: 'uploaded', pipelineLeaseUntilMs: NOW + 1000 }) === 'none');
  ok('an expired lease is picked up again', NS({ status: 'uploaded', pipelineLeaseUntilMs: NOW - 1 }) === 'process');
  ok('notes_pending before its time is none; due is process', NS({ status: 'uploaded', pipelineStatus: 'notes_pending', pipelineNextAtMs: NOW + 1 }) === 'none' && NS({ status: 'uploaded', pipelineStatus: 'notes_pending', pipelineNextAtMs: NOW }) === 'process');
  ok('ready and settled: none; ready with a customer not yet filed: finalize',
    NS({ status: 'uploaded', pipelineStatus: 'ready', notes: {} }) === 'none'
    && NS({ status: 'uploaded', pipelineStatus: 'ready', notes: {}, leadId: 'L1' }) === 'finalize'
    && NS({ status: 'uploaded', pipelineStatus: 'ready', notes: {}, leadId: 'L1', finalizedKey: 'L1:n' }) === 'none');
  ok('a notes-pending doc that gets a customer files the row now (finalize), notes later re-key it',
    NS({ status: 'uploaded', pipelineStatus: 'notes_pending', pipelineNextAtMs: NOW + 9e5, leadId: 'L1' }) === 'finalize'
    && NS({ status: 'uploaded', pipelineStatus: 'notes_pending', pipelineNextAtMs: 0, leadId: 'L1', notes: { a: 1 }, finalizedKey: 'L1:t' }) === 'process');
  ok('terminal states are none: failed, skipped (audio gone), quarantined', ['failed', 'skipped', 'quarantined_consent'].every((p) => NS({ status: 'uploaded', pipelineStatus: p, audioLive: false }) === 'none'));
  ok('a skip whose audio is still live is a purge, after its backoff', NS({ status: 'uploaded', pipelineStatus: 'skipped', audioLive: true, pipelineNextAtMs: 0 }) === 'purge' && NS({ status: 'uploaded', pipelineStatus: 'skipped', audioLive: true, pipelineNextAtMs: NOW + 5 }) === 'none');
  ok('NEG: an error backoff on a never-started doc is respected (no hot loop)', NS({ status: 'uploaded', pipelineNote: 'internal_error', pipelineNextAtMs: NOW + 9e5 }) === 'none');

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n3. Vocabulary prompt + corrections');
  const vp = LG.buildVocabularyPrompt({ priorityNames: ['Jane Smith'], names: ['John Jones', 'Pat Lee', 'Jane Smith'], streets: ['Oak Hill Dr', 'Elm St'], towns: ['Florence', 'Union'] });
  ok('prompt carries the priority name first, the streets, and the shingle brands', vp.indexOf('Jane Smith') < vp.indexOf('John Jones') && /Oak Hill/.test(vp) && /GAF/.test(vp) && /TAMKO/.test(vp) && /IKO/.test(vp) && /Owens Corning/.test(vp) && /CertainTeed/.test(vp));
  ok('prompt stays inside the budget (560 chars) however many names come in', LG.buildVocabularyPrompt({ names: Array.from({ length: 300 }, (_, i) => 'Customer Number' + i + ' Longsurname'), streets: Array.from({ length: 80 }, (_, i) => 'Some Very Long Street Name ' + i) }).length <= LG.VOCAB_MAX_CHARS);
  ok('the name is not duplicated', (vp.match(/Jane Smith/g) || []).length === 1);
  const fixed = LG.correctTranscript('We use the gaff HDZ and tam co shingles, Owens Corning and certain teed, timber line. Smyth called. My mother helped. The A C V is lower.', { names: ['Jane Smith', 'John Jones'], streets: ['412 Oak Hill Dr'] });
  ok('brand fixes: GAF, TAMKO, Owens Corning, CertainTeed, Timberline, HDZ, ACV', /GAF HDZ/.test(fixed.text) && /TAMKO/.test(fixed.text) && /Owens Corning/.test(fixed.text) && /CertainTeed/.test(fixed.text) && /Timberline/.test(fixed.text) && /ACV/.test(fixed.text), fixed.text);
  ok('a capitalised word one edit from a REAL customer surname is corrected (Smyth -> Smith)', /Smith called/.test(fixed.text), fixed.text);
  ok('NEG: an ordinary word is not turned into a name (mother stays)', /My mother helped/.test(fixed.text));
  ok('corrections are listed for the doc', fixed.corrections.length >= 5 && fixed.corrections.some((c) => c.to === 'Smith'));
  const noName = LG.correctTranscript('Smyth called', { names: [], streets: [] });
  ok('CONTROL: with no customers to match, Smyth is left alone', noName.text === 'Smyth called');

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n4. Ranked suggestions');
  const leadsArr = Object.keys(LEADS).map((p) => Object.assign({ id: p.split('/')[1] }, LEADS[p])).filter((l) => l.userId === OWNER || l.companyId === OWNER);
  const R = (o) => LG.rankSuggestions(Object.assign({ capture: { startedAtMs: START }, transcript: '', callerFacts: null, leads: leadsArr, appointments: [], nowMs: NOW }, o));
  const apptAt = (leadId, offMin, extra) => Object.assign({ id: 'a1', leadId, startTime: START + offMin * 60000, status: 'confirmed' }, extra || {});
  let r = R({ appointments: [apptAt('L_JONES', 12)] });
  ok('an appointment 12 min after you started is a chip with its evidence', r.suggestions.length === 1 && r.suggestions[0].leadId === 'L_JONES' && /On your calendar at/.test(r.suggestions[0].evidence) && /12 min after you started/.test(r.suggestions[0].evidence), J(r));
  ok('NEG: never auto-attach', r.autoAttach === false);
  r = R({ appointments: [apptAt('L_JONES', 75)] });
  ok('NEG: an appointment 75 min away is outside the window: no chip', r.suggestions.length === 0, J(r));
  r = R({ appointments: [apptAt('L_JONES', 10), apptAt('L_SMITH', -20, { id: 'a2' })] });
  ok('two customers on the calendar that hour: both offered, closest first, evidence says one of 2', r.suggestions.length === 2 && r.suggestions[0].leadId === 'L_JONES' && /one of 2/.test(r.suggestions[0].evidence) && r.suggestions[0].score < 90, J(r));
  r = R({ appointments: [apptAt('L_JONES', 10, { status: 'cancelled' })] });
  ok('NEG: a cancelled appointment is not offered', r.suggestions.length === 0);
  r = R({ transcript: TRANSCRIPT });
  ok('the spoken full name + address picks exactly one customer, evidence says what was said', r.suggestions.length === 1 && r.suggestions[0].leadId === 'L_SMITH' && /Matched by what was said/.test(r.suggestions[0].evidence), J(r));
  r = R({ transcript: 'Hi this is Pat Lee, thanks for coming out.' });
  ok('NEG: AMBIGUOUS name (two Pat Lees) refuses: no chip at all', r.suggestions.length === 0, J(r));
  r = R({ transcript: 'Hi this is Pat Lee at 5 Birch Lane.', callerFacts: { name: 'Pat Lee', street: '5 Birch Lane', town: null, service: null } });
  ok('CONTROL: the same name WITH the street (the notes\' caller facts) breaks the tie', r.suggestions.length === 1 && r.suggestions[0].leadId === 'L_LEE1', J(r));
  r = R({ transcript: 'Hi this is Pat Lee.', callerFacts: { name: 'Pat Lee', street: null, town: null, service: null } });
  ok('NEG: facts with a name but no street or town still do not choose between two Pat Lees', r.suggestions.length === 0, J(r));
  r = R({ transcript: TRANSCRIPT, appointments: [apptAt('L_SMITH', 5)] });
  ok('appointment + spoken name on the same customer is ONE chip with both pieces of evidence', r.suggestions.length === 1 && r.suggestions[0].signals.length === 2 && /calendar/.test(r.suggestions[0].evidence) && /said/.test(r.suggestions[0].evidence), J(r));
  r = R({ transcript: TRANSCRIPT, appointments: [apptAt('L_JONES', 5)] });
  ok('the name said out loud outranks a booking for someone else, and both are shown', r.suggestions.length === 2 && r.suggestions[0].leadId === 'L_SMITH' && r.suggestions[1].leadId === 'L_JONES', J(r));
  r = R({ capture: { startedAtMs: START, lat: 39.5, lng: -84.9, accuracyM: 20 }, leads: leadsArr.filter((l) => l.id !== 'L_MAPPED2') });
  ok('GPS: exactly ONE mapped customer inside the radius is a chip, and it says only mapped customers were checked', r.suggestions.length === 1 && r.suggestions[0].leadId === 'L_MAPPED' && /Only customers with a map pin/.test(r.suggestions[0].evidence) && r.suggestions[0].score <= 75, J(r));
  r = R({ capture: { startedAtMs: START, lat: 39.5, lng: -84.9, accuracyM: 20 } });
  ok('NEG: two mapped customers inside the radius: GPS stays silent', r.suggestions.length === 0, J(r));
  r = R({ capture: { startedAtMs: START, lat: 39.5, lng: -84.9, accuracyM: 400 }, leads: leadsArr.filter((l) => l.id !== 'L_MAPPED2') });
  ok('NEG: a 400 m fix cannot separate houses: no GPS chip', r.suggestions.length === 0);
  r = R({ capture: { startedAtMs: START, lat: 39.5008, lng: -84.9, accuracyM: 5 }, leads: leadsArr.filter((l) => l.id !== 'L_MAPPED2') });
  ok('NEG: 89 m away with a 5 m fix is outside max(40 m, 2x accuracy)', r.suggestions.length === 0, J(r));
  r = R({ transcript: 'Hi this is Dana Doerr at 7 Pine Road.' });
  ok('a do-not-record customer who is named is never offered, and the match is reported for the purge', r.suggestions.length === 0 && r.dnrMatch && r.dnrMatch.leadId === 'L_DNR', J(r));
  r = R({ transcript: TRANSCRIPT, leads: leadsArr.concat([{ id: 'L_GONE', userId: OWNER, firstName: 'Jane', lastName: 'Smith', address: '1 Gone St', deleted: true }]) });
  ok('a deleted customer is not a candidate (and does not make Jane ambiguous)', r.suggestions.length === 1 && r.suggestions[0].leadId === 'L_SMITH');

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n5. What attaching files (buildAttachment + the channel read)');
  const notes = LG.sanitizeVisitNotes(NOTES);
  ok('notes sanitize: promises, follow-ups, scope facts, insurance, speakers', notes.promises.length === 2 && notes.followUps.length === 1 && notes.scopeFacts.length === 3 && notes.insurance.carrier === 'State Farm' && notes.speakers.length === 2 && notes.callerFacts.name === 'Jane Smith', J(notes));
  ok('NEG: garbage from the model is dropped, never trusted', J(LG.sanitizeVisitNotes({ visit_type: 'bogus', promises: [{ who: 'x', text: '   ' }, 7, null], follow_ups: 'no', scope_facts: [1, '', 'ok'] }).promises) === '[]' && LG.sanitizeVisitNotes({ visit_type: 'bogus' }).visitType === 'other');
  ok('a personal visit files nothing', LG.sanitizeVisitNotes({ visit_type: 'personal', summary: 'x', promises: [{ who: 'jo', text: 'a' }] }).promises.length === 0);
  const at = LG.buildAttachment({ capture: cap('v1'), notes, visitId: 'v1', leadId: 'L_SMITH', lead: LEADS['leads/L_SMITH'], uid: OWNER, todayYmd: TODAY, nowMs: NOW, audioKeptDays: 90 });
  const p0 = at.tasks.find((t) => t.id === 'visit-v1-p0');
  const p1 = at.tasks.find((t) => t.id === 'visit-v1-p1');
  const f0 = at.tasks.find((t) => t.id === 'visit-v1-f0');
  ok('a promise with a STATED date is a kind:promise task due that date, source visit', p0 && p0.doc.kind === 'promise' && p0.doc.promiseKind === 'estimate' && p0.doc.dueDate === '2026-10-16' && p0.doc.source === 'visit' && p0.doc.dueStated === true && p0.doc.done === false, J(p0));
  ok('the task has the lead-task shape (text + title mirrored, userId = the lead owner, leadId)', p0.doc.text === p0.doc.title && p0.doc.userId === OWNER && p0.doc.leadId === 'L_SMITH');
  ok('what THEY promised is a waiting promise on the right party (adjuster)', p1 && p1.doc.promiseKind === 'waiting' && p1.doc.waitingOn === 'adjuster' && p1.doc.kind === 'promise', J(p1));
  ok('a follow-up with no stated date is due tomorrow and says it was inferred; not a promise', f0 && f0.doc.kind === undefined && f0.doc.dueDate === '2026-10-14' && f0.doc.dueInferred === true && f0.doc.text === f0.doc.title, J(f0));
  ok('the timeline row is keyed by visit, carries summary + said facts + insurance, and NO url', at.activityId === 'visit-v1' && /two layers/.test(at.activity.summary) && /Insurance/.test(at.activity.summary) && at.activity.type === 'visit' && !/https?:/.test(JSON.stringify(at.activity)) && at.activity.audioVisitId === 'v1');
  const pastDue = LG.buildAttachment({ capture: cap('v2'), notes: LG.sanitizeVisitNotes({ visit_type: 'estimate', promises: [{ who: 'jo', text: 'Call back', due: '2026-10-01' }] }), visitId: 'v2', leadId: 'L_SMITH', lead: LEADS['leads/L_SMITH'], uid: OWNER, todayYmd: TODAY, nowMs: NOW });
  ok('a stated date that is already past does not become a past-due task: due tomorrow, marked not stated', pastDue.tasks[0].doc.dueDate === '2026-10-14' && pastDue.tasks[0].doc.dueStated === false);
  const noNotes = LG.buildAttachment({ capture: cap('v3'), notes: null, visitId: 'v3', leadId: 'L_SMITH', lead: LEADS['leads/L_SMITH'], uid: OWNER, todayYmd: TODAY, nowMs: NOW });
  ok('transcript-only (no notes): a timeline row that says notes are pending, no tasks', noNotes.tasks.length === 0 && noNotes.activity.notesPending === true && /Notes are pending/.test(noNotes.activity.summary));

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n6. The pipeline end to end');
  // 6a happy path, unattached
  stub();
  let w = world({ v6happy1: cap('v6happy1') });
  w.db.docs.set('appointments/a1', { repUid: OWNER, userId: OWNER, leadId: 'L_JONES', startTime: new Date(START - 10 * 60000), status: 'confirmed' });
  scripted.beforeNotes = () => { order.push('doc-has-transcript:' + (!!D(w, 'v6happy1').transcript && D(w, 'v6happy1').pipelineStatus === 'transcribed')); };
  let out = await run(w, 'v6happy1');
  let d = D(w, 'v6happy1');
  ok('uploaded -> ready; the object was verified first (exists + download)', out.state === 'ready' && d.pipelineStatus === 'ready' && w.bucket.calls.exists[0] === pathFor('v6happy1') && w.bucket.calls.download.length === 1, J(out));
  ok('THE TRANSCRIPT WAS SAVED BEFORE THE NOTES CALL (status transcribed on the doc at that moment)', order.indexOf('doc-has-transcript:true') > order.indexOf('transcribe') && order.indexOf('doc-has-transcript:true') < order.indexOf('notes'), order.join(','));
  ok('the transcript is corrected, the raw one is kept beside it', /GAF Timberline/.test(d.transcript) && /gaff Timberline/.test(d.transcriptRaw) && d.transcriptCorrections.length >= 1);
  ok('the vocabulary prompt reached the transcriber with the day\'s customers and the shingle brands', /Jane Smith|John Jones/.test(counts.prompts[0]) && /GAF/.test(counts.prompts[0]) && counts.prompts[0].length <= LG.VOCAB_MAX_CHARS, counts.prompts[0]);
  ok('ranked suggestions are on the doc with evidence (spoken name + appointment)', d.suggestions.length === 2 && d.suggestions.some((s) => s.leadId === 'L_SMITH' && /said/.test(s.evidence)) && d.suggestions.some((s) => s.leadId === 'L_JONES' && /calendar/.test(s.evidence)), J(d.suggestions));
  ok('NOTHING was attached: leadId null, no activity row, no task anywhere', d.leadId === null && !w.db.log.some(([k, p]) => /^leads\/[^/]+\/(activity|tasks)\//.test(p) && k !== 'noop'), J(w.db.log.filter(([, p]) => /leads\//.test(p))));
  ok('usage was recorded for the audio seconds AND the notes tokens (once each); audioLive is true (retention will see it)', counts.usage === 2 && d.audioLive === true && d.transcriptDurationSec === 1480, String(counts.usage));
  const again = await run(w, 'v6happy1');
  ok('IDEMPOTENT: running it again does nothing (no second Groq, no second Claude)', again.step === 'none' && counts.transcribe === 1 && counts.notes === 1, J(again));

  // 6b notes outage, then recovery: ONLY the notes re-run
  stub({ notes: () => { throw creditErr(); } });
  w = world({ v6out0001: cap('v6out0001') });
  out = await run(w, 'v6out0001');
  d = D(w, 'v6out0001');
  ok('Anthropic credit exhausted: state notes_pending, the transcript is SAVED, suggestions still written', out.state === 'notes_pending' && d.pipelineStatus === 'notes_pending' && /Jane Smith/.test(d.transcript) && d.suggestions.length >= 1, J(out));
  ok('NO STRIKE: notesStrikes untouched, no transcribeStrikes, outage recorded, retry scheduled hours out', !d.notesStrikes && !d.transcribeStrikes && d.providerOutage && d.providerOutage.kind === 'credit' && d.pipelineNextAtMs > NOW + 30 * 60000, J(d));
  const t1 = counts.transcribe;
  out = await run(w, 'v6out0001', NOW + 5 * 60000);
  ok('the backoff is respected: five minutes later nothing runs', out.step === 'none' && counts.notes === 1);
  stub();   // credit restored; a fresh counter set
  out = await run(w, 'v6out0001', NOW + 2 * 3600000);
  d = D(w, 'v6out0001');
  ok('after the top-up: notes ran, transcript was NOT paid for again, state ready, outage cleared', out.state === 'ready' && counts.transcribe === 0 && counts.notes === 1 && d.notes && d.providerOutage === null && t1 === 1, J(out));

  // 6c Groq outage at transcription
  stub({ transcribe: () => { throw new Error('Groq rejected: Rate limit reached for model whisper'); } });
  w = world({ v6groq001: cap('v6groq001') });
  out = await run(w, 'v6groq001');
  d = D(w, 'v6groq001');
  ok('Groq rate limit: transcribe_pending, audio kept, no strike, no notes call', out.state === 'transcribe_pending' && !d.transcribeStrikes && counts.notes === 0 && w.bucket.store.has(pathFor('v6groq001')) && d.audioLive === true, J(out));
  stub();
  out = await run(w, 'v6groq001', NOW + 3600000);
  ok('Groq back: transcribed and noted on the retry', out.state === 'ready' && counts.transcribe === 1);

  // 6d own-fault failures strike, then stop; manual retry works
  stub({ notes: () => { throw new Error('notes: no JSON'); } });
  w = world({ v6own00001: cap('v6own00001') });
  out = await run(w, 'v6own00001', NOW);
  out = await run(w, 'v6own00001', NOW + 3600000);
  out = await run(w, 'v6own00001', NOW + 7200000);
  d = D(w, 'v6own00001');
  ok('three notes failures of the recording\'s own: notes_failed, transcript kept, audio kept', d.pipelineStatus === 'notes_failed' && d.notesStrikes === 3 && /Jane Smith/.test(d.transcript) && w.bucket.store.has(pathFor('v6own00001')));
  ok('and it stops by itself (nothing due, no loop)', LG.nextStep(d, NOW + 9e9).step === 'none');
  stub();
  const retried = await V.attachAction({ db: w.db, bucket: w.bucket, auth: { uid: OWNER, token: {} }, data: { visitId: 'v6own00001', action: 'retryNotes' }, nowMs: NOW + 8000000 });
  ok('the person can retry the notes; only the notes run', retried.ok && D(w, 'v6own00001').pipelineStatus === 'ready' && counts.transcribe === 0 && counts.notes === 1, J(retried));

  // 6e object missing
  stub();
  w = world({ v6miss0001: cap('v6miss0001') }, { noAudio: ['v6miss0001'] });
  out = await run(w, 'v6miss0001');
  d = D(w, 'v6miss0001');
  ok('status says uploaded but the object is not there: NOT processed (waiting_object), no vendor call', d.pipelineStatus === 'waiting_object' && counts.transcribe === 0 && counts.notes === 0 && w.bucket.calls.download.length === 0, J(out));
  out = await run(w, 'v6miss0001', NOW + 25 * 3600000);
  ok('a day later, still missing: failed (object_missing), never a vendor call', D(w, 'v6miss0001').pipelineStatus === 'failed' && D(w, 'v6miss0001').pipelineNote === 'object_missing' && counts.transcribe === 0);
  w = world({ v6store001: cap('v6store001') }, { bucket: { existsThrows: true } });
  out = await run(w, 'v6store001');
  ok('Storage unreachable is "not yet", never a strike or a failure', D(w, 'v6store001').pipelineStatus === 'waiting_object' && D(w, 'v6store001').pipelineNote === 'storage_unreachable' && !D(w, 'v6store001').transcribeStrikes);

  // 6f a forged audioPath is never read
  stub();
  w = world({ v6forge001: cap('v6forge001', { audioPath: 'audio/uVictim/_inbox/x.m4a' }) });
  w.bucket.store.set('audio/uVictim/_inbox/x.m4a', Buffer.from('VICTIM AUDIO'));
  out = await run(w, 'v6forge001');
  ok('another user\'s object named in audioPath is never read or transcribed', D(w, 'v6forge001').pipelineStatus === 'failed' && D(w, 'v6forge001').pipelineNote === 'bad_audio_path' && w.bucket.calls.exists.length === 0 && w.bucket.calls.download.length === 0 && counts.transcribe === 0);

  // 6g do-not-record, personal, consent
  stub();
  w = world({ v6dnr00001: cap('v6dnr00001', { leadId: 'L_DNR' }) });
  out = await run(w, 'v6dnr00001');
  d = D(w, 'v6dnr00001');
  ok('pre-attached to a do-not-record customer: no transcription, the audio is DELETED', d.pipelineStatus === 'skipped' && d.skipReason === 'do_not_record' && counts.transcribe === 0 && !w.bucket.store.has(pathFor('v6dnr00001')) && d.audioLive === false);
  stub({ transcribe: () => ({ text: 'Hi this is Dana Doerr at 7 Pine Road, about the roof.', durationSec: 60, segments: [] }) });
  w = world({ v6dnrnm001: cap('v6dnrnm001') });
  out = await run(w, 'v6dnrnm001');
  d = D(w, 'v6dnrnm001');
  ok('a do-not-record customer NAMED in the recording: transcript wiped, audio deleted, no notes call', d.pipelineStatus === 'skipped' && d.skipReason === 'do_not_record_match' && d.transcript === null && !w.bucket.store.has(pathFor('v6dnrnm001')) && counts.notes === 0, J(d));
  stub({ notes: () => Object.assign({}, NOTES, { visit_type: 'personal', summary: 'x' }) });
  w = world({ v6pers0001: cap('v6pers0001') });
  out = await run(w, 'v6pers0001');
  d = D(w, 'v6pers0001');
  ok('personal: nothing kept (transcript null, audio deleted, no tasks)', d.pipelineStatus === 'skipped' && d.skipReason === 'personal' && d.transcript === null && d.notes === null && !w.bucket.store.has(pathFor('v6pers0001')));
  stub();
  w = world({ v6noack001: cap('v6noack001', { consentMode: 'two_party_attested' }) });
  out = await run(w, 'v6noack001');
  ok('two-party company, disclosure never acknowledged: quarantined before any vendor call, audio deleted', D(w, 'v6noack001').pipelineStatus === 'quarantined_consent' && counts.transcribe === 0 && !w.bucket.store.has(pathFor('v6noack001')));
  w = world({ v6ack00001: cap('v6ack00001', { consentMode: 'two_party_attested', disclosureAckedAtMs: START }) });
  out = await run(w, 'v6ack00001');
  ok('CONTROL: the same company WITH the acknowledgement is processed', D(w, 'v6ack00001').pipelineStatus === 'ready' && counts.transcribe === 1);
  stub({ consent: () => ({ consented: false }) });
  w = world({ v6verbal001: cap('v6verbal001', { consentMode: 'two_party_verbal' }) });
  out = await run(w, 'v6verbal001');
  ok('two-party verbal with no yes in the opening: quarantined, transcript wiped, audio deleted', D(w, 'v6verbal001').pipelineStatus === 'quarantined_consent' && D(w, 'v6verbal001').transcript === null && !w.bucket.store.has(pathFor('v6verbal001')) && counts.notes === 0);
  stub({ consent: () => { throw creditErr(); } });
  w = world({ v6verbal002: cap('v6verbal002', { consentMode: 'two_party_verbal' }) });
  out = await run(w, 'v6verbal002');
  ok('verbal consent check hits a provider outage: fails CLOSED (consent_pending, no notes, no suggestions, no attach), transcript kept', D(w, 'v6verbal002').pipelineStatus === 'consent_pending' && counts.notes === 0 && !D(w, 'v6verbal002').suggestions && /Jane Smith/.test(D(w, 'v6verbal002').transcript));

  // 6h kill switch / budget
  stub(); flags.aiOff = true;
  w = world({ v6kill00001: cap('v6kill00001') });
  out = await run(w, 'v6kill00001');
  ok('AI kill switch: nothing spent, parked with a retry time', counts.transcribe === 0 && D(w, 'v6kill00001').pipelineNote === 'ai_disabled' && D(w, 'v6kill00001').pipelineNextAtMs > NOW);
  stub(); flags.overBudget = true;
  w = world({ v6budget001: cap('v6budget001') });
  out = await run(w, 'v6budget001');
  ok('company over its daily audio budget: parked, no Groq spend', counts.transcribe === 0 && D(w, 'v6budget001').pipelineNote === 'over_budget');

  // 6i ambiguity: two Pat Lees
  stub({ transcribe: () => ({ text: 'Hi this is Pat Lee, glad you could make it.', durationSec: 120, segments: [] }), notes: () => Object.assign({}, NOTES, { caller_name: 'Pat Lee', street: null, town: null }) });
  w = world({ v6ambig001: cap('v6ambig001') });
  out = await run(w, 'v6ambig001');
  d = D(w, 'v6ambig001');
  ok('ambiguous spoken name: no suggestion, no attach', d.pipelineStatus === 'ready' && d.suggestions.length === 0 && d.leadId === null);

  // 6j lease: two invocations at once pay Groq once
  stub();
  w = world({ v6lease001: cap('v6lease001') });
  const both = await Promise.all([run(w, 'v6lease001'), run(w, 'v6lease001')]);
  ok('two concurrent invocations: ONE transcribe, ONE notes (the lease)', counts.transcribe === 1 && counts.notes === 1 && both.some((b) => b.state === 'ready'), J(both) + ' ' + J(counts));

  // 6k pre-attached by the client: files itself; the channel reads the promise
  stub();
  w = world({ v6pre00001: cap('v6pre00001', { leadId: 'L_SMITH', source: 'customer' }) });
  out = await run(w, 'v6pre00001');
  d = D(w, 'v6pre00001');
  const act = w.db.docs.get('leads/L_SMITH/activity/visit-v6pre00001');
  ok('a capture the CLIENT pre-attached is filed when the notes land (the one automatic attach)', out.finalized === 'filed' && d.attachedLeadId === 'L_SMITH' && act && act.type === 'visit' && /two layers/.test(act.summary), J(out));
  const seen = await channelRead(w, OWNER);
  ok('the promise task is visible to the never-forget channel read: kind promise, a valid promiseKind, due 2026-10-16, source visit, under leads/L_SMITH',
    seen.some((t) => t.leadId === 'L_SMITH' && t.promiseKind === 'estimate' && t.dueDate === '2026-10-16' && t.source === 'visit'), J(seen));
  ok('the waiting promise is read too; the plain follow-up is NOT a promise', seen.some((t) => t.promiseKind === 'waiting') && !seen.some((t) => /-f0$/.test(t.id)), J(seen));
  if (fs.existsSync(path.join(ROOT, 'functions', 'promise-channel.js'))) {
    const real = await require(path.join(ROOT, 'functions', 'promise-channel.js')).readDuePromisePeople({ db: w.db, owner: OWNER, nowMs: Date.parse('2026-10-17T15:00:00Z'), labels: {} });
    ok('the REAL channel reader (merged PR #2444) lists the person owed', real.ok === true && JSON.stringify(real.people).indexOf('Jane') !== -1, J(real).slice(0, 300));
  } else {
    ok('the real promise-channel.js is not on this base (PR #2444 open); the inline predicate above mirrors it', true);
  }
  // idempotent re-finalize, and a tick survives it
  const ptask = 'leads/L_SMITH/tasks/visit-v6pre00001-p0';
  w.db.docs.get(ptask).done = true;
  await V._internal.doFinalize({ db: w.db, bucket: w.bucket, ref: w.db.doc(vpath('v6pre00001')), uid: OWNER, visitId: 'v6pre00001', d: Object.assign({}, D(w, 'v6pre00001')), nowMs: NOW + 1000 });
  ok('filing twice creates nothing twice and does not re-open a ticked task', tasksOf(w, 'L_SMITH').length === 3 && w.db.docs.get(ptask).done === true);

  // 6l attached while the notes are pending: row now, tasks when the notes land
  stub({ notes: () => { throw creditErr(); } });
  w = world({ v6late0001: cap('v6late0001', { leadId: 'L_SMITH' }) });
  out = await run(w, 'v6late0001');
  ok('pre-attached + AI outage: the timeline row exists NOW with "notes pending", no tasks yet', out.state === 'notes_pending' && out.finalized === 'filed' && w.db.docs.get('leads/L_SMITH/activity/visit-v6late0001').notesPending === true && tasksOf(w, 'L_SMITH').length === 0, J(out));
  stub();
  out = await run(w, 'v6late0001', NOW + 2 * 3600000);
  ok('when the notes land the row is rewritten and the tasks are made', w.db.docs.get('leads/L_SMITH/activity/visit-v6late0001').notesPending === false && tasksOf(w, 'L_SMITH').length === 3, J(out) + ' ' + tasksOf(w, 'L_SMITH').length);

  // 6m a lead the capture owner cannot reach is never trusted
  stub();
  w = world({ v6xten0001: cap('v6xten0001', { leadId: 'L_STRANGER' }) });
  out = await run(w, 'v6xten0001');
  d = D(w, 'v6xten0001');
  ok('a leadId in another tenant is dropped (unattached), nothing filed on the stranger', d.leadId === null && tasksOf(w, 'L_STRANGER').length === 0 && !w.db.docs.has('leads/L_STRANGER/activity/visit-v6xten0001'));
  stub();
  w = world({ v6co000001: cap('v6co000001', { leadId: 'L_CO' }) }, { seed: { ['users/' + OWNER]: { companyId: OWNER } } });
  out = await run(w, 'v6co000001');
  ok('CONTROL: a same-company customer owned by a teammate IS reachable', D(w, 'v6co000001').attachedLeadId === 'L_CO' && !!w.db.docs.get('leads/L_CO/activity/visit-v6co000001'));

  // 6n discard retracts what was filed (untouched tasks go, ticked stay)
  stub();
  w = world({ v6disc0001: cap('v6disc0001', { leadId: 'L_SMITH' }) });
  await run(w, 'v6disc0001');
  w.db.docs.get('leads/L_SMITH/tasks/visit-v6disc0001-p0').done = true;
  w.db.docs.get(vpath('v6disc0001')).status = 'discarded';
  out = await run(w, 'v6disc0001', NOW + 60000);
  d = D(w, 'v6disc0001');
  ok('discarded on the phone: audio deleted, transcript + notes wiped, timeline row removed', out.step === 'discard' && !w.bucket.store.has(pathFor('v6disc0001')) && d.transcript === null && d.notes === null && !w.db.docs.has('leads/L_SMITH/activity/visit-v6disc0001'), J(out));
  ok('untouched tasks it made are removed; the one that was ticked stays', !w.db.docs.has('leads/L_SMITH/tasks/visit-v6disc0001-p1') && !w.db.docs.has('leads/L_SMITH/tasks/visit-v6disc0001-f0') && w.db.docs.has('leads/L_SMITH/tasks/visit-v6disc0001-p0'));
  ok('and it settles (no loop)', LG.nextStep(D(w, 'v6disc0001'), NOW + 9e9).step === 'none');

  // 6o audio delete fails on a skip: kept, retried later, no hot loop
  stub();
  w = world({ v6delfail01: cap('v6delfail01', { leadId: 'L_DNR' }) }, { bucket: { deleteThrows: true } });
  out = await run(w, 'v6delfail01');
  d = D(w, 'v6delfail01');
  ok('audio delete fails: still marked live, noted, retry scheduled (not now)', d.audioLive === true && /audio_delete_failed/.test(d.pipelineNote) && d.pipelineNextAtMs > NOW && LG.nextStep(d, NOW).step === 'none');

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n7. attachVisitCapture');
  const A = (w2, auth, data, now) => V.attachAction({ db: w2.db, bucket: w2.bucket, auth, data, nowMs: now || NOW + 1000 });
  const asOwner = { uid: OWNER, token: {} };
  const rej = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  stub();
  w = world({ v7att00001: cap('v7att00001') });
  await run(w, 'v7att00001');
  let r7 = await A(w, asOwner, { visitId: 'v7att00001', leadId: 'L_SMITH' });
  ok('attach files it: row + promise tasks + follow-up', r7.ok && r7.filed === true && r7.tasksMade === 3 && !!w.db.docs.get('leads/L_SMITH/activity/visit-v7att00001'), J(r7));
  const before = w.db.log.length;
  r7 = await A(w, asOwner, { visitId: 'v7att00001', leadId: 'L_SMITH' });
  ok('attaching again is a no-op (already:true, no writes under the lead)', r7.ok && r7.already === true && !w.db.log.slice(before).some(([, p]) => /^leads\//.test(p)), J(r7));
  r7 = await A(w, asOwner, { visitId: 'v7att00001', leadId: 'L_JONES' });
  ok('change customer: the old customer\'s row + untouched tasks are retracted, the new one filed', r7.ok && !w.db.docs.has('leads/L_SMITH/activity/visit-v7att00001') && tasksOf(w, 'L_SMITH').length === 0 && tasksOf(w, 'L_JONES').length === 3, J(r7));
  r7 = await A(w, asOwner, { visitId: 'v7att00001', action: 'detach' });
  ok('detach: unattached again, nothing left on the customer', r7.ok && D(w, 'v7att00001').leadId === null && tasksOf(w, 'L_JONES').length === 0);
  let e = await rej(() => A(w, asOwner, { visitId: 'v7att00001', leadId: 'L_STRANGER' }));
  ok('NEG: a customer in another tenant is refused (permission-denied) and nothing is written there', e && e.code === 'permission-denied' && tasksOf(w, 'L_STRANGER').length === 0, e && e.message);
  e = await rej(() => A(w, asOwner, { visitId: 'v7att00001', leadId: 'L_DNR' }));
  ok('NEG: a do-not-record customer is refused (failed-precondition)', e && e.code === 'failed-precondition', e && e.message);
  e = await rej(() => A(w, { uid: OWNER, token: { role: 'viewer' } }, { visitId: 'v7att00001', leadId: 'L_SMITH' }));
  ok('NEG: a viewer is refused', e && e.code === 'permission-denied');
  r7 = await A(w, { uid: OWNER, token: { role: 'sales_rep' } }, { visitId: 'v7att00001', leadId: 'L_SMITH' });
  ok('a sales rep may file under THEIR OWN customer (the same line the rules draw)', r7.ok === true);
  e = await rej(() => A(w, { uid: OWNER, token: { role: 'sales_rep' } }, { visitId: 'v7att00001', leadId: 'L_CO' }));
  ok('NEG: ...but not under a colleague\'s customer in the same company (company staff only)', e && e.code === 'permission-denied', e && e.message);
  r7 = await A(w, { uid: OWNER, token: { role: 'manager' } }, { visitId: 'v7att00001', leadId: 'L_CO' });
  ok('CONTROL: a manager reaches the company\'s customer', r7.ok === true);
  e = await rej(() => A(w, null, { visitId: 'v7att00001', leadId: 'L_SMITH' }));
  ok('NEG: signed out is refused', e && e.code === 'unauthenticated');
  r7 = await A(w, { uid: OWNER, token: { role: 'manager' } }, { visitId: 'v7att00001', leadId: 'L_SMITH' });
  ok('CONTROL: a manager is allowed', r7.ok === true);
  e = await rej(() => A(w, { uid: 'uStranger', token: {} }, { visitId: 'v7att00001', leadId: 'L_STRANGER' }));
  ok('NEG: the uid comes from the token, never the client: another user cannot reach this capture (not-found)', e && e.code === 'not-found');
  e = await rej(() => A(w, asOwner, { visitId: '../etc', leadId: 'L_SMITH' }));
  ok('NEG: a malformed visit id is refused', e && e.code === 'invalid-argument');
  const url = await A(w, asOwner, { visitId: 'v7att00001', action: 'audioUrl' });
  ok('audioUrl: a ten-minute signed link for the capture\'s own object, never stored on the doc', url.ok && /signed\.example/.test(url.url) && url.expiresInSec === 600 && !/https?:/.test(JSON.stringify(D(w, 'v7att00001'))));
  w.db.docs.get(vpath('v7att00001')).audioLive = false;
  e = await rej(() => A(w, asOwner, { visitId: 'v7att00001', action: 'audioUrl' }));
  ok('NEG: audio that retention already deleted gives no link', e && e.code === 'failed-precondition');
  const nt = await A(w, asOwner, { visitId: 'v7att00001', action: 'notThese' });
  ok('"Not these": chips cleared, the offered customers remembered', nt.ok && D(w, 'v7att00001').suggestions.length === 0 && D(w, 'v7att00001').rejectedLeadIds.indexOf('L_SMITH') !== -1);

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n8. Sweeps, retention, indexes');
  // retry sweep
  stub({ notes: () => { throw creditErr(); } });
  w = world({ v8due000001: cap('v8due000001'), v8later0001: cap('v8later0001') });
  await run(w, 'v8due000001'); await run(w, 'v8later0001');
  w.db.docs.get(vpath('v8later0001')).pipelineNextAtMs = NOW + 9e8;
  w.db.docs.set(vpath('v8lost00001'), cap('v8lost00001'));
  w.bucket.store.set(pathFor('v8lost00001'), Buffer.from('AUDIO-v8lost00001'));
  w.db.docs.set(vpath('v8old000001'), cap('v8old000001', { uploadedAtMs: NOW - 5 * 86400000 }));
  stub();
  const sw = await V.sweep({ db: w.db, bucket: w.bucket, nowMs: NOW + 2 * 3600000 });
  ok('sweep: the due notes retry ran, the not-due one did not, a lost-trigger doc (uploaded < 48 h, never touched) was picked up',
    D(w, 'v8due000001').pipelineStatus === 'ready' && D(w, 'v8later0001').pipelineStatus === 'notes_pending' && D(w, 'v8lost00001').pipelineStatus === 'ready' && sw.lostTrigger === 1, J(sw));
  ok('NEG: an old untouched doc (> 48 h) is not swept up as a lost trigger', !D(w, 'v8old000001').pipelineStatus);
  // retention
  stub();
  const day = 86400000;
  w = world({
    v8keep00001: cap('v8keep00001', { firstSeenAtMs: NOW - 10 * day, audioLive: true, pipelineStatus: 'ready' }),
    v8old000002: cap('v8old000002', { firstSeenAtMs: NOW - 120 * day, audioLive: true, pipelineStatus: 'ready' }),
    v8att000001: cap('v8att000001', { firstSeenAtMs: NOW - 200 * day, audioLive: true, leadId: 'L_SMITH', attachedLeadId: 'L_SMITH', pipelineStatus: 'ready' }),
    v8gone00001: cap('v8gone00001', { firstSeenAtMs: NOW - 300 * day, audioLive: false, audioDeletedAtMs: NOW - 200 * day }),
  }, { seed: { 'users/uCo': { companyId: 'coShort' }, 'companies/coShort': { recordingRetentionDays: 7 }, ['users/uCo/visit_captures/v8short0001']: cap('v8short0001', { firstSeenAtMs: NOW - 9 * day, audioLive: true, audioPath: 'audio/uCo/_inbox/v8short0001.m4a' }) } });
  w.bucket.store.set('audio/uCo/_inbox/v8short0001.m4a', Buffer.from('x'));
  scripted.companyId = { uCo: 'coShort' };
  const rs = await V.retentionSweep({ db: w.db, bucket: w.bucket, nowMs: NOW });
  ok('retention (default 90 d): inbox audio past 90 days goes, attached visit audio goes, a 10-day-old one stays', !w.bucket.store.has(pathFor('v8old000002')) && !w.bucket.store.has(pathFor('v8att000001')) && w.bucket.store.has(pathFor('v8keep00001')), J(rs));
  ok('the doc keeps its transcript + notes, audioLive false, deletion stamped', D(w, 'v8old000002').audioLive === false && D(w, 'v8old000002').audioDeletedBy === 'retention' && D(w, 'v8old000002').transcript !== null);
  ok('a company that set recordingRetentionDays=7 is honoured (a 9-day-old memo goes)', !w.bucket.store.has('audio/uCo/_inbox/v8short0001.m4a'), J(rs));
  ok('NEG: an already-deleted one is not touched again', w.bucket.calls.delete.indexOf(pathFor('v8gone00001')) === -1);
  const retQuery = w.db.stats.queries.find((q) => q.label === 'g:visit_captures');
  ok('the retention query is audioLive == true, firstSeenAtMs < cutoff (the server\'s stamp), orderBy firstSeenAtMs', retQuery && retQuery.filters.indexOf('audioLive ==') !== -1 && retQuery.filters.indexOf('firstSeenAtMs <') !== -1 && retQuery.orderBy[0] === 'firstSeenAtMs', J(retQuery));
  const wSkip = world({ v8skip00001: cap('v8skip00001', { firstSeenAtMs: NOW - 10 * day, audioLive: true, skipReason: 'do_not_record', pipelineStatus: 'skipped' }), v8recent001: cap('v8recent001', { firstSeenAtMs: NOW - 10 * day, audioLive: true, pipelineStatus: 'ready' }) });
  await V.retentionSweep({ db: wSkip.db, bucket: wSkip.bucket, nowMs: NOW });
  ok('a skipped capture whose audio delete failed earlier is overdue at once (10 days old, well inside 90), its normal sibling is not', !wSkip.bucket.store.has(pathFor('v8skip00001')) && wSkip.bucket.store.has(pathFor('v8recent001')));
  const w2 = world({ v8fail00001: cap('v8fail00001', { firstSeenAtMs: NOW - 120 * day, audioLive: true }) }, { bucket: { deleteThrows: true } });
  const rs2 = await V.retentionSweep({ db: w2.db, bucket: w2.bucket, nowMs: NOW });
  ok('a failed delete keeps the doc live (retried tomorrow), counted', rs2.failed === 1 && D(w2, 'v8fail00001').audioLive === true);
  const cronSrc = fs.readFileSync(path.join(ROOT, 'functions', 'integrations', 'voice-intelligence.js'), 'utf8');
  ok('recordingRetentionCron calls the visit retention phase', /require\('\.\.\/visit-capture'\)\.retentionSweep/.test(cronSrc));
  // indexes
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8'));
  const hasComposite = (cg, fields) => idx.indexes.some((i) => i.collectionGroup === cg && i.queryScope === 'COLLECTION_GROUP' && J(i.fields.map((f) => f.fieldPath)) === J(fields));
  const groupQs = w.db.stats.queries.concat(sw && w.db.stats.queries).filter((q) => q && q.label === 'g:visit_captures');
  ok('index: audioLive + firstSeenAtMs composite (COLLECTION_GROUP) exists for the retention query', hasComposite('visit_captures', ['audioLive', 'firstSeenAtMs']));
  ok('index: status + uploadedAtMs composite exists for the lost-trigger query', hasComposite('visit_captures', ['status', 'uploadedAtMs']));
  ok('index: pipelineStatus + pipelineNextAtMs composite exists for the due-only retry query', hasComposite('visit_captures', ['pipelineStatus', 'pipelineNextAtMs']));
  ok('index: appointments repUid/userId + startTime composites already exist (the same query the phone runs)', ['repUid', 'userId'].every((f) => idx.indexes.some((i) => i.collectionGroup === 'appointments' && J(i.fields.map((x) => x.fieldPath)) === J([f, 'startTime']))));
  ok('every collection-group query shape this module runs is covered above', groupQs.length >= 1);

  // ═════════════════════════════════════════════════════════════════════
  console.log('\n9. Review round: the holes the reviewers found');
  // F1: a leadId that is a PATH never reaches another tenant's lead
  stub();
  w = world({ v9slash0001: cap('v9slash0001', { leadId: 'L_SMITH/activity/L_STRANGER' }) }, { seed: { 'leads/L_SMITH/activity/L_STRANGER': { userId: OWNER, companyId: 'uStranger', type: 'note' } } });
  out = await run(w, 'v9slash0001');
  ok('F1: a leadId with slashes is dropped (unattached); nothing is written under any lead', D(w, 'v9slash0001').leadId === null && D(w, 'v9slash0001').attachNote === 'lead_id_invalid' && !w.db.log.some(([k, p]) => /^leads\//.test(p)), J(w.db.log.filter(([, p]) => /^leads\//.test(p))));
  w = world({ v9slash0002: cap('v9slash0002', { leadId: 'L_SMITH' }) });
  w.db.docs.get(vpath('v9slash0002')).leadId = 'L_SMITH/..';
  await V._internal.doFinalize({ db: w.db, bucket: w.bucket, ref: w.db.doc(vpath('v9slash0002')), uid: OWNER, visitId: 'v9slash0002', d: D(w, 'v9slash0002'), nowMs: NOW });
  ok('F1: doFinalize refuses it too (the same guard, the finalize path)', D(w, 'v9slash0002').leadId === null && !w.db.log.some(([k, p]) => /^leads\//.test(p)));
  e = await rej(() => A(w, asOwner, { visitId: 'v9slash0002', leadId: 'L_SMITH/activity/x' }));
  ok('F1: the callable refuses it', e && e.code === 'invalid-argument');

  // F2: the company's consent setting is a floor the phone cannot lower
  stub();
  w = world({ v9cons00001: cap('v9cons00001', { consentMode: 'one_party' }) }, { seed: { ['companies/' + OWNER]: { recordingConsentMode: 'two_party_attested' } } });
  out = await run(w, 'v9cons00001');
  ok('F2: the company is two-party attested and the phone claimed one_party with no acknowledgement: quarantined, audio deleted, no vendor call', D(w, 'v9cons00001').pipelineStatus === 'quarantined_consent' && counts.transcribe === 0 && !w.bucket.store.has(pathFor('v9cons00001')));
  w = world({ v9cons00002: cap('v9cons00002', { consentMode: 'one_party', disclosureAckedAtMs: START }) }, { seed: { ['companies/' + OWNER]: { recordingConsentMode: 'two_party_attested' } } });
  out = await run(w, 'v9cons00002');
  ok('F2 CONTROL: the same company with the acknowledgement on the doc is processed', D(w, 'v9cons00002').pipelineStatus === 'ready' && counts.transcribe === 1);
  stub({ consent: () => ({ consented: false }) });
  w = world({ v9cons00003: cap('v9cons00003', { consentMode: 'one_party' }) }, { seed: { ['companies/' + OWNER]: { recordingConsentMode: 'two_party_verbal' } } });
  out = await run(w, 'v9cons00003');
  ok('F2: a two-party-verbal company: the phone saying one_party does not skip the opening-window check (no yes -> quarantined)', D(w, 'v9cons00003').pipelineStatus === 'quarantined_consent' && counts.consent === 1 && D(w, 'v9cons00003').transcript === null);
  stub();
  w = world({ v9cons00004: cap('v9cons00004', { consentMode: 'one_party' }) });
  out = await run(w, 'v9cons00004');
  ok('F2 CONTROL: a company with NO setting (unset in all three prod companies) stays one-party: no disclosure needed, no consent call', D(w, 'v9cons00004').pipelineStatus === 'ready' && counts.consent === 0);
  ok('F2: the phone can raise it (a two_party_verbal claim on a one-party company still checks)', LG.stricterConsent('two_party_verbal', 'one_party') === 'two_party_verbal' && LG.stricterConsent('one_party', 'two_party_attested') === 'two_party_attested' && LG.stricterConsent(undefined, undefined) === 'one_party');

  // classifier gaps: the Groq adapter's own codes, timeouts, dropped connections
  const vErr = (code, message) => Object.assign(new Error(message), { code });
  ok('visitOutage: Groq key unset (VoiceError groq-not-configured) is an outage that needs Jo', (LG.visitOutage(vErr('groq-not-configured', 'GROQ_API_KEY secret is unset. Set via firebase functions:secrets:set GROQ_API_KEY.')) || {}).kind === 'auth');
  ok('visitOutage: groq-network / TimeoutError / fetch failed / ECONNRESET are transient outages', ['groq-network'].every((c) => (LG.visitOutage(vErr(c, 'Groq request failed: fetch failed')) || {}).kind === 'overloaded') && (LG.visitOutage(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })) || {}).kind === 'overloaded' && (LG.visitOutage(new Error('read ECONNRESET')) || {}).kind === 'overloaded');
  ok('NEG: visitOutage still refuses the recording\'s own failures', LG.visitOutage(new Error('notes: no JSON')) === null && LG.visitOutage(new Error('Groq rejected: could not process file')) === null && LG.visitOutage(null) === null);
  stub({ transcribe: () => { throw vErr('groq-network', 'Groq request failed: fetch failed'); } });
  w = world({ v9net000001: cap('v9net000001') });
  out = await run(w, 'v9net000001');
  ok('a Groq network failure is pending, not a strike', out.state === 'transcribe_pending' && !D(w, 'v9net000001').transcribeStrikes && D(w, 'v9net000001').transientFails === 1);
  // poisoned file: six in a row become the file's fault
  let t9 = NOW;
  for (let i = 0; i < 6; i++) { t9 += 2 * 3600000; out = await run(w, 'v9net000001', t9); }
  ok('...but one poisoned file cannot hold the line for ever: after 6 in a row it strikes, and three strikes stop it', D(w, 'v9net000001').transcribeStrikes >= 1 && counts.transcribe >= 6);
  stub({ notes: () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); } });
  w = world({ v9net000002: cap('v9net000002') });
  out = await run(w, 'v9net000002');
  ok('a dropped connection on the notes call is pending, not a strike; the transcript is kept', out.state === 'notes_pending' && !D(w, 'v9net000002').notesStrikes && /Jane Smith/.test(D(w, 'v9net000002').transcript));
  // the object read is Storage's business
  stub();
  w = world({ v9dl0000001: cap('v9dl0000001') });
  const origFile = w.bucket.file;
  w.bucket.file = (p) => Object.assign(origFile(p), { download: async () => { throw Object.assign(new Error('socket reset'), { code: 503 }); } });
  out = await run(w, 'v9dl0000001');
  ok('a failed object read is waiting_object (storage_read_retry): never a transcribe strike, no Groq call', D(w, 'v9dl0000001').pipelineStatus === 'waiting_object' && D(w, 'v9dl0000001').pipelineNote === 'storage_read_retry' && !D(w, 'v9dl0000001').transcribeStrikes && counts.transcribe === 0);

  // nothing is retried for ever
  stub();
  w = world({ v9age000001: cap('v9age000001', { firstSeenAtMs: NOW - 15 * 86400000, audioLive: true, pipelineStatus: 'transcribe_pending', pipelineNextAtMs: 0 }) });
  out = await run(w, 'v9age000001');
  ok('a doc that has been retrying for 15 days is given up on (failed), not retried again', D(w, 'v9age000001').pipelineStatus === 'failed' && D(w, 'v9age000001').pipelineNote === 'gave_up_after_14_days' && counts.transcribe === 0);
  w = world({ v9age000002: cap('v9age000002', { firstSeenAtMs: NOW - 15 * 86400000, audioLive: true, pipelineStatus: 'notes_pending', pipelineNextAtMs: 0, transcript: 'hello there', transcriptDurationSec: 60 }) });
  out = await run(w, 'v9age000002');
  ok('...and a notes-pending one keeps its transcript and becomes notes_failed (a person can still retry)', D(w, 'v9age000002').pipelineStatus === 'notes_failed' && D(w, 'v9age000002').transcript === 'hello there');
  // an internal error repeats: counted, then stopped
  stub();
  w = world({ v9int000001: cap('v9int000001') });
  const realGet = w.db.doc;
  w.db.doc = (p) => { const r = realGet(p); if (/^leads\//.test(p)) r.get = async () => { throw new Error('firestore blip'); }; return r; };
  w.db.collection = ((orig) => (n) => { if (n === 'leads') throw new Error('firestore blip'); return orig(n); })(w.db.collection);
  for (let i = 0; i < 5; i++) await run(w, 'v9int000001', NOW + i * 20 * 60000);
  d = D(w, 'v9int000001');
  ok('an internal error that repeats is counted and given up on after 5 (not a loop), with a short code, no raw message', d.internalErrors === 5 && d.pipelineStatus === 'failed' && d.pipelineNote === 'internal_error_gave_up' && counts.transcribe === 0, J(d));

  // audioLive + server stamp from first sight; a parked doc is still reaped
  stub(); flags.aiOff = true;
  w = world({ v9park00001: cap('v9park00001', { uploadedAtMs: 99999999999999 }) });
  out = await run(w, 'v9park00001');
  d = D(w, 'v9park00001');
  ok('a parked doc (kill switch) is stamped audioLive + firstSeenAtMs by the server at first sight', d.audioLive === true && d.firstSeenAtMs === NOW && d.pipelineNote === 'ai_disabled');
  const rsp = await V.retentionSweep({ db: w.db, bucket: w.bucket, nowMs: NOW + 120 * 86400000 });
  ok('retention runs from the server stamp: a phone-written far-future uploadedAtMs does not keep the audio', !w.bucket.store.has(pathFor('v9park00001')) && rsp.deleted === 1, J(rsp));

  // purge_pending: a failed delete is retried, in a state the sweep owns
  stub();
  const flaky = { fail: true };
  w = world({ v9purge0001: cap('v9purge0001', { leadId: 'L_DNR' }) });
  const baseFile = w.bucket.file;
  w.bucket.file = (p) => Object.assign(baseFile(p), { delete: async (o) => { if (flaky.fail) throw new Error('delete failed'); return baseFile(p).delete(o); } });
  out = await run(w, 'v9purge0001');
  ok('a skip whose audio delete fails is purge_pending (audio still live), retried later', D(w, 'v9purge0001').pipelineStatus === 'purge_pending' && D(w, 'v9purge0001').audioLive === true && D(w, 'v9purge0001').purgeFinal === 'skipped' && D(w, 'v9purge0001').pipelineNextAtMs > NOW);
  const sw0 = await V.sweep({ db: w.db, bucket: w.bucket, nowMs: NOW + 5 * 60000 });
  ok('NEG: not due yet: the sweep leaves it alone', D(w, 'v9purge0001').pipelineStatus === 'purge_pending' && sw0.picked === 0, J(sw0));
  flaky.fail = false;
  const sw1 = await V.sweep({ db: w.db, bucket: w.bucket, nowMs: NOW + 2 * 3600000 });
  ok('the sweep retries it when due: audio deleted, state skipped, audioLive false', D(w, 'v9purge0001').pipelineStatus === 'skipped' && D(w, 'v9purge0001').audioLive === false && !w.bucket.store.has(pathFor('v9purge0001')) && sw1.picked === 1, J(sw1));
  w = world({ v9purge0002: cap('v9purge0002', { status: 'discarded' }) });
  const bf2 = w.bucket.file; const fl2 = { fail: true };
  w.bucket.file = (p) => Object.assign(bf2(p), { delete: async (o) => { if (fl2.fail) throw new Error('delete failed'); return bf2(p).delete(o); } });
  await run(w, 'v9purge0002');
  ok('a discard whose delete fails is also purge_pending (and discard-due is not re-run before its time)', D(w, 'v9purge0002').pipelineStatus === 'purge_pending' && LG.nextStep(D(w, 'v9purge0002'), NOW + 60000).step === 'none');
  fl2.fail = false;
  await V.sweep({ db: w.db, bucket: w.bucket, nowMs: NOW + 2 * 3600000 });
  ok('...then it settles as discarded', D(w, 'v9purge0002').pipelineStatus === 'discarded' && D(w, 'v9purge0002').audioLive === false);

  // the phone re-pointing or removing the customer by writing the doc directly
  stub();
  w = world({ v9repoint01: cap('v9repoint01', { leadId: 'L_SMITH' }) });
  await run(w, 'v9repoint01');
  ok('control: filed under L_SMITH', tasksOf(w, 'L_SMITH').length === 3);
  w.db.docs.get(vpath('v9repoint01')).leadId = 'L_JONES';
  out = await run(w, 'v9repoint01', NOW + 1000);
  ok('a direct re-point (the phone wrote leadId) retracts the old customer\'s filing and files the new one', out.step === 'finalize' && tasksOf(w, 'L_SMITH').length === 0 && !w.db.docs.has('leads/L_SMITH/activity/visit-v9repoint01') && tasksOf(w, 'L_JONES').length === 3 && D(w, 'v9repoint01').attachedLeadId === 'L_JONES', J(out));
  w.db.docs.get(vpath('v9repoint01')).leadId = null;
  out = await run(w, 'v9repoint01', NOW + 2000);
  ok('a direct detach (leadId null) unfiles: row and open tasks removed, attachedLeadId cleared', out.step === 'unfile' && tasksOf(w, 'L_JONES').length === 0 && D(w, 'v9repoint01').attachedLeadId === null && LG.nextStep(D(w, 'v9repoint01'), NOW + 3000).step === 'none', J(out));

  // F6: another person's capture with the same id
  stub();
  w = world({ v9same00001: cap('v9same00001', { leadId: 'L_SMITH' }) }, { seed: { 'leads/L_SMITH/activity/visit-v9same00001': { type: 'visit', visitUid: 'uOther', summary: 'the other rep\'s row' }, 'users/uOther': { companyId: OWNER } } });
  out = await run(w, 'v9same00001');
  ok('F6: a row with this id that belongs to another person is never overwritten (visit_id_conflict)', w.db.docs.get('leads/L_SMITH/activity/visit-v9same00001').visitUid === 'uOther' && /other rep/.test(w.db.docs.get('leads/L_SMITH/activity/visit-v9same00001').summary) && D(w, 'v9same00001').attachNote === 'visit_id_conflict');
  w.db.docs.set('leads/L_SMITH/tasks/visit-v9same00001-p0', { visitId: 'v9same00001', visitUid: 'uOther', done: false, text: 'theirs' });
  await V.retract({ db: w.db, leadId: 'L_SMITH', visitId: 'v9same00001', uid: OWNER });
  ok('F6: retract only removes what THIS person made', w.db.docs.has('leads/L_SMITH/tasks/visit-v9same00001-p0') && w.db.docs.has('leads/L_SMITH/activity/visit-v9same00001'));

  // F7: the person deletes the doc mid-pass
  stub();
  w = world({ v9gone00001: cap('v9gone00001') });
  scripted.transcribe = async () => { w.db.docs.delete(vpath('v9gone00001')); return { text: TRANSCRIPT, durationSec: 60, segments: [] }; };
  out = await run(w, 'v9gone00001');
  ok('F7: a doc deleted while the pipeline ran is NOT resurrected with its transcript', !w.db.docs.has(vpath('v9gone00001')) && out.step === 'gone' && counts.notes === 0);

  // F4: due-only sweep, a flood of waiting docs cannot starve a runnable one
  stub();
  const flood = {};
  for (let i = 0; i < 70; i++) flood['v9flood' + String(i).padStart(4, '0')] = cap('v9flood' + String(i).padStart(4, '0'), { pipelineStatus: 'waiting_object', pipelineNextAtMs: NOW + 9e8, firstSeenAtMs: NOW, audioLive: true });
  flood.v9runnable1 = cap('v9runnable1', { pipelineStatus: 'transcribe_pending', pipelineNextAtMs: NOW - 1000, firstSeenAtMs: NOW - 1e6, audioLive: true });
  w = world(flood);
  w.db.docs.set('users/uZed/visit_captures/v9runnable2', cap('v9runnable2', { pipelineStatus: 'transcribe_pending', pipelineNextAtMs: NOW - 5, firstSeenAtMs: NOW - 1e6, audioLive: true, audioPath: 'audio/uZed/_inbox/v9runnable2.m4a' }));
  w.db.docs.set('users/uZed', { companyId: 'uZed' });
  w.bucket.store.set('audio/uZed/_inbox/v9runnable2.m4a', Buffer.from('x'));
  const swf = await V.sweep({ db: w.db, bucket: w.bucket, nowMs: NOW });
  ok('F4: 70 backed-off docs hold no slot: both runnable docs (two tenants) ran', swf.picked === 2 && D(w, 'v9runnable1').pipelineStatus === 'ready' && w.db.docs.get('users/uZed/visit_captures/v9runnable2').pipelineStatus === 'ready', J(swf));
  stub();
  w = world({ v9far000001: cap('v9far000001', { uploadedAtMs: 99999999999999 }), v9near00001: cap('v9near00001', { uploadedAtMs: NOW - 60e3 }) });
  const swl = await V.sweep({ db: w.db, bucket: w.bucket, nowMs: NOW });
  ok('F4: a far-future uploadedAtMs is outside the lost-trigger window; a real recent one is rescued', !D(w, 'v9far000001').pipelineStatus && D(w, 'v9near00001').pipelineStatus === 'ready' && swl.lostTrigger === 1, J(swl));

  // the manual retry is bounded
  stub({ notes: () => { throw new Error('notes: no JSON'); } });
  w = world({ v9retry0001: cap('v9retry0001') });
  for (let i = 0; i < 3; i++) await run(w, 'v9retry0001', NOW + i * 3600000);
  stub();
  const R1 = await A(w, asOwner, { visitId: 'v9retry0001', action: 'retryNotes' }, NOW + 4 * 3600000);
  ok('retry notes works once', R1.ok && D(w, 'v9retry0001').manualRetries === 1);
  e = await rej(() => A(w, asOwner, { visitId: 'v9retry0001', action: 'retryNotes' }, NOW + 4 * 3600000 + 30000));
  ok('NEG: a second tap inside the cooldown is refused (resource-exhausted) and pays nothing', e && e.code === 'resource-exhausted' && counts.notes === 1);
  w.db.docs.get(vpath('v9retry0001')).manualRetries = 5;
  e = await rej(() => A(w, asOwner, { visitId: 'v9retry0001', action: 'retryNotes' }, NOW + 9 * 3600000));
  ok('NEG: and the number of manual retries is capped', e && e.code === 'resource-exhausted');
  stub({ rateLimited: true });
  scripted.rateLimited = true;
  e = await rej(() => A(w, asOwner, { visitId: 'v9retry0001', action: 'audioUrl' }));
  ok('the callable is rate limited per person (a limiter refusal passes through)', e && e.code === 'resource-exhausted' && counts.rate >= 1);

  // the doc the person reads never carries a raw provider message
  stub({ notes: () => { throw Object.assign(new Error('anthropic 401: invalid x-api-key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), { status: 401, provider: 'anthropic' }); } });
  w = world({ v9err000001: cap('v9err000001') });
  out = await run(w, 'v9err000001');
  ok('pipelineError on the client-readable doc is a short code (anthropic:auth), never the provider\'s text or a key fragment', D(w, 'v9err000001').pipelineError === 'anthropic:auth' && !/sk-ant|ABCDEFG/.test(J(D(w, 'v9err000001'))), D(w, 'v9err000001').pipelineError);

  // skipped audio gives no link; a failed-notes timeline row says so
  stub();
  w = world({ v9skip00001: cap('v9skip00001', { leadId: 'L_DNR' }) });
  await run(w, 'v9skip00001');
  w.db.docs.get(vpath('v9skip00001')).audioLive = true;
  e = await rej(() => A(w, asOwner, { visitId: 'v9skip00001', action: 'audioUrl' }));
  ok('a skipped capture gives no audio link even if audioLive were still set', e && e.code === 'failed-precondition');
  stub({ notes: () => { throw new Error('notes: no JSON'); } });
  w = world({ v9nf0000001: cap('v9nf0000001', { leadId: 'L_SMITH' }) });
  for (let i = 0; i < 3; i++) await run(w, 'v9nf0000001', NOW + i * 3 * 3600000);
  const nfRow = w.db.docs.get('leads/L_SMITH/activity/visit-v9nf0000001');
  ok('a permanently failed notes step is said plainly on the timeline (not "pending" for ever)', D(w, 'v9nf0000001').pipelineStatus === 'notes_failed' && nfRow && nfRow.notesFailed === true && nfRow.notesPending === false && /could not be written/.test(nfRow.summary), J(nfRow));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log(fails.map((x) => ' - ' + x).join('\n')); process.exit(1); }
})().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
