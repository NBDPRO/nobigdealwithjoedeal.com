/**
 * payment-terms-settings.js - Settings > Company Profile > "Payment terms"
 * (clause set v1 follow-up, 2026-11-18; documentation/projects/CLAUSE-SET-V1-2026-11-18.md).
 *
 * companyProfile.paymentTerms: the twelve numbers the printed contract clauses carry (late grace
 * days, late interest %, dispute days, ...). With flag docClauseSetV1 on, a contract is refused
 * while one a clause needs is unset; this panel is where a company sets them. A tenant other
 * than NBD starts blank (company-profile.js _resolveLegal) and fills each one in.
 *
 * The owner (solo, or the company keyed by their uid) or a company_admin edits; everyone else
 * reads. Save writes ONLY { paymentTerms } through window._saveCompanyProfile (a merge), and only
 * the fields filled in; a value outside its range refuses the whole save before anything is sent.
 * The bounds are clause-set.js numOk (the same bounds firestore.rules enforces): this file only
 * parses what was typed and asks numOk. Dollars are typed, cents are stored, with an explicit
 * rule: at most two decimals, and a third is refused, never rounded.
 *
 * The readiness line at the top is the send gate's own answer: clause-set.js renderV1 over every
 * state and payment source a contract can print, its `missing` lists joined. It reads no flag.
 *
 * The panel is built here under the Letterhead panel (found by #cp_businessLicense), so
 * dashboard.html carries no new markup. Loaded lazily from tenant-account-ui.js (the
 * `tenantsettings` ScriptLoader bundle), never at boot. No inline handlers, no style
 * attributes, every value escaped. The pure half (FIELDS / parse / collect / readiness) is
 * require()-able for tests/payment-terms-settings-2026-11-18.test.js.
 */
