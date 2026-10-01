// ── Globals Tranche 2c (2026-07-06): module scope ──
// Everything in this file used to sit at the top level of a classic
// script, so every function/var landed in global scope. The deliberate
// external surface is now exactly two window names:
//   • window.showToast          — guarded page-wide toast fallback
//   • window.nbdRenderFontGrid  — called by ui.js + dashboard-billing-tab.js
// (nbdSyncSizeBtns, ui.js switchSettingsTab's size-button repaint hook, was
// the third until Globals Tranche 3 T3-C, 2026-09-18 — it is registry-only
// now, in the __NBD_CALL_REGISTRY block below.)
// The delegate-dispatched handlers (data-fn / data-on-change /
// data-on-input in dashboard.html + generated markup) are registered in
// window.__NBD_CALL_REGISTRY at the bottom instead of being globals —
// dashboard-ui.js's dispatchers resolve the registry first, then fall
// back to allowlisted window globals for unconverted modules.
(function () {
// ── Professional Mode (DE-MOJI) — early boot ──
// Set the body class BEFORE paint so emojis never flash then disappear.
// The toggle function is also defined here so it's available to the
// Settings checkbox before any deferred scripts load.
(function() {
  if (localStorage.getItem('nbd_professional_mode') === '1') {
    document.body.classList.add('professional-mode');
  }
})();
// ── Toast notifications (dashboard) ──
// 30+ dashboard call sites — dashboard-ui.js (28x), the settings-toggle wrappers
// below (_nbdToast), nbdSetSize, nbdApplyLegacyFont — call `showToast(msg, type)`
// guarded by `typeof showToast === 'function'`. But the ONLY definition lived in
// /pro/customer.html — never on the dashboard — so every call silently no-op'd:
// font / UI-size / toggle changes applied with NO visible confirmation. Define it
// here (same self-contained impl as customer.html: own element + keyframes, typed
// colors) so that feedback finally shows. Guarded so it never clobbers a page that
// already defines its own showToast.
if (typeof window.showToast !== 'function') {
  window.showToast = function(message, type) {
    var bg = 'var(--s,#1a1d23)'; var edge = type === 'success' ? 'var(--green,#2ECC8A)' : type === 'error' ? 'var(--red,#E05252)' : 'var(--blue,#3b82f6)';
    var toast = document.createElement('div');
    toast.className = 'nbd-showtoast';
    toast.style.cssText = 'position:fixed;bottom:20px;right:20px;background:' + bg + ';color:var(--t,#e8eaf0);border:1px solid var(--br,rgba(255,255,255,.1));border-left:3px solid ' + edge + ';padding:11px 14px;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:var(--z-toast,10002);font-size:13px;font-weight:500;max-width:340px;animation:nbdToastIn .25s ease-out;pointer-events:auto;';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(function() {
      toast.style.animation = 'nbdToastOut .25s ease-in';
      toast.style.pointerEvents = 'none';
      setTimeout(function() { if (toast.parentNode) toast.remove(); }, 250);
    }, 2600);
  };
  if (!document.getElementById('nbdToastKeyframes')) {
    var _nbdTk = document.createElement('style');
    _nbdTk.id = 'nbdToastKeyframes';
    _nbdTk.textContent = '@keyframes nbdToastIn{from{transform:translateX(400px);opacity:0}to{transform:translateX(0);opacity:1}}@keyframes nbdToastOut{from{transform:translateX(0);opacity:1}to{transform:translateX(400px);opacity:0}}';
    (document.head || document.documentElement).appendChild(_nbdTk);
  }
}
// ── Site-wide sizing system ──
// 4 presets that scale --nbd-scale on :root, which every
// padding/font/gap rule multiplies against. The CSS uses
// calc() with the scale variable so one change ripples everywhere.
//
// data-nbd-scale-cards="true" tells card-font-size CSS rules to
// multiply by --nbd-scale. Default size leaves it absent (cards
// use their density-token sizes verbatim, scale=1.0 is implicit).
const NBD_SIZE_SCALES = { compact: 0.85, default: 1.0, comfortable: 1.12, large: 1.25 };
function _nbdApplyScaleAttrs(size, scale) {
  document.documentElement.style.setProperty('--nbd-scale', scale);
  document.body.dataset.nbdSize = size;
  if (size === 'default') document.documentElement.removeAttribute('data-nbd-scale-cards');
  else document.documentElement.setAttribute('data-nbd-scale-cards', 'true');
}
(function() {
  var saved = localStorage.getItem('nbd_ui_size') || 'default';
  var scale = NBD_SIZE_SCALES[saved] || 1.0;
  _nbdApplyScaleAttrs(saved, scale);
})();
// Stronger active-state styling so users can see which size is selected
// without squinting at a 1px border color difference. The active button
// uses an orange background fill, white text, and a soft glow.
function _nbdPaintSizeBtn(b, active) {
  if (active) {
    b.style.background = 'var(--orange)';
    b.style.borderColor = 'var(--orange)';
    b.style.color = 'var(--accent-fg, #fff)';
    b.style.boxShadow = '0 0 0 3px color-mix(in srgb, var(--orange) 22%, transparent)';
    b.style.fontWeight = '800';
  } else {
    b.style.background = '';
    b.style.borderColor = '';
    b.style.color = '';
    b.style.boxShadow = '';
    b.style.fontWeight = '';
  }
}
function nbdSetSize(size) {
  var scale = NBD_SIZE_SCALES[size] || 1.0;
  _nbdApplyScaleAttrs(size, scale);
  localStorage.setItem('nbd_ui_size', size);
  document.querySelectorAll('.nbd-size-btn').forEach(function(b) {
    _nbdPaintSizeBtn(b, b.dataset.size === size);
  });
  if (typeof showToast === 'function') showToast('UI size: ' + size, 'info');
}
// Sync size buttons on settings open
document.addEventListener('DOMContentLoaded', function() {
  var saved = localStorage.getItem('nbd_ui_size') || 'default';
  document.querySelectorAll('.nbd-size-btn').forEach(function(b) {
    _nbdPaintSizeBtn(b, b.dataset.size === saved);
  });
});
// Re-paint when the appearance tab opens (the size buttons are inside
// the lazy-hydrated settings template, so DOMContentLoaded fires before
// they exist in the live DOM). Module-scoped + registered in
// __NBD_CALL_REGISTRY below (Globals Tranche 3 T3-C, 2026-09-18) — ui.js
// switchSettingsTab, its only caller, reads it off the registry.
function nbdSyncSizeBtns() {
  var saved = localStorage.getItem('nbd_ui_size') || 'default';
  document.querySelectorAll('.nbd-size-btn').forEach(function(b) {
    _nbdPaintSizeBtn(b, b.dataset.size === saved);
  });
}

// ── Expanded font system (legacy inline picker) ──
// 28 font families spanning humanist sans, geometric, serif, slab,
// monospace, and display styles. Renamed to _NBD_LEGACY_FONTS to
// avoid colliding with the const NBD_FONTS in maps.js (theme engine
// font pairings). That collision caused a SyntaxError that killed
// maps.js entirely.
//
// Categories (cat field): 'sans' | 'serif' | 'mono' | 'display'.
// Picker UI groups by category and renders a label + Aa preview using
// the body font so users can browse by visual mood.
var _NBD_LEGACY_FONTS = [
  // ── Sans (humanist + geometric) ──
  { id: 'barlow',     label: 'Barlow',        cat: 'sans',    body: "'Barlow',sans-serif",             heading: "'Barlow Condensed',sans-serif",    gf: 'Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600' },
  { id: 'inter',      label: 'Inter',         cat: 'sans',    body: "'Inter',sans-serif",              heading: "'Inter',sans-serif",               gf: 'Inter:wght@400;500;600;700;800' },
  { id: 'poppins',    label: 'Poppins',       cat: 'sans',    body: "'Poppins',sans-serif",            heading: "'Poppins',sans-serif",             gf: 'Poppins:wght@400;500;600;700;800' },
  { id: 'roboto',     label: 'Roboto',        cat: 'sans',    body: "'Roboto',sans-serif",             heading: "'Roboto Condensed',sans-serif",    gf: 'Roboto+Condensed:wght@400;700&family=Roboto:wght@400;500;700' },
  { id: 'nunito',     label: 'Nunito',        cat: 'sans',    body: "'Nunito',sans-serif",             heading: "'Nunito',sans-serif",              gf: 'Nunito:wght@400;600;700;800' },
  { id: 'dm-sans',    label: 'DM Sans',       cat: 'sans',    body: "'DM Sans',sans-serif",            heading: "'DM Sans',sans-serif",             gf: 'DM+Sans:wght@400;500;700' },
  { id: 'space',      label: 'Space Grotesk', cat: 'sans',    body: "'Space Grotesk',sans-serif",      heading: "'Space Grotesk',sans-serif",       gf: 'Space+Grotesk:wght@400;500;600;700' },
  { id: 'outfit',     label: 'Outfit',        cat: 'sans',    body: "'Outfit',sans-serif",             heading: "'Outfit',sans-serif",              gf: 'Outfit:wght@400;500;600;700;800' },
  { id: 'montserrat', label: 'Montserrat',    cat: 'sans',    body: "'Montserrat',sans-serif",         heading: "'Montserrat',sans-serif",          gf: 'Montserrat:wght@400;500;600;700;800' },
  { id: 'lato',       label: 'Lato',          cat: 'sans',    body: "'Lato',sans-serif",               heading: "'Lato',sans-serif",                gf: 'Lato:wght@400;700;900' },
  { id: 'raleway',    label: 'Raleway',       cat: 'sans',    body: "'Raleway',sans-serif",            heading: "'Raleway',sans-serif",             gf: 'Raleway:wght@400;500;600;700;800' },
  { id: 'source',     label: 'Source Sans',   cat: 'sans',    body: "'Source Sans 3',sans-serif",      heading: "'Source Sans 3',sans-serif",       gf: 'Source+Sans+3:wght@400;600;700;800' },
  { id: 'work-sans',  label: 'Work Sans',     cat: 'sans',    body: "'Work Sans',sans-serif",          heading: "'Work Sans',sans-serif",           gf: 'Work+Sans:wght@400;500;600;700;800' },
  { id: 'manrope',    label: 'Manrope',       cat: 'sans',    body: "'Manrope',sans-serif",            heading: "'Manrope',sans-serif",             gf: 'Manrope:wght@400;500;600;700;800' },
  { id: 'sora',       label: 'Sora',          cat: 'sans',    body: "'Sora',sans-serif",               heading: "'Sora',sans-serif",                gf: 'Sora:wght@400;500;600;700;800' },
  { id: 'figtree',    label: 'Figtree',       cat: 'sans',    body: "'Figtree',sans-serif",            heading: "'Figtree',sans-serif",             gf: 'Figtree:wght@400;500;600;700;800' },
  { id: 'plus-jakarta', label: 'Plus Jakarta',cat: 'sans',    body: "'Plus Jakarta Sans',sans-serif",  heading: "'Plus Jakarta Sans',sans-serif",   gf: 'Plus+Jakarta+Sans:wght@400;500;600;700;800' },
  { id: 'be-vietnam', label: 'Be Vietnam',    cat: 'sans',    body: "'Be Vietnam Pro',sans-serif",     heading: "'Be Vietnam Pro',sans-serif",      gf: 'Be+Vietnam+Pro:wght@400;500;600;700;800' },
  { id: 'rubik',      label: 'Rubik',         cat: 'sans',    body: "'Rubik',sans-serif",              heading: "'Rubik',sans-serif",               gf: 'Rubik:wght@400;500;600;700;800' },
  // ── Serif ──
  { id: 'merriweather', label: 'Merriweather', cat: 'serif', body: "'Merriweather',serif",            heading: "'Merriweather',serif",             gf: 'Merriweather:wght@400;700;900' },
  { id: 'playfair',   label: 'Playfair',      cat: 'serif',   body: "'Playfair Display',serif",        heading: "'Playfair Display',serif",         gf: 'Playfair+Display:wght@400;500;600;700;800' },
  { id: 'lora',       label: 'Lora',          cat: 'serif',   body: "'Lora',serif",                    heading: "'Lora',serif",                     gf: 'Lora:wght@400;500;600;700' },
  { id: 'pt-serif',   label: 'PT Serif',      cat: 'serif',   body: "'PT Serif',serif",                heading: "'PT Serif',serif",                 gf: 'PT+Serif:wght@400;700' },
  { id: 'eb-garamond',label: 'EB Garamond',   cat: 'serif',   body: "'EB Garamond',serif",             heading: "'EB Garamond',serif",              gf: 'EB+Garamond:wght@400;500;600;700;800' },
  { id: 'crimson',    label: 'Crimson Pro',   cat: 'serif',   body: "'Crimson Pro',serif",             heading: "'Crimson Pro',serif",              gf: 'Crimson+Pro:wght@400;500;600;700;800' },
  // ── Mono ──
  { id: 'jetbrains',  label: 'JetBrains Mono',cat: 'mono',    body: "'JetBrains Mono',ui-monospace,monospace",  heading: "'JetBrains Mono',ui-monospace,monospace",  gf: 'JetBrains+Mono:wght@400;500;700' },
  { id: 'fira-code',  label: 'Fira Code',     cat: 'mono',    body: "'Fira Code',ui-monospace,monospace",       heading: "'Fira Code',ui-monospace,monospace",       gf: 'Fira+Code:wght@400;500;600;700' },
  { id: 'roboto-mono',label: 'Roboto Mono',   cat: 'mono',    body: "'Roboto Mono',ui-monospace,monospace",     heading: "'Roboto Mono',ui-monospace,monospace",     gf: 'Roboto+Mono:wght@400;500;600;700' }
];
var _nbdLoadedFonts = {};
// Renamed from `nbdApplyFont` → `nbdApplyLegacyFont` (2026-06-20). A SECOND global
// `function nbdApplyFont` lives in maps.js (theme-engine, NBD_FONTS pairings) and
// loads LATER (deferred at the bottom of dashboard.html), so it overwrote
// window.nbdApplyFont. The Settings font grid's cards (data-fn="nbdApplyFont",
// legacy ids like 'poppins'/'inter') were then dispatched to the maps.js version,
// whose NBD_FONTS.find() doesn't contain those ids → `if(!f) return` → every card
// silently no-op'd. This is the same collision noted above for the FONT LIST
// (NBD_FONTS → _NBD_LEGACY_FONTS); we now give the FUNCTION a unique name too so the
// two font systems stop clobbering each other. The grid + boot below call this name.
function nbdApplyLegacyFont(fontId) {
  var font = _NBD_LEGACY_FONTS.find(function(f) { return f.id === fontId; });
  if (!font) font = _NBD_LEGACY_FONTS[0]; // fallback to Barlow
  // Load Google Font if not already loaded
  if (!_nbdLoadedFonts[font.id]) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=' + font.gf + '&display=swap';
    document.head.appendChild(link);
    _nbdLoadedFonts[font.id] = true;
  }
  document.documentElement.style.setProperty('--nbd-font-body', font.body);
  document.documentElement.style.setProperty('--nbd-font-heading', font.heading);
  // --nbd-font-display is the heading var nbd-brand.css's base headings actually
  // read, so set it too — that's what makes a font choice flow to headings (not
  // just body). The 'barlow' default's heading IS 'Barlow Condensed', so picking
  // the default restores the brand. (Hardcoded brand-font chrome + all document/
  // PDF/portal generators stay brand-locked by design — they don't read this var.)
  document.documentElement.style.setProperty('--nbd-font-display', font.heading);
  document.body.style.fontFamily = font.body;
  localStorage.setItem('nbd_font', fontId);
  // Highlight active font card
  document.querySelectorAll('.nbd-font-card').forEach(function(c) {
    var active = c.dataset.fontId === fontId;
    c.style.borderColor = active ? 'var(--orange)' : 'var(--br)';
    c.style.background = active ? 'color-mix(in srgb, var(--orange) 6%, transparent)' : 'var(--s2)';
  });
  if (typeof showToast === 'function') showToast('Font: ' + font.label, 'info');
}
// (Dispatch used to require an explicit window export of this function to survive
// later same-name shadowing; the __NBD_CALL_REGISTRY entry at the bottom of this
// file is immune to window shadowing by construction — the dispatchers never
// consult window for registered names.)
// Render font grid into settings — grouped by category with a section
// heading so users can browse Sans / Serif / Mono. Each card shows an
// Aa preview rendered in that font so the picker reads like a sample
// sheet rather than a wall of labels.
function nbdRenderFontGrid() {
  var grid = document.getElementById('settings-font-grid');
  if (!grid) return;
  var saved = localStorage.getItem('nbd_font') || 'barlow';
  var cats = [
    { key: 'sans',    label: 'Sans-serif' },
    { key: 'serif',   label: 'Serif' },
    { key: 'mono',    label: 'Monospace' },
    { key: 'display', label: 'Display' }
  ];
  var html = '';
  cats.forEach(function(cat) {
    var fonts = _NBD_LEGACY_FONTS.filter(function(f) { return (f.cat || 'sans') === cat.key; });
    if (!fonts.length) return;
    html += '<div class="nbd-font-cat-head" style="grid-column:1/-1;font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--m);margin:6px 0 2px;border-bottom:1px solid var(--br);padding-bottom:4px;">' + cat.label + ' <span style="opacity:.6;font-weight:600;">· ' + fonts.length + '</span></div>';
    fonts.forEach(function(f) {
      var active = f.id === saved;
      html += '<div class="nbd-font-card" data-font-id="' + f.id + '" data-action="call" data-fn="nbdApplyLegacyFont" data-arg="' + f.id + '" style="background:' + (active ? 'color-mix(in srgb, var(--orange) 12%, transparent)' : 'var(--s2)') + ';border:2px solid ' + (active ? 'var(--orange)' : 'var(--br)') + ';border-radius:8px;padding:12px;cursor:pointer;transition:all .15s;text-align:center;' + (active ? 'box-shadow:0 0 0 3px color-mix(in srgb, var(--orange) 18%, transparent);' : '') + '">'
        + '<div style="font-family:' + f.body + ';font-size:22px;font-weight:700;color:var(--t);margin-bottom:4px;line-height:1;">Aa</div>'
        + '<div style="font-size:10px;color:var(--m);font-weight:600;">' + f.label + (active ? ' ✓' : '') + '</div>'
        + '</div>';
    });
  });
  grid.innerHTML = html;
}
// Expose so the settings-tab open hook in switchSettingsTab() can call it
// when the appearance template has just been hydrated.
window.nbdRenderFontGrid = nbdRenderFontGrid;

// Boot: apply saved font
(function() {
  var saved = localStorage.getItem('nbd_font');
  if (saved && saved !== 'barlow') nbdApplyLegacyFont(saved);
})();
document.addEventListener('DOMContentLoaded', nbdRenderFontGrid);

function toggleProfessionalMode(on) {
  if (on) {
    document.body.classList.add('professional-mode');
    localStorage.setItem('nbd_professional_mode', '1');
  } else {
    document.body.classList.remove('professional-mode');
    localStorage.removeItem('nbd_professional_mode');
  }
  // Sync the Settings checkbox if it exists
  var cb = document.getElementById('professionalModeToggle');
  if (cb) cb.checked = !!on;
  if (typeof showToast === 'function') showToast(on ? 'Professional Mode enabled' : 'Professional Mode disabled', 'info');
}
// On Settings tab open, sync the checkbox state
document.addEventListener('DOMContentLoaded', function() {
  var cb = document.getElementById('professionalModeToggle');
  if (cb) cb.checked = localStorage.getItem('nbd_professional_mode') === '1';
});

// ── Sidebar tool names — a discoverable, inverse view of the sidebar-collapse
// rail state. "Show tool names" CHECKED == labels visible == body is NOT
// .sidebar-collapsed. Single source of truth: the same `sidebar-collapsed`
// class + `nbd-sidebar-collapsed` key the rail toggle button uses, so the
// Settings checkbox and the rail button can never disagree. (The labels were
// never removed — they're text nodes hidden by font-size:0 under
// body.sidebar-collapsed; this just makes the toggle findable in Settings.)
function nbdSetSidebarLabels(show) {
  var collapsed = !show;
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  try { localStorage.setItem('nbd-sidebar-collapsed', collapsed ? '1' : '0'); } catch (e) {}
  // Keep the rail's own toggle button in sync
  var btn = document.getElementById('sidebarToggleBtn');
  if (btn) btn.classList.toggle('active', collapsed);
  // Reflect in our own checkbox if present
  var cb = document.getElementById('sidebarLabelsToggle');
  if (cb) cb.checked = show;
  // Leaflet maps need an invalidate-size after the rail width changes.
  // window.mainMap / window.d2dMap are never set (see toggleSidebarCollapse
  // in dashboard-ui.js) — bare typeof-guarded names + one 'resize' event,
  // which every Leaflet map answers with its own invalidateSize.
  setTimeout(function () {
    if (typeof mainMap !== 'undefined' && mainMap && mainMap.invalidateSize) mainMap.invalidateSize();
    if (typeof drawMap !== 'undefined' && drawMap && drawMap.invalidateSize) drawMap.invalidateSize();
    window.dispatchEvent(new Event('resize'));
  }, 200);
  if (typeof showToast === 'function') showToast(show ? 'Sidebar tool names shown' : 'Sidebar tool names hidden', 'info');
}

// On load, sync the "Show tool names" checkbox to the persisted rail state
// (checked = labels visible = not collapsed; default is shown).
document.addEventListener('DOMContentLoaded', function() {
  var cb = document.getElementById('sidebarLabelsToggle');
  if (cb) cb.checked = localStorage.getItem('nbd-sidebar-collapsed') !== '1';
});

// ══════════════════════════════════════════════════════════════════════
// CSP-safe wrappers for the inline onchange handlers we just stripped.
//
// `data-on-change` / `data-on-input` delegate (dashboard-ui.js) calls
// `window[fnName](firstArg)` where firstArg comes from `data-on-pass`.
// Inline handlers that did compound work (`if (window.X) X.f(this.y)`,
// ternaries, multi-statement, etc.) need a wrapper function that takes
// a single arg and does the original work. Each wrapper also fires
// `showToast` confirmation so users see the toggle reacting.
// ══════════════════════════════════════════════════════════════════════
function _nbdToast(msg, type) {
  if (typeof showToast === 'function') showToast(msg, type || 'info');
}

// ── Cross-device hydrate for one-way-written userSettings/{uid} fields ──
// nbdSetShapeStyle/nbdSetMaterial (below) write shapeStyle/materialStyle to
// userSettings/{uid} on every change, matching the merge write ThemeEngine
// already makes for the color theme — but until this helper, nothing ever
// read either field back. A rep's choice was durable on the device that
// made it (localStorage) and invisible everywhere else, despite the write
// succeeding every time and the commit message for both features claiming
// the preference "follows a rep across devices." Mirrors ThemeEngine.init()'s
// exact self-heal shape: local paint first (already done via
// shape-preboot.js/material-preboot.js + the boot IIFEs below), then a
// short poll for auth/Firestore to come up (may not exist yet at boot),
// then apply the server copy via `apply(remote, false)` — save=false so the
// hydrate doesn't echo an identical write straight back or toast a change
// the user sitting at this device didn't just make — but ONLY if it
// differs from what's already showing, so a same-session in-progress
// choice is never clobbered by a stale server read arriving late.
function _nbdHydratePrefFromFirestore(field, readCurrent, apply) {
  var tries = 0;
  function poll() {
    var uid, ok;
    try {
      uid = (window._user && window._user.uid) || null;
      ok = uid && window.db && window.getDoc && window.doc;
    } catch (e) { ok = false; }
    if (!ok) {
      if (++tries <= 10) setTimeout(poll, 500); // give up after ~5s
      return;
    }
    try {
      (window.nbdRetryOffline || function (f) { return f(); })(function () {
        return window.getDoc(window.doc(window.db, 'userSettings', uid));
      }).then(function (snap) {
        if (!snap.exists()) return;
        var remote = snap.data() && snap.data()[field];
        if (remote && remote !== readCurrent()) apply(remote);
      }).catch(function (err) { console.warn('[' + field + '] Firestore hydrate failed:', err.message); });
    } catch (e) {}
  }
  setTimeout(poll, 250);
}

// ── ThemeGX wrappers (GX = the glow/accent/animated-bg layer) ──
function nbdGxSetEnabled(on)     { if (window.ThemeGX) window.ThemeGX.setEnabled(!!on); _nbdToast('Theme Effects ' + (on ? 'ON' : 'OFF')); }
function nbdGxSetGlow(on)        { if (window.ThemeGX) window.ThemeGX.setGlow(!!on);    _nbdToast('Glow ' + (on ? 'ON' : 'OFF')); }
function nbdGxSetAnimatedBg(on)  { if (window.ThemeGX) window.ThemeGX.setAnimatedBg(!!on); _nbdToast('Animated background ' + (on ? 'ON' : 'OFF')); }
function nbdGxSetAccent(color)   { if (window.ThemeGX) window.ThemeGX.setAccent(color); _nbdToast('Accent: ' + color); }
function nbdGxSetIntensityFromSlider(pct) {
  var v = parseFloat(pct);
  if (window.ThemeGX && typeof window.ThemeGX.setIntensity === 'function') window.ThemeGX.setIntensity(v / 100);
  var lbl = document.getElementById('gxIntensityVal');
  if (lbl) lbl.textContent = Math.round(v) + '%';
}
// ── ThemeOverlays / ThemeSounds (visual effects + ambient audio) ──
function nbdOverlaysSetEnabled(on) { if (window.ThemeOverlays) window.ThemeOverlays.setEnabled(!!on); _nbdToast('Visual overlays ' + (on ? 'ON' : 'OFF')); }
function nbdSoundsSetEnabled(on)   { if (window.ThemeSounds)   window.ThemeSounds.setEnabled(!!on);   _nbdToast('Ambient sound ' + (on ? 'ON' : 'OFF')); }

// ── Shape & Depth (Settings > Appearance) ──
// Orthogonal to the color theme (data-theme) and spacing (data-density) —
// data-shape controls corner radius / elevation / motion character only.
// 'sharp' is the true no-op default: dashboard-app.css's :root tokens
// (--r-btn, --r-card, --r-input, --r-modal, --elevation-*) already equal
// today's real hardcoded values, so an absent attribute renders identically
// to before this feature existed. See shape-preboot.js for the pre-paint
// stamp that avoids a flash on load.
var NBD_SHAPE_STYLE_KEY = 'nbd_shape_style';
// clay / liquid / skeuo / spatial restyle the surface itself (css/shape-styles.css, 2026-10-01).
var NBD_SHAPE_STYLES = ['sharp', 'linear', 'pressed', 'soft', 'elevated', 'fluent', 'glass', 'tonal', 'clay', 'liquid', 'skeuo', 'spatial'];
// save=false is the hydrate-from-Firestore path (see _nbdHydratePrefFromFirestore
// below) — applies the remote value without echoing it straight back to
// Firestore and without toasting a change the user didn't just make.
function nbdSetShapeStyle(shape, save) {
  if (save === undefined) save = true;
  if (NBD_SHAPE_STYLES.indexOf(shape) === -1) shape = 'sharp';
  if (shape === 'sharp') document.documentElement.removeAttribute('data-shape');
  else document.documentElement.setAttribute('data-shape', shape);
  try { localStorage.setItem(NBD_SHAPE_STYLE_KEY, shape); } catch (e) {}
  if (save) {
    // Fire-and-forget cross-device sync, same merge write ThemeEngine.apply()
    // already makes for the color theme — local paint never waits on this.
    try {
      var uid = (window._user && window._user.uid) || null;
      if (uid && window.db && window.doc && window.setDoc) {
        window.setDoc(window.doc(window.db, 'userSettings', uid), { shapeStyle: shape }, { merge: true })
          .catch(function (err) { console.warn('[shape-style] Firestore sync failed:', err.message); });
      }
    } catch (e) {}
  }
  nbdSyncShapeStyleBtns(shape);
  if (save) _nbdToast('Shape: ' + shape.charAt(0).toUpperCase() + shape.slice(1));
}
// Paint the segmented control's active state. Called after a change, on
// Settings > Appearance hydrate (ui.js switchSettingsTab), and at boot.
function nbdSyncShapeStyleBtns(shape) {
  if (!shape) { try { shape = localStorage.getItem(NBD_SHAPE_STYLE_KEY) || 'sharp'; } catch (e) { shape = 'sharp'; } }
  document.querySelectorAll('.shape-style-btn').forEach(function (b) {
    var active = b.dataset.shape === shape;
    b.style.background = active ? 'var(--orange)' : 'var(--s)';
    b.style.color = active ? 'var(--accent-fg,#fff)' : 'var(--m)';
    b.style.borderColor = active ? 'var(--orange)' : 'var(--br)';
  });
}
document.addEventListener('DOMContentLoaded', function () {
  setTimeout(function () { nbdSyncShapeStyleBtns(); }, 200);
  _nbdHydratePrefFromFirestore(
    'shapeStyle',
    function () { try { return localStorage.getItem(NBD_SHAPE_STYLE_KEY) || 'sharp'; } catch (e) { return 'sharp'; } },
    function (remote) { nbdSetShapeStyle(remote, false); }
  );
});

// ── Comfort tab ternaries (boolean → enum string) ──
// nbdComfortSet takes (key, value) where value is an enum string. The
// inline handlers were `nbdComfortSet('motion', this.checked ? 'reduce' : 'normal')`
// etc. — we wrap each.
function nbdComfortSetMotion(on)     { if (typeof nbdComfortSet === 'function') nbdComfortSet('motion',    on ? 'reduce' : 'normal'); _nbdToast('Reduced motion ' + (on ? 'ON' : 'OFF')); }
function nbdComfortSetProMode(on)    { if (typeof nbdComfortSet === 'function') nbdComfortSet('proMode',   on ? '1'      : '0');      _nbdToast('Pro mode ' + (on ? 'ON' : 'OFF')); }
function nbdComfortSetCbSafe(on)     { if (typeof nbdComfortSet === 'function') nbdComfortSet('cbSafe',    on ? '1'      : '0');      _nbdToast('Color-blind palette ' + (on ? 'ON' : 'OFF')); }
function nbdComfortSetAutoTheme(on)  { if (typeof nbdComfortSet === 'function') nbdComfortSet('autoTheme', on ? '1'      : '0');      _nbdToast('Auto-theme ' + (on ? 'ON' : 'OFF')); }

// ── Other settings toggles (with confirmation toast) ──
// These wrap pre-existing global functions to add toast feedback so the
// user sees the toggle reacting even if the underlying effect is subtle.
function nbdSetCrmSecHeaderEnabledT(on) { if (typeof setCrmSecHeaderEnabled === 'function') setCrmSecHeaderEnabled(!!on); _nbdToast('Secondary header ' + (on ? 'ON' : 'OFF')); }
function nbdSetKanbanBoldHierarchyT(on) { if (typeof setKanbanBoldHierarchy === 'function') setKanbanBoldHierarchy(!!on); _nbdToast('Bold hierarchy ' + (on ? 'ON' : 'OFF')); }
function nbdSetCrmAutoCollapseT(on)     { if (typeof setCrmAutoCollapse === 'function')     setCrmAutoCollapse(!!on);     _nbdToast('Auto-collapse ' + (on ? 'ON' : 'OFF')); }

// ── Photos view: compound state mutations ──
function nbdSelectPhotoLead(leadId) {
  window._currentPhotoLeadId = leadId;
  if (window.PhotoEngine && typeof window.PhotoEngine.openGallery === 'function') {
    window.PhotoEngine.openGallery('photoGalleryContainer', leadId);
  }
}
function nbdTogglePhotosOnly(on) {
  window._photosOnlyWithPhotos = !!on;
  if (typeof renderPhotoLeads === 'function') renderPhotoLeads();
}

// ── Estimate compound: calcTierPrices + toggleInsuranceOverlay ──
// (We use data-on-after for this one — no wrapper needed; the dispatcher
// chains the second call.)

// ── D2D dispo filter (formerly inline onchange on the SELECT) ──
function d2dSetDispoFilter(value) {
  if (window.D2D && typeof window.D2D.setDispoFilter === 'function') {
    window.D2D.setDispoFilter(value);
  }
}

// ── Cal.com username live-preview (formerly an inline IIFE) ──
function nbdSettingsUpdateCalcomPreview(value) {
  var v = (value || '').trim().replace(/^@+/, '').replace(/\/+$/, '').toLowerCase();
  var p = document.getElementById('settingsCalcomPreview');
  if (p) {
    var url = v ? ('https://cal.com/' + v) : '';
    p.textContent = url;
    // The preview is an <a target=_blank> — textContent alone left it a
    // live-looking dead link (NEW-D45a). Keep href in step, same as the
    // bootstrap loaders that populate it from the saved user doc.
    if (url) { p.setAttribute('href', url); } else { p.removeAttribute('href'); }
    p.style.display = v ? '' : 'none';
  }
}

// ── Sidebar Customizer hidden-prefs — boot apply ──
// The customizer UI (js/dashboard-sidebar-customizer.js) ships inside the
// lazily-hydrated tpl-view-settings template, so its own apply only runs
// once the user first opens Settings → Appearance. Without this boot step,
// nav items the user hid all reappear on every fresh page load.
//
// Contract: this block only READS nbd_sidebar_hidden — the customizer
// stays the single writer (setItem/removeItem live there only).
//
// Timing: this file is a synchronous <script src> that executes BEFORE the
// static sidebar markup parses, so getElementById can't see the nav yet.
// Inject a <style> hide immediately (pre-paint, same no-flash ethos as the
// DE-MOJI boot above), then at DOMContentLoaded convert to the same inline
// display:none the customizer writes and remove the style tag. The handoff
// matters: applySidebarCustomizer() un-hides items by setting
// el.style.display = '' — a leftover stylesheet rule would override that
// and wedge items hidden until reload.
(function() {
  var hidden;
  try { hidden = JSON.parse(localStorage.getItem('nbd_sidebar_hidden') || '[]'); } catch (e) { hidden = []; }
  if (!Array.isArray(hidden)) hidden = [];
  // The ids feed a CSS selector — keep only sane element-id shapes.
  hidden = hidden.filter(function(id) { return /^[A-Za-z][A-Za-z0-9_-]*$/.test(String(id)); });
  if (!hidden.length) return;
  var st = document.createElement('style');
  st.id = 'nbdSidebarBootHide';
  st.textContent = hidden.map(function(id) { return '#' + id + '{display:none;}'; }).join('');
  (document.head || document.documentElement).appendChild(st);
  function _nbdSidebarBootFinalize() {
    if (_nbdSidebarBootFinalize._done) return;
    _nbdSidebarBootFinalize._done = true;
    hidden.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    st.remove();
  }
  // DOMContentLoaded is gated on every module/defer script finishing —
  // an early location.replace (auth gate, unauthenticated) can tear the
  // document down before it ever fires. Hook both ready events; first
  // one wins via the idempotence guard above.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _nbdSidebarBootFinalize);
    window.addEventListener('load', _nbdSidebarBootFinalize);
  } else {
    _nbdSidebarBootFinalize();
  }
})();

