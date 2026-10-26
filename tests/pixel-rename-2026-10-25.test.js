/**
 * tests/pixel-rename-2026-10-25.test.js — Pixel Mode / Pixel World game words
 * (Jo, 2026-10-25): "Lead Dex" -> "Lead Book", "Party" -> "Crew",
 * "Trainer Card" -> "Rep Card". User-facing words only: identifiers, CSS
 * classes, element ids and everything stored stay as they were.
 *
 *   1. the old words are gone from every string literal and comment in the
 *      Pixel JS and CSS (and from the Pixel pieces of dashboard.html), except
 *      an exact allowlist of the identifier forms that were kept on purpose;
 *      the scanner is proved on planted samples first, and every allowlist
 *      entry must still occur (a stale entry fails)
 *   2. the new labels exist: LEAD BOOK, CREW, REP CARD and their aria-labels,
 *      the empty state, the help line, the Settings blurb; and the Home card is
 *      RENDERED through pixel-mode-core.js with a stub DOM, so the words a
 *      person sees (headings, aria-labels, empty state) are read off the DOM
 *   3. what was kept: the identifier and CSS-class forms, the element ids, the
 *      stored keys (userSettings.pixelMode, userSettings.pixelWorld.seen,
 *      companyProfile.pixelWorld.enabled) pinned as exact strings, the
 *      exported API names the other suites call
 *   4. the Decision Engine's .dex- prefix is an unrelated feature and is
 *      untouched (its files are read and still carry the prefix)
 *   5. the originality rule still holds (no other game's names), and the
 *      loader ?v= numbers were bumped for the files this rename changed
 *
 * Run: node tests/pixel-rename-2026-10-25.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const PL = require(path.join(ROOT, 'docs/pro/js/pixel-logic.js'));
const WL = require(path.join(ROOT, 'docs/pro/js/pixel-world-logic.js'));
const MODE = require(path.join(ROOT, 'docs/pro/js/pixel-mode-core.js'));

const JS_FILES = [
  'docs/pro/js/pixel-mode-core.js',
  'docs/pro/js/pixel-mode.js',
  'docs/pro/js/pixel-world.js',
  'docs/pro/js/pixel-world-logic.js',
  'docs/pro/js/pixel-logic.js',
];
const CSS_FILES = ['docs/pro/css/pixel-mode.css', 'docs/pro/css/pixel-world.css'];

// ── a small scanner: the string literals and comments of a JS file ──────────
// Returns { strings, comments, code } where `code` is the source with every
// comment and string body blanked (same length), so identifier checks cannot be
// satisfied by a comment or a label.
function scanJs(src) {
  const strings = [], comments = [];
  const code = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (code[k] !== '\n') code[k] = ' '; };
  const n = src.length;
  const regexAfter = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'instanceof', 'else', 'do']);
  let i = 0, prev = '', word = '';
  function template(from) {              // returns the index after the closing backtick
    let j = from + 1;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '`') return j + 1;
      if (ch === '$' && src[j + 1] === '{') {      // a ${ } expression: skip to its matching }
        let depth = 1; j += 2;
        while (j < n && depth) {
          if (src[j] === '`') { j = template(j); continue; }
          if (src[j] === '{') depth++;
          else if (src[j] === '}') depth--;
          j++;
        }
        continue;
      }
      j++;
    }
    throw new Error('unterminated template literal');
  }
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i); if (j < 0) j = n;
      comments.push(src.slice(i + 2, j)); blank(i, j); i = j; continue;
    }
    if (c === '/' && d === '*') {
      const j = src.indexOf('*/', i + 2);
      if (j < 0) throw new Error('unterminated block comment');
      comments.push(src.slice(i + 2, j)); blank(i, j + 2); i = j + 2; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n') throw new Error('newline inside a string at ' + i);
        j++;
      }
      if (j >= n) throw new Error('unterminated string at ' + i);
      strings.push(src.slice(i + 1, j)); blank(i + 1, j); prev = c; word = ''; i = j + 1; continue;
    }
    if (c === '`') {
      const j = template(i);
      strings.push(src.slice(i + 1, j - 1)); blank(i + 1, j - 1); prev = c; word = ''; i = j; continue;
    }
    if (c === '/') {
      const isRegex = prev === '' || '(,=:[!&|?{};+-*%<>~^'.indexOf(prev) >= 0 || regexAfter.has(word);
      if (isRegex) {
        let j = i + 1, inClass = false;
        while (j < n) {
          const ch = src[j];
          if (ch === '\\') { j += 2; continue; }
          if (ch === '\n') throw new Error('newline inside a regex at ' + i);
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        blank(i, j); prev = ')'; word = ''; i = j; continue;
      }
      prev = '/'; word = ''; i++; continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      word = src.slice(i, j); prev = src[j - 1]; i = j; continue;
    }
    prev = c; word = ''; i++;
  }
  return { strings, comments, code: code.join('') };
}

