/**
 * numbers-logic.js — "knowing your numbers" (2026-10-04). Pure rules, no DOM.
 *
 * The 2026-10-04 read-only audit of the owner tenant: 38 won leads, $92.5k
 * booked, $3,650 collected and recorded; 104 Thumbtack leads, 36 with a cost.
 * Every number on the Sunday review, the lead-source table and Reports comes
 * from this file so they cannot disagree:
 *
 *   - ONE close rate: won ÷ (won + lost). "Won" is the sale test — the lead is
 *     won, in production, or on Contract Signed (Jo, 2026-09-15: a signed
 *     contract IS a job — crm-stages.js isJobStage). No decided leads → null,
 *     shown as "—", never 0%.
 *   - Revenue = money COLLECTED, by payment date (Jo, 2026-09-28). Booked
 *     figures are jobValue and are always labelled "projected".
 *   - Money in CENTS throughout; dollars only at the edge (fmtMoney).
 *   - Spend, cost per lead / per job and margin are CRM-only cost figures
 *     (never under docs/ public pages — this file ships only to /pro).
 *
 * window.NBDNumbers in the browser; module.exports for tests.
 */
(function (root) {
  'use strict';

  // ── Stages (mirror docs/pro/js/crm-stages.js; the test pins these) ───────
  var WON_KEYS = ['closed', 'install_complete', 'final_photos', 'final_payment', 'deductible_collected', 'collections', 'warranty_claim'];
  var JOB_KEYS = ['job_created', 'permit_pulled', 'materials_ordered', 'materials_delivered', 'crew_scheduled', 'install_in_progress'];
  var CONTRACT_SIGNED = 'contract_signed';
  var VALID_ROLES = ['new', 'active', 'job', 'won', 'lost'];
  var LEGACY = {
    'new': 'new', 'new lead': 'new', 'inspected': 'inspected', 'estimate sent': 'estimate_submitted',
    'approved': 'contract_signed', 'in progress': 'install_in_progress', 'complete': 'closed', 'lost': 'lost',
    'contacted': 'contacted', 'negotiating': 'negotiating', 'closed won': 'closed', 'closed lost': 'lost',
    'won': 'closed', 'closed_won': 'closed', 'closed-won': 'closed'
  };

  /** Stored stage value → key. Legacy display names fold ('New' → 'new'). */
  function canonStage(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return 'new';
    var lower = s.toLowerCase();
    if (LEGACY[lower]) return LEGACY[lower];
    return lower.replace(/[\s-]+/g, '_');
  }
  function stageKeyOf(lead) {
    if (!lead) return 'new';
    return lead._stageKey ? canonStage(lead._stageKey) : canonStage(lead.stage);
  }
  function roleFromKey(k) {
    if (WON_KEYS.indexOf(k) !== -1) return 'won';
    if (JOB_KEYS.indexOf(k) !== -1) return 'job';
    if (k === 'lost') return 'lost';
    if (k === 'new') return 'new';
    return 'active';
  }
  /**
   * Role: the persisted stageRole (custom-stage safe), then the live tenant
   * role function (window.stageRole — knows custom stages), then built-ins.
   */
  function roleOf(lead, roleFn) {
    if (!lead) return 'new';
    var p = lead._stageRole || lead.stageRole;
    if (typeof p === 'string' && VALID_ROLES.indexOf(p) !== -1) return p;
    var k = stageKeyOf(lead);
    var fn = roleFn || (root && typeof root.stageRole === 'function' ? root.stageRole : null);
    if (fn) { try { var r = fn(k); if (VALID_ROLES.indexOf(r) !== -1) return r; } catch (_) { /* fall through */ } }
    return roleFromKey(k);
  }
  /** THE sale test: won, in production, or contract signed. */
  function isSale(lead, roleFn) {
    if (!lead) return false;
    var r = roleOf(lead, roleFn);
    if (r === 'won' || r === 'job') return true;
    if (r === 'lost') return false;
    return stageKeyOf(lead) === CONTRACT_SIGNED;
  }
  function isLostLead(lead, roleFn) { return !!lead && roleOf(lead, roleFn) === 'lost'; }
  function counts(lead) { return !!lead && !lead.deleted && !lead.isProspect && !lead.e2eTestData; }

  /**
   * THE close rate. won ÷ (won + lost); rate null when nothing is decided.
   * @returns {{won:number, lost:number, decided:number, rate:(number|null)}}
   */
  function closeRate(records, roleFn) {
    var won = 0, lost = 0;
    (records || []).forEach(function (l) {
      if (!counts(l)) return;
      if (isSale(l, roleFn)) won++;
      else if (isLostLead(l, roleFn)) lost++;
    });
    var decided = won + lost;
    return { won: won, lost: lost, decided: decided, rate: decided ? won / decided : null };
  }
  /** '—' when there is no data, else 'NN%'. */
  function fmtRate(cr) {
    var r = cr && typeof cr === 'object' ? cr.rate : cr;
    return (r == null || !isFinite(r)) ? '—' : Math.round(r * 100) + '%';
  }

  // ── Money / dates ──────────────────────────────────────────────────────
  function toMs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (v instanceof Date) return v.getTime();
    if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (_) { return 0; } }
    if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch (_) { return 0; } }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (typeof v === 'string') { var t = Date.parse(v); return isFinite(t) ? t : 0; }
    return 0;
  }
  function dollarsToCents(v) {
    var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? Math.round(n * 100) : 0;
  }
  function fmtMoney(cents) {
    var d = (Number(cents) || 0) / 100;
    var neg = d < 0; d = Math.abs(d);
    var s = d >= 1e6 ? '$' + (d / 1e6).toFixed(1) + 'M'
      : d >= 10000 ? '$' + Math.round(d / 1000) + 'k'
      : '$' + Math.round(d).toLocaleString('en-US');
    return (neg ? '−' : '') + s;
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /** Local calendar month 'YYYY-MM'. */
  function monthKey(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
  function ymd(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function bookedCents(lead) { return dollarsToCents(lead && lead.jobValue); }

  // ── Lead sources ───────────────────────────────────────────────────────
  var SOURCE_ALIASES = {
    'door knock': 'Door Knock', 'door-to-door': 'Door Knock', 'door_knock': 'Door Knock', 'door to door': 'Door Knock', 'd2d': 'Door Knock',
    'storm canvass': 'Storm Canvass', 'storm_alert': 'Storm Alert', 'storm alert': 'Storm Alert',
    'google': 'Google', 'referral': 'Referral',
    'thumbtack': 'Thumbtack', 'yelp': 'Yelp', 'angi': 'Angi', 'angies list': 'Angi', "angie's list": 'Angi',
    'homeadvisor': 'HomeAdvisor', 'home advisor': 'HomeAdvisor',
    'online': 'Online', '': 'Unknown', 'other': 'Other'
  };
  /**
   * One bucket per real source. Every public-site funnel — contact form,
   * inspection / storm tool, instant estimate, and "Website — Cal.com
   * booking" — reports as Website (the stored values stay distinct).
   */
  function normalizeSource(raw) {
    var s = String(raw == null ? '' : raw).trim();
    var lower = s.toLowerCase();
    if (/^website\b/.test(lower) || /^cal\.?com\b/.test(lower)) return 'Website';
    if (Object.prototype.hasOwnProperty.call(SOURCE_ALIASES, lower)) return SOURCE_ALIASES[lower];
    return s || 'Unknown';
  }
  /** Spend is entered against these by default (owners can add more). */
  var PAID_SOURCES = ['Thumbtack', 'Yelp', 'Angi', 'HomeAdvisor'];
  function spendKey(source) { return normalizeSource(source).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
  function isPaidSource(source, spend) {
    var n = normalizeSource(source);
    if (PAID_SOURCES.indexOf(n) !== -1) return true;
    var months = (spend && spend.months) || {};
    var k = spendKey(n);
    return Object.keys(months).some(function (m) { return Number((months[m] || {})[k]) > 0; });
  }

  /**
   * What one lead cost, in cents, and how we know:
   *   'lead'    — the lead carries its own leadCost (Thumbtack's price);
   *   'monthly' — no per-lead price, so the month's entered spend for its
   *               source ÷ that source's leads that month;
   *   'none'    — neither.
   * monthLeadCounts: { 'YYYY-MM': { spendKey: n } } (from monthLeadCounts()).
   */
  function leadCostOf(lead, spend, monthLeadCounts) {
    var own = dollarsToCents(lead && lead.leadCost);
    if (own > 0) return { cents: own, basis: 'lead' };
    var ms = toMs(lead && lead.createdAt);
    if (!ms) return { cents: 0, basis: 'none' };
    var mk = monthKey(ms), sk = spendKey(lead.source);
    var monthSpend = Number((((spend && spend.months) || {})[mk] || {})[sk]) || 0;
    var n = ((monthLeadCounts || {})[mk] || {})[sk] || 0;
    if (monthSpend > 0 && n > 0) return { cents: Math.round(monthSpend / n), basis: 'monthly' };
    return { cents: 0, basis: 'none' };
  }
  function monthLeadCounts(leads) {
    var out = {};
    (leads || []).forEach(function (l) {
      if (!counts(l)) return;
      var ms = toMs(l.createdAt); if (!ms) return;
      var mk = monthKey(ms), sk = spendKey(l.source);
      out[mk] = out[mk] || {};
      out[mk][sk] = (out[mk][sk] || 0) + 1;
    });
    return out;
  }

  /**
   * Spend per source in cents. For a (source, month) with entered monthly
   * spend, that figure IS the spend (it is the bill); otherwise the sum of the
   * per-lead costs of that month's leads.
   */
  function spendBySource(leads, spend) {
    var months = (spend && spend.months) || {};
    var perLead = {}, entered = {};
    (leads || []).forEach(function (l) {
      if (!counts(l)) return;
      var ms = toMs(l.createdAt);
      var mk = ms ? monthKey(ms) : '';
      var sk = spendKey(l.source);
      if (mk && Number((months[mk] || {})[sk]) > 0) return; // covered by the bill
      var c = dollarsToCents(l.leadCost);
      if (c > 0) perLead[sk] = (perLead[sk] || 0) + c;
    });
    Object.keys(months).forEach(function (mk) {
      var row = months[mk] || {};
      Object.keys(row).forEach(function (sk) { var c = Number(row[sk]) || 0; if (c > 0) entered[sk] = (entered[sk] || 0) + c; });
    });
    var out = {};
    Object.keys(perLead).forEach(function (k) { out[k] = (out[k] || 0) + perLead[k]; });
    Object.keys(entered).forEach(function (k) { out[k] = (out[k] || 0) + entered[k]; });
    return out;
  }

  /**
   * The lead-source table: one row per source.
   * opts: { collectedByLead: { leadId: dollars }, spend, roleFn }
   * Row: { source, leads, won, lost, winRate (null|0..1), bookedCents
   *        (PROJECTED), collectedCents, spendCents, costPerWonCents (null),
   *        bookedPerDollar (null) }. Sorted by collected, then booked.
   */
  function sourceTable(leads, opts) {
    var o = opts || {};
    var paid = o.collectedByLead || {};
    var rows = {};
    (leads || []).forEach(function (l) {
      if (!counts(l)) return;
      var src = normalizeSource(l.source);
      var r = rows[src] || (rows[src] = { source: src, leads: 0, won: 0, lost: 0, bookedCents: 0, collectedCents: 0, spendCents: 0 });
      r.leads++;
      if (isSale(l, o.roleFn)) { r.won++; r.bookedCents += bookedCents(l); }
      else if (isLostLead(l, o.roleFn)) r.lost++;
      if (l.id != null && paid[l.id]) r.collectedCents += dollarsToCents(paid[l.id]);
    });
    var sp = spendBySource(leads, o.spend);
    Object.keys(rows).forEach(function (src) { rows[src].spendCents = sp[spendKey(src)] || 0; });
    var list = Object.keys(rows).map(function (k) {
      var r = rows[k];
      var dec = r.won + r.lost;
      r.winRate = dec ? r.won / dec : null;
      r.costPerWonCents = (r.spendCents > 0 && r.won > 0) ? Math.round(r.spendCents / r.won) : null;
      r.bookedPerDollar = r.spendCents > 0 ? (r.bookedCents / r.spendCents) : null;
      return r;
    }).sort(function (a, b) { return (b.collectedCents - a.collectedCents) || (b.bookedCents - a.bookedCents) || (b.leads - a.leads); });
    var t = { source: 'All sources', leads: 0, won: 0, lost: 0, bookedCents: 0, collectedCents: 0, spendCents: 0 };
    list.forEach(function (r) { ['leads', 'won', 'lost', 'bookedCents', 'collectedCents', 'spendCents'].forEach(function (f) { t[f] += r[f]; }); });
    t.winRate = (t.won + t.lost) ? t.won / (t.won + t.lost) : null;
    t.costPerWonCents = (t.spendCents > 0 && t.won > 0) ? Math.round(t.spendCents / t.won) : null;
    t.bookedPerDollar = t.spendCents > 0 ? t.bookedCents / t.spendCents : null;
    return { rows: list, totals: t };
  }

  /** Paid-source leads with no leadCost. covered = the month's spend is entered. */
  function missingLeadCost(leads, spend) {
    var months = (spend && spend.months) || {};
    return (leads || []).filter(function (l) {
      return counts(l) && isPaidSource(l.source, spend) && !(dollarsToCents(l.leadCost) > 0);
    }).map(function (l) {
      var ms = toMs(l.createdAt);
      var mk = ms ? monthKey(ms) : '';
      return { lead: l, month: mk, covered: !!(mk && Number((months[mk] || {})[spendKey(l.source)]) > 0) };
    });
  }

  // ── Spend CSV (Thumbtack billing export, or any date + amount CSV) ──────
  function splitCsvLine(line) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }
  function parseDateCell(s) {
    var t = String(s || '').trim();
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(t);
    if (m) { var y = +m[3]; if (y < 100) y += 2000; return new Date(y, +m[1] - 1, +m[2]).getTime(); }
    var p = Date.parse(t);
    return isFinite(p) ? p : 0;
  }
  /**
   * Parse a billing CSV: find a date column and an amount column by header
   * name, keep rows with a positive amount. Refunds / credits (negative) are
   * kept as negative so a month nets out.
   * @returns {{ rows: {ymd:string, cents:number}[], byMonth: {[k:string]:number}, skipped:number, error:(string|null) }}
   */
  function parseSpendCsv(text) {
    var lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) return { rows: [], byMonth: {}, skipped: 0, error: 'The file has no rows.' };
    var head = splitCsvLine(lines[0]).map(function (h) { return h.toLowerCase(); });
    var di = -1, ai = -1;
    head.forEach(function (h, i) {
      if (di < 0 && /date|charged on|time/.test(h)) di = i;
    });
    var amtPrefs = [/^amount$/, /amount|total|charge|price|cost|debit/];
    amtPrefs.some(function (re) { head.some(function (h, i) { if (ai < 0 && i !== di && re.test(h)) { ai = i; return true; } return false; }); return ai >= 0; });
    if (di < 0 || ai < 0) return { rows: [], byMonth: {}, skipped: 0, error: 'Could not find a date column and an amount column in the header row.' };
    var rows = [], byMonth = {}, skipped = 0;
    for (var i = 1; i < lines.length; i++) {
      var cells = splitCsvLine(lines[i]);
      var ms = parseDateCell(cells[di]);
      var raw = String(cells[ai] || '');
      var neg = /^\(.*\)$/.test(raw.trim()) || /^-/.test(raw.trim());
      var cents = Math.abs(dollarsToCents(raw));
      if (!ms || !cents) { skipped++; continue; }
      if (neg) cents = -cents;
      var mk = monthKey(ms);
      rows.push({ ymd: ymd(ms), cents: cents });
      byMonth[mk] = (byMonth[mk] || 0) + cents;
    }
    return { rows: rows, byMonth: byMonth, skipped: skipped, error: rows.length ? null : 'No rows with a date and an amount.' };
  }

  // ── Costs needed ───────────────────────────────────────────────────────
  /**
   * Won jobs with no costs recorded. An expense counts as a job cost when it
   * is linked to the lead (leadId) with a positive amount and is not
   * overhead (costType 'overhead' / marketing category).
   * @returns {{ list: object[], costed: number, total: number }}
   */
  function costsNeeded(leads, expenses, roleFn) {
    var costed = {};
    (expenses || []).forEach(function (e) {
      if (!e || e.deleted || !e.leadId) return;
      if (e.costType === 'overhead' || e.category === 'marketing') return;
      var c = Number(e.amountCents) || dollarsToCents(e.amount);
      if (c > 0) costed[e.leadId] = (costed[e.leadId] || 0) + c;
    });
    var wins = (leads || []).filter(function (l) { return counts(l) && isSale(l, roleFn); });
    // Costs typed on the customer page's Job Costs panel live on the lead
    // itself (profit-tracker.js: materialCost / laborCost / miscCosts).
    wins.forEach(function (l) {
      var own = dollarsToCents(l.materialCost) + dollarsToCents(l.laborCost) + dollarsToCents(l.miscCosts);
      if (own > 0) costed[l.id] = (costed[l.id] || 0) + own;
    });
    var list = wins.filter(function (l) { return !costed[l.id]; })
      .sort(function (a, b) { return bookedCents(b) - bookedCents(a); });
    return { list: list, costed: wins.length - list.length, total: wins.length, costCentsByLead: costed };
  }

  // ── Close dates ────────────────────────────────────────────────────────
  /** When the sale happened: closedAt, else the first move into a sale stage. */
  function saleDateMs(lead) {
    var c = toMs(lead && lead.closedAt);
    if (c) return c;
    var hist = (lead && Array.isArray(lead.stageHistory)) ? lead.stageHistory : [];
    for (var i = 0; i < hist.length; i++) {
      var h = hist[i] || {};
      var to = canonStage(h.to);
      if (to === CONTRACT_SIGNED || WON_KEYS.indexOf(to) !== -1 || JOB_KEYS.indexOf(to) !== -1) {
        var t = toMs(h.timestamp || h.at);
        if (t) return t;
      }
    }
    return 0;
  }
  /**
   * A win whose close date is not real: no closedAt, or closedAt equal to
   * createdAt (imports and back-entered wins stamped both at once — within a
   * minute counts as equal).
   */
  function needsCloseDate(lead, roleFn) {
    if (!counts(lead) || !isSale(lead, roleFn)) return false;
    var c = toMs(lead.closedAt), cr = toMs(lead.createdAt);
    if (!c) return true;
    return !!cr && Math.abs(c - cr) < 60000;
  }

  // ── Lost reasons ───────────────────────────────────────────────────────
  var LOST_REASONS = [
    { key: 'price', label: 'Price' },
    { key: 'competitor', label: 'Went with someone else' },
    { key: 'no_damage', label: 'No damage' },
    { key: 'no_response', label: 'No response' },
    { key: 'insurance_denied', label: 'Insurance denied' },
    { key: 'other', label: 'Other' }
  ];
  function lostReasonLabel(key) {
    for (var i = 0; i < LOST_REASONS.length; i++) if (LOST_REASONS[i].key === key) return LOST_REASONS[i].label;
    return '';
  }
  /** The reason key for a lost lead, reading older free-text reasons too. */
  function lostReasonKeyOf(lead) {
    if (!lead) return null;
    if (lead.lostReasonKey && lostReasonLabel(lead.lostReasonKey)) return lead.lostReasonKey;
    var t = String(lead.lostReason || '').toLowerCase().trim();
    if (!t) return null;
    if (/price|expensive|cost|cheaper|budget/.test(t)) return 'price';
    if (/competitor|someone else|another (company|contractor|roofer)|went with|chose/.test(t)) return 'competitor';
    if (/no damage|not enough damage|nothing wrong/.test(t)) return 'no_damage';
    if (/ghost|no response|no answer|no contact|unreachable|never (called|answered)/.test(t)) return 'no_response';
    if (/denied|denial|no (insurance )?claim|claim (was )?not approved/.test(t)) return 'insurance_denied';
    return 'other';
  }
  /** Validate a picker choice → error message or null. 'other' needs a note. */
  function validateLostReason(choice) {
    var c = choice || {};
    if (!c.key || !lostReasonLabel(c.key)) return 'Pick a reason.';
    if (c.key === 'other' && !String(c.note || '').trim()) return 'Add a short note for "Other".';
    return null;
  }
  /** The fields a lost move writes. */
  function lostReasonFields(choice) {
    var note = String((choice && choice.note) || '').trim().slice(0, 300);
    var label = lostReasonLabel(choice.key);
    return { lostReasonKey: choice.key, lostReason: note ? (label + ' — ' + note).slice(0, 300) : label, lostReasonNote: note || null };
  }
  function lossesByReason(leads, roleFn) {
    var byReason = {}, bySource = {}, missing = 0, total = 0;
    (leads || []).forEach(function (l) {
      if (!counts(l) || !isLostLead(l, roleFn)) return;
      total++;
      var k = lostReasonKeyOf(l);
      if (!k) { missing++; k = 'unknown'; }
      byReason[k] = (byReason[k] || 0) + 1;
      var src = normalizeSource(l.source);
      bySource[src] = bySource[src] || {};
      bySource[src][k] = (bySource[src][k] || 0) + 1;
    });
    return { total: total, missing: missing, byReason: byReason, bySource: bySource };
  }

  // ── Sold package ───────────────────────────────────────────────────────
  var TIERS = ['economy', 'good', 'better', 'best', 'beyond'];
  var TIER_LABELS = { economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' };
  function soldTierOf(lead) {
    var t = String((lead && lead.soldTier) || '').toLowerCase();
    return TIERS.indexOf(t) !== -1 ? t : null;
  }
  /** Package mix over sales: count + average ticket (booked, projected). */
  function packageMix(leads, roleFn) {
    var by = {}, unknown = 0, sales = 0;
    (leads || []).forEach(function (l) {
      if (!counts(l) || !isSale(l, roleFn)) return;
      sales++;
      var t = soldTierOf(l);
      if (!t) { unknown++; return; }
      var r = by[t] || (by[t] = { tier: t, label: TIER_LABELS[t], count: 0, bookedCents: 0, valued: 0 });
      r.count++;
      var b = bookedCents(l);
      if (b > 0) { r.bookedCents += b; r.valued++; }
    });
    var rows = TIERS.filter(function (t) { return by[t]; }).map(function (t) {
      var r = by[t]; r.avgTicketCents = r.valued ? Math.round(r.bookedCents / r.valued) : null; return r;
    });
    return { rows: rows, unknown: unknown, sales: sales };
  }

  // ── Storms ─────────────────────────────────────────────────────────────
  function stormIdForYmd(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? 'storm-' + d : null; }
  function stormResults(leads, roleFn) {
    var by = {};
    (leads || []).forEach(function (l) {
      if (!counts(l) || !l.stormId) return;
      var r = by[l.stormId] || (by[l.stormId] = { stormId: l.stormId, date: l.stormDate || String(l.stormId).replace(/^storm-/, ''), place: l.stormPlace || '', leads: 0, won: 0, lost: 0, bookedCents: 0 });
      r.leads++;
      if (!r.place && l.stormPlace) r.place = l.stormPlace;
      if (isSale(l, roleFn)) { r.won++; r.bookedCents += bookedCents(l); }
      else if (isLostLead(l, roleFn)) r.lost++;
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  }

  // ── Reviews & referrals ────────────────────────────────────────────────
  function isReferred(lead) {
    return !!(lead && (normalizeSource(lead.source) === 'Referral' || lead.redeemReferralCode || lead.referredByLeadId || lead.referredByCustomerId || lead.referrerLeadId));
  }
  /**
   * Per month: review asks sent, reviews received, referral links clicked,
   * referred leads, referred wins.
   * input: { leads, reviewAsks: [{at}], reviews: [{time (s) | at}], clicks: {'YYYY-MM': n}, roleFn }
   */
  function reviewsReferralsByMonth(input) {
    var i = input || {};
    var m = {};
    function row(k) { return m[k] || (m[k] = { month: k, asks: 0, reviews: 0, clicks: 0, referredLeads: 0, referredWins: 0 }); }
    (i.reviewAsks || []).forEach(function (a) { var t = toMs(a && (a.at || a.sentAt)); if (t) row(monthKey(t)).asks++; });
    (i.reviews || []).forEach(function (r) { var t = r && typeof r.time === 'number' ? r.time * 1000 : toMs(r && r.at); if (t) row(monthKey(t)).reviews++; });
    var clicks = i.clicks || {};
    Object.keys(clicks).forEach(function (k) { if (/^\d{4}-\d{2}$/.test(k)) row(k).clicks += Number(clicks[k]) || 0; });
    (i.leads || []).forEach(function (l) {
      if (!counts(l) || !isReferred(l)) return;
      var t = toMs(l.createdAt); if (t) row(monthKey(t)).referredLeads++;
      if (isSale(l, i.roleFn)) { var s = saleDateMs(l) || t; if (s) row(monthKey(s)).referredWins++; }
    });
    return Object.keys(m).sort().reverse().map(function (k) { return m[k]; });
  }
  /** Review asks from the leads themselves (reviewRequestedAt / reviewNudgedAt). */
  function reviewAsksFromLeads(leads) {
    var out = [];
    (leads || []).forEach(function (l) {
      if (!counts(l)) return;
      var t = toMs(l.reviewRequestedAt);
      if (t) out.push({ at: t, leadId: l.id });
    });
    return out;
  }

  // ── The Sunday business review ─────────────────────────────────────────
  var DAY = 86400000;
  /** The week's key: the local date of the Sunday the review covers up to. */
  function weekKey(nowMs) {
    var d = new Date(nowMs); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return ymd(d.getTime());
  }
  function daysIn(lead, nowMs) {
    var t = toMs(lead.stageStartedAt) || toMs(lead.updatedAt) || toMs(lead.createdAt);
    return t ? Math.max(0, Math.floor((nowMs - t) / DAY)) : 0;
  }
  function decidedAtMs(lead, roleFn) {
    if (isSale(lead, roleFn)) return saleDateMs(lead) || toMs(lead.stageStartedAt);
    if (isLostLead(lead, roleFn)) return toMs(lead.closedAt) || toMs(lead.stageStartedAt);
    return 0;
  }
  function rateBetween(leads, start, end, roleFn) {
    var inWin = (leads || []).filter(function (l) {
      if (!counts(l)) return false;
      var t = decidedAtMs(l, roleFn);
      return t && t >= start && t < end;
    });
    return closeRate(inWin, roleFn);
  }
  /** Top stuck stages (≥2 open leads, slowest average first) + oldest Contacted. */
  function stuckDeals(leads, nowMs, roleFn, labelFn) {
    var by = {};
    var open = (leads || []).filter(function (l) { return counts(l) && !isSale(l, roleFn) && !isLostLead(l, roleFn); });
    open.forEach(function (l) {
      var k = stageKeyOf(l);
      if (k === 'new') return;
      var r = by[k] || (by[k] = { stage: k, label: labelFn ? labelFn(k) : k, count: 0, totalDays: 0, oldest: null });
      var d = daysIn(l, nowMs);
      r.count++; r.totalDays += d;
      if (!r.oldest || d > r.oldest.days) r.oldest = { lead: l, days: d };
    });
    var bottlenecks = Object.keys(by).map(function (k) { var r = by[k]; r.avgDays = Math.round(r.totalDays / r.count); return r; })
      .filter(function (r) { return r.count >= 2; })
      .sort(function (a, b) { return (b.avgDays - a.avgDays) || (b.count - a.count); })
      .slice(0, 3);
    var oldestContacted = by.contacted ? by.contacted.oldest : null;
    return { bottlenecks: bottlenecks, oldestContacted: oldestContacted };
  }

  /**
   * Everything on the Sunday review, for the 7 days ending nowMs.
   * input: {
   *   nowMs, leads, roleFn, labelFn, spend,
   *   collectedBetween(startMs, endMs) → { total (dollars), count },
   *   owedCents, collectedByLead { leadId: dollars },
   *   expenses, reviewAsks, reviews, clicks
   * }
   */
  function weeklyReview(input) {
    var i = input || {};
    var now = i.nowMs || Date.now();
    var start = now - 7 * DAY;
    var leads = (i.leads || []).filter(counts);
    var roleFn = i.roleFn;

    var cash = null;
    if (typeof i.collectedBetween === 'function') {
      var c = i.collectedBetween(start, now) || {};
      cash = { collectedCents: dollarsToCents(c.total), payments: c.count || 0 };
    }

    var wins = leads.filter(function (l) { var t = isSale(l, roleFn) ? saleDateMs(l) : 0; return t >= start && t <= now; });
    var bookedWins = { count: wins.length, bookedCents: wins.reduce(function (s, l) { return s + bookedCents(l); }, 0), leads: wins };

    var newLeads = leads.filter(function (l) { var t = toMs(l.createdAt); return t >= start && t <= now; });
    var mlc = monthLeadCounts(i.leads || []);
    var allTable = sourceTable(i.leads || [], { collectedByLead: i.collectedByLead, spend: i.spend, roleFn: roleFn });
    var bySrc = {};
    newLeads.forEach(function (l) {
      var s = normalizeSource(l.source);
      var r = bySrc[s] || (bySrc[s] = { source: s, leads: 0, spendCents: 0, costPerWonCents: null });
      r.leads++;
      r.spendCents += leadCostOf(l, i.spend, mlc).cents;
    });
    Object.keys(bySrc).forEach(function (s) {
      var row = allTable.rows.filter(function (r) { return r.source === s; })[0];
      bySrc[s].costPerWonCents = row ? row.costPerWonCents : null;
    });
    var newBySource = Object.keys(bySrc).map(function (k) { return bySrc[k]; }).sort(function (a, b) { return b.leads - a.leads; });

    var thisWeek = rateBetween(leads, start, now + 1, roleFn);
    var prior4 = rateBetween(leads, start - 28 * DAY, start, roleFn);

    var stuck = stuckDeals(leads, now, roleFn, i.labelFn);

    var collected = i.collectedByLead || {};
    var cn = costsNeeded(leads, i.expenses || [], roleFn);
    var costedIds = {}; Object.keys(cn.costCentsByLead || {}).forEach(function (k) { costedIds[k] = 1; });
    var sales = leads.filter(function (l) { return isSale(l, roleFn); });
    var gaps = {
      noPayment: sales.filter(function (l) { return !(Number(collected[l.id]) > 0); }),
      noCost: sales.filter(function (l) { return !costedIds[l.id]; }),
      noPackage: sales.filter(function (l) { return !soldTierOf(l); }),
      paidNoCost: missingLeadCost(leads, i.spend).filter(function (x) { return !x.covered; }).map(function (x) { return x.lead; }),
      closeDates: sales.filter(function (l) { return needsCloseDate(l, roleFn); }),
      lostNoReason: leads.filter(function (l) { return isLostLead(l, roleFn) && !lostReasonKeyOf(l); })
    };

    var week = { asks: 0, reviews: 0, referredLeads: 0, referredWins: 0 };
    (i.reviewAsks || []).forEach(function (a) { var t = toMs(a && (a.at || a.sentAt)); if (t >= start && t <= now) week.asks++; });
    (i.reviews || []).forEach(function (r) { var t = r && typeof r.time === 'number' ? r.time * 1000 : toMs(r && r.at); if (t >= start && t <= now) week.reviews++; });
    leads.forEach(function (l) {
      if (!isReferred(l)) return;
      var t = toMs(l.createdAt); if (t >= start && t <= now) week.referredLeads++;
      if (isSale(l, roleFn)) { var s = saleDateMs(l); if (s >= start && s <= now) week.referredWins++; }
    });
    var mk = monthKey(now);
    week.clicksThisMonth = Number((i.clicks || {})[mk]) || 0;

    return {
      start: start, end: now, weekKey: weekKey(now),
      cash: cash,
      owedCents: typeof i.owedCents === 'number' ? i.owedCents : null,
      bookedWins: bookedWins,
      newLeads: { count: newLeads.length, bySource: newBySource },
      winRate: { week: thisWeek, prior4: prior4 },
      stuck: stuck,
      gaps: gaps,
      reviewsReferrals: week
    };
  }

  var api = {
    WON_KEYS: WON_KEYS, JOB_KEYS: JOB_KEYS, CONTRACT_SIGNED: CONTRACT_SIGNED,
    canonStage: canonStage, stageKeyOf: stageKeyOf, roleOf: roleOf, isSale: isSale, isLostLead: isLostLead,
    closeRate: closeRate, fmtRate: fmtRate,
    toMs: toMs, dollarsToCents: dollarsToCents, fmtMoney: fmtMoney, monthKey: monthKey, ymd: ymd, bookedCents: bookedCents,
    normalizeSource: normalizeSource, PAID_SOURCES: PAID_SOURCES, spendKey: spendKey, isPaidSource: isPaidSource,
    leadCostOf: leadCostOf, monthLeadCounts: monthLeadCounts, spendBySource: spendBySource, sourceTable: sourceTable,
    missingLeadCost: missingLeadCost, parseSpendCsv: parseSpendCsv,
    costsNeeded: costsNeeded, saleDateMs: saleDateMs, needsCloseDate: needsCloseDate,
    LOST_REASONS: LOST_REASONS, lostReasonLabel: lostReasonLabel, lostReasonKeyOf: lostReasonKeyOf,
    validateLostReason: validateLostReason, lostReasonFields: lostReasonFields, lossesByReason: lossesByReason,
    TIERS: TIERS, TIER_LABELS: TIER_LABELS, soldTierOf: soldTierOf, packageMix: packageMix,
    stormIdForYmd: stormIdForYmd, stormResults: stormResults,
    isReferred: isReferred, reviewsReferralsByMonth: reviewsReferralsByMonth, reviewAsksFromLeads: reviewAsksFromLeads,
    weekKey: weekKey, stuckDeals: stuckDeals, weeklyReview: weeklyReview,
    decidedAtMs: decidedAtMs, rateBetween: rateBetween
  };
  if (root) root.NBDNumbers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
