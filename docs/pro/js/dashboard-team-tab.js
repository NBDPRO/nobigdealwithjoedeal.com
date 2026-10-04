      // ── Team management functions ──
      // Hardening 2026-06-09: member docs are semi-external strings — today
      // they're owner-typed invites, but any signup/import path that writes
      // the same companies/<uid>/members collection feeds this renderer too.
      // Every member field that lands in the row template's innerHTML goes
      // through _nbdEscHtml (same fix shape as widgets.js esc(), PR #595;
      // that copy is IIFE-scoped, so this hydrated-template script defines
      // its own).
      function _nbdEscHtml(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
      }
      async function inviteTeamMember() {
        var email = (document.getElementById('inviteRepEmail')?.value || '').trim();
        var role = document.getElementById('inviteRepRole')?.value || 'sales_rep';
        if (!email || !email.includes('@')) {
          if (typeof showToast === 'function') showToast('Enter a valid email address', 'error');
          return;
        }
        if (!window._user?.uid) {
          if (typeof showToast === 'function') showToast('Not signed in', 'error');
          return;
        }
        try {
          // Pillar 4: invites go through the createTeamInvite callable —
          // firestore.rules denies client member CREATEs now so plan seat
          // limits are enforced server-side. The callable also ensures the
          // companies/{uid} doc exists (the setDoc that used to live here).
          // Self-provision the functions SDK globals (billing-gate pattern) —
          // they're set lazily and may not exist at click time.
          if (!(window._functions && window._httpsCallable)) {
            var mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
            window._functions = window._functions || mod.getFunctions();
            window._httpsCallable = window._httpsCallable || mod.httpsCallable;
          }
          var inviteFn = window._httpsCallable(window._functions, 'createTeamInvite');
          var res = await inviteFn({ email: email.toLowerCase(), role: role });
          var out = (res && res.data) || {};
          document.getElementById('inviteRepEmail').value = '';
          // showToast (dashboard-ui.js) renders msg via innerHTML — escape
          // the typed email before it rides along.
          // Phase 3: the teamInviteEmail trigger now actually emails the
          // invitee signup steps — the old copy said "sent" when nothing was.
          if (typeof showToast === 'function') {
            var seatNote = (out.seatsLimit != null) ? ' (' + out.seatsUsed + ' of ' + out.seatsLimit + ' seats)' : '';
            showToast(
              out.invited
                ? (out.resent ? 'Invite re-sent to ' : 'Invite created — ') + _nbdEscHtml(email) + (out.resent ? '' : ' will get an email with signup steps') + seatNote
                : _nbdEscHtml(email) + ' is already on your team',
              out.invited ? 'success' : 'error'
            );
          }
          loadTeamMembers();
        } catch (e) {
          console.error('Invite failed:', e);
          // Callable errors carry a human message (seat limit, bad role…).
          if (typeof showToast === 'function') showToast('Invite failed: ' + _nbdEscHtml(e.message || 'unknown error'), 'error');
        }
      }
      async function loadTeamMembers() {
        var list = document.getElementById('teamMembersList');
        if (!list || !window._user?.uid) return;
        // Resolve the tenant key: a member/admin's companyId claim points at the
        // OWNER's uid (the company doc key); only a solo owner keys by their own
        // uid. Reading companies/{_user.uid}/members was empty for any non-owner
        // member (their uid != companyId). Mirrors company-profile.js's resolver.
        var tenantKey = (window._userClaims && window._userClaims.companyId) || window._user.uid;
        var isOwnerViewer = tenantKey === window._user.uid;
        // Owner card: present the viewer AS owner only when they actually are one;
        // otherwise label generically so a member isn't mispresented as Owner.
        var nameEl = document.getElementById('teamOwnerName');
        var initEl = document.getElementById('teamOwnerInitials');
        if (nameEl) nameEl.textContent = isOwnerViewer ? (window._user.displayName || window._user.email || 'Owner') : 'Company Owner';
        if (initEl) {
          var name = isOwnerViewer ? (window._user.displayName || window._user.email || 'O') : 'Owner';
          initEl.textContent = name.split(' ').map(function(w){return w[0]}).join('').toUpperCase().substring(0,2);
        }
        try {
          var snap = await window.getDocs(window.collection(window.db, 'companies', tenantKey, 'members'));
          // An empty roster still needs the seat controls: a Starter/Team owner
          // buys their FIRST seat here (base cap 0 ⇒ no members ⇒ empty snap),
          // so the buy panel must render even with zero rows. Clear the list,
          // then fall through to _renderSeatBuy below (which self-hides when
          // the plan/entitlement doesn't qualify).
          if (snap.empty) {
            list.innerHTML = '';
            try { _renderSeatPanel([], list); } catch (_) { /* non-fatal */ }
            try { _renderSeatBuy(list); } catch (_) { /* non-fatal */ }
            return;
          }
          list.innerHTML = snap.docs.map(function(d) {
            var m = d.data();
            // roleColors lookups stay unescaped: unknown keys fall back to
            // a fixed CSS-var literal, so the output set is closed.
            var roleColors = { sales_rep:'var(--green)', manager:'var(--blue)', viewer:'var(--m)' };
            // Per-status management actions (Pillar 5 settings round). Invite
            // cancel = client delete (rules allow owner update/delete on
            // members; only CREATE is server-only). Disable/re-enable route
            // through the deactivateUser callable so the rep's Auth account
            // and sessions actually flip, not just the roster row.
            var status = m.status || 'invited';
            var email = String(m.email || d.id || '');
            // 30-day invite TTL (mirrors functions/handlers/invites.js
            // isInviteExpired): expired invites show as such — they've
            // already stopped consuming a seat server-side; Re-send
            // (cancel + re-invite) starts a fresh 30 days.
            var inviteExpired = false;
            if (status === 'invited' && m.invitedAt && typeof m.invitedAt.toMillis === 'function') {
              inviteExpired = (Date.now() - m.invitedAt.toMillis()) > 30 * 24 * 3600 * 1000;
            }
            var statusLabel = inviteExpired ? 'invite expired' : (m.status || 'invited');
            var btnBase = 'background:none;border:1px solid var(--br);color:var(--m);border-radius:6px;padding:4px 9px;font-size:10px;cursor:pointer;';
            var actions = '';
            if (status === 'invited') {
              actions = '<button style="' + btnBase + '" data-team-action="cancel" data-email="' + _nbdEscHtml(email) + '">Cancel invite</button>';
            } else if (status === 'active') {
              actions = '<button style="' + btnBase + '" data-team-action="disable" data-email="' + _nbdEscHtml(email) + '">Disable</button>';
            } else {
              actions = '<button style="' + btnBase + '" data-team-action="enable" data-email="' + _nbdEscHtml(email) + '">Re-enable</button>'
                + '<button style="' + btnBase + 'margin-left:6px;color:var(--red,#e05252);border-color:var(--red,#e05252);" data-team-action="remove" data-email="' + _nbdEscHtml(email) + '">Remove</button>';
            }
            return '<div style="padding:12px;background:var(--s2);border:1px solid var(--br);border-radius:7px;margin-bottom:6px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">'
              + '<div style="width:36px;height:36px;border-radius:18px;background:var(--s3);color:var(--m);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;">' + _nbdEscHtml((m.email||'?')[0].toUpperCase()) + '</div>'
              + '<div class="f1"><div style="font-size:13px;font-weight:600;color:var(--t);">' + _nbdEscHtml(m.email||'') + '</div>'
              + '<div class="meta-10">' + _nbdEscHtml((m.role||'rep').replace(/_/g,' ')) + ' · ' + _nbdEscHtml(statusLabel) + '</div></div>'
              + '<span style="font-size:9px;font-weight:700;padding:3px 8px;border-radius:10px;border:1px solid ' + (roleColors[m.role]||'var(--br)') + ';color:' + (roleColors[m.role]||'var(--m)') + ';text-transform:uppercase;letter-spacing:.06em;">' + _nbdEscHtml((m.role||'rep').replace(/_/g,' ')) + '</span>'
              + '<div>' + actions + '</div>'
              + '</div>';
          }).join('');
          // Over-capacity seat picker (cap-aware batch (de)activation).
          try {
            _renderSeatPanel(snap.docs.map(function(d){ var x = d.data()||{}; return { email:String(x.email||d.id||''), role:x.role, status:x.status, uid:x.uid }; }), list);
          } catch (_) { /* non-fatal */ }
          // Per-seat add-on purchase (Route 1b; dark until the seat price exists).
          try { _renderSeatBuy(list); } catch (_) { /* non-fatal */ }
        } catch(e) { console.warn('loadTeamMembers:', e.message); }
      }

      // ── Over-capacity SEAT PICKER ────────────────────────────────────
      // Server truth is assignSeats (cap-enforced). This panel lets the
      // owner/admin choose WHICH reps hold the plan's limited seats when the
      // team is over capacity (or has benched reps), instead of the lapse
      // cron's automatic oldest-first restore. Only claimed members (active/
      // deactivated, have a uid) hold seats; pending invites + the owner never
      // appear here.
      //
      // Returns null when the cap is UNKNOWN. getPlan() defaults to 'free'
      // (reps 1 ⇒ cap 0) until loadSubscription() succeeds, and a failed
      // reload keeps the last plan but zeroes purchasedSeats — reading either
      // as truth told the owner "You have N reps but your plan includes 0
      // seats" and pushed them to bench reps, whose Auth accounts assignSeats
      // then disables and whose tokens it revokes. Every caller treats null
      // as "don't render / don't submit" (fail-closed sibling:
      // dashboard-billing-tab.js renderBillingTab's `!info.loaded` branch).
      // Owner/founder sessions are unaffected: billing-gate.js sets
      // loaded=true on the owner path before any I/O.
      function _seatCap() {
        try {
          var pl = window.NBDBilling && window.NBDBilling.getPlan && window.NBDBilling.getPlan();
          if (!pl || pl.loaded !== true) return null;
          var reps = pl && pl.limits ? pl.limits.reps : 1;
          if (reps === Infinity || reps == null) return Infinity;
          var base = reps <= 1 ? 0 : reps; // mirrors server seatLimitForPlan
          // Per-seat add-ons (Route 1): purchased extra seats widen the cap,
          // matching the server's base + purchasedSeats at every cap site.
          var extra = pl && pl.purchasedSeats > 0 ? pl.purchasedSeats : 0;
          return base + extra;
        } catch (_) { return null; } // unknown, NOT unlimited: Infinity skipped _applySeats' cap check
      }
      function _renderSeatPanel(members, listEl) {
        var host = document.getElementById('teamSeatPanel');
        if (!host) {
          host = document.createElement('div');
          host.id = 'teamSeatPanel';
          if (listEl && listEl.parentNode) listEl.parentNode.insertBefore(host, listEl.nextSibling);
          host.addEventListener('change', function (e) {
            if (e.target && e.target.closest && e.target.closest('input[data-seat-email]')) _updateSeatCount(host);
          });
          host.addEventListener('click', function (e) {
            var b = e.target && e.target.closest && e.target.closest('[data-team-action="applySeats"]');
            if (b) _applySeats(host, b);
          });
        }
        var cap = _seatCap();
        // Plan unknown ⇒ no picker. (Must be explicit: `claimed.length > null`
        // coerces null to 0 and would render the over-capacity copy.)
        if (cap === null) { host.innerHTML = ''; host.style.display = 'none'; return; }
        var claimed = members.filter(function (m) { return m.uid && (m.status === 'active' || m.status === 'deactivated'); });
        var activeCount = claimed.filter(function (m) { return m.status === 'active'; }).length;
        var benched = claimed.length - activeCount;
        var relevant = cap !== Infinity && claimed.length > 0 && (claimed.length > cap || benched > 0);
        if (!relevant) { host.innerHTML = ''; host.style.display = 'none'; return; }
        host.style.display = '';
        var over = claimed.length > cap;
        var capLbl = cap;
        var rows = claimed.map(function (m) {
          var em = _nbdEscHtml(m.email);
          var chk = m.status === 'active' ? ' checked' : '';
          return '<label style="display:flex;align-items:center;gap:8px;padding:6px 9px;background:var(--s2);border:1px solid var(--br);border-radius:6px;margin-bottom:4px;font-size:12px;cursor:pointer;">'
            + '<input type="checkbox" data-seat-email="' + em + '"' + chk + ' style="width:15px;height:15px;">'
            + '<span style="color:var(--t);">' + em + '</span>'
            + '<span class="meta-10" style="margin-left:auto;text-transform:uppercase;letter-spacing:.05em;">' + _nbdEscHtml((m.role || 'rep').replace(/_/g, ' ')) + '</span></label>';
        }).join('');
        host.innerHTML = '<div style="margin-top:14px;padding:14px;background:var(--s);border:1px solid ' + (over ? 'var(--orange,#BD5728)' : 'var(--br)') + ';border-radius:8px;">'
          + '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--t);margin-bottom:4px;">Seat assignment</div>'
          + '<div class="meta-10" style="margin-bottom:10px;line-height:1.5;">' + (over
              ? 'You have ' + claimed.length + ' reps but your plan includes ' + capLbl + ' seat' + (cap === 1 ? '' : 's') + '. Choose who stays active — the rest are benched (their leads &amp; data are kept, and you can bring them back anytime).'
              : 'Choose which reps hold your ' + capLbl + ' seat' + (cap === 1 ? '' : 's') + '. Benched reps keep their data and can be brought back anytime.')
          + '</div>' + rows
          + '<div style="display:flex;align-items:center;gap:10px;margin-top:8px;">'
          + '<span id="teamSeatCount" class="meta-10">' + activeCount + ' of ' + capLbl + ' selected</span>'
          + '<button data-team-action="applySeats" style="margin-left:auto;background:var(--orange,#BD5728);border:none;color:#fff;padding:7px 16px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">Apply seat selection</button>'
          + '</div></div>';
        _updateSeatCount(host);
      }
      function _updateSeatCount(host) {
        var cap = _seatCap();
        var unknown = cap === null; // plan unloaded since the panel rendered
        var checked = host.querySelectorAll('input[data-seat-email]:checked').length;
        var over = !unknown && cap !== Infinity && checked > cap;
        var el = host.querySelector('#teamSeatCount');
        if (el) { el.textContent = checked + ' of ' + (unknown ? '?' : (cap === Infinity ? '∞' : cap)) + ' selected'; el.style.color = over ? 'var(--red,#e05252)' : ''; }
        var apply = host.querySelector('[data-team-action="applySeats"]');
        if (apply) apply.disabled = over || unknown;
      }
      async function _applySeats(host, btn) {
        var cap = _seatCap();
        var checked = Array.prototype.map.call(host.querySelectorAll('input[data-seat-email]:checked'),
          function (c) { return c.getAttribute('data-seat-email'); });
        // Never submit against an unknown cap: every unchecked rep is benched
        // (Auth disabled + tokens revoked) server-side.
        if (cap === null) {
          if (typeof showToast === 'function') showToast('Your plan is still loading — reopen the Team tab in a moment.', 'error');
          return;
        }
        if (cap !== Infinity && checked.length > cap) {
          if (typeof showToast === 'function') showToast('Select at most ' + cap + ' rep' + (cap === 1 ? '' : 's') + '.', 'error');
          return;
        }
        // Batch 2 (iOS PWA): native confirm() always returns true in PWA
        // standalone mode (see standalone-compat.js), so every destructive
        // guard in this tab — benching reps, buying/removing paid seats,
        // cancelling invites, revoking access — silently answered YES on the
        // installed app. nbdConfirm returns a real Promise<boolean> from a
        // modal in PWA mode and falls back to native confirm on desktop.
        var ask = window.nbdConfirm || function (m) { return Promise.resolve(window.confirm(m)); };
        if (!(await ask('Apply this seat selection? ' + checked.length + ' rep' + (checked.length === 1 ? '' : 's') + ' active; the rest are benched (data kept).'))) return;
        if (btn) { btn.disabled = true; btn.textContent = '…'; }
        try {
          var res = await _teamCallable('assignSeats', { activeEmails: checked });
          var d = (res && res.data) || {};
          if (typeof showToast === 'function') showToast('✓ Seats updated (' + (d.seatsUsed != null ? d.seatsUsed : checked.length) + '/' + (d.seatsLimit == null ? '∞' : d.seatsLimit) + ')', 'success');
        } catch (e) {
          if (typeof showToast === 'function') showToast('Failed: ' + _nbdEscHtml(e.message || 'unknown error'), 'error');
        }
        loadTeamMembers();
      }

      // ── Per-seat add-on purchase (Route 1b) ──────────────────────────
      // Owner buys extra rep seats beyond the plan cap; the server callable
      // setCompanySeatCount updates the Stripe subscription line item
      // (cap-enforced, entitled-only, dark-gated until the seat price
      // exists — its failed-precondition message surfaces in the toast).
      // Visible only for an entitled, card-billed, finite-cap plan.
      function _renderSeatBuy(listEl) {
        var host = document.getElementById('teamSeatBuy');
        if (!host) {
          host = document.createElement('div');
          host.id = 'teamSeatBuy';
          var panel = document.getElementById('teamSeatPanel');
          var anchor = panel || listEl;
          if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor.nextSibling);
          host.addEventListener('click', function (e) {
            var t = e.target && e.target.closest && e.target.closest('[data-team-action]');
            if (!t) return;
            var act = t.getAttribute('data-team-action');
            if (act === 'seatBuyMinus' || act === 'seatBuyPlus') {
              if (t.disabled) return;
              var el = host.querySelector('#seatBuyCount');
              var v = Math.max(0, Math.min(50, (parseInt(el && el.textContent, 10) || 0) + (act === 'seatBuyPlus' ? 1 : -1)));
              if (el) el.textContent = String(v);
              _syncSeatBuy(host);
            } else if (act === 'seatBuyApply') {
              _applySeatBuy(host, t);
            }
          });
        }
        var pl = (window.NBDBilling && window.NBDBilling.getPlan) ? window.NBDBilling.getPlan() : null;
        var reps = pl && pl.limits ? pl.limits.reps : null;
        // past_due is entitled to RENDER the stepper — the server allows a
        // past_due sub to REDUCE seats (undo a failed proration invoice) even
        // though it refuses new charges. Excluding past_due here made the
        // reduction path setCompanySeatCount was explicitly built for
        // unreachable: the only UI for it simply never appeared.
        var isPastDue = !!pl && pl.status === 'past_due';
        var entitled = !!pl && (pl.status === 'active' || pl.status === 'trialing' || isPastDue);
        // Only card-billed Stripe subs can carry a seat line item. An
        // access-code comp shows 'active' + a paid plan but would get a
        // failed-precondition from setCompanySeatCount, so don't offer the
        // stepper at all. source 'checkout' is the card-billed sub.
        // Founder accounts pass this predicate too (2026-07-29): billing-
        // gate's owner path mirrors a real checkout sub into getPlan()
        // (plan/status/source/purchasedSeats), so a card-billed founder
        // sees the stepper with the real plan's finite caps; a founder
        // WITHOUT a checkout sub stays enterprise (reps === Infinity) and
        // is excluded below. Gating is unaffected — owners bypass in
        // canUse/enforceGate/softGate regardless of the mirrored plan.
        var cardBilled = !!pl && pl.source === 'checkout';
        // The seat add-on is DARK (Jo's standing decision): setCompanySeatCount
        // refuses with failed-precondition until STRIPE_PRICE_SEAT exists. The
        // stepper used to render anyway, so every card-billed owner was offered
        // a control that could only fail with an error toast (GROK-CRM-AUDIT
        // row 14). It stays hidden until activation: create the seat price in
        // Stripe, add the STRIPE_PRICE_SEAT secret, deploy functions, THEN set
        // window.NBD_SEAT_ADDON_ENABLED = true (NEXT_SESSION-2026-09-14.md).
        var seatAddonLive = window.NBD_SEAT_ADDON_ENABLED === true;
        // !pl.loaded: an unloaded plan has no trustworthy caps (and _seatCap()
        // is null then, so the "included N" copy below would print 0).
        if (!seatAddonLive || !entitled || !cardBilled || !pl || !pl.loaded || pl.plan === 'free' || reps === Infinity || reps == null) {
          host.innerHTML = ''; host.style.display = 'none'; return;
        }
        host.style.display = '';
        var purchased = pl.purchasedSeats > 0 ? pl.purchasedSeats : 0;
        var stepBtn = 'background:var(--s2);border:1px solid var(--br);color:var(--t);border-radius:6px;width:26px;height:26px;font-size:14px;font-weight:700;cursor:pointer;';
        var stepBtnDisabled = 'background:var(--s2);border:1px solid var(--br);color:var(--t);border-radius:6px;width:26px;height:26px;font-size:14px;font-weight:700;opacity:.4;cursor:not-allowed;';
        // past_due may only go down from here — mirrors the server's
        // pastDueReduction gate (extraSeats < storedSeats). Disable "+"
        // rather than hide the whole control, so the reduction path stays
        // reachable and the reason is visible instead of a silent vanish.
        var plusAttrs = isPastDue ? ('disabled style="' + stepBtnDisabled + '" title="Fix your billing issue in Manage billing to add seats"') : ('style="' + stepBtn + '"');
        var note = isPastDue
          ? 'Your subscription has a billing issue — you can still remove extra seats to lower your bill. Fix billing in Manage billing to add more.'
          : ('Add rep seats beyond your plan’s included ' + (_seatCap() - purchased) + '. Billed monthly to your card, prorated.');
        host.innerHTML = '<div style="margin-top:10px;padding:12px 14px;background:var(--s);border:1px solid var(--br);border-radius:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">'
          + '<div class="f1" style="min-width:180px;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--t);">Extra seats</div>'
          + '<div class="meta-10" style="line-height:1.5;">' + note + '</div></div>'
          + '<button data-team-action="seatBuyMinus" style="' + stepBtn + '">−</button>'
          + '<span id="seatBuyCount" style="min-width:22px;text-align:center;font-size:14px;font-weight:700;color:var(--t);">' + purchased + '</span>'
          + '<button data-team-action="seatBuyPlus" ' + plusAttrs + '>+</button>'
          + '<button data-team-action="seatBuyApply" disabled style="background:var(--orange,#BD5728);border:none;color:#fff;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;opacity:.5;">Update seats</button>'
          + '</div>';
        _syncSeatBuy(host);
      }
      function _syncSeatBuy(host) {
        var pl = (window.NBDBilling && window.NBDBilling.getPlan) ? window.NBDBilling.getPlan() : null;
        var purchased = pl && pl.purchasedSeats > 0 ? pl.purchasedSeats : 0;
        var el = host.querySelector('#seatBuyCount');
        var target = parseInt(el && el.textContent, 10) || 0;
        var apply = host.querySelector('[data-team-action="seatBuyApply"]');
        if (apply) {
          var changed = target !== purchased;
          apply.disabled = !changed;
          apply.style.opacity = changed ? '' : '.5';
        }
      }
      async function _applySeatBuy(host, btn) {
        var el = host.querySelector('#seatBuyCount');
        var target = parseInt(el && el.textContent, 10);
        if (!(target >= 0 && target <= 50)) return;
        var pl = window.NBDBilling && window.NBDBilling.getPlan ? window.NBDBilling.getPlan() : null;
        var purchased = pl && pl.purchasedSeats > 0 ? pl.purchasedSeats : 0;
        if (target === purchased) return;
        // During a trial the proration is $0 and seat billing begins when the
        // trial converts — so "charged now" would be a lie. Match the copy to
        // the real Stripe behavior (mirrors seats.js always_invoice semantics).
        var isTrialing = !!pl && pl.status === 'trialing';
        var addN = target - purchased;
        var msg = target > purchased
          ? (isTrialing
              ? 'Add ' + addN + ' extra seat' + (addN === 1 ? '' : 's') + '? While your trial is active there’s no charge; seats are billed with your plan when the trial ends.'
              : 'Add ' + addN + ' extra seat' + (addN === 1 ? '' : 's') + '? Your card is charged the prorated amount now, then monthly with your plan.')
          : (target === 0
            ? 'Remove all purchased extra seats? A prorated credit is applied to your next invoice.'
            : 'Reduce purchased seats to ' + target + '? A prorated credit is applied to your next invoice.');
        var ask = window.nbdConfirm || function (m) { return Promise.resolve(window.confirm(m)); };
        if (!(await ask(msg))) return;
        if (btn) { btn.disabled = true; btn.textContent = '…'; }
        try {
          var res = await _teamCallable('setCompanySeatCount', { extraSeats: target });
          var d = (res && res.data) || {};
          if (typeof showToast === 'function') showToast('✓ Seats updated — ' + (d.purchasedSeats != null ? d.purchasedSeats : target) + ' extra, ' + (d.effectiveCap != null ? d.effectiveCap : '?') + ' total', 'success');
          // Refresh the billing mirror so _seatCap()/panels pick up the new count.
          if (window.NBDBilling && window.NBDBilling.loadSubscription) { try { await window.NBDBilling.loadSubscription(); } catch (_) {} }
        } catch (e) {
          if (typeof showToast === 'function') showToast(_nbdEscHtml(e.message || 'Seat update failed'), 'error');
        }
        if (btn) { btn.textContent = 'Update seats'; }
        loadTeamMembers();
      }

      // ── Member row actions (delegated; no inline handlers under strict CSP) ──
      async function _teamCallable(name, payload) {
        if (!(window._functions && window._httpsCallable)) {
          var mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
          window._functions = window._functions || mod.getFunctions();
          window._httpsCallable = window._httpsCallable || mod.httpsCallable;
        }
        return window._httpsCallable(window._functions, name)(payload);
      }
      async function handleTeamAction(action, email, btn) {
        // Resolve tenant key like loadTeamMembers (member/admin claim → owner uid).
        // The server callables re-derive the tenant from claims, so this is a
        // presence guard; resolving it correctly keeps non-owner admins working.
        var companyId = (window._userClaims && window._userClaims.companyId) || (window._user && window._user.uid);
        if (!companyId || !email) return;
        var confirms = {
          cancel:  'Cancel the invite for ' + email + '?',
          disable: 'Disable ' + email + '? Their login stops working until re-enabled. Their leads stay.',
          enable:  'Re-enable ' + email + '?',
          remove:  'Remove ' + email + ' from the team? Their access is revoked; their leads stay.'
        };
        var ask = window.nbdConfirm || function (m) { return Promise.resolve(window.confirm(m)); };
        if (!(await ask(confirms[action] || 'Proceed?'))) return;
        if (btn) { btn.disabled = true; btn.textContent = '…'; }
        try {
          if (action === 'cancel' || action === 'remove') {
            // removeMember (server) strips the member's companyId/role claims
            // and revokes their tokens before deleting the roster doc — a bare
            // client deleteDoc left a removed user with live tenant access
            // (Firestore authorizes by claim, not roster membership).
            await _teamCallable('removeMember', { email: email });
          } else {
            await _teamCallable('deactivateUser', { email: email, reactivate: action === 'enable' });
          }
          if (typeof showToast === 'function') showToast('✓ Done', 'success');
        } catch (e) {
          console.warn('team action failed:', e);
          if (typeof showToast === 'function') showToast('Failed: ' + _nbdEscHtml(e.message || 'unknown error'), 'error');
        }
        loadTeamMembers();
      }
      (function _wireTeamActions() {
        var list = document.getElementById('teamMembersList');
        if (!list || list._nbdTeamActionsWired) return;
        list._nbdTeamActionsWired = true;
        list.addEventListener('click', function (e) {
          var btn = e.target && e.target.closest && e.target.closest('[data-team-action]');
          if (!btn) return;
          handleTeamAction(btn.getAttribute('data-team-action'), btn.getAttribute('data-email') || '', btn);
        });
      })();
      // Load team when tab opens. This script ships INSIDE the lazily-
      // hydrated tpl-view-settings template, so it is re-executed by
      // _hydrateViewTemplate() on the first goTo('settings') — AFTER
      // DOMContentLoaded has already fired. A bare DOMContentLoaded
      // listener therefore never fires, the wrapper never installs, and
      // the owner card stays stuck on its 'JD'/'Loading...' placeholder.
      // Use a readyState guard (same idiom as dashboard-accessory-panel-init.js).
      //
      // Opening Team refreshes the billing plan FIRST (same as the Billing
      // tab's hook), so a boot-time loadSubscription() failure doesn't leave
      // the seat picker hidden (plan unknown ⇒ _seatCap() null) for the
      // whole session. A plan read that never settles can't strand the
      // roster: the fallback timer renders it anyway (picker stays hidden
      // until the plan does load, which re-renders).
      function _loadTeamAfterPlanRefresh() {
        var B = window.NBDBilling;
        if (!B || typeof B.loadSubscription !== 'function') { loadTeamMembers(); return; }
        var fallback = setTimeout(loadTeamMembers, 8000);
        var after = function () { clearTimeout(fallback); loadTeamMembers(); };
        var p;
        try { p = B.loadSubscription(); } catch (_) { after(); return; }
        Promise.resolve(p).then(after, after);
      }
      function _installTeamTabHook() {
        var _prev = window.switchSettingsTab;
        if (typeof _prev !== 'function') return;
        window.switchSettingsTab = function(tab) {
          _prev(tab);
          if (tab === 'team') _loadTeamAfterPlanRefresh();
        };
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _installTeamTabHook);
      } else {
        _installTeamTabHook();
      }

      // ── Manual invite-claim recovery ("Check my invite now") ──
      // Self-serve escape hatch for the invite-flag scenarios (rep signed up
      // before the invite, pre-existing account, shared device): calls
      // claimInvite directly, bypassing the boot-time flag gate entirely.
      // Document-level delegate because the button lives OUTSIDE
      // #teamMembersList; guarded against template re-hydration double-wiring.
      async function checkMyInvite(btn) {
        var out = document.getElementById('inviteCheckResult');
        var say = function (msg, color) {
          if (out) { out.textContent = msg; out.style.color = color || 'var(--m)'; }
        };
        if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
        try {
          var res = await _teamCallable('claimInvite', {});
          var data = (res && res.data) || {};
          // An owner of their own company must choose to join (invite-join.js).
          // Asked even if they declined at boot: pressing this button is asking.
          if (data.reason === 'confirm_required' && window.NBDInviteJoin) {
            say('Invite found from ' + (data.companyName || 'a team') + '.', 'var(--orange)');
            var outcome = await window.NBDInviteJoin.handle(data, function (p) { return _teamCallable('claimInvite', p); }, { fromBoot: false });
            if (outcome !== 'joined') { say('Not joined. You can check again any time.', 'var(--m)'); return; }
            data = { claimed: true };
          }
          if (data.claimed) {
            say('Invite found! Joining your team — reloading…', 'var(--orange)');
            if (window._user) await window._user.getIdToken(true);
            try {
              localStorage.setItem('nbd_invite_checked_' + (window._user && window._user.uid), '1');
            } catch (_) {}
            window.location.reload();
            return;
          }
          if (data.reason === 'already_member') {
            say('You are already on a team.', 'var(--m)');
          } else {
            say('No pending invite found for your email address. Ask your team owner to send one to the exact email you sign in with.', 'var(--m)');
          }
        } catch (e) {
          // failed-precondition = invite exists but email not verified yet.
          var msg = String((e && e.message) || 'unknown error');
          if (/verify your email/i.test(msg)) {
            say('An invite is waiting — verify your email address first, then try again.', 'var(--orange)');
          } else {
            say('Check failed: ' + msg, 'var(--red)');
          }
        } finally {
          if (btn) { btn.disabled = false; btn.textContent = 'Check my invite now'; }
        }
      }
      if (!window._NBD_INVITE_CHECK_DELEGATE) {
        window._NBD_INVITE_CHECK_DELEGATE = true;
        document.addEventListener('click', function (e) {
          var btn = e.target && e.target.closest && e.target.closest('[data-team-action="checkMyInvite"]');
          if (btn) checkMyInvite(btn);
        });
      }
