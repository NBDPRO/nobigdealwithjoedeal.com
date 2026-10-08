// ── Customer Documents — the single source of truth ─────────────────
//
// WHY THIS MODULE EXISTS (2026-08-18)
//
// The customer page had FOUR "documents" surfaces reading THREE different
// Firestore locations, and the one location documents actually land in was
// read by only one of them:
//
//   Overview → Documents (#docList)      read top-level `documents`
//   Documents tab → Shared (#sharedDocList)  read `lead_documents`
//   Documents tab → Generated (#generatedDocList)  read nothing (DOM-only)
//   Documents tab → #signedDocsList      read leads/{id}/documents  ← the real one
//
// Every real writer — the document generator, the signed-doc upload, and
// drag-and-drop — writes to `leads/{leadId}/documents`. So a customer with
// a stack of generated contracts and invoices showed "No documents yet" on
// the Overview, an empty "Shared Documents" panel (nothing in the client or
// in functions/ has EVER written `lead_documents`), and a "Generated
// Documents" list that was pure DOM and vanished on reload. The only honest
// panel was buried under the upload buttons — and it ran off a
// `setTimeout(…, 2000)` at DOMContentLoaded, so on a cold load it fired
// before window._customerId existed and silently gave up forever.
//
// This module owns the store: one read, one normalized shape, one cache,
// every surface painted from it. Loaders elsewhere delegate here. It is
// called from loadCustomerData() with the real lead id — no timers, no race.
//
// Legacy rows in the top-level `documents` collection (written by the old
// Overview upload modal before the subcollection existed) are merged in on a
// best-effort second read so nothing that predates the consolidation is
// orphaned. They carry `legacy: true` so deletes target the right path.
(function () {
  'use strict';

  var LEAD_SUB = 'documents';          // leads/{leadId}/documents  (canonical)
  var LEGACY_TOP = 'documents';        // top-level, {leadId, userId}  (historical)

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Firestore Timestamp | ISO string | Date | null → Date | null
  function toDate(v) {
    if (!v) return null;
    if (typeof v.toDate === 'function') { try { return v.toDate(); } catch (e) { return null; } }
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  // The three writers stamp three different field names for the same thing.
  // Generated docs: {filename, typeName, htmlPath, createdAt}. Signed/DnD
  // uploads: {name, url, uploadedAt}. Legacy top-level: {filename, url,
  // uploadedAt}. Normalize once here so no renderer has to know that.
  //
  // Generated docs deliberately carry NO direct URL: `htmlUrl` was a
  // getDownloadURL result — a permanent, no-auth, unrevocable token URL for
  // a document holding the homeowner's name, address, price and signature
  // (see functions/document-view.js). Rows with an htmlPath re-open through
  // the authed getDocumentHtml callable instead; htmlUrl is honored only for
  // pre-migration rows that never recorded a path, since rows that recorded
  // both may have had their token revoked by the orphan sweep.
  function normalize(id, d, legacy) {
    var url = d.url || d.signedDocumentUrl || (d.htmlPath ? '' : (d.htmlUrl || ''));
    var signedAt = toDate(d.signedAt);
    // Explicit lifecycle field (2026-09-17) — draft/sent/signed, stamped by
    // the generator, createSignRequest, submitSignature, onPersistFinalized
    // and the signed-doc upload. Whitelisted: this is Firestore data, not a
    // typed value. Rows written before this field existed have none — fall
    // back to the old presence-based inference so nothing needs a backfill.
    var status = (d.status === 'draft' || d.status === 'sent' || d.status === 'signed')
      ? d.status : null;
    return {
      id: id,
      legacy: !!legacy,
      name: d.name || d.filename || d.typeName || 'Document',
      // `type` is only present on generator output — it is what separates a
      // generated contract from an uploaded scan.
      docType: d.type && !/\//.test(String(d.type)) ? d.type : null,
      typeName: d.typeName || null,
      generated: !!(d.typeName || (d.type && !/\//.test(String(d.type)))),
      url: /^https?:/i.test(url) ? url : '',
      htmlPath: (typeof d.htmlPath === 'string' && d.htmlPath) ? d.htmlPath : null,
      // Filed PDFs (money-paper.js: NBD-500 invoice / NBD-510 receipt). No
      // stored URL — View asks getDocumentPdfUrl for a 10-minute signed link.
      pdfPath: (typeof d.pdfPath === 'string' && d.pdfPath) ? d.pdfPath : null,
      docCode: (typeof d.docCode === 'string' && d.docCode) ? d.docCode : null,
      size: Number.isFinite(+d.size) ? +d.size : null,
      date: toDate(d.uploadedAt) || toDate(d.createdAt) || toDate(d.date) || signedAt,
      status: status,
      signed: status ? status === 'signed'
        : !!(d.signedRemotely || d.signedAt || /signed/i.test(String(d.source || ''))),
      signedAt: signedAt,
      source: d.source || null,
      // A filed photo report can be handed over as a no-login link, not just a
      // download. createReportShareToken re-signs from `storagePath` rather than
      // trusting the recorded `url`, so a row without one has nothing to share
      // and the button is not offered. Legacy top-level rows are excluded
      // because the callable addresses the lead subcollection.
      shareable: !legacy && d.source === 'photo_report'
        && typeof d.storagePath === 'string' && !!d.storagePath,
      shareUrl: (typeof d.shareUrl === 'string' && /^https?:/i.test(d.shareUrl)) ? d.shareUrl : '',
      reportNumber: (typeof d.reportNumber === 'string' && d.reportNumber) ? d.reportNumber : '',
      deleted: d.deleted === true,
      // "Send for review" (2026-10-03): an attached estimate PDF — Jo builds
      // them outside the CRM — can be sent as the tracked /report/<token>
      // link (functions/estimate-send.js). Never a generated HTML doc (no
      // PDF), never a photo report (it has its own Share link), never a
      // legacy top-level row (the callable reads the lead subcollection).
      isPdf: !legacy && d.deleted !== true && !d.htmlPath && d.source !== 'photo_report'
        && (/^application\/pdf\b/i.test(String(d.type || ''))
          || /\.pdf$/i.test(String(d.filename || d.name || ''))
          || (typeof d.pdfPath === 'string' && !!d.pdfPath)),
      reviewToken: (d.source !== 'photo_report' && typeof d.shareToken === 'string'
        && /^[A-Z0-9]{10,64}$/.test(d.shareToken)) ? d.shareToken : '',
      // Documents shelf (2026-09-16): gates whether an UPLOADED row appears
      // in the homeowner portal (functions/portal.js's getHomeownerPortalView
      // — generated rows are always visible there, no flag needed). Same
      // default-closed opt-in shape as photos' sharedWithHomeowner.
      sharedWithHomeowner: d.sharedWithHomeowner === true
    };
  }

  // ── Read ──────────────────────────────────────────────────────────
  //
  // The canonical subcollection read is UNFILTERED and unordered on
  // purpose: it needs no composite index (so it cannot fail closed the way
  // an index-less query does) and the collection is per-lead and small.
  // Sorting and the soft-delete filter happen in memory below.
  async function fetchAll(leadId) {
    if (!leadId || !window.db || !window.getDocs || !window.collection) return [];
    var rows = [];

    try {
      var snap = await window.getDocs(
        window.collection(window.db, 'leads', leadId, LEAD_SUB)
      );
      snap.docs.forEach(function (d) { rows.push(normalize(d.id, d.data(), false)); });
    } catch (e) {
      // A failure here is a REAL failure — surface it rather than letting the
      // caller paint an empty state that looks like "this customer has none".
      console.error('[customer-documents] subcollection read failed:', e && e.message);
      throw e;
    }

    // Legacy top-level rows. Best-effort: a missing index or a tightened
    // rule must not take down the canonical list.
    try {
      var uid = window.auth && window.auth.currentUser && window.auth.currentUser.uid;
      if (uid && window.query && window.where) {
        var legacySnap = await window.getDocs(window.query(
          window.collection(window.db, LEGACY_TOP),
          window.where('leadId', '==', leadId),
          window.where('userId', '==', uid)
        ));
        legacySnap.docs.forEach(function (d) { rows.push(normalize(d.id, d.data(), true)); });
      }
    } catch (e) {
      console.warn('[customer-documents] legacy read skipped:', e && e.message);
    }

    return rows
      .filter(function (r) { return !r.deleted; })
      .sort(function (a, b) {
        return (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0);
      })
      .filter(dedupe());
  }

  // A document migrated from the top-level collection into the subcollection
  // exists in BOTH reads, and without this it renders twice on the record.
  //
  // The key is the Storage URL, NOT the name. Two rows pointing at the same
  // object are the same document by any reading; two rows sharing a filename
  // are NOT necessarily the same file, and collapsing those would HIDE a real
  // document. Hiding one is far worse than showing one twice — that asymmetry
  // is why this errs toward keeping rows. Rows with no URL are never deduped,
  // because there is nothing to prove sameness with.
  //
  // Applied after the sort, so the survivor is the newest of the pair; and
  // canonical rows win ties over legacy ones, since deletes and every future
  // write target the subcollection.
  function dedupe() {
    var seen = Object.create(null);
    return function (r) {
      if (!r.url) return true;
      var prior = seen[r.url];
      if (!prior) { seen[r.url] = r; return true; }
      // Already kept one. If we kept the legacy copy and this is canonical,
      // swap in place so the retained row is the one deletes can reach.
      if (prior.legacy && !r.legacy) {
        prior.id = r.id;
        prior.legacy = false;
      }
      return false;
    };
  }

  // ── Render ────────────────────────────────────────────────────────
  var ICONS = {
    proposal: '📄', contract: '📝', work_authorization: '✅', scope_of_work: '📋',
    invoice: '💰', estimate: '💰', warranty: '✅', insurance: '📋',
    inspectionHomeowner: '🔍', inspectionInsurance: '🔍'
  };

  function iconFor(doc) {
    return ICONS[doc.docType] || (doc.generated ? '📝' : '📄');
  }

  function metaLine(doc) {
    var bits = [];
    if (doc.date) bits.push(doc.date.toLocaleDateString());
    if (doc.size != null) bits.push((doc.size / 1024).toFixed(0) + ' KB');
    if (doc.signed) {
      bits.push('✓ Signed' + (doc.signedAt ? ' ' + doc.signedAt.toLocaleDateString() : ''));
    } else if (doc.status === 'sent') {
      bits.push('Awaiting signature');
    } else if (doc.source === 'signed_upload' || doc.source === 'dnd_upload') {
      bits.push('Uploaded');
    }
    return bits.join(' · ');
  }

  // One row shape everywhere. CSP: no inline handlers — the View link is a
  // plain anchor (scheme-validated in normalize) and delete routes through
  // the page's data-action delegate.
  //
  // The three .doc-btn <button>s reset their UA look with
  // `font-family:inherit`, NOT the `font:inherit` shorthand they used to
  // carry (2026-09-25 phone audit). The shorthand also reset font-size, so
  // .doc-btn's 11px lost to the inherited 16px: "Share with homeowner" grew
  // to 179px and, with .doc-actions flex-shrink:0, collapsed the file name
  // to 0px on a phone and pushed the ✕ past a 360px screen. The generated
  // row's View button rendered 16px beside the 11px View links for the
  // same reason.
  function rowHtml(doc) {
    var label = esc(doc.name);
    return '<div class="doc-item" data-doc-id="' + esc(doc.id) + '">'
      + '<div class="doc-icon">' + iconFor(doc) + '</div>'
      + '<div class="doc-content" style="min-width:0;">'
      + (doc.typeName || doc.docType
          ? '<div class="doc-type">' + esc(doc.typeName || doc.docType) + '</div>' : '')
      + '<div class="doc-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + label + '</div>'
      + '<div class="doc-date">' + esc(metaLine(doc)) + '</div>'
      + '</div>'
      + '<div class="doc-actions">'
      + (doc.url
          ? '<a href="' + esc(doc.url) + '" target="_blank" rel="noopener noreferrer" class="doc-btn">View</a>'
          : (doc.htmlPath
              ? '<button type="button" class="doc-btn" data-doc-view="' + esc(doc.id) + '"'
                + ' style="background:none;border:0;cursor:pointer;font-family:inherit;">View</button>'
              : (doc.pdfPath
                  ? '<button type="button" class="doc-btn" data-doc-pdf="' + esc(doc.id) + '"'
                    + ' style="background:none;border:0;cursor:pointer;font-family:inherit;">View</button>'
                  : '')))
      // Send for review: mint the tracked link, then Jo sends it from his
      // own phone (share sheet). "Share now" when Safari needed a fresh tap.
      + (doc.isPdf
          ? '<button type="button" class="doc-btn doc-btn-plain doc-btn-review" data-doc-review="' + esc(doc.id) + '"'
            + ' title="Text or email this estimate from your phone as a tracked link">'
            + (doc.reviewPending ? '📤 Share now' : (doc.reviewToken ? '📤 Send again' : '📤 Send for review')) + '</button>'
            + (doc.reviewToken
                ? '<button type="button" class="doc-btn doc-btn-plain" data-doc-fresh="' + esc(doc.id) + '"'
                  + ' title="New link for this estimate; the old link stops working">↻ Fresh link</button>'
                : '')
          : '')
      + (doc.shareable
          ? '<button type="button" class="doc-btn" data-doc-share="' + esc(doc.id) + '"'
            + ' title="' + (doc.shareUrl
                ? 'Copy the view link for this report'
                : 'Create a no-login link the homeowner or adjuster can open on a phone') + '"'
            + ' style="background:none;border:0;cursor:pointer;font-family:inherit;">'
            + (doc.shareUrl ? 'Copy link' : 'Share link') + '</button>'
          : '')
      // Uploaded (non-generated) rows only — generated documents are always
      // homeowner-visible by construction, no toggle needed. Legacy
      // (top-level collection) rows are excluded, same reasoning as
      // `shareable` above: this flag lives on the lead subcollection.
      + (!doc.generated && !doc.legacy
          ? '<button type="button" class="doc-btn" data-doc-homeowner-share="' + esc(doc.id) + '"'
            + ' title="' + (doc.sharedWithHomeowner
                ? 'Stop showing this in the homeowner\'s portal'
                : 'Show this in the homeowner\'s portal Documents card') + '"'
            + ' style="background:none;border:0;cursor:pointer;font-family:inherit;'
            + (doc.sharedWithHomeowner ? 'color:var(--green,#2e9e5b);' : '') + '">'
            + (doc.sharedWithHomeowner ? '✓ Shared' : 'Share with homeowner') + '</button>'
          : '')
      + '<button type="button" class="btn" data-action="deleteCustomerDoc"'
      + ' data-arg="' + esc(doc.id) + '" data-arg2="' + label + '"'
      + ' title="Remove this document from the customer record"'
      + ' style="background:none;border:none;cursor:pointer;color:var(--m);font-size:13px;line-height:1;padding:4px 6px;">&#10005;</button>'
      + '</div>'
      + '</div>';
  }

  function emptyHtml(message, withCreate) {
    return '<div class="empty">'
      + '<div class="empty-icon">📄</div>' + esc(message)
      + (withCreate
          ? '<div style="margin-top:14px;"><button class="btn btn-orange" data-action="openDocCreateModal"'
            + ' style="font-size:11px;padding:8px 16px;">📝 Create your first document</button></div>'
          : '')
      + '</div>';
  }

  function paint(elId, docs, emptyMsg, withCreate) {
    var el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML = docs.length
      ? docs.map(rowHtml).join('')
      : emptyHtml(emptyMsg, withCreate);
  }

  // Every surface, painted from the one cache.
  function render() {
    var docs = window._customerDocs || [];

    // Overview — everything this customer has.
    paint('docList', docs, 'No documents yet', true);

    // Documents tab — split by origin so each panel means something.
    paint('generatedDocList', docs.filter(function (d) { return d.generated; }),
      'Generate a document above to see it here', false);
    paint('signedDocsList', docs.filter(function (d) { return !d.generated; }),
      'No uploaded documents yet', false);

    if (typeof window.nbdNavCount === 'function') window.nbdNavCount('navCountDocs', docs.length);
    if (typeof window.nbdTitleCount === 'function') window.nbdTitleCount('docsPanelTitle', 'Files', docs.length);
  }

  function paintError() {
    ['docList', 'generatedDocList', 'signedDocsList'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      // Never render "No documents yet" on a failed read — that is the lie
      // that hid this bug for so long. Say the load failed.
      el.innerHTML = '<div class="empty"><div class="empty-icon">⚠️</div>'
        + 'Could not load documents — refresh to try again</div>';
    });
  }

  // ── Public API ────────────────────────────────────────────────────
  var _inflight = null;

  /**
   * Point the "Prepare for signature" link at THIS customer.
   *
   * The envelope signing page needs a lead to attach the document to, and
   * customer.html is static markup under a CSP that forbids inline scripts —
   * so the href is stamped here, where the lead id is already known. Without
   * it the page opens with no customer and refuses the upload.
   */
  function stampEsignLink(id) {
    try {
      var a = document.getElementById('esignSetupLink');
      if (a && id) a.href = '/pro/esign-setup?lead=' + encodeURIComponent(id);
    } catch (_) {}
  }

  // ── E-sign envelopes for this customer ──────────────────────────
  // esign-setup.js creates esign_envelopes/{id} and submitEsignEnvelope writes
  // the executed copy to esign/{uid}/{leadId}/{envId}/signed.pdf — but no CRM
  // surface read either, so after "Document signed" the rep had no way to open
  // the signed agreement. Owner-scoped query (rules: ownerUid == auth.uid);
  // the signed PDF is fetched as a blob, never via a download-token URL
  // (tokens bypass storage.rules).
  // viewed / declined / expired (2026-10-04): the in-house e-sign states that
  // replaced BoldSign's — opened, said no, link ran out.
  var ENV_LABEL = { draft: 'Draft', sent: 'Sent — waiting for signature', viewed: 'Opened — not signed yet', completed: 'Signed', voided: 'Voided', declined: 'Declined', expired: 'Link expired — resend' };
  async function loadEnvelopes(id) {
    var box = document.getElementById('esignEnvelopeList');
    var uid = window._user && window._user.uid || (window.auth && window.auth.currentUser && window.auth.currentUser.uid);
    if (!box || !id || !uid || !window.db || !window.getDocs || !window.query || !window.where || !window.collection) return;
    try {
      var snap = await window.getDocs(window.query(window.collection(window.db, 'esign_envelopes'),
        window.where('ownerUid', '==', uid), window.where('leadId', '==', id)));
      var rows = [];
      snap.forEach(function (d) { rows.push(Object.assign({ id: d.id }, d.data())); });
      var ms = function (t) { return t && t.toMillis ? t.toMillis() : (t && t.seconds ? t.seconds * 1000 : 0); };
      rows.sort(function (a, b) { return ms(b.signedAt || b.sentAt || b.createdAt) - ms(a.signedAt || a.sentAt || a.createdAt); });
      if (!rows.length) { box.innerHTML = ''; return; }
      box.innerHTML = rows.map(function (e) {
        var when = ms(e.signedAt || e.sentAt || e.createdAt);
        var whenTxt = when ? new Date(when).toLocaleDateString() : '';
        var action = (e.status === 'completed' && e.signedPath)
          ? '<button type="button" class="btn btn-ghost" data-esign-open="' + esc(e.signedPath) + '" style="font-size:11px;padding:6px 12px;">Open signed PDF</button>'
          : (e.status === 'draft' || e.status === 'sent' || e.status === 'viewed' || e.status === 'declined' || e.status === 'expired')
            ? '<a class="btn btn-ghost" href="/pro/esign-setup?lead=' + encodeURIComponent(id) + '&env=' + encodeURIComponent(e.id) + '" style="font-size:11px;padding:6px 12px;text-decoration:none;">Open</a>'
            : '';
        return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--br);">' +
          '<div style="min-width:0;"><div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(e.title || 'Document') + '</div>' +
          '<div style="font-size:11px;color:var(--m);">' + esc(ENV_LABEL[e.status] || e.status || '') +
          (e.remoteSignerName || e.signerName ? ' · ' + esc(e.remoteSignerName || e.signerName) : '') +
          (whenTxt ? ' · ' + esc(whenTxt) : '') + '</div></div>' + action + '</div>';
      }).join('');
      box.querySelectorAll('[data-esign-open]').forEach(function (b) {
        b.addEventListener('click', async function () {
          var w = window.open('', '_blank'); // open now — a popup opened after an await is blocked
          try {
            var st = await import('/assets/vendor/firebase/10.12.2/firebase-storage.js');
            var blob = await st.getBlob(st.ref(window.storage, b.getAttribute('data-esign-open')));
            var url = URL.createObjectURL(blob);
            if (w) w.location.href = url; else window.open(url, '_blank');
          } catch (err) {
            if (w) w.close();
            if (typeof window.showToast === 'function') window.showToast('Couldn’t open the signed PDF: ' + ((err && err.message) || 'error'), 'error');
          }
        });
      });
    } catch (err) {
      console.warn('[customer-documents] envelopes load failed', err && err.message);
    }
  }

  async function load(leadId) {
    var id = leadId || window._customerId;
    if (!id) return [];
    stampEsignLink(id);
    loadEnvelopes(id);
    try {
      _inflight = fetchAll(id);
      window._customerDocs = await _inflight;
      render();
      return window._customerDocs;
    } catch (e) {
      window._customerDocs = [];
      paintError();
      return [];
    } finally {
      _inflight = null;
    }
  }

  function refresh() { return load(window._customerId); }

  // SOFT delete, deliberately: the Firestore row survives with
  // `deleted: true`, so a misclick is recoverable and the record of what was
  // generated is not rewritten. fetchAll filters it out. The Storage object
  // is left alone — anyone holding a link you already sent still resolves
  // it, which is the honest behaviour for a document that may already be in
  // a homeowner's inbox.
  window.deleteCustomerDoc = async function (docId, label) {
    // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
    if (window.NBDRole && !window.NBDRole.guard()) return;
    if (!docId || !window._customerId) return;
    var name = label || 'this document';
    var ask = window.nbdConfirm || function (m) { return Promise.resolve(window.confirm(m)); };
    // Legacy rows live in the top-level collection; canonical ones in the
    // lead subcollection. Target whichever this id came from.
    var entry = (window._customerDocs || []).filter(function (d) { return d.id === docId; })[0];

    // A signed contract is locked (2026-09-29, firestore.rules
    // documentIsSigned): only the lead owner or a company_admin may archive
    // it. Say so up front instead of surfacing a raw permission error.
    if (entry && entry.signed && !entry.legacy) {
      var claims = window._userClaims || {};
      var me = window._user && window._user.uid;
      var lead = window._currentLead || {};
      if (!(claims.role === 'company_admin' || (me && lead.userId === me))) {
        if (typeof showToast === 'function') showToast('Signed contracts are locked. Only the account owner or a company admin can archive one.', 'error');
        return;
      }
    }
    var okToDelete = await ask(entry && entry.signed
      ? 'Archive the signed "' + name + '"?\n\n'
        + 'Signed contracts are locked records: it is hidden from this customer record but never deleted or changed.'
      : 'Remove "' + name + '" from this customer record?\n\n'
        + 'It stops showing on the record. Anyone you already sent the link to can still open it.');
    if (!okToDelete) return;
    var ref = entry && entry.legacy
      ? window.doc(window.db, LEGACY_TOP, docId)
      : window.doc(window.db, 'leads', window._customerId, LEAD_SUB, docId);

    try {
      await window.updateDoc(ref, { deleted: true, deletedAt: new Date().toISOString() });
      if (typeof showToast === 'function') showToast('Document removed', 'success');
      await refresh();
    } catch (e) {
      console.error('deleteCustomerDoc failed:', e);
      if (typeof showToast === 'function') showToast('Could not remove: ' + (e.message || 'unknown'), 'error');
    }
  };

  // Re-open a generated document. Its HTML never had a public URL — fetch it
  // through the authed getDocumentHtml callable and render it in the same
  // sandboxed viewer the generator uses, first-party. Delegated (not inline)
  // because the CSP sets script-src-attr 'none'.
  async function viewGeneratedDoc(docId, btn) {
    if (!docId || !window._customerId) return;
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
    try {
      if (!window._functions || !window._httpsCallable) {
        var mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
        window._functions = window._functions || mod.getFunctions();
        window._httpsCallable = window._httpsCallable || mod.httpsCallable;
      }
      var fn = window._httpsCallable(window._functions, 'getDocumentHtml');
      var res = await fn({ leadId: window._customerId, docId: docId });
      var data = (res && res.data) || {};
      if (!data.html) throw new Error('Document is empty');
      if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
        window.NBDDocViewer.open({
          html: data.html,
          title: data.typeName || 'Document',
          filename: data.filename || 'document.pdf'
        });
      } else {
        throw new Error('Document viewer is not loaded');
      }
    } catch (e) {
      console.warn('viewGeneratedDoc failed:', e && e.message);
      if (typeof showToast === 'function') {
        showToast('Could not open document: ' + ((e && e.message) || 'unknown'), 'error');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label || 'View'; }
    }
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-doc-view]');
    if (!btn) return;
    e.preventDefault();
    viewGeneratedDoc(btn.getAttribute('data-doc-view'), btn);
  });

  // Open a filed PDF (NBD-500 / NBD-510). The tab is opened synchronously in
  // the click so a popup blocker allows it, then pointed at the short-lived
  // signed link once getDocumentPdfUrl returns it.
  async function viewFiledPdf(docId, btn) {
    if (!docId || !window._customerId) return;
    var tab = window.open('about:blank', '_blank');
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
    try {
      if (!window._functions || !window._httpsCallable) {
        var mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
        window._functions = window._functions || mod.getFunctions();
        window._httpsCallable = window._httpsCallable || mod.httpsCallable;
      }
      var fn = window._httpsCallable(window._functions, 'getDocumentPdfUrl');
      var res = await fn({ leadId: window._customerId, docId: docId });
      var url = res && res.data && res.data.url;
      if (!url || !/^https:/i.test(url)) throw new Error('No link came back');
      if (tab && !tab.closed) { try { tab.opener = null; } catch (_) {} tab.location.href = url; }
      else window.location.href = url;
    } catch (e) {
      if (tab && !tab.closed) tab.close();
      console.warn('viewFiledPdf failed:', e && e.message);
      if (typeof showToast === 'function') showToast('Could not open document: ' + ((e && e.message) || 'unknown'), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label || 'View'; }
    }
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-doc-pdf]');
    if (!btn) return;
    e.preventDefault();
    viewFiledPdf(btn.getAttribute('data-doc-pdf'), btn);
  });

  /**
   * Mint (or reuse) the no-login view link for a filed photo report.
   *
   * Until now a photo report could only be downloaded and attached to an email.
   * createReportShareToken accepts a lead-scoped document as of 2026-09-08, so
   * the report can be delivered the way contractors increasingly deliver them:
   * a link that opens on a phone, forwards to the adjuster, expires, and
   * records that it was viewed.
   *
   * The server reuses a live token for the same file, so tapping this twice
   * yields ONE url — revoking the link the rep actually sent then revokes the
   * right thing.
   */
  async function shareLeadDocument(docId, btn) {
    if (!docId || !window._customerId) return;
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Linking…'; }
    try {
      if (!window._functions || !window._httpsCallable) {
        var mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
        window._functions = window._functions || mod.getFunctions();
        window._httpsCallable = window._httpsCallable || mod.httpsCallable;
      }
      var fn = window._httpsCallable(window._functions, 'createReportShareToken');
      var res = await fn({ leadId: window._customerId, documentId: docId });
      var data = (res && res.data) || {};
      if (!data.shareUrl) throw new Error('No link was returned');

      var copied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(data.shareUrl);
          copied = true;
        }
      } catch (_) { /* clipboard is best-effort; the link is shown either way */ }

      if (typeof showToast === 'function') {
        showToast(copied ? '✓ View link copied — expires in 30 days'
          : '✓ View link ready: ' + data.shareUrl, 'success');
      }
      // Repaint so the button becomes "Copy link" — the row now carries a
      // shareUrl written back by the callable. Twice, for the reason
      // _fileReportOnLead does it: the server write and this read race, and
      // both are idempotent.
      await refresh();
      setTimeout(refresh, 2500);
    } catch (e) {
      console.warn('shareLeadDocument failed:', e && e.message);
      if (typeof showToast === 'function') {
        showToast('Could not create a link: ' + ((e && e.message) || 'unknown'), 'error');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label || 'Share link'; }
    }
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-doc-share]');
    if (!btn) return;
    e.preventDefault();
    shareLeadDocument(btn.getAttribute('data-doc-share'), btn);
  });

  // Documents shelf (2026-09-16): flip sharedWithHomeowner on an UPLOADED
  // row. Generated rows need no toggle — functions/portal.js's
  // getHomeownerPortalView shows them unconditionally. A rep-uploaded file
  // could be anything (internal notes, adjuster correspondence), so this
  // defaults closed and is opt-in per document — same shape as photo-review.js's
  // bulk photo-share action, just single-row and persistent (shows current
  // state, not a one-shot button).
  async function toggleHomeownerShare(docId, btn) {
    if (!docId || !window._customerId) return;
    var entry = (window._customerDocs || []).filter(function (d) { return d.id === docId; })[0];
    if (!entry || entry.legacy) return; // legacy rows aren't offered the button; guard anyway
    var next = !entry.sharedWithHomeowner;
    if (btn) btn.disabled = true;
    try {
      await window.updateDoc(
        window.doc(window.db, 'leads', window._customerId, LEAD_SUB, docId),
        { sharedWithHomeowner: next, updatedAt: new Date().toISOString() }
      );
      if (typeof showToast === 'function') {
        showToast(next ? 'Shared with the homeowner' : 'No longer shown to the homeowner', 'success');
      }
      await refresh();
    } catch (e) {
      console.warn('toggleHomeownerShare failed:', e && e.message);
      if (typeof showToast === 'function') showToast('Could not update sharing: ' + (e.message || 'unknown'), 'error');
      if (btn) btn.disabled = false;
    }
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-doc-homeowner-share]');
    if (!btn) return;
    e.preventDefault();
    toggleHomeownerShare(btn.getAttribute('data-doc-homeowner-share'), btn);
  });

  // ── Send for review (2026-10-03) ──────────────────────────────────
  // 1. createEstimateReviewLink mints (or reuses) the tracked /report/<token>
  //    link for this PDF — the row's Storage download-token URL never leaves
  //    the CRM. Nothing is stamped yet: Jo may still cancel.
  // 2. The share sheet opens with the message written (phone-share.js);
  //    without one, Messages / Mail opens and Jo confirms it went out.
  // 3. ONLY when it actually went: lead.lastSharedAt / sharedDocId / … are
  //    stamped and recordEstimateShared fires the job spine's estimate_shared.
  // Nothing is ever sent from a server.
  var _reviewPending = Object.create(null); // docId → { text, link }

  async function _docCallable(name, data) {
    if (!window._functions || !window._httpsCallable) {
      var mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
      window._functions = window._functions || mod.getFunctions();
      try {
        var emu = await import('./nbd-emulator-connect.js');
        await emu.connectEmulatorsIfLocal({ functions: window._functions });
      } catch (_) { /* prod: no emulator module needed */ }
      window._httpsCallable = window._httpsCallable || mod.httpsCallable;
    }
    var res = await window._httpsCallable(window._functions, name)(data);
    return (res && res.data) || {};
  }

  function _reviewText(url) {
    var lead = window._currentLead || {};
    var EF = window.NBDEstimateFollowups;
    var brand = '';
    try { var b = typeof window._brand === 'function' ? window._brand() : null; brand = (b && (b.shortName || b.name)) || ''; } catch (_) {}
    var from = EF ? EF.fromLine(window._user, brand) : '';
    var first = String(lead.firstName || '').trim().split(/\s+/)[0] || '';
    return EF ? EF.reviewMessage({ firstName: first, from: from, url: url })
      : 'Hi' + (first ? ' ' + first : '') + ', here’s your roof estimate to look over:\n\n' + url;
  }

  function _setPending(docId, on) {
    (window._customerDocs || []).forEach(function (d) { if (d.id === docId) d.reviewPending = !!on; });
    render();
  }

  async function _recordShared(docId, link, via) {
    var leadId = window._customerId;
    var now = new Date();
    var entry = (window._customerDocs || []).filter(function (d) { return d.id === docId; })[0] || {};
    var patch = {
      lastSharedAt: now, lastSharedVia: via, sharedDocId: docId,
      sharedDocName: String(entry.name || '').slice(0, 200),
      sharedLinkUrl: link.shareUrl, sharedLinkExpiresAt: link.expiresAt ? new Date(link.expiresAt) : null
    };
    if (window._currentLead && window._currentLead.id === leadId) {
      window._currentLead = Object.assign({}, window._currentLead, patch);
    }
    if (Array.isArray(window._leads)) {
      var i = window._leads.findIndex(function (l) { return l && l.id === leadId; });
      if (i >= 0) window._leads[i] = Object.assign({}, window._leads[i], patch);
    }
    // The lead stamp is written here too (owner/staff write, rules-checked)
    // so the record is right even if the callable below is slow; the server
    // writes the same fields and is the authority.
    try {
      if (window.db && window.doc && window.updateDoc) {
        var w = Object.assign({}, patch, { lastSharedAt: window.serverTimestamp ? window.serverTimestamp() : now });
        await window.updateDoc(window.doc(window.db, 'leads', leadId), w);
      }
    } catch (e) { console.warn('[send-for-review] lead stamp failed', e && e.message); }
    try { window.dispatchEvent(new CustomEvent('nbd:data-refreshed', { detail: { source: 'estimate-shared', leadId: leadId } })); } catch (_) {}
    _docCallable('recordEstimateShared', { leadId: leadId, documentId: docId, token: link.token, via: via })
      .catch(function (e) { console.warn('[send-for-review] recordEstimateShared failed', e && e.message); });
  }

  async function _shareReview(docId, pend, btn) {
    var lead = window._currentLead || {};
    // leadId: the server's "ok to text?" check + the Comm Log row (R2-3-2).
    var res = await window.NBDPhoneShare.share({
      text: pend.text, phone: lead.phone, email: lead.email,
      subject: 'Your roof estimate', title: 'Roof estimate', noRetry: !!pend.retried,
      leadId: lead.id || window._customerId, source: 'estimate_review'
    });
    if (res.needsTap) {
      _reviewPending[docId] = { text: pend.text, link: pend.link, retried: true };
      _setPending(docId, true);
      if (typeof showToast === 'function') showToast('Link ready — tap “Share now” to send it', 'info');
      return res;
    }
    delete _reviewPending[docId];
    _setPending(docId, false);
    if (res.shared) {
      await _recordShared(docId, pend.link, res.via === 'share' ? 'phone_share' : res.via);
      if (typeof showToast === 'function') showToast('Shared from your phone ✓ — you’ll get a heads-up when they open it', 'success');
      setTimeout(refresh, 1500);
    }
    return res;
  }

  async function sendForReview(docId, btn) {
    if (window.NBDRole && !window.NBDRole.guard()) return;
    if (!docId || !window._customerId) return;
    if (!window.NBDPhoneShare) { if (typeof showToast === 'function') showToast('Sharing is still loading — try again', 'error'); return; }
    var pend = _reviewPending[docId];
    if (pend) return _shareReview(docId, pend, btn);
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Getting link…'; }
    try {
      var cur = window._currentLead || {};
      if (cur.phone && typeof window.NBDPhoneShare.precheck === 'function') window.NBDPhoneShare.precheck({ phone: cur.phone, leadId: cur.id || window._customerId });
      var link = await _docCallable('createEstimateReviewLink', { leadId: window._customerId, documentId: docId });
      if (!link.shareUrl || !/^https:\/\//.test(link.shareUrl)) throw new Error('No link came back');
      if (btn) { btn.disabled = false; btn.textContent = label; }
      return await _shareReview(docId, { text: _reviewText(link.shareUrl), link: link }, btn);
    } catch (e) {
      console.warn('sendForReview failed:', e && e.message);
      if (typeof showToast === 'function') showToast('Could not send for review: ' + ((e && e.message) || 'unknown'), 'error');
    } finally {
      if (btn && btn.isConnected && btn.disabled) { btn.disabled = false; btn.textContent = label || '📤 Send for review'; }
    }
  }

  async function freshReviewLink(docId, btn) {
    if (window.NBDRole && !window.NBDRole.guard()) return;
    if (!docId || !window._customerId) return;
    var ask = window.nbdConfirm || function (m) { return Promise.resolve(window.confirm(m)); };
    if (!(await ask('Make a fresh link for this estimate?\n\nThe link you sent before stops working.'))) return;
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Linking…'; }
    try {
      var out = await _docCallable('freshEstimateLink', { leadId: window._customerId, kind: 'review', documentId: docId });
      if (!out.url) throw new Error('No link came back');
      await refresh();
      return await _shareReview(docId, {
        text: _reviewText(out.url),
        link: { shareUrl: out.url, token: out.token, expiresAt: out.expiresAt }
      }, null);
    } catch (e) {
      console.warn('freshReviewLink failed:', e && e.message);
      if (typeof showToast === 'function') showToast('Could not make a fresh link: ' + ((e && e.message) || 'unknown'), 'error');
    } finally {
      if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = label || '↻ Fresh link'; }
    }
  }

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('[data-doc-review],[data-doc-fresh]');
    if (!t) return;
    e.preventDefault();
    if (t.hasAttribute('data-doc-fresh')) freshReviewLink(t.getAttribute('data-doc-fresh'), t);
    else sendForReview(t.getAttribute('data-doc-review'), t);
  });

  window.NBDCustomerDocs = {
    load: load,
    refresh: refresh,
    render: render,
    fetchAll: fetchAll,
    normalize: normalize
  };

  // The bootstrap calls window.loadDocuments(id) from loadCustomerData once
  // the lead is resolved. That is the ONLY entry point — no DOMContentLoaded
  // timer, so there is nothing to race.
  window.loadDocuments = load;
})();
