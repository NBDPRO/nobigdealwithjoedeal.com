// walk.js <scenario> - drives the installed-iPhone Today walk (see lib.js).
// Every destructive scenario re-seeds first, so scenarios are independent.
'use strict';
const lib = require('./lib');
const path = require('path');
const { execFileSync } = require('child_process');

const S = {};   // scenarios
const say = (...a) => console.log(...a);
const reseed = () => execFileSync(process.execPath, [path.join(__dirname, 'seed.js')], { stdio: ['ignore', 'ignore', 'inherit'] });

async function open(opts) {
  const h = await lib.launch(opts);
  await lib.login(h.page);
  await lib.forceStandalone(h.page);
  await lib.waitToday(h.page, opts && opts.waitOpts);
  return h;
}
const row = (page, key) => page.locator('[data-tp-row="' + key + '"]');
const callDoc = async (id) => { const d = await lib.admin().db.doc('phone_calls/' + id).get(); return d.exists ? d.data() : null; };
const brief = async (page) => { const t = await lib.readToday(page); return { title: t.title, strip: t.strip, banner: t.banner, sections: t.sections.map((s) => s.title + ': ' + s.rows.map((r) => r.name).join(' | ')) }; };
async function toasts(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.toast, .nbd-toast, [role="status"], #toastContainer > *, .cl-undo')).map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 6));
}

S.boot = async () => {
  reseed();
  const h = await open();
  say(JSON.stringify(await lib.readToday(h.page), null, 1));
  await lib.shot(h.page, '01-today-top');
  await lib.shot(h.page, '02-today-full', { full: true });
  say('TAP < 44:', JSON.stringify((await lib.tapTargets(h.page)).filter((t) => t.h < 44 || t.w < 44)));
  say('ERRORS:', JSON.stringify(h.errors));
  await h.browser.close();
};

// The boot-time invoice read returns an empty cache snapshot before the
// connection is up; Today and the strip then say "could not load" and the
// strip's own "Tap to try again" is a no-op for 30 s.
S.retry = async () => {
  reseed();
  const h = await lib.launch();
  await lib.login(h.page); await lib.forceStandalone(h.page);
  await lib.waitToday(h.page, { settle: 3000 });
  say('AFTER BOOT', JSON.stringify(await brief(h.page)));
  const retry = h.page.locator('#homeAttention [data-ha-retry]').first();
  if (await retry.count()) {
    const t0 = Date.now();
    await retry.click();
    await h.page.waitForTimeout(3500);
    say('AFTER STRIP RETRY (+' + (Date.now() - t0) + 'ms)', JSON.stringify(await brief(h.page)));
  } else say('no strip retry button this run (boot read was fine)');
  await h.page.waitForTimeout(31000);
  const r2 = h.page.locator('#homeAttention [data-ha-retry]').first();
  if (await r2.count()) { await r2.click(); await h.page.waitForTimeout(3500); say('AFTER 2nd RETRY (+31 s)', JSON.stringify(await brief(h.page))); }
  await h.browser.close();
};

// Dana: an urgent MISSED call 25 min ago + an older call carrying a promise.
// Today shows one row, "promised"; what does Done do to the missed call?
S.dana = async () => {
  reseed();
  const h = await open();
  const r = row(h.page, 'prom:ux_dana');
  await r.scrollIntoViewIfNeeded();
  say('ROW TEXT:', (await r.innerText()).replace(/\s+/g, ' '));
  await lib.shot(h.page, '10-dana-row', { mark: ['[data-tp-row="prom:ux_dana"]'] });
  say('BEFORE missed.handledAtMs =', (await callDoc('cube_ux_dana_missed')).handledAtMs, ' old.handledAtMs =', (await callDoc('cube_ux_dana_old')).handledAtMs);
  await r.locator('[data-tp-act="done"]').click();
  await h.page.waitForTimeout(2500);
  const m = await callDoc('cube_ux_dana_missed'), o = await callDoc('cube_ux_dana_old');
  say('AFTER  missed.handledAtMs =', m.handledAtMs, ' old.handledAtMs =', o.handledAtMs);
  say('AFTER', JSON.stringify(await brief(h.page)));
  await lib.shot(h.page, '11-dana-after-done');
  await h.browser.close();
};

