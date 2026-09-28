/**
 * maps.js — thin shim for the maps surface.
 *
 * Step 4d (2026-05-16) split the original 4254-line maps.js into
 * three sibling modules:
 *
 *   maps-core.js     — Leaflet init, overlay state, geodetic helpers
 *   maps-overlays.js — pins, jobs/storm/weather tiles, search,
 *                      damage-near-me, popups
 *   maps-routing.js  — drawing tool v2, structures/facets, zones,
 *                      accessories, solar, voice, presentation
 *
 * What still lives here:
 *   - NBD UNIFIED APPEARANCE ENGINE (theme/font picker — shared
 *     by pro/dashboard.html + pro/daily-success/index.html; kept
 *     bundled with maps.js as it has always been)
 *   - window.* exports for the public surface every other script
 *     calls into (smart-calendar.js depends on window.hav!)
 *   - the DOMContentLoaded handler that closes the nbd-howto-modal
 *     on overlay click
 *   - the nbdBoot IIFE that paints the saved theme + font BEFORE
 *     first paint
 *
 * Load order locked in dashboard.html:
 *
 *   core → overlays → routing → maps (shim)
 *
 * Classic-script (non-ESM) — every function called below is a
 * sibling-scope global declared in one of the three split modules.
 */

/* ── NBD UNIFIED APPEARANCE ENGINE (inlined) ── */
/* ═══════════════════════════════════════════════════════════════════
   NBD UNIFIED APPEARANCE ENGINE v1.0
   Shared by: pro/dashboard.html + pro/daily-success/index.html
   DO NOT EDIT independently in each file — keep in sync.
   ═══════════════════════════════════════════════════════════════════ */

