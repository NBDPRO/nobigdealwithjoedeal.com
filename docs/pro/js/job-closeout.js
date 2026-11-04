/* ══════════════════════════════════════════════════════════════════════
   job-closeout.js — the finished-job roll-up on customer.html (2026-10-22).

   Five things that must be true before a job is really closed out, read from
   data the page already has (no new fields, no writes):
     photos   — at least one After-phase photo
     invoice  — a final invoice exists (anything not draft / void / cancelled)
     paid     — paid in full (ReviewEngine.paidInFullFor: the one shared rule,
                so this card, the review ask and the referral credit agree)
     warranty — the certificate is filed (lead.warrantyCertFiledAt)
     review   — a review was asked (lead.reviewRequested)

   Pure part: evaluate(). Browser part: render(), called from
   customer-checklist.js. Shows only once the job is installed or finished.
   ══════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var NOT_FINAL = { draft: 1, void: 1, voided: 1, cancelled: 1, canceled: 1 };
  var FINISHED = { install_complete: 1, final_photos: 1, deductible_collected: 1, final_payment: 1, closed: 1, warranty_claim: 1, collections: 1 };
  var ALIAS = { complete: 'closed', 'closed won': 'closed', closed_won: 'closed', 'closed-won': 'closed', won: 'closed' };

  function stageKey(lead) {
    var raw = String((lead && (lead._stageKey || lead.stage)) || '').trim().toLowerCase();
    return ALIAS[raw] || raw.replace(/\s+/g, '_');
  }
  // Installed or later. A tenant's custom won stage counts through stageRole.
  function isFinishedJob(lead) {
    if (!lead || lead.deleted === true) return false;
    return !!FINISHED[stageKey(lead)] || lead.stageRole === 'won';
  }

  /**
   * ctx: { photos: array|null, invoices: array|null, paidInFull: boolean }
   * null photos / invoices = not loaded yet: the row is "unknown", never "done".
   */
  function evaluate(lead, ctx) {
    ctx = ctx || {};
    lead = lead || {};
    var photos = Array.isArray(ctx.photos) ? ctx.photos : null;
    var invoices = Array.isArray(ctx.invoices) ? ctx.invoices : null;
    function row(key, label, state, hint) { return { key: key, label: label, state: state, hint: hint }; }

    var afterCount = photos ? photos.filter(function (p) { return p && String(p.phase || '').toLowerCase() === 'after'; }).length : 0;
    var finalInv = invoices ? invoices.filter(function (i) { return i && i.deleted !== true && !NOT_FINAL[String(i.status || '').toLowerCase()]; }).length : 0;

    var rows = [
      row('photos', 'After photos', photos === null ? 'unknown' : (afterCount > 0 ? 'done' : 'todo'), 'Upload the After set'),
      row('invoice', 'Final invoice sent', invoices === null ? 'unknown' : (finalInv > 0 ? 'done' : 'todo'), 'Create and send the final invoice'),
      row('paid', 'Balance collected', invoices === null ? 'unknown' : (ctx.paidInFull === true ? 'done' : 'todo'), 'Record the final payment'),
      row('warranty', 'Warranty certificate filed', lead.warrantyCertFiledAt ? 'done' : 'todo', 'Generate the warranty certificate'),
      row('review', 'Review asked', (lead.reviewRequested === true || lead.reviewRequestedAt) ? 'done' : 'todo', 'Send the review ask once paid in full')
    ];
    var done = rows.filter(function (r) { return r.state === 'done'; }).length;
    return { rows: rows, done: done, total: rows.length, complete: done === rows.length, next: rows.filter(function (r) { return r.state === 'todo'; })[0] || null };
  }

  // The rep prompt shown while the warranty row is open. Credentials are the
  // two NBD holds (Jo, 2026-10-14 / brief 2026-10-22). Add a name here only
  // after Jo confirms the credential; tests/job-closeout-2026-10-22.test.js
  // pins the list and bans the ones NBD does not hold.
  var CREDENTIALS = ['GAF Certified #1162011', 'TAMKO Pro Gold #181382'];
  var WARRANTY_PROMPT = {
    title: 'Register the warranty',
    steps: [
      'File the warranty certificate for this job (Documents tab).',
      'If this job bought a GAF or TAMKO system warranty, register it with that manufacturer under NBD’s ' + CREDENTIALS.join(' / ') + ' account. For any other brand, follow that manufacturer’s own registration.',
      'Registration is done by you in the manufacturer’s portal; nothing is filed or sent for you.'
    ]
  };

  var api = { evaluate: evaluate, isFinishedJob: isFinishedJob, CREDENTIALS: CREDENTIALS, WARRANTY_PROMPT: WARRANTY_PROMPT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root) return;
  root.JobCloseout = api;

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };

  function draftHtml(d) {
    function box(id, label, text) {
      return '<label class="jco-lbl" for="' + id + '">' + esc(label) + '</label>' +
        '<textarea id="' + id + '" class="jco-ta" readonly rows="5">' + esc(text) + '</textarea>' +
        '<button type="button" class="jco-btn" data-jco-copy="' + id + '">Copy ' + esc(label.toLowerCase()) + '</button>';
    }
    var h = '<div class="jco-draft" role="group" aria-label="Draft ' + esc(d.kind) + ' ask (not sent)">';
    if (d.email) h += box('jcoEmail', 'Email', 'Subject: ' + d.email.subject + '\n\n' + d.email.body);
    if (d.text) h += box('jcoText', 'Text', d.text);
    h += d.notes.map(function (n) { return '<p class="jco-note">' + esc(n) + '</p>'; }).join('') + '</div>';
    return h;
  }

  // One delegated listener per panel element (CSP: no inline handlers).
  function bind(panel) {
    if (panel.__jcoBound) return;
    panel.__jcoBound = true;
    panel.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('[data-jco-draft],[data-jco-copy]') : null;
      if (!t) return;
      if (t.hasAttribute('data-jco-copy')) {
        var ta = root.document.getElementById(t.getAttribute('data-jco-copy'));
        if (!ta) return;
        try { ta.select(); } catch (e) {}
        try {
          if (root.navigator && root.navigator.clipboard) root.navigator.clipboard.writeText(ta.value);
          else root.document.execCommand('copy');
          if (typeof root.showToast === 'function') root.showToast('Copied. Nothing was sent.', 'success');
        } catch (e) { /* the text is selected: the rep can copy by hand */ }
        return;
      }
      buildDraft(t.getAttribute('data-jco-draft'));
    });
  }

  async function buildDraft(kind) {
    var lead = root._currentLead || {};
    var RE = root.ReviewEngine, PD = root.PostJobDrafts, panel = root.document.getElementById('closeoutPanel');
    if (!RE || !PD || !panel) return;
    var link = '';
    try {
      link = kind === 'review' ? await RE.getReviewLink() : await RE.referralLinkFor(lead.id);
    } catch (e) { link = ''; }
    var p = root._companyProfile;
    var d = PD.build(kind, lead, { link: link, company: p && (p.companyName || p.name) });
    if (!d) { if (typeof root.showToast === 'function') root.showToast('No link set up yet for this draft', 'error'); return; }
    panel.__jcoDraft = { lead: lead.id, draft: d };
    api.render(lead);
  }

  api.render = function (lead, opts) {
    var doc = root.document;
    var panel = doc && doc.getElementById('closeoutPanel');
    if (!panel) return;
    lead = lead || root._currentLead || {};
    if (!isFinishedJob(lead)) { panel.hidden = true; panel.innerHTML = ''; return; }
    var RE = root.ReviewEngine;
    var inv = null;
    try {
      var cached = root.NBDRevenue && typeof root.NBDRevenue.cached === 'function' ? root.NBDRevenue.cached() : null;
      if (Array.isArray(cached)) inv = cached.filter(function (i) { return i && i.leadId === lead.id && i.deleted !== true; });
    } catch (e) { inv = null; }
    var paid = false;
    try { paid = !!(RE && typeof RE.paidInFullFor === 'function' && RE.paidInFullFor(lead, inv === null ? undefined : inv)); } catch (e) { paid = false; }
    var res = evaluate(lead, { photos: Array.isArray(root._customerPhotos) && (root._customerPhotos.length || (opts && opts.photosLoaded)) ? root._customerPhotos : null, invoices: inv, paidInFull: paid });

    var rows = res.rows.map(function (r) {
      var mark = r.state === 'done' ? '✓' : (r.state === 'unknown' ? '…' : '○');
      var tail = r.state === 'todo' ? ' <span class="jco-hint">— ' + esc(r.hint) + '</span>' : '';
      return '<div class="jco-row' + (r.state === 'done' ? ' jco-done' : '') + '"><span class="jco-mark" aria-hidden="true">' + mark + '</span><span><span class="jco-sr">' + (r.state === 'done' ? 'Done: ' : (r.state === 'unknown' ? 'Loading: ' : 'To do: ')) + '</span>' + esc(r.label) + tail + '</span></div>';
    }).join('');
    var prompt = '';
    if (res.rows.filter(function (r) { return r.key === 'warranty' && r.state === 'todo'; }).length) {
      prompt = '<div class="jco-prompt" role="note"><strong>' + esc(WARRANTY_PROMPT.title) + '</strong><ol>' +
        WARRANTY_PROMPT.steps.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ol></div>';
    }
    // Drafts (post-job-drafts-logic.js): shown, never sent.
    var drafts = '';
    var PD = root.PostJobDrafts;
    if (PD) {
      var mo = PD.moments(lead, { paidInFull: paid });
      var btn = function (kind, label) {
        return '<button type="button" class="jco-btn" data-jco-draft="' + kind + '">' + esc(label) + '</button>';
      };
      var btns = (mo.review ? btn('review', 'Draft review ask') : '') + (mo.referral ? btn('referral', 'Draft referral ask') : '');
      if (btns) drafts += '<div class="jco-drafts">' + btns + '</div>';
      var open = panel.__jcoDraft;
      if (open && open.lead === lead.id && open.draft) drafts += draftHtml(open.draft);
    }
    panel.innerHTML =
      '<div class="jco-head"><div class="panel-title">Finished-job check</div>' +
        '<span class="jco-count">' + (res.complete ? 'All done' : res.done + ' of ' + res.total) + '</span></div>' + rows + prompt + drafts;
    bind(panel);
    panel.hidden = false;
  };
})(typeof window !== 'undefined' ? window : null);
