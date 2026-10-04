/**
 * stage-gate-sheet.js — the "fill what's missing, then move" bottom sheet.
 *
 * 2026-10-03 (stage-flow lane). A stage move the required-field gate refuses
 * (crm-stages.js REQUIRED_FIELDS_BY_TYPE) used to show a toast whose only
 * action — "Open full editor" — LEFT the customer page for the dashboard
 * editor. On the installed iPhone app that is a full page load into a modal
 * with ~40 fields to find the one that blocks. Now the customer page opens
 * this sheet instead: it asks ONLY for the missing fields, saves them, and
 * the caller commits the stage move.
 *
 * It also stops asking for what the CRM already knows:
 *   - "Estimate $" (insurance Contract Signed) and "Job Value" are pre-filled
 *     from the lead's PRIMARY estimate when it has a dollar value.
 *   - "Permit Filed" (Materials Ordered) offers "No permit required", which
 *     answers the gate (missingRequiredFields honours lead.permitNotRequired)
 *     and is recorded as such — permitNotRequired:true + a timestamp — never as
 *     a fake "permit filed" stamp.
 * No requirement is dropped: the patch is re-checked against the gate before
 * it is returned, and a field left blank keeps the move blocked.
 *
 * Pure rules (planFields / buildPatch / primaryEstimateValue) are exported
 * for tests (module.exports); the DOM part is window.NBDStageGateSheet.open.
 * CSP-safe: no inline handlers, no style attributes — one delegated listener
 * per open sheet, classes in css/stage-gate-sheet.css (44px targets, 16px
 * inputs so iOS does not zoom, safe-area padding for the standalone app).
 */