/* ── THEME REGISTRY (100 themes) ──────────────────────────────────── */
let _NBD_MP_DELEGATE; // module-local (globals Tranche 1 — was window.*)
const NBD_THEMES = [
  // STANDARD
  {id:'default',          name:'NBD Default',       cat:'standard', plan:'blueprint', accent:'#BD5728', bg:'#0A0C0F', s:'#13171d', jp:true},
  {id:'matrix',           name:'Matrix',            cat:'standard', plan:'blueprint', accent:'#00ff41', bg:'#000300', s:'#000800'},
  {id:'neon',             name:'Neon',              cat:'standard', plan:'foundation',accent:'#ff00ff', bg:'#08000f', s:'#120018'},
  {id:'galaxy',           name:'Galaxy',            cat:'standard', plan:'foundation',accent:'#9c27b0', bg:'#06000e', s:'#0e0020'},
  {id:'space',            name:'Space',             cat:'standard', plan:'blueprint', accent:'#4fc3f7', bg:'#000508', s:'#000e18'},
  {id:'ghost',            name:'Ghost',             cat:'standard', plan:'blueprint', accent:'#aab8e0', bg:'#050810', s:'#0c1020'},
  {id:'glow',             name:'Glow',              cat:'standard', plan:'blueprint', accent:'#ff6d00', bg:'#050200', s:'#0e0600'},
  {id:'grayscale',        name:'Grayscale',         cat:'standard', plan:'blueprint', accent:'#c8c8c8', bg:'#0a0a0a', s:'#141414'},
  {id:'blackwhite',       name:'Black & White',     cat:'standard', plan:'blueprint', accent:'#ffffff', bg:'#000000', s:'#0a0a0a'},
  {id:'old-timey',        name:'Old Timey',         cat:'standard', plan:'blueprint', accent:'#c8840a', bg:'#1e1408', s:'#2c1e10'},
  // HEROES
  {id:'batman',           name:'Batman',            cat:'heroes',   plan:'foundation',accent:'#f5c518', bg:'#080808', s:'#111115', jp:true},
  {id:'superman',         name:'Superman',          cat:'heroes',   plan:'foundation',accent:'#e53935', bg:'#030060', s:'#050090'},
  {id:'captain-america',  name:'Captain America',  cat:'heroes',   plan:'foundation',accent:'#b71c1c', bg:'#030a20', s:'#071430'},
  {id:'wolverine',        name:'Wolverine',         cat:'heroes',   plan:'infused',   accent:'#ffd600', bg:'#0e0a00', s:'#1e1600'},
  {id:'magneto',          name:'Magneto',           cat:'heroes',   plan:'infused',   accent:'#ce0000', bg:'#0e000a', s:'#1e0018'},
  {id:'darth-vader',      name:'Darth Vader',       cat:'heroes',   plan:'foundation',accent:'#cc0000', bg:'#000000', s:'#080808', jp:true},
  {id:'stormtrooper',     name:'Stormtrooper',      cat:'heroes',   plan:'foundation',accent:'#111118', bg:'#f2f2f4', s:'#ffffff', lt:true},
  {id:'lightsaber',       name:'Lightsaber',        cat:'heroes',   plan:'foundation',accent:'#00e5ff', bg:'#000508', s:'#000d14'},
  {id:'halo',             name:'Halo',              cat:'heroes',   plan:'foundation',accent:'#00e676', bg:'#010a04', s:'#031408'},
  // GAMING
  {id:'pokemon',          name:'Pokémon',           cat:'gaming',   plan:'foundation',accent:'#ffcc02', bg:'#12223D', s:'#16213e'},
  {id:'mario',            name:'Mario',             cat:'gaming',   plan:'foundation',accent:'#e52222', bg:'#1a0800', s:'#2e1200'},
  {id:'mario-underground',name:'Mario Underground',cat:'gaming',   plan:'infused',   accent:'#6666ff', bg:'#000018', s:'#00002e'},
  {id:'kirby',            name:'Kirby',             cat:'gaming',   plan:'infused',   accent:'#ff4081', bg:'#120008', s:'#200014'},
  {id:'zelda',            name:'Zelda',             cat:'gaming',   plan:'infused',   accent:'#c8a800', bg:'#060e00', s:'#0e1c00'},
  {id:'megaman',          name:'Mega Man',          cat:'gaming',   plan:'infused',   accent:'#00a8e8', bg:'#00060e', s:'#000e20'},
  {id:'digimon',          name:'Digimon',           cat:'gaming',   plan:'team',      accent:'#ff6600', bg:'#0a0014', s:'#160028'},
  {id:'lego',             name:'Lego',              cat:'gaming',   plan:'team',      accent:'#ffd700', bg:'#0c0c00', s:'#1c1c00'},
  {id:'retro',            name:'Retro',             cat:'gaming',   plan:'blueprint', accent:'#ff8c00', bg:'#120a00', s:'#201400'},
  {id:'arcade',           name:'Arcade',            cat:'gaming',   plan:'blueprint', accent:'#ff0055', bg:'#000018', s:'#000030', jp:true},
  // OS / TECH
  {id:'android',          name:'Android',           cat:'os',       plan:'blueprint', accent:'#4caf50', bg:'#0a0f0a', s:'#141c14'},
  {id:'ios',              name:'iOS',               cat:'os',       plan:'blueprint', accent:'#0a84ff', bg:'#000000', s:'#1c1c1e'},
  {id:'ios26',            name:'iOS 26',            cat:'os',       plan:'foundation',accent:'#30d158', bg:'#050508', s:'#0e0e14', jp:true},
  {id:'windows',          name:'Windows',           cat:'os',       plan:'foundation',accent:'#0078d4', bg:'#001828', s:'#002040'},
  {id:'terminal',         name:'Terminal',          cat:'os',       plan:'blueprint', accent:'#00ff00', bg:'#000000', s:'#0a0a0a'},
  // MATERIAL
  {id:'liquid',           name:'Liquid',            cat:'material', plan:'foundation',accent:'#78c8e8', bg:'#080c12', s:'#101820'},
  {id:'material-metal',   name:'Metal',             cat:'material', plan:'team',      accent:'#c8ccd8', bg:'#0e0e10', s:'#1a1a1e'},
  {id:'translucent',      name:'Translucent',       cat:'material', plan:'infused',   accent:'#e8eeff', bg:'#030408', s:'#080c14'},
  {id:'frosted',          name:'Frosted',           cat:'material', plan:'infused',   accent:'#5064c8', bg:'#e8eaf2', s:'#f0f2fa', lt:true},
  {id:'glass',            name:'Glass',             cat:'material', plan:'team',      accent:'#64c8f8', bg:'#010610', s:'#081828'},
  // AMBIENT / MOOD
  {id:'candlelit',        name:'Candlelit',         cat:'ambient',  plan:'blueprint', accent:'#e8820a', bg:'#0c0600', s:'#180e00', jp:true},
  {id:'ember',            name:'Ember',             cat:'ambient',  plan:'blueprint', accent:'#ff4500', bg:'#0a0300', s:'#160800'},
  {id:'midnight-oil',     name:'Midnight Oil',      cat:'ambient',  plan:'foundation',accent:'#d4900a', bg:'#060402', s:'#100c06'},
  {id:'deep-focus',       name:'Deep Focus',        cat:'ambient',  plan:'foundation',accent:'#0d9488', bg:'#020404', s:'#060c0c'},
  {id:'neon-rain',        name:'Neon Rain',         cat:'ambient',  plan:'infused',   accent:'#ff2d9b', bg:'#06000e', s:'#0e0018'},
  {id:'noir',             name:'Noir',              cat:'ambient',  plan:'team',      accent:'#d8cfa8', bg:'#080604', s:'#121008'},
  {id:'blood-moon',       name:'Blood Moon',        cat:'ambient',  plan:'team',      accent:'#e8001a', bg:'#080002', s:'#140006'},
  {id:'aurora',           name:'Aurora',            cat:'ambient',  plan:'infused',   accent:'#00ffc0', bg:'#020810', s:'#040e18'},
  {id:'obsidian',         name:'Obsidian',          cat:'ambient',  plan:'infused',   accent:'#8b5cf6', bg:'#06040a', s:'#0e0c14'},
  {id:'copper',           name:'Copper',            cat:'ambient',  plan:'foundation',accent:'#b87333', bg:'#0c0800', s:'#1a1200'},
  {id:'sakura',           name:'Sakura',            cat:'ambient',  plan:'team',      accent:'#e8346c', bg:'#fff0f4', s:'#ffe8f0', lt:true},
  // ABSTRACT
  {id:'typewriter',       name:'Typewriter',        cat:'abstract', plan:'blueprint', accent:'#8b4513', bg:'#f0e8d4', s:'#e8dfc8', lt:true},
  {id:'ink',              name:'Ink',               cat:'abstract', plan:'blueprint', accent:'#0f0a04', bg:'#f5f0e8', s:'#ece6d8', lt:true},
  {id:'brutalist',        name:'Brutalist',         cat:'abstract', plan:'command',   accent:'#000000', bg:'#e8e8e8', s:'#ffffff', lt:true},
  {id:'vapor',            name:'Vaporwave',         cat:'abstract', plan:'infused',   accent:'#ff71ce', bg:'#0a0014', s:'#140028'},
  {id:'chalk',            name:'Chalk',             cat:'abstract', plan:'team',      accent:'#f8f8f8', bg:'#12223D', s:'#202040'},
  {id:'blueprint-art',    name:'Blueprint',         cat:'abstract', plan:'foundation',accent:'#ffffff', bg:'#001428', s:'#001e3c'},
  // TACTICAL
  {id:'army',             name:'Army',              cat:'tactical', plan:'infused',   accent:'#6a8c2a', bg:'#060a02', s:'#0e1808'},
  {id:'cia',              name:'CIA',               cat:'tactical', plan:'infused',   accent:'#c8a000', bg:'#020202', s:'#0c0c0c'},
  {id:'fbi',              name:'FBI',               cat:'tactical', plan:'infused',   accent:'#c0c8d8', bg:'#000410', s:'#000820'},
  {id:'ninja',            name:'Ninja',             cat:'tactical', plan:'foundation',accent:'#cc0000', bg:'#040400', s:'#0c0c00'},
  {id:'stoic',            name:'Stoic',             cat:'tactical', plan:'blueprint', accent:'#8a8a8a', bg:'#080808', s:'#101010'},
  // SEASONAL
  {id:'halloween',        name:'Halloween',         cat:'seasonal', plan:'blueprint', accent:'#ff6d00', bg:'#080200', s:'#100400'},
  {id:'christmas',        name:'Christmas',         cat:'seasonal', plan:'blueprint', accent:'#e53935', bg:'#000e04', s:'#001808'},
  {id:'easter',           name:'Easter',            cat:'seasonal', plan:'blueprint', accent:'#9c27b0', bg:'#f0e8f8', s:'#ffe8f8', lt:true},
  {id:'thanksgiving',     name:'Thanksgiving',      cat:'seasonal', plan:'blueprint', accent:'#bf6000', bg:'#120800', s:'#201200'},
  {id:'usa',              name:'USA',               cat:'seasonal', plan:'blueprint', accent:'#cc0000', bg:'#010614', s:'#020c28'},
  // NATURE
  {id:'underwater',       name:'Underwater',        cat:'nature',   plan:'foundation',accent:'#00e5cc', bg:'#000c14', s:'#001828'},
  {id:'forest',           name:'Forest',            cat:'nature',   plan:'infused',   accent:'#4caf50', bg:'#010a02', s:'#03140a'},
  {id:'ocean',            name:'Ocean',             cat:'nature',   plan:'infused',   accent:'#1565c0', bg:'#000612', s:'#000e22'},
  {id:'desert',           name:'Desert',            cat:'nature',   plan:'infused',   accent:'#d4870a', bg:'#100800', s:'#201400'},
  {id:'storm',            name:'Storm',             cat:'nature',   plan:'infused',   accent:'#7eb8f7', bg:'#04060e', s:'#080e18'},
  {id:'tundra',           name:'Tundra',            cat:'nature',   plan:'team',      accent:'#a8e8f0', bg:'#040e1c', s:'#081a2e'},
  {id:'volcanic',         name:'Volcanic',          cat:'nature',   plan:'team',      accent:'#ff3d00', bg:'#120000', s:'#220000'},
  // MUSIC
  {id:'hiphop',           name:'Hip Hop',           cat:'music',    plan:'team',      accent:'#ffd600', bg:'#08040c', s:'#120818'},
  {id:'jazz',             name:'Jazz',              cat:'music',    plan:'team',      accent:'#d4a020', bg:'#0e0800', s:'#1e1400'},
  {id:'metal',            name:'Heavy Metal',       cat:'music',    plan:'team',      accent:'#888888', bg:'#000000', s:'#080808'},
  {id:'synthwave',        name:'Synthwave',         cat:'music',    plan:'infused',   accent:'#f706cf', bg:'#0d0018', s:'#180030'},
  {id:'lofi',             name:'Lo-Fi',             cat:'music',    plan:'foundation',accent:'#c8a878', bg:'#f2ede4', s:'#ebe4d8', lt:true},
  {id:'punk',             name:'Punk',              cat:'music',    plan:'team',      accent:'#ff1744', bg:'#0e0000', s:'#1e0000'},
  // REGION
  {id:'japan',            name:'Japan',             cat:'region',   plan:'team',      accent:'#c41c24', bg:'#0a0608', s:'#180e12'},
  {id:'viking',           name:'Viking',            cat:'region',   plan:'team',      accent:'#9a7c28', bg:'#080c14', s:'#101820'},
  {id:'roman',            name:'Roman',             cat:'region',   plan:'team',      accent:'#c8960a', bg:'#100e08', s:'#1e1c10'},
  {id:'wildwest',         name:'Wild West',         cat:'region',   plan:'command',   accent:'#c87840', bg:'#120a00', s:'#201400'},
  {id:'samurai',          name:'Samurai',           cat:'region',   plan:'command',   accent:'#cc2200', bg:'#080208', s:'#120810'},
  {id:'pharaoh',          name:'Pharaoh',           cat:'region',   plan:'command',   accent:'#c8980a', bg:'#0e0c00', s:'#1e1c00'},
  // CULTURE
  {id:'american-dad',     name:'American Dad',      cat:'culture',  plan:'command',   accent:'#e53935', bg:'#010614', s:'#030e28'},
  {id:'family-guy',       name:'Family Guy',        cat:'culture',  plan:'command',   accent:'#f5c518', bg:'#001020', s:'#001c38'},
  {id:'south-park',       name:'South Park',        cat:'culture',  plan:'command',   accent:'#ff8c00', bg:'#08100a', s:'#101e12'},
];

