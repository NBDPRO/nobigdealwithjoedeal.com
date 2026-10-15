#!/usr/bin/env node
/**
 * tests/deal-check-rate-2026-10-15.test.js — "Check my rate" in the deal room.
 *
 *   A. the stage rule: Pre-Qual Sent only when forward (deal-prequal-logic.js)
 *   B. /api/deal-prequal on a fake Firestore: the activity row, the move, the
 *      24 h dedupe, done deals, expired tokens, another tenant's lead
 *   C. the deal page (close-board.js): the button opens the Acorn dealer link,
 *      no amount prefill, Acorn-sourced credit wording, every "$X/mo" labelled,
 *      no APR or specific rate printed
 *   D. the homeowner script (deal-room.js): the finance row is labelled and the
 *      tap pings /api/deal-prequal without blocking the link
 *   E. wiring (meta tag, rewrite, export)
 *
 * Run: node tests/deal-check-rate-2026-10-15.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PQ = require(path.join(ROOT, 'functions/deal-prequal-logic.js'));
const API = require(path.join(ROOT, 'functions/deal-prequal.js'))._test;
const BAND = require(path.join(ROOT, 'docs/assets/js/financing-band.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 400) : '')); failed++; }
}
const LABEL = 'Estimated payment; actual rate, APR and term are set by the lender after approval';
const NOW = Date.parse('2026-10-15T18:00:00Z');
const DAY = 86400000;

function makeDb(seed) {
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, clone(v)]));
  const val = (v, cur) => {
    if (v === '__TS__') return NOW;
    if (v && v.__inc) return (Number(cur) || 0) + v.__inc;
    if (v && v.__union) return (Array.isArray(cur) ? cur : []).concat(v.__union);
    return v;
  };
  const apply = (cur, patch) => { const d = Object.assign({}, cur); for (const k of Object.keys(patch)) d[k] = val(patch[k], d[k]); return d; };
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    collection: (c) => ({ doc: (id) => ref(p + '/' + c + '/' + id) }),
    async get() { const d = store.get(p); return { exists: d !== undefined, data: () => (d === undefined ? undefined : clone(d)) }; },
  });
  return {
    store, doc: ref,
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        get: (r) => r.get(),
        update: (r, patch) => pending.push(() => { if (!store.has(r.path)) throw new Error('NOT_FOUND'); store.set(r.path, apply(store.get(r.path), patch)); }),
        set: (r, d) => pending.push(() => store.set(r.path, apply({}, d))),
      };
      const out = await fn(tx);
      pending.forEach((f) => f());
      return out;
    },
  };
}
const FV = { serverTimestamp: () => '__TS__', increment: (n) => ({ __inc: n }), arrayUnion: (...x) => ({ __union: x }) };
const TOKEN = 'abcdef0123456789';
const seed = (lead, room, tok) => ({
  ['deal_accept_tokens/' + TOKEN]: Object.assign({ dealId: 'D1', leadId: 'L1', ownerUid: 'O', companyId: 'O', status: 'pending' }, tok || {}),
  'deal_rooms/D1': Object.assign({ userId: 'O', leadId: 'L1', status: 'viewed' }, room || {}),
  ...(lead ? { 'leads/L1': Object.assign({ userId: 'O', companyId: 'O', firstName: 'Pat' }, lead) } : {}),
});
const acts = (db) => [...db.store.keys()].filter((k) => k.startsWith('leads/L1/activity/'));

(async () => {
  console.log('\nA. Pre-Qual Sent only when that is forward');
  {
    for (const s of ['new', 'contacted', 'inspected', 'New', 'Inspected']) ok(s + ' → moves to Pre-Qual Sent', PQ.planPrequalMove({ stage: s }).move === true && PQ.planPrequalMove({ stage: s }).to === 'prequal_sent');
    ok('no stage at all (a brand-new lead) → moves', PQ.planPrequalMove({}).move === true);
    for (const s of ['estimate_sent_cash', 'negotiating', 'estimate_submitted', 'claim_filed', 'scope_received', 'loan_approved', 'contract_signed', 'job_created', 'install_in_progress', 'closed']) {
      ok(s + ' → stays (not forward)', PQ.planPrequalMove({ stage: s }).move === false);
    }
    ok('already at Pre-Qual Sent → stays', PQ.planPrequalMove({ stage: 'prequal_sent' }).reason === 'already_there');
    ok('lost → stays', PQ.planPrequalMove({ stage: 'lost', stageRole: 'lost' }).reason === 'lost');
    ok('deleted → stays', PQ.planPrequalMove({ stage: 'new', deleted: true }).reason === 'deleted');
    ok('a tenant\'s custom stage → stays', PQ.planPrequalMove({ stage: 'waiting_on_hoa', stageRole: 'active' }).reason === 'custom_stage');
    ok('dedupe: once per deal per 24 h', PQ.shouldLog(0, NOW) && !PQ.shouldLog(NOW - DAY + 60000, NOW) && PQ.shouldLog(NOW - DAY, NOW));
  }

  console.log('\nB. /api/deal-prequal');
  {
    let db = makeDb(seed({ stage: 'inspected', stageRole: 'active' }));
    let r = await API.recordPrequalStarted(db, TOKEN, { FieldValue: FV, nowMs: NOW });
    const L = db.store.get('leads/L1');
    ok('an Inspected lead: logged and moved', r.logged && r.moved, JSON.stringify(r));
    ok('lead now Pre-Qual Sent, role active, history says homeowner / prequal_started', L.stage === 'prequal_sent' && L.stageRole === 'active' && L.stageStartedAt === NOW
      && Array.isArray(L.stageHistory) && L.stageHistory[0].from === 'inspected' && L.stageHistory[0].to === 'prequal_sent' && L.stageHistory[0].user === 'homeowner' && L.stageHistory[0].event === 'prequal_started');
    const row = db.store.get(acts(db)[0]) || {};
    ok('ONE "Financing prequal started" activity row on the lead', acts(db).length === 1 && row.type === 'financing_prequal_started' && row.label === 'Financing prequal started' && row.userId === 'O' && row.dealId === 'D1');
    ok('a signed contract date is not stamped by this move (not a sale)', L.closedAt === undefined);
    r = await API.recordPrequalStarted(db, TOKEN, { FieldValue: FV, nowMs: NOW + 3600000 });
    ok('a second tap an hour later → no second row', r.reason === 'recent' && acts(db).length === 1);
    r = await API.recordPrequalStarted(db, TOKEN, { FieldValue: FV, nowMs: NOW + DAY + 1 });
    ok('the next day → logged again, not moved (already there)', r.logged && !r.moved && r.reason === 'already_there' && acts(db).length === 2);

    db = makeDb(seed({ stage: 'negotiating', stageRole: 'active' }));
    r = await API.recordPrequalStarted(db, TOKEN, { FieldValue: FV, nowMs: NOW });
    ok('Negotiating: logged, stage untouched', r.logged && !r.moved && db.store.get('leads/L1').stage === 'negotiating' && acts(db).length === 1);
    db = makeDb(seed({ stage: 'contract_signed', stageRole: 'active' }));
    r = await API.recordPrequalStarted(db, TOKEN, { FieldValue: FV, nowMs: NOW });
    ok('Contract Signed: logged, never moved backwards', r.logged && !r.moved && db.store.get('leads/L1').stage === 'contract_signed');
    db = makeDb(seed({ stage: 'new' }, { status: 'accepted' }));
    r = await API.recordPrequalStarted(db, TOKEN, { FieldValue: FV, nowMs: NOW });
    ok('a deal already accepted: logged, not moved', r.logged && !r.moved && db.store.get('leads/L1').stage === 'new');
    db = makeDb(seed({ stage: 'new' }, null, { expiresAt: { seconds: Math.floor((NOW - 1000) / 1000) } }));
    r = await API.recordPrequalStarted(db, TOKEN, { FieldValue: FV, nowMs: NOW });
    ok('an expired link → nothing written', !r.logged && r.reason === 'expired' && acts(db).length === 0);
    db = makeDb(seed({ stage: 'new', companyId: 'OTHER', userId: 'OTHER' }));
    r = await API.recordPrequalStarted(db, TOKEN, { FieldValue: FV, nowMs: NOW });
    ok('another tenant\'s lead behind the id → untouched', !r.logged && db.store.get('leads/L1').stage === 'new' && acts(db).length === 0);
    db = makeDb(seed({ stage: 'new' }));
    r = await API.recordPrequalStarted(db, 'not a token!', { FieldValue: FV, nowMs: NOW });
    ok('a malformed token → nothing read or written', r.reason === 'bad_token' && acts(db).length === 0);
    ok('body parsing: text/plain beacon JSON and Buffers', API.parseBody('{"token":"x"}').token === 'x' && API.parseBody(Buffer.from('{"token":"y"}')).token === 'y' && typeof API.parseBody('nope') === 'object');
  }

  console.log('\nC. the deal page');
  function loadCB() {
    const win = { addEventListener() {}, _user: null };
    win.window = win;
    const doc = { getElementById: () => null, addEventListener() {}, querySelector: () => null };
    win.document = doc;
    const c = { window: win, document: doc, console: { log() {}, warn() {}, error() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, setTimeout, clearTimeout, navigator: {}, Date, Math, JSON };
    vm.createContext(c);
    vm.runInContext(read('docs/pro/js/estimate-config.js'), c);
    vm.runInContext(read('docs/assets/js/financing-band.js'), c);
    win._brand = () => ({ legalName: 'No Big Deal Home Solutions', contact: { phone: '(859) 420-7382', email: 'info@example.test' } });
    vm.runInContext(read('docs/pro/js/close-board.js'), c);
    return win.CloseBoard;
  }
  const tierOf = (p) => ({ price: p, description: '', lineItems: [] });
  const DEAL = { id: 'd1', customerName: 'Pat', address: '1 Test St, Milford, OH 45150', repName: 'Joe', repEmail: 'jd@example.test', repPhone: '(859) 420-7382',
    tiers: { good: tierOf(11000), better: tierOf(13000), best: tierOf(15000) } };
  const html = loadCB().generatePageHTML(DEAL);
  const visible = html.replace(/<script type="application\/json" id="nbd-deal-data">[\s\S]*?<\/script>/, '').replace(/<style>[\s\S]*?<\/style>/g, '');
  const btn = /<a class="check-rate-btn" href="([^"]+)" target="_blank" rel="noopener noreferrer" data-deal-action="checkRate">Check my rate<\/a>/.exec(html);
  ok('a "Check my rate" button, a plain link in a new tab (no handler attribute)', !!btn && !/onclick/i.test(html));
  ok('it opens the existing Acorn dealer link exactly, with no amount prefill', btn && btn[1] === BAND.preQualUrl && btn[1] === 'https://www.acornfinance.com/pre-qualify/?d=QU6WZ');
  ok('credit wording is Acorn\'s: soft check, no score impact, hard check only on choosing an offer',
    /soft credit check through Acorn Finance and does not affect your credit score/.test(visible) && /hard credit check only if you choose an offer and proceed/.test(visible));
  const mos = visible.match(/\$[\d,]+–\$[\d,]+\/mo/g) || [];
  ok('a monthly estimate per priced tier', mos.length === 3, mos.join(' | '));
  const tierChunks = visible.split('data-deal-tier="').slice(1);
  ok('EVERY "$X/mo" is followed by the TILA label', tierChunks.length === 3 && tierChunks.every((ch) => {
    const i = ch.indexOf('/mo'); return i > -1 && ch.indexOf(LABEL) > i;
  }));
  ok('the footnote carries the label too', new RegExp('\\*' + LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.').test(visible));
  ok('no APR and no specific rate printed anywhere on the page', !/\d+(\.\d+)?\s*%/.test(visible) && !/11\.49|19\.99/.test(visible));
  ok('the payment math is unchanged (the band\'s range over its default term)', mos[0] === BAND.fmtWhole(BAND.range(11000, BAND.defaultTermYears * 12).lo) + '–' + BAND.fmtWhole(BAND.range(11000, BAND.defaultTermYears * 12).hi) + '/mo');
  ok('the page loads deal-room.js?v=6', /deal-room\.js\?v=6/.test(html));

  console.log('\nD. the homeowner script');
  {
    const island = JSON.parse(/<script type="application\/json" id="nbd-deal-data">([\s\S]*?)<\/script>/.exec(html)[1]);
    const els = { financeOpts: { innerHTML: '' }, submitBtn: { disabled: true } };
    const metas = { 'nbd-deal-token': TOKEN, 'nbd-deal-prequal': '/api/deal-prequal' };
    let clickH = null;
    const beacons = [];
    const doc = {
      getElementById: (i) => (i === 'nbd-deal-data' ? { textContent: JSON.stringify(island) } : (els[i] || null)),
      querySelectorAll: () => [],
      querySelector: (sel) => { const m = /meta\[name="([^"]+)"\]/.exec(sel); return m && metas[m[1]] ? { content: metas[m[1]] } : null; },
      addEventListener: (ev, fn) => { if (ev === 'click') clickH = fn; }, visibilityState: 'visible',
    };
    const nav = { sendBeacon: (u, b) => { beacons.push([u, b]); return true; } };
    function Blob(parts, o) { this.parts = parts; this.type = o && o.type; }
    const c = { window: { addEventListener() {} }, document: doc, navigator: nav, Blob, Math, JSON, Number, String, parseInt };
    vm.createContext(c);
    vm.runInContext(read('docs/pro/deal-room.js'), c);
    clickH({ target: { closest: (sel) => (sel === '[data-deal-tier]' ? { dataset: { dealTier: 'better' } } : null) } });
    const row = els.financeOpts.innerHTML;
    ok('the picked tier\'s finance row shows "$X–$Y/mo" with the label right under it', /\/mo<\/span><\/div><div class="tier-monthly-note">/.test(row) && row.indexOf(LABEL) > row.indexOf('/mo'), row);
    ok('…and no APR or rate in it', !/%/.test(row));
    let prevented = false;
    clickH({ preventDefault() { prevented = true; }, target: { closest: (sel) => (sel === '[data-deal-action]' ? { dataset: { dealAction: 'checkRate' } } : null) } });
    ok('the tap pings /api/deal-prequal with the deal token', beacons.length === 1 && beacons[0][0] === '/api/deal-prequal' && JSON.parse(beacons[0][1].parts[0]).token === TOKEN);
    ok('…and never blocks the link from opening Acorn', prevented === false);
    metas['nbd-deal-token'] = '';
    clickH({ target: { closest: (sel) => (sel === '[data-deal-action]' ? { dataset: { dealAction: 'checkRate' } } : null) } });
    ok('the rep\'s in-app preview (no token) reports nothing', beacons.length === 1);
  }

  console.log('\nE. wiring');
  {
    const da = read('functions/deal-acceptance.js');
    ok('getDealRoom injects <meta name="nbd-deal-prequal"> → /api/deal-prequal', /const PREQUAL_PATH = '\/api\/deal-prequal'/.test(da) && /<meta name="nbd-deal-prequal" content="\$\{escAttr\(PREQUAL_PATH\)\}">/.test(da));
    const fb = JSON.parse(read('firebase.json'));
    const rw = JSON.stringify(fb.hosting);
    ok('firebase.json rewrites /api/deal-prequal → dealPrequalStarted', /"source":"\/api\/deal-prequal","function":\{"functionId":"dealPrequalStarted"/.test(rw));
    ok('exported from functions/index.js', /exports\.dealPrequalStarted = require\('\.\/deal-prequal'\)\.dealPrequalStarted/.test(read('functions/index.js')));
    const src = read('functions/deal-prequal.js');
    ok('rate-limited, preview bots ignored, always 204', /httpRateLimit\(req, res, 'dealprequal:ip'/.test(src) && /isPreviewBot/.test(src) && /res\.status\(204\)\.end\(\)/.test(src));
    ok('the endpoint sends nothing (no email / SMS / push)', !/resend|twilio|messages\.create|sendCustomNotification/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
    ok('close-board.js bumped in the loader', /'js\/close-board\.js\?v=17'/.test(read('docs/pro/js/script-loader.js')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
