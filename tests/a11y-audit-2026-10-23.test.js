/**
 * tests/a11y-audit-2026-10-23.test.js
 *
 * The accessibility audit of the Daily Success day page, the Workout Coach and the CRM Call Center
 * (documentation/qa/a11y-audit-2026-10-23.md). Two halves:
 *   1. the pure rules (docs/pro/daily-success/js/a11y-logic.js, docs/pro/js/call-center-filters-logic.js) run for real,
 *      each with a positive case and a negative control;
 *   2. source pins on the markup / wiring, read with comments removed (a commented-out line must not satisfy a pin).
 * The behaviour in a real browser (focus order, trap, return, live regions) is scripted in
 * scripts/a11y-audit-browser.js, which needs Playwright and is run by hand.
 *
 * Run: node tests/a11y-audit-2026-10-23.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const A = require(path.join(ROOT, 'docs/pro/daily-success/js/a11y-logic.js'));
const F = require(path.join(ROOT, 'docs/pro/js/call-center-filters-logic.js'));

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const read = (p) => stripComments(fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'));
const HTML = read('docs/pro/daily-success/index.html');
const APP = read('docs/pro/daily-success/js/app.js');
const COACH = read('docs/pro/daily-success/js/workout-coach.js');
const UI = read('docs/pro/daily-success/js/a11y-ui.js');
const CC = read('docs/pro/js/call-center-view.js');
const TOAST = read('docs/pro/js/toast.js');
const DECK = read('docs/pro/js/triage-deck.js');
const CCCSS = read('docs/pro/css/phone-calls.css');
const COACHCSS = read('docs/pro/daily-success/css/workout-coach.css');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n1. rest timer: three announcements per rest, never one a second');
{
  let said = '', heard = [];
  for (let left = 90; left >= 0; left--) { const r = A.restSay(left, said); said = r.said; if (r.say) heard.push(left + ':' + r.say); }
  ok('a 90 s rest is heard exactly three times: start, last ten seconds, over', eq(heard, ['90:Rest 1:30', '10:10 seconds left', '0:Rest over. Go.']), heard.join(' | '));
  ok('a short 8 s rest skips the start line and still ends', (() => { let s = '', h = []; for (let l = 8; l >= 0; l--) { const r = A.restSay(l, s); s = r.said; if (r.say) h.push(r.say); } return eq(h, ['10 seconds left', 'Rest over. Go.']); })());
  ok('control: the same second asked twice is only spoken once', A.restSay(90, 'start').say === '' && A.restSay(0, 'done').say === '');
  ok('control: a negative / junk time still ends cleanly', A.restSay(-3, '').say === 'Rest over. Go.' && A.restSay(undefined, 'ten').say === 'Rest over. Go.');
  ok('fmtRest pads seconds and never goes negative', A.fmtRest(65) === '1:05' && A.fmtRest(-4) === '0:00' && A.fmtRest(600) === '10:00');
}

console.log('\n2. names for controls that have none');
{
  ok('an icon-only button takes its title', A.nameFor({ tag: 'button', text: '🔍', title: 'Search' }) === 'Search');
  ok('control: a button with real text is left alone (visible text is its name)', A.nameFor({ tag: 'button', text: 'SAVE', title: 'Save the page' }) === '');
  ok('a bare text box takes its placeholder', A.nameFor({ tag: 'input', placeholder: 'e.g. Blitz Day' }) === 'e.g. Blitz Day');
  ok('a textarea with neither placeholder nor title gets nothing (the caller then tries a neighbouring label)', A.nameFor({ tag: 'textarea' }) === '');
  ok('glyphOnly: emoji and symbols yes, words and digits no', A.glyphOnly('✕') && A.glyphOnly(' 🔍 ') && A.glyphOnly('+') && !A.glyphOnly('+ NEW') && !A.glyphOnly('5') && A.glyphOnly(''));
  ok('humanKey names the priority and gratitude boxes and nothing else', A.humanKey('l-p2') === 'Priority 2' && A.humanKey('l-g3') === 'Gratitude 3' && A.humanKey('l-win') === '' && A.humanKey(null) === '' && A.humanKey('l-p10') === '');
}

console.log('\n3. accordion, dialog trap, arrow keys, focus recovery');
{
  ok('an open section says aria-expanded=true and points at its body', eq(A.sectionAria(false, 'diet-pb'), { 'aria-expanded': 'true', 'aria-controls': 'diet-pb' }));
  ok('a collapsed section says aria-expanded=false', A.sectionAria(true, 'diet-pb')['aria-expanded'] === 'false');
  ok('no body id -> no aria-controls (never points at nothing)', !('aria-controls' in A.sectionAria(true, '')));
  ok('Tab wraps last -> first and Shift+Tab first -> last', A.trapTab(4, 3, false) === 0 && A.trapTab(4, 0, true) === 3 && A.trapTab(4, 1, false) === 2 && A.trapTab(4, 2, true) === 1);
  ok('control: focus outside the list lands on the first (or last with Shift) and an empty dialog gives -1', A.trapTab(3, -1, false) === 0 && A.trapTab(3, 9, true) === 2 && A.trapTab(0, 0, false) === -1);
  ok('rove: arrows wrap, Home/End jump, other keys are not ours', A.rove('ArrowRight', 2, 3) === 0 && A.rove('ArrowLeft', 0, 3) === 2 && A.rove('Home', 2, 3) === 0 && A.rove('End', 0, 3) === 2 && A.rove('a', 0, 3) === -1 && A.rove('ArrowRight', 0, 0) === -1);
  ok('focusSelector rebuilds "the same button" from data-*', A.focusSelector('BUTTON', { coachAction: 'done', i: '2', s: '0' }) === 'button[data-coach-action="done"][data-i="2"][data-s="0"]');
  ok('control: quotes in a value cannot break out of the selector, no data-* gives ""', A.focusSelector('button', { id: 'a"b' }) === 'button[data-id="a\\"b"]' && A.focusSelector('button', {}) === '');
  ok('reduced motion asks for instant scrolling, otherwise smooth', A.scrollBehavior({ matchMedia: () => ({ matches: true }) }) === 'auto' && A.scrollBehavior({ matchMedia: () => ({ matches: false }) }) === 'smooth' && A.scrollBehavior({}) === 'smooth');
}

console.log('\n4. Call Center rules');
{
  ok('"✓ Handled" is spoken "Handled for Dana Smith" (glyph dropped, person named)', F.actionLabel('✓ Handled', 'Dana Smith') === 'Handled for Dana Smith');
  ok('"▶ Play" and "📌 Promise" likewise', F.actionLabel('▶ Play', 'Mike Ross') === 'Play for Mike Ross' && F.actionLabel('📌 Promise', 'Mike Ross') === 'Promise for Mike Ross');
  ok('control: no person -> the plain label; nothing to say -> ""', F.actionLabel('Close', '') === 'Close' && F.actionLabel('✕', 'Dana') === '');
  ok('rove matches the tracker rule', F.rove('ArrowRight', 8, 9) === 0 && F.rove('End', 0, 9) === 8 && F.rove('x', 0, 9) === -1);
  ok('focusKey finds the same chip again after a redraw', F.focusKey({ 'data-cc': 'range', 'data-arg': 'today', 'data-id': null, id: '' }) === '[data-cc="range"][data-arg="today"]');
  ok('control: a quote in a value is escaped; an element with no known attribute gives ""', F.focusKey({ 'data-id': 'a"b' }) === '[data-id="a\\"b"]' && F.focusKey({ class: 'x' }) === '');
  ok('the live line counts people on Needs attention and calls elsewhere, with the active filters', F.liveSummary(3, true, 'Needs attention', ['Today']) === 'Showing 3 people, Needs attention, Today' && F.liveSummary(1, false, 'All', []) === 'Showing 1 call, All' && F.liveSummary(1, true, 'Needs attention') === 'Showing 1 person, Needs attention');
}

console.log('\n5. Daily Success page wiring');
{
  const iA = HTML.indexOf('a11y-logic.js'), iApp = HTML.indexOf('js/app.js'), iUi = HTML.indexOf('a11y-ui.js');
  ok('a11y-logic.js loads before app.js (app.js reads it for scrolling)', iA > 0 && iA < iApp);
  ok('a11y-ui.js is an external deferred script (strict CSP)', iUi > 0 && /<script src="[^"]*a11y-ui\.js[^"]*" defer><\/script>/.test(HTML));
  const ico = HTML.match(/<button class="btn-ico"[^>]*>/g) || [];
  ok('every icon-only topbar button carries an aria-label', ico.length >= 4 && ico.every((b) => /aria-label="[^"]{3,}"/.test(b)), ico.filter((b) => !/aria-label=/.test(b)).join(' '));
  ok('the dismiss ✕ of the onboarding banner is named', /class="ob-dismiss"[^>]*aria-label="[^"]+"/.test(HTML));
  ok('the search box has a label of its own', /<input class="sinp" id="sinp"[^>]*aria-label="[^"]+"/.test(HTML));
  const styles = HTML.split('<style');
  const last = styles[styles.length - 1];
  ok('reduced-motion rule is in the LAST <style> block (so it cascades after every base rule)', /@media \(prefers-reduced-motion:reduce\)\{[^}]*transition-duration:\.01ms!important/.test(last));
  ok('the focus ring is in the last <style> block and not removed by !important outline:none anywhere', /:focus-visible\{outline:2px solid/.test(last) && !/outline:\s*none\s*!important/.test(HTML));
  ok('control: the first style blocks do not already carry it (we really added it last)', !/prefers-reduced-motion/.test(styles.slice(0, -1).join('<style')));
  ok('no smooth scrolling left that ignores reduced motion', !/behavior:\s*'smooth'/.test(APP) && (APP.match(/scrollBehavior\(\)/g) || []).length === 2);
  ok('the hover handlers and app.js never assign document.body.className (phone / theme classes live on body)', !/document\.body\.className\s*=/.test(UI) && !/document\.body\.className\s*=/.test(COACH));
}

console.log('\n6. the a11y layer applies the rules');
{
  ok('accordion: sectionAria drives aria-expanded / aria-controls on .ph[data-action="toggle-section"]', /L\.sectionAria\(/.test(UI) && /\.ph\[data-action="toggle-section"\]/.test(UI));
  ok('div-buttons get role=button, tabindex=0 and Enter / Space activation', /setAttribute\('role', 'button'\)/.test(UI) && /setAttribute\('tabindex', '0'\)/.test(UI) && /ev\.key === 'Enter' \|\| ev\.key === ' '/.test(UI));
  ok('dialogs: role=dialog, aria-modal, inert page behind, trapped Tab, focus returned', /'aria-modal', 'true'/.test(UI) && /setAttribute\('inert', ''\)/.test(UI) && /L\.trapTab\(/.test(UI) && /target\.focus\(/.test(UI));
  ok('inert is lifted BEFORE focus goes back (an inert opener cannot take focus)', /if \(closed\.length\) setInert\(stack\.length \? stack\[stack\.length - 1\]\.host : null\);\n\s*closed\.forEach/.test(UI));
  ok('a redraw inside a dialog recovers focus', /function recoverFocus/.test(UI) && /L\.focusSelector\(/.test(UI));
  ok('habit dots are named "<habit>, <day>" and expose aria-pressed', /function habits\(/.test(UI) && /'aria-pressed'/.test(UI));
  ok('landmarks: banner, navigation, main, search and the page h1', ['banner', 'navigation', 'main', 'search'].every((r) => new RegExp("role: '" + r + "'").test(UI)) && /role: 'heading', 'aria-level': '1'/.test(UI));
  ok('the status line (#nbd-toast) is a polite live region', /\$\('#nbd-toast'\)/.test(UI) && /'aria-live': 'polite'/.test(UI));
}

console.log('\n7. Workout Coach');
{
  const all = COACH.match(/<button class="wc-chip[^>]*>/g) || [];
  // the "x ✕" chip REMOVES an avoided lift (an action, not a toggle): it is named instead
  const chips = all.filter((c) => !/data-coach-action="unavoid-ex"/.test(c));
  ok('every toggle chip has aria-pressed (' + chips.length + ' templates)', chips.length >= 7 && chips.every((c) => /aria-pressed=/.test(c)), chips.filter((c) => !/aria-pressed=/.test(c)).join(' '));
  ok('the remove-an-avoided-lift chip is named for what it removes', all.length === chips.length + 1 && /data-coach-action="unavoid-ex"/.test(all.join('')) && all.filter((c) => /unavoid-ex/.test(c)).every((c) => /aria-label="Stop avoiding /.test(c)));
  ok('the set check is a toggle button', /<button class="wc-check[^>]*aria-pressed=/.test(COACH));
  ok('the gear says whether settings are open', /class="wc-gear[^>]*aria-expanded=/.test(COACH));
  ok('the rest text is a role=timer element, not announced per tick', /id="wcRestT" role="timer" aria-live="off"/.test(COACH));
  ok('negative control: the tick no longer rebuilds the whole #wcRest (that dropped focus off Skip every second)', !/getElementById\('wcRest'\)[\s\S]{0,80}innerHTML\s*=\s*restText\(\)/.test(COACH));
  ok('the milestones come from restSay and go to ONE persistent polite region', /if \(A\) \{ const r = A\.restSay\(restLeft\(\), rest\.said \|\| ''\); rest\.said = r\.said; say\(r\.say\); \}/.test(COACH) && /id = 'wcSay'/.test(COACH) && /setAttribute\('aria-live', 'polite'\)/.test(COACH));
  ok('the announcer is created on the page, not inside the redrawn sheet', /document\.body\.appendChild\(el\)/.test(COACH.slice(COACH.indexOf('function say('))));
  ok('visually-hidden helper exists in the coach stylesheet (and the timer span keeps the flex layout)', /\.wc-sr\s*\{[^}]*clip:/.test(COACHCSS) && /\.wc-rest-t\s*\{/.test(COACHCSS));
  ok('the ready-check rows are named groups', /class="wc-ready-row" role="group" aria-label=/.test(COACH));
}

console.log('\n8. Call Center, toasts, deck');
{
  ok('tabs: each tab has an id, aria-controls and a roving tabindex', /role="tab" id="ccTab-/.test(CC) && /aria-controls="ccPanel"/.test(CC) && /tabindex="' \+ \(active\[0\] === f\[0\]/.test(CC));
  ok('the list sits in a tabpanel labelled by the active tab', /id="ccPanel" role="tabpanel" aria-labelledby="ccTab-'/.test(CC));
  ok('arrow keys move between the tabs through the pure rove()', /FX\.rove\(e\.key/.test(CC) && /state\.refocus = '\[data-cc="filter"\]\[data-arg="'/.test(CC) && /state\.refocus \|\| focusKeyOf\(/.test(CC));
  ok('chips keep aria-pressed (existing) and the tablist is named', /aria-pressed="' \+ \(on \? 'true' : 'false'\)/.test(CC) && /role="tablist" aria-label="Call categories"/.test(CC));
  ok('a redraw restores focus to the same control, else to the panel', /function restoreFocus/.test(CC) && /FX\.focusKey\(/.test(CC) && /querySelector\('#ccPanel'\)/.test(CC));
  ok('negative control: the filter summary is not a role=status that is torn down every redraw', !/cc-filter-sum" role="status"/.test(CC));
  ok('one persistent polite live line reads the new count', /id = 'ccLive'/.test(CC) && /FX\.liveSummary\(/.test(CC) && /\.cc-sr\s*\{[^}]*clip:/.test(CCCSS));
  ok('status lines under each card are role=status, action buttons are named per person', /\[data-cc-status\]/.test(CC) && /FX\.actionLabel\(/.test(CC));
  ok('the h1 emoji is hidden from screen readers and the recording player is named', /<h1 class="cc-title"><span aria-hidden="true">/.test(CC) && /aria-label', 'Call recording'/.test(CC));
  ok('the a11y pass can never break the list (best effort, guarded)', /try \{ a11yApply\(/.test(CC));
  ok('focus ring for the Call Center controls', /\.cc-tab:focus-visible[^{]*\{\s*outline:/.test(CCCSS));
  ok('toasts: container is a polite status region; errors are role=alert', /setAttribute\('role', 'status'\)/.test(TOAST) && /setAttribute\('aria-live', 'polite'\)/.test(TOAST) && /type === 'error'\) toast\.setAttribute\('role', 'alert'\)/.test(TOAST));
  ok('toasts: the first toast is added after its region exists (a new live region misses what it is born with)', /container\.__fresh = true;/.test(TOAST) && /if \(container\.__fresh\) \{ container\.__fresh = false;/.test(TOAST) && /setTimeout\(\(\) => container\.appendChild\(toast\), 50\)/.test(TOAST));
  ok('triage deck: named dialog, focus moved in, opener refocused on close', /setAttribute\('aria-label', cfg\.title/.test(DECK) && /st\.opener =/.test(DECK) && /back\.focus\(/.test(DECK));
}

console.log('\n8b. surfaces that landed after the first pass (Progress measurements / photos, accent swatches, status chips)');
{
  // this file has "image/*" inside a string, which the block-comment stripper would take for a comment start: drop whole comment lines instead
  const MS = fs.readFileSync(path.join(ROOT, 'docs/pro/daily-success/js/measurements-ui.js'), 'utf8').replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
  const AC = read('docs/pro/daily-success/js/accent-ui.js');
  const toggles = (MS.match(/data-ms-action="(site|pose|unit)"/g) || []).length;
  ok('site, pose and unit chips are all toggles with aria-pressed', toggles === 3 && (MS.match(/aria-pressed="' \+ \((s\.id === site|p\.id === pose|u === unit)\)/g) || []).length === 3);
  ok('each photo Delete button says which photo', /aria-label="Delete ' \+ esc\(pose\) \+ ' photo from ' \+ esc\(p\.date\)/.test(MS));
  ok('photos have alt text and the measurement box a label', /alt="' \+ esc\(pose\) \+ ' photo from/.test(MS) && /id="msInput"[^>]*aria-label=/.test(MS));
  ok('accent swatches are a named radiogroup with aria-checked and a label each', /role="radiogroup" aria-label="Accent colour"/.test(AC) && /role="radio" aria-checked=/.test(AC) && /aria-label="' \+ esc\(a\.label\)/.test(AC));
  ok('status chips go through chipBtn (aria-pressed) inside a named group', /role="group" aria-label="Status">' \+ FX\.STATUSES\.map\(function \(s\) \{ return chipBtn\('status'/.test(CC));
  ok('a redraw right after a Progress / accent tap puts focus back', /function recoverTap/.test(UI) && /button\[data-ms-action\],button\[data-accent-pick\]/.test(UI) && /recoverTap\(\);\n  \}/.test(UI));
}

console.log('\n9. this suite is wired into CI');
{
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/ci-manifest.json'), 'utf8'));
  ok('listed in the node bucket', Array.isArray(m.node) && m.node.includes('a11y-audit-2026-10-23.test.js'));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
