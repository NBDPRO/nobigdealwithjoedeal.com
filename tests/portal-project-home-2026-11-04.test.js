/**
 * tests/portal-project-home-2026-11-04.test.js
 *
 * Customer portal Phase 1 (documentation/projects/CUSTOMER-PORTAL-PLAN-2026-11-04.md):
 * the "your project" home on top of the existing 9-step tracker.
 *
 *   1. Wording lives in functions/homeowner-progress.js (the one copy table
 *      the KY / crews scanner already reads) and stays neutral.
 *   2. portal.js: ONE big next action matched to the job (sign / book /
 *      estimate, then the existing pay / review / warranty), "Step X of Y",
 *      a spoken state per step, "Starts after: …" on later steps, and the
 *      after-signing booking card no longer says "Book your inspection".
 *   3. Anonymous metrics: recordCustomerEvent's m_open / m_action write ONLY
 *      a per-company per-day counter — no audit row, no IP, user agent,
 *      token or lead id — and refuse an action kind outside the allowlist.
 *      Real handler, stubbed Firestore.
 *   4. portal_metrics is closed to every client in firestore.rules.
 *
 * Run: node tests/portal-project-home-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

(async () => {
  console.log('\n1. wording (server copy table)');
  const HP = require(path.join(ROOT, 'functions/homeowner-progress.js'));
  const ui = HP.HOMEOWNER_PROGRESS_COPY.ui;
  for (const k of ['stepOf', 'startsAfter', 'srDone', 'srCurrent', 'srUpcoming', 'signLink', 'bookLink', 'estimateLink']) {
    ok('ui.' + k + ' is set', typeof ui[k] === 'string' && ui[k].length > 0);
  }
  const all = Object.values(ui).join(' | ');
  ok('no claim / carrier / adjuster / deductible wording in the new lines',
    !/\b(claim|carrier|adjuster|deductible|insurance company)\b/i.test([ui.stepOf, ui.startsAfter, ui.signLink, ui.bookLink, ui.estimateLink].join(' ')));
  ok('no "our team" / "in-house" anywhere in the ui copy (crews are subs)', !/our team|in-house|our employees/i.test(all));
  ok('placeholders: stepOf has {n} and {total}; startsAfter has {prev}', /\{n\}/.test(ui.stepOf) && /\{total\}/.test(ui.stepOf) && /\{prev\}/.test(ui.startsAfter));

  console.log('\n2. portal.js render');
  const PJS = read('docs/pro/js/portal.js');
  const code = stripComments(PJS);
  ok('sign action when the estimate waits on them (sent/viewed + live sign link)',
    /_sigSt === 'sent' \|\| _sigSt === 'viewed'/.test(code) && /data-metric="sign"/.test(code) && /copy\.signLink/.test(code));
  ok('book action only at an un-done inspection step with a booking link',
    /p\.currentKey === 'inspection' && !_inspDone && view\.bookingUrl && copy\.bookLink/.test(code) && /href="#book-card"/.test(code));
  ok('estimate action at the estimate step points at #est-card', /p\.currentKey === 'estimate' && view\.estimate && copy\.estimateLink/.test(code) && /href="#est-card"/.test(code));
  ok('the cards those anchors target exist', /'<div class="card" id="est-card">'/.test(code) && /'<div class="card" id="book-card" style="'/.test(code));
  ok('every next action carries a metric kind', ['pay', 'review', 'warranty'].every((k) => code.indexOf('data-metric="' + k + '"') > 0));
  ok('only the FIRST action becomes the big primary button', /ai === 0 \? a\.replace\('class="btn ', 'class="btn progress-action-primary '\)/.test(code));
  ok('"Step X of Y" is spoken (sr-only) — the visible "N of M done" already shows it', code.indexOf("(stepOfText ? '<span class=\"sr-only\">'") > 0);
  ok('"Step X of Y" is computed from the same visible list as the count (audit M2)',
    /const _curPos = steps\.findIndex/.test(code) && /_fillCopy\(copy\.stepOf, \{ n: _curPos \+ 1, total: total \}\)/.test(code));
  ok('each step speaks its state to screen readers', /<span class="sr-only">, ' \+ esc\(srState\)/.test(code));
  ok('a later step says what it starts after (previous visible step)', /s\.state === 'upcoming' && i > 0 && copy\.startsAfter/.test(code) && /prev: steps\[i - 1\]\.label/.test(code));
  ok('after signing the booking card no longer says "Book your inspection"', !/title = 'Book your inspection'/.test(code) && /title = 'Talk with '/.test(code));
  ok('M2 kept: skipped steps stay out of the list, bar and count', /const steps = _visibleProgressSteps\(_progressSteps\(p\.milestones, idx\)\);/.test(code));
  const html = read('docs/pro/portal.html');
  ok('CSS: primary action is full width on a phone, 52px tall', /\.progress-action-primary\{[\s\S]*?flex: 1 1 100%; min-height:52px/.test(html));
  ok('CSS: .sr-only is visually hidden', /\.sr-only\{[\s\S]*?clip:rect\(0,0,0,0\)/.test(html));
  ok('portal.js cache-buster bumped (v>=19)', Number((html.match(/js\/portal\.js\?v=(\d+)/) || [])[1]) >= 19);
  ok('metrics go through the ONE guarded emitter (no second fetch)', (code.match(/recordCustomerEvent/g) || []).length === 1 && /function _emitMetric\(type, kind\) \{\s*_emitAuditEvent\(type, null, \{ kind: kind \|\| null \}\);/.test(code));
  ok('the open metric fires once, next to portal_open', /_emitAuditEvent\('portal_open'\);\s*_emitMetric\('m_open'\);/.test(code));

  console.log('\n3. recordCustomerEvent metrics (real handler, stubbed Firestore)');
  const CA = path.join(ROOT, 'functions/customer-audit.js');
  function load(tokens, writes) {
    const realLoad = Module._load;
    Module._load = function (request) {
      if (request === 'firebase-admin/firestore') {
        const db = {
          doc(p) { const [col, id] = p.split('/'); return { get: async () => ({ exists: col === 'portal_tokens' && tokens[id] !== undefined, data: () => tokens[id] }) }; },
          collection(name) {
            return {
              add: async (d) => { writes.push({ col: name, op: 'add', d }); return { id: 'x' }; },
              doc: (id) => ({ set: async (d, o) => { writes.push({ col: name, op: 'set', id, d, o }); } }),
            };
          },
        };
        return { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'TS', increment: (n) => ({ inc: n }) } };
      }
      if (request === './integrations/upstash-ratelimit') return { httpRateLimit: async () => true };
      return realLoad.apply(this, arguments);
    };
    try { delete require.cache[require.resolve(CA)]; return require(CA); }
    finally { Module._load = realLoad; }
  }
  function res() {
    const r = new EventEmitter(); r.statusCode = 200; const h = {};
    r.setHeader = (k, v) => { h[k.toLowerCase()] = v; }; r.getHeader = (k) => h[k.toLowerCase()]; r.removeHeader = (k) => { delete h[k.toLowerCase()]; };
    r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; r.end(); return r; };
    r.end = () => { if (!r._e) { r._e = true; r.emit('finish'); } return r; };
    return r;
  }
  const TOK = 'BBBBBBBBBBBBBBBBBBBBBBBB';
  const FUT = { toMillis: () => Date.now() + 1e6 };
  const tokens = { [TOK]: { leadId: 'lead1', ownerUid: 'rep1', companyId: 'co_nbd', expiresAt: FUT, uses: 1, maxUses: 100 } };
  const call = async (body) => {
    const writes = [];
    const mod = load(tokens, writes);
    const r = res();
    await mod.recordCustomerEvent({ method: 'POST', body, headers: { 'user-agent': 'UA-SECRET', 'x-forwarded-for': '203.0.113.9', origin: 'https://nobigdealwithjoedeal.com' } }, r);
    return { r, writes, mod };
  };
  const open = await call({ token: TOK, type: 'm_open' });
  ok('m_open → 204', open.r.statusCode === 204, String(open.r.statusCode));
  const w = open.writes[0] || {};
  ok('writes ONE portal_metrics counter and no audit row', open.writes.length === 1 && w.col === 'portal_metrics' && w.op === 'set');
  ok('counter doc is company + day', /^co_nbd_\d{4}-\d{2}-\d{2}$/.test(w.id || ''), w.id);
  ok('increments counts.open, merged', w.d && w.d.counts && w.d.counts.open && w.d.counts.open.inc === 1 && w.o && w.o.merge === true);
  const flat = JSON.stringify(w.d || {});
  ok('stores no IP, user agent, token or lead id', !/203\.0\.113|UA-SECRET|BBBBBBBB|lead1/.test(flat), flat);
  const act = await call({ token: TOK, type: 'm_action', kind: 'sign' });
  ok('m_action sign → counts.action_sign', act.r.statusCode === 204 && act.writes[0] && act.writes[0].d.counts.action_sign);
  const bad = await call({ token: TOK, type: 'm_action', kind: '__proto__' });
  ok('an action kind outside the allowlist is refused (400), nothing written', bad.r.statusCode === 400 && bad.writes.length === 0);
  const junk = await call({ token: TOK, type: 'm_whatever' });
  ok('an unknown type is still refused (400)', junk.r.statusCode === 400 && junk.writes.length === 0);
  const noTok = await call({ token: 'CCCCCCCCCCCCCCCCCCCCCCCC', type: 'm_open' });
  ok('an unknown link counts nothing (404)', noTok.r.statusCode === 404 && noTok.writes.length === 0);
  const audit = await call({ token: TOK, type: 'portal_open' });
  ok('control: portal_open still writes its audit row (unchanged)', audit.writes.length === 1 && audit.writes[0].col === 'customerAuditEvents');
  const T = open.mod._test;
  ok('metricTarget falls back to ownerUid for a solo account, strips odd characters', T.metricTarget({ ownerUid: 'rep/1..x' }, 'm_open', null, Date.UTC(2026, 10, 4)).docId === 'rep1x_2026-11-04');

  console.log('\n4. rules');
  const rules = read('firestore.rules');
  ok('portal_metrics: no client read or write', /match \/portal_metrics\/\{docId\} \{\s*allow read, write: if false;\s*\}/.test(rules));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
