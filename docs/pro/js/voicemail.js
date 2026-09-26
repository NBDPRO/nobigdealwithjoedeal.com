/**
 * voicemail.js — Voicemail processing pipeline (Step 4)
 *
 * The existing voice-memo.js flow (NBDVoiceMemo.recordForLead) only
 * transcribes audio and writes the raw transcript to a lead's activity
 * subcollection. It doesn't summarize, extract action items, or accept
 * forwarded voicemail files from a phone.
 *
 * This module fills both gaps:
 *
 *   1. window.NBDVoicemail.openForLead(leadId)
 *      Opens a small modal with two options:
 *        - "Record" → MediaRecorder → dictate callable (mode:'summarize')
 *        - "Upload audio file" → file input → same dictate callable
 *
 *   2. After transcription completes:
 *        - Writes a 'voicemail' activity entry on /leads/{id}/activity
 *          (alongside the existing 'voice_memo' type) with the summary,
 *          actionItems, people, addresses, amounts, dates, category
 *        - Auto-creates a task for each actionItem in /leads/{id}/tasks
 *
 * Limits: enforced server-side by the dictate callable — 60 seconds /
 * 1.5MB raw audio. Forwarded voicemails longer than that are rejected
 * client-side BEFORE upload with a clear message.
 *
 * Auth + AppCheck enforced by the dictate callable. Per-uid rate limit
 * is 30/hr (same pool as cmd palette voice + Quick Capture).
 */
