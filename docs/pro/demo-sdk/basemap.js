// basemap.js — the sample account's offline map (Pro demo phase 2, wave 3,
// 2026-10-06).
//
// The CRM's maps (D2D door-knocking, Storm Center, the customer map) draw
// Esri / USGS / Kentucky / radar tiles from other sites. The demo route's CSP
// (img-src 'self' data: blob:) refuses every one of them, so in the sample
// account Leaflet's L.tileLayer is swapped (docs/pro/js/demo-mode.js traps the
// moment Leaflet sets window.L and calls install(L) below) for a grid layer
// that DRAWS each tile here, in the browser, as a small SVG: an invented
// neighbourhood ("Fort Thomas north", the story's storm zone) with its
// streets, houses and a park, the river, two invented highways and the
// sample customers' towns. No tile, image, font or API request leaves the
// browser, and nothing here is fetched at all: the geometry is in this file.
//
// Everything on it is labelled a sample: the attribution says "Sample map:
// invented streets, not to scale". Street names are Sample / Example /
// Placeholder / Demo / Test / Mock, like the rest of the seed.
//
// The same geometry places the seed's door knocks: scripts/build-demo-seed.js
// runs this file in a sandbox (no DOM) and reads houses() so every knock pin
// sits on a house on a drawn street, with a real-looking, invented address.
// Loaded as a classic script; install() is the only part that touches the DOM.
(function (root) {
  'use strict';

  var LABEL = 'Sample map: invented streets, not to scale';
  var M_PER_DEG_LAT = 111320;

  // ── geometry ([lat, lng], invented) ─────────────────────────────────────
  // River centreline, west to east; drawn as a band HALF_W degrees each side.
  var RIVER = [[39.150, -84.820], [39.120, -84.760], [39.108, -84.700], [39.098, -84.640], [39.092, -84.580],
    [39.097, -84.530], [39.100, -84.500], [39.093, -84.470], [39.086, -84.445], [39.075, -84.420],
    [39.058, -84.390], [39.045, -84.360], [39.030, -84.330], [39.005, -84.290], [38.985, -84.240],
    [38.975, -84.180], [38.960, -84.100]];
  var RIVER_HALF_W = 0.0024;

  function ring(centre, rLat, rLng, n) {
    var out = [];
    for (var i = 0; i <= n; i++) {
      var a = (i / n) * Math.PI * 2;
      out.push([+(centre[0] + Math.sin(a) * rLat).toFixed(5), +(centre[1] + Math.cos(a) * rLng).toFixed(5)]);
    }
    return out;
  }

  var ROADS = [
    // Regional (drawn from zoom 9): invented names on invented lines.
    { name: 'Sample Expressway', kind: 'highway', minZoom: 8, line: [[38.960, -84.610], [39.030, -84.560], [39.070, -84.528], [39.105, -84.512], [39.170, -84.490], [39.250, -84.430], [39.360, -84.320], [39.440, -84.230]] },
    { name: 'Sample Beltway', kind: 'highway', minZoom: 8, line: ring([39.150, -84.470], 0.150, 0.230, 36) },
    // The neighbourhood (drawn from zoom 13 / 14).
    { name: 'Sample Pike', kind: 'main', minZoom: 12, line: [[39.0560, -84.4720], [39.0690, -84.4560], [39.0735, -84.4500], [39.0768, -84.4445], [39.0793, -84.4390]] },
    { name: 'Example Ave', kind: 'street', line: [[39.0781, -84.4540], [39.0783, -84.4470], [39.0779, -84.4400]], houses: { first: 100 } },
    { name: 'Sample Ridge Rd', kind: 'street', line: [[39.0757, -84.4545], [39.0758, -84.4470], [39.0754, -84.4395]], houses: { first: 176 } },
    { name: 'Placeholder St', kind: 'street', line: [[39.0734, -84.4540], [39.0733, -84.4400]], houses: { first: 300 } },
    { name: 'Sample Hollow Ln', kind: 'street', line: [[39.0712, -84.4520], [39.0714, -84.4430]], houses: { first: 20 } },
    { name: 'Demo Ct', kind: 'street', line: [[39.0705, -84.4522], [39.0788, -84.4518]], houses: { first: 2 } },
    { name: 'Test Hill Rd', kind: 'street', line: [[39.0703, -84.4490], [39.0787, -84.4486]], houses: { first: 10 } },
    { name: 'Sample Way', kind: 'street', line: [[39.0706, -84.4452], [39.0786, -84.4455]], houses: { first: 40 } },
    { name: 'Mock Orchard Dr', kind: 'street', line: [[39.0712, -84.4418], [39.0782, -84.4420]], houses: { first: 60 } }
  ];

  var PARKS = [
    { name: 'Sample Park', ring: [[39.0789, -84.4512], [39.0801, -84.4512], [39.0803, -84.4476], [39.0790, -84.4474], [39.0789, -84.4512]] }
  ];

  // Towns: the sample customers' towns, at their real centres (the leads use
  // them), so a zoomed-out map of the whole account still reads.
  var PLACES = [
    ['Fort Thomas', 39.0751, -84.4466, 8, 13], ['Covington', 39.0837, -84.5086, 8], ['Florence', 38.9989, -84.6266, 8],
    ['Mason', 39.3601, -84.3099, 8], ['Union', 38.9459, -84.6805, 10], ['Loveland', 39.2689, -84.2638, 9],
    ['Fort Mitchell', 39.0595, -84.5474, 10], ['Milford', 39.1753, -84.2944, 8], ['Independence', 38.9431, -84.5441, 10],
    ['Batavia', 39.0770, -84.1769, 10], ['West Chester', 39.3328, -84.4083, 9], ['Erlanger', 39.0167, -84.6008, 10],
    ['Anderson Township', 39.0851, -84.3516, 10], ['Burlington', 39.0276, -84.7241, 10], ['Fairfield', 39.3454, -84.5603, 9],
    ['Fort Wright', 39.0517, -84.5341, 11], ['Blue Ash', 39.2320, -84.3783, 10], ['Hebron', 39.0659, -84.7010, 10],
    ['Montgomery', 39.2281, -84.3541, 11], ['Alexandria', 38.9595, -84.3880, 10], ['Lebanon', 39.4353, -84.2030, 9],
    ['Edgewood', 39.0187, -84.5777, 11], ['Cold Spring', 39.0137, -84.4380, 11]
  ].map(function (p) { return { name: p[0], at: [p[1], p[2]], minZoom: p[3], maxZoom: p[4] || 13, kind: 'place' }; });

  // ── local metres (equirectangular around the neighbourhood) ─────────────
  var LAT0 = 39.0751;
  var M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos(LAT0 * Math.PI / 180);
  function toXY(p) { return [p[1] * M_PER_DEG_LNG, p[0] * M_PER_DEG_LAT]; }
  function toLL(xy) { return [xy[1] / M_PER_DEG_LAT, xy[0] / M_PER_DEG_LNG]; }
  function segDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var L2 = dx * dx + dy * dy;
    var t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    var x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
    return Math.sqrt(x * x + y * y);
  }
  function lineDist(pXY, line) {
    var best = Infinity;
    for (var i = 1; i < line.length; i++) best = Math.min(best, segDist(pXY, toXY(line[i - 1]), toXY(line[i])));
    return best;
  }
  function inRing(pt, r) {
    var inside = false;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
      var yi = r[i][0], xi = r[i][1], yj = r[j][0], xj = r[j][1];
      if (((yi > pt[0]) !== (yj > pt[0])) && (pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function riverRing() {
    var north = RIVER.map(function (p) { return [p[0] + RIVER_HALF_W, p[1]]; });
    var south = RIVER.map(function (p) { return [p[0] - RIVER_HALF_W, p[1]]; }).reverse();
    return north.concat(south, [north[0]]);
  }
  var WATER = [{ name: 'Ohio River', ring: riverRing(), centre: RIVER }];

  // ── houses: one every SPACING m along each street, both sides ────────────
  // Even numbers on the left (walking first point → last), odd on the right.
  // A position near another road, in the park or in the river is skipped but
  // still uses its number, so numbering stays in order like a real street.
  var SPACING = 34, OFFSET = 15, CLEAR = 13;
  var _houses = null;
  function houses() {
    if (_houses) return _houses;
    var out = [];
    ROADS.forEach(function (rd) {
      if (!rd.houses) return;
      var pts = rd.line.map(toXY);
      var k = 0, carry = SPACING / 2;
      for (var s = 1; s < pts.length; s++) {
        var a = pts[s - 1], b = pts[s];
        var dx = b[0] - a[0], dy = b[1] - a[1], len = Math.sqrt(dx * dx + dy * dy);
        var ux = dx / len, uy = dy / len;
        for (var d = carry; d <= len; d += SPACING) {
          var cx = a[0] + ux * d, cy = a[1] + uy * d;
          [[-uy, ux, 0], [uy, -ux, 1]].forEach(function (side) {
            var hx = cx + side[0] * OFFSET, hy = cy + side[1] * OFFSET;
            var ll = toLL([hx, hy]);
            var clash = ROADS.some(function (o) { return o !== rd && o.kind !== 'highway' && lineDist([hx, hy], o.line) < OFFSET + CLEAR; }) ||
              PARKS.some(function (p) { return inRing(ll, p.ring); }) ||
              WATER.some(function (w) { return inRing(ll, w.ring); });
            if (clash) return;
            var num = rd.houses.first + 2 * k + side[2];
            out.push({
              number: num, street: rd.name, address: num + ' ' + rd.name,
              lat: +ll[0].toFixed(6), lng: +ll[1].toFixed(6),
              // the door faces the street; the roof square is drawn turned with it
              angle: Math.round(Math.atan2(uy, ux) * 180 / Math.PI)
            });
          });
          k++;
        }
        carry = d - len;
      }
    });
    _houses = out;
    return out;
  }
  function nearestHouse(lat, lng, maxMeters) {
    var p = toXY([lat, lng]), best = null, bd = Infinity;
    houses().forEach(function (h) {
      var q = toXY([h.lat, h.lng]), d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) { bd = d; best = h; }
    });
    return best && bd <= (maxMeters || 60) ? Object.assign({ meters: Math.round(bd) }, best) : null;
  }
  function nearestRoad(lat, lng, maxMeters) {
    var p = toXY([lat, lng]), best = null, bd = Infinity;
    ROADS.forEach(function (rd) { var d = lineDist(p, rd.line); if (d < bd) { bd = d; best = rd; } });
    return best && bd <= (maxMeters || 150) ? best.name : null;
  }

  var DATA = { label: LABEL, roads: ROADS, parks: PARKS, water: WATER, places: PLACES };

  // ── the Leaflet layer ────────────────────────────────────────────────────
  var STYLE = {
    streets: { land: '#efebe3', water: '#9ec5e6', park: '#c8e2b9', house: '#d8cfc1', houseLine: '#b9ab96',
      casing: { highway: '#c98a3e', main: '#d1a458', street: '#c9c1b3' }, fill: { highway: '#f5b971', main: '#f7d58b', street: '#ffffff' }, num: '#6b6255' },
    imagery: { land: '#34402f', water: '#1f3d55', park: '#3e5c35', house: '#7a6a58', houseLine: '#4f4438',
      casing: { highway: '#2a2a26', main: '#2a2a26', street: '#2a2a26' }, fill: { highway: '#c9b48a', main: '#b9b19b', street: '#9d998c' }, num: '#e9e4d8' }
  };
  var WIDTH = { highway: [5, 9], main: [4, 7], street: [3, 5.5] }; // [minZoomWidth, z18 width] px

  function variantFor(url) {
    return /World_Imagery|Imagery|satellite|aerial/i.test(String(url || '')) ? 'imagery' : 'streets';
  }
  // What a tile URL was for: a base map (drawn here), an underlay (USGS under
  // Esri — one sample map is enough) or an overlay (labels, Kentucky 3-inch,
  // radar): drawn as nothing, because there is no live data to show.
  function roleFor(url, opts) {
    var u = String(url || '');
    if (/nationalmap\.gov|USGSImagery/i.test(u)) return 'underlay';
    if (/Reference\/|kygisserver|mesonet|nexrad|radar|rainviewer|precip|tile\.py|hail|mrms/i.test(u)) return 'overlay';
    if (opts && ((opts.opacity != null && opts.opacity < 1) || (opts.zIndex != null && opts.zIndex >= 0))) return 'overlay';
    return 'base';
  }

  function install(L) {
    if (!L || !L.GridLayer || L.__nbdDemoBasemap) return false;
    L.__nbdDemoBasemap = true;
    var realTileLayer = L.tileLayer;

    function bboxOf(pts) {
      var s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
      pts.forEach(function (p) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); });
      return [s, w, n, e];
    }
    var FEATURES = [];
    WATER.forEach(function (w) { FEATURES.push({ t: 'water', pts: w.ring, bb: bboxOf(w.ring), minZoom: 0 }); });
    PARKS.forEach(function (p) { FEATURES.push({ t: 'park', pts: p.ring, bb: bboxOf(p.ring), minZoom: 13 }); });
    ROADS.forEach(function (r) { FEATURES.push({ t: 'road', kind: r.kind, pts: r.line, bb: bboxOf(r.line), minZoom: r.minZoom || 14 }); });

    var DemoBasemap = L.GridLayer.extend({
      options: { tileSize: 256, maxZoom: 23, maxNativeZoom: 23, attribution: LABEL, variant: 'streets', role: 'base', className: 'nbd-demo-basemap', updateWhenIdle: false },
      onAdd: function (map) {
        L.GridLayer.prototype.onAdd.call(this, map);
        if (this.options.role === 'base') addLabels(map, this.options.variant);
      },
      onRemove: function (map) {
        L.GridLayer.prototype.onRemove.call(this, map);
        if (this.options.role === 'base') removeLabels(map, this);
      },
      // The CRM's Esri retry handler and the draw tool's loupe ask these.
      setUrl: function () { return this; },
      getTileUrl: function () { return ''; },
      createTile: function (coords) {
        var div = document.createElement('div');
        div.className = 'nbd-demo-tile';
        if (this.options.role !== 'base') return div; // overlays: nothing live to draw
        var z = coords.z, map = this._map, st = STYLE[this.options.variant] || STYLE.streets;
        var size = this.getTileSize();
        var nw = coords.scaleBy(size);
        var b = this._tileCoordsToBounds(coords);
        var pad = 0.002 * Math.pow(2, Math.max(0, 14 - z));
        var S = b.getSouth() - pad, N = b.getNorth() + pad, W = b.getWest() - pad, E = b.getEast() + pad;
        function px(p) { var q = map.project([p[0], p[1]], z); return (q.x - nw.x).toFixed(1) + ',' + (q.y - nw.y).toFixed(1); }
        var parts = ['<rect width="' + size.x + '" height="' + size.y + '" fill="' + st.land + '"/>'];
        var roadsCasing = [], roadsFill = [];
        FEATURES.forEach(function (f) {
          if (z < f.minZoom) return;
          if (f.bb[2] < S || f.bb[0] > N || f.bb[3] < W || f.bb[1] > E) return;
          var d = 'M' + f.pts.map(px).join('L');
          if (f.t === 'water') parts.push('<path d="' + d + 'Z" fill="' + st.water + '"/>');
          else if (f.t === 'park') parts.push('<path d="' + d + 'Z" fill="' + st.park + '"/>');
          else {
            var wz = WIDTH[f.kind] || WIDTH.street;
            var w = z >= 18 ? wz[1] * Math.pow(1.6, z - 18) : Math.max(1, wz[0] * Math.pow(0.8, Math.max(0, 15 - z)));
            roadsCasing.push('<path d="' + d + '" fill="none" stroke="' + st.casing[f.kind] + '" stroke-width="' + (w + 2).toFixed(1) + '" stroke-linecap="round" stroke-linejoin="round"/>');
            roadsFill.push('<path d="' + d + '" fill="none" stroke="' + st.fill[f.kind] + '" stroke-width="' + w.toFixed(1) + '" stroke-linecap="round" stroke-linejoin="round"/>');
          }
        });
        parts = parts.concat(roadsCasing, roadsFill);
        if (z >= 16) {
          var half = 6 * Math.pow(2, z - 17); // ~12 m roofs
          houses().forEach(function (h) {
            if (h.lat < S || h.lat > N || h.lng < W || h.lng > E) return;
            var q = map.project([h.lat, h.lng], z), x = q.x - nw.x, y = q.y - nw.y;
            parts.push('<rect x="' + (x - half).toFixed(1) + '" y="' + (y - half).toFixed(1) + '" width="' + (2 * half).toFixed(1) + '" height="' + (2 * half).toFixed(1) +
              '" rx="1" fill="' + st.house + '" stroke="' + st.houseLine + '" transform="rotate(' + (-h.angle) + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')"/>');
            if (z >= 19) parts.push('<text x="' + x.toFixed(1) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="middle" font-size="11" font-family="system-ui,sans-serif" fill="' + st.num + '">' + h.number + '</text>');
          });
        }
        div.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size.x + '" height="' + size.y + '" viewBox="0 0 ' + size.x + ' ' + size.y + '" aria-hidden="true">' + parts.join('') + '</svg>';
        return div;
      }
    });

    // Street and town names: DOM labels in their own pane (above the tiles,
    // under the CRM's pins), shown by zoom.
    var LABELS = [];
    // A street's name repeats every ~LABEL_EVERY m along it (so it is on
    // screen at house level wherever you are); a highway's once, at its middle.
    var LABEL_EVERY = 260;
    function angleOf(a, b) {
      var dy = (b[0] - a[0]) * M_PER_DEG_LAT, dx = (b[1] - a[1]) * M_PER_DEG_LNG;
      var deg = -Math.atan2(dy, dx) * 180 / Math.PI;
      if (deg > 90) deg -= 180; if (deg < -90) deg += 180;
      return Math.round(deg);
    }
    ROADS.forEach(function (r) {
      var line = r.line;
      if (r.kind === 'highway') {
        var i = Math.floor((line.length - 1) / 2);
        LABELS.push({ name: r.name, at: line[i], rot: angleOf(line[i], line[Math.min(i + 1, line.length - 1)]), minZoom: 11, maxZoom: 23, cls: 'is-road' });
        return;
      }
      var next = LABEL_EVERY / 2, walked = 0;
      for (var s = 1; s < line.length; s++) {
        var a = toXY(line[s - 1]), b = toXY(line[s]), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        while (next <= walked + len) {
          var t = (next - walked) / len;
          LABELS.push({ name: r.name, at: toLL([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]), rot: angleOf(line[s - 1], line[s]), minZoom: 16, maxZoom: 23, cls: 'is-road' });
          next += LABEL_EVERY;
        }
        walked += len;
      }
    });
    PLACES.forEach(function (p) { LABELS.push({ name: p.name, at: p.at, rot: 0, minZoom: p.minZoom, maxZoom: p.maxZoom, cls: 'is-place' }); });
    LABELS.push({ name: 'Ohio River', at: [39.0950, -84.6100], rot: 0, minZoom: 10, maxZoom: 15, cls: 'is-water' });
    LABELS.push({ name: 'Sample Park', at: [39.0796, -84.4493], rot: 0, minZoom: 16, maxZoom: 23, cls: 'is-park' });

    function addLabels(map, variant) {
      if (map.__nbdDemoLabels) { map.__nbdDemoLabels.n++; return; }
      if (!map.getPane('nbdDemoLabels')) {
        var pane = map.createPane('nbdDemoLabels');
        pane.style.zIndex = 350;
        pane.style.pointerEvents = 'none';
      }
      var group = L.layerGroup();
      var markers = LABELS.map(function (l) {
        var span = document.createElement('span');
        span.className = 'nbd-demo-lbl ' + l.cls + (variant === 'imagery' ? ' on-dark' : '');
        span.textContent = l.name;
        if (l.rot) span.style.transform = 'translate(-50%,-50%) rotate(' + l.rot + 'deg)';
        var m = L.marker(l.at, { icon: L.divIcon({ className: 'nbd-demo-lbl-icon', html: span, iconSize: null }), interactive: false, keyboard: false, pane: 'nbdDemoLabels' });
        m.__nbd = l;
        return m;
      });
      function sync() {
        var z = map.getZoom();
        markers.forEach(function (m) {
          var on = z >= m.__nbd.minZoom && z <= m.__nbd.maxZoom;
          if (on && !group.hasLayer(m)) group.addLayer(m);
          else if (!on && group.hasLayer(m)) group.removeLayer(m);
        });
      }
      group.addTo(map);
      map.on('zoomend', sync);
      sync();
      map.__nbdDemoLabels = { n: 1, group: group, sync: sync };
    }
    function removeLabels(map) {
      var s = map.__nbdDemoLabels;
      if (!s || --s.n > 0) return;
      map.off('zoomend', s.sync);
      try { map.removeLayer(s.group); } catch (_) { /* already gone */ }
      map.__nbdDemoLabels = null;
    }

    function demoTileLayer(url, opts) {
      var o = Object.assign({}, opts || {});
      var role = roleFor(url, o);
      var layer = new DemoBasemap({ zIndex: o.zIndex, variant: variantFor(url), role: role, attribution: role === 'base' ? LABEL : '', pane: o.pane || 'tilePane' });
      layer._nbdRequestedUrl = String(url || '').slice(0, 200);
      if (role === 'overlay' && root.__NBD_DEMO__ && typeof root.__NBD_DEMO__.say === 'function') {
        root.__NBD_DEMO__.say('Live map layers (radar, imagery and labels) are in your real account. The sample account draws an offline sample map.');
      }
      return layer;
    }
    demoTileLayer.wms = demoTileLayer;
    L.tileLayer = demoTileLayer;
    L.tileLayer.__nbdReal = realTileLayer;
    L.NBDDemoBasemap = DemoBasemap;
    return true;
  }

  root.NBD_DEMO_BASEMAP = { DATA: DATA, LABEL: LABEL, houses: houses, nearestHouse: nearestHouse, nearestRoad: nearestRoad, inRing: inRing, roleFor: roleFor, install: install };
  // Leaflet already on the page (a late load of this file): swap it now.
  if (root.L && root.L.GridLayer) install(root.L);
})(typeof window !== 'undefined' ? window : this);
