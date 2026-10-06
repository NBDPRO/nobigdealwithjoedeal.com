/**
 * d2d-tracker-ui-2026b.js — D2D UI (render + modals + capture)
 *
 * Step 4f (2026-05-17): UI half of the split. Reads/writes the
 * window._D2DState object published by d2d-tracker-core-2026b.js.
 * Must load AFTER core so the state object is hydrated.
 *
 * UI owns:
 *   - renderD2D (all four tabs: feed / routes / gamify / analytics)
 *   - setTab / setDateFilter / setDispoFilter (filter mutators)
 *   - openQuickKnock / selectDispo / closeQuickKnock /
 *     handleSubmitKnock (the Knock modal flow)
 *   - openKnockDetail / closeKnockDetail (the Detail modal)
 *   - showConversionPrompt (hot-lead post-save dialog)
 *   - openSMSTemplateChooser (SMS chooser modal)
 *   - capturePhoto, startVoiceRecording, stopVoiceRecording
 *     (camera + microphone UI that touches DOM + state.photoFiles /
 *      state.voiceRecorder)
 *   - exportKnocksCSV (Blob download)
 *
 * Exports onto window._D2DState so the shim (d2d-tracker-2026b.js)
 * can compose the public window.D2D surface from both halves.
 */
(function() {
  'use strict';

  const state = window._D2DState || (window._D2DState = {});

  // Defensive: if core didn't load first, leave loud breadcrumbs but
  // still publish empty stubs so other modules don't crash on import.
  if (typeof state.getMetrics !== 'function') {
    console.error('[d2d-ui] core module missing — load d2d-tracker-core-2026b.js first');
  }

  // ============================================================================
  // PHOTO CAPTURE (UI)
  // ============================================================================
  function capturePhoto() {
    const input = document.createElement('input');
    input.type = 'file';
    // Accept iPhone HEIC + modern formats. 'image/*' alone drops HEIC
    // on desktop Chrome; explicit extensions fix that.
    input.accept = 'image/*,.heic,.heif,.avif';
    input.capture = 'environment';
    input.multiple = true;
    input.onchange = async (e) => {
      const files = Array.from(e.target.files);
      if (!files.length) return;

      if (!state.currentKnockEntry.photoFiles) state.currentKnockEntry.photoFiles = [];
      state.currentKnockEntry.photoFiles.push(...files);

      const preview = document.getElementById('d2d-photo-preview');
      if (preview) {
        preview.innerHTML = '';
        state.currentKnockEntry.photoFiles.forEach((f, i) => {
          const reader = new FileReader();
          reader.onload = (ev) => {
            preview.innerHTML += `<img src="${ev.target.result}" class="dk-thumb">`;
          };
          reader.readAsDataURL(f);
        });
      }
      window.showToast?.(`${files.length} photo${files.length > 1 ? 's' : ''} attached`, 'success');
    };
    input.click();
  }

  // ============================================================================
  // VOICE MEMO RECORDING (UI)
  // ============================================================================
  async function startVoiceRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.voiceRecorder = new MediaRecorder(stream);
      state.voiceChunks = [];
      state.voiceRecorder.ondataavailable = (e) => { if (e.data.size > 0) state.voiceChunks.push(e.data); };
      state.voiceRecorder.onstop = () => {
        state.voiceBlob = new Blob(state.voiceChunks, { type: 'audio/webm' });
        stream.getTracks().forEach(t => t.stop());
        const btn = document.getElementById('d2d-voice-btn');
        if (btn) {
          btn.innerHTML = '🎙️ Recorded';
          btn.style.background = 'var(--green, #2ECC8A)';
        }
        const playback = document.getElementById('d2d-voice-playback');
        if (playback) {
          playback.innerHTML = `<audio controls src="${URL.createObjectURL(state.voiceBlob)}" class="dk-audio"></audio>`;
        }
        window.showToast?.('Voice memo recorded', 'success');
      };
      state.voiceRecorder.start();
      setTimeout(() => { if (state.voiceRecorder?.state === 'recording') stopVoiceRecording(); }, 30000);

      const btn = document.getElementById('d2d-voice-btn');
      if (btn) {
        btn.innerHTML = '⏹️ Recording...';
        btn.style.background = 'var(--red, #E05252)';
        btn.onclick = stopVoiceRecording;
      }
    } catch(e) {
      console.error('Voice recording failed:', e);
      window.showToast?.('Microphone access denied', 'error');
    }
  }

  function stopVoiceRecording() {
    if (state.voiceRecorder?.state === 'recording') state.voiceRecorder.stop();
  }

  // ============================================================================
  // SMS TEMPLATE CHOOSER MODAL
  // ============================================================================
  function openSMSTemplateChooser(knock) {
    // Audit finding #13: single-overlay guard. Without this, fast
    // double-taps stacked multiple overlays in the DOM; only the
    // top one was clickable and the others were leaked.
    const existing = document.getElementById('d2d-sms-overlay');
    if (existing) { existing.remove(); }

    const overlay = document.createElement('div');
    overlay.className = 'd2d-modal-overlay open';
    overlay.id = 'd2d-sms-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'd2d-modal';
    modal.style.maxWidth = '400px';

    // Header (no inline onclick — CSP-safe + future inline-script removal).
    const hdr = document.createElement('div');
    hdr.className = 'd2d-modal-hdr';
    hdr.innerHTML = '<div class="d2d-modal-title">Send Follow-up</div>'
      + '<button class="d2d-modal-close" type="button" aria-label="Close">×</button>';
    hdr.querySelector('.d2d-modal-close').addEventListener('click', () => overlay.remove());
    modal.appendChild(hdr);

    const body = document.createElement('div');
    // (Former `padding:var(--s2)` dropped — --s2 is a COLOR token, so the
    // declaration always computed to 0. The .d2d-modal card already pads.)
    body.innerHTML = '<p class="dk-hint">Choose a template:</p>';

    // Per-template option button. Click handler is attached
    // programmatically so closure captures `knock` + `key` directly
    // — no JSON-stringify dance, no inline onclick attribute.
    const smsArgs = {
      phone: knock.phone, homeowner: knock.homeowner, address: knock.address,
      disposition: knock.disposition, followUpDate: knock.followUpDate
    };
    Object.entries(state.SMS_TEMPLATES).forEach(([key, tmpl]) => {
      const opt = document.createElement('div');
      opt.style.cssText = 'padding:10px;background:var(--s2);border:1px solid var(--br);border-radius:6px;margin-bottom:8px;cursor:pointer;transition:border-color var(--t-mid);';
      // Preview the RESOLVED text — templates carry a {company} token now, and
      // showing the rep a raw token (or worse, the platform owner's name) tells
      // him nothing about what his customer will actually read.
      const _preview = (typeof state.fillTemplate === 'function')
        ? state.fillTemplate(tmpl.body, {
            name: knock.homeowner || 'there',
            rep: state.currentRep?.name || window._user?.displayName || 'you',
            address: knock.address || '',
          })
        : tmpl.body;
      // ESCAPE. tmpl.body was a constant, but the resolved preview now embeds
      // the tenant's legalName and the homeowner's name — both stored, both
      // attacker-influencable — into an innerHTML sink.
      const _e = state.esc || ((s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
      opt.innerHTML = '<div class="dk-title">' + _e(tmpl.label) + '</div>'
        + '<div class="dk-sub">' + _e(_preview.substring(0, 80)) + '...</div>';
      opt.addEventListener('mouseenter', () => { opt.style.borderColor = 'var(--blue)'; });
      opt.addEventListener('mouseleave', () => { opt.style.borderColor = 'var(--br)'; });
      opt.addEventListener('click', () => {
        window.D2D.sendFollowUpSMS(smsArgs, key);
        overlay.remove();
      });
      body.appendChild(opt);
    });

    if (knock.email) {
      const sep = document.createElement('div');
      sep.style.cssText = 'margin-top:12px;padding-top:12px;border-top:1px solid var(--br);';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost';
      btn.style.cssText = 'width:100%;justify-content:center;padding:10px;';
      btn.textContent = '📧 Send Email Instead';
      const emailArgs = {
        email: knock.email, homeowner: knock.homeowner,
        address: knock.address, disposition: knock.disposition
      };
      btn.addEventListener('click', () => {
        window.D2D.sendFollowUpEmail(emailArgs);
        overlay.remove();
      });
      sep.appendChild(btn);
      body.appendChild(sep);
    }

    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ============================================================================
  // CSV EXPORT
  // ============================================================================
  function exportKnocksCSV() {
    const data = state.applyFilters();
    if (!data.length) { window.showToast?.('No knocks to export', 'error'); return; }

    const DISPOSITIONS = state.DISPOSITIONS;
    const headers = ['Address','Homeowner','Phone','Email','Disposition','Notes','Attempt #','Insurance Carrier','Claim #','Stage','Follow-up','Created','Lat','Lng'];
    const rows = data.map(k => [
      k.address || '', k.homeowner || '', k.phone || '', k.email || '',
      DISPOSITIONS[k.disposition]?.label || k.disposition || '',
      (k.notes || '').replace(/,/g, ';').replace(/\n/g, ' '),
      k.attemptNumber || '', k.insCarrier || '', k.claimNumber || '', k.stage || '',
      k.followUpDate ? state.formatDate(k.followUpDate) : '',
      k.createdAt ? state.formatDate(k.createdAt) + ' ' + state.formatTime(k.createdAt) : '',
      k.lat || '', k.lng || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`));

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `NBD-D2D-Knocks-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    window.showToast?.(`Exported ${data.length} knocks to CSV`, 'success');
  }

  // ============================================================================
  // QUICK KNOCK MODAL
  // ============================================================================
  function openQuickKnock(opts) {
    // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
    if (window.NBDRole && !window.NBDRole.guard()) return;
    // Idempotent (2026-09-25, phone-audit follow-up). Two calls used to build
    // two #d2d-quick-knock-overlay sheets with the same id — a double tap, or
    // two "+" > D2D Knock taps racing the lazy bundle — and the second call
    // also reset state.currentKnockEntry under the first. An OPEN sheet wins;
    // one that is mid-close (closeQuickKnock drops .open, removes it 300ms
    // later) goes now, so a quick close-then-reopen still opens a fresh one.
    const existing = document.getElementById('d2d-quick-knock-overlay');
    if (existing) {
      if (existing.classList.contains('open')) return;
      existing.remove();
    }
    opts = opts || {};
    const address = opts.address || '';
    const esc = state.esc;
    const DISPOSITIONS = state.DISPOSITIONS;
    const DISPO_ORDER = state.DISPO_ORDER;
    const CARRIERS = state.CARRIERS;
    const MAX_ATTEMPTS = state.MAX_ATTEMPTS;

    state.currentKnockEntry = {
      address: address,
      lat: opts.lat || null,
      lng: opts.lng || null,
      homeowner: '', phone: '', email: '', notes: '',
      disposition: null, photoFiles: [],
      insCarrier: '', claimNumber: '',
      followUpDate: '', followUpTime: '', appointmentAt: '',
      gpsAccuracy: (typeof state.gpsAccuracy === 'number') ? Math.round(state.gpsAccuracy) : null
    };

    // Pre-populate from history
    if (address) {
      const history = state.getAddressHistory(address);
      if (history.length > 0) {
        const last = history[0];
        if (last.homeowner) state.currentKnockEntry.homeowner = last.homeowner;
        if (last.phone) state.currentKnockEntry.phone = last.phone;
        if (last.email) state.currentKnockEntry.email = last.email;
      }
    }

    const attemptNum = address ? state.getAttemptCount(address) + 1 : 1;
    state.voiceBlob = null;

    const overlay = document.createElement('div');
    overlay.className = 'd2d-modal-overlay open';
    overlay.id = 'd2d-quick-knock-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) closeQuickKnock(); };

    const modal = document.createElement('div');
    modal.className = 'd2d-modal';
    modal.innerHTML = `
      <div class="d2d-modal-hdr">
        <div class="d2d-modal-title">Knock #${attemptNum}/${MAX_ATTEMPTS}${!state.isOnline ? ' <span class="dk-c-gold">⚡ Offline</span>' : ''}</div>
        <button class="d2d-modal-close" data-d2d-action="closeQuickKnock">×</button>
      </div>
      <div class="d2d-modal-body">
        <div class="d2d-field">
          <label class="d2d-field-label">Address * <span id="d2d-addr-badge" class="d2d-addr-badge"></span></label>
          <div class="d2d-addr-row">
            <input type="text" id="d2d-qk-address" class="d2d-input" value="${esc(address)}" placeholder="123 Main St, Cincinnati, OH">
            <button type="button" class="d2d-verify-btn" data-d2d-action="verifyKnockAddress" title="Re-check the door number against Google (county parcel data when connected)">✓ Verify</button>
          </div>
          <div id="d2d-addr-note" class="d2d-addr-note"></div>
          <div id="d2d-addr-confirm" class="d2d-addr-confirm" style="display:none;">
            <label class="d2d-addr-confirm-lbl"><input type="checkbox" id="d2d-addr-confirm-chk"> I've confirmed this door number is correct</label>
          </div>
        </div>

        <div class="d2d-field-label dk-mt12">Select Disposition:</div>
        ${[
          { title: 'Hot & Warm', icon: '🔥', keys: ['appointment', 'ins_has_claim', 'ins_needs_file', 'storm_damage', 'interested', 'come_back', 'callback'] },
          { title: 'Follow-up (no answer)', icon: '🔁', keys: ['revisit', 'not_home', 'left_material'] },
          { title: 'Cold / Skip', icon: '❄️', keys: ['tenant', 'not_interested', 'ins_denied', 'vacant', 'do_not_knock', 'cold_dead'] }
        ].map(g => `
          <div class="d2d-dispo-group-label">${g.icon} ${g.title}</div>
          <div class="d2d-dispo-grid">
            ${g.keys.map(key => {
              const d = DISPOSITIONS[key];
              return `<button class="d2d-dispo-btn" data-dispo="${key}" data-d2d-action="selectDispo" data-d2d-id="${key}" style="--dc:${d.color};" title="${esc(d.desc || d.label)}">
                <span class="d2d-dispo-icon">${d.icon}</span>
                <span class="d2d-dispo-label">${d.label}</span>
              </button>`;
            }).join('')}
          </div>
        `).join('')}

        <!-- Appointment Set → when (2026-10-03). Booked on the new lead as a
             dated event (lead-events.js) when the knock converts. -->
        <div id="d2d-appt-section" class="d2d-appt-section" hidden>
          <label class="d2d-field-label dk-w600" for="d2d-qk-appt">Appointment date &amp; time *</label>
          <input type="datetime-local" id="d2d-qk-appt" class="d2d-input d2d-appt-input">
        </div>

        <!-- Insurance carrier -->
        <div id="d2d-ins-section" class="d2d-ins-section">
          <label class="d2d-field-label dk-w600">Insurance Details</label>
          <select id="d2d-qk-carrier" class="d2d-input d2d-select">
            <option value="">Select Carrier...</option>
            ${CARRIERS.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
          <input type="text" id="d2d-qk-claim" class="d2d-input dk-mt8" placeholder="Claim # (optional)">
        </div>

        <details class="d2d-details">
          <summary class="d2d-details-summary">📋 Contact & Notes</summary>
          <div class="d2d-extras-body">
            <div class="d2d-field">
              <label class="d2d-field-label">Homeowner Name</label>
              <input type="text" id="d2d-qk-homeowner" class="d2d-input" value="${esc(state.currentKnockEntry.homeowner)}" placeholder="John Doe">
            </div>
            <div class="d2d-field">
              <label class="d2d-field-label">Phone</label>
              <input type="tel" id="d2d-qk-phone" class="d2d-input" value="${esc(state.currentKnockEntry.phone)}" placeholder="555-123-4567">
            </div>
            <div class="d2d-field">
              <label class="d2d-field-label">Email</label>
              <input type="email" id="d2d-qk-email" class="d2d-input" value="${esc(state.currentKnockEntry.email)}" placeholder="john@example.com">
            </div>
            <div class="d2d-field-row">
              <div class="d2d-field dk-grow">
                <label class="d2d-field-label">Follow-up Date</label>
                <input type="date" id="d2d-qk-followup" class="d2d-input">
              </div>
              <div class="d2d-field dk-grow">
                <label class="d2d-field-label">Follow-up Time</label>
                <input type="time" id="d2d-qk-followup-time" class="d2d-input">
              </div>
            </div>
            <div class="d2d-field">
              <label class="d2d-field-label">Notes</label>
              <textarea id="d2d-qk-notes" class="d2d-textarea" placeholder="Add any notes..."></textarea>
            </div>
            <div class="d2d-media-btns">
              <button class="d2d-action-btn dk-grow dk-bg-orange" data-d2d-action="capturePhoto">📷 Photo</button>
              <button class="d2d-action-btn dk-grow dk-bg-blue" id="d2d-voice-btn" data-d2d-action="startVoice">🎙️ Voice Memo</button>
            </div>
            <div id="d2d-photo-preview" class="d2d-photo-grid"></div>
            <div id="d2d-voice-playback"></div>
          </div>
        </details>

        <button id="d2d-qk-save" class="d2d-save-btn" data-d2d-action="submitKnock" disabled>
          Select Disposition
        </button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Setup autocomplete after DOM insertion
    setTimeout(() => state.setupAddressAutocomplete('d2d-qk-address'), 100);

    // Invalidate a verdict the moment the rep edits the address away from what
    // was verified — otherwise the save gate would pass a stale 'verified' for
    // a different address than what's now in the box.
    setTimeout(() => {
      const input = document.getElementById('d2d-qk-address');
      if (!input) return;
      input.addEventListener('input', () => {
        const e = state.currentKnockEntry;
        if (!e) return;
        if (input.value.trim() === (e.addrVerifiedFor || '')) return;
        if (e.addrConfidence || e.addrConfirmed) {
          e.addrConfidence = undefined; e.addrConfirmed = false; e.addrVerifiedFor = '';
        }
        setAddrBadge('');
        const note = document.getElementById('d2d-addr-note');
        if (note) note.innerHTML = '<span class="d2d-addr-reasons">Address edited — tap ✓ Verify to re-check the door number.</span>';
        const cw = document.getElementById('d2d-addr-confirm');
        if (cw) cw.style.display = 'none';
      });
      // Bind the confirm checkbox once (CSP-safe JS property). Confirming
      // applies to the exact text in the box at tick time.
      const chk = document.getElementById('d2d-addr-confirm-chk');
      if (chk) chk.onchange = () => {
        const e = state.currentKnockEntry;
        if (!e) return;
        e.addrConfirmed = chk.checked;
        if (chk.checked) e.addrVerifiedFor = (input.value || '').trim();
      };
    }, 130);

    // Kick off door-number verification: reverse-resolve a bare map tap, or
    // forward-verify a pre-filled (re-knock / history) address. The result
    // drives the confidence badge + confirm gate.
    setTimeout(() => {
      // Guard: a slow network result must not land on a NEWER knock if the rep
      // closed/reopened the modal while it was in flight.
      const myEntry = state.currentKnockEntry;
      setAddrBadge('resolving');
      const hasCoords = opts.lat != null && opts.lng != null;
      const p = (!address && hasCoords)
        ? state.resolveDoorAt(opts.lat, opts.lng)
        : (address ? state.verifyAddressString(address, opts.lat, opts.lng) : null);
      if (!p) { setAddrBadge(''); return; }
      p.then(res => { if (state.currentKnockEntry !== myEntry) return; if (res) applyResolution(res, { fromTap: !address }); else setAddrBadge(''); })
       .catch(err => { if (state.currentKnockEntry !== myEntry) return; console.warn('[D2D] address verify failed:', err && err.message || err); setAddrBadge('error'); });
    }, 120);
  }

  // ── Address-confidence UI (badge + note + confirm gate) ─────────────
  const ADDR_BADGE = {
    resolving:  { t: '⏳ Verifying…',   c: 'var(--m)' },
    verified:   { t: '🟢 Verified',      c: 'var(--green)' },
    likely:     { t: '🟡 Confirm',       c: 'var(--gold)' },
    conflict:   { t: '🟠 Mismatch',      c: 'var(--orange)' },
    unverified: { t: '🔴 No door #',     c: 'var(--red)' },
    error:      { t: '⚠️ Check failed',  c: 'var(--m)' }
  };
  function setAddrBadge(kind) {
    const badge = document.getElementById('d2d-addr-badge');
    if (!badge) return;
    const m = ADDR_BADGE[kind];
    badge.textContent = m ? m.t : '';
    badge.style.color = m ? m.c : 'var(--m)';
    badge.dataset.state = kind || '';
  }

  function renderAddrConfidence(res) {
    const esc = state.esc, escAttr = state.escapeHtml;
    setAddrBadge(res.confidence);
    const note = document.getElementById('d2d-addr-note');
    const confirmWrap = document.getElementById('d2d-addr-confirm');
    const chk = document.getElementById('d2d-addr-confirm-chk');
    if (note) {
      let html = '<span class="d2d-addr-reasons">' + res.reasons.map(r => esc(r)).join(' ') + '</span>';
      // On a conflict, offer each source's door number as a one-tap pick.
      if (res.confidence === 'conflict' && res.sources.length > 1) {
        html += '<div class="d2d-addr-alts">' + res.sources.map(s => {
          const args = escAttr(JSON.stringify({ address: s.formatted, houseNumber: s.houseNumber, lat: s.lat, lng: s.lng }));
          return `<button type="button" class="d2d-addr-alt" data-d2d-action="pickAddrSource" data-d2d-args='${args}'>${esc(s.label)}: <b>#${esc(s.houseNumber)}</b></button>`;
        }).join('') + '</div>';
      }
      note.innerHTML = html;
    }
    if (confirmWrap && chk) {
      const needsConfirm = res.confidence !== 'verified';
      // Save hard-requires a leading door number in the box (handleSubmitKnock),
      // so offering "I've confirmed this door number" when there is none to
      // confirm was a dead end: ticked, then rejected. Ask for the number.
      const typed = (document.getElementById('d2d-qk-address') || {}).value || '';
      const hasTypedNumber = !!state.extractHouseNumber(typed);
      if (needsConfirm && !hasTypedNumber) {
        confirmWrap.style.display = 'none';
        if (note) note.insertAdjacentHTML('beforeend', '<div class="d2d-addr-reasons"><b>Type the door number at the start of the address</b> (e.g. "123 Main St"), then tap ✓ Verify.</div>');
        return;
      }
      confirmWrap.style.display = needsConfirm ? 'block' : 'none';
      chk.checked = needsConfirm ? !!(state.currentKnockEntry && state.currentKnockEntry.addrConfirmed) : true;
      // onchange is bound once at modal setup (see openQuickKnock).
    }
  }

  function applyResolution(res, opts) {
    opts = opts || {};
    const e = state.currentKnockEntry;
    if (!e || !res) return;
    const input = document.getElementById('d2d-qk-address');
    // Adopt the resolved address on a fresh map tap; on manual verify keep the
    // rep's typed text but still adopt coords + confidence.
    if (opts.fromTap && res.address && input) { input.value = res.address; e.address = res.address; }
    if (res.lat != null) e.lat = res.lat;
    if (res.lng != null) e.lng = res.lng;
    e.addrConfidence = res.confidence;
    e.addrHouseNumber = res.houseNumber;
    e.addrConfirmed = (res.confidence === 'verified'); // verified needs no manual tick
    // Provenance stamped onto the saved knock (data-quality reporting + re-verify).
    e.addrSources = (res.sources || []).map(s => ({ src: s.label, hn: s.houseNumber }));
    e.addrRoundTripMeters = (typeof res.roundTripMeters === 'number') ? res.roundTripMeters : null;
    e.addrNeedsReverify = !!res.needsReverify; // saved offline / unresolved → re-verify queue picks it up
    // Remember exactly which address string this verdict applies to, so an
    // edit to the field afterwards invalidates it (see the input listener).
    e.addrVerifiedFor = ((input && input.value) || res.address || '').trim();
    renderAddrConfidence(res);
  }

  // Re-run verification against whatever's in the address box (✓ Verify button).
  function verifyKnockAddress() {
    const input = document.getElementById('d2d-qk-address');
    const val = (input && input.value || '').trim();
    if (val.length < 5) { window.showToast?.('Enter an address first', 'info'); return; }
    setAddrBadge('resolving');
    const e = state.currentKnockEntry;
    state.verifyAddressString(val, e && e.lat, e && e.lng)
      .then(res => { if (state.currentKnockEntry !== e) return; applyResolution(res, { fromTap: false }); })
      .catch(err => { if (state.currentKnockEntry !== e) return; console.warn('[D2D] verify failed:', err && err.message || err); setAddrBadge('error'); });
  }

  function selectDispo(key, btn) {
    state.currentKnockEntry.disposition = key;
    const dispo = state.DISPOSITIONS[key];

    document.querySelectorAll('.d2d-dispo-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');

    const saveBtn = document.getElementById('d2d-qk-save');
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.style.background = dispo.color;
      saveBtn.style.color = 'white';
      saveBtn.style.cursor = 'pointer';
      saveBtn.textContent = `${dispo.icon} ${dispo.label}`;
    }

    // Appointment Set asks when (2026-10-03).
    const apptSection = document.getElementById('d2d-appt-section');
    if (apptSection) {
      apptSection.hidden = key !== 'appointment';
      // The disposition grid is tall: on a phone the new field opens ~900px
      // below the button just tapped. Bring it to the rep (no focus — that
      // would pop the date wheel before they've looked).
      if (key === 'appointment') {
        try { apptSection.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { apptSection.scrollIntoView(); }
      }
    }

    // Show/hide insurance section
    const insSection = document.getElementById('d2d-ins-section');
    if (insSection) insSection.style.display = state.INS_DISPOSITIONS.includes(key) ? 'block' : 'none';

    // Auto-set follow-up
    if (dispo.autoFollowUp) {
      const fupInput = document.getElementById('d2d-qk-followup');
      if (fupInput) {
        const d = new Date();
        d.setDate(d.getDate() + dispo.autoFollowUp);
        fupInput.valueAsDate = d;
      }
      document.querySelector('.d2d-details')?.setAttribute('open', '');
    }
  }

  function closeQuickKnock() {
    const overlay = document.getElementById('d2d-quick-knock-overlay');
    if (overlay) { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 300); }
    state.currentKnockEntry = null;
    state.voiceBlob = null;
    // Remove the tapped-parcel outline once the knock is done with.
    if (typeof state.clearTapParcel === 'function') state.clearTapParcel();
  }

  // Save's validation gates point at fields near the TOP of the knock sheet
  // while Save sits at the bottom of a scrolled body. Centre the field in the
  // sheet and focus its control (preventScroll: the focus must not undo the
  // centring scroll with a jump of its own).
  function _bringIntoView(el, focusEl) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { el.scrollIntoView(); }
    if (focusEl && typeof focusEl.focus === 'function') {
      try { focusEl.focus({ preventScroll: true }); } catch (_) { focusEl.focus(); }
    }
  }

  let _knockSubmitInFlight = false;
  async function handleSubmitKnock() {
    // Guard against double-submit: photo+voice uploads can take several
    // seconds, during which the user can tap Save again and create
    // duplicate knock records (plus duplicate uploads that eat storage
    // quota). Single flag, cleared in a finally block below.
    if (_knockSubmitInFlight) return;
    _knockSubmitInFlight = true;
    // Capture the button + its original label up here so the finally
    // block below ALWAYS restores it, even if submitKnock throws or
    // times out. Previously the button was only re-enabled implicitly
    // by closeQuickKnock(); on a hung addDoc that never ran, leaving
    // the button stuck on "Saving..." with no recovery path.
    const saveBtn = document.getElementById('d2d-qk-save');
    const originalLabel = saveBtn ? saveBtn.textContent : '';
    let knockSaved = false;
    try {
    const address = (document.getElementById('d2d-qk-address')?.value || '').trim();
    if (!address) {
      window.showToast?.('Address required', 'error');
      _bringIntoView(document.getElementById('d2d-qk-address'), document.getElementById('d2d-qk-address'));
      return;
    }
    if (!state.currentKnockEntry?.disposition) { window.showToast?.('Disposition required', 'error'); return; }

    // ── Door-number accuracy gate ──────────────────────────────────
    // Every knock must carry a house number, and unless it was machine-
    // VERIFIED (≥2 sources agree) the rep must tick the confirm box. This is
    // what makes "100% accurate door numbers" enforceable rather than a hope.
    const houseNum = state.extractHouseNumber(address);
    if (!houseNum) {
      window.showToast?.('Add the door number to this address', 'error');
      _bringIntoView(document.getElementById('d2d-qk-address'), document.getElementById('d2d-qk-address'));
      return;
    }
    const entry = state.currentKnockEntry || {};
    const addrConf = entry.addrConfidence;
    // The verdict must apply to the address STILL in the box. Editing the text,
    // or picking a different autocomplete suggestion (which sets .value without
    // firing 'input'), moves it out of sync with addrVerifiedFor — so a
    // swapped-in address can never ride a prior verify/confirm.
    const verdictAppliesToText = (entry.addrVerifiedFor || '') === address;
    const addrOk = verdictAppliesToText && (addrConf === 'verified' || entry.addrConfirmed);
    if (!addrOk) {
      window.showToast?.('Confirm the door number is correct (check the box)', 'error');
      const wrap = document.getElementById('d2d-addr-confirm');
      if (wrap) {
        wrap.style.display = 'block';
        wrap.classList.remove('d2d-addr-confirm-flash');
        void wrap.offsetWidth;              // restart the flash animation
        wrap.classList.add('d2d-addr-confirm-flash');
        // The flash used to play off-screen: the confirm row sits under the
        // address at the TOP of the sheet and this gate fires from Save at the
        // BOTTOM — on a phone ~800px of scrolled body apart — so the toast
        // pointed at a box the rep could not see (phone audit 2026-09-25,
        // pipeline#5). Bring it to them.
        _bringIntoView(wrap, document.getElementById('d2d-addr-confirm-chk'));
      }
      return;
    }

    state.currentKnockEntry.address = address;
    state.currentKnockEntry.homeowner = document.getElementById('d2d-qk-homeowner')?.value || '';
    state.currentKnockEntry.phone = document.getElementById('d2d-qk-phone')?.value || '';
    state.currentKnockEntry.email = document.getElementById('d2d-qk-email')?.value || '';
    state.currentKnockEntry.notes = document.getElementById('d2d-qk-notes')?.value || '';
    state.currentKnockEntry.followUpDate = document.getElementById('d2d-qk-followup')?.value || '';
    state.currentKnockEntry.followUpTime = document.getElementById('d2d-qk-followup-time')?.value || '';
    state.currentKnockEntry.insCarrier = document.getElementById('d2d-qk-carrier')?.value || '';
    state.currentKnockEntry.claimNumber = document.getElementById('d2d-qk-claim')?.value || '';
    // An appointment needs its date and time — that IS the appointment
    // (2026-10-03). It is booked on the lead when the knock converts.
    state.currentKnockEntry.appointmentAt = '';
    if (state.currentKnockEntry.disposition === 'appointment') {
      const apptEl = document.getElementById('d2d-qk-appt');
      const apptVal = (apptEl && apptEl.value) || '';
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(apptVal)) {
        window.showToast?.('Pick the appointment date and time', 'error');
        _bringIntoView(document.getElementById('d2d-appt-section'), apptEl);
        return;
      }
      state.currentKnockEntry.appointmentAt = apptVal;
    }

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

    // Upload photos and voice before saving
    let photoUrls = [];
    let photoPaths = [];
    let voiceUrl = '';
    const tempId = Date.now().toString();

    // Photos go to uploadPhotos online OR offline (2026-10-04): it resizes
    // them and, when there is no signal or the upload fails, holds them in
    // the on-phone photo queue against this knock's tempId — the old
    // `&& state.isOnline` gate silently dropped every photo taken offline.
    let photosHeld = 0;
    if (state.currentKnockEntry.photoFiles?.length > 0) {
      // uploadPhotos returns an ARRAY of urls carrying a `paths` property
      // (index-aligned storage paths, persisted so the image pipeline can
      // stamp photoVariants on the knock doc). The array-with-property
      // shape is deliberate: it stays harmless under service-worker
      // version skew in BOTH directions — a stale core returns a plain
      // array (paths comes back undefined → []), and a stale UI paired
      // with the fresh core still assigns a real array to photoUrls.
      const uploaded = await state.uploadPhotos(state.currentKnockEntry.photoFiles, tempId);
      photoUrls = Array.isArray(uploaded) ? uploaded.slice() : [];
      photoPaths = (uploaded && Array.isArray(uploaded.paths)) ? uploaded.paths : [];
      photosHeld = (uploaded && Number(uploaded.queued)) || 0;
    }
    state.currentKnockEntry.clientTempId = tempId;
    state.currentKnockEntry.photosHeld = photosHeld;
    if (state.voiceBlob && state.isOnline) {
      voiceUrl = await state.uploadVoiceMemo(state.voiceBlob, tempId);
    }

    state.currentKnockEntry.photoUrls = photoUrls;
    state.currentKnockEntry.photoPaths = photoPaths;
    state.currentKnockEntry.voiceUrl = voiceUrl;

    const savedDispo = state.currentKnockEntry.disposition;
    const savedPhone = state.currentKnockEntry.phone;
    const knockId = await state.submitKnock(state.currentKnockEntry);

    if (!knockId) {
      // submitKnock returned null = error toast already shown.
      // Leave the modal open so the user can retry without re-typing.
      return;
    }

    knockSaved = true;
    closeQuickKnock();

    // Hot dispositions are already auto-converted to a CRM lead by submitKnock
    // (core: convertToLead after save). A second "Convert Now?" prompt here
    // contradicted the "Converted to CRM Lead" toast and its Edit First path
    // could create a duplicate lead — so no prompt; just offer the follow-up text.
    if (savedPhone && ['interested', 'appointment', 'storm_damage', 'ins_has_claim'].includes(savedDispo)) {
      setTimeout(async () => {
        if (await state.uiConfirm('Send follow-up text?', { okLabel: 'Yes, text them' })) {
          const knock = state.knocks.find(k => k.id === knockId);
          if (knock) openSMSTemplateChooser(knock);
        }
      }, 500);
    }
    } catch (err) {
      // submitKnock catches its own errors, so reaching here means a
      // throw from uploadPhotos / uploadVoiceMemo / addDoc timeout.
      console.error('handleSubmitKnock failed:', err);
      window.showToast?.(
        err && /timeout/i.test(err.message || '')
          ? 'Save timed out — check connection and try again'
          : 'Save failed — please try again',
        'error'
      );
    } finally {
      // Restore button state even on hang/throw. closeQuickKnock removes
      // the overlay (and the button with it) on success, so this only
      // matters when the modal is still open — exactly the failure path
      // where the user needs to retry.
      if (!knockSaved && saveBtn && document.body.contains(saveBtn)) {
        saveBtn.disabled = false;
        saveBtn.textContent = originalLabel || 'Save Knock';
      }
      _knockSubmitInFlight = false;
    }
  }

  // Show a branded prompt to convert knock → CRM lead
  function showConversionPrompt(knockId, dispoLabel) {
    const esc = state.esc;
    const overlay = document.createElement('div');
    overlay.className = 'd2d-modal-overlay open';
    overlay.id = 'd2d-convert-prompt';
    // Above the (already-closed) knock modal tier, below toasts — the old
    // inline 10002 sat ON the toast layer and covered save confirmations.
    overlay.style.zIndex = 'var(--z-overlay-top)';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const modal = document.createElement('div');
    modal.className = 'd2d-modal';
    modal.style.maxWidth = '360px';
    modal.innerHTML = `
      <div class="d2d-modal-body dk-prompt">
        <div class="dk-prompt-icon">🔥</div>
        <div class="dk-prompt-title">Hot Lead Detected</div>
        <div class="dk-prompt-sub">"${esc(dispoLabel)}" — convert this knock into a CRM lead so it shows up in your pipeline?</div>
        <div class="dk-row10">
          <button class="btn btn-green dk-btn-grow dk-btn-tall" data-d2d-action="convertToLeadAndDismissPrompt" data-d2d-id="${knockId}">
            ✅ Convert Now
          </button>
          <button class="btn btn-ghost dk-btn-grow dk-btn-tall" data-d2d-action="convertToLeadWithEditAndDismissPrompt" data-d2d-id="${knockId}">
            ✏️ Edit First
          </button>
        </div>
        <button class="dk-link-btn" data-d2d-action="dismissConvertPrompt">Skip for now</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // ============================================================================
  // KNOCK DETAIL MODAL
  // ============================================================================
  function openKnockDetail(knockId) {
    const knock = state.knocks.find(k => k.id === knockId);
    if (!knock) {
      if (typeof window.showToast === 'function') window.showToast('Knock not found — it may have been deleted', 'error');
      return;
    }

    const esc = state.esc;
    const DISPOSITIONS = state.DISPOSITIONS;
    const MAX_ATTEMPTS = state.MAX_ATTEMPTS;
    const dispo = DISPOSITIONS[knock.disposition];
    const attempts = state.getAttemptCount(knock.address);
    const history = state.getAddressHistory(knock.address);
    // Escape the knock id for interpolation into inline onclick
    // handlers below. Firestore doc IDs are alphanumeric today but
    // this guards against any future ID scheme that includes quotes.
    const safeId = esc(knock.id);

    const overlay = document.createElement('div');
    overlay.className = 'd2d-modal-overlay open';
    overlay.id = 'd2d-detail-overlay';
    // Esc to close — user said everything has to be accessible.
    overlay.onclick = (e) => { if (e.target === overlay) closeKnockDetail(); };
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        closeKnockDetail();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);

    const modal = document.createElement('div');
    modal.className = 'd2d-modal';
    modal.innerHTML = `
      <div class="d2d-modal-hdr">
        <div class="d2d-modal-title">${esc(knock.address)}</div>
        <button class="d2d-modal-close" data-d2d-action="closeKnockDetail">×</button>
      </div>
      <div class="d2d-modal-body">
        <div class="d2d-detail-badge" style="background:${dispo?.color};">
          ${dispo?.icon} ${dispo?.label} · Knock #${attempts}/${MAX_ATTEMPTS}
        </div>

        <div class="d2d-detail-grid">
          <div class="d2d-detail-field">
            <label class="d2d-detail-label">Homeowner</label>
            <div class="d2d-detail-value">${esc(knock.homeowner || '—')}</div>
          </div>
          <div class="d2d-detail-field">
            <label class="d2d-detail-label">Phone</label>
            <div class="d2d-detail-value">${knock.phone ? `<a href="tel:${esc(knock.phone)}" class="d2d-detail-link">${esc(knock.phone)}</a>` : '—'}</div>
          </div>
          <div class="d2d-detail-field">
            <label class="d2d-detail-label">Email</label>
            <div class="d2d-detail-value">${knock.email ? `<a href="mailto:${esc(knock.email)}" class="d2d-detail-link">${esc(knock.email)}</a>` : '—'}</div>
          </div>
          ${knock.insCarrier ? `<div class="d2d-detail-field">
            <label class="d2d-detail-label">Insurance</label>
            <div class="d2d-detail-value">${esc(knock.insCarrier)}${knock.claimNumber ? ` · #${esc(knock.claimNumber)}` : ''}</div>
          </div>` : ''}
        </div>

        ${knock.notes ? `<div class="d2d-detail-section"><label class="d2d-detail-label">Notes</label><div class="d2d-detail-notes">${esc(knock.notes)}</div></div>` : ''}

        ${knock.followUpDate ? `<div class="d2d-detail-section"><label class="d2d-detail-label">Follow-up</label><div class="d2d-detail-value">${state.formatDate(knock.followUpDate)}</div></div>` : ''}

        <div class="d2d-detail-section">
          <label class="d2d-detail-label">🏠 Property</label>
          <div id="d2d-pi-${safeId}" class="d2d-pi-wrap">
            <button class="d2d-action-btn dk-bg-plain dk-full" data-d2d-action="loadPropertyIntel" data-d2d-id="${safeId}">🏠 Load owner &amp; roof intel</button>
          </div>
        </div>

        ${knock.photoUrls?.length ? `<div class="d2d-detail-section"><label class="d2d-detail-label">Photos (${knock.photoUrls.length})</label><div class="d2d-photo-grid">${knock.photoUrls.map((url, i) => `<img src="${esc(knock.photoVariants?.[i]?.thumb || url)}" class="d2d-photo-thumb" loading="lazy" data-d2d-action="openImage" data-d2d-id="${esc(url)}" data-d2d-on-error="brokenPhoto">`).join('')}</div></div>` : ''}

        ${knock.voiceUrl ? `<div class="d2d-detail-section"><label class="d2d-detail-label">Voice Memo</label><audio controls src="${esc(knock.voiceUrl)}" class="d2d-audio-player"></audio></div>` : ''}

        <div class="d2d-detail-section">
          <label class="d2d-detail-label">📍 Address History (${history.length})</label>
          <div class="d2d-history-list">
            ${history.slice(0, 5).map(h => `
              <div class="d2d-history-item">
                <div class="d2d-history-dispo">${DISPOSITIONS[h.disposition]?.icon} ${DISPOSITIONS[h.disposition]?.label}</div>
                <div class="d2d-history-time">${state.formatDate(h.createdAt)} at ${state.formatTime(h.createdAt)}</div>
                ${h.notes ? `<div class="d2d-history-notes">${esc(h.notes.substring(0, 100))}</div>` : ''}
              </div>
            `).join('')}
          </div>
        </div>

        <div class="d2d-detail-actions">
          ${!knock.convertedToLead ? `
            <button class="d2d-action-btn dk-bg-green" data-d2d-action="convertToLead" data-d2d-id="${safeId}" aria-label="Convert knock to lead">✓ Convert to Lead</button>
          ` : `
            <button class="d2d-action-btn dk-bg-muted" disabled aria-label="Already converted to lead">✓ Lead Created</button>
          `}
          <button class="d2d-action-btn dk-bg-orange" data-d2d-action="openQuickKnock" data-d2d-args='{"address":"${esc(knock.address)}","lat":${Number(knock.lat) || 'null'},"lng":${Number(knock.lng) || 'null'}}' aria-label="Re-knock this address">↻ Re-Knock</button>
          ${knock.phone ? `<button class="d2d-action-btn dk-bg-blue" data-d2d-action="openSMSChooser" data-d2d-id="${safeId}" aria-label="Send SMS follow-up">📱 Follow Up</button>` : ''}
          <button class="d2d-action-btn dk-bg-red" data-d2d-action="deleteKnock" data-d2d-id="${safeId}" aria-label="Delete this knock">🗑️ Delete</button>
        </div>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  function closeKnockDetail() {
    const overlay = document.getElementById('d2d-detail-overlay');
    if (overlay) { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 300); }
  }

  // ============================================================================
  // TAB SWITCHING + FILTER MUTATORS
  // ============================================================================
  function setTab(tab) {
    state.currentTab = tab;
    renderD2D();
  }
  function setDateFilter(range) { state.filterDateRange = range; renderD2D(); }
  function setDispoFilter(val) { state.filterDispo = val || null; renderD2D(); }

  // ============================================================================
  // MAIN RENDER
  // ============================================================================
  function renderD2D() {
    const container = document.getElementById('d2dContent');
    if (!container) return;

    const esc = state.esc;
    const DISPOSITIONS = state.DISPOSITIONS;
    const DISPO_ORDER = state.DISPO_ORDER;
    const HOT_DISPOSITIONS = state.HOT_DISPOSITIONS;
    const MAX_ATTEMPTS = state.MAX_ATTEMPTS;
    const PAGE_SIZE = state.PAGE_SIZE;
    const currentTab = state.currentTab;
    const filterDateRange = state.filterDateRange;
    const filterDispo = state.filterDispo;
    const formatTime = state.formatTime;
    const timeAgo = state.timeAgo;

    const metrics = state.getMetrics();
    const revenue = state.getRevenueMetrics();
    const timeOfDay = state.getTimeOfDayStats();
    const breakdown = state.getDispositionBreakdown();
    const filtered = state.applyFilters();
    const gamify = state.getGamificationData();
    const insMetrics = state.getInsuranceMetrics();

    const funnel = revenue.conversionFunnel;
    const maxFunnelVal = Math.max(funnel.doors, funnel.conversations, funnel.appointments, funnel.estimates, funnel.closed, 1);

    // Headline "Value Per Door" is now the LIVE expected pipeline value
    // (Σ close-probability × deal size ÷ doors) so it moves the instant a rep
    // logs an appointment / claim / storm hit — instead of freezing on a
    // static "industry avg" until a deal literally closes.
    const perDoorText = revenue.totalDoorsKnocked > 0 ? '$' + revenue.expectedPerDoor.toLocaleString() : '—';

    // .stab-btn = the design-system underline tab (settings/storm vocabulary).
    // flex:1 + 44px tap target kept inline (layout, not button chrome).
    const tabBtn = (id, label, icon) => `<button class="stab-btn${currentTab === id ? ' stab-active' : ''} dk-tab" data-d2d-action="setTab" data-d2d-id="${id}">${icon} ${label}</button>`;

    let html = `
      <div class="dk-pad">

        ${!state.isOnline ? `<div class="dk-banner-gold">⚡ Offline — ${state.offlineQueue.length} queued</div>` : ''}

        <!-- Revenue Banner -->
        <div class="d2d-revenue-banner">
          <div class="d2d-rev-main">
            <div class="d2d-rev-primary">
              <div class="d2d-revenue-label">Expected Value / Door</div>
              <div class="d2d-revenue-amount">${perDoorText}</div>
              <div class="d2d-rev-tag">◉ Projected — not yet earned</div>
            </div>
            <div class="d2d-streak">
              <div class="d2d-streak-badge-sm">${gamify.currentMilestone ? gamify.currentMilestone.badge : '🔥'}</div>
              <div class="d2d-streak-num">${gamify.streak}</div>
              <div class="d2d-streak-lbl">Day Streak</div>
            </div>
          </div>
          <div class="d2d-rev-foot">
            <span class="d2d-rev-chip"><span class="d2d-rev-chip-k">Pipeline</span> $${revenue.pipelineValue.toLocaleString()}</span>
            <span class="d2d-rev-chip"><span class="d2d-rev-chip-k">Closed</span> ${revenue.totalClosed > 0 ? '$' + revenue.totalRevenue.toLocaleString() + ' · ' + revenue.totalClosed : '—'}</span>
            ${gamify.projectedRevenue > 0 ? `<span class="d2d-rev-chip"><span class="d2d-rev-chip-k">Proj/mo</span> $${gamify.projectedRevenue.toLocaleString()}</span>` : ''}
          </div>
        </div>

        <!-- Action Bar -->
        <div class="d2d-action-bar">
          <button data-d2d-action="openQuickKnock" class="d2d-big-btn">🚪 Knock</button>
          <button data-d2d-action="toggleHeatMap" class="d2d-big-btn d2d-big-btn-sec">${state.showHeat ? '🔥' : '❄️'} Heat</button>
          <button data-d2d-action="toggleHail" class="d2d-big-btn d2d-big-btn-sec" title="Recent hail reports">⛈ Hail</button>
          <button data-d2d-action="stormZone" class="d2d-big-btn d2d-big-btn-sec" title="Create a canvassing territory from recent hail">🌩️ Zone</button>
          <button data-d2d-action="centerOnMe" class="d2d-big-btn d2d-big-btn-sec">📍 Me</button>
          <button data-d2d-action="toggleTeamMode" class="d2d-big-btn d2d-big-btn-sec${state.teamMode ? ' d2d-big-btn-on' : ''}" title="Live team activity">${state.teamMode ? '👥' : '👤'} Team</button>
          <button data-d2d-action="exportCSV" class="d2d-big-btn d2d-big-btn-sec">📥 CSV</button>
        </div>

        <!-- Tab Bar -->
        <div class="dk-tabs">
          ${tabBtn('feed', 'Feed', '📋')}
          ${tabBtn('routes', 'Routes', '🗺️')}
          ${tabBtn('gamify', 'Challenges', '🏆')}
          ${tabBtn('analytics', 'Stats', '📊')}
        </div>
    `;

    // ─── FEED TAB ───
    if (currentTab === 'feed') {
      // Live Team panel — real-time teammate activity (onSnapshot-driven).
      let teamPanel = '';
      if (state.teamMode) {
        const ta = state.getTeamActivity();
        teamPanel = `
          <div class="d2d-team-panel">
            <div class="d2d-team-hd">
              <span class="d2d-team-live"><span class="d2d-live-dot"></span> Live Team</span>
              <span class="d2d-team-stat">${ta.activeNow} active · ${ta.totalToday} today</span>
            </div>
            ${ta.reps.length ? `<div class="d2d-team-reps">
              ${ta.reps.slice(0, 6).map(r => {
                const isLive = (Date.now() - r.lastMs) < 3600e3;
                const mins = Math.round((Date.now() - r.lastMs) / 60000);
                const nm = r.name || 'Rep';
                return `<div class="d2d-team-rep">
                  <span class="d2d-team-avatar${isLive ? ' live' : ''}">${esc(nm.slice(0, 1).toUpperCase())}</span>
                  <span class="d2d-team-name">${esc(nm)}</span>
                  <span class="d2d-team-count">${r.knocksToday} today · ${r.appts} apt</span>
                  <span class="d2d-team-ago">${isLive ? (mins < 1 ? 'now' : mins + 'm') : ''}</span>
                </div>`;
              }).join('')}
            </div>` : '<div class="d2d-aq-sub dk-mt6">No team knocks yet today.</div>'}
          </div>`;
      }
      html += `
        ${teamPanel}
        <!-- Follow-ups Due — Full Interactive List -->
        ${metrics.followUpsDue.length > 0 ? `
          <div class="d2d-followups-banner">
            <div class="dk-head-row">
              <div class="d2d-followups-title">📋 ${metrics.followUpsDue.length} Follow-up${metrics.followUpsDue.length !== 1 ? 's' : ''} Due</div>
              <button class="btn btn-ghost btn-sm" data-d2d-action="dismissFollowupsBanner">Dismiss</button>
            </div>
            <div class="d2d-followups-list dk-scroll">
              ${metrics.followUpsDue.map(k => {
                const dispo = DISPOSITIONS[k.disposition];
                const fDate = k.followUpDate ? new Date(k.followUpDate instanceof Date ? k.followUpDate : (k.followUpDate.seconds ? k.followUpDate.seconds * 1000 : k.followUpDate)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
                return `
                <div class="d2d-followup-item dk-followup" data-d2d-action="openKnockDetail" data-d2d-id="${esc(k.id)}">
                  <div class="dk-icon">${dispo?.icon || '📋'}</div>
                  <div class="dk-grow dk-min0">
                    <div class="dk-name">${esc(k.address?.substring(0, 50) || 'No address')}</div>
                    <div class="dk-meta">${dispo?.label || ''} ${fDate ? '· Due ' + fDate : ''} ${k.homeowner ? '· ' + esc(k.homeowner) : ''}</div>
                  </div>
                  <div class="dk-row4">
                    ${k.phone ? `<button class="btn btn-ghost btn-sm" data-d2d-action="callPhone" data-d2d-id="${esc(k.phone)}" data-d2d-stop="1">📞</button>` : ''}
                    <button class="btn btn-orange btn-sm" data-d2d-action="openQuickKnock" data-d2d-args='{"address":"${esc(k.address || '')}","lat":${Number(k.lat) || 'null'},"lng":${Number(k.lng) || 'null'}}' data-d2d-stop="1">↻</button>
                  </div>
                </div>`;
              }).join('')}
            </div>
          </div>
        ` : ''}

        <!-- Metrics Grid -->
        <div class="d2d-metrics-grid">
          <div class="d2d-metric-card">
            <div class="d2d-metric-val dk-c-blue">${metrics.today}</div>
            <div class="d2d-metric-lbl">Today</div>
          </div>
          <div class="d2d-metric-card">
            <div class="d2d-metric-val dk-c-blue">${metrics.week}</div>
            <div class="d2d-metric-lbl">Week</div>
          </div>
          <div class="d2d-metric-card">
            <div class="d2d-metric-val dk-c-green">${metrics.appointments}</div>
            <div class="d2d-metric-lbl">Appts</div>
          </div>
          <div class="d2d-metric-card">
            <div class="d2d-metric-val dk-c-gold">${metrics.conversionRate}%</div>
            <div class="d2d-metric-lbl">Conv</div>
          </div>
          <div class="d2d-metric-card">
            <div class="d2d-metric-val dk-c-orange">${revenue.totalDoorsKnocked > 0 ? '$' + revenue.expectedPerDoor.toLocaleString() : '—'}</div>
            <div class="d2d-metric-lbl">Exp/Door</div>
          </div>
          <div class="d2d-metric-card">
            <div class="d2d-metric-val dk-c-purple">${revenue.avgDealSize > 0 ? '$' + revenue.avgDealSize.toLocaleString() : '—'}</div>
            <div class="d2d-metric-lbl">Avg Deal</div>
          </div>
        </div>

        <!-- Conversion Funnel — full-width stage rows so labels never truncate -->
        <div class="d2d-block">
          <div class="d2d-block-title">Conversion Funnel</div>
          <div class="d2d-funnel">
            ${[
              { label: 'Doors',         icon: '🚪', val: funnel.doors,         color: 'var(--m,#6B7280)' },
              { label: 'Conversations', icon: '💬', val: funnel.conversations, color: 'var(--gold,#EAB308)' },
              { label: 'Appointments',  icon: '📅', val: funnel.appointments,  color: 'var(--blue,#4A9EFF)' },
              { label: 'Estimates',     icon: '📐', val: funnel.estimates,     color: 'var(--green,#2ECC8A)' },
              { label: 'Closed',        icon: '🤝', val: funnel.closed,        color: 'var(--orange,#BD5728)' }
            ].map((s, i, arr) => {
              const w = s.val > 0 ? Math.max(s.val / maxFunnelVal * 100, 8) : 0;
              const prev = i > 0 ? arr[i - 1].val : null;
              // Clamp to 100%: "Doors" counts UNIQUE addresses while the later
              // stages count knock rows, so a re-knocked door can make
              // conversations > doors and yield a nonsensical >100% readout.
              const conv = (prev && prev > 0) ? Math.min(100, Math.round(s.val / prev * 100)) : null;
              return `<div class="d2d-funnel-row">
                <div class="d2d-funnel-icon">${s.icon}</div>
                <div class="d2d-funnel-track">
                  <div class="d2d-funnel-fill" style="width:${w}%;background:${s.color};"></div>
                  <span class="d2d-funnel-name">${s.label}</span>
                  <span class="d2d-funnel-val">${s.val}</span>
                </div>
                <div class="d2d-funnel-conv">${conv !== null ? conv + '%' : ''}</div>
              </div>`;
            }).join('')}
          </div>
        </div>

        <!-- Disposition Breakdown — slim proportional bar + scannable count chips -->
        <div class="d2d-block">
          <div class="d2d-block-title">
            Disposition Breakdown
            ${filterDispo ? `<button class="d2d-clear-filter" data-d2d-action="setDispoFilter" data-d2d-id="">✕ Clear filter</button>` : ''}
          </div>
          <div class="d2d-dispo-bar">
            ${DISPO_ORDER.filter(k => breakdown[k] > 0).map(key => {
              const d = DISPOSITIONS[key];
              const pct = filtered.length > 0 ? (breakdown[key] / filtered.length * 100) : 0;
              return `<div class="d2d-dispo-seg${filterDispo && filterDispo !== key ? ' dim' : ''}" style="flex:${pct};background:${d.color};" data-d2d-action="setDispoFilter" data-d2d-id="${filterDispo === key ? '' : key}" title="${d.label}: ${breakdown[key]}"></div>`;
            }).join('')}
          </div>
          <div class="d2d-dispo-chips">
            ${DISPO_ORDER.filter(k => breakdown[k] > 0).map(key => {
              const d = DISPOSITIONS[key];
              const active = filterDispo === key;
              return `<button class="d2d-dispo-chip${active ? ' active' : ''}" style="--dc:${d.color};" data-d2d-action="setDispoFilter" data-d2d-id="${active ? '' : key}" title="${d.label}">
                <span class="d2d-chip-dot"></span>
                <span class="d2d-chip-lbl">${d.short}</span>
                <span class="d2d-chip-count">${breakdown[key]}</span>
              </button>`;
            }).join('')}
          </div>
        </div>

        <!-- Filters -->
        <div class="d2d-feed-header">
          <div class="d2d-date-pills">
            ${['today', 'week', 'month', 'all'].map(range => `
              <button class="d2d-pill ${filterDateRange === range ? 'active' : ''}" data-d2d-action="setDateFilter" data-d2d-id="${range}">
                ${range === 'today' ? 'Today' : range === 'week' ? 'Week' : range === 'month' ? 'Month' : 'All'}
              </button>
            `).join('')}
          </div>
          <select class="d2d-select" data-on-change="d2dSetDispoFilter">
            <option value="">All Dispositions</option>
            ${DISPO_ORDER.map(key => `<option value="${key}" ${filterDispo === key ? 'selected' : ''}>${DISPOSITIONS[key].label}</option>`).join('')}
          </select>
        </div>

        <!-- Knock Feed -->
        <div class="d2d-knock-feed">
          ${filtered.length === 0 ? `
            <div class="nbd-empty">
              <div class="ne-icon">📍</div>
              <div class="ne-msg">No knocks yet for this filter</div>
              <div class="ne-sub">Tap the map or press "Knock" to start</div>
            </div>
          ` : filtered.slice(0, PAGE_SIZE).map(knock => {
            const dispo = DISPOSITIONS[knock.disposition];
            const attempts = state.getAttemptCount(knock.address);
            return `
              <div class="d2d-knock-card" data-d2d-action="openKnockDetail" data-d2d-id="${knock.id}">
                <div class="d2d-knock-body">
                  <div>
                    <div class="d2d-knock-addr">${esc(knock.address)}</div>
                    <div class="d2d-knock-meta">
                      <span>${formatTime(knock.createdAt)}</span>
                      <span class="d2d-knock-attempt ${dispo?.color === '#BD5728' ? 'warning' : ''}" style="background:${dispo?.color || '#ccc'};">Knock #${attempts}/${MAX_ATTEMPTS}</span>
                      ${knock.insCarrier ? `<span>🏢 ${esc(knock.insCarrier)}</span>` : ''}
                    </div>
                  </div>
                  <div class="dk-row6">
                    ${knock.photoUrls?.length ? '<span class="dk-fs12">📷</span>' : ''}
                    ${knock.voiceUrl ? '<span class="dk-fs12">🎙️</span>' : ''}
                    <span class="dk-fs20">${dispo?.icon || ''}</span>
                    <div class="dk-right">
                      <div class="dk-label">${dispo?.label || ''}</div>
                      <div class="d2d-knock-time">${timeAgo(knock.createdAt)}</div>
                    </div>
                  </div>
                </div>
                ${knock.notes ? `<div class="dk-foot">${esc(knock.notes.substring(0, 80))}</div>` : ''}
                ${!knock.convertedToLead && HOT_DISPOSITIONS.includes(knock.disposition) ? `
                  <div class="dk-actions" data-d2d-stop-self="1">
                    <button class="btn btn-green btn-sm dk-btn-grow" data-d2d-action="convertToLead" data-d2d-id="${knock.id}" data-d2d-stop="1">✅ Convert to Lead</button>
                    <button class="btn btn-ghost btn-sm" data-d2d-action="convertToLeadWithEdit" data-d2d-id="${knock.id}" data-d2d-stop="1">✏️</button>
                  </div>
                ` : ''}
                ${knock.convertedToLead ? `<div class="dk-ok-note">✓ In CRM Pipeline</div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    // ─── ROUTES TAB ───
    if (currentTab === 'routes') {
      const route = state.walkingRoute || [];
      const streets = Object.entries(state.streetSequences).filter(([st, doors]) => doors.length >= 2).sort((a, b) => b[1].length - a[1].length).slice(0, 10);
      const gh = timeOfDay.bestWindow;
      const fmtHr = (h) => (h % 12 || 12) + (h < 12 ? 'am' : 'pm');

      html += `
        <div class="d2d-routes-section">
          ${gh && gh.conversions > 0 ? `<div class="d2d-golden-hours dk-mb12">🕐 Best time to knock: <strong>${fmtHr(gh.start)}–${fmtHr(gh.end)}</strong> — your warmest window</div>` : ''}
          <div class="d2d-route-actions">
            <button class="d2d-action-btn dk-grow dk-bg-blue" data-d2d-action="calcRoute">🗺️ Calculate Walking Route</button>
            ${route.length > 0 ? `<button class="d2d-action-btn dk-bg-green" data-d2d-action="navRoute" title="Open turn-by-turn in your map app">🧭 Navigate</button>` : ''}
            ${route.length > 0 ? `<button class="d2d-action-btn dk-bg-plain" data-d2d-action="clearRoute">Clear</button>` : ''}
          </div>
          ${route.length > 0 ? `
            <div class="d2d-section-title">Optimized Route (${route.length} stops)</div>
            ${route._stats && route._stats.totalMiles > 0 ? `
              <div class="dk-grid3">
                <div class="d2d-metric-card">
                  <div class="d2d-metric-val">${route._stats.stopCount}</div>
                  <div class="d2d-metric-lbl">Stops</div>
                </div>
                <div class="d2d-metric-card">
                  <div class="d2d-metric-val">${route._stats.totalMiles.toFixed(2)} mi</div>
                  <div class="d2d-metric-lbl">Distance</div>
                </div>
                <div class="d2d-metric-card">
                  <div class="d2d-metric-val">${Math.round(route._stats.walkMinutes)} min</div>
                  <div class="d2d-metric-lbl">Walk Time</div>
                </div>
              </div>
            ` : ''}
            <div class="d2d-route-list">
              ${route.map((p, i) => `
                <div class="d2d-route-stop" data-d2d-action="openQuickKnock" data-d2d-args='{"address":"${esc(p.address)}","lat":${p.lat},"lng":${p.lng}}'>
                  <div class="d2d-route-num">${i + 1}</div>
                  <div class="d2d-route-addr">${esc(p.address)}</div>
                  <span class="d2d-route-icon" style="color:${DISPOSITIONS[p.disposition]?.color || 'var(--m)'};">${DISPOSITIONS[p.disposition]?.icon || ''}</span>
                </div>
              `).join('')}
            </div>
          ` : `<div class="nbd-empty dk-empty-sm"><div class="ne-sub">Hit "Calculate" to find the best route through your unvisited doors (Not Home / Come Back)</div></div>`}
        </div>

        <div class="d2d-streets-section">
          <div class="d2d-section-title">🏘️ Street Sequences</div>
          ${streets.length === 0 ? '<div class="nbd-empty dk-empty-sm"><div class="ne-sub">No streets with enough data yet</div></div>' : streets.map(([street, doors]) => {
            const knocked = doors.filter(d => d.knocked).length;
            const total = doors.length;
            const pct = Math.round(knocked / total * 100);
            return `
              <div class="d2d-street-card">
                <div class="d2d-street-header">
                  <div class="d2d-street-name">${esc(street)}</div>
                  <div class="d2d-street-stat">${knocked}/${total} (${pct}%)</div>
                </div>
                <div class="d2d-street-doors">
                  ${doors.slice(0, 30).map(d => {
                    const col = d.knocked ? (DISPOSITIONS[d.disposition]?.color || '#6B7280') : 'var(--br)';
                    return `<div class="d2d-door-chip" style="background:${col};" title="${esc(d.address).replace(/"/g, '&quot;')}" ${d.knockId ? `data-d2d-action="openKnockDetail" data-d2d-id="${d.knockId}"` : `data-d2d-action="openQuickKnock" data-d2d-args='{"address":"${esc(d.address)}"}'` }>${d.houseNum || ''}</div>`;
                  }).join('')}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    // ─── GAMIFY TAB ───
    if (currentTab === 'gamify') {
      html += `
        <!-- Streak -->
        <div class="d2d-streak-hero">
          <div class="d2d-streak-badge">${gamify.currentMilestone?.badge || '🔥'}</div>
          <div class="d2d-streak-days">${gamify.streak} Day Streak</div>
          <div class="d2d-streak-sub">${gamify.currentMilestone?.label || 'Start your streak!'}</div>
          ${gamify.nextMilestone ? `<div class="d2d-streak-next">Next: ${gamify.nextMilestone.badge} ${gamify.nextMilestone.label} (${gamify.nextMilestone.days - gamify.streak} days)</div>` : ''}
        </div>

        <!-- Daily Challenges -->
        <div class="d2d-section-title">Daily Challenges (${gamify.completedChallenges}/${gamify.totalChallenges})</div>
        <div class="d2d-challenges">
          ${gamify.challenges.map(ch => `
            <div class="d2d-challenge-card ${ch.complete ? 'd2d-challenge-done' : ''}">
              <div class="d2d-challenge-header">
                <div class="d2d-challenge-label">${ch.icon} ${ch.label}</div>
                <div class="d2d-challenge-progress" style="color:${ch.complete ? 'var(--green)' : 'var(--m)'};">${ch.current}/${ch.target} ${ch.complete ? '✓' : ''}</div>
              </div>
              <div class="d2d-progress-track">
                <div class="d2d-progress-fill" style="width:${ch.pct}%;background:${ch.complete ? 'var(--green, #2ECC8A)' : 'var(--blue, #4A9EFF)'};"></div>
              </div>
            </div>
          `).join('')}
        </div>

        <!-- Commission Projection -->
        <div class="d2d-projection-card">
          <div class="d2d-section-title">💰 Monthly Projection</div>
          <div class="d2d-projection-grid">
            <div class="d2d-metric-card">
              <div class="d2d-metric-val dk-c-blue">${gamify.projectedKnocks}</div>
              <div class="d2d-metric-lbl">Proj. Knocks</div>
            </div>
            <div class="d2d-metric-card">
              <div class="d2d-metric-val dk-c-green">${gamify.projectedAppts}</div>
              <div class="d2d-metric-lbl">Proj. Appts</div>
            </div>
            <div class="d2d-metric-card">
              <div class="d2d-metric-val dk-c-orange">$${gamify.projectedRevenue.toLocaleString()}</div>
              <div class="d2d-metric-lbl">Proj. Revenue</div>
            </div>
          </div>
        </div>
      `;
    }

    // ─── ANALYTICS TAB ───
    if (currentTab === 'analytics') {
      const tod = timeOfDay;
      const maxHour = Math.max(...tod.hourCounts, 1);

      // Address data quality — verified vs. needs-review, with a re-verify queue.
      const aq = state.getAddressQuality();
      const aqPct = aq.totalDoors > 0 ? Math.round(aq.verified / aq.totalDoors * 100) : 0;
      const CONF_META = {
        verified:   { c: 'var(--green)', t: '🟢 Verified' },
        likely:     { c: 'var(--gold)',  t: '🟡 Confirm' },
        conflict:   { c: 'var(--orange)', t: '🟠 Mismatch' },
        unverified: { c: 'var(--red)',   t: '🔴 Unverified' }
      };
      html += `
        <!-- AI Sales Coach -->
        <div class="d2d-block">
          <div class="d2d-block-title">🧠 AI Sales Coach</div>
          <button class="d2d-action-btn dk-bg-purple dk-full" data-d2d-action="runCoach">🧠 Get today's game plan</button>
          <div id="d2d-coach-out" class="d2d-coach-out"></div>
        </div>

        <!-- Address Data Quality -->
        <div class="d2d-block">
          <div class="d2d-block-title">🔍 Address Data Quality</div>
          <div class="d2d-aq-card">
            <div class="d2d-aq-head">
              <div><span class="d2d-aq-big">${aqPct}%</span> <span class="d2d-aq-sub">${aq.verified}/${aq.totalDoors} doors verified</span></div>
              <div class="d2d-aq-actions">
                ${aq.needsReview > 0 ? `<button class="d2d-action-btn dk-bg-orange" data-d2d-action="reverifyPending">🔁 Re-verify ${Math.min(aq.needsReview, 25)}</button>` : '<span class="d2d-aq-clean">✓ All clear</span>'}
                ${(() => { const c = window._userClaims || {}; const admin = c.owner === true || c.role === 'admin' || c.role === 'company_admin' || window._role === 'admin'; return admin ? `<button class="d2d-action-btn dk-bg-purple" data-d2d-action="reverifyTeam" title="Re-verify the whole team's addresses (owner/admin)">🏢 Team</button>` : ''; })()}
              </div>
            </div>
            <div class="d2d-aq-bar"><div class="d2d-aq-fill" style="width:${aqPct}%;"></div></div>
            ${aq.needsReview > 0 ? `
              <div class="d2d-aq-sub dk-mt8">${aq.needsReview} address${aq.needsReview !== 1 ? 'es' : ''} need review${!state.isOnline ? ' · reconnect to re-verify' : ''}</div>
              <div class="d2d-aq-list">
                ${aq.reviewList.slice(0, 12).map(k => {
                  const m = CONF_META[k.addrConfidence] || { c: 'var(--m)', t: '⚪ Unchecked' };
                  return `<div class="d2d-aq-row">
                    <span class="d2d-aq-badge" style="color:${m.c};">${m.t}</span>
                    <span class="d2d-aq-addr" data-d2d-action="openKnockDetail" data-d2d-id="${esc(k.id)}">${esc(k.address)}</span>
                    <button class="d2d-aq-reverify" data-d2d-action="reverifyKnock" data-d2d-id="${esc(k.id)}" title="Re-verify this address">🔁</button>
                  </div>`;
                }).join('')}
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Golden Hours -->
        <div class="d2d-golden-hours">
          🕐 Golden Hours: <strong>${tod.bestWindow.start}:00 - ${tod.bestWindow.end}:00</strong> (${tod.bestWindow.conversions} conversions)
        </div>

        <!-- Time of Day Heatmap -->
        <div class="d2d-section-title">Hourly Activity (8am-9pm)</div>
        <div class="d2d-hourly-chart">
          ${Array.from({length: 14}, (_, i) => i + 8).map(hr => {
            const h = tod.hourCounts[hr] || 0;
            const c = tod.hourConversions[hr] || 0;
            const pct = h / maxHour * 100;
            return `<div class="d2d-hour-col" title="${hr}:00 — ${h} knocks, ${c} conversions">
              <div class="d2d-hour-bar" style="height:${pct}%;min-height:${h > 0 ? 2 : 0}px;">
                ${c > 0 ? `<div class="d2d-hour-conv" style="height:${h > 0 ? c/h*100 : 0}%;"></div>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>
        <div class="d2d-hour-labels">
          ${Array.from({length: 14}, (_, i) => `<div class="d2d-hour-lbl">${(i + 8) % 12 || 12}${i + 8 < 12 ? 'a' : 'p'}</div>`).join('')}
        </div>

        <!-- Insurance Metrics -->
        ${insMetrics.total > 0 ? `
          <div class="d2d-section-title">🏢 Insurance Breakdown (${insMetrics.total} total)</div>
          <div class="d2d-ins-list">
            ${Object.entries(insMetrics.carriers).sort((a, b) => b[1].total - a[1].total).slice(0, 8).map(([carrier, data]) => `
              <div class="d2d-ins-row">
                <span class="d2d-ins-name">${esc(carrier)}</span>
                <span class="d2d-ins-stats">${data.total} leads · ${data.hasClaim} claims · ${data.denied} denied</span>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <!-- Neighborhood Scores -->
        ${Object.keys(state.neighborhoodScores).length > 0 ? `
          <div class="d2d-section-title dk-mt14">🏘️ Top Neighborhoods</div>
          <div class="d2d-hood-list">
            ${Object.values(state.neighborhoodScores).sort((a, b) => b.score - a.score).slice(0, 5).map(n => {
              const col = n.score >= 70 ? 'var(--green)' : n.score >= 40 ? 'var(--gold)' : 'var(--red)';
              return `<div class="d2d-hood-row">
                <div class="d2d-hood-score" style="background:${col};">${n.score}</div>
                <div class="d2d-hood-info">
                  <div class="d2d-hood-primary">${n.knocks.length} knocks · ${n.appointments} apts</div>
                  <div class="d2d-hood-secondary">${n.conversations} conversations · ${n.stormDmg} storm dmg</div>
                </div>
              </div>`;
            }).join('')}
          </div>
        ` : ''}
      `;
    }

    html += '</div>';
    html += `<button class="d2d-fab" data-d2d-action="openQuickKnock" aria-label="Quick Knock">🚪</button>`;
    container.innerHTML = html;
  }

  // ============================================================================
  // EXPORT TO STATE OBJECT (shim composes these into window.D2D)
  // ============================================================================
  state.renderD2D = renderD2D;
  state.setTab = setTab;
  state.setDateFilter = setDateFilter;
  state.setDispoFilter = setDispoFilter;
  state.openQuickKnock = openQuickKnock;
  state.selectDispo = selectDispo;
  state.verifyKnockAddress = verifyKnockAddress;
  // Conflict resolver — rep picks which source's door number is right.
  state.pickAddrSource = function (args) {
    args = args || {};
    const input = document.getElementById('d2d-qk-address');
    if (input && args.address) input.value = args.address;
    const e = state.currentKnockEntry;
    if (e) {
      if (args.address) e.address = args.address;
      if (args.lat != null) e.lat = args.lat;
      if (args.lng != null) e.lng = args.lng;
    }
    // Re-verify the chosen address so the badge/confirm reflect the new pick.
    verifyKnockAddress();
  };
  state.closeQuickKnock = closeQuickKnock;
  state.handleSubmitKnock = handleSubmitKnock;
  state.showConversionPrompt = showConversionPrompt;
  state.openKnockDetail = openKnockDetail;
  state.closeKnockDetail = closeKnockDetail;
  state.openSMSTemplateChooser = openSMSTemplateChooser;
  state.exportKnocksCSV = exportKnocksCSV;
  state.capturePhoto = capturePhoto;
  state.startVoiceRecording = startVoiceRecording;
  state.stopVoiceRecording = stopVoiceRecording;

  // ============================================================================
  // CSP-SAFE EVENT DELEGATION
  // ============================================================================
  // Prod CSP `script-src-attr 'none'` blocks every inline onclick=, even when
  // injected via innerHTML. Instead, every UI element above carries
  // `data-d2d-action="methodName"` (plus optional `data-d2d-id`/`data-d2d-args`/
  // `data-d2d-stop`/`data-d2d-stop-self`). One document-level click listener
  // dispatches to window.D2D[action] — addEventListener is NOT blocked by CSP.

  // Helper wrappers for chained/composed actions that don't have a single
  // function counterpart on window.D2D.
  state.convertToLeadAndDismissPrompt = function (knockId) {
    if (window.D2D && window.D2D.convertToLead) window.D2D.convertToLead(knockId);
    const p = document.getElementById('d2d-convert-prompt');
    if (p) p.remove();
  };
  state.convertToLeadWithEditAndDismissPrompt = function (knockId) {
    if (window.D2D && window.D2D.convertToLeadWithEdit) window.D2D.convertToLeadWithEdit(knockId);
    const p = document.getElementById('d2d-convert-prompt');
    if (p) p.remove();
  };
  state.dismissConvertPrompt = function () {
    const p = document.getElementById('d2d-convert-prompt');
    if (p) p.remove();
  };
  state.dismissFollowupsBanner = function (target) {
    const banner = target && target.closest && target.closest('.d2d-followups-banner');
    if (banner) banner.style.display = 'none';
  };
  state.callPhone = function (phone) {
    if (phone) window.open('tel:' + encodeURIComponent(phone));
  };
  state.toggleHail = function () {
    if (window._d2dHailLayer) {
      if (window.D2D && window.D2D.hideHail) window.D2D.hideHail();
    } else {
      if (window.D2D && window.D2D.showHail) window.D2D.showHail({ radiusMi: 5, daysBack: 365 });
    }
  };
  state.openImage = function (url) { if (url) window.open(url, '_blank'); };

  // One delegated listener; attached at document scope so it catches clicks
  // inside any dynamically-appended modal/popover/list.
  if (!window._D2D_DELEGATE_BOUND) {
    window._D2D_DELEGATE_BOUND = true;
    document.addEventListener('click', function (ev) {
      const stopSelf = ev.target.closest && ev.target.closest('[data-d2d-stop-self="1"]');
      if (stopSelf && ev.target === stopSelf) ev.stopPropagation();
      const t = ev.target.closest && ev.target.closest('[data-d2d-action]');
      if (!t) return;
      if (t.dataset.d2dStop === '1') ev.stopPropagation();
      const action = t.dataset.d2dAction;
      const fn = window.D2D && window.D2D[action];
      if (typeof fn !== 'function') {
        console.warn('[d2d] no dispatch for', action);
        return;
      }
      try {
        if (t.dataset.d2dArgs) {
          fn(JSON.parse(t.dataset.d2dArgs));
        } else if (t.dataset.d2dId !== undefined) {
          fn(t.dataset.d2dId, t);
        } else {
          fn(t);
        }
      } catch (e) {
        console.error('[d2d] dispatch ' + action + ' failed:', e);
      }
    });
    // Broken-image fallback (was inline onerror= on <img>, also CSP-killed).
    document.addEventListener('error', function (ev) {
      const img = ev.target;
      if (!img || img.tagName !== 'IMG') return;
      if (img.dataset.d2dOnError !== 'brokenPhoto') return;
      const placeholder = Object.assign(document.createElement('div'), {
        className: 'd2d-photo-broken',
        textContent: '📷 Photo unavailable'
      });
      placeholder.style.cssText = 'background:var(--s2);border:1px dashed var(--br);color:var(--m);padding:16px 12px;border-radius:6px;font-size:11px;text-align:center;';
      if (img.parentNode) img.parentNode.replaceChild(placeholder, img);
    }, true); // capture phase to catch <img> error events
  }

})();
