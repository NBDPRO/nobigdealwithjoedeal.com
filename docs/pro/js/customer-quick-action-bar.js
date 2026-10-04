/**
 * customer-quick-action-bar.js — Wave 34 (Mobile quick-action bar)
 *
 * Reps on the phone with a customer want to be able to call back,
 * SMS, email, or set a follow-up task without scrolling around the
 * customer detail page. On desktop there's plenty of room and the
 * actions are already in the header / share row. On mobile the
 * page is a tall scroll and any of those actions take 2-3 swipes
 * + a tap. Mid-call, that's where flow dies.
 *
 * This wave adds a sticky bottom bar on mobile (≤640px) that
 * surfaces the four highest-frequency actions:
 *   - Call (tel: link with normalized digits)
 *   - SMS  (sms: link)
 *   - Email (mailto: link)
 *   - New task (window.openTaskModal — already exposed)
 *
 * Each button hides automatically when the lead doesn't have the
 * relevant data — a phoneless lead won't show Call/SMS, an
 * emailless lead won't show Email. Task is always available.
 *
 * Activates only on /pro/customer.html and only at viewport widths
 * ≤640px so desktop users don't lose page real estate. Listens for
 * resize so a phone in landscape correctly switches between
 * horizontal/vertical layouts.
 *
 * Honors iOS safe-area-inset-bottom so the bar doesn't get eaten
 * by the home-indicator strip on notched iPhones.
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['customer-quick-action-bar']) return;
  __NBD_LOADED['customer-quick-action-bar'] = true;

  const PATH = window.location.pathname || '';
  if (!/\/pro\/customer(?:\.html)?$/.test(PATH)) return;

  const MOBILE_MAX_WIDTH = 640;
  let barEl = null;

  // ─── Helpers ─────────────────────────────────────────────────────
  function isMobileViewport() {
    return window.innerWidth <= MOBILE_MAX_WIDTH;
  }

  function digitsOnly(s) {
    return String(s || '').replace(/\D+/g, '');
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  // ─── Render ──────────────────────────────────────────────────────
  function buildBar() {
    const lead = window._currentLead || {};
    const phone = digitsOnly(lead.phone);
    const email = (lead.email || '').trim();

    // Skip render entirely when there's no actionable contact info AND
    // openTaskModal isn't available — nothing to show. (Task button is
    // always shown when openTaskModal exists.)
    if (!phone && !email && typeof window.openTaskModal !== 'function') return null;

    const bar = document.createElement('div');
    bar.id = 'nbd-quick-action-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Quick actions');
    // Declare, don't compute. This bar is a full-width strip pinned at
    // bottom:0, so fab-stack-coordinator.js measures it and publishes its
    // height as --nbd-corner-claimed / --nbd-bottom-chrome; mobile-polish.css
    // then lifts the FAB stack by exactly that much. Nothing here needs to
    // know how tall the bar renders or where any FAB currently sits.
    bar.setAttribute('data-nbd-bottom-strip', '');
    // z-index sits on the page's ladder at --z-fab (customer.html :root,
    // "always UNDER overlays"), not the 99985 it shipped with (2026-09-25,
    // phone audit). This bar is page chrome, not an overlay, and at 99985 it
    // painted over EVERY overlay on the page, all of which sit at
    // --z-overlay (10000) or just above it: the document viewer's
    // Save / Email / Print / Download PDF footer, the photo editor's tool
    // strip, the estimate preview's Edit / Archive / Close, the upload and
    // edit modals' footers, and every toast. Worse than hidden: a tap on
    // "Save to Customer" landed on this bar's Call link and dialled the
    // homeowner, and "Edit" on the estimate sheet did the same. On the
    // ladder, any overlay covers the bar with no per-overlay bookkeeping,
    // so overlays added later are covered too. Toasts ride above it via
    // --nbd-bottom-chrome (customer-tasks-ui.js showToast).
    bar.style.cssText = `
      position:fixed; left:0; right:0; bottom:0;
      z-index:var(--z-fab, 9900);
      background:rgba(15,18,25,0.96);
      backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
      border-top:1px solid rgba(255,255,255,0.08);
      padding:8px 10px calc(8px + env(safe-area-inset-bottom, 0px));
      display:flex; gap:6px; justify-content:space-around;
      box-shadow:0 -4px 16px rgba(0,0,0,0.25);
      font-family:'Barlow',-apple-system,system-ui,sans-serif;
      animation:nbd-qab-slide .25s cubic-bezier(0.16, 1, 0.3, 1);`;

    if (!document.getElementById('nbd-qab-style')) {
      const style = document.createElement('style');
      style.id = 'nbd-qab-style';
      style.textContent = `
        @keyframes nbd-qab-slide { from { transform:translateY(100%); } to { transform:translateY(0); } }
        #nbd-quick-action-bar .qab-btn {
          flex:1; max-width:88px;
          display:flex; flex-direction:column; align-items:center; gap:3px;
          padding:8px 4px; border:none; border-radius:10px;
          background:transparent; color:#cbd5e1;
          font-family:inherit; font-size:10px; font-weight:600;
          letter-spacing:0.3px; text-transform:uppercase;
          text-decoration:none; cursor:pointer;
          -webkit-tap-highlight-color:transparent;
          transition:background .12s, color .12s, transform .12s;
        }
        #nbd-quick-action-bar .qab-btn:active {
          background:rgba(161,74,34,0.15); color:#fff;
          transform:scale(0.96);
        }
        #nbd-quick-action-bar .qab-icon {
          font-size:22px; line-height:1;
        }
        #nbd-quick-action-bar .qab-btn.qab-call .qab-icon { color:var(--green); }
        #nbd-quick-action-bar .qab-btn.qab-sms  .qab-icon { color:var(--blue); }
        #nbd-quick-action-bar .qab-btn.qab-email .qab-icon { color:var(--purple); }
        #nbd-quick-action-bar .qab-btn.qab-task .qab-icon { color:var(--gold); }
        /* The bar pushes pinned page content up; we add bottom
           padding to <main> equivalent via body so floating share
           buttons / footers don't get covered. Defensive — the page
           normally scrolls so the bar overlapping a few pixels of
           content is harmless. */
        body.nbd-qab-active { padding-bottom:64px; }
        /* 64px was the bar WITHOUT the home-bar inset. In the installed
           iPhone app the bar is ~104px tall (its own padding includes
           env(safe-area-inset-bottom)), so the last 40px of the page could
           never scroll clear of it — and anything scrolled into view
           (scrollIntoView, focus, a find-in-page hit) landed its bottom edge
           exactly under it: the doc-template ⓘ previews, for one
           (2026-10-03). Both now use the bar's measured height, published
           by fab-stack-coordinator.js as --nbd-bottom-chrome, with an
           inset-aware fallback for the frame before it measures. */
        body.nbd-qab-active { padding-bottom:max(calc(72px + env(safe-area-inset-bottom, 0px)), var(--nbd-bottom-chrome, 0px)); }
        html:has(> body.nbd-qab-active) { scroll-padding-bottom:max(calc(72px + env(safe-area-inset-bottom, 0px)), var(--nbd-bottom-chrome, 0px)); }
        /* FAB lift REMOVED 2026-07. This module used to write \`bottom:\`
           for three FABs it does not own, restating their base constants,
           at its own 641px breakpoint while the FAB stack switches at
           768px — the 641-768 band ran desktop panel geometry against
           mobile FAB geometry. The bar now just declares
           data-nbd-bottom-strip; fab-stack-coordinator.js measures it and
           the shared rule in mobile-polish.css lifts the stack. */
        @media (min-width:641px) {
          #nbd-quick-action-bar { display:none !important; }
          body.nbd-qab-active   { padding-bottom:0 !important; }
          html:has(> body.nbd-qab-active) { scroll-padding-bottom:0 !important; }
        }`;
      document.head.appendChild(style);
    }

    const buttons = [];
    if (phone) {
      buttons.push(`
        <a class="qab-btn qab-call" href="tel:${escapeAttr(phone)}" aria-label="Call ${escapeAttr(lead.phone)}">
          <span class="qab-icon">📞</span><span>Call</span>
        </a>`);
      // Text/Email stay sms:/mailto: ANCHORS — they open the rep's own
      // composer, pre-addressed and empty, which is what a rep mid-call
      // expects from a button labelled "Text": something they can type into,
      // read back, and abandon.
      //
      // These were briefly rewired to PortalLinkHelpers.smsForLead to close a
      // Comm Log gap (customer.html doesn't load crm-snooze.js, whose
      // capture-phase logger catches these clicks on the dashboard, so texts
      // sent from this bar don't reach the timeline). That is the wrong trade:
      // smsForLead is not a generic "text this customer" helper — it mints a
      // portal link, composes a fixed body, and hands straight to
      // NBDComms.sendSMS, which POSTs to Twilio with NO preview and no
      // confirmation. A rep tapping 💬 would have sent an unreviewed templated
      // message to the homeowner. An irreversible customer-facing send behind a
      // mislabelled control is strictly worse than a missing log line.
      //
      // That Comm Log gap is now CLOSED the right way — see the capture-phase
      // listener below, which routes these taps through the page's own
      // logCommunication(). The anchors stay anchors; the log happens
      // alongside the navigation instead of replacing it with a send.
      // Kanban's equivalent control is honestly labelled "Text portal link"
      // for exactly the reason above, and should stay that way.
      buttons.push(`
        <a class="qab-btn qab-sms" href="sms:${escapeAttr(phone)}" aria-label="Text ${escapeAttr(lead.phone)}">
          <span class="qab-icon">💬</span><span>Text</span>
        </a>`);
    }
    if (email) {
      buttons.push(`
        <a class="qab-btn qab-email" href="mailto:${escapeAttr(email)}" aria-label="Email ${escapeAttr(email)}">
          <span class="qab-icon">✉️</span><span>Email</span>
        </a>`);
    }
    if (typeof window.openTaskModal === 'function') {
      buttons.push(`
        <button class="qab-btn qab-task" type="button" aria-label="Add task">
          <span class="qab-icon">✓</span><span>Task</span>
        </button>`);
    }

    if (buttons.length === 0) return null;
    bar.innerHTML = buttons.join('');

    // Call / Text / Email navigate on their own (tel:/sms:/mailto: hand off to
    // the OS composer). They still have to reach the Comm Log.
    //
    // The gap this closes: on the dashboard, crm-snooze.js installs a
    // capture-phase delegate that logs EVERY tel:/sms:/mailto: click. That file
    // is not loaded on customer.html, so taps on this bar reached the timeline
    // from nowhere — a rep could call a customer from the bar and, weeks later,
    // find no record it happened.
    //
    // Routing through logCommunication (customer-bootstrap.module.js, read off
    // __NBD_CALL_REGISTRY since Globals Tranche 3 T3-C, 2026-09-18 — not
    // window) rather than porting the crm-snooze delegate: it
    // is the page's own canonical logger, and it does strictly more — refreshes
    // the timeline so the entry appears immediately, and stamps
    // lastContactedAt / lastContactType on the lead, which the follow-up logic
    // reads. Duplicating a second writer against `communications` is exactly
    // the kind of drift that leaves two implementations disagreeing.
    //
    // Never block navigation: the log is fire-and-forget, the protocol handler
    // fires as normal, and a logging failure must not cost the rep the call.
    bar.addEventListener('click', (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a || !bar.contains(a)) return;
      const href = a.getAttribute('href') || '';
      const type = href.startsWith('tel:') ? 'call'
        : href.startsWith('sms:') ? 'sms'
        : href.startsWith('mailto:') ? 'email' : null;
      if (!type) return;
      const leadId = window._customerId;
      const _nbdReg = window.__NBD_CALL_REGISTRY;
      if (!leadId || !_nbdReg || typeof _nbdReg.logCommunication !== 'function') return;
      const who = (lead && (lead.firstName || lead.name)) || 'customer';
      const label = {
        call: 'Called ' + who + ' from the quick bar',
        sms: 'Texted ' + who + ' from the quick bar',
        email: 'Emailed ' + who + ' from the quick bar',
      }[type];
      try {
        Promise.resolve(_nbdReg.logCommunication(leadId, type, label))
          .catch((err) => console.warn('[qab] comm log failed:', err && err.message));
      } catch (err) {
        console.warn('[qab] comm log threw:', err && err.message);
      }
    }, true); // capture — fire before anything that might stopPropagation

    const taskBtn = bar.querySelector('.qab-task');
    if (taskBtn) {
      taskBtn.addEventListener('click', () => {
        try { window.openTaskModal(); } catch (e) { console.warn('[qab]', e); }
      });
    }

    return bar;
  }

  function ensureBar() {
    // Remove + re-render so phone/email changes from background
    // revalidate (Wave 14) reflect in the bar without a page reload.
    if (barEl) {
      barEl.remove();
      barEl = null;
    }
    if (!isMobileViewport()) {
      document.body.classList.remove('nbd-qab-active');
      return;
    }
    const bar = buildBar();
    if (!bar) {
      document.body.classList.remove('nbd-qab-active');
      return;
    }
    document.body.appendChild(bar);
    document.body.classList.add('nbd-qab-active');
    barEl = bar;
  }

  // Debounce resize-driven re-renders so layout swap is smooth.
  let resizeTimer = null;
  function onResize() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(ensureBar, 120);
  }

  // ─── Init ────────────────────────────────────────────────────────
  function init() {
    // Wait until the customer data has rendered so window._currentLead
    // is populated. The page itself reveals via opacity:1 on the html
    // element after loadCustomerData; we'll just defer a touch and
    // then rely on the revalidate flow + resize listener for updates.
    setTimeout(ensureBar, 1500);
    window.addEventListener('resize', onResize);
    // Re-render whenever the lead is replaced (Wave 14 background
    // revalidate fires this implicitly when it swaps _currentLead;
    // we just listen for the same data-refreshed event the bell + bottleneck
    // widgets use, since the customer page also benefits).
    window.addEventListener('nbd:data-refreshed', () => setTimeout(ensureBar, 60));
  }

  const CustomerQuickActionBar = {
    refresh: ensureBar,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
