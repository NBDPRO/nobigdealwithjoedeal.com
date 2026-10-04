

// ============================================
// PHOTO REPORT GENERATOR
// ============================================

let removeDocFromQueue; // module-local (globals Tranche 1 — was window.*)



// ============================================
// DOCUMENT UPLOAD SYSTEM
// ============================================

window._docUploadQueue = [];

window.openDocUploadModal = function() {
  window._docUploadQueue = [];
  updateDocUploadPreview();
  // nbdModal owns visibility + Esc/backdrop close; onClose resets the queue
  // so every dismiss path (button, Esc, backdrop) clears in-progress picks.
  window.nbdModal.open('docUploadModal', { onClose: function() {
    window._docUploadQueue = [];
    updateDocUploadPreview();
  } });
};

window.closeDocUploadModal = function() {
  window.nbdModal.close('docUploadModal');
};

// Document drop zone
document.addEventListener('DOMContentLoaded', () => {
  const dropZone = document.getElementById('docDropZone');
  const fileInput = document.getElementById('docFileInput');
  
  if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());
    
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });
    
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files);
      addDocumentsToQueue(files);
    });
    
    fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      addDocumentsToQueue(files);
    });
  }
});

function addDocumentsToQueue(files) {
  // Dedupe on name+size+lastModified. A drop handler AND a change handler
  // both feed this function, and some gestures fire both for one set of
  // files (programmatically populating the file input does exactly that).
  // Without this guard, adding two files queued four entries and uploaded
  // each of them twice.
  const key = (f) => [f.name, f.size, f.lastModified || 0].join('|');
  const seen = new Set(window._docUploadQueue.map(it => key(it.file)));
  let added = 0;
  files.forEach(file => {
    const k = key(file);
    if (seen.has(k)) return;
    seen.add(k);
    added++;
    window._docUploadQueue.push({
      file: file,
      uploading: false,
      progress: 0
    });
  });
  updateDocUploadPreview();
  return added;
}

function updateDocUploadPreview() {
  const preview = document.getElementById('docUploadPreview');
  const uploadBtn = document.getElementById('uploadDocBtn');
  const countSpan = document.getElementById('uploadDocCount');
  
  // Every element here is optional. This function runs INSIDE the upload
  // loop's try block, so an unguarded null here does not merely skip a label —
  // it aborts the upload and reports it as "Upload failed", which is exactly
  // how a missing count span masqueraded as a broken uploader. A chrome
  // element that has gone missing must never be able to fail the transfer.
  if (window._docUploadQueue.length === 0) {
    if (preview) preview.innerHTML = '';
    if (uploadBtn) uploadBtn.style.display = 'none';
    return;
  }
  if (!preview) return;
  
  if (uploadBtn) uploadBtn.style.display = 'inline-flex';
  if (countSpan) countSpan.textContent = window._docUploadQueue.length;
  
  const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  preview.innerHTML = window._docUploadQueue.map((item, idx) => {
    const fileName = String(item.file.name || '');
    const fileType = (fileName.split('.').pop() || '').toUpperCase();
    const sizeKb = Number.isFinite(+item.file.size) ? (+item.file.size / 1024).toFixed(1) : '0.0';
    return `
      <div class="preview-item" style="aspect-ratio:auto;padding:12px;display:flex;align-items:center;gap:8px;">
        <div style="opacity:.6;"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:32px;height:32px;"><path d="M5 2h7l4 4v11a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M12 2v4h4"/></svg></div>
        <div style="flex:1;overflow:hidden;">
          <div style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${esc(fileName)}
          </div>
          <div style="font-size:10px;color:var(--m);">
            ${esc(fileType)} • ${esc(sizeKb)}KB
          </div>
        </div>
        ${item.uploading
          ? `<div style="font-size:10px;color:var(--blue);">${Math.round(Number(item.progress) || 0)}%</div>`
          : `<button type="button" class="preview-remove nbd-remove-doc" data-queue-idx="${idx}">×</button>`
        }
      </div>
    `;
  }).join('');
  preview.querySelectorAll('.nbd-remove-doc').forEach(btn => {
    btn.addEventListener('click', () => removeDocFromQueue(Number(btn.dataset.queueIdx)));
  });
}