/* ── FONT PAIRINGS (8 fonts) ──────────────────────────────────────── */
const NBD_FONTS = [
  { id:'nbd-default',    name:'NBD Default',    plan:'blueprint', css:{fd:"'Bebas Neue',sans-serif",   fu:"'Barlow Condensed',sans-serif", fb:"'Barlow',sans-serif",          fm:"'DM Mono',monospace"},          preview:{d:'NBD PRO', b:'Sharp. Direct. Built for the field.'} },
  { id:'operator',       name:'Operator',       plan:'foundation',css:{fd:"'Unbounded',sans-serif",     fu:"'Unbounded',sans-serif",        fb:"'Inter',sans-serif",            fm:"'JetBrains Mono',monospace"},    preview:{d:'NBD PRO', b:'Technical. Futuristic. Command-grade.'} },
  { id:'editorial',      name:'Editorial',      plan:'infused',   css:{fd:"'Playfair Display',serif",   fu:"'Barlow Condensed',sans-serif", fb:"'Barlow',sans-serif",          fm:"'IBM Plex Mono',monospace"},     preview:{d:'NBD Pro', b:'Refined. Authoritative. Premium feel.'} },
  { id:'terminal-font',  name:'Terminal',       plan:'blueprint', css:{fd:"'Share Tech Mono',monospace",fu:"'Share Tech Mono',monospace",   fb:"'Share Tech Mono',monospace",   fm:"'Share Tech Mono',monospace"},   preview:{d:'> NBD_PRO', b:'All mono. Pure signal. Zero noise.'} },
  { id:'typewriter-font',name:'Typewriter',     plan:'foundation',css:{fd:"'Courier Prime',monospace",  fu:"'Barlow Condensed',sans-serif", fb:"'Courier Prime',monospace",     fm:"'Courier Prime',monospace"},     preview:{d:'NBD PRO', b:'Worn-in. Tactile. Old iron feel.'} },
  { id:'syne',           name:'Syne / Exo',     plan:'team',      css:{fd:"'Syne',sans-serif",           fu:"'Exo 2',sans-serif",            fb:"'Exo 2',sans-serif",            fm:"'JetBrains Mono',monospace"},    preview:{d:'NBD PRO', b:'Geometric. Modern. Interface-native.'} },
  { id:'chakra',         name:'Chakra Petch',   plan:'infused',   css:{fd:"'Chakra Petch',sans-serif",  fu:"'Chakra Petch',sans-serif",     fb:"'Barlow',sans-serif",           fm:"'Space Mono',monospace"},        preview:{d:'NBD PRO', b:'Military-tech. Tactical. Clean edge.'} },
  { id:'classic',        name:'Classic Serif',  plan:'command',   css:{fd:"'Anton',sans-serif",          fu:"'Barlow Condensed',sans-serif", fb:"'Libre Baskerville',serif",     fm:"'IBM Plex Mono',monospace"},     preview:{d:'NBD PRO', b:'Heavy headline. Old press authority.'} },
];