(function (root) {
  'use strict';

  var node = typeof module === 'object' && module.exports;
  function clauseSet() { return node ? require('./clause-set') : (root && root.NBDClauseSet) || null; }

  // unit: 'days' | 'pct' | 'dollars' | 'sheets'. bounds are the hint text in STORED units; numOk is the authority.
  var FIELDS = [
    { key: 'lateGraceDays', label: 'Late payment grace', unit: 'days', int: true, bounds: [0, 365] },
    { key: 'lateInterestPct', label: 'Late interest', unit: 'pct', int: false, bounds: [0, 100] },
    { key: 'disputeDays', label: 'Invoice dispute window', unit: 'days', int: true, bounds: [0, 365] },
    { key: 'finalPaymentDays', label: 'Final payment due after completion', unit: 'days', int: true, bounds: [0, 365] },
    { key: 'punchListDays', label: 'Punch list window', unit: 'days', int: true, bounds: [0, 365] },
    { key: 'pauseNoticeDays', label: 'Notice before pausing work for non-payment', unit: 'days', int: true, bounds: [0, 365] },
    { key: 'restockPct', label: 'Restocking fee', unit: 'pct', int: false, bounds: [0, 100] },
    { key: 'cardFeePct', label: 'Card fee', unit: 'pct', int: false, bounds: [0, 10] },
    { key: 'deckingPerSheetCents', label: 'Replacement decking, per sheet', unit: 'dollars', int: true, bounds: [0, 100000] },
    { key: 'deckingSheetsBeforeChangeOrder', label: 'Decking sheets included before a change order', unit: 'sheets', int: true, bounds: [1, 200] },
    { key: 'atticFreeCheckDays', label: 'Free attic check window', unit: 'days', int: true, bounds: [1, 365] },
    { key: 'claimNoticeDays', label: 'Warranty claim notice', unit: 'days', int: true, bounds: [0, 365] }
  ];
  var BY_KEY = {};
  FIELDS.forEach(function (f) { BY_KEY[f.key] = f; });
  var UNIT_TEXT = { days: 'days', pct: '%', dollars: '$ per sheet', sheets: 'sheets' };

  function money(cents) {
    var d = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return '$' + d + '.' + ('0' + (cents % 100)).slice(-2);
  }
  function rangeText(f) {
    if (f.unit === 'dollars') return 'Enter dollars from ' + money(f.bounds[0]) + ' to ' + money(f.bounds[1]) + ', in whole cents.';
    if (f.int) return 'Enter a whole number from ' + f.bounds[0] + ' to ' + f.bounds[1] + '.';
    return 'Enter a number from ' + f.bounds[0] + ' to ' + f.bounds[1] + ', with at most two decimals.';
  }

  /** Stored cents -> the dollars a person types ("100.00"); '' when not a number. */
  function fromCents(c) {
    if (typeof c !== 'number' || !isFinite(c)) return '';
    return Math.floor(c / 100) + '.' + ('0' + (c % 100)).slice(-2);
  }

  /**
   * What was typed for one field -> { ok, value } (value in STORED units: cents for dollars),
   * { ok:false, blank:true } for nothing typed, or { ok:false, error }.
   * Money rule: dollars with at most two decimals; a third is refused, never rounded. Whole
   * cents are built from the digits, not by multiplying a float.
   */
  function parse(key, raw) {
    var f = Object.prototype.hasOwnProperty.call(BY_KEY, key) ? BY_KEY[key] : null;
    if (!f) return { ok: false, error: 'Unknown field.' };
    var s = String(raw == null ? '' : raw).trim();
    if (s === '') return { ok: false, blank: true };
    if (f.unit === 'dollars') s = s.replace(/^\$/, '').replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: rangeText(f) };
    var parts = s.split('.'), frac = parts[1] || '';
    var value;
    if (f.unit === 'dollars') {
      if (frac.length > 2) return { ok: false, error: 'Use whole cents: at most two decimals.' };
      value = parseInt(parts[0], 10) * 100 + parseInt((frac + '00').slice(0, 2), 10);
    } else if (f.int) {
      if (frac) return { ok: false, error: rangeText(f) };
      value = parseInt(parts[0], 10);
    } else {
      if (frac.length > 2) return { ok: false, error: rangeText(f) };
      value = Number(s);
    }
    var CS = clauseSet();
    if (!CS || !CS.numOk(value, key)) return { ok: false, error: rangeText(f) };
    return { ok: true, value: value };
  }

  /** { key: typed } -> { ok, terms, errors }: only the filled, valid fields; any bad one refuses the lot. */
  function collect(raw) {
    var terms = {}, errors = {};
    FIELDS.forEach(function (f) {
      if (!raw || raw[f.key] === undefined) return;
      var r = parse(f.key, raw[f.key]);
      if (r.ok) terms[f.key] = r.value;
      else if (!r.blank) errors[f.key] = r.error;
    });
    return { ok: Object.keys(errors).length === 0, terms: terms, errors: errors };
  }

  /**
   * The send gate's missing list: clause-set.js renderV1 over every state and payment source a contract can print,
   * so a clause only some contracts print still counts (a company must be ready for all of them).
   * -> { ready, missing: [field keys], atticMissing, line }. atticFreeCheckDays is not a contract clause; the attic
   * forms refuse without it (document-generator.js _docSendGate), so it is reported apart from the contract line.
   */
  function gateStatus(profileTerms, isNbd, CS) {
    CS = CS || clauseSet();
    var seen = {};
    if (CS) {
      var terms = CS.paymentTermsFor(profileTerms, !!isNbd);
      ['KY', 'OH', ''].forEach(function (st) {
        ['cash', 'insurance', 'financed', ''].forEach(function (src) {
          CS.renderV1({ state: st, paymentSource: src, terms: terms, hasWarranty: true, facts: { milestones: ['m'] } })
            .missing.forEach(function (k) { seen[k] = 1; });
        });
      });
    }
    var missing = (CS ? CS.PT_FIELDS : FIELDS.map(function (f) { return f.key; })).filter(function (k) { return seen[k]; });
    var attic = !CS || !CS.numOk(CS.paymentTermsFor(profileTerms, !!isNbd).atticFreeCheckDays, 'atticFreeCheckDays');
    var names = missing.map(function (k) { return BY_KEY[k] ? BY_KEY[k].label : k; });
    return {
      ready: missing.length === 0, missing: missing, atticMissing: attic,
      line: missing.length ? 'Not ready: set ' + names.join(', ') : 'Ready: new contracts can be sent'
    };
  }

  var api = { FIELDS: FIELDS, parse: parse, collect: collect, gateStatus: gateStatus, fromCents: fromCents };
  if (node) module.exports = api;

  var W = root;
  var doc = W && W.document;
  if (!W || !doc || W.NBDPaymentTermsSettings) return;
  W.NBDPaymentTermsSettings = api;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, k) { if (typeof W.showToast === 'function') W.showToast(m, k); }
  /** The owner (solo, or the company keyed by their uid) or a company_admin: the companyProfile writers. */
  function canEdit() {
    var c = W._userClaims || {}, uid = (W._user && W._user.uid) || '';
    var r = String(c.role || '').toLowerCase();
    if (r === 'company_admin' || r === 'admin') return true;
    if (r === 'viewer' || r === 'sales_rep' || r === 'manager') return false;
    return !!uid && (!c.companyId || c.companyId === uid);
  }
  function isNbd() {
    var b = null;
    try { b = typeof W._brand === 'function' ? W._brand() : null; } catch (e) { b = null; }
    return !b || !b.legalName || b.legalName === 'No Big Deal Home Solutions';
  }
  function profile() { return (typeof W._legal === 'function' ? W._legal() : W._companyProfile) || {}; }
  function val(el) { return el.value !== undefined && el.value !== null ? el.value : (el.getAttribute('value') || ''); }

  var panel = null, cssAsked = false, loadAsked = false, dirty = false;

  function inputHtml(f, terms, edit) {
    var v = terms[f.key];
    var shown = v === null || v === undefined ? '' : (f.unit === 'dollars' ? fromCents(v) : String(v));
    var hint = f.unit === 'dollars' ? '$' + fromCents(f.bounds[0]) + ' to $' + fromCents(f.bounds[1]) : f.bounds[0] + ' to ' + f.bounds[1];
    return '<div class="sf ptset-field"><label for="pt_' + f.key + '">' + esc(f.label) + ' <span class="ptset-unit">(' + esc(UNIT_TEXT[f.unit]) + ')</span></label>' +
      '<input type="text" inputmode="decimal" autocomplete="off" class="ptset-input" id="pt_' + f.key + '" data-ptset-field="' + f.key + '" value="' + esc(shown) + '"' +
      ' aria-describedby="pt_' + f.key + '_err"' + (edit ? '' : ' disabled') + '>' +
      '<div class="ptset-hint">' + esc(hint) + '</div>' +
      '<div class="ptset-err" id="pt_' + f.key + '_err"></div></div>';
  }

  function render() {
    var anchor = doc.getElementById('cp_businessLicense');
    var host = anchor && anchor.closest ? anchor.closest('.panel') : null;
    if (!host || !host.parentNode) return;
    var CS = clauseSet();
    if (!CS) {
      // The clause registry rides the documents bundle; load it (same files, ScriptLoader dedupes by path), then paint.
      if (!loadAsked && W.ScriptLoader && typeof W.ScriptLoader.load === 'function') {
        loadAsked = true;
        try {
          Promise.resolve(W.ScriptLoader.load('js/clause-set-text.js?v=3')).then(function () { return W.ScriptLoader.load('js/clause-set.js?v=5'); })
            .then(function () { try { render(); } catch (e) { /* the tab hook paints it later */ } }, function () { loadAsked = false; });
        } catch (e) { loadAsked = false; }
      }
      return;
    }
    if (!cssAsked && W.ScriptLoader && typeof W.ScriptLoader.load === 'function') {
      cssAsked = true;
      try { W.ScriptLoader.load('css/payment-terms-settings.css?v=1'); } catch (e) { /* unstyled still works */ }
    }
    if (!panel || !panel.parentNode) {
      panel = doc.createElement('div');
      panel.className = 'panel mb-md';
      panel.setAttribute('data-ptset', 'panel');
      var tz = host.parentNode.querySelector ? host.parentNode.querySelector('[data-cotz="panel"]') : null;
      var after = tz && tz.parentNode === host.parentNode ? tz : host;
      host.parentNode.insertBefore(panel, after.nextElementSibling || null);
      panel.addEventListener('click', onClick);
      panel.addEventListener('input', onInput);
    }
    if (dirty) return;   // never repaint over what is being typed
    var nbd = isNbd();
    var terms = CS.paymentTermsFor(profile().paymentTerms, nbd);
    var edit = canEdit();
    var r = gateStatus(profile().paymentTerms, nbd, CS);
    panel.innerHTML =
      '<div class="panel-hdr"><div><div class="panel-label">The numbers your printed contracts carry: late fees, windows, and decking.</div>' +
        '<div class="panel-title">Payment terms</div></div></div>' +
      '<div class="panel-body">' +
        '<div class="ptset-ready ' + (r.ready ? 'ptset-ready-ok' : 'ptset-ready-no') + '" data-ptset="ready" role="status">' + esc(r.line) + '</div>' +
        (r.atticMissing ? '<p class="ptset-note">Attic forms also need the free attic check window.</p>' : '') +
        '<p class="ptset-note">Card fee: 0 means no card fee is charged yet.</p>' +
        '<div class="ptset-grid">' + FIELDS.map(function (f) { return inputHtml(f, terms, edit); }).join('') + '</div>' +
        (edit ? '<div class="ptset-row"><button type="button" class="btn btn-ghost ptset-save" data-ptset="save">Save payment terms</button></div>'
          : '<p class="ptset-note">Only the owner or an admin can change these.</p>') +
      '</div>';
  }

  function showErr(key, msg) {
    var inpEl = doc.getElementById('pt_' + key), err = doc.getElementById('pt_' + key + '_err');
    if (!inpEl) return;
    if (msg) inpEl.setAttribute('aria-invalid', 'true'); else inpEl.removeAttribute('aria-invalid');
    if (err) err.textContent = msg || '';
  }
  function onInput(e) {
    var t = e && e.target;
    var key = t && t.getAttribute ? t.getAttribute('data-ptset-field') : null;
    if (!key) return;
    dirty = true;
    var r = parse(key, val(t));
    showErr(key, r.ok || r.blank ? '' : r.error);
  }
  function onClick(e) {
    var t = e && e.target && e.target.closest ? e.target.closest('[data-ptset="save"]') : null;
    if (!t || !canEdit()) return;
    var raw = {};
    FIELDS.forEach(function (f) { var el = doc.getElementById('pt_' + f.key); if (el) raw[f.key] = val(el); });
    var c = collect(raw);
    FIELDS.forEach(function (f) { showErr(f.key, c.errors[f.key] || ''); });
    if (!c.ok) { toast('Payment terms not saved: fix the highlighted fields', 'error'); return; }
    if (!Object.keys(c.terms).length) { toast('Nothing to save: fill in at least one term', 'error'); return; }
    if (typeof W._saveCompanyProfile !== 'function') { toast('Payment terms not saved: the company profile is still loading', 'error'); return; }
    Promise.resolve().then(function () { return W._saveCompanyProfile({ paymentTerms: c.terms }); }).then(function () {
      dirty = false;
      toast('Payment terms saved', 'success');
      render();
    }, function (err) {
      toast('Payment terms not saved: ' + ((err && err.message) || 'error'), 'error');
    });
  }

  function hook() {
    var prev = W.switchSettingsTab;
    if (typeof prev !== 'function') return false;
    if (prev.__ptsetWrapped) return true;
    var wrapped = function () {
      var out = prev.apply(this, arguments);
      try { render(); } catch (e) { /* never break the tab switch */ }
      return out;
    };
    Object.keys(prev).forEach(function (k) { try { wrapped[k] = prev[k]; } catch (_) { /* read-only flag */ } });
    wrapped.__ptsetWrapped = true;
    W.switchSettingsTab = wrapped;
    return true;
  }
  if (typeof W.addEventListener === 'function') W.addEventListener('nbd:company-profile-loaded', function () { try { render(); } catch (e) {} });
  hook();
  try { render(); } catch (e) { /* the tab hook paints it later */ }
})(typeof window !== 'undefined' ? window : null);
