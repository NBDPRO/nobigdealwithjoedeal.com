// ============================================================
// NBD Pro — ui.js
// Command Palette, Keyboard Shortcuts, Skeleton Screens,
// Toast Notifications, Settings/Nav UI, Navigation
// Extracted from dashboard.html for maintainability
// ============================================================

// COMMAND PALETTE (Cmd+K)
// ══════════════════════════════════════════════

let cmdSelectedIndex = 0;
let cmdCurrentResults = [];

// Open command palette
function openCmdPalette() {
  const palette = document.getElementById('cmdPalette');
  const input = document.getElementById('cmdInput');
  palette.style.display = 'flex';
  input.value = '';
  input.focus();
  cmdSelectedIndex = 0;
  renderCmdResults(getCmdActions());
  loadCmdRecents();
}

// Close command palette
function closeCmdPalette() {
  const palette = document.getElementById('cmdPalette');
  palette.style.display = 'none';
  cmdCurrentResults = [];
}

// Get quick actions
function getCmdActions() {
  return [
    { type: 'action', icon: '➕', title: 'New Lead', meta: 'Create a new customer lead', action: () => { closeCmdPalette(); openLeadModal(); } },
    { type: 'action', icon: '⚡', title: 'Quick Lead', meta: 'Fast 3-field add — for the field', action: () => { closeCmdPalette(); if (typeof window.openQuickAddLead === 'function') window.openQuickAddLead(); } },
    { type: 'action', icon: '📍', title: 'Lead Here (GPS)', meta: 'Create lead at my current location', action: () => { closeCmdPalette(); if (typeof window.openQuickAddLead === 'function') { window.openQuickAddLead(); setTimeout(() => { if (typeof window.qaUseMyLocation === 'function') window.qaUseMyLocation(); }, 200); } } },
    { type: 'action', icon: '📋', title: 'New Estimate', meta: 'Build a new estimate', action: () => { closeCmdPalette(); goTo('est'); if(typeof startNewEstimate==='function')startNewEstimate(); } },
    { type: 'action', icon: '📅', title: "Today's Schedule", meta: 'Appointments + travel times + priority', action: () => { closeCmdPalette(); goTo('schedule'); } },
    { type: 'action', icon: '👥', title: 'Pipeline', meta: 'Open the kanban board', action: () => { closeCmdPalette(); goTo('crm'); } },
    { type: 'action', icon: '👀', title: 'Prospects', meta: 'D2D knocks awaiting promotion', action: () => { closeCmdPalette(); goTo('prospects'); } },
    { type: 'action', icon: '🚪', title: 'Door-to-Door', meta: 'Knock tracker + map', action: () => { closeCmdPalette(); goTo('d2d'); } },
    { type: 'action', icon: '🗺️', title: 'Go to Map', meta: 'View leads on map', action: () => { closeCmdPalette(); goTo('map'); } },
    { type: 'action', icon: '📸', title: 'Go to Photos', meta: 'Manage project photos', action: () => { closeCmdPalette(); goTo('photos'); } },
    { type: 'action', icon: '📊', title: 'Go to Dashboard', meta: 'View overview stats', action: () => { closeCmdPalette(); goTo('dash'); } },
    { type: 'action', icon: '⚙️', title: 'Settings', meta: 'Manage account settings', action: () => { closeCmdPalette(); goTo('settings'); } },
    { type: 'action', icon: '💾', title: 'Export CSV', meta: 'Download leads as CSV', action: () => { closeCmdPalette(); if(typeof exportLeadsCSV==='function')exportLeadsCSV(); } },
    { type: 'action', icon: '🎨', title: 'Change Theme', meta: 'Customize appearance', action: () => { closeCmdPalette(); nbdPickerOpen(); } },
  ];
}

