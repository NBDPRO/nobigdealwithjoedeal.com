/**
 * esign-setup.js — the rep places the fields, at /pro/esign-setup.
 *
 * Upload any PDF, let the form tell us where its own fields are, adjust, and
 * send one link. Query params: ?lead=<leadId> to start a new envelope,
 * ?env=<envelopeId> to re-open a draft.
 *
 * WHY PLACEMENT EXISTS AT ALL
 * The older signing path had no positioning model of any kind: signature
 * blocks were emitted by whichever document template you happened to use, at
 * whatever spot that template hardcoded, and only one of the 27 templates
 * emitted a usable one. Nothing could be signed that we had not generated
 * ourselves — a supplier form or an insurance scope had no path through the
 * system at all.
 *
 * COORDINATES. Every field is stored in PDF user space via
 * `viewport.convertToPdfPoint`, so a box drawn at 300% zoom on a rotated page
 * is stored identically to one drawn at 50% on an upright one, and
 * functions/esign-stamp.js draws it with no transform. Storing normalised
 * fractions of the rendered page instead would break on any rotated or
 * cropped page — which scanned insurance forms routinely are.
 */

import { initializeApp, getApps } from '/assets/vendor/firebase/10.12.2/firebase-app.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from '/assets/vendor/firebase/10.12.2/firebase-app-check.js';
import { getAuth, onAuthStateChanged } from '/assets/vendor/firebase/10.12.2/firebase-auth.js';
import { getStorage, ref as storageRef, uploadBytes } from '/assets/vendor/firebase/10.12.2/firebase-storage.js';
import { getFunctions, httpsCallable } from '/assets/vendor/firebase/10.12.2/firebase-functions.js';
import * as pdfjsLib from '/assets/vendor/pdfjs/pdf.min.mjs';
import { connectEmulatorsIfLocal, emulatorAppCheckIfLocal } from './nbd-emulator-connect.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdfjs/pdf.worker.min.mjs';

// Canonical config — mirrors nbd-auth.js. A fabricated apiKey here would make
// getAuth() miss the live session entirely (see the photo-review.js note).
const firebaseConfig = {
  apiKey: 'AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg',
  authDomain: 'nobigdeal-pro.firebaseapp.com',
  projectId: 'nobigdeal-pro',
  storageBucket: 'nobigdeal-pro.firebasestorage.app',
  messagingSenderId: '717435841570',
  appId: '1:717435841570:web:c2338e11052c96fde02e7b',
};
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
// Locally, the emulator App Check shim (same as login/register): reCAPTCHA
// can't mint a token on localhost, so createEsignEnvelope (enforceAppCheck)
// answered "Unauthenticated" and e-sign setup was untestable in the rig.
// No-op off localhost — production takes the reCAPTCHA branch below.
const _emuAppCheck = await emulatorAppCheckIfLocal(app);
try {
  if (!_emuAppCheck && typeof window.__NBD_APP_CHECK_KEY === 'string' && window.__NBD_APP_CHECK_KEY) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(window.__NBD_APP_CHECK_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  }
} catch (_) {}
const auth = getAuth(app);
const storage = getStorage(app);
const fns = getFunctions(app, 'us-central1');
// Awaited, like every other call site: a callable firing before the emulator
// is wired would silently hit prod from a dev machine. No-op off localhost.
try { await connectEmulatorsIfLocal({ auth, functions: fns, storage }); } catch (_) {}

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const leadId = qs.get('lead') || '';
let envelopeId = qs.get('env') || '';

const el = {
  title: $('suTitle'), drop: $('suDrop'), file: $('suFile'), dropErr: $('suDropErr'),
  work: $('suWork'), tools: $('suTools'), auto: $('suAuto'), clear: $('suClear'), count: $('suCount'),
  scroll: $('suScroll'), doc: $('suDoc'),
  msg: $('suMsg'), msgTitle: $('suMsgTitle'), msgBody: $('suMsgBody'),
  zoomCtl: $('suZoomCtl'), zoomIn: $('suZoomIn'), zoomOut: $('suZoomOut'), zoomFit: $('suZoomFit'), zoomPct: $('suZoomPct'),
  signerName: $('suSignerName'), signerEmail: $('suSignerEmail'),
  save: $('suSave'), send: $('suSend'), status: $('suStatus'), void: $('suVoid'),
  sent: $('suSent'), sentClose: $('suSentClose'), sentNote: $('suSentNote'),
  link: $('suLink'), copy: $('suCopy'), open: $('suOpen'),
  generatedHint: $('suGeneratedHint'), generatedHintLink: $('suGeneratedHintLink'),
  cancelForms: $('suCancelForms'),
};

