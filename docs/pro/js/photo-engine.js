/**
 * PhotoEngine — Comprehensive Photo Management for NBD Pro Roofing CRM
 *
 * Handles camera capture, tagging, Firebase Storage upload, gallery,
 * lightbox, AI auto-tag, and bulk analyze. Single-file monolith by
 * design (§3.3 audit deferred multi-file split — see PR notes; rough
 * section map below makes navigation easy enough that the split isn't
 * load-bearing yet).
 *
 * ── Sections (rough line ranges, search for "// ════" to jump) ──────
 *   1.  TAG SYSTEM         — TAG_CATEGORIES enum (~line  14)
 *   2.  QUALITY PRESETS    — QUALITY_PRESETS enum (~line  55)
 *   3.  STATE              — module-private `state` object (~line 77)
 *   4.  STYLES             — injectStyles() injects all CSS once (~line  90)
 *   5.  UTILITY FUNCTIONS  — resizeImage, escapeHtml, etc. (~line 690)
 *   6.  CAMERA CAPTURE     — openCamera() + getUserMedia flow (~line 761)
 *   7.  PREVIEW & TAGGING  — showPreview() post-capture screen (~line 983)
 *   8.  FIREBASE UPLOAD    — uploadPhotoToFirebase() + AI auto-tag (~line 1101)
 *   9.  GALLERY & BROWSER  — renderGallery() + filtering/sorting (~line 1234)
 *  10.  LIGHTBOX           — openLightbox() full-screen viewer (~line 1322)
 *  11.  FIRESTORE QUERIES  — getPhotosForLead() etc. (~line 1422)
 *  12.  STAGING & REPORT   — stagePhoto() / report wiring (~line 1513)
 *  13.  PUBLIC API         — window.PhotoEngine = { ... } (~line 1540)
 *
 * ── Public API (window.PhotoEngine) ──────────────────────────────────
 *   openCamera(leadId)                — start the capture flow
 *   uploadPhotoToFirebase(blob, ...)  — direct upload bypass for files
 *   renderGallery(containerId, leadId)— populate a gallery container
 *   openLightbox(photoId, leadId)     — full-screen viewer
 *   deletePhotoFromFirebase(photoId)  — delete photo doc + Storage blob
 *   getPhotosForLead(leadId)          — Firestore read (cached)
 *   __updatePhotoCache(leadId, ...)   — in-memory cache patch (used by AI)
 *
 *   Inline-action delegate targets (called from data-action attributes
 *   in rendered HTML — wired in dashboard-actions.js):
 *     peRemove · peTagToggle · peBulkAnalyze · peOpenLightbox
 *     peStagePhoto · peDeletePhoto
 *
 * ── State shape ──────────────────────────────────────────────────────
 *   currentPreset       — 'quick' | 'standard' | 'high-res'
 *   selectedTags        — string[]    (active filter chips)
 *   stagedPhotos        — { [leadId]: photoId[] }
 *   cameraStream        — MediaStream | null (active camera)
 *   currentLeadId       — string | null
 *   photoCache          — { [leadId]: photoData[] }
 *   sessionPhotoCount   — number      (since modal opened)
 *   lastThumbUrl        — string      (camera "last shot" preview)
 *   uploadQueue         — in-memory MIRROR of the durable offline upload
 *                         queue (photo-queue-store.js owns the truth); the
 *                         sole queue only when IndexedDB is unavailable
 *
 * ── Load order requirement ───────────────────────────────────────────
 *   Firebase SDK + window._storage / _db / _user / _auth must be ready
 *   before this file runs. The IIFE warns (doesn't throw) so the page
 *   doesn't hard-crash; methods fail gracefully if called before init.
 *
 * ── Related modules ──────────────────────────────────────────────────
 *   photo-ai-classifier.js  — Haiku auto-tag wrapper (per-upload, USD-capped)
 *   photo-ai.js             — Sonnet deep-analysis wrapper (on-demand)
 *   photo-report.js         — Homeowner/adjuster PDF generator
 *   photo-editor.js         — Annotation overlay tool
 *   photo-smart-ingest.js   — Pre-upload EXIF/GPS analysis
 *   photo-queue-store.js    — IndexedDB store behind the offline queue
 *   photo-queue-recovery.js — drains that store on dashboard boot
 *
 * See functions/handlers/photo.js + functions/photo-vision.js for the
 * server-side AI paths (intentional two-path design — Haiku auto-tag
 * + Sonnet deep — documented at the top of those files).
 */

