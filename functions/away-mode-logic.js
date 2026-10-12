'use strict';
/**
 * functions/away-mode-logic.js — the rules behind the backup person and Away
 * mode (never-forget lane, 2026-10-12). Pure: no Firestore, no clock, no
 * network — away-mode.js does the reads, the sends and the writes. Design and
 * the reasoning for every number: documentation/projects/AWAY-MODE-BACKUP-2026-10-12.md.
 *
 * Shape of the problem: Jo is one person on a roof. Items that need him
 * (callWatch's "people", keyed by callerKey) sit open. If he has not
 * acknowledged one within a window, a verified backup is told; while Away is on
 * the windows tighten; when Away ends the backup's touches come back to Jo as a
 * "While you were away" list. Nothing here sends anything to a customer.
 *
 * What this file never does: mark a call handled, write a lead, or let an
 * unapproved wording reach a caller.
 */

const crypto = require('crypto');

const MIN = 60000;
const DAY = 86400000;

const DEFAULTS = Object.freeze({
  ackWindowMin: 120,      // normal: "if I haven't acknowledged by 2 h"
  awayWindowMin: 30,      // away: everything non-urgent after 30 min
  urgentWindowMin: 30,    // normal: urgent items use min(ackWindow, this)
  repeatMin: 240,         // re-tell the backup no sooner than this
  maxRepeats: 2,          // told 1 + 2 repeats, then exhausted
  maxFailedAttempts: 3,   // delivered 0 times → backup 'unreachable'
  digestAfter: 3,         // more than this many due → one digest
  itemMaxAgeDays: 7,      // older items stay in Jo's own digest
});
const LIMITS = Object.freeze({
  ackWindowMin: [15, 480],
  awayWindowMin: [10, 240],
  maxAwayDays: 21,        // an open-ended Away ends itself
  noteMax: 140,
  touchesMax: 10,
  playbookMax: 800,
  unavailableMax: 7,
});
const TOUCH_ACTIONS = Object.freeze(['took', 'called', 'cant_reach', 'note', 'done']);
const TOUCH_LABEL = Object.freeze({
  took: "I'm on it", called: 'Called', cant_reach: "Couldn't reach", note: 'Note', done: 'Says done',
});
const TZ = 'America/New_York';
const QUIET_START_HOUR = 21;   // 21:00 ET ...
const QUIET_END_HOUR = 8;      // ... to 08:00 ET (matches SEND_WINDOW in sms-outbox-guard.js)

// ── small helpers ────────────────────────────────────────────────────────
function toMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
function intIn(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && v !== null && v !== '' && v !== undefined ? clamp(n, lo, hi) : dflt;
}
/** Control chars and newlines out, collapsed, capped. Never trust a note. */
function cleanLine(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const digits10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const validPhone10 = (s) => digits10(s).length === 10 && String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '').length === 10;
const validEmail = (s) => /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,}$/.test(String(s || '').trim()) && String(s).length <= 254;

function etParts(ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' });
  const o = {};
  f.formatToParts(new Date(ms)).forEach((p) => { o[p.type] = p.value; });
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday);
  return { hour: Number(o.hour) % 24, minute: Number(o.minute), dow };
}
/** 21:00–08:00 Eastern: the hours nothing non-urgent is pushed to a backup. */
function inQuietHours(ms) {
  const h = etParts(ms).hour;
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}
const etYmd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
function fmtUntil(ms) {
  const d = new Date(ms);
  const day = d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
  const time = d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).replace(':00', '');
  return day + ' ' + time;
}

