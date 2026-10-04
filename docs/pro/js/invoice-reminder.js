/**
 * invoice-reminder.js — one-tap overdue-invoice reminder (2026-10-01, from
 * Jo's idea triage: "invoicing with automatic overdue reminders" — built
 * Jo's way: NOTHING goes to a homeowner without the rep tapping Send).
 *
 * The Money view's Collections queue gets a "Remind" button per overdue
 * invoice. It opens a sheet with the exact message (editable), and the rep
 * picks Text or Email. On a real send the invoice records lastReminderAt +
 * reminderCount, so the queue can show "reminded 3d ago" and nobody nags
 * twice in a morning.
 *
 * Kentucky (KRS 367.626, ky-insurance-law.js payLinkHold): an invoice on a KY
 * insurance job inside the post-decision window is HELD — no payment may be
 * requested yet. The reminder is refused for it, with the release date.
 *
 * Pure half: buildReminder() (exported for tests). Browser half: open().
 */
(function (root) {
  'use strict';

  var MIN_GAP_DAYS = 3; // a second reminder inside this gap asks "again already?"

  function toDate(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v.toDate === 'function') { try { return v.toDate(); } catch (_) { return null; } }
    if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function money(n) {
    var x = Number(n) || 0;
    return '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function firstName(inv, lead) {
    var n = (lead && lead.firstName) || String((inv && inv.customerName) || '').trim().split(/\s+/)[0] || '';
    return n;
  }

  /**
   * PURE. What a reminder for this invoice would say, and whether it may go.
   * opts: { company, repName, now, holdFn(lead, inv, now) -> {held, releaseDate} }
   */
  function buildReminder(inv, lead, opts) {
    inv = inv || {}; opts = opts || {};
    var now = opts.now || new Date();
    var hold = (typeof opts.holdFn === 'function') ? (opts.holdFn(lead || null, inv, now) || {}) : {};
    var balance = (inv.balanceDue != null && inv.balanceDue !== '') ? Number(inv.balanceDue) : Number(inv.total) || 0;
    var due = toDate(inv.dueDate);
    var daysPastDue = due ? Math.floor((now.getTime() - due.getTime()) / 86400000) : 0;
    var num = inv.nbdInvoiceNumber || inv.stripeInvoiceNumber || '';
    var company = opts.company || 'us';
    var who = firstName(inv, lead);
    var link = hold.held ? '' : (inv.stripePaymentLink || '');
    var dueText = due ? due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    var line1 = (who ? 'Hi ' + who + ', ' : 'Hi, ') + 'a friendly reminder from ' + company + ': invoice'
      + (num ? ' ' + num : '') + ' for ' + money(balance) + (dueText ? ' was due ' + dueText : ' is still open') + '.';
    var line2 = link ? 'You can pay here: ' + link : 'Reply here with any questions or to set up payment.';
    var sign = opts.repName ? ' Thanks, ' + opts.repName : ' Thanks!';
    var last = toDate(inv.lastReminderAt);
    return {
      allowed: !hold.held && balance > 0 && inv.status !== 'paid' && inv.status !== 'void',
      held: !!hold.held,
      releaseDate: hold.releaseDate || '',
      balance: balance,
      daysPastDue: daysPastDue,
      number: num,
      to: { phone: String(inv.customerPhone || (lead && lead.phone) || '').trim(), email: String(inv.customerEmail || (lead && lead.email) || '').trim() },
      text: line1 + ' ' + line2 + sign,
      subject: 'Reminder: invoice' + (num ? ' ' + num : '') + ' from ' + company,
      lastReminderAt: last,
      tooSoon: !!(last && (now.getTime() - last.getTime()) < MIN_GAP_DAYS * 86400000),
      reminderCount: Number(inv.reminderCount) || 0,
    };
  }

  // ── Browser half ──────────────────────────────────────────────────────
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg, type) { if (typeof root.showToast === 'function') root.showToast(msg, type || 'info'); }
  function companyName() {
    try { var b = typeof root._brand === 'function' ? root._brand() : null; if (b && (b.displayName || b.legalName)) return b.displayName || b.legalName; } catch (_) {}
    return 'No Big Deal Home Solutions';
  }
  function repName() {
    var u = root._user || {};
    var s = root._userSettings || {};
    return (s.displayName || u.displayName || '').trim().split(/\s+/)[0] || '';
  }
  function daysAgo(d) { var n = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000)); return n === 0 ? 'today' : n === 1 ? 'yesterday' : n + ' days ago'; }

  function close() { var s = document.getElementById('nbdInvReminder'); if (s) s.remove(); }

  async function open(invoiceId) {
    if (root.NBDRole && typeof root.NBDRole.guard === 'function' && !root.NBDRole.guard()) return;
    var snap;
    try { snap = await root.getDoc(root.doc(root.db, 'invoices', invoiceId)); }
    catch (e) { toast('Could not load that invoice — try again.', 'error'); return; }
    if (!snap || !snap.exists()) { toast('Invoice not found.', 'error'); return; }
    var inv = Object.assign({ id: invoiceId }, snap.data());
    // FAIL CLOSED (ky-insurance-law.js): the Kentucky hold is decided from
    // the LEAD. root._leads drops soft-deleted leads (and may not hold this
    // one yet), so a miss there reads the lead doc; a lead that still cannot
    // be read — or a jurisdiction module that did not load — refuses the
    // reminder rather than send a payment request on what may be a KY
    // insurance job inside its window (2026-10-03; was: no lead → not held).
    var lead = null;
    if (inv.leadId) {
      lead = (root._leads || []).find(function (l) { return l && l.id === inv.leadId; }) || null;
      if (!lead) {
        try {
          var ls = await root.getDoc(root.doc(root.db, 'leads', String(inv.leadId)));
          lead = (ls && ls.exists()) ? Object.assign({ id: String(inv.leadId) }, ls.data() || {}) : null;
        } catch (_) { lead = null; }
        if (!lead) { toast('Could not read this invoice\'s customer record, so the Kentucky payment rules can\'t be checked — no reminder sent.', 'error'); return; }
      }
    }
    var J = root.NBDJurisdiction;
    if (!J || typeof J.payLinkHold !== 'function') { toast('The Kentucky payment rules did not load — reload and try again.', 'error'); return; }
    // The tenant's time zone, as the server's payment-link check uses it
    // (functions/stripe.js: KyLaw.resolveTimeZone(companyProfile)).
    var tz;
    try { tz = J.resolveTimeZone(typeof root._legal === 'function' ? root._legal() : (root._companyProfile || {})); } catch (_) { tz = undefined; }
    var r = buildReminder(inv, lead, {
      company: companyName(), repName: repName(), now: new Date(),
      holdFn: function (l, i, n) { return J.payLinkHold(l, i, n, tz); },
    });
    if (r.held) { toast('Kentucky insurance job — no payment requests until ' + (r.releaseDate || 'the cancellation window ends') + '.', 'error'); return; }
    if (!r.allowed) { toast('Nothing to remind about — this invoice has no balance due.', 'info'); return; }

    close();
    var sheet = document.createElement('div');
    sheet.id = 'nbdInvReminder';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Send a payment reminder');
    sheet.style.cssText = 'position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;';
    var noPhone = !r.to.phone, noEmail = !r.to.email;
    sheet.innerHTML =
      '<div style="background:var(--s,#12223D);color:var(--t,#fff);border:1px solid var(--br,rgba(255,255,255,.12));border-radius:14px 14px 0 0;width:100%;max-width:560px;padding:16px 16px calc(16px + env(safe-area-inset-bottom,0px));box-sizing:border-box;">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;">' +
          '<div style="font-weight:800;font-size:16px;">Payment reminder</div>' +
          '<div style="font-size:12px;color:var(--m,#9ca3af);">' + esc(money(r.balance)) + ' · ' + esc(String(r.daysPastDue)) + 'd overdue</div>' +
        '</div>' +
        (r.lastReminderAt ? '<div style="font-size:12px;margin-top:6px;color:' + (r.tooSoon ? 'var(--gold,#eab308)' : 'var(--m,#9ca3af)') + ';">Last reminded ' + esc(daysAgo(r.lastReminderAt)) + (r.reminderCount > 1 ? ' (' + r.reminderCount + ' so far)' : '') + (r.tooSoon ? ' — maybe give it a few more days.' : '') + '</div>' : '') +
        '<label for="nbdInvReminderText" style="display:block;font-size:12px;color:var(--m,#9ca3af);margin:12px 0 6px;">Message (edit before sending)</label>' +
        '<textarea id="nbdInvReminderText" rows="5" style="width:100%;box-sizing:border-box;font:inherit;font-size:15px;line-height:1.4;padding:10px;border-radius:8px;border:1px solid var(--br,rgba(255,255,255,.15));background:var(--s2,rgba(255,255,255,.05));color:var(--t,#fff);">' + esc(r.text) + '</textarea>' +
        '<div style="font-size:12px;color:var(--m,#9ca3af);margin-top:6px;">To: ' + esc(r.to.phone || 'no phone on file') + ' · ' + esc(r.to.email || 'no email on file') + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">' +
          '<button type="button" class="btn btn-orange" data-inv-rem="sms"' + (noPhone ? ' disabled' : '') + ' style="flex:1 1 140px;min-height:44px;">Text it</button>' +
          '<button type="button" class="btn btn-ghost" data-inv-rem="email"' + (noEmail ? ' disabled' : '') + ' style="flex:1 1 140px;min-height:44px;">Email it</button>' +
          '<button type="button" class="btn btn-ghost" data-inv-rem="cancel" style="flex:0 1 100px;min-height:44px;">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(sheet);
    var ta = document.getElementById('nbdInvReminderText');
    if (ta) ta.focus();
    sheet.addEventListener('click', function (ev) {
      if (ev.target === sheet) { close(); return; }
      var b = ev.target.closest && ev.target.closest('[data-inv-rem]');
      if (!b || b.disabled) return;
      var act = b.getAttribute('data-inv-rem');
      if (act === 'cancel') { close(); return; }
      send(inv, r, act, (ta && ta.value || '').trim(), sheet);
    });
    sheet.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') close(); });
  }

  async function send(inv, r, method, text, sheet) {
    if (!text) { toast('The message is empty.', 'error'); return; }
    var btns = sheet.querySelectorAll('button');
    Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
    var C = root.NBDComms;
    var delivered = false, queued = false;
    try {
      if (method === 'sms') {
        if (!C || typeof C.sendSMS !== 'function') throw new Error('Texting is not available here.');
        var s = await C.sendSMS({ to: r.to.phone, message: text, leadId: inv.leadId || null, source: 'invoice_reminder', sourceRef: inv.id });
        if (!s || s.success === false) throw new Error((s && (s.message || s.error)) || 'The text was not sent.');
        queued = s.mode === 'queued'; delivered = !queued;
      } else {
        if (!C || typeof C.sendEmail !== 'function') throw new Error('Email is not available here.');
        var html = '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>';
        var e = await C.sendEmail({ to: r.to.email, subject: r.subject, html: html, leadId: inv.leadId || null, invoiceId: inv.id || null, kind: 'invoice' });
        if (!e || e.success === false) throw new Error((e && (e.message || e.error)) || 'The email was not sent.');
        // 'mailto' = the rep's own mail app opened; nothing confirms it was sent.
        delivered = e.mode !== 'mailto';
      }
    } catch (err) {
      Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
      toast((err && err.message) || 'Could not send the reminder.', 'error');
      return;
    }
    close();
    if (delivered) {
      try {
        await root.updateDoc(root.doc(root.db, 'invoices', inv.id), {
          lastReminderAt: new Date(), lastReminderMethod: method, reminderCount: (Number(inv.reminderCount) || 0) + 1, updatedAt: new Date(),
        });
      } catch (e2) { console.warn('[invoice-reminder] could not record the reminder', e2 && e2.message); }
      toast('Reminder sent by ' + (method === 'sms' ? 'text' : 'email') + '.', 'success');
    } else if (queued) {
      toast('Offline — the text is queued and goes out when you reconnect.', 'info');
    } else {
      toast('Opened in your mail app — send it from there.', 'info');
    }
    if (root.MoneyDashboard && typeof root.MoneyDashboard.refresh === 'function') root.MoneyDashboard.refresh();
  }

  var api = { buildReminder: buildReminder, open: open, MIN_GAP_DAYS: MIN_GAP_DAYS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.NBDInvoiceReminder = api;
})(typeof window !== 'undefined' ? window : this);
