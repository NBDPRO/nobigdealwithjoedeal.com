/**
 * tests/e2e/fixtures/in-tab-dialogs.js — answer the CRM's in-tab dialogs.
 *
 * Since #3221 (2026-11-19) window.nbdConfirm / nbdPrompt are real DOM dialogs in
 * every browser (docs/pro/js/standalone-compat.js and nbd-dialog.js share the hooks
 * #nbd-dialog, #nbd-dialog-confirm, #nbd-dialog-cancel, #nbd-dialog-input), and
 * alert() is one too. A spec that used to answer a NATIVE dialog with
 * page.on('dialog') no longer gets one: the page awaits a modal nobody clicks and
 * the next page.evaluate hangs until the 30 s test timeout ("Target page, context
 * or browser has been closed"). @shard2 / @shard3 do not run in the merge queue, so
 * #3221 only fixed the specs on the required shards.
 *
 * Usage: `await answerInTabDialogs(page, (d) => ({ accept: true, value: '50' }))`
 *   d = { kind: 'confirm' | 'prompt' | 'alert', message }. The answer is
 *   { accept: boolean, value?: string }; no answer means accept. Install it before
 *   the page navigates (it re-installs on every document via an init script) or
 *   right after, it also covers the document already open.
 */
'use strict';

async function answerInTabDialogs(page, decide) {
  if (page.__inTabDialogsInstalled) { page.__inTabDialogDecide = decide; return; }
  page.__inTabDialogsInstalled = true;
  page.__inTabDialogDecide = decide;
  await page.exposeFunction('__nbdE2eDialog', async (info) => {
    try {
      const r = page.__inTabDialogDecide ? await page.__inTabDialogDecide(info) : null;
      return r && typeof r === 'object' ? r : { accept: true };
    } catch (e) { return { accept: true }; }
  });
  const install = () => {
    const seen = new WeakSet();
    const handle = async (ov) => {
      if (seen.has(ov)) return;
      seen.add(ov);
      const input = ov.querySelector('#nbd-dialog-input');
      const cancel = ov.querySelector('#nbd-dialog-cancel');
      const ok = ov.querySelector('#nbd-dialog-confirm');
      const kind = input ? 'prompt' : cancel ? 'confirm' : 'alert';
      const message = String(ov.textContent || '').replace(/\s+/g, ' ').trim();
      const r = await window.__nbdE2eDialog({ kind, message });
      if (r.accept === false && cancel) { cancel.click(); return; }
      if (input && r.value != null) input.value = String(r.value);
      if (ok) ok.click();
    };
    const scan = (root) => {
      if (!root || !root.querySelectorAll) return;
      if (root.id === 'nbd-dialog') handle(root);
      root.querySelectorAll('#nbd-dialog').forEach(handle);
    };
    new MutationObserver((muts) => {
      for (const m of muts) m.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); });
    }).observe(document, { childList: true, subtree: true });
    scan(document);
  };
  await page.addInitScript(install);
  // the document that is already open (init scripts only run on the next navigation)
  await page.evaluate(install).catch(() => {});
}

module.exports = { answerInTabDialogs };
