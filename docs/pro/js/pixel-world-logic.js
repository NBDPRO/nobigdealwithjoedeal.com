/**
 * pixel-world-logic.js — pure rules for Pixel World, the walkable town
 * (2026-10-11, CRM style roadmap slice E2). No DOM, no canvas, no network:
 * movement and collision, where townspeople stand, what "!" means, the day
 * and night tint, the Lead Dex, area gates. require()d by tests; the browser
 * half is pixel-world.js (window.NBDPixelWorldLogic).
 *
 * Town art is original and drawn in pixel-world.js from small string
 * patterns. Nothing here names, copies or imitates a third-party game.
 *
 * Every number the player sees is a CRM fact computed by pixel-logic.js
 * (HP = days before a lead goes cold, "!" = the lead's own follow-up date is
 * past). This file only decides WHERE things are and what can be walked on.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pixel-logic.js'));
  else root.NBDPixelWorldLogic = factory(root.NBDPixelLogic);
})(typeof self !== 'undefined' ? self : this, function (PL) {
  'use strict';

  var TILE = 16;
  var W = 40, H = 24;

  // Tile ids.
  var T = { GRASS: 0, GRASS2: 1, FLOWER: 2, PATH: 3, TREE: 4, WATER: 5, BUILD: 6, DOOR: 7 };
  var SOLID = {}; SOLID[T.TREE] = 1; SOLID[T.WATER] = 1; SOLID[T.BUILD] = 1;

  // Areas. `door` is derived; `panel` names what the area opens.
  var BUILDINGS = [
    { id: 'leads',    name: 'LEADS HALL',        x: 4,  y: 3,  w: 7, h: 5, palette: 'blue'   },
    { id: 'workshop', name: 'ESTIMATE WORKSHOP', x: 16, y: 3,  w: 7, h: 5, palette: 'orange' },
    { id: 'tower',    name: 'STORM WATCH TOWER', x: 29, y: 2,  w: 5, h: 6, palette: 'slate'  },
    { id: 'bank',     name: 'BANK',              x: 4,  y: 14, w: 6, h: 5, palette: 'green'  },
    { id: 'trophy',   name: 'TROPHY HALL',       x: 22, y: 14, w: 7, h: 5, palette: 'gold'   },
    { id: 'office',   name: 'OFFICE',            x: 30, y: 14, w: 6, h: 5, palette: 'red'    },
  ];
  BUILDINGS.forEach(function (b) {
    b.door = { x: b.x + Math.floor(b.w / 2), y: b.y + b.h - 1 };
  });

  // Rooms behind a locked door open when the matching achievement theme is earned.
  var AREA_GATES = {
    vault:  { theme: 'gold-rush',    name: 'Gold Vault',   where: 'bank',  needs: 'Gold Rush' },
    summit: { theme: 'road-warrior', name: 'Summit Radar', where: 'tower', needs: 'Road Warrior' },
  };

  var START = { x: 20, y: 11 };

  function hash(str) {
    var h = 2166136261;
    var s = String(str);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // ── the map ────────────────────────────────────────────────────────────
  function makeWorld() {
    var tiles = new Uint8Array(W * H);
    var x, y;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      var t = T.GRASS;
      if ((x * 7 + y * 13) % 5 === 0) t = T.GRASS2;
      if ((x * 11 + y * 5) % 17 === 3) t = T.FLOWER;
      tiles[y * W + x] = t;
    }
    function rect(x0, y0, x1, y1, t) {
      for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) tiles[yy * W + xx] = t;
    }
    // roads: upper, lower, and the connector down the middle
    rect(2, 9, 37, 10, T.PATH);
    rect(2, 20, 37, 21, T.PATH);
    rect(19, 9, 20, 21, T.PATH);
    // pond in the west plaza
    rect(3, 11, 6, 13, T.WATER);
    // trees: the border, plus a hashed scatter that never touches a road/door/building
    for (x = 0; x < W; x++) { tiles[x] = T.TREE; tiles[(H - 1) * W + x] = T.TREE; tiles[W + x] = T.TREE; }
    for (y = 0; y < H; y++) { tiles[y * W] = T.TREE; tiles[y * W + W - 1] = T.TREE; }
    for (y = 3; y < H - 2; y++) for (x = 2; x < W - 2; x++) {
      if (tiles[y * W + x] !== T.GRASS && tiles[y * W + x] !== T.GRASS2) continue;
      if (hash(x + ':' + y) % 23 === 0) tiles[y * W + x] = T.TREE;
    }
    // buildings (stamped last so trees never poke through): footprint solid, door walkable,
    // one path tile from the door to the road.
    BUILDINGS.forEach(function (b) {
      // keep a clear apron around each footprint (trees removed)
      rect(Math.max(1, b.x - 1), Math.max(2, b.y - 1), Math.min(W - 2, b.x + b.w), Math.min(H - 2, b.y + b.h), T.GRASS);
      rect(b.x, b.y, b.x + b.w - 1, b.y + b.h - 1, T.BUILD);
      tiles[b.door.y * W + b.door.x] = T.DOOR;
      var downToRoad = b.y < 10;
      if (downToRoad) rect(b.door.x, b.door.y + 1, b.door.x, 8, T.PATH);
      else rect(b.door.x, b.door.y + 1, b.door.x, 19, T.PATH);
    });
    // Start area is always open.
    rect(START.x - 1, START.y, START.x + 1, START.y, T.PATH);
    return { w: W, h: H, tile: TILE, tiles: tiles, buildings: BUILDINGS, start: { x: START.x, y: START.y } };
  }

  function inBounds(world, x, y) { return x >= 0 && y >= 0 && x < world.w && y < world.h; }
  function tileAt(world, x, y) { return inBounds(world, x, y) ? world.tiles[y * world.w + x] : T.TREE; }
  function walkable(world, x, y) { return inBounds(world, x, y) && !SOLID[tileAt(world, x, y)]; }

  var DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  /** Where one step in `dir` would land (no collision test). */
  function stepFrom(pos, dir) {
    var d = DIRS[dir];
    return d ? { x: pos.x + d[0], y: pos.y + d[1] } : { x: pos.x, y: pos.y };
  }
  /**
   * One tile of movement. `blocked` is a Set of "x,y" keys for people standing
   * there. Facing always updates, even when the step is refused.
   */
  function tryMove(world, pos, dir, blocked) {
    var n = stepFrom(pos, dir);
    var key = n.x + ',' + n.y;
    var ok = !!DIRS[dir] && walkable(world, n.x, n.y) && !(blocked && blocked.has(key));
    return { x: ok ? n.x : pos.x, y: ok ? n.y : pos.y, moved: ok, facing: DIRS[dir] ? dir : 'down' };
  }

  function buildingAtDoor(world, x, y) {
    for (var i = 0; i < world.buildings.length; i++) {
      var b = world.buildings[i];
      if (b.door.x === x && b.door.y === y) return b;
    }
    return null;
  }

  /** Camera top-left in world pixels, clamped to the map. */
  function cameraFor(px, py, viewW, viewH, world) {
    var mw = world.w * world.tile, mh = world.h * world.tile;
    var cx = px * world.tile + world.tile / 2 - viewW / 2;
    var cy = py * world.tile + world.tile / 2 - viewH / 2;
    // A view bigger than the map centres it instead of pinning it top-left.
    return {
      x: mw <= viewW ? -Math.round((viewW - mw) / 2) : Math.round(Math.max(0, Math.min(mw - viewW, cx))),
      y: mh <= viewH ? -Math.round((viewH - mh) / 2) : Math.round(Math.max(0, Math.min(mh - viewH, cy))),
    };
  }

  // ── townspeople ────────────────────────────────────────────────────────
  /** Walkable plaza tiles people may stand on (never a door, never the start tile). */
  function plazaTiles(world) {
    var out = [];
    for (var y = 2; y < world.h - 1; y++) for (var x = 1; x < world.w - 1; x++) {
      var t = tileAt(world, x, y);
      if (t === T.DOOR || SOLID[t]) continue;
      if (x === world.start.x && y === world.start.y) continue;
      // keep people out of the one-tile door lanes so doors stay reachable
      if (t === T.PATH && (y === 8 || y === 19)) continue;
      out.push({ x: x, y: y });
    }
    return out;
  }

  /**
   * Deterministic placement: the same lead lands on the same tile every visit
   * (hash of its id), and no two people share a tile. `members` come from
   * NBDPixelLogic.partyOf, already ordered most-at-risk first.
   */
  function placePeople(world, members, cap) {
    var spots = plazaTiles(world);
    var taken = new Set();
    var out = [];
    var n = Math.min(members.length, cap > 0 ? cap : 40);
    for (var i = 0; i < n; i++) {
      var m = members[i];
      var start = hash(m.id) % spots.length;
      for (var k = 0; k < spots.length; k++) {
        var s = spots[(start + k) % spots.length];
        var key = s.x + ',' + s.y;
        if (taken.has(key)) continue;
        taken.add(key);
        out.push({ id: m.id, member: m, x: s.x, y: s.y, homeX: s.x, homeY: s.y, facing: 'down', hue: hash(m.id + 'hue') % 360 });
        break;
      }
    }
    return out;
  }

  /** Which way a wandering person may step: stays within 3 tiles of home. */
  function wanderStep(world, person, rng, blocked) {
    var order = ['up', 'down', 'left', 'right'];
    var dir = order[Math.floor(rng() * order.length)];
    var n = stepFrom(person, dir);
    if (Math.abs(n.x - person.homeX) > 3 || Math.abs(n.y - person.homeY) > 3) return null;
    if (!walkable(world, n.x, n.y)) return null;
    if (tileAt(world, n.x, n.y) === T.DOOR) return null;
    if (blocked && blocked.has(n.x + ',' + n.y)) return null;
    return { x: n.x, y: n.y, facing: dir };
  }

  /** The person (if any) standing on the tile the player faces. */
  function personFacing(people, pos, facing) {
    var t = stepFrom(pos, facing);
    for (var i = 0; i < people.length; i++) if (people[i].x === t.x && people[i].y === t.y) return people[i];
    return null;
  }

  // ── status marks ───────────────────────────────────────────────────────
  /** "!" over anyone whose own follow-up date is past; HP tier colour name. */
  function markFor(member) {
    return {
      bang: member.overdue > 0,
      tier: member.tier,
      hailPct: member.hailPct == null ? null : member.hailPct,
    };
  }

  /**
   * Adds hailPct to members whose coordinates fall inside an SPC hail-risk
   * polygon. `summarize(lat, lng)` is StormOutlook.summarizeAt (or a stub).
   * Members without coordinates are never flagged.
   */
  function flagHail(members, summarize) {
    var flagged = 0;
    members.forEach(function (m) {
      m.hailPct = null;
      if (typeof summarize !== 'function' || m.lat == null || m.lng == null) return;
      var r = null;
      try { r = summarize(m.lat, m.lng); } catch (e) { r = null; }
      if (r && r.hailPct != null && r.hailPct > 0) { m.hailPct = r.hailPct; flagged++; }
    });
    return flagged;
  }

  // ── day and night ──────────────────────────────────────────────────────
  var KEYS = [
    { h: 0,  c: [10, 20, 70],   a: 0.5 },
    { h: 5,  c: [10, 20, 70],   a: 0.5 },
    { h: 6.5, c: [255, 160, 90], a: 0.2 },
    { h: 8,  c: [255, 255, 255], a: 0 },
    { h: 17, c: [255, 255, 255], a: 0 },
    { h: 18.5, c: [255, 110, 60], a: 0.24 },
    { h: 20.5, c: [10, 20, 70],  a: 0.5 },
    { h: 24, c: [10, 20, 70],   a: 0.5 },
  ];
  /** Tint for a local hour (0–24, fractional). Returns { r, g, b, a, name }. */
  function dayTint(hour) {
    var h = ((Number(hour) % 24) + 24) % 24;
    for (var i = 0; i < KEYS.length - 1; i++) {
      var a = KEYS[i], b = KEYS[i + 1];
      if (h >= a.h && h <= b.h) {
        var t = b.h === a.h ? 0 : (h - a.h) / (b.h - a.h);
        var mix = function (p, q) { return Math.round(p + (q - p) * t); };
        var alpha = a.a + (b.a - a.a) * t;
        return {
          r: mix(a.c[0], b.c[0]), g: mix(a.c[1], b.c[1]), b: mix(a.c[2], b.c[2]),
          a: Math.round(alpha * 1000) / 1000,
          name: alpha < 0.02 ? 'DAY' : (h < 12 ? (h < 5 ? 'NIGHT' : 'DAWN') : (h < 20.5 ? 'DUSK' : 'NIGHT')),
        };
      }
    }
    return { r: 10, g: 20, b: 70, a: 0.5, name: 'NIGHT' };
  }

  // ── Lead Dex ───────────────────────────────────────────────────────────
  var DEX_SEEN_CAP = 400;
  /**
   * Every lead gets a number (oldest first). "caught" = a signed (won) lead,
   * "seen" = the player has talked to them, otherwise "unknown" (name hidden).
   */
  function dexEntries(leads, seenIds, env) {
    var seen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
    var rows = [];
    (leads || []).forEach(function (l) {
      if (!l || !l.id || l.deleted === true) return;
      var sk = l._stageKey || (env && typeof env.normalizeStage === 'function' ? env.normalizeStage(l.stage) : l.stage) || 'new';
      var role = l._stageRole || (env && typeof env.stageRole === 'function' ? env.stageRole(sk) : null);
      rows.push({
        id: l.id, created: PL.toMs(l.createdAt) || 0, stage: sk,
        name: PL.nameOf(l),
        state: role === 'won' ? 'caught' : (seen.has(l.id) ? 'seen' : 'unknown'),
      });
    });
    rows.sort(function (a, b) { return (a.created - b.created) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    rows.forEach(function (r, i) { r.no = i + 1; if (r.state === 'unknown') r.name = '???'; });
    return rows;
  }
  /** Add an id to the seen list, newest last, capped. Returns the same array if unchanged. */
  function markSeen(list, id) {
    var arr = Array.isArray(list) ? list : [];
    if (!id || arr.indexOf(id) >= 0) return arr;
    var next = arr.concat([String(id)]);
    return next.length > DEX_SEEN_CAP ? next.slice(next.length - DEX_SEEN_CAP) : next;
  }

  // ── gates + access ─────────────────────────────────────────────────────
  function gateOpen(gateId, isUnlocked) {
    var g = AREA_GATES[gateId];
    if (!g) return false;
    try { return typeof isUnlocked === 'function' && !!isUnlocked(g.theme); } catch (e) { return false; }
  }

  /**
   * Is Pixel World on for this person? Default OFF. On when the company
   * turned it on (companyProfile/{id}.pixelWorld.enabled) or the person opted
   * in on their own settings. Anything that is not literally true is off.
   */
  function worldEnabled(userSettings, companyFlag) {
    var u = userSettings && userSettings.pixelWorld;
    var user = !!(u && u.enabled === true);
    var co = !!(companyFlag && companyFlag.enabled === true);
    return user || co;
  }
  /** Only the owner (company id == uid) or a company_admin sets the company switch. */
  function canSetCompanyFlag(claims, uid) {
    var c = claims || {};
    var role = c.role || '';
    if (role === 'viewer') return false;
    if (role === 'company_admin' || role === 'admin') return true;
    return !!uid && (!c.companyId || c.companyId === uid) && role !== 'manager';
  }

  // ── stage moves (E2b) ──────────────────────────────────────────────────
  /**
   * Same rule as the kanban's ◀ ▶ arrows (crm-pipeline.js): previous = the key
   * before the current one; next = the next key that is not a lost stage
   * (losing a lead is its own action, never "progress"). Unknown current
   * stage = no moves.
   */
  function adjacentStages(stageKeys, current, roleOf) {
    var keys = Array.isArray(stageKeys) ? stageKeys : [];
    var i = keys.indexOf(current);
    if (i < 0) return { prev: null, next: null };
    var next = null;
    for (var j = i + 1; j < keys.length; j++) {
      var role = typeof roleOf === 'function' ? roleOf(keys[j]) : (keys[j] === 'lost' ? 'lost' : '');
      if (role !== 'lost') { next = keys[j]; break; }
    }
    var prev = i > 0 ? keys[i - 1] : null;
    if (prev !== null && typeof roleOf === 'function' && roleOf(prev) === 'lost') prev = null;
    return { prev: prev, next: next };
  }
  /** moveCard answers nothing useful, so success = the lead really changed stage. */
  function moveOutcome(targetKey, stageAfterKey) {
    return targetKey && stageAfterKey === targetKey ? 'moved' : 'refused';
  }

  // ── E2c: DRAFT TEXT ────────────────────────────────────────────────────
  // The SERVER owns the wording (functions/pixel-draft-logic.js). The game only
  // knows the template KEYS and the button labels; the callable
  // fileLeadTextDraft takes a key, never words. tests pin the keys to the server's.
  var DRAFT_TEMPLATES = [
    { key: 'followup', label: 'FOLLOW UP' },
    { key: 'estimate_check_in', label: 'ESTIMATE CHECK-IN' },
    { key: 'appointment_reminder', label: 'APPOINTMENT REMINDER' },
    { key: 'thanks_after_job', label: 'THANKS AFTER JOB' },
  ];
  /**
   * What the dialog says once fileLeadTextDraft answers (res) or fails (err).
   * Honest by construction: every branch says nothing was texted, and none
   * says "sent". status: 'filed' | 'already' | 'refused' | 'error'.
   */
  function draftOutcome(res, err) {
    var tail = ' Nothing was texted.';
    if (err) {
      var code = String((err && err.code) || '').replace(/^functions\//, '');
      if (code === 'permission-denied') return { status: 'refused', lines: ['NOT ALLOWED.', 'Your role cannot draft texts.' + tail] };
      if (code === 'resource-exhausted') return { status: 'refused', lines: ['NOT ALLOWED.', 'Too many drafts this hour. Try again later.' + tail] };
      return { status: 'error', lines: ['COULD NOT FILE.', 'Check your connection and try again.' + tail] };
    }
    var s = res && res.status;
    if (s === 'filed') return { status: 'filed', lines: ['DRAFT FILED.', 'It waits in the Agent inbox for the owner or an admin to send.' + tail] };
    if (s === 'already_filed') return { status: 'already', lines: ['ALREADY FILED.', 'Today\'s draft is already in the Agent inbox. Nothing new was filed.' + tail] };
    if (s === 'not_allowed') {
      var why = String((res && res.message) || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      return { status: 'refused', lines: ['NOT ALLOWED.', (why || 'This customer cannot be texted.') + tail] };
    }
    return { status: 'error', lines: ['COULD NOT FILE.', 'The answer did not make sense.' + tail] };
  }

  // ── dialog text ────────────────────────────────────────────────────────
  /** Lines a townsperson says. Facts only; no promises, no claim talk. */
  function talkLines(m, stageText) {
    var lines = [];
    lines.push(m.name + ' - ' + (stageText || m.stage) + '.');
    if (m.days == null) lines.push('No touch on record yet.');
    else if (m.days === 0) lines.push('You touched this lead today.');
    else lines.push(m.days + ' day' + (m.days === 1 ? '' : 's') + ' since the last touch. HP ' + m.pct + '/100.');
    if (m.overdue > 0) lines.push('Follow-up was due ' + m.overdue + ' day' + (m.overdue === 1 ? '' : 's') + ' ago.');
    if (m.hailPct != null) lines.push('In today\'s ' + m.hailPct + '% hail-risk area (SPC outlook).');
    return lines;
  }

  return {
    TILE: TILE, W: W, H: H, T: T, SOLID: SOLID, BUILDINGS: BUILDINGS, AREA_GATES: AREA_GATES, START: START,
    DEX_SEEN_CAP: DEX_SEEN_CAP,
    hash: hash, makeWorld: makeWorld, inBounds: inBounds, tileAt: tileAt, walkable: walkable,
    stepFrom: stepFrom, tryMove: tryMove, buildingAtDoor: buildingAtDoor, cameraFor: cameraFor,
    plazaTiles: plazaTiles, placePeople: placePeople, wanderStep: wanderStep, personFacing: personFacing,
    markFor: markFor, flagHail: flagHail, dayTint: dayTint, dexEntries: dexEntries, markSeen: markSeen,
    adjacentStages: adjacentStages, moveOutcome: moveOutcome, DRAFT_TEMPLATES: DRAFT_TEMPLATES, draftOutcome: draftOutcome,
    gateOpen: gateOpen, worldEnabled: worldEnabled, canSetCompanyFlag: canSetCompanyFlag, talkLines: talkLines,
  };
});
