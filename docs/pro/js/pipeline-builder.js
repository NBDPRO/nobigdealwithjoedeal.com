/**
 * pipeline-builder.js — Settings → Pipelines editor (freeform pipelines, Phase 2).
 *
 * Lets an owner / company_admin edit their kanban pipelines: per job-type view,
 * reorder / rename / recolor stages, change a stage's semantic role, add custom
 * stages, and remove stages from a view. Writes the config to
 * companyProfile.pipelines (owner/admin-write per the Settings sweep) and calls
 * applyPipelineConfig() (via the registry) so the board updates immediately on save.
 *
 * Ships INSIDE the lazily-hydrated <template id="tpl-view-settings">, so it wires
 * itself via a switchSettingsTab hook (same idiom as dashboard-team-tab.js) and
 * renders on the first Settings → Pipelines open (after DCL). Strict-CSP-safe:
 * all interaction is delegated data-pb-action attributes, no inline handlers.
 *
 * Engine deps (from crm-stages.js via dashboard-bootstrap, read off
 * __NBD_CALL_REGISTRY as of Globals Tranche 3 T3-C, 2026-09-18):
 *   resolvePipelineConfig, STAGE_ROLE, applyPipelineConfig — plus the
 *   still-bare window._saveCompanyProfile, window._companyProfile,
 *   window.KANBAN_VIEWS.
 *
 * HYDRATION GATE (2026-09-18). companyProfile.pipelines is a TENANT-WIDE
 * board config, and window._companyProfile holds the bare NBD defaults (no
 * `pipelines` key at all) until _loadCompanyProfile's getDoc succeeds — which
 * it may never do this session (a failed read leaves _companyProfileLoaded
 * unset; there is no cache on a fresh device). The builder used to snapshot
 * _cfg from whatever was in memory when the tab opened, so opening it early
 * seeded {stages:{},views:{}}, and the first edit + Save setDoc-merged that
 * back: empty nested maps REPLACE on a merge write, so every custom stage
 * and every per-view order was wiped for every rep. Now:
 *   - openBuilder awaits _loadCompanyProfile() when the profile isn't
 *     loaded, then snapshots (await-then-require, the _tenantFilePrefix
 *     pattern in company-profile.js).
 *   - loadCfg records WHETHER its snapshot came from a loaded profile
 *     (_cfgHydrated). A save-time `_companyProfileLoaded === true` check
 *     alone is not enough: the profile can finish loading AFTER a pre-
 *     hydration snapshot, and the stale defaults would still be written
 *     (same trap as _countyInputsResolved in dashboard-bootstrap).
 *   - render() shows no editor for an unhydrated snapshot, and save()
 *     (which Reset also goes through) refuses unless BOTH the snapshot and
 *     the live profile are hydrated.
 */
