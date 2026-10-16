/**
 * d2d-door-import.js — import a door list (CSV) into the D2D tracker (2026-10-16).
 *
 * Joe's aging-roof door lists (nbd-agents tools/aging-roofs.js) and any
 * spreadsheet of addresses come in as a CSV; the D2D tracker shows them as a
 * "door list": walkable routes in order, each stop one tap from the knock
 * sheet (openQuickKnock with the address and location filled in), and the
 * doors as small markers on the map. Doors only: nothing here contacts anyone.
 *
 * WHAT IS KEPT per door: the address, town, zip, location, year built / last
 * roof permit / estimated roof age and how it was estimated, the route and
 * stop. WHAT IS DROPPED: every other column, by design. A column that looks
 * like a person or a way to reach one (owner, name, phone, email, mailing
 * address) is never read, and the import says how many columns it ignored.
 *
 * STORED as d2d_doorlists/{id}: { userId, companyId, assignedTo, name, source,
 * createdAt, rowCount, doors[], notes[] } — the importer's own list, readable
 * by them, their company's owner / managers, and the rep it is assigned to
 * (firestore.rules; tests/firestore-rules.d2d-doorlists.test.js).
 *
 * Loaded in the lazy 'd2d' ScriptLoader bundle before the tracker; pure
 * helpers are exported for tests/d2d-door-import-2026-10-16.test.js.
 */
