(function () {
/**
 * dashboard-ui.js — DOM render helpers, event delegates, modals,
 * sidebar/mobile/theme UI bindings for the dashboard surface.
 *
 * Extracted from dashboard-main.js (Step 4a — 2026-05-16). Fourth
 * in the state→api→widgets→ui→actions→main load chain.
 *
 * Lives here:
 *   - breadcrumb update + template hydration
 *   - the data-action click delegate (allowlists come from
 *     dashboard-state.js)
 *   - Cal.com embed UI
 *   - autocomplete UI (renderAcDrop / initAddressAutocomplete /
 *     selectAcItem / hideAcDrop / initAllAutocomplete +
 *     formatMailingAddress helpers)
 *   - document template UI (DOC_TEMPLATES + tlToggleCat /
 *     openDocTemplate / closeDocViewer / printDoc / openUploadDoc /
 *     closeUploadDoc / handleDocUpload / injectBlankButtons IIFE)
 *   - property intel modal toggles
 *   - theme + comfort + auto-theme UI (applyTheme, loadSavedTheme,
 *     nbdComfortSet/*, nbdAutoTheme*)
 *   - kanban density + bold hierarchy UI
 *   - page-breathe: sidebar collapse, kanban fullscreen, Tools menu,
 *     scroll-collapse, FAB visibility
 *   - daily-program render helpers (theme grid, floors)
 *   - mobile nav (mobileNav, toggleMobileMore, closeMobileMore,
 *     toggleMapSidebar, syncMobileBadge)
 *   - CRM secondary-header auto-hide UI
 *   - spyglass / fab / quick-storm UI
 */

// ══════════════════════════════════════════════
// WHOLE-FILE IIFE — Globals Tranche 3 T3-A (2026-09-18)
// ══════════════════════════════════════════════
// This file is one IIFE, from line 1 to the `})();` after the
// __NBD_CALL_REGISTRY block at the bottom. It is deliberately NOT re-indented
// and has no 'use strict' (strict mode would change the `this` that the goTo
// wrappers below forward). A function or const declared here is private to
// the file. Other files reach it only through an explicit window export (the
// block below, plus the pre-existing `window.X = X;` lines further down) or
// through __NBD_CALL_REGISTRY.
//
// Load-once guard. Before the wrap, the file's top-level consts made a second
// execution a redeclaration SyntaxError that aborted cleanly. Inside the IIFE
// a second run would succeed and bind every document-level delegate below a
// second time, so each data-action / data-fn click would fire twice. Same
// shared registry idiom as the Tranche 0 widgets (activity-feed.js et al.).
const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
if (__NBD_LOADED['dashboard-ui']) return;
__NBD_LOADED['dashboard-ui'] = true;

// ══════════════════════════════════════════════
// WINDOW EXPORTS — Globals Tranche 3 T3-A (2026-09-18)
// ══════════════════════════════════════════════
// Every function below is declared in THIS file and reached from OUTSIDE it
// through the global object: a bare cross-file call, a window.X read, or a
// name-string dispatch map resolved against window. Inside the IIFE these
// lines are the only thing keeping the names reachable. Before the wrap they
// were redundant, because a top-level `function X` in a classic script
// already owned window.X (that prep landed first, as a zero-behaviour PR).
//
// The block sits at the TOP on purpose. Declarations are hoisted, so these
// lines run before the first statement that can throw at load: the eager
// template hydrate below and the unguarded #photoModal / #tipsModal listeners
// further down. The file's older exports sit below those throw points; a
// load-time throw there would strand them (latent: both elements are static
// markup in dashboard.html). Plain `window.X = X;` only:
// tests/smoke/dashboard.test.js's FWD_GUARD pin bans the typeof-guarded
// re-export form in this file.
window.updateBreadcrumb = updateBreadcrumb;             // dashboard-actions.js goTo(), bare
window._hydrateViewTemplate = _hydrateViewTemplate;     // dashboard-actions.js goTo(), bare
window._paintUserGreetings = _paintUserGreetings;       // dashboard-bootstrap.module.js auth + profile save, window.X
window.loadCalSettings = loadCalSettings;               // dashboard-main.js DOMContentLoaded, bare
window.renderAcDrop = renderAcDrop;                     // dashboard-api.js fetchAcSuggestions, bare
window.hideAcDrop = hideAcDrop;                         // crm-leads.js + this file's Enter delegate read it off window; maps-overlays.js, bare
window.closeUploadDoc = closeUploadDoc;                 // dashboard-api.js, bare; _NBD_MODAL_CLOSE_FNS.uploadDoc
window.applyTheme = applyTheme;                         // maps.js + ui.js, bare
window.dsRenderFloors = dsRenderFloors;                 // dashboard-actions.js daily-program cluster, bare
window.dsBuildThemeGrid = dsBuildThemeGrid;             // dashboard-actions.js daily-program cluster, bare
window.getCrmSecHeaderEnabled = getCrmSecHeaderEnabled; // dashboard-actions.js, bare
window.mobileNav = mobileNav;                           // mobile-nav-customizer.js replaces this at init; covers the gap before it
window.toggleMobileMore = toggleMobileMore;             // mobile-nav-customizer.js More button; _NBD_TOGGLE_FNS.mobileMore
window.closeMobileMore = closeMobileMore;               // dashboard-actions.js, mobile-nav-customizer.js; _NBD_MODAL_CLOSE_FNS.mobileMore
window.toggleMapSidebar = toggleMapSidebar;             // REQUIRED @audit shard: fnCheck('toggleMapSidebar')
// A documented TEST SEAM, not an app API. tests/e2e/globals-surface-snapshot.spec.js
// calls the real resolver to prove every _NBD_TOGGLE_FNS / _NBD_MODAL_CLOSE_FNS
// entry still resolves; that spec is the Globals tranches' before/after proof
// tool. No app code reads this name off window.
window._nbdResolveMapped = _nbdResolveMapped;

// ══════════════════════════════════════════════
// VIEW TEMPLATE HYDRATION + BREADCRUMB
// ══════════════════════════════════════════════
// Update breadcrumb navigation
function updateBreadcrumb(routeName, params = {}) {
  const breadcrumbEl = document.getElementById('breadcrumb-nav');
  if (!breadcrumbEl) return;

  const route = routeConfig[routeName];
  if (!route) {
    breadcrumbEl.innerHTML = '';
    return;
  }

  const crumbs = [];

  // Build breadcrumb trail
  if (route.parent) {
    const parentRoute = routeConfig[route.parent];
    if (parentRoute) {
      crumbs.push(`<a href="#/${route.parent}" class="breadcrumb-link">${parentRoute.label}</a>`);
    }
  }

  // Add current page
  crumbs.push(`<span class="breadcrumb-current">${route.label}</span>`);

  // Add detail params (like lead name, estimate number)
  if (params.detail) {
    crumbs.push(`<span class="breadcrumb-current">${params.detail}</span>`);
  }

  breadcrumbEl.innerHTML = crumbs.join('<span class="breadcrumb-sep">›</span>');
}

// Rock 4 Phase 3 — lazy hydration for templated views.
// A view DIV carrying data-view-template="tpl-<id>" starts empty; on first
// goTo() we clone the matching <template> into it. Idempotent: re-hydration
// is a no-op once the view has children. This is the foundation for the
// stub-view batch (aitree, understand, projectcodex, aiusage, board, ...)
// per docs/dev/dashboard-decomposition-plan.md Phase 3.
function _hydrateViewTemplate(name) {
  const view = document.getElementById('view-' + name);
  if (!view) return false;
  if (view.children.length > 0) return true; // already hydrated
  const tplId = view.dataset.viewTemplate;
  if (!tplId) return false;
  const tpl = document.getElementById(tplId);
  if (!tpl || !('content' in tpl)) return false;

  // Phase C.3+ — template <script>s run when the view hydrates. Each one
  // must run EXACTLY ONCE, in document order (2026-09-25 phone nav polish).
  //
  // This used to append the clone first and then swap every cloned
  // <script> in the live view for a fresh createElement copy, on the
  // premise that a cloned script is inert. It is not: a script parsed into
  // a <template> was never connected, so it never "started", and its clone
  // runs the moment it is inserted. So every template script ran TWICE —
  // once from the clone, once from the swap (measured on the Settings
  // template: two runs of all seven, in Chromium and WebKit). Every
  // switchSettingsTab wrapper went on twice, so opening Billing fired
  // loadSubscription twice and opening Team loaded the roster twice, and
  // pipeline-builder.js needed a guard of its own (#1767).
  //
  // Now the swap happens in the detached fragment, BEFORE anything is
  // inserted. The only script elements that ever reach the page are the
  // fresh copies, and each runs once, on insertion. importNode (not
  // content.cloneNode) makes the fragment this document's own, so the fresh
  // copies never move between documents. A script inserted by
  // script is async by default, which ran these in whatever order they
  // finished loading. async = false (unless the markup asked for async)
  // runs them in document order, the nearest thing to the `defer`
  // ordering they would have had in the page. The views that use this are
  // external files only; the page CSP refuses inline scripts, so an inline
  // copy keeps its text but would not run. Scripts that expect
  // DOMContentLoaded need a `document.readyState` check (see
  // dashboard-accessory-panel-init.js).
  const frag = document.importNode(tpl.content, true);
  frag.querySelectorAll('script').forEach(oldScript => {
    const newScript = document.createElement('script');
    for (const attr of Array.from(oldScript.attributes)) {
      newScript.setAttribute(attr.name, attr.value);
    }
    if (oldScript.hasAttribute('src')) {
      if (!oldScript.hasAttribute('async')) newScript.async = false;
    } else {
      newScript.text = oldScript.textContent;
    }
    oldScript.replaceWith(newScript);
  });
  view.appendChild(frag);
  _paintUserGreetings(view);
  _wireViewAddressSearch(name, view);
  return true;
}

// Greeting slots (phone audit 2026-09-25, pipeline#13 / views#12).
// #homeGreeting and the Dashboard title both live inside lazily-hydrated
// <template>s, but their only writer ran ONCE, at auth time
// (dashboard-bootstrap.module.js) — so a view cloned in after auth kept its
// template default. The Dashboard's default was a hard-coded owner's first
// name, and the app boots into Home, so every tenant who tapped the bottom-nav
// Home tab (which routes to 'dash') was welcomed as someone else. Every
// [data-user-greeting] element is now painted from window._user in BOTH places:
// here on every template clone, and by the auth-time writer via the window
// export above. Before auth resolves there is no user, so the neutral template
// text ("Welcome Back") stands.
function _paintUserGreetings(root) {
  const u = window._user;
  if (!u) return;
  const name = String(u.displayName || String(u.email || '').split('@')[0] || '').trim();
  const first = name.split(/\s+/)[0] || '';
  (root || document).querySelectorAll('[data-user-greeting]').forEach(function (el) {
    el.textContent = first ? 'Welcome Back, ' + first : 'Welcome Back';
  });
}

// Phase C.1 — eager-hydrate any .view.active (i.e. the default-active
// view-home) at module load so the first paint shows real content
// instead of an empty mount div. goTo() at boot is idempotent: when
// it later calls _hydrateViewTemplate('home') the view already has
// children and the function returns early.
(function _eagerHydrateActiveViews(){
  try {
    document.querySelectorAll('.view.active[data-view-template]').forEach(v => {
      const id = (v.id || '').replace(/^view-/, '');
      if (id) _hydrateViewTemplate(id);
    });
  } catch (e) { /* non-fatal — goTo() will hydrate later */ }
})();

// ══════════════════════════════════════════════
// DATA-ACTION CLICK DELEGATE
// ══════════════════════════════════════════════
// Phase C.4 starter — body-level click delegate for [data-action] elements.
//
// First action wired: data-action="goTo" data-target="<viewname>" replaces
// 52 inline `onclick="goTo('xxx')"` handlers in dashboard.html. Future
// actions register in the switch below.
//
// Why a delegate
//   - Each onclick="..." attribute counts against script-src 'unsafe-
//     inline' in the CSP. Once every inline handler is delegated we can
//     drop 'unsafe-inline' (Phase C.5) and tighten the CSP.
//   - One bound listener vs. 416 inline handlers = lower DOM cost on
//     re-renders and fewer string-eval'd handler bodies.
//   - data-* attributes are easier to audit, search, and refactor than
//     inline JS strings.
//
// Capture phase + .closest() so clicks on icons/spans inside the action
// element still resolve to the data-action ancestor.
// ══════════════════════════════════════════════
// DATA-ON CHANGE / INPUT DELEGATE — CSP-safe replacement for
// inline `onchange="..."` and `oninput="..."` attributes (the same
// CSP `script-src-attr 'none'` that blocks `onclick=` blocks these).
//
// Markup:
//   <input data-on-change="setFoo" data-on-pass="checked" ...>
//   <input data-on-input="setBar" data-on-pass="value" ...>
//   <select data-on-change="setBaz" data-on-pass="value" ...>
//   <input type="file" data-on-change="handleUpload" data-on-pass="files0" ...>
//
// `data-on-pass` controls what's passed as the first argument:
//   'checked' → el.checked (booleans)
//   'value'   → el.value (default)
//   'files0'  → el.files && el.files[0]
//   'int'     → parseInt(el.value, 10)
//   'float'   → parseFloat(el.value)
//   'element' → el itself (for handlers that read multiple properties)
//   'event'   → the event object (rare; for handlers expecting an event)
//
// `data-on-arg` provides a STATIC second argument (literal string).
// Function name must be registered in `__NBD_CALL_REGISTRY` (Tranche 2c
// module-scoped handlers) or on `_NBD_CALL_ALLOWLIST` (window globals).
//
// `data-on-after` (optional) names a SECOND function called immediately
// after the first — covers the inline pattern `f(this.checked); g()`.

// Resolve a markup-dispatched function name. Converted modules register
// their handlers in window.__NBD_CALL_REGISTRY (one namespaced global)
// instead of exposing each function on window — the registry is checked
// FIRST and needs no allowlist entry (registration is the explicit
// opt-in). Unconverted names keep resolving via window[fnName], gated by
// _NBD_CALL_ALLOWLIST exactly as before. Returns null when the name is
// unregistered/unlisted or not (yet) a function.
function _nbdResolveCall(fnName) {
  if (!fnName) return null;
  const reg = window.__NBD_CALL_REGISTRY;
  if (reg && typeof reg[fnName] === 'function') return reg[fnName];
  if (typeof _NBD_CALL_ALLOWLIST !== 'undefined' && !_NBD_CALL_ALLOWLIST.has(fnName)) return null;
  const fn = window[fnName];
  return typeof fn === 'function' ? fn : null;
}

// Resolve a handler name that came from one of the CURATED dispatch maps —
// _NBD_TOGGLE_FNS or _NBD_MODAL_CLOSE_FNS in dashboard-state.js. Registry
// first, then window, same precedence as _nbdResolveCall.
//
// Deliberately NO _NBD_CALL_ALLOWLIST gate, and that is the whole difference
// from _nbdResolveCall: there, `fnName` arrives from markup (data-fn=) and the
// allowlist is what stops arbitrary markup invoking an arbitrary global. Here
// the name never came from the page — the delegate read a data-target key and
// looked it up in an in-code map, so the map IS the allowlist. Adding an
// allowlist gate would break 35 of the 36 current names: only closeQuickAddLead
// happens to appear in both _NBD_CALL_ALLOWLIST and a map, and it is there for
// its separate data-fn dispatch, not for this path.
//
// Globals Tranche 3 (2026-09-01). Before this, both maps dispatched via a bare
// `window[fnName]`, which meant a handler reachable ONLY through one of these
// maps could never be taken off window: a module-scoped function is invisible
// to a string lookup on the global object. That pinned ~10 names — nearly all
// of them modal-CLOSE handlers — permanently outside the tranche. Now they can
// register like any other converted handler.
//
// Why this could ship safely: BEFORE this change the intersection of {36 names
// in the two maps} and {the __NBD_CALL_REGISTRY keys} was EMPTY, so `reg[fnName]`
// was undefined for every existing name and resolution fell straight through to
// window[fnName] exactly as before — a strict no-op. Had any name been in both,
// flipping the order would have silently swapped which implementation runs.
//
// AFTER this change the intersection is 2 of 36, on purpose: the same commit
// registers closeMobileInspection and closeMobileCreatePopover and deletes their
// window exports, so those two now resolve from the registry. That makes this
// file and dashboard-actions.js HARD-COUPLED — ship dashboard-actions.js without
// this helper and _NBD_MODAL_CLOSE_FNS, their only dispatch path, resolves
// nothing: the mobile inspection overlay and the m-create popover become
// impossible to close. tests/smoke/dashboard.test.js pins both halves.
function _nbdResolveMapped(fnName) {
  if (!fnName) return null;
  const reg = window.__NBD_CALL_REGISTRY;
  if (reg && typeof reg[fnName] === 'function') return reg[fnName];
  const fn = window[fnName];
  return typeof fn === 'function' ? fn : null;
}

function _nbdOnChangeDelegate(e, attrName) {
  const el = e.target && e.target.closest && e.target.closest('[' + attrName + ']');
  if (!el) return;
  const fn = _nbdResolveCall(el.getAttribute(attrName));
  if (!fn) return;
  const pass = el.getAttribute('data-on-pass') || 'value';
  let arg;
  switch (pass) {
    case 'checked': arg = el.checked; break;
    case 'value':   arg = el.value; break;
    case 'files0':  arg = el.files && el.files[0]; break;
    case 'int':     arg = parseInt(el.value, 10); break;
    case 'float':   arg = parseFloat(el.value); break;
    case 'element': arg = el; break;
    case 'event':   arg = e; break;
    default:        arg = el.value;
  }
  const args = [arg];
  const staticArg = el.getAttribute('data-on-arg');
  if (staticArg !== null) args.push(staticArg);
  fn(...args);
  const afterFn = _nbdResolveCall(el.getAttribute('data-on-after'));
  if (afterFn) afterFn();
}
document.addEventListener('change', function _nbdOnChangeHandler(e) {
  _nbdOnChangeDelegate(e, 'data-on-change');
});
document.addEventListener('input', function _nbdOnInputHandler(e) {
  _nbdOnChangeDelegate(e, 'data-on-input');
});

document.addEventListener('click', function _nbdActionDelegate(e) {
  const el = e.target && e.target.closest && e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'goTo') {
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    if (typeof goTo === 'function') goTo(target);
    return;
  }
  // C.4 cluster 2 — compound goTo patterns. Named actions for each
  // multi-statement onclick we couldn't cover with the generic goTo
  // branch above. Each handler covers a real cluster of buttons in
  // dashboard.html so converting the markup is mechanical.
  if (action === 'newEstimate') {
    e.preventDefault();
    if (typeof goTo === 'function') goTo('est');
    if (typeof startNewEstimate === 'function') startNewEstimate();
    return;
  }
  if (action === 'filterByStage') {
    e.preventDefault();
    const stage = el.dataset.stage;
    if (typeof goTo === 'function') goTo('crm');
    // The stage-filter call is wrapped in setTimeout so the kanban
    // has time to render before we filter (matches the original
    // inline handler's 200ms delay).
    setTimeout(function(){
      if (typeof window.filterByStage === 'function') window.filterByStage(stage);
    }, 200);
    return;
  }
  if (action === 'toolMenuGoTo') {
    // Pattern: tap a CRM-tools-menu item → goTo(target) + close the
    // menu so the next view paints over a clean header.
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    if (typeof goTo === 'function') goTo(target);
    if (typeof closeCrmToolsMenu === 'function') closeCrmToolsMenu();
    return;
  }
  // C.4 cluster 5 — arg-bearing toggles. Each named action wraps a
  // specific global function whose original onclick passed a string,
  // an event, or `this`. Same allowlist discipline as the no-arg
  // toggle action.
  if (action === 'navSection') {
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    if (typeof toggleNavSection === 'function') toggleNavSection(target);
    return;
  }
  if (action === 'mapSidebar') {
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    if (typeof toggleMapSidebar === 'function') toggleMapSidebar(target);
    return;
  }
  if (action === 'mapOverlay') {
    // Pattern: data-target="heat" → toggleOverlay('heat', el). The
    // second arg in the original inline form was `this` — the clicked
    // element — used to toggle an .active class on the button itself.
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    if (typeof toggleOverlay === 'function') toggleOverlay(target, el);
    return;
  }
  if (action === 'tradeChip') {
    e.preventDefault();
    if (window.toggleTradeChip && typeof window.toggleTradeChip === 'function') {
      window.toggleTradeChip(el);
    }
    return;
  }
  if (action === 'crmToolsMenu') {
    // Original inline was toggleCrmToolsMenu(event) — the function
    // uses event.stopPropagation() so it has to receive the real
    // event object.
    e.preventDefault();
    if (typeof toggleCrmToolsMenu === 'function') toggleCrmToolsMenu(e);
    return;
  }
  if (action === 'crmFiltersMenu') {
    // One-row toolbar (2026-07-06): the pipeline filter toggles live in
    // their own dropdown; same stopPropagation contract as crmToolsMenu.
    e.preventDefault();
    if (typeof toggleCrmFiltersMenu === 'function') toggleCrmFiltersMenu(e);
    return;
  }
  // C.4 cluster 4 — no-arg toggle handlers. Pattern: tap a button →
  // calls a global toggleXxx() with no arguments. Same allowlist
  // discipline as closeModal: data-target maps to a specific function
  // name in the registry. Markup with an unknown data-target is
  // silently ignored.
  if (action === 'toggle') {
    const target = el.dataset.target;
    if (!target) return;
    const fnName = _NBD_TOGGLE_FNS[target];
    if (!fnName) return;
    e.preventDefault();
    // Registry-first (Globals Tranche 3, 2026-09-01) — see _nbdResolveMapped.
    const fn = _nbdResolveMapped(fnName);
    if (fn) fn();
    // Keep the mobile Tools menu's active-state indicators in sync
    // whenever any filter toggles (whether tapped from the menu, the
    // inline button on desktop, or a keyboard shortcut). Cheap: a few
    // querySelectors. setTimeout(0) lets fn() finish updating its
    // source button's .active class before we mirror it.
    if (typeof window.syncMobileToolsMenuActive === 'function') {
      setTimeout(window.syncMobileToolsMenuActive, 0);
    }
    // If this toggle came from inside the mobile Tools (⋯) dropdown,
    // close the menu so the user immediately sees the filter result on
    // the kanban (saves one tap). The active-state mirror above
    // briefly previews ON before the menu closes — confirms the action.
    if (el.closest && el.closest('.crm-tools-menu')) {
      setTimeout(() => {
        if (typeof window.closeCrmToolsMenu === 'function') window.closeCrmToolsMenu();
        if (typeof window.closeCrmFiltersMenu === 'function') window.closeCrmFiltersMenu();
      }, 220);
    }
    return;
  }
  // C.4 kanban-view cluster — Insurance/Cash/Finance/Warranty/Service/
  // Jobs/All pipeline tabs on the CRM kanban. Original inline was
  // switchKanbanView('<view>'). Note: the original markup also carries
  // data-view="..." which other code reads; we leave that intact.
  if (action === 'kanbanView') {
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    if (typeof switchKanbanView === 'function') switchKanbanView(target);
    return;
  }
  // C.4 zone-color cluster — D2D zone color swatches. Original inline
  // was selectZoneColor(<css-var-or-hex>, this). Delegate passes the
  // string from data-target and the resolved element.
  // Globals Tranche 3 T3-0 (2026-08-31): selectZoneColor is module-scoped in
  // dashboard-actions.js now, so the old bare `typeof selectZoneColor` probe
  // would evaluate false and silently kill the swatches. Resolve it the same
  // way every other converted handler resolves — registry first.
  if (action === 'zoneColor') {
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    const zoneColorFn = _nbdResolveCall('selectZoneColor');
    if (zoneColorFn) zoneColorFn(target, el);
    return;
  }
  // C.4 pin-status cluster — D2D pin status buttons (not-home /
  // interested / not-interested / signed / callback / do-not-knock /
  // left-material / follow-up). Original inline was selectPin(<key>,
  // <color>, this) — both args travel through data-target / data-color.
  if (action === 'selectPin') {
    const target = el.dataset.target;
    const color = el.dataset.color;
    if (!target || !color) return;
    e.preventDefault();
    if (typeof selectPin === 'function') selectPin(target, color, el);
    return;
  }
  // C.4 line-type cluster — draw-tool color-coded line type pickers
  // (ridge / ridge vent / hip / valley / rake / eave / flashing /
  // step flash / drip edge / parapet / gutters). Original inline was
  // selLT(<index>, this) — index drives the active line type, the
  // element ref is used for the active-state toggle inside selLT.
  if (action === 'selLineType') {
    const target = el.dataset.target;
    if (target === undefined) return;
    const idx = parseInt(target, 10);
    if (Number.isNaN(idx)) return;
    e.preventDefault();
    if (typeof selLT === 'function') selLT(idx, el);
    return;
  }
  // C.4 settings-tab cluster — the Settings view header has 10 tab
  // buttons that each call switchSettingsTab(<key>). data-target carries
  // the tab key (profile/appearance/estimates/daily/company/team/
  // billing/notifications/access/help).
  if (action === 'settingsTab') {
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    if (typeof switchSettingsTab === 'function') switchSettingsTab(target);
    return;
  }
  // C.4 docgen cluster — every Templates view row called
  // NBDDocGen.fillAndGenerate(<template>). Single delegate branch
  // reads the template name from data-target and dispatches.
  if (action === 'docgen') {
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    // PR 2b: the docgen cluster is lazy. Load-then-run so a click inside the
    // Docs view works even if the rep clicked before the bundle finished
    // preloading (slow LTE in the field).
    const _fill = () => {
      if (window.NBDDocGen && typeof window.NBDDocGen.fillAndGenerate === 'function') {
        window.NBDDocGen.fillAndGenerate(target);
      } else if (typeof showToast === 'function') {
        showToast('Document generator is still loading — try again in a moment', 'warning');
      }
    };
    if (window.NBDDocGen && window.NBDDocGen.fillAndGenerate) { _fill(); }
    else if (window.ScriptLoader && window.ScriptLoader.loadBundle) { window.ScriptLoader.loadBundle('docgen').then(_fill); }
    else { _fill(); }
    return;
  }
  // C.4 mobile-nav cluster — bottom-nav items and the More-drawer
  // menu items both call mobileNav(target). The More-drawer entries
  // additionally call closeMobileMore() to dismiss the drawer; that
  // post-step is signalled by the presence of a data-close-more
  // attribute on the markup (its value is irrelevant, the attribute's
  // existence is the flag).
  if (action === 'mobileNav') {
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    // Globals Tranche 3 T3-A (2026-09-18): dispatch through window.mobileNav.
    // mobile-nav-customizer.js replaces it at init with a custom-tab-aware
    // version, and before the whole-file wrap that override is what this bare
    // call reached. Inside the IIFE the bare name would bind to the local
    // original instead, so the local is only the fallback.
    if (typeof window.mobileNav === 'function') window.mobileNav(target);
    else mobileNav(target);
    if (el.hasAttribute('data-close-more') && typeof closeMobileMore === 'function') {
      closeMobileMore();
    }
    return;
  }
  // C.4 photo-engine cluster — inline handlers in dynamically-rendered
  // photo previews, galleries, and lightboxes. Each branch corresponds
  // to a window.PhotoEngine entry point; the el.dataset values carry
  // the photo/lead identifiers the original inline calls inlined.
  if (action === 'peRemove') {
    // Generic "remove an element by id" — used by lightbox/preview
    // close buttons that don't have a registered close function (the
    // element is removed from the DOM entirely on close).
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    document.getElementById(target)?.remove();
    return;
  }
  if (action === 'peTagToggle') {
    // Self-toggle on the clicked pill — used by the Review & Tag
    // modal's QUICK_LOCATIONS / QUICK_DAMAGE / QUICK_TYPE button rows.
    e.preventDefault();
    el.classList.toggle('selected');
    return;
  }
  if (action === 'peBulkAnalyze') {
    e.preventDefault();
    const leadId = el.dataset.leadId;
    if (!leadId) return;
    if (window.PhotoEngine && typeof window.PhotoEngine._bulkAnalyze === 'function') {
      window.PhotoEngine._bulkAnalyze(leadId);
    }
    return;
  }
  if (action === 'peOpenLightbox') {
    e.preventDefault();
    const photoId = el.dataset.photoId;
    const leadId = el.dataset.leadId;
    if (!photoId || !leadId) return;
    if (window.PhotoEngine && typeof window.PhotoEngine._openLightbox === 'function') {
      window.PhotoEngine._openLightbox(photoId, leadId);
    }
    return;
  }
  if (action === 'peStagePhoto') {
    e.preventDefault();
    const photoId = el.dataset.photoId;
    const leadId = el.dataset.leadId;
    if (!photoId || !leadId) return;
    if (window.PhotoEngine && typeof window.PhotoEngine._stagePhoto === 'function') {
      window.PhotoEngine._stagePhoto(photoId, leadId);
    }
    return;
  }
  if (action === 'peDeletePhoto') {
    e.preventDefault();
    const photoId = el.dataset.photoId;
    if (!photoId) return;
    if (window.PhotoEngine && typeof window.PhotoEngine._deletePhoto === 'function') {
      window.PhotoEngine._deletePhoto(photoId);
    }
    return;
  }
  // C.4 finale — generic dispatchers that cover the long tail of
  // inline handlers. Each shape gets its own action so the markup
  // stays explicit + the allowlist limits which globals the delegate
  // can ever invoke.
  //
  // call         → registry-or-window[data-fn](...args) — args from
  //                data-arg/data-arg2; pass the resolved element if
  //                data-pass-el is set. Requires data-fn registered in
  //                __NBD_CALL_REGISTRY or on _NBD_CALL_ALLOWLIST
  //                (see _nbdResolveCall).
  // module       → window[Module]?.[method](...) defensive dispatch;
  //                falls back to a toast (data-fallback-toast).
  // windowOpen   → window.open(url, '_blank', 'noopener')
  // signOut      → window._signOut()
  // reload       → window.location.reload()
  // closeOpen    → getElementById(target).classList.remove('open')
  // clickProxy   → getElementById(target).click()  (file input triggers)
  // hideEl       → getElementById(target).style.display = 'none'
  // stopProp     → event.stopPropagation() (no preventDefault)
  if (action === 'call') {
    const fn = _nbdResolveCall(el.dataset.fn);
    if (!fn) return;
    e.preventDefault();
    const args = [];
    if (el.dataset.arg !== undefined) args.push(el.dataset.arg);
    if (el.dataset.arg2 !== undefined) args.push(el.dataset.arg2);
    if (el.hasAttribute('data-pass-el')) args.push(el);
    fn(...args);
    return;
  }
  if (action === 'module') {
    const target = el.dataset.target;
    if (!target || target.indexOf('.') === -1) return;
    const dot = target.indexOf('.');
    const moduleName = target.slice(0, dot);
    const method = target.slice(dot + 1);
    e.preventDefault();
    const mod = window[moduleName];
    if (mod && typeof mod[method] === 'function') {
      const args = [];
      if (el.dataset.arg !== undefined) args.push(el.dataset.arg);
      if (el.dataset.arg2 !== undefined) args.push(el.dataset.arg2);
      mod[method](...args);
    } else {
      const fallback = el.dataset.fallbackToast;
      if (fallback && typeof showToast === 'function') showToast(fallback, 'error');
    }
    return;
  }
  if (action === 'windowOpen') {
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    window.open(target, '_blank', 'noopener');
    return;
  }
  if (action === 'signOut') {
    e.preventDefault();
    if (typeof window._signOut === 'function') window._signOut();
    return;
  }
  if (action === 'reload') {
    e.preventDefault();
    window.location.reload();
    return;
  }
  if (action === 'closeOpen') {
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    document.getElementById(target)?.classList.remove('open');
    return;
  }
  if (action === 'clickProxy') {
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    document.getElementById(target)?.click();
    return;
  }
  if (action === 'hideEl') {
    const target = el.dataset.target;
    if (!target) return;
    e.preventDefault();
    const tgt = document.getElementById(target);
    if (tgt) tgt.style.display = 'none';
    return;
  }
  if (action === 'stopProp') {
    e.stopPropagation();
    return;
  }
  if (action === 'removeSelf') {
    e.preventDefault();
    el.remove();
    return;
  }
  if (action === 'removeParent') {
    e.preventDefault();
    el.parentElement?.remove();
    return;
  }
  if (action === 'removeClosest') {
    const sel = el.dataset.target;
    if (!sel) return;
    e.preventDefault();
    el.closest(sel)?.remove();
    return;
  }
  if (action === 'modalBackdropClose') {
    // Original onclick: if(event.target===this)closeXxxModal()
    // Click only triggers close if it landed on the backdrop itself,
    // not on a child element (the modal content). data-target carries
    // the close fn name; e.target must equal el.
    if (e.target !== el) return;
    const fnName = el.dataset.target;
    if (!fnName) return;
    // Unlike the toggle / closeModal branches, data-target here is the RAW
    // FUNCTION NAME straight out of the page, and this branch had no allowlist
    // gate at all — markup could name any global and the delegate would call
    // it. Gate it on the curated modal-close map, which is the same boundary
    // action='closeModal' already relies on, then resolve registry-first so a
    // converted handler keeps working. (Globals Tranche 3, 2026-09-01: found
    // while auditing the dispatch-map slice — this was a THIRD dispatcher over
    // the same closeXxx namespace and would have silently broken the moment
    // closeCardDetailModal, its only current caller, was converted.)
    if (typeof _NBD_MODAL_CLOSE_FNS === 'undefined'
      || Object.keys(_NBD_MODAL_CLOSE_FNS).every(k => _NBD_MODAL_CLOSE_FNS[k] !== fnName)) return;
    e.preventDefault();
    const fn = _nbdResolveMapped(fnName);
    if (fn) fn();
    return;
  }
  // C.4 cluster 3 — modal-close handlers. Every modal carries its own
  // closeXxxModal function (preserves cleanup logic — clear forms,
  // unbind handlers, etc.). The delegate maps a data-target value to
  // the right close function via an explicit allowlist so the markup
  // can't accidentally invoke an unrelated global.
  if (action === 'closeModal') {
    const target = el.dataset.target;
    if (!target) return;
    const fnName = _NBD_MODAL_CLOSE_FNS[target];
    if (!fnName) return;       // not on the allowlist; ignore
    e.preventDefault();
    // Registry-first (Globals Tranche 3, 2026-09-01) — see _nbdResolveMapped.
    const fn = _nbdResolveMapped(fnName);
    if (fn) fn();
    return;
  }
});

// Wave 28: Enter-key delegates — replaces 4 inline onkeydown handlers in
// dashboard.html (mapSearch/spyglassInput/drawSearch/joeInput) for CSP
// cleanliness. Two flavors:
//
//   data-enter-action="fnName"          → on Enter, call _nbdResolveCall(fnName)()
//                                          (registry-first, then allowlisted window)
//   data-enter-hide-ac="elementId"      → also call hideAcDrop(id) first
//
//   data-joe-input                      → textarea: Enter sends, auto-resize
(function(){
  if (window._NBD_ENTER_DELEGATE) return;
  window._NBD_ENTER_DELEGATE = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (!t || !t.dataset) return;
    if (t.dataset.enterAction) {
      // Registry-first, exactly like the click/change delegates — a name moved
      // off window into __NBD_CALL_REGISTRY (e.g. spyglassSearch, Globals Tranche
      // 2c-4h) must still resolve here, not silently no-op on Enter.
      const fn = _nbdResolveCall(t.dataset.enterAction);
      const acId = t.dataset.enterHideAc;
      if (acId && typeof window.hideAcDrop === 'function') {
        try { window.hideAcDrop(acId); } catch (_) {}
      }
      if (typeof fn === 'function') { try { fn(); } catch (_) {} }
    } else if (t.hasAttribute && t.hasAttribute('data-joe-input') && !e.shiftKey) {
      e.preventDefault();
      if (typeof window.sendJoeMessage === 'function') {
        try { window.sendJoeMessage(); } catch (_) {}
      }
    }
  });
  // Auto-grow the Joe textarea — mirrors the inline behavior that used
  // to live in the same onkeydown handler.
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-joe-input')) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 120) + 'px';
  });
})();

