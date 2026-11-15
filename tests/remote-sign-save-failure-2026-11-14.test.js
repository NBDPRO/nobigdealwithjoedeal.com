/**
 * tests/remote-sign-save-failure-2026-11-14.test.js
 *
 * Bug (2026-11-14 review, finding 9): submitSignature burns the token, then
 * saves the signed record over htmlPath (two tries). When both tries failed it
 * still stamped the document { status: 'signed' }, told the rep "Document
 * signed" and returned { ok: true }: the homeowner saw "All done — your
 * signature has been recorded", and the stored document the rep opens was the
 * UNSIGNED original. The signature was lost and nobody was told.
 *
 * Now: the document is flagged signedSaveFailed, the rep's notification says
 * the signed copy was NOT saved, the response carries saved:false, the sign
 * page tells the homeowner the contractor will confirm, the CRM documents row
 * warns, and (Joe, 2026-11-14) the document is NOT marked signed, the job does
 * not advance, no cancel-by date is stamped, and an already-signed document
 * cannot be sent for signature again (a flagged one can: the recovery path).
 *
 * Drives the real handler against stubbed firebase modules (the harness from
 * remote-signing-record-and-path-2026-10-05.test.js). Zero network.
 * Run: node tests/remote-sign-save-failure-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const kit = require('./lib/src-kit');
// Regex check on a value the code produced (not on file text).
const matches = (re, v) => re.test(String(v == null ? '' : v));

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// ── harness ──────────────────────────────────────────────────────────────
// failTimes: { '<path prefix>': n } makes the next n writes touching a path
// with that prefix throw (a direct set/add, or a batch commit holding one).
function makeDb(seed, failTimes) {
  const store = new Map(Object.entries(seed || {}));
  const fails = Object.assign({}, failTimes || {});
  const trip = (p) => {
    for (const k of Object.keys(fails)) if (p.startsWith(k) && fails[k] > 0) { fails[k]--; throw new Error('firestore unavailable ' + p); }
  };
  const apply = (prev, patch) => {
    const next = Object.assign({}, prev);
    for (const [k, v] of Object.entries(patch)) {
      if (v && v.__fv === 'delete') delete next[k];
      else next[k] = (v && v.__fv) ? ('FV:' + v.__fv) : v;
    }
    return next;
  };
  let auto = 0;
  const ref = (p) => ({
    id: p.split('/').pop(), path: p,
    get: async () => { const d = store.get(p); return { exists: d !== undefined, data: () => d, ref: ref(p), id: p.split('/').pop() }; },
    set: async (patch, o) => { trip(p); store.set(p, apply((o && o.merge) ? (store.get(p) || {}) : {}, patch)); },
    update: async (patch) => { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); store.set(p, apply(store.get(p), patch)); },
  });
  return {
    doc: ref,
    collection: (c) => ({
      add: async (d) => { trip(c + '/'); store.set(c + '/auto' + (++auto), d); return { id: 'auto' + auto }; },
      doc: (id) => ref(c + '/' + (id || ('auto' + (++auto)))),
    }),
    batch: () => {
      const ops = [];
      return {
        set: (r, d, o) => { ops.push(() => store.set(r.path, apply((o && o.merge) ? (store.get(r.path) || {}) : {}, d))); ops.paths = (ops.paths || []).concat(r.path); },
        update: (r, d) => { ops.push(() => store.set(r.path, apply(store.get(r.path) || {}, d))); ops.paths = (ops.paths || []).concat(r.path); },
        commit: async () => { (ops.paths || []).forEach(trip); ops.forEach((f) => f()); },
      };
    },
    runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, d) => { r.update(d); }, set: (r, d, o) => { r.set(d, o); } }),
    _store: store,
  };
}
function makeStorage(files, failSave) {
  const m = new Map(Object.entries(files || {}).map(([k, v]) => [k, Buffer.from(v, 'utf8')]));
  const downloads = [], saves = [];
  return {
    bucket: () => ({ file: (p) => ({
      download: async () => { downloads.push(p); if (!m.has(p)) throw new Error('no such object ' + p); return [m.get(p)]; },
      save: async (buf) => { saves.push(p); if (failSave && failSave(p)) throw new Error('storage unavailable'); m.set(p, Buffer.from(buf)); },
    }) }),
    _files: m, downloads, saves,
  };
}
const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', './await-briefly', './signed-price', 'crypto'];
const LOGS = [];
const SPINE = [];
function loadFn(db, storage) {
  const file = path.join(FN, 'remote-signing.js');
  class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const logger = { info() {}, warn(m, o) { LOGS.push({ level: 'warn', m, o }); }, error(m, o) { LOGS.push({ level: 'error', m, o }); } };
  const stubs = {
    'firebase-functions/v2/https': { onCall: (o, h) => h, onRequest: (o, h) => h, HttpsError },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'stub' }) },
    'firebase-functions/v2': { logger },
    'firebase-admin/firestore': { getFirestore: () => db, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
      FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }), delete: () => ({ __fv: 'delete' }) } },
    'firebase-admin/storage': { getStorage: () => storage },
    './integrations/upstash-ratelimit': { httpRateLimit: async () => true },
    './shared': { callableRateLimit: async () => {}, assertNotViewer: () => {} },
    './estimate-view-alert': { recordEstimateView: async () => {} },
    './integrations/_shared': { secretOr: (_s, d) => d },
    './messaging-controls': require('./lib/messaging-controls-stub'),
    './resend-guard': { resendRejected: () => false, resendErrorMessage: () => '' },
    './job-spine': { spineAfterRemoteSign: async (_db, info) => { SPINE.push(info && info.docId); return {}; } },
    resend: { Resend: class { constructor() { this.emails = { send: async () => ({ data: { id: 'm1' } }) }; } } },
  };
  const req = (id) => {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    if (REAL.indexOf(id) !== -1) return require(id.charAt(0) === '.' ? path.join(FN, id) : id);
    throw new Error('unstubbed require(' + id + ')');
  };
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'console', 'process', fs.readFileSync(file, 'utf8'))(mod, mod.exports, req, { log() {}, warn() {}, error() {} }, process);
  return mod.exports;
}
function reqRes(body) {
  const res = { statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  return { req: { method: 'POST', body, get: () => '' }, res };
}

// ── fixtures ─────────────────────────────────────────────────────────────
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ORIGINAL = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Roofing Agreement</title>
<style>.doc{font-family:serif}</style></head>
<body>
  <h1>Roofing Agreement</h1>
  <p>Prepared for <strong>Dana Whitfield</strong>.</p>
  <table><tr><td>Total</td><td>$28,400.00</td></tr></table>
  <div class="nbd-sig-block" data-nbd-sig="homeowner" data-label="Homeowner" data-required="true">
    <div class="nbd-sig-label">Homeowner</div>
    <canvas class="nbd-sig-canvas"></canvas>
    <div class="nbd-sig-controls">
      <button type="button" data-nbd-sig-action="clear">Clear</button>
      <span class="nbd-sig-state"></span>
    </div>
    <div class="nbd-sig-print-name">Print Name &amp; Date</div>
  </div>
  <script src="/pro/js/signature-widget.js"></script>
</body></html>`;

/** What the real widget produces from a served page. */
function widgetSign(html, src) {
  return html
    .replace(/<canvas class="nbd-sig-canvas"><\/canvas>/,
      `<img src="${src || PNG}" alt="Homeowner" class="nbd-sig-img" style="max-width:100%;height:auto;display:block;background:#fff;">`)
    .replace(/<div class="nbd-sig-controls">[\s\S]*?<\/span>\s*<\/div>/, '<div class="nbd-sig-date">Signed October 5, 2026</div>')
    .replace('data-nbd-sig="homeowner"', 'data-nbd-sig="homeowner" data-nbd-sig-finalized="1" data-nbd-sig-signed-at="2026-10-05T15:00:00.000Z"');
}

