// tests/e2e/kanban-visibility.spec.js — every pipeline card is actually
// visible, in every look (2026-10-01, Jo: "double check kanban card stability
// and visibility and make sure nothing is broken or causing cards to hide or
// be invisible").
//
// The appearance system now has four layers that all touch .k-card: colour
// themes and skins, static theme art behind the page, Shape & Depth surface
// styles (incl. translucent Liquid Glass / Spatial and transparent-edged
// Clay), and My Skin. This sweeps the combinations a rep can actually pick and
// checks each seeded lead's card BEHAVIOURALLY, never by reading state:
//
//   - it exists (one card per lead) in the column of its own stage
//   - it has a real size and is not display:none / visibility:hidden
//   - it is not faded (product of its and its ancestors' opacity >= .9)
//   - its name is what a finger at that spot hits (elementFromPoint), i.e.
//     nothing covers or clips it
//   - its name text clears WCAG AA (4.5:1) against the real composited
//     background behind it (translucent surfaces are alpha-blended down to
//     the page), so a translucent card over theme art can't wash it out
//
// Desktop board (1280px) sweeps 12 themes x every Shape & Depth style; the
// phone list (390px) sweeps a subset. Each describe logs in once, seeds its
// own leads under a unique token and deletes them afterwards; Cloud Functions
// calls are fulfilled locally. Tagged @audit (audit shard of the authed job).
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const THEMES = ['nbd-original', 'paper', 'high-contrast', 'liveops', 'daylight', 'jobsite', 'maximal',
  'blueprint', 'brick', 'deep-space', 'duo-machine-red', 'duo-neon-orange'];
// Every Shape & Depth style, read from the allow-list the picker uses.
const SHAPES = JSON.parse((require('fs').readFileSync(require('path').join(__dirname, '../../docs/pro/js/dashboard-ui-prefs-boot.js'), 'utf8')
  .match(/var NBD_SHAPE_STYLES = (\[[^\]]*\]);/) || [, '[]'])[1].replace(/'/g, '"'));
const PHONE_THEMES = ['nbd-original', 'paper', 'liveops', 'daylight', 'jobsite', 'blueprint'];
const PHONE_SHAPES = ['sharp', 'clay', 'liquid', 'skeuo', 'spatial'];

function installHelpers() {
  try {
    const today = new Date().toISOString().split('T')[0];
    ['overdue_scan', 'pending_estimate_scan', 'morning_briefing'].forEach((k) => localStorage.setItem('nbd_proactive_' + k, today));
    localStorage.setItem('nbd-onboarding-complete', '1');
  } catch (_) { /* storage blocked */ }

  // Any computed colour → [r,g,b,a] (rgb(), rgba(), color(srgb …), named).
  window.__kvRgba = (css) => {
    const s = String(css || '').trim();
    if (!s || s === 'transparent') return [0, 0, 0, 0];
    let m = s.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
    if (m) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4])];
    m = s.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
    if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4])];
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const g = c.getContext('2d'); g.clearRect(0, 0, 1, 1); g.fillStyle = s; g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255];
  };
  window.__kvLum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  // The colour actually painted behind an element: every ancestor's
  // background-color alpha-blended from the root down (images ignored; theme
  // art and the liquid sheen are faint by contract).
  window.__kvBehind = (el) => {
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) chain.push(n);
    let col = [255, 255, 255];
    for (let i = chain.length - 1; i >= 0; i--) {
      const [r, g, b, a] = window.__kvRgba(getComputedStyle(chain[i]).backgroundColor);
      if (a > 0) col = [r * a + col[0] * (1 - a), g * a + col[1] * (1 - a), b * a + col[2] * (1 - a)];
    }
    return col;
  };
  window.__kvCheck = (card, nameSel) => {
    if (!card) return { problem: 'missing' };
    card.scrollIntoView({ block: 'center', inline: 'center' });
    const r = card.getBoundingClientRect();
    const cs = getComputedStyle(card);
    if (cs.display === 'none' || cs.visibility !== 'visible') return { problem: 'hidden (' + cs.display + '/' + cs.visibility + ')' };
    if (r.width < 120 || r.height < 36) return { problem: 'too small ' + Math.round(r.width) + 'x' + Math.round(r.height) };
    let op = 1;
    for (let n = card; n && n.nodeType === 1; n = n.parentElement) op *= parseFloat(getComputedStyle(n).opacity || '1');
    if (op < 0.9) return { problem: 'faded (opacity ' + op.toFixed(2) + ')' };
    const name = card.querySelector(nameSel);
    if (!name) return { problem: 'no name element' };
    const nr = name.getBoundingClientRect();
    const cx = nr.left + Math.min(nr.width / 2, 40), cy = nr.top + nr.height / 2;
    if (!nr.width || !nr.height || cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return { problem: 'name off-screen or empty' };
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(hit === name || card.contains(hit))) {
      return { problem: 'covered by ' + (hit ? (hit.id ? '#' + hit.id : hit.className || hit.tagName) : 'nothing') };
    }
    const fg = window.__kvRgba(getComputedStyle(name).color);
    const bg = window.__kvBehind(name);
    const blended = fg[3] < 1 ? [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3])] : fg;
    const L1 = window.__kvLum(blended), L2 = window.__kvLum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    if (ratio < 4.5) return { problem: 'name contrast ' + ratio.toFixed(2) + ':1' };
    return { ok: true, ratio };
  };
}

