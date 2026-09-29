/**
 * NBD Pro — Analytics KPI Engine
 * Computes real-time business metrics from Firestore data.
 *
 * 1. renderKPIRow()  — compact KPI row on the Home dashboard view
 * 2. AnalyticsKPI.init() / .render(containerId) — full Analytics dashboard
 *
 * Data sources (all user-scoped):
 *   leads, estimates, photos, invoices, knocks, tasks
 *
 * Exposes: window.renderKPIRow(), window.computeKPIs(), window.AnalyticsKPI
 */

(function () {
  'use strict';

  // Defense-in-depth HTML escaper — this module builds DOM via string
  // concatenation into innerHTML and renders lead.source (which can be
  // public-sourced via public lead forms), so unescaped values are a
  // stored-XSS vector against the rep viewing the dashboard.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c];
    });
  }

  // ── Stage classifications ──
  // 2026-09-15: added 'collections' (Collections lane), then 'warranty_claim'
  // (Warranty Claim lane, same day) — this is only the fallback for a lead
  // with no _stageRole stamped yet, per the comment below, so it still needs
  // to stay current.
  const WON_STAGES = [
    'closed', 'install_complete', 'final_photos',
    'final_payment', 'deductible_collected', 'collections', 'warranty_claim', 'Complete'
  ];
  const LOST_STAGES = ['lost', 'Lost'];

  // Role-aware classification (freeform-pipeline foundation): prefer the
  // denormalized _stageRole stamped at load (custom-stage-safe), and fall back
  // to the legacy key lists for any un-stamped lead. WON_STAGES/LOST_STAGES
  // above are the fallback set (identical behaviour for built-in stages).
  function _isWon(l)     { return l && l._stageRole ? l._stageRole === 'won'  : WON_STAGES.includes((l && (l._stageKey || l.stage)) || ''); }
  function _isLost(l)    { return l && l._stageRole ? l._stageRole === 'lost' : LOST_STAGES.includes((l && (l._stageKey || l.stage)) || ''); }
  function _isDecided(l) { return _isWon(l) || _isLost(l); }
  // Metrics audit F8: 'job' role = in production — the deal is won and the
  // crew is working. That money belongs with closed revenue (crm-pipeline
  // already counts it there), NOT in "Active Pipeline". Same role resolution
  // as crm-pipeline's overdue-followup fix (#12).
  function _isJob(l) {
    var r = l && (l._stageRole
      || (typeof window.stageRole === 'function' ? window.stageRole(l._stageKey || l.stage) : ''));
    return r === 'job';
  }
  // Metrics audit F8: closed-won money = role won OR job (in production).
  function _isClosedWon(l) { return _isWon(l) || _isJob(l); }

  // ── Date helpers ──
  function toJSDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    if (v.seconds) return new Date(v.seconds * 1000);
    if (typeof v === 'string' || typeof v === 'number') return new Date(v);
    if (v instanceof Date) return v;
    return null;
  }

  function monthKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function monthLabel(key) {
    const [y, m] = key.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[parseInt(m, 10) - 1] + ' ' + y;
  }

  function formatCurrency(n) {
    if (n >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
    return '$' + Math.round(n).toLocaleString();
  }

  function formatNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'K';
    return Math.round(n).toLocaleString();
  }

  function pct(num, den) {
    return den > 0 ? Math.round((num / den) * 100) : 0;
  }

  // ── Invoice cash-collected helpers (cash basis) ──
  // Mirror money-dashboard.js so #/analytics agrees with the #/money Collected
  // card. Prefer inv.payments[] (one entry per credit with its own date) so a
  // deposit in May and a balance payoff in July land in different months.
  // Legacy docs without the array fall back to a single lump of
  // total−balanceDue dated by lastPaymentAt||paidAt.
  function collectedDollarsOf(inv) {
    var total = parseFloat(inv.total) || 0;
    var bal = (inv.balanceDue != null) ? (parseFloat(inv.balanceDue) || 0) : 0;
    return Math.round(Math.max(0, total - bal) * 100) / 100;
  }
  // TRANSITION RECONCILIATION (mirrors money-dashboard.paymentsOf): a
  // pre-ledger partial (before the 2026-07-19 deploy) never got a payments[]
  // entry, so a post-deploy credit leaves the ledger summing SHORT of the
  // invoice's actual collected cash — trusting the ledger alone silently
  // drops the earlier cash. Append one synthetic remainder entry (dated at
  // the EARLIEST ledger entry — tightest upper bound; lastPaymentAt is the
  // newest credit, strictly later) so totals stay exact.
  function paymentsOf(inv) {
    if (Array.isArray(inv.payments) && inv.payments.length > 0) {
      var out = [];
      var ledgerCents = 0;
      var earliestAt = null, earliestMs = Infinity;
      for (var i = 0; i < inv.payments.length; i++) {
        var p = inv.payments[i] || {};
        var amt = parseFloat(p.amount);
        var at = p.at != null ? p.at : p.date;
        if (!(amt > 0) || at == null) continue;
        out.push({ amount: amt, at: at });
        ledgerCents += Math.round(amt * 100);
        var d = toJSDate(at);
        if (d && d.getTime() < earliestMs) { earliestMs = d.getTime(); earliestAt = at; }
      }
      if (out.length) {
        var actualCents = Math.round(collectedDollarsOf(inv) * 100);
        var remainderCents = actualCents - ledgerCents;
        if (remainderCents >= 1) {
          var remAt = earliestAt != null ? earliestAt
            : (inv.lastPaymentAt != null ? inv.lastPaymentAt : inv.paidAt);
          if (remAt != null) out.push({ amount: remainderCents / 100, at: remAt, synthetic: true });
        }
        return out;
      }
    }
    var collected = collectedDollarsOf(inv);
    if (collected <= 0) return [];
    var payDate = inv.lastPaymentAt != null ? inv.lastPaymentAt : inv.paidAt;
    if (payDate == null) return [];
    return [{ amount: collected, at: payDate }];
  }
  // Latest payment date (UI / "has any payment" checks). Null = never paid.
  function paymentDateOf(inv) {
    var pays = paymentsOf(inv);
    if (!pays.length) return null;
    var latest = pays[0].at;
    for (var i = 1; i < pays.length; i++) {
      var a = toJSDate(pays[i].at), b = toJSDate(latest);
      if (a && (!b || a.getTime() > b.getTime())) latest = pays[i].at;
    }
    return latest;
  }

  // ════════════════════════════════════════════
  // HOME KPI ROW (existing functionality)
  // ════════════════════════════════════════════

  function computeKPIs() {
    var leads = window._leads || [];
    var estimates = window._estimates || [];
    var now = new Date();
    var thisMonth = now.getMonth();
    var thisYear = now.getFullYear();
    var today = new Date(); today.setHours(0, 0, 0, 0);

    // F8: active = still in play — not won, not lost, not in production.
    var activeLeads = leads.filter(function (l) {
      return !_isDecided(l) && !_isJob(l) && !l.deleted;
    });
    var pipelineValue = activeLeads.reduce(function (sum, l) {
      return sum + (parseFloat(l.jobValue) || 0);
    }, 0);

    var closedThisMonth = leads.filter(function (l) {
      if (!_isClosedWon(l)) return false;
      // F3: stageStartedAt is stamped on every stage move (+ backfilled by
      // migrations 002/003) — for a won lead it IS the close date. The old
      // updatedAt proxy re-attributed a March close to July the moment you
      // added a note to it.
      var d = toJSDate(l.stageStartedAt || l.updatedAt);
      return d && d.getMonth() === thisMonth && d.getFullYear() === thisYear;
    });
    var monthlyRevenue = closedThisMonth.reduce(function (sum, l) {
      return sum + (parseFloat(l.jobValue) || 0);
    }, 0);

    var totalClosed = leads.filter(function (l) {
      return _isClosedWon(l);
    }).length;
    var totalLost = leads.filter(function (l) {
      return _isLost(l);
    }).length;
    var totalDecided = totalClosed + totalLost;
    var closeRate = totalDecided > 0 ? Math.round((totalClosed / totalDecided) * 100) : 0;

    var leadsThisMonth = leads.filter(function (l) {
      var d = toJSDate(l.createdAt);
      return d && d.getMonth() === thisMonth && d.getFullYear() === thisYear;
    }).length;

    // F7: skip in-production (job-role) leads too — aligned with the CRM's
    // overdue-followup definition (#12). A crew-scheduled job isn't a
    // follow-up you're late on.
    var overdueFollowUps = leads.filter(function (l) {
      if (_isDecided(l) || _isJob(l) || !l.followUp) return false;
      // Local day ('YYYY-MM-DD' parses as UTC — a day early in the US).
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(l.followUp));
      var d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(l.followUp); d.setHours(0, 0, 0, 0);
      return d < today;
    }).length;

    var closedWithValue = leads.filter(function (l) {
      return _isClosedWon(l) && parseFloat(l.jobValue) > 0;
    });
    var avgDealSize = closedWithValue.length > 0
      ? closedWithValue.reduce(function (s, l) { return s + parseFloat(l.jobValue); }, 0) / closedWithValue.length
      : 0;

    var sourceMap = {};
    leads.filter(function (l) { return !l.deleted; }).forEach(function (l) {
      var src = l.source || 'Unknown';
      sourceMap[src] = (sourceMap[src] || 0) + 1;
    });
    var topSource = Object.entries(sourceMap).sort(function (a, b) { return b[1] - a[1]; })[0];

    return {
      pipelineValue: pipelineValue,
      monthlyRevenue: monthlyRevenue,
      closeRate: closeRate,
      leadsThisMonth: leadsThisMonth,
      overdueFollowUps: overdueFollowUps,
      avgDealSize: avgDealSize,
      activeLeadCount: activeLeads.length,
      closedThisMonthCount: closedThisMonth.length,
      topSource: topSource ? topSource[0] : 'N/A',
      topSourceCount: topSource ? topSource[1] : 0
    };
  }

  function renderKPIRow() {
    var container = document.getElementById('kpiRow');
    if (!container) return;

    var k = computeKPIs();
    // Revenue This Month = money COLLECTED this month (Jo, 2026-09-28:
    // "Revenue is always collected only"). k.monthlyRevenue is the jobValue of
    // leads that CLOSED this month — booked, not banked — so it no longer
    // fills this card. Shared invoice cache; '…' until the first load lands.
    var _R = window.NBDRevenue, _invs = _R ? _R.cached() : null;
    if (_R && !_invs) _R.loadInvoices().then(function () { if (_R.cached() && document.getElementById('kpiRow')) renderKPIRow(); });
    var _now = new Date();
    var _collectedMonth = _invs ? _R.collectedBetween(_invs, new Date(_now.getFullYear(), _now.getMonth(), 1).getTime(), _now.getTime()).total : null;

    // Every card routes somewhere (data-ak-action="goTo" + data-ak-target,
    // dispatched by the delegate at the bottom of this file). These cards
    // shipped with no click handler at all — on mobile they're the primary
    // dashboard surface, and tapping them silently did nothing.
    container.innerHTML =
      '<div class="kpi-grid">' +
        '<div class="kpi-card kpi-primary" data-ak-action="goTo" data-ak-target="crm" role="button" title="Open pipeline" style="cursor:pointer;">' +
          '<div class="kpi-icon">💰</div>' +
          '<div class="kpi-data">' +
            '<div class="kpi-value">$' + formatNum(k.pipelineValue) + '</div>' +
            '<div class="kpi-label">Active Pipeline</div>' +
            '<div class="kpi-sub">' + k.activeLeadCount + ' active leads</div>' +
          '</div>' +
        '</div>' +
        '<div class="kpi-card kpi-green" data-ak-action="goTo" data-ak-target="money" role="button" title="Open Money dashboard" style="cursor:pointer;">' +
          '<div class="kpi-icon">📈</div>' +
          '<div class="kpi-data">' +
            '<div class="kpi-value">' + (_collectedMonth == null ? '…' : '$' + formatNum(_collectedMonth)) + '</div>' +
            '<div class="kpi-label">Revenue This Month</div>' +
            '<div class="kpi-sub">Collected · ' + k.closedThisMonthCount + ' closed ($' + formatNum(k.monthlyRevenue) + ' booked)</div>' +
          '</div>' +
        '</div>' +
        '<div class="kpi-card" data-ak-action="goTo" data-ak-target="board" role="button" title="Open analytics" style="cursor:pointer;">' +
          '<div class="kpi-icon">🎯</div>' +
          '<div class="kpi-data">' +
            '<div class="kpi-value">' + k.closeRate + '%</div>' +
            '<div class="kpi-label">Close Rate</div>' +
            '<div class="kpi-sub">Avg deal $' + formatNum(k.avgDealSize) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="kpi-card" data-ak-action="goTo" data-ak-target="crm" role="button" title="Open pipeline" style="cursor:pointer;">' +
          '<div class="kpi-icon">🆕</div>' +
          '<div class="kpi-data">' +
            '<div class="kpi-value">' + k.leadsThisMonth + '</div>' +
            '<div class="kpi-label">New Leads</div>' +
            '<div class="kpi-sub">Top: ' + esc(k.topSource) + '</div>' +
          '</div>' +
        '</div>' +
        (k.overdueFollowUps > 0
          ? '<div class="kpi-card kpi-warning" data-ak-action="scrollToFollowUps" style="cursor:pointer;">' +
              '<div class="kpi-icon">⚠️</div>' +
              '<div class="kpi-data">' +
                '<div class="kpi-value">' + k.overdueFollowUps + '</div>' +
                '<div class="kpi-label">Overdue Follow-Ups</div>' +
                '<div class="kpi-sub">Click to view</div>' +
              '</div>' +
            '</div>'
          : '') +
      '</div>';
  }

  // ════════════════════════════════════════════
  // FULL ANALYTICS DASHBOARD (new)
  // ════════════════════════════════════════════

  var _analyticsCache = {
    leads: [], estimates: [], invoices: [],
    knocks: [], photos: [], tasks: [],
    loaded: false
  };

  /**
   * Fetch all user-scoped collections from Firestore.
   * Uses window._leads / window._estimates if already loaded,
   * otherwise queries Firestore directly.
   */
  async function fetchAllData() {
    var db = window._db || window.db;
    var uid = window._user?.uid;
    if (!db || !uid) return _analyticsCache;

    // Use cached in-memory data for leads/estimates (already loaded by dashboard)
    _analyticsCache.leads = window._leads || [];
    _analyticsCache.estimates = window._estimates || [];

    var qFn = window.query;
    var colFn = window.collection;
    var whereFn = window.where;
    var getDocsFn = window.getDocs;

    if (!qFn || !colFn || !whereFn || !getDocsFn) return _analyticsCache;

    // Fetch invoices, knocks, photos, tasks in parallel
    var fetchers = [
      // invoices (createdBy field)
      getDocsFn(qFn(colFn(db, 'invoices'), whereFn('createdBy', '==', uid)))
        .then(function (snap) {
          _analyticsCache.invoices = snap.docs.map(function (d) {
            return Object.assign({ id: d.id }, d.data());
          });
        })
        .catch(function () { _analyticsCache.invoices = []; }),

      // knocks (userId field)
      getDocsFn(qFn(colFn(db, 'knocks'), whereFn('userId', '==', uid)))
        .then(function (snap) {
          _analyticsCache.knocks = snap.docs.map(function (d) {
            return Object.assign({ id: d.id }, d.data());
          });
        })
        .catch(function () { _analyticsCache.knocks = []; }),

      // photos (userId field)
      getDocsFn(qFn(colFn(db, 'photos'), whereFn('userId', '==', uid)))
        .then(function (snap) {
          _analyticsCache.photos = snap.docs.map(function (d) {
            return Object.assign({ id: d.id }, d.data());
          });
        })
        .catch(function () { _analyticsCache.photos = []; }),

      // expenses — rule-safe scope: company_admin/manager read the whole tenant
      // (companyId); everyone else reads their own (userId). Querying companyId
      // as a non-staff user is permission-denied (see firestore.rules).
      (function () {
        var claims = window._userClaims || {};
        var staff = claims.role === 'company_admin' || claims.role === 'manager' || claims.role === 'admin';
        var q = (staff && claims.companyId)
          ? qFn(colFn(db, 'expenses'), whereFn('companyId', '==', claims.companyId))
          : qFn(colFn(db, 'expenses'), whereFn('userId', '==', uid));
        return getDocsFn(q)
          .then(function (snap) {
            _analyticsCache.expenses = snap.docs.map(function (d) {
              return Object.assign({ id: d.id }, d.data());
            });
          })
          .catch(function () { _analyticsCache.expenses = []; });
      })()
    ];

    await Promise.all(fetchers);
    _analyticsCache.loaded = true;
    // Expose knocks globally for rep-report-generator.js knock metrics
    // (knocks-to-deal, time-of-day heatmap, revenue-per-knock, top-cities).
    // This is the Board-view path; rep-report-generator also loads knocks
    // on demand (ensureKnocks) so Reports works without visiting Board first.
    window._knocks = _analyticsCache.knocks;
    return _analyticsCache;
  }

  /**
   * Compute the full set of analytics metrics.
   */
  function computeFullAnalytics(data) {
    var leads = data.leads || [];
    var invoices = data.invoices || [];
    var knocks = data.knocks || [];
    var photos = data.photos || [];
    var estimates = data.estimates || [];
    var expenses = data.expenses || [];

    var now = new Date();
    var thisMonth = now.getMonth();
    var thisYear = now.getFullYear();

    // ── Revenue collected (cash basis) ──
    // Sum EACH payment by amount (not face value). Multi-payment invoices use
    // inv.payments[]; legacy docs use total−balanceDue dated lastPaymentAt||paidAt.
    // Gating on status==='paid' && paidAt alone still hides open-job deposits.
    var totalRevenue = 0;
    invoices.forEach(function (inv) {
      paymentsOf(inv).forEach(function (p) {
        totalRevenue += parseFloat(p.amount) || 0;
      });
    });
    // Round once so float cents don't drift vs money-dashboard's integer cents.
    totalRevenue = Math.round(totalRevenue * 100) / 100;
    var collectedInvoices = invoices.filter(function (inv) {
      return paymentDateOf(inv) != null;
    });
    // Count of FULLY-paid invoices, for the "N paid invoices" sub-label (a
    // partial deposit is still outstanding and is counted below, not here).
    var paidInvoices = invoices.filter(function (inv) {
      return inv.status === 'paid';
    });

    var unpaidInvoices = invoices.filter(function (inv) {
      return inv.status !== 'paid';
    });
    var unpaidAmount = unpaidInvoices.reduce(function (sum, inv) {
      return sum + (parseFloat(inv.balanceDue) || parseFloat(inv.total) || 0);
    }, 0);

    // ── Pipeline value from active leads ──
    var activeLeads = leads.filter(function (l) {
      return !_isDecided(l) && !l.deleted;
    });
    var pipelineValue = activeLeads.reduce(function (sum, l) {
      return sum + (parseFloat(l.jobValue) || 0);
    }, 0);

    // ── Conversion rate ──
    var wonLeads = leads.filter(function (l) {
      return _isWon(l);
    });
    var lostLeads = leads.filter(function (l) {
      return _isLost(l);
    });
    var totalDecided = wonLeads.length + lostLeads.length;
    var nonDeleted = leads.filter(function (l) { return !l.deleted; });
    var conversionRate = pct(wonLeads.length, totalDecided);

    // ── Average deal size ──
    var wonWithValue = wonLeads.filter(function (l) { return parseFloat(l.jobValue) > 0; });
    var avgDealSize = wonWithValue.length > 0
      ? wonWithValue.reduce(function (s, l) { return s + parseFloat(l.jobValue); }, 0) / wonWithValue.length
      : 0;

    // ── Estimates ──
    var totalEstimates = estimates.length;
    // Two-shape read. This laddered total -> grandTotal and stopped, with no
    // `amount` rung, so Classic estimates contributed 0 to the numerator while
    // still counting in totalEstimates below — dragging the "Avg value" label
    // down twice over.
    var _estValue = (window.NBDCustomerEstimateRows && window.NBDCustomerEstimateRows.estimateValue)
      || function (e) {
        if (!e) return 0;
        var v = e.grandTotal != null ? e.grandTotal
          : e.total != null ? e.total
          : e.amount != null ? e.amount : 0;
        var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.-]/g, ''));
        return isFinite(n) ? n : 0;
      };
    var estTotalValue = estimates.reduce(function (sum, e) {
      return sum + _estValue(e);
    }, 0);
    var avgEstimateValue = totalEstimates > 0 ? estTotalValue / totalEstimates : 0;

    // ── Leads by stage ──
    var stageMap = {};
    nonDeleted.forEach(function (l) {
      var st = l._stageKey || l.stage || 'new';
      stageMap[st] = (stageMap[st] || 0) + 1;
    });

    // ── Leads by source ──
    var sourceMap = {};
    nonDeleted.forEach(function (l) {
      var src = l.source || 'Unknown';
      sourceMap[src] = (sourceMap[src] || 0) + 1;
    });

    // ── Monthly trend (last 6 months) ──
    var monthlyTrend = {};
    for (var i = 5; i >= 0; i--) {
      var d = new Date(thisYear, thisMonth - i, 1);
      monthlyTrend[monthKey(d)] = { leads: 0, closed: 0, revenue: 0 };
    }
    nonDeleted.forEach(function (l) {
      var cd = toJSDate(l.createdAt);
      if (cd) {
        var mk = monthKey(cd);
        if (monthlyTrend[mk]) monthlyTrend[mk].leads++;
      }
    });
    wonLeads.forEach(function (l) {
      // stageStartedAt is stamped on every stage move (+ backfilled by
      // migrations 002/003) — for a won lead it IS the close date. Same
      // fallback closedThisMonth uses (F3); this chart was missed when that
      // one was fixed, so until now ANY later write to a won lead — a note, an
      // address repair, a list re-save — moved its revenue out of the month it
      // actually closed in and into the month of the edit.
      var ud = toJSDate(l.stageStartedAt || l.updatedAt);
      if (ud) {
        var mk = monthKey(ud);
        if (monthlyTrend[mk]) monthlyTrend[mk].closed++;
      }
    });
    // Revenue bars = money COLLECTED in each month (payment date), not the
    // closed jobs' jobValue (Jo, 2026-09-28: revenue is collected only).
    invoices.forEach(function (inv) {
      paymentsOf(inv).forEach(function (p) {
        var pd = toJSDate(p.at);
        if (!pd) return;
        var mk = monthKey(pd);
        if (monthlyTrend[mk]) monthlyTrend[mk].revenue += parseFloat(p.amount) || 0;
      });
    });
    Object.keys(monthlyTrend).forEach(function (k) { monthlyTrend[k].revenue = Math.round(monthlyTrend[k].revenue * 100) / 100; });

    // ── D2D efficiency ──
    var totalKnocks = knocks.length;
    var appointments = knocks.filter(function (k) {
      return k.disposition === 'appointment' || k.stage === 'appointment';
    }).length;
    var knockToAppt = pct(appointments, totalKnocks);

    // ── Photo documentation ──
    var totalPhotos = photos.length;
    var leadsWithPhotos = new Set(photos.map(function (p) { return p.leadId; }).filter(Boolean));
    var photoPerLead = nonDeleted.length > 0
      ? (totalPhotos / nonDeleted.length).toFixed(1)
      : '0';

    // ── This month's collected cash ──
    // Attribute each payment to the month it was received (not the latest
    // payment date on the invoice), so a May deposit stays in May after a
    // July balance payoff overwrites lastPaymentAt.
    var monthRevenue = 0;
    invoices.forEach(function (inv) {
      paymentsOf(inv).forEach(function (p) {
        var pd = toJSDate(p.at);
        if (pd && pd.getMonth() === thisMonth && pd.getFullYear() === thisYear) {
          monthRevenue += parseFloat(p.amount) || 0;
        }
      });
    });
    monthRevenue = Math.round(monthRevenue * 100) / 100;

    // ── Expense / supplier-spend metrics ──
    // costType is denormalized on each expense doc, so no ExpenseConfig needed.
    // Gross margin uses the SAME basis as the per-job Expenses view (jobValue),
    // computed over won jobs that have logged direct costs — never paid-invoice
    // revenue (that would be a different basis and lie).
    var directByJob = {};       // leadId -> direct cents
    var expTotalCents = 0, expDirectCents = 0, expOverheadCents = 0, expMonthCents = 0;
    var supplierCents = {};
    expenses.forEach(function (e) {
      var c = parseInt(e.amountCents, 10) || 0;
      expTotalCents += c;
      var direct = e.costType === 'direct';
      if (direct) expDirectCents += c; else expOverheadCents += c;
      var ed = toJSDate(e.date);
      if (ed && ed.getMonth() === thisMonth && ed.getFullYear() === thisYear) expMonthCents += c;
      var sup = (e.supplier || '').trim() || 'Unknown';
      supplierCents[sup] = (supplierCents[sup] || 0) + c;
      if (direct && e.leadId) directByJob[e.leadId] = (directByJob[e.leadId] || 0) + c;
    });
    // Won-job gross margin (jobValue basis). ONLY count jobs that have logged
    // direct costs — including uncosted jobs (revenue, $0 cost) would inflate
    // the margin and lie. The sub-label shows "N of M costed" for honesty.
    var wonRev = 0, wonDirect = 0, costedJobs = 0;
    wonLeads.forEach(function (l) {
      var rev = parseFloat(l.jobValue) || 0;
      var dc = (directByJob[l.id] || 0) / 100;
      if (rev > 0 && dc > 0) { wonRev += rev; wonDirect += dc; costedJobs += 1; }
    });
    var expGrossMargin = wonRev > 0 ? Math.round(((wonRev - wonDirect) / wonRev) * 100) : null;
    var supplierLeaderboard = Object.keys(supplierCents).map(function (k) {
      return { supplier: k, cents: supplierCents[k] };
    }).sort(function (a, b) { return b.cents - a.cents; }).slice(0, 6);

    return {
      totalRevenue: totalRevenue,
      monthRevenue: monthRevenue,
      expTotalDollars: expTotalCents / 100,
      expDirectDollars: expDirectCents / 100,
      expOverheadDollars: expOverheadCents / 100,
      expMonthDollars: expMonthCents / 100,
      expGrossMargin: expGrossMargin,
      expCostedJobs: costedJobs,
      expWonJobs: wonLeads.length,
      expSupplierLeaderboard: supplierLeaderboard,
      unpaidAmount: unpaidAmount,
      pipelineValue: pipelineValue,
      conversionRate: conversionRate,
      avgDealSize: avgDealSize,
      totalLeads: nonDeleted.length,
      activeLeadCount: activeLeads.length,
      wonCount: wonLeads.length,
      lostCount: lostLeads.length,
      totalEstimates: totalEstimates,
      avgEstimateValue: avgEstimateValue,
      stageMap: stageMap,
      sourceMap: sourceMap,
      monthlyTrend: monthlyTrend,
      totalKnocks: totalKnocks,
      appointments: appointments,
      knockToAppt: knockToAppt,
      totalPhotos: totalPhotos,
      leadsWithPhotos: leadsWithPhotos.size,
      photoPerLead: photoPerLead,
      invoiceCount: invoices.length,
      paidCount: paidInvoices.length,
      unpaidCount: unpaidInvoices.length
    };
  }

  // ── CSS for the full analytics dashboard ──
  var ANALYTICS_CSS = `
    .ak-wrap { max-width: 960px; margin: 0 auto; }
    .ak-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 20px; }
    /* .ak-card follows the canonical .stat-card tile spec (dashboard-app.css)
       — same surface/border/radius/padding/hover — plus a colored top accent. */
    .ak-card { background: var(--s); border: 1px solid var(--br); border-radius: 9px; padding: 16px 18px; position: relative; overflow: hidden; transition: border-color var(--t-mid, .18s); }
    .ak-card:hover { border-color: color-mix(in srgb, var(--t) 14%, transparent); }
    .ak-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; }
    .ak-card.blue::before { background: var(--blue, #4E9BF5); }
    .ak-card.orange::before { background: var(--orange, #BD5728); }
    .ak-card.green::before { background: var(--green, #2ECC8A); }
    .ak-card.red::before { background: var(--red); }
    .ak-card.cyan::before { background: var(--blue,#3b82f6); }
    .ak-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--m, #8892A4); margin-bottom: 6px; font-weight: 600; }
    .ak-val { font-family: 'Barlow Condensed', sans-serif; font-size: 28px; font-weight: 900; line-height: 1.1; }
    .ak-val.blue { color: var(--blue, #4E9BF5); }
    .ak-val.orange { color: var(--orange, #BD5728); }
    .ak-val.green { color: var(--green, #2ECC8A); }
    .ak-val.red { color: var(--red); }
    .ak-val.cyan { color: var(--blue,#3b82f6); }
    .ak-sub { font-size: 10px; color: var(--m, #8892A4); margin-top: 4px; opacity: .7; }
    .ak-panel { background: var(--s2, #1a1d23); border: 1px solid var(--br, #2a2d35); border-radius: 10px; margin-bottom: 16px; overflow: hidden; }
    .ak-panel-hdr { padding: 14px 16px; border-bottom: 1px solid var(--br, #2a2d35); font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--t, #fff); display: flex; align-items: center; gap: 8px; }
    .ak-panel-body { padding: 16px; }
    .ak-bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .ak-bar-label { font-size: 11px; color: var(--m, #8892A4); min-width: 100px; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ak-bar-track { flex: 1; height: 20px; background: var(--s3, #222); border-radius: 4px; overflow: hidden; position: relative; }
    .ak-bar-fill { height: 100%; border-radius: 4px; transition: width .6s cubic-bezier(.22,1,.36,1); display: flex; align-items: center; padding-left: 8px; font-size: 10px; font-weight: 700; color: #fff; min-width: 24px; }
    .ak-bar-count { font-size: 11px; color: var(--m, #8892A4); min-width: 36px; text-align: right; font-weight: 600; }
    .ak-chart { display: flex; align-items: flex-end; gap: 6px; height: 160px; padding: 8px 0; }
    .ak-chart-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; height: 100%; }
    .ak-chart-val { font-size: 9px; color: var(--m, #8892A4); font-weight: 600; }
    .ak-chart-bar-wrap { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; width: 100%; gap: 1px; }
    .ak-chart-bar { width: 100%; border-radius: 3px 3px 0 0; transition: height .5s cubic-bezier(.22,1,.36,1); min-height: 2px; }
    .ak-chart-lbl { font-size: 9px; color: var(--m, #8892A4); white-space: nowrap; }
    .ak-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 640px) { .ak-cols { grid-template-columns: 1fr; } .ak-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; } .ak-card { padding: 12px; } .ak-val { font-size: 22px; } .ak-bar-label { min-width: 70px; font-size: 10px; } }
    .ak-loading { text-align: center; padding: 60px 16px; color: var(--m, #8892A4); }
    .ak-loading-spinner { display: inline-block; width: 28px; height: 28px; border: 3px solid var(--br, #2a2d35); border-top-color: var(--orange, #BD5728); border-radius: 50%; animation: ak-spin .8s linear infinite; margin-bottom: 12px; }
    @keyframes ak-spin { to { transform: rotate(360deg); } }
  `;

  /**
   * Render the full analytics dashboard into a container.
   */
  function renderAnalyticsDashboard(containerId) {
    var el = document.getElementById(containerId);
    if (!el) return;

    // Inject stylesheet once
    if (!document.getElementById('ak-style')) {
      var style = document.createElement('style');
      style.id = 'ak-style';
      style.textContent = ANALYTICS_CSS;
      document.head.appendChild(style);
    }

    // Show loading
    el.innerHTML =
      '<div class="ak-loading">' +
        '<div class="ak-loading-spinner"></div>' +
        '<div>Loading analytics data...</div>' +
      '</div>';

    fetchAllData().then(function (data) {
      var m = computeFullAnalytics(data);
      renderDashboardHTML(el, m);
      // renderDashboardHTML's el.innerHTML= wipes children, so re-append these
      // after each render (matches the AI Texting card's re-mount pattern).
      // EVERY card that injects into #analyticsContainer must be listed here or
      // it is destroyed the moment this fetch resolves — the Adjuster Tactics
      // card was appended by goTo('board') and then silently wiped on every
      // visit (tests/analytics-container-remount.test.js pins the whole set).
      renderD2DCommandCenter(el);
      remountContainerCards();
    }).catch(function (err) {
      console.error('Analytics fetch error:', err);
      el.innerHTML =
        '<div class="nbd-empty">' +
          '<div class="ne-icon">⚠️</div>' +
          '<div class="ne-msg">Could not load analytics</div>' +
          '<div class="ne-sub">Please try again.</div>' +
        '</div>';
      // The error branch wipes the container too — re-mount here as well, or a
      // failed analytics fetch takes the sibling cards down with it.
      remountContainerCards();
    });
  }

  // Cards that live INSIDE #analyticsContainer and are therefore destroyed by
  // this module's innerHTML writes. Each is optional (page-scoped: not every
  // dashboard loads every card) and each render() is idempotent — the cards
  // find-or-create their own host div, so re-mounting is safe to call twice.
  function remountContainerCards() {
    ['AiTextingStatsCard', 'AdjusterTacticCard'].forEach(function (name) {
      var card = window[name];
      if (card && typeof card.render === 'function') {
        try { card.render(); } catch (e) { console.warn('[analytics-kpi] re-mount failed for ' + name + ':', e && e.message); }
      }
    });
  }

  function renderDashboardHTML(el, m) {
    var stageEntries = Object.entries(m.stageMap).sort(function (a, b) { return b[1] - a[1]; });
    var sourceEntries = Object.entries(m.sourceMap).sort(function (a, b) { return b[1] - a[1]; });
    // Sort by the "YYYY-MM" key (zero-padded, so lexicographic == chronological)
    // rather than relying on object insertion order, so the trend chart is
    // always oldest→newest left-to-right.
    var trendEntries = Object.entries(m.monthlyTrend).sort(function (a, b) {
      return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
    });

    var maxStage = stageEntries.length > 0 ? stageEntries[0][1] : 1;
    var maxSource = sourceEntries.length > 0 ? sourceEntries[0][1] : 1;
    var maxTrendLeads = Math.max.apply(null, trendEntries.map(function (e) { return e[1].leads; }).concat([1]));
    var maxTrendRev = Math.max.apply(null, trendEntries.map(function (e) { return e[1].revenue; }).concat([1]));

    // Stage colors
    var stageColors = {
      new: 'var(--blue)', contacted: '#00d4ff', inspection_scheduled: '#8B5CF6',
      inspection_complete: '#A855F7', estimate_sent: '#EC4899', negotiation: 'var(--orange)',
      signed: 'var(--green)', install_scheduled: '#10B981', install_complete: '#059669',
      closed: 'var(--green)', Complete: 'var(--green)', lost: 'var(--red)', Lost: 'var(--red)'
    };

    function stageColor(s) { return stageColors[s] || 'var(--orange)'; }

    // Friendly stage names
    var stageLabels = {
      new: 'New', contacted: 'Contacted', inspection_scheduled: 'Insp. Scheduled',
      inspection_complete: 'Insp. Complete', estimate_sent: 'Estimate Sent',
      negotiation: 'Negotiation', signed: 'Signed', install_scheduled: 'Install Sched.',
      install_complete: 'Install Complete', closed: 'Closed Won', Complete: 'Complete',
      lost: 'Lost', Lost: 'Lost', final_photos: 'Final Photos',
      final_payment: 'Final Payment', deductible_collected: 'Deductible Collected'
    };

    // Build stage bars
    var stageBarsHTML = '';
    if (stageEntries.length === 0) {
      stageBarsHTML = '<div class="nbd-empty"><div class="ne-icon">📊</div><div class="ne-msg">No lead data yet</div></div>';
    } else {
      stageEntries.forEach(function (entry) {
        var label = stageLabels[entry[0]] || entry[0].replace(/_/g, ' ');
        var count = entry[1];
        var widthPct = Math.max(Math.round((count / maxStage) * 100), 4);
        var color = stageColor(entry[0]);
        stageBarsHTML +=
          '<div class="ak-bar-row">' +
            '<div class="ak-bar-label" title="' + esc(label) + '">' + esc(label) + '</div>' +
            '<div class="ak-bar-track">' +
              '<div class="ak-bar-fill" style="width:' + widthPct + '%;background:' + color + ';">' + count + '</div>' +
            '</div>' +
            '<div class="ak-bar-count">' + pct(count, m.totalLeads) + '%</div>' +
          '</div>';
      });
    }

    // Build source bars
    var sourceBarsHTML = '';
    if (sourceEntries.length === 0) {
      sourceBarsHTML = '<div class="nbd-empty"><div class="ne-icon">📊</div><div class="ne-msg">No source data yet</div></div>';
    } else {
      sourceEntries.slice(0, 8).forEach(function (entry) {
        var label = entry[0];
        var count = entry[1];
        var widthPct = Math.max(Math.round((count / maxSource) * 100), 4);
        sourceBarsHTML +=
          '<div class="ak-bar-row">' +
            '<div class="ak-bar-label" title="' + esc(label) + '">' + esc(label) + '</div>' +
            '<div class="ak-bar-track">' +
              '<div class="ak-bar-fill" style="width:' + widthPct + '%;background:var(--orange,#BD5728);">' + count + '</div>' +
            '</div>' +
            '<div class="ak-bar-count">' + pct(count, m.totalLeads) + '%</div>' +
          '</div>';
      });
    }

    // Build monthly trend chart
    var trendChartHTML = '';
    if (trendEntries.length === 0) {
      trendChartHTML = '<div class="nbd-empty"><div class="ne-msg">No trend data yet</div></div>';
    } else {
      trendEntries.forEach(function (entry) {
        var mk = entry[0];
        var d = entry[1];
        var leadH = Math.max(Math.round((d.leads / maxTrendLeads) * 100), 2);
        var revH = maxTrendRev > 0 ? Math.max(Math.round((d.revenue / maxTrendRev) * 100), 2) : 2;
        trendChartHTML +=
          '<div class="ak-chart-col">' +
            '<div class="ak-chart-val">' + d.leads + '</div>' +
            '<div class="ak-chart-bar-wrap">' +
              '<div class="ak-chart-bar" style="height:' + leadH + '%;background:var(--blue,#4E9BF5);opacity:.8;" title="' + d.leads + ' leads"></div>' +
              '<div class="ak-chart-bar" style="height:' + revH + '%;background:var(--green,#2ECC8A);opacity:.7;" title="' + formatCurrency(d.revenue) + ' revenue"></div>' +
            '</div>' +
            '<div class="ak-chart-lbl">' + monthLabel(mk) + '</div>' +
          '</div>';
      });
    }

    // ── Expense / supplier-spend section (only when expenses exist) ──
    var marginColor = m.expGrossMargin == null ? 'var(--t,#fff)'
      : m.expGrossMargin >= 40 ? 'var(--green,#2ECC8A)'
      : m.expGrossMargin >= 25 ? 'var(--orange,#BD5728)' : 'var(--red,#E5484D)';
    var supplierBarsHTML = '';
    var maxSup = (m.expSupplierLeaderboard[0] && m.expSupplierLeaderboard[0].cents) || 1;
    m.expSupplierLeaderboard.forEach(function (s) {
      var w = Math.max(Math.round((s.cents / maxSup) * 100), 4);
      var pctTotal = m.expTotalDollars > 0 ? Math.round((s.cents / 100) / m.expTotalDollars * 100) : 0;
      supplierBarsHTML +=
        '<div class="ak-bar-row">' +
          '<div class="ak-bar-label" title="' + esc(s.supplier) + '">' + esc(s.supplier) + '</div>' +
          '<div class="ak-bar-track"><div class="ak-bar-fill" style="width:' + w + '%;background:var(--orange,#BD5728);">' + formatCurrency(s.cents / 100) + '</div></div>' +
          '<div class="ak-bar-count">' + pctTotal + '%</div>' +
        '</div>';
    });
    var expenseSectionHTML = m.expTotalDollars > 0 ? (
      '<div class="ak-grid">' +
        '<div class="ak-card blue">' +
          '<div class="ak-lbl">Total COGS</div>' +
          '<div class="ak-val blue">' + formatCurrency(m.expDirectDollars) + '</div>' +
          '<div class="ak-sub">direct job costs · ' + formatCurrency(m.expTotalDollars) + ' all spend</div>' +
        '</div>' +
        '<div class="ak-card">' +
          '<div class="ak-lbl">Gross Margin <span style="opacity:.55;font-weight:normal;">(won jobs)</span></div>' +
          '<div class="ak-val" style="color:' + marginColor + '">' + (m.expGrossMargin == null ? '—' : m.expGrossMargin + '%') + '</div>' +
          '<div class="ak-sub">' + m.expCostedJobs + ' of ' + m.expWonJobs + ' won jobs costed · before overhead</div>' +
        '</div>' +
        '<div class="ak-card orange">' +
          '<div class="ak-lbl">Spend This Month</div>' +
          '<div class="ak-val orange">' + formatCurrency(m.expMonthDollars) + '</div>' +
          '<div class="ak-sub">materials, subs, overhead</div>' +
        '</div>' +
        '<div class="ak-card">' +
          '<div class="ak-lbl">Overhead</div>' +
          '<div class="ak-val" style="color:var(--t,#fff)">' + formatCurrency(m.expOverheadDollars) + '</div>' +
          '<div class="ak-sub">operating costs (not per-job)</div>' +
        '</div>' +
      '</div>' +
      '<div class="ak-panel">' +
        '<div class="ak-panel-hdr">💰 Spend by Supplier</div>' +
        '<div class="ak-panel-body">' + supplierBarsHTML + '</div>' +
      '</div>'
    ) : '';

    el.innerHTML =
      '<div class="ak-wrap">' +

        // ── Top KPI cards ──
        '<div class="ak-grid">' +
          '<div class="ak-card green">' +
            '<div class="ak-lbl">Total Revenue</div>' +
            '<div class="ak-val green">' + formatCurrency(m.totalRevenue) + '</div>' +
            '<div class="ak-sub">' + m.paidCount + ' paid invoices' + (m.monthRevenue > 0 ? ' · ' + formatCurrency(m.monthRevenue) + ' this month' : '') + '</div>' +
          '</div>' +
          '<div class="ak-card blue">' +
            '<div class="ak-lbl">Pipeline Value</div>' +
            '<div class="ak-val blue">' + formatCurrency(m.pipelineValue) + '</div>' +
            '<div class="ak-sub">' + m.activeLeadCount + ' active leads</div>' +
          '</div>' +
          '<div class="ak-card orange">' +
            '<div class="ak-lbl">Conversion Rate <span style="opacity:.55;font-weight:normal;">(all-time)</span></div>' +
            '<div class="ak-val orange">' + m.conversionRate + '%</div>' +
            '<div class="ak-sub">' + m.wonCount + ' won / ' + (m.wonCount + m.lostCount) + ' decided</div>' +
          '</div>' +
          '<div class="ak-card cyan">' +
            '<div class="ak-lbl">Avg Deal Size</div>' +
            '<div class="ak-val cyan">' + formatCurrency(m.avgDealSize) + '</div>' +
            '<div class="ak-sub">' + m.wonCount + ' closed deals</div>' +
          '</div>' +
        '</div>' +

        // ── Secondary KPIs ──
        '<div class="ak-grid">' +
          '<div class="ak-card">' +
            '<div class="ak-lbl">Estimates</div>' +
            '<div class="ak-val" style="color:var(--t,#fff)">' + m.totalEstimates + '</div>' +
            '<div class="ak-sub">Avg value ' + formatCurrency(m.avgEstimateValue) + '</div>' +
          '</div>' +
          '<div class="ak-card">' +
            '<div class="ak-lbl">D2D Knocks</div>' +
            '<div class="ak-val" style="color:var(--t,#fff)">' + formatNum(m.totalKnocks) + '</div>' +
            '<div class="ak-sub">' + m.appointments + ' appointments · ' + m.knockToAppt + '% set rate</div>' +
          '</div>' +
          '<div class="ak-card">' +
            '<div class="ak-lbl">Photos</div>' +
            '<div class="ak-val" style="color:var(--t,#fff)">' + formatNum(m.totalPhotos) + '</div>' +
            '<div class="ak-sub">' + m.photoPerLead + ' per lead · ' + m.leadsWithPhotos + ' leads documented</div>' +
          '</div>' +
          '<div class="ak-card red">' +
            '<div class="ak-lbl">Unpaid Invoices</div>' +
            '<div class="ak-val red">' + formatCurrency(m.unpaidAmount) + '</div>' +
            '<div class="ak-sub">' + m.unpaidCount + ' outstanding</div>' +
          '</div>' +
        '</div>' +

        // ── Expenses / supplier spend (only when expenses exist) ──
        expenseSectionHTML +

        // ── Monthly Trend ──
        '<div class="ak-panel">' +
          '<div class="ak-panel-hdr">📈 Monthly Trend (6 Months)</div>' +
          '<div class="ak-panel-body">' +
            '<div style="display:flex;gap:16px;margin-bottom:8px;font-size:10px;color:var(--m,#8892A4)">' +
              '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--blue,#4E9BF5);vertical-align:middle;margin-right:4px"></span>New Leads</span>' +
              '<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--green,#2ECC8A);vertical-align:middle;margin-right:4px"></span>Revenue</span>' +
            '</div>' +
            '<div class="ak-chart">' + trendChartHTML + '</div>' +
          '</div>' +
        '</div>' +

        // ── Two column: Stage + Source ──
        '<div class="ak-cols">' +
          '<div class="ak-panel">' +
            '<div class="ak-panel-hdr">📊 Leads by Stage</div>' +
            '<div class="ak-panel-body">' + stageBarsHTML + '</div>' +
          '</div>' +
          '<div class="ak-panel">' +
            '<div class="ak-panel-hdr">🎯 Leads by Source</div>' +
            '<div class="ak-panel-body">' + sourceBarsHTML + '</div>' +
          '</div>' +
        '</div>' +

      '</div>';
  }

  // ── Doors Verified KPI (D2D address data quality) ──
  // Appended to the Home KPI row after renderKPIRow(). computeKPIs()/renderKPIRow()
  // are synchronous and don't load knocks, so this fetches its own (owner-scoped,
  // no composite index) and only shows the card when the rep actually canvasses.
  async function renderDoorsVerifiedCard() {
    const grid = document.querySelector('#kpiRow .kpi-grid');
    if (!grid || document.getElementById('kpi-doors-verified')) return;
    const db = window._db || window.db;
    const uid = window._user && window._user.uid;
    let knocks = Array.isArray(window._knocks) ? window._knocks : null;
    if (!knocks && db && uid && window.getDocs && window.collection && window.query && window.where) {
      try {
        const snap = await window.getDocs(
          window.query(window.collection(db, 'knocks'), window.where('userId', '==', uid)));
        knocks = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
        window._knocks = knocks; // cache for reports/analytics
      } catch (e) { knocks = []; }
    }
    knocks = knocks || [];
    // Dedupe to the most-recent knock per address (mirrors D2D getAddressQuality).
    const latest = {};
    knocks.forEach(function (k) {
      if (!k.address) return;
      const key = String(k.address).toLowerCase().trim().replace(/\s+/g, ' '); // match D2D normalizeAddress
      const c = k.createdAt;
      const ms = c && c.seconds ? c.seconds * 1000 : (c instanceof Date ? c.getTime() : (typeof c === 'number' ? c : 0));
      if (!latest[key] || ms > latest[key]._ms) { k._ms = ms; latest[key] = k; }
    });
    const doors = Object.keys(latest).map(function (k) { return latest[k]; });
    const total = doors.length;
    if (total === 0) return; // no D2D activity → no card
    const verified = doors.filter(function (k) { return k.addrConfidence === 'verified'; }).length;
    const pct = Math.round((verified / total) * 100);
    const accent = pct >= 80 ? 'var(--green,#2ECC8A)' : pct >= 50 ? 'var(--gold,#D4A017)' : 'var(--orange,#BD5728)';
    grid.insertAdjacentHTML('beforeend',
      '<div class="kpi-card" id="kpi-doors-verified" data-ak-action="goTo" data-ak-target="d2d" role="button" ' +
        'title="Open Door-to-Door" style="cursor:pointer;border-left:3px solid ' + accent + ';">' +
        '<div class="kpi-icon">📍</div>' +
        '<div class="kpi-data">' +
          '<div class="kpi-value">' + pct + '%</div>' +
          '<div class="kpi-label">Doors Verified</div>' +
          '<div class="kpi-sub">' + verified + ' of ' + total + ' addresses</div>' +
        '</div>' +
      '</div>');
  }

  // ── Owner Command Center (D2D→revenue attribution + rep leaderboard + funnel) ──
  // Appended to the board Analytics view. Leads minted from D2D carry
  // source:'Door-to-Door' + d2dKnockId (the link back to the knock); leads DON'T
  // carry repName, so revenue is attributed to a rep by joining lead.d2dKnockId
  // → knock.repName. Own-uid data for a solo owner == the whole company.
  function _isConvo(dispo) {
    const D = (window.D2D && window.D2D.DISPOSITIONS) || (window._D2DState && window._D2DState.DISPOSITIONS);
    // DISPOSITIONS loaded → an unknown/blank key is NOT a conversation.
    if (D) return !!(D[dispo] && D[dispo].contact);
    return !!dispo && !['not_home', 'revisit', 'left_material', 'vacant', 'do_not_knock', 'cold_dead'].includes(dispo);
  }
  let _ccRendering = false;
  async function renderD2DCommandCenter(el) {
    if (!el || _ccRendering || document.getElementById('ak-d2d-cc')) return;
    const c = window._userClaims || {};
    const isBoss = c.owner === true || c.role === 'admin' || c.role === 'company_admin' || c.role === 'manager' || window._role === 'admin';
    if (!isBoss) return;
    _ccRendering = true;
    try {
      const leads = Array.isArray(window._leads) ? window._leads : [];
      // Pattern test, not equality: the same act was written as 'Door-to-Door'
      // (d2d-tracker), 'Door Knock' (maps-overlays) and 'door_knock' (an old
      // import). 'Door Knock' is canonical as of 2026-09-06 and the data is
      // normalized, but matching loosely costs nothing and stops a stray
      // spelling from an import or a restored backup emptying this panel.
      const _isDoorKnock = (src) => {
        const s = String(src || '').trim().toLowerCase().replace(/[_-]+/g, ' ');
        return s === 'door knock' || s === 'door to door' || s === 'd2d';
      };
      const d2dLeads = leads.filter(l => _isDoorKnock(l.source) || l.d2dKnockId);

      // Knocks: for a manager/admin the leads book is company-wide, but
      // window._knocks is own-uid only — so the rep-attribution join needs every
      // rep's knocks. Only admin/manager can read company knocks per the rules;
      // anyone else (owner-of-own-data, viewer) uses their own set and unmatched
      // revenue lands in an explicit 'Unattributed' bucket (keeps the leaderboard
      // total equal to the headline). Solo owner: own == whole company.
      let knocks = Array.isArray(window._knocks) ? window._knocks : [];
      // company_admin (the tenant owner) too: the /knocks rule is isCompanyStaff
      // (company_admin OR manager). Excluding it left an owner's board built
      // from their OWN knocks only — teammates' D2D revenue fell into
      // "Unattributed" (CRM sweep R14, 2026-09-28).
      const canReadTeam = c.role === 'admin' || c.role === 'company_admin' || c.role === 'manager' || window._role === 'admin';
      if (canReadTeam && c.companyId && window._db && window.getDocs && window.collection && window.query && window.where) {
        try {
          const snap = await window.getDocs(window.query(window.collection(window._db, 'knocks'), window.where('companyId', '==', c.companyId)));
          knocks = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
        } catch (e) { /* permission/network — keep own-uid knocks */ }
      }
      if (!knocks.length && !d2dLeads.length) return;      // no D2D activity
      if (document.getElementById('ak-d2d-cc')) return;    // re-check after await

      const knockById = {};
      knocks.forEach(k => { knockById[k.id] = k; });
      const wonD2D = d2dLeads.filter(_isWon);
      const d2dRevenue = wonD2D.reduce((s, l) => s + (Number(l.jobValue) || 0), 0);

      // Funnel counts are UNIQUE-DOOR based so stages stay monotonic (a door that
      // reached a stage counts once), matching the deduped Doors denominator.
      const norm = (a) => String(a || '').toLowerCase().trim().replace(/\s+/g, ' ');
      const doorSet = new Set(), convoSet = new Set(), apptSet = new Set(), convertedSet = new Set();
      knocks.forEach(k => {
        const key = norm(k.address); if (!key) return;
        doorSet.add(key);
        if (_isConvo(k.disposition)) convoSet.add(key);
        if (k.disposition === 'appointment') apptSet.add(key);
        if (k.convertedToLead) convertedSet.add(key);
      });
      const uniqDoors = doorSet.size, convos = convoSet.size, appts = apptSet.size, converted = convertedSet.size, won = wonD2D.length;

      // One row per REP (the knock's owner uid), named from the company
      // roster. Keying by the free-text repName split one person into
      // "Casey ZZ_QA" (knocks that carried a name) and "You" (knocks that
      // didn't), and credited a teammate's unnamed knocks to the viewer
      // (CRM sweep R14, 2026-09-28). A won lead whose knock isn't loaded is
      // credited to the lead's owner; only a lead with neither is Unattributed.
      if (window.NBDTeamNames) { try { await window.NBDTeamNames.load(); } catch (_) {} }
      const byRep = {};
      const _repKey = (uid, repName) => uid ? 'u:' + uid : (repName ? 'n:' + repName : 'unattributed');
      const bump = (key, uid, repName) => byRep[key] || (byRep[key] = { uid: uid || null, repName: repName || '', knocks: 0, appts: 0, converted: 0, revenue: 0 });
      knocks.forEach(k => {
        const key = _repKey(k.userId, k.repName);
        const s = bump(key, k.userId, k.repName);
        if (!s.repName && k.repName) s.repName = k.repName;
        s.knocks++; if (k.disposition === 'appointment') s.appts++; if (k.convertedToLead) s.converted++;
      });
      wonD2D.forEach(l => {
        const k = knockById[l.d2dKnockId];
        const uid = (k && k.userId) || l.userId || null;
        const nm = (k && k.repName) || '';
        bump(_repKey(uid, nm), uid, nm).revenue += Number(l.jobValue) || 0;
      });
      const _me = window._user && window._user.uid;
      const _nameOf = (r) => (window.NBDTeamNames && r.uid && window.NBDTeamNames.nameFor(r.uid))
        || r.repName || (r.uid && r.uid === _me ? 'You' : (r.uid ? 'Teammate' : 'Unattributed'));
      const reps = Object.keys(byRep).map(key => Object.assign({ name: _nameOf(byRep[key]) }, byRep[key])).sort((a, b) => b.revenue - a.revenue || b.appts - a.appts);

      const fmt$ = (n) => '$' + Math.round(n).toLocaleString();
      const clampPct = (n, d) => d > 0 ? Math.min(100, Math.round(n / d * 100)) : 0;
      // Monotonic by construction: converted ⊆ conversations ⊆ doors, won ⊆
      // converted. (Appointments live in the card row, not here — they're not a
      // strict funnel stage between conversation and conversion.)
      const funnel = [
        { label: 'Doors', val: uniqDoors, color: 'var(--m,#6B7280)' },
        { label: 'Conversations', val: convos, color: 'var(--gold,#D4A017)' },
        { label: 'Converted to Lead', val: converted, color: 'var(--purple,#9B6DFF)' },
        { label: 'Won', val: won, color: 'var(--green,#2ECC8A)' }
      ];
      const maxF = Math.max.apply(null, funnel.map(f => f.val).concat([1])); // scale to the LARGEST stage — never overflow
      const maxRepRev = Math.max.apply(null, reps.map(r => r.revenue).concat([1]));

      const html =
        '<div id="ak-d2d-cc">' +
          '<div class="ak-panel"><div class="ak-panel-hdr">🚪 Door-to-Door Command Center</div><div class="ak-panel-body">' +
            '<div class="ak-grid">' +
              '<div class="ak-card blue"><div class="ak-lbl">Doors Knocked</div><div class="ak-val">' + uniqDoors.toLocaleString() + '</div><div class="ak-sub">' + convos.toLocaleString() + ' conversations</div></div>' +
              '<div class="ak-card cyan"><div class="ak-lbl">Appointments</div><div class="ak-val">' + appts.toLocaleString() + '</div><div class="ak-sub">' + clampPct(appts, uniqDoors) + '% of doors</div></div>' +
              '<div class="ak-card orange"><div class="ak-lbl">D2D Leads Won</div><div class="ak-val">' + won.toLocaleString() + '</div><div class="ak-sub">' + converted.toLocaleString() + ' doors converted</div></div>' +
              '<div class="ak-card green"><div class="ak-lbl">D2D Booked</div><div class="ak-val">' + fmt$(d2dRevenue) + '</div><div class="ak-sub">' + (won > 0 ? 'projected · ' + fmt$(d2dRevenue / won) + ' avg won job' : 'projected · won door-knock jobs') + '</div></div>' +
            '</div>' +
            '<div style="font-weight:700;font-size:12px;color:var(--m);text-transform:uppercase;letter-spacing:.05em;margin:14px 0 8px;">Conversion Funnel</div>' +
            funnel.map(f => {
              const w = Math.max(f.val / maxF * 100, f.val > 0 ? 4 : 0);
              return '<div class="ak-bar-row"><div class="ak-bar-label">' + f.label + '</div>' +
                '<div class="ak-bar-track"><div class="ak-bar-fill" style="width:' + w + '%;background:' + f.color + ';"></div></div>' +
                '<div class="ak-bar-count">' + f.val.toLocaleString() + '</div></div>';
            }).join('') +
          '</div></div>' +
          '<div class="ak-panel"><div class="ak-panel-hdr">🏆 Rep Leaderboard (Door-to-Door)</div><div class="ak-panel-body">' +
            (reps.length ? reps.slice(0, 10).map((r, i) => {
              const w = Math.max(r.revenue / maxRepRev * 100, r.revenue > 0 ? 4 : 2);
              return '<div class="ak-bar-row"><div class="ak-bar-label">' + (i + 1) + '. ' + esc(r.name) + '</div>' +
                '<div class="ak-bar-track"><div class="ak-bar-fill" style="width:' + w + '%;background:var(--green,#2ECC8A);"></div></div>' +
                '<div class="ak-bar-count" title="' + r.knocks + ' knocks · ' + r.appts + ' appts">' + fmt$(r.revenue) + '</div></div>';
            }).join('') : '<div class="ak-sub">No rep activity yet.</div>') +
          '</div></div>' +
        '</div>';
      el.insertAdjacentHTML('beforeend', html);
    } finally { _ccRendering = false; }
  }

  // ── Public API ──
  window.renderKPIRow = renderKPIRow;
  window.renderD2DCommandCenter = renderD2DCommandCenter;
  window.computeKPIs = computeKPIs;

  window.AnalyticsKPI = {
    init: function () {
      // no-op — data is fetched on render
    },
    render: function (containerId) {
      renderAnalyticsDashboard(containerId || 'analyticsContainer');
    },
    refresh: function (containerId) {
      _analyticsCache.loaded = false;
      renderAnalyticsDashboard(containerId || 'analyticsContainer');
    },
    // Exposed for unit testing the (pure) metric computation.
    _test: { computeFullAnalytics: computeFullAnalytics }
  };

  // Globals Tranche 3 T3-C (2026-09-18): renderDoorsVerifiedCard is
  // registry-only — its one caller is dashboard-bootstrap.module.js's
  // loadLeads KPI-row timer, which reads it off __NBD_CALL_REGISTRY.
  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  Object.assign(window.__NBD_CALL_REGISTRY, { renderDoorsVerifiedCard: renderDoorsVerifiedCard });

})();