// ── config ───────────────────────────────────────────────────────────────
function cleanSchedule(list) {
  const out = [];
  (Array.isArray(list) ? list : []).slice(0, LIMITS.unavailableMax).forEach((w) => {
    if (!w || typeof w !== 'object') return;
    const days = (Array.isArray(w.days) ? w.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    const startMin = intIn(w.startMin, 0, 1439, null), endMin = intIn(w.endMin, 0, 1439, null);
    if (!days.length || startMin == null || endMin == null || startMin === endMin) return;
    out.push({ days: Array.from(new Set(days)).sort(), startMin, endMin });
  });
  return out;
}

/** Private config as stored (clamped; never trusts what a client sent). */
function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const b = r.backup && typeof r.backup === 'object' ? r.backup : {};
  const pb = r.playbook && typeof r.playbook === 'object' ? r.playbook : {};
  const ex = b.external && typeof b.external === 'object' ? b.external : null;
  return {
    ackWindowMin: intIn(r.ackWindowMin, LIMITS.ackWindowMin[0], LIMITS.ackWindowMin[1], DEFAULTS.ackWindowMin),
    awayWindowMin: intIn(r.awayWindowMin, LIMITS.awayWindowMin[0], LIMITS.awayWindowMin[1], DEFAULTS.awayWindowMin),
    backup: {
      memberEmail: cleanLine(b.memberEmail, 254).toLowerCase() || null,
      external: ex ? {
        name: cleanLine(ex.name, 60),
        phone: cleanLine(ex.phone, 20),
        email: cleanLine(ex.email, 254).toLowerCase(),
        consentNote: cleanLine(ex.consentNote, 200),
        consentAtMs: toMs(ex.consentAtMs),
        consentBy: cleanLine(ex.consentBy, 128),
      } : null,
    },
    schedule: { unavailable: cleanSchedule(r.schedule && r.schedule.unavailable) },
    nameBackupToCallers: r.nameBackupToCallers === true,
    playbook: {
      draft: cleanMultiline(pb.draft, LIMITS.playbookMax),
      approved: cleanMultiline(pb.approved, LIMITS.playbookMax),
      approvedHash: cleanLine(pb.approvedHash, 64),
      approvedAtMs: toMs(pb.approvedAtMs),
      approvedBy: cleanLine(pb.approvedBy, 128),
    },
  };
}
function cleanMultiline(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]+/g, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

/**
 * Validate a `save` request from the owner. Returns { ok, config } or
 * { ok:false, error }. The external contact needs an explicit consent tick.
 */
function validateSave(input, now) {
  const i = input && typeof input === 'object' ? input : {};
  const cur = normalizeConfig(i.current || {});
  const out = Object.assign({}, cur);
  if (i.ackWindowMin !== undefined) {
    const n = Math.round(Number(i.ackWindowMin));
    if (!(n >= LIMITS.ackWindowMin[0] && n <= LIMITS.ackWindowMin[1])) return { ok: false, error: 'The wait before your backup is told must be ' + LIMITS.ackWindowMin[0] + ' to ' + LIMITS.ackWindowMin[1] + ' minutes.' };
    out.ackWindowMin = n;
  }
  if (i.awayWindowMin !== undefined) {
    const n = Math.round(Number(i.awayWindowMin));
    if (!(n >= LIMITS.awayWindowMin[0] && n <= LIMITS.awayWindowMin[1])) return { ok: false, error: 'The away wait must be ' + LIMITS.awayWindowMin[0] + ' to ' + LIMITS.awayWindowMin[1] + ' minutes.' };
    out.awayWindowMin = n;
  }
  if (i.backup !== undefined) {
    const b = i.backup && typeof i.backup === 'object' ? i.backup : {};
    if (b.kind === 'none' || b === null || (!b.memberEmail && !b.external && !b.kind)) {
      out.backup = { memberEmail: null, external: null };
    } else if (b.kind === 'member' || b.memberEmail) {
      const email = cleanLine(b.memberEmail, 254).toLowerCase();
      if (!validEmail(email)) return { ok: false, error: 'Pick a team member as your backup.' };
      out.backup = { memberEmail: email, external: null };
    } else if (b.kind === 'external') {
      const ex = b.external && typeof b.external === 'object' ? b.external : {};
      const name = cleanLine(ex.name, 60);
      const phone = cleanLine(ex.phone, 20), email = cleanLine(ex.email, 254).toLowerCase();
      if (!name) return { ok: false, error: 'Enter your backup\'s name.' };
      if (!phone && !email) return { ok: false, error: 'Enter a phone number or email for your backup.' };
      if (phone && !validPhone10(phone)) return { ok: false, error: 'Enter a 10-digit US phone number.' };
      if (email && !validEmail(email)) return { ok: false, error: 'That email address does not look right.' };
      if (ex.consent !== true) return { ok: false, error: 'Confirm this person agreed to receive these notices.' };
      out.backup = {
        memberEmail: null,
        external: { name, phone, email, consentNote: cleanLine(ex.consentNote || 'Owner confirmed the person agreed', 200), consentAtMs: toMs(now) || 0, consentBy: '' },
      };
    } else return { ok: false, error: 'Unknown backup type.' };
  }
  if (i.schedule !== undefined) out.schedule = { unavailable: cleanSchedule(i.schedule && i.schedule.unavailable) };
  if (i.nameBackupToCallers !== undefined) out.nameBackupToCallers = i.nameBackupToCallers === true;
  return { ok: true, config: out };
}