// Fuzzy search.
// The lead store is `window._leads` (set by crm.js loadLeads). The previous
// `window.allLeads` reference was always undefined → cmd-K lead search has
// silently returned zero hits since the cmd palette shipped. Lead records
// also don't have `.name` — they have firstName/lastName/address.
function cmdFuzzySearch(query) {
  const results = [];
  const q = query.toLowerCase();

  // Search actions
  getCmdActions().forEach(action => {
    if (action.title.toLowerCase().includes(q) || action.meta.toLowerCase().includes(q)) {
      results.push({ ...action, score: cmdScoreMatch(q, action.title.toLowerCase()) });
    }
  });

  // Search leads
  const leads = window._leads || [];
  if (leads.length > 0) {
    leads.forEach(lead => {
      const fullName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
      const display = fullName || lead.address || 'Untitled lead';
      const searchText = `${fullName} ${lead.address || ''} ${lead.phone || ''} ${lead.email || ''}`.toLowerCase();
      if (searchText.includes(q)) {
        results.push({
          type: 'lead',
          icon: lead.isProspect ? '👀' : '👤',
          title: display,
          meta: [lead.address, lead.phone].filter(Boolean).join(' · ') || (lead.isProspect ? 'Prospect' : 'Customer'),
          action: () => {
            closeCmdPalette();
            // openCardDetailModal takes a leadId, NOT a lead object —
            // previous code passed the object and the modal silently
            // failed to populate.
            if (typeof openCardDetailModal === 'function') openCardDetailModal(lead.id);
          },
          score: cmdScoreMatch(q, display.toLowerCase())
        });
      }
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 10);
}

// Score match quality
function cmdScoreMatch(query, text) {
  if (text === query) return 100;
  if (text.startsWith(query)) return 80;
  return 50;
}

// Load recent items
function loadCmdRecents() {
  const recents = JSON.parse(localStorage.getItem('cmd-recents') || '[]');
  if (recents.length === 0) return;
  
  cmdCurrentResults = [
    ...recents.slice(0, 5).map(r => ({ ...r, badge: 'Recent' })),
    ...cmdCurrentResults
  ];
  renderCmdResults(cmdCurrentResults);
}

// Save recent item
function saveCmdRecent(item) {
  const recents = JSON.parse(localStorage.getItem('cmd-recents') || '[]');
  const filtered = recents.filter(r => r.title !== item.title);
  filtered.unshift({ type: item.type, icon: item.icon, title: item.title, meta: item.meta });
  localStorage.setItem('cmd-recents', JSON.stringify(filtered.slice(0, 10)));
}

// Render results
function _cmdEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderCmdResults(results) {
  const container = document.getElementById('cmdResults');
  if (results.length === 0) {
    container.innerHTML = '<div class="cmd-empty"><div class="cmd-empty-icon">🔍</div><div class="cmd-empty-text">No results found</div></div>';
    return;
  }
  
  const grouped = {};
  results.forEach(r => {
    const group = r.type || 'other';
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(r);
  });
  
  let html = '';
  const groupLabels = { 'action': 'Actions', 'lead': 'Leads', 'estimate': 'Estimates' };
  
  Object.keys(grouped).forEach(group => {
    if (grouped[group].length === 0) return;
    if (groupLabels[group]) {
      html += `<div class="cmd-group"><div class="cmd-group-label">${groupLabels[group]}</div>`;
    }
    grouped[group].forEach((item, idx) => {
      const globalIdx = results.indexOf(item);
      const selected = globalIdx === cmdSelectedIndex ? 'selected' : '';
      // Every field is escaped: a lead's name/address/phone come from the
      // PUBLIC contact form (lead bridge), and saved recents replay them from
      // localStorage on every open (security audit 2026-09-29).
      html += `
        <div class="cmd-item ${selected}" data-ui-action="cmdExecuteItem" data-ui-id="${globalIdx}" data-ui-hover-idx="${globalIdx}">
          <div class="cmd-item-icon">${_cmdEsc(item.icon)}</div>
          <div class="cmd-item-content">
            <div class="cmd-item-title">${_cmdEsc(item.title)}</div>
            <div class="cmd-item-meta">${_cmdEsc(item.meta || '')}</div>
          </div>
          ${item.badge ? `<div class="cmd-item-badge">${_cmdEsc(item.badge)}</div>` : ''}
        </div>
      `;
    });
    if (groupLabels[group]) html += `</div>`;
  });
  
  container.innerHTML = html;
}

// Execute selected item
function cmdExecuteItem(index) {
  const item = cmdCurrentResults[index];
  if (!item || !item.action) return;
  saveCmdRecent(item);
  item.action();
}

// Handle search input
function handleCmdSearch(query) {
  if (!query.trim()) {
    cmdCurrentResults = getCmdActions();
    cmdSelectedIndex = 0;
    renderCmdResults(cmdCurrentResults);
    loadCmdRecents();
    return;
  }
  
  cmdCurrentResults = cmdFuzzySearch(query);
  cmdSelectedIndex = 0;
  renderCmdResults(cmdCurrentResults);
}

// Keyboard navigation
function cmdSelectNext() {
  if (cmdCurrentResults.length === 0) return;
  cmdSelectedIndex = (cmdSelectedIndex + 1) % cmdCurrentResults.length;
  renderCmdResults(cmdCurrentResults);
}

function cmdSelectPrev() {
  if (cmdCurrentResults.length === 0) return;
  cmdSelectedIndex = (cmdSelectedIndex - 1 + cmdCurrentResults.length) % cmdCurrentResults.length;
  renderCmdResults(cmdCurrentResults);
}

// Global keyboard listener
document.addEventListener('keydown', (e) => {
  const palette = document.getElementById('cmdPalette');
  const isOpen = palette && palette.style.display === 'flex';
  
  // Cmd+K or Ctrl+K to open.
  // DUP-2 fix (2026-09-06): command-palette.js (window.NBDCommand) is the
  // canonical Cmd+K palette — global-search.js already stands down for it the
  // same way. This one did not, so on dashboard.html (which loads all three)
  // a single Cmd+K opened BOTH this #cmdPalette and NBDCommand's modal,
  // stacked. Checked per-event so load order is moot; if NBDCommand is
  // somehow absent this palette still works as the fallback.
  if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !window.NBDCommand) {
    e.preventDefault();
    if (!isOpen) openCmdPalette();
  }
  
  // Escape to close
  if (e.key === 'Escape' && isOpen) {
    closeCmdPalette();
  }
  
  // Arrow navigation when open
  if (isOpen) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdSelectNext();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdSelectPrev();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      cmdExecuteItem(cmdSelectedIndex);
    }
  }
});

// Add input listener
window.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('cmdInput');
  if (input) {
    input.addEventListener('input', (e) => handleCmdSearch(e.target.value));
  }
  // Phase 1 Step 1: voice input on the cmd palette. Wire the mic
  // button. Uses MediaRecorder → base64 → existing dictate callable
  // (Deepgram transcribe + Claude cleanup), then drops the cleaned
  // text into the input and triggers the same search path as typing.
  const micBtn = document.getElementById('cmdMicBtn');
  if (micBtn) {
    micBtn.addEventListener('click', cmdToggleVoice);
  }
});

// ═══════════════════════════════════════════════
// VOICE INPUT (Phase 1, Step 1)
// ═══════════════════════════════════════════════
let _cmdMediaRecorder = null;
let _cmdAudioChunks = [];
let _cmdRecordStream = null;
// Auto-stop after this many ms of recording — Whisper / Deepgram both
// price by audio second, and a runaway recorder would burn cost. 30s
// is longer than any real command someone speaks at the palette.
const CMD_MAX_RECORD_MS = 30_000;
let _cmdAutoStopTimer = null;

async function cmdToggleVoice() {
  const btn = document.getElementById('cmdMicBtn');
  if (!btn) return;
  const state = btn.dataset.state || 'idle';
  if (state === 'recording') {
    // Stop the recorder; transcription kicks in via mediaRecorder.onstop.
    _cmdStopRecording();
    return;
  }
  if (state === 'transcribing') {
    // No-op; let the in-flight transcription finish.
    return;
  }
  await _cmdStartRecording();
}

async function _cmdStartRecording() {
  const btn = document.getElementById('cmdMicBtn');
  const input = document.getElementById('cmdInput');
  if (!btn || !input) return;
  // MediaRecorder availability check — desktop Safari < 14.1 + some
  // older Android lack it. Surface a clear error rather than failing
  // mysteriously.
  if (typeof navigator === 'undefined' || !navigator.mediaDevices
      || typeof MediaRecorder === 'undefined') {
    if (typeof showToast === 'function') showToast('Voice input not supported in this browser', 'error');
    return;
  }
  try {
    _cmdRecordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    // NotAllowedError, NotFoundError, etc. — most often "user said no".
    if (typeof showToast === 'function') showToast('Mic access denied — enable in browser settings', 'error');
    return;
  }
  _cmdAudioChunks = [];
  const mimeType = _cmdPickAudioMime();
  try {
    _cmdMediaRecorder = mimeType
      ? new MediaRecorder(_cmdRecordStream, { mimeType })
      : new MediaRecorder(_cmdRecordStream);
  } catch (e) {
    if (typeof showToast === 'function') showToast('Voice recorder failed to start: ' + e.message, 'error');
    _cmdReleaseStream();
    return;
  }
  _cmdMediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) _cmdAudioChunks.push(e.data);
  });
  _cmdMediaRecorder.addEventListener('stop', () => _cmdHandleRecordingStop(mimeType));
  _cmdMediaRecorder.start();
  btn.dataset.state = 'recording';
  btn.setAttribute('aria-label', 'Stop recording');
  input.placeholder = 'Listening… (click mic to stop)';
  // Hard cap on record duration.
  clearTimeout(_cmdAutoStopTimer);
  _cmdAutoStopTimer = setTimeout(_cmdStopRecording, CMD_MAX_RECORD_MS);
}

