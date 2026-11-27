/**
 * tests/payment-terms-settings-2026-11-18.test.js - Settings > Company Profile >
 * "Payment terms" (docs/pro/js/payment-terms-settings.js).
 *
 * The clause set v1 prints twelve Company Profile numbers (paymentTerms). With flag
 * docClauseSetV1 on, an unset one refuses the contract send; this is the screen that sets
 * them. Owner / company_admin edit; everyone else reads. Save writes ONLY { paymentTerms }
 * through window._saveCompanyProfile (a merge). Bounds equal clause-set.js numOk and
 * firestore.rules. The readiness line is the send gate's own missing list (renderV1).
 *
 * Run: node tests/payment-terms-settings-2026-11-18.test.js
 */
'use strict';
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeDom, click, text } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const FILE = 'docs/pro/js/payment-terms-settings.js';
const SRC = read(FILE);
const tick = () => new Promise((r) => setImmediate(r));
let PT = null;
try { PT = require(path.join(ROOT, FILE)); } catch (e) { PT = null; }
const CS = require(path.join(ROOT, 'docs/pro/js/clause-set.js'));
const KEYS = ['lateGraceDays', 'lateInterestPct', 'disputeDays', 'finalPaymentDays', 'punchListDays', 'pauseNoticeDays',
  'restockPct', 'cardFeePct', 'deckingPerSheetCents', 'deckingSheetsBeforeChangeOrder', 'atticFreeCheckDays', 'claimNoticeDays'];

/** The send gate's own missing list for a tenant's terms: renderV1 over every state and payment source it can print. */
function gateMissing(profileTerms, isNbd) {
  const terms = CS.paymentTermsFor(profileTerms, isNbd), seen = {};
  ['KY', 'OH', ''].forEach((st) => ['cash', 'insurance', 'financed', ''].forEach((src) => {
    CS.renderV1({ state: st, paymentSource: src, terms, hasWarranty: true, facts: { milestones: ['m'] } }).missing.forEach((k) => { seen[k] = 1; });
  }));
  return CS.PT_FIELDS.filter((k) => seen[k]);
}

function mount(claims, profile, opts) {
  const o = opts || {};
  const dom = makeDom();
  const { document } = dom;
  const view = document.createElement('div');
  view.setAttribute('id', 'view-settings');
  view.innerHTML = '<div class="panel mb-md" id="lh"><div class="panel-body"><input type="text" id="cp_businessLicense"></div></div>';
  document.body.appendChild(view);
  const saves = [];
  const W = {
    document, console: { log() {}, warn() {}, error() {} },
    _userClaims: claims, _user: { uid: o.uid || 'co-a' },
    _companyProfile: profile, _legal: () => W._companyProfile,
    _brand: () => (o.nbd === false ? { legalName: 'Acme Roofing LLC' } : { legalName: 'No Big Deal Home Solutions' }),
    NBDClauseSet: CS,
    _saveCompanyProfile: (p) => { saves.push(JSON.parse(JSON.stringify(p))); if (o.saveFails) return Promise.reject(new Error('nope')); return Promise.resolve(); },
    showToast: (m, k) => { (W.toasts = W.toasts || []).push([String(m), k]); },
    switchSettingsTab: (t) => { W.tabs = (W.tabs || []).concat([t]); },
    ScriptLoader: { load: (u) => { (W.loads = W.loads || []).push(String(u)); return Promise.resolve(); } },
    addEventListener() {}, setTimeout: (f) => { f(); return 1; },
  };
  Object.defineProperty(W, 'NBDFlags', { get() { W.flagTouched = true; return undefined; }, configurable: true });
  const ctx = vm.createContext(W);
  ctx.window = ctx;
  vm.runInContext(SRC, ctx, { filename: FILE });
  return { W: ctx, dom, document, saves, panel: () => document.querySelector('[data-ptset="panel"]') };
}
const inp = (p, k) => p.querySelector('#pt_' + k);
const got = (p, k) => { const e = inp(p, k); return e.value !== undefined ? e.value : e.getAttribute('value'); };
function fill(p, vals) { Object.keys(vals).forEach((k) => { inp(p, k).value = String(vals[k]); }); }