// ── backup verification ──────────────────────────────────────────────────
/**
 * Is this member row a usable backup RIGHT NOW? Re-run every tick: a removed
 * or deactivated member ends their cover without anyone remembering to.
 * row = companies/{id}/members/{email} data (or null).
 */
function verifyBackup(row, ctx) {
  const ownerUid = ctx && ctx.ownerUid;
  if (!row || typeof row !== 'object') return { ok: false, reason: 'not_member' };
  if (row.status !== 'active') return { ok: false, reason: row.status === 'invited' ? 'unclaimed' : 'inactive' };
  if (!row.uid) return { ok: false, reason: 'unclaimed' };
  if (ownerUid && row.uid === ownerUid) return { ok: false, reason: 'is_owner' };
  const role = String(row.role || '').toLowerCase();
  if (role === 'viewer' || role === 'member') return { ok: false, reason: 'viewer' };
  const name = cleanLine(row.displayName || row.name || String(row.email || '').split('@')[0], 60) || 'Backup';
  return { ok: true, kind: 'member', uid: String(row.uid), name, email: String(row.email || '') };
}
/** { ok, kind:'external', name, phone, email } from private config, or not ok. */
function externalBackup(cfg) {
  const ex = cfg && cfg.backup && cfg.backup.external;
  if (!ex || !ex.name || !(ex.phone || ex.email) || !ex.consentAtMs) return { ok: false, reason: 'no_consent' };
  return { ok: true, kind: 'external', name: ex.name, phone: digits10(ex.phone), email: ex.email || '' };
}

// ── window state ─────────────────────────────────────────────────────────
/**
 * away = { on, startMs, untilMs|null }. 'active' while on and not past the end
 * (or the 21-day cap for an open-ended one); 'expired' once it should have
 * ended; 'inactive' when off.
 */
function awayWindowState(away, now) {
  if (!away || away.on !== true) return { state: 'inactive' };
  const start = toMs(away.startMs) || now;
  const capMs = start + LIMITS.maxAwayDays * DAY;
  const until = toMs(away.untilMs);
  const end = until && until > 0 ? Math.min(until, capMs) : capMs;
  if (now >= end) return { state: 'expired', endMs: end, capped: !until || until > capMs };
  return { state: 'active', startMs: start, endMs: end, openEnded: !until, capped: !until || until > capMs };
}
function isInUnavailableWindow(cfg, now) {
  const list = (cfg && cfg.schedule && cfg.schedule.unavailable) || [];
  if (!list.length) return false;
  const p = etParts(now);
  const mins = p.hour * 60 + p.minute;
  return list.some((w) => {
    if (w.startMin < w.endMin) return w.days.includes(p.dow) && mins >= w.startMin && mins < w.endMin;
    // wraps midnight: evening part is on `days`, morning part on the next day
    const prev = (p.dow + 6) % 7;
    return (w.days.includes(p.dow) && mins >= w.startMin) || (w.days.includes(prev) && mins < w.endMin);
  });
}

