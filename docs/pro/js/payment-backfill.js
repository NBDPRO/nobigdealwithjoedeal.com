/**
 * payment-backfill.js — Customer payment backfill (flag `paymentBackfill`, 2026-10-19).
 *
 * Jo has checks, Zelle and cash from customers that never reached the CRM, so
 * finished jobs, collected revenue and job profit are all wrong. This is the
 * owner-only screen that fixes it, a row at a time:
 *
 *   1. PASTE (CSV / TSV, with or without a header) or TYPE ONE row: payer,
 *      address, optional phone, payment date, amount, method (check | cash |
 *      zelle | other), check / reference no., memo, optional job type, optional
 *      source.
 *   2. REVIEW: each row is "new customer", "matches existing customer X
 *      (confirm)", "possible duplicate payment", "already imported", or has
 *      errors. A customer is NEVER merged for you: you tap "same customer" or
 *      "different". A re-paste flags what is already there.
 *   3. ONE TAP per row CREATES the customer (like the Add Lead form: finished,
 *      source Other and still unconfirmed for the Lead Source Fixer), the job
 *      (the lead IS the job record; the server mirror makes jobs/j1), and the
 *      payment on the path the CRM already uses (a minimal paid invoice, then
 *      InvoicePipeline.markPaid), so collected revenue, job profit, the Money
 *      dashboard and the agent tools count it. Undo is one tap; a later void
 *      needs a note. Nothing is hard-deleted.
 *   4. PHOTOS: 1+ photos or PDFs of the check / Zelle screenshot / deposit slip per
 *      payment (the shared proof-photos.js: EXIF stripped, private Storage rules,
 *      paths only). Drop several files at once and assign each to a row.
 *   5. CHECK VS CRM: paste rows and see which payments are already in the CRM,
 *      creating nothing.
 *
 * SAFETY: a backfilled customer is created quiet (completedBackfill +
 * paymentBackfill, which every after-install automation honours:
 * functions/quiet-backfill.js) and its invoice is source 'backfill', which
 * money-paper.js leaves alone. Nothing here sends a text or an email, and no code
 * here calls a messaging function. This file never reads or prints the pixels of
 * a check (the MICR line carries routing and account numbers).
 *
 * Money is cents until the invoice edge (the ledger keeps dollars). Flag off =
 * no button, nothing runs. Owner / company admin / solo operator only.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = window;
  const FLAG = 'paymentBackfill';
  const LG = () => w.NBDPaymentBackfillLogic;
  const PP = () => w.NBDProofPhotos;
  const IP = () => w.InvoicePipeline;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + ((Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toast = (m, k) => { if (typeof w.showToast === 'function') w.showToast(m, k || 'info'); };
  const METHOD_LABEL = { check: 'Check', cash: 'Cash', zelle: 'Zelle', other: 'Other' };
  const JT_LABEL = { insurance: 'Insurance', cash: 'Cash', finance: 'Finance', warranty: 'Warranty', service: 'Service' };

  function enabled() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)) && !!LG(); }
  function claims() { return w._userClaims || {}; }
  function uid() { return (w._user && w._user.uid) || null; }
  function tenant() { return claims().companyId || uid(); }
  // Owner / company admin / platform admin; a solo operator (no role, own uid) is the owner.
  function isOwner() {
    const c = claims(), role = c.role || '';
    if (role === 'admin' || role === 'company_admin') return !!uid();
    if (role) return false;
    return !!uid() && (!c.companyId || c.companyId === uid());
  }
  function on() { return enabled() && isOwner(); }

  let S = null;
  // { view:'entry'|'review'|'check', text, rows[], ch{n:{pick,jobType,override}}, files[{id,file}], assign{fileId:n}, done{n:{...}},
  //   busy{n}, leads, invoices, invoicesOk, check[], err, typed{} , urls{} }
  let fileSeq = 0;

  function leads() { return (w._leads || []).filter((l) => l && l.id); }
  async function loadInvoices() {
    const R = w.NBDRevenue;
    if (!R || typeof R.loadInvoices !== 'function') return { ok: false, list: [] };
    const list = await R.loadInvoices();
    // [] with no cache = "could not ask yet / the read failed", NOT "no payments".
    if (typeof R.cached === 'function' && !R.cached()) return { ok: false, list: [] };
    return { ok: true, list: list || [] };
  }

  // ── open / close ────────────────────────────────────────────────────────
  async function open() {
    if (!on()) return;
    if (!PP()) { toast('The photo helper did not load. Reload the page and try again.', 'error'); return; }
    S = { view: 'entry', text: '', rows: [], ch: {}, files: [], assign: {}, done: {}, busy: {}, leads: leads(), invoices: [], invoicesOk: false, check: [], err: '', typed: { method: '' }, urls: {} };
    render();
  }
  function close() {
    const m = document.getElementById('pbOverlay'); if (m) m.remove();
    if (S) Object.keys(S.urls).forEach((k) => { try { URL.revokeObjectURL(S.urls[k]); } catch (e) { /* nothing to free */ } });
    const changed = S && Object.keys(S.done).length;
    S = null;
    if (changed) {
      if (typeof w.loadLeads === 'function') { try { w.loadLeads(); } catch (e) { /* the board refreshes on its own */ } }
      if (w.Expenses && typeof w.Expenses.refresh === 'function') w.Expenses.refresh();
    }
  }

  // ── review ──────────────────────────────────────────────────────────────
  async function runReview(mode) {
    const text = (document.getElementById('pbText') || {}).value;
    if (text != null) S.text = text;
    const parsed = LG().parse(S.text, new Date());
    if (parsed.error) { S.err = parsed.error; render(); return; }
    S.err = '';
    const inv = await loadInvoices();
    S.invoices = inv.list; S.invoicesOk = inv.ok;
    S.leads = leads();
    if (mode === 'check') {
      if (!inv.ok) { S.err = 'The invoices did not load, so nothing can be compared. Nothing was changed. Try again in a moment.'; render(); return; }
      S.check = LG().checkAgainstCrm(parsed.rows, S.leads, S.invoices);
      S.truncated = !!parsed.truncated;
      S.view = 'check'; render(); return;
    }
    S.rows = LG().review(parsed.rows, S.leads, S.invoices);
    S.truncated = !!parsed.truncated;
    // Keep the owner's earlier answers for rows whose payment is unchanged.
    const keep = {};
    Object.keys(S.ch).forEach((n) => { keep[n] = S.ch[n]; });
    S.ch = {};
    S.rows.forEach((r) => { S.ch[r.n] = keep[r.n] || { pick: '', jobType: r.v && r.v.jobType || '', override: false }; });
    S.view = 'review';
    if (!inv.ok) toast('The invoices did not load, so duplicate payments in the CRM cannot be checked. Review carefully.', 'warn');
    render();
  }

  // The rows' statuses after the CRM changed (an undo): same inputs, fresh look at the invoices.
  function rereview() {
    const again = S.rows.map((r) => LG().validate({ n: r.n, input: r.input }, new Date()));
    S.rows = LG().review(again, S.leads, S.invoices);
  }

  // ── pieces ──────────────────────────────────────────────────────────────
  const rowOf = (n) => S.rows.find((r) => r.n === n);
  const chOf = (n) => S.ch[n] || (S.ch[n] = { pick: '', jobType: '', override: false });
  const filesOf = (n) => S.files.filter((f) => S.assign[f.id] === n);
  function urlOf(f) { return S.urls[f.id] || (S.urls[f.id] = (typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(f.file) : '')); }

  function trayHtml() {
    const opts = (cur) => '<option value="0">Assign to row…</option>' + S.rows.filter((r) => !r.errors.length).map((r) => '<option value="' + r.n + '"' + (cur === r.n ? ' selected' : '') + '>Row ' + r.n + ': ' + esc(r.v.name) + ' ' + esc(money(r.v.cents)) + '</option>').join('');
    let h = '<div class="sp-lab">Photos of the checks (drop several files here, or tap)</div>' +
      '<div class="pb-drop" id="pbDrop"><button type="button" class="sp-btn sp-wide" data-pb-action="add-files">📷 Add photos or PDFs</button><div class="sp-sub">Check images, Zelle screenshots, deposit slips. Photos are stored privately; nothing is read from them.</div></div>';
    if (S.files.length) {
      h += '<ul class="pb-tray">' + S.files.map((f) => '<li class="pb-file">' +
        (/^image\//.test(f.file.type) ? '<img class="pb-prev" alt="" src="' + esc(urlOf(f)) + '">' : '<span class="pb-prev pb-prevpdf">PDF</span>') +
        '<select class="sp-in" data-pb-f="as-' + f.id + '" aria-label="Assign photo to a row">' + opts(S.assign[f.id] || 0) + '</select>' +
        '<button type="button" class="sp-btn sp-sm" data-pb-action="drop-file" data-pb-file="' + f.id + '">Remove</button></li>').join('') + '</ul>';
    }
    return h;
  }

  function statusChip(r) {
    const cls = { error: 'sp-flag', already: 'sp-tag', dup: 'sp-flag', match: 'sp-flag', 'new': 'sp-ok' }[r.status] || 'sp-tag';
    return '<span class="' + cls + '">' + esc(LG().STATUS_LABEL[r.status] || r.status) + '</span>';
  }

  function matchHtml(r) {
    const ch = chOf(r.n);
    const btn = (action, extra, label, pressed) => '<button type="button" class="sp-chip pb-pick" data-pb-action="' + action + '" data-pb-n="' + r.n + '"' + extra + ' aria-pressed="' + pressed + '">' + label + '</button>';
    let h = '<div class="sp-sub">This looks like an existing customer. Confirm: nothing is merged for you.</div><div class="sp-chips" role="group" aria-label="Which customer">';
    r.matches.forEach((m) => { h += btn('pick', ' data-pb-lead="' + esc(m.leadId) + '"', 'Same: ' + esc(m.name) + (m.address ? ' · ' + esc(m.address) : '') + ' <i>(' + esc(m.reasons.join(', ')) + ')</i>', ch.pick === m.leadId); });
    h += btn('pick-new', '', 'Different customer: create new', ch.pick === 'new') + '</div>';
    return h;
  }
  function dupHtml(r) {
    const ch = chOf(r.n);
    const hits = (r.dup.hits || []).map((p) => '<li>' + esc(money(p.cents)) + ' on ' + esc(p.ymd) + ' · ' + esc(METHOD_LABEL[p.method] || p.method || 'payment') + (p.ref ? ' #' + esc(p.ref) : '') + (p.name ? ' · ' + esc(p.name) : '') + '</li>').join('');
    return '<div class="sp-warn" role="status">' + (r.dup.inPaste ? 'The same payment appears earlier in this paste.' : 'A payment with this amount, close to this date, is already in the CRM:') +
      (hits ? '<ul class="pb-hits">' + hits + '</ul>' : '') +
      '<button type="button" class="sp-chip pb-pick" data-pb-action="override" data-pb-n="' + r.n + '" aria-pressed="' + !!ch.override + '">It is a different payment: create it anyway</button></div>';
  }

  function rowHtml(r) {
    const v = r.v, ch = chOf(r.n), done = S.done[r.n], files = filesOf(r.n);
    let h = '<article class="sp-card pb-row" data-pb-row="' + r.n + '"><div class="sp-card-top"><b class="sp-payee">' + esc(v.name || '(no name)') + '</b><b>' + (v.cents ? money(v.cents) : '') + '</b></div>' +
      '<div class="sp-card-sub">Row ' + r.n + ' · ' + esc(v.ymd || 'no date') + ' · ' + esc(METHOD_LABEL[v.method] || '?') + (v.ref ? ' #' + esc(v.ref) : '') + '</div>' +
      '<div class="sp-card-sub">' + esc(v.address || '(no address)') + (v.phone ? ' · ' + esc(v.phone) : '') + '</div>' +
      (v.memo ? '<div class="sp-note">' + esc(v.memo) + '</div>' : '') + '<div>' + statusChip(r) + '</div>';
    if (r.errors.length) return h + '<ul class="pb-errs">' + r.errors.map((e) => '<li class="sp-err">' + esc(e) + '</li>').join('') + '</ul></article>';
    if (done) {
      h += '<div class="sp-card-sub"><span class="sp-ok">Created ✓</span> ' + (done.createdLead ? 'New customer and job.' : 'Added to the existing customer.') + (done.proofsFailed ? ' <span class="sp-flag">The photos did not upload: add them from the job.</span>' : '') + '</div>' +
        (done.proofs && done.proofs.length ? PP().thumbsHtml(done.proofs.map((p) => p.path)) : '') +
        '<div class="sp-act"><button type="button" class="sp-btn" data-pb-action="undo" data-pb-n="' + r.n + '">Undo</button>' +
        '<button type="button" class="sp-btn" data-pb-action="job-money" data-pb-lead="' + esc(done.leadId) + '">Open job money</button></div></article>';
      return h;
    }
    if (r.status === 'already') return h + '<div class="sp-card-sub">This exact payment is already in the CRM. Nothing to do.</div></article>';
    if (r.status === 'match') h += matchHtml(r);
    if (r.status === 'dup') h += dupHtml(r) + (r.matches.length ? matchHtml(r) : '');
    const creatingNew = r.status === 'new' || ch.pick === 'new' || (r.status === 'dup' && !ch.pick);
    if (creatingNew || !ch.pick) {
      h += '<label class="sp-lab" for="pbJt' + r.n + '">Job type (pick one, like the Add Lead form)</label><select id="pbJt' + r.n + '" class="sp-in" data-pb-f="jt-' + r.n + '"><option value="">Pick a job type</option>' +
        LG().JOB_TYPES.map((t) => '<option value="' + t + '"' + (ch.jobType === t ? ' selected' : '') + '>' + JT_LABEL[t] + '</option>').join('') + '</select>';
    }
    if (files.length) h += '<div class="sp-card-sub">' + files.length + ' photo' + (files.length === 1 ? '' : 's') + ' will be attached.</div>';
    const busy = !!S.busy[r.n];
    h += '<div class="sp-act"><button type="button" class="sp-btn sp-primary" data-pb-action="create" data-pb-n="' + r.n + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Creating…' : 'Create customer, job and payment') + '</button>' +
      '<button type="button" class="sp-btn" data-pb-action="row-photo" data-pb-n="' + r.n + '">Add photo</button></div><div class="sp-err" data-pb-err="' + r.n + '" role="alert"></div></article>';
    return h;
  }

  function counts() {
    const c = { error: 0, already: 0, dup: 0, match: 0, 'new': 0, done: Object.keys(S.done).length };
    S.rows.forEach((r) => { c[r.status]++; });
    return c;
  }

  function entryHtml() {
    const T = S.typed;
    return '<div class="sp-head"><h3 class="sp-title">Backfill customer payments</h3><button type="button" class="sp-x" data-pb-action="close" aria-label="Close">✕</button></div>' +
      '<p class="sp-lede">Paste the checks, Zelle and cash you were paid, one payment per row. Nothing is created until you tap a row.</p>' +
      '<div class="sp-sub">Columns, in order (or use a header row): payer, address, phone (optional), date, amount, method (check, cash, Zelle, other), check no., memo, job type (optional), source (optional).</div>' +
      '<label class="sp-lab" for="pbText">Paste rows (CSV or tab-separated)</label>' +
      '<textarea id="pbText" class="sp-in sp-ta pb-ta" rows="8" spellcheck="false" autocomplete="off" data-pb-f="text">' + esc(S.text) + '</textarea>' +
      (S.err ? '<div class="sp-err" role="alert">' + esc(S.err) + '</div>' : '') +
      '<div class="sp-act"><button type="button" class="sp-btn sp-primary" data-pb-action="review">Review rows</button>' +
      '<button type="button" class="sp-btn" data-pb-action="check">Check vs CRM (changes nothing)</button>' +
      '<button type="button" class="sp-btn" data-pb-action="clear">Clear</button></div>' +
      '<details class="pb-one"><summary class="sp-btn">Or type one payment</summary><div class="sp-sheetbox">' +
      '<label class="sp-lab" for="pbTPayer">Payer name</label><input id="pbTPayer" class="sp-in" autocomplete="off" data-pb-f="t-payer" value="' + esc(T.payer || '') + '">' +
      '<label class="sp-lab" for="pbTAddr">Address</label><input id="pbTAddr" class="sp-in" autocomplete="off" data-pb-f="t-address" value="' + esc(T.address || '') + '">' +
      '<label class="sp-lab" for="pbTPhone">Phone (optional)</label><input id="pbTPhone" class="sp-in" type="tel" autocomplete="off" data-pb-f="t-phone" value="' + esc(T.phone || '') + '">' +
      '<label class="sp-lab" for="pbTDate">Payment date</label><input id="pbTDate" class="sp-in" type="date" data-pb-f="t-date" value="' + esc(T.date || '') + '">' +
      '<label class="sp-lab" for="pbTAmt">Amount</label><input id="pbTAmt" class="sp-in sp-big" inputmode="decimal" autocomplete="off" placeholder="0.00" data-pb-f="t-amount" value="' + esc(T.amount || '') + '">' +
      '<div class="sp-lab">Method</div><div class="sp-methods" role="radiogroup" aria-label="Payment method">' + LG().METHODS.map((m) => '<label class="sp-method"><input type="radio" name="pbMethod" value="' + m + '"' + (T.method === m ? ' checked' : '') + ' data-pb-f="t-method"><span>' + METHOD_LABEL[m] + '</span></label>').join('') + '</div>' +
      '<label class="sp-lab" for="pbTRef">Check / reference no. (optional)</label><input id="pbTRef" class="sp-in" autocomplete="off" data-pb-f="t-ref" value="' + esc(T.ref || '') + '">' +
      '<label class="sp-lab" for="pbTMemo">Memo (optional)</label><input id="pbTMemo" class="sp-in" autocomplete="off" data-pb-f="t-memo" value="' + esc(T.memo || '') + '">' +
      '<label class="sp-lab" for="pbTJt">Job type (optional)</label><select id="pbTJt" class="sp-in" data-pb-f="t-jobType"><option value="">Pick later</option>' + LG().JOB_TYPES.map((t) => '<option value="' + t + '"' + (T.jobType === t ? ' selected' : '') + '>' + JT_LABEL[t] + '</option>').join('') + '</select>' +
      '<button type="button" class="sp-btn sp-wide" data-pb-action="add-typed">Add to the list above</button></div></details>';
  }

  function reviewHtml() {
    const c = counts();
    const chip = (n, label) => n ? '<span class="sp-tag">' + n + ' ' + label + '</span>' : '';
    return '<div class="sp-head"><button type="button" class="sp-x" data-pb-action="to-entry" aria-label="Back to the paste">←</button><h3 class="sp-title">Review ' + S.rows.length + ' row' + (S.rows.length === 1 ? '' : 's') + '</h3><button type="button" class="sp-x" data-pb-action="close" aria-label="Close">✕</button></div>' +
      '<div class="sp-chips">' + chip(c['new'], 'new') + chip(c.match, 'to confirm') + chip(c.dup, 'possible duplicate') + chip(c.already, 'already imported') + chip(c.error, 'need a fix') + chip(c.done, 'created') + '</div>' +
      (S.truncated ? '<div class="sp-warn" role="status">Only the first ' + LG().CONFIG.maxRows + ' rows are shown. Paste the rest in a second batch.</div>' : '') +
      (S.invoicesOk ? '' : '<div class="sp-warn" role="status">Invoices did not load: duplicate payments already in the CRM cannot be checked.</div>') +
      trayHtml() + S.rows.map(rowHtml).join('');
  }

  function checkHtml() {
    const c = S.check;
    const inCrm = c.filter((r) => r.inCrm).length, bad = c.filter((r) => r.errors.length).length;
    return '<div class="sp-head"><button type="button" class="sp-x" data-pb-action="to-entry" aria-label="Back to the paste">←</button><h3 class="sp-title">Check vs CRM</h3><button type="button" class="sp-x" data-pb-action="close" aria-label="Close">✕</button></div>' +
      '<p class="sp-lede"><b>' + inCrm + '</b> of ' + c.length + ' payment' + (c.length === 1 ? ' is' : 's are') + ' already in the CRM (same amount, within ' + LG().CONFIG.dupDays + ' days, and the same customer or a close name).' + (bad ? ' ' + bad + ' row' + (bad === 1 ? '' : 's') + ' could not be read.' : '') + ' Nothing was created or changed.</p>' +
      c.map((r) => '<article class="sp-card"><div class="sp-card-top"><b class="sp-payee">' + esc(r.v.name || '(no name)') + '</b><b>' + (r.v.cents ? money(r.v.cents) : '') + '</b></div>' +
        '<div class="sp-card-sub">Row ' + r.n + ' · ' + esc(r.v.ymd || 'no date') + ' · ' + esc(METHOD_LABEL[r.v.method] || '?') + (r.v.ref ? ' #' + esc(r.v.ref) : '') + '</div>' +
        (r.errors.length ? '<ul class="pb-errs">' + r.errors.map((e) => '<li class="sp-err">' + esc(e) + '</li>').join('') + '</ul>'
          : r.inCrm ? '<div><span class="sp-ok">' + (r.exact ? 'Already imported' : 'In the CRM') + '</span></div><ul class="pb-hits">' + r.hits.map((p) => '<li>' + esc(money(p.cents)) + ' on ' + esc(p.ymd) + ' · ' + esc(METHOD_LABEL[p.method] || p.method || 'payment') + (p.name ? ' · ' + esc(p.name) : '') + '</li>').join('') + '</ul>'
          : '<div><span class="sp-flag">Not in the CRM</span>' + (r.matches.length ? ' <span class="sp-sub">(customer found: ' + esc(r.matches[0].name) + ')</span>' : ' <span class="sp-sub">(no matching customer)</span>') + '</div>') + '</article>').join('') +
      '<button type="button" class="sp-btn sp-wide" data-pb-action="to-entry">Back to the paste</button>';
  }

  function overlay() {
    let m = document.getElementById('pbOverlay');
    if (!m) {
      m = document.createElement('div'); m.id = 'pbOverlay'; m.className = 'sp-overlay pb-overlay';
      m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Backfill customer payments');
      document.body.appendChild(m);
    }
    return m;
  }
  function render() {
    if (!S) return;
    const keepText = document.getElementById('pbText');
    if (keepText && S.view === 'entry') S.text = keepText.value;
    const body = S.view === 'review' ? reviewHtml() : S.view === 'check' ? checkHtml() : entryHtml();
    const m = overlay();
    m.innerHTML = '<div class="sp-sheet">' + body + '</div>';
    PP().hydrate(m);
  }
  const rowErr = (n, msg) => { const el = document.querySelector('[data-pb-err="' + n + '"]'); if (el) el.textContent = msg; };

  // ── the one-tap create ──────────────────────────────────────────────────
  function jobIdOf(lead) { const j = lead && lead.activeJobId; return typeof j === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(j) ? j : null; }

  async function mintCustomerId(leadId) {
    try {
      if (w._companyProfileLoaded !== true && typeof w._loadCompanyProfile === 'function') await w._loadCompanyProfile();
      if (w._companyProfileLoaded !== true || typeof w._custIdMint !== 'function' || typeof w._formatCustomerId !== 'function' || !w.runTransaction) return '';
      const cid = tenant();
      const mint = w._custIdMint(cid);
      if (!mint) return '';
      const counterRef = w.doc(w.db, 'counters', mint.counterId);
      const custId = await w.runTransaction(w.db, async (tx) => {
        const snap = await tx.get(counterRef);
        const next = snap.exists() ? (snap.data().next || 0) + 1 : 1;
        tx.set(counterRef, { next: next }, { merge: true });
        return w._formatCustomerId(mint.prefix, next, cid);
      });
      await w.updateDoc(w.doc(w.db, 'leads', leadId), { customerId: custId });
      return custId;
    } catch (e) { console.warn('[payment-backfill] customer id not minted', e && e.code); return ''; }
  }

  async function softVoid(coll, id, current, note) {
    const built = LG().voidPatch(current, note, uid(), Date.now());
    if (built.error) throw new Error(built.error);
    await w.updateDoc(w.doc(w.db, coll, id), Object.assign({}, built.patch, { deletedAt: w.serverTimestamp(), updatedAt: w.serverTimestamp() }));
  }

  async function createRow(n) {
    const r = rowOf(n); if (!r || S.busy[n] || S.done[n]) return;
    const ch = chOf(n), L = LG();
    if (r.errors.length || r.status === 'error') return rowErr(n, 'Fix this row first.');
    if (r.status === 'already') return rowErr(n, 'This payment is already in the CRM.');
    const needsConfirm = r.status === 'match' || (r.status === 'dup' && r.matches.length);
    if (needsConfirm && !ch.pick) return rowErr(n, 'Confirm the customer first: same customer, or different.');
    if (r.status === 'dup' && !ch.override) return rowErr(n, 'This looks like a payment that is already there. Tap "create it anyway" only if it is a different payment.');
    const existingId = ch.pick && ch.pick !== 'new' ? ch.pick : '';
    const jobType = ch.jobType || r.v.jobType;
    if (!existingId && !jobType) return rowErr(n, 'Pick a job type.');
    if (!w.db || !w.addDoc || !w.collection || !w.serverTimestamp || !IP() || typeof IP().markPaid !== 'function') return rowErr(n, 'Not connected. Try again.');
    S.busy[n] = true; render();
    const me = uid(), cid = tenant();
    const made = { lead: null, invoice: null };
    try {
      // 1. the customer (and with it the job: the lead is the job record).
      let lead, leadId, createdLead = false;
      if (existingId) {
        lead = S.leads.find((l) => l.id === existingId);
        if (!lead) throw new Error('That customer is no longer on the board.');
        leadId = lead.id;
      } else {
        // Resume: an earlier run of THIS payment may have made the customer already.
        const prior = S.leads.find((l) => l && l.deleted !== true && l.paymentBackfill === true && l.backfill && l.backfill.key === r.key);
        if (prior) { lead = prior; leadId = prior.id; }
        else {
          const data = L.buildLead({ v: r.v, jobType: jobType }, { stageRole: typeof w.stageRole === 'function' ? w.stageRole('closed') : 'won', uid: me, nowMs: Date.now() });
          const ref = await w.addDoc(w.collection(w.db, 'leads'), Object.assign({}, data, {
            createdAt: w.serverTimestamp(), updatedAt: w.serverTimestamp(), stageStartedAt: w.serverTimestamp(),
            meter: 'manual', userId: me, companyId: cid,
          }));
          leadId = ref.id; createdLead = true;
          made.lead = { id: leadId, data: data };
          const customerId = await mintCustomerId(leadId);
          lead = Object.assign({ id: leadId, userId: me, companyId: cid }, data, customerId ? { customerId } : {});
          if (Array.isArray(w._leads)) w._leads.push(lead);
          S.leads.push(lead);
        }
      }
      // 2. the invoice that carries the payment (the CRM's own minimal-invoice builder).
      let invoiceId = '';
      const priorInv = S.invoices.find((i) => i && i.deleted !== true && i.backfillKey === r.key && i.leadId === leadId);
      if (priorInv) invoiceId = priorInv.id;
      else {
        const now = new Date();
        const base = IP().jobValueInvoiceDoc({ lead: lead, leadId: leadId, totalCents: r.v.cents, jobId: jobIdOf(lead), credits: [], uid: me, companyId: cid, depRule: null, J: null, now: now });
        const doc = Object.assign({}, base, L.invoiceOverrides(r), { editLog: [L.logEntry(me, 'create', 'Backfilled payment', Date.now())] });
        const iref = await w.addDoc(w.collection(w.db, 'invoices'), doc);
        invoiceId = iref.id;
        made.invoice = { id: invoiceId, data: doc };
        S.invoices.push(Object.assign({ id: invoiceId }, doc));
      }
      // 3. the photos (private, EXIF stripped). A failure here never blocks the payment.
      let proofs = [], proofsFailed = false;
      const files = filesOf(n);
      if (files.length) {
        try {
          const stamp = Date.now();
          proofs = await PP().upload(files.map((f) => f.file), (i, base, ext) => IP().paymentProofPath(me, invoiceId, stamp + i, base + '.' + ext));
        } catch (e) { proofsFailed = true; console.warn('[payment-backfill] proof upload failed', e && e.message); }
      }
      // 4. the payment, on the path the CRM already uses (idempotent by payment id).
      await IP().markPaid(invoiceId, r.v.cents / 100, r.v.method, L.paymentDetails(r, proofs));
      S.done[n] = { leadId: leadId, invoiceId: invoiceId, createdLead: createdLead, proofs: proofs, proofsFailed: proofsFailed };
      toast(createdLead ? 'Customer, job and payment created' : 'Payment added to the customer', 'ok');
    } catch (e) {
      console.warn('[payment-backfill] create failed', e && (e.code || e.message));
      // Undo a half-made pair so nothing is left dangling.
      try { if (made.invoice) await softVoid('invoices', made.invoice.id, made.invoice.data, 'Backfill failed midway'); } catch (e2) { /* the void note is best effort */ }
      try { if (made.lead) await softVoid('leads', made.lead.id, made.lead.data, 'Backfill failed midway'); } catch (e3) { /* best effort */ }
      if (made.lead) { const i = S.leads.findIndex((l) => l.id === made.lead.id); if (i >= 0) S.leads.splice(i, 1); if (Array.isArray(w._leads)) { const j = w._leads.findIndex((l) => l && l.id === made.lead.id); if (j >= 0) w._leads.splice(j, 1); } }
      S.busy[n] = false; render();
      rowErr(n, 'Could not save: ' + (e && e.message ? String(e.message).slice(0, 140) : 'unknown error') + '. Nothing was kept.');
      return;
    }
    S.busy[n] = false; render();
  }

  async function undoRow(n) {
    const d = S.done[n]; if (!d || S.busy[n]) return;
    S.busy[n] = true; render();
    try {
      const inv = S.invoices.find((i) => i.id === d.invoiceId) || {};
      await softVoid('invoices', d.invoiceId, inv, 'Undone right after the backfill');
      if (d.createdLead) {
        const lead = S.leads.find((l) => l.id === d.leadId) || {};
        await softVoid('leads', d.leadId, lead, 'Undone right after the backfill');
        const i = S.leads.findIndex((l) => l.id === d.leadId); if (i >= 0) S.leads.splice(i, 1);
        if (Array.isArray(w._leads)) { const j = w._leads.findIndex((l) => l && l.id === d.leadId); if (j >= 0) w._leads.splice(j, 1); }
      }
      S.invoices = S.invoices.filter((i) => i.id !== d.invoiceId);
      delete S.done[n];
      rereview();
      toast('Undone. The customer and payment are voided (kept with a note, not deleted).', 'ok');
    } catch (e) {
      console.warn('[payment-backfill] undo failed', e && e.code);
      toast('Could not undo that. Nothing changed.', 'error');
    }
    S.busy[n] = false; render();
  }

  // ── typed row, files, events ────────────────────────────────────────────
  function addTyped() {
    const T = S.typed;
    const cell = (x) => String(x == null ? '' : x).replace(/[\t\r\n]+/g, ' ').trim();
    const line = LG().POSITIONAL.map((f) => cell(f === 'payer' ? T.payer : T[f])).join('\t');
    const t = document.getElementById('pbText');
    S.text = (t ? t.value : S.text).replace(/\s+$/, '') + (S.text || (t && t.value) ? '\n' : '') + line;
    S.typed = { method: '' };
    S.err = '';
    render();
    toast('Added to the list. Tap "Review rows" when you have them all.', 'ok');
  }
  function addFiles(files) {
    const ok = [];
    files.forEach((f) => { const c = PP().check(f); if (c.ok) ok.push(f); else toast(c.reason, 'warn'); });
    ok.forEach((f) => { S.files.push({ id: 'f' + (++fileSeq), file: f }); });
    if (S.view === 'entry' && ok.length) { toast(ok.length + ' photo' + (ok.length === 1 ? '' : 's') + ' added. Review the rows, then assign each photo to its row.', 'info'); }
    render();
  }

  function onClick(ev) {
    const t = ev.target && ev.target.closest && ev.target.closest('[data-pb-action]');
    if (!t || t.disabled) return;
    const a = t.dataset.pbAction;
    if (a === 'open') { open(); return; }
    if (!S) return;
    const n = Number(t.dataset.pbN);
    if (a === 'close') close();
    else if (a === 'review') runReview('review');
    else if (a === 'check') runReview('check');
    else if (a === 'clear') { S.text = ''; S.rows = []; S.err = ''; render(); }
    else if (a === 'to-entry') { S.view = 'entry'; render(); }
    else if (a === 'add-typed') addTyped();
    else if (a === 'add-files') PP().choose(addFiles);
    else if (a === 'drop-file') { S.files = S.files.filter((f) => f.id !== t.dataset.pbFile); delete S.assign[t.dataset.pbFile]; render(); }
    else if (a === 'row-photo') PP().choose((fs) => { const before = S.files.length; addFiles(fs); S.files.slice(before).forEach((f) => { S.assign[f.id] = n; }); render(); });
    else if (a === 'pick') { chOf(n).pick = t.dataset.pbLead; render(); }
    else if (a === 'pick-new') { chOf(n).pick = 'new'; render(); }
    else if (a === 'override') { chOf(n).override = !chOf(n).override; render(); }
    else if (a === 'create') createRow(n);
    else if (a === 'undo') undoRow(n);
    else if (a === 'job-money') { if (w.NBDSubPayments && typeof w.NBDSubPayments.openJobMoney === 'function') w.NBDSubPayments.openJobMoney(t.dataset.pbLead); else toast('Open the customer from the board to see its money.', 'info'); }
  }
  function onInput(ev) {
    if (!S) return;
    const el = ev.target, f = el && el.dataset && el.dataset.pbF;
    if (!f) return;
    if (f === 'text') { S.text = el.value; return; }
    if (f.indexOf('t-') === 0) { if (f === 't-method') { if (el.checked) S.typed.method = el.value; } else S.typed[f.slice(2)] = el.value; return; }
    if (f.indexOf('jt-') === 0) { chOf(Number(f.slice(3))).jobType = el.value; return; }
    if (f.indexOf('as-') === 0) { const id = f.slice(3); const n = Number(el.value); if (n) S.assign[id] = n; else delete S.assign[id]; render(); }
  }
  if (typeof document !== 'undefined' && !w._NBD_PB_DELEGATE) {
    w._NBD_PB_DELEGATE = true;
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onInput);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && document.getElementById('pbOverlay')) close(); });
    // Drop several photos at once onto the screen.
    document.addEventListener('dragover', (ev) => { if (S && ev.target && ev.target.closest && ev.target.closest('#pbOverlay')) ev.preventDefault(); });
    document.addEventListener('drop', (ev) => {
      if (!S || !(ev.target && ev.target.closest && ev.target.closest('#pbOverlay'))) return;
      ev.preventDefault();
      const fs = Array.prototype.slice.call((ev.dataTransfer && ev.dataTransfer.files) || []);
      if (fs.length) addFiles(fs);
    });
  }
  if (typeof w.addEventListener === 'function' && !w._NBD_PB_FLAGS) {
    w._NBD_PB_FLAGS = true;
    w.addEventListener('nbd:flags-loaded', () => {
      if (!on() || !w.Expenses || typeof w.Expenses.render !== 'function' || typeof w.Expenses.list !== 'function') return;
      if (typeof document !== 'undefined' && document.getElementById('pbPanel')) return;
      if (w.Expenses.list().length) w.Expenses.render();
    });
  }

  function buttonHtml() {
    if (!on()) return '';
    return '<button type="button" class="btn btn-ghost" data-pb-action="open" title="Paste the customer checks, Zelle and cash that never reached the CRM">🧾 Backfill customer payments</button>';
  }
  function panelHtml() {
    if (!on()) return '';
    return '<div class="ui-card sp-panel" id="pbPanel"><div class="sp-head"><h3 class="sp-title">Backfill customer payments</h3>' +
      '<button type="button" class="btn btn-orange sp-open" data-pb-action="open">Paste payments</button></div>' +
      '<div class="sp-sub">Paste the checks, Zelle and cash customers paid that never reached the CRM. Each row becomes a finished job with its payment and a photo of the check, only when you tap it. Nothing is sent to anyone.</div></div>';
  }

  w.NBDPaymentBackfill = { enabled, isOwner, open, buttonHtml, panelHtml, FLAG };
})();
