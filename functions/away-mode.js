'use strict';
/**
 * functions/away-mode.js — backup person + Away mode (never-forget lane,
 * 2026-10-12). Rules: away-mode-logic.js. Design, security model and the
 * deferred list: documentation/projects/AWAY-MODE-BACKUP-2026-10-12.md.
 *
 *   manageAway (onCall, App Check) — { action, ... }
 *     get            owner/company_admin → status + config + window + hand-back
 *     save           owner/company_admin → ack windows, backup, schedule
 *     setAway        owner/company_admin → { on, untilMs? }; off == hand back
 *     playbookDraft  owner/company_admin → generate / return the wording draft
 *     playbookSave   owner/company_admin → { text } (clears any approval)
 *     playbookApprove owner/company_admin → { hash } (must match the draft)
 *     imBack         owner/company_admin → hand back now
 *     reviewed       owner/company_admin → clears the "While you were away" row
 *     backupList     the verified backup only → minimal packets (no address,
 *                    amounts, notes or lead link)
 *     backupAct      the verified backup only → { key, action, note? }
 *   awayModeTick (every 15 min) — notifies the backup, ends expired windows.
 *
 * Writes are Admin-SDK only (firestore.rules: away_* have no client write).
 * A backup touch lands in the away ledger ONLY: it never marks a call handled
 * or writes a lead — Jo closes things when he is back.
 *
 * Integration points (see the design note, section 6): the pure resolver in
 * away-mode-logic.js, runAwayTick({ deliver }) for a verified delivery helper,
 * and thursdayAwayContext() for the Bland pathway. callWatch / the escalation
 * ladder are read through call-watch-logic.js and never edited.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const L = require('./away-mode-logic');
const { callableRateLimit } = require('./shared');
const W = require('./call-watch-logic');
const CL = require('./contact-labels');
const { requireTeamAdmin, CORS_ORIGINS } = require('./handlers/_shared');

const COL_STATUS = 'away_mode';
const COL_PRIVATE = 'away_private';
const COL_WINDOWS = 'away_windows';
const MIN = 60000;
const DAY = 86400000;
// External (non-member) backups: data model + consent are built and tested,
// delivery waits on A2P registration (design note, section 8.2).
const ALLOW_EXTERNAL = false;
const FAILED_ATTEMPTS_BEFORE_UNREACHABLE = L.DEFAULTS.maxFailedAttempts;
const MAX_LEDGER_ITEMS = 300;        // one ledger doc stays far under the 1 MiB limit
const TICK_BUDGET_MS = 90 * 1000;    // the function has 120 s; stop early and resume next run

const ledgerId = (cid, windowId) => cid + '__' + (windowId || 'standing');
const newWindowId = (now) => 'w' + Math.floor(now).toString(36);

// ── open items (read-only reuse of callWatch's rules) ────────────────────
/**
 * The people who need the owner right now, by callWatch's own rule
 * (callNeedsYou / reasonFor / callerKey). One entry per person: the earliest
 * open arrival (the ack clock), urgent if any item is.
 * Phone calls exist for the owner's own line only (userId == companyId).
 */
