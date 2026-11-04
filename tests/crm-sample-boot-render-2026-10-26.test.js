/* tests/crm-sample-boot-render-2026-10-26.test.js
 *
 * Overnight pass 2026-10-26 (wave 2), cluster "Sample account: the two
 * Dashboard panels that never leave Loading…, the Call Center failure banners,
 * and the doubled stylesheet links" (finding crm-6) — the PAINTED half (the
 * dependency-free half is tests/crm-sample-boot-2026-10-26.test.js). Real
 * Chromium on the real /pro/explore sample account, served by
 * tests/lib/demo-hosting-server.js with firebase.json's own rewrites; no
 * network, no auth. Runs in the "Pro demo zero-network walk (Chromium)" CI job.
 *
 *   1. Dashboard: "Today / Next best actions" and "Pipeline engagement" read
 *      the sample's leads instead of "Loading…". Both scripts gated on
 *      /pro/dashboard(.html) while the sample serves the page at
 *      /pro/explore/dashboard, so they never rendered. The briefing's AI
 *      enrichment must stay quiet here (it would toast "AI features run on NBD
 *      Pro servers…" five times per visit), and a briefing row must open the
 *      SAMPLE customer card, not the real page.
 *   2. Call Center: opens on its own honest "No calls yet" line with no failure
 *      banner and no "real account" toast. The pipeline-health strip and the
 *      "said you'd do" list read the owner's recorded phone calls, which the
 *      sample does not have; both used to refuse like any server callable, and
 *      the screen opened on two red "Could not … just now" banners whose Try
 *      again could never work. Nothing here claims a healthy pipeline.
 *
 * At 1200 and 390 px. Locally it SKIPS when playwright is not resolvable;
 * under CI=true that is a failure.
 * Run: cd tests && node crm-sample-boot-render-2026-10-26.test.js
 */
'use strict';

const { start } = require('./lib/demo-hosting-server');

let passed = 0;
let failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail ? '\n       ' + String(detail).slice(0, 1200) : '')); }
}
function report() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
}

