/**
 * zelle-contact.js — where a homeowner sends a Zelle payment (Jo, 2026-10-04).
 *
 * Jo corrected this: Zelle goes to (859) 420-7382 or jd@nobigdealwithjoedeal.com,
 * NOT info@. The documents / letterhead email STAYS info@ (brand.contact.email);
 * Zelle has its own pair on the company profile:
 *
 *   brand.contact.zelleEmail / brand.contact.zellePhone
 *
 * NBD's pair (jd@ + (859) 420-7382) is the default ONLY when the caller's
 * companyId IS the NBD platform tenant (NBD_OWNER_UID) — never decided from
 * brand strings: a tenant that never set brand.legalName looks exactly like
 * NBD by brand (provisioning-retry.js), and printing NBD's Zelle on its
 * invoice would send its customer's money to Jo. No companyId → no default.
 * Any other tenant gets only what it set itself — empty means "fall back to
 * what that surface did before" (the documents print contact.email; the
 * Stripe footer and the portal print no Zelle line). The browser twin is
 * docs/pro/js/company-profile.js (defaults + _IDENTITY_CONTACT) and
 * document-generator.js _resolveCompany; tests/receipts-zelle-ach-2026-10-04.test.js
 * pins that they agree.
 */
'use strict';

const NBD_LEGAL_NAME = 'No Big Deal Home Solutions';
const NBD_ZELLE = Object.freeze({ email: 'jd@nobigdealwithjoedeal.com', phone: '(859) 420-7382' });
// Same constant every functions file uses for the platform tenant.
const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

/** True only for the NBD platform tenant's companyId (fail closed). */
function isNbdCompany(companyId) {
  return typeof companyId === 'string' && companyId !== '' && companyId === NBD_OWNER_UID;
}

function isNbdBrand(brand) {
  return !brand || !brand.legalName || brand.legalName === NBD_LEGAL_NAME;
}

const _clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 120) : '');

/** "(859) 420-7382 or jd@…" — phone first (Jo's order), either alone, or ''. */
function zelleText(phone, email) {
  const p = _clean(phone), e = _clean(email);
  return p && e ? p + ' or ' + e : (p || e || '');
}

/**
 * The Zelle contact for a brand (companyProfile.brand) of the tenant
 * `companyId`. → { email, phone, text }
 * text is '' when the tenant set none (the caller keeps its old behaviour).
 * NBD's defaults need BOTH an NBD brand and the NBD companyId.
 */
function zelleContactOf(brand, companyId) {
  const b = (brand && typeof brand === 'object') ? brand : null;
  const c = (b && b.contact && typeof b.contact === 'object') ? b.contact : {};
  const nbd = isNbdBrand(b) && isNbdCompany(companyId == null ? '' : String(companyId));
  const email = _clean(c.zelleEmail) || (nbd ? NBD_ZELLE.email : '');
  const phone = _clean(c.zellePhone) || (nbd ? NBD_ZELLE.phone : '');
  return { email, phone, text: zelleText(phone, email) };
}

module.exports = { NBD_ZELLE, NBD_LEGAL_NAME, NBD_OWNER_UID, isNbdBrand, isNbdCompany, zelleText, zelleContactOf };
