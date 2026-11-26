'use strict';
/**
 * website-page-revenue.js — which website pages earn money (2026-11-26).
 *
 * The 2026-11-25 website audit found the site judged by traffic, not money.
 * This is the pure rollup behind the "Website pages → money" section of the
 * monthly marketing report (functions/marketing-report.js): per website page,
 *
 *   Leads      web leads that came in during the window, by the page they
 *              were sent from (CRM lead `sourcePage`, stamped by the lead
 *              bridge, functions/lead-bridge-logic.js mapPublicLeadToLead)
 *   Inspected  of those leads, how many reached an inspection (an inspected-
 *              or-later stage now or in their stageHistory, or an
 *              inspectionDate)
 *   Sold       of those leads, how many are a sale (stage-roles.js isSale:
 *              a signed contract, a job in production, or won)
 *   Collected  money RECEIVED during the window from any customer who came
 *              off that page, whenever they came in. Invoice payments minus
 *              refunds, dated by when the money arrived (agent-mcp-logic.js
 *              paymentsOf, the same ledger as every other revenue reader).
 *              Never estimates, contracts or pipeline.
 *
 * Two windows: last calendar month and the trailing 12 months ending with it,
 * as calendar days in the company's timezone. All money is integer cents.
 *
 * One company's leads and invoices in, numbers out: the caller scopes the
 * reads to a companyId. No customer names, phones or emails leave here.
 */
const AM = require('./agent-mcp-logic');
const SR = require('./stage-roles');

// Old URLs that now redirect, and form `source` values that are not paths,
// folded into the page a homeowner lands on today.
const PAGE_ALIAS = {
  '/storm-check': '/roof-check',
  '/roof-score': '/roof-check',
  '/storm-report': '/roof-check', // #3263 merged all three into /roof-check
  '/book': '/inspect', // /book folded into /inspect 2026-11-25 (firebase.json 301)
  '/index': '/',
  'homepage': '/',
  'estimate-funnel-v2': '/estimate',
  'storm-alerts-page': '/storm-alerts',
};

// Public collection → the label the report already uses (marketing-report.js
// SOURCES), for leads bridged before sourcePage existed (2026-09-13).
const COLLECTION_LABEL = {
  estimate_leads: 'Instant Estimate',
  inspect_leads: 'Inspection / Storm tool',
  contact_leads: 'Contact form',
  free_roof_entries: 'Free Roof entry',
  storm_alert_subscribers: 'Storm signup',
};

/**
 * The page a lead came from, grouped: 'page-form:/areas/mason-oh' and
 * '/areas/mason-oh/' are one page; redirected URLs count as their new home.
 */
