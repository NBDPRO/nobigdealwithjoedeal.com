/**
 * sync-chip-logic.js - the pure half of the one sync chip in the Daily Success header (audit M9).
 *
 * No DOM, no Firebase. sync-chip-ui.js draws the result into #sdot; ds-firebase-sync.js picks the retry delays from here.
 *
 * The chip answers one question: what is safe in the cloud, and what is only on this phone?
 *   - unsaved edits            "UNSAVED"                           (not even on the phone yet)
 *   - signed out               "SAVED ON PHONE - SIGNED OUT"       (nothing goes to the cloud)
 *   - offline                  "SAVED ON PHONE - OFFLINE"          (a retry could not work, so it is not tappable)
 *   - pushing                  "SAVED ON PHONE - SYNCING"
 *   - failed                   "NOT SYNCED - TAP TO RETRY"         (stays up until it works, and is the one tappable state)
 *   - paused                   "SYNC PAUSED"                       (another account was on this phone; the sync waits)
 *   - synced                   "SYNCED 3:42 PM"
 */
(function (root) {
  'use strict';

  // 2 s, 5 s, 15 s, 45 s, 2 min, then every 5 min.
  const LADDER = [2000, 5000, 15000, 45000, 120000, 300000];
  function backoffMs(attempt) {
    const n = Math.max(1, Math.floor(Number(attempt)) || 1);
    return LADDER[Math.min(n, LADDER.length) - 1];
  }

  function fmtTime(at) {
    const d = new Date(Number(at) || 0);
    if (!Number(at) || isNaN(d.getTime())) return '';
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + m + ' ' + ap;
  }

  // Each state is a list of [text, longOnly]. On a phone the header has room for about 130 px, so the segments marked longOnly are
  // hidden by CSS there ("SAVED ON PHONE - SYNCING" reads "SAVED - SYNCING"; "TAP TO RETRY" reads "RETRY"). text is all of it.
  const mk = (key, cls, retry, parts) => ({ key, cls, retry, parts, text: parts.map((p) => p[0]).join('') });
  const DOT = '● ', SEP = ' · ';

  // s: { signedIn: true | false | null (not known yet), online, dirty, cloud: 'idle'|'syncing'|'synced'|'failed'|'paused', at }
  function chipState(s) {
    s = s || {};
    if (s.dirty) return mk('unsaved', 'sdot dirty', false, [[DOT + 'UNSAVED', false]]);
    if (s.signedIn === null || s.signedIn === undefined) return mk('saved', 'sdot ok', false, [[DOT + 'SAVED', false]]);
    if (s.signedIn === false) return mk('signedout', 'sdot neu', false, [[DOT + 'SAVED', false], [' ON PHONE', true], [SEP + 'SIGNED OUT', false]]);
    if (s.online === false) return mk('offline', 'sdot neu', false, [[DOT + 'SAVED', false], [' ON PHONE', true], [SEP + 'OFFLINE', false]]);
    if (s.cloud === 'paused') return mk('paused', 'sdot err', false, [[DOT + 'SYNC PAUSED', false]]);
    if (s.cloud === 'failed') return mk('failed', 'sdot err', true, [[DOT + 'NOT SYNCED' + SEP, false], ['TAP TO ', true], ['RETRY', false]]);
    if (s.cloud === 'synced') return mk('synced', 'sdot ok', false, [[DOT + 'SYNCED' + (fmtTime(s.at) ? ' ' + fmtTime(s.at) : ''), false]]);
    return mk('syncing', 'sdot neu', false, [[DOT + 'SAVED', false], [' ON PHONE', true], [SEP + 'SYNCING…', false]]);
  }

  const api = { chipState, backoffMs, fmtTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDSyncChip = Object.assign(root.NBDSyncChip || {}, api);
})(typeof window !== 'undefined' ? window : null);