(function () {
  'use strict';

  // ONE copy (2026-09-25, phone-audit follow-up). This file ships inside the
  // lazily-hydrated settings <template>, and _hydrateViewTemplate
  // (dashboard-ui.js) executes its scripts TWICE: once when the cloned
  // <script> is inserted, again when it swaps in a fresh one (measured: two
  // runs, one fetch, in Chromium and WebKit). Each run had its own _cfg /
  // _dirty. The _pbWrapped check only kept the second copy from wrapping
  // switchSettingsTab when nothing else had wrapped it in between — when a
  // Billing / Connect / Team wrapper landed first (the usual order in WebKit),
  // both copies drove one panel: the first wired the edit handlers, the second
  // re-rendered the saved config over the edits. window.PipelineBuilder is set
  // at the end of the first run, so the second stops here.
  // Update 2026-09-25 (phone nav polish): _hydrateViewTemplate now runs each
  // template script once, at the source. This guard stays as a second line:
  // it costs nothing, and a second copy of this file would corrupt edits.
  if (window.PipelineBuilder) return;

  var ROOT_ID = 'pipelineBuilderRoot';
  var _cfg = null;      // working config (raw overrides), cloned from companyProfile.pipelines
  // true ONLY when _cfg was cloned from a definitively-loaded profile
  // (window._companyProfileLoaded === true at snapshot time). Set in loadCfg.
  var _cfgHydrated = false;
  var _loading = false; // openBuilder is awaiting _loadCompanyProfile()
  var _openSeq = 0;     // latest openBuilder call wins (a stale load can't re-render over a newer open)
  var _dirty = false;
  var _wired = false;   // root-level delegate installed once
  var _drag = null;     // active drag payload { view, stage } during row reorder

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function toast(msg, kind) { if (typeof window.showToast === 'function') window.showToast(msg, kind || 'ok'); }

  // Owner (doc keyed by uid → no companyId claim, or companyId===uid) or
  // company_admin/admin may edit; everyone else sees it read-only (matches the
  // companyProfile firestore rule so a denied save never surprises them).
  // Claims not loaded yet (window._userClaims unset until getIdTokenResult
  // resolves) means UNKNOWN, not "solo owner": fail closed to read-only. A
  // real solo owner still passes once the claims object (no companyId) lands.
  // The companyProfile rule is the real backstop; this only keeps the UI honest.
  function canEdit() {
    var c = window._userClaims;
    if (!c || typeof c !== 'object') return false;
    var role = c.role || '';
    if (role === 'admin' || role === 'company_admin') return true;
    if (!c.companyId) return true; // solo owner (no companyId claim)
    return window._user && c.companyId === window._user.uid; // owner keyed by uid
  }

  function ROLES() {
    // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
    var _nbdReg = window.__NBD_CALL_REGISTRY;
    var R = (_nbdReg && _nbdReg.STAGE_ROLE) || { NEW: 'new', ACTIVE: 'active', JOB: 'job', WON: 'won', LOST: 'lost' };
    return [R.NEW, R.ACTIVE, R.JOB, R.WON, R.LOST];
  }
  var ROLE_LABEL = { new: 'New', active: 'Active', job: 'In Production', won: 'Won', lost: 'Lost' };

  function loadCfg() {
    // Record hydration AT SNAPSHOT TIME — see the header. Never re-derive it
    // later from the live flag: that would bless a defaults-seeded snapshot
    // the moment the profile finished loading underneath it.
    _cfgHydrated = window._companyProfileLoaded === true;
    var raw = (window._companyProfile && window._companyProfile.pipelines) || null;
    try { _cfg = raw ? JSON.parse(JSON.stringify(raw)) : { stages: {}, views: {} }; }
    catch (_) { _cfg = { stages: {}, views: {} }; }
    if (!_cfg.stages) _cfg.stages = {};
    if (!_cfg.views) _cfg.views = {};
  }

  // The single write gate (save() — and so Reset — goes through it). BOTH
  // halves are required: _cfgHydrated says the working copy was cloned from
  // real data, _companyProfileLoaded says the live profile _saveCompanyProfile
  // merges onto is real too. Same "never write a wipe from a stale page" rule
  // as _resetEstimateDefaultsV2 / the custom-jurisdictions replace.
  function writeReady() {
    return _cfgHydrated === true && window._companyProfileLoaded === true && !!_cfg;
  }
  var NOT_LOADED_MSG = 'Still loading your saved pipelines — reopen Settings → Pipelines and try again.';

  function resolved() {
    // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
    var _nbdReg = window.__NBD_CALL_REGISTRY;
    var fn = _nbdReg && _nbdReg.resolvePipelineConfig;
    if (typeof fn !== 'function') return null;
    try { return fn(_cfg); } catch (_) { return null; }
  }

  // Materialize a view's stage order into the working config so a reorder/remove
  // persists (until then the view inherits the default order).
  function ensureViewStages(vk, res) {
    if (!_cfg.views[vk] || !Array.isArray(_cfg.views[vk].stages)) {
      var base = (res.views[vk] && res.views[vk].stages) ? res.views[vk].stages.slice() : [];
      _cfg.views[vk] = Object.assign({}, _cfg.views[vk], { stages: base });
    }
    return _cfg.views[vk].stages;
  }

  function setStageField(key, field, val) {
    _cfg.stages[key] = Object.assign({}, _cfg.stages[key], (function () { var o = {}; o[field] = val; return o; })());
    _dirty = true;
  }

  // Leads currently sitting on a stage. A lead carries its raw stage key on
  // `lead.stage` (moveCard writes the custom key straight there) and its
  // board-bucket key on `lead._stageKey` (= normalizeStage(stage)); for a
  // custom stage both equal the config key, so matching either finds occupants
  // even if the denormalized field is missing. Reads the COMPLETE book in
  // window._leads (not the filtered view) so the count covers every lead.
  function leadsOnStage(key) {
    if (!key) return [];
    var leads = (typeof window !== 'undefined' && Array.isArray(window._leads)) ? window._leads : [];
    return leads.filter(function (l) { return l && (l.stage === key || l._stageKey === key); });
  }

  // Delete guard the handler enforces: a custom stage may only be deleted when
  // NO lead sits on it. Deleting an occupied stage would orphan its leads —
  // their stage renders in no column, so resolveColumn snaps them into the New
  // column and stageRole() returns 'active', silently losing any won/lost role
  // (and dropping them from role-keyed KPIs / revenue / the portal). Blocking
  // is the safe minimal fix: move the leads elsewhere on the board first.
  //
  // FAIL CLOSED on an unhydrated cache (2026-07-18 post-sprint certification):
  // window._leads defaults to [] before loadLeads() finishes (a slow/flaky
  // load can leave it empty for seconds), and leadsOnStage() has no way to
  // tell "confirmed zero" from "haven't loaded yet" — it would report 0
  // occupants for a stage that actually holds leads, letting a real deletion
  // through and reintroducing the exact orphaning this guard exists to
  // block. window._leadsLoaded is the same hydration flag dashboard-
  // bootstrap.module.js's other stale-cache guards already key off; refuse
  // rather than reconcile against unknown data, same "don't act on
  // ambiguous data" pattern as the seat-rotation guard in seats.js.
  function canDeleteStage(key) {
    if (typeof window !== 'undefined' && !window._leadsLoaded) {
      return { ok: false, count: null, unhydrated: true };
    }
    var count = leadsOnStage(key).length;
    return { ok: count === 0, count: count };
  }

  // ── render ──────────────────────────────────────────────
  function render() {
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    if (_loading) { root.innerHTML = '<div style="padding:16px;color:var(--m);">Loading your saved pipelines…</div>'; return; }
    // Unhydrated snapshot = the NBD defaults, not this tenant's pipelines.
    // Showing them as an editor invites exactly the save that wipes the real
    // config, and even read-only they'd look like "my custom stages are gone".
    if (!_cfgHydrated) {
      root.innerHTML = '<div style="padding:16px;color:var(--m);">Couldn\'t load your saved pipelines, so editing is turned off (the defaults must never overwrite your setup). '
        + '<button type="button" class="btn btn-ghost" data-pb-action="retry" style="font-size:12px;padding:6px 12px;margin-left:6px;">↻ Retry</button></div>';
      return;
    }
    var res = resolved();
    if (!res) { root.innerHTML = '<div style="padding:16px;color:var(--m);">Pipeline engine not loaded yet — reopen this tab in a moment.</div>'; return; }
    var editable = canEdit();
    var roles = ROLES();

    var html = '';
    html += '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;">';
    html += '<div style="font-size:12px;color:var(--m);flex:1;min-width:200px;">Reorder, rename, recolor and add stages per pipeline. Each stage has a <b>role</b> (Won/Lost/etc.) that drives your KPIs, revenue and the customer portal — so custom stages still count correctly.</div>';
    if (editable) {
      html += '<button type="button" class="btn btn-primary" data-pb-action="save" style="font-size:12px;padding:8px 14px;"' + (_dirty ? '' : ' disabled') + '>💾 Save changes</button>';
      html += '<button type="button" class="btn btn-ghost" data-pb-action="reset" style="font-size:12px;padding:8px 12px;">↺ Reset to defaults</button>';
    } else {
      html += '<div style="font-size:11px;color:var(--m);font-style:italic;">'
        + (window._userClaims ? 'Read-only — only the owner or a company admin can edit pipelines.'
                              : 'Read-only until your account permissions load — reopen this tab in a moment.')
        + '</div>';
    }
    html += '</div>';

    var viewOrder = Object.keys(res.views);
    viewOrder.forEach(function (vk) {
      var view = res.views[vk];
      var stages = view.stages || [];
      html += '<div style="border:1px solid var(--br);border-radius:10px;margin-bottom:14px;overflow:hidden;">';
      html += '<div style="padding:10px 12px;background:var(--s2);font-weight:700;font-size:13px;color:var(--t);">'
        + esc(view.label || vk) + ' <span style="font-weight:400;color:var(--m);font-size:11px;">· ' + stages.length + ' stages</span></div>';
      html += '<div style="padding:8px;">';

      stages.forEach(function (key, i) {
        var m = res.stageMeta[key] || {};
        var isCustom = !!m.custom;
        var isHidden = !!m.hidden;
        html += '<div class="pb-stage-row" data-view="' + esc(vk) + '" data-stage="' + esc(key) + '" style="display:flex;align-items:center;gap:6px;padding:5px 4px;border-bottom:1px solid var(--br);flex-wrap:wrap;' + (isHidden ? 'opacity:.5;' : '') + '">';
        // drag handle (primary reorder affordance; ▲/▼ stay for touch / a11y)
        if (editable) {
          html += '<span class="pb-grip" draggable="true" data-view="' + esc(vk) + '" data-stage="' + esc(key) + '" title="Drag to reorder">⠿</span>';
        }
        // reorder (.pb-reorder: on touch the pair lays out side by side at
        // 36px — see injectCss; stacked 22x20 arrows 1px apart were the only
        // phone reorder control, the grip being HTML5 drag)
        html += '<div class="pb-reorder" style="display:flex;flex-direction:column;gap:1px;">';
        html += '<button type="button" class="pb-mini" data-pb-action="up" data-view="' + esc(vk) + '" data-stage="' + esc(key) + '"' + (i === 0 || !editable ? ' disabled' : '') + ' title="Move up">▲</button>';
        html += '<button type="button" class="pb-mini" data-pb-action="down" data-view="' + esc(vk) + '" data-stage="' + esc(key) + '"' + (i === stages.length - 1 || !editable ? ' disabled' : '') + ' title="Move down">▼</button>';
        html += '</div>';
        // color
        html += '<input type="color" value="' + esc(m.color || '#374151') + '" data-pb-action="recolor" data-stage="' + esc(key) + '"' + (editable ? '' : ' disabled') + ' style="width:26px;height:26px;border:none;background:none;padding:0;cursor:pointer;" title="Stage color" />';
        // label
        html += '<input type="text" value="' + esc(m.label || key) + '" data-pb-action="rename" data-stage="' + esc(key) + '"' + (editable ? '' : ' disabled') + ' maxlength="40" style="flex:1;min-width:120px;font-size:12px;padding:5px 8px;border:1px solid var(--br);border-radius:6px;background:var(--s1);color:var(--t);" />';
        // role
        html += '<select data-pb-action="role" data-stage="' + esc(key) + '"' + (editable ? '' : ' disabled') + ' style="font-size:11px;padding:5px 6px;border:1px solid var(--br);border-radius:6px;background:var(--s1);color:var(--t);" title="Semantic role (drives KPIs/portal)">';
        roles.forEach(function (r) {
          html += '<option value="' + r + '"' + (m.role === r ? ' selected' : '') + '>' + esc(ROLE_LABEL[r] || r) + '</option>';
        });
        html += '</select>';
        // hide/show on the board (keeps the stage in config + dropdowns)
        html += '<button type="button" class="pb-mini" data-pb-action="togglehide" data-stage="' + esc(key) + '"' + (editable ? '' : ' disabled') + ' title="' + (isHidden ? 'Show on board' : 'Hide from board') + '">' + (isHidden ? '🙈' : '👁') + '</button>';
        // remove-from-view / delete-custom
        html += '<button type="button" class="pb-mini pb-danger" data-pb-action="remove" data-view="' + esc(vk) + '" data-stage="' + esc(key) + '"' + (editable ? '' : ' disabled') + ' title="Remove from this pipeline">✕</button>';
        if (isCustom) {
          html += '<button type="button" class="pb-mini pb-danger" data-pb-action="delete" data-stage="' + esc(key) + '"' + (editable ? '' : ' disabled') + ' title="Delete this custom stage everywhere">🗑</button>';
        }
        html += '</div>';
      });

      // add-custom row
      if (editable) {
        html += '<div style="display:flex;align-items:center;gap:6px;padding:8px 4px 2px;flex-wrap:wrap;">';
        html += '<input type="text" placeholder="New stage name…" data-pb-add-label="' + esc(vk) + '" maxlength="40" style="flex:1;min-width:120px;font-size:12px;padding:5px 8px;border:1px solid var(--br);border-radius:6px;background:var(--s1);color:var(--t);" />';
        html += '<select data-pb-add-role="' + esc(vk) + '" style="font-size:11px;padding:5px 6px;border:1px solid var(--br);border-radius:6px;background:var(--s1);color:var(--t);">';
        roles.forEach(function (r) { html += '<option value="' + r + '"' + (r === 'active' ? ' selected' : '') + '>' + esc(ROLE_LABEL[r] || r) + '</option>'; });
        html += '</select>';
        html += '<button type="button" class="btn btn-ghost" data-pb-action="add" data-view="' + esc(vk) + '" style="font-size:11px;padding:6px 10px;">+ Add stage</button>';
        html += '</div>';
      }

      html += '</div></div>';
    });

    // Unsaved-changes save bar (phone audit views#9, 2026-09-25). The only
    // Save lived in the header above, and the editor is 6,596px tall at 412
    // (7 pipelines, 63 stage rows): after renaming a stage in the last
    // pipeline, Save sat 5,755px above the viewport — 7.4 screens up, with
    // nothing on screen saying the edit wasn't saved yet. This bar appears
    // as soon as the working copy is dirty (render, or markDirtyLight while
    // typing) and rides the bottom of the viewport: sticky inside the view's
    // scroller on desktop, fixed above #mobile-nav on phones (there the
    // document scrolls and <body> is an overflow container, so sticky never
    // engages) — see injectCss. It is the same data-pb-action="save" the
    // header button uses. The outer .pb-savebar is also the in-flow spacer
    // that keeps the last pipeline's rows from ending up under the fixed bar.
    if (editable) {
      html += '<div class="pb-savebar"' + (_dirty ? '' : ' hidden') + '><div class="pb-savebar-inner">'
        + '<button type="button" class="btn btn-orange" data-pb-action="save">💾 Save changes</button>'
        + '<span class="pb-savebar-msg">Unsaved changes</span>'
        + '</div></div>';
    }

    root.innerHTML = html;
  }

  // ── delegated handlers ──────────────────────────────────
  // Edits only ever touch a hydrated working copy. render() never draws the
  // controls otherwise; this also covers a stale or synthetic event.
  function canMutate() { return _cfgHydrated === true && !!_cfg; }

  function onChange(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (!canMutate()) return;
    var action = t.getAttribute('data-pb-action');
    if (action === 'rename') { setStageField(t.getAttribute('data-stage'), 'label', t.value); markDirtyLight(); }
    else if (action === 'recolor') { setStageField(t.getAttribute('data-stage'), 'color', t.value); render(); }
    else if (action === 'role') { setStageField(t.getAttribute('data-stage'), 'role', t.value); render(); }
  }

  // Rename fires on every keystroke via 'input'; keep the field focused (don't
  // re-render) and just flip the Save button on.
  function markDirtyLight() {
    _dirty = true;
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    // Every Save copy (header + the bottom save bar), not just the first.
    var saveBtns = root.querySelectorAll('[data-pb-action="save"]');
    for (var i = 0; i < saveBtns.length; i++) saveBtns[i].disabled = false;
    var bar = root.querySelector('.pb-savebar');
    if (bar) bar.hidden = false;
  }

  async function onClick(e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-pb-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-pb-action');
    if (action === 'rename' || action === 'recolor' || action === 'role') return; // handled on change
    e.preventDefault();
    if (action === 'retry') {
      openBuilder().catch(function (err) { console.warn('[pipelines] open failed', err); });
      return;
    }
    // save/reset carry their own gate (writeReady, inside save()); everything
    // else edits the working copy and needs a hydrated one.
    if (action !== 'save' && action !== 'reset' && !canMutate()) return;
    var res = resolved(); if (!res && action !== 'reset') return;
    var vk = btn.getAttribute('data-view');
    var key = btn.getAttribute('data-stage');

    if (action === 'up' || action === 'down') {
      var arr = ensureViewStages(vk, res);
      var idx = arr.indexOf(key);
      if (idx === -1) return;
      var swap = action === 'up' ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= arr.length) return;
      var tmp = arr[idx]; arr[idx] = arr[swap]; arr[swap] = tmp;
      _dirty = true; render();
    } else if (action === 'remove') {
      // CRM audit 2026-11-06 (ST-F51): same guard as 🗑 delete. Removing a stage
      // that still holds leads dropped them into this pipeline's first column.
      var rv = canDeleteStage(key);
      if (!rv.ok) {
        var rnm = (res.stageMeta[key] || {}).label || key;
        if (rv.unhydrated) { toast('Still loading your leads — wait a moment and try removing "' + rnm + '" again.', 'error'); return; }
        toast(rv.count + ' lead' + (rv.count === 1 ? ' is' : 's are') + ' still on "' + rnm + '." Move ' + (rv.count === 1 ? 'it' : 'them') + ' to another stage first, then remove it from this pipeline.', 'error');
        return;
      }
      var a2 = ensureViewStages(vk, res);
      var j = a2.indexOf(key);
      if (j !== -1) { a2.splice(j, 1); _dirty = true; render(); }
    } else if (action === 'togglehide') {
      var cur = res.stageMeta[key] && res.stageMeta[key].hidden;
      setStageField(key, 'hidden', !cur); // resolver only hides on === true; false ⇒ shown
      render();
    } else if (action === 'delete') {
      var verdict = canDeleteStage(key);
      if (!verdict.ok) {
        var nm = (res.stageMeta[key] || {}).label || key;
        if (verdict.unhydrated) {
          toast('Still loading your leads — wait a moment and try deleting "' + nm + '" again.', 'error');
          return;
        }
        var n = verdict.count;
        toast(n + ' lead' + (n === 1 ? ' is' : 's are') + ' still on "' + nm + '." Move '
          + (n === 1 ? 'it' : 'them') + ' to another stage on the board first, then delete this stage.', 'error');
        return;
      }
      // native confirm() is patched to silently return true in PWA standalone
      // mode (standalone-compat.js), so a tap on 🗑 would delete the stage with
      // no prompt at all. nbdConfirm gives a real Promise<boolean> modal there
      // and falls back to native confirm on desktop.
      var askDel = window.nbdConfirm || function (m) { return Promise.resolve(typeof confirm === 'function' ? confirm(m) : true); };
      if (!(await askDel('Delete this custom stage from every pipeline?'))) return;
      delete _cfg.stages[key];
      Object.keys(_cfg.views || {}).forEach(function (v) {
        if (_cfg.views[v] && Array.isArray(_cfg.views[v].stages)) {
          _cfg.views[v].stages = _cfg.views[v].stages.filter(function (s) { return s !== key; });
        }
      });
      _dirty = true; render();
    } else if (action === 'add') {
      var root = document.getElementById(ROOT_ID);
      var labEl = root && root.querySelector('[data-pb-add-label="' + cssEsc(vk) + '"]');
      var roleEl = root && root.querySelector('[data-pb-add-role="' + cssEsc(vk) + '"]');
      var label = (labEl && labEl.value || '').trim();
      var role = (roleEl && roleEl.value) || 'active';
      if (!label) { toast('Enter a stage name', 'error'); return; }
      var newKey = makeCustomKey(label, res);
      _cfg.stages[newKey] = { label: label.slice(0, 40), role: role, color: '#6366f1', icon: '📌' };
      var arr3 = ensureViewStages(vk, res);
      // Insert before the terminal Lost/Closed column if present, else append.
      var insAt = arr3.length;
      for (var k = 0; k < arr3.length; k++) {
        var rk = (res.stageMeta[arr3[k]] || {}).role;
        if (rk === 'lost' || arr3[k] === 'closed') { insAt = k; break; }
      }
      arr3.splice(insAt, 0, newKey);
      _dirty = true; render();
    } else if (action === 'save') {
      await save();
    } else if (action === 'reset') {
      // Refuse BEFORE asking — don't make them confirm a reset that can't run.
      if (!writeReady()) { toast(NOT_LOADED_MSG, 'error'); return; }
      var askReset = window.nbdConfirm || function (m) { return Promise.resolve(typeof confirm === 'function' ? confirm(m) : true); };
      if (!(await askReset('Reset ALL pipelines to the NBD defaults? Your custom stages + ordering will be removed.'))) return;
      var _prevCfg = _cfg, _prevDirty = _dirty;
      _cfg = { stages: {}, views: {} };
      _dirty = true;
      // Only force-clear the in-memory config below if the write LANDED. A
      // refused or failed save used to fall through and blank the live board
      // anyway (defaults until reload) while the server kept the old config.
      if (!(await save())) { _cfg = _prevCfg; _dirty = _prevDirty; render(); return; }
      // save() persisted {stages:{},views:{}} (Firestore clears the nested maps),
      // but _saveCompanyProfile's deep-merge PRESERVES the old overrides in the
      // in-memory profile — so force it empty and re-apply defaults now, instead
      // of the reset appearing to do nothing until a page reload.
      if (window._companyProfile) window._companyProfile.pipelines = {};
      // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
      var _nbdReg = window.__NBD_CALL_REGISTRY;
      if (_nbdReg && typeof _nbdReg.applyPipelineConfig === 'function') { try { _nbdReg.applyPipelineConfig(); } catch (_) {} }
      loadCfg(); render();
    }
  }

  function cssEsc(s) { return String(s || '').replace(/["\\]/g, '\\$&'); }

  function makeCustomKey(label, res) {
    var slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'stage';
    var base = 'custom_' + slug, key = base, n = 2;
    while (res.stageMeta[key] || _cfg.stages[key]) { key = base + '_' + n; n++; }
    return key;
  }

  // Resolves true only when the config was actually written.
  async function save() {
    // Hydration gate FIRST (see writeReady + the header): a working copy
    // seeded from the NBD defaults must never reach the tenant-wide write.
    if (!writeReady()) { toast(NOT_LOADED_MSG, 'error'); return false; }
    if (!canEdit()) { toast('Only the owner or a company admin can edit pipelines', 'error'); return false; }
    if (typeof window._saveCompanyProfile !== 'function') { toast('Cannot save right now', 'error'); return false; }
    // Header Save + the bottom save bar's Save: both show progress, and both
    // come back on failure (querySelector used to reach only the first).
    var btns = document.querySelectorAll('#' + ROOT_ID + ' [data-pb-action="save"]');
    for (var bi = 0; bi < btns.length; bi++) { btns[bi].disabled = true; btns[bi].textContent = 'Saving…'; }
    try {
      await window._saveCompanyProfile({ pipelines: _cfg });
      // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
      var _nbdReg = window.__NBD_CALL_REGISTRY;
      if (_nbdReg && typeof _nbdReg.applyPipelineConfig === 'function') _nbdReg.applyPipelineConfig();
      _dirty = false;
      toast('Pipelines saved', 'ok');
      // Reload from the (now-merged) profile so the working copy matches server.
      loadCfg(); render();
      return true;
    } catch (e) {
      console.warn('[pipelines] save failed', e);
      toast('Save failed: ' + ((e && e.message) || 'unknown'), 'error');
      for (var bj = 0; bj < btns.length; bj++) { btns[bj].disabled = false; btns[bj].textContent = '💾 Save changes'; }
      return false;
    }
  }

  // ── drag-to-reorder (HTML5 DnD, delegated + CSP-safe) ───────────
  function _clearDropHints(root) {
    var rows = root.querySelectorAll('.pb-stage-row.pb-dragover');
    for (var i = 0; i < rows.length; i++) rows[i].classList.remove('pb-dragover');
  }
  function onDragStart(e) {
    var g = e.target && e.target.closest && e.target.closest('.pb-grip');
    if (!g) return;
    _drag = { view: g.getAttribute('data-view'), stage: g.getAttribute('data-stage') };
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', _drag.stage); } catch (_) {} }
  }
  function onDragOver(e) {
    if (!_drag) return;
    var row = e.target && e.target.closest && e.target.closest('.pb-stage-row');
    if (!row || row.getAttribute('data-view') !== _drag.view) return; // reorder within a pipeline only
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    var root = document.getElementById(ROOT_ID);
    if (root) { _clearDropHints(root); if (row.getAttribute('data-stage') !== _drag.stage) row.classList.add('pb-dragover'); }
  }
  function onDrop(e) {
    if (!_drag) return;
    var row = e.target && e.target.closest && e.target.closest('.pb-stage-row');
    var payload = _drag; _drag = null;
    var root = document.getElementById(ROOT_ID);
    if (root) _clearDropHints(root);
    if (!row) return;
    var view = row.getAttribute('data-view');
    var target = row.getAttribute('data-stage');
    if (view !== payload.view || target === payload.stage) return;
    e.preventDefault();
    if (!canMutate()) return;
    var res = resolved(); if (!res) return;
    var arr = ensureViewStages(view, res);
    var from = arr.indexOf(payload.stage);
    if (from === -1) return;
    arr.splice(from, 1);
    var to = arr.indexOf(target);
    if (to === -1) { arr.splice(from, 0, payload.stage); return; } // target vanished — undo
    // Drop before/after the target based on where in the row we released.
    var rect = row.getBoundingClientRect();
    var after = (e.clientY - rect.top) > rect.height / 2;
    arr.splice(after ? to + 1 : to, 0, payload.stage);
    _dirty = true; render();
  }

  function wireRoot() {
    var root = document.getElementById(ROOT_ID);
    if (!root || root._pbWired) return;
    root._pbWired = true;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', function (e) {
      if (!canMutate()) return;
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-pb-action') === 'rename') { setStageField(e.target.getAttribute('data-stage'), 'label', e.target.value); markDirtyLight(); }
    });
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('drop', onDrop);
    root.addEventListener('dragend', function () { _drag = null; _clearDropHints(root); });
  }

  // Await-then-require (the _tenantFilePrefix pattern): if the profile isn't
  // definitively loaded, show "Loading…", await _loadCompanyProfile() (which
  // also RETRIES a read that failed at boot — a poll would just spin), then
  // snapshot. loadCfg records whether that worked; render() and save() both
  // honour it, so a failed load ends in a Retry prompt, never an editor.
  async function openBuilder() {
    var seq = ++_openSeq;
    wireRoot();
    _dirty = false;
    if (window._companyProfileLoaded !== true) {
      _cfg = null; _cfgHydrated = false; _loading = true;
      render();
      try {
        if (typeof window._loadCompanyProfile === 'function') await window._loadCompanyProfile();
      } catch (_) { /* a failed load leaves the flag unset — handled below */ }
      if (seq !== _openSeq) return; // a newer open owns the panel now
    }
    _loading = false;
    loadCfg();
    render();
  }

  // Inject the once-only CSS for the mini buttons.
  function injectCss() {
    if (document.getElementById('pb-style')) return;
    var s = document.createElement('style');
    s.id = 'pb-style';
    s.textContent = '.pb-mini{background:var(--s2);border:1px solid var(--br);color:var(--m);border-radius:5px;width:22px;height:20px;font-size:9px;line-height:1;cursor:pointer;padding:0;}'
      + '.pb-mini:disabled{opacity:.35;cursor:default;}.pb-mini.pb-danger{color:var(--red,#e05252);border-color:var(--red,#e05252);height:26px;width:26px;font-size:11px;}'
      + '.pb-grip{cursor:grab;color:var(--m);font-size:14px;line-height:1;padding:0 2px;user-select:none;touch-action:none;}'
      + '.pb-grip:active{cursor:grabbing;}'
      + '.pb-stage-row{border-radius:6px;transition:background .08s;}'
      + '.pb-stage-row.pb-dragover{background:color-mix(in srgb, var(--orange) 14%, transparent);box-shadow:inset 0 2px 0 var(--orange);}'
      // Touch (phone audit views#9, 2026-09-25): ▲/▼/👁 were 22x20 with ▲ and
      // ▼ stacked 1px apart (12px below ▲'s centre already hit ▼), and ✕ 26x26
      // — on a phone those arrows are the ONLY way to reorder, since the grip
      // is HTML5 drag. Same hover:none gate + 36px floor as the Wave 81 touch
      // rule in dashboard-app.css; ▲ ▼ go side by side so the pair doesn't
      // make every row 76px tall.
      + '@media (hover:none){.pb-mini,.pb-mini.pb-danger{width:36px;height:36px;font-size:13px;border-radius:7px;}'
      +   '.pb-reorder{flex-direction:row!important;gap:4px!important;}}'
      // Unsaved-changes save bar (see render()). Button first, hugging the left
      // edge, so on desktop it stays clear of the bottom-right FAB rail
      // (fab-stack-coordinator.js: move sideways, never stack on it).
      + '.pb-savebar{position:sticky;bottom:12px;z-index:var(--z-sticky,50);margin-top:12px;}'
      + '.pb-savebar[hidden]{display:none;}'
      + '.pb-savebar-inner{display:flex;align-items:center;gap:12px;width:max-content;max-width:100%;padding:8px 14px 8px 8px;background:var(--s);border:1px solid var(--orange);border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.28);}'
      + '.pb-savebar-inner .btn{font-size:13px;padding:10px 16px;min-height:40px;}'
      + '.pb-savebar-msg{font-size:12px;font-weight:600;color:var(--t);}'
      // Phones: the document is the scroller and <body> an overflow container,
      // so sticky never engages — the inner bar is fixed above #mobile-nav
      // (62px + safe area, riding above any bottom strip via margin-bottom like
      // the nav itself) and the outer div stays in flow as a spacer so the last
      // pipeline can still scroll clear of it.
      + '@media (max-width:768px){.pb-savebar{position:static;height:68px;margin-top:8px;}'
      +   '.pb-savebar-inner{position:fixed;left:12px;right:12px;width:auto;bottom:calc(62px + env(safe-area-inset-bottom,0px) + 10px);margin-bottom:var(--nbd-bottom-chrome,0px);z-index:var(--z-sticky,50);justify-content:flex-start;}}';
    document.head.appendChild(s);
  }

  // ── leave guard (2026-09-25, phone-audit follow-up views#9) ─────────────
  // The save bar says "Unsaved changes", but leaving the tab threw the edits
  // away without a word: openBuilder() resets _dirty and re-clones the saved
  // config, so Pipelines → Profile → Pipelines (or any view change) silently
  // dropped a rename or a reorder — and on a phone the bottom nav is one thumb
  // away from the last stage. Now a tab switch or a view change away from an
  // edited, on-screen builder asks first; Cancel keeps the working copy.
  // Deliberately NOT beforeunload: that fires the browser's own prompt on every
  // reload/close, the spam this guard is meant to avoid.
  var LEAVE_MSG = 'You have unsaved pipeline changes.\n\nLeave without saving? OK discards them. Cancel stays here so you can Save.';
  var _asking = false;
  // Edits are only "pending" while the builder is actually on screen: a hidden
  // panel (another Settings tab, another view) has nothing to leave.
  function pendingEdits() {
    if (!_dirty || !_cfgHydrated) return false;
    var root = document.getElementById(ROOT_ID);
    return !!root && typeof root.getClientRects === 'function' && root.getClientRects().length > 0;
  }
  // Resolves true when leaving is fine: nothing pending, or the rep chose to
  // discard (the next Pipelines open reloads the saved config). nbdConfirm is
  // the installed app's real modal; native confirm is the browser fallback.
  function confirmLeave() {
    if (!pendingEdits()) return Promise.resolve(true);
    if (_asking) return Promise.resolve(false); // a prompt is already up: drop the repeat tap
    _asking = true;
    var ask = window.nbdConfirm || function (m) { return Promise.resolve(window.confirm(m)); };
    return Promise.resolve(ask(LEAVE_MSG)).then(function (ok) {
      _asking = false;
      if (ok) _dirty = false;
      return !!ok;
    }, function () { _asking = false; return false; });
  }

  // Hook switchSettingsTab so the builder renders when Settings → Pipelines opens
  // (the panel is inside the lazily-hydrated settings template).
  function installHook() {
    injectCss();
    installNavGuard();
    var _prev = window.switchSettingsTab;
    if (typeof _prev !== 'function' || _prev._pbWrapped) { return; }
    var wrapped = function (tab) {
      var self = this, args = arguments;
      function run() {
        var r = _prev.apply(self, args);
        // openBuilder is async (it may await the profile load), so a try/catch
        // here would never see its failures — attach the handler to the promise
        // instead of leaving an unhandled rejection.
        if (tab === 'pipelines') { openBuilder().catch(function (e) { console.warn('[pipelines] open failed', e); }); }
        return r;
      }
      if (pendingEdits()) {
        // Re-selecting Pipelines while it is open with edits: openBuilder would
        // reset the working copy, so leave the panel exactly as it is.
        if (tab === 'pipelines') return;
        confirmLeave().then(function (ok) { if (ok) run(); });
        return;
      }
      return run();
    };
    wrapped._pbWrapped = true;
    window.switchSettingsTab = wrapped;
  }

  // View changes: every navigation (sidebar, bottom nav, More, the header's
  // Settings pill, the hash router on Back) goes through window.goTo — the
  // delegate and the router call it as a bare global. This file loads with the
  // Settings template, after goTo and its other wrappers exist. goTo('settings')
  // itself passes: it re-opens Settings on Profile via switchSettingsTab, which
  // is guarded above.
  function installNavGuard() {
    var _prevGoTo = window.goTo;
    if (typeof _prevGoTo !== 'function' || _prevGoTo._pbGuard) return;
    var guarded = function (name) {
      var self = this, args = arguments;
      if (name !== 'settings' && pendingEdits()) {
        confirmLeave().then(function (ok) {
          if (ok) { _prevGoTo.apply(self, args); return; }
          // Cancelled a Back press: the router already moved the hash, so put
          // it back without firing another hashchange.
          if (location.hash.indexOf('#/settings') !== 0 && history.replaceState) {
            try { history.replaceState(history.state, '', '#/settings'); } catch (_) { /* hash stays as-is */ }
          }
          // ...and tell the bottom nav, which lit the Back target on that
          // hashchange (mobile-nav-customizer.js re-syncs to the hash on
          // this event; 2026-09-25 phone nav polish).
          try { window.dispatchEvent(new CustomEvent('nbd:route-restored')); } catch (_) { /* no nav to re-sync */ }
        });
        return;
      }
      return _prevGoTo.apply(this, arguments);
    };
    guarded._pbGuard = true;
    window.goTo = guarded;
  }

  // Public surface: the pure delete-guard decision (occupied stages can't be
  // deleted) so it's unit-testable off the DOM. Mirrors the billing-gate
  // window.NBDBilling idiom.
  window.PipelineBuilder = { leadsOnStage: leadsOnStage, canDeleteStage: canDeleteStage };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installHook);
  } else {
    installHook();
  }
})();
