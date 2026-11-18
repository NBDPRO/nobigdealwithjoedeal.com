/**
 * blankday-ui.js - the "yesterday is blank" banner and the "Days logged this week" line on the Dash Today card (Joe, 2026-11-18).
 * The rules are blankday-logic.js (pure, unit tested); this file gathers what the tracker already knows, draws two small blocks for
 * nextup-ui.js's Today card (bannerHtml, weekHtml), and handles the two buttons.
 *   - "Fill it in" opens yesterday's page, creating it first when there is none (the app only ever made today's page before).
 *   - "Not now" hides the banner for the rest of today (nbd_ds_blank_dismissed holds today's date; this device only).
 * Classic script, delegated listener; every value that reaches innerHTML goes through esc().
 */
(function () {
  'use strict';
  if (window.NBDBlankUI) return;
  /* global pages */
  const KEY = 'nbd_ds_blank_dismissed';
  const L = () => window.NBDBlankDay;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => (typeof window.todayKey === 'function' ? window.todayKey() : '');
  const allPages = () => { try { return Array.isArray(pages) ? pages : []; } catch (_) { return []; } };
  const floorsNow = () => { try { return typeof window.getFloors === 'function' ? window.getFloors() : []; } catch (_) { return []; } };
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const dismissedFor = () => { try { return localStorage.getItem(KEY) || ''; } catch (_) { return ''; } };
  const hasWorkout = (dk) => { try { return !!(window.NBDDayLayout && window.NBDDayLayout.workoutDone(read('nbd_ds_workouts', []), dk)); } catch (_) { return false; } };

  function banner() {
    if (!L()) return null;
    return L().bannerFor({ pages: allPages(), floors: floorsNow(), hasWorkout, todayDk: today(), dismissedFor: dismissedFor() });
  }
  function bannerHtml() {
    const b = banner();
    if (!b) return '';
    return '<div class="nu-blank" role="status"><div class="nu-line"><b>Yesterday (' + esc(b.label) + ') is blank.</b> Nothing was logged.</div>' +
      '<div class="nu-blank-btns"><button type="button" class="nu-btn" data-blank="open" data-dk="' + esc(b.dk) + '">Fill it in →</button>' +
      '<button type="button" class="nu-btn ghost" data-blank="later">Not now</button></div></div>';
  }
  function weekHtml() {
    if (!L()) return '';
    const r = L().daysLogged(allPages(), floorsNow(), hasWorkout, today());
    return r ? '<div class="nu-floors nu-logged">Days logged this week: ' + r.logged + ' / ' + r.of + '</div>' : '';
  }

  // Opens a date's page; makes one first when that date has none.
  function openDay(dk) {
    const arr = allPages();
    let idx = arr.findIndex((p) => p.dk === dk && (Number(p.suf) || 1) === 1);
    if (idx < 0) idx = arr.findIndex((p) => p.dk === dk);
    if (idx < 0) {
      if (typeof window.mkPage !== 'function' || typeof window.switchTo !== 'function') return;
      arr.push(window.mkPage(dk));
      if (typeof window.savePages === 'function' && window.savePages() === false) { arr.pop(); return; }   // storage refused: the app already told Joe
      idx = arr.length - 1;
    }
    window.switchTo(idx);
  }
  function later() {
    try { localStorage.setItem(KEY, today()); } catch (_) { /* the banner just comes back on the next draw */ }
    if (window.NBDNextUp && window.NBDNextUp.mountDash) window.NBDNextUp.mountDash();
    else document.querySelectorAll('.nu-blank').forEach((n) => n.remove());
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-blank]') : null;
    if (!t) return;
    if (t.dataset.blank === 'open') openDay(t.dataset.dk);
    else if (t.dataset.blank === 'later') later();
  });

  window.NBDBlankUI = { bannerHtml, weekHtml, openDay, later };
  if (window.NBDBlankDay) { window.NBDBlankDay.bannerHtml = bannerHtml; window.NBDBlankDay.weekHtml = weekHtml; }
})();
