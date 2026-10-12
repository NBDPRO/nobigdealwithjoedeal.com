/**
 * tests/thursday-playbooks-2026-10-12.test.js — Thursday's per-label caller
 * playbooks (documentation/projects/THURSDAY-LABEL-PLAYBOOKS-2026-10-12.md).
 *
 *   A. the server resolver (functions/integrations/thursday-playbooks.js)
 *   B. the prompt block + Initialization snippet Jo reviews (text lints, and
 *      the snippet is EXECUTED in a vm against a fake fetch)
 *   C. the client rules (docs/pro/js/thursday-handled-logic.js): which tier
 *      every Thursday call lands in, least-sure ordering, the block list
 *   D. wiring / drift pins: dark by default, zero script-loader growth, the
 *      doc shape the rules accept = the shape the logic writes, block is NOT a
 *      new policy value
 *
 * Every absence assertion has a positive control (the same input WITHOUT the
 * thing under test does appear).
 *
 * Run: node tests/thursday-playbooks-2026-10-12.test.js
 */
'use strict';
process.env.TZ = 'America/New_York';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + detail : '')); }
}

const PB = require(path.join(ROOT, 'functions/integrations/thursday-playbooks.js'));
const LG = require(path.join(ROOT, 'docs/pro/js/thursday-handled-logic.js'));
const LL = require(path.join(ROOT, 'docs/pro/js/contact-labels-logic.js'));
const AWAY = require(path.join(ROOT, 'functions/away-mode-logic.js'));