// ══════════════════════════════════════════════
// CAL.COM SCHEDULING FUNCTIONS
// ══════════════════════════════════════════════
// "https://cal.com/joe/roof-inspection", "cal.com/joe", "@joe" → {username, slug}.
// Pasting the booking link here used to build cal.com/https://cal.com/joe/…
function _parseCalInput(rawUser, rawSlug) {
  const parts = String(rawUser || '').trim()
    .replace(/^https?:\/\//i, '').replace(/^(www\.)?cal\.com\//i, '').replace(/^@+/, '')
    .split(/[?#]/)[0].split('/').filter(Boolean);
  return {
    username: (parts[0] || '').toLowerCase().slice(0, 60),
    eventSlug: String(rawSlug || '').trim().replace(/^\/+|\/+$/g, '') || parts[1] || '',
  };
}

function loadCalSettings() {
  try {
    // users/{uid}.calcomUsername (Settings → Cal.com) is the real setting —
    // the webhook routes bookings by it, and it survives sign-out, which wipes
    // this page's old nbd_cal_settings cache. Prefer it; the cache is legacy.
    const rep = window._currentRep || {};
    let saved = null;
    if (rep.calcomUsername) {
      saved = JSON.stringify({ username: rep.calcomUsername, eventSlug: rep.calcomEventSlug || 'roof-inspection' });
    } else {
      saved = localStorage.getItem('nbd_cal_settings');
    }
    if (saved) {
      const s = JSON.parse(saved);
      const uEl = document.getElementById('calUsername');
      const eEl = document.getElementById('calEventSlug');
      const urlEl = document.getElementById('calBookingUrl');
      if (uEl && s.username) uEl.value = s.username;
      if (eEl && s.eventSlug) eEl.value = s.eventSlug;
      if (urlEl && s.username && s.eventSlug) {
        urlEl.value = 'https://cal.com/' + s.username + '/' + s.eventSlug;
      }
      updateCalEmbed();
    }
  } catch (e) { /* first load, no settings yet */ }
}

const saveCalSettings = function() {
  const uEl = document.getElementById('calUsername');
  const eEl = document.getElementById('calEventSlug');
  const { username, eventSlug } = _parseCalInput(uEl?.value, eEl?.value);
  if (!username) { showToast('Enter your Cal.com username', 'error'); return; }
  if (!eventSlug) { showToast('Enter your event type slug', 'error'); return; }
  if (uEl) uEl.value = username;
  if (eEl) eEl.value = eventSlug;
  const settings = { username, eventSlug };
  try { localStorage.setItem('nbd_cal_settings', JSON.stringify(settings)); } catch (_) {}
  // Same field Settings → Cal.com writes, so the two stay one setting.
  try {
    if (window.db && window.doc && window.setDoc && window._user) {
      window.setDoc(window.doc(window.db, 'users', window._user.uid),
        { calcomUsername: username, calcomEventSlug: eventSlug }, { merge: true })
        .catch(() => showToast('Saved on this device only — couldn’t sync to your account', 'warning'));
    }
    window._currentRep = Object.assign({}, window._currentRep || {}, { calcomUsername: username, calcomEventSlug: eventSlug });
  } catch (_) {}
  const urlEl = document.getElementById('calBookingUrl');
  if (urlEl) urlEl.value = 'https://cal.com/' + username + '/' + eventSlug;
  updateCalEmbed();
  showToast('Cal.com settings saved');
}

const updateCalEmbed = function() {
  const username = (document.getElementById('calUsername')?.value || '').trim();
  const eventSlug = (document.getElementById('calEventSlug')?.value || '').trim();
  const embed = document.getElementById('calEmbed');
  const placeholder = document.getElementById('calPlaceholder');
  if (!username || !eventSlug) {
    // Collapse the box with its content. The 500px floor used to be inline in
    // the template, so an unconfigured calendar left 500px of nothing above
    // the "Set Up Your Calendar" card (phone audit 2026-09-25, pipeline#10).
    if (embed) { embed.innerHTML = ''; embed.style.minHeight = ''; }
    if (placeholder) placeholder.style.display = '';
    return;
  }
  if (placeholder) placeholder.style.display = 'none';
  if (embed) {
    // The iframe below is position:absolute;inset:0, so the box needs a real
    // height of its own to hold it.
    embed.style.minHeight = '500px';
    const src = 'https://cal.com/' + username + '/' + eventSlug + '?embed=true&theme=dark';
    // Brave Shields (and Firefox ETP strict) blocks cross-origin
    // iframes by injecting a same-origin "blocked" page INTO the
    // iframe. That fires `load` (not `error`), so onerror-based
    // fallbacks never trigger. Probe iframe.contentWindow.location
    // after load: SecurityError = real cross-origin success, any
    // returned value = browser-injected block page. Same pattern
    // as PR #499 for the portal preview modal.
    embed.style.position = 'relative';
    embed.innerHTML =
      '<iframe id="calIframe" src="' + src + '"' +
        ' style="position:absolute;inset:0;width:100%;height:100%;min-height:500px;border:none;border-radius:0 0 10px 10px;"' +
        ' loading="lazy"></iframe>' +
      '<div id="calEmbedOverlay" data-state="loading" style="' +
        'position:absolute;inset:0;' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'gap:14px;padding:24px;' +
        'background:var(--s2,#0f1419);color:var(--t,#e8eaf0);text-align:center;' +
        'font-family:\'Barlow\',-apple-system,system-ui,sans-serif;' +
        'border-radius:0 0 10px 10px;">' +
        '<div data-state-loading style="display:flex;flex-direction:column;align-items:center;gap:14px;">' +
          '<div style="width:36px;height:36px;border-radius:50%;' +
            'border:3px solid var(--br);border-top-color:var(--orange);' +
            'animation:nbdCalEmbedSpin 0.9s linear infinite;"></div>' +
          '<div style="font-size:13px;color:var(--m,#9aa3b2);">Loading calendar…</div>' +
        '</div>' +
        '<div data-state-blocked style="display:none;flex-direction:column;align-items:center;gap:14px;max-width:340px;">' +
          '<div style="font-size:32px;line-height:1;">🛡️</div>' +
          '<div style="font-size:14px;font-weight:700;">Your browser blocked the embedded calendar</div>' +
          '<div style="font-size:12px;color:var(--m,#9aa3b2);line-height:1.45;">' +
            'Privacy shields (Brave, Firefox strict mode) often block cross-origin embeds. ' +
            'Open the booking page in a new tab to see availability.' +
          '</div>' +
          '<a href="' + src + '" target="_blank" rel="noopener" style="' +
            'display:inline-flex;align-items:center;gap:6px;' +
            'padding:8px 14px;border-radius:7px;' +
            'background:var(--orange);color:var(--accent-fg,#fff);' +
            'text-decoration:none;font-size:12px;font-weight:700;' +
            'letter-spacing:.04em;text-transform:uppercase;' +
            '-webkit-tap-highlight-color:transparent;">Open in new tab ↗</a>' +
        '</div>' +
      '</div>' +
      '<style>@keyframes nbdCalEmbedSpin { to { transform: rotate(360deg); } }</style>';

    const iframe = document.getElementById('calIframe');
    const stateEl = document.getElementById('calEmbedOverlay');
    let resolved = false;
    function _showBlocked() {
      if (resolved) return;
      resolved = true;
      if (!stateEl) return;
      stateEl.setAttribute('data-state', 'blocked');
      const loadingPanel = stateEl.querySelector('[data-state-loading]');
      const blockedPanel = stateEl.querySelector('[data-state-blocked]');
      if (loadingPanel) loadingPanel.style.display = 'none';
      if (blockedPanel) blockedPanel.style.display = 'flex';
    }
    function _hideOverlay() {
      if (resolved) return;
      resolved = true;
      if (stateEl) stateEl.style.display = 'none';
    }
    if (iframe) {
      iframe.addEventListener('load', () => {
        try {
          // Cross-origin success throws here. Same-origin return =
          // browser injected a block page (Brave / Firefox ETP).
          const _probe = iframe.contentWindow.location.href; // eslint-disable-line no-unused-vars
          _showBlocked();
        } catch (_) {
          _hideOverlay();
        }
      });
      iframe.addEventListener('error', _showBlocked);
    }
    // Safety net for browsers that fully cancel the navigation
    // (no load + no error fired).
    setTimeout(_showBlocked, 3500);
  }
  const urlEl = document.getElementById('calBookingUrl');
  if (urlEl) urlEl.value = 'https://cal.com/' + username + '/' + eventSlug;
}

const copyCalLink = function() {
  const urlEl = document.getElementById('calBookingUrl');
  if (!urlEl) return;
  // Same guard as the Text/Email siblings below — with no Cal.com username
  // saved this copied an empty string and still said "Booking link copied!".
  if (!urlEl.value) { showToast('Set up your booking link first', 'error'); return; }
  navigator.clipboard.writeText(urlEl.value).then(() => showToast('Booking link copied!')).catch(() => {
    urlEl.select(); document.execCommand('copy'); showToast('Booking link copied!');
  });
}

const shareCalViaSMS = function() {
  const url = document.getElementById('calBookingUrl')?.value || '';
  if (!url) { showToast('Set up your booking link first', 'error'); return; }
  const msg = encodeURIComponent('Schedule your free roof inspection here: ' + url);
  window.open('sms:?body=' + msg);
}

// Sign-off resolves per tenant. This was hardcoded '- No Big Deal Exteriors',
// so a contractor emailing his own homeowner signed the message with the
// platform owner's company. Same gate shape as email_system.js _brandFields():
// NBD keeps its exact literal; a tenant gets their legalName, and a tenant who
// hasn't set one gets no sign-off rather than the owner's.
function _calSignOff() {
  let b = null;
  try { if (typeof window._brand === 'function') b = window._brand() || null; } catch (e) { b = null; }
  const isNbd = !b || !b.legalName || b.legalName === 'No Big Deal Home Solutions';
  if (isNbd) return '\n\n- No Big Deal Exteriors';
  return b.legalName ? '\n\n- ' + b.legalName : '';
}

const shareCalViaEmail = function() {
  const url = document.getElementById('calBookingUrl')?.value || '';
  if (!url) { showToast('Set up your booking link first', 'error'); return; }
  const subject = encodeURIComponent('Schedule Your Free Roof Inspection');
  const body = encodeURIComponent('Hi,\n\nYou can schedule your free roof inspection at a time that works for you:\n\n' + url + '\n\nLooking forward to helping you!' + _calSignOff());
  window.open('mailto:?subject=' + subject + '&body=' + body);
}

// ══════════════════════════════════════════════
// TOAST — owned by js/ui.js
// ══════════════════════════════════════════════
// This file used to declare its own showToast plus a #toast singleton queue.
// As a top-level classic-script declaration it shared ONE global binding with
// ui.js's showToast, and ui.js (deferred later in dashboard.html) won it, so
// every bare showToast(...) in this file already ran ui.js's container toasts.
// Inside the whole-file IIFE (Globals Tranche 3 T3-A, 2026-09-18) a local
// declaration would SHADOW the global for this file only and flip those calls
// back onto the legacy queue, so it was deleted instead. Bare showToast here
// resolves to the global: dashboard-ui-prefs-boot.js's fallback until ui.js
// runs, then ui.js's owner. dashboard-state.js's old toastQueue / toastActive
// state went unused and was deleted 2026-09-22. Do not re-declare showToast in
// this file.

// ══════════════════════════════════════════════
// DAMAGE PHOTOS — modal close + photo mode toggle
// ══════════════════════════════════════════════
const closePhotoModal = function(){if(window.nbdModal){window.nbdModal.close('photoModal');}else{document.getElementById('photoModal').classList.remove('open');}};
document.getElementById('photoModal').addEventListener('click',e=>{if(e.target===document.getElementById('photoModal'))closePhotoModal();});

// Photo search — filters the photo leads list by name/address
const filterPhotoLeads = function(query) {
  window._photoSearchQuery = (query || '').toLowerCase().trim();
  renderPhotoLeads();
}

function setPhotoMode(mode) {
  if (mode !== 'recent' && mode !== 'by-property') return;
  window._photoMode = mode;
  const byProp = document.getElementById('photoGalleryContainer');
  const recent = document.getElementById('photoRecentFeed');
  document.querySelectorAll('.ph-mode-btn').forEach(b => {
    const on = b.dataset.phMode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (mode === 'recent') {
    if (byProp) byProp.style.display = 'none';
    if (recent) recent.style.display = 'block';
    renderRecentPhotoFeed();
  } else {
    if (recent) recent.style.display = 'none';
    if (byProp) byProp.style.display = '';
  }
}
window.setPhotoMode = setPhotoMode;

// ══════════════════════════════════════════════
// TIPS modal
// ══════════════════════════════════════════════
function openTips(){if(window.nbdModal){window.nbdModal.open('tipsModal');}else{document.getElementById('tipsModal').classList.add('open');}}
const closeTips = function(){if(window.nbdModal){window.nbdModal.close('tipsModal');}else{document.getElementById('tipsModal').classList.remove('open');}};
document.getElementById('tipsModal').addEventListener('click',e=>{if(e.target===document.getElementById('tipsModal'))closeTips();});

// ══════════════════════════════════════════════
// PROPERTY INTEL — modal open/close + cost UI
// ══════════════════════════════════════════════
// The "selective pull" cluster (pullIntelForModal / updatePropertyIntelCost /
// confirmPropertyIntelPull / executePullPropertyIntel) was DUPLICATED here and in
// js/property-intel.js (byte-identical logic; property-intel.js loads last and
// already won on window). Globals Tranche 2c-4h Slice H2 part 2 removed the
// dashboard-ui.js copies — property-intel.js is the sole owner and registers them
// in __NBD_CALL_REGISTRY. The last two twins, closePropertyIntelModal /
// closePropertyIntelConfirmModal, followed in the Tranche 3 dispatch-map slice
// (2026-09-02): property-intel.js is now their sole owner too, as scoped consts
// registered there — property-intel.js's copies were already the on-window
// winners by load order, so deleting the copies here changed which text runs
// for NOTHING (byte-identical bodies) while closing the fallback that would
// have silently shadowed a registered name.

// ══════════════════════════════════════════════
// ADDRESS AUTOCOMPLETE — UI wiring
// ══════════════════════════════════════════════
function initAddressAutocomplete(inputId, onSelect) {
  const input = document.getElementById(inputId);
  const drop  = document.getElementById('ac-' + inputId);
  if(!input || !drop) return;
  // Once per input (2026-09-25). There are now two callers: the boot list in
  // initAllAutocomplete, and _wireViewAddressSearch when a view template is
  // cloned. If both ever reached the same live input, a second binding would
  // fetch every suggestion twice.
  if(input._nbdAcBound) return;
  input._nbdAcBound = true;

  input.addEventListener('input', () => {
    clearTimeout(_acTimers[inputId]);
    const q = input.value.trim();
    if(q.length < 3) { drop.style.display='none'; return; }
    _acTimers[inputId] = setTimeout(() => fetchAcSuggestions(inputId, q, onSelect), 320);
  });

  input.addEventListener('keydown', e => {
    if(drop.style.display==='none') return;
    const items = drop.querySelectorAll('.ac-item');
    let active = drop.querySelector('.ac-active');
    if(e.key==='ArrowDown') {
      e.preventDefault();
      const next = active ? active.nextElementSibling : items[0];
      if(next) { active?.classList.remove('ac-active'); next.classList.add('ac-active'); input.value=next.dataset.label; }
    } else if(e.key==='ArrowUp') {
      e.preventDefault();
      const prev = active?.previousElementSibling;
      if(prev) { active.classList.remove('ac-active'); prev.classList.add('ac-active'); input.value=prev.dataset.label; }
    } else if(e.key==='Enter') {
      if(active) { e.preventDefault(); active.click(); }
    } else if(e.key==='Escape') {
      drop.style.display='none';
    }
  });

  // Close on outside click
  document.addEventListener('click', e => {
    if(!input.contains(e.target) && !drop.contains(e.target)) drop.style.display='none';
  }, {capture:false});
}

function renderAcDrop(inputId, results, onSelect) {
  const input = document.getElementById(inputId);
  const drop  = document.getElementById('ac-' + inputId);
  if(!drop) return;

  if(!results.length) { drop.style.display='none'; return; }

  const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  drop.innerHTML = results.map((r,i) => {
    // Wave 141: render the proper USPS mailing address as the
    // primary line. Sub-line shows county (where applicable) — the
    // disambiguator the rep cares about when two streets share the
    // same name in different towns. Fallback to display_name slice
    // for offline / non-US edge cases.
    const formatted = (typeof formatMailingAddress === 'function')
      ? formatMailingAddress(r) : '';
    const main = formatted || String(r.display_name || '').split(',').slice(0,2).join(',').trim();
    const a = r.address || {};
    const sub = a.county ? a.county : String(r.display_name || '').split(',').slice(2,4).join(',').trim();
    return `<div class="ac-item nbd-ac-item" data-label="${esc(main)}" data-idx="${i}"><b>${esc(main)}</b>${sub ? `<br><span style="color:var(--m);font-size:10px;">${esc(sub)}</span>` : ''}</div>`;
  }).join('');
  drop.querySelectorAll('.nbd-ac-item').forEach(el => {
    el.addEventListener('mousedown', (event) => {
      event.preventDefault();
      selectAcItem(inputId, Number(el.dataset.idx));
    });
  });
  drop.style.display = 'block';
  drop._results = results;

  // Store results for selection
  if(!window._acResults) window._acResults = {};
  window._acResults[inputId] = results;
}

function _abbreviateRoadSuffix(road) {
  const s = String(road || '').trim();
  if (!s) return '';
  // Tokenize on whitespace; abbreviate only the LAST token if it
  // matches a known suffix. "Example Road" → "Example Rd";
  // "St James Court" → "St James Ct" (first "St" untouched, last
  // "Court" → "Ct"). Doesn't touch directional suffixes (N/S/E/W).
  const tokens = s.split(/\s+/);
  if (tokens.length < 2) return s;
  const last = tokens[tokens.length - 1].toLowerCase().replace(/[.,]/g, '');
  if (_USPS_SUFFIX[last]) {
    tokens[tokens.length - 1] = _USPS_SUFFIX[last];
  }
  return tokens.join(' ');
}

function _state2letter(state, addrObj) {
  // Prefer Nominatim's ISO3166-2-lvl4 field (e.g. "US-OH") if present —
  // it's always 2 chars and never ambiguous.
  const iso = addrObj && addrObj['ISO3166-2-lvl4'];
  if (typeof iso === 'string' && /^US-[A-Z]{2}$/.test(iso)) {
    return iso.slice(3);
  }
  const s = String(state || '').trim().toLowerCase();
  if (_STATE_2L[s]) return _STATE_2L[s];
  // If it's already 2 chars, accept it (some Nominatim responses
  // already return abbreviated state).
  if (/^[A-Z]{2}$/.test(state)) return state;
  return state || '';
}

/**
 * Wave 141: format a Nominatim search result into a USPS-compliant
 * single-line mailing address.
 *
 *   formatMailingAddress({ display_name, address: { house_number,
 *     road, city, town, village, state, "ISO3166-2-lvl4", postcode } })
 *   → "456 Example Rd, Goshen, OH 45122"
 *
 * Falls back to a tidied display_name slice when structured fields
 * are missing (offline / non-US results / nominatim variants).
 */
function formatMailingAddress(r) {
  if (!r) return '';
  const a = r.address || {};
  const houseNum = a.house_number || '';
  const road = _abbreviateRoadSuffix(a.road || a.street || a.pedestrian || a.path || '');
  const city = a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || '';
  const stateCode = _state2letter(a.state, a);
  const zip = a.postcode || '';

  const street = [houseNum, road].filter(Boolean).join(' ').trim();
  const cityState = [
    city,
    [stateCode, zip].filter(Boolean).join(' ').trim(),
  ].filter(Boolean).join(', ').trim();

  if (street && cityState) return street + ', ' + cityState;
  if (street) return street;
  if (cityState) return cityState;

  // Last-resort fallback: clean up display_name. Strip ", United
  // States" and the county field (which Nominatim usually places
  // between city and state).
  let dn = String(r.display_name || '').trim();
  dn = dn.replace(/,\s*United States\s*$/i, '');
  // Drop any "X County" segment.
  dn = dn.replace(/,\s*[A-Z][a-z]+ County\s*,/g, ',');
  // Collapse multi-comma sequences.
  dn = dn.replace(/\s*,\s*,\s*/g, ', ').trim();
  return dn;
}
window.formatMailingAddress = formatMailingAddress;

function selectAcItem(inputId, idx) {
  const input = document.getElementById(inputId);
  const drop  = document.getElementById('ac-' + inputId);
  const results = window._acResults?.[inputId] || [];
  const r = results[idx];
  if(!r || !input) return;

  // Wave 141: produce a proper USPS-style mailing address using the
  // structured nominatim addressdetails — house_number + road
  // (suffix-abbreviated) + city + 2-letter state + ZIP. Replaces the
  // old `display_name.split(',').slice(0,3)` which produced
  // "456, Example Road, Goshen" (wrong on every count: comma
  // after house number, full road name instead of "Rd", missing
  // ZIP, state spelled out, county included).
  const label = formatMailingAddress(r) || r.display_name || '';
  input.value = label;
  drop.style.display = 'none';

  // Run the onSelect callback if provided
  const cb = window._acCallbacks?.[inputId];
  if(cb) cb(r, label);
}

function hideAcDrop(inputId) {
  const drop = document.getElementById('ac-' + inputId);
  if(drop) drop.style.display = 'none';
}

// Address search on a lazily-cloned view (Draw audit H9, 2026-09-25).
// initAllAutocomplete() below binds its inputs ONCE, at boot. #drawSearch
// lives inside <template id="tpl-view-draw">, which is only cloned into
// #view-draw when the rep first opens the Drawing Tool, so at boot there was
// no input to bind and initAddressAutocomplete returned early. No suggestion
// ever appeared on the Draw view, on any device: the audit typed 38
// characters and #ac-drawSearch never showed. _hydrateViewTemplate calls this
// on the one clone that creates the input.
//
// mapSearch and pinAddrInput (tpl-view-map) and estAddr (tpl-view-est) are
// also in the boot list and also templated. They are not bound here on
// purpose: this change covers the Draw view only, and picking a mapSearch
// suggestion starts a property-intel lookup that needs its own review.
function _wireViewAddressSearch(name, view) {
  if (name !== 'draw') return;
  initAddressAutocomplete('drawSearch');
  // Go, and the phone keyboard's Go key (an Enter keydown in the box), close
  // ☰ Tools. A picked suggestion does the same, via its _acCallbacks entry.
  // Both listeners are on the elements themselves: the document-level
  // delegates that run searchDraw fire after them, and they only read the
  // box's value.
  const go = view.querySelector('[data-fn="searchDraw"]');
  if (go) go.addEventListener('click', _closeDrawToolsAfterSearch);
  const input = view.querySelector('#drawSearch');
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') _closeDrawToolsAfterSearch(); });
}

// Close the phone ☰ Tools drawer once the rep has searched an address.
// Before, the map flew to the house while the drawer stayed open over it,
// with the address box and the keyboard still up, and the rep had to find
// "✕ Close". This runs only when the drawer is open. On desktop the sidebar
// is a fixed column, its toggle is display:none, and .open is never set, so
// a desktop search is unchanged. An empty box is skipped because searchDraw
// ignores it too.
function _closeDrawToolsAfterSearch() {
  const input = document.getElementById('drawSearch');
  const sidebar = document.getElementById('map-sidebar-draw');
  if (!input || !input.value.trim() || !sidebar || !sidebar.classList.contains('open')) return;
  // Without this, a suggestion fetch still waiting on its 320ms debounce
  // would reopen the list inside the closed drawer.
  clearTimeout(_acTimers.drawSearch);
  hideAcDrop('drawSearch');
  // Dismiss the keyboard. Otherwise it stays up over the map for a box that
  // is no longer on screen.
  input.blur();
  // Close it the same way tapping "✕ Close" does. That resets the button
  // label and remeasures Leaflet once the drawer's .3s close has finished.
  // invalidateSize keeps the centre, so the house stays in the middle.
  toggleMapSidebar('map-sidebar-draw');
}

function initAllAutocomplete() {
  if(!window._acCallbacks) window._acCallbacks = {};

  // mapSearch — on select, trigger full map search.
  // propCard/propCardInner live inside tpl-view-map; only present in
  // the DOM once #/map is hydrated. Guard so any pre-hydration call
  // (autocomplete fires before user navigates) doesn't null-deref.
  window._acCallbacks['mapSearch'] = (r, label) => {
    window._lastMapSearch = r;
    if(mainMap) mainMap.setView([parseFloat(r.lat), parseFloat(r.lon)], 19);
    const propCard = document.getElementById('propCard');
    const propCardInner = document.getElementById('propCardInner');
    if (propCard && propCardInner) {
      propCard.style.display = 'block';
      propCardInner.innerHTML = `
        <div class="pi-card">
          <div class="pi-header"><span class="pi-title">🏠 Property Intel</span><span class="pi-county"></span></div>
          <div class="pi-loading"><div class="pi-spinner"></div>Estimating property profile...</div>
        </div>
        <button class="make-lead-btn" data-du-action="makeLeadFromSearch">＋ Make This a Lead</button>`;
      fetchPropertyIntel(r, 'propCardInner');
    }
  };

  // pinAddrInput — just fill, no side effect
  window._acCallbacks['pinAddrInput'] = null;

  // drawSearch — on select, move draw map
  // typeof-guarded (2026-09-14, boot-weight containment): maps-routing.js
  // (where `let drawMap` lives, a bare sibling-scope global — see that
  // file's header) now loads lazily via the `drawtool` bundle, only once
  // the user visits #/draw. This callback registers unconditionally at
  // boot like the mapSearch one above it, so a bare `drawMap` read would
  // throw ReferenceError on any session that fires drawSearch before ever
  // opening the draw view.
  window._acCallbacks['drawSearch'] = (r) => {
    if(typeof drawMap !== 'undefined' && drawMap) drawMap.setView([parseFloat(r.lat), parseFloat(r.lon)], 19);
    // A picked suggestion is a search too: close the phone ☰ Tools drawer
    // over the map it just moved (H9, 2026-09-25). This does nothing when the
    // drawer is shut, and nothing on desktop.
    _closeDrawToolsAfterSearch();
  };

  // estAddr — just fill
  window._acCallbacks['estAddr'] = null;

  // lAddr — just fill
  window._acCallbacks['lAddr'] = null;

  initAddressAutocomplete('mapSearch');
  initAddressAutocomplete('pinAddrInput');
  initAddressAutocomplete('drawSearch');
  initAddressAutocomplete('estAddr');
  initAddressAutocomplete('qaAddr');
  initAddressAutocomplete('lAddr');
}

// Boot autocomplete after DOM ready
if(document.readyState==='loading') {
  document.addEventListener('DOMContentLoaded', initAllAutocomplete);
} else {
  initAllAutocomplete();
}

// HAV + MID — moved to docs/pro/js/maps.js (hoisted at top of file, also exposed on window)
// Canonical definitions now live there; this dashboard.html copy was deleted to prevent drift.

// ══════════════════════════════════════════════
// DOCUMENT LIBRARY — templates + UI
// ══════════════════════════════════════════════
const DOC_TEMPLATES = {
  contract: {
    title: 'Roofing Contract',
    content: `<h2>ROOFING CONTRACT</h2>
<p><strong>Contractor:</strong> {{COMPANY}} · <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> · {{COMPANY_PHONE}}</p>
<p><strong>Homeowner:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>Property Address:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>Scope of Work:</strong> Complete roof replacement including tear-off, decking inspection, synthetic underlayment, architectural shingles (GAF Timberline series), ridge cap, flashing, pipe boots, drip edge, and full cleanup.</p>
<p><strong>Materials:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> Color: <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>Contract Price:</strong> $<span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> &nbsp;&nbsp; <strong>Start Date:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>NBD Guarantee:</strong> NBD Pledge: for as long as you own the home, we'll come back and make it right. Written workmanship (labor) warranty by package — Standard 5 years (non-transferable), Preferred 10 years (transferable to 1 subsequent owner within 30 days of sale), Elite 20 years (fully transferable + annual courtesy inspection + signed certificate). Manufacturer warranty per product/package, provided by the manufacturer.</p>
<p><strong>Payment Terms:</strong> {{PAYMENT_TERMS}}</p>
<p>By signing below, homeowner authorizes {{COMPANY}} to perform the above work.</p>
<p><strong>Homeowner Signature:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> Date: <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>Contractor Signature:</strong> {{REP_NAME}} <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> Date: <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>`
  },
  warranty: {
    title: 'NBD Warranty Certificate',
    content: `<div style="text-align:center;padding:20px 0 10px;">
<div style="font-family:'Barlow Condensed',sans-serif;font-size:32px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;">No Big <span style="color:var(--orange);">Deal</span> Home Solutions</div>
<div style="font-size:11px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--orange);border:1px solid var(--orange);padding:3px 12px;border-radius:2px;display:inline-block;margin:6px 0;">Roofing · Siding · Gutters · Greater Cincinnati</div>
</div>
<div style="text-align:center;padding:24px 0 16px;border-top:3px solid var(--orange);border-bottom:1px solid #eee;margin-bottom:24px;">
<div style="font-size:9px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#999;margin-bottom:6px;">Certificate of Guarantee</div>
<div style="font-family:'Barlow Condensed',sans-serif;font-size:28px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#111;">NBD Labor Guarantee</div>
</div>
<p>This certificate confirms that the installation performed by <strong>{{COMPANY}}</strong> at the property listed below is covered by the NBD Labor Guarantee as described herein.</p>
<h2>Property &amp; Installation</h2>
<div class="doc-row-2">
  <div class="doc-field-row"><span class="doc-field-label">Property Address</span><span class="doc-field-line"></span></div>
  <div class="doc-field-row"><span class="doc-field-label">Homeowner</span><span class="doc-field-line"></span></div>
  <div class="doc-field-row"><span class="doc-field-label">Installation Date</span><span class="doc-field-line short"></span></div>
  <div class="doc-field-row"><span class="doc-field-label">Guarantee Tier</span><span class="doc-field-line short"></span></div>
</div>
<h2>Guarantee Terms</h2>
<div class="doc-check-grid">
  <div class="doc-check-item"><span class="doc-checkbox"></span>Economy — 1-year written labor warranty (non-transferable)</div>
  <div class="doc-check-item"><span class="doc-checkbox"></span>Standard — 5-year written labor warranty (non-transferable)</div>
  <div class="doc-check-item"><span class="doc-checkbox"></span>Preferred — 10-year written labor warranty (transferable to 1 subsequent owner within 30 days of sale)</div>
  <div class="doc-check-item"><span class="doc-checkbox"></span>Elite — 20-year written labor warranty (fully transferable + annual courtesy inspection)</div>
</div>
<p style="font-size:12px;color:#555;margin-top:12px;line-height:1.7;">NBD Pledge: for as long as you own the home, we'll come back and make it right. In writing, {{COMPANY}} guarantees all labor performed under this installation against defects in workmanship for the term of the tier checked above, beginning on the installation date. This guarantee covers labor costs to repair or correct any installation defect at no charge to the homeowner. It does not cover damage caused by acts of nature, improper maintenance, or alterations made by others. Manufacturer shingle warranty is separate and provided by the manufacturer directly.</p>
<h2>Transferability</h2>
<p style="font-size:12px;color:#555;line-height:1.7;">Preferred and Elite guarantees are transferable as noted above. To transfer, notify {{COMPANY}} in writing within 30 days of property sale. A transfer fee of $0 applies. New owner receives the remaining written workmanship coverage in writing.</p>
<div class="doc-sig-block">
  <div class="doc-sig-row">
    <div class="doc-sig-field"><div class="doc-field-line"></div><div class="doc-sig-label">Homeowner Signature &amp; Date</div></div>
    <div class="doc-sig-field"><div class="doc-field-line"></div><div class="doc-sig-label">{{REP_NAME}} — {{COMPANY}}</div></div>
  </div>
  <div style="text-align:center;font-size:10px;color:#aaa;margin-top:16px;">Certificate #: NBD-<span class="doc-field-line short" style="display:inline-block;width:80px;"></span> · Keep this document with your home records</div>
</div>`
  },
  supplement: {
    title: 'Supplement Request',
    content: `<h2>INSURANCE SUPPLEMENT REQUEST</h2>
<p><strong>Contractor:</strong> {{COMPANY}} | License # ________ | {{COMPANY_PHONE}}</p>
<p><strong>Claim #:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> &nbsp;&nbsp; <strong>Policy #:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>Insured:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> &nbsp;&nbsp; <strong>Property:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>Carrier:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> &nbsp;&nbsp; <strong>Adjuster:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>Supplement Items:</strong></p>
<p>1. Pipe boots (replace all) — $______ ea × ______ = $______</p>
<p>2. Drip edge (not included in initial estimate) — ______ LF @ $______ = $______</p>
<p>3. Ice & water shield (valleys) — ______ SQ @ $______ = $______</p>
<p>4. Decking replacement (damaged boards) — ______ SF @ $______ = $______</p>
<p>5. Ridge vent — ______ LF @ $______ = $______</p>
<p>6. Permit fee — $______</p>
<p>7. Dumpster/haul-away — $______</p>
<p><strong>Total Supplement:</strong> $______</p>
<p>Supporting documentation and photos attached.</p>`
  },
  scope: {
    title: 'Scope of Work',
    content: `<h2>SCOPE OF WORK</h2>
<p><strong>Property:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>ROOF REPLACEMENT — Full scope includes:</strong></p>
<p>☐ Complete tear-off of existing roofing material down to deck</p>
<p>☐ Inspect roof deck — replace damaged/rotted sections as needed</p>
<p>☐ Install synthetic underlayment (30 lb equivalent)</p>
<p>☐ Install ice & water shield in valleys and eave edges</p>
<p>☐ Install new drip edge (color to match)</p>
<p>☐ Install starter strip at eaves and rakes</p>
<p>☐ Install architectural shingles — Brand: ______ Color: ______</p>
<p>☐ Install hip and ridge cap shingles</p>
<p>☐ Replace all pipe boots and collars</p>
<p>☐ Re-flash chimney / skylights / walls as needed</p>
<p>☐ Install ridge vent (if applicable)</p>
<p>☐ Full cleanup — magnetic nail sweep, debris haul-away</p>
<p>☐ Final inspection with homeowner walk-through</p>
<p><strong>Measurements:</strong> ______ squares | Pitch: ______ | Estimated start: ______</p>`
  },
  authorization: {
    title: 'Work Authorization',
    content: `<h2>WORK AUTHORIZATION FORM</h2>
<p>I, <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>, owner of the property located at:</p>
<p><span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p>hereby authorize <strong>{{COMPANY}}</strong> to perform the following work:</p>
<p><span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p>I authorize {{COMPANY}} to negotiate with my insurance company on my behalf and to receive payment directly from the insurance carrier for covered work.</p>
<p><strong>Homeowner Signature:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>Date:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> &nbsp;&nbsp; <strong>Phone:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>`
  },
  inspection: {
    title: 'Inspection Checklist',
    content: `<h2>ROOF & EXTERIOR INSPECTION CHECKLIST</h2>
<p><strong>Property:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> Date: <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>ROOF:</strong></p>
<p>☐ Hail damage to shingles &nbsp; ☐ Wind damage / missing shingles &nbsp; ☐ Granule loss</p>
<p>☐ Ridge cap damage &nbsp; ☐ Hip cap damage &nbsp; ☐ Valley damage</p>
<p>☐ Flashing damage &nbsp; ☐ Pipe boot damage &nbsp; ☐ Skylights &nbsp; ☐ Chimney flashing</p>
<p>☐ Drip edge bent/damaged &nbsp; ☐ Fascia damage &nbsp; ☐ Soffit damage</p>
<p><strong>SIDING:</strong></p>
<p>☐ Hail spatter/cracks &nbsp; ☐ Dents (vinyl) &nbsp; ☐ Holes / punctures &nbsp; ☐ Missing panels</p>
<p><strong>GUTTERS:</strong></p>
<p>☐ Hail dents &nbsp; ☐ Bent sections &nbsp; ☐ Downspout damage &nbsp; ☐ Pulled away from fascia</p>
<p><strong>SOFT METALS (AC unit, window trim, mailbox, etc.):</strong></p>
<p>☐ AC condenser top &nbsp; ☐ Window trim/capping &nbsp; ☐ Door trim &nbsp; ☐ Other: ______</p>
<p><strong>Estimated Damage:</strong> ☐ Roof ☐ Siding ☐ Gutters ☐ Full Exterior</p>
<p><strong>Claim Recommended:</strong> ☐ Yes &nbsp; ☐ No — Below deductible &nbsp; ☐ Repair only</p>
<p><strong>Inspector:</strong> {{REP_NAME}} &nbsp;&nbsp; <strong>Signature:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>`
  },
  completion: {
    title: 'Certificate of Completion',
    content: `<h2>CERTIFICATE OF COMPLETION</h2>
<p>This certifies that <strong>{{COMPANY}}</strong> has completed the following work:</p>
<p><strong>Property:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>Work Completed:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>Completion Date:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> &nbsp;&nbsp; <strong>Invoice #:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>Total Contract Amount:</strong> $<span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>Warranty:</strong> NBD Pledge + written labor warranty per package — effective date of installation. <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p>All work has been completed per the agreed scope of work and to the homeowner's satisfaction.</p>
<p><strong>Homeowner Signature:</strong> <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> Date: <span class="field-line">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span></p>
<p><strong>Contractor:</strong> {{REP_NAME}} — {{COMPANY}} — {{COMPANY_PHONE}}</p>`
  }
};

// ═══ TEMPLATE LIBRARY — toggle / filter ═══
const tlToggleCat = function(headerEl){
  const cat = headerEl.closest('.tl-category');
  if(cat) cat.classList.toggle('tl-collapsed');
}
const tlFilterCat = function(catKey, btnEl){
  // Update active button
  document.querySelectorAll('.tl-filter-btn').forEach(b=>b.classList.remove('tl-filter-active'));
  if(btnEl) btnEl.classList.add('tl-filter-active');
  // Show/hide categories
  document.querySelectorAll('.tl-category').forEach(c=>{
    if(catKey==='all'){
      c.style.display='';
      c.classList.remove('tl-collapsed');
    } else {
      if(c.dataset.cat===catKey){
        c.style.display='';
        c.classList.remove('tl-collapsed');
      } else {
        c.style.display='none';
      }
    }
  });
}

// Resolve the current logged-in rep's display name for printable templates.
// Falls back to email, then a generic label, so the doc is still meaningful
// if auth hasn't settled yet.
function _nbdRepName(){
  try {
    const a = window.auth && window.auth.currentUser;
    if (a && (a.displayName || a.email)) return a.displayName || a.email;
    const u = window._user;
    if (u && (u.displayName || u.email)) return u.displayName || u.email;
  } catch(e){}
  // Generic, not "Authorized NBD Representative" — this is the fallback a
  // TENANT's blank form falls back to when auth hasn't settled.
  return 'Authorized Representative';
}

// Company identity for the printable blank forms below. These templates had
// "No Big Deal Home Solutions" and the owner's phone hardcoded into WORK
// AUTHORIZATIONS, warranty certificates and certificates of completion — the
// paper a rep prints and has a homeowner sign at the door. One of them reads
// "I authorize {company} to negotiate with my insurance company on my behalf
// and to receive payment directly from the insurance carrier": a tenant's
// customer was signing that in the platform owner's favour.
//
// Same isNbd gate as elsewhere; NBD's own forms render byte-identical.
function _nbdDocCompany(){
  let b = null;
  try { if (typeof window._brand === 'function') b = window._brand() || null; } catch(e){ b = null; }
  const isNbd = !b || !b.legalName || b.legalName === 'No Big Deal Home Solutions';
  if (isNbd) return { name: 'No Big Deal Home Solutions', phone: '(859) 420-7382' };
  const c = (b && b.contact) || {};
  // Never `|| NBD-literal` — an unset tenant field must render blank (the
  // forms already carry a ruled line for handwriting it in), not the owner's.
  return { name: b.legalName || b.displayName || '', phone: c.phone || '' };
}

function openDocTemplate(key){
  const t = DOC_TEMPLATES[key];
  if(!t) return;
  const repName = _nbdRepName();
  const co = _nbdDocCompany();
  document.getElementById('docViewerTitle').textContent = t.title;
  // Blank contract's payment terms (2026-09-25): the deposit rule's own
  // statement (deposit-rule.js) — this form printed "50% due at material
  // delivery", a sixth deposit answer that matched none of the others.
  const _dr = window.NBDDepositRule;
  const payTerms = (_dr && typeof _dr.policyText === 'function') ? _dr.policyText() : '';
  // Company legal name / phone and the rep's name are typed by people, not
  // constants — escaped like the terms (security audit 2026-09-29).
  const _escT = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  document.getElementById('docViewerContent').innerHTML = t.content
    .split('{{REP_NAME}}').join(_escT(repName))
    .split('{{COMPANY_PHONE}}').join(_escT(co.phone))
    .split('{{PAYMENT_TERMS}}').join(_escT(payTerms))
    .split('{{COMPANY}}').join(_escT(co.name));
  if(window.nbdModal){window.nbdModal.open('docViewerModal');}else{document.getElementById('docViewerModal').classList.add('open');}
}
const closeDocViewer = function(){ if(window.nbdModal){window.nbdModal.close('docViewerModal');}else{document.getElementById('docViewerModal').classList.remove('open');} };
const printDoc = function(){ window.print(); };
const openUploadDoc = function(){
  // docUploadArea lives inside tpl-view-docs (lazy-hydrated). Guard
  // for routes that haven't visited #/docs yet.
  const el = document.getElementById('docUploadArea');
  if (el) el.style.display = 'block';
};

// ── Inject "Blank" buttons on every template row ──
// Runs once after DOM is ready. Each .tl-doc-row that calls
// NBDDocGen.fillAndGenerate('type') gets a small "Blank" button
// inserted before the arrow. Clicking it calls generateBlank()
// instead, producing a printable empty copy.
(function injectBlankButtons() {
  document.querySelectorAll('.tl-doc-row').forEach(function(row) {
    var onclick = row.getAttribute('onclick') || '';
    var match = onclick.match(/fillAndGenerate\(['"]([^'"]+)['"]\)/);
    if (!match) return;
    var type = match[1];
    var btn = document.createElement('button');
    btn.textContent = 'Blank';
    btn.title = 'Print a blank copy to fill by hand';
    btn.style.cssText = 'background:var(--s2);border:1px solid var(--br);color:var(--m);padding:4px 10px;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:background var(--t-fast),color var(--t-fast),border-color var(--t-fast);';
    btn.addEventListener('mouseenter', function() { btn.style.borderColor = 'var(--orange)'; btn.style.color = 'var(--orange)'; });
    btn.addEventListener('mouseleave', function() { btn.style.borderColor = 'var(--br)'; btn.style.color = 'var(--m)'; });
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      // PR 2b: the docgen cluster is lazy — load-then-run on first use.
      var _blank = function() {
        if (window.NBDDocGen && typeof window.NBDDocGen.generateBlank === 'function') {
          window.NBDDocGen.generateBlank(type);
        } else if (typeof showToast === 'function') {
          showToast('Doc generator is still loading — try again in a moment', 'warning');
        }
      };
      if (window.NBDDocGen && window.NBDDocGen.generateBlank) { _blank(); }
      else if (window.ScriptLoader && window.ScriptLoader.loadBundle) { window.ScriptLoader.loadBundle('docgen').then(_blank); }
      else { _blank(); }
    });
    // Insert before the arrow
    var arrow = row.querySelector('.tl-doc-arrow');
    if (arrow) row.insertBefore(btn, arrow);
    else row.appendChild(btn);
  });
})();
function closeUploadDoc(){
  const el = document.getElementById('docUploadArea');
  if (el) el.style.display = 'none';
}
const handleDocUpload = function(inp){ _docFile = inp.files[0]; showToast('File selected: '+(_docFile?.name||''),'ok'); };

// ══════════════════════════════════════════════
// THEME SYSTEM — apply/load + auto-theme
// ══════════════════════════════════════════════
function applyTheme(key, save=true) {
  // Delegate to ThemeEngine if loaded (supports 155 themes with overlays, sounds, etc.)
  if(window.ThemeEngine) {
    window.ThemeEngine.apply(key, save);
    // Also update legacy UI elements
    document.querySelectorAll('.theme-card').forEach(c => {
      c.classList.toggle('active', c.dataset.key === key);
    });
    window._currentTheme = key;
    return;
  }
  // Legacy fallback for themes defined in CSS
  if(!THEME_KEYS.includes(key)) key = DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', key);
  document.querySelectorAll('.theme-card').forEach(c => {
    c.classList.toggle('active', c.dataset.key === key);
  });
  // Write-through to the canonical key too (PR #557 F-1) so that when the modern
  // engine later loads (here or on another surface) it reads this choice instead
  // of a stale nbd_pro_theme and silently reverting it.
  try { localStorage.setItem('nbd-theme', key); localStorage.setItem('nbd_pro_theme', key); } catch(e){}
  if(save && window._user && window._db) {
    try {
      const { doc, setDoc } = window._firestoreOps || {};
      if(setDoc) setDoc(doc(window._db,'userSettings',window._user.uid), {theme:key}, {merge:true}).catch(()=>{});
    } catch(e){}
  }
  window._currentTheme = key;
}

function loadSavedTheme() {
  // Canonical key first (nbd_pro_theme), then the legacy mirror (nbd-theme) — audit F-1.
  let saved = null;
  try { saved = localStorage.getItem('nbd_pro_theme') || localStorage.getItem('nbd-theme'); } catch(e){}
  // When the modern engine is present it validates ids against its 186-theme
  // registry and self-heals from Firestore in init(); hand it the saved id
  // directly rather than rejecting engine-only ids via the CSS-only THEME_KEYS
  // list (which would bounce them to default and cause a flash). save=false so
  // a restored locked theme is never gated on the boot path.
  if (window.ThemeEngine) { applyTheme(saved || DEFAULT_THEME, false); return; }
  if(saved && THEME_KEYS.includes(saved)) { applyTheme(saved, false); return; }
  // Fallback to Firebase pref (async)
  applyTheme(DEFAULT_THEME, false);
}

// ── KANBAN DENSITY + HIERARCHY ─────────────────────────────────────────────
function setKanbanDensity(d) {
  if (!['compact', 'comfortable', 'spacious'].includes(d)) d = 'comfortable';
  // 'comfortable' is the CSS default; clear the attribute so we don't carry stale values.
  if (d === 'comfortable') document.documentElement.removeAttribute('data-density');
  else document.documentElement.setAttribute('data-density', d);
  try { localStorage.setItem(KANBAN_DENSITY_KEY, d); } catch (e) {}
  // Reflect active state in the picker buttons.
  document.querySelectorAll('.kdens-btn').forEach(b => {
    const active = b.dataset.density === d;
    b.classList.toggle('is-on', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  _syncDensityToggleLabel(d);
}

// The Tools menu's Card density item names the current size in its own
// label and tooltip. It used to announce each step in a toast. Since Tools
// stays open while a rep steps through the sizes (2026-09-25 phone nav
// polish), that toast landed on the button itself at 412x860 (toast y
// 670-720, button 651-700), so the next tap hit the toast, which counts as
// a tap outside the menu, and closed Tools instead of stepping. The label is
// where the rep is already looking.
const _DENSITY_NAMES = { compact: 'Compact', comfortable: 'Comfortable', spacious: 'Spacious' };
function _syncDensityToggleLabel(d) {
  const btn = document.getElementById('kanbanDensityToggleBtn');
  if (!btn) return;
  if (!_DENSITY_NAMES[d]) {
    try { d = localStorage.getItem(KANBAN_DENSITY_KEY) || 'comfortable'; } catch (_) { d = 'comfortable'; }
    if (!_DENSITY_NAMES[d]) d = 'comfortable';
  }
  const next = { compact: 'comfortable', comfortable: 'spacious', spacious: 'compact' }[d];
  btn.title = 'Card density: ' + _DENSITY_NAMES[d] + ' — tap for ' + _DENSITY_NAMES[next];
  const lbl = btn.querySelector('.crm-hdr-btn-label');
  if (lbl) lbl.textContent = 'Card density: ' + _DENSITY_NAMES[d];
}

// Sweep R3 (C): one-tap cycle invoked by the kanban-header
// density toggle. Reads the current value from localStorage so the
// cycle starts from wherever the user left off, even if the
// data-density attribute got cleared (Comfortable = no attribute).
// setKanbanDensity updates the button's label + tooltip to the new size.
const cycleKanbanDensity = function() {
  const order = ['compact', 'comfortable', 'spacious'];
  let cur = 'comfortable';
  try { cur = localStorage.getItem(KANBAN_DENSITY_KEY) || 'comfortable'; } catch (_) {}
  if (!order.includes(cur)) cur = 'comfortable';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  setKanbanDensity(next);
}

function setKanbanBoldHierarchy(on) {
  if (on) document.documentElement.setAttribute('data-bold', 'true');
  else document.documentElement.removeAttribute('data-bold');
  try { localStorage.setItem(KANBAN_BOLD_KEY, on ? '1' : '0'); } catch (e) {}
}

// Prime the settings-panel kanban controls (density button active state +
// bold / auto-collapse checkboxes) from localStorage and apply the saved
// density to <html>. The controls live inside the lazy-hydrated
// tpl-view-settings template, so the DCL+200ms call below only reaches
// them on a direct #/settings load; on every later Settings open,
// ui.js switchSettingsTab('profile') re-runs this after the template
// mounts (NEW-D45c — same hydration-timing family as the #597 fixes).
function syncKanbanPrefControls() {
  const d = localStorage.getItem(KANBAN_DENSITY_KEY) || 'comfortable';
  setKanbanDensity(d);
  const bold = localStorage.getItem(KANBAN_BOLD_KEY) === '1';
  const t = document.getElementById('kanbanBoldToggle');
  if (t) t.checked = bold;
  // Sync auto-collapse toggle from localStorage (default off).
  const ac = localStorage.getItem('nbd-crm-autocollapse') === '1';
  const acT = document.getElementById('crmAutoCollapseToggle');
  if (acT) acT.checked = ac;
}
window._syncKanbanPrefControls = syncKanbanPrefControls;
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(syncKanbanPrefControls, 200);
});
window.setKanbanDensity = setKanbanDensity;
window.setKanbanBoldHierarchy = setKanbanBoldHierarchy;

// ══════════════════════════════════════════════════════════════════
// Wave 101: Comfort tab handlers — quick-access density / text size /
// motion / professional-mode controls in the 🎨 picker. Each setting
// persists to localStorage and applies to <html>/<body> attributes
// that CSS reads to drive the actual look.
// ══════════════════════════════════════════════════════════════════
function nbdComfortSet(kind, value) {
  const html = document.documentElement;
  const body = document.body;
  try {
    if (kind === 'density') {
      // Reuse the existing setKanbanDensity machinery so the deep-
      // settings density toggle stays in sync.
      if (typeof setKanbanDensity === 'function') setKanbanDensity(value);
    } else if (kind === 'size') {
      // 'medium' is the default — clear the attribute so we don't
      // carry stale values through theme changes.
      if (value === 'medium') html.removeAttribute('data-text-size');
      else html.setAttribute('data-text-size', value);
      try { localStorage.setItem('nbd_text_size', value); } catch (_) {}
    } else if (kind === 'motion') {
      if (value === 'reduce') html.setAttribute('data-motion', 'reduce');
      else html.removeAttribute('data-motion');
      try {
        if (value === 'reduce') localStorage.setItem('nbd_motion', 'reduce');
        else localStorage.removeItem('nbd_motion');
      } catch (_) {}
    } else if (kind === 'proMode') {
      if (value === '1') body.classList.add('professional-mode');
      else body.classList.remove('professional-mode');
      try {
        if (value === '1') localStorage.setItem('nbd_professional_mode', '1');
        else localStorage.removeItem('nbd_professional_mode');
      } catch (_) {}
    } else if (kind === 'cbSafe') {
      // W106: color-blind-safe palette
      if (value === '1') html.setAttribute('data-cb-safe', '1');
      else html.removeAttribute('data-cb-safe');
      try {
        if (value === '1') localStorage.setItem('nbd_cb_safe', '1');
        else localStorage.removeItem('nbd_cb_safe');
      } catch (_) {}
    } else if (kind === 'autoTheme') {
      // W107: auto theme switching. When ON, schedules a check
      // every minute that switches the active theme based on
      // local hour. Daytime (7am–7pm) uses 'paper' (light); rest
      // uses the rep's preferred dark theme (defaults to
      // 'nbd-original'). Rep can still pick a different theme
      // manually mid-day; auto only kicks in on the next
      // boundary.
      try {
        if (value === '1') localStorage.setItem('nbd_auto_theme', '1');
        else localStorage.removeItem('nbd_auto_theme');
      } catch (_) {}
      if (value === '1') nbdAutoThemeStart();
      else nbdAutoThemeStop();
    }
  } catch (_) { /* best effort */ }
  nbdComfortRefresh();
}
window.nbdComfortSet = nbdComfortSet;

// Wave 131: hold-to-talk hotkey toggle + key picker. Stored on
// localStorage via the NBDWhisper public API so the FAB tooltip,
// the hotkey listener, and this tab all share state.
const nbdComfortSetWhisperHotkey = function(enabled) {
  if (window.NBDWhisper && window.NBDWhisper.setHotkeyEnabled) {
    window.NBDWhisper.setHotkeyEnabled(!!enabled);
  } else {
    // NBDWhisper not loaded yet — just stash the flag for it to pick up.
    try {
      if (enabled) localStorage.removeItem('nbd_whisper_hotkey_disabled');
      else localStorage.setItem('nbd_whisper_hotkey_disabled', '1');
    } catch (_) {}
  }
  // Reveal/hide the key picker.
  const cfg = document.getElementById('npm-whisper-hotkey-config');
  if (cfg) cfg.style.display = enabled ? 'block' : 'none';
}

const nbdComfortSetWhisperKey = function(keyName) {
  if (window.NBDWhisper && window.NBDWhisper.setHotkey) {
    window.NBDWhisper.setHotkey(keyName);
  } else {
    try { localStorage.setItem('nbd_whisper_hotkey', keyName); } catch (_) {}
  }
}

// Reflect current state in the comfort tab's buttons + toggles
// so opening the picker shows the right active item.
function nbdComfortRefresh() {
  const html = document.documentElement;
  const body = document.body;
  const density = html.getAttribute('data-density') || 'comfortable';
  const size = html.getAttribute('data-text-size') || 'medium';
  const motion = html.getAttribute('data-motion') === 'reduce';
  const proMode = body.classList.contains('professional-mode');

  document.querySelectorAll('.npm-comfort-btn').forEach(b => {
    const kind = b.getAttribute('data-comfort');
    const val = b.getAttribute('data-value');
    let active = false;
    if (kind === 'density') active = (val === density);
    else if (kind === 'size') active = (val === size);
    // Active look lives in ui-primitives.css (.ui-seg.is-on) so skins own it.
    b.classList.toggle('is-on', active);
    b.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  const motionEl = document.getElementById('npm-reduce-motion');
  if (motionEl) motionEl.checked = motion;
  const proEl = document.getElementById('npm-pro-mode');
  if (proEl) proEl.checked = proMode;
  // W106: reflect color-blind-safe state
  const cbSafe = html.getAttribute('data-cb-safe') === '1';
  const cbEl = document.getElementById('npm-cb-safe');
  if (cbEl) cbEl.checked = cbSafe;
  // W107: reflect auto-theme state
  const autoTheme = (function(){ try { return localStorage.getItem('nbd_auto_theme') === '1'; } catch (_) { return false; } })();
  const autoEl = document.getElementById('npm-auto-theme');
  if (autoEl) autoEl.checked = autoTheme;
  // W131: reflect hold-to-talk hotkey state + chosen key.
  const whisperEnabled = (function(){
    try { return localStorage.getItem('nbd_whisper_hotkey_disabled') !== '1'; }
    catch (_) { return true; }
  })();
  const whisperKey = (function(){
    try { return localStorage.getItem('nbd_whisper_hotkey') || 'F2'; }
    catch (_) { return 'F2'; }
  })();
  const whisperToggle = document.getElementById('npm-whisper-hotkey');
  const whisperCfg = document.getElementById('npm-whisper-hotkey-config');
  const whisperKeyEl = document.getElementById('npm-whisper-hotkey-key');
  if (whisperToggle) whisperToggle.checked = whisperEnabled;
  if (whisperCfg) whisperCfg.style.display = whisperEnabled ? 'block' : 'none';
  if (whisperKeyEl) whisperKeyEl.value = whisperKey;
}

// ══════════════════════════════════════════════════════════════════
// Wave 107: time-of-day auto-theme switching.
// 7 AM – 7 PM local → light theme (paper); rest → dark theme
// (rep's last manually-chosen dark theme, or 'nbd-original'). The
// switch fires on enable + every minute. When the rep picks a
// theme manually, we remember which "side" of the day it falls on
// so future auto-switches respect their preference per side.
// ══════════════════════════════════════════════════════════════════
function nbdAutoThemeIsDay() {
  const h = new Date().getHours();
  return h >= 7 && h < 19;
}

function nbdAutoThemePreferredFor(side) {
  // side = 'day' or 'night'
  try {
    const saved = localStorage.getItem('nbd_auto_theme_' + side);
    if (saved) return saved;
  } catch (_) {}
  return side === 'day' ? 'paper' : 'nbd-original';
}

function nbdAutoThemeApplyForNow() {
  if (!window.ThemeEngine) return;
  const isDay = nbdAutoThemeIsDay();
  const want = nbdAutoThemePreferredFor(isDay ? 'day' : 'night');
  const cur = window.ThemeEngine.getCurrent && window.ThemeEngine.getCurrent();
  if (cur === want) return;
  try { window.ThemeEngine.apply(want, true); } catch (_) {}
}

function nbdAutoThemeStart() {
  nbdAutoThemeStop();
  nbdAutoThemeApplyForNow();
  _nbdAutoThemeInterval = setInterval(nbdAutoThemeApplyForNow, 60_000);
}
function nbdAutoThemeStop() {
  if (_nbdAutoThemeInterval) {
    clearInterval(_nbdAutoThemeInterval);
    _nbdAutoThemeInterval = null;
  }
}

// Listen for manual theme changes — when rep picks a theme by
// hand, remember it for the current side of the day so future
// auto-switches honor their dark / light preference.
// Bug fix: event name was 'nbd:theme-change' but theme-engine.js
// dispatches 'themechange' (no namespace prefix) at line 4541. The
// listener was silently dead — manual theme picks never got
// remembered for the auto-theme day/night system. Listening for
// both names so we work with any future dispatcher rename too.
function _nbdRememberManualTheme(ev) {
  try {
    const themeKey = (ev && ev.detail && (ev.detail.themeKey || ev.detail)) ||
                     (window.ThemeEngine && window.ThemeEngine.getCurrent && window.ThemeEngine.getCurrent());
    if (!themeKey || typeof themeKey !== 'string') return;
    if (localStorage.getItem('nbd_auto_theme') !== '1') return;
    const side = nbdAutoThemeIsDay() ? 'day' : 'night';
    localStorage.setItem('nbd_auto_theme_' + side, themeKey);
  } catch (_) {}
}
document.addEventListener('themechange', _nbdRememberManualTheme);
window.addEventListener('nbd:theme-change', _nbdRememberManualTheme);

window.nbdAutoThemeStart = nbdAutoThemeStart;
window.nbdAutoThemeStop = nbdAutoThemeStop;
window.nbdAutoThemeApplyForNow = nbdAutoThemeApplyForNow;

// Boot auto-theme on page load if user enabled it.
(function bootAutoTheme() {
  try {
    if (localStorage.getItem('nbd_auto_theme') === '1') {
      // Wait for ThemeEngine to be ready.
      const tryStart = () => {
        if (window.ThemeEngine) nbdAutoThemeStart();
        else setTimeout(tryStart, 200);
      };
      setTimeout(tryStart, 500);
    }
  } catch (_) {}
})();
window.nbdComfortRefresh = nbdComfortRefresh;

// Sync the comfort tab when the picker opens.
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(nbdComfortRefresh, 250);
});

// ══════════════════════════════════════════════════════════════════
// PIPELINE PAGE-BREATHE — sidebar collapse, fullscreen, Tools menu,
// FAB visibility, scroll-collapse, ESC handling.
// One self-contained block so future changes touch one place.
// ══════════════════════════════════════════════════════════════════
const toggleSidebarCollapse = function () {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (e) {}
  // Sync the button's `active` state
  const btn = document.getElementById('sidebarToggleBtn');
  if (btn) btn.classList.toggle('active', collapsed);
  // Keep the Settings "Show tool names" checkbox in sync (inverse of collapsed)
  const lblCb = document.getElementById('sidebarLabelsToggle');
  if (lblCb) lblCb.checked = !collapsed;
  // Leaflet maps need an invalidate-size after the rail width changes
  // so they don't render with the old viewport dimensions. `window.mainMap`
  // and `window.d2dMap` are never set (mainMap/drawMap are classic-script
  // top-level lets; the D2D map lives in the tracker's private state), so the
  // old reads were permanent no-ops. Bare typeof-guarded names — the idiom at
  // the other invalidate site below — plus one window 'resize' event, which
  // every Leaflet map (trackResize defaults on) answers with its own
  // invalidateSize, covering the D2D map without reaching into its state.
  setTimeout(() => {
    if (typeof mainMap !== 'undefined' && mainMap?.invalidateSize) mainMap.invalidateSize();
    if (typeof drawMap !== 'undefined' && drawMap?.invalidateSize) drawMap.invalidateSize();
    window.dispatchEvent(new Event('resize'));
  }, 200);
};

const toggleKanbanFullscreen = function () {
  const fullscreen = document.body.classList.toggle('kanban-fullscreen');
  // Sync the icon button's active state when present
  const btn = document.getElementById('kanbanFullscreenBtn');
  if (btn) btn.classList.toggle('active', fullscreen);
};
// The bootPageBreathe Esc listener (further down this file) bare-calls
// toggleKanbanFullscreen from inside its own IIFE. That IIFE is nested in
// this file's whole-file IIFE, where this const is declared, so the bare name
// resolves lexically with no global-object hop and Esc-to-exit keeps working
// with the name off window.

// Keep an open pipeline header dropdown on screen (2026-09-25 phone audit).
// Both menus are anchored right:0 under their button, which is right for the
// desktop row (it sits at the header's right edge) but not for a phone, where
// the row is left-aligned and the Filters menu hung 130px off the left edge.
// Nudge `right` so the menu sits 8px inside the viewport, and cap its height
// at the space left above the fixed phone nav bar (#mobile-nav, z 1900, which
// would otherwise cover the last items) so a short screen scrolls the menu
// instead of cutting off Find duplicates / Card density.
function _placeCrmMenu(menu) {
  const PAD = 8;
  menu.style.right = '';
  menu.style.maxHeight = '';
  const vw = document.documentElement.clientWidth;
  let bottom = window.innerHeight;
  const nav = document.getElementById('mobile-nav');
  if (nav) {
    const nr = nav.getBoundingClientRect();
    if (nr.height > 0 && nr.top > 0 && nr.top < bottom) bottom = nr.top;
  }
  const r = menu.getBoundingClientRect();
  let shift = 0;
  if (r.left < PAD) shift = PAD - r.left;
  else if (r.right > vw - PAD) shift = (vw - PAD) - r.right;
  if (shift) menu.style.right = (-shift) + 'px';
  menu.style.maxHeight = Math.max(120, Math.floor(bottom - r.top - PAD)) + 'px';
}

// Header dropdowns — Tools (⋯, the collapsed secondary toolbar) and Filters
// (one-row toolbar, 2026-07-06). One lifecycle for both (2026-09-25 phone
// audit follow-ups). The two used to carry near-copies of this code, and
// the copies had drifted:
//   - A second tap on ⋯ did not close Tools. Its outside-tap check compared
//     e.target.id with 'crmToolsBtn', but a tap on the button lands on its
//     <svg> child, so the check closed the menu and the button's own toggle
//     reopened it. Filters already used closest(). Both share one check now.
//   - The outside-tap closer listened for `click` only. WebKit (Jo's iPhone
//     app) sends no click for a tap on plain page (the header title, blank
//     board), only pointerdown/touchstart, so on the iPhone a tap beside an
//     open menu left it open. pointerdown fires on every engine; click
//     stays for keyboard activation.
//   - Each open added a document capture listener that only an OUTSIDE tap
//     removed, so every close from the button leaked one. Now one set of
//     listeners is armed while a menu is open and every close path here
//     removes it.
//   - A menu was placed only when it opened. After a rotate or resize it
//     kept the portrait `right` offset and height cap, and it hung off the
//     screen and under the nav bar. It is re-placed now.
// An item that ACTS (a view jump, Prospects, Deleted leads, Export CSV …)
// closes its menu too. The menu now paints above the FAB stack
// (kanban-force.css, --z-overlay), so a menu left open behind the Deleted
// leads drawer (z 1500) would paint over the drawer. Filter toggles keep
// the delegate's own 220ms preview-then-close. An item marked
// data-menu-stay opens nothing and is meant to be tapped again in place,
// so it leaves the menu open: Card density cycles Compact → Comfortable →
// Spacious, and closing after every step made a rep reopen Tools to reach
// the next one (2026-09-25 phone nav polish).
const _CRM_MENU_BTN = { crmToolsMenu: 'crmToolsBtn', crmFiltersMenu: 'crmFiltersBtn' };
let _crmMenuArmed = null; // { menu, onAway, onActed, onResize, raf } while a menu is open

function _crmMenuDisarm() {
  const a = _crmMenuArmed;
  if (!a) return;
  _crmMenuArmed = null;
  document.removeEventListener('pointerdown', a.onAway, true);
  document.removeEventListener('click', a.onAway, true);
  document.removeEventListener('click', a.onActed);
  window.removeEventListener('resize', a.onResize);
  window.removeEventListener('orientationchange', a.onResize);
  if (window.visualViewport) window.visualViewport.removeEventListener('resize', a.onResize);
  if (a.raf) cancelAnimationFrame(a.raf);
}

function _crmMenuArm(menu) {
  _crmMenuDisarm();
  const btnSel = '#' + _CRM_MENU_BTN[menu.id];
  const a = { menu, raf: 0 };
  a.onAway = (e) => {
    const t = e.target;
    // Closed by a path outside this lifecycle (openDupReview removes .open
    // itself): just stop listening.
    if (!menu.classList.contains('open')) { _crmMenuDisarm(); return; }
    // closest(), never t.id: the tap lands on the button's <svg>/<span>.
    // The button's own click toggles the menu shut.
    if (t && t.closest && t.closest(btnSel)) return;
    if (menu.contains(t)) return;
    _closeCrmMenus();
  };
  // An item that acts closes its menu. This is a bubble listener on document
  // added after load, so it runs after the action delegate (registered at
  // load), and the action still sees its menu open. The close stays in the
  // tap's own task. A setTimeout(0) was tried first, and in Chromium it had
  // sometimes not run by the time the Deleted leads drawer finished sliding
  // in (about 1 run in 3).
  a.onActed = (e) => {
    const t = e.target;
    const item = t && t.closest && t.closest('[data-action]');
    if (item && menu.contains(item) && item.dataset.action !== 'toggle'
        && !item.hasAttribute('data-menu-stay')) _closeCrmMenus();
  };
  a.onResize = () => {
    if (a.raf) return;
    a.raf = requestAnimationFrame(() => {
      a.raf = 0;
      if (_crmMenuArmed !== a) return;
      const btn = document.querySelector(btnSel);
      // The anchor button left the layout, so there is nothing to hang
      // the menu from.
      if (!btn || !btn.getClientRects().length) { _closeCrmMenus(); return; }
      _placeCrmMenu(menu);
    });
  };
  _crmMenuArmed = a;
  document.addEventListener('pointerdown', a.onAway, true);
  document.addEventListener('click', a.onAway, true);
  document.addEventListener('click', a.onActed);
  window.addEventListener('resize', a.onResize);
  window.addEventListener('orientationchange', a.onResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', a.onResize);
}

function _toggleCrmMenu(id, ev) {
  const menu = document.getElementById(id);
  if (!menu) return;
  const opening = !menu.classList.contains('open');
  // The two menus close each other, so only one is ever open.
  _closeCrmMenus();
  if (opening) {
    menu.classList.add('open');
    _placeCrmMenu(menu);
    // Reflect current filter active-state into the menu items (Needs
    // Attention / Stale Shares / etc.) before the user sees it. The
    // action-delegate also re-syncs on every toggle so the indicator
    // stays correct while the menu is open.
    if (typeof window.syncMobileToolsMenuActive === 'function') {
      window.syncMobileToolsMenuActive();
    }
    // The CRM template hydrates after the boot-time density sync, so name
    // the current size here, before the rep sees the item.
    if (id === 'crmToolsMenu') _syncDensityToggleLabel();
    _crmMenuArm(menu);
  }
  if (ev) ev.stopPropagation();
}
function _closeCrmMenu(id) {
  document.getElementById(id)?.classList.remove('open');
  if (_crmMenuArmed && _crmMenuArmed.menu.id === id) _crmMenuDisarm();
}
function _closeCrmMenus() {
  _closeCrmMenu('crmToolsMenu');
  _closeCrmMenu('crmFiltersMenu');
}

function toggleCrmToolsMenu(ev) { _toggleCrmMenu('crmToolsMenu', ev); }
function closeCrmToolsMenu() { _closeCrmMenu('crmToolsMenu'); }
window.toggleCrmToolsMenu = toggleCrmToolsMenu;
window.closeCrmToolsMenu = closeCrmToolsMenu;

function toggleCrmFiltersMenu(ev) { _toggleCrmMenu('crmFiltersMenu', ev); }
function closeCrmFiltersMenu() { _closeCrmMenu('crmFiltersMenu'); }
window.toggleCrmFiltersMenu = toggleCrmFiltersMenu;
window.closeCrmFiltersMenu = closeCrmFiltersMenu;

// Global header mobile kebab — collapses theme/settings/guide buttons
// into a single dropdown on ≤768px. Kept separate from the pipeline menus
// above so the two can be open independently if a user resizes mid-session.
//
// Same lifecycle as the pipeline menus (2026-09-25 phone nav polish). The
// kebab still had the old shape those menus were fixed away from:
//   - Its outside-tap closer listened for `click` only. WebKit (Jo's iPhone
//     app) sends no click for a tap on plain page such as the pipeline
//     title, so on the iPhone a tap beside the open kebab left it open.
//     pointerdown fires on every engine; click stays for keyboard use.
//   - Each open added a document capture listener that only an OUTSIDE tap
//     removed, so every close from the button, and every close by an item,
//     leaked one. Now one set is armed while the kebab is open and every
//     close path removes it.
//   - Tapping an item (Theme & Font, Settings, Theme Guide) left the kebab
//     open over the screen it had just opened. An item that acts closes it,
//     as in the pipeline menus.
let _hdrMenuArmed = null; // { onAway, onActed } while the kebab is open

function _hdrMenuDisarm() {
  const a = _hdrMenuArmed;
  if (!a) return;
  _hdrMenuArmed = null;
  document.removeEventListener('pointerdown', a.onAway, true);
  document.removeEventListener('click', a.onAway, true);
  document.removeEventListener('click', a.onActed);
}

// Armed from inside the opening click's own dispatch (the action delegate is
// a bubble listener on document), so neither listener sees that click: the
// document's capture phase has already passed, and a listener added to the
// target being dispatched is not called for the current event.
function _hdrMenuArm(menu) {
  _hdrMenuDisarm();
  const a = {};
  a.onAway = (e) => {
    const t = e.target;
    // Closed by a path outside this lifecycle: just stop listening.
    if (!menu.classList.contains('open')) { _hdrMenuDisarm(); return; }
    // closest(), never t.id: a finger lands on the button's <svg>. The
    // button's own click toggles the kebab shut.
    if (t && t.closest && t.closest('#hdrMobileBtn')) return;
    if (menu.contains(t)) return;
    closeHdrMobileMenu();
  };
  // Bubble listener added after load, so it runs after the action delegate
  // and the item's action still sees the kebab open.
  a.onActed = (e) => {
    const t = e.target;
    const item = t && t.closest && t.closest('[data-action]');
    if (item && menu.contains(item)) closeHdrMobileMenu();
  };
  _hdrMenuArmed = a;
  document.addEventListener('pointerdown', a.onAway, true);
  document.addEventListener('click', a.onAway, true);
  document.addEventListener('click', a.onActed);
}

const toggleHdrMobileMenu = function (ev) {
  const menu = document.getElementById('hdrMobileMenu');
  const btn  = document.getElementById('hdrMobileBtn');
  if (!menu) return;
  const isOpen = menu.classList.toggle('open');
  if (btn) btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  if (isOpen) _hdrMenuArm(menu);
  else _hdrMenuDisarm();
  if (ev && ev.stopPropagation) ev.stopPropagation();
};
function closeHdrMobileMenu() {
  document.getElementById('hdrMobileMenu')?.classList.remove('open');
  document.getElementById('hdrMobileBtn')?.setAttribute('aria-expanded', 'false');
  _hdrMenuDisarm();
}

// Mobile Tools menu — mirror filter active-state from the (hidden-on-mobile)
// inline source buttons into the dropdown menu items. PR #508 hid the inline
// Needs Attention / Stale Shares / Snoozed / Hot first / Bulk buttons on
// mobile and gave the user the same toggles inside the Tools (⋯) dropdown
// — but the menu items themselves had no visual hint that a filter was ON,
// so reps couldn't tell their state without scrolling the kanban to see the
// filter effect. Each filter module sets .active on its source inline button;
// we mirror that bit into the corresponding menu item.
const _MOBILE_TOOLS_FILTER_MAP = {
  needsAttention: 'needsAttentionBtn',
  staleShares:    'staleSharesBtn',
  showSnoozed:    'snoozedToggleBtn',
  engagementSort: 'engagementSortBtn',
  bulkMode:       'bulkModeBtn',
};
function syncMobileToolsMenuActive() {
  // Legacy mirror — a no-op since the one-row toolbar removed the
  // .crm-tools-menu-mobile duplicate cluster (the REAL filter buttons
  // now live inside #crmFiltersMenu and carry .active themselves); kept
  // null-guarded in case a page still ships the old markup.
  Object.entries(_MOBILE_TOOLS_FILTER_MAP).forEach(([target, srcId]) => {
    const src  = document.getElementById(srcId);
    const item = document.querySelector('.crm-tools-menu-mobile [data-target="' + target + '"]');
    if (!src || !item) return;
    item.classList.toggle('active', src.classList.contains('active'));
  });
  // One-row toolbar (2026-07-06): the Filters button shows how many
  // filter/sort toggles are ON so a collapsed filter can't silently
  // hide leads. Called on every toggle (delegate) + on menu open.
  // Each filter module stamps .active on its own button SYNCHRONOUSLY
  // inside its update fn (added 2026-07-06 — none of them ever set it
  // before, which is why the old mobile menu's active mirrors never lit
  // up). The class is therefore the cheap shared truth to count here.
  const filterIds = ['needsAttentionBtn', 'noNextStepBtn', 'staleSharesBtn', 'snoozedToggleBtn', 'engagementSortBtn'];
  const n = filterIds.filter((id) => {
    const b = document.getElementById(id);
    return b && b.classList.contains('active');
  }).length;
  const badge = document.getElementById('crmFiltersActiveBadge');
  if (badge) {
    badge.textContent = String(n);
    badge.style.display = n ? '' : 'none';
  }
  const fbtn = document.getElementById('crmFiltersBtn');
  if (fbtn) fbtn.classList.toggle('active', n > 0);
}
window.syncMobileToolsMenuActive = syncMobileToolsMenuActive;

// FAB visibility — show only on the CRM view. Hooks goTo() so we don't
// have to touch every nav site.
//
// Boot-order fix (2026-07-06): this file executes BEFORE
// dashboard-actions.js (dashboard.html loads them adjacent, both defer,
// ui first) — so window.goTo does NOT exist yet when this IIFE runs.
// The old `if (typeof goTo !== 'function') return;` guard silently
// disabled the entire FAB from the day the decomposition split the
// files: the pipeline lost its add-lead button and nobody saw an error.
// Now we poll briefly for goTo and install the wrap when it appears;
// updateFab also runs standalone so the class is right even pre-install.
(function setupAddLeadFab() {
  const updateFab = () => {
    const onCrm = document.getElementById('view-crm')?.classList.contains('active');
    document.body.classList.toggle('show-add-lead-fab', !!onCrm);
    // Field-tools cluster (⋯ launcher + W128 mic / W130 quick-capture /
    // W132 inbox): CRM + D2D only (Jo's call — a rep dictates the note
    // right after a knock, so the tools have to be reachable on the
    // door-knocking view too). Everywhere else the fixed bottom-right
    // stack stays hidden so it can't float over the Photos card buttons.
    // kanban-force.css keys the launcher + tool FABs off show-field-tools;
    // dashboard-app.css gives #d2dContent launcher-sized bottom clearance
    // so the D2D value/streak cards can always scroll clear of it.
    const onMap = document.getElementById('view-map')?.classList.contains('active');
    document.body.classList.toggle('show-field-tools', !!(onCrm || onMap));
  };
  const install = () => {
    const _origGoTo = window.goTo;
    if (typeof _origGoTo !== 'function') return false;
    // Re-evaluate after every navigation
    window.goTo = function() {
      const r = _origGoTo.apply(this, arguments);
      setTimeout(updateFab, 50);
      return r;
    };
    updateFab();
    return true;
  };
  if (!install()) {
    let _tries = 0;
    const _t = setInterval(() => {
      // 100 × 100ms = 10s ceiling — goTo appears within ms in practice
      // (dashboard-actions.js is the very next script tag).
      if (install() || ++_tries >= 100) clearInterval(_t);
    }, 100);
  }
  document.addEventListener('DOMContentLoaded', updateFab);
})();

// Scroll-collapse — OPT-IN behavior (was on by default; users found the
// header twitching during scroll/drag distracting). Now gated on the
// `nbd-crm-autocollapse` localStorage flag, which the toggle in
// Settings → CRM Pipeline Preferences flips. Default OFF.
function setCrmAutoCollapse(on) {
  try { localStorage.setItem(CRM_AUTOCOLLAPSE_KEY, on ? '1' : '0'); } catch (e) {}
  // If turning OFF, immediately drop any active collapse state so the
  // header pops back to full size without waiting for the next scroll.
  if (!on) document.body.classList.remove('crm-scrolling');
}
window.setCrmAutoCollapse = setCrmAutoCollapse;
function _isCrmAutoCollapseOn() {
  try { return localStorage.getItem(CRM_AUTOCOLLAPSE_KEY) === '1'; }
  catch (e) { return false; }
}

(function setupCrmScrollCollapse() {
  let scrollTimer = null;
  const onScroll = () => {
    if (!_isCrmAutoCollapseOn()) return;
    if (!document.getElementById('view-crm')?.classList.contains('active')) return;
    document.body.classList.add('crm-scrolling');
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      document.body.classList.remove('crm-scrolling');
    }, 700);
  };
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  document.addEventListener('dragstart', (e) => {
    if (!_isCrmAutoCollapseOn()) return;
    if (e.target?.closest?.('.kanban-board')) {
      document.body.classList.add('crm-scrolling');
    }
  });
  document.addEventListener('dragend', () => {
    if (!_isCrmAutoCollapseOn()) return;
    setTimeout(() => document.body.classList.remove('crm-scrolling'), 200);
  });
})();

// Boot: ESC to exit fullscreen (sidebar-collapsed restore moved to
// dashboard-state.js so it runs before this script).
(function bootPageBreathe() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('kanban-fullscreen')) {
      // Don't steal Escape from open modals — they handle it themselves
      const openModal = document.querySelector('.modal-bg.open, .d2d-modal-overlay.open');
      if (!openModal) toggleKanbanFullscreen();
    }
  });
})();

