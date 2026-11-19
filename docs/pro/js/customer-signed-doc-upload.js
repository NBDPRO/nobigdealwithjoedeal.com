
// ── Signed Document Upload (Sprint 6) ──
// Camera scan or file upload for signed paper documents.
// Uploads to Firebase Storage under docs/{uid}/{customerId}/
// and saves a record to leads/{leadId}/documents — the canonical store.
//
// This module UPLOADS. It does not read, render, or delete: customer-documents.js
// owns the store and every documents surface on the page (see the header there
// for why that consolidation happened). We just hand it a refresh when a new
// file lands.

function uploadSignedDoc(mode) {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  if (mode === 'camera') {
    document.getElementById('signedDocFileInput').click();
  } else {
    document.getElementById('signedDocBrowseInput').click();
  }
}

function _signedDocPaperCertOn() {
  try { return !!(window.NBDFlags && typeof window.NBDFlags.enabled === 'function' && window.NBDFlags.enabled('docClauseSetV1')); }
  catch (_) { return false; }
}

// The form lives in paper-cert.js (the docgen bundle), loaded here on demand so the customer page's boot
// path carries none of it. 'unavailable' = it could not be loaded: the upload is NOT made (never falls back to "signed").
async function _signedDocCollectPaper(file) {
  try {
    if (!window.NBDPaperCert && window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
      await window.ScriptLoader.loadBundle('docgen');
    }
    if (!window.NBDPaperCert || typeof window.NBDPaperCert.collect !== 'function') return 'unavailable';
    return await window.NBDPaperCert.collect(file);
  } catch (e) {
    console.warn('Paper certification form failed:', e && e.message);
    return 'unavailable';
  }
}

// "Certify" on a waiting upload (customer-documents.js row button). Same on-demand load.
async function certifyPaperDoc(docId) {
  if (window.NBDRole && !window.NBDRole.guard()) return;
  try {
    if (!window.NBDPaperCert && window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
      await window.ScriptLoader.loadBundle('docgen');
    }
    if (!window.NBDPaperCert) throw new Error('form did not load');
    await window.NBDPaperCert.certify(docId);
  } catch (e) {
    console.warn('certifyPaperDoc failed:', e && e.message);
    if (typeof showToast === 'function') showToast('Could not open the certification form. Try again.', 'error');
  }
}

async function handleSignedDocUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  input.value = ''; // reset for re-use

  const uid = window.auth?.currentUser?.uid;
  if (!uid || !window._customerId) {
    if (typeof showToast === 'function') showToast('Not signed in or no customer selected', 'error');
    return;
  }

  // Validate
  const maxSize = 20 * 1024 * 1024; // 20MB
  if (file.size > maxSize) {
    if (typeof showToast === 'function') showToast('File too large (max 20MB)', 'error');
    return;
  }

  // Paper certification (flag docClauseSetV1, default off): the rep says what the paper is, which generated
  // document it is the signed copy of, and the date it was signed. The row then WAITS ('wet_signed_uploaded',
  // "Uploaded, not certified") until the attestWetSigned callable certifies it. Flag off: nothing below runs
  // and the record is exactly what it always was.
  let paper = null;
  if (_signedDocPaperCertOn()) {
    paper = await _signedDocCollectPaper(file);
    if (paper === 'unavailable') {
      if (typeof showToast === 'function') showToast('The paper-signed form did not load. Try again in a moment.', 'error');
      return;
    }
    if (!paper) return; // cancelled
  }

  if (typeof showToast === 'function') showToast('Uploading ' + file.name + '...', 'info');

  try {
    const timestamp = Date.now();
    const safeName = (file.name || 'document').replace(/[^A-Za-z0-9._-]+/g, '_').substring(0, 100);
    const path = 'docs/' + uid + '/' + window._customerId + '/' + timestamp + '_' + safeName;
    const storageRef = window.ref(window.storage, path);
    await window.uploadBytes(storageRef, file);
    const downloadURL = await window.getDownloadURL(storageRef);

    // Save record to Firestore
    await window.addDoc(window.collection(window.db, 'leads', window._customerId, 'documents'), {
      name: safeName,
      url: downloadURL,
      type: file.type || 'application/octet-stream',
      size: file.size,
      uploadedAt: window.serverTimestamp(),
      uploadedBy: uid,
      source: 'signed_upload',
      // Already an executed document the rep is attaching, not something
      // moving through draft/sent — status starts (and stays) 'signed'.
      // Paper certification on: it waits as 'wet_signed_uploaded' until the server certifies it.
      status: paper ? 'wet_signed_uploaded' : 'signed',
      ...(paper ? Object.assign({ wetSignedDocType: paper.docType, wetSignedOn: paper.signedOn },
        paper.originalDocId ? { originalDocId: paper.originalDocId } : {},
        paper.witnessName ? { witnessName: paper.witnessName } : {}) : {})
    });

    if (typeof showToast === 'function') showToast('Document uploaded successfully', 'success');
    if (window.NBDCustomerDocs) await window.NBDCustomerDocs.refresh();
  } catch (e) {
    console.error('Signed doc upload failed:', e);
    if (typeof showToast === 'function') showToast('Upload failed: ' + (e.message || 'unknown'), 'error');
  }
}