// ── what counts as an old word ──────────────────────────────────────────────
// A: dex / party / parties / trainer as a word (letters on either side make it
//    part of a longer word, so index, partyOf, dexEntries, trainerCard do not
//    match here). B: the compound forms, which also catch trainerCard and
//    lead-dex written as one token.
const A = /(^|[^a-z])(dex|party|parties|trainer)([^a-z]|$)/i;
const B = /trainer[ _-]?card|lead[ _-]?dex|pok[eé]dex/i;
// The exact identifier forms kept on purpose that legitimately show up INSIDE a
// string or a comment (class names, an element id, the exported function name in
// a doc comment, and ordinary "third-party"). Longest first. Each one must still
// occur somewhere, or the test fails and the entry has to go.
const ALLOW = [
  'px-trainer-name', 'px-trainer-top', 'px-trainer-lv', 'px-trainer',
  'px-party-list', 'px-party',
  'homePixelParty',
  'partyOf',
  'third-party',
];
function stripAllowed(text) {
  let t = text;
  ALLOW.forEach((a) => { t = t.split(a).join(' '.repeat(a.length)); });
  return t;
}
function leaks(text) {
  const t = stripAllowed(text);
  return t.split('\n').map((line) => line.trim()).filter((line) => A.test(line) || B.test(line));
}

console.log('\n1. the old words are gone from strings and comments');
{
  // The scanner first: planted samples must be caught or passed as intended.
  const planted = scanJs([
    "var a = 'PARTY';",
    "// Trainer Card",
    "/* the Lead Dex */",
    "var b = 'Talk to townspeople to fill the Dex.';",
    "var c = /'party/.test(x) ? 1 : 4 / 2;",
    "var d = 'it\\'s the Lead Dex';",
    "var e = `tpl ${ 'inner' } Party`;",
    "var f = L.partyOf(1); function dexPanel() {} var g = 'px-party-list';",
  ].join('\n'));
  ok('scanner: string literals found, escapes and a regex with a quote handled',
    planted.strings.indexOf('PARTY') >= 0 && planted.strings.indexOf("it\\'s the Lead Dex") >= 0
    && planted.strings.every((s) => s !== "party") && planted.strings.indexOf('px-party-list') >= 0, JSON.stringify(planted.strings));
  ok('scanner: line and block comments found', planted.comments.some((c) => /Trainer Card/.test(c)) && planted.comments.some((c) => /Lead Dex/.test(c)));
  ok('scanner: code view blanks strings and comments, keeps identifiers',
    /partyOf/.test(planted.code) && /dexPanel/.test(planted.code) && !/PARTY|Trainer|Lead Dex|Dex\./.test(planted.code));
  ok('positive control: a planted PARTY label, Trainer Card comment, Lead Dex comment and "the Dex" note are all flagged',
    leaks(planted.strings.join('\n') + '\n' + planted.comments.join('\n')).length >= 4);
  ok('positive control: planted trainerCard and lead-dex tokens (compound forms) are flagged', leaks("'trainerCard' 'lead-dex'").length === 1 && leaks("'trainerCard'").length === 1);
  ok('negative control: kept identifier forms and third-party are not flagged',
    leaks("px-party-list px-party px-trainer px-trainer-top homePixelParty NBDPixelLogic.partyOf third-party sprites, index.html, z-index").length === 0);

  const seenAllow = new Set();
  const texts = [];
  JS_FILES.forEach((f) => {
    const raw = read(f);
    let sc;
    try { sc = scanJs(raw); } catch (e) { sc = null; ok(f + ': scanned without error', false, e.message); }
    if (!sc) return;
    const text = sc.strings.join('\n') + '\n' + sc.comments.join('\n');
    texts.push([f, text]);
    const found = leaks(text);
    ok(f.replace('docs/pro/', '') + ': no old word in any string literal or comment (' + sc.strings.length + ' strings, ' + sc.comments.length + ' comments scanned)',
      found.length === 0, found.slice(0, 5).join(' | '));
  });
  CSS_FILES.forEach((f) => {
    const raw = read(f);
    texts.push([f, raw]);
    const found = leaks(raw);
    ok(f.replace('docs/pro/', '') + ': no old word in any selector, value or comment', found.length === 0, found.slice(0, 5).join(' | '));
  });
  // dashboard.html: only the Pixel pieces are ours (the file also says "Third-Party Lender" elsewhere).
  const html = read('docs/pro/dashboard.html');
  const homeBlock = (html.match(/<!--\s*Pixel Mode[^]*?-->\s*<section id="homePixelParty"[^>]*>/) || [''])[0];
  const panelBlock = (html.match(/<!-- Pixel Mode \(2026-10-11\)[^]*?<!-- SIDEBAR CUSTOMIZER/) || [''])[0];
  ok('dashboard.html: both Pixel pieces located (the Home host and the Settings card)', homeBlock.length > 80 && panelBlock.length > 800, homeBlock.length + ' / ' + panelBlock.length);
  texts.push(['docs/pro/dashboard.html (Home host)', homeBlock], ['docs/pro/dashboard.html (Settings card)', panelBlock]);
  ok('dashboard.html Home host and Settings card: no old word', leaks(homeBlock).length === 0 && leaks(panelBlock).length === 0, leaks(homeBlock + '\n' + panelBlock).join(' | '));
  texts.forEach(([, t]) => ALLOW.forEach((a) => { if (t.indexOf(a) >= 0) seenAllow.add(a); }));
  const stale = ALLOW.filter((a) => !seenAllow.has(a));
  ok('every allowlist entry still occurs in a string or comment (no stale entry)', stale.length === 0, stale.join(', '));
}

