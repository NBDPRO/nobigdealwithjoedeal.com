/**
 * tests/sms-compliance-settings-ui-2026-10-05.test.js
 *
 * The CRM side of the texting-compliance work (2026-10-05):
 * docs/pro/js/sms-compliance-settings.js renders Settings → AI Texting →
 * "Texting rules": the company's texting switch, or "Texting needs
 * registration — coming soon" for a company without its own registration,
 * and the company's Do Not Text list with add / remove.
 *
 * Runs the REAL file in a vm against a stub window/document and drives it
 * through its delegated listeners and the manageSmsCompliance callable stub:
 *   A. wiring: dashboard.html mounts it in the AI Texting tab and loads it
 *      with defer; no inline handlers or style attributes (CSP + ratchet).
 *   B. an unregistered company sees "needs registration — coming soon" and
 *      no switch; NBD's owner sees the switch, a rep sees it disabled.
 *   C. the list: STOP-reply entries texted to the line can never be lifted
 *      from here, manual ones can (owner / company_admin only), a viewer gets
 *      no add form, and every value is escaped. (Lift sheet + reason:
 *      tests/sms-lift-stop-2026-10-07.test.js.)
 *   D. actions call the callable with the right payloads; a bad number never
 *      reaches it; turning texting off asks first.
 *
 * Zero deps. Run: node tests/sms-compliance-settings-ui-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'docs/pro/js/sms-compliance-settings.js');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const flush = () => new Promise((r) => setImmediate(r));

function load(opts) {
  const o = opts || {};
  const calls = [];
  const toasts = [];
  const listeners = {};
  const mount = { innerHTML: '', id: 'smsComplianceMount' };
  const elements = {
    smsComplianceMount: mount,
    sccPhone: { value: o.phone || '', focus() {} },
    sccNote: { value: o.note || '' },
    'stab-panel-ai-texting': { style: { display: 'none' } },
  };
  const responses = Object.assign({
    getSettings: { allowed: true, reason: null, registered: true, enabled: true, needsRegistration: false },
    listDnc: { entries: [] },
    addDnc: { ok: true, created: true },
    liftDnc: { ok: true, result: 'lifted', stillBlocked: null },
    setEnabled: { ok: true, allowed: false },
  }, o.responses || {});
  const win = {
    _userClaims: o.claims || {},
    _user: { uid: o.uid || 'joe' },
    _functions: {},
    _httpsCallable: (_f, name) => async (payload) => {
      calls.push([name, payload]);
      return { data: responses[payload.action] };
    },
    showToast: (m, k) => toasts.push([k, String(m)]),
    nbdConfirm: async () => (o.confirm !== false),
    switchSettingsTab: function () {},
    console,
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, String, Object, Array, JSON, Math, Number,
  };
  const document = {
    readyState: 'complete',
    getElementById: (id) => elements[id] || null,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  };
  win.document = document;
  win.window = win;
  const src = fs.readFileSync(SRC_PATH, 'utf8');
  vm.runInNewContext(src, Object.assign(win, { document, window: win }));
  return { win, mount, calls, toasts, listeners, elements };
}

/** A fake click target matching `#smsComplianceMount [data-scc-action]`. */
function target(attrs) {
  const el = {
    disabled: false,
    getAttribute: (k) => (attrs[k] == null ? null : attrs[k]),
    closest: (sel) => (/data-scc-action/.test(sel) ? el : null),
    matches: (sel) => /data-scc-change="enabled"/.test(sel) && attrs['data-scc-change'] === 'enabled',
    checked: attrs.checked,
  };
  return el;
}

