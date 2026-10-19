/**
 * job-cost-audit-logic.js — the pure rules behind the Job cost auditor
 * (2026-10-19). No DOM, no Firestore, no network: every function takes plain
 * data and returns plain data, so the browser panel (job-cost-audit.js) and the
 * agent tool (functions/agent-mcp-logic.js costAudit) read ONE definition.
 * functions/job-cost-audit-logic.js is a byte-identical copy
 * (tests/job-cost-audit-2026-10-19.test.js keeps the two equal).
 *
 * Why: finished jobs read ~100% margin because the sub / labor cost of the
 * independent crews was never logged. This file decides which jobs look wrong
 * and what the company's OWN other jobs say a sub typically costs.
 *
 * Rules of this file:
 *  - Money is integer cents. A percent is a number with one decimal at most.
 *  - Suggestions come ONLY from the company's own jobs that already have a real
 *    (non-estimated) sub / labor cost. Nothing here is an industry rate. Fewer
 *    than CONFIG.minPeers comparable jobs = no suggestion, an empty entry box.
 *  - Every threshold lives in CONFIG. Where the company has enough peers the
 *    threshold is the peers' own median +/- a spread; CONFIG holds only the
 *    fallback for when it does not.
 *  - A cost row counts only when it is a live (not deleted) DIRECT cost.
 *  - Estimated rows (estimated: true) count in margin but never feed peers.
 *
 * Exposed as window.NBDJobCostAudit and module.exports.
 */