let _NBD_VM_DELEGATE; // module-local (globals Tranche 1 — was window.*)
(function () {
  'use strict';
  if (window.NBDVoicemail && window.NBDVoicemail.__sentinel === 'nbd-voicemail-v1') return;

  // Same hard ceiling as the dictate callable. We reject larger blobs
  // client-side so the rep gets an immediate, friendly error instead
  // of a generic "invalid-argument" from the server.
  const MAX_AUDIO_BYTES = 1_500_000;
  // Accepted MIME types for uploaded files. webm/mp4/mp3/m4a/wav cover
  // every common voicemail forward path (iOS, Android, Google Voice).
  const ACCEPTED_TYPES = /^audio\/(webm|mp4|m4a|x-m4a|mpeg|mp3|wav|wave|x-wav|ogg|flac)/i;
  // Matching <input accept="..."> token list.
  const ACCEPT_ATTR = 'audio/*,.m4a,.mp3,.wav,.webm,.ogg';

  let _recording = null;

  // ── small helpers ──────────────────────────────────────────────
  function toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind || 'info');
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  async function getCallable(name) {
    if (!window._functions || !window._httpsCallable) {
      const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
      window._functions = mod.getFunctions();
      window._httpsCallable = mod.httpsCallable;
    }
    return window._httpsCallable(window._functions, name);
  }
  function isSupported() {
    return typeof window.MediaRecorder === 'function'
      && typeof navigator.mediaDevices?.getUserMedia === 'function';
  }
  async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // dataURL is "data:<mime>;base64,XXXX" — strip the prefix.
        const r = String(reader.result || '');
        const i = r.indexOf(',');
        resolve(i >= 0 ? r.slice(i + 1) : r);
      };
      reader.onerror = () => reject(reader.error || new Error('FileReader error'));
      reader.readAsDataURL(blob);
    });
  }

  // ── modal markup + open/close ─────────────────────────────────
  function ensureModal() {
    if (document.getElementById('vmModal')) return;
    const wrap = document.createElement('div');
    wrap.className = 'modal-bg';
    wrap.id = 'vmModal';
    wrap.onclick = (e) => { if (e.target === wrap) closeModal(); };
    wrap.innerHTML = `
      <div class="modal" style="max-width:460px;">
        <button class="modal-close" data-vm-action="close">✕</button>
        <div style="font-size:9px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--orange);margin-bottom:4px;">Voicemail</div>
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:20px;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Capture &amp; Auto-task</div>
        <div style="font-size:11px;color:var(--m);margin-bottom:16px;">Record a quick voicemail or upload one forwarded from your phone. AI extracts action items and auto-creates follow-up tasks.</div>

        <div id="vmIntro" style="display:flex;flex-direction:column;gap:10px;">
          <button id="vmRecordBtn" type="button"
            style="width:100%;background:var(--orange);color:var(--t);border:none;border-radius:8px;padding:14px;font-family:'Barlow Condensed',sans-serif;font-size:15px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
            <span id="vmRecordLabel">Record voicemail</span>
          </button>
          <button id="vmUploadBtn" type="button"
            style="width:100%;background:var(--s2);color:var(--t);border:1px solid var(--br);border-radius:8px;padding:14px;font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Upload audio file
          </button>
          <input id="vmFileInput" type="file" accept="${ACCEPT_ATTR}" style="display:none;">
          <div style="font-size:10px;color:var(--m);text-align:center;margin-top:2px;">Max 60 seconds · 1.5MB · webm / mp4 / m4a / mp3 / wav / ogg</div>
        </div>

        <div id="vmProgress" style="display:none;padding:16px;text-align:center;">
          <div id="vmProgressIcon" style="font-size:28px;margin-bottom:8px;">⏳</div>
          <div id="vmProgressLabel" style="font-size:13px;font-weight:600;color:var(--t);margin-bottom:4px;">Working…</div>
          <div id="vmProgressSub" style="font-size:11px;color:var(--m);"></div>
        </div>

        <div id="vmResult" style="display:none;"></div>

        <div id="vmErr" style="color:var(--red);font-size:12px;margin-top:8px;text-align:center;display:none;"></div>
      </div>
    `;
    document.body.appendChild(wrap);

    // Wire buttons after insertion.
    document.getElementById('vmRecordBtn').addEventListener('click', toggleRecord);
    document.getElementById('vmUploadBtn').addEventListener('click', () => document.getElementById('vmFileInput').click());
    document.getElementById('vmFileInput').addEventListener('change', onFileChosen);
  }

  let _currentLeadId = null;

  function openForLead(leadId) {
    if (!leadId) { toast('No lead selected', 'error'); return; }
    _currentLeadId = leadId;
    ensureModal();
    resetUI();
    document.getElementById('vmModal').classList.add('open');
  }

  function close() {
    const m = document.getElementById('vmModal');
    if (m) m.classList.remove('open');
    // Stop any in-flight recording so the mic light goes off.
    if (_recording && _recording.state !== 'inactive') {
      try { _recording.stop(); } catch (e) {}
    }
    _recording = null;
  }

  function resetUI() {
    const intro = document.getElementById('vmIntro');
    const prog  = document.getElementById('vmProgress');
    const res   = document.getElementById('vmResult');
    const err   = document.getElementById('vmErr');
    if (intro) intro.style.display = 'flex';
    if (prog)  prog.style.display = 'none';
    if (res)   { res.style.display = 'none'; res.innerHTML = ''; }
    if (err)   { err.style.display = 'none'; err.textContent = ''; }
    const lbl = document.getElementById('vmRecordLabel'); if (lbl) lbl.textContent = 'Record voicemail';
    const btn = document.getElementById('vmRecordBtn');   if (btn) btn.removeAttribute('data-state');
    const fi = document.getElementById('vmFileInput');    if (fi)  fi.value = '';
  }

  function showError(msg) {
    const err = document.getElementById('vmErr');
    if (err) { err.textContent = msg; err.style.display = 'block'; }
  }

  function showProgress(icon, label, sub) {
    document.getElementById('vmIntro').style.display = 'none';
    document.getElementById('vmResult').style.display = 'none';
    const p = document.getElementById('vmProgress');
    p.style.display = 'block';
    document.getElementById('vmProgressIcon').textContent = icon || '⏳';
    document.getElementById('vmProgressLabel').textContent = label || 'Working…';
    document.getElementById('vmProgressSub').textContent = sub || '';
  }

  // ── recording path ────────────────────────────────────────────
  async function toggleRecord() {
    if (!isSupported()) {
      toast('Recording not supported on this browser — upload a file instead', 'error');
      return;
    }
    // Toggle stop if we're mid-recording.
    if (_recording && _recording.state === 'recording') {
      try { _recording.stop(); } catch (e) {}
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      showError('Microphone access denied.');
      return;
    }

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.addEventListener('dataavailable', e => { if (e.data && e.data.size) chunks.push(e.data); });

    // 60s auto-stop matches the dictate callable's hard ceiling so we
    // don't waste the rep's time on audio the server is going to reject.
    const stopTimer = setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, 60_000);

    rec.addEventListener('stop', async () => {
      clearTimeout(stopTimer);
      stream.getTracks().forEach(t => t.stop());
      _recording = null;
      const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
      if (!blob || blob.size < 1000) { showError('Clip too short.'); resetUI(); return; }
      await processBlob(blob, { source: 'recorded' });
    });
    rec.addEventListener('error', () => {
      clearTimeout(stopTimer);
      stream.getTracks().forEach(t => t.stop());
      _recording = null;
      showError('Recording error.');
      resetUI();
    });

    rec.start();
    _recording = rec;

    const btn = document.getElementById('vmRecordBtn');
    const lbl = document.getElementById('vmRecordLabel');
    if (btn) btn.setAttribute('data-state', 'recording');
    if (lbl) lbl.textContent = 'Tap to stop · max 60s';
  }

  // ── upload path ────────────────────────────────────────────────
  async function onFileChosen(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!ACCEPTED_TYPES.test(file.type) && !/\.(webm|mp4|m4a|mp3|wav|ogg|flac)$/i.test(file.name)) {
      showError('Unsupported file type. Use webm, mp4, m4a, mp3, wav, or ogg.');
      e.target.value = '';
      return;
    }
    if (file.size > MAX_AUDIO_BYTES) {
      showError('File too large — server cap is 1.5MB (~60 seconds). Trim or compress and try again.');
      e.target.value = '';
      return;
    }
    await processBlob(file, { source: 'uploaded', filename: file.name });
    e.target.value = '';
  }

  // ── shared processing ─────────────────────────────────────────
  async function processBlob(blob, meta) {
    if (!_currentLeadId) { showError('No lead selected.'); return; }
    showProgress('📤', 'Uploading…', `${Math.round(blob.size / 1024)} KB`);

    let audioBase64;
    try {
      audioBase64 = await blobToBase64(blob);
    } catch (e) {
      showError('Could not read audio.'); resetUI(); return;
    }

    showProgress('🎧', 'Transcribing & summarizing…', 'Deepgram + Claude');

    let res;
    try {
      const fn = await getCallable('dictate');
      const todayLocal = new Date().toISOString().slice(0, 10);
      const r = await fn({
        audioBase64,
        mimeType: blob.type || 'audio/webm',
        mode: 'summarize',
        todayLocal
      });
      res = r.data || {};
    } catch (e) {
      const msg = e && (e.message || e.code) || 'Transcription failed';
      showError(String(msg).includes('rate') ? 'Rate limit — try again in an hour.' : 'Transcription failed.');
      resetUI();
      return;
    }

    if (res.empty || !res.transcript) {
      showError('No speech detected in the audio.');
      resetUI();
      return;
    }

    showProgress('💾', 'Saving…', '');

    const summary = res.summary || {};
    const activityId = await writeActivityEntry({
      leadId: _currentLeadId,
      transcript: res.transcript,
      confidence: res.confidence,
      summary,
      source: meta.source,
      filename: meta.filename || null,
      mimeType: blob.type || 'audio/webm',
      sizeBytes: blob.size
    });

    const createdTasks = await writeActionItemTasks({
      leadId: _currentLeadId,
      actionItems: summary.actionItems || []
    });

    renderResult({ transcript: res.transcript, summary, activityId, taskCount: createdTasks.length });
    toast(`✓ Voicemail saved · ${createdTasks.length} task${createdTasks.length === 1 ? '' : 's'} created`, 'success');
  }

  // ── persistence ───────────────────────────────────────────────
  async function writeActivityEntry({ leadId, transcript, confidence, summary, source, filename, mimeType, sizeBytes }) {
    if (!window._db || !window.addDoc || !window.collection || !window.serverTimestamp) return null;
    try {
      const uid = window._user?.uid || null;
      const companyId = window._userClaims?.companyId || uid || null;
      const ref = await window.addDoc(
        window.collection(window._db, 'leads', leadId, 'activity'),
        {
          type: 'voicemail',
          label: source === 'uploaded' ? 'Voicemail upload' : 'Voicemail recording',
          transcript,
          confidence: confidence || null,
          summary: {
            overview:    summary.overview    || '',
            actionItems: Array.isArray(summary.actionItems) ? summary.actionItems : [],
            people:      Array.isArray(summary.people)      ? summary.people      : [],
            addresses:   Array.isArray(summary.addresses)   ? summary.addresses   : [],
            amounts:     Array.isArray(summary.amounts)     ? summary.amounts     : [],
            dates:       Array.isArray(summary.dates)       ? summary.dates       : [],
            category:    summary.category || 'other'
          },
          // F-05 rule requires source:'rep' on client-written activity;
          // keep the recording origin ('recorded'/'uploaded') in mediaSource.
          source: 'rep',
          mediaSource: source,
          filename: filename || null,
          mimeType: mimeType || null,
          sizeBytes: sizeBytes || null,
          userId: uid,
          companyId,
          createdAt: window.serverTimestamp()
        }
      );
      return ref.id;
    } catch (e) {
      // Activity write isn't critical — the rep still sees the result
      // in the modal even if persistence failed. Surface a quiet warning.
      console.warn('[voicemail] activity write failed:', e?.message || e);
      return null;
    }
  }

  async function writeActionItemTasks({ leadId, actionItems }) {
    if (!Array.isArray(actionItems) || !actionItems.length) return [];
    if (!window._db || !window.addDoc || !window.collection || !window.serverTimestamp) return [];
    const uid = window._user?.uid || null;
    const companyId = window._userClaims?.companyId || uid || null;
    const created = [];
    // Due TODAY (local date): a customer left a voicemail asking for
    // something. With no dueDate a task never reaches Today's Tasks or the
    // bell — both return early on a falsy t.dueDate.
    const now = new Date();
    const dueDate = now.getFullYear() + '-'
      + String(now.getMonth() + 1).padStart(2, '0') + '-'
      + String(now.getDate()).padStart(2, '0');
    for (const text of actionItems) {
      if (typeof text !== 'string' || !text.trim()) continue;
      // Task-reader shape {text, title, done, dueDate} (see customer-tasks-ui
      // saveTask). These rows used to carry only title/body/status, so the
      // dashboard task list rendered them with a blank label (2026-09-26).
      const label = text.trim().slice(0, 200);
      try {
        const ref = await window.addDoc(
          window.collection(window._db, 'leads', leadId, 'tasks'),
          {
            text: label,
            title: label,
            notes: 'Auto-created from voicemail action items.',
            done: false,
            dueDate,
            priority: 'normal',
            source: 'voicemail',
            leadId,
            userId: uid,
            companyId,
            createdAt: window.serverTimestamp()
          }
        );
        created.push(ref.id);
      } catch (e) {
        console.warn('[voicemail] task write failed:', e?.message || e);
      }
    }
    return created;
  }

  // ── result view ───────────────────────────────────────────────
  function renderResult({ transcript, summary, activityId, taskCount }) {
    document.getElementById('vmIntro').style.display = 'none';
    document.getElementById('vmProgress').style.display = 'none';
    const r = document.getElementById('vmResult');
    r.style.display = 'block';

    const aiList = (arr, label) => Array.isArray(arr) && arr.length
      ? `<div style="margin-bottom:8px;"><div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--m);margin-bottom:4px;">${esc(label)}</div><div style="font-size:12px;color:var(--t);line-height:1.5;">${arr.map(esc).join(' · ')}</div></div>`
      : '';

    const tasksRow = taskCount > 0
      ? `<div style="background:rgba(189,87,40,.1);border:1px solid var(--orange);border-radius:7px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:var(--orange);">
           ✓ Created ${taskCount} task${taskCount === 1 ? '' : 's'} from action items.
         </div>` : '';

    r.innerHTML = `
      ${tasksRow}
      ${summary.overview ? `<div style="background:var(--s2);border:1px solid var(--br);border-radius:7px;padding:12px;margin-bottom:10px;">
        <div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--m);margin-bottom:4px;">Overview</div>
        <div style="font-size:13px;color:var(--t);line-height:1.5;">${esc(summary.overview)}</div>
      </div>` : ''}

      ${Array.isArray(summary.actionItems) && summary.actionItems.length ? `<div style="background:var(--s2);border:1px solid var(--br);border-radius:7px;padding:12px;margin-bottom:10px;">
        <div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--m);margin-bottom:6px;">Action Items</div>
        <ul style="margin:0;padding-left:18px;font-size:12px;color:var(--t);line-height:1.6;">
          ${summary.actionItems.map(a => `<li>${esc(a)}</li>`).join('')}
        </ul>
      </div>` : ''}

      ${aiList(summary.people, 'People') + aiList(summary.addresses, 'Addresses') + aiList(summary.amounts, 'Amounts') + aiList(summary.dates, 'Dates')}

      <details style="background:var(--s2);border:1px solid var(--br);border-radius:7px;padding:8px 12px;margin-bottom:12px;">
        <summary style="font-size:11px;color:var(--m);cursor:pointer;">Full transcript</summary>
        <div style="font-size:12px;color:var(--t);line-height:1.5;margin-top:8px;white-space:pre-wrap;">${esc(transcript)}</div>
      </details>

      <button data-vm-action="close" style="width:100%;background:var(--s2);color:var(--t);border:1px solid var(--br);border-radius:8px;padding:12px;font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;">Done</button>
    `;
  }

  // ── inline pulse animation for recording state ───────────────
  // Injected once on first open so we don't pollute the stylesheet
  // for users who never touch the voicemail feature.
  function ensureStyles() {
    if (document.getElementById('vmStyles')) return;
    const s = document.createElement('style');
    s.id = 'vmStyles';
    s.textContent = `
      #vmRecordBtn[data-state="recording"] {
        background: var(--red) !important;
        animation: vmPulse 1.2s ease-in-out infinite;
      }
      @keyframes vmPulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(220,38,38,.6); }
        50%      { box-shadow: 0 0 0 8px rgba(220,38,38,0);  }
      }
    `;
    document.head.appendChild(s);
  }
  // Patch ensureModal to run ensureStyles too — keeps single entrypoint.
  const _origEnsureModal = ensureModal;
  // (declared above; just reuse)
  function ensureModalWithStyles() { ensureStyles(); _origEnsureModal(); }

  window.NBDVoicemail = {
    __sentinel: 'nbd-voicemail-v1',
    openForLead: (id) => { ensureModalWithStyles(); openForLead(id); },
    close
  };
})();


(function(){if(_NBD_VM_DELEGATE)return;_NBD_VM_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-vm-action]');if(!t)return;if(t.dataset.vmAction==='close'&&window.NBDVoicemail&&window.NBDVoicemail.close)window.NBDVoicemail.close();});})();