// Point the "sign a generated doc instead" hint at THIS customer's Documents
// tab. Only meaningful with a real lead — esign-setup is always launched
// with ?lead=, but stay defensive rather than link to a bare '#documentsTab'
// that resolves against esign-setup's own (leadless) page.
if (leadId && el.generatedHint && el.generatedHintLink) {
  el.generatedHintLink.href = '/pro/customer.html?id=' + encodeURIComponent(leadId) + '#documentsTab';
  el.generatedHint.hidden = false;
}

let uid = null;
let currentStatus = 'draft';
let pdfDoc = null;
let pdfBytes = null;
let scale = 1, fitScale = 1;
let tool = 'signature';
let fields = [];
const pageViews = [];
let seq = 0;

const nid = () => `f${Date.now().toString(36)}${(seq++).toString(36)}`;

function busy(title, body) {
  el.msgTitle.textContent = title;
  el.msgBody.textContent = body || '';
  el.msg.hidden = false;
}
function idle() { el.msg.hidden = true; }
function status(text, bad) {
  el.status.textContent = text;
  el.status.classList.toggle('bad', !!bad);
  el.status.hidden = false;
}
// A live token only exists once the envelope is sent and before it's signed —
// voiding a draft (no link exists yet) or a completed/already-voided envelope
// is meaningless, and voidEsignEnvelope itself rejects 'completed'.
function updateVoidVisibility() {
  el.void.hidden = currentStatus !== 'sent' && currentStatus !== 'viewed';
}

/* ── render ────────────────────────────────────────────────────────────── */
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    wrap.appendChild(canvas);

    const layer = document.createElement('div');
    layer.className = 'es-layer';
    layer.style.pointerEvents = 'auto';
    wrap.appendChild(layer);

    const hit = document.createElement('div');
    hit.className = 'su-page-hit';
    layer.appendChild(hit);

    el.doc.appendChild(wrap);
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;

    const pv = { pageNum: n, index: n - 1, canvas, layer, hit, viewport, page };
    pageViews.push(pv);
    wireDraw(pv);
  }
  paintFields();
  el.zoomPct.textContent = `${Math.round((scale / fitScale) * 100)}%`;
}

/* PDF box -> viewport rect (rotation-safe). */
function toRect(viewport, f) {
  const a = viewport.convertToViewportPoint(f.x, f.y);
  const b = viewport.convertToViewportPoint(f.x + f.w, f.y + f.h);
  return {
    left: Math.min(a[0], b[0]), top: Math.min(a[1], b[1]),
    width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]),
  };
}
/* Viewport rect -> PDF box (the inverse; what we persist). */
function toPdfBox(viewport, left, top, width, height) {
  const a = viewport.convertToPdfPoint(left, top);
  const b = viewport.convertToPdfPoint(left + width, top + height);
  return {
    x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
    w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]),
  };
}

const LABEL = { signature: 'Signature', initials: 'Initials', date: 'Date', text: 'Text', checkbox: 'Check' };

function paintFields() {
  for (const pv of pageViews) {
    pv.layer.querySelectorAll('.su-field').forEach((n) => n.remove());
  }
  for (const f of fields) {
    const pv = pageViews[f.page];
    if (!pv) continue;
    const r = toRect(pv.viewport, f);

    const node = document.createElement('div');
    node.className = 'su-field'
      + (f.source === 'auto' ? ' is-auto' : '')
      + (f.required === false ? ' is-optional' : '');
    node.style.left = `${r.left}px`;
    node.style.top = `${r.top}px`;
    node.style.width = `${r.width}px`;
    node.style.height = `${r.height}px`;
    node.dataset.id = f.id;

    const lbl = document.createElement('span');
    lbl.className = 'su-lbl';
    lbl.textContent = LABEL[f.type] || f.type;
    lbl.style.fontSize = `${Math.max(8, Math.min(12, r.height * 0.4))}px`;
    node.appendChild(lbl);

    const req = document.createElement('button');
    req.type = 'button';
    req.className = 'su-req ' + (f.required === false ? 'opt' : 'req');
    req.textContent = f.required === false ? 'OPT' : 'REQ';
    req.title = 'Toggle required';
    req.addEventListener('pointerdown', (e) => e.stopPropagation());
    req.addEventListener('click', (e) => {
      e.stopPropagation();
      f.required = f.required === false;
      paintFields();
    });
    node.appendChild(req);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'su-del';
    del.textContent = '✕';
    del.title = 'Remove field';
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      fields = fields.filter((x) => x.id !== f.id);
      paintFields();
    });
    node.appendChild(del);

    const grip = document.createElement('div');
    grip.className = 'su-grip';
    node.appendChild(grip);

    wireMove(node, grip, f, pv);
    pv.layer.appendChild(node);
  }
  el.count.textContent = `${fields.length} field${fields.length === 1 ? '' : 's'}`;
  el.send.disabled = fields.length === 0;
}

