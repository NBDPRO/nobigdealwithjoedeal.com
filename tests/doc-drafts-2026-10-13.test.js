/**
 * doc-drafts-2026-10-13.test.js — stage-triggered auto-draft docs + the
 * "Docs to review" queue (Jo, 2026-10-13: "nothing is sent without my review").
 *
 *   A. the plan table: event -> draft kinds, and each kind's sendEmail `kind`
 *      (the thank-you / review ask has NONE; every other kind is on the
 *      transactional allowlist in functions/email-suppression.js);
 *   B. wording: tenant branding (a second company gets ITS name/phone, never
 *      NBD's), [[placeholders]] for the unknown, the warranty email's two
 *      separate warranty lines, TIER_LABOR_YEARS pinned to estimate-config.js,
 *      no insurance-claim wording (claim-wording-filter, with a positive
 *      control), no hardcoded legal entity;
 *   C. receipt amount in cents from the lead's paid invoices;
 *   D. the skip matrix (quiet backfill, lost, deleted, review declined,
 *      warranty visit, tenant mismatch, not paid in full);
 *   E. idempotency with a fake Firestore: re-run creates nothing, an edited /
 *      sent / dismissed draft is never overwritten;
 *   F. the spine hook: recordJobEvent drafts on installed/paid_in_full/
 *      contract_signed, and a throwing drafter never breaks the event;
 *   G. the queue UI: placeholder + unsubscribe + STOP blocking (each with a
 *      positive control), strict-CSP source rules.
 *
 * Run: node tests/doc-drafts-2026-10-13.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
function tryReq(p) { try { return require(path.join(ROOT, p)); } catch (e) { console.log('  (cannot load ' + p + ': ' + e.message + ')'); return null; } }

const DL = tryReq('functions/doc-drafts-logic.js');
const DDF = tryReq('functions/doc-drafts.js');
const SPINE = tryReq('functions/job-spine.js');
const SUPP = tryReq('functions/email-suppression.js');
const CW = tryReq('docs/pro/js/claim-wording-filter.js');
const UI = tryReq('docs/pro/js/doc-drafts-ui.js');

const NBD_UID = DL ? DL.NBD_OWNER_UID : 'nbd';
const NOW = Date.parse('2026-10-13T15:00:00Z');

// A tenant companyProfile, shaped like the real one (brand.contact.phone ...).
const profileOf = (name, phone, review) => ({ brand: { displayName: name, contact: { phone, email: 'o@x.test' }, integrations: { reviewUrl: review === undefined ? 'https://example.test/r' : review } } });
const OAKS = profileOf('Oaks Roofing', '(555) 010-0101', 'https://oaks.example.test/review');
const NBDP = profileOf('No Big Deal', '(859) 420-7382', 'https://nobigdealwithjoedeal.com/r');
const leadOf = (o) => Object.assign({ userId: 'u1', companyId: 'u1', stage: 'install_complete', firstName: 'Pat', lastName: 'Jones', email: 'pat@x.test', phone: '555', soldTier: 'better', jobType: 'cash', address: '123 Main St, Cincinnati, OH 45202' }, o || {});

// ── fake Firestore (docs by path; create() is create-only) ───────────────
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const writes = [];
  const hooks = { failCreate: null, failInvoices: false };
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const apply = (cur, patch) => Object.assign({}, cur, patch);
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    collection: (c) => col(p + '/' + c),
    async get() { const d = store.get(p); return { exists: d !== undefined, data: () => (d === undefined ? undefined : clone(d)) }; },
    async update(patch) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); writes.push(['update', p, patch]); store.set(p, apply(store.get(p), patch)); },
    async set(data) { writes.push(['set', p, data]); store.set(p, clone(data)); },
    async create(data) {
      if (hooks.failCreate && hooks.failCreate.test(p)) throw new Error('simulated write failure');
      if (store.has(p)) { const e = new Error('6 ALREADY_EXISTS: ' + p); e.code = 6; throw e; }
      writes.push(['create', p, data]); store.set(p, clone(data));
    },
  });
  const query = (c, filters) => ({
    where: (f, op, v) => query(c, filters.concat([[f, v]])),
    limit: () => query(c, filters),
    async get() {
      if (hooks.failInvoices && c === 'invoices') throw new Error('simulated read failure');
      const docs = [];
      for (const [k, v] of store) {
        const parts = k.split('/');
        if (parts.length !== c.split('/').length + 1 || !k.startsWith(c + '/')) continue;
        if (filters.every(([f, val]) => v[f] === val)) docs.push({ id: parts[parts.length - 1], data: () => clone(v) });
      }
      return { docs };
    },
  });
  const col = (c) => Object.assign({ doc: (id) => ref(c + '/' + id) }, query(c, []));
  return {
    store, writes, hooks, collection: col, doc: (p) => ref(p),
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        get: (r) => r.get(),
        create: (r, d) => pending.push(() => { if (store.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store.set(r.path, clone(d)); }),
        set: (r, d) => pending.push(() => { store.set(r.path, clone(d)); }),
        update: (r, p) => pending.push(() => { store.set(r.path, apply(store.get(r.path), p)); }),
      };
      const out = await fn(tx);
      pending.forEach((f) => f());
      return out;
    },
  };
}
const FV = { serverTimestamp: () => '__TS__', arrayUnion: (...x) => ({ __union: x }) };
const quiet = { info() {}, warn() {}, error() {} };
const deps = { FieldValue: FV, logger: quiet, now: () => NOW };
const draftsIn = (db, leadId) => [...db.store.keys()].filter((k) => k.startsWith('leads/' + (leadId || 'L1') + '/doc_drafts/'));
const kindsOf = (db, leadId) => draftsIn(db, leadId).map((k) => db.store.get(k).kind).sort();

(async () => {
  console.log('\nA. plan table + kind mapping');
  if (DL && SUPP) {
    ok('contract_signed + deal_accepted -> schedule_confirm',
      JSON.stringify(DL.planFor('contract_signed')) === '["schedule_confirm"]' && JSON.stringify(DL.planFor('deal_accepted')) === '["schedule_confirm"]');
    ok('scheduled -> crew_reminder', JSON.stringify(DL.planFor('scheduled')) === '["crew_reminder"]');
    ok('installed -> warranty + thank_you (the final invoice stays deposit-draft.js\'s)', JSON.stringify(DL.planFor('installed')) === '["warranty","thank_you"]');
    ok('paid_in_full -> paid_receipt (the Request Review task stays job-spine\'s)', JSON.stringify(DL.planFor('paid_in_full')) === '["paid_receipt"]');
    ok('other events plan nothing (booked, estimate_shared, deposit_paid...)',
      ['booked', 'inspected', 'estimate_shared', 'deposit_paid', 'lead_created', '', 'nope'].every((e) => DL.planFor(e).length === 0));
    ok('the review ask (thank_you) has NO email kind -> commercial on the server', DL.DRAFT_KINDS.thank_you.emailKind === '' && SUPP.resolveCategory({ kind: DL.DRAFT_KINDS.thank_you.emailKind }) === SUPP.CATEGORY.COMMERCIAL);
    const others = Object.keys(DL.DRAFT_KINDS).filter((k) => k !== 'thank_you');
    ok('every other kind is on the server\'s transactional allowlist',
      others.length === 4 && others.every((k) => SUPP.TRANSACTIONAL_KINDS.indexOf(DL.DRAFT_KINDS[k].emailKind) !== -1));
    ok('receipt -> receipt, warranty -> document, schedule + crew -> appointment',
      DL.DRAFT_KINDS.paid_receipt.emailKind === 'receipt' && DL.DRAFT_KINDS.warranty.emailKind === 'document'
      && DL.DRAFT_KINDS.schedule_confirm.emailKind === 'appointment' && DL.DRAFT_KINDS.crew_reminder.emailKind === 'appointment');
    ok('deterministic id: ddraft_<lead>_<kind>_<job>', DL.draftId('L1', 'warranty', 'j9') === 'ddraft_L1_warranty_j9' && DL.draftId('L1', 'warranty', null) === 'ddraft_L1_warranty_job');
    // the pure decision carries the same kind onto the document
    const d = DL.decide({ leadId: 'L1', event: 'installed', kind: 'thank_you', lead: leadOf(), profile: OAKS, tenantKey: 'u1', jobId: 'j1' });
    ok('decide(): thank_you doc carries emailKind "" and status draft', d.action === 'create' && d.doc.emailKind === '' && d.doc.status === 'draft');
    ok('decide(): a kind not planned for the event is refused', DL.decide({ leadId: 'L1', event: 'paid_in_full', kind: 'warranty', lead: leadOf() }).reason === 'not_planned');
  }

  console.log('\nB. wording + tenant branding');
  if (DL) {
    const ctxOf = (profile, key, lead) => ({ lead: lead || leadOf(), brand: DL.brandOf(profile, key), tier: (lead || leadOf()).soldTier, paidCents: 1234567 });
    const kinds = Object.keys(DL.DRAFT_KINDS);
    const oaks = kinds.map((k) => DL.build(k, ctxOf(OAKS, 'oaks-co')));
    ok('a second tenant gets ITS name and phone in every draft',
      oaks.every((t) => t.subject.indexOf('Oaks Roofing') !== -1 || t.body.indexOf('Oaks Roofing') !== -1)
      && oaks.every((t) => t.body.indexOf('(555) 010-0101') !== -1));
    ok('…and NBD\'s name / phone / domain never leak onto it',
      oaks.every((t) => !/no big deal|nbd|859|nobigdeal/i.test(t.subject + ' ' + t.body)));
    ok('NBD\'s own profile drives NBD\'s drafts (name + phone from the profile, not the code)',
      DL.build('crew_reminder', ctxOf(NBDP, NBD_UID)).body.indexOf('(859) 420-7382') !== -1);
    const src = fs.readFileSync(path.join(ROOT, 'functions/doc-drafts-logic.js'), 'utf8');
    const code = stripComments(src);
    ok('the logic file hardcodes no company name, phone or legal entity',
      !/No Big Deal|Home Solutions|420-7382|nobigdealwithjoedeal|\bNBD\b/.test(code.replace(/NBD_OWNER_UID|isNbd|NBD_/g, '')));
    const noProfile = DL.build('thank_you', ctxOf(null, 'u1'));
    ok('no profile -> [[company name]] / [[company phone]] / [[review link]] placeholders (blocks Send)',
      /\[\[company name\]\]/.test(noProfile.subject + noProfile.body) && /\[\[company phone\]\]/.test(noProfile.body) && /\[\[review link\]\]/.test(noProfile.body));
    ok('control: a configured tenant has none of those placeholders', DL.placeholdersIn(oaks[3].subject + oaks[3].body).length === 0);
    ok('a non-https review link is not used (placeholder instead)', /\[\[review link\]\]/.test(DL.build('thank_you', ctxOf(profileOf('X Co', '1', 'javascript:alert(1)'), 'x')).body));

    // warranty: two separate lines, nothing invented
    const wNbd = (tier) => DL.build('warranty', ctxOf(NBDP, NBD_UID, leadOf({ soldTier: tier }))).body;
    ok('NBD + better -> 10-year written labor line AND a separate manufacturer line', /Workmanship \(labor\) warranty: 10 years/.test(wNbd('better')) && /Manufacturer warranty \(separate/.test(wNbd('better')));
    ok('NBD + economy -> 1 year labor, manufacturer limited only, NO system warranty', /labor\) warranty: 1 year /.test(wNbd('economy')) && /No system warranty/.test(wNbd('economy')));
    ok('NBD + beyond -> 20 years labor, TAMKO HailGuard on its own line', /labor\) warranty: 20 years/.test(wNbd('beyond')) && /TAMKO HailGuard/.test(wNbd('beyond')));
    ok('economy never claims a system / 10-year warranty (positive control: better does name 10)', !/10 years|System Plus/i.test(wNbd('economy')) && /10 years/.test(wNbd('better')));
    const wNone = DL.build('warranty', ctxOf(NBDP, NBD_UID, leadOf({ soldTier: '' }))).body;
    ok('a job with no sold tier (a repair) -> [[workmanship warranty term]] placeholder, no invented years', /\[\[workmanship warranty term/.test(wNone) && !/\d+ years? from the installation/.test(wNone));
    const wOaks = DL.build('warranty', ctxOf(OAKS, 'oaks-co', leadOf({ soldTier: 'best' }))).body;
    ok('another company never inherits NBD\'s tier years (placeholder instead)', /\[\[workmanship warranty term/.test(wOaks) && !/20 years/.test(wOaks));
    ok('the email says the signed paperwork controls', /signed paperwork[^.]*control/.test(wNbd('good')));
    ok('no "lifetime", no Pledge promise, no "licensed", no in-house claim in any draft',
      kinds.every((k) => !/lifetime|pledge|licensed|in-house|our own crew|w-?2/i.test(DL.build(k, ctxOf(NBDP, NBD_UID)).body)));
    // TIER_LABOR_YEARS pinned to the one source
    const ctx = vm.createContext({ window: {} }); ctx.window.window = ctx.window;
    vm.runInContext(read('docs/pro/js/estimate-config.js'), ctx, { filename: 'estimate-config.js' });
    const real = ctx.window.NBD_ESTIMATE_CONFIG && ctx.window.NBD_ESTIMATE_CONFIG.TIER_LABOR_YEARS;
    ok('TIER_LABOR_YEARS copy == estimate-config.js (control: it is non-empty)', !!real && JSON.stringify(real) === JSON.stringify(DL.TIER_LABOR_YEARS) && Object.keys(real).length === 5, JSON.stringify(real));

    // Kentucky insurance job: no claim wording anywhere
    if (CW) {
      const ky = leadOf({ jobType: 'insurance', address: '9 Pike St, Florence, KY 41042', soldTier: 'good' });
      const texts = kinds.map((k) => { const t = DL.build(k, ctxOf(NBDP, NBD_UID, ky)); return t.subject + '\n\n' + t.body; });
      ok('KY insurance job: every draft passes the claim-wording gate', texts.every((t) => CW.scanText(t).length === 0), JSON.stringify(texts.map((t) => CW.scanText(t))));
      ok('…and none mentions a claim, adjuster, deductible or insurer', texts.every((t) => !/\b(claims?|adjusters?|deductibles?|insur\w*|supplements?)\b/i.test(t)));
      ok('control: the gate DOES flag a claim-handling sentence', CW.scanText('We will handle your insurance claim for you and negotiate with the adjuster.').length > 0);
    }
    ok('the money formatter is integer cents ($1,234,567.89; $0.05)', DL.fmtCents(123456789) === '$1,234,567.89' && DL.fmtCents(5) === '$0.05' && DL.fmtCents(0.1 * 3 * 100) === '$0.30');
    ok('schedule wording from lead.scheduledDate / scheduledStart', DL.scheduleOf({ scheduledDate: '2026-10-21', scheduledStart: '07:30' }) === 'Wednesday, October 21 at 7:30 AM' && DL.scheduleOf({}) === '' && DL.scheduleOf({ scheduledDate: '2026-02-31' }) === '');
    ok('crew reminder with no date -> [[install date]] placeholder', /\[\[install date\]\]/.test(DL.build('crew_reminder', ctxOf(OAKS, 'oaks-co')).body));
    ok('crew reminder with a date names it', /Wednesday, October 21/.test(DL.build('crew_reminder', ctxOf(OAKS, 'oaks-co', leadOf({ scheduledDate: '2026-10-21' }))).body));
  }

  console.log('\nC. channel (email vs copy)');
  if (DL) {
    ok('email on file -> one-click email', DL.channelFor(leadOf()) === 'email');
    ok('Thumbtack customer -> COPY even with an email', DL.channelFor(leadOf({ source: 'Thumbtack' })) === 'copy' && DL.channelFor(leadOf({ leadSource: 'yelp_leads' })) === 'copy');
    ok('phone-only customer -> COPY', DL.channelFor(leadOf({ email: '' })) === 'copy' && DL.channelFor(leadOf({ email: 'not-an-email' })) === 'copy');
    const d = DL.decide({ leadId: 'L1', event: 'paid_in_full', kind: 'paid_receipt', lead: leadOf({ source: 'Thumbtack' }), profile: OAKS, tenantKey: 'u1', jobId: 'j1', paidCents: 100 });
    ok('a copy draft stores no recipient', d.action === 'create' && d.doc.channel === 'copy' && d.doc.to === '');
  }

  console.log('\nD. skips + idempotency (fake Firestore)');
  if (DDF && DL) {
    const seed = (lead, extra) => Object.assign({ 'leads/L1': lead || leadOf({ activeJobId: 'j1' }), 'companyProfile/u1': OAKS }, extra || {});
    const run = (db, event, o) => DDF.draftDocsForEvent(db, Object.assign({ leadId: 'L1', event }, o || {}), deps);

    let db = makeDb(seed());
    let r = await run(db, 'installed');
    ok('installed -> warranty + thank_you drafted, status draft, nothing else written',
      r.created.length === 2 && JSON.stringify(kindsOf(db)) === '["thank_you","warranty"]'
      && draftsIn(db).every((k) => db.store.get(k).status === 'draft')
      && db.writes.every((w) => w[0] === 'create' && /\/doc_drafts\//.test(w[1])));
    const warrantyId = 'leads/L1/doc_drafts/ddraft_L1_warranty_j1';
    ok('the draft is shaped for the queue (to, subject, body, kind, event, jobId, tenant stamps)',
      (() => { const x = db.store.get(warrantyId); return x && x.to === 'pat@x.test' && x.event === 'installed' && x.jobId === 'j1' && x.companyId === 'u1' && x.userId === 'u1' && x.emailKind === 'document' && x.createdAt === '__TS__' && /Oaks Roofing/.test(x.subject); })());

    // idempotency
    db.store.get(warrantyId).body = 'Pat — I edited this myself.';
    db.store.get('leads/L1/doc_drafts/ddraft_L1_thank_you_j1').status = 'sent';
    const before = JSON.stringify([...db.store.entries()]);
    r = await run(db, 'installed');
    ok('re-run: nothing created, both reported existing', r.created.length === 0 && r.existing.length === 2);
    ok('re-run: an EDITED draft and a SENT draft are untouched byte-for-byte', JSON.stringify([...db.store.entries()]) === before && db.store.get(warrantyId).body === 'Pat — I edited this myself.');
    db.store.get(warrantyId).status = 'dismissed';
    await run(db, 'installed');
    ok('re-run: a DISMISSED draft is not resurrected', db.store.get(warrantyId).status === 'dismissed' && draftsIn(db).length === 2);

    // skip matrix
    const skipCase = async (label, lead, expectReason, extraSeed, event, kindsExpected) => {
      const d = makeDb(seed(lead, extraSeed));
      const o = await run(d, event || 'installed');
      ok(label, draftsIn(d).length === (kindsExpected || 0) && (expectReason === null || o.reason === expectReason || o.skipped.some((s) => s.reason === expectReason)), JSON.stringify(o));
    };
    await skipCase('quiet "Already completed" backfill -> nothing queued',
      leadOf({ activeJobId: 'j1', completedBackfill: true, stageHistory: [{ to: 'install_complete', backfill: true }] }), 'quiet_backfill');
    await skipCase('control: the same lead WITHOUT the backfill flag is queued',
      leadOf({ activeJobId: 'j1', stageHistory: [{ to: 'install_complete' }] }), null, null, 'installed', 2);
    await skipCase('lost lead -> nothing', leadOf({ activeJobId: 'j1', stage: 'lost' }), 'lost');
    await skipCase('deleted lead -> nothing', leadOf({ activeJobId: 'j1', deleted: true }), 'deleted');
    await skipCase('warranty-visit job -> nothing', leadOf({ activeJobId: 'j1', jobType: 'warranty' }), 'warranty_visit');
    await skipCase('reviewAskDeclined -> NO thank-you, the warranty summary still queues',
      leadOf({ activeJobId: 'j1', reviewAskDeclined: true }), 'review_declined', null, 'installed', 1);
    {
      const d = makeDb(seed(leadOf({ activeJobId: 'j1', reviewAskDeclined: true })));
      await run(d, 'installed');
      ok('…and the surviving one is the warranty', JSON.stringify(kindsOf(d)) === '["warranty"]');
    }
    {
      const d = makeDb(seed());
      const o = await run(d, 'installed', { companyId: 'someone-else' });
      ok('tenant mismatch (event for another company) -> nothing', o.reason === 'tenant_mismatch' && draftsIn(d).length === 0);
    }
    {
      const d = makeDb({});
      const o = await run(d, 'installed');
      ok('no such lead -> nothing, no throw', o.reason === 'no_lead' && draftsIn(d).length === 0);
      const bad = await DDF.draftDocsForEvent(d, { leadId: '../x', event: 'installed' }, deps);
      ok('a malformed lead id is refused', bad.reason === 'bad_lead_id');
    }
    {
      const throwing = { collection() { throw new Error('boom'); } };
      let threw = false; let o;
      try { o = await DDF.draftDocsForEvent(throwing, { leadId: 'L1', event: 'installed' }, deps); } catch (_) { threw = true; }
      ok('a Firestore failure never throws (the spine\'s event already counted)', !threw && o && o.reason === 'error');
    }

    // paid receipt — cents from the lead's paid invoices
    const inv = (id, o) => ['invoices/' + id, Object.assign({ leadId: 'L1', companyId: 'u1', userId: 'u1', status: 'paid', total: 100, amountPaid: 100, jobId: 'j1' }, o || {})];
    const paidSeed = (invoices, lead) => Object.assign(seed(lead || leadOf({ activeJobId: 'j1', stage: 'final_payment' })), Object.fromEntries(invoices));
    {
      const d = makeDb(paidSeed([inv('i1', { total: 4620.1, amountPaid: 4620.1 }), inv('i2', { total: 10.05, amountPaid: 10.05 })]));
      await run(d, 'paid_in_full');
      const x = d.store.get('leads/L1/doc_drafts/ddraft_L1_paid_receipt_j1');
      ok('paid_in_full -> receipt with the summed paid amount in cents ($4,630.15), kind receipt',
        !!x && /\$4,630\.15/.test(x.body) && x.emailKind === 'receipt', x && x.body);
    }
    {
      // 1.15 * 100 === 114.99999999999999 in IEEE-754: a dollars-float receipt prints $1.14.
      const d = makeDb(paidSeed([inv('i1', { total: 1.15, amountPaid: 1.15 })]));
      await run(d, 'paid_in_full');
      const x = d.store.get('leads/L1/doc_drafts/ddraft_L1_paid_receipt_j1');
      ok('float trap: $1.15 prints $1.15, not $1.14 (cents math)', !!x && /\$1\.15\b/.test(x.body) && !/\$1\.14/.test(x.body), x && x.body);
    }
    {
      const d = makeDb(paidSeed([inv('i1', { total: 500, amountPaid: 500 }), inv('i3', { status: 'sent', total: 900, amountPaid: 0 })]));
      const o = await run(d, 'paid_in_full');
      ok('a balance still owed -> no "paid in full" receipt', draftsIn(d).length === 0 && o.skipped.some((s) => s.reason === 'not_paid_in_full'), JSON.stringify(o));
    }
    {
      const d = makeDb(paidSeed([inv('i1', { total: 500, amountPaid: 500 }), inv('x1', { total: 9999, amountPaid: 9999, companyId: 'other' })]));
      await run(d, 'paid_in_full');
      const x = d.store.get('leads/L1/doc_drafts/ddraft_L1_paid_receipt_j1');
      ok('another tenant\'s invoice never counts toward the receipt', !!x && /\$500\.00/.test(x.body) && !/9,999/.test(x.body));
    }
    {
      const d = makeDb(paidSeed([], leadOf({ activeJobId: 'j1', stage: 'final_payment' })));
      await run(d, 'paid_in_full');
      const x = d.store.get('leads/L1/doc_drafts/ddraft_L1_paid_receipt_j1');
      ok('no money found on a paid-stage lead -> [[amount paid]] placeholder, never $0.00', !!x && /\[\[amount paid\]\]/.test(x.body) && !/\$0\.00/.test(x.body));
    }
    // contract signed
    {
      const d = makeDb(seed(leadOf({ activeJobId: 'j1', stage: 'contract_signed' })));
      await run(d, 'contract_signed');
      await run(d, 'deal_accepted');
      ok('contract_signed then deal_accepted -> ONE schedule confirmation for the job', JSON.stringify(kindsOf(d)) === '["schedule_confirm"]');
    }
    // crew scheduled (no spine emitter exists — the trigger calls the drafter)
    {
      const d = makeDb(seed(leadOf({ activeJobId: 'j1', stage: 'crew_scheduled', scheduledDate: '2026-10-21' })));
      await run(d, 'scheduled');
      ok('scheduled -> crew date email naming the date', JSON.stringify(kindsOf(d)) === '["crew_reminder"]' && /Wednesday, October 21/.test(d.store.get('leads/L1/doc_drafts/ddraft_L1_crew_reminder_j1').body));
      const trig = stripComments(read('functions/install-final-invoice.js'));
      ok('the lead trigger drafts the crew email when a lead ENTERS Crew Scheduled', /enteredStage\(before, after, 'crew_scheduled'\)[\s\S]{0,400}draftDocsForEvent/.test(trig) && /event: 'scheduled'/.test(trig));
      const emitters = fs.readdirSync(path.join(ROOT, 'functions')).filter((f) => /\.js$/.test(f))
        .filter((f) => /event:\s*'scheduled'/.test(read('functions/' + f)));
      ok('finding pinned: the spine\'s own recordJobEvent never receives a "scheduled" event from the CRM (only the trigger above drafts it)',
        emitters.every((f) => f === 'install-final-invoice.js'), emitters.join(','));
    }
  }

  console.log('\nE. the job spine hook');
  if (SPINE && DL) {
    const spineDeps = Object.assign({}, deps, { depositDraft: false, signedPrice: false, finalDraft: false, reviewTask: false });
    const lead = leadOf({ activeJobId: 'j1', stage: 'install_in_progress' });
    {
      const db = makeDb({ 'leads/L1': lead, 'companyProfile/u1': OAKS });
      const out = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'installed', sourceId: 'stage_install_complete_j1', companyId: 'u1' }, spineDeps);
      ok('recordJobEvent(installed) queues warranty + thank-you', out.docDrafts && out.docDrafts.created.length === 2 && JSON.stringify(kindsOf(db)) === '["thank_you","warranty"]', JSON.stringify(out.docDrafts));
      const again = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'installed', sourceId: 'stage_install_complete_j1', companyId: 'u1' }, spineDeps);
      ok('a duplicate event (retry) creates no second draft', draftsIn(db).length === 2 && (!again.docDrafts || again.docDrafts.created.length === 0));
    }
    {
      const db = makeDb({ 'leads/L1': lead });
      const out = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'booked', sourceId: 'b1' }, spineDeps);
      ok('an event with no plan (booked) drafts nothing', draftsIn(db).length === 0 && !out.docDrafts);
    }
    {
      const db = makeDb({ 'leads/L1': lead });
      const boom = Object.assign({}, spineDeps, { draftDocsForEvent: async () => { throw new Error('drafter exploded'); } });
      let threw = false; let out;
      try { out = await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'installed', sourceId: 's' }, boom); } catch (_) { threw = true; }
      ok('a throwing drafter never breaks the spine event', !threw && out && out.docDrafts && out.docDrafts.reason === 'error');
    }
    {
      const db = makeDb({ 'leads/L1': lead });
      const off = Object.assign({}, spineDeps, { docDrafts: false });
      await SPINE.recordJobEvent(db, { leadId: 'L1', event: 'installed', sourceId: 's' }, off);
      ok('control: deps.docDrafts === false switches it off', draftsIn(db).length === 0);
    }
    const sp = stripComments(read('functions/job-spine.js'));
    ok('the spine hook never sends (no sendEmail / Resend / NBDComms in doc-drafts*.js)',
      !/sendEmail|Resend|resend\.|NBDComms|sendSMS|twilio/i.test(stripComments(read('functions/doc-drafts.js')) + stripComments(read('functions/doc-drafts-logic.js'))));
    ok('the hook is wired next to the existing drafts', /DRAFT_EVENTS\.indexOf\(event\)[\s\S]{0,200}draftDocsForEvent/.test(sp));
  }

  console.log('\nF. the queue UI');
  if (UI) {
    const draftE = { channel: 'email', to: 'pat@x.test', emailKind: 'document' };
    const clean = { subject: 'Your warranty', body: 'Hi Pat,\n\nAll good.' };
    ok('control: a clean transactional draft has no blockers', UI.sendBlockers(draftE, clean, {}, {}).length === 0);
    ok('a [[placeholder]] in the body blocks Send', UI.sendBlockers(draftE, { subject: 'S', body: 'Date: [[install date]]' }, {}, {}).length === 1);
    ok('a [[placeholder]] in the SUBJECT blocks Send too', UI.sendBlockers(draftE, { subject: 'Hi [[company name]]', body: 'x' }, {}, {}).length === 1);
    ok('filling the placeholder unblocks it', UI.sendBlockers(draftE, { subject: 'S', body: 'Date: Tuesday' }, {}, {}).length === 0);
    ok('copy-channel draft (Thumbtack / phone-only) can never be sent', UI.sendBlockers({ channel: 'copy', to: '', emailKind: 'receipt' }, clean, {}, {}).length > 0);
    ok('do-not-contact blocks every kind', UI.sendBlockers(draftE, clean, { doNotContact: true }, {}).length > 0 && UI.sendBlockers({ channel: 'email', to: 'a@b.co', emailKind: '' }, clean, { dnc: true }, {}).length > 0);
    const review = { channel: 'email', to: 'pat@x.test', emailKind: '' };
    ok('review ask (commercial): unsubscribed -> blocked', UI.sendBlockers(review, clean, {}, { suppressed: true }).length > 0);
    ok('review ask (commercial): STOP -> blocked', UI.sendBlockers(review, clean, { smsOptedOut: true }, {}).length > 0);
    ok('control: review ask with neither is clear', UI.sendBlockers(review, clean, {}, {}).length === 0);
    ok('warranty / receipt (transactional) still send to an unsubscribed address',
      UI.sendBlockers(draftE, clean, { smsOptedOut: true }, { suppressed: true }).length === 0 && UI.sendBlockers({ channel: 'email', to: 'a@b.co', emailKind: 'receipt' }, clean, {}, { suppressed: true }).length === 0);
    ok('an emptied message is blocked', UI.sendBlockers(draftE, { subject: 'S', body: '   ' }, {}, {}).length > 0);
    ok('timeline line names the subject and the kind', /Emailed: "Hi" — Warranty summary/.test(UI.timelineText({ label: 'Warranty summary' }, 'Hi', 'emailed')));

    const src = read('docs/pro/js/doc-drafts-ui.js');
    const code = stripComments(src);
    ok('strict CSP: no inline handlers, no innerHTML / insertAdjacentHTML / document.write / eval in the queue UI',
      !/\bon[a-z]+\s*=\s*["']/i.test(code) && !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(code));
    ok('send passes leadId and the draft\'s kind to NBDComms.sendEmail, and the kind is omitted when empty (commercial)',
      /leadId: data\.leadId/.test(code) && /if \(kind\) payload\.kind = kind/.test(code) && /data\.emailKind \|\| undefined/.test(code));
    ok('a draft is marked sent only when the PLATFORM sent it (not a mail-app handoff)', /r\.success && r\.mode === 'platform'[\s\S]{0,80}finish\('emailed'\)/.test(code));
    ok('44px targets + font-size 16px inputs (iOS no-zoom)', /minHeight: '44px'/.test(code) && /fontSize: '16px'/.test(code));
    ok('the client writes only status / subject / body / sentAt / dismissedAt to the draft',
      (code.match(/save\(\{[^}]*\}\)/g) || []).every((c) => /^save\(\{ (status|subject|body|sentAt|dismissedAt)/.test(c)) && !/updateDoc\([^)]*,\s*\{[^}]*\b(to|emailKind|companyId|userId|leadId)\s*:/.test(code));
    const kick = stripComments(read('docs/pro/js/customer-bootstrap.module.js'));
    ok('lazy-loaded from the customer page (ScriptLoader.load) — not an eager <script> tag',
      /_kickDocDrafts\(lead, id\)/.test(kick) && /SL\.load\('js\/doc-drafts-ui\.js\?v=1'\)/.test(kick) && !/doc-drafts-ui\.js/.test(read('docs/pro/customer.html')) && !/doc-drafts-ui\.js/.test(read('docs/pro/dashboard.html')));
    ok('viewers never load the queue', /role === 'viewer'[\s\S]{0,60}return/.test(kick.slice(kick.indexOf('function _kickDocDrafts'))));
  }

  console.log('\nG. review round 1 (silent-failure findings)');
  if (DDF && DL && UI) {
    const seedL = (lead) => ({ 'leads/L1': lead, 'companyProfile/u1': OAKS });
    const run = (db, event, o) => DDF.draftDocsForEvent(db, Object.assign({ leadId: 'L1', event }, o || {}), deps);
    // (2) one kind's failure is recorded and does not abort the others
    {
      const db = makeDb(seedL(leadOf({ activeJobId: 'j1' })));
      db.hooks.failCreate = /ddraft_L1_thank_you_/;
      const o = await run(db, 'installed');
      const m = db.store.get('leads/L1/doc_drafts/ddfail_installed_thank_you_j1');
      ok('a failed create is filed as a status:failed marker, not just logged', !!m && m.status === 'failed', JSON.stringify(o));
      ok('...and the OTHER planned kind still got its draft', db.store.has('leads/L1/doc_drafts/ddraft_L1_warranty_j1'));
      ok('...and the result says which kind failed', !!(o.failed && o.failed.some((f) => f.kind === 'thank_you')), JSON.stringify(o));
    }
    {
      const db = makeDb(seedL(leadOf({ activeJobId: 'j1', stage: 'final_payment' })));
      db.hooks.failInvoices = true;
      const o = await run(db, 'paid_in_full');
      ok('an invoice-read failure files a paid_receipt marker and does not throw', db.store.has('leads/L1/doc_drafts/ddfail_paid_in_full_paid_receipt_j1') && !!o.failed && o.failed.length === 1, JSON.stringify(o));
    }
    // (4) no activeJobId: a later job does not collide with the first
    {
      const a = leadOf({ stageStartedAt: { seconds: Date.parse('2026-10-13T15:00:00Z') / 1000 } });
      const b = leadOf({ stageStartedAt: { seconds: Date.parse('2026-12-02T15:00:00Z') / 1000 } });
      const db = makeDb(seedL(a));
      await run(db, 'installed');
      await run(db, 'installed');
      ok('no job id: same stage entry retried -> still one set of drafts', draftsIn(db).length === 2);
      db.store.set('leads/L1', JSON.parse(JSON.stringify(b)));
      await run(db, 'installed');
      ok('no job id: a LATER job (new stage entry) gets its own drafts instead of a silent collision', draftsIn(db).length === 4, String(draftsIn(db).length));
    }
    // (4) schedule basis stored; the UI refreshes it at send time
    {
      const db = makeDb(seedL(leadOf({ activeJobId: 'j1', scheduledDate: '2026-10-21', scheduledStart: '07:30' })));
      await run(db, 'scheduled');
      const x = db.store.get('leads/L1/doc_drafts/ddraft_L1_crew_reminder_j1');
      ok('the schedule a date was baked from is stored on the draft (scheduleBasis)', !!x && x.scheduleBasis === 'Wednesday, October 21 at 7:30 AM', x && x.scheduleBasis);
      const cur = UI.scheduleOf({ scheduledDate: '2026-10-28', scheduledStart: '07:30' });
      ok('UI schedule formatter == server formatter', UI.scheduleOf({ scheduledDate: '2026-10-21', scheduledStart: '07:30' }) === DL.scheduleOf({ scheduledDate: '2026-10-21', scheduledStart: '07:30' }) && cur === 'Wednesday, October 28 at 7:30 AM');
      const r = UI.refreshSchedule(x.body, x.scheduleBasis, cur);
      ok('a moved date is re-derived into the message at send time', /October 28 at 7:30 AM/.test(r.body) && !/October 21/.test(r.body) && r.changed === true);
      const ph = UI.refreshSchedule('Date: [[install date]].', '', cur);
      ok('an unfilled [[install date]] is filled from the schedule once it exists', ph.body === 'Date: ' + cur + '.' && ph.changed === true);
      ok('control: an unchanged schedule leaves the body alone', UI.refreshSchedule(x.body, x.scheduleBasis, x.scheduleBasis).changed === false);
      ok('a schedule that was CLEARED blocks the date email',
        UI.sendBlockers({ channel: 'email', to: 'a@b.co', emailKind: 'appointment', kind: 'crew_reminder', scheduleBasis: 'Wednesday, October 21' }, { subject: 's', body: 'b' }, { scheduledDate: '' }, {}).length > 0);
    }
    // (5) the paid-in-full EVENT is trusted over a stage move that has not landed
    {
      const inv = (id, o) => ['invoices/' + id, Object.assign({ leadId: 'L1', companyId: 'u1', userId: 'u1', status: 'paid', total: 250, amountPaid: 250, jobId: 'j1' }, o || {})];
      const db = makeDb(Object.assign(seedL(leadOf({ activeJobId: 'j1', stage: 'install_complete' })), Object.fromEntries([inv('i1')])));
      await run(db, 'paid_in_full');
      ok('paid_in_full with the stage move not yet visible still drafts the receipt', db.store.has('leads/L1/doc_drafts/ddraft_L1_paid_receipt_j1'));
      const db2 = makeDb(Object.assign(seedL(leadOf({ activeJobId: 'j1', stage: 'install_complete' })), Object.fromEntries([inv('i1'), inv('i2', { status: 'sent', amountPaid: 0, total: 900 })])));
      await run(db2, 'paid_in_full');
      ok('control: ...but never while a balance is still owed', !db2.store.has('leads/L1/doc_drafts/ddraft_L1_paid_receipt_j1'));
    }
    // (1) a delivered send is never re-sendable
    {
      const base = { channel: 'email', to: 'a@b.co', emailKind: 'receipt' };
      ok('already-sent guard blocks a second Send', UI.sendBlockers(base, { subject: 's', body: 'b' }, {}, { alreadySent: true }).length > 0);
      ok('control: without the guard the same draft is clear', UI.sendBlockers(base, { subject: 's', body: 'b' }, {}, {}).length === 0);
    }
    // (3) Copy / Mark sent
    ok('Mark sent is blocked while a [[placeholder]] is left', UI.markSentBlockers({ subject: 's', body: 'x [[amount paid]]' }).length === 1 && UI.markSentBlockers({ subject: 's', body: 'x' }).length === 0);
    ok('"copied" timeline text names Thumbtack/Yelp only for a copy-channel draft',
      /Thumbtack/.test(UI.timelineText({ channel: 'copy', label: 'L' }, 'S', 'copied')) && !/Thumbtack|Yelp/.test(UI.timelineText({ channel: 'email', label: 'L' }, 'S', 'copied')));
    {
      const code = stripComments(read('docs/pro/js/doc-drafts-ui.js'));
      ok('bookkeeping failure after a delivered send is its own message, never "Could not send"',
        /Sent, but couldn.{1,3}t update the card/.test(code) && /sentGuard/.test(code) && /sessionStorage/.test(code));
      ok('timeline note uses an auto id (a retry is never a denied update of a deterministic id) and its failure is surfaced',
        /win\.collection\(win\.db, 'notes'\)/.test(code) && !/'ddraft-' \+ d\.id/.test(code) && /timeline note/i.test(code));
    }
  }

  console.log('\nH. queue UI behaviour (fake DOM): a delivered send is never re-sendable');
  {
    function mkEl(tag) {
      const e = { tag, style: {}, children: [], listeners: {}, attrs: {}, disabled: false, value: '', textContent: '', parent: null, removed: false };
      e.appendChild = (c) => { c.parent = e; e.children.push(c); return c; };
      e.insertBefore = (c) => { c.parent = e; e.children.unshift(c); return c; };
      e.addEventListener = (n, f) => { (e.listeners[n] = e.listeners[n] || []).push(f); };
      e.setAttribute = (k, v) => { e.attrs[k] = v; };
      e.remove = () => { e.removed = true; };
      e.querySelectorAll = (sel) => { const out = []; (function walk(n) { n.children.forEach((c) => { if (c.tag === sel && !c.removed) out.push(c); walk(c); }); })(e); return out; };
      e.click = () => (e.listeners.click || []).forEach((f) => f());
      return e;
    }
    const host = mkEl('div');
    const toasts = [];
    let sends = 0; let updateFails = true;
    const window_ = {
      document: { createElement: mkEl, getElementById: (id) => (id === 'overviewTab' ? host : null) },
      console, db: {}, _userClaims: { role: 'company_admin' }, auth: { currentUser: { uid: 'u1' } },
      showToast: (m, k) => toasts.push(k + ': ' + m),
      collection: (...a) => ({ a }), doc: (...a) => ({ a }), query: (...a) => ({ a }), where: (...a) => ({ a }),
      getDocs: async () => ({ forEach: (f) => f({ id: 'dd1', data: () => ({ status: 'draft', kind: 'paid_receipt', label: 'Paid-in-full receipt', emailKind: 'receipt', channel: 'email', to: 'a@b.co', subject: 'Receipt', body: 'Thanks.' }) }) }),
      updateDoc: async () => { if (updateFails) throw new Error('offline'); },
      setDoc: async () => {},
      NBDComms: { sendEmail: async () => { sends++; return { success: true, mode: 'platform' }; } },
      nbdConfirm: async () => true,
      sessionStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = v; } },
    };
    window_.window = window_;
    const vctx = vm.createContext(window_);
    vm.runInContext(read('docs/pro/js/doc-drafts-ui.js'), vctx, { filename: 'doc-drafts-ui.js' });
    const n = await window_.NBDDocDrafts.render('L1', { email: 'a@b.co' });
    const findBtn = (label) => { let hit = null; (function walk(x) { x.children.forEach((c) => { if (c.tag === 'button' && c.textContent === label) hit = c; walk(c); }); })(host); return hit; };
    const sendBtn = findBtn('Send email');
    ok('the queue renders one card with a Send button', n === 1 && !!sendBtn);
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    ok('delivered send + card update failure -> "Sent, but..." warning, NOT "Could not send"',
      toasts.some((t) => /Sent, but/.test(t)) && !toasts.some((t) => /Could not send/.test(t)), JSON.stringify(toasts));
    ok('...and Send is disabled for that card', sendBtn.disabled === true);
    sendBtn.disabled = false; // even a forced second tap must not resend
    sendBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    ok('...a second tap does not email the customer again (control: exactly one platform send happened)', sends === 1, 'sends=' + sends);
    ok('...and the guard survives in sessionStorage', /dd1/.test(window_.sessionStorage.getItem('nbd_ddraft_sent') || ''));
    // control: a draft whose send really failed stays sendable
    sends = 0; toasts.length = 0; host.children.length = 0; window_.sessionStorage._m = {};
    window_.NBDComms.sendEmail = async () => { sends++; throw new Error('network'); };
    const vctx2 = vm.createContext(window_);
    vm.runInContext(read('docs/pro/js/doc-drafts-ui.js'), vctx2, { filename: 'doc-drafts-ui.js' });
    await window_.NBDDocDrafts.render('L1', { email: 'a@b.co' });
    const s2 = findBtn('Send email');
    s2.click();
    await new Promise((r) => setTimeout(r, 20));
    ok('control: a send that really failed says "Could not send" and can be retried', toasts.some((t) => /Could not send/.test(t)) && s2.disabled === false, JSON.stringify(toasts));
  }

  console.log('\nI. vacuity-audit round (behavioural coverage for the survivors)');
  if (DL && DDF && UI && SPINE) {
    // logic edges
    const L2 = (o) => DL.shouldDraft(leadOf(o), 'thank_you', { jobId: '' });
    ok('already asked (no job id, reviewRequested) -> no second review ask', L2({ reviewRequested: true }).reason === 'already_asked' && L2({}).ok === true);
    ok('lost via lead.lost and via stageRole', DL.shouldDraft(leadOf({ lost: true }), 'warranty', {}).reason === 'lost' && DL.shouldDraft(leadOf({ stageRole: 'lost' }), 'warranty', {}).reason === 'lost');
    {
      const t = (tier, key) => DL.build('warranty', { lead: leadOf({ soldTier: tier }), brand: DL.brandOf(NBDP, key), tier }).body;
      ok('another company never gets the TAMKO HailGuard line (beyond)', !/TAMKO/.test(t('beyond', 'oaks-co')) && /TAMKO/.test(t('beyond', NBD_UID)));
    }
    ok('channel: a header-injection address and an oversized address are copy-only',
      DL.channelFor(leadOf({ email: 'a@b.co>\r\nBcc: x@y.z' })) === 'copy' && DL.channelFor(leadOf({ email: 'a'.repeat(250) + '@b.co' })) === 'copy' && DL.channelFor(leadOf({ email: 'a@b.co' })) === 'email');
    ok('first name is sanitised (public lead input): markup / quotes drop to "Hi,"',
      DL.firstNameOf({ firstName: '<b>Pat' }) === '' && DL.firstNameOf({ name: '"; DROP' }) === '' && DL.firstNameOf({ firstName: "D'Arcy" }) === "D'Arcy");
    ok('out-of-range times are rejected', DL.timeLong('25:00') === '' && DL.timeLong('10:75') === '' && DL.timeLong('07:05') === '7:05 AM');
    ok('negative cents format', DL.fmtCents(-5) === '-$0.05');
    {
      const mk = (meta) => { const d = makeDb({ 'leads/L1': leadOf({ stage: 'install_complete' }), 'companyProfile/u1': OAKS }); return DDF.draftDocsForEvent(d, { leadId: 'L1', event: 'installed', meta }, deps).then(() => draftsIn(d)); };
      const bad = await mk({ jobId: '../../x' });
      const good = await mk({ jobId: 'jobZ' });
      ok('meta.jobId: hostile value never reaches an id; a valid one does', bad.every((k) => /_nj\d{8}$/.test(k)) && good.every((k) => /_jobZ$/.test(k)), JSON.stringify([bad, good]));
    }
    // spine: refused events draft nothing
    {
      const d = makeDb({ 'leads/L1': leadOf({ activeJobId: 'j1' }) });
      const o = await SPINE.recordJobEvent(d, { leadId: 'L1', event: 'installed', companyId: 'someone-else', sourceId: 's' }, { FieldValue: FV, logger: quiet, now: () => NOW, depositDraft: false, signedPrice: false, finalDraft: false, reviewTask: false });
      ok('a tenant-mismatched spine event drafts nothing', draftsIn(d).length === 0 && !o.docDrafts, JSON.stringify(o).slice(0, 200));
    }
    // the drafter file only requires what it should (no mail transport)
    {
      const reqs = (stripComments(read('functions/doc-drafts.js')).match(/require\(['"][^'"]+['"]\)/g) || []).map((r) => r.slice(9, -2)).sort();
      const allowed = ['./doc-drafts-logic', './invoice-owed', './paid-in-full', 'firebase-admin/firestore', 'firebase-functions/v2'];
      ok('doc-drafts.js requires only allow-listed modules (no mail / SMS transport can be added silently)', reqs.length > 0 && reqs.every((r) => allowed.indexOf(r) !== -1), reqs.join(','));
    }
    // UI blockers
    const E = { channel: 'email', to: 'a@b.co', emailKind: 'receipt' };
    ok('email channel with an empty `to` is blocked (control: with `to` it is clear)', UI.sendBlockers(Object.assign({}, E, { to: '' }), { subject: 's', body: 'b' }, {}, {}).length > 0 && UI.sendBlockers(E, { subject: 's', body: 'b' }, {}, {}).length === 0);
    ok('an empty subject is blocked', UI.sendBlockers(E, { subject: '  ', body: 'b' }, {}, {}).length > 0);
    ok('an empty [[]] placeholder still blocks', UI.sendBlockers(E, { subject: 's', body: 'a [[]] b' }, {}, {}).length === 1);
  }

  console.log('\nJ. queue UI, driven in a fake window: payloads, role gate, writes');
  {
    function mk2(tag) {
      const e = { tag, style: {}, children: [], listeners: {}, disabled: false, value: '', textContent: '', removed: false };
      e.appendChild = (c) => { e.children.push(c); return c; };
      e.insertBefore = (c) => { e.children.unshift(c); return c; };
      e.addEventListener = (n, f) => { (e.listeners[n] = e.listeners[n] || []).push(f); };
      e.setAttribute = () => {};
      e.remove = () => { e.removed = true; };
      e.querySelectorAll = (sel) => { const out = []; (function w(n) { n.children.forEach((c) => { if (c.tag === sel && !c.removed) out.push(c); w(c); }); })(e); return out; };
      e.click = () => (e.listeners.click || []).forEach((f) => f());
      return e;
    }
    async function harness(role, rows, sendImpl) {
      const host = mk2('div');
      const w = {
        document: { createElement: mk2, getElementById: (id) => (id === 'overviewTab' ? host : null) },
        console, db: {}, _userClaims: { role }, auth: { currentUser: { uid: 'u1' } },
        showToast() {}, collection: (...a) => ({ a }), doc: (...a) => ({ a }), query: (...a) => ({ a }), where: (...a) => ({ a }),
        reads: 0, updates: [], sends: [],
        getDocs: async function () { w.reads++; return { forEach: (f) => rows.forEach((r) => f({ id: r.id, data: () => r.data })) }; },
        updateDoc: async (_r, patch) => { w.updates.push(patch); },
        setDoc: async () => {},
        NBDComms: { sendEmail: async (p) => { w.sends.push(p); return sendImpl ? sendImpl(p) : { success: true, mode: 'platform' }; } },
        nbdConfirm: async () => true,
        sessionStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = v; } },
      };
      w.window = w;
      vm.runInContext(read('docs/pro/js/doc-drafts-ui.js'), vm.createContext(w), { filename: 'doc-drafts-ui.js' });
      return { w, host, find: (label) => { let hit = null; (function walk(x) { x.children.forEach((c) => { if (c.tag === 'button' && c.textContent === label) hit = c; walk(c); }); })(host); return hit; } };
    }
    const row = (id, over) => ({ id, data: Object.assign({ status: 'draft', kind: 'warranty', label: 'Warranty summary', emailKind: 'document', channel: 'email', to: 'a@b.co', subject: 'S', body: 'Hello there.' }, over || {}) });
    const tick = () => new Promise((r) => setTimeout(r, 20));
    {
      const h = await harness('company_admin', [row('w1'), row('t1', { kind: 'thank_you', label: 'Thank-you', emailKind: '' })]);
      await h.w.NBDDocDrafts.render('L1', {});
      const btns = [];
      (function walk(x) { x.children.forEach((c) => { if (c.tag === 'button' && c.textContent === 'Send email') btns.push(c); walk(c); }); })(h.host);
      btns.forEach((b) => b.click());
      await tick();
      const byKind = h.w.sends.map((p) => p.kind);
      ok('warranty is sent with kind "document"; the thank-you is sent with NO kind property at all',
        h.w.sends.length === 2 && byKind.indexOf('document') !== -1 && h.w.sends.some((p) => !('kind' in p)), JSON.stringify(h.w.sends));
      ok('every send carries leadId (the server\'s recipient binding)', h.w.sends.every((p) => p.leadId === 'L1' && p.to === 'a@b.co'));
      const ALLOWED = ['status', 'subject', 'body', 'sentAt', 'dismissedAt'];
      ok('the client writes only allow-listed keys to a draft (every key of every update)', h.w.updates.length >= 2 && h.w.updates.every((u) => Object.keys(u).every((k) => ALLOWED.indexOf(k) !== -1)), JSON.stringify(h.w.updates.map((u) => Object.keys(u))));
    }
    {
      const h = await harness('viewer', [row('w1')]);
      const n = await h.w.NBDDocDrafts.render('L1', {});
      ok('a viewer: nothing rendered and the drafts are never even read', n === 0 && h.w.reads === 0);
      const h2 = await harness('company_admin', [row('w1')]);
      const n2 = await h2.w.NBDDocDrafts.render('L1', {});
      ok('control: a company_admin gets the card', n2 === 1 && h2.w.reads === 1);
    }
    {
      // a mail-app handoff is not a send: the card stays, nothing is written
      const h = await harness('company_admin', [row('w1')], () => ({ success: true, mode: 'mailto' }));
      await h.w.NBDDocDrafts.render('L1', {});
      h.find('Send email').click();
      await tick();
      ok('mailto handoff leaves the draft as a draft (no status write)', h.w.updates.length === 0 && h.find('Send email') && !h.find('Send email').disabled);
    }
    {
      // a draft with an unfilled placeholder cannot be sent through a click either
      const h = await harness('company_admin', [row('w1', { body: 'Date: [[install date]]' })]);
      await h.w.NBDDocDrafts.render('L1', {});
      const b = h.find('Send email');
      b.disabled = false; b.click();
      await tick();
      ok('a forced click on a Send with an unfilled blank still sends nothing', h.w.sends.length === 0);
    }
  }

  console.log('\nK. survivors from the mutation round');
  if (DDF && DL) {
    const db = makeDb({ 'leads/L1': leadOf({ activeJobId: 'j1' }), 'companyProfile/u1': OAKS });
    db.hooks.failCreate = /ddraft_L1_warranty_/;
    const o = await DDF.draftDocsForEvent(db, { leadId: 'L1', event: 'installed' }, deps);
    ok('the FIRST kind failing does not stop the second (thank-you still drafted)', db.store.has('leads/L1/doc_drafts/ddraft_L1_thank_you_j1') && o.failed.length === 1 && !o.error, JSON.stringify(o));
  }
  {
    // schedule refresh + dismiss writes, in the fake window
    const host = { tag: 'div', children: [] };
    const mk3 = (tag) => {
      const e = { tag, style: {}, children: [], listeners: {}, disabled: false, value: '', textContent: '', removed: false };
      e.appendChild = (c) => { e.children.push(c); return c; };
      e.insertBefore = (c) => { e.children.unshift(c); return c; };
      e.addEventListener = (n, f) => { (e.listeners[n] = e.listeners[n] || []).push(f); };
      e.setAttribute = () => {};
      e.remove = () => { e.removed = true; };
      e.querySelectorAll = (sel) => { const out = []; (function w(n) { n.children.forEach((c) => { if (c.tag === sel && !c.removed) out.push(c); w(c); }); })(e); return out; };
      e.click = () => (e.listeners.click || []).forEach((f) => f());
      return e;
    };
    const h = mk3('div');
    const updates = [];
    const w = {
      document: { createElement: mk3, getElementById: (id) => (id === 'overviewTab' ? h : null) },
      console, db: {}, _userClaims: { role: 'company_admin' }, auth: { currentUser: { uid: 'u1' } }, showToast() {},
      collection: () => ({}), doc: () => ({}), query: () => ({}), where: () => ({}),
      getDocs: async () => ({ forEach: (f) => f({ id: 'c1', data: () => ({ status: 'draft', kind: 'crew_reminder', label: 'Crew date confirmation', emailKind: 'appointment', channel: 'email', to: 'a@b.co', subject: 'S', body: 'Your crew is on the schedule for Wednesday, October 21 at 7:30 AM.', scheduleBasis: 'Wednesday, October 21 at 7:30 AM' }) }) }),
      updateDoc: async (_r, p) => { updates.push(p); }, setDoc: async () => {},
      NBDComms: { sendEmail: async () => ({ success: true, mode: 'platform' }) },
      sessionStorage: { getItem() { return null; }, setItem() {} },
    };
    w.window = w;
    vm.runInContext(read('docs/pro/js/doc-drafts-ui.js'), vm.createContext(w), { filename: 'doc-drafts-ui.js' });
    await w.NBDDocDrafts.render('L1', { scheduledDate: '2026-10-28', scheduledStart: '07:30' });
    const area = h.querySelectorAll('textarea')[0];
    ok('a card opened after the crew date moved shows the NEW date', !!area && /Wednesday, October 28 at 7:30 AM/.test(area.value) && !/October 21/.test(area.value), area && area.value);
    const find = (label) => { let hit = null; (function walk(x) { x.children.forEach((c) => { if (c.tag === 'button' && c.textContent === label) hit = c; walk(c); }); })(h); return hit; };
    find('Dismiss').click();
    await new Promise((r) => setTimeout(r, 20));
    ok('dismiss writes exactly status + dismissedAt', updates.length === 1 && JSON.stringify(Object.keys(updates[0]).sort()) === '["dismissedAt","status"]' && updates[0].status === 'dismissed', JSON.stringify(updates));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('\nFailures:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