// Load saved theme when user auth resolves
document.addEventListener('DOMContentLoaded', () => {
  loadSavedTheme();
  // Boot Theme Engine (overlays, sounds, achievements). The cluster is a
  // lazy bundle (2026-08-07): loadBundle('theme') calls this hook when the
  // files arrive — whichever path loaded them (dashboard-state boot kick,
  // Settings view, theme picker). Idempotent; also runs on the legacy page
  // where the cluster is still eager (ThemeEngine present at DCL).
  const initThemeStack = () => {
    if (initThemeStack._done || !window.ThemeEngine) return;
    initThemeStack._done = true;
    loadSavedTheme();   // re-apply through the engine path (legacy CSS
                        // fallback painted first while the bundle loaded)
    window.ThemeEngine.init();
    if(window.ThemeOverlays) window.ThemeOverlays.init();
    if(window.ThemeSounds) window.ThemeSounds.init();
    if(window.ThemeGX) window.ThemeGX.init({ intensity: 0.6, glow: true, animatedBg: true });
    if(window.ThemeGXPanel) ThemeGXPanel.render('gx-settings-panel');
  };
  window._nbdInitThemeStack = initThemeStack;
  if (window.ThemeEngine) setTimeout(initThemeStack, 500);
  // Boot achievements after leads load
  setTimeout(() => {
    if(window.ThemeAchievements && window._user) {
      window.ThemeAchievements.init();
    }
  }, 3000);
});