/* ── draw a new field ──────────────────────────────────────────────────── */
const MIN = 10;
function wireDraw(pv) {
  let start = null, ghost = null;
  pv.hit.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    const r = pv.layer.getBoundingClientRect();
    start = { x: e.clientX - r.left, y: e.clientY - r.top };
    ghost = document.createElement('div');
    ghost.className = 'su-ghost';
    pv.layer.appendChild(ghost);
    try { pv.hit.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  pv.hit.addEventListener('pointermove', (e) => {
    if (!start || !ghost) return;
    const r = pv.layer.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const left = Math.min(start.x, cx), top = Math.min(start.y, cy);
    ghost.style.left = `${left}px`;
    ghost.style.top = `${top}px`;
    ghost.style.width = `${Math.abs(cx - start.x)}px`;
    ghost.style.height = `${Math.abs(cy - start.y)}px`;
  });
  const finish = (e) => {
    if (!start) return;
    const r = pv.layer.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    let left = Math.min(start.x, cx), top = Math.min(start.y, cy);
    let w = Math.abs(cx - start.x), h = Math.abs(cy - start.y);
    if (ghost) { ghost.remove(); ghost = null; }
    start = null;

    // A tap (rather than a drag) drops a sensibly-sized default box, so
    // placing a field is one tap on a phone instead of a precise drag.
    if (w < MIN || h < MIN) {
      // defaultSize() returns a {w,h} in PDF points; each dimension is scaled
      // to viewport px separately. Multiplying the OBJECT by scale yields NaN
      // and persists a field with null coordinates.
      const d = defaultSize(tool);
      w = d.w * scale;
      h = d.h * scale;
      left = Math.max(0, left - w / 2);
      top = Math.max(0, top - h / 2);
    }
    const box = toPdfBox(pv.viewport, left, top, w, h);
    // Finite-check, not just a size floor: `NaN < 4` is false, so a NaN box
    // sailed past a bare size check and was placed with null coordinates.
    if (![box.x, box.y, box.w, box.h].every(Number.isFinite)) return;
    if (box.w < 4 || box.h < 4) return;
    fields.push(Object.assign({
      id: nid(), type: tool, page: pv.index,
      required: tool !== 'text', label: '', role: 'signer',
    }, box));
    paintFields();
  };
  pv.hit.addEventListener('pointerup', finish);
  pv.hit.addEventListener('pointercancel', () => { if (ghost) ghost.remove(); ghost = null; start = null; });
}

function defaultSize(type) {
  const S = (window.NBDEsignAutodetect && window.NBDEsignAutodetect.SIZES) || {};
  const s = S[type] || { w: 160, h: 24 };
  return { w: s.w, h: s.h };
}

/* ── move / resize an existing field ───────────────────────────────────── */
function wireMove(node, grip, f, pv) {
  let mode = null, origin = null, box0 = null;

  const begin = (e, m) => {
    mode = m;
    const r = pv.layer.getBoundingClientRect();
    origin = { x: e.clientX - r.left, y: e.clientY - r.top };
    box0 = toRect(pv.viewport, f);
    try { (m === 'resize' ? grip : node).setPointerCapture(e.pointerId); } catch (_) {}
    e.stopPropagation();
    e.preventDefault();
  };
  node.addEventListener('pointerdown', (e) => begin(e, 'move'));
  grip.addEventListener('pointerdown', (e) => begin(e, 'resize'));

  const onMove = (e) => {
    if (!mode) return;
    const r = pv.layer.getBoundingClientRect();
    const dx = (e.clientX - r.left) - origin.x;
    const dy = (e.clientY - r.top) - origin.y;
    let left = box0.left, top = box0.top, w = box0.width, h = box0.height;
    if (mode === 'move') { left += dx; top += dy; }
    else { w = Math.max(MIN, w + dx); h = Math.max(MIN, h + dy); }
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.style.width = `${w}px`;
    node.style.height = `${h}px`;
    Object.assign(f, toPdfBox(pv.viewport, left, top, w, h));
  };
  const end = () => { if (mode) { mode = null; paintFields(); } };
  node.addEventListener('pointermove', onMove);
  grip.addEventListener('pointermove', onMove);
  node.addEventListener('pointerup', end);
  grip.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  grip.addEventListener('pointercancel', end);
}

/* ── auto-detect ───────────────────────────────────────────────────────── */
el.auto.addEventListener('click', async () => {
  const AD = window.NBDEsignAutodetect;
  if (!AD) { status('Auto-detect is unavailable — place fields by hand.', true); return; }
  busy('Reading the document…', 'Looking for signature, initials and date lines.');
  let added = 0;
  try {
    for (const pv of pageViews) {
      const tc = await pv.page.getTextContent();
      // getTextContent() reports item positions in the page's own RAW,
      // UNROTATED user space (matching pv.page.view / the mediabox) — not
      // the rotation-aware viewport, which SWAPS width/height on a 90 or
      // 270 degree rotated page. Clamping against the rotated dimensions
      // here would corrupt (or drop) fields detected in the upper portion
      // of a rotated scan. pv.page.view is [x0, y0, x1, y1] in that same
      // raw space, so its own width/height are always correct regardless
      // of rotation.
      const view = pv.page.view;
      const pageSize = { w: view[2] - view[0], h: view[3] - view[1] };
      const found = AD.detectFields(tc.items, pageSize, {
        pageIndex: pv.index, idPrefix: `a${pv.index}_`,
      });
      for (const f of found) {
        // Never stack a proposal on a field already placed.
        const dup = fields.some((g) => g.page === f.page
          && Math.abs(g.x - f.x) < 24 && Math.abs(g.y - f.y) < 18);
        if (dup) continue;
        fields.push(Object.assign({}, f, { id: nid(), source: 'auto' }));
        added++;
      }
    }
  } catch (e) {
    idle();
    status('Could not read this PDF’s text layer — it may be a pure scan. Place fields by hand.', true);
    return;
  }
  idle();
  paintFields();
  status(added
    ? `Found ${added} field${added === 1 ? '' : 's'}. Check each one, drag to adjust, then send.`
    : 'No signature lines found — this may be a scan with no text layer. Place fields by hand.',
    added === 0);
});

el.clear.addEventListener('click', async () => {
  if (!fields.length) return;
  // nbdConfirm is a real DOM modal; the raw-confirm fallback is the house
  // idiom for pages that do not load standalone-compat.js.
  // tests/pwa-confirm-guard.test.js holds this line.
  const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  if (!(await ask(`Remove all ${fields.length} fields?`))) return;
  fields = [];
  paintFields();
});

el.tools.addEventListener('click', (e) => {
  const b = e.target.closest('.su-tool');
  if (!b) return;
  tool = b.dataset.type;
  el.tools.querySelectorAll('.su-tool').forEach((n) => n.classList.toggle('on', n === b));
});

/* ── zoom ──────────────────────────────────────────────────────────────── */
let rt = null;
function setScale(next) {
  const c = Math.max(fitScale * 0.5, Math.min(fitScale * 4, next));
  if (Math.abs(c - scale) < 0.001) return;
  scale = c;
  el.zoomPct.textContent = `${Math.round((scale / fitScale) * 100)}%`;
  clearTimeout(rt);
  rt = setTimeout(() => { renderAll().catch(() => {}); }, 90);
}
el.zoomIn.addEventListener('click', () => setScale(scale * 1.25));
el.zoomOut.addEventListener('click', () => setScale(scale / 1.25));
el.zoomFit.addEventListener('click', () => setScale(fitScale));

/* ── persistence ───────────────────────────────────────────────────────── */
function wireFields() {
  return fields.map((f) => ({
    id: f.id, type: f.type, page: f.page,
    x: +f.x.toFixed(2), y: +f.y.toFixed(2), w: +f.w.toFixed(2), h: +f.h.toFixed(2),
    required: f.required !== false,
    label: f.label || '', role: f.role || 'signer',
  }));
}

// Read-only view of exactly what Save would persist. The placement UI's one
// critical property — that a box drawn at any zoom on any page rotation
// round-trips to the same PDF coordinates — is only observable here, so
// tests/esign-setup-placement.test.js reads it. Deliberately a copy: nothing
// outside this module can mutate the field list through it.
window.__peekFields = () => wireFields();

async function save() {
  if (!envelopeId) { status('Upload a PDF first.', true); return false; }
  try {
    await httpsCallable(fns, 'saveEsignFields')({
      envelopeId,
      fields: wireFields(),
      signerName: el.signerName.value.trim(),
      signerEmail: el.signerEmail.value.trim(),
      cancelFormsIncluded: !!(el.cancelForms && el.cancelForms.checked),
    });
    status(`Saved — ${fields.length} field${fields.length === 1 ? '' : 's'}.`);
    return true;
  } catch (e) {
    status(e && e.message ? e.message : 'Could not save.', true);
    return false;
  }
}
el.save.addEventListener('click', save);

el.send.addEventListener('click', async () => {
  if (!fields.length) { status('Place at least one field before sending.', true); return; }
  el.send.disabled = true;
  const saved = await save();
  if (!saved) { el.send.disabled = false; return; }
  try {
    const r = await httpsCallable(fns, 'sendEsignEnvelope')({
      envelopeId,
      signerName: el.signerName.value.trim(),
      signerEmail: el.signerEmail.value.trim(),
      // With no email address, still mint the link so the rep can text it or
      // hand the phone over at the kitchen table.
      sendEmail: !!el.signerEmail.value.trim(),
    });
    const d = r.data || {};
    el.link.value = d.link || '';
    el.open.href = d.link || '#';
    el.sentNote.textContent = d.emailed
      ? `Emailed to ${el.signerEmail.value.trim()}. The link expires in 14 days and can only be used once.`
      : 'Link ready — text it to the signer or hand them the phone. It expires in 14 days and can only be used once.';
    el.sent.hidden = false;
    currentStatus = 'sent';
    updateVoidVisibility();
    status('Sent.');
  } catch (e) {
    status(e && e.message ? e.message : 'Could not send.', true);
  }
  el.send.disabled = false;
});

el.void.addEventListener('click', async () => {
  // nbdConfirm is a real DOM modal; the raw-confirm fallback is the house
  // idiom for pages that do not load standalone-compat.js.
  // tests/pwa-confirm-guard.test.js holds this line.
  const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  if (!(await ask('Void this link? The signer will no longer be able to open or sign it. You can send a fresh link afterward.'))) return;
  el.void.disabled = true;
  try {
    await httpsCallable(fns, 'voidEsignEnvelope')({ envelopeId });
    currentStatus = 'voided';
    updateVoidVisibility();
    el.sent.hidden = true;
    status('Link voided. Send a new one whenever you’re ready.');
  } catch (e) {
    status(e && e.message ? e.message : 'Could not void this link.', true);
  }
  el.void.disabled = false;
});

el.sentClose.addEventListener('click', () => { el.sent.hidden = true; });
el.copy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(el.link.value); el.copy.textContent = 'Copied'; }
  catch (_) { el.link.select(); }
  setTimeout(() => { el.copy.textContent = 'Copy link'; }, 1500);
});