async function loadOpenItems(db, companyId, nowMs) {
  const since14 = nowMs - W.CALL_WINDOW;
  // Read the promise window (45 days), like callWatch: a promise Jo made is
  // on Home to day 45, so the backup's cover list must carry it too.
  const sinceWin = nowMs - W.PROMISE_WINDOW;
  const [calls, texts, thursday, labels] = await Promise.all([
    db.collection('phone_calls').where('userId', '==', companyId).where('startedAtMs', '>=', sinceWin).orderBy('startedAtMs', 'desc').get(),
    db.collection('phone_text_days').where('userId', '==', companyId).where('startedAtMs', '>=', sinceWin).orderBy('startedAtMs', 'desc').get(),
    W.readThursday(db, companyId, since14),
    // The label rule (QA 2026-10-13): the cover list follows the same rule as
    // Home / callWatch. A failed labels read returns {} (loadLabels logs it) =
    // every row is judged without labels, i.e. nobody is hidden.
    CL.loadLabels(db, companyId),
  ]);
  const rows = (s) => s.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  const callRows = rows(calls), textRows = rows(texts);
  const ctx = W.reachIndex(callRows);
  ctx.labels = labels;
  const tctx = { labels };
  const by = new Map();
  const add = (key, at, why, who, phone10) => {
    const urgent = /urgent/.test(why);
    const cur = by.get(key);
    if (!cur) { by.set(key, { key, kind: 'person', who, why, urgent, atMs: at, phone10: phone10 || '' }); return; }
    if (at && (!cur.atMs || at < cur.atMs)) cur.atMs = at;
    if (urgent && !cur.urgent) { cur.urgent = true; cur.why = why; }
    if (!cur.phone10 && phone10) cur.phone10 = phone10;
  };
  const nameOf = (c) => c.contactName || c.from || (c.phoneDigits ? '…' + String(c.phoneDigits).slice(-4) : '') || 'Unknown caller';
  callRows.forEach((c) => {
    if (!W.callNeedsYou(c, nowMs, ctx)) return;
    add(W.callerKey(c), W.toMs(c.startedAtMs), W.reasonFor(c, nowMs, ctx), nameOf(c), L.digits10(c.phoneDigits));
  });
  textRows.forEach((c) => {
    if (!W.callNeedsYou(c, nowMs, tctx)) return;
    add(W.callerKey(c), W.toMs(c.startedAtMs), W.reasonFor(c, nowMs, tctx), nameOf(c), L.digits10(c.phoneDigits));
  });
  thursday.forEach((t) => {
    if (!t || t.reviewed === true || t.status !== 'processed') return;
    const at = W.toMs(t.startedAt) || W.toMs(t.processedAt);
    if (!at || at < nowMs - W.CALL_WINDOW) return;
    const d = L.digits10(t.from);
    // Same as callWatch newNeeds: Thursday took a call from a number Jo hid or
    // quieted, so it stays out of the cover list too.
    const tl = d ? labels[d] : null;
    if (tl && (tl.policy === 'hide' || tl.policy === 'quiet')) return;
    add(d ? 'num:' + d : 'thursday:' + t.id, at, t.urgent ? 'urgent (Thursday took it)' : 'Thursday took it', String(t.from || 'Caller'), d);
  });
  // Dated promises / ripe Waiting items that live only as lead tasks (the Handled
  // sheet closes the call and leaves the debt on a task): the backup must see
  // them too (2026-10-13, audit F1). One entry per PERSON, the same key as a
  // filed call, urgent never (a promise is dated, not an emergency). A failed
  // read THROWS like the call reads above: the tick records the error and an
  // expiring window treats every touched item as still open (fail closed).
  const PC = require('./promise-channel');
  const pr = await PC.readDuePromisePeople({ db, owner: companyId, nowMs, labels });
  if (pr.failed) throw new Error('promise tasks unreadable: ' + (pr.error || 'read failed'));
  pr.people.forEach((p) => {
    add(p.key, p.atMs, 'you promised something', p.who, '');
  });
  return Array.from(by.values());
}