removeDocFromQueue = function(index) {
  window._docUploadQueue.splice(index, 1);
  updateDocUploadPreview();
};

// Native alert() blocks the renderer until a human clicks OK. That stalls the
// page for anything driving it programmatically, and per the iOS PWA notes
// elsewhere in this file native dialogs misbehave in standalone mode too.
// Every other surface on this page reports through showToast, so everything
// in this module does the same. Falls back to the console; never blocks.
// kind: 'success' | 'error' | 'warning' | 'info'
function _nbdNotify(msg, kind) {
  if (typeof window.showToast === 'function') { window.showToast(msg, kind || 'info'); return; }
  if (kind === 'error') console.error('[docs]', msg); else console.log('[docs]', msg);
}

window.uploadDocuments = async function() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  if (window._docUploadQueue.length === 0) return;
  if (!window._customerId) {
    _nbdNotify('Customer ID not found', 'error');
    return;
  }
  
  _setDocUploadBusy(true);
  
  try {
    for (let i = 0; i < window._docUploadQueue.length; i++) {
      const item = window._docUploadQueue[i];
      item.uploading = true;
      updateDocUploadPreview();
      
      await uploadSingleDocument(item, i);
    }
    
    const _n = window._docUploadQueue.length;
    _nbdNotify(`Uploaded ${_n} file${_n === 1 ? '' : 's'}.`, 'success');
    closeDocUploadModal();
    if (window.NBDCustomerDocs) await window.NBDCustomerDocs.refresh();
    
  } catch (error) {
    console.error('Document upload error:', error);
    _nbdNotify('Upload failed: ' + ((error && error.message) || 'unknown error'), 'error');
  } finally {
    _setDocUploadBusy(false);
  }
};

// Toggle the upload button between its idle and busy labels.
//
// This replaced `uploadBtn.textContent = 'Uploading...'`, which was not a
// cosmetic bug: assigning textContent REPLACES an element's children, so that
// line deleted <span id="uploadDocCount"> out of the button on the very first
// upload. updateDocUploadPreview reads that span two lines later and threw
// "Cannot set properties of null" — inside the try, so it surfaced as a
// generic "Upload failed" and the real cause never reached anyone. Combined
// with the native alert() that froze the page before the message could be
// read, document upload had never once succeeded on this page.
//
// The two labels are sibling spans in customer.html toggled with [hidden], so
// nothing in the button is ever destroyed.
function _setDocUploadBusy(busy) {
  const btn = document.getElementById('uploadDocBtn');
  if (btn) btn.disabled = !!busy;
  const idle = document.getElementById('uploadDocBtnIdle');
  const work = document.getElementById('uploadDocBtnBusy');
  if (idle) idle.hidden = !!busy;
  if (work) work.hidden = !busy;
}

async function uploadSingleDocument(item, index) {
  const file = item.file;
  const timestamp = Date.now();
  // Storage rules require path `docs/{uid}/{file}` — the old
  // `documents/{file}` path is blocked by default-deny. Same
  // root-cause as the photo upload failure.
  const uid = window.auth?.currentUser?.uid;
  if (!uid) throw new Error('Not signed in — cannot upload');
  const safeName = (file.name || 'upload').replace(/[^A-Za-z0-9._-]+/g, '_').substring(0, 120);
  const filename = `${window._customerId}_${timestamp}_${safeName}`;
  const storageRef = window.ref(window.storage, `docs/${uid}/${filename}`);
  
  const uploadTask = window.uploadBytesResumable(storageRef, file);
  
  return new Promise((resolve, reject) => {
    uploadTask.on('state_changed',
      (snapshot) => {
        const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
        window._docUploadQueue[index].progress = progress;
        updateDocUploadPreview();
      },
      (error) => {
        console.error('Upload error:', error);
        reject(error);
      },
      async () => {
        try {
          const downloadURL = await window.getDownloadURL(uploadTask.snapshot.ref);
          
          // leads/{leadId}/documents is the canonical store (see
          // customer-documents.js). This used to write the top-level
          // `documents` collection, which no other surface on the page read.
          await window.addDoc(window.collection(window.db, 'leads', window._customerId, 'documents'), {
            userId: window.auth.currentUser.uid,
            uploadedBy: window.auth.currentUser.uid,
            url: downloadURL,
            filename: file.name,
            size: file.size,
            type: file.type,
            uploadedAt: window.serverTimestamp(),
            source: 'overview_upload',
            category: 'General'
          });
          
          resolve();
        } catch (error) {
          reject(error);
        }
      }
    );
  });
}

