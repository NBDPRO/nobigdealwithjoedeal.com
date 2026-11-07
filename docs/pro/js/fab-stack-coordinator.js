/**
 * fab-stack-coordinator.js — Wave 149; bottom-edge arbiter since 2026-07
 *
 * Owns the bottom edge of the viewport. Two jobs, one owner, because
 * both answer the same question: "what else is down there right now?"
 *
 * 1. HIDE ON MODAL.
 *    Hides the bottom-right FAB stack (W128 mic, W130 quick-capture,
 *    W132 inbox) whenever a full-screen modal is open. Without this,
 *    the FABs floated on top of W130's record modal, the W144
 *    supplement modal, the W146 estimate viewer, etc — covering
 *    content + giving the rep a stale set of tap targets that don't
 *    make sense in the current context.
 *
 *    Detection strategy: a MutationObserver watches document.body
 *    for known modal IDs being added/removed (the same set the
 *    keyboard ESC handlers in those modules use). When ANY of them
 *    is present + visible, the FAB stack opacity drops + pointer-
 *    events disable. When all are absent, FABs return.
 *
 *    The list of "blocking modals" is intentionally narrow — random
 *    dropdowns, toasts, and small banners do NOT hide the FABs. Only
 *    full-screen overlays that take focus.
 *
 * 2. ARBITRATE THE BOTTOM EDGE.
 *    Measures every element that has DECLARED itself bottom chrome and
 *    publishes the result as CSS custom properties on :root, which the
 *    stylesheets consume. Full contract + authoring rules in the block
 *    comment above _measureBottomEdge.
 *
 * A modal is simply the degenerate claim in that model: it claims the
 * whole viewport, so the stack disappears outright instead of shuffling
 * upward. That is why both jobs belong to one module — split them and
 * the two answers drift apart, which is exactly how five different
 * modules each ended up hard-coding their own corner offset.
 *
 * The contract is deliberately DOM-attribute-IN → CSS-custom-property-OUT
 * with no exported API: nothing may be published on window (Tranche-Zero
 * global ban, tests/smoke/dashboard.test.js), so page modules cannot
 * reach in here to ask where the bottom edge is — they declare an
 * attribute and read a variable from CSS.
 */