const FONT_HOST = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (_) {
    if (process.env.CI) { ok('playwright is installed (required in CI)', false); return report(); }
    console.log('  ! playwright unavailable — SKIPPED'); return report();
  }

  const srv = await start();
  const ORIGIN = srv.origin;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'allow', reducedMotion: 'reduce' });
    await ctx.route('**/*', async (route) => {
      const u = route.request().url();
      if (u.startsWith(ORIGIN + '/')) return route.continue();
      if (FONT_HOST.test(u)) {
        const css = /fonts\.googleapis\.com/.test(u);
        return route.fulfill({ status: 200, contentType: css ? 'text/css' : 'font/woff2', body: css ? '/* hermetic */' : '' });
      }
      return route.abort('blockedbyclient');
    });
    // Every "In your real account…" / "AI features run on NBD Pro servers…" toast the sample raises.
    await ctx.addInitScript(() => {
      window.__notices = [];
      window.addEventListener('nbd-demo:notice', (e) => window.__notices.push({ kind: (e.detail || {}).kind || '', message: String((e.detail || {}).message || '') }));
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e).slice(0, 300)));
    const notices = () => page.evaluate(() => window.__notices.map((n) => n.kind + ': ' + n.message.slice(0, 90)));

    await page.goto(ORIGIN + '/pro/explore');
    await page.waitForURL(ORIGIN + '/pro/explore/dashboard', { timeout: 40000 });
    await page.waitForFunction(() => Array.isArray(window._leads) && window._leads.length >= 20 && typeof window.goTo === 'function', null, { timeout: 40000, polling: 200 });

    // ── 1. the two Dashboard panels ─────────────────────────────────────
    console.log('1. Dashboard: Today / Next best actions and Pipeline engagement (crm-6)');
    await page.evaluate(() => window.goTo('dash'));
    await page.waitForFunction(() => {
      const el = document.getElementById('smart-followup-briefing-body');
      return !!el && !/^\s*Loading/.test(el.textContent || '');
    }, null, { timeout: 20000, polling: 200 }).catch(() => {});
    await page.waitForFunction(() => {
      const el = document.getElementById('engagement-cohort-body');
      return !!el && !/^\s*Loading/.test(el.textContent || '');
    }, null, { timeout: 20000, polling: 200 }).catch(() => {});
    // Past the five AI enrichment calls the briefing would otherwise start.
    await page.waitForTimeout(1500);

    const dash = await page.evaluate(() => {
      const sfb = document.getElementById('smart-followup-briefing-body');
      const ec = document.getElementById('engagement-cohort-body');
      const total = document.getElementById('engagement-cohort-total');
      const counts = [...document.querySelectorAll('#engagement-cohort-body .ec-row')].map((r) => Number((r.lastElementChild.textContent || '').trim()));
      const visible = (e) => !!e && e.getClientRects().length > 0;
      return {
        sfbVisible: visible(sfb), ecVisible: visible(ec),
        sfbText: ((sfb || {}).textContent || '').replace(/\s+/g, ' ').trim(),
        ecText: ((ec || {}).textContent || '').replace(/\s+/g, ' ').trim(),
        rows: sfb ? sfb.querySelectorAll('.sfb-row').length : -1,
        headlines: sfb ? [...sfb.querySelectorAll('.sfb-headline')].map((h) => h.textContent.trim()) : [],
        aiBadges: sfb ? [...sfb.querySelectorAll('.sfb-ai-badge')].filter((b) => getComputedStyle(b).display !== 'none').length : -1,
        ecRows: counts.length, ecSum: counts.reduce((a, b) => a + b, 0), ecTotal: ((total || {}).textContent || '').trim()
      };
    });
    ok('both panels are on screen (the Dashboard view is showing)', dash.sfbVisible && dash.ecVisible, JSON.stringify([dash.sfbVisible, dash.ecVisible]));
    ok('Today / Next best actions no longer reads "Loading…"', !/^Loading/.test(dash.sfbText), dash.sfbText);
    ok('Today / Next best actions lists one to five follow-ups from the sample leads', dash.rows >= 1 && dash.rows <= 5 && dash.headlines.every((h) => h.length > 3), JSON.stringify([dash.rows, dash.headlines]));
    ok('no row claims AI wrote it (AI is not in the sample account)', dash.aiBadges === 0, String(dash.aiBadges));
    ok('Pipeline engagement no longer reads "Loading…"', !/^Loading/.test(dash.ecText), dash.ecText);
    ok('Pipeline engagement shows its five tiers and a total that matches them', dash.ecRows === 5 && dash.ecSum > 0 && dash.ecTotal === dash.ecSum + ' total', JSON.stringify([dash.ecRows, dash.ecSum, dash.ecTotal]));
    const dashNotices = await notices();
    ok('the Dashboard raised no "AI features run on NBD Pro servers" toast (the briefing does not call the model here)', dashNotices.every((n) => !/^ai:/.test(n)), dashNotices.join(' | '));

    for (const w of [390, 1200]) {
      await page.setViewportSize({ width: w, height: 844 });
      await page.waitForTimeout(250);
      const fit = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        return ['smart-followup-briefing-body', 'engagement-cohort-body'].map((id) => {
          const p = document.getElementById(id).closest('.panel') || document.getElementById(id);
          const r = p.getBoundingClientRect();
          return { id, left: Math.round(r.left), right: Math.round(r.right), vw, scroll: p.scrollWidth, client: p.clientWidth };
        });
      });
      ok(w + ' px: both panels sit inside the viewport with nothing wider than themselves', fit.every((f) => f.left >= 0 && f.right <= f.vw + 1 && f.scroll <= f.client + 1), JSON.stringify(fit));
    }

    // A row opens the SAMPLE customer card (location.href = '/pro/customer.html?id=…' is remapped).
    const firstId = await page.evaluate(() => { const r = document.querySelector('#smart-followup-briefing-body .sfb-row'); return r ? r.getAttribute('data-sfb-lead-id') : ''; });
    if (!firstId) ok('a briefing row opens that customer inside the sample account', false, 'no briefing row to click');
    else {
      await page.click('#smart-followup-briefing-body .sfb-row .sfb-text');
      await page.waitForURL((u) => /\/pro\/explore\/customer/.test(u.pathname), { timeout: 20000 }).catch(() => {});
      const landed = new URL(page.url());
      ok('a briefing row opens that customer inside the sample account', /^\/pro\/explore\/customer$/.test(landed.pathname) && landed.searchParams.get('id') === firstId, page.url());
    }

    // ── 2. the Call Center ──────────────────────────────────────────────
    console.log('2. Call Center: no failure banner, no dead Try again, no claim of a pipeline (crm-6)');
    await page.goto(ORIGIN + '/pro/explore/dashboard');
    await page.waitForFunction(() => Array.isArray(window._leads) && window._leads.length >= 20 && typeof window.goTo === 'function', null, { timeout: 40000, polling: 200 });
    await page.evaluate(() => { window.__notices.length = 0; });
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.evaluate(() => window.goTo('calls'));
    await page.waitForSelector('.cc-wrap', { timeout: 25000 });
    await page.waitForFunction(() => /No calls yet/.test((document.querySelector('.cc-wrap') || {}).textContent || ''), null, { timeout: 25000, polling: 200 }).catch(() => {});
    // The view makes its own two callable reads on open; wait until it has built the
    // callable factory, then ask the same two ourselves so both have surely settled.
    await page.waitForFunction(() => !!(window._functions && window._httpsCallable), null, { timeout: 25000, polling: 100 }).catch(() => {});
    const answers = await page.evaluate(async () => {
      const ask = async (name) => {
        try { await window._httpsCallable(window._functions, name)({}); return 'resolved'; }
        catch (e) { return String((e && e.code) || (e && e.message) || e); }
      };
      return { health: await ask('callPipelineHealth'), promises: await ask('callPromisesList') };
    });
    await page.waitForTimeout(1500);

    for (const w of [1200, 390]) {
      await page.setViewportSize({ width: w, height: 844 });
      await page.waitForTimeout(250);
      const cc = await page.evaluate(() => {
        const wrap = document.querySelector('.cc-wrap');
        const text = ((wrap || {}).textContent || '').replace(/\s+/g, ' ');
        return {
          text,
          bad: document.querySelectorAll('.cc-health-bad, .cc-readfail').length,
          strips: document.querySelectorAll('.cc-health').length,
          tryAgain: [...document.querySelectorAll('.cc-wrap button')].filter((b) => /try again/i.test(b.textContent)).length,
          over: document.documentElement.scrollWidth - document.documentElement.clientWidth
        };
      });
      ok(w + ' px: no "Could not … just now" banner', cc.bad === 0 && !/Could not (check|load)/.test(cc.text), cc.text.slice(0, 400));
      ok(w + ' px: no Try again button for a read that can never succeed here', cc.tryAgain === 0, String(cc.tryAgain));
      ok(w + ' px: no pipeline strip, so nothing claims the sample has a healthy call pipeline', cc.strips === 0 && !/pipeline healthy/i.test(cc.text), cc.text.slice(0, 400));
      ok(w + ' px: the screen still says why it is empty (recordings come from the rep\'s phone)', /No calls yet\. Recordings from your phone/.test(cc.text), cc.text.slice(-260));
      ok(w + ' px: the page does not scroll sideways', cc.over <= 1, String(cc.over));
    }
    ok('the pipeline read is answered as "not this account\'s panel" (the quiet path), not as a failure', /permission-denied/.test(answers.health), JSON.stringify(answers));
    ok('the "said you\'d do" read is answered the same way', /permission-denied/.test(answers.promises), JSON.stringify(answers));
    const ccNotices = await notices();
    ok('the Call Center raised no "In your real account this would…" toast on open', ccNotices.length === 0, ccNotices.join(' | '));

    ok('no page error mentions the briefing, the cohort widget or the Call Center', pageErrors.every((m) => !/briefing|cohort|call-center|callPipelineHealth|callPromisesList/i.test(m)), pageErrors.join(' | '));
  } finally {
    await browser.close();
    await srv.close();
  }
  report();
})().catch((e) => { console.error(e); process.exit(1); });