// loadDocuments used to live here, reading the TOP-LEVEL `documents`
// collection (leadId + userId). None of the page's three real document
// writers ever wrote there, so this panel showed "No documents yet" for
// customers with a full stack of contracts and invoices. The store now
// lives in customer-documents.js, which reads leads/{id}/documents and
// merges any surviving legacy rows from the old collection. It publishes
// window.loadDocuments, so the bootstrap call site is unchanged.

// ============================================
// NOTES SYSTEM
// ============================================

window.openNotesModal = function() {
  var t = document.getElementById('noteText');
  if (t) t.value = '';
  window.nbdModal.open('notesModal');
  if (t) t.focus();
};

window.closeNotesModal = function() {
  window.nbdModal.close('notesModal');
};

window.saveNote = async function() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const noteText = document.getElementById('noteText').value.trim();

  if (!noteText) {
    _nbdNotify('Please enter a note', 'warning');
    return;
  }

  if (!window._customerId) {
    _nbdNotify('Customer ID not found', 'error');
    return;
  }

  try {
    await window.addDoc(window.collection(window.db, 'notes'), {
      leadId: window._customerId,
      userId: window.auth.currentUser.uid,
      text: noteText,
      createdAt: window.serverTimestamp(),
      createdBy: auth.currentUser?.email || 'Unknown'
    });

    closeNotesModal();
    await loadNotes(window._customerId);

    // Reload timeline to show new note
    const leadSnap = await getDoc(doc(db, 'leads', window._customerId));
    if (leadSnap.exists()) {
      await loadTimeline(window._customerId, leadSnap.data());
    }

  } catch (error) {
    console.error('Error saving note:', error);
    _nbdNotify('Note not saved: ' + ((error && error.message) || 'unknown error'), 'error');
  }
};

