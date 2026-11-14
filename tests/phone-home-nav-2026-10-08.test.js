/**
 * tests/phone-home-nav-2026-10-08.test.js — CRM phone batch E (phone audit
 * 2026-10-07 #6, #7, #10).
 *
 *   1. stage-write.js stageMoveNeedsConfirm — run, not regex-matched: a
 *      normal forward move does not ask; the cancellation-window warning and
 *      a destructive destination (Lost / Archived / Cancelled, by key or
 *      role) still do.
 *   2. customer-bootstrap progressStage asks ONLY through that rule and
 *      offers Undo (the same guarded commitStageChange back) for a plain move
 *      — the real function, sliced out and run with the real rule.
 *   3. Home (dashboard.html tpl-view-home): the needs-you strip sits ABOVE
 *      the Today list; the widgets, the No-next-step card and the game card
 *      sit inside the "More on Home" body; the header's extra links carry
 *      .home-hdr-extra and come again inside the body (no duplicate ids).
 *   4. today-home.css folds that body on a phone only (desktop unchanged).
 *   5. More drawer: Call Center, Schedule, Close Board, Door-to-Door are the
 *      first four items, under a "Field" heading; no item was lost.
 *
 * Converted 2026-11-14 (fragile-test plan, PR 0): sections 2-5 were regex
 * matches on the source text; they now run the code (2), query parsed tags
 * (3, 5) and read CSS declarations (4) through tests/lib/src-kit.js. The two
 * "cache-buster bumped past v=N" pins moved to
 * tests/asset-version-consistency-2026-11-14.test.js (one version per asset,
 * re-versioned when the file changes). See
 * documentation/runbooks/CONVERT-SOURCE-PIN-SUITE.md.
 *
 * Zero deps. Run: node tests/phone-home-nav-2026-10-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const K = require('./lib/src-kit');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

console.log('\n1. stageMoveNeedsConfirm (run in a vm)');
{
  const src = read('docs/pro/js/stage-write.js').replace(/^export\s+/mg, '');
  const ctx = { window: {}, console };
  let fn = null;
  try {
    vm.createContext(ctx);
    vm.runInContext(src + '\n;this.__f = typeof stageMoveNeedsConfirm === "function" ? stageMoveNeedsConfirm : null;', ctx);
    fn = ctx.__f;
  } catch (e) { ok('stage-write.js loads in a vm', false, e.message); }
  ok('stage-write.js exports stageMoveNeedsConfirm', typeof fn === 'function');
  if (fn) {
    ok('inspected → estimate sent: no confirm', fn('estimate_sent_cash', { warning: '', role: 'active' }) === false);
    ok('contract signed → permit: no confirm', fn('permit_pulled', { role: 'job' }) === false);
    ok('a closed (won) move: no confirm', fn('closed', { role: 'won' }) === false);
    ok('no opts at all: no confirm', fn('contacted') === false);
    ok('cancellation-window warning: confirm', fn('materials_ordered', { warning: 'The homeowner is still in the 3-day cancellation window' }) === true);
    ok('whitespace-only warning is no warning', fn('materials_ordered', { warning: '   ' }) === false);
    ok('lost (by key): confirm', fn('lost') === true && fn('Lost') === true && fn('closed_lost') === true);
    ok('archived / cancelled (by key): confirm', fn('archived') === true && fn('archive') === true && fn('cancelled') === true && fn('job_canceled') === true);
    ok('lost (by role): confirm', fn('went_elsewhere', { role: 'lost' }) === true);
    ok('a key that merely contains the letters is not destructive', fn('cancellation_window_review') === false && fn('lostwax') === false);
  }
}

(async () => {
console.log('\n2. progressStage asks only through the rule; Undo for a plain move (run)');
{
  const CB = 'docs/pro/js/customer-bootstrap.module.js';
  const cb = K.read(CB);
  const imp = K.esmImports(cb).find((i) => i.names._stageMoveNeedsConfirm);
  ok('imports stageMoveNeedsConfirm from stage-write.js', !!imp && imp.from === './stage-write.js' && imp.names._stageMoveNeedsConfirm === 'stageMoveNeedsConfirm', imp);
  ok('…and commitStageChange from the same file (the guarded writer Undo reuses)', !!imp && imp.names._commitStageChange === 'commitStageChange', imp);
  const fnSrc = K.sliceFn(cb, 'progressStage'), undoSrc = K.sliceFn(cb, '_undoStageMove');
  ok('progressStage and _undoStageMove were found', !!fnSrc && !!undoSrc);

  /** The real progressStage + _undoStageMove, with the REAL stageMoveNeedsConfirm, over spies. */
  function world(o) {
    const commits = [], toasts = [], asks = [], applied = [];
    let reloads = 0;
    const w = {
      _customerId: 'C1', db: {}, doc: () => ({}),
      _currentLead: { stage: o.from, jobType: 'retail', openWarrantyClaimId: o.claim || null }, _currentStage: o.from,
      stageLabel: (k) => k.toUpperCase(), stageRole: (k) => (o.roles && o.roles[k]) || null,
      nbdConfirm: (m) => { asks.push(m); return Promise.resolve(o.answer !== false); },
      showToast: (m, k) => toasts.push(typeof m === 'object' ? m : { message: m, type: k }),
      location: { reload() { reloads++; } },
      NBDJurisdiction: o.warn ? { workStartWarning: () => o.warn, resolveTimeZone: () => 'America/New_York' } : undefined,
      WarrantyClaim: { promptIntake: async () => true, promptResolution: async () => true },
    };
    const g = {
      window: w, document: { getElementById: () => null }, setTimeout: (f) => f(), console: { error() {} },
      _commitStageChange: async (...a) => { commits.push(a); if (o.race && commits.length === o.race.at) throw new Error(o.race.code); },
      _applyStageOnPage: (_lead, s) => { applied.push(s); w._currentStage = s; },
      _nextStageFor: () => null, _cbNotify() {},
    };
    K.loadInVm(['docs/pro/js/stage-write.js', 'progress'], g, { esm: true, src: { progress: 'var _stageMoveNeedsConfirm = stageMoveNeedsConfirm;\n' + fnSrc + ';\n' + undoSrc } });
    return { w, commits, toasts, asks, applied, reloads: () => reloads, move: (t, opts) => w.progressStage(t, opts) };
  }
  const undoOf = (t) => (t.toasts.find((x) => typeof x.undoAction === 'function') || {}).undoAction;

  const plain = world({ from: 'inspected', roles: { estimate_sent_cash: 'active' } });
  await plain.move('estimate_sent_cash');
  ok('a plain forward move asks nothing and writes once, through commitStageChange (to, from)',
    plain.asks.length === 0 && plain.commits.length === 1 && plain.commits[0][0] === 'C1' && plain.commits[0][1] === 'estimate_sent_cash' && plain.commits[0][2] === 'inspected', plain.commits);
  const undo = undoOf(plain);
  ok('…and its toast offers Undo', typeof undo === 'function', plain.toasts);
  if (undo) await undo();
  ok('Undo writes back through the same guarded commitStageChange (from ↔ to swapped)',
    plain.commits.length === 2 && plain.commits[1][1] === 'inspected' && plain.commits[1][2] === 'estimate_sent_cash' && plain.applied.join() === 'estimate_sent_cash,inspected', plain.commits);

  const again = world({ from: 'inspected' });
  await again.move('contacted');
  again.w._currentStage = 'negotiating';   // moved again since (another tap, another tab)
  await undoOf(again)();
  ok('Undo does nothing if the lead moved again since', again.commits.length === 1, again.commits);

  for (const code of ['STAGE_RACE_NOOP', 'STAGE_RACE_LOST']) {
    const race = world({ from: 'inspected', race: { at: 2, code } });
    await race.move('contacted');
    await undoOf(race)();
    ok('Undo refreshes on a race instead of clobbering (' + code + ')', race.reloads() === 1 && race.toasts.some((t) => /refreshing/.test(t.message || '')), race.toasts);
  }

  const lost = world({ from: 'inspected', answer: false });
  await lost.move('lost');
  ok('a destructive move (Lost) asks exactly once; "no" writes nothing', lost.asks.length === 1 && lost.asks[0] === 'Move customer to "LOST" stage?' && lost.commits.length === 0, lost.asks);
  const byRole = world({ from: 'inspected', roles: { went_elsewhere: 'lost' } });
  await byRole.move('went_elsewhere');
  ok('…by role too; "yes" moves it, with no Undo (it asked first)', byRole.asks.length === 1 && byRole.commits.length === 1 && !undoOf(byRole), byRole.toasts);

  const warn = world({ from: 'contract_signed', warn: 'The homeowner is still in the 3-day cancellation window' });
  await warn.move('materials_ordered');
  ok('the cancellation-window wording is kept, and the move still goes through on "yes"',
    warn.asks.length === 1 && warn.asks[0].startsWith('⚠ The homeowner is still in the 3-day cancellation window') && warn.asks[0].endsWith('Move customer to "MATERIALS_ORDERED" stage anyway?') && warn.commits.length === 1, warn.asks);

  const intake = world({ from: 'closed' });
  await intake.move('warranty_claim');
  const resolve = world({ from: 'warranty_claim', claim: 'WC1' });
  await resolve.move('closed');
  ok('warranty-claim moves are not undoable from a toast (into a claim, and out of an open one)',
    intake.commits.length === 1 && !undoOf(intake) && resolve.commits.length === 1 && !undoOf(resolve), [intake.toasts, resolve.toasts]);
  // positive control for the two checks above: the same world DOES offer Undo for a plain move
  const ctl = world({ from: 'closed' });
  await ctl.move('contacted');
  ok('…(control: the same world offers Undo for a plain move)', typeof undoOf(ctl) === 'function');
}

