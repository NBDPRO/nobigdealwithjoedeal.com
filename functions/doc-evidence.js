/**
 * functions/doc-evidence.js — the server's side of the evidence and clause
 * foundation (Jo, 2026-11-18, template/liability overhaul, phase 1). See
 * documentation/projects/CLAUSE-EVIDENCE-FOUNDATION-2026-11-18.md.
 *
 * What a signed record must carry, on EVERY signing path: the clause-set version
 * (clause-set.js), a SHA-256 digest of the exact document that was presented, the
 * consent text shown, the signing time, and the signer's IP and user agent. The
 * IP and user agent are read here, on the server, from the request — never taken
 * from a value the client sent.
 *
 * No npm packages (db is injected, crypto is built in), so the authed E2E and
 * the unit tests load it without functions/node_modules.
 *
 *   FLAG_NAME      the per-person feature flag docEvidenceFoundation (default OFF):
 *                  the fail-closed send checks, the in-person evidence write and
 *                  the remote-link consent checkbox. The stamps the existing
 *                  server writes already make (clause set, digest) are additive
 *                  and not gated.
 *   buildEvidence  one record shape for every path: every key present, null when unknown.
 *   stampFor       { clauseSetVersion, clauseIds } for a lead (+ estimate).
 *   serverGaps     the shared contract-gap check (doc-send-checks.js) for a server caller.
 */
'use strict';

const crypto = require('crypto');
const ClauseSet = require('./clause-set');
const Checks = require('./doc-send-checks');

const FLAG_NAME = 'docEvidenceFoundation';
const FLAG_DEFAULT = false;
// Phase 2 (2026-11-18): print the clause set v1 on the contract-class paths. Per person, default OFF.
const CLAUSE_FLAG_NAME = 'docClauseSetV1';

// The platform tenant's legal entity (company-profile.js brand.entityName default,
// the same string). A tenant key-less record, or the NBD owner's, is NBD's; any
// other tenant must set its own — never inherited.
const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const NBD_ENTITY_NAME = 'No Big Deal Solutions LLC';
const NBD_PHONE = '(859) 420-7382';

/** Only the boolean true turns the flag on; per-person overrides the default doc. */
function flagOn(flagsDefault, flagsMine, name) {
  const merged = Object.assign({}, flagsDefault || {}, flagsMine || {});
  return merged[name || FLAG_NAME] === true;
}

/**
 * Is the flag on for this person? feature_flags/_default merged with the
 * person's own doc. An unreadable flag reads OFF: this ships dark, and a read
 * failure must never switch new behaviour on.
 */
async function flagForUid(db, uid, opts) {
  // opts.strict (review 2026-11-18, finding 7): a SEND GATE must not read "off" because the
  // read failed. With strict the error is thrown (the gate turns it into a retryable refusal);
  // without it the old best-effort "unreadable reads OFF" holds, for the parts that only add.
  const strict = !!(opts && opts.strict === true);
  try {
    const flagDocId = String(uid || '');
    const reads = [db.doc('feature_flags/_default').get()];
    if (flagDocId) reads.push(strict ? db.doc('feature_flags/' + flagDocId).get() : db.doc('feature_flags/' + flagDocId).get().catch(() => null));
    const snaps = await Promise.all(reads);
    const docs = snaps.map((s) => (s && s.exists ? (s.data() || {}) : {}));
    return flagOn(docs[0], docs[1], opts && opts.flag);
  } catch (e) { if (strict) throw e; return false; }
}

const FLAG_UNREADABLE_MSG = 'Could not run the pre-send document check just now. Nothing was sent. Try again in a moment.';

/**
 * The flag as a SEND GATE reads it: true / false, or a retryable 'unavailable' error when the
 * flag could not be read at all (fail closed: a read error never switches a control off).
 * HttpsError is passed in so this module stays free of npm packages.
 */