(function () {
  'use strict';
  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['fab-stack-coordinator']) return;
  __NBD_LOADED['fab-stack-coordinator'] = true;

  const FAB_IDS = [
    'nbd-whisper-fab',          // W128
    'nbd-qc-fab',               // W130
    'nbd-qci-fab',              // W132
    'addLeadFab',               // Add Lead — revived + restacked 2026-07-06
    'nbd-fab-dial',             // mobile speed-dial launcher (fab-speed-dial.js)
    'nbd-vr-fab',               // the bottom-left record button (visit-recorder-launcher.js, 2026-11-07)
  ];

  const BLOCKING_MODAL_IDS = [
    'nbd-qc-modal',             // W130 Quick Capture full-screen
    'nbd-qci-modal',            // W132 Capture inbox modal
    'nbd-cmd-modal',            // W133 Cmd+K palette
    'nbd-supplement-modal',     // W144 supplement builder
    'nbd-lead-alert-stack',     // W139 hot-lead toast stack — DOESN'T block, see below
    'estV2Modal',               // V2 estimate builder
    'nbd-picker-modal',         // appearance picker
    // W150 PWA install banner sits at z-index:99990 with bottom:14px,
    // covering the FAB stack region on phones. Without coordinating
    // the FABs would still be visible BEHIND the banner but tap-blocked
    // by it — the rep sees mic / inbox icons they can't reach. Treat
    // the banner like any other blocking overlay and hide the FABs
    // while it's mounted.
    'nbd-pwa-install-banner',
    'nbd-pwa-ios-modal',        // W150 iOS Add-to-Home-Screen walkthrough
    'nbd-pwa-and-modal',        // W150 Android install fallback walkthrough
    // Add Lead revival (2026-07-06): the lead + quick-add modals are
    // .modal-bg overlays at z-index 2000 — BELOW the FAB stack's 9999 —
    // so without coordination the newly restacked Add Lead FAB (and the
    // mic/capture FABs) float on top of the very modal the FAB opened.
    'leadModal',                // full Add/Edit Lead modal (class-toggled)
    'quickAddModal',            // mobile 3-tap quick add (class-toggled)
    // Visual QA 2026-07-06 (emulator screenshots): the onboarding tour's
    // full-screen overlay rendered UNDER the FAB stack — the buttons
    // floated over the welcome dialog. Mounted on open / removed on
    // close, so display-toggle presence semantics are correct.
    'nbd-onb-overlay',
  ];

  // The lead-alert stack lists itself but should NOT trigger hide
  // (the stack is non-modal — it sits next to the FABs). Filter it.
  const _BLOCK_SET = new Set(BLOCKING_MODAL_IDS.filter(id => id !== 'nbd-lead-alert-stack'));

  // Modals that toggle a `.open` class instead of style.display —
  // _isModalActive treats presence-in-DOM as open for display-toggled
  // ids, which would read these as permanently open (they live in the
  // static HTML). estV2Modal was the original case; the lead modals
  // joined 2026-07-06.
  //
  // nbd-picker-modal is the load-bearing entry: it is STATIC in
  // dashboard.html and class-toggled (theme-bridge.css `.open` →
  // display:flex; maps.js nbdPickerOpen/Close flip the class, never
  // inline style) — but Wave 149 listed it as display-toggled, so
  // "presence = open" made _isModalActive() TRUE on every dashboard
  // load and the ENTIRE FAB stack (mic / quick-capture / inbox) has
  // been opacity-0 + untappable since. Found 2026-07-06 by the
  // add-lead revival E2E, whose restore assertion could never pass.
  const _CLASS_TOGGLED = new Set(['estV2Modal', 'leadModal', 'quickAddModal', 'nbd-picker-modal']);

  function _isModalActive() {
    for (const id of _BLOCK_SET) {
      const el = document.getElementById(id);
      if (!el) continue;
      const style = el.style;
      // Class-toggled modals (estV2Modal, leadModal, quickAddModal) flip
      // a `.open` class; others toggle display.
      if (_CLASS_TOGGLED.has(id)) {
        if (el.classList && el.classList.contains('open')) return true;
        continue;
      }
      // Display-toggle modals: visible when display !== 'none' (or
      // missing → defaults to flex/block per the modal's CSS rule).
      if (style.display === 'none') continue;
      // Some modals only exist in DOM when open; mere presence = open.
      return true;
    }
    return false;
  }

  function _applyHidden(hide) {
    FAB_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (hide) {
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        el.setAttribute('aria-hidden', 'true');
      } else {
        el.style.opacity = '';
        el.style.pointerEvents = '';
        el.removeAttribute('aria-hidden');
      }
    });
  }

  // ── Bottom-edge arbitration (2026-07) ────────────────────────────
  // This module is the single owner of the bottom edge. It measures the
  // DOM and publishes two lengths on :root; nothing else may hard-code a
  // corner offset for another module's element.
  //
  //   --nbd-bottom-chrome  = SUM of the heights of full-width fixed
  //                          strips pinned to bottom:0
  //                          ([data-nbd-bottom-strip]). Scroll surfaces
  //                          reserve it; #mobile-nav / toast / lead-alert
  //                          ride above it.
  //   --nbd-corner-claimed = MAX bottom-occupancy of any SHORT control
  //                          sitting on the bottom edge inside the right
  //                          rail ([data-nbd-corner-claim], plus the
  //                          strips above). The FAB stack translates up
  //                          by this much (rule in mobile-polish.css).
  //
  // RULES for anyone adding an attribute:
  //   * Never mark a FAB, #mobile-nav, or any element the FAB ladder
  //     already hard-codes clearance for — that double-counts. The nav's
  //     62px is already baked into the 78/138/196px bottom ladder.
  //   * Never mark a TALL panel (map legends, .nbd-pin-panel,
  //     .nbd-cust-panel). The height/position gates below drop it
  //     silently; tall panels partition HORIZONTALLY via --nbd-fab-rail,
  //     because a vertical claim on a 46vh panel would launch the FAB
  //     stack into the middle of the screen.
  //   * Never mark TRANSIENT chrome (toasts, the lead-alert stack). A
  //     claim is a layout promise; making one appear and vanish would
  //     make the whole stack jump every time a toast fires. Same
  //     remedy — move it sideways out of the rail.
  //   * getClientRects().length === 0 for display:none and for the
  //     contents of an un-hydrated <template>, so a never-visited view
  //     correctly claims nothing. No registration/teardown bookkeeping.

  // The horizontal lane the FAB column owns. STATIC — a design constant,
  // not a measurement: 94 = the widest desktop FAB (#nbd-whisper-fab,
  // right:20px + 54px wide) plus margin. Published as --nbd-fab-rail so
  // that everything else competing for the bottom-right corner moves
  // SIDEWAYS out of the lane instead of stacking on top of the FABs.
  const _FAB_RAIL_PX = 94;
  // Widest reach of any FAB measured from the RIGHT viewport edge — the
  // mobile fan-out puts #nbd-qci-fab's left edge at x = vw - 246. A
  // control whose right edge lands further left than this can never
  // share pixels with the stack, so it claims nothing even when it is
  // short and sitting on the bottom edge. Judgement call, not a
  // measurement: if a future FAB fans out wider, this must grow with it.
  const _CORNER_RAIL_PX = 260;
  // Breathing room between a claimant's top edge and the FAB above it.
  const _CLAIM_GAP_PX   = 8;
  function _measureBottomEdge() {
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const vw = window.innerWidth  || document.documentElement.clientWidth  || 0;
    // A zero viewport means a detached/backgrounded document; measuring
    // it would publish a meaningless 0px and drop every FAB for a frame.
    if (!vh || !vw) return;
    let strip = 0, claimed = 0;
    document.querySelectorAll(
      '[data-nbd-bottom-strip],[data-nbd-corner-claim]'
    ).forEach((el) => {
      if (!el.getClientRects().length) return;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const isStrip = el.hasAttribute('data-nbd-bottom-strip');
      // The SUM is taken on the strength of the declaration alone: a
      // strip promises to be full-width at bottom:0, and a scroll
      // surface has to reserve its height regardless of the corner
      // geometry. The gates below govern the corner CLAIM only.
      if (isStrip) strip += Math.ceil(r.height);
      if (r.bottom < vh * 0.75) return;    // not actually on the bottom edge
      if (r.height > vh * 0.30) return;    // a panel, not a bar — see RULES
      if (!isStrip && (vw - r.right) > _CORNER_RAIL_PX) return;  // not in the rail
      // A strip claims its HEIGHT, not vh - top (2026-09-25, phone audit).
      // #nbd-quick-action-bar slides up from translateY(100%) every time it
      // re-renders (page load, resize, every nbd:data-refreshed), and this
      // runs on the mutation that mounts it — i.e. with the bar still below
      // the screen. vh - top read ~0, the claim published 8px, and until
      // the 1.5s safety interval re-measured, the FAB stack sat 70px low,
      // on top of the bar's TASK button. A strip is pinned at bottom:0 by
      // declaration, so at rest the two numbers are identical; only the
      // height survives an animation. Corner claimants keep vh - top: they
      // can sit above the edge, which is what their claim measures.
      const reach = isStrip ? r.height : (vh - r.top);
      claimed = Math.max(claimed, Math.ceil(reach) + _CLAIM_GAP_PX);
    });
    const root = document.documentElement;
    root.style.setProperty('--nbd-bottom-chrome', strip + 'px');
    // Hard cap: never launch a FAB into the middle of the screen. Past
    // 40vh the declaration is wrong, and the failure we want is "the FAB
    // sits a little low", not "the FAB is floating mid-viewport".
    root.style.setProperty(
      '--nbd-corner-claimed',
      Math.min(claimed, Math.round(vh * 0.4)) + 'px'
    );
  }
  // rAF-coalesced: the body observer below watches class+style toggles
  // (crm-scrolling, nbd-dial-open) that fire in bursts, and the scroll
  // watch below can fire every frame. At most one forced layout per
  // frame over a handful of attributed nodes.
  let _rafId = 0;
  function _scheduleMeasure() {
    if (_rafId) return;
    _rafId = requestAnimationFrame(() => {
      _rafId = 0;
      // Re-derived here rather than at each call site: every path that
      // wants a measurement also wants the scroll watch to be correct,
      // and doing it inside the rAF inherits the coalescing for free.
      _syncScrollWatch();
      _measureBottomEdge();
    });
  }
  // A claimant that is part of normal flow (a sticky bar) enters and
  // leaves the bottom band as the page scrolls, so its claim is only
  // correct if we re-measure DURING the scroll. That listener is the
  // highest-frequency trigger this module has ever had, so it is
  // attached only while a claimant is actually in the DOM: roughly
  // thirty of the CRM's views declare none, and on those the scroll
  // cost stays at exactly zero. Bottom STRIPS are position:fixed, so
  // scrolling cannot move them — they never need the watch, which is
  // why the gate query is the corner attribute alone.
  // capture:true because what scrolls is usually an inner pane
  // (.view-scroll, .kcol-body) whose scroll event does not bubble.
  let _scrollWatch = false;
  function _syncScrollWatch() {
    const want = !!document.querySelector('[data-nbd-corner-claim]');
    if (want === _scrollWatch) return;
    _scrollWatch = want;
    if (want) {
      document.addEventListener('scroll', _scheduleMeasure, { passive: true, capture: true });
    } else {
      // The capture flag must match the one it was added with or the
      // removal is a silent no-op.
      document.removeEventListener('scroll', _scheduleMeasure, true);
    }
  }

  function _check() {
    _applyHidden(_isModalActive());
    // A modal opening or closing changes what occupies the bottom edge
    // too. This is also the path the 1.5s safety interval takes, which
    // is how a claimant hydrated deep inside a <template> — below the
    // subtree:false body observer's reach — eventually gets measured
    // and, via the rAF above, gets the scroll watch switched on.
    _scheduleMeasure();
  }

  function _bootstrap() {
    // Static token, published before the first measurement so no
    // stylesheet ever resolves it to its fallback mid-boot. It is also
    // declared in dashboard-app.css's :root, but customer.html runs the
    // full FAB stack WITHOUT loading that sheet — this write is what
    // makes the rail resolve on that page.
    document.documentElement.style.setProperty('--nbd-fab-rail', _FAB_RAIL_PX + 'px');
    _check();
    if (typeof MutationObserver !== 'function') return;
    const obs = new MutationObserver(() => { _check(); });
    obs.observe(document.body, {
      childList: true,
      subtree: false,         // only direct body children matter
      attributes: true,       // class+style toggles
      attributeFilter: ['class', 'style'],
    });
    // Class-toggled modals are PERSISTENT children — their .open flip is
    // an attribute change on a child, which the body observer above
    // deliberately doesn't see (subtree:false). Without this, hiding
    // waited on the belt-and-suspenders keydown/interval and the FAB
    // stack floated over a just-opened lead modal for up to 1.5s.
    // One observer, multiple targets; estV2Modal mounts dynamically and
    // simply isn't present here — its childList mount + the fallbacks
    // keep covering it as before.
    _CLASS_TOGGLED.forEach((id) => {
      const el = document.getElementById(id);
      if (el) obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
    // Also recheck on any keydown/click — a modal that toggled via
    // a child mutation might not have triggered the observer. Cheap
    // belt-and-suspenders.
    document.addEventListener('keydown', _check, true);
    window.addEventListener('focus', _check);
    // Geometry-only triggers: these change where the bottom edge IS
    // without opening or closing anything, so they skip the modal check
    // and go straight to the measurement. hashchange is the SPA's route
    // change — a new view brings a different set of declared chrome.
    // (The scroll listener is NOT registered here; _syncScrollWatch owns
    // it and only mounts it while a corner claimant exists.)
    window.addEventListener('resize', _scheduleMeasure);
    window.addEventListener('orientationchange', _scheduleMeasure);
    window.addEventListener('hashchange', _scheduleMeasure);
    // Periodic safety check — covers any modal toggle path I missed.
    // W159 CRITICAL fix: track the interval id + disconnect the
    // MutationObserver on pagehide so a bfcache restore doesn't
    // accumulate intervals. Previously every page navigation
    // started a new interval without clearing the old one — on
    // bfcache restore, two intervals ran in parallel checking a
    // potentially stale DOM state. If a modal had been open when
    // the user left, the stale interval's _check evaluated against
    // the now-detached DOM and could leave the FAB stack
    // permanently hidden.
    const intervalId = setInterval(_check, 1500);
    window.addEventListener('pagehide', () => {
      try { clearInterval(intervalId); } catch (_) {}
      try { obs.disconnect(); } catch (_) {}
      // Same W159 reasoning as the interval: a pending rAF and four live
      // listeners would otherwise measure a detached DOM after a bfcache
      // navigation. _scrollWatch is reset so the watch can re-arm rather
      // than believing it is still attached.
      try { if (_rafId) cancelAnimationFrame(_rafId); _rafId = 0; } catch (_) {}
      try {
        window.removeEventListener('resize', _scheduleMeasure);
        window.removeEventListener('orientationchange', _scheduleMeasure);
        window.removeEventListener('hashchange', _scheduleMeasure);
        document.removeEventListener('scroll', _scheduleMeasure, true);
        _scrollWatch = false;
      } catch (_) {}
    }, { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bootstrap, { once: true });
  } else {
    setTimeout(_bootstrap, 0);
  }

  const NBDFabStackCoordinator = {
    check: _check,
  };
})();