console.log('\n3. Home order: needs-you strip, Today, then More on Home');
{
  const dash = K.parseTags(K.read('docs/pro/dashboard.html'));
  const tpl = dash.byId('tpl-view-home');
  ok('tpl-view-home is a <template> on the dashboard', !!tpl && tpl.tag === 'template');
  const $ = (sel) => (tpl ? tpl.$(sel) : null);
  const att = $('#homeAttention'), plan = $('#todayPlan'), body = $('.home-more-body'), game = $('#homeGameCard');
  ok('#homeAttention comes before #todayPlan', !!att && !!plan && att.start < plan.start);
  ok('#todayPlan comes before the More on Home body', !!plan && !!body && plan.start < body.start && !body.contains(plan));
  for (const id of ['widgetGrid', 'homeNoNextStep']) ok('#' + id + ' sits inside the More on Home body', !!body && !!$('#' + id) && body.contains($('#' + id)));
  ok('the opt-in game card stays out of the fold (a rep who turned it on sees it)', !!game && !!body && game.start > plan.start && !body.contains(game) && game.start < body.start);
  const chk = $('#homeMoreChk'), lbl = $('label[for="homeMoreChk"]');
  ok('a checkbox + label disclosure (no script)', !!chk && chk.tag === 'input' && chk.attrs.type === 'checkbox' && chk.classes.includes('home-more-chk')
    && !!lbl && lbl.classes.includes('home-more-toggle') && lbl.attrs.id === 'homeMoreToggle');
  // four since 2026-10-16: "Arrange Home" (card-prefs.js) joined Sunday review / Catch up / Customize
  const extras = tpl ? tpl.$$('.home-hdr-extra').filter((e) => att && e.start < att.start) : [];
  ok('the four extra header links carry .home-hdr-extra (none is the orange primary)', extras.length === 4 && !extras.some((e) => e.classes.includes('btn-orange')), extras.length);
  const acts = $('.home-more-acts');
  const targets = acts ? acts.$$('[data-target]').map((e) => e.attrs['data-target']) : [];
  ok('the body repeats Sunday review / Catch up / Customize, with no ids',
    !!acts && ['weekreview', 'catchup', 'NBDWidgets.openPicker'].every((t) => targets.includes(t)) && acts.$$('[id]').length === 0, targets);
  const css = tpl ? K.cssRules(tpl.$$('style').map((s) => s.text).join('\n')) : [];
  const ha = K.cssRule(css, '.ha-item');
  ok('the needs-you chip is a 44px tap target', !!ha && parseFloat(ha['min-height']) >= 44, ha);
}

