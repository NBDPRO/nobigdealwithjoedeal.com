/**
 * NBD Pro — Clipboard & Share Portal Fix v1.0
 *
 * Fixes:
 * 1. Share Portal says "copied" but never copies (uses prompt() instead of clipboard)
 * 2. navigator.clipboard.writeText fails silently on mobile Safari
 *
 * Drop-in: load after customer-portal.js
 */

(function() {
  'use strict';

  // ── Robust clipboard copy (works on mobile Safari) ──────
  async function copyToClipboard(text) {
    // Method 1: Modern Clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch(e) {
        // Falls through to fallback
      }
    }

    // Method 2: Fallback for mobile Safari and insecure contexts
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(textarea);

      // iOS Safari needs special handling
      const range = document.createRange();
      const sel = window.getSelection();
      sel.removeAllRanges();

      textarea.contentEditable = 'true';
      textarea.readOnly = false;
      range.selectNodeContents(textarea);
      sel.addRange(range);
      textarea.setSelectionRange(0, text.length);

      const success = document.execCommand('copy');
      document.body.removeChild(textarea);
      return success;
    } catch(e) {
      console.warn('[ClipboardFix] All copy methods failed:', e);
      return false;
    }
  }

  // Expose globally for other scripts


  // ── Patch Share Portal button ───────────────────────────
  function patchSharePortal() {
    // Find Share Portal buttons (they reference CustomerPortal.generate)
    const buttons = document.querySelectorAll('button[onclick*="CustomerPortal"]');

    buttons.forEach(btn => {
      if (btn.textContent.includes('Share Portal')) {
        // Replace the onclick entirely
        btn.removeAttribute('onclick');
        btn.addEventListener('click', async function(e) {
          e.preventDefault();

          if (typeof CustomerPortal === 'undefined' || !CustomerPortal.generate) {
            if (typeof showToast === 'function') {
              showToast('Customer Portal not available', 'error');
            }
            return;
          }

          // Show loading state
          const origText = btn.innerHTML;
          btn.innerHTML = '🔗 Generating…';
          btn.disabled = true;

          try {
            const url = await CustomerPortal.generate(window._customerId);

            if (url) {
              const copied = await copyToClipboard(url);

              if (copied) {
                if (typeof showToast === 'function') {
                  showToast('✅ Portal link copied to clipboard!', 'success');
                }
                btn.innerHTML = '🔗 Link Copied!';
                setTimeout(() => { btn.innerHTML = origText; }, 2000);
              } else {
                // Fallback: show the URL for manual copy
                if (typeof showToast === 'function') {
                  showToast('Link generated — tap and hold to copy', 'info');
                }
                window.nbdPrompt('Portal link:', url);
              }
            } else {
              if (typeof showToast === 'function') {
                showToast('Failed to generate portal link', 'error');
              }
            }
          } catch(err) {
            console.error('[SharePortal]', err);
            if (typeof showToast === 'function') {
              showToast('Error generating portal: ' + err.message, 'error');
            }
          }

          btn.disabled = false;
          setTimeout(() => { btn.innerHTML = origText; }, 3000);
        });
      }
    });
  }

  // ── Init ────────────────────────────────────────────────
  function init() {
    patchSharePortal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Small delay to ensure buttons are rendered
    setTimeout(init, 500);
  }

})();
