/**
 * scripts/_zip-state.js — does a lead's ZIP belong to the state it says?
 *
 * audit-lead-addresses.js only checked that a 5-digit ZIP is PRESENT, so
 * "Cincinnati, OH 46211" (462xx is Indianapolis; the street is almost
 * certainly 45211) classified as `ok` (Repo Lab 2026-10-07, item 4). A wrong
 * ZIP breaks storm-near-customer matching and the county/tax lookups.
 *
 * REPORT-ONLY: the audit prints counts and doc ids; it never writes and the
 * result does not change the audit's exit code.
 *
 * Ranges are USPS 3-digit ZIP prefixes for the states NBD works in:
 *   OH 430–459   KY 400–427   IN 460–479
 * Any other valid state code is 'uncheckedState' (not judged either way).
 *
 * Kept in its own module so the unit test can load it without the audit's
 * firebase-admin entrypoint (tests/address-audit-script.test.js stubs that).
 */
'use strict';

const RANGES = {
  OH: [430, 459],
  KY: [400, 427],
  IN: [460, 479],
};

const STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR').split(' '));

// "<STATE> <ZIP>" — the state token immediately before the ZIP, optional comma.
const STATE_ZIP = /\b([A-Za-z]{2})\s*,?\s+(\d{5})(?:-\d{4})?\b/g;

/**
 * @param {string} addr
 * @returns {'ok'|'mismatch'|'uncheckedState'|'noPair'}
 *   ok             ZIP prefix is inside the stated state's range
 *   mismatch       state is OH/KY/IN and the ZIP prefix is outside its range
 *   uncheckedState a real state code we have no range for
 *   noPair         no "<STATE> <ZIP>" pair to judge (missing state or ZIP)
 */
function zipStateCheck(addr) {
  const s = String(addr == null ? '' : addr);
  let m, last = null;
  STATE_ZIP.lastIndex = 0;
  while ((m = STATE_ZIP.exec(s)) !== null) {
    if (STATES.has(m[1].toUpperCase())) last = m;
  }
  if (!last) return 'noPair';
  const state = last[1].toUpperCase();
  const range = RANGES[state];
  if (!range) return 'uncheckedState';
  const prefix = Number(last[2].slice(0, 3));
  return prefix >= range[0] && prefix <= range[1] ? 'ok' : 'mismatch';
}

module.exports = { zipStateCheck, RANGES };