// Mark current theme card active whenever settings opens
const origGoTo = typeof goTo === 'function' ? goTo : null;
function goToWithTheme(view) {
  if(origGoTo) origGoTo(view);
  if(view === 'settings') {
    setTimeout(() => {
      const cur = document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
      document.querySelectorAll('.theme-card').forEach(c => {
        c.classList.toggle('active', c.dataset.key === cur);
      });
    }, 50);
  }
}

// ══════════════════════════════════════════════
// DAILY PROGRAM SETTINGS — render helpers (UI side)
// ══════════════════════════════════════════════
function dsRenderFloors() {
  const wrap = document.getElementById('ds-floor-editor');
  if (!wrap) return;
  wrap.innerHTML = '';
  const inputStyle = 'background:var(--s2);border:1px solid var(--br);border-radius:4px;padding:6px 8px;color:var(--t);font-size:12px;width:100%;outline:none;';
  dsFloors.forEach((f, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr 70px 70px 28px;gap:6px;margin-bottom:6px;align-items:center;';

    const label = document.createElement('input');
    label.style.cssText = inputStyle;
    label.placeholder = 'Floor label';
    label.value = f.label || '';
    label.addEventListener('input', () => { dsFloors[i].label = label.value; });

    const target = document.createElement('input');
    target.style.cssText = inputStyle + 'text-align:center;';
    target.type = 'number';
    target.placeholder = 'Tgt';
    target.value = f.targetValue || 1;
    target.addEventListener('input', () => { dsFloors[i].targetValue = +target.value; });

    const unit = document.createElement('input');
    unit.style.cssText = inputStyle + 'text-align:center;';
    unit.placeholder = 'Unit';
    unit.value = f.unit || 'done';
    unit.addEventListener('input', () => { dsFloors[i].unit = unit.value; });

    const rm = document.createElement('button');
    rm.textContent = '×';
    rm.style.cssText = 'background:transparent;border:none;cursor:pointer;color:var(--red);font-size:17px;line-height:1;padding:0;width:28px;text-align:center;';
    rm.addEventListener('click', () => dsRemoveFloor(i));

    row.append(label, target, unit, rm);
    wrap.appendChild(row);
  });
}

