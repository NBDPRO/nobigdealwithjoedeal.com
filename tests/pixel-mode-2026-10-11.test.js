/**
 * tests/pixel-mode-2026-10-11.test.js — Pixel Mode skin + dialog-box
 * notifications (CRM style integration roadmap, slice E1).
 *
 *   1. pixel-logic.js: settings normalisation, HP (days before cold), the
 *      overdue follow-up rule, open-lead filtering, party ordering, trainer
 *      card + badges, box-shadow sprite, typewriter
 *   2. pixel-mode-core.js: its inline normalize agrees with the logic module;
 *      settings live on userSettings (not localStorage); no innerHTML; the
 *      lead name is only ever set through textContent
 *   3. pixel-mode.css: only theme tokens (no colour literals except black
 *      shading), skin rules gated on body.skin-pixel, motion gated on both
 *      Reduce Motion switches, scanlines never intercept the pointer
 *   4. dashboard.html: the settings panel, the Home host and a deferred
 *      script tag exist; nothing inline
 *
 * Run: node tests/pixel-mode-2026-10-11.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const L = require(path.join(ROOT, 'docs/pro/js/pixel-logic.js'));
const M = require(path.join(ROOT, 'docs/pro/js/pixel-mode-core.js'));
const LOADER = require(path.join(ROOT, 'docs/pro/js/pixel-mode.js'));

const DAY = 86400000;
const NOW = new Date(2026, 9, 11, 12, 0, 0).getTime();   // Oct 11 2026, local noon
const ago = (d) => NOW - d * DAY;

console.log('\n1. pixel-logic');
{
  ok('mode: missing → everything off', JSON.stringify(L.normalizeMode(undefined)) === JSON.stringify({ skin: false, scanlines: false, dialog: false }));
  ok('mode: only literal true switches a flag on', (() => {
    const m = L.normalizeMode({ skin: 'yes', scanlines: 1, dialog: true });
    return m.skin === false && m.scanlines === false && m.dialog === true;
  })());
  ok('anyOn: dialog alone counts (it works without the skin)', L.anyOn({ skin: false, dialog: true }) && !L.anyOn({ skin: false, dialog: false, scanlines: true }));

  ok('HP: touched now = 100', L.hpFor({ updatedAt: NOW }, NOW).pct === 100);
  ok('HP: half way to cold = 50, warn tier', (() => { const h = L.hpFor({ updatedAt: ago(7) }, NOW); return h.pct === 50 && h.tier === 'warn' && h.days === 7; })());
  ok('HP: at COLD_DAYS = 0, cold tier', (() => { const h = L.hpFor({ updatedAt: ago(L.COLD_DAYS) }, NOW); return h.pct === 0 && h.tier === 'cold'; })());
  ok('HP: past COLD_DAYS never goes negative', L.hpFor({ updatedAt: ago(90) }, NOW).pct === 0);
  ok('HP: no timestamp → unknown, never a made-up number', (() => { const h = L.hpFor({}, NOW); return h.pct === null && h.tier === 'unknown' && h.days === null; })());
  ok('HP: freshest of updatedAt / stageStartedAt / lastContactedAt / createdAt wins',
    L.hpFor({ createdAt: ago(40), lastContactedAt: ago(2), updatedAt: ago(30) }, NOW).days === 2);
  ok('HP: reads Firestore Timestamp-shaped values', L.hpFor({ updatedAt: { seconds: Math.floor(ago(1) / 1000) } }, NOW).days === 1);

  ok('overdue: yesterday = 1', L.overdueDays({ followUp: '2026-10-10' }, NOW) === 1);
  ok('overdue: today is NOT overdue', L.overdueDays({ followUp: '2026-10-11' }, NOW) === 0);
  ok('overdue: future / blank / junk = 0', L.overdueDays({ followUp: '2026-10-20' }, NOW) === 0 && L.overdueDays({ followUp: '' }, NOW) === 0 && L.overdueDays({ followUp: 'soon' }, NOW) === 0 && L.overdueDays({}, NOW) === 0);
  ok('overdue: ten days late = 10', L.overdueDays({ followUp: '2026-10-01' }, NOW) === 10);

  const stageRole = (k) => ({ signed: 'won', lost: 'lost', install: 'job' }[k] || 'active');
  const env = { stageRole };
  ok('open: deleted / lost / won / job are not in the party',
    !L.isOpenLead({ id: 'a', stage: 'new', deleted: true }, env) && !L.isOpenLead({ id: 'b', stage: 'lost' }, env)
    && !L.isOpenLead({ id: 'c', stage: 'signed' }, env) && !L.isOpenLead({ id: 'd', stage: 'install' }, env)
    && L.isOpenLead({ id: 'e', stage: 'new' }, env));
  ok('open: a lead with no id is never open', !L.isOpenLead({ stage: 'new' }, env));

  const leads = [
    { id: 'fresh', firstName: 'Fay', lastName: 'Fresh', stage: 'new', updatedAt: ago(0), jobValue: 9000 },
    { id: 'cold', firstName: 'Cal', lastName: 'Cold', stage: 'new', updatedAt: ago(13), jobValue: 4000, followUp: '2026-10-01' },
    { id: 'mid', name: 'Mid Lead', stage: 'contacted', updatedAt: ago(7), jobValue: 20000 },
    { id: 'mid2', name: 'Mid Two', stage: 'contacted', updatedAt: ago(7), jobValue: 30000 },
    { id: 'lost', name: 'Gone', stage: 'lost', updatedAt: ago(20) },
    { id: 'blank', name: 'No Dates', stage: 'new' },
  ];
  const party = L.partyOf(leads, env, NOW);
  ok('party: closest to cold first, lost excluded, unknown HP last',
    party.map((p) => p.id).join(',') === 'cold,mid2,mid,fresh,blank', party.map((p) => p.id).join(','));
  ok('party: ties break by pipeline value (bigger first)', party[1].id === 'mid2');
  ok('party: limit honoured', L.partyOf(leads, env, NOW, 2).length === 2);
  ok('party: names come from first+last, then name', party[0].name === 'Cal Cold' && party[2].name === 'Mid Lead');
  ok('party: overdue carried onto the member', party[0].overdue === 10 && party[3].overdue === 0);
  ok('party: env.visible filters', L.partyOf(leads, Object.assign({}, env, { visible: (l) => l.id === 'fresh' }), NOW).length === 1);

  const card = L.trainerCard(leads.concat([
    { id: 'won1', name: 'W1', stage: 'signed', stageStartedAt: ago(3) },
    { id: 'won2', name: 'W2', stage: 'signed', stageStartedAt: ago(200) },
  ]), Object.assign({}, env, { isUnlocked: (k) => k === 'gold-rush' }), NOW);
  ok('card: open = 5, overdue = 1, signed this month = 1 (old win excluded)', card.open === 5 && card.overdue === 1 && card.signed === 1, JSON.stringify(card));
  ok('card: level = 1 + floor(sqrt(signed))', card.level === 2 && L.trainerCard([], env, NOW).level === 1);
  ok('card: pipeline sums jobValue of OPEN leads only', card.pipeline === 63000, String(card.pipeline));
  ok('card: avg HP over leads that have a timestamp', card.avgHp === Math.round((100 + 7 + 50 + 50) / 4), String(card.avgHp));
  ok('card: badges - Closer from a signed deal, Gold Rush from the unlock, no Clean Slate while overdue',
    card.badges.some((b) => b.id === 'closer') && card.badges.some((b) => b.id === 'theme-gold-rush') && !card.badges.some((b) => b.id === 'clean-slate'));
  const clean = L.trainerCard([{ id: 'x', name: 'X', stage: 'new', updatedAt: ago(1) }], env, NOW);
  ok('card: Clean Slate when open leads and nothing overdue', clean.badges.some((b) => b.id === 'clean-slate'));
  ok('card: a locked theme the user never earned is NOT a badge', !L.trainerCard(leads, Object.assign({}, env, { isUnlocked: () => false }), NOW).badges.some((b) => /^theme-/.test(b.id)));

  const rows = ['ab', 'b.'];
  const sh = L.spriteBoxShadow(rows, { a: 'red', b: 'blue' }, 4);
  ok('sprite: one shadow per painted cell, at cell*px offsets, "." transparent',
    sh === '0px 0px 0 0 red,4px 0px 0 0 blue,0px 4px 0 0 blue', sh);
  ok('house sprite is a rectangle and paints something', L.HOUSE_ROWS.every((r) => r.length === L.HOUSE_ROWS[0].length) && L.spriteBoxShadow(L.HOUSE_ROWS, { r: '#1', R: '#2', w: '#3', g: '#4', d: '#5' }, 1).split(',').length > 40);

  ok('typewriter: reveals by elapsed time and caps at the full text',
    L.typewriterSlice('hello', 0, 10) === '' && L.typewriterSlice('hello', 200, 10) === 'he' && L.typewriterSlice('hello', 10000, 10) === 'hello');
}

console.log('\n2. pixel-mode-core.js');
{
  const raws = [undefined, null, {}, { skin: true }, { skin: 'true', dialog: true }, { scanlines: true, dialog: 1 }];
  ok('inline normalize agrees with NBDPixelLogic.normalizeMode for every shape',
    raws.every((r) => JSON.stringify(M.normalize(r)) === JSON.stringify(L.normalizeMode(r))));
  const src = read('docs/pro/js/pixel-mode-core.js');
  const code = stripJs(src);
  ok('settings persist on userSettings/{uid}.pixelMode', /'userSettings'/.test(code) && /pixelMode:\s*cfg/.test(code));
  ok('no localStorage (nbd_ keys are wiped at every sign-out)', !/localStorage|sessionStorage/.test(code));
  ok('never innerHTML / document.write / eval (lead names are public input)', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(code));
  ok('the lead name goes in via textContent', /who\.textContent\s*=\s*name/.test(code));
  ok('Reduce Motion honoured (OS + app switch) before any typewriter', /prefers-reduced-motion: reduce/.test(code) && /data-motion/.test(code) && /reducedMotion\(\)\s*\|\|/.test(code));
  ok('stylesheet and fonts only fetched once something is on', /if \(any\) ensureAssets\(\)/.test(code));
  ok('the core steps aside for the loader stub and replaces it once loaded', /NBDPixelMode\.__stub\)\) return/.test(code) && /w\.NBDPixelMode = \{/.test(code));
  ok('no network beyond the font CSS + own assets (nothing is sent anywhere)', !/\bfetch\(|XMLHttpRequest|sendBeacon/.test(code));
}

console.log('\n3. pixel-mode.css');
{
  const css = stripCss(read('docs/pro/css/pixel-mode.css'));
  const lits = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  ok('no hex colour literals (every colour is a theme token)', lits.length === 0, lits.join(' '));
  const rgb = (css.match(/rgba?\([^)]*\)/g) || []).filter((c) => !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/.test(c));
  ok('the only rgb() literals are black shading', rgb.length === 0, rgb.join(' '));
  // Every rule that restyles an EXISTING element must be under body.skin-pixel.
  const rules = css.replace(/@media[^{]*\{/g, '').split('}').map((r) => r.trim()).filter(Boolean);
  const loose = [];
  for (const r of rules) {
    const sel = r.split('{')[0].trim();
    if (!sel || /^@/.test(sel) || /^(\d+%|from|to)$/.test(sel)) continue;
    const parts = []; { let d = 0, cur = ''; for (const ch of sel) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) parts.push(cur.trim()); }
    for (const p of parts) {
      if (/^body\.skin-pixel/.test(p)) continue;
      if (/^(\.px-|\.toast\.px-dialog|html\[data-motion)/.test(p)) continue;
      loose.push(p);
    }
  }
  ok('every selector is body.skin-pixel…, .px-…, or .toast.px-dialog (nothing leaks onto the normal UI)', loose.length === 0, loose.join(' | '));
  ok('scanlines never intercept the pointer', /px-scanlines::after\s*\{[^}]*pointer-events:\s*none/.test(css));
  ok('the ▼ blink and the HP fill transition each have both reduce-motion switches',
    /html\[data-motion="reduce"\][^{]*px-dialog::after\s*\{\s*animation:\s*none/.test(css)
    && /prefers-reduced-motion: reduce\)\s*\{\s*\.toast\.px-dialog::after\s*\{\s*animation:\s*none/.test(css)
    && /html\[data-motion="reduce"\] \.px-hp > i\s*\{\s*transition:\s*none/.test(css));
  ok('Press Start 2P + VT323 named', /Press Start 2P/.test(css) && /VT323/.test(css));
  ok('focus stays visible on the skinned controls', /body\.skin-pixel \.btn:focus-visible/.test(css));
}

console.log('\n   boot loader (pixel-mode.js) — the only tag on the dashboard');
{
  const raw = read('docs/pro/js/pixel-mode.js');
  const code = stripJs(raw);
  const shapes = [undefined, null, {}, { skin: true }, { dialog: true }, { scanlines: true }, { skin: 'true' }, { dialog: 1 }, { skin: false, dialog: false }];
  ok('loader wakes the core exactly when the logic module says skin or dialog is on',
    shapes.every((r) => LOADER.wantsCore(r) === L.anyOn(L.normalizeMode(r)) || (r && r.scanlines === true && LOADER.wantsCore(r) === false)));
  ok('scanlines alone never wake the core (they need the skin)', LOADER.wantsCore({ scanlines: true }) === false);
  ok('loader stays tiny so it cannot eat the boot budget (< 5 KB)', Buffer.byteLength(raw) < 5 * 1024, String(Buffer.byteLength(raw)));
  ok('loader reads, never writes', !/setDoc|updateDoc|addDoc|localStorage/.test(code));
  ok('loader fetches only its own core, on demand', /pixel-mode-core\.js/.test(code) && !/fonts\.googleapis|pixel-mode\.css|pixel-logic/.test(code));
  ok('loader wakes on settings or the card scrolling into view', /wantsCore\(data\.pixelMode\)/.test(code) && /IntersectionObserver/.test(code));
  ok('loader leaves a __stub the core can replace', /__stub: true/.test(code));
}

console.log('\n4. dashboard.html');
{
  const html = read('docs/pro/dashboard.html');
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  ok('settings panel with the three switches', /id="pixelModePanel"/.test(noComments) && ['pxSkin', 'pxScanlines', 'pxDialog'].every((id) => new RegExp('id="' + id + '"').test(noComments)));
  ok('Home host is hidden by default', /<section id="homePixelParty"[^>]*\bhidden\b/.test(noComments));
  ok('script tag is deferred and versioned', /<script defer src="js\/pixel-mode\.js\?v=\d+"><\/script>/.test(noComments));
  const panel = (noComments.match(/<div class="panel mb-md" id="pixelModePanel">[\s\S]*?<!-- SIDEBAR CUSTOMIZER|<div class="panel mb-md" id="pixelModePanel">[\s\S]{0,2500}/) || [''])[0];
  ok('panel has no inline handlers', !/\son[a-z]+\s*=/.test(panel));
  ok('the CSS is NOT linked from the page (lazy)', !/pixel-mode\.css/.test(noComments));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join('; ')); process.exit(1); }
