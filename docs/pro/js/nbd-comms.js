/**
 * nbd-comms.js — platform messaging with graceful handoff fallback
 *
 * Three modules call `window.NBDComms.sendEmail` / `sendSMS`:
 *   - invoice-pipeline.js (object-shape signature)
 *   - email_system.js     (positional + options-object signature)
 *   - d2d-tracker.js      (positional with knockId signature)
 *
 * Preferred path: POST to Cloud Functions sendEmail / sendSMS
 * (Resend + Twilio). Server writes email_log / sms_log with leadId+uid+date
 * so the Communication Log query works. Client MUST NOT write those
 * collections (Firestore rules: allow write: if false).
 *
 * Fallback: mailto: / sms: protocol handoff when:
 *   - email: network failure / offline (status 0)
 *   - rate limit (429) / paid gate (402)
 *   - SMS: Twilio failed after the opt-out check passed (code 'provider_error')
 *   - caller passes { forceHandoff: true }
 *
 * SMS NEVER hands off on 401, 403 (opted out — our register or Twilio's STOP
 * list — or not allowed), or any other 5xx (e.g. 503 'optout_unverified': the
 * opt-out register could not be read). A handoff pre-fills the text on the
 * rep's phone, so it is a text to that person and may only follow a server
 * answer that came after the opt-out check. functions/sms-functions.js runs
 * that check before its paid gate and every limiter, which is what makes the
 * 402/429 handoff safe.
 *
 * SMS offline (status 0 — no network, fetch rejected, or the 25s abort) goes
 * to the OFFLINE OUTBOX (sms-outbox.js, window.NBDSmsOutbox): the text is kept
 * in IndexedDB and replayed through the sendQueuedSMS endpoint (the sendSMS
 * handler with `queued` forced on — its own endpoint so an old deploy cannot
 * serve a replay as a live send) when the app is back online, where the
 * server re-checks opt-out, quiet hours, staleness and competing activity
 * before it goes. No handoff: offline, nobody knows
 * whether the number is still textable. Only when the outbox cannot store
 * anything on this device (no IndexedDB, e.g. private mode) — or the page
 * did not load it — does offline keep the pre-outbox handoff.
 *
 * Returns { success, mode: 'platform'|'mailto'|'sms'|'queued', id?, sid?, error?, message? }.
 * Callers that mark invoices "sent" should treat mode:'platform' as delivered
 * and mode:'mailto'|'sms' as "rep initiated client handoff". mode:'queued' is
 * NEITHER: the text is stored on this device and has not gone anywhere — no
 * "sent" stamps, no "Text sent" toasts. A caller that stamps something when
 * the text really goes passes { source, sourceRef } and registers
 * NBDSmsOutbox.onSent(source, fn): the outbox keeps a durable receipt until
 * a handler applies it, whichever tab or page load the send happens in (the
 * 'nbd:sms-outbox-sent' window event is an in-tab notification only and
 * must not carry a stamp). success:false with mode:'platform' is a
 * REFUSAL the rep has already been told about; an SMS caller must not follow
 * it with its own sms: fallback or a re-send.
 *
 * Also defines window.EmailDrip — stage-change toast (opt-in review, no auto-send).
 *
 * Loaded on dashboard.html + customer.html as a defer-script before
 * crm.js / email_system.js so window.NBDComms / window.EmailDrip exist early.
 */
