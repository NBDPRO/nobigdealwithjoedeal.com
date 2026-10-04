/**
 * calendar-feed-ui.js — "Subscribe on your phone" panel in the Schedule view.
 *
 * Mints the rep's read-only .ics feed link (functions/calendar-feed.js) and
 * hands them a one-tap webcal:// subscribe. One active link per rep: pressing
 * the button again ROTATES, which is the only way to kill a leaked URL.
 *
 * Deliberately binds its own listeners by element id rather than registering
 * data-fn names in the dashboard's call dispatcher. The dispatcher needs a name
 * in either __NBD_CALL_REGISTRY or the dashboard-state allowlist, and a name
 * that lands in neither is a silently dead button — a class of bug this repo
 * has shipped before. Own listeners have no registry to drift from.
 *
 * The callable SDK is mandatory here: createCalendarFeedToken enforces App
 * Check, which a raw fetch cannot satisfy.
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['calendar-feed-ui']) return;
  __NBD_LOADED['calendar-feed-ui'] = true;

  const $ = (id) => document.getElementById(id);

  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
    else console.log('[CalendarFeed]', msg);
  }

  function setBusy(busy) {
    const btn = $('calFeedCreate');
    if (!btn) return;
    btn.disabled = !!busy;
    btn.textContent = busy ? 'Working…' : (currentUrl ? 'Rotate link' : 'Create my link');
  }

  // Held in memory only. The token is never written to localStorage: it is a
  // bearer credential for the rep's whole book, and a device that keeps it is
  // one more place it can leak from. Reloading the page means minting again,
  // which rotates — that is the intended cost.
  let currentUrl = '';

  function render(url) {
    currentUrl = url || '';
    const input = $('calFeedUrl');
    if (input) {
      input.value = currentUrl;
      input.placeholder = currentUrl ? '' : 'Tap "Create my link" to generate your feed';
    }
    const sub = $('calFeedSubscribe');
    if (sub) {
      if (currentUrl) {
        sub.href = currentUrl.replace(/^https:/, 'webcal:');
        sub.removeAttribute('aria-disabled');
        sub.style.opacity = '';
        sub.style.pointerEvents = '';
      } else {
        sub.removeAttribute('href');
        sub.setAttribute('aria-disabled', 'true');
        sub.style.opacity = '.5';
        sub.style.pointerEvents = 'none';
      }
    }
    const copy = $('calFeedCopy');
    if (copy) copy.disabled = !currentUrl;
    const btn = $('calFeedCreate');
    if (btn) btn.textContent = currentUrl ? 'Rotate link' : 'Create my link';
  }

  async function callable(name, payload) {
    if (!window._functions || !window._httpsCallable) {
      const mod = await import('/assets/vendor/firebase/12.19.0/firebase-functions.js');
      window._httpsCallable = mod.httpsCallable;
    }
    if (!window._functions || !window._httpsCallable) throw new Error('Functions SDK unavailable');
    const fn = window._httpsCallable(window._functions, name);
    const res = await fn(payload || {});
    return res && res.data;
  }

  async function createLink() {
    const rotating = !!currentUrl;
    // NOT raw confirm(): standalone-compat.js replaces window.confirm with a
    // function that returns true in the installed PWA, so a raw prompt here
    // would silently rotate the link — killing a subscription the rep never
    // agreed to kill. nbdConfirm is the real modal; the native call is the
    // desktop fallback. (tests/pwa-confirm-guard.test.js enforces this.)
    const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
    if (rotating && !(await ask('Rotate your calendar link?\n\nThe old link stops working immediately, and any phone already subscribed to it will stop updating until you subscribe again.'))) {
      return;
    }
    setBusy(true);
    try {
      const data = await callable('createCalendarFeedToken', {});
      if (!data || !data.feedUrl) throw new Error('No link returned');
      render(data.feedUrl);
      toast(rotating ? 'New link created — the old one is dead. Subscribe again on your phone.'
                     : 'Link created — tap "Subscribe on iPhone".', 'success');
    } catch (e) {
      console.warn('[CalendarFeed] mint failed', e);
      toast('Could not create your calendar link: ' + ((e && e.message) || 'unknown error'), 'error');
      render(currentUrl);
    } finally {
      setBusy(false);
    }
  }

  function copyLink() {
    if (!currentUrl) return;
    const done = () => toast('Calendar link copied', 'success');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(currentUrl).then(done, () => fallbackCopy(currentUrl, done));
        return;
      }
    } catch (e) { /* fall through */ }
    fallbackCopy(currentUrl, done);
  }

  function fallbackCopy(text, done) {
    try {
      const input = $('calFeedUrl');
      if (input && typeof input.select === 'function') {
        input.select();
        if (typeof input.setSelectionRange === 'function') input.setSelectionRange(0, text.length);
        document.execCommand('copy');
        done();
        return;
      }
    } catch (e) { /* ignore */ }
    toast('Could not copy — select the link and copy it manually', 'error');
  }

  function wire() {
    const btn = $('calFeedCreate');
    if (!btn || btn.dataset.nbdWired === '1') return;
    btn.dataset.nbdWired = '1';
    btn.addEventListener('click', createLink);
    const copy = $('calFeedCopy');
    if (copy) copy.addEventListener('click', copyLink);
    render('');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
  // The Schedule view is rendered on the same page; re-wire after navigation in
  // case the panel mounts late.
  window.addEventListener('hashchange', wire);
})();