(function (root) {
  'use strict';

  const JOB_TYPES = [
    { value: 'insurance', label: 'Insurance' },
    { value: 'cash', label: 'Cash' },
    { value: 'finance', label: 'Finance' },
    { value: 'warranty', label: 'Warranty' },
    { value: 'service', label: 'Service' },
  ];

  // How each gate field is asked for. Anything not listed is a text box.
  const KIND = {
    jobType: 'jobType',
    insCarrier: 'text', claimNumber: 'text', policyNumber: 'text', financeCompany: 'text',
    dateOfLoss: 'date', scheduledDate: 'date',
    estimateAmount: 'money', jobValue: 'money', loanAmount: 'money', deductibleOrOwedByHO: 'money',
    contractFiledAt: 'filed', warrantyCertFiledAt: 'filed', cocFiledAt: 'filed', aobFiledAt: 'filed',
    permitFiledAt: 'permit',
  };
  // A dollar figure of 0 is not an answer for these (a deductible can be $0).
  const MUST_BE_POSITIVE = ['estimateAmount', 'jobValue', 'loanAmount'];
  const FILED_TEXT = {
    contractFiledAt: 'The signed contract is on file',
    warrantyCertFiledAt: 'The warranty certificate is filed',
    cocFiledAt: 'The certificate of completion is filed',
    aobFiledAt: 'Filed',
  };

  const str = (v) => String(v == null ? '' : v).trim();
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function _estValue(est) {
    if (!est) return 0;
    const rows = root && root.NBDCustomerEstimateRows;
    if (rows && typeof rows.estimateValue === 'function') return Number(rows.estimateValue(est)) || 0;
    const v = est.grandTotal != null ? est.grandTotal : est.total != null ? est.total : est.amount;
    const n = Number(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : 0;
  }

  /** Dollar value of the lead's primary estimate, or null when there is none / it is $0. */
  function primaryEstimateValue(lead, estimates) {
    const id = lead && lead.primaryEstimateId;
    if (!id) return null;
    const est = (estimates || []).find((e) => e && e.id === id && !e.deleted);
    const v = _estValue(est);
    return v > 0 ? Math.round(v * 100) / 100 : null;
  }

  /**
   * The fields to ask for, in gate order, with any value the CRM already has.
   * @returns {Array<{field, kind, label, value, hint}>}
   */
  function planFields(lead, missing, ctx) {
    const c = ctx || {};
    const labelOf = typeof c.labelFor === 'function' ? c.labelFor : (f) => f;
    const fromEstimate = primaryEstimateValue(lead, c.estimates);
    return (missing || []).map((field) => {
      const kind = KIND[field] || 'text';
      const out = { field, kind, label: labelOf(field), value: '', hint: '' };
      if ((field === 'estimateAmount' || field === 'jobValue') && fromEstimate != null) {
        out.value = String(fromEstimate);
        out.hint = 'From the primary estimate — change it if the number moved.';
      }
      return out;
    });
  }

  /**
   * Turn what the rep entered into the lead patch.
   * @param {object} lead     the lead as stored
   * @param {string} stage    the stage being moved to
   * @param {Array}  fields   planFields() output
   * @param {object} values   field → raw value ('filed' kinds: true/false;
   *                          'permit': 'filed' | 'none')
   * @param {object} [ctx]    { nowIso, missingFn }
   * @returns {{ok:boolean, patch?:object, error?:string, field?:string, missing?:string[]}}
   */
  function buildPatch(lead, stage, fields, values, ctx) {
    const c = ctx || {};
    const nowIso = c.nowIso || new Date().toISOString();
    const v = values || {};
    const patch = {};
    for (const f of fields || []) {
      const raw = v[f.field];
      switch (f.kind) {
        case 'jobType': {
          const t = str(raw).toLowerCase();
          if (!JOB_TYPES.some((j) => j.value === t)) return { ok: false, field: f.field, error: 'Pick the job type.' };
          patch.jobType = t;
          break;
        }
        case 'money': {
          const n = Number(str(raw).replace(/[$,\s]/g, ''));
          if (str(raw) === '' || !isFinite(n) || n < 0) return { ok: false, field: f.field, error: 'Enter ' + f.label + ' as a dollar amount.' };
          if (MUST_BE_POSITIVE.includes(f.field) && !(n > 0)) return { ok: false, field: f.field, error: f.label + ' has to be more than $0.' };
          patch[f.field] = Math.round(n * 100) / 100;
          break;
        }
        case 'date': {
          const d = str(raw);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, field: f.field, error: 'Pick a date for ' + f.label + '.' };
          patch[f.field] = d;
          break;
        }
        case 'filed': {
          if (raw !== true) return { ok: false, field: f.field, error: 'Confirm ' + f.label + ' — or cancel and file it first.' };
          patch[f.field] = nowIso;
          break;
        }
        case 'permit': {
          if (raw === 'filed') { patch.permitFiledAt = nowIso; patch.permitNotRequired = false; }
          else if (raw === 'none') { patch.permitNotRequired = true; patch.permitNotRequiredAt = nowIso; }
          else return { ok: false, field: f.field, error: 'Say whether the permit is filed or not required.' };
          break;
        }
        default: {
          const t = str(raw).slice(0, 120);
          if (!t) return { ok: false, field: f.field, error: 'Enter ' + f.label + '.' };
          patch[f.field] = t;
        }
      }
    }
    // Re-check against the real gate: the sheet can never let a move through
    // that the kanban would refuse.
    if (typeof c.missingFn === 'function') {
      const still = c.missingFn(Object.assign({}, lead || {}, patch, { stage })) || [];
      if (still.length) return { ok: false, patch, missing: still, error: 'Still missing: ' + still.join(', ') };
    }
    return { ok: true, patch };
  }

  // ── DOM ──────────────────────────────────────────────────────────────
  function _fieldHtml(f) {
    const id = 'sgs-f-' + f.field;
    const hint = f.hint ? '<div class="sgs-hint">' + esc(f.hint) + '</div>' : '';
    if (f.kind === 'jobType') {
      return '<div class="sgs-field" data-sgs-field="jobType"><span class="sgs-label">' + esc(f.label) + '</span>' +
        '<div class="sgs-choices">' + JOB_TYPES.map((j) =>
          '<button type="button" class="sgs-choice" data-sgs="pick" data-field="jobType" data-value="' + j.value + '" aria-pressed="false">' + esc(j.label) + '</button>').join('') +
        '</div></div>';
    }
    if (f.kind === 'permit') {
      return '<div class="sgs-field" data-sgs-field="permitFiledAt"><span class="sgs-label">Permit</span>' +
        '<div class="sgs-choices">' +
          '<button type="button" class="sgs-choice" data-sgs="pick" data-field="permitFiledAt" data-value="filed" aria-pressed="false">Permit filed</button>' +
          '<button type="button" class="sgs-choice" data-sgs="pick" data-field="permitFiledAt" data-value="none" aria-pressed="false">No permit required</button>' +
        '</div></div>';
    }
    if (f.kind === 'filed') {
      return '<div class="sgs-field" data-sgs-field="' + esc(f.field) + '"><label class="sgs-check" for="' + id + '">' +
        '<input type="checkbox" id="' + id + '" data-field="' + esc(f.field) + '"> <span>' + esc(FILED_TEXT[f.field] || f.label) + '</span></label></div>';
    }
    const type = f.kind === 'date' ? 'date' : 'text';
    const mode = f.kind === 'money' ? ' inputmode="decimal" placeholder="$0.00"' : '';
    return '<div class="sgs-field" data-sgs-field="' + esc(f.field) + '"><label class="sgs-label" for="' + id + '">' + esc(f.label) + '</label>' +
      '<input class="sgs-input" type="' + type + '" id="' + id + '" data-field="' + esc(f.field) + '"' + mode + ' value="' + esc(f.value) + '" autocomplete="off">' + hint + '</div>';
  }

  let _openSheet = null;

  /**
   * Open the sheet. Resolves with the saved patch, or null when cancelled.
   * @param {object} o { lead, stage, stageLabel, missing, estimates, labelFor,
   *                     missingFn(lead) → [], save: async (patch) => void }
   */
  function open(o) {
    if (typeof document === 'undefined') return Promise.resolve(null);
    if (_openSheet) _openSheet.close(null);
    const lead = o.lead || {};
    let fields = planFields(lead, o.missing, o);
    const picks = {};
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'sgs-root';
      wrap.innerHTML =
        '<div class="sgs-backdrop" data-sgs="cancel"></div>' +
        '<div class="sgs-sheet" role="dialog" aria-modal="true" aria-labelledby="sgsTitle">' +
          '<div class="sgs-grip" aria-hidden="true"></div>' +
          '<h3 class="sgs-title" id="sgsTitle">Before “' + esc(o.stageLabel || o.stage) + '”</h3>' +
          '<p class="sgs-sub">Fill these in and the job moves on.</p>' +
          '<div class="sgs-fields"></div>' +
          '<div class="sgs-err" role="alert" aria-live="assertive"></div>' +
          '<div class="sgs-actions">' +
            '<button type="button" class="sgs-btn sgs-cancel" data-sgs="cancel">Cancel</button>' +
            '<button type="button" class="sgs-btn sgs-save" data-sgs="save">Save &amp; move</button>' +
          '</div>' +
        '</div>';
      const box = wrap.querySelector('.sgs-fields');
      const err = wrap.querySelector('.sgs-err');
      const render = () => {
        // Keep anything typed across a re-plan (job type picked → its fields).
        const typed = {};
        box.querySelectorAll('input[data-field]').forEach((i) => { typed[i.dataset.field] = i.type === 'checkbox' ? i.checked : i.value; });
        box.innerHTML = fields.map(_fieldHtml).join('');
        box.querySelectorAll('input[data-field]').forEach((i) => {
          if (!(i.dataset.field in typed)) return;
          if (i.type === 'checkbox') i.checked = !!typed[i.dataset.field]; else i.value = typed[i.dataset.field];
        });
        box.querySelectorAll('[data-sgs="pick"]').forEach((b) => {
          const on = picks[b.dataset.field] === b.dataset.value;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      };
      const values = () => {
        const out = Object.assign({}, picks);
        box.querySelectorAll('input[data-field]').forEach((i) => { out[i.dataset.field] = i.type === 'checkbox' ? i.checked : i.value; });
        return out;
      };
      let busy = false;
      const close = (result) => {
        if (!wrap.parentNode) return;
        document.removeEventListener('keydown', onKey, true);
        wrap.parentNode.removeChild(wrap);
        document.documentElement.classList.remove('sgs-open');
        _openSheet = null;
        resolve(result);
      };
      const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); close(null); } };
      wrap.addEventListener('click', async (e) => {
        const t = e.target && e.target.closest ? e.target.closest('[data-sgs]') : null;
        if (!t || busy) return;
        const act = t.dataset.sgs;
        if (act === 'cancel') { close(null); return; }
        if (act === 'pick') {
          picks[t.dataset.field] = t.dataset.value;
          // A job type decides which fields the stage needs — re-plan.
          if (t.dataset.field === 'jobType' && typeof o.missingFn === 'function') {
            const next = (o.missingFn(Object.assign({}, lead, { jobType: t.dataset.value, stage: o.stage })) || []).filter((f) => f !== 'jobType');
            fields = planFields(lead, ['jobType'].concat(next), o);
          }
          err.textContent = '';
          render();
          return;
        }
        if (act === 'save') {
          const res = buildPatch(lead, o.stage, fields, values(), { missingFn: o.missingFn });
          if (!res.ok) {
            err.textContent = res.error || 'Check the fields above.';
            const bad = res.field && box.querySelector('[data-sgs-field="' + res.field + '"] input, [data-sgs-field="' + res.field + '"] button');
            if (bad && bad.focus) { try { bad.focus({ preventScroll: false }); } catch (_) { bad.focus(); } }
            return;
          }
          busy = true;
          t.disabled = true;
          t.textContent = 'Saving…';
          err.textContent = '';
          try {
            if (typeof o.save === 'function') await o.save(res.patch);
            close(res.patch);
          } catch (ex) {
            busy = false;
            t.disabled = false;
            t.textContent = 'Save & move';
            err.textContent = 'Could not save: ' + ((ex && (ex.code || ex.message)) || 'unknown error');
          }
        }
      });
      document.addEventListener('keydown', onKey, true);
      render();
      document.body.appendChild(wrap);
      document.documentElement.classList.add('sgs-open');
      _openSheet = { close };
      const first = box.querySelector('input:not([type="checkbox"]), button, input');
      if (first && first.focus) { try { first.focus({ preventScroll: true }); } catch (_) { first.focus(); } }
    });
  }

  const api = { open, planFields, buildPatch, primaryEstimateValue, KIND, JOB_TYPES };
  if (root) root.NBDStageGateSheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