function _cmdStopRecording() {
  clearTimeout(_cmdAutoStopTimer);
  _cmdAutoStopTimer = null;
  try {
    if (_cmdMediaRecorder && _cmdMediaRecorder.state !== 'inactive') {
      _cmdMediaRecorder.stop();
    }
  } catch (_) {}
}

function _cmdReleaseStream() {
  if (_cmdRecordStream) {
    try { _cmdRecordStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    _cmdRecordStream = null;
  }
}

// Pick the best supported audio MIME. webm/opus is the desktop default;
// Safari handles audio/mp4 better. Returns '' to let the browser default
// kick in if neither is supported (rare).
function _cmdPickAudioMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

async function _cmdHandleRecordingStop(mimeType) {
  _cmdReleaseStream();
  const btn = document.getElementById('cmdMicBtn');
  const input = document.getElementById('cmdInput');
  if (!btn || !input) return;
  if (_cmdAudioChunks.length === 0) {
    btn.dataset.state = 'idle';
    btn.setAttribute('aria-label', 'Dictate a command (voice input)');
    input.placeholder = 'Search or jump to...';
    return;
  }
  btn.dataset.state = 'transcribing';
  btn.setAttribute('aria-label', 'Transcribing…');
  input.placeholder = 'Transcribing…';

  // Build base64. Browsers don't have a one-liner; chunk-encode via
  // FileReader to avoid the call-stack overflow that a naive
  // String.fromCharCode(...new Uint8Array(buf)) hits on big buffers.
  let audioBase64 = '';
  try {
    const blob = new Blob(_cmdAudioChunks, { type: mimeType || 'audio/webm' });
    audioBase64 = await _cmdBlobToBase64(blob);
  } catch (e) {
    _cmdResetMic('Could not encode audio: ' + (e.message || ''));
    return;
  }

  // Lazy-load the Firebase Functions SDK if it isn't already on window.
  let callDictate;
  try {
    if (window._functions && window._httpsCallable) {
      callDictate = window._httpsCallable(window._functions, 'dictate');
    } else {
      const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
      window._functions = window._functions || mod.getFunctions();
      window._httpsCallable = window._httpsCallable || mod.httpsCallable;
      callDictate = window._httpsCallable(window._functions, 'dictate');
    }
  } catch (e) {
    _cmdResetMic('Voice service unavailable');
    return;
  }

  try {
    const res = await callDictate({
      audioBase64,
      mimeType: mimeType || 'audio/webm',
      mode: 'clean',
    });
    const text = (res && res.data && (res.data.cleaned || res.data.transcript)) || '';
    if (!text) {
      _cmdResetMic('Didn\'t catch that — try again');
      return;
    }
    // Drop the transcription into the input and trigger the existing
    // search handler. The 'input' event mirrors what the rep would see
    // if they typed it themselves.
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    _cmdResetMic();
  } catch (e) {
    const msg = (e && e.message) || 'Transcription failed';
    _cmdResetMic(msg.includes('Rate limit') ? 'Voice rate limit — wait a moment' : 'Voice transcription failed');
  }
}

function _cmdResetMic(errorMsg) {
  const btn = document.getElementById('cmdMicBtn');
  const input = document.getElementById('cmdInput');
  if (btn) {
    btn.dataset.state = 'idle';
    btn.setAttribute('aria-label', 'Dictate a command (voice input)');
  }
  if (input) input.placeholder = 'Search or jump to...';
  if (errorMsg && typeof showToast === 'function') showToast(errorMsg, 'error');
}

function _cmdBlobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result || '';
      // result is a data URL like "data:audio/webm;base64,XXXX"
      const idx = result.indexOf('base64,');
      if (idx < 0) { reject(new Error('Bad encoding')); return; }
      resolve(result.slice(idx + 7));
    };
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

// Expose functions to window
window.openCmdPalette = openCmdPalette;
window.closeCmdPalette = closeCmdPalette;
window.cmdToggleVoice = cmdToggleVoice;


// ══════════════════════════════════════════════
// KEYBOARD SHORTCUTS SYSTEM
// ══════════════════════════════════════════════

// Open/close shortcuts reference panel
function openShortcutsPanel() {
  const panel = document.getElementById('shortcutsPanel');
  panel.style.display = 'flex';
}

function closeShortcutsPanel() {
  const panel = document.getElementById('shortcutsPanel');
  panel.style.display = 'none';
}

function toggleShortcutsPanel() {
  const panel = document.getElementById('shortcutsPanel');
  if (panel.style.display === 'flex') {
    closeShortcutsPanel();
  } else {
    openShortcutsPanel();
  }
}

// Scroll to kanban column
function scrollToColumn(columnIndex) {
  const columns = ['new', 'contacted', 'est-sent', 'negotiating', 'approved', 'won', 'lost'];
  if (columnIndex < 1 || columnIndex > columns.length) return;
  
  const columnId = 'col-' + columns[columnIndex - 1];
  const column = document.getElementById(columnId);
  
  if (column) {
    column.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    // Flash highlight
    column.style.transition = 'background 0.3s';
    const originalBg = column.style.background;
    column.style.background = 'color-mix(in srgb, var(--orange) 10%, transparent)';
    setTimeout(() => {
      column.style.background = originalBg;
    }, 600);
  }
}

// Check if we should ignore keyboard shortcuts (typing in input)
function shouldIgnoreShortcut() {
  const activeEl = document.activeElement;
  if (!activeEl) return false;
  
  const tagName = activeEl.tagName.toLowerCase();
  return (
    tagName === 'input' || 
    tagName === 'textarea' || 
    activeEl.contentEditable === 'true' ||
    activeEl.isContentEditable
  );
}

