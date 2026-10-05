/**
 * tests/care-plan-2026-10-05.test.js
 *
 * The Roof Care Plan (functions/care-plan.js + care-plan-logic.js): the
 * terms exactly as docs/services/roof-care-plan.html promises them, the dark
 * switch, the Stripe Checkout shape (subscription mode, inline price_data,
 * tagged, NO client_reference_id), lead linking / creation, the CRM invite
 * link, the webhook (idempotent, order-proof, ignores NBD Pro billing), the
 * yearly inspection task, the owner-only gate, and stripeWebhook's skip
 * guards. In-memory Firestore + a fake Stripe account; synthetic data only.
 * Nothing is sent anywhere.
 *
 * Run: node tests/care-plan-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
process.env.NBD_OWNER_UID = 'OWNER';
delete process.env.CARE_PLAN_MODE;
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'functions', 'care-plan-logic.js'));
const CP = require(path.join(ROOT, 'functions', 'care-plan.js'));
const X = CP._internal;
const { FieldValue } = require(require.resolve('firebase-admin/firestore', { paths: [path.join(ROOT, 'functions')] }));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
async function rejects(fn, re) {
  try { await fn(); return false; } catch (e) { return re ? re.test(String(e.code || '') + ' ' + String(e.message || '')) : true; }
}

// ── a small path-based in-memory Firestore ──────────────────────────────
function makeDb(seed) {
  const store = new Map();   // 'col/id' or 'col/id/sub/id' → data
  let auto = 0;
  const DEL = FieldValue.delete(), TS = FieldValue.serverTimestamp();
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  function resolve(obj, prev) {
    const out = prev ? clone(prev) : {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v.isEqual === 'function' && v.isEqual(DEL)) delete out[k];
      else if (v && typeof v.isEqual === 'function' && v.isEqual(TS)) out[k] = new Date().toISOString();
      else out[k] = clone(v);
    }
    return out;
  }
  function ref(p) {
    const id = p.split('/').pop();
    return {
      id, path: p,
      async get() { const d = store.get(p); return { id, exists: !!d, data: () => clone(d), ref: ref(p) }; },
      async set(data, opts) { store.set(p, resolve(data, opts && opts.merge ? store.get(p) : null)); },
      async update(patch) { if (!store.has(p)) throw new Error('no doc ' + p); store.set(p, resolve(patch, store.get(p))); },
      async create(data) { if (store.has(p)) throw Object.assign(new Error('6 ALREADY_EXISTS'), { code: 6 }); store.set(p, resolve(data)); },
      async delete() { store.delete(p); },
      collection(sub) { return col(p + '/' + sub); },
    };
  }
  function query(cp, filters, lim) {
    return {
      where(f, op, v) { return query(cp, filters.concat([[f, v]]), lim); },
      limit(n) { return query(cp, filters, n); },
      async get() {
        const depth = cp.split('/').length + 1;
        let docs = [...store.entries()]
          .filter(([k]) => k.startsWith(cp + '/') && k.split('/').length === depth)
          .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
          .map(([k]) => { const r = ref(k); return { id: r.id, ref: r, data: () => clone(store.get(k)) }; });
        if (lim) docs = docs.slice(0, lim);
        return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) };
      },
    };
  }
  function col(cp) { return Object.assign(query(cp, [], 0), { doc: (id) => ref(cp + '/' + (id || ('auto' + (++auto)))) }); }
  const db = {
    collection: col,
    doc: (p) => ref(p),
    async runTransaction(fn) {
      const ops = [];
      const tx = { get: (r) => r.get(), set: (r, d, o) => ops.push(() => r.set(d, o)), update: (r, d) => ops.push(() => r.update(d)), create: (r, d) => ops.push(() => r.create(d)) };
      const out = await fn(tx);
      for (const op of ops) await op();
      return out;
    },
    _get: (p) => clone(store.get(p)),
    _list: (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)),
    _count: () => store.size,
  };
  for (const [p, d] of Object.entries(seed || {})) store.set(p, clone(d));
  return db;
}

// ── a fake Stripe account ────────────────────────────────────────────────
function makeStripe() {
  let productCalls = 0;
  const s = { sessions: [], subs: new Map(), portalConfigs: 0, portalSessions: [] };
  return Object.assign(s, {
    products: { create: async () => { productCalls++; if (productCalls > 1) throw Object.assign(new Error('Product already exists.'), { code: 'resource_already_exists' }); return { id: C.STRIPE_PRODUCT_ID }; } },
    _productCalls: () => productCalls,
    checkout: { sessions: {
      create: async (p) => { const id = 'cs_test_' + String(s.sessions.length + 1).padStart(12, '0'); s.sessions.push(Object.assign({ id }, p)); return { id, url: 'https://checkout.stripe.test/' + id }; },
      retrieve: async (id) => { const x = s.sessions.find((y) => y.id === id); if (!x) throw new Error('No such session'); return Object.assign({ customer: 'cus_member' }, x); },
    } },
    subscriptions: { retrieve: async (id) => { const x = s.subs.get(id); if (!x) throw new Error('No such subscription: ' + id); return JSON.parse(JSON.stringify(x)); } },
    billingPortal: {
      configurations: { create: async () => { s.portalConfigs++; return { id: 'bpc_' + s.portalConfigs }; } },
      sessions: { create: async (p) => { s.portalSessions.push(p); return { url: 'https://billing.stripe.test/p/' + p.customer }; } },
    },
  });
}
// products counter shim (create() increments a plain counter)
function productCount(stripe) { return stripe._productCalls(); }

function sub(id, meta, extra) {
  return Object.assign({
    id, object: 'subscription', status: 'active', customer: 'cus_member', metadata: meta,
    current_period_end: 1820000000, cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_inline', unit_amount: meta && meta.interval === 'month' ? 1900 : 19900, recurring: { interval: (meta && meta.interval) || 'year' } } }] },
  }, extra || {});
}
const evt = (id, type, object) => ({ id, type, created: 1, data: { object } });

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 9, 6, 15, 0, 0);

(async () => {
  console.log('\n1. the terms, exactly as the page promises');
  {
    ok('$199 a year and $19 a month, in cents', C.PRICES_CENTS.year === 19900 && C.PRICES_CENTS.month === 1900);
    const page = fs.readFileSync(path.join(ROOT, 'docs', 'services', 'roof-care-plan.html'), 'utf8');
    ok('…and the public page still says $199 a year or $19 a month', /\$199 a year or \$19 a month/.test(page));
    const y = C.disclosureText('year'), m = C.disclosureText('month');
    ok('the yearly disclosure says $199, every year, renews automatically, cancel anytime', /\$199 today, then \$199 every year/.test(y) && /renews automatically/.test(y) && /cancel anytime/.test(y));
    ok('the monthly disclosure says $19 every month', /\$19 today, then \$19 every month/.test(m) && !/\$199/.test(m));
    ok('a disclosure version is recorded', /^\d{4}-\d{2}-\d{2}$/.test(C.DISCLOSURE_VERSION));
  }

  console.log('\n2. the dark switch (CARE_PLAN_MODE)');
  {
    ok('unset → off', C.carePlanMode({}) === 'off');
    ok('"off" → off', C.carePlanMode({ CARE_PLAN_MODE: 'off' }) === 'off');
    ok('"TEST" → test', C.carePlanMode({ CARE_PLAN_MODE: ' TEST ' }) === 'test');
    ok('"live" → live', C.carePlanMode({ CARE_PLAN_MODE: 'live' }) === 'live');
    ok('anything else fails closed → off', C.carePlanMode({ CARE_PLAN_MODE: 'true' }) === 'off' && C.carePlanMode({ CARE_PLAN_MODE: 'on' }) === 'off');
    const env = fs.readFileSync(path.join(ROOT, 'functions', '.env.nobigdeal-pro'), 'utf8');
    ok('production ships it OFF (functions/.env.nobigdeal-pro)', /^CARE_PLAN_MODE=off\r?$/m.test(env) && !/^CARE_PLAN_MODE=(test|live)\r?$/m.test(env));
  }

  console.log('\n3. the Stripe Checkout session');
  {
    const p = C.checkoutParams({ carePlanId: 'cp1', leadId: 'L1', companyId: 'OWNER', interval: 'year', email: 'h@example.com', productId: 'nbd_roof_care_plan' });
    const li = p.line_items[0];
    ok('subscription mode, one inline price_data line', p.mode === 'subscription' && p.line_items.length === 1 && li.price_data && !li.price);
    ok('yearly = 19900 cents every year', li.price_data.unit_amount === 19900 && li.price_data.recurring.interval === 'year' && li.price_data.currency === 'usd');
    const pm = C.checkoutParams({ carePlanId: 'cp1', leadId: 'L1', companyId: 'OWNER', interval: 'month' });
    ok('monthly = 1900 cents every month', pm.line_items[0].price_data.unit_amount === 1900 && pm.line_items[0].price_data.recurring.interval === 'month');
    ok('the session AND the subscription are tagged roof_care_plan with plan/lead/company ids',
      p.metadata.nbdProduct === 'roof_care_plan' && p.subscription_data.metadata.nbdProduct === 'roof_care_plan'
      && p.subscription_data.metadata.carePlanId === 'cp1' && p.subscription_data.metadata.leadId === 'L1' && p.subscription_data.metadata.companyId === 'OWNER');
    ok('NO client_reference_id (stripeWebhook would grant an NBD Pro plan to it)', !('client_reference_id' in p) && !('client_reference_id' in pm));
    ok('the renewal terms are shown on Stripe\'s pay button', /renews automatically/.test(p.custom_text.submit.message));
    ok('success_url hands back the session id', /session_id=\{CHECKOUT_SESSION_ID\}/.test(p.success_url) && /careplan=joined/.test(p.success_url));
    ok('the email is prefilled only when valid', p.customer_email === 'h@example.com' && !('customer_email' in pm));
    ok('no promotion codes (the price is the price)', p.allow_promotion_codes === false);
  }

  console.log('\n4. signup validation');
  {
    const good = { interval: 'year', termsAccepted: true, firstName: 'Pat', lastName: 'Q', email: 'PAT@Example.com', phone: '(513) 555-0142', address: '12 Oak St, Cincinnati' };
    const v = C.validateCheckout(good);
    ok('a complete signup passes; email lower-cased; phoneDigits derived', v.ok && v.data.email === 'pat@example.com' && v.data.phoneDigits === '5135550142');
    ok('terms must be accepted (true, not "true")', !C.validateCheckout(Object.assign({}, good, { termsAccepted: 'true' })).ok);
    ok('interval must be year or month', !C.validateCheckout(Object.assign({}, good, { interval: 'week' })).ok);
    ok('bad email refused', !C.validateCheckout(Object.assign({}, good, { email: 'nope' })).ok);
    ok('short phone refused', !C.validateCheckout(Object.assign({}, good, { phone: '555-0142' })).ok);
    ok('address required', !C.validateCheckout(Object.assign({}, good, { address: '' })).ok);
    ok('markup is stripped', C.validateCheckout(Object.assign({}, good, { firstName: '<b>Pat</b>' })).data.firstName === 'bPat/b');
    const inv = C.validateCheckout({ interval: 'month', termsAccepted: true, invite: 'a'.repeat(32) });
    ok('an invite needs only interval + consent', inv.ok && inv.data.invite && !inv.data.email);
  }

  console.log('\n5. Stripe status → membership');
  {
    ok('active/trialing → active', C.membershipStatus('active') === 'active' && C.membershipStatus('trialing') === 'active');
    ok('past_due/unpaid → past_due (keeps benefits while Stripe retries)', C.membershipStatus('past_due') === 'past_due' && C.isMemberStatus('past_due'));
    ok('canceled → cancelled (no benefits)', C.membershipStatus('canceled') === 'cancelled' && !C.isMemberStatus('cancelled'));
    ok('incomplete → pending', C.membershipStatus('incomplete') === 'pending' && !C.isMemberStatus('pending'));
    ok('a subscription invoice is recognised by subscription_details', C.isCarePlanObject({ object: 'invoice', subscription_details: { metadata: { nbdProduct: 'roof_care_plan' } } }));
    ok('NBD Pro objects are not', !C.isCarePlanObject({ metadata: { plan: 'growth' } }) && !C.isCarePlanObject(null));
  }

  console.log('\n6. the yearly inspection reminder');
  {
    const t0 = C.inspectionTask({ carePlanId: 'cp1', leadId: 'L1', ownerUid: 'OWNER', companyId: 'OWNER', activatedAtMs: T0, yearIndex: 0 });
    ok('first visit due two weeks after joining', t0.doc.dueDate === new Date(T0 + 14 * DAY).toISOString().slice(0, 10) && /first visit/.test(t0.doc.title));
    ok('task shape: text/title/done/dueDate/leadId/userId/companyId', t0.doc.text === t0.doc.title && t0.doc.done === false && t0.doc.leadId === 'L1' && t0.doc.userId === 'OWNER' && t0.doc.companyId === 'OWNER');
    const t1 = C.inspectionTask({ carePlanId: 'cp1', leadId: 'L1', ownerUid: 'OWNER', companyId: 'OWNER', activatedAtMs: T0, yearIndex: 1 });
    ok('year 2 due on the anniversary, its own deterministic id', t1.doc.dueDate === '2027-10-06' && t1.id === 'careplan_cp1_y2' && t0.id === 'careplan_cp1_y1');
    ok('year index: 0 in year one, 1 after a year', C.membershipYearIndex(T0, T0 + 300 * DAY) === 0 && C.membershipYearIndex(T0, T0 + 366 * DAY) === 1);
  }

  const OWNER_LEADS = {
    'leads/L_EMAIL': { companyId: 'OWNER', userId: 'OWNER', firstName: 'Ema', lastName: 'Il', email: 'em@example.com', phone: '513-555-0100', phoneDigits: '5135550100', address: '1 A St' },
    'leads/L_PHONE': { companyId: 'OWNER', userId: 'OWNER', firstName: 'Pho', lastName: 'Ne', email: '', phone: '(513) 555-0199', phoneDigits: '5135550199', address: '2 B St' },
    'leads/L_OTHER': { companyId: 'co-other', userId: 'u-other', firstName: 'Other', lastName: 'Tenant', email: 'shared@example.com', phoneDigits: '5135550777' },
  };
  const signup = (o) => Object.assign({ action: 'checkout', interval: 'year', termsAccepted: true, firstName: 'Pat', lastName: 'Q', email: 'new@example.com', phone: '513 555 0142', address: '12 Oak St', preview: true }, o || {});

  console.log('\n7. checkout — dark, preview, linking, creating');
  {
    const db = makeDb(OWNER_LEADS); const stripe = makeStripe(); X.reset();
    const before = db._count();
    const off = await X.handleCheckout(db, stripe, signup(), 'off');
    ok('OFF: 404, nothing written, no Stripe call', off.status === 404 && db._count() === before && stripe.sessions.length === 0);
    const noPreview = await X.handleCheckout(db, stripe, signup({ preview: false }), 'test');
    ok('TEST without ?preview: 404, nothing written', noPreview.status === 404 && db._count() === before);
    const r = await X.handleCheckout(db, stripe, signup(), 'test');
    ok('TEST with preview: a checkout url', r.status === 200 && /^https:\/\/checkout\.stripe\.test\//.test(r.body.url));
    const leadKey = db._list('leads/careplans__')[0];
    const lead = leadKey && db._get(leadKey);
    ok('a new lead is created the way the bridge does: NBD company, phoneDigits, source "Website — Roof Care Plan"',
      lead && lead.companyId === 'OWNER' && lead.userId === 'OWNER' && lead.phoneDigits === '5135550142' && lead.source === 'Website — Roof Care Plan' && lead.stage === 'new' && lead.webLead === true);
    const planKey = db._list('careplans/')[0];
    const plan = db._get(planKey);
    ok('the membership is pending, NBD-scoped, priced in cents, with the disclosure recorded',
      plan.status === 'pending' && plan.companyId === 'OWNER' && plan.amountCents === 19900 && plan.disclosureVersion === C.DISCLOSURE_VERSION && !!plan.termsAcceptedAt && plan.leadId === leadKey.split('/')[1]);
    ok('the session id is stored and its metadata names this plan', plan.stripeCheckoutSessionId === stripe.sessions[0].id && stripe.sessions[0].subscription_data.metadata.carePlanId === planKey.split('/')[1]);
    ok('the product is created lazily, once', productCount(stripe) === 1);
    await X.handleCheckout(db, stripe, signup(), 'test');
    ok('a second try for the same person reuses the pending membership (no pile of pendings)', db._list('careplans/').length === 1 && stripe.sessions.length === 2);

    const db2 = makeDb(OWNER_LEADS); X.reset();
    await X.handleCheckout(db2, makeStripe(), signup({ email: 'em@example.com', phone: '859 555 0000' }), 'live');
    ok('LIVE, no preview needed; an existing NBD customer is linked by EMAIL (no new lead)', db2._list('leads/careplans__').length === 0 && db2._get(db2._list('careplans/')[0]).leadId === 'L_EMAIL');
    const db3 = makeDb(OWNER_LEADS); X.reset();
    await X.handleCheckout(db3, makeStripe(), signup({ email: 'zzz@example.com', phone: '(513) 555-0199', preview: false }), 'live');
    ok('…or by PHONE', db3._get(db3._list('careplans/')[0]).leadId === 'L_PHONE');
    const db4 = makeDb(OWNER_LEADS); X.reset();
    await X.handleCheckout(db4, makeStripe(), signup({ email: 'shared@example.com', phone: '513 555 0777' }), 'live');
    const linked = db4._get(db4._list('careplans/')[0]).leadId;
    ok('another tenant\'s customer with the same email/phone is NEVER linked — a new NBD lead instead', linked !== 'L_OTHER' && db4._get('leads/' + linked).companyId === 'OWNER' && !db4._get('leads/L_OTHER').carePlan);
    const db5 = makeDb(Object.assign({}, OWNER_LEADS, { 'careplans/cpM': { companyId: 'OWNER', leadId: 'L_EMAIL', status: 'active' } })); X.reset();
    const dup = await X.handleCheckout(db5, makeStripe(), signup({ email: 'em@example.com' }), 'live');
    ok('an existing member cannot buy twice (409)', dup.status === 409 && dup.body.error === 'already_member');
    const bad = await X.handleCheckout(makeDb(), makeStripe(), signup({ termsAccepted: false }), 'live');
    ok('no terms consent → 400', bad.status === 400);
  }

  console.log('\n8. the CRM invite link (Jo sends it himself)');
  let inviteDb, inviteUrl;
  {
    const db = makeDb(OWNER_LEADS); const stripe = makeStripe(); X.reset();
    ok('refused while OFF', await rejects(() => X.handleAdmin(db, null, { action: 'invite', leadId: 'L_EMAIL' }, 'off', T0), /failed-precondition/));
    ok('refused for another tenant\'s lead', await rejects(() => X.handleAdmin(db, null, { action: 'invite', leadId: 'L_OTHER' }, 'test', T0), /not-found/));
    const inv = await X.handleAdmin(db, null, { action: 'invite', leadId: 'L_EMAIL' }, 'test', T0);
    const token = new URL(inv.url).searchParams.get('invite');
    const plan = db._get('careplans/' + inv.carePlanId);
    ok('returns a page link with a token; only its SHA-256 is stored', /\/services\/roof-care-plan\?invite=/.test(inv.url) && token.length >= 30 && plan.inviteTokenHash === X.sha256(token) && !JSON.stringify(plan).includes(token));
    ok('nothing is queued to the homeowner', db._list('email_queue/').length === 0 && db._list('sms').length === 0);
    ok('expires in 30 days', plan.inviteExpiresAtMs === T0 + 30 * DAY);
    const again = await X.handleAdmin(db, null, { action: 'invite', leadId: 'L_EMAIL' }, 'test', T0);
    ok('a second invite rotates the token on the SAME pending membership', again.carePlanId === inv.carePlanId && db._get('careplans/' + inv.carePlanId).inviteTokenHash !== plan.inviteTokenHash);
    const tok2 = new URL(again.url).searchParams.get('invite');
    const oldTry = await X.handleCheckout(db, stripe, { interval: 'month', termsAccepted: true, invite: token }, 'test');
    ok('the rotated-out token no longer works', oldTry.status === 404);
    const co = await X.handleCheckout(db, stripe, { interval: 'month', termsAccepted: true, invite: tok2 }, 'test');
    ok('the invite opens checkout for THAT customer (prefilled email, monthly)', co.status === 200 && stripe.sessions[0].customer_email === 'em@example.com'
      && stripe.sessions[0].subscription_data.metadata.leadId === 'L_EMAIL' && stripe.sessions[0].line_items[0].price_data.unit_amount === 1900);
    ok('an unknown token is refused', (await X.handleCheckout(db, stripe, { interval: 'year', termsAccepted: true, invite: 'z'.repeat(32) }, 'test')).status === 404);
    ok('invites keep working in LIVE, refused in OFF', (await X.handleCheckout(db, stripe, { interval: 'year', termsAccepted: true, invite: tok2 }, 'off')).status === 404);
    inviteDb = db; inviteUrl = again;
  }

  console.log('\n9. the webhook');
  {
    const db = inviteDb; const stripe = makeStripe();
    const cpId = inviteUrl.carePlanId;
    const meta = { nbdProduct: 'roof_care_plan', carePlanId: cpId, leadId: 'L_EMAIL', companyId: 'OWNER', interval: 'month' };
    stripe.subs.set('sub_care', sub('sub_care', meta));
    stripe.subs.set('sub_pro', sub('sub_pro', { firebaseUid: 'contractor', plan: 'growth' }));
    const before = db._count();
    const pro = await X.handleEvent(db, stripe, evt('evt_pro', 'customer.subscription.updated', { id: 'sub_pro', metadata: { plan: 'growth' } }), T0);
    ok('an NBD Pro subscription event is ignored (no writes)', pro.skipped === 'not_care_plan' && db._count() === before);
    const sess = { id: 'cs_test_x', object: 'checkout.session', subscription: 'sub_care', customer: 'cus_member', metadata: meta };
    const r1 = await X.handleEvent(db, stripe, evt('evt_1', 'checkout.session.completed', sess), T0);
    const plan = db._get('careplans/' + cpId);
    ok('checkout completed → member: active, Stripe ids, monthly, period end, activated', plan.status === 'active' && plan.stripeSubscriptionId === 'sub_care'
      && plan.stripeCustomerId === 'cus_member' && plan.interval === 'month' && plan.amountCents === 1900 && plan.currentPeriodEnd && plan.activatedAtMs === T0);
    ok('the invite token is spent', !('inviteTokenHash' in plan));
    const lead = db._get('leads/L_EMAIL');
    ok('the lead carries the server mirror (member badge source)', lead.carePlan && lead.carePlan.member === true && lead.carePlan.carePlanId === cpId && lead.carePlan.status === 'active');
    ok('the first-visit inspection task is on the lead', r1.task === 'careplan_' + cpId + '_y1' && db._get('leads/L_EMAIL/tasks/careplan_' + cpId + '_y1').done === false);
    const mails = db._list('email_queue/');
    const mail = db._get(mails[0] || 'x');
    ok('ONE alert to Jo (never the homeowner)', mails.length === 1 && mail.to === 'jd@nobigdealwithjoedeal.com' && mail.status === 'pending' && /Roof Care Plan/.test(mail.subject) && mail.to !== 'em@example.com');
    await X.handleEvent(db, stripe, evt('evt_1b', 'customer.subscription.created', { id: 'sub_care', metadata: meta }), T0 + 1000);
    await X.handleEvent(db, stripe, evt('evt_1c', 'invoice.paid', { id: 'in_1', subscription: 'sub_care', subscription_details: { metadata: meta } }), T0 + 2000);
    ok('more events for the same start: no second task, no second alert, activation date kept', db._list('leads/L_EMAIL/tasks/').length === 1 && db._list('email_queue/').length === 1 && db._get('careplans/' + cpId).activatedAtMs === T0);

    stripe.subs.set('sub_care', sub('sub_care', meta, { cancel_at_period_end: true }));
    await X.handleEvent(db, stripe, evt('evt_2', 'customer.subscription.updated', { id: 'sub_care', metadata: meta }), T0 + 5 * DAY);
    const l2 = db._get('leads/L_EMAIL').carePlan;
    ok('cancel at period end: still a member until it ends, no renewal date', l2.member === true && l2.endsAt && l2.renewsAt === null && db._get('careplans/' + cpId).cancelAtPeriodEnd === true);

    stripe.subs.set('sub_care', sub('sub_care', meta, { status: 'canceled', canceled_at: 1800000000 }));
    await X.handleEvent(db, stripe, evt('evt_3', 'customer.subscription.deleted', { id: 'sub_care', metadata: meta }), T0 + 40 * DAY);
    ok('deleted → cancelled, no benefits', db._get('careplans/' + cpId).status === 'cancelled' && db._get('leads/L_EMAIL').carePlan.member === false && !!db._get('careplans/' + cpId).cancelledAt);
    // A stale "active" event delivered late: we re-read Stripe, which says canceled.
    await X.handleEvent(db, stripe, evt('evt_old', 'customer.subscription.updated', { id: 'sub_care', status: 'active', metadata: meta }), T0 + 41 * DAY);
    ok('a late, out-of-order "active" event cannot resurrect it (Stripe re-read)', db._get('careplans/' + cpId).status === 'cancelled');

    // Renewal into year two creates the year-two inspection task.
    const db2 = makeDb(OWNER_LEADS); const s2 = makeStripe();
    const m2 = { nbdProduct: 'roof_care_plan', carePlanId: 'cpY', leadId: 'L_PHONE', companyId: 'OWNER', interval: 'year' };
    await db2.collection('careplans').doc('cpY').set({ companyId: 'OWNER', leadId: 'L_PHONE', status: 'pending' });
    s2.subs.set('sub_y', sub('sub_y', m2));
    await X.handleEvent(db2, s2, evt('e1', 'checkout.session.completed', { id: 'cs_y', subscription: 'sub_y', metadata: m2 }), T0);
    await X.handleEvent(db2, s2, evt('e2', 'invoice.paid', { id: 'in_y2', subscription: 'sub_y', subscription_details: { metadata: m2 } }), T0 + 366 * DAY);
    ok('the yearly renewal adds the year-two inspection, due on the anniversary', !!db2._get('leads/L_PHONE/tasks/careplan_cpY_y2') && db2._get('leads/L_PHONE/tasks/careplan_cpY_y2').dueDate === '2027-10-06');

    const db3 = makeDb(OWNER_LEADS); const s3 = makeStripe();
    await db3.collection('careplans').doc('cpF').set({ companyId: 'OWNER', leadId: 'L_EMAIL', status: 'pending' });
    s3.subs.set('sub_f', sub('sub_f', { nbdProduct: 'roof_care_plan', carePlanId: 'cpF', leadId: 'L_EMAIL', companyId: 'co-other' }));
    const foreign = await X.handleEvent(db3, s3, evt('ef', 'customer.subscription.updated', { id: 'sub_f' }), T0);
    ok('metadata naming another company is refused', foreign.skipped === 'foreign' && db3._get('careplans/cpF').status === 'pending');
    s3.subs.set('sub_g', sub('sub_g', { nbdProduct: 'roof_care_plan', carePlanId: 'cpF', leadId: 'L_PHONE', companyId: 'OWNER' }));
    const mism = await X.handleEvent(db3, s3, evt('eg', 'customer.subscription.updated', { id: 'sub_g' }), T0);
    ok('metadata whose lead disagrees with the stored membership is refused', mism.skipped === 'plan_mismatch' && !db3._get('leads/L_PHONE').carePlan);
    ok('a Connect (tenant) event is ignored', (await X.handleEvent(db3, s3, Object.assign(evt('ec', 'invoice.paid', {}), { account: 'acct_1' }), T0)).skipped === 'type');
  }

  console.log('\n10. the cancel / billing portal');
  {
    const db = makeDb(); const stripe = makeStripe();
    ok('a malformed session id → 400', (await X.handlePortal(db, stripe, { sessionId: 'nope' })).status === 400);
    stripe.sessions.push({ id: 'cs_live_abcdefghij1234', metadata: { plan: 'growth' } });
    ok('an NBD Pro checkout session cannot open a care-plan portal', (await X.handlePortal(db, stripe, { sessionId: 'cs_live_abcdefghij1234' })).status === 404);
    stripe.sessions.push({ id: 'cs_live_care000000001', metadata: { nbdProduct: 'roof_care_plan', companyId: 'OWNER' } });
    const p = await X.handlePortal(db, stripe, { sessionId: 'cs_live_care000000001' });
    ok('a member\'s session opens THEIR portal', p.status === 200 && /cus_member/.test(p.body.url) && stripe.portalSessions[0].customer === 'cus_member');
    await X.handlePortal(db, stripe, { sessionId: 'cs_live_care000000001' });
    ok('the portal configuration is created once (lazy, remembered)', stripe.portalConfigs === 1 && db._get('careplan_config/stripe').portalConfigId === 'bpc_1');
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'care-plan.js'), 'utf8');
    ok('cancel is enabled in the portal, at period end', /subscription_cancel:\s*\{\s*enabled:\s*true,\s*mode:\s*'at_period_end'\s*\}/.test(src));
    ok('the portal works in every mode (cancel never goes dark)', /body\.action === 'portal'\)\s*\{\s*out = await handlePortal/.test(src.replace(/\/\/.*$/gm, '')));
  }

  console.log('\n11. who may use the CRM actions');
  {
    const call = (uid, token) => () => X.requireOwner({ auth: uid ? { uid, token: token || {} } : null }, (t) => t.role === 'admin');
    ok('signed out → refused', await rejects(call(null), /unauthenticated/));
    ok('the NBD owner → allowed', !(await rejects(call('OWNER'))));
    ok('NBD\'s company_admin → allowed', !(await rejects(call('ca', { companyId: 'OWNER', role: 'company_admin' }))));
    ok('NBD\'s sales_rep → refused', await rejects(call('rep', { companyId: 'OWNER', role: 'sales_rep' }), /permission-denied/));
    ok('ANOTHER tenant\'s company_admin → refused', await rejects(call('x', { companyId: 'co-other', role: 'company_admin' }), /permission-denied/));
  }

  console.log('\n12. stripeWebhook (NBD Pro billing) skips care-plan objects');
  {
    const raw = fs.readFileSync(path.join(ROOT, 'functions', 'stripe.js'), 'utf8');
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const caseBody = (name) => { const i = src.indexOf("case '" + name + "'"); const j = src.indexOf('case ', i + 10); return i === -1 ? '' : src.slice(i, j === -1 ? undefined : j); };
    const cs = caseBody('checkout.session.completed');
    ok('checkout.session.completed: guard BEFORE the subscriptions/{uid} write', /isCarePlanObject\(session\)/.test(cs) && cs.indexOf('isCarePlanObject(session)') < cs.indexOf('subscriptions/${uid}') && cs.indexOf('isCarePlanObject(session)') < cs.indexOf('client_reference_id'));
    for (const name of ['customer.subscription.updated', 'customer.subscription.deleted']) {
      const b = caseBody(name);
      ok(name + ': guard BEFORE the subscriptions lookup', /isCarePlanObject\(subscription\)/.test(b) && b.indexOf('isCarePlanObject(subscription)') < b.indexOf(".collection('subscriptions')"));
    }
    const pf = caseBody('invoice.payment_failed');
    ok('invoice.payment_failed: guard BEFORE the lookup', pf.indexOf('isCarePlanObject(invoice)') !== -1 && pf.indexOf('isCarePlanObject(invoice)') < pf.indexOf(".collection('subscriptions')"));
    const ip = caseBody('invoice.paid');
    ok('invoice.paid: guard BEFORE the usage reset', ip.indexOf('isCarePlanObject(invoice)') !== -1 && ip.indexOf('isCarePlanObject(invoice)') < ip.indexOf(".collection('subscriptions')"));
    ok('the guard is the real classifier from care-plan-logic', /const \{ isCarePlanObject \} = require\('\.\/care-plan-logic'\)/.test(src));
  }

  console.log('\n13. wiring');
  {
    const idx = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
    ok('index.js exports the three functions by name (not the test seam)', /^exports\.carePlanPublic\s*=\s*carePlan\.carePlanPublic;/m.test(idx)
      && /^exports\.carePlanWebhook\s*=\s*carePlan\.carePlanWebhook;/m.test(idx) && /^exports\.carePlanAdmin\s*=\s*carePlan\.carePlanAdmin;/m.test(idx) && !/carePlan\._internal/.test(idx));
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'care-plan.js'), 'utf8');
    ok('every function is 256MiB (never below)', (src.match(/memory:\s*'256MiB'/g) || []).length === 3 && !/memory:\s*'128MiB'/.test(src));
    ok('the callable enforces App Check; the onRequest ones do not pretend to', /onCall\(\s*\{[^}]*enforceAppCheck:\s*true/.test(src) && (src.match(/enforceAppCheck/g) || []).length === 1);
    ok('the webhook fails closed without a real whsec_', /!whsec \|\| !whsec\.startsWith\('whsec_'\)/.test(src) && /status\(503\)/.test(src));
    ok('webhook idempotency marker lives in its own collection', /collection\('careplan_events'\)/.test(src) && !/stripe_events/.test(src.replace(/\/\/.*$/gm, '')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
