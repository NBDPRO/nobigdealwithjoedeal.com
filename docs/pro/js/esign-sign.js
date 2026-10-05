/**
 * esign-sign.js — the homeowner's signing surface for /pro/esign.html.
 *
 * No Firebase auth: the only credential is ?t=<token>, validated server-side
 * by getEsignEnvelope / submitEsignEnvelope (functions/esign-envelope.js).
 *
 * WHAT THIS DOES THAT THE OLD sign.html COULD NOT
 *  - Renders a real PDF with pdf.js and lets the signer PAN and ZOOM. The old
 *    page set user-scalable=no and dropped a whole contract into a fixed
 *    iframe, so a dense document on a phone was unreadable and un-zoomable.
 *    Zoom re-renders the canvas at the new scale rather than scaling a
 *    bitmap, so text stays sharp at 300%.
 *  - Supports five field types, placed by the rep, instead of one hardcoded
 *    signature box: signature, initials, date, text, checkbox.
 *  - Walks the signer through the fields ("Next") instead of leaving them to
 *    hunt for what is still blank on page 7.
 *  - Records consent to sign electronically. Nothing in the old flow did.
 *
 * COORDINATES: fields arrive in PDF user space (points, origin bottom-left).
 * Overlay positions come from viewport.convertToViewportPoint, the exact
 * inverse of what the placement UI used. See functions/esign-stamp.js for why
 * that, and not normalised fractions, is the contract.
 *
 * SIGNATURE PNGs ARE TRANSPARENT. The older widget baked a white background
 * into every signature, which is invisible on white HTML but lands as an
 * opaque white sticker when stamped onto a PDF form.
 */

import * as pdfjsLib from '/assets/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdfjs/pdf.worker.min.mjs';

const FN_BASE = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
  ? 'http://127.0.0.1:5001/nobigdeal-pro/us-central1'
  : 'https://us-central1-nobigdeal-pro.cloudfunctions.net';

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('t') || '';

const el = {
  brand: $('esBrand'), title: $('esTitle'), zoomCtl: $('esZoomCtl'),
  zoomIn: $('esZoomIn'), zoomOut: $('esZoomOut'), zoomFit: $('esZoomFit'), zoomPct: $('esZoomPct'),
  scroll: $('esScroll'), doc: $('esDoc'),
  msg: $('esMsg'), msgIcon: $('esMsgIcon'), msgTitle: $('esMsgTitle'), msgBody: $('esMsgBody'),
  foot: $('esFoot'), next: $('esNext'), progress: $('esProgress'), finish: $('esFinish'),
  sheet: $('esSheet'), sheetTitle: $('esSheetTitle'), sheetClose: $('esSheetClose'),
  tabs: $('esTabs'), padWrap: $('esPadWrap'), pad: $('esPad'), padHint: $('esPadHint'),
  typeWrap: $('esTypeWrap'), typeInput: $('esTypeInput'), typePreview: $('esTypePreview'),
  textWrap: $('esTextWrap'), textInput: $('esTextInput'),
  undo: $('esUndo'), clear: $('esClear'), apply: $('esApply'),
  done: $('esDone'), doneClose: $('esDoneClose'), doneBack: $('esDoneBack'),
  consent: $('esConsent'), consentText: $('esConsentText'), signerName: $('esSignerName'),
  submit: $('esSubmit'), doneErr: $('esDoneErr'),
};

/* The checkbox sheet's excerpt block (see openCheckSheet). Built here, not in
   esign.html: hosting ignores ?v=, so for the HTML's cache lifetime after a
   deploy an old esign.html runs THIS file — markup it expected in the page
   would be null and take the whole signing flow down with it. */
function buildCheckWrap() {
  const wrap = document.createElement('div');
  wrap.className = 'es-check-wrap';
  wrap.id = 'esCheckWrap';
  wrap.hidden = true;
  const lead = document.createElement('p');
  lead.className = 'es-check-lead';
  lead.textContent = 'This box is in your document. Read the text around it, then check it.';
  const excerpt = document.createElement('div');
  excerpt.className = 'es-excerpt';
  excerpt.id = 'esExcerpt';
  excerpt.setAttribute('role', 'img');
  excerpt.setAttribute('aria-label', 'The document text around this checkbox');
  const hint = document.createElement('p');
  hint.className = 'es-check-hint';
  hint.id = 'esCheckHint';
  wrap.append(lead, excerpt, hint);
  const foot = el.sheet.querySelector('.es-sheet-foot');
  el.sheet.querySelector('.es-sheet-panel').insertBefore(wrap, foot);
  el.checkWrap = wrap;
  el.excerpt = excerpt;
  el.checkHint = hint;
}
buildCheckWrap();

