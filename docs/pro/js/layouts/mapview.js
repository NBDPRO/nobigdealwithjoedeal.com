/**
 * layouts/mapview.js — the shared MapView layout component (2026-10-12, M1 of
 * the Mission Control / job-map lane).
 *
 * One small map surface for every layout that needs one (Mission Control, the
 * job-map day route, Crew Calendar's day map, Field Map, Pixel World's town).
 * It is a THIN themed shell over the map stack the CRM already ships — vendored
 * Leaflet (the `mapvendor` ScriptLoader bundle) and the OpenStreetMap street
 * tiles the draw tool already uses. No new tile vendor, no paid API, nothing
 * the CSP does not already allow.
 *
 * API (all coordinates are plain numbers; nothing here reads CRM data itself):
 *
 *   NBDMapView.create(el, opts) -> Promise<MapViewInstance>
 *       opts: { center:[lat,lng], zoom, tiles:'streets'|'sat'|'plain', scroll:boolean }
 *       Loads Leaflet on demand. Resolves null (never rejects) when it cannot.
 *
 *   inst.setPins(pins)       [{ id, lat, lng, kind:'job'|'lead'|'crew'|'stop'|'hail'|'dot',
 *                               color:'orange'|'red'|'gold'|'green'|'blue'|'purple'|'muted',
 *                               num?, title?, selected?, size? }]
 *                            kind 'dot' = small circle (storm reports, door knocks)
 *   inst.setSwaths(swaths)   [{ id, rings:[[lat,lng],...], level:'warn'|'gold'|'red'|'turf', title? }]
 *                            Hail danger is ALWAYS --red / --gold, in every theme;
 *                            'turf' (a crew's canvass area) is --orange, never danger-coloured.
 *   inst.setRoutes(routes)   [{ id, points:[[lat,lng],...], color?, dashed? }]   (--orange)
 *   inst.fit(pad?)           frame everything drawn
 *   inst.select(id)          highlight + pan to a pin
 *   inst.popup(id, node)     open a DOM node (NOT an html string) over a pin
 *   inst.on(name, fn)        'pinclick' -> {pin}, 'swathclick' -> {swath}, 'mapclick' -> {lat,lng}
 *   inst.setTiles(mode)      'streets' | 'sat' | 'plain'
 *   inst.retheme()           re-read the theme; also runs on `themechange`
 *   inst.destroy()
 *
 * Theming: land is --bg, roads/rules --s2/--rule, route --orange. OSM tiles are
 * recoloured with a CSS filter + blend chosen from the luminance of --bg (dark
 * theme -> inverted + multiplied into --bg), so a dark theme gets a dark map and
 * a light theme a light one, and it flips on `themechange`. Swaths and hail
 * pins use --red / --gold only.
 *
 * Pure helpers (luminance, point-in-polygon, normalisers, bounds) are exported
 * for tests: require('.../mapview.js').
 */
