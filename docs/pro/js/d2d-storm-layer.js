/**
 * d2d-storm-layer.js — Storm Watch on the door-knocking map (Jo, 2026-10-02;
 * idea #2 from the GameForce review: "hail, wind and tornado reports on your
 * map, so your team knocks the streets a storm just hit").
 *
 * A "🌩 Storms" toggle in the D2D Layers panel draws NWS Local Storm Reports
 * (hail / wind / tornado) around the map from the same server endpoint the
 * public /storm-report page uses (/api/storm-report — 5 years, 30 mi, newest
 * 200, cached per location 24 h; NOAA data via the Iowa Environmental
 * Mesonet, no key). Newer reports are brighter; a filter keeps the last 90
 * days / 1 year / 5 years. Panning far re-centres the query.
 *
 * Deep link: /pro/dashboard.html?storm=<lat>,<lon> opens the D2D map on that
 * spot with the layer on — the Storm Watch text links here
 * (functions/storm-watch.js).
 *
 * The map lives in window._D2DState (d2d-tracker-core-2026b.js); this file
 * needs Leaflet only when the layer is shown (the d2d bundle brings it).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const ENDPOINT = '/api/storm-report';
  const REFETCH_MI = 10;
  const WINDOWS = { d90: 90, y1: 365, y5: 1826 };
  const COLORS = { hail: '#3b82f6', wind: '#22c55e', tornado: '#ef4444' };

  let _layer = null, _legend = null, _center = null, _events = [], _window = 'y1', _map = null, _seq = 0;

  function haversineMi(la1, lo1, la2, lo2) {
    const R = 3958.8, dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** Age in days of a report date ('2025-06-14T21:30Z' etc.) at nowMs. */
  function ageDays(date, nowMs) {
    const t = Date.parse(String(date || '').replace(' ', 'T'));
    return Number.isFinite(t) ? (nowMs - t) / 86400000 : Infinity;
  }

  /** Marker style for one report (pure): newer = more opaque, bigger hail = bigger dot. */
  function styleFor(ev, nowMs) {
    const age = ageDays(ev.date, nowMs);
    const fill = COLORS[ev.type] || '#9ca3af';
    const opacity = age <= 30 ? 0.95 : age <= 90 ? 0.85 : age <= 365 ? 0.6 : 0.3;
    let radius = 6;
    if (ev.type === 'hail' && ev.magnitude) radius = Math.min(16, 5 + ev.magnitude * 5);
    if (ev.type === 'wind' && ev.magnitude) radius = ev.magnitude >= 70 ? 9 : 6;
    if (ev.type === 'tornado') radius = 10;
    return { radius, color: '#111827', weight: age <= 90 ? 2 : 1, fillColor: fill, fillOpacity: opacity, opacity: Math.max(0.4, opacity) };
  }

  /** Reports inside the chosen time window (pure). */
  function inWindow(events, windowKey, nowMs) {
    const days = WINDOWS[windowKey] || WINDOWS.y1;
    return (events || []).filter((e) => ageDays(e.date, nowMs) <= days && Number.isFinite(e.lat) && Number.isFinite(e.lon));
  }

  function label(ev) {
    const d = Date.parse(String(ev.date || '').replace(' ', 'T'));
    const when = Number.isFinite(d) ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const what = ev.type === 'hail' ? (ev.magnitude ? ev.magnitude + '" hail' : 'Hail')
      : ev.type === 'wind' ? (ev.magnitude ? ev.magnitude + ' mph wind' : 'Damaging wind') : 'Tornado';
    return what + (when ? ' · ' + when : '') + (ev.city ? ' · ' + ev.city : '');
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function draw() {
    if (!_map || !window.L) return;
    if (_layer) { _map.removeLayer(_layer); _layer = null; }
    const now = Date.now();
    const shown = inWindow(_events, _window, now).sort((a, b) => ageDays(b.date, now) - ageDays(a.date, now)); // newest on top
    _layer = window.L.layerGroup(shown.map((ev) => window.L.circleMarker([ev.lat, ev.lon], styleFor(ev, now)).bindPopup(esc(label(ev)))));
    _layer.addTo(_map);
    paintLegend(shown);
  }

  function paintLegend(shown) {
    if (!_legend) return;
    const n = { hail: 0, wind: 0, tornado: 0 };
    shown.forEach((e) => { if (n[e.type] != null) n[e.type]++; });
    const maxHail = shown.filter((e) => e.type === 'hail' && e.magnitude).reduce((m, e) => Math.max(m, e.magnitude), 0);
    _legend.innerHTML =
      '<div class="d2d-storm-chips">' +
        ['d90', 'y1', 'y5'].map((k) => '<button type="button" class="d2d-storm-chip' + (k === _window ? ' is-on' : '') + '" data-d2d-storm="' + k + '">' + ({ d90: '90 days', y1: '1 year', y5: '5 years' })[k] + '</button>').join('') +
      '</div>' +
      '<div class="d2d-storm-key"><span class="d2d-dot is-hail"></span>Hail ' + n.hail + (maxHail ? ' (max ' + esc(maxHail) + '")' : '') +
      ' <span class="d2d-dot is-wind"></span>Wind ' + n.wind + ' <span class="d2d-dot is-tornado"></span>Tornado ' + n.tornado + '</div>' +
      '<div class="d2d-storm-src">NWS storm reports (NOAA) · brighter = newer</div>';
  }

  async function load(center) {
    const seq = ++_seq;
    _center = center;
    try {
      const r = await fetch(ENDPOINT + '?lat=' + center.lat.toFixed(3) + '&lon=' + center.lng.toFixed(3), { headers: { accept: 'application/json' } });
      const j = r.ok ? await r.json() : null;
      if (seq !== _seq) return;
      _events = (j && Array.isArray(j.events)) ? j.events : [];
      if (!_events.length && typeof window.showToast === 'function') window.showToast('No storm reports within 30 miles in 5 years', 'info');
    } catch (e) {
      if (seq !== _seq) return;
      _events = [];
      if (typeof window.showToast === 'function') window.showToast('Could not load storm reports right now', 'error');
    }
    draw();
  }

  function onMoveEnd() {
    if (!_map || !_center) return;
    const c = _map.getCenter();
    if (haversineMi(c.lat, c.lng, _center.lat, _center.lng) >= REFETCH_MI) load(c);
  }

  function show(map) {
    _map = map || (window._D2DState && window._D2DState.d2dMap);
    if (!_map || !window.L) return;
    if (!_legend) {
      const Ctl = window.L.Control.extend({ onAdd: () => { const d = window.L.DomUtil.create('div', 'd2d-storm-legend'); window.L.DomEvent.disableClickPropagation(d); return d; } });
      _legend = null;
      const ctl = new Ctl({ position: 'bottomleft' });
      ctl.addTo(_map);
      _legend = ctl.getContainer();
      _legend._ctl = ctl;
    }
    _map.on('moveend', onMoveEnd);
    load(_map.getCenter());
  }

  function hide(map) {
    const m = map || _map;
    _seq++;
    if (m) {
      if (_layer) m.removeLayer(_layer);
      m.off('moveend', onMoveEnd);
      if (_legend && _legend._ctl) m.removeControl(_legend._ctl);
    }
    _layer = null; _legend = null; _center = null; _events = [];
  }

  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-d2d-storm]');
    if (!b) return;
    _window = b.dataset.d2dStorm;
    draw();
  });

  // ── Deep link: ?storm=<lat>,<lon> → the D2D map there, Storms on ─────
  function parseStormParam(search) {
    const m = /[?&]storm=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(String(search || ''));
    if (!m) return null;
    const lat = Number(m[1]), lon = Number(m[2]);
    return (lat > 24 && lat < 50 && lon > -130 && lon < -60) ? { lat, lon } : null;
  }
  function followDeepLink() {
    const at = parseStormParam(window.location.search);
    if (!at) return;
    let tries = 0;
    const tick = () => {
      if (typeof window.goTo !== 'function' || !window._user) { if (++tries < 60) setTimeout(tick, 500); return; }
      window.goTo('d2d');
      let mapTries = 0;
      const waitMap = () => {
        const st = window._D2DState || {};
        if (!st.d2dMap || typeof st.toggleLayer !== 'function') { if (++mapTries < 60) setTimeout(waitMap, 500); return; }
        st.d2dMap.setView([at.lat, at.lon], 13);
        if (!st.isLayerOn || !st.isLayerOn('storms')) st.toggleLayer('storms');
        try { window.history.replaceState({}, '', window.location.pathname + window.location.hash); } catch (_) {}
      };
      waitMap();
    };
    tick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', followDeepLink); else followDeepLink();

  window.NBDD2DStorms = { show, hide, styleFor, inWindow, label, parseStormParam, ageDays, WINDOWS };
})();
