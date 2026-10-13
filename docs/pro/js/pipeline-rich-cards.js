/**
 * pipeline-rich-cards.js — window.NBDPipelineRich: the Pipeline board's
 * "rich" card style (CRM style integration C5, Grok idea #10, Jo-approved
 * 2026-10-11).
 *
 * What it adds (all on top of the existing card; nothing is removed):
 *   - a 4th card density value, `rich` (setKanbanDensity / data-density), with
 *     a sub-style: `rich` (small roof thumbnail) or `photo` (banner photo);
 *   - per card: roof thumbnail, squares, Insurance/Retail chip, hail chip,
 *     an aging heat bar (days in stage vs the stage's target), the next step
 *     + when it is due, the rep's avatar;
 *   - a board strip: Open / Weighted / Going cold totals (Going cold is a
 *     board filter), and the Compact / Rich / Photo switch.
 *
 * Rules this file keeps:
 *   - "revenue" is collected money only — every figure here is a PIPELINE
 *     figure and says "projected" (open job value; weighted by stage odds);
 *   - photos come from the lead's own cover URL or the already-loaded
 *     NBDPhotoCache bag (the 200px thumb variant when the pipeline stamped
 *     one); this file never mints a token URL and never reads Storage;
 *   - no inline handlers: the switch and chips are driven by one delegated
 *     listener;
 *   - the pure helpers (_pure below) take `now` / data as arguments so
 *     tests/pipeline-rich-cards-2026-10-11.test.js can run them in Node.
 */