(async () => {
  // ═══ A. wiring ═════════════════════════════════════════════════════════
  console.log('A. wiring');
  const dash = fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8');
  const src = fs.existsSync(SRC_PATH) ? fs.readFileSync(SRC_PATH, 'utf8') : '';
  ok('docs/pro/js/sms-compliance-settings.js exists', !!src);
  const tab = (dash.match(/<div class="stab-panel dn" id="stab-panel-ai-texting">([\s\S]*?)<\/div><!-- \/stab-panel-ai-texting -->/) || [])[1] || '';
  ok('the AI Texting settings tab carries #smsComplianceMount', /id="smsComplianceMount"/.test(tab));
  // Lazy, not a boot <script> (dashboard-boot-budget): the Settings bundle.
  const loader = fs.readFileSync(path.join(ROOT, 'docs/pro/js/script-loader.js'), 'utf8');
  ok('loaded lazily with the Settings bundle (tenantsettings), with a ?v=, not as a boot script tag',
    /tenantsettings: \[[^\]]*'js\/sms-compliance-settings\.js\?v=\d+'/.test(loader) && !/<script[^>]*sms-compliance-settings/.test(dash));
  ok('no inline on*= handlers and no style= attributes in the file', !/\son[a-z]+=/i.test(src) && !/style=/.test(src));
  if (!src) { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(1); }

  // ═══ B. switch / registration ══════════════════════════════════════════
  console.log('\nB. the switch, or "needs registration — coming soon"');
  {
    const h = load({ claims: { companyId: 'co-1', role: 'company_admin' }, uid: 'adm',
      responses: { getSettings: { allowed: false, reason: 'not_registered', registered: false, enabled: true, needsRegistration: true } } });
    await h.win.NBDSmsCompliance.load(); await flush();
    ok('an unregistered company sees "Texting needs registration — coming soon"', /Texting needs registration — coming soon/.test(h.mount.innerHTML), h.mount.innerHTML.slice(0, 200));
    ok('…and no switch to flip', !/data-scc-change="enabled"/.test(h.mount.innerHTML));
  }
  {
    const h = load({ claims: {}, uid: 'joe' });
    await h.win.NBDSmsCompliance.load(); await flush();
    ok('NBD\'s owner (solo, no role claim) sees the switch, enabled and on',
      /id="sccEnabled"[^>]*checked/.test(h.mount.innerHTML) && !/id="sccEnabled"[^>]*disabled/.test(h.mount.innerHTML), h.mount.innerHTML.slice(0, 600));
    ok('the copy says texts go 8am–9pm in the homeowner\'s time zone', /8am–9pm in the homeowner's time zone/.test(h.mount.innerHTML));
  }
  {
    const h = load({ claims: { companyId: 'nbd', role: 'sales_rep' }, uid: 'rep' });
    await h.win.NBDSmsCompliance.load(); await flush();
    ok('a sales rep sees the switch disabled, with who can change it', /id="sccEnabled"[^>]*disabled/.test(h.mount.innerHTML) && /Only the owner or a company admin/.test(h.mount.innerHTML));
  }

  // ═══ C. the list ═══════════════════════════════════════════════════════
  console.log('\nC. the Do Not Text list');
  const ENTRIES = [
    { key: '8595550134', phone: '859-555-0134', source: 'stop_reply', addedAtMs: 1 },
    { key: '5135550123', phone: '513-555-0123', source: 'manual', note: '<img src=x onerror=alert(1)>', addedAtMs: 2 },
  ];
  {
    const h = load({ claims: {}, uid: 'joe', responses: { listDnc: { entries: ENTRIES } } });
    await h.win.NBDSmsCompliance.load(); await flush();
    const html = h.mount.innerHTML;
    ok('both numbers listed, formatted', /\(859\) 555-0134/.test(html) && /\(513\) 555-0123/.test(html));
    ok('the STOP-reply entry says only their START lifts it — and has NO lift button',
      /Opted out by text — only their START reply lifts it/.test(html) && !/data-scc-phone="8595550134"/.test(html));
    ok('the manual entry has a Lift button for the owner', /data-scc-action="lift" data-scc-phone="5135550123"/.test(html));
    ok('a note is escaped (no live markup from a typed note)', !/<img src=x/.test(html) && /&lt;img src=x/.test(html));
    ok('an add form for the owner', /id="sccPhone"/.test(html) && /data-scc-action="add"/.test(html));
  }
  {
    const h = load({ claims: { companyId: 'co-1', role: 'sales_rep' }, uid: 'rep', responses: { listDnc: { entries: ENTRIES } } });
    await h.win.NBDSmsCompliance.load(); await flush();
    ok('a sales rep can add but sees no lift button', /data-scc-action="add"/.test(h.mount.innerHTML) && !/data-scc-action="lift"/.test(h.mount.innerHTML));
  }
  {
    const h = load({ claims: { companyId: 'co-1', role: 'viewer' }, uid: 'v', responses: { listDnc: { entries: ENTRIES } } });
    await h.win.NBDSmsCompliance.load(); await flush();
    ok('a viewer sees the list but no add form and no lift', !/id="sccPhone"/.test(h.mount.innerHTML) && !/data-scc-action="lift"/.test(h.mount.innerHTML) && /\(859\) 555-0134/.test(h.mount.innerHTML));
  }

  // ═══ D. actions ════════════════════════════════════════════════════════
  console.log('\nD. actions reach the callable');
  const click = async (h, attrs) => { for (const fn of h.listeners.click || []) fn({ target: target(attrs) }); await flush(); await flush(); };
  const change = async (h, attrs) => { for (const fn of h.listeners.change || []) await fn({ target: target(attrs) }); await flush(); };
  {
    const h = load({ claims: {}, uid: 'joe', phone: '(513) 555-0123', note: 'asked at the door' });
    await click(h, { 'data-scc-action': 'add' });
    const add = h.calls.find((c) => c[1].action === 'addDnc');
    ok('Add → manageSmsCompliance { action: addDnc, phone, note }', !!add && add[0] === 'manageSmsCompliance' && add[1].phone === '(513) 555-0123' && add[1].note === 'asked at the door', JSON.stringify(h.calls));
  }
  {
    const h = load({ claims: {}, uid: 'joe', phone: '555-0123' });
    await click(h, { 'data-scc-action': 'add' });
    ok('a number that is not 10 digits never reaches the callable', !h.calls.some((c) => c[1].action === 'addDnc') && h.toasts.some(([k]) => k === 'error'));
  }
  {
    const h = load({ claims: {}, uid: 'joe', confirm: false });
    await change(h, { 'data-scc-change': 'enabled', checked: false });
    ok('turning texting OFF asks first — declined, nothing is saved', !h.calls.some((c) => c[1].action === 'setEnabled'));
  }
  {
    const h = load({ claims: {}, uid: 'joe' });
    await change(h, { 'data-scc-change': 'enabled', checked: false });
    ok('confirmed → { action: setEnabled, enabled: false }', h.calls.some((c) => c[1].action === 'setEnabled' && c[1].enabled === false), JSON.stringify(h.calls));
  }
  {
    const h = load({ claims: {}, uid: 'joe' });
    let loaded = 0;
    const orig = h.win.NBDSmsCompliance.load;
    h.win.switchSettingsTab('ai-texting'); await flush(); await flush();
    loaded = h.calls.filter((c) => c[1].action === 'getSettings').length;
    ok('opening the AI Texting tab loads the panel (switchSettingsTab is wrapped)', loaded === 1 && typeof orig === 'function', 'loads=' + loaded);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