const GOOD_PATH = 'documents/U1/L1/d-1.html';
const VICTIM_PATH = 'documents/VICTIM/L-VICTIM/d-9.html';
const VICTIM_HTML = '<html><body><p>Victim tenant contract — $99,000</p></body></html>';

function world(extra) {
  return Object.assign({
    // email on record: createSignRequest mails only that (R3-11, 2026-10-06).
    'leads/L1': { userId: 'U1', companyId: 'C1', firstName: 'Dana', email: 'dana@example.test' },
    'leads/L-VICTIM': { userId: 'VICTIM', companyId: 'C-VICTIM' },
    'users/U2': { companyId: 'C1' },          // a teammate in U1's tenant
    'users/U3': { companyId: 'C-OTHER' },     // someone else's
  }, extra || {});
}

async function submit(failSave, opts) {
  opts = opts || {};
  const db = makeDb(world({
    'leads/L1/documents/d1': Object.assign({ name: 'Roofing Agreement', status: 'sent', htmlPath: GOOD_PATH }, opts.docExtra || {}),
    'doc_sign_tokens/TOKSAVE00001': { status: 'pending', leadId: 'L1', docId: 'd1', ownerUid: 'U1', htmlPath: GOOD_PATH, signerName: 'Dana Whitfield' },
  }), opts.failTimes);
  const original = opts.original || ORIGINAL;
  const st = makeStorage({ [GOOD_PATH]: original }, failSave);
  const s = reqRes({ token: 'TOKSAVE00001', signedHtml: widgetSign(original) });
  LOGS.length = 0; SPINE.length = 0;
  const fns = loadFn(db, st);
  await fns.submitSignature(s.req, s.res);
  const notes = [...db._store.entries()].filter(([k]) => k.startsWith('notifications/')).map(([, v]) => v);
  const activity = [...db._store.entries()].filter(([k]) => k.startsWith('leads/L1/activity/')).map(([, v]) => v);
  const reload = reqRes({ token: 'TOKSAVE00001' });
  await fns.getSignDocument(reload.req, reload.res);
  return {
    status: s.res.statusCode, body: s.res.body || {}, doc: db._store.get('leads/L1/documents/d1') || {},
    stored: st._files.get(GOOD_PATH).toString('utf8'), notes, activity, logs: LOGS.slice(),
    burned: db._store.get('doc_sign_tokens/TOKSAVE00001').status === 'signed',
    reload: { status: reload.res.statusCode, body: reload.res.body || {} },
    lead: db._store.get('leads/L1') || {}, spine: SPINE.slice(),
  };
}