// ── Delegate registration (Tranche 2c) ──
// These handlers are dispatched from markup — data-fn / data-on-change /
// data-on-input in dashboard.html, the font-grid cards generated above,
// and the d2d dispo-filter select generated in d2d-tracker-ui-2026b.js —
// via the dashboard-ui.js dispatchers. Registering here instead of
// exposing each on window is what lets them live in module scope. The
// registry entry IS the security opt-in (the role an _NBD_CALL_ALLOWLIST
// entry used to play); tests/smoke/dashboard.test.js pins registration,
// markup wiring, and off-window status for every name below.
window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, {
  nbdSetSize: nbdSetSize,
  nbdSyncSizeBtns: nbdSyncSizeBtns,
  nbdApplyLegacyFont: nbdApplyLegacyFont,
  toggleProfessionalMode: toggleProfessionalMode,
  nbdSetSidebarLabels: nbdSetSidebarLabels,
  nbdGxSetEnabled: nbdGxSetEnabled,
  nbdGxSetGlow: nbdGxSetGlow,
  nbdGxSetAnimatedBg: nbdGxSetAnimatedBg,
  nbdGxSetAccent: nbdGxSetAccent,
  nbdGxSetIntensityFromSlider: nbdGxSetIntensityFromSlider,
  nbdOverlaysSetEnabled: nbdOverlaysSetEnabled,
  nbdSoundsSetEnabled: nbdSoundsSetEnabled,
  nbdComfortSetMotion: nbdComfortSetMotion,
  nbdComfortSetProMode: nbdComfortSetProMode,
  nbdComfortSetCbSafe: nbdComfortSetCbSafe,
  nbdComfortSetAutoTheme: nbdComfortSetAutoTheme,
  nbdSetCrmSecHeaderEnabledT: nbdSetCrmSecHeaderEnabledT,
  nbdSetKanbanBoldHierarchyT: nbdSetKanbanBoldHierarchyT,
  nbdSetCrmAutoCollapseT: nbdSetCrmAutoCollapseT,
  nbdSelectPhotoLead: nbdSelectPhotoLead,
  nbdTogglePhotosOnly: nbdTogglePhotosOnly,
  d2dSetDispoFilter: d2dSetDispoFilter,
  nbdSettingsUpdateCalcomPreview: nbdSettingsUpdateCalcomPreview,
  nbdSetMaterial: nbdSetMaterial,
  nbdSyncMaterialBtns: nbdSyncMaterialBtns,
  nbdSetShapeStyle: nbdSetShapeStyle,
  nbdSyncShapeStyleBtns: nbdSyncShapeStyleBtns
});

