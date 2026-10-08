/**
 * phone-share.js — send a message from Jo's OWN phone (2026-10-03).
 *
 * The server's Twilio number is a trial with no A2P registration: 23 texts
 * "sent" in 45 days, 0 delivered (error 30034 / 21608) while the CRM said
 * SENT. So a link Jo means to hand a homeowner goes out the way a person
 * sends one — the iPhone share sheet (navigator.share), which offers Messages,
 * Mail, WhatsApp… and sends from Jo's own number. Where there is no share
 * sheet (a desktop browser), the Messages / Mail app is opened with the
 * message already written (sms: / mailto:).
 *
 *   NBDPhoneShare.share({ text, url, title, phone, email, subject, ask })
 *     → Promise<{ shared: boolean, via: 'share'|'sms'|'email'|null,
 *                 cancelled?: boolean }>
 *
 * `shared` is TRUE only when Jo actually sent it:
 *   - the share sheet resolved (he picked an app and sent / copied), or
 *   - after an sms: / mailto: hand-off, he confirmed "Did it go out?" —
 *     opening Messages is not sending, and nothing here can see Messages.
 * A cancelled sheet or a "no" is { shared:false } and the caller stamps
 * nothing.
 *
 * OK TO TEXT? (review R2-3-2, Jo 2026-10-06). Before anything opens with a
 * PHONE number in it, the server is asked whether this person may be texted
 * (phoneTextAction 'check', functions/phone-text-check.js): the STOP register
 * in both key shapes, the company's Do Not Text list, a "no" on their consent
 * form, the company's texting switch and texting hours in the homeowner's
 * time. The browser cannot read those lists (firestore.rules). A "no" blocks
 * with the reason ({ shared:false, blocked:true }); a check that ERRORS
 * blocks too — "couldn't check — call instead" — never a hand-off.
 *   opts.leadId     the customer the text is about (homeowner texts need it)
 *   opts.recipient  'crew' for a text to a sub (no lead, no hours/consent)
 *   opts.preferSms  open Messages directly, not the share sheet
 *   opts.source     what to log it as (sms_log.source), default 'phone_share'
 * A homeowner text that went out is logged to the Communication Log
 * (phoneTextAction 'sent' → one sms_log row, via 'owner_device').
 *
 *   NBDPhoneShare.precheck(opts)   start the check early (e.g. while a link is
 *                                  minted) so the share sheet keeps the tap
 *   NBDPhoneShare.checkText(opts)  → { ok, reason?, code? } — never throws
 *   NBDPhoneShare.reportStop(opts) "They replied STOP" ({ leadId, logId?, phone? })
 *
 * Pure helpers (smsHref, mailtoHref, withLink) are exported for tests.
 */