(function (root) {
  'use strict';

  var COLORS = ['orange', 'red', 'gold', 'green', 'blue', 'purple', 'muted'];
  var KINDS = ['job', 'lead', 'crew', 'stop', 'hail', 'dot'];
  var LEVELS = ['warn', 'gold', 'red', 'turf'];   // warn/gold/red = hail danger; turf = a team's area (--orange)
  var TILE_MODES = ['streets', 'sat', 'plain'];

  // ── pure ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function num(v) { var n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v); return isFinite(n) ? n : null; }
  function validLat(v) { return v != null && v >= -90 && v <= 90; }
  function validLng(v) { return v != null && v >= -180 && v <= 180; }
  function pick(v, list, dflt) { return list.indexOf(v) !== -1 ? v : dflt; }

  /** "rgb(12, 14, 20)" / "rgba(...)" / "#abc" / "#aabbcc" -> {r,g,b,a} or null. */
  function parseColor(s) {
    var t = String(s == null ? '' : s).trim().toLowerCase();
    var m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\s*\)$/.exec(t);
    if (m) {
      var a = 1;
      if (m[4] != null) a = m[4].slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r: +m[1], g: +m[2], b: +m[3], a: a };
    }
    m = /^#([0-9a-f]{3})$/.exec(t);
    if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
    m = /^#([0-9a-f]{6})$/.exec(t);
    if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
    return null;
  }
  /** WCAG relative luminance 0..1 of a parsed colour. */
  function luminance(c) {
    function ch(v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  }
  /** Is this CSS colour a dark surface? Unknown / transparent -> true (the CRM's default look is dark). */
  function isDarkColor(s) {
    var c = parseColor(s);
    if (!c || c.a === 0) return true;
    return luminance(c) < 0.4;
  }

  /** Ray-casting point-in-polygon on [lat,lng] rings. Ring may be open or closed. */
  function pointInRing(lat, lng, ring) {
    if (!Array.isArray(ring) || ring.length < 3) return false;
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /** Hail size (inches) -> swath level. >= 1.75" (golf ball) is red, smaller hail gold. */
  function levelForHail(inches) {
    var n = num(inches);
    if (n == null || n <= 0) return 'warn';
    return n >= 1.75 ? 'red' : 'gold';
  }

  function normalizePin(p) {
    if (!p || typeof p !== 'object') return null;
    var lat = num(p.lat), lng = num(p.lng != null ? p.lng : p.lon);
    if (!validLat(lat) || !validLng(lng)) return null;
    // 0,0 is "no location" (an un-geocoded lead), not a pin in the Gulf of Guinea.
    if (lat === 0 && lng === 0) return null;
    var n = num(p.num);
    return {
      id: String(p.id == null ? '' : p.id),
      lat: lat, lng: lng,
      kind: pick(p.kind, KINDS, 'job'),
      color: pick(p.color, COLORS, 'muted'),
      num: n != null && n >= 0 ? Math.round(n) : null,
      title: String(p.title == null ? '' : p.title).slice(0, 200),
      selected: p.selected === true,
      size: num(p.size),
    };
  }
  function normalizeRing(r) {
    if (!Array.isArray(r)) return null;
    var out = [];
    for (var i = 0; i < r.length; i++) {
      var pt = r[i];
      var lat = num(pt && pt[0]), lng = num(pt && pt[1]);
      if (validLat(lat) && validLng(lng)) out.push([lat, lng]);
    }
    return out.length >= 3 ? out : null;
  }
  function normalizeSwath(s) {
    if (!s || typeof s !== 'object') return null;
    var rings = (Array.isArray(s.rings) ? s.rings : []).map(normalizeRing).filter(Boolean);
    if (!rings.length) return null;
    return { id: String(s.id == null ? '' : s.id), rings: rings, level: pick(s.level, LEVELS, 'warn'), title: String(s.title == null ? '' : s.title).slice(0, 200) };
  }
  function normalizeRoute(r) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.points)) return null;
    var pts = [];
    r.points.forEach(function (pt) {
      var lat = num(pt && pt[0]), lng = num(pt && pt[1]);
      if (validLat(lat) && validLng(lng)) pts.push([lat, lng]);
    });
    if (pts.length < 2) return null;
    return { id: String(r.id == null ? '' : r.id), points: pts, color: pick(r.color, COLORS, 'orange'), dashed: r.dashed === true };
  }

  /** [[south, west],[north, east]] around every point, or null when none. */
  function boundsOf(points) {
    var s = 90, w = 180, n = -90, e = -180, any = false;
    (points || []).forEach(function (p) {
      if (!p) return;
      any = true;
      if (p[0] < s) s = p[0]; if (p[0] > n) n = p[0];
      if (p[1] < w) w = p[1]; if (p[1] > e) e = p[1];
    });
    return any ? [[s, w], [n, e]] : null;
  }

  var TILES = {
    streets: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', opt: { attribution: '© OpenStreetMap', maxNativeZoom: 19, maxZoom: 21 } },
    sat: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opt: { attribution: '© Esri, Maxar, Earthstar Geographics', maxNativeZoom: 19, maxZoom: 21 } },
  };

  // ── the instance, against an injected environment (tests pass a fake) ─
  function build(env, el, opts) {
    var L = env.L, doc = env.doc, win = env.win;
    var o = opts || {};
    var listeners = {};
    var map = null, tileLayer = null, tiles = pick(o.tiles, TILE_MODES, 'streets');
    var pinLayer = null, swathLayer = null, routeLayer = null;
    var pinIndex = {}, swathIndex = {}, selectedId = null;
    var drawn = [];     // every [lat,lng] currently drawn, for fit()
    var themeHandler = null, ro = null, probe = null, dead = false;

    function emit(name, detail) {
      (listeners[name] || []).slice().forEach(function (fn) { try { fn(detail); } catch (e) {} });
    }

    el.classList.add('nbd-mv');
    probe = doc.createElement('span');
    probe.className = 'mv-probe';
    probe.setAttribute('aria-hidden', 'true');
    el.appendChild(probe);

    var center = Array.isArray(o.center) && validLat(num(o.center[0])) && validLng(num(o.center[1])) ? o.center : [39.1, -84.5];
    map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: o.scroll !== false, preferCanvas: false })
      .setView(center, num(o.zoom) || 11);
    pinLayer = L.layerGroup().addTo(map);
    swathLayer = L.layerGroup().addTo(map);
    routeLayer = L.layerGroup().addTo(map);
    // Layering is the default overlay pane's DOM order (swaths are added before
    // routes) under the marker pane. Custom panes were tried and dropped: a
    // Leaflet renderer created for a custom pane sized itself to 0 px and
    // clipped every polygon away.

    function applyTiles() {
      if (tileLayer) { try { map.removeLayer(tileLayer); } catch (e) {} tileLayer = null; }
      var t = TILES[tiles];
      if (t) { tileLayer = L.tileLayer(t.url, t.opt); tileLayer.addTo(map); }
      el.setAttribute('data-mv-tiles', tiles);
    }
    function retheme() {
      if (dead) return;
      var bg = '';
      try { bg = win.getComputedStyle(probe).backgroundColor; } catch (e) {}
      var dark = isDarkColor(bg);
      el.classList.toggle('mv-dark', dark);
      el.classList.toggle('mv-light', !dark);
      el.setAttribute('data-mv-theme', dark ? 'dark' : 'light');
    }

    function pinIcon(p) {
      var cls = 'mv-pin mv-pin--' + p.kind + ' mv-c-' + p.color + (p.selected ? ' mv-pin--sel' : '');
      var inner = p.num != null ? '<b>' + esc(p.num) + '</b>' : '';
      return L.divIcon({ className: 'mv-pin-wrap', html: '<span class="' + cls + '">' + inner + '</span>', iconSize: [30, 30], iconAnchor: [15, 15] });
    }

    // Redraw only what changed (#2467 follow-up, 2026-10-16): a Mission repaint
    // used to throw away and rebuild every pin (500 of them on a canvass day) on
    // each tab switch, layer toggle and poll. A pin with an id keeps its marker
    // while its drawn facts are the same; a changed one is replaced; a gone one
    // removed. Pins without an id are redrawn as before.
    var anonMarkers = [];
    function pinSig(p) { return [p.lat, p.lng, p.kind, p.color, p.num, p.title, p.selected ? 1 : 0, p.size].join('|'); }
    function makeMarker(p) {
      var m;
      if (p.kind === 'dot') {
        m = L.circleMarker([p.lat, p.lng], { radius: p.size && p.size > 0 ? Math.min(16, p.size) : 5, className: 'mv-dot mv-c-' + p.color, weight: 1 });
        if (p.title && m.bindTooltip) m.bindTooltip(p.title);
      } else {
        m = L.marker([p.lat, p.lng], { icon: pinIcon(p), title: p.title || undefined, keyboard: true, riseOnHover: true });
      }
      // the pin as drawn NOW (a kept marker outlives the list it came from)
      m.on('click', function () { emit('pinclick', { pin: p.id && pinIndex[p.id] ? pinIndex[p.id].pin : p }); });
      return m;
    }
    function setPins(list) {
      var next = {}, order = [], anon = [];
      (list || []).forEach(function (raw) {
        var p = normalizePin(raw);
        if (!p) return;
        if (p.id && p.id === selectedId) p.selected = true;
        if (!p.id || next[p.id]) { anon.push(p); return; }
        next[p.id] = p; order.push(p.id);
      });
      Object.keys(pinIndex).forEach(function (id) {
        var cur = pinIndex[id], n = next[id];
        if (n && pinSig(n) === cur.sig) { cur.pin = n; return; }
        pinLayer.removeLayer(cur.marker);
        delete pinIndex[id];
      });
      anonMarkers.forEach(function (m) { pinLayer.removeLayer(m); });
      anonMarkers = [];
      order.forEach(function (id) {
        if (pinIndex[id]) return;
        var p = next[id], m = makeMarker(p);
        m.addTo(pinLayer);
        pinIndex[id] = { pin: p, marker: m, sig: pinSig(p) };
      });
      anon.forEach(function (p) { var m = makeMarker(p); m.addTo(pinLayer); anonMarkers.push(m); });
      collect();
    }
    function setSwaths(list) {
      swathLayer.clearLayers();
      swathIndex = {};
      (list || []).forEach(function (raw) {
        var s = normalizeSwath(raw);
        if (!s) return;
        var poly = L.polygon(s.rings, { className: 'mv-swath mv-swath--' + s.level, weight: 2 });
        if (s.title && poly.bindTooltip) poly.bindTooltip(s.title, { sticky: true });
        poly.on('click', function () { emit('swathclick', { swath: s }); });
        poly.addTo(swathLayer);
        if (s.id) swathIndex[s.id] = { swath: s, layer: poly };
      });
      collect();
    }
    function setRoutes(list) {
      routeLayer.clearLayers();
      (list || []).forEach(function (raw) {
        var r = normalizeRoute(raw);
        if (!r) return;
        L.polyline(r.points, { className: 'mv-route mv-c-' + r.color + (r.dashed ? ' mv-route--dashed' : ''), weight: 4 }).addTo(routeLayer);
      });
      collect();
    }
    function collect() {
      drawn = [];
      Object.keys(pinIndex).forEach(function (k) { drawn.push([pinIndex[k].pin.lat, pinIndex[k].pin.lng]); });
      Object.keys(swathIndex).forEach(function (k) { swathIndex[k].swath.rings.forEach(function (r) { r.forEach(function (pt) { drawn.push(pt); }); }); });
    }
    function fit(pad) {
      var b = boundsOf(drawn);
      if (!b) return false;
      if (b[0][0] === b[1][0] && b[0][1] === b[1][1]) { map.setView(b[0], Math.max(map.getZoom(), 14)); return true; }
      map.fitBounds(b, { padding: [pad == null ? 40 : pad, pad == null ? 40 : pad], maxZoom: 16 });
      return true;
    }
    function select(id) {
      selectedId = id == null ? null : String(id);
      Object.keys(pinIndex).forEach(function (k) {
        var e = pinIndex[k];
        var want = k === selectedId;
        if (e.pin.selected === want) return;
        e.pin.selected = want;
        if (e.pin.kind !== 'dot' && e.marker.setIcon) e.marker.setIcon(pinIcon(e.pin));
        e.sig = pinSig(e.pin);
      });
      var hit = selectedId && pinIndex[selectedId];
      if (hit) map.panTo([hit.pin.lat, hit.pin.lng]);
      return !!hit;
    }
    function popup(id, node) {
      var hit = pinIndex[String(id)];
      if (!hit || !node) return false;
      L.popup({ closeButton: true, autoPan: true, className: 'mv-popup' }).setLatLng([hit.pin.lat, hit.pin.lng]).setContent(node).openOn(map);
      return true;
    }

    map.on('click', function (ev) { emit('mapclick', { lat: ev.latlng.lat, lng: ev.latlng.lng }); });
    applyTiles();
    retheme();
    if (win.addEventListener) {
      // The engine fires `themechange` as it applies, and a Theme Morph can land
      // the new tokens a frame (or ~400 ms of view transition) later, so read
      // again shortly after: the last read is the one that sticks.
      themeHandler = function () {
        retheme();
        if (typeof win.setTimeout === 'function') [60, 250, 650].forEach(function (ms) { win.setTimeout(retheme, ms); });
      };
      doc.addEventListener('themechange', themeHandler);
      doc.addEventListener('modechange', themeHandler);   // light/dark preference flips without a theme change
    }
    if (typeof win.ResizeObserver === 'function') {
      ro = new win.ResizeObserver(function () { try { map.invalidateSize(); } catch (e) {} });
      ro.observe(el);
    }

    return {
      map: map,
      setPins: setPins, setSwaths: setSwaths, setRoutes: setRoutes, fit: fit, select: select, popup: popup,
      setTiles: function (m) { tiles = pick(m, TILE_MODES, tiles); applyTiles(); },
      retheme: retheme,
      on: function (name, fn) { if (typeof fn === 'function') (listeners[name] = listeners[name] || []).push(fn); },
      invalidate: function () { try { map.invalidateSize(); } catch (e) {} },
      destroy: function () {
        dead = true;
        if (themeHandler) { doc.removeEventListener('themechange', themeHandler); doc.removeEventListener('modechange', themeHandler); }
        if (ro) { try { ro.disconnect(); } catch (e) {} }
        try { map.remove(); } catch (e) {}
        el.classList.remove('nbd-mv', 'mv-dark', 'mv-light');
        listeners = {}; pinIndex = {}; swathIndex = {}; anonMarkers = [];
      },
    };
  }

  // ── Leaflet loading + the public factory ─────────────────────────────
  function ensureLeaflet() {
    var w = root;
    if (w.L && typeof w.L.map === 'function') return Promise.resolve(true);
    var p = w.ScriptLoader && typeof w.ScriptLoader.loadBundle === 'function' ? w.ScriptLoader.loadBundle('mapvendor') : Promise.resolve();
    return Promise.resolve(p).then(function () {
      return new Promise(function (resolve) {
        var tries = 0;
        (function poll() {
          if (w.L && typeof w.L.map === 'function') return resolve(true);
          if (++tries > 80) return resolve(false);   // ~8 s
          setTimeout(poll, 100);
        })();
      });
    }, function () { return false; });
  }
  function create(el, opts) {
    if (!el || !root || !root.document) return Promise.resolve(null);
    return ensureLeaflet().then(function (ok) {
      if (!ok || el.isConnected === false) return null;
      try { return build({ L: root.L, doc: root.document, win: root }, el, opts); }
      catch (e) { try { console.warn('[mapview] create failed:', e && e.message); } catch (_) {} return null; }
    });
  }

  var api = {
    create: create, _build: build,
    COLORS: COLORS, KINDS: KINDS, LEVELS: LEVELS, TILE_MODES: TILE_MODES,
    parseColor: parseColor, luminance: luminance, isDarkColor: isDarkColor,
    pointInRing: pointInRing, levelForHail: levelForHail, boundsOf: boundsOf,
    normalizePin: normalizePin, normalizeSwath: normalizeSwath, normalizeRoute: normalizeRoute,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDMapView = api;
})(typeof window !== 'undefined' ? window : null);