(async () => {
  console.log('\n1. the file and how it loads (lazy, CSP)');
  ok(FILE + ' exists', !!SRC);
  const T0 = mount({ role: 'company_admin', companyId: 'co-a' }, { paymentTerms: { lateGraceDays: '"><img src=x>' } }, { nbd: false });
  T0.W.switchSettingsTab('company');
  const walk = (el, fn) => { fn(el); (el.children || []).forEach((c) => c.attrs && walk(c, fn)); };
  let bad = 0, nodes = 0, imgs = 0;
  if (T0.panel()) walk(T0.panel(), (el) => { nodes++; if (el.tagName === 'IMG') imgs++; Object.keys(el.attrs).forEach((k) => { if (/^on/i.test(k) || k === 'style') bad++; }); });
  ok('the panel paints (' + nodes + ' elements); no inline handler, no style attribute on any of them', nodes > 20 && bad === 0);
  ok('every value is escaped (a hostile saved value is not markup); the stylesheet loads lazily from the file', imgs === 0 && (T0.W.loads || []).some((u) => u === 'css/payment-terms-settings.css?v=1'));
  ok('painting it reads no flag (NBDFlags never touched) and writes nothing', T0.saves.length === 0 && T0.W.flagTouched !== true);
  ok('loaded lazily from the tenantsettings bundle file (tenant-account-ui.js), never at boot or by a tag',
    /ScriptLoader\.load\('js\/payment-terms-settings\.js\?v=\d+'\)/.test(read('docs/pro/js/tenant-account-ui.js'))
    && !/payment-terms-settings/.test(read('docs/pro/js/script-loader.js') + read('docs/pro/dashboard.html')));
  const tv = /'js\/tenant-account-ui\.js\?v=(\d+)'/.exec(read('docs/pro/js/script-loader.js'));
  ok('tenant-account-ui.js version bumped well above 2 (' + (tv && tv[1]) + ')', !!tv && Number(tv[1]) >= 8);
  const css = read('docs/pro/css/payment-terms-settings.css');
  ok('44px controls, nothing under 11px, no motion', /min-height: 44px/.test(css) && !/font-size:\s*(?:[0-9]|10)(?:\.\d+)?px|transition|animation/.test(css));

  console.log('\n2. bounds equal numOk (clause-set.js) at every edge');
  ok('exports the logic', !!PT && ['FIELDS', 'parse', 'collect', 'gateStatus', 'fromCents'].every((k) => PT[k] !== undefined));
  if (PT) {
    ok('one input spec per payment term, in the profile order', J(PT.FIELDS.map((f) => f.key)) === J(KEYS), J(PT.FIELDS.map((f) => f.key)));
    let allSame = true, why = '';
    PT.FIELDS.forEach((f) => {
      const dollars = f.unit === 'dollars';
      const probe = (n, kind) => {
        const raw = dollars ? (n / 100).toFixed(2) : String(n);
        const r = PT.parse(f.key, raw);
        const want = CS.numOk(n, f.key);
        if (r.ok !== want) { allSame = false; why += f.key + ' ' + kind + ' ' + raw + ' parse=' + r.ok + ' numOk=' + want + '; '; }
        if (r.ok && r.value !== n) { allSame = false; why += f.key + ' value ' + r.value + '!=' + n + '; '; }
      };
      const b = f.bounds;   // [min, max] in stored units (the hint text); numOk is the authority
      [b[0], b[1], b[0] - 1, b[1] + 1].forEach((n) => { if (n >= 0) probe(n, 'edge'); });
      if (f.int) ok(f.key + ': a fraction is refused (integer field)', !PT.parse(f.key, dollars ? '1.005' : '1.5').ok);
    });
    ok('every field: min, max, just under, just over agree with numOk', allSame, why);
    ok('percent 0-100 and card fee 0-10', PT.parse('lateInterestPct', '100').ok && !PT.parse('lateInterestPct', '100.01').ok
      && PT.parse('cardFeePct', '10').ok && !PT.parse('cardFeePct', '10.5').ok && PT.parse('cardFeePct', '0').ok);
    ok('days are integers 0-365; attic check days start at 1', PT.parse('disputeDays', '365').ok && !PT.parse('disputeDays', '366').ok
      && !PT.parse('disputeDays', '2.5').ok && PT.parse('lateGraceDays', '0').ok && !PT.parse('atticFreeCheckDays', '0').ok && PT.parse('atticFreeCheckDays', '1').ok);
    ok('decking sheets 1-200', !PT.parse('deckingSheetsBeforeChangeOrder', '0').ok && PT.parse('deckingSheetsBeforeChangeOrder', '200').ok && !PT.parse('deckingSheetsBeforeChangeOrder', '201').ok);
    ok('junk is refused: letters, negatives, exponent, hex, two dots; a blank is "not set", not an error',
      ['abc', '-1', '1e2', '0x10', '1.2.3', '--', 'NaN', 'Infinity'].every((s) => !PT.parse('lateGraceDays', s).ok && !PT.parse('lateGraceDays', s).blank)
      && PT.parse('lateGraceDays', '  ').blank === true && PT.parse('lateGraceDays', '').blank === true);
    ok('a refused value carries a plain message naming the range', /0.*365/.test(PT.parse('disputeDays', '400').error || ''), PT.parse('disputeDays', '400').error);

    console.log('\n3. dollars are shown, cents are stored');
    ok('$100 -> 10000 cents', PT.parse('deckingPerSheetCents', '100').value === 10000);
    ok('"$100.00" and "1,000" are read', PT.parse('deckingPerSheetCents', '$100.00').value === 10000 && PT.parse('deckingPerSheetCents', '1,000').value === 100000);
    ok('$0.01 -> 1 cent; $1000 is the top, $1000.01 is over', PT.parse('deckingPerSheetCents', '0.01').value === 1 && PT.parse('deckingPerSheetCents', '1000').ok && !PT.parse('deckingPerSheetCents', '1000.01').ok);
    ok('$99.995 is REFUSED (rule: at most two decimals, no silent rounding of money)', !PT.parse('deckingPerSheetCents', '99.995').ok && /cent/i.test(PT.parse('deckingPerSheetCents', '99.995').error || ''), J(PT.parse('deckingPerSheetCents', '99.995')));
    ok('$19.99 -> 1999 exactly (19.99*100 is 1998.9999999999998 in floats)', PT.parse('deckingPerSheetCents', '19.99').value === 1999);
    ok('fromCents shows dollars: 10000 -> "100.00", 1999 -> "19.99", null -> ""', PT.fromCents(10000) === '100.00' && PT.fromCents(1999) === '19.99' && PT.fromCents(null) === '');
    ok('a percent keeps its decimals: 1.5 is read, a third decimal is refused', PT.parse('lateInterestPct', '1.5').value === 1.5 && !PT.parse('lateInterestPct', '1.555').ok);

    console.log('\n4. readiness equals the send gate\'s missing list');
    const emptyR = PT.gateStatus({}, false, CS);
    ok('empty tenant: not ready, missing === the gate\'s list', !emptyR.ready && J(emptyR.missing) === J(gateMissing({}, false)) && emptyR.missing.length > 0, J(emptyR.missing) + ' vs ' + J(gateMissing({}, false)));
    const nbdR = PT.gateStatus({}, true, CS);
    ok('NBD defaults: missing === the gate\'s list (decking per sheet is unset in the defaults)', J(nbdR.missing) === J(gateMissing({}, true)) && nbdR.missing.includes('deckingPerSheetCents'), J(nbdR.missing));
    const full = { lateGraceDays: 15, lateInterestPct: 8, disputeDays: 10, finalPaymentDays: 7, punchListDays: 3, pauseNoticeDays: 5, restockPct: 15, cardFeePct: 0, deckingPerSheetCents: 10000, deckingSheetsBeforeChangeOrder: 10, atticFreeCheckDays: 3, claimNoticeDays: 30 };
    const fullR = PT.gateStatus(full, false, CS);
    ok('all twelve set: ready, nothing missing, gate agrees', fullR.ready && fullR.missing.length === 0 && gateMissing(full, false).length === 0);
    ok('card fee 0 is a valid "off", never missing', !PT.gateStatus({}, false, CS).missing.includes('cardFeePct') && !gateMissing({}, false).includes('cardFeePct'));
    const one = Object.assign({}, full); delete one.claimNoticeDays;
    ok('one unset: the line names it, as the gate does', J(PT.gateStatus(one, false, CS).missing) === J(['claimNoticeDays']) && J(gateMissing(one, false)) === J(['claimNoticeDays']));
    const zero = Object.assign({}, full, { deckingPerSheetCents: 0 });
    ok('a decking price of 0 is not ready (the gate refuses it)', PT.gateStatus(zero, false, CS).missing.includes('deckingPerSheetCents') && gateMissing(zero, false).includes('deckingPerSheetCents'));
    ok('the line text', fullR.line === 'Ready: new contracts can be sent' && /^Not ready: set /.test(emptyR.line), fullR.line + ' | ' + emptyR.line);
    ok('attic check days is flagged on its own (the attic forms need it, contracts do not)',
      !emptyR.missing.includes('atticFreeCheckDays') && emptyR.atticMissing === true && fullR.atticMissing === false);
    ok('readiness follows clause-set.js: a stubbed renderV1 moves the line with it (no second detector)', (() => { const fake = Object.assign({}, CS, { renderV1: () => ({ missing: ['claimNoticeDays'] }) }); return J(PT.gateStatus(full, false, fake).missing) === J(['claimNoticeDays']); })());

    console.log('\n5. collect: only valid values, only what is filled');
    const good = PT.collect({ lateGraceDays: '15', deckingPerSheetCents: '100', cardFeePct: '0', claimNoticeDays: '' });
    ok('valid values become numbers, dollars become cents, blanks are left out', good.ok && J(good.terms) === J({ lateGraceDays: 15, cardFeePct: 0, deckingPerSheetCents: 10000 }), J(good));
    const bad = PT.collect({ lateGraceDays: '999', cardFeePct: '12', disputeDays: '5' });
    ok('any bad value refuses the whole save and names each field', !bad.ok && J(Object.keys(bad.errors).sort()) === J(['cardFeePct', 'lateGraceDays']), J(bad));
  }

  console.log('\n6. the owner\'s panel');
  if (SRC) {
    const T = mount({ role: 'company_admin', companyId: 'co-a' }, { paymentTerms: { lateGraceDays: 15, deckingPerSheetCents: 10000 } }, { nbd: false });
    T.W.switchSettingsTab('company');
    const p = T.panel();
    ok('a Payment terms panel appears in Settings under the Letterhead panel', !!p && p.parentNode === T.document.getElementById('lh').parentNode, p && text(p));
    ok('one labelled input per field, twelve of them, enabled', KEYS.every((k) => !!inp(p, k) && !!p.querySelector('label[for="pt_' + k + '"]') && !inp(p, k).hasAttribute('disabled')));
    ok('units are shown (%, days, $ per sheet, sheets)', /%/.test(text(p)) && /days/i.test(text(p)) && /\$/.test(text(p)) && /sheets/i.test(text(p)));
    ok('stored cents show as dollars: 10000 -> 100.00; stored days show as typed', got(p, 'deckingPerSheetCents') === '100.00' && got(p, 'lateGraceDays') === '15', got(p, 'deckingPerSheetCents'));
    ok('a non-NBD tenant with nothing saved starts blank (no NBD number shown)', (() => {
      const B = mount({ role: 'company_admin', companyId: 'co-a' }, {}, { nbd: false }); B.W.switchSettingsTab('company');
      return KEYS.every((k) => got(B.panel(), k) === '');
    })());
    const rl = p.querySelector('[data-ptset="ready"]');
    ok('the readiness line is first in the panel and says Not ready', /^Not ready: set /.test(text(rl)) && rl === p.querySelector('.panel-body').children[0], text(rl));
    ok('the card fee note: 0 means no card fee is charged yet', /0 .*no card fee/i.test(text(p)), text(p).slice(0, 300));
    fill(p, { lateGraceDays: 20, lateInterestPct: 8, disputeDays: 10, finalPaymentDays: 7, punchListDays: 3, pauseNoticeDays: 5, restockPct: 15, cardFeePct: 0, deckingPerSheetCents: '100', deckingSheetsBeforeChangeOrder: 10, atticFreeCheckDays: 3, claimNoticeDays: 30 });
    click(T.dom, p.querySelector('button[data-ptset="save"]'));
    await tick();
    ok('Save writes ONLY paymentTerms (numbers; decking in cents) through the existing writer', J(T.saves) === J([{ paymentTerms: { lateGraceDays: 20, lateInterestPct: 8, disputeDays: 10, finalPaymentDays: 7, punchListDays: 3, pauseNoticeDays: 5, restockPct: 15, cardFeePct: 0, deckingPerSheetCents: 10000, deckingSheetsBeforeChangeOrder: 10, atticFreeCheckDays: 3, claimNoticeDays: 30 } }]), J(T.saves));
    ok('a success toast', (T.W.toasts || []).some((t) => t[1] === 'success'), J(T.W.toasts));
  }
  if (SRC) {
    const T = mount({ role: 'company_admin', companyId: 'co-a' }, {}, { nbd: false });
    T.W.switchSettingsTab('company'); const p = T.panel();
    fill(p, { lateGraceDays: 400, cardFeePct: 11, deckingPerSheetCents: '99.995', atticFreeCheckDays: 0 });
    click(T.dom, p.querySelector('button[data-ptset="save"]'));
    await tick();
    ok('out-of-range values: nothing is written', T.saves.length === 0, J(T.saves));
    ok('each bad field shows an inline message and aria-invalid', ['lateGraceDays', 'cardFeePct', 'deckingPerSheetCents', 'atticFreeCheckDays'].every((k) => inp(p, k).getAttribute('aria-invalid') === 'true' && !!p.querySelector('#pt_' + k + '_err') && text(p.querySelector('#pt_' + k + '_err')).length > 3));
    ok('an error toast says nothing was saved', (T.W.toasts || []).some((t) => t[1] === 'error'), J(T.W.toasts));
    fill(p, { lateGraceDays: 10 });
    H.fire(T.dom, inp(p, 'lateGraceDays'), 'input');
    ok('typing a good value clears that field\'s message live', inp(p, 'lateGraceDays').getAttribute('aria-invalid') !== 'true' && text(p.querySelector('#pt_lateGraceDays_err')) === '');
  }
  if (SRC) {
    const T = mount({ role: 'company_admin', companyId: 'co-a' }, {}, { nbd: false, saveFails: true });
    T.W.switchSettingsTab('company'); const p = T.panel();
    fill(p, { lateGraceDays: 15 });
    click(T.dom, p.querySelector('button[data-ptset="save"]'));
    await tick(); await tick();
    ok('a failed write says so', (T.W.toasts || []).some((t) => t[1] === 'error' && /not saved/i.test(t[0])), J(T.W.toasts));
  }
  if (SRC) {
    const T = mount({}, { paymentTerms: {} }, { uid: 'solo', nbd: false });
    T.W.switchSettingsTab('company'); const p = T.panel();
    ok('a solo owner (no claims) can edit', !!p && !inp(p, 'lateGraceDays').hasAttribute('disabled') && !!p.querySelector('button[data-ptset="save"]'));
  }

  console.log('\n7. reps read it');
  for (const role of ['sales_rep', 'manager', 'viewer']) {
    if (!SRC) break;
    const T = mount({ role, companyId: 'co-a' }, { paymentTerms: { lateGraceDays: 15 } }, { uid: 'u2', nbd: false });
    T.W.switchSettingsTab('company'); const p = T.panel();
    ok(role + ': inputs disabled, no Save, still sees readiness and the numbers', !!p && KEYS.every((k) => inp(p, k).hasAttribute('disabled')) && !p.querySelector('button[data-ptset="save"]')
      && /Not ready/.test(text(p)) && got(p, 'lateGraceDays') === '15' && /owner|admin/i.test(text(p)), p && text(p).slice(0, 160));
    click(T.dom, p);
    ok(role + ': nothing can be written', T.saves.length === 0);
  }

  console.log('\n8. NBD tenant and the flag');
  if (SRC) {
    const nbdTerms = { lateGraceDays: 15, lateInterestPct: 8, disputeDays: 10, finalPaymentDays: 7, punchListDays: 3, pauseNoticeDays: 5, restockPct: 15, cardFeePct: 0, deckingSheetsBeforeChangeOrder: 10, atticFreeCheckDays: 3, claimNoticeDays: 30 };
    const T = mount({ role: 'company_admin', companyId: 'co-a' }, { paymentTerms: nbdTerms }, { nbd: true });
    T.W.switchSettingsTab('company'); const p = T.panel();
    ok('NBD with defaults: the line names only the decking price',
      /^Not ready: set /.test(text(p.querySelector('[data-ptset="ready"]'))) && /decking/i.test(text(p.querySelector('[data-ptset="ready"]'))), text(p.querySelector('[data-ptset="ready"]')));
    const T2 = mount({ role: 'company_admin', companyId: 'co-a' }, { paymentTerms: Object.assign({}, nbdTerms, { deckingPerSheetCents: 10000 }) }, { nbd: false });
    T2.W.switchSettingsTab('company');
    ok('all set: "Ready: new contracts can be sent"', text(T2.panel().querySelector('[data-ptset="ready"]')) === 'Ready: new contracts can be sent', text(T2.panel().querySelector('[data-ptset="ready"]')));
    T2.W._companyProfile = { paymentTerms: {} };
    T2.W.switchSettingsTab('company');
    ok('the line repaints from the profile on the next paint', /^Not ready/.test(text(T2.panel().querySelector('[data-ptset="ready"]'))));
    ok('opening the tab again does not add a second panel', T2.document.querySelectorAll('[data-ptset="panel"]').length === 1);
  }
  ok('registered in tests/ci-manifest.json', JSON.stringify(JSON.parse(read('tests/ci-manifest.json'))).includes('payment-terms-settings-2026-11-18.test.js'));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
