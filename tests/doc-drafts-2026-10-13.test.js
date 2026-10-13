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
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const apply = (cur, patch) => Object.assign({}, cur, patch);
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    collection: (c) => col(p + '/' + c),
    async get() { const d = store.get(p); return { exists: d !== undefined, data: () => (d === undefined ? undefined : clone(d)) }; },
    async update(patch) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); writes.push(['update', p, patch]); store.set(p, apply(store.get(p), patch)); },
    async set(data) { writes.push(['set', p, data]); store.set(p, clone(data)); },
    async create(data) {
      if (store.has(p)) { const e = new Error('6 ALREADY_EXISTS: ' + p); e.code = 6; throw e; }
      writes.push(['create', p, data]); store.set(p, clone(data));
    },
  });
  const query = (c, filters) => ({
    where: (f, op, v) => query(c, filters.concat([[f, v]])),
    limit: () => query(c, filters),
    async get() {
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
    store, writes, collection: col, doc: (p) => ref(p),
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

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('\nFailures:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
