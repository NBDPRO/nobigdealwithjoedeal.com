/**
 * theme-gx.js — Opera GX Enhancement Layer for NBD Pro Theme System
 *
 * Hooks into the existing ThemeEngine via the 'themechange' event.
 * Adds: glow propagation, accent-derived palette, animated backgrounds,
 * real-time accent picker, and neon effects on interactive elements.
 *
 * Does NOT modify existing theme files. Layers on top.
 *
 * Usage: Include after theme-engine.js. Call ThemeGX.init() after ThemeEngine.init().
 *
 * Public API:
 *   ThemeGX.init(options)          - Initialize the GX layer
 *   ThemeGX.setAccent(hex)         - Override accent color for any theme
 *   ThemeGX.setGlow(enabled)       - Toggle glow effects
 *   ThemeGX.setAnimatedBg(enabled) - Toggle animated gradient background
 *   ThemeGX.setIntensity(0-1)      - Glow intensity (0 = subtle, 1 = full neon)
 *   ThemeGX.getState()             - Current GX state
 *   ThemeGX.destroy()              - Clean up
 */

(function() {
  'use strict';

  // ── State ──
  const STORAGE_KEY = 'nbd_gx_settings';
  let state = {
    enabled: true,
    glowEnabled: true,
    animatedBgEnabled: true,
    intensity: 0.6,          // 0-1, default moderate
    accentOverride: null,    // null = use theme accent, hex = override
    currentAccent: '#BD5728' // tracks whatever is active
  };

  let styleEl = null;        // <style> element for GX CSS variables
  let glowStyleEl = null;    // <style> element for glow rules
  let bgCanvas = null;       // Canvas for animated gradient bg
  let bgCtx = null;
  let bgAnimId = null;
  let bgGradientAngle = 0;

  // ── Color Utilities ──

  function hexToHSL(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const r = parseInt(hex.substr(0,2),16)/255;
    const g = parseInt(hex.substr(2,2),16)/255;
    const b = parseInt(hex.substr(4,2),16)/255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    let h, s, l = (max+min)/2;
    if (max === min) { h = s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d/(2-max-min) : d/(max+min);
      switch(max) {
        case r: h = ((g-b)/d + (g<b?6:0))/6; break;
        case g: h = ((b-r)/d + 2)/6; break;
        case b: h = ((r-g)/d + 4)/6; break;
      }
    }
    return { h: Math.round(h*360), s: Math.round(s*100), l: Math.round(l*100) };
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1-l);
    const f = n => {
      const k = (n + h/30) % 12;
      const color = l - a * Math.max(Math.min(k-3, 9-k, 1), -1);
      return Math.round(255 * Math.max(0, Math.min(1, color))).toString(16).padStart(2,'0');
    };
    return '#' + f(0) + f(8) + f(4);
  }

  function hslString(h, s, l, a) {
    if (a !== undefined) return `hsla(${h}, ${s}%, ${l}%, ${a})`;
    return `hsl(${h}, ${s}%, ${l}%)`;
  }

  // ── Derive GX Palette from Single Accent Color ──

  function deriveGXPalette(accentHex, intensity) {
    const hsl = hexToHSL(accentHex);
    const h = hsl.h;
    const s = hsl.s;
    const l = hsl.l;
    const i = intensity; // 0-1

    return {
      // Core accent (unchanged)
      accent: accentHex,

      // Glow variants — boosted lightness + saturation
      glow:         hslString(h, Math.min(s + 20, 100), Math.min(l + 15, 85)),
      glowSoft:     hslString(h, Math.min(s + 10, 100), Math.min(l + 10, 80), 0.4 * i),
      glowAmbient:  hslString(h, Math.min(s + 5, 100), Math.min(l + 5, 70), 0.15 * i),
      glowIntense:  hslString(h, Math.min(s + 30, 100), Math.min(l + 25, 95), 0.8 * i),

      // Neon text variant (brighter for dark backgrounds)
      neonText:     hslString(h, Math.min(s + 15, 100), Math.min(l + 20, 90)),

      // Shadow variants for box-shadow glow
      shadowSm:     `0 0 ${4 * i}px ${hslString(h, s, Math.min(l + 10, 80), 0.3 * i)}, 0 0 ${8 * i}px ${hslString(h, s, Math.min(l + 10, 80), 0.15 * i)}`,
      shadowMd:     `0 0 ${8 * i}px ${hslString(h, s, Math.min(l + 10, 80), 0.4 * i)}, 0 0 ${20 * i}px ${hslString(h, s, Math.min(l + 10, 80), 0.2 * i)}`,
      shadowLg:     `0 0 ${12 * i}px ${hslString(h, s, Math.min(l + 10, 80), 0.5 * i)}, 0 0 ${32 * i}px ${hslString(h, s, Math.min(l + 10, 80), 0.25 * i)}, 0 0 ${48 * i}px ${hslString(h, s, Math.min(l + 10, 80), 0.1 * i)}`,

      // Border glow
      borderGlow:   hslString(h, Math.min(s + 10, 100), Math.min(l + 10, 70), 0.5 * i),

      // Animated gradient colors (triadic spread for bg animation)
      gradA:        hslString(h, Math.max(s - 40, 10), 8, 0.6 * i),
      gradB:        hslString((h + 30) % 360, Math.max(s - 50, 8), 6, 0.4 * i),
      gradC:        hslString((h - 30 + 360) % 360, Math.max(s - 50, 8), 4, 0.3 * i),

      // Scrollbar
      scrollTrack:  hslString(h, Math.max(s - 30, 5), 12),
      scrollThumb:  hslString(h, Math.min(s, 80), Math.min(l, 50), 0.6),
      scrollHover:  accentHex,

      // Raw HSL values for CSS calc
      hue: h,
      sat: s,
      lit: l
    };
  }

  // ── Inject GX CSS Variables ──

  function injectGXVariables(palette) {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'theme-gx-vars';
      document.head.appendChild(styleEl);
    }

    styleEl.textContent = `:root {
  /* GX Core */
  --gx-accent: ${palette.accent};
  --gx-glow: ${palette.glow};
  --gx-glow-soft: ${palette.glowSoft};
  --gx-glow-ambient: ${palette.glowAmbient};
  --gx-glow-intense: ${palette.glowIntense};
  --gx-neon-text: ${palette.neonText};

  /* GX Shadows */
  --gx-shadow-sm: ${palette.shadowSm};
  --gx-shadow-md: ${palette.shadowMd};
  --gx-shadow-lg: ${palette.shadowLg};

  /* GX Border */
  --gx-border-glow: ${palette.borderGlow};

  /* GX Gradient BG */
  --gx-grad-a: ${palette.gradA};
  --gx-grad-b: ${palette.gradB};
  --gx-grad-c: ${palette.gradC};

  /* GX Scrollbar */
  --gx-scroll-track: ${palette.scrollTrack};
  --gx-scroll-thumb: ${palette.scrollThumb};
  --gx-scroll-hover: ${palette.scrollHover};

  /* GX Raw HSL */
  --gx-hue: ${palette.hue};
  --gx-sat: ${palette.sat}%;
  --gx-lit: ${palette.lit}%;

  /* GX Intensity (for CSS calcs) */
  --gx-intensity: ${state.intensity};
}`;
  }

  // ── Glow Styles ──

  function injectGlowStyles() {
    if (!state.glowEnabled) { removeGlowStyles(); return; }
    if (glowStyleEl) return; // already injected

    glowStyleEl = document.createElement('style');
    glowStyleEl.id = 'theme-gx-glow';
    glowStyleEl.textContent = `
/* ── GX Glow: Buttons ── */
[data-gx-glow] button:not(:disabled):hover,
[data-gx-glow] .btn:not(:disabled):hover,
[data-gx-glow] [role="button"]:not(:disabled):hover {
  box-shadow: var(--gx-shadow-md);
  border-color: var(--gx-border-glow);
}
[data-gx-glow] button:not(:disabled):active,
[data-gx-glow] .btn:not(:disabled):active {
  box-shadow: var(--gx-shadow-lg);
}
[data-gx-glow] button.primary,
[data-gx-glow] .btn-primary {
  box-shadow: var(--gx-shadow-sm);
}
[data-gx-glow] button.primary:hover,
[data-gx-glow] .btn-primary:hover {
  box-shadow: var(--gx-shadow-lg);
  text-shadow: 0 0 8px var(--gx-glow-soft);
}

/* ── GX Glow: Inputs ── */
[data-gx-glow] input:focus,
[data-gx-glow] textarea:focus,
[data-gx-glow] select:focus {
  box-shadow: var(--gx-shadow-md);
  border-color: var(--gx-border-glow) !important;
  outline: none;
}

/* ── GX Glow: Cards ── */
[data-gx-glow] .card:hover,
[data-gx-glow] .panel:hover {
  box-shadow: var(--gx-shadow-sm);
  border-color: var(--gx-border-glow);
}

/* ── GX Glow: Nav Items ── */
[data-gx-glow] .nav-item.active,
[data-gx-glow] .sidebar-item.active,
[data-gx-glow] [aria-current="page"] {
  box-shadow: inset 3px 0 0 var(--gx-accent), var(--gx-shadow-sm);
  text-shadow: 0 0 6px var(--gx-glow-ambient);
}
[data-gx-glow] .nav-item:hover,
[data-gx-glow] .sidebar-item:hover {
  background: var(--gx-glow-ambient);
}

/* ── GX Glow: Links ── */
[data-gx-glow] a:not(.btn):hover {
  text-shadow: 0 0 8px var(--gx-glow-soft);
}

/* ── GX Glow: Badges / Chips ── */
[data-gx-glow] .badge,
[data-gx-glow] .chip,
[data-gx-glow] .tag {
  box-shadow: var(--gx-shadow-sm);
}

/* ── GX Glow: Toggle / Switch ── */
[data-gx-glow] input[type="checkbox"]:checked + label,
[data-gx-glow] .toggle.active {
  box-shadow: var(--gx-shadow-md);
}

/* ── GX Glow: Scrollbar ── */
[data-gx-glow]::-webkit-scrollbar { width: 8px; }
[data-gx-glow]::-webkit-scrollbar-track { background: var(--gx-scroll-track); }
[data-gx-glow]::-webkit-scrollbar-thumb {
  background: var(--gx-scroll-thumb);
  border-radius: 4px;
}
[data-gx-glow]::-webkit-scrollbar-thumb:hover {
  background: var(--gx-scroll-hover);
  box-shadow: 0 0 6px var(--gx-glow-soft);
}
[data-gx-glow] * {
  scrollbar-color: var(--gx-scroll-thumb) var(--gx-scroll-track);
  scrollbar-width: thin;
}

/* ── GX Glow: Selection ── */
[data-gx-glow] ::selection {
  background: var(--gx-glow-ambient);
  color: var(--gx-neon-text);
}

/* ── GX Glow: Focus Ring ── */
[data-gx-glow] :focus-visible {
  outline: 2px solid var(--gx-border-glow);
  outline-offset: 2px;
  box-shadow: var(--gx-shadow-sm);
}

/* ── GX Glow: Pulse Animation (for notifications) ── */
@keyframes gx-pulse {
  0%, 100% { box-shadow: var(--gx-shadow-sm); }
  50% { box-shadow: var(--gx-shadow-lg); }
}
[data-gx-glow] .gx-pulse {
  animation: gx-pulse 2s ease-in-out infinite;
}

/* ── GX Glow: Neon Text Util ── */
[data-gx-glow] .gx-neon {
  color: var(--gx-neon-text);
  text-shadow: 0 0 4px var(--gx-glow-soft), 0 0 12px var(--gx-glow-ambient);
}

/* ── GX Glow: Border Glow Util ── */
[data-gx-glow] .gx-border {
  border: 1px solid var(--gx-border-glow);
  box-shadow: var(--gx-shadow-sm);
}

/* ── GX: Reduced Motion ── */
@media (prefers-reduced-motion: reduce) {
  [data-gx-glow] .gx-pulse { animation: none; }
  [data-gx-glow] * { transition-duration: 0s !important; }
}
`;
    document.head.appendChild(glowStyleEl);
  }

  function removeGlowStyles() {
    if (glowStyleEl) { glowStyleEl.remove(); glowStyleEl = null; }
    document.documentElement.removeAttribute('data-gx-glow');
  }

  // ── Animated Gradient Background ──

  function initAnimatedBg() {
    if (!state.animatedBgEnabled) { destroyAnimatedBg(); return; }
    if (bgCanvas) return;

    bgCanvas = document.createElement('canvas');
    bgCanvas.id = 'gx-animated-bg';
    bgCanvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:-1;pointer-events:none;opacity:0;transition:opacity 1s ease;';
    document.body.prepend(bgCanvas);
    bgCtx = bgCanvas.getContext('2d');

    function resize() {
      bgCanvas.width = window.innerWidth;
      bgCanvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    // Fade in
    requestAnimationFrame(() => { bgCanvas.style.opacity = '1'; });

    // Start animation
    let lastTime = 0;
    function animate(time) {
      if (!bgCanvas) return;
      bgAnimId = requestAnimationFrame(animate);

      // Throttle to ~20fps for performance
      if (time - lastTime < 50) return;
      lastTime = time;

      bgGradientAngle += 0.15;
      const w = bgCanvas.width;
      const h = bgCanvas.height;
      const hsl = hexToHSL(state.currentAccent);
      const intensity = state.intensity;

      // Clear
      bgCtx.clearRect(0, 0, w, h);

      // Animated radial gradients that drift
      const t = bgGradientAngle * 0.01;
      const cx1 = w * (0.3 + 0.2 * Math.sin(t));
      const cy1 = h * (0.3 + 0.2 * Math.cos(t * 0.7));
      const cx2 = w * (0.7 + 0.15 * Math.cos(t * 1.1));
      const cy2 = h * (0.6 + 0.2 * Math.sin(t * 0.8));
      const cx3 = w * (0.5 + 0.25 * Math.sin(t * 0.5));
      const cy3 = h * (0.8 + 0.15 * Math.cos(t * 1.3));

      const radius = Math.max(w, h) * 0.5;

      // Orb 1 — accent color
      const g1 = bgCtx.createRadialGradient(cx1, cy1, 0, cx1, cy1, radius);
      g1.addColorStop(0, hslString(hsl.h, Math.min(hsl.s, 60), 20, 0.12 * intensity));
      g1.addColorStop(1, 'transparent');
      bgCtx.fillStyle = g1;
      bgCtx.fillRect(0, 0, w, h);

      // Orb 2 — shifted hue
      const g2 = bgCtx.createRadialGradient(cx2, cy2, 0, cx2, cy2, radius * 0.8);
      g2.addColorStop(0, hslString((hsl.h + 30) % 360, Math.min(hsl.s, 40), 15, 0.08 * intensity));
      g2.addColorStop(1, 'transparent');
      bgCtx.fillStyle = g2;
      bgCtx.fillRect(0, 0, w, h);

      // Orb 3 — complementary
      const g3 = bgCtx.createRadialGradient(cx3, cy3, 0, cx3, cy3, radius * 0.6);
      g3.addColorStop(0, hslString((hsl.h - 30 + 360) % 360, Math.min(hsl.s, 30), 10, 0.06 * intensity));
      g3.addColorStop(1, 'transparent');
      bgCtx.fillStyle = g3;
      bgCtx.fillRect(0, 0, w, h);
    }

    bgAnimId = requestAnimationFrame(animate);
  }

  function destroyAnimatedBg() {
    if (bgAnimId) cancelAnimationFrame(bgAnimId);
    if (bgCanvas) { bgCanvas.remove(); bgCanvas = null; bgCtx = null; }
    bgAnimId = null;
  }

  // ── Persistence ──

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        enabled: state.enabled,
        glowEnabled: state.glowEnabled,
        animatedBgEnabled: state.animatedBgEnabled,
        intensity: state.intensity,
        accentOverride: state.accentOverride
      }));
    } catch(e) {}
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved) {
        state.enabled = saved.enabled !== false;
        state.glowEnabled = saved.glowEnabled !== false;
        state.animatedBgEnabled = saved.animatedBgEnabled !== false;
        state.intensity = typeof saved.intensity === 'number' ? saved.intensity : 0.6;
        state.accentOverride = saved.accentOverride || null;
      }
    } catch(e) {}
  }

  // ── Core Update ──

  function update(accentHex) {
    if (!state.enabled) return;

    const accent = state.accentOverride || accentHex || state.currentAccent;
    state.currentAccent = accent;

    const palette = deriveGXPalette(accent, state.intensity);
    injectGXVariables(palette);

    if (state.glowEnabled) {
      document.documentElement.setAttribute('data-gx-glow', '');
      injectGlowStyles();
    } else {
      removeGlowStyles();
    }

    if (state.animatedBgEnabled) {
      initAnimatedBg();
    } else {
      destroyAnimatedBg();
    }
  }

  // ── Theme Change Listener ──

  function onThemeChange(e) {
    // Get accent from the newly applied theme
    const themeKey = e.detail || window.ThemeEngine.getCurrent();
    const theme = window.ThemeEngine.get(themeKey);
    if (theme && theme.colors && theme.colors.accent) {
      update(theme.colors.accent);
    }
  }

  // ── Public API ──

  window.ThemeGX = {
    init: function(options) {
      options = options || {};
      loadState();

      // Allow init options to override
      if (options.intensity !== undefined) state.intensity = options.intensity;
      if (options.glow !== undefined) state.glowEnabled = options.glow;
      if (options.animatedBg !== undefined) state.animatedBgEnabled = options.animatedBg;

      // Listen for theme changes from existing engine
      document.addEventListener('themechange', onThemeChange);

      // Get current theme's accent
      if (window.ThemeEngine) {
        const current = window.ThemeEngine.getCurrent();
        const theme = window.ThemeEngine.get(current);
        if (theme && theme.colors) {
          update(theme.colors.accent);
        }
      } else {
        update(state.currentAccent);
      }

      // Visibility handling (pause animated bg when hidden)
      document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
          if (bgAnimId) { cancelAnimationFrame(bgAnimId); bgAnimId = null; }
        } else if (state.animatedBgEnabled && bgCanvas) {
          initAnimatedBg();
        }
      });

      console.log('[ThemeGX] Initialized — intensity:', state.intensity, 'glow:', state.glowEnabled, 'animBg:', state.animatedBgEnabled);
    },

    setAccent: function(hex) {
      if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
      state.accentOverride = hex;
      update(hex);
      saveState();

      // Also update the existing theme engine's --orange variable
      document.documentElement.style.setProperty('--orange', hex);
      document.documentElement.style.setProperty('--og', hex + '1f');
    },

    clearAccentOverride: function() {
      state.accentOverride = null;
      saveState();
      // CRM audit 2026-11-06 (ST-F22): setAccentOverride also wrote --orange
      // and --og inline on <html>; leaving them made "Reset to Default" a
      // no-op for every theme color that reads them.
      document.documentElement.style.removeProperty('--orange');
      document.documentElement.style.removeProperty('--og');
      // Re-read from current theme
      if (window.ThemeEngine) {
        const theme = window.ThemeEngine.get(window.ThemeEngine.getCurrent());
        if (theme) update(theme.colors.accent);
      }
    },

    setGlow: function(enabled) {
      state.glowEnabled = !!enabled;
      if (!enabled) removeGlowStyles();
      else update();
      saveState();
    },

    setAnimatedBg: function(enabled) {
      state.animatedBgEnabled = !!enabled;
      if (!enabled) destroyAnimatedBg();
      else initAnimatedBg();
      saveState();
    },

    setIntensity: function(val) {
      state.intensity = Math.max(0, Math.min(1, val));
      update();
      saveState();
    },

    setEnabled: function(enabled) {
      state.enabled = !!enabled;
      if (!enabled) {
        removeGlowStyles();
        destroyAnimatedBg();
        if (styleEl) { styleEl.textContent = ''; }
        document.documentElement.removeAttribute('data-gx-glow');
      } else {
        update();
      }
      saveState();
    },

    isEnabled: function() { return state.enabled; },
    getState: function() { return { ...state }; },
    getAccent: function() { return state.currentAccent; },

    // Utility: get derived palette for external use (e.g., charts, custom components)
    getPalette: function(hex) {
      return deriveGXPalette(hex || state.currentAccent, state.intensity);
    },

    destroy: function() {
      document.removeEventListener('themechange', onThemeChange);
      removeGlowStyles();
      destroyAnimatedBg();
      if (styleEl) { styleEl.remove(); styleEl = null; }
      document.documentElement.removeAttribute('data-gx-glow');
    }
  };
})();