(function (root) {
  'use strict';

  var DAY = 86400000;
  var LS_STYLE = 'nbd-kanban-rich-style';
  var STYLES = ['rich', 'photo'];
  var FILTER_COLD = 'going-cold';
  var THUMB_FETCH_CAP = 60;   // leads asked of NBDPhotoCache per paint

  // Days a deal may sit in a stage before it counts as late (heat bar full,
  // red, "going cold"). Defaults chosen for a residential roofing pipeline;
  // a company can override any key at runtime through NBDPipelineRich.SLA.
  var SLA_DEFAULT = 7;
  var SLA = {
    new: 2, contacted: 5, inspected: 5,
    claim_filed: 10, adjuster_meeting_scheduled: 10, adjuster_inspection_done: 5,
    scope_received: 5, estimate_submitted: 7, supplement_requested: 14,
    supplement_approved: 5,
    estimate_sent_cash: 7, negotiating: 7,
    prequal_sent: 7, loan_approved: 5,
    contract_signed: 7,
    job_created: 5, permit_pulled: 14, materials_ordered: 14, materials_delivered: 7,
    crew_scheduled: 14, install_in_progress: 5, install_complete: 3, final_photos: 3,
    deductible_collected: 7, final_payment: 14, collections: 30, warranty_claim: 14,
    warranty_scheduled: 14, warranty_repaired: 7,
    service_quoted: 7, service_approved: 7
  };

  // ── PURE ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isHttp(u) { return /^https?:\/\//i.test(String(u == null ? '' : u)); }

  function toDate(v) {
    if (!v) return null;
    var d = null;
    if (typeof v.toDate === 'function') d = v.toDate();
    else if (v instanceof Date) d = v;
    else if (typeof v.seconds === 'number') d = new Date(v.seconds * 1000);
    else if (typeof v === 'number' || typeof v === 'string') d = new Date(v);
    return d && !isNaN(d.getTime()) ? d : null;
  }
  function midnight(d) { var x = new Date(d.getTime()); x.setHours(0, 0, 0, 0); return x; }
  /** 'YYYY-MM-DD' as LOCAL midnight (new Date('YYYY-MM-DD') is UTC midnight). */
  function dayOf(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v == null ? '' : v).trim());
    var d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : toDate(v);
    return d ? midnight(d) : null;
  }

  /** Whole days the card has sat in its stage — same fallback chain as buildCard's aging cue. */
  function stageDays(lead, nowMs) {
    var l = lead || {};
    var ref = toDate(l.stageStartedAt) || toDate(l.updatedAt) || toDate(l.createdAt);
    if (!ref) return null;
    var n = midnight(new Date(nowMs == null ? Date.now() : nowMs));
    var days = Math.floor((n.getTime() - midnight(ref).getTime()) / DAY);
    return days < 0 ? 0 : days;
  }

  function slaFor(stageKey) {
    var v = SLA[String(stageKey || '')];
    return typeof v === 'number' && v > 0 ? v : SLA_DEFAULT;
  }

  /**
   * Heat for `days` in a stage with a `sla`-day target.
   *   ok   < 50% of the target   (green)
   *   warn 50% .. <100%          (gold)
   *   late >= 100%               (red)
   * `filled` is 0..10 segments of the bar.
   */
  function heatFor(days, sla) {
    var s = sla > 0 ? sla : SLA_DEFAULT;
    var d = days == null || days < 0 ? 0 : days;
    var ratio = d / s;
    var level = ratio >= 1 ? 'late' : (ratio >= 0.5 ? 'warn' : 'ok');
    var filled = Math.min(10, Math.round(ratio * 10));
    if (d > 0 && filled < 1) filled = 1;
    return { level: level, filled: filled, ratio: ratio, days: d, sla: s };
  }

  /** Roof squares: the aerial measurement, else its sqft / 100. null when unknown. */
  function squaresOf(lead) {
    var l = lead || {};
    var sq = Number(l.measurementSquares);
    if (isFinite(sq) && sq > 0 && sq < 1000) return Math.round(sq * 10) / 10;
    var sf = Number(l.measurementSqft);
    if (isFinite(sf) && sf > 0 && sf < 100000) return Math.round(sf / 10) / 10;
    return null;
  }

  /** Insurance vs Retail: insurance (or unset — NBD's default) is Insurance; cash / finance / service are Retail. */
  function typeChip(lead) {
    var jt = String((lead && lead.jobType) || '').toLowerCase();
    if (jt === 'warranty') return { label: 'Warranty', kind: 'warranty' };
    if (jt === 'cash' || jt === 'finance' || jt === 'service') return { label: 'Retail', kind: 'retail' };
    if (!jt || jt === 'insurance') return { label: 'Insurance', kind: 'insurance' };
    return { label: 'Retail', kind: 'retail' };
  }

  /** The hail chip: only when hail-cron stamped a hit on the lead. */
  function hailChip(lead) {
    var h = lead && lead.hailHit;
    var sz = h && Number(h.sizeInches);
    if (!sz || !isFinite(sz) || sz <= 0) return null;
    return { label: 'Hail verified', size: sz.toFixed(1) + '"' };
  }

  function photoUrl(p, small) {
    if (!p) return '';
    var cands = small
      ? [p.thumbUrl, p.urls && p.urls.thumb, p.url]
      : [p.url, p.thumbUrl, p.urls && p.urls.thumb];
    for (var i = 0; i < cands.length; i++) if (isHttp(cands[i])) return String(cands[i]);
    return '';
  }
  function photoMs(p) {
    var d = toDate(p && (p.capturedAt || p.createdAt || p.uploadedAt));
    return d ? d.getTime() : 0;
  }
  function isInspectionShot(p) {
    var ph = String((p && p.phase) || '').toLowerCase();
    if (ph === 'before' || ph === 'inspection') return true;
    var tags = (p && p.tags) || [];
    for (var i = 0; i < tags.length; i++) if (/inspect|before|roof/i.test(String(tags[i]))) return true;
    return false;
  }
  /**
   * The roof thumbnail: the rep's chosen cover, else the earliest inspection
   * ("before") shot, else the earliest photo. small=true prefers the pipeline's
   * 200px variant; the photo style asks for the full url.
   */
  function pickThumb(lead, photos, small) {
    var l = lead || {};
    var list = Array.isArray(photos) ? photos : [];
    if (isHttp(l.coverPhotoUrl)) {
      // The cover is a full-size URL; if the cache holds that photo, use its thumb variant.
      if (small) {
        for (var k = 0; k < list.length; k++) {
          if (list[k] && list[k].url === l.coverPhotoUrl) { var t = photoUrl(list[k], true); if (t) return t; }
        }
      }
      return String(l.coverPhotoUrl);
    }
    list = list.filter(function (p) { return !!photoUrl(p, small); });
    if (!list.length) return '';
    list.sort(function (a, b) { return photoMs(a) - photoMs(b); });
    var pick = null;
    for (var i = 0; i < list.length; i++) { if (isInspectionShot(list[i])) { pick = list[i]; break; } }
    return photoUrl(pick || list[0], small);
  }

  function initialsOf(name) {
    var parts = String(name || '').replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
    if (!parts.length) return '';
    var a = parts[0].charAt(0), b = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (a + b).toUpperCase();
  }
  function hueSlot(key) {
    var h = 0, s = String(key || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 6;
  }

  /** "Due today" / "Due tomorrow" / "Due Oct 14" / "3d overdue" + a level for colour. */
  function dueInfo(v, nowMs) {
    var d = dayOf(v);
    if (!d) return null;
    var today = midnight(new Date(nowMs == null ? Date.now() : nowMs));
    var diff = Math.round((d.getTime() - today.getTime()) / DAY);
    if (diff < 0) return { text: (-diff) + 'd overdue', level: 'over' };
    if (diff === 0) return { text: 'Due today', level: 'today' };
    if (diff === 1) return { text: 'Due tomorrow', level: 'soon' };
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return { text: 'Due ' + months[d.getMonth()] + ' ' + d.getDate(), level: diff <= 3 ? 'soon' : 'later' };
  }

  /**
   * The card's next step: the earliest-due open task, else the stage's
   * preferred action (+ the follow-up date), else the bare follow-up, else
   * "No next step".
   * @param tasks  [{title, done, dueDate, type}]
   * @param preferred {label, icon} | null
   */
  function nextStep(lead, tasks, preferred, nowMs) {
    var open = (Array.isArray(tasks) ? tasks : []).filter(function (t) { return t && !t.done && t.type !== 'event'; });
    var withDue = open.filter(function (t) { return dayOf(t.dueDate); })
      .sort(function (a, b) { return dayOf(a.dueDate) - dayOf(b.dueDate); });
    var pick = withDue[0] || open[0] || null;
    if (pick && (pick.title || pick.text)) {
      return { kind: 'task', text: String(pick.title || pick.text), due: pick.dueDate ? dueInfo(pick.dueDate, nowMs) : null };
    }
    var fu = lead && lead.followUp ? dueInfo(lead.followUp, nowMs) : null;
    if (preferred && preferred.label) return { kind: 'action', text: String(preferred.label), due: fu };
    if (fu) return { kind: 'followup', text: 'Follow up', due: fu };
    return { kind: 'none', text: 'No next step', due: null };
  }

  function roleOf(stageKey) {
    return typeof root.stageRole === 'function' ? root.stageRole(stageKey) : '';
  }
  /** Still in play: not lost, not won, not a job in production. */
  function isOpenStage(stageKey) {
    var r = roleOf(stageKey);
    if (r === 'won' || r === 'lost' || r === 'job') return false;
    if (typeof root.isJobStage === 'function' && root.isJobStage(stageKey)) return false;
    return !/^(lost|closed|complete)$/i.test(String(stageKey || ''));
  }
  /** Finished one way or the other: no heat bar, no next step. */
  function isClosedOut(stageKey) {
    var r = roleOf(stageKey);
    return r === 'won' || r === 'lost' || /^(lost|closed|complete)$/i.test(String(stageKey || ''));
  }

  /**
   * Board strip numbers over a set of cards.
   * env: { money(v)->number, prob(lead, stageKey)->0..1, now }
   * Returns { openCount, openValue, weightedValue, coldCount, coldIds }.
   */
  function summarize(cards, env) {
    var e = env || {};
    var money = typeof e.money === 'function' ? e.money : function (v) { return parseFloat(String(v == null ? '' : v).replace(/[^0-9.-]/g, '')) || 0; };
    var prob = typeof e.prob === 'function' ? e.prob : function () { return 0.1; };
    var out = { openCount: 0, openValue: 0, weightedValue: 0, coldCount: 0, coldIds: [] };
    (cards || []).forEach(function (l) {
      if (!l) return;
      var sk = l._stageKey || l.stage || 'new';
      if (!isOpenStage(sk)) return;
      var v = money(l.jobValue);
      out.openCount++;
      out.openValue += v;
      out.weightedValue += v * prob(l, sk);
      var d = stageDays(l, e.now);
      if (d != null && heatFor(d, slaFor(sk)).level === 'late') {
        out.coldCount++;
        if (out.coldIds.indexOf(l.id) === -1) out.coldIds.push(l.id);
      }
    });
    return out;
  }

  function fmtMoney(n) {
    n = Math.round(Number(n) || 0);
    if (n >= 1000000) return '$' + (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + 'M';
    if (n >= 1000) return '$' + Math.round(n / 1000) + 'K';
    return '$' + n.toLocaleString('en-US');
  }

  // ── card block (HTML) ────────────────────────────────────────────────
  var ICON_ROOF = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 10l8-7 8 7"/><path d="M4 9v7a1 1 0 001 1h10a1 1 0 001-1V9"/></svg>';

  function repNameFor(uid) {
    if (!uid) return '';
    var T = root.NBDTeamNames;
    var n = T && typeof T.nameFor === 'function' ? T.nameFor(uid) : null;
    if (n) return String(n);
    var maps = [root._repNames, root._teamNames];
    for (var i = 0; i < maps.length; i++) if (maps[i] && maps[i][uid]) return String(maps[i][uid]);
    return '';
  }

  /**
   * The rich block for one card.
   * ctx: { stageKey, terminal, photos, tasks, preferred, now, style }
   */
  function cardBlock(lead, ctx) {
    var l = lead || {}, c = ctx || {};
    var style = c.style === 'photo' ? 'photo' : 'rich';
    var id = esc(l.id);
    var sk = c.stageKey || l._stageKey || l.stage || 'new';

    var thumb = pickThumb(l, c.photos, style !== 'photo');
    var thumbHtml = '<span class="kr-thumb' + (thumb ? ' has-img' : '') + '" data-kr-lead="' + id + '">' +
      (thumb ? '<img src="' + esc(thumb) + '" alt="" loading="lazy" decoding="async">' : ICON_ROOF) + '</span>';

    var chips = [];
    var tc = typeChip(l);
    chips.push('<span class="kr-chip kr-chip-' + tc.kind + '">' + esc(tc.label) + '</span>');
    var hc = hailChip(l);
    if (hc) chips.push('<span class="kr-chip kr-chip-hail" title="Hail reported near this property (' + esc(hc.size) + ')">' + esc(hc.label) + '</span>');
    var sq = squaresOf(l);
    var sqHtml = sq != null ? '<span class="kr-sq" title="Roof squares (aerial measurement)">' + esc(String(sq)) + ' SQ</span>' : '';

    var uid = l.userId || l.assignedTo || '';
    var rname = repNameFor(uid);
    var avatar = uid
      ? '<span class="kr-av kr-av-' + hueSlot(uid) + '" data-kr-uid="' + esc(uid) + '" title="' + esc(rname || 'Owner') + '" aria-label="' + esc(rname ? 'Owner ' + rname : 'Owner') + '">' + esc(initialsOf(rname) || '·') + '</span>'
      : '';

    var heatHtml = '';
    var closed = !!c.terminal || isClosedOut(sk);
    if (!closed) {
      var days = stageDays(l, c.now);
      if (days != null) {
        var h = heatFor(days, slaFor(sk));
        var segs = '';
        for (var i = 0; i < 10; i++) segs += '<i' + (i < h.filled ? ' class="on"' : '') + '></i>';
        var tip = days + (days === 1 ? ' day' : ' days') + ' in this stage · target ' + h.sla + 'd';
        heatHtml = '<div class="kr-heat kr-heat-' + h.level + '" role="img" aria-label="' + esc(tip) + '" title="' + esc(tip) + '">' +
          '<span class="kr-heat-bar">' + segs + '</span><span class="kr-heat-txt">' + days + 'd</span></div>';
      }
    }

    var nextHtml = '';
    if (!closed) {
      var ns = nextStep(l, c.tasks, c.preferred, c.now);
      nextHtml = '<div class="kr-next kr-next-' + ns.kind + '"><span class="kr-next-txt" title="' + esc(ns.text) + '">' +
        (ns.kind === 'none' ? '' : '→ ') + esc(ns.text) + '</span>' +
        (ns.due ? '<span class="kr-due kr-due-' + ns.due.level + '">' + esc(ns.due.text) + '</span>' : '') + '</div>';
    }

    return '<div class="kr-block kr-' + style + '">' +
      '<div class="kr-top">' + thumbHtml +
        '<div class="kr-id"><div class="kr-chips">' + chips.join('') + '</div>' + sqHtml + '</div>' + avatar +
      '</div>' + heatHtml + nextHtml + '</div>';
  }

  // ── DOM side ─────────────────────────────────────────────────────────
  var doc = root.document;
  var state = { style: 'rich', lastDensity: null, summary: null, namesAsked: false, filterRegistered: false };

  function readStyle() {
    var s = 'rich';
    try { s = localStorage.getItem(LS_STYLE) || 'rich'; } catch (_) {}
    return STYLES.indexOf(s) === -1 ? 'rich' : s;
  }
  function applyStyleAttr() {
    if (doc) doc.documentElement.setAttribute('data-rich-style', state.style);
  }
  function currentDensity() {
    return (doc && doc.documentElement.getAttribute('data-density')) || 'comfortable';
  }
  function isRich() { return currentDensity() === 'rich'; }
  function currentStyle() { return state.style; }

  function setStyle(which) {
    var next = STYLES.indexOf(which) === -1 ? 'rich' : which;
    state.style = next;
    try { localStorage.setItem(LS_STYLE, next); } catch (_) {}
    applyStyleAttr();
  }

  function repaintBoard() {
    if (typeof root.renderLeads === 'function') {
      try { root.renderLeads(root._leads, root._filteredLeads); } catch (_) {}
    }
  }

  /** Card context for crm-pipeline.js buildCard. */
  function contextFor(l, parts) {
    var p = parts || {};
    var preferred = null;
    try {
      if (!p.terminal && typeof root.preferredActionFor === 'function') {
        var jt = l.jobType || (typeof root.inferJobType === 'function' ? root.inferJobType(l) : null);
        preferred = root.preferredActionFor(p.stageKey || l._stageKey || l.stage, jt) || null;
      }
    } catch (_) { preferred = null; }
    var tasks = (root._taskCache && root._taskCache[l.id]) || [];
    return {
      stageKey: p.stageKey, terminal: !!p.terminal, photos: p.photos || [],
      tasks: tasks, preferred: preferred, style: state.style
    };
  }
  /** '' unless the board is in rich density. buildCard inserts the result. */
  function blockFor(l, parts) {
    if (!isRich()) return '';
    return cardBlock(l, contextFor(l, parts));
  }

  // thumbnails: ask the on-demand cache for the leads that show a placeholder
  function patchThumbs() {
    if (!doc) return;
    var holders = doc.querySelectorAll('.k-card .kr-thumb:not(.has-img)');
    if (!holders.length) return;
    var byId = {};
    (root._leads || []).forEach(function (l) { if (l && l.id) byId[l.id] = l; });
    var want = [];
    holders.forEach(function (el) {
      var id = el.getAttribute('data-kr-lead');
      var lead = byId[id];
      if (!lead) return;
      var url = pickThumb(lead, (root._photoCache && root._photoCache[id]) || [], state.style !== 'photo');
      if (url) {
        el.classList.add('has-img');
        el.textContent = '';
        var img = doc.createElement('img');
        img.src = url; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
        el.appendChild(img);
      } else if (root.NBDPhotoCache && !root.NBDPhotoCache.isLoaded(id) && want.indexOf(id) === -1) {
        want.push(id);
      }
    });
    if (want.length && root.NBDPhotoCache) {
      try { root.NBDPhotoCache.ensure(want.slice(0, THUMB_FETCH_CAP)); } catch (_) {}
    }
  }
  function patchAvatars() {
    if (!doc) return;
    doc.querySelectorAll('.k-card .kr-av[data-kr-uid]').forEach(function (el) {
      var n = repNameFor(el.getAttribute('data-kr-uid'));
      if (!n) return;
      el.textContent = initialsOf(n) || '·';
      el.title = n;
      el.setAttribute('aria-label', 'Owner ' + n);
    });
  }
  function askNames() {
    if (state.namesAsked || !root.NBDTeamNames || typeof root.NBDTeamNames.load !== 'function') return;
    state.namesAsked = true;
    try { root.NBDTeamNames.load().then(patchAvatars).catch(function () {}); } catch (_) {}
  }

  // ── board strip ──────────────────────────────────────────────────────
  function moneyOf(v) {
    var R = root.NBDCustomerEstimateRows;
    if (R && typeof R.moneyValue === 'function') return R.moneyValue(v);
    return parseFloat(String(v == null ? '' : v).replace(/[^0-9.-]/g, '')) || 0;
  }
  /** Close odds per stage: the Forecast panel's table, blended with the company's own history. */
  function weightedProb() {
    var P = (root.Forecasting && root.Forecasting.STAGE_PROB) || {};
    var FE = root.ForecastEmpirical;
    var emp = null;
    if (FE && typeof FE.computeEmpiricalRates === 'function') {
      try {
        var leads = (root._leads || []).filter(function (l) { return l && !l.isProspect && !l.deleted; });
        emp = FE.computeEmpiricalRates(leads, {
          isWon: typeof root.isWonStage === 'function' ? root.isWonStage : function (k) { return P[k] === 1; },
          isLost: typeof root.isLostStage === 'function' ? root.isLostStage : function (k) { return P[k] === 0; }
        });
      } catch (_) { emp = null; }
    }
    return function (lead, key) {
      var prior = P[key] != null ? P[key] : 0.1;
      if (emp && FE && typeof FE.blendedProbability === 'function') {
        try { return FE.blendedProbability(key, emp, prior); } catch (_) {}
      }
      return prior;
    };
  }

  function ensureStrip() {
    if (!doc) return null;
    var el = doc.getElementById('krStrip');
    if (el) return el;
    var anchor = doc.getElementById('hiddenStageWrap') || doc.getElementById('followUpAlertsWrap');
    if (!anchor || !anchor.parentNode) return null;
    el = doc.createElement('div');
    el.id = 'krStrip';
    el.className = 'kr-strip';
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
    return el;
  }

  function paintStrip() {
    var el = ensureStrip();
    if (!el) return;
    var s = state.summary || { openCount: 0, openValue: 0, weightedValue: 0, coldCount: 0 };
    var coldOn = !!(root.NBDLeadFilters && root.NBDLeadFilters.isActive(FILTER_COLD));
    var d = currentDensity();
    var cur = d === 'compact' ? 'compact' : (d === 'rich' ? state.style : '');
    function sw(key, label) {
      var on = cur === key;
      return '<button type="button" class="kr-sw ui-seg' + (on ? ' is-on' : '') + '" data-kr-card="' + key + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + label + '</button>';
    }
    // Phone: the three segments collapse to ONE cycle button so the stats and
    // the card style share a row (CSS swaps which is visible, >640px keeps
    // the segments). Same three states, same handlers.
    var CYCLE = { '': 'compact', compact: 'rich', rich: 'photo', photo: 'compact' };
    var NAMES = { '': 'Cards', compact: 'Compact', rich: 'Rich', photo: 'Photo' };
    var nextKey = CYCLE[cur] || 'compact';
    var cycleLabel = 'Card style: ' + NAMES[cur] + '. Tap for ' + NAMES[nextKey] + '.';
    el.innerHTML =
      '<div class="kr-stats">' +
        '<button type="button" class="kr-stat' + (!coldOn ? ' is-on' : '') + '" data-kr-act="open" title="Open deals on this board. Pipeline value is projected, not collected." aria-pressed="' + (!coldOn ? 'true' : 'false') + '">' +
          '<span class="kr-stat-k">Open</span><span class="kr-stat-v">' + s.openCount + ' · ' + fmtMoney(s.openValue) + '</span><span class="kr-stat-n">projected</span></button>' +
        '<span class="kr-stat kr-stat-static" title="Each open deal times the close odds for its stage (your own win history once there is enough). A projection, not money collected.">' +
          '<span class="kr-stat-k">Weighted</span><span class="kr-stat-v">' + fmtMoney(s.weightedValue) + '</span><span class="kr-stat-n">projected</span></span>' +
        '<button type="button" class="kr-stat kr-stat-cold' + (coldOn ? ' is-on' : '') + '" data-kr-act="cold" title="Open deals past their stage target. Tap to show only these." aria-pressed="' + (coldOn ? 'true' : 'false') + '">' +
          '<span class="kr-stat-k">Going cold</span><span class="kr-stat-v">' + s.coldCount + '</span></button>' +
      '</div>' +
      '<div class="kr-switch" role="group" aria-label="Card style">' +
        sw('compact', 'Compact') + sw('rich', 'Rich') + sw('photo', 'Photo') +
        '<button type="button" class="kr-cycle ui-seg" data-kr-act="cycle" data-kr-next="' + nextKey + '" title="' + cycleLabel + '" aria-label="' + cycleLabel + '">' +
          '<span class="kr-cyc-k">' + NAMES[cur] + '</span></button>' +
      '</div>';
  }

  /** Fresh from the whole book (not the last paint), so a refresh while the filter is on still finds newly cold deals. */
  function coldCompute() {
    var ids = summarize(root._leads || [], { money: moneyOf, prob: function () { return 0; } }).coldIds;
    var set = {};
    ids.forEach(function (i) { set[i] = true; });
    return (root._leads || []).filter(function (l) { return l && set[l.id]; });
  }
  function registerFilter() {
    if (state.filterRegistered || !root.NBDLeadFilters) return;
    root.NBDLeadFilters.register(FILTER_COLD, { compute: coldCompute, paint: function () { paintStrip(); } });
    state.filterRegistered = true;
  }

  /** Called at the end of renderLeads with the cards the board shows. */
  function afterRender(cards) {
    if (!doc) return;
    registerFilter();
    state.summary = summarize(cards, { money: moneyOf, prob: weightedProb(), now: Date.now() });
    paintStrip();
    if (isRich()) { askNames(); patchThumbs(); }
  }

  // ── events ───────────────────────────────────────────────────────────
  function setCardStyle(key) {
    if (typeof root.setKanbanDensity !== 'function') return;
    if (key === 'compact') {
      root.setKanbanDensity(currentDensity() === 'compact' ? 'comfortable' : 'compact');
      return;
    }
    if (isRich() && state.style === key) { root.setKanbanDensity('comfortable'); return; }
    setStyle(key);
    if (isRich()) { repaintBoard(); paintStrip(); }   // same density, new sub-style
    else root.setKanbanDensity('rich');
  }

  if (doc) {
    doc.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('#krStrip [data-kr-card], #krStrip [data-kr-act]') : null;
      if (!t) return;
      var key = t.getAttribute('data-kr-card');
      if (key) { ev.preventDefault(); setCardStyle(key); return; }
      var act = t.getAttribute('data-kr-act');
      if (act === 'cycle') { ev.preventDefault(); setCardStyle(t.getAttribute('data-kr-next') || 'compact'); return; }
      var F = root.NBDLeadFilters;
      if (!F) return;
      if (act === 'cold') F.toggle(FILTER_COLD);
      else if (act === 'open') F.deactivate(FILTER_COLD);
    });
    doc.addEventListener('nbd:density-changed', function (ev) {
      var d = (ev && ev.detail && ev.detail.density) || currentDensity();
      if (d === state.lastDensity) return;
      var involvesRich = d === 'rich' || state.lastDensity === 'rich';
      state.lastDensity = d;
      if (involvesRich) repaintBoard(); else paintStrip();
    });
    root.addEventListener('nbd:photos-loaded', function () { if (isRich()) patchThumbs(); });
    state.style = readStyle();
    applyStyleAttr();
    state.lastDensity = currentDensity();
  }

  var api = {
    SLA: SLA, SLA_DEFAULT: SLA_DEFAULT, FILTER_COLD: FILTER_COLD,
    isRich: isRich, currentStyle: currentStyle, setStyle: setStyle,
    blockFor: blockFor, afterRender: afterRender,
    _pure: {
      stageDays: stageDays, slaFor: slaFor, heatFor: heatFor, squaresOf: squaresOf,
      typeChip: typeChip, hailChip: hailChip, pickThumb: pickThumb, initialsOf: initialsOf,
      dueInfo: dueInfo, nextStep: nextStep, summarize: summarize, cardBlock: cardBlock,
      isOpenStage: isOpenStage, fmtMoney: fmtMoney, esc: esc
    }
  };
  root.NBDPipelineRich = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