/* ── STATE ────────────────────────────────────────────────────────── */
const NBD_PLAN_ORDER  = ['blueprint','foundation','infused','team','command'];
// Read actual plan from window._userPlan (set by subscription check above)
// Fallback to 'blueprint' (lowest tier) if not set
const NBD_USER_PLAN   = window._userPlan || 'blueprint';
let _nbd_activeTheme  = localStorage.getItem('nbd-theme') || 'default';
let _nbd_activeFont   = localStorage.getItem('nbd-font')  || 'nbd-default';
let _nbd_activeCat    = 'all';
let _nbd_customs      = JSON.parse(localStorage.getItem('nbd-customs') || '[]');

// All themes/fonts unlocked — single-tier mode (no plan gating)
const _nbdUnlocked  = p => true;
const _nbdGetTheme  = id => [...NBD_THEMES, ..._nbd_customs].find(t => t.id === id);

/* ── APPLY THEME ──────────────────────────────────────────────────── */
function nbdApplyTheme(id) {
  // Single-authority convergence (audit F-1): on surfaces that load the modern
  // ThemeEngine (the dashboard sets window.NBD_THEME_ENGINE), delegate to it so
  // the two engines don't both write data-theme + inline vars and fight. The
  // legacy 'default' id maps to the engine's 'nbd-original'. daily-success and
  // the standalone maps surface don't set the flag, so they keep legacy behavior.
  if (window.NBD_THEME_ENGINE && window.ThemeEngine) {
    // Trust the key the engine ACTUALLY applied, not the one we requested: a
    // locked theme bounces to the default, so syncing on the requested id would
    // leave the picker highlighting a theme that isn't showing (PR #557 F-3).
    let applied = id === 'default' ? 'nbd-original' : id;
    try { const r = window.ThemeEngine.apply(applied, true); if (r) applied = r; } catch (e) {}
    // Map the engine's canonical default back to this surface's legacy id.
    const legacyId = applied === 'nbd-original' ? 'default' : applied;
    _nbd_activeTheme = legacyId;
    const lt = _nbdGetTheme(legacyId);
    if (lt) _nbdUpdateLabels(lt);
    if (typeof nbdRenderThemes === 'function') nbdRenderThemes();
    return;
  }
  const t = _nbdGetTheme(id);
  if (!t) return;
  if (!_nbdUnlocked(t.plan) && t.cat !== 'custom') {
    nbdToast('🔒 Requires ' + t.plan + ' plan');
    return;
  }
  // 1. body class (v5 system)
  document.body.className = id === 'default' ? '' : 'theme-' + id;
  // 2. data-theme attr (v3 system)
  document.documentElement.setAttribute('data-theme', id);
  // 3. Force --ac + legacy DS vars immediately
  const R = document.documentElement.style;
  R.setProperty('--ac',     t.accent);
  R.setProperty('--orange', t.accent);
  R.setProperty('--gold',   t.accent);
  // bg/surface for DS pages that use --bg/--bar
  R.setProperty('--bg',  t.bg  || '#0A0C0F');
  R.setProperty('--bar', t.s   || '#13171d');
  // 4. Persist
  _nbd_activeTheme = id;
  localStorage.setItem('nbd-theme', id);
  // 5. Firestore sync (if auth available)
  try {
    if (typeof db !== 'undefined' && typeof currentUser !== 'undefined' && currentUser) {
      db.collection('users').doc(currentUser.uid).set({ theme: id }, { merge: true });
    }
  } catch(e) {}
  // 6. UI
  _nbdUpdateLabels(t);
  nbdRenderThemes();
  nbdToast('✓ ' + t.name);
}

