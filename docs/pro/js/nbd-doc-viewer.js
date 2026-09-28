// ═══════════════════════════════════════════════════════════════
// NBD Pro — Universal Document Viewer (NBDDocViewer)
//
// One in-app modal that renders every generator's final document.
// Replaces the legacy `window.open('', '_blank') + document.write`
// popup pattern that lost the user into a dead-end blank window
// with no way to save, connect, or come back.
//
// Public API:
//   window.NBDDocViewer.open({
//     html:     string (required)  — full HTML document to display
//     title:    string              — header title (e.g. "Insurance Scope")
//     filename: string              — PDF filename (default: "Document.pdf")
//     leadId:   string              — optional — pre-link to a customer
//     onSave:   async (ctx) => ...  — custom save callback
//     allowClose: boolean           — whether to show the X close button
//   });
//
// Action buttons (always visible in the footer):
//   - Save to Customer — pick a lead + persist via onSave or default
//   - Email — opens mailto: with the doc link
//   - Print — iframe.contentWindow.print()
//   - Download PDF — html2pdf.js → file download (client-side)
//   - Close — warn-then-allow (confirm dialog if onSave hasn't fired)
//
// Security: the HTML is rendered inside an <iframe srcdoc> so any
// scripts inside the document run in a separate origin-less context
// that can't touch the parent app's state. We also escape the title
// and filename before display.
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // Guard: don't double-register if the script loads twice.
  if (window.NBDDocViewer && window.NBDDocViewer.__sentinel === 'nbd-doc-viewer-v1') return;

  // ─── State ───────────────────────────────────────────────
  let currentOverlay = null;
  let currentContext = null;
  let dirty = false;  // set per-open: true only when the doc has a save/sign path
  let escHandler = null;
  // Set when finalizeSignaturesIfPresent() is awaiting a reply from
  // the widget inside the iframe. The window-level message listener
  // (installed once) calls this with the parsed reply payload.
  let pendingFinalizeResolver = null;
  let messageListenerInstalled = false;

  // ─── HTML escape helper ──────────────────────────────────
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // ─── Inject a tiny postMessage listener into the iframe ──
  // Since H-2 removed 'allow-same-origin', the parent can no longer
  // call iframe.contentWindow.print() across origins. Instead we
  // wrap every srcdoc payload with a 100-byte listener that calls
  // window.print() when it receives our print message. The message
  // is opaque-matched on __nbdv so random postMessage spam from
  // other browser tabs can't trigger prints.
  const PRINT_LISTENER_SCRIPT = `<script>(function(){
    window.addEventListener('message', function(e){
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.__nbdv === 'print') { try { window.focus(); } catch(_){} try { window.print(); } catch(_){} }
    });
  })();</script>`;
  function wrapWithPrintListener(html) {
    if (typeof html !== 'string' || !html.length) return html || '';
    // Insert just before </body> when possible; otherwise append.
    const idx = html.toLowerCase().lastIndexOf('</body>');
    if (idx >= 0) return html.slice(0, idx) + PRINT_LISTENER_SCRIPT + html.slice(idx);
    return html + PRINT_LISTENER_SCRIPT;
  }

  // ─── Phone reading layout (2026-09-25, phone audit homeowner#2) ──
  // A generated contract showed here at print size on a phone — 9px clause
  // text in a 277px column on a 412px screen (225px at 360) — and this is
  // where it is signed IN PERSON, the homeowner reading it on the rep's
  // phone. doc-phone-
  // layout.js (shared with sign.html and the portal) adds a screen-only
  // sheet to the copy the iframe SHOWS. The signature widget hands the live
  // document back with that sheet inside it, so it is stripped in
  // finalizeSignaturesIfPresent() BEFORE the HTML becomes currentContext.html
  // or reaches onPersistFinalized — i.e. before it is stored, printed, or
  // rendered by html2pdf, which applies the document's own <style> blocks in
  // THIS page, where a leftover max-width rule would match the rep's phone
  // and reflow the PDF. currentContext.html never carries the sheet: it
  // starts as opts.html and is only ever replaced by a stripped reply.
  // Read at call time; absent, the document is shown exactly as served.
  function withPhoneLayout(html) {
    const L = window.NBDDocPhoneLayout;
    return L ? L.withPhoneLayout(html) : html;
  }
  function stripPhoneLayout(html) {
    const L = window.NBDDocPhoneLayout;
    return L ? L.stripPhoneLayout(html) : html;
  }

  // ─── CSS (injected once on first open) ───────────────────
  function ensureStyles() {
    if (document.getElementById('nbd-doc-viewer-styles')) return;
    const style = document.createElement('style');
    style.id = 'nbd-doc-viewer-styles';
    style.textContent = `
      #nbd-doc-viewer-overlay {
        position: fixed; inset: 0; z-index:var(--z-overlay,10000);
        background: rgba(8, 10, 14, 0.92);
        display: none;
        flex-direction: column;
        font-family: 'Barlow', 'Helvetica Neue', sans-serif;
        /* Safe-area insets so the header clears the iPhone notch
           and the footer clears the home indicator. */
        padding-top: env(safe-area-inset-top, 0);
        padding-bottom: env(safe-area-inset-bottom, 0);
        padding-left: env(safe-area-inset-left, 0);
        padding-right: env(safe-area-inset-right, 0);
      }
      #nbd-doc-viewer-overlay.open { display: flex; }
      .nbdv-header {
        background: #111418;
        border-bottom: 2px solid #BD5728;
        padding: 14px 20px;
        display: flex;
        align-items: center;
        gap: 14px;
        flex-shrink: 0;
      }
      .nbdv-title {
        font-family: 'Barlow Condensed', sans-serif;
        font-size: 18px;
        font-weight: 800;
        color: #fff;
        text-transform: uppercase;
        letter-spacing: .04em;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .nbdv-filename {
        font-size: 10px;
        color: #8b8e96;
        font-family: 'Barlow', sans-serif;
        text-transform: none;
        letter-spacing: 0;
        margin-top: 2px;
      }
      .nbdv-close {
        background: var(--orange,#BD5728);
        border: 1px solid #BD5728;
        color: #fff;
        font-weight: 700;
        padding: 10px 18px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
        min-height: 44px;
        min-width: 44px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        font-family: inherit;
        letter-spacing: .04em;
        transition: background .15s, transform .12s;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }
      .nbdv-close:hover { background: #ff8420; border-color: #ff8420; }
      .nbdv-close:active { transform: scale(.95); }
      .nbdv-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        background: #0a0c0f;
        overflow: hidden;
        min-height: 0;
      }
      .nbdv-iframe {
        flex: 1;
        width: 100%;
        border: none;
        background: #fff;
        min-height: 0;
      }
      .nbdv-footer {
        background: #111418;
        border-top: 1px solid #2a2f35;
        padding: 12px 20px;
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        justify-content: center;
        flex-shrink: 0;
      }
      .nbdv-action-btn {
        background: #181c22;
        border: 1px solid #2a2f35;
        color: #e8eaf0;
        padding: 12px 18px;
        border-radius: 6px;
        font-family: 'Barlow Condensed', sans-serif;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: .08em;
        text-transform: uppercase;
        cursor: pointer;
        min-height: 44px;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        transition: all .15s;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }
      .nbdv-action-btn:hover {
        border-color: var(--orange);
        color: var(--orange);
        background: color-mix(in srgb, var(--orange) 6%, transparent);
      }
      .nbdv-action-btn.primary {
        background: var(--orange,#BD5728);
        color: #fff;
        border-color: var(--orange,#BD5728);
      }
      .nbdv-action-btn.primary:hover {
        background: #ff8420;
        border-color: #ff8420;
        color: #fff;
      }
      .nbdv-action-btn:disabled {
        opacity: .4;
        cursor: not-allowed;
      }
      .nbdv-status {
        position: absolute;
        bottom: 70px;
        left: 50%;
        transform: translateX(-50%);
        background: #181c22;
        border: 1px solid #BD5728;
        color: var(--orange,#BD5728);
        padding: 8px 16px;
        border-radius: 20px;
        font-size: 12px;
        font-family: 'Barlow Condensed', sans-serif;
        letter-spacing: .06em;
        text-transform: uppercase;
        z-index: 10;
        display: none;
      }
      .nbdv-status.show { display: block; }
      @media (max-width: 600px) {
        .nbdv-header { padding: 10px 14px; }
        .nbdv-title { font-size: 15px; }
        .nbdv-footer { padding: 10px 12px; gap: 6px; }
        .nbdv-action-btn { padding: 10px 12px; font-size: 11px; flex: 1; min-width: 70px; }
      }
    `;
    document.head.appendChild(style);
  }

  // ─── Build the overlay DOM (DOM builders, never innerHTML) ──
  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'nbd-doc-viewer-overlay';

    const header = document.createElement('div');
    header.className = 'nbdv-header';

    const titleWrap = document.createElement('div');
    titleWrap.style.cssText = 'flex:1;min-width:0;';
    const titleEl = document.createElement('div');
    titleEl.className = 'nbdv-title';
    titleEl.id = 'nbdv-title';
    const filenameEl = document.createElement('div');
    filenameEl.className = 'nbdv-filename';
    filenameEl.id = 'nbdv-filename';
    titleWrap.appendChild(titleEl);
    titleWrap.appendChild(filenameEl);
    header.appendChild(titleWrap);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'nbdv-close';
    closeBtn.id = 'nbdv-close';
    closeBtn.type = 'button';
    closeBtn.textContent = '✕ Close';
    closeBtn.addEventListener('click', handleClose);
    header.appendChild(closeBtn);
    overlay.appendChild(header);

    const body = document.createElement('div');
    body.className = 'nbdv-body';
    const iframe = document.createElement('iframe');
    iframe.className = 'nbdv-iframe';
    iframe.id = 'nbdv-iframe';
    // srcdoc isolates the document in its own browsing context.
    //
    // H-2: 'allow-same-origin' REMOVED. That combo with 'allow-scripts'
    // let iframe code read `parent.window.auth` and steal an ID token
    // from any XSS that slipped past our escapers. The iframe now
    // renders in an opaque origin and can't touch the parent's DOM.
    //
    // Sandbox tokens retained:
    //   allow-popups / allow-popups-to-escape-sandbox → mailto:, _blank
    //   allow-forms   → any report form submit
    //   allow-scripts → ApexCharts, our postMessage print listener
    //   allow-modals  → some browsers require for window.print()
    iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox allow-forms allow-scripts allow-modals');
    body.appendChild(iframe);

    const status = document.createElement('div');
    status.className = 'nbdv-status';
    status.id = 'nbdv-status';
    body.appendChild(status);

    overlay.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'nbdv-footer';

    const addBtn = (label, className, handler) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nbdv-action-btn' + (className ? ' ' + className : '');
      btn.textContent = label;
      btn.addEventListener('click', handler);
      footer.appendChild(btn);
      return btn;
    };

    addBtn('💾 Save to Customer', 'primary', handleSave);
    addBtn('✉ Email', '', handleEmail);
    addBtn('🖨 Print', '', handlePrint);
    addBtn('📄 Download PDF', '', handlePdf);
    // Signatures PR4: remote signing. Hidden by default; open() shows it
    // for signable docs (when the generator passes onSendForSignature).
    const _signBtn = addBtn('✍️ Send for Signature', '', handleSendForSignature);
    _signBtn.id = 'nbdv-sign-btn';
    _signBtn.style.display = 'none';

    overlay.appendChild(footer);
    document.body.appendChild(overlay);
    return overlay;
  }

  // ─── Show a transient status pill (auto-hides in 2.5s) ───
  function flashStatus(msg) {
    const el = document.getElementById('nbdv-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2500);
  }

  // Signatures PR4: email the homeowner a remote-signing link. Delegates
  // to the generator's onSendForSignature closure (which awaits the doc's
  // persist, then calls the createSignRequest callable).
  async function handleSendForSignature() {
    if (!currentContext || typeof currentContext.onSendForSignature !== 'function') return;
    const def = currentContext.signerEmailDefault || '';
    const email = (window.prompt('Email the signing link to which address?', def) || '').trim();
    if (!email) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      if (window.showToast) window.showToast("That doesn't look like a valid email.", 'error');
      return;
    }
    flashStatus('Sending signing link…');
    try {
      const r = await currentContext.onSendForSignature(email);
      if (r && r.emailed) flashStatus('✓ Signing link emailed');
      else if (r && r.signLink) flashStatus('Link created — email is still sending');
      else flashStatus('Could not send — try again');
    } catch (e) {
      if (window.showToast) window.showToast('Send for signature failed: ' + (e && e.message || 'error'), 'error');
      else flashStatus('Send failed');
    }
  }

  // ─── Signature finalize bridge ───────────────────────────
  //
  // The signature widget (signature-widget.js) runs inside the
  // sandboxed iframe. We cannot read its canvases directly (no
  // allow-same-origin), so we postMessage `{ __nbd_sig: 'finalize' }`
  // and the widget replies with the signed HTML. Cheap source-string
  // check on currentContext.html short-circuits when no sigs exist.

  function ensureMessageListener() {
    if (messageListenerInstalled) return;
    messageListenerInstalled = true;
    window.addEventListener('message', function (e) {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.__nbd_sig !== 'finalized') return;
      if (!pendingFinalizeResolver) return;
      const resolve = pendingFinalizeResolver;
      pendingFinalizeResolver = null;
      resolve(e.data);
    });
  }

  async function finalizeSignaturesIfPresent() {
    if (!currentContext) return { ok: true, skipped: true };
    const src = typeof currentContext.html === 'string' ? currentContext.html : '';
    if (!src || src.indexOf('data-nbd-sig=') === -1) {
      return { ok: true, skipped: true };
    }
    const iframe = document.getElementById('nbdv-iframe');
    if (!iframe || !iframe.contentWindow) return { ok: true, skipped: true };

    return new Promise(function (resolve) {
      pendingFinalizeResolver = resolve;
      // Safety timeout — if widget never replies (script load failed,
      // for example) don't hang Save forever. Treat as skipped.
      const t = setTimeout(function () {
        if (pendingFinalizeResolver === resolve) {
          pendingFinalizeResolver = null;
          resolve({ ok: true, skipped: true, timedOut: true });
        }
      }, 3000);
      // Wrap resolver so timer is cleared on real reply
      const realResolver = resolve;
      pendingFinalizeResolver = function (payload) {
        clearTimeout(t);
        realResolver(payload);
      };
      try {
        iframe.contentWindow.postMessage({ __nbd_sig: 'finalize' }, '*');
      } catch (err) {
        clearTimeout(t);
        pendingFinalizeResolver = null;
        resolve({ ok: true, skipped: true, error: err });
      }
    }).then(function (reply) {
      if (reply && reply.ok && typeof reply.html === 'string') {
        // The record, not the screen: take the phone sheet back out before
        // anything below (or any caller of this function) sees the HTML.
        reply.html = stripPhoneLayout(reply.html);
        currentContext.html = reply.html;
        currentContext.signedSigners = Array.isArray(reply.signers) ? reply.signers : [];
        if (typeof currentContext.onPersistFinalized === 'function') {
          try {
            const r = currentContext.onPersistFinalized(reply.html, reply.signers || []);
            if (r && typeof r.then === 'function') {
              r.catch(function (e) { console.warn('[NBDDocViewer] onPersistFinalized rejected:', e); });
            }
          } catch (e) {
            console.warn('[NBDDocViewer] onPersistFinalized threw:', e);
          }
        }
      }
      return reply;
    });
  }

  // ─── Action handlers ─────────────────────────────────────

  async function handleSave() {
    if (!currentContext) return;
    flashStatus('Saving...');
    // Finalize signatures first if any are present and required ones
    // are still unsigned. The widget reply tells us what's missing.
    const fin = await finalizeSignaturesIfPresent();
    if (fin && fin.ok === false) {
      const missing = (fin.missing || []).join(', ');
      flashStatus('Sign required: ' + missing);
      if (typeof window.showToast === 'function') {
        window.showToast('Required signatures missing: ' + missing, 'error');
      }
      return;
    }
    try {
      if (typeof currentContext.onSave === 'function') {
        // Custom save callback (e.g. V2 Builder wires this to Firestore)
        const result = await currentContext.onSave(currentContext);
        if (result === false) {
          flashStatus('Save cancelled');
          return;
        }
      } else if (typeof window.showToast === 'function') {
        window.showToast('No save handler wired for this document', 'error');
        return;
      }
      dirty = false;
      flashStatus('✓ Saved');
      if (typeof window.showToast === 'function') {
        window.showToast('✓ Document saved', 'success');
      }
    } catch (e) {
      console.error('[NBDDocViewer] save failed:', e);
      flashStatus('Save failed');
      if (typeof window.showToast === 'function') {
        window.showToast('Save failed: ' + (e.message || 'unknown'), 'error');
      }
    }
  }

  function handleEmail() {
    if (!currentContext) return;
    const subject = encodeURIComponent(currentContext.title || 'NBD Document');
    const body = encodeURIComponent(
      'See attached ' + (currentContext.title || 'document') + '.\n\n'
      + 'Generated by NBD Pro.\n'
    );
    window.location.href = 'mailto:?subject=' + subject + '&body=' + body;
  }

  async function handlePrint() {
    const iframe = document.getElementById('nbdv-iframe');
    if (!iframe) return;
    // Finalize signatures first — unsigned canvases would otherwise
    // print as empty boxes, and the print dialog can't roll back.
    const fin = await finalizeSignaturesIfPresent();
    if (fin && fin.ok === false) {
      const missing = (fin.missing || []).join(', ');
      flashStatus('Sign required: ' + missing);
      if (typeof window.showToast === 'function') {
        window.showToast('Required signatures missing: ' + missing, 'error');
      }
      return;
    }
    // H-2: sandbox no longer grants same-origin, so we can't reach
    // iframe.contentWindow.print() directly. Instead post a message
    // to the listener we injected into the iframe HTML, which calls
    // window.print() from inside the sandbox.
    try {
      iframe.contentWindow.postMessage({ __nbdv: 'print' }, '*');
    } catch (e) {
      console.warn('[NBDDocViewer] postMessage print failed:', e);
    }
    // Fallback path: if no currentContext.html (shouldn't happen) we
    // open in a new window so the user still gets a print path.
    if (currentContext && typeof currentContext.html === 'string') {
      // The primary postMessage above usually wins. This is a safety
      // net — after 800ms, if the print dialog hasn't appeared, try
      // the new-window fallback.
      setTimeout(() => {
        try {
          const win = window.open('', '_blank');
          if (win && !win.closed) {
            win.document.open();
            win.document.write(currentContext.html);
            win.document.close();
            setTimeout(() => { try { win.print(); } catch (e) {} }, 400);
          }
        } catch (e) { /* blocked popup; user can use PDF instead */ }
      }, 800);
    }
  }

  async function handlePdf() {
    if (!currentContext) return;
    // Prefer the server-rendered PDF (higher fidelity than the client
    // html2pdf render) when one was supplied — open it in a NEW TAB. Only the
    // cross-origin iframe EMBED is blocked; a top-level navigation to the
    // Storage URL is fine and lets the browser's native viewer save/print it.
    // Skipped when the doc carries unsigned signature placeholders, since the
    // server PDF predates in-preview signing — those go through the client
    // render below so the drawn signatures are captured in the download.
    const _hasUnsignedSigs = typeof currentContext.html === 'string'
      && currentContext.html.indexOf('data-nbd-sig=') !== -1;
    if (currentContext.pdfUrl && !_hasUnsignedSigs) {
      try {
        window.open(currentContext.pdfUrl, '_blank', 'noopener');
        flashStatus('✓ Opening PDF…');
        return;
      } catch (e) { /* fall through to the client html2pdf render */ }
    }
    // PR 2b2: html2pdf is lazy (ScriptLoader 'pdfexport' bundle, ~1.1 MB).
    // Load it on the first PDF export, then continue. handlePdf is async.
    if (typeof window.html2pdf !== 'function') {
      flashStatus('Loading PDF engine…');
      if (window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
        await window.ScriptLoader.loadBundle('pdfexport');
      }
      if (typeof window.html2pdf !== 'function') {
        flashStatus('PDF engine unavailable');
        if (typeof window.showToast === 'function') {
          window.showToast('PDF engine failed to load — check your connection and try again.', 'error');
        }
        return;
      }
    }
    // Finalize signatures first so the PDF embeds the signed PNGs.
    // handlePdf reads from currentContext.html, which finalize updates.
    const fin = await finalizeSignaturesIfPresent();
    if (fin && fin.ok === false) {
      const missing = (fin.missing || []).join(', ');
      flashStatus('Sign required: ' + missing);
      if (typeof window.showToast === 'function') {
        window.showToast('Required signatures missing: ' + missing, 'error');
      }
      return;
    }
    flashStatus('Generating PDF...');
    // H-2: no more cross-origin iframe.contentDocument read. Build an
    // off-screen clone from currentContext.html in the parent. Same
    // visual result; no need for allow-same-origin on the iframe.
    const html = currentContext && typeof currentContext.html === 'string'
      ? currentContext.html : '';
    if (!html) {
      flashStatus('PDF failed: empty document');
      return;
    }
    // Parse the full HTML string into a DocumentFragment so we can
    // pull just the <body> content. We DO NOT inject user-generated
    // HTML into the live DOM — html2pdf operates on a detached node.
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const body = parsed.body;
    if (!body) {
      flashStatus('PDF failed: empty document');
      return;
    }
    // ── Preserve <head> <style> + <link rel="stylesheet"> ──────────
    // html2pdf operates on the body subtree only. Without this, every
    // generator that puts its CSS in <head> renders as an unstyled
    // text dump in Download-PDF (photo-report, contracts, estimates,
    // any future doc). Prepend the head's <style>/<link> nodes inside
    // body so the cloned subtree carries its own styles.
    const headStyleNodes = parsed.head
      ? parsed.head.querySelectorAll('style, link[rel="stylesheet"]')
      : [];
    if (headStyleNodes.length) {
      for (let i = headStyleNodes.length - 1; i >= 0; i--) {
        body.insertBefore(headStyleNodes[i].cloneNode(true), body.firstChild);
      }
    }
    // Defense in depth: strip any <script> / <iframe> / event-handler
    // attrs before handing the tree to html2pdf. parseFromString marks
    // script nodes inert, but html2pdf reparents the tree into the
    // live DOM during rendering — that *could* re-activate them on
    // some engines. This scrub makes that moot.
    body.querySelectorAll('script, iframe, object, embed').forEach(n => n.remove());
    body.querySelectorAll('*').forEach(el => {
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        if (attr.name.toLowerCase() === 'srcdoc') el.removeAttribute(attr.name);
      }
    });
    const filename = currentContext.filename || 'Document.pdf';
    const opt = {
      margin: [10, 10, 10, 10],
      filename: filename,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#fff' },
      jsPDF: { unit: 'mm', format: 'letter', orientation: 'portrait' }
    };
    try {
      // Clone the body so we don't mutate what the user is viewing.
      // Wait briefly for images to load inside the clone — photo
      // reports have external Firebase Storage URLs that need time.
      const clone = body.cloneNode(true);
      // Give images 2 seconds to load before generating PDF
      await new Promise(r => setTimeout(r, 2000));
      await window.html2pdf().set(opt).from(clone).save();
      flashStatus('✓ PDF downloaded');
      if (typeof window.showToast === 'function') {
        window.showToast('✓ PDF saved to downloads', 'success');
      }
    } catch (e) {
      console.error('[NBDDocViewer] PDF generation failed:', e);
      flashStatus('PDF failed');
      if (typeof window.showToast === 'function') {
        window.showToast('PDF failed: ' + (e.message || 'unknown'), 'error');
      }
    }
  }

  // Re-entrancy latch for handleClose. Native confirm() froze the event loop,
  // so a second Escape could not arrive while the guard was up. nbdConfirm
  // does not freeze anything, and escHandler stays attached until close()
  // runs — which is now AFTER the await. Without this latch, every Escape
  // press while the guard is open spawns a replacement guard behind the one
  // it cancels, so Escape can never actually close a dirty document in the
  // installed PWA and always leaves a modal on screen.
  let closing = false;

  async function handleClose() {
    if (closing) return;
    closing = true;
    try {
      if (dirty) {
        // In the installed PWA, standalone-compat.js replaces window.confirm
        // with a stub that always returns true — so this "lose your unsaved
        // document" guard silently answered OK and threw the work away.
        // nbdConfirm gives a real Promise<boolean> from a modal in standalone
        // mode; it doesn't exist on desktop, hence the native fallback.
        // eslint-disable-next-line no-alert
        const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
        const ok = await _ask('Close without saving?\n\n'
          + 'Click OK to close this document and lose any unsaved state. '
          + 'Click Cancel to keep reviewing, then press Save to Customer.');
        if (!ok) return;
      }
      close();
    } finally {
      closing = false;
    }
  }

  function close() {
    if (!currentOverlay) return;
    currentOverlay.classList.remove('open');
    // Clear iframe so the next open starts clean
    const iframe = document.getElementById('nbdv-iframe');
    if (iframe) iframe.removeAttribute('srcdoc');
    if (escHandler) {
      document.removeEventListener('keydown', escHandler);
      escHandler = null;
    }
    currentContext = null;
  }

  // ─── Public open() ───────────────────────────────────────
  // Accepts either:
  //   { html: '...' }  — legacy html2canvas/jsPDF generators (rendered in-iframe)
  //   { url: '...' }   — D-1+ server-side Puppeteer renders (signed PDF URL,
  //                      browser's native PDF viewer takes over inside the iframe)
  function open(opts) {
    opts = opts || {};
    const hasHtml = typeof opts.html === 'string' && opts.html.length > 0;
    const hasUrl  = typeof opts.url  === 'string' && opts.url.length > 0;
    if (!hasHtml && !hasUrl) {
      console.error('[NBDDocViewer] open() requires either html or url', opts);
      if (typeof window.showToast === 'function') {
        window.showToast('Could not open preview — document was empty.', 'error');
      }
      return;
    }
    ensureStyles();
    if (!currentOverlay) currentOverlay = buildOverlay();
    // Keep the viewer last in <body> (before its iframe is filled — moving an
    // iframe reloads it): it shares z-index var(--z-overlay) with the V2
    // builder modal, and once the builder sat after it in the DOM the viewer
    // opened BEHIND it — the "Rendering…" toast fired and nothing appeared.
    if (currentOverlay.parentNode === document.body && document.body.lastElementChild !== currentOverlay) {
      document.body.appendChild(currentOverlay);
    }

    currentContext = {
      html: opts.html || null,
      url:  opts.url  || null,
      // Server-rendered PDF (Firebase Storage). Used for the high-fidelity
      // Download action — NOT as the preview iframe.src: a cross-origin PDF
      // embed gets blocked by Chrome/Brave and can freeze the renderer.
      pdfUrl: opts.url || null,
      title: opts.title || 'Document',
      filename: opts.filename || 'Document.pdf',
      leadId: opts.leadId || null,
      onSave: opts.onSave || null,
      onPersistFinalized: opts.onPersistFinalized || null,
      meta: opts.meta || {},
      savedSigs: opts.savedSigs || null,
      // Signatures PR4: present only for signable docs — the generator
      // passes a closure that mints a doc_sign_tokens link + emails it.
      onSendForSignature: opts.onSendForSignature || null,
      signerEmailDefault: opts.signerEmailDefault || '',
      signedSigners: null
    };
    // Toggle the remote-signature button per doc (signable docs only).
    const _signBtnEl = document.getElementById('nbdv-sign-btn');
    if (_signBtnEl) _signBtnEl.style.display = (typeof currentContext.onSendForSignature === 'function') ? '' : 'none';
    // Only guard against losing work when the doc actually has a save or
    // signature path. A read-only server-PDF preview has nothing to lose, so it
    // should close without a spurious "Close without saving?" prompt.
    dirty = (typeof currentContext.onSave === 'function'
      || typeof currentContext.onSendForSignature === 'function'
      || typeof currentContext.onPersistFinalized === 'function'
      || (typeof currentContext.html === 'string' && currentContext.html.indexOf('data-nbd-sig=') !== -1));
    ensureMessageListener();

    // Escape title + filename before display
    const titleEl = document.getElementById('nbdv-title');
    const filenameEl = document.getElementById('nbdv-filename');
    if (titleEl) titleEl.textContent = currentContext.title;
    if (filenameEl) filenameEl.textContent = currentContext.filename;

    const iframe = document.getElementById('nbdv-iframe');
    if (iframe) {
      if (hasHtml) {
        // ALWAYS render the same-origin srcdoc HTML for the PREVIEW. When a
        // server-rendered PDF `url` is also supplied it is kept as pdfUrl for
        // the Download action only — setting a cross-origin Firebase-Storage
        // PDF as iframe.src is BLOCKED by Chrome/Brave ("This page has been
        // blocked by Chrome") and froze the renderer. srcdoc renders in an
        // opaque same-origin context, so it is never blocked.
        iframe.removeAttribute('src');
        iframe.srcdoc = wrapWithPrintListener(withPhoneLayout(opts.html));
        // PR3b: once the sandboxed doc + signature widget have loaded,
        // hand this lead's previously-saved signatures across the
        // boundary so the widget can offer "Use saved". Skipped when
        // there are none, so non-signature docs pay zero cost.
        const _savedSigs = currentContext.savedSigs;
        if (_savedSigs && typeof _savedSigs === 'object' && Object.keys(_savedSigs).length) {
          iframe.addEventListener('load', () => {
            try {
              iframe.contentWindow.postMessage({ __nbd_sig: 'savedSigs', sigs: _savedSigs }, '*');
            } catch (_) { /* cross-origin / not ready — non-fatal */ }
          }, { once: true });
        }
      } else if (opts.url) {
        // url-only caller (server-rendered PDF, no same-origin HTML — e.g.
        // inspection report, photo report, warranty cert). A cross-origin PDF
        // set as iframe.src is BLOCKED by Chrome/Brave and FROZE the renderer
        // (#594). So render an honest same-origin placeholder and let the user
        // open the PDF as a top-level navigation (never blocked) — via the
        // button here or the toolbar Download (both go through pdfUrl).
        iframe.removeAttribute('src');
        const _u = esc(opts.url);
        iframe.srcdoc = `<!doctype html><meta charset="utf-8"><body style="margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f4f5f7;color:#1f2937;text-align:center;">
          <div style="max-width:440px;padding:32px;">
            <div style="font-size:48px;margin-bottom:12px;">📄</div>
            <h2 style="margin:0 0 8px;font-size:18px;">Your PDF is ready</h2>
            <p style="margin:0 0 20px;font-size:14px;line-height:1.55;color:#4b5563;">This document was generated as a high-fidelity PDF. Inline preview isn't available for server PDFs — open it in a new tab to view, print, or save.</p>
            <a href="${_u}" target="_blank" rel="noopener" style="display:inline-block;background:#1A3057;color:#fff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;font-size:14px;">Open PDF in new tab &#8599;</a>
            <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;">You can also use Download in the toolbar above.</p>
          </div>
        </body>`;
      } else {
        // Nothing to show (neither html nor url).
        iframe.removeAttribute('srcdoc');
        iframe.removeAttribute('src');
      }
    }

    currentOverlay.classList.add('open');

    // Esc closes (with same warn-then-allow flow)
    escHandler = (e) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', escHandler);
  }

  // ─── Public API ──────────────────────────────────────────
  window.NBDDocViewer = {
    __sentinel: 'nbd-doc-viewer-v1',
    open: open,
    close: close,
    // Expose the flash helper so generators can push their own status
    flashStatus: flashStatus
  };

  console.log('[NBDDocViewer] Ready. Trigger via NBDDocViewer.open({ html, title, filename, onSave })');
})();
