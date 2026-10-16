/**
 * tests/crm-layouts-audit-fixes-2026-10-15.test.js — the High and Medium
 * fixes from the CRM layouts audit (2026-10-15). The rendered checks (Island's
 * row at 390 px, Mission's map height, contrast as painted) live in
 * tests/crm-layouts-render-2026-10-15.test.js; this file pins the source and
 * runs the pure parts.
 *
 *   D1  kit row card: the time label can shrink and the name column keeps room
 *   D2  Mission: "What closes this week" is out of the map column
 *   D3  closes-week classes are cwk- (Crew owns cw-)
 *   D4  Crew and Inbox show the card as one line that opens it
 *   D5  accent TEXT uses --ui-accent-text (>= 4.5:1 on navy and on light)
 *   D6/D8 44 px targets: closes-week buttons, "Show all", the storm scrubber
 *   D16 text drafts go through NBDPhoneShare.checkText on the tap
 *   D13 Mission says "storm feed unavailable", never a stale all-clear
 *   D12 Bento's "couldn't save" fires on a failed save, never on no change
 *   D15 Crew says "Loading" instead of a false empty roster / tray
 *   D21 light mode loads the theme engine at boot
 *   D30 Field's upload line says "All uploaded" only after a real 0
 * (D14, the fail-closed settings read, is behaviour-tested in
 * tests/layout-system-2026-10-11.test.js.)
 *
 * Run: node tests/crm-layouts-audit-fixes-2026-10-15.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 600) : '')); }
}
/** The declarations of the first rule whose selector ends with `sel`. */
function rule(css, sel) {
  const src = stripComments(css);
  let i = -1;
  for (;;) {
    i = src.indexOf(sel, i + 1);
    if (i === -1) return null;
    const after = src.slice(i + sel.length).match(/^\s*\{/);
    if (after) {
      const open = src.indexOf('{', i);
      return src.slice(open + 1, src.indexOf('}', open));
    }
  }
}
const decl = (body, prop) => {
  const m = body && body.match(new RegExp('(?:^|[;\\s])' + prop.replace(/-/g, '\\-') + '\\s*:\\s*([^;]+)'));
  return m ? m[1].trim() : null;
};

const KIT_CSS = read('docs/pro/css/layouts/kit.css');
const CWK_CSS = read('docs/pro/css/closes-week.css');
const CWK_JS = read('docs/pro/js/closes-week.js');
const MISSION_JS = read('docs/pro/js/layouts/mission.js');
const MISSION_CSS = read('docs/pro/css/layouts/mission.css');
const CREW_JS = read('docs/pro/js/layouts/crew.js');
const CREW_CSS = read('docs/pro/css/layouts/crew.css');
const INBOX_JS = read('docs/pro/js/layouts/inbox.js');
const UI = read('docs/pro/css/ui-primitives.css');

console.log('\nD1. kit row card');
{
  const t = rule(KIT_CSS, '.lk-card-row .lk-time');
  const m = rule(KIT_CSS, '.lk-card-row .lk-main');
  const r = rule(KIT_CSS, '.lk-card-row');
  ok('the time label may shrink (not flex:none) and has min-width:0', t && !/\bnone\b/.test(decl(t, 'flex') || 'none') && decl(t, 'min-width') === '0', t);
  ok('the name column keeps a real basis (never squeezed to 0 px) and may itself shrink', m && /^1 1 \d+(\.\d+)?em$/.test(decl(m, 'flex') || '') && decl(m, 'min-width') === '0', m);
  ok('the row wraps, so the name drops under a long time label', r && decl(r, 'flex-wrap') === 'wrap', r);
}

console.log('\nD2. Mission: the closes-week card is out of the map column');
{
  const shell = MISSION_JS.slice(MISSION_JS.indexOf('function shell()'), MISSION_JS.indexOf('function slot('));
  const center = (shell.match(/<section class="mc-center">([\s\S]*?)<\/section>/) || [])[1] || '';
  ok('.mc-center holds only the map and the timeline', /mc-map/.test(center) && !/cwk-slot|cw-slot/.test(center), center);
  ok('the card has its own cell in .mc-body, after the right panel (not inside a panel render() rewrites)',
    /<aside class="mc-side mc-right" data-mc-slot="right"><\/aside>' \+[\s\S]*?'<div class="mc-side mc-cwk" data-cwk-slot="mission"><\/div><\/div><\/div>'/.test(shell), shell);
  const phone = MISSION_CSS.slice(MISSION_CSS.indexOf('@media (max-width: 900px)'));
  ok('phone: rows sized to content, the map has its own height, the card is the LAST row',
    /\.mc-body \{ grid-template-columns: 1fr; grid-template-rows: max-content max-content max-content max-content;/.test(phone)
      && /\.mc-map \{ flex: none; height: clamp\(240px, 44vh, 420px\); \}/.test(phone) && /\.mc-cwk \{ grid-row: 4;/.test(phone) && !/minmax\(220px, 46vh\)/.test(stripComments(MISSION_CSS)));
  ok('laptop: the card sits under the left rail; map and path span both rows', /\.mc-cwk \{ grid-column: 1; grid-row: 2;/.test(MISSION_CSS) && /\.mc-center \{ grid-column: 2; grid-row: 1 \/ span 2; \}/.test(MISSION_CSS));
}

console.log('\nD3/D4. closes-week card: cwk- classes, compact in Crew and Inbox');
// a vm with a fake DOM: two hosts (one full, one compact) and the click delegate
function loadCard(rows) {
  let click = null;
  class Host {
    constructor(compact) { this.compact = compact; this._h = ''; this.firstChild = null; this.hidden = true; }
    hasAttribute(k) { return k === 'data-cwk-compact' && this.compact; }
    get innerHTML() { return this._h; }
    set innerHTML(v) { this._h = v; this.firstChild = v ? {} : null; }
  }
  const full = new Host(false), compact = new Host(true);
  const win = { _leadsLoaded: true, _leads: rows.map((r) => ({ id: r.leadId, firstName: 'Pat', phone: '(859) 555-0142' })),
    NBDClosesWeekLogic: { rank: () => rows }, addEventListener() {}, _isNbdPlatformTenant: () => true };
  win.window = win;
  const doc = { addEventListener: (t, f) => { if (t === 'click') click = f; }, querySelectorAll: () => [full, compact], querySelector: () => null, getElementById: () => null, body: {} };
  const c = { window: win, document: doc, localStorage: { getItem: () => null }, setTimeout: () => 0, Math, JSON, Date, encodeURIComponent, String, Number, Array, Object,
    MutationObserver: function () { this.observe = () => {}; } };
  vm.createContext(c);
  vm.runInContext(CWK_JS, c);
  const press = (attr, val) => click({ target: { closest: (sel) => (sel === '[' + attr + ']' ? { getAttribute: () => val } : null) }, preventDefault() {} });
  return { win, full, compact, press };
}
const ROWS = [
  { leadId: 'L1', name: 'Ben <Albright>', stageLabel: 'Negotiating', projectedValue: 20000, likelihoodPct: 50, score: 10000, reason: 'opened estimate', nextAction: { kind: 'text', label: 'Text' } },
  { leadId: 'L2', name: 'Cy', stageLabel: 'Estimate sent', projectedValue: 10000, likelihoodPct: 20, score: 2000, reason: 'quiet', nextAction: { kind: 'call', label: 'Call' } },
];
{
  const K = loadCard(ROWS);
  const classes = (h) => [...h.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
  const all = classes(K.full.innerHTML).concat(classes(K.compact.innerHTML));
  ok('every class the card paints is cwk- (none of Crew\'s cw- names)', all.length > 5 && all.every((c) => /^cwk-/.test(c)), all.filter((c) => !/^cwk-/.test(c)).join());
  const sels = [...stripComments(CWK_CSS).matchAll(/\.(c[a-z]*-[a-z-]+)/g)].map((m) => m[1]);
  ok('closes-week.css styles only cwk- classes', sels.length > 5 && sels.every((s) => /^cwk-/.test(s)), sels.filter((s) => !/^cwk-/.test(s)).join());
  const crewSels = new Set([...stripComments(CREW_CSS).matchAll(/\.(cw[a-z]*-[a-z0-9-]+)/g)].map((m) => m[1]));
  ok('no class the card paints is styled by crew.css', !all.some((c) => crewSels.has(c)), all.filter((c) => crewSels.has(c)).join());
  ok('a plain slot gets the full card', /class="cwk-list"/.test(K.full.innerHTML) && !/data-cwk-open/.test(K.full.innerHTML));
  const c0 = K.compact.innerHTML;
  ok('a compact slot gets ONE line: weighted total, count, the top deal (escaped), "See all"',
    /<button type="button" class="cwk-sum" data-cwk-open="1" aria-expanded="false">/.test(c0) && /\$12,000 weighted · 2 deals · top: Ben &lt;Albright&gt;/.test(c0)
      && /See all/.test(c0) && !/cwk-list|cwk-row/.test(c0), c0);
  K.press('data-cwk-open', '1');
  ok('"See all" opens the full card in the compact slot, with a Hide button', /class="cwk-list"/.test(K.compact.innerHTML) && /data-cwk-open="0"[^>]*>Hide</.test(K.compact.innerHTML));
  ok('…and the plain slot is unchanged (no Hide there)', !/data-cwk-open/.test(K.full.innerHTML));
  K.press('data-cwk-open', '0');
  ok('Hide folds it back to the one line', K.compact.innerHTML === c0);
  ok('Crew and Inbox ask for the compact card', /data-cwk-slot="crew" data-cwk-compact="1"/.test(CREW_JS) && /data-cwk-slot="inbox" data-cwk-compact="1"/.test(INBOX_JS));
  ok('no layout still leaves an old [data-cw-slot]', !['field', 'focus', 'inbox', 'crew', 'mission'].some((f) => /data-cw-slot/.test(read('docs/pro/js/layouts/' + f + '.js'))));
  const empty = loadCard([]);
  ok('nothing to rank: the compact line says so and opens nothing', /nothing open with a value/.test(empty.compact.innerHTML) && !/data-cwk-open/.test(empty.compact.innerHTML));
}

console.log('\nD5. accent text is readable');
{
  const m = UI.match(/--ui-accent-text:\s*color-mix\(in srgb,\s*var\(--orange[^)]*\)\s*(\d+)%,\s*var\(--t[^)]*\)\)/);
  ok('--ui-accent-text is defined in the FOUNDATION block from theme tokens only', !!m && UI.indexOf('--ui-accent-text') > UI.indexOf('FOUNDATION (A1'));
  const p = m ? Number(m[1]) / 100 : 1;
  const hx = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((x) => x + x).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const lum = (c) => { const n = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * n(c[0]) + 0.7152 * n(c[1]) + 0.0722 * n(c[2]); };
  const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const mix = (a, b) => a.map((v, i) => v * p + b[i] * (1 - p));
  const themes = {};
  for (const t of read('docs/pro/css/theme-system.css').matchAll(/:root\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)) {
    const v = {}; for (const d of t[2].matchAll(/--([a-z0-9]+):\s*(#[0-9a-fA-F]{3,6})\b/g)) v[d[1]] = hx(d[2]);
    themes[t[1]] = v;
  }
  const worst = (name) => { const v = themes[name]; const tok = mix(v.orange, v.t); return Math.min(...['bg', 's', 's2', 's3'].filter((k) => v[k]).map((k) => cr(tok, v[k]))); };
  const nbd = themes['nbd-original'];
  ok('brand orange as text on the nbd-original navy is under 4.5:1 (the defect this fixes)', nbd && cr(nbd.orange, nbd.s) < 4.5);
  ok('--ui-accent-text clears 4.5:1 on every nbd-original surface (bg, s, s2, s3)', nbd && worst('nbd-original') >= 4.5, nbd && worst('nbd-original').toFixed(2));
  const light = Object.keys(themes).filter((k) => themes[k].bg && lum(themes[k].bg) > 0.5 && themes[k].orange && themes[k].t);
  ok('…and on the light themes it gets darker, never lighter (>= 4.5:1 on paper)', themes.paper && worst('paper') >= 4.5 && light.length >= 2, themes.paper && worst('paper').toFixed(2));
  // no stylesheet in the layouts (or the card, or Classic's active nav item) uses the brand orange as TEXT
  const files = fs.readdirSync(path.join(ROOT, 'docs/pro/css/layouts')).map((f) => 'docs/pro/css/layouts/' + f).concat(['docs/pro/css/closes-week.css']);
  const bad = [];
  for (const f of files) {
    read(f).replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, '')).split('\n').forEach((ln, i) => { if (/(^|[\s;{])color\s*:\s*var\(--orange\)/.test(ln)) bad.push(f + ':' + (i + 1)); });
  }
  ok('no layout stylesheet uses var(--orange) as a text colour', bad.length === 0, bad.join(', '));
  const dash = read('docs/pro/css/dashboard-app.css');
  ok('Classic\'s active sidebar item reads the token', /\.ni\.active\{color:var\(--ui-accent-text, var\(--orange\)\);/.test(dash));
  const field = read('docs/pro/css/layouts/field.css');
  ok('Field\'s stop time and "DO THIS" read the token', /\.fa-now-time \{[^}]*color: var\(--ui-accent-text, var\(--orange\)\)/.test(field) && /\.fa-do \{[^}]*color: var\(--ui-accent-text, var\(--orange\)\)/.test(field));
  ok('filled buttons keep the brand orange (kit primary action, Record visit)', /\.lk-act-primary \{ background: var\(--orange\)/.test(KIT_CSS) && /background: var\(--orange\); color: var\(--accent-fg, #fff\);/.test(KIT_CSS));
  ok('DESIGN.md names the token', /`--ui-accent-text`/.test(read('DESIGN.md')));
}

console.log('\nD6/D8. 44 px targets');
{
  const px = (v) => { const m = String(v || '').match(/(\d+)px/); return m ? Number(m[1]) : 0; };
  ok('the closes-week action buttons are 44 px tall', px(decl(rule(CWK_CSS, '.cwk-act'), 'min-height')) >= 44);
  ok('"Show all N" / Hide is a 44 px button', px(decl(rule(CWK_CSS, '.cwk-more'), 'min-height')) >= 44);
  ok('the compact line is a 44 px button', px(decl(rule(CWK_CSS, '.cwk-sum'), 'min-height')) >= 44);
  const sc = rule(MISSION_CSS, '.mc-scrub');
  ok('the Mission storm scrubber is a 44 px-tall input', px(decl(sc, 'height')) >= 44 && px(decl(sc, 'min-height')) >= 44, sc);
}

let d16 = null;   // its async half runs at the end
console.log('\nD16. text drafts ask "ok to text?" first');
{
  // the card's drafts carry the marker; calls and links don't need it
  const K = loadCard(ROWS);
  const A = K.win.NBDClosesWeek._actionHtml;
  const L1 = { phone: '(859) 555-0142', firstName: 'Pat' };
  const t = A({ leadId: 'L1', nextAction: { kind: 'text', label: 'Text' } }, L1, {});
  ok('closes-week text draft: data-ps-check + the customer id', /href="sms:\+18595550142\?[^"]*" data-ps-check="1" data-ps-lead="L1"/.test(t), t);
  ok('closes-week check-rate draft: marked', /data-ps-check="1" data-ps-lead="L1"/.test(A({ leadId: 'L1', nextAction: { kind: 'check_rate', label: 'Check rate' } }, L1, {})));
  ok('a call is a plain tel: link (no text check)', !/data-ps-check/.test(A({ leadId: 'L1', nextAction: { kind: 'call', label: 'Call' } }, L1, {})));
  const Kit = require(path.join(ROOT, 'docs/pro/js/layouts/kit.js'));
  const bar = Kit.actionBar(Kit.fromLead({ id: 'L9', firstName: 'Al', phone: '5135550101' }), ['call', 'text']);
  ok('kit ActionBar Text (Mission, every layout): data-ps-check + the lead id', /href="sms:\+15135550101" data-lk-link="text" data-ps-check="1" data-ps-lead="L9"/.test(bar) && !/tel:[^>]*data-ps-check/.test(bar), bar);
  ok('Focus\'s drafted Text button is marked', /class="fo-act" data-fo-text data-ps-check="1" data-ps-lead="' \+ esc\(it\.id\) \+ '"/.test(read('docs/pro/js/layouts/focus.js')));

  // phone-share.js: the one delegate, in a vm with a fake callable
  async function tap(answer, lead) {
    const listeners = {};
    const opened = [], toasts = [];
    const win = { location: { assign: (h) => opened.push(h) }, showToast: (m, k) => toasts.push([m, k]), navigator: {},
      _functions: {}, _httpsCallable: () => (payload) => { win.asked = payload; return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ data: answer }); } };
    win.document = { addEventListener: (t, f, cap) => { listeners[t] = { f, cap }; } };
    win.window = win;
    const ctx = vm.createContext({ window: win, Promise, Object, String, Date, console });
    vm.runInContext(read('docs/pro/js/phone-share.js'), ctx);
    const a = { getAttribute: (k) => ({ href: 'sms:+18595550142?&body=Hi%20Pat', 'data-ps-lead': lead }[k] || null) };
    let prevented = false;
    const ev = { target: { closest: (s) => (s === 'a[data-ps-check]' ? a : null) }, preventDefault() { prevented = true; } };
    const p = listeners.click && listeners.click.f(ev);
    await p;
    return { prevented, opened, toasts, asked: win.asked, capture: listeners.click && listeners.click.cap === true, down: !!listeners.pointerdown };
  }
  d16 = async () => {
    const no = await tap({ ok: false, code: 'stopped', reason: 'This customer replied STOP.' }, 'L1');
    ok('one capture-phase click listener (and an early check on pointerdown)', no.capture && no.down);
    ok('a "no" (STOP / Do Not Text / hours): the tap is held, Messages never opens, the reason shows',
      no.prevented && no.opened.length === 0 && no.toasts.length === 1 && /STOP/.test(no.toasts[0][0]));
    ok('the server is asked with the number from the link and the customer id', no.asked && no.asked.action === 'check' && no.asked.leadId === 'L1' && no.asked.phone === '8595550142', JSON.stringify(no.asked));
    const err = await tap(new Error('offline'), 'L1');
    ok('a check that cannot run blocks too (fails closed)', err.prevented && err.opened.length === 0 && /Couldn't check/.test((err.toasts[0] || [])[0] || ''));
    const nolead = await tap({ ok: true }, '');
    ok('no customer id: blocked without asking (a homeowner text needs one)', nolead.opened.length === 0 && !nolead.asked);
    const yes = await tap({ ok: true }, 'L1');
    ok('a "yes": Messages opens with the drafted text', yes.prevented && yes.opened.length === 1 && yes.opened[0] === 'sms:+18595550142?&body=Hi%20Pat');
    ok('phone-share.js is a boot tag on the dashboard (so the delegate is always there) and re-versioned', /<script defer src="js\/phone-share\.js\?v=3"><\/script>/.test(read('docs/pro/dashboard.html')));
  };
}

console.log('\nD13. Mission: a failed storm poll is never an all-clear');
{
  const chip = MISSION_JS.slice(MISSION_JS.indexOf('function statusChip()'), MISSION_JS.indexOf('function topBar()'));
  const load = MISSION_JS.slice(MISSION_JS.indexOf('function loadWarnings()'), MISSION_JS.indexOf('function loadReports()'));
  ok('a failed poll after a good one is "stale" (it used to stay "ok")', /function warnFailed\(\) \{ S\.warnState = \(S\.warnState === 'ok' \|\| S\.warnState === 'stale'\) \? 'stale' : 'fail'; \}/.test(load)
    && (load.match(/warnFailed\(\)/g) || []).length >= 3 && !/if \(S\.warnState !== 'ok'\) S\.warnState = 'fail'/.test(load));
  ok('a good poll records when it was checked', /S\.warnings = w; S\.warnState = 'ok'; S\.warnAt = Date\.now\(\);/.test(load));
  ok('the stale chip says the feed is unavailable, when it last checked, and that it is not an all-clear',
    /S\.warnState === 'stale'\) return '<span class="mc-chip mc-chip-warn">Storm feed unavailable\. Last checked ' \+ esc\(timeOnly\(S\.warnAt\)\) \+ '; not an all-clear\./.test(chip));
  ok('the stale branch is decided BEFORE the "N active warnings" / "No active warning" lines', chip.indexOf("'stale'") < chip.indexOf('S.warnings.length') && chip.indexOf("'stale'") < chip.indexOf('No active warning'));
  ok('"No active warning" carries its checked time', /No active warning over your customers · checked ' \+ esc\(timeOnly\(S\.warnAt\)\)/.test(chip));
  const path_ = MISSION_JS.slice(MISSION_JS.indexOf('function pathList()'), MISSION_JS.indexOf('function customerPanel()'));
  ok('"In the path" never says "nobody" when the feed failed or is still loading', /S\.warnState === 'fail'\) return h \+ '<p class="mc-note">Unknown:/.test(path_) && /S\.warnState === 'loading'/.test(path_) && /S\.warnState === 'stale'/.test(path_)
    && path_.indexOf("'fail'") < path_.indexOf('No customer address sits inside an active warning'));
}

console.log('\nD12. Bento: "could not be saved" means it was not saved');
{
  const B = read('docs/pro/js/layouts/bento.js');
  const fs_ = B.slice(B.indexOf('function flushSave()'), B.indexOf('function scheduleSave()'));
  ok('nothing pending resolves "none" (an unchanged Done is not a failure)', /if \(!S\.local\) return Promise\.resolve\('none'\);/.test(fs_));
  ok('only a real save marks the board as the user\'s; a failed one stays dirty for a retry',
    /if \(r && r\.saved\) \{ S\.source = 'user'; return true; \}\s*S\.local = true;\s*return false;/.test(fs_) && /function \(\) \{ S\.local = true; return false; \}/.test(fs_) && (fs_.match(/S\.source = 'user'/g) || []).length === 1);
  ok('Done retries and says so only on a failed save', /flushSave\(\)\.then\(function \(ok\) \{ if \(ok === false\) toast\('Board kept on this screen; it could not be saved yet\.', 'error'\); \}\)/.test(B) && !/S\.source !== 'user'\) toast/.test(B));
}

console.log('\nD15. Crew: loading is not empty');
{
  ok('the roster has a read state; "No crews on the roster yet" only after the read came back',
    /var subsState = 'loading';/.test(CREW_JS) && /subsState === 'loading' \? '<p class="cw-hint" role="status">Loading your crews\.\.\.<\/p>'/.test(CREW_JS)
      && /subsState === 'fail' \? '<p class="cw-hint" role="alert">Couldn\\'t load your crew roster/.test(CREW_JS));
  ok('a failed roster read is not swallowed and offers Try again', !/loadSubs\(\)\.then\([^)]*\)\.catch\(function \(\) \{\}\)/.test(CREW_JS) && /function \(\) \{ if \(subsState !== 'ok'\) subsState = 'fail'; render\(\); \}/.test(CREW_JS)
    && /if \(a === 'reload'\) \{ load\(\); render\(\); return; \}/.test(CREW_JS));
  ok('the tray and the Day view say "Loading your jobs" until the leads are in', /W\._leadsLoaded === true \? '>Every signed job has a day\.' : ' role="status">Loading your jobs\.\.\.'/.test(CREW_JS)
    && /W\._leadsLoaded === true \? '<p class="cw-empty">No jobs on '/.test(CREW_JS));
}

console.log('\nD21. light mode at boot');
{
  const DS = read('docs/pro/js/dashboard-state.js');
  const blk = DS.slice(DS.indexOf("const autoOn = localStorage.getItem('nbd_auto_theme')"), DS.indexOf('// Boot the theme immediately'));
  ok('a page the preboot stamped data-mode="light" loads the theme engine at boot', /const light = document\.documentElement\.getAttribute\('data-mode'\) === 'light';/.test(blk) && /\|\| light\) kick\(\);/.test(blk));
  ok('"auto" also loads it when the phone switches to light later', /matchMedia\('\(prefers-color-scheme: light\)'\)/.test(blk) && /if \(ev\.matches\) kick\(\);/.test(blk));
  ok('the preboot is still the one that decides the mode (head, blocking)', /<script src="js\/theme-mode-preboot\.js\?v=1"><\/script>/.test(read('docs/pro/dashboard.html')) && /js\/dashboard-state\.js\?v=12/.test(read('docs/pro/dashboard.html')));
}

console.log('\nD30. Field: "All uploaded" only after a real 0');
{
  const F = read('docs/pro/js/layouts/field.js');
  const q = F.slice(F.indexOf('function queueLine()'), F.indexOf('function renderCapture()'));
  const rq = F.slice(F.indexOf('function refreshQueue()'), F.indexOf('function setCount('));
  ok('an unreadable queue is null (unknown), never 0', /P\.queuedPhotoCountDurable\(\)\.then\(done, function \(\) \{ done\(null\); \}\)/.test(rq) && !/done\(0\); \}\)/.test(rq)
    && /S\.queued = typeof n === 'number' && n >= 0 \? n : null;/.test(rq));
  ok('unknown reads as "Checking uploads", decided before "All uploaded"', /if \(S\.queued == null\) return S\.shots > 0 \? 'Checking uploads\.\.\. photos are saved on this phone' : '';/.test(q) && q.indexOf('S.queued == null') < q.indexOf('All uploaded'));
  ok('while photos wait it looks again (so the line moves when the drain empties it), and unmount stops that',
    /if \(mountedOn && S\.shots > 0 && S\.queued !== 0\) qTimer = setTimeout\(refreshQueue, 4000\);/.test(rq) && /mountedOn = false;\s*if \(qTimer\) \{ clearTimeout\(qTimer\); qTimer = null; \}/.test(F));
}

(async () => {
  console.log('\nD16 (async). phone-share.js holds a marked sms: link until checkText says yes');
  try { await d16(); } catch (e) { ok('the phone-share delegate ran', false, e && e.stack); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})();