function dsBuildThemeGrid() {
  const grid = document.getElementById('ds-theme-grid');
  if (!grid) return;
  grid.innerHTML = DS_THEMES.map(t => `
    <div data-du-action="dsPickTheme" data-du-id="${t.key}" id="ds-tc-${t.key}" style="
      cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:5px;
      padding:10px 6px;border-radius:6px;border:2px solid ${t.key===dsSelectedTheme?'var(--orange)':'var(--br)'};
      background:${t.key===dsSelectedTheme?'color-mix(in srgb, var(--orange) 8%, transparent)':'var(--s2)'};
      transition:border-color var(--t-fast),background var(--t-fast);
    ">
      <span style="width:18px;height:18px;border-radius:50%;background:${t.dot};display:block;flex-shrink:0;"></span>
      <span style="font-size:10px;font-family:'Barlow Condensed',sans-serif;letter-spacing:.04em;color:var(--t);text-align:center;white-space:nowrap;">${t.label}</span>
    </div>
  `).join('');
}

function dsPickTheme(key) {
  dsSelectedTheme = key;
  dsBuildThemeGrid();
}

// ══════════════════════════════════════════════
// MOBILE NAVIGATION — UI
// ══════════════════════════════════════════════
function mobileNav(view) {
  // Use the existing goTo() to switch views
  goTo(view);
  // Update bottom nav active state
  MOBILE_NAV_TABS.forEach(t => {
    const el = document.getElementById('mni-' + t);
    if (el) el.classList.toggle('active', t === view);
  });
  // If "more" items, deactivate all bottom tabs
  if (!MOBILE_NAV_TABS.includes(view)) {
    MOBILE_NAV_TABS.forEach(t => {
      const el = document.getElementById('mni-' + t);
      if (el) el.classList.remove('active');
    });
  }
  // Close any open map sidebar when switching views
  document.querySelectorAll('.map-sidebar.open').forEach(s => s.classList.remove('open'));
}

