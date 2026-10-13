/**
 * stage-write.js — the ONE safe way to change a lead's `stage` in Firestore.
 *
 * Foundation piece for the 2026-09-15 CRM stage-progression rework. Before
 * this file existed there were two independent implementations of "write a
 * new stage to Firestore":
 *
 *   - crm-pipeline.js's moveCard() (kanban drag/drop, context menu, list
 *     view) — a Firestore transaction with race guards (STAGE_RACE_NOOP /
 *     STAGE_RACE_LOST), stageRole stamping, an activity-log note, and an
 *     EmailDrip trigger.
 *   - customer-bootstrap.module.js's progressStage() ("Move to Next Stage"
 *     on the customer detail page) — a PLAIN updateDoc with no race
 *     protection at all, duplicating (by hand) the note + drip logic above.
 *
 * A rep on the kanban and a rep/customer-page session racing on the same
 * lead could silently last-write-wins clobber each other's stage change
 * through the second path. This module is the single choke point both
 * callers now go through, so every stage change gets the same transaction
 * safety, the same bookkeeping, and — going forward — the same required-
 * field gate and stage-entry checklist hook, in exactly one place.
 *
 * Pure-ish: reads Firebase helpers off `window.*` (the convention this app
 * already uses everywhere — doc/runTransaction/updateDoc/arrayUnion/
 * serverTimestamp/addDoc/collection are all wired onto `window` by both
 * dashboard-bootstrap.module.js and customer-bootstrap.module.js), so it
 * works unmodified from either page. No DOM, no board/render assumptions —
 * callers own all UI (optimistic render, toasts, reload-vs-in-place).
 */

/**
 * Who is making this stage change — read from the signed-in Firebase user AT
 * WRITE TIME (2026-10-03).
 *
 * Every stageHistory entry before 2026-09-15 says user "unknown" (the owner
 * tenant's whole history up to then — 19 of the 24 most recent entries the
 * 2026-10-03 audit read). moveCard built the actor from
 * window._currentUser?.email, a global only vault-auth.module.js (the vault
 * pages) ever sets, so on the dashboard it was always undefined. #1573 added
 * an auth.currentUser fallback, but callers still pass that dead global as
 * actorLabel, and nothing recorded the uid — a phone/custom-token sign-in
 * with no email would still say "unknown". Now: the uid always (`by`), plus
 * email and display name when the account has them; `user` keeps its old
 * meaning (a readable label) for every existing reader.
 *
 * @param {string} [labelOverride] an explicit label from the caller
 * @returns {{uid: (string|null), email: (string|null), name: (string|null), label: string}}
 */
export function stageActor(labelOverride) {
  const u = (window.auth && window.auth.currentUser)
    || (window._auth && window._auth.currentUser)
    || window._user
    || null;
  const uid = (u && u.uid) || null;
  const email = (u && u.email) || null;
  const name = (u && u.displayName) || null;
  const override = (typeof labelOverride === 'string' && labelOverride.trim()) ? labelOverride.trim() : null;
  return { uid, email, name, label: override || email || name || uid || 'unknown' };
}

/**
 * Commit a stage change transactionally, with the same race guards
 * moveCard() has always used.
 *
 * @param {string} id                the lead id
 * @param {string} newStage          destination stage key
 * @param {string} oldStage          the stage the caller believes the lead
 *                                    is currently on (used for the
 *                                    STAGE_RACE_LOST check and the history
 *                                    entry's `from`)
 * @param {Object} [opts]
 * @param {boolean} [opts.isLostMove]   stamp closedAt/lostReason
 * @param {string}  [opts.lostReason]
 * @param {Object}  [opts.lostFields]   { lostReasonKey, lostReason,
 *   lostReasonNote } from the required lost-reason picker
 *   (lost-reason-picker.js / numbers-logic.js lostReasonFields). A lost move
 *   with no reason and no reason already on the lead is refused with
 *   'LOST_REASON_REQUIRED' (2026-10-04: every loss carries a reason).
 * @param {boolean} [opts.isDrag]       true ONLY for genuine drag-and-drop
 *   call sites where `newStage` is a COLUMN key, not necessarily an exact
 *   stage match — enables the column-collapse NOOP guard. See moveCard's
 *   own isDrag doc-comment in crm-pipeline.js for the full rationale; this
 *   flag exists here only so callers keep that exact behavior, not to
 *   re-explain it.
 * @param {string}  [opts.actorLabel]   'user' field for the history event
 *                                       (defaults to the signed-in user's
 *                                       email)
 * @returns {Promise<{historyEvent: Object, enteredWon: boolean}>} resolves once the transaction
 *   (or fallback plain write), the activity note, and the drip trigger have
 *   all been attempted. Activity-note and drip failures are swallowed
 *   (console.warn only) — matching both prior implementations, since
 *   neither should block the stage write itself from succeeding.
 * @throws {Error} with `.message` one of:
 *   - 'STAGE_RACE_NOOP'  — another tab/session already landed on this exact
 *     stage (or, for a drag move, the same visible column). Nothing to do;
 *     the caller should treat the destination as already-correct.
 *   - 'STAGE_RACE_LOST'  — another tab/session moved the lead to a
 *     DIFFERENT stage since the caller's `oldStage` snapshot. The caller
 *     must NOT re-apply its own move; refresh from Firestore instead.
 *   - anything else — a genuine write failure (offline, rules denial, …).
 */