/* ── APPLY FONT ───────────────────────────────────────────────────── */
// opts.silent: boot-time restore of the saved font — no toast. Announcing
// "✓ Font: NBD Default" on every page load covered the phone tab bar.
function nbdApplyFont(id, opts) {
  const silent = !!(opts && opts.silent);
  const f = NBD_FONTS.find(f => f.id === id);
  if (!f) return;
  if (!_nbdUnlocked(f.plan)) { if (!silent) nbdToast('🔒 Font requires ' + f.plan + ' plan'); return; }
  const R = document.documentElement.style;
  R.setProperty('--fd', f.css.fd);
  R.setProperty('--fu', f.css.fu);
  R.setProperty('--fb', f.css.fb);
  R.setProperty('--fm', f.css.fm);
  document.body.style.fontFamily = f.css.fb;
  _nbd_activeFont = id;
  localStorage.setItem('nbd-font', id);
  nbdRenderFonts();
  if (!silent) nbdToast('✓ Font: ' + f.name);
}

/* ── LABELS ───────────────────────────────────────────────────────── */
function _nbdUpdateLabels(t) {
  const badge = document.getElementById('abadge') || document.querySelector('.tbb');
  if (badge) badge.textContent = t.name.toUpperCase();
  const nl = document.getElementById('npm-active-name');
  if (nl) nl.textContent = t.name;
  // Fonts moved to Settings → Appearance, so the picker sub-label now just
  // tracks the active theme (no font name).
  const ns = document.getElementById('npm-active-sub');
  if (ns) ns.textContent = t.name;
}

/* ── PICKER MODAL ─────────────────────────────────────────────────── */
function nbdPickerOpen()  {
  // Dashboard's 189-theme engine is a lazy bundle (2026-08-07): opening the
  // picker before it arrives kicks the load and re-renders the grid on
  // resolve. Customer page (no NBD_THEME_ENGINE flag) keeps the legacy grid.
  if (window.NBD_THEME_ENGINE && !window.ThemeEngine
      && window.ScriptLoader && window.ScriptLoader.loadBundle) {
    window.ScriptLoader.loadBundle('theme').then(() => {
      try { _nbdSyncActiveLabels(); nbdRenderCats(); nbdRenderThemes(); } catch (e) {}
    });
  }
  document.getElementById('nbd-picker-modal').classList.add('open'); _nbdSyncActiveLabels(); nbdRenderCats(); nbdRenderThemes();
}
// Re-sync the header sub-label + footer "Active:" label to the LIVE applied
// theme. On the dashboard (window.ThemeEngine) the saved theme is applied
// by ThemeEngine.init()/theme-init.js, NOT via nbdApplyTheme, so _nbdUpdateLabels
// never ran at boot and the static HTML default ("NBD Default") would otherwise
// show even when data-theme is e.g. 'ios' (NEW-C8). Read TE.getCurrent() so the
// label tracks the real applied key; fall back to the legacy _nbd_activeTheme.
function _nbdSyncActiveLabels() {
  const TE = window.ThemeEngine;
  if (TE) {
    const key = TE.getCurrent() || 'nbd-original';
    const t = (TE.get && TE.get(key)) || null;
    _nbdUpdateLabels({ name: t && t.name ? t.name : key });
  } else {
    const t = _nbdGetTheme(_nbd_activeTheme);
    if (t) _nbdUpdateLabels(t);
  }
}
function nbdPickerClose() { document.getElementById('nbd-picker-modal').classList.remove('open'); }

// Add modal click handler after DOM loads
const pickerModal = document.getElementById('nbd-picker-modal');
if (pickerModal) {
  pickerModal.addEventListener('click', function(e) { if (e.target === this) nbdPickerClose(); });
}

function nbdPickerTab(tab, el) {
  document.querySelectorAll('.npm-tab').forEach(t => t.classList.remove('on'));
  el.classList.add('on');
  document.querySelectorAll('.npm-panel').forEach(p => p.classList.remove('on'));
  document.getElementById('npm-panel-' + tab).classList.add('on');
}

