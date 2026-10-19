/**
 * tests/messaging-controls-2026-10-19.test.js
 *
 * The ONE kill switch (messaging_controls/global) and the canary, driven
 * through the real functions/messaging-controls.js and the real callable in a
 * fake Firestore world (tests/lib/sms-compliance-world.js). Nothing reaches
 * Twilio, Resend or Firestore.
 *
 *   A. Fail closed: missing doc, unreadable doc, string "true", master off,
 *      channel off -> NOT allowed; only exact booleans open a channel.
 *   B. Cache: a flip is seen after force / after the TTL, not before.
 *   C. Canary: SMS -> owner number with [would send to X]; email -> owner only,
 *      cc/bcc dropped, original recipients shown; no owner contact -> blocked.
 *   D. Internal alerts: own switch (absent = on), owner contact from config,
 *      hourly cap, cap 0 = none.
 *   E. manageMessagingControls: Jo only, reason required, booleans only,
 *      audit row with before/after, owner phone never written in full.
 *
 * Run: node tests/messaging-controls-2026-10-19.test.js
 */
'use strict';
const W = require('./lib/sms-compliance-world');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const ALL_ON = { customerSendsEnabled: true, smsEnabled: true, emailEnabled: true, otpEnabled: true };
const OWNER = { ownerPhone: '(859) 555-0199', ownerEmail: 'Owner@Example.test' };

function mc(opts) {
  const w = W.makeWorld(Object.assign({ noControls: true }, opts));
  const m = W.load(w, 'messaging-controls.js');
  m._resetCache();
  return { w, m, db: w.db };
}

