/**
 * tests/nbd-os-coach-ai-2026-11-09.test.js — NBD OS P2: the Coach's AI focus
 * line, browser half (docs/pro/js/os/coach-ai.js, the oscoachai bundle that
 * os/home.js loads; the owner's switch in edit mode's team controls;
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5.2).
 *
 * The REAL os/home.js, coach-logic.js and layouts/os.js run in the fake DOM
 * (tests/lib/nbd-os-home-harness.js); the coachLine callable is a fake.
 *   1. off by default: no AI markup, no bundle, no callable
 *   2. opted in: the bundle loads on the first Coach paint (never at boot),
 *      a "Today's focus (AI)" button sits above the top rule; NO call on paint
 *   3. one tap = one call, carrying rule ids and whole numbers only (a tenant
 *      stage name never leaves); the line shows above the rules, escaped, and
 *      is kept for the page only (no second call; never on the device, so the
 *      server's kill switch can pull it back at a reload); tomorrow it can be
 *      asked again
 *   4. no line (checked / capped / off) = nothing for the day; a failed call
 *      offers Try again
 *   5. the owner's switch: in edit mode for an owner / company_admin only,
 *      OFF by default, writes companyProfile.coachAiEnabled through the
 *      existing _saveCompanyProfile writer
 *   6. the files: no inline handlers, no style attributes, 44px, no text
 *      under 11px, no motion; nothing new on the dashboard's boot
 *
 * Run: node tests/nbd-os-coach-ai-2026-11-09.test.js
 */
