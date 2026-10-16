/**
 * before-after-slider.js — D-2.7
 * ─────────────────────────────────────────────────────────────────
 *
 * Draggable Before / After photo comparison slider for the homeowner
 * portal. Same UX as CompanyCam / Houzz — homeowner drags a vertical
 * divider left/right to reveal the After photo over the Before.
 *
 * Public API:
 *   NBDBeforeAfter.render(mount, { before, after, location, idx })
 *     mount    — DOM element to render into (gets cleared)
 *     before   — { url, caption? }
 *     after    — { url, caption? }
 *     location — string label (rendered under the slider)
 *     idx      — index in a list of pairs (used in the aria label)
 *
 * Implementation notes:
 *   - Vanilla JS, no library — same defer-loaded script style as
 *     the rest of the portal page
 *   - Pointer Events used so one handler covers mouse + touch +
 *     pen + Apple Pencil; bypasses the touch/mouse event split
 *   - The "After" image is the layer below; "Before" is layered on
 *     top and clip-path'd to the dragged x position. This is the
 *     cheaper render (no two-image swap on every move).
 *   - The handle itself is a thin vertical line with a circular grip.
 *     Brand-orange so it reads as an NBD element, not a stock widget.
 */
(function () {
  'use strict';
  if (window.NBDBeforeAfter && window.NBDBeforeAfter.__sentinel === 'nbd-ba-v1') return;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function ensureStyles() {
    if (document.getElementById('nbd-ba-styles')) return;
    const s = document.createElement('style');
    s.id = 'nbd-ba-styles';
    s.textContent = `
      .nbd-ba {
        position: relative;
        width: 100%;
        aspect-ratio: 4 / 3;
        background: #0a1424;
        border-radius: 10px;
        overflow: hidden;
        user-select: none;
        -webkit-user-select: none;
        /* pan-y, not none (phone audit, 2026-09-25): with none, the browser
           handed EVERY touch to the drag handler, so a thumb that landed on a
           slider while scrolling the portal could not scroll the page — and
           three stacked sliders cover ~58% of a phone screen, leaving only
           41px gutters to scroll by. pan-y keeps vertical swipes for the page
           and pinch-zoom for the photo; horizontal drags still come here.
           Plain pan-y first: a browser that rejects the pinch-zoom value
           (older iOS Safari) drops that whole line and keeps this one. */
        touch-action: pan-y;
        touch-action: pan-y pinch-zoom;
        cursor: ew-resize;
      }
      .nbd-ba .nbd-ba-layer {
        position: absolute;
        inset: 0;
      }
      .nbd-ba .nbd-ba-layer img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        pointer-events: none;
      }
      .nbd-ba .nbd-ba-before {
        clip-path: inset(0 50% 0 0);
        will-change: clip-path;
      }
      .nbd-ba .nbd-ba-label {
        position: absolute;
        top: 10px;
        padding: 4px 10px;
        font: 700 10px/1 'Barlow', sans-serif;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #fff;
        background: rgba(0,0,0,0.55);
        border-radius: 999px;
        backdrop-filter: blur(4px);
        pointer-events: none;
      }
      .nbd-ba .nbd-ba-label.left  { left: 12px; }
      .nbd-ba .nbd-ba-label.right { right: 12px; }
      .nbd-ba .nbd-ba-handle {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: rgba(255,255,255,0.95);
        transform: translateX(-50%);
        left: 50%;
        will-change: left;
        pointer-events: none;
        box-shadow: 0 0 12px rgba(0,0,0,0.45);
      }
      .nbd-ba .nbd-ba-grip {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 38px;
        height: 38px;
        border-radius: 50%;
        background: var(--accent, #A14A22);
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        font-weight: 900;
        font-size: 14px;
        font-family: 'Barlow Condensed', sans-serif;
        letter-spacing: 0.04em;
      }
      .nbd-ba .nbd-ba-grip svg { width: 18px; height: 18px; }
      .nbd-ba-meta {
        margin-top: 8px;
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        font-size: 12px;
        color: var(--muted, #888);
      }
      .nbd-ba-meta .nbd-ba-location {
        font-weight: 700;
        color: var(--text, inherit);
        letter-spacing: 0.04em;
      }
      .nbd-ba-meta .nbd-ba-hint {
        font-size: 11px;
        font-style: italic;
      }
    `;
    document.head.appendChild(s);
  }

  function render(mount, opts) {
    ensureStyles();
    if (!mount || !opts || !opts.before || !opts.after) return;
    const beforeUrl = opts.before.url || opts.before;
    const afterUrl  = opts.after.url  || opts.after;
    const location  = opts.location || '';
    const idx       = typeof opts.idx === 'number' ? opts.idx : 0;

    const ariaLabel = location
      ? 'Before and after comparison — ' + location
      : 'Before and after comparison ' + (idx + 1);

    const wrap = document.createElement('figure');
    wrap.className = 'nbd-ba-wrap';
    wrap.style.cssText = 'margin:0;';
    wrap.innerHTML = `
      <div class="nbd-ba" role="img" aria-label="${esc(ariaLabel)}">
        <div class="nbd-ba-layer nbd-ba-after">
          <img src="${esc(afterUrl)}" alt="After">
        </div>
        <div class="nbd-ba-layer nbd-ba-before">
          <img src="${esc(beforeUrl)}" alt="Before">
        </div>
        <div class="nbd-ba-label left">Before</div>
        <div class="nbd-ba-label right">After</div>
        <div class="nbd-ba-handle">
          <div class="nbd-ba-grip" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 3 12 9 6"/>
              <polyline points="15 6 21 12 15 18"/>
            </svg>
          </div>
        </div>
      </div>
      ${location
        ? `<figcaption class="nbd-ba-meta"><span class="nbd-ba-location">${esc(location)}</span><span class="nbd-ba-hint">Drag the handle to compare</span></figcaption>`
        : `<figcaption class="nbd-ba-meta"><span></span><span class="nbd-ba-hint">Drag the handle to compare</span></figcaption>`}
    `;
    mount.innerHTML = '';
    mount.appendChild(wrap);

    // ── Drag wiring ──
    const baEl     = wrap.querySelector('.nbd-ba');
    const handle   = wrap.querySelector('.nbd-ba-handle');
    const before   = wrap.querySelector('.nbd-ba-before');

    let dragging = false;
    // A touch is only a drag once it has moved sideways more than it has
    // moved up or down. Until then it may still be the start of a page
    // scroll (touch-action: pan-y above), so it must not move the handle:
    // jumping the handle to wherever the thumb landed on pointerdown is what
    // made a scroll attempt yank the photo to 68%. The browser answers a
    // vertical swipe with pointercancel, which drops the pending touch.
    let pendingTouch = null;
    const TOUCH_SLOP = 6; // px, roughly the platform's own tap slop

    function setRatio(r) {
      // Clamp to a tiny margin on both sides so the labels stay visible.
      const ratio = Math.min(0.99, Math.max(0.01, r));
      const pct = (ratio * 100).toFixed(2) + '%';
      handle.style.left = pct;
      before.style.clipPath = 'inset(0 ' + (100 - ratio * 100).toFixed(2) + '% 0 0)';
    }

    function eventRatio(ev) {
      const rect = baEl.getBoundingClientRect();
      const x = (ev.clientX != null ? ev.clientX : 0) - rect.left;
      return x / rect.width;
    }

    function startDrag(ev) {
      dragging = true;
      try { baEl.setPointerCapture(ev.pointerId); } catch (_) {}
      setRatio(eventRatio(ev));
    }
    function onPointerDown(ev) {
      if (ev.pointerType === 'touch') {
        // No preventDefault: that would claim the gesture before we know
        // which way it is going.
        pendingTouch = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
        return;
      }
      // Mouse / pen: unchanged — press anywhere jumps the handle there.
      startDrag(ev);
      ev.preventDefault();
    }
    function onPointerMove(ev) {
      if (pendingTouch && ev.pointerId === pendingTouch.id) {
        const dx = Math.abs(ev.clientX - pendingTouch.x);
        const dy = Math.abs(ev.clientY - pendingTouch.y);
        if (dx < TOUCH_SLOP || dx <= dy) return;
        pendingTouch = null;
        startDrag(ev);
        return;
      }
      if (!dragging) return;
      setRatio(eventRatio(ev));
    }
    function onPointerUp(ev) {
      // A touch that never moved is a tap: reveal up to the tapped point,
      // the same thing a mouse click does.
      if (ev.type === 'pointerup' && pendingTouch && ev.pointerId === pendingTouch.id) {
        setRatio(eventRatio(ev));
      }
      pendingTouch = null;
      dragging = false;
      try { baEl.releasePointerCapture(ev.pointerId); } catch (_) {}
    }

    baEl.addEventListener('pointerdown', onPointerDown);
    baEl.addEventListener('pointermove', onPointerMove);
    baEl.addEventListener('pointerup',   onPointerUp);
    baEl.addEventListener('pointercancel', onPointerUp);

    // Keyboard accessibility: arrow keys nudge by 5%, home/end pin
    baEl.tabIndex = 0;
    baEl.addEventListener('keydown', (e) => {
      const cur = parseFloat(handle.style.left) / 100 || 0.5;
      if (e.key === 'ArrowLeft')  { setRatio(cur - 0.05); e.preventDefault(); }
      if (e.key === 'ArrowRight') { setRatio(cur + 0.05); e.preventDefault(); }
      if (e.key === 'Home')       { setRatio(0.02);       e.preventDefault(); }
      if (e.key === 'End')        { setRatio(0.98);       e.preventDefault(); }
    });

    return wrap;
  }

  window.NBDBeforeAfter = {
    __sentinel: 'nbd-ba-v1',
    render
  };
})();