// Global keyboard shortcuts handler
document.addEventListener('keydown', (e) => {
  const cmdPalette = document.getElementById('cmdPalette');
  const shortcutsPanel = document.getElementById('shortcutsPanel');
  const isCmdPaletteOpen = cmdPalette && cmdPalette.style.display === 'flex';
  const isShortcutsPanelOpen = shortcutsPanel && shortcutsPanel.style.display === 'flex';
  
  // ? key - Toggle shortcuts panel (works anytime, even in modals)
  if (e.key === '?' && !shouldIgnoreShortcut()) {
    e.preventDefault();
    toggleShortcutsPanel();
    return;
  }
  
  // Esc key - Close any open modals
  if (e.key === 'Escape') {
    if (isShortcutsPanelOpen) {
      closeShortcutsPanel();
      return;
    }
    // Command palette Esc is handled in its own listener
  }
  
  // Don't process other shortcuts if typing in input or if modal is open
  if (shouldIgnoreShortcut() || isCmdPaletteOpen || isShortcutsPanelOpen) {
    return;
  }
  
  // C - New Lead
  if (e.key === 'c' || e.key === 'C') {
    e.preventDefault();
    if (typeof openLeadModal === 'function') {
      openLeadModal();
    }
    return;
  }
  
  // E - New Estimate
  if (e.key === 'e' || e.key === 'E') {
    e.preventDefault();
    goTo('est');
    if (typeof startNewEstimate === 'function') {
      setTimeout(() => startNewEstimate(), 100);
    }
    return;
  }
  
  // / - Focus search bar (if exists)
  if (e.key === '/') {
    e.preventDefault();
    const searchBar = document.querySelector('input[type="search"], input[placeholder*="Search"]');
    if (searchBar) {
      searchBar.focus();
      searchBar.select();
    }
    return;
  }
  
  // 1-7 - Jump to kanban columns
  if (e.key >= '1' && e.key <= '7') {
    e.preventDefault();
    const columnNum = parseInt(e.key);
    scrollToColumn(columnNum);
    return;
  }
});

// Expose functions
window.openShortcutsPanel = openShortcutsPanel;
window.closeShortcutsPanel = closeShortcutsPanel;
window.toggleShortcutsPanel = toggleShortcutsPanel;


// ══════════════════════════════════════════════
// SKELETON SCREENS (Loading States)
// ══════════════════════════════════════════════

// Show skeleton loading state in kanban
function showKanbanSkeleton() {
  // W159: previously hardcoded the legacy capitalized labels
  // ('New','Inspected',...). After the W?? stage-key migration the
  // DOM became `kbody-{lowercase_key}` (e.g. `kbody-new`,
  // `kbody-contacted`, `kbody-prospect`). Every getElementById here
  // returned null and the skeleton never showed — leaving the user
  // on a blank kanban during loadLeads. Use the current view's
  // stage keys (set by buildKanbanColumns), falling back to the
  // legacy labels only if the new system isn't initialised yet.
  const stages = (Array.isArray(window._stageKeys) && window._stageKeys.length)
    ? window._stageKeys
    // Fallback to the new VIEW_SIMPLE stage keys (snake_case) used
    // by buildKanbanColumns when no view-specific keys are exposed
    // yet. The legacy capitalized labels were dead since the
    // crm-stages migration — kbody-{StageKey} IDs are lowercase.
    : ['new', 'inspected', 'estimate_submitted', 'contract_signed', 'install_in_progress', 'closed', 'lost'];

  stages.forEach(stage => {
    const body = document.getElementById('kbody-' + stage);
    if (!body) return;
    
    // Create 3 skeleton cards per column
    const skeletonHTML = `
      <div class="k-card-skeleton">
        <div class="skeleton k-card-skeleton-header"></div>
        <div class="skeleton k-card-skeleton-line"></div>
        <div class="skeleton k-card-skeleton-line"></div>
        <div class="skeleton k-card-skeleton-line"></div>
        <div class="k-card-skeleton-footer">
          <div class="skeleton k-card-skeleton-tag"></div>
          <div class="skeleton k-card-skeleton-tag"></div>
        </div>
      </div>
      <div class="k-card-skeleton">
        <div class="skeleton k-card-skeleton-header"></div>
        <div class="skeleton k-card-skeleton-line"></div>
        <div class="skeleton k-card-skeleton-line"></div>
        <div class="skeleton k-card-skeleton-line"></div>
        <div class="k-card-skeleton-footer">
          <div class="skeleton k-card-skeleton-tag"></div>
          <div class="skeleton k-card-skeleton-tag"></div>
        </div>
      </div>
      <div class="k-card-skeleton">
        <div class="skeleton k-card-skeleton-header"></div>
        <div class="skeleton k-card-skeleton-line"></div>
        <div class="skeleton k-card-skeleton-line"></div>
        <div class="skeleton k-card-skeleton-line"></div>
        <div class="k-card-skeleton-footer">
          <div class="skeleton k-card-skeleton-tag"></div>
          <div class="skeleton k-card-skeleton-tag"></div>
        </div>
      </div>
    `;
    
    body.innerHTML = skeletonHTML;
  });
}

// Show skeleton loading state for photos grid
function showPhotosSkeleton() {
  const photosContainer = document.getElementById('photoLeadsList');
  if (!photosContainer) return;
  
  const skeletonHTML = `
    <div class="photo-skeleton-grid">
      ${Array(12).fill(0).map(() => `
        <div class="skeleton photo-skeleton-item"></div>
      `).join('')}
    </div>
  `;
  
  photosContainer.innerHTML = skeletonHTML;
}

// Expose functions
window.showKanbanSkeleton = showKanbanSkeleton;
window.showPhotosSkeleton = showPhotosSkeleton;


// ══════════════════════════════════════════════
// TOAST NOTIFICATION SYSTEM (for optimistic updates)
// ══════════════════════════════════════════════

let toastIdCounter = 0;
const activeToasts = new Map();