(function (root) {
  'use strict';

  function digits(phone) {
    let d = String(phone || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    return d.length >= 10 ? d : '';
  }

  // `sms:<number>?&body=` is the one shape both iOS Messages and Android
  // read the body from (iOS ignores a bare `?body=` on some versions).
  function smsHref(phone, text) {
    const d = digits(phone);
    return 'sms:' + d + '?&body=' + encodeURIComponent(String(text || ''));
  }

  function mailtoHref(email, subject, text) {
    const to = String(email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return '';
    return 'mailto:' + encodeURIComponent(to).replace(/%40/g, '@')
      + '?subject=' + encodeURIComponent(String(subject || ''))
      + '&body=' + encodeURIComponent(String(text || ''));
  }

  /** The message with the link on its own line, once. */
  function withLink(text, url) {
    const t = String(text || '').trim();
    const u = String(url || '').trim();
    if (!u || t.indexOf(u) !== -1) return t;
    return t ? t + '\n\n' + u : u;
  }

  function _ask(question) {
    const w = root || {};
    const fn = w.nbdConfirm || (w.confirm ? (m) => Promise.resolve(w.confirm(m)) : null);
    if (!fn) return Promise.resolve(false);
    try { return Promise.resolve(fn(question)).then((v) => v === true); } catch (_) { return Promise.resolve(false); }
  }

  function _open(href) {
    const w = root || {};
    try {
      if (w.location && typeof w.location.assign === 'function') w.location.assign(href);
      else if (w.open) w.open(href, '_self');
      return true;
    } catch (_) { return false; }
  }

  // ── the server's "ok to text?" (phone-text-check.js) ─────────────────
  const COULD_NOT_CHECK = "Couldn't check whether this customer can be texted — nothing was sent. Call them instead, or try again in a moment.";
  const OK_TTL_MS = 120000;
  const _checks = Object.create(null);

  async function _call(action, payload) {
    const w = root || {};
    if (!w._functions || !w._httpsCallable) {
      const mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
      w._functions = w._functions || mod.getFunctions();
      w._httpsCallable = w._httpsCallable || mod.httpsCallable;
    }
    const res = await w._httpsCallable(w._functions, 'phoneTextAction')(Object.assign({ action }, payload || {}));
    return (res && res.data) || {};
  }

  // 'crew' (a sub) / 'number' (no lead behind it): the number's lists only.
  function _numberOnly(o) { return (o.recipient === 'crew' || o.recipient === 'number') && !o.leadId; }
  function _checkKey(o) { return (_numberOnly(o) ? o.recipient : String(o.leadId || '')) + '|' + digits(o.phone); }

  /** The server's answer for this person, now. Never throws; an error is { ok:false, code:'unverified' }. */
  function checkText(opts) {
    const o = opts || {};
    const k = _checkKey(o);
    const hit = _checks[k];
    if (hit && Date.now() - hit.at < OK_TTL_MS) return hit.p;
    const p = (async () => {
      if (!digits(o.phone)) return { ok: false, code: 'no_phone', reason: 'No phone number on file for this customer.' };
      if (!_numberOnly(o) && !o.leadId) return { ok: false, code: 'no_lead', reason: COULD_NOT_CHECK };
      try {
        const r = await _call('check', _numberOnly(o)
          ? { phone: String(o.phone), recipient: o.recipient }
          : { phone: String(o.phone), leadId: String(o.leadId), recipient: 'homeowner' });
        return r && r.ok === true ? r : { ok: false, code: (r && r.code) || 'unverified', reason: (r && r.reason) || COULD_NOT_CHECK };
      } catch (_) {
        return { ok: false, code: 'unverified', reason: COULD_NOT_CHECK };
      }
    })();
    _checks[k] = { at: Date.now(), p };
    // Only a YES is kept (so a second "Share now" tap stays inside the tap);
    // a NO is asked again next time.
    p.then((r) => { if (!r || r.ok !== true) delete _checks[k]; });
    return p;
  }
  function precheck(opts) { if (opts && digits(opts.phone)) checkText(opts); }

  function _toast(m, t) { const w = root || {}; if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }

  /** Log a homeowner text that went out from the phone (Comm Log). Best-effort. */
  function _logSent(o, body) {
    if (_numberOnly(o) || !o.leadId || !digits(o.phone)) return;
    _call('sent', { leadId: String(o.leadId), phone: String(o.phone), body: String(body || '').slice(0, 1600), source: o.source || 'phone_share' })
      .catch((e) => { try { console.warn('[phone-share] comm-log write failed', e && e.message); } catch (_) {} });
  }

  /** "They replied STOP" — recorded like an inbound STOP (both lists). */
  async function reportStop(opts) {
    const o = opts || {};
    try {
      const r = await _call('stop', { leadId: String(o.leadId || ''), logId: o.logId || undefined, phone: o.phone ? String(o.phone) : undefined });
      Object.keys(_checks).forEach((k) => { delete _checks[k]; });
      return { ok: !!(r && r.ok) };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || 'Could not record it — try again.' };
    }
  }

  async function share(opts) {
    const o = opts || {};
    const w = root || {};
    const body = withLink(o.text, o.url);
    const nav = w.navigator || {};
    // Any send that carries a phone number asks the server first.
    if (digits(o.phone)) {
      const chk = await checkText(o);
      if (!chk || chk.ok !== true) {
        _toast((chk && chk.reason) || COULD_NOT_CHECK, 'error');
        return { shared: false, via: null, blocked: true, code: (chk && chk.code) || 'unverified', reason: (chk && chk.reason) || COULD_NOT_CHECK };
      }
    }
    const done = (r) => { if (r.shared && digits(o.phone)) _logSent(o, body); return r; };
    if (typeof nav.share === 'function' && !o.preferSms) {
      try {
        // The URL rides inside `text`, not `url:` — Messages drops the text
        // when both are given on some iOS versions, and Jo's words matter.
        await nav.share({ title: o.title || '', text: body });
        return done({ shared: true, via: 'share' });
      } catch (e) {
        if (e && e.name === 'AbortError') return { shared: false, via: null, cancelled: true };
        // Safari refuses a share that no longer has the tap's user
        // activation (the link mint took too long). The caller keeps the
        // message and offers a "Share now" tap — the next call is in-gesture.
        if (e && e.name === 'NotAllowedError' && !o.noRetry) return { shared: false, via: null, needsTap: true };
        // TypeError (bad data) / anything else: fall back to Messages / Mail.
      }
    }
    let via = null, href = '';
    if (digits(o.phone)) { via = 'sms'; href = smsHref(o.phone, body); }
    else if (mailtoHref(o.email, o.subject, body)) { via = 'email'; href = mailtoHref(o.email, o.subject, body); }
    if (!href) {
      // Nowhere to hand it to: put it on the clipboard so it can be pasted.
      try {
        if (nav.clipboard && nav.clipboard.writeText) await nav.clipboard.writeText(body);
        if (typeof w.showToast === 'function') w.showToast('No phone or email on file — message copied, paste it anywhere', 'info');
      } catch (_) { /* nothing else to do */ }
      return { shared: false, via: null };
    }
    if (!_open(href)) return { shared: false, via: null };
    const yes = await _ask(o.ask || (via === 'sms'
      ? 'Did the text go out from your phone?'
      : 'Did the email go out?'));
    return yes ? done({ shared: true, via }) : { shared: false, via: null, cancelled: true };
  }

  const api = { share, checkText, precheck, reportStop, smsHref, mailtoHref, withLink, digits };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) root.NBDPhoneShare = api;
})(typeof window !== 'undefined' ? window : null);