function pageKey(lead) {
  let s = String((lead && lead.sourcePage) || '').trim();
  if (/^calcom:/i.test(s)) return 'Cal.com booking';
  s = s.replace(/^page-form:/i, '');
  if (!s) {
    const col = lead && lead.publicLeadCollection;
    return '(page not recorded)' + (COLLECTION_LABEL[col] ? ' · ' + COLLECTION_LABEL[col] : '');
  }
  // A full URL keeps only its path.
  s = s.replace(/^https?:\/\/[^/]+/i, '');
  s = s.split(/[?#]/)[0].toLowerCase();
  if (s.charAt(0) === '/') {
    s = s.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
    if (s.length > 1) s = s.replace(/\/+$/, '');
    if (!s) s = '/';
  }
  return PAGE_ALIAS[s] || s;
}

// Built-in stages at or past the inspection on the main, warranty and service
// tracks: every built-in key except the two before it and 'lost'.
const PRE_INSPECTION = new Set(['new', 'contacted', 'lost']);
function stageIsInspectedOrLater(stage) {
  const k = SR.canonicalStageKey(stage);
  if (k) return !PRE_INSPECTION.has(k);
  return false; // a tenant custom stage the server cannot place
}

/** Did this lead get an inspection? Current stage, any stage it passed through, or a booked inspection date in the past. */
function reachedInspection(lead, nowMs) {
  if (!lead) return false;
  if (SR.isSale(lead)) return true;
  if (stageIsInspectedOrLater(lead.stage)) return true;
  const hist = Array.isArray(lead.stageHistory) ? lead.stageHistory : [];
  for (const h of hist) {
    if (h && (stageIsInspectedOrLater(h.to) || (h.from && stageIsInspectedOrLater(h.from)))) return true;
  }
  const insp = AM.ms(lead.inspectionDate);
  return insp > 0 && insp <= nowMs;
}

function isCountedLead(l) {
  return !!l && l.webLead === true && l.deleted !== true && !l.e2eTestData && !l.isProspect;
}

/** 'YYYY-MM' + n months. */
function addMonths(ym, n) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  return yy + '-' + String(mm + 1).padStart(2, '0');
}

/**
 * Windows for a report run on `todayYmd`: last calendar month, and the 12
 * months ending with it. `from` inclusive, `to` exclusive, YYYY-MM-DD.
 */
function windowsFor(todayYmd) {
  const thisMonth = String(todayYmd).slice(0, 7);
  const last = addMonths(thisMonth, -1);
  const to = thisMonth + '-01';
  return {
    month: { from: last + '-01', to, label: last },
    year: { from: addMonths(last, -11) + '-01', to, label: addMonths(last, -11) + ' to ' + last },
  };
}

function emptyRow(page) {
  return { page, month: { leads: 0, inspected: 0, sold: 0, collectedCents: 0 }, year: { leads: 0, inspected: 0, sold: 0, collectedCents: 0 } };
}

/**
 * @param {object} inp
 * @param {object[]} inp.leads     one company's CRM leads (each with `id`)
 * @param {object[]} inp.invoices  the same company's invoices
 * @param {string}   inp.todayYmd  report run day, company timezone
 * @param {string}   inp.tz        company timezone
 * @param {number}   inp.nowMs     clock, for "inspection date already passed"
 */
function buildPageRevenue(inp) {
  const tz = inp.tz || 'America/New_York';
  const w = windowsFor(inp.todayYmd);
  const inWin = (day, win) => day >= win.from && day < win.to;
  const rows = {};
  const row = (p) => (rows[p] = rows[p] || emptyRow(p));
  const pageOfLead = {};

  for (const l of inp.leads || []) {
    if (!isCountedLead(l)) continue;
    const p = pageKey(l);
    if (l.id) pageOfLead[l.id] = p;
    const t = AM.ms(l.createdAt);
    if (!t) continue;
    const day = AM.dayInZone(t, tz);
    const insp = reachedInspection(l, inp.nowMs || Date.now());
    const sold = SR.isSale(l);
    for (const k of ['month', 'year']) {
      if (!inWin(day, w[k])) continue;
      const r = row(p)[k];
      r.leads++;
      if (insp) r.inspected++;
      if (sold) r.sold++;
    }
  }

  for (const inv of inp.invoices || []) {
    if (!inv || inv.deleted === true || inv.e2eTestData) continue;
    const p = inv.leadId ? pageOfLead[inv.leadId] : null;
    if (!p) continue; // not a website customer
    for (const pay of AM.paymentsOf(inv)) {
      const t = AM.ms(pay.at instanceof Date ? pay.at.getTime() : pay.at);
      if (!t) continue;
      const day = AM.dayInZone(t, tz);
      const c = Math.round(pay.amount * 100);
      for (const k of ['month', 'year']) if (inWin(day, w[k])) row(p)[k].collectedCents += c;
    }
  }

  const list = Object.keys(rows).map((k) => rows[k])
    .sort((a, b) => b.year.collectedCents - a.year.collectedCents || b.year.sold - a.year.sold
      || b.year.leads - a.year.leads || (a.page < b.page ? -1 : 1));
  const total = emptyRow('All website pages');
  for (const r of list) for (const k of ['month', 'year']) for (const f of ['leads', 'inspected', 'sold', 'collectedCents']) total[k][f] += r[k][f];
  return { windows: w, rows: list, total };
}

function money(cents) {
  const neg = cents < 0, c = Math.abs(Math.round(cents));
  return (neg ? '-$' : '$') + Math.floor(c / 100).toLocaleString('en-US') + (c % 100 ? '.' + String(c % 100).padStart(2, '0') : '');
}

module.exports = { PAGE_ALIAS, pageKey, reachedInspection, windowsFor, buildPageRevenue, money };
