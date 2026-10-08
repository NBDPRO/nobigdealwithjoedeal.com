/**
 * invoice-from-estimate.js — how a saved estimate becomes invoice lines,
 * totals and a "Bill To" name, for the SERVER (2026-10-03).
 *
 * The rep makes an invoice in the browser (docs/pro/js/invoice-pipeline.js
 * createInvoiceFromEstimate). The server now makes one too: a DRAFT deposit
 * invoice when a contract is signed (functions/deposit-draft.js). Functions
 * deploy on their own and cannot reach docs/, so the two blocks below are
 * copied from invoice-pipeline.js byte-for-byte — the same arrangement as
 * ky-insurance-law.js and customer-estimate-rows.js.
 * tests/deposit-draft-2026-10-03.test.js fails if they drift: edit the block
 * in invoice-pipeline.js, then copy it here.
 *
 * Retail only: buildRowItems maps rows at the CUSTOMER price (retailTotal,
 * else the cost split marked up, else the row total) — never a cost rate.
 */
'use strict';

  // nbd:invoice-customer-name:start — byte-identical in
  // functions/invoice-from-estimate.js (the server's draft deposit invoice,
  // 2026-10-03), pinned by tests/deposit-draft-2026-10-03.test.js.
  // ── Customer name for "Bill To" (phone audit 2026-09-25, estimate#9) ────
  // createInvoiceFromEstimate read `est.customerName || lead.name`, and
  // NEITHER field is ever written: no estimate writer stamps customerName
  // (the V2 and Classic builders both save the homeowner as `owner`), and the
  // lead writer (crm-leads.js saveLead) saves firstName/lastName, never
  // `name` — 0 of 29 leads on the rig carry it. So every invoice made from an
  // estimate stored customerName '' and printed "BILL TO: Customer" above the
  // homeowner's own email and phone. The linked lead is the customer record,
  // so its current name wins; the estimate's `owner` covers an estimate with
  // no lead. Classic saves a blank owner as '—', which is not a name.
  function _cleanName(v) {
    const s = String(v == null ? '' : v).trim();
    return /^[\s—–-]*$/.test(s) ? '' : s;
  }
  function leadDisplayName(lead) {
    if (!lead) return '';
    return _cleanName(lead.name) || _cleanName(lead.customerName)
      || _cleanName([lead.firstName, lead.lastName].filter(Boolean).join(' '));
  }
  function resolveCustomerName(est, lead) {
    est = est || {};
    return _cleanName(est.customerName) || leadDisplayName(lead) || _cleanName(est.owner);
  }
  // nbd:invoice-customer-name:end

  // nbd:invoice-from-estimate:start — how an estimate becomes invoice lines
  // and totals. Byte-identical in functions/invoice-from-estimate.js, which
  // the server's draft deposit invoice (functions/deposit-draft.js,
  // 2026-10-03) builds from, so a server draft and a rep-made invoice for the
  // same estimate carry the same lines and the same total.
  // tests/deposit-draft-2026-10-03.test.js pins the two copies.
  function numFrom(v) {
    if (typeof v === 'number') return v;
    const m = String(v == null ? '' : v).match(/-?\d[\d,]*\.?\d*/);
    return m ? parseFloat(m[0].replace(/,/g, '')) : NaN;
  }

  /**
   * The ONE rounding rule's home (2026-10-07, ho-money audit H5):
   * NBDCustomerEstimateRows.footingRows — the function the estimate link and
   * the e-sign contract print their Sales tax / Rounding rows with. The
   * browser has it on window (dashboard.html and customer.html load
   * customer-estimate-rows.js before this file); the server and the unit
   * tests require() the copy beside this file (functions/ and docs/pro/js/
   * each carry one). null only if neither loaded — then the invoice keeps
   * the subtotal-based measure it used before.
   */
  function _footingApi() {
    try {
      if (typeof window !== 'undefined' && window.NBDCustomerEstimateRows
          && typeof window.NBDCustomerEstimateRows.footingRows === 'function') return window.NBDCustomerEstimateRows;
    } catch (_) { /* fall through */ }
    try {
      if (typeof require === 'function') {
        const m = require('./customer-estimate-rows');
        if (m && typeof m.footingRows === 'function') return m;
      }
    } catch (_) { /* fall through */ }
    return null;
  }

  /**
   * Map a saved estimate's rows to invoice line items — at the CUSTOMER price.
   *
   * Post-sweep V2 saves persist the retail price in rows[].retailTotal (and in
   * rate/total). OLDER V2 saves wrote the raw COST basis (material+labor, no
   * markup, no O&P) into rate/total, so invoices printed the contractor's cost
   * under a retail subtotal — the line items summed to ~55-65% of the subtotal
   * and exposed the margin to the homeowner/adjuster (money-math sweep
   * 2026-07-18). For those docs, derive retail from the persisted split:
   * materialTotal×(1+markup) + laborTotal; rows with no cost basis
   * (pass-through fees) stay at face value. Classic rows (no markup persisted)
   * are already all-in customer prices and map exactly as before.
   *
   * When the estimate carries an O&P ladder (V2 line-item / insurance),
   * Overhead & Profit is appended as its own line — the same presentation as
   * the signed scope ("Line Item Total → +O&P") — so Σ items == subtotal.
   * The invoice's charged total is NOT computed here; the locked saved
   * grandTotal/subtotal stay authoritative in createInvoiceFromEstimate.
   */
  function buildRowItems(est) {
    const markup = Number(est && est.materialMarkupPct);
    const hasV2Pricing = Number.isFinite(markup);
    // Classic docs carry their lines on `lineItems`, V2 on `rows`. Reading
    // `rows` alone silently produced an empty item list for every Classic
    // estimate — which is how a $0 invoice got written for a $14,200 job.
    // A non-empty rows wins (it is what the contract and estimate link
    // print); an empty rows array falls through to lineItems.
    // lineItems name their fields quantity / unitPrice / amount (a logged
    // estimate saved from doc pre-flight, legacy docs). Reading only the rows
    // names (qty / rate / total) priced every such line at $0, and the pay
    // link was refused (review R6-2-1, 2026-10-07). Sales tax / Rounding
    // footing rows are never lines here: tax and the adjustment come below.
    const useRows = !!est && Array.isArray(est.rows) && est.rows.length > 0;
    const src = useRows ? est.rows : ((est && Array.isArray(est.lineItems)) ? est.lineItems : []);
    const items = src.filter(function (row) {
      return !!row && (useRows || (row.code !== 'TAX' && row.code !== 'ADJ'));
    }).map(function (row) {
      const quantity = numFrom(row.qty != null ? row.qty : row.quantity);
      const explicitRetail = (row.retailTotal != null && Number.isFinite(Number(row.retailTotal)))
        ? Number(row.retailTotal) : null;
      const hasSplit = hasV2Pricing && (row.materialTotal != null || row.laborTotal != null);
      let lineTotal, unitPrice;
      if (explicitRetail != null) {
        lineTotal = explicitRetail;
      } else if (hasSplit) {
        const mat = Number(row.materialTotal) || 0;
        const lab = Number(row.laborTotal) || 0;
        lineTotal = (mat === 0 && lab === 0) ? numFrom(row.total) : mat * (1 + markup) + lab;
      } else {
        lineTotal = numFrom(row.total != null ? row.total : row.amount);
      }
      if (explicitRetail != null || hasSplit) {
        // Retail-priced row: derive the unit price from the retail total (the
        // saved rate string on old docs is the COST rate — never print it).
        unitPrice = (Number.isFinite(quantity) && quantity !== 0 && Number.isFinite(lineTotal))
          ? lineTotal / quantity : (Number.isFinite(lineTotal) ? lineTotal : 0);
      } else {
        unitPrice = numFrom(row.rate != null ? row.rate : row.unitPrice);
        if (!Number.isFinite(unitPrice) || unitPrice === 0) {
          unitPrice = (Number.isFinite(quantity) && quantity !== 0 && Number.isFinite(lineTotal))
            ? lineTotal / quantity : 0;
        }
      }
      return {
        description: row.desc || row.description || '',
        quantity: Number.isFinite(quantity) ? quantity : 1,
        unitPrice: Math.round((unitPrice || 0) * 100) / 100,
        total: Number.isFinite(lineTotal) ? Math.round(lineTotal * 100) / 100 : 0
      };
    }).filter(function (item) {
      // A $0 line is not a charge (2026-10-07, ho-money audit M8): a catalog
      // line left at 0 LF printed "0.00 LF $0" eleven times on one bill, and
      // a $0 line is below the pay link's $1-per-line floor (stripe.js), so
      // it also blocked the link. Not billed, not printed.
      return Math.round(item.total * 100) !== 0;
    });
    const ohp = (Number(est && est.overhead) || 0) + (Number(est && est.profit) || 0);
    if (hasV2Pricing && ohp > 0 && items.length) {
      const pct = Math.round(((Number(est.overheadPct) || 0) + (Number(est.profitPct) || 0)) * 100);
      const amt = Math.round(ohp * 100) / 100;
      items.push({
        description: 'Overhead & Profit' + (pct ? ' (' + pct + '%)' : ''),
        quantity: 1,
        unitPrice: amt,
        total: amt
      });
    }
    return items;
  }

  /**
   * An estimate's invoice lines and totals, BEFORE supplements and the
   * deposit (createInvoiceFromEstimate folds those in after). Was inline in
   * createInvoiceFromEstimate; moved here unchanged so the server draft
   * (functions/deposit-draft.js) reuses it instead of a second copy.
   *   opts.estimateValue(est) — the two-shape total reader
   *     (NBDCustomerEstimateRows.estimateValue); absent → grandTotal/total/amount
   *   opts.tierLabel(key)     — customer-facing tier name
   *     (NBD_ESTIMATE_CONFIG.tierLabel); absent → the built-in names
   * → { items, subtotal, tax, taxRate, total }
   */
  function invoiceTotalsFromEstimate(est, opts) {
    est = est || {};
    opts = opts || {};
    // Audit #3 F-3: inherit the tax rate the estimate was priced at (insurance
    // scope skips tax → 0 honored; fall back to 7.5% only when no rate saved).
    const taxRate = (typeof est.taxRate === 'number') ? est.taxRate : 0.075;

    // Two-shape read, not grandTotal alone. Classic estimates (title /
    // amount|total / lineItems) carry no grandTotal, so this scored NaN,
    // hasLockedTotal went false, and buildRowItems — which mapped est.rows
    // only — returned []. Every downstream number then computed 0 and a
    // `total: 0` invoice was written to Firestore before Stripe rejected it,
    // leaving an orphan $0 draft in the AR rollups. The picker that chose the
    // estimate had shown the right figure all along; it uses estimateValue.
    const savedGrand = (typeof opts.estimateValue === 'function')
      ? opts.estimateValue(est)
      : numFrom(est.grandTotal != null ? est.grandTotal
          : est.total != null ? est.total : est.amount);
    const hasLockedTotal = Number.isFinite(savedGrand) && savedGrand > 0;
    const isPerSq = (est.priceMode === 'per-sq') || (est.prices != null);

    let items, subtotal, tax, total;
    if (isPerSq && hasLockedTotal) {
      // PER-SQ V2: the customer price is the LOCKED selected-tier grandTotal,
      // not the internal cost-basis rows. Invoice it as a single summary line
      // so the invoice total == the signed quote.
      total = savedGrand;
      // In whole cents: subtotal + tax === total exactly, never a cent apart
      // from rounding the two halves separately.
      const _totC = Math.round(total * 100);
      const _subC = Math.round((taxRate > 0 ? (total / (1 + taxRate)) : total) * 100);
      subtotal = _subC / 100;
      tax = (_totC - _subC) / 100;
      // Customer-facing name (Economy/Standard/Preferred/Elite/Beyond) from
      // the shared config — the invoice printed the raw key ("Good tier").
      const _tierKey = String(est.selectedTier || est.tier || '');
      const tierLabel = (typeof opts.tierLabel === 'function')
        ? opts.tierLabel(_tierKey)
        : (({ economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' })[_tierKey]
          || _tierKey.replace(/^./, c => c.toUpperCase()));
      items = [{
        description: 'Roofing system' + (tierLabel ? ' — ' + tierLabel + ' tier' : ''),
        quantity: 1,
        unitPrice: subtotal,
        total: subtotal
      }];
    } else {
      // Row-based (classic builder + V2 line-item/insurance). Line items map
      // at the CUSTOMER price — incl. the retail derivation for older V2 docs
      // that persisted the cost basis, and the O&P line that makes the items
      // foot to the subtotal — in buildRowItems (pure, unit-tested).
      items = buildRowItems(est);
      if (hasLockedTotal) {
        // Trust the estimate's saved locked totals — the signed quote bakes in
        // the job-minimum floor + nearest-$25 rounding that a naive row-sum
        // recompute would drop, making the invoice disagree with the quote.
        total = savedGrand;
        const savedSub = Number(est.subtotal);
        // Classic builder saves `taxAmount`; V2 (estimate-v2-ui.js) saves the
        // SAME value under `tax` instead — a field-naming mismatch, not a
        // missing value. Reading only `taxAmount` made every V2 doc read NaN
        // here and fall through to `total - subtotal`, which is real tax ONLY
        // for a non-insurance job; for insurance (taxRate 0, true tax exactly
        // $0) that fallback instead measures the nearest-$25 ROUNDING NOISE
        // baked into `total` — negative about half the time (round-down),
        // and a fabricated positive "tax" on a tax-exempt invoice the other
        // half (round-up). `??` (not `||`) so an explicit 0 is trusted, not
        // treated as missing.
        const savedTax = Number(est.taxAmount ?? est.tax);
        subtotal = Number.isFinite(savedSub) ? savedSub : (taxRate > 0 ? total / (1 + taxRate) : total);
        tax = Number.isFinite(savedTax) ? savedTax : (total - subtotal);
        subtotal = Math.round(subtotal * 100) / 100;
        tax = Math.round(tax * 100) / 100;
        // The quote prints total − subtotal − tax as its own row: the
        // nearest-$25 rounding or the job-minimum lift (estimate-v2-ui.js /
        // estimate-finalization.js, same rule, same label). Without it the
        // lines + tax fell short of the total and createStripePaymentLink
        // refused the link ($120 material / $250 labor at 7%: $525 quoted,
        // $513.60 of lines + tax). Untaxed — tax is already the quote's.
        // adjustment:true lets the pay link take either sign (stripe.js).
        //
        // The cents come from THE rounding rule (footingRows, 2026-10-07):
        // measured from the printed lines when they sit within $1 of the
        // saved subtotal. Measuring from the subtotal (as this did) put the
        // invoice a cent off the estimate link whenever the engine's per-row
        // rounding left the lines a cent from the subtotal — KY audit shape:
        // estimate link "Rounding −$4.96", invoice "Rounding −$4.95" — and
        // the invoice's own lines + tax + rounding then missed its total by
        // that cent. The subtotal follows: lines + tax + rounding === total.
        let adjCents = Math.round(total * 100) - Math.round(subtotal * 100) - Math.round(tax * 100);
        const _F = _footingApi();
        if (_F) {
          const _foot = _F.footingRows({ grandTotal: total, subtotal: subtotal, tax: tax, taxRate: taxRate }, items);
          const _adj = _foot.filter(function (r) { return r.code === 'ADJ'; })[0];
          adjCents = _adj ? Math.round(_adj.total * 100) : 0;
          subtotal = (Math.round(total * 100) - Math.round(tax * 100) - adjCents) / 100;
        }
        if (adjCents !== 0) {
          items.push({
            description: (est.minJobApplied && adjCents > 0) ? 'Minimum job charge adjustment' : 'Rounding',
            quantity: 1,
            unitPrice: adjCents / 100,
            total: adjCents / 100,
            adjustment: true,
            taxable: false
          });
        }
      } else {
        // Whole cents (2026-10-07): an unrounded tax / total printed a
        // total a cent off subtotal + tax.
        const _subC = items.reduce((sum, item) => sum + Math.round(item.total * 100), 0);
        const _taxC = Math.round(_subC * taxRate);
        subtotal = _subC / 100;
        tax = _taxC / 100;
        total = (_subC + _taxC) / 100;
      }
    }
    return { items, subtotal, tax, taxRate, total };
  }

  /**
   * The rows a HOMEOWNER reads on an invoice — the emailed invoice
   * (buildInvoiceHtml), the in-app / printed invoice (renderInvoiceDetail)
   * and the NBD-500 PDF (functions/money-paper-logic.js invoicePayload) —
   * in order, adding up to the total shown (2026-10-07, ho-money audit H1).
   *
   * The email printed the items and then "Total", with no Sales tax row: a
   * $13,675 job's lines summed to $12,780.09 under a $13,675.00 total (the
   * $894.91 tax was never printed), and a per-SQ job read "Roofing system —
   * Elite tier $22,102.80" over $23,650.00. Now:
   *   lines (no $0 lines) → Subtotal → Sales tax (r%) → Rounding / Minimum
   *   job charge adjustment → [Job total → each "Less deposit …" credit] →
   *   Total
   * The adjustment is THE rounding rule (footingRows) over the printed
   * lines, so the invoice says the same Rounding as the estimate link; an
   * invoice saved before that rule (subtotal-based, a cent off) prints the
   * corrected cent, so its rows add up too.
   *
   * → [{ kind, label, amount, quantity?, unitPrice? }], amount in dollars
   *   (whole cents). kind: 'line' | 'subtotal' | 'tax' | 'adjustment' |
   *   'jobTotal' | 'credit' | 'total'. subtotal / jobTotal / total are
   *   running totals; Σ line + tax + adjustment + credit === total, in cents
   *   (an old invoice whose lines sit more than $1 from its saved subtotal
   *   is printed as saved — a real gap is never relabelled Rounding).
   */
  function invoiceDisplayRows(inv) {
    inv = inv || {};
    const c = function (v) { const n = Math.round(Number(v) * 100); return Number.isFinite(n) ? n : 0; };
    const items = (Array.isArray(inv.items) ? inv.items : []).filter(Boolean);
    const lines = items.filter(function (it) { return it.credit !== true && it.adjustment !== true && c(it.total) !== 0; });
    const credits = items.filter(function (it) { return it.credit === true && c(it.total) !== 0; });
    const adjItem = items.filter(function (it) { return it.adjustment === true; })[0] || null;
    const linesC = lines.reduce(function (s, it) { return s + c(it.total); }, 0);
    const creditC = credits.reduce(function (s, it) { return s + c(it.total); }, 0); // ≤ 0
    const taxC = c(inv.tax);
    const totalC = c(inv.total);
    const jobC = totalC - creditC;
    const rate = Number(inv.taxRate);
    let adjC = jobC - linesC - taxC;
    const F = _footingApi();
    if (F && inv.subtotal != null && inv.subtotal !== '' && Number.isFinite(Number(inv.subtotal)) && jobC > 0) {
      const foot = F.footingRows({ grandTotal: jobC / 100, subtotal: Number(inv.subtotal), tax: taxC / 100, taxRate: rate }, lines);
      const adj = foot.filter(function (r) { return r.code === 'ADJ'; })[0];
      adjC = adj ? c(adj.total) : 0;
    }
    const baseC = jobC - taxC - adjC;
    const rows = lines.map(function (it) {
      const q = Number(it.quantity);
      return {
        kind: 'line',
        label: String(it.description || 'Line item'),
        quantity: Number.isFinite(q) ? q : 1,
        unitPrice: c(it.unitPrice) / 100,
        amount: c(it.total) / 100
      };
    });
    rows.push({ kind: 'subtotal', label: 'Subtotal', amount: baseC / 100 });
    if (taxC !== 0) {
      const pct = (Number.isFinite(rate) && rate > 0) ? String(Math.round(rate * 100000) / 1000) + '%' : '';
      rows.push({ kind: 'tax', label: 'Sales tax' + (pct ? ' (' + pct + ')' : ''), amount: taxC / 100 });
    }
    if (adjC !== 0) {
      rows.push({ kind: 'adjustment', label: adjItem ? String(adjItem.description || 'Rounding') : 'Adjustment', amount: adjC / 100 });
    }
    if (credits.length) {
      rows.push({ kind: 'jobTotal', label: 'Job total', amount: jobC / 100 });
      credits.forEach(function (it) {
        rows.push({ kind: 'credit', label: String(it.description || 'Less deposit paid'), amount: c(it.total) / 100 });
      });
    }
    rows.push({ kind: 'total', label: 'Total', amount: totalC / 100 });
    return rows;
  }
  // nbd:invoice-from-estimate:end

  // nbd:job-billing:start — ONE live invoice per job, and a final invoice
  // that credits what the job was already billed (2026-10-03). Byte-identical
  // in functions/invoice-from-estimate.js (the server's install-day final
  // draft), pinned by tests/money-getting-paid-2026-10-03.test.js.
  //
  // createInvoiceFromEstimate billed the full estimate every time, with no
  // look at the job's other invoices — including the draft deposit invoice
  // the server makes on a signed contract — so a second tap billed the job
  // twice. Now:
  //   - a LIVE invoice (not paid / void / cancelled / deleted) that bills the
  //     whole job is opened instead of making another;
  //   - otherwise a new invoice is the FINAL one: each earlier invoice for
  //     the job (a paid deposit, or a deposit invoice already issued) is
  //     credited as its own "Less deposit …" line, so the total due is what
  //     is actually left;
  //   - nothing is made when those invoices already bill the whole job.
  // A credit line carries credit:true and a negative total; the online pay
  // link charges the balance as one line (functions/stripe.js).
  var JOB_BILLING_DEAD = { void: 1, voided: 1, cancelled: 1, canceled: 1, uncollectible: 1 };
  function _jbCents(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  function _jbJobId(v) {
    return (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v)) ? v : null;
  }
  function _jbMs(v) {
    if (!v) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
  }
  /**
   * This job's invoices: not deleted / void / cancelled; the same job, or —
   * when either side has no job stamp — an unpaid one (a PAID invoice with
   * no job stamp is an earlier job's history). The deposit draft's filter
   * (functions/deposit-draft-logic.js). Oldest first.
   *
   * opts (2026-10-05) = { soleJob, since }: a PAID invoice with no job stamp
   * — a deposit mirrored in from the Stripe dashboard (stripe-ledger-logic.js
   * mirrorInvoice never knew the job) — IS this job's when the customer has
   * exactly ONE job (soleJob: the caller read leads/{id}/jobs, see soleJobOf)
   * AND it was made on or after this job's estimate (since = the estimate's
   * createdAt), so an earlier roof's payment never credits this one. With two
   * or more jobs, or no estimate date, it stays out as before: the final
   * invoice then shows no credit for it (visible on the paper, the rep fixes
   * it) — never a silent credit to the wrong job.
   */
  function jobInvoicesOf(invoices, jobId, opts) {
    const jid = _jbJobId(jobId);
    const o = opts || {};
    const sinceMs = _jbMs(o.since);
    const adopt = !!jid && o.soleJob === true && sinceMs > 0;
    return (Array.isArray(invoices) ? invoices : []).filter(function (inv) {
      if (!inv || inv.deleted === true || inv.deletedAt) return false;
      const st = String(inv.status || '').toLowerCase();
      if (JOB_BILLING_DEAD[st]) return false;
      const ij = _jbJobId(inv.jobId);
      if (jid && ij) return ij === jid;
      if (st !== 'paid') return true;
      return adopt && !ij && _jbMs(inv.createdAt) >= sinceMs;
    }).sort(function (a, b) { return _jbMs(a.createdAt) - _jbMs(b.createdAt); });
  }
  /**
   * soleJobOf(jobs, jobId) — true when leads/{id}/jobs (not deleted) holds
   * exactly one job and it is jobId. Unread / empty / two or more → false.
   */
  function soleJobOf(jobs, jobId) {
    const jid = _jbJobId(jobId);
    const live = (Array.isArray(jobs) ? jobs : []).filter(function (j) { return j && j.deleted !== true; });
    return !!jid && live.length === 1 && live[0].id === jid;
  }
  /** Live = still in play for its job: anything but paid (after jobInvoicesOf). */
  function isLiveInvoice(inv) {
    return !!inv && String(inv.status || '').toLowerCase() !== 'paid';
  }
  /**
   * planJobInvoice(jobTotalCents, invoices, jobId, opts) — what billing this
   * job needs now (opts: jobInvoicesOf's).
   *  → { action: 'open', invoiceId, reason: 'live_invoice' }
   *      a live invoice bills the whole job: use it (with no job total to
   *      compare, any live invoice for the job is the job's bill);
   *  | { action: 'open', invoiceId, reason: 'billed_in_full' }
   *      earlier invoices already bill the whole job;
   *  | { action: 'create', credits: [{ invoiceId, label, cents, paid }], creditCents }
   */
  function planJobInvoice(jobTotalCents, invoices, jobId, opts) {
    const mine = jobInvoicesOf(invoices, jobId, opts);
    const totalC = Math.max(0, Math.round(Number(jobTotalCents) || 0));
    const covering = mine.filter(function (inv) {
      return isLiveInvoice(inv) && (totalC === 0 || _jbCents(inv.total) >= totalC);
    });
    if (covering.length) return { action: 'open', invoiceId: covering[0].id || null, reason: 'live_invoice' };
    const credits = [];
    let creditCents = 0;
    mine.forEach(function (inv) {
      const c = _jbCents(inv.total);
      if (!(c > 0)) return;
      const paid = String(inv.status || '').toLowerCase() === 'paid' || _jbCents(inv.amountPaid) >= c;
      credits.push({ invoiceId: inv.id || null, label: paid ? 'Less deposit paid' : 'Less deposit invoiced', cents: c, paid: paid });
      creditCents += c;
    });
    if (totalC > 0 && creditCents >= totalC) {
      return { action: 'open', invoiceId: mine.length ? (mine[mine.length - 1].id || null) : null, reason: 'billed_in_full' };
    }
    return { action: 'create', credits: credits, creditCents: creditCents };
  }
  /**
   * The final invoice's lines and total: one negative "Less deposit …" line
   * per credit (credit: true), total = the job total − the credits. Subtotal
   * and tax stay the job's own, so the paper shows what the job costs and
   * what is left to pay.
   */
  function applyJobCredits(base, credits) {
    base = base || {};
    const items = (Array.isArray(base.items) ? base.items : []).slice();
    let creditC = 0;
    (Array.isArray(credits) ? credits : []).forEach(function (cr) {
      const c = Math.max(0, Math.round(Number(cr && cr.cents) || 0));
      if (!c) return;
      creditC += c;
      items.push({
        description: String(cr.label || 'Less deposit paid') + (cr.invoiceId ? ' (invoice ' + String(cr.invoiceId).slice(0, 12) + ')' : ''),
        quantity: 1,
        unitPrice: -c / 100,
        total: -c / 100,
        credit: true,
        creditInvoiceId: cr.invoiceId || null
      });
    });
    const totalC = Math.max(0, _jbCents(base.total) - creditC);
    return Object.assign({}, base, { items: items, total: totalC / 100, creditTotal: creditC / 100 });
  }
  // nbd:job-billing:end

module.exports = {
  numFrom, buildRowItems, invoiceTotalsFromEstimate, invoiceDisplayRows, resolveCustomerName, leadDisplayName,
  jobInvoicesOf, soleJobOf, isLiveInvoice, planJobInvoice, applyJobCredits,
};
