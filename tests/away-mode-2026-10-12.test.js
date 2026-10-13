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
    const draft = L.playbookDraft({ companyName: 'No Big Deal Home Solutions', ownerName: 'Joe Deal', untilMs: Date.parse('2026-10-16T22:00:00Z'), backupName: 'Sam' });
    ok('draft names the date and does not name the backup unless asked', /Friday, October 16/.test(draft) && !/Sam/.test(draft));
    ok('draft NEVER names the backup, even when asked (callers hear the owner is away)', !/Sam/.test(L.playbookDraft({ ownerName: 'Joe', nameBackup: true, backupName: 'Sam R' })) && cfg({ nameBackupToCallers: true }).nameBackupToCallers === false && L.validateSave({ nameBackupToCallers: true }).config.nameBackupToCallers === false);
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
  // Stub the Admin SDK BEFORE away-mode.js (and handlers/_shared.js) load, so the
  // REAL requireTeamAdmin runs in section R: its company read and its
  // disabled-account check go to these stubs.
  const STUB = { db: null, disabled: new Set() };
  {
    const Module = require('module');
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      const mod = origLoad.apply(this, arguments);
      if (request === 'firebase-admin/firestore') {
        return Object.assign({}, mod, { getFirestore: () => STUB.db });
      }
      if (request === 'firebase-admin/auth') {
        return Object.assign({}, mod, { getAuth: () => ({ getUser: async (uid) => ({ uid, disabled: STUB.disabled.has(uid), displayName: '' }) }) });
      }
      return mod;
    };
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

  console.log('M2. the tick never undoes what landed while it ran');
  {
    const mk2 = () => fakeDb({
      'companies/own/members/sam@x.com': member(),
      'away_private/own': { companyId: 'own', backup: { memberEmail: 'sam@x.com' } },
      'away_mode/own': { companyId: 'own', active: true, backupState: 'ok', backup: { kind: 'member', name: 'Sam R', uid: 'u-sam' }, away: { on: true, startMs: NOW - 3 * H, untilMs: NOW + D, windowId: 'w1' }, lastTickAtMs: 0 },
      'away_windows/own__w1': { companyId: 'own', windowId: 'w1', status: 'active', startMs: NOW - 3 * H, items: { 'num:8595550147': { key: 'num:8595550147', who: 'Maria Santos', phone10: '8595550147', why: 'urgent', urgent: true, atMs: NOW - H, open: true, notifiedCount: 1, lastNotifiedMs: NOW - 30 * MIN, touches: [], assignee: 'backup' } } },
    });
    const one = [{ key: 'num:8595550147', kind: 'person', who: 'Maria Santos', why: 'urgent', urgent: true, atMs: NOW - H, phone10: '8595550147' }];
    // Jo taps "I'm back" while the tick is loading this tenant's items.
    const dbA = mk2();
    await I.runAwayTick({ db: dbA, nowMs: NOW, live: true, deliver: async () => ({ sent: 1 }), loadItems: async () => {
      await dbA.doc('away_windows/own__w1').set({ status: 'handed_back', handBack: { rows: [] } }, { merge: true });
      await dbA.doc('away_mode/own').set({ away: { on: false } }, { merge: true });
      return one;
    } });
    ok('"I\'m back" during a tick: the window is not resurrected', dbA.store.get('away_windows/own__w1').status === 'handed_back');
    ok('"I\'m back" during a tick: away stays off', dbA.store.get('away_mode/own').away.on === false);
    // The backup records a touch while the tick is loading.
    const dbB = mk2();
    dbB.store.get('away_windows/own__w1').items['num:8595550147'].notifiedCount = 0;   // due now, so deliver() runs mid-tick
    await I.runAwayTick({ db: dbB, nowMs: NOW, live: true, loadItems: async () => one, deliver: async () => {
      const cur = dbB.store.get('away_windows/own__w1');
      cur.items['num:8595550147'].touches = [{ action: 'called', note: 'left a voicemail', atMs: NOW - MIN, byUid: 'u-sam' }];
      cur.items['num:8595550147'].assignee = 'backup';
      return { sent: 1 };
    } });
    ok('a touch recorded during a tick is kept', dbB.store.get('away_windows/own__w1').items['num:8595550147'].touches.length === 1);
    // reviewed never takes a client window id
    const dbC = fakeDb({ 'away_mode/own': { companyId: 'own', active: true, away: { on: false }, pendingReview: null } });
    await I.handleManageAway({ auth: { uid: 'own', token: {} }, data: { action: 'reviewed', windowId: 'x/items/y' } }, { db: dbC, nowMs: NOW, requireAdmin: asOwner(), loadItems: items([]) });
    ok('reviewed ignores a client-supplied window id', ![...dbC.store.keys()].some((k) => k.startsWith('away_windows/')));
  }

  console.log('Q. owner-only: naming the backup and approving wording (finding F4, Jo 2026-10-12)');
  {
    const { teamAdminDecision } = require(path.join(ROOT, 'functions/handlers/_shared.js'));
    const ca = { uid: 'adm', claims: { role: 'company_admin', companyId: 'own' }, companyId: 'own', ownerId: 'own', companyExists: true };
    ok('real decision: a company_admin passes the normal gate', teamAdminDecision(ca).allow === true);
    ok('real decision: a company_admin FAILS the ownerOnly gate', teamAdminDecision(Object.assign({}, ca, { ownerOnly: true })).allow === false);
    ok('real decision: the owner passes the ownerOnly gate', teamAdminDecision({ uid: 'own', claims: {}, companyId: 'own', ownerId: 'own', companyExists: true, ownerOnly: true }).allow === true);
    ok('the owner-only action list is exactly get / save / playbook*', L.OWNER_ONLY_ACTIONS.slice().sort().join() === 'get,playbookApprove,playbookDraft,playbookSave,save,setAway');
    // Drive the callable through a gate that mimics requireTeamAdmin honoring ownerOnly.
    const dbO = fakeDb({ 'companies/own/members/sam@x.com': member() });
    const gate = async (req, target, opts) => {
      if (req.auth.uid === 'adm' && opts && opts.ownerOnly) { const e = new Error('Owner or admin access required'); e.code = 'permission-denied'; throw e; }
      return { uid: req.auth.uid, companyId: 'own' };
    };
    const run = (uid, data) => I.handleManageAway({ auth: { uid, token: {} }, data }, { db: dbO, nowMs: NOW, requireAdmin: gate, loadItems: items([]) });
    for (const data of [{ action: 'save', backup: { kind: 'member', memberEmail: 'sam@x.com' } }, { action: 'playbookDraft' }, { action: 'playbookSave', text: 'Hi' }, { action: 'playbookApprove', hash: 'x' }, { action: 'get' }]) {
      await rejects('company_admin cannot ' + data.action, run('adm', data), /permission-denied|Owner or admin/);
    }
    const sv = await run('own', { action: 'save', backup: { kind: 'member', memberEmail: 'sam@x.com' } });
    ok('the owner can name the backup', sv.ok === true);
    await rejects('company_admin cannot switch Away ON (owner-only)', run('adm', { action: 'setAway', on: true, untilMs: NOW + D }), /permission-denied|Owner or admin/);
    const on = await run('own', { action: 'setAway', on: true, untilMs: NOW + D });
    ok('the owner switches Away on', on.ok === true && on.status.away.on === true);
    ok('a company_admin can still mark "I\'m back", review, and use setAway OFF', (await run('adm', { action: 'setAway', on: false })).ok === true && (await run('adm', { action: 'imBack' })).ok === true && (await run('adm', { action: 'reviewed' })).ok === true);
    const src = read('functions/away-mode.js').replace(/\/\*[\s\S]*?\*\//g, '');
    ok('source: the gate passes { ownerOnly: true } for the owner-only list', /OWNER_ONLY_ACTIONS\.includes\(action\)/.test(src) && /\{ ownerOnly: true \}/.test(src));
  }

  console.log('R. real requireTeamAdmin, and an approval never goes live for a trip its approver did not start');
  {
    const db = fakeDb({
      'companies/own': { ownerId: 'own', name: 'NBD' },
      'companies/own/members/sam@x.com': member(),
    });
    STUB.db = db;
    const as = (uid, token, data) => I.handleManageAway({ auth: { uid, token }, data }, { db, nowMs: NOW, loadItems: items([]) });   // NO requireAdmin seam
    const adm = { role: 'company_admin', companyId: 'own' };
    for (const data of [{ action: 'get' }, { action: 'save', backup: { kind: 'member', memberEmail: 'sam@x.com' } }, { action: 'playbookDraft' }, { action: 'playbookSave', text: 'Hi' }, { action: 'playbookApprove', hash: 'x' }, { action: 'setAway', on: true, untilMs: NOW + D }]) {
      await rejects('REAL gate: company_admin refused on ' + data.action + (data.on ? ' (on)' : ''), as('adm', adm, data), /permission-denied|Owner or admin/);
    }
    ok('REAL gate: the owner passes get', (await as('own', {}, { action: 'get' })).ok === true);
    ok('REAL gate: a company_admin may still say "I\'m back" and review', (await as('adm', adm, { action: 'imBack' })).ok === true && (await as('adm', adm, { action: 'reviewed' })).ok === true);
    await rejects('REAL gate: a sales_rep is refused everything owner-ish', as('rep', { role: 'sales_rep', companyId: 'own' }, { action: 'imBack' }), /permission-denied|Owner or admin/);
    const xo = await as('x', { role: 'company_admin', companyId: 'other' }, { action: 'imBack' });
    ok('REAL gate: another company\'s company_admin only ever acts on THEIR company (sees nothing of ours)', xo.ok === true && xo.status === null);
    STUB.disabled.add('own');
    await rejects('REAL gate: a disabled owner account is refused', as('own', {}, { action: 'get' }), /permission-denied|Owner or admin/);
    STUB.disabled.delete('own');

    // The approval made while Away is OFF (bound to no end time) must not go live when
    // someone else starts the trip. The gate seam below ignores ownerOnly on purpose
    // (defence in depth: this is the handler-level rule, not the gate).
    const db2 = fakeDb({ 'companies/own/members/sam@x.com': member() });
    const open = async (req) => ({ uid: req.auth.uid, companyId: 'own' });
    const go = (uid, data) => I.handleManageAway({ auth: { uid, token: {} }, data }, { db: db2, nowMs: NOW, requireAdmin: open, loadItems: items([]) });
    const dr = await go('own', { action: 'playbookDraft' });
    await go('own', { action: 'playbookSave', text: dr.draft });
    await go('own', { action: 'playbookApprove', hash: dr.hash });
    ok('owner approved with Away off (bound to 0)', db2.store.get('away_private/own').playbook.approvedHash === dr.hash && db2.store.get('away_private/own').playbook.approvedForUntilMs === 0);
    await go('adm', { action: 'setAway', on: true, untilMs: NOW + D });
    ok('someone else starting the trip clears the approval', db2.store.get('away_private/own').playbook.approvedHash === '');
    ok('...and Thursday gets nothing', L.thursdayAwayContext(db2.store.get('away_private/own'), db2.store.get('away_mode/own').away, NOW) === null);
    ok('...while the draft is kept', db2.store.get('away_private/own').playbook.draft === dr.draft);
    const db3 = fakeDb({ 'companies/own/members/sam@x.com': member() });
    const go3 = (uid, data) => I.handleManageAway({ auth: { uid, token: {} }, data }, { db: db3, nowMs: NOW, requireAdmin: open, loadItems: items([]) });
    const dr3 = await go3('own', { action: 'playbookDraft' });
    await go3('own', { action: 'playbookSave', text: dr3.draft });
    await go3('own', { action: 'playbookApprove', hash: dr3.hash });
    await go3('own', { action: 'setAway', on: true, untilMs: NOW + D });
    ok('the approver starting their own trip keeps the approval (approve once)', L.thursdayAwayContext(db3.store.get('away_private/own'), db3.store.get('away_mode/own').away, NOW) !== null);

    // lost-update: actions write only the fields they own
    const db4 = fakeDb({ 'companies/own/members/sam@x.com': member(), 'away_private/own': { companyId: 'own', ackWindowMin: 90, backup: { memberEmail: 'sam@x.com' }, playbook: { draft: 'D', approved: 'D', approvedHash: L.hashText('D'), approvedAtMs: 1, approvedBy: 'own', approvedForUntilMs: 0 } } });
    const go4 = (uid, data) => I.handleManageAway({ auth: { uid, token: {} }, data }, { db: db4, nowMs: NOW, requireAdmin: open, loadItems: items([]) });
    await go4('own', { action: 'save', ackWindowMin: 45, backup: { kind: 'member', memberEmail: 'sam@x.com' } });
    ok('save leaves the approved wording alone', db4.store.get('away_private/own').playbook.approvedHash === L.hashText('D') && db4.store.get('away_private/own').ackWindowMin === 45);
    await go4('own', { action: 'playbookSave', text: 'D' });
    ok('re-saving identical wording keeps its approval and does not touch the backup/ack settings', db4.store.get('away_private/own').playbook.approvedHash === L.hashText('D') && db4.store.get('away_private/own').backup.memberEmail === 'sam@x.com' && db4.store.get('away_private/own').ackWindowMin === 45);
    await go4('own', { action: 'setAway', on: true, untilMs: NOW + D });
    await go4('own', { action: 'imBack' });
    ok('hand-back clears only the approval fields (backup and timings survive)', db4.store.get('away_private/own').playbook.approvedHash === '' && db4.store.get('away_private/own').ackWindowMin === 45 && db4.store.get('away_private/own').backup.memberEmail === 'sam@x.com' && db4.store.get('away_private/own').playbook.draft === 'D');
    // True lost-update checks: a concurrent write lands right AFTER the action reads away_private.
    const racy = (dbx, p, mutate, nth) => {
      const orig = dbx.doc;
      let fired = false, seen = 0;
      dbx.doc = (q) => {
        const r = orig(q);
        if (q !== p) return r;
        const g = r.get;
        r.get = async () => { const s = await g(); const frozen = s.data(); if (!fired && ++seen >= (nth || 1)) { fired = true; mutate(); } return Object.assign({}, s, { data: () => frozen }); };   // the snapshot is what was read, not what is stored later
        return r;
      };
    };
    const base5 = () => ({ 'companies/own/members/sam@x.com': member(), 'companies/own/members/kim@x.com': member({ uid: 'u-kim', email: 'kim@x.com' }),
      'away_private/own': { companyId: 'own', ackWindowMin: 90, backup: { memberEmail: 'sam@x.com' }, playbook: { draft: 'D', approved: 'D', approvedHash: L.hashText('D'), approvedAtMs: 1, approvedBy: 'own', approvedForUntilMs: 0 } } });
    const goR = (dbx, data) => I.handleManageAway({ auth: { uid: 'own', token: {} }, data }, { db: dbx, nowMs: NOW, requireAdmin: open, loadItems: items([]) });
    // save races an approval
    const d5 = fakeDb(base5());
    racy(d5, 'away_private/own', () => { d5.store.get('away_private/own').playbook.approvedHash = 'NEW-APPROVAL'; });
    await goR(d5, { action: 'save', ackWindowMin: 60, backup: { kind: 'member', memberEmail: 'sam@x.com' } });
    ok('lost-update: a save does not revert an approval that landed during it', d5.store.get('away_private/own').playbook.approvedHash === 'NEW-APPROVAL' && d5.store.get('away_private/own').ackWindowMin === 60);
    // hand-back races a save
    const d6 = fakeDb(Object.assign(base5(), { 'away_mode/own': { companyId: 'own', active: true, away: { on: true, startMs: NOW - H, untilMs: NOW + D, windowId: 'w1' }, backup: { kind: 'member', name: 'Sam', uid: 'u-sam' }, backupState: 'ok' }, 'away_windows/own__w1': { companyId: 'own', status: 'active', items: {} } }));
    racy(d6, 'away_private/own', () => { d6.store.get('away_private/own').ackWindowMin = 200; d6.store.get('away_private/own').backup.memberEmail = 'kim@x.com'; }, 2);   // fires after doHandBack's own read (the 2nd)
    await goR(d6, { action: 'imBack' });
    ok('lost-update: a hand-back does not revert a backup/timing save that landed during it', d6.store.get('away_private/own').ackWindowMin === 200 && d6.store.get('away_private/own').backup.memberEmail === 'kim@x.com' && d6.store.get('away_private/own').playbook.approvedHash === '');
    // wording approve races a backup change
    const d7 = fakeDb(base5());
    d7.store.get('away_private/own').playbook = { draft: 'D', approved: '', approvedHash: '', approvedAtMs: 0, approvedBy: '', approvedForUntilMs: 0 };
    racy(d7, 'away_private/own', () => { d7.store.get('away_private/own').backup.memberEmail = 'kim@x.com'; });
    await goR(d7, { action: 'playbookApprove', hash: L.hashText('D') });
    ok('lost-update: approving wording does not revert a backup change that landed during it', d7.store.get('away_private/own').backup.memberEmail === 'kim@x.com' && d7.store.get('away_private/own').playbook.approvedHash === L.hashText('D'));
    ok('source: manageAway is rate limited', /callableRateLimit\(request, 'manageAway'/.test(read('functions/away-mode.js')));
  }

  console.log('P. review findings (2026-10-12 security review)');
  {
    const seedTenant = (extra, ledgerItems, away) => fakeDb(Object.assign({
      'companies/own/members/sam@x.com': member(),
      'away_private/own': { companyId: 'own', backup: { memberEmail: 'sam@x.com' } },
      'away_mode/own': { companyId: 'own', active: true, backupState: 'ok', backup: { kind: 'member', name: 'Sam R', uid: 'u-sam' }, away: away === undefined ? { on: true, startMs: NOW - 3 * H, untilMs: NOW + D, windowId: 'w1' } : away, lastTickAtMs: 0 },
      'away_windows/own__w1': { companyId: 'own', windowId: 'w1', status: 'active', startMs: NOW - 3 * H, items: ledgerItems || {} },
    }, extra || {}));
    const quiet = async () => [];
    // F1: a pruned row really leaves the stored doc
    const old = {}; for (let i = 0; i < 5; i++) old['num:859555010' + i] = { key: 'num:859555010' + i, who: 'Old ' + i, open: true, notifiedCount: 1, lastNotifiedMs: NOW - 9 * D, routedAtMs: NOW - 9 * D, touches: [] };
    old['num:keep'] = { key: 'num:keep', who: 'Kept', open: true, notifiedCount: 1, lastNotifiedMs: NOW - 9 * D, routedAtMs: NOW - 9 * D, touches: [{ action: 'called', note: 'x', atMs: NOW - 8 * D }] };
    const dP = seedTenant(null, old);
    await I.runAwayTick({ db: dP, nowMs: NOW, live: true, deliver: async () => ({ sent: 1 }), loadItems: quiet });
    const ks = Object.keys(dP.store.get('away_windows/own__w1').items);
    ok('F1: closed, untouched rows older than 7 days are really removed from the stored ledger', ks.join() === 'num:keep', ks.join());
    // F1: hard cap
    const big = {}; for (let i = 0; i < 340; i++) big['num:' + String(1000000000 + i)] = { key: 'x' + i, who: 'P', open: false, notifiedCount: 1, lastNotifiedMs: NOW - D, routedAtMs: NOW - D + i, touches: [] };
    const dCap = seedTenant(null, big);
    await I.runAwayTick({ db: dCap, nowMs: NOW, live: true, deliver: async () => ({ sent: 1 }), loadItems: quiet });
    ok('F1: the ledger is capped at 300 entries', Object.keys(dCap.store.get('away_windows/own__w1').items).length === 300);
    // F2: longest-unserved first, and a budget that stops early
    const order = [];
    const dMany = fakeDb({});
    for (let i = 0; i < 6; i++) dMany.store.set('away_mode/t' + i, { companyId: 't' + i, active: true, away: { on: false }, lastTickAtMs: 1000 - i });
    await I.runAwayTick({ db: dMany, nowMs: NOW, live: false, deliver: async () => ({ sent: 1 }), loadItems: async (db, cid) => { order.push(cid); return []; } });
    ok('F2: tenants are served longest-since-served first', order.join() === 't5,t4,t3,t2,t1,t0', order.join());
    const rb = await I.runAwayTick({ db: dMany, nowMs: NOW, live: false, deliver: async () => ({ sent: 1 }), loadItems: quiet, budgetMs: -1 });
    ok('F2: an exhausted budget defers the rest instead of running into the timeout', rb.deferred === 6 && rb.tenants === 0);
    // F3: approval belongs to one trip
    const ap = (o) => ({ playbook: Object.assign({ draft: 'Hello', approved: 'Hello', approvedHash: L.hashText('Hello'), approvedAtMs: NOW - H, approvedBy: 'own', approvedForUntilMs: 0 }, o || {}) });
    const win = { on: true, startMs: NOW - H, untilMs: NOW + D };
    ok('F3: approved with no end time bound → used', L.thursdayAwayContext(ap(), win, NOW) !== null);
    ok('F3: approved against another end time → null', L.thursdayAwayContext(ap({ approvedForUntilMs: NOW + 5 * D }), win, NOW) === null);
    ok('F3: approved against this end time → used', L.thursdayAwayContext(ap({ approvedForUntilMs: NOW + D }), win, NOW) !== null);
    const dApp = seedTenant({ 'away_private/own': { companyId: 'own', backup: { memberEmail: 'sam@x.com' }, playbook: { draft: 'Hi there', approved: 'Hi there', approvedHash: L.hashText('Hi there'), approvedAtMs: NOW - H, approvedBy: 'own', approvedForUntilMs: NOW + D } } },
      { 'num:1': { key: 'num:1', who: 'A B', open: true, notifiedCount: 1, touches: [{ action: 'called', atMs: NOW }] } });
    await I.runAwayTick({ db: dApp, nowMs: NOW, live: false, deliver: async () => ({ sent: 1 }), loadItems: async () => [], budgetMs: 60000 });
    const dEnd = seedTenant({ 'away_private/own': dApp.store.get('away_private/own') }, { 'num:1': { key: 'num:1', who: 'A B', open: true, notifiedCount: 1, touches: [{ action: 'called', atMs: NOW }] } }, { on: true, startMs: NOW - 2 * D, untilMs: NOW - MIN, windowId: 'w1' });
    await I.runAwayTick({ db: dEnd, nowMs: NOW, live: false, deliver: async () => ({ sent: 1 }), loadItems: async () => [{ key: 'num:1' }] });
    ok('F3: hand-back clears the approval but keeps the draft', dEnd.store.get('away_private/own').playbook.approvedHash === '' && dEnd.store.get('away_private/own').playbook.draft === 'Hi there' && dEnd.store.get('away_mode/own').playbookApproved === false);
    const dChg = seedTenant({ 'away_private/own': dApp.store.get('away_private/own'), 'companies/own/members/sam@x.com': member() });
    await I.handleManageAway({ auth: { uid: 'own', token: {} }, data: { action: 'setAway', on: true, untilMs: NOW + 3 * D } }, { db: dChg, nowMs: NOW, requireAdmin: asOwner(), loadItems: items([]) });
    ok('F3: changing the end time clears wording approved against the old one', dChg.store.get('away_private/own').playbook.approvedHash === '');
    // F5: a caller-controlled string never reaches a lock screen as a link or spoof
    ok('F5: a URL-looking caller name is replaced', L.shortName('evil.example/pay-now-1800') === 'A caller' && L.shortName('pay@evil.co') === 'A caller' && L.shortName('http://x.co') === 'A caller');
    ok('F5: bidi override + zero-width characters are removed', L.cleanLine('Maria\u202e Santos\u200b', 60) === 'Maria Santos');
    const spoof = L.resolveBackupNotifications({ config: cfg(), items: [item({ who: 'evil.example/pay-now' })], now: NOW, notified: {}, backup: BK, away: null, ownerName: 'Joe' });
    ok('F5: the push shows "A caller", not the link', spoof.notify[0].title === 'A caller needs a call-back' && !/evil/.test(spoof.notify[0].body));
    ok('F5: ordinary names are unchanged', L.shortName('Maria Santos') === 'Maria S.' && L.shortName('St. Louis Roofing') === 'St. R.');
    // F7: an expired window is handed back even if the item query fails
    const dQ = seedTenant(null, { 'num:1': { key: 'num:1', who: 'Maria Santos', phone10: '8595550147', why: 'x', open: true, notifiedCount: 1, touches: [{ action: 'called', note: 'vm', atMs: NOW - H }] } }, { on: true, startMs: NOW - 2 * D, untilMs: NOW - MIN, windowId: 'w1' });
    const rq = await I.runAwayTick({ db: dQ, nowMs: NOW, live: false, deliver: async () => ({ sent: 1 }), loadItems: async () => { throw new Error('index missing'); }, log: { warn() {}, info() {} } });
    ok('F7: item query failing does not stop the hand-back (touched items come back as open)', rq.handedBack === 1 && rq.errors === 0 && dQ.store.get('away_mode/own').away.on === false && dQ.store.get('away_windows/own__w1').handBack.rows.length === 1);
    // F8: a member email is a document id, not a path
    ok('F8: slashes and backslashes are refused in a backup email', !L.validateSave({ backup: { kind: 'member', memberEmail: 'a/b@x.com' } }).ok && !L.validateSave({ backup: { kind: 'member', memberEmail: 'a@x.com/y.co' } }).ok && L.validateSave({ backup: { kind: 'member', memberEmail: 'sam.r+crew@x.com' } }).ok);
    // __proto__ / dotted keys cannot be touched (positive control: a real key works)
    const dK = fakeDb({
      'companies/own/members/sam@x.com': member(),
      'away_private/own': { companyId: 'own', backup: { memberEmail: 'sam@x.com' } },
      'away_mode/own': { companyId: 'own', active: true, away: { on: true, startMs: NOW - H, untilMs: NOW + D, windowId: 'w9' } },
      'away_windows/own__w9': { companyId: 'own', items: { 'num:1': { key: 'num:1', who: 'M S', open: true, notifiedCount: 1, touches: [] } } },
    });
    const asSam = (key) => I.handleManageAway({ auth: { uid: 'u-sam', token: { role: 'sales_rep', companyId: 'own' } }, data: { action: 'backupAct', key, touch: 'called' } }, { db: dK, nowMs: NOW, requireAdmin: deny });
    for (const k of ['__proto__', 'constructor', 'toString', 'a.b', 'num:1.touches']) await rejects('backupAct key ' + JSON.stringify(k) + ' is refused', asSam(k), /not-found|not on your list/);
    ok('positive control: the real key is accepted', (await asSam('num:1')).ok === true);
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
    // Settings panel is owner-only on the client too (mirrors the server gate)
    {
      const mount = { innerHTML: 'sentinel' };
      const sb2 = {
        console, setTimeout: () => 0, setInterval: () => 0, clearInterval() {}, Date, Math, JSON, Promise, Object,
        document: { readyState: 'complete', addEventListener() {}, getElementById: (id) => (id === 'awayModeMount' ? mount : null), getElementById2() {} },
        _user: { uid: 'adm' }, _userClaims: { role: 'company_admin', companyId: 'own' }, switchSettingsTab() {},
      };
      sb2.window = sb2; vm.createContext(sb2); vm.runInContext(read('docs/pro/js/away-mode-settings.js'), sb2);
      sb2.NBDAwaySettings.render();
      ok('settings panel: a company_admin sees nothing (get would be refused)', mount.innerHTML === '');
      sb2._user = { uid: 'own' }; sb2._userClaims = { role: 'company_admin', companyId: 'own' };
      sb2.NBDAwaySettings._set({ status: {}, config: { backup: {}, playbook: {} }, members: [], defaults: {} });
      ok('settings panel: the company-keyed owner sees it', /Away mode/.test(mount.innerHTML));
      mount.innerHTML = 'sentinel'; sb2._user = { uid: 'solo' }; sb2._userClaims = {};
      sb2.NBDAwaySettings._set({ status: {}, config: { backup: {}, playbook: {} }, members: [], defaults: {} });
      ok('settings panel: a solo owner (no claims) sees it', /Away mode/.test(mount.innerHTML));
      mount.innerHTML = 'sentinel'; sb2._user = { uid: 'vw' }; sb2._userClaims = { role: 'viewer', companyId: 'own' };
      sb2.NBDAwaySettings._set({ status: {}, config: {}, members: [] });
      ok('settings panel: a viewer / manager / rep sees nothing', mount.innerHTML === '');
    }
    C._paint({ status: { away: { on: false } } });
    ok('away off and nothing pending → empty and hidden', el.innerHTML === '' && el.hidden === true);
  }

  console.log('O. source contracts');
  {
    const server = read('functions/away-mode.js'), logic = read('functions/away-mode-logic.js');
    const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
    const sc = code(server);
    ok('owner actions go through requireTeamAdmin', /requireTeamAdmin/.test(sc) && /await \(\(deps && deps\.requireAdmin\) \|\| requireTeamAdmin\)\(request, null,/.test(sc));
    ok('the callable takes no companyId argument (tenant comes from the token)', !/data\.companyId|data\.cid|request\.data\.company/.test(sc));
    ok('the callable enforces App Check', /enforceAppCheck: true/.test(sc));
    const leadDocLines = sc.split('\n').filter((l) => l.includes("doc('leads/'"));
    ok('away-mode.js writes exactly one lead-side doc: the activity/away- hand-back note (and only when timeline is on)', leadDocLines.length === 1 && leadDocLines[0].includes("/activity/away-'") && sc.includes('if (timeline) tl = await fileHandBackTimeline('));
    ok('away-mode.js never writes a lead doc itself, nor a call, text-day, task or customer doc', ["collection('leads').doc", "collection('leads').add", "doc('phone_calls/", "doc('phone_text_days/", "collection('tasks')", "collection('customers')"].every((x) => !sc.includes(x)));
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
    ok('dashboard: mount + stylesheet present, NO new boot script tag (boot-budget ratchet)', /id="awayStatus"/.test(dash) && /css\/away-mode\.css/.test(dash) && /id="awayModeMount"/.test(dash) && !/js\/away-mode/.test(dash.replace(/<!--[\s\S]*?-->/g, '')));
    ok('away-mode.js is a lazy bundle kicked from Home (today-home.js)', /away:\s*\[\s*'js\/away-mode\.js\?v=1'\s*\]/.test(read('docs/pro/js/script-loader.js')) && /loadBundle\('away'\)/.test(read('docs/pro/js/today-home.js')));
    ok('script-loader + today-home cache-busters were bumped for the edit', /script-loader\.js\?v=19[7-9]|script-loader\.js\?v=[2-9]\d\d/.test(dash) && /today-home\.js\?v=([4-9]|\d\d)/.test(dash));
    ok('settings script loads with the Settings bundle', /js\/away-mode-settings\.js\?v=1/.test(read('docs/pro/js/script-loader.js')));
  }

  console.log('T. hand-back note on the lead timeline (2026-10-13)');
  {
    const CT = require(path.join(ROOT, 'docs/pro/js/call-timeline.js'));
    const P = require(path.join(ROOT, 'functions/promise-cleanup-logic.js'));
    const TOUCHED = { key: 'num:8595550147', who: 'Maria Santos', phone10: '8595550147', why: 'urgent', urgent: true, atMs: NOW - 5 * H, open: true, notifiedCount: 1, assignee: 'backup', touches: [{ action: 'called', note: 'no answer', atMs: NOW - 2 * H }] };
    const seed = () => ({
      'companies/own/members/sam@x.com': member(),
      'away_private/own': { companyId: 'own', backup: { memberEmail: 'sam@x.com' } },
      'away_mode/own': { companyId: 'own', active: true, backupState: 'ok', backup: { kind: 'member', name: 'Sam R', uid: 'u-sam' }, away: { on: true, startMs: NOW - 2 * D, untilMs: NOW - MIN, windowId: 'w1' }, lastTickAtMs: 0 },
      'away_windows/own__w1': { companyId: 'own', windowId: 'w1', status: 'active', startMs: NOW - 2 * D, items: {
        'num:8595550147': TOUCHED,
        'num:8595550148': Object.assign({}, TOUCHED, { key: 'num:8595550148', who: 'Shared Line', phone10: '8595550148' }),
        'num:8595550149': Object.assign({}, TOUCHED, { key: 'num:8595550149', who: 'No Lead', phone10: '8595550149' }),
        'num:8595550150': Object.assign({}, TOUCHED, { key: 'num:8595550150', who: 'Gone Lead', phone10: '8595550150' }),
        'thursday:abc': Object.assign({}, TOUCHED, { key: 'thursday:abc', who: 'Caller', phone10: '' }),
      } },
      'leads/L1': { userId: 'own', companyId: 'own', phoneDigits: '8595550147' },
      'leads/L2': { userId: 'own', companyId: 'own', phoneDigits: '8595550148' },
      'leads/L3': { userId: 'own', companyId: 'own', phoneDigits: '8595550148' },
      'leads/L4': { userId: 'own', companyId: 'own', phoneDigits: '8595550150', deleted: true },
      'leads/LX': { userId: 'other', companyId: 'other', phoneDigits: '8595550147' },
    });
    const allOpen = ['num:8595550147', 'num:8595550148', 'num:8595550149', 'num:8595550150', 'thursday:abc'].map((k) => ({ key: k }));
    const actKeys = (db) => [...db.store.keys()].filter((k) => /^leads\/[^/]+\/activity\//.test(k));
    const deliver = async () => ({ sent: 0 });

    // dark: the tick's expiry hand-back with the gate off writes no timeline note
    const dDark = fakeDb(seed());
    let r = await I.runAwayTick({ db: dDark, nowMs: NOW, live: false, deliver, loadItems: async () => allOpen });
    ok('gate off: the window is still handed back, but nothing is written to any lead', r.handedBack === 1 && dDark.store.get('away_windows/own__w1').status === 'handed_back' && actKeys(dDark).length === 0);

    // live: one note, on the one unambiguous lead of THIS company
    const dLive = fakeDb(seed());
    r = await I.runAwayTick({ db: dLive, nowMs: NOW, live: true, deliver, loadItems: async () => allOpen });
    const keys = actKeys(dLive);
    ok('gate on: exactly one note, on the one lead that matches the number', r.handedBack === 1 && keys.length === 1 && keys[0] === 'leads/L1/activity/away-w1-8595550147', keys.join());
    const act = dLive.store.get(keys[0]) || {};
    ok('the note carries the backup\'s one-liner, type, source and tenant stamp', act.summary === 'Sam: Called — no answer' && act.type === 'away_handback' && act.source === 'away-mode' && act.userId === 'own' && act.companyId === 'own' && act.awayWindowId === 'w1');
    ok('the note carries BOTH order fields (createdAt for the query, startedAtMs for the timeline)', act.createdAt !== undefined && act.createdAt !== null && act.startedAtMs === NOW);
    ok('a number on two leads, a lead-less number, a deleted lead and a phone-less row get no note', !keys.some((k) => /L2|L3|L4|LX/.test(k)) && keys.length === 1);
    ok('another company\'s lead with the same number is not touched', !dLive.store.has('leads/LX/activity/away-w1-8595550147'));
    ok('the ledger / status hand-back is unchanged by the timeline write', dLive.store.get('away_windows/own__w1').handBack.rows.length === 5 && dLive.store.get('away_mode/own').pendingReview.openCount === 5);

    // idempotent
    const again = await I.fileHandBackTimeline(dLive, 'own', 'w1', dLive.store.get('away_windows/own__w1').handBack.rows, NOW + 99 * MIN, 'Sam');
    ok('filing the same rows again writes nothing (deterministic id, create-if-absent)', again.written === 0 && actKeys(dLive).length === 1 && dLive.store.get(keys[0]).startedAtMs === NOW);

    // a failing lead lookup never blocks the hand-back
    const dBoom = fakeDb(seed());
    const realCol = dBoom.collection;
    dBoom.collection = (n) => { if (n === 'leads') throw new Error('boom'); return realCol(n); };
    r = await I.runAwayTick({ db: dBoom, nowMs: NOW, live: true, deliver, loadItems: async () => allOpen, log: { warn() {}, info() {} } });
    ok('a failing lead lookup is logged and the hand-back still completes', r.handedBack === 1 && r.errors === 0 && dBoom.store.get('away_mode/own').away.on === false);

    // I'm back (callable) is behind the same switch
    const prev = process.env.AWAY_MODE_ENABLED;
    const runBack = async () => {
      const sd = seed();
      sd['away_mode/own'] = Object.assign({}, sd['away_mode/own'], { away: { on: true, startMs: NOW - H, untilMs: NOW + D, windowId: 'w1' } });
      const db = fakeDb(sd);
      await I.handleManageAway({ auth: { uid: 'own', token: {} }, data: { action: 'imBack' } }, { db, nowMs: NOW, requireAdmin: async () => ({ uid: 'own', companyId: 'own', isOwner: true }), loadItems: async () => allOpen });
      return db;
    };
    try {
      delete process.env.AWAY_MODE_ENABLED;
      ok('I\'m back with the switch off writes no lead note', actKeys(await runBack()).length === 0);
      process.env.AWAY_MODE_ENABLED = 'true';
      ok('I\'m back with the switch on writes the note', actKeys(await runBack()).join() === 'leads/L1/activity/away-w1-8595550147');
    } finally { if (prev === undefined) delete process.env.AWAY_MODE_ENABLED; else process.env.AWAY_MODE_ENABLED = prev; }

    // hostile text: control / bidi characters are stripped server side, the client returns plain strings
    const evil = await I.fileHandBackTimeline(dLive, 'own', 'w2', [{ phone10: '8595550147', note: 'Sam: Note — <img src=x onerror=alert(1)>‮​' }], NOW, 'Sam');
    const evilDoc = dLive.store.get('leads/L1/activity/away-w2-8595550147') || {};
    ok('control and bidi characters are stripped from the stored note', evil.written === 1 && !/[‮​]/.test(evilDoc.summary || ''));
    const row = CT.fromActivity('away-w2-8595550147', evilDoc);
    ok('timeline row: plain strings, never markup the renderer would trust', !!row && typeof row.desc === 'string' && row.desc.includes('<img') && row.kind === 'away' && row.type === 'note');
    ok('timeline row sorts by when it happened, falls back to filed time', row.time.getTime() === NOW && CT.fromActivity('away-w1-x', { type: 'away_handback', summary: 's', createdAt: { toDate: () => new Date(NOW - H) } }).time.getTime() === NOW - H);
    ok('only an away- id with the away_handback type is shown; look-alikes are not', CT.fromActivity('abc123', { type: 'away_handback', summary: 'x' }) === null && CT.fromActivity('away-w1-x', { type: 'note', summary: 'x' }) === null);

    // not evidence that Jo kept a promise
    const call = { id: 'c1', startedAtMs: NOW - 3 * D };
    const evd = P.evidenceAfter(call, [
      { id: 'away-w1-8595550147', type: 'away_handback', label: 'While you were away', summary: 'Sam: Says done — sent the estimate', startedAtMs: NOW },
      { id: 'n1', type: 'note', summary: 'Sent the estimate by email', startedAtMs: NOW - D },
    ], 'cube-c1');
    ok('promise cleanup ignores the hand-back line as evidence (a backup\'s "done" is advisory)', evd.length === 1 && evd[0].activityId === 'n1');

    // customer page wiring
    const cb = read('docs/pro/js/customer-bootstrap.module.js');
    ok('PDF report gather leaves the internal away line out', /row && row\.kind !== 'away'/.test(cb));
    ok('timeline marks only call/text rows with the call style', /callEntry: row\.kind === 'call' \|\| row\.kind === 'text'/.test(cb));
    const sc2 = read('functions/away-mode.js');
    ok('timeline write rides the notify switch: tick passes live, imBack passes tickEnabled()', /timeline: live \}/.test(sc2) && /: tickEnabled\(\),/.test(sc2));
  }

  console.log('U. the hand-back row stays true after Jo clears it (2026-10-13)');
  {
    const CT = require(path.join(ROOT, 'docs/pro/js/call-timeline.js'));
    const S = require(path.join(ROOT, 'functions/away-handback-settle.js'));
    const ID = 'leads/L1/activity/away-w1-8595550147';
    const seedU = () => ({
      'leads/L1': { userId: 'own', companyId: 'own', phoneDigits: '8595550147' },
      [ID]: { type: 'away_handback', source: 'away-mode', label: 'While you were away \u00b7 Sam', summary: 'Sam: Says done \u2014 sent the estimate', backupSaysDone: true, awayWindowId: 'w1', startedAtMs: NOW - D },
      'leads/L2': { userId: 'own', companyId: 'own', phoneDigits: '8595550148' },
      'leads/L2/activity/away-w1-8595550148': { type: 'away_handback', summary: 'Sam: Called', backupSaysDone: false, startedAtMs: NOW - D },
      'leads/LX': { userId: 'other', companyId: 'other', phoneDigits: '8595550147' },
      'leads/LX/activity/away-w1-8595550147': { type: 'away_handback', summary: 'Other tenant', backupSaysDone: true, startedAtMs: NOW - D },
    });
    const call = { phoneDigits: '8595550147', userId: 'own', companyId: 'own' };
    const openList = (phones) => async () => phones.map((p) => ({ key: 'num:' + p, phone10: p }));
    const desc = (db) => CT.fromActivity('away-w1-8595550147', db.store.get(ID)).desc;
    const quiet = { warn() {}, info() {} };

    // before: the row is the backup's claim
    const d0 = fakeDb(seedU());
    ok('open item: the row still reads as the backup\'s claim', desc(d0) === 'Sam: Says done \u2014 sent the estimate (they say it is done)');

    // still open after another action: nothing changes
    let r = await S.settleHandBackTimeline(d0, call, { nowMs: NOW, byUid: 'own', byName: 'Joe Deal', loadItems: openList(['8595550147']), log: quiet });
    ok('the person is still on the list: no stamp, claim wording kept', r.settled === 0 && d0.store.get(ID).clearedAtMs === undefined && /they say it is done/.test(desc(d0)));

    // Jo clears them
    r = await S.settleHandBackTimeline(d0, call, { nowMs: NOW + H, byUid: 'own', byName: 'Joe Deal', loadItems: openList([]), log: quiet });
    const st = d0.store.get(ID);
    ok('cleared: the activity doc is stamped with when and by whom', r.settled === 1 && st.clearedAtMs === NOW + H && st.clearedByUid === 'own' && st.clearedByName === 'Joe');
    ok('cleared: the row no longer says "they say it is done" and reads plainly', desc(d0) === 'Sam: Says done \u2014 sent the estimate \u2014 handed back; cleared by Joe on Oct 13' && !/they say/.test(desc(d0)), desc(d0));
    ok('the stamp does not move the row or change the backup\'s own line', CT.fromActivity('away-w1-8595550147', st).time.getTime() === NOW - D && st.summary === 'Sam: Says done \u2014 sent the estimate' && st.backupSaysDone === true);

    // idempotent: a second clearing action keeps the first time
    r = await S.settleHandBackTimeline(d0, call, { nowMs: NOW + 5 * H, byUid: 'own', byName: 'Joe Deal', loadItems: openList([]), log: quiet });
    ok('settling again writes nothing (idempotent)', r.settled === 0 && r.reopened === 0 && d0.store.get(ID).clearedAtMs === NOW + H);

    // Jo undoes Handled: the person is open again, so is the claim
    r = await S.settleHandBackTimeline(d0, call, { nowMs: NOW + 6 * H, byUid: 'own', byName: 'Joe Deal', loadItems: openList(['8595550147']), log: quiet });
    ok('undo: the person is open again, so the claim wording comes back', r.reopened === 1 && /\(they say it is done\)$/.test(desc(d0)) && !d0.store.get(ID).clearedAtMs);

    // a task tick has no signed-in person: nothing is invented
    const dNoName = fakeDb(seedU());
    await S.settleHandBackTimeline(dNoName, call, { nowMs: NOW + H, byUid: '', byName: '', loadItems: openList([]), log: quiet });
    ok('no known name: "cleared on Oct 13", never a made-up person', desc(dNoName) === 'Sam: Says done \u2014 sent the estimate \u2014 handed back; cleared on Oct 13', desc(dNoName));

    // scope: only the cleared person\'s row, only this company\'s lead
    ok('another number\'s row and another tenant\'s lead are untouched', d0.store.get('leads/L2/activity/away-w1-8595550148').clearedAtMs === undefined && dNoName.store.get('leads/LX/activity/away-w1-8595550147').clearedAtMs === undefined);
    const dAmb = fakeDb(Object.assign(seedU(), { 'leads/L9': { userId: 'own', companyId: 'own', phoneDigits: '8595550147' } }));
    r = await S.settleHandBackTimeline(dAmb, call, { nowMs: NOW, loadItems: openList([]), log: quiet });
    ok('a number on two leads is skipped, as when the note was filed', r.settled === 0 && dAmb.store.get(ID).clearedAtMs === undefined);

    // hostile name / failure paths
    const dEvil = fakeDb(seedU());
    await S.settleHandBackTimeline(dEvil, call, { nowMs: NOW, byUid: 'own', byName: '<img src=x onerror=alert(1)> Evil', loadItems: openList([]), log: quiet });
    const evilRow = CT.fromActivity('away-w1-8595550147', dEvil.store.get(ID));
    ok('the name is a plain string; the renderer escapes it like the rest of the row', typeof evilRow.desc === 'string' && /cleared by </.test(evilRow.desc) && read('docs/pro/js/customer-bootstrap.module.js').includes('${esc(item.desc)}'));
    const dBoom = fakeDb(seedU());
    let threw = false; let rb;
    try { rb = await S.settleHandBackTimeline(dBoom, call, { nowMs: NOW, loadItems: async () => { throw new Error('boom'); }, log: quiet }); } catch (_) { threw = true; }
    ok('a failing open-items read never throws into the clearing action', !threw && rb.settled === 0 && dBoom.store.get(ID).clearedAtMs === undefined);
    const dPhone = fakeDb(seedU());
    ok('a call with no number settles nothing', (await S.settleHandBackTimeline(dPhone, { userId: 'own' }, { nowMs: NOW, loadItems: openList([]), log: quiet })).settled === 0);

    // wiring
    const cc = read('functions/call-center.js');
    ok('callCenterAction settles after handled/unhandled, task done/undo and a promise on a customer', (cc.match(/await settleAway\(db, call, auth, nowMs\);/g) || []).length === 3);
    ok('the task-tick mirror settles too (no signed-in person)', /await settleAway\(db, call, null, Date\.now\(\)\);/.test(cc));
    const settleSrc = read('functions/away-handback-settle.js').replace(/\/\*[\s\S]*?\*\//g, '');
    ok('settle writes only the activity/away- doc: no call, task, lead or send', !/phone_calls|phone_text_days|tasks|sendSms|sendEmail|twilio|resend/i.test(settleSrc) && (settleSrc.match(/\.set\(/g) || []).length === 2);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
