/**
 * tests/nbd-os-team-timezone-2026-11-09.test.js - NBD OS P2 "Team": the
 * company time zone (companyProfile.timeZone).
 *
 * Settings > Company Profile gets a "Time zone" panel under Letterhead
 * (docs/pro/js/company-timezone-settings.js, in the lazy `tenantsettings`
 * ScriptLoader bundle Settings already loads; no new <script> tag, no markup in
 * dashboard.html). The owner or a company_admin picks an IANA zone, validated
 * against Intl.supportedValuesOf('timeZone') when the browser has it, else a
 * fixed list; anyone else sees the zone, read only. Saving goes through the
 * existing writer (window._saveCompanyProfile) and keeps the older lowercase
 * `timezone` (Bots & API) in step when the doc has one, so every reader agrees.
 * firestore.rules bounds the field to a string of at most 64 chars
 * (tests/firestore-rules.os-team.test.js).
 *
 * Run: node tests/nbd-os-team-timezone-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeDom, click, text } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const FILE = 'docs/pro/js/company-timezone-settings.js';
const SRC = read(FILE);
const tick = () => new Promise((r) => setImmediate(r));
let TZ = null;
try { TZ = require(path.join(ROOT, FILE)); } catch (e) { TZ = null; }

/** Settings with a Letterhead panel, the file loaded, claims as given. */
function mount(claims, profile, opts) {
  const o = opts || {};
  const dom = makeDom();
  const { document } = dom;
  const view = document.createElement('div');
  view.setAttribute('id', 'view-settings');
  view.innerHTML = '<div class="panel mb-md" id="lh"><div class="panel-body"><input type="text" id="cp_businessLicense"></div></div><div class="panel mb-md" id="legal"></div>';
  document.body.appendChild(view);
  const saves = [];
  const W = {
    document, console: { log() {}, warn() {}, error() {} },
    Intl: o.intl === undefined ? Intl : o.intl,
    _userClaims: claims, _user: { uid: o.uid || 'co-a' },
    _companyProfile: profile,
    _saveCompanyProfile: (p) => { saves.push(JSON.parse(JSON.stringify(p))); if (o.saveFails) return Promise.reject(new Error('nope')); W._companyProfile = Object.assign({}, W._companyProfile, p); return Promise.resolve(); },
    showToast: (m, k) => { (W.toasts = W.toasts || []).push([String(m), k]); },
    switchSettingsTab: (t) => { W.tabs = (W.tabs || []).concat([t]); },
    addEventListener() {}, setTimeout: (f) => { f(); return 1; },
  };
  const ctx = vm.createContext(W);
  ctx.window = ctx;
  vm.runInContext(SRC, ctx, { filename: FILE });
  return { W: ctx, dom, document, saves, panel: () => document.querySelector('[data-cotz]') };
}

