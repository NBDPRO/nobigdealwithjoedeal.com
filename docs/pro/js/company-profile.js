/**
 * NBD Company Profile - shop-wide doc constants the rep can edit from Settings.
 *
 * Stored per tenant at Firestore `companyProfile/{companyId}` (Phase-1 audit
 * fix — was a single global `companyProfile/main` readable+writable by any
 * authenticated user of any tenant). The doc key is the signed-in user's
 * companyId claim, falling back to their uid for solo operators (an owner's
 * uid equals the companyId their invited members carry, so the whole tenant
 * resolves to the same doc). The defaults below match the values that used
 * to be hardcoded inside the doc generator templates, so a rep who never
 * touches Settings gets the same documents they did before this module
 * existed.
 *
 * Exposes:
 *   window.NBD_COMPANY_PROFILE_DEFAULTS — canonical defaults
 *   window._companyProfile              — current merged profile (defaults + remote overrides)
 *   window._loadCompanyProfile()        — fetch from Firestore, set _companyProfile
 *   window._ensureCompanyProfile(opts)  — retry that read with backoff until it
 *                                          lands (Promise<boolean>; 2026-09-25)
 *   window._saveCompanyProfile(profile) — write to Firestore + localStorage cache
 *   window._companyProfileLoadedKey()   — the tenant key whose SERVER copy is
 *                                          in memory, or null (2026-09-25)
 *   window._resetCompanyProfile()       — forget the in-memory profile and
 *                                          the loaded flag (account switch)
 */