// ── names ────────────────────────────────────────────────────────────────
/** "Maria Santos" → "Maria S."; one word or a number stays; never more. */
function shortName(s) {
  const t = cleanLine(s, 60);
  if (!t) return 'Someone';
  if (/^[\d\s().+\-…]+$/.test(t)) return t;
  const w = t.split(' ').filter(Boolean);
  if (w.length < 2) return w[0];
  const last = w[w.length - 1];
  return w[0] + ' ' + (/^[A-Za-z]/.test(last) ? last[0].toUpperCase() + '.' : '');
}
const firstName = (s) => cleanLine(s, 60).split(' ')[0] || '';

// ── the resolver ─────────────────────────────────────────────────────────
/**
 * Who should be told right now, and why.
 *
 *   config   normalized private config
 *   items    [{ key, kind, who, why, urgent, atMs, ackedAtMs?, phone10? }]
 *   now      ms
 *   notified { [key]: { count, lastAtMs } } from the ledger
 *   backup   the VERIFIED backup (verifyBackup / externalBackup) or null
 *   away     { on, startMs, untilMs } (the status doc's away block) or null
 *   ownerName  first name for the message ("Joe")
 *
 * Returns { notify: [{ type:'item'|'digest', keys, to, title, body, urgent }],
 *           skipped: [{ key, why }], backupProblem: null|string }
 */
function resolveBackupNotifications(args) {
  const a = args || {};
  const cfg = normalizeConfig(a.config);
  const now = Number.isFinite(a.now) ? a.now : 0;
  const items = Array.isArray(a.items) ? a.items : [];
  const notified = a.notified || {};
  const out = { notify: [], skipped: [], backupProblem: null };
  const backup = a.backup && a.backup.ok ? a.backup : null;
  if (!backup) {
    out.backupProblem = (a.backup && a.backup.reason) || 'no_backup';
    items.forEach((it) => it && out.skipped.push({ key: it.key, why: out.backupProblem === 'no_backup' ? 'no_backup' : 'backup_unavailable' }));
    return out;
  }
  const win = awayWindowState(a.away, now);
  const awayOn = win.state === 'active';
  const strict = awayOn || isInUnavailableWindow(cfg, now);
  const quiet = inQuietHours(now);
  const maxAge = DEFAULTS.itemMaxAgeDays * DAY;
  const due = [];
  const seen = new Set();

  items.forEach((it) => {
    if (!it || !it.key || seen.has(it.key)) return;
    seen.add(it.key);
    const at = toMs(it.atMs);
    if (!at) { out.skipped.push({ key: it.key, why: 'no_time' }); return; }
    if (toMs(it.ackedAtMs)) { out.skipped.push({ key: it.key, why: 'acknowledged' }); return; }
    if (now - at > maxAge) { out.skipped.push({ key: it.key, why: 'too_old' }); return; }
    const urgent = it.urgent === true;
    let thresholdMin;
    if (strict) thresholdMin = urgent ? 0 : cfg.awayWindowMin;
    else thresholdMin = urgent ? Math.min(cfg.ackWindowMin, DEFAULTS.urgentWindowMin) : cfg.ackWindowMin;
    // Turning Away on must not fire thirty stale items at once: measure from
    // the later of the item's arrival and the start of the window.
    const anchor = awayOn ? Math.max(at, toMs(win.startMs)) : at;
    if (now - anchor < thresholdMin * MIN) { out.skipped.push({ key: it.key, why: 'not_due' }); return; }
    const n = notified[it.key] || null;
    const count = n ? Number(n.count) || 0 : 0;
    if (count > 0) {
      if (count >= 1 + DEFAULTS.maxRepeats) { out.skipped.push({ key: it.key, why: 'exhausted' }); return; }
      if (now - toMs(n.lastAtMs) < DEFAULTS.repeatMin * MIN) { out.skipped.push({ key: it.key, why: 'told_recently' }); return; }
    }
    // Quiet hours: urgent goes through to a staff phone; an external contact
    // (and anything non-urgent) waits for 08:00.
    if (quiet && (!urgent || backup.kind === 'external')) { out.skipped.push({ key: it.key, why: 'quiet_hours' }); return; }
    due.push({ it, urgent, repeat: count > 0 });
  });
  if (!due.length) return out;

  const owner = firstName(a.ownerName) || 'the owner';
  const to = backup.kind === 'member'
    ? { kind: 'member', uid: backup.uid, name: backup.name }
    : { kind: 'external', name: backup.name, phone: backup.phone || '', email: backup.email || '' };
  const anyUrgent = due.some((d) => d.urgent);
  const lead = awayOn ? owner + ' is away. ' : owner + ' has not got to ';
  if (due.length > DEFAULTS.digestAfter) {
    const names = due.slice(0, 3).map((d) => shortName(d.it.who));
    const more = due.length > 3 ? ' +' + (due.length - 3) + ' more' : '';
    out.notify.push({
      type: 'digest', keys: due.map((d) => d.it.key), to, urgent: anyUrgent,
      title: due.length + ' people need a call-back',
      body: (awayOn ? lead : owner + ' is tied up. ') + names.join(', ') + more + '.',
    });
    return out;
  }
  due.forEach((d) => {
    const who = shortName(d.it.who);
    const why = cleanLine(d.it.why, 60) || 'needs a call-back';
    out.notify.push({
      type: 'item', keys: [d.it.key], to, urgent: d.urgent,
      title: (d.urgent ? 'Urgent: ' : '') + who + ' needs a call-back',
      body: (awayOn ? lead : owner + ' is tied up. ') + who + ' — ' + why + (d.repeat ? ' (reminder)' : '') + '.',
    });
  });
  return out;
}

