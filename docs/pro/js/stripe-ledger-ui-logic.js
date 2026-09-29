/**
 * stripe-ledger-ui-logic.js — pure rules for the CRM's Stripe ledger screens
 * (no DOM, no Firestore). Used by stripe-ledger-panel.js (Money view → Stripe
 * panel, review list, sync preview) and stripe-ledger-customer.js (the
 * customer page's Stripe Payments section). Pinned by
 * tests/stripe-ledger-ui-2026-09-29.test.js.
 *
 * Jo (2026-09-29): "Every transaction from Stripe makes its way back to the
 * CRM, recorded, linked to the customers in the CRM under their names."
 * functions/stripe-ledger.js writes stripeLedger/{stripeObjectId}; these
 * helpers turn those rows into what the screens show.
 *
 * Everything that ends up in innerHTML goes through esc() (Stripe customer
 * names and emails are public input) and every link through safeUrl()
 * (http/https only).
 */
(function (root) {
  'use strict';

  const TZ = 'America/New_York';   // house convention (money-dashboard etYear)

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Only a plain web link may become an href. javascript:, data: and
  // protocol-relative values come back null.
  function safeUrl(u) {
    const s = String(u == null ? '' : u).trim();
    return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : null;
  }

  function int(v) { const n = parseInt(v, 10); return isFinite(n) ? n : 0; }

  // $1,234.56 / −$12.00 (U+2212 so a refund reads as a minus, not a hyphen).
  function fmtMoney(cents) {
    const c = int(cents);
    const abs = (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (c < 0 ? '−$' : '$') + abs;
  }

  // ── roles + tenant ───────────────────────────────────────────────────
  // Tenant = the company the signed-in user belongs to, or their own uid
  // for a solo owner (expenses.js companyId()).
  function tenantOf(claims, uid) {
    const c = claims || {};
    return c.companyId || uid || null;
  }
  // firestore.rules §stripeLedger: the owner (row.userId == uid), same-company
  // company_admin / manager, or a platform admin. Sales reps and viewers cannot
  // read the ledger, so they never see the panel.
  function canRead(claims, uid) {
    if (!uid) return false;
    const r = (claims || {}).role || '';
    return r !== 'sales_rep' && r !== 'viewer';
  }
  // The callables (assign, sync, balance) take the account owner, the
  // owner's company_admin, or a platform admin (functions/stripe-ledger.js
  // requireOwner). A manager reads but does not write.
  function canWrite(claims, uid) {
    if (!uid) return false;
    const c = claims || {};
    const r = c.role || '';
    if (r === 'sales_rep' || r === 'viewer' || r === 'manager') return false;
    if (r === 'admin' || r === 'company_admin') return true;
    return tenantOf(c, uid) === uid;   // the solo owner of their own tenant
  }

  // ── queries (rule-safe: every one is scoped to the tenant) ───────────
  // Descriptors, applied by applyQuery with the dashboard's SDK globals.
  function ledgerQuery(tenant, n) {
    return { collection: 'stripeLedger', where: [['companyId', '==', tenant]], orderBy: ['atMs', 'desc'], limit: n || 200 };
  }
  // Equality-only (companyId + needsReview): no composite index needed.
  function reviewQuery(tenant) {
    return { collection: 'stripeLedger', where: [['companyId', '==', tenant], ['needsReview', '==', true]] };
  }
  // Equality-only (companyId + match.leadId): sorted on the client.
  function customerQuery(tenant, leadId) {
    return { collection: 'stripeLedger', where: [['companyId', '==', tenant], ['match.leadId', '==', leadId]] };
  }
  function applyQuery(desc, fb) {
    const parts = desc.where.map(function (w) { return fb.where(w[0], w[1], w[2]); });
    if (desc.orderBy) parts.push(fb.orderBy(desc.orderBy[0], desc.orderBy[1]));
    if (desc.limit) parts.push(fb.limit(desc.limit));
    return fb.query.apply(null, [fb.collection(fb.db, desc.collection)].concat(parts));
  }

  // ── labels ───────────────────────────────────────────────────────────
  const METHOD = {
    card: 'Card', apple_pay: 'Apple Pay', google_pay: 'Google Pay', link: 'Link',
    us_bank_account: 'Bank (ACH)', cashapp: 'Cash App', marked_paid_in_stripe: 'Marked paid in Stripe',
    stripe: 'Stripe', standard: 'Standard payout', instant: 'Instant payout',
  };
  function titleCase(s) {
    return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function methodLabel(row) {
    const r = row || {};
    const base = METHOD[r.method] || (r.method ? titleCase(r.method) : '');
    if ((r.method === 'card' || r.method === 'apple_pay' || r.method === 'google_pay') && r.last4) {
      return base + ' ···· ' + String(r.last4).replace(/[^0-9]/g, '').slice(-4) + (r.brand ? ' (' + titleCase(r.brand) + ')' : '');
    }
    return base;
  }
  const KIND = {
    charge: 'Payment', refund: 'Refund', dispute: 'Dispute', payout: 'Payout',
    invoice_paid_outside_stripe: 'Paid outside Stripe', platform_subscription: 'NBD Pro subscription',
  };
  function kindLabel(kind) { return KIND[kind] || titleCase(kind) || 'Transaction'; }

  // tone: good | bad | warn | info | muted
  function statusChip(row) {
    const r = row || {};
    const st = String(r.status || '');
    if (r.kind === 'platform_subscription') return { label: 'Subscription', tone: 'muted' };
    if (r.kind === 'dispute') return { label: 'Dispute · ' + titleCase(st || 'open'), tone: st === 'won' ? 'good' : 'bad' };
    if (r.kind === 'refund') return { label: st === 'succeeded' ? 'Refunded' : 'Refund · ' + titleCase(st), tone: st === 'failed' ? 'bad' : 'warn' };
    if (r.kind === 'payout') return { label: 'Payout · ' + titleCase(st), tone: st === 'failed' ? 'bad' : st === 'paid' ? 'info' : 'muted' };
    if (r.kind === 'invoice_paid_outside_stripe') return { label: 'Paid (outside Stripe)', tone: 'info' };
    if (st === 'succeeded') return r.needsReview ? { label: 'Paid · needs review', tone: 'warn' } : { label: 'Paid', tone: 'good' };
    if (st === 'failed') return { label: 'Failed', tone: 'bad' };
    if (st === 'pending') return { label: 'Pending', tone: 'warn' };
    return { label: titleCase(st) || '—', tone: 'muted' };
  }

  function leadNameOf(lead) {
    if (!lead) return '';
    const n = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim();
    return n || lead.name || '';
  }
  function leadsIndex(leads) {
    const m = {};
    (leads || []).forEach(function (l) { if (l && l.id && !l.deleted) m[l.id] = l; });
    return m;
  }

  function dateText(ms) {
    const n = Number(ms);
    if (!(n > 0)) return '';
    return new Date(n).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });
  }

  /**
   * One ledger row → what a list line shows. leadsById resolves the matched
   * lead's CURRENT name (a rename after matching shows the new name); the
   * row's own match.leadName is the fallback when the lead is not loaded.
   */
  function displayRow(row, leadsById) {
    const r = row || {};
    const m = r.match || {};
    const p = r.party || {};
    const lead = m.leadId && leadsById ? leadsById[m.leadId] : null;
    const matched = !!(m.leadId && m.confidence === 'high');
    const matchedName = matched ? (leadNameOf(lead) || m.leadName || '') : '';
    const partyName = p.name || p.email || '';
    const amount = int(r.amountCents);
    const fee = r.feeCents == null ? null : int(r.feeCents);
    return {
      id: r.id || null,
      kind: r.kind || null,
      kindLabel: kindLabel(r.kind),
      atMs: Number(r.atMs) || 0,
      dateText: dateText(r.atMs),
      leadId: matched ? m.leadId : null,
      name: matchedName || partyName || (r.kind === 'payout' ? 'To your bank' : r.kind === 'platform_subscription' ? (partyName || 'NBD Pro subscriber') : 'Unknown payer'),
      matched: matched,
      // "unmatched" is only meaningful for money from a customer.
      unmatched: !matched && r.kind !== 'payout' && r.kind !== 'platform_subscription',
      amountCents: amount,
      amountText: fmtMoney(amount),
      negative: amount < 0,
      feeCents: fee,
      feeText: fee == null ? '' : fmtMoney(fee),
      netText: r.netCents == null ? '' : fmtMoney(r.netCents),
      method: methodLabel(r),
      chip: statusChip(r),
      needsReview: !!r.needsReview,
      receiptUrl: safeUrl(r.receiptUrl),
      stripeUrl: safeUrl(r.stripeHostedUrl),
      invoiceId: m.invoiceId || null,
      invoiceNumber: r.nbdInvoiceNumber || r.stripeInvoiceNumber || null,
      failure: r.failure || null,
      description: r.description || null,
    };
  }

  // ── this month's Stripe collected ────────────────────────────────────
  function monthKey(ms) {
    const n = Number(ms);
    if (!(n > 0)) return null;
    return new Date(n).toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7);   // YYYY-MM in ET
  }
  /**
   * Gross / fees / net of the customer card, wallet and bank payments that
   * succeeded this month (ET). NBD Pro subscription charges are platform
   * revenue, not customer jobs, and are a separate kind — never counted.
   * Failed and pending charges moved no money. Refunds are reported beside
   * the total (not netted into it), so the gross matches Stripe's "payments".
   */
  function monthTotals(rows, nowMs) {
    const key = monthKey(nowMs || Date.now());
    const t = { month: key, grossCents: 0, feeCents: 0, netCents: 0, count: 0, refundCents: 0, refundCount: 0 };
    (rows || []).forEach(function (r) {
      if (!r || monthKey(r.atMs) !== key) return;
      if (r.kind === 'charge' && r.status === 'succeeded') {
        const amt = int(r.amountCents);
        if (amt <= 0) return;
        const fee = int(r.feeCents);
        t.grossCents += amt;
        t.feeCents += fee;
        t.netCents += (r.netCents == null ? amt - fee : int(r.netCents));
        t.count += 1;
      } else if (r.kind === 'refund' && r.status !== 'failed' && r.status !== 'canceled') {
        t.refundCents += Math.abs(int(r.amountCents));
        t.refundCount += 1;
      }
    });
    return t;
  }

  // ── review list ──────────────────────────────────────────────────────
  function reviewRows(rows) {
    return (rows || [])
      .filter(function (r) { return r && r.needsReview === true && r.kind !== 'platform_subscription'; })
      .slice()
      .sort(function (a, b) { return (Number(b.atMs) || 0) - (Number(a.atMs) || 0); });
  }
  // assignStripeTransaction takes only a completed payment.
  function canAssign(row) {
    const r = row || {};
    return (r.kind === 'charge' || r.kind === 'invoice_paid_outside_stripe') && r.status === 'succeeded' && int(r.amountCents) > 0;
  }
  // The matcher's pick first, then the other candidates — resolved to names,
  // dropping ids no longer in the CRM.
  function suggestionsFor(row, leadsById) {
    const m = (row && row.match) || {};
    const ids = [];
    if (m.leadId) ids.push(m.leadId);
    (Array.isArray(m.candidates) ? m.candidates : []).forEach(function (id) { if (id && ids.indexOf(id) === -1) ids.push(id); });
    return ids
      .map(function (id) {
        const l = leadsById && leadsById[id];
        if (l) return { leadId: id, name: leadNameOf(l) || 'Unnamed customer', address: l.address || '' };
        // Leads not loaded on this screen: the matcher's own pick still has
        // the name it stamped on the row.
        if (id === m.leadId && m.leadName) return { leadId: id, name: m.leadName, address: '' };
        return null;
      })
      .filter(Boolean)
      .slice(0, 5);
  }

  // "Search customer…": name, address or phone (digits). Needs 2+ characters.
  function searchLeads(leads, q, max) {
    const s = String(q || '').trim().toLowerCase();
    if (s.length < 2) return [];
    const digits = s.replace(/\D/g, '');
    const out = [];
    for (const l of leads || []) {
      if (!l || !l.id || l.deleted) continue;
      const name = leadNameOf(l).toLowerCase();
      const addr = String(l.address || '').toLowerCase();
      const phone = String(l.phone || '').replace(/\D/g, '');
      const hit = name.indexOf(s) !== -1 || addr.indexOf(s) !== -1 || (digits.length >= 3 && phone.indexOf(digits) !== -1);
      if (hit) out.push({ leadId: l.id, name: leadNameOf(l) || 'Unnamed customer', address: l.address || '', phone: l.phone || '' });
      if (out.length >= (max || 8)) break;
    }
    return out;
  }

  // ── Sync from Stripe: the dry-run preview ────────────────────────────
  // Buckets, in the order the preview lists them.
  const BUCKETS = [
    ['creates', 'Creates a CRM invoice + records the payment'],
    ['records', 'Recorded on an existing CRM invoice'],
    ['review', 'Needs review (you pick the customer)'],
    ['linked', 'Already in the CRM (linked, not counted twice)'],
    ['ledger', 'Ledger only (no money booked)'],
  ];
  function bucketOf(kind, row) {
    const a = String(row.action || '');
    if (/created CRM invoice/.test(a)) return 'creates';
    if (/recorded/.test(a)) return 'records';
    if (kind === 'dispute') return 'review';
    if (/needs review/.test(a)) return 'review';
    if (/already_recorded|credited_by_payment_link_path|already_recorded_by_hand/.test(a)) return 'linked';
    return 'ledger';
  }
  function amountCentsOf(v) { return Math.round((parseFloat(v) || 0) * 100); }
  /**
   * stripeLedgerSync's result → the preview table. Each source row is
   * { id, kind, status, amount (dollars), date, customer, match, action,
   * invoiceId }; refunds / disputes / payouts carry fewer fields.
   */
  function previewModel(res, leadsById) {
    const r = res || {};
    const lines = [];
    const add = function (list, kindDefault) {
      (Array.isArray(list) ? list : []).forEach(function (x) {
        if (!x) return;
        const kind = x.kind || kindDefault;
        const m = x.match || {};
        const lead = m.leadId && leadsById ? leadsById[m.leadId] : null;
        const who = m.leadId ? (m.name || leadNameOf(lead) || 'CRM customer') : '';
        const sugg = !m.leadId && Array.isArray(m.candidates) && m.candidates.length
          ? m.candidates.length + ' possible match' + (m.candidates.length === 1 ? '' : 'es') : '';
        lines.push({
          id: x.id || '',
          kind: kind,
          kindLabel: kindLabel(kind),
          date: x.date || '',
          customer: x.customer || '',
          amountCents: amountCentsOf(x.amount),
          amountText: fmtMoney(amountCentsOf(x.amount)),
          status: x.status || '',
          where: who || sugg || (kind === 'payout' ? 'Bank' : '—'),
          confidence: m.confidence || null,
          action: x.action || (kind === 'refund' ? (m.leadId ? 'noted on the customer' : 'ledger only') : 'ledger only'),
          bucket: bucketOf(kind, x),
          invoiceId: x.invoiceId || null,
        });
      });
    };
    add(r.charges, 'charge'); add(r.invoices, 'invoice_paid_outside_stripe');
    add(r.refunds, 'refund'); add(r.disputes, 'dispute'); add(r.payouts, 'payout');
    const groups = BUCKETS.map(function (b) {
      const rows = lines.filter(function (l) { return l.bucket === b[0]; })
        .sort(function (a, c) { return String(c.date).localeCompare(String(a.date)); });
      // A money total only means something for groups that book (or would
      // book) customer money; the ledger-only group mixes payouts,
      // subscriptions and refunds.
      return { key: b[0], label: b[1], rows: rows, count: rows.length, showTotal: b[0] !== 'ledger',
        cents: rows.reduce(function (s, l) { return s + (l.kind === 'payout' ? 0 : l.amountCents); }, 0) };
    });
    const count = function (k) { return groups.filter(function (g) { return g.key === k; })[0].count; };
    const t = r.totals || {};
    return {
      dryRun: t.dryRun !== false,
      total: lines.length,
      creates: count('creates'), records: count('records'), review: count('review'),
      linked: count('linked'), ledger: count('ledger'),
      collectedCents: amountCentsOf(t.collected),
      bookedCount: int(t.booked),
      needsReviewCount: int(t.needsReview),
      groups: groups,
    };
  }

  // ── CRM invoices mirrored from Stripe ────────────────────────────────
  /**
   * "From Stripe" chip + Open in Stripe / PDF links for an invoice the ledger
   * created (source:'stripe'). '' for every other invoice.
   */
  function stripeInvoiceBadgeHtml(inv) {
    const i = inv || {};
    if (i.source !== 'stripe') return '';
    const hosted = safeUrl(i.stripeHostedUrl);
    const pdf = safeUrl(i.stripePdfUrl);
    const num = i.nbdInvoiceNumber || i.stripeInvoiceNumber || '';
    const link = 'color:var(--blue,#3b82f6);font-size:11px;font-weight:700;text-decoration:none;white-space:nowrap;';
    return '<span class="nbd-stripe-src" style="display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:3px;">' +
      '<span style="background:color-mix(in srgb,#635bff 16%,transparent);color:#8b85ff;font-size:10px;font-weight:800;padding:2px 7px;border-radius:999px;letter-spacing:.03em;white-space:nowrap;">From Stripe</span>' +
      (num ? '<span style="font-size:11px;color:var(--m,#9ca3af);">' + esc(num) + '</span>' : '') +
      (hosted ? '<a href="' + esc(hosted) + '" target="_blank" rel="noopener noreferrer" style="' + link + '">Open in Stripe ↗</a>' : '') +
      (pdf ? '<a href="' + esc(pdf) + '" target="_blank" rel="noopener noreferrer" style="' + link + '">PDF ↗</a>' : '') +
      '</span>';
  }

  const api = {
    TZ, esc, safeUrl, fmtMoney, tenantOf, canRead, canWrite,
    ledgerQuery, reviewQuery, customerQuery, applyQuery,
    methodLabel, kindLabel, statusChip, leadNameOf, leadsIndex, dateText, displayRow,
    monthKey, monthTotals, reviewRows, canAssign, suggestionsFor, searchLeads,
    previewModel, stripeInvoiceBadgeHtml,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDStripeLedgerLogic = api;
})(typeof window !== 'undefined' ? window : null);