// ── A. the server resolver ──
console.log('A. resolver');
{
  const base = { from: '(555) 014-2222' };
  ok('disabled -> null (the lookup stays byte-identical)', PB.resolvePlaybook(Object.assign({ enabled: false, label: { kind: 'sub' } }, base)) === null
    && PB.resolvePlaybook(Object.assign({ label: { kind: 'sub' } }, base)) === null
    && PB.resolvePlaybook(Object.assign({ enabled: 'true', label: { kind: 'sub' } }, base)) === null);
  ok('control: enabled === true resolves', PB.resolvePlaybook(Object.assign({ enabled: true, label: { kind: 'sub' } }, base)).playbook === 'sub');
  ok('unusable number -> null', PB.resolvePlaybook({ enabled: true, from: '555', label: { kind: 'sub' } }) === null);
  const kinds = LL.KINDS;
  ok('every label kind maps to a known playbook id', kinds.every((k) => PB.PLAYBOOK_IDS.indexOf(PB.KIND_TO_PLAYBOOK[k]) !== -1));
  ok('the playbook map covers EXACTLY the label kinds (a new kind needs a playbook)', Object.keys(PB.KIND_TO_PLAYBOOK).sort().join() === kinds.slice().sort().join());
  ok('contractor and sub share the sub playbook', PB.KIND_TO_PLAYBOOK.contractor === 'sub' && PB.KIND_TO_PLAYBOOK.sub === 'sub');
  const r = (o) => PB.resolvePlaybook(Object.assign({ enabled: true, from: '5550142222' }, o));
  ok('no label + no lead -> unknown', r({}).playbook === 'unknown');
  ok('no label + exactly one lead -> customer', r({ leadKnown: true }).playbook === 'customer');
  ok('an explicit label beats the lead match (brother-in-law is personal)', r({ leadKnown: true, label: { kind: 'personal' } }).playbook === 'personal');
  ok('a junk kind falls back to the unlabeled flow', r({ label: { kind: 'billionaire' } }).playbook === 'unknown' && r({ label: { kind: '__proto__' } }).playbook === 'unknown');
  ok('personal + spam suppress the first name, others do not',
    r({ label: { kind: 'personal' } }).suppressName === true && r({ label: { kind: 'spam' } }).suppressName === true
    && r({ label: { kind: 'sub' } }).suppressName === false && r({ label: { kind: 'customer' } }).suppressName === false);
  ok('spam: no engagement, never handled even when the setting exists', r({ label: { kind: 'spam' }, handled: true }).engage === false && r({ label: { kind: 'spam' }, handled: true }).handled === false);
  ok('control: a handled sub is handled and engages', r({ label: { kind: 'sub' }, handled: true }).handled === true && r({ label: { kind: 'sub' }, handled: true }).engage === true);
  const v = r({ label: { kind: 'sub' }, handled: true }).vars;
  ok('vars are plain strings only (Bland prompt variables are text)', Object.keys(v).every((k) => typeof v[k] === 'string'), JSON.stringify(v));
  ok('vars: the four names the prompt reads', Object.keys(v).sort().join() === 'caller_away_text,caller_handled,caller_label_kind,caller_playbook');

  // away wording
  const away = { active: true, text: 'The owner is out of the office until Friday. I can take a message.', untilYmd: '2026-10-16' };
  ok('away text passes through when approved + active', r({ awayContext: away }).awayText === away.text);
  ok('no away context -> no text', r({ awayContext: null }).awayText === '' && r({}).awayText === '');
  ok('away context not marked active -> no text', r({ awayContext: { text: away.text } }).awayText === '');
  ok('spam gets no away text (control: the same context speaks for a sub)', r({ label: { kind: 'spam' }, awayContext: away }).awayText === '' && r({ label: { kind: 'sub' }, awayContext: away }).awayText === away.text);
  const withName = { active: true, text: 'The owner is away. Sam Backup is covering and will call you back.' };
  ok('text naming the backup (full name) is dropped', r({ awayContext: withName, backup: { name: 'Sam Backup' } }).awayText === '');
  ok('the full name is caught in any letter case (lowercase text)', r({ awayContext: { active: true, text: 'the owner is away. sam backup is covering.' }, backup: { name: 'Sam Backup' } }).awayText === '');
  ok('control: the same lowercase text with another backup passes', r({ awayContext: { active: true, text: 'the owner is away. sam backup is covering.' }, backup: { name: 'Lee Other' } }).awayText !== '');
  ok('S2: a mixed-case surname is caught in any case (McDonald / MCDONALD / mcdonald)',
    ['Ask McDonald at the office', 'ask MCDONALD', 'ask mcdonald'].every((t) => r({ awayContext: { active: true, text: t }, backup: { name: 'Bob McDonald' } }).awayText === ''));
  ok('S2: SAM / sam caught for backup Sam; control: Samuel is a different word', r({ awayContext: { active: true, text: 'SAM covers' }, backup: { name: 'Sam Backup' } }).awayText === '' && r({ awayContext: { active: true, text: 'Samuel covers' }, backup: { name: 'Sam Backup' } }).awayText !== '');
  ok('N4: a newline in the approved text is collapsed to one line', r({ awayContext: { active: true, text: 'The owner is away.\n\nHe will call back.' } }).awayText === 'The owner is away. He will call back.');
  ok('control: the same text with a different backup passes', r({ awayContext: withName, backup: { name: 'Lee Other' } }).awayText === withName.text);
  ok('text with only the backup first name (Capitalized) is dropped', r({ awayContext: { active: true, text: 'Sam will call you back.' }, backup: { name: 'Sam Backup' } }).awayText === '');
  ok('a backup called "Will" does not silence "will call you back" (lowercase verb)', r({ awayContext: { active: true, text: 'The owner is away and will call you back.' }, backup: { name: 'Will Smith' } }).awayText !== '');
  ok('text with the backup email is dropped', r({ awayContext: { active: true, text: 'Email sam@example.com' }, backup: { email: 'sam@example.com' } }).awayText === '');
  ok('text with the backup phone digits is dropped', r({ awayContext: { active: true, text: 'Call 513-555-0147 now.' }, backup: { phone: '(513) 555-0147' } }).awayText === '');
  ok('control: the same text without that backup phone passes', r({ awayContext: { active: true, text: 'Call 513-555-0147 now.' }, backup: { phone: '(513) 555-0999' } }).awayText !== '');
  const longText = 'x'.repeat(2000);
  ok('away text is bounded', r({ awayContext: { active: true, text: longText } }).awayText.length === PB.AWAY_TEXT_MAX);
  ok('control characters and bidi overrides never reach the prompt', r({ awayContext: { active: true, text: 'Away‮evil​\u0007 until Friday' } }).awayText === 'Awayevil until Friday');

  // widen
  const legacy = { known: true, first_name: 'Pat', job_hint: 'your project' };
  ok('widen(null) returns the base object untouched (same reference)', PB.widenLookupResponse(legacy, null) === legacy);
  const w1 = PB.widenLookupResponse(legacy, r({ label: { kind: 'customer' } }));
  ok('widen keeps the legacy keys and adds the four', w1.known === true && w1.first_name === 'Pat' && w1.playbook === 'customer' && w1.label_kind === 'customer' && w1.handled === false && w1.away_text === '');
  const w2 = PB.widenLookupResponse(legacy, r({ label: { kind: 'personal' } }));
  ok('widen blanks the name for personal', w2.known === false && w2.first_name === '' && w2.job_hint === '' && w2.playbook === 'personal');
  ok('widen does not mutate its input', legacy.known === true && legacy.first_name === 'Pat' && legacy.playbook === undefined);
}