// Wave 33: inline quick-add note. Optimistic prepend to the visible
// notesList so the rep sees the note land immediately, then writes
// to Firestore in the background. On success, reload notes from
// source. On failure, remove the optimistic card + restore the
// textarea content + toast.
window.quickAddNote = async function () {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const input  = document.getElementById('quickNoteInput');
  const send   = document.getElementById('quickNoteSend');
  const status = document.getElementById('quickNoteStatus');
  if (!input) return;
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }
  if (!window._customerId) {
    if (typeof window.showToast === 'function') window.showToast('No customer selected', 'error');
    return;
  }

  // Lock the form while we save.
  input.disabled = true;
  if (send) { send.disabled = true; send.style.opacity = '0.6'; send.style.cursor = 'wait'; }
  if (status) { status.textContent = 'Saving…'; status.style.color = 'var(--m)'; }

  // Optimistic prepend — temporary card with a pending marker.
  const list = document.getElementById('notesList');
  const tmpId = 'tmp-note-' + Date.now();
  const wasEmpty = list && /class="empty"/.test(list.innerHTML);
  const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  const bodyHtml = esc(text).replace(/\n/g, '<br>');
  const tmpCard = `
    <div id="${tmpId}" data-tmp="1"
      style="padding:12px;background:var(--s2);border-left:3px solid var(--orange);border-radius:4px;opacity:0.7;">
      <div style="font-size:13px;line-height:1.6;margin-bottom:6px;">${bodyHtml}</div>
      <div style="font-size:10px;color:var(--m);font-style:italic;">Saving…</div>
    </div>`;
  if (list) {
    if (wasEmpty) list.innerHTML = tmpCard;
    else list.insertAdjacentHTML('afterbegin', tmpCard);
  }

  try {
    await window.addDoc(window.collection(window.db, 'notes'), {
      leadId: window._customerId,
      userId: window.auth.currentUser.uid,
      text,
      createdAt: window.serverTimestamp(),
      createdBy: window.auth.currentUser?.email || 'Unknown'
    });

    // Success: clear the input, flash "Saved", reload from source.
    input.value = '';
    if (status) {
      status.textContent = 'Saved ✓';
      status.style.color = 'var(--green)';
      setTimeout(() => { if (status.textContent === 'Saved ✓') status.textContent = ''; }, 1800);
    }

    if (typeof loadNotes === 'function') {
      try { await loadNotes(window._customerId); } catch (_) {}
    }
    // Refresh the timeline panel so the new note shows up there too,
    // matching the modal's existing behavior.
    try {
      if (typeof getDoc === 'function' && typeof doc === 'function' && typeof db !== 'undefined') {
        const leadSnap = await getDoc(doc(db, 'leads', window._customerId));
        if (leadSnap.exists() && typeof loadTimeline === 'function') {
          await loadTimeline(window._customerId, leadSnap.data());
        }
      }
    } catch (_) {}
  } catch (e) {
    console.error('[quickAddNote] save failed', e);
    // Roll back: remove the optimistic card, put the text back so
    // the rep doesn't lose what they typed.
    const tmp = document.getElementById(tmpId);
    if (tmp) tmp.remove();
    input.value = text;
    if (status) {
      status.textContent = 'Save failed — try again';
      status.style.color = 'var(--red)';
    }
    if (typeof window.showToast === 'function') {
      window.showToast('Note save failed: ' + (e.message || 'unknown'), 'error');
    }
  } finally {
    input.disabled = false;
    if (send) { send.disabled = false; send.style.opacity = ''; send.style.cursor = ''; }
    input.focus();
  }
};

// Wire Cmd/Ctrl+Enter on the quick-note input. Listens lazily so it
// works even if the textarea wasn't in the DOM at parse time.
document.addEventListener('keydown', function (ev) {
  if (ev.target && ev.target.id === 'quickNoteInput'
      && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    if (typeof window.quickAddNote === 'function') window.quickAddNote();
  }
});

async function loadNotes(leadId) {
  try {
    // leadId-only (no author filter) so the notes panel shows the whole lead's
    // activity, incl. teammates' notes; the /notes rule authorizes by parent
    // lead. Sort createdAt desc in JS (no [leadId, createdAt] composite index).
    const noteSnap = await getDocs(
      query(collection(db, 'notes'), where('leadId', '==', leadId))
    );
    const _ms = (v) => (v && v.toDate ? v.toDate().getTime() : (v ? new Date(v).getTime() : 0)) || 0;
    const notes = noteSnap.docs
      .map(d => d.data())
      .sort((a, b) => _ms(b.createdAt) - _ms(a.createdAt));

    if (typeof window.nbdTitleCount === 'function') {
      window.nbdTitleCount('notesPanelTitle', 'Notes', notes.length);
    }

    if (!notes.length) {
      document.getElementById('notesList').innerHTML = `
      <div class="empty">
        <div class="empty-icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;vertical-align:middle;"><path d="M4 3h12a1 1 0 011 1v10l-4 4H4a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M13 14v4"/><path d="M7 7h6M7 10h3"/></svg></div>
        <div>No notes yet — type one in the box above and hit Send.</div>
      </div>
    `;
      return;
    }

    const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
    const html = notes.map(note => {
      const createdDate = note.createdAt?.toDate ? note.createdAt.toDate() : new Date();
      const timeAgo = getTimeAgo(createdDate);

      // Escape every user-controlled field. Preserve newlines in the note body
      // by escaping first then converting \n → <br>.
      const bodyHtml = esc(note.text).replace(/\n/g, '<br>');
      return `
        <div style="
          padding:12px;
          background:var(--s2);
          border-left:3px solid var(--orange);
          border-radius:4px;
        ">
          <div style="font-size:13px;line-height:1.6;margin-bottom:6px;">
            ${bodyHtml}
          </div>
          <div style="font-size:10px;color:var(--m);">
            ${esc(note.createdBy)} • ${esc(timeAgo)}
          </div>
        </div>
      `;
    }).join('');

    document.getElementById('notesList').innerHTML = html;
  } catch (e) {
    console.error('Error loading notes:', e);
  }
}