// ── Material: Shop Copy / Golden Hour (Settings > Appearance) ──
// A style axis alongside the color theme — status/identity treatment
// on the job pipeline, reusing the board's existing stage-aging classes
// (k-card-aging-warming/stale/critical, crm-pipeline.js) as the signal
// rather than a parallel status system. 'none' (default) is the no-op;
// the CSS in dashboard-app.css only activates under [data-material="..."].
var NBD_MATERIAL_KEY = 'nbd_material_style';
var NBD_MATERIALS = ['none', 'shop-copy', 'golden-hour'];
// save=false is the hydrate-from-Firestore path (see _nbdHydratePrefFromFirestore
// above) — applies the remote value without echoing it straight back to
// Firestore and without toasting a change the user didn't just make.
function nbdSetMaterial(material, save) {
  if (save === undefined) save = true;
  if (NBD_MATERIALS.indexOf(material) === -1) material = 'none';
  if (material === 'none') document.documentElement.removeAttribute('data-material');
  else document.documentElement.setAttribute('data-material', material);
  try { localStorage.setItem(NBD_MATERIAL_KEY, material); } catch (e) {}
  if (material === 'shop-copy') {
    var href = 'https://fonts.googleapis.com/css2?family=Big+Shoulders+Stencil:wght@700;800&display=swap';
    if (!document.querySelector('link[href="' + href + '"]')) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      document.head.appendChild(link);
    }
  }
  if (save) {
    try {
      var uid = (window._user && window._user.uid) || null;
      if (uid && window.db && window.doc && window.setDoc) {
        window.setDoc(window.doc(window.db, 'userSettings', uid), { materialStyle: material }, { merge: true })
          .catch(function (err) { console.warn('[material-style] Firestore sync failed:', err.message); });
      }
    } catch (e) {}
  }
  nbdSyncMaterialBtns(material);
  if (save) {
    var label = material === 'none' ? 'None' : material === 'shop-copy' ? 'Shop Copy' : 'Golden Hour';
    _nbdToast('Material: ' + label);
  }
}
function nbdSyncMaterialBtns(material) {
  if (!material) { try { material = localStorage.getItem(NBD_MATERIAL_KEY) || 'none'; } catch (e) { material = 'none'; } }
  document.querySelectorAll('.material-style-btn').forEach(function (b) {
    var active = b.dataset.material === material;
    b.style.background = active ? 'var(--orange)' : 'var(--s)';
    b.style.color = active ? 'var(--accent-fg,#fff)' : 'var(--m)';
    b.style.borderColor = active ? 'var(--orange)' : 'var(--br)';
  });
}
document.addEventListener('DOMContentLoaded', function () {
  setTimeout(function () {
    nbdSyncMaterialBtns();
    // A saved shop-copy preference from a prior session needs its font
    // loaded on this boot too — a fresh in-session choice loads it from
    // inside nbdSetMaterial itself. save=false: this is re-applying an
    // already-persisted preference, not a new user action, so it must not
    // re-toast "Material: Shop Copy" (previously fired, wrongly, on every
    // single page load for a shop-copy user) or echo an identical write
    // back to Firestore.
    try { if (localStorage.getItem(NBD_MATERIAL_KEY) === 'shop-copy') nbdSetMaterial('shop-copy', false); } catch (e) {}
  }, 200);
  _nbdHydratePrefFromFirestore(
    'materialStyle',
    function () { try { return localStorage.getItem(NBD_MATERIAL_KEY) || 'none'; } catch (e) { return 'none'; } },
    function (remote) { nbdSetMaterial(remote, false); }
  );
});
})();