(function (root) {
  'use strict';

  var CONFIG = {
    minPeers: 3,             // comparable jobs needed before any median is trusted
    minJobCents: 150000,     // "a job over $X" for the no-sub-cost flag ($1,500)
    highMarginPct: 90,       // fallback "too good to be true" margin
    pointsAboveMedian: 25,   // peers' median margin + this = too high
    pointsBelowMedian: 25,   // peers' median margin - this = too low
    lowMarginPct: 10,        // fallback "too thin" margin when there are no peers
    graceMs: 86400000,       // a cost dated this far before the customer existed
    marginPhases: ['finished'] // margin flags only where collected is the final money
  };

  var KINDS = ['materials', 'sub', 'labor', 'dumpster', 'permit', 'disposal', 'other'];
  var KIND_LABEL = {
    materials: 'Materials', sub: 'Sub labor', labor: 'Labor', dumpster: 'Dumpster',
    permit: 'Permit', disposal: 'Disposal', other: 'Other'
  };
  var CATEGORY_KIND = {
    materials: 'materials', subcontractor: 'sub', direct_labor: 'labor',
    equipment_dumpster: 'dumpster', permits_fees: 'permit', disposal: 'disposal'
  };

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function int(v) { var n = parseInt(v, 10); return isFinite(n) ? n : 0; }

  function toMs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (v instanceof Date) return v.getTime() || 0;
    if (typeof v.toDate === 'function') { var d = v.toDate(); return d ? d.getTime() || 0 : 0; }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    var t = new Date(v).getTime();
    return isFinite(t) ? t : 0;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function money(cents) {
    var n = Math.round(Math.abs(Number(cents) || 0) / 100);
    return (cents < 0 ? '-' : '') + '$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function round1(x) { return Math.round(x * 10) / 10; }
  function conf(c) { return Object.assign({}, CONFIG, c || {}); }

  // ── the cost rows ─────────────────────────────────────────────────────
  function centsOf(e) { return int(e && e.amountCents) + int(e && e.taxCents); }
  // A live DIRECT cost: not voided, not overhead, more than $0.
  function isLiveDirect(e) {
    return !!e && e.deleted !== true && e.costType === 'direct' && centsOf(e) > 0;
  }
  function kindOf(e) {
    var ak = e && e.auditKind;
    if (typeof ak === 'string' && KINDS.indexOf(ak) !== -1) return ak;
    var k = e && CATEGORY_KIND[e.category];
    return k || 'other';
  }
  function isSubLabor(kind) { return kind === 'sub' || kind === 'labor'; }

  /**
   * One job's money picture.
   * costs = the expense rows for the job (any state; dead rows are skipped).
   * → { collectedCents, directCents, byKind{}, subLaborCents, realSubLaborCents,
   *     estimatedCents, count, hasSubLabor, hasMaterials, marginPct|null }
   */
  function summarize(collectedCents, costs) {
    var collected = Math.max(0, int(collectedCents));
    var by = {}; KINDS.forEach(function (k) { by[k] = 0; });
    var direct = 0, est = 0, realSub = 0, count = 0;
    (costs || []).forEach(function (e) {
      if (!isLiveDirect(e)) return;
      var c = centsOf(e), k = kindOf(e);
      by[k] += c; direct += c; count++;
      if (e.estimated === true) est += c;
      else if (isSubLabor(k)) realSub += c;
    });
    var sub = by.sub + by.labor;
    return {
      collectedCents: collected, directCents: direct, byKind: by,
      subLaborCents: sub, realSubLaborCents: realSub, estimatedCents: est, count: count,
      // hasSubLabor = a REAL (not estimated) sub / labor cost. hasAnySub also counts
      // an estimate, so an estimate-only job is its own group, never "done".
      hasSubLabor: realSub > 0, hasAnySub: sub > 0, estimatedOnly: sub > 0 && realSub === 0,
      hasMaterials: by.materials > 0,
      marginPct: collected > 0 ? Math.round((collected - direct) / collected * 100) : null
    };
  }
  // A short fingerprint of the numbers a person looked at. "It's right" holds
  // only while this stays the same; a new cost or payment re-opens the card.
  function signature(s) { return s.directCents + ':' + s.collectedCents + ':' + s.count; }

  // ── trade + peers ─────────────────────────────────────────────────────
  function tradeKeyOf(lead) {
    var t = lead && lead.trades;
    if (!Array.isArray(t)) return 'general';
    var k = t.filter(function (x) { return typeof x === 'string' && x; })
      .map(function (x) { return x.toLowerCase(); }).sort();
    return k.length ? k.join('+') : 'general';
  }
  function squaresOf(lead) {
    var n = Number(lead && (lead.squares != null ? lead.squares : lead.totalSquares));
    return isFinite(n) && n > 0 ? n : 0;
  }

  function median(values) {
    var v = (values || []).filter(function (x) { return typeof x === 'number' && isFinite(x); }).sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  function stats(values) {
    var v = (values || []).filter(function (x) { return typeof x === 'number' && isFinite(x); });
    if (!v.length) return { n: 0, min: null, max: null, median: null };
    return { n: v.length, min: round1(Math.min.apply(null, v)), max: round1(Math.max.apply(null, v)), median: round1(median(v)) };
  }

  /**
   * jobs: [{ id, trade, squares, phase, settled, collectedCents, summary }]. A PEER
   * is a FINISHED job with nothing left owed (settled), money collected, a REAL
   * sub / labor cost AND materials logged: the only jobs whose margin is a whole
   * margin. A deposit-only job, an unpaid one or one with no materials would
   * teach the wrong median. Estimated costs never make a peer.
   */
  function buildPeers(jobs) {
    var out = [];
    (jobs || []).forEach(function (j) {
      var s = j && j.summary;
      if (!s || j.phase !== 'finished' || j.settled !== true) return;
      if (s.collectedCents <= 0 || s.realSubLaborCents <= 0 || !s.hasMaterials) return;
      var sq = j.squares > 0 ? j.squares : 0;
      out.push({
        id: j.id, trade: j.trade || 'general', collectedCents: s.collectedCents,
        marginPct: s.marginPct, subPct: round1(s.realSubLaborCents / s.collectedCents * 100),
        squares: sq, subPerSqCents: sq ? Math.round(s.realSubLaborCents / sq) : null
      });
    });
    return out;
  }
  function peersFor(peers, trade, excludeId) {
    return (peers || []).filter(function (p) { return p.trade === trade && p.id !== excludeId; });
  }

  /**
   * Suggestion for one job's sub cost, from the company's own similar jobs.
   * → { ok:false, n, message } when there are not enough comparable jobs;
   *   { ok:true, n, text, low, median, high: {pct, cents}, perSquare? } otherwise.
   * cents = pct of THIS job's collected money (0 when nothing is collected yet).
   */
  function suggest(peers, trade, job, config) {
    var c = conf(config), j = job || {};
    var same = peersFor(peers, trade, j.id);
    if (same.length < c.minPeers) {
      return {
        ok: false, n: same.length,
        message: same.length === 0
          ? 'No similar jobs have a sub cost logged yet, so there is nothing to compare. Enter it by hand.'
          : 'Only ' + same.length + ' similar job' + (same.length === 1 ? ' has' : 's have') + ' a sub cost logged (need ' + c.minPeers + '). Enter it by hand.'
      };
    }
    var st = stats(same.map(function (p) { return p.subPct; }));
    var collected = Math.max(0, int(j.collectedCents));
    var mk = function (pct) { return { pct: pct, cents: Math.round(collected * pct / 100) }; };
    var out = {
      ok: true, n: st.n, low: mk(st.min), median: mk(st.median), high: mk(st.max),
      text: 'Similar jobs: sub cost ' + st.min + '-' + st.max + '% of collected, median ' + st.median + '% (' + st.n + ' jobs)',
      noBase: collected <= 0
    };
    var sq = j.squares > 0 ? j.squares : 0;
    var withSq = same.filter(function (p) { return p.subPerSqCents != null; });
    if (sq && withSq.length >= c.minPeers) {
      var ps = stats(withSq.map(function (p) { return p.subPerSqCents; }));
      out.perSquare = {
        n: ps.n, lowCents: ps.min, medianCents: ps.median, highCents: ps.max,
        text: 'Per square: ' + money(ps.min) + '-' + money(ps.max) + ', median ' + money(ps.median) + ' (' + ps.n + ' jobs)',
        atMedianCents: Math.round(ps.median * sq)
      };
    }
    return out;
  }

  /** The margin band the company's own jobs set for this trade. */
  function thresholds(peers, trade, excludeId, config) {
    var c = conf(config);
    var same = peersFor(peers, trade, excludeId).filter(function (p) { return p.marginPct != null; });
    if (same.length >= c.minPeers) {
      var m = round1(median(same.map(function (p) { return p.marginPct; })));
      return { source: 'peers', n: same.length, medianMarginPct: m, highMarginPct: round1(m + c.pointsAboveMedian), lowMarginPct: round1(m - c.pointsBelowMedian) };
    }
    return { source: 'fallback', n: same.length, medianMarginPct: null, highMarginPct: c.highMarginPct, lowMarginPct: c.lowMarginPct };
  }

  // ── the checker ───────────────────────────────────────────────────────
  var SEV = { bad: 0, warn: 1, info: 2 };

  function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

  function duplicateGroups(costs) {
    var seen = {}, order = [];
    (costs || []).forEach(function (e) {
      if (!isLiveDirect(e)) return;
      var k = [e.category || '', centsOf(e), dayKey(toMs(e.date)), normName(e.supplier)].join('|');
      if (!seen[k]) { seen[k] = []; order.push(k); }
      seen[k].push(e);
    });
    return order.filter(function (k) { return seen[k].length > 1; }).map(function (k) { return seen[k]; });
  }

  /**
   * jobCostFlags(job, costs, peers, config) -> [{ code, severity, title, reason }]
   *   job   { id, collectedCents, createdMs, trade, phase }
   *   costs the job's expense rows
   *   peers buildPeers() output (any trade; the job itself is excluded)
   * Worst first. An empty list means nothing looks wrong.
   */
  function jobCostFlags(job, costs, peers, config) {
    var c = conf(config), j = job || {};
    var s = summarize(j.collectedCents, costs);
    var trade = j.trade || 'general';
    var th = thresholds(peers, trade, j.id, c);
    var flags = [];
    var add = function (code, severity, title, reason, extra) {
      flags.push(Object.assign({ code: code, severity: severity, title: title, reason: reason }, extra || {}));
    };
    var judge = c.marginPhases.indexOf(j.phase) !== -1;
    var m = s.marginPct;

    if (s.collectedCents <= 0 && s.directCents > 0) {
      add('costs_no_payment', 'info', 'Costs but no payment',
        money(s.directCents) + ' of costs are logged and no money has been collected on this job yet.');
    }
    if (judge && s.collectedCents > 0 && s.directCents > s.collectedCents) {
      add('negative_margin', 'bad', 'Lost money on paper',
        'Costs of ' + money(s.directCents) + ' are more than the ' + money(s.collectedCents) + ' collected (margin ' + m + '%).');
    }
    if (judge && s.collectedCents > 0 && s.subLaborCents > s.collectedCents) {
      add('sub_exceeds_collected', 'bad', 'Sub cost is more than the customer paid',
        'Sub / labor cost of ' + money(s.subLaborCents) + ' is more than the ' + money(s.collectedCents) + ' collected.');
    }
    var noSubHigh = false;
    if (judge && s.collectedCents >= c.minJobCents && !s.hasAnySub && m != null && m > c.highMarginPct) {
      noSubHigh = true;
      add('high_margin_no_sub', 'warn', 'Margin looks too good',
        'Margin is ' + m + '% on a ' + money(s.collectedCents) + ' job and no sub or labor cost is logged. A crew did this work.');
    }
    if (judge && !noSubHigh && m != null && s.collectedCents > 0 && m > th.highMarginPct) {
      add('margin_above_peers', 'warn', 'Margin is far above your other jobs',
        th.source === 'peers'
          ? 'Margin is ' + m + '%. Your other ' + trade + ' jobs sit around ' + th.medianMarginPct + '% (' + th.n + ' jobs), so anything over ' + th.highMarginPct + '% is worth a second look.'
          : 'Margin is ' + m + '%, over the ' + th.highMarginPct + '% check line.');
    }
    if (judge && m != null && m >= 0 && s.collectedCents > 0 && s.directCents > 0 && m < th.lowMarginPct) {
      add('margin_below_peers', 'warn', 'Margin is far below your other jobs',
        th.source === 'peers'
          ? 'Margin is ' + m + '%. Your other ' + trade + ' jobs sit around ' + th.medianMarginPct + '% (' + th.n + ' jobs), so under ' + th.lowMarginPct + '% is worth a second look.'
          : 'Margin is ' + m + '%, under the ' + th.lowMarginPct + '% check line.');
    }
    if (s.count > 0 && !s.hasMaterials && s.collectedCents > 0) {
      add('no_materials', 'info', 'No materials logged', 'Costs are logged but none is materials.');
    }
    duplicateGroups(costs).forEach(function (g) {
      add('duplicate_costs', 'warn', 'Possible duplicate cost',
        g.length + ' rows of ' + money(centsOf(g[0])) + (g[0].supplier ? ' from ' + String(g[0].supplier).slice(0, 40) : '') + ' on ' + dayKey(toMs(g[0].date)) + ' look the same.',
        { ids: g.map(function (e) { return e.id; }).filter(Boolean) });
    });
    if (j.createdMs) {
      var early = (costs || []).filter(function (e) {
        var t = toMs(e && e.date);
        return isLiveDirect(e) && t && t < j.createdMs - c.graceMs;
      });
      if (early.length) {
        var first = Math.min.apply(null, early.map(function (e) { return toMs(e.date); }));
        add('cost_before_job', 'warn', 'Cost dated before the job existed',
          early.length + ' cost' + (early.length === 1 ? ' is' : 's are') + ' dated ' + dayKey(first) + ', before this customer was added on ' + dayKey(j.createdMs) + '.',
          { ids: early.map(function (e) { return e.id; }).filter(Boolean) });
      }
    }
    flags.sort(function (a, b) { return SEV[a.severity] - SEV[b.severity]; });
    return flags;
  }

  // The audit marker on a lead: { complete, completeBy, completeAt, asked{kind:answer}, ack{code:sig} }.
  // Flags the owner called "right" stay quiet while the numbers are unchanged.
  function applyAcks(flags, audit, summary) {
    var ack = (audit && audit.ack) || {};
    var sig = signature(summary);
    return (flags || []).filter(function (f) { return ack[f.code] !== sig; });
  }

  // "Costs complete" and Skip / Unsure hold only while the numbers they were given
  // on hold (signature). "Not applicable" is a deliberate answer and stays.
  function isComplete(audit, summary) {
    return !!audit && audit.complete === true && audit.completeSig === signature(summary);
  }
  function askedValue(answer, summary) { return answer === 'na' ? 'na' : answer + '@' + signature(summary); }
  function askedAnswer(audit, key, summary) {
    var v = audit && audit.asked && audit.asked[key];
    if (v === 'na') return 'na';
    if (typeof v !== 'string') return null;
    var i = v.indexOf('@');
    return i > 0 && v.slice(i + 1) === signature(summary) ? v.slice(0, i) : null;
  }
  // One phase rule for the panel and the agent tool. role = the stage role
  // (won / job / lost / other); the unit is the lead.
  function phaseFor(role, collectedCents) {
    if (role === 'lost') return null;
    if (role === 'won') return 'finished';
    if (role === 'job') return 'production';
    return collectedCents > 0 ? 'signed' : null;
  }

  // ── the queue ─────────────────────────────────────────────────────────
  var GROUPS = [
    { key: 'too_low', label: 'Margin looks too low or negative' },
    { key: 'too_high', label: 'Margin looks too high' },
    { key: 'no_payment', label: 'Costs but no payment' },
    { key: 'no_sub', label: 'No labor / sub cost logged' },
    { key: 'estimated_only', label: 'Only an estimated sub cost' },
    { key: 'no_materials', label: 'No materials logged' },
    { key: 'other', label: 'Other things to check' }
  ];
  var FLAG_GROUP = {
    negative_margin: 'too_low', sub_exceeds_collected: 'too_low', margin_below_peers: 'too_low',
    high_margin_no_sub: 'too_high', margin_above_peers: 'too_high',
    costs_no_payment: 'no_payment', duplicate_costs: 'other', cost_before_job: 'other'
  };

  /**
   * One queue row for a job, or null when the job is not in the queue.
   * job: { id, name, phase, collectedCents, createdMs, trade, squares, audit }
   * A job marked "costs complete" is out of the queue.
   */
  function auditRow(job, costs, peers, config) {
    var j = job || {};
    var audit = j.audit || {};
    var s = summarize(j.collectedCents, costs);
    if (isComplete(audit, s)) return null;
    var flags = applyAcks(jobCostFlags(j, costs, peers, config), audit, s);
    var groups = [];
    var add = function (g) { if (groups.indexOf(g) === -1) groups.push(g); };
    flags.forEach(function (f) { if (FLAG_GROUP[f.code]) add(FLAG_GROUP[f.code]); });
    if (!s.hasAnySub && askedAnswer(audit, 'sub', s) !== 'na') add('no_sub');
    if (s.estimatedOnly) add('estimated_only');
    if (!s.hasMaterials && askedAnswer(audit, 'materials', s) !== 'na') add('no_materials');
    // "no materials" as a flag card is redundant with its group
    flags = flags.filter(function (f) { return f.code !== 'no_materials'; });
    if (!groups.length) return null;
    var rank = GROUPS.map(function (g) { return g.key; });
    groups.sort(function (a, b) { return rank.indexOf(a) - rank.indexOf(b); });
    return {
      id: j.id, name: j.name, phase: j.phase, trade: j.trade || 'general',
      summary: s, flags: flags, groups: groups, primary: groups[0],
      estimatedOnly: s.estimatedOnly
    };
  }

  /** jobs -> { rows[], counts{group:n}, total }. costsByLead: { leadId: [expense] }. */
  function auditQueue(jobs, costsByLead, peers, config) {
    var rows = [], counts = {};
    GROUPS.forEach(function (g) { counts[g.key] = 0; });
    (jobs || []).forEach(function (j) {
      var r = auditRow(j, (costsByLead || {})[j.id] || [], peers, config);
      if (!r) return;
      rows.push(r);
      r.groups.forEach(function (g) { counts[g]++; });
    });
    return { rows: rows, counts: counts, total: rows.length };
  }

  /** Search + group filter + sort over queue rows. */
  function filterRows(rows, opts) {
    var o = opts || {};
    var q = String(o.query || '').trim().toLowerCase();
    var out = (rows || []).filter(function (r) {
      if (o.group && o.group !== 'all' && r.groups.indexOf(o.group) === -1) return false;
      if (o.phase && o.phase !== 'all' && r.phase !== o.phase) return false;
      if (q && String(r.name || '').toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var by = {
      collected: function (a, b) { return b.summary.collectedCents - a.summary.collectedCents; },
      margin: function (a, b) {
        var x = a.summary.marginPct, y = b.summary.marginPct;
        return (y == null ? -1e9 : y) - (x == null ? -1e9 : x);
      },
      name: function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); },
      worst: function (a, b) {
        var ra = a.flags.length ? SEV[a.flags[0].severity] : 3, rb = b.flags.length ? SEV[b.flags[0].severity] : 3;
        return (ra - rb) || (b.summary.collectedCents - a.summary.collectedCents);
      }
    };
    return out.sort(by[o.sort] || by.worst);
  }

  /** "Ask me" questions for a job, skipping what is already known or answered. */
  var QUESTIONS = [
    { key: 'sub', text: 'Did a sub do this one? Who, and about how much?', kind: 'sub' },
    { key: 'dumpster', text: 'Was there a dumpster or dump fee?', kind: 'dumpster' },
    { key: 'permit', text: 'Was there a permit?', kind: 'permit' },
    { key: 'disposal', text: 'Any disposal or tear-off haul-away fee?', kind: 'disposal' },
    { key: 'materials', text: 'Are all the material receipts in?', kind: 'materials' }
  ];
  function nextQuestion(summary, audit) {
    var open = QUESTIONS.filter(function (q) {
      var have = q.key === 'sub' ? summary.hasAnySub : summary.byKind[q.kind] > 0;
      return !have && !askedAnswer(audit, q.key, summary);
    });
    return open.length ? open[0] : null;
  }

  var API = {
    CONFIG: CONFIG, KINDS: KINDS, KIND_LABEL: KIND_LABEL, GROUPS: GROUPS, QUESTIONS: QUESTIONS,
    centsOf: centsOf, isLiveDirect: isLiveDirect, kindOf: kindOf, summarize: summarize, signature: signature,
    tradeKeyOf: tradeKeyOf, squaresOf: squaresOf, median: median, stats: stats,
    buildPeers: buildPeers, peersFor: peersFor, suggest: suggest, thresholds: thresholds,
    jobCostFlags: jobCostFlags, applyAcks: applyAcks, isComplete: isComplete, askedValue: askedValue, askedAnswer: askedAnswer, phaseFor: phaseFor, auditRow: auditRow, auditQueue: auditQueue,
    filterRows: filterRows, nextQuestion: nextQuestion, money: money
  };
  if (root && typeof root === 'object') root.NBDJobCostAudit = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : null);