// ✓ Handled on an unknown urgent caller: sheet, exits, toasts, undo, counts, reload.
S.handled = async () => {
  reseed();
  const h = await open();
  const key = 'num:5135550142';
  say('BEFORE', JSON.stringify(await brief(h.page)));
  await row(h.page, key).scrollIntoViewIfNeeded();
  await row(h.page, key).locator('[data-tp-act="handled"]').click();
  await h.page.waitForSelector('#prSheet:not([hidden])', { timeout: 8000 });
  await h.page.waitForTimeout(400);
  await lib.shot(h.page, '20-handled-sheet');
  say('SHEET TEXT:', (await h.page.locator('#prSheet').innerText()).replace(/\s+/g, ' ').slice(0, 400));
  const tt = await h.page.evaluate(() => Array.from(document.querySelectorAll('#prSheet button')).map((b) => { const r = b.getBoundingClientRect(); return (b.textContent || '').trim().slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }));
  say('SHEET BUTTONS:', JSON.stringify(tt));
  await h.page.locator('#prSheet [data-pr-act="kind"][data-pr-val="none"]').click();
  await h.page.waitForTimeout(300);
  say('IMMEDIATELY AFTER', JSON.stringify(await brief(h.page)));
  say('TOASTS right after:', JSON.stringify(await toasts(h.page)));
  await h.page.waitForTimeout(2500);
  say('AFTER 2.5s', JSON.stringify(await brief(h.page)));
  say('DOC handledAtMs =', (await callDoc('cube_ux_leak')).handledAtMs);
  await lib.shot(h.page, '21-handled-after');
  await h.page.reload(); await lib.forceStandalone(h.page); await lib.waitToday(h.page);
  say('AFTER RELOAD', JSON.stringify(await brief(h.page)));
  await h.browser.close();
};

// Double tap + slow network on Handled.
S.double = async () => {
  reseed();
  const h = await open();
  let hits = 0;
  await h.page.route('**/callCenterAction*', async (route) => { hits++; await new Promise((r) => setTimeout(r, 3500)); route.continue(); });
  const key = 'num:5135550166';   // 4 open calls
  await row(h.page, key).scrollIntoViewIfNeeded();
  await row(h.page, key).locator('[data-tp-act="handled"]').click();
  await h.page.waitForSelector('#prSheet:not([hidden])');
  const none = h.page.locator('#prSheet [data-pr-act="kind"][data-pr-val="none"]');
  await none.click();
  await h.page.waitForTimeout(150);
  say('150ms after tap: sheet hidden =', await h.page.evaluate(() => document.getElementById('prSheet').hidden), ' sheet text =', (await h.page.locator('#prSheet').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160));
  await lib.shot(h.page, '22-handled-in-flight');
  await none.click({ timeout: 1000 }).catch(() => {});
  await h.page.waitForTimeout(500);
  say('AFTER 2nd TAP sheet hidden =', await h.page.evaluate(() => document.getElementById('prSheet').hidden), ' callable hits so far =', hits);
  await h.page.waitForTimeout(16000);
  say('FINAL hits =', hits, ' (4 calls -> 4 serial writes expected)');
  say('FINAL', JSON.stringify(await brief(h.page)));
  await h.browser.close();
};

// Failure: the callable is down. Toast truthfulness, row comes back?
S.offline = async () => {
  reseed();
  const h = await open();
  await h.page.route('**/callCenterAction*', (route) => route.abort('failed'));
  const key = 'num:5135550177';
  await row(h.page, key).scrollIntoViewIfNeeded();
  await row(h.page, key).locator('[data-tp-act="handled"]').click();
  await h.page.waitForSelector('#prSheet:not([hidden])');
  await h.page.locator('#prSheet [data-pr-act="kind"][data-pr-val="none"]').click();
  await h.page.waitForTimeout(2500);
  say('SHEET hidden =', await h.page.evaluate(() => document.getElementById('prSheet').hidden), ' sheet text =', (await h.page.locator('#prSheet').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 220));
  say('ROW still there =', await row(h.page, key).count());
  say('TOASTS:', JSON.stringify(await toasts(h.page)));
  await lib.shot(h.page, '23-handled-failed');
  await h.browser.close();
};


// Suggestions: Accept on "Looks like Supplier" (one tap) then what happens to that number.
S.suggest = async () => {
  reseed();
  const h = await open();
  const sec = h.page.locator('[data-tp-sec="suggestions"]');
  say('SUGGESTIONS:', (await sec.innerText()).replace(/\s+/g, ' ').slice(0, 500));
  say('POSITION of first chip top(px)=', await sec.evaluate((n) => Math.round(n.getBoundingClientRect().top + scrollY)), ' first section top(px)=', await h.page.evaluate(() => Math.round(document.querySelector('[data-tp-sec="appts"]').getBoundingClientRect().top + scrollY)));
  await lib.shot(h.page, '30-suggestions', { mark: ['[data-tp-sec="suggestions"]'] });
  await h.page.locator('[data-tp-sec="suggestions"] button', { hasText: 'Accept' }).first().click();
  await h.page.waitForTimeout(1500);
  say('AFTER ACCEPT toasts:', JSON.stringify(await toasts(h.page)));
  say('AFTER ACCEPT', JSON.stringify(await brief(h.page)));
  await lib.shot(h.page, '31-after-accept');
  await h.browser.close();
};