/** Minimal packet the backup sees: no address, amounts, notes or lead link. */
function backupPacket(entry, now) {
  const e = entry || {};
  return {
    key: String(e.key || ''),
    who: shortName(e.who),
    phone10: digits10(e.phone10),
    why: cleanLine(e.why, 60),
    urgent: e.urgent === true,
    ageMin: Math.max(0, Math.round((now - toMs(e.atMs)) / MIN)),
    touches: (Array.isArray(e.touches) ? e.touches : []).slice(-LIMITS.touchesMax).map((t) => ({
      action: t.action, label: TOUCH_LABEL[t.action] || t.action, note: cleanLine(t.note, LIMITS.noteMax), atMs: toMs(t.atMs),
    })),
  };
}

/** Add a touch to a ledger entry (pure). Returns { ok, entry } or { ok:false, error }. */
function recordTouch(entry, touch, now) {
  if (!entry || typeof entry !== 'object') return { ok: false, error: 'That item is not on your list.' };
  const t = touch || {};
  if (!TOUCH_ACTIONS.includes(t.action)) return { ok: false, error: 'Unknown action.' };
  const note = cleanLine(t.note, LIMITS.noteMax);
  if (t.action === 'note' && !note) return { ok: false, error: 'Write a short note.' };
  const touches = (Array.isArray(entry.touches) ? entry.touches : []).concat([{ action: t.action, note, atMs: now, byUid: String(t.byUid || '') }]).slice(-LIMITS.touchesMax);
  return { ok: true, entry: Object.assign({}, entry, { touches, assignee: 'backup' }) };
}

/**
 * Hand-back (pure). ledger = away_windows doc data; openKeys = Set of person
 * keys that STILL need Jo when the window ends (from the source of truth).
 * Only items the backup touched AND that are still open become rows; they are
 * reassigned to the owner (assignee:'owner') with a one-line note.
 */