(async () => {
  console.log('\n1. the file and how it loads');
  ok(FILE + ' exists', !!SRC);
  const SL = read('docs/pro/js/script-loader.js');
  const bundle = /tenantsettings:\s*\[([\s\S]*?)\]/.exec(SL);
  ok('it rides the lazy tenantsettings bundle Settings already loads: tenant-account-ui.js (in that bundle) loads it at runtime',
    !!bundle && /'js\/tenant-account-ui\.js\?v=\d+'/.test(bundle[1])
    && /ScriptLoader\.load\('js\/company-timezone-settings\.js\?v=\d+'\)/.test(read('docs/pro/js/tenant-account-ui.js')), bundle && bundle[1]);
  ok('script-loader.js (blocking, at its ceiling) does not grow for it', !/company-timezone-settings/.test(SL));
  ok('no <script> tag for it in dashboard.html', !/company-timezone-settings/.test(read('docs/pro/dashboard.html')));
  const code = H.noComments(SRC);
  ok('no style attribute, no inline handler, no el.style', !/style="|style=\\"|\son[a-z]+=|\.style\b/.test(code));
  const CSS = read('docs/pro/css/company-timezone-settings.css');
  ok('its stylesheet loads lazily from the file (ScriptLoader.load), 44px field and button, no text under 11px, no motion',
    /ScriptLoader\.load\('css\/company-timezone-settings\.css\?v=\d+'\)/.test(SRC) && /\.cotz-select[^}]*min-height: 44px/.test(CSS) && /\.cotz-save \{ min-height: 44px; \}/.test(CSS)
    && !/font-size:\s*(?:[0-9]|10)(?:\.\d+)?px/.test(CSS) && !/transition|animation/.test(CSS));
  ok('every interpolated value is escaped (esc)', /function esc\(/.test(SRC) && !/\+\s*z\s*\+/.test(code));

  console.log('\n2. the zone list and the check');
  ok('exports NBDCompanyTimeZone logic (zones, valid, current, saveFields)', !!TZ && ['zones', 'valid', 'current', 'saveFields'].every((k) => typeof TZ[k] === 'function'));
  if (TZ) {
    const intl = Intl;
    ok('with Intl.supportedValuesOf: every IANA zone the browser knows, plus UTC', TZ.zones(intl).indexOf('America/Chicago') !== -1 && TZ.zones(intl).indexOf('Europe/Paris') !== -1 && TZ.zones(intl).indexOf('UTC') !== -1);
    ok('a zone the list names by its other spelling (Asia/Kolkata = Asia/Calcutta) is valid too', TZ.valid('Asia/Kolkata', intl) && TZ.valid('Asia/Calcutta', intl));
    ok('a real zone is valid; junk, a near-miss and 65 chars are not', TZ.valid('America/Denver', intl) && !TZ.valid('America/Atlantis', intl) && !TZ.valid('america/denver', intl) && !TZ.valid('A'.repeat(65), intl) && !TZ.valid(7, intl));
    const old = { DateTimeFormat: Intl.DateTimeFormat };   // a browser without supportedValuesOf
    ok('without supportedValuesOf: the fixed list (the US zones and UTC)', TZ.zones(old).indexOf('America/New_York') !== -1 && TZ.zones(old).indexOf('Pacific/Honolulu') !== -1 && TZ.zones(old).indexOf('UTC') !== -1 && TZ.zones(old).length < 40, J(TZ.zones(old)));
    ok('and a zone off that list is refused there', TZ.valid('America/Chicago', old) && !TZ.valid('Asia/Kolkata', old));
    ok('the current zone: timeZone, else the older timezone, else none (no default is claimed)', TZ.current({ timeZone: 'America/Chicago' }, intl) === 'America/Chicago'
      && TZ.current({ timezone: 'America/Denver' }, intl) === 'America/Denver' && TZ.current({}, intl) === '' && TZ.current({ timeZone: 'Nope/Zone' }, intl) === '');
    ok('saving writes timeZone', J(TZ.saveFields({}, 'America/Chicago')) === J({ timeZone: 'America/Chicago' }));
    ok('and keeps an older lowercase timezone in step', J(TZ.saveFields({ timezone: 'America/Denver' }, 'America/Chicago')) === J({ timeZone: 'America/Chicago', timezone: 'America/Chicago' }));
  }

  console.log('\n3. the owner\'s panel');
  if (SRC) {
    const T = mount({ role: 'company_admin', companyId: 'co-a' }, { timeZone: 'America/Chicago' });
    T.W.switchSettingsTab('company');
    const p = T.panel();
    ok('a Time zone panel appears in Settings, in the Letterhead panel\'s column', !!p && p.parentNode === T.document.getElementById('lh').parentNode, p && text(p));
    const sel = p && p.querySelector('select#cp_timeZone');
    ok('a labelled native select of zones, the saved one selected', !!sel && !!p.querySelector('label[for="cp_timeZone"]') && !!sel.querySelector('option[value="America/Chicago"][selected]'));
    ok('a Save button, enabled', !!p.querySelector('button[data-cotz="save"]') && !p.querySelector('button[data-cotz="save"]').hasAttribute('disabled'));
    ok('it says what the zone is for', /today|leaderboard|team/i.test(text(p)));
    sel.value = 'America/Denver';
    click(T.dom, p.querySelector('button[data-cotz="save"]'));
    await tick();
    ok('Save goes through the existing writer with { timeZone }', J(T.saves) === J([{ timeZone: 'America/Denver' }]), J(T.saves));
    ok('a success toast', (T.W.toasts || []).some((t) => /time zone/i.test(t[0]) && t[1] === 'success'), J(T.W.toasts));
    sel.value = 'America/Atlantis';
    click(T.dom, p.querySelector('button[data-cotz="save"]'));
    await tick();
    ok('a zone that is not real is refused, nothing written', T.saves.length === 1 && (T.W.toasts || []).some((t) => t[1] === 'error'), J(T.W.toasts));
    T.W.switchSettingsTab('company');
    ok('opening the tab again does not add a second panel', T.document.querySelectorAll('[data-cotz]').filter((n) => n.tagName === 'DIV' && n.classList.contains('panel')).length === 1);
  }
  if (SRC) {
    const T = mount({ role: 'company_admin', companyId: 'co-a' }, { timezone: 'America/Denver' });
    T.W.switchSettingsTab('company');
    const p = T.panel(); const sel = p.querySelector('select#cp_timeZone');
    sel.value = 'America/Chicago';
    click(T.dom, p.querySelector('button[data-cotz="save"]'));
    await tick();
    ok('a doc with the older lowercase timezone gets both written, the same value', J(T.saves) === J([{ timeZone: 'America/Chicago', timezone: 'America/Chicago' }]), J(T.saves));
  }
  if (SRC) {
    const T = mount({}, {}, { uid: 'solo' });
    T.W.switchSettingsTab('company');
    const p = T.panel();
    ok('a solo owner (no claims) can set it; with none saved the picker asks', !!p && !p.querySelector('button[data-cotz="save"]').hasAttribute('disabled') && /not set|choose|pick/i.test(text(p)), p && text(p));
    ok('nothing pre-selected when none is saved (no zone is claimed for them)', p && !p.querySelector('option[selected][value]'));
  }
  if (SRC) {
    const T = mount({ role: 'company_admin', companyId: 'co-a' }, { timeZone: 'America/Chicago' }, { saveFails: true });
    T.W.switchSettingsTab('company');
    const p = T.panel(); p.querySelector('select#cp_timeZone').value = 'America/Denver';
    click(T.dom, p.querySelector('button[data-cotz="save"]'));
    await tick(); await tick();
    ok('a failed save says so', (T.W.toasts || []).some((t) => t[1] === 'error' && /time zone/i.test(t[0])), J(T.W.toasts));
  }

  console.log('\n4. everyone else reads it');
  for (const role of ['sales_rep', 'manager', 'viewer']) {
    if (!SRC) break;
    const T = mount({ role, companyId: 'co-a' }, { timeZone: 'America/Chicago' }, { uid: 'u2' });
    T.W.switchSettingsTab('company');
    const p = T.panel();
    ok(role + ': sees the zone, read only (disabled select, no Save)', !!p && p.querySelector('select#cp_timeZone').hasAttribute('disabled') && !p.querySelector('button[data-cotz="save"]') && /owner|admin/i.test(text(p)), p && text(p));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