(function() {
  'use strict';

  // Local HTML escaper for user-sourced photo fields (description, location,
  // tags, AI text) interpolated into gallery/lightbox innerHTML. Previously these
  // calls resolved to a top-level escHtml() that happens to be global from
  // crm-leads.js — a fragile undeclared cross-module dependency that would throw
  // ReferenceError on any page that loads PhotoEngine without crm-leads. Define
  // it locally so escaping is self-contained.
  // Humanizes the AI's snake_case damageType ('granular_loss' → 'Granular
  // loss') via the shared canon in docs/pro/js/photo-damage-types.js; the
  // chip used to render the raw enum. Resolved per call, raw-value fallback.
  const dmgLabel = (v) => {
    const D = window.NBD_PHOTO_DAMAGE;
    return D ? D.label(v) : String(v == null ? '' : v);
  };
  const escHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Ensure Firebase is initialized
  if (!window._storage || !window._db || !window._user || !window._auth) {
    console.warn('PhotoEngine: Firebase not fully initialized. Waiting...');
  }

  // ============================================================================
  // TAG SYSTEM — Categories and definitions
  // ============================================================================
  const TAG_CATEGORIES = {
    damage: {
      label: 'Damage Type',
      color: '#EF4444',
      tags: [
        'hail', 'wind', 'impact', 'wear', 'leak', 'missing_shingles',
        'lifted_shingles', 'cracked', 'granule_loss', 'nail_pop',
        'flashing_damage', 'gutter_damage', 'soffit_damage', 'fascia_damage',
        'skylight_damage', 'vent_damage', 'chimney_damage'
      ]
    },
    location: {
      label: 'Location',
      color: '#3B82F6',
      tags: [
        'front_slope', 'back_slope', 'left_slope', 'right_slope', 'ridge',
        'valley', 'hip', 'eave', 'rake', 'gutter', 'soffit', 'fascia',
        'chimney', 'skylight', 'vent', 'flat_section', 'garage', 'porch',
        'interior_ceiling', 'attic'
      ]
    },
    photo_type: {
      label: 'Photo Type',
      color: '#8B5CF6',
      tags: [
        'before', 'after', 'during', 'damage_close_up', 'overview',
        'measurement', 'material_sample', 'test_square', 'satellite',
        'existing_condition'
      ]
    },
    report_section: {
      label: 'Report Section',
      color: '#06B6D4',
      tags: [
        'cover_photo', 'roof_overview', 'damage_detail', 'interior_damage',
        'repair_needed', 'completed_work', 'material_used', 'comparison'
      ]
    }
  };

  // ============================================================================
  // QUALITY PRESETS
  // ============================================================================
  const QUALITY_PRESETS = {
    quick: {
      label: 'Quick',
      maxDimension: 640,
      jpegQuality: 0.6,
      description: 'Fast upload for D2D canvassing'
    },
    standard: {
      label: 'Standard',
      maxDimension: 1280,
      jpegQuality: 0.8,
      description: 'Balanced everyday use'
    },
    'high-res': {
      label: 'High-Res',
      maxDimension: 2048,
      jpegQuality: 0.92,
      description: 'Insurance documentation'
    }
  };

  // ============================================================================
  // STATE — module-private. Shape documented in the file header above.
  // ============================================================================
  let state = {
    currentPreset: localStorage.getItem('photoEnginePreset') || 'standard',
    selectedTags: [],
    stagedPhotos: {}, // { leadId: [photoIds] }
    cameraStream: null,
    currentLeadId: null,
    photoCache: {}, // { leadId: [photoData] }
    sessionPhotoCount: 0,
    lastThumbUrl: null,
    uploadQueue: [], // offline-safe queue
    // 'burst' (default since 2026-10-04): the shutter only shoots — the
    // camera stays open and tagging happens afterwards in Photo Review.
    // 'tag': the old per-shot Review & Tag sheet. The rep's choice persists.
    captureMode: _readCaptureMode()
  };

  function _readCaptureMode() {
    try {
      return localStorage.getItem('photoEngineCaptureMode') === 'tag' ? 'tag' : 'burst';
    } catch (_) { return 'burst'; }
  }

  // ============================================================================
  // STYLES - Injected into DOM
  // ============================================================================

  function injectStyles() {
    if (document.getElementById('photo-engine-styles')) return;

    const styles = `
      /* ═══════════════════════════════════════════
         NBD PRO CAMERA — Professional Inspection Tool
         Phone-first, one-handed, tag-as-you-go
         ═══════════════════════════════════════════ */

      .pe-modal {
        position: fixed;
        top:0;right:0;bottom:0;left:0;
        background: #000;
        display: flex;
        flex-direction: column;
        z-index: var(--z-overlay,10000);
        font-family: 'Barlow Condensed', 'Barlow', -apple-system, sans-serif;
        color: #fff;
        -webkit-user-select: none;
        user-select: none;
      }

      /* ── CAMERA TOP BAR ── */
      .pe-cam-topbar {
        position: absolute;
        top: 0; left: 0; right: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        padding-top: max(12px, env(safe-area-inset-top));
        background: linear-gradient(to bottom, rgba(0,0,0,.7) 0%, transparent 100%);
        z-index: 10;
      }
      .pe-cam-back {
        width: 44px; height: 44px;
        background: rgba(255,255,255,.12);
        -webkit-backdrop-filter:blur(20px);backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
        border: none; border-radius: 50%;
        color: #fff; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
      }
      .pe-cam-back:active { transform: scale(.9); }
      .pe-cam-back svg { width: 22px; height: 22px; }
      .pe-cam-title {
        font-size: 15px; font-weight: 700;
        letter-spacing: .08em; text-transform: uppercase;
        text-shadow: 0 1px 4px rgba(0,0,0,.5);
      }
      .pe-cam-tools {
        display: flex; gap: 8px; align-items: center;
      }
      .pe-cam-tool {
        width: 44px; height: 44px;
        background: rgba(255,255,255,.12);
        -webkit-backdrop-filter:blur(20px);backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
        border: none; border-radius: 50%;
        color: #fff; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: background var(--t-mid), transform var(--t-fast);
      }
      .pe-cam-tool:active { transform: scale(.9); }
      .pe-cam-tool.active { background: var(--orange); }
      .pe-cam-tool svg { width: 20px; height: 20px; }
      .pe-preset-badge {
        padding: 4px 10px;
        background: rgba(255,255,255,.15);
        -webkit-backdrop-filter:blur(20px);backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255,255,255,.2);
        border-radius: 6px;
        font-size: 11px; font-weight: 700;
        letter-spacing: .1em; text-transform: uppercase;
        color: #fff; cursor: pointer;
      }
      .pe-preset-badge:active { opacity: .7; }

      /* ── VIEWFINDER ── */
      .pe-cam-viewfinder {
        flex: 1;
        position: relative;
        overflow: hidden;
        background: #000;
      }
      .pe-cam-video {
        width: 100%; height: 100%;
        object-fit: cover;
      }

      /* ── BOTTOM CONTROLS ── */
      .pe-cam-bottom {
        position: absolute;
        bottom: 0; left: 0; right: 0;
        padding: 20px 24px;
        padding-bottom: max(24px, env(safe-area-inset-bottom));
        background: linear-gradient(to top, rgba(0,0,0,.75) 0%, transparent 100%);
        display: flex;
        align-items: center;
        justify-content: space-between;
        z-index: 10;
      }
      .pe-cam-counter {
        width: 48px; height: 48px;
        background: rgba(255,255,255,.12);
        -webkit-backdrop-filter:blur(20px);backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
        border-radius: 12px;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        font-size: 18px; font-weight: 800;
        line-height: 1;
      }
      .pe-cam-counter-label {
        font-size: 8px; font-weight: 600;
        letter-spacing: .1em; text-transform: uppercase;
        opacity: .6; margin-top: 2px;
      }
      .pe-cam-capture {
        width: 72px; height: 72px;
        border-radius: 50%;
        background: transparent;
        border: 4px solid rgba(255,255,255,.8);
        cursor: pointer;
        position: relative;
        transition: transform var(--t-fast), border-color var(--t-mid);
      }
      .pe-cam-capture::after {
        content: '';
        position: absolute;
        inset: 4px;
        border-radius: 50%;
        background: var(--orange);
        transition: background var(--t-fast);
      }
      .pe-cam-capture:active { transform: scale(.92); }
      .pe-cam-capture:active::after { background: #fff; }
      @keyframes pe-flash { 0%{opacity:1} 100%{opacity:0} }
      .pe-cam-flash-overlay {
        position: absolute; top:0;right:0;bottom:0;left:0;
        background: #fff; opacity: 0;
        pointer-events: none; z-index: 5;
      }
      .pe-cam-flash-overlay.flash {
        animation: pe-flash .15s ease-out;
      }
      .pe-cam-thumb {
        width: 48px; height: 48px;
        border-radius: 12px;
        border: 2px solid rgba(255,255,255,.4);
        background: rgba(255,255,255,.08);
        object-fit: cover;
        cursor: pointer;
      }
      .pe-cam-thumb-empty {
        width: 48px; height: 48px;
        border-radius: 12px;
        background: rgba(255,255,255,.06);
        border: 2px dashed rgba(255,255,255,.15);
      }

      /* ── UPLOAD QUEUE INDICATOR ── */
      .pe-queue-bar {
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 3px;
        background: rgba(255,255,255,.1);
        z-index: 15;
      }
      .pe-queue-progress {
        height: 100%;
        background: var(--orange);
        transition: width .3s;
        border-radius: 0 2px 2px 0;
      }
      .pe-queue-label {
        position: absolute;
        top: 6px; right: 16px;
        font-size: 10px; font-weight: 600;
        color: var(--orange);
        letter-spacing: .06em;
        z-index: 15;
      }

      /* ── BURST MODE (2026-10-04) ── */
      .pe-mode-badge {
        min-width: 64px; min-height: 44px;
        padding: 0 12px;
        background: var(--orange);
        border: 1px solid rgba(255,255,255,.35);
        border-radius: 22px;
        font-size: 13px; font-weight: 800;
        letter-spacing: .08em; text-transform: uppercase;
        color: #fff; cursor: pointer;
      }
      .pe-mode-badge[data-mode="tag"] { background: rgba(255,255,255,.15); }
      .pe-cam-counter.pe-bump { animation: pe-bump .25s ease-out; }
      @keyframes pe-bump { 0%{transform:scale(1.25)} 100%{transform:scale(1)} }
      .pe-cam-hint {
        position: absolute; left: 0; right: 0;
        bottom: calc(max(24px, env(safe-area-inset-bottom)) + 92px);
        text-align: center; z-index: 10;
        font-size: 14px; font-weight: 700; letter-spacing: .04em;
        text-shadow: 0 1px 4px rgba(0,0,0,.8);
      }
      .pe-cam-hint[hidden] { display: none; }
      .pe-burst-done {
        position: fixed; left: 0; right: 0; bottom: 0;
        z-index: calc(var(--z-overlay,10000) + 1);
        background: #111418; color: #fff;
        border-top: 1px solid rgba(255,255,255,.15);
        border-radius: 16px 16px 0 0;
        padding: 20px 16px max(20px, env(safe-area-inset-bottom));
        display: flex; flex-direction: column; gap: 12px;
        font-family: 'Barlow', -apple-system, sans-serif;
      }
      .pe-burst-done-title { font-size: 20px; font-weight: 800; }
      .pe-burst-done-sub { font-size: 15px; color: #D7DCE5; line-height: 1.4; }
      .pe-burst-done-row { display: flex; gap: 10px; }
      .pe-burst-done-row .pe-btn { flex: 1; min-height: 48px; font-size: 16px; }
      .pe-burst-done-row a.pe-btn { display: flex; align-items: center; justify-content: center; text-decoration: none; text-align: center; }

      /* ── REVIEW / TAG SCREEN ── */
      .pe-modal-header {
        display: flex; align-items: center;
        padding: 14px 16px;
        padding-top: max(14px, env(safe-area-inset-top));
        background: var(--s);
        border-bottom: 1px solid var(--br);
        gap: 12px;
      }
      .pe-modal-back {
        width: 36px; height: 36px;
        background: none; border: none;
        color: var(--t); cursor: pointer;
        display: flex; align-items: center; justify-content: center;
      }
      .pe-modal-back svg { width: 20px; height: 20px; }
      .pe-modal-title {
        font-size: 16px; font-weight: 700;
        letter-spacing: .04em; text-transform: uppercase;
        color: var(--t);
      }

      .pe-preview-container {
        flex: 1; overflow-y: auto;
        padding: 16px;
        padding-bottom: max(16px, env(safe-area-inset-bottom));
        background: var(--bg);
      }
      .pe-preview-image {
        width: 100%; max-height: 320px;
        object-fit: contain;
        border-radius: 12px;
        background: var(--s);
        margin-bottom: 20px;
      }
      .pe-section {
        margin-bottom: 20px;
      }
      .pe-section-title {
        display: flex; align-items: center; gap: 8px;
        font-size: 11px; font-weight: 700;
        letter-spacing: .12em; text-transform: uppercase;
        color: var(--m);
        margin-bottom: 10px;
      }
      .pe-section-title svg { width: 14px; height: 14px; opacity: .6; }
      .pe-pill-scroll {
        display: flex; gap: 8px;
        overflow-x: auto; -webkit-overflow-scrolling: touch;
        scrollbar-width: none; padding-bottom: 4px;
      }
      .pe-pill-scroll::-webkit-scrollbar { display: none; }

      .pe-tag-pill {
        padding: 8px 16px;
        border-radius: 999px;
        border: 1.5px solid var(--br);
        background: var(--s2);
        color: var(--t);
        cursor: pointer;
        font-size: 13px; font-weight: 500;
        white-space: nowrap;
        transition: background var(--t-mid), color var(--t-mid), border-color var(--t-mid), transform var(--t-fast);
        flex-shrink: 0;
      }
      .pe-tag-pill:active { transform: scale(.95); }
      .pe-tag-pill.selected {
        background: var(--orange);
        border-color: var(--orange);
        color: var(--accent-fg); font-weight: 600;
      }
      .pe-tag-pill.cat-damage.selected { background: var(--red); border-color: var(--red); }
      .pe-tag-pill.cat-location.selected { background: var(--blue); border-color: var(--blue); }
      .pe-tag-pill.cat-type.selected { background: var(--purple); border-color: var(--purple); }

      .pe-textarea, .pe-input {
        width: 100%; padding: 12px 14px;
        background: var(--s2);
        border: 1px solid var(--br);
        border-radius: 10px;
        color: var(--t);
        font-family: 'Barlow', sans-serif;
        font-size: 14px;
        box-sizing: border-box;
      }
      .pe-textarea:focus, .pe-input:focus {
        outline: none;
        border-color: var(--orange);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--orange) 12%, transparent);
      }
      .pe-textarea { resize: none; min-height: 64px; }

      .pe-button-group {
        display: flex; gap: 10px;
        margin-top: 24px;
        padding-bottom: max(8px, env(safe-area-inset-bottom));
      }
      .pe-btn {
        flex: 1;
        padding: 14px 16px;
        border: none; border-radius: 12px;
        font-weight: 700; font-size: 14px;
        letter-spacing: .04em; text-transform: uppercase;
        cursor: pointer;
        transition: background var(--t-mid), color var(--t-mid), transform var(--t-fast);
        font-family: 'Barlow Condensed', sans-serif;
      }
      .pe-btn:active { transform: scale(.97); }
      .pe-btn-primary {
        background: var(--orange);
        color: var(--accent-fg);
      }
      .pe-btn-secondary {
        background: var(--s2);
        color: var(--t);
        border: 1px solid var(--br);
      }

      .pe-close-btn {
        background: none; border: none;
        color: var(--t); cursor: pointer;
        font-size: 1.5rem; padding: .5rem;
        display: flex; align-items: center; justify-content: center;
      }

      /* Gallery Styles */
      .pe-gallery-container {
        padding: 1rem;
      }

      .pe-gallery-toolbar {
        display: flex;
        gap: 1rem;
        margin-bottom: 1rem;
        flex-wrap: wrap;
        align-items: center;
      }

      .pe-toolbar-select {
        padding: 0.5rem 0.75rem;
        background: var(--s2);
        border: 1px solid var(--br);
        border-radius: 0.5rem;
        color: var(--t);
        cursor: pointer;
        font-size: 0.9rem;
      }

      .pe-toolbar-select:focus {
        outline: none;
        border-color: var(--orange);
      }

      .pe-gallery-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: 1rem;
      }

      .pe-gallery-item {
        position: relative;
        background: var(--s2);
        border-radius: 0.5rem;
        overflow: hidden;
        cursor: pointer;
        border: 2px solid transparent;
        transition: border-color var(--t-mid), transform var(--t-mid), box-shadow var(--t-mid);
      }

      .pe-gallery-item:hover {
        border-color: var(--orange);
        transform: translateY(-2px);
      }

      .pe-gallery-item.selected {
        border-color: var(--orange);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--orange) 20%, transparent);
      }

      .pe-gallery-thumbnail {
        width: 100%;
        aspect-ratio: 1;
        object-fit: cover;
      }

      .pe-gallery-checkbox {
        position: absolute;
        top: 0.5rem;
        left: 0.5rem;
        width: 24px;
        height: 24px;
        cursor: pointer;
      }

      .pe-gallery-tags {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        background: linear-gradient(to top, rgba(0,0,0,0.7), transparent);
        padding: 0.5rem;
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem;
      }

      .pe-mini-tag {
        font-size: 0.65rem;
        padding: 0.2rem 0.4rem;
        border-radius: 0.25rem;
        background: color-mix(in srgb, var(--orange) 80%, transparent);
        color: var(--accent-fg);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* B.1 — AI Vision auto-tag chip. Sits in the bottom-left corner
         of each gallery thumbnail (mirror of .pe-staged-badge in top-
         right). Theme-aware via --accent-fg / --accent-ring; pulsing
         dot indicates "AI-generated" so the rep knows to verify. */
      .pe-ai-chip {
        position: absolute;
        bottom: 0.4rem;
        left: 0.4rem;
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        max-width: calc(100% - 0.8rem);
        padding: 0.18rem 0.45rem 0.18rem 0.4rem;
        border-radius: 999px;
        background: color-mix(in srgb, var(--orange) 90%, transparent);
        color: var(--accent-fg);
        box-shadow: inset 0 0 0 1px var(--accent-ring);
        font-size: 0.65rem;
        font-weight: 700;
        letter-spacing: 0.02em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        z-index: 2;
        -webkit-backdrop-filter: blur(2px);
        backdrop-filter: blur(2px);
      }
      .pe-ai-chip-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: currentColor;
        flex-shrink: 0;
        animation: pe-ai-chip-pulse 2s ease-in-out infinite;
      }
      @keyframes pe-ai-chip-pulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.4; }
      }

      /* Lightbox */
      .pe-lightbox {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.95);
        display: flex;
        align-items: center;
        justify-content: center;
        /* Must beat an open .pe-modal / .modal-bg (both at --z-overlay);
           toasts stay above at --z-toast. */
        z-index: var(--z-overlay-top,10001);
      }

      .pe-lightbox-content {
        width: 90%;
        max-width: 800px;
        max-height: 85vh;
        overflow: auto;
      }

      .pe-lightbox-image {
        width: 100%;
        height: auto;
        display: block;
        margin-bottom: 1rem;
      }

      .pe-lightbox-metadata {
        background: var(--s);
        padding: 1rem;
        border-radius: 0.5rem;
        color: var(--t);
      }

      .pe-metadata-row {
        display: flex;
        margin-bottom: 0.5rem;
        font-size: 0.9rem;
      }

      .pe-metadata-label {
        font-weight: 600;
        margin-right: 1rem;
        color: var(--m);
        min-width: 100px;
      }

      .pe-lightbox-nav {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        width: 100%;
        display: flex;
        justify-content: space-between;
        padding: 0 1rem;
        pointer-events: none;
      }

      .pe-nav-btn {
        pointer-events: all;
        width: 50px;
        height: 50px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.2);
        border: 2px solid white;
        color: white;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.5rem;
        transition: background var(--t-mid);
      }

      .pe-nav-btn:hover {
        background: rgba(255, 255, 255, 0.3);
      }

      /* Progress Bar */
      .pe-progress-container {
        width: 100%;
        height: 4px;
        background: var(--s2);
        border-radius: 2px;
        overflow: hidden;
        margin-bottom: 1rem;
      }

      .pe-progress-bar {
        height: 100%;
        background: var(--orange);
        width: 0%;
        transition: width 0.3s;
      }

      .pe-progress-text {
        font-size: 0.85rem;
        color: var(--m);
        text-align: center;
        margin-top: 0.5rem;
      }

      /* Category Groups */
      .pe-tag-category {
        margin-bottom: 1.5rem;
      }

      .pe-category-title {
        font-size: 0.8rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--m);
        margin-bottom: 0.75rem;
      }

      .pe-tag-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
      }

      /* Empty states now use the shared .nbd-empty pattern from
         dashboard-app.css (batch-2 consolidation) — the local
         .pe-empty-state/.pe-empty-icon rules were deleted with it. */

      /* Staging Badge */
      .pe-staged-badge {
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
        background: var(--orange);
        color: var(--accent-fg);
        width: 28px;
        height: 28px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 600;
        font-size: 0.8rem;
      }
    `;

    const styleEl = document.createElement('style');
    styleEl.id = 'photo-engine-styles';
    styleEl.textContent = styles;
    document.head.appendChild(styleEl);
  }

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  function generateId() {
    return Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  function formatDate(date) {
    if (date == null) return '—';
    // Accept Firestore Timestamps (createdAt/uploadedAt) as well as the
    // legacy numeric capturedAt epoch — quick-upload / annotation photos
    // have no capturedAt, so callers fall back to the Timestamp fields.
    if (typeof date === 'object') {
      if (typeof date.toDate === 'function') date = date.toDate();
      else if (typeof date.seconds === 'number') date = new Date(date.seconds * 1000);
    }
    if (typeof date === 'number') date = new Date(date);
    if (!(date instanceof Date) || isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  // Comparable epoch (ms) for sorting a photo by recency. Prefers the
  // canonical `createdAt` (Firestore Timestamp), then `uploadedAt`
  // (Timestamp), then the legacy numeric `capturedAt` epoch. Returns 0
  // when nothing usable is present so undated docs sort oldest.
  function photoEpoch(p) {
    const t = (p && (p.createdAt || p.uploadedAt || p.capturedAt)) || null;
    if (t == null) return 0;
    if (typeof t === 'number') return t;                       // capturedAt: Date.now() ms
    if (typeof t.toMillis === 'function') return t.toMillis(); // Firestore Timestamp
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    const d = new Date(t);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  function resizeImage(canvas, maxDimension, quality) {
    return new Promise((resolve) => {
      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;
      const scale = Math.min(1, maxDimension / Math.max(width, height));

      const newWidth = width * scale;
      const newHeight = height * scale;

      const resized = document.createElement('canvas');
      resized.width = newWidth;
      resized.height = newHeight;
      resized.getContext('2d').drawImage(canvas, 0, 0, newWidth, newHeight);

      resized.toBlob(resolve, 'image/jpeg', quality);
    });
  }

  function generateThumbnail(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          const size = 200;
          canvas.width = size;
          canvas.height = size;

          const scale = Math.max(size / img.width, size / img.height);
          const x = (size / 2) - (img.width / 2) * scale;
          const y = (size / 2) - (img.height / 2) * scale;
          ctx.drawImage(img, x, y, img.width * scale, img.height * scale);

          canvas.toBlob(resolve, 'image/jpeg', 0.8);
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(blob);
    });
  }

  // ============================================================================
  // FIELD CAPTURE CONTEXT — phase from the lead's stage, one GPS fix per
  // camera session, on-site check (2026-10-04)
  //
  // An audit found 0 After photos and 0 geolocated photos of 111: phase came
  // only from a tag the rep had to pick on every shot, and geoLocation was
  // hard-coded null. Now every shot is stamped at capture:
  //   phase      — from the lead's stage (before contract → Before, install
  //                in progress → During, install complete or later → After).
  //                A phase TAG the rep picks always wins (phaseSource 'tag').
  //   geoLocation— ONE reading per camera session, taken only when the camera
  //                opens (the browser asks permission once). Stored on the
  //                CRM photo doc only. Canvas captures carry no EXIF, and the
  //                public/portal copies never read these fields.
  //   onSite     — true when that reading is within ON_SITE_RADIUS_M of the
  //                lead's own lat/lng; false when it is clearly elsewhere;
  //                null when either side is unknown or the fix is too vague.
  // ============================================================================

  // A residential lot plus phone-GPS error: a 30 m fix at the curb of a deep
  // lot can sit 60 m from a geocoded rooftop. Wider than this starts calling
  // the neighbour's house "on-site".
  const ON_SITE_RADIUS_M = 75;
  // A fix vaguer than this (cell-tower / wifi-only) says nothing either way.
  const GEO_MAX_ACCURACY_M = 150;
  // How long a shot waits for the session's GPS fix before saving without it.
  const GEO_WAIT_MS = 1500;

  const _PHASE_DURING = ['install_in_progress', 'in_progress'];
  const _PHASE_AFTER = ['install_complete', 'final_photos', 'deductible_collected', 'final_payment',
    'collections', 'closed', 'warranty_claim', 'warranty_repaired', 'complete', 'closed_won'];
  const _PHASE_BEFORE = ['new', 'new_lead', 'contacted', 'inspected', 'claim_filed', 'adjuster_meeting_scheduled',
    'adjuster_inspection_done', 'scope_received', 'estimate_submitted', 'estimate_sent', 'supplement_requested',
    'supplement_approved', 'estimate_sent_cash', 'negotiating', 'prequal_sent', 'loan_approved', 'approved',
    'contract_signed', 'job_created', 'permit_pulled', 'materials_ordered', 'materials_delivered', 'crew_scheduled',
    'warranty_scheduled', 'service_quoted', 'service_approved', 'lost', 'closed_lost'];

  /**
   * Stage key (or legacy display name) → 'Before' | 'During' | 'After' | null.
   * Pure. A tenant's custom stage returns null: guessing a phase for a stage
   * we cannot place would put a wrong label on a homeowner report.
   */
  function phaseForStage(stage) {
    const k = String(stage == null ? '' : stage).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!k) return null;
    if (_PHASE_DURING.indexOf(k) !== -1) return 'During';
    if (_PHASE_AFTER.indexOf(k) !== -1) return 'After';
    if (_PHASE_BEFORE.indexOf(k) !== -1) return 'Before';
    return null;
  }

  /** The phase a rep's TAGS name, or null. Pure. */
  function phaseFromTags(tags) {
    const t = Array.isArray(tags) ? tags : [];
    if (t.includes('before')) return 'Before';
    if (t.includes('after')) return 'After';
    if (t.includes('during')) return 'During';
    return null;
  }

  /** Great-circle distance in metres. Pure. */
  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function _finiteLatLng(lat, lng) {
    const la = Number(lat), ln = Number(lng);
    if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') return null;
    if (!isFinite(la) || !isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
    if (la === 0 && ln === 0) return null;
    return { lat: la, lng: ln };
  }

  /**
   * true / false / null — see the section header. Pure.
   * @param geo  {lat,lng,accuracy}
   * @param lead {lat,lng}
   */
  function onSiteFor(geo, lead, radiusM) {
    const g = geo && _finiteLatLng(geo.lat, geo.lng);
    const l = lead && _finiteLatLng(lead.lat, lead.lng);
    if (!g || !l) return null;
    const acc = Number(geo.accuracy);
    if (isFinite(acc) && acc > GEO_MAX_ACCURACY_M) return null;
    return haversineMeters(g, l) <= (radiusM || ON_SITE_RADIUS_M);
  }

  /**
   * Everything a shot is stamped with besides the pixels, decided at capture
   * and carried through the offline queue unchanged. Pure.
   *   tags  — what the rep picked (a phase tag wins)
   *   stage — the lead's stage at capture
   *   geo   — the session fix, or null
   *   lead  — {lat,lng} for the on-site check
   */
  function captureContext(tags, stage, geo, lead) {
    const tagPhase = phaseFromTags(tags);
    const stagePhase = phaseForStage(stage);
    const g = geo && _finiteLatLng(geo.lat, geo.lng);
    const acc = g && isFinite(Number(geo.accuracy)) ? Math.round(Number(geo.accuracy)) : null;
    return {
      phase: tagPhase || stagePhase || null,
      phaseSource: tagPhase ? 'tag' : (stagePhase ? 'stage' : null),
      geo: g ? { lat: g.lat, lng: g.lng, accuracy: acc, at: (geo && geo.at) || null } : null,
      onSite: g ? onSiteFor(geo, lead) : null
    };
  }

  /** The lead behind a capture, from whatever the page already holds. */
  function _leadForCapture(leadId) {
    if (!leadId) return null;
    const cur = window._currentLead;
    if (cur && (cur.id === leadId || window._customerId === leadId)) return cur;
    const list = Array.isArray(window._leads) ? window._leads : [];
    return list.find((l) => l && l.id === leadId) || null;
  }

  function _stageOf(lead) {
    return lead ? (lead._stageKey || lead.stage || null) : null;
  }

  /**
   * One GPS reading for this camera session. Resolves to {lat,lng,accuracy,at}
   * or null (denied, unavailable, timed out). Never rejects. The browser shows
   * its own permission prompt the first time.
   */
  function _readSessionGeo() {
    return new Promise((resolve) => {
      try {
        if (typeof navigator === 'undefined' || !navigator.geolocation
          || typeof navigator.geolocation.getCurrentPosition !== 'function') { resolve(null); return; }
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const c = pos && pos.coords;
            resolve(c ? { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, at: Date.now() } : null);
          },
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
        );
      } catch (_) { resolve(null); }
    });
  }

  /** The session fix if it arrives within `ms`, else null. */
  function _geoWithin(promise, ms) {
    if (!promise) return Promise.resolve(null);
    return Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]);
  }

  // ============================================================================
  // CAMERA CAPTURE
  // ============================================================================

  async function openCamera(leadId) {
    state.currentLeadId = leadId;
    injectStyles();
    // Burst count for THIS camera session (the done sheet reports it).
    let burstShots = 0;
    // One GPS reading per camera session — asked for here, when the camera
    // opens, never per shot. The tag flow reopens the camera after each
    // save, so a reading younger than two minutes is reused instead of
    // asking again.
    if (!state.sessionGeoPromise || !state.sessionGeoAt || Date.now() - state.sessionGeoAt > 120000) {
      state.sessionGeoAt = Date.now();
      state.sessionGeoPromise = _readSessionGeo();
    }
    const geoPromise = state.sessionGeoPromise;

    const modal = document.createElement('div');
    modal.className = 'pe-modal';
    modal.id = 'photo-camera-modal';

    modal.innerHTML = `
      <div class="pe-cam-viewfinder">
        <video class="pe-cam-video" id="camera-video" playsinline autoplay muted></video>
        <div class="pe-cam-flash-overlay" id="cam-flash"></div>

        <!-- Top Bar -->
        <div class="pe-cam-topbar">
          <button class="pe-cam-back" id="cam-back-btn" title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <span class="pe-cam-title">NBD Camera</span>
          <div class="pe-cam-tools">
            <button class="pe-mode-badge" id="mode-btn" type="button" data-mode="${state.captureMode}" aria-label="Capture mode — tap to switch between burst and tag each shot">${state.captureMode === 'tag' ? 'Tag' : 'Burst'}</button>
            <button class="pe-preset-badge" id="preset-btn">${QUALITY_PRESETS[state.currentPreset].label.toUpperCase()}</button>
            <button class="pe-cam-tool" id="flash-btn" title="Flash">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            </button>
            <button class="pe-cam-tool" id="switch-camera-btn" title="Switch Camera">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v4h-4"/><path d="M4 17v-4h4"/><path d="M7.5 7a9 9 0 0112.6 2.5"/><path d="M16.5 17A9 9 0 013.9 14.5"/></svg>
            </button>
          </div>
        </div>

        <div class="pe-cam-hint" id="cam-hint" ${state.captureMode === 'burst' ? '' : 'hidden'}>Burst — shoot away, tag later in Photo Review</div>

        <!-- Bottom Controls -->
        <div class="pe-cam-bottom">
          <div class="pe-cam-counter" id="cam-counter" aria-live="polite">
            <span id="cam-count">${state.sessionPhotoCount}</span>
            <span class="pe-cam-counter-label">photos</span>
          </div>
          <button class="pe-cam-capture" id="capture-btn" title="Capture" aria-label="Take photo"></button>
          <div id="cam-thumb-slot">${state.lastThumbUrl ? `<img class="pe-cam-thumb" src="${state.lastThumbUrl}" alt="Last">` : '<div class="pe-cam-thumb-empty"></div>'}</div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const video = modal.querySelector('#camera-video');
    const captureBtn = modal.querySelector('#capture-btn');
    const switchCameraBtn = modal.querySelector('#switch-camera-btn');
    const flashBtn = modal.querySelector('#flash-btn');
    const presetBtn = modal.querySelector('#preset-btn');
    const backBtn = modal.querySelector('#cam-back-btn');

    let facingMode = 'environment';
    let imageCapture = null;
    let torch = false;

    const modeBtn = modal.querySelector('#mode-btn');

    // Back button closes camera. After a burst it says what happened and
    // offers the one next step — tagging, in Photo Review.
    backBtn.onclick = () => {
      if (state.cameraStream) state.cameraStream.getTracks().forEach(t => t.stop());
      modal.remove();
      if (burstShots > 0) _showBurstDone(leadId, burstShots);
    };

    // Burst ⇄ tag-each-shot. Remembered for next time.
    modeBtn.onclick = () => {
      state.captureMode = state.captureMode === 'burst' ? 'tag' : 'burst';
      try { localStorage.setItem('photoEngineCaptureMode', state.captureMode); } catch (_) {}
      modeBtn.dataset.mode = state.captureMode;
      modeBtn.textContent = state.captureMode === 'tag' ? 'Tag' : 'Burst';
      const hint = modal.querySelector('#cam-hint');
      if (hint) hint.hidden = state.captureMode !== 'burst';
    };

    // Start camera
    try {
      const constraints = {
        video: {
          facingMode: facingMode,
          width: { ideal: 1920 },
          height: { ideal: 1440 }
        },
        audio: false
      };

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (highRes) {
        // Older iPhones throw OverconstrainedError on 1920x1440. Retry
        // without resolution hints before giving up — the device picks
        // whatever it can deliver.
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: false });
        } catch (anyRes) {
          throw anyRes;
        }
      }
      state.cameraStream = stream;
      video.srcObject = stream;

      // Check for flash capability (Safari doesn't support ImageCapture API)
      const videoTrack = stream.getVideoTracks()[0];
      try {
        const capabilities = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
        if (!capabilities.torch) {
          flashBtn.style.opacity = '0.3';
          flashBtn.disabled = true;
        }
      } catch(e) {
        flashBtn.style.opacity = '0.3';
        flashBtn.disabled = true;
      }
    } catch (err) {
      // getUserMedia denied or unsupported — fall back to the iOS file
      // chooser with capture=environment so the user still gets a path
      // to take/select a photo instead of seeing the modal vanish.
      modal.remove();
      const fallback = document.createElement('input');
      fallback.type = 'file';
      fallback.accept = 'image/*,.heic,.heif,.avif';
      fallback.capture = 'environment';
      fallback.multiple = true;
      fallback.onchange = async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        // Audit 2026-08-02 (silent-failure class): the old handler tried
        // window.handlePhotoFiles — defined NOWHERE in the repo — then a bare
        // handleFileSelect that only exists on customer.html, while this
        // bundle loads on the dashboard. Net effect: every picked file was
        // silently dropped. Upload directly (File extends Blob; tags can be
        // edited in the gallery afterwards) and ALWAYS say what happened.
        let uploaded = 0, failedCount = 0;
        for (const file of files) {
          try {
            await uploadPhotoToFirebase(file, leadId, [], '', '');
            uploaded++;
          } catch (err) {
            failedCount++;
            console.error('[photo-engine] fallback upload failed:', err);
          }
        }
        if (failedCount && !uploaded) {
          showToast('Could not save the selected photos', 'error');
        } else if (failedCount) {
          showToast(`${uploaded} photo${uploaded === 1 ? '' : 's'} uploaded, ${failedCount} failed`, 'warning');
        } else {
          showToast(`${uploaded} photo${uploaded === 1 ? '' : 's'} uploaded`, 'success');
        }
      };
      fallback.click();
      showToast('Camera unavailable — using file picker', 'warning');
      return;
    }

    // Switch camera
    switchCameraBtn.onclick = async () => {
      facingMode = facingMode === 'environment' ? 'user' : 'environment';
      if (state.cameraStream) {
        state.cameraStream.getTracks().forEach(t => t.stop());
      }

      try {
        const constraints = {
          video: {
            facingMode: facingMode,
            width: { ideal: 1920 },
            height: { ideal: 1440 }
          },
          audio: false
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        state.cameraStream = stream;
        video.srcObject = stream;

        const videoTrack = stream.getVideoTracks()[0];
      } catch (err) {
        showToast('Could not switch camera', 'error');
      }
    };

    // Flash toggle (works without ImageCapture API)
    flashBtn.onclick = async () => {
      if (flashBtn.disabled) return;
      torch = !torch;
      try {
        const track = state.cameraStream.getVideoTracks()[0];
        await track.applyConstraints({ advanced: [{ torch: torch }] });
        flashBtn.classList.toggle('active', torch);
      } catch (err) {
        flashBtn.disabled = true;
        flashBtn.style.opacity = '0.3';
        showToast('Flash not available on this device', 'warning');
      }
    };

    // Preset selector
    presetBtn.onclick = () => {
      const presetKeys = Object.keys(QUALITY_PRESETS);
      const current = presetKeys.indexOf(state.currentPreset);
      const next = (current + 1) % presetKeys.length;
      state.currentPreset = presetKeys[next];
      localStorage.setItem('photoEnginePreset', state.currentPreset);
      presetBtn.textContent = QUALITY_PRESETS[state.currentPreset].label.toUpperCase();
    };

    // Capture photo
    captureBtn.onclick = async () => {
      try {
        // Flash effect
        const flashEl = modal.querySelector('#cam-flash');
        flashEl.classList.remove('flash');
        void flashEl.offsetWidth; // force reflow
        flashEl.classList.add('flash');

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);

        const preset = QUALITY_PRESETS[state.currentPreset];
        const blob = await resizeImage(canvas, preset.maxDimension, preset.jpegQuality);

        // Update thumbnail
        const thumbUrl = URL.createObjectURL(blob);
        if (state.lastThumbUrl && state.captureMode === 'burst') {
          try { URL.revokeObjectURL(state.lastThumbUrl); } catch (_) {}
        }
        state.lastThumbUrl = thumbUrl;
        const thumbSlot = modal.querySelector('#cam-thumb-slot');
        if (thumbSlot) thumbSlot.innerHTML = `<img class="pe-cam-thumb" src="${thumbUrl}" alt="Last">`;

        if (state.captureMode === 'burst') {
          // Shutter only: the camera stays open. The count and thumbnail
          // move now; the save runs behind the next shot.
          burstShots++;
          state.sessionPhotoCount++;
          const countEl = modal.querySelector('#cam-count');
          if (countEl) countEl.textContent = String(state.sessionPhotoCount);
          const counter = modal.querySelector('#cam-counter');
          if (counter) { counter.classList.remove('pe-bump'); void counter.offsetWidth; counter.classList.add('pe-bump'); }
          _saveBurstShot(blob, leadId, geoPromise);
          return;
        }

        // Stop camera
        state.cameraStream.getTracks().forEach(t => t.stop());
        modal.remove();

        // Show preview with "Save & Next" flow
        showPreview(blob, leadId, geoPromise);
      } catch (err) {
        showToast('Failed to capture photo', 'error');
        console.error(err);
      }
    };
  }

  // ============================================================================
  // PREVIEW & TAGGING
  // ============================================================================

  async function showPreview(blob, leadId, geoPromise) {
    const modal = document.createElement('div');
    modal.className = 'pe-modal';
    modal.id = 'photo-preview-modal';

    const QUICK_LOCATIONS = ['Front Slope', 'Back Slope', 'Left Slope', 'Right Slope', 'Ridge', 'Valley', 'Eave', 'Gutter', 'Chimney', 'Interior'];
    const QUICK_DAMAGE = ['Hail', 'Wind', 'Impact', 'Wear', 'Leak', 'Missing Shingles', 'Lifted', 'Cracked', 'Granule Loss', 'Flashing'];
    const QUICK_TYPE = ['Before', 'During', 'After', 'Close-Up', 'Overview', 'Measurement'];

    const reader = new FileReader();
    reader.onload = (e) => {
      const imageData = e.target.result;

      modal.innerHTML = `
        <div class="pe-modal-header">
          <button class="pe-modal-back" data-action="peRemove" data-target="photo-preview-modal">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <div class="pe-modal-title">Review & Tag</div>
        </div>
        <div class="pe-preview-container">
          <img class="pe-preview-image" src="${imageData}" alt="Preview" />

          <div class="pe-section">
            <div class="pe-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="10" r="3"/><path d="M12 21.7C17.3 17 20 13 20 10a8 8 0 10-16 0c0 3 2.7 7 8 11.7z"/></svg>
              Location
            </div>
            <div class="pe-pill-scroll" id="location-pills">
              ${QUICK_LOCATIONS.map(loc => `<button class="pe-tag-pill cat-location" data-tag="${loc.toLowerCase().replace(/ /g,'_')}" data-action="peTagToggle">${loc}</button>`).join('')}
            </div>
          </div>

          <div class="pe-section">
            <div class="pe-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              Damage Type
            </div>
            <div class="pe-pill-scroll" id="damage-pills">
              ${QUICK_DAMAGE.map(d => `<button class="pe-tag-pill cat-damage" data-tag="${d.toLowerCase().replace(/ /g,'_')}" data-action="peTagToggle">${d}</button>`).join('')}
            </div>
          </div>

          <div class="pe-section">
            <div class="pe-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
              Photo Type
            </div>
            <div class="pe-pill-scroll" id="type-pills">
              ${QUICK_TYPE.map(t => `<button class="pe-tag-pill cat-type" data-tag="${t.toLowerCase().replace(/ /g,'_').replace(/-/g,'_')}" data-action="peTagToggle">${t}</button>`).join('')}
            </div>
          </div>

          <div class="pe-section">
            <div class="pe-section-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Notes
            </div>
            <textarea class="pe-textarea" id="photo-description" placeholder="Optional — add notes about this photo..."></textarea>
          </div>

          <div class="pe-button-group">
            <button class="pe-btn pe-btn-secondary" data-action="peRemove" data-target="photo-preview-modal">Retake</button>
            <button class="pe-btn pe-btn-primary" id="save-next-btn">Save & Next</button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Handle Save & Next
      const saveBtn = modal.querySelector('#save-next-btn');
      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = 'SAVING...';

        const selectedTags = Array.from(modal.querySelectorAll('.pe-tag-pill.selected'))
          .map(el => el.dataset.tag);
        const description = modal.querySelector('#photo-description').value;

        // Extract location from selected location pills
        const locationTags = Array.from(modal.querySelectorAll('#location-pills .pe-tag-pill.selected'))
          .map(el => el.textContent.trim());
        const location = locationTags.join(', ');

        const reopen = () => setTimeout(() => openCamera(leadId), 300);
        const abandon = (msg) => {
          showToast(msg, 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = 'SAVE & NEXT';
        };

        // ── 1. Refuse what can never be uploaded ───────────────────────────
        // A missing customer or an uninitialised Firebase makes
        // uploadPhotoToFirebase throw before any network call, every time.
        // Queueing one of those would toast "held", then drop it as
        // unrecoverable on the next drain — success reported, photo gone.
        const preflight = _uploadPreflightError(leadId);
        if (preflight) { abandon(preflight.message); return; }

        // ── 2. Persist BEFORE attempting the network ──────────────────────
        // The queue used to be written only from the catch below, i.e. only
        // after uploadPhotoToFirebase rejected — and Firebase Storage retries
        // a failed upload until `maxUploadRetryTime`, which defaults to TEN
        // MINUTES and is set nowhere in this repo. So on a roof with no
        // signal the photo sat in a local variable behind a "SAVING..."
        // button for ten minutes before it was durable, and a bfcache resume
        // in that window (dashboard-sw-bootstrap.js reloads on every one)
        // destroyed it. Writing to IndexedDB first costs milliseconds and
        // makes the retry budget irrelevant.
        // The photo's identity, fixed here and never recomputed. It is
        // persisted with the row AND used for this first attempt, so the
        // attempt and every later retry address the same Storage objects and
        // the same Firestore document.
        const _lead = _leadForCapture(leadId);
        const shot = {
          uploadId: generateId(),
          capturedAt: Date.now(),
          preset: state.currentPreset,
          // Phase (a picked phase tag wins over the stage), the session GPS
          // fix and the on-site check — pinned now, carried by the queue.
          capture: captureContext(selectedTags, _stageOf(_lead), await _geoWithin(geoPromise, GEO_WAIT_MS), _lead)
        };

        let outcome = null;
        try {
          outcome = await enqueueForRetry({
            blob,
            dataUrl: imageData,
            leadId,
            tags: selectedTags,
            description,
            location,
            timestamp: shot.capturedAt,
            uploadId: shot.uploadId,
            preset: shot.preset,
            capture: shot.capture
          });
        } catch (queueErr) {
          console.warn('[PhotoEngine] enqueue threw:', queueErr && queueErr.message);
        }

        if (outcome && outcome.queued === false) {
          // Storage is full. Telling the rep to keep shooting into a queue
          // that cannot accept anything is worse than stopping them.
          abandon(outcome.message);
          return;
        }

        const entry = outcome && outcome.entry;
        // Claim it so a concurrent drain (an `online` event, or boot
        // recovery) cannot upload the same row while this attempt is live.
        if (entry) _inFlight.add(_inFlightKey(entry));

        const attempt = uploadPhotoToFirebase(blob, leadId, selectedTags, description, location, shot)
          .then(async () => { if (entry) await _dropItem(entry); return true; })
          .catch((e) => {
            // Leave it queued for the drain; just release the claim.
            if (entry) _inFlight.delete(_inFlightKey(entry));
            console.warn('[PhotoEngine] upload failed, photo stays queued:', e && e.message);
            return false;
          });

        // ── 3. Never make the rep wait out the retry budget ───────────────
        if (!entry) {
          // Nothing holds this photo but the pending attempt, so its result
          // is the only honest thing to report — wait for it.
          if (await attempt) {
            state.sessionPhotoCount++;
            modal.remove();
            showToast(`Photo ${state.sessionPhotoCount} saved`, 'success');
            reopen();
          } else {
            abandon('Save failed — please retry');
          }
          return;
        }

        const settled = await Promise.race([
          attempt,
          new Promise((r) => setTimeout(() => r('pending'), SAVE_CONFIRM_MS))
        ]);

        state.sessionPhotoCount++;
        modal.remove();

        if (settled === true) {
          showToast(`Photo ${state.sessionPhotoCount} saved`, 'success');
          // A successful upload is the best available evidence that signal is
          // back — better than waiting for an `online` event that may never
          // fire on a flaky LTE connection that never fully dropped.
          flushUploadQueue();
        } else if (outcome.durable) {
          // True whether the attempt failed or is merely still going: the
          // photo is committed to IndexedDB and a later drain will send it.
          showToast('Photo held — it will upload when you\'re back online, even if you close the app.', 'success');
        } else {
          // Storage refused it (private mode, disabled IDB, a dead object
          // store). We still retry from memory, so the photo is not lost
          // *yet* — but leaving the page ends it. Under-promise, exactly as
          // before persistence existed.
          showToast('Photo held — retrying when you\'re back online. Keep this page open.', 'warning');
        }
        reopen();
      };
    };

    reader.readAsDataURL(blob);
  }

  // ============================================================================
  // BURST SAVE (2026-10-04)
  //
  // The tag sheet after every shot (26 tags) closed the camera and restarted
  // it — on a roof, that is the difference between shooting the slope and
  // not. Burst keeps the camera open: each shot goes straight into the same
  // durable IndexedDB queue Save & Next uses (enqueue BEFORE any network),
  // stamped with phase / GPS / on-site, and the queue drains one photo at a
  // time behind the shutter. Tagging moves to Photo Review afterwards.
  // ============================================================================

  // Warn once per page that photos are held in memory only.
  let _burstMemoryWarned = false;

  async function _saveBurstShot(blob, leadId, geoPromise) {
    const preflight = _uploadPreflightError(leadId);
    if (preflight) { showToast(preflight.message, 'error'); return { queued: false }; }
    const lead = _leadForCapture(leadId);
    const shot = {
      uploadId: generateId(),
      capturedAt: Date.now(),
      preset: state.currentPreset,
      capture: captureContext([], _stageOf(lead), await _geoWithin(geoPromise, GEO_WAIT_MS), lead)
    };
    let outcome = null;
    try {
      outcome = await enqueueForRetry({
        blob, leadId, tags: [], description: '', location: '',
        timestamp: shot.capturedAt, uploadId: shot.uploadId, preset: shot.preset,
        capture: shot.capture
      });
    } catch (e) {
      console.warn('[PhotoEngine] burst enqueue threw:', e && e.message);
    }
    if (outcome && outcome.queued === false) {
      // Storage full: say so on every shot — the rep must stop shooting.
      showToast(outcome.message, 'error');
      return outcome;
    }
    if (!outcome) {
      // Nothing could hold it: upload now, and say so if that fails.
      try {
        await uploadPhotoToFirebase(blob, leadId, [], '', '', shot);
        return { queued: false, uploaded: true };
      } catch (e) {
        showToast('That photo could not be saved — take it again', 'error');
        return { queued: false };
      }
    }
    if (!outcome.durable && !_burstMemoryWarned) {
      _burstMemoryWarned = true;
      showToast('Photos are held in memory only — keep this page open until they upload.', 'warning');
    }
    _kickDrain();
    return outcome;
  }

  // Drain behind the shutter. One drain at a time (flushUploadQueue is
  // single-flight); a shot taken mid-drain asks for one more pass.
  let _drainAgain = false;
  function _kickDrain() {
    if (_draining) { _drainAgain = true; return; }
    flushUploadQueue({ quiet: true });
  }

  function _photoReviewUrl(leadId) {
    try {
      if (window.NBDUrl && typeof window.NBDUrl.photoReview === 'function') return window.NBDUrl.photoReview(leadId);
    } catch (_) {}
    return '/pro/photo-review.html?id=' + encodeURIComponent(leadId);
  }

  function _showBurstDone(leadId, count) {
    const old = document.getElementById('pe-burst-done');
    if (old) old.remove();
    const sheet = document.createElement('div');
    sheet.className = 'pe-burst-done';
    sheet.id = 'pe-burst-done';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Photos saved');
    sheet.innerHTML =
      '<div class="pe-burst-done-title"></div>' +
      '<div class="pe-burst-done-sub">They upload on their own, even with no signal. Tag them now in Photo Review, or any time later.</div>' +
      '<div class="pe-burst-done-row">' +
        '<button type="button" class="pe-btn pe-btn-secondary" data-burst="later">Later</button>' +
        '<a class="pe-btn pe-btn-primary" data-burst="review"></a>' +
      '</div>';
    sheet.querySelector('.pe-burst-done-title').textContent =
      count + ' photo' + (count === 1 ? '' : 's') + ' saved';
    const link = sheet.querySelector('[data-burst="review"]');
    link.textContent = 'Tag in Photo Review';
    link.href = _photoReviewUrl(leadId);
    sheet.querySelector('[data-burst="later"]').addEventListener('click', () => sheet.remove());
    document.body.appendChild(sheet);
    return sheet;
  }

  // ============================================================================
  // PHOTO-EDITOR SAVES THROUGH THE SAME QUEUE (2026-10-04)
  //
  // photo-editor.js wrote straight to Storage + Firestore with no queue: a
  // save on a roof with no signal hung on "Saving", and a reload lost the
  // annotations outright. Editor saves now ride the durable upload queue
  // exactly like camera shots — persisted first, attempted once in the
  // foreground, drained later by flushUploadQueue (which recognises the row
  // by capture.edit and hands it to _applyQueuedEdit).
  //
  //   mode 'meta' — tags / notes / annotations only (no image; the row holds
  //                 an empty placeholder blob because the store needs one)
  //   mode 'over' — flattened image replaces the photo (url + storagePath)
  //   mode 'copy' — flattened image saved as a NEW photo doc. Its doc id and
  //                 filename are pinned at enqueue, so a retry overwrites the
  //                 same objects instead of minting a second copy.
  // ============================================================================

  function _cleanMeta(meta) {
    // Structured-clone + Firestore safe: plain JSON only (no sentinels).
    try { return JSON.parse(JSON.stringify(meta || {})); } catch (_) { return {}; }
  }

  /**
   * Apply one queued editor save. Throws on failure so the drain stops and
   * keeps the row (same contract as uploadPhotoToFirebase).
   */
  async function _applyQueuedEdit(blob, item) {
    const edit = (item && item.capture && item.capture.edit) || {};
    const uid = item.uid || _currentUid();
    if (!uid) throw new Error('Not signed in');
    if (!window._db) throw new Error('Firebase not initialized');
    const { doc, setDoc, updateDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const meta = _cleanMeta(edit.meta);
    if (edit.mode === 'meta') {
      if (!edit.photoId) throw Object.assign(new Error('No photo id'), { retryable: false });
      await updateDoc(doc(window._db, 'photos', edit.photoId), meta);
      return true;
    }
    if (!window._storage) throw new Error('Firebase not initialized');
    const { ref, uploadBytes, getDownloadURL } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js'
    );
    const leadSegment = item.leadId ? (item.leadId + '/') : '';
    const fileName = edit.mode === 'over' ? `photo_${edit.photoId}.jpg` : `photo_${edit.copyId}.jpg`;
    // storagePath mirrors the upload key so the image pipeline can find this
    // doc by equality and stamp fresh `urls` variants for the new pixels.
    const storagePath = `photos/${uid}/${leadSegment}${fileName}`;
    const sref = ref(window._storage, storagePath);
    await uploadBytes(sref, blob);
    const url = await getDownloadURL(sref);
    const stamped = Object.assign({}, meta, { isAnnotated: true, annotatedAt: serverTimestamp() });
    if (edit.mode === 'over') {
      const patch = Object.assign({ url, storagePath }, stamped);
      if (edit.originalUrl && edit.originalStoragePath) {
        patch.originalUrl = edit.originalUrl;
        patch.originalStoragePath = edit.originalStoragePath;
      }
      await updateDoc(doc(window._db, 'photos', edit.photoId), patch);
    } else {
      await setDoc(doc(window._db, 'photos', edit.copyId), Object.assign({
        url, storagePath,
        originalPhotoId: edit.photoId || null,
        leadId: item.leadId || null,
        userId: uid,
        companyId: edit.companyId || uid,
        createdAt: serverTimestamp()
      }, stamped), { merge: true });
    }
    return true;
  }

  /**
   * Queue an editor save, then try it once in the foreground.
   * @returns {Promise<{status:'saved'|'held'|'held-memory'|'refused', message?:string}>}
   *   saved       — reached the server
   *   held        — durable on this device, will upload later
   *   held-memory — memory only (IndexedDB refused) — keep the page open
   *   refused     — the queue is full / device out of space (message says so)
   */
  async function enqueueEdit(opts) {
    const o = opts || {};
    const mode = o.mode === 'over' || o.mode === 'copy' ? o.mode : 'meta';
    const leadId = o.leadId;
    const pre = _uploadPreflightError(leadId);
    if (pre) return { status: 'refused', message: pre.message };
    const blob = mode === 'meta' ? new Blob([], { type: 'application/octet-stream' }) : o.blob;
    if (!blob) return { status: 'refused', message: 'Nothing to save' };
    const edit = {
      mode,
      photoId: o.photoId || null,
      copyId: mode === 'copy' ? ('ann_' + generateId()) : null,
      meta: _cleanMeta(o.meta),
      companyId: (window._userClaims && window._userClaims.companyId) || null,
      originalUrl: o.originalUrl || null,
      originalStoragePath: o.originalStoragePath || null
    };
    const timestamp = Date.now();
    let outcome = null;
    try {
      outcome = await enqueueForRetry({
        blob, leadId,
        tags: Array.isArray(edit.meta.tags) ? edit.meta.tags : [],
        description: '', location: '',
        timestamp,
        uploadId: 'edit_' + generateId(),
        preset: null,
        capture: { edit }
      });
    } catch (e) {
      console.warn('[PhotoEngine] edit enqueue threw:', e && e.message);
    }
    if (outcome && outcome.queued === false) return { status: 'refused', message: outcome.message };
    const entry = outcome && outcome.entry;
    if (entry) _inFlight.add(_inFlightKey(entry));
    const fakeItem = { uid: _currentUid(), leadId, capture: { edit } };
    const attempt = _applyQueuedEdit(blob, entry || fakeItem)
      .then(async () => { if (entry) await _dropItem(entry); return true; })
      .catch((e) => {
        if (entry) _inFlight.delete(_inFlightKey(entry));
        console.warn('[PhotoEngine] edit save failed, stays queued:', e && e.message);
        return false;
      });
    if (!entry) return (await attempt) ? { status: 'saved' } : { status: 'refused', message: 'Save failed — check your connection and try again' };
    const settled = await Promise.race([
      attempt,
      new Promise((r) => setTimeout(() => r('pending'), (o.waitMs != null ? o.waitMs : SAVE_CONFIRM_MS)))
    ]);
    if (settled === true) return { status: 'saved' };
    return { status: outcome.durable ? 'held' : 'held-memory' };
  }

  // ============================================================================
  // FIREBASE UPLOAD
  // ============================================================================

  // B.1 — Lazy-load the Functions SDK + call analyzePhotoVision in the
  // background. Same pattern as billing-gate.js so we don't ship the
  // functions SDK unless the rep actually uploads a photo. All errors
  // swallowed — auto-tag is a "nice to have", upload itself must
  // succeed regardless.
  let _httpsCallableAnalyze = null;
  async function _getAnalyzePhotoVision(){
    if (_httpsCallableAnalyze) return _httpsCallableAnalyze;
    try {
      if (window._functions && window._httpsCallable) {
        _httpsCallableAnalyze = window._httpsCallable(window._functions, 'analyzePhotoVision');
        return _httpsCallableAnalyze;
      }
      const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
      window._functions     = window._functions     || mod.getFunctions();
      window._httpsCallable = window._httpsCallable || mod.httpsCallable;
      _httpsCallableAnalyze = window._httpsCallable(window._functions, 'analyzePhotoVision');
      return _httpsCallableAnalyze;
    } catch (e) {
      console.warn('[PhotoEngine] AI auto-tag SDK load failed:', e && e.message);
      return null;
    }
  }
  // ──────────────────────────────────────────────────────────────────
  // MARK: AI auto-tag (Haiku classifier, per-upload, USD-capped server-side)
  // ──────────────────────────────────────────────────────────────────
  function _autoTagPhotoBackground(photoId){
    if (!photoId) return;
    // Fire and forget. The server writes aiSuggestion back to the photo
    // doc on success; renderGalleryGrid() reads it from the cache on
    // next render. Failure (cap hit, API timeout, etc.) is silent.
    Promise.resolve()
      .then(_getAnalyzePhotoVision)
      .then(fn => fn ? fn({ photoId }) : null)
      .catch(e => console.warn('[PhotoEngine] AI auto-tag failed:', e && e.message));
  }

  // ============================================================================
  // OFFLINE UPLOAD QUEUE — persist + drain
  //
  // History, because the shape of this code is a direct response to it:
  // state.uploadQueue was pushed to on every failed upload, under a toast
  // promising the photo would be sent once connectivity returned, and then
  // READ BY NOTHING — never drained, never retried, never persisted. Draining
  // landed first. It fixed the retry but not the loss: the queue was memory
  // only, and dashboard-sw-bootstrap.js reloads the page on every `pageshow`
  // with event.persisted — every iOS bfcache resume, i.e. exactly when a rep
  // backgrounds the app on a roof. So the toast had to under-promise ("Keep
  // this page open") because nothing else was true.
  //
  // Now the queue is backed by NBDPhotoQueueStore (IndexedDB, photo-sized
  // caps, see photo-queue-store.js) and it survives the reload. The store is
  // the source of truth; state.uploadQueue is a mirror kept for the sync
  // queuedPhotoCount() reader and for the degraded path where IndexedDB is
  // unavailable at all.
  //
  // Drain triggers: `online`, after any successful upload (a working upload
  // is better evidence of connectivity than an event that may never fire on
  // flaky LTE), and on boot via photo-queue-recovery.js.
  //
  // NOTE ON ORDERING — nothing is spliced out of the queue up front any more.
  // The previous drain took the whole batch into a local array and re-queued
  // only the item that threw, so a five-photo queue failing at #3 destroyed
  // #4 and #5 with it, silently. Here items leave storage one at a time and
  // only after a confirmed upload, so a mid-drain failure leaves the failing
  // photo and everything behind it exactly where they were.
  let _draining = false;

  // Queue entries the FOREGROUND capture path is uploading right now. The
  // capture flow enqueues BEFORE its first upload attempt (see the Save & Next
  // handler), so for the duration of that attempt a row exists in storage
  // that a drain must not also pick up — that would upload the photo twice.
  // Holds durable ids and, for memory-only entries, the entry object itself.
  // Page-local by design: after a reload the foreground attempt is dead and
  // the row is exactly what the boot drain should retry.
  const _inFlight = new Set();

  // How long the capture flow waits for an upload to confirm before telling
  // the rep the photo is held and handing the camera back. The photo is
  // already durable by then, so this only decides which true sentence to
  // show; the attempt continues in the background either way.
  const SAVE_CONFIRM_MS = 10000;

  function _dataUrlToBlob(dataUrl) {
    const [head, b64] = String(dataUrl || '').split(',');
    if (!b64) return null;
    const mime = (/data:([^;]+)/.exec(head) || [])[1] || 'image/jpeg';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function _store() {
    return (typeof window !== 'undefined' && window.NBDPhotoQueueStore) || null;
  }

  function _currentUid() {
    const u = typeof window !== 'undefined' && window._user;
    return (u && typeof u.uid === 'string' && u.uid) ? u.uid : null;
  }

  function _inFlightKey(entry) {
    return entry && entry.id != null ? entry.id : entry;
  }

  /**
   * A stable upload identity for a row queued before `uploadId` was stored.
   * Must be unique across devices AND users, because it becomes a Firestore
   * document id — a bare autoIncrement row id would collide between reps on
   * the first photo each ever queued.
   */
  function _legacyUploadId(item) {
    if (!item || item.id == null) return null;   // memory-only: no stable id
    const uid = item.uid || _currentUid() || 'anon';
    return 'q_' + uid + '_' + item.id + '_' + (item.timestamp || 0);
  }

  /**
   * Put a photo somewhere it can be retried from, preferring durable
   * storage. Returns what actually happened, so the caller's toast describes
   * reality, plus the queue `entry` so the caller can mark it in flight and
   * drop it on a confirmed upload:
   *   { durable: true,  queued: true,  entry } — committed to IndexedDB
   *   { durable: false, queued: true,  entry } — memory only, dies with the page
   *   { queued: false, message }               — refused outright (queue full)
   *
   * Every entry carries the capturing user's uid; the drain uploads only the
   * signed-in user's entries (see _pendingItems).
   */
  async function enqueueForRetry(item) {
    const store = _store();
    const uid = item.uid || _currentUid();
    if (store) {
      try {
        const id = await store.add(Object.assign({}, item, { uid }));
        const entry = {
          id,
          uid,
          blob: item.blob,
          leadId: item.leadId,
          tags: item.tags || [],
          description: item.description || '',
          location: item.location || '',
          timestamp: item.timestamp,
          uploadId: item.uploadId || null,
          preset: item.preset || null,
          // Phase / GPS / on-site, pinned at capture (captureContext).
          capture: item.capture || null
        };
        state.uploadQueue.push(entry);
        return { durable: true, queued: true, entry };
      } catch (e) {
        if (e && e.reason === 'queue-full') {
          return {
            durable: false,
            queued: false,
            message: 'Offline photo storage is full (' + store.MAX_ITEMS
              + ' photos). Reconnect to upload before taking more.'
          };
        }
        if (e && e.reason === 'quota') {
          return {
            durable: false,
            queued: false,
            message: 'Your device is out of storage. Reconnect to upload the photos already held.'
          };
        }
        // 'unavailable' / 'bad-item' / 'write-failed' — fall through to the
        // memory queue rather than dropping the photo on the floor.
        console.warn('[PhotoEngine] durable queue unavailable:', e && e.message);
      }
    }

    const entry = {
      dataUrl: item.dataUrl,
      blob: item.blob,
      uid,
      leadId: item.leadId,
      tags: item.tags || [],
      description: item.description || '',
      location: item.location || '',
      timestamp: item.timestamp,
      uploadId: item.uploadId || null,
      preset: item.preset || null,
      // Phase / GPS / on-site, pinned at capture (captureContext).
      capture: item.capture || null
    };
    state.uploadQueue.push(entry);
    return { durable: false, queued: true, entry };
  }

  /**
   * Queued items to attempt, oldest first: the signed-in user's durable rows
   * from storage, followed by any memory-only entries (the ones storage
   * refused, which still have to drain while this page lives — an earlier
   * version read storage OR the array and left those to rot). Entries the
   * foreground capture path is uploading right now are skipped. Memory
   * entries are returned by reference so _dropItem's indexOf branch works.
   */
  async function _pendingItems() {
    const uid = _currentUid();
    const store = _store();
    let durable = [];
    if (store) {
      try {
        if (await store.available()) durable = await store.all();
      } catch (e) {
        console.warn('[PhotoEngine] could not read durable queue:', e && e.message);
      }
    }
    // Only this user's rows. On a shared device another rep may have signed
    // out with photos still held; they wait for that rep, they are not
    // uploaded under this account.
    durable = durable.filter((r) => r && r.uid === uid && !_inFlight.has(r.id));
    const memOnly = (state.uploadQueue || []).filter((x) =>
      x && x.id == null && x.uid === uid && !_inFlight.has(x));
    return durable.concat(memOnly);
  }

  /** Remove a drained (or unrecoverable) item from storage and the mirror. */
  async function _dropItem(item) {
    const store = _store();
    if (store && item && item.id != null) {
      try { await store.remove(item.id); }
      catch (e) { console.warn('[PhotoEngine] could not drop queued photo:', e && e.message); }
    }
    _inFlight.delete(_inFlightKey(item));
    const q = state.uploadQueue || [];
    const idx = item && item.id != null
      ? q.findIndex((x) => x && x.id === item.id)
      : q.indexOf(item);
    if (idx !== -1) q.splice(idx, 1);
  }

  /**
   * Rebuild the in-memory mirror from storage (boot, and after a drain),
   * keeping any memory-only entries — they exist nowhere else.
   */
  async function _syncMirror() {
    const store = _store();
    if (!store) return;
    // Same synchronous shortcut photo-queue-recovery.js takes: when the
    // counter positively says the queue was empty, the mirror is already
    // correct and opening IndexedDB would tell us nothing.
    if (typeof store.lastKnownCount === 'function' && store.lastKnownCount() === 0) return;
    try {
      if (!(await store.available())) return;
      const rows = await store.all();
      const memOnly = (state.uploadQueue || []).filter((x) => x && x.id == null);
      state.uploadQueue = rows.concat(memOnly);
    } catch (e) {
      console.warn('[PhotoEngine] mirror sync failed:', e && e.message);
    }
  }

  async function flushUploadQueue(opts) {
    // quiet: the burst camera's own drain — no "N queued photos uploaded"
    // toast over the viewfinder after every shot.
    const quiet = !!(opts && opts.quiet);
    if (_draining) return 0;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0;
    _draining = true;
    _drainAgain = false;
    let sent = 0;
    let stalled = false;
    // Rows that LEFT the queue, uploaded or dropped. `sent` alone is the wrong
    // trigger for the marker sync below: an unrecoverable row is dropped
    // without ever being sent, so a drain can empty the queue entirely with
    // `sent === 0`. See the sync block at the end.
    let removed = 0;
    try {
      const items = await _pendingItems();
      for (const item of items) {
        // Decode outside the retry path. A truncated data URL passes the
        // `!b64` check and then makes atob throw; a throw landing in the
        // catch below would leave the item first in line on every future
        // drain, failing identically and blocking every healthy photo behind
        // it forever. A photo we cannot decode is unrecoverable — drop it.
        let blob = item && item.blob;
        if (!blob && item && item.dataUrl) {
          try { blob = _dataUrlToBlob(item.dataUrl); } catch (_) { blob = null; }
        }
        if (!blob || !item.leadId) { await _dropItem(item); removed++; continue; }

        try {
          if (item.capture && item.capture.edit) {
            // A queued photo-editor save (2026-10-04) — same queue, its own
            // apply step. See _applyQueuedEdit.
            await _applyQueuedEdit(blob, item);
          } else {
            await uploadPhotoToFirebase(blob, item.leadId, item.tags || [], item.description || '', item.location || '', {
              // A legacy row queued before this field existed has no uploadId.
              // Derive a stable one from uid + row id + capture time rather than
              // minting a fresh one per retry: unique across devices and users
              // (a bare row id would collide as a Firestore doc id), and the
              // same on every attempt at that row.
              uploadId: item.uploadId || _legacyUploadId(item),
              capturedAt: item.timestamp,
              preset: item.preset,
              capture: item.capture || null
            });
          }
          await _dropItem(item);
          sent++;
          removed++;
        } catch (e) {
          // Still offline (or the upload is failing for another reason).
          // Stop here and leave this item AND everything after it queued.
          stalled = true;
          break;
        }
      }
      if (sent && !quiet && typeof showToast === 'function') {
        showToast(sent === 1 ? '✓ 1 queued photo uploaded' : `✓ ${sent} queued photos uploaded`, 'success');
      }
      await _syncMarkerAfterDrain(removed);
    } finally {
      _draining = false;
      // A burst shot landed mid-drain: one more pass for it — unless this
      // pass stalled on a failure, where an immediate retry would only fail
      // again (the `online` event and boot recovery take it from there).
      if (_drainAgain && !stalled) {
        _drainAgain = false;
        setTimeout(() => { flushUploadQueue({ quiet: quiet }); }, 0);
      }
    }
    return sent;
  }

  // Bounded on purpose. This runs INSIDE flushUploadQueue's try, so the
  // `_draining` guard still covers it and a second drain cannot start a
  // second, interleaving marker write — but that also means a promise which
  // never settles would leave `_draining` stuck true and permanently disable
  // every future drain. If the sync has not finished in MARKER_SYNC_TIMEOUT_MS
  // we stop waiting and let it land on its own — abandoning the wait does not
  // cancel the write, and photo-queue-recovery.js serialises and bounds the
  // marker queue itself so a slow write cannot strand the ones behind it.
  //
  // Do NOT read this as "the next drain will re-file it anyway". It will not:
  // this runs only when `removed > 0`, and a drain that emptied the queue
  // leaves nothing for a later drain to remove, so there is no next sync. The
  // recovery module's own boot repair is what covers a marker left stale.
  //
  // The bound is read inside the function, not from a module const: the
  // behavioural harness extracts these functions one at a time and runs them
  // in a bare sandbox, so a free variable declared elsewhere in this file is
  // simply absent there — the reference throws, the race rejects, and the
  // catch below swallows it, leaving a green test that proved nothing. The
  // window hook also lets that harness drive the timeout in milliseconds
  // instead of waiting five seconds to prove the bound exists.
  async function _syncMarkerAfterDrain(removed) {
    const MARKER_SYNC_TIMEOUT_MS =
      (typeof window !== 'undefined' && window.__nbdMarkerSyncTimeoutMs) || 5000;
    // Tell the server what is still owed. This function is the drain for ALL
    // three routes — boot recovery, the `online` listener, and the flush after
    // a successful capture — but only the first one used to update the
    // server-side loss marker. The other two cleared the local counter and
    // left the marker frozen at the old number, which the next sign-in after a
    // logout reads back as a loss and reports as "reshoot the roof" for photos
    // that uploaded fine. Feature-detected: photo-engine can load on a page
    // where photo-queue-recovery.js is absent, and a stale service-worker
    // cache can pair a new engine with an older recovery module.
    //
    // Gated on `removed`, not on `sent`. An unrecoverable row — no decodable
    // blob, or no leadId — is dropped without ever being uploaded, so a drain
    // can empty the queue completely while `sent` stays 0. Under the old
    // `if (sent)` the local counter went to 0 and the server marker stayed
    // frozen at the old number, which is exactly the stale-marker accusation
    // this block was added to prevent, reachable through the one path it did
    // not cover. What matters is whether the queue CHANGED, not whether
    // anything reached Firebase.
    if (!removed) return;
    const rec = typeof window !== 'undefined' && window.NBDPhotoQueueRecovery;
    if (!rec || typeof rec.syncMarker !== 'function') return;
    let timer = null;
    try {
      await Promise.race([
        rec.syncMarker(),
        new Promise((resolve) => { timer = setTimeout(resolve, MARKER_SYNC_TIMEOUT_MS); })
      ]);
    } catch (e) {
      console.warn('[PhotoEngine] marker sync failed:', e && e.message);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  if (typeof window !== 'undefined' && !window.__nbdPhotoQueueBound) {
    window.__nbdPhotoQueueBound = true;
    window.addEventListener('online', function () { flushUploadQueue(); });
    // Hydrate the mirror from storage so queuedPhotoCount() is truthful the
    // moment this module loads after a reload. The drain itself is triggered
    // by photo-queue-recovery.js, which waits for Firebase auth first.
    _syncMirror();
  }

  /**
   * The two ways an upload fails DETERMINISTICALLY, before any network call.
   * Returned as an Error tagged `retryable = false` so callers can tell them
   * apart from a dead network: queueing one of these would tell the rep the
   * photo is held and then drop it as unrecoverable on the next drain.
   */
  function _uploadPreflightError(leadId) {
    if (!window._storage || !window._db || !window._user) {
      const err = new Error('Firebase not initialized');
      err.retryable = false;
      return err;
    }
    // Fail loudly on a missing lead. Callers that read a lead id out of a
    // global can hand us null/'' when that global was cleared (the
    // read-after-close class of bug), and firestore.rules leaves `leadId`
    // unconstrained — so the write SUCCEEDS and silently strands the photo at
    // photos/<uid>/null/ on a doc attached to no customer. There is no UI
    // anywhere that lists leadId-less photos, so they are unrecoverable.
    // Every caller is already inside a try/catch that toasts.
    if (!leadId || typeof leadId !== 'string') {
      const err = new Error('Cannot upload a photo without a customer — reopen the customer and try again');
      err.retryable = false;
      return err;
    }
    return null;
  }

  /**
   * @param opts {uploadId, capturedAt, preset} — the photo's IDENTITY, pinned
   * when it was taken. Omit for a one-shot upload that is never retried.
   *
   * WHY IT EXISTS: this function is not atomic. It commits the ~1.5MB Storage
   * object, then does four more failable things (thumbnail generate + upload,
   * two getDownloadURL, setDoc), and nothing leaves the queue until the LAST
   * one resolves. Both the Storage filenames and the Firestore doc id used to
   * be minted INSIDE the function — `Date.now()` and `generateId()` — so every
   * retry wrote to a brand-new path under a brand-new doc id.
   *
   * On flaky LTE, where the big PUT gets through and the thumbnail times out,
   * that is the ordinary case: each retry left another full-size orphan in the
   * bucket that nothing reaps, and a reload after a successful setDoc could
   * leave a visible duplicate in the gallery. Pinning the identity at capture
   * makes the whole sequence idempotent — a retry overwrites the same two
   * objects and setDoc()s the same document.
   */
  /**
   * Everything about an upload that must be IDENTICAL on every attempt,
   * derived in one pure place so it can be exercised for real by a test.
   * (It lived inline inside uploadPhotoToFirebase, where the only way to test
   * it was a regex over the source — and a regex cannot tell you that a retry
   * lands on the same Storage object.)
   */
  function _uploadIdentity(uid, leadId, opts) {
    const o = opts || {};
    const uploadId = o.uploadId || generateId();
    const preset = o.preset || state.currentPreset;
    return {
      uploadId,
      preset,
      capturedAt: typeof o.capturedAt === 'number' ? o.capturedAt : Date.now(),
      // The doc id IS the idempotency key: a retry setDoc()s the same document
      // instead of creating a second gallery entry for one photo.
      photoId: uploadId,
      photoPath: `photos/${uid}/${leadId}/${uploadId}_${preset}.jpg`,
      thumbPath: `photos/${uid}/${leadId}/thumbs/${uploadId}_thumb.jpg`
    };
  }

  async function uploadPhotoToFirebase(blob, leadId, tags, description, location, opts) {
    const preflight = _uploadPreflightError(leadId);
    if (preflight) {
      throw preflight;
    }

    const { ref, uploadBytes, getDownloadURL } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js'
    );
    const { doc, setDoc, updateDoc, getDoc, serverTimestamp } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );

    const uid = window._user.uid;
    // Every value here must be STABLE across retries of the same photo, so it
    // comes from one pure derivation the tests can run directly.
    const ident = _uploadIdentity(uid, leadId, opts);
    const { uploadId, capturedAt, preset, photoPath, thumbPath } = ident;

    try {
      // Upload main photo
      const photoRef = ref(window._storage, photoPath);
      await uploadBytes(photoRef, blob);
      const photoUrl = await getDownloadURL(photoRef);

      // Generate and upload thumbnail
      const thumbBlob = await generateThumbnail(blob);
      const thumbRef = ref(window._storage, thumbPath);
      await uploadBytes(thumbRef, thumbBlob);
      const thumbUrl = await getDownloadURL(thumbRef);

      // Derive a normalized `phase` field from the user-selected tags.
      // The customer page's photo panel (customer-tasks-ui.js) buckets on
      // photo.phase for its Before / During / After filters and counts.
      // Without a dedicated field every photo defaulted to 'During' and the
      // Before/After buckets were always empty. We honor whichever phase tag
      // the user set; if none, we leave phase null so consumers fall back to
      // their existing 'During' default.
      // (This used to name share-gallery.js as the reader — that module was
      // deleted 2026-07-27; the field is still load-bearing for the panel above.)
      //
      // 2026-10-04: a photo with no phase tag now takes its phase from the
      // lead's stage at capture (captureContext) — a phase tag still wins.
      // Callers that pinned the context at capture (camera, burst, queue
      // drain) pass it in opts.capture; anything else (file picks, the
      // customer-page hub) gets it derived here from the lead as it is now.
      const _cap = (opts && opts.capture)
        || captureContext(tags, _stageOf(_leadForCapture(leadId)), null, null);
      const _tagPhase = phaseFromTags(tags);
      const phase = _tagPhase || _cap.phase || null;
      const phaseSource = _tagPhase ? 'tag' : (phase ? (_cap.phaseSource || 'stage') : null);

      // Store metadata in Firestore
      // The doc id IS the idempotency key: a retry setDoc()s the same
      // document instead of creating a second gallery entry for one photo.
      const photoId = ident.photoId;
      const photoData = {
        id: photoId,
        leadId,
        userId: uid,
        // Tenancy: every team-scoped reader (dashboard boot's _photoCache, the
        // customer page, share-gallery) queries photos by userId==me OR
        // companyId==my tenant. Uploads stamped only userId were invisible to
        // teammates — a company_admin opening another rep's customer saw an
        // empty gallery. Stamp it here, on the one write path all uploads
        // funnel through. Omitted (not null) for solo users with no claim, so
        // the field stays absent rather than blocking an equality query.
        ...(window._userClaims && window._userClaims.companyId
          ? { companyId: window._userClaims.companyId }
          : {}),
        url: photoUrl,
        // Storage path for future-proof deletion. Without this, the
        // delete path has to parse the download URL — fragile and prone
        // to orphaning Storage objects when URLs include encoded paths.
        storagePath: photoPath,
        thumbStoragePath: thumbPath,
        thumbUrl,
        tags,
        phase,
        // 'tag' (the rep picked it) | 'stage' (stamped from the lead's stage)
        // — Photo Review still asks the rep to confirm a stage-stamped phase.
        phaseSource,
        description,
        location,
        quality: preset,
        width: blob.size > 0 ? 'auto' : 0,
        height: 'auto',
        fileSize: blob.size,
        // `createdAt` is the CANONICAL ordering field for /photos — every
        // write path (quick-upload, repos.create, annotation copy) stamps it
        // with serverTimestamp(), and the Recent feed + per-lead gallery both
        // orderBy('createdAt'). `capturedAt` (client capture epoch) and
        // `uploadedAt` are kept additively for display/back-compat; they are
        // no longer the ordering authority. See firestore.indexes.json
        // (photos [userId, createdAt] / [leadId, userId, createdAt]).
        createdAt: serverTimestamp(),
        capturedAt,
        uploadedAt: serverTimestamp(),
        reportSections: [],
        // One GPS reading per camera session ({lat,lng,accuracy,at}) or null.
        // CRM-only: the portal and public pages project explicit fields and
        // never read it; the reports print only "on-site", never coordinates.
        geoLocation: _cap.geo || null,
        onSite: typeof _cap.onSite === 'boolean' ? _cap.onSite : null
      };

      // A stable doc id makes the retry idempotent — but it also means the
      // retry now lands on the SAME document, and an unmerged setDoc would
      // RESET it to capture-time state. Where the old code left a duplicate,
      // this would silently discard everything written after the first
      // successful upload: the rep's own edits to tags/phase/description via
      // updatePhotoTags, `reportSections`, and (depending on ordering) the
      // urls/variantsGeneratedAt the Storage finalize trigger stamps.
      //
      // `{ merge: true }` is NOT sufficient: photoData carries capture-time
      // tags/phase/description plus `reportSections: []`, so a merged write
      // still overwrites rep edits and blanks the sections.
      //
      // So: create once, and on any later attempt repair only what a
      // re-upload can legitimately have changed — the download URLs, whose
      // tokens are re-minted by overwriting the Storage objects.
      const photoDocRef = doc(window._db, 'photos', photoId);
      const repair = {
        url: photoUrl,
        thumbUrl,
        storagePath: photoPath,
        thumbStoragePath: thumbPath,
        fileSize: blob.size
      };
      let createdDoc = false;
      const snap = await getDoc(photoDocRef).catch(() => null);
      if (snap && snap.exists()) {
        await updateDoc(photoDocRef, repair);
      } else if (snap) {
        await setDoc(photoDocRef, photoData);
        createdDoc = true;
      } else {
        // The read failed, so we cannot tell. Repair first — an unknown state
        // must never clobber rep edits — and create only if the document
        // genuinely is not there.
        try {
          await updateDoc(photoDocRef, repair);
        } catch (_) {
          await setDoc(photoDocRef, photoData);
          createdDoc = true;
        }
      }

      // Clear cache for this lead
      delete state.photoCache[leadId];

      // Keep the GLOBAL cache and the embedded hub in step. state.photoCache is
      // this engine's own cache; the customer Photos hub renders exclusively
      // from window._photoCache, which nothing here touched. So a rep shooting
      // five roof photos got five "Photo N saved" toasts, closed the camera,
      // and found the tab showing the old count and grid — re-entering did not
      // help, because mount() re-renders the same stale cache. Reps read that
      // as a failed save and re-shot the roof, creating duplicates.
      //
      // The sibling estimate hub is already wired this way (dashboard-widgets
      // calls CustomerEstimateHub.refresh() after a write). Guarded and
      // fire-and-forget: a rendering failure must never surface as a photo that
      // did not save, since at this point it demonstrably did.
      // Idempotent by id: the hub's own multi-file upload path pushes each
      // returned photo into this same cache, and it also routes through this
      // function — so an unconditional push here would render every
      // button-uploaded photo twice.
      try {
        if (!window._photoCache) window._photoCache = {};
        if (!Array.isArray(window._photoCache[leadId])) window._photoCache[leadId] = [];
        const _bag = window._photoCache[leadId];
        if (!_bag.some((p) => p && p.id === photoId)) _bag.push(photoData);
        if (window.CustomerPhotoHub && typeof window.CustomerPhotoHub.refresh === 'function') {
          window.CustomerPhotoHub.refresh();
        }
      } catch (e) { /* cache/repaint is best-effort; the write already succeeded */ }

      // ── B.1 (Phase B) — AI Vision auto-tag, fire-and-forget.
      // After the photo lands in Firestore, kick off
      //   analyzePhotoVision({ photoId })
      // so Claude Vision tags damageType / severity / area / confidence
      // and writes them back to the photo doc (server side, see
      // functions/photo-vision.js). The lead-cost meter caps spend per
      // lead + per user/month, so over-triggering is gated server-side.
      // Failure is silent — manual tagging still works.
      // Only on CREATE. A retry lands on a doc that has already been analysed,
      // so re-firing would re-spend the per-lead AI budget on a photo that is
      // already tagged — and the vision cache cannot absorb it, because it is
      // keyed on the image URL and the overwrite mints a new token.
      if (createdDoc) {
        try {
          _autoTagPhotoBackground(photoId);
        } catch (e) { /* never let auto-tag break the upload flow */ }
        // An After photo on a lead whose install completed before any After
        // photo existed: the Before & After report was waiting for it
        // (photo-report.js NBDAutoBeforeAfter). Same bundle, so normally
        // present; guarded because a stale cache can split them.
        if (phase === 'After') {
          try {
            if (window.NBDAutoBeforeAfter && typeof window.NBDAutoBeforeAfter.afterPhoto === 'function') {
              window.NBDAutoBeforeAfter.afterPhoto(leadId);
            }
          } catch (e) { /* the report is a bonus; the photo saved */ }
        }
      }

      return photoData;
    } catch (err) {
      console.error('Upload error:', err);
      throw err;
    }
  }

  // ============================================================================
  // GALLERY & BROWSER
  // ============================================================================

  async function renderGallery(containerId, leadId) {
    const container = document.getElementById(containerId);
    if (!container) {
      console.error('Container not found:', containerId);
      return;
    }

    injectStyles();
    container.innerHTML = '<div style="text-align: center; padding: 2rem; color: var(--m);">Loading photos...</div>';

    try {
      const photos = await getPhotosForLead(leadId);

      container.innerHTML = `
        <div class="pe-gallery-container">
          <div class="pe-gallery-toolbar">
            <select class="pe-toolbar-select" id="filter-tag">
              <option value="">All Photos</option>
              ${Object.entries(TAG_CATEGORIES).map(([_, cat]) =>
                cat.tags.map(tag => `<option value="${tag}">${cat.label}: ${tag.replace(/_/g, ' ')}</option>`).join('')
              ).join('')}
            </select>
            <select class="pe-toolbar-select" id="sort-by">
              <option value="newest">Newest First</option>
              <option value="oldest">Oldest First</option>
              <option value="quality">Quality Preset</option>
            </select>
            <select class="pe-toolbar-select" id="view-mode">
              <option value="grid">Grid View</option>
              <option value="list">List View</option>
            </select>
            <button id="pe-bulk-ai-btn" type="button" class="btn btn-orange btn-sm"
              data-action="peBulkAnalyze" data-lead-id="${leadId}"
              style="margin-left:auto;">
              ✨ Analyze All with AI
            </button>
          </div>
          <div id="pe-ai-summary"></div>
          <div id="gallery-content"></div>
        </div>
      `;

      renderGalleryGrid(container.querySelector('#gallery-content'), photos, leadId);

      // CSP-safe wiring: the dashboard CSP enforces script-src-attr 'none', which
      // blocks inline onchange= — the filter/sort <select>s were silently dead.
      // Attach the same handlers via addEventListener instead.
      const _peFilter = container.querySelector('#filter-tag');
      if (_peFilter) _peFilter.addEventListener('change', function () { window.PhotoEngine._filterGallery(leadId); });
      const _peSort = container.querySelector('#sort-by');
      if (_peSort) _peSort.addEventListener('change', function () { window.PhotoEngine._sortGallery(leadId); });
    } catch (err) {
      container.innerHTML = `<div class="nbd-empty"><div class="ne-icon">📷</div><div class="ne-msg">No photos yet</div></div>`;
      console.error('Gallery error:', err);
    }
  }

  function renderGalleryGrid(container, photos, leadId) {
    if (photos.length === 0) {
      container.innerHTML = `<div class="nbd-empty"><div class="ne-icon">📷</div><div class="ne-msg">No photos found</div></div>`;
      return;
    }

    container.innerHTML = `
      <div class="pe-gallery-grid">
        ${photos.map(photo => `
          <div class="pe-gallery-item" data-photo-id="${escHtml(photo.id)}">
            <img class="pe-gallery-thumbnail" src="${escHtml(photo.thumbUrl || photo.url)}" alt="Photo"
                 data-action="peOpenLightbox" data-photo-id="${escHtml(photo.id)}" data-lead-id="${escHtml(leadId)}" />
            ${state.stagedPhotos[leadId]?.includes(photo.id) ? `<div class="pe-staged-badge">OK</div>` : ''}
            <input type="checkbox" class="pe-gallery-checkbox" data-photo-id="${escHtml(photo.id)}" />
            <div class="pe-gallery-tags">
              ${photo.tags.slice(0, 3).map(tag => `<span class="pe-mini-tag">${escHtml(tag)}</span>`).join('')}
            </div>
            ${photo.aiSuggestion && photo.aiSuggestion.damageType ? `
              <span class="pe-ai-chip"
                title="AI suggested: ${escHtml(dmgLabel(photo.aiSuggestion.damageType))}${photo.aiSuggestion.confidence ? ' · ' + Math.round(photo.aiSuggestion.confidence*100) + '% confidence' : ''}">
                <span class="pe-ai-chip-dot" aria-hidden="true"></span>
                ${escHtml(dmgLabel(photo.aiSuggestion.damageType))}${photo.aiSuggestion.confidence ? ' · ' + Math.round(photo.aiSuggestion.confidence*100) + '%' : ''}
              </span>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  // ============================================================================
  // LIGHTBOX
  // ============================================================================

  async function openLightbox(photoId, leadId) {
    if (!window._db) return;

    const { doc, getDoc } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );

    try {
      const photoRef = doc(window._db, 'photos', photoId);
      const photoSnap = await getDoc(photoRef);

      if (!photoSnap.exists()) {
        showToast('Photo not found', 'error');
        return;
      }

      const photo = photoSnap.data();

      const lightbox = document.createElement('div');
      lightbox.className = 'pe-lightbox';
      lightbox.id = 'photo-lightbox';

      lightbox.innerHTML = `
        <div class="pe-lightbox-content">
          <img class="pe-lightbox-image" src="${escHtml(photo.url)}" alt="Full size" />
          <div class="pe-lightbox-metadata">
            <div class="pe-metadata-row">
              <div class="pe-metadata-label">Date</div>
              <div>${formatDate(photo.capturedAt || photo.createdAt || photo.uploadedAt)}</div>
            </div>
            ${photo.description ? `
              <div class="pe-metadata-row">
                <div class="pe-metadata-label">Notes</div>
                <div>${escHtml(photo.description)}</div>
              </div>
            ` : ''}
            ${photo.location ? `
              <div class="pe-metadata-row">
                <div class="pe-metadata-label">Location</div>
                <div>${escHtml(photo.location)}</div>
              </div>
            ` : ''}
            <div class="pe-metadata-row">
              <div class="pe-metadata-label">Quality</div>
              <div>${escHtml(QUALITY_PRESETS[photo.quality]?.label || photo.quality)}</div>
            </div>
            <div class="pe-metadata-row">
              <div class="pe-metadata-label">Size</div>
              <div>${formatFileSize(photo.fileSize)}</div>
            </div>
            ${photo.tags.length > 0 ? `
              <div class="pe-metadata-row">
                <div class="pe-metadata-label">Tags</div>
                <div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">
                  ${photo.tags.map(tag => `<span style="background: var(--orange); color: var(--accent-fg); padding: 0.2rem 0.5rem; border-radius: 0.25rem; font-size: 0.8rem;">${escHtml(tag)}</span>`).join('')}
                </div>
              </div>
            ` : ''}
            <div style="display: flex; gap: 0.5rem; margin-top: 1rem;">
              <button class="pe-btn pe-btn-primary" style="flex: 1;" data-action="peStagePhoto" data-photo-id="${photoId}" data-lead-id="${leadId}">
                Stage for Report
              </button>
              <button class="pe-btn pe-btn-secondary" style="flex: 1;" data-action="peDeletePhoto" data-photo-id="${photoId}">
                Delete
              </button>
            </div>
            <div class="pe-ai-slot" data-photo-id="${photoId}"></div>
          </div>
        </div>
        <div class="pe-lightbox-nav">
          <button class="pe-nav-btn" data-action="peRemove" data-target="photo-lightbox">X</button>
          <button class="pe-nav-btn" data-action="peRemove" data-target="photo-lightbox">OK</button>
        </div>
      `;

      document.body.appendChild(lightbox);
      lightbox.onclick = (e) => {
        if (e.target === lightbox) lightbox.remove();
      };

      // Wave 10: AI damage analysis. Injects an "Analyze with AI" button
      // (or renders an existing aiAnalysis) into the metadata pane.
      try {
        if (window.PhotoAI && typeof window.PhotoAI.injectInLightbox === 'function') {
          const slot = lightbox.querySelector('.pe-ai-slot[data-photo-id="' + photoId + '"]');
          if (slot) window.PhotoAI.injectInLightbox({ id: photoId, leadId, ...photo }, slot);
        }
      } catch (e) {
        console.warn('[PhotoEngine] AI inject failed', e);
      }
    } catch (err) {
      showToast('Failed to load photo', 'error');
      console.error(err);
    }
  }

  // ============================================================================
  // FIRESTORE QUERIES
  // ============================================================================

  async function getPhotosForLead(leadId) {
    if (!window._db) throw new Error('Firestore not initialized');

    if (state.photoCache[leadId]) {
      return state.photoCache[leadId];
    }

    const { collection, query, where, getDocs, orderBy } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );

    // Order by the canonical `createdAt` (serverTimestamp on every write
    // path) — NOT `capturedAt`, which only photo-engine uploads set, so
    // quick-upload / annotation-copy photos were silently excluded from
    // this gallery. Requires the composite index
    // photos [leadId, userId, createdAt DESC] (firestore.indexes.json).
    const q = query(
      collection(window._db, 'photos'),
      where('leadId', '==', leadId),
      where('userId', '==', window._auth?.currentUser?.uid),
      orderBy('createdAt', 'desc')
    );

    const querySnapshot = await getDocs(q);
    const photos = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    state.photoCache[leadId] = photos;
    return photos;
  }

  async function deletePhotoFromFirebase(photoId) {
    if (!window._storage || !window._db) throw new Error('Firebase not initialized');

    const { deleteDoc, doc, getDoc } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
    );
    const { ref, deleteObject } = await import(
      'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js'
    );

    try {
      // Get photo metadata
      const photoRef = doc(window._db, 'photos', photoId);
      const photoSnap = await getDoc(photoRef);

      if (photoSnap.exists()) {
        const photo = photoSnap.data();

        // Delete from storage. The Firebase Storage SDK can construct a
        // Reference directly from a download URL via `ref(storage, url)`,
        // which correctly handles the URL-encoded path segments. The
        // previous `url.split('/').pop()` approach extracted only the
        // filename plus query string and produced an INVALID path —
        // deletion silently 404'd inside the catch and the storage
        // object was orphaned. Prefer photo.storagePath when present
        // (set on newer uploads); fall back to the URL parser.
        const tryDelete = async (ref1, label) => {
          try { await deleteObject(ref1); }
          catch (e) { console.warn(label + ' deletion failed:', e?.message || e); }
        };

        if (photo.storagePath) {
          await tryDelete(ref(window._storage, photo.storagePath), 'Storage');
        } else if (photo.url) {
          // SDK accepts gs:// and https://firebasestorage.googleapis.com URLs.
          await tryDelete(ref(window._storage, photo.url), 'Storage');
        }

        // Thumb deletion: prefer the explicit path stored on newer uploads;
        // fall back to the documented path scheme for legacy records.
        const uid = window._user.uid;
        if (photo.thumbStoragePath) {
          await tryDelete(ref(window._storage, photo.thumbStoragePath), 'Thumbnail');
        } else if (photo.thumbUrl) {
          await tryDelete(ref(window._storage, photo.thumbUrl), 'Thumbnail');
        } else if (photo.leadId) {
          const thumbPath = `photos/${uid}/${photo.leadId}/thumbs/${photoSnap.id}_thumb.jpg`;
          await tryDelete(ref(window._storage, thumbPath), 'Thumbnail');
        }

        // Delete from Firestore
        await deleteDoc(photoRef);

        // Clear cache
        delete state.photoCache[photo.leadId];
      }
    } catch (err) {
      console.error('Delete error:', err);
      throw err;
    }
  }

  // ============================================================================
  // STAGING & REPORT
  // ============================================================================

  function stagePhoto(photoId, leadId) {
    if (!state.stagedPhotos[leadId]) {
      state.stagedPhotos[leadId] = [];
    }
    if (!state.stagedPhotos[leadId].includes(photoId)) {
      state.stagedPhotos[leadId].push(photoId);
    }
    showToast('Photo staged for report', 'success');
  }

  function clearStagedPhotos(leadId) {
    delete state.stagedPhotos[leadId];
    showToast('Staging cleared', 'success');
  }

  async function getStagedPhotos(leadId) {
    const stagedIds = state.stagedPhotos[leadId] || [];
    if (stagedIds.length === 0) return [];

    const allPhotos = await getPhotosForLead(leadId);
    return allPhotos.filter(p => stagedIds.includes(p.id));
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  window.PhotoEngine = {
    openCamera,
    // Exposed so the retry is an operation the app can trigger, not only an
    // `online` side effect — and so it is testable at all.
    flushUploadQueue,
    // Exposed 2026-09-14 so a caller outside this module's own camera-capture
    // flow (customer-bootstrap.module.js's uploadSinglePhoto) can durably
    // persist a photo BEFORE attempting the network upload, the same way
    // openCamera's save flow already does — a no-signal shot from the
    // customer page was previously lost outright, never queued at all.
    // Returns { durable, queued, entry } — see the function body for the
    // durable-vs-memory-fallback and queue-full/quota messaging contract.
    enqueueForRetry,
    // 2026-10-04: photo-editor saves ride the same durable queue.
    enqueueEdit,
    // Pure capture helpers, exposed for tests and for the report engines.
    _capture: { phaseForStage, phaseFromTags, haversineMeters, onSiteFor, captureContext, ON_SITE_RADIUS_M },
    // Burst internals, exposed for the behavioural suite
    // (tests/field-photos-client-2026-10-04.test.js) and the E2E.
    _burst: { saveBurstShot: _saveBurstShot, readCaptureMode: _readCaptureMode, showBurstDone: _showBurstDone },
    // Synchronous, reads the in-memory mirror. Accurate once _syncMirror()
    // has run; use queuedPhotoCountDurable() if you need the storage truth
    // without depending on that having happened yet.
    queuedPhotoCount: () => (state.uploadQueue || []).length,
    queuedPhotoCountDurable: async () => {
      const store = _store();
      if (!store) return (state.uploadQueue || []).length;
      try { return await store.count(); }
      catch (_) { return (state.uploadQueue || []).length; }
    },
    openGallery: renderGallery,
    getPhotosForReport: getPhotosForLead,
    getPhotosByTag: async (leadId, tag) => {
      const photos = await getPhotosForLead(leadId);
      return photos.filter(p => p.tags && p.tags.includes(tag));
    },
    getStagedPhotos,
    clearStagedPhotos,
    deletePhoto: deletePhotoFromFirebase,
    uploadFromFile: async (leadId, file, tags = [], description = '') => {
      if (!(file instanceof Blob)) {
        throw new Error('Invalid file');
      }
      return uploadPhotoToFirebase(file, leadId, tags, description, '');
    },
    // Writes `phase` alongside `tags`, because phase is DERIVED from tags and
    // was only ever computed at upload time (see uploadPhotoToFirebase). Tagging
    // an existing photo "before"/"after" therefore changed nothing downstream:
    // the customer page's Before/During/After buckets and the homeowner portal's
    // before/after pairing both read `phase`, so a rep could tag ten photos and
    // watch the Before and After counts stay at zero.
    //
    // Same derivation as the upload path — kept literally identical rather than
    // factored out, so the two cannot drift into disagreeing about what a tag
    // means. A tag set with none of the three clears phase to null rather than
    // leaving a stale value behind.
    updatePhotoTags: async (photoId, tags) => {
      if (!window._db) throw new Error('Firestore not initialized');
      const { doc, updateDoc, getDoc } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const _tagList = Array.isArray(tags) ? tags : [];
      let phase = null;
      if (_tagList.includes('before')) phase = 'Before';
      else if (_tagList.includes('after')) phase = 'After';
      else if (_tagList.includes('during')) phase = 'During';
      const ref = doc(window._db, 'photos', photoId);
      // 2026-10-04: a phase stamped from the lead's stage at capture is not a
      // tag, so a tag edit that names no phase leaves it alone — only a phase
      // that came FROM a tag is cleared when that tag goes.
      if (!phase) {
        try {
          const snap = await getDoc(ref);
          const cur = snap && snap.exists() ? (snap.data() || {}) : {};
          if (cur.phaseSource === 'stage' && cur.phase) { await updateDoc(ref, { tags }); return; }
        } catch (_) { /* unreadable: fall through to the old behaviour */ }
      }
      await updateDoc(ref, { tags, phase, phaseSource: phase ? 'tag' : null });
    },
    updatePhotoDescription: async (photoId, description) => {
      if (!window._db) throw new Error('Firestore not initialized');
      const { doc, updateDoc } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      await updateDoc(doc(window._db, 'photos', photoId), { description });
    },

    // Internal methods (prefixed with _)
    _filterGallery: async (leadId) => {
      const filterTag = document.getElementById('filter-tag')?.value || '';
      const photos = await getPhotosForLead(leadId);
      const filtered = filterTag ? photos.filter(p => p.tags && p.tags.includes(filterTag)) : photos;
      const sortBy = document.getElementById('sort-by')?.value || 'newest';
      const sorted = [...filtered].sort((a, b) => {
        if (sortBy === 'oldest') return photoEpoch(a) - photoEpoch(b);
        if (sortBy === 'quality') return (b.quality || '').localeCompare(a.quality || '');
        return photoEpoch(b) - photoEpoch(a);
      });
      const container = document.getElementById('gallery-content');
      if (container) renderGalleryGrid(container, sorted, leadId);
    },
    _sortGallery: async (leadId) => {
      const filterTag = document.getElementById('filter-tag')?.value || '';
      const photos = await getPhotosForLead(leadId);
      const filtered = filterTag ? photos.filter(p => p.tags && p.tags.includes(filterTag)) : photos;
      const sortBy = document.getElementById('sort-by')?.value || 'newest';
      const sorted = [...filtered].sort((a, b) => {
        if (sortBy === 'oldest') return photoEpoch(a) - photoEpoch(b);
        if (sortBy === 'quality') return (b.quality || '').localeCompare(a.quality || '');
        return photoEpoch(b) - photoEpoch(a);
      });
      const container = document.getElementById('gallery-content');
      if (container) renderGalleryGrid(container, sorted, leadId);
    },
    _openLightbox: openLightbox,
    _stagePhoto: stagePhoto,
    // Internal: patch a photo in the per-lead cache so the next gallery
    // open / lightbox open sees freshly-stamped fields (e.g. aiAnalysis).
    __updatePhotoCache: (leadId, photoId, patch) => {
      const list = state.photoCache[leadId];
      if (!Array.isArray(list)) return;
      const i = list.findIndex(p => p.id === photoId);
      if (i >= 0) list[i] = { ...list[i], ...patch };
    },
    // Wave 12: bulk AI analysis. Iterates the currently visible gallery
    // photos, calls PhotoAI.analyze on each, updates the in-memory cache
    // as results come in, and renders a severity-summary banner above
    // the gallery when finished.
    _bulkAnalyze: async (leadId) => {
      if (!window.PhotoAI || typeof window.PhotoAI.bulkAnalyze !== 'function') {
        showToast('AI module not loaded', 'error');
        return;
      }
      const btn = document.getElementById('pe-bulk-ai-btn');
      const summarySlot = document.getElementById('pe-ai-summary');
      if (btn) {
        btn.disabled = true;
        btn.style.opacity = '0.7';
        btn.style.cursor = 'wait';
        btn.textContent = '⏳ Starting…';
      }
      // Listen for the cap-reached event from PhotoAI / PhotoAIClassifier
      // so the finishing toast can give a friendlier "hit your cap"
      // message instead of just "N failed". Detached in `finally`.
      let capSkipped = 0;
      let capReason = null;
      const onCapSkip = (e) => {
        capSkipped++;
        if (!capReason && e && e.detail && e.detail.reason) capReason = e.detail.reason;
      };
      window.addEventListener('nbd:ai-classify-skipped', onCapSkip);
      try {
        // Filter to roof + damage photos by default — those are what
        // the model is trained on. If the user has filtered by tag,
        // honor that; otherwise analyze everything.
        let photos = await getPhotosForLead(leadId);
        const filterTag = document.getElementById('filter-tag')?.value || '';
        if (filterTag) {
          photos = photos.filter(p => p.tags && p.tags.includes(filterTag));
        }
        if (photos.length === 0) {
          showToast('No photos to analyze', 'info');
          return;
        }
        const todoCount = photos.filter(p => !p.aiAnalysis).length;
        if (todoCount === 0) {
          showToast('All photos already analyzed', 'info');
          if (summarySlot && window.PhotoAI.renderSummaryBanner) {
            const summary = await window.PhotoAI.bulkAnalyze(photos); // counts only
            summarySlot.innerHTML = window.PhotoAI.renderSummaryBanner(summary);
          }
          return;
        }
        const summary = await window.PhotoAI.bulkAnalyze(photos, ({ index, total }) => {
          if (btn) btn.textContent = `⏳ Analyzing ${index + 1} of ${total}…`;
        });
        if (summarySlot && window.PhotoAI.renderSummaryBanner) {
          summarySlot.innerHTML = window.PhotoAI.renderSummaryBanner(summary);
        }
        if (capSkipped > 0) {
          const reasonLabel = capReason === 'daily-cap' ? 'daily (100/day)'
                            : capReason === 'lead-cap'  ? 'per-lead ($10)'
                            : capReason === 'user-cap'  ? 'monthly ($50)'
                            : 'AI';
          const msg = `Hit ${reasonLabel} cap. Analyzed ${summary.analyzed} — try again later.`;
          showToast(msg, 'info');
        } else {
          const msg = summary.failed > 0
            ? `Analyzed ${summary.analyzed} of ${summary.total - summary.skipped} (${summary.failed} failed)`
            : `Analyzed ${summary.analyzed} photo${summary.analyzed === 1 ? '' : 's'}`;
          showToast(msg, summary.failed > 0 ? 'error' : 'success');
        }
      } catch (err) {
        console.error('[PhotoEngine] bulk analyze failed', err);
        showToast('Bulk analysis failed: ' + err.message, 'error');
      } finally {
        window.removeEventListener('nbd:ai-classify-skipped', onCapSkip);
        if (btn) {
          btn.disabled = false;
          btn.style.opacity = '';
          btn.style.cursor = '';
          btn.textContent = '✨ Analyze All with AI';
        }
      }
    },
    _deletePhoto: async (photoId) => {
      const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
      if (await _ask('Delete this photo? This cannot be undone.')) {
        deletePhotoFromFirebase(photoId).then(() => {
          document.getElementById('photo-lightbox')?.remove();
          showToast('Photo deleted', 'success');
        }).catch(err => showToast('Delete failed: ' + err.message, 'error'));
      }
    }
  };

  // Inject styles on load
  document.addEventListener('DOMContentLoaded', injectStyles);
  if (document.readyState === 'loading') {
    injectStyles();
  }
})();