// Promises / waiting buttons on Marcus and Priya: what writes, what leaves, confirm/undo.
S.promises = async () => {
  reseed();
  const h = await open();
  const { db } = lib.admin();
  const t = async (l, id) => { const d = await db.doc('leads/' + l + '/tasks/' + id).get(); const x = d.data() || {}; return JSON.stringify({ done: x.done, outcome: x.outcome, dueDate: x.dueDate, missCount: x.missCount, nudgeCount: x.nudgeCount, waitingSince: x.waitingSince }); };
  say('wait-ux1 before', await t('ux_priya', 'wait-ux1'));
  // Still waiting on the first item
  const pr = row(h.page, 'waitp:ux_priya');
  await pr.scrollIntoViewIfNeeded();
  await lib.shot(h.page, '40-waiting-row', { mark: ['[data-tp-row="waitp:ux_priya"]'] });
  await pr.locator('[data-tp-act="pstill"]').first().click();
  await h.page.waitForTimeout(1500);
  say('after Still waiting: toasts', JSON.stringify(await toasts(h.page)), 'doc', await t('ux_priya', 'wait-ux1'));
  say('WAITING now:', (await h.page.locator('[data-tp-sec="waiting"]').innerText().catch(() => '(section gone)')).replace(/\s+/g, ' ').slice(0, 300));
  // Mark dead on the supplier item - confirm? undo?
  const dead = h.page.locator('[data-tp-act="pdead"]').first();
  await dead.scrollIntoViewIfNeeded();
  await dead.click();
  await h.page.waitForTimeout(1500);
  say('after Mark dead: toasts', JSON.stringify(await toasts(h.page)), 'doc', await t('ux_priya', 'wait-ux2'));
  await lib.shot(h.page, '41-after-mark-dead');
  // Kept it on Marcus
  const mr = row(h.page, 'prom:ux_marcus');
  await mr.scrollIntoViewIfNeeded();
  await mr.locator('[data-tp-act="pkept"]').click();
  await h.page.waitForTimeout(1500);
  say('after Kept it: toasts', JSON.stringify(await toasts(h.page)), 'doc', await t('ux_marcus', 'promise-ux1'));
  say('AFTER', JSON.stringify(await brief(h.page)));
  await h.browser.close();
};

// Sam: Done on a promised row that carries an unfiled rider call; Tomorrow on Linda's; return trips.
S.done = async () => {
  reseed();
  const h = await open();
  const sam = row(h.page, 'prom:ux_sam');
  await sam.scrollIntoViewIfNeeded();
  await lib.shot(h.page, '50-sam-row', { mark: ['[data-tp-row="prom:ux_sam"]'] });
  await sam.locator('[data-tp-act="done"]').click();
  await h.page.waitForTimeout(3000);
  say('AFTER Done(Sam)', JSON.stringify(await brief(h.page)));
  say('toasts', JSON.stringify(await toasts(h.page)));
  say('unfiled call handled?', (await callDoc('cube_ux_sam')).handledAtMs);
  const lin = row(h.page, 'fu:ux_linda');
  await lin.scrollIntoViewIfNeeded();
  await lin.locator('[data-tp-act="fu7"]').click();
  await h.page.waitForTimeout(1500);
  say('AFTER +1 week(Linda) toasts', JSON.stringify(await toasts(h.page)));
  const d = await lib.admin().db.doc('leads/ux_linda').get();
  say('linda.followUp =', d.data().followUp);
  say('FINAL', JSON.stringify(await brief(h.page)));
  await h.browser.close();
};

// Estimate follow-up: what the share message looks like and what is stamped.
S.estimate = async () => {
  reseed();
  const h = await open();
  const r = row(h.page, 'est:ux_tom');
  await r.scrollIntoViewIfNeeded();
  await r.locator('[data-ef-send]').click();
  await h.page.waitForTimeout(2500);
  await lib.shot(h.page, '60-estimate-followup');
  say('PAGE after tap, visible dialogs/sheets:', JSON.stringify(await h.page.evaluate(() => Array.from(document.querySelectorAll('[role=dialog],.sheet,.ps-sheet,#phoneShareSheet,[id*=hare]')).filter((n) => n.offsetParent).map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400)))));
  say('TOASTS', JSON.stringify(await toasts(h.page)));
  await h.browser.close();
};

