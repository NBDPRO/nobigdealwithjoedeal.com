/**
 * pixel-logic.js — pure decisions for Pixel Mode and Pixel World (2026-10-11).
 *
 * Nothing here touches the DOM, Firestore or the network, so it can be
 * require()d by tests (window.NBDPixelLogic in the browser). Both the skin
 * (pixel-mode.js) and the town (pixel-world.js) read the CRM through these
 * functions, so "HP", "overdue" and "open lead" mean ONE thing everywhere.
 *
 * Game words map to real CRM facts, never invented ones:
 *   HP        days since the lead was last touched, against COLD_DAYS
 *   "!"       the lead's own followUp date is before today
 *   Party     the open leads most likely to go cold
 *   Level     1 + floor(sqrt(deals signed this month))
 *
 * Revenue stays "projected" wherever it is shown: this module never sums
 * collected money, only the lead's own jobValue as a pipeline figure.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NBDPixelLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;
  // A lead untouched this long is "cold": HP bar empty.
  var COLD_DAYS = 14;

  function toMs(t) {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return t;
    if (t instanceof Date) return t.getTime();
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.toDate === 'function') return t.toDate().getTime();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    var v = Date.parse(t);
    return isFinite(v) ? v : 0;
  }

  // ── settings ───────────────────────────────────────────────────────────
  // userSettings/{uid}.pixelMode. Booleans only; anything else is "off".
  function normalizeMode(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    return {
      skin: r.skin === true,
      scanlines: r.scanlines === true,
      dialog: r.dialog === true,
    };
  }
  function anyOn(cfg) { return !!(cfg && (cfg.skin || cfg.dialog)); }

  // ── leads ──────────────────────────────────────────────────────────────
  function stageKeyOf(lead, env) {
    if (lead._stageKey) return lead._stageKey;
    if (env && typeof env.normalizeStage === 'function') {
      try { return env.normalizeStage(lead.stage) || lead.stage || 'new'; } catch (e) { /* fall through */ }
    }
    return lead.stage || 'new';
  }

  /** Open = not deleted, not lost, not won/closed, not an in-production job. */
  function isOpenLead(lead, env) {
    if (!lead || !lead.id || lead.deleted === true) return false;
    var sk = stageKeyOf(lead, env);
    var role = lead._stageRole || (env && typeof env.stageRole === 'function' ? env.stageRole(sk) : null) || 'active';
    if (role === 'won' || role === 'lost' || role === 'job') return false;
    var re = /^(closed|lost|complete|completed)$/i;
    if (re.test(String(sk)) || re.test(String(lead.stage || ''))) return false;
    return true;
  }

  function lastTouchMs(lead) {
    return Math.max(toMs(lead.updatedAt), toMs(lead.stageStartedAt), toMs(lead.lastContactedAt), toMs(lead.createdAt));
  }

  /** Whole days since the last touch, or null when the lead carries no timestamp. */
  function daysUntouched(lead, now) {
    var t = lastTouchMs(lead);
    if (!t) return null;
    var n = now == null ? Date.now() : now;
    return Math.max(0, Math.floor((n - t) / DAY));
  }

  /**
   * HP: 100 at a fresh touch, 0 at COLD_DAYS untouched.
   * tier: ok (>=60), warn (>=30), cold (<30), unknown (no timestamp).
   */
  function hpFor(lead, now) {
    var d = daysUntouched(lead, now);
    if (d == null) return { days: null, pct: null, tier: 'unknown' };
    var pct = Math.max(0, Math.min(100, Math.round((1 - d / COLD_DAYS) * 100)));
    return { days: d, pct: pct, tier: pct >= 60 ? 'ok' : pct >= 30 ? 'warn' : 'cold' };
  }

  function localMidnight(now) {
    var d = new Date(now == null ? Date.now() : now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** Days past the lead's followUp date ('YYYY-MM-DD', local). 0 = not overdue / no date. */
  function overdueDays(lead, now) {
    var f = String(lead && lead.followUp != null ? lead.followUp : '').trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(f);
    if (!m) return 0;
    var due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    var today = localMidnight(now);
    if (!(due < today)) return 0;
    return Math.round((today - due) / DAY);
  }

  function nameOf(lead) {
    var n = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || String(lead.name || '').trim();
    return n || String(lead.address || '').split(',')[0] || 'Customer';
  }
  function leadValue(lead) {
    var v = Number(lead && lead.jobValue);
    return isFinite(v) && v > 0 ? v : 0;
  }

  /** One lead as the game sees it. */
  function describe(lead, env, now) {
    var hp = hpFor(lead, now);
    return {
      id: lead.id,
      name: nameOf(lead),
      stage: stageKeyOf(lead, env),
      days: hp.days,
      pct: hp.pct,
      tier: hp.tier,
      overdue: overdueDays(lead, now),
      value: leadValue(lead),
      lat: isFinite(Number(lead.lat)) && lead.lat !== '' && lead.lat != null ? Number(lead.lat) : null,
      lng: isFinite(Number(lead.lng)) && lead.lng !== '' && lead.lng != null ? Number(lead.lng) : null,
    };
  }

  /** The party: open leads closest to going cold first (unknown HP last). */
  function partyOf(leads, env, now, limit) {
    var out = [];
    (leads || []).forEach(function (l) {
      if (!isOpenLead(l, env)) return;
      if (env && typeof env.visible === 'function' && !env.visible(l)) return;
      out.push(describe(l, env, now));
    });
    out.sort(function (a, b) {
      var ap = a.pct == null ? 1000 : a.pct, bp = b.pct == null ? 1000 : b.pct;
      if (ap !== bp) return ap - bp;
      return b.value - a.value;
    });
    return typeof limit === 'number' ? out.slice(0, limit) : out;
  }

  // ── trainer card ───────────────────────────────────────────────────────
  var THEME_BADGES = {
    'gold-rush': 'Gold Rush', 'road-warrior': 'Road Warrior', 'eternal-flame': 'Eternal Flame',
    'iron-door': 'Iron Door', 'night-owl': 'Night Owl', 'diamond': 'Diamond',
    'hologram': 'Hologram', 'completionist': 'Completionist', 'legend': 'Legend',
  };

  function sameMonth(ms, now) {
    if (!ms) return false;
    var a = new Date(ms), b = new Date(now == null ? Date.now() : now);
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  }

  /**
   * @param {Array} leads
   * @param {Object} env  { stageRole, normalizeStage, visible, isUnlocked(themeKey) }
   */
  function trainerCard(leads, env, now) {
    env = env || {};
    var open = 0, overdue = 0, signed = 0, hpSum = 0, hpN = 0, fullHp = 0, pipeline = 0;
    (leads || []).forEach(function (l) {
      if (!l || !l.id || l.deleted === true) return;
      if (typeof env.visible === 'function' && !env.visible(l)) return;
      var sk = stageKeyOf(l, env);
      var role = l._stageRole || (typeof env.stageRole === 'function' ? env.stageRole(sk) : null);
      if (role === 'won' && sameMonth(toMs(l.stageStartedAt) || toMs(l.updatedAt), now)) { signed++; return; }
      if (!isOpenLead(l, env)) return;
      open++;
      pipeline += leadValue(l);
      if (overdueDays(l, now) > 0) overdue++;
      var hp = hpFor(l, now);
      if (hp.pct != null) { hpSum += hp.pct; hpN++; if (hp.pct >= 75) fullHp++; }
    });
    var avgHp = hpN ? Math.round(hpSum / hpN) : null;
    var badges = [];
    if (open > 0 && overdue === 0) badges.push({ id: 'clean-slate', label: 'Clean Slate', hint: 'No overdue follow-ups' });
    if (hpN >= 3 && fullHp === hpN) badges.push({ id: 'full-hp', label: 'Full HP', hint: 'Every open lead touched recently' });
    if (signed >= 1) badges.push({ id: 'closer', label: 'Closer', hint: 'Signed a deal this month' });
    if (signed >= 5) badges.push({ id: 'rainmaker', label: 'Rainmaker', hint: 'Five signed this month' });
    Object.keys(THEME_BADGES).forEach(function (k) {
      if (typeof env.isUnlocked === 'function' && env.isUnlocked(k)) {
        badges.push({ id: 'theme-' + k, label: THEME_BADGES[k], hint: 'Achievement unlocked' });
      }
    });
    return {
      level: 1 + Math.floor(Math.sqrt(signed)),
      open: open, overdue: overdue, signed: signed, avgHp: avgHp, pipeline: pipeline,
      badges: badges,
    };
  }

  // ── sprites ────────────────────────────────────────────────────────────
  /**
   * CSS box-shadow sprite. `rows` is an array of equal-length strings, `palette`
   * maps a character to a colour ('.' and ' ' are transparent). The element
   * carrying the shadow is px×px and sits at the sprite's top-left cell.
   */
  function spriteBoxShadow(rows, palette, px) {
    var size = px > 0 ? px : 1;
    var parts = [];
    for (var y = 0; y < rows.length; y++) {
      var row = rows[y];
      for (var x = 0; x < row.length; x++) {
        var ch = row.charAt(x);
        if (ch === '.' || ch === ' ') continue;
        var colour = palette[ch];
        if (!colour) continue;
        parts.push((x * size) + 'px ' + (y * size) + 'px 0 0 ' + colour);
      }
    }
    return parts.join(',');
  }

  // Original house sprite, 11 x 10. r=roof, R=roof shade, w=wall, d=door, g=glass.
  var HOUSE_ROWS = [
    '.....r.....',
    '....rrr....',
    '...rrrrr...',
    '..rrrrrrr..',
    '.rrrrrrrrr.',
    'RRRRRRRRRRR',
    '.wwwwwwwww.',
    '.wggwwwggw.',
    '.wggwdwggw.',
    '.wwwwdwwww.',
  ];

  // ── typewriter ─────────────────────────────────────────────────────────
  function typewriterSlice(text, elapsedMs, cps) {
    var s = String(text == null ? '' : text);
    var n = Math.floor((elapsedMs > 0 ? elapsedMs : 0) * (cps > 0 ? cps : 40) / 1000);
    return n >= s.length ? s : s.slice(0, n);
  }

  return {
    COLD_DAYS: COLD_DAYS, DAY: DAY, THEME_BADGES: THEME_BADGES, HOUSE_ROWS: HOUSE_ROWS,
    toMs: toMs, normalizeMode: normalizeMode, anyOn: anyOn,
    isOpenLead: isOpenLead, lastTouchMs: lastTouchMs, daysUntouched: daysUntouched,
    hpFor: hpFor, overdueDays: overdueDays, nameOf: nameOf, valueOf: leadValue,
    describe: describe, partyOf: partyOf, trainerCard: trainerCard,
    spriteBoxShadow: spriteBoxShadow, typewriterSlice: typewriterSlice,
  };
});
