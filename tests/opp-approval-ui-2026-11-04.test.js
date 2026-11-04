/**
 * tests/opp-approval-ui-2026-11-04.test.js
 *
 * Thumbtack Opportunities watcher, PR 4: the approval cards inside the Follow-up board
 * (docs/pro/js/opp-approval-logic.js, opp-approval.js, and the few lines in follow-up-board.js).
 * The real modules run in a vm sandbox with a fake document and a fake callable. Pins:
 *   1. the HTML strings: every server string is escaped (an Opportunity's words are DATA), the
 *      reasons, caps and "will send 8am" show, approved cards say nothing was sent, no approve-all;
 *   2. dark: followUpBoard off, thumbtackOpportunities off, a viewer / member / rep: nothing renders
 *      and oppDraftList is never called;
 *   3. flag on: opening the board loads the cards once; Approve / Edit / Save edit / Skip / Snooze each
 *      send ONE oppDraftDecide for the ONE card they sit on, with exactly the documented fields;
 *   4. what Jo typed is what is approved, and survives a refusal; a server refusal is shown on the card;
 *   5. one request at a time (a double tap sends one); a section-wide refusal hides the section;
 *   6. strict CSP and wiring: no inline script / handler / style, no network sink of its own, the
 *      send flag is never read, the dashboard loads the files.
 * Synthetic data only (ZZ_QA). Run: node tests/opp-approval-ui-2026-11-04.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, what) {
  for (let i = 0; i < 400; i++) { if (fn()) return true; await tick(); }
  throw new Error('timed out waiting for ' + what);
}

const OL = require(path.join(ROOT, 'docs/pro/js/opp-approval-logic.js'));
const F = require(path.join(ROOT, 'docs/pro/js/follow-up-board-logic.js'));
const EB = require(path.join(ROOT, 'docs/pro/js/estimate-follow-board.js'));
const EF = require(path.join(ROOT, 'docs/pro/js/estimate-followups.js'));

const NOW = Date.UTC(2026, 10, 4, 15);
const TEXT = 'Hi, this is No Big Deal Home Solutions. We are fully insured and happy to take a free look at the missing shingles this week.';
const card = (id, over) => Object.assign({
  oppId: id, status: 'pending', text: TEXT, originalText: null, editedByJo: false, templateKey: 'opp_roof_repair_a', category: 'Roof repair', tradeKey: 'roof_repair',
  city: 'Goshen', zip: '45122', milesNearestBase: 4.2, baseUsed: 'goshen', prosAlready: 1, photos: 2, ageNowMin: 14, score: 88,
  reasons: ['Roof repair is a trade you work.', 'Near the Goshen base.'], flags: [], snoozedUntilMs: null, approvedAtMs: null, sendLabel: null, skipReason: null,
}, over || {});
const listOf = (cards, over) => Object.assign({ ok: true, status: 'done', nowMs: NOW, cards, caps: { approvedToday: 3, perDay: 8, approvedThisWeek: 9, perWeek: 25 }, inSendHours: true, sendLabel: 'in the send window (8am to 8pm Eastern)' }, over || {});

console.log('1. the HTML strings');
{
  const ATTACK = '<img src=x onerror=alert(1)>"\'&<script>alert(2)</script>';
  const evil = card('ZZ"><b>1', { text: ATTACK, city: '<b>Goshen</b>', category: '<i>Roof</i>', reasons: [ATTACK], flags: ['<u>x</u>'], baseUsed: 'x', sendLabel: ATTACK });
  const pend = OL.pendingHtml(evil, { editing: true, text: ATTACK, msg: ATTACK, skipping: true }, listOf([evil]));
  const appr = OL.approvedHtml(Object.assign({}, evil, { status: 'approved' }));
  const sect = OL.sectionHtml({ data: listOf([evil, Object.assign({}, evil, { oppId: 'ZZ2', status: 'approved' })]), error: ATTACK, msg: ATTACK, ui: {} }, NOW);
  for (const [name, h] of [['pending card (editing, with skip choices)', pend], ['approved card', appr], ['the whole section', sect]]) {
    ok('ESCAPING in the ' + name + ': no live <img>, <script>, <b>, <i> or <u> tag from the data', !/<img|<script|<b>Goshen|<i>Roof|<u>x|<b>1/.test(h), h.slice(0, 200));
    ok('...the data is present only as escaped text', /&lt;img src=x onerror=alert\(1\)&gt;/.test(h) || /&lt;b&gt;/.test(h));
    ok('...no attribute is broken out of by a quote in the data', !/data-opp-id="ZZ"><b>/.test(h) && !/"\s+onerror=/.test(h));
  }
  ok('esc handles & < > " \' and null', OL.esc('<>&"\'') === '&lt;&gt;&amp;&quot;&#39;' && OL.esc(null) === '' && OL.esc(undefined) === '' && OL.esc(5) === '5');
}
{
  const c = card('ZZ1');
  const data = listOf([c]);
  const h = OL.pendingHtml(c, {}, data);
  ok('a card shows the trade and place, the age, miles from the base, pros already in, photos and the score', /Roof repair · Goshen 45122/.test(h) && /posted 14 min ago/.test(h) && /4\.2 mi from Goshen/.test(h) && /1 pro already in/.test(h) && /photos: yes/.test(h) && /88\/100/.test(h));
  ok('it shows the plain-language reasons it was shortlisted', /Why it was shortlisted/.test(h) && /Roof repair is a trade you work\./.test(h) && /Near the Goshen base\./.test(h));
  ok('it shows the draft text', h.includes(OL.esc(TEXT)));
  ok('Approve, Edit, Snooze 1h and Skip are there, each tied to this one card', ['approve', 'edit', 'snooze', 'skipopen'].every((a) => new RegExp('data-opp-act="' + a + '" data-opp-id="ZZ1"').test(h)) || ['approve', 'edit', 'snooze', 'skipopen'].every((a) => h.includes('data-opp-act="' + a + '"') && h.includes('data-opp-id="ZZ1"')));
  ok('every button carries a card id; no button acts on "all"', (h.match(/<button/g) || []).length === (h.match(/<button[^>]*data-opp-id="ZZ1"/g) || []).length && !/approve\s*all|approveall|approve_all|data-opp-act="[a-z]*all"/i.test(h));
  ok('Approve is a normal button inside the window', /data-opp-act="approve"[^>]*>Approve<\/button>/.test(h) && !/will send 8am/.test(h));
  const out = OL.pendingHtml(c, {}, listOf([c], { inSendHours: false, sendLabel: 'will send 8am' }));
  ok('OUTSIDE the send hours the Approve button says "will send 8am"', /data-opp-act="approve"[^>]*>Approve \(will send 8am\)<\/button>/.test(out), out.slice(out.indexOf('data-opp-act="approve"'), out.indexOf('data-opp-act="approve"') + 160));
  const full = OL.pendingHtml(c, {}, listOf([c], { caps: { approvedToday: 8, perDay: 8, approvedThisWeek: 9, perWeek: 25 } }));
  ok('at the DAILY cap Approve is disabled and the cap is explained', /data-opp-act="approve"[^>]*disabled/.test(full) && /Approved today 8 of 8/.test(full) && /cap is reached/.test(full));
  const wfull = OL.pendingHtml(c, {}, listOf([c], { caps: { approvedToday: 1, perDay: 8, approvedThisWeek: 25, perWeek: 25 } }));
  ok('at the WEEKLY cap Approve is disabled too', /data-opp-act="approve"[^>]*disabled/.test(wfull));
  const nearly = OL.pendingHtml(c, {}, listOf([c], { caps: { approvedToday: 7, perDay: 8, approvedThisWeek: 24, perWeek: 25 } }));
  ok('one below each cap Approve is enabled', !/data-opp-act="approve"[^>]*disabled/.test(nearly));
  const unknown = OL.pendingHtml(c, {}, listOf([c], { caps: { approvedToday: null, perDay: 8, approvedThisWeek: null, perWeek: 25 } }));
  ok('unknown counts disable Approve (the same fail closed as the server)', /data-opp-act="approve"[^>]*disabled/.test(unknown) && /counts unknown/.test(unknown));
  ok('capLine reads "Approved today 3 of 8 · this week 9 of 25"', OL.capLine(data.caps) === 'Approved today 3 of 8 · this week 9 of 25');
  const busy = OL.pendingHtml(c, { busy: true }, data);
  ok('a busy card disables every button on it', (busy.match(/<button/g) || []).length === (busy.match(/<button[^>]* disabled/g) || []).length && (busy.match(/<button/g) || []).length >= 4);
  const ed = OL.pendingHtml(c, { editing: true, text: 'my edit' }, data);
  ok('editing shows a labelled box with Jo\'s text, Save edit and Cancel edit', /<textarea[^>]*data-opp-text="ZZ1"[^>]*aria-labelledby="oppL-ZZ1"[^>]*>my edit<\/textarea>/.test(ed) && /data-opp-act="saveedit"/.test(ed) && /data-opp-act="canceledit"/.test(ed) && !/data-opp-act="edit"/.test(ed));
  const sk = OL.pendingHtml(c, { skipping: true }, data);
  ok('Skip offers exactly the four reasons', ['wrong_trade', 'too_far', 'too_small', 'too_crowded'].every((r) => sk.includes('data-opp-act="skip" data-opp-reason="' + r + '"')) && (sk.match(/data-opp-act="skip"/g) || []).length === 4 && /Wrong trade/.test(sk) && /Too crowded/.test(sk));
  const ap = OL.approvedHtml(card('ZZ1', { status: 'approved', sendLabel: 'will send 8am', text: 'ZZ_QA approved text' }));
  ok('an approved card is read-only, labelled, and says nothing has been sent', !/<button/.test(ap) && /Approved · will send 8am/.test(ap) && /Nothing has been sent/.test(ap) && /ZZ_QA approved text/.test(ap));
  const part = OL.partition([card('a'), card('b', { snoozedUntilMs: NOW + 1000 }), card('c', { snoozedUntilMs: NOW - 1000 }), card('d', { status: 'approved' }), card('e', { status: 'skipped' }), null, { status: 'pending' }], NOW);
  ok('partition: active (a, c), snoozed (b), approved (d); skipped and junk dropped', part.active.map((x) => x.oppId).join() === 'a,c' && part.snoozed.map((x) => x.oppId).join() === 'b' && part.approved.map((x) => x.oppId).join() === 'd');
  const sec = OL.sectionHtml({ data: data }, NOW);
  ok('the section says one tap approves one draft and nothing is sent from here', /One tap approves one draft/.test(sec) && /nothing is sent from here/.test(sec) && /no sender yet/.test(sec));
  ok('the section shows the caps line', /Approved today 3 of 8/.test(sec));
  ok('an empty list says so', /No Thumbtack drafts waiting/.test(OL.sectionHtml({ data: listOf([]) }, NOW)));
  ok('before the first load it says loading, then shows no cards', /Loading drafts/.test(OL.sectionHtml({ loading: true }, NOW)) && !/opp-card/.test(OL.sectionHtml({ loading: true }, NOW)));
  ok('the age labels', OL.ageLabel(0.2) === 'posted just now' && OL.ageLabel(59) === 'posted 59 min ago' && OL.ageLabel(60) === 'posted 1 h ago' && OL.ageLabel(135) === 'posted 2 h 15 min ago' && OL.ageLabel(null) === 'posted time unknown' && OL.ageLabel(-5) === 'posted time unknown');
}

console.log('\n2 and 3. the modules in a sandbox, inside the real Follow-up board');
(async () => {
  const BOARD = read('docs/pro/js/follow-up-board.js'), OPP = read('docs/pro/js/opp-approval.js'), LOGIC = read('docs/pro/js/opp-approval-logic.js');
  function boot(opts) {
    opts = opts || {};
    const handlers = {};
    const created = [];
    const boxes = [];                       // textareas the test "types" into
    const body = { appendChild(n) { n.parentNode = body; }, removeChild(n) { n.parentNode = null; } };
    const btn = { id: 'followUpBoardBtn', hidden: true, getAttribute() { return null; } };
    btn.closest = () => btn;
    const badge = { id: 'followUpBoardBadge', hidden: true, textContent: '' };
    const document = {
      readyState: 'complete', body,
      getElementById: (id) => (id === 'followUpBoardBtn' ? btn : id === 'followUpBoardBadge' ? badge : null),
      createElement() { const n = { className: '', innerHTML: '', scrollTop: 0, setAttribute() {}, querySelector() { return null; } }; created.push(n); return n; },
      querySelectorAll: (sel) => (sel === '[data-opp-text]' ? boxes : []),
      addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
      activeElement: null,
    };
    const calls = [], gate = { hold: null };
    const state = { list: opts.list || listOf([card('ZZ1'), card('ZZ2', { score: 70, text: TEXT + ' Second.' })]), decide: opts.decide || null, listErr: opts.listErr || null };
    const win = {
      document, _leads: [], _userClaims: opts.claims || {}, _user: { uid: 'u1' },
      NBDFlags: { enabled: (n) => (n === 'followUpBoard' ? opts.board !== false : n === 'thumbtackOpportunities' ? !!opts.opp : false), load: () => Promise.resolve() },
      NBDEstimateFollowups: Object.assign({}, EF, {
        callable: async (name, data) => {
          calls.push({ name, data: JSON.parse(JSON.stringify(data)) });
          if (name === 'oppDraftList') { if (state.listErr) throw state.listErr; return typeof state.list === 'function' ? state.list() : state.list; }
          if (name === 'oppDraftDecide') { if (gate.hold) await gate.hold; if (state.decide instanceof Error) throw state.decide; return typeof state.decide === 'function' ? state.decide(data) : (state.decide || { ok: true, status: 'approved', message: 'Approved. Nothing was sent.' }); }
          return { ok: true, status: 'filed' };
        },
        stampNudge: async () => true,
      }),
      NBDEstimateFollowBoard: { _pure: EB },
      NBDFollowUpLogic: F,
      LeadSnooze: { snooze: async () => {} },
      db: {}, doc: () => ({}), serverTimestamp: () => 'TS', updateDoc: async () => {},
      getDocs: async () => ({ docs: [] }), query: (...a) => a, where: (...a) => a, collection: (...a) => a,
      addEventListener() {}, showToast() {},
    };
    win.window = win;
    const ctx = { window: win, document, setTimeout: () => 0, setInterval: () => 0, console, Date, Promise, Math, JSON, String, Object, Array, Number, Error };
    vm.runInNewContext(LOGIC, ctx, { filename: 'opp-approval-logic.js' });
    vm.runInNewContext(OPP, ctx, { filename: 'opp-approval.js' });
    vm.runInNewContext(BOARD, ctx, { filename: 'follow-up-board.js' });
    const fire = (type, ev) => (handlers[type] || []).forEach((fn) => fn(ev));
    const target = (attrs) => { const t = { id: '', getAttribute: (n) => (attrs[n] === undefined ? null : attrs[n]) }; t.closest = () => t; return t; };
    const typeInto = (id, value) => {
      let b = boxes.filter((x) => x._id === id)[0];
      if (!b) { b = { _id: id, value: '', getAttribute: (n) => (n === 'data-opp-text' ? id : null) }; boxes.push(b); }
      b.value = value;
      fire('input', { target: b });
    };
    return { win, created, btn, calls, state, gate, boxes, overlay: () => created[0], html: () => (created[0] ? created[0].innerHTML : ''),
      decides: () => calls.filter((c) => c.name === 'oppDraftDecide'), lists: () => calls.filter((c) => c.name === 'oppDraftList'),
      typeInto,
      clickBtn: () => fire('click', { target: btn, preventDefault() {} }),
      opp: (a, id, extra) => fire('click', { target: target(Object.assign({ 'data-opp-act': a, 'data-opp-id': id }, extra || {})), preventDefault() {} }) };
  }
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    // dark
    {
      const e = boot({ opp: false });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn();
      await until(() => e.created[0], 'board');
      await tick(); await tick();
      ok('thumbtackOpportunities OFF (followUpBoard on): the board opens, no Thumbtack section, oppDraftList never called', !/Thumbtack Opportunities/.test(e.html()) && e.lists().length === 0 && e.decides().length === 0);
      e.opp('approve', 'ZZ1'); e.opp('snooze', 'ZZ1'); await tick();
      ok('...and a stray click on an opp control does nothing', e.decides().length === 0);
    }
    {
      const e = boot({ opp: true, board: false });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn(); await tick(); await tick();
      ok('followUpBoard OFF: the board does not open, so no Thumbtack call is made', e.created.length === 0 && e.lists().length === 0);
    }
    for (const role of ['viewer', 'member', 'sales_rep']) {
      const e = boot({ opp: true, claims: { role } });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn(); await tick(); await tick();
      ok('flag on but ' + role + ': no Thumbtack section, oppDraftList never called', !/Thumbtack Opportunities/.test(e.html()) && e.lists().length === 0, role);
    }
    // on
    {
      const e = boot({ opp: true });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn();
      await until(() => /opp-card/.test(e.html()), 'cards');
      ok('POSITIVE CONTROL: both flags on -> the section and both cards render inside the board overlay', /Thumbtack Opportunities to approve/.test(e.html()) && (e.html().match(/class="fub-row opp-card"/g) || []).length === 2 && /fub-box/.test(e.html()));
      ok('opening loads the cards exactly once, with no fields, and decides nothing', e.lists().length === 1 && JSON.stringify(e.lists()[0].data) === '{}' && e.decides().length === 0);
      ok('the section sits above the follow-up lists', e.html().indexOf('Thumbtack Opportunities to approve') < e.html().indexOf('Nobody needs a follow-up') || e.html().indexOf('Thumbtack Opportunities to approve') < e.html().indexOf('fub-total'));
      e.opp('approve', 'ZZ2');
      await until(() => e.decides().length === 1, 'approve call');
      ok('APPROVE sends ONE oppDraftDecide for the ONE card: exactly { oppId, action, text }', JSON.stringify(e.decides()[0].data) === JSON.stringify({ oppId: 'ZZ2', action: 'approve', text: TEXT + ' Second.' }), JSON.stringify(e.decides()[0].data));
      await until(() => e.lists().length === 2, 'reload after approve');
      ok('...then the list is reloaded; nothing else was called (no other card, no bulk call)', e.decides().length === 1 && e.calls.every((c) => c.name === 'oppDraftList' || c.name === 'oppDraftDecide'));
      ok('...and the answer is shown, saying nothing was sent', /Nothing was sent/.test(e.html()));
    }
    {
      const e = boot({ opp: true });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn();
      await until(() => /opp-card/.test(e.html()), 'cards');
      e.opp('snooze', 'ZZ1');
      await until(() => e.decides().length === 1, 'snooze');
      ok('SNOOZE sends { oppId, action: "snooze" } only', JSON.stringify(e.decides()[0].data) === JSON.stringify({ oppId: 'ZZ1', action: 'snooze' }));
      await until(() => e.lists().length === 2, 'reload');
      e.opp('skipopen', 'ZZ1');
      ok('Skip first opens the four reasons and sends nothing', /data-opp-reason="too_far"/.test(e.html()) && e.decides().length === 1);
      e.opp('skip', 'ZZ1', { 'data-opp-reason': 'too_far' });
      await until(() => e.decides().length === 2, 'skip');
      ok('SKIP sends { oppId, action: "skip", reason } only', JSON.stringify(e.decides()[1].data) === JSON.stringify({ oppId: 'ZZ1', action: 'skip', reason: 'too_far' }));
    }
    {
      const e = boot({ opp: true });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn();
      await until(() => /opp-card/.test(e.html()), 'cards');
      e.opp('edit', 'ZZ1');
      ok('Edit opens a box holding the draft text, escaped, and sends nothing', /<textarea[^>]*data-opp-text="ZZ1"/.test(e.html()) && e.html().includes('>' + OL.esc(TEXT) + '</textarea>') && e.decides().length === 0);
      e.typeInto('ZZ1', 'Hi, we are fully insured and can come by this week. Reply right here in Thumbtack.');
      e.opp('saveedit', 'ZZ1');
      await until(() => e.decides().length === 1, 'save edit');
      ok('SAVE EDIT sends { oppId, action: "edit", text } with what Jo typed', JSON.stringify(e.decides()[0].data) === JSON.stringify({ oppId: 'ZZ1', action: 'edit', text: 'Hi, we are fully insured and can come by this week. Reply right here in Thumbtack.' }));
      await until(() => e.lists().length === 2, 'reload');
      e.opp('edit', 'ZZ1');
      e.typeInto('ZZ1', 'Hi, we are fully insured. Reply here with a photo.');
      e.opp('approve', 'ZZ1');
      await until(() => e.decides().length === 2, 'approve edited');
      ok('APPROVE while editing approves exactly what is in the box', e.decides()[1].data.action === 'approve' && e.decides()[1].data.text === 'Hi, we are fully insured. Reply here with a photo.');
    }
    {
      const refusal = { ok: true, status: 'not_allowed', code: 'text_refused', message: 'This looks like a phone number (a long run of digits or number words). Phone numbers are not allowed in a Thumbtack message.' };
      const e = boot({ opp: true, decide: refusal });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn();
      await until(() => /opp-card/.test(e.html()), 'cards');
      e.opp('edit', 'ZZ1');
      e.typeInto('ZZ1', 'Call me at 513 555 0100, <b>fully insured</b>');
      e.opp('approve', 'ZZ1');
      await until(() => e.decides().length === 1, 'refused approve');
      await until(() => /Phone numbers are not allowed/.test(e.html()), 'refusal shown');
      ok('a server REFUSAL (phone shape) is shown on the card in the server\'s words', /Phone numbers are not allowed in a Thumbtack message/.test(e.html()));
      ok('...Jo\'s text is kept in the box (escaped), nothing was reloaded, the card is still there', e.html().includes('Call me at 513 555 0100, &lt;b&gt;fully insured&lt;/b&gt;') && e.lists().length === 1 && /data-opp-act="approve" data-opp-id="ZZ1"/.test(e.html()));
      ok('...and the page sent the text to the server rather than judging it itself (one call, the typed text)', e.decides().length === 1 && e.decides()[0].data.text.indexOf('513 555 0100') !== -1);
    }
    {
      const e = boot({ opp: true, decide: new Error('Network down') });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn();
      await until(() => /opp-card/.test(e.html()), 'cards');
      e.opp('approve', 'ZZ1');
      await until(() => /Could not save: Network down/.test(e.html()), 'error shown');
      ok('a failed call says nothing was changed, keeps the card, and can be tried again', /Nothing was changed/.test(e.html()) && !/data-opp-act="approve"[^>]*disabled/.test(e.html()) && e.lists().length === 1);
    }
    {
      const e = boot({ opp: true });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn();
      await until(() => /opp-card/.test(e.html()), 'cards');
      let release; e.gate.hold = new Promise((r) => { release = r; });
      e.opp('approve', 'ZZ1'); e.opp('approve', 'ZZ1'); e.opp('approve', 'ZZ2'); e.opp('snooze', 'ZZ1');
      await tick(); await tick();
      ok('DOUBLE TAP / rapid taps while one request is running send exactly ONE request', e.decides().length === 1, String(e.decides().length));
      ok('...and the card shows busy (its buttons are disabled)', /data-opp-act="approve" data-opp-id="ZZ1" disabled/.test(e.html()));
      release();
      await until(() => e.lists().length === 2, 'reload');
      e.opp('approve', 'ZZ2');
      await until(() => e.decides().length === 2, 'next approve');
      ok('after it finishes the next tap works', e.decides()[1].data.oppId === 'ZZ2');
    }
    {
      const e = boot({ opp: true, list: listOf([card('ZZ1')], { caps: { approvedToday: 8, perDay: 8, approvedThisWeek: 9, perWeek: 25 }, inSendHours: false, sendLabel: 'will send 8am' }) });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn();
      await until(() => /opp-card/.test(e.html()), 'cards');
      ok('at the cap the screen disables Approve and says why (the server enforces it too)', /data-opp-act="approve"[^>]*disabled/.test(e.html()) && /Approved today 8 of 8/.test(e.html()));
    }
    {
      const e = boot({ opp: true, list: listOf([card('ZZ1', { snoozedUntilMs: NOW + 600000 }), card('ZZ2', { status: 'approved', sendLabel: 'will send 8am', text: 'ZZ_QA approved' })]) });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn();
      await until(() => /Approved/.test(e.html()) && /snoozed/.test(e.html()), 'mixed');
      ok('a snoozed card is hidden and counted; an approved card is listed without buttons', !/data-opp-act="approve"/.test(e.html()) && /1 snoozed for an hour/.test(e.html()) && /Approved · will send 8am/.test(e.html()) && /Nothing has been sent/.test(e.html()));
    }
    {
      const e = boot({ opp: true, list: listOf([card('ZZ1', { text: '<img src=x onerror=alert(1)> "hi" & \'bye\'', city: '<script>x</script>', reasons: ['<b>bold</b>'] })]) });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn();
      await until(() => /opp-card/.test(e.html()), 'cards');
      ok('IN THE BOARD: an Opportunity\'s markup is shown as text, never as markup', !/<img|<script|<b>bold/.test(e.html()) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(e.html()) && /&lt;script&gt;x&lt;\/script&gt;/.test(e.html()));
    }
    {
      const e = boot({ opp: true, list: { ok: true, status: 'not_allowed', code: 'feature_off', message: 'The Thumbtack Opportunities watcher is not turned on yet.' } });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn();
      await until(() => e.lists().length === 1, 'list'); await tick(); await tick();
      ok('the server saying feature_off hides the section (no error shown)', !/Thumbtack Opportunities to approve/.test(e.html()) && !/Could not read/.test(e.html()));
      const k = boot({ opp: true, list: { ok: true, status: 'not_allowed', code: 'kill_switch', message: 'x' } });
      k.win.NBDFollowUpBoard.sync(); k.clickBtn(); await until(() => k.lists().length === 1, 'list'); await tick(); await tick();
      ok('the kill switch hides it too', !/Thumbtack Opportunities to approve/.test(k.html()));
      const p = boot({ opp: true, listErr: Object.assign(new Error('Only the account owner can use the Thumbtack Opportunities watcher.'), { code: 'functions/permission-denied' }) });
      p.win.NBDFollowUpBoard.sync(); p.clickBtn(); await until(() => p.lists().length === 1, 'list'); await tick(); await tick();
      ok('permission-denied (not the owner) hides the section quietly', !/Thumbtack Opportunities to approve/.test(p.html()) && !/Could not read/.test(p.html()));
      const u = boot({ opp: true, listErr: Object.assign(new Error('boom'), { code: 'functions/unavailable' }) });
      u.win.NBDFollowUpBoard.sync(); u.clickBtn(); await until(() => /Could not read the drafts: boom/.test(u.html()), 'error');
      ok('any other failure to read is said plainly and approves nothing', /Could not read the drafts: boom/.test(u.html()) && u.decides().length === 0);
    }
    {
      const e = boot({ opp: true });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn();
      await until(() => /opp-card/.test(e.html()), 'cards');
      e.win.NBDFollowUpBoard.close();
      e.opp('approve', 'ZZ1'); await tick();
      ok('after the board closes, a stray click on an opp control does nothing', e.decides().length === 0);
    }
  } finally { Date.now = realNow; }

  console.log('\n6. strict CSP and wiring');
  const code = strip(OPP), logic = strip(LOGIC), board = strip(BOARD), css = read('docs/pro/css/follow-up-board.css');
  ok('no inline event handler in the new markup or code', !/\son[a-z]+\s*=\s*["'\\]/i.test(code) && !/\son[a-z]+\s*=\s*["'\\]/i.test(logic));
  ok('no inline script, eval or new Function', !/<script|\beval\(|new Function\(/.test(code + logic));
  ok('no inline style attribute is produced (the inline-style ratchet stays put)', !/\bstyle\s*=/.test(code + logic));
  ok('one delegated click listener and one input listener', (code.match(/doc\.addEventListener\('click'/g) || []).length === 1 && (code.match(/doc\.addEventListener\('input'/g) || []).length === 1);
  ok('no network sink of its own (no fetch / XHR / sendBeacon / mailto / sms:)', !/\bfetch\(|XMLHttpRequest|sendBeacon|mailto:|sms:/.test(code + logic));
  ok('it talks to exactly two callables, both owner-only', (code.match(/'(oppDraft[A-Za-z]+)'/g) || []).filter((v, i, a) => a.indexOf(v) === i).sort().join() === "'oppDraftDecide','oppDraftList'");
  ok('it never touches Firestore directly (no getDocs / updateDoc / setDoc / collection)', !/getDocs|updateDoc|setDoc|addDoc|deleteDoc|collection\(/.test(code + logic));
  ok('the reserved send flag is never read; the one flag is thumbtackOpportunities', !/thumbtackOppSend/.test(code + logic + board) && /FLAG = 'thumbtackOpportunities'/.test(code));
  ok('there is no approve-all control anywhere', !/approve\s*all|approveAll|approve_all|approveall/i.test(code + logic));
  // Source-level backstop for the behavioural escaping tests above: a server field is never concatenated into markup bare.
  const bare = logic.split('\n').filter((l) => /['"]\s*\+\s*(c|ui|state|d|r)\.[A-Za-z]/.test(l) && !/esc\(/.test(l) && !/\+\s*(c|ui|state|d)\.[A-Za-z.]+\s*\+\s*['"]\s*(ms|min|h|mi)\b/.test(l));
  ok('no server field is concatenated into markup without esc() (source scan)', bare.length === 0, bare.join(' | ').slice(0, 300));
  ok('the board only asks the module for a section and repaints (a few lines)', /NBDOppApproval/.test(board) && /opp\.html\(\)/.test(board) && /NBDOppApproval\.open\(paint\)/.test(board) && /NBDOppApproval\.close\(\)/.test(board));
  ok('44px touch targets for the new textarea come from the shared .fub-btn / .fub-in rules; the new classes exist in the css', /\.opp-card/.test(css) && /\.opp-ta/.test(css) && /min-height: 44px/.test(css));
  const dash = read('docs/pro/dashboard.html');
  const iBoard = dash.indexOf('<script defer src="js/follow-up-board.js'), iLogic = dash.indexOf('<script defer src="js/opp-approval-logic.js'), iDom = dash.indexOf('<script defer src="js/opp-approval.js');
  ok('dashboard loads the logic, then the screen, both deferred, after the board', iBoard > 0 && iLogic > iBoard && iDom > iLogic);
  ok('the stylesheet version was bumped so browsers fetch the new rules', /css\/follow-up-board\.css\?v=2/.test(dash));
  const inlineScripts = (dash.match(/<script(?![^>]*\bsrc=)[^>]*>/g) || []).filter((s) => !/type="(application\/ld\+json|importmap)"/.test(s));
  ok('the dashboard gained no inline script', !inlineScripts.some((s) => /opp-approval/.test(s)));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
