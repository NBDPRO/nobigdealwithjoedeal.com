/* ══════════════════════════════════════════════════════════════════════
   claim-core.js — ONE canonical view of an insurance claim.

   Claim data historically lived in four unsynchronized layers:
     1. Flat lead-doc fields written by the dashboard lead modal
        (claimStatus, insCarrier, claimNumber, policyNumber, dateOfLoss,
        deductibleOrOwedByHO, supplementStatus, scopeOfWork…)
     2. insurance-claim.js — the 11-stage claimStage workflow, which read
        DIFFERENT names (insuranceCarrier, deductible) and wrote
        claimStatus:'in_progress' (not one of the 7 dropdown values).
     3. The pipeline insurance track (lead.stage) — untouched here.
     4. estimate docs' claim object ({carrier, number, adjuster, …}).

   This module is the arbiter for (1)+(2)+(4):
     • ClaimCore.normalizeClaim(lead) — canonical read view resolving all
       legacy field-name variants.
     • ClaimCore.claimStatusFromStage(stageId) — maps the 11 workflow
       stages onto the 7 claimStatus values so advancing the workflow
       keeps the coarse status in sync (insurance-claim.js calls this).
     • ClaimPanel.render(containerId, lead) — the RoofLink-style Claim
       Details panel on customer.html: deductible hero, status chip,
       claim facts grid, and tap-to-call contact slots for Adjuster /
       Claim Handler / Mortgage Company.
     • openClaimEditor / saveClaimEdits / closeClaimEditor — the editor
       modal (canonical nbdModal .modal-bg pair, CSP-safe: zero inline
       handlers; buttons ride customer.html's generic data-action
       delegate which resolves window[fnName]).

   Contact fields are stored FLAT on the lead doc (adjusterName /
   adjusterPhone / adjusterEmail are already declared in types.js;
   claimHandler* / mortgageCompany* follow the same convention) so the
   lead modal, rules, and exports keep working with plain field paths.
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.ClaimCore) return; // single owner

  var esc = window.nbdEsc || function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };

  // The 7 canonical claimStatus values (dashboard.html #lClaimStatus).
  var STATUS_VALUES = ['No Claim', 'Claim Filed', 'Adjuster Scheduled', 'Approved', 'Supplementing', 'Paid Out', 'Denied'];

  // 11 workflow stages (insurance-claim.js CLAIM_STAGES) → coarse status.
  // initial_inspection/documentation are pre-filing legwork, so the claim
  // itself is still "No Claim".
  var STAGE_TO_STATUS = {
    initial_inspection: 'No Claim',
    documentation:      'No Claim',
    claim_filed:        'Claim Filed',
    adjuster_scheduled: 'Adjuster Scheduled',
    adjuster_visit:     'Adjuster Scheduled',
    estimate_review:    'Adjuster Scheduled',
    supplement_filed:   'Supplementing',
    approved:           'Approved',
    work_scheduled:     'Approved',
    completed:          'Paid Out',
    denied:             'Denied'
  };

  var STATUS_COLORS = {
    'No Claim':           '#9ca3af',
    'Claim Filed':        '#3b82f6',
    'Adjuster Scheduled': '#a78bfa',
    'Approved':           '#10b981',
    'Supplementing':      '#BD5728',
    'Paid Out':           '#10b981',
    'Denied':             '#ef4444'
  };

  function claimStatusFromStage(stageId) {
    return STAGE_TO_STATUS[stageId] || null;
  }

  // Canonical read view. Resolves every legacy variant so callers stop
  // caring which surface wrote the field.
  function normalizeClaim(lead) {
    lead = lead || {};
    // Status: prefer a valid claimStatus; a corrupted value (the old
    // 'in_progress' write) falls back to the stage mapping.
    var status = lead.claimStatus;
    if (STATUS_VALUES.indexOf(status) === -1) {
      status = (lead.claimStage && STAGE_TO_STATUS[lead.claimStage]) || 'No Claim';
    }
    return {
      status: status,
      stage: lead.claimStage || null,
      number: lead.claimNumber || '',
      carrier: lead.insCarrier || lead.insuranceCarrier || lead.carrier || '',
      filedBy: lead.claimFiledBy || '',
      policyNumber: lead.policyNumber || '',
      policyHolder: lead.policyHolder || '',
      dateOfLoss: lead.dateOfLoss || '',
      dateDiscovered: lead.dateDiscovered || '',
      typeOfLoss: lead.damageType || '',
      deductible: (lead.deductibleOrOwedByHO != null && lead.deductibleOrOwedByHO !== '') ? Number(lead.deductibleOrOwedByHO)
                : (lead.deductible != null ? Number(lead.deductible) : null),
      estimateAmount: (lead.estimateAmount != null && lead.estimateAmount !== '') ? Number(lead.estimateAmount) : null,
      approvedAmount: (lead.approvedAmount != null && lead.approvedAmount !== '') ? Number(lead.approvedAmount) : null,
      supplementStatus: lead.supplementStatus || '',
      scopeOfWork: lead.scopeOfWork || '',
      adjuster:        { name: lead.adjusterName || '',     phone: lead.adjusterPhone || '',     email: lead.adjusterEmail || '' },
      // The adjuster's inspection (2026-09-29): 'YYYY-MM-DD' + optional 'HH:MM'
      // America/New_York, same shape as scheduledDate/scheduledStart. Feeds the
      // Schedule view (smart-calendar.js) and the .ics feed.
      adjusterMeeting: { date: lead.adjusterMeetingDate || '', start: lead.adjusterMeetingStart || '' },
      claimHandler:    { name: lead.claimHandlerName || '', phone: lead.claimHandlerPhone || '', email: lead.claimHandlerEmail || '' },
      mortgageCompany: { name: lead.mortgageCompanyName || '', phone: lead.mortgageCompanyPhone || '', email: '' }
    };
  }

  window.ClaimCore = {
    STATUS_VALUES: STATUS_VALUES,
    STAGE_TO_STATUS: STAGE_TO_STATUS,
    STATUS_COLORS: STATUS_COLORS,
    claimStatusFromStage: claimStatusFromStage,
    normalizeClaim: normalizeClaim
  };

  /* ── Claim Details panel (customer.html #insurancePanel) ─────────── */

  function money(n) {
    return (n == null || isNaN(n)) ? '—' : '$' + Number(n).toLocaleString();
  }
  function dt(s) { return s ? esc(s) : '—'; }

  // "Tue, Oct 6 · 10:00 am" via schedule-window.js when it is loaded (both
  // pages load it); the raw values otherwise. Returned ESCAPED — the date and
  // time are rep-typed fields on the lead doc.
  function meetingLabel(m) {
    if (!m || !m.date) return '';
    var W = window.NBDScheduleWindow;
    var t = W && W.formatWindow ? W.formatWindow({ scheduledDate: m.date, scheduledStart: m.start || null }) : '';
    return esc(t || (m.date + (m.start ? ' ' + m.start : '')));
  }

  function factCell(label, value) {
    return '<div class="info-item"><div class="info-label">' + esc(label) + '</div>' +
           '<div class="info-value">' + (value || '—') + '</div></div>';
  }

  // One contact slot row. Filled → name + tap-to-call / sms / email
  // action links (RoofLink-style). Empty → a "+ Add" affordance that
  // opens the claim editor AT that contact's section (`slot`, below):
  // it used to open at the top every time, which on a 412px phone put the
  // Claim Handler fields at y=861 — under the fold, behind 17 other fields
  // (2026-09-25 phone audit).
  function contactRow(label, c, slot) {
    var has = c && (c.name || c.phone || c.email);
    var inner;
    if (!has) {
      inner = '<button type="button" data-action="openClaimEditor" data-arg="' + esc(slot) + '" aria-label="Add ' + esc(label) + '" style="background:none;border:none;color:var(--blue,#3b82f6);font-size:15px;cursor:pointer;padding:4px 0;min-height:36px;font-weight:600;">＋ Add</button>';
    } else {
      var digits = String(c.phone || '').replace(/\D/g, '');
      var links = '';
      if (digits) {
        links += '<a href="tel:' + esc(digits) + '" style="color:var(--green,#10b981);text-decoration:none;font-size:13px;margin-left:10px;">📞 Call</a>';
        links += '<a href="sms:' + esc(digits) + '" style="color:var(--blue,#3b82f6);text-decoration:none;font-size:13px;margin-left:10px;">💬 Text</a>';
      }
      if (c.email) links += '<a href="mailto:' + esc(c.email) + '" style="color:var(--orange,#BD5728);text-decoration:none;font-size:13px;margin-left:10px;">✉️ Email</a>';
      inner = '<div style="color:var(--t);font-weight:600;">' + esc(c.name || c.phone || c.email) + '</div>' +
              (c.phone ? '<div style="color:var(--m,#9ca3af);font-size:12px;margin-top:2px;">' + esc(c.phone) + '</div>' : '') +
              (links ? '<div style="margin-top:4px;margin-left:-10px;">' + links + '</div>' : '');
    }
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-top:1px solid var(--br,rgba(255,255,255,.08));gap:12px;">' +
           '<div style="color:var(--m,#9ca3af);font-size:12px;text-transform:uppercase;letter-spacing:.06em;flex:0 0 auto;">' + esc(label) + '</div>' +
           '<div style="text-align:right;min-width:0;">' + inner + '</div></div>';
  }

  function render(containerId, lead) {
    var el = document.getElementById(containerId || 'insurancePanel');
    if (!el) return;
    var c = normalizeClaim(lead || window._currentLead || {});
    var color = STATUS_COLORS[c.status] || '#9ca3af';
    el.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:start;gap:12px;">' +
        '<div>' +
          '<div class="panel-title" style="margin-bottom:4px;">Insurance Claim Details</div>' +
          '<div style="color:var(--m,#9ca3af);font-size:12px;">Deductible</div>' +
          '<div style="color:var(--blue,#3b82f6);font-size:24px;font-weight:800;">' + money(c.deductible) + '</div>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex:0 0 auto;">' +
          '<button type="button" data-action="openClaimEditor" style="background:none;border:1px solid var(--br,rgba(255,255,255,.15));border-radius:8px;color:var(--t);font-size:12px;cursor:pointer;padding:6px 12px;">✎ Edit</button>' +
          '<span id="claimStatusChip" style="background:' + color + '22;color:' + color + ';border:1px solid ' + color + '55;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700;white-space:nowrap;">' + esc(c.status) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="info-grid" style="margin-top:12px;">' +
        factCell('Claim Number', dt(c.number)) +
        factCell('Type of Loss', dt(c.typeOfLoss)) +
        factCell('Carrier', dt(c.carrier)) +
        factCell('Claim Filed By', dt(c.filedBy)) +
        factCell('Policy Number', dt(c.policyNumber)) +
        factCell('Policy Holder', dt(c.policyHolder)) +
        factCell('Date of Loss', dt(c.dateOfLoss)) +
        factCell('Date Damage Discovered', dt(c.dateDiscovered)) +
        factCell('Estimate Amount', money(c.estimateAmount)) +
        factCell('Approved Amount', money(c.approvedAmount)) +
        factCell('Supplement Status', dt(c.supplementStatus)) +
        factCell('Scope of Work', dt(c.scopeOfWork)) +
        factCell('Adjuster Meeting', meetingLabel(c.adjusterMeeting) || '—') +
      '</div>' +
      '<div style="margin-top:14px;">' +
        contactRow('Adjuster', c.adjuster, 'adjuster') +
        contactRow('Claim Handler', c.claimHandler, 'handler') +
        contactRow('Mortgage Company', c.mortgageCompany, 'mortgage') +
      '</div>';
  }

  // Re-fetch the lead (the workflow widget writes claimStage/claimStatus
  // straight to Firestore) and re-render the panel from fresh data.
  function refresh() {
    var id = window._customerId;
    if (id && window.getDoc && window.doc && window.db) {
      window.getDoc(window.doc(window.db, 'leads', id)).then(function (snap) {
        if (snap && snap.exists && snap.exists()) {
          if (window._currentLead) Object.assign(window._currentLead, snap.data());
          render('insurancePanel', window._currentLead || snap.data());
        }
      }).catch(function () { render('insurancePanel', window._currentLead); });
    } else {
      render('insurancePanel', window._currentLead);
    }
  }

  window.ClaimPanel = { render: render, refresh: refresh };

  /* ── Claim editor modal ──────────────────────────────────────────── */

  function field(label, id, type, value, ph) {
    return '<div class="mfield" style="flex:1;min-width:0;"><label style="display:block;color:var(--m,#9ca3af);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">' + esc(label) + '</label>' +
      '<input type="' + type + '" id="' + id + '" value="' + esc(value == null ? '' : value) + '" placeholder="' + esc(ph || '') + '" style="width:100%;background:rgba(255,255,255,.05);border:1px solid var(--br,rgba(255,255,255,.12));border-radius:8px;color:var(--t);padding:9px 10px;font-size:14px;font-family:inherit;box-sizing:border-box;"></div>';
  }
  function selectField(label, id, options, value) {
    var opts = options.map(function (o) {
      var v = Array.isArray(o) ? o[0] : o, t = Array.isArray(o) ? o[1] : o;
      return '<option value="' + esc(v) + '"' + (v === value ? ' selected' : '') + '>' + esc(t) + '</option>';
    }).join('');
    return '<div class="mfield" style="flex:1;min-width:0;"><label style="display:block;color:var(--m,#9ca3af);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">' + esc(label) + '</label>' +
      '<select id="' + id + '" style="width:100%;background:rgba(255,255,255,.05);border:1px solid var(--br,rgba(255,255,255,.12));border-radius:8px;color:var(--t);padding:9px 10px;font-size:14px;font-family:inherit;box-sizing:border-box;">' + opts + '</select></div>';
  }
  // align-items:flex-end (2026-09-25): at 412px "Estimate Amount ($)" and
  // "Approved Amount ($)" wrap to two lines in their 103px columns while
  // "Deductible ($)" does not, so the Deductible input sat 13px higher than
  // its neighbours. Bottom-aligning the cells lines the inputs up whatever
  // the labels do; single-line rows are unchanged.
  function row() {
    return '<div style="display:flex;gap:10px;margin-bottom:10px;align-items:flex-end;">' + Array.prototype.slice.call(arguments).join('') + '</div>';
  }
  function section(t, slot) {
    return '<div' + (slot ? ' data-claim-section="' + esc(slot) + '"' : '') + ' style="font-family:\'Barlow Condensed\',sans-serif;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--orange,#BD5728);margin:16px 0 8px;">' + esc(t) + '</div>';
  }
  // Contact slot → the section heading and the field a "+ Add" lands on.
  var SLOT_FIELD = { adjuster: 'clmAdjName', handler: 'clmHandlerName', mortgage: 'clmMortgageName' };

  // `slot` is set by a contact row's "+ Add" (data-arg); Edit and every
  // other caller pass nothing and get the editor from the top, as before.
  window.openClaimEditor = function (slot) {
    var focusId = (typeof slot === 'string' && SLOT_FIELD.hasOwnProperty(slot)) ? SLOT_FIELD[slot] : null;
    var lead = window._currentLead || {};
    var c = normalizeClaim(lead);
    var old = document.getElementById('claimEditModal');
    if (old) old.remove();
    var bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.id = 'claimEditModal';
    bg.innerHTML =
      '<div class="modal" style="max-width:560px;width:100%;max-height:86vh;overflow-y:auto;background:var(--s,#1a1d23);border:1px solid var(--br,rgba(255,255,255,.1));border-radius:14px;padding:20px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
          '<div style="font-family:\'Barlow Condensed\',sans-serif;font-size:20px;font-weight:800;color:var(--t);">Claim Details</div>' +
          '<button type="button" data-action="closeClaimEditor" aria-label="Close" style="background:none;border:none;color:var(--m,#9ca3af);font-size:22px;cursor:pointer;padding:4px 8px;line-height:1;min-width:40px;min-height:40px;">×</button>' +
        '</div>' +
        section('Claim') +
        row(field('Claim Number', 'clmNumber', 'text', c.number, 'CLM-123456'),
            selectField('Status', 'clmStatus', STATUS_VALUES, c.status)) +
        row(field('Carrier', 'clmCarrier', 'text', c.carrier, 'State Farm'),
            selectField('Filed By', 'clmFiledBy', [['', 'Not Filed'], ['homeowner', 'Homeowner'], ['contractor', 'Contractor (NBD)'], ['agent', 'Insurance Agent']], c.filedBy)) +
        row(field('Policy Number', 'clmPolicyNumber', 'text', c.policyNumber, 'POL-9988776'),
            field('Policy Holder', 'clmPolicyHolder', 'text', c.policyHolder, 'Name on the policy')) +
        row(field('Date of Loss', 'clmDateOfLoss', 'date', c.dateOfLoss, ''),
            field('Date Damage Discovered', 'clmDateDiscovered', 'date', c.dateDiscovered, '')) +
        row(field('Type of Loss', 'clmTypeOfLoss', 'text', c.typeOfLoss, 'Wind, Hail…'),
            selectField('Supplement', 'clmSupplementStatus', [['', 'N/A'], ['needed', 'Needed'], ['requested', 'Requested'], ['under_review', 'Under Review'], ['re_inspection', 'Re-Inspection'], ['approved', 'Approved'], ['denied', 'Denied']], c.supplementStatus)) +
        section('Money') +
        row(field('Deductible ($)', 'clmDeductible', 'number', c.deductible, '1500'),
            field('Estimate Amount ($)', 'clmEstimateAmount', 'number', c.estimateAmount, '18500'),
            field('Approved Amount ($)', 'clmApprovedAmount', 'number', c.approvedAmount, '16200')) +
        row(field('Scope of Work', 'clmScopeOfWork', 'text', c.scopeOfWork, 'Full roof replacement, gutters…')) +
        section('Adjuster', 'adjuster') +
        row(field('Name', 'clmAdjName', 'text', c.adjuster.name, 'Mike Johnson'),
            field('Phone', 'clmAdjPhone', 'tel', c.adjuster.phone, '(513) 555-0100')) +
        row(field('Email', 'clmAdjEmail', 'email', c.adjuster.email, 'adjuster@carrier.com')) +
        row(field('Meeting Date', 'clmAdjMeetDate', 'date', c.adjusterMeeting.date, ''),
            field('Meeting Time', 'clmAdjMeetStart', 'time', c.adjusterMeeting.start, '')) +
        section('Claim Handler', 'handler') +
        row(field('Name', 'clmHandlerName', 'text', c.claimHandler.name, ''),
            field('Phone', 'clmHandlerPhone', 'tel', c.claimHandler.phone, '')) +
        row(field('Email', 'clmHandlerEmail', 'email', c.claimHandler.email, '')) +
        section('Mortgage Company', 'mortgage') +
        row(field('Company', 'clmMortgageName', 'text', c.mortgageCompany.name, ''),
            field('Phone', 'clmMortgagePhone', 'tel', c.mortgageCompany.phone, '')) +
        '<div style="display:flex;gap:10px;margin-top:16px;">' +
          '<button type="button" data-action="closeClaimEditor" style="flex:1;background:none;border:1px solid var(--br,rgba(255,255,255,.15));border-radius:10px;color:var(--m,#9ca3af);font-size:14px;font-weight:700;cursor:pointer;padding:12px;">Cancel</button>' +
          '<button type="button" id="saveClaimBtn" data-action="saveClaimEdits" style="flex:2;background:var(--orange,#BD5728);border:none;border-radius:10px;color:#fff;font-size:14px;font-weight:800;cursor:pointer;padding:12px;">SAVE CLAIM</button>' +
        '</div>' +
      '</div>';
    // nbdModal's focusFirst() takes an [autofocus] field over the first
    // button (the ×), so the "+ Add" slot's Name field gets the caret.
    // focusFirst focuses with preventScroll, so the card is scrolled to the
    // section explicitly — by scrollTop on the card only, never
    // scrollIntoView(), which would also move the page behind the modal.
    var focusEl = focusId ? bg.querySelector('#' + focusId) : null;
    if (focusEl) focusEl.setAttribute('autofocus', '');
    document.body.appendChild(bg);
    if (window.nbdModal) window.nbdModal.open('claimEditModal');
    else { bg.classList.add('open'); if (focusEl) focusEl.focus({ preventScroll: true }); }
    if (focusEl) {
      var card = bg.querySelector('.modal');
      var head = bg.querySelector('[data-claim-section="' + slot + '"]');
      if (card && head) {
        card.scrollTop += head.getBoundingClientRect().top - card.getBoundingClientRect().top - 12;
      }
    }
  };

  window.closeClaimEditor = function () {
    if (window.nbdModal) window.nbdModal.close('claimEditModal');
    var el = document.getElementById('claimEditModal');
    if (el) el.classList.remove('open');
  };

  window.saveClaimEdits = async function () {
    var btn = document.getElementById('saveClaimBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'SAVING…'; }
    var val = function (id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; };
    var numOrNull = function (id) { var v = val(id); return v === '' ? null : (Number(v) || 0); };
    // Adjuster meeting: a real date, and a time only with a date. A time input
    // hands back 'HH:MM' (some browsers 'HH:MM:SS' — trimmed to the minute).
    var meetDate = val('clmAdjMeetDate');
    var meetStart = val('clmAdjMeetStart').slice(0, 5);
    var W = window.NBDScheduleWindow;
    var meetErr = (meetDate && W && W.parseYmd && !W.parseYmd(meetDate)) ? 'The adjuster meeting date is not a real date.'
      : (meetStart && !/^([01]\d|2[0-3]):[0-5]\d$/.test(meetStart)) ? 'The adjuster meeting time must look like 10:00.'
      : (meetStart && !meetDate) ? 'Pick the adjuster meeting day for that time.'
      : '';
    if (meetErr) {
      if (typeof window.showToast === 'function') window.showToast(meetErr, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'SAVE CLAIM'; }
      return;
    }
    try {
      var updates = {
        claimNumber: val('clmNumber'),
        claimStatus: val('clmStatus') || 'No Claim',
        insCarrier: val('clmCarrier'),
        claimFiledBy: val('clmFiledBy'),
        policyNumber: val('clmPolicyNumber'),
        policyHolder: val('clmPolicyHolder'),
        dateOfLoss: val('clmDateOfLoss'),
        dateDiscovered: val('clmDateDiscovered'),
        damageType: val('clmTypeOfLoss'),
        supplementStatus: val('clmSupplementStatus'),
        deductibleOrOwedByHO: numOrNull('clmDeductible') || 0,
        estimateAmount: numOrNull('clmEstimateAmount') || 0,
        approvedAmount: numOrNull('clmApprovedAmount') || 0,
        scopeOfWork: val('clmScopeOfWork'),
        adjusterName: val('clmAdjName'),
        adjusterPhone: val('clmAdjPhone'),
        adjusterEmail: val('clmAdjEmail'),
        adjusterMeetingDate: meetDate,
        adjusterMeetingStart: meetStart,
        claimHandlerName: val('clmHandlerName'),
        claimHandlerPhone: val('clmHandlerPhone'),
        claimHandlerEmail: val('clmHandlerEmail'),
        mortgageCompanyName: val('clmMortgageName'),
        mortgageCompanyPhone: val('clmMortgagePhone'),
        updatedAt: new Date()
      };
      await window.updateDoc(window.doc(window.db, 'leads', window._customerId), updates);
      if (window._currentLead) Object.assign(window._currentLead, updates);
      render('insurancePanel', window._currentLead);
      // The workflow widget shows carrier/claim#/approved — refresh it too.
      if (window.InsuranceClaim && window.InsuranceClaim.renderClaimWorkflow) {
        try { window.InsuranceClaim.renderClaimWorkflow('insuranceClaimWorkflow', window._customerId); } catch (e) {}
      }
      window.closeClaimEditor();
      if (typeof window.showToast === 'function') window.showToast('Claim details saved', 'success');
    } catch (e) {
      console.error('Claim save failed:', e);
      if (typeof window.showToast === 'function') window.showToast('Failed to save claim: ' + e.message, 'error');
    }
    if (btn) { btn.disabled = false; btn.textContent = 'SAVE CLAIM'; }
  };

  // Late-load self-render: if customer-bootstrap already populated the
  // page before this script parsed (defer order races the module), paint
  // the panel now. The panel div stays display:none unless bootstrap
  // decided the lead is insurance-flavored, so rendering is always safe.
  if (window._currentLead && document.getElementById('insurancePanel')) {
    try { render('insurancePanel', window._currentLead); } catch (e) {}
  }
})();
