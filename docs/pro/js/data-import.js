/**
 * data-import.js — Wave 23 (CSV Lead Import)
 *
 * Round-trips the spreadsheet bridge Wave 21 opened with export.
 * Reps moving from another CRM or a spreadsheet now get a real
 * onboarding entry point: drop a CSV, see how columns will map,
 * confirm, and the rows land in Firestore.
 *
 * Pipeline:
 *   1. File picker OR drag-drop CSV onto a drop zone
 *   2. Parse with a small RFC-4180 tolerant tokenizer (handles
 *      quoted fields, doubled-quote escapes, embedded newlines).
 *   3. Auto-detect column → field mapping using a header alias
 *      table. Editable mapping table shows the rep what's lined
 *      up and lets them override before importing.
 *   4. Per-row dedup via window.LeadDedup.findDuplicates against
 *      window._leads. Rows with HIGH-confidence dupes are
 *      pre-flagged "skip"; rep can override per row.
 *   5. Bulk addDoc to leads collection with userId + companyId
 *      stamping, serverTimestamp createdAt/updatedAt, plus
 *      stageStartedAt so Wave 17 / 19 aging cues work right
 *      away. Progress shown live ("Importing 12 of 47…").
 *
 * Exposes: window.openLeadImport / LeadImport.{open}
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['data-import']) return;
  __NBD_LOADED['data-import'] = true;

  // ─── Header aliases (case-insensitive) ──────────────────────────
  // Maps any incoming column name to the canonical lead field. The
  // first match wins. Anything not in this table is offered to the
  // rep with "(skip)" pre-selected so they can opt in.
  const HEADER_ALIASES = {
    firstName:  ['first name', 'firstname', 'first', 'fname', 'given name'],
    lastName:   ['last name', 'lastname', 'last', 'lname', 'surname', 'family name'],
    phone:      ['phone', 'phone number', 'phonenumber', 'mobile', 'cell',
                 'cell phone', 'mobile phone', 'tel', 'telephone'],
    email:      ['email', 'email address', 'e-mail', 'email_address'],
    address:    ['address', 'street', 'street address', 'home address',
                 'mailing address', 'addr', 'full address'],
    stage:      ['stage', 'status', 'lead status', 'pipeline stage'],
    source:     ['source', 'lead source', 'how heard', 'campaign'],
    damageType: ['damage type', 'damage', 'storm damage', 'issue'],
    jobValue:   ['job value', 'value', 'estimate', 'amount', 'deal value',
                 'price', 'estimated value', 'job size'],
    claimNumber:['claim number', 'claim #', 'claim no', 'claim_number', 'claim'],
    insCarrier: ['carrier', 'insurance carrier', 'insurance', 'ins carrier'],
    notes:      ['notes', 'note', 'comment', 'comments', 'description', 'details'],
    customerId: ['customer id', 'customerid', 'customer #', 'cust id', 'nbd id'],
  };

  // Inverse lookup: lowercased alias → canonical field.
  const ALIAS_TO_FIELD = (() => {
    const m = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      m[field.toLowerCase()] = field; // always allow exact name
      for (const a of aliases) m[a.toLowerCase()] = field;
    }
    return m;
  })();

  // ─── CSV parser (RFC-4180 tolerant) ─────────────────────────────
  // Handles: quoted fields, doubled-quote escape (""), embedded
  // newlines and commas inside quoted fields, optional CR before LF,
  // optional UTF-8 BOM at start. Returns an array of arrays of strings.
  function parseCsv(text) {
    if (!text) return [];
    // Strip BOM.
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; continue; }
          inQuotes = false;
          continue;
        }
        cell += ch;
        continue;
      }
      // Outside quotes.
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === ',') { row.push(cell); cell = ''; continue; }
      if (ch === '\r') {
        // Eat the next \n if present (CRLF), then end the row.
        if (text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        rows.push(row); row = [];
        continue;
      }
      if (ch === '\n') {
        row.push(cell); cell = '';
        rows.push(row); row = [];
        continue;
      }
      cell += ch;
    }
    // Flush trailing cell/row if non-empty.
    if (cell.length > 0 || row.length > 0) {
      row.push(cell);
      rows.push(row);
    }
    // Drop trailing fully-empty rows (very common with Excel exports).
    while (rows.length > 0 && rows[rows.length - 1].every(c => c === '')) rows.pop();
    return rows;
  }

  // ─── Mapping detection ──────────────────────────────────────────
  function detectMapping(headers) {
    // headers: array of strings as they appear in the first row.
    // Returns: array of canonical field names (or null) at each
    // index, plus a "duplicates" set listing fields that appear in
    // more than one column (we only honor the first hit).
    const map = [];
    const seen = new Set();
    for (const raw of headers) {
      const norm = String(raw || '').trim().toLowerCase();
      const field = ALIAS_TO_FIELD[norm];
      if (field && !seen.has(field)) {
        map.push(field);
        seen.add(field);
      } else {
        map.push(null); // skip
      }
    }
    return map;
  }

  // ─── Row → lead payload ─────────────────────────────────────────
  function buildLeadFromRow(row, mapping, headers) {
    const lead = {};
    for (let i = 0; i < mapping.length; i++) {
      const field = mapping[i];
      if (!field) continue;
      let val = row[i] != null ? String(row[i]).trim() : '';
      // Undo the export's formula-injection marker on the way back in. This
      // module round-trips the spreadsheet bridge with data-export.js (its
      // HEADER_ALIASES match that file's LEAD_HEADERS labels exactly), and
      // since 2026-09-03 the export prefixes a single quote to any field
      // starting with = + - @ TAB CR. Without this, the common case is not a
      // hostile payload but an ordinary dash-bulleted note: "- called 3x"
      // exports as "'- called 3x" and re-imports with the apostrophe welded
      // on, permanently.
      // The lookahead is what keeps it safe: only a quote that is followed by
      // a character the export would have marked is stripped, so a genuine
      // leading apostrophe in real data ("'96 Chevy in the driveway") is left
      // exactly as typed.
      val = val.replace(/^'(?=[=+\-@\t\r])/, '');
      if (val === '') continue;
      if (field === 'jobValue') {
        const num = Number(val.replace(/[^0-9.\-]/g, ''));
        lead[field] = isNaN(num) ? 0 : num;
      } else {
        lead[field] = val;
      }
    }
    return lead;
  }

  // ─── Stage + customer-ID hygiene for one imported row ───────────
  // (CRM sweep R13, 2026-09-28.) Pure apart from the window.normalizeStage /
  // window.stageRole lookups; unit-tested by lifting it out of this file.
  //
  // STAGE: rows were written with the CSV's text verbatim ("Install Complete",
  // "Won"). The board normalises at read time, but the SERVER classifies the
  // raw string (functions/stage-roles.js roleFor): "Install Complete" is
  // `active` there and `won` on the board, so a finished job imported this way
  // was open work to the weekly digest and the dormant-lead nudge. Store the
  // key the board shows and stamp stageRole beside it — the same contract as
  // stage-write.js / the Edit Lead save. A label the board can't place lands
  // in New (where the board already showed it); the original text is kept as
  // importedStage so nothing is lost silently.
  //
  // CUSTOMER ID: a Customer ID column is honoured only when no existing lead
  // already carries it — two leads with one ID make the public referral link
  // for that customer ambiguous (functions/referrals.js refuses with 409). A
  // kept ID also skips the mint: /leads customerId is write-once, so minting
  // over it was denied after burning a counter number.
  function prepareImportedLead(lead, existingLeads) {
    const out = Object.assign({}, lead);
    if (out.stage) {
      const raw = String(out.stage).trim();
      const key = typeof window.normalizeStage === 'function' ? window.normalizeStage(raw) : raw;
      out.stage = key;
      if (typeof window.stageRole === 'function') out.stageRole = window.stageRole(key);
      if (key !== raw) out.importedStage = raw;
    }
    if (out.customerId) {
      const cid = String(out.customerId).trim();
      const taken = (existingLeads || []).some(l => l && l.customerId && String(l.customerId).trim() === cid);
      if (taken || !cid) delete out.customerId;
    }
    return out;
  }

  // ─── Modal UI ───────────────────────────────────────────────────
  let modalEl = null;

  function openImport() {
    if (modalEl) return; // already open
    modalEl = document.createElement('div');
    modalEl.id = 'nbd-import-modal';
    modalEl.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:99996;
      display:flex; align-items:center; justify-content:center; padding:20px;
      font-family:'Barlow',-apple-system,system-ui,sans-serif;`;
    modalEl.innerHTML = `
      <div style="
        background:var(--s,#1a1f2a); border:1px solid var(--br,#2a3344);
        border-radius:12px; padding:0; width:100%; max-width:680px;
        max-height:88vh; display:flex; flex-direction:column;
        box-shadow:0 12px 40px rgba(0,0,0,0.5);">
        <div class="dix-p18px22px-bb1pxsolid-dflex">
          <div>
            <h2 class="dix-fs17px-m003px-ct">Import Leads</h2>
            <div class="dix-fs12px-cm">CSV from your old CRM, spreadsheet, or anywhere else</div>
          </div>
          <button id="nbd-import-x" aria-label="Close" style="
            background:transparent; border:none; color:var(--m,#9aa3b2);
            cursor:pointer; padding:6px 10px; font-size:18px; line-height:1;
            -webkit-tap-highlight-color:transparent;">×</button>
        </div>
        <div id="nbd-import-body" style="
          flex:1; overflow:auto; padding:22px;
          display:flex; flex-direction:column; gap:14px;">
        </div>
      </div>`;
    document.body.appendChild(modalEl);
    modalEl.querySelector('#nbd-import-x').addEventListener('click', closeImport);
    modalEl.addEventListener('click', e => { if (e.target === modalEl) closeImport(); });
    renderUploadStep();
  }

  function closeImport() {
    if (modalEl) modalEl.remove();
    modalEl = null;
  }

  function renderUploadStep() {
    const body = modalEl.querySelector('#nbd-import-body');
    body.innerHTML = `
      <div id="nbd-drop-zone" style="
        border:2px dashed var(--br,#2a3344); border-radius:12px;
        padding:38px 20px; text-align:center;
        background:var(--s2,#0f1419);
        transition:border-color .2s, background .2s;
        cursor:pointer;">
        <div class="dix-fs36px-mb10px-opa07">📁</div>
        <div class="dix-fs14px-w600-ct">Drop a CSV here</div>
        <div class="dix-fs12px-cm-mb14px">or click to choose a file</div>
        <input type="file" id="nbd-import-file" accept=".csv,text/csv" style="display:none;">
      </div>
      <div class="dix-fs11px-cm-lh16">
        <strong class="dix-ct">Tips:</strong>
        First row should be headers. We auto-recognize names like "First Name", "Phone", "Address", "Email", "Job Value", "Stage", etc. You can adjust the mapping in the next step.
      </div>`;
    const zone = body.querySelector('#nbd-drop-zone');
    const input = body.querySelector('#nbd-import-file');
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      if (input.files && input.files[0]) handleFile(input.files[0]);
    });
    zone.addEventListener('dragover', e => {
      e.preventDefault();
      zone.style.borderColor = 'var(--orange,#A14A22)';
      zone.style.background = 'rgba(161,74,34,0.05)';
    });
    zone.addEventListener('dragleave', () => {
      zone.style.borderColor = 'var(--br,#2a3344)';
      zone.style.background = 'var(--s2,#0f1419)';
    });
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.style.borderColor = 'var(--br,#2a3344)';
      zone.style.background = 'var(--s2,#0f1419)';
      const f = e.dataTransfer?.files?.[0];
      if (f) handleFile(f);
    });
  }

  // Batch 2 (iOS PWA): toast helper so error surfaces work in standalone
  // where native alert() is non-blocking and reps miss the message.
  function _err(msg) {
    if (typeof showToast === 'function') showToast(msg, 'error');
    else window.alert(msg);
  }
  async function handleFile(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      _err('File too large (max 10 MB)');
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch (e) {
      _err('Could not read file: ' + e.message);
      return;
    }
    const rows = parseCsv(text);
    if (rows.length < 2) {
      _err('CSV needs at least a header row + 1 data row.');
      return;
    }
    const headers = rows[0];
    const dataRows = rows.slice(1);
    const mapping = detectMapping(headers);
    renderMappingStep(headers, mapping, dataRows);
  }

  function renderMappingStep(headers, mapping, dataRows) {
    const body = modalEl.querySelector('#nbd-import-body');

    // Build the per-column dropdown options.
    const fields = ['', ...Object.keys(HEADER_ALIASES)];
    const fieldLabel = {
      '': '(skip)',
      firstName: 'First Name', lastName: 'Last Name',
      phone: 'Phone', email: 'Email', address: 'Address',
      stage: 'Stage', source: 'Source', damageType: 'Damage Type',
      jobValue: 'Job Value', claimNumber: 'Claim #',
      insCarrier: 'Carrier', notes: 'Notes', customerId: 'Customer ID',
    };

    // Preview = first 5 rows.
    const preview = dataRows.slice(0, 5);

    body.innerHTML = `
      <div class="dix-dflex-aicenter-jcspacebet">
        <div>
          <div class="dix-fs13px-w600-ct">${dataRows.length} row${dataRows.length === 1 ? '' : 's'} detected</div>
          <div class="dix-fs11px-cm">Confirm column mapping below, then import.</div>
        </div>
        <button id="nbd-import-back" style="
          background:transparent; color:var(--m,#9aa3b2);
          border:1px solid var(--br,#2a3344); padding:6px 14px;
          border-radius:7px; font-size:12px; font-weight:600; cursor:pointer;
          -webkit-tap-highlight-color:transparent;">← Choose different file</button>
      </div>

      <div class="dix-oveauto-max300px-bd1pxsolid">
        <table class="dix-wd100-borcollapse-fs12px">
          <thead class="dix-bgs2-possticky-top0">
            <tr>${headers.map((h, i) => `
              <th class="dix-p10px12px-taleft-bb1pxsolid">
                <div class="dix-fs10px-cm-ttuppercas">${escapeHtml(h)}</div>
                <select class="nbd-import-mapsel" data-col-index="${i}" style="
                  background:var(--s,#1a1f2a); color:var(--t,#e8eaf0);
                  border:1px solid var(--br,#2a3344); border-radius:5px;
                  padding:5px 8px; font-size:12px; font-family:inherit;
                  cursor:pointer; max-width:160px;">
                  ${fields.map(f => `
                    <option value="${escapeHtml(f)}" ${mapping[i] === f ? 'selected' : ''}>
                      ${escapeHtml(fieldLabel[f] || f)}
                    </option>`).join('')}
                </select>
              </th>`).join('')}</tr>
          </thead>
          <tbody>
            ${preview.map(row => `
              <tr>${row.map(cell => `
                <td class="dix-p8px12px-bb1pxsolid-whinowrap">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${dataRows.length > preview.length ? `
        <div class="dix-fs11px-cm-tacenter">
          + ${dataRows.length - preview.length} more rows not shown
        </div>` : ''}

      <div class="dix-dflex-jcflexend-gap8px">
        <button id="nbd-import-cancel" style="
          background:transparent; color:var(--m,#9aa3b2);
          border:1px solid var(--br,#2a3344); padding:9px 18px;
          border-radius:8px; font-size:13px; font-weight:600; cursor:pointer;
          -webkit-tap-highlight-color:transparent;">Cancel</button>
        <button id="nbd-import-go" style="
          background:linear-gradient(135deg,#BD5728 0%,#A14A22 100%);
          color:#fff; border:none; padding:9px 22px; border-radius:8px;
          font-size:13px; font-weight:700; cursor:pointer;
          -webkit-tap-highlight-color:transparent;">Import ${dataRows.length} row${dataRows.length === 1 ? '' : 's'}</button>
      </div>`;

    body.querySelector('#nbd-import-back').addEventListener('click', renderUploadStep);
    body.querySelector('#nbd-import-cancel').addEventListener('click', closeImport);
    body.querySelectorAll('.nbd-import-mapsel').forEach(sel => {
      sel.addEventListener('change', e => {
        const i = parseInt(e.target.getAttribute('data-col-index'), 10);
        mapping[i] = e.target.value || null;
      });
    });
    body.querySelector('#nbd-import-go').addEventListener('click', () => {
      runImport(headers, mapping, dataRows);
    });
  }

  // ─── Bulk import ────────────────────────────────────────────────
  async function runImport(headers, mapping, dataRows) {
    const body = modalEl.querySelector('#nbd-import-body');
    body.innerHTML = `
      <div class="dix-tacenter-p30px20px">
        <div class="dix-fs32px-mb10px">⏳</div>
        <div class="dix-fs14px-ct-w600">
          Importing leads…
        </div>
        <div id="nbd-import-progress" class="dix-fs12px-cm-mb16px">
          Starting…
        </div>
        <div class="dix-hei6px-bgs2-r3px">
          <div id="nbd-import-bar" style="
            height:100%; width:0%; background:linear-gradient(90deg,#A14A22,#f59e0b);
            transition:width .15s ease;"></div>
        </div>
      </div>`;

    const progressEl = body.querySelector('#nbd-import-progress');
    const barEl = body.querySelector('#nbd-import-bar');

    if (!window.db || !window.addDoc || !window.collection || !window.serverTimestamp) {
      _toast('Firestore SDK not ready — try refreshing', 'error');
      closeImport();
      return;
    }

    const uid = window._user?.uid;
    if (!uid) {
      _toast('Not signed in', 'error');
      closeImport();
      return;
    }

    // FAIL CLOSED on an unhydrated lead cache (mirrors pipeline-builder.js
    // canDeleteStage). Dedup (LeadDedup.findDuplicates) and the LITE
    // total-leads cap below both read window._leads, which is [] until
    // loadLeads() succeeds and is reset to [] on a failed first load
    // (dashboard-bootstrap.module.js). Importing against it treats every CSV
    // row as new — re-importing the onboarding CSV duplicates the whole
    // book, each copy minting a fresh customer ID. Checked here (when the
    // rep confirms the mapping), not in openImport, so a load that finishes
    // while they pick a file still lets the import through.
    if (window._leadsLoaded !== true) {
      _toast('Your leads are still loading — wait for the board to finish, then import again.', 'error');
      closeImport();
      return;
    }

    // Plan-cap gate (first-run audit 2026-07-28): the CSV bulk path must
    // mirror _saveLead's enforceGate check — without it a free tenant could
    // import unlimited leads around the 10/mo cap. At the cap this shows the
    // canonical upgrade modal (billing-gate.js owns its CSP-safe delegate,
    // loaded earlier on both dashboard pages) and aborts. Fails open before
    // the plan loads and for owners, per the 2026-07-16 product decision.
    if (window.NBDBilling && typeof window.NBDBilling.enforceGate === 'function'
        && !window.NBDBilling.enforceGate('leads', 'leads')) {
      closeImport();
      return;
    }

    const companyId = window._userClaims?.companyId || uid;
    const existingLeads = Array.isArray(window._leads) ? window._leads : [];

    // Remaining monthly allowance — imports run up to the cap, then stop
    // (partial import beats all-or-nothing for onboarding). Owners resolve
    // to enterprise (limits Infinity) so they're exempt automatically; an
    // unloaded plan fails open, matching enforceGate above.
    // Owner accounts are NEVER limit-gated — billing-gate.js says so in three
    // separate places (_isOwner short-circuits hasCapacity, enforceGate and
    // softGate), and enforceGate above has already let this caller through on
    // that basis. Re-deriving the cap from getPlan() contradicted that decision:
    // loadSubscription()'s owner short-circuit can lose a race with the claims
    // read (its own comment calls this out as "rare and self-limiting"), which
    // leaves _plan at 'free'. When that happened the founder's own import was
    // silently capped at the free tier's 10 leads — enforceGate said yes, then
    // `remaining` said 0, and 51 of 55 rows were dropped as "plan limit
    // reached". Key the cap on the same owner claim the gate uses.
    const _isOwnerAcct = !!(window._userClaims && window._userClaims.owner === true);
    let remaining = Infinity;
    if (!_isOwnerAcct && window.NBDBilling && typeof window.NBDBilling.getPlan === 'function') {
      const p = window.NBDBilling.getPlan();
      if (p.loaded && p.limits && p.limits.leads !== Infinity) {
        remaining = Math.max(0, p.limits.leads - (p.usage.leads || 0));
      }
    }
    // LITE (trial-expired free): mirror _saveLead's blunt total-leads stop.
    // Owner-exempt for the same reason as the plan cap above.
    if (!_isOwnerAcct && window._userPlan === 'lite') {
      remaining = Math.min(remaining, Math.max(0, 10 - existingLeads.length));
    }

    let imported = 0;
    let skippedDupe = 0;
    let skippedEmpty = 0;
    let skippedCap = 0;
    let failed = 0;

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const built = buildLeadFromRow(row, mapping, headers);

      // Skip rows where every mapped field is blank.
      if (Object.keys(built).length === 0) { skippedEmpty++; continue; }
      const lead = prepareImportedLead(built, existingLeads);

      // Dedup against existing leads + already-imported leads (which
      // we accumulate locally so a CSV with internal duplicates also
      // dedups within itself).
      let isDupe = false;
      if (window.LeadDedup && typeof window.LeadDedup.findDuplicates === 'function') {
        const matches = window.LeadDedup.findDuplicates(lead, existingLeads);
        if (matches.some(m => m.confidence === 'high')) {
          isDupe = true;
        }
      }
      if (isDupe) { skippedDupe++; continue; }

      // Plan-cap stop: allowance exhausted — everything from this row on
      // stays unimported (dupes/empties above never consumed allowance).
      if (imported >= remaining) {
        skippedCap = dataRows.length - i;
        break;
      }

      try {
        const ref = await window.addDoc(
          window.collection(window.db, 'leads'),
          {
            ...lead,
            // Normalized inbound-SMS match key — see functions/phone-utils.js.
            // CSV import is the bulk-onboarding path; without this every
            // imported lead is invisible to incomingSMS's phoneDigits match.
            phoneDigits: String(lead.phone || '').replace(/\D/g, '').replace(/^1/, '').slice(-10),
            userId: uid,
            companyId,
            createdAt: window.serverTimestamp(),
            updatedAt: window.serverTimestamp(),
            stageStartedAt: window.serverTimestamp(),
            importedAt: window.serverTimestamp(),
            deleted: false,
          }
        );
        // Mint the human-facing customer ID (NBD-#### / tenant-prefixed) the
        // same way _saveLead does — transactional counter, then stamp the
        // lead. Without this, imported leads carried NO customerId while
        // hand-entered ones did (found on the 2026-08-16 backfill of 57
        // rows), so document numbering and portal references were
        // inconsistent across the two populations. Fail open per row: a mint
        // failure logs and moves on, exactly like _saveLead's catch — the
        // lead itself is already saved.
        try {
          if (!lead.customerId
              && window._companyProfileLoaded === true
              && typeof window._custIdMint === 'function'
              && typeof window._formatCustomerId === 'function'
              && typeof window.runTransaction === 'function'
              && typeof window.updateDoc === 'function'
              // Platform-identity veto (company-profile.js _custIdMint): null
              // for a non-NBD tenant whose brand still resolves as NBD → skip.
              && window._custIdMint(companyId)) {
            const _mint = window._custIdMint(companyId);
            const _ctrId = _mint.counterId;
            const _pfx = _mint.prefix;
            const counterRef = window.doc(window.db, 'counters', _ctrId);
            const custId = await window.runTransaction(window.db, async (tx) => {
              const snap = await tx.get(counterRef);
              const nextNum = (snap.exists() ? (snap.data().next || 0) : 0) + 1;
              tx.set(counterRef, { next: nextNum }, { merge: true });
              return window._formatCustomerId(_pfx, nextNum, companyId);
            });
            await window.updateDoc(window.doc(window.db, 'leads', ref.id), { customerId: custId });
          }
        } catch (cidErr) { console.warn('[import] customer ID mint failed for row', i, cidErr); }

        // Push into in-memory cache so subsequent dedup checks within
        // this same import run catch dupes from earlier rows.
        existingLeads.push({ id: ref.id, ...lead, userId: uid, companyId });
        imported++;
        // Meter the create (server-authoritative monthly counter — same
        // call both _saveLead branches make). Without this, imported leads
        // never count and subsequent single adds under-gate.
        if (window.NBDBilling && typeof window.NBDBilling.trackUsage === 'function') {
          window.NBDBilling.trackUsage('leads');
        }
      } catch (e) {
        console.warn('[import] row failed', i, e.message);
        failed++;
      }

      // Update progress every row (CSV imports are usually small;
      // batching the UI updates would make the bar feel laggy).
      const done = i + 1;
      const pct = Math.round((done / dataRows.length) * 100);
      if (barEl) barEl.style.width = pct + '%';
      if (progressEl) progressEl.textContent =
        `Processing ${done} of ${dataRows.length} (${imported} imported, ${skippedDupe} skipped as duplicates)`;
    }

    // Refresh kanban + dispatch event so widgets update.
    if (typeof window.loadLeads === 'function') {
      try { await window.loadLeads(); } catch (_) {}
    } else if (typeof window._loadLeads === 'function') {
      try { await window._loadLeads(); } catch (_) {}
    }
    try { window.dispatchEvent(new CustomEvent('nbd:data-refreshed', { detail: { source: 'import' } })); } catch (_) {}

    renderDoneStep({ imported, skippedDupe, skippedEmpty, skippedCap, failed, total: dataRows.length });

    // Cap hit mid-import: surface the canonical upsell once (on Growth it
    // degrades to billing-gate's explanatory toast). Fresh getPlan() so the
    // "used" figure includes the rows this run just metered.
    if (skippedCap > 0 && window.NBDBilling
        && typeof window.NBDBilling.showUpgradeModal === 'function') {
      let used = 0, cap = 10;
      if (typeof window.NBDBilling.getPlan === 'function') {
        const pNow = window.NBDBilling.getPlan();
        used = (pNow.usage && pNow.usage.leads) || 0;
        if (pNow.limits && pNow.limits.leads !== Infinity) cap = pNow.limits.leads;
      }
      window.NBDBilling.showUpgradeModal('leads', 'leads', used, cap);
    }
  }

  function renderDoneStep(result) {
    const body = modalEl.querySelector('#nbd-import-body');
    body.innerHTML = `
      <div class="dix-tacenter-p24px16px">
        <div class="dix-fs36px-mb12px">${result.failed > 0 ? '⚠️' : '✅'}</div>
        <h3 class="dix-fs16px-ct-m006px">Import complete</h3>
        <div class="dix-fs13px-cm-mb18px">
          ${result.imported} of ${result.total} leads added to your CRM.
        </div>
        <div class="dix-dflex-flecolumn-gap6px">
          <div class="dix-dflex-jcspacebet-p8px12px">
            <span class="dix-cm">Imported</span>
            <strong class="dix-c10b981">${result.imported}</strong>
          </div>
          ${result.skippedDupe > 0 ? `
            <div class="dix-dflex-jcspacebet-p8px12px">
              <span class="dix-cm">Skipped as duplicates</span>
              <strong class="dix-cf59e0b">${result.skippedDupe}</strong>
            </div>` : ''}
          ${result.skippedCap > 0 ? `
            <div class="dix-dflex-jcspacebet-p8px12px">
              <span class="dix-cm">Not imported — plan limit reached</span>
              <strong class="dix-cf59e0b">${result.skippedCap}</strong>
            </div>
            <div class="dix-fs11px-cf59e0b-taleft">
              Upgrade your plan to import the rest.
            </div>` : ''}
          ${result.skippedEmpty > 0 ? `
            <div class="dix-dflex-jcspacebet-p8px12px">
              <span class="dix-cm">Skipped (empty rows)</span>
              <strong class="dix-cm">${result.skippedEmpty}</strong>
            </div>` : ''}
          ${result.failed > 0 ? `
            <div class="dix-dflex-jcspacebet-p8px12px">
              <span class="dix-cm">Failed</span>
              <strong class="dix-cef4444">${result.failed}</strong>
            </div>` : ''}
        </div>
        <button id="nbd-import-done" style="
          background:linear-gradient(135deg,#BD5728 0%,#A14A22 100%);
          color:#fff; border:none; padding:10px 26px; border-radius:8px;
          font-size:13px; font-weight:700; cursor:pointer;
          -webkit-tap-highlight-color:transparent;">Done</button>
      </div>`;
    body.querySelector('#nbd-import-done').addEventListener('click', closeImport);
  }

  // ─── Helpers ─────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function _toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
    else console.log('[LeadImport]', msg);
  }

  // ─── Public API ─────────────────────────────────────────────────
  const LeadImport = {
    open: openImport,
    parseCsv,
    detectMapping,
    HEADER_ALIASES,
  };
  window.openLeadImport = openImport;
})();