function handBack(ledger, openKeys, now, backupName) {
  const items = (ledger && ledger.items) || {};
  const open = openKeys instanceof Set ? openKeys : new Set(openKeys || []);
  const who = firstName(backupName) || 'Your backup';
  const rows = [];
  const next = {};
  let routed = 0, touched = 0, resolved = 0, untouchedOpen = 0;
  Object.keys(items).forEach((k) => {
    const e = items[k];
    routed++;
    const ts = Array.isArray(e.touches) ? e.touches : [];
    const stillOpen = open.has(k);
    if (!ts.length) { if (stillOpen) untouchedOpen++; next[k] = Object.assign({}, e, { assignee: 'owner' }); return; }
    touched++;
    if (!stillOpen) { resolved++; next[k] = Object.assign({}, e, { assignee: 'owner' }); return; }
    const last = ts[ts.length - 1];
    const line = cleanLine(who + ': ' + (TOUCH_LABEL[last.action] || last.action) + (last.note ? ' — ' + last.note : ''), LIMITS.noteMax);
    rows.push({
      key: k, who: shortName(e.who), phone10: digits10(e.phone10), why: cleanLine(e.why, 60),
      note: line, backupSaysDone: ts.some((t) => t.action === 'done'), lastTouchMs: toMs(last.atMs), assignee: 'owner',
    });
    next[k] = Object.assign({}, e, { assignee: 'owner' });
  });
  rows.sort((a, b) => b.lastTouchMs - a.lastTouchMs);
  return {
    rows, items: next,
    summary: { atMs: now, routed, touched, open: rows.length, resolved, untouchedOpen, backupName: cleanLine(backupName, 60) },
  };
}

// ── status doc + Today line ──────────────────────────────────────────────
/**
 * The company-readable status doc. NO phone/email/customer data. problem is
 * one of null | 'none' | 'unavailable' | 'unreachable'.
 */
function statusDoc(args) {
  const a = args || {};
  const win = awayWindowState(a.away, a.now);
  const backup = a.backup && a.backup.ok ? a.backup : null;
  let backupState = 'none';
  if (a.configuredBackup) backupState = backup ? 'ok' : 'unavailable';
  if (backup && a.unreachable) backupState = 'unreachable';
  const nameShown = a.configuredBackup ? cleanLine(a.configuredBackupName || (backup && backup.name) || '', 60) : '';
  return {
    away: win.state === 'active'
      ? { on: true, startMs: win.startMs, untilMs: toMs(a.away.untilMs) || null, endMs: win.endMs, openEnded: !!win.openEnded, windowId: cleanLine(a.away.windowId, 64) }
      : { on: false },
    // uid lets the backup's own browser know it is the backup without a
    // callable round trip; a member's uid is already visible to teammates.
    backup: a.configuredBackup ? { kind: a.configuredBackup, name: nameShown, uid: backup && backup.kind === 'member' ? String(backup.uid || '') : '' } : null,
    ownerName: cleanLine(a.ownerName, 40),
    backupState,
    playbookApproved: !!a.playbookApproved,
    pendingReview: a.pendingReview ? { windowId: cleanLine(a.pendingReview.windowId, 64), openCount: Number(a.pendingReview.openCount) || 0, atMs: toMs(a.pendingReview.atMs) } : null,
    lastTickAtMs: toMs(a.lastTickAtMs) || 0,
    updatedAtMs: a.now,
  };
}

/** Today's status line from the status doc. Mirrored by docs/pro/js/away-mode.js. */
function statusLine(doc, now) {
  const d = doc || {};
  const away = d.away || {};
  if (!away.on) return null;
  if (away.endMs && now >= away.endMs) return { text: "Your away window has ended — tap I'm back to see what happened", tone: 'warn', canImBack: true };
  const bs = d.backupState || 'none';
  const nm = d.backup && d.backup.name ? d.backup.name : '';
  const until = away.untilMs && away.untilMs > 0
    ? 'Away until ' + fmtUntil(away.untilMs)
    : 'Away — no end date (ends itself ' + fmtUntil(away.endMs || now) + ')';
  const behind = d.lastTickAtMs && now - d.lastTickAtMs > 45 * MIN;
  let text, tone = 'ok';
  if (bs === 'ok') text = until + ' — backup: ' + nm;
  else if (bs === 'unavailable') { text = until + ' — your backup' + (nm ? ' ' + nm : '') + ' is no longer active. Nobody is covering.'; tone = 'bad'; }
  else if (bs === 'unreachable') { text = until + ' — ' + (nm || 'your backup') + ' could not be reached. Check their phone.'; tone = 'bad'; }
  else { text = until + ' — no backup set'; tone = 'warn'; }
  if (behind && bs === 'ok') { text += ' (backup routing is behind)'; tone = 'warn'; }
  return { text, tone, canImBack: true };
}

