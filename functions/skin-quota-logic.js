/**
 * skin-quota-logic.js — pure rules for the My Skin storage caps (2026-10).
 *
 * Storage rules cannot count or sum objects, so the caps are enforced here, by
 * the Storage triggers in skin-quota.js:
 *   - a person's pictures: skins/{uid}/**            hard cap 1 GB
 *   - a company's set:     companies/{id}/skins/**   cap 500 MB
 * (The client shows a soft 300 MB warning for personal pictures; that is UI
 * only — see docs/pro/js/my-skin-logic.js QUOTA_SOFT_BYTES.)
 */
'use strict';

const PERSONAL_HARD_BYTES = 1024 * 1024 * 1024;
const COMPANY_CAP_BYTES = 500 * 1024 * 1024;

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const THEME_RE = /^(_custom|_all|[a-z0-9-]{1,40})$/;
const IMAGE_RE = /^[a-z0-9]{8,16}(_t)?$/;

/**
 * Which cap an object name falls under, or null for anything else.
 *   skins/{uid}/wallpaper | texture | mascot
 *   skins/{uid}/themes/{themeId}/{imageId}[_t]
 *   companies/{companyId}/skins/themes/{themeId}/{imageId}[_t]
 */
function classify(name) {
  const p = String(name || '').split('/');
  if (p[0] === 'skins' && p.length >= 3 && ID_RE.test(p[1])) {
    if (p.length === 3 && ['wallpaper', 'texture', 'mascot'].indexOf(p[2]) !== -1) return { kind: 'personal', owner: p[1], prefix: 'skins/' + p[1] + '/' };
    if (p.length === 5 && p[2] === 'themes' && THEME_RE.test(p[3]) && IMAGE_RE.test(p[4])) return { kind: 'personal', owner: p[1], prefix: 'skins/' + p[1] + '/' };
    return null;
  }
  if (p[0] === 'companies' && p.length === 6 && ID_RE.test(p[1]) && p[2] === 'skins' && p[3] === 'themes' && THEME_RE.test(p[4]) && IMAGE_RE.test(p[5])) {
    return { kind: 'company', owner: p[1], prefix: 'companies/' + p[1] + '/skins/' };
  }
  return null;
}

function capFor(kind) { return kind === 'company' ? COMPANY_CAP_BYTES : PERSONAL_HARD_BYTES; }

/** Sum object sizes (strings or numbers) of a bucket listing. */
function sumBytes(files) {
  let n = 0;
  (files || []).forEach((f) => { n += Number(f && (f.size != null ? f.size : f.metadata && f.metadata.size)) || 0; });
  return n;
}

/** The decision for a just-finalized object. totalBytes already includes it. */
function decide(kind, totalBytes) {
  const cap = capFor(kind);
  return { over: totalBytes > cap, cap: cap, total: totalBytes };
}

module.exports = { PERSONAL_HARD_BYTES, COMPANY_CAP_BYTES, classify, capFor, sumBytes, decide };
