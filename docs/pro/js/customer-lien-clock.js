/**
 * customer-lien-clock.js — the internal lien clock on the customer page.
 *
 * Dark: shows only when the `lienClock` feature flag is on (absent = off).
 * INTERNAL ONLY: a rep-facing planning card. It prints nothing to a customer,
 * files nothing and mails nothing; a person files. Every date is shown with
 * "verify with counsel" (js/lien-clock.js holds the rules and the reasons).
 *
 * The rep records two dates on the lead: the last day of work
 * (`lienLastWorkDate`) and, once recorded, the day the affidavit / sworn
 * statement was filed (`lienFiledDate`). The clock is computed from those.
 * A Kentucky insurance job shows the "no lien for the excess" line instead of
 * a countdown (KRS 367.628(2)(g)).
 *
 * Activates only on /pro/customer.html; re-evaluates on 'nbd:data-refreshed'.
 */
(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : {};
  const loaded = root.__NBD_LOADED = root.__NBD_LOADED || {};
  if (loaded['customer-lien-clock']) return;
  loaded['customer-lien-clock'] = true;

  const CARD_ID = 'nbd-lien-clock';
  const STYLE_ID = 'nbd-lien-clock-style';
  const FLAG = 'lienClock';
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  // The property's state: an explicit lead.state wins, then ", OH 45xxx" / ", KY" in the address.
  function stateOf(lead) {
    const direct = String((lead && (lead.state || lead.propertyState)) || '').trim().toUpperCase();
    if (direct === 'OH' || direct === 'KY') return direct;
    const m = /,\s*(OH|KY|Ohio|Kentucky)\b/i.exec(String((lead && lead.address) || ''));
    if (!m) return '';
    return /^k/i.test(m[1]) ? 'KY' : 'OH';
  }

  // Same test the customer page uses for its insurance panel (customer-bootstrap.module.js).
  function isInsuranceJob(lead) {
    if (!lead) return false;
    return !!(lead.jobType === 'insurance' || lead.insCarrier || lead.insuranceCarrier || lead.claimNumber
      || (lead.claimStatus && lead.claimStatus !== 'No Claim'));
  }

  function todayStr(now) {
    const d = now instanceof Date ? now : new Date();
    const p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** What to render for a lead; null when the card should not show at all. */
  function buildModel(lead, opts) {
    opts = opts || {};
    if (!opts.flagOn || !lead) return null;
    const LC = opts.LienClock || root.NBDLienClock;
    if (!LC) return null;
    const state = stateOf(lead);
    const last = DATE_RE.test(String(lead.lienLastWorkDate || '')) ? lead.lienLastWorkDate : '';
    const filed = DATE_RE.test(String(lead.lienFiledDate || '')) ? lead.lienFiledDate : '';
    const clock = LC.compute({
      state: state, lastWorkDate: last, filedDate: filed,
      isInsurance: isInsuranceJob(lead), today: todayStr(opts.now)
    });
    return { state: state, last: last, filed: filed, clock: clock, disclaimer: LC.DISCLAIMER };
  }

  const CSS = ''
    + '#' + CARD_ID + '{margin:0 0 16px;padding:12px 16px;border-radius:10px;border:1px solid var(--br,rgba(255,255,255,.14));'
    + 'background:var(--s2,rgba(255,255,255,.04));color:var(--t,#e8eaf0);font-size:13px;}'
    + '#' + CARD_ID + ' .nlc-title{font-weight:700;margin-bottom:4px;}'
    + '#' + CARD_ID + ' .nlc-note{font-size:12px;color:var(--m,#9aa3b2);margin:2px 0 8px;}'
    + '#' + CARD_ID + ' .nlc-row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:8px;}'
    + '#' + CARD_ID + ' label{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--m,#9aa3b2);}'
    + '#' + CARD_ID + ' input[type=date]{min-height:44px;padding:0 10px;border-radius:8px;font:inherit;}'
    + '#' + CARD_ID + ' .nlc-btn{min-height:44px;min-width:44px;padding:0 16px;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;}'
    + '#' + CARD_ID + ' ul{list-style:none;margin:0;padding:0;}'
    + '#' + CARD_ID + ' li{padding:6px 0;border-top:1px solid var(--br,rgba(255,255,255,.1));}'
    + '#' + CARD_ID + ' .nlc-urgent{font-weight:700;}'
    + '#' + CARD_ID + ' .nlc-status{font-size:12px;color:var(--m,#9aa3b2);}';

  function html(m) {
    const c = m.clock;
    let h = '<div class="nlc-title">Lien clock (internal)</div>';
    h += '<div class="nlc-note">' + esc(m.disclaimer) + ' Nothing here is sent to the customer and nothing is filed for you.</div>';
    if (!c.supported) {
      return h + '<div class="nlc-note">' + esc(c.reason || 'Add the property state to this customer to use the clock.') + '</div>';
    }
    if (c.suppressed) {
      return h + '<div class="nlc-note">' + esc(c.reason) + '</div>';
    }
    h += '<div class="nlc-row">'
      + '<label>Last day of work<input type="date" id="nlcLast" value="' + esc(m.last) + '"></label>'
      + '<label>Filed on (once recorded)<input type="date" id="nlcFiled" value="' + esc(m.filed) + '"></label>'
      + '<button type="button" class="nlc-btn" id="nlcSave">Save dates</button></div>';
    if (!c.steps.length) return h + '<div class="nlc-note">' + esc(c.reason) + '</div>';
    h += '<ul>';
    for (let i = 0; i < c.steps.length; i++) {
      const s = c.steps[i];
      const when = s.status === 'passed' ? 'passed ' + Math.abs(s.daysLeft) + ' day(s) ago'
        : s.daysLeft === 0 ? 'due today' : s.daysLeft + ' day(s) left';
      h += '<li class="' + (s.status === 'urgent' || s.status === 'passed' ? 'nlc-urgent' : '') + '">'
        + esc(s.label) + '<div class="nlc-status">Work by ' + esc(s.workBy) + ' (statutory ' + esc(s.deadline)
        + ', ' + esc(s.basis) + ') · ' + esc(when) + '</div></li>';
    }
    return h + '</ul>';
  }

  function flagOn() {
    const F = root.NBDFlags;
    return !!(F && typeof F.enabled === 'function' && F.enabled(FLAG));
  }

  async function save(doc) {
    const last = doc.getElementById('nlcLast'), filed = doc.getElementById('nlcFiled');
    const lv = last ? last.value : '', fv = filed ? filed.value : '';
    if ((lv && !DATE_RE.test(lv)) || (fv && !DATE_RE.test(fv))) return false;
    const upd = { lienLastWorkDate: lv || null, lienFiledDate: fv || null };
    if (!root.updateDoc || !root.doc || !root.db || !root._customerId) return false;
    await root.updateDoc(root.doc(root.db, 'leads', root._customerId), upd);
    if (root._currentLead) Object.assign(root._currentLead, upd);
    return true;
  }

  function render(doc, lead) {
    const old = doc.getElementById(CARD_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const m = buildModel(lead, { flagOn: flagOn() });
    if (!m) return null;
    const host = doc.querySelector('.ui-page');
    if (!host) return null;
    if (!doc.getElementById(STYLE_ID)) {
      const st = doc.createElement('style');
      st.id = STYLE_ID;
      st.textContent = CSS;
      doc.head.appendChild(st);
    }
    const el = doc.createElement('div');
    el.id = CARD_ID;
    el.innerHTML = html(m);
    host.insertBefore(el, host.firstChild);
    const btn = doc.getElementById('nlcSave');
    if (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        save(doc).then(function (ok) {
          btn.disabled = false;
          if (ok) render(doc, root._currentLead || lead);
        }, function () { btn.disabled = false; });
      });
    }
    return el;
  }

  const api = { stateOf, isInsuranceJob, buildModel, html, render, FLAG };
  root.NBDCustomerLienClock = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  const PATH = (root.location && root.location.pathname) || '';
  if (!/\/pro\/customer(?:\.html)?$/.test(PATH)) return;

  function refresh() {
    try { render(root.document, root._currentLead || null); } catch (_) { /* a planning card never breaks the page */ }
  }

  function init() {
    const F = root.NBDFlags;
    if (F && typeof F.load === 'function') { F.load().then(function () { setTimeout(refresh, 300); }, function () {}); }
    setTimeout(refresh, 1500);
    root.addEventListener('nbd:data-refreshed', function () { setTimeout(refresh, 60); });
  }

  if (root.document && root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