let _NBD_NC_DELEGATE; // module-local (globals Tranche 1 — was window.*)
(function () {
  'use strict';

  const FUNCTIONS_BASE = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(
    (typeof location !== 'undefined' && location.hostname) || ''
  )
    ? 'http://127.0.0.1:5001/nobigdeal-pro/us-central1'
    : 'https://us-central1-nobigdeal-pro.cloudfunctions.net';

  // ── Helpers ─────────────────────────────────────────────────────
  // (escHtml removed: its only caller was the stage-email toast, which built an
  // HTML string for a renderer that uses textContent. There is no innerHTML
  // sink left in this module, and keeping an escaper around invites someone to
  // reach for it again on a text sink — where it corrupts the output rather
  // than protecting it.)

  function toMailtoBody(html) {
    if (!html) return '';
    return String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ── Argument normalization ──────────────────────────────────────
  function normalizeEmailArgs(a, b, c, d) {
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      return {
        to: a.to || '',
        subject: a.subject || '',
        body: a.body || a.text || (a.html ? toMailtoBody(a.html) : ''),
        html: a.html || null,
        leadId: a.leadId || null,
        replyTo: a.replyTo || null,
        forceHandoff: !!a.forceHandoff,
      };
    }
    return {
      to: a || '',
      subject: b || '',
      body: c || '',
      html: (d && d.html) || null,
      leadId: (d && d.leadId) || null,
      replyTo: (d && d.replyTo) || null,
      forceHandoff: !!(d && d.forceHandoff),
    };
  }

  // `leadStage` / `source` / `sourceRef` only matter when the text ends up in
  // the offline outbox: leadStage is what the server compares against the
  // lead's stage at send time (a moved lead holds the text), source/sourceRef
  // tell the caller's receipt handler which record a later send belongs to
  // (see onSent in sms-outbox.js). The positional form takes them
  // as an optional 4th options argument (d2d-tracker's call shape).
  function normalizeSmsArgs(a, b, c, d) {
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      return {
        to: a.to || a.phone || '',
        body: a.message || a.body || a.text || '',
        knockId: a.knockId || null,
        leadId: a.leadId || null,
        forceHandoff: !!a.forceHandoff,
        leadStage: typeof a.leadStage === 'string' ? a.leadStage : null,
        source: typeof a.source === 'string' ? a.source : null,
        sourceRef: typeof a.sourceRef === 'string' ? a.sourceRef : null,
      };
    }
    const o = (d && typeof d === 'object') ? d : {};
    return {
      to: a || '',
      body: b || '',
      knockId: c || null,
      leadId: typeof o.leadId === 'string' ? o.leadId : null,
      forceHandoff: false,
      leadStage: typeof o.leadStage === 'string' ? o.leadStage : null,
      source: typeof o.source === 'string' ? o.source : null,
      sourceRef: typeof o.sourceRef === 'string' ? o.sourceRef : null,
    };
  }

  function _currentUser() {
    return window._user
      || (window.auth && window.auth.currentUser)
      || (window._auth && window._auth.currentUser)
      || null;
  }

  // The lead's stage as the page knows it right now, for a text that is about
  // to be queued. The caller's value wins; otherwise the page's own copy of
  // the lead (dashboard: window._leads, customer page: window._currentLead).
  // null when unknown — the server then checks only that the lead still
  // exists, not that it has not moved.
  function _leadStageFor(leadId, given) {
    if (typeof given === 'string' && given) return given;
    if (!leadId) return null;
    try {
      const cur = window._currentLead;
      if (cur && cur.id === leadId && typeof cur.stage === 'string') return cur.stage;
      const list = Array.isArray(window._leads) ? window._leads : [];
      for (let i = 0; i < list.length; i++) {
        const l = list[i];
        if (l && l.id === leadId) return typeof l.stage === 'string' ? l.stage : null;
      }
    } catch (_) {}
    return null;
  }

  // The outbox module, when this page loaded it and the browser can store it.
  // sms-outbox.js is loaded right after this file on dashboard.html and
  // customer.html; anywhere else (or before it has run) this is null and the
  // offline path below keeps its pre-outbox behaviour.
  function _outbox() {
    const ob = window.NBDSmsOutbox;
    return (ob && typeof ob.enqueue === 'function') ? ob : null;
  }

  function _isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  function _openHandoff(href) {
    if (!href) return;
    try {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { a.remove(); } catch (_) {} }, 0);
    } catch (e) {
      try { window.location.href = href; } catch (_) {}
    }
  }

  async function _authHeaders() {
    const user = _currentUser();
    if (!user || typeof user.getIdToken !== 'function') return null;
    const idToken = await user.getIdToken();
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + idToken,
    };
    // App Check: sendEmail/sendSMS declare enforceAppCheck:true.
    try {
      const ac = window.__NBD_APP_CHECK;
      if (ac) {
        const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js');
        if (mod && typeof mod.getToken === 'function') {
          const tok = await mod.getToken(ac, /* forceRefresh */ false);
          if (tok && tok.token) headers['X-Firebase-AppCheck'] = tok.token;
        }
      }
    } catch (_) { /* proceed; server may still accept in soft-fail envs */ }
    return headers;
  }

  // The ID token could not be minted. A token refresh needs the network (a
  // phone asleep for over an hour, then "lie-fi": navigator.onLine true, no
  // real connectivity), and it rejects with auth/network-request-failed —
  // which used to escape _platformPost, so sendSMS REJECTED: the text was
  // neither queued nor sent, and most callers showed nothing. That is a
  // connection failure like any other (status 0), except that no request
  // left: `neverSent`, so the outbox does not mark the text "may have gone".
  // Any other auth failure is a sign-in problem (401).
  function _authFailure(e) {
    const code = (e && e.code) || '';
    if (code === 'auth/network-request-failed' || (e && e.name === 'TypeError')) {
      return { ok: false, status: 0, error: 'network', neverSent: true };
    }
    return { ok: false, status: 401, error: 'not-authenticated' };
  }

  async function _platformPost(fnName, body) {
    let headers;
    try {
      headers = await _authHeaders();
    } catch (e) {
      return _authFailure(e);
    }
    if (!headers) return { ok: false, status: 401, error: 'not-authenticated' };
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    // An abort lands in the status-0 (offline) branch below, which SMS queues
    // in the offline outbox (or, with no outbox on the page, hands off).
    // sendSMS bounds its opt-out read (functions/sms-optout.js
    // READ_TIMEOUT_MS, 10s) so a slow register answers 503 before this fires.
    // Keep this the larger of the two; tests/sms-optout-key.test.js checks it.
    const timeout = controller ? setTimeout(() => controller.abort(), 25000) : null;
    try {
      const res = await fetch(FUNCTIONS_BASE + '/' + fnName, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
      if (timeout) clearTimeout(timeout);
      // `|| {}`: a JSON body of `null` would otherwise throw on data.error and
      // land in the catch below as status 0 — the offline handoff.
      const data = (await res.json().catch(() => null)) || {};
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: data.error || ('HTTP ' + res.status),
          // Machine-readable reason (e.g. 'opted_out', 'optout_unverified',
          // 'provider_error'); null when the server sent none — including the
          // framework's plain-text 500 for an uncaught throw.
          code: (typeof data.code === 'string' && data.code) || null,
          // Why a queued (offline-outbox) text was held: 409 {code:'held', reason}.
          reason: (typeof data.reason === 'string' && data.reason) || null,
        };
      }
      return { ok: true, status: res.status, data: data };
    } catch (e) {
      if (timeout) clearTimeout(timeout);
      return { ok: false, status: 0, error: (e && e.message) || 'network-error' };
    }
  }

  /**
   * Put a text that could not reach sendSMS into the offline outbox.
   *
   * Returns the sendSMS result to hand back to the caller, or null when the
   * outbox cannot store anything on this device (no IndexedDB — private
   * mode, storage disabled), in which case sendSMS keeps its pre-outbox
   * behaviour: the device-Messages handoff. The outbox never invents a
   * localStorage copy of a phone number and a message.
   *
   * { success: true, mode: 'queued' } means STORED, NOT SENT. Every caller
   * must treat it that way — no "sent" stamps, no "Text sent" toasts.
   */
  async function _enqueueOffline(args, user, attemptAt, clientMsgId, attempted) {
    const ob = _outbox();
    if (!ob || !user || !user.uid) return null;
    try {
      const rec = await ob.enqueue({
        // The live attempt's id: if that request reached sendSMS, the server
        // claimed it, and the replay answers "in_flight"/"duplicate" rather
        // than sending the text a second time.
        id: clientMsgId || undefined,
        // A real request went out and its answer never came back: it may
        // have been sent. The outbox then asks the server before any local
        // "stale" hold (see sms-outbox.js _flushInner).
        uncertain: !!attempted,
        uid: user.uid,
        to: args.to,
        body: args.body,
        leadId: args.leadId || null,
        knockId: args.knockId || null,
        source: args.source || null,
        sourceRef: args.sourceRef || null,
        leadStageAtQueue: _leadStageFor(args.leadId, args.leadStage),
        createdAt: attemptAt,
      });
      if (window.showToast) window.showToast('Queued — will send when you\'re back online', 'info');
      return { success: true, mode: 'queued', id: rec.id };
    } catch (e) {
      const reason = e && e.reason;
      if (reason === 'queue-full') {
        // Refuse out loud. Never drop, never hand off: the rep has 50 texts
        // waiting already and needs to look at them.
        const msg = 'Not sent — ' + (ob.MAX_PER_USER || 50) + ' texts are already waiting to send. Open Pending texts and clear some first.';
        if (window.showToast) window.showToast(msg, 'error');
        return { success: false, mode: 'platform', error: 'outbox-full', message: msg };
      }
      // 'unavailable' / 'quota' / 'write-failed' / 'bad-item': the text is
      // not stored anywhere. Fall back to the pre-outbox behaviour.
      console.warn('[NBDComms] offline outbox could not store the text:', reason || (e && e.message));
      return null;
    }
  }

  // The offline outbox's endpoint. NOT sendSMS: Hosting deploys before
  // Functions, and an old sendSMS ignores `queued` — it would send every
  // replay as a live text with none of the queued checks. An old fleet has no
  // sendQueuedSMS: the POST fails (404, or a CORS failure that reads as status
  // 0) and the text stays queued. See functions/sms-functions.js.
  const QUEUED_FN = 'sendQueuedSMS';

  // 5xx answers that are a server VERDICT "nothing was sent" (a check could
  // not run, or the queued-gate budget is spent): the text is certainly not
  // on the homeowner's phone. A plain 500 is not one of them.
  const NOT_SENT_5XX = { outbox_unverified: 1, optout_unverified: 1, outbox_throttled: 1 };

  /**
   * One answer from sendQueuedSMS → the outbox's outcome vocabulary (see
   * sendQueued). `neverSent: true` marks answers that prove the text did not
   * go — the outbox then does not treat it as "may have gone".
   */
  function _queuedOutcome(plat) {
    if (plat.ok) {
      const d = plat.data || {};
      return { outcome: d.duplicate ? 'duplicate' : 'sent', sid: d.sid || null };
    }
    const message = plat.error || null;
    if (plat.status === 0) return { outcome: 'network', message, neverSent: !!plat.neverSent };
    if (plat.status === 401) return { outcome: 'auth', message, neverSent: true };
    // This deploy has no sendQueuedSMS yet (Hosting shipped first, or a
    // functions rollback): nothing was sent, try again later.
    if (plat.status === 404) return { outcome: 'retry', reason: 'not_deployed', message, neverSent: true };
    if (plat.status === 409 && plat.code === 'held') return { outcome: 'held', reason: plat.reason || 'held', message };
    // (a peek) nothing of it reached Twilio.
    if (plat.status === 409 && plat.code === 'not_claimed') return { outcome: 'not_claimed', message };
    if (plat.status === 403) return { outcome: plat.code === 'opted_out' ? 'opted_out' : 'refused', reason: plat.code || 'forbidden', message };
    if (plat.status === 402) return { outcome: 'held', reason: 'plan_required', message };
    if (plat.status === 429) return { outcome: 'held', reason: 'rate_limited', message };
    if (plat.code === 'provider_error') return { outcome: 'held', reason: 'provider_error', message };
    if (plat.status >= 500) {
      return { outcome: 'retry', reason: plat.code || 'server_error', message, neverSent: NOT_SENT_5XX[plat.code] === 1 };
    }
    return { outcome: 'held', reason: plat.status === 400 ? 'invalid' : 'error', message };
  }

  // ── NBDComms ────────────────────────────────────────────────────
  window.NBDComms = {
    /**
     * Send email via platform (Resend) with mailto: fallback.
     * @returns {Promise<{success:boolean, mode:string, id?:string, error?:string}>}
     */
    async sendEmail() {
      const { to, subject, body, html, leadId, replyTo, forceHandoff } = normalizeEmailArgs.apply(null, arguments);
      if (!to) {
        const msg = 'No recipient — add an email to the customer record first.';
        if (window.showToast) window.showToast(msg, 'error');
        return { success: false, mode: 'mailto', error: 'no-recipient' };
      }
      const plainBody = body || (html ? toMailtoBody(html) : '');
      if (!subject || !String(subject).trim()) {
        if (window.showToast) window.showToast('Email subject is required.', 'error');
        return { success: false, mode: 'mailto', error: 'no-subject' };
      }
      if (!plainBody && !html) {
        if (window.showToast) window.showToast('Email body is empty.', 'error');
        return { success: false, mode: 'mailto', error: 'no-body' };
      }

      if (!forceHandoff) {
        const plat = await _platformPost('sendEmail', {
          to: to,
          subject: subject,
          body: plainBody || undefined,
          html: html || undefined,
          replyTo: replyTo || undefined,
          leadId: leadId || undefined,
        });
        if (plat.ok) {
          if (window.showToast) window.showToast('Email sent', 'success');
          return {
            success: true,
            mode: 'platform',
            id: (plat.data && (plat.data.id || plat.data.messageId)) || null,
          };
        }
        // Hard role/auth errors: don't silently open mailto (rep would think
        // they sent). Surface and stop.
        if (plat.status === 403 || plat.status === 401) {
          const msg = plat.error || 'Not allowed to send email from this account.';
          if (window.showToast) window.showToast(msg, 'error');
          return { success: false, mode: 'platform', error: plat.error || 'forbidden' };
        }
        // Rate limit: tell the rep; fall through to mailto so work continues.
        if (plat.status === 429 && window.showToast) {
          window.showToast((plat.error || 'Email limit reached') + ' — opening your mail app instead.', 'warning');
        } else if (plat.error && window.showToast) {
          window.showToast('Platform email failed — opening your mail app.', 'warning');
        }
      }

      // Handoff fallback (no client audit write — rules deny it and it lies).
      const link = 'mailto:' + encodeURIComponent(to)
        + '?subject=' + encodeURIComponent(subject || '')
        + '&body=' + encodeURIComponent(plainBody);
      _openHandoff(link);
      return { success: true, mode: 'mailto' };
    },

    /**
     * Send SMS via platform (Twilio) with sms: protocol fallback.
     * @returns {Promise<{success:boolean, mode:string, sid?:string, error?:string}>}
     */
    async sendSMS() {
      const args = normalizeSmsArgs.apply(null, arguments);
      const { to, body, knockId, leadId, forceHandoff } = args;
      if (!to) {
        const msg = 'No phone number — add one to the customer record first.';
        if (window.showToast) window.showToast(msg, 'error');
        return { success: false, mode: 'sms', error: 'no-recipient' };
      }
      if (!body || !String(body).trim()) {
        if (window.showToast) window.showToast('Message body is empty.', 'error');
        return { success: false, mode: 'sms', error: 'no-body' };
      }

      if (!forceHandoff) {
        // Taken BEFORE the attempt: the outbox's replay is checked against
        // activity since this moment.
        const attemptAt = Date.now();
        const user = _currentUser();
        // The attempt's idempotency key, minted BEFORE it and sent with it.
        // If the fetch dies after the request reached sendSMS (a network drop
        // mid-request, the 25s abort), the outbox stores the text under this
        // same id; the server claimed it before calling Twilio, so the replay
        // answers "in_flight" or "duplicate" instead of sending it again. The
        // activity check alone cannot catch that: the live send's sms_log row
        // is written only after Twilio returns. No outbox on the page → no id
        // (and the pre-outbox path exactly).
        const ob = _outbox();
        const clientMsgId = (ob && user && typeof ob.newId === 'function') ? ob.newId() : null;
        // Known offline and there is somewhere to keep the text: don't burn
        // a doomed request, queue it now.
        const skipAttempt = !!(_isOffline() && ob && user);
        const plat = skipAttempt
          ? { ok: false, status: 0, error: 'offline' }
          : await _platformPost('sendSMS', {
            to: to,
            body: body,
            leadId: leadId || undefined,
            knockId: knockId || undefined,
            clientMsgId: clientMsgId || undefined,
          });
        if (plat.status === 0 && _outbox() && user) {
          // "May have gone" only when a request can actually have left: not
          // for the offline pre-check, and not when the ID token could not
          // even be minted (plat.neverSent).
          const queued = await _enqueueOffline(args, user, attemptAt, clientMsgId, !skipAttempt && !plat.neverSent);
          if (queued) return queued;
          // null → the outbox could not store it (no IndexedDB): fall through
          // to the pre-outbox behaviour below, which hands off to Messages.
        }
        if (plat.ok) {
          if (window.showToast) window.showToast('Text sent', 'success');
          return {
            success: true,
            mode: 'platform',
            sid: (plat.data && plat.data.sid) || null,
          };
        }
        // Refusals: do not open device Messages (would still text).
        //   403 — opted out (our register, or Twilio's STOP list) / not allowed.
        //   5xx other than 'provider_error' — the server could not show this
        //         number is textable: 503 'optout_unverified', or the function
        //         threw (a plain-text 500 with no code). Fail closed, as the
        //         server does. 'provider_error' is Twilio failing AFTER the
        //         opt-out check passed, so it still hands off below.
        //   409 'held' — this attempt's clientMsgId is already claimed (only
        //         an outbox replay of the same id can do that): the text is
        //         in flight or sent. A handoff would be a second text.
        if (plat.status === 403 || (plat.status >= 500 && plat.code !== 'provider_error')
          || (plat.status === 409 && plat.code === 'held')) {
          const msg = plat.status === 403
            ? (plat.error || 'Cannot text this number (opted out or not allowed).')
            : plat.status === 409
              ? 'This text is already being sent — check the conversation before sending it again.'
              : 'Could not confirm this number can be texted — nothing was sent. Try again in a moment.';
          if (window.showToast) window.showToast(msg, 'error');
          // `error` is the machine code when the server sent one; `message` is
          // what the rep was told (invoice-pipeline surfaces it).
          return { success: false, mode: 'platform', error: plat.code || plat.error || 'forbidden', message: msg };
        }
        if (plat.status === 401) {
          if (window.showToast) window.showToast('Sign in again to send texts.', 'error');
          return { success: false, mode: 'platform', error: 'not-authenticated' };
        }
        if (plat.status === 429 && window.showToast) {
          window.showToast((plat.error || 'SMS limit reached') + ' — opening Messages instead.', 'warning');
        } else if (plat.error && window.showToast) {
          // Paid-gate / Twilio trial / A2P / network — hand off so field work continues.
          const err = String(plat.error || '');
          const a2p = /30034|A2P|unverified|trial|subscription|paid/i.test(err);
          window.showToast(
            a2p
              ? 'Platform SMS blocked (plan/Twilio/A2P) — opening Messages. Finish Twilio setup for business-line texts.'
              : 'Platform SMS unavailable — opening Messages.',
            'warning'
          );
          try {
            window.__NBD_SMS_PLATFORM_LAST_ERROR = { at: Date.now(), status: plat.status, error: err };
            window.dispatchEvent(new CustomEvent('nbd:sms-platform-error', { detail: window.__NBD_SMS_PLATFORM_LAST_ERROR }));
          } catch (_) {}
        }
      }

      const link = 'sms:' + encodeURIComponent(to) + '?body=' + encodeURIComponent(body || '');
      _openHandoff(link);
      return { success: true, mode: 'sms' };
    },

    /**
     * Replay one offline-outbox record through sendQueuedSMS. Used by
     * sms-outbox.js only. NO toasts and NO handoff here, ever — the outbox
     * decides what the rep is told, and a replay must never open Messages.
     *
     * @param {object} rec  outbox record: { id, to, body, leadId, knockId, createdAt, leadStageAtQueue }
     * @param {{overrideStale?: boolean, overrideActivity?: boolean}} [opts]
     *        explicit rep consent from the Pending texts tray. The server
     *        honours overrideActivity only for recent_outbound /
     *        recent_inbound / lead_changed — never opt-out or quiet hours.
     * @returns {Promise<{outcome: 'sent'|'duplicate'|'held'|'opted_out'|'refused'|'network'|'retry'|'auth', reason?: string, message?: string, sid?: string, neverSent?: boolean}>}
     *   sent/duplicate → it went out (now or on an earlier attempt)
     *   held           → not sent; `reason` says why (server hold, or 402/429/provider_error)
     *   opted_out      → not sent, and never will be (403)
     *   refused        → not sent; another 403
     *   network        → no answer; try again later (neverSent: no request left)
     *   retry          → the server could not check it (5xx), or this deploy
     *                    has no sendQueuedSMS yet (404); try again later
     *   auth           → not signed in; try again later
     */
    async sendQueued(rec, opts) {
      opts = opts || {};
      if (!rec || !rec.id || !rec.to || !rec.body) return { outcome: 'refused', reason: 'invalid', message: 'Queued text is incomplete.' };
      if (_isOffline()) return { outcome: 'network', neverSent: true };
      const payload = {
        to: rec.to,
        body: rec.body,
        leadId: rec.leadId || undefined,
        knockId: rec.knockId || undefined,
        queued: true,
        clientMsgId: rec.id,
        queuedAt: rec.createdAt,
        // Two readings of THIS device's clock: its offset from real time
        // cancels out, so the server can place the moment the text was
        // written on its own clock (sms-outbox-guard.js effectiveQueuedAt).
        // queuedAt alone let a phone running fast make an old text look
        // fresh and hide a reply that came in after it was written.
        queuedAgeMs: Math.max(0, Date.now() - rec.createdAt),
        leadStageAtQueue: rec.leadStageAtQueue || undefined,
      };
      // An edit names the id(s) it replaces; the server holds it if one of
      // them reached Twilio after all.
      if (Array.isArray(rec.supersedes) && rec.supersedes.length) payload.supersedes = rec.supersedes.slice(-5);
      if (opts.overrideStale === true) payload.overrideStale = true;
      if (opts.overrideActivity === true) payload.overrideActivity = true;
      return _queuedOutcome(await _platformPost(QUEUED_FN, payload));
    },

    /**
     * "Did this text go?" — without sending it. The tray's "Check again" and
     * the flush's re-ask about a text whose last answer never arrived. The
     * server reads this id's claim (and those of the ids an edit replaces)
     * and answers from them alone; it never calls Twilio, so nothing a peek
     * answers can make a text "may have gone".
     *
     * @returns {Promise<{outcome: 'duplicate'|'held'|'not_claimed'|'network'|'retry'|'auth'|'refused', reason?: string, sid?: string, neverSent: true}>}
     *   duplicate   → it went out; apply it as sent
     *   held        → in_flight (claimed / outcome unknown), or recent_outbound
     *                 (an edit whose original went)
     *   not_claimed → nothing of it reached Twilio: it did NOT go
     */
    async peekQueued(rec) {
      if (!rec || !rec.id) return { outcome: 'refused', reason: 'invalid', neverSent: true };
      if (_isOffline()) return { outcome: 'network', neverSent: true };
      const payload = { peek: true, clientMsgId: rec.id };
      if (Array.isArray(rec.supersedes) && rec.supersedes.length) payload.supersedes = rec.supersedes.slice(-5);
      const out = _queuedOutcome(await _platformPost(QUEUED_FN, payload));
      // A peek never sends. The only 200 it has is "duplicate"; anything
      // else claiming a send is not trusted as one.
      if (out.outcome === 'sent') return { outcome: 'retry', reason: 'unexpected', neverSent: true };
      out.neverSent = true;
      return out;
    },
  };

  // ── EmailDrip ──────────────────────────────────────────────────
  // Stage-change toast: Review opens the modal; Send now builds the
  // stage template and posts via platform NBDComms (no auto-send on move).
  window.EmailDrip = {
    async onStageChange(leadId, oldStageKey, newStageKey) {
      if (!leadId || !newStageKey) return;
      if (oldStageKey === newStageKey) return;
      if (newStageKey === 'lost' || newStageKey === 'closed') return;
      try {
        const hasTemplate = !!(window.emailSystem
          && window.emailSystem.stageTemplates
          && window.emailSystem.stageTemplates[newStageKey]);
        let lead = (window._leads || []).find(l => l.id === leadId);
        if (!lead && window.db && window.getDoc && window.doc) {
          try {
            const snap = await window.getDoc(window.doc(window.db, 'leads', leadId));
            if (snap.exists()) lead = { id: leadId, ...snap.data() };
          } catch (_) {}
        }
        if (!lead || !lead.email) return;
        const name = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || 'this customer';
        // PLAIN TEXT. showToast renders its message with textContent — a
        // deliberate stored-XSS fix, and its own source notes that no caller
        // passes intentional markup. This one did: it built <strong> and two
        // styled <button> elements, so the rep dragging a lead to a new stage
        // got a toast containing the literal characters
        //   <button data-nc-action="sendStageNow" style="…">Send now</button>
        // spelled out on screen. The buttons were never clickable, so the
        // markup bought nothing even before it failed to render.
        //
        // Note this is also why the name must NOT be escaped here: escHtml
        // through a textContent renderer displays a customer called "Bob & Sons"
        // as "Bob &amp; Sons". Escaping is for innerHTML sinks; this is not one.
        //
        // The actions are dropped rather than re-homed. Of the two, only
        // gotoCustomerEmail resolves on the dashboard (emailByStage lives in
        // email_system.js, loaded on customer.html alone), and sendStageEmail
        // returns { error: 'no-emailByStage' } there for the same reason — so a
        // working "Send now" button would still not send. Whether that
        // subsystem should be reachable from the dashboard is a product call,
        // not something to paper over with a button that no-ops.
        const msg = `📧 Stage email ready for ${name} — open their customer page to review.`;
        if (typeof window.showToast === 'function') {
          window.showToast(msg, hasTemplate ? 'success' : 'info');
        }
      } catch (e) {
        console.warn('EmailDrip.onStageChange failed:', e && e.message);
      }
    },

    /**
     * Build the stage template for a lead and send via NBDComms.
     * Used by the toast "Send now" button and email_system hooks.
     */
    async sendStageEmail(leadId) {
      if (!leadId) return { success: false, error: 'no-lead' };
      if (typeof window.emailByStage === 'function' && typeof window.emailSystem?.buildStageEmail === 'function') {
        const built = await window.emailSystem.buildStageEmail(leadId);
        if (!built || !built.to) {
          if (window.showToast) window.showToast('No customer email for this lead', 'error');
          return { success: false, error: 'no-email' };
        }
        if (!window.NBDComms || typeof window.NBDComms.sendEmail !== 'function') {
          // Fall back to review modal.
          if (typeof window.emailByStage === 'function') window.emailByStage(leadId);
          return { success: false, error: 'comms-unavailable' };
        }
        return window.NBDComms.sendEmail({
          to: built.to,
          subject: built.subject,
          body: built.body,
          leadId: leadId,
        });
      }
      // buildStageEmail missing — open review modal instead.
      if (typeof window.emailByStage === 'function') {
        window.emailByStage(leadId);
        return { success: true, mode: 'review' };
      }
      return { success: false, error: 'no-emailByStage' };
    },
  };
})();


(function(){if(_NBD_NC_DELEGATE)return;_NBD_NC_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-nc-action]');if(!t)return;var a=t.dataset.ncAction;var id=t.dataset.ncId;if(a==='sendStageNow'&&window.EmailDrip&&typeof window.EmailDrip.sendStageEmail==='function'){t.disabled=true;window.EmailDrip.sendStageEmail(id).finally(function(){try{t.disabled=false;}catch(_){}});}else if(a==='emailByStage'&&typeof window.emailByStage==='function')window.emailByStage(id);else if(a==='gotoCustomerEmail')window.location.href='/pro/customer.html?id='+id+'&action=email-stage';});})();