console.log('\n4. today-home.css folds the body on a phone only');
{
  const css = K.cssRules(K.read('docs/pro/css/today-home.css'));
  const top = (sel) => K.cssRule(css, sel) || {};
  const phone = (sel) => K.cssRule(css, sel, { media: '(max-width:768px)' }) || {};
  ok('desktop: the toggle and the repeated links are hidden', top('.home-more-toggle').display === 'none' && top('.home-more-acts').display === 'none');
  ok('desktop: nothing hides the body outside a media query',
    css.filter((r) => r.media === null && r.selectors.some((s) => /\.home-more-body$/.test(s)) && r.decls.display === 'none').length === 0);
  ok('phone: the body hides until the box is checked', phone('.home-more-chk:not(:checked)~.home-more-body').display === 'none');
  ok('phone: the header extras hide', phone('.home-hdr-acts>.home-hdr-extra').display === 'none');
  ok('phone: the toggle is a ≥44px target', parseFloat(phone('.home-more-toggle')['min-height']) >= 44, phone('.home-more-toggle'));
  const chk = css.filter((r) => r.selectors.includes('.home-more-chk'));
  ok('the hidden checkbox stays focusable (opacity:0, never display:none)',
    chk.some((r) => r.decls.opacity === '0') && !chk.some((r) => r.decls.display === 'none'), chk.map((r) => r.decls));
}

