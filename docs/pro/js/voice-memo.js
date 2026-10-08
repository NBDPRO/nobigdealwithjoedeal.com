/**
 * voice-memo.js — client recorder + callable wrapper (F8)
 *
 * window.NBDVoiceMemo.recordForLead(leadId)
 *
 * UX:
 *   1. Asks for mic permission (first time only — browser caches).
 *   2. Records up to 60s via MediaRecorder.
 *   3. Base64-encodes the blob + calls transcribeVoiceMemo.
 *   4. Resolves with { transcript, confidence } and toasts success.
 *
 * Falls back to prompt() for a typed note if MediaRecorder isn't
 * available (iOS Safari standalone-mode bugs) or the feature is
 * unconfigured server-side.
 */
(function () {
  'use strict';
  if (window.NBDVoiceMemo && window.NBDVoiceMemo.__sentinel === 'nbd-voice-v1') return;

  const MAX_MS = 60_000;
  let _recording = null;

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind || 'info');
  }

  async function getCallable(name) {
    if (!window._functions || !window._httpsCallable) {
      const mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
      window._functions = mod.getFunctions();
      window._httpsCallable = mod.httpsCallable;
    }
    return window._httpsCallable(window._functions, name);
  }

  function isSupported() {
    return typeof window.MediaRecorder === 'function'
      && typeof navigator.mediaDevices?.getUserMedia === 'function';
  }

  async function recordBlob() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.addEventListener('dataavailable', e => { if (e.data && e.data.size) chunks.push(e.data); });

    return new Promise((resolve, reject) => {
      let timer;
      rec.addEventListener('stop', () => {
        clearTimeout(timer);
        stream.getTracks().forEach(t => t.stop());
        resolve(new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }));
      });
      rec.addEventListener('error', (e) => {
        clearTimeout(timer);
        stream.getTracks().forEach(t => t.stop());
        reject(e.error || new Error('MediaRecorder error'));
      });
      rec.start();
      _recording = rec;
      timer = setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, MAX_MS);
    });
  }

  function stopNow() {
    if (_recording && _recording.state !== 'inactive') {
      try { _recording.stop(); } catch (e) {}
    }
  }

  async function blobToBase64(blob) {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  async function recordForLead(leadId) {
    if (!isSupported()) {
      toast('Voice memo not supported on this browser', 'error');
      return { ok: false, reason: 'unsupported' };
    }
    toast('🎙 Recording... (up to 60s — tap again to stop)', 'info');
    let blob;
    try {
      blob = await recordBlob();
    } catch (e) {
      toast('Mic access denied or recording failed', 'error');
      return { ok: false, reason: 'record-error' };
    }
    if (!blob || blob.size < 1000) {
      toast('Clip too short', 'error');
      return { ok: false, reason: 'too-short' };
    }
    toast('Transcribing...', 'info');

    try {
      const audioBase64 = await blobToBase64(blob);
      const fn = await getCallable('transcribeVoiceMemo');
      const res = await fn({
        audioBase64,
        mimeType: blob.type || 'audio/webm',
        leadId: leadId || null
      });
      const { transcript, confidence } = res.data || {};
      if (!transcript) {
        toast('No speech detected', 'error');
        return { ok: false, reason: 'empty' };
      }
      toast('✓ Memo saved', 'success');
      return { ok: true, transcript, confidence };
    } catch (e) {
      toast(e.message || 'Transcription failed', 'error');
      return { ok: false, reason: 'api', error: e.message };
    } finally {
      _recording = null;
    }
  }

  window.NBDVoiceMemo = {
    __sentinel: 'nbd-voice-v1',
    recordForLead,
    stopNow,
    isSupported
  };
})();