export async function commitStageChange(id, newStage, oldStage, opts) {
  opts = opts || {};
  const isDrag = !!opts.isDrag;
  const isLostMove = !!opts.isLostMove;
  const lostFields = (opts.lostFields && typeof opts.lostFields === 'object' && opts.lostFields.lostReason) ? opts.lostFields : null;
  const lostReason = (lostFields && lostFields.lostReason) || opts.lostReason || null;
  // jobType (2026-09-15): threaded through from the caller's already-loaded
  // lead object so the StageChecklist hook below can pick the right
  // per-track action (STAGE_ACTIONS is jobType-scoped) without this
  // function re-fetching the lead doc just to read one field.
  const jobType = opts.jobType || null;

  // Already-completed backfill (2026-10-13, Jo: "say already completed on
  // anything that missed scheduling and it forwards it to the next stage").
  // A QUIET move onto install_complete for a job that was finished without
  // ever being scheduled in the app: it stamps the real completion date
  // (completedAt — the field winback / anniversary / social-studio /
  // agent-mcp already read), marks the lead completedBackfill (the quiet flag
  // every after-install automation checks), and fires NO customer-facing
  // side effect from here (no drip toast, no Before & After report). The
  // required-field gate lives in moveCard, not here, so this path never
  // blocks on a skipped intermediate stage — the caller records what it
  // bypassed in opts.backfill.skipped / .unchecked (history + note only).
  // opts.backfill = { date: 'YYYY-MM-DD', skipped?: string[], unchecked?: string[], today?: 'YYYY-MM-DD' }
  const backfill = (opts.backfill && typeof opts.backfill === 'object') ? opts.backfill : null;
  let backfillAt = null;
  let backfillDate = '';
  let backfillResult = null;
  if (backfill) {
    if (newStage !== 'install_complete') throw new Error('BACKFILL_STAGE_INVALID');
    // The race guards and the Undo token only mean something inside a
    // transaction; without one (a page that never exposed runTransaction)
    // refuse rather than write a completion with no way back.
    if (typeof window.runTransaction !== 'function') throw new Error('BACKFILL_NEEDS_TRANSACTION');
    if (completionDateIssue(backfill.date, backfill.today)) throw new Error('BACKFILL_DATE_INVALID');
    backfillDate = String(backfill.date).trim();
    const _p = backfillDate.split('-').map(Number);
    backfillAt = new Date(_p[0], _p[1] - 1, _p[2], 12, 0, 0);   // local noon: the same calendar day in every US zone
  }
  const _names = (a) => (Array.isArray(a) ? a : []).map((x) => String(x == null ? '' : x).slice(0, 60)).filter(Boolean).slice(0, 12);

  const actor = stageActor(opts.actorLabel);
  const historyEvent = {
    from: oldStage,
    to: newStage,
    timestamp: new Date().toISOString(),
    user: actor.label,
    by: actor.uid,
  };
  if (actor.email) historyEvent.byEmail = actor.email;
  if (actor.name) historyEvent.byName = actor.name;
  if (isLostMove && lostReason) historyEvent.lostReason = lostReason;
  if (backfill) {
    historyEvent.backfill = true;
    historyEvent.completedOn = backfillDate;
    historyEvent.reason = 'missed_scheduling';
    const _sk = _names(backfill.skipped);
    const _un = _names(backfill.unchecked);
    if (_sk.length) historyEvent.skipped = _sk;
    if (_un.length) historyEvent.unchecked = _un;
  }

  const leadRef = window.doc(window.db, 'leads', id);
  // Won-stage close stamp (2026-10-03 data audit: 10 won leads had no
  // closedAt — only a LOST move stamped it, so a deal dragged to Install
  // Complete / Final Payment / Closed carried no close date and fell out of
  // every "closed this month" read that keys on it). Entering a won stage
  // stamps closedAt unless the lead was already won with a close date (a
  // won → won step is not a second close). Set inside the transaction from
  // the server copy, so a stale local snapshot can't double-stamp.
  const _roleOf = (k) => (typeof window.stageRole === 'function' ? window.stageRole(k) : null);
  const enteringWon = _roleOf(newStage) === 'won';
  let enteredWon = false;
  // The close date is the SALE (2026-10-04, Jo 2026-09-15: a signed contract
  // IS a job): entering contract signed, a job stage or a won stage stamps
  // closedAt unless the lead was already a sale with a date. Same rule as
  // functions/stage-roles.js needsClosedAt and numbers-logic.js isSale.
  const _N = window.NBDNumbers;
  const _isSale = (k) => {
    if (_N && typeof _N.isSale === 'function') return _N.isSale({ stage: k });
    const r = _roleOf(k);
    return r === 'won' || r === 'job' || String(k || '').toLowerCase() === 'contract_signed';
  };
  const enteringSale = _isSale(newStage);
  // Sold package: carry the homeowner's accepted pick onto soldTier at the
  // sale when nothing has set one yet (the spine does the same server-side).
  const _TIERS = ['economy', 'good', 'better', 'best', 'beyond'];
  const _soldTierPatch = (cur) => {
    if (!enteringSale || !cur || _TIERS.indexOf(String(cur.soldTier || '').toLowerCase()) !== -1) return null;
    const t = String(cur.acceptedTier || '').toLowerCase();
    return _TIERS.indexOf(t) !== -1 ? { soldTier: t, soldTierSource: 'deal_room' } : null;
  };
  const _lostPayload = (cur) => {
    const reason = lostReason || (cur && cur.lostReason) || null;
    if (!reason) throw new Error('LOST_REASON_REQUIRED');
    const out = { lostReason: reason };
    if (lostFields) {
      out.lostReasonKey = lostFields.lostReasonKey || null;
      out.lostReasonNote = lostFields.lostReasonNote || null;
    }
    return out;
  };

  // Backfill: the completion fields, written in the SAME patch as the stage so
  // a half-applied backfill (stage moved, date missing) cannot exist. prev is
  // read from the server copy inside the transaction — it is what Undo puts
  // back. completedBackfill.token is this write's history timestamp: Undo
  // only fires while that token is still on the lead (nothing moved it since).
  const _backfillPatch = (payload, cur) => {
    const prev = {};
    payload.completedAt = backfillAt;
    payload.stageStartedAt = backfillAt;          // it entered Install Done on the day it finished
    payload.completedBackfill = {
      date: backfillDate, quiet: true, reason: 'missed_scheduling',
      by: actor.label, byUid: actor.uid, at: window.serverTimestamp(),
      token: historyEvent.timestamp, fromStage: (cur && cur.stage) || oldStage || null,
    };
    ['stage', 'stageRole', 'stageStartedAt', 'closedAt', 'completedAt', 'completedBackfill', 'soldTier', 'soldTierSource'].forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(payload, k)) prev[k] = (cur && cur[k] !== undefined) ? cur[k] : null;
    });
    if (!prev.stage) prev.stage = oldStage || null;
    return { prev, token: historyEvent.timestamp, date: backfillDate };
  };

  if (typeof window.runTransaction === 'function') {
    await window.runTransaction(window.db, async (tx) => {
      const snap = await tx.get(leadRef);
      if (!snap.exists()) throw new Error('Lead not found');
      const cur = snap.data() || {};

      // Column-collapse NOOP — drag-only. See moveCard's own comment in
      // crm-pipeline.js for the full history; kept identical here so a
      // dropped-on-its-own-column card behaves the same from either page.
      const _keys = window._stageKeys;
      const _curCol = (isDrag && typeof window.resolveColumn === 'function' && Array.isArray(_keys) && _keys.length)
        ? window.resolveColumn(cur.stage, _keys) : cur.stage;
      if (cur.stage === newStage || _curCol === newStage) {
        throw new Error('STAGE_RACE_NOOP');
      }
      // Only enforce the from-stage check when the caller actually has one
      // recorded — an optimistic-inserted lead can have an undefined local
      // `oldStage` even though Firestore already settled elsewhere.
      if (oldStage && cur.stage && cur.stage !== oldStage) {
        throw new Error('STAGE_RACE_LOST');
      }

      const payload = {
        stage: newStage,
        ...(window.stageRole ? { stageRole: window.stageRole(newStage) } : {}),
        updatedAt: window.serverTimestamp(),
        stageStartedAt: window.serverTimestamp(),
        stageHistory: window.arrayUnion(historyEvent),
      };
      if (isLostMove) {
        payload.closedAt = window.serverTimestamp();
        Object.assign(payload, _lostPayload(cur));
      } else if (enteringSale && (!cur.closedAt || !_isSale(cur.stage))) {
        payload.closedAt = window.serverTimestamp();
      }
      const _tier = _soldTierPatch(cur);
      if (_tier) Object.assign(payload, _tier);
      if (backfill) backfillResult = _backfillPatch(payload, cur);
      else if (cur.completedBackfill && _roleOf(newStage) !== 'won' && _roleOf(newStage) !== 'lost') {
        // A job marked "already completed" is dragged BACK to open work: the
        // completion claim (and the quiet flag with it) no longer holds, and
        // the real completion — when it comes — must not stay muted.
        payload.completedBackfill = null;
        payload.completedAt = null;
      }
      enteredWon = enteringWon && _roleOf(cur.stage) !== 'won';
      tx.update(leadRef, payload);
    });
  } else {
    // Fallback for a page where runTransaction isn't exposed — no race
    // protection, but every other write is identical.
    const payload = {
      stage: newStage,
      ...(window.stageRole ? { stageRole: window.stageRole(newStage) } : {}),
      updatedAt: window.serverTimestamp(),
      stageStartedAt: window.serverTimestamp(),
      stageHistory: window.arrayUnion(historyEvent),
    };
    if (isLostMove) {
      payload.closedAt = window.serverTimestamp();
      Object.assign(payload, _lostPayload(null));
    } else if (enteringSale && !_isSale(oldStage)) {
      // No server read on this path: the caller's oldStage decides.
      payload.closedAt = window.serverTimestamp();
    }
    if (backfill) backfillResult = _backfillPatch(payload, null);
    enteredWon = enteringWon && _roleOf(oldStage) !== 'won';
    await window.updateDoc(leadRef, payload);
  }

  // Activity-log note. Best-effort: a note-write failure shouldn't undo a
  // successful stage change.
  try {
    const label = (typeof window.stageLabel === 'function' ? window.stageLabel(newStage) : null)
      || (window.STAGE_META && window.STAGE_META[newStage] && window.STAGE_META[newStage].label)
      || newStage;
    await window.addDoc(window.collection(window.db, 'notes'), {
      leadId: id,
      userId: window._user?.uid || window.auth?.currentUser?.uid || null,
      text: backfill
        ? ("Marked already completed on " + completionLabel(backfillDate) + " (missed scheduling)"
          + (_names(backfill.skipped).length ? " — skipped " + _names(backfill.skipped).join(", ") : "")
          + (_names(backfill.unchecked).length ? "; not checked: " + _names(backfill.unchecked).join(", ") : ""))
        : `Stage moved to "${label}"`,
      type: 'stage_change',
      createdAt: window.serverTimestamp(),
      createdBy: window._user?.email || window.auth?.currentUser?.email || 'system',
    });
  } catch (e) { console.warn('[stage-write] activity note failed:', e && e.message); }

  // Email drip automation.
  try {
    if (!backfill && window.EmailDrip && typeof window.EmailDrip.onStageChange === 'function') {
      window.EmailDrip.onStageChange(id, oldStage, newStage);
    }
  } catch (e) { console.warn('[stage-write] drip trigger failed:', e && e.message); }

  // Stage-entry auto-task (2026-09-15 driven-UX foundation) — the actual
  // "drives the work" mechanism: the lead's #1 next action for its NEW
  // stage shows up as a real task without the rep opening the board.
  // Not awaited, same as the drip above — this is a side effect of a
  // stage change that already succeeded, not a precondition for it.
  // stage-checklist.js's own top-level try/catch means this never rejects.
  try {
    if (window.StageChecklist && typeof window.StageChecklist.onStageChange === 'function') {
      window.StageChecklist.onStageChange(id, oldStage, newStage, jobType);
    }
  } catch (e) { console.warn('[stage-write] stage-checklist trigger failed:', e && e.message); }

  // Before & After report on install complete (2026-10-04). Not awaited:
  // a side effect of a stage change that already succeeded.
  // Quiet backfill: a long-finished job must not file a homeowner report.
  try { if (!backfill) autoBeforeAfterOnStage(id, oldStage, newStage); }
  catch (e) { console.warn('[stage-write] before/after trigger failed:', e && e.message); }

  // Production flow (2026-10-04, production.js): a soft warning when a job
  // reaches Final Photos with no After photos (the move has already gone
  // through — it warns, never blocks), and the "After photos + walkthrough"
  // checklist task on entering Install Done. Not awaited, best-effort.
  try {
    if (window.NBDProduction && typeof window.NBDProduction.onStageChange === 'function') {
      window.NBDProduction.onStageChange(id, oldStage, newStage);
    }
  } catch (e) { console.warn('[stage-write] production hook failed:', e && e.message); }

  // enteredWon: this move took the lead from a non-won stage onto a won one —
  // the caller's cue to offer "Create invoice" (crm-pipeline.js moveCard).
  return backfillResult ? { historyEvent, enteredWon, backfill: backfillResult } : { historyEvent, enteredWon };
}