(function () {
  if (window._NBD_AK_DELEGATE) return;
  window._NBD_AK_DELEGATE = true;
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest && ev.target.closest('[data-ak-action]');
    if (!t) return;
    var action = t.dataset.akAction;
    if (action === 'goTo') {
      var target = t.dataset.akTarget;
      if (target && typeof window.goTo === 'function') window.goTo(target);
      return;
    }
    if (action === 'scrollToFollowUps') {
      // The follow-up alerts live inside the CRM view (#followUpAlertsWrap,
      // rendered by renderLeads) — scrolling in place from the dash view
      // targeted an element in a hidden (or not-yet-hydrated) view and did
      // nothing. Navigate to the CRM first; clear the session dismiss flag
      // because this tap is an explicit "show me" request; then scroll once
      // the kanban render has run (same 200ms-class delay as filterByStage).
      try { localStorage.removeItem('nbd_crm_followup_hidden'); } catch (e) {}
      if (typeof window.goTo === 'function') window.goTo('crm');
      setTimeout(function () {
        // Registry-only (crm-portal-bridge.js, Globals Tranche 3 T3-C).
        var _nbdReg = window.__NBD_CALL_REGISTRY;
        if (_nbdReg && typeof _nbdReg.scrollToFollowUps === 'function') _nbdReg.scrollToFollowUps();
      }, 300);
    }
  });
})();
