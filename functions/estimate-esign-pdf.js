/**
 * functions/estimate-esign-pdf.js — the estimate a homeowner signs, as a PDF
 * with its own signature fields.
 *
 * Replaces the BoldSign body (retired 2026-10-04). BoldSign was sent the
 * CLIENT's retail-quote HTML and put its signature box at fixed coordinates on
 * page 1. This builds the contract on the server from the STORED estimate —
 * the same customer-facing numbers the homeowner's estimate link shows
 * (customer-estimate-rows.js, the retail ladder that never leaks cost) — and
 * because it lays the page out itself, it knows exactly where each signer's
 * signature and date boxes are. No guessing, no client-supplied document.
 *
 * Also in the document, because this is a home-solicitation sale:
 *   - the 16 CFR 429.1(a) statement, bold, immediately above the signatures
 *   - two completed FTC NOTICE OF CANCELLATION forms. Their date and
 *     deadline are SYSTEM fields: blank (with a note) while the homeowner
 *     reads, filled in by the server with the signing date when the last
 *     signer signs — so the executed copy carries a completed form dated the
 *     day of the transaction.
 * Kentucky insurance jobs never reach this file — sendEstimateEnvelope refuses
 * them (KRS 367.624 notices are on the deal page and the generated contract).
 *
 * Pure: input object in, { bytes, pages, fields, systemFields } out. No I/O.
 * Money arrives in CENTS and is formatted here; nothing is recomputed.
 */
'use strict';

const KyLaw = require('./ky-insurance-law');

let _pdfLib = null;
function pdfLib() {
  if (!_pdfLib) _pdfLib = require('pdf-lib');
  return _pdfLib;
}

const W = 612;
const H = 792;
const M = 54;
const BODY = 10;

function winAnsi(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/ /g, ' ')
    .replace(/[^\x09\x0A\x0D\x20-\x7E¡-ÿ]/g, '');
}

/** Cents → "$12,345.67". Integer math; the input is never re-derived. */
function money(cents) {
  const c = Math.round(Number(cents) || 0);
  const neg = c < 0;
  const abs = Math.abs(c);
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + '$' + dollars + '.' + String(abs % 100).padStart(2, '0');
}

function wrap(font, text, size, width) {
  const out = [];
  String(text).split(/\n/).forEach((para) => {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    words.forEach((w) => {
      const next = line ? line + ' ' + w : w;
      if (!line || font.widthOfTextAtSize(next, size) <= width) line = next;
      else { out.push(line); line = w; }
    });
    out.push(line);
  });
  return out;
}

class Layout {
  constructor(doc, fonts) { this.doc = doc; this.f = fonts; this.page = null; this.pageIndex = -1; this.y = 0; }
  newPage() { this.page = this.doc.addPage([W, H]); this.pageIndex += 1; this.y = H - M; return this; }
  ensure(h) { if (this.y - h < M) this.newPage(); return this; }
  text(t, o) {
    const opts = Object.assign({ size: BODY, bold: false, gap: 4, x: M, width: W - 2 * M, color: [0.07, 0.08, 0.12] }, o || {});
    const font = opts.bold ? this.f.bold : this.f.reg;
    wrap(font, winAnsi(t), opts.size, opts.width).forEach((ln) => {
      this.ensure(opts.size * 1.4);
      this.page.drawText(ln, { x: opts.x, y: this.y - opts.size, size: opts.size, font, color: pdfLib().rgb(...opts.color) });
      this.y -= opts.size * 1.38;
    });
    this.y -= opts.gap;
    return this;
  }
  rule(gray) {
    this.ensure(10);
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: W - M, y: this.y }, thickness: 0.7, color: pdfLib().rgb(gray || 0.75, gray || 0.75, gray || 0.78) });
    this.y -= 10;
    return this;
  }
  textHeight(t, size, bold, width) {
    return wrap(bold ? this.f.bold : this.f.reg, winAnsi(t), size, width || (W - 2 * M)).length * size * 1.38;
  }
}

