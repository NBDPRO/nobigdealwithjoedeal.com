/**
 * functions/env-number.js — read a numeric env cap WITHOUT turning 0 into the default.
 *
 * `Number(process.env.X) || 2000` is a trap on a cap or kill switch: an
 * operator who sets X=0 to mean "send nothing" gets 2000 instead (found in
 * sms-functions.js STORM_MAX_SMS_PER_DAY, 2026-10-19 messaging audit).
 *
 *   unset / blank / not a number / negative  -> the default
 *   0                                        -> 0 (a real zero: sends nothing)
 *   positive                                 -> floor(value)
 */
'use strict';

function envCap(raw, dflt) {
  if (raw === undefined || raw === null) return dflt;
  const s = String(raw).trim();
  if (s === '') return dflt;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return dflt;
  return Math.floor(n);
}

module.exports = { envCap };