// ── B. prompt + snippet ──
console.log('\nB. prompt block and Initialization snippet');
{
  const P = PB.PROMPT_BLOCK;
  ok('the prompt names every variable the snippet sets', ['caller_playbook', 'caller_handled', 'caller_away_text'].every((n) => P.indexOf('{{' + n + '}}') !== -1));
  ok('every playbook has a branch in the prompt', ['customer', 'prospect', 'sub', 'supplier', 'insurance', 'referral', 'personal', 'recruiter', 'spam'].every((id) => new RegExp('^- [^\\n]*\\b' + id + '\\b', 'm').test(P)));
  ok('unknown is the normal script (no separate branch)', /normal call script/.test(P));
  ok('label is a hint, never proof of who is speaking', /never proof of who is speaking/.test(P));
  ok('every call ends with a name + callback number', /ends with two things: a name/.test(P) && /number Jo can call back/.test(P));
  ok('no promises of time, price, crew, date, outcome', /Never promise a time, a price, a crew, a date or an outcome/.test(P));
  ok('away text is spoken word for word and never names a backup', /word for word/.test(P) && /never say who is covering/.test(P));
  // The Kentucky claim rule + the NBD honesty rules, as absences with positive controls.
  const banned = [
    [/\b(we|joe|jo|nbd)\s+(handle|handles|file|files|negotiate|negotiates)\s+(the|your)\s+claim/i, 'handles the claim'],
    [/walk\s+(you|them)\s+through\s+the\s+claim/i, 'walks through the claim'],
    [/\bin-house\b/i, 'in-house'],
    [/\blicensed\b/i, 'licensed'],
    [/\bguarantee/i, 'guarantee'],
    [/\$\s?\d/, 'a dollar figure'],
    [/assignment of benefits|\bAOB\b/i, 'AOB'],
    [/will be covered|is covered|get you covered/i, 'a coverage promise'],
  ];
  // Sentences that PROHIBIT a phrase ("never say it is covered") are not violations of it.
  const affirmative = P.split(/(?<=[.!?])\s+/).filter((x) => !/\bnever\b/i.test(x)).join(' ');
  banned.forEach(([re, label]) => ok('the prompt never says: ' + label, !re.test(affirmative), String(affirmative.match(re))));
  ok('control: the prohibition sentences were really set aside (the raw prompt does contain "is covered")', /is covered/.test(P) && !/is covered/.test(affirmative));
  const BAD = 'We handle the claim. Joe will walk you through the claim. Our in-house licensed crew. We guarantee $500. AOB. It is covered.';
  ok('control: every lint regex fires on a deliberately bad sentence', banned.every(([re]) => re.test(BAD)));
  ok('insurance branch is neutral and names the Kentucky limits', /never say whether anything is covered/.test(P) && /never confirm details about the customer/.test(P));
  ok('spam branch ends the call and collects nothing', /Do not collect anything/.test(P) && /hang-up tool/.test(P));
  ok('personal branch asks no intake and guesses no name', /No intake questions/.test(P) && /no name guessing/.test(P));
  ok('sub branch gives out no customer details', /never give out any customer's name, address or details/.test(P));
  ok('the block is additive (starts with the marker, never edits an earlier block)', P.indexOf(PB.PROMPT_MARK) !== -1 && P.indexOf('RECORDING NOTICE') === -1 && P.indexOf('OPENING') === -1);

  // Execute the snippet.
  function runSnippet(fetchImpl, env, body) {
    const code = PB.initCode('https://example.test/lookup').replace('export default', 'module.exports =');
    const sandbox = { module: { exports: {} }, Response: { json: (o) => ({ json: o }) }, AbortSignal: { timeout: () => undefined }, fetch: fetchImpl, JSON, String, Object };
    vm.runInNewContext(code, sandbox);
    return sandbox.module.exports.fetch({ json: async () => body }, env, {});
  }
  const NAMES = ['caller_known', 'caller_first_name', 'caller_job_hint', 'caller_playbook', 'caller_label_kind', 'caller_handled', 'caller_away_text'];
  const okFetch = (payload) => async () => ({ ok: true, json: async () => payload });
  (async () => {
    const full = (await runSnippet(okFetch({ known: true, first_name: 'Pat', job_hint: 'your project', playbook: 'customer', label_kind: 'customer', handled: true, away_text: 'Away.' }), { THURSDAY_LOOKUP_TOKEN: 't' }, { from: '+15135550142' })).json;
    ok('snippet: a full answer maps every variable', full.caller_known === 'true' && full.caller_first_name === 'Pat' && full.caller_playbook === 'customer' && full.caller_label_kind === 'customer' && full.caller_handled === 'true' && full.caller_away_text === 'Away.', JSON.stringify(full));
    ok('snippet: every output value is a string', Object.keys(full).every((k) => typeof full[k] === 'string'));
    ok('snippet: the variable set is exactly the seven names', Object.keys(full).sort().join() === NAMES.slice().sort().join());
    const labelOnly = (await runSnippet(okFetch({ known: false, first_name: '', job_hint: '', playbook: 'sub', label_kind: 'sub', handled: false, away_text: '' }), { THURSDAY_LOOKUP_TOKEN: 't' }, { from: '5135550142' })).json;
    ok('snippet: a label-only answer still carries the playbook (known stays false)', labelOnly.caller_known === 'false' && labelOnly.caller_playbook === 'sub');
    const legacyAnswer = (await runSnippet(okFetch({ known: true, first_name: 'Pat', job_hint: '' }), { THURSDAY_LOOKUP_TOKEN: 't' }, { from: '5135550142' })).json;
    ok('snippet: a legacy answer (flag off) greets by name and leaves the playbook empty', legacyAnswer.caller_known === 'true' && legacyAnswer.caller_playbook === '' && legacyAnswer.caller_handled === 'false');
    const nameLeak = (await runSnippet(okFetch({ known: false, first_name: 'Pat', playbook: 'personal' }), { THURSDAY_LOOKUP_TOKEN: 't' }, { from: '5135550142' })).json;
    ok('snippet: a name never rides along when known is not true', nameLeak.caller_first_name === '');
    const down = (await runSnippet(async () => { throw new Error('boom'); }, { THURSDAY_LOOKUP_TOKEN: 't' }, { from: '5135550142' })).json;
    ok('snippet: a failed lookup = all-empty unknown, same seven names', down.caller_known === 'false' && Object.keys(down).sort().join() === NAMES.slice().sort().join() && down.caller_playbook === '');
    const noTok = (await runSnippet(okFetch({ known: true, first_name: 'Pat' }), {}, { from: '5135550142' })).json;
    ok('snippet: no token / no number = unknown (never calls out)', noTok.caller_known === 'false');
    let called = 0;
    await runSnippet(async () => { called++; return { ok: true, json: async () => ({}) }; }, { THURSDAY_LOOKUP_TOKEN: 't' }, {});
    ok('snippet: no caller number -> no request made', called === 0);
    finish();
  })().catch((e) => { console.error(e); process.exit(1); });
}

function finishC() {
  // ── C. client rules ──
  console.log('\nC. tiers, ordering, block list');
  const NOW = Date.parse('2026-10-12T15:00:00Z');
  const call = (over) => Object.assign({
    callId: 'c1', status: 'processed', reviewed: false, from: '+15135550142', fromDigits: '5135550142',
    startedAt: new Date(NOW - 3600000), urgent: false, callerType: 'new_lead',
    route: { action: 'create_lead' }, extraction: { confidence: 'high', issue: 'Roof leak', caller_name: 'Pat Example', callback_number: '5135550142', callback_window: '', caller_type: 'new_lead', language: 'en' },
  }, over || {});
  const D = '5135550142';
  const tier = (c, l, h) => LG.disposition(c, l, h).tier;
  ok('unlabeled, unhandled -> its own row', tier(call(), null, null) === 'item');
  ok('still processing -> wait (the row arrives when it is done)', tier(call({ status: 'processing' }), null, null) === 'wait' && tier(call({ status: 'pending' }), null, null) === 'wait');
  ok('a failed extraction -> its own row (a call never vanishes)', tier(call({ status: 'failed', extraction: null }), null, null) === 'item');
  ok('reviewed -> done; control: the same call unreviewed is an item', tier(call({ reviewed: true }), null, null) === 'done' && tier(call(), null, null) === 'item');
  ok('spam / test / silent that the server auto-reviewed -> ledger (counted)', tier(call({ reviewed: true, callerType: 'spam' }), null, null) === 'ledger' && tier(call({ reviewed: true, callerType: 'silent' }), null, null) === 'ledger');
  ok('spam LABEL -> ledger, even when it claims to be urgent', tier(call({ urgent: true }), { kind: 'spam', policy: 'hide' }, null) === 'ledger');
  ok('handled number, ordinary message -> recap', tier(call(), null, { digits: D }) === 'recap');
  ok('handled number + urgent -> its own row (promise wins)', tier(call({ urgent: true }), null, { digits: D }) === 'item');
  ok('handled number + callback requested -> its own row', tier(call({ extraction: { callback_window: 'today after 3' } }), null, { digits: D }) === 'item');
  ok('quiet label, ordinary -> recap; urgent -> row (control pair)', tier(call(), { kind: 'sub', policy: 'quiet' }, null) === 'recap' && tier(call({ urgent: true }), { kind: 'sub', policy: 'quiet' }, null) === 'item');
  ok('hide label (personal) -> ledger; urgent -> row (control pair)', tier(call(), { kind: 'personal', policy: 'hide' }, null) === 'ledger' && tier(call({ urgent: true }), { kind: 'personal', policy: 'hide' }, null) === 'item');
  ok('hide label + only a callback request -> stays hidden (Jo hid it; a callback is not a promise he made)', tier(call({ extraction: { callback_window: 'tonight' } }), { kind: 'personal', policy: 'hide' }, null) === 'ledger');
  ok('surface label (customer) -> its own row', tier(call(), { kind: 'customer', policy: 'surface' }, null) === 'item');
  ok('a label with no policy falls back by kind (personal hides, sub surfaces)', tier(call(), { kind: 'personal' }, null) === 'ledger' && tier(call(), { kind: 'sub' }, null) === 'item');
  ok('every call lands in exactly one tier from a closed set', ['wait', 'done', 'ledger', 'recap', 'item'].indexOf(tier(call(), null, null)) !== -1);

  // never ends without a Today item: sweep the matrix and require item|recap|ledger|done|wait only
  const labels = [null, { kind: 'customer', policy: 'surface' }, { kind: 'sub', policy: 'quiet' }, { kind: 'personal', policy: 'hide' }, { kind: 'spam', policy: 'hide' }, { kind: 'insurance', policy: 'surface' }];
  const handledOpts = [null, { digits: D }];
  const types = ['new_lead', 'existing_customer', 'adjuster', 'supplier_sub', 'job_seeker', 'spam', 'test', 'silent'];
  let cells = 0, unplaced = 0, ledgerNonSpam = 0;
  labels.forEach((l) => handledOpts.forEach((h) => types.forEach((t) => [false, true].forEach((u) => {
    const x = LG.disposition(call({ callerType: t, urgent: u, reviewed: false }), l, h);
    cells++;
    if (['item', 'recap', 'ledger'].indexOf(x.tier) === -1) unplaced++;
    // The only unreviewed calls that are merely counted are Jo's own hide/spam choices.
    if (x.tier === 'ledger' && !(l && (l.kind === 'spam' || l.policy === 'hide'))) ledgerNonSpam++;
  }))));
  ok('matrix (' + cells + ' cells): every unreviewed processed call is an item, a recap line or a counted ledger row', unplaced === 0);
  ok('matrix: nothing is merely counted unless Jo hid or spam-labeled that number', ledgerNonSpam === 0);

  // uncertainty ordering
  const sure = call({ callId: 'sure' });
  const unsure = call({ callId: 'unsure', fromDigits: '5135550143', from: '+15135550143', extraction: { confidence: 'low', issue: '', caller_name: '', callback_number: '', callback_window: '', caller_type: 'new_lead', language: 'es' }, route: { action: 'possible_match' } });
  ok('uncertainty: a low-confidence, unmatched, no-summary call scores higher than a clean one', LG.uncertainty(unsure, null).score > LG.uncertainty(sure, null).score + 50);
  ok('uncertainty: reasons are plain words', LG.uncertainty(unsure, null).reasons.length >= 3 && LG.uncertainty(unsure, null).reasons.every((s) => typeof s === 'string' && s.length > 4));
  ok('uncertainty: the label disagreeing with the caller type raises it (control: agreeing does not)',
    LG.uncertainty(call({ callerType: 'new_lead' }), { kind: 'sub' }).score > LG.uncertainty(call({ callerType: 'supplier_sub' }), { kind: 'sub' }).score);
  ok('uncertainty is capped at 100', LG.uncertainty(Object.assign({}, unsure, { status: 'failed', urgent: true, callerType: 'silent' }), { kind: 'sub' }).score <= 100);

  // summarize
  const mk = (id, over) => call(Object.assign({ callId: id, fromDigits: '51355510' + id, from: '+151355510' + id }, over || {}));
  const handledMap = {};
  const many = [];
  for (let n = 10; n < 16; n++) {
    handledMap['51355510' + n] = { digits: '51355510' + n };
    many.push(mk(String(n), { extraction: { confidence: n === 13 ? 'low' : n === 14 ? 'medium' : 'high', issue: 'msg ' + n, callback_number: '51355510' + n, callback_window: '', caller_type: 'new_lead', language: n === 15 ? 'es' : 'en' }, startedAt: new Date(NOW - n * 60000) }));
  }
  const sum = LG.summarize(many, {}, handledMap, NOW);
  ok('summarize: 6 handled calls -> 0 own rows, 6 recap lines', sum.items.length === 0 && sum.recap.count === 6 && sum.recap.rows.length === 6);
  ok('summarize: the three she was least sure about are on top', sum.recap.top.length === 3 && sum.recap.top[0].id === '13' && sum.recap.top.map((r) => r.id).sort().join() === ['13', '14', '15'].sort().join(), sum.recap.top.map((r) => r.id).join());
  ok('summarize: handledCount reports the numbers handed over', sum.handledCount === 6);
  const mixed = LG.summarize([mk('20'), mk('21', { urgent: true }), mk('22', { reviewed: true, callerType: 'spam' }), mk('23', { reviewed: true })], {}, {}, NOW);
  ok('summarize: urgent row first; reviewed spam counted as ledger; reviewed normal call gone', mixed.items.length === 2 && mixed.items[0].id === '21' && mixed.ledgerCount === 1);
  const old = LG.summarize([mk('30', { startedAt: new Date(NOW - 5 * 86400000) })], {}, {}, NOW);
  ok('summarize: an unreviewed call older than 3 days drops off Today (control: a fresh one stays)', old.items.length === 0 && LG.summarize([mk('31')], {}, {}, NOW).items.length === 1);

  // block list
  const lab = { '5550142222': { digits: '5550142222', kind: 'spam', policy: 'hide', name: 'SEO robocaller', updatedAtMs: 5 }, '5550142223': { digits: '5550142223', kind: 'personal', policy: 'hide', updatedAtMs: 9 }, '5550142224': { digits: '5550142224', kind: 'spam', policy: 'surface', updatedAtMs: 7 }, '5550142225': { digits: '5550142225', kind: 'spam', policy: 'hide', updatedAtMs: 8 } };
  const bl = LG.blockList(lab);
  ok('block list: spam + hide only, newest first (personal and a surfaced spam label are not on it)', bl.map((r) => r.digits).join() === '5550142225,5550142222', bl.map((r) => r.digits).join());
  ok('block list text: one number per line, formatted', LG.blockListText(bl) === '(555) 014-2225\n(555) 014-2222 - SEO robocaller', JSON.stringify(LG.blockListText(bl)));
  ok('block list: works on a Map too', LG.blockList(new Map(Object.entries(lab))).length === 2);
  ok('block list: empty -> empty text', LG.blockListText([]) === '');

  // setting doc
  const doc = LG.buildDoc({ digits: '(555) 014-2222', companyId: 'co-a', uid: 'u1', nowMs: NOW, note: ' Aunt  Pat ' });
  ok('buildDoc: normalised digits + trimmed note', doc.digits === '5550142222' && doc.note === 'Aunt Pat' && doc.createdAtMs === NOW && doc.updatedBy === 'u1');
  ok('buildDoc: no note -> no note key', !('note' in LG.buildDoc({ digits: '5550142222', companyId: 'co-a', uid: 'u1' })));
  ok('buildDoc: bad digits / no company / no uid -> null', LG.buildDoc({ digits: '55', companyId: 'c', uid: 'u' }) === null && LG.buildDoc({ digits: '5550142222', uid: 'u' }) === null && LG.buildDoc({ digits: '5550142222', companyId: 'c' }) === null);
  ok('buildDoc: note capped at 200', LG.buildDoc({ digits: '5550142222', companyId: 'c', uid: 'u', note: 'x'.repeat(500) }).note.length === 200);
  ok('buildDoc carries only keys the rules allow', Object.keys(doc).every((k) => LG.DOC_KEYS.indexOf(k) !== -1));
  ok('checkTarget: own number refused; control: another number allowed', !LG.checkTarget('5550142222', { ownDigits: ['(555) 014-2222'] }).ok && LG.checkTarget('5550142223', { ownDigits: ['5550142222'] }).ok);
  ok('checkTarget: a spam-labeled number is refused with a reason', !LG.checkTarget('5550142222', { label: { kind: 'spam' } }).ok && /spam/.test(LG.checkTarget('5550142222', { label: { kind: 'spam' } }).reason));
  ok('checkTarget: control: a sub-labeled number is allowed', LG.checkTarget('5550142222', { label: { kind: 'sub' } }).ok);
  ok('checkTarget: no digits refused', !LG.checkTarget('', {}).ok);

  // ── D. wiring / drift ──
  // E. the DOM file, run in a vm: escaping + role gating + flag gating
  console.log('\nE. thursday-handled.js in a sandbox');
  {
    const src = read('docs/pro/js/thursday-handled.js');
    function boot(over) {
      const o = over || {};
      const listeners = {};
      const toasts = [];
      const win = {
        document: { addEventListener() {}, querySelector() { return null; } },
        addEventListener(n, f) { (listeners[n] = listeners[n] || []).push(f); },
        dispatchEvent() { return true; },
        showToast(m) { toasts.push(m); },
        _user: o.noUser ? null : { uid: 'u1' },
        _userClaims: o.claims || {},
        NBDFlags: { enabled: (n) => o.flag !== false && n === 'thursdayLabelPlaybooks' },
        NBDThursdayHandledLogic: LG,
        NBDContactLabelsLogic: LL,
        NBDContactLabels: { current: () => o.labels || {}, get: (d) => (o.labels || {})[d] || null, clear: async () => ({ ok: true }) },
        navigator: { clipboard: { writeText: async () => {} } },
        console, setTimeout, clearTimeout, Date, JSON, Object, String, Number, Array, Promise, Math,
        CustomEvent: function CustomEvent(n) { this.type = n; },
      };
      win.window = win;
      vm.runInNewContext(src, Object.assign(win, { document: win.document }), { filename: 'thursday-handled.js' });
      return { win, T: win.NBDThursdayHandled, toasts };
    }
    const NOWMS = Date.now();
    const hostile = '"><img src=x onerror=alert(1)>';
    const calls = [
      { callId: 'h1', _id: 'h1', status: 'processed', reviewed: false, from: '+15135550142', fromDigits: '5135550142', startedAt: new Date(NOWMS - 600000), urgent: true, callerType: 'new_lead', extraction: { caller_name: hostile, issue: '<script>alert(2)</script>', confidence: 'low', callback_number: '5135550142', language: 'en' }, route: { action: 'create_lead' }, leadId: 'x"y' },
    ];
    const s1 = boot({ claims: { role: 'company_admin', companyId: 'co-a' }, labels: { '5135550142': { kind: 'sub', policy: 'surface', name: hostile } } });
    s1.T._state.loaded = true; s1.T._state.calls = calls;
    const h = s1.T.todayHtml();
    ok('sandbox: the Today section renders for a flagged writer', /Thursday took a call/.test(h), h.slice(0, 120));
    ok('sandbox: hostile caller name / issue / lead id are escaped, no raw tag or attribute breakout', !/<img/i.test(h) && !/<script/i.test(h) && !/"><img/.test(h) && /&lt;img/.test(h) && /x%22y/.test(h), h.slice(0, 400));
    ok('sandbox: a writer gets the Reviewed button; control: a viewer does not', /data-th-act="reviewed"/.test(h) && !/data-th-act="reviewed"/.test((() => { const v = boot({ claims: { role: 'viewer', companyId: 'co-a' } }); v.T._state.loaded = true; v.T._state.calls = calls; return v.T.todayHtml(); })()));
    const off = boot({ flag: false, claims: { role: 'company_admin' } });
    off.T._state.loaded = true; off.T._state.calls = calls;
    ok('sandbox: flag off -> todayHtml / panelHtml / sheetHtml are all empty (control: on is not)', off.T.todayHtml() === '' && off.T.panelHtml('blocklist') === '' && off.T.sheetHtml('5135550142') === '' && h !== '');
    const rep = boot({ claims: { role: 'sales_rep', companyId: 'co-a' } });
    rep.T._state.loaded = true; rep.T._state.calls = calls;
    ok('sandbox: a sales_rep sees nothing (no read, no write)', rep.T.todayHtml() === '' && rep.T.sheetHtml('5135550142') === '');
    const vw = boot({ claims: { role: 'viewer', companyId: 'co-a' } });
    ok('sandbox: a viewer gets no handle toggle', vw.T.sheetHtml('5135550142') === '');
    ok('sandbox: a writer gets the toggle; a spam-labeled number gets none (control pair)',
      /Let Thursday handle this number/.test(s1.T.sheetHtml('5135550142')) && boot({ claims: { role: 'company_admin' }, labels: { '5135550142': { kind: 'spam', policy: 'hide' } } }).T.sheetHtml('5135550142') === '');
    const panel = boot({ claims: { role: 'company_admin' }, labels: { '5550142222': { digits: '5550142222', kind: 'spam', policy: 'hide', name: hostile, updatedAtMs: 1 } } });
    panel.T._state.loaded = true;
    const ph = panel.T.panelHtml('blocklist');
    ok('sandbox: block list panel escapes the label name and offers Copy list + Not spam', /Copy list/.test(ph) && /Not spam/.test(ph) && !/<img/.test(ph) && /&lt;img/.test(ph), ph.slice(0, 300));
    ok('sandbox: the handled panel lists numbers with Take back', (() => { const p = boot({ claims: { role: 'company_admin' } }); p.T._state.loaded = true; p.T._state.handled = { '5550142222': { digits: '5550142222', updatedAtMs: 1 } }; const x = p.T.panelHtml('thandled'); return /\(555\) 014-2222/.test(x) && /Take back/.test(x); })());
    ok('sandbox: isBlocked is true only for spam + hide', (() => { const p = boot({ claims: {}, labels: { '5550142222': { kind: 'spam', policy: 'hide' }, '5550142223': { kind: 'spam', policy: 'surface' }, '5550142224': { kind: 'personal', policy: 'hide' } } }); return p.T.isBlocked('5550142222') && !p.T.isBlocked('5550142223') && !p.T.isBlocked('5550142224'); })());
  }

  console.log('\nD. wiring and drift');
  const rules = read('firestore.rules');
  const m = /function thursdayHandledOk[\s\S]*?hasOnly\(\[([^\]]+)\]\)/.exec(rules);
  const ruleKeys = m ? m[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort() : [];
  ok('rules hasOnly keys == logic DOC_KEYS (the shape the client writes is the shape the rules accept)', ruleKeys.join() === LG.DOC_KEYS.slice().sort().join(), ruleKeys.join());
  ok('server playbook map == client playbook map', JSON.stringify(Object.keys(PB.KIND_TO_PLAYBOOK).sort().map((k) => [k, PB.KIND_TO_PLAYBOOK[k]])) === JSON.stringify(Object.keys(LG.KIND_TO_PLAYBOOK).sort().map((k) => [k, LG.KIND_TO_PLAYBOOK[k]])));
  ok('contact label POLICIES are still exactly surface/quiet/hide (block is a spam+hide label, not a 4th policy)', LL.POLICIES.join() === 'surface,quiet,hide' && /d\.policy in \['surface', 'quiet', 'hide'\]/.test(rules));
  ok('the rule is mounted under companies/{companyId}/thursday_handled/{digits}', /match \/thursday_handled\/\{digits\}/.test(rules));
  ok('rules: viewer cannot write (notViewer on create, update, delete)', (/match \/thursday_handled\/\{digits\}[\s\S]*?allow create: if isAuth\(\) && notViewer\(\)[\s\S]*?allow update: if isAuth\(\) && notViewer\(\)[\s\S]*?allow delete: if isAuth\(\) && notViewer\(\)/.test(rules)));
  const gates = read('functions/cron-gates.js');
  ok('the flag is registered, enabled-polarity, in thursday.js', /THURSDAY_LABEL_PLAYBOOKS_ENABLED', polarity: 'enabled', file: 'integrations\/thursday.js'/.test(gates));
  const thu = read('functions/integrations/thursday.js');
  ok("thursday.js reads the flag as the literal 'true' (dark by default)", /process\.env\.THURSDAY_LABEL_PLAYBOOKS_ENABLED === 'true'/.test(thu));
  ok('thursday.js: the playbook reads start only when enabled, and BESIDE the lead queries (before them)',
    /const inputsP = playbooksEnabled\(\) \? loadPlaybookInputs\(/.test(thu) && thu.indexOf('const inputsP = playbooksEnabled()') < thu.indexOf("const col = db().collection('leads')"));
  ok('thursday.js: a playbook failure never blocks the greeting (budget race + catch -> null)', /Promise\.race\(\[reads, budget\]\)/.test(thu) && /playbook context unavailable/.test(thu) && /over budget/.test(thu));
  ok('thursday.js: the budget is short enough to sit inside the 2.5 s snippet timeout', (function () { const m = /PLAYBOOK_READ_BUDGET_MS = (\d+)/.exec(thu); return !!m && Number(m[1]) <= 1200; })());
  const env = fs.readFileSync(path.join(ROOT, 'functions/.env.nobigdeal-pro'), 'utf8');
  ok('the flag is NOT set in the committed env (dark)', !/THURSDAY_LABEL_PLAYBOOKS_ENABLED/.test(env));
  const loader = read('docs/pro/js/script-loader.js');
  ok('script-loader.js gains no thursday bundle (blocking bytes are at the ceiling)', !/thursday/i.test(loader));
  const cl = read('docs/pro/js/contact-labels.js');
  ok('contact-labels.js loads the Thursday files lazily, only when the flag is on', /enabled\('thursdayLabelPlaybooks'\)/.test(cl) && /ScriptLoader\.load\('js\/thursday-handled\.js\?v=1'\)/.test(cl));
  const th = read('docs/pro/js/thursday-handled.js');
  ok('thursday-handled.js is flag-gated at every entry (load, today, panel, sheet)', (th.match(/if \(!enabled\(\)/g) || []).length >= 4);
  ok('thursday-handled.js has no inline handler and no network send', !/\bon(click|change|submit)=/.test(th) && !/sendText|sendSms|sms:|mailto:/.test(th.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('thursday-handled.js never writes carrier or call state (no fetch/XHR/beacon)', !/\bfetch\(|XMLHttpRequest|sendBeacon/.test(th));
  const today = read('docs/pro/js/today-home.js');
  ok('today-home.js renders the Thursday section only through the guarded hook', /w\.NBDThursdayHandled \? w\.NBDThursdayHandled\.todayHtml\(\) : ''/.test(today) && /'nbd:thursday-handled-changed'/.test(today));
  const cc = read('docs/pro/js/call-center-view.js');
  ok('call-center-view.js: both new filters are flag-gated (4th element is the gate)', /\['thandled', 'Thursday-handled'[^\n]*thEnabled\],/.test(cc) && /\['blocklist', 'Block list'[^\n]*thEnabled\],/.test(cc));
  ok('call-center-view.js: every FILTERS read goes through filtersNow() except the default', (cc.match(/FILTERS\.(map|forEach)\(/g) || []).length === 0);
  const html = read('docs/pro/dashboard.html');
  ok('dashboard.html: today-home.js cache-buster bumped (the hook only ships if browsers refetch)', /js\/today-home\.js\?v=([6-9]|\d\d)"/.test(html));
  ok('script-loader.js: call-center-view cache-buster bumped', /call-center-view\.js\?v=(1[4-9]|[2-9]\d)'/.test(loader));
  ok('home-attention.js: contact-labels.js cache-buster bumped', /contact-labels\.js\?v=([3-9]|\d\d)'/.test(read('docs/pro/js/home-attention.js')));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join('; ')); process.exit(1); }
}
function finish() { finishC(); }