/**
 * Should a one-tap stage move stop and ask first? (2026-10-08, phone audit
 * 2026-10-07 #10: every "→ Move to <next>" asked "Move customer to X?", two
 * taps for one action, while a kanban drag never asked.)
 *
 * A normal move just moves; the caller offers a few seconds of Undo instead.
 * Ask only when the move is one to think twice about:
 *   - a warning applies — the 3-day cancellation window (NBDJurisdiction
 *     workStartWarning) or any other caller-supplied warning text;
 *   - the destination is destructive: Lost, Archived, Cancelled (by key or
 *     by stage role), which close the job out.
 * Pure: no DOM, no Firestore.
 *
 * @param {string} nextStage destination stage key
 * @param {{warning?: string, role?: string}} [opts] warning text; the
 *   destination's stage role when the caller knows it (window.stageRole)
 * @returns {boolean}
 */
export function stageMoveNeedsConfirm(nextStage, opts) {
  const o = opts || {};
  if (o.warning && String(o.warning).trim()) return true;
  const role = String(o.role || '').toLowerCase();
  if (role === 'lost' || role === 'archived' || role === 'cancelled') return true;
  const key = String(nextStage || '').toLowerCase();
  return /(^|[_\s-])(lost|archived?|cancell?ed)($|[_\s-])/.test(key);
}