function toggleMobileMore() {
  const menu = document.getElementById('mobile-more-menu');
  const moreBtn = document.getElementById('mni-more');
  const isOpen = menu.classList.contains('open');
  menu.classList.toggle('open', !isOpen);
  if (moreBtn) moreBtn.classList.toggle('active', !isOpen);
  document.body.style.overflow = !isOpen ? 'hidden' : '';
}

function closeMobileMore() {
  document.getElementById('mobile-more-menu')?.classList.remove('open');
  document.getElementById('mni-more')?.classList.remove('active');
  document.body.style.overflow = '';
}

function toggleMapSidebar(id) {
  const sidebar = document.getElementById(id);
  if (!sidebar) return;
  // Close all other map sidebars first
  document.querySelectorAll('.map-sidebar').forEach(s => {
    if (s.id !== id) s.classList.remove('open');
  });
  sidebar.classList.toggle('open');
  // Update button text
  const btn = sidebar.closest('.map-view')?.querySelector('.map-toggle-btn');
  if (btn) btn.textContent = sidebar.classList.contains('open') ? '✕ Close' : btn.textContent.replace('✕ Close','').trim() || '☰ Tools';
  // The drawer animates max-height over .3s (dashboard-app.css, `.map-sidebar`
  // / `.map-sidebar.open` in the <=768px block) and now GENUINELY resizes
  // .map-area, which is flex:1 in the same column. Before the map height-chain
  // fix the pane was min-height-locked, so opening the drawer never changed the
  // map's box and Leaflet never needed to hear about it; now the box shrinks
  // (654px -> 315px at 375px wide) and without a remeasure Leaflet keeps
  // requesting tiles for the old viewport and paints a torn pane. 350ms so the
  // .3s transition has settled — invalidating mid-animation just re-measures an
  // intermediate height.
  //
  // Read the two map handles as BARE sibling-scope names behind `typeof`
  // guards, not off `window`: both are classic-script top-level `let`s
  // (`let mainMap` in maps-core.js, `let drawMap` in maps-routing.js), so they
  // live in the global LEXICAL environment and never become window properties
  // — `window.mainMap` is permanently undefined. The `typeof` guard is what
  // keeps a bare read from throwing ReferenceError on a page that loads this
  // file without the maps modules; it is the same idiom dashboard-actions.js
  // uses for `drawMap`.
  setTimeout(() => {
    if (typeof mainMap !== 'undefined' && mainMap?.invalidateSize) mainMap.invalidateSize();
    if (typeof drawMap !== 'undefined' && drawMap?.invalidateSize) drawMap.invalidateSize();
  }, 350);
}

