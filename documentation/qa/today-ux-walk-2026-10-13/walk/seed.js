// seed.js - a busy-Tuesday seed for the Today walk, EMULATOR ONLY.
//
// Run after the e2e seed (tests/e2e/fixtures/seed-emulator.js) created the
// tenant + user. Wipes this tenant's leads / calls / invoices / appointments
// and writes the scenarios the walk drives. Shapes copy what the app and the
// call ingest write (call-center-view.spec.js, never-forget-client.spec.js).
//
// People (name -> what is open):
//   Dana Whitfield   urgent missed call today + older call carrying Jo's promise  (calls inside a "Promised follow-up" row)
//   Marcus Reyes     overdue "Call back" promise, missed twice                   (Promises)
//   Priya Nair       open call + owed invoice + two waiting items               (Calls owed + Money + Waiting: one person, three sections)
//   Tom Becker       estimate out 6 days, not opened                            (Estimates to follow up)
//   Linda Grant      follow-up date 3 days ago                                  (Stalled)
//   Sam Ortiz        task due today + an UNFILED call from his own number        (rider inside his row)
//   Greg Hale        $1,234 invoice past due                                    (Money)
//   Kim Lowe         inspection at 2 pm today                                   (Appointments)
//   unknown 513-555-0142  urgent "leak" call 10 min ago                         (Calls owed)
//   unknown 513-555-0177  two noted calls                                       (Calls owed, "2 open")
//   unknown 513-555-0166  4 calls in the last 24 h, none noted                  (suggestion: "calling a lot")
//   513-555-0190 "Gulf Eagle"  supplier by AI call type, 3 calls               (suggestion: Supplier)
//   unknown 513-555-0155  texted a promise                                      (text day)
//   unknown 513-555-0120  open Jo promise 60 days ago                           (old promises row)
//   unknown 513-555-0121  urgent call 16 days ago, never handled                (rolls off silently)
//   Stripe ledger: 2 payments need a customer
'use strict';
const lib = require('./lib');

const MIN = 60000, HR = 3600000, DAY = 86400000;

async function wipe(db, uid) {
  for (const c of ['phone_calls', 'phone_text_days', 'invoices', 'appointments', 'stripeLedger', 'contact_labels', 'contact_suggestions', 'thursday_calls', 'thursday_handled']) {
    try {
      const snap = await db.collection(c).where('userId', '==', uid).get();
      for (const d of snap.docs) await d.ref.delete();
      const snap2 = await db.collection(c).where('companyId', '==', uid).get();
      for (const d of snap2.docs) await d.ref.delete();
    } catch (e) { /* collection may not use these fields */ }
  }
  const leads = await db.collection('leads').where('userId', '==', uid).get();
  for (const l of leads.docs) await db.recursiveDelete(l.ref);
}

