/**
 * canvasser-ui.js — Canvasser mode (2026-10-16): the screens. Rules: canvasser-logic.js.
 *
 * FOR JOE (the company owner; managers can look): Settings → Team → Canvassers.
 * Mark a Sales Rep teammate as a commission-only canvasser with their % (on
 * money collected, never contract value), see each rep's doors knocked, leads,
 * appointments set, closed jobs, money collected and commission owed for this
 * month / 30 days / all time, the leaderboard, and who ticked today's pre-knock
 * checklist in which town. Tracking only: no payroll, no payouts.
 *
 * FOR THE REP: a Sales Rep already sees only their own leads and knocks
 * (firestore.rules). Marked as a canvasser, the app opens on Door-to-Door, the
 * menu shows only Door-to-Door and Pipeline (their own leads), and the knock
 * sheet waits for today's checklist for the town they are in (once per town
 * per day): permit on file, ID badge, the cancel notice at signing, the town's
 * knocking hours. A town that bans door-to-door cannot be started.
 *
 * Data: canvassers/{companyId}__{uid} (written by the owner only) and
 * canvass_checks/{id} (the rep's own ticked checklist, never edited). See
 * firestore.rules and tests/firestore-rules.canvassers.test.js.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDCanvasser) return;
  var W = window;
  var C = W.NBDCanvasserLogic;
  if (!C) return;

  var ALLOWED_VIEWS = { d2d: 1, crm: 1, settings: 1 };
  var S = { mode: false, rep: null, checks: [], gateOpen: false, range: 'month', panelAt: 0, busy: false };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(m, k) { if (typeof W.showToast === 'function') W.showToast(m, k || 'info'); }
  function db() { return W._db || W.db; }
  function uid() { return W._user && W._user.uid; }
  function claims() { return W._userClaims || {}; }
  function companyId() { return claims().companyId || uid(); }
  function ready() { return !!(db() && uid() && typeof W.getDocs === 'function' && typeof W.collection === 'function'); }
  function isOwnerish() {
    var c = claims();
    return c.role === 'admin' || c.role === 'company_admin' || (!c.role && companyId() === uid());
  }
  function isStaff() { return isOwnerish() || claims().role === 'manager'; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function docsOf(snap) { var o = []; if (snap && typeof snap.forEach === 'function') snap.forEach(function (d) { o.push(Object.assign({ id: d.id }, d.data())); }); return o; }
  function q(col) { var args = [W.collection(db(), col)].concat([].slice.call(arguments, 1)); return W.query.apply(null, args); }
  function read(p) { return Promise.resolve(p).then(docsOf, function () { return null; }); }

  // ── the rep ─────────────────────────────────────────────────────────────
  function todayKey() { return 'nbd_canvass_' + uid() + '_' + C.ymdOf(new Date()); }
  function startRepMode(rep) {
    S.mode = true; S.rep = rep;
    document.documentElement.classList.add('nbd-canvasser');
    if (typeof W.goTo === 'function' && !W.goTo.__canvasser) {
      var orig = W.goTo;
      var wrapped = function (name) {
        if (S.mode && name && !ALLOWED_VIEWS[name]) { toast('Canvasser mode: Door-to-Door and your own leads.', 'info'); return orig.call(this, 'd2d'); }
        return orig.apply(this, arguments);
      };
      wrapped.__canvasser = true;
      W.goTo = wrapped;
      try { orig('d2d'); } catch (e) { /* view not ready */ }
    }
    wrapKnock();
    paintTownPill();
  }
  function wrapKnock() {
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      var D = W.D2D;
      if (D && typeof D.openQuickKnock === 'function' && !D.openQuickKnock.__canvasser) {
        var orig = D.openQuickKnock;
        var gated = function (args) {
          if (!S.mode || lsGet(todayKey())) return orig.apply(this, arguments);
          openChecklist(function () { orig(args); });
          return undefined;
        };
        gated.__canvasser = true;
        D.openQuickKnock = gated;
      }
      if ((D && D.openQuickKnock && D.openQuickKnock.__canvasser && tries > 5) || tries > 600) clearInterval(t);
    }, 1000);
  }
  function paintTownPill() {
    var el = document.getElementById('canvassTownPill');
    var town = lsGet(todayKey());
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.id = 'canvassTownPill';
      el.className = 'cv-pill';
      el.addEventListener('click', function () { openChecklist(null); });
      document.body.appendChild(el);
    }
    var t = town && C.TOWNS.filter(function (x) { return x.id === town; })[0];
    el.textContent = town ? '✓ ' + (t ? t.name : 'Checklist done') + ' today' : '📋 Today\'s checklist';
    el.setAttribute('aria-label', town ? 'Pre-knock checklist done for today; tap to change town' : 'Pre-knock checklist: tap to start');
  }

  function checklistHtml(townId) {
    var c = C.checklistFor(townId);
    var opts = '<option value="">Pick the town you are knocking in…</option>' + C.TOWNS.map(function (t) {
      return '<option value="' + esc(t.id) + '"' + (t.id === townId ? ' selected' : '') + '>' + esc(t.name) + (t.permit === 'banned' ? ' (door-to-door banned)' : '') + '</option>';
    }).join('') + '<option value="other"' + (townId === 'other' ? ' selected' : '') + '>Another town</option>';
    var h = '<div class="cv-card" role="document"><h2 class="cv-title" id="cvTitle">Before you knock</h2>' +
      '<p class="cv-sub">Once per town, every day. Research, not legal advice: when in doubt, call the town.</p>' +
      '<label class="cv-lbl" for="cvTown">Town</label><select id="cvTown" class="cv-select">' + opts + '</select>';
    if (!townId) return h + '<div class="cv-actions"><button type="button" class="cv-btn cv-ghost" data-cv="cancel">Not now</button></div></div>';
    if (c.blocked) {
      return h + '<p class="cv-stop" role="alert">' + esc(c.why) + '</p><div class="cv-actions"><button type="button" class="cv-btn cv-ghost" data-cv="cancel">Back</button></div></div>';
    }
    if (c.town) h += '<p class="cv-note"><strong>' + esc(c.town.name) + ':</strong> ' + esc(c.town.note) + '</p>';
    h += '<ul class="cv-items">' + c.items.map(function (it) {
      return '<li><label class="cv-item"><input type="checkbox" data-cv-item="' + esc(it.id) + '"> <span>' + esc(it.label) + '</span></label></li>';
    }).join('') + '</ul>';
    return h + '<div class="cv-actions"><button type="button" class="cv-btn cv-ghost" data-cv="cancel">Not now</button>' +
      '<button type="button" class="cv-btn cv-go" data-cv="save" disabled>Start knocking</button></div></div>';
  }
  function openChecklist(then) {
    if (S.gateOpen) return;
    S.gateOpen = true;
    var wrap = document.createElement('div');
    wrap.className = 'cv-overlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'cvTitle');
    var townId = '';
    var paint = function () {
      wrap.innerHTML = checklistHtml(townId);
      var sel = wrap.querySelector('#cvTown');
      if (sel) sel.addEventListener('change', function () { townId = sel.value; paint(); });
      var boxes = wrap.querySelectorAll('[data-cv-item]');
      var go = wrap.querySelector('[data-cv="save"]');
      boxes.forEach(function (b) { b.addEventListener('change', function () { if (go) go.disabled = ![].every.call(boxes, function (x) { return x.checked; }); }); });
    };
    var close = function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); S.gateOpen = false; };
    wrap.addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('[data-cv]');
      if (!b) return;
      if (b.getAttribute('data-cv') === 'cancel') { close(); return; }
      if (b.getAttribute('data-cv') === 'save' && !b.disabled) {
        var ticked = {};
        wrap.querySelectorAll('[data-cv-item]').forEach(function (x) { ticked[x.getAttribute('data-cv-item')] = x.checked; });
        var d = C.checkDoc(townId, ticked, { uid: uid(), companyId: companyId() }, new Date());
        if (!d) { toast('Tick every line first.', 'error'); return; }
        d.createdAt = W.serverTimestamp ? W.serverTimestamp() : new Date();
        b.disabled = true;
        Promise.resolve(W.addDoc(W.collection(db(), 'canvass_checks'), d)).then(function () {
          lsSet(todayKey(), townId);
          paintTownPill();
          close();
          if (typeof then === 'function') then();
        }, function () { b.disabled = false; toast('The checklist could not be saved. Try again.', 'error'); });
      }
    });
    wrap.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') close(); });
    paint();
    document.body.appendChild(wrap);
    var first = wrap.querySelector('select, button');
    if (first) first.focus();
  }

  // ── Joe's panel ─────────────────────────────────────────────────────────
  function rangeOf(key) {
    var now = Date.now(), d = new Date();
    if (key === 'month') return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: now };
    if (key === '30') return { from: now - 30 * 86400000, to: now };
    return { from: 0, to: 0 };
  }
  function loadPanelData() {
    var cid = companyId();
    var eq = function (f, v) { return W.where(f, '==', v); };
    return Promise.all([
      read(W.getDocs(q('canvassers', eq('companyId', cid)))),
      read(W.getDocs(W.collection(db(), 'companies', cid, 'members'))),
      read(W.getDocs(q('knocks', eq('companyId', cid)))),
      read(W.getDocs(q('leads', eq('companyId', cid)))),
      read(W.getDocs(q('invoices', eq('companyId', cid)))),
      read(W.getDocs(q('canvass_checks', eq('companyId', cid), eq('ymd', C.ymdOf(new Date()))))),
      read(W.getDocs(q('d2d_doorlists', eq('userId', uid())))),
    ]).then(function (r) {
      return { canvassers: r[0] || [], members: r[1] || [], knocks: r[2], leads: r[3], invoices: r[4], checks: r[5] || [], lists: r[6] || [] };
    });
  }
  function panelHtml(d) {
    var range = rangeOf(S.range);
    var reps = d.canvassers.filter(function (c) { return c.active !== false; });
    var stats = C.leaderboard(reps.map(function (c) { return C.repStats({ uid: c.uid, pct: c.pct, name: c.name }, { knocks: d.knocks || [], leads: d.leads || [], invoices: d.invoices || [] }, range); }));
    var owner = isOwnerish();
    var h = '<div class="panel-hdr"><div><div class="panel-label">Commission-only</div><div class="panel-title">Canvassers</div></div></div><div class="panel-body cv-panel">' +
      '<p class="cv-sub">A canvasser is a Sales Rep teammate: they see only their own leads and doors. Commission is a % of money collected on their jobs, never contract value. Tracking only: no payroll, no payouts.</p>' +
      '<div class="cv-range" role="group" aria-label="Period">' + [['month', 'This month'], ['30', 'Last 30 days'], ['all', 'All time']].map(function (r) {
        return '<button type="button" class="cv-chip' + (S.range === r[0] ? ' is-on' : '') + '" data-cv-range="' + r[0] + '" aria-pressed="' + (S.range === r[0]) + '">' + r[1] + '</button>';
      }).join('') + '</div>';
    if (!d.knocks || !d.leads || !d.invoices) h += '<p class="cv-warn" role="status">Some numbers could not be read with your account\'s role. The company owner role sees every rep\'s numbers.</p>';
    if (!stats.length) h += '<div class="ui-empty cv-empty">No canvassers yet. Invite a Sales Rep above, then mark them as a canvasser here.</div>';
    else {
      h += '<div class="cv-table-wrap"><table class="cv-table"><thead><tr><th scope="col">#</th><th scope="col">Rep</th><th scope="col">Doors</th><th scope="col">Leads</th><th scope="col">Appts</th><th scope="col">Closed</th><th scope="col">Collected</th><th scope="col">%</th><th scope="col">Commission owed</th><th scope="col">Today</th></tr></thead><tbody>' +
        stats.map(function (s) {
          var chk = (d.checks || []).filter(function (c) { return c.userId === s.uid; });
          var today = chk.length ? '✓ ' + chk.map(function (c) { return c.town; }).join(', ') : 'No checklist';
          var pct = owner ? '<input class="cv-pct" type="number" inputmode="decimal" min="0" max="' + C.MAX_PCT + '" step="0.5" value="' + esc(s.pct) + '" aria-label="Commission % for ' + esc(s.name || 'rep') + '" data-cv-pct="' + esc(s.uid) + '">' : esc(s.pct + '%');
          // data-l: the column name, shown beside each value when the table stacks on a phone
          return '<tr><td data-l="#">' + s.rank + '</td><td data-l="Rep" class="cv-rep">' + esc(s.name || s.uid) + '</td><td data-l="Doors">' + s.doors + '</td><td data-l="Leads">' + s.leads + '</td><td data-l="Appts">' + s.appointments + '</td><td data-l="Closed">' + s.closed +
            '</td><td data-l="Collected">' + esc(C.fmtMoney(s.collectedCents)) + '</td><td data-l="%">' + pct + '</td><td data-l="Commission owed"><strong>' + esc(C.fmtMoney(s.commissionCents)) + '</strong></td><td data-l="Today" class="' + (chk.length ? 'cv-ok' : 'cv-miss') + '">' + esc(today) +
            '</td></tr>';
        }).join('') + '</tbody></table></div>';
      if (owner) h += '<div class="cv-row"><button type="button" class="btn btn-ghost cv-btn" data-cv="save-pcts">Save %</button>' +
        '<select class="ui-input cv-select" id="cvRemove" aria-label="Canvasser to remove"><option value="">Stop tracking a canvasser…</option>' +
        reps.map(function (c) { return '<option value="' + esc(c.uid) + '">' + esc(c.name || c.uid) + '</option>'; }).join('') + '</select>' +
        '<button type="button" class="btn btn-ghost cv-btn" data-cv="remove">Stop tracking</button></div>';
    }
    // Hand one of the owner's door lists (D2D → Routes → Import doors) to a canvasser.
    if (owner && reps.length && (d.lists || []).length) {
      h += '<div class="cv-add"><div class="cv-lbl">Give a door list to a canvasser</div><div class="cv-row">' +
        '<select class="ui-input cv-select" id="cvListId" aria-label="Door list">' + d.lists.map(function (l) {
          var to = reps.filter(function (c) { return c.uid === l.assignedTo; })[0];
          return '<option value="' + esc(l.id) + '">' + esc((l.name || 'Door list') + ' · ' + ((l.doors || []).length) + ' doors' + (to ? ' · with ' + (to.name || to.uid) : '')) + '</option>';
        }).join('') + '</select><select class="ui-input cv-select" id="cvListRep" aria-label="Canvasser"><option value="">Nobody (keep it mine)</option>' +
        reps.map(function (c) { return '<option value="' + esc(c.uid) + '">' + esc(c.name || c.uid) + '</option>'; }).join('') + '</select>' +
        '<button type="button" class="btn btn-ghost cv-btn" data-cv="assign">Give</button></div></div>';
    }
    if (owner) {
      var have = {};
      reps.forEach(function (c) { have[c.uid] = 1; });
      var pick = d.members.filter(function (m) { return m && m.uid && m.role === 'sales_rep' && m.status === 'active' && !have[m.uid]; });
      h += '<div class="cv-add"><div class="cv-lbl">Add a canvasser</div>' + (pick.length
        ? '<div class="cv-row"><select class="ui-input cv-select" id="cvAddUid" aria-label="Sales Rep to mark as a canvasser">' + pick.map(function (m) {
          return '<option value="' + esc(m.uid) + '" data-name="' + esc(m.name || m.displayName || m.email || '') + '">' + esc(m.name || m.displayName || m.email || m.uid) + '</option>';
        }).join('') + '</select><input class="ui-input cv-pct" id="cvAddPct" type="number" inputmode="decimal" min="0" max="' + C.MAX_PCT + '" step="0.5" value="10" aria-label="Commission %">' +
          '<button type="button" class="btn btn-orange cv-btn" data-cv="add">Add</button></div>'
        : '<p class="cv-sub">No active Sales Rep teammates to add. Invite one with the Sales Rep role first.</p>') + '</div>';
    }
    return h + '</div>';
  }
  function renderPanel(force) {
    var el = document.getElementById('canvasserPanel');
    if (!el || !ready() || !isStaff() || S.busy) return;
    var host = document.getElementById('stab-panel-team') || el.parentNode;
    if (!force && (!host || host.offsetParent === null)) return;   // the Team tab is not on screen
    if (!force && Date.now() - S.panelAt < 60000) return;
    S.busy = true; S.panelAt = Date.now();
    loadPanelData().then(function (d) { S.last = d; el.innerHTML = panelHtml(d); el.hidden = false; }).finally(function () { S.busy = false; });
  }
  function onPanelClick(ev) {
    var el = document.getElementById('canvasserPanel');
    if (!el || !el.contains(ev.target)) return;
    var r = ev.target.closest('[data-cv-range]');
    if (r) { S.range = r.getAttribute('data-cv-range'); if (S.last) el.innerHTML = panelHtml(S.last); return; }
    var b = ev.target.closest('[data-cv]');
    if (!b || !isOwnerish()) return;
    var cid = companyId();
    var ref = function (repUid) { return W.doc(db(), 'canvassers', cid + '__' + repUid); };
    var act = b.getAttribute('data-cv');
    if (act === 'add') {
      var sel = el.querySelector('#cvAddUid'), pct = el.querySelector('#cvAddPct');
      if (!sel || !sel.value) return;
      var name = (sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].getAttribute('data-name')) || '';
      Promise.resolve(W.setDoc(ref(sel.value), { companyId: cid, uid: sel.value, name: name.slice(0, 80), pct: C.clampPct(pct && pct.value), active: true, updatedBy: uid(), updatedAt: W.serverTimestamp() }))
        .then(function () { toast('Canvasser added.', 'success'); renderPanel(true); }, function () { toast('Only the company owner can add a canvasser.', 'error'); });
    } else if (act === 'save-pcts') {
      var ins = el.querySelectorAll('[data-cv-pct]');
      Promise.all([].map.call(ins, function (i) { return W.updateDoc(ref(i.getAttribute('data-cv-pct')), { pct: C.clampPct(i.value), updatedBy: uid(), updatedAt: W.serverTimestamp() }); }))
        .then(function () { toast('Commission % saved.', 'success'); renderPanel(true); }, function () { toast('The % could not be saved.', 'error'); });
    } else if (act === 'assign') {
      var ls = el.querySelector('#cvListId'), rp = el.querySelector('#cvListRep');
      if (!ls || !ls.value) return;
      Promise.resolve(W.updateDoc(W.doc(db(), 'd2d_doorlists', ls.value), { assignedTo: rp && rp.value ? rp.value : null }))
        .then(function () { toast(rp && rp.value ? 'Door list given to the canvasser. It shows in their Routes tab.' : 'Door list is yours only again.', 'success'); renderPanel(true); }, function () { toast('Could not change that door list.', 'error'); });
    } else if (act === 'remove') {
      var rm = el.querySelector('#cvRemove');
      if (!rm || !rm.value) return;
      Promise.resolve(W.updateDoc(ref(rm.value), { active: false, updatedBy: uid(), updatedAt: W.serverTimestamp() }))
        .then(function () { toast('No longer tracked as a canvasser. Their leads and knocks stay.', 'success'); renderPanel(true); }, function () { toast('Could not change that.', 'error'); });
    }
  }

  // ── boot ────────────────────────────────────────────────────────────────
  function boot() {
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if (!ready() || !W._userClaims) { if (tries > 120) clearInterval(t); return; }
      clearInterval(t);
      var c = claims();
      if (c.role === 'sales_rep' && c.companyId && typeof W.getDoc === 'function') {
        Promise.resolve(W.getDoc(W.doc(db(), 'canvassers', c.companyId + '__' + uid()))).then(function (s) {
          var d = s && typeof s.exists === 'function' && s.exists() ? s.data() : null;
          if (d && d.active !== false) startRepMode(d);
        }, function () { /* not a canvasser */ });
      }
      if (isStaff()) {
        document.addEventListener('click', onPanelClick);
        setInterval(function () { renderPanel(false); }, 2000);
      }
    }, 500);
  }
  boot();

  W.NBDCanvasser = { openChecklist: openChecklist, renderPanel: renderPanel, _panelHtml: panelHtml, _checklistHtml: checklistHtml, _state: S };
})();