async function flagForGate(db, uid, HttpsError) {
  try { return await flagForUid(db, uid, { strict: true }); }
  catch (_) { throw new HttpsError('unavailable', FLAG_UNREADABLE_MSG); }
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * { ip, ua } of an HTTP request, read from the request itself (never the body).
 * Lazy and guarded: a request with no readable address yields nulls, never a throw.
 */
function requestFacts(req) {
  let ip = null;
  let ipSource = null;
  try {
    const rl = require('./integrations/upstash-ratelimit');
    if (typeof rl.clientIpInfo === 'function') { const info = rl.clientIpInfo(req || {}); ip = info.ip || null; ipSource = info.source || null; }
    else { ip = rl.clientIp(req || {}) || null; ipSource = ip ? 'unreported' : null; }
  } catch (_) { ip = null; ipSource = null; }
  // clientIp's "no usable address" marker is not evidence: null, and the source says so (review 2, item 9),
  // the same on every path (deal-acceptance.js uses this reading too).
  if (!ip || ip === 'unknown') { ip = null; ipSource = 'unknown'; }
  let ua = null;
  try { ua = String((req && typeof req.get === 'function' && req.get('user-agent')) || '').slice(0, 300) || null; } catch (_) { ua = null; }
  return { ip, ua, ipSource };
}

function _s(v, max) { return typeof v === 'string' && v ? v.slice(0, max) : null; }

/**
 * One evidence record, the same shape on every path. Every key is always
 * present: a fact we do not have reads null, never an absent key a reader skips.
 *   path            'esign_envelope' | 'deal_room' | 'in_person' | 'remote_link'
 *   documentSha256  digest of the document as presented (the bytes the signer saw)
 *   signedSha256    digest of the executed record, when there is one
 *   consent         { agreed: true | false | null, text, at } — null = no consent step on this path
 */
function buildEvidence(input) {
  const i = input || {};
  const at = Number.isFinite(Number(i.signedAtMs)) ? Number(i.signedAtMs) : Date.now();
  const c = i.consent || {};
  return {
    path: _s(i.path, 40),
    clauseSetVersion: _s(i.clauseSetVersion, 60),
    clauseIds: Array.isArray(i.clauseIds) ? i.clauseIds.slice(0, 60).map(String) : [],
    documentSha256: _s(i.documentSha256, 64),
    signedSha256: _s(i.signedSha256, 64),
    consent: {
      agreed: c.agreed === true ? true : (c.agreed === false ? false : null),
      text: _s(c.text, 600),
      at: c.agreed === true ? (Number.isFinite(Number(c.at)) ? Number(c.at) : at) : null,
    },
    signedAtMs: at,
    ip: _s(i.ip, 64),
    // How the address was derived ('xff:hops=1:chain=3' or 'socket'): the address is only as good as the
    // proxy-hop count it assumes (functions/rate-limit.js NBD_TRUSTED_PROXY_HOPS, default 1).
    ipSource: _s(i.ipSource, 80),
    ua: _s(i.ua, 300),
    recordedByUid: _s(i.recordedByUid, 128),
  };
}

/**
 * The v1 clause refs a document printed: opts.refs (the server built the document) or the
 * <!-- nbd:clause-set VERSION ref,ref --> marker in opts.html. null when there are none.
 */
function v1RefsFrom(opts) {
  const o = opts || {};
  let version = o.version || ClauseSet.CLAUSE_SET_VERSION;
  let raw = Array.isArray(o.refs) ? o.refs : null;
  if (!raw && typeof o.html === 'string') {
    const m = /<!-- nbd:clause-set (CS-[0-9.-]+) ([A-Za-z0-9_,-]{1,2000}) -->/.exec(o.html);
    if (m) { version = m[1]; raw = m[2].split(','); }
  }
  if (!raw) return null;
  const known = ClauseSet.V1_IDS;
  const refs = raw.filter((r) => { const m = /^([A-Z]+-\d+)_V\d+$/.exec(String(r)); return m && known.indexOf(m[1]) !== -1; });
  return refs.length && version === ClauseSet.CLAUSE_SET_VERSION ? { version, refs } : null;
}

/** { clauseSetVersion, clauseIds } for a lead (+ estimate), through the one Kentucky classifier. */
function stampFor(KyLaw, lead, est, opts) {
  let j = null;
  try { j = KyLaw.classifyLead(lead || {}, est || {}); } catch (_) { j = null; }
  let source = '';
  // An unreadable state keeps the payment source unknown too: the strict set (fail closed).
  if (j && j.state) {
    const jt = typeof KyLaw.normJobType === 'function' ? KyLaw.normJobType((lead || {}).jobType) : '';
    source = j.insurance ? 'insurance' : (jt === 'finance' ? 'financed' : 'cash');
  }
  const d = ClauseSet.describeFor({ state: j ? j.state : '', paymentSource: source });
  const out = { clauseSetVersion: d.clauseSetVersion, clauseIds: d.clauses.map((c) => c.ref) };
  // A document that printed the clause set v1 says so (marker) or the caller passes the refs it built;
  // only refs the registry knows are recorded, so a forged marker cannot add an unknown id.
  const v1 = v1RefsFrom(opts);
  if (v1) { out.clauseSetVersion = v1.version; v1.refs.forEach((r) => { if (out.clauseIds.indexOf(r) === -1) out.clauseIds.push(r); }); }
  return out;
}

/** Is this tenant key the NBD platform tenant (or key-less, which reads as NBD like entityNameFor)? */
function isNbdTenant(tenantKey) { return !tenantKey || String(tenantKey) === NBD_OWNER_UID; }

/** { state, paymentSource } the clause set reads for a lead (+ estimate): unreadable state keeps the source unknown (strict). */
function clauseContextFor(KyLaw, lead, est) {
  let j = null;
  try { j = KyLaw.classifyLead(lead || {}, est || {}); } catch (_) { j = null; }
  if (!j || !j.state) return { state: '', paymentSource: '' };
  const jt = typeof KyLaw.normJobType === 'function' ? KyLaw.normJobType((lead || {}).jobType) : '';
  return { state: j.state, paymentSource: j.insurance ? 'insurance' : (jt === 'finance' ? 'financed' : 'cash') };
}

/**
 * The clause set v1 for a server-built document (flag docClauseSetV1): renderV1 with this tenant's numbers
 * (NBD's own only for the NBD tenant), its party block and the job facts. Pure; the caller reads the flag.
 */
function buildClauseSet(KyLaw, lead, est, profile, tenantKey, facts, printed) {
  // Review 2026-11-18, item 9: a lead with neither companyId nor userId is nobody's. It never reads as NBD (NBD's numbers
  // and party names); the v1 build is refused instead.
  if (!tenantKey) {
    const err = new Error('This lead has no company on it, so the clause set cannot be built. Open the lead, check its company, and try again.');
    err.clauseRefused = true;
    throw err;
  }
  const nbd = isNbdTenant(tenantKey);
  const p = profile || {};
  const brand = p.brand || {};
  const ctx = clauseContextFor(KyLaw, lead, est);
  const phone = String(((brand.contact || {}).phone) || '').trim() || (nbd ? NBD_PHONE : '');
  return ClauseSet.renderV1({
    state: ctx.state, paymentSource: ctx.paymentSource,
    terms: ClauseSet.paymentTermsFor(p.paymentTerms, nbd),
    party: ClauseSet.partyFor(brand, nbd),
    // Review 2026-11-18, item 7: user-supplied facts carry no scannable {{token}} into the document.
    facts: Object.assign({ companyPhone: ClauseSet.plain(phone) }, safeFacts(facts)),
    printed: printed || undefined,
  });
}

/** The job facts with every string made token-safe (ClauseSet.plain); non-strings (milestones) pass through. */
function safeFacts(facts) {
  const out = {};
  Object.keys(facts || {}).forEach((k) => {
    const v = facts[k];
    out[k] = typeof v === 'string' ? ClauseSet.plain(v) : (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? ClauseSet.plain(x) : x)) : v);
  });
  return out;
}