(async () => {
  console.log('A. fail closed');
  {
    let { m, db } = mc({});
    let s = await m.channelStatus(db, 'sms');
    ok('missing doc -> not allowed (controls_missing)', !s.allowed && s.reason === 'controls_missing', JSON.stringify(s));
    ({ m, db } = mc({ docs: { 'messaging_controls/global': ALL_ON }, readThrows: (p) => p === 'messaging_controls/global' }));
    s = await m.channelStatus(db, 'sms');
    ok('unreadable doc -> not allowed (controls_unreadable)', !s.allowed && s.reason === 'controls_unreadable', JSON.stringify(s));
    ({ m, db } = mc({ docs: { 'messaging_controls/global': ALL_ON } }));
    for (const ch of ['sms', 'mms', 'email', 'otp', 'bland_sms']) {
      s = await m.channelStatus(db, ch);
      ok('all on -> ' + ch + ' allowed, not canary', s.allowed && !s.canary && s.reason === null, JSON.stringify(s));
    }
    s = await m.channelStatus(db, 'carrier_pigeon');
    ok('unknown channel -> not allowed', !s.allowed);
    ({ m, db } = mc({ docs: { 'messaging_controls/global': Object.assign({}, ALL_ON, { customerSendsEnabled: 'true' }) } }));
    s = await m.channelStatus(db, 'sms');
    ok('string "true" is not true', !s.allowed && s.reason === 'customer_sends_off', JSON.stringify(s));
    ({ m, db } = mc({ docs: { 'messaging_controls/global': Object.assign({}, ALL_ON, { customerSendsEnabled: false }) } }));
    s = await m.channelStatus(db, 'email');
    ok('master off beats channel on', !s.allowed && s.reason === 'customer_sends_off');
    ({ m, db } = mc({ docs: { 'messaging_controls/global': Object.assign({}, ALL_ON, { smsEnabled: false }) } }));
    ok('sms off blocks sms', !(await m.channelStatus(db, 'sms')).allowed);
    ok('sms off blocks mms and bland_sms (same switch)', !(await m.channelStatus(db, 'mms')).allowed && !(await m.channelStatus(db, 'bland_sms')).allowed);
    ok('sms off leaves email allowed', (await m.channelStatus(db, 'email')).allowed);
    ({ m, db } = mc({ docs: { 'messaging_controls/global': { customerSendsEnabled: true } } }));
    s = await m.channelStatus(db, 'otp');
    ok('channel absent -> channel_off (not on by default)', !s.allowed && s.reason === 'channel_off');
  }

  console.log('B. cache');
  {
    const { w, m, db } = mc({ docs: { 'messaging_controls/global': ALL_ON } });
    ok('first read allowed', (await m.channelStatus(db, 'sms', { nowMs: 1000 })).allowed);
    w.store.set('messaging_controls/global', Object.assign({}, ALL_ON, { customerSendsEnabled: false }));
    ok('inside the TTL the old answer stands (bounded staleness)', (await m.channelStatus(db, 'sms', { nowMs: 1000 + m.CACHE_MS - 1 })).allowed);
    ok('after the TTL the flip is seen', !(await m.channelStatus(db, 'sms', { nowMs: 1000 + m.CACHE_MS + 1 })).allowed);
    w.store.set('messaging_controls/global', ALL_ON);
    ok('force bypasses the cache', (await m.channelStatus(db, 'sms', { nowMs: 1000 + m.CACHE_MS + 2, force: true })).allowed);
    // an unreadable read is NOT cached as "on" or "off": the next read retries
    const w2 = W.makeWorld({ noControls: true, docs: { 'messaging_controls/global': ALL_ON }, readThrows: () => w2.fail });
    w2.fail = true;
    const m2 = W.load(w2, 'messaging-controls.js'); m2._resetCache();
    ok('read error -> closed', !(await m2.channelStatus(w2.db, 'sms', { nowMs: 5 })).allowed);
    w2.fail = false;
    ok('error was not cached: recovers on the next read', (await m2.channelStatus(w2.db, 'sms', { nowMs: 6 })).allowed);
  }

  console.log('C. canary');
  {
    const docs = { 'messaging_controls/global': Object.assign({}, ALL_ON, { canary: true }), 'messaging_controls/internal': OWNER };
    const { m, db } = mc({ docs });
    const s = await m.guardSms(db, '+18595550123', 'Hi Sam - got your request.');
    ok('SMS canary: sends, flagged canary', s.send && s.canary);
    ok('SMS canary: goes to the OWNER number from config', s.to === '+18595550199', s.to);
    ok('SMS canary: body shows [would send to <customer>]', s.body.indexOf('[would send to +18595550123]') === 0 && s.body.indexOf('got your request') > 0, s.body);
    ok('SMS canary: customer number is not the recipient', s.to !== '+18595550123');
    const e = await m.guardEmail(db, { to: 'cust@x.test', cc: ['c2@x.test'], bcc: 'b@x.test', reply_to: 'cust@x.test', subject: 'Your estimate', html: '<p>Hello</p>', text: 'Hello', from: 'a@b.test' });
    ok('email canary: sends, flagged', e.send && e.canary);
    ok('email canary: to is only the owner (normalised)', JSON.stringify(e.msg.to) === '["owner@example.test"]', JSON.stringify(e.msg.to));
    ok('email canary: cc / bcc / reply_to dropped', !('cc' in e.msg) && !('bcc' in e.msg) && !('reply_to' in e.msg));
    ok('email canary: original recipients shown in html and text',
      /\[would send to cust@x\.test \(cc c2@x\.test\) \(bcc b@x\.test\)\]/.test(e.msg.html) && /\[would send to cust@x\.test/.test(e.msg.text));
    ok('email canary: subject tagged, body preserved', e.msg.subject === '[CANARY] Your estimate' && e.msg.html.indexOf('<p>Hello</p>') > 0);
    ok('email canary: customer address appears only inside the banner text, never in a to-style field',
      JSON.stringify(e.msg.to).indexOf('cust@x.test') === -1);
    const html = (await m.guardEmail(db, { to: 'a<b>@x.test', subject: 's', html: '<p>x</p>' })).msg;
    ok('email canary banner is HTML-escaped (to value is not markup)', html && html.html.indexOf('<b>') === -1);

    const noOwner = mc({ docs: { 'messaging_controls/global': Object.assign({}, ALL_ON, { canary: true }) } });
    const s2 = await noOwner.m.guardSms(noOwner.db, '+18595550123', 'hi');
    ok('canary with no owner contact -> BLOCKED, never falls through to the customer', !s2.send && s2.reason === 'canary_no_target');
    const e2 = await noOwner.m.guardEmail(noOwner.db, { to: 'cust@x.test', subject: 's', text: 't' });
    ok('canary email with no owner address -> BLOCKED', !e2.send && e2.reason === 'canary_no_target');

    const off = mc({ docs: { 'messaging_controls/global': Object.assign({}, ALL_ON, { canary: true, customerSendsEnabled: false }), 'messaging_controls/internal': OWNER } });
    ok('canary does not override a closed master switch', !(await off.m.guardSms(off.db, '+18595550123', 'hi')).send);
    const live = mc({ docs: { 'messaging_controls/global': ALL_ON, 'messaging_controls/internal': OWNER } });
    const s3 = await live.m.guardSms(live.db, '+18595550123', 'hi');
    ok('canary off: customer number and body untouched', s3.send && !s3.canary && s3.to === '+18595550123' && s3.body === 'hi');
  }

  console.log('D. internal alerts');
  {
    let { m, db } = mc({});
    let s = await m.internalAlertStatus(db, 'sms');
    ok('no owner phone configured -> owner_phone_not_configured', !s.allowed && s.reason === 'owner_phone_not_configured');
    ({ m, db } = mc({ docs: { 'messaging_controls/internal': OWNER } }));
    s = await m.internalAlertStatus(db, 'sms', { nowMs: Date.parse('2026-10-19T15:00:00Z') });
    ok('owner phone from config -> allowed, with the number', s.allowed && s.phone === '+18595550199');
    ok('internal alerts work with NO messaging_controls/global at all (separate switch)', s.allowed);
    ({ m, db } = mc({ docs: { 'messaging_controls/internal': Object.assign({}, OWNER, { internalAlertsEnabled: false }) } }));
    s = await m.internalAlertStatus(db, 'sms');
    ok('internalAlertsEnabled:false -> off', !s.allowed && s.reason === 'internal_alerts_off');
    const prev = process.env.INTERNAL_SMS_PER_HOUR;
    process.env.INTERNAL_SMS_PER_HOUR = '2';
    ({ m, db } = mc({ docs: { 'messaging_controls/internal': OWNER } }));
    const t = Date.parse('2026-10-19T15:00:00Z');
    const r = [];
    for (let i = 0; i < 4; i++) r.push((await m.internalAlertStatus(db, 'sms', { nowMs: t + i, force: true })).allowed);
    ok('hourly cap of 2: third and fourth are refused', JSON.stringify(r) === '[true,true,false,false]', JSON.stringify(r));
    ok('next hour starts a fresh count', (await m.internalAlertStatus(db, 'sms', { nowMs: t + 3600_000, force: true })).allowed);
    process.env.INTERNAL_SMS_PER_HOUR = '0';
    ({ m, db } = mc({ docs: { 'messaging_controls/internal': OWNER } }));
    ok('cap 0 means no internal SMS (zero is zero)', !(await m.internalAlertStatus(db, 'sms', { nowMs: t })).allowed);
    if (prev === undefined) delete process.env.INTERNAL_SMS_PER_HOUR; else process.env.INTERNAL_SMS_PER_HOUR = prev;
  }

  console.log('E. manageMessagingControls callable');
  {
    async function call(data, uid, docs) {
      const w = W.makeWorld({ noControls: true, docs: docs || {} });
      const mod = W.load(w, 'messaging-controls-fns.js');
      let out, err;
      try { out = await mod.manageMessagingControls.__handler({ auth: uid ? { uid, token: {} } : null, data }); } catch (e) { err = e; }
      return { w, out, err };
    }
    let r = await call({ action: 'get' }, null);
    ok('signed out -> unauthenticated', r.err && r.err.code === 'unauthenticated');
    r = await call({ action: 'set', patch: { canary: true }, reason: 'testing' }, 'someone-else');
    ok('any other signed-in user -> permission-denied', r.err && r.err.code === 'permission-denied');
    ok('...and nothing was written', !r.w.store.has('messaging_controls/global'));
    r = await call({ action: 'set', patch: { canary: true } }, NBD);
    ok('no reason -> invalid-argument', r.err && r.err.code === 'invalid-argument' && !r.w.store.has('messaging_controls/global'));
    r = await call({ action: 'set', patch: { canary: 'yes' }, reason: 'because' }, NBD);
    ok('non-boolean -> invalid-argument', r.err && r.err.code === 'invalid-argument');
    r = await call({ action: 'set', patch: { adminOverride: true }, reason: 'because' }, NBD);
    ok('unknown field -> invalid-argument', r.err && r.err.code === 'invalid-argument');
    r = await call({ action: 'set', patch: {}, reason: 'because' }, NBD);
    ok('empty patch -> invalid-argument', r.err && r.err.code === 'invalid-argument');
    r = await call({ action: 'set', patch: { customerSendsEnabled: true, smsEnabled: true, canary: true }, reason: 'first canary test' }, NBD);
    ok('Jo can set controls', !r.err && r.out.ok && r.out.controls.customerSendsEnabled === true && r.out.controls.canary === true, r.err && r.err.message);
    const doc = r.w.store.get('messaging_controls/global');
    ok('doc written with the patch', doc && doc.customerSendsEnabled === true && doc.canary === true && doc.updatedBy === NBD);
    const auditRows = [...r.w.store.entries()].filter(([k]) => k.indexOf('messaging_controls_audit/') === 0).map(([, v]) => v);
    ok('every flip is audit-logged with reason, before and after',
      auditRows.length === 1 && auditRows[0].reason === 'first canary test' && auditRows[0].byUid === NBD
      && auditRows[0].before.customerSendsEnabled === false && auditRows[0].after.customerSendsEnabled === true, JSON.stringify(auditRows));
    r = await call({ action: 'setInternal', patch: { ownerPhone: '(859) 555-0177', ownerEmail: 'jo@example.test' }, reason: 'set contact' }, NBD);
    ok('Jo can set the owner contact', !r.err && r.out.internal.ownerPhoneSet && r.out.internal.ownerEmailSet, r.err && r.err.message);
    ok('owner phone stored normalised in the internal doc', r.w.store.get('messaging_controls/internal').ownerPhone === '+18595550177');
    const a2 = [...r.w.store.entries()].filter(([k]) => k.indexOf('messaging_controls_audit/') === 0).map(([, v]) => JSON.stringify(v)).join('');
    ok('audit row never carries the phone digits or the email', a2.indexOf('5550177') === -1 && a2.indexOf('jo@example.test') === -1, a2);
    ok('no app log line carries the phone digits', JSON.stringify(r.w.logs.info).indexOf('5550177') === -1);
    r = await call({ action: 'setInternal', patch: { ownerPhone: '123' }, reason: 'bad' }, NBD);
    ok('bad owner phone -> invalid-argument', r.err && r.err.code === 'invalid-argument');
    r = await call({ action: 'get' }, NBD, { 'messaging_controls/internal': { ownerPhone: '+18595550177' } });
    ok('get reports presence, never the number', !r.err && r.out.internal.ownerPhoneSet === true && JSON.stringify(r.out).indexOf('5550177') === -1);
    r = await call({ action: 'wat' }, NBD);
    ok('unknown action -> invalid-argument', r.err && r.err.code === 'invalid-argument');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