// Sync bottom nav active state with goTo() calls from desktop sidebar
// (wraps the existing goTo — safe because we already wrap it once above for DS settings).
// Forward `arguments` so the (view, params) signature is preserved.
(function() {
  const _prev = window.goTo;
  window.goTo = function() {
    const view = arguments[0];
    if (_prev) _prev.apply(this, arguments);
    // Keep bottom nav in sync
    MOBILE_NAV_TABS.forEach(t => {
      const el = document.getElementById('mni-' + t);
      if (el) el.classList.toggle('active', t === view);
    });
    // Mirror lead badge to mobile nav
    const badge = document.getElementById('leadBadge');
    const mbadge = document.getElementById('mni-crm-badge');
    if (badge && mbadge) {
      const count = badge.textContent.trim();
      mbadge.textContent = count;
      mbadge.style.display = (count && count !== '0') ? 'block' : 'none';
    }
  };
})();

// Keep mobile CRM badge in sync with lead count updates
const _origUpdateLeadBadge = window.updateLeadBadge;
function syncMobileBadge() {
  setTimeout(() => {
    const badge = document.getElementById('leadBadge');
    const mbadge = document.getElementById('mni-crm-badge');
    if (badge && mbadge) {
      const count = badge.textContent.trim();
      mbadge.textContent = count;
      mbadge.style.display = (count && count !== '0') ? 'block' : 'none';
    }
  }, 200);
}
// Observe leadBadge for changes
const _leadBadgeEl = document.getElementById('leadBadge');
if (_leadBadgeEl) {
  new MutationObserver(syncMobileBadge).observe(_leadBadgeEl, { childList: true, characterData: true, subtree: true });
}