(function () {
  'use strict';

  // The deposit rule's generic statement (see paymentTermsContract below).
  function _depositPolicyText() {
    const R = (typeof window !== 'undefined') && window.NBDDepositRule;
    if (R && typeof R.policyText === 'function') return R.policyText();
    return 'Cash jobs under $2,000: no deposit — payment in full on completion. ' +
      'Cash jobs of $2,000 or more: 50% deposit at contract signing, balance on completion. ' +
      'Insurance claims: the homeowner’s deductible is due at signing and the insurance ACV payment (the carrier’s first check) ' +
      'is due as soon as the carrier releases it; the balance is due on completion. ' +
      'The deductible is the homeowner’s responsibility and is never waived or reduced.';
  }

  const NBD_COMPANY_PROFILE_DEFAULTS = {
    /* ── LETTERHEAD ────────────────────────────────────────────
       Identity fields that appear on every generated document.
       Empty defaults so the rep's own info wins as soon as they
       fill the Settings → Company Profile → Letterhead panel.
       Render functions fall through to NBDDocGen.COMPANY if any
       field is left blank, so docs are never broken. */
    businessName:    '',
    businessPhone:   '',
    businessEmail:   '',
    businessWebsite: '',
    businessAddress: '',
    businessLicense: '',

    /* ── ESTIMATE PRICING (shop-wide overrides) ────────────────────
       Per-tenant overrides for the per-SQ estimate rates. EMPTY by
       default so estimate-config.js (window.NBD_ESTIMATE_CONFIG) supplies
       the numbers; a forthcoming Settings → Estimates → Add-on Rates editor
       (Phase 2b) will write overrides here. The engine resolves
       companyProfile.pricing → config → inline fallback AT CALC TIME
       (estimate-builder-v2.js applyCompanyPricing). This is the INVERSE of the
       L-1 stale-localStorage trap: config is the default, the shop doc is the
       override, a saved localStorage snapshot never touches add-on pricing.
       NOTE: pricing.tierRates, when present, OVERRIDES the tier rate the existing
       Estimates editor writes to localStorage — the two must not both be live for
       the same field without a clear precedence story (resolved in Phase 2b). */
    pricing: {
      addonPrices: {},   // { steepPerSq, verySteepPerSq, ..., chimneyFlash, ... }
      tierRates:   {}     // { good, better, best }
      // dumpFee / tearOffExtraPerSq may also be set here (optional)
    },

    /* ── JOB BUDGET ALERTS ─────────────────────────────────────
       Per-tenant thresholds for the Expenses view's per-job cost
       flags. Mirrors ExpenseConfig.BUDGET (docs/pro/js/expense-config.js)
       so unconfigured tenants keep the 65/30 industry defaults;
       budgetStatus() falls back per-field on any invalid value. */
    budgetDefaults: {
      directCostPctWarn: 65,   // amber ⚠ when direct cost ≥ this % of contract value
      marginFloorPct:    30    // red ⚠ when projected gross margin < this %
    },

    /* ── LEGAL TEXT ────────────────────────────────────────────── */
    cancellationWindowText: 'three (3) business days',
    cancellationStatute: 'Kentucky Revised Statutes § 367.390',
    cancellationContractClause:
      'The Homeowner has the right to cancel this agreement within three (3) business days of signature without penalty, as permitted by Kentucky Revised Statutes § 367.390. Any deposit paid will be refunded within 10 days of cancellation notice.',
    cancellationProposalShort:
      'You have the right to cancel this agreement within 3 days of signature without penalty (KY Residential Finance Law).',

    changeOrderClause:
      'Any changes to the original scope of work must be documented in writing and signed by both parties before work proceeds. All change orders will specify: description of work, cost adjustments, and timeline impacts. NBD reserves the right to adjust pricing and completion dates based on scope changes.',
    changeOrderClauseShort:
      'Any changes to the scope of work must be documented in writing and agreed upon before proceeding. Change orders will adjust pricing and timeline accordingly.',

    disputeResolutionClause:
      'In the event of dispute, both parties agree to attempt resolution through good faith negotiation. If negotiation fails, disputes shall be resolved through mediation or binding arbitration under Kentucky law.',

    entireAgreementClause:
      'This contract constitutes the entire agreement between parties and supersedes all prior negotiations, representations, or agreements. Any modifications must be made in writing and signed by both parties.',

    // Deposit terms (2026-09-25): the deposit rule's own statement
    // (deposit-rule.js policyText — cash under $2,000 none, cash $2,000+ 50%
    // at signing, insurance the deductible + the ACV payment, the deductible
    // never waived). These defaulted to a flat "Fifty percent (50%)" that
    // contradicted every insurance job and every small cash job. A job with a
    // price prints its own computed terms instead; this is the boilerplate
    // for documents that know no job. deposit-rule.js loads before this file
    // on both pages; the literal is the same sentence for the (unexpected)
    // case it did not, pinned by tests/deposit-rule.test.js.
    paymentTermsContract: _depositPolicyText(),
    // "Insurance assignments accepted." dropped 2026-09-27: the AOB is retired
    // in both states (Direction to Pay instead).
    paymentTermsProposal: _depositPolicyText(),
    paymentMethodsNoCash:
      'All payments must be made by check, ACH transfer, or credit card. No cash payments accepted. Material delays may extend timeline.',

    materialsWarrantyDisclaimer:
      'Material warranties are provided by manufacturers and are separate from NBD workmanship warranty. See warranty section below.',

    proposalValidityDays: 30,
    limitationOfLiability:
      "NBD's total liability shall not exceed the contract price. This proposal is valid for 30 days from date of issue.",

    latePaymentChargeText: '1.5% monthly finance charge',

    /* ── FINANCING ─────────────────────────────────────────────── */
    financePartner: 'Acorn Finance',
    // apr 0 = "rate set by the lender" sentinel (see renderFinancingOptions in
    // document-generator-templates.js): the Acorn marketplace doesn't give the
    // contractor fixed terms, so defaults must not fabricate APRs or badges on
    // customer paper. Enter real APRs only for a genuine fixed-rate program.
    financingTiers: [
      { months: 12, apr: 0, label: '12 Months', badge: 'Short Term', color: '#16a34a' },
      { months: 36, apr: 0, label: '36 Months', badge: 'Mid Term',   color: '#0ea5e9' },
      { months: 60, apr: 0, label: '60 Months', badge: 'Long Term',  color: '#7c3aed' }
    ],

    /* ── MARKETING / BRANDING ──────────────────────────────────── */
    tagline: "No Big Deal — We've Got You Covered",
    serviceArea: 'Greater Cincinnati & Northern Kentucky',
    services: [
      { icon: '🏠',  name: 'Roofing',         desc: 'Full replacements, repairs, and storm damage restoration' },
      { icon: '🧱',  name: 'Siding',          desc: 'Vinyl, fiber cement, LP SmartSide, and board & batten' },
      { icon: '🌧️', name: 'Gutters',         desc: 'Seamless gutters, guards, downspouts, and drainage' },
      { icon: '🪟',  name: 'Windows & Doors', desc: 'Energy-efficient upgrades and storm damage replacement' },
      { icon: '🎨',  name: 'Interior',        desc: 'Water damage repair, paint, drywall, flooring' },
      { icon: '⛈️', name: 'Storm Damage',    desc: 'Damage inspection, photo documentation and a detailed repair estimate for your claim' }
    ],
    valueProps: [
      { icon: '🛡️', title: 'Warranty Protection',  desc: 'Lifetime workmanship warranty on every tier, plus full manufacturer coverage on all materials.' },
      { icon: '📋',  title: 'Storm Damage Documentation', desc: 'We document the damage and give you a detailed repair estimate. You manage your claim, and we can meet your adjuster after you file.' },
      { icon: '⭐',  title: '5-Star Service',        desc: 'Exceptional service from first contact through final walkthrough and beyond.' },
      { icon: '💰',  title: 'Flexible Financing',    desc: 'Affordable monthly payments through our partnership with Acorn Finance.' }
    ],

    /* ── CODE & JURISDICTION ───────────────────────────────────── */
    codeCycle: '2021 International Building Code (IBC)',
    codeJurisdiction: 'Kentucky Building Code (KBC)',

    /* ── BRAND — TenantContext backbone (Phase A, 2026-06-07) ───────
       The single per-tenant brand source of truth. Every brand-bearing
       surface (doc generators, customer portal, SMS/email copy, doc-number
       prefixes) should resolve from window._brand() / window._tenant().brand
       instead of a hardcoded NBD literal. These are the canonical NBD
       defaults; a tenant's companyProfile.brand override deep-merges on top,
       so NBD stays byte-identical until a tenant sets its own values.
       Fields not yet consumed by any surface are wired in later phases
       (B = brand into the renderers, C = contact.alert* into lead routing). */
    brand: {
      displayName: 'No Big Deal',
      legalName:   'No Big Deal Home Solutions',
      seal:        'NBD',
      docPrefix:   'NBD',   // customer IDs / doc numbers: NBD-0001, NBD-WC-…
      // The tagline documents actually carry. Was "No Big Deal with Joe Deal —
      // seriously, it's in the name.", which matched neither the document
      // generator's literal nor the stored companyProfile — stale default.
      tagline:     "No Big Deal — We've Got You Covered",
      smsSignOff:  'Joe from No Big Deal Roofing',
      logoUrl:     'https://nobigdealwithjoedeal.com/assets/images/nbd-logo.png',
      colors: {
        // NBD DOCUMENT STANDARD, locked 2026-09-07. These are MEASURED off the
        // master logo artwork (1536x1024) — the logo is the colour source of
        // truth, not any code file. Retired: #1A3057 (too blue), #12223D,
        // #1A3057 (too grey-blue) and #BD5728, which was both off-brand and
        // failed WCAG AA for body text at 3.07:1 on white.
        primary:   '#1A3057',  // navy — logo wordmark/roof. 13.09:1 on white
        secondary: '#12223D',  // navy-deep — navy mixed 30% to black. 15.89:1
        accent:    '#BD5728',  // orange — the logo's rust. 4.61:1, clears AA
        ink:       '#14181F',  // body text
        charcoal:  '#14181F',
        cream:     '#FAF7F2',
        // Supporting neutrals, mathematically mixed FROM the navy rather than
        // picked by eye — that is why the palette reads as one family.
        grey:      '#4C4C4D',  // logo subline grey — captions, labels. 8.58:1
        rule:      '#DFE2E7',  // hairlines, borders — navy 86% to white
        wash:      '#F6F7F8'   // zebra rows, panel fills — navy 96% to white
      },
      fonts: {
        display:    'Bebas Neue',       // marketing display
        body:       'Montserrat',       // marketing body
        // Document faces per the NBD Document Standard. These two tokens
        // existed but were consumed NOWHERE — the generator hardcoded
        // Georgia/Helvetica. printCSS() now reads them.
        docDisplay: 'Montserrat',       // PDF display / headings
        docBody:    'Lato'              // PDF body
      },
      // Manufacturer and credential badges printed on document classes that
      // carry them. A licence number is a CREDENTIAL CLAIM, not cosmetic
      // styling, so 'affiliates' is listed in _IDENTITY_TOP below and is
      // BLANKED for any non-NBD tenant that has not set its own — otherwise
      // deepMerge would print NBD's GAF/TAMKO/American Operator badges on
      // another company's contracts, which is a false certification claim.
      //
      // 'badge' is the key into window.NBD_BADGE_ASSETS (nbd-badge-assets.js,
      // generated by scripts/build-badge-assets.js) — affiliateRow() renders
      // the actual credential artwork when that asset resolves, and falls
      // back to the plain name/number card below when it doesn't, so a
      // slow/failed script load never produces an empty-looking row.
      affiliates: [
        { name: 'GAF Certified',              number: '#1162011', badge: 'gaf' },
        { name: 'TAMKO Pro Gold',             number: '#181382',  badge: 'tamko' },
        // American Operator has no member-number equivalent — the badge
        // artwork itself carries "Certified" — so number stays empty.
        { name: 'Locally Owned & Operated',   number: '',         badge: 'localOperator',
          alt: 'Locally Owned & Operated — Certified by American Operator' }
      ],
      contact: {
        phone:      '(859) 420-7382',
        // The DOCUMENTS/portal address, not the marketing one. NBD runs two on
        // purpose: jd@ is the public marketing contact (docs/ pages, lead
        // alerts), info@ is what customer documents carry — including the Zelle
        // payment instruction on invoices. Do not unify these.
        email:      'info@nobigdealwithjoedeal.com',
        website:    'nobigdealwithjoedeal.com',
        // Documents have never printed a company address; keep that. The
        // letterhead address lives on companyProfile.businessAddress and feeds
        // the public microsite payload, not the document letterhead.
        address:    '',
        // CAN-SPAM postal address printed under the unsubscribe link on
        // COMMERCIAL email (functions/email-suppression.js tenantPostalAddress
        // reads brand.contact.mailingAddress from each tenant's own profile).
        // Empty on purpose and not a copy of `address`: the letterhead address
        // and the address a contractor is willing to publish in marketing mail
        // are separate decisions. Empty = print no address; there is no
        // platform default, by design.
        mailingAddress: '',
        alertEmail: 'jd@nobigdealwithjoedeal.com', // Phase C: public-lead alert recipient
        alertSms:   '+18594207382',                // Phase C: per-tenant alert SMS
        slackWebhook: ''                           // Phase C: optional per-tenant Slack lead alert (empty = none)
      },
      // Phase C: per-tenant integration endpoints. Empty string = "fall through
      // to the platform/global default" (NBD's global function secrets), so NBD
      // stays byte-identical; a tenant overrides any of these in its
      // companyProfile.brand.integrations. Not yet consumed by a surface beyond
      // documentation — lead routing reads brand.contact.* today.
      integrations: {
        twilioNumber: '',                                   // tenant's own A2P-approved SMS number (else global TWILIO_PHONE_NUMBER)
        resendDomain: 'nobigdealwithjoedeal.com',           // verified sender domain for outbound email
        reviewUrl:    'https://nobigdealwithjoedeal.com/r', // Google review redirect (/r 302)
        calLink:      ''                                    // tenant's Cal.com booking link
      }
    }
  };

  // Deep merge — arrays are replaced wholesale, objects merged key by key.
  // Arrays-as-replace is intentional: editing the services list should set
  // exactly N entries, not graft remote entries onto local defaults.
  function deepMerge(target, source) {
    if (!source || typeof source !== 'object') return target;
    if (Array.isArray(source)) return source.slice();
    const out = Object.assign({}, target);
    Object.keys(source).forEach((k) => {
      const sv = source[k];
      const tv = out[k];
      if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
        out[k] = deepMerge(tv, sv);
      } else if (Array.isArray(sv)) {
        out[k] = sv.slice();
      } else {
        out[k] = sv;
      }
    });
    return out;
  }

  const CACHE_KEY = 'nbd_company_profile_v1';
  // The cache is tenant-SCOPED (CACHE_KEY + ':' + tenantKey). A single global
  // key bled the last tenant's legal text / financing APRs / budgetDefaults into
  // the next tenant's generated documents when two tenants share a browser
  // (e.g. Jo testing NBD then signing in as Oaks). Only ever read/write the
  // keyed variant, and only once the tenant key is known.
  function _cacheKeyFor(k) { return CACHE_KEY + ':' + k; }

  // The tenant's RAW (un-merged) brand override, as written to
  // companyProfile/{key}.brand — NOT deep-merged onto the NBD defaults.
  // _brand() uses this to tell "the tenant set this field" from "the field
  // is just NBD's default showing through the merge", so a partially-
  // configured tenant never inherits NBD's phone/email/logo/seal (review M1).
  // null until a keyed load/cache/save populates it (i.e. NBD or pre-auth).
  let _brandOverrideRaw = null;

  // Resolve the per-tenant document key for `companyProfile/{key}`.
  //
  // Priority:
  //   1. window._userClaims.companyId — populated by dashboard-bootstrap
  //      (instant, no network).
  //   2. Live ID-token claims via getIdTokenResult() — works on customer.html
  //      and any page that exposes window.auth / window._user.
  //   3. uid — solo-operator convention (companyId == uid). An owner's uid is
  //      the companyId their invited members carry, so the tenant shares one
  //      doc. Matches `claims.companyId || uid` used across the backend.
  //
  // Returns null when no user is resolvable yet (not signed in / auth not
  // ready). Callers MUST treat null as "skip Firestore, keep defaults/cache"
  // so we never issue a guaranteed-denied read against a bad key.
  async function _resolveCompanyKey() {
    try {
      const claims = window._userClaims;
      const cid = claims && claims.companyId;
      // Claims read for a DIFFERENT account never pick the key (2026-09-25,
      // PR #1774 review). After an account switch in this tab the dashboard
      // refreshes window._userClaims only once its boot awaits finish, but it
      // reads the company profile before that — with the previous account's
      // companyId, so Save All could later land on a different tenant than
      // the one in memory. A decoded ID token carries its uid (user_id / sub);
      // claims without one (older callers, tests) are trusted as before.
      const claimUid = claims && (claims.user_id || claims.sub);
      const cur = (window.auth && window.auth.currentUser) || window._user || null;
      const stale = !!(claimUid && cur && cur.uid && String(claimUid) !== String(cur.uid));
      if (cid && !stale) return String(cid);
    } catch (_) { /* ignore */ }
    try {
      const u = (window.auth && window.auth.currentUser) || window._user || null;
      if (u && typeof u.getIdTokenResult === 'function') {
        const tr = await u.getIdTokenResult();
        const claimCid = tr && tr.claims && tr.claims.companyId;
        if (claimCid) return String(claimCid);
        if (u.uid) return u.uid;
      }
      if (u && u.uid) return u.uid;
    } catch (_) { /* ignore */ }
    return null;
  }
  // Exported so per-tenant writers outside this module (e.g. the custom-
  // jurisdictions full-replace in dashboard-bootstrap) target the SAME doc
  // key as _saveCompanyProfile — a divergent key means the merge-write and
  // the replace-write hit different docs and deleted rows resurrect.
  window._resolveCompanyKey = _resolveCompanyKey;

  window.NBD_COMPANY_PROFILE_DEFAULTS = NBD_COMPANY_PROFILE_DEFAULTS;
  window._companyProfile = deepMerge({}, NBD_COMPANY_PROFILE_DEFAULTS);

  // Do NOT hydrate from cache here: at module-parse time the tenant key isn't
  // known yet, so reading a cache would risk loading the PREVIOUS tenant's
  // overrides into this session's documents. _loadCompanyProfile hydrates the
  // tenant-keyed cache once the key resolves. Purge any legacy un-keyed cache.
  try { localStorage.removeItem(CACHE_KEY); } catch (_) { /* ignore */ }

  // What the most recent _loadCompanyProfile call ended with: 'ok', 'no-db',
  // 'no-key', or the error it caught. Read ONLY by _ensureCompanyProfile below
  // to tell a retryable failure from one a retry cannot fix — never a
  // substitute for _companyProfileLoaded, which stays the one hydration gate.
  let _lastLoadOutcome = null;

  // WHOSE server copy is in memory (2026-09-25, PR #1774 review). The flag
  // alone said "a server read landed at some point"; it could not say the
  // profile in memory still IS that copy, or which tenant it belongs to:
  //   - every re-read reset the profile to defaults + this tenant's cache
  //     before its getDoc, so a re-read that then failed left that copy in
  //     memory under a true flag — bare defaults when the cache was missing
  //     or could not be written (storage blocked, quota full). The Estimates
  //     tab painted zero jurisdictions as resolved, and Save All
  //     full-replaced the company's list with nothing (reproduced);
  //   - an account switch in the same tab changed the tenant under it.
  // _loadedKey is set only beside the flag, by a server read. A re-read of
  // the SAME tenant now leaves the in-memory copy alone until a new server
  // copy replaces it; a different tenant, or _resetCompanyProfile, clears
  // both. _profileEpoch lets a read that was already out when the account
  // changed land nowhere.
  let _loadedKey = null;
  let _profileEpoch = 0;

  window._companyProfileLoadedKey = function () {
    return window._companyProfileLoaded === true ? _loadedKey : null;
  };

  // Forget the in-memory profile and the loaded flag: the signed-in account
  // changed (dashboard _bindCachesToSession), or a read resolved another
  // tenant's key. Writes the flag only to take it back to false — only a
  // server read ever sets it true.
  window._resetCompanyProfile = function () {
    _profileEpoch++;
    _loadedKey = null;
    _brandOverrideRaw = null;
    window._companyProfile = deepMerge({}, NBD_COMPANY_PROFILE_DEFAULTS);
    if (window._companyProfileLoaded === true) window._companyProfileLoaded = false;
  };

  window._loadCompanyProfile = async function () {
    let epoch = _profileEpoch;
    try {
      if (!window.db) { _lastLoadOutcome = 'no-db'; return window._companyProfile; }
      const key = await _resolveCompanyKey();
      if (!key) { _lastLoadOutcome = 'no-key'; return window._companyProfile; } // not signed in yet — defaults stand
      // The account changed while the key was resolving: that key may be
      // the previous account's. Ask again (retryable) rather than read it.
      if (epoch !== _profileEpoch) { _lastLoadOutcome = 'stale'; return window._companyProfile; }
      // A different tenant than the one whose server copy is in memory
      // (claims changed under this tab): that copy is not this tenant's.
      if (_loadedKey !== null && _loadedKey !== key) { window._resetCompanyProfile(); epoch = _profileEpoch; }
      // Re-reading the tenant whose server copy is already in memory: keep
      // it until the new copy lands. A failed re-read must not put the cache
      // (possibly stale, missing or unwritable) or bare defaults in its place
      // under a flag that still says "loaded".
      const keepServerCopy = window._companyProfileLoaded === true && _loadedKey === key;
      if (!keepServerCopy) {
        // Reset to defaults, then hydrate THIS tenant's cache (instant render)
        // before the network read — so a prior tenant's in-memory or cached
        // overrides can't survive into this tenant's session.
        window._companyProfile = deepMerge({}, NBD_COMPANY_PROFILE_DEFAULTS);
        _brandOverrideRaw = null;
        try {
          const cachedRaw = localStorage.getItem(_cacheKeyFor(key));
          if (cachedRaw) {
            const cached = JSON.parse(cachedRaw) || {};
            window._companyProfile = deepMerge(NBD_COMPANY_PROFILE_DEFAULTS, cached);
            _brandOverrideRaw = cached.brand || null;
          }
        } catch (_) { /* ignore */ }
      }
      const { getDoc, doc } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      // QA 2026-06-21 #1: on a cold boot the Firestore WebChannel can still be
      // establishing, so this first getDoc throws "client is offline" and the
      // feature silently fell back to localStorage/defaults until a reload.
      // Retry the transient before giving up. nbdRetryOffline is defined
      // idempotently here so boot-script load order can't matter.
      window.nbdRetryOffline = window.nbdRetryOffline || async function (fn, tries, delay) {
        tries = tries || 3; delay = delay || 800;
        for (let i = 0; ; i++) {
          try { return await fn(); }
          catch (e) {
            const m = ((e && (e.code || e.message)) || '') + '';
            if (i >= tries - 1 || !/offline|unavailable|deadline|backend|network/i.test(m)) throw e;
            await new Promise(r => setTimeout(r, delay * (i + 1)));
          }
        }
      };
      // ONLY the server's copy counts (2026-09-25, PR #1774 review). Offline,
      // getDoc resolves from the SDK's local view instead of throwing — and a
      // merge write issued before hydration (Settings > Company Profile Save,
      // the AI persona "team default") puts a PARTIAL doc there, holding only
      // the fields it wrote. Accepting that marked the profile loaded with no
      // customJurisdictions, and the next Save All full-replaced the
      // company's list with nothing under a "✓ saved" (reproduced on the rig:
      // fromCache=true pending=true keys=[the one written field]). Back
      // online, the acked write's doc can still race the watch update
      // (fromCache=false, hasPendingWrites=true, same partial keys), so both
      // flags disqualify a snapshot. Thrown as a retryable 'unavailable' so
      // nbdRetryOffline and _ensureCompanyProfile keep asking until a clean
      // server snapshot lands; nothing below — the profile, this tenant's
      // cache, the flag — is touched by a rejected one.
      const snap = await window.nbdRetryOffline(async () => {
        const s = await getDoc(doc(window.db, 'companyProfile', key));
        const md = s && s.metadata;
        if (md && (md.fromCache || md.hasPendingWrites)) {
          throw Object.assign(new Error('companyProfile read came from this device\'s local copy, not the server (the client is offline or a write is still pending)'), { code: 'unavailable' });
        }
        return s;
      });
      // The account changed while this read was out: the copy it fetched
      // belongs to the previous one. Land nothing; the caller asks again.
      if (epoch !== _profileEpoch) { _lastLoadOutcome = 'stale'; return window._companyProfile; }
      if (snap && snap.exists()) {
        const remote = snap.data() || {};
        window._companyProfile = deepMerge(NBD_COMPANY_PROFILE_DEFAULTS, remote);
        _brandOverrideRaw = (remote && remote.brand) || null;
        try { localStorage.setItem(_cacheKeyFor(key), JSON.stringify(remote)); } catch (_) {}
      } else {
        // The server has no doc for this tenant: the defaults ARE its
        // profile. Whatever the cache (or a kept copy) held is not the
        // server's — a write the rules refused, or a doc since deleted.
        window._companyProfile = deepMerge({}, NBD_COMPANY_PROFILE_DEFAULTS);
        _brandOverrideRaw = null;
        try { localStorage.removeItem(_cacheKeyFor(key)); } catch (_) {}
      }
      // Hydration is DEFINITIVE only once the doc read succeeded (exists or
      // not) FROM THE SERVER. Destructive per-tenant writes (the custom-jurisdictions
      // full-replace) gate on this flag so a pre-hydration empty render can
      // never be saved as a tenant-wide wipe. A failed read leaves it unset.
      const firstLanding = window._companyProfileLoaded !== true;
      _loadedKey = key;
      window._companyProfileLoaded = true;
      _lastLoadOutcome = 'ok';
      // Tell every panel still showing "Loading…" that it can paint now,
      // whichever caller's read it was that landed (2026-09-25, lane
      // profretry). Dispatched only here, after a successful read.
      if (firstLanding) {
        try { window.dispatchEvent(new CustomEvent('nbd:company-profile-loaded')); } catch (_) { /* no event target */ }
      }
    } catch (e) {
      _lastLoadOutcome = e || new Error('company profile load failed');
      console.warn('[company-profile] load failed:', e && e.message);
    }
    return window._companyProfile;
  };

  // ── Retry a profile read that gave up (2026-09-25, lane profretry) ──────
  // WHY: _loadCompanyProfile runs ONCE at boot, un-awaited. On a cold
  // Firestore channel its getDoc throws "client is offline"; nbdRetryOffline
  // tries three times inside ~2.4s, gives up, and nothing ever asked again.
  // _companyProfileLoaded then stayed unset for the whole session while a
  // manual _loadCompanyProfile() seconds later landed in ~15ms — so My
  // Jurisdictions sat on "Loading…" until its 30s poll quit, and Save All
  // left county rates and jurisdictions out of the company write.
  //
  // window._ensureCompanyProfile() → Promise<boolean>
  //   true  once _companyProfileLoaded === true;
  //   false when the run ends without it: the backoff schedule ran out, or the
  //         read failed for a reason a retry cannot fix (permission denied, no
  //         signed-in tenant).
  // ONE run at a time: the boot, the Estimates tab and Save All share it
  // instead of stacking reads. A call while the run is waiting out a backoff
  // delay KICKS it — the next read happens now — so opening the tab, pressing
  // Save or coming back online asks straight away rather than polling. A call
  // after a run gave up starts a fresh one, so "Try again" really tries again.
  // A landing is announced by the 'nbd:company-profile-loaded' event above.
  //
  // THE HYDRATION INVARIANT IS UNCHANGED. Every attempt is a plain
  // window._loadCompanyProfile() call — the only writer of
  // _companyProfileLoaded, which it sets only after getDoc resolved with the
  // SERVER's copy (never a local-cache or pending-write snapshot). A failed,
  // refused or timed-out attempt leaves the flag unset, so every destructive
  // full-replace write gated on it stays shut until a real read lands.
  const _ENSURE_DELAYS_MS = [0, 1000, 2000, 4000, 8000, 15000];
  // A getDoc that never settles must not stall the run: after this long the
  // next attempt starts (the stuck one can still land and set the flag).
  const _ENSURE_ATTEMPT_TIMEOUT_MS = 20000;
  let _ensureRun = null;
  let _ensureWake = null; // ends the current backoff delay early (a kick)

  function _ensureDelay(ms) {
    return new Promise(function (resolve) {
      let timer = null;
      const done = function () {
        clearTimeout(timer);
        if (_ensureWake === done) _ensureWake = null;
        resolve();
      };
      timer = setTimeout(done, ms);
      _ensureWake = done;
    });
  }

  function _loadFailureIsFinal(outcome) {
    if (outcome === 'no-db' || outcome === 'no-key') return true;
    if (!outcome || typeof outcome !== 'object') return false; // unknown: retry
    const m = String((outcome.code || '') + ' ' + (outcome.message || ''));
    return /permission|unauthenticated|insufficient/i.test(m);
  }

  async function _runEnsure() {
    for (let i = 0; i < _ENSURE_DELAYS_MS.length; i++) {
      if (window._companyProfileLoaded === true) return true;
      if (_ENSURE_DELAYS_MS[i]) await _ensureDelay(_ENSURE_DELAYS_MS[i]);
      if (window._companyProfileLoaded === true) return true;
      _lastLoadOutcome = null;
      let timer = null;
      try {
        await Promise.race([
          Promise.resolve().then(function () { return window._loadCompanyProfile(); }),
          new Promise(function (_, reject) {
            timer = setTimeout(function () { reject(new Error('company profile read timed out')); }, _ENSURE_ATTEMPT_TIMEOUT_MS);
          })
        ]);
      } catch (e) {
        if (_lastLoadOutcome == null) _lastLoadOutcome = e;
      } finally {
        clearTimeout(timer);
      }
      if (window._companyProfileLoaded === true) return true;
      if (_loadFailureIsFinal(_lastLoadOutcome)) return false;
    }
    return window._companyProfileLoaded === true;
  }

  window._ensureCompanyProfile = function () {
    if (window._companyProfileLoaded === true) return Promise.resolve(true);
    if (typeof window._loadCompanyProfile !== 'function') return Promise.resolve(false);
    if (_ensureRun) {
      if (_ensureWake) _ensureWake();
      return _ensureRun;
    }
    _ensureRun = _runEnsure()
      .catch(function () { return false; })
      .then(function (ok) {
        _ensureRun = null;
        _ensureWake = null;
        return ok === true || window._companyProfileLoaded === true;
      });
    return _ensureRun;
  };

  // A phone that walks back into signal: ask again rather than wait for a tab
  // to be reopened. Only for a signed-in page whose profile never landed.
  try {
    window.addEventListener('online', function () {
      if (window._companyProfileLoaded === true) return;
      if (!(window._user || (window.auth && window.auth.currentUser))) return;
      window._ensureCompanyProfile().catch(function () { /* the next waiter asks again */ });
    });
  } catch (_) { /* no event target (unit-test sandbox) */ }

  // Arrived AFTER the page asked: start the read here (2026-09-25, lane
  // profretry). Both pages load this file deferred, far down the page, and
  // their auth callback can fire in between deferred scripts. It then found
  // no window._loadCompanyProfile, its typeof guard skipped the boot read
  // outright, and nothing ever read the profile — reproduced on the rig at
  // 1280 against main: never called in 25s, flag unset, a manual read
  // landing in 16ms. The boot now leaves window.__nbdCompanyProfileWanted
  // when it skips, so the read starts exactly once, from whichever side runs
  // second. (Not keyed on window._user: nbd-auth.js sets that earlier, and
  // the boot's own read would then run twice.)
  try {
    if (window.__nbdCompanyProfileWanted === true && window._companyProfileLoaded !== true) {
      window.__nbdCompanyProfileWanted = false;
      window._ensureCompanyProfile().catch(function () { /* the waiters ask again */ });
    }
  } catch (_) { /* never block the page on this */ }

  window._saveCompanyProfile = async function (overrides) {
    const overridesObj = overrides || {};
    // Resolve the tenant key up front so the cache read/write below is
    // tenant-scoped (no cross-tenant bleed).
    const key = window.db ? await _resolveCompanyKey() : null;
    // The server copy in memory is ANOTHER tenant's than the one this save
    // lands on (the account's company changed under this tab; 2026-09-25,
    // second review of PR #1774). It is forgotten, not relabelled: the build
    // below then starts from this tenant's cache like any unloaded save —
    // it used to swap this tenant's cache into memory under a flag that
    // still named the other one — and this tenant's server copy is asked for.
    if (key && window._companyProfileLoaded === true && _loadedKey !== null && _loadedKey !== key) {
      window._resetCompanyProfile();
      Promise.resolve().then(function () { return window._ensureCompanyProfile(); }).catch(function () { /* the next waiter asks again */ });
    }
    // Merge onto the EXISTING remote overrides (this tenant's cache, not bare
    // defaults) so a PARTIAL save — e.g. just { pricing } from the Add-on Rates
    // editor — can't clobber unrelated fields (brand / legal / letterhead). This
    // mirrors the Firestore { merge:true } write below so in-memory matches server.
    let prevRemote = {};
    if (key) { try { prevRemote = JSON.parse(localStorage.getItem(_cacheKeyFor(key)) || '{}') || {}; } catch (_) {} }
    const mergedRemote = deepMerge(prevRemote, overridesObj);
    // Once this tenant's SERVER copy is in memory, build on it — never on the
    // cache, which can be missing, unwritable (storage blocked, quota full)
    // or older than it (2026-09-25, PR #1774 review). Rebuilding from a
    // missing cache dropped every field this save did not carry — the saved
    // jurisdictions among them — under a flag that still said "loaded".
    const onServerCopy = !!key && window._companyProfileLoaded === true && _loadedKey === key;
    window._companyProfile = onServerCopy
      ? deepMerge(window._companyProfile, overridesObj)
      : deepMerge(NBD_COMPANY_PROFILE_DEFAULTS, mergedRemote);
    if ('brand' in overridesObj) _brandOverrideRaw = overridesObj.brand || null;
    if (key) { try { localStorage.setItem(_cacheKeyFor(key), JSON.stringify(mergedRemote)); } catch (_) {} }
    if (!window.db) return window._companyProfile;
    if (!key) {
      // No resolvable tenant key — keep in-memory but don't write a mis-keyed
      // (rules-denied) doc or an un-keyed cache. The next save after auth is
      // ready persists it.
      console.warn('[company-profile] save skipped: no tenant key (auth not ready)');
      return window._companyProfile;
    }
    const { setDoc, doc } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    // brand.docPrefix / brand.seal are the tenant's globally-reserved customer-ID
    // prefix — they're set ONLY by the reserveCompanyPrefix callable (admin SDK)
    // and are immutable to client writes (firestore.rules). A full-profile "save
    // everything" round-trip carries the loaded docPrefix back here; strip it from
    // the write so the (deep-merge) setDoc never touches it — otherwise the rules
    // guard would deny the whole save. In-memory/localStorage keep the value (the
    // mint helpers read it); only the Firestore payload is scrubbed.
    const writePayload = _stripReservedBrandKeys(overridesObj);
    await setDoc(doc(window.db, 'companyProfile', key), writePayload, { merge: true });
    return window._companyProfile;
  };

  // Returns a shallow clone of the overrides with brand.docPrefix / brand.seal
  // removed (they're callable-managed + client-immutable). Non-mutating.
  function _stripReservedBrandKeys(overridesObj) {
    if (!overridesObj || !overridesObj.brand || typeof overridesObj.brand !== 'object') return overridesObj;
    const brand = Object.assign({}, overridesObj.brand);
    if (!('docPrefix' in brand) && !('seal' in brand)) return overridesObj;
    delete brand.docPrefix;
    delete brand.seal;
    return Object.assign({}, overridesObj, { brand: brand });
  }

  // ── TenantContext backbone (Phase A, 2026-06-07) ─────────────────
  // The one resolver every brand-bearing surface reads from, so brand is
  // resolved from the ACTIVE TENANT instead of a hardcoded NBD literal.
  //   window._brand()  → the merged brand (NBD defaults + this tenant's
  //                       companyProfile.brand overrides).
  //   window._tenant() → the fuller context later pillars hang off the same
  //                       resolution (lead routing, billing, domains).
  // Both are sync and read window._companyProfile (already merged by the
  // load path). Before auth/load they return NBD defaults — never null —
  // so a consumer can always render a brand.
  // A brand is "NBD" (and renders byte-identical) when it carries no legalName
  // or the canonical NBD legalName. Same gate the doc/PDF/portal consumers use.
  function _isNbdBrand(b) {
    const NBD = NBD_COMPANY_PROFILE_DEFAULTS.brand.legalName;
    return !b || !b.legalName || b.legalName === NBD;
  }

  // Top-level + contact identity fields a tenant must set for itself. For a
  // non-NBD tenant, any of these that the tenant did NOT explicitly provide is
  // blanked rather than left showing NBD's deep-merged default — so NBD's
  // phone/email/logo/seal/tagline can never bleed onto another company's docs,
  // portal, or alerts (review M1). displayName is special-cased to the tenant's
  // own legalName (never blank, never 'No Big Deal'). colors/fonts are cosmetic
  // and may inherit. NBD itself is returned untouched (byte-identical).
  // 'affiliates' belongs here and NOT in the "cosmetic, may inherit" bucket:
  // a GAF/TAMKO licence number is a CERTIFICATION CLAIM. Left to deep-merge, a
  // stranger tenant's contract would print NBD's GAF #1162011 as if it were
  // their own — a false credential on a signed document, which is a materially
  // worse failure than a wrong colour. Blanked to '' like the rest of the
  // identity surface; the badge renderer treats '' / [] / undefined as "no
  // badges" so a tenant that has not set its own simply prints none.
  const _IDENTITY_TOP     = ['seal', 'docPrefix', 'tagline', 'smsSignOff', 'logoUrl', 'affiliates'];
  // 'mailingAddress' belongs here for the same reason as the rest: it is a
  // postal address that identifies a specific business. Left to deep-merge, a
  // stranger tenant would inherit NBD's the moment NBD sets one.
  const _IDENTITY_CONTACT = ['phone', 'email', 'website', 'address', 'mailingAddress', 'alertEmail', 'alertSms'];

  function _resolveBrand() {
    const profile = window._companyProfile || NBD_COMPANY_PROFILE_DEFAULTS;
    const merged = profile.brand || NBD_COMPANY_PROFILE_DEFAULTS.brand;
    if (_isNbdBrand(merged)) return merged; // NBD / unconfigured → full defaults
    // Non-NBD tenant: keep only what the tenant set itself (raw override),
    // blank the rest of the identity surface.
    const raw = _brandOverrideRaw || {};
    const rawContact = raw.contact || {};
    const out = Object.assign({}, merged);
    out.displayName = ('displayName' in raw) ? merged.displayName : (merged.legalName || '');
    _IDENTITY_TOP.forEach(function (k) { if (!(k in raw)) out[k] = ''; });
    out.contact = Object.assign({}, merged.contact);
    _IDENTITY_CONTACT.forEach(function (k) { if (!(k in rawContact)) out.contact[k] = ''; });
    return out;
  }

  window._tenant = function () {
    const profile = window._companyProfile || NBD_COMPANY_PROFILE_DEFAULTS;
    let companyId = null;
    try { companyId = (window._userClaims && window._userClaims.companyId) || null; } catch (_) { /* ignore */ }
    return {
      companyId: companyId,
      brand: _resolveBrand(),
      profile: profile
    };
  };
  window._brand = function () { return _resolveBrand(); };

  /**
   * Resolve the brand logo for a CUSTOMER-FACING DOCUMENT.
   *
   * Defined here, next to _resolveBrand, because every document renderer
   * already depends on this file — a separate module would add a load-order
   * dependency to eight live pages for six lines of code.
   *
   * Order: the inlined data URI (survives the doc viewer's null-origin iframe,
   * where a root-relative src cannot resolve) → the tenant's own logoUrl →
   * nothing. Returns '' rather than a placeholder so callers can fall back to
   * a text wordmark; a document with no logo is fine, a document wearing
   * SOMEONE ELSE'S logo is not.
   *
   * TENANCY: brand.logoUrl is already blanked by _resolveBrand for a non-NBD
   * tenant that has not set its own, so a stranger never inherits NBD's mark.
   * The data URI is only used when the resolved brand IS NBD, for the same
   * reason — it is NBD's artwork, baked in at build time.
   */
  window._brandLogoSrc = function () {
    try {
      const b = _resolveBrand() || {};
      if (_isNbdBrand(b) && typeof window !== 'undefined' && window.NBD_LOGO_DATA_URI) {
        return window.NBD_LOGO_DATA_URI;
      }
      return b.logoUrl || '';
    } catch (_) { return ''; }
  };

  // ── Per-tenant LEGAL text resolver (gauntlet Batch 3) ────────────
  // The top-level companyProfile legal/jurisdiction DEFAULTS (cancellation
  // statute, dispute governing law, building-code jurisdiction, service area,
  // and the clauses that name "NBD" as the contracting party) are deep-merged
  // for EVERY tenant — the brand-blanking in _resolveBrand() only covers
  // brand.*, never these top-level fields. Left alone, a stranger (non-NBD)
  // tenant's generated contract/proposal cites a Kentucky statute, binds
  // disputes to Kentucky law, references the Kentucky Building Code, and names
  // "NBD" as the contractor. _legal() returns the profile with those fields
  // made STATE-NEUTRAL (never jurisdictionally wrong — the 3-day rescission
  // RIGHT is preserved, only the KY citation is dropped) and the literal "NBD"
  // party-name substituted with the tenant's legalName — but ONLY for a
  // non-NBD tenant that did NOT override the field itself (a tenant override in
  // Settings > Legal Text always wins). NBD — and any unconfigured tenant whose
  // brand is still NBD — gets the profile untouched → byte-identical docs.
  //
  // "The tenant set this field" == its merged value differs from the NBD
  // default (value-diff). Every field handled here is a string, so === is safe.
  // Value-diff also SELF-HEALS a doc that a pre-fix Settings "save everything"
  // had frozen with the NBD/KY defaults as explicit overrides: an override that
  // merely echoes the default is indistinguishable from no override, and both
  // get the neutral variant — which is exactly what a non-NBD tenant wants.
  const _NEUTRAL_LEGAL = {
    cancellationStatute: '',
    cancellationContractClause:
      'The Homeowner has the right to cancel this agreement within three (3) business days of signature without penalty, as permitted by applicable state law. Any deposit paid will be refunded within 10 days of cancellation notice.',
    cancellationProposalShort:
      'You have the right to cancel this agreement within 3 days of signature without penalty, as permitted by applicable state law.',
    disputeResolutionClause:
      'In the event of dispute, both parties agree to attempt resolution through good faith negotiation. If negotiation fails, disputes shall be resolved through mediation or binding arbitration under the laws of the state in which the work is performed.',
    codeJurisdiction: 'applicable state and local building codes',
    serviceArea: ''
  };
  // Clauses whose NBD default names the literal "NBD" as the contracting party.
  // For a non-NBD tenant that kept the default, swap "NBD" for their legalName.
  const _PARTY_NAME_CLAUSES = [
    'changeOrderClause',
    'materialsWarrantyDisclaimer', 'limitationOfLiability'
  ];

  function _resolveLegal() {
    const profile = window._companyProfile || NBD_COMPANY_PROFILE_DEFAULTS;
    const brand = profile.brand || NBD_COMPANY_PROFILE_DEFAULTS.brand;
    if (_isNbdBrand(brand)) return profile; // NBD / unconfigured → untouched (byte-identical)
    const D = NBD_COMPANY_PROFILE_DEFAULTS;
    const tenantName = (brand && brand.legalName) || '';
    const out = Object.assign({}, profile);
    // Jurisdiction neutralization — only where the tenant kept the NBD default.
    Object.keys(_NEUTRAL_LEGAL).forEach(function (k) {
      if (out[k] === D[k]) out[k] = _NEUTRAL_LEGAL[k];
    });
    // Party-name substitution — only where the tenant kept the NBD default.
    if (tenantName) {
      _PARTY_NAME_CLAUSES.forEach(function (k) {
        if (out[k] === D[k]) out[k] = String(D[k]).replace(/\bNBD\b/g, tenantName);
      });
    }
    return out;
  }
  window._legal = function () { return _resolveLegal(); };

  // ── Per-tenant customer-ID minting (loose-end fix) ───────────────
  // Customer IDs were hardcoded 'NBD-####' from a single global
  // counters/customerIds doc. These helpers let each tenant mint its own
  // prefix + sequence WITHOUT changing NBD. The gate is the resolved
  // docPrefix: NBD (and any tenant that hasn't set a docPrefix) → the
  // original shared 'customerIds' doc + 'NBD' prefix, byte-identical and
  // never reset. A configured tenant (e.g. Oaks docPrefix 'OAK') →
  // counters/customerIds_<companyId> + its own prefix, so tenants never
  // share or collide a sequence.
  // Fallback docPrefix for a NON-NBD tenant that hasn't formally reserved one
  // (skipped onboarding / blanked the seal). Byte-identical to onboarding.js
  // deriveSeal so a later reserveCompanyPrefix yields the SAME prefix and no
  // customerId reformats mid-stream. Never 'NBD' (the platform sentinel) and
  // never '' — falls back to 'CUS' so the companyId-derived _custIdSalt suffix
  // still yields a globally-unique, non-NBD-branded ID.
  function _deriveCustPrefix() {
    const b = _resolveBrand();
    const words = String((b && b.legalName) || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    let seal = words.map(function (w) { return w[0]; }).join('').slice(0, 4);
    if (seal.length < 2 && words[0]) seal = words[0].slice(0, 3);
    if (!seal || seal === 'NBD') seal = 'CUS';
    return seal;
  }
  // The gate is now "is this the NBD platform tenant?" (via _isNbdBrand), NOT
  // "does the resolved prefix STRING equal 'NBD'?". A non-NBD tenant that never
  // reserved a prefix used to resolve prefix 'NBD' + the shared 'customerIds'
  // counter — minting NBD-branded IDs from NBD's own sequence. Now only the
  // real NBD tenant touches the legacy shared counter / un-salted 'NBD-####';
  // every stranger mints from its own counter with a derived, salted prefix.
  window._custIdPrefix = function () {
    const b = _resolveBrand();
    if (_isNbdBrand(b)) return 'NBD';                       // ONLY the NBD platform tenant
    if (b && b.docPrefix) return b.docPrefix;               // a reserved prefix wins
    return _deriveCustPrefix();                             // non-NBD, unreserved → derived (never 'NBD')
  };
  // ── Tenant prefix for CUSTOMER-FACING FILENAMES (2026-09-06) ──────────
  // ASYNC on purpose. `_companyProfile` is seeded at parse time (:276) with the
  // NBD defaults, whose brand.legalName is the exact string `_isNbdBrand()`
  // (:396) tests for — so `_custIdPrefix()` answers 'NBD' for EVERY tenant
  // until `_loadCompanyProfile()` resolves, and both pages fire that un-awaited.
  // Reading it synchronously to build a filename therefore turns a
  // deterministic leak into a race, AND into a permanent session-long leak
  // whenever hydration fails (getDoc throws → caught at :331 → the profile
  // never loads → every PDF that session is still named "NBD-…").
  //
  // Same gate the customer-ID mint uses (customer-bootstrap.module.js:404-421):
  // await hydration, then REQUIRE _companyProfileLoaded === true. When the
  // answer is not knowable this returns '' and the caller ships an UNPREFIXED
  // name — never 'NBD'. That rule is already written down in
  // estimate-finalization.js:210 ("callers must not substitute 'NBD'"); the
  // `|| 'NBD'` fallbacks in warranty-cert.js and estimate-v2-ui.js:56 are the
  // same defect class and should move to this helper too.
  window._tenantFilePrefix = async function () {
    try {
      if (window._companyProfileLoaded !== true && typeof window._loadCompanyProfile === 'function') {
        await window._loadCompanyProfile();
      }
      if (window._companyProfileLoaded !== true) return '';
      if (typeof window._custIdPrefix !== 'function') return '';
      const p = String(window._custIdPrefix() || '');

      // PLATFORM-IDENTITY VETO (2026-09-06, second pass). Hydration alone is
      // not enough. `_isNbdBrand()` treats ANY tenant that never set
      // brand.legalName as NBD — a real state, documented in
      // provisioning-retry.js — so a hydrated but un-provisioned contractor
      // still resolved to the platform prefix and shipped "NBD-…" documents.
      // Decide platform identity from the AUTH KEY, not the brand doc. This is
      // the same test the server already makes in functions/render-pdf.js:302
      // (`isPlatform = String(companyId) === NBD_OWNER_UID`) under the comment
      // "Blank beats wrong"; the owner UID constant is already used client-side
      // at invoice-pipeline.js:623.
      if (p !== 'NBD') return p;
      let key = null;
      try { key = await window._resolveCompanyKey(); } catch (_) { key = null; }
      const OWNER = window.__NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
      // 'NBD' is the right answer for exactly one tenant. From any other
      // identity it is the bug, and an unprefixed filename beats a wrong brand.
      return (String(key || '') === OWNER) ? 'NBD' : '';
    } catch (_) { return ''; }
  };

  // Tenant prefix for a MINTED IDENTIFIER (certificate numbers, document
  // numbers) — as opposed to a filename.
  //
  // Same hydration + platform-identity gates as _tenantFilePrefix, but it must
  // NEVER return '': a blank prefix mints the orphan "-123456" that
  // docgen-brand.test.js:98 ("unreserved: never blank") and
  // docgen-render.test.js:181 ("no orphan Certificate #-WC-") already forbid.
  // Where a filename can safely drop the prefix, an identifier cannot.
  //
  // So the residual fallback is the neutral 'CUS' this codebase already uses
  // for an underivable non-NBD brand (document-generator.js deriveSeal, pinned
  // by tests/cust-id-prefix.test.js). Neutral beats another tenant's brand:
  // 'CUS-123456' is anonymous, 'NBD-123456' is someone else's identity on a
  // stranger's certificate.
  window._tenantIdPrefix = async function () {
    const p = await window._tenantFilePrefix();
    return p || 'CUS';
  };

  // Build a customer-facing filename carrying the tenant's prefix. `rest` must
  // be non-empty and already carry the extension: nbd-doc-viewer.js defaults a
  // blank filename to 'NBD-Document.pdf' (:614, :715), so an empty prefix must
  // never be implemented by omitting the filename.
  window._tenantFileName = async function (rest) {
    const base = String(rest || 'Document.pdf');
    const p = await window._tenantFilePrefix();
    return (p ? p + '-' : '') + base;
  };

  window._custCounterId = function (companyId) {
    const b = _resolveBrand();
    if (_isNbdBrand(b)) return 'customerIds';               // NBD → legacy shared counter (unchanged)
    return 'customerIds_' + String(companyId || window._custIdPrefix() || '').toLowerCase();
  };

  // ── Customer-ID salt (defense-in-depth against prefix collision) ──
  // The prefix registry (docPrefixes/{PREFIX}, enforced by reserveCompanyPrefix)
  // makes prefixes globally unique, which alone makes every customerId unique.
  // The salt is a SECOND layer: a short, deterministic, companyId-derived suffix
  // baked into the ID string itself, so even if a prefix reservation were somehow
  // bypassed, two tenants can never mint the same customerId (and the public
  // referral endpoint — which resolves a lead by exact customerId match — can
  // never misroute across tenants). FNV-1a/32 → base36 → 4 upper-alnum chars.
  // MUST stay byte-identical to functions/customer-id.js:custIdSalt (server mints
  // the same IDs via the backfill). NBD keeps its legacy un-salted 'NBD-####'.
  window._custIdSalt = function (companyId) {
    const s = String(companyId || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return (h >>> 0).toString(36).toUpperCase().padStart(4, '0').slice(-4);
  };
  // Canonical customer-ID formatter. Every mint site (dashboard + customer
  // bootstrap, server backfill) routes through this so the format never drifts.
  // NBD prefix → 'NBD-0001' (legacy, un-salted, NEVER changed). Any other
  // (registered) prefix → 'OAK-0001-K3P9'.
  window._formatCustomerId = function (prefix, seq, companyId) {
    const p = prefix || 'NBD';
    const base = p + '-' + String(seq).padStart(4, '0');
    return (p === 'NBD') ? base : base + '-' + window._custIdSalt(companyId);
  };

  // The RAW, un-merged tenant brand override (null for NBD / pre-auth). Lets a
  // consumer or a provisioning check see exactly which brand fields the tenant
  // has actually set, with no NBD defaults mixed in (review M1).
  window._brandOverride = function () { return _brandOverrideRaw; };
})();
