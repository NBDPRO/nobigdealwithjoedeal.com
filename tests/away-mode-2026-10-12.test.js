#!/usr/bin/env node
/**
 * Away mode + backup person (never-forget lane, 2026-10-12):
 * functions/away-mode-logic.js (pure rules), functions/away-mode.js (callable
 * + tick, run against an in-memory Firestore), docs/pro/js/away-mode.js
 * (client mirror), and the source contracts that keep the security model
 * honest. Design: documentation/projects/AWAY-MODE-BACKUP-2026-10-12.md.
 *
 * Run: node tests/away-mode-2026-10-12.test.js   (no emulator, no network)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const L = require(path.join(ROOT, 'functions/away-mode-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
async function rejects(label, p, re) {
  try { await p; ok(label, false, 'did not throw'); }
  catch (e) { ok(label, re ? re.test(String(e && (e.code || '') + ' ' + (e && e.message))) : true, String(e && e.message)); }
}

const MIN = 60000, H = 3600000, D = 86400000;
// Tuesday 2026-10-13, 2:00 PM Eastern (inside the day, outside quiet hours).
const NOW = Date.parse('2026-10-13T18:00:00Z');
const NIGHT = Date.parse('2026-10-14T02:30:00Z');   // 10:30 PM Eastern
const cfg = (o) => L.normalizeConfig(o || {});
const BK = { ok: true, kind: 'member', uid: 'u-sam', name: 'Sam' };
const item = (o) => Object.assign({ key: 'num:8595550147', kind: 'person', who: 'Maria Santos', why: 'missed call', urgent: false, atMs: NOW - 3 * H, phone10: '8595550147' }, o || {});
const resolve = (o) => L.resolveBackupNotifications(Object.assign({ config: cfg(), items: [item()], now: NOW, notified: {}, backup: BK, away: null, ownerName: 'Joe' }, o || {}));

(async () => {
  console.log('A. config — clamped, never trusts the client');
  {
    const c = cfg({ ackWindowMin: 99999, awayWindowMin: 1, backup: { memberEmail: ' SAM@X.COM ' }, schedule: { unavailable: [{ days: [1, 1, 9, 'x'], startMin: 480, endMin: 1020 }, { days: [], startMin: 1, endMin: 2 }] } });
    ok('ack window clamped to 480, away to 10', c.ackWindowMin === 480 && c.awayWindowMin === 10);
    ok('member email lower-cased and trimmed', c.backup.memberEmail === 'sam@x.com');
    ok('schedule keeps only valid windows with de-duped days', c.schedule.unavailable.length === 1 && c.schedule.unavailable[0].days.join() === '1');
    ok('defaults: 120 / 30', cfg().ackWindowMin === 120 && cfg().awayWindowMin === 30);
    const v = L.validateSave({ ackWindowMin: 5 });
    ok('validateSave refuses a wait under 15 minutes', !v.ok && /15/.test(v.error));
    ok('validateSave: member backup needs a real email', !L.validateSave({ backup: { kind: 'member', memberEmail: 'nope' } }).ok);
    ok('validateSave: external backup needs the consent tick', !L.validateSave({ backup: { kind: 'external', external: { name: 'Pat', phone: '8595550100' } } }).ok);
    const ex = L.validateSave({ backup: { kind: 'external', external: { name: 'Pat', phone: '(859) 555-0100', consent: true } } }, NOW);
    ok('external backup with consent is accepted and stamped', ex.ok && ex.config.backup.external.consentAtMs === NOW && ex.config.backup.memberEmail === null);
    ok('external backup refuses a bad phone', !L.validateSave({ backup: { kind: 'external', external: { name: 'Pat', phone: '555', consent: true } } }).ok);
    ok('kind none clears the backup', L.validateSave({ backup: { kind: 'none' }, current: { backup: { memberEmail: 'a@b.co' } } }).config.backup.memberEmail === null);
  }

  console.log('B. who can be the backup');
  {
    const row = (o) => Object.assign({ status: 'active', uid: 'u-sam', role: 'sales_rep', email: 'sam@x.com', displayName: 'Sam R' }, o || {});
    ok('active claimed rep is fine', L.verifyBackup(row(), { ownerUid: 'own' }).ok === true);
    ok('missing row → not_member', L.verifyBackup(null).reason === 'not_member');
    ok('deactivated → inactive', L.verifyBackup(row({ status: 'deactivated' })).reason === 'inactive');
    ok('invited, not joined → unclaimed', L.verifyBackup(row({ status: 'invited', uid: '' })).reason === 'unclaimed');
    ok('active but no uid → unclaimed', L.verifyBackup(row({ uid: '' })).reason === 'unclaimed');
    ok('the owner cannot be their own backup', L.verifyBackup(row({ uid: 'own' }), { ownerUid: 'own' }).reason === 'is_owner');
    ok('a viewer cannot be a backup (decision B)', L.verifyBackup(row({ role: 'viewer' })).reason === 'viewer');
    ok('an access-code member cannot either', L.verifyBackup(row({ role: 'member' })).reason === 'viewer');
    ok('external backup without consent is not usable', L.externalBackup(cfg({ backup: { external: { name: 'Pat', phone: '8595550100' } } })).ok === false);
  }

  console.log('C. the window — 21-day cap, expiry');
  {
    ok('off → inactive', L.awayWindowState({ on: false }, NOW).state === 'inactive' && L.awayWindowState(null, NOW).state === 'inactive');
    ok('on with a future end → active', L.awayWindowState({ on: true, startMs: NOW - H, untilMs: NOW + D }, NOW).state === 'active');
    ok('on past its end → expired', L.awayWindowState({ on: true, startMs: NOW - 2 * D, untilMs: NOW - MIN }, NOW).state === 'expired');
    const open = L.awayWindowState({ on: true, startMs: NOW - 20 * D, untilMs: null }, NOW);
    ok('open-ended is active until day 21', open.state === 'active' && open.openEnded === true);
    ok('open-ended past 21 days ends itself', L.awayWindowState({ on: true, startMs: NOW - 22 * D, untilMs: null }, NOW).state === 'expired');
    ok('an end date past the cap is clamped to the cap', L.awayWindowState({ on: true, startMs: NOW - 22 * D, untilMs: NOW + 30 * D }, NOW).state === 'expired');
  }

  console.log('D. resolver — thresholds');
  {
    ok('normal: 3 h old non-urgent, window 120 → told', resolve().notify.length === 1);
    ok('normal: 90 min old non-urgent → not due', (resolve({ items: [item({ atMs: NOW - 90 * MIN })] }).skipped[0] || {}).why === 'not_due');
    ok('normal: urgent uses min(window, 30) → told at 31 min', resolve({ items: [item({ urgent: true, atMs: NOW - 31 * MIN })] }).notify.length === 1);
    ok('normal: urgent at 20 min → not yet', resolve({ items: [item({ urgent: true, atMs: NOW - 20 * MIN })] }).notify.length === 0);
    const away = { on: true, startMs: NOW - 5 * H, untilMs: NOW + D };
    ok('away: urgent is told at once', resolve({ away, items: [item({ urgent: true, atMs: NOW - MIN })] }).notify.length === 1);
    ok('away: non-urgent uses the 30 min away window', resolve({ away, items: [item({ atMs: NOW - 31 * MIN })] }).notify.length === 1 && resolve({ away, items: [item({ atMs: NOW - 20 * MIN })] }).notify.length === 0);
    const lateStart = { on: true, startMs: NOW - 10 * MIN, untilMs: NOW + D };
    ok('away just turned on: a 3-hour-old item is measured from the window start (no instant flood)',
      resolve({ away: lateStart, items: [item({ atMs: NOW - 3 * H })] }).notify.length === 0);
    ok('unavailable schedule window behaves like away', (() => {
      const c = cfg({ schedule: { unavailable: [{ days: [2], startMin: 13 * 60, endMin: 17 * 60 }] } }); // Tue 1–5 PM ET
      return resolve({ config: c, items: [item({ atMs: NOW - 35 * MIN })] }).notify.length === 1 && resolve({ items: [item({ atMs: NOW - 35 * MIN })] }).notify.length === 0;
    })());
    ok('overnight unavailable window wraps midnight', L.isInUnavailableWindow(cfg({ schedule: { unavailable: [{ days: [2], startMin: 22 * 60, endMin: 6 * 60 }] } }), Date.parse('2026-10-14T08:00:00Z')) === true);
  }

  console.log('E. resolver — acknowledged, old, repeats, no backup');
  {
    ok('acknowledged items are skipped', (resolve({ items: [item({ ackedAtMs: NOW - H })] }).skipped[0] || {}).why === 'acknowledged');
    ok('items older than 7 days are left to Jo\'s own digest', (resolve({ items: [item({ atMs: NOW - 8 * D })] }).skipped[0] || {}).why === 'too_old');
    ok('told 10 minutes ago → not re-told', resolve({ notified: { 'num:8595550147': { count: 1, lastAtMs: NOW - 10 * MIN } } }).skipped[0].why === 'told_recently');
    const again = resolve({ notified: { 'num:8595550147': { count: 1, lastAtMs: NOW - 5 * H } } });
    ok('told 5 h ago → one reminder, worded as a reminder', again.notify.length === 1 && /reminder/.test(again.notify[0].body));
    ok('after 1 + 2 repeats it is exhausted', resolve({ notified: { 'num:8595550147': { count: 3, lastAtMs: NOW - 9 * H } } }).skipped[0].why === 'exhausted');
    const none = resolve({ backup: null });
    ok('no backup → nothing sent, reason no_backup', none.notify.length === 0 && none.backupProblem === 'no_backup' && none.skipped[0].why === 'no_backup');
    const gone = resolve({ backup: { ok: false, reason: 'inactive' } });
    ok('deactivated backup → nothing sent, reason surfaces', gone.notify.length === 0 && gone.backupProblem === 'inactive' && gone.skipped[0].why === 'backup_unavailable');
    ok('duplicate keys are told once', resolve({ items: [item(), item()] }).notify.length === 1);
  }

  console.log('F. resolver — quiet hours, digest, wording');
  {
    ok('10:30 PM: non-urgent is held', (resolve({ now: NIGHT, items: [item({ atMs: NIGHT - 5 * H })] }).skipped[0] || {}).why === 'quiet_hours');
    ok('10:30 PM: urgent still reaches a teammate', resolve({ now: NIGHT, items: [item({ urgent: true, atMs: NIGHT - 2 * H })] }).notify.length === 1);
    const ext = { ok: true, kind: 'external', name: 'Pat', phone: '8595550100' };
    ok('10:30 PM: urgent does NOT override quiet hours for an external contact', (resolve({ now: NIGHT, backup: ext, items: [item({ urgent: true, atMs: NIGHT - 2 * H })] }).skipped[0] || {}).why === 'quiet_hours');
    ok('the quiet window is 21:00-08:00 Eastern', L.inQuietHours(Date.parse('2026-10-13T01:00:00Z')) && !L.inQuietHours(Date.parse('2026-10-13T13:00:00Z')) && L.inQuietHours(Date.parse('2026-10-14T01:00:00Z')));
    const many = [1, 2, 3, 4, 5].map((i) => item({ key: 'num:85955501' + i + i, who: 'Person ' + i }));
    const dg = resolve({ items: many });
    ok('more than three due → one digest, all five keys stamped', dg.notify.length === 1 && dg.notify[0].type === 'digest' && dg.notify[0].keys.length === 5 && /5 people/.test(dg.notify[0].title));
    const one = resolve().notify[0];
    ok('a push names a short name, not the full one', /Maria S\./.test(one.body) && !/Santos/.test(one.body + one.title));
    ok('the push carries no number, address or amount', !/\d{7,}|\$/.test(one.body + one.title));
    ok('away wording says the owner is away', /is away/.test(resolve({ away: { on: true, startMs: NOW - 5 * H, untilMs: NOW + D }, items: [item({ atMs: NOW - H })] }).notify[0].body));
    ok('shortName', L.shortName('Maria Santos') === 'Maria S.' && L.shortName('Allstate') === 'Allstate' && L.shortName('(859) 555-0147') === '(859) 555-0147' && L.shortName('') === 'Someone');
  }

  console.log('G. the backup packet and touches');
  {
    const p = L.backupPacket({ key: 'k', who: 'Maria Santos', phone10: '+1 (859) 555-0147', why: 'missed call', urgent: true, atMs: NOW - 45 * MIN,
      address: '12 Oak St', amountCents: 1200000, notes: 'secret', leadId: 'L1', touches: [] }, NOW);
    ok('a packet is exactly name, number, why, urgency, age, touches', Object.keys(p).sort().join() === 'ageMin,key,phone10,touches,urgent,who,why');
    ok('packet carries none of address / amount / notes / lead id', JSON.stringify(p).indexOf('Oak') < 0 && JSON.stringify(p).indexOf('secret') < 0 && JSON.stringify(p).indexOf('L1') < 0 && JSON.stringify(p).indexOf('1200000') < 0);
    ok('phone is normalized to 10 digits, name shortened, age in minutes', p.phone10 === '8595550147' && p.who === 'Maria S.' && p.ageMin === 45);
    const e = { key: 'k', touches: [] };
    ok('unknown action refused', !L.recordTouch(e, { action: 'delete' }, NOW).ok);
    ok('a note touch needs text', !L.recordTouch(e, { action: 'note', note: '  ' }, NOW).ok);
    const t = L.recordTouch(e, { action: 'called', note: 'line one\nline two\u0000 ' + 'x'.repeat(300), byUid: 'u-sam' }, NOW);
    ok('note is flattened, control-char free and capped at 140', t.ok && !/[\n\u0000]/.test(t.entry.touches[0].note) && t.entry.touches[0].note.length <= 140);
    ok('a touch never sets any field outside touches/assignee', Object.keys(t.entry).sort().join() === 'assignee,key,touches');
    let en = e; for (let i = 0; i < 15; i++) en = L.recordTouch(en, { action: 'took', byUid: 'u' }, NOW + i).entry;
    ok('touches are capped at 10', en.touches.length === 10);
  }

  console.log('H. hand-back');
  {
    const ledger = { items: {
      a: { key: 'a', who: 'Maria Santos', phone10: '8595550147', why: 'missed call', touches: [{ action: 'called', note: 'left voicemail', atMs: NOW - H }], assignee: 'backup' },
      b: { key: 'b', who: 'Bob Jones', phone10: '8595550148', why: 'urgent', touches: [{ action: 'done', note: 'sent a text', atMs: NOW - 2 * H }], assignee: 'backup' },
      c: { key: 'c', who: 'Cara Lee', phone10: '8595550149', why: 'follow-up due', touches: [], assignee: 'backup' },
      d: { key: 'd', who: 'Dan Fox', phone10: '8595550150', why: 'missed call', touches: [{ action: 'took', atMs: NOW - 3 * H }], assignee: 'backup' },
    } };
    const hb = L.handBack(ledger, new Set(['a', 'b', 'c']), NOW, 'Sam R');
    ok('only touched AND still-open items become rows', hb.rows.map((r) => r.key).sort().join() === 'a,b');
    ok('untouched open item is counted, not a row', hb.summary.untouchedOpen === 1);
    ok('touched but already cleared is counted as resolved', hb.summary.resolved === 1 && hb.summary.touched === 3);
    ok('every row is reassigned to the owner', hb.rows.every((r) => r.assignee === 'owner') && Object.values(hb.items).every((i) => i.assignee === 'owner'));
    const ra = hb.rows.find((r) => r.key === 'a');
    ok('the one-line note says who did what', ra.note === 'Sam: Called — left voicemail' && ra.note.length <= 140);
    ok('"done" is advisory: still a row, flagged', hb.rows.find((r) => r.key === 'b').backupSaysDone === true);
    ok('rows are newest touch first', hb.rows[0].key === 'a');
    ok('the ledger input was not mutated', ledger.items.a.assignee === 'backup');
  }

  console.log('I. status doc and the Today line');
  {
    const away = { on: true, startMs: NOW - H, untilMs: Date.parse('2026-10-16T22:00:00Z'), windowId: 'w1' };   // Fri 6 PM ET
    const base = { away, now: NOW, configuredBackup: 'member', configuredBackupName: 'Sam', backup: BK, playbookApproved: true, lastTickAtMs: NOW - MIN, ownerName: 'Joe' };
    const d = L.statusDoc(base);
    ok('status doc carries no phone / email / customer fields', !/phone|email|consent|draft|items/i.test(JSON.stringify(d)));
    ok('status says backup ok and wording approved', d.backupState === 'ok' && d.playbookApproved === true && d.backup.name === 'Sam' && d.backup.uid === 'u-sam');
    const line = L.statusLine(d, NOW);
    ok('line: "Away until Fri 6 PM — backup: Sam"', line.text === 'Away until Fri 6 PM — backup: Sam' && line.tone === 'ok', line && line.text);
    ok('no backup configured → warn "no backup set"', L.statusLine(L.statusDoc(Object.assign({}, base, { configuredBackup: null, backup: null })), NOW).tone === 'warn');
    const un = L.statusLine(L.statusDoc(Object.assign({}, base, { backup: { ok: false, reason: 'inactive' } })), NOW);
    ok('backup no longer active → red "Nobody is covering"', un.tone === 'bad' && /Nobody is covering/.test(un.text));
    const ur = L.statusLine(L.statusDoc(Object.assign({}, base, { unreachable: true })), NOW);
    ok('backup unreachable → red', ur.tone === 'bad' && /could not be reached/.test(ur.text));
    ok('tick 50 min behind → amber "routing is behind"', /routing is behind/.test(L.statusLine(Object.assign({}, d, { lastTickAtMs: NOW - 50 * MIN }), NOW).text));
    ok('off → no line', L.statusLine(L.statusDoc({ away: null, now: NOW }), NOW) === null);
    ok('an ended window asks Jo to tap I\'m back', /I'm back/.test(L.statusLine(Object.assign({}, d, { away: Object.assign({}, d.away, { endMs: NOW - MIN }) }), NOW).text));
    ok('open-ended says when it ends itself', /no end date/.test(L.statusLine(L.statusDoc(Object.assign({}, base, { away: { on: true, startMs: NOW - H, untilMs: null, windowId: 'w2' } })), NOW).text));
  }

  console.log('J. customer wording — draft is never used, approval is bound to the text');
  {
    const draft = L.playbookDraft({ companyName: 'No Big Deal Home Solutions', ownerName: 'Joe Deal', untilMs: Date.parse('2026-10-16T22:00:00Z'), nameBackup: false, backupName: 'Sam' });
    ok('draft names the date and does not name the backup unless asked', /Friday, October 16/.test(draft) && !/Sam/.test(draft));
    ok('draft names the backup only when the owner ticked it', /Sam is covering/.test(L.playbookDraft({ ownerName: 'Joe', nameBackup: true, backupName: 'Sam R' })));
    ok('draft makes no outcome / claim promise', !/guarantee|approved|insurance|claim|free|cover(ed)? by/i.test(draft));
    const away = { on: true, startMs: NOW - H, untilMs: NOW + D };
    ok('no approved text → null (the draft is never used)', L.thursdayAwayContext({ playbook: { draft } }, away, NOW) === null);
    const approved = { playbook: { draft, approved: draft, approvedHash: L.hashText(draft), approvedAtMs: NOW - H, approvedBy: 'own' } };
    const ctx = L.thursdayAwayContext(approved, away, NOW);
    ok('approved + active → the approved text', ctx && ctx.active === true && ctx.text === draft && /^\d{4}-\d{2}-\d{2}$/.test(ctx.untilYmd));
    ok('approved but window off → null', L.thursdayAwayContext(approved, { on: false }, NOW) === null);
    ok('approved but window expired → null', L.thursdayAwayContext(approved, { on: true, startMs: NOW - 2 * D, untilMs: NOW - MIN }, NOW) === null);
    const tampered = { playbook: Object.assign({}, approved.playbook, { approved: draft + ' Free roof!' }) };
    ok('approved text that no longer matches its hash → null', L.thursdayAwayContext(tampered, away, NOW) === null);
    const base = { channel: 'sms', approved: true, inbound: true, theyWroteFirst: true, optedOut: false, textingAllowed: true, withinWindow: true, windowId: 'w1', lastReplyWindowId: '' };
    ok('auto-reply passes only when every condition holds', L.autoReplyAllowed(base).ok === true);
    const no = (o, why) => { const r = L.autoReplyAllowed(Object.assign({}, base, o)); return r.ok === false && r.why === why; };
    ok('refused: voice channel', no({ channel: 'voice' }, 'sms_only'));
    ok('refused: wording not approved', no({ approved: false }, 'wording_not_approved'));
    ok('refused: outbound / not a reply', no({ inbound: false }, 'not_inbound'));
    ok('refused: first contact by us', no({ theyWroteFirst: false }, 'not_first_contact_from_them'));
    ok('refused: STOP / opted out', no({ optedOut: true }, 'opted_out'));
    ok('refused: texting off or unregistered', no({ textingAllowed: false }, 'texting_off'));
    ok('refused: outside the homeowner window', no({ withinWindow: false }, 'quiet_hours'));
    ok('refused: second reply in the same window', no({ lastReplyWindowId: 'w1' }, 'already_replied_this_window'));
  }

  // ── server: an in-memory Firestore ──
  function fakeDb(seed) {
    const store = new Map(Object.entries(seed || {}));
    const snap = (p) => ({ id: p.split('/').pop(), exists: store.has(p), data: () => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : undefined), ref: ref(p) });
    const merge = (a, b) => {
      const out = Object.assign({}, a);
      Object.keys(b).forEach((k) => { out[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a && typeof a[k] === 'object' && !Array.isArray(a[k])) ? merge(a[k], b[k]) : b[k]; });
      return out;
    };
    function ref(p) {
      return {
        path: p,
        get: async () => snap(p),
        set: async (v, o) => { store.set(p, o && o.merge ? merge(store.get(p) || {}, JSON.parse(JSON.stringify(v))) : JSON.parse(JSON.stringify(v))); },
        update: async (v) => { store.set(p, merge(store.get(p) || {}, v)); },
      };
    }
    let seq = 0;
    function col(name) {
      const filters = []; let lim = Infinity;
      const q = {
        where(f, op, v) { filters.push([f, op, v]); return q; },
        orderBy() { return q; },
        limit(n) { lim = n; return q; },
        async get() {
          const docs = [];
          store.forEach((v, p) => {
            if (!p.startsWith(name + '/') || p.slice(name.length + 1).includes('/')) return;
            const ok2 = filters.every(([f, op, val]) => (op === '==' ? v[f] === val : op === '>=' ? v[f] >= val : true));
            if (ok2) docs.push(snap(p));
          });
          return { docs: docs.slice(0, lim), forEach: (fn) => docs.slice(0, lim).forEach(fn), empty: !docs.length };
        },
        async add(v) { const id = 'auto' + (++seq); store.set(name + '/' + id, JSON.parse(JSON.stringify(v))); return { id }; },
      };
      return q;
    }
    return { store, doc: ref, collection: col };
  }
  const A = require(path.join(ROOT, 'functions/away-mode.js'));
  const I = A._internal;
  const member = (o) => Object.assign({ status: 'active', uid: 'u-sam', role: 'sales_rep', email: 'sam@x.com', displayName: 'Sam R' }, o || {});
  const asOwner = () => async (req) => ({ uid: 'own', companyId: 'own', isOwner: true });
  const deny = async () => { const e = new Error('Owner or admin access required'); e.code = 'permission-denied'; throw e; };
  const OWNER_REQ = { auth: { uid: 'own', token: {} }, data: {} };
  const items = (list) => async () => list;

  console.log('K. manageAway — owner actions');
  {
    const db = fakeDb({ 'companies/own/members/sam@x.com': member(), 'companies/own/members/vic@x.com': member({ uid: 'u-vic', role: 'viewer', email: 'vic@x.com' }) });
    const call = (data, extra) => I.handleManageAway({ auth: { uid: 'own', token: {} }, data }, Object.assign({ db, nowMs: NOW, requireAdmin: asOwner(), loadItems: items([]) }, extra || {}));
    await rejects('a non-admin caller is refused every owner action', I.handleManageAway({ auth: { uid: 'rep', token: { role: 'sales_rep', companyId: 'own' } }, data: { action: 'setAway', on: true } }, { db, nowMs: NOW, requireAdmin: deny }), /permission-denied|Owner or admin/);
    await rejects('unknown action', call({ action: 'nope' }), /invalid-argument|Unknown/);
    await rejects('save: a viewer cannot be the backup', call({ action: 'save', backup: { kind: 'member', memberEmail: 'vic@x.com' } }), /view-only|failed-precondition/);
    await rejects('save: a stranger email cannot be the backup', call({ action: 'save', backup: { kind: 'member', memberEmail: 'who@x.com' } }), /not on your team|failed-precondition/);
    await rejects('save: an external contact is not enabled yet', call({ action: 'save', backup: { kind: 'external', external: { name: 'Pat', phone: '8595550100', consent: true } } }), /registration|failed-precondition/);
    const saved = await call({ action: 'save', ackWindowMin: 90, backup: { kind: 'member', memberEmail: 'Sam@X.com' } });
    ok('save: stores a normalized backup and the status doc says ok', saved.ok && saved.status.backupState === 'ok' && saved.status.backup.name === 'Sam R' && saved.status.backup.uid === 'u-sam' && saved.config.ackWindowMin === 90);
    ok('save: status doc is active (the tick will look at it) and holds no contact data', db.store.get('away_mode/own').active === true && !/phone|email/i.test(JSON.stringify(db.store.get('away_mode/own'))));
    ok('save: private config lives in away_private, not the status doc', db.store.get('away_private/own').backup.memberEmail === 'sam@x.com' && db.store.get('away_mode/own').backup.memberEmail === undefined);
    await rejects('setAway: end in the past', call({ action: 'setAway', on: true, untilMs: NOW - H }), /future/);
    await rejects('setAway: more than 21 days', call({ action: 'setAway', on: true, untilMs: NOW + 30 * D }), /21 days/);
    const on = await call({ action: 'setAway', on: true, untilMs: NOW + 2 * D });
    ok('setAway on: window id, status line fields, ledger created', on.status.away.on === true && /^w/.test(on.status.away.windowId) && db.store.has('away_windows/own__' + on.status.away.windowId));
    const wid = on.status.away.windowId;
    const again = await call({ action: 'setAway', on: true, untilMs: NOW + 3 * D });
    ok('setAway again changes the end, keeps the same window', again.status.away.windowId === wid && again.status.away.untilMs === NOW + 3 * D);
    // wording
    const dr = await call({ action: 'playbookDraft' });
    ok('playbookDraft returns text + its hash', dr.draft.length > 20 && dr.hash === L.hashText(dr.draft));
    await rejects('approve with no draft saved', call({ action: 'playbookApprove', hash: dr.hash }), /Write the wording first/);
    const sv = await call({ action: 'playbookSave', text: dr.draft });
    ok('playbookSave stores the draft, not approved', sv.config.playbook.approved === false && sv.config.playbook.draft === dr.draft && sv.status.playbookApproved === false);
    await rejects('approve with a stale hash is refused', call({ action: 'playbookApprove', hash: 'deadbeef' }), /changed|failed-precondition/);
    const ap = await call({ action: 'playbookApprove', hash: sv.config.playbook.hash });
    ok('approve with the matching hash approves', ap.config.playbook.approved === true && ap.status.playbookApproved === true);
    ok('Thursday context now returns the approved text while away', L.thursdayAwayContext(db.store.get('away_private/own'), db.store.get('away_mode/own').away, NOW).text === dr.draft);
    const ed = await call({ action: 'playbookSave', text: dr.draft + ' We close at five.' });
    ok('editing the wording clears the approval', ed.config.playbook.approved === false && ed.status.playbookApproved === false);
    ok('...and Thursday goes quiet about it', L.thursdayAwayContext(db.store.get('away_private/own'), db.store.get('away_mode/own').away, NOW) === null);
    // hand-back through the callable
    db.store.set('away_windows/own__' + wid, Object.assign({}, db.store.get('away_windows/own__' + wid), { items: {
      'num:1': { key: 'num:1', who: 'Maria Santos', phone10: '8595550147', why: 'missed call', open: true, notifiedCount: 1, touches: [{ action: 'called', note: 'no answer', atMs: NOW - H }], assignee: 'backup' },
      'num:2': { key: 'num:2', who: 'Bob Jones', phone10: '8595550148', why: 'missed call', open: true, notifiedCount: 1, touches: [], assignee: 'backup' },
    } }));
    const back = await call({ action: 'imBack' }, { loadItems: items([{ key: 'num:1' }, { key: 'num:2' }]) });
    ok('imBack: window off, hand-back pending with one row', back.status.away.on === false && back.status.pendingReview && back.status.pendingReview.openCount === 1 && back.handBack.rows === 1);
    ok('imBack: ledger closed with the backup\'s one-line note', db.store.get('away_windows/own__' + wid).status === 'handed_back' && db.store.get('away_windows/own__' + wid).handBack.rows[0].note === 'Sam: Called — no answer');
    const again2 = await call({ action: 'imBack' });
    ok('imBack twice is harmless', again2.ok === true && again2.status.pendingReview.windowId === wid);
    const g = await call({ action: 'get' });
    ok('get returns the hand-back rows for the owner', g.handBack && g.handBack.rows.length === 1 && g.members.map((m) => m.email).join() === 'sam@x.com');
    ok('get never returns a viewer as a pickable backup', g.members.every((m) => m.email !== 'vic@x.com'));
    const rv = await call({ action: 'reviewed' });
    ok('reviewed clears the pending row', rv.status.pendingReview === null && db.store.get('away_windows/own__' + wid).reviewedAtMs === NOW);
  }

  console.log('L. manageAway — the backup\'s own actions');
  {
    const db = fakeDb({
      'companies/own/members/sam@x.com': member(),
      'away_private/own': { companyId: 'own', backup: { memberEmail: 'sam@x.com' } },
      'away_mode/own': { companyId: 'own', active: true, away: { on: true, startMs: NOW - H, untilMs: NOW + D, windowId: 'w9' }, backupState: 'ok' },
      'away_windows/own__w9': { companyId: 'own', items: {
        'num:1': { key: 'num:1', who: 'Maria Santos', phone10: '8595550147', why: 'missed call', urgent: true, atMs: NOW - H, open: true, notifiedCount: 1, touches: [], address: '12 Oak St', notes: 'secret' },
        'num:2': { key: 'num:2', who: 'Old Closed', phone10: '8595550148', why: 'x', atMs: NOW - H, open: false, notifiedCount: 1, touches: [] },
        'num:3': { key: 'num:3', who: 'Never Told', phone10: '8595550149', why: 'x', atMs: NOW - H, open: true, notifiedCount: 0, touches: [] },
      } },
      'away_windows/other__w1': { companyId: 'other', items: { 'num:9': { key: 'num:9', who: 'Other Tenant', open: true, notifiedCount: 1, touches: [] } } },
    });
    const as = (uid, token, data) => I.handleManageAway({ auth: { uid, token }, data }, { db, nowMs: NOW, requireAdmin: deny });
    const sam = { role: 'sales_rep', companyId: 'own' };
    const list = await as('u-sam', sam, { action: 'backupList' });
    ok('the backup sees only routed, still-open people', list.items.length === 1 && list.items[0].key === 'num:1');
    ok('...with no address, notes or lead id', JSON.stringify(list).indexOf('Oak') < 0 && JSON.stringify(list).indexOf('secret') < 0);
    await rejects('another rep is not the backup', as('u-rep', { role: 'sales_rep', companyId: 'own' }, { action: 'backupList' }), /not the backup|permission-denied/);
    await rejects('a viewer is refused', as('u-sam', { role: 'viewer', companyId: 'own' }, { action: 'backupList' }), /permission-denied/);
    await rejects('another company\'s member cannot list this company\'s packets', as('u-sam', { role: 'sales_rep', companyId: 'other' }, { action: 'backupList' }), /permission-denied|not the backup/);
    await rejects('a deactivated backup is refused on the next call', I.handleManageAway({ auth: { uid: 'u-sam', token: sam }, data: { action: 'backupList' } }, { db: (() => { const d2 = fakeDb(Object.fromEntries(db.store)); d2.store.set('companies/own/members/sam@x.com', member({ status: 'deactivated' })); return d2; })(), nowMs: NOW, requireAdmin: deny }), /not the backup|permission-denied/);
    await rejects('a touch on an item that was never routed to them is refused', as('u-sam', sam, { action: 'backupAct', key: 'num:3', touch: 'called' }), /not-found|not on your list/);
    await rejects('a touch on an item outside the ledger is refused', as('u-sam', sam, { action: 'backupAct', key: 'num:404', touch: 'called' }), /not-found|not on your list/);
    await rejects('a made-up touch is refused', as('u-sam', sam, { action: 'backupAct', key: 'num:1', touch: 'delete_lead' }), /invalid-argument|Unknown/);
    const t = await as('u-sam', sam, { action: 'backupAct', key: 'num:1', touch: 'called', note: 'left a voicemail' });
    const stored = db.store.get('away_windows/own__w9').items['num:1'];
    ok('a touch lands in the ledger only', t.ok && stored.touches.length === 1 && stored.touches[0].byUid === 'u-sam' && stored.touches[0].note === 'left a voicemail');
    ok('a touch writes nothing else in the system (no phone_calls / leads / tasks docs)', ![...db.store.keys()].some((k) => /^(phone_calls|leads|phone_text_days)\//.test(k)));
    ok('a touch did not disturb the other entries or the ledger shell', db.store.get('away_windows/own__w9').items['num:2'].open === false && db.store.get('away_windows/own__w9').companyId === 'own');
  }

  console.log('M. awayModeTick');
  {
    const open = (extra) => [Object.assign({ key: 'num:8595550147', kind: 'person', who: 'Maria Santos', why: 'urgent', urgent: true, atMs: NOW - H, phone10: '8595550147' }, extra || {})];
    const mk = (statusExtra, seedExtra) => fakeDb(Object.assign({
      'companies/own/members/sam@x.com': member(),
      'away_private/own': { companyId: 'own', ackWindowMin: 120, backup: { memberEmail: 'sam@x.com' } },
      'away_mode/own': Object.assign({ companyId: 'own', active: true, backupState: 'ok', backup: { kind: 'member', name: 'Sam R', uid: 'u-sam' }, away: { on: true, startMs: NOW - 3 * H, untilMs: NOW + D, windowId: 'w1' }, lastTickAtMs: 0 }, statusExtra || {}),
    }, seedExtra || {}));
    const sent = [];
    const deliver = (n) => async (uid, title, body, data) => { sent.push({ uid, title, body, data }); return { sent: n, failed: 0 }; };
    let r = await I.runAwayTick({ db: mk(), nowMs: NOW, live: true, deliver: deliver(1), loadItems: items(open()) });
    ok('tick: the urgent item is pushed to the backup once', r.notified === 1 && sent.length === 1 && sent[0].uid === 'u-sam' && sent[0].data.type === 'away_backup');
    const db1 = mk();
    await I.runAwayTick({ db: db1, nowMs: NOW, live: true, deliver: deliver(1), loadItems: items(open()) });
    const n1 = sent.length;
    r = await I.runAwayTick({ db: db1, nowMs: NOW + 15 * MIN, live: true, deliver: deliver(1), loadItems: items(open()) });
    ok('tick: the next tick does not re-send (idempotent)', sent.length === n1 && r.notified === 0);
    const led = db1.store.get('away_windows/own__w1');
    ok('tick: ledger records the routing', led.items['num:8595550147'].notifiedCount === 1 && led.items['num:8595550147'].open === true && led.status === 'active');
    // dry run
    sent.length = 0;
    r = await I.runAwayTick({ db: mk(), nowMs: NOW, live: false, deliver: deliver(1), loadItems: items(open()) });
    ok('dry run (gate off): nothing is sent or written', sent.length === 0 && r.notified === 0);
    // delivery truth
    const dbf = mk();
    sent.length = 0;
    const tick = (at) => I.runAwayTick({ db: dbf, nowMs: at, live: true, deliver: deliver(0), loadItems: items(open()) });
    await tick(NOW);
    ok('push reached 0 devices: NOT counted as told', dbf.store.get('away_windows/own__w1').items['num:8595550147'].notifiedCount === 0 && dbf.store.get('away_windows/own__w1').items['num:8595550147'].failedAttempts === 1);
    ok('...and one in-app bell was written for the backup', [...dbf.store.keys()].filter((k) => k.startsWith('notifications/')).length === 1);
    await tick(NOW + 15 * MIN);
    await tick(NOW + 30 * MIN);
    const st3 = dbf.store.get('away_mode/own');
    ok('three failed attempts → backupState unreachable (Jo sees the red line)', st3.backupState === 'unreachable', st3.backupState);
    ok('...and the bell was not re-written on every retry', [...dbf.store.keys()].filter((k) => k.startsWith('notifications/')).length === 1);
    // deactivated backup
    sent.length = 0;
    const dbd = mk({}, { 'companies/own/members/sam@x.com': member({ status: 'deactivated' }) });
    r = await I.runAwayTick({ db: dbd, nowMs: NOW, live: true, deliver: deliver(1), loadItems: items(open()) });
    ok('deactivated backup: nothing sent, status goes unavailable', sent.length === 0 && dbd.store.get('away_mode/own').backupState === 'unavailable' && r.unavailable === 1);
    // external backup is not delivered to yet
    sent.length = 0;
    const dbe = mk({ backup: { kind: 'external', name: 'Pat', uid: '' } }, { 'away_private/own': { companyId: 'own', backup: { external: { name: 'Pat', phone: '8595550100', consentAtMs: NOW - D } } } });
    await I.runAwayTick({ db: dbe, nowMs: NOW, live: true, deliver: deliver(1), loadItems: items(open()) });
    ok('external backup: not delivered to in this build', sent.length === 0 && I.ALLOW_EXTERNAL === false);
    // expiry → hand-back, even with the gate off
    const dbx = mk({ away: { on: true, startMs: NOW - 2 * D, untilMs: NOW - MIN, windowId: 'w1' } }, {
      'away_windows/own__w1': { companyId: 'own', windowId: 'w1', status: 'active', items: { 'num:8595550147': { key: 'num:8595550147', who: 'Maria Santos', phone10: '8595550147', why: 'urgent', open: true, notifiedCount: 1, touches: [{ action: 'called', note: 'no answer', atMs: NOW - 2 * H }] } } },
    });
    r = await I.runAwayTick({ db: dbx, nowMs: NOW, live: false, deliver: deliver(1), loadItems: items(open()) });
    const sx = dbx.store.get('away_mode/own');
    ok('expired window is handed back automatically (not behind the notify gate)', r.handedBack === 1 && sx.away.on === false && sx.pendingReview && sx.pendingReview.openCount === 1);
    ok('...the row is reassigned to the owner with the backup\'s note', dbx.store.get('away_windows/own__w1').handBack.rows[0].note === 'Sam: Called — no answer' && dbx.store.get('away_windows/own__w1').items['num:8595550147'].assignee === 'owner');
    r = await I.runAwayTick({ db: dbx, nowMs: NOW + 15 * MIN, live: true, deliver: deliver(1), loadItems: items(open()) });
    ok('...and a second tick leaves the hand-back alone', dbx.store.get('away_mode/own').pendingReview.windowId === 'w1' && r.handedBack === 0);
    // one tenant's fault does not stop the rest
    const dbm = mk();
    dbm.store.set('away_mode/bad', { companyId: 'bad', active: true, away: { on: true, startMs: NOW, untilMs: NOW + D, windowId: 'w1' } });
    r = await I.runAwayTick({ db: dbm, nowMs: NOW, live: true, deliver: deliver(1), loadItems: async (db, cid) => { if (cid === 'bad') throw new Error('boom'); return open(); }, log: { warn() {}, info() {} } });
    ok('one tenant failing is counted and does not block the others', r.errors === 1 && r.notified === 1);
  }

  console.log('N. client mirror (docs/pro/js/away-mode.js)');
  {
    const src = read('docs/pro/js/away-mode.js');
    const els = {};
    const sandbox = {
      console, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, Date, Math, JSON, Promise,
      MutationObserver: function () { this.observe = () => {}; },
      document: { readyState: 'complete', addEventListener() {}, getElementById: (id) => els[id] || null, querySelector: () => null, body: {}, hidden: false },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    const C = sandbox.NBDAway;
    ok('client module loads and exposes the mirror', !!C && typeof C.statusLine === 'function');
    const until = Date.parse('2026-10-16T22:00:00Z');
    const docs = [
      { away: { on: true, startMs: NOW - H, untilMs: until, windowId: 'w' }, backup: { name: 'Sam' }, backupState: 'ok', lastTickAtMs: NOW - MIN },
      { away: { on: true, startMs: NOW - H, untilMs: until, windowId: 'w' }, backup: { name: 'Sam' }, backupState: 'unavailable', lastTickAtMs: NOW },
      { away: { on: true, startMs: NOW - H, untilMs: until, windowId: 'w' }, backup: { name: 'Sam' }, backupState: 'unreachable', lastTickAtMs: NOW },
      { away: { on: true, startMs: NOW - H, untilMs: until, windowId: 'w' }, backup: null, backupState: 'none', lastTickAtMs: NOW },
      { away: { on: true, startMs: NOW - H, untilMs: null, endMs: until, windowId: 'w' }, backup: { name: 'Sam' }, backupState: 'ok', lastTickAtMs: NOW },
      { away: { on: true, startMs: NOW - H, untilMs: until, windowId: 'w' }, backup: { name: 'Sam' }, backupState: 'ok', lastTickAtMs: NOW - 2 * H },
      { away: { on: true, startMs: NOW - 2 * D, untilMs: NOW - MIN, endMs: NOW - MIN, windowId: 'w' }, backup: { name: 'Sam' }, backupState: 'ok', lastTickAtMs: NOW },
      { away: { on: false } },
    ];
    ok('client status line == server status line on every shape', docs.every((d) => JSON.stringify(C.statusLine(d, NOW)) === JSON.stringify(L.statusLine(d, NOW))),
      docs.map((d) => JSON.stringify(C.statusLine(d, NOW)) + ' | ' + JSON.stringify(L.statusLine(d, NOW))).join('\n'));
    // paint with a stub element
    const el = { hidden: true, innerHTML: '', setAttribute() {}, getAttribute() { return null; } };
    els.awayStatus = el;
    sandbox._userClaims = {}; sandbox._user = { uid: 'own' };
    C._paint({ status: Object.assign({ pendingReview: { windowId: 'w' } }, docs[0], { away: { on: false } }), handBack: { rows: [{ key: 'k', who: '<img src=x onerror=alert(1)>', phone10: '8595550147', note: 'Sam: Called', backupSaysDone: true }], touched: 1, resolved: 0, backupName: 'Sam' } });
    ok('hand-back card renders rows and a Reviewed button', /While you were away/.test(el.innerHTML) && /data-away-act="reviewed"/.test(el.innerHTML) && /says done/.test(el.innerHTML));
    ok('customer names are escaped in the card', el.innerHTML.indexOf('<img') < 0 && /&lt;img/.test(el.innerHTML));
    C._paint({ status: docs[1] });
    ok('owner sees the red line with an I\'m back button', /Nobody is covering/.test(el.innerHTML) && /data-away-act="back"/.test(el.innerHTML) && /away-bad/.test(el.innerHTML));
    sandbox._userClaims = { role: 'sales_rep', companyId: 'own' }; sandbox._user = { uid: 'u-sam' };
    C._paint({ status: Object.assign({}, docs[0], { backup: { name: 'Sam', uid: 'u-sam' }, ownerName: 'Joe' }), packets: [{ key: 'num:1', who: 'Maria S.', phone10: '8595550147', why: 'missed call', urgent: true, ageMin: 45, touches: [] }] });
    ok('the backup sees a cover list with call + touch buttons and no I\'m back', /Covering: 1 person needs a call-back/.test(el.innerHTML) && /tel:\+18595550147/.test(el.innerHTML) && /data-away-touch="called"/.test(el.innerHTML) && !/data-away-act="back"/.test(el.innerHTML));
    C._paint({ status: docs[0] });
    ok('a teammate who is not the backup sees the line only', /backup: Sam/.test(el.innerHTML) && !/data-away-act/.test(el.innerHTML));
    C._paint({ status: { away: { on: false } } });
    ok('away off and nothing pending → empty and hidden', el.innerHTML === '' && el.hidden === true);
  }

  console.log('O. source contracts');
  {
    const server = read('functions/away-mode.js'), logic = read('functions/away-mode-logic.js');
    const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
    const sc = code(server);
    ok('owner actions go through requireTeamAdmin', /requireTeamAdmin/.test(sc) && /await \(\(deps && deps\.requireAdmin\) \|\| requireTeamAdmin\)\(request\)/.test(sc));
    ok('the callable takes no companyId argument (tenant comes from the token)', !/data\.companyId|data\.cid|request\.data\.company/.test(sc));
    ok('the callable enforces App Check', /enforceAppCheck: true/.test(sc));
    ok('away-mode.js never writes a lead, call, task or customer doc', !/collection\('(leads|phone_calls|phone_text_days|tasks|customers)'\)\s*\.(doc|add)|doc\('(leads|phone_calls|phone_text_days)\//.test(sc));
    ok('away-mode.js sends nothing to customers (no sms/email helpers required)', !/sms-functions|twilio|resend|sendEmail|sendSms/i.test(sc));
    ok('away-mode.js does not edit callWatch (reads its logic only)', /require\('\.\/call-watch-logic'\)/.test(sc) && !/call-watch'\)|require\('\.\/call-watch\.js'\)/.test(sc));
    ok('external delivery stays off until A2P', /const ALLOW_EXTERNAL = false;/.test(sc));
    ok('the notify tick is behind AWAY_MODE_ENABLED and registered as a gate', /AWAY_MODE_ENABLED/.test(sc) && /AWAY_MODE_ENABLED/.test(read('functions/cron-gates.js')));
    ok('the tick is in the heartbeat plan', /awayModeTick:\s+\{ slug:/.test(read('functions/integrations/heartbeat-plan.js')));
    ok('both exports are registered (index.js + function-map.json)', /exports\.manageAway/.test(read('functions/index.js')) && /"manageAway": "\.\/away-mode"/.test(read('functions/function-map.json')) && /"awayModeTick": "\.\/away-mode"/.test(read('functions/function-map.json')));
    ok('logic module is pure: no firestore/network requires', !/require\('(firebase|node-fetch|https?)/.test(code(logic)) && !/\bfetch\(/.test(code(logic)));
    const rules = read('firestore.rules');
    const blk = (n) => (rules.match(new RegExp('match /' + n + '/\\{[^}]+\\} \\{[\\s\\S]*?\\n    \\}')) || [''])[0];
    ok('rules: away_mode / away_private / away_windows exist', !!blk('away_mode') && !!blk('away_private') && !!blk('away_windows'));
    ok('rules: none of the three allows a client write', ['away_mode', 'away_private', 'away_windows'].every((n) => /allow write: if false;|allow read, write: if false;/.test(blk(n))));
    ok('rules: away_private has no client read at all', /allow read, write: if false;/.test(blk('away_private')));
    for (const f of ['docs/pro/js/away-mode.js', 'docs/pro/js/away-mode-settings.js']) {
      const s = read(f);
      ok(f + ': no inline handlers, no eval', !/\son[a-z]+\s*=\s*["']/.test(s.replace(/data-away-[a-z-]+="[^"]*"/g, '')) && !/\beval\(|new Function\(/.test(s));
    }
    const dash = read('docs/pro/dashboard.html');
    ok('dashboard: mount + deferred script + stylesheet present', /id="awayStatus"/.test(dash) && /<script defer src="js\/away-mode\.js\?v=1"><\/script>/.test(dash) && /css\/away-mode\.css/.test(dash) && /id="awayModeMount"/.test(dash));
    ok('settings script loads with the Settings bundle', /js\/away-mode-settings\.js\?v=1/.test(read('docs/pro/js/script-loader.js')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
