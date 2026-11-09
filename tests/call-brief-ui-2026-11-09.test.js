/**
 * tests/call-brief-ui-2026-11-09.test.js — Call to Close P0 step 5 + P0b: the
 * lazy review sheet docs/pro/js/call-brief-ui.js, run in a vm with a tiny
 * DOM stub. Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §4, §5.2.
 *
 *   1. nothing is ever pre-ticked: no checked box, no pressed / done state, no
 *      Apply-all, every field row starts on Accept / Edit / Skip
 *   2. the field diff: fill-empty (a filled field offers Skip only), the
 *      insurance-job warning on carrier / claim # / insurance job type only
 *   3. follow-up only when the call's date differs from the customer's
 *   4. the stage card is read-only; the proposal button only on the customer
 *      page; the Project Description seed is fixed phrases, no numbers, and
 *      empty when the customer already has a scope of work
 *   5. an unreliable brief shows the banner and the summary only
 *   6. escaping: transcript words never reach the DOM as markup
 *   7. CSP + boot: no inline handler or style, no <script> tag for the sheet
 *      in dashboard.html / customer.html, loaded through ScriptLoader
 *   8. the promise Add asks first, then sends callCenterAction promise with
 *      its slot; the who toggle flips the kind to waiting
 *
 * Run: node tests/call-brief-ui-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = read('docs/pro/js/call-brief-ui.js');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail)) : '')); }
}

function load(opts) {
  const o = opts || {};
  const listeners = {};
  const dlgEl = {
    className: '', innerHTML: '', open: false, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; if (k === 'open') this.open = false; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    showModal() { this.open = true; }, close() { this.open = false; (listeners.close || []).forEach((f) => f()); },
    contains() { return true; }, querySelector() { return null; },
  };
  const body = { kids: [], appendChild(x) { this.kids.push(x); }, contains(x) { return this.kids.includes(x); } };
  const calls = [];
  const win = {
    ScriptLoader: { load: async () => {}, loadBundle: async () => {} },
    _functions: {}, _httpsCallable: (_f, name) => async (data) => { calls.push({ name, data }); if (o.fail) { const e = o.fail(name, data); if (e) throw e; } return { data: name === 'callCenterAction' ? { ok: true, dueDate: data.dueYmd || '2026-11-06' } : { ok: true } }; },
    auth: { currentUser: { uid: 'jo' } },
  };
  const ctx = vm.createContext({ window: win, document: { createElement: () => dlgEl, body, querySelector: () => null }, console, setTimeout, Date, Event: function () {} });
  vm.runInContext(SRC, ctx);
  return { CB: win.NBDCallBrief, dlg: dlgEl, calls, listeners, win };
}

const BRIEF = {
  v: 1, transcriptOk: { reliable: true, cutOff: false, why: '' },
  summary: { text: 'Hail leak in the kitchen; State Farm claim.', quotes: ['the roof is leaking in the kitchen'], inferred: false },
  fields: {
    insCarrier: { value: 'State Farm', quote: 'My insurance is State Farm', conf: 'said' },
    claimNumber: { value: 'H44729', quote: 'the claim number is H as in Henry 4 4 7 2 9', conf: 'said' },
    dateOfLoss: { value: '2026-11-03', spoken: 'last Tuesday', quote: 'hail storm last Tuesday', conf: 'said' },
    adjusterName: { value: 'Dana Smith', quote: 'The adjuster, Dana Smith', conf: 'said' },
    adjusterMeetingYmd: null,
    damageType: { value: 'hail', quote: 'hail storm', conf: 'said' },
    jobType: { value: 'insurance', quote: 'My insurance is State Farm', conf: 'implied' },
    workKind: { value: 'replace', quote: 'We want a full replacement', conf: 'said' },
  },
  scope: { service: { value: 'Roof replacement', quote: 'full replacement' }, tierInterest: null, stories: { value: 2, quote: 'two stories' }, layers: null,
    mentions: { gutters: true, chimney: false, skylight: false, decking: false }, saidQuantities: [{ text: '28 squares', quote: 'about twenty-eight squares' }] },
  promises: [
    { who: 'jo', text: 'Send the estimate', kind: 'estimate', dueSpoken: 'by Friday', dueYmd: '2026-11-06', quote: 'I will send you the estimate by Friday' },
    { who: 'them', text: 'Send the adjuster report', kind: 'waiting', dueSpoken: '', dueYmd: '', quote: 'I will send you the adjuster report' },
  ],
  followUp: { value: '2026-11-10', spoken: 'Tuesday', quote: 'call me Tuesday', conf: 'said' },
  stage: { targetKey: 'claim_filed', label: 'Claim Filed', role: 'active', reason: 'A claim is open.', quote: 'the claim number is H as in Henry 4 4 7 2 9' },
  drafts: { estimate: true, proposal: true, followUp: null },
  flags: { injection: false, unreliable: false, cutOff: false }, people: [], objections: [], competitor: null,
};
const CALL = { startedAtMs: Date.parse('2026-11-05T15:00:00Z'), durationSec: 312, attachedBy: 'jo', leadId: 'L1', urgent: true };
const LEAD = { firstName: 'Pat', lastName: 'Example', insCarrier: '', claimNumber: '', damageType: 'wind', followUp: '2026-11-08', scopeOfWork: '' };
const clone = (x) => JSON.parse(JSON.stringify(x));

(async () => {
  console.log('\n1. Nothing pre-ticked');
  {
    const { CB } = load();
    CB._showWith({ brief: clone(BRIEF), call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'customer' });
    const html = CB._render();
    ok('no checked box anywhere', !/\schecked[\s>=]/.test(html) && !/type="checkbox"/.test(html));
    ok('nothing pressed', !/aria-pressed="true"/.test(html));
    ok('no Apply-all / bulk control', !/apply[- ]?all|accept all|select all/i.test(html) && !/data-cb-act="(apply|all|bulk)/.test(html));
    ok('no row starts filled in, added or skipped', !/cb-done|cb-skipped|Filled in|Added to the timeline/.test(html));
    const accepts = (html.match(/data-cb-act="accept"/g) || []).length;
    ok('every empty proposed field starts on Accept (5: carrier, claim #, date, adjuster, job type)', accepts === 5, accepts);
    ok('the only selected options are the promise kind pickers (preset to the model kind)', (html.match(/ selected/g) || []).length === 2);
    ok('the who toggle shows the model\'s guess as a radio, not an action', /role="radio" aria-checked="true" tabindex="0" data-cb-act="who" data-i="0" data-who="jo"/.test(html) && /aria-checked="true" tabindex="0" data-cb-act="who" data-i="1" data-who="them"/.test(html));
    ok('promises need Add (no promise is sent on render)', (html.match(/data-cb-act="promise"/g) || []).length === 2);
    const rows = CB._fieldRows(BRIEF, LEAD);
    ok('_fieldRows never carries a selected / accepted flag', rows.every((r) => !('selected' in r) && !('accepted' in r) && !('checked' in r)));
  }

  console.log('\n2. Field diff');
  {
    const { CB } = load();
    const rows = CB._fieldRows(BRIEF, LEAD);
    ok('workKind is not a lead field row', !rows.some((r) => r.key === 'workKind'));
    const dmg = rows.find((r) => r.key === 'damageType');
    ok('a filled field is flagged filled, with its current value', dmg.filled === true && dmg.current === 'wind');
    CB._showWith({ brief: clone(BRIEF), call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'customer' });
    const html = CB._render();
    const dmgRow = html.split('data-cb-row="field:damageType"')[1].split('data-cb-row=')[0];
    ok('…and offers Skip only (no Accept, no Edit)', /Already filled in/.test(dmgRow) && !/data-cb-act="accept"/.test(dmgRow) && !/data-cb-act="edit"/.test(dmgRow) && /data-cb-act="skip"/.test(dmgRow));
    ok('carrier and claim # carry the insurance-job warning', rows.find((r) => r.key === 'insCarrier').warn === CB.INSURANCE_WARN && rows.find((r) => r.key === 'claimNumber').warn === CB.INSURANCE_WARN);
    ok('…an insurance job type too', rows.find((r) => r.key === 'jobType').warn === CB.INSURANCE_WARN);
    ok('date of loss and adjuster name carry no warning (they do not flip isInsurance)', rows.find((r) => r.key === 'dateOfLoss').warn === '' && rows.find((r) => r.key === 'adjusterName').warn === '');
    ok('the warning names Kentucky', /Kentucky notices and the cancellation form will apply/.test(CB.INSURANCE_WARN));
    ok('a cash job type has no warning', CB._warnFor('jobType', 'cash') === '');
    const meetBrief = clone(BRIEF);
    meetBrief.fields.adjusterMeetingYmd = { value: '2026-11-12', spoken: 'next Thursday', quote: 'the adjuster comes next Thursday', conf: 'said' };
    const meet = CB._fieldRows(meetBrief, LEAD).find((r) => r.key === 'adjusterMeetingYmd');
    ok('the adjuster meeting is labelled: it goes on the calendar (and Google Calendar)', meet && meet.warn === CB.CALENDAR_WARN && /calendar/.test(CB.CALENDAR_WARN) && /Google Calendar/.test(CB.CALENDAR_WARN), meet);
    ok('a field the customer already has with the same value is not a row', !CB._fieldRows(BRIEF, Object.assign({}, LEAD, { jobType: 'Insurance' })).some((r) => r.key === 'jobType'));
    ok('a filled field shows no insurance warning (nothing will change)', CB._fieldRows(BRIEF, Object.assign({}, LEAD, { insCarrier: 'Allstate' })).find((r) => r.key === 'insCarrier').warn === '');
    const viaAlias = CB._fieldRows(BRIEF, Object.assign({}, LEAD, { insCarrier: '', insuranceCarrier: 'Allstate' })).find((r) => r.key === 'insCarrier');
    ok('a carrier held under insuranceCarrier shows as filled ("Now: Allstate"), not empty', viaAlias && viaAlias.filled === true && viaAlias.current === 'Allstate' && viaAlias.warn === '', viaAlias);
    ok('…insuranceCompany and carrier count too', ['insuranceCompany', 'carrier'].every((k) => CB._fieldRows(BRIEF, Object.assign({}, LEAD, { [k]: 'Allstate' })).find((r) => r.key === 'insCarrier').filled === true));
    ok('the sheet\'s aliases match the server\'s (call-brief-logic LEAD_FIELD_ALIASES)', JSON.stringify(CB.LEAD_FIELD_ALIASES) === JSON.stringify(require(path.join(ROOT, 'functions', 'call-brief-logic.js')).LEAD_FIELD_ALIASES));
    ok('a same-value carrier under an alias is not a row', !CB._fieldRows(BRIEF, Object.assign({}, LEAD, { insuranceCarrier: 'state farm' })).some((r) => r.key === 'insCarrier'));
    ok('quotes and said / implied are shown', /&ldquo;My insurance is State Farm&rdquo;/.test(html) && /cb-badge">implied/.test(html));
  }

  console.log('\n3. Follow-up');
  {
    const { CB } = load();
    ok('a different date → offered', JSON.stringify(CB._followUpChange(BRIEF, LEAD)) === JSON.stringify({ to: '2026-11-10', from: '2026-11-08', quote: 'call me Tuesday' }));
    ok('the same date → not offered', CB._followUpChange(BRIEF, Object.assign({}, LEAD, { followUp: '2026-11-10' })) === null);
    ok('no date on the brief → not offered', CB._followUpChange(Object.assign({}, BRIEF, { followUp: null }), LEAD) === null);
    CB._showWith({ brief: Object.assign(clone(BRIEF), { followUp: null }), call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'customer' });
    ok('…and the section is absent', !/cbFuH/.test(CB._render()));
  }

  console.log('\n4. Stage, drafts, the proposal seed');
  {
    const { CB } = load();
    CB._showWith({ brief: clone(BRIEF), call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'customer' });
    const html = CB._render();
    ok('the stage card is read-only: "Suggests: Claim Filed, because …"', /Suggests: <strong>Claim Filed<\/strong>, because a claim is open/.test(html) && /Nothing moves from here/.test(html));
    ok('the sheet never moves a stage itself', !/commitStageChange|updateDoc\([^)]*stage/i.test(SRC));
    ok('customer page: one filled button in the drafts region, "Draft proposal"', /data-cb-act="proposal"/.test(html) && (html.split('id="cbDraftH"')[1].split('cb-foot')[0].match(/btn-orange/g) || []).length === 1);
    CB._showWith({ brief: clone(BRIEF), call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'calls' });
    const h2 = CB._render();
    ok('Call Center: no proposal button, a link to the customer instead', !/data-cb-act="proposal"/.test(h2) && /Open the customer to draft a proposal/.test(h2));
    const seed = CB._projectSeed(BRIEF, LEAD);
    ok('the seed is fixed phrases from the choices', seed === 'Complete roof replacement for hail damage, including gutters.', seed);
    ok('the seed carries no number or dollar sign', !/[\d$]/.test(seed));
    ok('no seed when the customer already has a scope of work', CB._projectSeed(BRIEF, Object.assign({}, LEAD, { scopeOfWork: 'Already written' })) === '');
    ok('a repair call seeds "Roof repair"', /^Roof repair/.test(CB._projectSeed(Object.assign(clone(BRIEF), { fields: Object.assign(clone(BRIEF.fields), { workKind: { value: 'repair' } }) }), LEAD)));
    // Review #12: the seed is built from fixed phrases only, never the model's words.
    const noKind = (service, damage) => { const b = clone(BRIEF); b.fields.workKind = null; b.scope.service = service ? { value: service, quote: 'x' } : null; b.fields.damageType = damage ? { value: damage, quote: 'x' } : null; return CB._projectSeed(b, LEAD); };
    ok('no workKind: a service that says replace → the fixed replacement phrase', noKind('Full reroof with ridge vent, replace it all', 'hail') === 'Complete roof replacement for hail damage, including gutters.', noKind('Full reroof with ridge vent, replace it all', 'hail'));
    ok('no workKind: a service that says repair → "Roof repair"', /^Roof repair\b/.test(noKind('Repair the flashing by the chimney', '')), noKind('Repair the flashing by the chimney', ''));
    ok('no workKind and a service in other words → no seed (the model\'s wording is never pasted)', noKind('Siding and new windows on the back', 'hail') === '');
    ok('a damage type in the model\'s words → only a fixed damage word, or none', noKind('replacement', 'big nasty hail from the 2025 storm') === 'Complete roof replacement for hail damage, including gutters.'
      && noKind('replacement', 'weird stuff on the shingles') === 'Complete roof replacement, including gutters.', [noKind('replacement', 'big nasty hail from the 2025 storm'), noKind('replacement', 'weird stuff on the shingles')]);
    ok('scope items are never seeded (only the description field is touched)', /data-field="projectDescription"/.test(SRC) && !/data-field="scopeItems"/.test(SRC) && /DocPreflight\.open\('proposal', leadId\)/.test(SRC));
    ok('the "From the call" list shows the said quantity as a quote', CB._scopeHints(BRIEF).some((h) => h === 'Said: "about twenty-eight squares"'));
    ok('the seed is only set when the field is empty', /if \(seed && !String\(ta\.value \|\| ''\)\.trim\(\)\)/.test(SRC));
  }

  console.log('\n5. Unreliable');
  {
    const { CB } = load();
    const b = clone(BRIEF);
    b.transcriptOk = { reliable: false, cutOff: false, why: 'Looks like Spanish' };
    Object.keys(b.fields).forEach((k) => { b.fields[k] = null; });
    b.promises = []; b.stage = null; b.followUp = null;
    CB._showWith({ brief: b, call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'customer' });
    const html = CB._render();
    ok('the banner says listen to the recording', /Transcript unreliable, listen to the recording/.test(html) && /Looks like Spanish/.test(html));
    ok('no field, promise or stage section', !/cbFieldH|cbPromH|cbStageH/.test(html) && /cbSumH/.test(html));
  }

  console.log('\n6. Escaping');
  {
    const { CB } = load();
    const b = clone(BRIEF);
    b.summary.text = '<img src=x onerror=alert(1)> leak';
    b.summary.quotes = ['<script>alert(1)</script>'];
    b.fields.adjusterName.value = '"><svg onload=alert(1)>';
    b.promises[0].text = '<b>bold</b>';
    CB._showWith({ brief: b, call: CALL, lead: Object.assign(clone(LEAD), { firstName: '<i>Pat</i>' }), leadId: 'L1', page: 'customer' });
    const html = CB._render();
    ok('no raw tags from the transcript or the lead', !/<img|<script|<svg|<b>bold|<i>Pat/.test(html));
    ok('…they arrive escaped', /&lt;img src=x onerror=alert\(1\)&gt;/.test(html) && /&lt;i&gt;Pat&lt;\/i&gt;/.test(html));
  }

  console.log('\n7. CSP and boot');
  {
    ok('no inline on*= handler in any HTML the sheet builds', !/\son[a-z]+=\\?["']/i.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')));
    ok('no style= attribute in the sheet', !/style=/.test(SRC));
    ok('no <script> in the sheet', !/<script/i.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/'<script>alert/g, '')));
    for (const page of ['docs/pro/dashboard.html', 'docs/pro/customer.html']) {
      ok(page + ' has no <script> tag for the sheet (it loads on tap)', !/call-brief-ui\.js/.test(read(page)) && !/call-brief\.css/.test(read(page)));
    }
    ok('the stylesheet loads with the sheet through ScriptLoader', /CSS_HREF = '\/pro\/css\/call-brief\.css\?v=1'/.test(SRC) && /ScriptLoader\.load\(CSS_HREF\)/.test(SRC));
    const css = read('docs/pro/css/call-brief.css');
    ok('the sheet CSS: 44px targets, no transition:all, no hex outside var() fallbacks', /min-height: 44px/.test(css) && !/transition:\s*all/.test(css) && !(css.replace(/var\([^()]*(\([^()]*\))?[^()]*\)/g, '').match(/#[0-9a-f]{3,8}\b/gi)));
    ok('a bottom sheet on phones', /@media \(max-width: 600px\)[\s\S]*\.cb-sheet \{[^}]*margin: auto 0 0/.test(css));
  }

  console.log('\n8. Promises: ask first, then the slot');
  {
    const { CB, dlg, calls, listeners } = load();
    CB._showWith({ callId: 'cube_ABCDE12345', brief: clone(BRIEF), call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'customer' });
    const click = async (attrs) => {
      const b = { disabled: false, getAttribute: (k) => (k in attrs ? attrs[k] : null), closest: () => b };
      for (const fn of listeners.click) fn({ target: b });
      await new Promise((r) => setTimeout(r, 5));
    };
    await click({ 'data-cb-act': 'promise', 'data-i': '1' });
    ok('Add asks first ("…marks the call handled"), nothing sent yet', /marks the call handled/.test(dlg.innerHTML) && calls.length === 0);
    await click({ 'data-cb-act': 'promise-yes', 'data-i': '1' });
    const p = calls.find((c) => c.name === 'callCenterAction');
    ok('confirm → callCenterAction promise with slot 1, waiting on the customer', p && p.data.action === 'promise' && p.data.slot === 1 && p.data.kind === 'waiting' && p.data.waitingOn === 'customer' && p.data.id === 'cube_ABCDE12345', p);
    await click({ 'data-cb-act': 'who', 'data-i': '0', 'data-who': 'them' });
    ok('the who toggle flips Jo\'s promise to a waiting chase', /cbKind-0[^>]*>[\s\S]*?value="waiting" selected/.test(dlg.innerHTML));
    await click({ 'data-cb-act': 'who', 'data-i': '0', 'data-who': 'jo' });
    ok('…and back to the model\'s kind', /value="estimate" selected/.test(dlg.innerHTML));
    await click({ 'data-cb-act': 'accept', 'data-k': 'claimNumber' });
    ok('Accept on claim # asks with the warning first, nothing sent', /Kentucky notices[\s\S]*Fill it in\?/.test(dlg.innerHTML) && !calls.some((c) => c.name === 'callBriefDecide' && /claimNumber/.test(c.data.item)));
    await click({ 'data-cb-act': 'accept-yes', 'data-k': 'claimNumber' });
    const d = calls.find((c) => c.name === 'callBriefDecide' && c.data.item === 'field:claimNumber');
    ok('…then one decide call for that one field, with the acknowledgement', d && d.data.decision === 'accept' && d.data.confirmedInsurance === true);
    await click({ 'data-cb-act': 'accept', 'data-k': 'adjusterName' });
    const d2 = calls.find((c) => c.name === 'callBriefDecide' && c.data.item === 'field:adjusterName');
    ok('a field with no warning accepts on one tap, without the acknowledgement', d2 && d2.data.confirmedInsurance === false);
  }
  {
    const { CB, dlg, calls, listeners } = load();
    const b = clone(BRIEF);
    b.fields.adjusterMeetingYmd = { value: '2026-11-12', spoken: 'next Thursday', quote: 'the adjuster comes next Thursday', conf: 'said' };
    CB._showWith({ callId: 'cube_ABCDE12345', brief: b, call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'customer' });
    const click = async (attrs) => {
      const btn = { disabled: false, getAttribute: (k) => (k in attrs ? attrs[k] : null), closest: () => btn };
      for (const fn of listeners.click) fn({ target: btn });
      await new Promise((r) => setTimeout(r, 5));
    };
    await click({ 'data-cb-act': 'accept', 'data-k': 'adjusterMeetingYmd' });
    ok('Accept on the adjuster meeting asks first (calendar label), nothing sent', /Google Calendar[\s\S]*Fill it in\?/.test(dlg.innerHTML) && !calls.some((c) => c.name === 'callBriefDecide'));
    await click({ 'data-cb-act': 'accept-yes', 'data-k': 'adjusterMeetingYmd' });
    const d = calls.find((c) => c.name === 'callBriefDecide' && c.data.item === 'field:adjusterMeetingYmd');
    ok('…then sends it with the calendar confirm', d && d.data.confirmedCalendar === true, d);
  }

  console.log('\n9. Brief promises never touch slot 0 (review 2026-11-09 #1/#10)');
  {
    const mkClick = (listeners) => async (attrs) => {
      const b = { disabled: false, getAttribute: (k) => (k in attrs ? attrs[k] : null), closest: () => b };
      for (const fn of listeners.click) fn({ target: b });
      await new Promise((r) => setTimeout(r, 5));
    };
    const slots = (calls) => calls.filter((c) => c.name === 'callCenterAction').map((c) => c.data.slot);
    {
      const { CB, calls, listeners, dlg } = load();
      CB._showWith({ callId: 'cube_ABCDE12345', brief: clone(BRIEF), call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'customer' });
      const click = mkClick(listeners);
      await click({ 'data-cb-act': 'promise', 'data-i': '0' });
      ok('the confirm says it adds a new task and never changes a promise already on the customer', /adds a new task/.test(dlg.innerHTML) && /never changes/.test(dlg.innerHTML));
      await click({ 'data-cb-act': 'promise-yes', 'data-i': '0' });
      await click({ 'data-cb-act': 'promise', 'data-i': '1' });
      await click({ 'data-cb-act': 'promise-yes', 'data-i': '1' });
      ok('the brief\'s first promise goes to slot 1, the next to slot 2 (slot 0 is the card\'s Promise button)', JSON.stringify(slots(calls)) === '[1,2]', slots(calls));
      const logged = calls.filter((c) => c.name === 'callBriefDecide' && /^promise:/.test(c.data.item)).map((c) => c.data.slot);
      ok('…and each decision records its slot', JSON.stringify(logged) === '[1,2]', logged);
    }
    {
      const { CB, calls, listeners } = load();
      CB._showWith({ callId: 'cube_ABCDE12345', brief: clone(BRIEF), call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'customer',
        decisions: [{ item: 'promise:0', decision: 'accept', slot: 1, gen: 1 }] });
      const click = mkClick(listeners);
      await click({ 'data-cb-act': 'promise', 'data-i': '1' });
      await click({ 'data-cb-act': 'promise-yes', 'data-i': '1' });
      ok('a slot used by an earlier Add (any brief) is skipped', JSON.stringify(slots(calls)) === '[2]', slots(calls));
    }
    {
      const taken = new Set([1]);
      const { CB, calls, listeners, dlg } = load({ fail: (name, data) => (name === 'callCenterAction' && taken.has(data.slot) ? new Error('That promise is already on the customer.') : null) });
      CB._showWith({ callId: 'cube_ABCDE12345', brief: clone(BRIEF), call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'customer' });
      const click = mkClick(listeners);
      await click({ 'data-cb-act': 'promise', 'data-i': '0' });
      await click({ 'data-cb-act': 'promise-yes', 'data-i': '0' });
      ok('a slot the server says is taken → the next free slot, never an overwrite', JSON.stringify(slots(calls)) === '[1,2]' && /cb-done/.test(dlg.innerHTML), slots(calls));
    }
    ok('the sheet never sends slot: i (the brief index)', !/slot: i\b/.test(SRC));
  }

  console.log('\n10. The You / Them radiogroup works from the keyboard (review #17)');
  {
    const { CB, dlg, listeners } = load();
    CB._showWith({ callId: 'cube_ABCDE12345', brief: clone(BRIEF), call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'customer' });
    const html = CB._render();
    ok('roving tabindex: the checked radio is in the tab order, the other is not', /role="radio" aria-checked="true" tabindex="0" data-cb-act="who" data-i="0" data-who="jo"/.test(html) && /role="radio" aria-checked="false" tabindex="-1" data-cb-act="who" data-i="0" data-who="them"/.test(html), html.match(/role="radio"[^>]*/g));
    let prevented = false;
    const target = { getAttribute: (k) => ({ 'data-cb-act': 'who', 'data-i': '0', 'data-who': 'jo' })[k] || null, closest: () => target };
    (listeners.keydown || []).forEach((fn) => fn({ key: 'ArrowRight', target, preventDefault: () => { prevented = true; } }));
    ok('ArrowRight moves the choice to Them (and flips the kind to waiting)', prevented && /aria-checked="true" tabindex="0" data-cb-act="who" data-i="0" data-who="them"/.test(dlg.innerHTML) && /cbKind-0[^>]*>[\s\S]*?value="waiting" selected/.test(dlg.innerHTML));
    let p2 = false;
    const t2 = { getAttribute: (k) => ({ 'data-cb-act': 'who', 'data-i': '0', 'data-who': 'them' })[k] || null, closest: () => t2 };
    (listeners.keydown || []).forEach((fn) => fn({ key: 'ArrowUp', target: t2, preventDefault: () => { p2 = true; } }));
    ok('ArrowUp moves it back to You', p2 && /aria-checked="true" tabindex="0" data-cb-act="who" data-i="0" data-who="jo"/.test(dlg.innerHTML));
    let p3 = false;
    (listeners.keydown || []).forEach((fn) => fn({ key: 'a', target: t2, preventDefault: () => { p3 = true; } }));
    ok('other keys are left alone', !p3);
  }

  console.log('\n11. A regenerated brief does not inherit index-keyed decisions (review #14)');
  {
    const { CB } = load();
    const old = [{ item: 'promise:0', decision: 'accept', slot: 1, gen: 100 }, { item: 'field:insCarrier', decision: 'skip', gen: 100 }];
    CB._showWith({ brief: clone(BRIEF), generatedAtMs: 200, decisions: old, call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'customer' });
    const html = CB._render();
    ok('a decision from an earlier brief does not mark this brief\'s promise 0 Added', /data-cb-act="promise" data-i="0"/.test(html));
    ok('…nor this brief\'s carrier row Skipped', /data-cb-act="accept" data-k="insCarrier"/.test(html.split('data-cb-row="field:insCarrier"')[1].split('data-cb-row=')[0]));
    CB._showWith({ brief: clone(BRIEF), generatedAtMs: 100, decisions: old, call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'customer' });
    const same = CB._render();
    ok('the same brief still shows its own decisions', !/data-cb-act="promise" data-i="0"/.test(same) && /cb-skipped/.test(same.split('data-cb-row="field:insCarrier"')[1].split('data-cb-row=')[0]));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
