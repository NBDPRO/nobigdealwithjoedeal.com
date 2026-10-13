/**
 * doc-drafts-ui.js — the "Docs to review" queue on the customer page
 * (Jo, 2026-10-13).
 *
 * The server (functions/doc-drafts.js) drafts the email that belongs to a
 * stage event — schedule confirmation, crew date, warranty summary,
 * thank-you + review ask, paid receipt — into leads/{id}/doc_drafts. This file
 * is the review step: edit it, send it, copy it, or dismiss it. NOTHING goes
 * out on its own.
 *
 * Send is blocked while
 *   - any [[placeholder]] is left in the subject or body,
 *   - the customer has no email on file or came from Thumbtack / Yelp (those
 *     get a COPY button — the message goes through the marketplace app),
 *   - the address is on the do-not-contact list, or — for the thank-you's
 *     review ask, the one COMMERCIAL kind — the person unsubscribed from this
 *     company's email or texted STOP.
 * The server enforces the unsubscribe itself (sendEmail answers 403
 * 'unsubscribed'); the checks here only keep the button honest.
 *
 * Sending goes through window.NBDComms.sendEmail with leadId and the draft's
 * email `kind` (receipt / appointment / document are transactional; the
 * thank-you carries NO kind so the server treats it as commercial). A draft is
 * marked sent only when the PLATFORM delivered it — a mail-app handoff is not
 * a confirmed send.
 *
 * Lazy: loaded by customer-bootstrap.module.js after the lead renders
 * (ScriptLoader.load), so it costs no boot <script> tag. Strict CSP: no
 * inline handlers; every server value goes in through textContent / .value.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api.pure;
  if (root) root.NBDDocDrafts = api;
})(typeof window !== 'undefined' ? window : null, function (win) {
  'use strict';

  // ── PURE (unit-tested in node) ──────────────────────────────────────────
  var PH_RE = /\[\[[^\]]*\]\]/g;

  function placeholders(text) {
    return String(text == null ? '' : text).match(PH_RE) || [];
  }
  function unresolved(subject, body) {
    return placeholders(subject).concat(placeholders(body));
  }

  /**
   * Why Send is blocked, as a list of plain-English reasons ([] = clear).
   * draft: { channel, to, emailKind }; edit: { subject, body };
   * lead: the customer doc; state: { suppressed } (email_suppressions hit).
   */
  function sendBlockers(draft, edit, lead, state) {
    var out = [];
    var d = draft || {};
    var l = lead || {};
    var e = edit || {};
    var s = state || {};
    var left = unresolved(e.subject, e.body);
    if (left.length) out.push('Fill in ' + left.length + ' highlighted blank' + (left.length === 1 ? '' : 's') + ' first: ' + left.slice(0, 3).join(' '));
    if (d.channel !== 'email' || !d.to) out.push('No email to send to — use Copy.');
    if (!String(e.subject || '').trim() || !String(e.body || '').trim()) out.push('Subject and message can\'t be empty.');
    if (l.doNotContact === true || l.dnc === true) out.push('This customer is on your do-not-contact list.');
    var commercial = !d.emailKind;
    if (commercial && s.suppressed) out.push('They unsubscribed from your marketing email — a review ask is marketing.');
    if (commercial && l.smsOptedOut === true) out.push('They replied STOP — a review ask is marketing.');
    return out;
  }

  /** The timeline line a send leaves on the customer card. */
  function timelineText(draft, subject, how) {
    var d = draft || {};
    var verb = how === 'copied' ? 'Marked sent (copied to Thumbtack / Yelp / text)' : 'Emailed';
    return '📧 ' + verb + ': "' + String(subject || '').slice(0, 120) + '" — ' + String(d.label || d.kind || 'document') + ' (from Docs to review)';
  }

  /** The text Copy puts on the clipboard. */
  function copyText(subject, body) {
    return String(subject || '').trim() + '\n\n' + String(body || '').trim();
  }

  var pure = { placeholders: placeholders, unresolved: unresolved, sendBlockers: sendBlockers, timelineText: timelineText, copyText: copyText };
  if (!win || !win.document) return { pure: pure };

  // ── BROWSER ─────────────────────────────────────────────────────────────
  var doc = win.document;
  var seq = 0;

  function toast(msg, kind) {
    if (typeof win.showToast === 'function') win.showToast(msg, kind || 'info');
  }
  function claims() { return win._userClaims || {}; }
  function uid() {
    return (win.auth && win.auth.currentUser && win.auth.currentUser.uid)
      || (win._auth && win._auth.currentUser && win._auth.currentUser.uid) || '';
  }
  function tenantKey() { return String(claims().companyId || uid() || ''); }

  function sha256Hex(text) {
    return win.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }
  /** Advisory: is this address on the tenant's unsubscribe register? */
  function isSuppressed(email) {
    var e = String(email || '').trim().toLowerCase();
    var tk = tenantKey();
    if (!e || !tk || !(win.crypto && win.crypto.subtle) || !win.getDoc || !win.doc) return Promise.resolve(false);
    return sha256Hex(e).then(function (h) {
      return win.getDoc(win.doc(win.db, 'email_suppressions', tk + '__' + h));
    }).then(function (snap) { return !!snap.exists(); }).catch(function () { return false; });
  }

  function el(tag, css, text) {
    var n = doc.createElement(tag);
    if (css) Object.assign(n.style, css);
    if (text != null) n.textContent = text;
    return n;
  }
  var BTN = { minHeight: '44px', minWidth: '44px', padding: '0 14px', borderRadius: '10px', fontSize: '14px', fontWeight: '600', cursor: 'pointer', border: '1px solid var(--br, #d1d5db)', background: 'var(--s, #fff)', color: 'var(--t, #111827)' };
  var BTN_PRIMARY = Object.assign({}, BTN, { background: 'var(--orange, #e8720c)', color: '#fff', border: '1px solid transparent' });

  function setBusy(btns, busy) { btns.forEach(function (b) { b.disabled = busy; b.style.opacity = busy ? '.6' : '1'; }); }

  function cardFor(d, lead, onGone) {
    var data = d.data;
    var card = el('div', { border: '1px solid var(--br, #d1d5db)', borderRadius: '12px', padding: '12px', marginTop: '10px', background: 'var(--s, #fff)' });
    var head = el('div', { fontWeight: '700', fontSize: '14px' }, data.label || 'Draft');
    var meta = el('div', { fontSize: '12px', color: 'var(--m, #6b7280)', margin: '2px 0 8px', overflowWrap: 'anywhere' });
    meta.textContent = data.channel === 'email' && data.to ? 'To: ' + data.to : 'No email to send to — copy it into Thumbtack, Yelp or a text.';
    var subj = el('input', { width: '100%', boxSizing: 'border-box', minHeight: '44px', padding: '8px', fontSize: '16px', borderRadius: '8px', border: '1px solid var(--br, #d1d5db)', marginBottom: '8px' });
    subj.type = 'text'; subj.value = data.subject || ''; subj.setAttribute('aria-label', 'Subject');
    var body = el('textarea', { width: '100%', boxSizing: 'border-box', minHeight: '180px', padding: '8px', fontSize: '16px', borderRadius: '8px', border: '1px solid var(--br, #d1d5db)', fontFamily: 'inherit' });
    body.value = data.body || ''; body.setAttribute('aria-label', 'Message');
    var warn = el('div', { fontSize: '13px', margin: '8px 0', color: '#b45309', overflowWrap: 'anywhere' });
    var row = el('div', { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' });
    var send = el('button', BTN_PRIMARY, 'Send email'); send.type = 'button';
    var copy = el('button', BTN, 'Copy'); copy.type = 'button';
    var markSent = el('button', BTN, 'Mark sent'); markSent.type = 'button';
    var dismiss = el('button', BTN, 'Dismiss'); dismiss.type = 'button';
    var state = { suppressed: false };
    var isEmail = data.channel === 'email' && !!data.to;
    if (isEmail) row.appendChild(send);
    row.appendChild(copy); row.appendChild(markSent); row.appendChild(dismiss);
    var all = [send, copy, markSent, dismiss];

    function refresh() {
      var edit = { subject: subj.value, body: body.value };
      var why = sendBlockers(data, edit, lead, state);
      var left = unresolved(edit.subject, edit.body);
      warn.textContent = why.join(' ');
      send.disabled = why.length > 0;
      send.style.opacity = why.length ? '.5' : '1';
      body.style.borderColor = left.length ? '#d97706' : 'var(--br, #d1d5db)';
    }
    subj.addEventListener('input', refresh);
    body.addEventListener('input', refresh);

    function ref() { return win.doc(win.db, 'leads', data.leadId, 'doc_drafts', d.id); }
    function save(patch) { return win.updateDoc(ref(), patch); }
    function logTimeline(how) {
      try {
        var u = uid();
        if (!u || typeof win.setDoc !== 'function') return Promise.resolve();
        return win.setDoc(win.doc(win.db, 'notes', 'ddraft-' + d.id), {
          leadId: data.leadId, userId: u, createdBy: u,
          text: timelineText(data, subj.value, how), type: 'email', source: 'doc_draft', draftId: d.id,
          createdAt: new Date(), loggedAt: new Date(),
        }).catch(function () {});
      } catch (_) { return Promise.resolve(); }
    }
    function finish(how) {
      return save({ status: 'sent', subject: subj.value, body: body.value, sentAt: new Date() })
        .then(function () { return logTimeline(how); })
        .then(function () { card.remove(); onGone(); });
    }

    send.addEventListener('click', function () {
      refresh();
      if (send.disabled) return;
      if (!win.NBDComms || typeof win.NBDComms.sendEmail !== 'function') { toast('Email isn\'t available right now.', 'error'); return; }
      setBusy(all, true);
      var kind = data.emailKind || undefined;
      var payload = { to: data.to, subject: subj.value.trim(), body: body.value, leadId: data.leadId };
      if (kind) payload.kind = kind;
      win.NBDComms.sendEmail(payload).then(function (r) {
        if (r && r.success && r.mode === 'platform') return finish('emailed');
        if (r && r.success && r.mode === 'mailto') {
          toast('Opened your mail app. Tap Mark sent once you\'ve sent it.', 'warning');
        } else if (r && r.error === 'unsubscribed') {
          state.suppressed = true; refresh();
        }
        setBusy(all, false); refresh();
      }).catch(function (e) {
        setBusy(all, false); refresh();
        toast('Could not send: ' + ((e && e.message) || 'try again'), 'error');
      });
    });

    copy.addEventListener('click', function () {
      var text = copyText(subj.value, body.value);
      var done = function () { toast('Copied. Paste it where you talk to them, then tap Mark sent.', 'success'); };
      if (win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) {
        win.navigator.clipboard.writeText(text).then(done, function () { toast('Couldn\'t copy — select the text and copy it.', 'error'); });
      } else { toast('Couldn\'t copy — select the text and copy it.', 'error'); }
    });

    markSent.addEventListener('click', function () {
      var ask = win.nbdConfirm || function (m) { return Promise.resolve(win.confirm(m)); };
      Promise.resolve(ask('Mark this as sent? Only do this if you actually sent it yourself.')).then(function (yes) {
        if (!yes) return;
        setBusy(all, true);
        return finish('copied').catch(function (e) { setBusy(all, false); toast('Could not update: ' + ((e && e.message) || 'try again'), 'error'); });
      });
    });

    dismiss.addEventListener('click', function () {
      setBusy(all, true);
      save({ status: 'dismissed', dismissedAt: new Date() })
        .then(function () { card.remove(); onGone(); })
        .catch(function (e) { setBusy(all, false); toast('Could not dismiss: ' + ((e && e.message) || 'try again'), 'error'); });
    });

    card.appendChild(head); card.appendChild(meta); card.appendChild(subj); card.appendChild(body); card.appendChild(warn); card.appendChild(row);
    refresh();
    // The unsubscribe register only matters for the commercial kind.
    if (!data.emailKind && isEmail) {
      isSuppressed(data.to).then(function (yes) { if (yes) { state.suppressed = true; refresh(); } });
    }
    return card;
  }

  function render(leadId, lead) {
    var mine = ++seq;
    var role = claims().role || '';
    var old = doc.getElementById('docDraftsPanel');
    if (old) old.remove();
    if (!leadId || role === 'viewer' || role === 'member') return Promise.resolve(0);
    if (!win.db || !win.getDocs || !win.query || !win.collection || !win.where) return Promise.resolve(0);
    return win.getDocs(win.query(win.collection(win.db, 'leads', leadId, 'doc_drafts'), win.where('status', '==', 'draft')))
      .then(function (snap) {
        if (mine !== seq) return 0;
        var rows = [];
        snap.forEach(function (s) { rows.push({ id: s.id, data: Object.assign({ leadId: leadId }, s.data() || {}) }); });
        if (!rows.length) return 0;
        rows.sort(function (a, b) { return String(a.data.label || '').localeCompare(String(b.data.label || '')); });
        var host = doc.getElementById('overviewTab');
        if (!host) return 0;
        var panel = el('section', { border: '1px solid #d97706', borderRadius: '14px', padding: '12px', margin: '0 0 16px', background: 'var(--s2, rgba(217,119,6,.06))' });
        panel.id = 'docDraftsPanel';
        panel.setAttribute('aria-label', 'Docs to review');
        var title = el('div', { fontWeight: '800', fontSize: '15px' });
        var sub = el('div', { fontSize: '12px', color: 'var(--m, #6b7280)', marginTop: '2px' }, 'Drafted for you. Nothing is sent until you tap Send.');
        function setTitle() {
          var n = panel.querySelectorAll('textarea').length;
          title.textContent = 'Docs to review (' + n + ')';
          if (!n) panel.remove();
        }
        panel.appendChild(title); panel.appendChild(sub);
        rows.forEach(function (r) { panel.appendChild(cardFor(r, lead || win._currentLead || {}, setTitle)); });
        host.insertBefore(panel, host.firstChild);
        setTitle();
        return rows.length;
      }).catch(function (e) {
        if (win.console) win.console.warn('[docDrafts] load failed:', e && (e.code || e.message));
        return 0;
      });
  }

  return { pure: pure, render: render };
});
