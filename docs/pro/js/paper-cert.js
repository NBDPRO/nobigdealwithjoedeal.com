// ── Paper certification (flag docClauseSetV1, Jo's decisions Q49 and Q63, 2026-11-18) ──
// Loaded on demand from the docgen bundle (script-loader.js), never on the customer page's boot path.
//
//   NBDPaperCert.collect(file)   the form shown when a paper-signed file is picked: what the paper is, which
//                                generated document it is the signed copy of, the date it was signed and an
//                                optional witness. Resolves { docType, originalDocId, signedOn, witnessName }, or null.
//   NBDPaperCert.certify(docId)  shows the attestation sentence and calls the attestWetSigned callable. The SERVER
//                                writes the attestation and files the contract; nothing here marks anything signed.
//
// Until it is certified an upload reads "Uploaded, not certified" and does not file the contract.
(function () {
  'use strict';

  // The sentence the server writes into the attestation (functions/paper-cert-logic.js ATTEST_TEXT; a test pins them equal).
  // DRAFTER WORDING: attorney to confirm. Neutral: no claim-handling or legal-effect language.
  var ATTEST_TEXT = 'I confirm that the uploaded paper document carries the homeowner’s handwritten signature, and that it was signed on the date shown.';

  var PAPER_TYPES = [
    { value: 'contract', label: 'Contract' },
    { value: 'proposal', label: 'Proposal' },
    { value: 'work_authorization', label: 'Work authorization' },
    { value: 'change_order', label: 'Change order' },
    { value: 'certificate_of_completion', label: 'Certificate of completion' },
    { value: 'other', label: 'Other signed paper' }
  ];

  function todayStr() {
    var d = new Date();
    var m = String(d.getMonth() + 1); var day = String(d.getDate());
    return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
  }

  // The generated documents of this kind on this customer: the paper is the signed copy of one of these.
  function originalsFor(docType) {
    return (window._customerDocs || []).filter(function (d) {
      return d && d.generated && d.docType === docType && d.htmlPath && !d.deleted;
    });
  }

  // '' when the form is good, else the sentence to show the rep.
  function checkForm(f) {
    var ok = PAPER_TYPES.some(function (t) { return t.value === (f && f.docType); });
    if (!ok) return 'Choose what kind of document this is.';
    var s = String((f && f.signedOn) || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'Enter the date the homeowner signed.';
    if (s > todayStr()) return 'The signing date cannot be in the future.';
    return '';
  }

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'style') el.setAttribute('style', attrs[k]);
      else el.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }

  var FIELD = 'width:100%;box-sizing:border-box;font-size:16px;padding:10px;border:1px solid #DFE2E7;border-radius:8px;font-family:inherit;';
  var LABEL = 'display:block;font-size:12px;font-weight:700;color:#4C4C4D;margin:12px 0 4px;';

  // A small modal. fields = builder(box) -> reader(); resolves reader() on OK, null on cancel.
  // Inputs are 16px so an iPhone does not zoom into them.
  function modal(title, intro, build, okLabel) {
    return new Promise(function (resolve) {
      var overlay = h('div', { style: 'position:fixed;inset:0;background:rgba(18,34,61,.55);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;' });
      var box = h('div', { role: 'dialog', 'aria-modal': 'true', style: 'background:#fff;color:#14181F;border-radius:14px;max-width:460px;width:100%;max-height:92vh;overflow:auto;padding:18px;box-sizing:border-box;' });
      box.appendChild(h('div', { text: title, style: 'font-size:17px;font-weight:800;margin-bottom:4px;' }));
      if (intro) box.appendChild(h('div', { text: intro, style: 'font-size:13px;color:#4C4C4D;line-height:1.45;' }));
      var read = build(box);
      var err = h('div', { style: 'color:#B3261E;font-size:13px;margin-top:10px;min-height:16px;', role: 'alert' });
      box.appendChild(err);
      var cancel = h('button', { type: 'button', text: 'Cancel', style: 'flex:1;min-height:46px;font-size:15px;border:1px solid #DFE2E7;background:#fff;border-radius:10px;cursor:pointer;' });
      var okBtn = h('button', { type: 'button', text: okLabel, style: 'flex:1;min-height:46px;font-size:15px;font-weight:700;border:0;background:#BD5728;color:#fff;border-radius:10px;cursor:pointer;' });
      box.appendChild(h('div', { style: 'display:flex;gap:10px;margin-top:14px;' }, [cancel, okBtn]));
      overlay.appendChild(box);
      function close(v) { try { overlay.parentNode && overlay.parentNode.removeChild(overlay); } catch (_) {} resolve(v); }
      cancel.addEventListener('click', function () { close(null); });
      okBtn.addEventListener('click', function () {
        var v = read();
        var bad = v && v.__error;
        if (bad) { err.textContent = bad; return; }
        close(v);
      });
      document.body.appendChild(overlay);
    });
  }

  // Overridable so a test (or another surface) can answer the form without a DOM.
  var prompt = {
    collect: function (file) {
      return modal('Paper-signed copy', 'Tell the CRM what this paper is. It stays "Uploaded, not certified" until you certify it.', function (box) {
        var type = h('select', { style: FIELD }, PAPER_TYPES.map(function (t) { return h('option', { value: t.value, text: t.label }); }));
        var orig = h('select', { style: FIELD });
        var date = h('input', { type: 'date', max: todayStr(), value: todayStr(), style: FIELD });
        var wit = h('input', { type: 'text', maxlength: '80', placeholder: 'Optional', style: FIELD });
        function fillOriginals() {
          orig.textContent = '';
          orig.appendChild(h('option', { value: '', text: 'No original in the CRM' }));
          originalsFor(type.value).forEach(function (d) {
            orig.appendChild(h('option', { value: d.id, text: (d.typeName || d.name || 'Document') + (d.date ? ' - ' + new Date(d.date).toLocaleDateString() : '') }));
          });
        }
        fillOriginals();
        type.addEventListener('change', fillOriginals);
        box.appendChild(h('label', { text: 'What is this?', style: LABEL })); box.appendChild(type);
        box.appendChild(h('label', { text: 'The document it is the signed copy of', style: LABEL })); box.appendChild(orig);
        box.appendChild(h('label', { text: 'Date the homeowner signed', style: LABEL })); box.appendChild(date);
        box.appendChild(h('label', { text: 'Witness name', style: LABEL })); box.appendChild(wit);
        return function () {
          var f = { docType: type.value, originalDocId: orig.value, signedOn: date.value, witnessName: String(wit.value || '').trim().slice(0, 80) };
          var bad = checkForm(f);
          return bad ? { __error: bad } : f;
        };
      }, 'Upload');
    },
    certify: function () {
      return modal('Certify the signed copy', ATTEST_TEXT, function (box) {
        var wit = h('input', { type: 'text', maxlength: '80', placeholder: 'Optional', style: FIELD });
        box.appendChild(h('label', { text: 'Witness name (optional)', style: LABEL })); box.appendChild(wit);
        return function () { return { witnessName: String(wit.value || '').trim().slice(0, 80) }; };
      }, 'I confirm');
    }
  };

  async function collect(file) {
    var f = await prompt.collect(file);
    if (!f) return null;
    var bad = checkForm(f);
    if (bad) { if (typeof window.showToast === 'function') window.showToast(bad, 'error'); return null; }
    return { docType: f.docType, originalDocId: f.originalDocId || '', signedOn: f.signedOn, witnessName: String(f.witnessName || '').trim().slice(0, 80) };
  }

  async function callable(name) {
    if (!window._functions || !window._httpsCallable) {
      var mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
      window._functions = window._functions || mod.getFunctions();
      window._httpsCallable = window._httpsCallable || mod.httpsCallable;
    }
    return window._httpsCallable(window._functions, name);
  }

  async function certify(docId) {
    if (!docId || !window._customerId) return;
    var f = await prompt.certify();
    if (!f) return;
    try {
      var fn = await callable('attestWetSigned');
      var payload = { leadId: window._customerId, docId: docId };
      var w = String(f.witnessName || '').trim().slice(0, 80);
      if (w) payload.witnessName = w;
      await fn(payload);
      if (typeof window.showToast === 'function') window.showToast('Certified. It now counts as the signed document.', 'success');
    } catch (e) {
      if (typeof window.showToast === 'function') window.showToast('Could not certify: ' + ((e && e.message) || 'unknown'), 'error');
    }
    if (window.NBDCustomerDocs && typeof window.NBDCustomerDocs.refresh === 'function') {
      try { await window.NBDCustomerDocs.refresh(); } catch (_) {}
    }
  }

  window.NBDPaperCert = {
    ATTEST_TEXT: ATTEST_TEXT, PAPER_TYPES: PAPER_TYPES,
    originalsFor: originalsFor, checkForm: checkForm, collect: collect, certify: certify,
    _setPrompt: function (fn) { prompt = { collect: fn, certify: fn }; }
  };
})();