// ══════════════════════════════════════════════════════════════════════
// CRM SECONDARY HEADER — AUTO-HIDE ON SCROLL + SETTINGS TOGGLE
// ══════════════════════════════════════════════════════════════════════
function getCrmSecHeaderEnabled() {
  try {
    const val = localStorage.getItem(CRM_SEC_HEADER_SETTING);
    return val === null ? true : val === 'true'; // default ON
  } catch { return true; }
}

function setCrmSecHeaderEnabled(enabled) {
  try { localStorage.setItem(CRM_SEC_HEADER_SETTING, String(enabled)); } catch {}
  applyCrmSecHeaderState();
}
// Expose to window. This file is IIFE-wrapped, so the Settings "Secondary Toolbar"
// toggle could not reach this setter: its handler nbdSetCrmSecHeaderEnabledT
// (dashboard-ui-prefs-boot.js, a separate file) guards on a BARE
// `typeof setCrmSecHeaderEnabled === 'function'`, which resolves against the global
// scope — and this function was never put there. The toggle silently no-op'd
// (and, post-PR #670, falsely toasted "Secondary header ON"). Its siblings
// setKanbanDensity / setKanbanBoldHierarchy / setCrmAutoCollapse are all
// window-exposed; this was the one missed export.
window.setCrmSecHeaderEnabled = setCrmSecHeaderEnabled;

function applyCrmSecHeaderState() {
  const enabled = getCrmSecHeaderEnabled();
  const header = document.getElementById('crmSecondaryHeader');
  const restoreBtn = document.getElementById('crmSecRestoreBtn');
  if (!header || !restoreBtn) return;

  if (!enabled) {
    header.classList.add('hidden');
    restoreBtn.style.display = 'none';
  } else {
    header.classList.remove('hidden');
    restoreBtn.style.display = 'none';
  }
}

function restoreCrmSecondary() {
  const header = document.getElementById('crmSecondaryHeader');
  const restoreBtn = document.getElementById('crmSecRestoreBtn');
  if (!header || !restoreBtn) return;
  header.classList.remove('hidden');
  restoreBtn.style.display = 'none';
}

// Auto-hide on scroll within kanban board
const kanbanBoard = document.getElementById('kanbanBoard');
if (kanbanBoard) {
  kanbanBoard.addEventListener('scroll', function() {
    const enabled = getCrmSecHeaderEnabled();
    if (!enabled) return; // Don't auto-hide if setting is off

    const header = document.getElementById('crmSecondaryHeader');
    const restoreBtn = document.getElementById('crmSecRestoreBtn');
    if (!header || !restoreBtn) return;

    const scrollTop = kanbanBoard.scrollLeft; // horizontal scroll
    const currentView = document.querySelector('.view.active');
    const isCrmView = currentView && currentView.id === 'view-crm';
    if (!isCrmView) return;

    if (scrollTop > 50 && scrollTop > _lastScrollTop) {
      // Scrolling right → hide
      header.classList.add('hidden');
      restoreBtn.style.display = 'block';
    } else if (scrollTop < 20) {
      // Scrolled back to start → show
      header.classList.remove('hidden');
      restoreBtn.style.display = 'none';
    }
    _lastScrollTop = scrollTop;
  });
}

// Apply state on page load
document.addEventListener('DOMContentLoaded', applyCrmSecHeaderState);

// ══════════════════════════════════════════════
// MAP ENHANCEMENTS — spyglass, fab bar, quick storm check
// ══════════════════════════════════════════════
// ── Spyglass search ──────────────────────────
const spyglassSearch = async function() {
  const q = document.getElementById('spyglassInput')?.value?.trim();
  if(!q) return;
  hideAcDrop('spyglassInput');
  const data = await geocode(q);
  if(!data) return;
  if(mainMap) mainMap.setView([parseFloat(data.lat), parseFloat(data.lon)], 18);
  // Also show property card — guard since propCard lives in tpl-view-map.
  window._lastMapSearch = data;
  const propCard = document.getElementById('propCard');
  const propCardInner = document.getElementById('propCardInner');
  if (propCard && propCardInner) {
    propCard.style.display = 'block';
    propCardInner.innerHTML = `
      <div class="pi-card">
        <div class="pi-header"><span class="pi-title">🏠 Property Intel</span><span class="pi-county"></span></div>
        <div class="pi-loading"><div class="pi-spinner"></div>Estimating property profile...</div>
      </div>
      <button class="make-lead-btn" data-du-action="makeLeadFromSearch">＋ Make This a Lead</button>`;
    fetchPropertyIntel(data, 'propCardInner');
  }
  // Show sidebar if hidden
  const sidebar = document.getElementById('map-sidebar-map');
  if(sidebar && !sidebar.classList.contains('open') && window.innerWidth <= 768) {
    sidebar.classList.add('open');
  }
};

const spyglassGoToLocation = function() {
  showToast('Getting your location...');
  if(!navigator.geolocation) { showToast('Location unavailable','error'); return; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      if(!mainMap) return;
      mainMap.setView([lat, lng], 17);
      // Accuracy ring
      if(window._locMarker) mainMap.removeLayer(window._locMarker);
      if(window._locRing) mainMap.removeLayer(window._locRing);
      window._locMarker = L.circleMarker([lat,lng], {
        radius:8, color:'#fff', fillColor:'var(--blue)', fillOpacity:1, weight:2
      }).addTo(mainMap);
      window._locRing = L.circleMarker([lat,lng], {
        radius:20, color:'var(--blue)', fillColor:'transparent', weight:2, opacity:.5, className:'loc-pulse-ring'
      }).addTo(mainMap);
      showToast('Located ✓');
    },
    () => showToast('Location access denied','error'),
    {enableHighAccuracy:true, timeout:8000}
  );
};

// ── FAB bar toggles (sync with sidebar toggles) ──
const fabToggle = function(type, el) {
  const tog = document.getElementById('tog-'+type);
  if(tog) {
    toggleOverlay(type, tog);
    el.classList.toggle('active', tog.classList.contains('on'));
  }
};

// Sync fab active states when overlay toggles happen from sidebar
const _origToggleOverlay = window.toggleOverlay;
window.toggleOverlay = function(type, el) {
  if(_origToggleOverlay) _origToggleOverlay(type, el);
  const fab = document.getElementById('fab-'+type);
  if(fab) fab.classList.toggle('active', el?.classList?.contains('on'));
};

// ── Quick storm check at current location ──
const quickStormCheck = async function() {
  showToast('Getting location for storm check...');
  if(!navigator.geolocation) { showToast('Location unavailable','error'); return; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      if(mainMap) mainMap.setView([lat, lng], 13);
      // Turn on storm overlay
      const tog = document.getElementById('tog-storm');
      if(tog && !tog.classList.contains('on')) {
        toggleOverlay('storm', tog);
      }
      const fab = document.getElementById('fab-storm');
      if(fab) fab.classList.add('active');
      showToast('Storm radar active at your location');
    },
    () => showToast('Location access denied','error')
  );
};

// (Removed 2026-09-22: a spyglass autocomplete wrapper that replaced
// initAllAutocomplete's global slot to also bind #spyglassInput, and three unused
// _origDropPin/_origDeletePin/_origInitMainMap captures. The wrapper never ran:
// the boot call above binds the original function before this point, and nothing
// else ever called it through the global object. After the whole-file IIFE wrap it
// had nothing left to wrap either. #spyglassInput therefore has no address
// autocomplete, only Enter -> spyglassSearch, which is what it has always done.)

// ── Zone tooltip CSS ─────────────────────────────────────────
(function injectZoneCSS(){
  const s = document.createElement('style');
  // Batch-2 tokenization: the tooltip used a hardcoded near-black surface +
  // light text, which was unreadable-on-arrival in the light themes (paper/
  // ghost). Tokens follow the active theme; the translucency is kept via
  // color-mix so map detail still reads through.
  s.textContent = `.zone-tooltip{background:color-mix(in srgb, var(--s) 88%, transparent)!important;border:1px solid var(--br)!important;color:var(--t)!important;border-radius:4px!important;padding:2px 8px!important;font-size:11px!important;box-shadow:0 2px 8px rgba(0,0,0,.4)!important;}
  .zone-tooltip::before{display:none!important;}`;
  document.head.appendChild(s);
})();


// CSP-safe delegation for 2 data-du-action attrs (dashboard-ui residual).
// (Other dashboard-ui buttons use the dashboard global action delegate via
//  data-action="goTo" etc. — that delegate is in dashboard-actions.js.)
(function () {
  if (window._NBD_DU_DELEGATE_BOUND) return;
  window._NBD_DU_DELEGATE_BOUND = true;
  document.addEventListener('click', function (ev) {
    const t = ev.target.closest && ev.target.closest('[data-du-action]');
    if (!t) return;
    const action = t.dataset.duAction;
    const id = t.dataset.duId;
    try {
      switch (action) {
        case 'makeLeadFromSearch': if (typeof makeLeadFromSearch === 'function') makeLeadFromSearch(); break;
        case 'dsPickTheme':        if (typeof dsPickTheme === 'function') dsPickTheme(id); break;
        default: console.warn('[dashboard-ui] no dispatch for', action);
      }
    } catch (e) { console.error('[dashboard-ui] dispatch ' + action + ' failed:', e); }
  });
})();

// ── Delegate registration (Globals Tranche 2c-4g — 2026-07-08) ──
// Three leaf comfort/kanban handlers dispatched ONLY from markup, through THIS
// file’s own registry-first resolver (_nbdResolveCall). Converted from auto-global
// `function X` declarations to `const X = function` (off window: a const never
// becomes a window property, and since T3-A the whole file is one IIFE anyway)
// + registered here; their _NBD_CALL_ALLOWLIST entries are dropped in
// dashboard-state.js. MUST-STAY siblings keep window + allowlist (via explicit
// `window.X = X` exports since the T3-A wrap): setKanbanDensity (allowlist
// dispatch backing), setPhotoMode (widgets.js
// cross-file call), nbdComfortSet (prefs-boot.js cross-file calls).
window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, {
  cycleKanbanDensity: cycleKanbanDensity,
  nbdComfortSetWhisperHotkey: nbdComfortSetWhisperHotkey,
  nbdComfortSetWhisperKey: nbdComfortSetWhisperKey,
  // Tranche 2c-4h (Slice H1, 2026-07-08): 9 leaf cal/photo/template handlers,
  // each a bare `function X` living ONLY in this file with zero cross-file
  // callers (21-agent audit). Converted to `const X = function` (off window;
  // file-private since the T3-A IIFE wrap) + registered here; allowlist
  // entries dropped in dashboard-state.js. TDZ-safe: the sole non-markup caller (loadCalSettings →
  // updateCalEmbed) runs from dashboard-main.js's DOMContentLoaded, long after
  // these consts initialize.
  saveCalSettings: saveCalSettings,
  updateCalEmbed: updateCalEmbed,
  copyCalLink: copyCalLink,
  shareCalViaSMS: shareCalViaSMS,
  shareCalViaEmail: shareCalViaEmail,
  filterPhotoLeads: filterPhotoLeads,
  tlToggleCat: tlToggleCat,
  tlFilterCat: tlFilterCat,
  handleDocUpload: handleDocUpload,
  // Tranche 2c-4h (Slice H2, 2026-07-08): 6 entangled single-defs — their only
  // entanglement was forward-ref `window.X = X` re-export shims in maps.js +
  // dashboard-actions.js, removed in this same slice. `function X` → `const X`
  // + registered here. (2026-08-07: damagNearMe no longer aliases
  // spyglassGoToLocation anywhere — its single implementation registers in
  // maps-overlays.js.)
  spyglassSearch: spyglassSearch,
  spyglassGoToLocation: spyglassGoToLocation,
  fabToggle: fabToggle,
  quickStormCheck: quickStormCheck,
  openUploadDoc: openUploadDoc,
  printDoc: printDoc,
  // Tranche 3 dispatch-map slice (2026-09-02): six handlers whose ONLY reach
  // is _NBD_TOGGLE_FNS / _NBD_MODAL_CLOSE_FNS (registry-first since T3-M).
  // Each converted from an auto-global declaration to a const in this file
  // (file-private since the T3-A IIFE wrap) + registered here — same scope
  // as the definitions, so no cross-IIFE ordering trap. Their map entries in dashboard-state.js
  // are now the only dispatch path: losing either half of a pair is a
  // modal-Joe-cannot-close bug, and the graduate pins in
  // tests/smoke/dashboard.test.js lock both halves. Per-name reach proofs
  // were adversarially verified 2026-09-02 (zero bare cross-file calls, zero
  // HTML or generated-markup name hits, no allowlist entries).
  toggleHdrMobileMenu: toggleHdrMobileMenu,
  toggleKanbanFullscreen: toggleKanbanFullscreen,
  toggleSidebarCollapse: toggleSidebarCollapse,
  closePhotoModal: closePhotoModal,
  closeDocViewer: closeDocViewer,
  closeTips: closeTips
});
})();
