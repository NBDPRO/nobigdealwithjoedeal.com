/**
 * tests/thursday-logic.test.js — the pure decisions behind the Thursday
 * (Bland AI receptionist) → CRM pipeline (functions/integrations/thursday-logic.js,
 * shared verbatim by the webhook, the processing trigger and the backfill).
 *
 * Guards what matters most:
 *   1. Tenant scoping — a lead in ANOTHER company with the caller's exact
 *      phone is never matched, never attached, never looked up.
 *   2. No duplicates — a Thumbtack lead (669 proxy phone, "Halina N.", town
 *      only) is flagged as a possible match instead of re-created; an
 *      existing customer at the same street is attached.
 *   3. Webhook trust — the Bland HMAC check fails closed on every bad input.
 *   4. Extraction hygiene — model output is clamped to the router's enums.
 *   5. Minimal disclosure from the live lookup (first name + stage hint only).
 *
 * Zero deps. Run: node tests/thursday-logic.test.js
 */
'use strict';

const path = require('path');
const crypto = require('crypto');
const T = require(path.join('..', 'functions', 'integrations', 'thursday-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const OTHER = 'otherTenantCompany00000000001';

// ── Fixtures ────────────────────────────────────────────────────────────────
const LEADS = [
  { id: 'castellano1', companyId: NBD, userId: NBD, firstName: 'Maria', lastName: 'Castellano',
    address: '2718 Linden Ave, Covington, KY 41014', phone: '(859) 555-0101', phoneDigits: '8595550101',
    source: 'Referral', stage: 'Estimate Sent' },
  { id: 'thumbtack_leads__abc', companyId: NBD, userId: NBD, firstName: 'Halina', lastName: 'N.',
    address: 'West Chester, OH 45069', phone: '+16695550199', phoneDigits: '6695550199',
    source: 'Thumbtack', stage: 'New' },
  // Another tenant's customer with the SAME phone as the Castellano test caller.
  { id: 'otherTenantLead', companyId: OTHER, userId: OTHER, firstName: 'Maria', lastName: 'Castellano',
    address: '2718 Linden Ave, Covington, KY 41014', phone: '5135550142', phoneDigits: '5135550142',
    source: 'Door Knock', stage: 'New' },
  { id: 'deletedLead', companyId: NBD, userId: NBD, firstName: 'Deleted', lastName: 'Person',
    address: '5 Gone Rd, Mason, OH 45040', phoneDigits: '5135550777', deleted: true },
  { id: 'smith1', companyId: NBD, firstName: 'John', lastName: 'Smith', address: '10 Oak St, Mason, OH 45040', phoneDigits: '5135550001' },
  { id: 'smith2', companyId: NBD, firstName: 'John', lastName: 'Smith', address: '99 Elm Dr, Loveland, OH 45140', phoneDigits: '5135550002' },
  { id: 'phoneOnly', companyId: NBD, firstName: 'Pat', lastName: 'Lee', address: '', phoneDigits: '5135550333', stage: 'Contract Signed' },
];

function ex(over) { return T.sanitizeExtraction(Object.assign({ caller_type: 'new_lead', confidence: 'high' }, over)); }
function call(over) { return Object.assign({ callId: 'c0ffee12-0000-4000-8000-000000000001', from: '+15135550142', to: '+15139405589', transcript: 'x', transcripts: [], durationSec: 95 }, over); }

console.log('THURSDAY — signature');
{
  const secret = 'whsec_test_123';
  const body = Buffer.from(JSON.stringify({ call_id: 'abc123', to: '+15139405589' }));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  ok('valid hex signature verifies', T.verifyBlandSignature(body, sig, secret));
  ok('uppercase / sha256= prefix tolerated', T.verifyBlandSignature(body, 'sha256=' + sig.toUpperCase(), secret));
  ok('tampered body rejected', !T.verifyBlandSignature(Buffer.from(body.toString().replace('abc123', 'abc124')), sig, secret));
  ok('wrong secret rejected', !T.verifyBlandSignature(body, sig, 'whsec_other'));
  ok('missing secret fails closed', !T.verifyBlandSignature(body, sig, ''));
  ok('missing signature fails closed', !T.verifyBlandSignature(body, '', secret));
  ok('wrong-length signature rejected (no throw)', !T.verifyBlandSignature(body, sig.slice(0, 10), secret));
  ok('bearer: exact token matches', T.bearerMatches('Bearer tok_abc', 'tok_abc'));
  ok('bearer: wrong / missing token rejected', !T.bearerMatches('Bearer tok_abd', 'tok_abc') && !T.bearerMatches('', 'tok_abc') && !T.bearerMatches('Bearer x', ''));
}

console.log('\nTHURSDAY — ids + call normalization');
{
  ok('doc id is bland_calls__{call_id}', T.callDocId('abc-123_XYZ') === 'bland_calls__abc-123_XYZ');
  let threw = false; try { T.callDocId('../../etc'); } catch (e) { threw = true; }
  ok('path-escaping call id refused', threw);
  ok('lead id reuses the call doc id (idempotent create)', T.leadDocIdForCall('abc123') === 'bland_calls__abc123');
  ok('task/activity ids deterministic', T.taskIdForCall('abc123') === 'thursday-abc123' && T.activityIdForCall('abc123') === 'thursday-abc123');

  const n = T.normalizeCall({
    call_id: 'abc123', from: '+15135550142', to: '+15139405589', inbound: true, call_length: 1.5,
    started_at: '2026-09-26T14:00:00Z', summary: 'Leak', recording_url: 'https://x/rec.mp3',
    transcripts: [{ user: 'assistant', text: 'Thanks for calling' }, { user: 'user', text: 'Hello? Anyone?' }],
  });
  ok('duration minutes → seconds', n.durationSec === 90);
  ok('transcript assembled from turns when concatenated is absent', n.transcript.indexOf('user: Hello? Anyone?') !== -1);
  ok('Thursday inbound call accepted', T.isThursdayCall(n));
  ok('call to another number refused', !T.isThursdayCall(Object.assign({}, n, { to: '+15135550000' })));
  ok('outbound call refused', !T.isThursdayCall(Object.assign({}, n, { inbound: false })));
  ok('caller who said 2 words is silent', T.isEffectivelySilent(n));
  const talky = T.normalizeCall({ call_id: 'x12345', transcripts: [{ user: 'user', text: 'Hi my name is Maria Castellano and I have a leak over my kitchen at 1912 Linden' }] });
  ok('real caller is not silent', !T.isEffectivelySilent(talky));
}

console.log('\nTHURSDAY — extraction parsing + sanitizing');
{
  const resp = { stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 2000, output_tokens: 400 },
    content: [{ type: 'text', text: '```json\n{"caller_name":"Maria Castellano","caller_type":"new_lead"}\n```' }] };
  const p = T.parseExtractionResponse(resp);
  ok('fenced JSON parsed', p.parsed.caller_name === 'Maria Castellano');
  // 2026-10-04: Opus 5.5 list price, $4 in / $20 out per MTok (was Opus 5, $5/$25 → 0.02).
  ok('cost computed from usage ($4/$20 per MTok)', Math.abs(p.costUsd - 0.016) < 1e-9, String(p.costUsd));
  ok('extraction model is claude-opus-5-5', T.EXTRACTION_MODEL === 'claude-opus-5-5', T.EXTRACTION_MODEL);
  // Only the model id moved: the request keeps effort low, the JSON schema,
  // the server-side fallback and its 8000-token ceiling.
  const rq = T.buildExtractionRequest({ from: '+15135550100', transcript: 'hi' });
  ok('extraction request shape unchanged apart from the model',
    rq.model === 'claude-opus-5-5' && rq.max_tokens === 8000 && rq.fallbacks === 'default'
      && rq.output_config.effort === 'low' && rq.output_config.format.type === 'json_schema'
      && !('thinking' in rq) && !('temperature' in rq) && !('tool_choice' in rq)
      && JSON.stringify(Object.keys(rq)) === JSON.stringify(['model', 'max_tokens', 'fallbacks', 'output_config', 'system', 'messages']),
    Object.keys(rq));
  const codeOf = (r) => { try { T.parseExtractionResponse(r); return 'none'; } catch (e) { return e.code; } };
  ok('refusal → typed error', codeOf({ stop_reason: 'refusal', content: [] }) === 'refusal');
  ok('max_tokens → typed error', codeOf({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":' }] }) === 'max-tokens');
  ok('non-JSON → typed error', codeOf({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sorry, no.' }] }) === 'bad-json');
  ok('API error body → typed error', codeOf({ type: 'error', error: { message: 'overloaded' } }) === 'api-error');

  const s = T.sanitizeExtraction({
    caller_name: '  Maria   Castellano ', callback_number: '1 (859) 555-0101', caller_type: 'Existing Customer',
    urgent: 'yes', email: 'MARIA @Example.com', zip: 'KY 41014-1234', state: 'Kentucky',
    insurance: { involved: 'maybe', carrier: 'State Farm', claim_filed: 'unknown', claim_number: 'SF-99812' },
    confidence: 'certain', extra_field: 'dropped',
  });
  ok('caller_type normalized to enum', s.caller_type === 'existing_customer');
  ok('unknown caller_type falls back to new_lead', T.sanitizeExtraction({ caller_type: 'alien' }).caller_type === 'new_lead');
  ok('string "yes" → urgent true', s.urgent === true);
  ok('callback number → 10 digits', s.callback_number === '8595550101');
  ok('email lowercased + spaces removed', s.email === 'maria@example.com');
  ok('zip+4 → 5-digit zip', s.zip === '41014');
  ok('spelled-out state → postal code', s.state === 'KY', s.state);
  ok('unknown state text dropped, not truncated', T.sanitizeExtraction({ state: 'Narnia' }).state === '');
  ok('carrier present → insurance involved', s.insurance.involved === 'yes');
  ok('claim number present → claim filed', s.insurance.claim_filed === 'yes');
  ok('bad confidence → medium', s.confidence === 'medium');
  ok('unknown keys dropped', !('extra_field' in s));
  ok('silent extraction is log-only type', T.silentExtraction().caller_type === 'silent');

  const req = T.buildExtractionRequest(call({ transcript: 'user: hi' }));
  ok('request uses structured outputs json_schema', req.output_config.format.type === 'json_schema' && req.output_config.format.schema === T.EXTRACTION_SCHEMA);
  ok('request opts into server-side fallbacks with the matching beta header',
    req.fallbacks === 'default' && T.extractionHeaders('k')['anthropic-beta'] === 'server-side-fallback-2026-07-01');
  ok('no assistant prefill in request', req.messages.every((m) => m.role === 'user'));
  const schemaObjects = [T.EXTRACTION_SCHEMA, T.EXTRACTION_SCHEMA.properties.insurance];
  ok('every schema object is closed and fully required',
    schemaObjects.every((o) => o.additionalProperties === false && Object.keys(o.properties).every((k) => o.required.indexOf(k) !== -1)));
}

console.log('\nTHURSDAY — heard-about-us → canonical source');
{
  const cases = [
    ['Google', 'Google'], ['found you on google maps', 'Google'], ['Thumbtack', 'Thumbtack'],
    ['my neighbor Jim recommended you', 'Referral'], ['saw your yard sign', 'Direct'],
    ['Facebook', 'Online'], ['your website', 'Website'], ['Angie\'s List', 'Angi'],
    ['you knocked on my door', 'Door Knock'], ['', 'Other'], ['no idea', 'Other'],
  ];
  for (const [inp, want] of cases) {
    const got = T.mapHeardAboutToSource(inp);
    ok('"' + inp + '" → ' + want, got === want, 'got ' + got);
  }
  ok('every mapped value is canonical',
    cases.every(([inp]) => T.CANONICAL_SOURCES.indexOf(T.mapHeardAboutToSource(inp)) !== -1));
}

console.log('\nTHURSDAY — matching (tenant-scoped, no duplicates)');
{
  // Maria Castellano calls from a number NOT on her lead (her lead has 859-555-0101),
  // but that number IS on another tenant's lead.
  const mEx = ex({ caller_name: 'Maria Castellano', address: '2718 Linden Ave', town: 'Covington', state: 'KY', caller_type: 'existing_customer' });
  const m = T.matchLeads({ companyId: NBD, extraction: mEx, call: call({ from: '+15135550142' }), leads: LEADS });
  ok('Castellano → strong match to the NBD Castellano lead', m.confidence === 'strong' && m.lead.leadId === 'castellano1',
    JSON.stringify({ c: m.confidence, l: m.lead && m.lead.leadId }));
  ok('other tenant lead never appears (same phone + same address)',
    ![].concat(m.strong, m.possible).some((r) => r.leadId === 'otherTenantLead'));

  const mOther = T.matchLeads({ companyId: NBD, extraction: ex({}), call: call({ from: '+15135550142' }), leads: LEADS });
  ok('phone that exists ONLY in another tenant → no match at all', mOther.confidence === 'none');

  let threw = false; try { T.matchLeads({ companyId: '', extraction: mEx, call: call(), leads: LEADS }); } catch (e) { threw = true; }
  ok('matchLeads refuses to run without a companyId', threw);

  // Halina: Thumbtack lead has a 669 proxy phone, "Halina N.", town + zip only.
  const dEx = ex({ caller_name: 'Halina Nowicka', address: '7420 Birchwood Ct', town: 'West Chester', zip: '45069' });
  const d = T.matchLeads({ companyId: NBD, extraction: dEx, call: call({ from: '+15135559876' }), leads: LEADS });
  ok('Halina → flagged possible match to her Thumbtack lead (not new)',
    d.confidence === 'possible' && d.possible.some((r) => r.leadId === 'thumbtack_leads__abc'), JSON.stringify(d.possible.map((r) => r.leadId)));
  const dRoute = T.decideRoute(dEx, d);
  ok('Halina route never creates a lead', dRoute.action === 'possible_match' && dRoute.leadId === 'thumbtack_leads__abc');

  const proxyCaller = T.matchLeads({ companyId: NBD, extraction: ex({}), call: call({ from: '+16695550199' }), leads: LEADS });
  ok('a Thumbtack proxy number never phone-matches', proxyCaller.confidence === 'none');

  const smith = T.matchLeads({ companyId: NBD, extraction: ex({ caller_name: 'John Smith' }), call: call({ from: '+15135551111' }), leads: LEADS });
  ok('two John Smiths → possible, never a guessed attach', smith.confidence === 'possible' && smith.lead === null && smith.possible.length === 2);

  const two = T.matchLeads({ companyId: NBD, extraction: ex({ callback_number: '5135550001' }), call: call({ from: '+15135550002' }), leads: LEADS });
  ok('two different strong phone hits → downgraded to possible', two.confidence === 'possible');

  const del = T.matchLeads({ companyId: NBD, extraction: ex({}), call: call({ from: '+15135550777' }), leads: LEADS });
  ok('deleted lead never matched', del.confidence === 'none');

  const byPhone = T.matchLeads({ companyId: NBD, extraction: ex({}), call: call({ from: '+15135550333' }), leads: LEADS });
  ok('exact non-proxy phone → strong', byPhone.confidence === 'strong' && byPhone.lead.leadId === 'phoneOnly');

  const cb = T.matchLeads({ companyId: NBD, extraction: ex({ callback_number: '859-555-0101' }), call: call({ from: '+15135559999' }), leads: LEADS });
  ok('callback number matches when caller ID does not', cb.confidence === 'strong' && cb.lead.leadId === 'castellano1');

  const wrongTown = T.matchLeads({ companyId: NBD, extraction: ex({ caller_name: 'Maria Castellano', address: '2718 Linden Ave', town: 'Dayton', zip: '45402' }), call: call({ from: '+15135559999' }), leads: LEADS });
  ok('same street + name but a DIFFERENT town → only possible', wrongTown.confidence === 'possible');
}

console.log('\nTHURSDAY — routing');
{
  const none = { confidence: 'none', lead: null, strong: [], possible: [] };
  const strong = { confidence: 'strong', lead: { leadId: 'L1', name: 'A', reasons: ['phone'] }, strong: [{}], possible: [] };
  for (const t of ['spam', 'test', 'silent']) {
    const r = T.decideRoute(ex({ caller_type: t }), strong);
    ok(t + ' → log only, no notifications, no task', r.action === 'log_only' && !r.notifyEmail && !r.notifyPush && !r.notifySms && !r.createTask);
  }
  const js = T.decideRoute(ex({ caller_type: 'job_seeker' }), none);
  ok('job seeker → inbox + email only', js.action === 'inbox' && js.notifyEmail && !js.notifySms && !js.notifyPush);
  const nl = T.decideRoute(ex({ caller_type: 'new_lead', urgent: true }), none);
  ok('new lead, no match → create lead + task + all notifications', nl.action === 'create_lead' && nl.createTask && nl.notifySms && nl.notifyPush && nl.notifyEmail && nl.urgent);
  const ec = T.decideRoute(ex({ caller_type: 'existing_customer' }), strong);
  ok('existing customer, strong match → attach + task', ec.action === 'attach' && ec.leadId === 'L1' && ec.createTask);
  const ecNone = T.decideRoute(ex({ caller_type: 'existing_customer' }), none);
  ok('existing customer, no match → create lead (labelled)', ecNone.action === 'create_lead' && /no CRM match/.test(ecNone.label));
  const adj = T.decideRoute(ex({ caller_type: 'adjuster' }), none);
  ok('adjuster, no match → inbox, never a lead', adj.action === 'inbox' && !adj.createTask);
  const adjM = T.decideRoute(ex({ caller_type: 'adjuster' }), strong);
  ok('adjuster, matched job → attach + task', adjM.action === 'attach' && adjM.createTask);
  const sup = T.decideRoute(ex({ caller_type: 'supplier_sub' }), none);
  ok('supplier, no match → inbox', sup.action === 'inbox');
}

console.log('\nTHURSDAY — real-call tuning (2026-09-26 dry-run)');
{
  const talk = (words) => T.normalizeCall({ call_id: 'tune1234', transcripts: [{ user: 'user', text: words }] });
  ok('"Hello? / Hello?" (2 words) is silent', T.isEffectivelySilent(talk('Hello? Hello?')));
  ok('"Hey it\'s Mike, call me back" (6 words) is NOT silent', !T.isEffectivelySilent(talk("Hey it's Mike, call me back")));
  ok('no caller turns at all is silent', T.isEffectivelySilent(T.normalizeCall({ call_id: 'tune1235', transcripts: [] })));
  const spoke = T.silentExtraction(talk('Hello?'));
  const mute = T.silentExtraction(T.normalizeCall({ call_id: 'tune1236', transcripts: [] }));
  const none = { confidence: 'none', possible: [] };
  const rSpoke = T.decideRoute(spoke, none);
  ok('caller said "Hello?" and hung up → inbox, no alerts', rSpoke.action === 'inbox' && !rSpoke.notifyEmail && !rSpoke.notifyPush && !rSpoke.notifySms);
  ok('nobody spoke, hung up fast → log only', T.decideRoute(mute, none).action === 'log_only');
  const waited = T.silentExtraction(T.normalizeCall({ call_id: 'tune1237', transcripts: [], call_length: 0.4 }));
  ok('nobody spoke but stayed 24 s (waiting for Thursday) → inbox', T.decideRoute(waited, none).action === 'inbox');
  // 2026-09-28: Thursday greets on connect, so a caller who hangs up during
  // her greeting (the real 3 s call, only her words in the transcript) is a
  // missed caller; a sub-2 s blip is not.
  const greeted = T.normalizeCall({ call_id: 'tune1238', transcripts: [{ user: 'assistant', text: 'Thanks for calling No Big Deal Home Solutions, this is Thursday.' }], call_length: 0.05 });
  ok('greeting-only transcript is still silent (caller said nothing)', T.isEffectivelySilent(greeted));
  ok('hung up 3 s into Thursday\'s greeting → inbox, no alerts', (() => { const r = T.decideRoute(T.silentExtraction(greeted), none); return r.action === 'inbox' && !r.notifyEmail && !r.notifyPush && !r.notifySms; })());
  const blip = T.silentExtraction(T.normalizeCall({ call_id: 'tune1239', transcripts: [], call_length: 0.0166666666666667 }));
  ok('1 s line blip → log only', T.decideRoute(blip, none).action === 'log_only');
  const own = T.applyCallOverrides(ex({ caller_type: 'new_lead', caller_name: '' }), call({ from: '+18594207382' }), {});
  const rOwn = T.decideRoute(own, none);
  ok('call from Jo\'s own cell → test, log only, no lead', own.caller_type === 'test' && rOwn.action === 'log_only' && !rOwn.createTask);
  const extra = T.applyCallOverrides(ex({ caller_type: 'new_lead' }), call({ from: '+15135550123' }), { ownerNumbers: ['513-555-0123'] });
  ok('config ownerNumbers extend the list', extra.caller_type === 'test');
  const cust = T.applyCallOverrides(ex({ caller_type: 'new_lead' }), call({ from: '+15135550999' }), {});
  ok('anyone else is untouched', cust.caller_type === 'new_lead' && !cust.owner_call);
}

console.log('\nTHURSDAY — builders + notifications');
{
  const e = ex({ caller_name: 'halina nowicka', callback_number: '5135559876', address: '7420 Birchwood Ct', town: 'west chester',
    state: 'OH', zip: '45069', issue: 'Shingles blown off after the storm', urgent: true, urgent_reason: 'Tarp needed tonight',
    heard_about_us: 'Google', insurance: { involved: 'yes', carrier: 'Allstate', claim_filed: 'no', claim_number: '' } });
  const c = call({ callId: 'abc123', from: '+15135559876', startedAt: '2026-09-26T14:00:00.000Z', summary: 'Storm damage' });
  const route = T.decideRoute(e, { confidence: 'none', possible: [] });
  const lead = T.buildLeadDoc({ extraction: e, call: c, ownerUid: NBD, companyId: NBD });
  ok('lead scoped to NBD (userId + companyId)', lead.userId === NBD && lead.companyId === NBD);
  ok('lead stage New / status new', lead.stage === 'New' && lead.status === 'new');
  ok('source = canonical heard-about value', lead.source === 'Google');
  ok('intake records the phone funnel separately', lead.intake === 'Phone — Thursday' && lead.sourcePage === 'phone:thursday');
  ok('names title-cased', lead.firstName === 'Halina' && lead.lastName === 'Nowicka');
  ok('phone E.164 + phoneDigits stamped', lead.phone === '+15135559876' && lead.phoneDigits === '5135559876');
  ok('address composed with town/state/zip', lead.address === '7420 Birchwood Ct, west chester, OH 45069');
  ok('insurance fields use the CRM field names', lead.jobType === 'insurance' && lead.insCarrier === 'Allstate' && lead.claimStatus === 'No Claim');
  ok('provenance points back at the call doc', lead.publicLeadId === 'bland_calls__abc123' && lead.thursdayCallId === 'abc123');
  ok('no cost/margin keys on the lead', !Object.keys(lead).some((k) => /cost|margin/i.test(k)));

  const task = T.buildTask({ extraction: e, call: c, route, leadId: 'bland_calls__abc123', ownerUid: NBD, now: Date.parse('2026-09-26T14:00:00Z') });
  ok('task has the reader shape (text/title/done/dueDate)', task.text && task.title === task.text && task.done === false && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate));
  ok('urgent task is high priority + flagged', task.priority === 'high' && /URGENT/.test(task.text));

  const sms = T.buildSmsText({ extraction: e, call: c, route, leadId: 'bland_calls__abc123' });
  ok('SMS ≤ 300 chars', sms.length <= 300, String(sms.length));
  ok('SMS carries name, town, URGENT and the card link', /Nowicka/i.test(sms) && /west chester/i.test(sms) && /URGENT/.test(sms) && /customer\.html\?id=bland_calls__abc123/.test(sms));
  const longSms = T.buildSmsText({ extraction: Object.assign({}, e, { issue: 'x'.repeat(900) }), call: c, route, leadId: 'L' });
  ok('very long issue still ≤ 300 chars and keeps the link', longSms.length <= 300 && /customer\.html\?id=L$/.test(longSms));

  const mail = T.buildEmail({ extraction: e, call: Object.assign({}, c, { transcript: '<script>alert(1)</script>' }), route, leadId: 'bland_calls__abc123' });
  ok('email subject names type, caller, town and URGENT', /New lead/.test(mail.subject) && /Nowicka/i.test(mail.subject) && /URGENT/.test(mail.subject));
  ok('email HTML escapes transcript', mail.html.indexOf('<script>') === -1 && mail.html.indexOf('&lt;script&gt;') !== -1);
  ok('email never carries a raw Bland recording URL', mail.html.indexOf('https://x/') === -1);
  const failedMail = T.buildEmail({ extraction: null, call: c, route: { label: 'Needs review', action: 'inbox' }, extractionError: 'refusal' });
  ok('email still renders when extraction failed', /FAILED \(refusal\)/.test(failedMail.text));
}

console.log('\nTHURSDAY — live caller lookup (minimal disclosure)');
{
  const hit = T.buildLookupResponse({ companyId: NBD, from: '+18595550101', leads: LEADS });
  ok('known caller → first name + stage hint only', hit.known === true && hit.first_name === 'Maria' && hit.job_hint === 'your estimate');
  ok('lookup never returns address / last name / phone', Object.keys(hit).sort().join(',') === 'first_name,job_hint,known');
  const other = T.buildLookupResponse({ companyId: NBD, from: '+15135550142', leads: LEADS });
  ok('number known only to another tenant → unknown', other.known === false);
  const proxy = T.buildLookupResponse({ companyId: NBD, from: '+16695550199', leads: LEADS });
  ok('Thumbtack proxy number → unknown', proxy.known === false);
  const dup = T.buildLookupResponse({ companyId: NBD, from: '+15135550001', leads: LEADS.concat([{ id: 'dupe', companyId: NBD, firstName: 'Jane', phoneDigits: '5135550001' }]) });
  ok('two leads on one number → unknown (never guess a name)', dup.known === false);
  ok('garbage caller id → unknown', T.buildLookupResponse({ companyId: NBD, from: 'anonymous', leads: LEADS }).known === false);
}

console.log('\nTHURSDAY — couples + second numbers (PR C)');
{
  ok('"Tom & Maria" → "Tom or Maria"', T.lookupFirstName({ firstName: 'Tom & Maria' }) === 'Tom or Maria');
  ok('"Bob and Sue" → "Bob or Sue"', T.lookupFirstName({ firstName: 'Bob and Sue' }) === 'Bob or Sue');
  ok('single name unchanged', T.lookupFirstName({ firstName: 'halina' }) === 'Halina');
  ok('placeholder name → empty', T.lookupFirstName({ firstName: 'Caller 7382' }) === '');
  const couple = [{ id: 'c1', companyId: NBD, firstName: 'Tom & Maria', lastName: 'Castellano', phoneDigits: '8595550177', altPhoneDigits: '8595550166', stage: 'contract_signed' }];
  const viaAlt = T.buildLookupResponse({ companyId: NBD, from: '+18595550166', leads: couple });
  ok('second number is recognized by the live lookup', viaAlt.known && viaAlt.first_name === 'Tom or Maria', JSON.stringify(viaAlt));
  const dupe = T.buildLookupResponse({ companyId: NBD, from: '+18595550166', leads: couple.concat(couple) });
  ok('same lead returned by both queries counts once', dupe.known === true);
  const other = T.buildLookupResponse({ companyId: NBD, from: '+18595550166', leads: [Object.assign({}, couple[0], { companyId: OTHER })] });
  ok('second number never crosses tenants', other.known === false);

  const lead = { phone: '859-555-0177', phoneDigits: '8595550177', source: 'Referral' };
  const p1 = T.secondNumberPatch(lead, { from: '+18595550166' }, { callback_number: '8595550177' });
  ok('caller used another phone → remembered as altPhone', p1.altPhoneDigits === '8595550166' && !p1.phone, JSON.stringify(p1));
  ok('existing altPhone is never overwritten', Object.keys(T.secondNumberPatch(Object.assign({ altPhoneDigits: '5135550000' }, lead), { from: '+18595550166' }, {})).length === 0);
  ok('same number as the lead → nothing to add', Object.keys(T.secondNumberPatch(lead, { from: '+18595550177' }, {})).length === 0);
  const blank = T.secondNumberPatch({}, { from: '+15135550142' }, {});
  ok('lead without a phone gets the caller\'s number', blank.phone === '+15135550142' && blank.phoneDigits === '5135550142');
  const tt = T.secondNumberPatch({ phone: '+16695550199', phoneDigits: '6695550199', source: 'Thumbtack' }, { from: '+15135559876' }, {});
  ok('Thumbtack proxy lead learns the real number', tt.altPhoneDigits === '5135559876');
  ok('Thursday\'s own number is never stored', Object.keys(T.secondNumberPatch(lead, { from: '+15139405589' }, {})).length === 0);
  const m = T.matchLeads({ companyId: NBD, extraction: ex({}), call: call({ from: '+18595550166' }), leads: couple });
  ok('matcher attaches on the second number too', m.confidence === 'strong' && m.lead.leadId === 'c1');
}

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