// Call Center + bell vs Today, and what logout wipes.
S.surfaces = async () => {
  reseed();
  const h = await open();
  const bell = await h.page.evaluate(() => { const b = document.querySelector('#notifBadge, .notif-badge, [id*=otifBadge]'); return b ? b.textContent : null; });
  say('bell badge text =', bell);
  await h.page.evaluate(() => window.goTo && window.goTo('calls'));
  await h.page.waitForTimeout(3500);
  await lib.shot(h.page, '70-call-center');
  say('CALL CENTER header/tabs:', (await h.page.locator('#view-calls').innerText()).replace(/\s+/g, ' ').slice(0, 900));
  await h.page.locator('#view-calls [data-cc="act"], #view-calls button', { hasText: 'Handled' }).first().click().catch((e) => say('no handled btn', e.message.slice(0, 80)));
  await h.page.waitForTimeout(2500);
  say('toasts after CC Handled:', JSON.stringify(await toasts(h.page)));
  await lib.shot(h.page, '71-call-center-after-handled');
  await h.page.evaluate(() => { location.hash = ''; window.goTo && window.goTo('home'); });
  await h.page.waitForTimeout(1500);
  say('HOME right after (no wait):', JSON.stringify(await brief(h.page)));
  await h.page.waitForTimeout(8000);
  say('HOME +8s:', JSON.stringify(await brief(h.page)).slice(0, 300));
  await h.page.locator('#notifBell, [data-action="toggleNotifs"], .notif-bell, button[aria-label*="otif"]').first().click().catch(() => {});
  await h.page.waitForTimeout(1200);
  await lib.shot(h.page, '72-bell');
  say('LS keys:', JSON.stringify(await h.page.evaluate(() => Object.keys(localStorage).filter((k) => /^nbd[_-]/.test(k)))));
  await h.browser.close();
};

S.bell = async () => {
  reseed();
  const h = await open();
  const badge = async () => h.page.evaluate(() => { const b = document.querySelector('#notifBadge, .notif-badge, [id*=otifBadge]'); return b ? b.textContent : null; });
  say('badge before =', await badge());
  const btn = h.page.locator('#notifBtn');
  say('bell button count =', await btn.count());
  await btn.click();
  await h.page.waitForTimeout(1200);
  const panel = h.page.locator('#notifDropdown');
  say('PANEL:', ((await panel.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 1200));
  await lib.shot(h.page, '72-bell');
  const clear = h.page.locator('#clearAllNotifBtn');
  if (await clear.count()) { await clear.click(); await h.page.waitForTimeout(1500); say('AFTER CLEAR badge =', await badge(), 'panel =', ((await panel.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 200)); await lib.shot(h.page, '73-bell-cleared'); }
  say('HOME strip now:', (await lib.readToday(h.page)).strip);
  await h.browser.close();
};

S.contrast = async () => {
  reseed();
  const h = await open();
  const out = await h.page.evaluate(() => {
    const parse = (c) => { const m = c.match(/rgba?(([^)]+))/); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const bgOf = (el) => { let n = el; let acc = null; while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.9) return c; n = n.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const sels = ['.tp-title', '.tp-name', '.tp-sub', '.tp-dim', '.tp-miss', '.tp-tag', '.tp-sec-title', '.tp-count', '.tp-btn', '.tp-btn.tp-go', '.tp-hot', '.tp-wait-step', '.ha-item', '.tp-readfail', '.tp-more', '.tp-hd-btn'];
    return sels.map((s) => { const el = document.querySelector('#todayPlan ' + s + ', #homeAttention ' + s); if (!el) return { s, missing: true }; const cs = getComputedStyle(el); const fg = parse(cs.color), bg = bgOf(el); const L1 = lum(fg), L2 = lum(bg); const cr = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); const r = el.getBoundingClientRect(); return { s, fg: cs.color, bg: 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')', ratio: Math.round(cr * 100) / 100, font: cs.fontSize, h: Math.round(r.height) }; });
  });
  out.forEach((o) => say(JSON.stringify(o)));
  await h.browser.close();
};

const name = process.argv[2] || 'boot';
if (!S[name]) { console.error('unknown scenario ' + name + '; have: ' + Object.keys(S).join(', ')); process.exit(2); }
S[name]().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { S };
