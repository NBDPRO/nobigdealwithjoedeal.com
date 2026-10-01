/**
 * Insurance Claim Workflow Automation Module
 * NBD Pro CRM - Roofing Contractor SaaS
 *
 * Guides contractors through the insurance claim process with visual
 * workflow tracking, checklist management, and Firestore integration.
 */

let _NBD_IC_DELEGATE; // module-local (globals Tranche 1 — was window.*)
(function() {
  'use strict';
  // Claim # and carrier are free text a rep types or the Thursday phone-intake
  // AI copies from a caller (security audit 2026-09-29) — never raw HTML.
  function _icEsc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // Claim workflow stages in order
  const CLAIM_STAGES = [
    { id: 'initial_inspection', label: 'Initial Inspection' },
    { id: 'documentation', label: 'Documentation' },
    { id: 'claim_filed', label: 'Claim Filed' },
    { id: 'adjuster_scheduled', label: 'Adjuster Scheduled' },
    { id: 'adjuster_visit', label: 'Adjuster Visit' },
    { id: 'estimate_review', label: 'Estimate Review' },
    { id: 'supplement_filed', label: 'Supplement Filed' },
    { id: 'approved', label: 'Approved' },
    { id: 'work_scheduled', label: 'Work Scheduled' },
    { id: 'completed', label: 'Completed' },
    { id: 'denied', label: 'Denied' }
  ];

  // Document requirements per stage
  const STAGE_CHECKLISTS = {
    initial_inspection: [
      'Damage photos',
      'Measurements',
      'Initial assessment'
    ],
    documentation: [
      'Close-up damage photos',
      'Wide-angle photos',
      'Written damage report'
    ],
    claim_filed: [
      'Claim number',
      'Carrier name',
      'Policy number',
      'Date filed'
    ],
    adjuster_scheduled: [
      'Adjuster name',
      'Date/time scheduled',
      'Contact information'
    ],
    adjuster_visit: [
      'Adjuster photos',
      'Adjuster estimate',
      'Scope of work'
    ],
    estimate_review: [
      'Contractor estimate',
      'Variance analysis'
    ],
    supplement_filed: [
      'Supplement documents',
      'Additional damage found',
      'Updated estimate'
    ],
    approved: [
      'Approval letter',
      'Approved amount',
      'Deductible amount'
    ],
    work_scheduled: [
      'Scheduled date',
      'Work scope confirmed'
    ],
    completed: [
      'Final inspection passed',
      'Insurance paperwork signed',
      'Payment received'
    ],
    denied: [
      'Denial letter',
      'Denial reason',
      'Appeal strategy (if applicable)'
    ]
  };

  /**
   * Get current claim status, progress, and next actions
   * @param {Object} lead - Lead document object
   * @returns {Object} Status object with stage, progress percentage, next actions
   */
  function getClaimStatus(lead) {
    const claimHistory = lead.claimHistory || [];
    const currentStageId = lead.claimStage || CLAIM_STAGES[0].id;
    const currentIndex = CLAIM_STAGES.findIndex(s => s.id === currentStageId);
    const progress = ((currentIndex + 1) / CLAIM_STAGES.length) * 100;

    const currentStage = CLAIM_STAGES[currentIndex] || CLAIM_STAGES[0];
    const nextStage = currentIndex < CLAIM_STAGES.length - 1
      ? CLAIM_STAGES[currentIndex + 1]
      : null;

    const checklist = STAGE_CHECKLISTS[currentStageId] || [];
    const completedItems = lead[`checklist_${currentStageId}`] || [];
    const checklistProgress = checklist.length > 0
      ? (completedItems.length / checklist.length) * 100
      : 0;

    return {
      currentStage: currentStage.label,
      currentStageId,
      progress,
      nextStage: nextStage ? nextStage.label : 'Complete',
      checklistProgress,
      claimNumber: lead.claimNumber,
      // The dashboard lead modal writes insCarrier / deductibleOrOwedByHO;
      // older widget-written docs used insuranceCarrier / deductible.
      // Read both so the widget stops showing blanks for modal-entered data.
      insuranceCarrier: lead.insCarrier || lead.insuranceCarrier,
      approvedAmount: lead.approvedAmount,
      deductible: (lead.deductibleOrOwedByHO != null && lead.deductibleOrOwedByHO !== '')
        ? lead.deductibleOrOwedByHO : lead.deductible,
      // Set in the Claim Details editor (claim-core.js), 2026-09-29.
      adjusterMeetingDate: lead.adjusterMeetingDate || '',
      adjusterMeetingStart: lead.adjusterMeetingStart || '',
      history: claimHistory
    };
  }

  /**
   * Advance to next claim stage with optional notes
   * @param {string} leadId - Lead document ID
   * @param {string} notes - Stage transition notes
   * @returns {Promise} Resolves when Firestore update completes
   */
  async function advanceClaimStage(leadId, notes = '') {
    try {
      const leadDocRef = window.doc(window.db, 'leads', leadId);
      const leadSnap = await window.getDoc(leadDocRef);

      if (!leadSnap.exists()) {
        console.error('Lead not found:', leadId);
        return false;
      }

      const lead = leadSnap.data();
      const currentIndex = CLAIM_STAGES.findIndex(
        s => s.id === (lead.claimStage || CLAIM_STAGES[0].id)
      );

      if (currentIndex >= CLAIM_STAGES.length - 1) {
        console.warn('Claim already at final stage');
        return false;
      }

      const nextStageId = CLAIM_STAGES[currentIndex + 1].id;
      const historyEntry = {
        stage: nextStageId,
        timestamp: new Date().toISOString(),
        notes: notes,
        completedAt: new Date()
      };

      // Keep the coarse 7-value claimStatus (lead modal dropdown) in sync
      // with the fine-grained 11-stage workflow. The old hardcoded
      // 'in_progress' wasn't one of the dropdown's values, so advancing
      // the workflow corrupted the status everywhere else. When ClaimCore
      // isn't loaded, write no status at all rather than a bad one.
      const syncedStatus = (window.ClaimCore && window.ClaimCore.claimStatusFromStage)
        ? window.ClaimCore.claimStatusFromStage(nextStageId) : null;
      await window.updateDoc(leadDocRef, {
        claimStage: nextStageId,
        ...(syncedStatus ? { claimStatus: syncedStatus } : {}),
        claimHistory: window.arrayUnion(historyEntry),
        [`checklist_${nextStageId}`]: []
      });

      return true;
    } catch (error) {
      console.error('Error advancing claim stage:', error);
      return false;
    }
  }

  const _BOX = 'background: var(--s,#12223D); border: 1px solid var(--br,rgba(255,255,255,.08)); border-radius: 8px; padding: 12px 16px; font-size: 13px;';

  /**
   * A cash / finance / service / warranty job with a claim on file (e.g.
   * denied, then paid cash): one read-only line — no workflow, no Advance.
   */
  function _claimSummaryLine(lead, status) {
    const S = (window.NBDJurisdiction && window.NBDJurisdiction.claimSignals) ? window.NBDJurisdiction.claimSignals(lead) : {};
    const stageLabel = (CLAIM_STAGES.find((s) => s.id === S.claimStage) || {}).label || '';
    const parts = [S.claimStatus || stageLabel, S.claimNumber ? '#' + S.claimNumber : '', S.carrier || status.insuranceCarrier || ''].filter(Boolean);
    return '<div class="claim-summary-line" style="' + _BOX + ' color: var(--m,#9ca3af);">' +
      '<strong style="color: var(--t);">Claim on file:</strong> ' + _icEsc(parts.join(' · ') || 'yes') +
      ' <span style="opacity:.8;">— this is a ' + _icEsc(String(lead.jobType || '').toLowerCase()) + ' job, so the claim workflow is hidden.</span></div>';
  }

  /**
   * No job type and nothing that points at a claim: ask, instead of showing
   * an 11-step insurance workflow that may not apply. One tap sets the type
   * (viewers see the question without the buttons).
   */
  function _jobTypePrompt(leadId) {
    const viewer = !!(window.NBDRole && typeof window.NBDRole.isViewer === 'function' && window.NBDRole.isViewer());
    const types = [['insurance', 'Insurance'], ['cash', 'Cash'], ['finance', 'Finance'], ['service', 'Service'], ['warranty', 'Warranty']];
    const btn = 'border: 1px solid var(--br,rgba(255,255,255,.15)); background: transparent; color: var(--t); border-radius: 999px; padding: 10px 16px; min-height: 44px; font-size: 13px; cursor: pointer;';
    return '<div class="claim-type-prompt" style="' + _BOX + '">' +
      '<div style="color: var(--t); font-weight: 600; margin-bottom: ' + (viewer ? '0' : '10px') + ';">Insurance job? <span style="color: var(--m,#9ca3af); font-weight: 400;">The job type isn\'t set.</span></div>' +
      (viewer ? '' : '<div style="display: flex; flex-wrap: wrap; gap: 8px;">' + types.map(([v, l]) =>
        '<button type="button" data-ic-action="settype" data-ic-id="' + _icEsc(leadId) + '" data-ic-type="' + v + '" style="' + btn + '">' + l + '</button>').join('') + '</div>') +
      '</div>';
  }

  /** Set a lead's job type from the prompt, then re-decide the panel. */
  async function setJobType(leadId, jobType) {
    const K = window.NBDJurisdiction;
    const jt = K && K.normJobType ? K.normJobType(jobType) : '';
    if (!jt) return false;
    if (window.NBDRole && typeof window.NBDRole.guard === 'function' && !window.NBDRole.guard()) return false;
    await window.updateDoc(window.doc(window.db, 'leads', leadId), { jobType: jt, updatedAt: window.serverTimestamp() });
    // The page's in-memory copy, so other panels read the new type without a reload.
    const cur = window._currentLead;
    if (cur && (cur.id === leadId || cur.leadId === leadId)) cur.jobType = jt;
    return true;
  }

  /**
   * Render visual claim workflow UI
   * @param {string} containerId - HTML element ID for rendering
   * @param {string} leadId - Lead document ID
   */
  async function renderClaimWorkflow(containerId, leadId) {
    const container = document.getElementById(containerId);
    if (!container) {
      console.error('Container not found:', containerId);
      return;
    }

    try {
      const leadSnap = await window.getDoc(window.doc(window.db, 'leads', leadId));
      if (!leadSnap.exists()) {
        console.error('Lead not found:', leadId);
        return;
      }

      const lead = leadSnap.data();
      const status = getClaimStatus(lead);
      // Which panel this job gets (Jo, 2026-09-30) — the shared check in
      // ky-insurance-law.js claimPanelMode. It used to render the full 11-step
      // workflow on EVERY customer: 160 of 166 live ones were cash / service /
      // untyped and read "Step 1 of 11, Initial Inspection". Without the
      // module, the old full panel (never a hidden one by accident).
      const K = window.NBDJurisdiction;
      const mode = (K && typeof K.claimPanelMode === 'function') ? K.claimPanelMode(lead) : 'full';
      container.hidden = (mode === 'hidden');
      if (mode === 'hidden') { container.innerHTML = ''; return; }
      if (mode === 'summary') { container.innerHTML = _claimSummaryLine(lead, status); return; }
      if (mode === 'prompt') { container.innerHTML = _jobTypePrompt(leadId); return; }
      const currentIndex = CLAIM_STAGES.findIndex(s => s.id === status.currentStageId);
      // "Tue, Oct 6 · 10:00 am" — schedule-window.js loads before this file;
      // the raw values if it did not. Escaped at the sink below either way.
      const _SW = window.NBDScheduleWindow;
      const meeting = status.adjusterMeetingDate
        ? ((_SW && _SW.formatWindow && _SW.formatWindow({ scheduledDate: status.adjusterMeetingDate, scheduledStart: status.adjusterMeetingStart || null }))
          || (status.adjusterMeetingDate + (status.adjusterMeetingStart ? ' ' + status.adjusterMeetingStart : '')))
        : '';

      // .claim-stages is a read-only progress list, not buttons (2026-09-25
      // phone audit). The 11 stages rendered as filled, rounded,
      // cursor:pointer chips with no handler at all, so a rep tapping
      // "Denied" or "Claim Filed" got nothing — only "Advance to…" below
      // moves the stage. They now read as status, not controls: no pointer,
      // no fill on pending steps, the current one carries aria-current.
      // Denser too: at 360 the old grid was 11 full-width 40px tiles, 560px.
      const html = `
        <div class="claim-workflow" style="background: var(--s,#12223D); border: 1px solid var(--br,rgba(255,255,255,.08)); border-radius: 8px; padding: 20px;">
          <h3 style="color: var(--t); margin: 0 0 20px 0; font-size: 18px; font-weight: 600;">Insurance Claim Progress</h3>

          <div class="claim-progress-bar" style="background: rgba(255,255,255,.05); height: 8px; border-radius: 4px; margin-bottom: 24px; overflow: hidden;">
            <div style="background: var(--orange,#BD5728); height: 100%; width: ${status.progress}%; transition: width 0.3s ease;"></div>
          </div>

          <div class="claim-stages" role="list" aria-label="Claim stages" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 6px; margin-bottom: 24px;">
            ${CLAIM_STAGES.map((stage, idx) => {
              const isCompleted = idx < currentIndex;
              const isCurrent = idx === currentIndex;
              const look = isCompleted
                ? 'background: rgba(16,185,129,.12); color: #10b981; border: 1px solid transparent;'
                : isCurrent
                  ? 'background: rgba(189,87,40,.16); color: var(--t); border: 1px solid #BD5728; font-weight: 700;'
                  : 'background: transparent; color: var(--m,#9ca3af); border: 1px solid transparent;';
              const mark = isCompleted ? '✓' : isCurrent ? '●' : '○';

              return `
                <div role="listitem"${isCurrent ? ' aria-current="step"' : ''} style="
                  ${look}
                  border-radius: 6px;
                  padding: 6px 8px;
                  display: flex;
                  align-items: center;
                  gap: 6px;
                  cursor: default;
                  font-size: 12px;
                  line-height: 1.25;
                ">
                  <span aria-hidden="true" style="flex: 0 0 auto; font-size: 11px;">${mark}</span>
                  <span style="word-break: break-word;">${stage.label}</span>
                </div>
              `;
            }).join('')}
          </div>

          <div class="claim-current-stage" style="background: rgba(255,255,255,.02); border-radius: 8px; padding: 16px; margin-bottom: 16px; border: 1px solid var(--br,rgba(255,255,255,.08));">
            <div style="color: var(--m,#9ca3af); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">Current Stage</div>
            <div style="color: var(--t); font-size: 18px; font-weight: 600; margin-bottom: 12px;">${status.currentStage}</div>
            <div style="color: var(--m,#9ca3af); font-size: 13px; line-height: 1.5;">
              ${status.nextStage !== 'Complete'
                ? `<strong>Next:</strong> ${status.nextStage}`
                : '<strong style="color: #10b981;">Workflow Complete</strong>'}
            </div>
          </div>

          <div class="claim-details" style="background: rgba(255,255,255,.02); border-radius: 8px; padding: 16px; margin-bottom: 16px; border: 1px solid var(--br,rgba(255,255,255,.08)); font-size: 13px;">
            ${status.claimNumber ? `<div style="color: var(--m,#9ca3af); margin-bottom: 8px;"><strong style="color: var(--t);">Claim #:</strong> ${_icEsc(status.claimNumber)}</div>` : ''}
            ${status.insuranceCarrier ? `<div style="color: var(--m,#9ca3af); margin-bottom: 8px;"><strong style="color: var(--t);">Carrier:</strong> ${_icEsc(status.insuranceCarrier)}</div>` : ''}
            ${meeting ? `<div style="color: var(--m,#9ca3af); margin-bottom: 8px;"><strong style="color: var(--t);">Adjuster meeting:</strong> ${_icEsc(meeting)}</div>` : ''}
            ${status.approvedAmount ? `<div style="color: var(--m,#9ca3af);"><strong style="color: var(--t);">Approved:</strong> $${status.approvedAmount.toLocaleString()}</div>` : ''}
          </div>

          <div class="claim-actions">
            <textarea
              id="claim-notes-${leadId}"
              placeholder="Add notes for stage transition..."
              style="
                width: 100%;
                background: rgba(255,255,255,.05);
                border: 1px solid var(--br,rgba(255,255,255,.08));
                border-radius: 6px;
                color: var(--t);
                padding: 10px;
                font-size: 13px;
                font-family: inherit;
                margin-bottom: 12px;
                resize: vertical;
                min-height: 60px;
              "
            ></textarea>
            <button
              data-ic-action="advance" data-ic-id="${leadId}" data-ic-next="${status.nextStage}"
              style="
                background: var(--orange,#BD5728);
                color: white;
                border: none;
                border-radius: 6px;
                padding: 12px 16px;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                transition: background 0.2s ease;
                width: 100%;
              "
            >
              ${status.nextStage !== 'Complete' ? 'Advance to ' + status.nextStage : 'Workflow Complete'}
            </button>
          </div>
        </div>
      `;

      container.innerHTML = html;
    } catch (error) {
      console.error('Error rendering claim workflow:', error);
      container.innerHTML = '<div style="color: #ef4444; padding: 16px;">Error loading claim workflow</div>';
    }
  }

  /**
   * Render document checklist for current claim stage
   * @param {string} containerId - HTML element ID for rendering
   * @param {string} leadId - Lead document ID
   */
  async function renderClaimChecklist(containerId, leadId) {
    const container = document.getElementById(containerId);
    if (!container) {
      console.error('Container not found:', containerId);
      return;
    }

    try {
      const leadSnap = await window.getDoc(window.doc(window.db, 'leads', leadId));
      if (!leadSnap.exists()) {
        console.error('Lead not found:', leadId);
        return;
      }

      const lead = leadSnap.data();
      const currentStageId = lead.claimStage || CLAIM_STAGES[0].id;
      const checklist = STAGE_CHECKLISTS[currentStageId] || [];
      const completed = lead[`checklist_${currentStageId}`] || [];

      const checklistHtml = checklist.map((item, idx) => {
        const isChecked = completed.includes(item);
        return `
          <div style="display: flex; align-items: center; padding: 12px; border-bottom: 1px solid var(--br,rgba(255,255,255,.08)); gap: 12px;">
            <input
              type="checkbox"
              ${isChecked ? 'checked' : ''}
              data-ic-check="1" data-ic-lead="${leadId}" data-ic-stage="${currentStageId}" data-ic-item="${String(item).replace(/&/g,'&amp;').replace(/"/g,'&quot;')}"
              style="cursor: pointer; width: 16px; height: 16px;"
            >
            <label style="flex: 1; color: ${isChecked ? 'var(--m,#9ca3af)' : 'var(--t)'}; text-decoration: ${isChecked ? 'line-through' : 'none'}; cursor: pointer;">
              ${item}
            </label>
          </div>
        `;
      }).join('');

      const html = `
        <div class="claim-checklist" style="background: var(--s,#12223D); border: 1px solid var(--br,rgba(255,255,255,.08)); border-radius: 8px; overflow: hidden;">
          <div style="background: rgba(255,255,255,.02); padding: 16px; border-bottom: 1px solid var(--br,rgba(255,255,255,.08));">
            <h3 style="color: var(--t); margin: 0 0 8px 0; font-size: 16px; font-weight: 600;">
              ${CLAIM_STAGES.find(s => s.id === currentStageId)?.label || 'Checklist'} Documents
            </h3>
            <div style="color: var(--m,#9ca3af); font-size: 12px;">
              ${completed.length} of ${checklist.length} items complete
            </div>
          </div>
          <div>
            ${checklistHtml || '<div style="padding: 16px; color: var(--m,#9ca3af);">No items for this stage</div>'}
          </div>
        </div>
      `;

      container.innerHTML = html;
    } catch (error) {
      console.error('Error rendering checklist:', error);
      container.innerHTML = '<div style="color: #ef4444; padding: 16px;">Error loading checklist</div>';
    }
  }

  /**
   * Update checklist item completion status
   * @param {string} leadId - Lead document ID
   * @param {string} stageId - Stage ID
   * @param {string} item - Checklist item text
   * @param {boolean} isChecked - Completion status
   */
  async function updateChecklistItem(leadId, stageId, item, isChecked) {
    try {
      const leadDocRef = window.doc(window.db, 'leads', leadId);
      const fieldName = `checklist_${stageId}`;

      if (isChecked) {
        await window.updateDoc(leadDocRef, {
          [fieldName]: window.arrayUnion(item)
        });
      } else {
        await window.updateDoc(leadDocRef, {
          [fieldName]: window.arrayRemove(item)
        });
      }
    } catch (error) {
      console.error('Error updating checklist:', error);
    }
  }

  /**
   * Get compact claim summary HTML for kanban cards
   * @param {Object} lead - Lead document object
   * @returns {string} HTML badge/summary
   */
  function getClaimSummaryHTML(lead) {
    const status = getClaimStatus(lead);
    const stageColor = status.currentStageId === 'denied' ? '#ef4444' :
                       status.currentStageId === 'approved' ? '#10b981' :
                       status.currentStageId === 'completed' ? '#10b981' :
                       '#BD5728';

    return `
      <div style="
        background: rgba(255,255,255,.05);
        border-left: 3px solid ${stageColor};
        border-radius: 4px;
        padding: 8px 12px;
        margin-top: 8px;
        font-size: 12px;
      ">
        <div style="color: var(--m,#9ca3af); margin-bottom: 4px;">Insurance Claim</div>
        <div style="color: var(--t); font-weight: 600; margin-bottom: 4px;">${status.currentStage}</div>
        ${status.claimNumber ? `<div style="color: var(--m,#9ca3af);">Claim #${_icEsc(status.claimNumber)}</div>` : ''}
      </div>
    `;
  }

  // Export public API
  window.InsuranceClaim = {
    CLAIM_STAGES,
    STAGE_CHECKLISTS,
    getClaimStatus,
    advanceClaimStage,
    renderClaimWorkflow,
    renderClaimChecklist,
    updateChecklistItem,
    getClaimSummaryHTML,
    setJobType
  };

})();

// Advance: disabled while the write is in flight (a double tap on a phone
// advanced the claim TWICE — there is no way back), then a toast either
// way (2026-09-25: it was silent, so the only feedback was the tiles
// repainting somewhere above the button).
// "Insurance job?" prompt (2026-09-30): one tap sets the job type, then the
// panel re-decides (an Insurance tap opens the full workflow in place).
(function () {
  if (window.__NBD_IC_SETTYPE) return;
  window.__NBD_IC_SETTYPE = true;
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest && ev.target.closest('[data-ic-action="settype"]');
    if (!t || t.disabled || !window.InsuranceClaim) return;
    var box = t.closest('.claim-type-prompt');
    var btns = box ? box.querySelectorAll('button') : [t];
    Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
    var leadId = t.dataset.icId, type = t.dataset.icType;
    window.InsuranceClaim.setJobType(leadId, type).then(function (ok) {
      if (ok) {
        if (typeof window.showToast === 'function') window.showToast('Job type set: ' + t.textContent, 'success');
        window.InsuranceClaim.renderClaimWorkflow('insuranceClaimWorkflow', leadId);
      } else {
        Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
      }
    }).catch(function () {
      Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
      if (typeof window.showToast === 'function') window.showToast('Could not set the job type', 'error');
    });
  });
})();

(function(){if(_NBD_IC_DELEGATE)return;_NBD_IC_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-ic-action]');if(!t)return;if(t.dataset.icAction==='advance'&&window.InsuranceClaim&&window.InsuranceClaim.advanceClaimStage){if(t.disabled)return;t.disabled=true;var leadId=t.dataset.icId;var next=t.dataset.icNext||'';var notesEl=document.getElementById('claim-notes-'+leadId);var notes=notesEl?notesEl.value.trim():'';window.InsuranceClaim.advanceClaimStage(leadId,notes).then(function(ok){t.disabled=false;if(ok&&window.InsuranceClaim&&window.InsuranceClaim.renderClaimWorkflow)window.InsuranceClaim.renderClaimWorkflow('insuranceClaimWorkflow',leadId);if(ok&&window.ClaimPanel&&window.ClaimPanel.refresh)window.ClaimPanel.refresh();if(typeof window.showToast==='function'){if(ok)window.showToast('Claim moved to '+(next||'the next stage'),'success');else window.showToast('Could not advance the claim','error');}});}});document.addEventListener('change',function(ev){var c=ev.target.closest&&ev.target.closest('[data-ic-check]');if(!c)return;if(window.InsuranceClaim&&window.InsuranceClaim.updateChecklistItem){window.InsuranceClaim.updateChecklistItem(c.dataset.icLead,c.dataset.icStage,c.dataset.icItem,c.checked);}});})();
