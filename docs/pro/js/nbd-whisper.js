/**
 * nbd-whisper.js — NBD Pro's "dictate everywhere" engine (W128)
 *
 * The Whispr-Flow analog requested by the user: tap a floating mic
 * button (or in the future: hold F2), talk, AI-cleaned text drops
 * into whatever input is currently focused. If no input is focused,
 * the result floats as a copyable tooltip.
 *
 * Pipeline:
 *   1. MediaRecorder captures audio (up to 60s, opus/webm preferred)
 *   2. base64 → transcribeVoiceMemo callable (Deepgram Nova-3,
 *      smart_format + punctuate). leadId omitted so we don't leak
 *      dictation transcripts into a lead's activity log.
 *   3. callClaude with a tight cleanup prompt — strip filler words
 *      ("um", "uh", "like"), keep voice + content intact, normalize
 *      punctuation, ~30 token output limit overhead.
 *   4. Insert at cursor position of focused input, OR show a copyable
 *      tooltip if nothing is focused.
 *
 * Public surface:
 *   window.NBDWhisper.dictateInto(targetEl, options)
 *   window.NBDWhisper.attachFloatingButton()
 *   window.NBDWhisper.start({ skipCleanup: bool })
 *   window.NBDWhisper.stop()
 *   window.NBDWhisper.isRecording
 *
 * Disabled when MediaRecorder isn't supported (very old browsers).
 *
 * Wave 128 ships click-to-toggle. Wave 131 will add hold-to-talk
 * via a global hotkey. Wave 130 will add the Quick Capture modal
 * (dedicated 5-minute scratchpad with summarize + extract-tasks
 * routing, separate from the dictate-into-input flow).
 */

