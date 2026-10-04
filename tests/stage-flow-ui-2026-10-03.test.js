/**
 * tests/stage-flow-ui-2026-10-03.test.js — moving a job through stages on a phone.
 *
 *  1. Scheduling the build offers "Move to Crew Scheduled?" — only when that
 *     is a forward move on the lead's own track (schedule-planner-logic.js
 *     crewMoveOffer), and the tap goes through moveCard → commitStageChange.
 *  2. The required-field block no longer leaves the customer page: the
 *     stage-gate sheet (stage-gate-sheet.js) asks for just the missing fields
 *     and its patch is re-checked against the real gate.
 *  3. Don't ask for what the CRM has: "Estimate $" pre-fills from the primary
 *     estimate; "No permit required" answers the permit gate and nothing else.
 *  5. Door-knock outcomes: "Appointment" and "Needs to file" land on
 *     Contacted (not Inspected / Claim Filed); the follow-up date is the LOCAL
 *     day; an appointment is booked through the one event writer.
 *  6. The customer page's milestone list uses the board's stage labels
 *     (Closed was "Warranty Registered").
 *
 * Run: node tests/stage-flow-ui-2026-10-03.test.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'docs', 'pro', 'js');
// A missing file reads as '' so every check still reports (break-test vs main).
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); } catch (_) { return ''; } };
const tryRequire = (f) => { try { return require(path.join(JS, f)); } catch (e) { return null; } };

// crm-stages (ES module) — strip-and-vm, as crm-required-fields.test.js.
let cs = read('docs/pro/js/crm-stages.js');
cs = cs.replace(/export\s+function\s+/g, 'function ').replace(/export\s+const\s+/g, 'const ');
cs += '\nthis.__out = { missingRequiredFields, stageOptionsForType, stageRole, normalizeStage, requiredFieldLabel, STAGE_META };';
const csb = { console, window: {} };
vm.runInNewContext(cs, csb);
const { missingRequiredFields, stageOptionsForType, stageRole, normalizeStage, requiredFieldLabel, STAGE_META } = csb.__out;
const track = (jt) => stageOptionsForType(jt).map((o) => o.value);

// ── 1. schedule → crew scheduled offer ───────────────────────────────────
console.log('\n1. scheduling the build offers the stage move');
{
  const P = tryRequire('schedule-planner-logic.js');
  const offer = P && P.crewMoveOffer;
  ok('schedule-planner-logic exports crewMoveOffer', typeof offer === 'function');
  if (typeof offer === 'function') {
    const o = { normalize: normalizeStage, roleOf: stageRole };
    const L = (stage, jobType) => ({ id: 'x', stage, jobType });
    ok('materials delivered (insurance) → offered', offer(L('materials_delivered', 'insurance'), track('insurance'), o) === true);
    ok('contract signed (cash) → offered', offer(L('contract_signed', 'cash'), track('cash'), o) === true);
    ok('job created (finance) → offered', offer(L('job_created', 'finance'), track('finance'), o) === true);
    ok('already Crew Scheduled → not offered', offer(L('crew_scheduled', 'insurance'), track('insurance'), o) === false);
    ok('installing (past it) → not offered (a backward move)', offer(L('install_in_progress', 'insurance'), track('insurance'), o) === false);
    ok('closed → not offered', offer(L('closed', 'cash'), track('cash'), o) === false);
    ok('lost → not offered', offer(L('lost', 'insurance'), track('insurance'), o) === false);
    ok('an estimate-stage lead (Show all open leads) → not offered', offer(L('estimate_submitted', 'insurance'), track('insurance'), o) === false);
    ok('warranty track (no Crew Scheduled on it) → not offered', offer(L('warranty_scheduled', 'warranty'), track('warranty'), o) === false);
    ok('service track → not offered', offer(L('service_approved', 'service'), track('service'), o) === false);
    ok('no track known → not offered', offer(L('materials_delivered', 'insurance'), [], o) === false);
  }
  const ui = read('docs/pro/js/schedule-planner.js');
  ok('a date save (not a week, not a clear) arms the offer', /if \(!clear && out\.fields\.scheduledDate && offerFor\(lead\)\) _offer\[id\] = true;/.test(ui));
  ok('the chip moves the stage through moveCard (commitStageChange + every gate)', /window\.moveCard\(id, 'crew_scheduled'\)/.test(ui) && /commitStageChange\(id, 'crew_scheduled'/.test(ui));
  ok('the chip is a delegated data-sp-action, not an inline handler', /data-sp-action="stage"/.test(ui) && !/onclick=/i.test(ui));
  ok('the planner save path itself writes no stage', !/stage:\s*'crew_scheduled'/.test(ui.slice(ui.indexOf('async function save('), ui.indexOf('document.addEventListener(\'click\''))));
}

// ── 2 + 3. the stage-gate sheet ──────────────────────────────────────────
console.log('\n2/3. stage-gate sheet: only the missing fields, pre-filled, re-checked');
{
  const G = tryRequire('stage-gate-sheet.js');
  ok('stage-gate-sheet.js loads in node (pure rules exported)', !!(G && G.buildPatch && G.planFields));
  if (G && G.buildPatch) {
    const NOW = '2026-10-03T15:00:00.000Z';
    // Insurance → Contract Signed needs Estimate $; the primary estimate has it.
    const lead = { id: 'L1', jobType: 'insurance', stage: 'supplement_approved', primaryEstimateId: 'E2' };
    const ests = [{ id: 'E1', grandTotal: 9000 }, { id: 'E2', grandTotal: '18,450.50' }];
    const miss = missingRequiredFields(Object.assign({}, lead, { stage: 'contract_signed' }));
    ok('the gate asks for Estimate $ at insurance Contract Signed', JSON.stringify(miss) === '["estimateAmount"]', JSON.stringify(miss));
    const fields = G.planFields(lead, miss, { estimates: ests, labelFor: requiredFieldLabel });
    ok('Estimate $ is pre-filled from the PRIMARY estimate (not the first one)', fields[0].value === '18450.5', fields[0].value);
    ok('…labelled for a human', fields[0].label === 'Estimate $');
    ok('no primary estimate → no pre-fill (no guessing)', G.planFields({ jobType: 'insurance' }, miss, { estimates: ests })[0].value === '');
    ok('a $0 primary estimate → no pre-fill', G.planFields({ primaryEstimateId: 'Z' }, miss, { estimates: [{ id: 'Z', grandTotal: 0 }] })[0].value === '');
    const r = G.buildPatch(lead, 'contract_signed', fields, { estimateAmount: fields[0].value }, { nowIso: NOW, missingFn: missingRequiredFields });
    ok('accepting the pre-fill saves it as a number and clears the gate', r.ok && r.patch.estimateAmount === 18450.5, JSON.stringify(r));
    ok('a blank Estimate $ keeps the move blocked', !G.buildPatch(lead, 'contract_signed', fields, { estimateAmount: '' }, { missingFn: missingRequiredFields }).ok);
    ok('$0 is not an Estimate $', !G.buildPatch(lead, 'contract_signed', fields, { estimateAmount: '0' }, { missingFn: missingRequiredFields }).ok);

    // Materials Ordered needs Permit Filed; "No permit required" answers it.
    const job = { id: 'L2', jobType: 'cash', stage: 'job_created', contractFiledAt: '2026-09-01T00:00:00Z' };
    const pm = missingRequiredFields(Object.assign({}, job, { stage: 'materials_ordered' }));
    ok('the gate asks for Permit Filed at Materials Ordered', JSON.stringify(pm) === '["permitFiledAt"]', JSON.stringify(pm));
    const pf = G.planFields(job, pm, { labelFor: requiredFieldLabel });
    ok('the permit field offers two answers (filed / not required)', pf[0].kind === 'permit');
    const none = G.buildPatch(job, 'materials_ordered', pf, { permitFiledAt: 'none' }, { nowIso: NOW, missingFn: missingRequiredFields });
    ok('"No permit required" satisfies the gate', none.ok, JSON.stringify(none));
    ok('…and is RECORDED as not required (never a fake filed stamp)', none.ok && none.patch.permitNotRequired === true && none.patch.permitNotRequiredAt === NOW && !none.patch.permitFiledAt);
    const filed = G.buildPatch(job, 'materials_ordered', pf, { permitFiledAt: 'filed' }, { nowIso: NOW, missingFn: missingRequiredFields });
    ok('"Permit filed" stamps permitFiledAt', filed.ok && filed.patch.permitFiledAt === NOW);
    ok('no answer → still blocked', !G.buildPatch(job, 'materials_ordered', pf, {}, { missingFn: missingRequiredFields }).ok);

    // Job type first, then that type's fields.
    const untyped = { id: 'L3', stage: 'contacted' };
    const jm = missingRequiredFields(Object.assign({}, untyped, { stage: 'crew_scheduled' }));
    ok('an untyped lead is asked for its job type first', JSON.stringify(jm) === '["jobType"]', JSON.stringify(jm));
    const jf = G.planFields(untyped, ['jobType', 'scheduledDate'], { labelFor: requiredFieldLabel });
    const jr = G.buildPatch(untyped, 'crew_scheduled', jf, { jobType: 'cash', scheduledDate: '2026-10-09' }, { missingFn: missingRequiredFields });
    ok('job type + its date together clear the Crew Scheduled gate', jr.ok && jr.patch.jobType === 'cash', JSON.stringify(jr));
    const partial = G.buildPatch(untyped, 'crew_scheduled', G.planFields(untyped, ['jobType'], {}), { jobType: 'cash' }, { missingFn: missingRequiredFields });
    ok('the patch is re-checked against the REAL gate (job type alone is not enough)', !partial.ok && partial.missing && partial.missing.includes('scheduledDate'), JSON.stringify(partial));

    // Crew Scheduled date; filed attestations.
    const crew = G.buildPatch({ jobType: 'cash' }, 'crew_scheduled', G.planFields({}, ['scheduledDate'], {}), { scheduledDate: '2026-10-09' }, { missingFn: missingRequiredFields });
    ok('a picked date satisfies Crew Scheduled', crew.ok && crew.patch.scheduledDate === '2026-10-09');
    ok('a non-date is refused', !G.buildPatch({ jobType: 'cash' }, 'crew_scheduled', G.planFields({}, ['scheduledDate'], {}), { scheduledDate: 'soon' }, {}).ok);
    const cf = G.buildPatch({ jobType: 'cash' }, 'job_created', G.planFields({}, ['contractFiledAt'], {}), { contractFiledAt: true }, { nowIso: NOW, missingFn: missingRequiredFields });
    ok('"contract is on file" stamps contractFiledAt', cf.ok && cf.patch.contractFiledAt === NOW);
    ok('an unticked attestation is refused', !G.buildPatch({}, 'job_created', G.planFields({}, ['contractFiledAt'], {}), { contractFiledAt: false }, {}).ok);
  }

  // The gate itself: "no permit" answers permitFiledAt ONLY.
  const base = { jobType: 'insurance', permitNotRequired: true };
  ok('gate: permitNotRequired clears Materials Ordered on every track',
    ['insurance', 'cash', 'finance', 'warranty', 'service'].every((jt) => missingRequiredFields({ jobType: jt, permitNotRequired: true, stage: 'materials_ordered' }).length === 0));
  ok('gate: permitNotRequired does NOT clear the contract at Job Created', JSON.stringify(missingRequiredFields(Object.assign({}, base, { stage: 'job_created' }))) === '["contractFiledAt"]');
  ok('gate: …nor Crew Scheduled', JSON.stringify(missingRequiredFields(Object.assign({}, base, { stage: 'crew_scheduled' }))) === '["scheduledDate"]');
  ok('gate: …nor insurance Closed', missingRequiredFields(Object.assign({}, base, { stage: 'closed' })).length === 2);
  ok('gate: a truthy-but-not-true flag ("yes") does not count', missingRequiredFields({ jobType: 'cash', permitNotRequired: 'yes', stage: 'materials_ordered' }).length === 1);
  ok('gate: no flag → permit still required', missingRequiredFields({ jobType: 'cash', stage: 'materials_ordered' }).length === 1);

  const boot = read('docs/pro/js/customer-bootstrap.module.js');
  const ps = boot.slice(boot.indexOf('window.progressStage = async function'));
  const gate = ps.slice(0, ps.indexOf('Warranty-claim guard'));
  ok('customer page: the gate opens the sheet with the real gate as missingFn', /await sheet\.open\(\{/.test(gate) && /missingFn: _missingRequiredFields/.test(gate));
  ok('customer page: it saves the patch on the lead, then the move continues', /updateDoc\(doc\(db, 'leads', window\._customerId\), \{ \.\.\.patch/.test(gate) && /if \(!saved\) return;/.test(gate));
  ok('customer page: no page exit left in the gate', !/location\.href/.test(gate) && !/Open full editor/.test(gate.replace(/\/\/.*$/gm, '')));
  const html = read('docs/pro/customer.html');
  ok('customer.html loads the sheet + its stylesheet', /<script defer src="js\/stage-gate-sheet\.js\?v=\d+"><\/script>/.test(html) && /css\/stage-gate-sheet\.css\?v=\d+/.test(html));
  const sheetSrc = read('docs/pro/js/stage-gate-sheet.js');
  ok('sheet: no inline handlers / style attributes (CSP)', !/\son[a-z]+=/i.test(sheetSrc.replace(/\/\*[\s\S]*?\*\//g, '')) && !/style="/.test(sheetSrc));
  const css = read('docs/pro/css/stage-gate-sheet.css');
  ok('sheet: 44px targets, 16px inputs, safe-area padding', /min-height: 44px/.test(css) && /font-size: 16px/.test(css) && /safe-area-inset-bottom/.test(css));
}

// ── 5. door-knock outcomes ──────────────────────────────────────────────
console.log('\n5. door-knock outcome → CRM');
{
  const K = tryRequire('d2d-knock-lead-logic.js');
  ok('d2d-knock-lead-logic.js loads', !!(K && K.stageForDisposition));
  if (K && K.stageForDisposition) {
    ok('"Appointment Set" lands on Contacted (not Inspected)', K.stageForDisposition('appointment') === 'contacted');
    ok('"Needs to file" lands on Contacted (not Claim Filed)', K.stageForDisposition('ins_needs_file') === 'contacted');
    ok('"Has a claim" still lands on Claim Filed (their claim exists)', K.stageForDisposition('ins_has_claim') === 'claim_filed');
    ok('interested / callback / storm → Contacted', ['interested', 'callback', 'storm_damage', 'left_material'].every((d) => K.stageForDisposition(d) === 'contacted'));
    ok('no knock outcome lands on Inspected', ['appointment', 'interested', 'callback', 'left_material', 'storm_damage', 'ins_has_claim', 'ins_needs_file', 'ins_denied', 'not_home', 'not_interested'].every((d) => K.stageForDisposition(d) !== 'inspected'));
    // 9:30pm local on Oct 3 is Oct 4 in UTC west of Greenwich — the old bug.
    const late = new Date(2026, 9, 3, 23, 30);
    ok('localYmd is the LOCAL calendar day', K.localYmd(late) === '2026-10-03', K.localYmd(late));
    ok('followUpYmd keeps a YYYY-MM-DD string as is', K.followUpYmd('2026-10-05') === '2026-10-05');
    ok('followUpYmd of a local-midnight Date is that day', K.followUpYmd(new Date(2026, 9, 5)) === '2026-10-05');
    ok('followUpYmd reads a Firestore Timestamp shape', K.followUpYmd({ toDate: () => new Date(2026, 9, 6, 23, 59) }) === '2026-10-06');
    const appt = K.appointmentWhen('2026-10-06T14:30');
    ok('a datetime-local appointment reads as local time', appt && appt.getHours() === 14 && appt.getMinutes() === 30 && appt.getDate() === 6);
    ok('garbage appointment → null', K.appointmentWhen('tomorrow-ish') === null);
  }
  const E = tryRequire('lead-events.js');
  ok('lead-events.js (the one event writer) loads', !!(E && E.build));
  if (E && E.build) {
    const ev = E.build('L9', { title: 'Inspection appointment', when: new Date(2026, 9, 6, 14, 30), source: 'd2d' }, { uid: 'u1', email: 'jo@x' });
    ok('an appointment is a type:event task with its time', ev && ev.type === 'event' && ev.leadId === 'L9' && ev.userId === 'u1' && ev.eventAt === new Date(2026, 9, 6, 14, 30).toISOString() && ev.source === 'd2d' && ev.done === false);
    ok('no time → no event', E.build('L9', { title: 'x', when: '' }) === null);
    ok('no title → no event', E.build('L9', { title: ' ', when: new Date() }) === null);
  }
  const core = read('docs/pro/js/d2d-tracker-core-2026b.js');
  const conv = core.slice(core.indexOf('async function convertToLead(knockId)'), core.indexOf('function convertToLeadWithEdit('));
  ok('convertToLead maps the stage through stageForDisposition', /_KL\.stageForDisposition\(knock\.disposition\)/.test(conv));
  ok('convertToLead no longer writes Inspected for an appointment', !/disposition === 'appointment'\) stage = 'inspected'/.test(conv));
  ok('convertToLead no longer maps every insurance outcome to Claim Filed', !/INS_DISPOSITIONS\.includes\(knock\.disposition\)\) stage = 'claim_filed'/.test(conv));
  ok('the auto follow-up uses the local day', /followUpStr = _KL \? _KL\.localYmd\(d\)/.test(conv));
  ok('an appointment with a time is booked through NBDLeadEvents.add', /window\.NBDLeadEvents\.add\(_newLeadId,/.test(conv) && /knock\.appointmentAt/.test(conv));
  const edit = core.slice(core.indexOf('function convertToLeadWithEdit('), core.indexOf('async function loadTeamKnocks('));
  ok('"edit first" pre-fills the same stage map', /stageForDisposition\(knock\.disposition\)/.test(edit) && !/stageEl\.value = 'inspected'/.test(edit));
  ok('the knock stores appointmentAt only for an appointment', /appointmentAt: \(disposition === 'appointment' && data\.appointmentAt\)/.test(core));
  const ui = read('docs/pro/js/d2d-tracker-ui-2026b.js');
  ok('the knock sheet asks for the appointment date & time', /type="datetime-local" id="d2d-qk-appt"/.test(ui) && /apptSection\.hidden = key !== 'appointment'/.test(ui));
  ok('…and will not save an appointment without one', /Pick the appointment date and time/.test(ui));
  ok('…and brings the new field on screen when Appointment is picked', /if \(key === 'appointment'\) \{\s*try \{ apptSection\.scrollIntoView\(/.test(ui));
  const sl = read('docs/pro/js/script-loader.js');
  const d2d = sl.slice(sl.indexOf('d2d: ['), sl.indexOf('],', sl.indexOf('d2d: [')));
  ok('the d2d bundle loads the logic + event writer BEFORE the core', d2d.indexOf('d2d-knock-lead-logic.js') > -1 && d2d.indexOf('lead-events.js') > -1
    && d2d.indexOf('lead-events.js') < d2d.indexOf('d2d-tracker-core-2026b.js') && d2d.indexOf('d2d-knock-lead-logic.js') < d2d.indexOf('d2d-tracker-core-2026b.js'));
  const ctu = read('docs/pro/js/customer-tasks-ui.js');
  ok('the customer page Add Event writes through the same writer', /window\.NBDLeadEvents\.add\(window\._customerId,/.test(ctu));
}

// ── 6. canonical stage labels on the milestone list ─────────────────────
const p6 = (async () => {
  console.log('\n6. milestone labels are the board\'s');
  const ctu = read('docs/pro/js/customer-tasks-ui.js');
  const m = ctu.match(/window\.loadProjectTimeline = async function\(leadId\) \{[\s\S]*?\n\};\n/);
  const esc = ctu.match(/function nbdEscFn\(\) \{[\s\S]*?\n\}\n/);
  ok('loadProjectTimeline found', !!(m && esc));
  if (m && esc) {
    const run = (stage, withLabeler) => {
      let html = '';
      const el = { set innerHTML(v) { html = v; }, get innerHTML() { return html; } };
      const win = {
        db: {}, doc: () => ({}),
        getDoc: async () => ({ exists: () => true, data: () => ({ stage, jobType: 'insurance', stageHistory: [] }) }),
      };
      if (withLabeler) win.stageLabel = (k) => (STAGE_META[k] && STAGE_META[k].label) || k;
      const ctx = { window: win, document: { getElementById: () => el }, console };
      vm.runInNewContext(esc[0] + m[0], ctx);
      return win.loadProjectTimeline('L1').then(() => html);
    };
    await Promise.all([run('closed', true), run('closed', false), run('install_complete', true)]).then(([a, b, c]) => {
      ok('Closed reads "Closed" (was "Warranty Registered")', /milestone-title">Closed</.test(a) && !/Warranty Registered/.test(a));
      ok('…even before the labeler loads (stale-cache default)', /milestone-title">Closed</.test(b) && !/Warranty Registered/.test(b));
      ok('every milestone title is a STAGE_META label', (a.match(/milestone-title">([^<]*)</g) || []).every((t) => {
        const l = t.replace(/.*">/, '').replace(/<$/, '');
        return Object.values(STAGE_META).some((s) => s.label === l);
      }), (a.match(/milestone-title">([^<]*)</g) || []).join(' | '));
      ok('install_complete reads "Install Done" like the board', /milestone-title">Install Done</.test(c));
    });
  }
})();

p6.catch((e) => { failed++; fails.push('section 6 threw: ' + (e && e.message)); }).then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
});