'use strict';
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { read, makeWin, NOW, DK, byKey, text, click, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const tick = () => new Promise((r) => setImmediate(r));
const DAY = 86400000;
const AI_JS = read('docs/pro/js/os/coach-ai.js');
const AI_CSS = read('docs/pro/css/os/coach-ai.css');
const HOME_JS = read('docs/pro/js/os/home.js');

// a stuck lead in a tenant stage whose NAME must never reach the server
const leads = [{ id: 'S1', stage: 'fresh-bucket', createdAt: NOW - 40 * DAY }];
const labelOf = () => 'Maria Castellano Bucket';
function setup(o) {
  const opts = Object.assign({ surface: 'phone', leads, stageRole: () => 'new', home: { phone: [{ id: 'coach', s: 'l' }], desk: [{ id: 'coach', s: 'l' }] } }, o || {});
  const T = makeWin(opts);
  T.W.stageLabel = labelOf;
  T.W._companyProfile = o && o.profile !== undefined ? o.profile : { coachAiEnabled: true };
  T.loads = [];
  T.W.ScriptLoader = {
    bundles: {},
    loadBundle(name) {
      T.loads.push(name);
      (T.W.ScriptLoader.bundles[name] || []).filter((f) => /\.js(\?|$)/.test(f)).forEach((f) => vm.runInContext(read('docs/pro/' + f.split('?')[0]), T.W, { filename: f }));
      return Promise.resolve();
    },
  };
  T.calls = [];
  T.answer = { line: 'Call back the missed calls first, then chase the <b>old</b> leads.', cached: false };
  T.W._functions = {};
  T.W._httpsCallable = (fns, name) => (payload) => {
    T.calls.push({ name, payload: JSON.parse(JSON.stringify(payload)) });
    if (T.answer instanceof Error) return Promise.reject(T.answer);
    return Promise.resolve({ data: T.answer });
  };
  T.W._impl.mount({ surface: opts.surface === 'phone' ? 'phone' : 'desktop' });
  return T;
}
const card = (T) => byKey(T.document.getElementById('osPhone'), 'coach-1');

(async () => {
  console.log('\n1. off by default');
  {
    const T = setup({ profile: { companyName: 'Acme' } });
    await tick();
    ok('the Coach paints its rules', !!card(T) && !!card(T).querySelector('.os-hw-coach-line'), card(T) && text(card(T)));
    ok('no AI markup', !card(T).querySelector('.os-hw-ai, [data-oshw-coach="ai"]'));
    ok('the oscoachai bundle is not loaded', T.loads.indexOf('oscoachai') === -1, J(T.loads));
    ok('no callable', T.calls.length === 0);
    const T2 = setup({ profile: { coachAiEnabled: 'true' } });
    await tick();
    ok('a non-boolean flag is off too', !card(T2).querySelector('.os-hw-ai, [data-oshw-coach="ai"]') && T2.loads.indexOf('oscoachai') === -1);
    const T3 = setup({ profile: null });
    await tick();
    ok('no profile in memory yet: off', !card(T3).querySelector('[data-oshw-coach="ai"]'));
  }

  console.log('\n2. opted in: the button, on tap only');
  const T = setup();
  {
    await tick();
    ok('the first Coach paint asks for the bundle (runtime, never a <script> tag)', J(T.loads) === J(['oscoachai'])
      && J(T.W.ScriptLoader.bundles.oscoachai) === J(['css/os/coach-ai.css?v=1', 'js/os/coach-ai.js?v=1']), J(T.loads));
    await tick();
    const btn = card(T).querySelector('[data-oshw-coach="ai"]');
    ok('once it lands, "Today\'s focus (AI)" shows', !!btn && /Today's focus \(AI\)/.test(text(btn)), text(card(T)));
    const body = card(T).querySelector('.os-hw-body');
    const kids = body.children.filter((c) => c.attrs);
    ok('…above the top rule', kids.indexOf(btn) >= 0 && kids.indexOf(btn) < kids.indexOf(card(T).querySelector('.os-hw-coach-line')));
    ok('…a real button (type=button), 44px class', btn.tagName === 'BUTTON' && btn.getAttribute('type') === 'button' && btn.classList.contains('os-hw-btn'));
    ok('nothing was called on paint', T.calls.length === 0);
    T.W.dispatchEvent(new T.W.CustomEvent('nbd:data-refreshed'));
    ok('…nor on a repaint', T.calls.length === 0);
    ok('read cost 0 so far', T.reads.length === 0, J(T.reads));
  }

  console.log('\n3. one tap, one call, counts only; the line kept for the page, no line for the day');
  {
    click(T.dom, card(T).querySelector('[data-oshw-coach="ai"]'));
    ok('while it waits: "Finding today\'s focus…" (a status line)', /Finding today's focus/.test(text(card(T))) && !!card(T).querySelector('.os-hw-ai-busy[role="status"]'));
    await tick();
    ok('one coachLine call', T.calls.length === 1 && T.calls[0].name === 'coachLine', J(T.calls));
    const sent = T.calls[0].payload;
    ok('it sends the rules\' ids and evidence', Array.isArray(sent.rules) && sent.rules.length >= 2 && sent.rules.every((r) => /^[a-z-]+$/.test(r.id) && r.evidence && typeof r.evidence === 'object'), J(sent));
    ok('…whole numbers and true only: the tenant\'s stage name never leaves', sent.rules.every((r) => Object.values(r.evidence).every((v) => v === true || (Number.isInteger(v) && v >= 0)))
      && !/Maria|Bucket|Castellano/.test(J(sent)), J(sent));
    ok('…and no customer names (the plan\'s rows carry names; none are sent)', !/Customer|Three|Dee|img/.test(J(sent)), J(sent));
    await tick(); await tick();
    const line = card(T).querySelector('.os-hw-ai');
    ok('the line shows, labelled "AI focus"', !!line && /AI focus/.test(text(line)) && /Call back the missed calls first/.test(text(line)), text(card(T)));
    ok('…escaped (markup from the server is text)', !card(T).querySelector('.os-hw-ai b') && /<b>old<\/b>/.test(text(line)));
    const kids = card(T).querySelector('.os-hw-body').children.filter((c) => c.attrs);
    ok('…above the top rule, and the rules list still stands', kids.indexOf(line) < kids.indexOf(card(T).querySelector('.os-hw-coach-line')) && card(T).querySelectorAll('.os-hw-coach-more li').length >= 1);
    ok('no button any more today', !card(T).querySelector('[data-oshw-coach="ai"]'));
    // review fix (2026-11-09): the line is kept for this page only, never on the device, so an operator's
    // kill switch (checked by the server before its day cache) pulls it back at the next reload
    ok('the line is NOT written to the device (nothing in nbd_os_coach_ai)', !T.store.nbd_os_coach_ai, T.store.nbd_os_coach_ai);
    T.W.dispatchEvent(new T.W.CustomEvent('nbd:data-refreshed'));
    ok('a repaint shows the kept line with no second call', T.calls.length === 1 && /Call back the missed calls/.test(text(card(T))));
    // a fresh mount the same day (reload): the button again; a tap re-reads the server's day cache
    const R = setup({ store: { nbd_os_coach_ai: J({ d: DK, u: 'u1', line: 'An old device copy of a line.' }) } });
    await tick(); await tick();
    ok('after a reload: no line from a device copy, the button is back, no call on paint', !/old device copy/.test(text(card(R))) && !!card(R).querySelector('[data-oshw-coach="ai"]') && R.calls.length === 0, text(card(R)));
    R.answer = { line: 'Call back the missed calls first.', cached: true };
    click(R.dom, card(R).querySelector('[data-oshw-coach="ai"]'));
    await tick(); await tick();
    ok('…a tap gets the server\'s cached line (one call, no model spend on the server)', R.calls.length === 1 && /Call back the missed calls first/.test(text(card(R))));
    const K = setup();
    await tick(); await tick();
    K.answer = { line: null, cached: false, reason: 'unavailable' };
    click(K.dom, card(K).querySelector('[data-oshw-coach="ai"]'));
    await tick(); await tick();
    ok('the kill switch on (reason unavailable) → no line and no button for the day', !card(K).querySelector('.os-hw-ai, [data-oshw-coach="ai"]') && JSON.parse(K.store.nbd_os_coach_ai).none === true);
    const noneToday = K.store.nbd_os_coach_ai;
    const S = setup({ store: { nbd_os_coach_ai: noneToday } });
    await tick(); await tick();
    ok('…kept as none on the device for the day (a reload shows no button)', !card(S).querySelector('[data-oshw-coach="ai"]'));
    const O = setup({ store: { nbd_os_coach_ai: J(Object.assign({}, JSON.parse(noneToday), { u: 'someone-else' })) } });
    await tick(); await tick();
    ok('another user\'s none on this device never applies', !!card(O).querySelector('[data-oshw-coach="ai"]'));
    const Y = setup({ store: { nbd_os_coach_ai: J(Object.assign({}, JSON.parse(noneToday), { d: '2026-11-08' })) } });
    await tick(); await tick();
    ok('yesterday\'s none is gone: the button is back', !!card(Y).querySelector('[data-oshw-coach="ai"]'));
    const N = setup({ profile: { coachAiEnabled: false } });
    await tick(); await tick();
    ok('the company turned it off: no AI markup', !card(N).querySelector('.os-hw-ai, [data-oshw-coach="ai"]'));
  }

  console.log('\n3b. an M Coach on the phone: 2 rows have no room for it while rules wait behind More');
  {
    const Mm = setup({ home: { phone: [{ id: 'coach', s: 'm' }], desk: [] } });
    await tick(); await tick();
    ok('M, closed, with More: no AI markup (the card would clip)', !!card(Mm).querySelector('[data-oshw-coach="more"]') && !card(Mm).querySelector('.os-hw-ai, [data-oshw-coach="ai"]'), text(card(Mm)));
    click(Mm.dom, card(Mm).querySelector('[data-oshw-coach="more"]'));
    await tick(); await tick();
    const btn = card(Mm).querySelector('[data-oshw-coach="ai"]');
    ok('…opened (the rows of an L): the button is there, above the top rule', !!btn && card(Mm).classList.contains('is-open'));
    const one = { total: 1, appointments: [], promises: [], calls: [], promised: [{ key: 'p', leadId: 'L3', overdue: true }], estimates: [], money: [], stalled: [] };
    const M1 = setup({ leads: [], plan: one, home: { phone: [{ id: 'coach', s: 'm' }], desk: [] } });
    await tick(); await tick();
    ok('M with one rule (no More): the button shows', !card(M1).querySelector('[data-oshw-coach="more"]') && !!card(M1).querySelector('[data-oshw-coach="ai"]'), text(card(M1)));
  }

  console.log('\n3c. a screen reader hears the answer; focus follows it (review fix, 2026-11-09)');
  {
    const live = (T) => text(T.document.getElementById('osPhone').querySelector('.os-hw-live'));
    const act = (T) => T.document.activeElement;
    const A = setup();
    await tick(); await tick();
    let resolve;
    A.W._httpsCallable = (fns, name) => (payload) => { A.calls.push({ name, payload }); return new Promise((r) => { resolve = r; }); };
    click(A.dom, card(A).querySelector('[data-oshw-coach="ai"]'));
    ok('the tap moves focus to the waiting status line (not the top rule\'s action)', act(A) && act(A).classList && act(A).classList.contains('os-hw-ai-busy') && act(A).getAttribute('tabindex') === '-1', act(A) && act(A).className);
    await tick();
    resolve({ data: { line: 'Call back the missed calls first.' } });
    await tick(); await tick(); await tick();
    ok('the line arrives: the polite live region says it', /AI focus: Call back the missed calls first\./.test(live(A)), live(A));
    const line = card(A).querySelector('.os-hw-ai');
    ok('…and focus moves to the line itself (tabindex -1)', act(A) === line && line.getAttribute('tabindex') === '-1', act(A) && act(A).className);
    const B = setup();
    await tick(); await tick();
    B.answer = new Error('functions/unavailable');
    click(B.dom, card(B).querySelector('[data-oshw-coach="ai"]'));
    await tick(); await tick(); await tick();
    ok('a failed call is said aloud', /Couldn't reach the coach/.test(live(B)), live(B));
    ok('…and focus sits on Try again', act(B) === card(B).querySelector('[data-oshw-coach="ai"]'));
    const C = setup();
    await tick(); await tick();
    C.answer = { line: null, reason: 'checked' };
    click(C.dom, card(C).querySelector('[data-oshw-coach="ai"]'));
    await tick(); await tick(); await tick();
    ok('no line today is said aloud', /No AI focus line today/.test(live(C)), live(C));
    ok('…and focus falls to the top rule\'s action', act(C) === card(C).querySelector('.os-hw-coach-act'), act(C) && act(C).className);
    const D = setup();
    await tick(); await tick();
    let res2;
    D.W._httpsCallable = () => () => new Promise((r) => { res2 = r; });
    click(D.dom, card(D).querySelector('[data-oshw-coach="ai"]'));
    const elsewhere = D.document.getElementById('osPhone');
    elsewhere.focus();
    await tick();
    res2({ data: { line: 'Chase the estimates waiting on an answer.' } });
    await tick(); await tick(); await tick();
    ok('the rep moved on while it waited: the line is announced but focus is not pulled back', act(D) === elsewhere && /AI focus: Chase the estimates/.test(live(D)));
  }

  console.log('\n4. no line, and failures');
  {
    const A = setup();
    await tick(); await tick();
    A.answer = { line: null, cached: false, reason: 'checked' };
    click(A.dom, card(A).querySelector('[data-oshw-coach="ai"]'));
    await tick(); await tick();
    ok('a rejected line (the number check) → nothing, and no button for the rest of the day', !card(A).querySelector('.os-hw-ai, [data-oshw-coach="ai"]') && A.calls.length === 1, text(card(A)));
    ok('…kept as none for today', JSON.parse(A.store.nbd_os_coach_ai).none === true);
    ok('…the rules still stand', !!card(A).querySelector('.os-hw-coach-line'));
    const B = setup();
    await tick(); await tick();
    B.answer = new Error('functions/unavailable');
    click(B.dom, card(B).querySelector('[data-oshw-coach="ai"]'));
    await tick(); await tick();
    const retry = card(B).querySelector('[data-oshw-coach="ai"]');
    ok('a failed call offers one plain "Try again"', !!retry && /Try again/.test(text(retry)) && !B.store.nbd_os_coach_ai, text(card(B)));
    B.answer = { line: 'Chase the estimates waiting on an answer.' };
    click(B.dom, retry);
    await tick(); await tick();
    ok('…which works the second time', /Chase the estimates/.test(text(card(B))) && B.calls.length === 2);
    const M = setup();
    await tick(); await tick();
    M.answer = { line: null, reason: 'model' };
    click(M.dom, card(M).querySelector('[data-oshw-coach="ai"]'));
    await tick(); await tick();
    ok('the model down (reason model) → Try again, not none', !!card(M).querySelector('[data-oshw-coach="ai"]') && !M.store.nbd_os_coach_ai);
    // review fix (2026-11-09): "no-facts" (a client sending rules the server doesn't know) is kept only for
    // the rules it was asked about; when other rules fire later the button comes back
    const NF = setup();
    await tick(); await tick();
    NF.answer = { line: null, cached: false, reason: 'no-facts' };
    click(NF.dom, card(NF).querySelector('[data-oshw-coach="ai"]'));
    await tick(); await tick();
    ok('no-facts → no button while the same rules stand', !card(NF).querySelector('[data-oshw-coach="ai"]') && NF.calls.length === 1, text(card(NF)));
    const nfKept = JSON.parse(NF.store.nbd_os_coach_ai || 'null');
    ok('…kept with the rule ids it was about', nfKept && nfKept.none === true && typeof nfKept.ids === 'string' && nfKept.ids.length > 0, NF.store.nbd_os_coach_ai);
    NF.W.NBDToday.last = () => ({ total: 1, appointments: [], promises: [], calls: [], promised: [{ key: 'p', leadId: 'L3', overdue: true }], estimates: [], money: [], stalled: [] });
    NF.W._leads = [];
    NF.W.dispatchEvent(new NF.W.CustomEvent('nbd:today-rendered'));
    await tick();
    ok('…other rules fire later: the button is back', !!card(NF).querySelector('[data-oshw-coach="ai"]'), text(card(NF)));
    const E = setup({ leads: [], plan: { total: 0, appointments: [], promises: [], calls: [], promised: [], estimates: [], money: [], stalled: [] } });
    await tick(); await tick();
    ok('no rule fired → no AI button (nothing to focus on)', !card(E).querySelector('[data-oshw-coach="ai"]'), text(card(E)));
  }

  console.log('\n5. the owner\'s switch (edit mode, team controls)');
  {
    const homeOf = (T) => T.document.getElementById('osDesk').querySelector('.os-widgets');
    const O = setup({ surface: 'desktop', claims: { role: 'company_admin', companyId: 'c1' }, profile: { companyName: 'Acme' } });
    O.saves = [];
    O.W._saveCompanyProfile = (p) => { O.saves.push(J(p)); O.W._companyProfile = Object.assign({}, O.W._companyProfile, p); return Promise.resolve(O.W._companyProfile); };
    O.W.ScriptLoader.bundles.oshomeco = undefined;
    const col = homeOf(O);
    ok('not in edit mode: no switch', !col.querySelector('[data-osdo="homecoachai"]'));
    click(O.dom, col.querySelector('[data-osdo="homeedit"]'));
    const sw = col.querySelector('[data-osdo="homecoachai"]');
    ok('an admin in edit mode sees "Coach AI focus line", a switch, OFF by default', !!sw && sw.getAttribute('role') === 'switch' && sw.getAttribute('aria-checked') === 'false' && /Coach AI focus line/.test(text(sw)), sw && text(sw));
    click(O.dom, sw);
    await tick(); await tick(); await tick();
    ok('a tap loads the owner bundle and writes ONLY { coachAiEnabled: true } through _saveCompanyProfile', J(O.saves) === J(['{"coachAiEnabled":true}']) && O.loads.indexOf('oshomeco') !== -1, J(O.saves));
    ok('…says what it means', O.W.toasts.some((t) => /one focus sentence a day/.test(t.msg)), J(O.W.toasts));
    const sw2 = col.querySelector('[data-osdo="homecoachai"]');
    ok('…and the switch now reads ON', sw2 && sw2.getAttribute('aria-checked') === 'true' && sw2.classList.contains('is-on'));
    click(O.dom, sw2);
    await tick(); await tick(); await tick();
    ok('a second tap turns it off', O.saves[1] === '{"coachAiEnabled":false}', J(O.saves));
    const F = setup({ surface: 'desktop', claims: { role: 'company_admin', companyId: 'c1' }, profile: {} });
    F.W._saveCompanyProfile = () => Promise.reject(new Error('permission-denied'));
    click(F.dom, homeOf(F).querySelector('[data-osdo="homeedit"]'));
    click(F.dom, homeOf(F).querySelector('[data-osdo="homecoachai"]'));
    await tick(); await tick(); await tick();
    ok('a refused write says so plainly', F.W.toasts.some((t) => t.kind === 'error' && /Only an owner or admin/.test(t.msg)), J(F.W.toasts));
    for (const role of ['sales_rep', 'manager', 'viewer']) {
      const R = setup({ surface: 'desktop', claims: { role, companyId: 'c1' } });
      const c = homeOf(R);
      const e = c.querySelector('[data-osdo="homeedit"]');
      if (e) click(R.dom, e);
      ok(role + ' never sees the switch', !c.querySelector('[data-osdo="homecoachai"]'));
    }
  }

  console.log('\n6. the files');
  {
    const code = noComments(AI_JS);
    ok('coach-ai.js exists, exposes NBDOSCoachAI', /W\.NBDOSCoachAI = \{/.test(code));
    ok('no inline handlers, no style attributes, no el.style', !/\son[a-z]+=|style="|\.style\b|setAttribute\(\s*'style'/.test(code + noComments(HOME_JS).slice(HOME_JS.indexOf('coachAi'))));
    ok('every value into the DOM is escaped (the line, through esc())', /esc\(t\.line\)/.test(code));
    ok('it calls only coachLine, on tap (ask), never claudeProxy', /callable\('coachLine'/.test(code) && !/claudeProxy/.test(code));
    ok('no network on paint: html() has no call in it', (() => { const h = code.slice(code.indexOf('function html('), code.indexOf('function repaint(')); return !/callable|fetch|import\(/.test(h); })());
    ok('coach-ai.css: theme tokens only, no motion, nothing under 11px', !/#[0-9a-fA-F]{3,6}\b|rgb\(/.test(AI_CSS) && !/transition|animation/.test(AI_CSS)
      && (AI_CSS.match(/font-size:\s*([^;]+);/g) || []).every((d) => /var\(--ui-fs-(label|body-sm|body), 1[1-4]px\)/.test(d)), AI_CSS);
    ok('…the ask button keeps a 44px target (os-hw-btn) and min-width 44px', /\.os-hw-ai-ask \{[^}]*min-width: 44px/.test(AI_CSS) && /os-hw-btn os-hw-ai-ask/.test(code));
    const dash = read('docs/pro/dashboard.html');
    ok('nothing new on the dashboard\'s boot (no <script> or <link> for it)', !/coach-ai/.test(dash));
    const R = require(require('path').join(H.ROOT, 'docs/pro/js/layout-system.js'));
    ok('…and not in the OS layout\'s needs either (runtime bundle only)', !J(R.get('os').needs).includes('coach-ai'));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { ok('suite ran without throwing', false, e && e.stack); console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(1); });
