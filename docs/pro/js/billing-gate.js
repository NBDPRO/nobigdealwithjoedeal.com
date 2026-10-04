// ═══════════════════════════════════════════════════════════════
// NBD Pro — Billing Gate Module
//
// Client-side plan checking, usage tracking, and soft feature
// gates. Reads the user's plan from Firestore (subscriptions/{uid})
// and enforces limits with warnings (not hard locks).
//
// Tier limits:
//   free:       10 leads/mo,  0 reports,  0 AI calls, solo
//   starter:    50 leads/mo,  2 reports, 20 AI calls, solo
//   team:      150 leads/mo,  ∞ reports, 100 AI calls, 2 reps
//   growth:    500 leads/mo,  ∞ reports,  ∞ AI calls, 5 reps
//   enterprise:  ∞ everything
//
// Soft gating on reports/aiCalls: warns at 80%, informational at 100%.
// Leads: warns at 80%; at 100% new-lead creation is blocked client-side
// until the next cycle or an upgrade (existing leads stay fully editable).
//
// Usage is tracked per billing cycle in Firestore and reset
// by the webhook when a new invoice is paid.
//
// Exposes: window.NBDBilling
// ═══════════════════════════════════════════════════════════════

let _NBD_BG_DELEGATE; // module-local (globals Tranche 1 — was window.*)
(function () {
  'use strict';
  if (window.NBDBilling) return;

  // ── Plan definitions ──
  // Canonical keys match the Stripe price tiers (functions/stripe.js
  // VALID_PLANS / functions/billing.js PLAN_LIMITS). Legacy doc values
  // (foundation/blueprint/professional — written forever by old
  // access-code grants and Stripe metadata) are resolved to canonical
  // ONCE, in loadSubscription() via PLAN_ALIASES, so `_plan` (and
  // getPlan().plan) is always a canonical key. The foundation/
  // professional alias rows below are belt-and-braces for any code
  // that indexes PLANS with a raw doc value directly.
  const PLANS = {
    free:         { label: 'Free',         leads: 10,  reports: 0,        aiCalls: 0,        reps: 1,        price: 0 },
    starter:      { label: 'Starter',      leads: 50,  reports: 2,        aiCalls: 20,       reps: 1,        price: 99 },
    foundation:   { label: 'Starter',      leads: 50,  reports: 2,        aiCalls: 20,       reps: 1,        price: 99 },
    team:         { label: 'Team',         leads: 150, reports: Infinity, aiCalls: 100,       reps: 2,        price: 149 },
    growth:       { label: 'Growth',       leads: 500, reports: Infinity, aiCalls: Infinity, reps: 5,        price: 299 },
    professional: { label: 'Growth',       leads: 500, reports: Infinity, aiCalls: Infinity, reps: 5,        price: 299 },
    enterprise:   { label: 'Enterprise',   leads: Infinity, reports: Infinity, aiCalls: Infinity, reps: Infinity, price: null }
  };

  // Read-boundary alias resolution — mirrors PLAN_ALIASES in
  // nbd-auth.js. Production subscription docs carry legacy values
  // FOREVER; this map can never be removed.
  const PLAN_ALIASES = { foundation: 'starter', blueprint: 'starter', professional: 'growth' };
  function _normalizePlan(raw) {
    const k = (typeof raw === 'string' ? raw : '').toLowerCase().trim();
    return PLAN_ALIASES[k] || k || 'free';
  }

  let _plan = 'free';
  let _status = 'none';  // none | active | trialing | past_due | cancelled
  let _usage = { leads: 0, reports: 0, aiCalls: 0, cycleStart: null };
  let _trialEndsAt = null;
  // Per-seat add-ons (Route 1): extra rep seats bought beyond the plan cap,
  // stamped on the sub doc by the Stripe webhook. UI mirror only — the server
  // cap sites (createTeamInvite/assignSeats/lapse) are the enforced truth.
  let _purchasedSeats = 0;
  // Sub doc `source` ('checkout' = card-billed Stripe sub, 'access_code' =
  // comp, etc.). Exposed so the team tab hides the buy-seats stepper for
  // tenants the seat-charging callable would refuse (non-card-billed).
  let _source = null;
  let _loaded = false;

  // Owner bypass — claim-ONLY since the OWNER_EMAILS retirement
  // (2026-07-06): keyed on the { owner: true } custom claim minted
  // server-side by mintOwnerClaims (functions/handlers/auth.js) from the
  // single server-side list in handlers/_shared.js. The email fallback
  // this module used to carry is gone — nbd-auth.js keeps the founder
  // emails solely as a MINT TRIGGER (never authorization) and heals a
  // missing claim at login (mint + token re-read), so by the time this
  // module gates anything a founder session already carries the claim.
  function _isOwner() {
    // window._userClaims is populated by nbd-auth.js / dashboard-
    // bootstrap (and by loadSubscription below).
    try {
      return !!(window._userClaims && window._userClaims.owner === true);
    } catch (_) { return false; }
  }

  // Wait up to `ms` for the Firestore window globals to exist. The
  // modular Firebase SDK is imported in an ES module script in the page
  // head; if loadSubscription() races it, the first call would throw and
  // silently fall back to 'free'. Poll briefly so the caller can see the
  // real sub doc on the first successful tick.
  function _waitForFirestore(ms) {
    const deadline = Date.now() + ms;
    return new Promise((resolve) => {
      (function tick() {
        const ready = typeof window.getDoc === 'function'
                   && typeof window.doc === 'function'
                   && window.db;
        if (ready) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, 50);
      })();
    });
  }

  // Pillar 4: billing is company-level — resolve the subscription from
  // the companyId claim (== owner uid) so team members see the team
  // plan, not a phantom 'free' under their own uid. Solo owners:
  // companyId == uid, byte-identical behavior.
  async function _resolveBillingKey(uid) {
    let billingKey = uid;
    try {
      if (window._userClaims && window._userClaims.companyId) {
        billingKey = window._userClaims.companyId;
      } else if (window._user && typeof window._user.getIdTokenResult === 'function') {
        const tr = await window._user.getIdTokenResult();
        billingKey = (tr && tr.claims && tr.claims.companyId) || uid;
      }
    } catch (_) { /* fall back to uid */ }
    return billingKey;
  }

  // ── Load subscription data from Firestore ──
  async function loadSubscription() {
    try {
      const uid = window._user?.uid;
      if (!uid) return;

      // Resolve token claims once, up front, so the owner short-circuit
      // below can key on claims.owner === true. This read is the token
      // cache in the common case (nbd-auth already read/refreshed it at
      // login, including the owner-mint heal path), so a failure here is
      // both rare and self-limiting: the founder would resolve like a
      // normal user for this load and heal on the next.
      try {
        if (!window._userClaims && window._user
            && typeof window._user.getIdTokenResult === 'function') {
          const tr = await window._user.getIdTokenResult();
          if (tr && tr.claims) window._userClaims = tr.claims;
        }
      } catch (_) { /* claims unread — owner short-circuit simply won't fire */ }

      // Owner short-circuit: enterprise defaults, never gated. Gate
      // safety never depends on the read below — canUse/enforceGate/
      // softGate key on _isOwner() before ever consulting _plan, and the
      // defaults are pinned BEFORE any Firestore I/O so an auth/permission
      // hiccup can't downgrade the founder.
      //
      // Founder display mirror (2026-07-29): the old block skipped the
      // Firestore read entirely, so _source stayed null and _purchasedSeats
      // stayed 0 — the team tab's _renderSeatBuy() therefore hid the
      // "Extra seats" stepper from a founder who holds a REAL card-billed
      // sub (source 'checkout'). Best-effort read the sub doc and mirror a
      // source==='checkout' doc into the display state (plan/status/source/
      // purchasedSeats/usage/trialEndsAt) so getPlan() reflects the real
      // subscription — with its real finite caps — and the stepper renders.
      // ONLY checkout docs mirror: a comp/junk doc (access_code, plan
      // 'free', missing source) must never repaint the founder's billing
      // UI as Free, and checkout is the only sub kind setCompanySeatCount
      // can act on anyway. Missing doc or ANY read failure keeps the
      // enterprise defaults.
      if (_isOwner()) {
        _plan = 'enterprise';
        _status = 'active';
        _usage = { leads: 0, reports: 0, aiCalls: 0, cycleStart: null };
        _trialEndsAt = null;
        _purchasedSeats = 0;
        _source = null;
        _loaded = true;
        try {
          if (await _waitForFirestore(3000)) {
            const billingKey = await _resolveBillingKey(uid);
            const snap = await window.getDoc(window.doc(window.db, 'subscriptions', billingKey));
            const data = snap.exists() ? snap.data() : null;
            if (data && data.source === 'checkout') {
              _plan = _normalizePlan(data.plan || 'free');
              _status = data.status || 'none';
              _usage = data.usage || { leads: 0, reports: 0, aiCalls: 0 };
              _trialEndsAt = data.trialEndsAt || null;
              _source = 'checkout';
              // Same entitled-status seat mirror as the non-owner path.
              const entitledForSeats = _status === 'active' || _status === 'trialing'
                || _status === 'past_due';
              _purchasedSeats = entitledForSeats
                ? Math.max(0, Number(data.purchasedSeats) || 0) : 0;
            }
          }
        } catch (_) { /* display mirror failed — founder keeps enterprise defaults */ }
        return;
      }

      const firestoreReady = await _waitForFirestore(3000);
      if (!firestoreReady) {
        // Surface the race explicitly instead of silently becoming 'free'.
        // Leave _loaded=false so softGate()/hardGate() treat the user as
        // "plan unknown — allow the action" rather than falsely free.
        console.error('[Billing] Firestore SDK not ready after 3s — plan unknown, deferring gating.');
        return;
      }

      const billingKey = await _resolveBillingKey(uid);
      const snap = await window.getDoc(window.doc(window.db, 'subscriptions', billingKey));
      if (snap.exists()) {
        const data = snap.data();
        _plan = _normalizePlan(data.plan || 'free');
        _status = data.status || 'none';
        _usage = data.usage || { leads: 0, reports: 0, aiCalls: 0 };
        _trialEndsAt = data.trialEndsAt || null;
        // Access-code trial expiry — mirror of the read-time check in
        // functions/billing.js trackUsage (the server meter is the real
        // gate; this keeps the UI honest). A code-granted subscription
        // past its trialEndsAt gates as the free plan. Stripe subs and
        // untimed code comps are untouched.
        if (
          data.source === 'access_code'
          && _trialEndsAt
          && typeof _trialEndsAt.toMillis === 'function'
          && _trialEndsAt.toMillis() < Date.now()
        ) {
          _plan = 'free';
          _status = 'trial_expired';
        }
        // Mirror the server's entitled-status gate (createTeamInvite/
        // assignSeats): purchased seats count ONLY while the sub is
        // active/trialing/past_due. Keyed on the FINAL _status — after the
        // trial-expiry override above — so an 'unpaid'/'cancelled'/
        // 'trial_expired' doc's stale seat count can't inflate the UI cap
        // the server will refuse anyway.
        const entitledForSeats = _status === 'active' || _status === 'trialing'
          || _status === 'past_due';
        _purchasedSeats = entitledForSeats
          ? Math.max(0, Number(data.purchasedSeats) || 0) : 0;
        _source = typeof data.source === 'string' ? data.source : null;
      } else {
        _plan = 'free';
        _status = 'none';
        _purchasedSeats = 0;
        _source = null;
      }
      _loaded = true;
    } catch (e) {
      console.warn('[Billing] loadSubscription failed:', e.message);
      // Do NOT force plan='free' + _loaded=true here. That made a paid tenant
      // flash as Free with Upgrade buttons whenever the sub doc read failed
      // (network blip, rules race, SDK hiccup). Leave _loaded=false so
      // softGate/enforceGate fail OPEN (plan unknown) and the billing UI can
      // render a neutral "Loading…" / "Unavailable" state instead of a false
      // Free tier. Server createCheckoutSession already double-bill-guards
      // (#992); this only fixes the scary-but-harmless client flash.
      _purchasedSeats = 0;
      _source = null;
      _loaded = false;
    }
  }

  // ── Check if a feature is available on the current plan ──
  function canUse(feature) {
    if (_isOwner()) return true; // owner accounts are never limit-gated
    const limits = PLANS[_plan] || PLANS.free;
    switch (feature) {
      case 'leads':   return _usage.leads < limits.leads;
      case 'reports': return limits.reports === Infinity || _usage.reports < limits.reports;
      case 'aiCalls': return limits.aiCalls === Infinity || _usage.aiCalls < limits.aiCalls;
      case 'team':    return limits.reps > 1;
      default:        return true;
    }
  }

  // ── Get usage percentage for a feature (0-1) ──
  function usagePct(feature) {
    const limits = PLANS[_plan] || PLANS.free;
    switch (feature) {
      case 'leads':   return limits.leads === Infinity ? 0 : (_usage.leads / limits.leads);
      case 'reports': return limits.reports === Infinity ? 0 : (_usage.reports / limits.reports);
      case 'aiCalls': return limits.aiCalls === Infinity ? 0 : (_usage.aiCalls / limits.aiCalls);
      default:        return 0;
    }
  }

  // ── Increment usage counter ──
  // Called by the app when a gated action happens (lead created, report
  // generated, AI call made).
  //
  // Audit batch 3 (2026-05-13): closes the Audit A KNOWN GAP. Routes
  // through the trackUsage Cloud Function (admin SDK) which atomically
  // increments subscriptions/{uid}.usage[feature] in a transaction.
  // Firestore rules still block direct client writes — only the callable
  // touches the doc. The server returns the post-increment usage + plan
  // limit + overage flag so we can sync local state to the server truth.
  //
  // Local counter is patched optimistically so the gate-check renders
  // instantly; the server call is fire-and-forget for the increment but
  // we reconcile if the server reports a different number (e.g. counter
  // drift from another device).
  let _httpsCallableTrackUsage = null;
  async function _getCallable() {
    if (_httpsCallableTrackUsage) return _httpsCallableTrackUsage;
    if (window._functions && window._httpsCallable) {
      _httpsCallableTrackUsage = window._httpsCallable(window._functions, 'trackUsage');
      return _httpsCallableTrackUsage;
    }
    try {
      const mod = await import('/assets/vendor/firebase/12.19.0/firebase-functions.js');
      window._functions    = window._functions    || mod.getFunctions();
      window._httpsCallable = window._httpsCallable || mod.httpsCallable;
      _httpsCallableTrackUsage = window._httpsCallable(window._functions, 'trackUsage');
      return _httpsCallableTrackUsage;
    } catch (e) {
      console.warn('[Billing] couldn\'t load functions SDK:', e.message);
      return null;
    }
  }
  async function trackUsage(feature) {
    if (!window._user?.uid) return;
    // Optimistic local bump — UI updates immediately.
    _usage[feature] = (_usage[feature] || 0) + 1;
    const call = await _getCallable();
    if (!call) return; // SDK didn't load (offline / blocked); local counter is best-effort
    try {
      const res = await call({ feature });
      const data = res && res.data;
      if (data && typeof data.usage === 'number') {
        // Server authoritative — keep local in sync. If the server
        // reports higher (another device incremented too) we accept it.
        _usage[feature] = data.usage;
      }
    } catch (e) {
      // Soft fail — local counter still tracks within the session, just
      // doesn't survive to other devices on this iteration.
      console.warn('[Billing] trackUsage callable failed:', e.message);
    }
  }

  // ── Enforcing gate — warn at 80%, BLOCK at the cap (gauntlet batch 2) ──
  // Product decision 2026-07-16: caps are real ("we can't afford to give
  // free tiers infinite leads") with nudges on the way. Returns true if the
  // action may proceed; at/over the cap it shows the upgrade modal and
  // returns FALSE. Owners/admins and unlimited features always pass.
  // Fails OPEN before the plan loads — a network blip must never block a
  // rep mid-door-knock (H-03 keeps the plan itself from being spoofed).
  function enforceGate(feature, featureLabel) {
    if (!_loaded) return true;    // plan unknown — never block on a race
    if (_isOwner()) return true;  // owner accounts are never limit-gated
    const limits = PLANS[_plan] || PLANS.free;
    const limit = limits[feature === 'aiCalls' ? 'aiCalls' : feature];
    if (limit === Infinity) return true;
    if (!canUse(feature)) {
      showUpgradeModal(feature, featureLabel, _usage[feature] || 0, limit);
      return false; // hard stop — the cap is the cap
    }
    // Under the cap: nudge as it approaches (softGate's 80% toast).
    softGate(feature, featureLabel);
    return true;
  }

  // ── Soft gate check — warn at 80%, modal at 100% ──
  // Returns true if the action should proceed, false if blocked.
  // Never actually blocks — just shows warnings/modals.
  function softGate(feature, featureLabel) {
    if (!_loaded) return true; // Don't block before plan loads
    if (_isOwner()) return true; // owner accounts bypass warnings + upgrade modal
    const pct = usagePct(feature);
    const limits = PLANS[_plan] || PLANS.free;
    const limit = limits[feature === 'aiCalls' ? 'aiCalls' : feature];

    if (limit === Infinity || limit === 0) return true; // unlimited or not tracked

    if (pct >= 1.0) {
      // At limit — show upgrade modal but allow action
      showUpgradeModal(feature, featureLabel, _usage[feature], limit);
      return true; // soft gate — still allow
    }
    if (pct >= 0.8) {
      // Approaching limit — show warning toast
      const remaining = limit - (_usage[feature] || 0);
      if (typeof showToast === 'function') {
        showToast(remaining + ' ' + featureLabel + ' remaining this month. Upgrade for more.', 'warning');
      }
    }
    return true;
  }

  // ── Upgrade modal ──
  function showUpgradeModal(feature, featureLabel, used, limit) {
    const existing = document.getElementById('nbd-upgrade-modal');
    if (existing) existing.remove();

    // Upgrade ladder: free → starter → team → growth → (Enterprise, no self-serve).
    const nextPlan = _plan === 'free' ? 'starter'
      : (_plan === 'starter' ? 'team'
      : (_plan === 'team' ? 'growth' : null));
    if (!nextPlan) {
      // Growth is the top self-serve tier with a FINITE lead cap, so there's no
      // higher plan to upsell and the modal has nothing to render. But
      // enforceGate() is about to hard-block the action, so a silent return
      // leaves e.g. the Add-Lead button doing nothing with zero feedback. Surface
      // a toast explaining the cap instead (enterprise never reaches here — its
      // limits are Infinity, so enforceGate returns before calling this).
      if (typeof window.showToast === 'function') {
        window.showToast(
          `You've reached your monthly limit of ${limit} ${featureLabel} on the ` +
          `${(PLANS[_plan] || {}).label || _plan} plan. Contact us to raise it.`,
          'error');
      }
      return;
    }

    const nextInfo = PLANS[nextPlan];
    const overlay = document.createElement('div');
    overlay.id = 'nbd-upgrade-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;padding:20px;';

    const card = document.createElement('div');
    card.style.cssText = 'background:var(--s,#1a1d23);border:2px solid #BD5728;border-radius:14px;padding:32px;max-width:440px;width:100%;text-align:center;';
    card.innerHTML = `
      <div style="font-size:36px;margin-bottom:12px;">📈</div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-size:24px;font-weight:800;color:var(--t,#fff);text-transform:uppercase;margin-bottom:8px;">Plan Limit Reached</div>
      <div style="font-size:13px;color:var(--m,#888);margin-bottom:20px;line-height:1.5;">
        You've used <strong style="color:var(--orange,#BD5728);">${used} of ${limit}</strong> ${featureLabel} this month on the <strong>${(PLANS[_plan] || {}).label || 'Free'}</strong> plan.
      </div>
      <div style="font-size:13px;color:var(--t,#fff);margin-bottom:20px;">
        Upgrade to <strong style="color:var(--orange,#BD5728);">${nextInfo.label}</strong> for ${nextInfo[feature === 'aiCalls' ? 'aiCalls' : feature] === Infinity ? 'unlimited' : nextInfo[feature === 'aiCalls' ? 'aiCalls' : feature]} ${featureLabel}/mo — <strong>$${nextInfo.price}/mo</strong>
      </div>
      <div style="display:flex;gap:10px;justify-content:center;">
        <button data-bg-action="closeUpgrade" style="background:var(--s2);border:1px solid var(--br);color:var(--m);padding:10px 20px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;">Maybe Later</button>
        <button data-bg-action="closeUpgradeAndGoBilling" style="background:var(--orange,#BD5728);border:none;color:#fff;padding:10px 24px;border-radius:6px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:700;">View Plans</button>
      </div>
      <div style="font-size:10px;color:var(--m,#888);margin-top:14px;">New leads pause until you upgrade or your cycle resets — everything you already have stays fully editable.</div>
    `;
    overlay.appendChild(card);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // ── Get current plan info ──
  function getPlan() {
    return {
      plan: _plan,
      // false until a successful loadSubscription() (or owner short-circuit).
      // Billing UI MUST check this before rendering Free + Upgrade — an
      // unloaded plan still defaults _plan to 'free' for fail-open gates.
      loaded: _loaded,
      label: (PLANS[_plan] || PLANS.free).label,
      status: _status,
      usage: { ..._usage },
      limits: PLANS[_plan] || PLANS.free,
      purchasedSeats: _purchasedSeats,
      source: _source,
      trialEndsAt: _trialEndsAt,
      isTrialing: _status === 'trialing',
      isPastDue: _status === 'past_due',
      isCancelled: _status === 'cancelled',
      isActive: _status === 'active' || _status === 'trialing'
    };
  }

  // ── Expose ──
  window.NBDBilling = {
    PLANS,
    loadSubscription,
    canUse,
    usagePct,
    trackUsage,
    softGate,
    enforceGate,
    getPlan,
    showUpgradeModal
  };

  console.log('[NBDBilling] Module ready');
})();


// CSP-safe delegation (replaces 2 inline onclicks).
(function(){if(_NBD_BG_DELEGATE)return;_NBD_BG_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-bg-action]');if(!t)return;var a=t.dataset.bgAction;try{var m=document.getElementById('nbd-upgrade-modal');if(m)m.remove();if(a==='closeUpgradeAndGoBilling'&&typeof goTo==='function'){/* 'billing' is NOT a route (routeConfig, dashboard-state.js) — goTo fell through and dumped the user on the pipeline with no explanation. Billing is a TAB inside Settings. goTo opens the tab named by params.id (#/settings/billing); a switchSettingsTab here was undone by goTo's own 50 ms default-tab timer. An unknown tab falls back to Profile, still the right screen. */goTo('settings',{id:'billing'});}}catch(e){console.error('[billing-gate]',e);}});})();