function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  
  return date.toLocaleDateString();
}

// ============================================
// ESTIMATE SYSTEM
// ============================================

window.openEstimateModal = function() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  document.getElementById('estimateAmount').value = '';
  document.getElementById('estimateNotes').value = '';
  // onClose clears the working estimate id on any dismiss (mirrors the
  // create-modal reset in customer-bootstrap.module.js's closeEstimateModal).
  window.nbdModal.open('estimateModal', { onClose: function() {
    window._currentEstimateId = null;
  } });
};

window.closeEstimateModal = function() {
  window.nbdModal.close('estimateModal');
};

window.saveEstimate = async function() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const type = document.getElementById('estimateType').value;
  const amount = parseFloat(document.getElementById('estimateAmount').value);
  const notes = document.getElementById('estimateNotes').value.trim();
  
  if (!amount || amount <= 0) {
    _nbdNotify('Enter a valid estimate amount', 'warning');
    return;
  }
  
  if (!window._customerId) {
    _nbdNotify('Customer ID not found', 'error');
    return;
  }
  
  try {
    const estRef = await window.addDoc(window.collection(window.db, 'estimates'), {
      leadId: window._customerId,
      // The estimates create rule requires userId == auth.uid; omitting it
      // made every Log Estimate from this page PERMISSION_DENIED.
      userId: window.auth?.currentUser?.uid || auth.currentUser?.uid || null,
      // Tenancy. The create rule PERMITS companyId to be absent, so omitting it
      // failed silently at READ time instead: the team estimates listener
      // queries where('companyId','==',claims.companyId), so an estimate logged
      // from this page was invisible to every teammate — the manager's estimate
      // count, the estimates list and the revenue rollups all under-reported it,
      // permanently. Mirrors the canonical writer in dashboard-bootstrap.
      // Solo operators key by uid (the companyId == uid convention).
      companyId: window._userClaims?.companyId
        || window.auth?.currentUser?.uid || auth.currentUser?.uid || null,
      type: type,
      amount: amount,
      // Classic-shape doc (type/amount) written into a collection the rest of
      // the page reads in V2 shape. NBDCustomerEstimateRows.estimateValue /
      // .estimateName prefer grandTotal/title, so mirror both here rather than
      // making every reader special-case the Log Estimate flow.
      grandTotal: amount,
      title: type ? `${type} Estimate` : 'Estimate',
      notes: notes,
      status: 'Draft',
      createdAt: window.serverTimestamp(),
      createdBy: auth.currentUser?.email || 'Unknown'
    });

    // Pipeline wiring: the header Job Value, the Profit panel, pipeline $,
    // the KPI tiles and the leaderboard ALL read lead.jobValue — never the
    // estimates collection — so logging an estimate here used to leave every
    // one of them at zero. Mirrors the canonical stamp-back in
    // dashboard-bootstrap.module.js:_saveEstimate. Best-effort: a lead-write
    // failure must never fail the estimate save the rep just watched succeed.
    try {
      const leadRef = window.doc(window.db, 'leads', window._customerId);
      const leadSnap = await window.getDoc(leadRef);
      if (leadSnap.exists()) {
        const lead = leadSnap.data();
        if (!lead.primaryEstimateId) {
          // First estimate this lead has ever had — unambiguous, stamp it
          // straight through. Only bump a stone-cold "new" lead forward, to
          // Contacted (there is no "quote drafted" stage); never regress a
          // lead already further along the funnel. normalizeStage/stageRole
          // live in dashboard-bootstrap.module.js, which customer.html does
          // NOT load, so both are typeof-guarded and the fallback compares
          // literally — an unrecognized stage is left alone rather than
          // being treated as 'new'.
          const stampUpdate = {
            jobValue: amount,
            primaryEstimateId: estRef.id,
            lastEstimateAt: window.serverTimestamp()
          };
          const stageKey = (typeof window.normalizeStage === 'function')
            ? window.normalizeStage(lead.stage)
            : String(lead.stage || 'new').trim().toLowerCase();
          await window.updateDoc(leadRef, stampUpdate);
          // The New → Contacted bump goes through stage-write.js's
          // commitStageChange like every other stage move (job spine,
          // 2026-10-03): it used to ride along in the plain update above, so
          // the lead got no stageStartedAt, no stageHistory entry, no
          // timeline note and no stage-entry task. Race-guarded; a lead that
          // moved meanwhile is left where it is.
          if (stageKey === 'new') {
            try {
              const { commitStageChange } = await import('./stage-write.js');
              await commitStageChange(window._customerId, 'contacted', lead.stage || null, { jobType: lead.jobType || null });
            } catch (advErr) {
              const m = advErr && advErr.message;
              if (m !== 'STAGE_RACE_NOOP' && m !== 'STAGE_RACE_LOST') console.warn('[saveEstimate] New → Contacted failed:', m);
            }
          }
        } else {
          // Lead already has a primary estimate (this is a revision or a
          // second quote) — don't silently clobber a rep-confirmed number.
          // Same confirm helper the V2 builder uses, falling back to the
          // native confirm() where nbdModal isn't loaded. On reject the
          // estimate still saves; the lead is just left untouched.
          const existingVal = Number(lead.jobValue) || 0;
          const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
          const useNew = await ask(
            `This lead's job value is currently $${existingVal.toLocaleString()} (from an earlier estimate). ` +
            `Use this new estimate's $${amount.toLocaleString()} instead?`
          );
          if (useNew) {
            await window.updateDoc(leadRef, {
              jobValue: amount,
              primaryEstimateId: estRef.id,
              lastEstimateAt: window.serverTimestamp()
            });
          }
        }
      }
    } catch (stampErr) {
      console.warn('[saveEstimate] lead stamp-back failed:', stampErr);
    }

    _nbdNotify('Estimate created.', 'success');
    closeEstimateModal();
    if (window.loadEstimates) await window.loadEstimates(window._customerId);

    // Reload timeline
    const leadSnap2 = await window.getDoc(window.doc(window.db, 'leads', window._customerId));
    if (leadSnap2.exists()) {
      const fresh = { id: leadSnap2.id, ...leadSnap2.data() };
      // Leads have NO snapshot listener on this page — the stamp-back above
      // changed jobValue/stage on the server and nothing would repaint. Re-seed
      // the in-memory state every other module reads, then hand-repaint the two
      // cells that show it (mirrors saveCustomerEdits in customer-edit-modal.js).
      window._currentLead = fresh;
      window._leadDoc = fresh;
      if (Array.isArray(window._leads)) window._leads = [fresh];
      const _jvCell = document.getElementById('infoJobValue');
      if (_jvCell) _jvCell.textContent = fresh.jobValue ? `$${(Number(fresh.jobValue) || 0).toLocaleString()}` : '—';
      // jobValue feeds the profit-panel margin math → re-render it too
      if (window.ProfitTracker && typeof window.ProfitTracker.renderCostPanel === 'function') {
        try { window.ProfitTracker.renderCostPanel('profitPanel', window._customerId); } catch (e) {}
      }
      if (window.loadTimeline) await window.loadTimeline(window._customerId, fresh);
    }

  } catch (error) {
    console.error('Error saving estimate:', error);
    _nbdNotify('Estimate not saved: ' + ((error && error.message) || 'unknown error'), 'error');
  }
};



// Expose loader functions defined in THIS script block to window scope
// NOTE: loadEstimates and loadTimeline are in the module script — exposed there
window.loadNotes = loadNotes;