// ── identity ─────────────────────────────────────────────────────────────
function callerOf(request) {
  const a = request.auth;
  if (!a || !a.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const t = a.token || {};
  return { uid: a.uid, role: String(t.role || '').toLowerCase(), companyId: t.companyId || a.uid };
}
async function memberRow(db, companyId, email) {
  if (!email) return null;
  const s = await db.doc('companies/' + companyId + '/members/' + String(email).toLowerCase()).get();
  return s.exists ? s.data() : null;
}
async function ownerFirstName(companyId) {
  try {
    const { getAuth } = require('firebase-admin/auth');
    const u = await getAuth().getUser(companyId);
    return L.firstName(u.displayName || '') || '';
  } catch (_) { return ''; }
}

// ── status doc (the only thing members can read) ─────────────────────────
async function writeStatus(db, cid, parts, nowMs) {
  const ref = db.doc(COL_STATUS + '/' + cid);
  const cur = (await ref.get()).data() || {};
  const doc = L.statusDoc(Object.assign({
    away: cur.away && cur.away.on ? { on: true, startMs: cur.away.startMs, untilMs: cur.away.untilMs, windowId: cur.away.windowId } : null,
    lastTickAtMs: cur.lastTickAtMs, now: nowMs,
  }, parts));
  doc.companyId = cid;
  doc.active = !!(doc.away.on || doc.backup || doc.pendingReview);
  if (parts.keepPending === false) doc.pendingReview = null;
  await ref.set(doc, { merge: false });
  return doc;
}

// ── hand-back ────────────────────────────────────────────────────────────
const TIMELINE_MAX_ROWS = 100;
/**
 * Write each hand-back row's one-liner onto the matching lead's timeline as
 * leads/{leadId}/activity/away-{windowId}-{phone10} (type 'away_handback').
 * Internal only: it never notifies and never touches a customer.
 *   - a row with no phone, or a number on zero or more than one live lead
 *     (a proxy / office line), is skipped: a note on the wrong customer is
 *     worse than none;
 *   - deterministic id + create-if-absent, so a repeat hand-back is a no-op;
 *   - createdAt (server time) is the order field promise-cleanup / lead-brief
 *     query by; startedAtMs is the one the customer timeline sorts by.
 * Best effort: a failure is logged and never blocks the hand-back itself.
 * Returns { written, skipped }.
 */
async function fileHandBackTimeline(db, cid, windowId, rows, nowMs, backupName, log = logger) {
  const out = { written: 0, skipped: 0 };
  const list = (Array.isArray(rows) ? rows : []).slice(0, TIMELINE_MAX_ROWS);
  for (const r of list) {
    try {
      const phone = L.digits10(r && r.phone10);
      if (!/^[0-9]{10}$/.test(phone) || !r.note) { out.skipped++; continue; }
      const ids = new Set();
      for (const f of ['userId', 'companyId']) {
        const s = await db.collection('leads').where(f, '==', cid).where('phoneDigits', '==', phone).get();
        s.forEach((d) => { if ((d.data() || {}).deleted !== true) ids.add(d.id); });
      }
      if (ids.size !== 1) { out.skipped++; continue; }
      const leadId = Array.from(ids)[0];
      const ref = db.doc('leads/' + leadId + '/activity/away-' + windowId + '-' + phone);
      if ((await ref.get()).exists) { out.skipped++; continue; }
      await ref.set({
        userId: cid, companyId: cid, type: 'away_handback', source: 'away-mode',
        label: 'While you were away' + (backupName ? ' · ' + L.cleanLine(backupName, 40) : ''),
        summary: L.cleanLine(r.note, L.LIMITS.noteMax + 60),
        backupSaysDone: r.backupSaysDone === true,
        awayWindowId: windowId,
        startedAtMs: nowMs,
        createdAt: FieldValue.serverTimestamp(),
      });
      out.written++;
    } catch (e) {
      out.skipped++;
      log.warn('[awayHandBack] timeline note failed', { cid, err: e && e.message });
    }
  }
  return out;
}

async function doHandBack(db, cid, { nowMs, endedBy, openKeys, backupName, timeline }) {
  const stRef = db.doc(COL_STATUS + '/' + cid);
  const st = (await stRef.get()).data() || {};
  const wid = st.away && st.away.windowId;
  if (!wid) return { handedBack: false, reason: 'no_window' };
  const lRef = db.doc(COL_WINDOWS + '/' + ledgerId(cid, wid));
  const led = (await lRef.get()).data() || { items: {} };
  if (led.status === 'handed_back') return { handedBack: false, reason: 'already' };
  const hb = L.handBack(led, openKeys || new Set(Object.keys(led.items || {})), nowMs, backupName);
  await lRef.set({
    companyId: cid, windowId: wid, status: 'handed_back', endMs: nowMs, endedBy,
    items: hb.items, handBack: Object.assign({}, hb.summary, { rows: hb.rows }), reviewedAtMs: 0,
  }, { merge: true });
  // The lead-timeline note rides the same switch as notifying (AWAY_MODE_ENABLED):
  // dark means no new writes anywhere but the ledger and status docs.
  let tl = null;
  if (timeline) tl = await fileHandBackTimeline(db, cid, wid, hb.rows, nowMs, hb.summary.backupName);
  const privRef = db.doc(COL_PRIVATE + '/' + cid);
  const priv = L.normalizeConfig((await privRef.get()).data());
  // The approved wording is for THIS trip (it can name a date): clear it, keep
  // the draft, so the next Away needs a fresh one-tap approval.
  if (priv.playbook.approvedHash) {
    // only the approval fields, merged: never rewrite a doc the owner may be saving
    await privRef.set({ companyId: cid, updatedAtMs: nowMs, playbook: { approved: '', approvedHash: '', approvedAtMs: 0, approvedBy: '', approvedForUntilMs: 0 } }, { merge: true });
  }
  const pending = hb.rows.length || hb.summary.touched ? { windowId: wid, openCount: hb.rows.length, atMs: nowMs } : null;
  await db.doc(COL_STATUS + '/' + cid).set(Object.assign(
    L.statusDoc({
      away: null, now: nowMs, lastTickAtMs: st.lastTickAtMs, ownerName: st.ownerName,
      configuredBackup: st.backup ? st.backup.kind : null, configuredBackupName: st.backup ? st.backup.name : '',
      backup: st.backupState === 'ok' || st.backupState === 'unreachable' ? { ok: true, kind: st.backup && st.backup.kind, uid: st.backup && st.backup.uid, name: st.backup && st.backup.name } : null,
      playbookApproved: false,
      pendingReview: pending,
    }),
    // stays in the tick's query only while there is a backup to route to or a
    // hand-back waiting to be reviewed
    { companyId: cid, active: !!(st.backup || pending) }), { merge: false });
  return { handedBack: true, rows: hb.rows.length, summary: hb.summary, timeline: tl };
}

// ── the tick ─────────────────────────────────────────────────────────────
/**
 * One run. deps: { db, nowMs, live, deliver(uid,title,body,data) → {sent},
 * loadItems? (tests) }. Returns counters. Never throws for one tenant's fault.
 */
async function runAwayTick({ db, nowMs, live, deliver, loadItems = loadOpenItems, log = logger, budgetMs = TICK_BUDGET_MS }) {
  const out = { tenants: 0, notified: 0, failed: 0, handedBack: 0, unavailable: 0, errors: 0, deferred: 0 };
  const snap = await db.collection(COL_STATUS).where('active', '==', true).get();
  // Longest-since-served first, so a flood of junk tenants cannot starve a real one;
  // stop before the function's own timeout and pick up where we left off next run.
  const docs = snap.docs.slice().sort((a, b) => (Number((a.data() || {}).lastTickAtMs) || 0) - (Number((b.data() || {}).lastTickAtMs) || 0));
  const t0 = Date.now();
  for (let n = 0; n < docs.length; n++) {
    if (Date.now() - t0 > budgetMs) { out.deferred = docs.length - n; break; }
    const d = docs[n];
    const cid = d.id;
    out.tenants++;
    try {
      const st = d.data() || {};
      const priv = L.normalizeConfig((await db.doc(COL_PRIVATE + '/' + cid).get()).data());
      const win = L.awayWindowState(st.away, nowMs);
      // An expired window is handed back even when the item query fails (then
      // every touched item is treated as still open: the conservative side).
      let items = null;
      try { items = await loadItems(db, cid, nowMs); } catch (e) {
        if (win.state !== 'expired') throw e;
        log.warn('[awayTick] items unavailable at hand-back', { cid, err: e && e.message });
      }
      const openKeys = items ? new Set(items.map((i) => i.key)) : null;
      let backup = null, configured = null, configuredName = '';
      if (priv.backup.memberEmail) {
        configured = 'member';
        const row = await memberRow(db, cid, priv.backup.memberEmail);
        backup = L.verifyBackup(row, { ownerUid: cid });
        configuredName = (backup.ok ? backup.name : L.cleanLine(row && (row.displayName || row.name) || priv.backup.memberEmail.split('@')[0], 60));
      } else if (priv.backup.external) {
        configured = 'external';
        backup = L.externalBackup(priv);
        configuredName = priv.backup.external.name;
      }
      if (win.state === 'expired') {
        // Not gated by AWAY_MODE_ENABLED: ending a window is only a ledger +
        // status change, and an Away that never ends would be the worse bug.
        const r = await doHandBack(db, cid, { nowMs, endedBy: 'expired', openKeys, backupName: configuredName, timeline: live });
        if (r.handedBack) out.handedBack++;
        continue;
      }
      const wid = win.state === 'active' ? st.away.windowId : 'standing';
      const lRef = db.doc(COL_WINDOWS + '/' + ledgerId(cid, wid));
      const led = (await lRef.get()).data() || { companyId: cid, windowId: wid, status: 'active', startMs: nowMs, items: {} };
      const entries = Object.assign({}, led.items || {});
      const notified = {};
      Object.keys(entries).forEach((k) => { notified[k] = { count: entries[k].notifiedCount || 0, lastAtMs: entries[k].lastNotifiedMs || 0 }; });

      // External backups are never delivered to in this build (ALLOW_EXTERNAL).
      const usable = backup && backup.ok && (backup.kind === 'member' || ALLOW_EXTERNAL) ? backup : (backup && backup.ok ? { ok: false, reason: 'external_not_enabled' } : backup);
      const res = L.resolveBackupNotifications({
        config: priv, items, now: nowMs, notified, backup: usable, away: win.state === 'active' ? st.away : null,
        ownerName: await ownerFirstName(cid),
      });
      if (res.backupProblem && configured) out.unavailable++;

      let unreachable = st.backupState === 'unreachable';
      const byKey = new Map(items.map((i) => [i.key, i]));
      for (const n of res.notify) {
        let r = { sent: 0 };
        if (live && n.to.kind === 'member') {
          try {
            r = await deliver(n.to.uid, n.title, n.body, { type: 'away_backup', clickUrl: '/pro/dashboard.html#/home', windowId: wid });
          } catch (e) { log.warn('[awayTick] deliver failed', { cid, err: e && e.message }); }
        }
        const sent = r && Number(r.sent) > 0;
        const attempts = Math.max(0, ...n.keys.map((k) => (entries[k] && entries[k].failedAttempts) || 0));
        for (const k of n.keys) {
          const it = byKey.get(k) || {};
          const prev = entries[k] || {};
          const base = Object.assign({
            key: k, who: it.who || prev.who || '', phone10: it.phone10 || prev.phone10 || '', why: it.why || prev.why || '',
            urgent: !!(it.urgent || prev.urgent), kind: it.kind || 'person', atMs: it.atMs || prev.atMs || nowMs,
            routedAtMs: prev.routedAtMs || nowMs, touches: prev.touches || [], assignee: prev.assignee || 'backup',
            notifiedCount: prev.notifiedCount || 0, lastNotifiedMs: prev.lastNotifiedMs || 0, failedAttempts: prev.failedAttempts || 0,
          });
          if (sent) { base.notifiedCount++; base.lastNotifiedMs = nowMs; base.failedAttempts = 0; }
          else if (live) {
            base.failedAttempts = attempts + 1;
            if (base.failedAttempts >= FAILED_ATTEMPTS_BEFORE_UNREACHABLE) { base.notifiedCount++; base.lastNotifiedMs = nowMs; }
          }
          entries[k] = base;
        }
        if (sent) { out.notified++; unreachable = false; }
        else if (live) {
          out.failed++;
          if (attempts + 1 >= FAILED_ATTEMPTS_BEFORE_UNREACHABLE) unreachable = true;
          // One in-app bell on the first miss (they may have the CRM open).
          if (attempts === 0 && n.to.kind === 'member') {
            try {
              await db.collection('notifications').add({
                userId: n.to.uid, type: 'away_backup', title: n.title, message: n.body, priority: n.urgent ? 'high' : 'normal',
                clickUrl: '/pro/dashboard.html#/home', read: false, dismissed: false, createdAt: FieldValue.serverTimestamp(),
              });
            } catch (e) { log.warn('[awayTick] bell failed', { cid, err: e && e.message }); }
          }
        }
      }
      // Keep the ledger's open flag current; prune old, untouched, closed rows.
      Object.keys(entries).forEach((k) => {
        entries[k].open = openKeys.has(k);
        const e = entries[k];
        if (!e.open && !(e.touches || []).length && nowMs - (e.lastNotifiedMs || e.routedAtMs || 0) > 7 * DAY) delete entries[k];
      });
      // Hard cap: oldest closed + untouched rows go first.
      const keys = Object.keys(entries);
      if (keys.length > MAX_LEDGER_ITEMS) {
        keys.filter((k) => entries[k].open === false && !(entries[k].touches || []).length)
          .sort((a, b) => (entries[a].routedAtMs || 0) - (entries[b].routedAtMs || 0))
          .slice(0, keys.length - MAX_LEDGER_ITEMS).forEach((k) => { delete entries[k]; });
      }
      if (live) {
        // Re-read just before writing: a backup's touch, or Jo's "I'm back", can
        // land while this tenant's items were loading. Never roll a touch back,
        // never resurrect a window that was handed back meanwhile.
        const fresh = (await lRef.get()).data() || null;
        if (fresh && fresh.items) {
          Object.keys(entries).forEach((k) => {
            const f = fresh.items[k];
            if (f && Array.isArray(f.touches) && f.touches.length > (entries[k].touches || []).length) {
              entries[k].touches = f.touches;
              entries[k].assignee = f.assignee || entries[k].assignee;
            }
          });
        }
        const ledgerWrite = { companyId: cid, windowId: wid, items: entries, lastTickAtMs: nowMs };
        if (!fresh) { ledgerWrite.status = 'active'; ledgerWrite.startMs = nowMs; }
        // merge:false on the WHOLE doc (read just above): a merge would keep the
        // keys we pruned, and the doc would creep toward the 1 MiB limit.
        if (!fresh || fresh.status !== 'handed_back') await lRef.set(Object.assign({}, fresh || {}, ledgerWrite), { merge: false });
        const priorState = st.backupState;
        const nextState = !configured ? 'none' : (!backup || !backup.ok || (backup.kind === 'external' && !ALLOW_EXTERNAL)) ? 'unavailable' : (unreachable ? 'unreachable' : 'ok');
        if (nextState !== priorState || !st.lastTickAtMs || nowMs - st.lastTickAtMs > 5 * MIN) {
          // Only the tick's own fields, merged: a whole-doc write here could undo an
          // "I'm back" or a Settings save that landed while the tick ran.
          await db.doc(COL_STATUS + '/' + cid).set({ backupState: nextState, lastTickAtMs: nowMs, updatedAtMs: nowMs }, { merge: true });
        }
      }
    } catch (e) {
      out.errors++;
      log.warn('[awayTick] tenant failed', { cid, err: e && e.message });
    }
  }
  return out;
}

// ── the callable ─────────────────────────────────────────────────────────
function publicConfig(priv) {
  const b = priv.backup || {};
  return {
    ackWindowMin: priv.ackWindowMin, awayWindowMin: priv.awayWindowMin,
    backup: { memberEmail: b.memberEmail || null, external: b.external ? { name: b.external.name, phone: b.external.phone, email: b.external.email, consentAtMs: b.external.consentAtMs } : null },
    schedule: priv.schedule, 
    playbook: { draft: priv.playbook.draft, approved: !!priv.playbook.approvedHash, approvedAtMs: priv.playbook.approvedAtMs, hash: L.hashText(priv.playbook.draft || '') },
  };
}

async function eligibleMembers(db, cid) {
  const s = await db.collection('companies/' + cid + '/members').get();
  const out = [];
  s.docs.forEach((d) => {
    const v = L.verifyBackup(d.data(), { ownerUid: cid });
    if (v.ok) out.push({ email: String(d.id).toLowerCase(), name: v.name });
  });
  return out;
}

async function handleManageAway(request, deps) {
  const db = (deps && deps.db) || getFirestore();
  const nowMs = (deps && deps.nowMs) || Date.now();
  const data = request.data || {};
  const action = typeof data.action === 'string' ? data.action : '';

  // ── the backup's own two actions ──
  if (action === 'backupList' || action === 'backupAct') {
    const c = callerOf(request);
    if (c.role === 'viewer' || c.role === 'member') throw new HttpsError('permission-denied', 'Your role cannot be a backup');
    const cid = c.companyId;
    const priv = L.normalizeConfig((await db.doc(COL_PRIVATE + '/' + cid).get()).data());
    const row = await memberRow(db, cid, priv.backup.memberEmail);
    const v = L.verifyBackup(row, { ownerUid: cid });
    if (!v.ok || v.uid !== c.uid) throw new HttpsError('permission-denied', 'You are not the backup for this company');
    const st = (await db.doc(COL_STATUS + '/' + cid).get()).data() || {};
    const win = L.awayWindowState(st.away, nowMs);
    const wid = win.state === 'active' ? st.away.windowId : 'standing';
    const lRef = db.doc(COL_WINDOWS + '/' + ledgerId(cid, wid));
    const led = (await lRef.get()).data() || { items: {} };
    if (action === 'backupList') {
      const items = Object.values(led.items || {}).filter((e) => e && e.open !== false && (e.notifiedCount || 0) > 0)
        .map((e) => L.backupPacket(e, nowMs)).sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.ageMin - a.ageMin);
      return { ok: true, windowId: wid, away: win.state === 'active', items };
    }
    const key = typeof data.key === 'string' ? data.key : '';
    const entry = (led.items || {})[key];
    if (!entry || entry.open === false || !(entry.notifiedCount > 0)) throw new HttpsError('not-found', 'That item is not on your list');
    const r = L.recordTouch(entry, { action: data.touch, note: data.note, byUid: c.uid }, nowMs);
    if (!r.ok) throw new HttpsError('invalid-argument', r.error);
    await lRef.set({ items: { [key]: r.entry } }, { merge: true });
    return { ok: true };
  }

  // ── owner / company_admin ──
  // Owner / company_admin of the caller's OWN company only (requireTeamAdmin
  // also refuses a disabled account and a subordinate role without a
  // companyId). deps.requireAdmin is a test seam; production never passes it.
  // Naming the backup and approving the wording are OWNER-ONLY (a company_admin
  // may still switch Away on/off and review the hand-back).
  const ownerOnly = L.OWNER_ONLY_ACTIONS.includes(action) && !(action === 'setAway' && data.on !== true);
  const caller = await ((deps && deps.requireAdmin) || requireTeamAdmin)(request, null, ownerOnly ? { ownerOnly: true } : null);
  const cid = caller.companyId;
  const privRef = db.doc(COL_PRIVATE + '/' + cid);
  const loadPriv = async () => L.normalizeConfig((await privRef.get()).data());
  const status = async () => (await db.doc(COL_STATUS + '/' + cid).get()).data() || null;

  async function refreshStatus(priv, extra) {
    const st = (await status()) || {};
    let backup = null, configured = null, name = '';
    if (priv.backup.memberEmail) {
      configured = 'member';
      const row = await memberRow(db, cid, priv.backup.memberEmail);
      backup = L.verifyBackup(row, { ownerUid: cid });
      name = backup.ok ? backup.name : L.cleanLine(priv.backup.memberEmail.split('@')[0], 60);
    } else if (priv.backup.external) { configured = 'external'; backup = L.externalBackup(priv); name = priv.backup.external.name; }
    const keepPending = st.pendingReview && !(extra && extra.clearPending);
    return writeStatus(db, cid, {
      ownerName: await ownerFirstName(cid),
      away: extra && extra.away !== undefined ? extra.away : (st.away && st.away.on ? st.away : null),
      configuredBackup: configured, configuredBackupName: name,
      backup: backup && backup.ok ? backup : null,
      unreachable: st.backupState === 'unreachable' && backup && backup.ok,
      playbookApproved: !!priv.playbook.approvedHash,
      pendingReview: keepPending ? st.pendingReview : null,
      keepPending: !!keepPending,
    }, nowMs);
  }

  if (action === 'get') {
    const priv = await loadPriv();
    const st = await status();
    let handBack = null;
    if (st && st.pendingReview && st.pendingReview.windowId) {
      const led = (await db.doc(COL_WINDOWS + '/' + ledgerId(cid, st.pendingReview.windowId)).get()).data() || {};
      handBack = led.handBack || null;
    }
    return { ok: true, status: st, config: publicConfig(priv), members: await eligibleMembers(db, cid), handBack, allowExternal: ALLOW_EXTERNAL, defaults: L.DEFAULTS, now: nowMs };
  }

  if (action === 'save') {
    const cur = await loadPriv();
    const input = Object.assign({}, data, { current: cur });
    if (input.backup && input.backup.kind === 'external' && !ALLOW_EXTERNAL) {
      throw new HttpsError('failed-precondition', 'A backup outside your team needs texting registration — coming soon. Pick a team member for now.');
    }
    const v = L.validateSave(input, nowMs);
    if (!v.ok) throw new HttpsError('invalid-argument', v.error);
    if (v.config.backup.memberEmail && v.config.backup.memberEmail !== cur.backup.memberEmail) {
      const row = await memberRow(db, cid, v.config.backup.memberEmail);
      const ok = L.verifyBackup(row, { ownerUid: cid });
      if (!ok.ok) {
        const why = { not_member: 'That person is not on your team.', inactive: 'That team member is not active.', unclaimed: 'That person has not joined yet.', is_owner: 'You cannot be your own backup.', viewer: 'A view-only member cannot be your backup.' };
        throw new HttpsError('failed-precondition', why[ok.reason] || 'That person cannot be your backup.');
      }
    }
    if (v.config.backup.external) v.config.backup.external.consentBy = caller.uid;
    const next = Object.assign({}, v.config, { playbook: cur.playbook });
    // only the fields save owns, merged (a concurrent wording approval survives)
    await privRef.set({
      companyId: cid, updatedAtMs: nowMs, updatedBy: caller.uid,
      ackWindowMin: next.ackWindowMin, awayWindowMin: next.awayWindowMin, backup: next.backup,
      schedule: next.schedule, nameBackupToCallers: false,
    }, { merge: true });
    const st = await refreshStatus(next);
    logger.info('away_save', { companyId: cid, backup: next.backup.memberEmail ? 'member' : (next.backup.external ? 'external' : 'none') });
    return { ok: true, status: st, config: publicConfig(next) };
  }

  if (action === 'setAway') {
    const priv = await loadPriv();
    const st = await status();
    const on = data.on === true;
    if (!on) return handleManageAway({ auth: request.auth, data: { action: 'imBack' } }, deps);
    let until = Number(data.untilMs) || 0;
    if (until) {
      if (until <= nowMs + 5 * MIN) throw new HttpsError('invalid-argument', 'Pick an end time in the future.');
      if (until > nowMs + L.LIMITS.maxAwayDays * DAY) throw new HttpsError('invalid-argument', 'Away can run at most ' + L.LIMITS.maxAwayDays + ' days at a time.');
    }
    const already = st && st.away && st.away.on;
    // A changed end time makes any wording approved against the old one stale.
    // A NEW window never inherits wording its starter did not approve: an approval
    // made while Away was off (bound to no end time) goes live only when the
    // approver themselves starts the trip.
    const stale = priv.playbook.approvedHash && (already
      ? (priv.playbook.approvedForUntilMs && priv.playbook.approvedForUntilMs !== (until || 0))
      : priv.playbook.approvedBy !== caller.uid);
    if (stale) {
      priv.playbook = Object.assign({}, priv.playbook, { approved: '', approvedHash: '', approvedAtMs: 0, approvedBy: '', approvedForUntilMs: 0 });
      await privRef.set({ companyId: cid, updatedAtMs: nowMs, playbook: { approved: '', approvedHash: '', approvedAtMs: 0, approvedBy: '', approvedForUntilMs: 0 } }, { merge: true });
    }
    const away = already
      ? { on: true, startMs: st.away.startMs, untilMs: until || null, windowId: st.away.windowId }
      : { on: true, startMs: nowMs, untilMs: until || null, windowId: newWindowId(nowMs) };
    if (!already) {
      await db.doc(COL_WINDOWS + '/' + ledgerId(cid, away.windowId)).set({
        companyId: cid, windowId: away.windowId, status: 'active', startMs: nowMs, startedBy: caller.uid, items: {},
      }, { merge: false });
    }
    const out = await refreshStatus(priv, { away, clearPending: false });
    logger.info('away_on', { companyId: cid, until: !!until });
    return { ok: true, status: out };
  }

  if (action === 'imBack') {
    const priv = await loadPriv();
    const st = await status();
    if (!st || !st.away || !st.away.on) return { ok: true, status: st, handBack: null };
    const items = await (deps && deps.loadItems ? deps.loadItems(db, cid, nowMs) : loadOpenItems(db, cid, nowMs));
    const r = await doHandBack(db, cid, {
      nowMs, endedBy: caller.uid, openKeys: new Set(items.map((i) => i.key)),
      timeline: deps && deps.timeline !== undefined ? !!deps.timeline : tickEnabled(),
      backupName: (st.backup && st.backup.name) || (priv.backup.external && priv.backup.external.name) || '',
    });
    const after = await status();
    logger.info('away_off', { companyId: cid, rows: r.rows || 0 });
    return { ok: true, status: after, handBack: r };
  }

  if (action === 'reviewed') {
    const st = await status();
    // Only the window the status doc names (never a client-supplied id).
    const wid = (st && st.pendingReview && st.pendingReview.windowId) || '';
    if (!/^w[0-9a-z]{1,20}$/.test(wid)) return { ok: true };
    await db.doc(COL_WINDOWS + '/' + ledgerId(cid, wid)).set({ reviewedAtMs: nowMs, reviewedBy: caller.uid }, { merge: true });
    const priv = await loadPriv();
    const out = await refreshStatus(priv, { clearPending: true });
    return { ok: true, status: out };
  }

  if (action === 'playbookDraft' || action === 'playbookSave' || action === 'playbookApprove') {
    const priv = await loadPriv();
    const st = await status();
    if (action === 'playbookDraft') {
      const company = ((await db.doc('companies/' + cid).get()).data() || {}).name;
      const draft = L.playbookDraft({
        companyName: company, ownerName: await ownerFirstName(cid), untilMs: st && st.away && st.away.untilMs,

      });
      return { ok: true, draft, hash: L.hashText(draft) };
    }
    const pb = Object.assign({}, priv.playbook);
    if (action === 'playbookSave') {
      const clean = L.cleanMultiline(data.text, L.LIMITS.playbookMax);
      if (!clean) throw new HttpsError('invalid-argument', 'The wording cannot be empty.');
      pb.draft = clean;
      if (L.hashText(clean) !== pb.approvedHash) { pb.approved = ''; pb.approvedHash = ''; pb.approvedAtMs = 0; pb.approvedBy = ''; }
    } else {
      if (!pb.draft) throw new HttpsError('failed-precondition', 'Write the wording first.');
      if (typeof data.hash !== 'string' || data.hash !== L.hashText(pb.draft)) {
        throw new HttpsError('failed-precondition', 'The wording changed — review it and approve again.');
      }
      pb.approved = pb.draft; pb.approvedHash = L.hashText(pb.draft); pb.approvedAtMs = nowMs; pb.approvedBy = caller.uid;
      // Bound to the end time it was approved against (0 = Away was off).
      pb.approvedForUntilMs = st && st.away && st.away.on && st.away.untilMs ? Number(st.away.untilMs) : 0;
    }
    const next = Object.assign({}, priv, { playbook: pb });
    // only the playbook, merged (a concurrent backup save survives)
    await privRef.set({ companyId: cid, updatedAtMs: nowMs, updatedBy: caller.uid, playbook: pb }, { merge: true });
    const out = await refreshStatus(next);
    return { ok: true, status: out, config: publicConfig(next) };
  }

  throw new HttpsError('invalid-argument', 'Unknown action');
}

exports.manageAway = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    // 120 / min / uid (the Today list refreshes ~1/min; a real user never nears it)
    await callableRateLimit(request, 'manageAway', 120, 60_000);
    return handleManageAway(request);
  }
);

const tickEnabled = () => process.env.AWAY_MODE_ENABLED === 'true';
exports.awayModeTick = onSchedule(
  { schedule: 'every 15 minutes', timeZone: 'America/New_York', timeoutSeconds: 120, memory: '256MiB', maxInstances: 1 },
  async () => {
    const push = require('./push-functions');
    const r = await runAwayTick({
      db: getFirestore(), nowMs: Date.now(), live: tickEnabled(),
      deliver: (uid, title, body, data) => push.sendCustomNotification(uid, title, body, Object.assign({ notificationId: 'away-' + Date.now() }, data)),
    });
    logger.info('[awayModeTick]', r);
    if (r.errors) throw new Error('awayModeTick: ' + r.errors + ' tenant(s) failed');
  }
);

exports._internal = { handleManageAway, runAwayTick, loadOpenItems, doHandBack, fileHandBackTimeline, ledgerId, ALLOW_EXTERNAL };
