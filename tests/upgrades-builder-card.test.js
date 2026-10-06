/**
 * tests/upgrades-builder-card.test.js — Upgrades & Add-ons, stage 2 lane
 * "card": the Upgrades card on the Job Templates build screen, the Show
 * homeowner page, the save, the paperwork readers and the V2 reopen.
 *
 * WHY (documentation/projects/UPGRADES-ADDONS-DESIGN-2026-09-25.md): the
 * design's one money rule is that the price on the card, the line on every
 * printed surface and the change in the estimate's total are the SAME
 * integer number of cents. This suite drives the REAL files — the build
 * screen (job-templates-ui.js) on a fake DOM through its own delegated click
 * / input listeners, the real save path (JobTemplates.createEstimate →
 * applyUpgrades → NBDUpgrades), the real readers (customer-estimate-rows.js
 * + its functions/ mirror, invoice-pipeline.js, the DocPreflight →
 * NBDDocGen proposal / contract renderer) and the real V2 builder
 * (estimate-v2-ui.js) reopening the saved doc — with real template inputs.
 * The only strings it matches are rendered output.
 *
 *   1. LOADING      the estimates bundle carries the two upgrade files (executed)
 *   2. CARD         offers, nothing pre-ticked, needs_price rows, More, copy
 *   3. PICK         pick one, quantity follows / is typed, errors block save
 *   4. STARS        two at most, a reason from this house or it doesn't show
 *   5. REQUIRED     "Make required" moves an item into the base scope
 *   6. HOMEOWNER    Show homeowner: priced + measured only, Add / No thanks
 *   7. SAVE         card price = preview line = saved row = change in total;
 *                   the offered / chosen / declined log with frozen prices
 *   8. READERS      portal (both copies), doc line items, invoice, proposal
 *                   and contract HTML print the quoted line and total
 *   9. V2           reopen → edit → save keeps the lines and the total;
 *                   county re-taxes the upgrade exactly; insurance drops it
 *  10. GUARDS       insurance jobs, scope-insert mode, every gutter template
 *
 * Run: node tests/upgrades-builder-card.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PRO_JS = path.join(ROOT, 'docs', 'pro', 'js');
const read = (p) => fs.readFileSync(p, 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.UPG_VERBOSE) console.log("  ✓ " + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }
const cents = (d) => Math.round(Number(d) * 100);

// ════════════════════════════════════════════════════════════════════
// Sandbox with a minimal fake DOM (the honest-paperwork suite's shape,
// plus the Upgrades card slot and the homeowner page).
// ════════════════════════════════════════════════════════════════════
const DOM_IDS = ['jtModal', 'jtModalBody', 'jtModalFoot', 'jtStepLbl', 'jtUIStyles', 'jtEditModal',
  'jtEstName', 'jtLeadSel', 'jtRunTotal', 'jtEditCard', 'jtUpgCard', 'jtCreateErr'];
function makeSandbox(extraWin) {
  const byId = {};
  const listeners = {};
  function el(tag) {
    const classes = new Set();
    return {
      tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '',
      style: {}, dataset: {}, disabled: false, firstChild: null,
      classList: {
        add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); },
        toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      },
      appendChild(ch) { if (ch && ch.id) byId[ch.id] = ch; return ch; },
      setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
      focus() {}, setSelectionRange() {}, remove() {},
    };
  }
  const document = {
    head: el('head'), body: el('body'),
    createElement: el,
    getElementById(id) {
      if (byId[id]) return byId[id];
      if (DOM_IDS.indexOf(id) === -1) return null;
      const e = el('div'); e.id = id; byId[id] = e; return e;
    },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
  };
  const store = {};
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  };
  const win = Object.assign({ localStorage, document }, extraWin || {});
  win.window = win;
  const sandbox = {
    window: win, document, localStorage, navigator: { userAgent: 'node' },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
    CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test' },
    URL,
  };
  vm.createContext(sandbox);
  return { win, sandbox, byId, listeners };
}
function load(env, rel) {
  vm.runInContext(read(path.join(ROOT, rel)), env.sandbox, { filename: path.basename(rel) });
}

const STACK = [
  'docs/pro/js/estimate-config.js',
  // Eager on dashboard.html after estimate-config (2026-09-25): every quote,
  // contract and invoice deposit comes from it.
  'docs/pro/js/deposit-rule.js',
  'docs/pro/js/product-data.js',
  'docs/pro/js/roofivent-catalog.js',
  'docs/pro/js/estimate-labor-catalog.js',
  'docs/pro/js/estimate-builder-v2.js',
  'docs/pro/js/estimate-catalog-xactimate.js',
  'docs/pro/js/estimate-logic-engine.js',
  'docs/pro/js/job-templates-data.js',
  'docs/pro/js/job-templates.js',
  'docs/pro/js/customer-estimate-rows.js',
  'docs/pro/js/invoice-pipeline.js',
  'docs/pro/js/upgrade-library.js',
  'docs/pro/js/upgrade-pricing.js',
];
function uiStack(extraWin) {
  const env = makeSandbox(extraWin);
  STACK.forEach((f) => load(env, f));
  load(env, 'docs/pro/js/job-templates-ui.js');
  const w = env.win;
  env.toasts = [];
  w.showToast = (m) => env.toasts.push(String(m));
  env.saved = [];
  w._saveEstimate = (payload) => { env.saved.push(JSON.parse(JSON.stringify(payload))); return Promise.resolve('est_' + env.saved.length); };
  env.click = (action, id) => env.listeners.click.forEach((fn) => fn({
    target: { closest: () => ({ tagName: 'BUTTON', dataset: { jtAction: action, id: id } }) },
  }));
  env.input = (dataset, extra) => env.listeners.input.forEach((fn) => fn({ target: Object.assign({ dataset: dataset }, extra || {}) }));
  env.body = () => (env.byId.jtModalBody ? env.byId.jtModalBody.innerHTML : '');
  env.card = () => (env.byId.jtUpgCard ? env.byId.jtUpgCard.innerHTML : '');
  env.ho = () => (env.byId.jtHomeowner ? env.byId.jtHomeowner.innerHTML : '');
  env.hoOpen = () => !!(env.byId.jtHomeowner && env.byId.jtHomeowner.classList.contains('open'));
  env.foot = () => (env.byId.jtRunTotal ? env.byId.jtRunTotal.innerHTML : '');
  env.start = (ids) => {
    env.click('clear-selection'); env.click('close-modal');
    if (ids.length === 1) { env.click('quick-use', ids[0]); return; }
    ids.forEach((id) => env.input({ jtAction: 'toggle-select', id: id }, { checked: true, type: 'checkbox' }));
    env.click('open-preconfirm');
  };
  return env;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Rendered-output readers — the card and the homeowner page are HTML strings.
const pxText = (html, id) => { const m = new RegExp('data-upg-px="' + id + '">([^<]*)<').exec(html); return m ? m[1] : null; };
const pressed = (html, action, id) => {
  const m = new RegExp('data-jt-action="' + action + '" data-id="' + id + '" aria-pressed="(true|false)"').exec(html);
  return m ? m[1] === 'true' : null;
};
const sumText = (html) => { const m = /data-upg-sum>([^<]*)</.exec(html); return m ? m[1] : null; };
// A row's inline alert (an engine error or a refusal notice); '*' = the card's top line.
const errText = (html, id) => { const m = new RegExp('data-upg-err="' + id.replace('*', '\\*') + '" role="alert">([^<]*)<').exec(html); return m ? m[1] : null; };
const footTotalCents = (html) => { const m = /Total \(retail\): <b>\$([\d,.]+)<\/b>/.exec(html); return m ? cents(m[1].replace(/,/g, '')) : null; };
const hoTotalCents = (html) => { const m = /Total with your choices<b>\$([\d,.]+)<\/b>/.exec(html); return m ? cents(m[1].replace(/,/g, '')) : null; };
// "150 ft × $18 = $2,700" → cents of the line
const lineCentsOf = (txt) => { const m = /= \$([\d,.]+)$/.exec(String(txt || '')); return m ? cents(m[1].replace(/,/g, '')) : null; };

// "free" as an offer word — not the honest "clog-free" in Alu-Rex's warranty name.
const PRESSURE = /(?<![-\w])free\b|today only|limited time|act now|hurry/i;
const K5 = 'jt_gi_k5_seamless_full';
const CLEAN = 'jt_gr_clean_1story';
const LEAF = ['amerimax_lockin_mesh', 'leafblaster_pro_micromesh', 'leafblaster_pro_reinforced', 'alurex'];

(async function main() {
  // ══════════════════════════════════════════════════════════════════
  section('1. LOADING — the estimates bundle carries the upgrade files (executed, not grepped)');
  // ══════════════════════════════════════════════════════════════════
  {
    const env = makeSandbox();
    env.sandbox.document.baseURI = 'https://example.test/pro/dashboard.html';
    load(env, 'docs/pro/js/script-loader.js');
    const b = env.win.ScriptLoader && env.win.ScriptLoader.bundles && env.win.ScriptLoader.bundles.estimates;
    ok('ScriptLoader exposes the estimates bundle', Array.isArray(b));
    const at = (f) => (b || []).findIndex((s) => s.split('?')[0] === 'js/' + f);
    ok('upgrade-library.js rides the estimates bundle', at('upgrade-library.js') !== -1);
    ok('upgrade-pricing.js rides the estimates bundle', at('upgrade-pricing.js') !== -1);
    ok('the library loads before the pricing helper (it throws without it)', at('upgrade-library.js') < at('upgrade-pricing.js'));
    // Since #1762 the upgrade files ride the END of the bundle (after the
    // Job Templates UI); the card and V2 read them at call time, so the
    // contract is only that they are in the SAME lazy bundle.
    ok('both ride the same bundle as the Job Templates UI that calls them', at('job-templates-ui.js') !== -1 && at('upgrade-pricing.js') !== -1);
  }

  // ══════════════════════════════════════════════════════════════════
  section('2. CARD — offers on the build screen, nothing pre-ticked');
  // ══════════════════════════════════════════════════════════════════
  const env = uiStack();
  const W = env.win, JT = W.JobTemplates, U = W.NBDUpgrades;
  ok('UI + engine + NBDUpgrades loaded', !!(W.JobTemplatesUI && JT && U && JT.applyUpgrades && JT.upgradeOffers));
  env.start([K5]);
  let card = env.card();
  ok('the K5 build screen paints an Upgrades card', /data-upg-card/.test(card) && /jt-upg-t">Upgrades</.test(card), card.slice(0, 120));
  ok('card summary starts at "none picked"', sumText(card) === '· none picked', sumText(card));
  ok('leaf protection is ONE pick-one block that starts on None',
    /data-upg-slot="group:leaf_protection"/.test(card) && pressed(card, 'upg-pick-none', 'leaf_protection') === true);
  ok('nothing is pre-ticked: every leaf option is unpressed', LEAF.every((id) => pressed(card, 'upg-pick', id) === false),
    LEAF.map((id) => id + '=' + pressed(card, 'upg-pick', id)).join(' '));
  ok('no star on a fresh card', !/★ Recommended/.test(card));
  // Independent figure: NBDUpgrades itself on the same resolve.
  const res0 = JT.resolveSelection([{ templateId: K5 }], {});
  const direct = U.offeredFor([K5], { lines: res0.lines, measurements: res0.measurements, taxRate: res0.totals.taxRate });
  const dAlu = direct.find((o) => o.id === 'alurex');
  ok('fixture: Alu-Rex is offered at $18/ft on the K5 gutter run', dAlu && dAlu.unitCents === 1800 && dAlu.qty > 0, JSON.stringify(dAlu && { u: dAlu.unitCents, q: dAlu.qty }));
  const aluText = pxText(card, 'alurex');
  ok('price with quantity: "' + aluText + '"', aluText === dAlu.qty + ' ft × $18 = $' + (dAlu.qty * 18).toLocaleString('en-US'), aluText);
  ok('every leaf row\'s price is qty × unit from NBDUpgrades, to the cent',
    LEAF.every((id) => { const o = direct.find((x) => x.id === id); return lineCentsOf(pxText(card, id)) === o.qty * o.unitCents; }));
  ok('a row with no saved price says "Needs a price in Settings"', pxText(card, 'downspout_3x4_step_up') === 'Needs a price in Settings');
  ok('…and cannot be picked (disabled), with no star / required tools',
    /data-jt-action="upg-pick" data-id="downspout_3x4_step_up" aria-pressed="false" disabled/.test(card)
      && !/data-jt-action="upg-star" data-id="downspout_3x4_step_up"/.test(card)
      && !/data-jt-action="upg-require" data-id="downspout_3x4_step_up"/.test(card));
  ok('about three slots show, the rest behind "More (1)"', /data-jt-action="upg-more">More \(1\)</.test(card)
    && !/data-upg-row="popup_emitter"/.test(card), (card.match(/More \(\d+\)/) || ['none'])[0]);
  env.click('upg-more');
  ok('"More" reveals the rest', /data-upg-row="popup_emitter"/.test(env.card()) && /Show fewer/.test(env.card()));
  env.click('upg-more');
  ok('an item already in the base scope is not offered (the K5 apron line)', !/data-upg-row="gutter_apron"/.test(env.card()));
  ok('honest warranty lines: Alu-Rex lifetime clog-free, LeafBlaster 40-year PARTS + no clog coverage, Amerimax 10-year',
    /Alu-Rex lifetime clog-free limited warranty, transferable once; covers pine-needle areas\./.test(card)
      && /40-year limited parts warranty\./.test(card) && /does not cover clogging/.test(card)
      && /Amerimax 10-year limited manufacturer warranty\./.test(card));
  const lbBlock = (card.split('data-upg-row="leafblaster_pro_micromesh"')[1] || '').split('data-upg-row=')[0];
  ok('LeafBlaster never says lifetime or no-clog', lbBlock && !/lifetime|no-clog|clog-free/i.test(lbBlock), lbBlock.slice(0, 80));
  ok('tenant-neutral installer line on the sub-installed item', /Installed by an independent certified installer\./.test(card));
  ok('no pressure copy on the card', !PRESSURE.test(card));
  env.start([ 'jt_fr_asphalt_good' ]);
  ok('a roofing template gets no Upgrades card (none offered yet)', env.card() === '', env.card().slice(0, 80));
  // The installer name saved in Settings → Upgrade prices (#1762:
  // companyProfile.pricing.upgradePrices, per item) reaches the copy.
  W._companyProfile = { pricing: { upgradePrices: { alurex: { cents: null, enabled: true, installerName: 'Acme Guard Co' } } } };
  env.start([K5]);
  ok('a tenant\'s certified installer is named from its own data',
    /Installed by Acme Guard Co, an independent Alu-Rex-certified installer\./.test(env.card()));
  W._companyProfile = null;

  // ══════════════════════════════════════════════════════════════════
  section('3. PICK — pick one, footage follows the scope or is typed, errors block the save');
  // ══════════════════════════════════════════════════════════════════
  env.start([K5]);
  const baseTotalC = footTotalCents(env.foot());
  const baseP = JT.buildEstimatePayload(res0, {});
  ok('fixture: the foot shows the engine total before any pick', baseTotalC === cents(baseP.grandTotal), baseTotalC + ' vs ' + cents(baseP.grandTotal));
  env.click('upg-pick', 'alurex');
  card = env.card();
  const aluC = dAlu.qty * 1800;
  const aluTax = U.taxCentsAt(aluC, baseP.taxRate);
  ok('picking Alu-Rex: "1 picked · +$2,700"-style summary from the same cents', sumText(card) === '· 1 picked · +$' + (aluC / 100).toLocaleString('en-US'), sumText(card));
  ok('picking Alu-Rex presses it and releases None', pressed(card, 'upg-pick', 'alurex') === true && pressed(card, 'upg-pick-none', 'leaf_protection') === false);
  ok('the sticky foot total moves by EXACTLY the quote + its tax', footTotalCents(env.foot()) === cents(baseP.grandTotal) + aluC + aluTax,
    footTotalCents(env.foot()) + ' vs ' + (cents(baseP.grandTotal) + aluC + aluTax));
  env.click('upg-pick', 'leafblaster_pro_micromesh');
  card = env.card();
  ok('pick one: LeafBlaster replaces Alu-Rex', pressed(card, 'upg-pick', 'alurex') === false && pressed(card, 'upg-pick', 'leafblaster_pro_micromesh') === true
    && /· 1 picked/.test(sumText(card)));
  env.click('upg-pick-none', 'leaf_protection');
  ok('None clears the group', /none picked/.test(sumText(env.card())) && pressed(env.card(), 'upg-pick-none', 'leaf_protection') === true);
  env.click('upg-pick', 'alurex');
  env.input({ jtAction: 'upg-qty', id: 'group:leaf_protection' }, { value: '137' });
  await wait(320);
  card = env.card();
  ok('typed footage re-prices: 137 ft × $18 = $2,466 (the design note\'s example)', pxText(card, 'alurex') === '137 ft × $18 = $2,466', pxText(card, 'alurex'));
  ok('…every option of the group follows the one footage', pxText(card, 'amerimax_lockin_mesh') === '137 ft × $6 = $822');
  ok('…and the foot total follows', footTotalCents(env.foot()) === cents(baseP.grandTotal) + 246600 + U.taxCentsAt(246600, baseP.taxRate));
  env.input({ jtAction: 'upg-qty', id: 'group:leaf_protection' }, { value: '137.2' });
  await wait(320);
  ok('feet round UP to the next whole foot (137.2 → 138)', pxText(env.card(), 'alurex') === '138 ft × $18 = $2,484', pxText(env.card(), 'alurex'));
  env.input({ jtAction: 'upg-qty', id: 'group:leaf_protection' }, { value: '' });
  await wait(320);
  ok('clearing the box follows the gutter footage again', pxText(env.card(), 'alurex') === aluText);
  env.input({ jtAction: 'upg-qty', id: 'group:leaf_protection' }, { value: '0' });
  await wait(320);
  card = env.card();
  ok('a zero footage on a picked guard is an error on its row', /data-upg-err="alurex" role="alert">[^<]*quantity/.test(card), (card.match(/data-upg-err="alurex"[^>]*>[^<]*/) || [''])[0]);
  ok('…the summary says to fix it and the foot says upgrades are not added', /fix the upgrade/.test(sumText(card)) && /upgrades not added/.test(env.foot()));
  env.click('go-preview');
  ok('fixture: the preview renders an empty refusal slot beside Create estimate', /id="jtCreateErr" role="alert"><\/div>/.test(env.body()));
  const nSaved = env.saved.length;
  env.click('create-estimate');
  await wait(30);
  ok('Create estimate refuses to save while a pick cannot be priced', env.saved.length === nSaved);
  // Inline beside the button: the toast layer sits under #jtModal (review of #1763).
  ok('…and says why ON the preview, beside the button (role=alert), not only in a toast',
    /^Not saved — fix the upgrade first: .*quantity/.test(env.byId.jtCreateErr.textContent || ''), env.byId.jtCreateErr.textContent);
  env.click('back-to-preconfirm');
  env.input({ jtAction: 'upg-qty', id: 'group:leaf_protection' }, { value: '' });
  await wait(320);

  // A cleaning template: its eaveLf is the coverage cap, never billed.
  env.start([CLEAN]);
  card = env.card();
  ok('cleaning template: guards offered but unpriced until measured ("type the footage")',
    /\$18 per ft — type the footage to price it/.test(pxText(card, 'alurex') || ''), pxText(card, 'alurex'));
  ok('…the hint names the template\'s 160 ft as NOT this house', /about 160 ft, which is not this house/.test(card));
  ok('…and Show homeowner is disabled until something is priced and measured', /data-jt-action="upg-show-homeowner" disabled/.test(card));
  env.input({ jtAction: 'upg-qty', id: 'group:leaf_protection' }, { value: '212' });
  await wait(320);
  ok('typing the measured feet prices it (212 × $12 = $2,544)', pxText(env.card(), 'leafblaster_pro_micromesh') === '212 ft × $12 = $2,544'
    && !/data-jt-action="upg-show-homeowner" disabled/.test(env.card()));

  // ══════════════════════════════════════════════════════════════════
  section('4. STARS — at most two, and a star needs a reason from THIS house');
  // ══════════════════════════════════════════════════════════════════
  env.start([K5]);
  env.click('upg-star', 'alurex');
  card = env.card();
  ok('starring opens the reason box', /data-jt-action="upg-reason" data-id="alurex"/.test(card));
  ok('…but no Recommended badge until a reason is typed', !/★ Recommended<\/span>/.test(card.split('data-upg-row="alurex"')[1].split('data-upg-row=')[0].replace(/aria-pressed="true">★ Recommended/, '')));
  env.input({ jtAction: 'upg-reason', id: 'alurex' }, { value: 'Two big oaks over the back run' });
  env.click('upg-star', 'amerimax_lockin_mesh');
  env.input({ jtAction: 'upg-reason', id: 'amerimax_lockin_mesh' }, { value: '   ' });
  env.click('upg-star', 'leafblaster_pro_micromesh');
  card = env.card();
  ok('a third star is refused, with the reason ON its row (a toast here sits under the modal)', pressed(card, 'upg-star', 'leafblaster_pro_micromesh') === false
    && /^Up to 2 recommendations/.test(errText(card, 'leafblaster_pro_micromesh') || ''), errText(card, 'leafblaster_pro_micromesh'));
  ok('the reasoned star shows its badge', /class="jt-upg-badge star">★ Recommended/.test(card.split('data-upg-row="alurex"')[1].split('data-upg-row=')[0]));
  ok('the blank-reason star shows no badge', !/class="jt-upg-badge star"/.test(card.split('data-upg-row="amerimax_lockin_mesh"')[1].split('data-upg-row=')[0]));
  env.click('upg-star', 'amerimax_lockin_mesh');
  ok('…the refusal clears on the next tap', errText(env.card(), 'leafblaster_pro_micromesh') === '', errText(env.card(), 'leafblaster_pro_micromesh'));
  env.click('upg-star', 'leafblaster_pro_micromesh');
  ok('unstarring frees a slot', pressed(env.card(), 'upg-star', 'leafblaster_pro_micromesh') === true && pressed(env.card(), 'upg-star', 'amerimax_lockin_mesh') === false);
  env.click('upg-star', 'leafblaster_pro_micromesh');
  ok('starring picks nothing (a star is advice, not a tick)', LEAF.every((id) => pressed(env.card(), 'upg-pick', id) === false));

  // ══════════════════════════════════════════════════════════════════
  section('5. MAKE REQUIRED — an item moved into the base scope');
  // ══════════════════════════════════════════════════════════════════
  env.start([K5]);
  env.click('upg-require', 'leafblaster_pro_micromesh');
  card = env.card();
  ok('Make required picks it and marks it Required', pressed(card, 'upg-pick', 'leafblaster_pro_micromesh') === true
    && pressed(card, 'upg-require', 'leafblaster_pro_micromesh') === true && /jt-upg-badge req">Required/.test(card));
  ok('…and the group says its guard is now in the price, not the homeowner\'s choice',
    /data-upg-grp-req="leaf_protection">LeafBlaster PRO stainless micromesh gutter guard is required/.test(card));
  const reqPickSnap = () => LEAF.map((id) => id + '=' + pressed(env.card(), 'upg-pick', id) + '/' + pressed(env.card(), 'upg-require', id)).join(' ');
  const reqHeld = 'amerimax_lockin_mesh=false/false leafblaster_pro_micromesh=true/true leafblaster_pro_reinforced=false/false alurex=false/false';
  ok('fixture: LeafBlaster alone is picked and required', reqPickSnap() === reqHeld, reqPickSnap());

  // Review of #1763 (all three lenses): a sibling tap swapped the required
  // guard out. On the rep's card it is refused and says why, on the row.
  env.click('upg-pick', 'alurex');
  card = env.card();
  ok('rep card: tapping a sibling does NOT replace the required guard', reqPickSnap() === reqHeld, reqPickSnap());
  ok('…it says why on the tapped row', /^LeafBlaster PRO stainless micromesh gutter guard is required on this job\. Tap its “✓ Required” to release it first\.$/.test(errText(card, 'alurex') || ''),
    errText(card, 'alurex'));
  env.click('upg-pick-none', 'leaf_protection');
  ok('rep card: None does not drop the required guard either (the reason shows on it)', reqPickSnap() === reqHeld
    && /^Required on this job\./.test(errText(env.card(), 'leafblaster_pro_micromesh') || ''), reqPickSnap());
  env.click('upg-pick', 'leafblaster_pro_micromesh');
  ok('rep card: untapping the required guard itself is refused too', reqPickSnap() === reqHeld);
  // Second review of #1763: "Make required" on a sibling ran upgPickOn, which
  // clears the group's other picks AND their required flags, so the guard was
  // swapped out and the total dropped with no note. Refused like a row tap.
  const footReq0 = footTotalCents(env.foot());
  ok('fixture: a sibling still offers "Make required" while the guard is held', pressed(env.card(), 'upg-require', 'amerimax_lockin_mesh') === false
    && footReq0 != null, String(footReq0));
  env.click('upg-require', 'amerimax_lockin_mesh');
  card = env.card();
  ok('rep card: "Make required" on a sibling does NOT replace the required guard', reqPickSnap() === reqHeld, reqPickSnap());
  ok('…the total does not move', footTotalCents(env.foot()) === footReq0, footTotalCents(env.foot()) + ' vs ' + footReq0);
  ok('…it says why on the tapped row', /^LeafBlaster PRO stainless micromesh gutter guard is required on this job\. Tap its “✓ Required” to release it first\.$/.test(errText(card, 'amerimax_lockin_mesh') || ''),
    errText(card, 'amerimax_lockin_mesh'));

  // Only the leaf group is priced by default, and it is now base scope.
  env.click('upg-show-homeowner');
  ok('Show homeowner with nothing left to offer: refused, and says so on the card', !env.hoOpen()
    && /^Nothing left to offer: the priced options are already in the price as required\.$/.test(errText(env.card(), '*') || ''), errText(env.card(), '*'));
  ok('…the button reads disabled with that reason', /data-jt-action="upg-show-homeowner" disabled title="Nothing left to offer/.test(env.card()));

  // A second priced option (the tenant priced the 3x4 step-up) — the page opens.
  W._companyProfile = { pricing: { upgradePrices: { downspout_3x4_step_up: { cents: 400, enabled: true, installerName: '' } } } };
  env.start([K5]);
  env.click('upg-require', 'leafblaster_pro_micromesh');
  const dsp = JT.upgradeOffers(JT.resolveSelection([{ templateId: K5 }], {}), {}).find((o) => o.id === 'downspout_3x4_step_up');
  ok('fixture: a tenant price makes the 3x4 step-up quotable on K5', dsp && dsp.state === 'available' && dsp.unitCents === 400 && dsp.qty > 0,
    JSON.stringify(dsp && { s: dsp.state, u: dsp.unitCents, q: dsp.qty }));
  env.click('upg-show-homeowner');
  let ho = env.ho();
  ok('the homeowner page opens for the other option', env.hoOpen() && /data-ho-id="downspout_3x4_step_up"/.test(ho));
  ok('the homeowner page does not offer the required item as a choice', !/data-ho-id="leafblaster_pro_micromesh"/.test(ho));
  ok('…NOR any other option of its group: no card, no Add, no No thanks, no "choose one, or none"',
    LEAF.every((id) => !new RegExp('data-ho-id="' + id + '"|data-id="' + id + '"').test(ho)) && !/Leaf protection<small>/.test(ho),
    LEAF.filter((id) => new RegExp('data-id="' + id + '"').test(ho)).join(','));
  ok('…it lists it under "Already included"', /Already included \(\d+\)[\s\S]*<li>LeafBlaster PRO stainless micromesh gutter guard<\/li>/.test(ho));
  const hoReq0 = hoTotalCents(ho);
  // A stale page or a forged event: Add / No thanks on a held option are refused.
  env.click('upg-ho-add', 'alurex');
  env.click('upg-ho-add', 'amerimax_lockin_mesh');
  env.click('upg-ho-no', 'leafblaster_pro_micromesh');
  env.click('upg-ho-no', 'leafblaster_pro_reinforced');
  ho = env.ho();
  ok('an Add / No thanks on the required group changes neither the picks nor the total', hoTotalCents(ho) === hoReq0
    && /<li>LeafBlaster PRO stainless micromesh gutter guard<\/li>/.test(ho) && reqPickSnap() === reqHeld, hoTotalCents(ho) + ' vs ' + hoReq0 + ' · ' + reqPickSnap());
  env.click('upg-ho-add', 'downspout_3x4_step_up');
  ho = env.ho();
  const dspC = dsp.qty * 400;
  const reqBaseP = JT.applyUpgrades(JT.buildEstimatePayload(JT.resolveSelection([{ templateId: K5 }], {}), {}), JT.resolveSelection([{ templateId: K5 }], {}),
    { picks: ['leafblaster_pro_micromesh'], required: { leafblaster_pro_micromesh: true }, quantities: {} }).payload;
  ok('fixture: the page\'s opening total is the base WITH the required guard', hoReq0 === cents(reqBaseP.grandTotal), hoReq0 + ' vs ' + cents(reqBaseP.grandTotal));
  ok('Add on the other option moves the total by EXACTLY its card price + its tax', hoTotalCents(ho) - hoReq0 === dspC + U.taxCentsAt(dspC, reqBaseP.taxRate),
    (hoTotalCents(ho) - hoReq0) + ' vs ' + (dspC + U.taxCentsAt(dspC, reqBaseP.taxRate)));
  env.click('upg-ho-done');
  ok('after hand back the rep\'s guard is still picked AND required', reqPickSnap() === reqHeld && pressed(env.card(), 'upg-pick', 'downspout_3x4_step_up') === true, reqPickSnap());
  env.click('go-preview');
  const prevReq = env.body();
  ok('preview prints it as a plain base-scope line (no "Upgrade —")',
    /<td>LeafBlaster PRO stainless micromesh gutter guard<\/td>/.test(prevReq) && !/Upgrade — LeafBlaster/.test(prevReq));
  env.click('create-estimate');
  await wait(30);
  let sv = env.saved[env.saved.length - 1];
  const reqRow = sv && sv.rows.find((r) => r.code === 'UPG LG-LBP');
  ok('saved: plain desc, "Base scope", upgradeRequired, still face value', reqRow && reqRow.desc === 'LeafBlaster PRO stainless micromesh gutter guard'
    && reqRow.category === 'Base scope' && reqRow.upgradeRequired === true && cents(reqRow.retailTotal) === dAlu.qty * 1200, JSON.stringify(reqRow && { d: reqRow.desc, c: reqRow.category }));
  ok('saved log: status "required"', !!(sv && sv.upgradeLog) && (sv.upgradeLog.items.find((i) => i.id === 'leafblaster_pro_micromesh') || {}).status === 'required');
  ok('saved log: the held group\'s other options are NOT logged as "offered" (never the homeowner\'s choice)',
    !!(sv && sv.upgradeLog) && !sv.upgradeLog.items.some((i) => LEAF.indexOf(i.id) !== -1 && i.id !== 'leafblaster_pro_micromesh')
      && (sv.upgradeLog.items.find((i) => i.id === 'downspout_3x4_step_up') || {}).status === 'chosen',
    sv && sv.upgradeLog && sv.upgradeLog.items.map((i) => i.id + ':' + i.status).join(','));
  ok('saved: the other option is an "Upgrade —" line at its card price', (sv.rows.find((r) => r.upgradeId === 'downspout_3x4_step_up') || {}).upgradeCents === dspC);
  W._companyProfile = null;

  // Releasing is the rep's own button: then the group is a choice again.
  env.start([K5]);
  env.click('upg-require', 'leafblaster_pro_micromesh');
  env.click('upg-require', 'leafblaster_pro_micromesh');
  ok('"✓ Required" releases it (still picked, no longer required)', pressed(env.card(), 'upg-pick', 'leafblaster_pro_micromesh') === true
    && pressed(env.card(), 'upg-require', 'leafblaster_pro_micromesh') === false && !/data-upg-grp-req=/.test(env.card()));
  env.click('upg-pick', 'alurex');
  ok('…and then a sibling replaces it as usual', pressed(env.card(), 'upg-pick', 'alurex') === true && pressed(env.card(), 'upg-pick', 'leafblaster_pro_micromesh') === false
    && errText(env.card(), 'alurex') === '');
  // Release first, then "Make required" on a sibling: the guard moves to it.
  env.start([K5]);
  env.click('upg-require', 'leafblaster_pro_micromesh');
  env.click('upg-require', 'leafblaster_pro_micromesh');
  env.click('upg-require', 'amerimax_lockin_mesh');
  ok('…released first, "Make required" on a sibling makes IT the required guard',
    reqPickSnap() === 'amerimax_lockin_mesh=true/true leafblaster_pro_micromesh=false/false leafblaster_pro_reinforced=false/false alurex=false/false'
      && errText(env.card(), 'amerimax_lockin_mesh') === '', reqPickSnap());

  // ══════════════════════════════════════════════════════════════════
  section('6. SHOW HOMEOWNER — priced and measured only; Add / No thanks; running total with tax');
  // ══════════════════════════════════════════════════════════════════
  env.start([K5]);
  env.click('upg-star', 'alurex');
  env.input({ jtAction: 'upg-reason', id: 'alurex' }, { value: 'Two big oaks over the back run' });
  env.click('upg-show-homeowner');
  ho = env.ho();
  ok('Show homeowner opens its own full-screen page', env.hoOpen() && /Options for your home/.test(ho));
  ok('the four leaf options are offered, each with Add and No thanks', LEAF.every((id) =>
    new RegExp('data-jt-action="upg-ho-add" data-id="' + id + '" aria-pressed="false">Add<').test(ho)
      && new RegExp('data-jt-action="upg-ho-no" data-id="' + id + '" aria-pressed="false">No thanks<').test(ho)));
  ok('Add and No thanks are the same button class (equal size by the grid)', (ho.match(/class="jt-ho-btn add"/g) || []).length === 4
    && (ho.match(/class="jt-ho-btn no"/g) || []).length === 4);
  const hoIds = (ho.match(/data-ho-id="([a-z0-9_]+)"/g) || []).map((x) => x.slice('data-ho-id="'.length, -1));
  ok('no unpriced item reaches the homeowner (offer cards are the four priced guards only)',
    hoIds.length === 4 && hoIds.every((id) => LEAF.indexOf(id) !== -1), hoIds.join(','));
  ok('the reasoned star reads as a recommendation for this home', /★ Recommended for your home: Two big oaks over the back run/.test(ho));
  ok('"Already included" lists the base scope', /Already included \((\d+)\)/.test(ho) && /<li>/.test(ho));
  ok('the running total starts at the base price incl. tax', hoTotalCents(ho) === cents(baseP.grandTotal), hoTotalCents(ho) + '');
  ok('no pressure copy, no "free" on the homeowner page', !PRESSURE.test(ho));
  env.click('upg-ho-add', 'alurex');
  ho = env.ho();
  ok('Add: the card shows added and the total moves by the quote + tax', /data-ho-id="alurex"/.test(ho) && /jt-ho-card added" data-ho-id="alurex"/.test(ho)
    && hoTotalCents(ho) === cents(baseP.grandTotal) + aluC + aluTax, hoTotalCents(ho) + ' vs ' + (cents(baseP.grandTotal) + aluC + aluTax));
  ok('…and the page says how much of it is tax', new RegExp('includes \\$[\\d,.]+ sales tax').test(ho));
  env.click('upg-ho-add', 'amerimax_lockin_mesh');
  ho = env.ho();
  ok('pick one on the homeowner page too', /jt-ho-card added" data-ho-id="amerimax_lockin_mesh"/.test(ho) && !/jt-ho-card added" data-ho-id="alurex"/.test(ho));
  env.click('upg-ho-no', 'amerimax_lockin_mesh');
  env.click('upg-ho-no', 'leafblaster_pro_micromesh');
  env.click('upg-ho-add', 'alurex');
  ho = env.ho();
  ok('No thanks is recorded and pressed', pressed(ho, 'upg-ho-no', 'leafblaster_pro_micromesh') === true && pressed(ho, 'upg-ho-no', 'amerimax_lockin_mesh') === true);
  env.click('upg-ho-done');
  ok('hand back closes the page', !env.hoOpen() && env.ho() === '');
  card = env.card();
  ok('…and returns the picks to the rep\'s card', pressed(card, 'upg-pick', 'alurex') === true && /Homeowner: no thanks/.test(card));

  // ══════════════════════════════════════════════════════════════════
  section('7. SAVE — card price = preview line = saved row = change in total, to the cent');
  // ══════════════════════════════════════════════════════════════════
  const cardLine = lineCentsOf(pxText(env.card(), 'alurex'));
  env.click('go-preview');
  const prev = env.body();
  const prevRow = /<td>Upgrade — Alu-Rex DoublePro gutter guard<\/td><td class="num">(\d+)<\/td><td>LF<\/td><td class="num">\$([\d,.]+)<\/td><td class="num">\$([\d,.]+)<\/td>/.exec(prev);
  ok('the preview paper prints "Upgrade — Alu-Rex DoublePro gutter guard"', !!prevRow, (prev.match(/Upgrade —[^<]*/) || ['none'])[0]);
  ok('…qty, unit price and line total as quoted', prevRow && Number(prevRow[1]) === dAlu.qty && prevRow[2] === '18.00' && cents(prevRow[3].replace(/,/g, '')) === cardLine);
  const prevTot = /class="r g"><span>Total<\/span><span>\$([\d,.]+)</.exec(prev);
  ok('…and the preview total is the base + quote + tax', prevTot && cents(prevTot[1].replace(/,/g, '')) === cents(baseP.grandTotal) + aluC + aluTax, prevTot && prevTot[1]);
  env.click('create-estimate');
  await wait(30);
  sv = env.saved[env.saved.length - 1];
  const row = sv && sv.rows.find((r) => r.code === 'UPG LG-ARX');
  ok('saved: the upgrade row, tagged, at face value', row && row.upgrade === true && row.upgradeId === 'alurex' && row.desc === 'Upgrade — Alu-Rex DoublePro gutter guard');
  ok('CARD PRICE = SAVED ROW (retailTotal, total and upgradeCents)', row && cents(row.retailTotal) === cardLine && cents(row.total) === cardLine && row.upgradeCents === cardLine,
    row && [cents(row.retailTotal), cardLine].join(' vs '));
  ok('SUBTOTAL moves by exactly the quote', cents(sv.subtotal) - cents(baseP.subtotal) === cardLine, (cents(sv.subtotal) - cents(baseP.subtotal)) + '');
  ok('TAX moves by exactly the quote\'s tax', cents(sv.tax) - cents(baseP.tax) === aluTax && sv.taxAmount === sv.tax);
  ok('GRAND TOTAL moves by exactly the quote + its tax', cents(sv.grandTotal) - cents(baseP.grandTotal) === cardLine + aluTax,
    (cents(sv.grandTotal) - cents(baseP.grandTotal)) + ' vs ' + (cardLine + aluTax));
  ok('O&P untouched (upgrades sit outside markup and O&P)', sv.overhead === baseP.overhead && sv.profit === baseP.profit && sv.retailBeforeOHP === baseP.retailBeforeOHP);
  // The deposit follows the moved total (deposit-rule review fix, 2026-09-25):
  // the base payload's plan was stamped BEFORE the upgrade was added.
  const depWant = W.NBDDepositRule.compute({ total: sv.grandTotal, mode: sv.mode || 'cash' });
  ok('DEPOSIT is re-stamped on the upgraded total (plan total = grandTotal, deposit = the rule)', !!sv.depositPlan
    && sv.depositPlan.totalCents === cents(sv.grandTotal) && cents(sv.deposit) === depWant.depositCents && sv.depositPlan.summary === depWant.summary,
    sv.depositPlan && (sv.depositPlan.totalCents + ' vs ' + cents(sv.grandTotal)));
  ok('upgradeCents / upgradeTaxCents / upgrades[] on the estimate', sv.upgradeCents === cardLine && sv.upgradeTaxCents === aluTax
    && sv.upgrades.length === 1 && sv.upgrades[0].id === 'alurex' && sv.upgrades[0].unitCents === 1800);
  const log = sv.upgradeLog;
  // {} when missing, so a broken save reddens these checks instead of crashing the suite.
  const li = (id) => (log && log.items.find((i) => i.id === id)) || {};
  ok('the log records every offer the homeowner could have had', !!log && LEAF.every((id) => !!li(id).id) && log.items.length === 4, log && log.items.map((i) => i.id).join(','));
  ok('…chosen / declined / offered', li('alurex').status === 'chosen' && li('leafblaster_pro_micromesh').status === 'declined'
    && li('amerimax_lockin_mesh').status === 'declined' && li('leafblaster_pro_reinforced').status === 'offered');
  ok('…with FROZEN prices (unit cents, qty, line cents)', li('alurex').unitCents === 1800 && li('alurex').qty === dAlu.qty && li('alurex').retailCents === cardLine
    && li('leafblaster_pro_reinforced').unitCents === 1500 && li('leafblaster_pro_reinforced').retailCents === dAlu.qty * 1500);
  ok('…the star and its reason, and that the homeowner saw the page', li('alurex').recommended === true && li('alurex').reason === 'Two big oaks over the back run'
    && li('amerimax_lockin_mesh').recommended === false && !!log && log.shownToHomeowner === true && log.version === U.version);
  ok('a needs_price item is never in the log (it was never quotable)', !!log && !li('downspout_3x4_step_up').id && !li('underground_drain').id);
  ok('no undefined anywhere in the saved doc (Firestore rejects it)', !JSON.stringify(sv, (k, v) => (v === undefined ? '__UNDEF__' : v)).includes('__UNDEF__'));
  const savedAlu = sv;

  // Nothing picked, upgrades offered: the offered record is still saved.
  env.start([K5]);
  env.click('go-preview');
  env.click('create-estimate');
  await wait(30);
  sv = env.saved[env.saved.length - 1];
  ok('nothing picked: no upgrade row, the base total unchanged', !sv.rows.some((r) => r.upgrade) && sv.grandTotal === baseP.grandTotal);
  ok('…but the offer is logged (all "offered", prices frozen)', sv.upgradeLog && sv.upgradeLog.items.every((i) => i.status === 'offered' && Number.isInteger(i.unitCents))
    && sv.upgradeLog.shownToHomeowner === false);

  // ══════════════════════════════════════════════════════════════════
  section('8. READERS — every printed surface shows the quoted line and total');
  // ══════════════════════════════════════════════════════════════════
  {
    const CR = W.NBDCustomerEstimateRows, IP = W.InvoicePipeline;
    const CR_SERVER = require(path.join(ROOT, 'functions', 'customer-estimate-rows.js'));
    const want = cardLine;
    const pick = (rows) => rows.find((r) => /Upgrade — Alu-Rex/.test(r.desc || r.description || ''));
    const disp = pick(CR.buildDisplayRows(savedAlu));
    ok('portal export rows (buildDisplayRows): the line at the quoted cents', disp && cents(disp.total) === want && disp.rate === '$18.00', JSON.stringify(disp));
    const srv = pick(CR_SERVER.buildDisplayRows(savedAlu));
    ok('the portal server\'s copy (functions/) prints the same row', srv && JSON.stringify(srv) === JSON.stringify(disp));
    const doc = pick(CR.buildDocLineItems(savedAlu));
    ok('proposal / contract line items (buildDocLineItems)', doc && cents(doc.total) === want && doc.qty === dAlu.qty && doc.unit === 'LF' && doc.rate === 18);
    const inv = pick(IP.buildRowItems(savedAlu));
    ok('invoice items (InvoicePipeline.buildRowItems)', inv && cents(inv.total) === want && inv.unitPrice === 18 && inv.quantity === dAlu.qty, JSON.stringify(inv));
    // Scope lines only — the footing rows (sales tax, Rounding / minimum job,
    // customer-estimate-rows.js footingRows 2026-10-06) follow the tax, not the quote.
    const sum = (rows) => rows.filter((r) => r.code !== 'TAX' && r.code !== 'ADJ').reduce((s, r) => s + cents(r.total), 0);
    const baseDoc = JT.buildEstimatePayload(res0, {});
    // The engine's own per-row rounding already leaves a cent or two between
    // the printed lines and the subtotal; an upgrade must add NO drift to it.
    const drift = (e) => sum(CR.buildDisplayRows(e)) - cents(e.subtotal);
    ok('the upgrade adds no footing drift between printed lines and subtotal', drift(savedAlu) === drift(baseDoc),
      drift(savedAlu) + ' vs ' + drift(baseDoc));
    ok('each reader\'s lines move by exactly the quote', sum(CR.buildDisplayRows(savedAlu)) - sum(CR.buildDisplayRows(baseDoc)) === want
      && sum(CR.buildDocLineItems(savedAlu)) - sum(CR.buildDocLineItems(baseDoc)) === want
      && sum(IP.buildRowItems(savedAlu)) - sum(IP.buildRowItems(baseDoc)) === want);
    ok('every printed row (scope + tax + rounding) foots to the upgraded price', CR.buildDisplayRows(savedAlu).reduce((s, r) => s + cents(r.total), 0) === cents(savedAlu.grandTotal));
    ok('estimateValue (pipeline / lead job value) reads the upgraded total', CR.estimateValue(savedAlu) === savedAlu.grandTotal);

    // The real proposal + contract HTML (DocPreflight → NBDDocGen).
    const d = makeSandbox({ _brand: () => ({ legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} }) });
    ['docs/pro/js/estimate-config.js', 'docs/pro/js/deposit-rule.js', 'docs/pro/js/customer-estimate-rows.js', 'docs/pro/js/document-generator.js',
      'docs/pro/js/document-generator-templates.js', 'docs/pro/js/doc-preflight.js'].forEach((f) => load(d, f));
    d.win.showToast = () => {};
    const paper = async (type) => {
      const w = d.win;
      w._leadDoc = { firstName: 'Jane', lastName: 'Smith', address: '123 Main St, Cincinnati, OH 45202', phone: '5135550100', email: 'j@example.test', scopeOfWork: 'Work as quoted.' };
      w._customerEstimates = [savedAlu];
      let captured = null;
      const real = w.NBDDocGen.generate;
      w.NBDDocGen.generate = (t, data) => { captured = data; };
      try {
        w.DocPreflight.open(type, null);
        if (w.DocPreflight._state.open) { w.DocPreflight._state.softAck = true; await w.DocPreflight.submit(); }
      } finally { w.NBDDocGen.generate = real; }
      if (!captured) return null;
      const data = Object.assign({}, captured, { date: 'September 25, 2026', issueDate: 'September 25, 2026' });
      return type === 'proposal' ? w.NBDDocGen.renderProposal(data) : w.NBDDocGen.renderContract(data);
    };
    for (const type of ['proposal', 'contract']) {
      let html = null;
      try { html = await paper(type); } catch (e) { html = 'ERR ' + e.message; }
      ok(type + ' HTML renders', !!html && html.indexOf('ERR') !== 0, html && html.slice(0, 80));
      const lineRe = new RegExp('<td>Upgrade — Alu-Rex DoublePro gutter guard</td>\\s*<td[^>]*>' + dAlu.qty + '</td>\\s*<td[^>]*>LF</td>\\s*' +
        '<td[^>]*>\\$18\\.00</td>\\s*<td[^>]*>\\$(' + (want / 100).toFixed(2) + '|' +
        (want / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ')</td>');
      ok(type + ' prints "Upgrade — Alu-Rex DoublePro gutter guard", ' + dAlu.qty + ' LF × $18.00 = $' + (want / 100).toFixed(2),
        !!html && lineRe.test(html), html && (html.match(/<td>Upgrade —[\s\S]{0,300}/) || ['none'])[0].replace(/\s+/g, ' '));
      const g = Number(savedAlu.grandTotal);
      ok(type + ' prints the upgraded grand total', !!html && (html.indexOf('$' + g.toFixed(2)) !== -1
        || html.indexOf('$' + g.toLocaleString('en-US', { minimumFractionDigits: 2 })) !== -1), '$' + g.toFixed(2));
    }
  }

  // ══════════════════════════════════════════════════════════════════
  section('9. V2 — reopen → edit → save keeps the upgrade lines and the total');
  // ══════════════════════════════════════════════════════════════════
  {
    const v = makeSandbox();
    STACK.forEach((f) => load(v, f));
    load(v, 'docs/pro/js/estimate-finalization.js');
    load(v, 'docs/pro/js/estimate-v2-ui.js');
    const w = v.win;
    const V2 = w.EstimateV2UI && w.EstimateV2UI._test;
    const FIN = w.EstimateFinalization;
    ok('V2 builder loaded beside the upgrade files', !!(V2 && FIN && w.NBDUpgrades));
    let seq = 0;
    const reopen = (doc) => {
      const d = JSON.parse(JSON.stringify(doc)); d.id = 'est_upg_' + (++seq);
      w._estimates = [d];
      V2.rehydrateFromSaved(d.id);
      return V2.getState();
    };
    const upLines = (est) => (est.lines || []).filter((l) => l.code === 'UPG LG-ARX');
    const doc0 = savedAlu;

    let st = reopen(doc0);
    ok('reopen: the upgrade row is kept out of the catalog scope', !st.scope.some((s) => /^UPG /.test(s.code)) && st.upgrades.length === 1);
    ok('reopen: the offered / chosen / declined log is carried', st.upgradeLog && st.upgradeLog.items.length === 4);
    let est = V2.effectiveEstimate();
    ok('clean replay prints the upgrade line at face and the saved total', upLines(est).length === 1 && cents(upLines(est)[0].retailTotal) === cardLine
      && cents(est.total) === cents(doc0.grandTotal));
    let re = V2.buildSavePayload(est, st);
    const reRow = re.rows.find((r) => r.code === 'UPG LG-ARX');
    ok('clean re-save keeps the row, its tag, its face value and a real rate', reRow && reRow.upgrade === true && reRow.upgradeId === 'alurex'
      && cents(reRow.retailTotal) === cardLine && reRow.rate === '$18.00' && reRow.upgradeCents === cardLine, JSON.stringify(reRow && { r: reRow.rate, t: reRow.retailTotal }));
    ok('clean re-save keeps the total, upgradeCents / tax and the log', cents(re.grandTotal) === cents(doc0.grandTotal) && re.upgradeCents === cardLine
      && re.upgradeTaxCents === aluTax && re.upgradeLog && re.upgradeLog.items.length === 4);

    // EDIT: the builder re-resolves live. The base comes from V2's own
    // engine call; the upgrade must add exactly its quote + tax on top.
    st._reopenedClean = false;
    est = V2.effectiveEstimate();
    const liveUp = upLines(est);
    const saveUps = st.upgrades; st.upgrades = [];
    const baseLive = V2.effectiveEstimate();
    st.upgrades = saveUps;
    ok('after an edit the upgrade line is still there, once', liveUp.length === 1 && cents(liveUp[0].retailTotal) === cardLine, 'lines: ' + liveUp.length);
    ok('after an edit: total = the live base + the quote + its tax, to the cent',
      cents(est.total) === cents(baseLive.total) + cardLine + w.NBDUpgrades.taxCentsAt(cardLine, baseLive.taxRate),
      cents(est.total) + ' vs ' + (cents(baseLive.total) + cardLine + aluTax));
    ok('after an edit: subtotal moves by the quote, tax by its tax', cents(est.subtotal) - cents(baseLive.subtotal) === cardLine
      && cents(est.tax) - cents(baseLive.tax) === w.NBDUpgrades.taxCentsAt(cardLine, baseLive.taxRate));
    ok('an unchanged scope re-resolves to the SAME total the Job Templates screen saved', cents(est.total) === cents(doc0.grandTotal),
      cents(est.total) + ' vs ' + cents(doc0.grandTotal));
    const rq = FIN.formatEstimate(est, 'retail-quote', { customer: { name: 'Jane Smith', address: '1 Elm St' }, estimate: { number: 'EST-1', date: '2026-09-25' } }).html;
    const pt = /PROJECT TOTAL<\/strong><\/td>\s*<td class="num"><strong>\$([\d,.]+)</.exec(rq);
    ok('the V2 Retail Quote lists the upgrade in the scope', rq.indexOf('<strong>Upgrade — Alu-Rex DoublePro gutter guard</strong>') !== -1);
    ok('…and its PROJECT TOTAL is the upgraded total, to the cent', !!pt && cents(pt[1].replace(/,/g, '')) === cents(est.total), pt && pt[1]);
    re = V2.buildSavePayload(est, st);
    const reRow2 = re.rows.find((r) => r.code === 'UPG LG-ARX');
    ok('edited re-save keeps the tagged row and the upgraded total', reRow2 && reRow2.upgrade === true && cents(reRow2.retailTotal) === cardLine
      && cents(re.grandTotal) === cents(est.total) && re.upgradeCents === cardLine);
    ok('…in every reader (portal rows print the quoted line)', cents((w.NBDCustomerEstimateRows.buildDisplayRows(re).find((r) => r.code === 'UPG LG-ARX') || {}).total) === cardLine);
    ok('the draft carries the upgrades too', (V2.collectDraft().upgrades || []).length === 1);

    // Second cycle: reopen THE RE-SAVED doc, edit again, save again.
    st = reopen(re);
    ok('second reopen: still an upgrade, still out of the catalog scope', st.upgrades.length === 1 && !st.scope.some((s) => /^UPG /.test(s.code)));
    st._reopenedClean = false;
    const est2 = V2.effectiveEstimate();
    const re2 = V2.buildSavePayload(est2, st);
    ok('second edit + save: same line, same total, to the cent', upLines(est2).length === 1 && cents(re2.grandTotal) === cents(re.grandTotal)
      && re2.rows.filter((r) => r.code === 'UPG LG-ARX').length === 1);

    // A county with a different rate re-taxes the upgrade exactly.
    const counties = (w.EstimateBuilderV2.getCountyTaxMap && w.EstimateBuilderV2.getCountyTaxMap()) || {};
    const other = Object.keys(counties).find((k) => Number(counties[k]) !== Number(doc0.taxRate));
    const countyWas0 = st.county;
    if (other) {
      st.county = other;
      const e3 = V2.effectiveEstimate();
      const upT = w.NBDUpgrades.taxCentsAt(cardLine, e3.taxRate);
      const saveU = st.upgrades; st.upgrades = [];
      const b3 = V2.effectiveEstimate(); st.upgrades = saveU;
      ok('county ' + other + ' (' + e3.taxRate + '): the upgrade is re-taxed at the new rate, the quote unchanged',
        cents(e3.total) === cents(b3.total) + cardLine + upT && e3.upgradeTaxCents === upT && upLines(e3).length === 1 && cents(upLines(e3)[0].retailTotal) === cardLine);
    } else {
      ok('a second county rate exists to test re-taxing', false, JSON.stringify(counties));
    }

    // A total WITH cents (review of #1763): Hamilton County's 7.8% on the
    // upgrade gives exact tax cents on top of the $25-rounded engine total.
    // The Retail Quote printed PROJECT TOTAL / Balance rounded to the dollar
    // (fmtMoneyBig), so the V2 paper disagreed with the saved grandTotal and
    // with the proposal, contract, portal and invoice.
    ok('fixture: Hamilton County is a tax jurisdiction (7.8%)', Number(counties['hamilton-oh']) === 0.078, String(counties['hamilton-oh']));
    st.county = 'hamilton-oh';
    const eh = V2.effectiveEstimate();
    ok('fixture: at 7.8% the upgraded total carries cents', cents(eh.total) % 100 !== 0 && upLines(eh).length === 1, String(eh.total));
    const rqh = FIN.formatEstimate(eh, 'retail-quote', { customer: { name: 'Jane Smith', address: '1 Elm St' }, estimate: { number: 'EST-2', date: '2026-09-25' } }).html;
    const money2 = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ptH = /PROJECT TOTAL<\/strong><\/td>\s*<td class="num"><strong>(\$[\d,.]+)</.exec(rqh);
    ok('Retail Quote PROJECT TOTAL prints the cents: ' + money2(cents(eh.total)), !!ptH && ptH[1] === money2(cents(eh.total)), ptH && ptH[1]);
    // Stage labels come from deposit-rule.js (2026-09-25): a cash job over
    // $2,000 is "50% deposit — At signing" + "Balance — On completion".
    const depH = /50% deposit — At signing<\/strong><\/td>\s*<td class="num"><strong>(\$[\d,.]+)</.exec(rqh);
    const balH = /Balance — On completion<\/strong><\/td>\s*<td class="num"><strong>(\$[\d,.]+)</.exec(rqh);
    ok('…and deposit + balance foot to it exactly', !!depH && !!balH
      && cents(depH[1].replace(/[$,]/g, '')) + cents(balH[1].replace(/[$,]/g, '')) === cents(eh.total), [depH && depH[1], balH && balH[1]].join(' + '));
    const reH = V2.buildSavePayload(eh, st);
    ok('…and the saved grandTotal is that same figure', cents(reH.grandTotal) === cents(eh.total) && cents(reH.grandTotal) === cents(ptH && ptH[1].replace(/[$,]/g, '')));
    st.county = countyWas0;
    ok('fixture: back on the saved county the total is the saved one', cents(V2.effectiveEstimate().total) === cents(doc0.grandTotal), String(V2.effectiveEstimate().total));

    // Insurance: upgrades never go inside a claim — dropped from the price,
    // kept in state (switching back restores them).
    st.jobMode = 'insurance';
    const ins = V2.effectiveEstimate();
    ok('insurance: no upgrade line and no upgrade in the total', upLines(ins).length === 0 && st.upgrades.length === 1);
    const insSave = V2.buildSavePayload(ins, st);
    ok('insurance re-save: no upgrade rows, and upgradeCents written as 0 (not left stale)', !insSave.rows.some((r) => r.upgrade) && insSave.upgradeCents === 0
      && Array.isArray(insSave.upgrades) && insSave.upgrades.length === 0);
    const logOf = (p, id) => ((p.upgradeLog && p.upgradeLog.items) || []).find((i) => i.id === id) || {};
    ok('insurance re-save: the log says the chosen upgrade was removed (not "chosen" for a line the estimate lacks)',
      logOf(insSave, 'alurex').status === 'removed' && logOf(insSave, 'alurex').removedFrom === 'chosen', JSON.stringify(logOf(insSave, 'alurex')));
    ok('…while the builder keeps the original record (switching back restores it)', (st.upgradeLog.items.find((i) => i.id === 'alurex') || {}).status === 'chosen');
    st.jobMode = 'cash';
    ok('back to cash: the upgrade line returns', upLines(V2.effectiveEstimate()).length === 1);
    ok('…and a save logs it "chosen" again', logOf(V2.buildSavePayload(V2.effectiveEstimate(), st), 'alurex').status === 'chosen');

    // Review of #1763: two more paths used to drop the upgrade SILENTLY.
    // (1) Per-SQ — gated on the toggle alone. A per-SQ quote prints no
    // lines, so the upgrade is out of that price, but the builder now says
    // so and the log records it; and a per-SQ toggle the overlay cannot
    // honour (no roof area) prices line-item WITH the upgrade.
    st.mode = 'per-sq';
    const ps1 = V2.effectiveEstimate();
    ok('per-SQ (overlay applies): no upgrade line, and the estimate says why', ps1.priceMode === 'per-sq' && upLines(ps1).length === 0
      && /per-SQ quote prints no line items/.test(ps1.upgradesOffReason || ''), ps1.priceMode + ' · ' + ps1.upgradesOffReason);
    const psSave = V2.buildSavePayload(ps1, st);
    ok('…its save writes upgradeCents 0 and logs the upgrade "removed"', psSave.upgradeCents === 0 && logOf(psSave, 'alurex').status === 'removed');
    const sqftWas = st.measurements.rawSqft;
    st.measurements.rawSqft = 0;
    const ps2 = V2.effectiveEstimate();
    ok('per-SQ toggled with no roof area: priced line-item, WITH the upgrade', ps2.priceMode === 'line-item' && upLines(ps2).length === 1
      && !ps2.upgradesOffReason && cents(ps2.total) === cents(doc0.grandTotal), ps2.priceMode + ' ' + ps2.total);
    st.measurements.rawSqft = sqftWas;
    st.mode = 'line-item';
    // (2) An empty catalog scope with only a pass-through fee left.
    const scopeWas = st.scope, feesWas = st.passThru;
    st.scope = [];
    st.passThru = [{ code: 'SVC MEAS', desc: 'Measurement report', amount: 75, source: 'passthru' }];
    const pe1 = V2.effectiveEstimate();
    ok('empty scope + a fee: the upgrade is out of the price and the estimate says why', !!pe1 && upLines(pe1).length === 0
      && /scope is empty/.test(pe1.upgradesOffReason || ''), pe1 && pe1.upgradesOffReason);
    st.scope = scopeWas; st.passThru = feesWas;
    // (3) The rep removed the line (× in the scope list).
    const upsWas = st.upgrades;
    st.upgrades = [];
    const rmSave = V2.buildSavePayload(V2.effectiveEstimate(), st);
    ok('a removed upgrade: upgradeCents 0 and logged "removed" (removedFrom "chosen")', rmSave.upgradeCents === 0
      && logOf(rmSave, 'alurex').status === 'removed' && logOf(rmSave, 'alurex').removedFrom === 'chosen');
    st.upgrades = upsWas;
    ok('restored: the line and the saved total are back', upLines(V2.effectiveEstimate()).length === 1 && cents(V2.effectiveEstimate().total) === cents(doc0.grandTotal));

    // A plain V2 estimate is untouched by any of this.
    const plain = JSON.parse(JSON.stringify(JT.buildEstimatePayload(res0, {})));
    delete plain.sourceTemplates; plain.builder = 'v2';
    st = reopen(plain);
    const pe = V2.effectiveEstimate();
    const ps = V2.buildSavePayload(pe, st);
    ok('a plain estimate gains no upgrade keys on re-save', !('upgradeCents' in ps) && !('upgradeLog' in ps) && !('upgrades' in ps) && st.upgrades.length === 0);
  }

  // ══════════════════════════════════════════════════════════════════
  section('10. GUARDS — insurance jobs, scope-insert mode, every gutter template');
  // ══════════════════════════════════════════════════════════════════
  {
    env.start([K5]);
    env.click('upg-pick', 'alurex');
    env.click('set-jobmode', 'insurance');
    card = env.card();
    ok('insurance: the card says upgrades are never inside a claim', /insurance claim/.test(card) && /not on insurance jobs/.test(card));
    ok('insurance: no pick controls and no Show homeowner', !/data-jt-action="upg-pick"/.test(card) && !/upg-show-homeowner/.test(card));
    env.click('go-preview');
    ok('insurance: the preview prints no upgrade line', !/Upgrade —/.test(env.body()));
    env.click('create-estimate');
    await wait(30);
    sv = env.saved[env.saved.length - 1];
    ok('insurance: the saved estimate has no upgrade rows and no upgrade log', !sv.rows.some((r) => r.upgrade) && !('upgradeLog' in sv) && sv.mode === 'insurance');
    env.click('close-modal');

    // Scope-insert mode hands V2 catalog codes only — no card there.
    W.JobTemplatesUI.openPickerForScope(() => {});
    env.click('quick-use', K5);
    ok('"Insert into estimate" mode shows no Upgrades card (insertIntoV2 has no upgrade path)', env.card() === '');
    env.click('close-modal');

    // Every gutter template: nothing pre-ticked, None pressed, card honest.
    const L = W.NBD_UPGRADE_LIBRARY;
    const bad = [];
    // The job mode outlives the modal (existing behaviour); the sweep must
    // run on a cash job, where the picks exist, or it passes vacuously.
    env.start([K5]);
    env.click('set-jobmode', 'cash');
    ok('back on cash, the card is live again', /data-jt-action="upg-pick"/.test(env.card()));
    Object.keys(L.templates).forEach((id) => {
      env.start([id]);
      const c = env.card();
      if (/aria-pressed="true"/.test(c.replace(/data-jt-action="upg-pick-none" data-id="[a-z_]+" aria-pressed="true"/g, ''))) bad.push(id + ' pre-ticked');
      if (/data-upg-slot="group:/.test(c) && pressed(c, 'upg-pick-none', 'leaf_protection') !== true) bad.push(id + ' None not pressed');
      if (PRESSURE.test(c)) bad.push(id + ' pressure copy');
    });
    ok('all ' + Object.keys(L.templates).length + ' gutter templates: nothing pre-ticked, None pressed, no pressure copy', bad.length === 0, bad.join('; '));
    env.click('close-modal');
    ok('closing the modal resets picks, stars and answers (never carried to the next quote)',
      JSON.stringify(Object.keys(env.win.JobTemplatesUI)) && (env.start([K5]), LEAF.every((id) => pressed(env.card(), 'upg-pick', id) === false) && !/★/.test(env.card())));
  }

  // ══════════════════════════════════════════════════════════════════
  section('11. JOB MINIMUM — a floored job says an option counts toward the minimum first');
  // ══════════════════════════════════════════════════════════════════
  {
    // Review of #1763 (minor): the pricing core re-applies the job minimum
    // to the WHOLE job, so on a floored job an option first fills the gap
    // and the total moves by less than its price. The card and the
    // homeowner page now say so instead of silently disagreeing.
    const RESEAL = 'jt_gr_reseal';
    const tpl = JT.get(RESEAL);
    env.start([RESEAL]);
    ok('fixture: an unfloored reseal shows no minimum note', !/data-upg-min/.test(env.card()));
    for (let i = 1; i < tpl.items.length; i++) {
      env.input({ jtAction: 'item-include', tid: RESEAL, idx: String(i) }, { checked: false, type: 'checkbox', closest: () => null });
    }
    await wait(320);
    const flRes = JT.resolveSelection([{ templateId: RESEAL, itemChoices: Object.fromEntries(tpl.items.map((x, i) => [i, { include: i === 0 }])) }], {});
    const flBase = JT.buildEstimatePayload(flRes, {});
    ok('fixture: one line left, the job is floored at its minimum', flBase.minJobApplied === true && cents(flBase.grandTotal) === cents(flRes.minJobCharge),
      flBase.grandTotal + ' / ' + flRes.minJobCharge);
    env.input({ jtAction: 'upg-qty', id: 'group:leaf_protection' }, { value: '10' });
    await wait(320);
    env.click('upg-pick', 'amerimax_lockin_mesh');
    card = env.card();
    const minMsg = 'This job is priced at its $' + Number(flRes.minJobCharge).toLocaleString('en-US') + ' minimum charge.';
    ok('the card says the job is at its minimum and an option counts toward it first',
      new RegExp('data-upg-min>' + minMsg.replace(/[$.]/g, '\\$&') + ' An option counts toward that minimum first').test(card), (card.match(/data-upg-min>[^<]*/) || ['none'])[0]);
    ok('fixture: 10 ft of Amerimax ($60) leaves the floored total where it was', footTotalCents(env.foot()) === cents(flBase.grandTotal), String(footTotalCents(env.foot())));
    env.click('upg-show-homeowner');
    ok('the homeowner page says it too, above the options', env.hoOpen() && new RegExp('class="jt-ho-min" data-ho-min>' + minMsg.replace(/[$.]/g, '\\$&')).test(env.ho()));
    env.click('upg-ho-done');
    env.click('close-modal');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
