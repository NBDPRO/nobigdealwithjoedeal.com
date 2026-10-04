/**
 * photo-ai-classifier.js — Phase 3 client wrapper for the
 * analyzePhotoVision Cloud Function.
 *
 * Client wrapper for the AUTO-TAG path. Returns a light suggestion
 * (phase / damageType / severity / caption / confidence) that the
 * upload flow stamps onto every photo and the Review UI surfaces as
 * 1-tap-accept chips.
 *
 * The function is heavyweight (1-3s/photo, costs money). This module
 * gives the upload flow a fire-and-forget API plus a throttled batch
 * mode for the Review UI (Phase 4):
 *
 *   PhotoAIClassifier.classify(photoId)          → Promise<suggestion|null>
 *   PhotoAIClassifier.classifyBatch(photoIds)    → Promise<Map<id, suggestion>>
 *
 * Concurrency cap of 5 by default so a 100-photo batch:
 *   - finishes in ~20-40s (vs ~3-5min serialized)
 *   - never trips the 100/min/uid rate limit
 *   - degrades gracefully on cap hit (function returns {skipped:true})
 *
 * Suggestions also land on the photo doc as `aiSuggestion` server-side,
 * so the Review UI doesn't need to thread them through state — it can
 * just read photos from Firestore and chip whichever ones have a
 * suggestion populated.
 *
 * ── Sister wrapper ──
 * For the on-demand DEEP-analysis path (Sonnet, returns rich
 * observations + recommendations), see photo-ai.js / PhotoAI. Two
 * paths exist by design — different cost profiles, different
 * surfaces. Design split documented at the top of
 * functions/photo-vision.js + functions/handlers/photo.js.
 */
(function () {
  'use strict';

  if (window.PhotoAIClassifier
      && window.PhotoAIClassifier.__sentinel === 'nbd-photo-ai-classifier-v1') return;

  // ─── Helpers ─────────────────────────────────────────────────────
  let _httpsCallable = null;
  let _fns = null;
  async function ensureCallable() {
    if (_httpsCallable) return _httpsCallable;
    if (window._httpsCallable && window._functions) {
      _fns = window._functions;
      _httpsCallable = window._httpsCallable(_fns, 'analyzePhotoVision');
      return _httpsCallable;
    }
    // Lazy-load Firebase Functions SDK on first use (mirrors the
    // pattern used by _sharePortalLink and other on-demand callers
    // in customer.html / dashboard.html).
    const mod = await import('/assets/vendor/firebase/12.19.0/firebase-functions.js');
    _fns = mod.getFunctions();
    window._functions   = _fns;
    window._httpsCallable = mod.httpsCallable;
    _httpsCallable = mod.httpsCallable(_fns, 'analyzePhotoVision');
    return _httpsCallable;
  }

  // ─── Per-classify call ──────────────────────────────────────────
  async function classify(photoId) {
    if (typeof photoId !== 'string' || !photoId) return null;
    let call;
    try { call = await ensureCallable(); }
    catch (e) {
      console.warn('[ai-classify] callable init failed:', e.message);
      return null;
    }
    try {
      const res = await call({ photoId });
      const data = res && res.data;
      if (!data) return null;
      if (data.skipped) {
        // Cap reached — bubble it up so the UI can surface a toast.
        try {
          window.dispatchEvent(new CustomEvent('nbd:ai-classify-skipped', {
            detail: { photoId, reason: data.reason }
          }));
        } catch (_) {}
        return null;
      }
      return data.suggestion || null;
    } catch (e) {
      // Permission denied (not your photo) / not found / quota → log
      // and return null. The Review UI just shows the photo without
      // a suggestion in this case.
      console.warn('[ai-classify] call failed:', e && e.message);
      return null;
    }
  }

  // ─── Throttled batch ────────────────────────────────────────────
  // Strict-concurrency pool so a 100-photo batch never floods the
  // function more than CONCURRENCY at a time.
  const DEFAULT_CONCURRENCY = 5;
  async function classifyBatch(photoIds, opts) {
    opts = opts || {};
    const concurrency = Math.max(1, Math.min(20, opts.concurrency || DEFAULT_CONCURRENCY));
    if (!Array.isArray(photoIds) || photoIds.length === 0) return new Map();

    const queue = photoIds.slice();
    const results = new Map();
    let active = 0;
    let aborted = false;

    return new Promise((resolve) => {
      function tick() {
        if (aborted) { if (active === 0) resolve(results); return; }
        while (active < concurrency && queue.length) {
          const id = queue.shift();
          active++;
          classify(id)
            .then(suggestion => results.set(id, suggestion))
            .catch(() => results.set(id, null))
            .finally(() => {
              active--;
              if (opts.onEach) {
                try { opts.onEach(id, results.get(id), results.size, photoIds.length); }
                catch (_) {}
              }
              if (queue.length === 0 && active === 0) resolve(results);
              else tick();
            });
        }
      }
      tick();
    });
  }

  // ─── Cap awareness ──────────────────────────────────────────────
  // The Review UI can listen for this to render a banner.
  // CustomEvent name: 'nbd:ai-classify-skipped' — detail = { photoId, reason }

  window.PhotoAIClassifier = {
    __sentinel: 'nbd-photo-ai-classifier-v1',
    classify,
    classifyBatch,
  };
})();
