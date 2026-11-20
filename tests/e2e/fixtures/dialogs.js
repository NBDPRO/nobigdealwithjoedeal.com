// @ts-check
// Answers NBD Pro's in-tab dialogs (nbd-dialog.js / standalone-compat.js) the way
// specs used to answer native confirm()/prompt()/alert() with page.on('dialog').
// Native dialogs are gone from docs/pro: they sit outside the DOM and freeze agent
// tools, so a spec that only listens for the 'dialog' event now hangs.
//
//   const dlg = await autoDialogs(page);                 // accept everything, like page.on('dialog', d => d.accept())
//   dlg.log                                              // ['confirm: Delete this?', 'prompt: Rename:' ...]
//   dlg.promptValue = '12.5';                            // typed into the next/any prompt (default: keep the prefilled value)
//   dlg.dismissNext = true;                              // Cancel the next one
//   dlg.rule = (d) => /close without saving/i.test(d.text);   // true = OK, false = Cancel (overrides accept)
//
// The observer lives in the page (an init script, so it survives navigation) and asks
// Node what to do through an exposed binding; Node clicks nothing itself.

/**
 * @param {import('@playwright/test').Page} page
 * @param {{accept?: boolean}} [opts]
 */
async function autoDialogs(page, opts = {}) {
  const ctl = {
    /** @type {string[]} */ log: [],
    accept: opts.accept !== false,
    /** @type {string|number|null} */ promptValue: null,
    dismissNext: false,
    /** @type {null | ((d: {kind: string, text: string}) => boolean | undefined)} */ rule: null,
  };
  await page.exposeBinding('__nbdDlgAnswer', (_src, d) => {
    ctl.log.push(d.kind + ': ' + d.text);
    let yes = ctl.accept;
    if (ctl.rule) { const r = ctl.rule(d); if (typeof r === 'boolean') yes = r; }
    if (ctl.dismissNext) { yes = false; ctl.dismissNext = false; }
    return { yes, value: d.kind === 'prompt' && yes && ctl.promptValue != null ? String(ctl.promptValue) : null };
  });
  await page.addInitScript(() => {
    const seen = new WeakSet();
    const handle = async (ov) => {
      if (seen.has(ov)) return;
      seen.add(ov);
      const q = (s) => ov.querySelector(s);
      const input = q('#nbd-dialog-input');
      const cancel = q('#nbd-dialog-cancel');
      const msgEl = q('[id^="nbd-dialog-msg"], .sa-msg');
      const kind = input ? 'prompt' : cancel ? 'confirm' : 'alert';
      // @ts-ignore exposed by the fixture
      const ans = await window.__nbdDlgAnswer({ kind, text: msgEl ? msgEl.innerText : ov.innerText });
      if (input && ans.value != null) input.value = ans.value;
      const btn = ans.yes || !cancel ? q('#nbd-dialog-confirm') : cancel;
      if (btn) btn.click();
    };
    const scan = () => { const ov = document.getElementById('nbd-dialog'); if (ov) handle(ov); };
    const start = () => { new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true }); scan(); };
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  });
  return ctl;
}

module.exports = { autoDialogs };
