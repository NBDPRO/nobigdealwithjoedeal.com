/**
 * NBD Pro — First-Run Onboarding Tour
 *
 * Lightweight 5-step guided tour for brand-new reps. Detects "no leads
 * yet" + "tour not seen", waits for the dashboard to mount, then walks
 * the rep through:
 *   1. Welcome / orientation
 *   2. Add your first lead
 *   3. Track stages on the kanban
 *   4. D2D tracker is built in
 *   5. Settings + tour restart
 *
 * Self-contained: no third-party tour libraries. Uses absolute-positioned
 * spotlight + tooltip, click outside or X dismisses, Esc dismisses.
 *
 * Storage:
 *   localStorage 'nbd-onboarding-complete' = '1' once dismissed/finished
 *
 * Public API: window.OnboardingTour.start() / stop() / forceRestart()
 */
(function() {
  'use strict';

  const STORAGE_KEY = 'nbd-onboarding-complete';
  let _stepIdx = 0;
  let _dir = 1; // travel direction: +1 Next / -1 Back — drives the skip loop
  let _overlay = null;

  // Tour steps. Each has:
  //   anchor:       CSS selector for the element to spotlight (or null = centered)
  //   title:        Short headline
  //   body:         One-paragraph explanation
  //   ctaLabel:     Optional CTA button label (e.g. "Add a lead")
  //   ctaAction:    Function called when CTA clicked (closes tour first)
  //   placement:    'top' | 'bottom' | 'left' | 'right' | 'center'
  // Steps trimmed to <30 words each. Each step has a `learnMore` anchor
  // pointing into how-to.html — the tour gives the 30-second version, the
  // how-to handles the deep dive. New users get oriented without reading
  // a wall of text per spotlight.
  const STEPS = [
    {
      anchor:    null,
      title:     'Welcome to NBD Pro 👋',
      body:      "Quick 30-second tour so you know where everything lives. You can re-run this anytime, and there's a full how-to one click away if you want the deep version.",
      placement: 'center'
    },
    {
      anchor:    '#nav-crm',
      title:     'Pipeline is home base',
      body:      "Every lead lives on the kanban. Drag cards across columns as deals move — Inspected → Estimate Sent → Contract Signed → Closed.",
      learnMore: 'how-to.html#kanban',
      placement: 'right'
    },
    {
      anchor:    '#addLeadFab, #crmAddLeadBtn, #mni-create, #prospectsToggleBtn',
      title:     'Add your first lead',
      body:      "Tap the orange + button. Name + address is enough — you can fill in damage, claim, or job value later.",
      ctaLabel:  '＋ Add a lead now',
      ctaAction: () => { if (typeof window.openLeadModal === 'function') window.openLeadModal(); },
      learnMore: 'how-to.html#leads',
      placement: 'left'
    },
    {
      anchor:    '#nav-d2d',
      title:     'Door-to-Door built in',
      body:      "Tap a door, log the disposition, and it saves with GPS. Storm and insurance knocks auto-create leads as Prospects.",
      learnMore: 'how-to.html#d2d',
      placement: 'right'
    },
    {
      anchor:    '.hdr-tool[data-target="settings"], #hdrMobileBtn',
      title:     'Make it yours',
      body:      "Settings has themes, UI sizes, and card density. The connection dot in the top right is also a refresh button.",
      learnMore: 'how-to.html#settings',
      placement: 'left'
    },
    {
      anchor:    null,
      title:     "You're set 🚀",
      body:      "Go build pipeline. Want the deep version? The how-to walks every feature step by step — open it anytime from the menu or the connection dot.",
      ctaLabel:  '📖 Open the full How-To',
      ctaAction: () => { window.location.href = '/pro/how-to'; },
      placement: 'center'
    }
  ];

  // ────────────────────────────────────────────────────────────────────
  // CSS injection (one-time)
  // ────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('nbd-onb-css')) return;
    const css = `
      .nbd-onb-overlay{
        position:fixed; inset:0; z-index:99990;
        background:rgba(0,0,0,.65);
        -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px);
        display:flex; align-items:center; justify-content:center;
        animation:nbd-onb-fade .2s ease;
      }
      @keyframes nbd-onb-fade { from { opacity:0; } to { opacity:1; } }

      .nbd-onb-spotlight{
        position:fixed; pointer-events:none;
        border-radius:10px;
        box-shadow:0 0 0 9999px rgba(0,0,0,.65), 0 0 0 3px var(--orange,#BD5728);
        transition:all .4s cubic-bezier(.4, 0, .2, 1);
        z-index:99991;
      }

      .nbd-onb-tooltip{
        position:fixed;
        max-width:440px; width:calc(100vw - 32px);
        background:var(--s,#16213e); border:1px solid var(--br,#2a2d35);
        border-radius:14px; padding:26px 28px 22px;
        box-shadow:0 18px 52px rgba(0,0,0,.55);
        color:var(--t,#e8eaf0);
        font-family:'Barlow',sans-serif;
        z-index:99992;
        animation:nbd-onb-pop .32s cubic-bezier(.16, 1, .3, 1);
      }
      @keyframes nbd-onb-pop {
        from { opacity:0; transform:translateY(-8px) scale(.97); }
        to   { opacity:1; transform:translateY(0)    scale(1);   }
      }
      .nbd-onb-tooltip-center{ position:relative; max-width:500px; padding:32px 32px 26px; }

      .nbd-onb-step{
        font-size:10px; font-weight:700; letter-spacing:.14em;
        text-transform:uppercase; color:var(--orange,#BD5728);
        margin-bottom:10px;
      }
      .nbd-onb-title{
        font-family:'Barlow Condensed',sans-serif;
        font-size:26px; font-weight:800; letter-spacing:.02em;
        line-height:1.15; margin-bottom:12px;
        color:var(--t,#e8eaf0);
      }
      .nbd-onb-body{
        font-size:14px; line-height:1.65; color:var(--m,#9ca3af);
        margin-bottom:20px;
      }
      .nbd-onb-learn{
        display:inline-block; margin-bottom:18px;
        color:var(--orange,#BD5728); text-decoration:none;
        font-size:12px; font-weight:600;
        border-bottom:1px dashed currentColor; padding-bottom:1px;
      }
      .nbd-onb-learn:hover{ filter:brightness(1.15); }
      .nbd-onb-actions{
        display:flex; align-items:center; gap:12px;
        flex-wrap:wrap; margin-top:4px;
      }
      .nbd-onb-btn{
        background:var(--orange,#BD5728); color:#fff; border:none;
        padding:11px 20px; border-radius:8px;
        font-family:inherit; font-size:13px; font-weight:700;
        letter-spacing:.02em;
        cursor:pointer; transition:all .15s;
        min-height:40px;
      }
      .nbd-onb-btn:hover{ filter:brightness(1.08); transform:translateY(-1px); }
      .nbd-onb-btn-ghost{
        background:transparent; color:var(--m,#9ca3af);
        border:1px solid var(--br,#2a2d35);
      }
      .nbd-onb-btn-ghost:hover{ color:var(--t,#e8eaf0); border-color:var(--t,#e8eaf0); }
      .nbd-onb-skip{
        margin-left:auto;
        background:transparent; border:none;
        color:var(--m,#9ca3af); cursor:pointer;
        font-size:11px; font-weight:600;
        padding:8px 10px; border-radius:4px;
      }
      .nbd-onb-skip:hover{ color:var(--t,#e8eaf0); text-decoration:underline; }

      .nbd-onb-progress{
        display:flex; gap:6px; margin-top:20px;
      }
      .nbd-onb-dot{
        flex:1; height:3px; border-radius:2px;
        background:color-mix(in srgb, var(--m,#9ca3af) 30%, transparent);
        transition:background .25s;
      }
      .nbd-onb-dot.active{ background:var(--orange,#BD5728); }
      .nbd-onb-dot.done{ background:color-mix(in srgb, var(--orange,#BD5728) 50%, transparent); }

      /* Mobile: a little more padding, but still cap the title size */
      @media (max-width:480px){
        .nbd-onb-tooltip{ padding:22px 22px 18px; border-radius:12px; }
        .nbd-onb-title{ font-size:22px; }
        .nbd-onb-body{ font-size:14px; }
      }
    `;
    const style = document.createElement('style');
    style.id = 'nbd-onb-css';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ────────────────────────────────────────────────────────────────────
  // Spotlight + tooltip positioning
  // ────────────────────────────────────────────────────────────────────
  function findAnchor(selector) {
    if (!selector) return null;
    // Try each comma-separated selector in order; first one that exists + is
    // visible wins. Visibility = a real layout box + not hidden. The old
    // offset-parent test was wrong two ways: it is null for position:fixed
    // elements that ARE visible (the add-lead FAB, the mobile bottom nav),
    // and non-null for visibility:hidden ones.
    for (const sel of selector.split(',').map(s => s.trim()).filter(Boolean)) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none') return el;
    }
    return null;
  }

  function positionSpotlight(target) {
    let spot = document.getElementById('nbd-onb-spotlight');
    if (!spot) {
      spot = document.createElement('div');
      spot.id = 'nbd-onb-spotlight';
      spot.className = 'nbd-onb-spotlight';
      document.body.appendChild(spot);
    }
    if (!target) {
      spot.style.display = 'none';
      return;
    }
    spot.style.display = 'block';
    const r = target.getBoundingClientRect();
    const pad = 8;
    spot.style.top    = (r.top    - pad) + 'px';
    spot.style.left   = (r.left   - pad) + 'px';
    spot.style.width  = (r.width  + pad*2) + 'px';
    spot.style.height = (r.height + pad*2) + 'px';
  }

  function positionTooltip(tip, target, placement) {
    if (!target || placement === 'center') {
      tip.classList.add('nbd-onb-tooltip-center');
      tip.style.position = 'fixed';
      tip.style.top = '50%';
      tip.style.left = '50%';
      tip.style.transform = 'translate(-50%, -50%)';
      return;
    }
    tip.classList.remove('nbd-onb-tooltip-center');
    const r = target.getBoundingClientRect();
    const tipR = tip.getBoundingClientRect();
    const margin = 16;
    let top, left;
    switch (placement) {
      case 'top':
        top  = r.top - tipR.height - margin;
        left = r.left + (r.width / 2) - (tipR.width / 2);
        break;
      case 'bottom':
        top  = r.bottom + margin;
        left = r.left + (r.width / 2) - (tipR.width / 2);
        break;
      case 'right':
        top  = r.top + (r.height / 2) - (tipR.height / 2);
        left = r.right + margin;
        break;
      case 'left':
      default:
        top  = r.top + (r.height / 2) - (tipR.height / 2);
        left = r.left - tipR.width - margin;
        break;
    }
    // Clamp to viewport
    top  = Math.max(8, Math.min(top,  window.innerHeight - tipR.height - 8));
    left = Math.max(8, Math.min(left, window.innerWidth  - tipR.width  - 8));
    tip.style.top  = top  + 'px';
    tip.style.left = left + 'px';
    tip.style.transform = '';
  }

  // ────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderStep() {
    // Direction-aware skip: an anchored step whose anchor is missing or
    // hidden right now (wrong view, collapsed sidebar, mobile breakpoint)
    // is skipped in the direction of travel instead of rendering a
    // floating centered tooltip pointing at nothing. Forward exhaustion
    // falls into the `if (!step) complete()` below; backward exhaustion
    // clamps to step 0, which must stay placement:'center' (always
    // renderable) so this loop terminates in both directions.
    while (STEPS[_stepIdx] && STEPS[_stepIdx].placement !== 'center'
           && STEPS[_stepIdx].anchor && !findAnchor(STEPS[_stepIdx].anchor)) {
      _stepIdx += _dir;
      if (_stepIdx < 0) { _stepIdx = 0; break; }
    }
    const step = STEPS[_stepIdx];
    if (!step) { complete(); return; }
    const target = findAnchor(step.anchor);

    // Build / find the overlay backdrop (shown only on the centered step)
    if (step.placement === 'center') {
      if (!_overlay) {
        _overlay = document.createElement('div');
        _overlay.className = 'nbd-onb-overlay';
        _overlay.id = 'nbd-onb-overlay';
        document.body.appendChild(_overlay);
      } else {
        _overlay.style.display = 'flex';
      }
      positionSpotlight(null);
    } else {
      if (_overlay) _overlay.style.display = 'none';
      positionSpotlight(target);
    }

    // Tooltip
    let tip = document.getElementById('nbd-onb-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'nbd-onb-tooltip';
      tip.className = 'nbd-onb-tooltip';
      document.body.appendChild(tip);
    }
    const isLast = _stepIdx === STEPS.length - 1;
    const isFirst = _stepIdx === 0;
    const dots = STEPS.map((_, i) => {
      const cls = i < _stepIdx ? 'done' : (i === _stepIdx ? 'active' : '');
      return `<div class="nbd-onb-dot ${cls}"></div>`;
    }).join('');

    // Step label: hide step counter on the first AND last centered steps
    // so welcome and the closer don't say "STEP 0 OF 5" awkwardly. The
    // anchored steps in between get a clean 'STEP N OF M'.
    const stepLabel = isFirst
      ? 'GET STARTED'
      : isLast
      ? "YOU'RE READY"
      : `STEP ${_stepIdx} OF ${STEPS.length - 2}`;

    const learnLink = step.learnMore
      ? `<a class="nbd-onb-learn" href="${escHtml(step.learnMore)}" target="_blank" rel="noopener">Learn more →</a>`
      : '';

    tip.innerHTML = `
      <div class="nbd-onb-step">${stepLabel}</div>
      <div class="nbd-onb-title">${escHtml(step.title)}</div>
      <div class="nbd-onb-body">${escHtml(step.body)}</div>
      ${learnLink}
      <div class="nbd-onb-actions">
        ${!isFirst ? '<button class="nbd-onb-btn nbd-onb-btn-ghost" data-act="back">← Back</button>' : ''}
        ${step.ctaLabel ? `<button class="nbd-onb-btn" data-act="cta">${escHtml(step.ctaLabel)}</button>` : ''}
        <button class="nbd-onb-btn ${step.ctaLabel ? 'nbd-onb-btn-ghost' : ''}" data-act="next">${isLast ? 'Got it' : 'Next →'}</button>
        <button class="nbd-onb-skip" data-act="skip">${isFirst ? 'Skip tour' : 'Skip'}</button>
      </div>
      <div class="nbd-onb-progress">${dots}</div>
    `;

    tip.querySelectorAll('button[data-act]').forEach(b => {
      b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'next')      { _dir = 1; _stepIdx++; renderStep(); }
        else if (act === 'back') { _dir = -1; _stepIdx = Math.max(0, _stepIdx - 1); renderStep(); }
        else if (act === 'skip') { complete(); }
        else if (act === 'cta')  {
          complete();
          if (typeof step.ctaAction === 'function') {
            try { step.ctaAction(); } catch (e) { console.warn('Tour CTA failed:', e); }
          }
        }
      });
    });

    // Position NOW as well (2026-09-30): the tooltip used to sit unplaced, with
    // no centered class, for two frames after this write, which is a visible
    // flash, and a slow CI runner sampled the Welcome step inside that gap
    // (onboarding-tour-anchors @audit). The pass below re-positions once
    // layout has settled, for anchored steps that need the tooltip's size.
    positionTooltip(tip, target, step.placement);
    // Re-position after innerHTML write (next tick so layout settles)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => positionTooltip(tip, target, step.placement));
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ────────────────────────────────────────────────────────────────────
  function complete() {
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch (e) {}
    document.getElementById('nbd-onb-tooltip')?.remove();
    document.getElementById('nbd-onb-spotlight')?.remove();
    if (_overlay) { _overlay.remove(); _overlay = null; }
    document.removeEventListener('keydown', _onKey, true);
    window.removeEventListener('resize', _onResize);
  }

  function _onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); complete(); }
    else if (e.key === 'ArrowRight') { _dir = 1; _stepIdx++; renderStep(); }
    else if (e.key === 'ArrowLeft') { _dir = -1; _stepIdx = Math.max(0, _stepIdx - 1); renderStep(); }
  }
  function _onResize() {
    const tip = document.getElementById('nbd-onb-tooltip');
    if (!tip) return;
    const step = STEPS[_stepIdx];
    if (!step) return;
    const target = findAnchor(step.anchor);
    // If the resize hid the current anchor (e.g. desktop→mobile collapsed
    // the sidebar mid-step), re-render so the skip logic runs instead of
    // positionTooltip's silent center fallback.
    if (!target && step.placement !== 'center' && step.anchor) { renderStep(); return; }
    positionTooltip(tip, target, step.placement);
    positionSpotlight(target);
  }

  function start(force) {
    if (!force) {
      try { if (localStorage.getItem(STORAGE_KEY) === '1') return; } catch (e) {}
    }
    _stepIdx = 0;
    _dir = 1;
    injectStyles();
    document.addEventListener('keydown', _onKey, true);
    window.addEventListener('resize', _onResize);
    // Wait one frame so the dashboard layout settles before the first
    // anchor lookup (the kanban + sidebar mount async).
    requestAnimationFrame(() => requestAnimationFrame(renderStep));
  }

  // Auto-trigger: first time, on the dashboard, with no leads.
  // NEW-D24: how-to.html's "▶ Restart Tour" sets the one-shot FORCE_KEY before
  // navigating here — an explicit request must fire the tour even when the user
  // has leads, otherwise the has-leads branch below silently re-marks the tour
  // complete and the button is a no-op for exactly the users who click it.
  const FORCE_KEY = 'nbd-tour-force';
  function maybeAutoStart() {
    let force = false;
    try {
      force = localStorage.getItem(FORCE_KEY) === '1';
      if (force) localStorage.removeItem(FORCE_KEY); // one-shot
    } catch (e) {}
    try { if (!force && localStorage.getItem(STORAGE_KEY) === '1') return; } catch (e) { return; }
    // Wait for leads to load before deciding "is this a first-time user"
    let attempts = 0;
    const t = setInterval(() => {
      attempts++;
      // Only auto-start if leads have loaded (or 8s elapsed) AND there
      // are zero leads. If they have any data we don't want to interrupt.
      if (window._leadsLoaded || attempts > 80) {
        clearInterval(t);
        if (force) {
          // Explicit restart: skip the zero-leads heuristic. Shorter breath —
          // the user just asked for the tour, no need to ease them in.
          setTimeout(() => start(true), 500);
          return;
        }
        const leads = window._leads || [];
        if (leads.length === 0) {
          // Give the user a breath to take in the empty dashboard before
          // the tour overlay drops in. 1.5s feels deliberate, not
          // hijacked — 800ms felt rushed in usability testing.
          setTimeout(() => start(false), 1500);
        } else {
          // Has leads — tour shouldn't fire, but mark it complete so we
          // don't keep polling on every page load
          try { localStorage.setItem(STORAGE_KEY, '1'); } catch (e) {}
        }
      }
    }, 100);
  }

  window.OnboardingTour = {
    start,
    stop: complete,
    forceRestart: () => { try { localStorage.removeItem(STORAGE_KEY); } catch(e){} start(true); }
  };

  // Auto-boot: wait for DOM + first paint
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeAutoStart);
  } else {
    maybeAutoStart();
  }
})();