/* ── load ──────────────────────────────────────────────────────────────── */
async function openBytes(bytes, title) {
  pdfBytes = bytes;
  pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  el.title.textContent = title ? `· ${title}` : '';
  el.drop.hidden = true;
  el.work.hidden = false;
  el.zoomCtl.hidden = false;
  const first = await pdfDoc.getPage(1);
  const avail = el.scroll.clientWidth - 24;
  fitScale = Math.max(0.2, Math.min(3, avail / first.getViewport({ scale: 1 }).width));
  scale = fitScale;
  await renderAll();
}

// Read every page's text and ask esign-autodetect.js whether the two FTC
// cancellation forms are already in this PDF. Best-effort: false on error.
async function pdfHasCancelForms() {
  const AD = window.NBDEsignAutodetect;
  if (!AD || typeof AD.hasCancelForms !== 'function' || !pdfDoc) return false;
  try {
    const pages = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const pg = await pdfDoc.getPage(i);
      pages.push((await pg.getTextContent()).items);
    }
    return AD.hasCancelForms(pages);
  } catch (_) { return false; }
}

el.file.addEventListener('change', async () => {
  const file = el.file.files && el.file.files[0];
  if (!file) return;
  el.dropErr.hidden = true;
  if (file.type && file.type !== 'application/pdf') {
    el.dropErr.textContent = 'That is not a PDF. Only PDFs can be sent for signature.';
    el.dropErr.hidden = false;
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    el.dropErr.textContent = 'That PDF is larger than 25 MB. Please compress it and try again.';
    el.dropErr.hidden = false;
    return;
  }
  if (!leadId) {
    el.dropErr.textContent = 'No customer selected. Open this page from a customer record.';
    el.dropErr.hidden = false;
    return;
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  // Render from the LOCAL file — no round trip, and no dependence on bucket
  // CORS for the common path.
  try { await openBytes(buf, file.name.replace(/\.pdf$/i, '')); }
  catch (_) {
    el.dropErr.textContent = 'That PDF could not be opened. It may be corrupt or password-protected.';
    el.dropErr.hidden = false;
    return;
  }

  // A contract that already carries the two FTC Notice of Cancellation forms
  // must not get a second set with a different date when it is signed
  // (review R4 D8, 2026-10-08). The box starts from the PDF's own text; the
  // rep can change it before sending (a scan has no text to read).
  if (el.cancelForms) el.cancelForms.checked = await pdfHasCancelForms();

  busy('Uploading…', 'Storing the document securely.');
  const id = nid() + Math.random().toString(36).slice(2, 8);
  const path = `esign/${uid}/${leadId}/${id}/source.pdf`;
  try {
    await uploadBytes(storageRef(storage, path), buf, { contentType: 'application/pdf' });
    const r = await httpsCallable(fns, 'createEsignEnvelope')({
      leadId, envelopeId: id, sourcePath: path,
      title: file.name.replace(/\.pdf$/i, ''),
      cancelFormsIncluded: !!(el.cancelForms && el.cancelForms.checked),
    });
    envelopeId = (r.data && r.data.envelopeId) || id;
    idle();
    status('Uploaded. Try “Auto-detect fields”, or drag a box where the signature goes.');
  } catch (e) {
    idle();
    status(e && e.message ? e.message : 'Upload failed — the document is shown but not saved yet.', true);
  }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) { location.href = '/pro/login?next=' + encodeURIComponent(location.pathname + location.search); return; }
  uid = user.uid;
  if (!envelopeId) {                        // new envelope: wait for a file
    // Pre-fill the signer from this customer (the rep had to retype both,
    // and a typo'd email sends a legal document to the wrong person). Only
    // fills empty boxes; best-effort — rules or a missing lead just leave
    // them blank as before.
    if (leadId) {
      try {
        const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
        const db = fs.getFirestore(app);
        try { await connectEmulatorsIfLocal({ db }); } catch (_) {}
        const snap = await fs.getDoc(fs.doc(db, 'leads', leadId));
        if (snap.exists()) {
          const l = snap.data() || {};
          const nm = ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || '';
          if (nm && !el.signerName.value.trim()) el.signerName.value = nm;
          if (l.email && !el.signerEmail.value.trim()) el.signerEmail.value = l.email;
        }
      } catch (_) { /* leave the signer boxes for the rep */ }
    }
    return;
  }
  busy('Loading…', 'Fetching the document you started.');
  try {
    const r = await httpsCallable(fns, 'getEsignEnvelopeForOwner')({ envelopeId });
    const d = r.data || {};
    const bytes = Uint8Array.from(atob(d.pdf), (c) => c.charCodeAt(0));
    fields = (d.fields || []).map((f) => Object.assign({}, f));
    el.signerName.value = d.signerName || '';
    el.signerEmail.value = d.signerEmail || '';
    if (el.cancelForms) el.cancelForms.checked = d.cancelFormsIncluded === true;
    await openBytes(bytes, d.title);
    idle();
    currentStatus = d.status || 'draft';
    updateVoidVisibility();
    if (d.status && d.status !== 'draft') {
      status(`This envelope is already ${d.status}. Sending again will revoke the old link and issue a new one.`, true);
    }
  } catch (e) {
    idle();
    el.drop.hidden = false;
    el.dropErr.textContent = (e && e.message) || 'Could not load that envelope.';
    el.dropErr.hidden = false;
  }
});