// customer-documents.js row, rendered for real (the customer-doc-delete harness).
async function docRow(row) {
  const els = {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date,
    document: { addEventListener() {}, getElementById(id) { return (els[id] = els[id] || { id, innerHTML: '' }); } },
  };
  const win = sandbox; win.window = win;
  win._customerId = 'L1'; win.db = {}; win.auth = { currentUser: { uid: 'U1' } };
  win.collection = (_db, ...p) => ({ path: p.join('/') }); win.query = (c) => ({ legacy: true, ref: c });
  win.where = () => ({}); win.doc = (_db, ...p) => ({ path: p.join('/') });
  win.getDocs = async (ref) => ({ docs: (ref && ref.legacy ? [] : [row]).map(d => ({ id: d.id, data: () => d })) });
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js/customer-documents.js'), 'utf8'), sandbox, { filename: 'customer-documents.js' });
  await win.NBDCustomerDocs.load('L1');
  return els.docList.innerHTML;
}

(async () => {
  section('1. the signed record saves (unchanged behaviour)');
  {
    const r = await submit(null);
    ok('200, token burned', r.status === 200 && r.burned, r.status + ' ' + JSON.stringify(r.body));
    ok('response does not report a save failure', r.body.ok === true && r.body.saved !== false);
    ok('the stored document carries the signature', r.stored.includes('src="' + PNG + '"'));
    ok('document is not flagged', r.doc.status === 'signed' && !r.doc.signedSaveFailed);
    ok('rep notified "Document signed"', r.notes.length === 1 && r.notes[0].title === 'Document signed');
  }

  section('2. both saves of the signed record fail');
  {
    const r = await submit((p) => p === GOOD_PATH);
    ok('still 200 and the token stays burned (no double-sign)', r.status === 200 && r.burned, String(r.status));
    ok('the stored document really is the unsigned original (the bug condition)', r.stored === ORIGINAL);
    ok('response tells the page the signed copy was not saved (saved:false)', r.body.ok === true && r.body.saved === false, JSON.stringify(r.body));
    ok('document is flagged signedSaveFailed', r.doc.signedSaveFailed === true, JSON.stringify(r.doc));
    ok('rep notification does NOT say "Document signed"', r.notes.length === 1 && r.notes[0].title !== 'Document signed', r.notes[0] && r.notes[0].title);
    ok('rep notification says the signed copy was not saved (high priority)',
      r.notes.length === 1 && /not saved/i.test(r.notes[0].title + ' ' + r.notes[0].message) && r.notes[0].priority === 'high');
    ok('rep notification still opens the lead', !!r.notes[0] && r.notes[0].leadId === 'L1' && r.notes[0].userId === 'U1');
  }

  section('3. the archive save fails but the signed record saves');
  {
    const r = await submit((p) => p !== GOOD_PATH);
    ok('not flagged as a lost signature (the record itself saved)', r.body.saved !== false && !r.doc.signedSaveFailed && r.stored.includes(PNG));
  }

  section('5. review round 2 (2026-11-14)');
  {
    // M1: a successful save clears a stale flag (no client can: the signed-row lock).
    const r = await submit(null, { docExtra: { signedSaveFailed: true } });
    ok('a successful save removes a stale signedSaveFailed', r.status === 200 && !('signedSaveFailed' in r.doc), JSON.stringify(r.doc.signedSaveFailed));
    ok('…and records signedSha256 of the stored copy', /^[0-9a-f]{64}$/.test(r.doc.signedSha256 || ''));
  }
  {
    // M2: no signedSha256 for a copy that was never stored.
    const r = await submit((p) => p === GOOD_PATH);
    ok('save failed: signedSha256 is null (nothing stored to hash)', r.doc.signedSha256 === null, String(r.doc.signedSha256));
    ok('save failed: the unsaved record is hashed as unsavedRecordSha256', /^[0-9a-f]{64}$/.test(r.doc.unsavedRecordSha256 || ''));
    ok('save failed: the error log carries docId, leadId and ownerUid',
      r.logs.some((l) => l.level === 'error' && /NOT saved/.test(l.m) && l.o && l.o.docId === 'd1' && l.o.leadId === 'L1' && l.o.ownerUid === 'U1'));
    // LOW: a reload of the burned link is honest too.
    ok('save failed: reloading the link does not say "already signed" plainly',
      r.reload.status === 410 && /could not be saved/i.test(r.reload.body.error || '') && /contractor/i.test(r.reload.body.error || ''), JSON.stringify(r.reload.body));
  }
  {
    const r = await submit(null);
    ok('save ok: reloading the link still says "already signed"', r.reload.status === 410 && /already been signed/.test(r.reload.body.error || ''));
  }
  {
    // HIGH: the flag and the bell survive one failed write (retried together).
    const r = await submit((p) => p === GOOD_PATH, { failTimes: { 'leads/L1/documents/d1': 1 } });
    ok('first flag write fails: the document is still flagged (retried)', r.doc.signedSaveFailed === true, JSON.stringify(r.doc));
    ok('…and exactly one "NOT saved" bell went out', r.notes.length === 1 && /NOT saved/.test(r.notes[0].title), JSON.stringify(r.notes));
    ok('…and the failed attempt is logged at error level with the ids',
      r.logs.some((l) => l.level === 'error' && /attempt 1 of 2/.test(l.m) && l.o && l.o.docId === 'd1' && l.o.ownerUid === 'U1'), JSON.stringify(r.logs.map((l) => l.level + ' ' + l.m)));
  }
  {
    // HIGH: when the flag + bell cannot be written at all, a second channel.
    const r = await submit((p) => p === GOOD_PATH, { failTimes: { 'leads/L1/documents/d1': 9, 'notifications/': 9 } });
    ok('flag and bell both unwritable: an activity row on the lead says the copy was not saved',
      r.activity.length === 1 && /not saved/i.test(r.activity[0].label + ' ' + r.activity[0].message) && r.activity[0].docId === 'd1', JSON.stringify(r.activity));
    ok('…and every failed Firestore write is logged at error, none only at warn (Storage retries keep their warn)',
      r.logs.filter((l) => l.level === 'warn' && !/upload failed|archive failed/.test(l.m)).length === 0 && r.logs.filter((l) => l.level === 'error').length >= 3, JSON.stringify(r.logs.map((l) => l.level + ' ' + l.m)));
    ok('…and the homeowner is still told the truth (saved:false)', r.body.saved === false);
  }
  {
    const signDoc = kit.parseTags(kit.read('docs/pro/sign.html'));
    const sp = signDoc.$$('script').find((e) => /^js\/sign-page\.js/.test(e.attr('src') || ''));
    ok('sign.html cache-busts the changed sign-page.js (v=5)', !!sp && sp.attr('src') === 'js/sign-page.js?v=5', sp && sp.attr('src'));
  }

  section('6. Joe\'s decisions (2026-11-14)');
  {
    // A contract carrying the Notice of Right to Cancel, so the cancel-by
    // stamp is really exercised (no packet → no cancelBy at all).
    const KY = require(path.join(FN, 'ky-insurance-law.js'));
    const packet = KY.cancelPacketHtml({ transactionDate: '2026-01-05', timeZone: 'America/New_York', sellerName: 'No Big Deal Home Solutions',
      sellerAddress: '4400 Test Pike, Cincinnati, OH 45202', email: 'info@example.test', homeownerName: 'Dana Whitfield',
      propertyAddress: '902 Ridge Rd, Cincinnati, OH 45230', state: 'OH', kyInsurance: false });
    const WITH_PACKET = ORIGINAL.replace('</body>', packet + '\n</body>');

    const okSave = await submit(null, { original: WITH_PACKET });
    ok('fixture check: a saved signing stamps the lead cancelBy and runs the job spine',
      matches(/^\d{4}-\d{2}-\d{2}$/, okSave.lead.cancelBy) && okSave.spine.length === 1, JSON.stringify({ cancelBy: okSave.lead.cancelBy, spine: okSave.spine, status: okSave.status, body: okSave.body }));

    // 1. Save failed: the job does not advance and no screen reads "signed".
    const bad = await submit((p) => p === GOOD_PATH, { original: WITH_PACKET });
    ok('save failed: the job spine does NOT run', bad.spine.length === 0, JSON.stringify(bad.spine));
    ok('save failed: no cancel-by date is stamped on the lead', !('cancelBy' in bad.lead), JSON.stringify(bad.lead));
    ok('save failed: no cancel-by date on the document either', !('cancelBy' in bad.doc), JSON.stringify(bad.doc.cancelBy));
    ok('save failed: the document keeps its pre-signing status (not "signed")', bad.doc.status === 'sent', String(bad.doc.status));
    ok('save failed: no signedAt / signedRemotely (the CRM infers "signed" from either)', !('signedAt' in bad.doc) && !('signedRemotely' in bad.doc), JSON.stringify(bad.doc));
    ok('save failed: when the signature came in is still recorded (unsavedSignatureAt)', !!bad.doc.unsavedSignatureAt && bad.doc.signedSaveFailed === true);
    ok('save failed: the rep is still alerted', bad.notes.length === 1 && matches(/NOT saved/, bad.notes[0].title));
  }
  {
    // 2. No new link for a document that is already properly signed; a
    // document whose save failed may get one (the recovery path).
    async function mint(docExtra) {
      const db = makeDb(world({ 'leads/L1/documents/d1': Object.assign({ name: 'Roofing Agreement', htmlPath: GOOD_PATH }, docExtra) }));
      const st = makeStorage({ [GOOD_PATH]: ORIGINAL });
      const fns = loadFn(db, st);
      try {
        const v = await fns.createSignRequest({ auth: { uid: 'U1', token: {} }, data: { leadId: 'L1', docId: 'd1', signerEmail: 'dana@example.test' } });
        return { v, tokens: [...db._store.keys()].filter((k) => k.startsWith('doc_sign_tokens/')).length };
      } catch (e) { return { e, tokens: [...db._store.keys()].filter((k) => k.startsWith('doc_sign_tokens/')).length }; }
    }
    const signed = await mint({ status: 'signed', signedAt: 'FV:ts' });
    ok('already signed: createSignRequest refuses (failed-precondition) and mints no token',
      !!signed.e && signed.e.code === 'failed-precondition' && signed.tokens === 0, signed.e ? signed.e.code + ' ' + signed.e.message : 'minted');
    ok('…with a message that says it is already signed', !!signed.e && /already signed/i.test(signed.e.message));
    const signedAtOnly = await mint({ signedAt: 'FV:ts' });
    ok('a legacy row with only signedAt is refused too', !!signedAtOnly.e && signedAtOnly.tokens === 0);
    const recover = await mint({ status: 'sent', signedSaveFailed: true, unsavedSignatureAt: 'FV:ts' });
    ok('save failed: a new link CAN be minted (recovery path)', !recover.e && recover.tokens === 1, recover.e ? recover.e.message : '');
    const stale = await mint({ status: 'signed', signedAt: 'FV:ts', signedSaveFailed: true });
    ok('a signed row that also carries signedSaveFailed may be re-sent (recovery)', !stale.e && stale.tokens === 1, stale.e ? stale.e.message : '');
    const fresh = await mint({ status: 'draft' });
    ok('an unsigned draft still mints', !fresh.e && fresh.tokens === 1, fresh.e ? fresh.e.message : '');
  }

  section('4. the homeowner and the rep see it');
  {
    // One pin: a saved === false branch whose message names the contractor and
    // never says "All done" or "recorded", before the ordinary success branch.
    ok('sign page has a saved === false branch: names the contractor, no "All done" / "recorded"',
      /if \(r\.ok && r\.data\.ok && r\.data\.saved === false\) \{(?:(?!All done|recorded|\} else)[\s\S])*contractor(?:(?!All done|recorded|\} else)[\s\S])*\} else if \(r\.ok && r\.data\.ok\)/i.test(kit.read('docs/pro/js/sign-page.js')));

    // The CRM documents row warns (Joe 2026-11-14: put it back; the boot-budget
    // raise rides with it until the conductor's own raise lands).
    // The row as submitSignature now leaves it: status unchanged ('sent'), the flag set.
    const rowWarn = await docRow({ id: 'd1', name: 'Roofing Agreement', status: 'sent', signedSaveFailed: true, htmlPath: GOOD_PATH });
    ok('CRM documents row warns the signed copy was not saved', matches(/not saved/i, rowWarn), rowWarn.slice(0, 300));
    ok('…and does not show "✓ Signed" or plain "Awaiting signature"', !matches(/✓ Signed|Awaiting signature/, rowWarn));
    // A row flagged under the round-2 shape (status signed) warns too.
    const rowWarn2 = await docRow({ id: 'd1', name: 'Roofing Agreement', status: 'signed', signedRemotely: true, signedSaveFailed: true, htmlPath: GOOD_PATH });
    ok('a flagged row stamped signed also warns, not "✓ Signed"', matches(/not saved/i, rowWarn2) && !matches(/✓ Signed/, rowWarn2));
    const rowOk = await docRow({ id: 'd1', name: 'Roofing Agreement', status: 'signed', signedRemotely: true, htmlPath: GOOD_PATH });
    ok('a normally signed row still shows "✓ Signed"', matches(/✓ Signed/, rowOk) && !matches(/not saved/i, rowOk));
  }

  console.log('\n' + (failed === 0 ? '✓' : '✗') + ' remote-sign save failure: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) { console.error('FAILED: ' + fails.join(', ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
