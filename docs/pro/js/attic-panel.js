/**
 * attic-panel.js - the rep's Attic check panel (phase 3, flag docAtticAckV1, default OFF).
 *
 * The rep records the attic on the job: scope (Q22), inspected or not (with the reason and who), what was seen with the
 * photos each needs (Q69), the ventilation numbers and the recommendations (only lines with a price show, Q28), then makes
 * the acknowledgment for the homeowner to sign. The re-roof contract is blocked until it is signed (the server decides;
 * see functions/attic-gate.js). An owner or admin can record "proceed anyway" with a reason when the homeowner will not
 * sign the not-inspected page (Q18). A declined or scheduling reason creates the free later check as a rep task (Q17, Q71).
 *
 * Strict CSP: no inline handlers or scripts; one delegated listener. Photos go through the CRM's own photo upload
 * (PhotoEngine.uploadFromFile: EXIF-stripped, re-encoded copies on the job). Off, or on any page but the customer page: nothing runs.
 */
(function () {
  'use strict';
  var PATH = (window.location && window.location.pathname) || '';
  if (!/\/pro\/customer(?:\.html)?$/.test(PATH)) return;
  var w = window;
  var BTN_ID = 'atticOpenBtn';
  var MODAL_ID = 'atticPanelModal';
  var S = null;   // { leadId, rec, scope, urls, problems, busy }

  function AA() { return w.NBDAtticAck || null; }
  function on() { return !!(AA() && w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled('docAtticAckV1')); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function say(m, kind) { if (typeof w.showToast === 'function') w.showToast(m, kind || 'info'); else console.log(m); }
  function terms() {
    var CS = w.NBDClauseSet, cp = (w._legal ? w._legal() : w._companyProfile) || {};
    var isNbd = !(w._brand && w._brand() && w._brand().legalName && w._brand().legalName !== 'No Big Deal Home Solutions');
    return CS && CS.paymentTermsFor ? CS.paymentTermsFor(cp.paymentTerms, isNbd) : { atticFreeCheckDays: isNbd ? 3 : null };
  }
  function prices() { return (w.NBD_ESTIMATE_CONFIG && w.NBD_ESTIMATE_CONFIG.atticRecommendationPrices) || {}; }
  function lead() { return w._leadDoc || {}; }

  // ── Open ─────────────────────────────────────────────────────────
  async function open() {
    if (!on()) return;
    var id = w._customerId, L = lead();
    if (!id) { say('Open a customer first.', 'warning'); return; }
    var est = null;
    try {
      if (L.primaryEstimateId && w.getDoc && w.doc) { var es = await w.getDoc(w.doc(w.db, 'estimates', L.primaryEstimateId)); est = es && es.exists && es.exists() ? es.data() : null; }
    } catch (_) { est = null; }
    var rec = L.atticCheck && typeof L.atticCheck === 'object' ? JSON.parse(JSON.stringify(L.atticCheck)) : { status: 'inspected', conditions: {}, vent: {}, recs: [], photos: [] };
    rec.conditions = rec.conditions || {}; rec.vent = rec.vent || {}; rec.recs = rec.recs || []; rec.photos = rec.photos || [];
    var sc = AA().effectiveScope(L, est);
    // Review 2026-11-18 (finding 1): the scope can be raised here, never lowered (an owner or admin lowers it with a reason).
    S = { leadId: id, rec: rec, scope: sc, minScope: sc, urls: {}, problems: [], busy: false };
    mount(); render();
    if (w.nbdModal && typeof w.nbdModal.open === 'function') w.nbdModal.open(MODAL_ID);
    else document.getElementById(MODAL_ID).setAttribute('aria-hidden', 'false');
  }
  function close() {
    if (w.nbdModal && typeof w.nbdModal.close === 'function') w.nbdModal.close(MODAL_ID);
    else { var m = document.getElementById(MODAL_ID); if (m) m.setAttribute('aria-hidden', 'true'); }
  }
  function mount() {
    if (document.getElementById(MODAL_ID)) return;
    var m = document.createElement('div');
    m.id = MODAL_ID; m.className = 'modal-bg'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-hidden', 'true');
    m.innerHTML = '<div class="modal-content"><div id="atticPanelBody"></div></div>';
    document.body.appendChild(m);
  }

  // ── Render ───────────────────────────────────────────────────────
  function field(label, inner) { return '<label class="attic-f"><span>' + esc(label) + '</span> ' + inner + '</label>'; }
  function photoBtn(kind, label) {
    var n = (S.rec.photos || []).filter(function (p) { return p.kind === kind; }).length;
    return '<span class="attic-ph"><label class="btn">' + esc(label) + ' (' + n + ')<input type="file" accept="image/*" data-attic-photo="' + esc(kind) + '" hidden></label></span>';
  }
  function render() {
    var A = AA(), X = A.TEXT, r = S.rec, host = document.getElementById('atticPanelBody');
    if (!host) return;
    var h = '<h3>Attic check</h3>';
    h += field('Scope of this job', '<select data-attic-f="scope">' + A.SCOPES.map(function (s) { return '<option value="' + s + '"' + (S.scope === s ? ' selected' : '') + (A.scopeRank(s) < A.scopeRank(S.minScope) ? ' disabled' : '') + '>' + esc(A.SCOPE_LABELS[s]) + '</option>'; }).join('') + '</select>');
    if (A.scopeRank(S.minScope) > 0) h += '<p class="attic-note">The scope can be raised, not lowered here. If the job really is not a re-roof, the company owner or an admin records that with a reason.</p>';
    if (S.scope === 'repair') h += '<p class="attic-note">A repair does not need the form; it can be offered.</p>';
    if (!A.needsForm(S.scope) && S.scope !== 'repair') h += '<p class="attic-note">No attic form is used on this job.</p>';
    h += '<div class="attic-f"><label><input type="radio" name="atticStatus" data-attic-f="status" value="inspected"' + (r.status !== 'not_inspected' ? ' checked' : '') + '> We inspected the attic</label> ' +
      '<label><input type="radio" name="atticStatus" data-attic-f="status" value="not_inspected"' + (r.status === 'not_inspected' ? ' checked' : '') + '> We did not inspect the attic</label></div>';
    if (r.status !== 'not_inspected') {
      h += field('Date inspected', '<input type="date" data-attic-f="inspectedOn" value="' + esc(r.inspectedOn || '') + '">');
      h += field('Access point', '<select data-attic-f="accessPoint"><option value=""></option>' + A.ACCESS.map(function (a) { return '<option' + (r.accessPoint === a ? ' selected' : '') + '>' + esc(a) + '</option>'; }).join('') + '</select>');
      h += '<div class="attic-f">' + photoBtn('overview', 'Overview photo') + '</div><h4>What we saw (each ticked box needs a photo)</h4>';
      X.CONDITIONS.forEach(function (t, i) {
        var k = A.CONDITION_KEYS[i];
        h += '<div class="attic-f"><label><input type="checkbox" data-attic-f="cond.' + k + '"' + (r.conditions[k] ? ' checked' : '') + '> ' + esc(t.replace(/\*\*/g, '')) + '</label>' + (r.conditions[k] && k !== 'none' ? photoBtn('cond:' + k, 'Photo') : '') + '</div>';
        if (k === 'other' && r.conditions.other) h += field('Describe', '<input type="text" maxlength="200" data-attic-f="conditionOther" value="' + esc(r.conditionOther || '') + '">');
      });
      h += field('Notes', '<input type="text" maxlength="300" data-attic-f="notes" value="' + esc(r.notes || '') + '">');
      h += '<h4>Ventilation numbers (approximate)</h4>';
      [['floorSqFt', 'Attic floor area (sq ft)'], ['neededArea', 'Vent area needed (sq in)'], ['neededIntake', 'Needed: intake'], ['neededExhaust', 'Needed: exhaust'], ['nowIntake', 'Now: intake'], ['nowExhaust', 'Now: exhaust'], ['manufacturer', 'Shingle manufacturer']].forEach(function (p) {
        h += field(p[1], '<input type="text" maxlength="40" data-attic-f="vent.' + p[0] + '" value="' + esc(r.vent[p[0]] == null ? '' : r.vent[p[0]]) + '">');
      });
      h += field('Rule used', '<select data-attic-f="vent.rule"><option value=""></option>' + A.RULES.map(function (x) { return '<option value="' + x + '"' + (r.vent.rule === x ? ' selected' : '') + '>' + (x === 'code' ? "code official's requirement" : x) + '</option>'; }).join('') + '</select>');
      h += '<h4>Our recommendations</h4><p class="attic-note">Only a line with a price prints. A line with no price stays hidden until Jo prices it.</p>';
      var priced = {}; A.recommendationLines(Object.assign({}, r, { recs: A.REC_DEFS.map(function (d) { return { id: d.id, qty: 1 }; }) }), terms(), prices()).forEach(function (l) { priced[l.id] = true; });
      A.REC_DEFS.forEach(function (d) {
        var cur = (r.recs || []).filter(function (c) { return c.id === d.id; })[0];
        var label = X.REC_LABELS[d.label].replace(/^\{\{|\}\}$/g, '').replace(/\bN\b/, d.unit || '');
        h += '<div class="attic-f"><label><input type="checkbox" data-attic-f="rec.' + d.id + '"' + (cur ? ' checked' : '') + '> ' + esc(label) + (priced[d.id] ? '' : ' (no price set: hidden)') + '</label>' +
          (cur && d.per === 'unit' ? ' <input type="number" min="1" step="1" data-attic-f="recq.' + d.id + '" value="' + esc(cur.qty || '') + '"> ' + esc(d.unit) : '') + '</div>';
      });
    } else {
      h += field('Reason', '<select data-attic-f="reason"><option value=""></option>' + A.REASONS.map(function (x) {
        var i = A.REASON_LINE[x], t = X.REASONS[i].replace(/\*\*/g, '').replace(/\{\{[^}]*\}\}/g, '').replace(/\(Whose schedule:[^)]*\)/, '').replace(/\[ \]\s*/g, '');
        if (x === 'scheduling_homeowner') t += ' (homeowner\'s schedule)'; else if (x === 'scheduling_nbd') t += ' (our schedule)';
        return '<option value="' + x + '"' + (r.reason === x ? ' selected' : '') + '>' + esc(t) + '</option>';
      }).join('') + '</select>');
      if (r.reason) h += '<p class="attic-note">Who could not: ' + esc(A.REASON_WHO[r.reason] || 'see the note') + '.' + (r.reason === 'scheduling_nbd' ? ' A missed visit on our side is never written as the homeowner\'s choice; offer a make-up visit.' : '') + '</p>';
      if (r.reason === 'other') h += field('Describe', '<input type="text" maxlength="200" data-attic-f="reasonText" value="' + esc(r.reasonText || '') + '">');
      if (r.reason === 'no_access' || r.reason === 'unsafe') h += '<div class="attic-f">' + photoBtn('access', 'Photo of the access') + '</div>';
      h += field('Notes', '<input type="text" maxlength="300" data-attic-f="notes" value="' + esc(r.notes || '') + '">');
    }
    if (S.problems.length) h += '<ul class="attic-problems">' + S.problems.map(function (p) { return '<li>' + esc(p.message) + '</li>'; }).join('') + '</ul>';
    h += '<div class="attic-actions"><button type="button" class="btn" data-attic-act="save">Save record</button> ' +
      '<button type="button" class="btn btn-orange" data-attic-act="form">Make the form for signing</button> ' +
      '<button type="button" class="btn" data-attic-act="override">Owner: proceed without a signed page</button> ' +
      '<button type="button" class="btn" data-attic-act="close">Close</button></div>';
    host.innerHTML = h;
  }

  // ── Edit ─────────────────────────────────────────────────────────
  function setField(path, el) {
    var r = S.rec, v = el.type === 'checkbox' ? el.checked : el.value;
    if (path === 'scope') { if (AA().scopeRank(v) >= AA().scopeRank(S.minScope)) S.scope = v; return true; }
    if (path === 'status') { r.status = v; return true; }
    if (path.indexOf('cond.') === 0) { r.conditions[path.slice(5)] = v === true; return true; }
    if (path.indexOf('vent.') === 0) { r.vent[path.slice(5)] = v; return false; }
    if (path.indexOf('rec.') === 0) {
      var id = path.slice(4); r.recs = (r.recs || []).filter(function (c) { return c.id !== id; });
      if (v === true) r.recs.push({ id: id, qty: 1 });
      return true;
    }
    if (path.indexOf('recq.') === 0) { var q = Number(v); (r.recs || []).forEach(function (c) { if (c.id === path.slice(5)) c.qty = q; }); return false; }
    r[path] = v;
    return path === 'reason';
  }
  async function addPhoto(kind, file) {
    if (!file || !w.PhotoEngine || typeof w.PhotoEngine.uploadFromFile !== 'function') { say('Photo upload is not ready on this page. Reload and try again.', 'error'); return; }
    S.busy = true;
    try {
      var p = await w.PhotoEngine.uploadFromFile(S.leadId, file, ['attic'], 'Attic: ' + kind);
      if (p && p.id) { S.rec.photos.push({ id: p.id, kind: kind }); S.urls[p.id] = p.url || p.downloadURL || ''; }
      else say('The photo did not save. Try again.', 'error');
    } catch (e) { say('The photo did not save: ' + (e && e.message || e), 'error'); }
    S.busy = false; render();
  }
  function clean(rec) {
    var o = JSON.parse(JSON.stringify(rec));
    o.version = AA().VERSION; o.who = AA().REASON_WHO[o.reason] || null;
    o.recordedBy = (w._user && w._user.uid) || null; o.recordedAt = new Date().toISOString();
    return o;
  }
  async function save(quiet) {
    var A = AA(), probs = A.validate(S.rec);
    if (S.rec.status === 'not_inspected') { delete S.rec.inspectedOn; }
    S.problems = probs;
    if (probs.length) { render(); say('The attic record is not complete: ' + probs[0].message, 'warning'); return false; }
    if (!w.updateDoc || !w.doc || !w.db) { say('Could not save here. Reload and try again.', 'error'); return false; }
    var rec = clean(S.rec);
    await w.updateDoc(w.doc(w.db, 'leads', S.leadId), { atticCheck: rec, scope: S.scope });
    if (w._leadDoc && w._leadDoc.id === S.leadId) { w._leadDoc.atticCheck = rec; w._leadDoc.scope = S.scope; }
    await freeCheckTask(rec);
    if (!quiet) say('Attic record saved.', 'success');
    render();
    return true;
  }
  // Q17, Q71: the free later check is a rep task, due atticFreeCheckDays before the start date (else contract date + 7 days).
  async function freeCheckTask(rec) {
    var A = AA();
    if (!A.wantsFreeCheck(rec) || rec.freeCheckTaskCreated || !w.addDoc || !w.collection) return;
    var L = lead(), days = terms().atticFreeCheckDays;
    var start = /^\d{4}-\d{2}-\d{2}$/.test(String(L.scheduledDate || '')) ? Date.parse(L.scheduledDate + 'T12:00:00') : null;
    var due = A.freeCheckDue({ startMs: start, contractMs: Date.now(), days: typeof days === 'number' ? days : null });
    if (due == null) return;
    var ymd = new Date(due).toISOString().slice(0, 10);
    var title = 'Offer the free attic check before the start date';
    await w.addDoc(w.collection(w.db, 'leads', S.leadId, 'tasks'), {
      leadId: S.leadId, userId: (w._user && w._user.uid) || null, title: title, text: title, dueDate: ymd, priority: 'normal', done: false,
      notes: 'The attic was not inspected (' + rec.reason + '). A check is free if asked for at least ' + (days == null ? 'a few' : days) + ' days before the start date.',
      source: 'attic-ack', createdAt: w.serverTimestamp ? w.serverTimestamp() : new Date(), createdBy: (w._user && w._user.email) || 'Attic check'
    });
    S.rec.freeCheckTaskCreated = true;
    await w.updateDoc(w.doc(w.db, 'leads', S.leadId), { 'atticCheck.freeCheckTaskCreated': true });
  }
  async function makeForm() {
    var A = AA();
    if (!(await save(true))) return;
    if (!A.needsForm(S.scope) && S.scope !== 'repair') { say('This job does not use the attic form.', 'warning'); return; }
    if (!w.NBDDocGen || typeof w.NBDDocGen.generate !== 'function') { say('The document tools are still loading. Try again in a moment.', 'warning'); return; }
    var L = lead();
    var type = S.rec.status === 'not_inspected' ? 'attic_not_inspected' : 'attic_acknowledgment';
    close();
    var name = [L.firstName, L.lastName].filter(Boolean).join(' ') || L.name || '';
    w.NBDDocGen.generate(type, { leadId: S.leadId, homeownerName: name, address: L.address || '', atticCheck: S.rec, atticPhotoUrls: S.urls, formDate: new Date().toISOString().slice(0, 10), contractDate: new Date().toISOString().slice(0, 10),
      signers: ((w.NBDDocGen.DOCUMENT_TYPES[type] || {}).defaultSigners || []).map(function (s) { return { role: s.role, label: s.label, required: !!s.required }; }) });
  }
  async function override() {
    var reason = typeof w.prompt === 'function' ? w.prompt('The homeowner will not sign the not-inspected page. Why is the job proceeding? (recorded with your name; owner or admin only)') : '';
    if (!reason) return;
    if (!w._functions || !w._httpsCallable) { say('Not ready. Reload and try again.', 'error'); return; }
    try {
      await w._httpsCallable(w._functions, 'recordAtticOverride')({ leadId: S.leadId, reason: reason });
      say('Recorded. The contract can now be sent. The form stays logged as notice, never as signed.', 'success');
    } catch (e) { say((e && e.message) || 'Only the company owner or an admin can do that.', 'error'); }
  }

  // ── Wiring (one delegated listener each; no inline handlers) ─────
  function addButton() {
    if (document.getElementById(BTN_ID)) return;
    var t = document.getElementById('docCreateModalTitle');
    if (!t || !t.parentNode) return;
    var b = document.createElement('button');
    b.type = 'button'; b.id = BTN_ID; b.className = 'btn'; b.setAttribute('data-attic-act', 'open'); b.textContent = 'Attic check';
    t.parentNode.appendChild(b);
  }
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-attic-act]') : null;
    if (!el || !on()) return;
    var a = el.getAttribute('data-attic-act');
    if (a === 'open') open();
    else if (!S) return;
    else if (a === 'save') save(false).catch(function (x) { say('Not saved: ' + (x && x.message || x), 'error'); });
    else if (a === 'form') makeForm().catch(function (x) { say('Could not make the form: ' + (x && x.message || x), 'error'); });
    else if (a === 'override') override();
    else if (a === 'close') close();
  });
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (!S || !el || !el.getAttribute) return;
    var ph = el.getAttribute('data-attic-photo');
    if (ph) { addPhoto(ph, el.files && el.files[0]); return; }
    var f = el.getAttribute('data-attic-f');
    if (f && setField(f, el)) render();
  });
  function boot() { if (on()) addButton(); }
  if (w.NBDFlags && typeof w.NBDFlags.onReady === 'function') w.NBDFlags.onReady(boot);
  document.addEventListener('DOMContentLoaded', boot);
  w.addEventListener('load', boot);
  w.NBDAtticPanel = { open: open, _state: function () { return S; } };
})();