console.log('\n2. the new words exist, and the Home card renders them');
{
  const core = scanJs(read('docs/pro/js/pixel-mode-core.js'));
  const world = scanJs(read('docs/pro/js/pixel-world.js'));
  const has = (sc, s) => sc.strings.indexOf(s) >= 0;
  ok('Home: REP CARD heading and its aria-label', has(core, 'REP CARD') && has(core, 'Rep card'));
  ok('Home: CREW heading, aria-label and empty state (reads right: "on your crew")',
    has(core, 'CREW') && has(core, 'Crew: leads closest to going cold') && has(core, 'No open leads on your crew.'));
  ok('Pixel World: LEAD BOOK panel title and the "fill the Lead Book" note',
    has(world, 'LEAD BOOK') && world.strings.some((s) => /Talk to townspeople to fill the Lead Book\.$/.test(s)));
  ok('Pixel World: CREW menu entry', has(world, 'CREW'));
  ok('Pixel World: the menu pairs the new labels with the unchanged handlers',
    /\[\['CREW', partyPanel\], \['LEAD BOOK', dexPanel\], \['TROPHIES',/.test(read('docs/pro/js/pixel-world.js')));
  ok('Pixel World: the help line names the new menu entries', has(world, 'Esc / B: back. MENU: Crew, Lead Book, Trophies.'));
  const html = read('docs/pro/dashboard.html');
  ok('dashboard.html: the Home host is named for the crew', /<section id="homePixelParty"[^>]*aria-label="Pixel Mode crew"[^>]*hidden/.test(html));
  ok('dashboard.html: the Settings blurb says "as a Crew with an HP bar"', /your leads as a Crew with an HP bar/.test(html));

  // Render the Home card through the real core with a stub DOM.
  class Node {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.className = ''; this.style = {}; this.hidden = false; this._text = ''; this.tabIndex = -1; this.title = ''; }
    appendChild(c) { if (c && c.isFrag) { c.children.forEach((k) => this.children.push(k)); c.children = []; } else this.children.push(c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this.children = []; this._text = v == null ? '' : String(v); }
  }
  const walk = (node, fn) => { fn(node); node.children.forEach((k) => walk(k, fn)); };
  async function renderHome(leads) {
    const host = new Node('section');
    const byId = { homePixelParty: host };
    const doc = {
      readyState: 'complete', hidden: false,
      body: { classList: { toggle() {}, add() {}, remove() {} } },
      head: new Node('head'), documentElement: new Node('html'),
      createElement: (t) => new Node(t),
      createDocumentFragment: () => { const f = new Node('#frag'); f.isFrag = true; return f; },
      getElementById: (id) => byId[id] || null,
      addEventListener() {},
    };
    const sandbox = { document: doc, setTimeout() { return 0; }, setInterval() { return 0; }, clearInterval() {}, clearTimeout() {}, console };
    sandbox.window = sandbox;
    sandbox.NBDPixelLogic = PL;
    sandbox._leads = leads;
    vm.runInNewContext(read('docs/pro/js/pixel-mode-core.js'), sandbox, { filename: 'pixel-mode-core.js' });
    await sandbox.NBDPixelMode.set({ skin: true });
    await new Promise((r) => setImmediate(r));
    return host;
  }
  const NOW = Date.now();
  const lead = (id, name, daysAgo) => ({ id, name, stage: 'new', updatedAt: NOW - daysAgo * 86400000 });
  (async () => {
    const full = await renderHome([lead('a', 'Ann Ames', 12), lead('b', 'Bo Bell', 2)]);
    const heads = []; const labels = []; const classes = [];
    walk(full, (nd) => {
      if (nd.tagName === 'H3') heads.push(nd.textContent);
      if (nd.hasAttribute('aria-label')) labels.push(nd.getAttribute('aria-label'));
      classes.push(nd.className);
    });
    ok('rendered: the two Home cards are headed REP CARD then CREW', heads.join('|') === 'REP CARD|CREW', heads.join('|'));
    ok('rendered: aria-labels are "Rep card" and "Crew: leads closest to going cold"', labels.indexOf('Rep card') >= 0 && labels.indexOf('Crew: leads closest to going cold') >= 0, labels.join(' | '));
    const tokens = [].concat(...classes.map((c) => c.split(/\s+/).filter(Boolean)));
    ok('rendered: the crew list still carries the kept hooks (px-party, px-party-list, px-trainer) and the two leads are listed',
      tokens.indexOf('px-party') >= 0 && tokens.indexOf('px-party-list') >= 0 && tokens.indexOf('px-trainer') >= 0
      && tokens.filter((t) => t === 'px-mon').length === 2, tokens.join(' '));
    const everything = [];
    walk(full, (nd) => { everything.push(nd._text); nd.hasAttribute('aria-label') && everything.push(nd.getAttribute('aria-label')); });
    ok('rendered: no old word anywhere in the text or aria-labels a person sees', leaks(everything.join('\n')).length === 0, leaks(everything.join('\n')).join(' | '));
    ok('rendered: the host is shown', full.hidden === false);

    const empty = await renderHome([]);
    const emptyText = [];
    walk(empty, (nd) => { if (/\bpx-empty\b/.test(nd.className)) emptyText.push(nd.textContent); });
    ok('rendered: with no open leads the crew card says "No open leads on your crew."', emptyText.indexOf('No open leads on your crew.') >= 0, emptyText.join(' | '));

    kept();
  })().catch((e) => { ok('the Home card rendered through pixel-mode-core.js', false, e && e.stack); finish(); });
}

function kept() {
  console.log('\n3. what was kept (identifiers, ids, stored keys)');
  const src = {};
  JS_FILES.forEach((f) => { src[f] = scanJs(read(f)); });
  const codeHas = (f, id) => new RegExp('\\b' + id + '\\b').test(src[f].code);
  const KEPT = [
    ['docs/pro/js/pixel-logic.js', 'partyOf'], ['docs/pro/js/pixel-logic.js', 'trainerCard'],
    ['docs/pro/js/pixel-mode-core.js', 'partyOf'], ['docs/pro/js/pixel-mode-core.js', 'trainerCard'],
    ['docs/pro/js/pixel-world.js', 'partyOf'], ['docs/pro/js/pixel-world.js', 'trainerCard'],
    ['docs/pro/js/pixel-world.js', 'party'], ['docs/pro/js/pixel-world.js', 'partyPanel'], ['docs/pro/js/pixel-world.js', 'dexPanel'],
    ['docs/pro/js/pixel-world-logic.js', 'dexEntries'], ['docs/pro/js/pixel-world-logic.js', 'DEX_SEEN_CAP'],
  ];
  KEPT.forEach(([f, id]) => ok('identifier kept: ' + id + ' in ' + path.basename(f), codeHas(f, id)));
  ok('exports kept: NBDPixelLogic.partyOf / trainerCard, NBDPixelWorldLogic.dexEntries / DEX_SEEN_CAP (= 400) / markSeen',
    typeof PL.partyOf === 'function' && typeof PL.trainerCard === 'function' && typeof WL.dexEntries === 'function' && WL.DEX_SEEN_CAP === 400 && typeof WL.markSeen === 'function');
  ok('the Lead Book states are unchanged (signed lead = "caught", talked-to = "seen", else "unknown")',
    (() => {
      const rows = WL.dexEntries([{ id: 'a', createdAt: 1, stage: 'won' }, { id: 'b', createdAt: 2, stage: 'new' }, { id: 'c', createdAt: 3, stage: 'new' }], ['b'], { stageRole: (s) => (s === 'won' ? 'won' : 'active'), normalizeStage: (s) => s });
      return rows.map((r) => r.state).join(',') === 'caught,seen,unknown' && rows[2].name === '???';
    })());

  const core = read('docs/pro/js/pixel-mode-core.js');
  const coreStrings = src['docs/pro/js/pixel-mode-core.js'].strings;
  ['px-card px-party', 'px-party-list', 'px-card px-trainer', 'homePixelParty', 'pixelModePanel', 'pxScanlines', 'pxWorldUser', 'pxWorldCompany', 'pxWorldCompanyRow', 'pxOpenWorld']
    .forEach((s) => ok('class / element id string kept in the core: ' + s, coreStrings.indexOf(s) >= 0));
  // pxSkin / pxDialog are object keys in the core's id -> setting map, not strings.
  ok('settings-panel ids kept in the core\'s id -> setting map (pxSkin / pxScanlines / pxDialog)',
    /var map = \{ pxSkin: 'skin', pxScanlines: 'scanlines', pxDialog: 'dialog' \};/.test(core));
  const html = read('docs/pro/dashboard.html');
  ['homePixelParty', 'pixelModePanel', 'pxSkin', 'pxScanlines', 'pxDialog', 'pxWorldUser', 'pxWorldCompany', 'pxWorldCompanyRow', 'pxOpenWorld']
    .forEach((id) => ok('dashboard.html still has id="' + id + '"', new RegExp('id="' + id + '"').test(html)));
  const css = read('docs/pro/css/pixel-mode.css');
  ['.px-party-list', '.px-trainer', '.px-trainer-top', '.px-trainer-lv', '.px-trainer-name'].forEach((sel) => ok('CSS selector kept: ' + sel, css.indexOf(sel + ' {') >= 0));

  // Stored keys, as exact strings from the code. These are the lines that read and write the saved settings.
  const pins = [
    ["w.setDoc(w.doc(w.db, 'userSettings', uid), { pixelMode: cfg }, { merge: true })", 'userSettings/{uid}.pixelMode is written as { pixelMode: cfg }'],
    ["cfg = normalize(d.pixelMode)", 'the skin settings are read from .pixelMode'],
    ["var p = data && data.pixelWorld;", 'the town settings are read from .pixelWorld'],
    ["worldSeen = p && Array.isArray(p.seen) ? p.seen.filter(function (x) { return typeof x === 'string'; }).slice(-400) : [];", 'the Lead Book list is read from pixelWorld.seen, strings only, newest 400'],
    ["return w.setDoc(w.doc(w.db, 'userSettings', uid), { pixelWorld: patch }, { merge: true })", 'userSettings/{uid}.pixelWorld is written as { pixelWorld: patch }'],
    ["saveSeen: function (arr) { worldSeen = arr.slice(-400); return saveWorld({ seen: worldSeen }); }", 'the game saves its list as { seen: [...] }'],
    ["w.setDoc(w.doc(w.db, 'companyProfile', companyId()), { pixelWorld: { enabled: on } }, { merge: true })", 'the company switch is companyProfile/{id}.pixelWorld.enabled'],
    ["worldCompany = d.pixelWorld && typeof d.pixelWorld === 'object' ? { enabled: d.pixelWorld.enabled === true } : null;", 'the company switch is read from .pixelWorld.enabled (literal true only)'],
  ];
  pins.forEach(([line, name]) => ok('stored key pinned: ' + name, core.indexOf(line) >= 0));
  ok('settings shape unchanged: normalize keeps exactly skin / scanlines / dialog, true only',
    JSON.stringify(Object.keys(MODE.normalize({ skin: true, scanlines: true, dialog: true, party: true, dex: true }))) === JSON.stringify(['skin', 'scanlines', 'dialog'])
    && JSON.stringify(Object.keys(PL.normalizeMode({}))) === JSON.stringify(['skin', 'scanlines', 'dialog'])
    && MODE.normalize({ skin: 'true' }).skin === false);
  ok('no localStorage / sessionStorage key was introduced for the rename', !/localStorage|sessionStorage/.test(src['docs/pro/js/pixel-mode-core.js'].code + src['docs/pro/js/pixel-world.js'].code));
  ok('the game still stores only the seen list (no new pixelWorld field)', !/pixelWorld/.test(src['docs/pro/js/pixel-world.js'].code));

  decisionEngine();
}

function decisionEngine() {
  console.log('\n4. Decision Engine: the .dex- prefix is a different feature and is untouched');
  const css = read('docs/pro/css/decision-engine-view.css');
  const js = read('docs/pro/js/decision-engine.js');
  ok('decision-engine-view.css still carries the .dex- class prefix', (css.match(/\.dex-/g) || []).length >= 10, String((css.match(/\.dex-/g) || []).length));
  ok('decision-engine.js still emits dex- classes', (js.match(/\bdex-/g) || []).length >= 10, String((js.match(/\bdex-/g) || []).length));
  ok('the Decision Engine files do not use the new Pixel labels (no accidental search-and-replace)',
    !/Lead Book|LEAD BOOK|Rep Card|REP CARD/.test(css + js));
  const pixelSrc = JS_FILES.concat(CSS_FILES).map(read).join('\n');
  ok('the Pixel files do not use the Decision Engine prefix', !/\bdex-/.test(pixelSrc));

  originalityAndVersions();
}

function originalityAndVersions() {
  console.log('\n5. originality still holds; loader ?v= bumped for the changed files');
  // Same expression as tests/pixel-world-2026-10-11.test.js, run over raw text (comments too) and over the core as well.
  const banned = /pok[eé]mon|pikachu|nintendo|mario|zelda|\bsonic\b|game ?boy|kirby|poké|pokeball/i;
  const all = JS_FILES.concat(CSS_FILES);
  const hit = all.filter((f) => banned.test(read(f)));
  ok('no other game\'s name in any Pixel Mode / Pixel World file, comments included', hit.length === 0, hit.join(', '));

  const ver = (text, re) => { const m = text.match(re); return m ? Number(m[1]) : null; };
  const core = read('docs/pro/js/pixel-mode-core.js');
  const loader = read('docs/pro/js/pixel-mode.js');
  const html = read('docs/pro/dashboard.html');
  const checks = [
    [ver(loader, /pixel-mode-core\.js\?v=(\d+)'/), 2, 'pixel-mode-core.js (CORE_URL in pixel-mode.js)'],
    [ver(core, /pixel-mode\.css\?v=(\d+)'/), 2, 'pixel-mode.css (CSS_URL)'],
    [ver(core, /pixel-logic\.js\?v=(\d+)'/), 2, 'pixel-logic.js (LOGIC_URL)'],
    [ver(core, /pixel-world-logic\.js\?v=(\d+)'/), 2, 'pixel-world-logic.js (WORLD_LOGIC_URL)'],
    [ver(core, /pixel-world\.js\?v=(\d+)'/), 2, 'pixel-world.js (WORLD_JS_URL)'],
    [ver(html, /<script defer src="js\/pixel-mode\.js\?v=(\d+)"><\/script>/), 3, 'pixel-mode.js (the dashboard tag)'],
  ];
  checks.forEach(([v, min, name]) => ok('cache-bust: ' + name + ' is at v=' + min + ' or later (a changed file must not be served from the old cache)', v != null && v >= min, 'found ' + v));
  ok('WORLD_JS_URL still appears exactly twice in the core (the lazy-load guard in pixel-world-2026-10-11 counts it)', (core.match(/WORLD_JS_URL/g) || []).length === 2);

  finish();
}

function finish() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join('; ')); process.exit(1); }
}