/**
 * When a lead moves ONTO install_complete, hand it to photo-report.js's
 * NBDAutoBeforeAfter (lazy `photos` bundle), which files the homeowner
 * Before & After report in Documents — or, with no After photo yet, waits
 * for the first one. Returns true when it fired. Never throws, never awaits.
 */
export function autoBeforeAfterOnStage(id, oldStage, newStage) {
  if (!id || newStage !== 'install_complete' || oldStage === 'install_complete') return false;
  const run = () => {
    const ba = window.NBDAutoBeforeAfter;
    if (ba && typeof ba.onInstallComplete === 'function') {
      Promise.resolve(ba.onInstallComplete(id)).catch((e) =>
        console.warn('[stage-write] before/after report failed:', e && e.message));
    }
  };
  if (window.NBDAutoBeforeAfter) { run(); return true; }
  const loader = window.ScriptLoader;
  if (loader && typeof loader.loadBundle === 'function') {
    Promise.resolve(loader.loadBundle('photos')).then(run).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Why a completion date is not acceptable, or '' when it is. Pure.
 * 'malformed' (not a real YYYY-MM-DD calendar day), 'future' (after today —
 * "already completed" cannot be tomorrow), 'too-old' (before 2015).
 * @param {string} ymd
 * @param {string} [today] YYYY-MM-DD; defaults to the device's local day
 */
export function completionDateIssue(ymd, today) {
  const s = String(ymd == null ? '' : ymd).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return 'malformed';
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return 'malformed';
  let t = String(today == null ? '' : today).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const n = new Date();
    t = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  }
  if (s > t) return 'future';
  if (y < 2015) return 'too-old';
  return '';
}

/** 'YYYY-MM-DD' → 'Oct 2, 2026' (no Date/timezone involved). Pure. */
export function completionLabel(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return (MON[+m[2] - 1] || m[2]) + ' ' + (+m[3]) + ', ' + m[1];
}

/**
 * Undo an "already completed" backfill: put back the stage and the fields
 * that write replaced, and clear completedAt / completedBackfill — but ONLY
 * while the lead is still exactly as that write left it (stage still
 * install_complete and completedBackfill.token still the one this write
 * minted). Anything else having moved the lead since → throws 'UNDO_STALE'
 * and writes nothing. Cleared fields go back to null (the app reads null and
 * absent alike). Appends an undo event to stageHistory; never deletes one.
 * @param {string} id
 * @param {{prev: Object, token: string, date?: string}} snap commitStageChange's result.backfill
 * @returns {Promise<{stage: string}>}
 */
export async function undoBackfillCompletion(id, snap) {
  if (!id || !snap || !snap.token || !snap.prev || typeof snap.prev !== 'object' || !snap.prev.stage) {
    throw new Error('UNDO_UNAVAILABLE');
  }
  const actor = stageActor();
  const leadRef = window.doc(window.db, 'leads', id);
  const KEYS = ['stage', 'stageRole', 'stageStartedAt', 'closedAt', 'completedAt', 'completedBackfill', 'soldTier', 'soldTierSource'];
  const event = {
    from: 'install_complete', to: snap.prev.stage, timestamp: new Date().toISOString(),
    user: actor.label, by: actor.uid, backfillUndo: true, undoOf: snap.token,
  };
  if (actor.email) event.byEmail = actor.email;
  if (actor.name) event.byName = actor.name;
  const build = (cur) => {
    const bf = cur && cur.completedBackfill;
    if (!cur || cur.stage !== 'install_complete' || !bf || bf.token !== snap.token) throw new Error('UNDO_STALE');
    const patch = {};
    KEYS.forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(snap.prev, k)) patch[k] = snap.prev[k] === undefined ? null : snap.prev[k];
    });
    patch.completedAt = Object.prototype.hasOwnProperty.call(snap.prev, 'completedAt') ? (snap.prev.completedAt || null) : null;
    patch.completedBackfill = null;
    patch.updatedAt = window.serverTimestamp();
    patch.stageHistory = window.arrayUnion(event);
    return patch;
  };
  // The token check is only atomic inside a transaction: no fallback write.
  if (typeof window.runTransaction !== 'function') throw new Error('UNDO_UNAVAILABLE');
  await window.runTransaction(window.db, async (tx) => {
    const s = await tx.get(leadRef);
    if (!s.exists()) throw new Error('Lead not found');
    tx.update(leadRef, build(s.data() || {}));
  });
  try {
    const label = (typeof window.stageLabel === 'function' ? window.stageLabel(snap.prev.stage) : null)
      || (window.STAGE_META && window.STAGE_META[snap.prev.stage] && window.STAGE_META[snap.prev.stage].label)
      || snap.prev.stage;
    await window.addDoc(window.collection(window.db, 'notes'), {
      leadId: id,
      userId: window._user?.uid || window.auth?.currentUser?.uid || null,
      text: 'Undid "already completed" - back to "' + label + '"',
      type: 'stage_change',
      createdAt: window.serverTimestamp(),
      createdBy: window._user?.email || window.auth?.currentUser?.email || 'system',
    });
  } catch (e) { console.warn('[stage-write] undo note failed:', e && e.message); }
  return { stage: snap.prev.stage };
}