/* Decline (2026-10-04 — BoldSign retired; it had a decline and we did not).
   Built here, not in esign.html, for the same cache reason as the checkbox
   sheet above. A header button opens a sheet with an optional reason; the
   server burns the link, stops reminders and tells the rep. */
function buildDecline() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'es-decline';
  btn.id = 'esDeclineBtn';
  btn.textContent = 'Decline';
  btn.hidden = true;
  document.querySelector('.es-bar').appendChild(btn);

  const sheet = document.createElement('div');
  sheet.className = 'es-sheet';
  sheet.id = 'esDecline';
  sheet.hidden = true;
  const panel = document.createElement('div');
  panel.className = 'es-sheet-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'esDeclineTitle');
  const head = document.createElement('div');
  head.className = 'es-sheet-head';
  const h3 = document.createElement('h3');
  h3.id = 'esDeclineTitle';
  h3.textContent = 'Decline to sign?';
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'es-x'; x.setAttribute('aria-label', 'Close'); x.textContent = '✕';
  head.append(h3, x);
  const body = document.createElement('div');
  body.className = 'es-consent';
  const p = document.createElement('p');
  p.className = 'es-fineprint';
  p.textContent = 'Your rep will be told you declined, and this link will stop working. If you change your mind, ask them for a new one.';
  const label = document.createElement('label');
  label.className = 'es-namewrap';
  const span = document.createElement('span');
  span.textContent = 'Reason (optional)';
  const reason = document.createElement('textarea');
  reason.className = 'es-reason'; reason.id = 'esDeclineReason'; reason.maxLength = 500;
  reason.placeholder = 'Anything you want your rep to know';
  label.append(span, reason);
  const err = document.createElement('div');
  err.className = 'es-err'; err.id = 'esDeclineErr'; err.hidden = true;
  body.append(p, label, err);
  const foot = document.createElement('div');
  foot.className = 'es-sheet-foot';
  const back = document.createElement('button');
  back.type = 'button'; back.className = 'es-ghost'; back.textContent = 'Back';
  const go = document.createElement('button');
  go.type = 'button'; go.className = 'es-danger'; go.id = 'esDeclineGo'; go.textContent = 'Decline';
  foot.append(back, go);
  panel.append(head, body, foot);
  sheet.appendChild(panel);
  document.body.appendChild(sheet);

  const close = () => { sheet.hidden = true; };
  btn.addEventListener('click', () => { err.hidden = true; sheet.hidden = false; });
  x.addEventListener('click', close);
  back.addEventListener('click', close);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
  go.addEventListener('click', async () => {
    go.disabled = true;
    err.hidden = true;
    const r = await post('declineEsignEnvelope', { token, reason: reason.value.trim() })
      .catch(() => ({ ok: false, status: 0, data: {} }));
    go.disabled = false;
    if (r.ok && r.data.ok) {
      close();
      btn.hidden = true;
      el.foot.hidden = true;
      el.zoomCtl.hidden = true;
      el.done.hidden = true;
      showMsg('👋', 'You declined to sign', 'Your rep has been told. If you change your mind, ask them for a new link.');
      return;
    }
    err.textContent = r.data.error || (r.status === 0 ? 'Connection problem — check your signal and try again.' : 'Could not record that. Please try again.');
    err.hidden = false;
  });
  el.declineBtn = btn;
}
buildDecline();

let pdfDoc = null;
let envelope = null;      // { title, fields, pages, signerName, companyName }
let scale = 1;
let fitScale = 1;
const values = Object.create(null);   // fieldId -> { png } | { text } | { checked }
const pageViews = [];                 // [{ pageNum, canvas, layer, viewport }]
let activeField = null;
let submitting = false;

/* ── messaging ─────────────────────────────────────────────────────────── */
function showMsg(icon, title, body) {
  el.msgIcon.textContent = icon;
  el.msgTitle.textContent = title;
  el.msgBody.textContent = body;
  el.msg.hidden = false;
  el.msg.style.display = 'flex';
}
function hideMsg() { el.msg.style.display = 'none'; }