/**
 * input = {
 *   companyName, sellerAddress, title, estimateNumber, preparedDate (string),
 *   customer: { name, address, phone, email },
 *   lines: [{ name, quantity, lineTotalCents }], tierName, totalCents,
 *   depositPlan: { label, valueText, summary, rows: [{ label, due, amountText }] } | null,
 *   signers: [{ id, name }],
 * }
 */
async function buildEstimateContractPdf(input) {
  const i = input || {};
  const signers = Array.isArray(i.signers) && i.signers.length ? i.signers : [{ id: 'signer', name: '' }];
  const { PDFDocument, StandardFonts, rgb } = pdfLib();
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsi(i.title || 'Roofing Contract'));
  doc.setProducer('NBD Pro e-sign');
  const fonts = { reg: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const L = new Layout(doc, fonts);
  const company = i.companyName || 'No Big Deal Home Solutions';

  // ── Header ─────────────────────────────────────────────────────────────
  L.newPage()
    .text(company, { size: 16, bold: true, gap: 2 })
    .text(i.title || 'Roofing Contract', { size: 13, bold: true, gap: 2 })
    .text([i.estimateNumber ? 'Estimate #' + i.estimateNumber : '', i.preparedDate ? 'Prepared ' + i.preparedDate : '']
      .filter(Boolean).join('  ·  ') || ' ', { size: 9, gap: 8, color: [0.35, 0.37, 0.42] })
    .rule();

  const c = i.customer || {};
  L.text('PREPARED FOR', { size: 8.5, bold: true, gap: 2, color: [0.35, 0.37, 0.42] })
    .text(c.name || '-', { bold: true, gap: 1 });
  if (c.address) L.text(c.address, { gap: 1 });
  const contact = [c.phone, c.email].filter(Boolean).join('  ·  ');
  if (contact) L.text(contact, { gap: 1 });
  L.y -= 6;
  L.rule();

  // ── Scope ──────────────────────────────────────────────────────────────
  L.text('SCOPE OF WORK', { size: 8.5, bold: true, gap: 4, color: [0.35, 0.37, 0.42] });
  const lines = Array.isArray(i.lines) ? i.lines : [];
  if (lines.length) {
    const descW = 330;
    const qtyX = M + descW + 14;
    const amtRight = W - M;
    L.ensure(14);
    L.page.drawText('Description', { x: M, y: L.y - 9, size: 9, font: fonts.bold });
    L.page.drawText('Qty', { x: qtyX, y: L.y - 9, size: 9, font: fonts.bold });
    L.page.drawText('Amount', { x: amtRight - fonts.bold.widthOfTextAtSize('Amount', 9), y: L.y - 9, size: 9, font: fonts.bold });
    L.y -= 14;
    lines.forEach((ln) => {
      const desc = wrap(fonts.reg, winAnsi(ln.name || 'Line item'), 9.5, descW);
      const h = desc.length * 9.5 * 1.35 + 3;
      L.ensure(h);
      const top = L.y;
      desc.forEach((d, k) => L.page.drawText(d, { x: M, y: top - 9.5 - k * 9.5 * 1.35, size: 9.5, font: fonts.reg }));
      const q = winAnsi(ln.quantity == null ? '' : String(ln.quantity)).slice(0, 18);
      if (q) L.page.drawText(q, { x: qtyX, y: top - 9.5, size: 9.5, font: fonts.reg });
      if (ln.lineTotalCents != null && Number.isFinite(Number(ln.lineTotalCents))) {
        const a = money(ln.lineTotalCents);
        L.page.drawText(a, { x: amtRight - fonts.reg.widthOfTextAtSize(a, 9.5), y: top - 9.5, size: 9.5, font: fonts.reg });
      }
      L.y -= h;
    });
  } else {
    L.text(i.tierName
      ? 'The ' + i.tierName + ' package, complete as described in your estimate.'
      : 'The work described in your estimate.', { gap: 2 });
  }
  if (i.tierName && lines.length) L.text('Package: ' + i.tierName, { size: 9, gap: 2, color: [0.35, 0.37, 0.42] });
  L.y -= 4;
  L.rule();
  L.text('Contract price: ' + money(i.totalCents), { size: 13, bold: true, gap: 6 });

  // ── Payment ────────────────────────────────────────────────────────────
  const dp = i.depositPlan;
  L.text('PAYMENT TERMS', { size: 8.5, bold: true, gap: 3, color: [0.35, 0.37, 0.42] });
  if (dp && (dp.summary || dp.valueText)) {
    if (dp.valueText) L.text((dp.label || 'Due at signing') + ': ' + dp.valueText, { bold: true, gap: 2 });
    if (dp.summary) L.text(dp.summary, { gap: 2 });
    (Array.isArray(dp.rows) ? dp.rows : []).forEach((r) => {
      const bits = [r.label, r.due, r.amountText].filter(Boolean).join(' - ');
      if (bits) L.text('- ' + bits, { size: 9.5, gap: 1 });
    });
  } else {
    L.text('As agreed with your contractor and shown on your estimate.', { gap: 2 });
  }
  L.y -= 3;
  L.text(KyLaw.PAYMENT_CLAUSE, { size: 9.5, gap: 8 });

  // ── Acceptance + signatures (kept together with the FTC statement) ─────
  const accept = 'By signing below, the homeowner' + (signers.length > 1 ? 's' : '') +
    ' accept' + (signers.length > 1 ? '' : 's') + ' this proposal as a contract and authorize ' + company +
    ' to perform the work described above for the contract price shown, on the payment terms above.';
  const SIG_BLOCK = 92;
  const need = L.textHeight(accept, BODY, false) + L.textHeight(KyLaw.FTC_STATEMENT, 10.5, true) + 24 + signers.length * SIG_BLOCK;
  if (L.y - need < M) L.newPage();
  L.text('ACCEPTANCE', { size: 8.5, bold: true, gap: 3, color: [0.35, 0.37, 0.42] })
    .text(accept, { gap: 8 })
    // 16 CFR 429.1(a): in immediate proximity to the buyer's signature, bold, >= 10 pt.
    .text(KyLaw.FTC_STATEMENT, { size: 10.5, bold: true, gap: 10 });

  const fields = [];
  signers.forEach((s, idx) => {
    L.ensure(SIG_BLOCK);
    const label = (idx === 0 ? 'Homeowner' : 'Co-owner') + ' signature';
    const top = L.y;
    const sig = { x: M, y: top - 14 - 46, w: 250, h: 46 };
    const date = { x: M + 290, y: top - 14 - 22, w: 140, h: 20 };
    L.page.drawText(label, { x: M, y: top - 9, size: 9, font: fonts.bold, color: rgb(0.35, 0.37, 0.42) });
    L.page.drawText('Date', { x: date.x, y: top - 9, size: 9, font: fonts.bold, color: rgb(0.35, 0.37, 0.42) });
    // The boxes are drawn into the page itself, so the paper copy shows where
    // the signer signed even outside our viewer.
    L.page.drawRectangle({ x: sig.x, y: sig.y, width: sig.w, height: sig.h, borderColor: rgb(0.74, 0.34, 0.16), borderWidth: 0.8, borderDashArray: [3, 2] });
    L.page.drawLine({ start: { x: date.x, y: date.y }, end: { x: date.x + date.w, y: date.y }, thickness: 0.8, color: rgb(0.2, 0.2, 0.25) });
    L.page.drawText(winAnsi(s.name || ''), { x: M, y: sig.y - 12, size: 9, font: fonts.reg });
    fields.push({ id: 'sig_' + s.id, type: 'signature', page: L.pageIndex, x: sig.x, y: sig.y, w: sig.w, h: sig.h, required: true, label: label, role: s.id });
    fields.push({ id: 'date_' + s.id, type: 'date', page: L.pageIndex, x: date.x, y: date.y + 1, w: date.w, h: date.h, required: true, label: 'Date', role: s.id });
    L.y = top - SIG_BLOCK;
  });

  // ── FTC NOTICE OF CANCELLATION, in duplicate (16 CFR 429.1(b)) ─────────
  const systemFields = [];
  [1, 2].forEach((n) => {
    L.newPage()
      .text('Federal Trade Commission Cooling-Off Rule (16 CFR 429.1). Copy ' + n + ' of 2 - Buyer. Detach and keep.', { size: 9, gap: 6, color: [0.35, 0.37, 0.42] })
      .text('NOTICE OF CANCELLATION', { size: 13, bold: true, gap: 10 });
    const dateTop = L.y;
    systemFields.push({ id: 'sys_ftc_date_' + n, type: 'text', page: L.pageIndex, x: M, y: dateTop - 16, w: 220, h: 16, required: false, label: 'Date of transaction', role: '__system' });
    L.page.drawLine({ start: { x: M, y: dateTop - 17 }, end: { x: M + 220, y: dateTop - 17 }, thickness: 0.8, color: rgb(0, 0, 0) });
    L.y = dateTop - 20;
    L.text('(Date) - filled in with the date you sign', { size: 9, bold: true, gap: 10 });
    KyLaw.FTC_FORM_PARAS.forEach((p) => L.text(p, { size: 10.5, bold: true, gap: 6 }));
    L.text('To cancel this transaction, mail or deliver a signed and dated copy of this Cancellation Notice or any other written notice, or send a telegram, to ' +
      company + ', at ' + (i.sellerAddress || '________________________________') + ' NOT LATER THAN MIDNIGHT OF', { size: 10.5, bold: true, gap: 2 });
    const dlTop = L.y;
    systemFields.push({ id: 'sys_ftc_deadline_' + n, type: 'text', page: L.pageIndex, x: M, y: dlTop - 16, w: 220, h: 16, required: false, label: 'Cancellation deadline', role: '__system' });
    L.page.drawLine({ start: { x: M, y: dlTop - 17 }, end: { x: M + 220, y: dlTop - 17 }, thickness: 0.8, color: rgb(0, 0, 0) });
    L.y = dlTop - 20;
    L.text('(Date) - three business days after the date you sign', { size: 9, bold: true, gap: 12 });
    L.text(KyLaw.CANCEL_LINE, { size: 10.5, bold: true, gap: 18 });
    L.ensure(60);
    L.page.drawLine({ start: { x: M, y: L.y - 10 }, end: { x: M + 260, y: L.y - 10 }, thickness: 0.8, color: rgb(0, 0, 0) });
    L.y -= 14;
    L.text("(Date)", { size: 9.5, bold: true, gap: 16 });
    L.page.drawLine({ start: { x: M, y: L.y - 10 }, end: { x: M + 260, y: L.y - 10 }, thickness: 0.8, color: rgb(0, 0, 0) });
    L.y -= 14;
    L.text("(Buyer's signature)", { size: 9.5, bold: true, gap: 0 });
  });

  const bytes = await doc.save({ useObjectStreams: true });
  const pages = doc.getPages().map(() => ({ w: W, h: H, rotation: 0 }));
  return { bytes, pages, fields, systemFields };
}

/**
 * The values for the system fields at the moment the last signer signs:
 * the transaction date and the FTC deadline (3 business days, 16 CFR 429.0),
 * both as calendar dates in the tenant's timezone.
 */
function systemFieldValues(systemFields, when, timeZone) {
  const t = KyLaw.toUtcDay(when == null ? new Date() : when, timeZone || KyLaw.DEFAULT_TIME_ZONE);
  const dateText = t != null ? KyLaw.formatDay(t) : '';
  const deadline = t != null ? KyLaw.formatDay(KyLaw.addBusinessDays(t, 3)) : '';
  const out = {};
  (Array.isArray(systemFields) ? systemFields : []).forEach((f) => {
    if (/^sys_ftc_date_/.test(f.id)) out[f.id] = { text: dateText };
    else if (/^sys_ftc_deadline_/.test(f.id)) out[f.id] = { text: deadline };
  });
  return { values: out, transactionDate: t != null ? KyLaw.isoDay(t) : '', cancelBy: t != null ? KyLaw.isoDay(KyLaw.addBusinessDays(t, 3)) : '' };
}

module.exports = { buildEstimateContractPdf, systemFieldValues, money };
