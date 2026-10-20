/**
 * sub-paperwork.js — the Sub paperwork tracker (flag `subPaperwork`, 2026-10-19).
 *
 * One screen per independent subcontractor on companies/{id}/subs: is the W-9 on
 * file, are the liability and workers' comp papers current, and how much was paid
 * this year. In January, one export (CSV or print) for the 1099 prep.
 *
 *   - The status fields live ON the sub doc (firestore.rules subPaperworkOk); the
 *     W-9 / certificate FILES are private Storage objects under
 *     sub-papers/{companyId}/{subId}/ with a pointer doc in subs/{subId}/papers.
 *     Firestore keeps the PATH only. A file opens through the signed-in SDK
 *     (getBlob into a blob: URL, see proof-photos.js), never a download URL.
 *   - NO Social Security or tax ID is typed in or stored here; the form refuses
 *     text that looks like one. The W-9 is the file.
 *   - Alerts (functions/sub-paperwork-watch.js) go to the owner's Agent inbox only.
 *     Nothing here sends anything to a sub or a customer.
 *   - Owner / company_admin write. Viewer and manager see statuses and totals, no
 *     files. A sales_rep sees nothing. Crews are independent subcontractors.
 *
 * Flag off = no panel, no button, this file does nothing. Money is cents.
 * window.NBDSubPaperwork.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = window;
  const FLAG = 'subPaperwork';
  const WRITE_ROLES = ['', 'company_admin'];
  const READ_ROLES = ['', 'admin', 'company_admin', 'manager', 'viewer'];
  const ENTITY_TYPES = ['', 'Individual / sole proprietor', 'LLC', 'S corporation', 'C corporation', 'Partnership', 'Other'];
  const LG = () => w.NBDSubPaperworkLogic;
  const PP = () => w.NBDProofPhotos;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + ((Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toast = (m, k) => { if (typeof w.showToast === 'function') w.showToast(m, k || 'info'); };

  function enabled() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)) && !!LG(); }
  function claims() { return w._userClaims || {}; }
  function uid() { return (w._user && w._user.uid) || null; }
  function tenant() { return claims().companyId || uid(); }
  function canWrite() { return !!uid() && WRITE_ROLES.indexOf(claims().role || '') !== -1; }
  function canRead() { return !!uid() && READ_ROLES.indexOf(claims().role || '') !== -1; }
  const expenses = () => ((w.Expenses && typeof w.Expenses.list === 'function') ? w.Expenses.list() : []).filter((e) => e && e.deleted !== true);

  // S: { view:'list'|'sheet'|'export', roster[], year, subId, papers[], busy, err }
  let S = null;
  let lastNeed = null; // { need, total } for the Expenses panel

  async function loadRoster() {
    const out = [];
    try {
      const snap = await w.getDocs(w.collection(w.db, 'companies', tenant(), 'subs'));
      // The real doc id goes LAST: a stray `id` field in the data must never win.
      snap.forEach((d) => { const s = d.data() || {}; if (s.active !== false && s.name) out.push(Object.assign({}, s, { id: d.id, aliases: Array.isArray(s.aliases) ? s.aliases.filter((a) => typeof a === 'string') : [] })); });
    } catch (e) { console.warn('[sub-paperwork] roster not loaded', e && e.code); return null; }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  async function loadPapers(subId) {
    if (!canWrite()) return [];
    try {
      const snap = await w.getDocs(w.collection(w.db, 'companies', tenant(), 'subs', subId, 'papers'));
      const out = [];
      snap.forEach((d) => { const p = d.data() || {}; if (LG().paperPathOk(p.storagePath)) out.push(Object.assign({ id: d.id }, p)); });
      return out.sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || String(a.storagePath).localeCompare(String(b.storagePath)));
    } catch (e) { console.warn('[sub-paperwork] papers not loaded', e && e.code); return []; }
  }

  async function open(view) {
    if (!enabled() || !canRead()) return;
    const roster = await loadRoster();
    S = { view: view || 'list', roster: roster || [], loadErr: roster === null, year: new Date().getFullYear(), subId: null, papers: [], busy: false, err: '', kind: 'w9' };
    render();
  }
  function close() { const el = document.getElementById('spwOverlay'); if (el) el.remove(); S = null; }

  // ── pieces ────────────────────────────────────────────────────────────
  const today = () => LG().localYmd(new Date());
  function chipHtml(c) { return '<span class="spw-chip spw-' + esc(c.state) + '"><b>' + esc(c.label) + '</b> ' + esc(c.text) + '</span>'; }
  function sortedRoster() {
    const t = today();
    return S.roster.slice().sort((a, b) => LG().worstOf(LG().chipsFor(b, t)) - LG().worstOf(LG().chipsFor(a, t)) || String(a.name).localeCompare(String(b.name)));
  }

  function listHtml() {
    const L = LG(), t = today();
    if (S.loadErr) return '<div class="spw-warn" role="alert">Could not load your subs. Nothing was changed.</div>';
    if (!S.roster.length) return '<div class="spw-empty">No subs on your roster yet. Add them under Production, then come back here.</div>';
    const yt = L.yearTotals(expenses(), S.roster, new Date().getFullYear());
    const paid = {}; yt.subs.forEach((x) => { paid[x.sub.id] = x.totals; });
    const need = S.roster.filter((s) => L.needsAttention(s, t)).length;
    return '<p class="spw-lede"><b>' + need + '</b> of ' + S.roster.length + ' sub' + (S.roster.length === 1 ? '' : 's') + ' need paperwork attention. Paid this year is what is logged in the CRM.</p>' +
      sortedRoster().map((s) => {
        const p = paid[s.id] || { cents: 0, count: 0 };
        return '<button type="button" class="spw-card" data-spw-act="sheet" data-spw-sub="' + esc(s.id) + '">' +
          '<span class="spw-top"><b class="spw-name">' + esc(s.name) + '</b><span class="spw-sub">' + esc(s.trade || '') + '</span></span>' +
          '<span class="spw-chips">' + L.chipsFor(s, t).map(chipHtml).join('') + '</span>' +
          '<span class="spw-sub">Paid ' + new Date().getFullYear() + ': <b>' + money(p.cents) + '</b> · ' + p.count + ' payment' + (p.count === 1 ? '' : 's') + '</span></button>';
      }).join('');
  }

  function fieldVal(s, k) { return s && s[k] != null ? s[k] : ''; }
  function sheetHtml() {
    const L = LG(), s = S.roster.find((x) => x.id === S.subId);
    if (!s) return '<div class="spw-empty">That sub is not on the list.</div>';
    const ro = canWrite() ? '' : ' disabled';
    const t = today();
    const w9 = ['none', 'requested', 'on_file'].map((k) => '<option value="' + k + '"' + (String(s.w9Status || 'none') === k ? ' selected' : '') + '>' + ({ none: 'No W-9 yet', requested: 'Asked for it, not back', on_file: 'On file' })[k] + '</option>').join('');
    const ent = ENTITY_TYPES.map((e) => '<option value="' + esc(e) + '"' + (String(s.entityType || '') === e ? ' selected' : '') + '>' + esc(e || 'Not set') + '</option>').join('');
    const field = (label, inner) => '<label class="spw-field"><span class="spw-lab">' + label + '</span>' + inner + '</label>';
    const date = (id, k, label) => field(label, '<input class="spw-in" type="date" id="' + id + '" value="' + esc(k === 'glExpiry' ? L.glExpiryOf(s) : fieldVal(s, k)) + '"' + ro + '>');
    let h = '<div class="spw-chips">' + L.chipsFor(s, t).map(chipHtml).join('') + '</div>' +
      field('Legal name (for the 1099)', '<input class="spw-in" id="spwLegal" maxlength="120" autocomplete="off" value="' + esc(fieldVal(s, 'legalName')) + '"' + ro + '>') +
      field('Business type', '<select class="spw-in" id="spwEntity"' + ro + '>' + ent + '</select>') +
      field('W-9', '<select class="spw-in" id="spwW9"' + ro + '>' + w9 + '</select>') +
      date('spwW9On', 'w9ReceivedOn', 'W-9 received on') +
      date('spwGl', 'glExpiry', 'Liability certificate ends') +
      '<label class="spw-check"><input type="checkbox" id="spwWcEx"' + (s.wcExempt === true ? ' checked' : '') + ro + '> Workers\' comp does not apply (exempt)</label>' +
      date('spwWc', 'wcExpiry', "Workers' comp certificate ends") +
      field("Why workers' comp does not apply", '<input class="spw-in" id="spwWcNote" maxlength="200" autocomplete="off" value="' + esc(fieldVal(s, 'wcExemptNote')) + '"' + ro + '>') +
      '<label class="spw-check"><input type="checkbox" id="spwLicReq"' + (s.licenseRequired === true ? ' checked' : '') + ro + '> This trade or town needs a license or registration</label>' +
      field('License / registration (name, not the number)', '<input class="spw-in" id="spwLicNote" maxlength="200" autocomplete="off" value="' + esc(fieldVal(s, 'licenseNote')) + '"' + ro + '>') +
      date('spwLicExp', 'licenseExpiry', 'License ends') +
      field('Notes', '<textarea class="spw-in spw-ta" id="spwNote" maxlength="500" rows="3"' + ro + '>' + esc(fieldVal(s, 'paperworkNote')) + '</textarea>') +
      '<p class="spw-hint">Do not type a Social Security or tax ID number here. Keep the W-9 as a file below.</p>' +
      '<div class="spw-err" id="spwErr" role="alert">' + esc(S.err) + '</div>' +
      (canWrite() ? '<button type="button" class="spw-btn spw-primary" data-spw-act="save"' + (S.busy ? ' disabled' : '') + '>Save paperwork</button>' : '<div class="spw-sub">View only.</div>');
    if (canWrite()) h += papersHtml();
    return h + paymentsHtml(s);
  }
  function papersHtml() {
    const L = LG();
    const kinds = L.KINDS.map((k) => '<option value="' + k.key + '"' + (S.kind === k.key ? ' selected' : '') + '>' + esc(k.label) + '</option>').join('');
    const items = S.papers.map((p) => '<li class="spw-paper"><span>' + esc(L.kindLabel(p.kind)) + ' <span class="spw-sub">' + esc(p.fileName || '') + '</span></span>' +
      PP().thumbsHtml([p.storagePath]) + '<button type="button" class="spw-btn" data-spw-act="del-paper" data-spw-paper="' + esc(p.id) + '">Remove</button></li>').join('');
    return '<div class="spw-sec"><div class="spw-lab">Private files</div>' +
      '<p class="spw-hint">Photos and PDFs only. Only you can open these; they never leave the CRM. Re-saved photos have their location data stripped.</p>' +
      (items ? '<ul class="spw-papers">' + items + '</ul>' : '<div class="spw-sub">No files yet.</div>') +
      '<label class="spw-field"><span class="spw-lab">What is it?</span><select class="spw-in" id="spwKind">' + kinds + '</select></label>' +
      '<button type="button" class="spw-btn spw-primary" data-spw-act="add-paper"' + (S.busy ? ' disabled' : '') + '>Take a photo or choose a file</button></div>';
  }
  function paymentsHtml(s) {
    const L = LG(), yr = new Date().getFullYear();
    const roster = S.roster;
    const rows = L.paymentsFor(expenses(), roster, s.id, yr, 20);
    const yt = L.yearTotals(expenses(), roster, yr).subs.find((x) => x.sub.id === s.id);
    const label = { cash: 'Cash', zelle: 'Zelle', check: 'Check', other: 'Other', none: 'No method' };
    return '<div class="spw-sec"><div class="spw-lab">Paid in ' + yr + ': ' + money(yt ? yt.totals.cents : 0) + '</div>' +
      (rows.length ? rows.map((e) => '<div class="spw-pay"><span>' + esc(dateText(e.date)) + ' · ' + esc(label[L.methodOf(e)]) + '</span><b>' + money(L.centsOf(e)) + '</b></div>').join('') : '<div class="spw-sub">No payments logged this year.</div>') + '</div>';
  }
  function dateText(v) {
    const ms = v && typeof v.toDate === 'function' ? v.toDate() : v instanceof Date ? v : new Date(v);
    return isNaN(ms.getTime()) ? 'no date' : ms.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function exportHtml() {
    const L = LG();
    const yt = L.yearTotals(expenses(), S.roster, S.year);
    const rows = L.prepRows(yt, {});
    const years = []; for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 4; y--) years.push(y);
    let h = '<div class="spw-banner" role="note"><b>' + esc(L.CPA_NOTE) + '</b><br>' + esc(L.COVERAGE_NOTE) + '</div>' +
      '<label class="spw-field"><span class="spw-lab">Calendar year</span><select class="spw-in" id="spwYear">' + years.map((y) => '<option' + (y === S.year ? ' selected' : '') + '>' + y + '</option>').join('') + '</select></label>';
    if (!rows.length) h += '<div class="spw-empty">No logged payments to subs in ' + S.year + '.</div>';
    rows.forEach((r) => {
      h += '<div class="spw-card spw-static"><span class="spw-top"><b class="spw-name">' + esc(r.name) + '</b><b>' + money(r.totals.cents) + '</b></span>' +
        '<span class="spw-sub">' + r.totals.count + ' payment' + (r.totals.count === 1 ? '' : 's') + ' · ' + esc(r.w9) + '</span>' +
        (r.flags.length ? '<span class="spw-chips">' + r.flags.map((f) => '<span class="spw-chip spw-missing">' + esc(f) + '</span>').join('') + '</span>' : '') + '</div>';
    });
    if (yt.estimated.count) h += '<div class="spw-sub">' + yt.estimated.count + ' estimated cost row(s) (' + money(yt.estimated.cents) + ') were never paid and are left out.</div>';
    h += '<div class="spw-sub">No Social Security or tax ID numbers are in this export. Read those from the W-9 file.</div>' +
      '<div class="spw-row"><button type="button" class="spw-btn spw-primary" data-spw-act="csv">Download CSV</button><button type="button" class="spw-btn" data-spw-act="print">Print</button></div>';
    return h;
  }

  function render() {
    if (!S) return;
    let el = document.getElementById('spwOverlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'spwOverlay'; el.className = 'spw-overlay'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Sub paperwork');
      document.body.appendChild(el);
    }
    const sub = S.view === 'sheet' ? S.roster.find((x) => x.id === S.subId) : null;
    const title = S.view === 'sheet' ? (sub ? sub.name : 'Sub') : S.view === 'export' ? '1099 prep' : 'Sub paperwork';
    const tabs = S.view === 'sheet' ? '<button type="button" class="spw-btn" data-spw-act="back">‹ All subs</button>' :
      '<div class="spw-tabs" role="group"><button type="button" class="spw-tab" data-spw-act="tab-list" aria-pressed="' + (S.view === 'list') + '">Subs</button>' +
      '<button type="button" class="spw-tab" data-spw-act="tab-export" aria-pressed="' + (S.view === 'export') + '">1099 prep</button></div>';
    const body = S.view === 'sheet' ? sheetHtml() : S.view === 'export' ? exportHtml() : listHtml();
    el.innerHTML = '<div class="spw-sheet"><div class="spw-head"><h2 class="spw-title">' + esc(title) + '</h2><button type="button" class="spw-x" data-spw-act="close" aria-label="Close">✕</button></div>' + tabs + body + '</div>';
    if (S.view === 'sheet' && PP()) PP().hydrate(el);
  }

  // ── actions ───────────────────────────────────────────────────────────
  const val = (id) => { const e = document.getElementById(id); return e ? e.value : ''; };
  const chk = (id) => { const e = document.getElementById(id); return !!(e && e.checked); };

  async function save() {
    if (!canWrite() || !S || S.busy) return;
    const L = LG(), s = S.roster.find((x) => x.id === S.subId);
    if (!s) return;
    const c = L.cleanPaperwork({
      legalName: val('spwLegal'), entityType: val('spwEntity'), w9Status: val('spwW9'), w9ReceivedOn: val('spwW9On'), glExpiry: val('spwGl'),
      wcExpiry: val('spwWc'), wcExempt: chk('spwWcEx'), wcExemptNote: val('spwWcNote'), licenseRequired: chk('spwLicReq'), licenseNote: val('spwLicNote'),
      licenseExpiry: val('spwLicExp'), paperworkNote: val('spwNote'), paperworkReviewedAt: today(),
    });
    if (!c.ok) { S.err = c.message; render(); return; }
    S.err = ''; S.busy = true; render();
    // insuranceExpiry stays the older name for the liability date, so the Production roster warning keeps working.
    const data = Object.assign({}, c.fields, { insuranceExpiry: c.fields.glExpiry || null, updatedAt: w.serverTimestamp() });
    try {
      await w.setDoc(w.doc(w.db, 'companies', tenant(), 'subs', s.id), data, { merge: true });
      const fresh = await loadRoster();
      if (fresh) S.roster = fresh;
      S.busy = false; toast('Paperwork saved', 'success'); S.view = 'list'; S.subId = null; render();
    } catch (e) {
      console.warn('[sub-paperwork] save failed', e && e.code);
      S.busy = false; S.err = 'Could not save. Nothing was changed.'; render();
    }
  }

  async function addPaper() {
    if (!canWrite() || !S || S.busy || !PP()) return;
    S.kind = val('spwKind') || S.kind;
    const kind = S.kind, t = tenant(), subId = S.subId;
    PP().choose(async (files) => {
      if (!S || S.subId !== subId) return;
      S.busy = true; S.err = ''; render();
      let uploaded = [];
      try {
        const done = await PP().upload(files.slice(0, 1), (i, base, ext) => 'sub-papers/' + t + '/' + subId + '/' + Date.now() + '_' + base + '.' + ext);
        uploaded = done.map((f) => f.path);
        for (const f of done) {
          if (!LG().paperPathOk(f.path)) throw new Error('bad path');
          await w.addDoc(w.collection(w.db, 'companies', t, 'subs', subId, 'papers'), { kind: kind, storagePath: f.path, fileName: f.name.slice(0, 120), uploadedAt: w.serverTimestamp(), uploadedBy: uid() });
        }
        uploaded = [];
        if (S && S.subId === subId) S.papers = await loadPapers(subId);
        toast('File saved', 'success');
      } catch (e) {
        console.warn('[sub-paperwork] upload failed', e && e.message);
        // An upload with no pointer doc would be an orphan nobody can see: remove it (best effort).
        for (const p of uploaded) {
          try { const st = w._nbdStorageSdk || (w._nbdStorageSdk = await import('/assets/vendor/firebase/10.12.2/firebase-storage.js')); await st.deleteObject(st.ref(w.storage, p)); } catch (x) { /* nothing more to do */ }
        }
        if (S) S.err = 'Could not save that file. It must be a photo or a PDF under 25MB. Nothing was changed.';
      }
      if (S) { S.busy = false; render(); }
    });
  }

  async function delPaper(id) {
    const p = S && S.papers.find((x) => x.id === id);
    if (!p || !canWrite()) return;
    const ask = typeof w.nbdConfirm === 'function' ? w.nbdConfirm('Remove this file? It is deleted for good.') : Promise.resolve(w.confirm('Remove this file? It is deleted for good.'));
    if (!(await ask)) return;
    try {
      const st = w._nbdStorageSdk || (w._nbdStorageSdk = await import('/assets/vendor/firebase/10.12.2/firebase-storage.js'));
      await st.deleteObject(st.ref(w.storage, p.storagePath)).catch((e) => { if (!e || e.code !== 'storage/object-not-found') throw e; });
      await w.deleteDoc(w.doc(w.db, 'companies', tenant(), 'subs', S.subId, 'papers', id));
      S.papers = await loadPapers(S.subId); render(); toast('File removed', 'success');
    } catch (e) { console.warn('[sub-paperwork] remove failed', e && e.code); toast('Could not remove that file.', 'error'); }
  }

  function downloadCsv() {
    const L = LG();
    const text = L.csv1099(L.yearTotals(expenses(), S.roster, S.year), {});
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'sub-payments-' + S.year + '-1099-prep.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function onClick(ev) {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-spw-act]') : null;
    if (!t) return;
    const a = t.getAttribute('data-spw-act');
    if (a === 'open') { ev.preventDefault(); open(t.getAttribute('data-spw-view') || 'list'); return; }
    if (!S) return;
    if (a === 'close') close();
    else if (a === 'back' || a === 'tab-list') { S.view = 'list'; S.subId = null; S.err = ''; render(); }
    else if (a === 'tab-export') { S.view = 'export'; render(); }
    else if (a === 'sheet') {
      S.view = 'sheet'; S.subId = t.getAttribute('data-spw-sub'); S.err = ''; S.papers = []; render();
      const id = S.subId; const p = await loadPapers(id);
      if (S && S.subId === id) { S.papers = p; render(); }
    }
    else if (a === 'save') save();
    else if (a === 'add-paper') addPaper();
    else if (a === 'del-paper') delPaper(t.getAttribute('data-spw-paper'));
    else if (a === 'csv') downloadCsv();
    else if (a === 'print') w.print();
  }
  function onChange(ev) {
    if (S && ev.target && ev.target.id === 'spwYear') { S.year = parseInt(ev.target.value, 10) || S.year; render(); }
  }
  if (typeof document !== 'undefined' && !w._NBD_SPW_DELEGATE) {
    w._NBD_SPW_DELEGATE = true;
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && document.getElementById('spwOverlay')) close(); });
  }
  // Flags arrive a moment after boot: redraw an already-open Expenses page once.
  if (typeof w.addEventListener === 'function' && !w._NBD_SPW_FLAGS) {
    w._NBD_SPW_FLAGS = true;
    w.addEventListener('nbd:flags-loaded', () => {
      if (!enabled() || !canRead() || !w.Expenses || typeof w.Expenses.render !== 'function' || typeof w.Expenses.list !== 'function') return;
      if (document.getElementById('spwPanel')) return;
      if (w.Expenses.list().length) w.Expenses.render();
    });
  }

  // ── Expenses page: one card ───────────────────────────────────────────
  let counted = false;
  function panelHtml() {
    if (!enabled() || !canRead()) return '';
    if (!counted && w.db && w.getDocs && tenant()) {
      counted = true;
      loadRoster().then((r) => {
        if (!r) return;
        const t = today();
        lastNeed = { need: r.filter((s) => LG().needsAttention(s, t)).length, total: r.length };
        const el = document.getElementById('spwCount');
        if (el) el.textContent = lastNeed.need + ' of ' + lastNeed.total + ' subs need paperwork attention';
      });
    }
    return '<section class="spw-panel" id="spwPanel" aria-label="Sub paperwork"><div class="spw-head"><h3 class="spw-title">Sub paperwork</h3>' +
      '<button type="button" class="spw-btn spw-primary" data-spw-act="open">Open</button></div>' +
      '<div class="spw-sub" id="spwCount">' + (lastNeed ? esc(lastNeed.need + ' of ' + lastNeed.total + ' subs need paperwork attention') : 'W-9s, insurance papers and 1099 prep for your subs') + '</div></section>';
  }

  w.NBDSubPaperwork = { panelHtml: panelHtml, open: open, close: close, enabled: enabled };
})();