(function (root) {
  'use strict';

  var MAX_DOORS = 1500;
  var MAX_NOTES = 40;
  var MAX_BYTES = 2 * 1024 * 1024;
  var DOOR_KEYS = ['a', 'la', 'ln', 'z', 't', 'y', 'r', 'ag', 'b', 'rt', 's'];
  var LIST_KEYS = ['userId', 'companyId', 'assignedTo', 'name', 'source', 'createdAt', 'rowCount', 'doors', 'notes'];

  // header aliases → field. Compared lower-case with spaces / dashes as underscores.
  var ALIASES = {
    address: ['address', 'street_address', 'full_address', 'site_address', 'property_address', 'addr', 'location_address'],
    city: ['city', 'town', 'municipality', 'jurisdiction'],
    state: ['state', 'st'],
    zip: ['zip', 'zipcode', 'zip_code', 'postal', 'postal_code'],
    lat: ['lat', 'latitude', 'y'],
    lng: ['lng', 'lon', 'long', 'longitude', 'x'],
    yearBuilt: ['year_built', 'yearbuilt', 'yr_built', 'yrblt', 'built'],
    roofPermit: ['last_roof_permit', 'roof_permit', 'roof_permit_year', 'roof_permit_date', 'last_roof_permit_year'],
    roofAge: ['roof_age', 'roof_age_years', 'est_roof_age', 'estimated_roof_age'],
    basis: ['basis', 'age_basis', 'roof_age_basis'],
    route: ['route', 'route_id', 'cluster', 'walk'],
    stop: ['stop', 'seq', 'sequence', 'order', 'stop_no'],
    note: ['permit_note', 'canvassing_note', 'note'],
  };
  // Never read: people and ways to reach them.
  var PERSONAL = /(owner|^name$|first_?name|last_?name|full_?name|phone|mobile|cell|email|e_?mail|mail(ing)?_?(name|addr)|contact|ssn|dob)/;

  function normHeader(h) { return String(h == null ? '' : h).replace(/^﻿/, '').trim().toLowerCase().replace(/[\s\-.]+/g, '_'); }
  function clean(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 120); }

  /** RFC 4180 CSV → rows (array of arrays). Quotes, doubled quotes, CRLF, a trailing newline. */
  function parseCsv(text) {
    var s = String(text == null ? '' : text).replace(/^﻿/, '');
    var rows = [], row = [], field = '', q = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
    return rows;
  }

  /** header row → { field: index }, plus the columns ignored and the personal ones never read. */
  function mapColumns(header) {
    var map = {}, ignored = [], personal = [];
    (header || []).forEach(function (h, i) {
      var n = normHeader(h);
      if (!n) return;
      if (PERSONAL.test(n) && !/^(address|street_address|full_address|site_address|property_address)$/.test(n)) { personal.push(String(h)); return; }
      var hit = null;
      Object.keys(ALIASES).forEach(function (f) { if (!hit && ALIASES[f].indexOf(n) !== -1 && map[f] == null) hit = f; });
      if (hit) map[hit] = i; else ignored.push(String(h));
    });
    return { map: map, ignored: ignored, personal: personal };
  }

  function num(v) {
    if (v == null) return NaN;
    var t = String(v).trim();
    if (!t) return NaN;
    var n = Number(t);
    return isFinite(n) ? n : NaN;
  }
  function year(v) {
    var m = /(\d{4})/.exec(String(v == null ? '' : v));
    var y = m ? Number(m[1]) : NaN;
    return y >= 1800 && y <= 2100 ? y : null;
  }

  /**
   * CSV text → { doors, notes, skipped, ignored, personal, total, error }.
   * nowYear: for the age when only a year built / permit year is given.
   */
  function planImport(text, nowYear) {
    var yr = Number(nowYear) || new Date().getFullYear();
    if (String(text || '').length > MAX_BYTES) return { error: 'That file is over 2 MB. Split it into smaller lists.' };
    var rows = parseCsv(text);
    if (rows.length < 2) return { error: 'No rows found. The first line must be the column names (address, city, zip, lat, lng, ...).' };
    var cols = mapColumns(rows[0]);
    var m = cols.map;
    if (m.address == null) return { error: 'No address column. Name one column "address".' };
    var doors = [], skipped = { no_address: 0, bad_location: 0, over_cap: 0, duplicate: 0 }, seen = {}, notes = {};
    var cell = function (r, f) { return m[f] == null ? '' : r[m[f]]; };
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var addr = clean(cell(r, 'address'), 120);
      if (!addr) { skipped.no_address++; continue; }
      var city = clean(cell(r, 'city'), 60), st = clean(cell(r, 'state'), 2).toUpperCase(), zip = clean(cell(r, 'zip'), 10).replace(/[^\d-]/g, '').slice(0, 10);
      var la = num(cell(r, 'lat')), ln = num(cell(r, 'lng'));
      var hasLoc = isFinite(la) && isFinite(ln);
      if (hasLoc && (la < -90 || la > 90 || ln < -180 || ln > 180 || (la === 0 && ln === 0))) { skipped.bad_location++; continue; }
      var key = (addr + '|' + zip).toLowerCase();
      if (seen[key]) { skipped.duplicate++; continue; }
      seen[key] = 1;
      if (doors.length >= MAX_DOORS) { skipped.over_cap++; continue; }
      var y = year(cell(r, 'yearBuilt')), rp = year(cell(r, 'roofPermit'));
      var ag = num(cell(r, 'roofAge'));
      var basis = clean(cell(r, 'basis'), 20).toLowerCase();
      if (!isFinite(ag)) {
        if (rp) { ag = yr - rp; basis = 'roof_permit'; }
        else if (y) { ag = yr - y; basis = 'year_built'; }
      }
      if (!/^(year_built|roof_permit|unknown)$/.test(basis)) basis = isFinite(ag) ? (rp ? 'roof_permit' : y ? 'year_built' : 'unknown') : 'unknown';
      var full = addr + (city && addr.toLowerCase().indexOf(city.toLowerCase()) === -1 ? ', ' + city : '') + (st && !new RegExp('\\b' + st + '\\b', 'i').test(addr) ? ', ' + st : '') + (zip && addr.indexOf(zip) === -1 ? ' ' + zip : '');
      var d = { a: clean(full, 160), la: hasLoc ? Math.round(la * 1e6) / 1e6 : null, ln: hasLoc ? Math.round(ln * 1e6) / 1e6 : null, z: zip, t: city,
        y: y, r: rp, ag: isFinite(ag) && ag >= 0 && ag < 300 ? Math.round(ag) : null, b: basis,
        rt: clean(cell(r, 'route'), 20) || '', s: isFinite(num(cell(r, 'stop'))) ? Math.max(0, Math.floor(num(cell(r, 'stop')))) : null };
      doors.push(d);
      var nt = clean(cell(r, 'note'), 400);
      if (nt && city && !notes[city] && Object.keys(notes).length < MAX_NOTES) notes[city] = nt;
    }
    if (!doors.length) return { error: 'No usable doors in that file.', skipped: skipped };
    // No route column: one route, oldest roof first. With one: keep its order.
    var anyRoute = doors.some(function (d) { return d.rt; });
    if (!anyRoute) {
      doors.sort(function (a, b) { return (b.ag == null ? -1 : b.ag) - (a.ag == null ? -1 : a.ag); });
      doors.forEach(function (d, i) { d.rt = 'R1'; d.s = i + 1; });
    } else {
      doors.forEach(function (d, i) { if (!d.rt) d.rt = 'R?'; if (d.s == null) d.s = i + 1; });
    }
    return {
      doors: doors, total: rows.length - 1, skipped: skipped, ignored: cols.ignored, personal: cols.personal,
      notes: Object.keys(notes).map(function (t) { return { town: t, note: notes[t] }; }),
    };
  }

  /** The Firestore doc for a plan. Only the allowed keys; the caller adds createdAt. */
  function listDoc(plan, o) {
    var x = o || {};
    return {
      userId: String(x.userId || ''), companyId: String(x.companyId || ''), assignedTo: x.assignedTo ? String(x.assignedTo) : null,
      name: clean(x.name || 'Door list', 80), source: clean(x.source || 'CSV import', 120),
      rowCount: plan.doors.length, doors: plan.doors.map(function (d) { var o2 = {}; DOOR_KEYS.forEach(function (k) { o2[k] = d[k] == null ? null : d[k]; }); return o2; }),
      notes: (plan.notes || []).slice(0, MAX_NOTES),
    };
  }

  /** Doors grouped by route, in stop order. Pure. */
  function routesOf(list) {
    var by = {};
    ((list && list.doors) || []).forEach(function (d) { (by[d.rt || 'R1'] = by[d.rt || 'R1'] || []).push(d); });
    return Object.keys(by).sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); }).map(function (k) {
      return { route: k, doors: by[k].slice().sort(function (a, b) { return (a.s || 0) - (b.s || 0); }) };
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function ageLabel(d) {
    if (d.ag == null) return 'roof age unknown';
    return '~' + d.ag + ' yr roof' + (d.b === 'roof_permit' ? ' (last roof permit ' + (d.r || '') + ')' : d.b === 'year_built' ? ' (built ' + (d.y || '') + ')' : '');
  }
  /** The args a stop hands openQuickKnock (escaped for a double-quoted attribute). */
  function knockArgs(d) {
    var a = { address: d.a };
    if (d.la != null && d.ln != null) { a.lat = d.la; a.lng = d.ln; }
    return esc(JSON.stringify(a));
  }

  /** The Routes tab section. knockedKeys: normalized addresses already knocked. Pure. */
  function sectionHtml(lists, shownId, knockedKeys) {
    var known = knockedKeys || {};
    var h = '<div class="d2d-doorlists" data-d2d-doorlists><div class="d2d-section-title">🚪 Door lists</div>' +
      '<p class="d2d-doorlist-help">Import a CSV of addresses (an aging-roof list or any spreadsheet). Doors and mail only: phone, email and owner columns are never read.</p>' +
      '<div class="d2d-route-actions"><button type="button" class="d2d-action-btn dk-grow dk-bg-blue" data-d2d-action="importDoors">📤 Import doors (CSV)</button></div>';
    if (!lists || !lists.length) return h + '<div class="nbd-empty dk-empty-sm"><div class="ne-sub">No door lists yet.</div></div></div>';
    lists.forEach(function (l) {
      var on = l.id === shownId;
      var rts = routesOf(l);
      var knocked = (l.doors || []).filter(function (d) { return known[String(d.a || '').toLowerCase().trim().replace(/\s+/g, ' ')]; }).length;
      h += '<div class="d2d-doorlist' + (on ? ' is-on' : '') + '">' +
        '<div class="d2d-doorlist-head"><div class="d2d-doorlist-name">' + esc(l.name) + '</div>' +
        '<div class="d2d-doorlist-stat">' + esc((l.doors || []).length + ' doors · ' + rts.length + (rts.length === 1 ? ' route' : ' routes') + ' · ' + knocked + ' knocked') + '</div></div>' +
        '<div class="d2d-route-actions">' +
        (on ? '<button type="button" class="d2d-action-btn dk-bg-plain" data-d2d-action="hideDoorList">Hide on map</button>'
          : '<button type="button" class="d2d-action-btn dk-bg-green" data-d2d-action="showDoorList" data-d2d-id="' + esc(l.id) + '">Show on map</button>') +
        (l.mine ? '<button type="button" class="d2d-action-btn dk-bg-plain" data-d2d-action="deleteDoorList" data-d2d-id="' + esc(l.id) + '">Delete</button>' : '') +
        '</div>';
      if (l.notes && l.notes.length) {
        h += '<ul class="d2d-doorlist-notes">' + l.notes.map(function (n) { return '<li><strong>' + esc(n.town) + ':</strong> ' + esc(n.note) + '</li>'; }).join('') + '</ul>';
      }
      if (on) {
        rts.forEach(function (rt) {
          h += '<div class="d2d-section-title">' + esc('Route ' + rt.route + ' (' + rt.doors.length + ' stops)') + '</div><div class="d2d-route-list">' +
            rt.doors.slice(0, 120).map(function (d, i) {
              var done = !!known[String(d.a || '').toLowerCase().trim().replace(/\s+/g, ' ')];
              return '<div class="d2d-route-stop' + (done ? ' is-done' : '') + '" role="button" tabindex="0" data-d2d-action="openQuickKnock" data-d2d-args="' + knockArgs(d) + '">' +
                '<div class="d2d-route-num">' + (d.s || i + 1) + '</div><div class="d2d-route-addr">' + esc(d.a) +
                '<div class="d2d-doorlist-age">' + esc(ageLabel(d)) + (done ? ' · knocked' : '') + '</div></div></div>';
            }).join('') + (rt.doors.length > 120 ? '<div class="ne-sub">' + esc('+' + (rt.doors.length - 120) + ' more on the map') + '</div>' : '') + '</div>';
        });
      }
      h += '</div>';
    });
    return h + '</div>';
  }

  // ── browser ─────────────────────────────────────────────────────────────
  var S = { lists: [], shownId: null, layer: null, loaded: false };
  function W() { return root; }
  function toast(m, k) { if (root && typeof root.showToast === 'function') root.showToast(m, k || 'info'); }
  function uid() { return root && root._user && root._user.uid; }
  function companyId() {
    var st = root && root._D2DState;
    return (st && st.currentRep && st.currentRep.companyId) || (root._userClaims && root._userClaims.companyId) || uid();
  }
  function rerender() { var st = root && root._D2DState; if (st && typeof st.renderD2D === 'function') st.renderD2D(); }

  function load() {
    var w = W();
    if (!w || !(w._db || w.db) || typeof w.getDocs !== 'function' || !uid()) return Promise.resolve([]);
    var col = w.collection(w._db || w.db, 'd2d_doorlists');
    var mine = w.query(col, w.where('userId', '==', uid()));
    var assigned = w.query(col, w.where('assignedTo', '==', uid()), w.where('companyId', '==', companyId()));
    var read = function (q) { return Promise.resolve(w.getDocs(q)).then(function (s) { var o = []; s.forEach(function (d) { o.push(Object.assign({ id: d.id }, d.data())); }); return o; }, function () { return []; }); };
    return Promise.all([read(mine), read(assigned)]).then(function (r) {
      var by = {};
      r[0].concat(r[1]).forEach(function (l) { by[l.id] = Object.assign(l, { mine: l.userId === uid() }); });
      S.lists = Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return String(b.name).localeCompare(String(a.name)); });
      rerender();
      return S.lists;
    });
  }

  function pickFile() {
    if (root.NBDRole && typeof root.NBDRole.guard === 'function' && root.NBDRole.guard() === false) return;
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.csv,text/csv';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > MAX_BYTES) { toast('That file is over 2 MB. Split it into smaller lists.', 'error'); return; }
      var rd = new FileReader();
      rd.onload = function () { importText(String(rd.result || ''), f.name); };
      rd.onerror = function () { toast('That file could not be read.', 'error'); };
      rd.readAsText(f);
    });
    inp.click();
  }

  function importText(text, fileName) {
    var plan = planImport(text, new Date().getFullYear());
    if (plan.error) { toast(plan.error, 'error'); return Promise.resolve(null); }
    var st = root._D2DState || {};
    var msg = plan.doors.length + ' doors in ' + routesOf({ doors: plan.doors }).length + ' route(s) from ' + fileName + '.' +
      (plan.personal.length ? ' Not read (people / contact columns): ' + plan.personal.join(', ') + '.' : '') +
      (plan.skipped.duplicate + plan.skipped.no_address + plan.skipped.bad_location + plan.skipped.over_cap ? ' Skipped: ' +
        Object.keys(plan.skipped).filter(function (k) { return plan.skipped[k]; }).map(function (k) { return plan.skipped[k] + ' ' + k.replace(/_/g, ' '); }).join(', ') + '.' : '') +
      ' Import this door list?';
    var ask = typeof st.uiConfirm === 'function' ? st.uiConfirm(msg, { okLabel: 'Import' }) : (typeof window.nbdConfirm === 'function' ? window.nbdConfirm(msg) : Promise.resolve(window.confirm(msg)));
    return Promise.resolve(ask).then(function (yes) {
      if (!yes) return null;
      var w = W();
      var doc = listDoc(plan, { userId: uid(), companyId: companyId(), name: String(fileName || 'Door list').replace(/\.csv$/i, ''), source: 'CSV import' });
      doc.createdAt = w.serverTimestamp();
      return Promise.resolve(w.addDoc(w.collection(w._db || w.db, 'd2d_doorlists'), doc)).then(function (ref) {
        toast('Door list imported: ' + plan.doors.length + ' doors.', 'success');
        S.shownId = ref && ref.id;
        return load().then(function () { draw(); return ref && ref.id; });
      }, function (e) {
        toast(/permission/i.test(String(e && (e.code || e.message))) ? 'Your role cannot import door lists.' : 'The door list could not be saved. Try again.', 'error');
        return null;
      });
    });
  }

  function draw() {
    var st = root._D2DState || {};
    var map = st.d2dMap, L = root.L;
    if (S.layer && map) { try { map.removeLayer(S.layer); } catch (e) { /* gone */ } }
    S.layer = null;
    var list = S.lists.filter(function (l) { return l.id === S.shownId; })[0];
    if (!list || !map || !L) return;
    var g = L.layerGroup();
    var pts = [];
    (list.doors || []).forEach(function (d) {
      if (d.la == null || d.ln == null) return;
      var old = d.ag != null && d.ag >= 25, mid = d.ag != null && d.ag >= 15;
      var m = L.circleMarker([d.la, d.ln], { radius: 6, weight: 2, color: old ? '#BD5728' : mid ? '#d97706' : '#64748b', fillOpacity: 0.35, className: 'd2d-door-marker' });
      m.bindPopup('<div class="d2d-door-pop"><strong>' + esc(d.a) + '</strong><br>' + esc(ageLabel(d)) + '<br>' + esc('Route ' + d.rt + ' · stop ' + d.s) +
        '<br><button type="button" class="d2d-action-btn dk-bg-orange" data-d2d-action="openQuickKnock" data-d2d-args="' + knockArgs(d) + '">🚪 Knock here</button></div>');
      g.addLayer(m);
      pts.push([d.la, d.ln]);
    });
    g.addTo(map);
    S.layer = g;
    if (pts.length && typeof map.fitBounds === 'function') { try { map.fitBounds(pts, { padding: [24, 24], maxZoom: 17 }); } catch (e) { /* ignore */ } }
  }

  function show(id) { S.shownId = String(id || ''); draw(); rerender(); }
  function hide() { S.shownId = null; draw(); rerender(); }
  function remove(id) {
    var st = root._D2DState || {};
    var ask = typeof st.uiConfirm === 'function' ? st.uiConfirm('Delete this door list? Knocks you logged stay.', { okLabel: 'Delete', danger: true }) : Promise.resolve(true);
    return Promise.resolve(ask).then(function (yes) {
      if (!yes) return false;
      var w = W();
      return Promise.resolve(w.deleteDoc(w.doc(w._db || w.db, 'd2d_doorlists', String(id)))).then(function () {
        if (S.shownId === id) S.shownId = null;
        draw();
        return load().then(function () { toast('Door list deleted.', 'success'); return true; });
      }, function () { toast('The door list could not be deleted.', 'error'); return false; });
    });
  }
  function html() {
    if (!S.loaded) { S.loaded = true; load(); }   // first paint of the Routes tab reads the lists once
    var st = root._D2DState || {};
    var known = {};
    (st.knocks || []).forEach(function (k) { var a = String((k && k.address) || '').toLowerCase().trim().replace(/\s+/g, ' '); if (a) known[a] = 1; });
    return sectionHtml(S.lists, S.shownId, known);
  }

  var api = {
    MAX_DOORS: MAX_DOORS, DOOR_KEYS: DOOR_KEYS, LIST_KEYS: LIST_KEYS,
    parseCsv: parseCsv, mapColumns: mapColumns, planImport: planImport, listDoc: listDoc, routesOf: routesOf, sectionHtml: sectionHtml,
    load: load, pickFile: pickFile, importText: importText, show: show, hide: hide, remove: remove, html: html, draw: draw,
  };
  if (root) root.NBDDoorImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
