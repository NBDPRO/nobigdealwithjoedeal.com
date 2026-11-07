/**
 * photo-ai.js — Wave 10 (AI photo analysis MVP)
 *
 * Client wrapper for the DEEP-analysis path. Calls the
 * analyzeRoofPhoto Cloud Function (Sonnet) and renders the rich
 * result (severity / materials / observations / recommendations /
 * confidence) in the photo lightbox + bulk-analyze flow.
 *
 *   window.PhotoAI.analyze(photoId)            → Promise<analysis>
 *   window.PhotoAI.renderAnalysisCard(analysis)→ HTML string
 *   window.PhotoAI.severityBadge(severity)     → HTML span
 *   window.PhotoAI.injectInLightbox(photoId, container)
 *      → adds an "Analyze with AI" button or shows an existing analysis.
 *
 * ── Sister wrapper ──
 * For the per-upload AUTO-TAG path (Haiku, returns 1-tap-accept
 * chip suggestions), see photo-ai-classifier.js / PhotoAIClassifier.
 * Two paths exist by design — different cost profiles, different
 * surfaces. The split is documented at the top of
 * functions/handlers/photo.js + functions/photo-vision.js.
 *
 * Safe to include as a <script defer>. No side effects on load.
 */
(function () {
  'use strict';

  if (window.PhotoAI && window.PhotoAI.__sentinel === 'nbd-photo-ai-v1') return;

  const FUNCTIONS_BASE = (window.__NBD_FUNCTIONS_BASE
    || 'https://us-central1-nobigdeal-pro.cloudfunctions.net').replace(/\/+$/, '');

  // ─── Helpers ─────────────────────────────────────────────────────
  async function getIdToken() {
    try {
      if (window.auth && window.auth.currentUser) {
        return await window.auth.currentUser.getIdToken();
      }
    } catch (e) {}
    return null;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ─── Main analyze call ───────────────────────────────────────────
  async function analyze(photoId) {
    if (!photoId) throw new Error('photoId required');
    const token = await getIdToken();
    if (!token) throw new Error('Not signed in');

    const res = await fetch(FUNCTIONS_BASE + '/analyzeRoofPhoto', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ photoId }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data && data.error ? data.error : 'Analysis failed';
      // 429 = analyzeRoofPhoto daily cap (100/uid/day). Fire the same
      // event the Haiku classifier dispatches so any cap-aware UI
      // surface (photo-review banner, bulk-analyze toast in photo-
      // engine, etc.) sees both paths.
      if (res.status === 429) {
        try {
          window.dispatchEvent(new CustomEvent('nbd:ai-classify-skipped', {
            detail: { photoId, reason: 'daily-cap' }
          }));
        } catch (_) {}
      }
      throw new Error(msg + ' (' + res.status + ')');
    }
    return data.analysis;
  }

  // ─── UI bits ─────────────────────────────────────────────────────
  function severityBadge(severity) {
    const map = {
      none:     { label: 'No damage',  bg: '#dcfce7', fg: '#166534' },
      minor:    { label: 'Minor',      bg: '#fef9c3', fg: '#854d0e' },
      moderate: { label: 'Moderate',   bg: '#ffedd5', fg: '#9a3412' },
      severe:   { label: 'Severe',     bg: '#fee2e2', fg: '#991b1b' },
    };
    const m = map[severity] || map.none;
    return `<span style="
      display:inline-block; padding:3px 10px; border-radius:999px;
      background:${m.bg}; color:${m.fg};
      font-size:11px; font-weight:700; letter-spacing:.3px;
      text-transform:uppercase;">${escapeHtml(m.label)}</span>`;
  }

  function confidenceText(c) {
    return c === 'high' ? 'High confidence'
         : c === 'medium' ? 'Medium confidence'
         : 'Low confidence — verify visually';
  }

  function renderAnalysisCard(analysis) {
    if (!analysis) return '';

    if (analysis.notRoof) {
      return `
        <div class="pa-card pa-card-warn" style="
          border:1px solid #fbbf24; background:#fffbeb; color:#92400e;
          padding:12px 14px; border-radius:8px; margin-top:12px;
          font-size:13px; line-height:1.5;">
          <strong>Photo doesn't appear to show a roof.</strong>
          <div style="margin-top:4px;">Re-take the photo of the actual roof surface for analysis.</div>
        </div>`;
    }

    const obs = (analysis.observations || []).map(o =>
      `<li>${escapeHtml(o)}</li>`).join('');
    const recs = (analysis.recommendations || []).map(r =>
      `<li>${escapeHtml(r)}</li>`).join('');
    const mats = (analysis.materials || []).map(m =>
      `<span style="display:inline-block; padding:2px 8px; border-radius:4px;
        background:#e0e7ff; color:#3730a3; font-size:11px; font-weight:600;
        margin-right:4px;">${escapeHtml(m)}</span>`).join('');

    return `
      <div class="pa-card" style="
        border:1px solid #e5e7eb; background:#fff; color:#1f2937;
        padding:14px; border-radius:10px; margin-top:12px;
        font-size:13px; line-height:1.5;
        box-shadow:0 1px 2px rgba(0,0,0,.04);">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-bottom:10px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <strong style="font-size:14px; color:#111827;">AI Damage Analysis</strong>
            ${severityBadge(analysis.severity)}
          </div>
          <span style="font-size:11px; color:#6b7280;">${escapeHtml(confidenceText(analysis.confidence))}</span>
        </div>

        ${mats ? `<div style="margin-bottom:10px;">${mats}</div>` : ''}

        ${obs ? `
          <div style="margin-bottom:10px;">
            <div style="font-weight:600; color:#374151; margin-bottom:4px;">What I see</div>
            <ul style="margin:0; padding-left:18px; color:#1f2937;">${obs}</ul>
          </div>` : ''}

        ${recs ? `
          <div>
            <div style="font-weight:600; color:#374151; margin-bottom:4px;">Recommended next steps</div>
            <ul style="margin:0; padding-left:18px; color:#1f2937;">${recs}</ul>
          </div>` : ''}

        <div style="margin-top:10px; font-size:10px; color:#9ca3af;">
          AI-generated assessment. Always verify in person before quoting or filing claims.
        </div>
      </div>`;
  }

  // Add an "Analyze with AI" button (or render existing analysis) into
  // a container element within the photo lightbox.
  function injectInLightbox(photo, container) {
    if (!container) return;
    if (!photo || !photo.id) return;

    // Existing analysis → render it.
    if (photo.aiAnalysis) {
      container.insertAdjacentHTML('beforeend', renderAnalysisCard(photo.aiAnalysis));
      return;
    }

    // No analysis yet → render the button + status area.
    const slotId = `pa-slot-${photo.id}`;
    container.insertAdjacentHTML('beforeend', `
      <div id="${slotId}" style="margin-top:12px;">
        <button type="button" class="pa-analyze-btn" data-photo-id="${escapeHtml(photo.id)}"
          style="
            display:inline-flex; align-items:center; gap:8px;
            padding:10px 16px; border-radius:8px; border:1px solid #A14A22;
            background:linear-gradient(135deg,var(--orange,#BD5728) 0%,color-mix(in srgb,var(--orange,#BD5728) 85%,#000) 100%);
            color:#fff; font-weight:600; font-size:13px;
            cursor:pointer; box-shadow:0 1px 2px rgba(0,0,0,.08);">
          <span aria-hidden="true">✨</span>
          <span>Analyze damage with AI</span>
        </button>
        <div class="pa-status" style="margin-top:8px; font-size:12px; color:#6b7280;"></div>
      </div>`);

    const btn = container.querySelector(`#${slotId} .pa-analyze-btn`);
    const status = container.querySelector(`#${slotId} .pa-status`);
    if (!btn || !status) return;

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.style.opacity = '0.7';
      btn.style.cursor = 'wait';
      status.textContent = 'Analyzing photo (5–15 seconds)…';
      try {
        const analysis = await analyze(photo.id);
        const slot = document.getElementById(slotId);
        if (slot) slot.innerHTML = renderAnalysisCard(analysis);
        // Best-effort: refresh in-memory cache so re-opens see it.
        if (window.PhotoEngine && window.PhotoEngine.__updatePhotoCache) {
          try { window.PhotoEngine.__updatePhotoCache(photo.leadId, photo.id, { aiAnalysis: analysis }); } catch (e) {}
        }
      } catch (err) {
        btn.disabled = false;
        btn.style.opacity = '';
        btn.style.cursor = '';
        status.textContent = err.message || 'Analysis failed.';
        status.style.color = '#b91c1c';
      }
    });
  }

  // ─── Bulk analysis ───────────────────────────────────────────────
  // Analyze every photo that doesn't already have an aiAnalysis stamped.
  // Runs sequentially (not parallel) to respect the 100/day per-uid cap
  // and stay polite to the upstream model. Reports progress via the
  // optional onProgress callback: ({ index, total, photoId, status,
  // analysis?, error? }).
  //
  // Returns a summary: { total, analyzed, skipped, failed,
  //                      severityCounts: { none, minor, moderate, severe } }.
  async function bulkAnalyze(photos, onProgress) {
    if (!Array.isArray(photos)) throw new Error('photos array required');
    const todo = photos.filter(p => p && p.id && !p.aiAnalysis);
    const summary = {
      total: photos.length,
      analyzed: 0,
      skipped: photos.length - todo.length,
      failed: 0,
      severityCounts: { none: 0, minor: 0, moderate: 0, severe: 0 },
    };

    // Pre-count severities from already-analyzed photos so the summary
    // reflects the full set, not just what we touched this run.
    photos.forEach(p => {
      const sev = p && p.aiAnalysis && p.aiAnalysis.severity;
      if (sev && summary.severityCounts[sev] !== undefined) {
        summary.severityCounts[sev]++;
      }
    });

    for (let i = 0; i < todo.length; i++) {
      const photo = todo[i];
      if (typeof onProgress === 'function') {
        try { onProgress({ index: i, total: todo.length, photoId: photo.id, status: 'start' }); } catch (e) {}
      }
      try {
        const analysis = await analyze(photo.id);
        summary.analyzed++;
        if (analysis && summary.severityCounts[analysis.severity] !== undefined) {
          summary.severityCounts[analysis.severity]++;
        }
        // Patch in-memory cache so subsequent UI sees the analysis.
        if (window.PhotoEngine && typeof window.PhotoEngine.__updatePhotoCache === 'function') {
          try { window.PhotoEngine.__updatePhotoCache(photo.leadId, photo.id, { aiAnalysis: analysis }); } catch (e) {}
        }
        if (typeof onProgress === 'function') {
          try { onProgress({ index: i, total: todo.length, photoId: photo.id, status: 'done', analysis }); } catch (e) {}
        }
      } catch (err) {
        summary.failed++;
        if (typeof onProgress === 'function') {
          try { onProgress({ index: i, total: todo.length, photoId: photo.id, status: 'error', error: err.message }); } catch (e) {}
        }
        // If we hit the daily cap, stop — there's no value in burning
        // through the rest knowing they'll all 429.
        if (err.message && /limit reached/i.test(err.message)) {
          summary.failed += (todo.length - i - 1);
          break;
        }
      }
    }
    return summary;
  }

  // Render a one-line summary banner suitable for a gallery header.
  function renderSummaryBanner(summary) {
    if (!summary || summary.total === 0) return '';
    const sc = summary.severityCounts;
    const totalDamaged = sc.minor + sc.moderate + sc.severe;
    const dot = (color) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:4px;"></span>`;
    return `
      <div style="
        background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px;
        padding:10px 14px; margin-bottom:12px;
        font-size:13px; color:#374151; display:flex; flex-wrap:wrap; gap:14px; align-items:center;">
        <strong style="color:#111827;">AI Damage Summary</strong>
        <span>${summary.total} photo${summary.total === 1 ? '' : 's'}</span>
        ${totalDamaged > 0 ? `<span style="color:#991b1b;">${totalDamaged} with damage</span>` : '<span style="color:#166534;">No damage detected</span>'}
        ${sc.severe   > 0 ? `<span>${dot('#ef4444')}${sc.severe} severe</span>`     : ''}
        ${sc.moderate > 0 ? `<span>${dot('#f97316')}${sc.moderate} moderate</span>` : ''}
        ${sc.minor    > 0 ? `<span>${dot('#fbbf24')}${sc.minor} minor</span>`       : ''}
      </div>`;
  }

  window.PhotoAI = {
    __sentinel: 'nbd-photo-ai-v1',
    analyze,
    bulkAnalyze,
    renderAnalysisCard,
    renderSummaryBanner,
    severityBadge,
    injectInLightbox,
  };
})();
