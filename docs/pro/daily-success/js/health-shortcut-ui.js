/**
 * health-shortcut-ui.js — the ⌚ Apple Health weight card (research idea #9,
 * 2026-10-20). Server side: functions/health-shortcut.js (healthShortcutManage).
 *
 * DARK: the card renders nothing until the server says available:true, and it
 * says that only when Jo has set system/healthShortcut {enabled:true} in the
 * Firebase console. Off by default after that too: nothing is sent until Jo
 * taps "Create Shortcut key".
 *
 * The key is shown ONCE, in the create response, and lives only in this
 * script's memory (never localStorage, never a DOM attribute but the read-only
 * box that shows it); a re-render or "Done" drops it. Rotate and Turn off are
 * two taps (arm, then confirm) because confirm() is unreliable in the
 * installed app.
 *
 * Classic script, loaded after progress-charts-ui.js. Delegated listeners
 * only; every value into innerHTML goes through esc().
 */
(function () {
  'use strict';
  if (window.NBDHealthShortcutUI) return;

  const FUNCTIONS_SDK = '/assets/vendor/firebase/10.12.2/firebase-functions.js';
  const APP_SDK = '/assets/vendor/firebase/10.12.2/firebase-app.js';
  const AUTH_SDK = '/assets/vendor/firebase/10.12.2/firebase-auth.js';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // st: null until the server answers; { available, enabled, lastAt, lastDate, lastWeightLbs, lastResult, endpoint }
  let st = null;
  let revealed = null;      // the just-minted key, memory only
  let armed = null;         // 'rotate' | 'off' | null: the first tap of a two-tap action
  let showSteps = false;
  let busy = false;
  let err = '';
  let copied = '';

  const RESULT_TEXT = {
    written: 'Saved to that day',
    unchanged: 'Already had this weight',
    hand_entered: 'Kept the weight you typed that day',
    deleted: 'Skipped: you deleted that day',
  };

  function when(ms) {
    if (!ms || !isFinite(ms)) return '';
    try { return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; }
  }

  function stepsHtml(endpoint) {
    const url = esc(endpoint || '');
    return '<ol class="hs-steps">' +
      '<li><b>Make Health use pounds.</b> Health app → Browse → Body Measurements → Weight → Unit → <b>lb</b>. If it says kg the number will be wrong.</li>' +
      '<li>Open the <b>Shortcuts</b> app → tap <b>+</b> (top right). Name it <b>Send weight to NBD</b>.</li>' +
      '<li>Tap <b>Add Action</b> → search <b>Find Health Samples</b>. Tap <b>Add Filter</b> → <b>Type</b> → <b>Weight</b>. Add another filter: <b>Start Date</b> → <b>is in the last</b> <b>1 day</b>. Turn on <b>Sort by Start Date, Latest First</b> and <b>Limit</b> = <b>1</b>.</li>' +
      '<li>Add action <b>Get Details of Health Samples</b> → set it to <b>Value</b>.</li>' +
      '<li>Add action <b>Current Date</b>, then <b>Format Date</b> → Format <b>Custom</b> → type <b>yyyy-MM-dd</b>.</li>' +
      '<li>Add action <b>Get Contents of URL</b>. URL: <span class="hs-url">' + url + '</span> Tap the arrow to show more: Method <b>POST</b>. Headers: add <b>Authorization</b> = <b>Bearer </b> (with a space) followed by your key. Request Body <b>JSON</b>: add a <b>Text</b> field named <b>date</b> = the formatted date; add a <b>Number</b> field named <b>weightLbs</b> = the Value from step 4.</li>' +
      '<li>Tap <b>Play</b> once to test. Come back here: this card should show your weight and today\'s date.</li>' +
      '<li>Automatic every day: Shortcuts → <b>Automation</b> tab → <b>+</b> → <b>Time of Day</b> (say 9:00 AM, after you weigh in) → <b>Daily</b> → <b>Run Immediately</b> → choose <b>Send weight to NBD</b>.</li>' +
      '</ol>' +
      '<div class="wc-meta">A weight you type by hand on a day is never overwritten by the Shortcut. Sleep is not stored yet.</div>';
  }

  function cardHtml() {
    if (!st || !st.available) return '';
    let body;
    if (revealed) {
      body = '<div class="hs-warn">Your key. This is the only time it is shown. Copy it now and paste it into the Shortcut.</div>' +
        '<div class="hs-keyrow"><input class="hs-key" id="hsKey" type="text" readonly value="' + esc(revealed) + '" aria-label="Shortcut key">' +
        '<button type="button" class="pg-chip" data-hs-action="copy" data-what="key">' + (copied === 'key' ? 'Copied' : 'Copy') + '</button></div>' +
        stepsHtml(st.endpoint) +
        '<div class="hs-btns"><button type="button" class="pg-chip on" data-hs-action="done">I pasted it, done</button></div>';
    } else if (st.enabled) {
      const last = st.lastDate && st.lastWeightLbs != null
        ? 'Last reading: <b>' + esc(st.lastWeightLbs) + ' lb</b> for ' + esc(st.lastDate) + (st.lastAt ? ' (received ' + esc(when(st.lastAt)) + ')' : '') +
          (st.lastResult && RESULT_TEXT[st.lastResult] ? '. ' + esc(RESULT_TEXT[st.lastResult]) + '.' : '')
        : 'Nothing received yet. Run the Shortcut once to test it.';
      body = '<div class="wt-big hs-on">On</div><div class="wc-meta">' + last + '</div>' +
        '<div class="hs-btns">' +
        '<button type="button" class="pg-chip" data-hs-action="steps">' + (showSteps ? 'Hide steps' : 'Setup steps') + '</button>' +
        '<button type="button" class="pg-chip' + (armed === 'rotate' ? ' on' : '') + '" data-hs-action="rotate">' + (armed === 'rotate' ? 'Tap again: old key stops working' : 'Rotate key') + '</button>' +
        '<button type="button" class="pg-chip' + (armed === 'off' ? ' on' : '') + '" data-hs-action="off">' + (armed === 'off' ? 'Tap again to turn off' : 'Turn off') + '</button>' +
        '</div>' + (showSteps ? stepsHtml(st.endpoint) : '');
    } else {
      body = '<div class="wc-meta">Your scale writes to Apple Health. A Shortcut on your iPhone can send that weight here every morning, so you never type it. Off until you make a key. The key works for your weight only.</div>' +
        '<div class="hs-btns"><button type="button" class="pg-chip on" data-hs-action="create">Create Shortcut key</button></div>';
    }
    return '<div class="wc-card hs-card" id="hsCard"><div class="wc-card-h">⌚ Apple Health weight</div>' + body +
      (err ? '<div class="hs-err" role="alert">' + esc(err) + '</div>' : '') + '</div>';
  }

  function refresh() { const el = document.getElementById('hsCard'); if (el) { const h = cardHtml(); if (h) el.outerHTML = h; else el.remove(); } }

  async function call(action) {
    const mod = await import(FUNCTIONS_SDK);
    const fns = mod.getFunctions();
    // Localhost only: point THIS instance at the Functions emulator before the call. The page-wide
    // connect does not await the default instance, so without this the first call can race it and
    // POST to production. A no-op off localhost.
    try { await (await import('/pro/js/nbd-emulator-connect.js')).connectEmulatorsIfLocal({ functions: fns }); } catch (_) { /* prod path */ }
    const res = await mod.httpsCallable(fns, 'healthShortcutManage')({ action });
    return (res && res.data) || {};
  }

  async function load() {
    try { st = await call('status'); } catch (_) { st = null; }
    insert();
  }

  function insert() {
    try {
      const main = document.getElementById('main');
      const h = cardHtml();
      const cur = document.getElementById('hsCard');
      if (!h) { if (cur) cur.remove(); return; }
      if (cur) { cur.outerHTML = h; return; }
      if (!main) return;
      const box = document.createElement('div');
      box.className = 'hs-dash';
      box.innerHTML = h;
      const after = document.getElementById('pgCard') || document.getElementById('wtCard');
      const anchor = after && after.parentNode && (after.parentNode === main || after.parentNode.parentNode === main) ? (after.parentNode === main ? after : after.parentNode) : null;
      main.insertBefore(box, anchor ? anchor.nextSibling : main.firstChild);
    } catch (_) { /* the dashboard renders without it */ }
  }

  async function act(action) {
    if (busy) return;
    busy = true; err = ''; refresh();
    try {
      const out = await call(action);
      st = out;
      if (action === 'create' && out.token) { revealed = out.token; showSteps = true; }
      else revealed = null;
    } catch (e) {
      err = e && e.code === 'functions/failed-precondition' ? 'The Health Shortcut is not turned on yet.' : 'Could not do that. Try again in a moment.';
    } finally { busy = false; armed = null; refresh(); }
  }

  function copy(text, what) {
    const done = () => { copied = what; refresh(); setTimeout(() => { copied = ''; refresh(); }, 1800); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, () => selectKey()); return; }
    } catch (_) { /* fall through */ }
    selectKey();
  }
  function selectKey() { const i = document.getElementById('hsKey'); if (i) { i.focus(); i.select(); } }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-hs-action]');
    if (!t) return;
    const a = t.dataset.hsAction;
    if (a === 'create') act('create');
    else if (a === 'rotate') { if (armed === 'rotate') act('create'); else { armed = 'rotate'; refresh(); } }
    else if (a === 'off') { if (armed === 'off') act('off'); else { armed = 'off'; refresh(); } }
    else if (a === 'steps') { showSteps = !showSteps; refresh(); }
    else if (a === 'done') { revealed = null; refresh(); }
    else if (a === 'copy' && revealed) copy(revealed, 'key');
  });

  function hookDash() {
    const orig = window.renderDash;
    if (typeof orig !== 'function' || orig.__hs) return;
    const wrapped = function () { const r = orig.apply(this, arguments); insert(); return r; };
    Object.keys(orig).forEach((k) => { wrapped[k] = orig[k]; });
    wrapped.__hs = true;
    window.renderDash = wrapped;
  }

  // Ask the server once per page load, after sign-in (the call needs a user).
  async function whenSignedIn(cb) {
    try {
      const app = await import(APP_SDK);
      const auth = await import(AUTH_SDK);
      const go = () => {
        if (!app.getApps().length) { setTimeout(go, 500); return; }
        const unsub = auth.onAuthStateChanged(auth.getAuth(), (u) => { if (u) { try { unsub(); } catch (_) {} cb(); } });
      };
      go();
    } catch (_) { /* no card without the SDK */ }
  }

  function boot() { hookDash(); whenSignedIn(load); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDHealthShortcutUI = { cardHtml, refresh, _state: (s) => { st = s; }, _reveal: (k) => { revealed = k; }, _arm: (a) => { armed = a; }, _err: (e) => { err = e; } };
})();