/** buildClauseSet for a callable: a refusal becomes a failed-precondition HttpsError (HttpsError is passed in). */
function buildClauseSetFor(HttpsError, KyLaw, lead, est, profile, tenantKey, facts, printed) {
  try { return buildClauseSet(KyLaw, lead, est, profile, tenantKey, facts, printed); }
  catch (e) {
    if (e && e.clauseRefused) throw new HttpsError('failed-precondition', e.message);
    throw e;
  }
}

const _esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The clause set as the HTML block the deal page carries: escaped, ids shown, bold lead-ins. */
function clauseSetHtml(cs) {
  const para = (t) => _esc(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const items = (list) => (list || []).filter((x) => !x.byRef).map((x) => x.paragraphs.map((p) =>
    '<p style="margin:6px 0;"><span style="color:#777;font-size:10px;">' + _esc(x.id) + '</span> ' + para(p) + '</p>').join('')).join('');
  const parts = [];
  if (cs.party) parts.push('<h3 style="margin:10px 0 4px;font-size:13px;">Parties</h3><p style="margin:6px 0;"><span style="color:#777;font-size:10px;">PARTY-1</span> ' + para(cs.party.paragraphs[0]) + '</p>');
  (cs.sections || []).forEach((s) => {
    const inner = items(s.items);
    if (inner) parts.push('<h3 style="margin:10px 0 4px;font-size:13px;">' + _esc(s.title) + '</h3>' + inner);
  });
  if (cs.partyBlock) parts.push('<p style="margin:10px 0 4px;font-size:12px;"><strong>' + _esc(cs.partyBlock.nameLine) + '</strong><br>' + _esc(cs.partyBlock.byLine) + '</p>');
  return '<div data-nbd-clause-set="' + _esc(cs.clauseSetVersion) + '" style="background:#fff;color:#111;border-radius:10px;padding:14px;margin:16px 0;font-size:12px;line-height:1.5;">' + parts.join('') + '</div>';
}

/** Put the clause block before the page's Sign & Schedule section (else the signature box, else the end). */
function injectClauseBlock(html, block) {
  const h = String(html == null ? '' : html);
  if (!block) return h;
  const marks = ['<div class="section-title">Sign & Schedule</div>', '<div class="section-title">Sign &amp; Schedule</div>', '<div class="sign-section">', '</body>'];
  for (let k = 0; k < marks.length; k++) {
    const at = h.indexOf(marks[k]);
    if (at >= 0) return h.slice(0, at) + block + h.slice(at);
  }
  return h + block;
}

/** The flag as a send gate reads it (a read error is a retryable refusal, never "off"). */
async function clauseFlagForGate(db, uid, HttpsError) {
  try { return await flagForUid(db, uid, { strict: true, flag: CLAUSE_FLAG_NAME }); }
  catch (_) { throw new HttpsError('unavailable', FLAG_UNREADABLE_MSG); }
}

/** The legal entity a tenant's contracts name: its own, else NBD's for the NBD tenant only. */
function entityNameFor(profile, tenantKey) {
  const own = String(((profile || {}).brand || {}).entityName || '').trim();
  if (own) return own;
  return (!tenantKey || String(tenantKey) === NBD_OWNER_UID) ? NBD_ENTITY_NAME : '';
}

/** The shared contract-gap check (doc-send-checks.js) for a server caller. */
function serverGaps(facts) {
  return Checks.contractGaps(facts);
}

/**
 * The full gap check as the SERVER can run it (review 2026-11-18, finding 2): from the stored
 * document, the lead, the tenant profile and the price, never from anything the browser claims.
 * The browser check is only UX; this is the gate.
 *   o = { type, html, lead, profile, tenantKey, KyLaw, priceCents, address, homeownerName }
 * Start date and estimated completion live in the generator's form data, which the server never
 * sees (the stored HTML prints them as free text), so those two are not checked here: they are
 * marked present, and the [placeholder] scan still catches an unfilled token for them.
 */
function serverContractGaps(o) {
  const x = o || {};
  const lead = x.lead || {};
  const KyLaw = x.KyLaw;
  const name = x.homeownerName != null ? x.homeownerName
    : [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.name || lead.fullName;
  return Checks.contractGaps({
    type: x.type || 'contract',
    priceCents: x.priceCents,
    address: x.address != null ? x.address : lead.address,
    homeownerName: name,
    mailingAddress: KyLaw && typeof KyLaw.contractorMailingAddress === 'function' ? KyLaw.contractorMailingAddress(x.profile || {}) : '',
    needsMailingAddress: true,
    entityName: entityNameFor(x.profile, x.tenantKey),
    startDate: 'not observable on the server', estimatedCompletion: 'not observable on the server',
    text: x.html == null ? '' : x.html,
    clauseConfigMissing: x.clauseConfigMissing,
  });
}

/** Cents from an estimate document (grandTotal, else total), or null. */
function estimateCents(est) {
  const n = Number(est && (est.grandTotal != null ? est.grandTotal : est.total));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/** Is the clause-set v1 flag on for this person? An unreadable flag reads OFF (it only adds text; the send gate is the other flag). */
function clauseFlagForUid(db, uid) { return flagForUid(db, uid, { flag: CLAUSE_FLAG_NAME }); }

module.exports = {
  CLAUSE_FLAG_NAME, clauseFlagForUid,
  FLAG_NAME, FLAG_DEFAULT, NBD_ENTITY_NAME, CLAUSE_SET_VERSION: ClauseSet.CLAUSE_SET_VERSION,
  NBD_OWNER_UID_FOR_TESTS: NBD_OWNER_UID, clauseSetHtml, injectClauseBlock, isNbdTenant, clauseContextFor, buildClauseSet, buildClauseSetFor, clauseFlagForGate, v1RefsFrom, flagOn, flagForUid, flagForGate, FLAG_UNREADABLE_MSG, sha256Hex, requestFacts, buildEvidence, stampFor, entityNameFor, serverGaps,
  serverContractGaps, estimateCents, isContractClass: Checks.isContractClass,
  describeGaps: Checks.describeGaps,
};
