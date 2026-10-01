/**
 * NBD Pro CRM — Theme Engine v1.0
 * Master theme controller for 155-theme system
 *
 * Manages color schemes, overlays, fonts, cursors, and special effects
 * for a roofing contractor SaaS platform.
 *
 * IIFE pattern, exposed as window.ThemeEngine
 */

(function() {
  'use strict';

  // ============================================================================
  // CONFIGURATION & STATE
  // ============================================================================

  const STORAGE_KEY = 'nbd_pro_theme';
  // Legacy mirror key shared with maps.js / daily-success / dashboard-ui.js so
  // the two theme paths converge on one value (audit F-1). STORAGE_KEY is
  // canonical; LEGACY_KEY is written-through and read as a migration fallback.
  const LEGACY_KEY = 'nbd-theme';
  const MODE_STORAGE_KEY = 'nbd_pro_mode_pref';
  // Actual Firestore path is userSettings/{uid} (see apply/init). The old
  // FIRESTORE_PATH = 'user_settings/theme' constant was dead and was removed.
  const FONT_CACHE = new Set();
  const DEFAULT_THEME = 'nbd-original';

  let currentTheme = DEFAULT_THEME;
  let styleElement = null;

  // ============================================================================
  // CATEGORIES
  // ============================================================================

  const CATEGORIES = [
    { key: 'professional', label: 'Professional', icon: '💼' },
    { key: 'nature', label: 'Nature & Elements', icon: '🌿' },
    { key: 'luxury', label: 'Luxury & Premium', icon: '✨' },
    { key: 'scifi', label: 'Sci-Fi & Cyber', icon: '🚀' },
    { key: 'popculture', label: 'Pop Culture', icon: '🎬' },
    { key: 'sports', label: 'Sports & Energy', icon: '⚡' },
    { key: 'construction', label: 'Construction & Trade', icon: '🔨' },
    { key: 'mood', label: 'Mood & Aesthetic', icon: '🎨' },
    { key: 'seasonal', label: 'Seasonal', icon: '🌍' },
    { key: 'achievement', label: 'Achievements', icon: '🏆' },
    { key: 'anime', label: 'Anime', icon: '🎌' },
    { key: 'cartoon', label: 'Cartoon', icon: '📺' }
  ];

  // ============================================================================
  // THEME DEFINITIONS (186 themes)
  // ============================================================================

  const THEMES = {
    // PROFESSIONAL (10)
    'nbd-original': {
      name: 'NBD Original',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1A3057',
        surface: '#0f2847',
        surface2: '#1a3d5e',
        text: '#e2e8f0',
        muted: '#9ca3af',
        border: 'rgba(255,255,255,.08)',
        accent: '#BD5728',
        accentBg: 'rgba(189,87,40,.12)',
        green: '#16a34a',
        red: '#ef4444',
        gold: '#eab308',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'midnight': {
      name: 'Midnight',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      mode: 'dark',
      colors: {
        bg: '#0b1024',
        surface: '#141a36',
        surface2: '#1d2548',
        text: '#e2e8f0',
        muted: '#7e88a8',
        border: 'rgba(99,102,241,.14)',
        accent: '#6366f1',
        accentBg: 'rgba(99,102,241,.16)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'cobalt': {
      name: 'Cobalt',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      mode: 'dark',
      colors: {
        bg: '#061230',
        surface: '#0a1d4d',
        surface2: '#0f2a6e',
        text: '#eaf2ff',
        muted: '#90b3e8',
        border: 'rgba(96,165,250,.24)',
        accent: '#3b82f6',
        accentBg: 'rgba(59,130,246,.18)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fcd34d',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'slate': {
      name: 'Slate',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      mode: 'dark',
      colors: {
        bg: '#0f1117',
        surface: '#161b25',
        surface2: '#1c2333',
        text: '#f1f5f9',
        muted: '#64748b',
        border: 'rgba(148,163,184,.14)',
        accent: '#64748b',
        accentBg: 'rgba(100,116,139,.18)',
        green: '#22c55e',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'steel': {
      name: 'Steel',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      mode: 'dark',
      colors: {
        bg: '#1a1f26',
        surface: '#252b35',
        surface2: '#323a47',
        text: '#e6edf5',
        muted: '#8a96a6',
        border: 'rgba(186,196,210,.14)',
        accent: '#bac4d2',
        accentBg: 'rgba(186,196,210,.14)',
        green: '#1abc9c',
        red: '#e74c3c',
        gold: '#d4a017',
        blue: '#5a8fc4'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'paper': {
      name: 'Paper',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      mode: 'light',
      colors: {
        bg: '#fafaf7',
        surface: '#ffffff',
        surface2: '#f3f1ec',
        text: '#1a1a1a',
        muted: '#6b6b6b',
        border: 'rgba(0,0,0,.10)',
        accent: '#1a1a1a',
        accentBg: 'rgba(26,26,26,.06)',
        green: '#16a34a',
        red: '#dc2626',
        gold: '#a16207',
        blue: '#1d4ed8'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: 'light-theme'
    },
    'ghost': {
      name: 'Ghost',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      mode: 'light',
      colors: {
        bg: '#f4f6fa',
        surface: '#ffffff',
        surface2: '#eef1f6',
        text: '#3b4252',
        muted: '#6b7280',
        border: 'rgba(60,70,90,.14)',
        accent: '#475569',
        accentBg: 'rgba(71,85,105,.14)',
        green: '#10b981',
        red: '#ef4444',
        gold: '#d97706',
        blue: '#0ea5e9'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: 'light-theme'
    },
    'obsidian': {
      name: 'Obsidian',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      mode: 'dark',
      colors: {
        bg: '#040406',
        surface: '#0c0c10',
        surface2: '#16161c',
        text: '#f0f0f4',
        muted: '#7a7a82',
        border: 'rgba(255,255,255,.06)',
        accent: '#dadcde',
        accentBg: 'rgba(218,220,222,.06)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fcd34d',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'arctic': {
      name: 'Arctic',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0f172a',
        surface: '#1e293b',
        surface2: '#334155',
        text: '#f1f5f9',
        muted: '#cbd5e1',
        border: 'rgba(203,213,225,.12)',
        accent: '#7dd3fc',
        accentBg: 'rgba(125,211,252,.12)',
        green: '#34d399',
        red: '#fca5a5',
        gold: '#fcd34d',
        blue: '#7dd3fc'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'coffee': {
      name: 'Coffee',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1008',
        surface: '#2a1e12',
        surface2: '#3a2e22',
        text: '#e8e4dc',
        muted: '#b8a898',
        border: 'rgba(232,228,220,.08)',
        accent: '#a0724a',
        accentBg: 'rgba(160,114,74,.12)',
        green: '#86a873',
        red: '#d4a574',
        gold: '#c9a961',
        blue: '#6b7a9a'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },

    // ─── WAVE 105: PROFESSIONAL EXPANSION (5 new) ───
    // Round out the catalog with one accessibility-grade theme +
    // four modern dark variants chosen to fill gaps that the
    // existing 10 professional themes don't cover.

    // High-contrast a11y. Pure black bg + near-white text +
    // bright orange accent. Targets WCAG AAA contrast for users
    // with low vision. Distinct from the other dark themes
    // because it intentionally pushes to the contrast extreme.
    'high-contrast': {
      name: 'High Contrast',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      mode: 'dark',
      colors: {
        bg: '#000000',
        surface: '#0a0a0a',
        surface2: '#181818',
        text: '#ffffff',
        muted: '#cccccc',
        border: '#ffffff',
        accent: '#ff8800',
        accentBg: 'rgba(255,136,0,0.20)',
        green: '#00ff88',
        red: '#ff3838',
        gold: '#ffdd00',
        blue: '#00bfff'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: 'high-contrast-theme'
    },

    // Sage — modern earthy dark green. Calmer than 'forest',
    // workday-friendly, complements warm orange accent badges.
    'sage': {
      name: 'Sage',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      mode: 'dark',
      colors: {
        bg: '#0e1a16',
        surface: '#162822',
        surface2: '#1f372f',
        text: '#e8efea',
        muted: '#8fa89d',
        border: 'rgba(159,194,168,.16)',
        accent: '#7bb89b',
        accentBg: 'rgba(123,184,155,.16)',
        green: '#4ade80',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },

    // Amber — warm dark theme. For reps who don't like the cool
    // blue cast of midnight/cobalt/slate. Reminiscent of
    // candlelight or workshop lighting.
    'amber-dark': {
      name: 'Amber',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      mode: 'dark',
      colors: {
        bg: '#1a140d',
        surface: '#241b12',
        surface2: '#322618',
        text: '#f5ead6',
        muted: '#a89478',
        border: 'rgba(217,166,98,.14)',
        accent: '#d9a662',
        accentBg: 'rgba(217,166,98,.16)',
        green: '#65d39a',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#7dd3fc'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },

    // Plum — deep purple, modern, distinct from 'midnight' (more
    // saturated, less indigo). Pairs well with the W91/W92
    // engagement orange + violet share accents.
    'plum': {
      name: 'Plum',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      mode: 'dark',
      colors: {
        bg: '#150a1f',
        surface: '#1f1330',
        surface2: '#2c1c45',
        text: '#ece4f5',
        muted: '#a292b8',
        border: 'rgba(167,139,250,.16)',
        accent: '#a78bfa',
        accentBg: 'rgba(167,139,250,.18)',
        green: '#34d399',
        red: '#fb7185',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },

    // Mono — pure grayscale with a single chromatic accent. For
    // reps who want minimal color noise and a "design tool"
    // aesthetic. Different from 'slate' which has subtle blue
    // undertones; mono is strictly neutral.
    'mono': {
      name: 'Mono',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      mode: 'dark',
      colors: {
        bg: '#101010',
        surface: '#181818',
        surface2: '#222222',
        text: '#f5f5f5',
        muted: '#888888',
        border: 'rgba(255,255,255,.10)',
        accent: '#BD5728',
        accentBg: 'rgba(189,87,40,.14)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#eab308',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },

    // Live Ops (2026-10-01) — Jo's "AI Business OS" look: deep indigo-navy
    // space, a slowly moving WebGL gradient wallpaper (theme-overlays.js
    // 'shader-gradient'), translucent cards with thin cyan glow edges and
    // uppercase spaced labels. Colours mirror the :root[data-theme="liveops"]
    // token line in theme-system.css (engine bg → --s, surface → --s2,
    // surface2 → --s3, outerBg → --bg). The card glow CSS is scoped to
    // [data-theme="liveops"] at the end of theme-system.css.
    'liveops': {
      name: 'Live Ops',
      category: 'professional',
      locked: false,
      unlockCondition: null,
      mode: 'dark',
      colors: {
        outerBg: '#070b24',
        bg: '#0d1438',
        surface: '#121c4a',
        surface2: '#18245c',
        text: '#e8eeff',
        muted: '#9fb0e0',
        border: 'rgba(56,225,255,.16)',
        accent: '#38e1ff',
        accentBg: 'rgba(56,225,255,.16)',
        accentHover: '#7aeeff',
        green: '#34f0b4',
        red: '#ff5d7a',
        gold: '#ffcf4a',
        blue: '#5b8cff',
        purple: '#a78bfa',
        paper: '#121c4a',
        rule: 'rgba(56,225,255,.12)'
      },
      // Stops stay dark (max relative luminance well under --m's AA budget)
      // so muted text that sits straight on the wallpaper still reads.
      overlay: {
        type: 'shader-gradient',
        colors: ['#070b24', '#1a3594', '#36208a', '#0a4462'],
        speed: 1,
        scale: 0.5,
        grain: 0.01,
        darkOnly: true
      },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '14px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: 'glow',
      specialClass: 'liveops-theme'
    },

    // NATURE & ELEMENTS (12)
    'forest': {
      name: 'Forest',
      category: 'nature',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1f0a',
        surface: '#142814',
        surface2: '#1e3d1e',
        text: '#e8f5e9',
        muted: '#a5d6a7',
        border: 'rgba(165,214,167,.12)',
        accent: '#22c55e',
        accentBg: 'rgba(34,197,94,.12)',
        green: '#22c55e',
        red: '#ef5350',
        gold: '#fdd835',
        blue: '#42a5f5'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'ocean': {
      name: 'Ocean',
      category: 'nature',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a192f',
        surface: '#112240',
        surface2: '#1a3a5e',
        text: '#e8f4f8',
        muted: '#8ecae6',
        border: 'rgba(142,202,230,.12)',
        accent: '#06b6d4',
        accentBg: 'rgba(6,182,212,.12)',
        green: '#26a69a',
        red: '#ef5350',
        gold: '#fbc02d',
        blue: '#06b6d4'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'desert': {
      name: 'Desert',
      category: 'nature',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#2c1810',
        surface: '#3d2317',
        surface2: '#4d3524',
        text: '#f5deb3',
        muted: '#d4a574',
        border: 'rgba(212,165,116,.12)',
        accent: '#d4a057',
        accentBg: 'rgba(212,160,87,.12)',
        green: '#8bc34a',
        red: '#ff7043',
        gold: '#d4a057',
        blue: '#5c6bc0'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'aurora': {
      name: 'Aurora',
      category: 'nature',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0e2a',
        surface: '#0f1535',
        surface2: '#1a2a52',
        text: '#e0f2f1',
        muted: '#80deea',
        border: 'rgba(128,222,234,.12)',
        accent: '#34d399',
        accentBg: 'rgba(52,211,153,.12)',
        green: '#34d399',
        red: '#ef5350',
        gold: '#ffd54f',
        blue: '#4fc3f7'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'volcano': {
      name: 'Volcano',
      category: 'nature',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0a0a',
        surface: '#2a1010',
        surface2: '#3a1a1a',
        text: '#ffe4d6',
        muted: '#ffb3ba',
        border: 'rgba(255,179,186,.12)',
        accent: '#ef4444',
        accentBg: 'rgba(239,68,68,.12)',
        green: '#10b981',
        red: '#ef4444',
        gold: '#f97316',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'glacier': {
      name: 'Glacier',
      category: 'nature',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0c1929',
        surface: '#142233',
        surface2: '#1e3a5e',
        text: '#e0f7fa',
        muted: '#80deea',
        border: 'rgba(128,222,234,.12)',
        accent: '#7dd3fc',
        accentBg: 'rgba(125,211,252,.12)',
        green: '#26c6da',
        red: '#ff6e40',
        gold: '#ffb74d',
        blue: '#7dd3fc'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'thunderstorm': {
      name: 'Thunderstorm',
      category: 'nature',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0d0d1a',
        surface: '#12223D',
        surface2: '#26264a',
        text: '#e8eaf6',
        muted: '#9fa8da',
        border: 'rgba(159,168,218,.12)',
        accent: '#fbbf24',
        accentBg: 'rgba(251,191,36,.12)',
        green: '#4dd0e1',
        red: '#ef5350',
        gold: '#fbbf24',
        blue: '#5c6bc0'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'sunset': {
      name: 'Sunset',
      category: 'nature',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0a15',
        surface: '#2a1020',
        surface2: '#3a1a30',
        text: '#ffe0d2',
        muted: '#ffb3b3',
        border: 'rgba(255,179,179,.12)',
        accent: '#f97316',
        accentBg: 'rgba(249,115,22,.12)',
        green: '#26a69a',
        red: '#ef5350',
        gold: '#ffd54f',
        blue: '#29b6f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'canyon': {
      name: 'Canyon',
      category: 'nature',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#2a1a10',
        surface: '#3d2a1a',
        surface2: '#4d3a2a',
        text: '#f5deb3',
        muted: '#d4a574',
        border: 'rgba(212,165,116,.12)',
        accent: '#c2410c',
        accentBg: 'rgba(194,65,12,.12)',
        green: '#8bc34a',
        red: '#d32f2f',
        gold: '#ffa726',
        blue: '#1976d2'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'coral-reef': {
      name: 'Coral Reef',
      category: 'nature',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1a2a',
        surface: '#0f2540',
        surface2: '#1a3a5e',
        text: '#e0f2f1',
        muted: '#80deea',
        border: 'rgba(128,222,234,.12)',
        accent: '#f472b6',
        accentBg: 'rgba(244,114,182,.12)',
        green: '#26a69a',
        red: '#f472b6',
        gold: '#ffd54f',
        blue: '#2dd4bf'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'tundra': {
      name: 'Tundra',
      category: 'nature',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1f2e',
        surface: '#252b3d',
        surface2: '#35404e',
        text: '#e2e8f0',
        muted: '#cbd5e1',
        border: 'rgba(203,213,225,.12)',
        accent: '#e2e8f0',
        accentBg: 'rgba(226,232,240,.08)',
        green: '#5eead4',
        red: '#fca5a5',
        gold: '#fcd34d',
        blue: '#7dd3fc'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'rainforest': {
      name: 'Rainforest',
      category: 'nature',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1a0a',
        surface: '#0f2a0f',
        surface2: '#1a3a1a',
        text: '#d4f1d4',
        muted: '#a5d6a7',
        border: 'rgba(165,214,167,.12)',
        accent: '#10b981',
        accentBg: 'rgba(16,185,129,.12)',
        green: '#10b981',
        red: '#ef5350',
        gold: '#f59e0b',
        blue: '#06b6d4'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },

    // LUXURY & PREMIUM (8)
    'crimson': {
      name: 'Crimson',
      category: 'luxury',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0505',
        surface: '#2a0a0a',
        surface2: '#3a1515',
        text: '#fde4e4',
        muted: '#f8a5a5',
        border: 'rgba(248,165,165,.12)',
        accent: '#dc2626',
        accentBg: 'rgba(220,38,38,.12)',
        green: '#10b981',
        red: '#dc2626',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'gold': {
      name: 'Gold',
      category: 'luxury',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1505',
        surface: '#2a2008',
        surface2: '#3a3010',
        text: '#fff9e6',
        muted: '#ffd699',
        border: 'rgba(255,214,153,.12)',
        accent: '#eab308',
        accentBg: 'rgba(234,179,8,.12)',
        green: '#10b981',
        red: '#dc2626',
        gold: '#eab308',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'rose': {
      name: 'Rose',
      category: 'luxury',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0a10',
        surface: '#2a1018',
        surface2: '#3a1a28',
        text: '#ffe4e8',
        muted: '#f8b3c1',
        border: 'rgba(248,179,193,.12)',
        accent: '#f43f5e',
        accentBg: 'rgba(244,63,94,.12)',
        green: '#10b981',
        red: '#f43f5e',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'diamond': {
      name: 'Diamond',
      category: 'luxury',
      locked: true,
      unlockCondition: 'Complete 50 theme customizations',
      colors: {
        bg: '#0a0a12',
        surface: '#15152a',
        surface2: '#20204a',
        text: '#f5f3ff',
        muted: '#e0d9f9',
        border: 'rgba(224,217,249,.12)',
        accent: '#a78bfa',
        accentBg: 'rgba(167,139,250,.12)',
        green: '#a78bfa',
        red: '#f87171',
        gold: '#fcd34d',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: 'glow',
      specialClass: null
    },
    'marble': {
      name: 'Marble',
      category: 'luxury',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1a1a',
        surface: '#2a2a2a',
        surface2: '#3a3a3a',
        text: '#e2e8f0',
        muted: '#9ca3af',
        border: 'rgba(255,255,255,.08)',
        accent: '#e2e8f0',
        accentBg: 'rgba(226,232,240,.08)',
        green: '#10b981',
        red: '#fca5a5',
        gold: '#fcd34d',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'velvet': {
      name: 'Velvet',
      category: 'luxury',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0510',
        surface: '#2a0a1a',
        surface2: '#3a1a2a',
        text: '#f3e8ff',
        muted: '#e9d5ff',
        border: 'rgba(233,213,255,.12)',
        accent: '#a855f7',
        accentBg: 'rgba(168,85,247,.12)',
        green: '#10b981',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'champagne': {
      name: 'Champagne',
      category: 'luxury',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1810',
        surface: '#2a2518',
        surface2: '#3a3528',
        text: '#fffbf0',
        muted: '#f4d5a3',
        border: 'rgba(244,213,163,.12)',
        accent: '#fbbf24',
        accentBg: 'rgba(251,191,36,.12)',
        green: '#10b981',
        red: '#fca5a5',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'onyx': {
      name: 'Onyx',
      category: 'luxury',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#050505',
        surface: '#0a0a0a',
        surface2: '#151515',
        text: '#f5f5f5',
        muted: '#6b7280',
        border: 'rgba(107,114,128,.12)',
        accent: '#6b7280',
        accentBg: 'rgba(107,114,128,.12)',
        green: '#10b981',
        red: '#ef5350',
        gold: '#ffc107',
        blue: '#29b6f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },

    // SCI-FI & CYBER (12)
    'matrix': {
      name: 'Matrix',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#020a02',
        surface: '#072007',
        surface2: '#0d3a0d',
        text: '#86efac',
        muted: '#22c55e',
        border: 'rgba(34,197,94,.28)',
        accent: '#22c55e',
        accentBg: 'rgba(34,197,94,.18)',
        green: '#22c55e',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'code-rain' },
      font: { heading: "'Courier New', monospace", body: "'Courier New', monospace" },
      cursor: 'crosshair',
      borderRadius: '0px',
      borderStyle: 'solid',
      transition: '0.1s linear',
      cardEffect: 'glow',
      specialClass: null
    },
    'neon': {
      name: 'Neon',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0010',
        surface: '#150020',
        surface2: '#1a0030',
        text: '#fff0f6',
        muted: '#f472b6',
        border: 'rgba(244,114,182,.12)',
        accent: '#ec4899',
        accentBg: 'rgba(236,72,153,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'neon-flicker' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '4px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: 'glow',
      specialClass: null
    },
    'synthwave': {
      name: 'Synthwave',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0530',
        surface: '#2a0845',
        surface2: '#3a1855',
        text: '#fff0f6',
        muted: '#f472b6',
        border: 'rgba(244,114,182,.12)',
        accent: '#f472b6',
        accentBg: 'rgba(244,114,182,.12)',
        green: '#22d3ee',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#22d3ee'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'vaporwave': {
      name: 'Vaporwave',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1040',
        surface: '#2a1855',
        surface2: '#3a2865',
        text: '#f0abfc',
        muted: '#5eead4',
        border: 'rgba(94,234,212,.12)',
        accent: '#f0abfc',
        accentBg: 'rgba(240,171,252,.12)',
        green: '#5eead4',
        red: '#f87171',
        gold: '#fcd34d',
        blue: '#5eead4'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: null,
      specialClass: null
    },
    'deep-space': {
      name: 'Deep Space',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#020208',
        surface: '#0a0a15',
        surface2: '#15151f',
        text: '#e0deff',
        muted: '#a5b4fc',
        border: 'rgba(165,180,252,.12)',
        accent: '#8b5cf6',
        accentBg: 'rgba(139,92,246,.12)',
        green: '#34d399',
        red: '#fca5a5',
        gold: '#fcd34d',
        blue: '#60a5fa'
      },
      overlay: { type: 'star-field' }, // was 'starfield' — typo'd against the registered overlayLibrary key, silently rendered nothing
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'galaxy': {
      name: 'Galaxy',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#05050f',
        surface: '#0a0a1f',
        surface2: '#15152f',
        text: '#e8eaff',
        muted: '#a5aeff',
        border: 'rgba(165,174,255,.12)',
        accent: '#6366f1',
        accentBg: 'rgba(99,102,241,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#6366f1'
      },
      // Was 'none' — a real overlay was never assigned. star-field is a
      // genuine fit for a theme literally named Galaxy: two parallax
      // star-depth layers, two static planets, a rare shooting star.
      overlay: { type: 'star-field', color: 'rgba(230,230,255,.9)', density: 0.6, speed: 0.3 },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'plasma': {
      name: 'Plasma',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0020',
        surface: '#2a0035',
        surface2: '#3a0050',
        text: '#f3e8ff',
        muted: '#e9d5ff',
        border: 'rgba(233,213,255,.12)',
        accent: '#a855f7',
        accentBg: 'rgba(168,85,247,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'plasma-surge' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'dashed',
      transition: '0.15s ease',
      cardEffect: 'glow',
      specialClass: null
    },
    'glow': {
      name: 'Glow',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a0a',
        surface: '#151515',
        surface2: '#202020',
        text: '#f5f5f5',
        muted: '#aaaaaa',
        border: 'rgba(255,255,255,.08)',
        accent: '#84cc16',
        accentBg: 'rgba(132,204,22,.12)',
        green: '#84cc16',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: 'glow',
      specialClass: null
    },
    'cyberpunk': {
      name: 'Cyberpunk',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a000a',
        surface: '#1a0515',
        surface2: '#2a0a25',
        text: '#fff0f6',
        muted: '#f472b6',
        border: 'rgba(244,114,182,.12)',
        accent: '#ec4899',
        accentBg: 'rgba(236,72,153,.12)',
        green: '#34d399',
        red: '#fca5a5',
        gold: '#fcd34d',
        blue: '#06b6d4'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: 'pointer',
      borderRadius: '2px',
      borderStyle: 'solid',
      transition: '0.1s ease',
      cardEffect: null,
      specialClass: null
    },
    'hologram': {
      name: 'Hologram',
      category: 'scifi',
      locked: true,
      unlockCondition: 'Master 5 different themes in builder',
      colors: {
        bg: '#05050a',
        surface: '#0f0f1a',
        surface2: '#1a1a2a',
        text: '#e8f4f8',
        muted: '#90caf9',
        border: 'rgba(144,202,249,.12)',
        accent: '#bbdefb',
        accentBg: 'rgba(187,222,251,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'holographic-shift' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'double',
      transition: '0.3s ease',
      cardEffect: 'glow',
      specialClass: null
    },
    'quantum': {
      name: 'Quantum',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#000510',
        surface: '#001020',
        surface2: '#002040',
        text: '#e0f2fe',
        muted: '#7dd3fc',
        border: 'rgba(125,211,252,.12)',
        accent: '#3b82f6',
        accentBg: 'rgba(59,130,246,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'starship': {
      name: 'Starship',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0f1520',
        surface: '#1a2030',
        surface2: '#253849',
        text: '#e2e8f0',
        muted: '#cbd5e1',
        border: 'rgba(203,213,225,.12)',
        accent: '#f97316',
        accentBg: 'rgba(249,115,22,.12)',
        green: '#22c55e',
        red: '#ef5350',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },

    // POP CULTURE (15)
    'batman': {
      name: 'Batman',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a0a',
        surface: '#1a1a1a',
        surface2: '#2a2a2a',
        text: '#f5f5f5',
        muted: '#999999',
        border: 'rgba(255,255,255,.08)',
        accent: '#fbbf24',
        accentBg: 'rgba(251,191,36,.12)',
        green: '#22c55e',
        red: '#dc2626',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'darth-vader': {
      name: 'Darth Vader',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a0a',
        surface: '#151515',
        surface2: '#202020',
        text: '#e8e8e8',
        muted: '#888888',
        border: 'rgba(255,255,255,.08)',
        accent: '#ef4444',
        accentBg: 'rgba(239,68,68,.12)',
        green: '#34d399',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'lightsaber': {
      name: 'Lightsaber',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a15',
        surface: '#0f0f22',
        surface2: '#1a1a35',
        text: '#e8eaff',
        muted: '#a5b4fc',
        border: 'rgba(165,180,252,.12)',
        accent: '#60a5fa',
        accentBg: 'rgba(96,165,250,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: 'glow',
      specialClass: null
    },
    'pokemon': {
      name: 'Pokemon',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0a0a',
        surface: '#2a1515',
        surface2: '#3a2525',
        text: '#fde4e4',
        muted: '#f8a5a5',
        border: 'rgba(248,165,165,.12)',
        accent: '#ef4444',
        accentBg: 'rgba(239,68,68,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'mario': {
      name: 'Mario',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0a0a',
        surface: '#2a1010',
        surface2: '#3a1a1a',
        text: '#ffe4d6',
        muted: '#ffb3ba',
        border: 'rgba(255,179,186,.12)',
        accent: '#dc2626',
        accentBg: 'rgba(220,38,38,.12)',
        green: '#22c55e',
        red: '#dc2626',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '4px',
      borderStyle: 'solid',
      transition: '0.1s steps(4, end)',
      cardEffect: null,
      specialClass: null
    },
    'zelda': {
      name: 'Zelda',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1a0a',
        surface: '#0f2a0f',
        surface2: '#1a3a1a',
        text: '#d4f1d4',
        muted: '#a5d6a7',
        border: 'rgba(165,214,167,.12)',
        accent: '#eab308',
        accentBg: 'rgba(234,179,8,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#eab308',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'arcade': {
      name: 'Arcade',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a15',
        surface: '#0f0f22',
        surface2: '#1a1a35',
        text: '#f5f5f5',
        muted: '#aaaaaa',
        border: 'rgba(34,197,94,.12)',
        accent: '#22c55e',
        accentBg: 'rgba(34,197,94,.12)',
        green: '#22c55e',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: "'Press Start 2P', monospace", body: "'Press Start 2P', monospace" },
      cursor: null,
      borderRadius: '0px',
      borderStyle: 'solid',
      transition: '0.05s steps(2, end)',
      cardEffect: null,
      specialClass: null
    },
    'retro': {
      name: 'Retro',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1520',
        surface: '#2a2030',
        surface2: '#3a3040',
        text: '#ffe4e8',
        muted: '#f8a5a5',
        border: 'rgba(248,165,165,.12)',
        accent: '#f97316',
        accentBg: 'rgba(249,115,22,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '4px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },
    'mandalorian': {
      name: 'Mandalorian',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1a15',
        surface: '#2a2a22',
        surface2: '#3a3a32',
        text: '#f5f5f0',
        muted: '#c0c0c0',
        border: 'rgba(192,192,192,.12)',
        accent: '#94a3b8',
        accentBg: 'rgba(148,163,184,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'iron-man': {
      name: 'Iron Man',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0505',
        surface: '#2a0a0a',
        surface2: '#3a1515',
        text: '#ffe4d6',
        muted: '#ffb3ba',
        border: 'rgba(255,179,186,.12)',
        accent: '#38bdf8',
        accentBg: 'rgba(56,189,248,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#eab308',
        blue: '#38bdf8'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: 'glow',
      specialClass: null
    },
    'joker': {
      name: 'Joker',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1a0a',
        surface: '#0f2a12',
        surface2: '#1a3a1a',
        text: '#e8f5e9',
        muted: '#a5d6a7',
        border: 'rgba(165,214,167,.12)',
        accent: '#22c55e',
        accentBg: 'rgba(34,197,94,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#a855f7'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'tron': {
      name: 'TRON',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#000a1a',
        surface: '#001530',
        surface2: '#002545',
        text: '#e8f4f8',
        muted: '#90caf9',
        border: 'rgba(144,202,249,.12)',
        accent: '#06b6d4',
        accentBg: 'rgba(6,182,212,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#06b6d4'
      },
      overlay: { type: 'none' },
      font: { heading: "'Orbitron', monospace", body: "'Orbitron', monospace" },
      cursor: null,
      borderRadius: '2px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: 'glow',
      specialClass: null
    },
    'stranger-things': {
      name: 'Stranger Things',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0505',
        surface: '#1a0f0f',
        surface2: '#2a1a1a',
        text: '#ffe4e8',
        muted: '#f8a5a5',
        border: 'rgba(248,165,165,.12)',
        accent: '#ef4444',
        accentBg: 'rgba(239,68,68,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'top-gun': {
      name: 'Top Gun',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0f1a',
        surface: '#152030',
        surface2: '#253849',
        text: '#e2e8f0',
        muted: '#cbd5e1',
        border: 'rgba(203,213,225,.12)',
        accent: '#d4a057',
        accentBg: 'rgba(212,160,87,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#d4a057',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'john-wick': {
      name: 'John Wick',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a0a',
        surface: '#151515',
        surface2: '#202020',
        text: '#e8e8e8',
        muted: '#888888',
        border: 'rgba(255,255,255,.08)',
        accent: '#b8860b',
        accentBg: 'rgba(184,134,11,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#b8860b',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },

    // SPORTS & ENERGY (8)
    'racing-red': {
      name: 'Racing Red',
      category: 'sports',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0505',
        surface: '#2a0808',
        surface2: '#3a1515',
        text: '#fde4e4',
        muted: '#f8a5a5',
        border: 'rgba(248,165,165,.12)',
        accent: '#dc2626',
        accentBg: 'rgba(220,38,38,.12)',
        green: '#22c55e',
        red: '#dc2626',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },
    'stadium-lights': {
      name: 'Stadium Lights',
      category: 'sports',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a0a',
        surface: '#1a1a1a',
        surface2: '#2a2a2a',
        text: '#f8fafc',
        muted: '#cbd5e1',
        border: 'rgba(203,213,225,.12)',
        accent: '#f8fafc',
        accentBg: 'rgba(248,250,252,.08)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: 'glow',
      specialClass: null
    },
    'champion-gold': {
      name: 'Champion Gold',
      category: 'sports',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1508',
        surface: '#2a2210',
        surface2: '#3a3218',
        text: '#fffbf0',
        muted: '#f4d5a3',
        border: 'rgba(244,213,163,.12)',
        accent: '#eab308',
        accentBg: 'rgba(234,179,8,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#eab308',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'endzone': {
      name: 'Endzone',
      category: 'sports',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1a0a',
        surface: '#0f2a15',
        surface2: '#1a3a20',
        text: '#d4f1d4',
        muted: '#a5d6a7',
        border: 'rgba(165,214,167,.12)',
        accent: '#16a34a',
        accentBg: 'rgba(22,163,74,.12)',
        green: '#16a34a',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'fast-break': {
      name: 'Fast Break',
      category: 'sports',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0510',
        surface: '#150a1a',
        surface2: '#1f1a28',
        text: '#ffe4d6',
        muted: '#ffb3ba',
        border: 'rgba(255,179,186,.12)',
        accent: '#f97316',
        accentBg: 'rgba(249,115,22,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },
    'knockout': {
      name: 'Knockout',
      category: 'sports',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0505',
        surface: '#2a0a0a',
        surface2: '#3a1515',
        text: '#fde4e4',
        muted: '#f8a5a5',
        border: 'rgba(248,165,165,.12)',
        accent: '#dc2626',
        accentBg: 'rgba(220,38,38,.12)',
        green: '#22c55e',
        red: '#dc2626',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.1s ease',
      cardEffect: null,
      specialClass: null
    },
    'checkered-flag': {
      name: 'Checkered Flag',
      category: 'sports',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a0a',
        surface: '#1a1a1a',
        surface2: '#2a2a2a',
        text: '#f5f5f5',
        muted: '#aaaaaa',
        border: 'rgba(255,255,255,.08)',
        accent: '#eab308',
        accentBg: 'rgba(234,179,8,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#eab308',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'trophy': {
      name: 'Trophy',
      category: 'sports',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1508',
        surface: '#2a2210',
        surface2: '#3a3218',
        text: '#fffbf0',
        muted: '#f4d5a3',
        border: 'rgba(244,213,163,.12)',
        accent: '#d4a057',
        accentBg: 'rgba(212,160,87,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#d4a057',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },

    // CONSTRUCTION & TRADE (10)
    'blueprint': {
      name: 'Blueprint',
      category: 'construction',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1a3a',
        surface: '#0f2550',
        surface2: '#1a3a70',
        text: '#e0f2ff',
        muted: '#90caf9',
        border: 'rgba(144,202,249,.12)',
        accent: '#38bdf8',
        accentBg: 'rgba(56,189,248,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#38bdf8'
      },
      overlay: { type: 'grid-lines' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'dashed',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'hard-hat': {
      name: 'Hard Hat',
      category: 'construction',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1a08',
        surface: '#2a2a10',
        surface2: '#3a3a18',
        text: '#fffde7',
        muted: '#f9d1a0',
        border: 'rgba(249,209,160,.12)',
        accent: '#eab308',
        accentBg: 'rgba(234,179,8,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#eab308',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'concrete': {
      name: 'Concrete',
      category: 'construction',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1a1a',
        surface: '#2a2a2a',
        surface2: '#3a3a3a',
        text: '#e2e8f0',
        muted: '#9ca3af',
        border: 'rgba(255,255,255,.08)',
        accent: '#6b7280',
        accentBg: 'rgba(107,114,128,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'noise' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '4px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'copper-pipe': {
      name: 'Copper Pipe',
      category: 'construction',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1008',
        surface: '#2a1a10',
        surface2: '#3a2a20',
        text: '#f5deb3',
        muted: '#d4a574',
        border: 'rgba(212,165,116,.12)',
        accent: '#c2774a',
        accentBg: 'rgba(194,119,74,.12)',
        green: '#8bc34a',
        red: '#ff7043',
        gold: '#c2774a',
        blue: '#5c6bc0'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'safety-orange': {
      name: 'Safety Orange',
      category: 'construction',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0a00',
        surface: '#2a1505',
        surface2: '#3a2510',
        text: '#fff0e6',
        muted: '#ffb3ba',
        border: 'rgba(255,179,186,.12)',
        accent: '#f97316',
        accentBg: 'rgba(249,115,22,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'crane': {
      name: 'Crane',
      category: 'construction',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1a08',
        surface: '#2a2a10',
        surface2: '#3a3a18',
        text: '#fffde7',
        muted: '#f9d1a0',
        border: 'rgba(249,209,160,.12)',
        accent: '#fbbf24',
        accentBg: 'rgba(251,191,36,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'diesel': {
      name: 'Diesel',
      category: 'construction',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a08',
        surface: '#1a1a12',
        surface2: '#2a2a20',
        text: '#e8e8e0',
        muted: '#999990',
        border: 'rgba(153,153,144,.12)',
        accent: '#84cc16',
        accentBg: 'rgba(132,204,22,.12)',
        green: '#84cc16',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'sawdust': {
      name: 'Sawdust',
      category: 'construction',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1510',
        surface: '#2a2218',
        surface2: '#3a3228',
        text: '#f5deb3',
        muted: '#d4a574',
        border: 'rgba(212,165,116,.12)',
        accent: '#a0724a',
        accentBg: 'rgba(160,114,74,.12)',
        green: '#8bc34a',
        red: '#d4a574',
        gold: '#c9a961',
        blue: '#5c6bc0'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'brick': {
      name: 'Brick',
      category: 'construction',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0a08',
        surface: '#2a1510',
        surface2: '#3a2520',
        text: '#ffe4d6',
        muted: '#ffb3ba',
        border: 'rgba(255,179,186,.12)',
        accent: '#b91c1c',
        accentBg: 'rgba(185,28,28,.12)',
        green: '#22c55e',
        red: '#b91c1c',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'brick-pattern' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '4px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'toolbox': {
      name: 'Toolbox',
      category: 'construction',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a15',
        surface: '#151522',
        surface2: '#20202f',
        text: '#e2e8f0',
        muted: '#cbd5e1',
        border: 'rgba(203,213,225,.12)',
        accent: '#ef4444',
        accentBg: 'rgba(239,68,68,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#94a3b8'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },

    // MOOD & AESTHETIC (10)
    'lo-fi': {
      name: 'Lo-Fi',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1815',
        surface: '#2a2520',
        surface2: '#3a3530',
        text: '#e8e4dc',
        muted: '#b8a898',
        border: 'rgba(232,228,220,.12)',
        accent: '#d4c5a9',
        accentBg: 'rgba(212,197,169,.12)',
        green: '#a0a878',
        red: '#d48484',
        gold: '#d4a574',
        blue: '#7a8fa0'
      },
      overlay: { type: 'vinyl-noise' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '16px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: null,
      specialClass: null
    },
    'dark-academia': {
      name: 'Dark Academia',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1510',
        surface: '#2a2218',
        surface2: '#3a3228',
        text: '#f5deb3',
        muted: '#d4a574',
        border: 'rgba(212,165,116,.12)',
        accent: '#b8860b',
        accentBg: 'rgba(184,134,11,.12)',
        green: '#8bc34a',
        red: '#d4a574',
        gold: '#b8860b',
        blue: '#5c6bc0'
      },
      overlay: { type: 'none' },
      font: { heading: "'Georgia', serif", body: "'Georgia', serif" },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: null,
      specialClass: null
    },
    'cottagecore': {
      name: 'Cottagecore',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1510',
        surface: '#2a2520',
        surface2: '#3a3530',
        text: '#e8e4dc',
        muted: '#b8a898',
        border: 'rgba(232,228,220,.12)',
        accent: '#86a873',
        accentBg: 'rgba(134,168,115,.12)',
        green: '#86a873',
        red: '#a08070',
        gold: '#d4a574',
        blue: '#7a8fa0'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '16px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: null,
      specialClass: null
    },
    'minimalist': {
      name: 'Minimalist',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#fafafa',
        surface: '#ffffff',
        surface2: '#f5f5f5',
        text: '#1a1a1a',
        muted: '#888888',
        border: 'rgba(0,0,0,.08)',
        accent: '#1a1a1a',
        accentBg: 'rgba(0,0,0,.04)',
        green: '#2d5016',
        red: '#a4001c',
        gold: '#8b7355',
        blue: '#0052a3'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.25s ease',
      cardEffect: null,
      specialClass: 'light-theme'
    },
    'brutalist': {
      name: 'Brutalist',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#d4d0c8',
        surface: '#e8e4dc',
        surface2: '#f0ebe3',
        text: '#000000',
        muted: '#555555',
        border: 'rgba(0,0,0,.2)',
        accent: '#000000',
        accentBg: 'rgba(0,0,0,.1)',
        green: '#333333',
        red: '#000000',
        gold: '#444444',
        blue: '#222222'
      },
      overlay: { type: 'none' },
      font: { heading: "'Courier New', monospace", body: "'Courier New', monospace" },
      cursor: null,
      borderRadius: '0px',
      borderStyle: 'solid',
      transition: '0s',
      cardEffect: null,
      specialClass: 'light-theme'
    },
    'art-deco': {
      name: 'Art Deco',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a08',
        surface: '#1a1a12',
        surface2: '#2a2a20',
        text: '#fffde7',
        muted: '#f9d1a0',
        border: 'rgba(249,209,160,.12)',
        accent: '#d4a057',
        accentBg: 'rgba(212,160,87,.12)',
        green: '#8bc34a',
        red: '#ff7043',
        gold: '#d4a057',
        blue: '#5c6bc0'
      },
      overlay: { type: 'geometric-pattern' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '20px',
      borderStyle: 'solid',
      transition: '0.25s ease',
      cardEffect: null,
      specialClass: null
    },
    'noir': {
      name: 'Noir',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#141416',
        surface: '#1f1f22',
        surface2: '#2a2a2e',
        text: '#f5f5f5',
        muted: '#9aa0aa',
        border: 'rgba(255,255,255,.12)',
        accent: '#dc2626',
        accentBg: 'rgba(220,38,38,.16)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'film-grain' },
      font: { heading: "'Georgia', serif", body: "'Georgia', serif" },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'polaroid': {
      name: 'Polaroid',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      mode: 'light',
      colors: {
        bg: '#f5f0eb',
        surface: '#fffaf3',
        surface2: '#f9f4ec',
        text: '#2c2520',
        muted: '#7a6e62',
        border: 'rgba(0,0,0,.12)',
        accent: '#2c7a7b',
        accentBg: 'rgba(44,122,123,.14)',
        green: '#2d5016',
        red: '#a4001c',
        gold: '#b07820',
        blue: '#2c5282'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: null,
      specialClass: null
    },
    'grunge': {
      name: 'Grunge',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a08',
        surface: '#1a1a10',
        surface2: '#2a2a20',
        text: '#e8e8e0',
        muted: '#999990',
        border: 'rgba(153,153,144,.12)',
        accent: '#a3903f',
        accentBg: 'rgba(163,144,63,.12)',
        green: '#8bc34a',
        red: '#d4a574',
        gold: '#a3903f',
        blue: '#5c6bc0'
      },
      overlay: { type: 'texture-distress' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '4px',
      borderStyle: 'dashed',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },
    'vapor-room': {
      name: 'Vapor Room',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0a2a',
        surface: '#2a1040',
        surface2: '#3a1860',
        text: '#f0abfc',
        muted: '#e879f9',
        border: 'rgba(232,121,249,.12)',
        accent: '#e879f9',
        accentBg: 'rgba(232,121,249,.12)',
        green: '#5eead4',
        red: '#f87171',
        gold: '#fcd34d',
        blue: '#5eead4'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '20px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: null,
      specialClass: null
    },

    // SEASONAL (6)
    'pumpkin-patch': {
      name: 'Pumpkin Patch',
      category: 'seasonal',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0a05',
        surface: '#2a1508',
        surface2: '#3a2515',
        text: '#fff0e6',
        muted: '#ffb3ba',
        border: 'rgba(255,179,186,.12)',
        accent: '#f97316',
        accentBg: 'rgba(249,115,22,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '20px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: null,
      specialClass: null
    },
    'snowfall': {
      name: 'Snowfall',
      category: 'seasonal',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0f172a',
        surface: '#1e293b',
        surface2: '#334155',
        text: '#f1f5f9',
        muted: '#cbd5e1',
        border: 'rgba(203,213,225,.12)',
        accent: '#f1f5f9',
        accentBg: 'rgba(241,245,249,.08)',
        green: '#34d399',
        red: '#fca5a5',
        gold: '#fcd34d',
        blue: '#7dd3fc'
      },
      overlay: { type: 'snowflake-drift' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.25s ease',
      cardEffect: null,
      specialClass: null
    },
    'spring-bloom': {
      name: 'Spring Bloom',
      category: 'seasonal',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1a0a',
        surface: '#0f2a15',
        surface2: '#1a3a20',
        text: '#f9e0ec',
        muted: '#f9a8d4',
        border: 'rgba(249,168,212,.12)',
        accent: '#f9a8d4',
        accentBg: 'rgba(249,168,212,.12)',
        green: '#22c55e',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'petal-float' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '20px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: null,
      specialClass: null
    },
    'summer-heat': {
      name: 'Summer Heat',
      category: 'seasonal',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1005',
        surface: '#2a1a08',
        surface2: '#3a2a10',
        text: '#fffbf0',
        muted: '#f4d5a3',
        border: 'rgba(244,213,163,.12)',
        accent: '#fbbf24',
        accentBg: 'rgba(251,191,36,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      // 'heat-shimmer' was never registered in ThemeOverlays' overlayLibrary —
      // silently rendered nothing. Repointed at the existing, working
      // ember-particles effect at low density until a real heat-shimmer
      // effect gets built.
      overlay: { type: 'ember-particles', density: 0.4, speed: 0.8 },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '20px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: null,
      specialClass: null
    },
    'fourth-of-july': {
      name: 'Fourth of July',
      category: 'seasonal',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a1a',
        surface: '#0f0f2a',
        surface2: '#1a1a3a',
        text: '#f5f5f5',
        muted: '#cbd5e1',
        border: 'rgba(203,213,225,.12)',
        accent: '#ef4444',
        accentBg: 'rgba(239,68,68,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'fireworks' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'storm-season': {
      name: 'Storm Season',
      category: 'seasonal',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a10',
        surface: '#15151f',
        surface2: '#20202f',
        text: '#e2e8f0',
        muted: '#64748b',
        border: 'rgba(100,119,139,.12)',
        accent: '#64748b',
        accentBg: 'rgba(100,119,139,.12)',
        green: '#34d399',
        red: '#ef5350',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },

    // ANIME (25)
    'dragon-ball-z': {
      name: 'Dragon Ball Z',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0a00',
        surface: '#2a1505',
        surface2: '#3a2510',
        text: '#fff0e6',
        muted: '#ffb3ba',
        border: 'rgba(255,179,186,.12)',
        accent: '#e86a10',
        accentBg: 'rgba(232,106,16,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#ffd700',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.1s steps(2, end)',
      cardEffect: null,
      specialClass: null
    },
    'naruto': {
      name: 'Naruto',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0a00',
        surface: '#2a1505',
        surface2: '#3a2510',
        text: '#fff0e6',
        muted: '#ffb3ba',
        border: 'rgba(255,179,186,.12)',
        accent: '#ff6b2b',
        accentBg: 'rgba(255,107,43,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'scroll-texture' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'one-piece': {
      name: 'One Piece',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1a2a',
        surface: '#0f2540',
        surface2: '#1a3a5e',
        text: '#e0f2f1',
        muted: '#80deea',
        border: 'rgba(128,222,234,.12)',
        accent: '#d4a057',
        accentBg: 'rgba(212,160,87,.12)',
        green: '#22c55e',
        red: '#dc2626',
        gold: '#d4a057',
        blue: '#3b82f6'
      },
      overlay: { type: 'compass-rose' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'attack-on-titan': {
      name: 'Attack on Titan',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0f1a0f',
        surface: '#1a2a1a',
        surface2: '#2a3a2a',
        text: '#d4f1d4',
        muted: '#a5d6a7',
        border: 'rgba(165,214,167,.12)',
        accent: '#4a7a4a',
        accentBg: 'rgba(74,122,74,.12)',
        green: '#22c55e',
        red: '#8b0000',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'vertical-lines' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },
    'demon-slayer': {
      name: 'Demon Slayer',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a1a',
        surface: '#0f1530',
        surface2: '#1a2545',
        text: '#e8f4f8',
        muted: '#90caf9',
        border: 'rgba(144,202,249,.12)',
        accent: '#4fc3f7',
        accentBg: 'rgba(79,195,247,.12)',
        green: '#22c55e',
        red: '#ff6d00',
        gold: '#fbbf24',
        blue: '#4fc3f7'
      },
      overlay: { type: 'water-flow' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'my-hero-academia': {
      name: 'My Hero Academia',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1a0a',
        surface: '#1b5e20',
        surface2: '#2e7d32',
        text: '#d4f1d4',
        muted: '#a5d6a7',
        border: 'rgba(165,214,167,.12)',
        accent: '#22c55e',
        accentBg: 'rgba(34,197,94,.12)',
        green: '#22c55e',
        red: '#f44336',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'death-note': {
      name: 'Death Note',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#050505',
        surface: '#0a0a0a',
        surface2: '#151515',
        text: '#f5f5f5',
        muted: '#aaaaaa',
        border: 'rgba(255,255,255,.08)',
        accent: '#b71c1c',
        accentBg: 'rgba(183,28,28,.12)',
        green: '#22c55e',
        red: '#b71c1c',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'ruled-lines' },
      font: { heading: "'Georgia', serif", body: "'Georgia', serif" },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },
    'cowboy-bebop': {
      name: 'Cowboy Bebop',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1008',
        surface: '#3e2723',
        surface2: '#4a3229',
        text: '#f5deb3',
        muted: '#d4a574',
        border: 'rgba(212,165,116,.12)',
        accent: '#ffb300',
        accentBg: 'rgba(255,179,0,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#ffb300',
        blue: '#00897b'
      },
      overlay: { type: 'film-grain' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'evangelion': {
      name: 'Evangelion',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0530',
        surface: '#4a148c',
        surface2: '#5e1aa1',
        text: '#f0f0f0',
        muted: '#b19cd9',
        border: 'rgba(177,156,217,.12)',
        accent: '#ff6d00',
        accentBg: 'rgba(255,109,0,.12)',
        green: '#76ff03',
        red: '#ff6d00',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'hexagonal-grid' },
      font: { heading: "'Courier New', monospace", body: "'Courier New', monospace" },
      cursor: null,
      borderRadius: '2px',
      borderStyle: 'solid',
      transition: '0.1s ease',
      cardEffect: null,
      specialClass: null
    },
    'akira': {
      name: 'Akira',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1a1a',
        surface: '#2a2a2a',
        surface2: '#3a3a3a',
        text: '#f5f5f5',
        muted: '#aaaaaa',
        border: 'rgba(255,255,255,.08)',
        accent: '#d50000',
        accentBg: 'rgba(213,0,0,.12)',
        green: '#22c55e',
        red: '#d50000',
        gold: '#fbbf24',
        blue: '#00e5ff'
      },
      overlay: { type: 'perspective-grid' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '4px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },
    'studio-ghibli': {
      name: 'Studio Ghibli',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      mode: 'light',
      colors: {
        bg: '#fff8e1',
        surface: '#ffffff',
        surface2: '#f5f5f0',
        text: '#1a3a1a',
        muted: '#5d6b5d',
        border: 'rgba(45,80,22,.14)',
        accent: '#2e7d32',
        accentBg: 'rgba(46,125,50,.14)',
        green: '#2e7d32',
        red: '#8d4e25',
        gold: '#a06820',
        blue: '#1976d2'
      },
      overlay: { type: 'watercolor' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '16px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: null,
      specialClass: 'light-theme'
    },
    'jujutsu-kaisen': {
      name: 'Jujutsu Kaisen',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0015',
        surface: '#1a0033',
        surface2: '#2a0050',
        text: '#f3e8ff',
        muted: '#e9d5ff',
        border: 'rgba(233,213,255,.12)',
        accent: '#7c4dff',
        accentBg: 'rgba(124,77,255,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'dark-particles' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'bleach': {
      name: 'Bleach',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#050508',
        surface: '#0a0a12',
        surface2: '#15151f',
        text: '#eceff1',
        muted: '#b0bec5',
        border: 'rgba(176,190,197,.12)',
        accent: '#2979ff',
        accentBg: 'rgba(41,121,255,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#2979ff'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'hunter-x-hunter': {
      name: 'Hunter x Hunter',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1a0a',
        surface: '#1b3a1b',
        surface2: '#2a5a2a',
        text: '#d4f1d4',
        muted: '#a5d6a7',
        border: 'rgba(165,214,167,.12)',
        accent: '#22c55e',
        accentBg: 'rgba(34,197,94,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'fullmetal-alchemist': {
      name: 'Fullmetal Alchemist',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a1a',
        surface: '#1a237e',
        surface2: '#283593',
        text: '#e8eaff',
        muted: '#a5b4fc',
        border: 'rgba(165,180,252,.12)',
        accent: '#ffc107',
        accentBg: 'rgba(255,193,7,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#ffc107',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'chainsaw-man': {
      name: 'Chainsaw Man',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0000',
        surface: '#1a0505',
        surface2: '#2a0a0a',
        text: '#ffe4e8',
        muted: '#f8a5a5',
        border: 'rgba(248,165,165,.12)',
        accent: '#b71c1c',
        accentBg: 'rgba(183,28,28,.12)',
        green: '#22c55e',
        red: '#b71c1c',
        gold: '#ffd600',
        blue: '#3b82f6'
      },
      overlay: { type: 'slash-marks' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.1s ease',
      cardEffect: null,
      specialClass: null
    },
    'sailor-moon': {
      name: 'Sailor Moon',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a20',
        surface: '#1a1a4e',
        surface2: '#2a2a6e',
        text: '#f9d7e8',
        muted: '#f48fb1',
        border: 'rgba(244,143,177,.12)',
        accent: '#f48fb1',
        accentBg: 'rgba(244,143,177,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#ffd54f',
        blue: '#60a5fa'
      },
      overlay: { type: 'star-twinkle' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '20px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: null,
      specialClass: null
    },
    'ghost-in-shell': {
      name: 'Ghost in the Shell',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0f1a1a',
        surface: '#1a2a2a',
        surface2: '#2a3a3a',
        text: '#c8e6c9',
        muted: '#81c784',
        border: 'rgba(129,199,132,.12)',
        accent: '#00bfa5',
        accentBg: 'rgba(0,191,165,.12)',
        green: '#00bfa5',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'data-stream' },
      font: { heading: "'Courier New', monospace", body: "'Courier New', monospace" },
      cursor: null,
      borderRadius: '2px',
      borderStyle: 'solid',
      transition: '0.1s ease',
      cardEffect: null,
      specialClass: null
    },
    'spy-x-family': {
      name: 'Spy x Family',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1a0a',
        surface: '#1a2e1a',
        surface2: '#2a4a2a',
        text: '#d4f1d4',
        muted: '#a5d6a7',
        border: 'rgba(165,214,167,.12)',
        accent: '#2e7d32',
        accentBg: 'rgba(46,125,50,.12)',
        green: '#2e7d32',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'vinland-saga': {
      name: 'Vinland Saga',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1520',
        surface: '#1A3057',
        surface2: '#2a5a8c',
        text: '#e0f2ff',
        muted: '#90caf9',
        border: 'rgba(144,202,249,.12)',
        accent: '#bf360c',
        accentBg: 'rgba(191,54,12,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'wood-grain' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'solo-leveling': {
      name: 'Solo Leveling',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0515',
        surface: '#1a0a2e',
        surface2: '#2a1a4a',
        text: '#e0deff',
        muted: '#a5b4fc',
        border: 'rgba(165,180,252,.12)',
        accent: '#448aff',
        accentBg: 'rgba(68,138,255,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#448aff'
      },
      overlay: { type: 'shadow-particles' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'one-punch-man': {
      name: 'One Punch Man',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      mode: 'light',
      colors: {
        bg: '#fafafa',
        surface: '#ffffff',
        surface2: '#f5f5f5',
        text: '#1a1a1a',
        muted: '#5f6671',
        border: 'rgba(0,0,0,.12)',
        accent: '#b8860b',
        accentBg: 'rgba(255,214,0,.22)',
        green: '#2d5016',
        red: '#a4001c',
        gold: '#b8860b',
        blue: '#0052a3'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: 'light-theme'
    },
    'berserk': {
      name: 'Berserk',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0e0a0a',
        surface: '#1a1212',
        surface2: '#2a1818',
        text: '#f5f5f5',
        muted: '#a89696',
        border: 'rgba(255,255,255,.10)',
        accent: '#c41e3a',
        accentBg: 'rgba(196,30,58,.16)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'dark-fog' },
      font: { heading: "'Georgia', serif", body: "'Georgia', serif" },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },
    'jojos-bizarre': {
      name: 'JoJo\'s Bizarre',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0030',
        surface: '#2a0050',
        surface2: '#3a0070',
        text: '#f3e8ff',
        muted: '#e9d5ff',
        border: 'rgba(233,213,255,.12)',
        accent: '#aa00ff',
        accentBg: 'rgba(170,0,255,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#ffd600',
        blue: '#00e5ff'
      },
      overlay: { type: 'dramatic-lines' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },
    'mob-psycho': {
      name: 'Mob Psycho 100',
      category: 'anime',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a20',
        surface: 'linear-gradient(135deg, #1a1a4e 0%, #2a1a6e 100%)',
        surface2: '#3a2a8e',
        text: '#f5f5f5',
        muted: '#cbd5e1',
        border: 'rgba(203,213,225,.12)',
        accent: '#ff4081',
        accentBg: 'rgba(255,64,129,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'aura-waves' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: 'glow',
      specialClass: null
    },

    // CARTOON (25)
    'spongebob': {
      name: 'SpongeBob',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a2040',
        // Surfaces deepened one notch (was #0277bd/#0288d1) so the iconic yellow
        // body text (--t #fff176, emitted raw) clears AA 4.5 on the card surface
        // — 4.14 → 4.91 (PR #557 F-2). Keeps the SpongeBob blue+yellow identity.
        surface: '#026baa',
        surface2: '#0277bd',
        text: '#fff176',
        muted: '#fff59d',
        border: 'rgba(255,241,118,.12)',
        accent: '#fff176',
        accentBg: 'rgba(255,241,118,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'bubbles' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '20px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: null,
      specialClass: null
    },
    'avatar-water': {
      name: 'Avatar - Water',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1a3a',
        surface: '#0d47a1',
        surface2: '#1565c0',
        text: '#e3f2fd',
        muted: '#90caf9',
        border: 'rgba(144,202,249,.12)',
        accent: '#e3f2fd',
        accentBg: 'rgba(227,242,253,.08)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#90caf9'
      },
      overlay: { type: 'water-current' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.25s ease',
      cardEffect: null,
      specialClass: null
    },
    'avatar-fire': {
      name: 'Avatar - Fire',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0505',
        surface: '#b71c1c',
        surface2: '#d32f2f',
        text: '#fde4e4',
        muted: '#f8a5a5',
        border: 'rgba(248,165,165,.12)',
        accent: '#ffd600',
        accentBg: 'rgba(255,214,0,.12)',
        green: '#22c55e',
        red: '#dc2626',
        gold: '#ffd600',
        blue: '#3b82f6'
      },
      overlay: { type: 'ember-particles' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'avatar-earth': {
      name: 'Avatar - Earth',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1508',
        surface: '#33691e',
        surface2: '#558b2f',
        text: '#f1f8e9',
        muted: '#c5e1a5',
        border: 'rgba(197,225,165,.12)',
        accent: '#9ccc65',
        accentBg: 'rgba(156,204,101,.12)',
        green: '#9ccc65',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'earth-crack' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.25s ease',
      cardEffect: null,
      specialClass: null
    },
    'avatar-air': {
      name: 'Avatar - Air',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      mode: 'light',
      colors: {
        bg: '#e1f5fe',
        surface: '#ffffff',
        surface2: '#b3e5fc',
        text: '#01579b',
        muted: '#0277bd',
        border: 'rgba(2,119,189,.18)',
        accent: '#c2670c',
        accentBg: 'rgba(194,103,12,.16)',
        green: '#2d5016',
        red: '#a4001c',
        gold: '#c2670c',
        blue: '#0277bd'
      },
      overlay: { type: 'cloud-drift' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '20px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: null,
      specialClass: 'light-theme'
    },
    'rick-and-morty': {
      name: 'Rick and Morty',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#050808',
        surface: '#0d1117',
        surface2: '#161b22',
        text: '#c9d1d9',
        muted: '#8b949e',
        border: 'rgba(139,148,158,.12)',
        accent: '#76ff03',
        accentBg: 'rgba(118,255,3,.12)',
        green: '#76ff03',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#00bcd4'
      },
      overlay: { type: 'portal-swirl' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'samurai-jack': {
      name: 'Samurai Jack',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#050505',
        surface: '#0f0f0f',
        surface2: '#1a1a1a',
        text: '#f5f5f5',
        muted: '#aaaaaa',
        border: 'rgba(255,255,255,.08)',
        accent: '#c62828',
        accentBg: 'rgba(198,40,40,.12)',
        green: '#22c55e',
        red: '#c62828',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'ink-wash' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '4px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },
    'adventure-time': {
      name: 'Adventure Time',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1a3a',
        surface: '#2a2a5a',
        surface2: '#3a3a7a',
        text: '#f8fafc',
        muted: '#cbd5e1',
        border: 'rgba(203,213,225,.12)',
        accent: '#f8bbd0',
        accentBg: 'rgba(248,187,208,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fff9c4',
        blue: '#b3e5fc'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '20px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: null,
      specialClass: null
    },
    'gravity-falls': {
      name: 'Gravity Falls',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a1008',
        surface: '#3e2723',
        surface2: '#4a3229',
        text: '#f5deb3',
        muted: '#d4a574',
        border: 'rgba(212,165,116,.12)',
        accent: '#2e7d32',
        accentBg: 'rgba(46,125,50,.12)',
        green: '#2e7d32',
        red: '#ef4444',
        gold: '#ffd600',
        blue: '#3b82f6'
      },
      overlay: { type: 'journal-symbols' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'regular-show': {
      name: 'Regular Show',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a2040',
        surface: '#1a3050',
        surface2: '#2a4060',
        text: '#e8f4f8',
        muted: '#90caf9',
        border: 'rgba(144,202,249,.12)',
        accent: '#42a5f5',
        accentBg: 'rgba(66,165,245,.12)',
        green: '#66bb6a',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#42a5f5'
      },
      overlay: { type: 'vhs-lines' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'teen-titans': {
      name: 'Teen Titans',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a2a',
        surface: '#1a237e',
        surface2: '#283593',
        text: '#e8eaff',
        muted: '#a5b4fc',
        border: 'rgba(165,180,252,.12)',
        accent: '#dc2626',
        accentBg: 'rgba(220,38,38,.12)',
        green: '#22c55e',
        red: '#dc2626',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'ben-10': {
      name: 'Ben 10',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#000a00',
        surface: '#001a00',
        surface2: '#002a00',
        text: '#e8f5e9',
        muted: '#a5d6a7',
        border: 'rgba(165,214,167,.12)',
        accent: '#00c853',
        accentBg: 'rgba(0,200,83,.12)',
        green: '#00c853',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'dna-helix' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'invader-zim': {
      name: 'Invader Zim',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0008',
        surface: '#1a0510',
        surface2: '#2a0a20',
        text: '#f3e8ff',
        muted: '#e9d5ff',
        border: 'rgba(233,213,255,.12)',
        accent: '#e91e63',
        accentBg: 'rgba(233,30,99,.12)',
        green: '#76ff03',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },
    'simpsons': {
      name: 'The Simpsons',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a2040',
        surface: '#2a3060',
        surface2: '#3a4080',
        text: '#f5f5f5',
        muted: '#cbd5e1',
        border: 'rgba(203,213,225,.12)',
        accent: '#ffd600',
        accentBg: 'rgba(255,214,0,.12)',
        green: '#22c55e',
        red: '#dc2626',
        gold: '#ffd600',
        blue: '#3b82f6'
      },
      overlay: { type: 'cloud-top' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '16px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'futurama': {
      name: 'Futurama',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#050810',
        surface: '#0a1020',
        surface2: '#151530',
        text: '#e8eaff',
        muted: '#a5b4fc',
        border: 'rgba(165,180,252,.12)',
        accent: '#00897b',
        accentBg: 'rgba(0,137,123,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#ff9800',
        blue: '#00897b'
      },
      overlay: { type: 'star-field' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'south-park': {
      name: 'South Park',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      mode: 'light',
      colors: {
        bg: '#fff8dc',
        surface: '#fef9e6',
        surface2: '#f5edc7',
        text: '#3e2723',
        muted: '#5d4037',
        border: 'rgba(62,39,35,.18)',
        accent: '#d97706',
        accentBg: 'rgba(217,119,6,.16)',
        green: '#15803d',
        red: '#b91c1c',
        gold: '#d97706',
        blue: '#1d4ed8'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '0px',
      borderStyle: 'solid',
      transition: '0.05s steps(2, end)',
      cardEffect: null,
      specialClass: null
    },
    'steven-universe': {
      name: 'Steven Universe',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a20',
        surface: '#1a1a4e',
        surface2: '#2a2a6e',
        text: '#f9d7e8',
        muted: '#f48fb1',
        border: 'rgba(244,143,177,.12)',
        accent: '#f48fb1',
        accentBg: 'rgba(244,143,177,.12)',
        green: '#34d399',
        red: '#ef4444',
        gold: '#ffd54f',
        blue: '#60a5fa'
      },
      overlay: { type: 'star-sparkle' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '16px',
      borderStyle: 'solid',
      transition: '0.25s ease',
      cardEffect: null,
      specialClass: null
    },
    'courage': {
      name: 'Courage the Cowardly Dog',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0520',
        surface: '#4a148c',
        surface2: '#6a1aac',
        text: '#f3e8ff',
        muted: '#ce93d8',
        border: 'rgba(206,147,216,.12)',
        accent: '#ce93d8',
        accentBg: 'rgba(206,147,216,.12)',
        green: '#aed581',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'creepy-fog' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'dexters-lab': {
      name: 'Dexter\'s Laboratory',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0530',
        surface: '#7b1fa2',
        surface2: '#8e24aa',
        text: '#f3e8ff',
        muted: '#e9d5ff',
        border: 'rgba(233,213,255,.12)',
        accent: '#00e676',
        accentBg: 'rgba(0,230,118,.12)',
        green: '#00e676',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#60a5fa'
      },
      overlay: { type: 'none' },
      font: { heading: "'Courier New', monospace", body: "'Courier New', monospace" },
      cursor: null,
      borderRadius: '4px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },
    'powerpuff-girls': {
      name: 'The Powerpuff Girls',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a10',
        surface: '#1a1a22',
        surface2: '#2a2a32',
        text: '#f5f5f5',
        muted: '#aaaaaa',
        border: 'rgba(255,255,255,.08)',
        accent: '#f06292',
        accentBg: 'rgba(240,98,146,.12)',
        green: '#66bb6a',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#42a5f5'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '20px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'scooby-doo': {
      name: 'Scooby-Doo',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0520',
        surface: '#311b92',
        surface2: '#4527a0',
        text: '#f3e8ff',
        muted: '#ce93d8',
        border: 'rgba(206,147,216,.12)',
        accent: '#4caf50',
        accentBg: 'rgba(76,175,80,.12)',
        green: '#4caf50',
        red: '#ef4444',
        gold: '#ff8f00',
        blue: '#60a5fa'
      },
      overlay: { type: 'fog-edge' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'tmnt': {
      name: 'Teenage Mutant Ninja Turtles',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a1a0a',
        surface: '#1a2a1a',
        surface2: '#2a3a2a',
        text: '#d4f1d4',
        muted: '#a5d6a7',
        border: 'rgba(165,214,167,.12)',
        accent: '#2e7d32',
        accentBg: 'rgba(46,125,50,.12)',
        green: '#2e7d32',
        red: '#ef4444',
        gold: '#ff8f00',
        blue: '#3b82f6'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },
    'transformers': {
      name: 'Transformers',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0a1a',
        surface: '#151530',
        surface2: '#201545',
        text: '#e8eaff',
        muted: '#a5b4fc',
        border: 'rgba(165,180,252,.12)',
        accent: '#d32f2f',
        accentBg: 'rgba(211,47,47,.12)',
        green: '#22c55e',
        red: '#d32f2f',
        gold: '#fbbf24',
        blue: '#1565c0'
      },
      overlay: { type: 'none' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'solid',
      transition: '0.1s ease',
      cardEffect: null,
      specialClass: null
    },
    'looney-tunes': {
      name: 'Looney Tunes',
      category: 'cartoon',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#1a0505',
        surface: '#2a1010',
        surface2: '#3a1a1a',
        text: '#fde4e4',
        muted: '#f8a5a5',
        border: 'rgba(248,165,165,.12)',
        accent: '#c62828',
        accentBg: 'rgba(198,40,40,.12)',
        green: '#22c55e',
        red: '#c62828',
        gold: '#ffeb3b',
        blue: '#3b82f6'
      },
      overlay: { type: 'spotlight-vignette' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '16px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: null,
      specialClass: null
    },
    'dragon-ball-super': {
      name: 'Dragon Ball Super',
      category: 'cartoon',
      locked: true,
      unlockCondition: 'Complete Dragon Ball Z theme customization',
      colors: {
        bg: '#0a0a0f',
        surface: '#15152a',
        surface2: '#20203a',
        text: '#f0f0ff',
        muted: '#d0d0ff',
        border: 'rgba(208,208,255,.12)',
        accent: '#2962ff',
        accentBg: 'rgba(41,98,255,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#e0e0e0',
        blue: '#2962ff'
      },
      overlay: { type: 'silver-cascade' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: 'glow',
      specialClass: null
    },

    // ADDITIONAL ACHIEVEMENT THEMES
    'gold-rush': {
      name: 'Gold Rush',
      category: 'achievement',
      locked: true,
      unlockCondition: 'Close 10 deals',
      colors: {
        bg: '#1a1508',
        surface: '#2a2010',
        surface2: '#3a3018',
        text: '#fffbf0',
        muted: '#f4d5a3',
        border: 'rgba(244,213,163,.12)',
        accent: '#fbbf24',
        accentBg: 'rgba(251,191,36,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'gold-particles' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: 'glow',
      specialClass: null
    },
    'eternal-flame': {
      name: 'Eternal Flame',
      category: 'achievement',
      locked: true,
      unlockCondition: 'Maintain 30-day login streak',
      colors: {
        bg: '#1a0505',
        surface: '#2a0a0a',
        surface2: '#3a1515',
        text: '#fde4e4',
        muted: '#f8a5a5',
        border: 'rgba(248,165,165,.12)',
        accent: '#ef4444',
        accentBg: 'rgba(239,68,68,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      // 'flame-burst' was never registered in ThemeOverlays' overlayLibrary —
      // silently rendered nothing. Repointed at the existing, working
      // ember-particles effect at higher density until a real flame-burst
      // effect gets built.
      overlay: { type: 'ember-particles', density: 0.9, speed: 1.2 },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.2s ease',
      cardEffect: 'glow',
      specialClass: null
    },
    'iron-door': {
      name: 'Iron Door',
      category: 'achievement',
      locked: true,
      unlockCondition: 'Knock 500 doors',
      colors: {
        bg: '#1a1a1a',
        surface: '#2a2a2a',
        surface2: '#3a3a3a',
        text: '#e2e8f0',
        muted: '#9ca3af',
        border: 'rgba(255,255,255,.08)',
        accent: '#6b7280',
        accentBg: 'rgba(107,114,128,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'metal-shine' },
      font: { heading: "'Courier New', monospace", body: "'Courier New', monospace" },
      cursor: null,
      borderRadius: '4px',
      borderStyle: 'double',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'completionist': {
      name: 'Completionist',
      category: 'achievement',
      locked: true,
      unlockCondition: 'Use every feature in NBD Pro',
      colors: {
        bg: '#050510',
        surface: '#0a0a2e',
        surface2: '#15152f',
        text: '#f0f0ff',
        muted: '#d0d0ff',
        border: 'rgba(208,208,255,.12)',
        accent: '#ff00ff',
        accentBg: 'rgba(255,0,255,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fcd34d',
        blue: '#60a5fa'
      },
      overlay: { type: 'rainbow-shimmer' },
      font: { heading: null, body: null },
      cursor: 'url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgZmlsbD0iIzZmNDdlNiIgLz48L3N2Zz4=) 12 12, auto',
      borderRadius: '12px',
      borderStyle: 'solid',
      transition: '0.15s ease',
      cardEffect: 'glow',
      specialClass: null
    },
    'night-owl': {
      name: 'Night Owl',
      category: 'achievement',
      locked: true,
      unlockCondition: 'Login after midnight 10 times',
      colors: {
        bg: '#050505',
        surface: '#0a0a0a',
        surface2: '#151515',
        text: '#f0f0f0',
        muted: '#808080',
        border: 'rgba(255,255,255,.08)',
        accent: '#7dd3fc',
        accentBg: 'rgba(125,211,252,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fbbf24',
        blue: '#7dd3fc'
      },
      overlay: { type: 'moon-glow' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '20px',
      borderStyle: 'solid',
      transition: '0.3s ease',
      cardEffect: 'glow',
      specialClass: null
    },
    'road-warrior': {
      name: 'Road Warrior',
      category: 'achievement',
      locked: true,
      unlockCondition: 'Complete 100 on-site inspections',
      colors: {
        bg: '#1a1a15',
        surface: '#2a2a22',
        surface2: '#3a3a32',
        text: '#f5f5f0',
        muted: '#c0c0c0',
        border: 'rgba(192,192,192,.12)',
        accent: '#fbbf24',
        accentBg: 'rgba(251,191,36,.12)',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#fbbf24',
        blue: '#3b82f6'
      },
      overlay: { type: 'road-line' },
      font: { heading: null, body: null },
      cursor: null,
      borderRadius: '8px',
      borderStyle: 'dashed',
      transition: '0.2s ease',
      cardEffect: null,
      specialClass: null
    },
    'legend': {
      name: 'Legend',
      category: 'achievement',
      locked: true,
      unlockCondition: 'Achieve all other achievements',
      colors: {
        bg: '#050505',
        surface: '#0f0f15',
        surface2: '#1a1a2a',
        text: '#f0f0ff',
        muted: '#d0d0ff',
        border: 'rgba(208,208,255,.12)',
        accent: '#a78bfa',
        accentBg: 'rgba(167,139,250,.12)',
        green: '#34d399',
        red: '#f87171',
        gold: '#fcd34d',
        blue: '#60a5fa'
      },
      overlay: { type: 'mythic-aura' },
      font: { heading: "'Georgia', serif", body: "'Georgia', serif" },
      cursor: null,
      borderRadius: '12px',
      borderStyle: 'double',
      transition: '0.25s ease',
      cardEffect: 'glow',
      specialClass: 'legend-theme'
    },

    // ════════════════════════════════════════════════════════════════════
    // CSS-ORPHAN PORT (33 themes) — 2026-05-19
    // Palettes lifted verbatim from theme-system.css [data-theme="X"] rules
    // so users with stale `nbd-theme` localStorage IDs (e.g. "halloween"
    // from the legacy era) honor the light/dark mode pref like every other
    // theme, instead of falling into the CSS-only branch in apply().
    // Only `presentation` remains CSS-only — it's a customer.html overlay,
    // not a picker theme.
    // ════════════════════════════════════════════════════════════════════
    'android': {
      name: 'Android',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0f0a', surface: '#141c14', surface2: '#1c2a1c',
        text: '#e8f5e8', muted: '#78a878', border: 'rgba(76,175,80,.1)',
        accent: '#4caf50', accentBg: 'rgba(76,175,80,.3)',
        green: '#66bb6a', red: '#f44336', gold: '#ffd600', blue: '#4caf50'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'army': {
      name: 'Army',
      category: 'construction',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#060a02', surface: '#0e1808', surface2: '#182610',
        text: '#e0f0c8', muted: '#789858', border: 'rgba(106,140,42,.1)',
        accent: '#6a8c2a', accentBg: 'rgba(106,140,42,.28)',
        green: '#8bc34a', red: '#c0392b', gold: '#c8a820', blue: '#6a8c2a'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'blood-moon': {
      name: 'Blood Moon',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#080002', surface: '#140006', surface2: '#200008',
        text: '#ffe8ec', muted: '#c06070', border: 'rgba(232,0,26,.12)',
        accent: '#e8001a', accentBg: 'rgba(232,0,26,.38)',
        green: '#4caf50', red: '#e8001a', gold: '#ffd600', blue: '#e8001a'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'blueprint-art': {
      name: 'Blueprint Art',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#001428', surface: '#001e3c', surface2: '#002a52',
        text: '#c8e0ff', muted: '#6088a8', border: 'rgba(255,255,255,.1)',
        accent: '#ffffff', accentBg: 'rgba(255,255,255,.2)',
        green: '#4db6ac', red: '#ef9a9a', gold: '#fff176', blue: '#4fc3f7'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'candlelit': {
      name: 'Candlelit',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0c0600', surface: '#180e00', surface2: '#241600',
        text: '#fff4d8', muted: '#a07848', border: 'rgba(232,130,10,.14)',
        accent: '#e8820a', accentBg: 'rgba(232,130,10,.45)',
        green: '#8bc34a', red: '#e53935', gold: '#e8820a', blue: '#e8820a'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'christmas': {
      name: 'Christmas',
      category: 'seasonal',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#000e04', surface: '#001808', surface2: '#00220c',
        text: '#f5fff8', muted: '#80b890', border: 'rgba(229,57,53,.1)',
        accent: '#e53935', accentBg: 'rgba(229,57,53,.25)',
        green: '#4caf50', red: '#e53935', gold: '#ffd600', blue: '#2196f3'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'cia': {
      name: 'CIA',
      category: 'construction',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#020202', surface: '#0c0c0c', surface2: '#161616',
        text: '#f0f0e0', muted: '#888870', border: 'rgba(200,160,0,.08)',
        accent: '#c8a000', accentBg: 'rgba(200,160,0,.22)',
        green: '#4a7a4a', red: '#c02020', gold: '#c8a000', blue: '#c8a000'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'copper': {
      name: 'Copper',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0c0800', surface: '#1a1200', surface2: '#281e00',
        text: '#f8ecd8', muted: '#a08058', border: 'rgba(184,115,51,.1)',
        accent: '#b87333', accentBg: 'rgba(184,115,51,.28)',
        green: '#8bc34a', red: '#c0392b', gold: '#b87333', blue: '#b87333'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'deep-focus': {
      name: 'Deep Focus',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#020404', surface: '#060c0c', surface2: '#0c1414',
        text: '#e0f8f4', muted: '#4a9088', border: 'rgba(13,148,136,.1)',
        accent: '#0d9488', accentBg: 'rgba(13,148,136,.28)',
        green: '#14b8a6', red: '#ef4444', gold: '#fbbf24', blue: '#0d9488'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'easter': {
      name: 'Easter',
      category: 'seasonal',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#f0e8f8', surface: '#ffe8f8', surface2: '#f8d8f0',
        text: '#2a0838', muted: '#806888', border: 'rgba(156,39,176,.08)',
        accent: '#9c27b0', accentBg: 'rgba(156,39,176,.2)',
        green: '#4caf50', red: '#e91e63', gold: '#ffd600', blue: '#2196f3'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'ember': {
      name: 'Ember',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0300', surface: '#160800', surface2: '#220e00',
        text: '#ffe8d8', muted: '#b06040', border: 'rgba(255,69,0,.12)',
        accent: '#ff4500', accentBg: 'rgba(255,69,0,.42)',
        green: '#8bc34a', red: '#ff4500', gold: '#ff9800', blue: '#ff4500'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'frosted': {
      name: 'Frosted',
      category: 'luxury',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#e8eaf2', surface: '#f0f2fa', surface2: '#e0e4f0',
        text: '#1a1e3c', muted: '#6068a0', border: 'rgba(80,100,200,.08)',
        accent: '#5064c8', accentBg: 'rgba(80,100,200,.18)',
        green: '#388e3c', red: '#d32f2f', gold: '#f9a825', blue: '#5064c8'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'halloween': {
      name: 'Halloween',
      category: 'seasonal',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#080200', surface: '#100400', surface2: '#180800',
        text: '#fff0d8', muted: '#907850', border: 'rgba(255,109,0,.1)',
        accent: '#ff6d00', accentBg: 'rgba(255,109,0,.3)',
        green: '#6a8c2a', red: '#ff3d00', gold: '#ff6d00', blue: '#ff6d00'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'ink': {
      name: 'Ink',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#f5f0e8', surface: '#ece6d8', surface2: '#e2dac8',
        text: '#0f0a04', muted: '#605840', border: 'rgba(0,0,0,.08)',
        accent: '#0f0a04', accentBg: 'rgba(15,10,4,.12)',
        green: '#1a4a1a', red: '#7a1a1a', gold: '#907020', blue: '#1a2060'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'ios': {
      name: 'iOS',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#000000', surface: '#1c1c1e', surface2: '#2c2c2e',
        text: '#ffffff', muted: '#aeaeb2', border: 'rgba(255,255,255,.1)',
        accent: '#0a84ff', accentBg: 'rgba(10,132,255,.32)',
        green: '#30d158', red: '#ff453a', gold: '#ffd60a', blue: '#0a84ff'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'ios26': {
      name: 'iOS 26',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#050508', surface: '#0e0e14', surface2: '#181820',
        text: '#f5f5f7', muted: '#8e8e93', border: 'rgba(255,255,255,.08)',
        accent: '#30d158', accentBg: 'rgba(48,209,88,.28)',
        green: '#30d158', red: '#ff453a', gold: '#ffd60a', blue: '#0a84ff'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'japan': {
      name: 'Japan',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0a0608', surface: '#180e12', surface2: '#26161e',
        text: '#fff8f8', muted: '#b88898', border: 'rgba(196,28,36,.1)',
        accent: '#c41c24', accentBg: 'rgba(196,28,36,.28)',
        green: '#4caf50', red: '#c41c24', gold: '#ffd600', blue: '#c41c24'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'liquid': {
      name: 'Liquid',
      category: 'luxury',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#080c12', surface: '#101820', surface2: '#18242e',
        text: '#e8f4ff', muted: '#7098b8', border: 'rgba(120,200,232,.1)',
        accent: '#78c8e8', accentBg: 'rgba(120,200,232,.3)',
        green: '#4db6ac', red: '#ef9a9a', gold: '#fff176', blue: '#78c8e8'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'lofi': {
      name: 'Lo-Fi Beige',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#f2ede4', surface: '#ebe4d8', surface2: '#e0d8c8',
        text: '#2c2418', muted: '#786858', border: 'rgba(0,0,0,.08)',
        accent: '#c8a878', accentBg: 'rgba(200,168,120,.2)',
        green: '#6a9a6a', red: '#b06060', gold: '#c8a878', blue: '#8c7a6b'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'metal': {
      name: 'Heavy Metal',
      category: 'luxury',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#0e0e10', surface: '#1a1a1e', surface2: '#242428',
        text: '#f0f0f4', muted: '#808090', border: 'rgba(255,255,255,.08)',
        accent: '#c8ccd8', accentBg: 'rgba(200,204,216,.22)',
        green: '#a5d6a7', red: '#ef9a9a', gold: '#fff176', blue: '#90caf9'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'midnight-oil': {
      name: 'Midnight Oil',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#060402', surface: '#100c06', surface2: '#1a140c',
        text: '#f0e8d0', muted: '#988060', border: 'rgba(212,144,10,.1)',
        accent: '#d4900a', accentBg: 'rgba(212,144,10,.28)',
        green: '#8bc34a', red: '#c0392b', gold: '#d4900a', blue: '#d4900a'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'neon-rain': {
      name: 'Neon Rain',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#06000e', surface: '#0e0018', surface2: '#180028',
        text: '#ffe8f8', muted: '#c060a8', border: 'rgba(255,45,155,.12)',
        accent: '#ff2d9b', accentBg: 'rgba(255,45,155,.44)',
        green: '#00e676', red: '#ff1744', gold: '#ffff00', blue: '#00e5ff'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'ninja': {
      name: 'Ninja',
      category: 'construction',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#040400', surface: '#0c0c00', surface2: '#141400',
        text: '#e8e8d0', muted: '#787858', border: 'rgba(204,0,0,.1)',
        accent: '#cc0000', accentBg: 'rgba(204,0,0,.3)',
        green: '#6a8a2a', red: '#cc0000', gold: '#c8a000', blue: '#cc0000'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'obsidian-v5': {
      name: 'Obsidian Purple',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#06040a', surface: '#0e0c14', surface2: '#181620',
        text: '#f0eeff', muted: '#8880c0', border: 'rgba(139,92,246,.1)',
        accent: '#8b5cf6', accentBg: 'rgba(139,92,246,.32)',
        green: '#4db6ac', red: '#f87171', gold: '#fbbf24', blue: '#8b5cf6'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'sakura': {
      name: 'Sakura',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#fff0f4', surface: '#ffe8f0', surface2: '#ffd8e8',
        text: '#2a0818', muted: '#a04868', border: 'rgba(232,52,108,.08)',
        accent: '#e8346c', accentBg: 'rgba(232,52,108,.2)',
        green: '#4caf50', red: '#e8346c', gold: '#ffd600', blue: '#e91e63'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'samurai': {
      name: 'Samurai',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#080208', surface: '#120810', surface2: '#1e1018',
        text: '#f8f0e8', muted: '#987058', border: 'rgba(204,34,0,.1)',
        accent: '#cc2200', accentBg: 'rgba(204,34,0,.32)',
        green: '#4caf50', red: '#cc2200', gold: '#ffd600', blue: '#cc2200'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'terminal': {
      name: 'Terminal',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        // muted bumped from #005500 → #00aa00 so muted-on-bg clears AA 3:1
        // (CSS-only original failed contrast; we don't re-introduce it here).
        bg: '#000000', surface: '#0a0a0a', surface2: '#111111',
        text: '#00ff00', muted: '#00aa00', border: 'rgba(0,255,0,.08)',
        accent: '#00ff00', accentBg: 'rgba(0,255,0,.3)',
        green: '#00ff00', red: '#ff4444', gold: '#ffff00', blue: '#00ff00'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'translucent': {
      name: 'Translucent',
      category: 'luxury',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#030408', surface: '#080c14', surface2: '#0e1420',
        text: '#f8f9ff', muted: '#8890b8', border: 'rgba(255,255,255,.06)',
        accent: '#e8eeff', accentBg: 'rgba(232,238,255,.18)',
        green: '#a5d6a7', red: '#ef9a9a', gold: '#fff176', blue: '#e8eeff'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'typewriter': {
      name: 'Typewriter',
      category: 'mood',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#f0e8d4', surface: '#e8dfc8', surface2: '#ded4b8',
        text: '#1a1208', muted: '#706040', border: 'rgba(0,0,0,.08)',
        accent: '#1a1208', accentBg: 'rgba(26,18,8,.12)',
        green: '#2a5a2a', red: '#8a2a2a', gold: '#a08020', blue: '#1a3060'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'underwater': {
      name: 'Underwater',
      category: 'nature',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#000c14', surface: '#001828', surface2: '#00223a',
        text: '#d8fff8', muted: '#4898a0', border: 'rgba(0,229,204,.1)',
        accent: '#00e5cc', accentBg: 'rgba(0,229,204,.34)',
        green: '#69f0ae', red: '#ef9a9a', gold: '#fff176', blue: '#00e5cc'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'volcanic': {
      name: 'Volcanic',
      category: 'nature',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#120000', surface: '#220000', surface2: '#340000',
        text: '#ffe8e0', muted: '#c06858', border: 'rgba(255,61,0,.12)',
        accent: '#ff3d00', accentBg: 'rgba(255,61,0,.38)',
        green: '#ffab40', red: '#ff3d00', gold: '#ff9800', blue: '#ff3d00'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'wildwest': {
      name: 'Wild West',
      category: 'popculture',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#120a00', surface: '#201400', surface2: '#302000',
        text: '#fff4e0', muted: '#a08860', border: 'rgba(200,120,64,.1)',
        accent: '#c87840', accentBg: 'rgba(200,120,64,.26)',
        green: '#8bc34a', red: '#c0392b', gold: '#c87840', blue: '#c87840'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    },
    'windows': {
      name: 'Windows',
      category: 'scifi',
      locked: false,
      unlockCondition: null,
      colors: {
        bg: '#001828', surface: '#002040', surface2: '#002c56',
        text: '#e8f4ff', muted: '#6898c8', border: 'rgba(0,120,212,.1)',
        accent: '#0078d4', accentBg: 'rgba(0,120,212,.32)',
        green: '#107c10', red: '#d13438', gold: '#ffb900', blue: '#0078d4'
      },
      overlay: { type: 'none' }, font: { heading: null, body: null },
      cursor: null, borderRadius: '12px', borderStyle: 'solid',
      transition: '0.2s ease', cardEffect: null, specialClass: null
    }
  };

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  function ensureStyleElement() {
    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.id = 'te-vars';
      styleElement.type = 'text/css';
      document.head.appendChild(styleElement);
    }
    return styleElement;
  }

  // Parse #rrggbb / #rgb to {r,g,b}; returns null on invalid input.
  function parseHex(hex) {
    if (!hex || typeof hex !== 'string') return null;
    const m = hex.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  // Relative luminance per WCAG. Returns 0..1.
  function luminance(hex) {
    const c = parseHex(hex);
    if (!c) return 0;
    const norm = v => {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * norm(c.r) + 0.7152 * norm(c.g) + 0.0722 * norm(c.b);
  }

  // The mode the theme's `colors` palette was authored for.
  // Themes can opt-in explicitly via theme.mode; otherwise inferred from bg luminance.
  function getNativeMode(theme) {
    if (theme.mode === 'light' || theme.mode === 'dark') return theme.mode;
    if (theme.specialClass === 'light-theme') return 'light';
    return luminance(theme.colors.bg) > 0.55 ? 'light' : 'dark';
  }

  // Backward-compat alias — older callers (picker swatches, etc.) used getMode
  // to mean "what mode is this theme." That's now native mode.
  function getMode(theme) { return getNativeMode(theme); }

  // User mode preference: 'light' | 'dark' | 'auto'. Default 'auto' = follow OS.
  function getStoredModePref() {
    try {
      const v = localStorage.getItem(MODE_STORAGE_KEY);
      if (v === 'light' || v === 'dark' || v === 'auto') return v;
    } catch (_) {}
    return 'auto';
  }

  function setStoredModePref(pref) {
    try { localStorage.setItem(MODE_STORAGE_KEY, pref); } catch (_) {}
  }

  function getOSMode() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    } catch (_) {}
    return 'dark';
  }

  // The mode we should actually render right now.
  // pref === 'light' | 'dark' → that. pref === 'auto' → follow OS.
  function getResolvedModeFromPref() {
    const pref = getStoredModePref();
    if (pref === 'light' || pref === 'dark') return pref;
    return getOSMode();
  }

  // Lighten or darken a hex color by amount (0..1). Positive = lighter.
  function adjustHex(hex, amount) {
    const c = parseHex(hex);
    if (!c) return hex;
    const adj = v => Math.max(0, Math.min(255, Math.round(
      amount >= 0 ? v + (255 - v) * amount : v * (1 + amount)
    )));
    const toHex = n => n.toString(16).padStart(2, '0');
    return '#' + toHex(adj(c.r)) + toHex(adj(c.g)) + toHex(adj(c.b));
  }

  // Convert hex to rgba string with given alpha.
  function hexToRgba(hex, alpha) {
    const c = parseHex(hex);
    if (!c) return `rgba(0,0,0,${alpha})`;
    return `rgba(${c.r},${c.g},${c.b},${alpha})`;
  }

  // Linear-blend two hex colors. t=0 → a, t=1 → b. Returns hex.
  function blendHex(a, b, t) {
    const ca = parseHex(a);
    const cb = parseHex(b);
    if (!ca || !cb) return a;
    const lerp = (x, y) => Math.max(0, Math.min(255, Math.round(x + (y - x) * t)));
    const toHex = n => n.toString(16).padStart(2, '0');
    return '#' + toHex(lerp(ca.r, cb.r)) + toHex(lerp(ca.g, cb.g)) + toHex(lerp(ca.b, cb.b));
  }

  // Contrast ratio per WCAG. Returns >= 1.
  function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // Walk the accent away from bg until it clears the target ratio.
  // Used so derived palettes never produce invisible accent buttons.
  function tuneAgainst(fg, bg, target) {
    let cur = fg;
    const bgIsLight = luminance(bg) > 0.5;
    for (let i = 0; i < 8; i++) {
      if (contrastRatio(cur, bg) >= target) return cur;
      cur = adjustHex(cur, bgIsLight ? -0.14 : 0.16);
    }
    return cur;
  }

  // Two-sided tuning for foreground/background pairs that need a strict
  // contrast ratio (e.g. card ink on card paper). Tries tuning fg first;
  // if that can't reach the target (fg is already at the limit toward
  // black/white), tunes bg in the opposite direction instead. Some hand-
  // authored palettes pick a paper that's mid-luminance enough that no
  // light text can clear 4.5 against it — SpongeBob's iconic yellow on
  // blue, Avatar Earth's cream on olive — and only paper-tuning helps.
  function pickContrastingPair(fg, bg, target) {
    const tunedFg = tuneAgainst(fg, bg, target);
    if (contrastRatio(tunedFg, bg) >= target) return { fg: tunedFg, bg: bg };
    const tunedBg = tuneAgainst(bg, fg, target);
    return { fg: fg, bg: tunedBg };
  }

  // Algorithmic LIGHT palette derived from the theme's accent color.
  // Preserves theme identity via hue-tinted backgrounds. Semantic colors
  // fall back to readable defaults so green/red/etc. work on light bg.
  function deriveLightPalette(colors) {
    const accent = colors.accent;
    const bg = blendHex(accent, '#ffffff', 0.96);
    const surface = blendHex(accent, '#ffffff', 0.92);
    const surface2 = blendHex(accent, '#ffffff', 0.86);
    const text = '#0f172a';
    const muted = '#64748b';
    const border = 'rgba(15,23,42,0.10)';
    const tunedAccent = tuneAgainst(accent, bg, 3.0);
    return {
      bg,
      surface,
      surface2,
      text,
      muted,
      border,
      accent: tunedAccent,
      accentBg: hexToRgba(tunedAccent, 0.10),
      green: '#16a34a',
      red: '#dc2626',
      gold: '#ca8a04',
      blue: '#2563eb'
    };
  }

  // Algorithmic DARK palette derived from the theme's accent color.
  function deriveDarkPalette(colors) {
    const accent = colors.accent;
    const bg = blendHex(accent, '#000000', 0.88);
    const surface = blendHex(accent, '#000000', 0.80);
    const surface2 = blendHex(accent, '#000000', 0.70);
    const text = '#e2e8f0';
    const muted = '#94a3b8';
    const border = 'rgba(226,232,240,0.12)';
    const tunedAccent = tuneAgainst(accent, bg, 3.0);
    return {
      bg,
      surface,
      surface2,
      text,
      muted,
      border,
      accent: tunedAccent,
      accentBg: hexToRgba(tunedAccent, 0.16),
      green: '#34d399',
      red: '#f87171',
      gold: '#fbbf24',
      blue: '#60a5fa'
    };
  }

  // Pick the palette for the requested mode. Order:
  //   1. Explicit theme.colorsLight / colorsDark (full or partial override)
  //   2. theme.colors when its native mode matches the requested mode
  //   3. Derived palette (algorithmic) when we need the opposite mode
  // Partial overrides win key-by-key over the base they merge into.
  function resolvePalette(theme, mode) {
    const native = getNativeMode(theme);
    const override = mode === 'light' ? theme.colorsLight : theme.colorsDark;

    if (mode === native) {
      return override ? Object.assign({}, theme.colors, override) : theme.colors;
    }

    const derived = mode === 'light'
      ? deriveLightPalette(theme.colors)
      : deriveDarkPalette(theme.colors);
    return override ? Object.assign({}, derived, override) : derived;
  }

  // Swatch-friendly view of resolvePalette: returns just the four colors a
  // picker card needs (bg/surface/accent/text) for the user's current mode.
  // Returns null if the themeKey isn't registered.
  function previewResolvedColors(themeKey) {
    const theme = THEMES[themeKey];
    if (!theme) return null;
    const mode = getResolvedModeFromPref();
    const colors = resolvePalette(theme, mode);
    return {
      bg: colors.bg,
      surface: colors.surface,
      accent: colors.accent,
      text: colors.text
    };
  }

  function generateCSSVariables(theme, themeKey) {
    // Resolve the actual mode we should render in (user pref or OS), then
    // pick the matching palette — explicit override, native, or derived.
    const mode = getResolvedModeFromPref();
    const colors = resolvePalette(theme, mode);

    const {
      bg, surface, surface2, text, muted, border, accent, accentBg,
      green, red, gold, blue
    } = colors;

    const isLight = mode === 'light';

    // Derived vars so kanban + tags + tag chips have proper foundations.
    // --bg: outermost page background — slightly darker than --s for dark themes,
    //       slightly lighter than --s for light themes (so layered surfaces step).
    const bgDerived = colors.outerBg
      || (isLight ? adjustHex(bg, 0.02) : adjustHex(bg, -0.18));

    // --rule: subtle divider line — derived from text color at low alpha
    const rule = colors.rule || hexToRgba(text, isLight ? 0.08 : 0.09);

    // --paper / --ink: card surface + card text. These DRIVE kanban cards.
    // Light themes: paper = surface, ink = text (dark on light card).
    // Dark themes: paper = surface2 (a step up), ink = text (light on dark card).
    const paperBase = colors.paper || (isLight ? surface : surface2);

    // Post-tune the accent against the FINAL rendered --bg (bgDerived). The
    // derived bg gets nudged a notch by adjustHex above, which can shave the
    // accent's contrast below AA UI (3:1) — South Park hit 2.99 pre-tune.
    const accentFinal = tuneAgainst(accent, bgDerived, 3.0);

    // Tune the card ink/paper pair to clear 4.5:1 (AA normal). Tries ink
    // first; falls back to tuning paper when ink is already at its limit
    // (e.g. SpongeBob's iconic yellow on blue).
    const inkPaper = pickContrastingPair(colors.ink || text, paperBase, 4.5);
    const ink = inkPaper.fg;
    const paper = inkPaper.bg;

    // --ob: accent hover state (slightly brighter), derived AFTER tuning so
    // the hover hue tracks the tuned accent, not the raw one.
    const ob = colors.accentHover || adjustHex(accentFinal, isLight ? -0.12 : 0.15);

    // --accent-fg: the text/icon color painted ON TOP of an --orange (accent)
    // fill — the quick-add "ADD" button, kanban active-filter tab, primary
    // CTAs (background:var(--orange); color:var(--accent-fg)). White by
    // default, but it MUST flip to a dark ink when the final accent is too
    // light/desaturated to carry white text, or pale accents render
    // white-on-white (theme sweep 2026-06-07 B-1/P-2: stadium-lights #f8fafc,
    // snowfall, avatar-water, marble, tundra, spongebob's pale yellow, …).
    // theme-system.css carries a static per-theme flip-list, but it only
    // covers some themes and can't track the per-MODE accent (a theme's
    // derived light/dark accent differs from its authored one). Emitting it
    // HERE — in the high-specificity per-theme te-vars block, alongside
    // --orange — makes the engine own the token: always present, mode-correct
    // (computed from accentFinal), and it wins the cascade over the static
    // list. Gate strictly on MEASURED contrast against the FINAL accent so a
    // dark-accent mode keeps white text and never under-contrasts.
    const accentFg = (contrastRatio('#ffffff', accentFinal) < 3 || luminance(accentFinal) > 0.7)
      ? '#0a0a0a'
      : '#ffffff';

    // --purple: semantic purple — used by tag-ng and stage chips.
    const purple = colors.purple || (isLight ? '#7c3aed' : '#a78bfa');

    // --m: muted/secondary text. This is the ONE token hand-authored palettes
    // routinely leave below AA — it's deliberately low-contrast, and unlike
    // ink/paper it was emitted raw. Audit (2026-06) found 36/186 themes' muted
    // failed AA. Muted reads predominantly on cards/panels (--s2 = surface), so
    // tune it against THAT surface — keeping its hue, only lifting lightness
    // until it clears AA normal (4.5:1). Tuning against the page bg instead
    // would break mixed-luminance themes whose card and bg differ sharply
    // (brutalist, spongebob, avatar-*) where no single muted satisfies both.
    // tuneAgainst returns immediately for themes already passing, so legible
    // themes are untouched. Mirrors the ink/paper treatment above.
    const mutedFinal = tuneAgainst(muted, surface || surface2 || bg, 4.5);

    const fontHeading = theme.font.heading ? `'${theme.font.heading}'` : "'Barlow Condensed', sans-serif";
    const fontBody = theme.font.body ? `'${theme.font.body}'` : "'Inter', sans-serif";

    // High-specificity selector so we beat the generic [data-theme="X"] rules
    // in theme-system.css. We target the active theme key explicitly.
    const sel = themeKey
      ? `:root[data-theme="${themeKey}"]`
      : ':root';

    let css = `${sel} {
  --bg: ${bgDerived};
  --s: ${bg};
  --s2: ${surface};
  --s3: ${surface2};
  --t: ${text};
  --m: ${mutedFinal};
  --br: ${border};
  --rule: ${rule};
  --orange: ${accentFinal};
  --ob: ${ob};
  --og: ${accentBg};
  --accent-fg: ${accentFg};
  --green: ${green};
  --red: ${red};
  --gold: ${gold};
  --blue: ${blue};
  --purple: ${purple};
  --paper: ${paper};
  --ink: ${ink};
  --te-radius: ${theme.borderRadius};
  --te-border: ${theme.borderStyle};
  --te-transition: ${theme.transition};
  --te-font-heading: ${fontHeading};
  --te-font-body: ${fontBody};
}`;

    return css;
  }

  function loadGoogleFont(fontName) {
    if (!fontName || FONT_CACHE.has(fontName)) return;

    const link = document.createElement('link');
    link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/\s+/g, '+')}&display=swap`;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
    FONT_CACHE.add(fontName);
  }

  function dispatchThemeChange(themeKey) {
    const event = new CustomEvent('themechange', {
      detail: themeKey,
      bubbles: true,
      cancelable: false
    });
    document.dispatchEvent(event);
  }

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  const ThemeEngine = {
    init() {
      // Hydrate unlocks from localStorage so a user who unlocked themes on
      // a previous session sees them immediately (Firestore hydration runs
      // async when auth resolves; localStorage covers the gap).
      this.hydrateUnlocks();
      // Key convergence (audit F-1): STORAGE_KEY (nbd_pro_theme) is canonical.
      // One-time migrate users who only carry the legacy maps.js/daily-success
      // key (nbd-theme): adopt it and write it through to the canonical key.
      // The legacy 'default' id maps to this engine's 'nbd-original'.
      let saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) {
        const legacy = localStorage.getItem(LEGACY_KEY);
        if (legacy) {
          saved = (legacy === 'default') ? 'nbd-original' : legacy;
          try { localStorage.setItem(STORAGE_KEY, saved); } catch (_) {}
        }
      }
      if (!saved) saved = DEFAULT_THEME;
      this.apply(saved, false);

      // Audit batch 1 (2026-05-13): once Firebase auth + Firestore are
      // ready, pull the rep's saved theme from userSettings/{uid} and
      // apply it if it differs from what localStorage had. This is what
      // makes the theme follow the rep across devices — first paint
      // uses localStorage (instant), then we self-heal to the server
      // copy if the rep changed it elsewhere. Polls briefly because the
      // page may boot before window._user / window.db are populated.
      const tryHydrateFromFirestore = () => {
        try {
          const uid = (window._user && window._user.uid) || null;
          if (!uid || !window.db || !window.getDoc || !window.doc) return false;
          // QA 2026-06-21 #1: retry the transient cold-boot "client is offline"
          // (WebChannel not yet up) so the saved theme actually hydrates instead
          // of silently staying on the default until a reload. Falls back to a
          // direct call if the retry helper hasn't loaded yet.
          (window.nbdRetryOffline || (f => f()))(() => window.getDoc(window.doc(window.db, 'userSettings', uid)))
            .then(snap => {
              if (!snap.exists()) return;
              const remoteTheme = snap.data() && snap.data().theme;
              if (remoteTheme && remoteTheme !== currentTheme && THEMES[remoteTheme]) {
                this.apply(remoteTheme, false); // don't re-save; came from server
              }
            })
            .catch(err => console.warn('[theme-engine] Firestore hydrate failed:', err.message));
          return true;
        } catch (_) { return false; }
      };
      // Try a few times — auth typically resolves within 1-2s of page load.
      let tries = 0;
      const poll = () => {
        if (tryHydrateFromFirestore()) return;
        if (++tries > 10) return; // give up after ~5s
        setTimeout(poll, 500);
      };
      setTimeout(poll, 250);
    },

    apply(themeKey, save = true) {
      const theme = THEMES[themeKey];
      if (!theme) {
        // CSS-only theme (defined in theme-system.css but not registered here).
        // Set data-theme so the CSS selector matches, and clear our injected
        // style so the engine doesn't override the CSS file's vars.
        const html = document.documentElement;
        html.setAttribute('data-theme', themeKey);
        const styleEl = ensureStyleElement();
        styleEl.innerHTML = '';
        // Best-effort mode hint from the CSS-loaded --bg luminance.
        try {
          const bg = getComputedStyle(html).getPropertyValue('--bg').trim();
          const lum = luminance(bg);
          html.setAttribute('data-mode', lum > 0.55 ? 'light' : 'dark');
          if (lum > 0.55) html.setAttribute('data-light', 'true');
          else html.removeAttribute('data-light');
        } catch (e) {}
        if (save) {
          localStorage.setItem(STORAGE_KEY, themeKey);
          try { localStorage.setItem(LEGACY_KEY, themeKey); } catch (_) {} // write-through (F-1)
        }
        currentTheme = themeKey;
        // CSS-only themes carry no `overlay` config in this registry-less
        // path — clear whatever the previous theme's overlay was.
        if (window.ThemeOverlays) window.ThemeOverlays.apply({ type: 'none' });
        dispatchThemeChange(themeKey);
        return themeKey;
      }

      // Plan-gate (audit F-4): a locked theme must never be APPLIED ANEW
      // unless the user has unlocked it. apply() previously ignored `locked`,
      // so a locked achievement theme could be applied via a picker click,
      // a direct ThemeEngine.apply('diamond') call, or a URL param. We gate
      // only on save===true (deliberate new applications); save===false is the
      // boot/cross-device restore path, which must not bounce a theme the user
      // legitimately earned before the unlock set has hydrated from Firestore
      // (theme-achievements.js hydrates themeUnlocks async after boot). The
      // fallback re-applies the default rather than half-applying the locked one.
      if (save && theme.locked && !this.isUnlocked(themeKey)) {
        console.warn('[theme-engine] theme "' + themeKey + '" is locked — applying default instead');
        // Visual fallback ONLY — pass save=false so a rejected locked-theme
        // attempt (e.g. a ?theme=<locked> URL param or a stray apply(locked,
        // true) call) does NOT overwrite the rep's real saved theme in
        // localStorage + Firestore. Persisting here would silently wipe their
        // earned preference cross-device.
        if (themeKey !== DEFAULT_THEME) this.apply(DEFAULT_THEME, false);
        // Report the key we ACTUALLY applied (the default), not the rejected
        // locked one, so callers (maps.js picker) can stay in sync — PR #557 F-3.
        return DEFAULT_THEME;
      }

      const html = document.documentElement;

      // Set data-theme attribute
      html.setAttribute('data-theme', themeKey);

      // Resolve mode from user preference (or OS, when pref is 'auto'),
      // NOT from the theme's native mode. This lets a user with light
      // pref still pick the "Matrix" theme and see a readable light variant.
      // CSS keys off [data-mode="light"|"dark"] for component-level adjustments.
      const mode = getResolvedModeFromPref();
      html.setAttribute('data-mode', mode);
      if (mode === 'light') {
        html.setAttribute('data-light', 'true');
      } else {
        html.removeAttribute('data-light');
      }

      // Inject CSS variables — keyed by themeKey so we win specificity
      // ties against theme-system.css [data-theme="X"] rules.
      const styleEl = ensureStyleElement();
      styleEl.innerHTML = generateCSSVariables(theme, themeKey);

      // Load Google Fonts
      if (theme.font.heading) loadGoogleFont(theme.font.heading);
      if (theme.font.body) loadGoogleFont(theme.font.body);

      // Set cursor
      if (theme.cursor) {
        document.body.style.cursor = theme.cursor;
      }

      // Add/remove special class
      if (theme.specialClass) {
        document.body.classList.add(theme.specialClass);
      }

      // Save to localStorage
      if (save) {
        localStorage.setItem(STORAGE_KEY, themeKey);
        try { localStorage.setItem(LEGACY_KEY, themeKey); } catch (_) {} // write-through to nbd-theme so legacy readers stay in sync (F-1)
        // Audit batch 1 (2026-05-13): also sync the chosen theme to
        // Firestore so reps see the same theme across devices instead
        // of getting reset to default every time they open NBD on a
        // different browser/phone. Fire-and-forget — local theme is
        // already applied; Firestore sync is a nice-to-have, never
        // block on it.
        try {
          const uid = (window._user && window._user.uid) || null;
          if (uid && window.db && window.doc && window.setDoc) {
            window.setDoc(
              window.doc(window.db, 'userSettings', uid),
              { theme: themeKey, themeUpdatedAt: window.serverTimestamp ? window.serverTimestamp() : Date.now() },
              { merge: true }
            ).catch(err => console.warn('[theme-engine] Firestore sync failed:', err.message));
          }
        } catch (_) { /* non-fatal — page already painted the new theme */ }
      }

      currentTheme = themeKey;
      // Wire the theme's declared overlay (living-background/particle
      // effect) to the overlay engine. This call was missing entirely —
      // grepping the whole docs/pro/js tree found zero calls to
      // ThemeOverlays.apply() from anywhere, so every theme's `overlay`
      // field (37 registered effect types) has been dead configuration
      // since it was added; selecting a theme changed colors only.
      if (window.ThemeOverlays) window.ThemeOverlays.apply(theme.overlay || { type: 'none' });
      dispatchThemeChange(themeKey);
      return themeKey;
    },

    get(themeKey) {
      return THEMES[themeKey];
    },

    getAll() {
      return THEMES;
    },

    getByCategory(category) {
      return Object.entries(THEMES)
        .filter(([, theme]) => theme.category === category)
        .map(([key, theme]) => ({ key, ...theme }));
    },

    getCategories() {
      return CATEGORIES;
    },

    getCurrent() {
      return currentTheme;
    },

    isUnlocked(themeKey) {
      const theme = THEMES[themeKey];
      if (!theme) return false; // unknown/CSS-only key — never throw on .locked
      if (!theme.locked) return true;
      if (!window._themeUnlocks) return false;
      return window._themeUnlocks.has(themeKey);
    },

    unlock(themeKey) {
      if (!window._themeUnlocks) window._themeUnlocks = new Set();
      if (window._themeUnlocks.has(themeKey)) return; // already unlocked
      window._themeUnlocks.add(themeKey);
      // Persist to localStorage immediately so reload retains the unlock,
      // and sync to Firestore in the background so the unlock follows the
      // user across devices. Best-effort — failure to write doesn't block
      // the user from using the theme they just unlocked.
      try {
        const arr = [...window._themeUnlocks];
        localStorage.setItem('nbd_theme_unlocks', JSON.stringify(arr));
      } catch (e) {}
      try {
        const uid = window._user?.uid;
        if (uid && window.db && typeof window.setDoc === 'function' && typeof window.doc === 'function') {
          window.setDoc(
            window.doc(window.db, 'userSettings', uid),
            { themeUnlocks: [...window._themeUnlocks] },
            { merge: true }
          ).catch(err => console.warn('Theme unlock Firestore sync failed:', err.message));
        }
      } catch (e) {}
    },

    // Hydrate the in-memory unlock set from localStorage on boot. Firestore
    // hydration happens asynchronously elsewhere when auth resolves.
    hydrateUnlocks() {
      if (window._themeUnlocks && window._themeUnlocks.size > 0) return;
      try {
        const raw = localStorage.getItem('nbd_theme_unlocks');
        if (raw) {
          const arr = JSON.parse(raw);
          window._themeUnlocks = new Set(Array.isArray(arr) ? arr : []);
        }
      } catch (e) {}
    },

    previewCSS(themeKey) {
      const theme = THEMES[themeKey];
      if (!theme) return '';
      return generateCSSVariables(theme, themeKey);
    },

    // Mode-aware swatch colors for picker cards. Returns the four palette
    // values (bg/surface/accent/text) that resolvePalette would produce for
    // the user's current mode pref, so picker cards match what apply()
    // would actually render. Returns null if themeKey is unregistered.
    previewResolvedColors(themeKey) {
      return previewResolvedColors(themeKey);
    },

    // Expose mode resolution for picker swatches + component logic.
    // Returns the theme's NATIVE mode (what its `colors` palette was designed for).
    // For "what is being rendered right now", use getResolvedMode().
    getMode(themeKey) {
      const theme = THEMES[themeKey];
      if (!theme) return 'dark';
      return getNativeMode(theme);
    },

    // User mode preference API: 'light' | 'dark' | 'auto'.
    getModePref() {
      return getStoredModePref();
    },

    setModePref(pref) {
      if (pref !== 'light' && pref !== 'dark' && pref !== 'auto') return;
      setStoredModePref(pref);
      if (currentTheme) this.apply(currentTheme, false);
      document.dispatchEvent(new CustomEvent('modechange', {
        detail: { pref, resolved: getResolvedModeFromPref() },
        bubbles: true,
        cancelable: false
      }));
    },

    // The mode actually being rendered right now (user pref or OS when 'auto').
    getResolvedMode() {
      return getResolvedModeFromPref();
    }
  };

  // Re-apply the current theme when the OS color scheme flips, but only
  // when the user's preference is 'auto' (otherwise the user has an explicit
  // pref that should win regardless of OS).
  try {
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const onOSChange = () => {
        if (getStoredModePref() === 'auto' && currentTheme) {
          ThemeEngine.apply(currentTheme, false);
          document.dispatchEvent(new CustomEvent('modechange', {
            detail: { pref: 'auto', resolved: getResolvedModeFromPref() },
            bubbles: true,
            cancelable: false
          }));
        }
      };
      if (mq.addEventListener) mq.addEventListener('change', onOSChange);
      else if (mq.addListener) mq.addListener(onOSChange);
    }
  } catch (_) {}

  // ============================================================================
  // EXPOSURE
  // ============================================================================

  window.ThemeEngine = ThemeEngine;
  window._themeUnlocks = window._themeUnlocks || new Set();

})();