/* ── RENDER THEMES ────────────────────────────────────────────────── */
function nbdRenderThemes() {
  const grid = document.getElementById('npm-grid');
  if (!grid) return;
  const q = (document.getElementById('npm-search')?.value || '').toLowerCase();
  const TE = window.ThemeEngine;

  if (TE) {
    // ThemeEngine path: 155 themes with multi-color cards
    const allThemes = TE.getAll();
    const current = TE.getCurrent() || 'nbd-original';
    let entries = Object.entries(allThemes);
    if (_nbd_activeCat !== 'all') entries = entries.filter(([,t]) => t.category === _nbd_activeCat);
    if (q) entries = entries.filter(([k,t]) => t.name.toLowerCase().includes(q) || k.includes(q));
    if (!entries.length) { grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:32px;font-size:11px;color:var(--m);">No themes found.</div>'; return; }
    grid.innerHTML = '';
    entries.forEach(([key, t]) => {
      const isAct = key === current;
      const isLocked = t.locked && !(TE.isUnlocked && TE.isUnlocked(key));
      const bg = t.colors?.bg || '#12223D';
      const accent = t.colors?.accent || '#BD5728';
      const surface = t.colors?.surface || '#16213e';
      const txt = t.colors?.text || '#e2e8f0';
      const d = document.createElement('div');
      d.className = 'npm-bubble' + (isAct ? ' active' : '') + (isLocked ? ' locked' : '');
      d.onclick = () => { if (!isLocked) { applyTheme(key); nbdPickerClose(); } else nbdToast('🔒 Locked — earn this theme'); };
      d.style.cssText = `background:${bg};border-color:${accent};box-shadow:inset 0 0 0 1px ${accent}33;opacity:${isLocked?'0.4':'1'};`;
      if (isAct) d.style.boxShadow = '0 0 0 2.5px #fff, 0 4px 22px rgba(0,0,0,0.6)';
      const dots = `<div style="display:flex;gap:3px;margin-bottom:3px;"><span style="width:8px;height:8px;border-radius:50%;background:${accent};display:block;"></span><span style="width:8px;height:8px;border-radius:50%;background:${surface};display:block;"></span>${t.colors?.accent2?`<span style="width:8px;height:8px;border-radius:50%;background:${t.colors.accent2};display:block;"></span>`:''}</div>`;
      const overlay = (t.overlay?.type && t.overlay.type !== 'none') ? '<span style="font-size:7px;position:absolute;top:3px;right:5px;color:'+txt+'44;">✦</span>' : '';
      d.innerHTML = `${dots}<span class="npm-lbl" style="color:${txt}">${isLocked?'🔒 ':''}${t.name}</span>${overlay}<div class="npm-activedot"></div>`;
      grid.appendChild(d);
    });
  } else {
    // Legacy path
    let list = [...NBD_THEMES, ..._nbd_customs];
    if (_nbd_activeCat !== 'all') list = list.filter(t => t.cat === _nbd_activeCat);
    if (q) list = list.filter(t => t.name.toLowerCase().includes(q));
    if (!list.length) { grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:32px;font-size:11px;color:#5a6478;">No themes found.</div>'; return; }
    grid.innerHTML = '';
    list.forEach(t => {
      const ok = _nbdUnlocked(t.plan) || t.cat === 'custom';
      const isAct = t.id === _nbd_activeTheme;
      const hexLum = h => { const n=parseInt((h||'#000').replace('#',''),16); const r=((n>>16)&255)/255,g=((n>>8)&255)/255,b=(n&255)/255; const tl=c=>c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4); return 0.2126*tl(r)+0.7152*tl(g)+0.0722*tl(b); };
      const textCol = hexLum(t.bg||'#000') > 0.12 ? '#1a1208' : '#e8eaf0';
      const d = document.createElement('div');
      d.className = 'npm-bubble' + (isAct ? ' active' : '') + (ok ? '' : ' locked');
      d.onclick = () => { if (ok) nbdApplyTheme(t.id); else nbdToast('🔒 ' + t.plan + ' required'); };
      d.style.cssText = `background:${t.s||'#13171d'};border-color:${t.accent};box-shadow:inset 0 0 0 1px ${t.accent}33;`;
      if (isAct) d.style.boxShadow = '0 0 0 2.5px #fff, 0 4px 22px rgba(0,0,0,0.6)';
      d.innerHTML = `<div class="npm-dot" style="background:${t.accent};box-shadow:0 0 5px ${t.accent}88"></div><span class="npm-lbl" style="color:${textCol}">${t.name}</span>${t.jp?`<span class="npm-star" style="color:${t.accent}">★</span>`:''}<div class="npm-activedot"></div>${!ok?'<div class="npm-lock-overlay">🔒</div>':''}`;
      grid.appendChild(d);
    });
  }
}

function nbdRenderCats() {
  const el = document.getElementById('npm-cats');
  if (!el) return;
  const TE = window.ThemeEngine;
  if (TE) {
    // ThemeEngine categories
    const teCats = [{key:'all',label:'All',icon:''},...TE.getCategories()];
    // Self-heal: if the active cat isn't in TE's list (e.g. left over
    // from the legacy fallback that ran before TE loaded), snap back
    // to 'all' so the grid actually shows themes.
    if (!teCats.some(c => c.key === _nbd_activeCat)) _nbd_activeCat = 'all';
    el.innerHTML = teCats.map(c => `<button class="npm-cat${_nbd_activeCat===c.key?' on':''}" data-mp-action="setCat" data-mp-id="${c.key}">${c.icon?c.icon+' ':''}${c.label}</button>`).join('');
  } else {
    const cats = ['all','standard','heroes','gaming','os','material','ambient','abstract','tactical','nature','music','region','seasonal','culture','custom'];
    const labels = {all:'All',standard:'Standard',heroes:'Heroes',gaming:'Gaming',os:'OS/Tech',material:'Material',ambient:'Ambient',abstract:'Abstract',tactical:'Tactical',nature:'Nature',music:'Music',region:'Region',seasonal:'Seasonal',culture:'Culture',custom:'⚡ Custom'};
    el.innerHTML = cats.map(c => `<button class="npm-cat${_nbd_activeCat===c?' on':''}" data-mp-action="setCat" data-mp-id="${c}">${labels[c]||c}</button>`).join('');
  }
}

function nbdSetCat(cat, el) {
  _nbd_activeCat = cat;
  document.querySelectorAll('.npm-cat').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
  nbdRenderThemes();
}

function nbdRandom() {
  const TE = window.ThemeEngine;
  if (TE) {
    const keys = Object.keys(TE.getAll()).filter(k => { const t = TE.get(k); return !t.locked || TE.isUnlocked(k); });
    applyTheme(keys[Math.floor(Math.random() * keys.length)]);
  } else {
    const ok = NBD_THEMES.filter(t => _nbdUnlocked(t.plan));
    nbdApplyTheme(ok[Math.floor(Math.random() * ok.length)].id);
  }
}

/* ── RENDER FONTS ─────────────────────────────────────────────────── */
function nbdRenderFonts() {
  const el = document.getElementById('npm-fonts');
  if (!el) return;
  el.innerHTML = '';
  NBD_FONTS.forEach(f => {
    const isAct = f.id === _nbd_activeFont;
    const ok = _nbdUnlocked(f.plan);
    const d = document.createElement('div');
    d.className = 'npm-font-card' + (isAct ? ' active' : '');
    d.style.opacity = ok ? '1' : '0.45';
    d.style.cursor = ok ? 'pointer' : 'default';
    d.onclick = () => nbdApplyFont(f.id);
    d.innerHTML = `<div class="npm-font-head">${f.name} ${!ok?'🔒':''}<div class="npm-font-check"></div></div><div class="npm-font-display" style="font-family:${f.css.fd}">${f.preview.d}</div><div class="npm-font-body" style="font-family:${f.css.fb}">${f.preview.b}</div><div class="npm-font-mono" style="font-family:${f.css.fm}">const lead = { name: 'Dave Pruitt' }</div>`;
    el.appendChild(d);
  });
}

/* ── CUSTOM BUILDER ───────────────────────────────────────────────── */
function nbdLiveCustom() {
  const bg=document.getElementById('ncp-bg').value, s=document.getElementById('ncp-s').value, ac=document.getElementById('ncp-accent').value, t=document.getElementById('ncp-t').value, m=document.getElementById('ncp-m').value;
  _nbdApplyCustomVars(ac,bg,s,t,m);
}
function nbdApplyCustom() { nbdLiveCustom(); nbdToast('Custom preview applied'); }
function nbdSaveCustom() {
  if (!_nbdUnlocked('command')) { nbdToast('🔒 Custom themes require Command plan'); return; }
  const ac=document.getElementById('ncp-accent').value, bg=document.getElementById('ncp-bg').value, s=document.getElementById('ncp-s').value, tc=document.getElementById('ncp-t').value, m=document.getElementById('ncp-m').value;
  const slot = { id:'custom-'+Date.now(), name:'Custom '+((_nbd_customs.length)+1), cat:'custom', plan:'command', accent:ac, bg, s, tc, m };
  _nbd_customs.push(slot);
  localStorage.setItem('nbd-customs', JSON.stringify(_nbd_customs));
  nbdToast('Saved: ' + slot.name);
  nbdRenderThemes();
}
function _nbdApplyCustomVars(accent,bg,s,text,muted) {
  const R = document.documentElement.style;
  const adj=(h,p)=>{const n=parseInt((h||'#000').replace('#',''),16);const r=Math.min(255,Math.max(0,((n>>16)&255)+Math.round(p*2.55)));const g=Math.min(255,Math.max(0,((n>>8)&255)+Math.round(p*2.55)));const b=Math.min(255,Math.max(0,(n&255)+Math.round(p*2.55)));return '#'+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);};
  R.setProperty('--bg',bg); R.setProperty('--s',s); R.setProperty('--bar',s);
  R.setProperty('--s2',adj(s,5)); R.setProperty('--s3',adj(s,10)); R.setProperty('--rule',adj(s,12));
  R.setProperty('--orange',accent); R.setProperty('--ac',accent);
  R.setProperty('--orange-h',adj(accent,12)); R.setProperty('--orange-a',adj(accent,-10));
  R.setProperty('--t',text); R.setProperty('--m',muted); R.setProperty('--muted',muted);
  try { const rr=parseInt(accent.slice(1,3),16),gg=parseInt(accent.slice(3,5),16),bb=parseInt(accent.slice(5,7),16); R.setProperty('--glow',`rgba(${rr},${gg},${bb},0.28)`); R.setProperty('--glow2',`rgba(${rr},${gg},${bb},0.09)`); } catch(e){}
}

