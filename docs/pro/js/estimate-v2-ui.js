// ============================================================
// NBD Pro — Estimate V2 Builder UI
//
// Full-screen modal that wires the 3-catalog linked engine to
// a working user interface:
//
//   1. Measurement inputs (left column)
//   2. Mode toggle: Per-SQ | Line-Item
//   3. Line item picker with search + category filters (middle)
//   4. Selected scope panel with live quantity recalc (right)
//   5. Running grand total at bottom
//   6. Three export buttons: Insurance Scope | Retail Quote | Internal
//
// Triggered by window.openEstimateV2Builder() from dashboard.
// Self-contained — creates its own DOM when first opened.
// ============================================================

(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // ─── Tenant identity on customer-facing estimates ────────────────────
  //
  // These were hardcoded `preparedBy: 'Joe Deal'` and `number: 'NBD-V2-' + …`.
  // Both reach paper a homeowner signs: formatEstimate() renders "Scope
  // Prepared By" into the retail quote — the paper a homeowner signs (the
  // e-sign path was a BoldSign send of that HTML until 2026-10-04) — so the
  // executed instrument named the wrong contracting party. estimate-finalization.js already HAS the correct
  // non-NBD gate; it just never fired, because `est.preparedBy` was always
  // truthy and short-circuited it.
  //
  // Same shape as email_system.js _brandFields(): resolve once, and never use
  // an NBD literal as a `||` fallback — _resolveBrand() blanks unset tenant
  // fields to '', so `x || 'Joe Deal'` re-injects the owner's identity exactly
  // where a tenant left something empty.
  function _v2Brand() {
    let b = null;
    try { if (typeof window._brand === 'function') b = window._brand() || null; } catch (e) { b = null; }
    const isNbd = !b || !b.legalName || b.legalName === 'No Big Deal Home Solutions';
    return { b: b || {}, isNbd };
  }
  function _v2PreparedBy() {
    const { isNbd } = _v2Brand();
    // NBD keeps its exact literal (byte-identical output for the owner).
    if (isNbd) return 'Joe Deal';
    // A tenant signs their own paper: the logged-in rep, else nothing. Never
    // a fallback to the owner's name.
    return (window._user && (window._user.displayName || window._user.email)) || '';
  }
  // Customer-facing tier name (GBB audit, 2026-09-09). The internal
  // good/better/best keys never change — this is display-only, for the
  // homeowner presentation mode and the retail-quote PDF, both of which a
  // customer actually reads. Single source: estimate-config.js.
  function _v2TierLabel(key) {
    const cfg = window.NBD_ESTIMATE_CONFIG;
    if (cfg && typeof cfg.tierLabel === 'function') return cfg.tierLabel(key);
    return ({ economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' })[key] || key;
  }
  // Five tiers, cheapest first (estimate-config.js TIER_ORDER, 2026-10-02).
  function _v2Tiers() {
    const cfg = window.NBD_ESTIMATE_CONFIG;
    return (cfg && Array.isArray(cfg.TIER_ORDER)) ? cfg.TIER_ORDER.slice() : ['economy', 'good', 'better', 'best', 'beyond'];
  }
  function _v2TierBtnId(t) { return 'v2tier' + t.charAt(0).toUpperCase() + t.slice(1); }
  // Catalog items currently in scope (for the shingle rules).
  function _v2ScopeItems() {
    const cat = window.NBD_XACT_CATALOG;
    if (!cat || typeof cat.find !== 'function') return [];
    return (state.scope || []).map(x => cat.find(x.code)).filter(Boolean);
  }
  // Shingle rules (Jo, 2026-10-02): Beyond is TAMKO HailGuard ONLY; Economy
  // never a 3-tab. On a switch INTO one of those tiers the scope's shingle
  // lines are swapped to the allowed one (and the rep is told), so the lock
  // can never be met by leaving a wrong shingle in place.
  // Economy also drops HailGuard (it IS the Beyond product — an Economy
  // quote listing it would contradict its own price); any other
  // architectural is Jo's pick and stays.
  const _V2_TIER_SWAP = { beyond: { to: 'RFG 240-TAMKO-HAIL', when: () => true }, economy: { to: 'RFG 240-TAMKO-HERITAGE', when: (it) => it.sub === 'shingles-3tab' || it.code === 'RFG 240-TAMKO-HAIL' } };
  function _v2EnforceTierShingles(tier) {
    const cfg = window.NBD_ESTIMATE_CONFIG;
    const swap = _V2_TIER_SWAP[tier];
    if (!swap || !cfg || typeof cfg.isShingleItem !== 'function') return 0;
    const cat = window.NBD_XACT_CATALOG;
    if (!cat || typeof cat.find !== 'function' || !cat.find(swap.to)) return 0;
    let swapped = 0;
    const seen = new Set();
    state.scope = (state.scope || []).map(x => {
      const it = cat.find(x.code);
      if (!it || !cfg.isShingleItem(it) || it.code === swap.to || !swap.when(it)) return x;
      swapped++;
      return Object.assign({}, x, { code: swap.to });
    }).filter(x => { if (seen.has(x.code)) return false; seen.add(x.code); return true; });
    if (swapped && typeof window.showToast === 'function') {
      window.showToast(tier === 'beyond'
        ? 'Beyond is TAMKO HailGuard only — the shingle line was switched to HailGuard.'
        : 'Economy never uses a 3-tab — the shingle line was switched to TAMKO Heritage.', 'info');
    }
    return swapped;
  }
  // Tier-appropriateness signal (GBB backlog, 2026-09-17). Every catalog
  // entry in estimate-catalog-xactimate.js already self-declares a tier
  // (good/better/best/any) but nothing in the real add-to-scope path ever
  // compared it against the job's own state.tier — a rep could add ANY
  // item to a job of ANY tier with zero feedback, which is exactly the
  // "tier at random" complaint the GBB source-of-truth fix (PR #1615) only
  // half-solved (that fix pointed the PRINTED tier at the real estimate;
  // it did nothing about the MATERIALS under it). 'any' items (underlayment,
  // flashing, permits, etc.) are tier-neutral by design and never flag.
  // Internal, rep-only labels here — _v2TierLabel() above is the CUSTOMER-
  // facing name and would be a confusing mismatch against the raw
  // good/better/best language the tier picker itself uses.
  function _v2TierMismatch(itemTier) {
    const cfg = window.NBD_ESTIMATE_CONFIG;
    const jobTier = (cfg && typeof cfg.productTier === 'function') ? cfg.productTier(state.tier) : state.tier;
    return !!itemTier && itemTier !== 'any' && itemTier !== jobTier;
  }
  function _v2TierBadgeHtml(itemTier) {
    if (!itemTier || itemTier === 'any') return '';
    const mismatch = _v2TierMismatch(itemTier);
    const cls = 'tier-pill' + (mismatch ? ' mismatch' : '');
    const title = mismatch ? ' title="This job is priced ' + state.tier + ' tier"' : '';
    return '<span class="' + cls + '"' + title + '>' + itemTier + '</span>';
  }
  // ASYNC since 2026-09-06. The old comment here claimed _custIdPrefix()
  // "already returns 'NBD' for the platform tenant and a derived prefix for
  // everyone else" — true only AFTER company-profile hydration. Read
  // synchronously it answers 'NBD' for EVERY tenant, so this estimate number
  // went out NBD-branded on another contractor's document. The resolver gates
  // on hydration and on platform identity, and never returns blank: a minted
  // identifier cannot carry an orphan leading dash.
  // Await company-profile hydration once, so the SYNCHRONOUS formatters in
  // estimate-finalization.js read a real tenant brand rather than the NBD
  // defaults company-profile.js:276 seeds at parse time. Never blocks the rep:
  // a hydration failure falls through and renders with whatever brand exists.
  async function _awaitBrandHydration() {
    try {
      if (window._companyProfileLoaded !== true && typeof window._loadCompanyProfile === 'function') {
        await window._loadCompanyProfile();
      }
    } catch (_) { /* render with what we have */ }
  }

  async function _v2EstNumber(suffix) {
    const prefix = window._tenantIdPrefix ? await window._tenantIdPrefix() : 'CUS';
    return prefix + '-V2-' + suffix;
  }

  // Session state
  const state = {
    mode: 'line-item',        // 'line-item' | 'per-sq'
    tier: 'better',
    jobMode: 'insurance',     // 'insurance' | 'cash'
    // Neutral default (first-run audit 2026-07-28): '' = "Other / My county".
    // The engines already fail safe on a blank county (DEFAULT_PERMIT_COST
    // $150 + 7% fallback tax), so a tenant outside the 7 listed OH/KY
    // counties never gets silently taxed/permitted as Hamilton County, OH.
    county: '',
    measurements: {
      rawSqft: 0, pitch: 6, waste: 1.15,   // default 6/12 (non-steep) so the steep adder is opt-in, not auto-applied
      ridgeLf: 0, eaveLf: 0, rakeLf: 0, hipLf: 0, valleyLf: 0, wallLf: 0,
      pipes: 0, chimneys: 0, skylights: 0, stories: 1,
      tearOffLayers: 1, deckReplacePct: 0.15, cutUpRoof: false,
      // Wave 143: per-SQ mode add-ons. The engine
      // (estimate-builder-v2.js calculatePerSq) reads these directly.
      // hasChimneyFlash / hasSkylightFlash gate the $425/$350
      // flat add-ons (config-locked); valleyMetalLf and guttersLf
      // multiply by $8.50/LF. Previously had no UI controls so the
      // rep couldn't enable them in per-SQ mode at all.
      hasChimneyFlash: false,
      hasSkylightFlash: false,
      valleyMetalLf: 0,
      guttersLf: 0,
      accessLevel: 'standard'   // 'standard' | 'moderate' | 'difficult' (per-SQ access tier)
    },
    scope: [],                // Array of { code, overrides } entries
    // Photo embeds: photos SELECTED to ride this estimate ({id, url}),
    // rendered in presentation mode, the doc formats, the preview sheet,
    // and the homeowner share view. _leadPhotos is the pick-from cache
    // (the linked lead's photo docs), loaded lazily per open.
    photos: [],
    _leadPhotos: null,
    customer: { name: '', address: '', phone: '', email: '' },
    // deductible null = not entered (2026-09-25). It was a $2,500
    // placeholder; once the deposit rule made the deductible the insurance
    // deposit, that placeholder would have printed "Your $2,500 deductible is
    // due at signing" on a homeowner's quote nobody had entered a deductible
    // for. Unset, the paperwork says the deductible is due without a number
    // and the builder warns the rep.
    claim: { carrier: '', number: '', adjuster: '', dateOfLoss: '', deductible: null, acv: null, recoverableDepreciation: null, policyNumber: '' },
    searchFilter: '',
    categoryFilter: 'all',
    // Per-job minimum-charge floor. null means "use engine default"
    // ($2500). Presets can override this — e.g. Shingle Patch sets
    // it to $500 so tiny jobs don't get bumped to the full-job floor.
    minJobCharge: null,
    // Pass-through line items appended to the final estimate after
    // the engine runs. Used for things the catalog can't express:
    // aerial measurement reports, e-sign fees, etc. Each entry is
    // { code, desc, amount, source }. Rendered as a removable chip
    // in the scope pane and included verbatim in the retail quote.
    passThru: [],
    // Upgrades & Add-ons rows (stage 2, 2026-09-25): the homeowner's picks
    // from a Job Template estimate, restored from the saved doc's
    // `upgrade: true` rows. Like passThru they are added AFTER the engine at
    // face value (their frozen quoted price), but they are also TAXED — see
    // _applyUpgradeLines. Each entry is the saved row itself.
    upgrades: [],
    // The saved offered / chosen / declined record, carried so a re-save
    // (or a second "Save Again?" doc) keeps it. Never edited here.
    upgradeLog: null,
    // 3B — reopen: when a saved V2 estimate is reopened, the raw doc is
    // stashed here so doc regeneration can faithfully REPLAY the saved
    // numbers (honoring the persisted materialMarkupPct → B-8 retail) instead
    // of re-resolving. _reopenedClean flips false on the first edit, after
    // which we fall back to a live re-resolve.
    _reopenedDoc: null,
    _reopenedClean: false,
    // A Job Template estimate's job type, kept from the saved doc it was
    // reopened from (_jobTypeFieldsOf) — null for every V2-built estimate.
    // Rides every estimate this builder renders or saves, so its paperwork
    // prints the JOB TYPE's workmanship warranty, not roofing's lifetime one.
    jobType: null,
    // Roof Care Plan (2026-10-05): what kind of work this estimate is —
    // 'repair' | 'replacement' | null (not said). The member discount
    // (care-plan-discount.js) applies only to 'repair'. Set by the repair /
    // replacement presets, the V3 Repair-or-roof choice, Job Template
    // inserts, and the rep's "This is repair work" button; saved and reopened.
    workKind: null
  };

  // The per-estimate half of `state` as it stands at page load — what "a new
  // estimate" means. Captured once so _resetEstimateState() can never drift
  // from the literal above.
  const _FRESH_ESTIMATE = JSON.stringify({
    mode: state.mode, tier: state.tier, jobMode: state.jobMode, county: state.county,
    measurements: state.measurements, scope: state.scope, photos: state.photos,
    customer: state.customer, claim: state.claim, passThru: state.passThru,
    minJobCharge: state.minJobCharge, jobType: state.jobType, workKind: state.workKind,
    upgrades: state.upgrades, upgradeLog: state.upgradeLog,
  });

  // ── Job Template estimates reopened here (review 2026-09-25) ───────
  // "Open in Estimate Builder" is the Job Templates success step's primary
  // button, so template gutter, repair and inspection estimates get edited
  // and re-printed HERE — and this builder's Retail / Single Quote and server
  // PDF printed a LIFETIME workmanship warranty and tier text on all of them,
  // because the saved job type never reached the formatter. These are the
  // fields NBDCustomerEstimateRows.estimateWarranty() reads; they are copied
  // off the saved doc, carried on every estimate this builder produces, and
  // re-saved with it. null when the doc is not a Job Template estimate.
  const _JOB_TYPE_KEYS = ['sourceTemplates', 'tierApplies', 'warrantyKind', 'warrantyParts', 'repairWarranty'];
  function _jobTypeFieldsOf(doc) {
    if (!doc) return null;
    const out = {};
    if (doc.builder === 'template') out.builder = 'template';
    _JOB_TYPE_KEYS.forEach((k) => {
      if (doc[k] !== undefined && doc[k] !== null) out[k] = JSON.parse(JSON.stringify(doc[k]));
    });
    return Object.keys(out).length ? out : null;
  }
  // ── Upgrades & Add-ons rows (stage 2, 2026-09-25) ───────────────────
  // A Job Template estimate can carry the homeowner's upgrades: face-value
  // retail rows tagged `upgrade: true` (upgrade-pricing.js price()), added
  // AFTER the engine. Reopened here they used to land in the catalog scope,
  // and the first edit dropped them — getCurrentEstimate re-resolves scope
  // codes through the catalog, which has no "UPG …" code — so the next save
  // silently lost a line the homeowner signed for and understated the total.
  // Now they live in state.upgrades and _applyUpgradeLines re-adds them.
  const _UPGRADE_TAG_KEYS = ['upgradeId', 'upgradeGroup', 'upgradeVersion', 'upgradeCents',
    'upgradeWarranty', 'upgradeNotCovered', 'upgradeInstaller', 'upgradeRequired'];
  function _isUpgradeRow(r) {
    return !!r && (r.upgrade === true || /^UPG /.test(String(r.code || '').trim().toUpperCase()));
  }
  // The frozen quoted price in exact cents: the row's own upgradeCents, else
  // its retail total (a row is never re-priced from today's library).
  function _upgradeRowCents(r) {
    if (r && Number.isSafeInteger(r.upgradeCents) && r.upgradeCents >= 0) return r.upgradeCents;
    const t = Number(r && (r.retailTotal != null ? r.retailTotal : r.total));
    return Number.isFinite(t) && t > 0 ? Math.round(t * 100) : 0;
  }
  // The upgrade tag a saved row must keep, so the NEXT reopen still knows it
  // is an upgrade. null, never undefined (Firestore rejects undefined).
  function _upgradeTagsOf(src) {
    if (!src || src.upgrade !== true) return {};
    const out = { upgrade: true };
    _UPGRADE_TAG_KEYS.forEach((k) => { out[k] = (src[k] === undefined) ? null : src[k]; });
    out.upgradeCents = _upgradeRowCents(src);
    return out;
  }

  // The id of the SAVED estimate `state` holds (set by rehydrateFromSaved),
  // or null while it holds a new, unsaved one.
  let _stateFromSavedDoc = null;

  // ═════════════════════════════════════════════════════════
  // Modal HTML (created lazily on first open)
  // ═════════════════════════════════════════════════════════

  // Per-tenant custom jurisdictions → extra #v2county options (county-
  // jurisdiction settings, 2026-07-29). Built from window._companyProfile at
  // modal-mount time — mounting is user-initiated, so the profile is hydrated
  // by then on all three estimate pages (dashboard, legacy, customer.html).
  // Jurisdiction names are tenant-entered text: HTML-escape them (stored-XSS
  // render-safety rule). Appended AFTER the 7 static option literals so the
  // smoke pins on the static head keep matching.
  function _tenantCountyOptions() {
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    const cj = (window._companyProfile
      && window._companyProfile.pricing
      && window._companyProfile.pricing.customJurisdictions) || null;
    if (!cj || typeof cj !== 'object') return '';
    return Object.keys(cj)
      .filter(slug => slug && cj[slug] && typeof cj[slug].name === 'string' && cj[slug].name.trim())
      .map(slug => `<option data-tenant-option value="${esc(slug)}">${esc(cj[slug].name.trim())}</option>`)
      .join('');
  }

  // The modal template is baked once per page life (ensureModal early-returns
  // once #estV2Modal exists), so the tenant tail of #v2county must refresh on
  // every open: a jurisdiction added in Settings mid-session — or a
  // companyProfile that hydrated after first mount — must be selectable
  // without a reload. Injected options carry data-tenant-option so the 8
  // static options are never touched (smoke pins on the static head).
  function _refreshTenantCountyOptions() {
    const sel = document.getElementById('v2county');
    if (!sel) return;
    sel.querySelectorAll('option[data-tenant-option]').forEach(o => o.remove());
    const html = _tenantCountyOptions();
    if (html) sel.insertAdjacentHTML('beforeend', html);
  }

  function ensureModal() {
    if (document.getElementById('estV2Modal')) return;

    const modal = document.createElement('div');
    modal.id = 'estV2Modal';
    modal.innerHTML = `
      <style>
      #estV2Modal {
        position:fixed; inset:0; z-index:var(--z-overlay,10000);
        background:rgba(10,12,15,0.95);
        display:none; overflow:hidden;
        font-family:'Barlow','Helvetica Neue',sans-serif;
        /* Safe-area insets so the header isn't clipped under the notch
           and the footer isn't clipped by the home indicator. */
        padding-top: env(safe-area-inset-top, 0);
        padding-bottom: env(safe-area-inset-bottom, 0);
        padding-left: env(safe-area-inset-left, 0);
        padding-right: env(safe-area-inset-right, 0);
      }
      #estV2Modal.open { display:flex; flex-direction:column; }
      .v2-hdr {
        background:var(--s,#111418); border-bottom:2px solid var(--orange,#BD5728);
        padding:12px 20px;
        display:flex; justify-content:space-between; align-items:center;
        flex-shrink:0;
        gap:12px;
      }
      .v2-title {
        font-family:'Barlow Condensed',sans-serif; font-size:22px;
        font-weight:800; color:var(--t,#fff); text-transform:uppercase;
        letter-spacing:.06em;
      }
      .v2-title .pro { color:var(--orange,#BD5728); }
      .v2-beta {
        font-size:9px; background:var(--orange,#BD5728); color:var(--accent-fg,#fff);
        padding:2px 8px; border-radius:2px; letter-spacing:.15em;
        margin-left:10px;
      }
      /* Close button: iOS HIG minimum 44x44 tap target, clearly
         visible, orange-filled on mobile so it's impossible to miss. */
      .v2-close {
        background:var(--orange,#BD5728); border:1px solid var(--orange,#BD5728); color:var(--accent-fg,#fff);
        padding:10px 18px; cursor:pointer; font-weight:700;
        border-radius:6px; font-size:13px;
        min-height:44px; min-width:44px;
        display:inline-flex; align-items:center; justify-content:center;
        flex-shrink:0;
        font-family:inherit;
        letter-spacing:.04em;
        transition:background var(--t-mid,.18s), transform var(--t-fast,.12s);
        -webkit-tap-highlight-color:transparent;
        touch-action:manipulation;
      }
      .v2-close:hover { background:var(--ob,#ff8420); border-color:var(--ob,#ff8420); }
      .v2-close:active { transform:scale(.95); }
      .v2-body {
        flex:1; display:grid;
        grid-template-columns:280px 1fr 360px;
        gap:0; overflow:hidden;
        min-height:0;
      }
      .v2-pane {
        background:var(--s2,#181c22); border-right:1px solid var(--br,#2a2f35);
        padding:16px; overflow-y:auto; color:var(--t,#e8eaf0);
        min-height:0;
      }
      .v2-pane.right { border-right:none; border-left:1px solid var(--br,#2a2f35); background:var(--s,#111418); }

      /* ── Mobile responsive ── Stack the 3 panes vertically
         under 1000px so the modal stays usable on tablets in
         portrait, small laptops, and phones. */
      @media (max-width: 1000px) {
        .v2-body {
          grid-template-columns: 1fr;
          grid-template-rows: auto 1fr auto;
          overflow-y: auto;
        }
        .v2-pane {
          border-right: none;
          border-bottom: 1px solid var(--br,#2a2f35);
          max-height: none;
        }
        .v2-pane.right {
          border-left: none;
          border-top: 1px solid var(--br,#2a2f35);
        }
      }
      @media (max-width: 600px) {
        .v2-hdr { padding: 10px 14px; }
        .v2-title { font-size: 16px !important; }
        .v2-title + .v2-title { margin-left: 10px !important; }
        .v2-pane { padding: 12px; }
        /* Keep the 44×44 tap target on mobile — only trim label
           length if the header runs tight. */
        .v2-close { padding: 10px 14px; font-size: 12px; min-height:44px; }
        .v2-total-val { font-size: 32px !important; }
      }
      /* Extra-small phones (iPhone SE, 320px): stack header vertically
         to avoid crowding the close button against the title. */
      @media (max-width: 380px) {
        .v2-hdr { flex-wrap: wrap; padding: 8px 12px; gap: 8px; }
        .v2-title { font-size: 14px !important; }
        .v2-title + .v2-title { margin-left: 8px !important; }
        .v2-close { width: 100%; }
      }

      /* ── Phase 1b: mobile step navigation ──
         Under 1000px the stacked-panes scroll becomes three STEPS driven
         by data-mstep on the modal root, with a fixed bottom bar (step
         tabs + live total). No data-mstep attr (desktop) shows all panes
         — these rules only bite inside the media query. */
      .v2-mstep-bar { display:none; }
      @media (max-width: 1000px) {
        .v2-body { padding-bottom: 62px; }
        .v2-mstep-bar {
          display:flex; position:absolute; left:0; right:0; bottom:0;
          align-items:center; gap:6px; z-index:6;
          background:var(--s,#111418); border-top:2px solid var(--orange,#BD5728);
          padding:8px 10px calc(8px + env(safe-area-inset-bottom, 0));
        }
        .v2-mstep-btn {
          flex:1; min-height:44px; border-radius:8px; cursor:pointer;
          background:var(--s2,#181c22); border:1px solid var(--br,#2a2f35);
          color:var(--m,#98a0ab); font-family:'Barlow Condensed',sans-serif;
          font-size:13px; font-weight:700; letter-spacing:.05em; text-transform:uppercase;
          -webkit-tap-highlight-color:transparent; touch-action:manipulation;
        }
        .v2-mstep-btn.active {
          background:var(--orange,#BD5728); border-color:var(--orange,#BD5728);
          color:var(--accent-fg,#fff);
        }
        .v2-mstep-total {
          background:none; border:none; cursor:pointer; flex:none;
          font-family:'Barlow Condensed',sans-serif; font-size:19px; font-weight:800;
          color:var(--green,#2ecc8a); padding:0 6px; white-space:nowrap;
          -webkit-tap-highlight-color:transparent;
        }
        #estV2Modal[data-mstep="1"] .pane-items,
        #estV2Modal[data-mstep="1"] .pane-review { display:none; }
        #estV2Modal[data-mstep="2"] .pane-setup,
        #estV2Modal[data-mstep="2"] .pane-review { display:none; }
        #estV2Modal[data-mstep="3"] .pane-setup,
        #estV2Modal[data-mstep="3"] .pane-items { display:none; }
        /* Phone audit 2026-09-25 (estimate#12): with two of the three panes
           hidden, the stacked-panes grid above (rows auto 1fr auto) put the
           one visible pane in an AUTO row, so it only took its content height
           and the rest of the screen was the 0.95 overlay — the dashboard
           ("HOT LEADS", the win-rate ring) showed through under a short Setup
           or Review step. One row that fills the body, and the pane scrolls
           itself; the opaque body is belt-and-braces for any gap. */
        #estV2Modal[data-mstep] .v2-body {
          grid-template-rows: minmax(0, 1fr);
          background: var(--bg,#0a0c0f);
        }
      }

      /* ── Phase 3: homeowner presentation mode ──
         Fullscreen overlay INSIDE the modal (so the existing delegated
         data-action handler covers its buttons). Homeowner-clean: big
         tier cards, no margins/costs/internal numbers anywhere. */
      .v2-present {
        position:absolute; inset:0; z-index:30; display:none;
        flex-direction:column; overflow-y:auto;
        background:var(--bg,#0b0d10);
        padding-top: env(safe-area-inset-top, 0);
      }
      .v2-present.open { display:flex; }
      .vp-hdr { padding:20px 22px 4px; flex:none; }
      .vp-name {
        font-family:'Barlow Condensed',sans-serif; font-size:26px; font-weight:800;
        color:var(--t,#fff); text-transform:uppercase; letter-spacing:.04em; line-height:1.1;
      }
      .vp-addr { font-size:13px; color:var(--m,#98a0ab); margin-top:4px; }
      .vp-cards {
        display:grid; gap:12px; padding:18px 22px;
        grid-template-columns:repeat(auto-fit, minmax(190px, 1fr));
        align-items:stretch;
      }
      .vp-card {
        border:2px solid var(--br,#2a2f35); border-radius:14px; padding:20px 14px;
        background:var(--s2,#181c22); text-align:center; cursor:pointer;
        font-family:inherit; color:var(--t,#e8eaf0);
        -webkit-tap-highlight-color:transparent; touch-action:manipulation;
      }
      .vp-card.active { border-color:var(--green,#2ecc8a); box-shadow:0 0 0 1px var(--green,#2ecc8a); }
      .vp-tier {
        font-family:'Barlow Condensed',sans-serif; font-size:15px; font-weight:800;
        text-transform:uppercase; letter-spacing:.12em; color:var(--m,#98a0ab);
      }
      .vp-card.active .vp-tier { color:var(--green,#2ecc8a); }
      .vp-price {
        font-family:'Barlow Condensed',sans-serif; font-size:34px; font-weight:800;
        color:var(--t,#fff); margin:8px 0 4px;
      }
      .vp-blurb { font-size:11px; color:var(--m,#98a0ab); line-height:1.5; }
      .vp-pick {
        margin-top:12px; font-size:10px; font-weight:700; letter-spacing:.1em;
        text-transform:uppercase; color:var(--m,#98a0ab);
      }
      .vp-card.active .vp-pick { color:var(--green,#2ecc8a); }
      .vp-foot {
        margin-top:auto; flex:none; display:flex; gap:10px;
        padding:14px 22px calc(16px + env(safe-area-inset-bottom, 0));
        border-top:1px solid var(--br,#2a2f35); background:var(--s,#111418);
        align-items:center;
      }
      .vp-total {
        font-family:'Barlow Condensed',sans-serif; font-size:26px; font-weight:800;
        color:var(--green,#2ecc8a); white-space:nowrap; padding-right:6px;
      }
      .vp-sign {
        flex:1; min-height:48px; border-radius:10px; border:none; cursor:pointer;
        background:var(--orange,#BD5728); color:var(--accent-fg,#fff);
        font-family:'Barlow Condensed',sans-serif; font-size:16px; font-weight:800;
        letter-spacing:.06em; text-transform:uppercase;
      }
      .vp-done {
        flex:none; min-height:48px; padding:0 18px; border-radius:10px; cursor:pointer;
        background:none; border:1px solid var(--br,#2a2f35); color:var(--m,#98a0ab);
        font-family:'Barlow Condensed',sans-serif; font-size:13px; font-weight:700;
        letter-spacing:.06em; text-transform:uppercase;
      }
      .v2-section {
        font-family:'Barlow Condensed',sans-serif; font-size:11px;
        font-weight:700; text-transform:uppercase; letter-spacing:.15em;
        color:var(--orange,#BD5728); margin:16px 0 8px; padding:6px 8px 6px 4px;
        border-bottom:1px solid var(--br,#2a2f35);
        cursor:pointer; user-select:none;
        display:flex; align-items:center; justify-content:space-between;
        -webkit-tap-highlight-color:transparent; touch-action:manipulation;
        min-height:32px;
      }
      .v2-section:first-child { margin-top:0; }
      .v2-section::after {
        content:'−';
        font-size:16px; line-height:1; color:var(--orange,#BD5728);
        margin-left:8px; transition:transform var(--t-fast,.12s);
      }
      .v2-section.collapsed::after { content:'+'; }
      .v2-section-content {
        overflow:hidden;
        transition:max-height var(--t-mid,.18s) ease, opacity var(--t-mid,.18s) ease, margin var(--t-mid,.18s) ease;
        max-height:5000px; /* large enough for any content */
        opacity:1;
      }
      .v2-section.collapsed + .v2-section-content {
        max-height:0 !important;
        opacity:0;
        margin:0 !important;
        pointer-events:none;
      }
      /* Phone audit 2026-09-25 (estimate#2): the headers that stay collapsed
         on a phone are still the only way into their section — 32px was
         under the 40px touch floor the scope-row buttons use (Wave 28). */
      @media (pointer:coarse) {
        .v2-section { min-height:40px; }
      }

      /* On small screens: make the panes flex so collapsed sections let
         the open one breathe. Each pane scrolls independently, so the
         items list can fill the entire middle pane when the measurements
         + scope sections are collapsed. */
      @media (max-width: 1000px) {
        #estV2Modal.open .v2-body { min-height:0; }
        .v2-pane { display:flex; flex-direction:column; }
        .v2-pane > .v2-section-content { flex:0 0 auto; }
        /* The catalog list is the one content area that must always
           be free to grow, so give it flex:1 inside its pane. */
        .v2-pane #v2items { flex:1 1 auto; min-height:200px; }
      }
      .v2-field { margin-bottom:10px; }
      .v2-field label {
        display:block; font-size:9px; text-transform:uppercase;
        letter-spacing:.1em; color:var(--m,#888); margin-bottom:3px;
      }
      .v2-field input, .v2-field select {
        width:100%; background:var(--bg,#0a0c0f); border:1px solid var(--br,#2a2f35);
        color:var(--t,#e8eaf0); padding:8px 10px; border-radius:3px;
        font-size:13px; font-family:inherit;
      }
      .v2-field input:focus, .v2-field select:focus {
        outline:none; border-color:var(--orange,#BD5728);
      }
      .v2-field.inline {
        display:flex; align-items:center; gap:8px;
      }
      .v2-field.inline label {
        margin-bottom:0; flex:1;
      }
      .v2-field.inline input[type=checkbox] {
        width:auto;
      }
      /* Phone audit 2026-09-25 (estimate#3): the three price-adder checkboxes
         (Cut-up Roof, Chimney +$425, Skylight +$350) were a bare <label>
         beside a 13x13 box — no for=, not wrapping it — so tapping the text
         did nothing and the only target was the box at the far right edge.
         The whole row is the <label> now (.v2-check), so any tap on it
         toggles; the text span keeps the field-label look. */
      .v2-check { cursor:pointer; -webkit-tap-highlight-color:transparent; }
      .v2-check > span {
        flex:1; font-size:9px; text-transform:uppercase;
        letter-spacing:.1em; color:var(--m,#888);
      }
      /* estimate#4: an empty measurement field showed a grey "3900" / "120"
         that read like a value already entered. The hints now say "e.g.";
         italic makes an unfilled field obviously unfilled at a glance. */
      #estV2Modal .v2-field input::placeholder { font-style:italic; }
      @media (max-width: 1000px) {
        /* estimate#4: 9px uppercase labels are the only thing telling a rep
           which box is Eave vs Rake vs Ridge on a phone. */
        .v2-field label, .v2-check > span { font-size:12px; letter-spacing:.06em; }
      }
      @media (pointer:coarse) {
        .v2-check { min-height:44px; margin-bottom:4px; }
        .v2-field.inline.v2-check input[type=checkbox] {
          width:22px; height:22px; flex:none; margin:0;
          accent-color:var(--orange,#BD5728);
        }
      }
      .v2-tabs {
        display:flex; gap:0; margin-bottom:12px;
        border:1px solid var(--br,#2a2f35); border-radius:4px; overflow:hidden;
      }
      .v2-tabs button {
        flex:1; background:var(--bg,#0a0c0f); border:none; color:var(--m,#888);
        padding:10px; font-size:11px; font-weight:700;
        letter-spacing:.1em; text-transform:uppercase; cursor:pointer;
        font-family:inherit;
      }
      .v2-tabs button.active {
        background:var(--orange,#BD5728); color:var(--accent-fg,#fff);
      }
      /* Five tiers in one row (2026-10-02): tighter padding + tracking so
         "ECONOMY" fits a 320px phone; 44px tall for a thumb. */
      #v2tierTabs button { padding:10px 2px; letter-spacing:.03em; min-height:44px; min-width:0; }
      .v2-cat-tabs {
        display:flex; gap:4px; margin-bottom:10px; flex-wrap:wrap;
      }
      .v2-cat-tabs button {
        background:var(--bg,#0a0c0f); border:1px solid var(--br,#2a2f35); color:var(--m,#888);
        padding:4px 9px; font-size:10px; cursor:pointer; border-radius:3px;
        font-family:inherit;
      }
      .v2-cat-tabs button.active {
        background:var(--orange,#BD5728); color:var(--accent-fg,#fff); border-color:var(--orange,#BD5728);
      }
      /* Phone audit 2026-09-25 (estimate#5): the category chips are the only
         filter besides search on a 278-item catalog, and they were 22px tall
         with 10px text, wrapping into 3-4 rows above the list. On touch they
         get the 40px floor and ONE sideways-scrolling row, so a bigger target
         doesn't cost the list four rows of height. */
      @media (pointer:coarse) {
        .v2-cat-tabs {
          flex-wrap:nowrap; overflow-x:auto; gap:6px;
          overscroll-behavior-x:contain; scrollbar-width:none;
          -webkit-overflow-scrolling:touch;
        }
        .v2-cat-tabs::-webkit-scrollbar { display:none; }
        .v2-cat-tabs button {
          flex:none; min-height:40px; padding:6px 14px; font-size:13px;
          border-radius:20px; white-space:nowrap;
          -webkit-tap-highlight-color:transparent; touch-action:manipulation;
        }
      }
      .v2-search {
        width:100%; background:var(--bg,#0a0c0f); border:1px solid var(--br,#2a2f35);
        color:var(--t,#e8eaf0); padding:10px 12px; border-radius:4px;
        font-size:13px; margin-bottom:10px; font-family:inherit;
      }
      .v2-item-list {
        display:flex; flex-direction:column; gap:4px;
      }
      .v2-item {
        background:var(--bg,#0a0c0f); border:1px solid var(--br,#2a2f35);
        padding:10px 12px; border-radius:3px; cursor:pointer;
        display:flex; justify-content:space-between; align-items:flex-start;
        transition:border-color var(--t-fast,.12s), transform var(--t-fast,.12s), background var(--t-fast,.12s);
      }
      .v2-item:hover {
        border-color:var(--orange,#BD5728); transform:translateX(2px);
      }
      .v2-item .code {
        font-family:'Barlow Condensed',sans-serif; font-size:10px;
        color:var(--orange,#BD5728); font-weight:700; letter-spacing:.05em;
      }
      .v2-item .name { font-size:12px; color:var(--t,#e8eaf0); margin-top:2px; }
      .v2-item .cost {
        font-size:11px; color:var(--m,#888); text-align:right;
        font-variant-numeric:tabular-nums; flex-shrink:0; margin-left:12px;
      }
      .v2-item .add-btn {
        background:var(--orange,#BD5728); border:none; color:var(--accent-fg,#fff);
        padding:4px 10px; font-size:10px; font-weight:700;
        cursor:pointer; border-radius:3px; letter-spacing:.05em;
      }
      /* Tier badge — every catalog item's own good/better/best/any grade,
         rendered wherever the item appears (browse, ✓ Selected, scope
         review) so a rep can see tier at a glance instead of guessing. */
      .tier-pill {
        display:inline-block; font-size:8px; font-weight:700; letter-spacing:.06em;
        text-transform:uppercase; padding:1px 5px; border-radius:3px;
        color:var(--m,#888); border:1px solid var(--br,#2a2f35); vertical-align:middle;
      }
      .tier-pill.mismatch {
        color:var(--orange,#BD5728); border-color:var(--orange,#BD5728);
      }
      .tier-warn {
        color:var(--orange,#BD5728); font-size:10px; margin-top:3px; clear:both;
      }
      .v2-scope-item {
        background:var(--bg,#0a0c0f); border-left:3px solid var(--orange,#BD5728);
        padding:10px 12px; margin-bottom:6px; border-radius:3px;
        font-size:12px;
      }
      .v2-scope-item.overridden { border-left-color:var(--blue,#22d3ee); }
      .v2-scope-item .name { color:var(--t,#e8eaf0); font-weight:600; }
      .v2-scope-item .qty {
        color:var(--m,#888); font-size:10px; margin-top:2px;
        font-variant-numeric:tabular-nums;
      }
      .v2-scope-item.overridden .qty { color:var(--blue,#22d3ee); }
      .v2-scope-item .total {
        color:var(--orange,#BD5728); font-weight:700; font-size:13px; float:right;
        font-variant-numeric:tabular-nums;
      }
      .v2-scope-item .actions {
        float:right; display:flex; gap:4px; margin-left:8px;
      }
      /* An upgrade row (stage 2, 2026-09-25) has only ×: two empty
         placeholders keep its price in the same column as every other row. */
      .v2-scope-item .v2-act-ph { visibility:hidden; pointer-events:none; }
      /* Upgrades out of the price (insurance, per-SQ, empty scope) — review
         of #1763, 2026-09-25: said here instead of dropped silently. */
      .v2-upg-off { margin:0 0 8px; padding:8px 10px; border:1px solid var(--gold,#eab308); border-radius:8px;
        font-size:12px; line-height:1.4; color:var(--t,#e8eaf0); background:color-mix(in srgb, var(--gold,#eab308) 12%, transparent); }
      /* .edit-note joined these rules 2026-09-25 (phone audit estimate#6): the
         📝 button was added later with NO rule at all, so it rendered as a
         bare browser-default grey chip, 22px wide on a phone. */
      .v2-scope-item .rm,
      .v2-scope-item .edit-qty,
      .v2-scope-item .edit-note {
        background:none; border:none; color:var(--m,#666); cursor:pointer;
        font-size:14px; padding:2px 6px; border-radius:3px;
        min-width:28px; min-height:28px;
        display:inline-flex; align-items:center; justify-content:center;
        transition:color var(--t-fast,.12s), background var(--t-fast,.12s);
      }
      /* Wave 28: bump touch targets to 40px on coarse pointers (touch
         screens) so fat-fingering doesn't accidentally hit the wrong
         scope-item action. Hover/desktop keeps the compact 28px size. */
      @media (pointer:coarse) {
        .v2-scope-item .rm,
        .v2-scope-item .edit-qty,
        .v2-scope-item .edit-note { min-width:40px; min-height:40px; }
        /* The destructive × sat 4px from ✎; give it its own space. */
        .v2-scope-item .rm { margin-left:10px; }
      }
      /* Inline per-row editor (estimate#6) — replaces window.prompt(), which
         gave Android a full text keyboard for a quantity and is unreliable in
         the installed PWA. Quantity uses inputmode=decimal (number pad). */
      .v2-row-edit {
        clear:both; margin-top:8px; padding-top:8px;
        border-top:1px dashed var(--br,#2a2f35);
      }
      .v2-row-edit-lbl {
        display:block; font-size:11px; color:var(--m,#888); margin-bottom:6px;
      }
      .v2-row-edit-ctl { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
      .v2-row-edit-ctl input {
        flex:1 1 120px; min-width:0; min-height:40px; font-size:16px;
        background:var(--s2,#181c22); color:var(--t,#e8eaf0);
        border:1px solid var(--orange,#BD5728); border-radius:6px; padding:6px 10px;
        font-family:inherit;
      }
      .v2-row-edit-ctl button {
        min-height:40px; padding:0 12px; border-radius:6px; cursor:pointer;
        background:var(--bg,#0a0c0f); border:1px solid var(--br,#2a2f35); color:var(--t,#e8eaf0);
        font-family:'Barlow Condensed',sans-serif; font-size:13px; font-weight:700;
        letter-spacing:.05em; text-transform:uppercase;
        -webkit-tap-highlight-color:transparent; touch-action:manipulation;
      }
      .v2-row-edit-ctl button.primary {
        background:var(--orange,#BD5728); border-color:var(--orange,#BD5728); color:var(--accent-fg,#fff);
      }
      .v2-row-edit-err { color:var(--red,#c53030); font-size:11px; margin-top:6px; }
      /* Undo bar for a removed scope line (estimate#6). Lives INSIDE the modal
         (the delegated data-action handler covers it; the host page's toast
         stack differs per page). Local z-index, above the step bar (6). */
      .v2-undo {
        position:absolute; z-index:7; left:10px; right:10px; margin:0 auto;
        bottom:16px; max-width:440px;
        display:none; align-items:center; gap:10px;
        background:var(--s,#111418); border:1px solid var(--orange,#BD5728);
        border-radius:10px; padding:6px 6px 6px 14px;
        box-shadow:0 6px 20px rgba(0,0,0,.35);
        color:var(--t,#e8eaf0); font-size:13px;
      }
      .v2-undo.show { display:flex; }
      .v2-undo-msg { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .v2-undo button {
        flex:none; min-height:40px; padding:0 16px; border-radius:8px; cursor:pointer;
        background:var(--orange,#BD5728); border:none; color:var(--accent-fg,#fff);
        font-family:'Barlow Condensed',sans-serif; font-size:14px; font-weight:800;
        letter-spacing:.06em; text-transform:uppercase;
        -webkit-tap-highlight-color:transparent; touch-action:manipulation;
      }
      @media (max-width: 1000px) {
        .v2-undo { bottom:calc(72px + env(safe-area-inset-bottom, 0)); }
      }
      .v2-scope-item .edit-qty { font-size:12px; }
      .v2-scope-item .edit-qty:hover { color:var(--blue,#22d3ee); background:color-mix(in srgb, var(--blue,#22d3ee) 8%, transparent); }
      .v2-scope-item .rm:hover { color:var(--red,#c53030); background:color-mix(in srgb, var(--red,#c53030) 8%, transparent); }
      .v2-total-card {
        background:var(--bg,#0a0c0f); border:2px solid var(--orange,#BD5728);
        border-radius:6px; padding:16px; margin-top:16px;
        text-align:center;
      }
      .v2-total-lbl {
        font-size:10px; color:var(--m,#888); text-transform:uppercase;
        letter-spacing:.15em;
      }
      .v2-total-val {
        font-family:'Barlow Condensed',sans-serif; font-size:42px;
        font-weight:800; color:var(--orange,#BD5728); line-height:1;
      }
      .v2-rollup {
        font-size:11px; color:var(--m,#888); margin-top:10px;
        line-height:1.6;
      }
      .v2-rollup strong { color:var(--t,#e8eaf0); }
      /* Deposit line (2026-09-25, deposit-rule.js) — left-aligned prose so a
         two-line insurance sentence stays readable at 360px. */
      .v2-deposit:empty { display:none; }
      .v2-deposit {
        margin-top:10px; padding-top:10px; border-top:1px solid var(--br,#2a2f35);
        text-align:left; font-size:12px; line-height:1.5; color:var(--t,#e8eaf0);
        overflow-wrap:anywhere;
      }
      .v2-deposit-head { display:flex; justify-content:space-between; gap:8px; font-weight:700; }
      .v2-deposit-head strong { color:var(--orange,#BD5728); }
      .v2-deposit-sum { color:var(--m,#9ca3af); margin-top:2px; }
      .v2-deposit-note { color:var(--orange,#BD5728); margin-top:4px; font-size:11px; }
      .v2-export-btns {
        display:grid; grid-template-columns:1fr 1fr 1fr;
        gap:8px; margin-top:14px;
      }
      /* Wave 28: collapse to 1-col on phones so the three buttons get
         full tap-width instead of three squished 60-70px chips. */
      @media (max-width:430px) {
        .v2-export-btns { grid-template-columns:1fr; }
      }
      .v2-export-btns button {
        background:var(--bg,#0a0c0f); border:1px solid var(--br,#2a2f35); color:var(--t,#e8eaf0);
        padding:12px 6px; font-size:10px; font-weight:700;
        letter-spacing:.08em; text-transform:uppercase; cursor:pointer;
        border-radius:4px; font-family:inherit;
      }
      .v2-export-btns button.primary {
        background:var(--orange,#BD5728); border-color:var(--orange,#BD5728); color:var(--accent-fg,#fff);
      }
      .v2-export-btns button:hover {
        border-color:var(--orange,#BD5728);
      }
      .v2-preset-btns {
        display:grid; grid-template-columns:1fr 1fr;
        gap:6px; margin-top:6px;
      }
      .v2-preset-btns button {
        background:var(--bg,#0a0c0f); border:1px solid var(--br,#2a2f35); color:var(--m,#888);
        padding:8px 6px; font-size:10px; font-weight:600;
        cursor:pointer; border-radius:3px; font-family:inherit;
        text-align:center;
      }
      .v2-preset-btns button:hover {
        border-color:var(--orange,#BD5728); color:var(--orange,#BD5728);
      }
      .v2-empty {
        text-align:center; color:var(--m,#666); padding:24px 8px;
        font-size:12px; font-style:italic;
      }
      /* Send to homeowner / Sign on this phone / Kentucky gate (2026-10-03) */
      .v2-send-ho { width:100%; justify-content:center; min-height:52px; padding:12px; margin-bottom:6px; font-size:15px; }
      .v2-sign-phone, .v2-ky-contract {
        width:100%; justify-content:center; min-height:48px; padding:12px; margin-bottom:6px;
        border-color:var(--green,#2ecc8a); color:var(--green,#2ecc8a);
      }
      /* Full packet / Paperwork only (2026-10-04) */
      .v2-packet { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:6px; }
      .v2-packet-opt {
        min-height:48px; border-radius:8px; border:2px solid var(--br,#2a2f35); background:var(--s2,#181c22);
        color:var(--t,#e8eaf0); font:inherit; font-size:14px; font-weight:700; cursor:pointer; padding:6px 8px;
      }
      .v2-packet-opt.active { border-color:var(--orange,#BD5728); color:var(--orange,#BD5728); }
      .v2-packet-hint { font-size:12px; color:var(--m,#888); text-align:center; margin-bottom:6px; line-height:1.4; }
      .v2-packet-photos { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; margin-bottom:8px; }
      .v2-packet-photos[hidden] { display:none; }
      .v2-packet-ph {
        position:relative; padding:0; aspect-ratio:1; border-radius:8px; overflow:hidden; cursor:pointer;
        border:2px solid var(--orange,#BD5728); background:var(--s,#111418); min-height:44px;
      }
      .v2-packet-ph img { width:100%; height:100%; object-fit:cover; display:block; }
      .v2-packet-ph.off { border-color:var(--br,#2a2f35); }
      .v2-packet-ph.off img { opacity:.35; }
      .v2-packet-ph .v2-packet-check {
        position:absolute; top:4px; right:4px; width:22px; height:22px; border-radius:50%; display:flex;
        align-items:center; justify-content:center; background:var(--orange,#BD5728); color:#fff; font-size:12px; font-weight:800;
      }
      .v2-packet-ph.off .v2-packet-check { display:none; }
      .v2-share-status { font-size:12px; color:var(--m,#888); text-align:center; min-height:1em; margin-bottom:6px; }
      .v2-share-box { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px; }
      .v2-share-box[hidden] { display:none; }
      .v2-share-box .v2-share-act {
        display:flex; align-items:center; justify-content:center; min-height:48px; border-radius:8px;
        border:1px solid var(--br,#2a2f35); background:var(--s2,#181c22); color:var(--t,#e8eaf0);
        font:inherit; font-size:14px; font-weight:700; text-decoration:none; cursor:pointer;
      }
      .v2-share-box .v2-share-url { grid-column:1 / -1; font-size:11px; color:var(--m,#888); word-break:break-all; text-align:center; }
      .v2-ky-note {
        font-size:12px; line-height:1.45; color:var(--t,#e8eaf0); background:var(--s2,#181c22);
        border:1px solid var(--orange,#BD5728); border-radius:8px; padding:10px; margin-bottom:8px;
      }
      .v2-ky-note[hidden], .v2-ky-contract[hidden] { display:none !important; }
      #estV2Modal .v2-ky-off { display:none !important; }
      /* In-house e-sign (2026-10-04): optional co-owner, signs after the homeowner. */
      .v2-cosign { display:grid; gap:6px; margin:4px 0 8px; }
      .v2-cosign-lbl { font-size:11px; color:var(--m,#888); }
      .v2-cosign-in {
        width:100%; min-height:44px; box-sizing:border-box; padding:10px; border-radius:6px;
        border:1px solid var(--br,#2a2f35); background:var(--s2,#181c22); color:var(--t,#e8eaf0); font:inherit; font-size:14px;
      }
      #estV2Modal .v2-status-err { color:var(--red,#ff6b6b) !important; }
      </style>

      <div class="v2-hdr">
        <div>
          <span class="v2-title">NBD<span class="pro"> PRO</span></span>
          <span class="v2-title" style="margin-left:20px;">Estimate Builder V2</span>
          <span class="v2-beta">BETA</span>
        </div>
        <button class="v2-close" type="button" data-action="close">✕ Close</button>
      </div>

      <div class="v2-body">
        <!-- LEFT: Measurements + Mode + Customer -->
        <div class="v2-pane pane-setup">
          <div class="v2-section">Mode</div>
          <div class="v2-tabs">
            <button id="v2modePerSq" type="button" data-action="set-mode" data-arg="per-sq">Per-SQ</button>
            <button id="v2modeLine" type="button" class="active" data-action="set-mode" data-arg="line-item">Line-Item</button>
          </div>
          <div class="v2-tabs">
            <button id="v2jobInsurance" type="button" class="active" data-action="set-job-mode" data-arg="insurance">Insurance</button>
            <button id="v2jobCash" type="button" data-action="set-job-mode" data-arg="cash">Cash</button>
          </div>
          <div id="v2modeHint" class="v2-mode-hint" hidden style="font-size:12px;color:var(--gold,#D4A017);margin:6px 2px 0;"></div>

          <!-- Wave 142: Tier selector. Drives the Good/Better/Best
               per-SQ rate ($545/$595/$660) AND the catalog-mode
               material grade. Was hardcoded in state.tier='better'
               with no UI to change — meaning reps couldn't switch
               tiers from inside the modal at all. -->
          <div class="v2-section">Tier</div>
          <div class="v2-tabs" id="v2tierTabs">
            <button id="v2tierEconomy" type="button" data-action="set-tier" data-arg="economy">Economy</button>
            <button id="v2tierGood"   type="button" data-action="set-tier" data-arg="good">Good</button>
            <button id="v2tierBetter" type="button" class="active" data-action="set-tier" data-arg="better">Better</button>
            <button id="v2tierBest"   type="button" data-action="set-tier" data-arg="best">Best</button>
            <button id="v2tierBeyond" type="button" data-action="set-tier" data-arg="beyond" title="TAMKO HailGuard only">Beyond</button>
          </div>

          <!-- Wave 142: County / jurisdiction selector. Drives permit
               cost AND sales tax. Was hardcoded to hamilton-oh —
               wrong for any job in Butler/Warren/Clermont/KY. -->
          <div class="v2-field">
            <label>County / Jurisdiction</label>
            <select id="v2county" data-state="county">
              <option value="">Other / My county — default permit, 7.00% tax</option>
              <option value="hamilton-oh">Hamilton County, OH</option>
              <option value="butler-oh">Butler County, OH</option>
              <option value="warren-oh">Warren County, OH</option>
              <option value="clermont-oh">Clermont County, OH</option>
              <option value="kenton-ky">Kenton County, KY</option>
              <option value="boone-ky">Boone County, KY</option>
              <option value="campbell-ky">Campbell County, KY</option>${_tenantCountyOptions()}
            </select>
          </div>

          <div class="v2-section">Measurements</div>

          <!-- Auto-measure: hits the measurement provider (Instant Roofer by
               default; HOVER/EagleView/Nearmap selectable) via the
               NBDIntegrations client. Button is greyed-out if the
               provider isn't configured server-side. -->
          <div class="v2-field" style="display:flex;gap:6px;align-items:stretch;">
            <input type="text" id="v2measureAddr" placeholder="Property address for auto-measure"
                   style="flex:1;background:var(--s2,#181c22);color:var(--t,#e8eaf0);border:1px solid var(--br,#2a2f35);padding:10px 12px;border-radius:4px;font-size:13px;font-family:inherit;"/>
            <button type="button" id="v2measureBtn" class="btn btn-orange" data-action="auto-measure"
                    style="min-height:44px;white-space:nowrap;justify-content:center;">
              📐 Auto-measure
            </button>
          </div>
          <div id="v2measureStatus" style="font-size:11px;color:var(--m,#8b8e96);min-height:14px;margin-top:-6px;"></div>

          <div class="v2-field">
            <label>Raw Roof Area (SF)</label>
            <input type="number" id="v2rawSqft" placeholder="e.g. 3900" data-field="rawSqft">
          </div>
          <div class="v2-field">
            <label>Pitch (rise/12)</label>
            <select id="v2pitch" data-field="pitch">
              <option value="3">3/12</option>
              <option value="4">4/12</option>
              <option value="5">5/12</option>
              <option value="6" selected>6/12</option>
              <option value="7">7/12</option>
              <option value="8">8/12 (steep)</option>
              <option value="9">9/12</option>
              <option value="10">10/12</option>
              <option value="11">11/12</option>
              <option value="12">12/12 (very steep)</option>
              <option value="13">13/12</option>
              <option value="14">14/12</option>
              <option value="15">15/12</option>
              <option value="16">16/12 (extreme)</option>
              <option value="18">18/12 (extreme)</option>
            </select>
          </div>
          <div class="v2-field">
            <label>Eave LF</label>
            <input type="number" id="v2eaveLf" placeholder="e.g. 120" data-field="eaveLf">
          </div>
          <div class="v2-field">
            <label>Rake LF</label>
            <input type="number" id="v2rakeLf" placeholder="e.g. 50" data-field="rakeLf">
          </div>
          <div class="v2-field">
            <label>Ridge LF</label>
            <input type="number" id="v2ridgeLf" placeholder="e.g. 45" data-field="ridgeLf">
          </div>
          <div class="v2-field">
            <label>Hip LF</label>
            <input type="number" id="v2hipLf" placeholder="e.g. 20" data-field="hipLf">
          </div>
          <div class="v2-field">
            <label>Valley LF</label>
            <input type="number" id="v2valleyLf" placeholder="e.g. 32" data-field="valleyLf">
          </div>
          <div class="v2-field">
            <label>Pipes (count)</label>
            <input type="number" id="v2pipes" placeholder="e.g. 4" data-field="pipes">
          </div>
          <div class="v2-field">
            <label>Chimneys (count)</label>
            <input type="number" id="v2chimneys" placeholder="e.g. 1" data-field="chimneys">
          </div>
          <div class="v2-field">
            <label>Skylights (count)</label>
            <input type="number" id="v2skylights" placeholder="0" data-field="skylights">
          </div>
          <div class="v2-field">
            <label>Tear-off Layers</label>
            <select id="v2layers" data-field="tearOffLayers">
              <option value="1">1 Layer</option>
              <option value="2">2 Layers</option>
              <option value="3">3 Layers</option>
            </select>
          </div>
          <div class="v2-field">
            <label>Stories</label>
            <select id="v2stories" data-field="stories">
              <option value="1">1 Story</option>
              <option value="2">2 Story (+$15/SQ)</option>
              <option value="3">3+ Story (+$30/SQ)</option>
            </select>
          </div>
          <div class="v2-field">
            <label>Access</label>
            <select id="v2access" data-field="accessLevel">
              <option value="standard">Standard</option>
              <option value="moderate">Moderate (+$15/SQ)</option>
              <option value="difficult">Difficult (+$35/SQ)</option>
            </select>
          </div>
          <label class="v2-field inline v2-check" for="v2cutup">
            <span>Cut-up Roof (+3% waste + $15/SQ)</span>
            <input type="checkbox" id="v2cutup" data-field="cutUpRoof">
          </label>

          <!-- Wave 143: per-SQ mode add-ons. Drive the
               estimate-builder-v2.js calculatePerSq() add-on prices
               ($425 chimney flash, $350 skylight flash, $8.50/LF
               valley metal, $8.50/LF gutters). In line-item mode
               these become catalog selections instead — the engine
               handles both paths from the same state shape. -->
          <div class="v2-section">Add-Ons</div>
          <label class="v2-field inline v2-check" for="v2chimneyFlash">
            <span>Chimney Flashing (+$425)</span>
            <input type="checkbox" id="v2chimneyFlash" data-field="hasChimneyFlash">
          </label>
          <label class="v2-field inline v2-check" for="v2skylightFlash">
            <span>Skylight Flashing (+$350)</span>
            <input type="checkbox" id="v2skylightFlash" data-field="hasSkylightFlash">
          </label>
          <div class="v2-field">
            <label>Valley Metal LF (@ $8.50)</label>
            <input type="number" id="v2valleyMetalLf" placeholder="0" min="0" data-field="valleyMetalLf">
          </div>
          <div class="v2-field">
            <label>Gutters LF (@ $8.50)</label>
            <input type="number" id="v2guttersLf" placeholder="0" min="0" data-field="guttersLf">
          </div>

          <div class="v2-section">Presets</div>
          <div class="v2-preset-btns">
            <button type="button" data-action="load-preset" data-arg="standard-reroof">Standard Reroof</button>
            <button type="button" data-action="load-preset" data-arg="storm-claim">Storm Claim</button>
            <button type="button" data-action="load-preset" data-arg="small-repair">Small Repair</button>
            <button type="button" data-action="load-preset" data-arg="shingle-patch">Shingle Patch</button>
            <button type="button" data-action="load-preset" data-arg="full-redeck">Full Redeck</button>
            <button type="button" data-action="load-preset" data-arg="hail-damage-insurance" style="grid-column:span 2;">Hail Damage Insurance</button>
            <button type="button" data-action="load-preset" data-arg="tamko-storm-hailguard" style="grid-column:span 2;">TAMKO Storm — HailGuard</button>
            <button type="button" data-action="open-job-templates" style="grid-column:span 2;">🧰 Job Templates…</button>
          </div>
        </div>

        <!-- MIDDLE: Catalog picker -->
        <div class="v2-pane pane-items">
          <div class="v2-section">Line Item Catalog (278 items)</div>
          <input type="text" class="v2-search" id="v2search" placeholder="Search by code, name, or tag..." data-action="search">
          <div class="v2-cat-tabs" id="v2cats"></div>
          <div class="v2-item-list" id="v2items"></div>
        </div>

        <!-- RIGHT: Selected scope + total + export -->
        <div class="v2-pane right pane-review">

          <!-- Wave 142: Customer + Claim inputs. Previously
               state.customer / state.claim could ONLY be populated
               via prefillFromLead — meaning a standalone estimate
               (no linked lead) had no way to enter customer info, the
               PDF was blank on every customer field, and Send-for-
               Signature failed at the "name + email required" gate.
               These inputs use data-customer / data-claim attributes
               to drive a delegated input handler that writes back to
               state in real time. syncCustomerInputs() reads from
               state and writes to these IDs on lead-prefill or
               draft-restore. -->
          <div class="v2-section">Customer</div>
          <div class="v2-field">
            <label>Name</label>
            <input type="text" id="v2custName" data-customer="name" placeholder="e.g. Sarah Smith" autocomplete="name">
          </div>
          <div class="v2-field">
            <label>Email</label>
            <input type="email" id="v2custEmail" data-customer="email" placeholder="e.g. sarah@example.com" autocomplete="email">
          </div>
          <div class="v2-field">
            <label>Phone</label>
            <input type="tel" id="v2custPhone" data-customer="phone" placeholder="e.g. (859) 555-0100" autocomplete="tel">
          </div>
          <div class="v2-field">
            <label>Property Address</label>
            <input type="text" id="v2custAddress" data-customer="address" placeholder="e.g. 123 Main St, Goshen, OH 45122" autocomplete="street-address">
          </div>

          <!-- Claim inputs only matter for insurance jobs but the
               state shape carries them regardless; rendering the
               whole block keeps the UI consistent (the rep can
               leave these blank for a cash job). -->
          <div class="v2-section">Insurance Claim</div>
          <div class="v2-field">
            <label>Carrier</label>
            <input type="text" id="v2claimCarrier" data-claim="carrier" placeholder="e.g. State Farm">
          </div>
          <div class="v2-field">
            <label>Claim Number</label>
            <input type="text" id="v2claimNumber" data-claim="number" placeholder="e.g. 04-1234-A">
          </div>
          <div class="v2-field">
            <label>Adjuster</label>
            <input type="text" id="v2claimAdjuster" data-claim="adjuster" placeholder="e.g. Mike Johnson">
          </div>
          <div class="v2-field">
            <label>Deductible</label>
            <input type="number" id="v2claimDeductible" data-claim="deductible" placeholder="e.g. 2500" min="0" step="50">
          </div>
          <!-- ACV (2026-09-25, deposit rule): the carrier scope's ACV line,
               before the deductible. The insurance deposit is the deductible
               plus the carrier's first check (ACV − deductible); blank = not
               known yet, and the paperwork says the ACV payment is due when
               the carrier releases it. Same claim.acv field the save payload
               and the insurance scope already carry. -->
          <div class="v2-field">
            <label>ACV (carrier scope, before deductible)</label>
            <input type="number" id="v2claimAcv" data-claim="acv" placeholder="Blank until the carrier's scope arrives" min="0" step="0.01" inputmode="decimal">
          </div>
          <div class="v2-field">
            <label>Date of Loss</label>
            <input type="date" id="v2claimDateOfLoss" data-claim="dateOfLoss">
          </div>
          <div class="v2-field">
            <label>Policy Number</label>
            <input type="text" id="v2claimPolicyNumber" data-claim="policyNumber" placeholder="e.g. POL-9988776">
          </div>

          <div class="v2-section">Selected Scope</div>
          <div id="v2scopeList">
            <div class="nbd-empty" style="padding:24px 8px;"><div class="ne-icon">🧾</div><div class="ne-msg">No items selected yet</div><div class="ne-sub">Pick from the catalog or load a preset.</div></div>
          </div>

          <div class="v2-total-card">
            <div class="v2-total-lbl">Grand Total</div>
            <div class="v2-total-val" id="v2total">$0</div>
            <div class="v2-deposit" id="v2deposit" aria-live="polite"></div>
            <div class="v2-rollup" id="v2rollup"></div>
          </div>

          <div class="v2-section">Photos</div>
          <div id="v2photosHint" style="font-size:11px;color:var(--m,#888);margin-bottom:8px;">
            Tap photos to include them on this estimate — they show in the
            homeowner presentation, the printed quote, and the shared link.
          </div>
          <div id="v2photosGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px;"></div>

          <div class="v2-section">Preview / Export</div>
          <div class="v2-export-btns">
            <button type="button" data-action="finalize" data-arg="insurance-scope">📋 Insurance Scope</button>
            <button type="button" data-action="finalize" data-arg="retail-quote">💼 Retail Quote</button>
            <button type="button" data-action="finalize" data-arg="single-quote">📄 Single Quote</button>
            <button type="button" data-action="finalize" data-arg="internal-view">🔒 Internal</button>
          </div>

          <div class="v2-section">Send to Homeowner</div>
          <div class="v2-packet" role="group" aria-label="What the homeowner gets">
            <button type="button" id="v2packetFull" class="v2-packet-opt active" data-action="set-packet" data-arg="full" aria-pressed="true">📦 Full packet</button>
            <button type="button" id="v2packetPaper" class="v2-packet-opt" data-action="set-packet" data-arg="paperwork" aria-pressed="false">📄 Paperwork only</button>
          </div>
          <div id="v2packetHint" class="v2-packet-hint"></div>
          <div id="v2packetPhotos" class="v2-packet-photos" hidden></div>
          <button id="v2sendHoBtn" type="button" class="btn btn-orange v2-send-ho" data-action="send-to-homeowner">
            📲 Send to homeowner
          </button>
          <div id="v2shareStatus" class="v2-share-status" aria-live="polite"></div>
          <div id="v2shareBox" class="v2-share-box" hidden></div>

          <div class="v2-section">Present</div>
          <button type="button" class="btn btn-ghost" data-action="present"
            style="width:100%;justify-content:center;padding:12px;margin-bottom:6px;border-color:var(--green,#2ecc8a);color:var(--green,#2ecc8a);">
            🎁 Present to Homeowner
          </button>

          <div class="v2-section">Save</div>
          <button id="v2saveBtn" type="button" class="btn btn-orange" data-action="save"
            style="width:100%;justify-content:center;padding:14px;">
            💾 Save Estimate to Customer
          </button>
          <div id="v2saveStatus" style="font-size:10px;color:var(--m,#888);margin-top:6px;text-align:center;"></div>

          <div class="v2-section">E-Signature</div>
          <button id="v2signPhoneBtn" type="button" class="btn btn-ghost v2-sign-phone" data-action="sign-on-phone">
            📱 Sign on this phone
          </button>
          <div id="v2kyNote" class="v2-ky-note" hidden>
            Kentucky insurance job: sign on this phone or with the generated contract — both carry the
            KRS 367.624 notices and the cancellation form. E-mail e-signature is off for this job.
          </div>
          <button id="v2kyContractBtn" type="button" class="btn btn-ghost v2-ky-contract" data-action="ky-contract" hidden>
            📄 Generate contract (Kentucky notices)
          </button>
          <div class="v2-cosign" id="v2cosign">
            <label class="v2-cosign-lbl" for="v2coName">Co-owner signing too? (optional — signs after the homeowner)</label>
            <input id="v2coName" class="v2-cosign-in" type="text" autocomplete="off" placeholder="Co-owner full name">
            <input id="v2coEmail" class="v2-cosign-in" type="email" autocomplete="off" inputmode="email" placeholder="Co-owner email">
          </div>
          <button id="v2signBtn" type="button" class="btn btn-ghost" data-action="send-for-signature"
            style="width:100%;justify-content:center;padding:12px;margin-bottom:6px;border-color:var(--orange,#BD5728);color:var(--orange,#BD5728);">
            ✍️ Send for Signature
          </button>
          <div id="v2signStatus" style="font-size:10px;color:var(--m,#888);text-align:center;"></div>
        </div>
      </div>

      <!-- Phase 1b (RoofLink rebuild): mobile step bar. Under 1000px the
           three panes become STEPS — Setup → Items → Review — instead of
           one giant stacked scroll, with the live total always visible.
           Desktop (3-column grid) is untouched; the bar is display:none
           there. Tapping the total jumps to Review. -->
      <div class="v2-mstep-bar" id="v2mStepBar">
        <button type="button" class="v2-mstep-btn active" data-action="mstep" data-arg="1">① Setup</button>
        <button type="button" class="v2-mstep-btn" data-action="mstep" data-arg="2">② Items</button>
        <button type="button" class="v2-mstep-btn" data-action="mstep" data-arg="3">③ Review</button>
        <button type="button" class="v2-mstep-total" id="v2mTotal" data-action="mstep" data-arg="3">$0</button>
      </div>

      <!-- Undo for a removed scope line (2026-09-25, estimate#6). -->
      <div class="v2-undo" id="v2Undo" role="status" aria-live="polite">
        <span class="v2-undo-msg"></span>
        <button type="button" data-action="undo-remove">Undo</button>
      </div>
    `;
    document.body.appendChild(modal);

    // ─────────────────────────────────────────────────────
    // Wrap each .v2-section header's following siblings into
    // a .v2-section-content block so the section can be
    // collapsed by toggling a class on the header. This runs
    // once, right after the modal DOM is created.
    // ─────────────────────────────────────────────────────
    modal.querySelectorAll('.v2-pane').forEach(pane => {
      const sections = Array.from(pane.querySelectorAll('.v2-section'));
      sections.forEach((hdr, i) => {
        const next = sections[i + 1] || null;
        const wrapper = document.createElement('div');
        wrapper.className = 'v2-section-content';
        // Move every sibling between this header and the next header
        // (or the end of the pane) into the wrapper.
        let cursor = hdr.nextSibling;
        while (cursor && cursor !== next) {
          const toMove = cursor;
          cursor = cursor.nextSibling;
          wrapper.appendChild(toMove);
        }
        hdr.parentNode.insertBefore(wrapper, next);
      });

      // On screens ≤1000px, start with only the BULKY, optional sections
      // collapsed. Phone audit 2026-09-25 (estimate#2): this used to collapse
      // EVERYTHING except the catalog "so the items list is front-and-center"
      // — a rule from the one-long-stacked-scroll era (2026-04). The Phase 1b
      // step bar (2026-07) already gives each pane its own screen, so the
      // rule left Setup as five bare headers with no input visible, and put
      // the scope list, the Grand Total card and Save behind taps on Review —
      // including a reopened estimate, which open() lands on Review precisely
      // so the rep can LOOK at it. Measurements, scope, total, save, present
      // and sign stay open; claim fields, the photo grid and the deal-room
      // button start folded (one tap away, and none is on the main path).
      if (window.innerWidth <= 1000) {
        const FOLDED_ON_PHONE = ['insurance claim', 'photos', 'close board'];
        pane.querySelectorAll('.v2-section').forEach(hdr => {
          const txt = (hdr.textContent || '').trim().toLowerCase();
          if (FOLDED_ON_PHONE.includes(txt)) hdr.classList.add('collapsed');
        });
      }
    });

    // Associate each field label with its control (2026-09-25, estimate#3/#4
    // sibling): the markup's bare <label>s had no for=, so tapping a label
    // never reached its input and screen readers announced unlabeled fields.
    // One control per .v2-field; rows that are themselves a <label> (the
    // .v2-check checkbox rows) already wrap theirs.
    modal.querySelectorAll('.v2-field').forEach(field => {
      const lbl = field.querySelector(':scope > label');
      const ctl = field.querySelectorAll(':scope > input[id], :scope > select[id]');
      if (lbl && ctl.length === 1 && !lbl.htmlFor) lbl.htmlFor = ctl[0].id;
    });

    // Click-to-toggle. Delegation keeps it robust against re-renders
    // inside the sections.
    modal.addEventListener('click', (ev) => {
      const hdr = ev.target.closest('.v2-section');
      if (!hdr || !modal.contains(hdr)) return;
      // Ignore clicks inside inputs/buttons that happen to be inside a
      // section header (shouldn't happen given the markup, but defensive).
      if (ev.target.closest('input, select, textarea, button')) return;
      hdr.classList.toggle('collapsed');
    });

    // ─────────────────────────────────────────────────────
    // CSP-strict-safe delegated click handler. Every button in
    // the modal uses data-action + optional data-arg instead of
    // an inline onclick attribute. One listener dispatches them
    // all so the file runs clean under the Report-Only CSP
    // (script-src-attr 'none').
    // ─────────────────────────────────────────────────────
    modal.addEventListener('click', (ev) => {
      const target = ev.target.closest('[data-action]');
      if (!target || !modal.contains(target)) return;
      // Skip non-button elements that happen to have data-action
      // further up the chain (inputs handle their own events below).
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;

      const action = target.dataset.action;
      const arg    = target.dataset.arg;
      switch (action) {
        case 'close':
          close();
          break;
        case 'mstep':
          // Phase 1b: mobile step bar — Setup(1) / Items(2) / Review(3).
          if (arg) setMobileStep(arg);
          break;
        case 'set-mode':
          if (arg) setMode(arg);
          break;
        case 'set-job-mode':
          if (arg) setJobMode(arg);
          break;
        case 'set-tier':
          // W142: change Good/Better/Best tier from inside the modal.
          // Updates state, repaints the active button, recalculates
          // grand total. catalog-mode tier feeds resolveEstimate;
          // per-SQ mode tier picks the locked rate from
          // estimate-config.js TIER_RATES. (Body extracted to
          // setTierChoice so Phase-3 presentation tier cards share it.)
          if (arg) setTierChoice(arg);
          break;
        case 'cp-work-kind':
          // Roof Care Plan: the rep says what kind of work this is.
          setWorkKind(arg);
          break;
        case 'present':
          // Phase 3: homeowner-facing Good/Better/Best compare screen.
          openPresentation();
          break;
        case 'toggle-photo':
          if (arg) togglePhoto(arg);
          break;
        case 'set-packet':
          if (arg) setPacket(arg);
          break;
        case 'toggle-packet-photo':
          if (arg) togglePacketPhoto(arg);
          break;
        case 'pres-tier':
          if (arg) { setTierChoice(arg); openPresentation(); }
          break;
        case 'pres-close':
          closePresentation();
          break;
        case 'pres-sign':
          closePresentation();
          // Kentucky insurance job: the e-mail e-signature body has no KRS
          // 367.624 notices — sign on this phone (the deal page carries them).
          if (_kySigningBlocked()) signOnThisPhone();
          else sendForSignature({ inPerson: true });
          break;
        case 'load-preset':
          if (arg) loadPreset(arg);
          break;
        case 'open-job-templates':
          // Job-template picker (job-templates-ui.js, same bundle). Inserts
          // its selection back through addScopeEntries below.
          if (window.JobTemplatesUI && typeof window.JobTemplatesUI.openPickerForScope === 'function') {
            window.JobTemplatesUI.openPickerForScope();
          }
          break;
        case 'finalize':
          // finalize is async; an unhandled rejection used to fail silently
          // after the "Rendering…" toast — no modal, no message.
          if (arg) finalize(arg).catch(e => {
            console.error('[V2 finalize] failed:', e);
            if (typeof window.showToast === 'function') window.showToast('Preview failed: ' + ((e && e.message) || 'unknown error') + ' — try again.', 'error');
          });
          break;
        case 'send-to-homeowner':
        case 'create-deal-room':
          // One flow (2026-10-03): save → deal → link → share sheet, and the
          // builder stays open. "Create Deal Room" used to skip the save.
          sendToHomeowner();
          break;
        case 'sign-on-phone':
          signOnThisPhone();
          break;
        case 'ky-contract':
          openKyContract();
          break;
        case 'share-native':
          _shareNative(false);
          break;
        case 'share-mark':
          // A Text / Email link: the anchor opens Messages / Mail itself.
          _markShared(arg === 'email' ? 'email' : 'sms');
          break;
        case 'share-copy':
          _copyShareLink();
          break;
        case 'save':
          save();
          break;
        case 'auto-measure':
          autoMeasure();
          break;
        case 'send-for-signature':
          sendForSignature();
          break;
        case 'sign-copy':
          _copySignLink();
          break;
        case 'set-category':
          setCategory(arg || 'all');
          break;
        case 'add-to-scope': {
          const code = target.dataset.code;
          if (code) addToScope(code);
          break;
        }
        case 'remove-from-scope': {
          const item = target.closest('.v2-scope-item');
          const code = item && item.dataset.code;
          if (code) removeFromScope(code);
          break;
        }
        case 'remove-selected': {
          // × in the Items step's "✓ Selected" view. Its own case because
          // those rows are .v2-item cards, not .v2-scope-item — and the
          // code sits on the button itself.
          const code = target.dataset.code;
          if (code) removeFromScope(code);
          break;
        }
        case 'override-qty': {
          const item = target.closest('.v2-scope-item');
          const code = item && item.dataset.code;
          if (code) overrideQty(code);
          break;
        }
        case 'edit-note': {
          const item = target.closest('.v2-scope-item');
          const code = item && item.dataset.code;
          if (code) overrideNote(code);
          break;
        }
        // Inline row editor (2026-09-25, estimate#6) + the undo bar.
        case 'row-edit-apply':
          commitRowEditor('apply');
          break;
        case 'row-edit-auto':
          commitRowEditor('auto');
          break;
        case 'row-edit-clear':
          commitRowEditor('clear');
          break;
        case 'row-edit-cancel':
          _closeRowEditor();
          break;
        case 'undo-remove':
          undoRemove();
          break;
      }
    });

    // Enter applies / Escape cancels the inline row editor. Escape stops here
    // so it cancels the edit rather than bubbling to a page-level handler.
    modal.addEventListener('keydown', (ev) => {
      if (!ev.target || ev.target.id !== 'v2RowEditInput') return;
      if (ev.key === 'Enter') { ev.preventDefault(); commitRowEditor('apply'); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); _closeRowEditor(); }
    });

    // ─────────────────────────────────────────────────────
    // CSP-strict-safe delegated input/change handler. Every
    // measurement input / select / checkbox has data-field set
    // to the state key it updates. One listener pipes them all
    // through updateMeasurement().
    // The search input uses data-action="search" instead so
    // it routes to setSearch() (it's not a measurement field).
    // ─────────────────────────────────────────────────────
    const fieldInputHandler = (ev) => {
      const el = ev.target;
      if (!el || !modal.contains(el)) return;

      // Search input → setSearch
      if (el.dataset.action === 'search') {
        setSearch(el.value);
        return;
      }
      // W142: customer/claim/top-level state inputs
      if (el.dataset.customer) {
        state.customer = state.customer || {};
        state.customer[el.dataset.customer] = el.value;
        // If the customer's property address is being typed and the
        // separate "auto-measure" address input is empty, mirror it
        // so the rep doesn't have to type the address twice.
        if (el.dataset.customer === 'address') {
          const measureAddr = document.getElementById('v2measureAddr');
          if (measureAddr && !measureAddr.value) measureAddr.value = el.value;
        }
        saveDraftDebounced();
        return;
      }
      if (el.dataset.claim) {
        state.claim = state.claim || {};
        const key = el.dataset.claim;
        // Deductible coerces to number; ACV to a number or null (blank = not
        // known yet — never 0, which would read as "carrier pays nothing");
        // other claim fields stay strings.
        state.claim[key] = (key === 'deductible')
          ? (Number(el.value) || 0)
          : (key === 'acv')
            ? ((el.value !== '' && isFinite(Number(el.value)) && Number(el.value) > 0) ? Number(el.value) : null)
            : el.value;
        // The deposit follows the deductible and the ACV (deposit-rule.js).
        if (key === 'deductible' || key === 'acv') renderDepositLine();
        saveDraftDebounced();
        return;
      }
      if (el.dataset.state) {
        const key = el.dataset.state;
        // Only the keys we explicitly support — defense against a
        // future field that accidentally writes to e.g. state.scope.
        if (key === 'county') {
          state.county = el.value;
          state._reopenedClean = false;   // 3B: county (tax) change → re-resolve
          render();
          saveDraftDebounced();
        }
        return;
      }
      // Measurement field → updateMeasurement
      const field = el.dataset.field;
      if (!field) return;
      const value = (el.type === 'checkbox') ? el.checked : el.value;
      updateMeasurement(field, value);
    };
    // input fires for text/number/search; change fires for select/checkbox
    modal.addEventListener('input', fieldInputHandler);
    modal.addEventListener('change', fieldInputHandler);
  }

  // ═════════════════════════════════════════════════════════
  // State management
  // ═════════════════════════════════════════════════════════

  function setMode(mode) {
    state.mode = mode;
    state._reopenedClean = false;   // 3B: mode change → re-resolve
    document.getElementById('v2modePerSq').classList.toggle('active', mode === 'per-sq');
    document.getElementById('v2modeLine').classList.toggle('active', mode === 'line-item');
    render();
  }

  // Per-SQ only prices when the overlay applies (Cash + a roof area). Without
  // this, picking Per-SQ on a fresh Insurance estimate silently kept
  // line-item pricing and the Settings tier rates looked dead.
  function _paintModeHint() {
    const el = document.getElementById('v2modeHint');
    if (!el) return;
    let msg = '';
    if (state.mode === 'per-sq') {
      if (!_perSqOverlayApplies()) {
        if (state.jobMode === 'insurance') msg = 'Per-SQ pricing applies to Cash jobs — switch to Cash to use your tier rates.';
        else msg = 'Enter the raw roof area below — Per-SQ prices from it.';
      } else if (!(state.scope && state.scope.length)) {
        msg = 'Add the roofing system from Items — Per-SQ then prices the job at your tier rate.';
      }
    }
    el.textContent = msg;
    el.hidden = !msg;
  }

  function setJobMode(jobMode) {
    state.jobMode = jobMode;
    state._reopenedClean = false;   // 3B: job-mode change → re-resolve
    document.getElementById('v2jobInsurance').classList.toggle('active', jobMode === 'insurance');
    document.getElementById('v2jobCash').classList.toggle('active', jobMode === 'cash');
    render();
  }

  function updateMeasurement(key, value) {
    // W143: hasChimneyFlash + hasSkylightFlash are checkbox booleans
    // (same shape as cutUpRoof). Listing them explicitly here is
    // clearer than checking `typeof value === 'boolean'` because the
    // delegated handler casts to bool only when ev.target.type
    // === 'checkbox' — unifying the cast point here means the engine
    // never sees a stringly-typed bool from a third-party caller.
    const BOOL_FIELDS = new Set(['cutUpRoof', 'hasChimneyFlash', 'hasSkylightFlash']);
    const STRING_FIELDS = new Set(['accessLevel']);   // tier <select> values are strings, not numbers
    if (BOOL_FIELDS.has(key)) {
      state.measurements[key] = !!value;
    } else if (STRING_FIELDS.has(key)) {
      state.measurements[key] = String(value || 'standard');
    } else {
      state.measurements[key] = Number(value) || 0;
    }
    // QA-fix (V2-7, estimate-qa-2026-06-08): keep the stored waste factor in sync
    // with the selected pitch so the line-item / persisted path uses the same
    // (correct) waste the per-SQ engine derives. measurements.pitch is the RISE
    // integer, so the rise/run ratio is pitch/12. Without this, waste stayed stuck
    // at the initial default (1.17) regardless of the chosen pitch.
    if (key === 'pitch' || key === 'cutUpRoof') {
      const ratio = (Number(state.measurements.pitch) || 8) / 12;
      if (window.EstimateBuilderV2 && typeof EstimateBuilderV2.wasteFactorForPitch === 'function') {
        let w = EstimateBuilderV2.wasteFactorForPitch(ratio);
        if (state.measurements.cutUpRoof) w += 0.03;
        state.measurements.waste = w;
      }
    }
    state._reopenedClean = false;   // 3B: a measurement change → re-resolve live
    render();
  }

  function setSearch(q) {
    state.searchFilter = q || '';
    // Typing a search means "find me something in the catalog" — drop out of
    // the "✓ Selected" view so results aren't silently swallowed by it.
    if (state.searchFilter && state.categoryFilter === 'selected') state.categoryFilter = 'all';
    renderCatalog();
  }

  function setCategory(cat) {
    state.categoryFilter = cat || 'all';
    renderCatalog();
  }

  function addToScope(code) {
    if (state.scope.find(s => s.code === code)) return;  // Already in scope
    // Steer, don't block — same call as the esign re-upload fix (PR #1614):
    // still let the add through (a rep may have a real reason to mix), just
    // surface the mismatch immediately instead of silently pricing wrong.
    const cat = window.NBD_XACT_CATALOG;
    const item = cat && typeof cat.find === 'function' ? cat.find(code) : null;
    // Beyond = HailGuard only; Economy = never a 3-tab. These BLOCK, unlike
    // the tier-mismatch steer below: they are what the tier is (Jo, 2026-10-02).
    const _cfgT = window.NBD_ESTIMATE_CONFIG;
    if (item && _cfgT && typeof _cfgT.checkTierShingles === 'function') {
      const chk = _cfgT.checkTierShingles(state.tier, [item]);
      if (!chk.ok) {
        if (typeof window.showToast === 'function') window.showToast(chk.problems[0], 'error');
        return;
      }
    }
    if (item && _v2TierMismatch(item.tier) && typeof window.showToast === 'function') {
      window.showToast(
        '"' + (item.name || code) + '" is a ' + item.tier + '-tier item — this job is priced ' + state.tier + ' tier',
        'warning'
      );
    }
    state.scope.push({ code });
    state._reopenedClean = false;   // 3B: edit → re-resolve live, stop replaying
    render();
  }

  // Undo for a removed line (phone audit 2026-09-25, estimate#6). × sat 4px
  // from ✎ and deleted a priced line instantly — including its manual qty
  // override and note, which the rep then had to rebuild from the 278-item
  // catalog. Every removal path (Review ×, the Items step's ✓ Selected ×)
  // goes through removeFromScope, so the undo lives here. One pending undo:
  // a second removal commits the first.
  let _pendingUndo = null;
  let _undoTimer = null;
  const UNDO_MS = 8000;
  // Inline row editor state — see _openRowEditor below.
  let _rowEdit = null;   // { code, kind: 'qty' | 'note', error }

  // What "nothing else changed since the removal" means for undo's replay
  // restore — every input getCurrentEstimate prices from except the one line.
  function _undoFingerprint() {
    try {
      return JSON.stringify([state.mode, state.tier, state.jobMode, state.county,
        state.measurements, state.minJobCharge, state.scope, state.passThru, state.upgrades]);
    } catch (e) { return null; }
  }

  function _dismissUndo() {
    clearTimeout(_undoTimer);
    _undoTimer = null;
    _pendingUndo = null;
    const bar = document.getElementById('v2Undo');
    if (bar) bar.classList.remove('show');
  }

  function _offerUndo(entry) {
    const bar = document.getElementById('v2Undo');
    if (!bar) return;
    clearTimeout(_undoTimer);
    _pendingUndo = entry;
    const msg = bar.querySelector('.v2-undo-msg');
    if (msg) msg.textContent = 'Removed ' + (entry.label || entry.item.code);
    bar.classList.add('show');
    _undoTimer = setTimeout(_dismissUndo, UNDO_MS);
  }

  function undoRemove() {
    const u = _pendingUndo;
    _dismissUndo();
    if (!u) return;
    const list = (u.list === 'passThru' || u.list === 'upgrades') ? u.list : 'scope';
    // The array the removal produced must still be the live one. A preset,
    // Clear, a reopen or another removal replaces it — undoing into that
    // would resurrect a line into a different estimate.
    if (state[list] !== u.after) return;
    // Re-added from the catalog meanwhile → nothing to restore.
    if (state[list].some(x => x.code === u.item.code)) return;
    const unchanged = u.fingerprint != null && _undoFingerprint() === u.fingerprint;
    state[list].splice(Math.min(u.index, state[list].length), 0, u.item);
    // Undo straight after the removal restores the exact prior state, so a
    // reopened estimate goes back to replaying its SAVED numbers (3B) rather
    // than re-resolving live — remove + undo must not move the total.
    state._reopenedClean = unchanged ? u.wasClean : false;
    render();
  }

  function removeFromScope(code) {
    // An upgrade row (stage 2, 2026-09-25) lives in state.upgrades — its
    // own list, with the same undo. Removing one is the rep's call (the
    // homeowner changed their mind); it re-prices live like any removal.
    const upIdx = (state.upgrades || []).findIndex(r => r && r.code === code);
    if (upIdx >= 0) {
      const wasCleanU = !!state._reopenedClean;
      const removedU = state.upgrades[upIdx];
      state.upgrades = state.upgrades.filter((r, i) => i !== upIdx);
      if (_rowEdit && _rowEdit.code === code) _rowEdit = null;
      state._reopenedClean = false;   // 3B
      render();
      _offerUndo({ list: 'upgrades', index: upIdx, item: removedU, label: removedU.desc || code,
        after: state.upgrades, wasClean: wasCleanU, fingerprint: _undoFingerprint() });
      return;
    }
    // Pass-through lines live in a separate array — check there
    // first so a removal on the "measurement report" chip works.
    const wasClean = !!state._reopenedClean;
    const ptBefore = state.passThru || [];
    const ptIdx = ptBefore.findIndex(p => p.code === code);
    const scIdx = ptIdx >= 0 ? -1 : (state.scope || []).findIndex(s => s.code === code);
    const removed = ptIdx >= 0 ? ptBefore[ptIdx] : (scIdx >= 0 ? state.scope[scIdx] : null);
    let label = code;
    if (removed) {
      try {
        const est = getCurrentEstimate();
        const line = est && est.lines.find(l => l.code === code);
        if (line && line.name) label = line.name;
        else if (removed.desc) label = removed.desc;
      } catch (e) { /* label is cosmetic */ }
    }
    const beforePT = (state.passThru || []).length;
    state.passThru = (state.passThru || []).filter(p => p.code !== code);
    if (state.passThru.length === beforePT) {
      state.scope = state.scope.filter(s => s.code !== code);
    }
    if (_rowEdit && _rowEdit.code === code) _rowEdit = null;
    state._reopenedClean = false;   // 3B
    render();
    if (removed) {
      _offerUndo({
        list: ptIdx >= 0 ? 'passThru' : 'scope',
        index: ptIdx >= 0 ? ptIdx : scIdx,
        item: removed,
        label: label,
        after: ptIdx >= 0 ? state.passThru : state.scope,
        wasClean: wasClean,
        fingerprint: _undoFingerprint(),
      });
    }
  }

  // Inline per-row editor (phone audit 2026-09-25, estimate#6). Quantity and
  // note used window.prompt(): a free-text dialog, so Android put up the full
  // keyboard for a number, and native dialogs are unreliable in the installed
  // PWA (standalone-compat.js). Tapping ✎ / 📝 now opens an editor in the row
  // itself — a number pad for quantity. One row at a time; module state
  // (_rowEdit, declared above), not `state`, so it never rides a draft or a
  // save.
  function _openRowEditor(code, kind) {
    const scopeEntry = state.scope.find(s => s.code === code);
    if (!scopeEntry) return;   // pass-through lines have no qty/note
    _rowEdit = { code: code, kind: kind, error: '' };
    renderScope();
    const input = document.getElementById('v2RowEditInput');
    if (input) {
      // Same tick as the tap, so a phone raises its keyboard.
      try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
      try { input.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    }
  }

  function _closeRowEditor() {
    if (!_rowEdit) return;
    _rowEdit = null;
    renderScope();
  }

  // Manual quantity override. Opens the row editor seeded with the current
  // override (blank when the line is on auto) so the user can type the exact
  // value they want (e.g. 2 squares for a tiny repair, 15 LF of drip edge
  // instead of the auto-calculated full perimeter). An empty value or "auto"
  // clears the override and reverts to the formula.
  function overrideQty(code) {
    _openRowEditor(code, 'qty');
  }

  // Apply a typed quantity. Returns false (editor stays open with the reason)
  // on an invalid entry.
  function applyQtyOverride(code, input, badInput) {
    const scopeEntry = state.scope.find(s => s.code === code);
    if (!scopeEntry) return true;
    const trimmed = String(input == null ? '' : input).trim();
    if (badInput) {
      if (_rowEdit) _rowEdit.error = 'Please enter a non-negative number (or blank to revert).';
      return false;
    }
    scopeEntry.overrides = scopeEntry.overrides || {};
    if (trimmed === '' || trimmed.toLowerCase() === 'auto') {
      // Revert to formula
      delete scopeEntry.overrides.qty;
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) {
        if (_rowEdit) _rowEdit.error = 'Please enter a non-negative number (or blank to revert).';
        return false;
      }
      scopeEntry.overrides.qty = n;
    }
    state._reopenedClean = false;   // 3B
    return true;
  }

  // Per-line note (RoofLink-style "Note:" on estimate rows). Lives in
  // state.scope[].overrides.note — pure annotation, never touches math.
  // Rendered on the scope row, persisted on saved rows (rows[].note),
  // and printed on the finalized documents under the line description.
  function overrideNote(code) {
    _openRowEditor(code, 'note');
  }

  function applyNote(code, input) {
    const scopeEntry = state.scope.find(s => s.code === code);
    if (!scopeEntry) return true;
    scopeEntry.overrides = scopeEntry.overrides || {};
    const trimmed = String(input == null ? '' : input).trim();
    if (trimmed === '') delete scopeEntry.overrides.note;
    else scopeEntry.overrides.note = trimmed.slice(0, 500);
    state._reopenedClean = false;   // 3B
    return true;
  }

  // Row-editor buttons + Enter/Escape. `mode` is 'apply' | 'auto' | 'clear'.
  function commitRowEditor(mode) {
    if (!_rowEdit) return;
    const input = document.getElementById('v2RowEditInput');
    const value = (mode === 'auto' || mode === 'clear') ? '' : (input ? input.value : '');
    const bad = mode === 'apply' && !!(input && input.validity && input.validity.badInput);
    const ok = _rowEdit.kind === 'qty'
      ? applyQtyOverride(_rowEdit.code, value, bad)
      : applyNote(_rowEdit.code, value);
    if (!ok) { renderScope(); return; }
    _rowEdit = null;
    render();
  }

  function clearScope() {
    state.scope = [];
    state._reopenedClean = false;   // 3B
    render();
  }

  // Sync state.measurements back into the DOM inputs. Used when a
  // preset carries its own measurement defaults so the user actually
  // sees the new rawSqft / eaveLf / etc. numbers reflected in the
  // left pane, not just in the total.
  // ═════════════════════════════════════════════════════════
  // AUTO-MEASURE — Instant Roofer (default) / HOVER / EagleView / Nearmap
  // via NBDIntegrations
  //
  // 1. POST the address (+ the lead's stored lat/lng when we have them —
  //    Instant Roofer locates the roof from a point) → returns a jobId.
  //    Synchronous providers answer with the measurements already ready
  //    and we apply them on the spot.
  // 2. Otherwise poll Firestore measurements/{jobId} every 4s for up to 10 min.
  // 3. When status flips to 'ready', spread the returned fields into
  //    state.measurements and re-render.
  //
  // If the provider isn't configured (no secret), NBDIntegrations
  // surfaces a toast — we still update the status line for clarity.
  // ═════════════════════════════════════════════════════════
  let _measurePollTimer = null;
  async function autoMeasure() {
    const addrEl = document.getElementById('v2measureAddr');
    const btn    = document.getElementById('v2measureBtn');
    const statusEl = document.getElementById('v2measureStatus');
    const setStatus = (msg, color) => {
      if (statusEl) {
        statusEl.textContent = msg || '';
        statusEl.style.color = color || 'var(--m,#8b8e96)';
      }
    };

    if (!window.NBDIntegrations || typeof window.NBDIntegrations.requestMeasurement !== 'function') {
      setStatus('Integrations client not loaded yet — try again.', 'var(--red,#ff6b6b)');
      return;
    }
    const address = (addrEl && addrEl.value || state.customer.address || '').trim();
    if (!address || address.length < 5) {
      setStatus('Enter a property address first.', 'var(--red,#ff6b6b)');
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = '📐 Requesting...'; }
    setStatus('Requesting roof measurement...');

    // Send the leadId, NOT the lead's lat/lng. The server reads the same
    // coordinates itself and tags them `lead` / `geocoded`, which is the truth:
    // they come from a Nominatim `limit=1` forward geocode at save time, not
    // from a pin someone placed on the roof. Passing them here would have
    // labelled them `client` — indistinguishable from a real D2D knock pin —
    // and suppressed the confirm-the-pin warning on exactly the leads most
    // likely to be sitting on the neighbour's roof.
    const leadId = (state.customer && state.customer.leadId) || state.leadId || null;
    const result = await window.NBDIntegrations.requestMeasurement({ address, leadId });

    if (btn) { btn.disabled = false; btn.textContent = '📐 Auto-measure'; }

    if (!result || !result.ok) {
      setStatus(result && result.error ? result.error : 'Auto-measure failed.', 'var(--red,#ff6b6b)');
      return;
    }

    // Synchronous providers (Instant Roofer AI, Nearmap) hand the numbers
    // back in the callable response — apply them now, no polling needed.
    if (result.status === 'ready' && result.measurements) {
      clearInterval(_measurePollTimer);
      applyMeasurementResult(result.measurements, result);
      setStatus(measurementStatusLine(result), 'var(--green, #2ecc8a)');
      return;
    }
    // Async providers: poll the jobId's Firestore doc until the vendor
    // callback flips it to 'ready'.
    const jobId = result.jobId;
    setStatus('Job ' + jobId.slice(0, 8) + '... (~' + (result.estimatedMinutes || 30) + ' min to ready)', 'var(--orange,#BD5728)');

    clearInterval(_measurePollTimer);
    let tries = 0;
    const POLL_MS = 4000;
    const MAX_TRIES = Math.ceil((10 * 60 * 1000) / POLL_MS); // 10 min cap
    _measurePollTimer = setInterval(async () => {
      tries++;
      if (tries > MAX_TRIES) {
        clearInterval(_measurePollTimer);
        setStatus('Still processing — refresh later to pick up the result.', 'var(--m,#8b8e96)');
        return;
      }
      if (!window.db || !window.doc || !window.getDoc) return; // SDK not ready
      try {
        const snap = await window.getDoc(window.doc(window.db, 'measurements', jobId));
        if (!snap.exists()) return;
        const d = snap.data();
        if (d.status === 'ready' && d.measurements) {
          clearInterval(_measurePollTimer);
          applyMeasurementResult(d.measurements, d);
          setStatus(measurementStatusLine(d), 'var(--green, #2ecc8a)');
        } else if (d.status === 'failed') {
          clearInterval(_measurePollTimer);
          setStatus('Provider reported failure. Measure manually.', 'var(--red,#ff6b6b)');
        }
      } catch (e) { /* transient — keep polling */ }
    }, POLL_MS);
  }

  // Status line after a measurement lands: provider, confidence when the
  // vendor scored it, and a nudge when the point came from a street-
  // interpolated geocode (it may be sitting on the neighbour's roof).
  function measurementStatusLine(meta) {
    meta = meta || {};
    const m = meta.measurements || {};
    const provider = meta.provider === 'instantroofer'
      ? (meta.reportType === 'human' ? 'Instant Roofer · human certified' : 'Instant Roofer · AI')
      : (meta.provider || 'provider');
    let line = '✓ Measurements loaded (' + provider
      + (m.confidence && m.confidence.label ? ', ' + m.confidence.label.toLowerCase() + ' confidence' : '')
      + (meta.cached ? ', reused recent report' : '') + ')';
    // Warn unless the point is known to sit on the building. 'geocoded' (a
    // lead's stored Nominatim result) and 'interpolated' both mean the address
    // was resolved along a street and may land on the neighbour's roof — which
    // Instant Roofer would measure, and bill for, without complaint.
    var TRUSTED_PRECISION = ['rooftop', 'building', 'parcel-centroid', 'client'];
    if (meta.coordPrecision && TRUSTED_PRECISION.indexOf(meta.coordPrecision) === -1) {
      line += ' — the address was resolved by geocode, not a rooftop pin; check the outline is this house before pricing.';
    }

    // Everything below here is data the vendor returns on EVERY measure, that
    // we already pay for, that is already written to Firestore — and that no
    // line of code rendered anywhere. Reading it meant opening the raw doc.
    const facts = [];
    if (m.stories != null)      facts.push(m.stories + (Number(m.stories) === 1 ? ' storey' : ' storeys'));
    if (m.perimeterLf != null)  facts.push(Math.round(m.perimeterLf) + ' lf perimeter');
    if (m.facets != null)       facts.push(m.facets + ' facets');
    if (m.complexityLabel)      facts.push(String(m.complexityLabel).toLowerCase() + ' complexity');
    if (m.wastePct != null)     facts.push(m.wastePct + '% vendor waste');
    if (facts.length) line += ' · ' + facts.join(' · ');

    // Scope signals, not trivia. A commercial or attached-row building is a
    // different job from the single-family reroof this builder prices, and both
    // were being detected, paid for, stored, and silently discarded.
    if (m.isCommercial === true) {
      line += ' — ⚠ the vendor classes this building as COMMERCIAL; confirm the scope before pricing it as a house.';
    } else if (m.isTownhome === true) {
      line += ' — ⚠ classed as a townhome / attached row; check where this roof actually ends.';
    }
    return line;
  }

  // meta (optional) is the measurements doc / callable response: provider,
  // reportType, passThruEligible, passThruHasDocument, coordPrecision, cached.
  function applyMeasurementResult(m, meta) {
    meta = meta || {};
    // Each vendor uses slightly different field names — normalize.
    const next = {
      rawSqft:  numOr(m.rawSqft, state.measurements.rawSqft),
      ridgeLf:  numOr(m.ridge  || m.ridgeLf,  state.measurements.ridgeLf),
      eaveLf:   numOr(m.eave   || m.eaveLf,   state.measurements.eaveLf),
      hipLf:    numOr(m.hip    || m.hipLf,    state.measurements.hipLf),
      valleyLf: numOr(m.valley || m.valleyLf, state.measurements.valleyLf),
      rakeLf:   numOr(m.rake   || m.rakeLf,   state.measurements.rakeLf)
    };
    // Pitch arrives as '8/12', '8:12', or a bare number. parseInt('0/12') is 0
    // and parseInt('2/12') is 2 — neither is an option in #v2pitch (3–16), so
    // the <select> would go blank and the estimate would price off a rise the
    // rep never chose. Parse the same grammar the server does, normalise a
    // non-12 run, then clamp into the range the control actually offers.
    const rise = parsePitchRise(m.pitch);
    if (rise !== null) next.pitch = Math.min(16, Math.max(3, Math.round(rise)));
    function parsePitchRise(p) {
      if (p === null || p === undefined) return null;
      const mm = /^(\d+(?:\.\d+)?)\s*(?:[/:]\s*(\d+(?:\.\d+)?))?/.exec(String(p).trim());
      if (!mm) return null;
      const r = Number(mm[1]), run = mm[2] ? Number(mm[2]) : 12;
      if (!isFinite(r) || !isFinite(run) || run <= 0) return null;
      return run === 12 ? r : (r / run) * 12;
    }
    // Storey count is returned by EVERY AI measure and it PRICES: calculatePerSq
    // charges twoStoryPerSq ($15/SQ) at 2 and threeStoryPerSq ($30/SQ) at 3+
    // (estimate-builder-v2.js:921-923). state.measurements.stories defaults to 1
    // and this mapper never set it, so an auto-measured two-storey house was
    // quoted as one-storey — ~$600 silently missing on a 40 SQ roof, with the
    // right answer sitting in the response. The homeowner's own web wizard has
    // been told the storey count all along (public-measure.js publicSummary);
    // only the rep's estimate was blind to it.
    //
    // Filled ONLY while the control is still at its untouched default of 1.
    // The vendor marks this field beta/estimated, so it must never overwrite a
    // storey count a rep deliberately chose — that would invert this very bug
    // and drop $600 off a hand-corrected quote. Clamped to 1–3 because
    // #v2stories offers exactly those ("3+ Story"), and syncMeasurementInputs
    // would blank the select on any value not in the list.
    const vendorStories = numOr(m.stories, null);
    if (vendorStories !== null && Number(state.measurements.stories || 1) === 1) {
      next.stories = Math.min(3, Math.max(1, Math.round(vendorStories)));
    }

    state.measurements = Object.assign({}, state.measurements, next);

    // A measurement change has to re-resolve the document live, exactly as
    // updateMeasurement (:1202) and applyImportedMeasurements (:3741) already
    // do. Without this the vendor path was the ONE measurement path that left
    // the flag set, so on a reopened estimate effectiveEstimate() kept replaying
    // the saved rows: the builder pane showed the new numbers while Preview,
    // the presentation view, Save and the deal room all kept the old ones — and
    // a save afterwards wrote the NEW pitch beside the OLD square footage.
    state._reopenedClean = false;

    // Margin opportunity: auto-add a pass-through line for the aerial
    // measurement, billed to the homeowner at retail on the quote. Price
    // configurable via window.NBD_MEASUREMENT_PASSTHRU_PRICE; default $75.
    //
    // THE WORDING IS NOT COSMETIC. A HOVER/EagleView PDF or an Instant Roofer
    // Human Certified Report is a document the homeowner can be sent, so
    // "Aerial measurement report" is a true description of what they bought.
    // An Instant Roofer AI measure produces NO document — billing it as a
    // "report" would put a line on an invoice for something that does not
    // exist and cannot be produced if they ask for it. Same price, honest
    // description: the measurement is work performed either way.
    //
    // Skip if a pass-through for this job already exists (idempotent on retry
    // — matched by code as well, because rehydrateFromSaved resets `source`).
    const passThruPrice = Number(window.NBD_MEASUREMENT_PASSTHRU_PRICE) || 75;
    if (passThruPrice > 0 && meta.passThruEligible !== false) {
      const alreadyAdded = (state.passThru || []).some(p => p.source === 'measurement' || p.code === 'SVC MEASURE-RPT');
      if (!alreadyAdded) {
        state.passThru = state.passThru || [];
        state.passThru.push({
          code:   'SVC MEASURE-RPT',
          desc:   meta.passThruHasDocument === false
            ? 'Aerial roof measurement'
            : 'Aerial measurement report',
          amount: passThruPrice,
          source: 'measurement'
        });
      }
    }

    syncMeasurementInputs();
    render();
  }
  function numOr(v, fallback) {
    const n = Number(v);
    return isFinite(n) && n > 0 ? n : fallback;
  }

  function syncMeasurementInputs() {
    // Legacy drafts (saved before the access tier existed) lack accessLevel;
    // normalize to 'standard' so the select renders correctly (pricing is already
    // safe — undefined matches neither tier → $0 access).
    if (!state.measurements.accessLevel) state.measurements.accessLevel = 'standard';
    const map = {
      rawSqft: 'v2rawSqft', pitch: 'v2pitch', eaveLf: 'v2eaveLf',
      rakeLf: 'v2rakeLf', ridgeLf: 'v2ridgeLf', hipLf: 'v2hipLf',
      valleyLf: 'v2valleyLf', pipes: 'v2pipes', chimneys: 'v2chimneys',
      skylights: 'v2skylights', tearOffLayers: 'v2layers', stories: 'v2stories',
      accessLevel: 'v2access'
    };
    Object.keys(map).forEach(key => {
      const el = document.getElementById(map[key]);
      if (!el) return;
      const v = state.measurements[key];
      el.value = (v == null ? '' : String(v));
    });
    const cutupEl = document.getElementById('v2cutup');
    if (cutupEl) cutupEl.checked = !!state.measurements.cutUpRoof;
    // The Wave 143 add-ons were never synced here (2026-09-25, found beside
    // estimate#3): a reopened estimate WITH chimney flashing showed the box
    // unchecked, and the LF fields showed the previous session's numbers.
    const chimEl = document.getElementById('v2chimneyFlash');
    if (chimEl) chimEl.checked = !!state.measurements.hasChimneyFlash;
    const skyEl = document.getElementById('v2skylightFlash');
    if (skyEl) skyEl.checked = !!state.measurements.hasSkylightFlash;
    [['valleyMetalLf', 'v2valleyMetalLf'], ['guttersLf', 'v2guttersLf']].forEach(([key, id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      const v = state.measurements[key];
      el.value = (v == null ? '' : String(v));
    });
  }

  // Presets are objects, not bare code lists. Each preset declares:
  //   codes        — the line items to add
  //   measurements — optional measurement defaults to load (null =
  //                  keep whatever the user already typed)
  //
  // Full-roof presets (Standard Reroof, Storm Claim, Full Redeck,
  // Hail Insurance) keep measurements:null because those ARE full-
  // roof jobs and the user should type their real measurements first.
  //
  // Repair presets (Small Repair, Shingle Patch) ship with baked-in
  // small-job defaults so the line items scale to the repair size
  // instead of inheriting whatever the user had typed before.
  //
  // Disposal line choice: full-roof presets use DSP 30YD / DSP 40YD
  // (formula-gated by sq). Repair presets use DSP HAUL which is
  // manual-entry so user types their actual disposal cost.
  const PRESETS = {
    // Standard Reroof: bread-and-butter cash/insurance reroof with
    // all the finish flashing most houses actually need. Adds
    // chimney + step flashing which the prior preset was missing,
    // so the quote doesn't short the field crew on flashing labor.
    //
    // Dumpster sizes: we include all three sq-gated sizes so the
    // engine's self-selecting formulas pick exactly one based on
    // the actual roof size. A 22-sq roof gets 20YD, a 33-sq roof
    // gets 30YD, a 45-sq roof gets 40YD. The other two resolve
    // to qty=0 and sit at $0 in the scope list. User can remove
    // the zero-qty ones if they want a cleaner quote.
    'standard-reroof': {
      codes: [
        'LAB TO1', 'RFG 240-GAF-HDZ', 'RFG SYN', 'RFG IWS', 'RFG STRT',
        'RFG DRPE-AL', 'RFG RIDG-ARC', 'RFG VLY-W', 'RFG PIPE-LD',
        'RFG CHIM-STD', 'RFG STPF-AL',
        'RFG RIDG-VNT', 'RFG NAIL-C',
        'DSP 20YD', 'DSP 30YD', 'DSP 40YD',
        'PRM RES-OH', 'LAB MOB', 'LAB DEMOB', 'LAB CLN-M'
      ],
      measurements: null
    },
    // Storm Claim: Standard Reroof + insurance documentation lines
    // (LAB PHOTO, LAB WALK for adjuster walk, CUP IWS-E, CUP KICK).
    // Uses premium nail gun line and adds step flashing.
    'storm-claim': {
      codes: [
        'LAB TO1', 'RFG 240-GAF-HDZ', 'RFG SYN', 'RFG IWS', 'RFG STRT',
        'RFG DRPE-AL', 'RFG RIDG-ARC', 'RFG VLY-W', 'RFG PIPE-LD',
        'RFG CHIM-STD', 'RFG STPF-AL',
        'RFG RIDG-VNT', 'RFG NAIL-LUMA',
        'DSP 20YD', 'DSP 30YD', 'DSP 40YD',
        'PRM RES-OH', 'LAB MOB', 'LAB DEMOB', 'LAB CLN-M', 'LAB PHOTO',
        'LAB WALK', 'CUP IWS-E', 'CUP KICK'
      ],
      measurements: null
    },
    // Small Repair: 2 squares, ~20 LF of eave. Uses DSP HAUL (manual)
    // so a 10-yd dumpster doesn't get auto-zero'd by its sq-gate.
    // User can tweak rawSqft/eaveLf for their specific repair area.
    // $2,500 min-job floor applies — a crew roll-out isn't worth less.
    'small-repair': {
      codes: [
        'LAB TO1', 'RFG 240-GAF-HDZ', 'RFG SYN', 'RFG STRT', 'RFG DRPE-AL',
        'DSP HAUL', 'LAB MOB', 'LAB CLN-M'
      ],
      measurements: {
        rawSqft: 200, pitch: 8, waste: 1.15,
        ridgeLf: 0, eaveLf: 20, rakeLf: 0, hipLf: 0, valleyLf: 0, wallLf: 0,
        pipes: 0, chimneys: 0, skylights: 0, stories: 1,
        tearOffLayers: 1, deckReplacePct: 0, cutUpRoof: false
      },
      minJobCharge: 2500
    },
    // Shingle Patch: truly tiny — 10 SF / ~1 square foot of repair.
    // Barebones scope: tear-off labor, shingles, detail hourly,
    // haul-it disposal. User fills in DSP HAUL + LAB DTL-HR with
    // real numbers via the qty-override pencil.
    // $500 min-job floor — this is a trip charge, not a job-level min.
    'shingle-patch': {
      codes: [
        'LAB TO1', 'RFG 240-GAF-HDZ', 'RFG NAIL-C',
        'LAB DTL-HR', 'DSP HAUL'
      ],
      measurements: {
        rawSqft: 10, pitch: 8, waste: 1.10,
        ridgeLf: 0, eaveLf: 0, rakeLf: 0, hipLf: 0, valleyLf: 0, wallLf: 0,
        pipes: 0, chimneys: 0, skylights: 0, stories: 1,
        tearOffLayers: 1, deckReplacePct: 0, cutUpRoof: false
      },
      minJobCharge: 500
    },
    // Full Redeck: 100% deck replacement. Without this override the
    // engine used deckReplacePct=0.15 (15%) from the default — a
    // critical bug that made Full Redeck quotes read like Standard
    // Reroof quotes with an extra OSB line at 15% coverage. Now we
    // force deckReplacePct=1.0 so all decking lines scale to full
    // adjustedSqft. Also adds step flashing for completeness.
    'full-redeck': {
      codes: [
        'LAB TO1', 'RFG OSB716', 'RFG 240-GAF-HDZ', 'RFG SYN', 'RFG IWS',
        'RFG STRT', 'RFG DRPE-AL', 'RFG RIDG-ARC', 'RFG VLY-W', 'RFG PIPE-LD',
        'RFG CHIM-STD', 'RFG STPF-AL',
        'RFG RIDG-VNT', 'RFG NAIL-LUMA',
        'DSP 30YD', 'DSP 40YD',
        'PRM RES-OH', 'LAB MOB', 'LAB DEMOB', 'LAB CLN-M'
      ],
      // Partial measurement override — only the keys listed get
      // merged in, preserving whatever the user typed for rawSqft
      // / ridge / eave / etc. from their real measurements.
      measurements: {
        deckReplacePct: 1.0
      }
    },
    // Hail Damage Insurance: impact-rated shingles, code upgrades,
    // hurricane clips, chimney saddle, step flashing, full
    // insurance doc package. This is the premium claim scope.
    'hail-damage-insurance': {
      codes: [
        'LAB TO1', 'RFG ARM-GAF', 'RFG SYN-P', 'RFG IWS', 'RFG STRT-PS',
        'RFG DRPE-AL', 'RFG RIDG-IMP', 'RFG VLY-W', 'RFG PIPE-LD',
        'RFG CHIM-STD', 'RFG CHIM-SAD', 'RFG STPF-AL',
        'RFG RIDG-VNT-PR', 'RFG NAIL-LUMA',
        'DSP 30YD', 'PRM RES-OH', 'LAB MOB', 'LAB DEMOB', 'LAB CLN-M',
        'LAB PHOTO', 'LAB WALK', 'CUP IWS-E', 'CUP KICK', 'CUP HC'
      ],
      measurements: null
    },
    // TAMKO HailGuard: Class 4 (tested beyond) + the first
    // asphalt shingle with a hail warranty. Bundles the TAMKO warranty-required
    // accessories — Synthetic Guard + Moisture Guard (HailGuard hail warranty)
    // and TAMKO starter + hip&ridge (160mph wind warranty). Vents/boots stay
    // GAF/Roofivent. Modeled on hail-damage-insurance with only the 5 TAMKO
    // codes swapped, so every other code is guaranteed valid.
    'tamko-storm-hailguard': {
      codes: [
        'LAB TO1', 'RFG 240-TAMKO-HAIL', 'RFG SYN-TAMKO', 'RFG IWS-TAMKO', 'RFG STRT-TAMKO',
        'RFG DRPE-AL', 'RFG RIDG-TAMKO', 'RFG VLY-W', 'RFG PIPE-LD',
        'RFG CHIM-STD', 'RFG CHIM-SAD', 'RFG STPF-AL',
        'RFG RIDG-VNT-PR', 'RFG NAIL-LUMA',
        'DSP 30YD', 'PRM RES-OH', 'LAB MOB', 'LAB DEMOB', 'LAB CLN-M',
        'LAB PHOTO', 'LAB WALK', 'CUP IWS-E', 'CUP KICK', 'CUP HC'
      ],
      measurements: null
    }
  };

  function loadPreset(presetKey) {
    clearScope();
    const preset = PRESETS[presetKey];
    if (!preset) return;
    // If the preset ships its own measurements, overwrite state +
    // sync the DOM so the user sees the change. Otherwise leave the
    // user's typed measurements alone.
    if (preset.measurements) {
      state.measurements = Object.assign({}, state.measurements, preset.measurements);
      syncMeasurementInputs();
    }
    // Per-preset min job charge. Presets without a floor fall back
    // to the engine default ($2500). Repair presets drop it to $500
    // so a Shingle Patch quote shows the real cost instead of the
    // full-job crew-rollout minimum.
    state.minJobCharge = (preset.minJobCharge != null) ? preset.minJobCharge : null;
    // The two repair presets are repair work; every other preset is a roof.
    state.workKind = REPAIR_PRESET_KEYS.indexOf(presetKey) !== -1 ? 'repair' : 'replacement';
    (preset.codes || []).forEach(c => state.scope.push({ code: c, overrides: {} }));
    state._reopenedClean = false;   // 3B: loading a preset is an edit
    render();
  }

  // Additive scope insertion for the job-template picker (job-templates.js
  // insertIntoV2). Unlike loadPreset this does NOT clearScope. Measurements
  // and the min-job floor only apply when the scope was empty — inserting a
  // repair template into a mid-build full-roof estimate must not clobber the
  // rep's typed measurements or lower the job floor.
  function addScopeEntries(entries, measurements, opts) {
    opts = opts || {};
    const wasEmpty = !(state.scope && state.scope.length);
    const existing = {};
    (state.scope || []).forEach(s => { existing[s.code] = true; });
    let added = 0, skipped = 0;
    (entries || []).forEach(e => {
      if (!e || !e.code) return;
      if (existing[e.code]) { skipped++; return; }   // no double LAB MOB etc.
      existing[e.code] = true;
      state.scope.push({ code: e.code, overrides: Object.assign({}, e.overrides) });
      added++;
    });
    if (wasEmpty) {
      if (measurements) {
        state.measurements = Object.assign({}, state.measurements, measurements);
        syncMeasurementInputs();
      }
      if (opts.minJobCharge != null) state.minJobCharge = opts.minJobCharge;
    }
    // Roof Care Plan: replacement work anywhere in the job makes it a
    // replacement (no member discount); repair work marks an unmarked job.
    if (opts.workKind === 'replacement') state.workKind = 'replacement';
    else if (opts.workKind === 'repair' && (wasEmpty || !state.workKind)) state.workKind = 'repair';
    if (added || skipped) {
      state._reopenedClean = false;
      render();
    }
    return { added: added, skipped: skipped };
  }

  // ═════════════════════════════════════════════════════════
  // Rendering
  // ═════════════════════════════════════════════════════════

  // Shared per-SQ engine input. Used both for the retail-quote tier
  // cards (finalize) and for the canonical customer total in
  // getCurrentEstimate (V2-2/V2-pkb fix). Single source so the headline,
  // the highlighted card, and the saved grandTotal can never disagree.
  // NOTE: state.measurements.pitch is the RISE integer (e.g. 8 for 8/12);
  // parsePitch reads a bare number as the rise/run RATIO, so we pass
  // "<rise>/12" (see V2-1 fix).
  function buildPerSqInput() {
    const m = state.measurements || {};
    return {
      rawSqft:          m.rawSqft,
      pitch:            (Number(m.pitch) || 6) + '/12',   // unknown pitch → 6/12 (non-steep), never auto-charge steep
      cutUpRoof:        m.cutUpRoof,
      ridgeLf:          m.ridgeLf,
      eaveLf:           m.eaveLf,
      hipLf:            m.hipLf,
      pipes:            m.pipes,
      tearOffLayers:    m.tearOffLayers,
      hasChimneyFlash:  m.hasChimneyFlash,
      hasSkylightFlash: m.hasSkylightFlash,
      valleyMetalLf:    m.valleyMetalLf,
      guttersLf:        m.guttersLf,
      stories:          m.stories,        // Phase 1: two-story / three-story+ adders
      accessLevel:      m.accessLevel,    // Phase 1: moderate / difficult access tier
      county:           state.county,
      city:             state.county,   // permit lookup uses city or county
      mode:             state.jobMode,
      tier:             state.tier,
      // The preset / job template's own floor wins over the per-SQ roof
      // minimum (calculatePerSq precedence). null = none set → the engine
      // uses the shop's per-SQ minimum. Before 2026-10-05 (bug #5) this was
      // never sent, so a $500 preset still quoted the $2,500 roof floor.
      minJobCharge:     state.minJobCharge
    };
  }

  // Overlay a reopened line's SAVED cost basis onto the live catalog item.
  // resolveLineItem takes explicit item.materialCost / item.laborCost ahead of
  // any catalog or inferred value (estimate-logic-engine.js:787, :806), so this
  // pins a reopened line to what it was quoted at. Non-destructive: always a
  // fresh object, never a mutation of the shared catalog entry. Used by every
  // path that feeds resolveEstimate — keep them in sync.
  function withSavedCost(base, s) {
    return (s && s.savedCost) ? Object.assign({}, base, s.savedCost) : base;
  }

  // Quantity label for the scope panels.
  //
  // NEVER round a fractional quantity to a whole number. The old rule was
  // "one decimal for SQ and LF, whole numbers for everything else", so a
  // 1.5-hour detail line rendered as "2 HR" beside its correct $127.50
  // total — and $85/hr x 2 HR = $170, so the line read as arithmetic that
  // was 25% short. The math was right; the label was lying.
  //
  // SQ and LF keep the one-decimal house format (23 reads "23.0") but gain a
  // hundredths place when one carries information: job templates ship 0.35
  // and 0.7 SQ scopes, and "0.4 SQ" is the same lie in a different unit.
  // Every other unit prints whole when whole, fractional when not.
  function fmtQty(q, unit) {
    const n = Math.round((Number(q) || 0) * 100) / 100;
    const u = String(unit || '').toUpperCase();
    if (u === 'SQ' || u === 'LF') {
      return (Math.round(n * 10) / 10 === n) ? n.toFixed(1) : n.toFixed(2);
    }
    return String(n);
  }

  // The number to SHOW for one line.
  //
  // resolveEstimate stamps two figures on every line: lineTotal (the
  // contractor's COST basis) and retailTotal (what the customer is
  // charged — material at markup, labor as-is). Every customer document
  // prints retailTotal. The builder's own scope panels printed lineTotal,
  // so the same drip-edge line read $52 on screen and $61.75 on the PDF,
  // the per-line numbers never footed to the headline total, and the panel
  // that a rep quotes from was the one showing cost.
  //
  // Show retail here too. The cost basis and margin still have a home —
  // the internal rollup under the scope list — where it is labelled.
  function lineRetail(line, markupPct) {
    if (!line) return 0;
    const r = Number(line.retailTotal);
    if (Number.isFinite(r)) return r;
    const mat = Number(line.materialTotal) || 0;
    const lab = Number(line.laborTotal) || 0;
    if (mat === 0 && lab === 0) {
      return Number(line.lineTotal || line.total || ((line.quantity || 1) * (line.unitPrice || 0))) || 0;
    }
    const mkp = Number(markupPct);
    return mat * (1 + (Number.isFinite(mkp) ? mkp : 0.25)) + lab;
  }

  // Shop-wide line-item settings, read back from the Settings > Estimates
  // panel (localStorage nbd_est_settings_v3, via EstimateBuilderV2).
  //
  // The panel headed "V2 Engine · Line-Item Mode — these percentages apply
  // to every line-item estimate" was not reaching the engine: this file sent
  // resolveEstimate only { tier, mode, county }, so it fell through to its
  // own 25 / 10 / 10 defaults and a tenant who edited any of the three saw
  // no change on any estimate. Same story for the minimum charge. Forward
  // them, and only forward values that are actually numbers so a blank or
  // corrupted field can never zero out a price.
  function shopSettings() {
    try {
      if (window.EstimateBuilderV2 && typeof window.EstimateBuilderV2.loadSettings === 'function') {
        return window.EstimateBuilderV2.loadSettings() || {};
      }
    } catch (_) { /* settings are optional — the engine has its own defaults */ }
    return {};
  }

  function shopLineItemRates() {
    const s = shopSettings();
    const out = {};
    ['materialMarkupPct', 'overheadPct', 'profitPct'].forEach(function (k) {
      const raw = s[k];
      // Number(null) and Number('') are both 0, and a forwarded 0 would zero
      // out a real overhead or markup. Only an actual number counts.
      if (raw === null || raw === undefined || raw === '') return;
      const v = Number(raw);
      if (Number.isFinite(v) && v >= 0) out[k] = v;
    });
    return out;
  }

  // 0 means "no floor", which is the default and the honest one for a
  // hand-built repair. Only a positive number a human set is a floor.
  function shopRepairMinimum() {
    const v = Number(shopSettings().minRepairCharge);
    return (Number.isFinite(v) && v > 0) ? v : 0;
  }

  // The settings object every resolveEstimate call in this file should use,
  // so the tier cards, the headline and the saved estimate all price on the
  // same rules. Keep in sync with getCurrentEstimate.
  function tierSettings(tier) {
    const out = Object.assign({
      tier: tier,
      mode: state.jobMode,
      county: state.county
    }, shopLineItemRates());
    const floor = (state.minJobCharge != null) ? Number(state.minJobCharge) : shopRepairMinimum();
    if (Number.isFinite(floor) && floor > 0) out.minJobCharge = floor;
    return out;
  }

  // Does the per-SQ customer-total overlay in getCurrentEstimate apply? The
  // SAME condition it runs on, so the upgrade rule and the price cannot drift.
  function _perSqOverlayApplies() {
    return state.mode === 'per-sq'
      && state.jobMode !== 'insurance'
      && !!window.EstimateBuilderV2
      && typeof window.EstimateBuilderV2.calculateAllTiers === 'function'
      && !!state.measurements && Number(state.measurements.rawSqft) > 0;
  }

  // Why this estimate's upgrade rows are NOT in the price right now, or null
  // when they are (review of #1763, 2026-09-25). They stay in state.upgrades
  // either way, so undoing the cause brings them back; while a reason holds,
  // the scope list and the Selected list say so and a save logs them
  // "removed" instead of leaving the log claiming "chosen" for a line the
  // saved estimate no longer has.
  function _upgradesOffReason(itemsCount) {
    if (!(state.upgrades || []).length) return null;
    if (state.jobMode === 'insurance') return 'upgrades are never part of an insurance claim';
    if (_perSqOverlayApplies()) return 'a per-SQ quote prints no line items — switch to line-item to include them';
    if (!itemsCount) return 'upgrades add onto the job’s scope, and the scope is empty';
    return null;
  }

  // The scope list's warning while upgrades are out of the price ('' when
  // they are in it, or there are none).
  function _upgradesOffHtml(reason) {
    const n = (state.upgrades || []).length;
    if (!n || !reason) return '';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return '<div class="v2-upg-off" role="status" data-upg-off>⚠ ' + n + ' upgrade' + (n === 1 ? '' : 's') +
      ' the homeowner chose ' + (n === 1 ? 'is' : 'are') + ' not in this price: ' + esc(reason) + '. Saving now leaves ' +
      (n === 1 ? 'it' : 'them') + ' off this estimate.</div>';
  }

  // A total prints its cents when it has any (review of #1763, 2026-09-25:
  // upgrades add exact tax on top of the $25-rounded engine total, so a
  // whole-dollar display disagreed with the saved grandTotal).
  function _fmtTotal(n) {
    const c = Math.round((Number(n) || 0) * 100);
    const d = (c % 100 === 0) ? 0 : 2;
    return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  // Re-add a reopened estimate's upgrade rows to a live re-resolve (stage 2,
  // 2026-09-25). Each at its FROZEN face value — the quoted price never moves
  // with today's library — and taxed at the estimate's CURRENT rate with the
  // same integer rounding NBDUpgrades.price() used, so an unchanged county
  // reproduces the saved tax to the cent and a new county re-taxes exactly.
  // The engine's nearest-$25 total is kept; the upgrades add on top of it
  // (NBDUpgrades.totalsWithUpgrades, which also re-applies a job minimum to
  // the whole job instead of billing the floor gap on top).
  //
  // Not on an insurance claim and not on a per-SQ quote: upgrades never go
  // inside a claim, and a per-SQ customer paper prints no lines. The rows
  // stay in state.upgrades (switching back restores them) but price nothing.
  //
  // Review of #1763 (2026-09-25): whether upgrades price is decided by
  // _upgradesOffReason — ONE rule for the price, the scope list's warning,
  // the Selected list and the saved log — and the per-SQ half reads whether
  // the per-SQ overlay REALLY applies (_perSqOverlayApplies), not the mode
  // toggle alone: a per-SQ toggle the overlay cannot honour (no roof area)
  // prices line-item, so the upgrades stay in that price.
  function _applyUpgradeLines(estimate, itemsCount) {
    const ups = state.upgrades || [];
    if (!ups.length || !estimate) return;
    if (_upgradesOffReason(itemsCount)) return;
    const U = window.NBDUpgrades;
    const rate = Number(estimate.taxRate) || 0;
    let upgCents = 0;
    ups.forEach((r) => { upgCents += _upgradeRowCents(r); });
    const taxCents = (U && typeof U.taxCentsAt === 'function')
      ? U.taxCentsAt(upgCents, rate)
      // Same half-up integer rounding as upgrade-pricing.js taxOn — only
      // reached if the upgrade files failed to load with this bundle.
      : Math.floor((upgCents * Math.round(rate * 1e6) + 500000) / 1e6);
    if (U && typeof U.totalsWithUpgrades === 'function') {
      const t = U.totalsWithUpgrades({
        subtotal: estimate.subtotal, tax: estimate.tax, grandTotal: estimate.total,
        minJobApplied: estimate.minJobApplied, minJobCharge: estimate.minJobCharge, roundTo: 25,
      }, { upgradeCents: upgCents, taxCents: taxCents, errors: [] });
      estimate.subtotal = t.subtotal;
      estimate.tax = t.tax;
      estimate.total = t.grandTotal;
      estimate.minJobApplied = t.minJobApplied;
    } else {
      estimate.subtotal = (Math.round((Number(estimate.subtotal) || 0) * 100) + upgCents) / 100;
      estimate.tax = (Math.round((Number(estimate.tax) || 0) * 100) + taxCents) / 100;
      estimate.total = (Math.round((Number(estimate.total) || 0) * 100) + upgCents + taxCents) / 100;
    }
    estimate.lines = estimate.lines || [];
    ups.forEach((r) => {
      const cents = _upgradeRowCents(r);
      const qty = Number(r.quantity) || 1;
      const unit = Number.isFinite(Number(r.unitPrice)) ? Number(r.unitPrice) : (cents / 100) / qty;
      estimate.lines.push(Object.assign({
        code: r.code,
        name: r.desc,
        quantity: qty,
        unit: r.unit || 'EA',
        unitPrice: unit,
        // Face value, no cost basis: lineTotal == retail, like a pass-through
        // fee (finalization's lineRetailTotal and every saved-row reader take
        // retailTotal / face as-is).
        lineTotal: cents / 100,
        retailPerUnit: unit,
        retailTotal: cents / 100,
        category: r.category || 'Upgrades',
        source: 'upgrade',
        qtyOverridden: false,
      }, _upgradeTagsOf(Object.assign({}, r, { upgrade: true }))));
    });
    estimate.upgradeCents = upgCents;
    estimate.upgradeTaxCents = taxCents;
  }

  // ── Roof Care Plan member discount (2026-10-05) ─────────────────────
  // Repair work for a member: a visible "Roof Care Plan member — 10% off
  // repairs" line (care-plan-discount.js). Never on a replacement (per-SQ
  // pricing or a replacement preset/template) and never on an insurance claim.
  const REPAIR_PRESET_KEYS = ['small-repair', 'shingle-patch'];
  const _CPD = () => window.NBDCarePlanDiscount || null;
  function _isMemberDiscountLine(line) {
    const D = _CPD();
    return !!(D && D.isDiscountLine(line));
  }
  function _memberDiscountDecision() {
    const D = _CPD();
    if (!D) return null;
    return D.decide({
      lead: _linkedLeadForDeposit(),
      workKind: state.workKind,
      jobMode: state.jobMode,
      priceMode: _perSqOverlayApplies() ? 'per-sq' : 'line-item',
    });
  }
  function _applyMemberDiscount(estimate) {
    const D = _CPD();
    const d = _memberDiscountDecision();
    estimate.memberDiscountReason = d ? d.reason : null;   // read by renderScope, never persisted
    if (D && d && d.applies) D.apply(estimate);
  }
  function setWorkKind(kind) {
    const k = (kind === 'repair' || kind === 'replacement') ? kind : null;
    if (state.workKind === k) return;
    state.workKind = k;
    state._reopenedClean = false;   // it changes the price — an edit
    render();
  }
  function _fmtSignedTotal(n) {
    const c = Math.round((Number(n) || 0) * 100);
    return (c < 0 ? '−' : '') + _fmtTotal(Math.abs(c) / 100);
  }
  // A saved discount row keeps its tag and reads −$X.XX, not $-X.XX.
  function _memberDiscountTagOf(line) {
    if (!_isMemberDiscountLine(line)) return {};
    const c = Math.round((Number(line.retailPerUnit) || 0) * 100);
    return { source: 'care_plan_discount', rate: (c < 0 ? '−' : '') + '$' + (Math.abs(c) / 100).toFixed(2) };
  }
  // The note above the scope list on a member's estimate ('' otherwise).
  function _memberDiscountHtml(estimate) {
    const D = _CPD();
    const reason = estimate && estimate.memberDiscountReason;
    if (!D || !reason || reason === 'not_member') return '';
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let btn = '';
    if (reason === 'applied') btn = '<button type="button" class="ui-btn-quiet cp-note-btn" data-action="cp-work-kind" data-arg="replacement">Not repair work</button>';
    else if (reason === 'not_repair' || (reason === 'replacement' && state.mode !== 'per-sq')) btn = '<button type="button" class="ui-btn-quiet cp-note-btn" data-action="cp-work-kind" data-arg="repair">This is repair work</button>';
    const amt = reason === 'applied' && estimate.memberDiscount
      ? ' <strong class="ui-money">' + esc('−' + _fmtTotal(estimate.memberDiscount.cents / 100)) + '</strong>' : '';
    return '<div class="cp-note' + (reason === 'applied' ? ' is-on' : '') + '" role="status" data-cp-note="' + esc(reason) + '">' +
      '<span class="cp-note-text">🛡 ' + esc(D.reasonText(reason)) + amt + '</span>' + btn + '</div>';
  }

  function getCurrentEstimate() {
    const cat = window.NBD_XACT_CATALOG;
    if (!cat) return null;
    // Merge each scope entry's override.qty onto the catalog item
    // so resolveLineItem() can skip the formula. Non-destructive —
    // we spread a fresh object so the catalog's original item stays
    // untouched and other consumers see clean data.
    const items = state.scope.map(s => {
      const found = cat.find(s.code);
      if (!found) return null;
      const base = withSavedCost(found, s);
      const ov = s.overrides && s.overrides.qty;
      if (ov !== undefined && ov !== null && ov !== '') {
        return Object.assign({}, base, { _qtyOverride: Number(ov) });
      }
      return base;
    }).filter(Boolean);
    // Even if the catalog scope is empty, a pass-through line alone
    // can constitute a mini-estimate (e.g. a standalone measurement-
    // report invoice). When both are empty there's nothing to show.
    const hasPassThru = (state.passThru || []).length > 0;
    if (!items.length && !hasPassThru) return null;
    if (!window.EstimateLogic) return null;
    const settings = Object.assign({
      tier: state.tier,
      mode: state.jobMode,
      county: state.county
    }, shopLineItemRates());
    // Minimum charge, in precedence order:
    //   1. the preset or job template's own floor (state.minJobCharge)
    //   2. the shop's opt-in repair minimum from Settings > Estimates
    // There is deliberately NO third fallback. #1470 removed the hidden
    // $2,500 engine default that quoted a $555 pipe-boot repair at $2,500;
    // a floor now exists only because somebody set one.
    if (state.minJobCharge != null) {
      settings.minJobCharge = state.minJobCharge;
    } else {
      const shopMin = shopRepairMinimum();
      if (shopMin > 0) settings.minJobCharge = shopMin;
    }
    // Resolve catalog scope first. If there are no catalog items,
    // start with an empty shell so the pass-through lines can
    // produce a valid { lines, subtotal, total } structure.
    const estimate = items.length
      ? window.EstimateLogic.resolveEstimate(items, state.measurements, settings)
      : { lines: [], subtotal: 0, tax: 0, total: 0 };

    // Upgrades BEFORE pass-through fees: the job-minimum unwind in
    // _applyUpgradeLines must see the engine's own totals only (a Services
    // fee added after the floor would otherwise be pulled under it).
    _applyUpgradeLines(estimate, items.length);
    // Roof Care Plan member — 10% off repairs (2026-10-05): on the job's own
    // price (engine + upgrades), BEFORE pass-through fees, which are never
    // discounted. care-plan-discount.js decides and does the math.
    _applyMemberDiscount(estimate);
    // Read by renderScope / the Selected list (never persisted:
    // buildSavePayload names its fields).
    estimate.upgradesOffReason = _upgradesOffReason(items.length);

    // Append every pass-through line. These are flat-fee charges
    // (measurement report, e-sign fee, permit upcharge) that don't
    // scale with roof size — the engine formulas don't apply. Field
    // shape matches what resolveEstimate produces so renderScope /
    // finalizers read them uniformly.
    for (const p of (state.passThru || [])) {
      const amt = Number(p.amount) || 0;
      estimate.lines = estimate.lines || [];
      estimate.lines.push({
        code:      p.code || 'SVC CUSTOM',
        name:      p.desc || 'Service',
        quantity:  1,
        unit:      'ea',
        unitPrice: amt,
        lineTotal: amt,
        // Pass-through fees are charged at FACE — no markup, no O&P — so
        // retail == cost here. Set explicitly so retail-reading consumers
        // (invoice items, server quote, saved rows) don't re-derive it.
        retailPerUnit: amt,
        retailTotal:   amt,
        category:  'Services',
        source:    p.source || 'passthru',
        qtyOverridden: false
      });
      estimate.subtotal = (estimate.subtotal || 0) + amt;
      estimate.total    = (estimate.total    || 0) + amt;
      estimate.materialRetail = estimate.materialRetail || 0;
    }

    // ── V2-2 / V2-pkb (estimate-qa-2026-06-08): canonical customer total ──
    // For PER-SQ CASH (retail Good-Better-Best) estimates, the customer total is
    // the SELECTED tier's per-SQ price (locked spec; matches classic estimates.js
    // :522-528). The line-item resolveEstimate sum is the INTERNAL cost basis
    // (kept as internalLineItemTotal). LINE-ITEM and INSURANCE estimates keep the
    // scope total — insurance prices off the approved scope, never a retail tier,
    // so we gate on jobMode too. priceMode reflects what actually set grandTotal.
    const passThruSum = (state.passThru || [])
      .reduce((s, p) => s + (Number(p.amount) || 0), 0);
    estimate.priceMode = 'line-item';   // flipped to 'per-sq' only when the overlay applies
    if (_perSqOverlayApplies()) {
      const tiers = window.EstimateBuilderV2.calculateAllTiers(buildPerSqInput());
      // Fold flat pass-through fees (e.g. the $75 aerial-measurement report that
      // applyMeasurementResult auto-adds) into EACH tier's customer total, so the
      // tier cards, the "Your Investment" headline, prices{}, and the saved
      // grandTotal all show the SAME number — else they disagree by passThruSum
      // (a smaller resurrection of the V2-2 bug this fix exists to kill).
      if (passThruSum) {
        _v2Tiers().forEach(k => {
          if (tiers[k]) tiers[k].total = (Number(tiers[k].total) || 0) + passThruSum;
        });
      }
      const chosen = tiers[state.tier] || tiers.better;
      if (chosen) {
        estimate.internalLineItemTotal = estimate.total;   // cost basis (Internal View)
        estimate.total    = chosen.total;                  // tier price + passThru (all-in)
        estimate.subtotal = (Number(chosen.subtotal) || 0) + passThruSum;
        estimate.taxRate  = chosen.taxRate;
        estimate.tax      = chosen.tax;
        // The chosen tier's floor, not the line-item basis's (2026-10-05
        // bug #3): without these a floored per-SQ quote printed the floor gap
        // as "Rounding" and the Internal View said "Min job applied: No".
        estimate.minJobApplied = !!chosen.minJobApplied;
        estimate.minJobCharge  = Number(chosen.minJobCharge) || 0;   // floor in force, like resolveEstimate
        // The deposit is stamped on the ALL-IN customer total at the end of
        // getCurrentEstimate (_stampDeposit → deposit-rule.js). This line used
        // to be its own "cash 50% / insurance 0%" copy (2026-09-25).
        estimate.tier     = (tiers[state.tier] ? state.tier : 'better');
        // Every tier's price (five since 2026-10-02) — the deal room, portal
        // and quote read this map.
        estimate.prices   = {};
        _v2Tiers().forEach(k => { if (tiers[k]) estimate.prices[k] = tiers[k].total; });
        estimate.perSqTiers = tiers;        // .total now passThru-inclusive; reused in finalize
        estimate.priceMode  = 'per-sq';
        // Reconcile the Internal View margin to the per-SQ customer total (it was
        // computed against the line-item cost basis → understated true margin).
        const hardCost = (estimate.hardCost != null)
          ? estimate.hardCost
          : ((estimate.internal && estimate.internal.hardCost) || 0);
        estimate.internal = Object.assign({}, estimate.internal, {
          margin: estimate.total - hardCost,
          marginPct: estimate.total > 0 ? ((estimate.total - hardCost) / estimate.total) * 100 : 0
        });
      }
    }
    // A reopened Job Template estimate stays one after an edit, so its
    // documents keep the job type's workmanship warranty (see _jobTypeFieldsOf).
    // Per-SQ still wins downstream: estimateWarranty() treats a per-SQ quote
    // as roofing with a real tier.
    if (state.jobType) Object.assign(estimate, JSON.parse(JSON.stringify(state.jobType)));
    return _stampDeposit(estimate);
  }

  // ═════════════════════════════════════════════════════════
  // Deposit (2026-09-25) — deposit-rule.js is the ONE answer. Every V2
  // surface (the builder's deposit line, the on-screen Retail / Single Quote,
  // the server Retail Quote PDF, the signed contract PDF, the saved doc the invoice
  // and portal read) takes it from here, computed on the estimate's all-in
  // customer total with the live claim fields. Before: an on-screen 50/50
  // fallback, a hard-coded 25% on the server PDF and a $0 insurance deposit.
  // ═════════════════════════════════════════════════════════
  function _depositPlanFor(estimate, claim, jobMode) {
    const R = window.NBDDepositRule;
    if (!R || !estimate) return null;
    const c = claim || {};
    return R.compute({
      total: estimate.total,
      mode: jobMode || estimate.mode || 'cash',
      deductible: c.deductible,
      acv: c.acv,
      // Kentucky hold (2026-09-27): the job's address decides; an insurance
      // quote with no readable state is held, like the contract (fail closed).
      address: (state.customer && state.customer.address) || '',
      // The linked lead's claim number / carrier / jobType make it an
      // insurance job for the KY hold even when priced in cash or per-square
      // mode — the same test that puts the KY notices on the contract
      // (2026-10-03). null (no linked lead) = the rule as before.
      lead: _linkedLeadForDeposit()
    });
  }
  function _linkedLeadForDeposit() {
    const id = state.leadId || (state.customer && state.customer.leadId) || null;
    if (!id) return null;
    try {
      const cur = window._leadDoc;
      if (cur && cur.id === id) return cur;
      return (Array.isArray(window._leads) && window._leads.find((l) => l && l.id === id)) || null;
    } catch (_) { return null; }
  }
  function _stampDeposit(estimate) {
    if (!estimate) return estimate;
    const plan = _depositPlanFor(estimate, state.claim, state.jobMode);
    estimate.depositPlan = plan;
    estimate.deposit = plan ? plan.depositCents / 100 : null;
    return estimate;
  }
  // The builder's own deposit line, under the grand total: what the homeowner
  // will read, plus the rep-only notes (no deductible entered, override).
  function renderDepositLine(estimate) {
    const el = document.getElementById('v2deposit');
    if (!el) return;
    const est = estimate || ((state.scope.length || (state.passThru && state.passThru.length)) ? getCurrentEstimate() : null);
    const plan = est && est.depositPlan;
    if (!plan || !(plan.totalCents > 0)) { el.innerHTML = ''; return; }
    const e = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    el.innerHTML =
      '<div class="v2-deposit-head"><span>' + e(plan.label) + '</span><strong>' + e(plan.valueText) + '</strong></div>' +
      '<div class="v2-deposit-sum">' + e(plan.summary) + '</div>' +
      (plan.repNote ? '<div class="v2-deposit-note">' + e(plan.repNote) + '</div>' : '');
  }

  // ═════════════════════════════════════════════════════════
  // Photo embeds — pick the linked lead's photos onto the estimate.
  //
  // The pick-from set is the lead's /photos docs (team-visible since the
  // 2026-07 dual-scope work). Selection lives in state.photos [{id,url}]
  // and persists through drafts + the saved doc, so it rides everywhere:
  // presentation mode, retail/insurance doc formats, the preview sheet,
  // and the homeowner share view.
  // ═════════════════════════════════════════════════════════
  async function loadLeadPhotos(force) {
    const leadId = state.leadId || (state.customer && state.customer.leadId) || null;
    if (!leadId) { state._leadPhotos = null; renderPhotos(); return; }
    if (state._leadPhotos && state._leadPhotos._leadId === leadId && !force) return;
    if (!window.db || !window.getDocs || !window.query || !window.collection || !window.where) return;
    try {
      const snap = await window.getDocs(window.query(
        window.collection(window.db, 'photos'),
        window.where('leadId', '==', leadId)
      ));
      const list = [];
      snap.forEach(d => {
        const p = d.data() || {};
        // userId / category / phase / damageType / tags rank the deal packet's
        // inspection photos (deal-packet.js candidates); url is the rep's own
        // thumbnail here and never goes to the homeowner.
        if (p.url && !p.deleted) list.push({ id: d.id, url: p.url, userId: p.userId || null, category: p.category || '', phase: p.phase || '', damageType: p.damageType || '', tags: Array.isArray(p.tags) ? p.tags : [], _ms: (p.createdAt && p.createdAt.toMillis) ? p.createdAt.toMillis() : 0 });
      });
      list.sort((a, b) => b._ms - a._ms);
      state._leadPhotos = { _leadId: leadId, list: list.slice(0, 60) };
      renderPhotos();
    } catch (e) {
      console.warn('[estimate-v2] loadLeadPhotos failed:', e);
    }
  }

  function renderPhotos() {
    renderPacket();
    const grid = document.getElementById('v2photosGrid');
    const hint = document.getElementById('v2photosHint');
    if (!grid) return;
    const leadId = state.leadId || (state.customer && state.customer.leadId) || null;
    const escP = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    if (!leadId) {
      grid.innerHTML = '';
      if (hint) hint.textContent = 'Attach a customer to pull in their photos.';
      return;
    }
    const photos = (state._leadPhotos && state._leadPhotos.list) || [];
    if (!photos.length) {
      grid.innerHTML = '';
      if (hint) hint.textContent = state._leadPhotos
        ? 'No photos on this customer yet. Add some in Step mode (📷 Add photos) or from their customer page.'
        : 'Loading customer photos…';
      return;
    }
    const selected = new Set((state.photos || []).map(p => p.id || p.url));
    if (hint) hint.textContent = (state.photos || []).length
      ? (state.photos.length + ' photo' + (state.photos.length === 1 ? '' : 's') + ' will ride this estimate — presentation, printed quote, and shared link.')
      : 'Tap photos to include them on this estimate — they show in the homeowner presentation, the printed quote, and the shared link.';
    grid.innerHTML = photos.map(p => {
      const on = selected.has(p.id) || selected.has(p.url);
      return '<button type="button" data-action="toggle-photo" data-arg="' + escP(p.id) + '"' +
        ' style="position:relative;padding:0;border-radius:8px;overflow:hidden;cursor:pointer;aspect-ratio:1;' +
        'border:2px solid ' + (on ? 'var(--orange,#BD5728)' : 'var(--br,#2a2f35)') + ';background:var(--s,#111418);">' +
        '<img src="' + escP(p.url) + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;' + (on ? '' : 'opacity:.75;') + '">' +
        (on ? '<span style="position:absolute;top:4px;right:4px;background:var(--orange,#BD5728);color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;">✓</span>' : '') +
        '</button>';
    }).join('');
  }

  function togglePhoto(photoId) {
    const all = (state._leadPhotos && state._leadPhotos.list) || [];
    const photo = all.find(p => p.id === photoId);
    if (!photo) return;
    const cur = state.photos || [];
    const idx = cur.findIndex(p => (p.id || p.url) === photoId || p.url === photo.url);
    if (idx >= 0) cur.splice(idx, 1);
    else cur.push({ id: photo.id, url: photo.url });
    state.photos = cur;
    state._reopenedClean = false;
    renderPhotos();
    saveDraftDebounced();
  }

  // W142 tier change, extracted from the dispatcher so the Phase-3
  // presentation tier cards drive the exact same path as the Setup tabs.
  function setTierChoice(arg) {
    if (_v2Tiers().indexOf(arg) === -1) return;
    state.tier = arg;
    state._reopenedClean = false;   // 3B: tier change → re-resolve
    _v2EnforceTierShingles(arg);    // Beyond → HailGuard, Economy → no 3-tab
    _v2Tiers().forEach(t => {
      const b = document.getElementById(_v2TierBtnId(t));
      if (b) b.classList.toggle('active', t === arg);
    });
    render();
    saveDraftDebounced();
  }

  // ═════════════════════════════════════════════════════════
  // Phase 3 — homeowner presentation mode
  //
  // Good/Better/Best side-by-side for the kitchen table: the rep hands
  // the phone over instead of reading numbers aloud. Tapping a tier IS
  // a real tier change (setTierChoice — same path as the Setup tabs),
  // and "Sign Now" opens the in-house signing page on this device. Homeowner-
  // clean: no margins, costs, or internal numbers anywhere.
  // ═════════════════════════════════════════════════════════

  // Three tier totals for the compare cards. Per-SQ mode already carries
  // estimate.prices {good,better,best}. Line-item mode computes the other
  // two tiers with a temporary state.tier swap through getCurrentEstimate
  // (pure compute — no render, no _reopenedClean flip). The CURRENT tier
  // shows the truthful replay-aware number from effectiveEstimate ONLY when
  // it agrees with the like-for-like figure; on disagreement, or when all
  // three price the same, this returns a single tier so the caller renders
  // one honest total instead of a comparison it cannot stand behind.
  function triTierTotals(current) {
    const _none = () => { const o = {}; _v2Tiers().forEach(t => { o[t] = null; }); return o; };
    if (current.prices && current.prices.good != null) {
      const o = _none();
      _v2Tiers().forEach(t => { if (current.prices[t] != null) o[t] = current.prices[t]; });
      return o;
    }
    // Compute ALL THREE from the SAME source, including the current tier.
    //
    // This used to take the current tier from effectiveEstimate() and its two
    // siblings from getCurrentEstimate(). Those are different code paths, so
    // the three cards could disagree for reasons that have nothing to do with
    // tier. Joe hit exactly that: a homeowner was shown GOOD $2,500 /
    // BETTER $725 / BEST $2,500 — "Better" cheaper than "Good", "Good" equal
    // to "Best". Three prices from two engines is not a comparison.
    const orig = state.tier;
    const out = _none();
    _v2Tiers().forEach(t => {
      try {
        state.tier = t;
        const e = getCurrentEstimate();
        out[t] = e ? e.total : null;
      } catch (err) {
        out[t] = null;
      }
    });
    state.tier = orig;

    // The selected tier's truthful, replay-aware number still wins on its own
    // card — but only when it AGREES with the like-for-like figure. If the two
    // sources disagree, the comparison cannot be trusted, so show no
    // comparison: returning just the current tier drops openPresentation into
    // its existing single-total card ("fewer than 2 priced tiers → no fake
    // compare"), which is the honest output.
    const same = out[orig];
    const truth = current.total;
    const bothNumbers = typeof same === 'number' && typeof truth === 'number';
    if (bothNumbers && Math.round(same) !== Math.round(truth)) {
      return Object.assign(_none(), { [orig]: truth });
    }
    if (bothNumbers) out[orig] = truth;

    // Tiers that all price identically are not tiers. A line-item repair
    // scope prices off the scope, so all three come out equal — and three
    // cards reading the same figure under "fits the budget" /
    // "most popular" / "top-of-the-line" promises the homeowner a choice
    // that does not exist. Collapse to the single total card.
    const vals = _v2Tiers()
      .map(t => out[t]).filter(v => typeof v === 'number').map(v => Math.round(v));
    if (vals.length >= 2 && vals.every(v => v === vals[0])) {
      return Object.assign(_none(), { [orig]: out[orig] });
    }
    return out;
  }

  function openPresentation() {
    const modal = document.getElementById('estV2Modal');
    if (!modal) return;
    const estimate = effectiveEstimate();
    if (!estimate) {
      if (window.showToast) window.showToast('Add line items to the scope first', 'info');
      return;
    }
    const escP = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = (n) => (n == null || !isFinite(Number(n)))
      ? null : '$' + Math.round(Number(n)).toLocaleString('en-US');

    const tiers = triTierTotals(estimate);
    const BLURB = {
      economy: 'A new roof for less — ' + ((typeof window !== 'undefined' && window.NBD_ESTIMATE_CONFIG && window.NBD_ESTIMATE_CONFIG.TIER_LABOR_YEARS && window.NBD_ESTIMATE_CONFIG.TIER_LABOR_YEARS.economy) || 1) + '-year labor warranty.',
      good: 'Solid protection that fits the budget.',
      better: 'Our most popular package — the sweet spot.',
      best: 'Top-of-the-line materials and warranty.',
      beyond: 'TAMKO HailGuard — the only shingle with a hail warranty.'
    };
    const LABEL = {};
    _v2Tiers().forEach(t => { LABEL[t] = _v2TierLabel(t); });
    const cardOrder = _v2Tiers().filter(t => fmt(tiers[t]) !== null);

    const cards = cardOrder.length >= 2
      ? cardOrder.map(t =>
          '<button type="button" class="vp-card' + (state.tier === t ? ' active' : '') + '" data-action="pres-tier" data-arg="' + t + '">' +
            '<div class="vp-tier">' + LABEL[t] + '</div>' +
            '<div class="vp-price">' + fmt(tiers[t]) + '</div>' +
            '<div class="vp-blurb">' + BLURB[t] + '</div>' +
            '<div class="vp-pick">' + (state.tier === t ? '✓ Selected' : 'Tap to select') + '</div>' +
          '</button>').join('')
      // Fewer than 2 priced tiers → a single clean total card, no fake compare.
      : '<div class="vp-card active" style="cursor:default;">' +
          '<div class="vp-tier">Your Project</div>' +
          '<div class="vp-price">' + (fmt(estimate.total) || '$0') + '</div>' +
          '<div class="vp-blurb">Full scope as reviewed with your estimator.</div>' +
        '</div>';

    let pres = document.getElementById('v2Present');
    if (!pres) {
      pres = document.createElement('div');
      pres.id = 'v2Present';
      pres.className = 'v2-present';
      modal.appendChild(pres);
    }
    // Photo strip — the selected photos, homeowner-facing ("here's YOUR
    // roof"). Horizontal scroll keeps any count tidy on a phone.
    const photoStrip = (state.photos && state.photos.length)
      ? '<div style="display:flex;gap:8px;overflow-x:auto;padding:4px 22px 0;-webkit-overflow-scrolling:touch;">' +
          state.photos.map(p =>
            '<img src="' + escP(p.url) + '" alt="" loading="lazy" ' +
            'style="height:110px;border-radius:10px;flex:none;border:1px solid var(--br,#2a2f35);">'
          ).join('') +
        '</div>'
      : '';

    pres.innerHTML =
      '<div class="vp-hdr">' +
        '<div class="vp-name">' + (escP(state.customer.name) || 'Your Roofing Estimate') + '</div>' +
        (state.customer.address ? '<div class="vp-addr">' + escP(state.customer.address) + '</div>' : '') +
      '</div>' +
      photoStrip +
      '<div class="vp-cards">' + cards + '</div>' +
      '<div class="vp-foot">' +
        '<div class="vp-total">' + (fmt(estimate.total) || '$0') + '</div>' +
        '<button type="button" class="vp-sign" data-action="pres-sign">✍ Sign Now</button>' +
        '<button type="button" class="vp-done" data-action="pres-close">Done</button>' +
      '</div>';
    pres.classList.add('open');
  }

  function closePresentation() {
    const pres = document.getElementById('v2Present');
    if (pres) pres.classList.remove('open');
  }

  // Phase 1b: switch the mobile step (no-op visually on desktop — the
  // CSS only hides panes inside the ≤1000px media query). Scrolls the
  // newly shown pane to its top so each step starts at its beginning.
  function setMobileStep(n) {
    const modal = document.getElementById('estV2Modal');
    if (!modal) return;
    const step = String(n);
    modal.dataset.mstep = step;
    modal.querySelectorAll('.v2-mstep-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.arg === step);
    });
    const pane = modal.querySelector(step === '1' ? '.pane-setup' : step === '2' ? '.pane-items' : '.pane-review');
    if (pane) pane.scrollTop = 0;
    const body = modal.querySelector('.v2-body');
    if (body) body.scrollTop = 0;
  }

  function renderCatalog() {
    const catDiv = document.getElementById('v2items');
    const catTabs = document.getElementById('v2cats');
    if (!catDiv || !catTabs) return;

    const cat = window.NBD_XACT_CATALOG;
    if (!cat) {
      catDiv.innerHTML = '<div class="v2-empty">Catalog still loading...</div>';
      return;
    }

    // Category chips — use data-action + data-arg so the
    // delegated click handler dispatches them, keeping this
    // file CSP-strict (no inline onclick attributes).
    const escAttr = (s) => String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    // "✓ Selected (N)" chip — collapses the 278-item catalog down to just
    // what's actually on this estimate. Step ② shows a selection COUNT but
    // never said WHICH items, so checking your picks meant leaving the
    // catalog for the Review step and coming back. Only rendered when
    // something is selected, so a fresh estimate isn't cluttered.
    const selectedCount = (state.scope || []).length + ((state.passThru || []).length) + ((state.upgrades || []).length);
    // If the last selection was removed while viewing it, fall back to All.
    if (state.categoryFilter === 'selected' && selectedCount === 0) state.categoryFilter = 'all';

    const cats = Object.keys(cat.byCategory || {}).sort();
    catTabs.innerHTML = [
      selectedCount
        ? `<button type="button" class="${state.categoryFilter === 'selected' ? 'active' : ''}" data-action="set-category" data-arg="selected" style="${state.categoryFilter === 'selected' ? '' : 'border-color:var(--green,#2ecc8a);color:var(--green,#2ecc8a);'}">✓ Selected (${selectedCount})</button>`
        : '',
      `<button type="button" class="${state.categoryFilter === 'all' ? 'active' : ''}" data-action="set-category" data-arg="all">All</button>`,
      ...cats.map(c =>
        `<button type="button" class="${state.categoryFilter === c ? 'active' : ''}" data-action="set-category" data-arg="${escAttr(c)}">${escAttr(c)} (${cat.byCategory[c].length})</button>`
      )
    ].join('');

    // Selected view renders its own card shape (qty + line total + remove),
    // so it short-circuits the catalog filtering below entirely.
    if (state.categoryFilter === 'selected') {
      renderSelectedList(catDiv, cat);
      return;
    }

    // Filter items
    let items = state.categoryFilter === 'all' ? cat.items : cat.byCategory[state.categoryFilter] || [];
    if (state.searchFilter) {
      const q = state.searchFilter.toLowerCase();
      items = items.filter(i =>
        (i.name || '').toLowerCase().includes(q) ||
        (i.code || '').toLowerCase().includes(q) ||
        (i.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }

    // Limit to first 50 for performance; user can refine with search
    const limited = items.slice(0, 50);
    const totalCount = items.length;

    // Simple HTML escape for attributes + text nodes. Catalog codes
    // are alphanumeric today but this guards against any future
    // catalog entry containing quotes or HTML special characters
    // that would break out of an attribute and become an XSS sink.
    const esc = (s) => String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    catDiv.innerHTML = limited.map(item => {
      const inScope = !!state.scope.find(s => s.code === item.code);
      const mat = Number(item.materialCost) || 0;
      const lab = Number(item.laborCost) || 0;
      const unitCost = mat + lab;
      // data-code is read by the delegated click handler installed
      // on #v2items in ensureModal(). No inline onclick attribute so
      // this stays clean under the Report-Only CSP (script-src-attr 'none').
      return `
        <div class="v2-item" data-action="add-to-scope" data-code="${esc(item.code)}" ${inScope ? 'style="border-color:var(--green,#065f46);background:color-mix(in srgb, var(--green,#065f46) 12%, var(--bg,#0a0c0f));"' : ''}>
          <div style="flex:1;min-width:0;">
            <div class="code">${esc(item.code)} ${_v2TierBadgeHtml(item.tier)}</div>
            <div class="name">${esc((item.name || '').substring(0, 60))}${(item.name || '').length > 60 ? '…' : ''}</div>
          </div>
          <div class="cost">
            <div style="color:var(--t,#e8eaf0);font-weight:700;">$${unitCost.toFixed(0)}</div>
            <div style="font-size:9px;">/${esc(item.unit)}</div>
            ${inScope ? '<div style="color:var(--green,#065f46);font-size:9px;margin-top:2px;">✓ IN SCOPE</div>' : ''}
          </div>
        </div>
      `;
    }).join('');

    if (totalCount > limited.length) {
      catDiv.innerHTML += `<div class="v2-empty">Showing ${limited.length} of ${totalCount}. Type to refine search.</div>`;
    }
    if (!items.length) {
      catDiv.innerHTML = '<div class="nbd-empty" style="padding:24px 8px;"><div class="ne-icon">🔍</div><div class="ne-msg">No items match your search</div><div class="ne-sub">Try a different code, name, or tag.</div></div>';
    }
  }

  // "✓ Selected" view for the Items step — the picked items with their
  // RESOLVED quantity and line total (not catalog list price), so it reads
  // as a real mini scope list rather than a filtered catalog. Each row
  // removes with ×; tapping the row itself does nothing here (addToScope
  // no-ops on an item already in scope, which would feel broken).
  function renderSelectedList(catDiv, cat) {
    const esc = (s) => String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // Resolved lines give the real qty/total. Best-effort: if the engine
    // isn't ready we still list the picks with their catalog identity.
    let byCode = {};
    let markupPct = null;
    // Upgrades out of the price: the estimate's own reason, or (no estimate:
    // nothing in the scope) the empty-scope one.
    let upOffReason = _upgradesOffReason(0);
    try {
      const est = getCurrentEstimate();
      (est && est.lines || []).forEach(l => { byCode[l.code] = l; });
      if (est && est.materialMarkupPct != null) markupPct = est.materialMarkupPct;
      if (est) upOffReason = est.upgradesOffReason || null;
    } catch (e) { byCode = {}; }

    const rows = [];
    (state.scope || []).forEach(s => {
      const item = (cat && typeof cat.find === 'function' && cat.find(s.code)) || null;
      const line = byCode[s.code];
      rows.push({
        code: s.code,
        name: (line && line.name) || (item && item.name) || s.code,
        qty: line ? (Number(line.quantity) || 0) : null,
        unit: (line && line.unit) || (item && item.unit) || '',
        total: line ? lineRetail(line, markupPct) : null,
        overridden: !!(line && line.qtyOverridden),
        tier: (line && line.tier) || (item && item.tier) || null
      });
    });
    (state.passThru || []).forEach(p => {
      rows.push({
        code: p.code, name: p.desc || 'Service', qty: 1, unit: 'ea',
        total: Number(p.amount) || 0, overridden: false, passThru: true
      });
    });
    // Upgrade rows at their quoted face value (stage 2, 2026-09-25) — or,
    // while they are out of the price, no amount and the reason (review of
    // #1763: they used to list at full price beside a total without them).
    const upOff = upOffReason;
    (state.upgrades || []).forEach(r => {
      rows.push({
        code: r.code, name: r.desc || 'Upgrade', qty: Number(r.quantity) || 1, unit: r.unit || '',
        total: upOff ? null : _upgradeRowCents(r) / 100, overridden: false, upgradeOff: upOff
      });
    });

    if (!rows.length) {
      catDiv.innerHTML = '<div class="nbd-empty" style="padding:24px 8px;"><div class="ne-icon">🧾</div><div class="ne-msg">Nothing selected yet</div><div class="ne-sub">Pick items from All or a category.</div></div>';
      return;
    }

    const sum = rows.reduce((s, r) => s + (r.total || 0), 0);
    catDiv.innerHTML =
      rows.map(r => {
        const qtyStr = r.qty != null
          ? fmtQty(r.qty, r.unit) + ' ' + esc(r.unit)
          : '—';
        return `
        <div class="v2-item" data-code="${esc(r.code)}" style="border-color:var(--green,#2ecc8a);background:color-mix(in srgb, var(--green,#2ecc8a) 10%, var(--bg,#0a0c0f));">
          <div style="flex:1;min-width:0;">
            <div class="code">${esc(r.code)}${r.passThru ? ' · PASS-THRU' : ''} ${_v2TierBadgeHtml(r.tier)}</div>
            <div class="name">${esc((r.name || '').substring(0, 60))}${(r.name || '').length > 60 ? '…' : ''}</div>
            <div style="font-size:10px;color:var(--m,#98a0ab);margin-top:2px;">${qtyStr}${r.overridden ? ' · <span style="color:var(--blue,#22d3ee);">manual</span>' : ''}</div>
            ${_v2TierMismatch(r.tier) ? '<div class="tier-warn">⚠ ' + esc(r.tier) + '-tier item on a ' + esc(state.tier) + '-tier job</div>' : ''}
            ${r.upgradeOff ? '<div class="tier-warn">⚠ Not in this price: ' + esc(r.upgradeOff) + '</div>' : ''}
          </div>
          <div class="cost" style="display:flex;align-items:center;gap:8px;">
            <div style="text-align:right;">
              <div style="color:var(--t,#e8eaf0);font-weight:700;">${r.total != null ? '$' + Math.round(r.total).toLocaleString() : '—'}</div>
            </div>
            <button type="button" data-action="remove-selected" data-code="${esc(r.code)}" title="Remove from estimate"
              style="background:none;border:1px solid var(--br,#2a2f35);color:var(--m,#98a0ab);border-radius:6px;width:30px;height:30px;font-size:15px;line-height:1;cursor:pointer;flex:none;">×</button>
          </div>
        </div>`;
      }).join('') +
      `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:12px 4px 4px;border-top:1px solid var(--br,#2a2f35);margin-top:8px;">
         <span style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--m,#98a0ab);">${rows.length} item${rows.length === 1 ? '' : 's'}</span>
         <span style="font-family:'Barlow Condensed',sans-serif;font-size:18px;font-weight:800;color:var(--green,#2ecc8a);">$${Math.round(sum).toLocaleString()}</span>
       </div>`;
  }

  // Markup for the inline row editor (estimate#6). Every interpolated value
  // goes through the caller's escaper — the note is rep-typed text.
  function _rowEditorHtml(line, scopeEntry, esc) {
    const kind = _rowEdit.kind;
    const ov = (scopeEntry && scopeEntry.overrides) || {};
    const err = _rowEdit.error ? `<div class="v2-row-edit-err" role="alert">${esc(_rowEdit.error)}</div>` : '';
    const common = `id="v2RowEditInput" data-code="${esc(line.code)}" data-kind="${kind}" enterkeyhint="done"`;
    if (kind === 'qty') {
      const unit = line.unit || '';
      const now = fmtQty(line.quantity, unit);
      const manual = ov.qty != null;
      return `
          <div class="v2-row-edit">
            <label class="v2-row-edit-lbl" for="v2RowEditInput">Quantity${unit ? ' (' + esc(unit) + ')' : ''} — now ${esc(now)}${manual ? ' manual' : ' auto'}. Leave blank for auto.</label>
            <div class="v2-row-edit-ctl">
              <input ${common} type="number" inputmode="decimal" min="0" step="any" value="${manual ? esc(String(ov.qty)) : ''}">
              <button type="button" class="primary" data-action="row-edit-apply">Set</button>
              ${manual ? '<button type="button" data-action="row-edit-auto">Auto</button>' : ''}
              <button type="button" data-action="row-edit-cancel">Cancel</button>
            </div>
            ${err}
          </div>`;
    }
    const note = ov.note || '';
    return `
          <div class="v2-row-edit">
            <label class="v2-row-edit-lbl" for="v2RowEditInput">Note — prints under this line on the estimate documents.</label>
            <div class="v2-row-edit-ctl">
              <input ${common} type="text" maxlength="500" value="${esc(note)}">
              <button type="button" class="primary" data-action="row-edit-apply">Save</button>
              ${note ? '<button type="button" data-action="row-edit-clear">Remove</button>' : ''}
              <button type="button" data-action="row-edit-cancel">Cancel</button>
            </div>
            ${err}
          </div>`;
  }

  function renderScope() {
    const listDiv = document.getElementById('v2scopeList');
    const totalEl = document.getElementById('v2total');
    const rollupEl = document.getElementById('v2rollup');
    if (!listDiv) return;

    // Only show the empty state when BOTH the catalog scope and
    // the pass-through list are empty. A standalone "$75 measurement
    // report" quote is valid.
    if (!state.scope.length && !(state.passThru && state.passThru.length)) {
      listDiv.innerHTML = '<div class="nbd-empty" style="padding:24px 8px;"><div class="ne-icon">🧾</div><div class="ne-msg">No items selected yet</div><div class="ne-sub">Pick from the catalog or load a preset.</div></div>' +
        _upgradesOffHtml(_upgradesOffReason(0));
      totalEl.textContent = '$0';
      const mT0 = document.getElementById('v2mTotal');
      if (mT0) mT0.textContent = '$0';
      rollupEl.innerHTML = '';
      renderDepositLine(null);
      return;
    }

    const estimate = getCurrentEstimate();
    if (!estimate) {
      listDiv.innerHTML = '<div class="v2-empty">Engine loading...</div>';
      return;
    }

    // Escape every interpolated value so catalog data (today trusted,
    // tomorrow possibly user-editable) can never smuggle markup into
    // the scope list. Consistent with the data-code pattern introduced
    // in the CRITICAL-1 fix for the catalog renderer above.
    const escLocal = (s) => String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    // Hide zero-qty dumpster lines (DSP 20YD / 30YD / 40YD) so
    // when a preset loads all three sizes only the one the engine
    // self-selected for the actual roof size actually renders.
    // User can still remove the live one via the × button; if they
    // want an alternate size, they re-add from the catalog.
    // Only dumpster codes are filtered — every other zero-qty line
    // (e.g. step flashing with wallLf=0) still shows so the user
    // can see what's in scope and pencil a quantity in.
    const visibleLines = estimate.lines.filter(line => {
      if (line.quantity > 0) return true;
      // Filter zero-qty auto-gated dumpsters
      if (/^DSP\s+\d+YD$/.test(line.code)) return false;
      return true;
    });

    // An open row editor survives a re-render with what the rep has typed so
    // far (and its focus), so a background render can't eat a half-typed
    // quantity.
    const prevEditEl = _rowEdit ? document.getElementById('v2RowEditInput') : null;
    const prevEdit = (prevEditEl && prevEditEl.dataset.code === _rowEdit.code
        && prevEditEl.dataset.kind === _rowEdit.kind)
      ? { value: prevEditEl.value, focused: document.activeElement === prevEditEl }
      : null;

    listDiv.innerHTML = _upgradesOffHtml(estimate.upgradesOffReason) + _memberDiscountHtml(estimate) + visibleLines.map(line => {
      const safeQty = fmtQty(line.quantity, line.unit);
      const overridden = !!line.qtyOverridden;
      // Per-line rep note (overrides.note) — annotation only, shown here
      // and printed under the line on the finalized documents.
      const noteEntry = state.scope.find(s => s.code === line.code);
      const lineNote = (noteEntry && noteEntry.overrides && noteEntry.overrides.note) || '';
      const editing = !!(_rowEdit && noteEntry && _rowEdit.code === line.code);
      // data-action + data-code get picked up by the delegated click
      // handler on #v2scopeList installed in ensureModal(). Clean under
      // Report-Only CSP (script-src-attr 'none') — zero inline onclicks.
      // The pencil (edit-qty) lets the user set a manual quantity that
      // bypasses the measurement-based formula.
      // An upgrade row is a quoted, frozen price the homeowner picked: it can
      // be removed (with undo) but not re-quantified or annotated here.
      const isUpg = line.upgrade === true;
      // The Roof Care Plan member line: shown, never edited or removed here
      // (the note above the list says why it is on and how to change it).
      if (_isMemberDiscountLine(line)) {
        return '<div class="v2-scope-item cp-discount-row" data-code="' + escLocal(line.code) + '">' +
          '<div class="total">' + escLocal(_fmtSignedTotal(line.retailTotal)) + '</div>' +
          '<div class="name">' + escLocal(line.name || '') + '</div>' +
          '<div class="qty">Roof Care Plan member price</div></div>';
      }
      return `
        <div class="v2-scope-item${overridden ? ' overridden' : ''}${isUpg ? ' upgrade' : ''}" data-code="${escLocal(line.code)}">
          <div class="actions">
            ${isUpg ? '<span class="edit-note v2-act-ph" aria-hidden="true"></span><span class="edit-qty v2-act-ph" aria-hidden="true"></span>' : `<button class="edit-note" type="button" data-action="edit-note" title="${lineNote ? 'Edit note' : 'Add note'}" style="${lineNote ? 'color:var(--orange,#BD5728);' : ''}">📝</button>
            <button class="edit-qty" type="button" data-action="override-qty" title="Edit quantity">✎</button>`}
            <button class="rm" type="button" data-action="remove-from-scope" title="Remove">×</button>
          </div>
          <div class="total">$${Math.round(lineRetail(line, estimate.materialMarkupPct)).toLocaleString()}</div>
          <div class="name">${escLocal(isUpg ? (line.name || '') : (line.name || '').substring(0, 38))}</div>
          <div class="qty">${safeQty} ${escLocal(line.unit)} · ${escLocal(line.code)}${overridden ? ' · <span style="color:var(--blue,#22d3ee);">manual</span>' : ''}${isUpg ? ' · <span style="color:var(--orange,#BD5728);">upgrade · quoted price</span>' : ''}</div>
          ${lineNote ? `<div class="line-note" style="font-size:11px;color:var(--m,#9ca3af);font-style:italic;margin-top:2px;">📝 ${escLocal(lineNote)}</div>` : ''}
          ${_v2TierMismatch(line.tier) ? `<div class="tier-warn">⚠ ${escLocal(line.tier)}-tier item on a ${escLocal(state.tier)}-tier job</div>` : ''}
          ${editing ? _rowEditorHtml(line, noteEntry, escLocal) : ''}
        </div>
      `;
    }).join('');

    if (prevEdit) {
      const el = document.getElementById('v2RowEditInput');
      if (el) {
        el.value = prevEdit.value;
        if (prevEdit.focused) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }
      }
    }

    totalEl.textContent = _fmtTotal(estimate.total);
    // Phase 1b: mirror into the mobile step bar's always-visible total.
    const mT = document.getElementById('v2mTotal');
    if (mT) mT.textContent = _fmtTotal(estimate.total);
    renderDepositLine(estimate);

    const taxDisplay = estimate.taxRate > 0
      ? `<br>Tax: <strong>$${Math.round(estimate.tax).toLocaleString()}</strong> (${(estimate.taxRate * 100).toFixed(2)}%)`
      : '<br>Tax: <strong>Insurance mode (no tax)</strong>';

    rollupEl.innerHTML = `
      Material: <strong>$${Math.round(estimate.materialRetail).toLocaleString()}</strong><br>
      Labor: <strong>$${Math.round(estimate.laborCost).toLocaleString()}</strong><br>
      OH+Profit: <strong>$${Math.round(estimate.overhead + estimate.profit).toLocaleString()}</strong>
      ${taxDisplay}
      <br><span style="color:var(--green,#065f46);">Margin: <strong>${estimate.internal.marginPct.toFixed(1)}%</strong> ($${Math.round(estimate.internal.margin).toLocaleString()})</span>
    `;
  }

  function render() {
    // Tier shingle lock on EVERY scope path (V3 E2E 2026-10-02).
    if (_v2EnforceTierShingles(state.tier)) state._reopenedClean = false;
    renderCatalog();
    renderScope();
    renderPhotos();
    _paintModeHint();
    _applyKySigningGate();
    // F7: debounced autosave on every render. Cheap — just a JSON
    // write to localStorage. Firestore backup fires on a slower
    // cadence so network blips don't cost the rep their work.
    saveDraftDebounced();
    // V3 step layer (estimate-v3-wizard.js) repaints its bar + cards.
    if (window.EstimateV3 && typeof window.EstimateV3.onRender === 'function') {
      try { window.EstimateV3.onRender(); } catch (e) { console.warn('[v3] onRender failed:', e); }
    }
  }

  // ═════════════════════════════════════════════════════════
  // AUTOSAVE DRAFTS (F7)
  //
  // Writes state to localStorage on every render, and syncs to
  // Firestore estimate_drafts/{uid} at most once every 10s so
  // reloads + device switches pick up where the rep left off.
  // Draft is cleared on a successful save() or when a new builder
  // session is opened with a different linked leadId.
  // ═════════════════════════════════════════════════════════
  const DRAFT_KEY_LOCAL = 'nbd_v2_draft_v1';
  let _draftLocalTimer = null;
  let _draftRemoteTimer = null;
  let _lastDraftRemotePush = 0;

  function collectDraft() {
    return {
      mode: state.mode,
      tier: state.tier,
      jobMode: state.jobMode,
      county: state.county,
      measurements: state.measurements,
      scope: state.scope,
      customer: state.customer,
      claim: state.claim,
      passThru: state.passThru,
      photos: state.photos,
      minJobCharge: state.minJobCharge,
      // An edited Job Template estimate restored from this draft must still
      // print its job type's warranty, not roofing's (2026-09-25).
      jobType: state.jobType,
      workKind: state.workKind,
      // …and still carry the homeowner's upgrades (stage 2, 2026-09-25).
      upgrades: state.upgrades,
      upgradeLog: state.upgradeLog,
      savedAt: Date.now()
    };
  }

  // Audit #21: both catch blocks were fully silent — if localStorage quota
  // blew up OR the Firestore push kept failing (offline/permissions), the
  // user had no idea their draft wasn't saving. We now log both errors and
  // surface a one-shot toast the first time a Firestore push fails in a
  // session so reps don't think "I saved it" when they didn't.
  let _draftRemoteErrorNotified = false;

  function saveDraftDebounced() {
    // 3B: a freshly-reopened (unedited) estimate must not overwrite the rep's
    // in-progress new-estimate draft. Once they actually edit (_reopenedClean
    // flips false) autosave resumes normally.
    if (state._reopenedClean) return;
    clearTimeout(_draftLocalTimer);
    _draftLocalTimer = setTimeout(() => {
      _draftLocalTimer = null;   // "pending" is observable (_flushDraftNow)
      try {
        const payload = collectDraft();
        localStorage.setItem(DRAFT_KEY_LOCAL, JSON.stringify(payload));
      } catch (e) {
        // QuotaExceededError means old drafts need clearing; tell the user.
        console.warn('[estimate-v2] localStorage draft save failed:', e);
        window.showToast?.('Could not auto-save draft locally — browser storage is full. Clear old drafts or save manually.', 'warning', 6000);
      }
      // Firestore push at most every 10s.
      const now = Date.now();
      if (now - _lastDraftRemotePush > 10_000) {
        _lastDraftRemotePush = now;
        pushDraftToFirestore().catch(err => {
          console.warn('[estimate-v2] draft push to Firestore failed:', err);
          if (!_draftRemoteErrorNotified) {
            _draftRemoteErrorNotified = true;
            window.showToast?.('Cloud auto-save hit an error. Your draft is saved locally — click Save to retry syncing.', 'warning', 7000);
          }
        });
      }
    }, 400);
  }

  // Write a still-pending debounced local draft NOW, from the state it was
  // scheduled for. open() resets `state` on a context change; without this a
  // timer queued in the last 400ms would fire afterwards and save the RESET
  // state over the rep's real draft.
  function _flushDraftNow() {
    if (!_draftLocalTimer) return;
    clearTimeout(_draftLocalTimer);
    _draftLocalTimer = null;
    if (state._reopenedClean) return;
    try { localStorage.setItem(DRAFT_KEY_LOCAL, JSON.stringify(collectDraft())); } catch (e) { /* best effort */ }
  }

  async function pushDraftToFirestore() {
    if (!window.db || !window.doc || !window.setDoc || !window._user) return;
    await window.setDoc(
      window.doc(window.db, 'estimate_drafts', window._user.uid),
      {
        userId: window._user.uid,
        updatedAt: window.serverTimestamp ? window.serverTimestamp() : new Date(),
        draft: collectDraft()
      },
      { merge: true }
    );
    // Caller's .catch() will report failures now — no silent catch here.
    _draftRemoteErrorNotified = false;
  }

  async function restoreDraft() {
    // Local first (instant), then Firestore if newer.
    let local = null;
    try {
      const raw = localStorage.getItem(DRAFT_KEY_LOCAL);
      if (raw) local = JSON.parse(raw);
    } catch (e) {}
    let remote = null;
    try {
      if (window.db && window.doc && window.getDoc && window._user) {
        const snap = await window.getDoc(window.doc(window.db, 'estimate_drafts', window._user.uid));
        if (snap.exists()) remote = snap.data().draft || null;
      }
    } catch (e) {}
    const pick =
      !local && !remote ? null
      : !local          ? remote
      : !remote         ? local
      : (remote.savedAt || 0) > (local.savedAt || 0) ? remote : local;
    if (!pick) return false;
    // F7 (finished 2026-08-16): the comment at the call site always said
    // "OFFER to restore" — but the implementation restored silently, with only
    // an easy-to-miss toast. A rep opening "new estimate" days later landed in
    // a stale session (old customer, old scope) without realizing it, and the
    // only way out was hand-deleting line items. A draft saved in the last few
    // minutes is almost certainly an accidental close/reopen — keep restoring
    // that seamlessly. Anything older is a genuine "resume or start fresh?"
    // decision that belongs to the rep.
    const ageMs = Date.now() - (pick.savedAt || 0);
    if (ageMs > 10 * 60 * 1000) {
      const mins = Math.round(ageMs / 60000);
      const when = mins < 120 ? mins + ' minutes ago'
        : mins < 2880 ? Math.round(mins / 60) + ' hours ago'
        : Math.round(mins / 1440) + ' days ago';
      const who = pick.customer && pick.customer.name ? ' (' + pick.customer.name + ')' : '';
      // In the installed PWA, native confirm() is patched to always return
      // true (standalone-compat.js), which silently re-runs the exact F7 bug
      // above — the rep taps "new estimate" and lands in the stale session
      // with no say in it. nbdConfirm gives a real modal with a real Cancel;
      // it only exists in standalone mode, so fall back to confirm on desktop.
      const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
      if (!(await ask('Resume your unsaved estimate draft from ' + when + who + '?\n\nOK resumes it — Cancel starts fresh and discards the draft.'))) {
        clearDraft();
        return false;
      }
    }
    // Apply without clobbering fields that aren't in the draft.
    Object.keys(pick).forEach(k => {
      if (k === 'savedAt') return;
      if (pick[k] == null) return;
      state[k] = pick[k];
    });
    syncMeasurementInputs();
    if (typeof syncCustomerInputs === 'function') syncCustomerInputs();
    return true;
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY_LOCAL); } catch (e) {}
    if (window.db && window.doc && window.deleteDoc && window._user) {
      try {
        window.deleteDoc(window.doc(window.db, 'estimate_drafts', window._user.uid));
      } catch (e) {}
    }
  }

  // ═════════════════════════════════════════════════════════
  // D-3: Server-side estimate render (Puppeteer + new template)
  // ═════════════════════════════════════════════════════════
  //
  // Tries the renderPdf callable first. Returns true on success so
  // the legacy formatter path can short-circuit. Throws on real
  // errors (which the caller catches and falls back from).
  async function _tryServerRenderEstimate(format, estimate, meta, previewHtml) {
    if (!window._functions || !window._httpsCallable) {
      const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
      window._functions = mod.getFunctions();
      window._httpsCallable = mod.httpsCallable;
    }
    const payload = _buildEstimatePayload(format, estimate, meta);
    if (!payload) return false;

    if (typeof window.showToast === 'function') window.showToast('Rendering estimate…', 'info');

    const fn = window._httpsCallable(window._functions, 'renderPdf');
    const slug = (payload.preparedFor && payload.preparedFor.name || 'estimate')
      .replace(/[^A-Za-z0-9]+/g, '-').substring(0, 40);
    // Tenant-resolved prefix. This is the PRIMARY estimate PDF — the server
    // render the homeowner receives; finalize() returns on its success and only
    // falls through to the html2canvas path below when it fails.
    const _base = 'Estimate-' + slug + '-' + (meta.estimate && meta.estimate.number || Date.now()) + '.pdf';
    const filename = window._tenantFileName ? await window._tenantFileName(_base) : _base;

    const r = await fn({ template: 'estimate', payload, filename });
    const data = r && r.data;
    if (!data || !data.ok || !data.url) throw new Error('Render returned no URL');

    if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
      window.NBDDocViewer.open({
        // Same-origin HTML drives the PREVIEW (renders, never blocked); the
        // server PDF `url` becomes the high-fidelity Download. Without html the
        // viewer would embed the cross-origin Storage PDF and get blocked.
        html:     previewHtml || undefined,
        url:      data.url,
        title:    'Project Estimate' + (payload.preparedFor && payload.preparedFor.name ? ' — ' + payload.preparedFor.name : ''),
        filename: data.filename || filename,
        onSave:   async () => { await save(); },
      });
    } else {
      window.open(data.url, '_blank', 'noopener');
    }

    const ms = data.timing && data.timing.totalMs;
    if (typeof window.showToast === 'function') {
      window.showToast(ms ? `✓ Estimate rendered in ${ms}ms` : '✓ Estimate rendered', 'success');
    }
    return true;
  }

  // Maps the estimate builder's internal data to the new estimate.hbs
  // payload shape. Centralized so the template stays the only place
  // that knows the doc structure.
  function _buildEstimatePayload(format, estimate, meta) {
    const customer = meta.customer || {};
    const fullName = ((customer.firstName || '') + ' ' + (customer.lastName || '')).trim()
      || customer.name
      || 'Homeowner';

    // Look up the lead by address (closest match) to pick up customerId
    // for the cover's PREPARED FOR block. Tolerant of misses.
    const lead = (window._leads || []).find(l =>
      (l.address && customer.address && l.address.trim() === String(customer.address).trim()) ||
      (l.firstName && customer.firstName && l.firstName === customer.firstName && l.lastName === customer.lastName)
    );

    const estNum = (meta.estimate && meta.estimate.number) || 'EST-' + Date.now().toString().slice(-6);
    // The rep's LOCAL date — the UTC date dated evening estimates tomorrow.
    const dateStr = (meta.estimate && meta.estimate.date)
      || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const dateFmt = (function () {
      try {
        return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US',
          { month: 'long', day: 'numeric', year: 'numeric' });
      } catch (_) { return dateStr; }
    })();

    const preparedFor = {
      name:        fullName,
      address:     customer.address || '',
      customerId:  (lead && lead.customerId) || null,
      projectLine: (function () {
        const parts = [];
        if (estimate.materialType || customer.material) parts.push(estimate.materialType || customer.material);
        if (meta && meta.tiers) parts.push(_v2Tiers().filter(t => meta.tiers[t]).map(_v2TierLabel).join(' / ') + ' comparison');
        return parts.length ? parts.join(' · ') : null;
      })(),
    };
    // Server-PDF payload. coverPage.hbs has a {{else}} branch that falls back
    // to the resolved COMPANY block — but it only fires when these fields are
    // OMITTED. Sending them populated bypassed the tenant fallback entirely and
    // stamped the owner's role, cell and email onto a tenant's cover page.
    //
    // So for a tenant we send the rep name only, and leave role/phone/email off
    // the payload so the Handlebars fallback does its job. NBD keeps the exact
    // literals it had.
    const _pb = _v2Brand();
    const preparedBy = _pb.isNbd
      ? {
          name:  (meta.estimate && meta.estimate.preparedBy) || (window._user && window._user.displayName) || 'Joe Deal',
          role:  'Project Owner · No Big Deal Home Solutions',
          phone: '(859) 420-7382',
          email: 'jd@nobigdealwithjoedeal.com',
        }
      : (() => {
          const name = (meta.estimate && meta.estimate.preparedBy)
            || (window._user && (window._user.displayName || window._user.email)) || '';
          return name ? { name } : {};
        })();
    const projectMeta = [
      { label: 'Estimate Date',  value: dateFmt },
      { label: 'Estimate No.',   value: estNum },
      { label: 'Valid For',      value: '30 days' },
    ];

    // 2f: a Single Quote is one all-in number, no Good/Better/Best and no
    // itemized table. Defined here (before the tier block) so it can also
    // force-suppress tiers even if a caller somehow passed meta.tiers — the
    // single-quote payload is always one consistent number.
    const isSingleQuote = format === 'single-quote';

    // Tier comparison block — only when meta.tiers is populated by
    // the retail-quote path. Marks the middle tier (Better) as
    // recommended unless a different one is flagged.
    let tierList = null;
    if (!isSingleQuote && meta.tiers && _v2Tiers().some(t => meta.tiers[t])) {
      const recommended = meta.tiers.recommended || 'better';
      const buildTier = (key, name, subtitle, features) => {
        const src = meta.tiers[key];
        if (!src) return null;
        const tierTotal = Number(src.total || src.grandTotal || 0);
        // Each card states ITS OWN deposit (deposit-rule.js, 2026-09-25): the
        // Terms section's deposit is the selected tier's, so a homeowner
        // weighing Good against Best otherwise saw a dollar deposit for a
        // price they were not choosing.
        const tierPlan = _depositPlanFor({ total: tierTotal, mode: estimate.mode },
          meta.claim || state.claim, estimate.mode || state.jobMode || null);
        return {
          name,
          subtitle,
          total: tierTotal,
          features,
          priceNote: (tierPlan && tierPlan.totalCents > 0) ? (tierPlan.label + ': ' + tierPlan.valueText) : null,
          isRecommended: key === recommended,
        };
      };
      // GBB audit, 2026-09-09: "Labor warranty: 10 years"/"15 years" were two
      // MORE independent durations that never matched the 5/10/20 scheme
      // elsewhere, let alone each other. Jo, 2026-10-06 (final): each package
      // states its WRITTEN labor years from estimate-config.js
      // TIER_LABOR_YEARS (the one map; the literal below only covers a page
      // without the config), never "lifetime".
      // Economy / Beyond (2026-10-02, Jo): Economy is Jo's pick of an
      // economy-grade architectural (never 3-tab) with a 1-YEAR labor
      // warranty + the manufacturer's limited warranty, NO system warranty.
      // Beyond is TAMKO HailGuard only — the one shingle with a hail warranty.
      const _LY = (typeof window !== 'undefined' && window.NBD_ESTIMATE_CONFIG && window.NBD_ESTIMATE_CONFIG.TIER_LABOR_YEARS)
        || { economy: 1, good: 5, better: 10, best: 20, beyond: 20 };
      const _ly = (k) => _LY[k] + (_LY[k] === 1 ? ' year' : ' years') + ' (written)';
      // GAF System Plus (Jo, 2026-10-05: "System Plus is Standard and up"):
      // included in Standard/Preferred/Elite, never a separate line. A GAF
      // certification is NBD's, so the bullet prints for the platform tenant
      // only — another company's quote never claims it.
      const _trSp = window.NBDTenantRules;
      const _sp = (!_trSp || typeof _trSp.isPlatformTenant !== 'function' || _trSp.isPlatformTenant())
        ? ['GAF System Plus warranty included (GAF shingles + qualifying GAF accessories)'] : [];
      tierList = [
        buildTier('economy', _v2TierLabel('economy'), 'Economy-grade architectural shingle · standard install',
          ['Economy-grade architectural shingle (never a 3-tab)', 'Standard ridge vent + flashing', 'Labor warranty: ' + _ly('economy'), "Shingle manufacturer's standard limited warranty — no system warranty", 'Full tear-off included']),
        buildTier('good',   _v2TierLabel('good'),   '25-yr architectural shingle · standard install',
          ['GAF Timberline HD', 'Standard ridge vent + flashing', 'Labor warranty: ' + _ly('good') + ', non-transferable'].concat(_sp, ['Full tear-off included'])),
        buildTier('better', _v2TierLabel('better'), '30-yr architectural · upgraded underlayment',
          ['GAF Timberline HDZ', 'Synthetic underlayment upgrade', 'Ice & water shield on eaves + valleys', 'Labor warranty: ' + _ly('better') + ', transferable to 1 subsequent owner'].concat(_sp, ['Full tear-off included'])),
        buildTier('best',   _v2TierLabel('best'),   'Designer shingle · premium system',
          ['GAF Timberline ULTRA HDZ', 'Synthetic underlayment + ice & water full perimeter', 'Premium ridge vent', 'Labor warranty: ' + _ly('best') + ', fully transferable'].concat(_sp, ['Annual courtesy inspection'])),
        buildTier('beyond', _v2TierLabel('beyond'), 'TAMKO HailGuard Class 4 · hail warranty',
          ['TAMKO HailGuard — the only shingle with a manufacturer hail warranty', 'TAMKO Synthetic Guard + Moisture Guard (required for the hail warranty)', 'TAMKO starter + hip & ridge', 'Labor warranty: ' + _ly('beyond') + ', fully transferable', 'Annual courtesy inspection']),
      ].filter(Boolean);
    }

    // Line items mapped to the template shape — priced at RETAIL. The old map
    // read l.unitPrice/l.price (absent on engine lines → $0.00) and l.lineTotal
    // (the INTERNAL cost basis), so the rendered proposal printed the
    // contractor's cost under a retail subtotal and leaked the margin
    // (money-math sweep 2026-07-18). retailTotal comes from resolveEstimate /
    // _reconstructEstimateFromSaved; derive from the material/labor split for
    // docs that predate it. Pass-throughs (no cost basis) stay at face.
    const _mkp = Number(estimate.materialMarkupPct);
    const _lineRetail = (l) => lineRetail(l, _mkp);
    const lines = (estimate.lines || []).map((l) => {
      const qty = Number(l.quantity || l.qty || 1) || 1;
      const retail = Math.round(_lineRetail(l) * 100) / 100;
      return {
        code:        l.code || '',
        description: l.name || l.description || '',
        category:    l.category || '',
        quantity:    l.quantity || l.qty || 1,
        unit:        l.unit || 'ea',
        unitPrice:   Math.round((retail / qty) * 100) / 100,
        lineTotal:   retail,
      };
    });
    // Overhead & Profit as its own row, so the visible lines foot to the
    // subtotal — the same Line Item Total → +O&P → Subtotal ladder the signed
    // insurance scope shows (Σ retail lines == retailBeforeOHP by identity).
    const scopeLineCount = lines.length;   // stats card counts SCOPE lines, not the O&P row
    const _ohp = (Number(estimate.overhead) || 0) + (Number(estimate.profit) || 0);
    if (lines.length && _ohp > 0) {
      const _ohpPct = Math.round(((Number(estimate.overheadPct) || 0) + (Number(estimate.profitPct) || 0)) * 100);
      lines.push({
        code: '', category: '',
        description: 'Overhead & Profit' + (_ohpPct ? ' (' + _ohpPct + '%)' : ''),
        quantity: 1, unit: 'ea',
        unitPrice: Math.round(_ohp * 100) / 100,
        lineTotal: Math.round(_ohp * 100) / 100,
      });
    }

    // Job-type workmanship warranty (review 2026-09-25): a string for a Job
    // Template estimate that is not roofing ('' = the job carries none), null
    // for everything else, which keeps this payload exactly as it was.
    const _rowsApi = window.NBDCustomerEstimateRows;
    const _jw = (_rowsApi && typeof _rowsApi.estimateWarranty === 'function')
      ? _rowsApi.estimateWarranty(estimate) : null;
    const jobWarranty = (_jw && typeof _jw.text === 'string') ? _jw.text : null;

    // Stats card row — surface the headline numbers above the table. The
    // 'GAF Timberline' fallback is a roofing default: a gutter or repair job
    // with no material named gets no Material tile rather than a shingle.
    const _material = estimate.materialType || meta.materialType || (jobWarranty === null ? 'GAF Timberline' : '');
    const stats = [
      { label: 'Line Items',  value: String(scopeLineCount),  sub: 'in scope' },
      _material ? { label: 'Material', value: _material, sub: '' } : null,
      // Pre-formatted here, so the server's money helper never sees it: the
      // same cents rule as the on-screen total (review of #1763).
      { label: 'Estimate',    value: _fmtTotal(estimate.total), sub: 'incl. tax' },
    ].filter(Boolean);

    // (isSingleQuote defined above, before the tier block.) Zeroing the lines
    // below makes estimate.hbs suppress the Scope & Pricing section
    // ({{#if lines.length}}) and render just the headline total. Same for
    // per-SQ estimates: their line items are the internal cost basis while
    // subtotal/total are the selected TIER price, so no per-line rendering
    // (retail or otherwise) can foot to the headline — the tier cards carry
    // the pricing instead.
    const summary = {
      headline: tierList
        ? 'Three ways to do this. Same crew, same workmanship.'
        : isSingleQuote
          ? 'Your all-in price for the proposed work.'
          : 'Scope and pricing for the proposed work.',
      body: tierList
        ? 'Pick the level that fits your budget and how long you want the roof to last. Our recommendation is flagged.'
        : isSingleQuote
          ? 'One clear number for the full scope we discussed — materials, labor, and overhead included. No tiers, no upsell pressure, no fine-print surprises.'
          : 'Itemized breakdown below covers materials, labor, and overhead. Subtotal and final total at the foot of the table.',
    };

    const validUntilMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const validUntilFmt = new Date(validUntilMs).toLocaleDateString('en-US',
      { month: 'long', day: 'numeric', year: 'numeric' });

    // Deposit terms (2026-09-25): the SAME plan the on-screen quote prints
    // (deposit-rule.js). Was a hard-coded `depositPct: 25` → "25% at contract
    // signing" on every server-rendered Retail Quote, whatever the screen said.
    // Pre-formatted client-side (valueText / summary) like the Estimate tile,
    // so the server's money helper and the screen cannot disagree.
    const _dp = estimate.depositPlan
      || _depositPlanFor(estimate, meta.claim, estimate.mode || null);
    const depositTerms = (_dp && _dp.totalCents > 0) ? {
      label:     _dp.label,
      valueText: _dp.valueText,
      summary:   _dp.summary,
      amount:    _dp.depositCents / 100,
      balance:   _dp.balanceCents / 100,
    } : null;

    return {
      // Cover (shared partial)
      preparedFor,
      preparedBy,
      projectMeta,
      coverTagline: 'Built to last.<br>Priced to fit.',
      // No "three tiers" line on a job-type estimate: no tier applies to it.
      coverSub:     isSingleQuote
        ? 'A clear, all-in price for the work we discussed — no upsell pressure, no fine-print surprises.'
        : jobWarranty !== null
          ? 'A clear estimate with itemized scope — no upsell pressure, no fine-print surprises.'
          : 'A clear estimate with itemized scope and three tiers to choose from — no upsell pressure, no fine-print surprises.',
      // The lead's rep-chosen cover photo (RoofLink "Set Cover") fronts the
      // PDF when present — previously hardcoded null so the cover page never
      // carried an image.
      coverPhoto:   (() => {
        try {
          const lid = state.customer && state.customer.leadId;
          const lead = lid ? (window._leads || []).find(l => l.id === lid) : null;
          const u = lead && lead.coverPhotoUrl;
          return (u && /^https?:/i.test(String(u))) ? u : null;
        } catch (_) { return null; }
      })(),
      coverCaption: null,
      // Body content
      summary,
      stats,
      tierList,
      tiers: tierList ? true : false, // template gates on truthy
      lines: (isSingleQuote || estimate.priceMode === 'per-sq') ? [] : lines,
      subtotal: Number(estimate.subtotal || 0),
      tax:      Number(estimate.tax || 0),
      total:    Number(estimate.total || 0),
      // Subtotal + Tax never foots to Total by itself: the engine rounds the
      // total to the nearest $25 (either way) and lifts it to the shop
      // minimum. Print the difference as its own row so the ladder adds up.
      ...(() => {
        // In cents from the printed (cent-rounded) figures, so the rows foot as shown.
        const diff = (Math.round((Number(estimate.total || 0)) * 100) - Math.round((Number(estimate.subtotal || 0)) * 100) - Math.round((Number(estimate.tax || 0)) * 100)) / 100;
        if (!diff) return { rounding: 0 };
        return {
          rounding: diff,
          roundingLabel: (estimate.minJobApplied && diff > 0) ? 'Minimum job charge adjustment' : 'Rounding',
          roundingSign: diff < 0 ? '−' : '',
          roundingAbs: Math.abs(diff),
        };
      })(),
      terms: {
        validityDays: 30,
        validUntil:   validUntilFmt,
        deposit:      depositTerms,
        scheduleNote: 'Typical start: 2-4 weeks from signed contract.',
        // GBB audit, 2026-09-09: was '10 years labor minimum' — did not match
        // this same document's own tier-list bullets above (which said 10/15/
        // Lifetime). Each tier states its own written labor years, stated
        // per-tier in tierList above.
        // A job-type estimate prints its own sentence instead, or nothing at
        // all when the job carries no workmanship warranty (estimate.hbs
        // drops the row on a falsy value) — 2026-09-25.
        // 2026-10-06 (Jo, final): the NBD Pledge is NBD's PROMISE on every
        // job (never a "lifetime warranty"); the written labor warranty is by
        // package (1–20 years, TIER_LABOR_YEARS). Another company's estimate
        // never prints the Pledge: its own per-option sentences
        // (shown above) or no row; the manufacturer warranty follows the
        // package chosen plus any extended manufacturer warranty sold.
        warranty:     jobWarranty === null
          ? (function () {
            var TR = (typeof window !== 'undefined') ? window.NBDTenantRules : null;
            if (TR && typeof TR.isPlatformTenant === 'function' && TR.isPlatformTenant() === false) {
              var own = (typeof TR.ownWarrantyText === 'function' && typeof TR.tierOrder === 'function')
                && TR.tierOrder().some(function (t) { return !!TR.ownWarrantyText(t); });
              return own ? 'Workmanship warranty as stated for each option above; manufacturer warranty per the package you choose' : null;
            }
            var _pc = (typeof window !== 'undefined') ? window.NBD_ESTIMATE_CONFIG : null;
            return ((_pc && _pc.PLEDGE_PROMISE) || 'NBD Pledge: for as long as you own the home, we\'ll come back and make it right.')
              + ' Written labor warranty by package — 1 to 20 years; length and transferability for each option above. Manufacturer warranty: per the package you choose, plus any extended manufacturer warranty sold on this job';
          })()
          : (jobWarranty || null),
      },
      notes: null,
    };
  }

  // ─── Firestore save payload (extracted so it can be unit-tested) ───
  // Matches the classic builder's data shape so the estimates list + customer
  // timeline pick up V2 estimates. PURE: depends only on (estimate, state).
  function _buildSavePayload(estimate, state) {
    const ctx = estimate.context || {};
    // Estimate name: typed name if any, else synthesize from customer + tier.
    const existingName = (state.estimateName || '').trim();
    const fallbackName = (state.customer.address || '').trim()
      || (state.customer.name ? state.customer.name.trim() + ' estimate' : '')
      || 'V2 Estimate ' + new Date().toLocaleDateString();
    const num = (v) => (v != null && isFinite(Number(v)) ? Number(v) : null);
    return Object.assign({
      // Identity
      name:             existingName || fallbackName,
      builder:          'v2',
      estimateVersion:  'v2',
      method:           estimate.method || 'line-item',
      tier:             estimate.tier || state.tier,
      mode:             estimate.mode || state.jobMode,
      // Customer association. state.leadId is set only on the REOPEN path
      // (loading an existing doc); a brand-new estimate opened from a customer
      // card links via prefillFromLead → state.customer.leadId. Fall back to it
      // so a fresh estimate isn't saved orphaned (leadId:null) — which would
      // hide it from the customer page and skip the lead jobValue/primaryEstimate
      // stamp-back (that block is gated on data.leadId).
      leadId:           state.leadId || (state.customer && state.customer.leadId) || null,
      addr:             state.customer.address || '',
      owner:            state.customer.name || '',
      // Contact the estimate was written for (phone audit 2026-09-25,
      // estimate#8). Only name + address were persisted, so a reopen blanked
      // email + phone: the regenerated Retail Quote printed "—" for both and
      // Send for Signature refused ("Customer name + email required") on an
      // estimate already linked to a lead with an email. Same key names
      // invoice-pipeline.js already reads off an estimate (est.customerEmail /
      // est.customerPhone, with the lead as fallback).
      customerEmail:    String(state.customer.email || '').trim(),
      customerPhone:    String(state.customer.phone || '').trim(),
      // Photo embeds: the selected photos ride the saved doc so every
      // downstream surface (preview sheet, homeowner share view, doc
      // regeneration on reopen) sees the same set.
      photos:           (state.photos || []).map(p => ({ id: p.id || null, url: p.url })),
      // FU-1: persist insurance claim info (carrier/deductible/adjuster/…) so a
      // reopened insurance estimate restores its claim header instead of "—".
      // Sanitized to plain values; undefined → null (Firestore-safe).
      claim: (state.claim && (state.claim.carrier || state.claim.number || state.claim.adjuster
        || state.claim.dateOfLoss || state.claim.deductible != null || state.claim.acv != null))
        ? {
            carrier:             state.claim.carrier || '',
            number:              state.claim.number || '',
            adjuster:            state.claim.adjuster || '',
            dateOfLoss:          state.claim.dateOfLoss || '',
            deductible:          num(state.claim.deductible),   // num() → null on non-finite (never NaN)
            acv:                 num(state.claim.acv),
            recoverableDepreciation: num(state.claim.recoverableDepreciation),
            policyNumber:        state.claim.policyNumber || '',
          }
        : null,
      // Measurements (echoed so the estimate list can show them)
      raw:              Math.round(ctx.rawSqft || 0),
      adj:              Math.round(ctx.adjustedSqft || 0),
      sq:               Number((ctx.sq || 0).toFixed(2)),
      wf:               ctx.waste || 1.17,
      pl:               String(state.measurements.pitch || 8) + '/12',
      ridge:            ctx.ridgeLf || 0,
      eave:             ctx.eaveLf || 0,
      hip:              ctx.hipLf || 0,
      pipes:            ctx.pipes || 0,
      // Complexity + add-on measurement inputs (sourced from state.measurements,
      // NOT echoed in ctx). These drive the per-SQ adders (stories/access/cut-up),
      // formula-driven line quantities (rake/valley/wall LF, chimneys/skylights),
      // tear-off layers, deck-replace %, flashing, and the tax/permit jurisdiction.
      // Persisting them was MISSING → reopen reset them to defaults and the first
      // edit silently dropped the adders, corrupting the saved customer price (the
      // V2 recurrence of the classic 'Edit-on-Classic corrupted totals' bug; see
      // estimates.js:800-826 where the classic builder was fixed for this).
      county:           state.county || null,
      stories:          num(state.measurements.stories),
      accessLevel:      state.measurements.accessLevel || 'standard',
      cutUpRoof:        !!state.measurements.cutUpRoof,
      tearOffLayers:    num(state.measurements.tearOffLayers),
      deckReplacePct:   num(state.measurements.deckReplacePct),
      rakeLf:           num(state.measurements.rakeLf),
      valleyLf:         num(state.measurements.valleyLf),
      wallLf:           num(state.measurements.wallLf),
      chimneys:         num(state.measurements.chimneys),
      skylights:        num(state.measurements.skylights),
      hasChimneyFlash:  !!state.measurements.hasChimneyFlash,
      hasSkylightFlash: !!state.measurements.hasSkylightFlash,
      valleyMetalLf:    num(state.measurements.valleyMetalLf),
      guttersLf:        num(state.measurements.guttersLf),
      // Line items in the classic builder's shape (code/desc/qty/rate/total),
      // PLUS the per-line material/labor split + units so a reopened estimate
      // can reconstruct B-8 retail line pricing without re-resolving the
      // catalog. The extra fields are additive — classic reopen ignores them.
      // rate/total carry the RETAIL price — the classic-row contract is
      // customer-facing (portal, classic views, and invoice items all print
      // these verbatim). Writing the raw cost basis here leaked the margin to
      // the homeowner/adjuster (money-math sweep 2026-07-18); the cost lives
      // only in the *CostPerUnit/*Total split fields below.
      rows: (estimate.lines || []).map(line => {
        const mk = (num(estimate.materialMarkupPct) != null ? num(estimate.materialMarkupPct) : 0.25);
        const matT = Number(line.materialTotal) || 0;
        const labT = Number(line.laborTotal) || 0;
        const retailTotal = Math.round(((line.retailTotal != null)
          ? Number(line.retailTotal)
          : ((matT === 0 && labT === 0)
              ? (Number(line.lineTotal) || 0)              // pass-through: face value
              : matT * (1 + mk) + labT)) * 100) / 100;
        const retailPerUnit = (line.retailPerUnit != null)
          ? Number(line.retailPerUnit)
          : (Number(line.materialCostPerUnit) || 0) * (1 + mk) + (Number(line.laborCostPerUnit) || 0);
        // An upgrade row keeps its tag (stage 2, 2026-09-25) so the next
        // reopen restores it as an upgrade, not as an unknown catalog code.
        return Object.assign({
        code:   line.code,
        desc:   line.name,
        qty:    (line.quantity || 0).toFixed(2) + (line.unit || ''),
        rate:   '$' + retailPerUnit.toFixed(2),
        total:  retailTotal,
        retailTotal: retailTotal,
        // B-8 reconstruction fields:
        quantity:            num(line.quantity),
        unit:                line.unit || '',
        category:            line.category || '',
        materialTotal:       num(line.materialTotal),
        laborTotal:          num(line.laborTotal),
        materialCostPerUnit: num(line.materialCostPerUnit),
        laborCostPerUnit:    num(line.laborCostPerUnit),
        unitPrice:           num(line.unitPrice),
        // Persist a manual per-line qty override so reopen doesn't wipe it (the
        // override lives in state.scope[].overrides.qty; without this the saved
        // qty re-resolves from measurements on the first post-reopen edit).
        qtyOverride:         ((state.scope || []).find(s => s.code === line.code)?.overrides?.qty ?? null),
        // Per-line rep note — annotation printed under the line on documents.
        note:                ((state.scope || []).find(s => s.code === line.code)?.overrides?.note ?? null),
        }, _upgradeTagsOf(line), _memberDiscountTagOf(line));
      }),
      // Totals — grandTotal is the canonical customer total: the selected
      // per-SQ tier price for per-SQ estimates, the scope total for line-item.
      grandTotal:       estimate.total,
      // Persisted so a reopen (_reconstructEstimateFromSaved) knows whether
      // the job-minimum floor produced this total — without it, reopening a
      // floored small-repair estimate hardcoded minJobApplied:false and
      // estimate-finalization.js's "Minimum Job Charge Adjustment" summary
      // row (gated on this flag) silently disappeared, so the regenerated
      // scope's subtotal + tax no longer summed to the printed total.
      minJobApplied:    !!estimate.minJobApplied,
      prices:           estimate.prices || null,            // {good,better,best} per-SQ tier prices (classic shape, close-board.js reads this)
      selectedTier:     estimate.tier || state.tier,
      priceMode:        estimate.priceMode || state.mode,   // 'per-sq' | 'line-item' — tells consumers which model set grandTotal
      internalLineItemTotal: (estimate.internalLineItemTotal != null ? estimate.internalLineItemTotal : null), // cost basis for per-SQ estimates
      // Deposit (2026-09-25): deposit-rule.js's answer on the saved total.
      // `deposit` stays numeric for legacy readers; `depositPlan` is the
      // display plan the homeowner portal prints (the server cannot run the
      // rule). The invoice recomputes from the rule rather than trusting
      // either, so a doc saved under the old logic can't carry it forward.
      ...(() => {
        const plan = estimate.depositPlan || _depositPlanFor(estimate, state.claim, state.jobMode);
        const R = window.NBDDepositRule;
        return {
          deposit:     plan ? plan.depositCents / 100 : (estimate.deposit != null ? Number(estimate.deposit) : null),
          depositPlan: (plan && R) ? R.toStored(plan) : null,
        };
      })(),
      materialCost:     estimate.materialCost,
      laborCost:        estimate.laborCost,
      subtotal:         estimate.subtotal,
      tax:              estimate.tax,
      taxRate:          estimate.taxRate,
      // B-8 retail-scope reconstruction: persist the markup + the O&P ladder
      // inputs so a round-tripped insurance estimate's formatInsuranceScope
      // reconciles instead of silently defaulting materialMarkupPct to 0.25.
      materialMarkupPct: num(estimate.materialMarkupPct),
      retailBeforeOHP:   num(estimate.retailBeforeOHP),
      overhead:          num(estimate.overhead),
      overheadPct:       num(estimate.overheadPct),
      profit:            num(estimate.profit),
      profitPct:         num(estimate.profitPct),
      // Internal margin view
      internal:         estimate.internal || null,
      // Timestamp handled by _saveEstimate (serverTimestamp)
    }, _savedJobTypeFields(estimate), _savedUpgradeFields(estimate, state), {
      // Roof Care Plan (2026-10-05): the kind of work, and the member discount
      // in cents when it is on this estimate (null = not applied).
      workKind:       state.workKind || null,
      memberDiscount: estimate.memberDiscount ? Object.assign({}, estimate.memberDiscount) : null,
    });
  }

  // The estimate-level upgrade fields a re-save must carry (stage 2,
  // 2026-09-25), in the shape NBDUpgrades.applyToEstimate first wrote them.
  // Written whenever this estimate has or HAD upgrades: updateDoc merges
  // top-level keys, so removing the last upgrade here must write
  // upgradeCents 0 / upgrades [] rather than leave the old figures behind.
  // The offered / chosen / declined log is history and rides unchanged.
  function _savedUpgradeFields(estimate, state) {
    const lines = (estimate.lines || []).filter((l) => l && l.upgrade === true);
    if (!lines.length && !(state.upgrades && state.upgrades.length) && !state.upgradeLog) return {};
    const logged = {};
    ((state.upgradeLog && state.upgradeLog.items) || []).forEach((it) => { if (it && it.id) logged[it.id] = it; });
    const out = {
      upgradeCents: lines.reduce((s, l) => s + _upgradeRowCents(l), 0),
      upgradeTaxCents: lines.length
        ? (Number.isSafeInteger(estimate.upgradeTaxCents) ? estimate.upgradeTaxCents : null)
        : 0,
      upgrades: lines.map((l) => ({
        id: l.upgradeId || null,
        qty: Number(l.quantity) || null,
        unit: l.unit || null,
        unitCents: Number.isFinite(Number(l.unitPrice)) ? Math.round(Number(l.unitPrice) * 100) : null,
        retailCents: _upgradeRowCents(l),
        priceSource: (logged[l.upgradeId] && logged[l.upgradeId].priceSource) || null,
      })),
      upgradeLibraryVersion: (lines[0] && lines[0].upgradeVersion) || null,
    };
    if (state.upgradeLog) {
      out.upgradeLog = JSON.parse(JSON.stringify(state.upgradeLog));
      // A chosen / required item this save does NOT carry (the rep removed
      // it, or it is out of the price — insurance, per-SQ, empty scope) is
      // logged "removed", keeping what it was, so the saved log never claims
      // a line the estimate lacks (review of #1763, 2026-09-25). Derived per
      // save from the untouched state.upgradeLog: bring the line back and the
      // next save logs it as it was.
      const onSave = {};
      lines.forEach((l) => { if (l.upgradeId) onSave[l.upgradeId] = true; });
      (out.upgradeLog.items || []).forEach((it) => {
        if (it && (it.status === 'chosen' || it.status === 'required') && !onSave[it.id]) {
          it.removedFrom = it.status;
          it.status = 'removed';
        }
      });
    }
    return out;
  }

  // The job-type fields a Job Template estimate edited here must keep on
  // re-save (2026-09-25). An update would merge-keep them anyway, but the
  // second "Save Again?" of a session creates a NEW doc (_saveEstimate
  // clears _editingEstimateId after the first), and that copy printed
  // roofing's lifetime warranty on a gutter job. `builder` stays 'v2' — this
  // builder did write it; sourceTemplates is what marks it a template job.
  function _savedJobTypeFields(estimate) {
    const f = _jobTypeFieldsOf(estimate);
    if (!f) return {};
    delete f.builder;
    return f;
  }

  // ─── 3B: reopen a saved V2 estimate ───────────────────────────────
  // Reconstruct a resolveEstimate-shaped object from a SAVED estimate doc, so
  // doc regeneration replays the exact saved numbers (B-8 retail honored).
  // Returns null for a pre-3A doc that lacks materialMarkupPct + per-line splits
  // — the caller then falls back to a live re-resolve from the rehydrated scope.
  function _reconstructEstimateFromSaved(doc) {
    if (!doc || !Array.isArray(doc.rows) || doc.materialMarkupPct == null) return null;
    const n = (v) => (v != null && isFinite(Number(v)) ? Number(v) : null);
    const lines = doc.rows.filter((r) => r && r.code).map((r) => Object.assign({
      code: r.code, name: r.desc, category: r.category || '',
      quantity: n(r.quantity), unit: r.unit || '',
      materialCostPerUnit: Number(r.materialCostPerUnit) || 0,
      laborCostPerUnit: Number(r.laborCostPerUnit) || 0,
      materialTotal: n(r.materialTotal), laborTotal: n(r.laborTotal),
      unitPrice: n(r.unitPrice),
      // lineTotal is the engine's COST basis. Rebuild it from the persisted
      // split — post-sweep docs store the RETAIL price in r.total (customer-
      // facing classic-row contract), so reading r.total here would inflate
      // the cost on new docs. Pass-through rows (no split) keep face value.
      lineTotal: (r.materialTotal != null || r.laborTotal != null)
        ? (Number(r.materialTotal) || 0) + (Number(r.laborTotal) || 0)
        : Number(r.total) || 0,
      retailTotal: n(r.retailTotal),
      codeRefs: {},
    }, _isUpgradeRow(r) ? Object.assign({
      // An upgrade row replays at its face unit price (a re-save would
      // otherwise rebuild its rate from the null cost split as $0.00) and
      // keeps its tag, so the re-saved row is still an upgrade on the next
      // reopen.
      retailPerUnit: n(r.unitPrice), source: 'upgrade',
    }, _upgradeTagsOf(Object.assign({}, r, { upgrade: true }))) : {}));
    // Job Template estimates: the replay carries the saved job type, so a
    // clean reopen's regenerated Retail Quote / PDF prints its workmanship
    // warranty (review 2026-09-25). Nothing is added for a V2/classic doc.
    return Object.assign({
      method: doc.method || 'line-item',
      mode: doc.mode || 'insurance',
      tier: doc.tier || 'better',
      // Echo the saved measurements so a re-save (_buildSavePayload reads
      // estimate.context) doesn't zero them out.
      context: {
        rawSqft: n(doc.raw), adjustedSqft: n(doc.adj), sq: n(doc.sq), waste: n(doc.wf),
        ridgeLf: n(doc.ridge), eaveLf: n(doc.eave), hipLf: n(doc.hip), pipes: n(doc.pipes),
      },
      lines,
      materialCost: n(doc.materialCost), laborCost: n(doc.laborCost),
      // hardCost = material + labor (cost basis). The internal-view format reads
      // estimate.hardCost directly; without it the reopened doc shows $0 there.
      hardCost: (doc.internal && doc.internal.hardCost != null)
        ? Number(doc.internal.hardCost)
        : ((doc.materialCost != null && doc.laborCost != null)
            ? Number(doc.materialCost) + Number(doc.laborCost) : null),
      // materialRetail = materialCost × (1+markup); the internal-view format
      // reads it. Prefer deriving from retailBeforeOHP − laborCost when present.
      materialRetail: (doc.retailBeforeOHP != null && doc.laborCost != null)
        ? (Number(doc.retailBeforeOHP) - Number(doc.laborCost))
        : (doc.materialCost != null ? Number(doc.materialCost) * (1 + Number(doc.materialMarkupPct)) : null),
      materialMarkupPct: Number(doc.materialMarkupPct),
      retailBeforeOHP: n(doc.retailBeforeOHP),
      overhead: n(doc.overhead), overheadPct: n(doc.overheadPct),
      profit: n(doc.profit), profitPct: n(doc.profitPct),
      subtotal: n(doc.subtotal), tax: n(doc.tax), taxRate: n(doc.taxRate),
      // Read the persisted flag rather than hardcoding false — a saved
      // estimate floored to the job minimum must reopen still knowing it,
      // or the "Minimum Job Charge Adjustment" row silently vanishes and
      // the regenerated scope stops summing to the stated total. Docs
      // saved before this field existed read undefined -> !! -> false,
      // which is the same behavior they always had (no regression).
      total: n(doc.grandTotal), minJobApplied: !!doc.minJobApplied,
      prices: doc.prices || null, selectedTier: doc.selectedTier || doc.tier,
      priceMode: doc.priceMode || 'line-item',
      deposit: n(doc.deposit),
      // Normalize the internal block so the formatter's marginPct.toFixed(1)
      // can't throw on a partial/legacy block (live 3A docs always carry it).
      internal: doc.internal
        ? Object.assign({ margin: null, marginPct: 0 }, doc.internal,
            { marginPct: Number((doc.internal || {}).marginPct) || 0 })
        : null,
    }, _jobTypeFieldsOf(doc) || {},
    // The saved upgrade figures replay as saved (a clean re-save keeps them).
    doc.rows.some(_isUpgradeRow)
      ? { upgradeCents: n(doc.upgradeCents), upgradeTaxCents: n(doc.upgradeTaxCents) }
      : {});
  }

  // Parse a saved pitch label ("8/12") back to the numeric rise (8).
  function _parsePitchRise(pl) {
    const m = /^(\d+(?:\.\d+)?)/.exec(String(pl || ''));
    return m ? Number(m[1]) : 6;
  }

  // Rehydrate the builder `state` from a saved V2 estimate doc (already loaded
  // into window._estimates by the list). Repopulates customer + measurements +
  // scope (catalog codes from rows) + mode/tier/county, and stashes the doc for
  // faithful replay. window._editingEstimateId is set so a re-save UPDATES the
  // same doc (via _saveEstimate) instead of creating a duplicate.
  function rehydrateFromSaved(estimateId) {
    const doc = (window._estimates || []).find((e) => e.id === estimateId);
    if (!doc) {
      if (typeof window.showToast === 'function') window.showToast('Estimate not found', 'error');
      return false;
    }
    // Phone audit 2026-09-25 (estimate#8): phone + email were hard-coded ''
    // here, so every reopen blanked them — the Retail Quote printed "—" and
    // Send for Signature's lead-prefill fallback never ran (it keys on
    // state.customer.leadId, which this never set). Restore what the estimate
    // was saved with; a doc saved before customerEmail/customerPhone were
    // persisted falls back to its linked lead's contact on file.
    const lead = doc.leadId ? (window._leads || []).find(l => l && l.id === doc.leadId) : null;
    state.customer = {
      name: doc.owner || '', address: doc.addr || '',
      phone: doc.customerPhone || (lead && lead.phone) || '',
      email: doc.customerEmail || (lead && lead.email) || '',
      leadId: doc.leadId || null,
    };
    // FU-1: restore the persisted insurance claim (else the reopened scope's
    // claim header shows "—"). Fall back to the neutral default for old docs.
    state.claim = doc.claim
      ? {
          carrier: doc.claim.carrier || '', number: doc.claim.number || '',
          adjuster: doc.claim.adjuster || '', dateOfLoss: doc.claim.dateOfLoss || '',
          // null = not entered (no $2,500 placeholder since the deposit rule,
          // 2026-09-25 — see the state default). A doc saved BEFORE the rule
          // with exactly 2500 carries that placeholder, not a deductible
          // anyone entered (deposit-rule.js hasLegacyPlaceholderDeductible):
          // reopen it as not entered — prefillFromLead fills the lead's, and
          // the deposit line says it is missing — so a re-save can't launder
          // the placeholder into a confirmed "$2,500 deductible".
          deductible: (doc.claim.deductible == null ||
            (window.NBDDepositRule && window.NBDDepositRule.hasLegacyPlaceholderDeductible(doc)))
            ? null : Number(doc.claim.deductible),
          acv: (doc.claim.acv != null ? Number(doc.claim.acv) : null),
          recoverableDepreciation: (doc.claim.recoverableDepreciation != null ? Number(doc.claim.recoverableDepreciation) : null),
          policyNumber: doc.claim.policyNumber || '',
        }
      : { carrier: '', number: '', adjuster: '', dateOfLoss: '', deductible: null, acv: null, recoverableDepreciation: null, policyNumber: '' };
    state.estimateName = doc.name || '';
    state.leadId = doc.leadId || null;
    // Photo embeds: restore the saved selection + refresh the pick-from
    // grid for the linked lead.
    state.photos = Array.isArray(doc.photos) ? doc.photos.map(p => ({ id: p.id || null, url: p.url })) : [];
    loadLeadPhotos(true);
    state.jobMode = doc.mode || 'insurance';
    state.mode = (doc.priceMode === 'per-sq') ? 'per-sq' : 'line-item';
    state.tier = doc.tier || doc.selectedTier || 'better';
    // A Job Template estimate keeps its job type (and so its workmanship
    // warranty) through this builder; null for a V2/classic doc.
    state.jobType = _jobTypeFieldsOf(doc);
    // Roof Care Plan: an estimate saved with the member discount was repair
    // work; otherwise whatever it was saved as.
    state.workKind = (doc.workKind === 'repair' || doc.workKind === 'replacement') ? doc.workKind
      : (doc.memberDiscount ? 'repair' : null);
    if (doc.county) state.county = doc.county;
    // Fully reset measurements to defaults + the doc's saved values, so a field
    // a PREVIOUS reopen/session set (stories, accessLevel, chimney flags, …)
    // that this doc doesn't carry can't bleed into the reopened estimate.
    state.measurements = {
      rawSqft: Number(doc.raw) || 0,
      pitch: _parsePitchRise(doc.pl),
      waste: Number(doc.wf) || 1.15,
      ridgeLf: Number(doc.ridge) || 0,
      eaveLf: Number(doc.eave) || 0,
      hipLf: Number(doc.hip) || 0,
      pipes: Number(doc.pipes) || 0,
      // Restore the complexity + add-on inputs from the saved doc (now persisted
      // by _buildSavePayload). A still-fresh object (no spread of prior state) so
      // a previous session's values can't bleed in; docs that predate this
      // persistence simply lack the keys and fall back to the SAME neutral
      // defaults as before — but new saves now round-trip faithfully, so a
      // reopen+edit no longer drops the 2-story/access/cut-up adders, flashing,
      // or the LF-driven line quantities, and county no longer reverts.
      rakeLf:          Number(doc.rakeLf) || 0,
      valleyLf:        Number(doc.valleyLf) || 0,
      wallLf:          Number(doc.wallLf) || 0,
      chimneys:        Number(doc.chimneys) || 0,
      skylights:       Number(doc.skylights) || 0,
      stories:         Number(doc.stories) || 1,
      tearOffLayers:   Number(doc.tearOffLayers) || 1,
      deckReplacePct:  (doc.deckReplacePct != null ? Number(doc.deckReplacePct) : 0.15),
      cutUpRoof:       !!doc.cutUpRoof,
      hasChimneyFlash: !!doc.hasChimneyFlash,
      hasSkylightFlash: !!doc.hasSkylightFlash,
      valleyMetalLf:   Number(doc.valleyMetalLf) || 0,
      guttersLf:       Number(doc.guttersLf) || 0,
      accessLevel:     doc.accessLevel || 'standard',
    };
    // Rebuild the scope from the saved catalog codes (skip pass-through/service
    // rows, which aren't catalog items). Quantities re-resolve from measurements.
    //
    // savedCost (2026-08-18): carry the cost basis the row was SAVED at. Without
    // it, reopening re-resolves every line from the LIVE catalog
    // (getCurrentEstimate → cat.find(code)), and because _reopenedClean flips
    // false on any measurement/county/tier edit while _editingEstimateId still
    // points at the same doc, the next save rewrites signed work at today's
    // catalog price. The catalog is a source of defaults for NEW lines, not a
    // re-pricer of work already quoted. Same failure this file already fixes for
    // pass-through fees immediately below — this is that fix applied to cost.
    // Only trusted when BOTH halves are finite: a partially-written legacy row
    // must fall through to the catalog rather than resolve at half its cost.
    state.scope = (doc.rows || [])
      .filter((r) => r && r.code && !/^SVC /.test(r.code) && r.source !== 'passthru' && !_isUpgradeRow(r) && !_isMemberDiscountLine(r))
      .map((r) => ({
        code: r.code,
        savedCost: (Number.isFinite(Number(r.materialCostPerUnit))
                 && Number.isFinite(Number(r.laborCostPerUnit)))
          ? { materialCost: Number(r.materialCostPerUnit),
              laborCost:    Number(r.laborCostPerUnit) }
          : null,
        overrides: Object.assign(
          (r.qtyOverride != null ? { qty: Number(r.qtyOverride) } : {}),
          (r.note ? { note: String(r.note) } : {})
        )
      }));
    // Repopulate pass-through fees (measurement report, e-sign, permit upcharge)
    // from the saved SVC/passthru rows — else the FIRST edit after reopen drops
    // them from the live re-resolve (getCurrentEstimate reads state.passThru)
    // and the next save loses the fee + understates grandTotal/deposit.
    state.passThru = (doc.rows || [])
      .filter((r) => r && r.code && (/^SVC /.test(r.code) || r.source === 'passthru') && !_isUpgradeRow(r) && !_isMemberDiscountLine(r))
      .map((r) => ({ code: r.code, desc: r.desc,
        amount: Number(r.total) || Number(r.unitPrice) || 0, source: r.source || 'passthru' }));
    // Upgrade rows (stage 2, 2026-09-25): kept whole, out of the catalog
    // scope, and re-added after the engine by _applyUpgradeLines — the same
    // "restore it or the first edit drops it" fix as the fees above, plus tax.
    state.upgrades = (doc.rows || [])
      .filter(_isUpgradeRow)
      .map((r) => Object.assign(JSON.parse(JSON.stringify(r)), { upgrade: true }));
    state.upgradeLog = doc.upgradeLog ? JSON.parse(JSON.stringify(doc.upgradeLog)) : null;
    state._reopenedDoc = doc;
    state._reopenedClean = true;
    _stateFromSavedDoc = estimateId;           // next fresh open resets (see open())
    window._editingEstimateId = estimateId;   // _saveEstimate updates this doc
    window._v2SavedEstimateId = estimateId;    // sendForSignature scopes to it
    if (typeof syncCustomerInputs === 'function') syncCustomerInputs();
    // Push the rehydrated measurements into their DOM inputs too — otherwise the
    // left pane shows the PRIOR session's values and the rep's first edit writes
    // one key over a stale-DOM baseline (the rest stays wrong).
    if (typeof syncMeasurementInputs === 'function') syncMeasurementInputs();
    return true;
  }

  // Stamp per-line rep notes (state.scope[].overrides.note) onto resolved
  // lines as line.repNote so the document formatters can print them. Also
  // honors notes carried on replayed saved rows (line.note) when the scope
  // entry lacks one (belt-and-braces for reconstructed docs).
  function _stampLineNotes(estimate) {
    if (!estimate || !Array.isArray(estimate.lines)) return;
    estimate.lines.forEach(line => {
      const e = (state.scope || []).find(s => s.code === line.code);
      const n = (e && e.overrides && e.overrides.note) || line.note || null;
      if (n) line.repNote = String(n);
    });
  }

  // The estimate to render/save RIGHT NOW: on a clean reopen of a 3A-capable
  // doc, replay the saved numbers faithfully; otherwise re-resolve live.
  function effectiveEstimate() {
    if (state._reopenedClean && state._reopenedDoc) {
      const replay = _reconstructEstimateFromSaved(state._reopenedDoc);
      // The replay carries the doc's SAVED deposit, which may predate the
      // deposit rule (2026-09-25) — re-stamp it from the rule + live claim.
      if (replay) return _stampDeposit(replay);
    }
    return getCurrentEstimate();
  }

  // ═════════════════════════════════════════════════════════
  // Finalization — opens formatted estimate in new window
  // ═════════════════════════════════════════════════════════

  async function finalize(format) {
    // ── HYDRATION GATE (2026-09-06) ──────────────────────────────────────
    // EstimateFinalization's formatters are synchronous and derive the doc
    // prefix / seal from window._brand(), which company-profile.js:276 seeds
    // with the NBD DEFAULTS at parse time. Rendering before hydration stamps
    // the platform identity onto another tenant's estimate.
    //
    // Hydration did already happen on this path — but only as a side effect of
    // `await _v2EstNumber(...)` sitting inside the argument list, i.e. by
    // argument-evaluation order. That is an accident, not a guarantee: reorder
    // the object literal and the leak comes back silently. Gate explicitly.
    await _awaitBrandHydration();
    // Normalize format defensively — buttons pass 'insurance-scope' |
    // 'retail-quote' | 'internal-view', but older call sites also use
    // 'internal'. Map legacy aliases so the formatter + titleMap both
    // resolve correctly.
    const FORMAT_ALIASES = { internal: 'internal-view', retail: 'retail-quote', insurance: 'insurance-scope', single: 'single-quote' };
    format = FORMAT_ALIASES[format] || format;

    const toast = (msg, kind) => (typeof window.showToast === 'function')
      ? window.showToast(msg, kind || 'error')
      : console.warn('[V2 preview]', kind || 'info', msg);

    // 3B: on a clean reopen of a 3A-capable doc this replays the saved numbers
    // (B-8 retail honored); otherwise it re-resolves live.
    const estimate = effectiveEstimate();
    if (!estimate) {
      toast('Add line items to the scope before generating a preview.', 'error');
      return;
    }
    if (!window.EstimateFinalization) {
      toast('Preview engine still loading — try again in a moment.', 'error');
      return;
    }
    const meta = {
      customer: state.customer,
      claim: state.claim,
      // Photo embeds: the selected photos render as a Photo Documentation
      // section in the customer-facing formats (estimate-finalization.js).
      photos: (state.photos || []).slice(),
      estimate: {
        number: await _v2EstNumber(Date.now()),
        date: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10), // local date, not UTC (evening = tomorrow)
        preparedBy: _v2PreparedBy()
      }
    };
    // For retail quote, also pass tier comparison.
    // Line-item mode produces identical totals across tiers because
    // the scope items are fixed. To show real tier differentiation,
    // we use the EstimateBuilderV2 per-SQ calculator which applies
    // the flat $545/$595/$660 rates from locked spec — giving the
    // customer a meaningful good/better/best choice on the quote.
    // Per-SQ Good/Better/Best tier cards are shown ONLY for per-SQ
    // (cash / retail) estimates. Line-item / insurance estimates price off
    // the scope total, so showing per-SQ tier cards there would contradict
    // the headline (the V2-2 bug). Reuse the tiers getCurrentEstimate already
    // computed so the highlighted card == headline == saved grandTotal.
    if (format === 'retail-quote' && state.mode === 'per-sq' && state.jobMode !== 'insurance') {
      if (estimate.perSqTiers) {
        // Copy: `.recommended` is stamped below, and perSqTiers is the
        // estimate's cached object reused by later renders.
        meta.tiers = Object.assign({}, estimate.perSqTiers);
      } else if (window.EstimateBuilderV2 && typeof window.EstimateBuilderV2.calculateAllTiers === 'function') {
        meta.tiers = window.EstimateBuilderV2.calculateAllTiers(buildPerSqInput());
      } else {
        // Fallback to the (identical-per-tier) line-item calc if
        // the per-SQ engine is unavailable for some reason
        const cat = window.NBD_XACT_CATALOG;
        // Same saved-cost pin as getCurrentEstimate — this fallback also feeds
        // resolveEstimate, so without it the non-selected tier cards would price
        // a reopened estimate off today's catalog.
        const items = state.scope
          .map(s => { const f = cat.find(s.code); return f ? withSavedCost(f, s) : null; })
          .filter(Boolean);
        meta.tiers = {};
        _v2Tiers().forEach(t => { meta.tiers[t] = window.EstimateLogic.resolveEstimate(items, state.measurements, tierSettings(t)); });
      }
      // Mark the rep's selected tier so the formatter highlights the matching
      // card by KEY (not float-equality on totals — see estimate-finalization.js).
      if (meta.tiers) meta.tiers.recommended = state.tier;
    }
    // Per-line rep notes ride to the formatters as line.repNote — the
    // resolver doesn't carry annotations, so stamp them from state here
    // (and from saved rows on a clean reopen, where state mirrors them).
    _stampLineNotes(estimate);
    // formatEstimate can throw if a required field in the catalog item
    // is malformed. Wrap so the user gets a real error instead of a
    // silent nothing — the single biggest reason "previews not showing"
    // is the call threw and the exception bubbled unnoticed.
    let result;
    try {
      result = window.EstimateFinalization.formatEstimate(estimate, format, meta);
    } catch (e) {
      console.error('[V2 finalize] formatEstimate threw:', e);
      toast('Preview failed to render: ' + (e.message || 'unknown error'), 'error');
      return;
    }
    if (!result || typeof result.html !== 'string' || !result.html.length) {
      console.error('[V2 finalize] formatter returned no html', { format, result });
      toast('Preview formatter returned no document. Check console for details.', 'error');
      return;
    }

    // ─── D-3: try server-side Puppeteer render first ───
    // Routes through the new renderPdf callable so the estimate
    // comes out as a real vector PDF with the shared design system
    // (cover, brand band, social rail, tier comparison, etc.). The
    // legacy html2canvas path stays as a fallback for any case the
    // server rejects (transient error, missing template, etc.).
    if (format === 'retail-quote' || format === 'internal-view' || format === 'single-quote') {
      try {
        // Pass the client HTML so the viewer previews it same-origin (renders,
        // never blocked); the server PDF becomes the Download. See nbd-doc-viewer.
        const ok = await _tryServerRenderEstimate(format, estimate, meta, result && result.html);
        if (ok) return;
      } catch (e) {
        console.warn('[V2 finalize] server render failed, falling back:', e && e.message || e);
      }
    }

    // Route through the Universal Document Viewer so the user
    // can Save, Email, Print, or Download PDF without being
    // dumped into a blank popup with no way back.
    if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
      const titleMap = {
        'insurance-scope': 'Insurance Scope',
        'retail-quote': 'Retail Quote',
        'single-quote': 'Quote',
        'internal-view': 'Internal Estimate View'
      };
      const titleSuffix = state.customer && state.customer.address
        ? ' — ' + state.customer.address
        : '';
      // Tenant-resolved prefix (fallback render path; the server path above is
      // the primary one and is prefixed the same way).
      const _estBase = (titleMap[format] || 'Estimate').replace(/\s+/g, '-')
        + '-' + new Date().toISOString().split('T')[0] + '.pdf';
      const _estName = window._tenantFileName ? await window._tenantFileName(_estBase) : _estBase;
      window.NBDDocViewer.open({
        html: result.html,
        title: (titleMap[format] || 'Estimate') + titleSuffix,
        filename: _estName,
        onSave: async () => {
          // Wire the doc viewer's "Save to Customer" button to
          // the same Firestore write the Save button in the
          // bottom-left corner of the builder uses.
          await save();
        }
      });
    } else {
      // Fallback: original popup behavior if the viewer isn't loaded.
      // window.open returns null when blocked by a popup blocker —
      // tell the user explicitly instead of letting the click vanish.
      const w = window.EstimateFinalization.openInNewWindow(result);
      if (!w) {
        toast('Popup blocked by browser. Allow popups for this site to view previews.', 'error');
      }
    }
  }

  // ═════════════════════════════════════════════════════════
  // Save estimate to Firestore — wires to window._saveEstimate
  // (same function the classic builder uses, so V2 estimates
  // appear in the existing Estimates list + customer records)
  // ═════════════════════════════════════════════════════════

  // Resolves to the saved estimate id, or null when nothing was saved
  // (Send to homeowner / Sign on this phone need the id; the Save button
  // ignores it).
  async function save() {
    _savedIdOut = null;
    await _saveInner();
    return _savedIdOut;
  }
  let _savedIdOut = null;
  async function _saveInner() {
    const statusEl = document.getElementById('v2saveStatus');
    const btn = document.getElementById('v2saveBtn');
    const setStatus = (msg, color) => {
      if (statusEl) { statusEl.textContent = msg; statusEl.style.color = color || 'var(--m,#888)'; }
    };

    // Guard: no scope. 3B: a clean reopen re-saves the faithful replay so the
    // persisted numbers (and markup) survive a reopen→save round-trip.
    const estimate = effectiveEstimate();
    if (!estimate) {
      setStatus('Add line items to the scope first.', 'var(--red,#c53030)');
      return;
    }
    // Tier shingle lock, re-checked at save (a stale page or a reopened
    // estimate must not slip a wrong shingle onto Beyond / a 3-tab onto
    // Economy). Jo, 2026-10-02.
    const _cfgS = window.NBD_ESTIMATE_CONFIG;
    if (_cfgS && typeof _cfgS.checkTierShingles === 'function') {
      const chk = _cfgS.checkTierShingles(state.tier, _v2ScopeItems());
      if (!chk.ok) {
        setStatus(chk.problems[0], 'var(--red,#c53030)');
        if (window.showToast) window.showToast(chk.problems[0], 'error');
        return;
      }
    }

    // Guard: save function missing (e.g., dashboard not loaded)
    if (typeof window._saveEstimate !== 'function') {
      setStatus('Save failed: _saveEstimate not loaded.', 'var(--red,#c53030)');
      return;
    }

    // Guard: user not signed in
    if (!window._user?.uid) {
      setStatus('Save failed: not signed in.', 'var(--red,#c53030)');
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    setStatus('Saving to Firestore…', 'var(--m,#888)');

    try {
      const payload = _buildSavePayload(estimate, state);

      // Linkage invariant (CRM audit 2026-07): an unattached estimate is
      // invisible on every customer page and Activity tab (both query by
      // leadId) and never reaches the pipeline. The button literally says
      // "Save Estimate to Customer" — if there's no customer, say so and
      // make the rep choose, never silently orphan the save. This is the
      // save-time guard that keeps the migration-005 backlog from refilling.
      if (!payload.leadId) {
        const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
        const proceed = await ask(
          'This estimate isn\'t attached to a customer — it won\'t appear on ' +
          'any customer page or count toward your pipeline.\n\n' +
          'Save it unattached anyway? (You can attach it later with the ' +
          'Assign button on the Estimates list.)'
        );
        if (!proceed) {
          setStatus('Save cancelled — attach a customer first.', 'var(--m,#888)');
          if (btn) { btn.disabled = false; btn.textContent = '💾 Save Estimate to Customer'; }
          return;
        }
      }

      const savedId = await window._saveEstimate(payload);

      if (savedId) {
        // Expose the id so sendForSignature() can send THIS estimate (the
        // server builds the contract from the saved doc).
        window._v2SavedEstimateId = savedId;
        _savedIdOut = savedId;
        // F7: saved estimate → draft is obsolete.
        clearDraft();
        setStatus('✓ Saved — estimate #' + savedId.substring(0, 8) + '…', 'var(--green,#2ECC8A)');
        if (typeof window.showToast === 'function') {
          window.showToast('✓ Estimate saved to Firestore', 'success');
        }
        if (btn) { btn.textContent = '✓ Saved — Save Again?'; }
        // Re-enable after 2 seconds so user can save again after changes
        setTimeout(() => {
          if (btn) { btn.disabled = false; btn.textContent = '💾 Save Estimate to Customer'; }
        }, 2000);
      } else {
        setStatus('Save failed — check console.', 'var(--red,#c53030)');
        if (btn) { btn.disabled = false; btn.textContent = '💾 Save Estimate to Customer'; }
      }
    } catch (e) {
      console.error('[EstimateV2UI] Save failed:', e);
      setStatus('Save error: ' + e.message, 'var(--red,#c53030)');
      if (btn) { btn.disabled = false; btn.textContent = '💾 Save Estimate to Customer'; }
    }
  }

  // ═════════════════════════════════════════════════════════
  // SEND FOR SIGNATURE — in-house e-sign (BoldSign retired 2026-10-04).
  //
  // Flow:
  //   1. Save the estimate (a second tap UPDATES the same doc), because the
  //      server builds the contract from the SAVED estimate — what is signed
  //      is what the rep just built.
  //   2. sendEstimateEnvelope (functions/esign-envelope.js) builds the
  //      contract PDF with each signer's boxes placed, emails the homeowner
  //      a single-use link (unless in person), and returns the link.
  //   3. In person (Present → Sign Now): the signing page opens on THIS
  //      device; the tab is opened inside the tap (Safari blocks it after an
  //      await). Otherwise the link shows under the button to copy or open.
  // The homeowner gets the signed PDF by email; the rep gets a bell, the
  // estimate flips to signed, and the PDF files on the customer.
  // ═════════════════════════════════════════════════════════
  let _signBusy = false;
  let _lastSignLink = '';
  async function sendForSignature(opts) {
    const inPerson = !!(opts && opts.inPerson);
    if (_signBusy) return 'busy';
    const say = _statusSetter('v2signStatus');
    const btn = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('v2signBtn') : null;
    const closeTab = (w) => { if (w) { try { w.close(); } catch (_) {} } };

    // Kentucky insurance job (2026-10-03): the e-sign contract carries no
    // KRS 367.624 notices or KY cancellation form. Same test the contract
    // notices use (ky-insurance-law.js classifyLead); the button is hidden
    // for these jobs, this refuses if reached anyway, and the server refuses
    // too (sendEstimateEnvelope).
    if (_kySigningBlocked()) {
      say(KY_SIGN_MSG, 'error');
      if (typeof window.showToast === 'function') window.showToast(KY_SIGN_MSG, 'warning');
      return 'ky';
    }

    // B2: if name/email missing and we have a linked lead, try to
    // auto-fill before complaining.
    if ((!state.customer.name || !state.customer.email) && state.customer.leadId) {
      prefillFromLead(state.customer.leadId);
    }
    const customer = state.customer || {};
    const signerName  = (customer.name || '').trim();
    const signerEmail = (customer.email || '').trim().toLowerCase();
    if (!signerName) { say('Add the customer name (Customer step) first.', 'error'); return 'failed'; }
    if (!inPerson && (!signerEmail || signerEmail.indexOf('@') === -1)) {
      say('Customer email required to send the link — add it in the Customer panel, or use "Present" and Sign Now in person.', 'error');
      return 'failed';
    }
    const leadId = state.leadId || customer.leadId || null;
    if (!leadId) { say('Link this estimate to a customer first — the signed contract is filed on the customer.', 'error'); return 'failed'; }
    if (!effectiveEstimate()) { say('Add line items to the scope first.', 'error'); return 'failed'; }

    // Optional co-owner (signs after the homeowner, on their own link).
    const signers = [{ name: signerName, email: signerEmail }];
    const coEl = (id) => (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null;
    const coName = ((coEl('v2coName') || {}).value || '').trim();
    const coEmail = ((coEl('v2coEmail') || {}).value || '').trim().toLowerCase();
    if (coName || coEmail) {
      if (!coName || (!inPerson && coEmail.indexOf('@') === -1)) {
        say('Co-owner needs a name and an email (or clear both).', 'error');
        return 'failed';
      }
      signers.push({ name: coName, email: coEmail });
    }

    let w = null;
    if (inPerson) { try { w = (typeof window.open === 'function') ? window.open('', '_blank') : null; } catch (_) { w = null; } }
    _signBusy = true;
    if (btn) btn.disabled = true;
    try {
      // 1. Save — re-sending the same estimate updates it instead of adding a copy.
      say('Saving the estimate…');
      let pinned = null;
      if (window._v2SavedEstimateId && !window._editingEstimateId) {
        pinned = window._v2SavedEstimateId;
        window._editingEstimateId = pinned;
      }
      let estimateId = null;
      try { estimateId = await save(); }
      finally { if (pinned && window._editingEstimateId === pinned) window._editingEstimateId = null; }
      if (!estimateId) { closeTab(w); say('The estimate did not save — nothing was sent.', 'error'); return 'failed'; }

      // 2. Send.
      say(inPerson ? 'Preparing the contract…' : 'Sending the contract…');
      if (!window._functions || !window._httpsCallable) {
        const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
        window._functions = mod.getFunctions();
        window._httpsCallable = mod.httpsCallable;
      }
      let data = null;
      try {
        const fn = window._httpsCallable(window._functions, 'sendEstimateEnvelope');
        const r = await fn({ estimateId, signers, sendEmail: !inPerson });
        data = (r && r.data) || null;
      } catch (e) {
        closeTab(w);
        say((e && e.message) || 'Could not send for signature — try again.', 'error');
        return 'failed';
      }
      if (!data || !data.ok || !data.link) { closeTab(w); say('Could not send for signature — try again.', 'error'); return 'failed'; }
      _lastSignLink = data.link;
      _renderSignBox(data.link);

      // 3. Hand-off.
      if (inPerson) {
        if (w && !w.closed) {
          try { w.location.href = data.link; say('Signing page open — hand the phone to the homeowner.', 'ok'); return 'opened'; }
          catch (_) { /* fall through to the link below */ }
        }
        say('Tap "Sign on this device", then hand the phone to the homeowner.', 'ok');
        return 'link';
      }
      say(data.emailed ? '✓ Sent to ' + signerEmail + ' — you will get a bell when it is signed.'
        : 'Link ready — the email did not go out. Copy the link below and text it.', data.emailed ? 'ok' : 'error');
      if (typeof window.showToast === 'function') window.showToast(data.emailed ? 'Contract sent for signature' : 'Signing link ready', data.emailed ? 'success' : 'warning');
      return data.emailed ? 'sent' : 'link';
    } finally {
      _signBusy = false;
      if (btn) btn.disabled = false;
    }
  }

  // The signing link under the E-Signature button: open it here (in person)
  // or copy it to text. Plain controls — each tap is a fresh user gesture.
  function _renderSignBox(link) {
    const box = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('v2shareBox') : null;
    if (!box || !link) return;
    box.innerHTML =
      '<a class="v2-share-act" target="_blank" rel="noopener" href="' + _escAttr(link) + '">📱 Sign on this device</a>' +
      '<button type="button" class="v2-share-act" data-action="sign-copy">📋 Copy signing link</button>' +
      '<div class="v2-share-url">' + _escAttr(link) + '</div>';
    box.hidden = false;
  }
  async function _copySignLink() {
    if (!_lastSignLink) return;
    let okCopy = false;
    try { await navigator.clipboard.writeText(_lastSignLink); okCopy = true; } catch (_) { okCopy = false; }
    if (window.showToast) window.showToast(okCopy ? 'Signing link copied' : 'Link ready — copy it from below', okCopy ? 'success' : 'info');
  }

  // ═════════════════════════════════════════════════════════
  // Public API
  // ═════════════════════════════════════════════════════════

  // B2: auto-populate the Customer panel from a linked lead. Called
  // by open() if the caller passes { leadId }. Also called internally
  // when sendForSignature discovers a lead link but blank customer
  // data, so the "Send for Signature" flow doesn't fail for an
  // estimate that was started from a lead detail page.
  function prefillFromLead(leadId) {
    if (!leadId) return false;
    const lead = (window._leads || []).find(l => l.id === leadId);
    if (!lead) return false;
    const name = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim();
    // Only overwrite empty fields so we don't clobber a rep who
    // already started typing.
    if (!state.customer.name    && name)          state.customer.name    = name;
    if (!state.customer.email   && lead.email)    state.customer.email   = lead.email;
    if (!state.customer.phone   && lead.phone)    state.customer.phone   = lead.phone;
    if (!state.customer.address && lead.address)  state.customer.address = lead.address;
    state.customer.leadId = leadId;
    // Claim fields too — insurance mode gets filled in if the lead
    // has any carrier/number on file.
    if (lead.insCarrier && !state.claim.carrier)      state.claim.carrier = lead.insCarrier;
    if (lead.claimNumber && !state.claim.number)      state.claim.number  = lead.claimNumber;
    if (lead.policyNumber && !state.claim.policyNumber) state.claim.policyNumber = lead.policyNumber;
    if (lead.dateOfLoss && !state.claim.dateOfLoss)   state.claim.dateOfLoss = lead.dateOfLoss;
    if (lead.adjusterName && !state.claim.adjuster)   state.claim.adjuster = lead.adjusterName;
    // Deductible: unset (null / a cleared 0) takes the lead's recorded
    // deductible — never over a value the rep typed. 2500 is the retired
    // placeholder (2026-09-25), still treated as unset for drafts saved with it.
    if (lead.deductibleOrOwedByHO != null && lead.deductibleOrOwedByHO !== ''
        && (state.claim.deductible == null || state.claim.deductible === 0 || state.claim.deductible === 2500)) {
      state.claim.deductible = Number(lead.deductibleOrOwedByHO) || 0;
    }
    // Photo embeds: a NEW lead context starts with a clean selection and
    // pulls that lead's photo grid (guarded no-op if it's the same lead).
    if (!state._leadPhotos || state._leadPhotos._leadId !== leadId) {
      state.photos = [];
      loadLeadPhotos(true);
    }
    // Sync inputs if the modal is open. If not, the next render does it.
    syncCustomerInputs();
    return true;
  }
  function syncCustomerInputs() {
    // W142: sync ALL of state.customer + state.claim + state.tier
    // + state.county to their inputs. Previously only the four
    // customer fields were synced, AND those DOM IDs didn't exist
    // anywhere in the modal (the inputs were never rendered).
    // Wave 142 added all the missing inputs; this function now
    // populates the full set on prefillFromLead / restoreDraft /
    // any external state mutation.
    const fields = {
      v2custName:        state.customer && state.customer.name,
      v2custEmail:       state.customer && state.customer.email,
      v2custPhone:       state.customer && state.customer.phone,
      v2custAddress:     state.customer && state.customer.address,
      v2claimCarrier:      state.claim && state.claim.carrier,
      v2claimNumber:       state.claim && state.claim.number,
      v2claimAdjuster:     state.claim && state.claim.adjuster,
      v2claimDeductible:   state.claim && state.claim.deductible,
      v2claimAcv:          state.claim && state.claim.acv,
      v2claimDateOfLoss:   state.claim && state.claim.dateOfLoss,
      v2claimPolicyNumber: state.claim && state.claim.policyNumber,
      v2county:            state.county
    };
    for (const id of Object.keys(fields)) {
      const el = document.getElementById(id);
      if (el && fields[id] != null) el.value = fields[id];
    }
    // A blank deductible / ACV is a real state ("not entered" / "not known
    // yet"), so a previous estimate's figure must not linger in the input
    // while the deposit ignores it (deposit rule, 2026-09-25).
    ['deductible', 'acv'].forEach((k) => {
      const el = document.getElementById(k === 'acv' ? 'v2claimAcv' : 'v2claimDeductible');
      if (el && !(state.claim && state.claim[k] != null)) el.value = '';
    });
    // Tier — buttons, not an input. Toggle .active class.
    const tier = state.tier || 'better';
    _v2Tiers().forEach(t => {
      const b = document.getElementById(_v2TierBtnId(t));
      if (b) b.classList.toggle('active', t === tier);
    });
    // Mirror the customer address into the auto-measure input when
    // the rep hasn't typed there yet — saves typing the address twice.
    const addrEl = document.getElementById('v2measureAddr');
    if (addrEl && !addrEl.value && state.customer && state.customer.address) {
      addrEl.value = state.customer.address;
    }
  }

  // Drawing-tool import (maps-routing importToEstimate). The drawing's
  // measurements are authoritative — they must override whatever a
  // restored draft holds, so open() applies them AFTER restoreDraft()/
  // prefillFromLead() resolve. The old caller-side setTimeout(300) lost
  // that race two ways (lazy 'estimates' bundle still mounting; async
  // draft restore re-syncing inputs afterwards) and the restored draft
  // silently won while the success toast still fired (NEW-D39, d8 sweep).
  function applyImportedMeasurements(imp) {
    Object.keys(imp).forEach(k => {
      if (imp[k] == null) return;
      state.measurements[k] = Number(imp[k]) || 0;
    });
    // Same pitch→waste rule as updateMeasurement so the imported pitch
    // doesn't leave a stale waste factor behind.
    if (window.EstimateBuilderV2 && typeof EstimateBuilderV2.wasteFactorForPitch === 'function') {
      const ratio = (Number(state.measurements.pitch) || 8) / 12;
      let w = EstimateBuilderV2.wasteFactorForPitch(ratio);
      if (state.measurements.cutUpRoof) w += 0.03;
      state.measurements.waste = w;
    }
    state._reopenedClean = false;
    syncMeasurementInputs();
  }

  // Put the builder back to a NEW estimate (2026-09-25, estimate#8 sibling).
  // `state` outlives close() by design — an accidental close + reopen for the
  // same customer keeps the rep's work — but nothing ever cleared it when the
  // context CHANGED. Reopening saved estimate A (Mark Deluca), closing, then
  // starting a new estimate for customer B showed A's name, address and whole
  // scope under B; prefillFromLead only fills EMPTY fields, and state.leadId
  // (set only by a reopen) still pointed at A, so Save filed B's estimate
  // under A and loadLeadPhotos pulled A's photos. With estimate#8 restoring
  // a reopen's email/phone, the bleed would have reached the signature email
  // too. window._v2SavedEstimateId is estimate-scoped as well: left set,
  // Send for Signature skipped the save and scoped B's envelope to A's id.
  function _resetEstimateState() {
    // Same guard close() applies: a new estimate must never Save as an UPDATE
    // of the saved one this state was loaded from.
    if (_stateFromSavedDoc && window._editingEstimateId === _stateFromSavedDoc) window._editingEstimateId = null;
    Object.assign(state, JSON.parse(_FRESH_ESTIMATE));
    state.estimateName = '';
    state.leadId = null;
    state._leadPhotos = null;
    state._reopenedDoc = null;
    state._reopenedClean = false;
    _stateFromSavedDoc = null;
    _rowEdit = null;
    _dismissUndo();
    window._v2SavedEstimateId = null;
    // Repaint the controls from the fresh state, the same way a reopen does.
    const toggle = (id, on) => { const b = document.getElementById(id); if (b) b.classList.toggle('active', on); };
    toggle('v2modePerSq', state.mode === 'per-sq');
    toggle('v2modeLine', state.mode === 'line-item');
    toggle('v2jobInsurance', state.jobMode === 'insurance');
    toggle('v2jobCash', state.jobMode === 'cash');
    syncMeasurementInputs();
    // A fresh page shows empty measurement boxes (their "e.g." hints), not 0s.
    document.querySelectorAll('#estV2Modal input[type=number][data-field]').forEach(el => {
      if (el.value === '0') el.value = '';
    });
    syncCustomerInputs();
    ['v2measureAddr'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    ['v2measureStatus', 'v2saveStatus', 'v2signStatus'].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = '';
    });
  }

  function open(opts) {
    opts = opts || {};
    ensureModal();
    _refreshTenantCountyOptions();
    document.getElementById('estV2Modal').classList.add('open');
    // Phase 1b: pick the mobile starting step — a REOPENED estimate lands
    // on Review (scope + total + save/export, the "look at it" step); a
    // fresh estimate starts at Setup. Desktop ignores the attribute.
    setMobileStep(opts.estimateId ? 3 : 1);
    // V3 (2026-10-02): the step-by-step layer opens by default on top of
    // this modal; "Full editor" in the header drops back to this layout.
    if (window.EstimateV3 && typeof window.EstimateV3.onOpen === 'function') {
      try { window.EstimateV3.onOpen({ reopened: !!opts.estimateId }); } catch (e) { console.warn('[v3] onOpen failed:', e); }
    }
    // A previous session's pending undo / open row editor belong to it.
    _dismissUndo();
    _rowEdit = null;
    // Full packet / Paperwork only (2026-10-04): the rep's remembered choice.
    _packetChoice = null; // the rep's remembered choice, re-read below
    if (_DP() && typeof _DP().load === 'function') {
      _DP().load().then(() => { if (!_packetChoice) renderPacket(); }).catch(() => {});
    }
    const pendingImport = opts.importMeasurements || null;
    // 3B: reopen a saved V2 estimate (routed here from the estimates list).
    // Rehydrate its state and render — takes precedence over draft restore.
    if (opts.estimateId) {
      if (rehydrateFromSaved(opts.estimateId)) {
        if (typeof window.showToast === 'function') window.showToast('Estimate loaded — review, regenerate docs, or edit', 'info');
        render();
        return;
      }
      // Fall through to a normal open if the doc wasn't found.
    } else {
      // Fresh open (from a lead or a draft) — NOT a reopen. Clear any stale
      // replay state so we don't render a previous reopen's saved numbers.
      state._reopenedDoc = null;
      state._reopenedClean = false;
    }
    // F7: if there's a draft AND the caller didn't pass a leadId
    // (i.e. fresh "start new estimate" click), offer to restore it.
    // Prefilling from a lead overrides any stale draft since the
    // lead data is authoritative.
    const leadId = opts.leadId || window._cardDetailLeadId || null;
    // New context → new estimate: after a reopened SAVED estimate (it lives in
    // Firestore; an edited one is also in the autosave draft), or when the
    // linked customer changes. Same customer keeps the in-memory work.
    const prevLeadId = (state.customer && state.customer.leadId) || state.leadId || null;
    if (_stateFromSavedDoc || (leadId && prevLeadId && prevLeadId !== leadId)) {
      _flushDraftNow();
      _resetEstimateState();
    }
    if (leadId) {
      prefillFromLead(leadId);
      if (pendingImport) {
        applyImportedMeasurements(pendingImport);
        if (typeof window.showToast === 'function') window.showToast('Drawing measurements imported into V2 Builder', 'success');
      }
      render();
      return;
    }
    restoreDraft().then((restored) => {
      if (pendingImport) {
        applyImportedMeasurements(pendingImport);
        if (typeof window.showToast === 'function') {
          window.showToast(restored
            ? 'Drawing measurements imported — they replace the restored draft’s measurements'
            : 'Drawing measurements imported into V2 Builder', 'success');
        }
      } else if (restored) {
        if (typeof window.showToast === 'function') {
          window.showToast('Restored unsaved draft', 'info');
        }
      }
      // W142: always sync the new Customer/Claim/Tier/County inputs
      // on open so the rep sees the current in-memory state even
      // when there's no lead AND no draft to restore. Without this,
      // a fresh-no-lead open shows the modal's hardcoded HTML
      // defaults regardless of what state was preserved across
      // previous opens.
      syncCustomerInputs();
      render();
    });
  }

  function close() {
    const m = document.getElementById('estV2Modal');
    if (m) m.classList.remove('open');
    closePresentation(); // Phase 3: never leave the overlay armed for next open
    _dismissUndo();      // a removal is committed once the builder closes
    _rowEdit = null;
    // 3B: closing a reopened estimate clears the replay + editing state so a
    // stale window._editingEstimateId can't bleed into the Classic builder's
    // next save (the two builders share that global).
    if (state._reopenedDoc) {
      if (window._editingEstimateId === state._reopenedDoc.id) window._editingEstimateId = null;
      state._reopenedDoc = null;
      state._reopenedClean = false;
    }
  }

  // ═════════════════════════════════════════════════════════
  // KENTUCKY SIGNING GATE (2026-10-03)
  //
  // "Send for Signature" (in-house e-sign since 2026-10-04; BoldSign before)
  // sends a "Roofing Contract" PDF with none of the KRS 367.624 insurance-job
  // notices or the KY cancellation form — those live only on the deal page
  // and the generated contract. On a Kentucky insurance job (the SAME test the contract notices
  // use: ky-insurance-law.js classifyLead — Kentucky address/ZIP, or an
  // insurance job whose state can't be read; fail closed) the e-sign button
  // is hidden and refuses (the server refuses too), and the rep is routed to "Sign on this phone" (the
  // deal page) or the generated contract, which both carry the notices.
  // ═════════════════════════════════════════════════════════
  const KY_SIGN_MSG = 'Kentucky insurance job: e-mail e-signature does not include the KRS 367.624 notices. ' +
    'Use "Sign on this phone" or "Generate contract" — both carry the notices and the cancellation form.';

  // The linked lead record (the open customer, else the loaded lead list).
  function _linkedLeadForSigning() {
    const id = state.leadId || (state.customer && state.customer.leadId) || null;
    if (!id) return null;
    try {
      const cur = window._leadDoc;
      if (cur && cur.id === id) return cur;
      return (Array.isArray(window._leads) && window._leads.find((l) => l && l.id === id)) || null;
    } catch (_) { return null; }
  }
  // The lead as the builder currently has it: the rep's typed address and
  // claim fields over the stored lead's.
  function _kySigningLead() {
    const lead = Object.assign({}, _linkedLeadForSigning() || {});
    const c = state.customer || {};
    const cl = state.claim || {};
    if (c.address) lead.address = c.address;
    if (cl.number) lead.claimNumber = cl.number;
    if (cl.carrier) lead.insCarrier = cl.carrier;
    return lead;
  }
  // classifyLead → { kyInsurance, insurance, … }, or null if the law module
  // is missing (the callers fail closed on null).
  function _kyClassification() {
    const J = window.NBDJurisdiction;
    if (!J || typeof J.classifyLead !== 'function') return null;
    try { return J.classifyLead(_kySigningLead(), { jobMode: state.jobMode }); } catch (_) { return null; }
  }
  function _kySigningBlocked() {
    const j = _kyClassification();
    return !j || j.kyInsurance === true;
  }
  function _applyKySigningGate() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    const blocked = _kySigningBlocked();
    const sign = document.getElementById('v2signBtn');
    if (sign && sign.classList) sign.classList.toggle('v2-ky-off', blocked);
    const co = document.getElementById('v2cosign');
    if (co && co.classList) co.classList.toggle('v2-ky-off', blocked);
    const note = document.getElementById('v2kyNote');
    if (note) note.hidden = !blocked;
    const kc = document.getElementById('v2kyContractBtn');
    if (kc) kc.hidden = !blocked;
  }

  // The generated contract (document-generator.js) — it prints the Kentucky
  // notices + cancellation form for this job. Saves the estimate first so the
  // contract reads the current numbers, then hands off to the same
  // prerequisites + pre-flight chain the customer page's Contract chip uses.
  async function openKyContract() {
    const toast = (m, t) => { if (window.showToast) window.showToast(m, t); };
    const leadId = state.leadId || (state.customer && state.customer.leadId) || null;
    if (!leadId) { toast('Link this estimate to a customer first — the contract is generated from the customer file.', 'error'); return; }
    if (!window._v2SavedEstimateId) {
      const id = await save();
      if (!id) { toast('Save the estimate first — the contract reads it.', 'error'); return; }
    }
    close();
    const reg = window.__NBD_CALL_REGISTRY;
    if (reg && typeof reg._generateDocWithPreflight === 'function') { reg._generateDocWithPreflight('contract', leadId); return; }
    const run = () => {
      if (window.DocPreflight && typeof window.DocPreflight.open === 'function') window.DocPreflight.open('contract', leadId);
      else toast('Document generator is still loading — open the customer and tap Contract.', 'warning');
    };
    if (!window.DocPreflight && window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
      window.ScriptLoader.loadBundle('docgen').then(run, run);
    } else run();
  }

  // ═════════════════════════════════════════════════════════
  // SEND TO HOMEOWNER / SIGN ON THIS PHONE (2026-10-03)
  //
  // "Create Deal Room" never called save(): the estimate the homeowner was
  // shown was never stored (no primary estimate, no job value on the lead),
  // then the builder closed and jumped to the Close Board. Now one flow:
  //   1. save the estimate (save() — _saveEstimate stamps primaryEstimateId +
  //      jobValue on the lead; a second tap UPDATES the same estimate)
  //   2. create the deal (or refresh this estimate's open deal)
  //   3. mint the /deal/<token> accept link
  //   4a. Send: the phone's share sheet (navigator.share), else Messages /
  //       Mail (sms: / mailto:) — the rep's own phone sends; nothing is sent
  //       from the server. The builder stays open.
  //   4b. Sign on this phone: open the accept page in-app (signature pad +
  //       the Kentucky notices); acceptance runs through submitDealAcceptance
  //       like any homeowner link — no e-mail needed.
  // ═════════════════════════════════════════════════════════

  // Tier prices for the deal: the per-SQ map when there is one; a cash
  // line-item estimate compares tiers like the presentation does; an
  // insurance estimate offers only the package it was priced on.
  function _dealPricesFor(estimate) {
    if (!estimate) return null;
    let src;
    if (estimate.prices && Object.keys(estimate.prices).some((k) => Number(estimate.prices[k]) > 0)) src = estimate.prices;
    else if (state.jobMode === 'insurance') src = { [state.tier]: estimate.total };
    else src = triTierTotals(estimate);
    const out = {};
    _v2Tiers().forEach((t) => { const v = Number(src && src[t]); if (v > 0) out[t] = v; });
    return Object.keys(out).length ? out : null;
  }

  function _statusSetter(id) {
    return (msg, kind) => {
      const el = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById(id) : null;
      if (!el) return;
      el.textContent = msg || '';
      if (el.classList) el.classList.toggle('v2-status-err', kind === 'error');
    };
  }

  // ── Full packet / Paperwork only (2026-10-04) ──────────────────────────
  // The rep's choice, remembered per user (deal-packet.js → userSettings).
  // Kept OUT of state: a new estimate must not reset it to the default.
  let _packetChoice = null;
  // Photos Jo deselected, for the lead they belong to.
  let _packetOff = { leadId: null, ids: [] };
  function _DP() { return window.NBDDealPacket || null; }
  function packetChoice() {
    if (_packetChoice) return _packetChoice;
    const DP = _DP();
    return DP ? DP.current() : 'full';
  }
  function _packetLeadId() { return state.leadId || (state.customer && state.customer.leadId) || null; }
  function _packetExcluded() {
    const lid = _packetLeadId();
    if (_packetOff.leadId !== lid) _packetOff = { leadId: lid, ids: [] };
    return _packetOff.ids;
  }
  // The lead's photos the full packet offers (up to 6, best first).
  function _packetCandidates() {
    const DP = _DP();
    const list = (state._leadPhotos && state._leadPhotos.list) || [];
    if (!DP) return [];
    return DP.candidates(list, {
      uid: (window._user && window._user.uid) || null,
      estimatePhotoIds: (state.photos || []).map((p) => p.id).filter(Boolean),
    });
  }
  // The IDs that go on the deal — none on a paperwork packet.
  function packetPhotoIds() {
    if (packetChoice() !== 'full') return [];
    const off = _packetExcluded();
    return _packetCandidates().map((p) => p.id).filter((id) => off.indexOf(id) === -1);
  }
  function setPacket(v) {
    const DP = _DP();
    _packetChoice = DP ? DP.normalize(v) : (v === 'paperwork' ? 'paperwork' : 'full');
    if (DP) DP.remember(_packetChoice);
    renderPacket();
    return _packetChoice;
  }
  function togglePacketPhoto(id) {
    const off = _packetExcluded();
    const i = off.indexOf(id);
    if (i >= 0) off.splice(i, 1); else off.push(id);
    renderPacket();
  }
  function renderPacket() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    const pk = packetChoice();
    const full = document.getElementById('v2packetFull');
    const paper = document.getElementById('v2packetPaper');
    if (full && full.classList) { full.classList.toggle('active', pk === 'full'); if (full.setAttribute) full.setAttribute('aria-pressed', String(pk === 'full')); }
    if (paper && paper.classList) { paper.classList.toggle('active', pk === 'paperwork'); if (paper.setAttribute) paper.setAttribute('aria-pressed', String(pk === 'paperwork')); }
    const hint = document.getElementById('v2packetHint');
    const grid = document.getElementById('v2packetPhotos');
    const e = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    if (pk !== 'full') {
      if (hint) hint.textContent = 'Estimate, terms and signature — no photos.';
      if (grid) { grid.innerHTML = ''; grid.hidden = true; }
      return;
    }
    const cands = _packetCandidates();
    const off = _packetExcluded();
    const on = cands.filter((p) => off.indexOf(p.id) === -1).length;
    if (hint) {
      hint.textContent = 'Estimate, ' + (on ? on + ' inspection photo' + (on === 1 ? '' : 's') : 'no photos') +
        ', scope, warranty and reviews.' + (cands.length ? ' Tap a photo to leave it out.' : '');
    }
    if (!grid) return;
    grid.innerHTML = cands.map((p) => {
      const isOff = off.indexOf(p.id) !== -1;
      return '<button type="button" class="v2-packet-ph' + (isOff ? ' off' : '') + '" data-action="toggle-packet-photo" data-arg="' + e(p.id) + '"' +
        ' aria-pressed="' + (!isOff) + '" aria-label="' + (isOff ? 'Add' : 'Leave out') + ' this photo">' +
        '<img src="' + e(p.url) + '" alt="" loading="lazy"><span class="v2-packet-check">✓</span></button>';
    }).join('');
    grid.hidden = !cands.length;
  }
  // Line names only — the deal page's "What's included" (no cost, no qty).
  function _scopeNames(estimate) {
    const out = [];
    ((estimate && estimate.lines) || []).forEach((l) => {
      const n = String((l && (l.name || l.description)) || '').trim();
      if (n && out.indexOf(n) === -1 && out.length < 15) out.push(n);
    });
    return out;
  }

  let _dealBusy = false;
  let _lastShare = null;

  // Steps 1–3. Resolves { deal, url } or null (the reason is on `say`).
  async function _prepareDealLink(say) {
    const estimate = effectiveEstimate();
    if (!estimate) { say('Add line items to the scope first.', 'error'); return null; }
    const c = state.customer || {};
    const name = (c.name || '').trim();
    if (!name) { say('Add the customer name (Customer step) first.', 'error'); return null; }
    const prices = _dealPricesFor(estimate);
    if (!prices) { say('Price the estimate first — no package has a total yet.', 'error'); return null; }

    // 1. Save. Re-sending the same estimate updates it instead of adding a
    //    copy; the edit id is cleared afterwards so it can't leak into the
    //    next builder session.
    say('Saving the estimate…');
    let pinned = null;
    if (window._v2SavedEstimateId && !window._editingEstimateId) {
      pinned = window._v2SavedEstimateId;
      window._editingEstimateId = pinned;
    }
    let estimateId = null;
    try { estimateId = await save(); }
    finally { if (pinned && window._editingEstimateId === pinned) window._editingEstimateId = null; }
    if (!estimateId) { say('The estimate did not save — nothing was sent.', 'error'); return null; }

    // 2. The Close Board engine loads with its view; load it here if needed.
    if ((!window.CloseBoard || typeof window.CloseBoard.getAcceptLink !== 'function')
        && window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
      try { await window.ScriptLoader.loadBundle('closeboard'); } catch (_) { /* checked below */ }
    }
    const CB = window.CloseBoard;
    if (!CB || typeof CB.createFromEstimate !== 'function' || typeof CB.getAcceptLink !== 'function') {
      say('The deal page did not load — check signal and try again.', 'error');
      return null;
    }
    const cl = state.claim || {};
    const j = _kyClassification();
    const leadData = {
      id: c.leadId || state.leadId || null,
      estimateId,
      name,
      email: (c.email || '').trim(),
      phone: c.phone || '',
      address: c.address || '',
      insCarrier: cl.carrier || '',
      claimNumber: cl.number || '',
      deductible: Number(cl.deductible) || 0,
      // Insurance by the same test the builder's Kentucky gate uses, so the
      // deal page prints the KY notices for exactly the jobs gated here.
      insuranceClaim: !!(j && j.insurance) || state.jobMode === 'insurance'
    };
    let deal;
    // The packet chosen above (2026-10-04): photo IDs only, never URLs.
    const packet = packetChoice();
    // The deposit inputs the saved estimate carries (review R2-2-5): the deal
    // page prices each tier through deposit-rule.js fromEstimate on these —
    // the same mode / claim / address the estimate, contract and invoice use.
    const _ov = estimate.depositPlan && estimate.depositPlan.override;
    const depositBasis = {
      mode: estimate.mode || state.jobMode,
      claim: { deductible: cl.deductible, acv: cl.acv },
      addr: c.address || '',
      depositPlan: _ov ? { override: _ov } : null,
    };
    const dealEst = { id: estimateId, prices, packet, packetPhotoIds: packetPhotoIds(), scopeSummary: _scopeNames(estimate), depositBasis };
    try { deal = CB.createFromEstimate(dealEst, leadData); }
    catch (e) {
      console.error('[v2] deal create failed:', e);
      say('Could not create the deal — try again.', 'error');
      return null;
    }
    if (!deal || !deal.id) { say('Could not create the deal — try again.', 'error'); return null; }

    // 3. Upload the page + mint the single-use accept link.
    say('Creating the homeowner link…');
    let url = null;
    try { url = await CB.getAcceptLink(deal); } catch (e) { url = null; }
    if (!url) { say('Could not create the link — see the message and try again.', 'error'); return null; }
    return { deal, url };
  }

  function _brandName() {
    try {
      const b = (typeof window._brand === 'function') ? window._brand() : null;
      return (b && (b.legalName || b.name)) || '';
    } catch (_) { return ''; }
  }
  function _shareMessage(name, url) {
    const first = String(name || '').trim().split(/\s+/)[0] || 'there';
    const brand = _brandName();
    return 'Hi ' + first + '! Here\'s your roof estimate' + (brand ? ' from ' + brand : '') +
      '. Compare the options and sign here: ' + url;
  }
  function _escAttr(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function _smsHref(phone, body) {
    const digits = String(phone || '').replace(/[^\d+]/g, '');
    return digits.replace(/\D/g, '').length >= 7 ? 'sms:' + digits + '?body=' + encodeURIComponent(body) : '';
  }
  function _mailHref(email, body) {
    if (!email || email.indexOf('@') === -1) return '';
    const brand = _brandName();
    return 'mailto:' + encodeURIComponent(email) + '?subject=' + encodeURIComponent('Your roof estimate' + (brand ? ' — ' + brand : '')) +
      '&body=' + encodeURIComponent(body);
  }
  // The rep's fallback controls under the button: Share / Text / Email / Copy.
  // Plain links, so each tap is a fresh user gesture (iOS won't open a share
  // sheet or a sms: link after a long await).
  function _renderShareBox() {
    const box = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('v2shareBox') : null;
    if (!box || !_lastShare) return;
    const s = _lastShare;
    const sms = _smsHref(s.phone, s.text);
    const mail = _mailHref(s.email, s.text);
    const canShare = typeof navigator !== 'undefined' && navigator && typeof navigator.share === 'function';
    box.innerHTML =
      (canShare ? '<button type="button" class="v2-share-act" data-action="share-native">📤 Share…</button>' : '') +
      (sms ? '<a class="v2-share-act" data-action="share-mark" data-arg="sms" href="' + _escAttr(sms) + '">💬 Text</a>' : '') +
      (mail ? '<a class="v2-share-act" data-action="share-mark" data-arg="email" href="' + _escAttr(mail) + '">✉️ Email</a>' : '') +
      '<button type="button" class="v2-share-act" data-action="share-copy">📋 Copy link</button>' +
      '<div class="v2-share-url">' + _escAttr(s.url) + '</div>';
    box.hidden = false;
  }
  function _markShared(via) {
    if (!_lastShare) return;
    try { if (window.CloseBoard && typeof window.CloseBoard.markShared === 'function') window.CloseBoard.markShared(_lastShare.dealId, via); } catch (_) {}
  }
  // navigator.share, else Messages (phone on file), else Mail (email on file).
  // `auto` = called right after the link was minted (not from a tap).
  async function _shareNative(auto) {
    const s = _lastShare;
    if (!s) return 'none';
    const nav = (typeof navigator !== 'undefined') ? navigator : null;
    if (nav && typeof nav.share === 'function') {
      try {
        await nav.share({ title: 'Your roof estimate', text: s.text.replace(s.url, '').trim(), url: s.url });
        _markShared('link');
        if (window.showToast) window.showToast('✓ Shared', 'success');
        return 'shared';
      } catch (e) {
        // AbortError = the rep closed the sheet. NotAllowedError = the tap's
        // activation expired during the save — the Share button below works.
        return (e && e.name === 'AbortError') ? 'cancelled' : 'blocked';
      }
    }
    if (!auto) return 'none';
    const href = _smsHref(s.phone, s.text) || _mailHref(s.email, s.text);
    if (!href) return 'none';
    _markShared(href.indexOf('sms:') === 0 ? 'sms' : 'email');
    try { window.location.href = href; } catch (_) {}
    return href.indexOf('sms:') === 0 ? 'sms' : 'email';
  }
  async function _copyShareLink() {
    if (!_lastShare) return;
    let okCopy = false;
    try { await navigator.clipboard.writeText(_lastShare.url); okCopy = true; } catch (_) { okCopy = false; }
    _markShared('link');
    if (window.showToast) window.showToast(okCopy ? 'Link copied' : 'Link ready — copy it from below', okCopy ? 'success' : 'info');
  }

  async function sendToHomeowner() {
    if (_dealBusy) return 'busy';
    _dealBusy = true;
    const btn = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('v2sendHoBtn') : null;
    const say = _statusSetter('v2shareStatus');
    if (btn) btn.disabled = true;
    try {
      const r = await _prepareDealLink(say);
      if (!r) return 'failed';
      const c = state.customer || {};
      _lastShare = {
        dealId: r.deal.id, url: r.url,
        name: c.name || '', phone: c.phone || '', email: (c.email || '').trim(),
        text: _shareMessage(c.name, r.url)
      };
      _renderShareBox();
      say('✓ Link ready — send it from your phone.', 'ok');
      return await _shareNative(true);
    } finally {
      _dealBusy = false;
      if (btn) btn.disabled = false;
    }
  }

  async function signOnThisPhone() {
    if (_dealBusy) return 'busy';
    _dealBusy = true;
    const say = _statusSetter('v2signStatus');
    // Open the tab INSIDE the tap — Safari blocks window.open after an await.
    let w = null;
    try { w = (typeof window.open === 'function') ? window.open('', '_blank') : null; } catch (_) { w = null; }
    try {
      const r = await _prepareDealLink(say);
      if (!r) { if (w) { try { w.close(); } catch (_) {} } return 'failed'; }
      if (w && !w.closed) {
        try { w.location.href = r.url; say('Signing page open — hand the phone to the homeowner.', 'ok'); return 'opened'; }
        catch (_) { /* fall through to the link */ }
      }
      // Popup blocked: a plain link opens it on the next tap.
      const box = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('v2shareBox') : null;
      if (box) {
        box.innerHTML = '<a class="v2-share-act" target="_blank" rel="noopener" href="' + _escAttr(r.url) + '">📱 Open the signing page</a>';
        box.hidden = false;
      }
      say('Tap "Open the signing page", then hand the phone to the homeowner.', 'ok');
      return 'link';
    } finally {
      _dealBusy = false;
    }
  }

  window.EstimateV2UI = {
    open,
    close,
    setMode,
    setJobMode,
    updateMeasurement,
    setSearch,
    setCategory,
    addToScope,
    removeFromScope,
    clearScope,
    loadPreset,
    addScopeEntries,
    // Roof Care Plan (2026-10-05): V3's Repair-or-roof choice lands here.
    setWorkKind,
    finalize,
    save,
    // 2026-10-03: the one homeowner flow (V3's Finish primary calls it too).
    sendToHomeowner,
    signOnThisPhone,
    // Quick Measure import (tools.js applyQMData) pushes measurements into
    // an ALREADY-OPEN builder through here — open({importMeasurements})
    // only covers the not-yet-open case. Re-renders so the imported
    // numbers (and the recomputed total) show immediately.
    applyImportedMeasurements: (imp) => { applyImportedMeasurements(imp || {}); render(); },
    getState: () => state,
    // Per-tier totals for the V3 Package cards — the same numbers the
    // homeowner presentation compares (an absent tier reads null).
    tierTotals: () => triTierTotals(effectiveEstimate()),
    // V3 Photos step: photos taken from inside the estimate (PhotoEngine
    // upload to the linked customer) refresh the pick grid and ride the
    // estimate — a photo shot here is one the rep wants on the quote.
    reloadLeadPhotos: () => loadLeadPhotos(true),
    includePhoto: (photoId) => {
      const on = (state.photos || []).some((p) => p.id === photoId);
      if (!on) togglePhoto(photoId);
    },
    // Test seam — pure builders + reopen helpers, exercised by
    // tests/estimate-v2-payload.test.js.
    _test: {
      buildEstimatePayload: _buildEstimatePayload,
      buildSavePayload: _buildSavePayload,
      reconstructEstimateFromSaved: _reconstructEstimateFromSaved,
      rehydrateFromSaved: rehydrateFromSaved,
      effectiveEstimate: effectiveEstimate,
      collectDraft: collectDraft,
      getState: () => state,
      // Display helpers. Pure, and the two that decide whether the scope
      // panel tells the rep the truth about quantity and price —
      // tests/estimate-scope-display.test.js.
      fmtQty: fmtQty,
      lineRetail: lineRetail,
      shopRepairMinimum: shopRepairMinimum,
      shopLineItemRates: shopLineItemRates,
      // Close flow (2026-10-03) — tests/close-flow-2026-10-03.test.js.
      kySigningBlocked: _kySigningBlocked,
      applyKySigningGate: _applyKySigningGate,
      dealPricesFor: _dealPricesFor,
      sendForSignature: sendForSignature,
      sendToHomeowner: sendToHomeowner,
      signOnThisPhone: signOnThisPhone,
      lastShare: () => _lastShare,
      // Deal packet (2026-10-04) — tests/deal-packet-2026-10-04.test.js.
      setPacket: setPacket,
      packetChoice: packetChoice,
      packetPhotoIds: packetPhotoIds,
      togglePacketPhoto: togglePacketPhoto,
      renderPacket: renderPacket,
    },
  };

  // Global launchers matched in dashboard.html
  window.openEstimateV2Builder = open;
  window.closeEstimateV2Builder = close;

  console.log('[EstimateV2UI] Modal builder ready. Trigger: openEstimateV2Builder()');
})();
