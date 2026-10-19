/**
 * payment-backfill-logic.js — the pure rules for the Customer payment backfill
 * (flag `paymentBackfill`, 2026-10-19).
 *
 * Jo pastes (or types) the customer checks / Zelle / cash he was paid, one row
 * per payment. This file: reads the rows (CSV / TSV, with or without a header),
 * validates each, matches it to an existing customer (never merges one), finds
 * payments already in the CRM (and repeats inside the paste), and builds the
 * documents a one-tap "Create" writes: the customer lead (finished, quiet), and
 * the paid invoice that carries the payment. Nothing here touches Firestore or
 * the DOM, so every rule is unit-tested.
 *
 * Money is integer cents here; an invoice payment entry keeps `amount` in
 * dollars (the CRM's existing ledger shape) and the UI converts at the edge.
 * No customer data in tests: fixtures are synthetic.
 *
 * window.NBDPaymentBackfillLogic + module.exports.
 */
(function (root) {
  'use strict';

  var CONFIG = { dupDays: 7, nameMatch: 0.8, nameLoose: 0.5, maxRows: 300, minYear: 2015, maxCents: 99999999, maxMemo: 300 };
  var METHODS = ['check', 'cash', 'zelle', 'other'];
  var JOB_TYPES = ['insurance', 'cash', 'finance', 'warranty', 'service'];
  var POSITIONAL = ['payer', 'address', 'phone', 'date', 'amount', 'method', 'ref', 'memo', 'jobType', 'source'];
  var ALIASES = {
    payer: ['payer', 'payer name', 'name', 'customer', 'customer name', 'from', 'paid by'],
    address: ['address', 'property', 'property address', 'job address', 'street'],
    phone: ['phone', 'phone number', 'cell', 'mobile', 'tel'],
    date: ['date', 'payment date', 'check date', 'paid date', 'date paid', 'received'],
    amount: ['amount', 'amt', 'payment', 'payment amount', 'check amount', 'paid'],
    method: ['method', 'payment method', 'paid with', 'form'],
    ref: ['check #', 'check no', 'check number', 'check num', 'reference', 'ref', 'ref #', 'confirmation', 'confirmation #'],
    memo: ['memo', 'note', 'notes', 'description', 'for', 'what for'],
    jobType: ['job type', 'jobtype', 'type of job', 'category'],
    source: ['source', 'lead source', 'how heard']
  };
  var METHOD_WORDS = {
    check: 'check', cheque: 'check', chk: 'check', ck: 'check',
    cash: 'cash', zelle: 'zelle', zel: 'zelle',
    other: 'other', ach: 'other', card: 'other', venmo: 'other', cashapp: 'other', wire: 'other', 'money order': 'other', mo: 'other'
  };
  var TYPE_WORDS = {
    insurance: 'insurance', ins: 'insurance', claim: 'insurance',
    cash: 'cash', retail: 'cash', 'out of pocket': 'cash',
    finance: 'finance', financed: 'finance', financing: 'finance',
    warranty: 'warranty', service: 'service', repair: 'service'
  };
  var STREET = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', circle: 'cir', boulevard: 'blvd', highway: 'hwy', place: 'pl', parkway: 'pkwy', terrace: 'ter', trail: 'trl', north: 'n', south: 's', east: 'e', west: 'w' };
  var SUFFIX = { llc: 1, inc: 1, co: 1, corp: 1, jr: 1, sr: 1, ii: 1, iii: 1 };
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  var DAY_MS = 86400000;

  function s(v) { return v == null ? '' : String(v); }
  function clean(v) { return s(v).replace(/\s+/g, ' ').trim(); }
  function dayNum(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / DAY_MS); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // ── reading the paste ─────────────────────────────────────────────────
  /** Split text into cells. Tab if any tab is present, else comma. Quotes ("a, b", "" inside) honoured. */
  function splitTable(text) {
    var t = s(text).replace(/\r\n?/g, '\n');
    var delim = t.indexOf('\t') !== -1 ? '\t' : ',';
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < t.length; i++) {
      var c = t[i];
      if (q) {
        if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return clean(x) !== ''; }); });
  }
  function headerMap(cells) {
    var map = {}, hits = 0;
    cells.forEach(function (c, i) {
      var h = clean(c).toLowerCase().replace(/[^a-z0-9# ]+/g, ' ').replace(/\s+/g, ' ').trim();
      Object.keys(ALIASES).forEach(function (f) { if (map[f] == null && ALIASES[f].indexOf(h) !== -1) { map[f] = i; hits++; } });
    });
    return hits >= 3 ? map : null;
  }

  function parseDate(v) {
    var t = clean(v), m, y, mo, d;
    if (!t) return null;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4}|\d{2})$/.exec(t))) { mo = +m[1]; d = +m[2]; y = +m[3]; if (m[3].length === 2) y += 2000; }
    else if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(t))) { mo = MONTHS[m[1].toLowerCase().slice(0, 4)] || MONTHS[m[1].toLowerCase().slice(0, 3)]; d = +m[2]; y = +m[3]; }
    else return null;
    if (!mo || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return { y: y, m: mo, d: d, ymd: y + '-' + pad(mo) + '-' + pad(d), day: dayNum(y, mo, d) };
  }
  function parseCents(v) {
    var t = clean(v).replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return 0;
    return Math.round(parseFloat(t) * 100);
  }
  function parseMethod(v) {
    var t = clean(v).toLowerCase().replace(/[^a-z ]+/g, '').trim();
    return METHOD_WORDS[t] || '';
  }
  function parseJobType(v) {
    var t = clean(v).toLowerCase().replace(/[^a-z ]+/g, '').trim();
    return TYPE_WORDS[t] || '';
  }
  function digits(v) { return s(v).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); }
  function splitName(raw) {
    var t = clean(raw);
    if (t.indexOf(',') !== -1) { var p = t.split(','); t = clean(p.slice(1).join(' ')) + ' ' + clean(p[0]); }
    var parts = clean(t).split(' ');
    if (parts.length === 1) return { first: parts[0], last: '' };
    return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
  }

  /**
   * text -> { rows[], header: bool, error? }. Each row: { n, input:{...raw cells}, v:{...parsed}, errors:[] }.
   * Without a header the columns are, in order: payer, address, phone, date,
   * amount, method, check no, memo, job type, source.
   */
  function parse(text, today) {
    var table = splitTable(text);
    if (!table.length) return { rows: [], header: false, error: 'Paste at least one row.' };
    var map = headerMap(table[0]);
    var body = map ? table.slice(1) : table;
    if (!map) { map = {}; POSITIONAL.forEach(function (f, i) { map[f] = i; }); }
    var truncated = body.length > CONFIG.maxRows;
    var rows = body.slice(0, CONFIG.maxRows).map(function (cells, i) {
      var input = {};
      Object.keys(map).forEach(function (f) { input[f] = clean(cells[map[f]]); });
      return validate({ n: i + 1, input: input }, today);
    });
    return { rows: rows, header: !!headerMap(table[0]), truncated: truncated };
  }

  /** Parse + validate one row's inputs. today = a Date (for the future-date check). */
  function validate(row, today) {
    var inp = row.input, errors = [], v = {};
    var name = clean(inp.payer);
    if (!name) errors.push('Who paid? A name is required.');
    var nm = splitName(name);
    v.name = clean(nm.first + ' ' + nm.last); v.first = nm.first; v.last = nm.last;
    v.address = clean(inp.address);
    if (!v.address) errors.push('Address is required (the CRM needs one to make the customer).');
    var ph = digits(inp.phone);
    if (inp.phone && (ph.length < 10 || ph.length > 15)) errors.push('Phone needs at least 10 digits (or leave it empty).');
    v.phoneDigits = ph.length >= 10 ? ph.slice(-10) : '';
    v.phone = v.phoneDigits ? clean(inp.phone) : '';
    var dt = parseDate(inp.date);
    if (!dt) errors.push('Payment date is missing or not a real date (try 2026-10-03 or 10/3/2026).');
    else {
      var now = today instanceof Date ? today : new Date();
      if (dt.day > dayNum(now.getFullYear(), now.getMonth() + 1, now.getDate()) + 1) errors.push('That date is in the future.');
      if (dt.y < CONFIG.minYear) errors.push('That date is before ' + CONFIG.minYear + '.');
    }
    v.date = dt; v.ymd = dt ? dt.ymd : '';
    var cents = parseCents(inp.amount);
    if (cents <= 0) errors.push('Amount must be more than $0 (for example 1234.50).');
    else if (cents > CONFIG.maxCents) errors.push('That amount is too large.');
    v.cents = cents > 0 && cents <= CONFIG.maxCents ? cents : 0;
    v.method = parseMethod(inp.method);
    if (!v.method) errors.push('Method must be check, cash, Zelle or other.');
    v.ref = clean(inp.ref).replace(/^#\s*/, '').slice(0, 60);
    v.memo = clean(inp.memo).slice(0, CONFIG.maxMemo);
    v.jobType = parseJobType(inp.jobType);
    if (clean(inp.jobType) && !v.jobType) errors.push('Job type must be insurance, cash, finance, warranty or service (or leave it empty and pick one).');
    v.sourceHint = clean(inp.source).slice(0, 80);
    row.v = v; row.errors = errors;
    return row;
  }

  // ── names and addresses ───────────────────────────────────────────────
  function nameTokens(name) {
    var t = clean(name).toLowerCase();
    if (t.indexOf(',') !== -1) { var p = t.split(','); t = p.slice(1).join(' ') + ' ' + p[0]; }
    return t.replace(/&/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(function (x) { return x && !SUFFIX[x]; });
  }
  /** 0..1: matching name words (a word or its first-letter initial) over the longer name. */
  function nameScore(a, b) {
    var ta = nameTokens(a), tb = nameTokens(b);
    if (!ta.length || !tb.length) return 0;
    var used = {}, hit = 0;
    ta.forEach(function (x) {
      for (var i = 0; i < tb.length; i++) {
        if (used[i]) continue;
        var y = tb[i];
        if (x === y || (x.length === 1 && y[0] === x) || (y.length === 1 && x[0] === y)) { used[i] = true; hit++; return; }
      }
    });
    return hit / Math.max(ta.length, tb.length);
  }
  function addrParts(addr) {
    var t = clean(addr).toLowerCase().split(',')[0].replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(Boolean);
    t = t.map(function (x) { return STREET[x] || x; });
    var house = /^\d+[a-z]?$/.test(t[0] || '') ? t[0] : '';
    return { house: house, street: (house ? t.slice(1) : t).filter(function (x) { return x !== 'apt' && x !== 'unit'; }) };
  }
  /** Same house number and the same first street word after st/ave/dr... are normalized. */
  function sameAddress(a, b) {
    var x = addrParts(a), y = addrParts(b);
    return !!x.house && x.house === y.house && !!x.street.length && !!y.street.length && x.street[0] === y.street[0];
  }

  /** A short stable key for "this exact payment": who + where + day + cents + check no. (FNV-1a, 32-bit.) */
  function paymentKey(v) {
    var ap = addrParts(v.address);
    var base = nameTokens(v.name).sort().join(' ') + '|' + ap.house + ' ' + (ap.street[0] || '') + '|' + v.ymd + '|' + v.cents + '|' + clean(v.ref).toLowerCase();
    var h = 0x811c9dc5;
    for (var i = 0; i < base.length; i++) { h ^= base.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h.toString(36);
  }
  function paymentIdFor(v) { return 'bf_' + paymentKey(v); }

  // ── matching a customer (never a merge) ───────────────────────────────
  function leadName(l) { return clean(((l && l.firstName) || '') + ' ' + ((l && l.lastName) || '')) || clean(l && l.name) || ''; }
  /**
   * Existing customers this row might be. A candidate needs the same phone, OR the
   * same address, OR a name that matches well. Best first, at most 3. The caller
   * shows them and the owner confirms; nothing is chosen here.
   */
  function matchCustomers(v, leads) {
    var out = [];
    (leads || []).forEach(function (l) {
      if (!l || !l.id || l.deleted === true) return;
      var reasons = [], score = 0;
      var ph = digits(l.phone || l.phoneNumber || '');
      if (v.phoneDigits && ph.length >= 10 && ph.slice(-10) === v.phoneDigits) { score += 100; reasons.push('same phone'); }
      if (v.address && sameAddress(v.address, l.address)) { score += 60; reasons.push('same address'); }
      var ns = nameScore(v.name, leadName(l));
      if (ns >= CONFIG.nameMatch) { score += 40; reasons.push('same name'); }
      else if (ns >= CONFIG.nameLoose && (reasons.length)) { score += 15; reasons.push('similar name'); }
      var ok = reasons.indexOf('same phone') !== -1 || reasons.indexOf('same address') !== -1 || reasons.indexOf('same name') !== -1;
      if (ok) out.push({ leadId: l.id, name: leadName(l), address: clean(l.address), customerId: l.customerId || '', score: score, reasons: reasons });
    });
    out.sort(function (a, b) { return (b.score - a.score) || a.name.localeCompare(b.name); });
    return out.slice(0, 3);
  }

  // ── payments already in the CRM ───────────────────────────────────────
  function toYmd(v) {
    if (v == null) return '';
    var ms = typeof v === 'number' ? v : (v instanceof Date ? v.getTime() : (typeof v.toMillis === 'function' ? v.toMillis() : (typeof v.toDate === 'function' ? v.toDate().getTime() : (typeof v.seconds === 'number' ? v.seconds * 1000 : NaN))));
    if (isNaN(ms)) return '';
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  /** Flatten invoices -> one entry per recorded payment (voided invoices and refunds left out). */
  function paymentsIndex(invoices, leads) {
    var byLead = {};
    (leads || []).forEach(function (l) { if (l && l.id) byLead[l.id] = l; });
    var out = [];
    (invoices || []).forEach(function (inv) {
      if (!inv || inv.deleted === true) return;
      (Array.isArray(inv.payments) ? inv.payments : []).forEach(function (p) {
        if (!p) return;
        var amt = parseFloat(p.amount);
        if (!(amt > 0)) return;
        var ymd = toYmd(p.at);
        var d = ymd ? parseDate(ymd) : null;
        var lead = inv.leadId ? byLead[inv.leadId] : null;
        out.push({
          invoiceId: inv.id || '', leadId: inv.leadId || '', cents: Math.round(amt * 100), ymd: ymd, day: d ? d.day : null,
          method: p.method || '', ref: clean(p.reference), paymentId: p.paymentId || '',
          name: lead ? leadName(lead) : clean(inv.customerName), backfillKey: inv.backfillKey || ''
        });
      });
    });
    return out;
  }
  /**
   * Is this payment already in the CRM?
   *   { level:'already', hit }   the exact backfilled payment (same payment id)
   *   { level:'possible', hits } same amount within +/-dupDays AND (a matched customer, a similar name, or the same check no.)
   *   { level:'none' }
   * index = paymentsIndex(...). matches = matchCustomers(...) for this row.
   */
  function findDuplicates(v, index, matches) {
    var id = paymentIdFor(v);
    var exact = (index || []).filter(function (p) { return p.paymentId === id; });
    if (exact.length) return { level: 'already', hit: exact[0] };
    var ids = {};
    (matches || []).forEach(function (m) { ids[m.leadId] = true; });
    var hits = [];
    (index || []).forEach(function (p) {
      if (p.cents !== v.cents) return;
      var refSame = v.ref && p.ref && v.ref.toLowerCase() === p.ref.toLowerCase();
      var near = v.date && p.day != null && Math.abs(p.day - v.date.day) <= CONFIG.dupDays;
      if (!near && !refSame) return;
      if (ids[p.leadId] || refSame || nameScore(v.name, p.name) >= CONFIG.nameLoose) hits.push(p);
    });
    return hits.length ? { level: 'possible', hits: hits.slice(0, 3) } : { level: 'none' };
  }

  /**
   * Review every parsed row. -> rows with .status:
   *   'error'     the row cannot be saved as it stands
   *   'already'   this exact payment was imported before
   *   'dup'       possible duplicate payment (in the CRM or earlier in this paste)
   *   'match'     matches existing customer(s): the owner confirms or says "different"
   *   'new'       a new customer
   * plus .matches, .dup, .key. Never decides for the owner.
   */
  function review(rows, leads, invoices) {
    var index = paymentsIndex(invoices, leads);
    var seen = {};
    return (rows || []).map(function (r) {
      var o = Object.assign({}, r);
      if (r.errors.length) { o.status = 'error'; o.matches = []; o.dup = { level: 'none' }; return o; }
      o.key = paymentKey(r.v);
      o.matches = matchCustomers(r.v, leads);
      o.dup = findDuplicates(r.v, index, o.matches);
      var again = seen[o.key];
      seen[o.key] = true;
      if (o.dup.level === 'already') o.status = 'already';
      else if (again) { o.status = 'dup'; o.dup = { level: 'possible', inPaste: true, hits: [] }; }
      else if (o.dup.level === 'possible') o.status = 'dup';
      else if (o.matches.length) o.status = 'match';
      else o.status = 'new';
      return o;
    });
  }
  var STATUS_LABEL = { error: 'Needs a fix', already: 'Already imported', dup: 'Possible duplicate payment', match: 'Matches an existing customer: confirm', 'new': 'New customer' };

  /** "Check vs CRM": per row, is the payment already there? Read-only. */
  function checkAgainstCrm(rows, leads, invoices) {
    return review(rows, leads, invoices).map(function (r) {
      var inCrm = r.status === 'already' || (r.dup && r.dup.level === 'possible' && !r.dup.inPaste);
      return { n: r.n, status: r.status, inCrm: inCrm, exact: r.status === 'already', errors: r.errors, v: r.v, hits: r.dup && r.dup.hit ? [r.dup.hit] : ((r.dup && r.dup.hits) || []), matches: r.matches };
    });
  }

  // ── what one tap writes ───────────────────────────────────────────────
  function noonOf(v) { return new Date(v.date.y, v.date.m - 1, v.date.d, 12, 0, 0); }
  /**
   * The customer lead, shaped like the Add Lead form's payload, finished and QUIET.
   * ctx: { stageRole, uid, nowMs }. The caller adds userId / companyId / timestamps.
   * Never guesses the source: 'Other', and no confirmedSource (so the Lead Source
   * Fixer still asks). completedBackfill + stageHistory (backfill:true) is the
   * quiet mechanism every after-install automation already honours
   * (functions/quiet-backfill.js); paymentBackfill is the extra marker it also reads.
   */
  function buildLead(row, ctx) {
    var v = row.v, c = ctx || {};
    var nowMs = c.nowMs || Date.now();
    var at = noonOf(v);
    var iso = new Date(nowMs).toISOString();
    var data = {
      firstName: v.first, lastName: v.last, address: v.address, phone: v.phone, phoneDigits: v.phoneDigits, email: '',
      stage: 'closed', jobType: row.jobType || v.jobType, subType: '', source: 'Other',
      notes: ('Backfilled from a payment record' + (v.memo ? ': ' + v.memo : '.')).slice(0, 500),
      scopeOfWork: v.memo || '',
      jobValue: v.cents / 100,
      claimStatus: 'No Claim',
      closedAt: at, completedAt: at,
      deleted: false,
      paymentBackfill: true,
      completedBackfill: { date: v.ymd, quiet: true, reason: 'payment_backfill', by: 'Payment backfill', byUid: c.uid || null, token: iso, fromStage: null },
      stageHistory: [
        { from: null, to: 'install_complete', timestamp: iso, user: 'Payment backfill', by: c.uid || null, backfill: true, completedOn: v.ymd },
        { from: 'install_complete', to: 'closed', timestamp: iso, user: 'Payment backfill', by: c.uid || null, backfill: true }
      ],
      backfill: { key: paymentKey(v), at: iso, by: c.uid || null, sourceHint: v.sourceHint, rowNote: 'created by Payment backfill' }
    };
    if (c.stageRole) data.stageRole = c.stageRole;
    return data;
  }
  /** What to add on top of invoice-pipeline.jobValueInvoiceDoc(...) so the invoice is a quiet, paid-on-arrival backfill. */
  function invoiceOverrides(row) {
    var v = row.v;
    var label = 'Backfilled payment' + (v.memo ? ': ' + v.memo : '');
    return {
      items: [{ description: label, quantity: 1, unitPrice: v.cents / 100, total: v.cents / 100 }],
      source: 'backfill', backfilled: true, backfillKey: paymentKey(v),
      notes: label, dueDate: noonOf(v), terms: '', totalConfirmedBy: null
    };
  }
  /** The markPaid details: the payment lands on the check date, keeps method, check no., memo, proof. */
  function paymentDetails(row, proofs) {
    var v = row.v, d = { at: noonOf(v), reference: v.ref, note: v.memo, payer: 'homeowner', paymentId: paymentIdFor(v) };
    var p = (proofs || []).filter(function (x) { return x && x.path; });
    if (p.length) { d.proofStoragePath = p[0].path; d.proofName = p[0].name || 'proof'; if (p.length > 1) d.proofPaths = p.slice(1).map(function (x) { return x.path; }); }
    return d;
  }
  /** Soft void of a backfilled lead / invoice: the row is kept, a note is required. */
  function voidPatch(doc, note, by, nowMs) {
    var n = clean(note);
    if (!n) return { error: 'Say why you are voiding it.' };
    var log = Array.isArray(doc && doc.editLog) ? doc.editLog.slice() : [];
    log.push({ at: nowMs || Date.now(), by: by || null, what: 'void', source: 'payment-backfill', note: n.slice(0, 300) });
    return { patch: { deleted: true, voidNote: n.slice(0, 300), editLog: log.slice(-25) } };
  }
  function logEntry(by, what, note, nowMs) { return { at: nowMs || Date.now(), by: by || null, what: what, source: 'payment-backfill', note: clean(note).slice(0, 300) }; }

  var API = {
    CONFIG: CONFIG, METHODS: METHODS, JOB_TYPES: JOB_TYPES, STATUS_LABEL: STATUS_LABEL, POSITIONAL: POSITIONAL,
    splitTable: splitTable, parse: parse, validate: validate, parseDate: parseDate, parseCents: parseCents, parseMethod: parseMethod, parseJobType: parseJobType,
    nameScore: nameScore, sameAddress: sameAddress, paymentKey: paymentKey, paymentIdFor: paymentIdFor, leadName: leadName,
    matchCustomers: matchCustomers, paymentsIndex: paymentsIndex, findDuplicates: findDuplicates, review: review, checkAgainstCrm: checkAgainstCrm,
    buildLead: buildLead, invoiceOverrides: invoiceOverrides, paymentDetails: paymentDetails, voidPatch: voidPatch, logEntry: logEntry
  };
  if (root && typeof root === 'object') root.NBDPaymentBackfillLogic = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : null);