// ── customer-facing wording ──────────────────────────────────────────────
const hashText = (s) => crypto.createHash('sha256').update(cleanMultiline(s, LIMITS.playbookMax), 'utf8').digest('hex');

/**
 * The DRAFT Jo edits and approves once. Never says who will call or when
 * unless Jo typed it; no outcome promises, no claim handling.
 */
function playbookDraft(args) {
  const a = args || {};
  const until = toMs(a.untilMs);
  const when = until ? 'until ' + new Date(until).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' }) : 'for a few days';
  const co = cleanLine(a.companyName, 60) || 'No Big Deal Home Solutions';
  const owner = firstName(a.ownerName) || 'the owner';
  const cover = a.nameBackup && firstName(a.backupName) ? ' ' + firstName(a.backupName) + ' is covering the phones and will follow up.' : '';
  return cleanMultiline(
    'Thanks for calling ' + co + '. ' + owner + ' is out of the office ' + when + '.' + cover +
    ' I can take your name, number and what you need, and ' + owner + ' will call you back as soon as he is back.' +
    ' If water is coming in right now, tell me and I will mark it urgent.', LIMITS.playbookMax);
}

/**
 * What Thursday may say while Away is on: the APPROVED text only, only while
 * the window is active, only when the approval still matches the text. The
 * draft is never returned. null = say nothing about being away.
 */
function thursdayAwayContext(cfg, away, now) {
  const c = normalizeConfig(cfg);
  const win = awayWindowState(away, now);
  if (win.state !== 'active') return null;
  const pb = c.playbook;
  if (!pb.approved || !pb.approvedHash || !pb.approvedAtMs) return null;
  if (hashText(pb.approved) !== pb.approvedHash) return null;
  return { active: true, text: pb.approved, untilYmd: win.endMs ? etYmd(win.endMs) : null };
}

/**
 * The only gate an Away auto-reply may pass. Inbound only; once per number per
 * window; never to an opted-out number; never outside the homeowner's send
 * window; never when texting is off; never as first contact.
 * All environment facts are injected so this stays pure:
 *   inbound, optedOut, lastReplyWindowId, windowId, withinWindow (bool from
 *   sms-send-window.withinRecipientWindow), textingAllowed (sms-texting-gate),
 *   theyWroteFirst, approved (thursdayAwayContext !== null), channel
 */
function autoReplyAllowed(a) {
  const x = a || {};
  if (x.channel !== 'sms') return { ok: false, why: 'sms_only' };
  if (x.approved !== true) return { ok: false, why: 'wording_not_approved' };
  if (x.inbound !== true) return { ok: false, why: 'not_inbound' };
  if (x.theyWroteFirst !== true) return { ok: false, why: 'not_first_contact_from_them' };
  if (x.optedOut === true) return { ok: false, why: 'opted_out' };
  if (x.textingAllowed !== true) return { ok: false, why: 'texting_off' };
  if (x.withinWindow !== true) return { ok: false, why: 'quiet_hours' };
  if (x.windowId && x.lastReplyWindowId === x.windowId) return { ok: false, why: 'already_replied_this_window' };
  return { ok: true, why: null };
}

module.exports = {
  DEFAULTS, LIMITS, TOUCH_ACTIONS, TOUCH_LABEL, QUIET_START_HOUR, QUIET_END_HOUR,
  toMs, cleanLine, digits10, validPhone10, validEmail, inQuietHours, etYmd, fmtUntil,
  normalizeConfig, validateSave, verifyBackup, externalBackup,
  awayWindowState, isInUnavailableWindow, shortName, firstName,
  resolveBackupNotifications, backupPacket, recordTouch, handBack,
  cleanMultiline, statusDoc, statusLine, hashText, playbookDraft, thursdayAwayContext, autoReplyAllowed,
};
