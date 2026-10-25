/**
 * layout-logic.js — the pure half of the Daily Success layout switch.
 *
 * A layout is how the screens are arranged (data-ui on <html>); a theme is the colour skin (data-theme). They are independent,
 * so every layout must work in every theme. No DOM here: layout-ui.js applies and renders, tests/ds-layout-switch-*.test.js drives this.
 *
 * `ready` is the honest flag: a layout is only offered to pick once its CSS ships. The rest are listed as "coming" so the picker
 * shows the lineup without offering a choice that does nothing.
 * Design brief: documentation/projects/DAILY-SUCCESS-INTERFACES-2026-10-22.md.
 */
(function (root) {
  'use strict';

  const KEY = 'nbd_ds_layout';
  const DEFAULT = 'classic';
  const LAYOUTS = [
    { id: 'classic', label: 'Classic', blurb: 'The tracker as it is today.', ready: true },
    { id: 'logbook', label: 'Log Book', blurb: 'Plain and fast. Today\'s workout as a list, last time beside every set.', ready: true },
    { id: 'rings', label: 'Rings', blurb: 'Daily rings for floors, workout and calories. Close the rings.', ready: true },
    { id: 'cockpit', label: 'Cockpit', blurb: 'One dense HUD: today\'s numbers, the training week, what is behind.', ready: true },
    { id: 'quest', label: 'Quest', blurb: 'XP, levels and daily quests. Streaks can break; XP never does.', ready: true },
    { id: 'arcade', label: 'Arcade', blurb: 'Retro pixel look: scores, combos, PRs as high scores.', ready: false },
    { id: 'onething', label: 'One Thing', blurb: 'One big card: do this next, nothing else.', ready: true },
    { id: 'journal', label: 'Journal', blurb: 'A calm paper page for the day: an intention, a note.', ready: true },
  ];

  const byId = (id) => LAYOUTS.find((l) => l.id === id) || null;
  /** Only a layout that exists AND is ready can be active; anything else (old value, typo, hand-edited storage) is the default. */
  function normLayout(id) {
    const l = byId(typeof id === 'string' ? id : '');
    return l && l.ready ? l.id : DEFAULT;
  }

  const api = { KEY, DEFAULT, LAYOUTS, byId, normLayout };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDLayout = Object.assign(root.NBDLayout || {}, api);
})(typeof window !== 'undefined' ? window : null);
