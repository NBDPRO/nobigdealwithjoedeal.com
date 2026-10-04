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
 * nothing. Nothing in this file talks to a server.
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

  async function share(opts) {
    const o = opts || {};
    const w = root || {};
    const body = withLink(o.text, o.url);
    const nav = w.navigator || {};
    if (typeof nav.share === 'function') {
      try {
        // The URL rides inside `text`, not `url:` — Messages drops the text
        // when both are given on some iOS versions, and Jo's words matter.
        await nav.share({ title: o.title || '', text: body });
        return { shared: true, via: 'share' };
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
    return yes ? { shared: true, via } : { shared: false, via: null, cancelled: true };
  }

  const api = { share, smsHref, mailtoHref, withLink, digits };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) root.NBDPhoneShare = api;
})(typeof window !== 'undefined' ? window : null);
