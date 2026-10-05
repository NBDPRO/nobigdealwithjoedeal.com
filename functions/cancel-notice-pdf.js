/**
 * functions/cancel-notice-pdf.js — the Notice of Right to Cancel as PDF pages.
 *
 * An e-sign envelope is an uploaded PDF, so the HTML packet the generated
 * contracts carry (ky-insurance-law.js cancelPacketHtml) cannot ride on it.
 * When an envelope is the CONTRACT (job-spine-logic.js envelopeIsContract —
 * the same test that moves the job to Contract Signed), submitEsignEnvelope
 * appends these pages to the signed PDF (2026-10-04):
 *
 *   1. Notice of Right to Cancel — contract date, last day to cancel, how to
 *      cancel, the 16 CFR 429.1(a) statement (+ the KRS 367.624(3) notices on
 *      a Kentucky insurance job)
 *   2-3. the FTC NOTICE OF CANCELLATION, completed, copy 1 and copy 2
 *   4-5. Kentucky insurance job only: the KRS 367.624(4) form, copy 1 and 2
 *
 * Every word comes from ky-insurance-law.js (the statute text is verbatim
 * there). Statutory text is Helvetica-Bold 10.5pt (the rules: bold, at least
 * 10 point). Pure: bytes in, bytes out, no I/O.
 */
'use strict';

const KyLaw = require('./ky-insurance-law');

let _pdfLib = null;
function pdfLib() {
  if (!_pdfLib) _pdfLib = require('pdf-lib');
  return _pdfLib;
}

const PAGE_W = 612;   // US Letter
const PAGE_H = 792;
const MARGIN = 54;
const BODY = 10.5;

// The standard fonts are WinAnsi: map the few typographic characters the
// copy uses to plain ones rather than let one glyph fail the whole stamp.
function winAnsi(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-').replace(/ /g, ' ')
    .replace(/[^\x09\x0A\x0D\x20-\x7E¡-ÿ]/g, '');
}
// The steps are escaped HTML (shared with the browser packet).
function plain(html) {
  return String(html || '').replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function wrap(font, text, size, width) {
  const out = [];
  String(text).split(/\n/).forEach((para) => {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    words.forEach((w) => {
      const next = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
      else { out.push(line); line = w; }
    });
    out.push(line);
  });
  return out;
}

class Writer {
  constructor(doc, fonts) { this.doc = doc; this.f = fonts; this.page = null; this.y = 0; }
  newPage() { this.page = this.doc.addPage([PAGE_W, PAGE_H]); this.y = PAGE_H - MARGIN; return this; }
  text(t, opts) {
    const o = Object.assign({ size: BODY, bold: false, gap: 6, center: false }, opts || {});
    const font = o.bold ? this.f.bold : this.f.reg;
    const lines = wrap(font, winAnsi(t), o.size, PAGE_W - 2 * MARGIN);
    lines.forEach((ln) => {
      if (this.y - o.size < MARGIN) this.newPage();
      const x = o.center ? (PAGE_W - font.widthOfTextAtSize(ln, o.size)) / 2 : MARGIN;
      this.page.drawText(ln, { x, y: this.y - o.size, size: o.size, font, color: pdfLib().rgb(0.07, 0.07, 0.07) });
      this.y -= o.size * 1.35;
    });
    this.y -= o.gap;
    return this;
  }
  rule() {
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 1, dashArray: [5, 4], color: pdfLib().rgb(0.35, 0.35, 0.35) });
    this.y -= 14;
    return this;
  }
  sigLines(label) {
    this.y -= 18;
    [['(Date)'], [label]].forEach(([l]) => {
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + 260, y: this.y }, thickness: 0.8, color: pdfLib().rgb(0, 0, 0) });
      this.y -= 4;
      this.text(l, { bold: true, gap: 14 });
    });
    return this;
  }
}

/**
 * Append the notice + forms to `pdfBytes`.
 * opts: { transactionDate, timeZone, sellerName, sellerAddress, email, fax,
 *         homeownerName, propertyAddress, state, kyInsurance }
 * Returns { bytes, cancelBy, pagesAdded }.
 */
