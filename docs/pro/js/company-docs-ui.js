/**
 * company-docs-ui.js — the company's OWN expiring documents (2026-10-18).
 *
 *   Settings -> Company Profile -> "Company documents"  (#companyDocsMount)
 *     list with a status badge per row, add / edit / remove. Owner and
 *     company_admin edit; manager and viewer see the list read-only; a sales
 *     rep sees nothing (the rules do not let a rep read it).
 *   Home  (#homeDocExpiry)
 *     one compact warning when anything is within 30 days or expired. Hidden
 *     when everything is fine, and for people who cannot read the list.
 *
 * Data: companies/{tenant}/companyDocs (firestore.rules "COMPANY DOCUMENTS").
 * Status maths: company-docs-logic.js (pure, local calendar days). The file
 * reference is plain text saying where the paper lives; no link is ever saved
 * or rendered. Server alert: functions/company-doc-expiry.js (Agent inbox, to
 * the owner only).
 *
 * No inline handlers: delegated listeners on data attributes. Lazy bundle
 * 'companydocs' (script-loader.js), kicked by today-home.js boot and by goTo
 * ('settings').
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.NBDCompanyDocs && window.NBDCompanyDocs.__v === 1) return;

  var L = window.NBDCompanyDocsLogic;
  if (!L) return;
  var doc = document;
  var rows = null;         // null = not loaded yet; [] = loaded and empty
  var loadError = '';
  var editingId = null;    // null = adding
  var loadingP = null;

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); };
  var toast = function (m, k) { if (typeof window.showToast === 'function') window.showToast(m, k || 'info'); };
  function claims() { return window._userClaims || {}; }
  function uid() { return (window._user && window._user.uid) || null; }
  function tenantKey() { return claims().companyId || uid(); }
  function role() { return String(claims().role || '').toLowerCase(); }
  // Writers: the solo owner (no role claim, no foreign companyId), the company's
  // own uid-keyed owner, and company_admin. Mirrors firestore.rules companyDocWriter().
  function canWrite() {
    var c = claims(), r = role();
    if (!uid()) return false;
    if (r === 'viewer') return false;
    if (r === 'company_admin') return !!c.companyId;
    if (c.companyId) return c.companyId === uid();
    return !r;
  }
  // Readers add manager + viewer (companyDocs read rule); a sales_rep reads nothing.
  function canRead() { return canWrite() || ((role() === 'manager' || role() === 'viewer') && !!claims().companyId); }
  function ready() { return !!(window.db && window.collection && window.getDocs && tenantKey()); }

  function load(force) {
    if (!canRead() || !ready()) return Promise.resolve(rows);
    if (!force && rows) return Promise.resolve(rows);
    if (loadingP) return loadingP;
    loadingP = window.getDocs(window.collection(window.db, 'companies', tenantKey(), 'companyDocs')).then(function (snap) {
      var out = [];
      snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
      rows = out; loadError = '';
    }, function (e) {
      rows = rows || []; loadError = (e && e.message) || 'could not load';
    }).then(function () { loadingP = null; paintAll(); return rows; });
    return loadingP;
  }

  // ── Settings card ────────────────────────────────────────────────────
  function badge(st) {
    var cls = st.state === 'expired' ? 'cd-bad' : st.rank >= 2 ? 'cd-warn' : st.rank === 1 ? 'cd-soon' : st.state === 'none' ? 'cd-none' : 'cd-ok';
    return '<span class="cd-badge ' + cls + '">' + esc(st.label) + '</span>';
  }
  function settingsHtml() {
    if (!canRead()) return '';
    var today = L.localYmd();
    var editable = canWrite();
    var h = '<div class="panel mb-md"><div class="panel-hdr"><div><div class="panel-label">Insurance, licenses &amp; certifications</div><div class="panel-title">Company documents</div></div></div><div class="panel-body">' +
      '<p class="meta-12-mb16">The papers your company has to keep current. Add the expiry date and you get a warning on Home 30 days out, and a note in your Agent inbox at 30, 14 and 7 days and when it expires. Nothing here goes to a customer.</p>';
    if (rows === null) return h + '<div class="meta-10">Loading company documents…</div></div></div>';
    if (loadError) h += '<div class="body-13 cd-err">Could not load the list (' + esc(loadError) + ').</div>';
    var sum = L.summarize(rows, today);
    if (!sum.rows.length) h += '<div class="body-13">No company documents yet.' + (editable ? ' Add your insurance certificate first.' : '') + '</div>';
    else {
      h += '<ul class="cd-list">' + sum.rows.map(function (r) {
        var full = rows.filter(function (x) { return x.id === r.id; })[0] || {};
        return '<li class="cd-row"><div class="cd-main"><span class="cd-name">' + esc(r.name) + '</span>' +
          '<span class="cd-sub">' + esc(L.typeLabel(r.type)) + (r.issuer ? ' · ' + esc(r.issuer) : '') + '</span>' +
          (full.fileRef ? '<span class="cd-sub">Where it lives: ' + esc(full.fileRef) + '</span>' : '') +
          (full.notes ? '<span class="cd-sub">' + esc(full.notes) + '</span>' : '') + '</div>' +
          '<div class="cd-side">' + badge(r.status) +
          (editable ? '<span class="cd-acts"><button type="button" class="btn btn-ghost fs-11" data-cd-act="edit" data-cd-id="' + esc(r.id) + '">Edit</button>' +
            '<button type="button" class="btn btn-ghost fs-11" data-cd-act="remove" data-cd-id="' + esc(r.id) + '">Remove</button></span>' : '') +
          '</div></li>';
      }).join('') + '</ul>';
    }
    if (editable) {
      var cur = editingId ? (rows.filter(function (x) { return x.id === editingId; })[0] || {}) : {};
      h += '<div class="cd-form"><h4 class="cd-form-title">' + (editingId ? 'Edit document' : 'Add a document') + '</h4>' +
        '<div class="sf-row">' +
        '<div class="sf"><label for="cdType">Kind</label><select id="cdType">' + L.TYPES.map(function (t) { return '<option value="' + t.key + '"' + ((cur.type || 'gl_coi') === t.key ? ' selected' : '') + '>' + esc(t.label) + '</option>'; }).join('') + '</select></div>' +
        '<div class="sf"><label for="cdName">Name</label><input type="text" id="cdName" maxlength="80" value="' + esc(cur.name || '') + '" placeholder="General liability certificate"></div>' +
        '<div class="sf"><label for="cdIssuer">Issued by</label><input type="text" id="cdIssuer" maxlength="80" value="' + esc(cur.issuer || '') + '" placeholder="Insurer, state, city or manufacturer"></div>' +
        '<div class="sf"><label for="cdExpiry">Expires</label><input type="date" id="cdExpiry" value="' + esc(cur.expiry || '') + '"></div></div>' +
        '<div class="sf-row"><div class="sf"><label for="cdFileRef">Where the file lives (not a link)</label><input type="text" id="cdFileRef" maxlength="300" value="' + esc(cur.fileRef || '') + '" placeholder="Drive &gt; Company &gt; Insurance &gt; COI 2026.pdf"></div>' +
        '<div class="sf"><label for="cdNotes">Notes</label><input type="text" id="cdNotes" maxlength="1000" value="' + esc(cur.notes || '') + '" placeholder="Agent, policy renewal month, anything to remember"></div></div>' +
        '<div class="cd-formacts"><button type="button" class="btn btn-orange" data-cd-act="save">' + (editingId ? '💾 Save changes' : '＋ Add document') + '</button>' +
        (editingId ? '<button type="button" class="btn btn-ghost" data-cd-act="cancel">Cancel</button>' : '') + '</div>' +
        '<div class="meta-10">Do not put policy numbers or account numbers here.</div></div>';
    } else {
      h += '<div class="meta-10">Only the owner and company admins can change these.</div>';
    }
    return h + '</div></div>';
  }

  // ── Home strip ───────────────────────────────────────────────────────
  function homeHtml() {
    if (!canRead() || !rows) return '';
    var sum = L.summarize(rows, L.localYmd());
    if (!sum.attention.length) return '';
    var worst = sum.worst === 4;
    var list = sum.attention.slice(0, 3).map(function (r) {
      return '<li class="cd-hrow"><span class="cd-name">' + esc(r.name) + '</span>' + badge(r.status) + '</li>';
    }).join('');
    var more = sum.attention.length > 3 ? '<li class="cd-hrow cd-sub">+ ' + (sum.attention.length - 3) + ' more</li>' : '';
    return '<div class="cd-home ' + (worst ? 'cd-home-bad' : 'cd-home-warn') + '" role="region" aria-label="Company documents">' +
      '<div class="cd-hhdr"><h3 class="cd-htitle">' + (worst ? 'A company document has expired' : 'A company document expires soon') + '</h3>' +
      '<button type="button" class="cd-hbtn" data-cd-act="open">Open documents</button></div><ul class="cd-hlist">' + list + more + '</ul></div>';
  }

  function paint(el, html) {
    if (!el) return;
    if (el.__cdHtml === html && (el.firstChild || !html)) return;
    el.__cdHtml = html;
    el.innerHTML = html;
    if (el.id === 'homeDocExpiry') el.hidden = !html;
  }
  function paintAll() {
    paint(doc.getElementById('companyDocsMount'), settingsHtml());
    paint(doc.getElementById('homeDocExpiry'), homeHtml());
  }

  // ── actions ──────────────────────────────────────────────────────────
  function val(id) { var el = doc.getElementById(id); return el ? el.value : ''; }
  function save() {
    var c = L.clean({ type: val('cdType'), name: val('cdName'), issuer: val('cdIssuer'), expiry: val('cdExpiry'), notes: val('cdNotes'), fileRef: val('cdFileRef') });
    if (!c.ok) { toast(c.message, 'error'); return; }
    var t = tenantKey();
    if (!t || !canWrite() || !window.setDoc || !window.doc) { toast('Not ready yet. Try again in a moment.', 'error'); return; }
    var data = Object.assign({}, c.doc, { updatedAt: typeof window.serverTimestamp === 'function' ? window.serverTimestamp() : new Date(), updatedBy: uid() });
    var p;
    if (editingId) p = window.setDoc(window.doc(window.db, 'companies', t, 'companyDocs', editingId), data, { merge: true });
    else {
      data.createdAt = data.updatedAt;
      p = window.addDoc(window.collection(window.db, 'companies', t, 'companyDocs'), data);
    }
    Promise.resolve(p).then(function () {
      toast(editingId ? 'Saved' : 'Document added', 'success');
      editingId = null;
      return load(true);
    }, function (e) { toast((e && e.message) || 'Could not save', 'error'); });
  }
  function remove(id) {
    var t = tenantKey();
    if (!id || !t || !canWrite() || !window.deleteDoc || !window.doc) return;
    var ask = typeof window.nbdConfirm === 'function' ? window.nbdConfirm('Remove this document from the list? Renewing is better done with Edit: change the expiry date.') : Promise.resolve(window.confirm('Remove this document from the list?'));
    Promise.resolve(ask).then(function (yes) {
      if (!yes) return null;
      return window.deleteDoc(window.doc(window.db, 'companies', t, 'companyDocs', id)).then(function () { toast('Removed', 'success'); return load(true); });
    }).catch(function (e) { toast((e && e.message) || 'Could not remove', 'error'); });
  }
  function openSettings() {
    if (typeof window.goTo === 'function') window.goTo('settings');
    var tries = 0;
    (function go() {
      if (typeof window.switchSettingsTab === 'function' && doc.getElementById('stab-panel-company-profile')) { window.switchSettingsTab('company-profile'); return; }
      if (++tries < 20) setTimeout(go, 250);
    })();
  }

  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-cd-act]') : null;
    if (!t) return;
    var a = t.getAttribute('data-cd-act');
    if (a === 'open') { ev.preventDefault(); openSettings(); return; }
    if (!t.closest('#companyDocsMount')) return;
    if (a === 'save') save();
    else if (a === 'cancel') { editingId = null; paintAll(); }
    else if (a === 'edit') { editingId = t.getAttribute('data-cd-id'); paintAll(); var n = doc.getElementById('cdName'); if (n && n.focus) n.focus(); }
    else if (a === 'remove') remove(t.getAttribute('data-cd-id'));
  });

  // ── wiring: Settings tab hook + Home mount (Home is a template mounted on navigation) ──
  function installTabHook() {
    var prev = window.switchSettingsTab;
    if (typeof prev !== 'function') return false;
    if (prev.__cdWrapped) return true;
    var wrapped = function (tab) {
      var out = prev.apply(this, arguments);
      if (tab === 'company-profile') { paintAll(); load(true); }
      return out;
    };
    Object.keys(prev).forEach(function (k) { try { wrapped[k] = prev[k]; } catch (_) { /* read-only flag */ } });
    wrapped.__cdWrapped = true;
    window.switchSettingsTab = wrapped;
    return true;
  }
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(function () { queued = false; if (rows === null) load(); else paintAll(); });
  }
  function boot() {
    if (!installTabHook()) {
      var tries = 0;
      var iv = setInterval(function () { if (installTabHook() || ++tries > 120) clearInterval(iv); }, 500);
    }
    try { new MutationObserver(schedule).observe(doc.body, { childList: true, subtree: true }); } catch (_) { /* the timer still paints */ }
    setInterval(function () { if (!doc.hidden) schedule(); }, 30 * 60000);   // the date rolls over at midnight
    schedule();
    var n = 0;   // auth / Firestore may not be up yet: ask again until the first load has run
    var iv2 = setInterval(function () { if (rows !== null || (!canRead() && uid()) || ++n > 90) { clearInterval(iv2); return; } schedule(); }, 1000);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDCompanyDocs = { __v: 1, load: load, render: paintAll, _settingsHtml: settingsHtml, _homeHtml: homeHtml, _set: function (r) { rows = r; paintAll(); } };
})();