(function () {
  'use strict';
  if (window.NBDWhisper && window.NBDWhisper.__sentinel === 'nbd-whisper-v1') return;

  // ─── Configuration ──────────────────────────────────────────────
  const MAX_RECORD_MS = 60_000;             // 60s hard ceiling
  const TICK_MS = 50;                       // visualizer poll interval
  const FLOAT_BTN_ID = 'nbd-whisper-fab';   // floating mic button id
  const VISUALIZER_ID = 'nbd-whisper-viz';  // live waveform overlay id
  const TOOLTIP_ID = 'nbd-whisper-tip';     // copyable result tooltip
  const FOCUSABLE_SELECTOR = 'textarea, input[type="text"], input[type="search"], input:not([type]), [contenteditable="true"]';

  // ─── State ──────────────────────────────────────────────────────
  let _stream = null;
  let _recorder = null;
  let _chunks = [];
  let _audioCtx = null;
  let _analyser = null;
  let _animFrame = 0;
  let _maxTimer = 0;
  let _recordingStartMs = 0;
  let _isRecording = false;
  let _lastFocused = null;       // remember last focused input across mic UI clicks
  let _busyClaude = false;       // simple guard against double-fire

  // ─── Tiny utility helpers ───────────────────────────────────────
  function isSupported() {
    return typeof window.MediaRecorder === 'function'
      && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
  function toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind || 'info');
    else console.log('[NBDWhisper]', kind || 'info', msg);
  }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Track last focused input so the floating mic button can target
  // it even after the user clicks the mic (which steals focus).
  if (typeof document !== 'undefined') {
    document.addEventListener('focusin', (e) => {
      const t = e.target;
      if (!t || !t.matches) return;
      if (t.matches(FOCUSABLE_SELECTOR)) {
        // Skip the mic button itself.
        if (t.id === FLOAT_BTN_ID) return;
        _lastFocused = t;
      }
    }, true);
  }

  // ─── MediaRecorder lifecycle ────────────────────────────────────
  async function _startRecorder() {
    if (_isRecording) return;
    if (!isSupported()) { toast('Voice not supported on this browser', 'error'); return; }

    try {
      _stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      toast(e && e.name === 'NotAllowedError'
        ? 'Mic access denied — enable in browser settings.'
        : 'Could not access microphone.', 'error');
      return;
    }

    // Pick the best supported MIME. Safari emits mp4; Chrome/Firefox webm.
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    let mimeType = '';
    for (const t of preferred) {
      if (MediaRecorder.isTypeSupported(t)) { mimeType = t; break; }
    }

    try {
      _recorder = mimeType
        ? new MediaRecorder(_stream, { mimeType })
        : new MediaRecorder(_stream);
    } catch (e) {
      _releaseStream();
      toast('Recorder failed to initialize.', 'error');
      return;
    }

    _chunks = [];
    _recorder.addEventListener('dataavailable', (ev) => {
      if (ev.data && ev.data.size > 0) _chunks.push(ev.data);
    });
    _recorder.addEventListener('error', () => {
      toast('Recording error.', 'error');
      _stopRecorder();
    });
    _recorder.addEventListener('stop', _onRecorderStop);

    // Audio analyser for the live waveform.
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        _audioCtx = new Ctx();
        const src = _audioCtx.createMediaStreamSource(_stream);
        _analyser = _audioCtx.createAnalyser();
        _analyser.fftSize = 64;
        src.connect(_analyser);
      }
    } catch (_) { /* visualizer is optional */ }

    _recorder.start(1000);
    _isRecording = true;
    _recordingStartMs = Date.now();
    _showVisualizer();
    _updateFabState();

    _maxTimer = setTimeout(_stopRecorder, MAX_RECORD_MS);
  }

  function _stopRecorder() {
    if (!_isRecording) return;
    if (_maxTimer) { clearTimeout(_maxTimer); _maxTimer = 0; }
    if (_recorder && _recorder.state !== 'inactive') {
      try { _recorder.stop(); } catch (_) { /* fall through to onStop */ }
    }
  }

  function _onRecorderStop() {
    _isRecording = false;
    _hideVisualizer();
    _updateFabState();

    const blob = new Blob(_chunks, { type: (_recorder && _recorder.mimeType) || 'audio/webm' });
    _releaseStream();

    if (!blob || blob.size < 800) {
      toast('Clip too short.', 'error');
      return;
    }
    _processBlob(blob);
  }

  function _releaseStream() {
    if (_stream) {
      try { _stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      _stream = null;
    }
    if (_audioCtx) {
      try { _audioCtx.close(); } catch (_) {}
      _audioCtx = null;
    }
    _analyser = null;
    if (_animFrame) {
      cancelAnimationFrame(_animFrame);
      _animFrame = 0;
    }
  }

  // ─── Pipeline: blob → transcript → clean → insert ───────────────
  async function _blobToBase64(blob) {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  // ── W129: unified `dictate` callable (transcribe + clean in one
  // round-trip). Saves a network hop vs. the W128 implementation
  // that chained transcribeVoiceMemo + callClaude. Also moves the
  // cleanup prompt server-side so it's versioned with the function.
  // Falls back to the old chained path if `dictate` is unavailable
  // (e.g. mid-deploy or an older client cached pre-W129 code).
  async function _ensureCallable() {
    if (!window._functions || !window._httpsCallable) {
      const mod = await import('/assets/vendor/firebase/12.19.0/firebase-functions.js');
      window._functions = mod.getFunctions();
      window._httpsCallable = mod.httpsCallable;
    }
  }

  async function _dictate(blob, opts) {
    opts = opts || {};
    await _ensureCallable();
    const audioBase64 = await _blobToBase64(blob);
    // Send the rep's local date as a hint so the server-side
    // summarize/extract-tasks prompts can resolve "tomorrow" correctly.
    const todayLocal = new Date().toLocaleDateString('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    try {
      const fn = window._httpsCallable(window._functions, 'dictate');
      const res = await fn({
        audioBase64,
        mimeType: blob.type || 'audio/webm',
        mode: opts.mode || 'clean',
        todayLocal,
      });
      return res.data || {};
    } catch (e) {
      // Fallback to the W128 chained path if `dictate` callable is
      // unavailable. Lets the FAB keep working through a deploy
      // window where the new function isn't deployed yet.
      // W159 CRITICAL fix: `return await` so a rejection from the
      // fallback propagates back through the outer await in
      // _processBlob's try/catch. Previously `return _dictateFallback(...)`
      // returned the unawaited promise, detaching its rejection from
      // the caller's catch — voice would silently hang with the
      // "Transcribing…" toast stuck and the FAB in idle state.
      console.warn('[NBDWhisper] dictate callable failed, falling back:', e.message);
      return await _dictateFallback(blob, opts);
    }
  }

  async function _dictateFallback(blob, opts) {
    await _ensureCallable();
    const fn = window._httpsCallable(window._functions, 'transcribeVoiceMemo');
    const audioBase64 = await _blobToBase64(blob);
    const res = await fn({
      audioBase64,
      mimeType: blob.type || 'audio/webm',
      leadId: null,
    });
    const transcript = (res.data && res.data.transcript || '').trim();
    if (!transcript || (opts.mode || 'clean') !== 'clean') {
      return { transcript, cleaned: transcript };
    }
    const cleaned = await _cleanWithClaude(transcript);
    return { transcript, cleaned };
  }

  async function _cleanWithClaude(transcript) {
    if (typeof window.callClaude !== 'function') return _localCleanup(transcript);
    const system = 'You are a copy editor. Take the user\'s spoken transcript and return ONLY the cleaned text, with these rules:\n'
      + '1. Strip filler words like "um", "uh", "like", "you know", "I mean", "sort of", "kind of".\n'
      + '2. Add proper punctuation and capitalization.\n'
      + '3. Keep the speaker\'s voice and word choice — do not paraphrase or summarize.\n'
      + '4. If the speaker said a voice command like "new paragraph", insert a paragraph break.\n'
      + '5. Return ONLY the cleaned text. No quotes, no commentary, no preamble.';
    try {
      const result = await window.callClaude({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: Math.min(1500, Math.max(200, transcript.length + 200)),
        system,
        messages: [{ role: 'user', content: transcript }],
        feature: 'whisper-clean',
      });
      const txt = (result && result.content && result.content[0] && result.content[0].text) || '';
      return txt.trim() || _localCleanup(transcript);
    } catch (e) {
      console.warn('[NBDWhisper] Claude cleanup fallback failed:', e.message);
      return _localCleanup(transcript);
    }
  }

  // Tiny offline fallback: capitalize first letter, add ending period
  // if the model isn't reachable. Never throws.
  function _localCleanup(s) {
    let t = String(s || '').trim();
    if (!t) return '';
    t = t[0].toUpperCase() + t.slice(1);
    if (!/[.!?]$/.test(t)) t += '.';
    return t;
  }

  async function _processBlob(blob, opts) {
    opts = opts || {};
    if (_busyClaude) return;
    _busyClaude = true;
    toast('Transcribing…', 'info');
    try {
      // W129: single round-trip via `dictate` callable. Server does
      // transcribe + cleanup in one shot. Fallback path inside
      // _dictate handles the rare case where the new callable
      // isn't deployed yet.
      const result = await _dictate(blob, { mode: opts.mode || 'clean' });
      const cleaned = (result.cleaned || result.transcript || '').trim();
      if (!cleaned) {
        toast('No speech detected.', 'error');
        return;
      }
      _insertOrShow(cleaned);
    } catch (e) {
      toast('Dictation failed: ' + (e.message || 'try again'), 'error');
    } finally {
      _busyClaude = false;
    }
  }

  // ─── Insertion: into focused input, or floating tooltip ─────────
  function _getTarget() {
    // Prefer the LIVE focused element (active right now), then fall
    // back to the last-remembered focused input (which the
    // focusin tracker keeps updated even when the user clicks away
    // to the mic button).
    const active = document.activeElement;
    if (active && active !== document.body && active.matches && active.matches(FOCUSABLE_SELECTOR)) {
      if (active.id !== FLOAT_BTN_ID) return active;
    }
    if (_lastFocused && document.contains(_lastFocused)) return _lastFocused;
    return null;
  }

  function _insertOrShow(text) {
    const target = _getTarget();
    if (target) {
      _insertIntoElement(target, text);
      toast('Dictated ✓', 'success');
    } else {
      _showResultTooltip(text);
    }
  }

  function _insertIntoElement(el, text) {
    // contenteditable
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      el.focus();
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        el.textContent = (el.textContent || '') + text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // textarea / input
    if ('selectionStart' in el && 'selectionEnd' in el && typeof el.setRangeText === 'function') {
      const start = el.selectionStart || 0;
      const end = el.selectionEnd || 0;
      // setRangeText inserts at cursor and collapses cursor to end.
      el.setRangeText(text, start, end, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
      return;
    }
    // Last-resort fallback — append to value/textContent.
    if ('value' in el) {
      el.value = (el.value || '') + text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.textContent = (el.textContent || '') + text;
    }
  }

  function _showResultTooltip(text) {
    let tip = document.getElementById(TOOLTIP_ID);
    if (!tip) {
      tip = document.createElement('div');
      tip.id = TOOLTIP_ID;
      tip.style.cssText =
        'position:fixed;bottom:88px;right:20px;max-width:340px;z-index:var(--z-overlay-top,10001);' +
        'background:#1a1f2e;color:#e2e8f0;border:1px solid var(--orange, #A14A22);' +
        'border-radius:10px;padding:14px 16px;font-size:14px;line-height:1.5;' +
        'box-shadow:0 8px 32px rgba(0,0,0,0.5);';
      document.body.appendChild(tip);
    }
    _placeAboveMic(tip);
    tip.innerHTML =
      '<div style="font-size:11px;color:#94a3b8;margin-bottom:6px;letter-spacing:0.05em;">DICTATED</div>' +
      '<div id="nbd-whisper-tip-text" style="margin-bottom:10px;white-space:pre-wrap;">' + escHtml(text) + '</div>' +
      '<div style="display:flex;gap:8px;">' +
        '<button type="button" class="nbd-whisper-tip-copy" style="flex:1;padding:7px 12px;border-radius:6px;border:none;background:var(--orange, #A14A22);color:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer;">Copy</button>' +
        '<button type="button" class="nbd-whisper-tip-close" style="padding:7px 12px;border-radius:6px;border:1px solid #2a3344;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;">Dismiss</button>' +
      '</div>';
    const copyBtn = tip.querySelector('.nbd-whisper-tip-copy');
    const closeBtn = tip.querySelector('.nbd-whisper-tip-close');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = 'Copied ✓';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      } catch (_) {
        copyBtn.textContent = 'Failed';
      }
    });
    closeBtn.addEventListener('click', () => tip.remove());
    // Auto-dismiss after 30s — gives time to read + copy without lingering.
    setTimeout(() => { try { tip.remove(); } catch (_) {} }, 30_000);
  }

  // ─── Keep the pill + result tip OFF the mic (2026-09-25, phone audit) ──
  // Both were pinned at bottom:~90px, which clears the mic only at its
  // desktop slot (bottom 20px, 54px tall, so its top edge sits 74px up). On
  // a phone the mic lives in the speed-dial fan row, and on customer.html it
  // is lifted above the quick-action bar as well, so the recording pill
  // landed right on it: the ⏹ stop control hit-tested as the pill, a rep
  // could not stop a dictation and it ran to the 60s ceiling (measured at
  // 412px on customer.html; the dashboard's fan row has the same overlap).
  // Measure where the mic actually is and float above it. Math.max keeps
  // the desktop slot at its old 90px.
  function _placeAboveMic(el) {
    const mic = document.getElementById(FLOAT_BTN_ID);
    if (!el || !mic || !mic.getClientRects().length) return;
    const r = mic.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!vh || r.bottom <= 0 || r.top >= vh) return;
    el.style.bottom = Math.max(90, Math.round(vh - r.top + 10)) + 'px';
  }

  // ─── Live audio visualizer ──────────────────────────────────────
  function _showVisualizer() {
    let viz = document.getElementById(VISUALIZER_ID);
    if (!viz) {
      viz = document.createElement('div');
      viz.id = VISUALIZER_ID;
      viz.style.cssText =
        'position:fixed;bottom:90px;right:20px;z-index:var(--z-overlay,10000);display:flex;align-items:center;' +
        'gap:10px;padding:10px 14px;background:#0a1424;border:1px solid var(--orange, #A14A22);' +
        'border-radius:999px;box-shadow:0 4px 20px rgba(0,0,0,0.4);font:inherit;font-size:13px;color:#fff;';
      viz.innerHTML =
        '<span style="width:10px;height:10px;border-radius:50%;background:var(--orange, #A14A22);' +
          'animation:nbd-whisper-pulse 1s ease-in-out infinite;"></span>' +
        '<canvas id="nbd-whisper-canvas" width="120" height="22" style="display:block;"></canvas>' +
        '<span id="nbd-whisper-timer" style="font-variant-numeric:tabular-nums;min-width:34px;">0:00</span>';
      document.body.appendChild(viz);
      // Pulse keyframes once.
      if (!document.getElementById('nbd-whisper-pulse-css')) {
        const css = document.createElement('style');
        css.id = 'nbd-whisper-pulse-css';
        css.textContent = '@keyframes nbd-whisper-pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.4;transform:scale(1.4);}}';
        document.head.appendChild(css);
      }
    }
    viz.style.display = 'flex';
    _placeAboveMic(viz);
    const canvas = document.getElementById('nbd-whisper-canvas');
    const ctx = canvas && canvas.getContext('2d');
    const timerEl = document.getElementById('nbd-whisper-timer');
    if (!ctx) return;

    const draw = () => {
      if (!_isRecording) return;
      const data = new Uint8Array(_analyser ? _analyser.frequencyBinCount : 0);
      if (_analyser) _analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const bars = 18;
      const barW = canvas.width / bars - 1;
      for (let i = 0; i < bars; i++) {
        // If no analyser, render a gentle idle pulse so the UI
        // doesn't look frozen.
        const sample = _analyser
          ? data[Math.floor((i / bars) * data.length)] / 255
          : 0.2 + 0.15 * Math.sin(Date.now() / 250 + i / 2);
        const h = Math.max(2, sample * canvas.height);
        ctx.fillStyle = '#fbbf24';
        ctx.fillRect(i * (barW + 1), (canvas.height - h) / 2, barW, h);
      }
      const elapsed = Math.floor((Date.now() - _recordingStartMs) / 1000);
      if (timerEl) {
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        timerEl.textContent = m + ':' + String(s).padStart(2, '0');
      }
      _animFrame = requestAnimationFrame(draw);
    };
    draw();
  }

  function _hideVisualizer() {
    const viz = document.getElementById(VISUALIZER_ID);
    if (viz) viz.style.display = 'none';
  }

  // ─── Floating mic button ────────────────────────────────────────
  function attachFloatingButton() {
    if (!isSupported()) return;
    if (document.getElementById(FLOAT_BTN_ID)) return;
    const btn = document.createElement('button');
    btn.id = FLOAT_BTN_ID;
    btn.type = 'button';
    btn.title = 'Dictate (W128) — tap to start, tap again to stop';
    btn.setAttribute('aria-label', 'Dictate into focused input');
    btn.style.cssText =
      // W149: bottom uses calc + safe-area-inset-bottom so the FAB
      // clears the iOS home indicator on iPhone X+ and the gesture
      // bar on Android. Without this, the button sat ~10px below
      // the home indicator on a notched phone, making it tap-occluded.
      'position:fixed;' +
      'bottom:calc(20px + env(safe-area-inset-bottom, 0px));' +
      'right:calc(20px + env(safe-area-inset-right, 0px));' +
      'z-index:9999;' +
      'width:54px;height:54px;border-radius:50%;border:none;' +
      'background:var(--orange, #A14A22);color:#fff;font-size:22px;' +
      'box-shadow:0 6px 20px rgba(161,74,34,0.4);cursor:pointer;' +
      'display:flex;align-items:center;justify-content:center;' +
      '-webkit-tap-highlight-color:transparent;transition:transform 120ms ease, box-shadow 120ms ease, opacity 160ms ease;';
    btn.innerHTML = '🎤';
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); /* keep input focused */ });
    btn.addEventListener('click', () => {
      if (_isRecording) _stopRecorder();
      else _startRecorder();
    });
    document.body.appendChild(btn);
    _updateFabState();
  }

  function _updateFabState() {
    const btn = document.getElementById(FLOAT_BTN_ID);
    if (!btn) return;
    if (_isRecording) {
      btn.style.background = '#ef4444';
      btn.style.boxShadow = '0 6px 20px rgba(239,68,68,0.5)';
      btn.innerHTML = '⏹';
      btn.title = 'Stop recording';
    } else {
      btn.style.background = 'var(--orange, #A14A22)';
      btn.style.boxShadow = '0 6px 20px rgba(161,74,34,0.4)';
      btn.innerHTML = '🎤';
      btn.title = 'Dictate (W128) — tap to start, tap again to stop';
    }
  }

  // ─── Public API for explicit dictate-into call sites ────────────
  // (used in W131's hotkey wiring + future Quick Capture in W130)
  function dictateInto(targetEl, opts) {
    opts = opts || {};
    if (targetEl && targetEl.matches && targetEl.matches(FOCUSABLE_SELECTOR)) {
      _lastFocused = targetEl;
      try { targetEl.focus(); } catch (_) {}
    }
    if (_isRecording) _stopRecorder();
    else _startRecorder();
  }

  // ─── W131: Hold-to-talk hotkey ─────────────────────────────────
  // Hold the configured key (default F2) → recording starts after a
  // 200ms grip window (so an accidental tap doesn't fire an
  // empty 50ms recording). Release → stop + process.
  //
  // Two reasons for the 200ms threshold:
  //   1. Accidental F2 taps on Windows (e.g. rename file shortcut
  //      reflex from File Explorer) shouldn't trigger dictation.
  //   2. The MediaRecorder + getUserMedia handshake takes ~80–150ms
  //      on cold mic permission. Without the threshold, fast taps
  //      hit a "clip too short" error every time.
  //
  // Customization:
  //   - localStorage.nbd_whisper_hotkey = 'F2' (default) | 'F3' | ...
  //   - localStorage.nbd_whisper_hotkey_disabled = '1' to opt out.
  //
  // Voice commands ("send", "stop", "delete that", "new paragraph")
  // are handled server-side by W129's CLEAN_PROMPT — no client-side
  // command parsing needed. The "send" command is handled below by
  // detecting it in the cleaned text and clicking a sibling submit
  // button if found.

  const DEFAULT_HOTKEY = 'F2';
  const HOLD_THRESHOLD_MS = 200;
  let _hotkeyDown = false;
  let _hotkeyTimer = 0;
  let _hotkeyArmed = false;
  let _hotkeyHandlersBound = false;

  function _getHotkeyName() {
    try { return localStorage.getItem('nbd_whisper_hotkey') || DEFAULT_HOTKEY; }
    catch (_) { return DEFAULT_HOTKEY; }
  }
  function _isHotkeyDisabled() {
    try { return localStorage.getItem('nbd_whisper_hotkey_disabled') === '1'; }
    catch (_) { return false; }
  }

  function attachHotkey() {
    // Always attach the listeners; the onDown/onUp handlers themselves
    // gate on _isHotkeyDisabled() each event, so the Comfort tab can
    // toggle without requiring a page reload.
    if (_hotkeyHandlersBound) return;
    if (typeof document === 'undefined') return;
    if (!isSupported()) return;

    const onDown = (e) => {
      // Re-check the disabled flag on every keydown so a Comfort
      // tab toggle takes effect without a page reload.
      if (_isHotkeyDisabled()) return;
      // Match by key name (F2/F3/etc.) so a Cmd-/Ctrl-modified press
      // of the same key doesn't accidentally toggle recording.
      const target = _getHotkeyName();
      if (e.key !== target) return;
      // Modifier-pressed F2 should pass through to the browser/OS.
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.repeat) {
        // Auto-repeat fires while held — ignore everything after the
        // first event so we don't restart the recorder mid-hold.
        e.preventDefault();
        return;
      }
      _hotkeyDown = true;
      _hotkeyArmed = false;
      e.preventDefault();
      // Wait the threshold before actually starting. If the user
      // releases before the timer fires, treat as a tap (no-op).
      _hotkeyTimer = setTimeout(() => {
        _hotkeyTimer = 0;
        if (!_hotkeyDown) return;
        _hotkeyArmed = true;
        _startRecorder();
      }, HOLD_THRESHOLD_MS);
    };

    const onUp = (e) => {
      const target = _getHotkeyName();
      if (e.key !== target) return;
      _hotkeyDown = false;
      e.preventDefault();
      if (_hotkeyTimer) {
        clearTimeout(_hotkeyTimer);
        _hotkeyTimer = 0;
        // Released before threshold — quick tap, do nothing.
        return;
      }
      if (_hotkeyArmed && _isRecording) {
        _hotkeyArmed = false;
        _stopRecorder();
      }
    };

    // Blur safety: if the window loses focus mid-hold, treat as
    // released (otherwise the recording would run until the 60s cap).
    const onBlur = () => {
      if (_hotkeyDown) {
        _hotkeyDown = false;
        if (_hotkeyTimer) { clearTimeout(_hotkeyTimer); _hotkeyTimer = 0; }
        if (_hotkeyArmed && _isRecording) {
          _hotkeyArmed = false;
          _stopRecorder();
        }
      }
    };

    document.addEventListener('keydown', onDown, true);
    document.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', onBlur, true);
    _hotkeyHandlersBound = true;

    // Update the FAB tooltip to mention the hotkey.
    setTimeout(() => {
      const btn = document.getElementById(FLOAT_BTN_ID);
      if (btn) btn.title = 'Dictate — tap, or hold ' + _getHotkeyName() + ' to talk';
    }, 100);
  }

  function setHotkey(keyName) {
    if (typeof keyName !== 'string' || !keyName) return;
    try { localStorage.setItem('nbd_whisper_hotkey', keyName); } catch (_) {}
    const btn = document.getElementById(FLOAT_BTN_ID);
    if (btn && !_isHotkeyDisabled()) {
      btn.title = 'Dictate — tap, or hold ' + keyName + ' to talk';
    }
  }

  function setHotkeyEnabled(enabled) {
    try {
      if (enabled) localStorage.removeItem('nbd_whisper_hotkey_disabled');
      else localStorage.setItem('nbd_whisper_hotkey_disabled', '1');
    } catch (_) {}
    if (enabled) attachHotkey();
    // Note: disabling without reload leaves the listeners attached
    // but they early-return on _isHotkeyDisabled() check — which we
    // re-evaluate inside the handlers below.
  }

  // Auto-attach hotkey at the same time as the FAB.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachHotkey, { once: true });
  } else {
    setTimeout(attachHotkey, 0);
  }

  // ─── Public exports ─────────────────────────────────────────────
  window.NBDWhisper = {
    __sentinel: 'nbd-whisper-v1',
    isSupported,
    attachFloatingButton,
    attachHotkey,
    setHotkey,
    setHotkeyEnabled,
    dictateInto,
    start: _startRecorder,
    stop: _stopRecorder,
    get isRecording() { return _isRecording; },
    get hotkey() { return _getHotkeyName(); },
    get hotkeyDisabled() { return _isHotkeyDisabled(); },
  };

  // Auto-attach the floating button once the DOM is interactive on
  // pages that include this script. Pages that want to suppress it
  // can call window.NBDWhisper.attachFloatingButton = function(){};
  // BEFORE this auto-init runs, but the standard case is "just
  // include the script and the FAB appears."
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachFloatingButton, { once: true });
  } else {
    setTimeout(attachFloatingButton, 0);
  }
})();
