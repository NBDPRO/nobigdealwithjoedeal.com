/**
 * tests/lazy-customer-jobs-add-2026-11-08.test.js — the "＋ Add job" sheet
 * leaves the customer page's boot path; the Jobs panel stays on it
 * (boot-weight lane, batch 4b, 2026-11-08).
 *
 * A whole-file move of customer-jobs.js was declined earlier the same day: it
 * polls every 1 s from boot and, once the lead and NBDJobs are ready, paints
 * #jobsPanel before #checklistPanel in the default Overview tab on every
 * card. So the file is SPLIT. customer-jobs.js keeps the panel (its markup,
 * timing and data unchanged). The add sheet, its form check and the save,
 * which run only after a tap on "＋ Add job" or the #addJob deep link, move to
 * js/customer-jobs-add.js: the ScriptLoader bundle `customerjobsadd`,
 * registered at runtime by customer-jobs.js (script-loader.js is blocking and
 * at its byte ceiling, so it is untouched). NBDCustomerJobs.openAdd is a
 * load-then-call stand-in.
 *
 * Pins, with the REAL script-loader.js in a vm and a fake page whose <head>
 * lists the tags appended to it and lets a tag remove() itself, as a browser
 * does:
 *   - the panel paints at boot, byte-identical to the pre-split markup, and
 *     nothing is fetched at boot;
 *   - a tap before the file lands opens the sheet once it lands; the sheet
 *     still checks the title, saves through NBDJobs.add and repaints the panel;
 *   - a failed fetch says so, throws nothing, and the next tap fetches again
 *     and works;
 *   - #addJob loads the sheet after the panel paints and opens it;
 *   - no ScriptLoader on the page: nothing throws, the panel still paints,
 *     the tap says why;
 *   - customer.html carries no tag for the sheet file; script-loader.js
 *     holds no customerjobsadd bundle.
 *
 * Run: node tests/lazy-customer-jobs-add-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}

const BOOT = read('docs/pro/js/customer-jobs.js');
const ADD_FILE = 'docs/pro/js/customer-jobs-add.js';
const ADD = exists(ADD_FILE) ? read(ADD_FILE) : '';
const LOADER = read('docs/pro/js/script-loader.js');
const CUSTOMER = read('docs/pro/customer.html');
const flush = async (n) => { for (let i = 0; i < (n || 6); i++) await new Promise((r) => setImmediate(r)); };

// The Jobs panel as the pre-split customer-jobs.js painted it for the page
// below (one job on the card, write access, costs not loaded yet).
const GOLDEN_PANEL = '<div class="panel-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><div class="panel-title" style="margin:0;">Jobs</div><button type="button" class="btn btn-orange" data-cj-add style="font-size:11px;padding:6px 12px;">＋ Add job</button></div><div class="cj-row" data-cj-job="j1" style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:9px 0;border-top:1px solid var(--br,rgba(255,255,255,.08));"><div style="min-width:0;"><div style="font-weight:700;font-size:13px;">Roof replacement</div><div style="font-size:11px;color:var(--m,#9ca3af);margin-top:2px;">Contacted · $9,000</div></div><span class="cj-badge" data-cj-standing="card" style="flex:none;font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px;border:1px solid var(--orange,#A14A22);color:var(--orange,#A14A22);white-space:nowrap;">On card</span></div>';

// ── a fake customer page ──────────────────────────────────────────────────
// Elements live in a tree (children) plus whatever their innerHTML names by
// id (inner); getElementById walks what is attached to the document.
function makePage(opts) {
  opts = opts || {};
  const head = [], appended = [], timeouts = [], intervals = [], toasts = [], adds = [], warns = [];
  let focused = null;
  function el(tag) {
    const e = {
      tagName: String(tag).toUpperCase(), id: '', attrs: {}, style: {}, listeners: {}, children: [], inner: [],
      parentNode: null, value: '', textContent: '', disabled: false, className: '', _html: '',
      setAttribute(n, v) { this.attrs[n] = String(v); if (n === 'id') this.id = String(v); },
      getAttribute(n) {
        if (n === 'src') return this.src == null ? null : this.src;
        if (n === 'href') return this.href == null ? null : this.href;
        return n in this.attrs ? this.attrs[n] : null;
      },
      hasAttribute(n) { return n in this.attrs; },
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      fire(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev)); },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
      insertBefore(c, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); c.parentNode = this; return c; },
      querySelector(sel) { const m = /^#(.+)$/.exec(sel); return m ? (walk([this]).find((x) => x.id === m[1] && x !== this) || null) : null; },
      closest(sel) { const m = /^\[([\w-]+)\]$/.exec(sel); return m && this.attrs[m[1]] !== undefined ? this : null; },
      focus() { focused = this.id; },
      get innerHTML() { return this._html; },
      set innerHTML(h) {
        this._html = String(h);
        this.inner = [];
        const re = /<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g;
        let m;
        while ((m = re.exec(this._html))) {
          const attrs = {};
          m[2].replace(/([\w-]+)(?:="([^"]*)")?/g, (_, k, v) => { attrs[k] = v == null ? '' : v; return ''; });
          if (!attrs.id && !Object.keys(attrs).some((k) => /^data-cj-/.test(k))) continue;
          const c = el(m[1]);
          Object.keys(attrs).forEach((k) => c.setAttribute(k, attrs[k]));
          c.parentNode = this;
          this.inner.push(c);
        }
      },
    };
    return e;
  }
  function walk(roots) {
    const out = [];
    (function go(list) { list.forEach((x) => { out.push(x); go(x.children); go(x.inner); }); })(roots);
    return out;
  }
  const body = el('body');
  const overview = el('div'); overview.setAttribute('id', 'overviewTab');
  const checklist = el('div'); checklist.setAttribute('id', 'checklistPanel');
  overview.appendChild(checklist);
  body.appendChild(overview);
  const document = {
    readyState: 'complete',
    baseURI: 'https://x.test/pro/customer.html',
    body,
    head: {
      appendChild(e) { head.push(e); appended.push(e); e.parentNode = document.head; return e; },
      removeChild(e) { const i = head.indexOf(e); if (i >= 0) head.splice(i, 1); e.parentNode = null; return e; },
    },
    createElement: el,
    querySelector: () => null,
    querySelectorAll(sel) {
      if (sel === 'script[src]') return head.filter((e) => e.tagName === 'SCRIPT' && e.src);
      if (sel === 'link[rel="stylesheet"][href]') return head.filter((e) => e.tagName === 'LINK' && e.rel === 'stylesheet' && e.href);
      return [];
    },
    getElementById: (id) => walk([body]).find((x) => x.id === id) || null,
    addEventListener() {},
  };
  const role = opts.role || 'company_admin';
  const theLead = { id: 'lead-1', firstName: 'Pat', lastName: 'Q', address: '56 Add Job Way, Mason, OH 45040', lat: 39.3, lng: -84.3, activeJobId: 'j1', stage: 'contacted', jobValue: 9000 };
  const jobs = [{ id: 'j1', title: 'Roof replacement', stage: 'contacted', stageRole: 'active', jobValue: 9000 }];
  const NBDJobs = {
    JOB_FIELDS: ['stage', 'stageRole', 'jobValue'],
    isOpen: (j) => !['lost', 'won'].includes(j.stageRole),
    loadLead: async () => jobs.slice(),
    forLead: () => jobs.slice(),
    async add(l, fields) { adds.push([l.id, fields]); jobs.push(Object.assign({ id: 'j' + (jobs.length + 1), stage: 'new', stageRole: 'new' }, fields)); return 'j' + jobs.length; },
  };
  const ctx = {
    document, URL, Promise, URLSearchParams, Set, Object, Number, String, Math, Array,
    console: { log() {}, info() {}, error() {}, warn(...a) { warns.push(a.join(' ')); } },
    setTimeout(fn) { timeouts.push(fn); return timeouts.length; },
    clearTimeout() {},
    setInterval(fn) { intervals.push(fn); return intervals.length; },
    clearInterval(id) { intervals[id - 1] = null; },
    location: { hash: opts.hash || '', pathname: '/pro/customer.html', search: '?id=lead-1' },
    addEventListener() {},
    showToast(m, k) { toasts.push([k, m]); },
    _currentLead: theLead,
    _userClaims: { role, companyId: 'c1' },
    _user: { uid: 'u1' },
    db: {},
    collection: () => ({}), query: () => ({}), where: () => ({}),
    getDocs: async () => ({ docs: [] }),
    NBDJobs,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const page = {
    ctx, head, appended, toasts, adds, warns, jobs, overview, body,
    get focused() { return focused; },
    run(src, name) { vm.runInContext(src, ctx, { filename: name }); },
    byId: (id) => document.getElementById(id),
    sheet: () => document.getElementById('cjAddSheet'),
    sheets: () => walk([body]).filter((x) => x.id === 'cjAddSheet').length,
    addTags: () => head.filter((e) => e.tagName === 'SCRIPT' && /customer-jobs-add\.js/.test(String(e.src))),
    addAppended: () => appended.filter((e) => /customer-jobs-add\.js/.test(String(e.src))),
    async tick() { intervals.forEach((fn) => { if (fn) fn(); }); await flush(); },
    runTimeouts() { while (timeouts.length) timeouts.shift()(); },
    // A tap on "＋ Add job", the way the browser delivers it to the panel's delegate.
    tapAdd() {
      const p = document.getElementById('jobsPanel');
      const btn = p && p.inner.find((x) => x.attrs['data-cj-add'] !== undefined);
      if (!btn) throw new Error('no ＋ Add job button');
      p.fire('click', { target: btn });
    },
    // The ScriptLoader's tag landing: the file runs, then onload fires.
    land(tag) { page.run(ADD, 'customer-jobs-add.js'); tag.onload(); },
  };
  if (opts.loader !== false) page.run(LOADER, 'script-loader.js');
  return page;
}
async function boot(opts) {
  const page = makePage(opts);
  let threw = null;
  try { page.run(BOOT, 'customer-jobs.js'); await page.tick(); } catch (e) { threw = e; }
  page.threw = threw;
  return page;
}

(async function main() {
  console.log('\nCUSTOMER JOBS: the boot file still paints the panel');
  ok('js/customer-jobs-add.js exists', !!ADD);
  {
    const p = await boot();
    ok('customer-jobs.js runs on the real script-loader.js without throwing', !p.threw, p.threw && p.threw.message);
    const panel = p.byId('jobsPanel');
    ok('#jobsPanel paints on the first poll, before #checklistPanel in #overviewTab',
      !!panel && p.overview.children[0] === panel && p.overview.children[1] && p.overview.children[1].id === 'checklistPanel');
    ok('...with the same markup as before the split', !!panel && panel.innerHTML === GOLDEN_PANEL, panel && panel.innerHTML);
    ok('nothing is fetched at boot (no tag appended, no preload)', p.head.length === 0, p.head.map((e) => e.src || e.href).join(', '));
    const B = p.ctx.ScriptLoader && p.ctx.ScriptLoader.bundles;
    const list = (B && B.customerjobsadd) || [];
    ok('it registers the customerjobsadd bundle at runtime, holding only the sheet file',
      list.length === 1 && /^js\/customer-jobs-add\.js\?v=\d+$/.test(list[0]), JSON.stringify(list));
    const CJ = p.ctx.NBDCustomerJobs || {};
    ok('NBDCustomerJobs keeps its boot helpers (_standing, _render, _costsByJob, _costLine) and openAdd',
      ['_standing', '_render', '_costsByJob', '_costLine', 'openAdd'].every((k) => typeof CJ[k] === 'function'));
    ok('the boot file no longer carries the sheet (no #cjAddForm markup, no buildJob)', !/cjAddForm/.test(BOOT) && !/function buildJob\(/.test(BOOT));
  }

  console.log('\nCUSTOMER JOBS: a tap before the file lands');
  {
    const p = await boot();
    let threw = null;
    try { p.tapAdd(); } catch (e) { threw = e; }
    await flush();
    const tags = p.addTags();
    ok('the tap throws nothing', !threw, threw && threw.message);
    ok('the tap fetches the sheet file: one tag appended', tags.length === 1, p.head.map((e) => e.src).join(', '));
    ok('no sheet opens before the file lands', !p.sheet());
    p.tapAdd();
    await flush();
    ok('a second tap while it loads fetches nothing more', p.addAppended().length === 1, p.addAppended().length);
    if (tags[0]) p.land(tags[0]);
    await flush();
    p.runTimeouts();
    ok('once it lands, the sheet opens, once', !!p.sheet() && p.sheets() === 1, p.sheets());
    ok('...and the title field takes focus, as before', p.focused === 'cjTitle', p.focused);
    ok('no error toast on the happy path', !p.toasts.some((t) => t[0] === 'error'), JSON.stringify(p.toasts));
    const form = p.byId('cjAddForm');
    if (form) form.fire('submit', { preventDefault() {} });
    await flush();
    ok('a blank title is refused with the sheet\'s own message', p.byId('cjErr') && p.byId('cjErr').textContent === 'Say what the job is.' && p.adds.length === 0);
    p.byId('cjTitle').value = 'Gutter guards';
    p.byId('cjType').value = 'cash';
    p.byId('cjValue').value = '1450';
    p.byId('cjScope').value = 'Front + back runs';
    if (form) form.fire('submit', { preventDefault() {} });
    await flush();
    const f = p.adds[0] && p.adds[0][1];
    ok('save writes the job through NBDJobs.add, fields as before',
      p.adds.length === 1 && p.adds[0][0] === 'lead-1' && f.title === 'Gutter guards' && f.jobType === 'cash' && f.jobValue === 1450 && f.scopeOfWork === 'Front + back runs'
      && f.property.address === '56 Add Job Way, Mason, OH 45040' && f.property.lat === 39.3, JSON.stringify(p.adds));
    ok('the sheet closes and a success toast says what was added', !p.sheet() && p.toasts.some((t) => t[0] === 'success' && t[1] === 'Job added: Gutter guards'), JSON.stringify(p.toasts));
    const panel = p.byId('jobsPanel');
    ok('the panel repaints with both jobs', !!panel && /Jobs <span[^>]*>\(2\)<\/span>/.test(panel.innerHTML) && /data-cj-job="j2"/.test(panel.innerHTML) && /data-cj-standing="open"/.test(panel.innerHTML));
    p.tapAdd();
    await flush();
    ok('the next tap opens the sheet directly, with no second fetch', !!p.sheet() && p.addAppended().length === 1);
    p.sheet().fire('keydown', { key: 'Escape' });
    ok('Escape closes it', !p.sheet());
    ok('NBDCustomerJobs._buildJob is there once the sheet file has run', typeof (p.ctx.NBDCustomerJobs || {})._buildJob === 'function');
  }

  console.log('\nCUSTOMER JOBS: a failed fetch');
  {
    const p = await boot();
    let threw = null, r = null;
    try { p.tapAdd(); r = p.ctx.NBDCustomerJobs.openAdd(); } catch (e) { threw = e; }
    await flush();
    const tags = p.addTags();
    if (tags[0]) tags[0].onerror();
    try { await r; } catch (e) { threw = e; }
    await flush();
    ok('the tap neither throws nor rejects', !threw, threw && threw.message);
    ok('no sheet opens', !p.sheet());
    ok('the rep is told, in the house wording (check the connection, tap again; not a refresh)',
      p.toasts.filter((t) => t[0] === 'error' && t[1] === 'Could not load the add-job form — check your connection and tap again').length === 1, JSON.stringify(p.toasts));
    ok('ScriptLoader drops the dead tag from <head>', !!tags[0] && p.addTags().length === 0 && tags[0].parentNode === null);
    ok('the panel is still there', !!p.byId('jobsPanel'));
    p.toasts.length = 0;
    let threw2 = null;
    try { p.tapAdd(); } catch (e) { threw2 = e; }
    await flush();
    const again = p.addAppended();
    ok('the next tap fetches again: a second, new tag', again.length === 2 && again[1] !== tags[0], again.length);
    if (again[1]) p.land(again[1]);
    await flush();
    ok('...and when it lands, the sheet opens, with no error toast', !threw2 && !!p.sheet() && !p.toasts.some((t) => t[0] === 'error'), JSON.stringify(p.toasts));
  }

  console.log('\nCUSTOMER JOBS: the #addJob deep link');
  {
    const p = makePage({ hash: '#addJob' });
    p.run(BOOT, 'customer-jobs.js');
    ok('nothing is fetched before the lead is ready', p.head.length === 0);
    await p.tick();
    const tags = p.addTags();
    ok('the panel paints first, then the sheet file is fetched', !!p.byId('jobsPanel') && tags.length === 1 && !p.sheet(), p.head.map((e) => e.src).join(', '));
    if (tags[0]) p.land(tags[0]);
    await flush();
    ok('once it lands, the add sheet opens on load', !!p.sheet() && p.sheets() === 1);
  }
  {
    const p = await boot({ hash: '#schedule' });
    ok('any other hash fetches nothing', p.head.length === 0);
    const v = await boot({ hash: '#addJob', role: 'viewer' });
    ok('a viewer\'s #addJob fetches nothing and opens nothing (no write access)', v.head.length === 0 && !v.sheet());
    ok('a viewer gets no ＋ Add job button, as before', !/data-cj-add/.test((v.byId('jobsPanel') || {}).innerHTML || ''));
  }

  console.log('\nCUSTOMER JOBS: no ScriptLoader on the page');
  {
    const p = await boot({ loader: false });
    ok('customer-jobs.js runs without throwing', !p.threw, p.threw && p.threw.message);
    ok('the panel still paints, same markup', !!p.byId('jobsPanel') && p.byId('jobsPanel').innerHTML === GOLDEN_PANEL);
    let threw = null;
    try { p.tapAdd(); await flush(); } catch (e) { threw = e; }
    ok('a tap throws nothing, opens nothing, and says why', !threw && !p.sheet() && p.toasts.some((t) => t[0] === 'error'), JSON.stringify(p.toasts));
    const q = await boot({ loader: false, hash: '#addJob' });
    ok('the deep link without a ScriptLoader throws nothing', !q.threw && !!q.byId('jobsPanel'), q.threw && q.threw.message);
  }

  console.log('\nCUSTOMER JOBS: the sheet file');
  {
    ok('it guards against running twice', /if \(window\.__nbdCustomerJobsAdd\) return;/.test(ADD));
    ok('it adds _openSheet / _buildJob to NBDCustomerJobs (no new page global)', /\._openSheet = /.test(ADD) && /\._buildJob = /.test(ADD));
    const p = makePage();
    p.run(BOOT, 'customer-jobs.js');
    if (ADD) p.run(ADD, 'customer-jobs-add.js');
    const bj = (p.ctx.NBDCustomerJobs || {})._buildJob;
    const l = p.ctx._currentLead;
    const props = [l.address, '9 Other St'];
    ok('buildJob: blank-spaces title refused', bj && bj(l, props, { title: '   ' }).error === 'Say what the job is.');
    ok('buildJob: a negative value refused', bj && bj(l, props, { title: 'X', value: '-5' }).error === 'Value must be a dollar amount.');
    ok('buildJob: a second property gets no pin', bj && JSON.stringify(bj(l, props, { title: 'X', prop: '1' }).fields.property) === '{"address":"9 Other St","lat":null,"lng":null}');
  }

  console.log('\nCUSTOMER JOBS: customer.html and script-loader.js');
  {
    ok('customer.html has no eager tag for the sheet file', !/customer-jobs-add\.js/.test(CUSTOMER));
    ok('customer.html still carries customer-jobs.js as a deferred tag, after jobs-store.js and script-loader.js',
      /<script defer src="js\/customer-jobs\.js\?v=\d+"><\/script>/.test(CUSTOMER)
      && CUSTOMER.indexOf('js/customer-jobs.js') > CUSTOMER.indexOf('js/jobs-store.js') && CUSTOMER.indexOf('js/jobs-store.js') > CUSTOMER.indexOf('js/script-loader.js')
      && CUSTOMER.indexOf('js/script-loader.js') > 0);
    ok('script-loader.js is untouched: no customerjobsadd bundle in the blocking file', !/customer-jobs-add|customerjobsadd/.test(LOADER));
    ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"lazy-customer-jobs-add-2026-11-08.test.js"') >= 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  ✗ crashed: ' + (e && e.stack)); process.exit(1); });
