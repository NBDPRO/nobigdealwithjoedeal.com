(function () {
  'use strict';

  // Endpoint base — same host that serves the other functions.
  // Localhost-only emulator switch (same Audit #3 rule as
  // nbd-emulator-connect.js): the rep-side pages already point their SDK at
  // the emulators when served from localhost, but the public token pages
  // hardcoded prod — leaving the homeowner surface untestable in the
  // hermetic e2e harness. Any hostname other than localhost/127.0.0.1
  // keeps prod.
  const FUNCTIONS_BASE = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
    ? 'http://127.0.0.1:5001/nobigdeal-pro/us-central1'
    : 'https://us-central1-nobigdeal-pro.cloudfunctions.net';

  // Escape helper — every interpolated homeowner/rep field goes
  // through this. The function payload is trusted (redacted by
  // getHomeownerPortalView) but defense-in-depth is free.
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Defense-in-depth for href/src sinks: esc() neutralizes quotes/brackets but
  // NOT URL schemes, so a non-http(s) value (e.g. javascript:) would survive
  // intact. Only let http(s) through; everything else becomes ''. Mirrors the
  // googleReviewUrl guard used elsewhere.
  const safeUrl = (u) => {
    const s = String(u == null ? '' : u).trim();
    return /^https?:\/\//i.test(s) ? s : '';
  };
  // The signing link must be OUR signing page with a token, nothing else —
  // the same origin pin the old BoldSign embed carried (Wave 87): the server
  // hands this back and the page links it, so a wrong origin would send the
  // homeowner somewhere we never meant to.
  const signLink = (u) => {
    const s = String(u == null ? '' : u).trim();
    return /^https:\/\/nobigdealwithjoedeal\.com\/pro\/esign\.html\?t=[A-Za-z0-9]{10,64}$/.test(s) ? s : '';
  };

  // Whole dollars as before; cents when the amount has them. Review of #1763
  // (2026-09-25): an upgraded estimate's total carries exact upgrade tax, so
  // a whole-dollar portal total disagreed with the proposal and invoice.
  function fmtMoney(n) {
    if (n == null || isNaN(Number(n))) return '—';
    const c = Math.round(Number(n) * 100);
    const d = (c % 100 === 0) ? 0 : 2;
    return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function signaturePill(status) {
    if (status === 'signed') return '<span class="pill pill-green">✓ Signed</span>';
    if (status === 'sent' || status === 'viewed') return '<span class="pill pill-orange">✍ Awaiting signature</span>';
    if (status === 'declined') return '<span class="pill pill-red">Declined</span>';
    if (status === 'expired') return '<span class="pill">Expired</span>';
    return '';
  }

  function getToken() {
    try {
      const p = new URLSearchParams(location.search);
      return p.get('token') || '';
    } catch (e) { return ''; }
  }

  // NEW-D26: every interactive card (messages, rating, callback, photo
  // upload, audit events) posts `token: TOKEN` — but TOKEN was never
  // declared anywhere, so each send threw `ReferenceError: TOKEN is not
  // defined` the moment a homeowner used it. The bug predates the js/
  // extraction (the inline original had the same 5 dangling references);
  // it was simply unreachable while the whole script was CSP-dead
  // (NEW-D23). loadView() re-reads getToken() itself, so this constant
  // only serves the card senders.
  const TOKEN = getToken().trim();

  // NEW-D26 (part 2): renderView() declared `const repName` locally, but the
  // card wirers reference it after render — wireMessagingCard's incoming
  // bubbles (rep replies), wireRatingCard's thank-you panels, and
  // wireCallbackCard's success line all threw `ReferenceError: repName is not
  // defined` (live repro: callback send POSTed fine, then surfaced "Network
  // error: repName is not defined" and re-enabled the button — inviting
  // double-sends). Same latent class as TOKEN above: unreachable while the
  // script was CSP-dead. Hoisted to module scope; renderView assigns it.
  let repName = 'Your Rep';

  // ─── Live-poll state ────────────────────────────────────────────
  // Step 13: portal becomes "push-feeling" via 30s visibility-aware
  // polling against the same getHomeownerPortalView callable. Diffs the
  // new view against _lastView; on real changes (stage / photos /
  // messages / estimate) surfaces an inline banner before re-rendering.
  // Server changes: none. Cost: 1 callable invocation / tab / 30s while
  // the page is visible. Pauses entirely when document.hidden.
  const POLL_INTERVAL_MS = 30_000;
  let _lastView = null;

  // (2026-10-04) The signature-safe repaint deferral is gone with BoldSign:
  // signing happens on its own page (esign.html), not in an iframe here, so a
  // repaint has nothing in flight to destroy.
  let _pollTimer = null;
  let _pollInflight = false;

  // isPoll=true marks a background live-poll so the server doesn't count it
  // against the token's replay budget (only genuine opens do). See portal.js
  // getHomeownerPortalView.
  async function _fetchView(token, isPoll) {
    const res = await fetch(FUNCTIONS_BASE + '/getHomeownerPortalView', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, poll: !!isPoll })
    });
    return res;
  }

  // ─── Error states ───────────────────────────────────────────────
  // getHomeownerPortalView has five distinct terminal outcomes. This page
  // rendered specific copy for two of them and sent the rest to
  // "Please try again in a moment." Two of those can NEVER succeed on a
  // retry, so the advice was not merely unhelpful, it was false:
  //
  //   400 bad_token       the link arrived truncated. SMS and email
  //                       clients wrap and clip long URLs, and the
  //                       token charset guard (functions/portal.js,
  //                       /^[A-Za-z0-9]{10,64}$/) rejects the remainder.
  //   429 too_many_opens  tokens are minted with maxUses:100 against a
  //                       30-day TTL and only genuine opens count
  //                       (polls are exempt), so a homeowner checking
  //                       progress a few times a day during an active
  //                       job reaches the cap inside a month.
  //
  // Both told the customer to wait. Waiting never worked, and nothing
  // pointed them at the one thing that does — asking their rep to send a
  // fresh link, which takes the rep a second.
  //
  // `transient` is the honest half: only states where refreshing can
  // actually help are allowed to say so. Keyed on the backend's stable
  // `code` where present and falling back to the status, so this stays
  // correct against a backend that has not been redeployed yet.
  function _errorStateFor(status, code) {
    switch (code) {
      case 'bad_token':
        return { transient: false, title: 'This link looks incomplete',
          body: 'Links sometimes get cut short in a text message. Ask your rep to send it again.' };
      case 'too_many_opens':
        return { transient: false, title: 'This link has reached its limit',
          body: 'Ask your rep for a fresh link — it only takes them a second.' };
      case 'expired':
        return { transient: false, title: 'This link has expired',
          body: 'Ask your rep for a new one — they can send a fresh link right away.' };
      case 'unknown_link':
      case 'project_missing':
        return { transient: false, title: 'We can\'t find this project',
          body: 'Check the link with your rep — it may have been mistyped or replaced.' };
      default: break;
    }
    // No code (older backend), or one we do not recognise: fall back to
    // the status, which has carried the same meanings since Wave 87.
    if (status === 400) return _errorStateFor(null, 'bad_token');
    if (status === 404) return _errorStateFor(null, 'unknown_link');
    if (status === 410) return _errorStateFor(null, 'expired');
    if (status === 429) {
      // Two different 429s reach here with opposite correct advice: the
      // per-IP limiter (30/min) really does clear on its own, the replay
      // cap never does. Without a code we cannot tell them apart —
      // Retry-After would, but it is not CORS-exposed to this origin — so
      // say something true of both and name the escalation.
      return { transient: true, title: 'Too many requests right now',
        body: 'Give it a minute and refresh. If it keeps happening, contact your rep for a fresh link.' };
    }
    return { transient: true, title: 'Couldn\'t load your project',
      body: 'Check your connection and refresh. If it keeps happening, contact your rep.' };
  }

  function _renderError(main, state) {
    if (!main) return;
    main.innerHTML = '<div class="error-state" data-transient="' + (state.transient ? '1' : '0') + '">'
      + '<h2>' + esc(state.title) + '</h2>'
      + '<div>' + esc(state.body) + '</div></div>';
  }

  async function loadView() {
    const token = getToken().trim();
    const main = document.getElementById('mainWrap');
    if (!token) {
      _renderError(main, { transient: false, title: 'No link found',
        body: 'This page needs the link your rep sent you. Open it again from your text or email.' });
      return;
    }
    try {
      // F-06: token in POST body, not URL. Keeps the token out of
      // access logs, Referer headers, and browser history. The same
      // page URL still carries ?token= in the browser history (from
      // the emailed link) but the *server-side* log chain no longer
      // receives it.
      const res = await _fetchView(token);
      if (!res.ok) {
        // Read the body for the machine-readable `code`. Best-effort: a
        // body that is missing or not JSON must not turn a clean 410 into
        // the generic network message, so the status carries it alone.
        let code = null;
        try { code = (await res.clone().json()).code || null; } catch (_) {}
        _renderError(main, _errorStateFor(res.status, code));
        return;
      }
      const view = await res.json();
      _lastView = view;
      renderView(view);
      _showLivePill();
      _startLivePolling();
      // Audit batch 7: emit a portal_open event so the rep's
      // customer-side activity log captures the visit. Fire-and-forget;
      // never block the page on telemetry.
      _emitAuditEvent('portal_open');
    } catch (e) {
      // Genuinely transient: DNS, offline, CORS, a 5xx that never parsed.
      // This is the one place "refresh and try again" is honest advice.
      _renderError(main, _errorStateFor(0, null));
    }
  }

  // ─── Diff helpers ───────────────────────────────────────────────
  // Stage / progress label changes are the most important signal —
  // the rep marking "Inspection Done" → "Estimate Ready" is what the
  // homeowner is waiting on. Photos / messages are next-tier.
  function _diffView(prev, next) {
    if (!prev) return null; // first paint — nothing to announce
    const events = [];
    const pStage = (prev.progress && prev.progress.currentLabel) || '';
    const nStage = (next.progress && next.progress.currentLabel) || '';
    if (pStage && nStage && pStage !== nStage) {
      events.push({ kind: 'stage', from: pStage, to: nStage, msg: `🎉 Status update: now ${nStage}` });
    }
    // 2026-09-16 (photo self-announce fix): was a bare length comparison,
    // so a homeowner's OWN upload via "Show Us What You See" (which lands
    // in this same sharedWithHomeowner-gated photos array — see
    // uploadHomeownerPhoto in functions/portal.js) incremented the count
    // and got announced back to them as "new photo from your rep". Diff by
    // id to find what's actually NEW, then exclude anything the homeowner
    // uploaded themselves (source: 'homeowner', added to the server payload
    // by the same fix) — only a rep-sourced addition is a "from your rep"
    // event.
    const pPhotoIds = new Set(((prev.photos) || []).map(p => p.id));
    const newRepPhotos = ((next.photos) || []).filter(p => !pPhotoIds.has(p.id) && p.source !== 'homeowner');
    if (newRepPhotos.length) {
      events.push({ kind: 'photos', delta: newRepPhotos.length, msg: `📸 ${newRepPhotos.length} new photo${newRepPhotos.length === 1 ? '' : 's'} from your rep` });
    }
    // (Removed dead "new message" banner: getHomeownerPortalView never returns
    // a `messages` field, so this never fired. Rep replies are surfaced by the
    // messaging card's own 30s poll instead.)
    const pEstId = (prev.estimate && prev.estimate.id) || null;
    const nEstId = (next.estimate && next.estimate.id) || null;
    if (nEstId && pEstId !== nEstId) {
      events.push({ kind: 'estimate', msg: `📋 New estimate ready to review` });
    }
    // Signature flip — the single highest-value moment. Without this branch,
    // _diffView returns null on a sign completion, _pollOnce skips renderView
    // (yet still advances _lastView), so the "Review & sign" card stays stale
    // forever even though the signature persisted server-side. Repaint on any
    // signatureStatus change or when the signed-document URL appears.
    const pSig = (prev.estimate && prev.estimate.signatureStatus) || '';
    const nSig = (next.estimate && next.estimate.signatureStatus) || '';
    const pSignedUrl = (prev.estimate && prev.estimate.signedDocumentUrl) || '';
    const nSignedUrl = (next.estimate && next.estimate.signedDocumentUrl) || '';
    if (nSig !== pSig || (nSignedUrl && nSignedUrl !== pSignedUrl)) {
      const done = !!nSignedUrl || /sign|complete|done/i.test(nSig);
      events.push({ kind: 'signed', msg: done ? `✅ Your contract is signed — thank you!` : `✍️ Signature status updated` });
    }
    return events.length ? events : null;
  }

  // ─── Banner UI ──────────────────────────────────────────────────
  // One banner at a time, slides in from the top of the page. Auto-
  // dismisses after 8s; clicking it dismisses immediately.
  function _showUpdateBanner(events) {
    if (!Array.isArray(events) || !events.length) return;
    const existing = document.getElementById('liveBanner');
    if (existing) existing.remove();
    const banner = document.createElement('div');
    banner.id = 'liveBanner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.style.cssText = 'position:fixed;top:14px;left:50%;transform:translate(-50%, -120%);background:var(--green, #2ecc8a);color:#fff;padding:12px 18px;border-radius:10px;font-weight:600;font-size:14px;box-shadow:0 8px 24px rgba(0,0,0,.18);z-index:var(--z-toast, 10002);cursor:pointer;max-width:90vw;transition:transform .35s cubic-bezier(.22,.61,.36,1);';
    // Stack the messages — typically 1-2; cap at 3 lines so it can't
    // grow off-screen if a slow homeowner returns to a much-updated page.
    banner.innerHTML = events.slice(0, 3).map(e => `<div>${e.msg}</div>`).join('');
    banner.addEventListener('click', () => banner.remove());
    document.body.appendChild(banner);
    // Trigger the slide-in via rAF so the initial off-screen style applies first.
    requestAnimationFrame(() => { banner.style.transform = 'translate(-50%, 0)'; });
    setTimeout(() => {
      if (banner.parentNode) {
        banner.style.transform = 'translate(-50%, -120%)';
        setTimeout(() => banner.remove(), 400);
      }
    }, 8000);
  }

  // Tiny "🟢 Live" indicator pinned to the page corner so the homeowner
  // sees this is current data, not a snapshot. Gently pulses when a
  // poll fires so they get visual confirmation the page is alive.
  //
  // Phone audit (2026-09-25): it is a label, not a control, but it was
  // pointer-events:auto at z-index 9998 — so on a phone, whatever scrolled
  // under the bottom-right corner (the right end of "Choose a photo", the
  // warranty box, Send) ignored taps there, and it sat undimmed ON TOP of
  // the document viewer (.doc-modal-overlay was z-index 1000). Now taps pass
  // through it, and it sits on the rep side's z ladder (dashboard-app.css):
  // --z-fab, "floating — always UNDER overlays", with the viewer at
  // --z-overlay and the update banner at --z-toast. That stylesheet is not
  // loaded here, so the fallbacks carry the same numbers.
  function _showLivePill() {
    if (document.getElementById('livePill')) return;
    const pill = document.createElement('div');
    pill.id = 'livePill';
    pill.style.cssText = 'position:fixed;bottom:14px;right:14px;background:rgba(0,0,0,.55);color:#fff;font-size:11px;padding:6px 10px;border-radius:999px;font-weight:500;letter-spacing:.04em;backdrop-filter:blur(6px);z-index:var(--z-fab, 9900);pointer-events:none;display:flex;align-items:center;gap:6px;';
    pill.innerHTML = '<span id="livePillDot" style="width:6px;height:6px;border-radius:50%;background:#2ecc8a;display:inline-block;transition:transform .2s;"></span><span>Live</span>';
    document.body.appendChild(pill);
  }
  function _pulseLivePill() {
    const dot = document.getElementById('livePillDot');
    if (!dot) return;
    dot.style.transform = 'scale(1.8)';
    setTimeout(() => { dot.style.transform = 'scale(1)'; }, 220);
  }

  // ─── Poll loop ──────────────────────────────────────────────────
  function _startLivePolling() {
    if (_pollTimer) return; // already running
    _scheduleNextPoll();
    document.addEventListener('visibilitychange', _onVisibility);
  }

  function _scheduleNextPoll() {
    clearTimeout(_pollTimer);
    if (document.hidden) { _pollTimer = null; return; }
    _pollTimer = setTimeout(_pollOnce, POLL_INTERVAL_MS);
  }

  function _onVisibility() {
    // Tab hidden → halt timer to save battery + Cloud Function cost.
    // Tab returning → fire one immediate poll so the homeowner doesn't
    // wait 30s for the catch-up after coming back to the page.
    if (document.hidden) {
      clearTimeout(_pollTimer);
      _pollTimer = null;
    } else {
      _pollOnce();
    }
  }

  async function _pollOnce() {
    if (_pollInflight) { _scheduleNextPoll(); return; }
    _pollInflight = true;
    _pulseLivePill();
    try {
      const token = getToken().trim();
      if (!token) return;
      const res = await _fetchView(token, true); // background poll — don't burn the replay budget
      if (res.status === 410 || res.status === 404) {
        // Link revoked/expired mid-session — stop polling and surface
        // a non-destructive notice. Don't wipe the rendered view; the
        // homeowner can still see what they had.
        clearTimeout(_pollTimer);
        _pollTimer = null;
        _showUpdateBanner([{ msg: 'This link is no longer valid. Contact your rep for a fresh link.' }]);
        return;
      }
      if (!res.ok) return; // transient failure — try again on next tick
      const view = await res.json();
      const events = _diffView(_lastView, view);

      _lastView = view;
      if (events) {
        // Re-render first so the banner refers to data the user can see,
        // then show the banner. Avoids the "🎉 Status: Approved" toast
        // landing before the UI has caught up.
        renderView(view);
        _showUpdateBanner(events);
      }
    } catch (e) { /* swallow — transient network errors during polling shouldn't disrupt the page */ }
    finally {
      _pollInflight = false;
      _scheduleNextPoll();
    }
  }

  // ─── Is this the rep's preview rather than the homeowner? ───────
  // The CRM's "Portal preview" modal embeds this page in a same-origin
  // iframe. Until 2026-09-08 that embed was refused outright by
  // X-Frame-Options, so the page never ran inside it and the question
  // never arose. Making the preview work makes it urgent: without this
  // guard every preview click would emit the homeowner's own telemetry.
  //
  // The damage is not merely a wrong count. `estimate_view` fires a
  // Firestore trigger (functions/fresh-view-logic.js) that pushes the rep
  // an `estimate_viewed` notification — the real-time buying-intent
  // signal — and that trigger de-dupes per lead over a window. So a rep
  // previewing their own link would be told their customer was reading
  // the estimate right now, AND the genuine open minutes later would be
  // swallowed as a duplicate. A false positive that suppresses the true
  // one is worse than no signal.
  //
  // Framing is the reliable discriminator: firebase.json allows
  // frame-ancestors 'self' only, so nothing but our own CRM can embed
  // this page, and a homeowner opening a texted link is never framed.
  // A throw can only happen when framed cross-origin, so it counts as
  // framed too. `?preview=1` is the belt for a future preview surface
  // that opens in a tab instead.
  const IS_PREVIEW = (function () {
    try {
      if (window.self !== window.top) return true;
    } catch (_) {
      return true;
    }
    try {
      return new URLSearchParams(location.search).get('preview') === '1';
    } catch (_) {
      return false;
    }
  })();

  // ─── Customer-side audit logger (batch 7) ───────────────────────
  // Posts a minimal { token, type, resourceId? } payload to the
  // recordCustomerEvent Cloud Function. Token-validated server-side.
  // Fire-and-forget — telemetry should never break the page.
  function _emitAuditEvent(type, resourceId) {
    try {
      // A rep looking at their own preview is not a customer visit.
      if (IS_PREVIEW) return;
      const token = getToken().trim();
      if (!token) return;
      fetch(FUNCTIONS_BASE + '/recordCustomerEvent', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, type, resourceId: resourceId || null }),
        keepalive: true,
      }).catch(() => {});
    } catch (_) { /* never fail the page */ }
  }

  // Link to the itemized scope for one estimate, carrying the portal token
  // the page already holds. Relative on purpose: the portal is served from
  // /pro/, so this resolves whether the page was reached as /pro/portal or
  // /pro/portal.html.
  //
  // Deliberately NOT tagged as a rep preview. getEstimateForView writes its
  // own activity record server-side, so a client flag could not suppress it
  // anyway — pretending otherwise would be worse than the gap. Suppressing
  // rep-initiated estimate views is a server-side change and its own slice.
  function _estimateScopeHref(estimateId) {
    return 'estimate-view.html?token=' + encodeURIComponent(getToken().trim())
      + '&estimateId=' + encodeURIComponent(estimateId);
  }

  // ─── The install date ───────────────────────────────────────────
  // "When is the crew coming?" is the one question a homeowner opens this
  // page to answer, and the portal could not answer it — lead.scheduledDate
  // never reached the view.
  //
  // The whole difficulty is the date arithmetic, so it lives in one pure
  // function that the suite drives directly.
  //
  // 1. NEVER `new Date('2026-09-16')`. That parses as UTC midnight, so in
  //    America/New_York it renders "Tuesday, September 15" — the wrong day
  //    AND the wrong weekday, which is the half that matters because the
  //    weekday is what a homeowner writes on the calendar. Measured, not
  //    assumed. The same bug is live on the warranty certificate
  //    (customer-bootstrap.module.js) and is deliberately not fixed here —
  //    that is a separate document with its own suite.
  //    Build from the parts instead, which is local by definition.
  //
  // 2. Past dates must not claim anything. A date that has gone by means the
  //    job slipped or the rep has not updated the card; "Crew arrives
  //    Tuesday" would then be false. Each branch is phrased to stay true:
  //    future/today promise an arrival, past states the record only.
  function _scheduleLine(ymd, todayYmd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return null;
    const [y, m, d] = String(ymd).split('-').map(Number);
    const dt = new Date(y, m - 1, d);          // local midnight, not UTC
    // Reject a date the calendar does not have (2026-02-30 rolls forward).
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    let pretty;
    try {
      pretty = dt.toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric',
      });
    } catch (_) {
      pretty = ymd;
    }
    // String compare is safe and timezone-free on zero-padded ISO dates.
    const when = ymd === todayYmd ? 'today' : (ymd > todayYmd ? 'future' : 'past');
    if (when === 'today') return { when, text: 'Crew arrives today' };
    if (when === 'future') return { when, text: 'Crew arrives ' + pretty };
    return { when, text: 'Scheduled for ' + pretty };
  }

  // A job planned to a week, before its day is set (2026-09-29). weekYmd is
  // that week's Monday. Past weeks say nothing: a lapsed plan is not a
  // promise to repeat to the homeowner. The note is the "we'll walk down your
  // days" Jo asked for, phrased as what happens next, not a guarantee.
  function _weekLine(weekYmd, todayYmd) {
    if (typeof weekYmd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(weekYmd)) return null;
    const [y, m, d] = weekYmd.split('-').map(Number);
    const mon = new Date(y, m - 1, d);
    if (mon.getFullYear() !== y || mon.getMonth() !== m - 1 || mon.getDate() !== d) return null;
    const sun = new Date(y, m - 1, d + 6);
    const p = (v) => String(v).padStart(2, '0');
    const sunYmd = sun.getFullYear() + '-' + p(sun.getMonth() + 1) + '-' + p(sun.getDate());
    if (sunYmd < todayYmd) return null;
    let pretty;
    try { pretty = mon.toLocaleDateString(undefined, { month: 'long', day: 'numeric' }); } catch (_) { pretty = weekYmd; }
    const thisWeek = weekYmd <= todayYmd;
    return {
      when: 'week',
      text: thisWeek ? 'Your project is scheduled for this week' : 'Your project is scheduled for the week of ' + pretty,
      note: 'We\'ll confirm your exact day as that week\'s schedule comes together, and we\'ll reach out before the crew arrives.',
    };
  }

  // A customer's OTHER scheduled jobs (multi-job, 2026-09-30; the server sends
  // view.progress.otherJobs, see functions/portal.js otherJobsFor). Same
  // honesty rules as the main line: a day that has passed says nothing, a
  // lapsed week says nothing. → [{title, when, text, date, win}].
  function _otherJobLines(jobs, todayYmd) {
    const out = [];
    (Array.isArray(jobs) ? jobs : []).forEach(function (j) {
      if (!j || typeof j.title !== 'string' || !j.title) return;
      const s = _scheduleLine(j.scheduledDate, todayYmd);
      if (s) {
        if (s.when !== 'past') out.push({ title: j.title, when: s.when, text: s.text, date: j.scheduledDate, win: j.scheduleWindow || null });
        return;
      }
      const w = _weekLine(j.scheduledWeek, todayYmd);
      if (w) out.push({ title: j.title, when: 'week', text: w.text.replace('Your project is scheduled', 'Scheduled'), date: null, win: null });
    });
    return out;
  }

  // The arrival window after the date (2026-09-29): "· arriving around
  // 7:00 am · 2-day job" / "· 2:30–3:30 pm". The server sends the window's
  // three fields raw (functions/portal.js scheduleWindowFor); the wording and
  // the date math are schedule-window.js's (window.NBDScheduleWindow), which
  // portal.html loads first. Only a date still ahead (or today) gets a window:
  // _scheduleLine's past branch states the record and promises nothing, and a
  // time on it would be a promise.
  function _scheduleWindowSuffix(scheduledDate, win, when) {
    if (when === 'past' || !win || typeof win !== 'object') return '';
    const W = window.NBDScheduleWindow;
    if (!W || typeof W.portalPhrase !== 'function') return '';
    const phrase = W.portalPhrase({
      scheduledDate: scheduledDate,
      scheduledStart: win.scheduledStart,
      scheduledDurationMin: win.scheduledDurationMin,
      scheduledEndDate: win.scheduledEndDate,
    });
    return phrase ? ' · ' + phrase : '';
  }

  // Local today as YYYY-MM-DD. toISOString() would be UTC and would flip the
  // answer for every evening visitor east or west of it.
  function _localToday(now) {
    const n = now || new Date();
    const p = (v) => String(v).padStart(2, '0');
    return n.getFullYear() + '-' + p(n.getMonth() + 1) + '-' + p(n.getDate());
  }

  // Short date for a completed progress-timeline step, e.g. "Sep 3" (or
  // "Sep 3, 2025" across a year boundary, so a job spanning New Year's
  // doesn't read as "which September"). Unlike _scheduleLine's bare
  // YYYY-MM-DD input, view.progress.milestoneDates carries full ISO
  // timestamps (server writes new Date().toISOString()) — new Date(iso)
  // parses those correctly in the reader's local zone.
  function _milestoneDateLabel(iso) {
    if (typeof iso !== 'string') return null;
    const dt = new Date(iso);
    if (isNaN(dt.getTime())) return null;
    const sameYear = dt.getFullYear() === new Date().getFullYear();
    try {
      return dt.toLocaleDateString(undefined, sameYear
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (_) {
      return null;
    }
  }

  // ── Progress tracker helpers (9 steps, 2026-10-03) ──────────────
  // Every word on the tracker comes from the server's
  // HOMEOWNER_PROGRESS_COPY (functions/homeowner-progress.js) — Jo edits it
  // there. These helpers only fill placeholders and lay the steps out.

  // The build day for "{date}", e.g. "Monday, October 12". Built from the
  // parts (local midnight) — never new Date('YYYY-MM-DD'), which is UTC and
  // shows the day before for every US reader (see _scheduleLine).
  function _buildDayLabel(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return null;
    const [y, m, d] = String(ymd).split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    try {
      return dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    } catch (_) {
      return ymd;
    }
  }

  // Fill {name} placeholders; an unknown one is left as-is.
  function _fillCopy(text, vars) {
    return String(text == null ? '' : text).replace(/\{(\w+)\}/g, function (m, k) {
      return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
    });
  }

  // The current step's sentence. A {date} with no usable date drops the
  // sentence rather than printing "{date}" or "Invalid Date" to a customer
  // (the server already sends the no-date wording when it has no date).
  function _progressBlurb(text, scheduledDate) {
    const t = String(text || '');
    if (t.indexOf('{date}') === -1) return t;
    const day = _buildDayLabel(scheduledDate);
    return day ? _fillCopy(t, { date: day }) : '';
  }

  // [{key,label,state}] — the server sends each step's state. An older
  // payload (5-step, no state) is derived from currentIndex so a cached
  // server response still renders.
  function _progressSteps(milestones, idx) {
    const OK = { done: 1, current: 1, upcoming: 1, skipped: 1 };
    return (Array.isArray(milestones) ? milestones : []).map(function (m, i) {
      const st = m && OK[m.state] ? m.state : (i < idx ? 'done' : (i === idx ? 'current' : 'upcoming'));
      return { key: (m && m.key) || '', label: (m && m.label) || '', state: st };
    });
  }

  // Printing (the adjuster's paper copy — portal.html's print sheet keeps
  // "the dated progress tracker"): a closed <details> prints only its
  // summary, so open the step list first.
  try {
    window.addEventListener('beforeprint', function () {
      document.querySelectorAll('details.progress-all').forEach(function (d) { d.open = true; });
    });
  } catch (_) { /* printing is best-effort */ }

  function renderView(view) {
    const firstName = (view.homeowner && view.homeowner.firstName) || '';
    const lastName  = (view.homeowner && view.homeowner.lastName)  || '';
    const fullName = (firstName + ' ' + lastName).trim();
    const address = (view.homeowner && view.homeowner.address) || '';
    repName = (view.rep && view.rep.displayName) || 'Your Rep';
    const companyName = (view.company && view.company.name) || 'No Big Deal Home Solutions';
    // NBD-gate for the few customer-visible fallback labels that hardcode the
    // 'NBD' abbreviation (e.g. the warranty tier fallback): NBD keeps its literal
    // byte-identical, a tenant gets a companyName-derived label instead.
    const isNbdCompany = !(view.company && view.company.name) || view.company.name === 'No Big Deal Home Solutions';

    // Full white-label (2026-07-19): tenant portals get the tenant's title,
    // logo (server-guarded https, tenant-set only), footer, and accent —
    // NBD keeps every literal byte-identical.
    if (!isNbdCompany) {
      try {
        document.title = 'Your Project · ' + companyName;
        var _logo = document.querySelector('.hero-logo');
        if (_logo) {
          if (view.company.logoUrl) {
            // If the logo host is blocked by CSP img-src or 404s, hide the
            // element instead of painting the broken-image icon (drill
            // finding). Realistic tenant logos live in Firebase Storage,
            // which the CSP whitelists.
            _logo.addEventListener('error', function () { _logo.style.display = 'none'; });
            _logo.src = view.company.logoUrl; _logo.alt = companyName;
          }
          else { _logo.style.display = 'none'; }
        }
        var _foot = document.getElementById('portalFooterBrand');
        if (_foot) _foot.textContent = '© 2026 ' + companyName;
        var _footSite = document.getElementById('portalFooterSite');
        if (_footSite) _footSite.style.display = 'none';
        var _cols = view.company.colors || null;
        if (_cols && _cols.accent) {
          // 2026-09-16 (CTA-contrast fix): this used to copy the raw tenant
          // accent verbatim into the background ramp, with only a coarse
          // luminance>0.45 threshold picking white-or-#12223D foreground —
          // not a computed WCAG ratio, so a mid-luminance tenant color could
          // clear that threshold while still failing real AA (4.5:1)
          // against EITHER ink choice. Fix: darken the accent itself, in
          // small steps, until at least one ink choice actually achieves
          // AA — "derive by darkening until AA, don't copy the accent" —
          // then pick whichever ink has the higher of the two ratios. A
          // tenant accent already dark enough exits the loop on the first
          // check (safeAccent === the original color, unchanged).
          var _hexToRgb = function (h) {
            h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
            return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
          };
          var _relLum = function (rgb) {
            var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
            return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
          };
          var _contrast = function (l1, l2) {
            var a = Math.max(l1, l2) + 0.05, b = Math.min(l1, l2) + 0.05; return a / b;
          };
          var _rgbToHex = function (rgb) {
            return '#' + rgb.map(function (v) {
              return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
            }).join('');
          };
          var AA = 4.5; // WCAG AA, normal text — the button label size this drives
          var DARK_INK_LUM = _relLum(_hexToRgb('#12223D'));
          var _rgb = _hexToRgb(_cols.accent);
          var safeAccent = _cols.accent;
          for (var _i = 0; _i < 20; _i++) {
            var _lum = _relLum(_rgb);
            if (_contrast(_lum, 1) >= AA || _contrast(_lum, DARK_INK_LUM) >= AA) { safeAccent = _rgbToHex(_rgb); break; }
            _rgb = _rgb.map(function (c) { return c * 0.9; }); // 10% darker each step
            safeAccent = _rgbToHex(_rgb);
          }
          var _safeLum = _relLum(_hexToRgb(safeAccent));
          var _fg = _contrast(_safeLum, 1) >= _contrast(_safeLum, DARK_INK_LUM) ? '#ffffff' : '#12223D';

          // Override the whole orange RAMP, not just the base token — the
          // tenant drill showed mixed blue/orange (progress dots, eyebrow,
          // totals use the -deep/-medium/-soft/-glow variants). color-mix
          // derives each from safeAccent (the AA-verified color above, not
          // necessarily the raw tenant value).
          // nbd-brand.css also scopes the token set onto .nbd-brand (body
          // carries that class), which SHADOWS an html-level override for
          // everything inside body — set the vars on BOTH roots.
          var _apply = function (st) {
            st.setProperty('--nbd-orange', safeAccent);
            st.setProperty('--accent', safeAccent);
            st.setProperty('--nbd-orange-deep', 'color-mix(in srgb, ' + safeAccent + ' 78%, #000)');
            st.setProperty('--nbd-orange-medium', 'color-mix(in srgb, ' + safeAccent + ' 88%, #000)');
            st.setProperty('--nbd-orange-ink', 'color-mix(in srgb, ' + safeAccent + ' 60%, #000)');
            st.setProperty('--nbd-orange-soft', 'color-mix(in srgb, ' + safeAccent + ' 12%, transparent)');
            st.setProperty('--nbd-orange-glow', 'color-mix(in srgb, ' + safeAccent + ' 30%, transparent)');
            st.setProperty('--nbd-ink-on-orange', _fg);
          };
          _apply(document.documentElement.style);
          if (document.body) _apply(document.body.style);
        }
      } catch (e) { /* brand chrome is best-effort; portal content still renders */ }
    } else {
      // portal.html now ships a neutral "Your Project" title (no company
      // name during loading); NBD's own portal gets its full title back here
      // (companyName resolves to NBD's name on this branch).
      document.title = 'Your Project · ' + companyName;
    }
    // Footer was hidden while loading — reveal it now that it carries the
    // right company.
    try { var _pf = document.getElementById('portalFooter'); if (_pf) _pf.style.visibility = ''; } catch (_) {}

    // Hero
    document.getElementById('heroWrap').style.display = '';
    document.getElementById('heroCompany').textContent = companyName;
    document.getElementById('heroTitle').textContent = fullName
      ? 'Hey ' + firstName + ', here\'s your project'
      : 'Your project';
    document.getElementById('heroSub').textContent = address
      ? address + ' · managed by ' + repName
      : 'Managed by ' + repName;

    const parts = [];

    // ── Project progress tracker ──
    // 9 steps (2026-10-03): Inspection → Estimate → Signed → Build day set →
    // Build → Final walkthrough → Final payment → Warranty → Review. The
    // server (functions/homeowner-progress.js) decides the step, each step's
    // state and every word; this lays it out for a phone: the current step,
    // the next one and the done count up top, the full list behind a native
    // <details> (no script, no inline handler, no inline style).
    if (view.progress && Array.isArray(view.progress.milestones)) {
      const p = view.progress;
      const copy = p.copy || {};
      const idx = p.currentIndex >= 0 ? p.currentIndex : 0;
      const steps = _progressSteps(p.milestones, idx);
      const total = typeof p.total === 'number' ? p.total : steps.length;
      const doneCount = typeof p.doneCount === 'number' ? p.doneCount : idx;
      const blurb = _progressBlurb(p.currentBlurb, p.scheduledDate);
      const countText = copy.doneCount ? _fillCopy(copy.doneCount, { done: doneCount, total: total }) : '';

      // One segment per step; the state rides on a data attribute for CSS.
      const bar = '<div class="progress-bar" aria-hidden="true">' +
        steps.map(function (s) {
          return '<span class="progress-seg" data-state="' + esc(s.state) + '"></span>';
        }).join('') +
      '</div>';

      // Actions — each reuses something the page ALREADY shows: the
      // rep-sent Stripe link (server sends payLink only for an unpaid Final
      // payment step), the rating card, the warranty card.
      const ratingInfoP = view.rating || {};
      const actions = [];
      if (p.payLink && safeUrl(p.payLink) && copy.payLink) {
        actions.push('<a class="btn progress-action" href="' + esc(safeUrl(p.payLink)) + '" target="_blank" rel="noopener">' + esc(copy.payLink) + '</a>');
      }
      if (p.currentKey === 'review' && ratingInfoP.canRate && !ratingInfoP.submitted && copy.reviewLink) {
        actions.push('<a class="btn progress-action" href="#cr-card">' + esc(copy.reviewLink) + '</a>');
      }
      if (p.warrantyOnFile && view.warranty && (p.currentKey === 'review' || p.currentKey === 'warranty') && copy.warrantyLink) {
        actions.push('<a class="btn btn-ghost progress-action" href="#wc-card">' + esc(copy.warrantyLink) + '</a>');
      }

      const list = '<ol class="progress-list">' +
        steps.map(function (s, i) {
          const mark = s.state === 'done' ? '✓' : (s.state === 'skipped' ? '–' : String(i + 1));
          // Only a finished step carries a date (the current one isn't done).
          const dateLabel = s.state === 'done'
            ? _milestoneDateLabel(p.milestoneDates && p.milestoneDates[s.key])
            : null;
          return '<li class="progress-item" data-state="' + esc(s.state) + '"' +
              (s.state === 'current' ? ' aria-current="step"' : '') + '>' +
            '<span class="progress-dot" aria-hidden="true">' + mark + '</span>' +
            '<span class="progress-item-label">' + esc(s.label) + '</span>' +
            (dateLabel ? '<span class="progress-step-date">' + esc(dateLabel) + '</span>' : '') +
          '</li>';
        }).join('') +
      '</ol>';

      const nextHtml = p.nextLabel
        ? '<div class="progress-next">' +
            '<div class="progress-next-label">' + esc(copy.nextUp || '') + '</div>' +
            '<div><strong>' + esc(p.nextLabel) + '</strong></div>' +
          '</div>'
        : (!p.pending && copy.allDone
          ? '<div class="progress-next progress-next-done">' + esc(copy.allDone) + '</div>'
          : '');
      // Sits above "Next up" because it is the more specific fact: a date
      // beats a milestone name. Rendered from the raw YYYY-MM-DD the server
      // sent, compared against the READER's local today.
      const sched = _scheduleLine(p.scheduledDate, _localToday());
      const schedWin = sched ? _scheduleWindowSuffix(p.scheduledDate, p.scheduleWindow, sched.when) : '';
      // No exact date yet but a planned week → the week line (never both).
      const week = sched ? null : _weekLine(p.scheduledWeek, _localToday());
      const schedHtml = sched
        ? '<div class="progress-schedule" data-when="' + esc(sched.when) + '">'
            + '<span aria-hidden="true">📅</span> ' + esc(sched.text) + esc(schedWin)
          + '</div>'
        : week
          ? '<div class="progress-schedule" data-when="week">'
              + '<span aria-hidden="true">📅</span> ' + esc(week.text)
              + '<div class="progress-schedule-note">' + esc(week.note) + '</div>'
            + '</div>'
          : '';
      // "Also scheduled — Gutter guards: Crew arrives Monday, October 12"
      const otherHtml = _otherJobLines(p.otherJobs, _localToday()).map(function (o) {
        const win = o.date ? _scheduleWindowSuffix(o.date, o.win, o.when) : '';
        return '<div class="progress-schedule" data-when="' + esc(o.when) + '" data-other-job>'
          + '<span aria-hidden="true">📅</span> Also scheduled — <strong>' + esc(o.title) + '</strong>: ' + esc(o.text) + esc(win)
          + '</div>';
      }).join('');
      parts.push(
        '<div class="card progress-card" data-progress-step="' + esc(p.currentKey || '') + '">' +
          '<div class="card-label">' + esc(copy.heading || '') + '</div>' +
          '<div class="progress-head">' +
            '<div class="card-title">' + esc(p.currentLabel) + '</div>' +
            (countText ? '<div class="progress-count">' + esc(countText) + '</div>' : '') +
          '</div>' +
          bar +
          (blurb ? '<p class="progress-blurb">' + esc(blurb) + '</p>' : '') +
          (p.paidLine && p.currentKey !== 'payment' ? '<p class="progress-paid">' + esc(p.paidLine) + '</p>' : '') +
          (actions.length ? '<div class="progress-actions">' + actions.join('') + '</div>' : '') +
          schedHtml +
          otherHtml +
          nextHtml +
          '<details class="progress-all">' +
            '<summary>' + esc(_fillCopy(copy.showAll || '', { total: steps.length })) + '</summary>' +
            list +
          '</details>' +
        '</div>'
      );
    }

    // B6 — Reorder: when the estimate is SIGNED, booking becomes the
    // primary CTA. When it's AWAITING signature, the embedded signer
    // goes first. When neither, only the booking card shows.
    const estStatus = (view.estimate && view.estimate.signatureStatus) || 'none';
    const awaitingSign = estStatus === 'sent' || estStatus === 'viewed';
    const signedNow = estStatus === 'signed';

    // ── Estimate summary ──
    if (view.estimate) {
      const e = view.estimate;
      // Audit batch 7: the homeowner is looking at the estimate.
      // Capture as estimate_view; resourceId = estimate doc id.
      if (e.id) _emitAuditEvent('estimate_view', e.id);
      const sig = signaturePill(e.signatureStatus || 'none');
      const hasTotal = e.grandTotal != null && !isNaN(Number(e.grandTotal));
      const signedHref = safeUrl(e.signedDocumentUrl);
      // Audit batch 7 gap fix: id lets wireDocumentLinks() below bind a
      // click handler that emits document_view — this was the one
      // homeowner document-viewing action with zero audit trail.
      const signedPdf = signedHref
        ? '<a id="signedContractLink" class="btn btn-ghost" style="margin-top:12px;" href="' + esc(signedHref) + '" target="_blank" rel="noopener">📄 Download Signed Contract</a>'
        : '';
      parts.push(
        '<div class="card">' +
          '<div class="card-label">Your Estimate</div>' +
          '<div class="row">' +
            '<div>' +
              // A null/NaN total used to render fmtMoney()'s em-dash into
              // .big-num — a 36px orange "—" under the word TOTAL, which
              // reads as a broken page at the moment the customer is
              // deciding. Say the honest thing instead.
              (hasTotal
                ? '<div class="kv-key">Total</div><div class="big-num">' + esc(fmtMoney(e.grandTotal)) + '</div>'
                : '<div class="kv-key">Total</div><div class="kv-val" style="color:var(--muted);">Your rep is still putting the numbers together.</div>') +
              (e.tierName ? '<div class="kv-val" style="margin-top:6px;color:var(--muted);">' + esc(e.tierName) + '</div>' : '') +
              // Payment terms (2026-09-25): the deposit rule's own sentence,
              // stamped by the rep's builder and validated server-side
              // (functions/deposit-plan-view.js) — the same words the quote,
              // contract and invoice print. Absent on older estimates.
              ((e.depositPlan && e.depositPlan.summary)
                ? '<div class="kv-key" style="margin-top:12px;">' + esc(e.depositPlan.label || 'Due at signing') + '</div>' +
                  '<div class="kv-val" data-portal-deposit><strong>' + esc(e.depositPlan.valueText || '') + '</strong></div>' +
                  '<div class="kv-val" style="margin-top:4px;color:var(--muted);font-size:13px;line-height:1.5;">' + esc(e.depositPlan.summary) + '</div>'
                : '') +
              // The itemized scope. /pro/estimate-view.html is a complete,
              // deployed, cost-redacted line-item viewer — every line with
              // quantity and retail total, the roof measurements, the tier
              // cards — and the portal linked to it exactly zero times, so
              // the homeowner's whole answer to "what am I paying for?" was
              // one orange number and a status pill, with the signature
              // iframe as the very next card.
              //
              // No new credential: getEstimateForView takes this same portal
              // token, and refuses an estimateId whose leadId does not match
              // the token's (functions/portal.js, cross-tenant defense), so
              // the link grants nothing the homeowner does not already hold.
              (e.id
                ? '<div style="margin-top:12px;">' +
                    '<a class="btn" href="' + esc(_estimateScopeHref(e.id)) + '"'
                      + ' target="_blank" rel="noopener">See what\'s included →</a>' +
                  '</div>'
                : '') +
            '</div>' +
            '<div>' +
              '<div class="kv-key">Status</div>' +
              // Was: (sig || '<span class="pill">Draft</span>'). Only shared
              // estimates reach the portal now, so "Draft" would be both
              // unreachable and, if it ever did fire, alarming — a homeowner
              // should never be told the thing they are looking at is a
              // draft of their own contract. A shared estimate with no
              // signature flow is simply "sent".
              '<div class="kv-val">' + (sig || '<span class="pill">Sent to you</span>') + '</div>' +
              (e.signedAt ? '<div class="kv-val" style="color:var(--muted);font-size:13px;margin-top:6px;">Signed ' + esc(new Date(e.signedAt).toLocaleDateString()) + '</div>' : '') +
              signedPdf +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }

    // ── Sign your contract (in-house e-sign, 2026-10-04) ──
    // While the estimate awaits the homeowner's signature the server returns
    // the live single-use signing link (functions/portal.js — the same link
    // their email carries). It opens the signing page; there is no
    // third-party iframe any more (BoldSign's embed never had a key, so this
    // card only ever said "Check your email").
    const signUrl = signLink(view.estimate && view.estimate.signUrl);
    if (awaitingSign && signUrl) {
      parts.push(
        '<div class="card" style="border-color:var(--orange);">' +
          '<div class="card-label">Sign Your Contract</div>' +
          '<div class="card-title">Ready for your signature</div>' +
          '<p style="color:var(--muted);margin:0 0 14px;">Review it on your phone and sign in about a minute. Once signed, you get a copy by email and your rep gets a confirmation.</p>' +
          '<a id="portalSignLink" class="btn" href="' + esc(signUrl) + '" target="_blank" rel="noopener">Review &amp; sign →</a>' +
        '</div>'
      );
    } else if (awaitingSign && !signUrl) {
      // Awaiting but no embed — fall back to the emailed link.
      parts.push(
        '<div class="card" style="border-color:var(--orange);">' +
          '<div class="card-label">Sign Your Contract</div>' +
          '<div class="card-title">Check your email</div>' +
          '<p style="color:var(--muted);margin:0 0 14px;">We\'ve sent the signing link. If you can\'t find it, reply to any message from your rep and we\'ll re-send.</p>' +
        '</div>'
      );
    }

    // ── Documents shelf (2026-09-16) ──
    // Contract/estimate/invoice/warranty/etc (auto-visible, generated by
    // construction) + any rep-shared upload + signed ancillary (esign)
    // paperwork — see functions/portal.js's view.documents build for the
    // visibility rule. A row with a direct `url` (upload, or an esign PDF —
    // both already server-validated https) just downloads; a row with none
    // (`viaHtml`, generated HTML content) opens in the sandboxed viewer
    // below — see wirePortalDocumentsCard for why that can't be a plain
    // link the way the others are.
    if (Array.isArray(view.documents) && view.documents.length) {
      const docRows = view.documents.map(function (d) {
        const dateLabel = _milestoneDateLabel(d.date);
        const meta = dateLabel ? '<div class="doc-meta">' + esc(dateLabel) + '</div>' : '';
        const action = d.url
          ? '<a class="btn btn-ghost" href="' + esc(safeUrl(d.url)) + '" target="_blank" rel="noopener">Download</a>'
          : '<button type="button" class="btn btn-ghost portal-doc-view" data-doc-id="' + esc(d.id) + '">View</button>';
        return '<div class="doc-row">' +
                 '<div class="doc-info"><div class="doc-name">' + esc(d.name) + '</div>' + meta + '</div>' +
                 action +
               '</div>';
      }).join('');
      parts.push(
        '<div class="card">' +
          '<div class="card-label">📄 Your Documents</div>' +
          '<div class="doc-list">' + docRows + '</div>' +
        '</div>'
      );
    }

    // ── Balance due / pay (2026-09-16), read-only ──
    // Only ever shows a real, already-rep-sent Stripe link (functions/
    // portal.js never mints one) — never a dead "Pay Now" button. Absent
    // entirely when there's no outstanding invoice, same gating shape as
    // every other conditional card on this page.
    if (view.balance) {
      const amount = (view.balance.amountCents / 100).toLocaleString(undefined, {
        style: 'currency', currency: 'USD'
      });
      const payAction = view.balance.stripePaymentLink
        ? '<a class="btn" style="margin-top:12px;" href="' + esc(safeUrl(view.balance.stripePaymentLink)) + '" target="_blank" rel="noopener">Pay Now →</a>'
        : '<p style="color:var(--muted);margin:12px 0 0;">Ask your rep for a payment link to pay online.</p>';
      parts.push(
        '<div class="card">' +
          '<div class="card-label">💳 Balance Due</div>' +
          '<div class="card-title">' + esc(amount) + '</div>' +
          payAction +
        '</div>'
      );
    }

    // ── Booking embed ──
    // The rep's calendar can carry more than one visit type (see
    // booking-events.js). Which one belongs here depends on where the job
    // is: a homeowner sitting on an unsigned estimate wants to talk about
    // the estimate, not book another roof inspection. The other available
    // types are listed underneath rather than hidden.
    //
    // Tenancy: options() reads view.rep + the company name off the
    // server-rendered view, so a tenant with nothing configured gets an
    // empty list and this whole card is skipped — same as the old
    // `if (view.bookingUrl)` guard, which is kept as the fallback path.
    if (view.bookingUrl) {
      const bookCtx = {
        rep: view.rep || {},
        companyName: (view.company && view.company.name) || ''
      };
      const bookOpts = (window.NBDBooking && window.NBDBooking.options(bookCtx)) || [];
      const wantKind = awaitingSign ? 'estimate' : 'inspection';
      const primary =
        bookOpts.find((o) => o.kind === wantKind) ||
        bookOpts.find((o) => o.kind === 'inspection') ||
        bookOpts[0] ||
        // No catalog (script blocked, or an older cached portal.js): fall
        // back to exactly what the server already resolved.
        { kind: 'inspection', label: 'Book a Time', url: view.bookingUrl };

      const embedSrc = primary.url + (primary.url.indexOf('?') === -1 ? '?' : '&') + 'embed=true&theme=light';

      let label, title, subtitle, borderCss;
      if (primary.kind === 'estimate') {
        label = 'Before You Sign';
        title = 'Questions about your estimate?';
        subtitle = 'Grab a slot and we will go through it line by line — materials, timeline, warranty, what insurance covers. Nothing to sign on the call.';
        borderCss = 'border-color:var(--orange);';
      } else if (signedNow) {
        label = 'Next Step';
        title = 'Book your inspection';
        subtitle = 'Pick a time for our crew to inspect your roof and confirm next steps.';
        borderCss = 'border-color:var(--green);';
      } else {
        label = 'Book a Time';
        title = 'Book a Time';
        subtitle = 'Your rep will confirm within the hour. Reschedule anytime from the confirmation email.';
        borderCss = '';
      }

      // Anything else this rep offers, as plain links under the embed.
      const others = bookOpts.filter((o) => o.url !== primary.url);
      const othersHtml = others.length
        ? '<div style="margin-top:14px;border-top:1px solid var(--br);padding-top:12px;">' +
            '<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Need something else?</div>' +
            others.map((o) =>
              '<a class="btn" style="margin:0 8px 8px 0;" href="' + esc(safeUrl(o.url)) + '" target="_blank" rel="noopener">' +
                esc(o.label) + '</a>'
            ).join('') +
          '</div>'
        : '';

      parts.push(
        '<div class="card" style="' + borderCss + '">' +
          '<div class="card-label">' + esc(label) + '</div>' +
          '<div class="card-title">' + esc(title) + '</div>' +
          '<p style="color:var(--muted);margin:0 0 14px;">' + esc(subtitle) + '</p>' +
          // data-embed="booking": portal.html hides this frame on phones,
          // where the button below is the booking path (phone audit,
          // 2026-09-25 — see the .cal-embed rule there).
          '<iframe class="cal-embed" data-embed="booking" src="' + esc(embedSrc) + '" title="Schedule" loading="lazy" referrerpolicy="no-referrer"></iframe>' +
          '<div style="margin-top:10px;"><a class="btn" href="' + esc(safeUrl(primary.url)) + '" target="_blank" rel="noopener">Open Booking Page →</a></div>' +
          othersHtml +
        '</div>'
      );
    }

    // ── Project photos gallery ──
    // Phase 5 (Output Engine): Phase tabs + Location filter chips on
    // the portal so a homeowner with 100 shared photos can scan by
    // "what's done" (After) or "where you worked" (Roof slope). Only
    // photos the rep flipped to sharedWithHomeowner reach this view
    // already (server-side filter in getHomeownerPortalView).
    const photos = Array.isArray(view.photos) ? view.photos : [];
    if (photos.length) {
      const phaseOrder = { 'Before': 0, 'During': 1, 'After': 2 };
      const sorted = photos.slice().sort(function (a, b) {
        const pa = phaseOrder[a.phase] != null ? phaseOrder[a.phase] : 1;
        const pb = phaseOrder[b.phase] != null ? phaseOrder[b.phase] : 1;
        return pa - pb;
      });

      // Stash globally so the tab/chip filter handlers can re-render.
      window._portalPhotos = sorted;
      window._portalPhotoFilter = { phase: 'all' };

      // Phase counts for tab labels. (Location chips were removed — the server
      // redacts photo `location` from the homeowner payload, so the chips never
      // had data and the location filter was dead code.)
      const phaseCount = { all: sorted.length, Before: 0, During: 0, After: 0 };
      sorted.forEach(function (p) {
        if (p.phase === 'Before' || p.phase === 'During' || p.phase === 'After') {
          phaseCount[p.phase]++;
        }
      });
      const phaseTabs = ['all', 'Before', 'During', 'After']
        .filter(function (k) { return phaseCount[k] > 0; })
        .map(function (k) {
          const label = k === 'all' ? 'All' : k;
          return '<button class="ph-tab" data-phase="' + esc(k) + '"' + (k === 'all' ? ' aria-pressed="true"' : '') + '>' +
                   esc(label) + ' <span class="ph-tab-count">' + phaseCount[k] + '</span>' +
                 '</button>';
        }).join('');

      parts.push(
        '<div class="card" id="portalPhotoCard">' +
          '<div class="card-label">Project Photos</div>' +
          '<div class="card-title">' + photos.length + ' photo' + (photos.length === 1 ? '' : 's') + ' from your project</div>' +
          (phaseTabs ? '<div class="ph-tabs" role="tablist" id="portalPhaseTabs">' + phaseTabs + '</div>' : '') +
          '<div class="ph-grid" id="portalPhotoGrid"></div>' +
          '<div class="ph-empty" id="portalPhotoEmpty" style="display:none;">No photos match these filters.</div>' +
        '</div>'
      );
    }

    // ── Wave 118: Customer photo upload card ──
    // The portal's biggest close-the-loop opportunity: let the
    // homeowner upload photos of damage/concerns without waiting
    // for an inspection. Single drag-drop or tap-to-upload, with
    // a caption + immediate confirmation.
    parts.push(
      '<div class="card" id="cuh-card" style="border:1px dashed var(--accent, #A14A22);background:rgba(189,87,40,0.04);">' +
        '<div class="card-label">📸 Show Us What You See</div>' +
        '<div class="card-title">Upload a photo</div>' +
        '<p style="color:var(--muted);margin:0 0 14px;font-size:14px;line-height:1.5;">Spotted storm damage? Mid-job concern? Want to show us the finished work? Snap a photo — your rep gets it in seconds.</p>' +
        '<input id="cuh-file" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" style="display:none;">' +
        '<button id="cuh-pick" type="button" class="btn" style="width:100%;padding:14px;font-size:15px;background:var(--accent, #A14A22);color:#fff;border:none;border-radius:8px;cursor:pointer;-webkit-tap-highlight-color:transparent;">📷 Choose a photo</button>' +
        '<div id="cuh-preview" style="display:none;margin-top:12px;"></div>' +
        '<div id="cuh-status" style="display:none;margin-top:10px;padding:10px;border-radius:6px;font-size:13px;"></div>' +
      '</div>'
    );

    // ── Rep contact card ──
    const phoneHref = view.rep && view.rep.phone ? 'tel:' + view.rep.phone.replace(/\D/g, '') : null;
    parts.push(
      '<div class="card">' +
        '<div class="card-label">Your Rep</div>' +
        '<div class="card-title">' + esc(repName) + '</div>' +
        '<div style="color:var(--muted);font-size:13px;margin-bottom:10px;">' + esc(companyName) + '</div>' +
        (phoneHref
          ? '<a class="btn btn-ghost" href="' + esc(phoneHref) + '">📞 ' + esc(view.rep.phone) + '</a>'
          : '') +
      '</div>'
    );

    // ── Wave 121: Customer rating card (only on completed jobs) ──
    // Two states:
    //   1. Already rated → show a small "You rated this 5★" recap card
    //   2. Can rate (job complete + not yet rated) → show the rater
    // Hidden entirely on jobs that aren't complete yet.
    const ratingInfo = view.rating || {};
    if (ratingInfo.canRate && !ratingInfo.submitted) {
      parts.push(
        '<div class="card" id="cr-card" style="border:1px solid var(--accent, #A14A22);background:rgba(189,87,40,0.05);">' +
          '<div class="card-label">⭐ How did we do?</div>' +
          '<div class="card-title">Rate your experience</div>' +
          '<p style="color:var(--muted);margin:0 0 14px;font-size:14px;line-height:1.5;">Your rep would love to hear how the project went. It only takes a tap.</p>' +
          '<div id="cr-stars" style="display:flex;justify-content:space-between;gap:6px;margin-bottom:14px;">' +
            [1,2,3,4,5].map(n =>
              '<button type="button" class="cr-star" data-stars="' + n + '" aria-label="' + n + ' stars" style="flex:1;padding:14px 0;border-radius:8px;border:1px solid var(--br, #2a3344);background:var(--bg, #0a1424);color:#888;font-size:24px;cursor:pointer;transition:all 120ms ease;-webkit-tap-highlight-color:transparent;">☆</button>'
            ).join('') +
          '</div>' +
          '<textarea id="cr-comment" rows="2" maxlength="500" placeholder="Tell us a bit more (optional)" style="width:100%;padding:10px;border-radius:6px;border:1px solid var(--br, #2a3344);background:var(--bg, #0a1424);color:inherit;font:inherit;font-size:13px;box-sizing:border-box;resize:vertical;margin-bottom:10px;display:none;"></textarea>' +
          '<button id="cr-send" type="button" class="btn" disabled style="width:100%;padding:13px;font-size:14px;background:var(--accent, #A14A22);color:#fff;border:none;border-radius:8px;cursor:pointer;opacity:0.55;display:none;">Send rating</button>' +
          '<div id="cr-status" style="display:none;margin-top:10px;padding:10px;border-radius:6px;font-size:13px;"></div>' +
          '<div id="cr-thanks" style="display:none;margin-top:8px;padding:14px;border-radius:8px;background:rgba(46,204,138,0.08);border:1px solid rgba(46,204,138,0.45);"></div>' +
        '</div>'
      );
    } else if (ratingInfo.submitted) {
      const stars = Number(ratingInfo.stars) || 0;
      parts.push(
        '<div class="card" style="border:1px solid var(--br, #2a3344);">' +
          '<div class="card-label">⭐ Your rating</div>' +
          '<div style="font-size:24px;letter-spacing:4px;color:#fbbf24;">' +
            '★'.repeat(stars) + '<span style="color:#444;">' + '☆'.repeat(5 - stars) + '</span>' +
          '</div>' +
          '<div style="color:var(--muted);font-size:13px;margin-top:8px;">Thanks for rating ' + esc(repName.split(' ')[0]) + '!</div>' +
        '</div>'
      );
    }

    // ── D-2.7: Before & After photo sliders ──
    // Card only renders when the server returned at least one
    // before/after pair (auto-matched by location + phase tag).
    // Each pair becomes a draggable slider — homeowner drags the
    // orange handle left/right to reveal the After over the Before.
    if (Array.isArray(view.photoPairs) && view.photoPairs.length > 0) {
      const slots = view.photoPairs.map((_, i) => '<div class="ba-slot" data-i="' + i + '"></div>').join('');
      parts.push(
        '<div class="card" id="ba-card">' +
          '<div class="card-label">📸 Before &amp; After</div>' +
          '<div class="card-title">See the transformation</div>' +
          '<p style="color:var(--muted);margin:0 0 16px;font-size:13px;line-height:1.5;">Drag the orange handle to slide between the before and after for each location.</p>' +
          '<div style="display:flex;flex-direction:column;gap:24px;">' + slots + '</div>' +
        '</div>'
      );
    }

    // ── Wave 123: Async messaging card (homeowner ↔ rep) ──
    // Always rendered. Thread loads via getPortalMessages on mount,
    // refreshes every 30s while the page is visible.
    parts.push(
      '<div class="card" id="pm-card">' +
        '<div class="card-label">💬 Message Your Rep</div>' +
        '<div class="card-title">Quick questions, anytime</div>' +
        '<p style="color:var(--muted);margin:0 0 14px;font-size:13px;line-height:1.5;">No phone tag. ' + esc(repName.split(' ')[0]) + ' will see this in their CRM.</p>' +
        '<div id="pm-thread" style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:8px;background:var(--bg, #0a1424);border-radius:8px;border:1px solid var(--br, #2a3344);margin-bottom:12px;">' +
          '<div id="pm-empty" style="color:var(--muted);font-size:13px;text-align:center;padding:18px 8px;line-height:1.5;">' +
            '<div style="font-size:28px;margin-bottom:6px;">💬</div>' +
            '<div style="font-weight:600;color:inherit;margin-bottom:4px;">Start a conversation with ' + esc(repName.split(' ')[0]) + '</div>' +
            'Ask anything — pricing, scheduling, what to expect.' +
          '</div>' +
        '</div>' +
        '<textarea id="pm-text" rows="2" maxlength="2000" placeholder="Type your message… (Enter to send · Shift+Enter for new line)" style="width:100%;padding:10px;border-radius:6px;border:1px solid var(--br, #2a3344);background:var(--bg, #0a1424);color:inherit;font:inherit;font-size:14px;box-sizing:border-box;resize:vertical;margin-bottom:6px;"></textarea>' +
        '<div style="display:flex;align-items:center;justify-content:flex-end;margin-bottom:8px;">' +
          '<div id="pm-counter" style="font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;">0 / 2000</div>' +
        '</div>' +
        '<button id="pm-send" type="button" class="btn" disabled style="width:100%;padding:12px;font-size:14px;background:var(--accent, #A14A22);color:#fff;border:none;border-radius:8px;cursor:pointer;opacity:0.55;">Send</button>' +
        '<div id="pm-status" style="display:none;margin-top:8px;padding:8px;border-radius:6px;font-size:12px;"></div>' +
      '</div>'
    );

    // ── Wave 119: Request a callback card ──
    // Companion to the call-now button: lets the homeowner pick a
    // time-window that works for them instead of playing phone tag.
    // Lands as a task on the lead so it surfaces in the rep's bell.
    parts.push(
      '<div class="card" id="cb-card">' +
        '<div class="card-label">📞 Or — Request a Callback</div>' +
        '<div class="card-title">Pick a time that works</div>' +
        '<p style="color:var(--muted);margin:0 0 14px;font-size:14px;line-height:1.5;">Busy now? Tell your rep when to call. They\'ll get the request right away.</p>' +
        '<div id="cb-slots" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;">' +
          '<button type="button" class="cb-slot" data-slot="today">Today</button>' +
          '<button type="button" class="cb-slot" data-slot="tomorrow-morning">Tomorrow morning</button>' +
          '<button type="button" class="cb-slot" data-slot="tomorrow-afternoon">Tomorrow afternoon</button>' +
          '<button type="button" class="cb-slot" data-slot="tomorrow-evening">Tomorrow evening</button>' +
          '<button type="button" class="cb-slot" data-slot="weekend">This weekend</button>' +
          '<button type="button" class="cb-slot" data-slot="anytime">Anytime this week</button>' +
        '</div>' +
        '<textarea id="cb-note" rows="2" maxlength="280" placeholder="What\'s the best way to reach you? (optional)" style="width:100%;padding:10px;border-radius:6px;border:1px solid var(--br, #2a3344);background:var(--bg, #0a1424);color:inherit;font:inherit;font-size:13px;box-sizing:border-box;resize:vertical;margin-bottom:10px;"></textarea>' +
        '<button id="cb-send" type="button" class="btn" disabled style="width:100%;padding:13px;font-size:14px;background:var(--accent, #A14A22);color:#fff;border:none;border-radius:8px;cursor:pointer;opacity:0.55;">Pick a time first</button>' +
        '<div id="cb-status" style="display:none;margin-top:10px;padding:10px;border-radius:6px;font-size:13px;"></div>' +
      '</div>'
    );

    // ── Step 17: Digital Warranty Card ──
    // Rendered when the rep has generated a warranty certificate from
    // customer.html (which now persists `lead.warranty`). Acts as the
    // homeowner's permanent reference: tier, terms, contact CTA. Hidden
    // until the rep issues a cert.
    if (view.warranty) {
      const w = view.warranty;
      const tierAccent = w.tier === 'elite' ? '#111'
                       : w.tier === 'preferred' ? '#1a3260'
                       : w.tier === 'beyond' ? '#0f5257'
                       : w.tier === 'economy' ? '#5b5f66'
                       : '#A14A22';
      // Economy is a 1-YEAR labor warranty (Jo, 2026-10-02), never the
      // Lifetime Pledge — even when an older card carries no saved label.
      const pledgeTitle = w.tier === 'economy'
        ? 'Economy — 1-Year Labor Warranty'
        : (isNbdCompany ? 'NBD Lifetime Pledge' : companyName + ' Lifetime Pledge');
      const installLabel = w.installDate
        ? new Date(w.installDate + 'T12:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
        : '—';
      // 2026-09-15 (Warranty Claim lane): the sms: deep link below used to be
      // the entire flow — tapping it just opened the phone's own Messages
      // app with a pre-filled body, which meant the "claim" existed nowhere
      // until (if) the homeowner actually sent that text and the rep
      // happened to read it. Now posts to reportWarrantyClaim, which drops a
      // task + activity entry on the lead like every other portal card here.
      const claimCta = w.openWarrantyClaimId
        ? '<div style="text-align:center;padding:12px;background:var(--nbd-bg-tint);border:1px solid var(--br,#2a3344);border-radius:8px;font-size:13px;color:var(--muted);">🛟 Claim in progress — ' + esc(repName) + ' is on it.</div>'
        : (
          '<div id="wc-form">' +
            '<textarea id="wc-issue" rows="2" maxlength="2000" placeholder="What\'s going on? (e.g. leak near the chimney, missing shingle)" ' +
              'style="width:100%;background:var(--bg,#0a1424);border:1px solid var(--br,#2a3344);border-radius:8px;padding:10px 12px;color:inherit;font:inherit;font-size:13px;resize:vertical;margin-bottom:10px;box-sizing:border-box;"></textarea>' +
            '<button type="button" id="wc-send" style="display:block;width:100%;text-align:center;padding:12px;background:var(--accent,#A14A22);color:#fff;border:none;border-radius:8px;font-weight:700;font-size:13px;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;">🛟 Start a warranty claim</button>' +
            '<div id="wc-status" style="display:none;margin-top:10px;padding:10px 12px;border-radius:8px;font-size:12px;"></div>' +
          '</div>'
        );
      parts.push(
        '<div class="card" id="wc-card" style="background:linear-gradient(135deg, rgba(189,87,40,.04), rgba(189,87,40,.01)); border:1px solid rgba(189,87,40,.35);">' +
          '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px;">' +
            '<div>' +
              '<div class="card-label" style="color:var(--accent,#A14A22);">🛡️ Digital Warranty Card</div>' +
              '<div class="card-title" style="margin-top:2px;">' + esc(w.tierLabel || pledgeTitle) + '</div>' +
            '</div>' +
            '<div style="background:' + tierAccent + ';color:#fff;font-family:\'Barlow Condensed\',sans-serif;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;padding:5px 12px;border-radius:3px;white-space:nowrap;">' + esc(w.tier || 'standard') + '</div>' +
          '</div>' +

          (w.tierDesc ? '<p style="color:var(--text);margin:0 0 14px;font-size:13px;line-height:1.55;">' + esc(w.tierDesc) + '</p>' : '') +

          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">' +
            '<div style="background:var(--nbd-bg-tint);border:1px solid var(--br,#2a3344);border-radius:7px;padding:10px 12px;">' +
              '<div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:3px;">Installed</div>' +
              '<div style="font-size:13px;font-weight:700;color:var(--text);">' + esc(installLabel) + '</div>' +
            '</div>' +
            '<div style="background:var(--nbd-bg-tint);border:1px solid var(--br,#2a3344);border-radius:7px;padding:10px 12px;">' +
              '<div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:3px;">Cert No.</div>' +
              '<div style="font-size:13px;font-weight:700;color:var(--text);font-family:\'Barlow\',sans-serif;font-variant-numeric:tabular-nums;">' + esc(w.certNumber || '—') + '</div>' +
            '</div>' +
          '</div>' +

          (w.work ? '<div style="background:var(--nbd-bg-tint);border:1px solid var(--br,#2a3344);border-radius:7px;padding:10px 12px;margin-bottom:14px;">' +
            '<div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:3px;">Work Performed</div>' +
            '<div style="font-size:13px;color:var(--text);">' + esc(w.work) + '</div>' +
          '</div>' : '') +

          claimCta +

          '<p style="font-size:11px;color:var(--muted);margin:12px 0 0;line-height:1.5;text-align:center;">Save this page or screenshot it — your permanent warranty reference.</p>' +
        '</div>'
      );
    }

    // ── Step 16: Refer a friend ──
    // Two conditions, and both matter.
    //
    // 1. A stable referral code (customerId — NBD-0001 format). Leads
    //    without one are usually unstamped or pre-Wave 0 stragglers; rather
    //    than build a half-working link we hide the card entirely.
    //
    // 2. The job is actually FINISHED. customerId is stamped early in the
    //    lifecycle, so gating on it alone put this card in front of a
    //    homeowner the same afternoon the rep knocked — handing them SMS
    //    copy reading "They did a great job for me" and email copy reading
    //    "the guys who did mine were great", addressed to their friends.
    //    This is the one card designed to leave the property, so it is the
    //    most embarrassing thing on the page if forwarded before anything
    //    happened, and it poisons the referral channel it exists to grow.
    //
    //    It is the same gate the rating card uses (view.rating.canRate —
    //    PAID IN FULL since 2026-10-03, computed server-side by
    //    functions/homeowner-progress.js and re-enforced when a rating is
    //    submitted). Asking for a referral at
    //    the moment you ask for a rating is the correct pairing: both claim
    //    the work is done, so both wait until it is.
    const customerId = view.homeowner && view.homeowner.customerId;
    const jobComplete = !!(view.rating && view.rating.canRate === true);
    if (customerId && jobComplete) {
      // Canonical custom domain — NOT the *.web.app origin, which Google
      // Safe Browsing has flagged (a friend tapping the texted link in
      // Chrome would hit a red interstitial). Every other homeowner-facing
      // link in the app uses nobigdealwithjoedeal.com.
      const referLink = 'https://nobigdealwithjoedeal.com/pro/refer.html?ref=' + encodeURIComponent(customerId) + (isNbdCompany ? '' : ('&co=' + encodeURIComponent(companyName)));
      const sent = (view.referralStats && view.referralStats.sent) || 0;
      const statPill = sent > 0
        ? '<span style="background:rgba(46,204,138,.16);color:var(--nbd-success);border:1px solid rgba(46,204,138,.4);font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;letter-spacing:.04em;">✓ ' + sent + ' sent your way</span>'
        : '';
      const smsBody = encodeURIComponent(
        "Hey — wanted to share my roofing guys (" + companyName + "). They did a great job for me. " + referLink
      );
      const emailSubject = encodeURIComponent('My roofing recommendation');
      const emailBody = encodeURIComponent(
        "Hey,\n\nIf you ever need roof work, the guys who did mine were great — " + companyName + ". Sharing my referral link below:\n\n" + referLink + "\n\nNo pressure, just thought I'd pass it along."
      );
      parts.push(
        '<div class="card" id="rf-card">' +
          '<div class="card-label">📨 Refer a friend</div>' +
          '<div class="card-title">Know someone with a beat-up roof?</div>' +
          '<p style="color:var(--muted);margin:0 0 14px;font-size:13px;line-height:1.5;">Send your neighbor our way — they get a no-pressure roof check, you get our thanks.</p>' +
          (statPill ? '<div style="margin-bottom:14px;">' + statPill + '</div>' : '') +
          '<div style="display:flex;gap:8px;margin-bottom:10px;">' +
            '<input id="rf-link" type="text" readonly value="' + esc(referLink) + '" style="flex:1;padding:10px;border-radius:6px;border:1px solid var(--br, #2a3344);background:var(--bg, #0a1424);color:inherit;font:inherit;font-size:12px;">' +
            '<button id="rf-copy" type="button" style="padding:0 14px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:var(--surface-2,#13243d);color:var(--text);border:1px solid var(--br, #2a3344);border-radius:6px;cursor:pointer;white-space:nowrap;">Copy</button>' +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
            '<a href="sms:?&body=' + smsBody + '" style="flex:1;min-width:120px;text-align:center;padding:10px;background:var(--accent, #A14A22);color:#fff;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.04em;">💬 Text it</a>' +
            '<a href="mailto:?subject=' + emailSubject + '&body=' + emailBody + '" style="flex:1;min-width:120px;text-align:center;padding:10px;background:var(--surface-2,#13243d);color:var(--text);border:1px solid var(--br, #2a3344);border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:.04em;">✉️ Email it</a>' +
          '</div>' +
          '<div id="rf-status" style="display:none;margin-top:10px;padding:8px 10px;border-radius:6px;font-size:12px;background:rgba(46,204,138,.12);color:var(--nbd-success);border:1px solid rgba(46,204,138,.4);text-align:center;"></div>' +
        '</div>'
      );
    }

    // ── Expiry note ──
    if (view.tokenInfo && view.tokenInfo.daysRemaining != null) {
      const d = view.tokenInfo.daysRemaining;
      parts.push(
        '<div style="font-size:11px;color:var(--muted);text-align:center;padding:10px;">' +
        'This link is active for ' + d + ' more day' + (d === 1 ? '' : 's') + '.' +
        '</div>'
      );
    }

    document.getElementById('mainWrap').innerHTML = parts.join('');

    // A poll-driven re-render replaces #pm-thread, but the messaging poll
    // interval closed over the OLD (now-detached) node — rep replies would
    // append into an orphan and never show. Kill the stale interval so
    // wireMessagingCard() below rebinds it to the fresh node (QA finding).
    if (_pmPollHandle) { clearInterval(_pmPollHandle); _pmPollHandle = null; }

    // Wave 118: wire up the customer photo upload card.
    wireUploadCard();
    // Wave 119: wire up the callback request card.
    wireCallbackCard();
    // 2026-09-15 (Warranty Claim lane): wire up the warranty claim form
    // (no-op if not rendered — hidden entirely without a warranty cert, and
    // replaced with a status line instead of a form once a claim is open).
    wireWarrantyClaimCard();
    // Wave 121: wire up the rating card (no-op if not rendered).
    wireRatingCard(view);
    // Wave 123: wire up the messaging thread + compose.
    wireMessagingCard();
    // D-2.7: hydrate each before/after slot with the slider widget.
    wireBeforeAfterSliders(view);
    // Step 16: wire the Refer-a-friend Copy button (no-op when card
    // wasn't rendered, e.g. lead missing customerId).
    wireReferralCard();
    // Phase 5 (Output Engine): wire phase tabs + location chips that
    // filter the photo gallery client-side.
    wirePhotoFilters();
    // Audit batch 7 gap fix: wire the signed-contract download link to
    // emit document_view (no-op if the card wasn't rendered).
    wireDocumentLinks(view);
    // 2026-09-16: wire the Documents shelf's "View" buttons (no-op if the
    // card wasn't rendered, or every row had a direct download url instead).
    wirePortalDocumentsCard();
  }

  // ─── D-2.7: Before & After ────────────────────────────────────
  function wireBeforeAfterSliders(view) {
    if (!Array.isArray(view.photoPairs) || view.photoPairs.length === 0) return;
    if (!window.NBDBeforeAfter || typeof window.NBDBeforeAfter.render !== 'function') {
      // Script hasn't loaded yet — retry on next tick. The script tag
      // is `defer` so DOMContentLoaded normally runs first, but if the
      // view fetched faster than expected this guard catches the race.
      setTimeout(() => wireBeforeAfterSliders(view), 200);
      return;
    }
    document.querySelectorAll('#ba-card .ba-slot').forEach((slot) => {
      const i = parseInt(slot.dataset.i, 10);
      const pair = view.photoPairs[i];
      if (!pair) return;
      const beforeUrl = (pair.before && (pair.before.urls && (pair.before.urls.med || pair.before.urls.full)) || (pair.before && pair.before.url)) || null;
      const afterUrl  = (pair.after  && (pair.after.urls  && (pair.after.urls.med  || pair.after.urls.full))  || (pair.after  && pair.after.url))  || null;
      if (!beforeUrl || !afterUrl) return;
      window.NBDBeforeAfter.render(slot, {
        before:   { url: beforeUrl },
        after:    { url: afterUrl },
        location: pair.location || '',
        idx: i,
      });
    });
  }

  // ─── Step 16: Refer a friend ─────────────────────────────────
  function wireReferralCard() {
    const linkEl = document.getElementById('rf-link');
    const copyBtn = document.getElementById('rf-copy');
    const statusEl = document.getElementById('rf-status');
    if (!linkEl || !copyBtn) return;
    copyBtn.addEventListener('click', async () => {
      const val = linkEl.value;
      let ok = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(val);
          ok = true;
        } else {
          // Fallback for iOS standalone PWAs / older Safari that don't
          // expose navigator.clipboard outside HTTPS contexts.
          linkEl.select();
          document.execCommand('copy');
          ok = true;
        }
      } catch (_) { /* swallow — status path handles failure */ }
      if (statusEl) {
        statusEl.textContent = ok ? '✓ Link copied — paste it anywhere' : 'Copy failed — long-press the link to copy manually.';
        statusEl.style.display = 'block';
        statusEl.style.background = ok ? 'rgba(46,204,138,.12)' : 'rgba(220,38,38,.12)';
        statusEl.style.color = ok ? 'var(--nbd-success)' : 'var(--nbd-danger)';
        statusEl.style.borderColor = ok ? 'rgba(46,204,138,.4)' : 'rgba(220,38,38,.4)';
        clearTimeout(wireReferralCard._t);
        wireReferralCard._t = setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
      }
    });
  }

  // ─── Audit batch 7 gap fix: signed-contract download → document_view ──
  // The homeowner's one document-viewing action in the portal (clicking
  // "Download Signed Contract") left zero trace in customerAuditEvents even
  // though 'document_view' is a declared ALLOWED_TYPE and the rep-facing
  // activity timeline renders an icon/label for it — the coverage the UI
  // implied never existed. Click handler mirrors the photo_view pattern:
  // fire-and-forget, never blocks the navigation/download itself.
  function wireDocumentLinks(view) {
    const link = document.getElementById('signedContractLink');
    if (!link) return;
    const estId = (view && view.estimate && view.estimate.id) || null;
    link.addEventListener('click', function () {
      _emitAuditEvent('document_view', estId);
    });
  }

  // ─── 2026-09-16: Documents shelf — sandboxed viewer ────────────
  // A generated document (contract/estimate/invoice/etc) has no direct URL
  // to link to — functions/document-view.js's header explains why a signed
  // Storage URL is wrong for HTML specifically (it would execute same-origin
  // as storage.googleapis.com, unlike the plain-link rows above, which are
  // PDFs/images). The rep-facing equivalent (NBDDocViewer, docs/pro/js/
  // nbd-doc-viewer.js) solves this with a sandboxed srcdoc iframe; this
  // mirrors its exact sandbox token list (see that file's "H-2" comment —
  // 'allow-same-origin' is deliberately ABSENT so the iframe gets an opaque
  // origin: allow-scripts still lets the document's own print button etc.
  // work, but an opaque-origin frame cannot read this page's DOM, storage,
  // or make same-origin-credentialed requests, even with scripting on).
  // 2026-09-16 (a11y fix): this modal originally had no aria-modal, no
  // role, and no focus trap at all — a real modal dialog with none of the
  // accessible-modal semantics or keyboard containment customer.html's
  // OLDER modals at least (incompletely) advertise. Since this is new code
  // with no back-compat concern, it gets the full treatment: role="dialog"
  // + aria-modal on the dialog box itself (not the backdrop), focus moved
  // in on open and restored to whatever triggered it on close, and a real
  // Tab-key trap so keyboard/screen-reader focus can't leak to the page
  // behind the backdrop.
  let _docModal = null;
  let _docModalTrapHandler = null;
  let _docModalTriggerEl = null;
  function _openDocModal(name) {
    _docModalTriggerEl = document.activeElement;
    if (!_docModal) {
      const overlay = document.createElement('div');
      overlay.className = 'doc-modal-overlay';
      overlay.innerHTML =
        '<div class="doc-modal" role="dialog" aria-modal="true" aria-labelledby="docModalTitle">' +
          '<div class="doc-modal-header">' +
            '<div class="doc-modal-title" id="docModalTitle"></div>' +
            '<button type="button" class="doc-modal-close" aria-label="Close">✕</button>' +
          '</div>' +
          '<div class="doc-modal-body">' +
            '<div class="doc-modal-status">Loading…</div>' +
            '<iframe class="doc-modal-iframe" tabindex="-1" sandbox="allow-popups allow-popups-to-escape-sandbox allow-forms allow-scripts allow-modals" title="Document"></iframe>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      const close = () => {
        overlay.classList.remove('open');
        overlay.querySelector('.doc-modal-iframe').srcdoc = '';
        if (_docModalTrapHandler) { document.removeEventListener('keydown', _docModalTrapHandler); _docModalTrapHandler = null; }
        if (_docModalTriggerEl && typeof _docModalTriggerEl.focus === 'function') _docModalTriggerEl.focus();
      };
      overlay.querySelector('.doc-modal-close').addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      overlay._nbdClose = close;
      _docModal = overlay;
    }
    // Wired on every OPEN (not just the first build) — close() removes it,
    // and the modal DOM is reused across opens, so a listener added only
    // once at build time would silently stop working after the first close.
    const dialog = _docModal.querySelector('.doc-modal');
    // The iframe is deliberately tabindex="-1" (excluded here by
    // :not([tabindex="-1"])) — NOT an oversight. Once keyboard focus moves
    // INSIDE a sandboxed cross-origin iframe (no allow-same-origin, by
    // design — see the sandbox comment above), its keydown events fire in
    // THAT document, not this one; a parent-level listener structurally
    // cannot observe them, so Tab pressed while focus is inside the iframe
    // can never reach this handler to be trapped. Granting the sandbox
    // allow-same-origin to fix that would defeat the entire reason it's
    // sandboxed in the first place. So the close button is the only
    // element this trap manages — a provably-correct trap around one
    // element beats an attempted trap that silently leaks focus to the
    // page behind the backdrop the moment a user tabs into the iframe.
    // offsetParent is null for display:none elements (among other cases) —
    // still needed for anything ever added here in future, though today
    // the only match is the always-visible close button.
    const focusable = () => Array.from(dialog.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter((el) => el.offsetParent !== null);
    _docModalTrapHandler = (e) => {
      if (e.key === 'Escape') { _docModal._nbdClose(); return; }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      e.preventDefault();
      const idx = items.indexOf(document.activeElement);
      const next = e.shiftKey
        ? items[idx <= 0 ? items.length - 1 : idx - 1]
        : items[idx === -1 || idx === items.length - 1 ? 0 : idx + 1];
      next.focus();
    };
    document.addEventListener('keydown', _docModalTrapHandler);

    _docModal.querySelector('.doc-modal-title').textContent = name || 'Document';
    _docModal.querySelector('.doc-modal-status').style.display = 'block';
    _docModal.querySelector('.doc-modal-status').textContent = 'Loading…';
    _docModal.querySelector('.doc-modal-iframe').style.display = 'none';
    _docModal.classList.add('open');
    // Move focus into the dialog so screen readers announce it and Tab
    // starts contained — the close button, not the iframe (which has no
    // content yet while the fetch below is in flight).
    _docModal.querySelector('.doc-modal-close').focus();
    return _docModal;
  }

  // Phone audit (2026-09-25), the sibling of estimate-view.js errorStateFor:
  // getPortalDocumentHtml's error strings are written for logs ("Not
  // shared", "Document path is not readable", "Invalid token") and the
  // viewer showed them to the homeowner verbatim. Keyed on status instead;
  // the network-failure line in the catch below was already homeowner copy.
  function _docErrorCopy(status) {
    if (status === 400) return 'This link looks incomplete. Ask your rep to send it again.';
    if (status === 403 || status === 404) return 'This document isn’t available here anymore. Ask your rep to share it again.';
    if (status === 410) return 'This link has expired. Ask your rep for a new one.';
    if (status === 413) return 'This document is too large to open here. Ask your rep for a copy.';
    if (status === 429) return 'Too many requests right now. Give it a minute and try again.';
    return 'Could not open this document. Try again in a moment — if it keeps happening, contact your rep.';
  }

  function wirePortalDocumentsCard() {
    const list = document.querySelector('.doc-list');
    if (!list) return;
    list.addEventListener('click', async function (e) {
      const btn = e.target.closest('.portal-doc-view');
      if (!btn) return;
      const docId = btn.dataset.docId;
      if (!docId) return;
      const token = getToken().trim();
      const modal = _openDocModal(btn.closest('.doc-row')?.querySelector('.doc-name')?.textContent);
      try {
        const res = await fetch(FUNCTIONS_BASE + '/getPortalDocumentHtml', {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, docId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || typeof data.html !== 'string') {
          modal.querySelector('.doc-modal-status').textContent = _docErrorCopy(res.ok ? 0 : res.status);
          return;
        }
        const iframe = modal.querySelector('.doc-modal-iframe');
        // Phone audit homeowner#2 (2026-09-25): a generated contract showed
        // here at print size — 9px clause text in a 245px column on a 412px
        // phone (193px at 360; the modal's own 16px margin took 32px more,
        // see portal.html). doc-phone-layout.js (shared with sign.html and
        // the rep's doc viewer) adds a screen-only phone sheet to the copy
        // SHOWN; this viewer only displays, so nothing is ever read back to
        // strip. Read at call time: absent, the document shows as served.
        const phone = window.NBDDocPhoneLayout;
        iframe.srcdoc = phone ? phone.withPhoneLayout(data.html) : data.html;
        modal.querySelector('.doc-modal-status').style.display = 'none';
        iframe.style.display = 'block';
        _emitAuditEvent('document_view', docId);
      } catch (err) {
        modal.querySelector('.doc-modal-status').textContent = 'Could not load this document — check your connection and try again.';
      }
    });
  }

  // ─── Phase 5: portal photo gallery filtering ──────────────────
  // Filters the already-rendered photo grid in place. No round-trip;
  // the homeowner sees the new selection within a frame.
  function wirePhotoFilters() {
    const grid = document.getElementById('portalPhotoGrid');
    if (!grid || !Array.isArray(window._portalPhotos)) return;

    // Tile factory mirrors the original sorted-photo render so the
    // grid looks identical after a filter as it did at first paint.
    function tileHtml(p) {
      // NOTE: photo src/href are server-origin Storage https URLs (and an
      // <img src> can't execute script), so they keep plain esc() — the
      // safeUrl scheme guard is applied to the click-anchors that matter
      // (signed-contract download + booking link) above.
      const u = (p.urls && p.urls.med) ? esc(p.urls.med) : esc(p.url || '');
      const srcset = (p.urls && p.urls.thumb && p.urls.med && p.urls.full)
        ? ' srcset="' + esc(p.urls.thumb) + ' 200w, ' + esc(p.urls.med) + ' 600w, ' + esc(p.urls.full) + ' 1600w" sizes="(max-width:520px) 30vw, 160px"'
        : '';
      const fullHref = (p.urls && p.urls.full) ? esc(p.urls.full) : u;
      // Audit batch 7: data-photo-id powers the photo_view event emission
      // via the delegated grid click handler below. Server validates token
      // → leadId binding, so a tampered photoId can't leak across leads.
      return '<a class="ph-tile" href="' + fullHref + '" target="_blank" rel="noopener" data-photo-id="' + esc(p.id || '') + '" aria-label="' + esc(p.caption || p.phase || 'Project photo') + '">' +
               '<img loading="lazy" decoding="async" src="' + u + '"' + srcset + ' alt="' + esc(p.caption || p.phase || '') + '">' +
             '</a>';
    }

    // Audit batch 7: delegated click handler emits photo_view events.
    // Single listener vs one per tile = cheaper + survives re-renders
    // from phase/location filter changes without re-binding.
    grid.addEventListener('click', function (e) {
      const tile = e.target.closest('.ph-tile');
      if (!tile) return;
      const photoId = tile.dataset.photoId;
      if (photoId) _emitAuditEvent('photo_view', photoId);
    });

    function renderFiltered() {
      const f = window._portalPhotoFilter || { phase: 'all' };
      const filtered = window._portalPhotos.filter(function (p) {
        if (f.phase !== 'all' && p.phase !== f.phase) return false;
        return true;
      });
      const empty = document.getElementById('portalPhotoEmpty');
      if (filtered.length === 0) {
        grid.innerHTML = '';
        if (empty) empty.style.display = 'block';
      } else {
        grid.innerHTML = filtered.map(tileHtml).join('');
        if (empty) empty.style.display = 'none';
      }
    }
    // Initial render — show all photos before any filter is tapped.
    renderFiltered();

    const tabs = document.getElementById('portalPhaseTabs');
    if (tabs) {
      tabs.addEventListener('click', function (e) {
        const btn = e.target.closest('.ph-tab');
        if (!btn) return;
        Array.from(tabs.querySelectorAll('.ph-tab')).forEach(function (b) {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
        window._portalPhotoFilter.phase = btn.dataset.phase || 'all';
        renderFiltered();
      });
    }
  }

  // ─── Wave 123 + Step 14 polish: Async messaging ────────────────
  // Loads the thread on mount, polls every 30s while visible, and
  // posts new messages via sendPortalMessage. The poll handle is
  // tracked so we can clear it on pagehide / visibilitychange.
  //
  // Step 14 adds:
  //   - Enter-to-send (Shift+Enter for newline)
  //   - Live char counter that warns when near the 2000-char ceiling
  //   - Optimistic local bubble (instant feedback + retry on failure)
  //   - Read receipt (✓ Delivered / ✓✓ Read) on outgoing bubbles
  //   - Timestamp grouping — only show time at the start of a new
  //     "burst" (>5 min gap from previous message)
  let _pmPollHandle = null;
  let _pmLastFetch = 0;
  let _pmVisWired = false; // visibilitychange listener registered once, not per re-render
  // Locally-tracked outgoing messages waiting for the server roundtrip
  // to surface them in the next fetched thread. Keyed by client-side
  // pending id; cleared once the server message with matching text
  // shows up in the polled response.
  const _pmPending = new Map();
  function wireMessagingCard() {
    const threadEl = document.getElementById('pm-thread');
    const emptyEl = document.getElementById('pm-empty');
    const textEl = document.getElementById('pm-text');
    const sendBtn = document.getElementById('pm-send');
    const statusEl = document.getElementById('pm-status');
    const counterEl = document.getElementById('pm-counter');
    if (!threadEl || !textEl || !sendBtn) return;

    // ── Char counter — warns at 80% capacity, errors past max ───
    const MAX_CHARS = 2000;
    const WARN_AT = 1700;
    function updateCounter() {
      if (!counterEl) return;
      const n = textEl.value.length;
      counterEl.textContent = n + ' / ' + MAX_CHARS;
      counterEl.style.color = n >= WARN_AT
        ? (n >= MAX_CHARS ? 'var(--nbd-danger)' : 'var(--nbd-warn)')
        : 'var(--muted, #888)';
    }

    function escMsg(s) {
      return String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
    function fmtTime(ms) {
      if (!ms) return '';
      const d = new Date(ms);
      const now = new Date();
      const sameDay = d.toDateString() === now.toDateString();
      const opts = sameDay
        ? { hour: 'numeric', minute: '2-digit' }
        : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
      return d.toLocaleString(undefined, opts);
    }
    function setStatus(msg, kind) {
      if (!statusEl) return;
      if (!msg) { statusEl.style.display = 'none'; return; }
      statusEl.style.display = 'block';
      statusEl.textContent = msg;
      statusEl.style.background = kind === 'error' ? 'rgba(239,68,68,0.12)' : 'var(--nbd-bg-tint)';
      statusEl.style.color = kind === 'error' ? 'var(--nbd-danger)' : 'var(--muted, #888)';
      statusEl.style.border = kind === 'error' ? '1px solid rgba(239,68,68,0.45)' : '1px solid var(--br, #2a3344)';
    }

    // Toggle the "Sending…" → "Sent" → "Read" indicator on outgoing
    // bubbles. WhatsApp-style: ✓ delivered (server ack), ✓✓ read
    // (rep marked the thread read). Falls back to the original
    // timestamp line when the message hasn't reached either state.
    function bubbleStatusLine(m, isYou) {
      const time = escMsg(fmtTime(m.createdAt || (m._pending ? Date.now() : 0)));
      if (!isYou) return time;
      if (m._pending && !m._failed) return '<span style="opacity:.7;">Sending…</span>';
      if (m._failed)                 return '<span style="color:var(--nbd-danger);">Tap to retry</span>';
      const readMark = m.readByRecipient
        ? '<span style="color:#fff;letter-spacing:-3px;">✓✓</span>'
        : '<span style="opacity:.7;">✓</span>';
      return time + ' · ' + readMark;
    }

    // Step 14: only emit a timestamp / header line at the start of
    // a new "burst" (defined as >5 min from the previous message).
    // Keeps the thread visually quieter for rapid back-and-forth.
    const BURST_GAP_MS = 5 * 60_000;
    function shouldShowTime(prev, cur) {
      if (!prev) return true;
      const pMs = prev.createdAt || (prev._pending ? prev._localMs : 0);
      const cMs = cur.createdAt  || (cur._pending  ? cur._localMs  : 0);
      if (!pMs || !cMs) return true;
      if (prev.source !== cur.source) return true;
      return (cMs - pMs) > BURST_GAP_MS;
    }

    function renderThread(messages) {
      // Merge in any pending optimistic messages. We dedup by text +
      // source: if the server already returned a homeowner message
      // matching the pending text, the pending entry gets dropped.
      const serverMsgs = Array.isArray(messages) ? messages.slice() : [];
      const pendingArr = Array.from(_pmPending.values());
      pendingArr.forEach(p => {
        const matched = serverMsgs.find(s =>
          s.source === 'homeowner' && s.text === p.text);
        if (matched) {
          _pmPending.delete(p._pendingId);
        }
      });
      const merged = serverMsgs.concat(
        Array.from(_pmPending.values())
          // Stable-sort by createdAt; pending entries use _localMs.
          .sort((a, b) => (a._localMs || 0) - (b._localMs || 0))
      );

      if (merged.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        Array.from(threadEl.querySelectorAll('.pm-bubble, .pm-empty-spacer')).forEach(n => n.remove());
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';
      Array.from(threadEl.querySelectorAll('.pm-bubble, .pm-empty-spacer')).forEach(n => n.remove());
      const accent = 'var(--accent, #A14A22)';
      let prev = null;
      merged.forEach(m => {
        const bubble = document.createElement('div');
        bubble.className = 'pm-bubble';
        const isYou = m.source === 'homeowner';
        const dim = m._pending && !m._failed ? '0.65' : '1';
        bubble.style.cssText =
          'max-width:80%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.4;' +
          'word-wrap:break-word;align-self:' + (isYou ? 'flex-end' : 'flex-start') + ';' +
          'background:' + (isYou ? accent : 'var(--nbd-bg-tint)') + ';' +
          'color:' + (isYou ? '#fff' : 'inherit') + ';' +
          'opacity:' + dim + ';' +
          'border-bottom-' + (isYou ? 'right' : 'left') + '-radius:4px;';

        const showTime = shouldShowTime(prev, m);
        const statusLine = showTime
          ? '<div style="font-size:10px;opacity:0.7;margin-top:4px;text-align:' + (isYou ? 'right' : 'left') + ';">' +
              (isYou ? 'You' : esc(repName.split(' ')[0])) + ' · ' + bubbleStatusLine(m, isYou) +
            '</div>'
          : '';

        bubble.innerHTML = '<div>' + escMsg(m.text) + '</div>' + statusLine;

        // Failed-bubble click handler — retry the send.
        if (m._failed && m._pendingId) {
          bubble.style.cursor = 'pointer';
          bubble.title = 'Tap to retry';
          bubble.addEventListener('click', () => retryPending(m._pendingId));
        }

        threadEl.appendChild(bubble);
        prev = m;
      });
      // Auto-scroll to the latest message.
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    async function fetchMessages() {
      _pmLastFetch = Date.now();
      try {
        const res = await fetch(FUNCTIONS_BASE + '/getPortalMessages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN }),
        });
        if (!res.ok) {
          // Silent fail on poll — don't spam status messages.
          if (res.status === 410 || res.status === 404) {
            setStatus('Conversation link no longer valid.', 'error');
          }
          return;
        }
        const json = await res.json().catch(() => ({}));
        renderThread(json.messages || []);
      } catch (_) {
        // Network blip on poll — silent.
      }
    }

    // Initial fetch.
    fetchMessages();
    // Poll every 30s while page is visible. Pause on hide.
    function startPoll() {
      if (_pmPollHandle) return;
      _pmPollHandle = setInterval(() => {
        if (document.hidden) return;
        if (Date.now() - _pmLastFetch < 25_000) return;
        fetchMessages();
      }, 30_000);
    }
    function stopPoll() {
      if (_pmPollHandle) {
        clearInterval(_pmPollHandle);
        _pmPollHandle = null;
      }
    }
    startPoll();
    // Refresh on tab refocus — register ONCE (wireMessagingCard re-runs on every
    // poll-driven re-render; without this guard the listener leaks each time).
    if (!_pmVisWired) {
      _pmVisWired = true;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && Date.now() - _pmLastFetch > 10_000) {
          fetchMessages();
        }
      });
    }
    // Cleanup on pagehide so the poll doesn't run for a navigated-away tab.
    window.addEventListener('pagehide', stopPoll, { once: true });

    // Compose: enable Send only when there's content.
    // Step 14: also drive the live char counter from the same handler.
    textEl.addEventListener('input', () => {
      const has = textEl.value.trim().length > 0;
      sendBtn.disabled = !has;
      sendBtn.style.opacity = has ? '1' : '0.55';
      updateCounter();
    });

    // Step 14: Enter-to-send (Shift+Enter inserts a newline). Matches
    // the convention every messaging app on the planet uses; the help
    // text is in the textarea placeholder.
    textEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        if (!sendBtn.disabled) sendBtn.click();
      }
    });

    // Core send path — extracted so the retry-failed-bubble flow can
    // reuse it. The optimistic local bubble appears immediately; the
    // server roundtrip either confirms it (next fetch matches by text)
    // or marks it failed so the rep can tap to retry without retyping.
    async function doSend(text, pendingId) {
      try {
        const res = await fetch(FUNCTIONS_BASE + '/sendPortalMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN, text }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          // Per-token daily quota / expired / 4xx — surface the server
          // message and mark the bubble failed.
          const p = _pmPending.get(pendingId);
          if (p) { p._failed = true; p._pending = false; renderThread(_lastMessages); }
          setStatus(json.error || 'Could not send. Try again.', 'error');
          return false;
        }
        // Success — leave the pending bubble in place until the next
        // poll surfaces the server message and the dedup logic drops it.
        await fetchMessages();
        setStatus('');
        return true;
      } catch (err) {
        const p = _pmPending.get(pendingId);
        if (p) { p._failed = true; p._pending = false; renderThread(_lastMessages); }
        setStatus('Network error — tap your message to retry.', 'error');
        return false;
      }
    }

    function retryPending(pendingId) {
      const p = _pmPending.get(pendingId);
      if (!p) return;
      p._failed = false;
      p._pending = true;
      p._localMs = Date.now();
      renderThread(_lastMessages);
      doSend(p.text, pendingId);
    }

    // Tracks the most recent server-side message list so optimistic
    // renders can re-merge against it on retry / failure-state flips.
    let _lastMessages = [];
    const origRenderThread = renderThread;
    renderThread = function(messages) {
      if (Array.isArray(messages)) _lastMessages = messages;
      else messages = _lastMessages;
      origRenderThread(messages);
    };

    sendBtn.addEventListener('click', async () => {
      const text = textEl.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      setStatus('');

      // Optimistic bubble — render immediately so the homeowner sees
      // their message in-thread before the network call resolves.
      const pendingId = 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      _pmPending.set(pendingId, {
        _pendingId: pendingId,
        _pending: true,
        _failed: false,
        _localMs: Date.now(),
        source: 'homeowner',
        text,
        readByRecipient: false
      });
      textEl.value = '';
      updateCounter();
      renderThread(_lastMessages);

      const ok = await doSend(text, pendingId);
      // Reset compose state regardless — failures keep the pending
      // bubble visible (with retry affordance) so the rep doesn't lose
      // their work.
      sendBtn.textContent = 'Send';
      sendBtn.disabled = false;
      sendBtn.style.opacity = '0.55';
    });

    // Drive the counter once on mount so the "0 / 2000" reflects any
    // pre-filled textarea state (e.g., browser autofill restoring a
    // previous draft).
    updateCounter();
  }

  // ─── Wave 121: Customer rating ─────────────────────────────────
  // 1-5 star pick → optional comment → submit → conditional follow-up
  // (Google review nudge for 4-5★, "rep will reach out" for 1-3★).
  function wireRatingCard(view) {
    const starsWrap = document.getElementById('cr-stars');
    const sendBtn = document.getElementById('cr-send');
    const commentEl = document.getElementById('cr-comment');
    const statusEl = document.getElementById('cr-status');
    const thanksEl = document.getElementById('cr-thanks');
    if (!starsWrap || !sendBtn) return; // card wasn't rendered

    let chosenStars = 0;

    function paintStars(filled) {
      Array.from(starsWrap.querySelectorAll('.cr-star')).forEach(b => {
        const n = Number(b.dataset.stars) || 0;
        const isFilled = n <= filled;
        b.textContent = isFilled ? '★' : '☆';
        b.style.color = isFilled ? 'var(--nbd-warn)' : '#888';
        b.style.borderColor = isFilled ? 'var(--nbd-warn)' : 'var(--br, #2a3344)';
        b.style.background = isFilled ? 'rgba(251,191,36,0.08)' : 'var(--bg, #0a1424)';
      });
    }

    Array.from(starsWrap.querySelectorAll('.cr-star')).forEach(b => {
      b.addEventListener('click', () => {
        chosenStars = Number(b.dataset.stars) || 0;
        paintStars(chosenStars);
        // Reveal comment + submit on first pick.
        if (commentEl) commentEl.style.display = 'block';
        sendBtn.style.display = 'block';
        sendBtn.disabled = false;
        sendBtn.style.opacity = '1';
        sendBtn.textContent = chosenStars >= 4 ? 'Send my rating' : 'Send feedback';
      });
      // Hover-preview for desktop.
      b.addEventListener('mouseenter', () => {
        if (chosenStars > 0) return;
        paintStars(Number(b.dataset.stars) || 0);
      });
      b.addEventListener('mouseleave', () => {
        if (chosenStars > 0) paintStars(chosenStars);
        else paintStars(0);
      });
    });

    function setStatus(msg, kind) {
      if (!statusEl) return;
      statusEl.style.display = 'block';
      statusEl.textContent = msg;
      if (kind === 'error') {
        statusEl.style.background = 'rgba(239,68,68,0.12)';
        statusEl.style.color = 'var(--nbd-danger)';
        statusEl.style.border = '1px solid rgba(239,68,68,0.45)';
      } else {
        statusEl.style.background = 'var(--nbd-bg-tint)';
        statusEl.style.color = 'var(--muted, #888)';
        statusEl.style.border = '1px solid var(--br, #2a3344)';
      }
    }

    sendBtn.addEventListener('click', async () => {
      if (chosenStars < 1 || chosenStars > 5) {
        setStatus('Pick a star rating first.', 'error');
        return;
      }
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      try {
        const res = await fetch(FUNCTIONS_BASE + '/submitCustomerRating', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: TOKEN,
            stars: chosenStars,
            comment: commentEl ? commentEl.value : '',
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatus(json.error || 'Could not save rating. Try again.', 'error');
          sendBtn.disabled = false;
          sendBtn.textContent = chosenStars >= 4 ? 'Send my rating' : 'Send feedback';
          return;
        }

        // Hide the rater controls; show the thank-you tier copy.
        Array.from(starsWrap.querySelectorAll('.cr-star')).forEach(b => {
          b.disabled = true; b.style.cursor = 'default';
        });
        if (commentEl) commentEl.disabled = true;
        sendBtn.style.display = 'none';
        if (statusEl) statusEl.style.display = 'none';

        if (thanksEl) {
          thanksEl.style.display = 'block';
          if (json.tier === 'high') {
            // 4-5 stars → nudge to Google review.
            // W134 defense-in-depth: validate URL scheme on the client too.
            // Server-side `submitCustomerRating` already enforces https?://,
            // but a defensive check here means any future server bug or
            // direct-invocation can't pivot to a `javascript:` href.
            const _rawUrl = json.googleReviewUrl;
            const reviewUrl = (typeof _rawUrl === 'string'
              && /^https?:\/\//i.test(_rawUrl.trim())) ? _rawUrl.trim() : null;
            thanksEl.innerHTML =
              '<div style="font-size:15px;font-weight:600;color:var(--nbd-success);margin-bottom:8px;">🎉 Thank you!</div>' +
              '<div style="color:var(--muted);font-size:13px;line-height:1.5;margin-bottom:' + (reviewUrl ? '12px' : '0') + ';">' +
              'It means the world that we earned ' + chosenStars + ' stars. ' +
              (reviewUrl ? 'A public Google review helps other homeowners find us — tap below if you have a sec.' : '&mdash; ' + esc(repName.split(' ')[0]) + ' will be in touch.') +
              '</div>' +
              (reviewUrl
                ? '<a href="' + esc(reviewUrl) + '" target="_blank" rel="noopener" class="btn" style="display:block;text-align:center;padding:12px;font-size:14px;background:var(--accent, #A14A22);color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">⭐ Leave a Google review</a>'
                : '');
          } else {
            // 1-3 stars → recovery message.
            thanksEl.style.background = 'rgba(251,191,36,0.08)';
            thanksEl.style.borderColor = 'rgba(251,191,36,0.45)';
            thanksEl.innerHTML =
              '<div style="font-size:15px;font-weight:600;color:#fbbf24;margin-bottom:8px;">Thank you for the honest feedback.</div>' +
              '<div style="color:var(--muted);font-size:13px;line-height:1.5;">' +
              'We take this seriously. ' + esc(repName.split(' ')[0]) + ' will reach out within 24 hours to make this right.' +
              '</div>';
          }
        }
      } catch (err) {
        setStatus('Network error: ' + (err.message || 'try again'), 'error');
        sendBtn.disabled = false;
        sendBtn.textContent = chosenStars >= 4 ? 'Send my rating' : 'Send feedback';
      }
    });
  }

  // ─── Wave 119: Request a callback ─────────────────────────────────
  // Time-slot picker → POST to requestCallback Cloud Function with
  // the portal token. Server creates a task on the lead so the rep
  // sees it in their bell + customer page activity log.
  function wireCallbackCard() {
    const slotsWrap = document.getElementById('cb-slots');
    const sendBtn = document.getElementById('cb-send');
    const noteEl = document.getElementById('cb-note');
    const statusEl = document.getElementById('cb-status');
    if (!slotsWrap || !sendBtn) return;

    let chosenSlot = null;

    // Style the slot chips inline so we don't need a separate CSS bundle.
    Array.from(slotsWrap.querySelectorAll('.cb-slot')).forEach(b => {
      b.style.cssText =
        'padding:9px 14px;border-radius:999px;border:1px solid var(--br, #2a3344);' +
        'background:var(--bg, #0a1424);color:inherit;font:inherit;font-size:13px;' +
        'cursor:pointer;-webkit-tap-highlight-color:transparent;transition:all 120ms ease;';
      b.addEventListener('click', () => selectSlot(b));
    });

    function selectSlot(btn) {
      chosenSlot = btn.dataset.slot || null;
      Array.from(slotsWrap.querySelectorAll('.cb-slot')).forEach(b => {
        const isActive = b === btn;
        b.style.background = isActive ? 'var(--accent, #A14A22)' : 'var(--bg, #0a1424)';
        b.style.borderColor = isActive ? 'var(--accent, #A14A22)' : 'var(--br, #2a3344)';
        b.style.color = isActive ? '#fff' : 'inherit';
      });
      sendBtn.disabled = false;
      sendBtn.style.opacity = '1';
      sendBtn.textContent = 'Send callback request';
    }

    function setStatus(msg, kind) {
      if (!statusEl) return;
      statusEl.style.display = 'block';
      statusEl.textContent = msg;
      if (kind === 'error') {
        statusEl.style.background = 'rgba(239,68,68,0.12)';
        statusEl.style.color = 'var(--nbd-danger)';
        statusEl.style.border = '1px solid rgba(239,68,68,0.45)';
      } else if (kind === 'success') {
        statusEl.style.background = 'rgba(46,204,138,0.12)';
        statusEl.style.color = 'var(--nbd-success)';
        statusEl.style.border = '1px solid rgba(46,204,138,0.45)';
      } else {
        statusEl.style.background = 'var(--nbd-bg-tint)';
        statusEl.style.color = 'var(--muted, #888)';
        statusEl.style.border = '1px solid var(--br, #2a3344)';
      }
    }

    sendBtn.addEventListener('click', async () => {
      if (!chosenSlot) {
        setStatus('Pick a time first.', 'error');
        return;
      }
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      try {
        const res = await fetch(FUNCTIONS_BASE + '/requestCallback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: TOKEN,
            slot: chosenSlot,
            note: noteEl ? noteEl.value : '',
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatus(json.error || 'Could not send request. Try again.', 'error');
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send callback request';
          return;
        }
        setStatus('✓ Got it! ' + esc(repName) + ' will reach out.', 'success');
        // Lock the form so they don't double-send.
        Array.from(slotsWrap.querySelectorAll('.cb-slot')).forEach(b => {
          b.disabled = true; b.style.cursor = 'default'; b.style.opacity = '0.6';
        });
        if (noteEl) noteEl.disabled = true;
        sendBtn.style.display = 'none';
      } catch (err) {
        setStatus('Network error: ' + (err.message || 'try again'), 'error');
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send callback request';
      }
    });
  }

  // ─── 2026-09-15: Warranty claim report ───────────────────────────
  // Issue description → POST to reportWarrantyClaim Cloud Function with
  // the portal token. Server drops a task + activity entry on the lead —
  // see functions/portal.js's reportWarrantyClaim for why this never
  // touches lead.stage/openWarrantyClaimId directly (that's the rep's own
  // "File Warranty Claim" click, via crm-pipeline.js's moveCard() guard).
  function wireWarrantyClaimCard() {
    const issueEl = document.getElementById('wc-issue');
    const sendBtn = document.getElementById('wc-send');
    const statusEl = document.getElementById('wc-status');
    if (!issueEl || !sendBtn) return; // not rendered (no cert, or claim already open)

    function setStatus(msg, kind) {
      if (!statusEl) return;
      statusEl.style.display = 'block';
      statusEl.textContent = msg;
      if (kind === 'error') {
        statusEl.style.background = 'rgba(239,68,68,0.12)';
        statusEl.style.color = 'var(--nbd-danger)';
        statusEl.style.border = '1px solid rgba(239,68,68,0.45)';
      } else {
        statusEl.style.background = 'rgba(46,204,138,0.12)';
        statusEl.style.color = 'var(--nbd-success)';
        statusEl.style.border = '1px solid rgba(46,204,138,0.45)';
      }
    }

    sendBtn.addEventListener('click', async () => {
      const issueDescription = issueEl.value.trim();
      if (!issueDescription) {
        setStatus('Tell us what\'s going on first.', 'error');
        return;
      }
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';
      try {
        const res = await fetch(FUNCTIONS_BASE + '/reportWarrantyClaim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: TOKEN, issueDescription }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatus(json.error || 'Could not send your report. Try again.', 'error');
          sendBtn.disabled = false;
          sendBtn.textContent = '🛟 Start a warranty claim';
          return;
        }
        setStatus('✓ Got it! ' + esc(repName) + ' will follow up.', 'success');
        issueEl.disabled = true;
        sendBtn.style.display = 'none';
      } catch (err) {
        setStatus('Network error: ' + (err.message || 'try again'), 'error');
        sendBtn.disabled = false;
        sendBtn.textContent = '🛟 Start a warranty claim';
      }
    });
  }

  // ─── Wave 118: Customer photo upload ─────────────────────────────
  // File pick → resize/compress to 1600px max → base64 → POST to
  // uploadHomeownerPhoto Cloud Function with the portal token.
  // Success: show thumbnail + confirmation. Failure: friendly error.
  function wireUploadCard() {
    const pickBtn = document.getElementById('cuh-pick');
    const fileInput = document.getElementById('cuh-file');
    const preview = document.getElementById('cuh-preview');
    const status = document.getElementById('cuh-status');
    if (!pickBtn || !fileInput) return;

    pickBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      handleUpload(file);
    });

    function setStatus(msg, kind) {
      if (!status) return;
      status.style.display = 'block';
      status.textContent = msg;
      if (kind === 'error') {
        status.style.background = 'rgba(239,68,68,0.12)';
        status.style.color = 'var(--nbd-danger)';
        status.style.border = '1px solid rgba(239,68,68,0.45)';
      } else if (kind === 'success') {
        status.style.background = 'rgba(46,204,138,0.12)';
        status.style.color = 'var(--nbd-success)';
        status.style.border = '1px solid rgba(46,204,138,0.45)';
      } else {
        status.style.background = 'var(--nbd-bg-tint)';
        status.style.color = 'var(--muted, #888)';
        status.style.border = '1px solid var(--br, #2a3344)';
      }
    }

    // Resize the image client-side so we don't waste bandwidth or
    // server CPU on full-resolution iPhone photos. 1600px max edge
    // is plenty for damage assessment + keeps payloads under 1-2MB.
    function resizeImage(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function (e) {
          const img = new Image();
          img.onload = function () {
            const MAX = 1600;
            let w = img.width, h = img.height;
            if (w > MAX || h > MAX) {
              if (w >= h) { h = Math.round(h * (MAX / w)); w = MAX; }
              else        { w = Math.round(w * (MAX / h)); h = MAX; }
            }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            // JPEG q=0.85 hits the sweet spot for photos —
            // visibly clean, well under the 8MB server cap.
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            resolve(dataUrl);
          };
          img.onerror = () => reject(new Error('Could not read image'));
          img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
      });
    }

    async function handleUpload(file) {
      try {
        if (!/^image\//.test(file.type)) {
          setStatus('Please pick an image file.', 'error');
          return;
        }
        setStatus('Preparing photo…', 'info');
        const dataUrl = await resizeImage(file);

        // Show preview thumbnail.
        preview.style.display = 'block';
        preview.innerHTML =
          '<div style="display:flex;gap:12px;align-items:flex-start;">' +
            '<img src="' + dataUrl + '" alt="Photo preview" style="width:80px;height:80px;object-fit:cover;border-radius:6px;flex-shrink:0;">' +
            '<div style="flex:1;">' +
              '<input id="cuh-caption" type="text" placeholder="Optional note (e.g. \'Spot in the back\')" maxlength="280" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--br, #2a3344);background:var(--bg, #0a1424);color:inherit;font:inherit;font-size:13px;box-sizing:border-box;">' +
              '<button id="cuh-send" type="button" class="btn" style="margin-top:8px;width:100%;padding:11px;font-size:14px;background:var(--accent, #A14A22);color:#fff;border:none;border-radius:6px;cursor:pointer;">Send to your rep</button>' +
            '</div>' +
          '</div>';
        setStatus('Add an optional note, then send.', 'info');

        const sendBtn = document.getElementById('cuh-send');
        sendBtn.addEventListener('click', async () => {
          const captionEl = document.getElementById('cuh-caption');
          const caption = captionEl ? captionEl.value : '';
          sendBtn.disabled = true;
          sendBtn.textContent = 'Sending…';
          try {
            const res = await fetch(FUNCTIONS_BASE + '/uploadHomeownerPhoto', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: TOKEN, dataUrl, caption }),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
              setStatus(json.error || 'Upload failed. Try again.', 'error');
              sendBtn.disabled = false;
              sendBtn.textContent = 'Send to your rep';
              return;
            }
            setStatus(
              '✓ Photo sent to your rep.' + (typeof json.remainingToday === 'number'
                ? ' (' + json.remainingToday + ' more allowed today)' : ''),
              'success'
            );
            // Belt-and-suspenders for the photo self-announce fix above:
            // mark this photo as already-seen in local state immediately,
            // rather than depending on the next 30s poll's server payload
            // to carry source:'homeowner' before _diffView runs against it.
            // Covers a race between this success handler and the poll timer.
            if (_lastView && Array.isArray(_lastView.photos) && json.photoId) {
              _lastView = Object.assign({}, _lastView, {
                photos: _lastView.photos.concat([{ id: json.photoId, url: json.url || null, urls: null, phase: 'During', caption: caption || '', source: 'homeowner' }])
              });
            }
            // Reset for another upload after a beat so the rep
            // can send a few in sequence.
            setTimeout(() => {
              preview.style.display = 'none';
              preview.innerHTML = '';
              fileInput.value = '';
              setStatus('Got more? Upload another.', 'info');
            }, 1500);
          } catch (err) {
            setStatus('Network error: ' + (err.message || 'try again'), 'error');
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send to your rep';
          }
        });
      } catch (err) {
        setStatus(err.message || 'Could not prepare photo.', 'error');
      }
    }
  }

  loadView();
})();
