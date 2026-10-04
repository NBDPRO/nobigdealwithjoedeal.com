/**
 * stage-checklist.js — the actual "drives the work" mechanism.
 *
 * 2026-09-15 (driven-UX foundation). Everything else in this pass (the
 * clickable next-action chip, the shared preferredActionFor() helper) is
 * still the rep noticing a suggestion and choosing to act on it. This is
 * the part that removes the noticing: the moment a lead ENTERS a stage,
 * the single most relevant follow-up (the same one preferredActionFor()
 * would show on the kanban chip) shows up as a real task in the lead's
 * task list — on Today's Tasks, the notification bell, everywhere a task
 * already surfaces — without the rep having to look at the board at all.
 *
 * Sibling to EmailDrip.onStageChange: stage-write.js's commitStageChange()
 * calls both, the same way, after every successful stage write (kanban
 * drag, list-view stage select, context-menu move, Close-Job/prev-next
 * arrows, AND customer.html's "Move to Next Stage" — this file is loaded
 * on both pages, exactly like nbd-comms.js/EmailDrip already is).
 *
 * Deliberately ONE task per stage entry, not one per possible action —
 * STAGE_ACTIONS often lists several things a rep COULD do at a stage
 * (send a doc, log a call, advance further); flooding the task list with
 * all of them defeats the point of a next-action surface. The task ID is
 * deterministic (stage key + action id, mirroring the dedupe pattern
 * functions/integrations/measurement.js already uses for exactly this
 * reason) and existence-checked before writing, so re-entering the same
 * stage — a correction, a retry, a race between two tabs — never
 * duplicates or silently reopens a task the rep already completed.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  function _todayLocal() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  async function onStageChange(leadId, oldStage, newStage, jobType) {
    try {
      if (!leadId || !newStage) return;

      // No "what's next" on a lost deal or a closed job. Every OTHER won
      // stage does get its task (2026-10-03, job spine): won also covers
      // Install Done / Final Photos / Deductible / Final Payment /
      // Collections — the after-the-sale work (Close-Out Checklist, Final
      // Invoice, Request Final Payment, Warranty Certificate, Close Job) that
      // the old "skip every won stage" rule meant never became a task.
      // Closed stays skipped: its preferred action is File Warranty Claim, a
      // reaction to a problem, not a next step. functions/job-spine-logic.js
      // stageGetsTask is the server twin of this rule.
      if (String(newStage) === 'closed') return;
      if (typeof window.stageRole === 'function') {
        if (window.stageRole(newStage) === 'lost') return;
      }

      if (typeof window.preferredActionFor !== 'function') return;
      const action = window.preferredActionFor(newStage, jobType || null);
      if (!action || !action.id) return;

      if (!window.db || !window.doc || !window.getDoc || !window.setDoc || !window.serverTimestamp) {
        // These Firebase helpers may not be exposed on every page that
        // could someday load this file — degrade quietly rather than throw,
        // matching how the EmailDrip call right next to this one in
        // stage-write.js is also best-effort.
        return;
      }

      // Deterministic id: re-entering the same stage (a correction, a
      // retry, two tabs racing) resolves to the SAME doc rather than a new
      // row — the existence check below is what makes that idempotent
      // instead of just "less likely to collide."
      const taskId = 'stage-' + String(newStage).slice(0, 60) + '-' + String(action.id).slice(0, 60);
      const ref = window.doc(window.db, 'leads', leadId, 'tasks', taskId);

      const snap = await window.getDoc(ref);
      if (snap.exists()) return; // already surfaced (and maybe already done) — never reopen or duplicate.

      const stageLabelText = (typeof window.stageLabel === 'function' ? window.stageLabel(newStage) : null) || newStage;
      const actionLabel = action.label || String(action.id).replace(/_/g, ' ');

      await window.setDoc(ref, {
        // text is the field every task UI actually renders (tasks.js
        // renderTaskList reads t.text, not t.title) — title is carried
        // too, matching the measurement.js auto-task precedent, in case a
        // future surface reads that name instead.
        text: (action.icon ? action.icon + ' ' : '') + actionLabel,
        title: actionLabel,
        notes: 'Suggested when this lead moved to "' + stageLabelText + '".',
        source: 'stage_entry',
        stageKey: newStage,
        actionId: action.id,
        actionKind: action.kind || '',
        // Due TODAY (local day). An empty dueDate — what this wrote until
        // 2026-09-28 — is skipped by Today's Tasks and the bell (both only
        // surface dated tasks), so the "shows up without the rep looking at
        // the board" promise above never held (CRM sweep R14). Local, not
        // toISOString(): UTC made every date a day early in US evenings
        // (the follow-up bug #1822 fixed).
        dueDate: _todayLocal(),
        done: false,
        createdAt: window.serverTimestamp(),
      });

      // Let any observer (Ask Joe proactive, the notification bell, a
      // future "you have a new suggested task" toast) know one landed,
      // without this module needing to know who's listening — same
      // pattern as runLeadAction's nbd:lead-action event.
      try {
        document.dispatchEvent(new CustomEvent('nbd:stage-task-created', {
          detail: { leadId, stage: newStage, actionId: action.id, taskId },
        }));
      } catch (_) { /* CustomEvent unsupported in some embedded contexts — non-fatal */ }
    } catch (e) {
      console.warn('[stage-checklist] onStageChange failed:', e && e.message);
    }
  }

  window.StageChecklist = { onStageChange: onStageChange };
})();