(async () => {
  const { db } = lib.admin();
  const { uid, co } = await lib.who();
  const now = Date.now();
  const ymd = (off) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + off); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  await wipe(db, uid);

  const base = { userId: uid, companyId: co, createdAt: new Date(now - 20 * DAY), deleted: false };
  const lead = async (id, o) => { await db.doc('leads/' + id).set(Object.assign({}, base, o)); return id; };
  const task = async (leadId, id, o) => db.doc('leads/' + leadId + '/tasks/' + id).set(Object.assign({ done: false, userId: uid, companyId: co, leadId, createdAt: new Date(now - 6 * DAY) }, o));
  const callBase = { userId: uid, companyId: co, source: 'cube-acr', tags: [], alternateLeadIds: [], transcript: null, createdAtMs: now, storagePath: null };
  const ymdOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  const call = async (id, o) => db.doc('phone_calls/' + id).set(Object.assign({}, callBase, { ymd: ymdOf(o.startedAtMs) }, o));

  // customers
  const dana = await lead('ux_dana', { firstName: 'Dana', lastName: 'Whitfield', phone: '5135550101', address: '412 Maple Ave, Florence, KY', stage: 'contacted' });
  const marcus = await lead('ux_marcus', { firstName: 'Marcus', lastName: 'Reyes', phone: '5135550102', address: '88 Ridge Rd, Hebron, KY', stage: 'contacted' });
  const priya = await lead('ux_priya', { firstName: 'Priya', lastName: 'Nair', phone: '5135550103', address: '19 Oak Ct, Union, KY', stage: 'install_complete', email: 'priya@example.test' });
  const tom = await lead('ux_tom', { firstName: 'Tom', lastName: 'Becker', phone: '5135550104', address: '7 Elm St, Burlington, KY', stage: 'estimate_sent', lastSharedAt: new Date(now - 6 * DAY), sharedDocId: 'doc_ux_tom' });
  const linda = await lead('ux_linda', { firstName: 'Linda', lastName: 'Grant', phone: '5135550105', address: '301 Pine St, Erlanger, KY', stage: 'contacted', followUp: ymd(-3) });
  const sam = await lead('ux_sam', { firstName: 'Sam', lastName: 'Ortiz', phone: '5135550106', address: '56 Birch Ln, Independence, KY', stage: 'contacted' });
  const greg = await lead('ux_greg', { firstName: 'Greg', lastName: 'Hale', phone: '5135550107', address: '900 Cedar Dr, Florence, KY', stage: 'install_complete' });
  const kim = await lead('ux_kim', { firstName: 'Kim', lastName: 'Lowe', phone: '5135550108', address: '22 Walnut Way, Walton, KY', stage: 'contacted' });

  // Dana: an older call carrying Jo's promise + an urgent MISSED call 25 minutes ago.
  await call('cube_ux_dana_old', { leadId: dana, bucket: 'customer', contactName: 'Dana Whitfield', phoneDigits: '5135550101', direction: 'inbound', startedAtMs: now - 2 * DAY, status: 'noted', summary: 'Gutter is pulling away; Jo will send the gutter quote.', promises: [{ who: 'jo', text: 'Send the gutter quote', due: null }] });
  await call('cube_ux_dana_missed', { leadId: dana, bucket: 'customer', contactName: 'Dana Whitfield', phoneDigits: '5135550101', direction: 'inbound', startedAtMs: now - 25 * MIN, status: 'short', urgent: true, summary: '' });
  // Marcus: overdue promise task, missed twice.
  await task(marcus, 'promise-ux1', { kind: 'promise', promiseKind: 'callback', text: 'Call back - about the ridge vent', title: 'Call back', why: 'about the ridge vent', dueDate: ymd(-2), madeYmd: ymd(-5), missCount: 2, rescheduleCount: 2 });
  // Priya: one open call (noted, filed), an owed invoice, two waiting items.
  await call('cube_ux_priya', { leadId: priya, bucket: 'customer', contactName: 'Priya Nair', phoneDigits: '5135550103', direction: 'inbound', startedAtMs: now - 3 * HR, status: 'noted', summary: 'Asked when the final invoice is coming.', promises: [], urgent: true });
  await db.collection('invoices').add({ createdBy: uid, userId: uid, companyId: co, leadId: priya, status: 'sent', total: 2450, balanceDue: 2450, invoiceNumber: 'UX-1001', createdAt: new Date(now - 9 * DAY), dueDate: ymd(-2) });
  await task(priya, 'wait-ux1', { kind: 'promise', promiseKind: 'waiting', text: 'Waiting on the adjuster', title: 'Waiting on', why: 'supplement approval', waitingOn: 'adjuster', waitingSince: ymd(-5), madeYmd: ymd(-5), dueDate: ymd(-2), nudgeCount: 1, missCount: 0, rescheduleCount: 0 });
  await task(priya, 'wait-ux2', { kind: 'promise', promiseKind: 'waiting', text: 'Waiting on the supplier', title: 'Waiting on', why: 'drip edge on backorder', waitingOn: 'supplier', waitingSince: ymd(-4), madeYmd: ymd(-4), dueDate: ymd(-1), nudgeCount: 0, missCount: 0, rescheduleCount: 0 });
  // Sam: a task due today + an UNFILED call from his own number.
  await task(sam, 'task-ux1', { text: 'Check the gutter downspout', title: 'Check the gutter downspout', dueDate: ymd(0) });
  await call('cube_ux_sam', { leadId: null, bucket: 'unknown', contactName: '', phoneDigits: '5135550106', direction: 'inbound', startedAtMs: now - 50 * MIN, status: 'noted', summary: 'Asked if we can come Thursday.', promises: [] });
  // Greg: invoice past due.
  await db.collection('invoices').add({ createdBy: uid, userId: uid, companyId: co, leadId: greg, status: 'overdue', total: 1234, balanceDue: 1234, invoiceNumber: 'UX-1002', createdAt: new Date(now - 20 * DAY), dueDate: ymd(-9) });
  // Kim: appointment at 2 pm today.
  const t2 = new Date(); t2.setHours(14, 0, 0, 0);
  await db.collection('appointments').add({ userId: uid, repUid: uid, companyId: co, leadId: kim, title: 'Roof inspection', attendeeName: 'Kim Lowe', attendeePhone: '5135550108', location: '22 Walnut Way, Walton, KY', startTime: t2, endTime: new Date(t2.getTime() + HR), status: 'confirmed', bookingId: 'bk_ux_kim' });
  // Unknown callers.
  await call('cube_ux_leak', { leadId: null, bucket: 'unknown', contactName: '', phoneDigits: '5135550142', direction: 'inbound', startedAtMs: now - 10 * MIN, status: 'stored', urgent: true, summary: 'Caller says water is coming through the kitchen ceiling.' });
  await call('cube_ux_u77a', { leadId: null, bucket: 'unknown', contactName: '', phoneDigits: '5135550177', direction: 'inbound', startedAtMs: now - 5 * HR, status: 'noted', summary: 'Asked about siding.' });
  await call('cube_ux_u77b', { leadId: null, bucket: 'unknown', contactName: '', phoneDigits: '5135550177', direction: 'inbound', startedAtMs: now - 7 * HR, status: 'noted', summary: 'First call, left a message.' });
  for (let i = 0; i < 4; i++) await call('cube_ux_u66_' + i, { leadId: null, bucket: 'unknown', contactName: '', phoneDigits: '5135550166', direction: 'inbound', startedAtMs: now - (2 + i * 3) * HR, status: 'short' });
  for (let i = 0; i < 3; i++) await call('cube_ux_sup_' + i, { leadId: null, bucket: 'contact', contactName: 'Gulf Eagle Supply', phoneDigits: '5135550190', direction: 'inbound', startedAtMs: now - (30 + i * 20) * HR, status: 'noted', callType: 'supplier', summary: 'Your order is ready for pickup.', promises: [] });
  await db.doc('phone_text_days/txt_5135550155_' + ymdOf(now).replace(/-/g, '')).set({ userId: uid, companyId: co, channel: 'text', status: 'noted', leadId: null, contactName: '', phoneDigits: '5135550155', ymd: ymdOf(now), startedAtMs: now - 4 * HR, messageCount: 3, summary: 'Wants a price on a shed roof; Jo said he would text it tonight.', promises: [{ who: 'jo', text: 'Text the shed roof price tonight', due: null }], followUpDate: null, urgent: false });
  await call('cube_ux_old_promise', { leadId: null, bucket: 'unknown', contactName: '', phoneDigits: '5135550120', direction: 'inbound', startedAtMs: now - 60 * DAY, status: 'noted', summary: 'Wanted a gutter guard quote.', promises: [{ who: 'jo', text: 'Send the gutter guard quote', due: null }] });
  await call('cube_ux_old_urgent', { leadId: null, bucket: 'unknown', contactName: '', phoneDigits: '5135550121', direction: 'inbound', startedAtMs: now - 16 * DAY, status: 'noted', urgent: true, summary: 'Tree on the garage roof.' });
  // A call already handled this morning (must NOT show anywhere).
  await call('cube_ux_handled', { leadId: null, bucket: 'unknown', contactName: '', phoneDigits: '5135550199', direction: 'inbound', startedAtMs: now - 6 * HR, status: 'noted', summary: 'Already dealt with.', handledAtMs: now - 5 * HR, urgent: true });
  // Stripe: two payments with no customer.
  for (let i = 0; i < 2; i++) await db.doc('stripeLedger/ux_pi_' + i).set({ companyId: co, userId: uid, needsReview: true, kind: 'payment', amountCents: 150000 + i * 5000, status: 'succeeded', createdAt: new Date(now - (i + 1) * HR) });

  console.log('[ux-seed] seeded for uid ' + uid);
  process.exit(0);
})().catch((e) => { console.error('[ux-seed] FAILED', e); process.exit(1); });