async function appendCancelNotice(pdfBytes, opts) {
  const o = opts || {};
  const { PDFDocument, StandardFonts } = pdfLib();
  const doc = await PDFDocument.load(pdfBytes);
  const before = doc.getPageCount();
  const fonts = { reg: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  const tz = o.timeZone || KyLaw.DEFAULT_TIME_ZONE;
  const tx = o.transactionDate == null || o.transactionDate === '' ? new Date() : o.transactionDate;
  const t = KyLaw.toUtcDay(tx, tz);
  const dateText = t != null ? KyLaw.formatDay(t) : String(tx);
  const endT = t != null ? KyLaw.addBusinessDays(t, 3) : null;
  const deadline = endT != null ? KyLaw.formatDay(endT) : '';
  const seller = o.sellerName || 'the contractor';
  const addr = o.sellerAddress || '';
  const w = new Writer(doc, fonts);

  // 1. The notice.
  w.newPage()
    .text('NOTICE OF RIGHT TO CANCEL', { size: 16, bold: true, center: true, gap: 2 })
    .text('Contract date: ' + dateText, { center: true, gap: 12 })
    .text('You signed a contract with ' + seller + ' at your home. Under ' + KyLaw.homeSolicitationLawText(o.state) +
      ', you can cancel it within three business days without any penalty or obligation.', { gap: 10 })
    .text('Homeowner: ' + (o.homeownerName || '-'), { gap: 2 })
    .text('Property: ' + (o.propertyAddress || '-'), { gap: 2 })
    .text('Last day to cancel: ' + (deadline ? deadline + ' (before midnight)' : '-'), { bold: true, gap: 12 })
    .text('HOW TO CANCEL', { bold: true, gap: 4 });
  KyLaw.cancelHowToSteps({ sellerName: seller, sellerAddress: addr, deadlineText: deadline })
    .forEach((step, i) => w.text((i + 1) + '. ' + plain(step), { gap: 4 }));
  w.y -= 6;
  w.text(KyLaw.FTC_STATEMENT, { bold: true, gap: 10 });
  if (o.kyInsurance === true) {
    w.text('KENTUCKY INSURANCE JOB: A SECOND RIGHT TO CANCEL', { bold: true, gap: 4 })
      .text(KyLaw.KY_NOTICE_CANCEL, { bold: true, gap: 6 })
      .text(KyLaw.KY_NOTICE_NO_ASSIGNMENT, { bold: true, gap: 10 });
  }
  w.text('The homeowner received this notice and two completed copies of the Notice of Cancellation form on ' + dateText + '.', { gap: 0 });

  // 2-3. FTC forms, completed, in duplicate.
  ['Copy 1 of 2 - Buyer', 'Copy 2 of 2 - Buyer'].forEach((copy) => {
    w.newPage()
      .text('Federal Trade Commission Cooling-Off Rule (16 CFR 429.1). Cut along the dashed line to detach.', { size: 9, gap: 4 })
      .rule()
      .text(copy, { size: 9, gap: 2 })
      .text('NOTICE OF CANCELLATION', { size: 13, bold: true, center: true, gap: 8 })
      .text(dateText + '   (Date)', { bold: true, gap: 8 });
    KyLaw.FTC_FORM_PARAS.forEach((p) => w.text(p, { bold: true, gap: 6 }));
    w.text('To cancel this transaction, mail or deliver a signed and dated copy of this Cancellation Notice or any other written notice, or send a telegram, to ' +
      seller + ', at ' + (addr || '________________________') + ' NOT LATER THAN MIDNIGHT OF ' + (deadline || '____________') + '.', { bold: true, gap: 6 })
      .text(KyLaw.CANCEL_LINE, { bold: true, gap: 0 })
      .sigLines("(Buyer's signature)");
    w.rule();
  });

  // 4-5. Kentucky insurance job: KRS 367.624(4) forms.
  if (o.kyInsurance === true) {
    const P = KyLaw.KY_FORM_BODY_PARTS;
    const fax = String(o.fax || '').trim() || KyLaw.NO_FAX_TEXT;
    ['Copy 1 of 2 - Buyer', 'Copy 2 of 2 - Buyer'].forEach((copy) => {
      w.newPage()
        .text('Kentucky Revised Statutes 367.624(4). Cut along the dashed line to detach.', { size: 9, gap: 4 })
        .rule()
        .text(copy, { size: 9, gap: 2 })
        .text('NOTICE OF CANCELLATION', { size: 13, bold: true, center: true, gap: 8 })
        .text(dateText + '   (Date of transaction)', { bold: true, gap: 8 })
        .text(P[0] + (addr || '________________') + P[1] + (o.email || '________________') + P[2] + fax + P[3], { bold: true, gap: 6 })
        .text(KyLaw.CANCEL_LINE, { bold: true, gap: 0 })
        .sigLines("(Buyer's Signature)");
      w.rule();
    });
  }

  const bytes = await doc.save();
  return { bytes, cancelBy: endT != null ? KyLaw.isoDay(endT) : '', pagesAdded: doc.getPageCount() - before };
}

module.exports = { appendCancelNotice };