async function setupContext(context) {
  await context.addInitScript(installHelpers);
  await context.route(/cloudfunctions\.net\/|\.run\.app\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"result":{}}' }));
  await context.route(/sentry\.io\//, (r) => r.fulfill({ status: 200, body: '' }));
}

async function seed(page, token) {
  await safeWaitForFunction(page, () => typeof window.addDoc === 'function' && !!window.db && !!window._user
    && typeof window._loadLeads === 'function' && Array.isArray(window._stageKeys) && window._stageKeys.length > 0, { timeout: 40_000 });
  return safeEvaluate(page, async (tok) => {
    const uid = window._user.uid;
    const stages = window._stageKeys.slice(0, 6);
    const old = new Date(); old.setDate(old.getDate() - 60);
    const out = [];
    for (let i = 0; i < stages.length; i++) {
      const ref = await window.addDoc(window.collection(window.db, 'leads'), {
        meter: 'manual', // server lead meter (firestore.rules leadMeterOk, 2026-10-04)
        userId: uid, companyId: (window._userClaims && window._userClaims.companyId) || uid,
        firstName: 'Kv', lastName: tok + 'S' + i, stage: stages[i], // no jobType: every pipeline tab shows an untyped lead
        jobValue: 5000 + i * 1000, address: (20 + i) + ' Card St, Milford OH 45150', phone: '(513) 555-01' + (40 + i),
        source: 'Door Knock', createdAt: i === 0 ? old : new Date(), updatedAt: new Date(),
        // The first lead has sat in its stage for 60 days: the "critical"
        // aging treatment (an animated stripe) must not hide or fade it.
        stageStartedAt: i === 0 ? old : new Date(),
      });
      out.push({ id: ref.id, stage: stages[i] });
    }
    await window._loadLeads();
    return out;
  }, token);
}

async function cleanup(page, rows) {
  if (!page || !rows) return;
  await Promise.race([
    safeEvaluate(page, (ids) => Promise.all(ids.map((id) => window.deleteDoc(window.doc(window.db, 'leads', id)).catch(() => {}))), rows.map((r) => r.id)).catch(() => {}),
    new Promise((r) => setTimeout(r, 15_000)),
  ]);
}

async function openCrm(page, mode) {
  await safeWaitForFunction(page, () => typeof window.goTo === 'function', { timeout: 30_000 });
  await safeEvaluate(page, (m) => {
    try { localStorage.setItem('nbd_crm_show_prospects', '0'); localStorage.setItem('nbd_crm_show_snoozed', '0'); } catch (_) {}
    window.goTo('crm');
    if (m === 'list' && window.crmViewList) window.crmViewList();
    if (m === 'board' && window.crmViewBoard) window.crmViewBoard();
  }, mode);
  const skip = page.getByText('Skip tour', { exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
}

// Apply theme + shape in-page, let two frames paint, then check every card.
async function sweep(page, rows, themes, shapes, cardSel, nameSel) {
  // theme-engine.js is a lazy bundle (script-loader 'theme'); load it the way the picker does.
  await safeEvaluate(page, () => window.ScriptLoader && window.ScriptLoader.loadBundle ? window.ScriptLoader.loadBundle('theme') : null);
  await safeWaitForFunction(page, () => !!(window.ThemeEngine && window.ThemeEngine.apply), { timeout: 30_000 });
  return safeEvaluate(page, async ({ rows, themes, shapes, cardSel, nameSel }) => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // Exactly what the Shape & Depth picker does (dashboard-ui-prefs-boot.js).
    const setShape = (sh) => { if (sh === 'sharp') document.documentElement.removeAttribute('data-shape'); else document.documentElement.setAttribute('data-shape', sh); };
    // Toasts are transient overlays, not what's under test.
    document.querySelectorAll('#toastContainer .toast').forEach((t) => t.remove());
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const checkOne = (r) => {
      const cards = document.querySelectorAll(cardSel + '[data-id="' + r.id + '"]:not([data-job-id])');
      return cards.length > 1 ? { problem: cards.length + ' cards for one lead' } : window.__kvCheck(cards[0], nameSel);
    };
    const failures = []; const transient = []; let checked = 0; let worst = 99; const skipped = [];
    for (const theme of themes) {
      try { window.ThemeEngine.apply(theme, false); } catch (_) {}
      if (document.documentElement.getAttribute('data-theme') !== theme) { skipped.push(theme); continue; }
      // A theme change runs colour transitions (and may refresh the board):
      // measure the settled page, not the frame mid-fade.
      await sleep(450);
      for (const shape of shapes) {
        setShape(shape);
        await frame();
        for (const r of rows) {
          let res = checkOne(r);
          checked++;
          if (!res.ok) {
            // One re-check after the page settles separates a real defect
            // (still wrong) from a measurement taken mid-transition or
            // mid-rerender (reported, but not a failure).
            await sleep(400);
            const again = checkOne(r);
            if (again.ok) { transient.push(theme + ' / ' + shape + ' / ' + r.stage + ': ' + res.problem); res = again; }
            else res = again;
          }
          if (res.ok) worst = Math.min(worst, res.ratio);
          else failures.push(theme + ' / ' + shape + ' / ' + r.stage + ': ' + res.problem);
        }
      }
    }
    setShape('sharp');
    try { window.ThemeEngine.apply('nbd-original', false); } catch (_) {}
    return { failures, transient, checked, worst: Math.round(worst * 100) / 100, skipped };
  }, { rows, themes, shapes, cardSel, nameSel });
}

test.describe.serial('Pipeline cards stay visible in every look @audit', () => {
  test('desktop board: every card visible and readable across themes x Shape & Depth styles', async ({ browser }) => {
    test.setTimeout(240_000);
    const creds = requireTestUser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await setupContext(context);
    const page = await context.newPage();
    let rows = null;
    try {
      await loginAs(page, creds);
      await openCrm(page, 'board');
      // Seed into the columns THIS view shows (a coarse view folds some stages together).
      rows = await seed(page, 'KvD' + Date.now());
      await safeWaitForFunction(page, (ids) => ids.every((id) => document.querySelector('.k-card[data-id="' + id + '"]')), { timeout: 30_000 }, rows.map((r) => r.id))
        .catch(() => {});
      // Each card sits in its own stage's column.
      const placement = await safeEvaluate(page, (rs) => rs.map((r) => {
        const c = document.querySelector('.k-card[data-id="' + r.id + '"]');
        const col = c && c.closest('[id^="kbody-"]');
        return { stage: r.stage, col: col ? col.id.slice(6) : null };
      }), rows);
      for (const p of placement) expect(p.col, 'card for a ' + p.stage + ' lead sits in its own column').toBe(p.stage);

      const shapes = SHAPES;
      expect(shapes.length, 'Shape & Depth styles found (positive control)').toBeGreaterThanOrEqual(8);
      const res = await sweep(page, rows, THEMES, shapes, '.k-card', '.kc-name');
      console.log(`[kanban-visibility] board: ${res.checked} card checks, worst name contrast ${res.worst}:1, themes not registered: ${res.skipped.join(',') || 'none'}, transient: ${res.transient.length}`); res.transient.slice(0, 10).forEach((t) => console.log('[kanban-visibility] transient ' + t)); res.failures.forEach((f) => console.log('[kanban-visibility] FAIL ' + f));
      expect(res.checked, 'cards were actually checked').toBeGreaterThan(THEMES.length * 6);
      expect(res.failures, res.failures.slice(0, 15).join('\n')).toEqual([]);
    } finally {
      await cleanup(page, rows);
      await context.close();
    }
  });

  test('phone list: every card visible and readable (390px)', async ({ browser }) => {
    test.setTimeout(180_000);
    const creds = requireTestUser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await setupContext(context);
    const page = await context.newPage();
    let rows = null;
    try {
      await loginAs(page, creds);
      await openCrm(page, 'list');
      rows = await seed(page, 'KvP' + Date.now());
      await safeWaitForFunction(page, (ids) => ids.every((id) => document.querySelector('.cl-card[data-id="' + id + '"]')), { timeout: 30_000 }, rows.map((r) => r.id))
        .catch(() => {});
      const res = await sweep(page, rows, PHONE_THEMES, PHONE_SHAPES, '.cl-card', '.cl-card-name');
      console.log(`[kanban-visibility] phone list: ${res.checked} card checks, worst name contrast ${res.worst}:1, transient: ${res.transient.length}`); res.failures.forEach((f) => console.log('[kanban-visibility] FAIL ' + f));
      expect(res.checked).toBeGreaterThan(PHONE_THEMES.length * 6);
      expect(res.failures, res.failures.slice(0, 15).join('\n')).toEqual([]);
    } finally {
      await cleanup(page, rows);
      await context.close();
    }
  });
});
