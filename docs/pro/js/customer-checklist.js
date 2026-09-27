/* ══════════════════════════════════════════════════════════════════════
   customer-checklist.js — persisted per-job workflow checklist
   (RoofLink "View Checklist" parity).

   The stage-based next-action chips (crm-stages.js) are transient
   suggestions — nothing stored a job-level check-off state. This panel
   renders a jobType-appropriate checklist on customer.html and persists
   ticks as a flat map on the lead doc:

     lead.jobChecklist = { 'ins-inspect': true, 'ins-file-claim': true, … }

   CSP contract: checkboxes carry data-change-action="toggleJobChecklistItem"
   + data-arg="<key>" + data-pass-el="true" and ride customer-tasks-ui.js's
   existing change delegate → window.toggleJobChecklistItem(key, el).
   Item keys are stable slugs (safe as Firestore map keys + dot paths).

   2026-09-15 (Paperwork Filing): items carrying `gateField` are backed by a
   REAL lead field — the same *FiledAt scalar REQUIRED_FIELDS_BY_TYPE
   (crm-stages.js) hard-blocks a stage advance on — instead of the flat
   self-reported jobChecklist boolean every other row uses. Auto-derived
   fields (contract/AOB/warranty-cert/COC — stamped the moment the real
   document is e-signed or generated, see document-generator.js's
   onPersistFinalized and warranty-cert.js's _persistWarrantyToLead) render
   READ-ONLY: a rep can never tick "Sign contract" with nothing behind it,
   because there's nothing to tick — only `manual: true` (Permit, which has
   no in-app signer to hook) stays an interactive checkbox, routed through
   paperwork-write.js's commitPaperworkFiled() instead of a bare
   jobChecklist.<key> write.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.JobChecklist) return; // single owner

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };

  // Stable keys — NEVER rename one (renames orphan saved ticks).
  var CHECKLISTS = {
    insurance: [
      { key: 'ins-inspect',      label: 'Inspect roof & document damage' },
      { key: 'ins-photos',       label: 'Capture photo set (Before)' },
      { key: 'ins-file-claim',   label: 'File claim with carrier' },
      { key: 'ins-adjuster',     label: 'Meet adjuster on site' },
      { key: 'ins-scope',        label: 'Receive carrier scope / approval' },
      // Key kept (renames orphan saved ticks); the document is now the
      // Direction to Pay, which stamps the same aobFiledAt field (2026-09-27).
      { key: 'ins-aob',          label: 'Direction to Pay signed',        gateField: 'aobFiledAt' },
      { key: 'ins-estimate',     label: 'Build & send estimate' },
      { key: 'ins-contract',     label: 'Sign contract',                 gateField: 'contractFiledAt' },
      { key: 'ins-permit',       label: 'Permit filed',                  gateField: 'permitFiledAt', manual: true },
      { key: 'ins-materials',    label: 'Order materials' },
      { key: 'ins-install',      label: 'Install & photo (During / After)' },
      { key: 'ins-supplement',   label: 'File supplement (if needed)' },
      { key: 'ins-invoice',      label: 'Final invoice & COC to carrier', gateField: 'cocFiledAt' },
      { key: 'ins-collect',      label: 'Collect deductible + final payment' },
      { key: 'ins-warranty-cert',label: 'Warranty certificate filed',     gateField: 'warrantyCertFiledAt' }
    ],
    default: [
      { key: 'job-inspect',      label: 'Inspect & photo document' },
      { key: 'job-estimate',     label: 'Build & send estimate' },
      { key: 'job-follow-up',    label: 'Follow up on estimate' },
      { key: 'job-contract',     label: 'Sign contract',                 gateField: 'contractFiledAt' },
      { key: 'job-permit',       label: 'Permit filed',                  gateField: 'permitFiledAt', manual: true },
      { key: 'job-materials',    label: 'Order materials' },
      { key: 'job-schedule',     label: 'Schedule crew' },
      { key: 'job-install',      label: 'Install & photo (During / After)' },
      { key: 'job-walkthrough',  label: 'Final walkthrough' },
      { key: 'job-collect',      label: 'Collect final payment' },
      { key: 'job-review',       label: 'Request a review' }
    ]
  };

  function itemsFor(lead) {
    return (lead && lead.jobType === 'insurance') ? CHECKLISTS.insurance : CHECKLISTS.default;
  }

  // Checked state for one item — a gateField item reads the REAL lead
  // field (the same one REQUIRED_FIELDS_BY_TYPE gates on); every other item
  // reads the flat self-reported jobChecklist map, as before.
  function isChecked(item, lead, state) {
    return item.gateField ? !!lead[item.gateField] : !!state[item.key];
  }

  function render(lead) {
    var panel = document.getElementById('checklistPanel');
    if (!panel) return;
    lead = lead || window._currentLead || {};
    var items = itemsFor(lead);
    var state = lead.jobChecklist || {};
    var done = items.filter(function (i) { return isChecked(i, lead, state); }).length;
    var pct = items.length ? Math.round((done / items.length) * 100) : 0;

    var rows = items.map(function (i) {
      var checked = isChecked(i, lead, state);
      // Auto-derived gate fields (contract/AOB/warranty-cert/COC — stamped by
      // a real signing/generation event) render READ-ONLY: a rep can never
      // tick "Sign contract" with nothing behind it, because there's nothing
      // to tick. Only `manual: true` (Permit — no in-app signer to hook)
      // stays interactive.
      var readOnly = !!i.gateField && !i.manual;
      var inputAttrs = readOnly
        ? (checked ? ' checked' : '') + ' disabled'
        : (checked ? ' checked' : '') + ' data-change-action="toggleJobChecklistItem" data-arg="' + esc(i.key) + '" data-pass-el="true"';
      // Padding widens the tap area (it measured 57x13 on a phone); the
      // matching negative margin keeps the checklist row the same height.
      var generateLink = (readOnly && !checked)
        ? ' <a href="#documentsTab" style="display:inline-block;font-size:11px;color:var(--orange,#BD5728);text-decoration:underline;padding:10px 6px;margin:-10px 0 -10px 0;">Generate&nbsp;&rarr;</a>'
        : '';
      return '<label style="display:flex;align-items:center;gap:10px;padding:8px 4px;border-top:1px solid var(--br,rgba(255,255,255,.06));cursor:' + (readOnly ? 'default' : 'pointer') + ';">' +
        '<input type="checkbox"' + inputAttrs +
          ' style="width:16px;height:16px;' + (readOnly ? 'cursor:default;' : 'cursor:pointer;') + 'flex:0 0 auto;accent-color:var(--orange,#BD5728);">' +
        '<span style="flex:1;font-size:13px;color:' + (checked ? 'var(--m,#9ca3af)' : 'var(--t)') + ';' +
          (checked ? 'text-decoration:line-through;' : '') + '">' + esc(i.label) + generateLink + '</span>' +
        '</label>';
    }).join('');

    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
        '<div class="panel-title" style="margin:0;">Job Checklist</div>' +
        '<span style="font-size:12px;color:var(--m,#9ca3af);font-weight:700;">' + done + ' of ' + items.length + '</span>' +
      '</div>' +
      '<div style="background:rgba(255,255,255,.06);height:6px;border-radius:3px;overflow:hidden;margin-bottom:6px;">' +
        '<div style="background:var(--orange,#BD5728);height:100%;width:' + pct + '%;transition:width .25s ease;"></div>' +
      '</div>' +
      rows;
    panel.style.display = 'block';
  }

  // data-change-action handler — el is the checkbox (data-pass-el).
  window.toggleJobChecklistItem = async function (key, el) {
    if (!key || !window._customerId) return;
    var checked = !!(el && el.checked);
    var lead = window._currentLead || {};
    var item = itemsFor(lead).filter(function (i) { return i.key === key; })[0];

    // manual gateField items (Permit) write through paperwork-write.js's
    // shared chokepoint, not the flat jobChecklist boolean — this IS the
    // real *FiledAt field REQUIRED_FIELDS_BY_TYPE gates a stage advance on,
    // so the Kanban's own "Mark Permit Filed" chip and this checkbox must
    // never drift on write shape.
    if (item && item.manual && item.gateField) {
      if (!(window.PaperworkWrite && typeof window.PaperworkWrite.commitPaperworkFiled === 'function')) {
        if (el) el.checked = !checked;
        if (typeof window.showToast === 'function') window.showToast('Could not save — try again', 'error');
        return;
      }
      try {
        var stamp = await window.PaperworkWrite.commitPaperworkFiled(window._customerId, item.gateField, checked);
        lead[item.gateField] = stamp;
        render(lead);
      } catch (e) {
        console.error('Checklist toggle (paperwork field) failed:', e);
        if (el) el.checked = !checked;
        if (typeof window.showToast === 'function') window.showToast('Could not save checklist — try again', 'error');
      }
      return;
    }

    try {
      var update = { updatedAt: new Date() };
      update['jobChecklist.' + key] = checked;
      await window.updateDoc(window.doc(window.db, 'leads', window._customerId), update);
      lead.jobChecklist = lead.jobChecklist || {};
      lead.jobChecklist[key] = checked;
      render(lead); // repaint strike-through + progress bar
    } catch (e) {
      console.error('Checklist toggle failed:', e);
      if (el) el.checked = !checked; // revert the optimistic flip
      if (typeof window.showToast === 'function') {
        window.showToast('Could not save checklist — try again', 'error');
      }
    }
  };

  window.JobChecklist = { render: render, CHECKLISTS: CHECKLISTS };

  // Late-load self-render (defer order races the bootstrap module).
  if (window._currentLead && document.getElementById('checklistPanel')) {
    try { render(window._currentLead); } catch (e) {}
  }
})();