/* ── COPY HELPERS ─────────────────────────────────────────────────── */
function nbdCopyClass() { const c=_nbd_activeTheme==='default'?'(default — no class needed)':`body.theme-${_nbd_activeTheme}`; navigator.clipboard?.writeText(c); nbdToast('Copied: '+c); }
function nbdCopyFS()    { const c=`await db.collection('users').doc(uid).update({ theme: '${_nbd_activeTheme}', font: '${_nbd_activeFont}' });`; navigator.clipboard?.writeText(c); nbdToast('Firestore write copied'); }

/* ── HOW-TO MODAL ─────────────────────────────────────────────────── */
function nbdHowtoOpen()  { document.getElementById('nbd-howto-modal').classList.add('open'); }
function nbdHowtoClose() { document.getElementById('nbd-howto-modal').classList.remove('open'); }
document.addEventListener('DOMContentLoaded', function() {
  const _howtoModal = document.getElementById('nbd-howto-modal');
  if (_howtoModal) _howtoModal.addEventListener('click', function(e) { if (e.target === this) nbdHowtoClose(); });
});

/* ── TOAST ────────────────────────────────────────────────────────── */
function nbdToast(msg) {
  let el = document.getElementById('nbd-toast') || document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id='nbd-toast'; el.className='nbd-toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

/* ── GLOBAL ALIASES (backward compat for both pages) ─────────────── */
window.toggleThemeMenu         = nbdPickerOpen;
window.dsApplyTheme            = nbdApplyTheme;
window.buildTopbarThemeGrid    = nbdRenderThemes;
window.buildWelcomeThemePicker = () => {};  // DS welcome modal — no-op, full picker replaces it

/* ── EXPOSE MAP FUNCTIONS TO WINDOW ─────────────────────────────────
   spyglassSearch / spyglassGoToLocation / fabToggle / quickStormCheck →
   __NBD_CALL_REGISTRY (dashboard-ui.js, Globals Tranche 2c-4h Slice H2);
   markup dispatch resolves registry-first, no re-export needed here.
   damagNearMe → single implementation + registry in maps-overlays.js
   (the alias to spyglassGoToLocation that lived here shadowed it).
   The zone-draw cluster (selectZoneColor / startZoneDraw / cancelZoneDraw /
   saveZone / deleteZone) and damageNearMePhotos → __NBD_CALL_REGISTRY in
   dashboard-actions.js, Globals Tranche 3 slice T3-0 (2026-08-31) — the six
   re-exports that lived here are deleted. Those were the shims the Tranche 2
   audit called "unguarded"; the 2026-08-07 rework above already made them
   typeof-guarded, which is what finally made the cluster convertible.
   2026-09-17 (Globals Tranche 3, T3-B): the remaining 12-name try/catch
   block (searchMap/selectPin/deletePin/clearAllPins/goToLeadFromPin/
   deleteLeadFromPin/makeLeadFromPin/deletePinOnly/toggleMapSidebar/
   updatePinStats/toggleOverlay/goToMyLocation) was pure `window.X =
   window.X` — every one of those 12 names is a top-level `function`/
   `async function` declaration in its owner sibling file (maps-overlays.js,
   dashboard-ui.js, dashboard-widgets.js, maps-core.js, maps-routing.js;
   goToMyLocation and searchMap even carry their OWN explicit window.X = X
   export already), which a classic non-module script puts on window the
   moment that file parses — independent of whether this block ever ran.
   Verified against the live tree: single owner each, zero bracket/dynamic
   dispatch, no twin definitions. Deleted rather than re-guarded. */

/* ── BOOT ─────────────────────────────────────────────────────────── */
(function nbdBoot() {
  // On surfaces with the modern ThemeEngine (dashboard sets window.NBD_THEME_ENGINE),
  // the engine owns appearance (data-theme + injected vars). Skip the legacy
  // body-class + inline-var forcing here — it ran on EVERY load and overrode the
  // engine, since inline documentElement styles outrank the engine's injected
  // <style> (audit F-1). Fonts + category rendering are independent and always run.
  if (!window.NBD_THEME_ENGINE) {
    const saved = localStorage.getItem('nbd-theme') || localStorage.getItem('ds-theme') || 'default';
    const t = _nbdGetTheme(saved) || _nbdGetTheme('default');
    if (t) {
      document.body.className = t.id === 'default' ? '' : 'theme-' + t.id;
      document.documentElement.setAttribute('data-theme', t.id);
      const R = document.documentElement.style;
      R.setProperty('--ac',     t.accent);
      R.setProperty('--orange', t.accent);
      R.setProperty('--gold',   t.accent);
      R.setProperty('--bg',     t.bg  || '#0A0C0F');
      R.setProperty('--bar',    t.s   || '#13171d');
      _nbd_activeTheme = t.id;
      _nbdUpdateLabels(t);
    }
  }
  // Don't clobber a font chosen via the Settings grid. That picker (legacy
  // prefs-boot, nbdApplyLegacyFont) writes localStorage 'nbd_font' (UNDERSCORE);
  // this engine uses 'nbd-font' (HYPHEN) and boots LAST, so unconditionally
  // applying 'nbd-default' here reverted the user's Settings font on every reload.
  // Only auto-apply this engine's font when the user actually picked one here,
  // or when no Settings-grid font is active.
  (function(){
    var mapsFont = localStorage.getItem('nbd-font');
    var legacyFont = localStorage.getItem('nbd_font');
    if (mapsFont) nbdApplyFont(mapsFont, { silent: true });
    else if (!(legacyFont && legacyFont !== 'barlow')) nbdApplyFont('nbd-default', { silent: true });
    // else: a Settings-grid font is active; prefs-boot already applied it — leave it.
  })();
  nbdRenderCats();
})();
/* ── END NBD UNIFIED APPEARANCE ENGINE ── */



(function(){if(_NBD_MP_DELEGATE)return;_NBD_MP_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-mp-action]');if(!t)return;if(t.dataset.mpAction==='setCat'&&typeof nbdSetCat==='function')nbdSetCat(t.dataset.mpId,t);});})();
