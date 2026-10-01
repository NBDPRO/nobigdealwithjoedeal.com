/**
 * winback.js — the Past Customers view (#/winback), lazy 'winback' bundle
 * (2026-10-01).
 *
 * Customers whose last job wrapped up 6+ months ago and who have nothing
 * open now, so the rep can check in, ask for a referral, or remind them about
 * gutter maintenance. Jo's rule: NOTHING goes out automatically — "Reach out"
 * opens a sheet with an editable draft, and the rep taps Text it / Email it.
 * Same send path and result handling as invoice-reminder.js (NBDComms).
 *
 * On a real send the lead records lastWinbackAt / lastWinbackKind /
 * winbackCount, which takes the customer off the list for 90 days.
 *
 * Rules + drafts: winback-logic.js (window.NBDWinbackLogic).
 */
(function () {
  'use strict';
  if (window.NBDWinback && window.NBDWinback.__v === 1) return;

  const LG = () => window.NBDWinbackLogic;
  let _rows = [];
  let _filter = 'all';          // 'all' | 'anniv' | 'two'
  let _loading = false;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, t) => { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); };
  const isViewer = () => !!(window.NBDRole && typeof window.NBDRole.isViewer === 'function' && window.NBDRole.isViewer());
  const KIND_LABEL = { checkin: 'Check-in', referral: 'Referral', maintenance: 'Maintenance' };

  function scroll() { return document.getElementById('winbackScroll') || document.querySelector('#view-winback .view-scroll'); }

  function companyName() {
    try { const b = typeof window._brand === 'function' ? window._brand() : null; if (b && (b.displayName || b.legalName)) return b.displayName || b.legalName; } catch (_) {}
    return 'No Big Deal Home Solutions';
  }
  function repName() {
    const u = window._user || {};
    const s = window._userSettings || {};
    return String(s.displayName || u.displayName || '').trim().split(/\s+/)[0] || '';
  }
  function daysAgo(t) {
    const n = Math.max(0, Math.floor((Date.now() - t) / 86400000));
    return n === 0 ? 'today' : n === 1 ? 'yesterday' : n + 'd ago';
  }

  // ── data ─────────────────────────────────────────────────────────────
  function compute() {
    const L = LG();
    if (!L) { _rows = []; return; }
    const J = window.NBDJobs;
    const jobsReady = !!(J && typeof J.loadedAt === 'function' && J.loadedAt());
    _rows = L.pastCustomers(window._leads || [], jobsReady ? (id) => J.forLead(id) : () => [], new Date(), {
      roleOf: typeof window.stageRole === 'function' ? window.stageRole : null,
      // No isOpen injected: win-back's own "neither won nor lost" rule
      // (winback-logic defaultIsOpen), not jobs-store's paid-in-full one.
    });
  }

  async function ensureJobs() {
    const J = window.NBDJobs;
    if (!J || typeof J.load !== 'function') return;
    if (typeof J.loadedAt === 'function' && J.loadedAt()) return;
    try { await J.load(); } catch (e) { console.warn('[winback] jobs load failed', e && (e.code || e.message)); }
  }

  // ── render ───────────────────────────────────────────────────────────
  function visible() {
    if (_filter === 'anniv') return _rows.filter((r) => r.anniversarySoon);
    if (_filter === 'six') return _rows.filter((r) => r.monthsSince >= 6);
    if (_filter === 'year') return _rows.filter((r) => r.monthsSince >= 12);
    return _rows;
  }

  function filterChip(key, label, n) {
    const on = _filter === key;
    return '<button type="button" class="btn btn-sm ' + (on ? 'btn-orange' : 'btn-ghost') + '" data-wb-action="filter" data-wb-filter="' + key + '" aria-pressed="' + (on ? 'true' : 'false') + '" style="min-height:36px;">' +
      esc(label) + ' <span style="opacity:.75;">(' + n + ')</span></button>';
  }

  function sinceLabel(m) {
    if (m < 12) return m + (m === 1 ? ' month' : ' months') + ' since last job';
    const y = Math.floor(m / 12), r = m % 12;
    return y + (y === 1 ? ' year' : ' years') + (r ? ' ' + r + ' mo' : '') + ' since last job';
  }

  function row(r) {
    const href = '/pro/customer.html?id=' + encodeURIComponent(r.leadId);
    const meta = [esc(sinceLabel(r.monthsSince))];
    if (r.lastJobTitle) meta.push(esc(r.lastJobTitle));
    if (r.jobCount > 1) meta.push(esc(r.jobCount + ' jobs'));
    if (r.lastWinbackAt) meta.push('last reached ' + esc(daysAgo(r.lastWinbackAt)));
    return '<div class="wb-row" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--s2,#1a1d23);border:1px solid var(--br,#2a2e37);border-left:4px solid ' + (r.anniversarySoon ? 'var(--orange,#BD5728)' : 'var(--br,#2a2e37)') + ';border-radius:10px;padding:10px 12px;margin-bottom:8px;">' +
      '<div style="flex:1 1 200px;min-width:0;">' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
          '<a href="' + esc(href) + '" style="font-weight:800;color:var(--t);text-decoration:none;overflow-wrap:anywhere;">' + esc(r.name) + '</a>' +
          (r.anniversarySoon ? '<span style="font-size:11px;font-weight:700;color:var(--orange,#BD5728);border:1px solid var(--orange,#BD5728);border-radius:999px;padding:1px 8px;white-space:nowrap;">🎉 Anniversary soon</span>' : '') +
        '</div>' +
        (r.address ? '<div style="font-size:12px;color:var(--m);overflow-wrap:anywhere;">' + esc(r.address) + '</div>' : '') +
        '<div style="font-size:12px;color:var(--m);margin-top:2px;overflow-wrap:anywhere;">' + meta.join(' · ') + '</div>' +
      '</div>' +
      (isViewer() ? '' : '<button type="button" class="btn btn-orange btn-sm" data-wb-action="reach" data-wb-id="' + esc(r.leadId) + '" style="min-height:44px;flex:0 0 auto;">Reach out</button>') +
    '</div>';
  }

  function render() {
    const el = scroll();
    if (!el) return;
    if (!LG()) { el.innerHTML = '<div style="padding:20px;">Loading…</div>'; return; }
    const list = visible();
    const anniv = _rows.filter((r) => r.anniversarySoon).length;
    const six = _rows.filter((r) => r.monthsSince >= 6).length;
    const year = _rows.filter((r) => r.monthsSince >= 12).length;
    el.innerHTML =
      '<div class="page-hdr" style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:10px;">' +
        '<div style="min-width:0;"><div class="page-title">🤝 Past Customers</div>' +
        '<div class="page-sub">Customers whose last job wrapped up 3+ months ago, with nothing open now. Nothing is sent until you review the message and tap Send.</div></div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:14px 0;">' +
        filterChip('all', 'All', _rows.length) + filterChip('six', '6+ months', six) + filterChip('year', '1+ year', year) + filterChip('anniv', 'Anniversary soon', anniv) +
      '</div>' +
      (_loading ? '<div style="color:var(--m);font-size:13px;margin-bottom:10px;">Loading jobs…</div>' : '') +
      (list.length ? list.map(row).join('')
        : '<div style="background:var(--s2,#1a1d23);border:1px solid var(--br,#2a2e37);border-radius:10px;padding:16px;color:var(--m);font-size:14px;">' +
          (_rows.length ? 'Nobody matches this filter.'
            : 'No past customers to reach out to right now. A customer shows up here once a job is closed out and paid in full, at least 6 months have passed, nothing else is open, there is a phone or email on file, and nobody reached out in the last 90 days.') +
          '</div>');
  }

  function bind(el) {
    if (!el || el._wbBound) return;
    el._wbBound = true;
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest && ev.target.closest('[data-wb-action]');
      if (!b) return;
      const act = b.getAttribute('data-wb-action');
      if (act === 'filter') { _filter = b.getAttribute('data-wb-filter') || 'all'; render(); return; }
      if (act === 'reach') openSheet(b.getAttribute('data-wb-id'));
    });
  }

  async function init() {
    const el = scroll();
    if (!el) return;
    bind(el);
    compute();
    const J = window.NBDJobs;
    const needJobs = !!(J && typeof J.load === 'function' && !(typeof J.loadedAt === 'function' && J.loadedAt()));
    _loading = needJobs;
    render();
    if (needJobs) {
      await ensureJobs();
      _loading = false;
      compute();
      render();
    }
  }

  // ── reach-out sheet ──────────────────────────────────────────────────
  function closeSheet() { const s = document.getElementById('nbdWinbackSheet'); if (s) s.remove(); }

  function openSheet(leadId) {
    if (window.NBDRole && typeof window.NBDRole.guard === 'function' && !window.NBDRole.guard()) return;
    const r = _rows.find((x) => x.leadId === leadId);
    if (!r) { toast('That customer is no longer on the list.', 'info'); return; }
    let kind = 'checkin';
    const draft = (k) => LG().buildWinbackMessage(r, { company: companyName(), repName: repName(), kind: k });
    let msg = draft(kind);

    closeSheet();
    const sheet = document.createElement('div');
    sheet.id = 'nbdWinbackSheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Reach out to a past customer');
    sheet.style.cssText = 'position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;';
    const noPhone = !r.phone, noEmail = !r.email;
    const kindBtn = (k) => '<button type="button" class="btn btn-sm ' + (k === kind ? 'btn-orange' : 'btn-ghost') + '" data-wb-kind="' + k + '" aria-pressed="' + (k === kind ? 'true' : 'false') + '" style="flex:1 1 90px;min-height:40px;">' + esc(KIND_LABEL[k]) + '</button>';
    sheet.innerHTML =
      '<div style="background:var(--s,#12223D);color:var(--t,#fff);border:1px solid var(--br,rgba(255,255,255,.12));border-radius:14px 14px 0 0;width:100%;max-width:560px;max-height:92vh;overflow-y:auto;padding:16px 16px calc(16px + env(safe-area-inset-bottom,0px));box-sizing:border-box;">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;">' +
          '<div style="font-weight:800;font-size:16px;overflow-wrap:anywhere;">Reach out to ' + esc(r.name) + '</div>' +
          '<div style="font-size:12px;color:var(--m,#9ca3af);">' + esc(sinceLabel(r.monthsSince)) + '</div>' +
        '</div>' +
        (r.lastWinbackAt ? '<div style="font-size:12px;margin-top:6px;color:var(--m,#9ca3af);">Last reached ' + esc(daysAgo(r.lastWinbackAt)) + '</div>' : '') +
        '<div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap;" role="group" aria-label="Message type">' +
          LG().KINDS.map(kindBtn).join('') +
        '</div>' +
        '<label for="nbdWinbackText" style="display:block;font-size:12px;color:var(--m,#9ca3af);margin:12px 0 6px;">Message (edit before sending)</label>' +
        '<textarea id="nbdWinbackText" rows="6" style="width:100%;box-sizing:border-box;font:inherit;font-size:15px;line-height:1.4;padding:10px;border-radius:8px;border:1px solid var(--br,rgba(255,255,255,.15));background:var(--s2,rgba(255,255,255,.05));color:var(--t,#fff);">' + esc(msg.text) + '</textarea>' +
        '<div style="font-size:12px;color:var(--m,#9ca3af);margin-top:6px;overflow-wrap:anywhere;">To: ' + esc(r.phone || 'no phone on file') + ' · ' + esc(r.email || 'no email on file') + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">' +
          '<button type="button" class="btn btn-orange" data-wb-send="sms"' + (noPhone ? ' disabled' : '') + ' style="flex:1 1 140px;min-height:44px;">Text it</button>' +
          '<button type="button" class="btn btn-ghost" data-wb-send="email"' + (noEmail ? ' disabled' : '') + ' style="flex:1 1 140px;min-height:44px;">Email it</button>' +
          '<button type="button" class="btn btn-ghost" data-wb-send="cancel" style="flex:0 1 100px;min-height:44px;">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(sheet);
    const ta = document.getElementById('nbdWinbackText');
    if (ta) ta.focus();
    sheet.addEventListener('click', (ev) => {
      if (ev.target === sheet) { closeSheet(); return; }
      const k = ev.target.closest && ev.target.closest('[data-wb-kind]');
      if (k) {
        kind = k.getAttribute('data-wb-kind');
        msg = draft(kind);
        if (ta) ta.value = msg.text;
        sheet.querySelectorAll('[data-wb-kind]').forEach((b) => {
          const on = b.getAttribute('data-wb-kind') === kind;
          b.classList.toggle('btn-orange', on); b.classList.toggle('btn-ghost', !on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        return;
      }
      const b = ev.target.closest && ev.target.closest('[data-wb-send]');
      if (!b || b.disabled) return;
      const act = b.getAttribute('data-wb-send');
      if (act === 'cancel') { closeSheet(); return; }
      send(r, kind, msg.subject, act, (ta && ta.value || '').trim(), sheet);
    });
    sheet.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeSheet(); });
  }

  async function send(r, kind, subject, method, text, sheet) {
    if (window.NBDRole && typeof window.NBDRole.guard === 'function' && !window.NBDRole.guard()) return;
    if (!text) { toast('The message is empty.', 'error'); return; }
    const btns = sheet.querySelectorAll('button');
    Array.prototype.forEach.call(btns, (b) => { b.disabled = true; });
    const C = window.NBDComms;
    let delivered = false, queued = false;
    try {
      if (method === 'sms') {
        if (!C || typeof C.sendSMS !== 'function') throw new Error('Texting is not available here.');
        const s = await C.sendSMS({ to: r.phone, message: text, leadId: r.leadId, source: 'winback', sourceRef: r.leadId });
        if (!s || s.success === false) throw new Error((s && (s.message || s.error)) || 'The text was not sent.');
        queued = s.mode === 'queued'; delivered = !queued;
      } else {
        if (!C || typeof C.sendEmail !== 'function') throw new Error('Email is not available here.');
        const body = LG().emailText(text);
        if (!body) throw new Error('The message is empty.');
        const html = '<p>' + esc(body).replace(/\n/g, '<br>') + '</p>';
        // 'winback' is a COMMERCIAL kind on purpose: the server applies the
        // unsubscribe gate and adds the unsubscribe footer.
        const e = await C.sendEmail({ to: r.email, subject: subject, html: html, leadId: r.leadId, kind: 'winback' });
        if (!e || e.success === false) throw new Error((e && (e.message || e.error)) || 'The email was not sent.');
        // 'mailto' = the rep's own mail app opened; nothing confirms it was sent.
        delivered = e.mode !== 'mailto';
      }
    } catch (err) {
      Array.prototype.forEach.call(btns, (b) => { b.disabled = false; });
      toast((err && err.message) || 'Could not send the message.', 'error');
      return;
    }
    closeSheet();
    if (delivered) {
      const lead = (window._leads || []).find((l) => l && l.id === r.leadId) || null;
      const count = (Number(lead && lead.winbackCount) || 0) + 1;
      const at = new Date();
      try {
        await window.updateDoc(window.doc(window.db, 'leads', r.leadId), {
          lastWinbackAt: at, lastWinbackKind: kind, winbackCount: count,
        });
        if (lead) { lead.lastWinbackAt = at; lead.lastWinbackKind = kind; lead.winbackCount = count; }
      } catch (e2) { console.warn('[winback] could not record the send', e2 && e2.message); }
      toast('Sent by ' + (method === 'sms' ? 'text' : 'email') + '.', 'success');
      compute();
      render();
    } else if (queued) {
      toast('Offline — the text is queued and goes out when you reconnect.', 'info');
    } else {
      toast('Opened in your mail app — send it from there.', 'info');
    }
  }

  // _send is exposed for tests/winback-2026-10-01.test.js (it drives the real
  // send path against a fake NBDComms to prove only a real send is recorded).
  window.NBDWinback = { __v: 1, init, render, open: openSheet, rows: () => _rows.slice(), _send: send };
})();
