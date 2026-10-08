/**
 * tests/phone-home-nav-2026-10-08.test.js — CRM phone batch E (phone audit
 * 2026-10-07 #6, #7, #10).
 *
 *   1. stage-write.js stageMoveNeedsConfirm — run, not regex-matched: a
 *      normal forward move does not ask; the cancellation-window warning and
 *      a destructive destination (Lost / Archived / Cancelled, by key or
 *      role) still do.
 *   2. customer-bootstrap progressStage asks ONLY through that rule and
 *      offers Undo (the same guarded commitStageChange back) for a plain move.
 *   3. Home (dashboard.html tpl-view-home): the needs-you strip sits ABOVE
 *      the Today list; the widgets, the No-next-step card and the game card
 *      sit inside the "More on Home" body; the header's extra links carry
 *      .home-hdr-extra and come again inside the body (no duplicate ids).
 *   4. today-home.css folds that body on a phone only (desktop unchanged).
 *   5. More drawer: Call Center, Schedule, Close Board, Door-to-Door are the
 *      first four items, under a "Field" heading; no item was lost.
 *
 * Zero deps. Run: node tests/phone-home-nav-2026-10-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
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

console.log('\n2. progressStage asks only through the rule; Undo for a plain move');
{
  const cb = read('docs/pro/js/customer-bootstrap.module.js');
  const i = cb.indexOf('window.progressStage = async function');
  const ps = stripJs(cb.slice(i, cb.indexOf('\n};', i)));
  ok('imports stageMoveNeedsConfirm from stage-write.js', /import \{[^}]*stageMoveNeedsConfirm as _stageMoveNeedsConfirm[^}]*\} from "\.\/stage-write\.js"/.test(cb));
  ok('the rule is consulted with the warning and the destination role',
    /_stageMoveNeedsConfirm\(nextStage, \{ warning: cxlWarn, role: _destRole \}\)/.test(ps));
  // Every ask( in progressStage sits inside if (mustAsk) { … }.
  const asks = [];
  let at = -1; while ((at = ps.indexOf('await ask(', at + 1)) !== -1) asks.push(at);
  const guard = ps.indexOf('if (mustAsk) {');
  ok('exactly one ask, and it is inside if (mustAsk)', asks.length === 1 && guard !== -1 && asks[0] > guard && asks[0] - guard < 200, 'asks=' + asks.length);
  ok('the cancellation-window wording is kept', /Move customer to "\$\{label\}" stage anyway\?/.test(ps));
  ok('a plain move offers Undo through the toast', /undoAction: \(\) => _undoStageMove\(lead, oldStage, nextStage\)/.test(ps) && /let undoable = !mustAsk;/.test(ps));
  ok('warranty-claim moves are not undoable from a toast', (ps.match(/undoable = false;/g) || []).length === 2);
  const u = cb.indexOf('async function _undoStageMove(');
  const undo = stripJs(cb.slice(u, cb.indexOf('\n}\n', u)));
  ok('Undo writes back through the guarded commitStageChange (from ↔ to swapped)', /await _commitStageChange\(window\._customerId, fromStage, movedTo,/.test(undo));
  ok('Undo refreshes on a race instead of clobbering', /STAGE_RACE_NOOP/.test(undo) && /STAGE_RACE_LOST/.test(undo) && /location\.reload\(\)/.test(undo));
  ok('Undo does nothing if the lead moved again since', /!== movedTo\) return;/.test(undo));
  ok('customer-bootstrap cache-buster bumped past v=24', +((read('docs/pro/customer.html').match(/customer-bootstrap\.module\.js\?v=(\d+)/) || [])[1] || 0) > 24);
}

console.log('\n3. Home order: needs-you strip, Today, then More on Home');
{
  const html = read('docs/pro/dashboard.html');
  const t = html.indexOf('<template id="tpl-view-home">');
  const tpl = html.slice(t, html.indexOf('</template>', t));
  const pos = (s) => tpl.indexOf(s);
  ok('#homeAttention comes before #todayPlan', pos('id="homeAttention"') !== -1 && pos('id="homeAttention"') < pos('id="todayPlan"'));
  const body = pos('class="home-more-body"');
  ok('#todayPlan comes before the More on Home body', pos('id="todayPlan"') < body && body !== -1);
  for (const id of ['widgetGrid', 'homeNoNextStep']) ok('#' + id + ' sits inside the More on Home body', pos('id="' + id + '"') > body);
  ok('the opt-in game card stays out of the fold (a rep who turned it on sees it)', pos('id="homeGameCard"') > pos('id="todayPlan"') && pos('id="homeGameCard"') < body);
  ok('a checkbox + label disclosure (no script)', /<input type="checkbox" id="homeMoreChk" class="home-more-chk"/.test(tpl) && /<label for="homeMoreChk" class="home-more-toggle" id="homeMoreToggle">/.test(tpl));
  const hdr = tpl.slice(0, pos('id="homeAttention"'));
  ok('the three extra header links carry .home-hdr-extra', (hdr.match(/home-hdr-extra/g) || []).length === 3 && !/btn-orange[^"]*home-hdr-extra/.test(hdr));
  const acts = tpl.slice(pos('class="home-more-acts"'), pos('id="homeNoNextStep"'));
  ok('the body repeats Sunday review / Catch up / Customize, with no ids', /data-target="weekreview"/.test(acts) && /data-target="catchup"/.test(acts) && /NBDWidgets\.openPicker/.test(acts) && !/\bid="/.test(acts));
  ok('the needs-you chip is a 44px tap target', /\.ha-item\{[^}]*min-height:44px/.test(tpl));
  ok('today-home.css cache-buster bumped past v=2', +((html.match(/css\/today-home\.css\?v=(\d+)/) || [])[1] || 0) > 2);
}

console.log('\n4. today-home.css folds the body on a phone only');
{
  const css = read('docs/pro/css/today-home.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const top = css.split('@media')[0];
  ok('desktop: the toggle and the repeated links are hidden', /\.home-more-toggle\{display:none;\}/.test(css) && /\.home-more-acts\{display:none;\}/.test(css));
  ok('desktop: nothing hides the body outside a media query', !/home-more-body\{display:none/.test(top));
  const m = css.match(/@media \(max-width:768px\)\{([\s\S]*?)\n\}/g) || [];
  const phone = m.join('\n');
  ok('phone: the body hides until the box is checked', /\.home-more-chk:not\(:checked\) ~ \.home-more-body\{display:none;\}/.test(phone));
  ok('phone: the header extras hide', /\.home-hdr-acts > \.home-hdr-extra\{display:none;\}/.test(phone));
  ok('phone: the toggle is a ≥44px target', /\.home-more-toggle\{[\s\S]*?min-height:(4[4-9]|[5-9]\d)px/.test(phone));
  ok('the hidden checkbox stays focusable (no display:none)', /\.home-more-chk\{[^}]*opacity:0/.test(css) && !/\.home-more-chk\{[^}]*display:none/.test(css));
}

console.log('\n5. More drawer: field tools first');
{
  const html = read('docs/pro/dashboard.html');
  const a = html.indexOf('<div id="mobile-more-menu">');
  const menu = html.slice(a, html.indexOf('<!-- NBD UNIFIED APPEARANCE', a));
  const items = [...menu.matchAll(/<(?:div|a) class="mm-item[^"]*"([^>]*)>/g)].map((m) => {
    const t = m[1].match(/data-target="([^"]+)"/); const id = m[1].match(/id="([^"]+)"/); const f = m[1].match(/data-fn="([^"]+)"/);
    return (t && t[1]) || (id && id[1]) || (f && f[1]);
  });
  ok('the first four items are Call Center, Schedule, Close Board, Door-to-Door', JSON.stringify(items.slice(0, 4)) === JSON.stringify(['calls', 'schedule', 'closeboard', 'd2d']), items.slice(0, 6).join(','));
  ok('they sit under the first heading, "Field"', /^[\s\S]*?<div class="mm-section[^"]*">Field<\/div>/.test(menu) && menu.indexOf('>Field</div>') < menu.indexOf('data-target="calls"'));
  const want = ['home', 'dash', 'crm', 'prospects', 'est', 'd2d', 'map', 'photos', 'docs', 'products', 'job-templates', 'draw', 'training', 'academy', 'storm', 'closeboard', 'repos', 'talk-tank', 'calls', 'board', 'reports', 'expenses', 'schedule', 'signs', 'winback', 'careplan', 'money', 'weekreview', 'refrewards', 'openDailyProgramFromMore', 'mm-social', 'mm-roofrep', 'aiusage', 'joe', 'NBDAgentInbox.open', 'settings'];
  const missing = want.filter((k) => !items.includes(k));
  ok('no drawer item was lost (36)', missing.length === 0 && items.length === want.length, 'missing=' + missing.join(',') + ' n=' + items.length);
  ok('no item appears twice', new Set(items).size === items.length);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
