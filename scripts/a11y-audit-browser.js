#!/usr/bin/env node
/**
 * scripts/a11y-audit-browser.js - the in-browser half of the 2026-10-23 accessibility audit
 * (documentation/qa/a11y-audit-2026-10-23.md). Drives the Daily Success tracker and the Call Center view in headless
 * Chromium with the keyboard only and asserts what a screen-reader user depends on: accordion state, dialog focus
 * in / trap / return, the rest timer keeping its Skip button and speaking, tabs with arrow keys, focus surviving a redraw.
 * Run by hand (it needs Playwright; CI does not install browsers):
 *
 *   node scripts/a11y-audit-browser.js
 *
 * Playwright is found in tests/node_modules, else set PLAYWRIGHT_CORE=<path to playwright-core>. To use an already
 * downloaded browser set CHROME=<path to chrome / chrome-headless-shell>. Nothing here touches the network or Firebase:
 * the sign-in module and every external host are stubbed, and the pages are served from docs/ on a random local port.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_CORE, path.join(__dirname, '..', 'tests', 'node_modules', 'playwright-core'), 'playwright-core'].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (_) { /* next */ } }
  console.error('playwright-core not found. Set PLAYWRIGHT_CORE or run npm install in tests/.');
  process.exit(2);
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); } else { failed++; console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

async function main() {
  const { chromium } = loadPlaywright();
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    let f = path.join(DOCS, p);
    if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(r);
  });
  await new Promise((res) => srv.listen(0, res));
  const port = srv.address().port;
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await tracker(await ctx.newPage(), port);
    await callCenter(await ctx.newPage());
  } finally { await browser.close(); srv.close(); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

async function tracker(pg, port) {
  console.log('\nDaily Success tracker + Workout Coach');
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.route('**/pro/js/nbd-auth.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'export const NBDAuth={init(){return {}}};' }));
  await pg.route(/googleapis|gstatic|firebase|cdn|fonts/, (r) => r.abort());
  await pg.addInitScript(() => localStorage.setItem('nbd-welcome-seen', '1'));
  await pg.goto('http://localhost:' + port + '/pro/daily-success/index.html');
  await pg.waitForTimeout(1200);
  await pg.click('#tabrow .tab:not(.dtab)');
  await pg.waitForTimeout(500);

  const ph = pg.locator('.pc[data-sec="mindset"] > .ph');
  const st = () => ph.evaluate((e) => ({ role: e.getAttribute('role'), tab: e.tabIndex, exp: e.getAttribute('aria-expanded'), col: e.parentElement.classList.contains('collapsed'), ctl: e.getAttribute('aria-controls'), ctlOk: !!document.getElementById(e.getAttribute('aria-controls')) }));
  const s0 = await st();
  ok('accordion header is a focusable button that names its body', s0.role === 'button' && s0.tab === 0 && s0.ctlOk, s0);
  await ph.focus(); await pg.keyboard.press('Enter'); await pg.waitForTimeout(150);
  const s1 = await st();
  ok('Enter toggles it and aria-expanded follows', s1.col !== s0.col && s1.exp === (s1.col ? 'false' : 'true'), s1);
  await pg.keyboard.press('Space'); await pg.waitForTimeout(150);
  const s2 = await st();
  ok('Space toggles it back', s2.col === s0.col && s2.exp === s0.exp, s2);

  await pg.focus('[data-action="open-rename"]'); await pg.keyboard.press('Enter'); await pg.waitForTimeout(300);
  const d = await pg.evaluate(() => ({ role: document.querySelector('#mRen .mbox').getAttribute('role'), modal: document.querySelector('#mRen .mbox').getAttribute('aria-modal'), label: document.querySelector('#mRen .mbox').getAttribute('aria-label'), inert: !!document.querySelector('.topbar[inert]'), active: document.activeElement.id }));
  ok('Rename opens as a named modal dialog with the page behind inert and focus in the field', d.role === 'dialog' && d.modal === 'true' && !!d.label && d.inert && d.active === 'renInp', d);
  for (let i = 0; i < 6; i++) await pg.keyboard.press('Tab');
  ok('Tab stays inside the dialog', await pg.evaluate(() => !!document.activeElement.closest('#mRen')));
  await pg.keyboard.press('Escape'); await pg.waitForTimeout(200);
  const back = await pg.evaluate(() => ({ action: document.activeElement.getAttribute('data-action'), inert: document.querySelectorAll('[inert]').length }));
  ok('Escape closes it, lifts inert and returns focus to the Rename button', back.action === 'open-rename' && back.inert === 0, back);

  ok('the Workout Coach card is on the day page', await pg.locator('[data-coach-action="start"]').count() === 1);
  await pg.focus('[data-coach-action="start"]'); await pg.keyboard.press('Enter'); await pg.waitForTimeout(500);
  const c = await pg.evaluate(() => { const o = document.getElementById('wcOverlay'); return { open: o.classList.contains('open'), role: o.getAttribute('role'), modal: o.getAttribute('aria-modal'), active: document.activeElement.id }; });
  ok('the logger opens as a modal dialog and takes focus', c.open && c.role === 'dialog' && c.modal === 'true' && c.active === 'wcOverlay', c);
  await pg.locator('.wc-check').first().focus(); await pg.keyboard.press('Enter'); await pg.waitForTimeout(300);
  const after = await pg.evaluate(() => { const a = document.activeElement; return { act: a.getAttribute('data-coach-action'), i: a.getAttribute('data-i'), s: a.getAttribute('data-s'), pressed: a.getAttribute('aria-pressed') }; });
  ok('finishing a set redraws the sheet but focus stays on that set\'s check (now pressed)', after.act === 'done' && after.i === '0' && after.s === '0' && after.pressed === 'true', after);
  const rest = await pg.evaluate(() => ({ role: document.getElementById('wcRestT') && document.getElementById('wcRestT').getAttribute('role'), say: document.getElementById('wcSay') && document.getElementById('wcSay').textContent }));
  ok('the rest timer is a role=timer and announces its start once', rest.role === 'timer' && /^Rest \d+:\d\d$/.test(rest.say || ''), rest);
  await pg.focus('#wcRestBtn'); await pg.waitForTimeout(2300);
  ok('the Skip button keeps focus while the timer ticks', await pg.evaluate(() => document.activeElement.id) === 'wcRestBtn');
  await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
  const out = await pg.evaluate(() => ({ open: document.getElementById('wcOverlay').classList.contains('open'), inert: document.querySelectorAll('[inert]').length, active: document.activeElement.tagName }));
  ok('Escape closes the logger, lifts inert and does not drop focus on <body>', !out.open && out.inert === 0 && out.active !== 'BODY', out);

  const unnamed = await pg.evaluate(() => [...document.querySelectorAll('button,input:not([type=hidden]),select,textarea,[role=button]')].filter((e) => !(e.getAttribute('aria-label') || (e.labels && e.labels.length) || e.textContent.trim() || e.getAttribute('aria-labelledby')) && !e.closest('#nbd-picker-modal')).map((e) => e.tagName + '.' + e.className));
  ok('no unnamed control on the day page (the theme picker is owned by the themes work)', unnamed.length === 0, unnamed.slice(0, 5));
  ok('no script errors', errors.length === 0, errors.slice(0, 3));
}

async function callCenter(pg) {
  console.log('\nCall Center');
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  await pg.route('http://cc.test/**', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/h.html') return r.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/pro/css/phone-calls.css"></head><body><div id="view-calls"><div class="view-scroll"></div></div><script src="/pro/js/call-center-filters-logic.js"></script><script src="/pro/js/call-center-view.js"></script></body></html>' });
    const f = path.join(DOCS, u.pathname);
    if (fs.existsSync(f)) return r.fulfill({ contentType: f.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(f) });
    r.fulfill({ status: 404, body: '' });
  });
  await pg.goto('http://cc.test/h.html');
  await pg.evaluate(() => {
    const now = Date.now();
    const S = NBDCallCenter._state;
    S.calls = [
      { id: 'a', channel: 'call', startedAtMs: now - 3600e3, direction: 'inbound', contactName: 'Dana Smith', phoneDigits: '5135550101', status: 'transcribed', storagePath: 'x', summary: 'Roof leak' },
      { id: 'b', channel: 'call', startedAtMs: now - 7200e3, direction: 'inbound', contactName: 'Mike Ross', phoneDigits: '5135550102', status: 'transcribed', summary: 'Quote' },
      { id: 'c', channel: 'call', startedAtMs: now - 86400e3 * 3, direction: 'outbound', contactName: 'Lee Park', phoneDigits: '5135550103', status: 'transcribed', summary: 'Gutter' },
    ];
    S.loaded = true; NBDCallCenter.setFilter('all');
  });
  const tabs = await pg.evaluate(() => [...document.querySelectorAll('[role=tab]')].map((t) => ({ id: t.id, tab: t.tabIndex, sel: t.getAttribute('aria-selected'), ctl: t.getAttribute('aria-controls') })));
  ok('exactly one tab is a tab stop (the selected one) and every tab controls the panel', tabs.filter((t) => t.tab === 0).length === 1 && tabs.find((t) => t.tab === 0).sel === 'true' && tabs.every((t) => t.ctl === 'ccPanel' && t.id), tabs);
  const labels = await pg.evaluate(() => [...document.querySelectorAll('.cc-card:first-child .pc-actions button')].map((b) => b.getAttribute('aria-label')));
  ok('action buttons name the person', labels.length >= 3 && labels.every((l) => / for /.test(l || '')), labels);
  await pg.focus('#ccTab-all'); await pg.keyboard.press('ArrowRight'); await pg.waitForTimeout(100);
  const r1 = await pg.evaluate(() => ({ id: document.activeElement.id, sel: document.activeElement.getAttribute('aria-selected'), live: document.getElementById('ccLive').textContent, labelled: document.getElementById('ccPanel').getAttribute('aria-labelledby') }));
  ok('ArrowRight moves to the next tab, selects it, keeps focus on it and the panel follows', r1.sel === 'true' && r1.labelled === r1.id && r1.id !== 'ccTab-all', r1);
  ok('a live line says what is showing', /^Showing \d+ (calls?|people|person)/.test(r1.live), r1.live);
  await pg.keyboard.press('End'); await pg.waitForTimeout(100);
  ok('End goes to the last tab', await pg.evaluate(() => document.activeElement.id === [...document.querySelectorAll('[role=tab]')].pop().id));
  await pg.focus('[data-cc="range"][data-arg="today"]'); await pg.keyboard.press('Enter'); await pg.waitForTimeout(100);
  const chip = await pg.evaluate(() => ({ arg: document.activeElement.getAttribute('data-arg'), pressed: document.activeElement.getAttribute('aria-pressed') }));
  ok('a filter chip keeps focus after it redraws the list and reports aria-pressed', chip.arg === 'today' && chip.pressed === 'true', chip);
  await pg.focus('[data-cc="range"][data-arg="custom"]'); await pg.keyboard.press('Enter'); await pg.waitForTimeout(100);
  await pg.fill('[data-cc-date="from"]', '2026-10-01'); await pg.waitForTimeout(100);
  ok('the date box keeps focus (and its value) after the list redraws', await pg.evaluate(() => document.activeElement.getAttribute('data-cc-date') === 'from' && document.activeElement.value === '2026-10-01'));
  ok('no script errors', errors.length === 0, errors.slice(0, 3));
}

main().catch((e) => { console.error(e); process.exit(2); });