// Show toast notification with optional undo action
function showToast(msgOrOptions, typeArg) {
  // Support both signatures:
  // showToast('message', 'success')  — simple, used 80+ times
  // showToast({message, type, ...})  — fancy with undo/actions
  let options;
  if (typeof msgOrOptions === 'string') {
    options = { message: msgOrOptions, type: typeArg || 'info' };
  } else {
    options = msgOrOptions;
  }
  
  // Duration by type: errors stay longer so user can read them.
  // success: 4s, info: 5s, warning: 7s, error: 9s
  const TYPE_DURATIONS = { success: 4000, info: 5000, warning: 7000, error: 9000 };
  const {
    message,
    type = 'info',
    duration = TYPE_DURATIONS[options.type || typeArg || 'info'] || 5000,
    undoAction = null,
    undoText = 'Undo'
  } = options;
  
  const container = document.getElementById('toastContainer');
  if (!container) return;

  // Cap concurrent toasts. Bulk operations (move/delete on 50+ leads) can
  // call showToast hundreds of times; without a cap the toasts pile off
  // screen and 9-second error toasts stack into a wall the user can't read.
  // When over the cap, pop the oldest BEFORE adding the new one.
  const MAX_VISIBLE_TOASTS = 5;
  const existing = container.querySelectorAll('.toast');
  if (existing.length >= MAX_VISIBLE_TOASTS) {
    // Remove oldest (first child) so the most recent toast is always visible.
    const oldest = existing[0];
    if (oldest && typeof window._closeToast === 'function') {
      window._closeToast(oldest.id);
    } else if (oldest) {
      oldest.remove();
    }
  }

  const toastId = `toast-${toastIdCounter++}`;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.id = toastId;
  
  const icon = {
    'success': '✓',
    'error': '⚠️',
    'info': 'ℹ️',
    'warning': '⚠️'
  }[type] || 'ℹ️';
  
  let actionsHTML = '';
  if (undoAction) {
    actionsHTML = `
      <div class="toast-actions">
        <button class="toast-btn toast-btn-primary" data-ui-action="toastUndo" data-ui-id="${toastId}">
          ${undoText}
        </button>
      </div>
    `;
  }
  
  // SECURITY: render the message as TEXT, never HTML. showToast is called from
  // many sites with lead/customer/portal-sourced strings — e.g. a homeowner
  // portal callback note or rating comment relayed through a task-overdue
  // notification — so interpolating `message` into innerHTML was a stored-XSS
  // sink executing in the rep's authenticated same-origin session. No caller
  // passes intentional markup; mirrors the safe dashboard-ui.js showToast.
  toast.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-content">
      <div class="toast-message"></div>
      ${actionsHTML}
    </div>
    <button class="toast-close" data-ui-action="closeToast" data-ui-id="${toastId}">✕</button>
  `;
  const _msgEl = toast.querySelector('.toast-message');
  // Many callers prefix their own "✓ " / "⚠️ " — beside the type icon that
  // read "✓ ✓ Estimate duplicated". Drop a leading mark that repeats the icon.
  let _msgText = (message == null ? '' : String(message));
  if (type === 'success') _msgText = _msgText.replace(/^\s*[✓✔✅]️?\s*/, '');
  else if (type === 'error' || type === 'warning') _msgText = _msgText.replace(/^\s*⚠️?\s*/, '');
  if (_msgEl) _msgEl.textContent = _msgText;

  container.appendChild(toast);
  
  // Store undo action
  if (undoAction) {
    activeToasts.set(toastId, undoAction);
  }
  
  // Auto-remove after duration
  if (duration > 0) {
    setTimeout(() => closeToast(toastId), duration);
  }
  
  return toastId;
}

// Close specific toast
function closeToast(toastId) {
  const toast = document.getElementById(toastId);
  if (toast) {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(400px)';
    setTimeout(() => {
      toast.remove();
      activeToasts.delete(toastId);
    }, 300);
  }
}

// Execute undo action
function toastUndo(toastId) {
  const undoAction = activeToasts.get(toastId);
  if (undoAction && typeof undoAction === 'function') {
    undoAction();
  }
  closeToast(toastId);
}

// Expose functions
window.showToast = showToast;
window._closeToast = closeToast;
window._toastUndo = toastUndo;


// COLLAPSIBLE NAV SECTIONS
function toggleNavSection(section) {
  const content = document.getElementById('section-'+section);
  const toggle = document.getElementById('toggle-'+section);
  const isOpen = content.classList.contains('open');
  
  if(isOpen) {
    content.classList.remove('open');
    toggle.classList.remove('open');
  } else {
    content.classList.add('open');
    toggle.classList.add('open');
  }
  
  // Save state to localStorage
  localStorage.setItem('nav-'+section, isOpen ? 'closed' : 'open');
}

// SETTINGS PAGE COLLAPSIBLE SECTIONS
function switchSettingsTab(tab) {
  // Hide all panels
  document.querySelectorAll('.stab-panel').forEach(p => p.style.display = 'none');
  // Deactivate all tab buttons
  document.querySelectorAll('.stab-btn').forEach(b => b.classList.remove('stab-active'));
  // Show selected panel
  const panel = document.getElementById('stab-panel-' + tab);
  if (panel) panel.style.display = 'block';
  // Activate selected tab button
  const btn = document.getElementById('stab-' + tab);
  if (btn) btn.classList.add('stab-active');

  // Lazy-load appearance tab content — render theme/font grids
  if (tab === 'appearance') {
    // Render the font picker grid + repaint size buttons. Both are
    // inside the lazy-hydrated settings template, so the boot-time
    // DOMContentLoaded callback ran while these elements were still
    // stuck inside <template>. Calling them here is idempotent.
    if (typeof window.nbdRenderFontGrid === 'function') window.nbdRenderFontGrid();
    // nbdSyncSizeBtns lives in __NBD_CALL_REGISTRY (dashboard-ui-prefs-
    // boot.js), not on window — Globals Tranche 3 T3-C, 2026-09-18.
    if (window.__NBD_CALL_REGISTRY && typeof window.__NBD_CALL_REGISTRY.nbdSyncSizeBtns === 'function') {
      window.__NBD_CALL_REGISTRY.nbdSyncSizeBtns();
    }
    if (typeof window.nbdSyncModeToggle === 'function') window.nbdSyncModeToggle();
    // Shape & Depth segmented control active-state — same lazy-hydration
    // hook as the three calls above; nbdSyncShapeStyleBtns lives in
    // __NBD_CALL_REGISTRY (dashboard-ui-prefs-boot.js), not on window.
    if (window.__NBD_CALL_REGISTRY && typeof window.__NBD_CALL_REGISTRY.nbdSyncShapeStyleBtns === 'function') {
      window.__NBD_CALL_REGISTRY.nbdSyncShapeStyleBtns();
    }
    // Material segmented control active-state — same lazy-hydration hook
    // as the calls above; nbdSyncMaterialBtns lives in
    // __NBD_CALL_REGISTRY (dashboard-ui-prefs-boot.js), not on window.
    if (window.__NBD_CALL_REGISTRY && typeof window.__NBD_CALL_REGISTRY.nbdSyncMaterialBtns === 'function') {
      window.__NBD_CALL_REGISTRY.nbdSyncMaterialBtns();
    }
    // Visual Overlays checkbox was hardcoded `checked` in markup with
    // nothing ever syncing it from the actual (now-persisted) state —
    // it would keep showing ON even after a saved OFF preference took
    // effect on boot.
    (function () {
      var t = document.getElementById('te-overlays-toggle');
      if (t && window.ThemeOverlays) t.checked = window.ThemeOverlays.isEnabled();
    })();
    // === ThemeEngine: filter buttons + flat grid ===
    const teGrid = document.getElementById('te-theme-grid');
    const teCatBar = document.getElementById('te-cat-bar');
    if (teGrid && teCatBar && !teGrid.dataset.loaded) {
      window._teActiveCat = 'all';
      window._teRenderSettingsGrid = function(cat) {
        window._teActiveCat = cat || 'all';
        const TE = window.ThemeEngine;
        const current = TE ? TE.getCurrent() : (document.documentElement.getAttribute('data-theme') || 'nbd-original');

        // Update active button state
        document.querySelectorAll('.te-filter-btn').forEach(b => {
          const isSel = b.dataset.cat === window._teActiveCat;
          b.style.background = isSel ? 'var(--orange)' : 'var(--s2)';
          b.style.color = isSel ? '#fff' : 'var(--m)';
        });

        if (!TE) {
          // Legacy: render from THEME_KEYS
          const keys = typeof THEME_KEYS !== 'undefined' ? THEME_KEYS : [];
          teGrid.innerHTML = keys.map(k => {
            const isAct = k === current;
            return `<div data-ui-action="applyTheme" data-ui-id="${k}" style="background:var(--s2);border:2px solid ${isAct?'var(--orange)':'var(--br)'};border-radius:8px;padding:8px;cursor:pointer;transition:all .15s;">
              <div style="font-size:10px;font-weight:700;color:var(--t);font-family:'Barlow Condensed',sans-serif;text-transform:capitalize;">${k.replace(/-/g,' ')}${isAct?' ✓':''}</div></div>`;
          }).join('');
          return;
        }

        // ThemeEngine: render themed cards
        const allThemes = TE.getAll();
        let entries = Object.entries(allThemes);
        if (cat && cat !== 'all') entries = entries.filter(([,t]) => t.category === cat);

        teGrid.innerHTML = entries.map(([key, t]) => {
          const isActive = key === current;
          const isLocked = t.locked && !(TE.isUnlocked && TE.isUnlocked(key));
          // Swatch palette must track the user's mode pref, not the theme's
          // native palette — otherwise a Light-mode user sees a dark Matrix
          // swatch but clicking it applies the light derivation.
          const resolved = (typeof TE.previewResolvedColors === 'function')
            ? TE.previewResolvedColors(key)
            : null;
          const bg = resolved?.bg || t.colors?.bg || '#12223D';
          const accent = resolved?.accent || t.colors?.accent || '#BD5728';
          const surface = resolved?.surface || t.colors?.surface || '#16213e';
          const txt = resolved?.text || t.colors?.text || '#e2e8f0';
          const muted = t.colors?.muted || '#6b7280';
          return `<div ${isLocked ? "" : `data-ui-action="previewTheme" data-ui-id="${key}"`} style="background:${bg};border:2px solid ${isActive ? accent : 'rgba(255,255,255,.06)'};border-radius:8px;padding:8px;cursor:${isLocked?'not-allowed':'pointer'};transition:all .15s;position:relative;opacity:${isLocked?'0.45':'1'};">
            <div style="display:flex;gap:3px;margin-bottom:4px;">
              <span style="width:10px;height:10px;border-radius:50%;background:${accent};"></span>
              <span style="width:10px;height:10px;border-radius:50%;background:${surface};"></span>
              ${t.colors?.accent2 ? `<span style="width:10px;height:10px;border-radius:50%;background:${t.colors.accent2};"></span>` : ''}
            </div>
            <div style="font-size:10px;font-weight:700;color:${txt};font-family:'Barlow Condensed',sans-serif;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${isLocked?'🔒 ':''}${t.name}</div>
            ${isActive ? `<div style="position:absolute;top:4px;right:4px;background:${accent};color:#fff;font-size:7px;font-weight:800;padding:1px 5px;border-radius:6px;">✓</div>` : ''}
            ${t.overlay?.type && t.overlay.type !== 'none' ? `<div style="position:absolute;bottom:3px;right:4px;font-size:7px;color:${muted};">✦</div>` : ''}
          </div>`;
        }).join('');
      };

      // Build filter buttons
      const TE = window.ThemeEngine;
      const btnStyle = 'padding:5px 10px;border-radius:14px;border:1px solid var(--br);font-size:10px;font-weight:700;cursor:pointer;font-family:\'Barlow Condensed\',sans-serif;letter-spacing:.04em;text-transform:uppercase;transition:all .15s;white-space:nowrap;';
      let btns = `<button class="te-filter-btn" data-cat="all" data-ui-action="renderSettingsGrid" data-ui-id="all" style="${btnStyle}background:var(--orange);color:#fff;">All</button>`;
      if (TE) {
        TE.getCategories().forEach(c => {
          btns += `<button class="te-filter-btn" data-cat="${c.key}" data-ui-action="renderSettingsGrid" data-ui-id="${c.key}" style="${btnStyle}background:var(--s2);color:var(--m);">${c.icon} ${c.label}</button>`;
        });
      }
      teCatBar.innerHTML = btns;

      // Initial render: show all
      window._teRenderSettingsGrid('all');
      teGrid.dataset.loaded = '1';

      // Init achievements + builder
      if (window.ThemeAchievements?.renderAchievementPanel) window.ThemeAchievements.renderAchievementPanel('te-achievements-panel');
      if (window.ThemeBuilder?.renderBuilder) window.ThemeBuilder.renderBuilder('te-builder-panel');
    }
    const fontGrid = document.getElementById('settings-font-grid');
    if (fontGrid && !fontGrid.dataset.loaded) {
      if (typeof NBD_FONTS !== 'undefined') {
        fontGrid.innerHTML = '';
        const _nbd_activeFont = window._nbd_activeFont || '';
        NBD_FONTS.forEach(f => {
          const isAct = f.id === _nbd_activeFont;
          const d = document.createElement('div');
          d.style.cssText = 'background:var(--s2);border:1px solid var(--br);border-radius:8px;padding:10px;cursor:pointer;transition:border-color .15s;' + (isAct ? 'border-color:var(--orange);' : '');
          d.onclick = () => { if (typeof nbdApplyFont === 'function') nbdApplyFont(f.id); };
          d.innerHTML = '<div style="font-family:' + f.css.fd + ';font-size:13px;font-weight:700;margin-bottom:4px;">' + f.name + (isAct ? ' ✓' : '') + '</div><div style="font-family:' + f.css.fb + ';font-size:11px;color:var(--m);">' + f.preview.b + '</div>';
          fontGrid.appendChild(d);
        });
        fontGrid.dataset.loaded = '1';
      } else if (typeof renderFontGrid === 'function') {
        renderFontGrid('settings-font-grid');
        fontGrid.dataset.loaded = '1';
      }
    }
  }
  // Re-init daily floors when switching to daily tab
  if (tab === 'daily') {
    if (typeof dsInitEditor === 'function') dsInitEditor();
    if (typeof dsLoadThemeGrid === 'function') dsLoadThemeGrid();
  }
  // Load v2 estimate settings when switching to estimates tab
  if (tab === 'estimates') {
    // PR 2c: EstimateBuilderV2 ships in the lazy 'estimates' bundle. Load it
    // before reading its settings + the product/xactimate counts, so the tab
    // shows real values (not zeros) and saves against the real config.
    // _loadEstimateDefaultsV2 lives in dashboard-bootstrap.module.js's
    // __NBD_CALL_REGISTRY (Globals Tranche 3 T3-C, 2026-09-18), not on
    // window. Resolved HERE, at call time, not via the _nbdReg below: that
    // var is hoisted but still undefined when the EstimateBuilderV2-already-
    // loaded branch runs this synchronously, which would silently no-op.
    var _runEstDefaults = function () {
      var _estReg = window.__NBD_CALL_REGISTRY;
      if (_estReg && typeof _estReg._loadEstimateDefaultsV2 === 'function') _estReg._loadEstimateDefaultsV2();
    };
    if (window.EstimateBuilderV2) { _runEstDefaults(); }
    else if (window.ScriptLoader && window.ScriptLoader.loadBundle) { window.ScriptLoader.loadBundle('estimates').then(_runEstDefaults); }
    else { _runEstDefaults(); }
  }
  // Lazy-load Company tab settings from localStorage + Firestore.
  // These six settings-tab loaders live in dashboard-bootstrap.module.js's
  // __NBD_CALL_REGISTRY (Globals Tranche 3, T3-C, 2026-09-17) rather than on
  // window directly — a real ES module, so nothing leaks there by default.
  var _nbdReg = window.__NBD_CALL_REGISTRY;
  if (tab === 'company') {
    if (_nbdReg && typeof _nbdReg._loadCompanySettings === 'function') {
      _nbdReg._loadCompanySettings();
    }
  }
  // Company Profile tab — pull from Firestore singleton + populate fields
  if (tab === 'company-profile') {
    if (_nbdReg && typeof _nbdReg._loadCompanyProfileSettings === 'function') {
      _nbdReg._loadCompanyProfileSettings();
    }
  }
  // Access tab — populate session info
  if (tab === 'access') {
    if (_nbdReg && typeof _nbdReg._loadAccessInfo === 'function') {
      _nbdReg._loadAccessInfo();
    }
  }
  // Billing tab — populate Ask Joe AI usage
  if (tab === 'billing') {
    if (_nbdReg && typeof _nbdReg._loadBillingInfo === 'function') {
      _nbdReg._loadBillingInfo();
    }
  }
  // Notifications tab — restore saved preferences
  if (tab === 'notifications') {
    if (_nbdReg && typeof _nbdReg._loadNotifSettings === 'function') {
      _nbdReg._loadNotifSettings();
    }
  }
  // Profile tab — repopulate fields from the saved user doc. The
  // boot-time priming in onAuthStateChanged ran while these inputs were
  // still inside the lazy-hydrated <template id="tpl-view-settings">,
  // so it no-oped; this runs after _hydrateViewTemplate has mounted the
  // template, so Display Name / Cal.com / the digest + dormant-nudge
  // checkboxes reflect what was actually saved (not the hardcoded
  // `checked` defaults in the markup).
  if (tab === 'profile') {
    // On a refresh straight onto #/settings this runs before the bootstrap
    // module has registered its loaders, so the call silently no-oped and the
    // saved Phone / review link / Cal.com showed blank — and the next Save
    // wrote those blanks over the real values. Retry until it exists.
    (function _runProfileLoad(tries) {
      var _nbdReg = window.__NBD_CALL_REGISTRY; // re-read each try (was undefined on the first)
      if (_nbdReg && typeof _nbdReg._loadProfileSettings === 'function') { _nbdReg._loadProfileSettings(); return; }
      if (tries < 60) setTimeout(function () { _runProfileLoad(tries + 1); }, 250);
    })(0);
    // The kanban density buttons + bold/auto-collapse checkboxes live in
    // this panel too; their boot-time DCL+200ms painter ran before the
    // template hydrated on any non-direct load, so the active state and
    // checkbox priming were lost until now (NEW-D45c).
    if (typeof window._syncKanbanPrefControls === 'function') {
      window._syncKanbanPrefControls();
    }
  }
}
window.switchSettingsTab = switchSettingsTab;

// Mode toggle (Light / Dark / Auto) — applies to every theme.
// Reads/writes ThemeEngine.setModePref; rerenders the active state on the
// segmented control so user sees the selection persist.
window.nbdSetModePref = function(pref) {
  const TE = window.ThemeEngine;
  if (!TE || typeof TE.setModePref !== 'function') return;
  TE.setModePref(pref);
  if (typeof window.nbdSyncModeToggle === 'function') window.nbdSyncModeToggle();
  // Re-render the theme grid so the swatches reflect the new mode's palette.
  if (typeof window._teRenderSettingsGrid === 'function') {
    window._teRenderSettingsGrid(window._teActiveCat || 'all');
  }
  if (typeof window.showToast === 'function') {
    const label = pref === 'auto' ? 'Auto (follows device)' : (pref === 'light' ? 'Light mode' : 'Dark mode');
    window.showToast('Display: ' + label);
  }
};

window.nbdSyncModeToggle = function() {
  const TE = window.ThemeEngine;
  const pref = (TE && typeof TE.getModePref === 'function') ? TE.getModePref() : 'auto';
  document.querySelectorAll('.te-mode-btn').forEach(btn => {
    const isSel = btn.getAttribute('data-mode-val') === pref;
    btn.style.background = isSel ? 'var(--orange)' : 'transparent';
    btn.style.color = isSel ? '#fff' : 'var(--m)';
  });
};

// Theme preview system — click previews, confirm bar to apply or revert
window._tePreviewTheme = function(key) {
  const TE = window.ThemeEngine;
  const prev = window._teOriginalTheme || (TE ? TE.getCurrent() : (document.documentElement.getAttribute('data-theme') || 'nbd-original'));
  if (!window._teOriginalTheme) window._teOriginalTheme = prev;

  // Apply preview without saving
  if (TE) { TE.apply(key, false); } else { applyTheme(key, false); }

  // Show confirm bar if not already showing
  if (!document.getElementById('te-confirm-bar')) {
    const bar = document.createElement('div');
    bar.id = 'te-confirm-bar';
    bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:9999;background:var(--s);border-top:2px solid var(--orange);padding:10px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);';
    bar.innerHTML = `
      <div style="font-size:13px;color:var(--t);font-family:'Barlow Condensed',sans-serif;font-weight:700;letter-spacing:.04em;">PREVIEWING THEME</div>
      <div style="display:flex;gap:8px;">
        <button data-ui-action="revertTheme" style="padding:8px 16px;background:var(--s2);border:1px solid var(--br);border-radius:8px;color:var(--t);font-size:12px;font-weight:700;cursor:pointer;font-family:'Barlow Condensed',sans-serif;">✕ Revert</button>
        <button data-ui-action="confirmTheme" style="padding:8px 20px;background:var(--orange);border:none;border-radius:8px;color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:'Barlow Condensed',sans-serif;">✓ Apply Theme</button>
      </div>`;
    document.body.appendChild(bar);
  }
};
window._teRevertTheme = function() {
  const orig = window._teOriginalTheme || 'nbd-original';
  const TE = window.ThemeEngine;
  if (TE) { TE.apply(orig, false); } else { applyTheme(orig, false); }
  window._teOriginalTheme = null;
  const bar = document.getElementById('te-confirm-bar');
  if (bar) bar.remove();
};
window._teConfirmTheme = function() {
  // Save the currently previewed theme permanently
  const cur = window.ThemeEngine ? window.ThemeEngine.getCurrent() : (document.documentElement.getAttribute('data-theme') || 'nbd-original');
  if (window.ThemeEngine) { window.ThemeEngine.apply(cur, true); } else { applyTheme(cur, true); }
  window._teOriginalTheme = null;
  const bar = document.getElementById('te-confirm-bar');
  if (bar) bar.remove();
  if (typeof showToast === 'function') showToast('Theme applied ✓');
  // Refresh the section to update active states
  const s = document.getElementById('te-theme-sections');
  if (s) { s.dataset.loaded = ''; switchSettingsTab('appearance'); }
};

function toggleSettingsSection(section) {
  const container = document.getElementById('settings-'+section);
  if (!container) return;
  
  const isCollapsed = container.classList.contains('collapsed');
  
  if(isCollapsed) {
    container.classList.remove('collapsed');
  } else {
    container.classList.add('collapsed');
  }
  
  // Save state to localStorage
  localStorage.setItem('settings-'+section, isCollapsed ? 'open' : 'collapsed');
}

// Restore settings section states on load
function restoreSettingsSections() {
  ['themes', 'crm', 'estimates', 'daily'].forEach(section => {
    const state = localStorage.getItem('settings-'+section);
    const container = document.getElementById('settings-'+section);
    if (!container) return;
    
    // Apply saved state, or use default (themes/crm open, estimates/daily collapsed)
    if (state === 'collapsed') {
      container.classList.add('collapsed');
    } else if (state === 'open') {
      container.classList.remove('collapsed');
    }
    // If no saved state, leave as-is (HTML default)
  });
}


// Restore nav section states on load
function restoreNavSections() {
  ['tools','insights','ai-tools'].forEach(section => {
    const state = localStorage.getItem('nav-'+section);
    if(state === 'closed') {
      const content = document.getElementById('section-'+section);
      const toggle = document.getElementById('toggle-'+section);
      if (content) content.classList.remove('open');
      if (toggle) toggle.classList.remove('open');
    }
  });
}
setTimeout(restoreNavSections, 100);

// ══════════════════════════════════════════════

// ══ Window Scope Exposures ══════════════════════════════════
window.openCmdPalette = openCmdPalette;
window.closeCmdPalette = closeCmdPalette;
window.openShortcutsPanel = openShortcutsPanel;
window.closeShortcutsPanel = closeShortcutsPanel;
window.toggleShortcutsPanel = toggleShortcutsPanel;
window.scrollToColumn = scrollToColumn;
window.showKanbanSkeleton = showKanbanSkeleton;
window.showPhotosSkeleton = showPhotosSkeleton;
window.showToast = showToast;
window.closeToast = closeToast;
window.toggleNavSection = toggleNavSection;
window.switchSettingsTab = switchSettingsTab;
window.toggleSettingsSection = toggleSettingsSection;
window.restoreSettingsSections = restoreSettingsSections;
window.restoreNavSections = restoreNavSections;


// ── CSP-safe delegation for 9 data-ui-action attrs (replaces inline onclick=
//    that prod CSP `script-src-attr 'none'` was killing). Preserves
//    cmd-palette hover-selection via mouseover bound to data-ui-hover-idx.
(function () {
  if (window._NBD_UI_DELEGATE_BOUND) return;
  window._NBD_UI_DELEGATE_BOUND = true;
  const UI_FN = {
    cmdExecuteItem:     (id) => { if (typeof cmdExecuteItem === 'function') cmdExecuteItem(parseInt(id, 10)); },
    toastUndo:          (id) => { if (typeof window._toastUndo === 'function') window._toastUndo(id); },
    closeToast:         (id) => { if (typeof window._closeToast === 'function') window._closeToast(id); },
    applyTheme:         (id) => { if (typeof applyTheme === 'function') applyTheme(id); },
    previewTheme:       (id) => { if (typeof window._tePreviewTheme === 'function') window._tePreviewTheme(id); },
    renderSettingsGrid: (id) => { if (typeof window._teRenderSettingsGrid === 'function') window._teRenderSettingsGrid(id); },
    revertTheme:        ()   => { if (typeof window._teRevertTheme === 'function') window._teRevertTheme(); },
    confirmTheme:       ()   => { if (typeof window._teConfirmTheme === 'function') window._teConfirmTheme(); },
  };
  document.addEventListener('click', function (ev) {
    const t = ev.target.closest && ev.target.closest('[data-ui-action]');
    if (!t) return;
    const fn = UI_FN[t.dataset.uiAction];
    if (typeof fn !== 'function') return;
    try { fn(t.dataset.uiId); }
    catch (e) { console.error('[ui] dispatch ' + t.dataset.uiAction + ' failed:', e); }
  });
  document.addEventListener('mouseover', function (ev) {
    const t = ev.target.closest && ev.target.closest('[data-ui-hover-idx]');
    if (!t) return;
    const idx = parseInt(t.dataset.uiHoverIdx, 10);
    if (!Number.isFinite(idx)) return;
    if (typeof cmdSelectedIndex !== 'undefined') {
      cmdSelectedIndex = idx;
      if (typeof renderCmdResults === 'function' && typeof cmdCurrentResults !== 'undefined') {
        renderCmdResults(cmdCurrentResults);
      }
    }
  });
})();