async function post(path, body) {
  const res = await fetch(`${FN_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, data: data || {} };
}

/* ── geometry ──────────────────────────────────────────────────────────── */
/** PDF-space box -> viewport rect, correct under any page rotation. */
function boxToViewRect(viewport, f) {
  const a = viewport.convertToViewportPoint(f.x, f.y);
  const b = viewport.convertToViewportPoint(f.x + f.w, f.y + f.h);
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

const isInk = (f) => f.type === 'signature' || f.type === 'initials';
const isDone = (f) => {
  const v = values[f.id];
  if (!v) return false;
  if (f.type === 'checkbox') return v.checked === true;
  if (isInk(f)) return !!v.png;
  return typeof v.text === 'string' && v.text.trim() !== '';
};
const requiredFields = () => (envelope.fields || []).filter((f) => f.required !== false);
const remaining = () => requiredFields().filter((f) => !isDone(f));

function updateProgress() {
  const req = requiredFields();
  const done = req.filter(isDone).length;
  el.progress.textContent = `${done} of ${req.length}`;
  el.finish.disabled = done < req.length;
  el.next.textContent = remaining().length ? 'Next field' : 'All set';
  el.next.disabled = remaining().length === 0;
}

/* ── rendering ─────────────────────────────────────────────────────────── */
async function renderAll() {
  el.doc.textContent = '';
  pageViews.length = 0;

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const viewport = page.getViewport({ scale });

    const wrap = document.createElement('div');
    wrap.className = 'es-page';
    wrap.style.width = `${Math.floor(viewport.width)}px`;
    wrap.style.height = `${Math.floor(viewport.height)}px`;

    const canvas = document.createElement('canvas');
    // Render at device pixel ratio so the page is sharp on a phone, but lay
    // it out at CSS size so field overlays share one coordinate space.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const ctx = canvas.getContext('2d');
    wrap.appendChild(canvas);

    const layer = document.createElement('div');
    layer.className = 'es-layer';
    wrap.appendChild(layer);
    el.doc.appendChild(wrap);

    await page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;

    pageViews.push({ pageNum: n, canvas, layer, viewport });
  }
  placeFields();
  el.zoomPct.textContent = `${Math.round((scale / fitScale) * 100)}%`;
}

function placeFields() {
  for (const pv of pageViews) pv.layer.textContent = '';
  for (const f of envelope.fields || []) {
    const pv = pageViews[f.page];
    if (!pv) continue;
    const r = boxToViewRect(pv.viewport, f);

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'es-field' + (f.required === false ? ' is-optional' : '');
    b.style.left = `${r.left}px`;
    b.style.top = `${r.top}px`;
    b.style.width = `${r.width}px`;
    b.style.height = `${r.height}px`;
    b.dataset.fieldId = f.id;
    b.setAttribute('aria-label', `${f.label || f.type} — ${f.required === false ? 'optional' : 'required'}`);
    // Scale the hint text with the box so it stays legible when zoomed out.
    b.style.fontSize = `${Math.max(8, Math.min(13, r.height * 0.42))}px`;
    paintField(b, f);
    b.addEventListener('click', () => openField(f));
    pv.layer.appendChild(b);
  }
  updateProgress();
}

function paintField(node, f) {
  const v = values[f.id];
  node.textContent = '';
  node.classList.toggle('is-done', isDone(f));

  if (isInk(f) && v && v.png) {
    const img = document.createElement('img');
    img.src = v.png;
    img.alt = f.label || 'signature';
    node.appendChild(img);
    return;
  }
  if (f.type === 'checkbox') {
    // A checkbox box is often ~18pt. Any word crammed into it renders as an
    // illegible smudge, so an unchecked box stays EMPTY — the dashed outline
    // is the affordance — and only the tick is ever drawn.
    if (v && v.checked) {
      const s = document.createElement('span');
      s.className = 'es-tick';
      s.textContent = '✓';
      node.appendChild(s);
    }
    return;
  }
  if (!isInk(f) && v && typeof v.text === 'string' && v.text.trim()) {
    const s = document.createElement('span');
    s.className = 'es-val';
    s.textContent = v.text;
    node.appendChild(s);
    return;
  }
  node.textContent = f.label || (
    f.type === 'signature' ? 'Sign' :
    f.type === 'initials' ? 'Initials' :
    f.type === 'date' ? 'Date' : 'Tap'
  );
}

function repaint(f) {
  const node = document.querySelector(`.es-field[data-field-id="${CSS.escape(f.id)}"]`);
  if (node) paintField(node, f);
  updateProgress();
}

/* ── zoom ──────────────────────────────────────────────────────────────── */
let rerenderTimer = null;
function setScale(next) {
  const clamped = Math.max(fitScale * 0.5, Math.min(fitScale * 4, next));
  if (Math.abs(clamped - scale) < 0.001) return;
  scale = clamped;
  el.zoomPct.textContent = `${Math.round((scale / fitScale) * 100)}%`;
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => { renderAll().catch(reportRenderError); }, 90);
}

function computeFitScale(firstPage) {
  const avail = el.scroll.clientWidth - 24;
  const base = firstPage.getViewport({ scale: 1 });
  return Math.max(0.2, Math.min(3, avail / base.width));
}

/* Two-finger pinch. The scroll container keeps native one-finger panning. */
const pointers = new Map();
let pinchStart = 0;
let pinchScale0 = 1;
el.scroll.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  pointers.set(e.pointerId, e);
  if (pointers.size === 2) {
    const [p, q] = [...pointers.values()];
    pinchStart = Math.hypot(p.clientX - q.clientX, p.clientY - q.clientY);
    pinchScale0 = scale;
  }
});
el.scroll.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, e);
  if (pointers.size !== 2 || !pinchStart) return;
  e.preventDefault();
  const [p, q] = [...pointers.values()];
  const d = Math.hypot(p.clientX - q.clientX, p.clientY - q.clientY);
  setScale(pinchScale0 * (d / pinchStart));
}, { passive: false });
const dropPointer = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinchStart = 0; };
el.scroll.addEventListener('pointerup', dropPointer);
el.scroll.addEventListener('pointercancel', dropPointer);

el.zoomIn.addEventListener('click', () => setScale(scale * 1.25));
el.zoomOut.addEventListener('click', () => setScale(scale / 1.25));
el.zoomFit.addEventListener('click', () => setScale(fitScale));

/* ── signature pad (transparent output) ────────────────────────────────── */
const pad = {
  ctx: null, strokes: [], current: null, w: 0, h: 0, dpr: 1,
  init() {
    const c = el.pad;
    const rect = c.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(rect.width, 1);
    this.h = Math.max(rect.height, 1);
    c.width = Math.round(this.w * this.dpr);
    c.height = Math.round(this.h * this.dpr);
    this.ctx = c.getContext('2d');
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.lineWidth = 2.4;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.strokeStyle = '#12121e';
    this.strokes = [];
    this.current = null;
    el.padHint.classList.remove('hide');
  },
  pos(e) {
    const r = el.pad.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  },
  down(e) {
    e.preventDefault();
    try { el.pad.setPointerCapture(e.pointerId); } catch (_) {}
    this.current = [this.pos(e)];
    el.padHint.classList.add('hide');
  },
  move(e) {
    if (!this.current) return;
    e.preventDefault();
    const p = this.pos(e);
    const last = this.current[this.current.length - 1];
    this.current.push(p);
    this.ctx.beginPath();
    this.ctx.moveTo(last.x, last.y);
    this.ctx.lineTo(p.x, p.y);
    this.ctx.stroke();
  },
  up() {
    if (!this.current) return;
    if (this.current.length > 1) this.strokes.push(this.current);
    this.current = null;
    syncApply();
  },
  redraw() {
    this.ctx.clearRect(0, 0, this.w, this.h);
    for (const s of this.strokes) {
      if (s.length < 2) continue;
      this.ctx.beginPath();
      this.ctx.moveTo(s[0].x, s[0].y);
      for (let i = 1; i < s.length; i++) this.ctx.lineTo(s[i].x, s[i].y);
      this.ctx.stroke();
    }
    el.padHint.classList.toggle('hide', this.strokes.length > 0);
  },
  isEmpty() { return this.strokes.length === 0; },
  /**
   * Trim to the drawn ink and export a TRANSPARENT PNG. Trimming matters:
   * an untrimmed pad is mostly empty space, and the stamper fits the image
   * to its box — so an untrimmed signature renders tiny and floating.
   */
  toPNG() {
    if (this.isEmpty()) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of this.strokes) for (const p of s) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const m = 6;
    minX = Math.max(0, minX - m); minY = Math.max(0, minY - m);
    maxX = Math.min(this.w, maxX + m); maxY = Math.min(this.h, maxY + m);
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const out = document.createElement('canvas');
    out.width = Math.round(w * this.dpr);
    out.height = Math.round(h * this.dpr);
    const o = out.getContext('2d');
    o.drawImage(el.pad,
      Math.round(minX * this.dpr), Math.round(minY * this.dpr),
      Math.round(w * this.dpr), Math.round(h * this.dpr),
      0, 0, Math.round(w * this.dpr), Math.round(h * this.dpr));
    return out.toDataURL('image/png');
  },
};
el.pad.addEventListener('pointerdown', (e) => pad.down(e));
el.pad.addEventListener('pointermove', (e) => pad.move(e));
el.pad.addEventListener('pointerup', () => pad.up());
el.pad.addEventListener('pointercancel', () => pad.up());
el.pad.addEventListener('pointerleave', () => pad.up());

/** Render typed text to a transparent PNG so typed and drawn take one path. */
function typedToPNG(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const dpr = 2;
  const font = '44px "Segoe Script", "Brush Script MT", cursive';
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = font;
  const w = Math.max(20, Math.ceil(probe.measureText(t).width) + 16);
  const h = 68;
  const c = document.createElement('canvas');
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.font = font;
  ctx.fillStyle = '#12121e';
  ctx.textBaseline = 'middle';
  ctx.fillText(t, 8, h / 2);
  return c.toDataURL('image/png');
}

/* ── field entry sheet ─────────────────────────────────────────────────── */
let sheetMode = 'draw';

function setSheetMode(mode) {
  sheetMode = mode;
  for (const b of el.tabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
  el.padWrap.hidden = mode !== 'draw';
  el.typeWrap.hidden = mode !== 'type';
  if (mode === 'draw') requestAnimationFrame(() => { pad.init(); pad.redraw(); });
  syncApply();
}

function syncApply() {
  if (!activeField) return;
  if (activeField.type === 'checkbox') { el.apply.disabled = false; return; }
  let ready;
  if (isInk(activeField)) {
    ready = sheetMode === 'draw' ? !pad.isEmpty() : !!el.typeInput.value.trim();
  } else {
    ready = !!el.textInput.value.trim();
  }
  el.apply.disabled = !ready;
}

/**
 * @param {object} f
 * @param {{viaNext?: boolean}} [opts] viaNext: the signer pressed "Next
 *   field" rather than tapping this field on the page.
 */
function openField(f, opts) {
  activeField = f;
  document.querySelectorAll('.es-field.is-target').forEach((n) => n.classList.remove('is-target'));
  const node = document.querySelector(`.es-field[data-field-id="${CSS.escape(f.id)}"]`);
  if (node) node.classList.add('is-target');

  if (f.type === 'checkbox') {
    // "Next field" must never tick a box by itself (2026-09-25, phone audit
    // homeowner#6). It used to land here and toggle in place, so walking a
    // phone envelope with Next alone checked a required acknowledgment with
    // no act on the box: the overlay is empty when unchecked, f.label is
    // always '' (esign-setup.js and esign-autodetect.js write label:''), and
    // the PDF's own words beside it render at 10pt x fitScale = 5.5-6.3px
    // on a phone. Next now opens a sheet that shows those words, legibly,
    // and the signer checks the box themselves.
    if (opts && opts.viaNext) { openCheckSheet(f); return; }
    // A direct tap is an act on the box itself, so it keeps the one-tap
    // toggle (pinned by tests/esign-signer-flow.test.js).
    values[f.id] = { checked: !(values[f.id] && values[f.id].checked) };
    repaint(f);
    activeField = null;
    return;
  }

  el.checkWrap.hidden = true;
  el.apply.textContent = 'Apply';
  const ink = isInk(f);
  el.sheetTitle.textContent = f.label || (
    f.type === 'signature' ? 'Sign here' :
    f.type === 'initials' ? 'Your initials' :
    f.type === 'date' ? 'Date' : 'Enter text'
  );
  el.tabs.hidden = !ink;
  el.padWrap.hidden = !ink;
  el.typeWrap.hidden = true;
  el.textWrap.hidden = ink;
  el.undo.hidden = !ink;
  el.clear.hidden = !ink;

  const existing = values[f.id];
  if (ink) {
    el.typeInput.value = '';
    el.typePreview.textContent = '';
    setSheetMode('draw');
  } else {
    el.textInput.placeholder = f.type === 'date' ? 'MM/DD/YYYY' : (f.label || 'Type here');
    // Dates default to today — the overwhelmingly common answer.
    el.textInput.value = (existing && existing.text)
      || (f.type === 'date' ? new Date().toLocaleDateString('en-US') : '');
  }

  el.sheet.hidden = false;
  el.apply.disabled = true;
  syncApply();
  if (!ink) setTimeout(() => el.textInput.focus(), 60);
}

const isChecked = (f) => !!(values[f.id] && values[f.id].checked);

function openCheckSheet(f) {
  el.sheetTitle.textContent = f.label || (f.required === false ? 'Optional checkbox' : 'Required checkbox');
  el.tabs.hidden = true;
  el.padWrap.hidden = true;
  el.typeWrap.hidden = true;
  el.textWrap.hidden = true;
  el.undo.hidden = true;
  el.clear.hidden = true;
  el.checkWrap.hidden = false;
  el.apply.textContent = isChecked(f) ? 'Uncheck this box' : 'Check this box';
  el.sheet.hidden = false;
  syncApply();
  renderExcerpt(f).catch((e) => {
    console.warn('[esign] excerpt render failed', e);
    el.excerpt.textContent = '';
    el.checkHint.textContent = 'The excerpt could not be drawn. Close this, zoom into the page to read the text beside the box, then tap the box itself.';
  });
}

/**
 * Which side of the box its statement is on, from pdf.js's text layer: the
 * text on the box's own line (the text's mid-height inside the box's height)
 * nearest the box. `start` is where the left-hand run begins, so the reader
 * can open at the first word. null when the line has no text layer.
 */
async function statementSide(page, vp, r) {
  let tc;
  try { tc = await page.getTextContent(); } catch (_) { return null; }
  let left = null;
  let right = null;
  for (const it of (tc && tc.items) || []) {
    if (!it.str || !it.str.trim() || !it.transform) continue;
    const [a, b, c, d, e, f] = it.transform;
    const n = Math.hypot(a, b) || 1;
    const p0 = vp.convertToViewportPoint(e, f);
    const p1 = vp.convertToViewportPoint(e + ((it.width || 0) * a) / n, f + ((it.width || 0) * b) / n);
    if (Math.abs(p1[1] - p0[1]) > 1) continue;              // not a horizontal run on screen
    const mid = p0[1] - 0.35 * Math.hypot(c, d) * vp.scale;  // baseline up to mid x-height
    if (mid < r.top || mid > r.top + r.height) continue;    // another line
    const x0 = Math.min(p0[0], p1[0]);
    const x1 = Math.max(p0[0], p1[0]);
    if (x0 >= r.left + r.width - 2) {
      const gap = x0 - (r.left + r.width);
      if (!right || gap < right.gap) right = { gap };
    } else if (x1 <= r.left + 2) {
      const gap = r.left - x1;
      left = left ? { gap: Math.min(left.gap, gap), start: Math.min(left.start, x0) } : { gap, start: x0 };
    }
  }
  if (left && (!right || left.gap < right.gap)) return { side: 'left', start: left.start };
  return right ? { side: 'right' } : null;
}

/**
 * Draw the band of the page around a checkbox at a READABLE scale, the box
 * outlined. The whole page width is kept (the statement can sit on either
 * side of the box) and the excerpt scrolls sideways, opening where the
 * statement starts (statementSide).
 * Rendered by pdf.js at the excerpt scale — not cropped from the page canvas,
 * which at phone fit-scale holds 5-6px text that would only enlarge to blur.
 */
const EXCERPT_SCALE = 1.5;     // 10pt body text -> 15 CSS px
const EXCERPT_BAND_PT = 46;    // ~3 lines of 10-12pt text above and below
let excerptSeq = 0;

async function renderExcerpt(f) {
  const seq = ++excerptSeq;
  el.excerpt.textContent = '';
  el.checkHint.textContent = 'Scroll the excerpt sideways to read the whole line.';
  const page = await pdfDoc.getPage(f.page + 1);
  if (seq !== excerptSeq) return;
  const vp = page.getViewport({ scale: EXCERPT_SCALE });
  const r = boxToViewRect(vp, f);
  const side = await statementSide(page, vp, r);
  if (seq !== excerptSeq) return;
  const band = EXCERPT_BAND_PT * EXCERPT_SCALE;
  const top = Math.max(0, Math.floor(r.top - band));
  const bottom = Math.min(Math.floor(vp.height), Math.ceil(r.top + r.height + band));
  const w = Math.floor(vp.width);
  const h = Math.max(1, bottom - top);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const inner = document.createElement('div');
  inner.className = 'es-excerpt-page';
  inner.style.width = `${w}px`;
  inner.style.height = `${h}px`;
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const mark = document.createElement('div');
  mark.className = 'es-excerpt-box';
  mark.style.left = `${r.left}px`;
  mark.style.top = `${r.top - top}px`;
  mark.style.width = `${r.width}px`;
  mark.style.height = `${r.height}px`;
  inner.appendChild(canvas);
  inner.appendChild(mark);
  el.excerpt.appendChild(inner);
  // Open where the statement STARTS. A box at the left of its line has the
  // words to its right: start just left of the box. A box at the right
  // margin ("…is accurate and current: [ ]") has them to its LEFT, and
  // starting at the box showed only the last word or two. The page's text
  // layer says which side the nearest words are on; with no text there (a
  // scanned page) the box-first start stands.
  el.excerpt.scrollLeft = Math.max(0, (side && side.side === 'left' ? side.start : r.left) - 24);
  // Opening at the first word can leave the box itself past the right edge.
  if (r.left + r.width > el.excerpt.scrollLeft + el.excerpt.clientWidth) {
    el.checkHint.textContent = 'Scroll the excerpt sideways: the box is at the end of this line.';
  }

  await page.render({
    canvasContext: canvas.getContext('2d'),
    viewport: vp,
    // Shift the page up so the band's top edge lands on the canvas origin.
    transform: [dpr, 0, 0, dpr, 0, -top * dpr],
  }).promise;
  if (seq !== excerptSeq) return;
  if (el.excerpt.scrollWidth <= el.excerpt.clientWidth + 1) el.checkHint.textContent = '';
}

function closeSheet() {
  excerptSeq++;              // abandon an excerpt still rendering
  el.excerpt.textContent = '';
  el.sheet.hidden = true;
  activeField = null;
  document.querySelectorAll('.es-field.is-target').forEach((n) => n.classList.remove('is-target'));
}

el.sheetClose.addEventListener('click', closeSheet);
el.sheet.addEventListener('click', (e) => { if (e.target === el.sheet) closeSheet(); });
el.tabs.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) setSheetMode(b.dataset.mode);
});
el.undo.addEventListener('click', () => { pad.strokes.pop(); pad.redraw(); syncApply(); });
el.clear.addEventListener('click', () => { pad.strokes = []; pad.redraw(); syncApply(); });
el.typeInput.addEventListener('input', () => { el.typePreview.textContent = el.typeInput.value; syncApply(); });
el.textInput.addEventListener('input', syncApply);
el.textInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !el.apply.disabled) el.apply.click(); });

el.apply.addEventListener('click', () => {
  const f = activeField;
  if (!f) return;
  if (f.type === 'checkbox') {
    // The sheet's own button, pressed after the excerpt was on screen: the
    // signer's affirmative act on this box.
    values[f.id] = { checked: !isChecked(f) };
  } else if (isInk(f)) {
    const png = sheetMode === 'draw' ? pad.toPNG() : typedToPNG(el.typeInput.value);
    if (!png) return;
    values[f.id] = { png };
  } else {
    const text = el.textInput.value.trim();
    if (!text) return;
    values[f.id] = { text };
  }
  repaint(f);
  closeSheet();
  // Walk them straight to whatever is still blank.
  const nxt = remaining()[0];
  if (nxt) scrollToField(nxt);
});

/* ── navigation ────────────────────────────────────────────────────────── */
function scrollToField(f) {
  const node = document.querySelector(`.es-field[data-field-id="${CSS.escape(f.id)}"]`);
  if (!node) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  document.querySelectorAll('.es-field.is-target').forEach((n) => n.classList.remove('is-target'));
  node.classList.add('is-target');
}
el.next.addEventListener('click', () => {
  const nxt = remaining()[0];
  if (nxt) { scrollToField(nxt); setTimeout(() => openField(nxt, { viaNext: true }), 320); }
});

/* ── finish ────────────────────────────────────────────────────────────── */
el.finish.addEventListener('click', () => {
  el.doneErr.hidden = true;
  el.signerName.value = el.signerName.value || envelope.signerName || '';
  el.done.hidden = false;
  syncSubmit();
});
el.doneClose.addEventListener('click', () => { el.done.hidden = true; });
el.doneBack.addEventListener('click', () => { el.done.hidden = true; });
el.done.addEventListener('click', (e) => { if (e.target === el.done) el.done.hidden = true; });

function syncSubmit() {
  el.submit.disabled = !(el.consent.checked && el.signerName.value.trim().length >= 2);
}
el.consent.addEventListener('change', syncSubmit);
el.signerName.addEventListener('input', syncSubmit);

el.submit.addEventListener('click', async () => {
  if (submitting) return;
  submitting = true;
  el.submit.disabled = true;
  const original = el.submit.textContent;
  el.submit.textContent = 'Submitting…';
  el.doneErr.hidden = true;

  const r = await post('submitEsignEnvelope', {
    token,
    values,
    consent: el.consent.checked === true,
    signerName: el.signerName.value.trim(),
  }).catch(() => ({ ok: false, status: 0, data: {} }));

  if (r.ok && r.data.ok) {
    el.done.hidden = true;
    el.foot.hidden = true;
    el.zoomCtl.hidden = true;
    if (el.declineBtn) el.declineBtn.hidden = true;
    if (r.data.complete === false) {
      // Multi-signer: someone signs after this person, on their own link.
      showMsg('✅', 'Thank you — your signature is recorded',
        (r.data.nextSigner ? r.data.nextSigner : 'The next signer') +
        ' will get their own link to sign next. Once everyone has signed, a copy comes to your email.');
    } else {
      showMsg('🎉', 'All done — thank you!',
        'Your signature has been recorded. A signed copy is on its way to your email, and your rep has been told. You can close this page.');
    }
    return;
  }

  submitting = false;
  el.submit.disabled = false;
  el.submit.textContent = original;

  if (r.status === 409 || r.status === 410) {
    el.done.hidden = true;
    el.foot.hidden = true;
    // Same distinction boot() already makes on the initial load: a revoked
    // link is not a signed one, and telling the signer it is both false and
    // leaves them nothing to act on.
    const reason = r.data.reason || '';
    if (reason === 'revoked') showMsg('🚫', 'Link cancelled', r.data.error || 'This link was cancelled. Please use the latest link.');
    else if (reason === 'declined') showMsg('👋', 'Declined', r.data.error || 'This document was declined.');
    else if (reason === 'expired') showMsg('⏳', 'This link expired', r.data.error || 'This signing link has expired.');
    else showMsg('✅', 'Already signed', r.data.error || 'This document has already been signed.');
    return;
  }
  if (Array.isArray(r.data.missing) && r.data.missing.length) {
    el.doneErr.textContent = 'Some required fields are still blank. Close this and tap “Next field”.';
    el.doneErr.hidden = false;
    // Trust the server over our own bookkeeping about what is missing.
    for (const id of r.data.missing) delete values[id];
    placeFields();
    return;
  }
  el.doneErr.textContent = r.data.error || (r.status === 0
    ? 'Connection problem — check your signal and try again.'
    : 'Could not submit. Please try again.');
  el.doneErr.hidden = false;
});

function reportRenderError(e) {
  console.error('[esign] render failed', e);
  showMsg('⚠️', 'Could not display the document',
    'Something went wrong while drawing the pages. Please reload, or ask your rep to resend.');
}

/* ── boot ──────────────────────────────────────────────────────────────── */
async function boot() {
  if (!token || token.length < 10) {
    showMsg('⚠️', 'Invalid link', 'This signing link looks incomplete. Please use the button in your email.');
    return;
  }

  let r;
  try { r = await post('getEsignEnvelope', { token }); }
  catch (_) {
    showMsg('📡', 'Connection problem', 'Could not reach the server. Check your connection and reload.');
    return;
  }

  if (!r.ok) {
    // Expired, revoked and already-signed are DISTINCT here. The old page
    // told an expired link "already signed", which is false and leaves the
    // homeowner with nothing to do about it.
    const reason = r.data.reason || '';
    if (r.status === 410 && reason === 'signed') showMsg('✅', 'Already signed', r.data.error);
    else if (r.status === 410 && reason === 'expired') showMsg('⏳', 'This link expired', r.data.error);
    else if (r.status === 410 && reason === 'revoked') showMsg('🚫', 'Link cancelled', r.data.error);
    else if (r.status === 410 && reason === 'declined') showMsg('👋', 'Declined', r.data.error);
    else if (r.status === 404) showMsg('🔗', 'Invalid link', r.data.error || 'This signing link is not valid.');
    else if (r.status === 429) showMsg('⏳', 'Too many tries', 'Please wait a minute and reload the page.');
    else showMsg('⚠️', 'Could not load', r.data.error || 'Something went wrong. Please try again shortly.');
    return;
  }

  envelope = r.data;
  if (envelope.companyName) {
    el.brand.textContent = envelope.companyName;
    try { document.title = `Review & Sign · ${envelope.companyName}`; } catch (_) {}
  }
  el.title.textContent = envelope.title ? `· ${envelope.title}` : '';
  if (Number(envelope.signerCount) > 1) {
    // Multi-signer: say whose turn this is, so a co-owner knows the first
    // signature is not missing — it is drawn in when everyone has signed.
    const of = document.createElement('span');
    of.className = 'es-signer-of';
    of.textContent = ` · Signer ${(Number(envelope.signerIndex) || 0) + 1} of ${envelope.signerCount}`;
    el.title.appendChild(of);
  }
  if (el.declineBtn && envelope.canDecline !== false) el.declineBtn.hidden = false;
  el.consentText.textContent = envelope.consentText || 'I agree to sign electronically.';
  el.signerName.value = envelope.signerName || '';

  if (!Array.isArray(envelope.fields) || envelope.fields.length === 0) {
    // Refused server-side at send time too; this is the belt to that braces.
    showMsg('⚠️', 'This document can’t be signed',
      'It was sent without any fields to fill in. Please contact your rep for a corrected copy.');
    return;
  }

  let bytes;
  try {
    bytes = Uint8Array.from(atob(envelope.pdf), (c) => c.charCodeAt(0));
  } catch (_) {
    showMsg('⚠️', 'Could not read the document', 'Please reload, or ask your rep to resend it.');
    return;
  }

  try {
    pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const first = await pdfDoc.getPage(1);
    fitScale = computeFitScale(first);
    scale = fitScale;
    await renderAll();
  } catch (e) { reportRenderError(e); return; }

  hideMsg();
  el.foot.hidden = false;
  el.zoomCtl.hidden = false;
  updateProgress();

  const firstField = remaining()[0] || (envelope.fields || [])[0];
  if (firstField) setTimeout(() => scrollToField(firstField), 220);
}

// Re-fit on rotation. The old widget never handled resize, so rotating the
// phone left strokes landing away from the finger.
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!pdfDoc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    const first = await pdfDoc.getPage(1);
    const wasFit = Math.abs(scale - fitScale) < 0.01;
    fitScale = computeFitScale(first);
    if (wasFit) { scale = fitScale; await renderAll().catch(reportRenderError); }
    else placeFields();
  }, 200);
});

boot();
