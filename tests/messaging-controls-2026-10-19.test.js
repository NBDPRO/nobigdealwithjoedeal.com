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
const ALL_ON = { customerSendsEnabled: true, smsEnabled: true, emailEnabled: true, otpEnabled: true, canary: false };
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

  console.log('C2. canary fails SAFE: live only when canary is the boolean false');
  {
    const base = { customerSendsEnabled: true, smsEnabled: true, emailEnabled: true, otpEnabled: true };
    for (const [label, val, hasKey] of [['absent', undefined, false], ['string "true"', 'true', true], ['number 1', 1, true], ['null', null, true], ['string "false"', 'false', true], ['0', 0, true]]) {
      const g = Object.assign({}, base); if (hasKey) g.canary = val;
      const withOwner = mc({ docs: { 'messaging_controls/global': g, 'messaging_controls/internal': OWNER } });
      const s = await withOwner.m.guardSms(withOwner.db, '+18595550123', 'hi');
      ok('canary ' + label + ' -> NOT live: redirected to the owner', s.send && s.canary && s.to === '+18595550199', JSON.stringify(s));
      const emOwner = await withOwner.m.guardEmail(withOwner.db, { to: 'c@x.test', subject: 's', text: 't' });
      ok('canary ' + label + ' -> guardEmail redirects to the owner too', emOwner.send && emOwner.canary && JSON.stringify(emOwner.msg.to) === '["owner@example.test"]', JSON.stringify(emOwner.msg && emOwner.msg.to));
      const noOwner = mc({ docs: { 'messaging_controls/global': g } });
      const s2 = await noOwner.m.guardSms(noOwner.db, '+18595550123', 'hi');
      ok('canary ' + label + ' and no owner contact -> nothing is sent', !s2.send, JSON.stringify(s2));
      const e = await noOwner.m.guardEmail(noOwner.db, { to: 'c@x.test', subject: 's', text: 't' });
      ok('canary ' + label + ' and no owner address -> no email', !e.send);
    }
    const live = mc({ docs: { 'messaging_controls/global': Object.assign({}, base, { canary: false }) } });
    const sl = await live.m.guardSms(live.db, '+18595550123', 'hi');
    ok('canary boolean false is the ONLY live state', sl.send && !sl.canary && sl.to === '+18595550123');
    const e2 = mc({ docs: { 'messaging_controls/global': Object.assign({}, base, { canary: true }), 'messaging_controls/internal': OWNER } });
    const em = await e2.m.guardEmail(e2.db, { to: 'c@x.test', subject: 's', text: 't', tags: [{ name: 'nbd_unsub', value: 'tok' }] });
    ok("the owner's canary email drops the customer's unsubscribe/bounce tags", em.send && !('tags' in em.msg));
    const emh = await e2.m.guardEmail(e2.db, { to: 'c@x.test', subject: 's', text: 't', headers: { 'List-Unsubscribe': '<https://x.test/u?t=cust>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'X-NBD-Campaign': 'c' } });
    ok("the owner's canary email carries NO headers (List-Unsubscribe one-click would unsubscribe the real customer)", emh.send && !('headers' in emh.msg));
    const M = mc({}).m;
    ok('maxPerRun cleaning: absent 5; 0; 7; null/false/"abc"/-1/3.5/99 -> 0 (fewer, never more)',
      M.cleanMaxPerRun(undefined) === 5 && M.cleanMaxPerRun(0) === 0 && M.cleanMaxPerRun(7) === 7 && [null, false, 'abc', -1, 3.5, 501].every((v) => M.cleanMaxPerRun(v) === 0));
  }

  console.log('C2b. a canary redirect is flagged so callers do not count it as a delivery');
  {
    const t = mc({ docs: { 'messaging_controls/global': Object.assign({}, ALL_ON, { canary: true }), 'messaging_controls/internal': OWNER } });
    const sent = [];
    const fake = { emails: { send: async (m) => { sent.push(m); return { data: { id: 'x' }, error: null }; } } };
    const r = await t.m.guardResend(t.db, fake).emails.send({ to: 'c@x.test', subject: 's', text: 't' });
    ok('canary: the response carries canary:true and went to the owner', r.canary === true && JSON.stringify(sent[0].to) === '["owner@example.test"]', JSON.stringify(r));
    const live = mc({ docs: { 'messaging_controls/global': ALL_ON } });
    const r2 = await live.m.guardResend(live.db, fake).emails.send({ to: 'c@x.test', subject: 's', text: 't' });
    ok('live: no canary flag', !r2.canary);
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'functions', 'esign-io.js'), 'utf8');
    ok('esign-io.sendMail treats a canary response as NOT emailed', /response\.canary === true\) return \{ emailed: false/.test(src));
  }

  console.log('C3. legal copies (a signed document) are not paused by the customer pause');
  {
    const msg = { to: 'signer@x.test', subject: 'Your signed copy', text: 't' };
    let t = mc({});
    ok('no controls doc: a normal email is blocked...', !(await t.m.guardEmail(t.db, msg)).send);
    ok('...but the signed copy (legal) still goes, to the signer, not redirected', (await t.m.guardEmail(t.db, msg, { legal: true })).send === true);
    t = mc({ docs: { 'messaging_controls/global': Object.assign({}, ALL_ON, { customerSendsEnabled: false, canary: true }), 'messaging_controls/internal': OWNER } });
    const g = await t.m.guardEmail(t.db, msg, { legal: true });
    ok('master off + canary on: the signed copy still goes to the signer (ignores both)', g.send && !g.canary && g.msg.to === 'signer@x.test', JSON.stringify(g));
    t = mc({ docs: { 'messaging_controls/global': Object.assign({}, ALL_ON, { customerSendsEnabled: false, legalCopiesEnabled: false }) } });
    ok('legalCopiesEnabled:false (the narrow switch) puts the signed copy back under the pause', (await t.m.guardEmail(t.db, msg, { legal: true })).send === false);
    t = mc({ readThrows: (p) => p === 'messaging_controls/global' });
    ok('unreadable controls: the signed copy still goes (default ON for legal copies)', (await t.m.guardEmail(t.db, msg, { legal: true })).send === true);
    ok('a NON-legal email stays blocked when controls are unreadable', (await t.m.guardEmail(t.db, msg)).send === false);
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'functions', 'esign-envelope.js'), 'utf8');
    ok('esign-envelope: the signed copy is sent with { legal: true } and a failed copy raises a high "NOT emailed" bell',
      /\{ legal: true \}\);/.test(src) && /Signed copy NOT emailed/.test(src));
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
    // distinct-subject cap: repeats of the SAME lead do not use up the hour
    process.env.INTERNAL_SMS_PER_HOUR = '2';
    ({ m, db } = mc({ docs: { 'messaging_controls/internal': OWNER } }));
    const kr = [];
    for (const k of ['lead-1', 'lead-1', 'lead-1', 'lead-2', 'lead-3', 'lead-2']) kr.push((await m.internalAlertStatus(db, 'sms', { nowMs: t + 10, force: true, key: k })).allowed);
    ok('cap of 2 by DISTINCT lead: repeats of a lead are free, the third distinct lead is refused', JSON.stringify(kr) === '[true,true,true,true,false,true]', JSON.stringify(kr));
    process.env.INTERNAL_SMS_PER_HOUR = '1';
    ({ m, db } = mc({ docs: { 'messaging_controls/internal': OWNER } }));
    const dr = [];
    for (const k of ['lead-a', 'lead-b', 'lead-b', 'lead-b', 'lead-a']) dr.push((await m.internalAlertStatus(db, 'sms', { nowMs: t + 20, force: true, key: k })).allowed);
    ok('a lead DENIED by the cap is denied again on retry (no marker written) while the allowed lead repeats free', JSON.stringify(dr) === '[true,false,false,false,true]', JSON.stringify(dr));
    process.env.INTERNAL_SMS_PER_HOUR = '1';
    ({ m, db } = mc({ docs: { 'messaging_controls/internal': OWNER } }));
    const fl = [];
    for (const k of ['f1', 'f2', 'f3']) fl.push((await m.internalAlertStatus(db, 'sms', { nowMs: t + 30, force: true, key: k, bucket: 'lead' })).allowed);
    fl.push((await m.internalAlertStatus(db, 'sms', { nowMs: t + 30, force: true })).allowed);
    ok('a public-form lead flood uses up only the lead bucket: a storm/call alert still gets its own allowance', JSON.stringify(fl) === '[true,false,false,true]', JSON.stringify(fl));
    process.env.INTERNAL_SMS_PER_HOUR = '0';
    ({ m, db } = mc({ docs: { 'messaging_controls/internal': OWNER } }));
    ok('cap 0 means no internal SMS (zero is zero)', !(await m.internalAlertStatus(db, 'sms', { nowMs: t })).allowed);
    if (prev === undefined) delete process.env.INTERNAL_SMS_PER_HOUR; else process.env.INTERNAL_SMS_PER_HOUR = prev;
  }

  console.log('E. manageMessagingControls callable');
  {
    async function call(data, uid, docs, o) {
      const w = W.makeWorld({ noControls: true, docs: docs || {} });
      const mod = W.load(w, 'messaging-controls-fns.js');
      if (o && o.auditFails) {
        const orig = w.db.collection;
        w.db.collection = (n) => (n === 'messaging_controls_audit' ? { doc: () => ({ set: async () => { throw new Error('audit down'); } }) } : orig(n));
      }
      const authTime = o && o.authTime !== undefined ? o.authTime : Math.floor(Date.now() / 1000);
      let out, err;
      try { out = await mod.manageMessagingControls.__handler({ auth: uid ? { uid, token: authTime === null ? {} : { auth_time: authTime } } : null, data }); } catch (e) { err = e; }
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
    const stale = Math.floor(Date.now() / 1000) - 3600;
    r = await call({ action: 'set', patch: { customerSendsEnabled: true }, reason: 'turn on' }, NBD, {}, { authTime: stale });
    ok('turning sends ON needs a recent sign-in (stale auth_time -> failed-precondition), nothing written', r.err && r.err.code === 'failed-precondition' && !r.w.store.has('messaging_controls/global'));
    r = await call({ action: 'set', patch: { customerSendsEnabled: true }, reason: 'turn on' }, NBD, {}, { authTime: null });
    ok('...a token with no auth_time at all is treated as stale', r.err && r.err.code === 'failed-precondition');
    r = await call({ action: 'set', patch: { canary: false }, reason: 'go live' }, NBD, {}, { authTime: stale });
    ok('canary -> false (going live) needs a recent sign-in too', r.err && r.err.code === 'failed-precondition');
    r = await call({ action: 'set', patch: { customerSendsEnabled: false, canary: true }, reason: 'stop' }, NBD, {}, { authTime: stale });
    ok('turning things OFF never needs a recent sign-in', !r.err && r.out.ok === true, r.err && r.err.message);
    r = await call({ action: 'setInternal', patch: { ownerPhone: '(859) 555-0177' }, reason: 'contact' }, NBD, {}, { authTime: stale });
    ok('changing the owner contact needs a recent sign-in', r.err && r.err.code === 'failed-precondition' && !r.w.store.has('messaging_controls/internal'));
    r = await call({ action: 'setAutomations', patch: { leadAckSms: true }, reason: 'switch it on' }, NBD, {}, { authTime: stale });
    ok('turning an automation ON needs a recent sign-in', r.err && r.err.code === 'failed-precondition');
    r = await call({ action: 'setAutomations', patch: { leadAckSms: false }, reason: 'switch it off' }, NBD, {}, { authTime: stale });
    ok('...turning one OFF does not', !r.err && r.out.ok);
    r = await call({ action: 'set', patch: { customerSendsEnabled: true }, reason: 'turn on' }, NBD, {}, { auditFails: true });
    ok('AUDIT FIRST: if the audit row cannot be written the flip does not happen', r.err && r.err.code === 'unavailable' && !r.w.store.has('messaging_controls/global'), r.err && r.err.code);
    r = await call({ action: 'set', patch: { customerSendsEnabled: true }, reason: 'turn on' }, NBD);
    const rows2 = [...r.w.store.entries()].filter(([k]) => k.indexOf('messaging_controls_audit/') === 0).map(([, v]) => v);
    ok('the audit row records intent -> applied with before and after', rows2.length === 1 && rows2[0].status === 'applied' && rows2[0].before.customerSendsEnabled === false && rows2[0].after.customerSendsEnabled === true, JSON.stringify(rows2));
    r = await call({ action: 'setInternal', patch: { ownerPhone: '(859) 555-0166' }, reason: 'new phone' }, NBD, { 'messaging_controls/internal': { ownerPhone: '+18595550177', ownerEmail: 'old@example.test' } });
    const q = [...r.w.store.entries()].filter(([k]) => k.indexOf('email_queue/') === 0).map(([, v]) => v);
    ok('a contact change queues a notice to the PREVIOUS owner email (no phone digits in it)', q.length === 1 && q[0].to === 'old@example.test' && q[0].status === 'pending' && !/5550166|5550177/.test(JSON.stringify(q)), JSON.stringify(q));
    r = await call({ action: 'get' }, NBD, { 'messaging_controls/internal': { ownerPhone: '+18595550177' } });
    ok('get reports presence, never the number', !r.err && r.out.internal.ownerPhoneSet === true && JSON.stringify(r.out).indexOf('5550177') === -1);
    r = await call({ action: 'wat' }, NBD);
    ok('unknown action -> invalid-argument', r.err && r.err.code === 'invalid-argument');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
