/**
 * contact-labels.js — the per-number label registry (data) and the Label
 * sheet (UI), lazy bundle 'contactlabels' (2026-10-12).
 *
 *   NBDContactLabels.load(force)   → { digits10: label }  (memoised 60 s)
 *   NBDContactLabels.current()     → the same object, no read
 *   NBDContactLabels.get(digits)   → label | null
 *   NBDContactLabels.apply(o)      → optimistic write, honest rollback
 *   NBDContactLabels.clear(digits) → remove a label (same rollback)
 *   NBDContactLabels.openSheet(o)  → the compact kind + policy sheet
 *
 * Storage: companies/{tenant}/contact_labels/{digits10}; tenant = the
 * claims.companyId a member carries, else a solo owner's own uid (the key
 * companies/{cid}/subs uses). firestore.rules: owner / company_admin /
 * manager write, viewer reads, a sales_rep neither reads nor writes.
 *
 * Failure rules: a failed read leaves NO labels (every call surfaces under
 * the old rule — fail open toward showing Jo the call); a failed write rolls
 * the label back, fires nbd:labels-changed so the row returns, and says so.
 * Nothing here sends anything. Strict CSP: classes, delegated listeners.
 * Pure rules: contact-labels-logic.js. Design:
 * documentation/projects/CONTACT-ROUTING-TREE-2026-10-12.md.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDContactLabels) return;
  var w = window, doc = document;
  var LG = w.NBDContactLabelsLogic;
  if (!LG) return;

  var TTL = 60 * 1000;
  var state = { labels: {}, loaded: false, at: 0, busy: null, undo: null, undoTimer: 0, sheet: null, opener: null };

  function claims() { return w._userClaims || {}; }
  function uid() { return (w._user && w._user.uid) || null; }
  function role() { return claims().role || ''; }
  function tenant() { return claims().companyId || uid() || null; }
  function canRead() { return !!(uid() && role() !== 'sales_rep'); }
  function canWrite() { return !!(uid() && role() !== 'viewer' && role() !== 'sales_rep'); }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtPhone(d) { return d && d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : (d || ''); }
  function changed() { try { w.dispatchEvent(new CustomEvent('nbd:labels-changed')); } catch (_) { /* old browser */ } }
  function colRef() { return w.collection(w.db, 'companies', tenant(), 'contact_labels'); }

  // One object for the page's lifetime: home-attention.js holds the
  // reference, so refreshes mutate it in place.
  function replaceAll(next) {
    Object.keys(state.labels).forEach(function (k) { delete state.labels[k]; });
    Object.keys(next).forEach(function (k) { state.labels[k] = next[k]; });
  }

  async function load(force) {
    if (!canRead() || !w.db || !w.getDocs || !w.collection) return state.labels;
    if (!force && state.loaded && Date.now() - state.at < TTL) return state.labels;
    if (state.busy) return state.busy;
    state.busy = (async function () {
      try {
        var snap = await w.getDocs(colRef());
        replaceAll(LG.indexLabels(snap.docs.map(function (d) { return { id: d.id, data: d.data() }; })));
        state.loaded = true; state.at = Date.now();
      } catch (e) {
        // No labels is the safe answer: every call surfaces as it did before.
        console.warn('[labels] read failed', e && e.code);
        state.at = Date.now();
      } finally { state.busy = null; }
      changed();
      return state.labels;
    })();
    return state.busy;
  }

  function get(digits) { return LG.lookup(state.labels, digits); }

  function leadCountFor(d) {
    return (w._leads || []).filter(function (l) {
      return l && l.id && !l.deleted && [l.phoneDigits, l.phone, l.phone2, l.altPhone, l.mobilePhone, l.secondaryPhone].some(function (p) { return LG.digits10(p) === d; });
    }).length;
  }

  // "On customer ..." for the sheet: the one non-deleted lead that carries the
  // number ('' for none, or a proxy line on 3+ leads, which identifies nobody).
  function leadNameFor(d) {
    var hits = (w._leads || []).filter(function (l) {
      return l && l.id && !l.deleted && [l.phoneDigits, l.phone, l.phone2, l.altPhone, l.mobilePhone, l.secondaryPhone].some(function (p) { return LG.digits10(p) === d; });
    });
    if (!hits.length || hits.length >= 3) return '';
    return ((hits[0].firstName || '') + ' ' + (hits[0].lastName || '')).trim() || 'a customer';
  }

  /** Persist (or remove, when doc is null) with rollback to `prev` on failure. */
  async function persist(d, doc, prev) {
    if (doc) state.labels[d] = LG.indexLabels([{ id: d, data: doc }])[d]; else delete state.labels[d];
    changed();
    try {
      var ref = w.doc(w.db, 'companies', tenant(), 'contact_labels', d);
      if (doc) await w.setDoc(ref, doc); else await w.deleteDoc(ref);
      return true;
    } catch (e) {
      if (prev) state.labels[d] = prev; else delete state.labels[d];
      changed();
      console.warn('[labels] write failed', e && e.code);
      toast("Couldn't save that label — check your connection and tap it again", 'error');
      return false;
    }
  }

  /**
   * o: { digits, kind, policy?, name?, note?, source? }. Resolves { ok, prev }.
   * Optimistic: the row is hidden / chipped at once; a failed write puts it back.
   */
  async function apply(o) {
    o = o || {};
    if (!canWrite()) { toast("Your role can't label numbers.", 'info'); return { ok: false }; }
    var d = LG.digits10(o.digits);
    var chk = LG.checkTarget(d, o.kind, { leadCount: d ? leadCountFor(d) : 0 });
    if (!chk.ok) { toast(chk.reason, 'info'); return { ok: false }; }
    var prev = state.labels[d] ? Object.assign({}, state.labels[d]) : null;
    var doc = LG.buildDoc({
      digits: d, kind: o.kind, policy: o.policy, name: o.name != null ? o.name : (prev && prev.name), note: o.note != null ? o.note : (prev && prev.note),
      source: o.source, companyId: tenant(), uid: uid(), createdAtMs: prev && prev.createdAtMs,
      ackAtMs: o.ackAtMs != null ? o.ackAtMs : (prev && prev.ackAtMs),
      capture: o.capture,
    });
    if (!doc) { toast("Couldn't label that number.", 'error'); return { ok: false }; }
    var ok = await persist(d, doc, prev);
    return { ok: ok, prev: prev };
  }

  /** "Keep hidden": a hidden number came back; quiet it until it happens again. */
  async function ack(digits) {
    // One number or a list (a customer with two labeled numbers): one Undo.
    var list = (Array.isArray(digits) ? digits : [digits]).map(function (x) { return LG.digits10(x); }).filter(function (d) { return d && state.labels[d]; });
    if (!list.length) return { ok: false };
    var before = list.map(function (d) { return Object.assign({}, state.labels[d]); });
    var okAll = true;
    for (var i = 0; i < list.length; i++) {
      var cur = state.labels[list[i]];
      var r = await apply({ digits: list[i], kind: cur.kind, policy: cur.policy, ackAtMs: Date.now(), source: cur.source, capture: cur.capture });
      if (!r.ok) okAll = false;
    }
    if (okAll) {
      // Audit UX-low: "Keep hidden" had no toast and no Undo.
      showUndo('Kept hidden — it will tell you again only if it rings after this.', function () {
        return Promise.all(before.map(function (p) { return persistRestore(p.digits, p); }));
      });
    }
    return { ok: okAll, prev: before[0] };
  }

  /** apply + the undo bar (used by a one-tap suggestion Accept). */
  async function applyWithUndo(o) {
    var d = LG.digits10(o && o.digits);
    var before = d ? get(d) : null;
    before = before ? Object.assign({}, before) : null;
    var r = await apply(o);
    if (!r.ok) return r;
    var now = get(d);
    showUndo('Labeled ' + LG.KIND_LABEL[o.kind] + '. ' + LG.effectText(o.kind, LG.policyOf(now), now && now.capture), function () {
      return before ? persistRestore(d, before) : clear(d);
    });
    return r;
  }

  async function clear(digits) {
    if (!canWrite()) return { ok: false };
    if (Array.isArray(digits)) {
      // Several numbers of one customer: remove them all, one Undo.
      var list = digits.map(function (x) { return LG.digits10(x); }).filter(function (d) { return d && state.labels[d]; });
      if (!list.length) return { ok: false };
      var snap = list.map(function (d) { return Object.assign({}, state.labels[d]); });
      var all = true;
      for (var i = 0; i < list.length; i++) {
        var one = await persist(list[i], null, snap[i]);
        if (!one) all = false;
      }
      if (all) {
        var rec = snap.some(function (p) { return p.capture === 'off'; });
        showUndo('Label removed.' + (rec ? ' New calls and texts are recorded again; ones skipped earlier cannot be brought back.' : ' Its calls show on Today again.'), function () {
          return Promise.all(snap.map(function (p) { return persistRestore(p.digits, p); }));
        });
      }
      return { ok: all, prev: snap[0] };
    }
    var d = LG.digits10(digits);
    if (!d || !state.labels[d]) return { ok: false };
    var prev = Object.assign({}, state.labels[d]);
    var ok = await persist(d, null, prev);
    return { ok: ok, prev: prev };
  }

  // ── undo bar ─────────────────────────────────────────────────────────
  function undoBar() {
    var el = doc.getElementById('clUndo');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'clUndo'; el.className = 'cl-undo'; el.setAttribute('role', 'status'); el.hidden = true;
      doc.body.appendChild(el);
    }
    return el;
  }
  function hideUndo() {
    clearTimeout(state.undoTimer);
    state.undo = null;
    var el = doc.getElementById('clUndo');
    if (el) el.hidden = true;
  }
  function showUndo(text, undoFn) {
    var el = undoBar();
    state.undo = undoFn;
    el.innerHTML = '<span class="cl-undo-text">' + esc(text) + '</span><button type="button" class="cl-undo-btn" data-cl="undo">Undo</button>';
    el.hidden = false;
    clearTimeout(state.undoTimer);
    state.undoTimer = setTimeout(hideUndo, 9000);
  }

  // ── the sheet ────────────────────────────────────────────────────────
  function closeSheet() {
    if (state.sheet && state.sheet.parentNode) state.sheet.parentNode.removeChild(state.sheet);
    state.sheet = null;
    var back = state.opener; state.opener = null;
    if (back && back.focus) { try { back.focus(); } catch (_) { /* gone */ } }
  }
  function kindButton(k, current) {
    return '<button type="button" class="cl-kind' + (current === k ? ' is-on' : '') + '" data-cl="kind" data-kind="' + k + '" aria-pressed="' + (current === k) + '">' + esc(LG.KIND_LABEL[k]) + '</button>';
  }
  function paintSheet(s) {
    var cur = get(s.digits);
    var curKind = cur ? cur.kind : s.pending;
    var more = s.more || (curKind && LG.PRIMARY_KINDS.indexOf(curKind) === -1);
    var extra = LG.KINDS.filter(function (k) { return LG.PRIMARY_KINDS.indexOf(k) === -1; });
    var pol = s.policy || (cur ? LG.policyOf(cur) : '');
    var pols = LG.POLICIES.map(function (p) {
      return '<button type="button" class="cl-pol' + (pol === p ? ' is-on' : '') + '" data-cl="policy" data-policy="' + p + '" aria-pressed="' + (pol === p) + '">' + esc(LG.POLICY_LABEL[p]) + '</button>';
    }).join('');
    s.el.innerHTML =
      '<div class="cl-hd"><div class="cl-title">Label this number</div>' +
      '<div class="cl-who">' + (s.name ? esc(s.name) + ' · ' : '') + esc(fmtPhone(s.digits)) + '</div></div>' +
      (s.leadName ? '<div class="cl-hint">On customer <b>' + esc(s.leadName) + '</b>. A label only changes what surfaces — the customer stays as it is.</div>' : '') +
      '<div class="cl-sec">What is it?</div>' +
      '<div class="cl-kinds">' + LG.PRIMARY_KINDS.map(function (k) { return kindButton(k, curKind); }).join('') +
      (more ? extra.map(function (k) { return kindButton(k, curKind); }).join('') : '<button type="button" class="cl-kind cl-more" data-cl="more">More…</button>') + '</div>' +
      '<div class="cl-sec">What should the CRM do with its calls?</div>' +
      '<div class="cl-pols">' + pols + '</div>' +
      // What the current choice does, in words (audit H5): kind + policy as they stand.
      (curKind && (pol || LG.defaultPolicy(curKind)) ? '<div class="cl-effect" role="status">' + esc(LG.effectText(curKind, pol || LG.defaultPolicy(curKind), cur && cur.capture)) + '</div>' : '') +
      '<div class="cl-note">' + (pol ? '' : 'Tapping what it is applies its usual choice at once (you can undo for 9 seconds): Sub, Supplier, Contractor and Job seeker start as “Only if I promised” — their missed and urgent calls stay off Today; Personal and Spam start as “Stop surfacing”. ') +
      'This only decides what shows on Today. It never blocks a call or sends anything.</div>' +
      // Thursday-handled toggle (js/thursday-handled.js; '' until that lazy file is loaded and the flag is on).
      (w.NBDThursdayHandled ? w.NBDThursdayHandled.sheetHtml(s.digits) : '') +
      '<div class="cl-foot">' + (cur ? '<button type="button" class="cl-link" data-cl="remove">Remove label</button>' : '<span></span>') +
      '<button type="button" class="cl-link" data-cl="close">Cancel</button></div>';
  }

  /** Open the sheet for one number: { digits, name?, leadName? }. */
  function openSheet(o) {
    o = o || {};
    var d = LG.digits10(o.digits);
    if (!d) { toast('This row has no phone number to label.', 'info'); return; }
    if (!canWrite()) { toast("Your role can't label numbers.", 'info'); return; }
    closeSheet();
    var cur = get(d);
    var wrap = doc.createElement('div');
    wrap.className = 'cl-overlay';
    wrap.innerHTML = '<div class="cl-back" data-cl="close"></div><div class="cl-sheet" role="dialog" aria-modal="true" aria-label="Label this number" tabindex="-1"></div>';
    doc.body.appendChild(wrap);
    state.opener = doc.activeElement || null;
    state.sheet = wrap;
    var s = { el: wrap.querySelector('.cl-sheet'), digits: d, name: o.name || (cur && cur.name) || '', leadName: o.leadName || leadNameFor(d), policy: '', more: false, pending: LG.isKind(o.pending) ? o.pending : '', source: LG.SOURCES.indexOf(o.source) !== -1 ? o.source : 'manual' };
    wrap.__s = s;
    paintSheet(s);
    var first = s.el.querySelector('.cl-kind.is-on') || s.el.querySelector('.cl-kind');
    if (first) first.focus(); else s.el.focus();
  }

  // Personal: ask before anything stops being recorded (2026-10-12, Jo). The
  // sheet repaints as a two-button confirm; nothing is written until a tap.
  function confirmPersonal(s) {
    s.el.innerHTML =
      '<div class="cl-hd"><div class="cl-title">Personal number</div>' +
      '<div class="cl-who">' + (s.name ? esc(s.name) + ' · ' : '') + esc(fmtPhone(s.digits)) + '</div></div>' +
      '<div class="cl-hint">Hiding keeps its calls off Today (a promise you make still shows). You can also stop the CRM from <b>copying and transcribing</b> its future calls and texts.</div>' +
      (s.leadName ? '<div class="cl-hint"><b>This number is on customer ' + esc(s.leadName) + '.</b> If you stop copying, you will not see their calls or texts. Pick Hide only unless you are sure.</div>' : '') +
      '<div class="cl-note">If you stop it: new calls and texts from this number are not copied, transcribed or read. A one-line record (time and direction) is still kept so the Call Center shows it rang. <b>Texts that arrive while it is off are dropped for good — they cannot be brought back into the CRM later</b> (calls stay as recordings in your own Drive). If this number later becomes a customer, the CRM records it again and tells you. <b>Calls and texts already in the CRM stay exactly as they are</b> — remove them from the Call Center yourself if you want them gone.</div>' +
      '<div class="cl-kinds"><button type="button" class="cl-pol' + (s.leadName ? ' is-on' : '') + '" data-cl="personal-hide">Hide only</button>' +
      '<button type="button" class="cl-pol' + (s.leadName ? '' : ' is-on') + '" data-cl="personal-stop">Hide + stop copying future calls</button></div>' +
      '<div class="cl-foot"><span></span><button type="button" class="cl-link" data-cl="close">Cancel</button></div>';
    var b = s.el.querySelector('[data-cl="' + (s.leadName ? 'personal-hide' : 'personal-stop') + '"]');
    if (b) b.focus();
  }

  async function chooseKind(s, kind, capture) {
    var before = get(s.digits);
    // Same kind again (a policy tap): keep what Jo already confirmed.
    if (capture === undefined && before && before.kind === kind) capture = before.capture || '';
    // A first pick of Personal asks about capture before writing anything.
    if (kind === 'personal' && capture === undefined && !(before && before.kind === 'personal')) { confirmPersonal(s); return; }
    var r = await apply({ digits: s.digits, kind: kind, policy: s.policy || undefined, name: s.name, source: s.source || 'manual', capture: capture });
    closeSheet();
    if (!r.ok) return;
    var now = get(s.digits);
    showUndo('Labeled ' + LG.KIND_LABEL[kind] + '. ' + LG.effectText(kind, LG.policyOf(now), now && now.capture), function () {
      return before ? persistRestore(s.digits, before) : clear(s.digits);
    });
  }
  async function persistRestore(d, prev) {
    // updatedAtMs is kept as it was: it is half of "when did Jo last decide"
    // (with ackAtMs), and an Undo must put the old decision back, not make a
    // fresh one that silences the reconciliation row.
    var doc = LG.buildDoc({ digits: d, kind: prev.kind, policy: prev.policy, name: prev.name, note: prev.note, source: prev.source, companyId: tenant(), uid: uid(), createdAtMs: prev.createdAtMs, ackAtMs: prev.ackAtMs, capture: prev.capture, nowMs: prev.updatedAtMs || undefined });
    if (!doc) return { ok: false };
    var cur = state.labels[d] ? Object.assign({}, state.labels[d]) : null;
    return { ok: await persist(d, doc, cur) };
  }

  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-cl]') : null;
    if (!t) return;
    var a = t.getAttribute('data-cl');
    var s = state.sheet && state.sheet.__s;
    if (a === 'undo') {
      var fn = state.undo; hideUndo();
      if (fn) Promise.resolve(fn()).catch(function () { /* persist already told the user */ });
      return;
    }
    if (a === 'close') { closeSheet(); return; }
    if (!s) return;
    if (a === 'more') { s.more = true; paintSheet(s); return; }
    if (a === 'personal-hide') { chooseKind(s, 'personal', ''); return; }
    if (a === 'personal-stop') { chooseKind(s, 'personal', 'off'); return; }
    if (a === 'kind') { chooseKind(s, t.getAttribute('data-kind')); return; }
    if (a === 'policy') {
      var p = t.getAttribute('data-policy');
      var cur = get(s.digits);
      if (cur) { s.policy = p; chooseKind(s, cur.kind); return; }
      // Opened from a suggestion that hides: the kind is picked, the policy is Jo's tap.
      if (s.pending) { s.policy = p; chooseKind(s, s.pending); return; }
      s.policy = s.policy === p ? '' : p; paintSheet(s);
      return;
    }
    if (a === 'remove') {
      var before = get(s.digits);
      closeSheet();
      clear(s.digits).then(function (r) {
        if (r && r.ok && before) showUndo('Label removed', function () { return persistRestore(s.digits, before); });
      });
    }
  });
  doc.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && state.sheet) { ev.stopPropagation(); closeSheet(); }
  });

  // The Today line "N people hidden by labels · See them in the Call Center"
  // opened the default tab (UX walk 2026-10-13). Its own handler still goes to
  // the Call Center; this one lands it on the Labeled list, where every hidden
  // person is, so the count is a tap to the people it counts. The view may
  // still be loading, so it is asked a few times, then given up quietly.
  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('.tp-hidden [data-tp-act="goto"]') : null;
    if (!t) return;
    var tries = 0;
    (function land() {
      var cc = w.NBDCallCenter;
      if (cc && typeof cc.setFilter === 'function' && cc._state && cc._state.loaded !== undefined) {
        try { cc.setFilter('labeled'); } catch (_) { /* the default tab is still a safe place to land */ }
        return;
      }
      if (++tries < 20) setTimeout(land, 200);
    })();
  });

  // Thursday label playbooks (2026-10-12): the "let Thursday handle this number"
  // toggle, the Today recap row and the block list live in two lazy files that
  // load only when the `thursdayLabelPlaybooks` flag is on. Registered here (not
  // in script-loader.js, whose blocking bytes are at their ceiling). Best-effort.
  // The flags read can land after this file (it needs the signed-in user), so a
  // flag that is not on yet is re-checked a few times; NBDFlags caches the read.
  try {
    var F = w.NBDFlags;
    if (F && typeof F.load === 'function' && w.ScriptLoader && typeof w.ScriptLoader.load === 'function') {
      var thTry = function (n) {
        Promise.resolve(F.load()).then(function () {
          if (F.enabled('thursdayLabelPlaybooks')) {
            return w.ScriptLoader.load('css/thursday-handled.css?v=1')
              .then(function () { return w.ScriptLoader.load('js/thursday-handled-logic.js?v=1'); })
              .then(function () { return w.ScriptLoader.load('js/thursday-handled.js?v=1'); });
          }
          if (n < 6) setTimeout(function () { thTry(n + 1); }, 2500);
          return null;
        }).catch(function () { /* optional surface */ });
      };
      thTry(0);
    }
  } catch (_) { /* optional surface */ }

  w.NBDContactLabels = {
    load: load, current: function () { return state.labels; }, get: get, apply: apply, applyWithUndo: applyWithUndo, ack: ack, clear: clear,
    openSheet: openSheet, canWrite: canWrite, canRead: canRead,
  };
})();