console.log('\n5. More drawer: field tools first');
{
  const menu = K.parseTags(K.read('docs/pro/dashboard.html')).byId('mobile-more-menu');
  ok('#mobile-more-menu is on the dashboard', !!menu);
  const nodes = menu ? menu.$$('div.mm-item, a.mm-item') : [];
  const items = nodes.map((e) => e.attrs['data-target'] || e.attrs.id || e.attrs['data-fn']);
  ok('the first four items are Call Center, Schedule, Close Board, Door-to-Door', JSON.stringify(items.slice(0, 4)) === JSON.stringify(['calls', 'schedule', 'closeboard', 'd2d']), items.slice(0, 6).join(','));
  const head = menu ? menu.$('.mm-section') : null;
  ok('they sit under the first heading, "Field"', !!head && head.text.trim() === 'Field' && !!nodes[0] && head.start < nodes[0].start);
  const want = ['home', 'dash', 'crm', 'prospects', 'est', 'd2d', 'map', 'photos', 'docs', 'products', 'job-templates', 'draw', 'training', 'academy', 'storm', 'closeboard', 'repos', 'talk-tank', 'calls', 'board', 'reports', 'expenses', 'schedule', 'signs', 'winback', 'careplan', 'money', 'weekreview', 'refrewards', 'openDailyProgramFromMore', 'mm-social', 'mm-roofrep', 'aiusage', 'joe', 'NBDAgentInbox.open', 'messaging', 'settings'];
  const missing = want.filter((k) => !items.includes(k));
  ok('no drawer item was lost (37)', missing.length === 0 && items.length === want.length, 'missing=' + missing.join(',') + ' n=' + items.length);
  ok('no item appears twice', new Set(items).size === items.length);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
