/**
 * accent-logic.js — the pure half of the Daily Success accent picker.
 *
 * An accent is a colour laid over whichever of the ten skins is active. It is a short curated list, never a free hex, because
 * every entry has to read on every skin: white button text on the fill, and the accent as TEXT on the card and page.
 * One text colour cannot do both a white card and a black one, so each accent carries two text tints (for light and dark surfaces)
 * and textFor() picks by the skin's card colour. tests/ds-accent-picker-2026-10-22.test.js checks the whole accent x skin matrix.
 * No DOM here: accent-ui.js applies and renders.
 */
(function (root) {
  'use strict';

  const KEY = 'nbd_ds_accent';
  // fill: --ac (buttons, borders, rings; carries white text). onLight / onDark: accent used as text on a light / dark surface.
  const ACCENTS = [
    { id: 'clay', label: 'Clay', fill: '#B4461E', onLight: '#9A3A14', onDark: '#FF9A70' },
    { id: 'teal', label: 'Teal', fill: '#0F766E', onLight: '#0B5F58', onDark: '#5FD6C8' },
    { id: 'indigo', label: 'Indigo', fill: '#4F46E5', onLight: '#4338CA', onDark: '#B4B0FF' },
    { id: 'plum', label: 'Plum', fill: '#9D2D7E', onLight: '#862568', onDark: '#F2A0DA' },
    { id: 'rose', label: 'Rose', fill: '#BE123C', onLight: '#A30F34', onDark: '#FF9DB3' },
    { id: 'moss', label: 'Moss', fill: '#3F7A1E', onLight: '#33650F', onDark: '#9BE070' },
    { id: 'sky', label: 'Sky', fill: '#1D6FB8', onLight: '#175C99', onDark: '#82C4F5' },
    { id: 'amber', label: 'Amber', fill: '#8F5A00', onLight: '#7A4B00', onDark: '#FFC857' },
  ];

  const byId = (id) => ACCENTS.find((a) => a.id === id) || null;
  /** Only an id in the list is an accent; anything else (old value, hand-edited storage) means "use the theme's own". */
  function normAccent(id) { const a = byId(typeof id === 'string' ? id : ''); return a ? a.id : null; }

  function lum(hex) {
    const n = parseInt(String(hex).replace('#', '').slice(0, 6), 16);
    return [16, 8, 0].map((s, i) => { const v = ((n >> s) & 255) / 255; return (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) * [0.2126, 0.7152, 0.0722][i]; }).reduce((a, b) => a + b, 0);
  }
  /** A surface that is not clearly light counts as dark (missing or rgba value included), which is the safe side: the light tint on a light card would fail. */
  function isLight(hex) { return /^#[0-9a-f]{6}$/i.test(String(hex).trim()) && lum(hex.trim()) > 0.4; }
  const textFor = (a, surface) => (isLight(surface) ? a.onLight : a.onDark);
  const isHex = (v) => /^#[0-9a-f]{6}$/i.test(String(v).trim());
  /** The colour to judge light-or-dark by: the skin's card, or for a saved custom theme (no --paper rule) its own background. */
  const surfaceOf = (paper, fallbackBg) => (isHex(paper) ? String(paper).trim() : (isHex(fallbackBg) ? String(fallbackBg).trim() : ''));

  /** The custom properties to set inline for this accent on a skin whose card colour is `paper`. */
  function vars(id, paper) {
    const a = byId(id);
    if (!a) return null;
    // --orange is the legacy name the appearance modal's own chrome reads; that modal is dark in every skin, so it takes the on-dark tint.
    return { '--ac': a.fill, '--ac-text': textFor(a, paper), '--ac-on-dark': a.onDark, '--orange': a.onDark };
  }

  const api = { KEY, ACCENTS, byId, normAccent, lum, isLight, isHex, surfaceOf, textFor, vars };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDAccent = Object.assign(root.NBDAccent || {}, api);
})(typeof window !== 'undefined' ? window : null);
